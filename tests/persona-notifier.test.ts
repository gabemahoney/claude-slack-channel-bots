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
 * is dropped with one log line and never posted), and a failed open or post
 * is logged and the whole failure (step, code, thrown value) handed to the
 * caller's failure callback without ever rejecting. An injected resolver is
 * the one the notifier uses (its cached DM is reused).
 *
 * Pure module under test: built from injected fakes only, through the shared
 * `makeNotifierHarness` (`makeStubSlack` Web stubs, a validated-key set, a
 * dry-run flag and a line capture). No token is used; every stub carries
 * `LEAK_SENTINEL` and `afterEach` runs `assertNoLeak` over every captured log
 * line and post.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { WebClient } from '@slack/web-api'

import type { Persona } from '../src/config.ts'
import { MAX_HELD_NOTICES_PER_PERSONA, createPersonaNotifier, formatPersonaNotice } from '../src/persona-notifier.ts'
import { createPersonaDestinations, type DestinationFailure } from '../src/persona-destination.ts'
import { personaKey, renderPersonaRef } from '../src/persona-identity.ts'
import { makeMultiPersonaConfig, makeStandInPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness, type NotifierHarness } from './test-helpers/persona-notifier.ts'
import { stubOpenedDmId, type WebApiOutcome } from './test-helpers/slack-stub.ts'
import { LEAK_SENTINEL, assertNoLeak } from './test-helpers/credentials.ts'

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
  return { h: makeNotifierHarness(config, { validated: false, leakMarker: LEAK_SENTINEL }), A, B, D }
}

/** Validate the persona's client and flush its held notices. */
async function validateAndFlush(p: Persona): Promise<void> {
  h.validate(p.key)
  await h.notifier.flush(p.key)
}

const ref = (p: Persona) => renderPersonaRef(p.name, p.key)
const texts = (p: Persona) => h.posts(p.key).map((c) => c.text)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'persona-notifier-'))
  f = makeFixture(dir)
  h = f.h
})

afterEach(() => {
  assertNoLeak({ lines: h.logs, posts: h.allPosts() })
  rmSync(dir, { recursive: true, force: true })
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

  test('the failed-post log line names the persona with its stored key', async () => {
    const { s, p } = standIn({ post: [{ kind: 'network' }] })

    await s.notifier.notify(p.key, 'body')

    expect(s.logs).toHaveLength(1)
    expect(s.logs[0]).toStartWith(
      `[slack] persona-notifier: failed to post notice for ${renderPersonaRef(p.name, p.key)} to ${STAND_IN}: `,
    )
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

  test.each<[string, WebApiOutcome, string, string, boolean]>([
    ['missing_scope', { kind: 'platform', error: 'missing_scope' }, ' (reason=missing_scope): ', 'missing_scope', true],
    ['no conversation ID', { kind: 'ok', result: { channel: undefined } }, ' (reason=no_conversation_id)', 'no_conversation_id', false],
  ])(
    'a failed DM open (%s) posts nothing, logs one line naming the persona and conversations.open, and calls the callback once with the open step and code; the next notice opens again',
    async (_label, outcome, tail, code, withError) => {
      h.validate(f.D.key)
      h.stub(f.D.key).script.open.push(outcome)
      const failures: DestinationFailure[] = []

      await expect(h.notifier.notify(f.D.key, 'x', { onPostFailure: (err) => failures.push(err) })).resolves.toBeUndefined()

      expect(h.posts(f.D.key)).toEqual([])
      expect(h.logs).toHaveLength(1)
      expect(h.logs[0]).toStartWith(
        `[slack] persona-notifier: failed to post notice for ${ref(f.D)}: could not open its DM destination (conversations.open)${tail}`,
      )
      expect(h.logs[0]).not.toContain('An API error occurred')
      // The whole failure: the open step and its code, no channel (nothing was posted).
      expect(failures).toHaveLength(1)
      const [failure] = failures
      expect(failure!.outcome).toBe('failed')
      expect(failure!.step).toBe('conversations.open')
      expect(failure!.code).toBe(code)
      expect(failure!.channelId).toBeUndefined()
      if (withError) expect(failure!.error).toBeInstanceOf(Error)
      // No thrown value at all (the cause describer keys on its absence).
      else expect('error' in failure!).toBe(false)

      await h.notifier.notify(f.D.key, 'y')
      expect(methods(f.D)).toEqual(['conversations.open', 'conversations.open', 'chat.postMessage'])
    },
  )

  test('an injected destination resolver is the one used: a DM it already opened is reused, with no second conversations.open', async () => {
    // A resolver shared with another caller (the permission poller, in the
    // server), which has already opened D's DM through its own post.
    const web = h.stub(f.D.key).web as unknown as WebClient
    const destinations = createPersonaDestinations({ log: (line) => h.logs.push(line) })
    expect(await destinations.post(f.D, web, { text: 'prompt' })).toMatchObject({ outcome: 'posted', channelId: dmId() })
    expect(methods(f.D)).toEqual(['conversations.open', 'chat.postMessage'])
    const notifier = createPersonaNotifier({
      getPersona: (key) => h.personas.find((p) => p.key === key),
      clientFor: (key) => h.stub(key).web as unknown as WebClient,
      destinations,
      isDryRun: () => false,
      log: (line) => h.logs.push(line),
    })

    await notifier.notify(f.D.key, 'notice')

    expect(methods(f.D)).toEqual(['conversations.open', 'chat.postMessage', 'chat.postMessage'])
    expect(h.posts(f.D.key).at(-1)).toEqual({ channel: dmId(), text: formatPersonaNotice(f.D, 'notice') })
    expect(h.logs).toEqual([])
  })

  test('a failed post to the opened DM logs the D… ID with its reason and calls the callback once', async () => {
    h.validate(f.D.key)
    h.stub(f.D.key).script.post.push({ kind: 'platform', error: 'not_in_channel' })
    const failures: unknown[] = []

    await h.notifier.notify(f.D.key, 'x', { onPostFailure: (err) => failures.push(err) })

    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toStartWith(`[slack] persona-notifier: failed to post notice for ${ref(f.D)} to ${dmId()} (reason=not_in_channel): `)
    expect(failures).toHaveLength(1)
  })

  test('a dm destination the resolver refuses (DMs off) makes no Slack call and does not call the failure callback', async () => {
    h.personas.splice(h.personas.indexOf(f.D), 1, { ...f.D, dm: { enabled: false, contact: 'U0DELTA01' } })
    h.validate(f.D.key)
    const failures: unknown[] = []

    await h.notifier.notify(f.D.key, 'x', { onPostFailure: (err) => failures.push(err) })

    expect(methods(f.D)).toEqual([])
    expect(failures).toEqual([])
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain(ref(f.D))
    expect(h.logs[0]).toContain('dm.enabled is not true')
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
// Failed posts and the failure callback
// ---------------------------------------------------------------------------

// [label, scripted post outcome, the failure's code]
const FAILURES: [string, WebApiOutcome, string][] = [
  ['network', { kind: 'network' }, 'network_error'],
  ['platform', { kind: 'platform', error: 'channel_not_found' }, 'channel_not_found'],
  ['reject(undefined)', { kind: 'reject', value: undefined }, 'unknown_error'],
]

describe('failed posts (SR-11 spawn-failure-post class)', () => {
  test.each(FAILURES)(
    'a rejected immediate post (%s) is logged naming the persona and calls the callback once; other personas still post',
    async (_label, outcome, code) => {
      h.validate(f.A.key)
      h.validate(f.B.key)
      h.stub(f.A.key).script.post.push(outcome)
      const failures: DestinationFailure[] = []

      await expect(
        h.notifier.notify(f.A.key, 'Spawn failure', { onPostFailure: (failure) => failures.push(failure) }),
      ).resolves.toBeUndefined()
      await h.notifier.notify(f.B.key, 'still here')

      expect(failures).toHaveLength(1)
      const [failure] = failures
      expect(failure!.step).toBe('chat.postMessage')
      expect(failure!.code).toBe(code)
      expect(failure!.channelId).toBe(f.A.permission_prompts)
      // The rejection itself is handed over, even when it is `undefined`.
      expect('error' in failure!).toBe(true)
      if (outcome.kind === 'reject') expect(failure!.error).toBeUndefined()
      else expect(failure!.error).toBeInstanceOf(Error)
      expect(h.logs).toHaveLength(1)
      expect(h.logs[0]).toContain(ref(f.A))
      expect(h.posts(f.B.key)).toHaveLength(1)
    },
  )

  test('a held notice with a callback whose flushed post is rejected calls that callback once', async () => {
    const failures: unknown[] = []
    const successes: unknown[] = []
    await h.notifier.notify(f.A.key, 'fails', { onPostFailure: (err) => failures.push(err) })
    await h.notifier.notify(f.A.key, 'succeeds', { onPostFailure: (err) => successes.push(err) })
    h.stub(f.A.key).script.post.push({ kind: 'network' })

    await expect(validateAndFlush(f.A)).resolves.toBeUndefined()

    expect(failures).toHaveLength(1)
    expect(successes).toHaveLength(0)
    expect(h.posts(f.A.key)).toHaveLength(2)
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain(ref(f.A))
  })

  test('a rejected post raised without a callback only logs', async () => {
    h.validate(f.A.key)
    h.stub(f.A.key).script.post.push({ kind: 'network' })

    await expect(h.notifier.notify(f.A.key, 'no callback')).resolves.toBeUndefined()

    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain(ref(f.A))
  })

  test('a failure callback that throws is logged and does not reject', async () => {
    h.validate(f.A.key)
    h.stub(f.A.key).script.post.push({ kind: 'network' })

    await expect(
      h.notifier.notify(f.A.key, 'x', {
        onPostFailure: () => {
          throw new Error('callback broke')
        },
      }),
    ).resolves.toBeUndefined()

    expect(h.logs).toHaveLength(2)
    expect(h.logs.every((l) => l.includes(ref(f.A)))).toBe(true)
  })

  test('a postMessage that throws synchronously is logged once, calls the callback once, and notify resolves', async () => {
    h.validate(f.A.key)
    const web = h.stub(f.A.key).web
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

    expect(calls).toBe(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.step).toBe('chat.postMessage')
    expect(failures[0]!.channelId).toBe(f.A.permission_prompts)
    expect(failures[0]!.error).toBe(thrown)
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toStartWith(
      `[slack] persona-notifier: failed to post notice for ${ref(f.A)} to ${f.A.permission_prompts}: Error code=slack_webapi_request_error`,
    )
  })
})

// ---------------------------------------------------------------------------
// Failed-post log line: Slack platform reason, never free text
// ---------------------------------------------------------------------------

describe('failed-post log line (SR-10.3 token-safe)', () => {
  /** Script one rejected post for A, raise a notice and return the single log line. */
  async function failedLine(outcome: WebApiOutcome): Promise<string> {
    h.validate(f.A.key)
    h.stub(f.A.key).script.post.push(outcome)
    await h.notifier.notify(f.A.key, 'x')
    expect(h.logs).toHaveLength(1)
    return h.logs[0]!
  }

  test('a platform error carries its short Slack reason beside the destination', async () => {
    const line = await failedLine({ kind: 'platform', error: 'not_in_channel' })

    expect(line).toStartWith(
      `[slack] persona-notifier: failed to post notice for ${ref(f.A)} to ${f.A.permission_prompts} (reason=not_in_channel): `,
    )
    expect(line).toContain('code=slack_webapi_platform_error')
    // Never the error message.
    expect(line).not.toContain('An API error occurred')
  })

  test.each<[string, WebApiOutcome]>([
    ['a request error (no platform reason)', { kind: 'network' }],
    ['a platform error with no data.error', { kind: 'platform' }],
    ['an HTTP error', { kind: 'http', status: 503 }],
  ])('%s logs no reason', async (_label, outcome) => {
    const line = await failedLine(outcome)

    expect(line).toStartWith(`[slack] persona-notifier: failed to post notice for ${ref(f.A)} to ${f.A.permission_prompts}: `)
    expect(line).not.toContain('reason=')
    expect(line).not.toContain('error occurred')
  })

  test.each<[string, string]>([
    ['spaces', 'channel is not here'],
    ['a hyphen and the sentinel', `bad-reason-${LEAK_SENTINEL}`],
    ['a newline', 'not_in_channel\nsecond line'],
    ['more than 64 characters', `a${'b'.repeat(64)}`],
  ])('a platform reason with %s is never logged', async (_label, reason) => {
    const line = await failedLine({ kind: 'platform', error: reason })

    expect(line).not.toContain('reason=')
    expect(line).not.toContain(reason)
    expect(line).toContain('code=slack_webapi_platform_error')
  })
})
