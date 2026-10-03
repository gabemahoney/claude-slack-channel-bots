/**
 * persona-notifier.test.ts — Per-persona server notices (b.av2 SR-7.2).
 *
 * Every notice about a persona goes only to that persona's `permission_prompts`
 * channel, through that persona's own Web client, as one top-level message
 * whose text carries the persona reference built from the persona's stored
 * key. A `dm` destination gets its notices in the persona's DM with its
 * contact, opened at post time through the shared destination resolver (whose
 * cache and failures `persona-destination.test.ts` proves), dry run posts
 * nothing, notices raised before the persona's client is validated are held
 * and flushed per persona (at most
 * `MAX_HELD_NOTICES_PER_PERSONA` per persona: past it the oldest held notice
 * is dropped with one log line and never posted). A notice whose open or post
 * fails at the destination (b.av2 SR-7.1: `missing_scope` on the DM open,
 * `not_in_channel`, Slack unreachable) is handed to the destination hold: it
 * is held, never lost, and retried on the SR-3.2 backoff (5 s, 10 s, 20 s …)
 * with one `persona-destination-failed` line per episode (naming `im:write`
 * for `missing_scope` on the open) and one cleared line, posted in raised
 * order once the cause clears, and its failure callback runs once however
 * many retries fail. A post refused for the message itself (`invalid_blocks`,
 * `msg_too_long`) is logged per notice and dropped, opening no episode. The
 * hold's own schedule, epochs and cap are proven in
 * `persona-destination-hold.test.ts`; this file keeps one case per failure
 * kind and the notifier-level rules. Nothing rejects. An injected resolver is
 * the one used (its cached DM is reused). A teardown's `forget(key)` (b.av2
 * SR-6.5) drops the persona's pre-validation queue unposted, with one line
 * only when notices were dropped, so the key added again never posts them;
 * it leaves the destination hold and other personas' queues alone.
 *
 * The persona teardown window (b.jg5 SRJ-1003, SRJ-1002, SRJ-1013, AC 65):
 * while a persona's window is open every notice for its key is one log line
 * and one startup-errors entry (`persona-teardown-notice`, or
 * `persona-kill-survivor` for the kill-failure alert's survivor version),
 * over a channel and a `dm` destination, a validated and a not-yet-validated
 * client, a key still applied (a destructive modify's old half, its applied
 * persona sending notices elsewhere) and a key no longer applied: no Slack
 * call, never queued, never handed to the destination hold, never dropped
 * (`forget` drops only what was queued before the window, with its one
 * line). Once it closes the key's notices route as before, but for the
 * all-clear of an outage whose onset the window routed, which is written the
 * same way whenever it comes; an all-clear also listing a class whose onset
 * was posted is split by its `allClearOf` (the marked part written, the rest
 * posted), or written whole without a usable one. A notice built for Slack is
 * written with its control-character escapes undone. From a teardown's
 * submit until its window opens, an `ad-config-malformed` onset for an
 * applied key is muted (one line, no post, no entry) and its all-clear
 * written. The entries are read back from the harness's
 * temp `logDir`; their class and text come from `src/`'s constant and
 * builder.
 *
 * Pure module under test: built from injected fakes only, through the shared
 * `makeNotifierHarness` (`makeStubSlack` Web stubs, a validated-key set, a
 * dry-run flag, a line capture and a destination hold on a fake clock, so no
 * real timer runs and retries fire only on `h.clock.runNext()`, and the
 * startup-errors recorder over the harness's own temp `logDir`, removed after
 * each case). No token is used; every stub carries `LEAK_SENTINEL` and
 * `afterEach` runs `assertNoLeak` over every captured log line, post and
 * startup-errors entry, and the written `startup-errors.log`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WebClient } from '@slack/web-api'

import type { Persona } from '../src/config.ts'
import { LATCH_CASE_LEFTOVER, conflictNoticeText } from '../src/conflict-latch.ts'
import { PERSONA_KILL_SURVIVOR_LABEL } from '../src/kill-failure-alert.ts'
import type { OutageClass } from '../src/outage-state.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import {
  MAX_HELD_NOTICES_PER_PERSONA,
  PERSONA_NOTICE_OUTAGE_ALL_CLEAR,
  PERSONA_NOTICE_OUTAGE_ONSET,
  PERSONA_NOTICE_SUBMIT_MUTED_OUTAGE_CLASSES,
  PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER,
  PERSONA_TEARDOWN_NOTICE_LABEL,
  PERSONA_TEARDOWN_NOTICE_RAISED,
  createPersonaNotifier,
  formatPersonaNotice,
  personaTeardownNoticeEntryText,
  personaTeardownNoticeWrittenLine,
  type PersonaNoticeOptions,
} from '../src/persona-notifier.ts'
import { createPersonaDestinations, type DestinationFailure } from '../src/persona-destination.ts'
import { createPersonaDestinationHold } from '../src/persona-destination-hold.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import { escapeSlackControlCharacters, unescapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeMultiPersonaConfig, makeStandInPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness, teardownNoticeEntry, teardownNoticeLine, type NotifierHarness } from './test-helpers/persona-notifier.ts'
import { stubOpenedDmId, type WebApiOutcome } from './test-helpers/slack-stub.ts'
import { LEAK_SENTINEL, assertNoLeak, sentinelInMessage, writtenFile } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Fixture {
  h: NotifierHarness
  A: Persona
  B: Persona
  /** `dm`-destination persona. */
  D: Persona
}

let dir: string
let f: Fixture
let h: NotifierHarness

/**
 * A and B each send notices to a later `all` channel, never their first
 * channel, so a post to "the persona's first channel" is told apart from a
 * post to its destination. A also sits in a `mentions` channel. D sends
 * notices by DM (a valid `dm` destination: DMs on, a contact set).
 */
function makeFixture(baseDir: string): Fixture {
  const config = makeMultiPersonaConfig(
    [
      {
        name: 'Alpha Notifier',
        channels: [
          { id: 'C0ALPHA01', delivery: 'all' },
          { id: 'C0ALPHA02', delivery: 'mentions' },
          { id: 'C0ALPHA03', delivery: 'all' },
        ],
        permission_prompts: 'C0ALPHA03',
      },
      {
        name: 'Beta Notifier',
        channels: [
          { id: 'C0BETA001', delivery: 'all' },
          { id: 'C0BETA002', delivery: 'all' },
        ],
        permission_prompts: 'C0BETA002',
      },
      { name: 'Delta Notifier', channels: [], dm: { enabled: true, contact: 'U0DELTA01' }, permission_prompts: 'dm' },
    ],
    baseDir,
  )
  const [A, B, D] = config.personas as [Persona, Persona, Persona]
  // Enough microtask turns per timer for a retry to post 20 held notices in one `runNext`.
  const clock = createFakeClock({ flushTurns: 500 })
  return { h: makeNotifierHarness(config, { validated: false, leakMarker: LEAK_SENTINEL, clock }), A, B, D }
}

/** Validate the persona's client and flush its held notices. */
async function validateAndFlush(p: Persona): Promise<void> {
  h.validate(p.key)
  await h.notifier.flush(p.key)
}

const ref = (p: Persona) => renderPersonaRef(p.name, p.key)
const texts = (p: Persona) => h.posts(p.key).map((c) => c.text)

/** Every call on `queue` fails with `outcome` until `recover(queue)`. */
function failAlways(queue: WebApiOutcome[], outcome: WebApiOutcome): void {
  queue.push(...Array<WebApiOutcome>(1000).fill(outcome))
}

/** The cause clears: calls on `queue` succeed again. */
function recover(queue: WebApiOutcome[]): void {
  queue.length = 0
}

/** The start of the one `persona-destination-failed` line an episode opens. */
const episodeStart = (p: Persona, step: string, destination: string, code: string) =>
  `[slack] persona-destination-failed: personas[${p.index}] ${ref(p)}: ${step} failed for destination=${destination} with error ${code}`

/** The start of the line that ends the episode. */
const clearedStart = (p: Persona, destination: string) =>
  `[slack] persona-destination-failed: personas[${p.index}] ${ref(p)}: cleared: destination=${destination} accepts posts again`

/** A persona's hold with nothing held. */
const NOT_HELD = { held: false, heldNotices: 0, nextDueAt: undefined }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'persona-notifier-'))
  f = makeFixture(dir)
  h = f.h
})

afterEach(() => {
  try {
    h.hold.cancelAll()
    assertNoLeak({
      lines: h.logs,
      posts: h.allPosts(),
      entries: h.startupEntries(),
      ...(existsSync(h.startupErrorsPath) ? { file: writtenFile(h.startupErrorsPath) } : {}),
    })
  } finally {
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

// Mirror-case selector: [label, notified persona, other persona].
const PAIRS = [
  ['A', (x: Fixture) => x.A, (x: Fixture) => x.B],
  ['B', (x: Fixture) => x.B, (x: Fixture) => x.A],
] as const

// ---------------------------------------------------------------------------
// Destination and identity
// ---------------------------------------------------------------------------

describe('destination and identity (SR-7.2)', () => {
  test.each(PAIRS)(
    'notices for %s post top-level to its permission_prompts channel (not its first channel) through its own client only',
    async (_label, pick, other) => {
      const self = pick(f)
      const peer = other(f)
      // The destination is a later channel, so channels[0] is a wrong answer.
      expect(self.permission_prompts).not.toBe(self.channels[0]!.id)
      h.validate(self.key)
      h.validate(peer.key)

      await h.notifier.notify(self.key, 'Spawn failure:\n  Error: boom')

      expect(h.posts(self.key)).toHaveLength(1)
      const [args] = h.posts(self.key)
      expect(args!.channel).toBe(self.permission_prompts)
      // Top-level, persona's own identity: no thread_ts, username or icon override.
      expect(Object.keys(args!).sort()).toEqual(['channel', 'text'])
      expect(h.posts(peer.key)).toHaveLength(0)
      expect(h.totalPosts()).toBe(1)

      // A second notice goes to the same destination: never to another of its channels.
      await h.notifier.notify(self.key, 'two')
      expect(h.posts(self.key).map((c) => c.channel)).toEqual([self.permission_prompts, self.permission_prompts])
      expect(h.posts(peer.key)).toHaveLength(0)
    },
  )

  test.each(PAIRS)(
    'the posted text for %s carries its persona reference and the body, never a channel ID or "route"',
    async (_label, pick) => {
      const self = pick(f)
      h.validate(self.key)

      await h.notifier.notify(self.key, '*Working directory unreachable* — `/nowhere`')

      const [text] = texts(self)
      expect(text).toContain(ref(self))
      expect(text).toContain('*Working directory unreachable* — `/nowhere`')
      for (const ch of self.channels) expect(text).not.toContain(ch.id)
      expect(text).not.toMatch(/route/i)
    },
  )
})

// ---------------------------------------------------------------------------
// Stored key: a stand-in persona whose key is not derived from its name
// ---------------------------------------------------------------------------

describe('the persona reference uses the stored key (SR-7.2)', () => {
  const STAND_IN = 'C0STAND01'

  /** A stand-in persona (the route→persona adapter's shape): name and key are both the channel ID. */
  function standIn(opts: { post?: WebApiOutcome[]; dryRun?: boolean } = {}): { s: NotifierHarness; p: Persona } {
    const config = makeStandInPersonaConfig({ [STAND_IN]: {} }, dir)
    const p = config.personas[0]!
    // Precondition: the stored key is not the key derived from the name.
    expect(p.key).toBe(STAND_IN)
    expect(personaKey(p.name)).not.toBe(p.key)
    const s = makeNotifierHarness(config, {
      leakMarker: LEAK_SENTINEL,
      dryRun: opts.dryRun,
      post: opts.post ? { [p.key]: opts.post } : undefined,
    })
    return { s, p }
  }

  test('the posted text is exactly "Persona <name> (key=<stored key>): <body>" to the stand-in channel', async () => {
    const { s, p } = standIn()

    await s.notifier.notify(p.key, 'body')

    expect(s.posts(p.key)).toEqual([{ channel: STAND_IN, text: `Persona ${renderPersonaRef(p.name, p.key)}: body` }])
    expect(formatPersonaNotice(p, 'body')).toBe(`Persona "${STAND_IN}" (key=${STAND_IN}): body`)
    expect(s.logs).toEqual([])
    assertNoLeak({ lines: s.logs, posts: s.allPosts() })
  })

  test('the dry-run log line names the persona with its stored key', async () => {
    const { s, p } = standIn({ dryRun: true })

    await s.notifier.notify(p.key, 'Spawn failure:\n  Error: boom')

    expect(s.totalPosts()).toBe(0)
    expect(s.logs).toEqual([`[slack] dry-run: would post notice for ${renderPersonaRef(p.name, p.key)}: Spawn failure:`])
    assertNoLeak({ lines: s.logs })
  })

  test.each<[string, WebApiOutcome, string]>([
    ['the dropped-notice line (a payload error)', { kind: 'platform', error: 'invalid_blocks' }, 'persona-notifier: failed to post notice for '],
    ['the persona-destination-failed line (Slack unreachable)', { kind: 'network' }, 'persona-destination-failed: personas[0] '],
  ])('%s names the persona with its stored key', async (_label, outcome, head) => {
    const { s, p } = standIn({ post: [outcome] })

    await s.notifier.notify(p.key, 'body')

    expect(s.logs).toHaveLength(1)
    expect(s.logs[0]).toStartWith(`[slack] ${head}${renderPersonaRef(p.name, p.key)}`)
    s.hold.cancelAll()
    assertNoLeak({ lines: s.logs, posts: s.allPosts() })
  })
})

// ---------------------------------------------------------------------------
// dm destination (SR-7.1, SR-7.2)
// ---------------------------------------------------------------------------

describe('dm-destination notices (SR-7.2)', () => {
  const dmId = () => stubOpenedDmId(f.D.dm.contact!)
  const methods = (p: Persona) => h.stub(p.key).callLog.map((c) => c.method)

  test('SR-7.2: a DM-only persona\'s notice raised before validation is held with no Slack call, then on flush opens the DM on its own client and posts there', async () => {
    await h.notifier.notify(f.D.key, 'Spawn failure:\n  Error: boom')
    await h.notifier.flush(f.D.key)
    expect(methods(f.D)).toEqual([])

    await validateAndFlush(f.D)

    expect(h.stub(f.D.key).callLog.map((c) => [c.method, c.args])).toEqual([
      ['conversations.open', { users: 'U0DELTA01' }],
      ['chat.postMessage', { channel: dmId(), text: formatPersonaNotice(f.D, 'Spawn failure:\n  Error: boom') }],
    ])
    for (const p of [f.A, f.B]) expect(methods(p)).toEqual([])
    expect(h.logs).toEqual([])
  })

  test('several held dm notices flush with one conversations.open, posted to the DM in raised order; a later notice posts at once with no second open', async () => {
    for (const n of ['1', '2', '3']) await h.notifier.notify(f.D.key, `D${n}`)

    await validateAndFlush(f.D)
    await h.notifier.notify(f.D.key, 'D4')

    expect(methods(f.D)).toEqual(['conversations.open', ...Array(4).fill('chat.postMessage')])
    expect(h.posts(f.D.key)).toEqual(['D1', 'D2', 'D3', 'D4'].map((t) => ({ channel: dmId(), text: formatPersonaNotice(f.D, t) })))
  })

  test.each<[string, WebApiOutcome, string, boolean]>([
    ['missing_scope', { kind: 'platform', error: 'missing_scope' }, 'missing_scope', true],
    ['no conversation ID', { kind: 'ok', result: { channel: undefined } }, 'no_conversation_id', false],
  ])(
    'a failed DM open (%s) holds the notice: nothing posted, one persona-destination-failed line naming conversations.open (im:write for missing_scope only), the callback once with the open step and code; a notice raised meanwhile waits; the retry opens again and posts both in raised order',
    async (_label, outcome, code, isMissingScope) => {
      h.validate(f.D.key)
      h.stub(f.D.key).script.open.push(outcome)
      const failures: DestinationFailure[] = []

      await expect(h.notifier.notify(f.D.key, 'x', { onPostFailure: (err) => failures.push(err) })).resolves.toBeUndefined()
      await h.notifier.notify(f.D.key, 'y')

      expect(methods(f.D)).toEqual(['conversations.open'])
      expect(h.logs).toHaveLength(1)
      expect(h.logs[0]).toStartWith(episodeStart(f.D, 'conversations.open', 'dm', code))
      expect(h.logs[0]!.includes('im:write')).toBe(isMissingScope)
      expect(h.logs[0]).not.toContain('An API error occurred')
      // The whole failure: the open step and its code, no channel (nothing was posted).
      expect(failures).toHaveLength(1)
      const [failure] = failures
      expect(failure!.outcome).toBe('failed')
      expect(failure!.step).toBe('conversations.open')
      expect(failure!.code).toBe(code)
      expect(failure!.channelId).toBeUndefined()
      if (isMissingScope) expect(failure!.error).toBeInstanceOf(Error)
      // No thrown value at all (the cause describer keys on its absence).
      else expect('error' in failure!).toBe(false)
      expect(h.hold.view(f.D.key)).toEqual({ held: true, heldNotices: 2, nextDueAt: 5_000 })

      await h.clock.runNext()

      expect(methods(f.D)).toEqual(['conversations.open', 'conversations.open', 'chat.postMessage', 'chat.postMessage'])
      expect(h.posts(f.D.key)).toEqual(['x', 'y'].map((t) => ({ channel: dmId(), text: formatPersonaNotice(f.D, t) })))
      expect(h.logs).toHaveLength(2)
      expect(h.logs[1]).toStartWith(clearedStart(f.D, 'dm'))
      expect(failures).toHaveLength(1)
      expect(h.hold.view(f.D.key)).toEqual(NOT_HELD)
    },
  )

  test('several notices held before validation and flushed onto a failing shared DM open log one episode line, not one per notice; each callback runs once; they post in raised order once the open succeeds', async () => {
    const failed: string[] = []
    for (const n of ['D1', 'D2', 'D3']) await h.notifier.notify(f.D.key, n, { onPostFailure: () => failed.push(n) })
    failAlways(h.stub(f.D.key).script.open, { kind: 'platform', error: 'missing_scope' })

    await validateAndFlush(f.D)

    // The flush's three attempts shared one open, and its one failure opened one episode.
    expect(methods(f.D)).toEqual(['conversations.open'])
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toStartWith(episodeStart(f.D, 'conversations.open', 'dm', 'missing_scope'))
    expect(h.logs[0]).toContain('im:write')
    expect(failed).toEqual(['D1', 'D2', 'D3'])
    // The flush's later failures did not move the retry either.
    expect(h.hold.view(f.D.key)).toEqual({ held: true, heldNotices: 3, nextDueAt: 5_000 })

    await h.clock.runNext()
    expect(methods(f.D)).toEqual(['conversations.open', 'conversations.open'])
    expect(h.logs).toHaveLength(1)

    recover(h.stub(f.D.key).script.open)
    await h.clock.runNext()

    expect(h.posts(f.D.key)).toEqual(['D1', 'D2', 'D3'].map((t) => ({ channel: dmId(), text: formatPersonaNotice(f.D, t) })))
    expect(h.logs).toHaveLength(2)
    expect(h.logs[1]).toStartWith(clearedStart(f.D, 'dm'))
    expect(failed).toEqual(['D1', 'D2', 'D3'])
  })

  test('an injected destination resolver is the one used: a DM it already opened is reused, with no second conversations.open', async () => {
    // A resolver shared with another caller (the permission poller, in the
    // server), which has already opened D's DM through its own post.
    const web = h.stub(f.D.key).web as unknown as WebClient
    const destinations = createPersonaDestinations({ log: (line) => h.logs.push(line) })
    expect(await destinations.post(f.D, web, { text: 'prompt' })).toMatchObject({ outcome: 'posted', channelId: dmId() })
    expect(methods(f.D)).toEqual(['conversations.open', 'chat.postMessage'])
    const getPersona = (key: string) => h.personas.find((p) => p.key === key)
    const clientFor = (key: string) => h.stub(key).web as unknown as WebClient
    const log = (line: string) => {
      h.logs.push(line)
    }
    // Wired as the server wires it: the shared resolver, and a hold over it (on a fake clock).
    const notifier = createPersonaNotifier({
      getPersona,
      clientFor,
      destinations,
      destinationHold: createPersonaDestinationHold({ destinations, getPersona, clientFor, clock: createFakeClock(), log }),
      isDryRun: () => false,
      log,
    })

    await notifier.notify(f.D.key, 'notice')

    expect(methods(f.D)).toEqual(['conversations.open', 'chat.postMessage', 'chat.postMessage'])
    expect(h.posts(f.D.key).at(-1)).toEqual({ channel: dmId(), text: formatPersonaNotice(f.D, 'notice') })
    expect(h.logs).toEqual([])
  })

  test('a dm destination the resolver refuses (DMs off) makes no Slack call, does not call the failure callback and holds nothing', async () => {
    h.personas.splice(h.personas.indexOf(f.D), 1, { ...f.D, dm: { enabled: false, contact: 'U0DELTA01' } })
    h.validate(f.D.key)
    const failures: unknown[] = []

    await h.notifier.notify(f.D.key, 'x', { onPostFailure: (err) => failures.push(err) })

    expect(methods(f.D)).toEqual([])
    expect(failures).toEqual([])
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain(ref(f.D))
    expect(h.logs[0]).toContain('dm.enabled is not true')
    expect(h.hold.view(f.D.key)).toEqual(NOT_HELD)
    expect(h.clock.pendingCount()).toBe(0)
  })

  test('dry run: a dm-destination notice makes no Slack call of any kind, before or after validation', async () => {
    h.setDryRun(true)

    await h.notifier.notify(f.D.key, 'one')
    await validateAndFlush(f.D)
    await h.notifier.notify(f.D.key, 'two')

    expect(methods(f.D)).toEqual([])
    expect(h.logs).toEqual(['one', 'two'].map((t) => `[slack] dry-run: would post notice for ${ref(f.D)}: ${t}`))
  })
})

// ---------------------------------------------------------------------------
// dry run, unknown key
// ---------------------------------------------------------------------------

describe('notices that are logged, not posted', () => {
  test('dry run makes no Slack call and logs one line naming the persona with only the first line', async () => {
    h.validate(f.A.key)
    h.setDryRun(true)

    await h.notifier.notify(f.A.key, 'Spawn failure:\n  Error: boom')

    expect(h.totalPosts()).toBe(0)
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain(ref(f.A))
    expect(h.logs[0]).not.toContain('Error:')
  })

  test('SR-3.4: in dry run a notice for a persona whose stub would fail makes no Slack call and nothing is held', async () => {
    h.validate(f.A.key)
    h.validate(f.D.key)
    h.setDryRun(true)
    failAlways(h.stub(f.A.key).script.post, { kind: 'platform', error: 'not_in_channel' })
    failAlways(h.stub(f.D.key).script.open, { kind: 'platform', error: 'missing_scope' })

    await h.notifier.notify(f.A.key, 'a')
    await h.notifier.notify(f.D.key, 'd')

    for (const p of [f.A, f.B, f.D]) {
      expect(h.stub(p.key).callLog).toEqual([])
      expect(h.hold.view(p.key)).toEqual(NOT_HELD)
    }
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.logs).toEqual([
      `[slack] dry-run: would post notice for ${ref(f.A)}: a`,
      `[slack] dry-run: would post notice for ${ref(f.D)}: d`,
    ])
  })

  test('an unknown key posts nothing, logs once and does not throw', async () => {
    for (const p of h.personas) h.validate(p.key)

    await expect(h.notifier.notify('no_such_persona', 'hello')).resolves.toBeUndefined()
    await expect(h.notifier.flush('no_such_persona')).resolves.toBeUndefined()

    expect(h.totalPosts()).toBe(0)
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain('no_such_persona')
  })
})

// ---------------------------------------------------------------------------
// Hold and flush per persona
// ---------------------------------------------------------------------------

describe('hold and flush per persona (SR-7.2)', () => {
  test.each(PAIRS)(
    'validating %s first flushes only its held notices, in raised order, exactly once',
    async (_label, pick, other) => {
      const first = pick(f)
      const second = other(f)
      for (const n of ['1', '2', '3']) {
        await h.notifier.notify(f.A.key, `A${n}`)
        await h.notifier.notify(f.B.key, `B${n}`)
      }
      expect(h.totalPosts()).toBe(0)

      // A flush before validation keeps the queue.
      await h.notifier.flush(first.key)
      expect(h.totalPosts()).toBe(0)

      await validateAndFlush(first)
      const tag = first === f.A ? 'A' : 'B'
      const peerTag = tag === 'A' ? 'B' : 'A'
      expect(texts(first).map((t) => t.slice(-2))).toEqual([`${tag}1`, `${tag}2`, `${tag}3`])
      expect(h.posts(first.key).every((c) => c.channel === first.permission_prompts)).toBe(true)
      expect(h.posts(second.key)).toHaveLength(0)

      await validateAndFlush(second)
      expect(texts(second).map((t) => t.slice(-2))).toEqual([`${peerTag}1`, `${peerTag}2`, `${peerTag}3`])

      // Nothing is posted twice.
      await h.notifier.flush(first.key)
      await h.notifier.flush(second.key)
      expect(h.totalPosts()).toBe(6)

      // After validation a notice posts at once, no flush needed.
      await h.notifier.notify(first.key, 'late')
      expect(texts(first).at(-1)).toContain('late')
      expect(h.totalPosts()).toBe(7)
    },
  )

  test('a notice for a validated persona with notices still held posts after them, in raised order', async () => {
    await h.notifier.notify(f.A.key, 'held-1')
    await h.notifier.notify(f.A.key, 'held-2')
    await h.notifier.notify(f.B.key, 'held-B')
    h.validate(f.A.key)

    await h.notifier.notify(f.A.key, 'fresh-3')

    expect(texts(f.A).map((t) => t.split(': ').at(-1))).toEqual(['held-1', 'held-2', 'fresh-3'])
    expect(h.posts(f.B.key)).toHaveLength(0)
    await h.notifier.flush(f.A.key)
    expect(h.posts(f.A.key)).toHaveLength(3)
  })

  test('a held notice whose persona is no longer applied at flush time is dropped with a log line', async () => {
    await h.notifier.notify(f.A.key, 'held')
    h.personas.splice(h.personas.indexOf(f.A), 1)

    await validateAndFlush(f.A)

    expect(h.totalPosts()).toBe(0)
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain(f.A.key)
  })

  test('held notices are bounded per persona: the 21st drops only the oldest (one line, its first line), the newest 20 post in order, the other persona\'s queue is untouched', async () => {
    const bound = MAX_HELD_NOTICES_PER_PERSONA
    expect(bound).toBe(20)
    // Multi-line bodies: the drop line must carry the first line only.
    const noticeA = (i: number) => `A-notice-${String(i).padStart(2, '0')}\n  detail line ${i}`
    const noticeB = (i: number) => `B-notice-${i}\n  detail`

    // A's bound is its own: B's notices, interleaved, count only against B.
    for (let i = 1; i <= bound; i++) {
      await h.notifier.notify(f.A.key, noticeA(i))
      if (i <= 3) await h.notifier.notify(f.B.key, noticeB(i))
    }
    // Exactly at the bound nothing is dropped.
    expect(h.logs).toEqual([])

    await h.notifier.notify(f.A.key, noticeA(bound + 1))

    expect(h.totalPosts()).toBe(0)
    expect(h.logs).toEqual([
      `[slack] persona-notifier: more than ${bound} notices held for ${ref(f.A)} — ` +
        'oldest held notice dropped, not posted: A-notice-01',
    ])

    await validateAndFlush(f.A)

    // The newest 20, in raised order, to A's destination through A's client; the dropped one never posts.
    const expected = Array.from({ length: bound }, (_, i) => formatPersonaNotice(f.A, noticeA(i + 2)))
    expect(texts(f.A)).toEqual(expected)
    expect(h.posts(f.A.key).every((c) => c.channel === f.A.permission_prompts)).toBe(true)
    expect(h.posts(f.B.key)).toEqual([])

    // A second flush posts nothing more: the dropped notice is gone for good.
    await h.notifier.flush(f.A.key)
    expect(h.posts(f.A.key)).toHaveLength(bound)
    expect(h.posts(f.A.key).some((c) => c.text.includes('A-notice-01'))).toBe(false)

    // B's queue kept all three of its notices, in raised order, and dropped none.
    await validateAndFlush(f.B)
    expect(texts(f.B)).toEqual([1, 2, 3].map((i) => formatPersonaNotice(f.B, noticeB(i))))
    expect(h.logs).toHaveLength(1)
    assertNoLeak({ lines: h.logs, posts: h.allPosts() })
  })
})


// ---------------------------------------------------------------------------
// A teardown forgets the persona's held notices (b.av2 SR-6.5)
// ---------------------------------------------------------------------------

describe('forget(key): a teardown drops the persona\'s pre-validation queue (b.av2 SR-6.5)', () => {
  const droppedLine = (p: Persona, n: number) =>
    `[slack] persona-notifier: persona=${p.key}: dropped ${n} held notice(s), not posted — the persona was torn down`

  test('drops A\'s held notices unposted with one line naming the count and no Slack call; A re-added under the same key posts only its own notices, and B\'s queue is untouched', async () => {
    await h.notifier.notify(f.A.key, 'old-1')
    await h.notifier.notify(f.A.key, 'old-2')
    await h.notifier.notify(f.B.key, 'b-1')

    h.notifier.forget(f.A.key)

    expect(h.logs).toEqual([droppedLine(f.A, 2)])
    for (const p of h.personas) expect(h.stub(p.key).callLog).toEqual([])

    // A leaves the applied set and is added again under the same key.
    h.personas.splice(h.personas.indexOf(f.A), 1)
    h.personas.push({ ...f.A })
    await h.notifier.notify(f.A.key, 'new-1')
    await validateAndFlush(f.A)
    await h.notifier.notify(f.A.key, 'new-2')
    expect(texts(f.A)).toEqual(['new-1', 'new-2'].map((t) => formatPersonaNotice(f.A, t)))

    await validateAndFlush(f.B)
    expect(texts(f.B)).toEqual([formatPersonaNotice(f.B, 'b-1')])
    expect(h.logs).toHaveLength(1)
  })

  test.each<[string, (x: Fixture) => string]>([
    ['a persona with nothing held', (x) => x.A.key],
    ['a key no persona has', () => 'no_such_persona'],
  ])('%s: forget logs nothing, calls no Slack method and does not throw', async (_label, key) => {
    await h.notifier.notify(f.B.key, 'b-1')
    h.notifier.forget(key(f))
    expect(h.logs).toEqual([])
    expect(h.totalPosts()).toBe(0)
    await validateAndFlush(f.B)
    expect(texts(f.B)).toEqual([formatPersonaNotice(f.B, 'b-1')])
  })

  test('leaves the destination hold alone: with a notice held for a failing destination and another queued before validation, only the queued one is dropped; the held one posts once the cause clears', async () => {
    h.validate(f.A.key)
    failAlways(h.stub(f.A.key).script.post, { kind: 'platform', error: 'not_in_channel' })
    await h.notifier.notify(f.A.key, 'held-at-destination')
    // A's client is unavailable again (as before validation): the next notice is queued.
    h.validated.delete(f.A.key)
    await h.notifier.notify(f.A.key, 'queued')
    const heldView = { held: true, heldNotices: 1, nextDueAt: 5_000 }
    expect(h.hold.view(f.A.key)).toEqual(heldView)
    const linesBefore = [...h.logs]

    h.notifier.forget(f.A.key)

    expect(h.logs).toEqual([...linesBefore, droppedLine(f.A, 1)])
    expect(h.hold.view(f.A.key)).toEqual(heldView)
    h.validate(f.A.key)
    recover(h.stub(f.A.key).script.post)
    await h.clock.runNext()
    await h.notifier.flush(f.A.key)
    // The failed first attempt, then the one retry that posted; the queued notice never.
    expect(texts(f.A)).toEqual(['held-at-destination', 'held-at-destination'].map((t) => formatPersonaNotice(f.A, t)))
    expect(h.hold.view(f.A.key)).toEqual(NOT_HELD)
  })
})

// ---------------------------------------------------------------------------
// Destination failures: held, retried on backoff, logged once per episode
// ---------------------------------------------------------------------------

describe('destination failures are held and retried, one line per episode (SR-7.1, SR-10.3)', () => {
  // [label, persona, the stub queue that fails, its outcome, failed step, code, names im:write]
  test.each<[string, (x: Fixture) => Persona, 'open' | 'post', WebApiOutcome, string, string, boolean]>([
    ['missing_scope on the DM open', (x) => x.D, 'open', { kind: 'platform', error: 'missing_scope' }, 'conversations.open', 'missing_scope', true],
    ['not_in_channel on a channel destination', (x) => x.A, 'post', { kind: 'platform', error: 'not_in_channel' }, 'chat.postMessage', 'not_in_channel', false],
    ['not_in_channel on the opened DM', (x) => x.D, 'post', { kind: 'platform', error: 'not_in_channel' }, 'chat.postMessage', 'not_in_channel', false],
    ['Slack unreachable on a channel destination', (x) => x.B, 'post', { kind: 'network' }, 'chat.postMessage', 'network_error', false],
  ])(
    '%s: the notices are held with no post, one line names the persona, the callback runs once, retries at 5 s, 10 s, 20 s log nothing, and once it clears both post once in raised order through its own client',
    async (_label, pick, queue, outcome, step, code, namesImWrite) => {
      const p = pick(f)
      const isDm = p.permission_prompts === 'dm'
      const destination = isDm ? 'dm' : p.permission_prompts
      const postedTo = isDm ? stubOpenedDmId(p.dm.contact!) : p.permission_prompts
      const stub = h.stub(p.key)
      const attempts = () => stub.callLog.filter((c) => c.method === step).length
      h.validate(p.key)
      failAlways(stub.script[queue], outcome)
      const failures: DestinationFailure[] = []

      await h.notifier.notify(p.key, 'Spawn failure:\n  Error: boom', { onPostFailure: (x) => failures.push(x) })
      await h.notifier.notify(p.key, 'second')

      // One attempt, of the first notice only; the second waits behind it.
      expect(attempts()).toBe(1)
      expect(texts(p).every((t) => t === formatPersonaNotice(p, 'Spawn failure:\n  Error: boom'))).toBe(true)
      expect(h.logs).toHaveLength(1)
      expect(h.logs[0]).toStartWith(episodeStart(p, step, destination, code))
      expect(h.logs[0]!.includes('im:write')).toBe(namesImWrite)
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({ outcome: 'failed', step, code })
      expect(h.hold.view(p.key)).toEqual({ held: true, heldNotices: 2, nextDueAt: 5_000 })

      // Retries on the SR-3.2 backoff: nothing before each is due, one attempt each, no line, no callback.
      await h.clock.advance(4_999)
      expect(attempts()).toBe(1)
      const retriedAt: number[] = []
      for (let i = 0; i < 3; i++) {
        await h.clock.runNext()
        retriedAt.push(h.clock.now())
      }
      expect(retriedAt).toEqual([5_000, 15_000, 35_000])
      expect(attempts()).toBe(4)
      expect(texts(p).every((t) => t === formatPersonaNotice(p, 'Spawn failure:\n  Error: boom'))).toBe(true)
      expect(h.logs).toHaveLength(1)
      expect(failures).toHaveLength(1)

      recover(stub.script[queue])
      await h.clock.runNext()

      expect(h.clock.now()).toBe(75_000)
      // Each notice posted exactly once, in raised order, to the destination (a DM's `D…` ID, never the contact).
      const failedPosts = queue === 'post' ? 4 : 0
      expect(h.posts(p.key).slice(failedPosts)).toEqual(
        ['Spawn failure:\n  Error: boom', 'second'].map((t) => ({ channel: postedTo, text: formatPersonaNotice(p, t) })),
      )
      expect(h.logs).toHaveLength(2)
      expect(h.logs[1]).toStartWith(clearedStart(p, destination))
      expect(failures).toHaveLength(1)
      expect(h.hold.view(p.key)).toEqual(NOT_HELD)
      expect(h.clock.pendingCount()).toBe(0)
      // Only the persona's own client made a call.
      for (const other of h.personas.filter((q) => q.key !== p.key)) expect(h.stub(other.key).callLog).toEqual([])
    },
  )

  test('two failing personas each get their own line and schedule; one clearing delivers only its notices while the other stays held', async () => {
    h.validate(f.A.key)
    h.validate(f.B.key)
    h.validate(f.D.key)
    failAlways(h.stub(f.A.key).script.post, { kind: 'platform', error: 'not_in_channel' })
    failAlways(h.stub(f.D.key).script.open, { kind: 'platform', error: 'missing_scope' })

    await h.notifier.notify(f.A.key, 'a1')
    await h.notifier.notify(f.D.key, 'd1')
    await h.notifier.notify(f.B.key, 'b1')

    expect(h.logs).toHaveLength(2)
    expect(h.logs[0]).toStartWith(episodeStart(f.A, 'chat.postMessage', f.A.permission_prompts, 'not_in_channel'))
    expect(h.logs[0]).not.toContain('im:write')
    expect(h.logs[1]).toStartWith(episodeStart(f.D, 'conversations.open', 'dm', 'missing_scope'))
    expect(h.logs[1]).toContain('im:write')
    // B, not failing, posts at once and is never held.
    expect(texts(f.B)).toEqual([formatPersonaNotice(f.B, 'b1')])
    expect(h.hold.view(f.B.key)).toEqual(NOT_HELD)

    recover(h.stub(f.A.key).script.post)
    await h.clock.runNext() // both personas' first retries are due at 5 s

    expect(texts(f.A)).toEqual(['a1', 'a1'].map((t) => formatPersonaNotice(f.A, t)))
    expect(h.posts(f.D.key)).toEqual([])
    expect(h.logs).toHaveLength(3)
    expect(h.logs[2]).toStartWith(clearedStart(f.A, f.A.permission_prompts))
    expect(h.hold.view(f.A.key)).toEqual(NOT_HELD)
    expect(h.hold.view(f.D.key)).toEqual({ held: true, heldNotices: 1, nextDueAt: 15_000 })

    recover(h.stub(f.D.key).script.open)
    await h.clock.runNext()

    expect(h.clock.now()).toBe(15_000)
    expect(h.posts(f.D.key)).toEqual([{ channel: stubOpenedDmId(f.D.dm.contact!), text: formatPersonaNotice(f.D, 'd1') }])
    expect(h.logs).toHaveLength(4)
    expect(h.logs[3]).toStartWith(clearedStart(f.D, 'dm'))
    expect(texts(f.B)).toHaveLength(1)
  })

  test('a held notice dropped past MAX_HELD_NOTICES_PER_PERSONA while its destination fails is named in the drop line by its first line only', async () => {
    const notice = (i: number) => `A-held-${String(i).padStart(2, '0')}\n  detail line ${i}`
    h.validate(f.A.key)
    failAlways(h.stub(f.A.key).script.post, { kind: 'platform', error: 'not_in_channel' })

    for (let i = 1; i <= MAX_HELD_NOTICES_PER_PERSONA + 1; i++) await h.notifier.notify(f.A.key, notice(i))

    const dropLines = h.logs.filter((l) => l.includes('oldest held notice dropped'))
    expect(dropLines).toHaveLength(1)
    expect(dropLines[0]).toEndWith(': A-held-01')
    expect(dropLines[0]).not.toContain('detail line')
  })
})

// ---------------------------------------------------------------------------
// Failed posts and the failure callback
// ---------------------------------------------------------------------------

// [label, scripted post outcome, the failure's code]
const FAILURES: [string, WebApiOutcome, string][] = [
  ['platform', { kind: 'platform', error: 'channel_not_found' }, 'channel_not_found'],
  ['reject(undefined)', { kind: 'reject', value: undefined }, 'unknown_error'],
]

describe('failed posts and the failure callback (SR-11 spawn-failure-post class)', () => {
  test.each(FAILURES)(
    'a rejected immediate post (%s): notify resolves and the callback gets the whole failure, the rejection included',
    async (_label, outcome, code) => {
      h.validate(f.A.key)
      h.stub(f.A.key).script.post.push(outcome)
      const failures: DestinationFailure[] = []

      await expect(
        h.notifier.notify(f.A.key, 'Spawn failure', { onPostFailure: (failure) => failures.push(failure) }),
      ).resolves.toBeUndefined()

      expect(h.posts(f.A.key)).toHaveLength(1)
      expect(failures).toHaveLength(1)
      const [failure] = failures
      expect(failure!.step).toBe('chat.postMessage')
      expect(failure!.code).toBe(code)
      expect(failure!.channelId).toBe(f.A.permission_prompts)
      // The rejection itself is handed over, even when it is `undefined`.
      expect('error' in failure!).toBe(true)
      if (outcome.kind === 'reject') expect(failure!.error).toBeUndefined()
      else expect(failure!.error).toBeInstanceOf(Error)
    },
  )

  test('a notice held before validation whose flushed post is rejected calls its callback once and is retried; the other flushed notice posts and never calls its callback', async () => {
    const failures: unknown[] = []
    const successes: unknown[] = []
    await h.notifier.notify(f.A.key, 'fails', { onPostFailure: (err) => failures.push(err) })
    await h.notifier.notify(f.A.key, 'succeeds', { onPostFailure: (err) => successes.push(err) })
    h.stub(f.A.key).script.post.push({ kind: 'network' })

    await expect(validateAndFlush(f.A)).resolves.toBeUndefined()

    // Both flushed posts were issued together; only the first failed.
    expect(failures).toHaveLength(1)
    expect(successes).toHaveLength(0)
    expect(h.posts(f.A.key)).toHaveLength(2)
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain(ref(f.A))
    expect(h.hold.view(f.A.key)).toEqual({ held: true, heldNotices: 1, nextDueAt: 5_000 })

    await h.clock.runNext()

    expect(texts(f.A)).toEqual(['fails', 'succeeds', 'fails'].map((t) => formatPersonaNotice(f.A, t)))
    expect(failures).toHaveLength(1)
    expect(successes).toHaveLength(0)
    expect(h.logs).toHaveLength(2)
  })

  test('a failure callback that throws is logged once and does not reject; the notice is still held and posted', async () => {
    h.validate(f.A.key)
    failAlways(h.stub(f.A.key).script.post, { kind: 'network' })

    await expect(
      h.notifier.notify(f.A.key, 'x', {
        onPostFailure: () => {
          throw new Error('callback broke')
        },
      }),
    ).resolves.toBeUndefined()
    await h.clock.runNext()

    expect(h.logs).toHaveLength(2)
    expect(h.logs.every((l) => l.includes(ref(f.A)))).toBe(true)
    expect(h.logs.filter((l) => l.includes('callback threw'))).toHaveLength(1)
    expect(h.hold.view(f.A.key).heldNotices).toBe(1)

    recover(h.stub(f.A.key).script.post)
    await h.clock.runNext()

    expect(h.posts(f.A.key)).toHaveLength(3)
    expect(h.logs).toHaveLength(3)
  })

  test('a postMessage that throws synchronously is held under one line, calls the callback once, notify resolves, and it posts once the client answers', async () => {
    h.validate(f.A.key)
    const web = h.stub(f.A.key).web
    const original = web.chat.postMessage
    const thrown = Object.assign(new Error(`sync failure ${LEAK_SENTINEL}`), { code: 'slack_webapi_request_error' })
    let calls = 0
    web.chat.postMessage = (() => {
      calls++
      throw thrown
    }) as typeof web.chat.postMessage
    const failures: DestinationFailure[] = []

    await expect(
      h.notifier.notify(f.A.key, 'x', { onPostFailure: (failure) => failures.push(failure) }),
    ).resolves.toBeUndefined()
    await h.clock.runNext()

    expect(calls).toBe(2)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.step).toBe('chat.postMessage')
    expect(failures[0]!.channelId).toBe(f.A.permission_prompts)
    expect(failures[0]!.error).toBe(thrown)
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toStartWith(episodeStart(f.A, 'chat.postMessage', f.A.permission_prompts, 'network_error'))

    web.chat.postMessage = original
    await h.clock.runNext()

    expect(texts(f.A)).toEqual([formatPersonaNotice(f.A, 'x')])
    expect(h.logs).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Failure log lines: Slack platform reason, and the error's message logged redacted
// ---------------------------------------------------------------------------

describe('failure log lines (SR-10.3 token-safe)', () => {
  test.each<[string, (x: Fixture) => Persona, string, (x: Fixture) => string]>([
    ['invalid_blocks on a channel destination', (x) => x.A, 'invalid_blocks', (x) => x.A.permission_prompts],
    ['msg_too_long in the opened DM', (x) => x.D, 'msg_too_long', (x) => stubOpenedDmId(x.D.dm.contact!)],
  ])(
    'a post refused for the message itself (%s) is dropped, not held: one per-notice line with the short reason beside the destination and the error\'s message logged redacted, the callback once, no episode; the next notice posts at once',
    async (_label, pick, code, where) => {
      const p = pick(f)
      h.validate(p.key)
      h.stub(p.key).script.post.push({ kind: 'platform', error: code })
      const failures: DestinationFailure[] = []

      await h.notifier.notify(p.key, 'x', { onPostFailure: (x) => failures.push(x) })

      expect(h.logs).toHaveLength(1)
      expect(h.logs[0]).toStartWith(`[slack] persona-notifier: failed to post notice for ${ref(p)} to ${where(f)} (reason=${code}): `)
      expect(h.logs[0]).toContain('code=slack_webapi_platform_error')
      // The error's message is logged redacted: the stub's rejection quotes a
      // fake token and a WebSocket ticket URL, each holding the leak sentinel
      // (the afterEach leak check covers the sentinel itself).
      const message = /message="([^"]*)"/.exec(h.logs[0]!)?.[1]
      expect(message).toContain('An API error occurred')
      expect(message).toContain(code)
      expect(message).toContain('<redacted-token>')
      expect(message).toContain('<redacted-url>')
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({ step: 'chat.postMessage', code, channelId: where(f) })
      expect(h.hold.view(p.key)).toEqual(NOT_HELD)
      expect(h.clock.pendingCount()).toBe(0)

      await h.notifier.notify(p.key, 'y')

      expect(texts(p)).toEqual(['x', 'y'].map((t) => formatPersonaNotice(p, t)))
      expect(h.logs).toHaveLength(1)
    },
  )
})

// ---------------------------------------------------------------------------
// The persona teardown window (b.jg5 SRJ-1003, SRJ-1002, SRJ-1013, AC 65)
// ---------------------------------------------------------------------------

describe('the persona teardown window: every notice for the key is a log line and a startup-errors entry, never posted, held or dropped (b.jg5 SRJ-1003)', () => {
  /** The line a notice written by the window logs (`teardownNoticeLine`): `<class>` its entry's class, the notice's first line. */
  const windowLine = (p: Persona, text: string, classLabel: string = PERSONA_TEARDOWN_NOTICE_LABEL) =>
    teardownNoticeLine(p, text, PERSONA_TEARDOWN_NOTICE_RAISED, classLabel)

  /** The line an all-clear written after the window closed logs. */
  const allClearLine = (p: Persona, text: string) => teardownNoticeLine(p, text, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER)

  // The teardown route's one literal pin (b.jg5 SRJ-1003, SRJ-1013): the two
  // occasions, an entry's text and both forms of the line, the notice's first
  // line only, its Slack escapes undone. Every other case builds them with
  // `teardownNoticeEntry` and `teardownNoticeLine`.
  test('the teardown route\'s occasions, entry text and log lines (pin)', () => {
    const p = { name: 'Alpha', key: 'alpha_1' }
    expect([PERSONA_TEARDOWN_NOTICE_RAISED, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER]).toEqual([
      'raised during its teardown',
      'the all-clear of an outage raised during its teardown',
    ])
    expect(personaTeardownNoticeEntryText('persona "Alpha" (key=alpha_1)', 'Outage &lt;x&gt;\nmore')).toBe(
      'persona "Alpha" (key=alpha_1), raised during its teardown: Outage &lt;x&gt;\nmore',
    )
    expect(personaTeardownNoticeEntryText('persona "Alpha" (key=alpha_1)', 'All clear', PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER)).toBe(
      'persona "Alpha" (key=alpha_1), the all-clear of an outage raised during its teardown: All clear',
    )
    expect(personaTeardownNoticeWrittenLine(p, PERSONA_TEARDOWN_NOTICE_LABEL, PERSONA_TEARDOWN_NOTICE_RAISED, 'Outage &lt;x&gt;\nmore')).toBe(
      '[slack] persona-notifier: notice for "Alpha" (key=alpha_1) raised during its teardown — written to the server log and startup-errors.log (persona-teardown-notice), not posted: Outage <x>',
    )
    expect(personaTeardownNoticeWrittenLine(p, PERSONA_TEARDOWN_NOTICE_LABEL, PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER, 'All clear')).toBe(
      '[slack] persona-notifier: all-clear for "Alpha" (key=alpha_1) of an outage raised during its teardown — written to the server log and startup-errors.log (persona-teardown-notice), not posted: All clear',
    )
  })

  const droppedLine = (p: Persona, n: number) =>
    `[slack] persona-notifier: persona=${p.key}: dropped ${n} held notice(s), not posted — the persona was torn down`

  /** No Slack call of any kind on any persona's stub, nothing held at a destination and no hold timer. */
  function expectNoSlackCallOrHold(): void {
    for (const p of [f.A, f.B, f.D]) {
      expect(h.stub(p.key).callLog).toEqual([])
      expect(h.hold.view(p.key)).toEqual(NOT_HELD)
    }
    expect(h.clock.pendingCount()).toBe(0)
  }

  const onset = (...classes: OutageClass[]): PersonaNoticeOptions => ({ outage: { phase: PERSONA_NOTICE_OUTAGE_ONSET, classes } })
  const allClear = (...classes: OutageClass[]): PersonaNoticeOptions => ({ outage: { phase: PERSONA_NOTICE_OUTAGE_ALL_CLEAR, classes } })

  /**
   * The applied set for the case: the key still applied as a destructive
   * modify's new half, which sends its notices to another destination (A:
   * another of its channels; D: its DM with another contact), or the key no
   * longer applied (apply step 1 removed it).
   */
  function applyCase(p: Persona, stillApplied: boolean): void {
    const at = h.personas.findIndex((q) => q.key === p.key)
    if (!stillApplied) {
      h.personas.splice(at, 1)
      return
    }
    const newHalf: Persona =
      p.permission_prompts === 'dm'
        ? { ...p, dm: { enabled: true, contact: 'U0DELTA02' } }
        : { ...p, permission_prompts: p.channels[0]!.id }
    expect(newHalf.permission_prompts === 'dm' ? newHalf.dm.contact : newHalf.permission_prompts).not.toBe(
      p.permission_prompts === 'dm' ? p.dm.contact : p.permission_prompts,
    )
    h.personas.splice(at, 1, newHalf)
  }

  // Rows: the persona (a channel or a `dm` destination), whether its client is validated, and whether its key is
  // still applied (a destructive modify's old half, its new half sending notices elsewhere) or no longer applied.
  test.each<[string, (x: Fixture) => Persona, boolean, boolean]>([
    ['channel destination, validated, still applied', (x) => x.A, true, true],
    ['channel destination, validated, no longer applied', (x) => x.A, true, false],
    ['channel destination, not validated, still applied', (x) => x.A, false, true],
    ['channel destination, not validated, no longer applied', (x) => x.A, false, false],
    ['dm destination, validated, still applied', (x) => x.D, true, true],
    ['dm destination, validated, no longer applied', (x) => x.D, true, false],
    ['dm destination, not validated, still applied', (x) => x.D, false, true],
    ['dm destination, not validated, no longer applied', (x) => x.D, false, false],
  ])('%s: a notice raised in the window makes no Slack call, is neither queued nor held, and writes one log line and one persona-teardown-notice entry naming the persona; nothing posts once the window closes', async (_label, pick, validated, stillApplied) => {
    const p = pick(f)
    if (validated) h.validate(p.key)
    applyCase(p, stillApplied)
    const text = 'Spawn failure:\n  Error: boom'

    await h.duringTeardown(p, async () => {
      await expect(h.notifier.notify(p.key, text)).resolves.toBeUndefined()
      // A flush in the window posts nothing.
      await h.notifier.flush(p.key)
    })

    expect(h.startupEntries()).toEqual([teardownNoticeEntry(p, text)])
    expect(h.startupEntries()[0]!.classLabel).toBe(PERSONA_TEARDOWN_NOTICE_LABEL)
    expect(h.startupEntries()[0]!.text).toContain(PERSONA_TEARDOWN_NOTICE_RAISED)
    expect(h.logs).toEqual([windowLine(p, text)])
    expectNoSlackCallOrHold()

    // Nothing was queued: a forget drops nothing, and a validated flush posts nothing.
    h.notifier.forget(p.key)
    h.validate(p.key)
    await h.notifier.flush(p.key)
    expect(h.logs).toEqual([windowLine(p, text)])
    expectNoSlackCallOrHold()
  })

  test('the window comes before the dry-run branch: in dry run a notice raised in it is still written, with no dry-run line', async () => {
    h.validate(f.A.key)
    h.setDryRun(true)

    await h.duringTeardown(f.A, () => h.notifier.notify(f.A.key, 'onset'))

    expect(h.logs).toEqual([windowLine(f.A, 'onset')])
    expect(h.startupEntries()).toEqual([teardownNoticeEntry(f.A, 'onset')])
    expectNoSlackCallOrHold()
  })

  test('b.jg5 SRJ-704, SRJ-1013: the survivor option writes one persona-kill-survivor entry and no persona-teardown-notice one, and posts nothing; outside a window the option changes nothing', async () => {
    h.validate(f.A.key)
    const survivor: PersonaNoticeOptions = { teardownEntryClass: PERSONA_KILL_SURVIVOR_LABEL }

    await h.duringTeardown(f.A, () => h.notifier.notify(f.A.key, 'survivor version', survivor))

    expect(h.startupEntries()).toEqual([teardownNoticeEntry(f.A, 'survivor version', PERSONA_TEARDOWN_NOTICE_RAISED, PERSONA_KILL_SURVIVOR_LABEL)])
    expect(h.startupEntries().filter((e) => e.classLabel === PERSONA_TEARDOWN_NOTICE_LABEL)).toEqual([])
    expect(h.logs).toEqual([windowLine(f.A, 'survivor version', PERSONA_KILL_SURVIVOR_LABEL)])
    expectNoSlackCallOrHold()

    await h.notifier.notify(f.A.key, 'survivor version', survivor)
    expect(h.posts(f.A.key)).toEqual([{ channel: f.A.permission_prompts, text: formatPersonaNotice(f.A, 'survivor version') }])
    expect(h.startupEntries()).toHaveLength(1)
  })

  test('forget in the window drops none of the notices raised in it; a notice queued before the window is dropped by it with its one line, and a flush in the window posts nothing of it', async () => {
    await h.notifier.notify(f.A.key, 'queued before')
    h.validate(f.A.key) // the queue waits for a flush

    const window = h.openTeardown(f.A)
    await h.notifier.notify(f.A.key, 'in the window 1')
    await h.notifier.flush(f.A.key)
    expect(h.posts(f.A.key)).toEqual([])
    h.notifier.forget(f.A.key)
    await h.notifier.notify(f.A.key, 'in the window 2')
    h.notifier.forget(f.A.key)
    window.close()
    h.notifier.forget(f.A.key)
    await h.notifier.flush(f.A.key)

    expect(h.startupEntries()).toEqual([teardownNoticeEntry(f.A, 'in the window 1'), teardownNoticeEntry(f.A, 'in the window 2')])
    expect(h.logs).toEqual([windowLine(f.A, 'in the window 1'), droppedLine(f.A, 1), windowLine(f.A, 'in the window 2')])
    expectNoSlackCallOrHold()
  })

  test('after the window closes the key\'s notices route as before (posted for an applied key, dropped with its line for a removed one); another persona\'s notices in the window post as usual', async () => {
    for (const p of [f.A, f.B]) h.validate(p.key)

    await h.duringTeardown(f.A, () => h.notifier.notify(f.B.key, 'B in A\'s window'))
    expect(h.posts(f.B.key)).toEqual([{ channel: f.B.permission_prompts, text: formatPersonaNotice(f.B, 'B in A\'s window') }])

    await h.notifier.notify(f.A.key, 'after')
    expect(h.posts(f.A.key)).toEqual([{ channel: f.A.permission_prompts, text: formatPersonaNotice(f.A, 'after') }])

    h.personas.splice(h.personas.indexOf(f.A), 1)
    await h.duringTeardown(f.A, () => undefined)
    await h.notifier.notify(f.A.key, 'removed')
    expect(h.posts(f.A.key)).toHaveLength(1)
    expect(h.logs).toEqual([`[slack] persona-notifier: no applied persona with key=${f.A.key} — notice dropped`])
    expect(h.startupEntries()).toEqual([])
  })

  // b.jg5 SRJ-1002, SRJ-1003 (hatch A3): the all-clear of an outage whose onset the window routed.
  test('an onset routed by the window marks its outage: the all-clear that comes after the window closed is written (the all-clear occasion) and never reaches the new half\'s destination; a later all-clear of that class posts as usual', async () => {
    h.validate(f.A.key)
    applyCase(f.A, true) // the new half, validated, sends its notices to another channel
    const newHalf = h.personas.find((q) => q.key === f.A.key)!

    await h.duringTeardown(f.A, () => h.notifier.notify(f.A.key, 'onset: unreachable', onset('ad-unreachable')))
    await h.notifier.notify(f.A.key, 'all clear: unreachable', allClear('ad-unreachable'))

    expect(h.startupEntries()).toEqual([
      teardownNoticeEntry(f.A, 'onset: unreachable'),
      teardownNoticeEntry(f.A, 'all clear: unreachable', PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER),
    ])
    expect(h.logs).toEqual([windowLine(f.A, 'onset: unreachable'), allClearLine(f.A, 'all clear: unreachable')])
    expectNoSlackCallOrHold()

    // The mark is spent: the next all-clear of that class is an ordinary notice.
    await h.notifier.notify(f.A.key, 'all clear again', allClear('ad-unreachable'))
    expect(h.posts(f.A.key)).toEqual([{ channel: newHalf.permission_prompts, text: formatPersonaNotice(newHalf, 'all clear again') }])
    expect(h.startupEntries()).toHaveLength(2)
  })

  // Rows: what follows the onset the window routed, before the all-clear that comes after the window closed.
  test.each<[string, (x: Fixture) => Promise<void>, boolean]>([
    ['an all-clear listing a class the window did not mark', async (x) => {
      await h.notifier.notify(x.A.key, 'all clear: other', allClear('tmux-unavailable'))
    }, false],
    ['an onset of the marked class raised outside any window (a new outage)', async (x) => {
      await h.notifier.notify(x.A.key, 'onset again', onset('ad-unreachable'))
    }, true],
    ['an all-clear of the marked class raised in the window itself', async (x) => {
      await h.duringTeardown(x.A, () => h.notifier.notify(x.A.key, 'all clear in window', allClear('ad-unreachable')))
    }, true],
  ])('%s: the marked class\'s all-clear after the window posts as usual once its mark is gone, and is written while the mark stands (mark gone: %p)', async (_label, between, markGone) => {
    h.validate(f.A.key)
    await h.duringTeardown(f.A, () => h.notifier.notify(f.A.key, 'onset: unreachable', onset('ad-unreachable')))
    await between(f)
    const entriesBefore = h.startupEntries().length

    await h.notifier.notify(f.A.key, 'all clear: unreachable', allClear('ad-unreachable'))

    const posted = h.posts(f.A.key).map((c) => c.text)
    if (markGone) {
      expect(posted.at(-1)).toBe(formatPersonaNotice(f.A, 'all clear: unreachable'))
      expect(h.startupEntries()).toHaveLength(entriesBefore)
    } else {
      expect(posted).not.toContain(formatPersonaNotice(f.A, 'all clear: unreachable'))
      expect(h.startupEntries().slice(entriesBefore)).toEqual([teardownNoticeEntry(f.A, 'all clear: unreachable', PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER)])
    }
  })

  test('the all-clear of an outage whose onset the window routed for a removed key is written whenever it comes, naming the persona as the window did', async () => {
    h.personas.splice(h.personas.indexOf(f.A), 1)

    await h.duringTeardown(f.A, () => h.notifier.notify(f.A.key, 'onset', onset('ad-config-malformed')))
    await h.notifier.notify(f.A.key, 'all clear', allClear('tmux-unavailable', 'ad-config-malformed'))

    expect(h.startupEntries()).toEqual([
      teardownNoticeEntry(f.A, 'onset'),
      teardownNoticeEntry(f.A, 'all clear', PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER),
    ])
    expect(h.logs).toEqual([windowLine(f.A, 'onset'), allClearLine(f.A, 'all clear')])
    expectNoSlackCallOrHold()
  })

  // Rows: no recorder installed, or the error the installed recorder throws (its line gives that error, described).
  test.each<[string, Error | undefined]>([
    ['no recorder installed', undefined],
    ['a recorder that throws', new Error('disk full')],
  ])('%s: the notice is still never posted, held or dropped, and its one line says its entry was not written', async (_label, thrown) => {
    const recorder = thrown === undefined ? null : () => { throw thrown }
    const reason = thrown === undefined ? 'no startup-errors recorder is installed' : describeThrownValue(thrown)
    const s = makeNotifierHarness(
      makeMultiPersonaConfig([{ name: 'Alpha Notifier' }], dir),
      { leakMarker: LEAK_SENTINEL, recordStartupError: recorder },
    )
    const [p] = s.personas as [Persona]

    try {
      await expect(s.duringTeardown(p, () => s.notifier.notify(p.key, 'notice\n  detail'))).resolves.toBeUndefined()

      expect(s.logs).toEqual([
        `[slack] persona-notifier: notice for ${ref(p)} raised during its teardown — not posted, and its startup-errors entry was not written: ${reason}: notice`,
      ])
      expect(s.stub(p.key).callLog).toEqual([])
      expect(s.hold.view(p.key)).toEqual(NOT_HELD)
      expect(s.startupEntries()).toEqual([])
      assertNoLeak({ lines: s.logs })
    } finally {
      s.cleanup()
    }
  })

  test('the window\'s state: none, submitted from the submit, open while the window is open, none once it closes and the submit ends; submits and opens are counted, so two teardowns of one key pair up; other keys stay none', () => {
    const state = () => [f.A.key, f.B.key].map((k) => h.notifier.teardownWindowState(k))
    expect(state()).toEqual(['none', 'none'])

    h.notifier.submitTeardown(f.A.key)
    h.notifier.submitTeardown(f.A.key)
    expect(state()).toEqual(['submitted', 'none'])
    h.notifier.openTeardownWindow(f.A)
    h.notifier.openTeardownWindow(f.A)
    expect(state()).toEqual(['open', 'none'])
    h.notifier.closeTeardownWindow(f.A.key)
    expect(state()).toEqual(['open', 'none'])
    h.notifier.closeTeardownWindow(f.A.key)
    expect(state()).toEqual(['submitted', 'none'])
    h.notifier.settleTeardown(f.A.key)
    expect(state()).toEqual(['submitted', 'none'])
    h.notifier.settleTeardown(f.A.key)
    expect(state()).toEqual(['none', 'none'])
    // A close or settle with none registered is a no-op.
    h.notifier.closeTeardownWindow(f.A.key)
    h.notifier.settleTeardown(f.A.key)
    expect(state()).toEqual(['none', 'none'])
    expect(h.logs).toEqual([])
  })

  // b.jg5 SRJ-1003: a notice built for Slack (here the CONFLICT notice, whose
  // session name and description are escaped for Slack) is written with the
  // escapes undone, in the entry and the line's first line, so it reads as the
  // unescaped notices' entries do; a persona name holding the same characters
  // is written as given.
  test('a CONFLICT notice built for Slack, its session name and description holding &, < and >, for a persona whose name holds them too: the entry and the line carry the characters, never &amp;, &lt; or &gt;; nothing posted', async () => {
    const odd: Persona = { ...f.A, name: 'Alpha <&> Notifier' }
    h.personas.splice(h.personas.indexOf(f.A), 1, odd)
    const text = conflictNoticeText({
      sessionName: 'slack_bot_<a&b>',
      latchCase: LATCH_CASE_LEFTOVER,
      description: `session <x> & <y> refused (${sentinelInMessage('conflict')})`,
    })
    expect(text).toContain(escapeSlackControlCharacters('<a&b>'))
    expect(text).toContain(escapeSlackControlCharacters('<x> & <y>'))

    await h.duringTeardown(odd, () => h.notifier.notify(odd.key, text))

    const unescaped = unescapeSlackControlCharacters(text)
    expect(h.startupEntries()).toEqual([teardownNoticeEntry(odd, unescaped)])
    expect(h.logs).toEqual([windowLine(odd, unescaped)])
    const [entry] = h.startupEntries()
    expect(entry!.text).toContain('<a&b>')
    expect(entry!.text).toContain('<x> & <y>')
    expect(entry!.text).toContain(`persona ${ref(odd)}`)
    for (const written of [entry!.text, h.logs[0]!]) {
      for (const escape of ['&amp;', '&lt;', '&gt;']) expect(written).not.toContain(escape)
    }
    expectNoSlackCallOrHold()
    assertNoLeak({ lines: h.logs, entries: h.startupEntries(), file: writtenFile(h.startupErrorsPath) })
  })

  // b.jg5 SRJ-1003, SRJ-1016: an outage that is a notice episode of its own
  // (ad-config-malformed) has its onset muted from the teardown's submit
  // until its window opens, and its all-clear is then written, never posted.
  test('the outage classes whose onset a submitted teardown mutes (pin)', () => {
    expect(PERSONA_NOTICE_SUBMIT_MUTED_OUTAGE_CLASSES).toEqual(['ad-config-malformed'])
  })

  /** The line of an onset muted between the teardown's submit and its window: the classes, the onset's first line unescaped. */
  const mutedOnsetLine = (p: Persona, classes: readonly string[], text: string) =>
    `[slack] persona-notifier: onset for ${ref(p)} of ${classes.join(', ')} not posted — muted, its persona teardown was submitted; its all-clear is written, never posted: ${unescapeSlackControlCharacters(text).split('\n')[0]}`

  test('ad-config-malformed\'s onset for an applied key between the teardown\'s submit and its window: no Slack call, no entry, one muted line (first line unescaped); its all-clear after the teardown is written, never posted; a tmux-unavailable onset raised in the same stretch posts as usual', async () => {
    h.validate(f.A.key)
    const onsetText = 'agent-director config &lt;tmux&gt; section &amp; more is malformed\n  detail'
    h.notifier.submitTeardown(f.A.key)

    await h.notifier.notify(f.A.key, onsetText, onset('ad-config-malformed'))
    await h.notifier.notify(f.A.key, 'onset: tmux', onset('tmux-unavailable'))

    expect(h.posts(f.A.key)).toEqual([{ channel: f.A.permission_prompts, text: formatPersonaNotice(f.A, 'onset: tmux') }])
    expect(h.startupEntries()).toEqual([])
    expect(h.logs).toEqual([mutedOnsetLine(f.A, ['ad-config-malformed'], onsetText)])
    expect(h.logs[0]).toContain('config <tmux> section & more is malformed')

    // The teardown's turn: its window opens and closes, then its submit ends.
    h.notifier.openTeardownWindow(f.A)
    h.notifier.closeTeardownWindow(f.A.key)
    h.notifier.settleTeardown(f.A.key)
    await h.notifier.notify(f.A.key, 'all clear: config', allClear('ad-config-malformed'))
    await h.notifier.notify(f.A.key, 'all clear: tmux', allClear('tmux-unavailable'))

    expect(h.startupEntries()).toEqual([teardownNoticeEntry(f.A, 'all clear: config', PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER)])
    expect(h.logs.slice(1)).toEqual([allClearLine(f.A, 'all clear: config')])
    expect(texts(f.A)).toEqual([formatPersonaNotice(f.A, 'onset: tmux'), formatPersonaNotice(f.A, 'all clear: tmux')])
  })

  // Controls: before any submit the onset posts; a key no longer applied has
  // it dropped with the drop's line, unmuted and unmarked, so its all-clear
  // is dropped the same way.
  test('controls: with no teardown submitted the ad-config-malformed onset posts; for a submitted key no longer applied it is dropped as before, with no muted line and no entry, and so is its all-clear', async () => {
    h.validate(f.A.key)
    await h.notifier.notify(f.A.key, 'onset: config', onset('ad-config-malformed'))
    expect(texts(f.A)).toEqual([formatPersonaNotice(f.A, 'onset: config')])

    h.validate(f.B.key)
    h.personas.splice(h.personas.indexOf(f.B), 1)
    h.notifier.submitTeardown(f.B.key)
    await h.notifier.notify(f.B.key, 'onset: config', onset('ad-config-malformed'))
    h.notifier.settleTeardown(f.B.key)
    await h.notifier.notify(f.B.key, 'all clear: config', allClear('ad-config-malformed'))

    const dropped = `[slack] persona-notifier: no applied persona with key=${f.B.key} — notice dropped`
    expect(h.logs).toEqual([dropped, dropped])
    expect(h.posts(f.B.key)).toEqual([])
    expect(h.startupEntries()).toEqual([])
  })

  // b.jg5 SRJ-1002, SRJ-1003: an all-clear listing a class whose onset the
  // window routed and one whose onset was posted is split by its
  // `allClearOf`: the marked classes' all-clear is written, the rest posted
  // to the destination naming only its own classes.
  test('an all-clear listing a window-routed class and a posted one, with allClearOf: the marked class\'s all-clear is written (the all-clear occasion), the other class\'s posted to the destination, each rendered for its own classes only', async () => {
    h.validate(f.A.key)
    const asked: string[][] = []
    const allClearOf = (classes: readonly string[]): string => {
      asked.push([...classes])
      return `All clear: ${classes.join(' + ')}`
    }
    await h.duringTeardown(f.A, () => h.notifier.notify(f.A.key, 'onset: unreachable', onset('ad-unreachable')))
    await h.notifier.notify(f.A.key, 'onset: tmux', onset('tmux-unavailable'))

    await h.notifier.notify(f.A.key, 'All clear: ad-unreachable + tmux-unavailable', {
      outage: { phase: PERSONA_NOTICE_OUTAGE_ALL_CLEAR, classes: ['ad-unreachable', 'tmux-unavailable'], allClearOf },
    })

    expect(asked).toEqual([['ad-unreachable'], ['tmux-unavailable']])
    expect(h.startupEntries()).toEqual([
      teardownNoticeEntry(f.A, 'onset: unreachable'),
      teardownNoticeEntry(f.A, 'All clear: ad-unreachable', PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER),
    ])
    expect(h.logs).toEqual([windowLine(f.A, 'onset: unreachable'), allClearLine(f.A, 'All clear: ad-unreachable')])
    expect(h.posts(f.A.key)).toEqual([
      { channel: f.A.permission_prompts, text: formatPersonaNotice(f.A, 'onset: tmux') },
      { channel: f.A.permission_prompts, text: formatPersonaNotice(f.A, 'All clear: tmux-unavailable') },
    ])
  })

  // Rows: the all-clear's renderer: none (the outage state's all-clear
  // before it carried one), one that throws, one that answers no string.
  // Without a usable renderer the whole all-clear is written, and nothing of
  // it is posted.
  test.each<[string, PersonaNoticeOptions['outage']]>([
    ['no allClearOf', { phase: PERSONA_NOTICE_OUTAGE_ALL_CLEAR, classes: ['ad-unreachable', 'tmux-unavailable'] }],
    ['an allClearOf that throws', { phase: PERSONA_NOTICE_OUTAGE_ALL_CLEAR, classes: ['ad-unreachable', 'tmux-unavailable'], allClearOf: () => { throw new Error('no render') } }],
    ['an allClearOf answering no string', { phase: PERSONA_NOTICE_OUTAGE_ALL_CLEAR, classes: ['ad-unreachable', 'tmux-unavailable'], allClearOf: () => undefined as unknown as string }],
  ])('an all-clear listing a window-routed class and a posted one, with %s: the whole all-clear is written, nothing of it posted', async (_label, outage) => {
    h.validate(f.A.key)
    await h.duringTeardown(f.A, () => h.notifier.notify(f.A.key, 'onset: unreachable', onset('ad-unreachable')))
    await h.notifier.notify(f.A.key, 'onset: tmux', onset('tmux-unavailable'))

    await h.notifier.notify(f.A.key, 'All clear: both', { outage })

    expect(h.startupEntries().slice(1)).toEqual([teardownNoticeEntry(f.A, 'All clear: both', PERSONA_TEARDOWN_NOTICE_ALL_CLEAR_AFTER)])
    expect(texts(f.A)).toEqual([formatPersonaNotice(f.A, 'onset: tmux')])
  })

  test('a notice quoting a redacted error carries no token into the log line or the entry (assertNoLeak over both and the written file)', async () => {
    const text = `agent-director kill refused: ${describeThrownValue(new Error(`refused ${sentinelInMessage('teardown-notice')}`))}`

    await h.duringTeardown(f.A, () => h.notifier.notify(f.A.key, text))

    expect(h.startupEntries()).toEqual([teardownNoticeEntry(f.A, text)])
    expect(h.startupEntries()[0]!.text).toContain('<redacted-token>')
    assertNoLeak({ lines: h.logs, entries: h.startupEntries(), file: writtenFile(h.startupErrorsPath) })
  })
})
