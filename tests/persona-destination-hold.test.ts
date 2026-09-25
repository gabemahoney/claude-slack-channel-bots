/**
 * persona-destination-hold.test.ts — Hold and retry a persona's prompts and
 * notices while its destination fails (b.av2 SR-7.1 failure part, SR-3.2,
 * SR-3.3, SR-10.3).
 *
 * The hold's policy is proven here once, so the poller and notifier suites
 * need only one representative case each:
 * - a destination failure (every open failure, every post failure but a
 *   payload error) opens one episode with one `persona-destination-failed`
 *   line naming the persona, the step, the code and, for `missing_scope` on
 *   the open, `im:write`;
 * - retries follow the persona's own SR-3.2 schedule (5 s doubling to 300 s,
 *   no give-up, never shorter than `retryAfter`), log nothing and move only
 *   the due time;
 * - the first success logs one cleared line, resets the schedule and delivers
 *   the held notices in submission order;
 * - an attempt that started before the episode opened neither logs again nor
 *   moves the due time, and its notice is re-queued in order;
 * - the gate (`begin`) refuses before the due time and while a retry is in
 *   flight; a gated success posts the held notices at once;
 * - with the persona's `permission_prompts` changed in place during an open
 *   episode, a failure at a destination the episode has not named logs one
 *   more opening line naming it (never again for that destination, stale
 *   failures silent, the backoff unreset), and the cleared line names the
 *   destination the successful post went to;
 * - a failure from an attempt that started before the last episode change
 *   (opened or closed) logs nothing and schedules nothing; its notice is
 *   re-queued and, with no episode open, posted at once;
 * - a gated attempt always ends: `post` ends it even when the resolver
 *   throws, and `release` moves held notices on;
 * - held notices are capped per persona; a persona not up, or whose lookups
 *   throw, waits the current backoff step (one line per run of throws); one no
 *   longer applied is dropped with one line; `cancel`/`cancelAll` log one line
 *   per persona that had notices held, and an in-flight attempt then changes
 *   nothing;
 * - payload errors and refusals open no episode; no token reaches a line.
 *
 * Built over the real destination resolver, one `makeStubSlack` stub per
 * persona (leak marker on) and a fake clock. `afterEach` cancels every
 * persona, asserts no fake-clock timer is left and runs `assertNoLeak` over
 * every line and recorded failure.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Persona } from '../src/config.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import { createPersonaDestinations, type DestinationSlackClient, type PersonaDestinations } from '../src/persona-destination.ts'
import {
  MAX_HELD_NOTICES_PER_PERSONA,
  createPersonaDestinationHold,
  type HoldNotice,
  type PersonaDestinationHold,
} from '../src/persona-destination-hold.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import {
  asWebClient,
  makeDeferredWebApiCall,
  makeStubSlack,
  stubOpenedDmId,
  type SettledWebApiOutcome,
  type StubSlack,
  type WebApiOutcome,
} from './test-helpers/slack-stub.ts'
import {
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
} from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string
/** `dm` destination, DMs on. */
let D: Persona
/** Channel destination. */
let C: Persona
/** A second `dm` destination with its own contact. */
let E: Persona
/** A `dm` destination with DMs off (the loader rejects it): refused with no Slack call. */
let R: Persona
let stubs: Map<string, StubSlack>
/** `clientFor`: a missing key is a persona that is not up. */
let clients: Map<string, DestinationSlackClient>
/** `getPersona`: a missing key is a persona no longer applied. */
let applied: Map<string, Persona>
let logs: string[]
/** Each notice failure callback call, less the raw thrown value. */
let failures: { notice: string; step: string; code: string; first: boolean; held: boolean }[]
let clock: FakeClock
let hold: PersonaDestinationHold
/** Which lookup throws `lookupError` when the hold calls it; none when undefined. */
let lookupThrows: 'getPersona' | 'clientFor' | undefined
let lookupError: Error
/** How many of the next resolver posts throw instead of settling (breaking its never-rejects contract). */
let resolverThrows: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'persona-destination-hold-'))
  const config = makeMultiPersonaConfig(
    [
      { name: 'Dee Direct', channels: [], dm: { enabled: true, contact: 'U0DEE0001' }, permission_prompts: 'dm' },
      { name: 'Cee Channel', channels: [{ id: 'C0CEE0001', delivery: 'all' }], permission_prompts: 'C0CEE0001' },
      { name: 'Eff Direct', channels: [], dm: { enabled: true, contact: 'U0EFF0001' }, permission_prompts: 'dm' },
      { name: 'Arr Refused', channels: [], dm: { enabled: false }, permission_prompts: 'dm' },
    ],
    dir,
  )
  ;[D, C, E, R] = config.personas as [Persona, Persona, Persona, Persona]
  stubs = new Map(config.personas.map((p) => [p.key, makeStubSlack({ leakMarker: LEAK_SENTINEL })]))
  clients = new Map(config.personas.map((p) => [p.key, asWebClient(stubs.get(p.key)!.web)]))
  applied = new Map(config.personas.map((p) => [p.key, p]))
  logs = []
  failures = []
  clock = createFakeClock()
  lookupThrows = undefined
  // The message carries the leak marker inside a fake token and a WebSocket
  // ticket URL: its line logs the message redacted, so no line may copy it.
  lookupError = new Error(`lookup failed (${sentinelInMessage('lookup')})`)
  resolverThrows = 0
  const log = (line: string): void => {
    logs.push(line)
  }
  const real = createPersonaDestinations({ log })
  const destinations: PersonaDestinations = {
    post: (persona, c, message) => {
      if (resolverThrows > 0) {
        resolverThrows -= 1
        return Promise.reject(new Error('resolver threw'))
      }
      return real.post(persona, c, message)
    },
    forget: (key) => real.forget(key),
  }
  hold = createPersonaDestinationHold({
    destinations,
    getPersona: (key) => {
      if (lookupThrows === 'getPersona') throw lookupError
      return applied.get(key)
    },
    clientFor: (key) => {
      if (lookupThrows === 'clientFor') throw lookupError
      return clients.get(key)
    },
    clock,
    log,
  })
})

afterEach(() => {
  hold.cancelAll()
  expect(clock.pendingCount()).toBe(0)
  assertNoLeak({ lines: logs, failures })
  rmSync(dir, { recursive: true, force: true })
})

const stub = (p: Persona): StubSlack => stubs.get(p.key)!
const client = (p: Persona): DestinationSlackClient => clients.get(p.key)!
/** `chat.postMessage` calls on `p`'s stub (failed ones included), as `{channel, text}`. */
const posts = (p: Persona) => stub(p).calls.postMessage as { channel: string; text: string }[]
const postedTexts = (p: Persona): string[] => posts(p).map((c) => c.text)

/** A notice whose failure callback records into `failures`. */
function notice(text: string): HoldNotice {
  return {
    message: { text },
    summary: text,
    onAttemptFailed: (failure, info) => {
      failures.push({ notice: text, step: failure.step, code: failure.code, ...info })
    },
  }
}

const deliver = (p: Persona, text: string): Promise<void> => hold.deliver(p, client(p), notice(text))

/** Every `persona-destination-failed` line that opens an episode. */
const startLines = (): string[] => logs.filter((l) => l.includes('persona-destination-failed:') && !l.includes(': cleared:'))
const clearedLines = (): string[] => logs.filter((l) => l.includes('persona-destination-failed:') && l.includes(': cleared:'))
/** The `personas[i] "<name>" (key=…)` part every diagnostic line for `p` carries. */
const refOf = (p: Persona): string => `personas[${p.index}] ${renderPersonaRef(p.name, p.key)}`

/** Make every attempt of `step` on `p` fail with `error` until `unstick` empties the queue. */
function stick(p: Persona, queue: 'open' | 'post', error: string): void {
  stub(p).script[queue].push(...Array<WebApiOutcome>(1000).fill({ kind: 'platform', error }))
}
function unstick(p: Persona, queue: 'open' | 'post'): void {
  stub(p).script[queue].length = 0
}

/** The requested delay of the one pending timer. */
function onlyTimerDelay(): number {
  expect(clock.pendingCount()).toBe(1)
  return clock.pending()[0]!.delayMs
}

// ---------------------------------------------------------------------------
// One episode per cause
// ---------------------------------------------------------------------------

describe('an episode: held, retried on backoff, one start line, one cleared line', () => {
  interface EpisodeRow {
    persona: () => Persona
    queue: 'open' | 'post'
    method: 'conversations.open' | 'chat.postMessage'
    error: string
    destination: string
    imWrite: boolean
    postedTo: () => string
  }
  test.each<[string, EpisodeRow]>([
    [
      'AC 44: missing_scope from conversations.open on a dm destination is held, retried on backoff, logged once naming im:write, and delivered once to the opened DM after the cause clears',
      {
        persona: () => D,
        queue: 'open',
        method: 'conversations.open',
        error: 'missing_scope',
        destination: 'dm',
        imWrite: true,
        postedTo: () => stubOpenedDmId('U0DEE0001'),
      },
    ],
    [
      'not_in_channel from chat.postMessage on a channel destination is held, retried, logged once without im:write, and posted once after the cause clears',
      {
        persona: () => C,
        queue: 'post',
        method: 'chat.postMessage',
        error: 'not_in_channel',
        destination: 'C0CEE0001',
        imWrite: false,
        postedTo: () => 'C0CEE0001',
      },
    ],
    [
      'missing_scope from chat.postMessage (the post step, after the DM opened) is held and logged once without naming im:write, which only the open needs',
      {
        persona: () => D,
        queue: 'post',
        method: 'chat.postMessage',
        error: 'missing_scope',
        destination: 'dm',
        imWrite: false,
        postedTo: () => stubOpenedDmId('U0DEE0001'),
      },
    ],
  ])('%s', async (_title, row) => {
    const p = row.persona()
    const attempts = (): number => stub(p).callLog.filter((c) => c.method === row.method).length
    stick(p, row.queue, row.error)

    await deliver(p, 'the notice')

    expect(hold.view(p.key)).toEqual({ held: true, heldNotices: 1, nextDueAt: 5000 })
    expect(attempts()).toBe(1)
    expect(startLines()).toHaveLength(1)
    const line = startLines()[0]!
    expect(line).toContain(`persona-destination-failed: ${refOf(p)}: ${row.method} failed for destination=${row.destination} with error ${row.error}`)
    expect(line.includes('im:write')).toBe(row.imWrite)

    await clock.advance(4999)
    expect(attempts()).toBe(1)
    await clock.advance(1)
    expect(attempts()).toBe(2)
    expect(onlyTimerDelay()).toBe(10_000)
    await clock.advance(10_000)
    expect(attempts()).toBe(3)
    expect(startLines()).toHaveLength(1)
    expect(failures).toEqual([
      { notice: 'the notice', step: row.method, code: row.error, first: true, held: true },
      { notice: 'the notice', step: row.method, code: row.error, first: false, held: true },
      { notice: 'the notice', step: row.method, code: row.error, first: false, held: true },
    ])

    unstick(p, row.queue)
    const failedPosts = posts(p).length
    await clock.runNext()

    expect(posts(p).slice(failedPosts)).toEqual([{ channel: row.postedTo(), text: 'the notice' }])
    expect(clearedLines()).toHaveLength(1)
    expect(clearedLines()[0]).toContain(`persona-destination-failed: ${refOf(p)}: cleared: destination=${row.destination}`)
    expect(startLines()).toHaveLength(1)
    expect(hold.view(p.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(clock.pendingCount()).toBe(0)

    // Delivered once: nothing more, however long the clock runs.
    await clock.advance(3_600_000)
    expect(posts(p).length).toBe(failedPosts + 1)
    for (const other of [D, C, E, R].filter((o) => o !== p)) expect(stub(other).callLog).toEqual([])
  })

  test('retry gaps double from 5 s and stop growing at 300 s; the hold never gives up and failed retries log nothing', async () => {
    stick(D, 'open', 'missing_scope')
    await deliver(D, 'n1')

    const gaps: number[] = []
    for (let i = 0; i < 10; i++) {
      gaps.push(onlyTimerDelay())
      const before = stub(D).calls.conversationsOpen.length
      await clock.runNext()
      expect(stub(D).calls.conversationsOpen.length).toBe(before + 1)
    }
    expect(gaps).toEqual([5000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000])
    expect(onlyTimerDelay()).toBe(300_000)
    expect(hold.view(D.key).heldNotices).toBe(1)
    expect(startLines()).toHaveLength(1)
    expect(logs).toHaveLength(1)
  })

  test.each<[string, WebApiOutcome, number]>([
    ['a rate-limited error with retryAfter 60 s waits 60 s', { kind: 'rate-limited', retryAfter: 60 }, 60_000],
    ['a ratelimited platform error with retryAfter 30 s waits 30 s', { kind: 'platform', error: 'ratelimited', retryAfter: 30 }, 30_000],
    ['a retryAfter of 2 s below the 5 s step waits the 5 s step', { kind: 'rate-limited', retryAfter: 2 }, 5_000],
  ])('retryAfter: %s', async (_title, outcome, waitMs) => {
    stub(C).script.post.push(outcome)
    await deliver(C, 'n1')

    expect(onlyTimerDelay()).toBe(waitMs)
    await clock.advance(waitMs - 1)
    expect(posts(C)).toHaveLength(1)
    await clock.advance(1)
    expect(postedTexts(C)).toEqual(['n1', 'n1'])
    expect(clearedLines()).toHaveLength(1)
  })

  test('several notices in one episode: one start line, each posted once in submission order after the cause clears', async () => {
    stick(D, 'open', 'missing_scope')

    // Issued together: all three wait on the one DM open and fail together.
    await Promise.all([deliver(D, 'n1'), deliver(D, 'n2'), deliver(D, 'n3')])
    await deliver(D, 'n4')

    expect(stub(D).calls.conversationsOpen).toHaveLength(1)
    expect(startLines()).toHaveLength(1)
    expect(hold.view(D.key)).toEqual({ held: true, heldNotices: 4, nextDueAt: 5000 })
    expect(onlyTimerDelay()).toBe(5000)

    unstick(D, 'open')
    await clock.runNext()

    expect(postedTexts(D)).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(posts(D).every((c) => c.channel === stubOpenedDmId('U0DEE0001'))).toBe(true)
    expect(stub(D).calls.conversationsOpen).toHaveLength(2)
    expect(startLines()).toHaveLength(1)
    expect(clearedLines()).toHaveLength(1)
  })

  test('a failure after a cleared episode opens a new episode with a new start line, its backoff restarting at 5 s', async () => {
    stick(C, 'post', 'not_in_channel')
    await deliver(C, 'n1')
    await clock.runNext()
    await clock.runNext()
    expect(onlyTimerDelay()).toBe(20_000)
    unstick(C, 'post')
    await clock.runNext()
    expect(clearedLines()).toHaveLength(1)

    stick(C, 'post', 'channel_not_found')
    await deliver(C, 'n2')

    expect(startLines()).toHaveLength(2)
    expect(startLines()[1]).toContain('chat.postMessage failed for destination=C0CEE0001 with error channel_not_found')
    expect(onlyTimerDelay()).toBe(5000)
    expect(hold.view(C.key)).toEqual({ held: true, heldNotices: 1, nextDueAt: clock.now() + 5000 })
  })

  test('once notices are held, a later one joins the queue behind them with no attempt of its own', async () => {
    stick(C, 'post', 'not_in_channel')
    await deliver(C, 'n1')
    await deliver(C, 'n2')

    expect(posts(C)).toHaveLength(1)
    expect(hold.view(C.key).heldNotices).toBe(2)
    expect(failures.map((f) => f.notice)).toEqual(['n1'])
  })
})

// ---------------------------------------------------------------------------
// The destination changed in place while an episode is open
// ---------------------------------------------------------------------------

describe('C\'s permission_prompts changed in place while its episode is open', () => {
  const C1 = 'C0CEE0001'
  const C2 = 'C0CEE0002'
  /** Replace C's applied entry with one sending prompts to `destination` (both channels listed); returns it. */
  function moveC(destination: string): Persona {
    const moved: Persona = {
      ...C,
      channels: [{ id: C1, delivery: 'all' }, { id: C2, delivery: 'all' }],
      permission_prompts: destination,
    }
    applied.set(C.key, moved)
    return moved
  }
  /** The opening lines are exactly one per `[destination, code]`, in order, each naming C, its destination and error. */
  function expectOpeningLines(...expected: Array<[string, string]>): void {
    const lines = startLines()
    expect(lines).toHaveLength(expected.length)
    expected.forEach(([destination, code], i) => {
      expect(lines[i]).toContain(refOf(C))
      expect(lines[i]).toContain(`destination=${destination} with error ${code}`)
    })
  }
  /** Exactly one cleared line, naming C, the destination posted to and the episode's latest cause. */
  function expectClearedLine(destination: string, code: string): void {
    const lines = clearedLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(refOf(C))
    expect(lines[0]).toContain(`cleared: destination=${destination} `)
    expect(lines[0]).toContain(`error ${code}`)
  }
  const postedChannels = (): string[] => posts(C).map((c) => c.channel)

  test('a failure at C1, then the first success at C2: the cleared line names C2, where the post went, and no line names C2 as failing', async () => {
    stick(C, 'post', 'not_in_channel')
    await deliver(C, 'n1')
    moveC(C2)
    unstick(C, 'post')
    await clock.runNext()

    expect(postedChannels()).toEqual([C1, C2])
    expectOpeningLines([C1, 'not_in_channel'])
    expectClearedLine(C2, 'not_in_channel')
    expect(hold.view(C.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
  })

  test('a failure at C2 logs exactly one more opening line naming it; a repeat at C2, and a failure back at C1, log nothing; the backoff runs on unreset; the cleared line names C1 with the latest named cause', async () => {
    stick(C, 'post', 'not_in_channel')
    await deliver(C, 'n1')
    moveC(C2)
    unstick(C, 'post')
    stick(C, 'post', 'channel_not_found')

    await clock.runNext()
    expectOpeningLines([C1, 'not_in_channel'], [C2, 'channel_not_found'])
    expect(onlyTimerDelay()).toBe(10_000)

    await clock.runNext()
    expect(startLines()).toHaveLength(2)
    expect(onlyTimerDelay()).toBe(20_000)

    // Back to C1, already named in this episode.
    moveC(C1)
    await clock.runNext()
    expect(startLines()).toHaveLength(2)
    expect(onlyTimerDelay()).toBe(40_000)
    expect(postedChannels()).toEqual([C1, C2, C2, C1])

    unstick(C, 'post')
    await clock.runNext()
    expect(postedChannels()).toEqual([C1, C2, C2, C1, C1])
    expectClearedLine(C1, 'channel_not_found')
    expect(logs).toHaveLength(3)
    expect(hold.view(C.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
  })

  test('a stale failure at C2 (its attempt started before the episode opened at C1) logs nothing and moves nothing', async () => {
    const slow = makeDeferredWebApiCall()
    stub(C).script.post.push(slow.outcome, { kind: 'platform', error: 'not_in_channel' })
    const pA = hold.deliver(moveC(C2), client(C), notice('nA'))
    applied.set(C.key, C)
    await deliver(C, 'nB')
    expectOpeningLines([C1, 'not_in_channel'])
    expect(hold.view(C.key)).toEqual({ held: true, heldNotices: 1, nextDueAt: 5000 })

    slow.settle({ kind: 'platform', error: 'channel_not_found' })
    await pA

    expect(postedChannels()).toEqual([C2, C1])
    expectOpeningLines([C1, 'not_in_channel'])
    expect(hold.view(C.key)).toEqual({ held: true, heldNotices: 2, nextDueAt: 5000 })
    expect(onlyTimerDelay()).toBe(5000)

    await clock.runNext()
    expect(postedTexts(C).slice(2)).toEqual(['nA', 'nB'])
    expect(postedChannels().slice(2)).toEqual([C1, C1])
    expectClearedLine(C1, 'not_in_channel')
    expect(logs).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Attempts from before the episode (the stale-epoch rule)
// ---------------------------------------------------------------------------

describe('an attempt that started before the episode opened', () => {
  /** Two notices posted at once on C, each held open until the test settles it; the second fails first. */
  async function twoInFlightSecondFailsFirst() {
    const first = makeDeferredWebApiCall()
    const second = makeDeferredWebApiCall()
    stub(C).script.post.push(first.outcome, second.outcome)
    const p1 = deliver(C, 'n1')
    const p2 = deliver(C, 'n2')
    expect(postedTexts(C)).toEqual(['n1', 'n2'])

    second.settle({ kind: 'platform', error: 'not_in_channel' })
    await p2
    expect(startLines()).toHaveLength(1)
    expect(clock.pending()[0]!.dueAt).toBe(5000)
    await clock.advance(1000)
    return { first, p1 }
  }

  test('failing, it logs no second line, does not move the due time, and its notice is re-queued in submission order', async () => {
    const { first, p1 } = await twoInFlightSecondFailsFirst()

    first.settle({ kind: 'platform', error: 'not_in_channel' })
    await p1

    expect(startLines()).toHaveLength(1)
    expect(clock.pendingCount()).toBe(1)
    expect(clock.pending()[0]!.dueAt).toBe(5000)
    expect(hold.view(C.key)).toEqual({ held: true, heldNotices: 2, nextDueAt: 5000 })

    await clock.runNext()
    expect(postedTexts(C).slice(2)).toEqual(['n1', 'n2'])
    expect(clearedLines()).toHaveLength(1)
  })

  test('succeeding, it changes nothing: the episode stays open with no cleared line and the held notice waits for its retry', async () => {
    const { first, p1 } = await twoInFlightSecondFailsFirst()

    first.settle()
    await p1

    expect(clearedLines()).toHaveLength(0)
    expect(hold.view(C.key)).toEqual({ held: true, heldNotices: 1, nextDueAt: 5000 })
    expect(posts(C)).toHaveLength(2)

    await clock.runNext()
    expect(postedTexts(C).slice(2)).toEqual(['n2'])
    expect(clearedLines()).toHaveLength(1)
  })
})

describe('an attempt that started before the episode closed', () => {
  test('failing after a retry cleared the episode, it opens no second episode: no line, no wait, its notice posts at once and nothing stays held', async () => {
    const slow = makeDeferredWebApiCall()
    stub(C).script.post.push(slow.outcome, { kind: 'platform', error: 'not_in_channel' })
    const pA = deliver(C, 'nA')
    await deliver(C, 'nB')
    expect(startLines()).toHaveLength(1)
    expect(hold.view(C.key)).toEqual({ held: true, heldNotices: 1, nextDueAt: 5000 })

    // The retry posts nB and ends the episode while nA is still in flight.
    await clock.runNext()
    expect(clearedLines()).toHaveLength(1)
    expect(postedTexts(C)).toEqual(['nA', 'nB', 'nB'])

    slow.settle({ kind: 'platform', error: 'not_in_channel' })
    await pA
    await clock.flush()

    expect(clock.now()).toBe(5000)
    expect(startLines()).toHaveLength(1)
    expect(clearedLines()).toHaveLength(1)
    expect(logs).toHaveLength(2)
    expect(postedTexts(C)).toEqual(['nA', 'nB', 'nB', 'nA'])
    expect(hold.view(C.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The gate used by re-derived items (the poller)
// ---------------------------------------------------------------------------

describe('the gate (begin)', () => {
  const prompt = (text: string) => ({ text })

  test('after a failure it refuses until the due time and while a retry is in flight; a gated success posts the held notices at once, in order', async () => {
    const retry = makeDeferredWebApiCall()
    stub(C).script.post.push({ kind: 'platform', error: 'not_in_channel' }, retry.outcome)

    const first = hold.begin(C.key)!
    expect(await first.post(C, client(C), prompt('prompt 1'))).toMatchObject({ outcome: 'failed', code: 'not_in_channel' })
    expect(startLines()).toHaveLength(1)
    expect(hold.view(C.key)).toEqual({ held: true, heldNotices: 0, nextDueAt: 5000 })
    // A hold used only by the gate makes no timer.
    expect(clock.pendingCount()).toBe(0)

    expect(hold.begin(C.key)).toBeUndefined()
    await clock.advance(4999)
    expect(hold.begin(C.key)).toBeUndefined()
    await clock.advance(1)
    const second = hold.begin(C.key)!
    expect(second).toBeDefined()
    const inFlight = second.post(C, client(C), prompt('prompt 2'))
    expect(hold.begin(C.key)).toBeUndefined()

    // Notices handed over during the retry are held behind it, with no attempt and no timer.
    await deliver(C, 'n1')
    await deliver(C, 'n2')
    expect(hold.view(C.key).heldNotices).toBe(2)
    expect(postedTexts(C)).toEqual(['prompt 1', 'prompt 2'])
    expect(clock.pendingCount()).toBe(0)

    retry.settle()
    expect(await inFlight).toMatchObject({ outcome: 'posted', channelId: 'C0CEE0001' })
    await clock.flush()

    expect(clock.now()).toBe(5000)
    expect(postedTexts(C)).toEqual(['prompt 1', 'prompt 2', 'n1', 'n2'])
    expect(startLines()).toHaveLength(1)
    expect(clearedLines()).toHaveLength(1)
    expect(hold.view(C.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(clock.pendingCount()).toBe(0)
    const next = hold.begin(C.key)
    expect(next).toBeDefined()
    next!.release()
  })

  test('a failed gated retry only moves the due time on the schedule, logging nothing; a released attempt is given back', async () => {
    stick(C, 'post', 'not_in_channel')
    await hold.begin(C.key)!.post(C, client(C), prompt('p'))
    await clock.advance(5000)

    const released = hold.begin(C.key)!
    released.release()
    const retry = hold.begin(C.key)!
    expect(retry).toBeDefined()
    await retry.post(C, client(C), prompt('p'))

    expect(hold.view(C.key)).toEqual({ held: true, heldNotices: 0, nextDueAt: 15_000 })
    expect(logs).toHaveLength(1)
    await clock.advance(9999)
    expect(hold.begin(C.key)).toBeUndefined()

    // A gated success resets the schedule: the next episode starts at 5 s again.
    unstick(C, 'post')
    await clock.advance(1)
    await hold.begin(C.key)!.post(C, client(C), prompt('p'))
    expect(clearedLines()).toHaveLength(1)
    stick(C, 'post', 'not_in_channel')
    await hold.begin(C.key)!.post(C, client(C), prompt('p'))
    expect(startLines()).toHaveLength(2)
    expect(hold.view(C.key).nextDueAt).toBe(clock.now() + 5000)
    expect(clock.pendingCount()).toBe(0)
  })

  test('a gated retry whose resolver throws still ends: the gate opens again and the notices held behind it drain', async () => {
    stick(C, 'post', 'not_in_channel')
    await hold.begin(C.key)!.post(C, client(C), prompt('p'))
    await clock.advance(5000)

    const retry = hold.begin(C.key)!
    await deliver(C, 'n1')
    expect(hold.view(C.key).heldNotices).toBe(1)
    resolverThrows = 1
    await expect(retry.post(C, client(C), prompt('p'))).rejects.toThrow('resolver threw')

    // No release: `post` itself ended the attempt.
    const again = hold.begin(C.key)
    expect(again).toBeDefined()
    again!.release()
    expect(logs).toHaveLength(1)

    unstick(C, 'post')
    await clock.advance(1)
    expect(postedTexts(C)).toEqual(['p', 'n1'])
    expect(clearedLines()).toHaveLength(1)
    expect(hold.view(C.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(clock.pendingCount()).toBe(0)
  })

  test('a notice handed over while a gated retry is in flight posts once that attempt is released unposted', async () => {
    stub(C).script.post.push({ kind: 'platform', error: 'not_in_channel' })
    await hold.begin(C.key)!.post(C, client(C), prompt('p'))
    await clock.advance(5000)

    const retry = hold.begin(C.key)!
    await deliver(C, 'n1')
    expect(clock.pendingCount()).toBe(0)
    retry.release()
    await clock.advance(1)

    expect(postedTexts(C)).toEqual(['p', 'n1'])
    expect(clearedLines()).toHaveLength(1)
    expect(hold.view(C.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Held-notice retries in flight, not up, no longer applied
// ---------------------------------------------------------------------------

describe('held-notice retries', () => {
  test('while a held-notice retry is in flight nothing else is attempted for the persona, however long it takes', async () => {
    const retry = makeDeferredWebApiCall()
    stub(C).script.post.push({ kind: 'platform', error: 'not_in_channel' }, retry.outcome)
    await deliver(C, 'n1')
    await clock.runNext()
    expect(posts(C)).toHaveLength(2)

    await clock.advance(3_600_000)
    expect(hold.begin(C.key)).toBeUndefined()
    await deliver(C, 'n2')
    expect(posts(C)).toHaveLength(2)
    expect(clock.pendingCount()).toBe(0)

    retry.settle()
    await clock.flush()
    expect(postedTexts(C)).toEqual(['n1', 'n1', 'n2'])
    expect(clearedLines()).toHaveLength(1)
  })

  test('a retry that comes due while the persona has no client keeps it held and waits again, with no line and no Slack call', async () => {
    stick(D, 'open', 'missing_scope')
    await deliver(D, 'n1')
    clients.delete(D.key)

    await clock.runNext()

    expect(stub(D).calls.conversationsOpen).toHaveLength(1)
    expect(hold.view(D.key)).toEqual({ held: true, heldNotices: 1, nextDueAt: 10_000 })
    expect(onlyTimerDelay()).toBe(5000)
    expect(logs).toHaveLength(1)

    clients.set(D.key, asWebClient(stub(D).web))
    unstick(D, 'open')
    await clock.runNext()
    expect(postedTexts(D)).toEqual(['n1'])
    expect(clearedLines()).toHaveLength(1)
  })

  test('a persona not up at a later retry waits the current backoff step (20 s after two failed retries), not 5 s', async () => {
    stick(C, 'post', 'not_in_channel')
    await deliver(C, 'n1')
    await clock.runNext()
    await clock.runNext()
    expect(onlyTimerDelay()).toBe(20_000)
    clients.delete(C.key)

    await clock.runNext()

    expect(posts(C)).toHaveLength(3)
    expect(onlyTimerDelay()).toBe(20_000)
    expect(hold.view(C.key)).toEqual({ held: true, heldNotices: 1, nextDueAt: clock.now() + 20_000 })
    expect(logs).toHaveLength(1)

    clients.set(C.key, asWebClient(stub(C).web))
    unstick(C, 'post')
    await clock.runNext()
    expect(postedTexts(C)).toEqual(['n1', 'n1', 'n1', 'n1'])
    expect(clearedLines()).toHaveLength(1)
  })

  test.each<['getPersona' | 'clientFor']>([['getPersona'], ['clientFor']])(
    'a %s lookup that throws at a due retry waits the current backoff step like a missing client, with one line per run of throws, and recovers',
    async (which) => {
      const lookupLine = (): string =>
        `[slack] persona-destination-hold: persona or client lookup threw for persona=${D.key}: ` +
        `${describeThrownValue(lookupError)} — held notices wait and retry with backoff`
      stick(D, 'open', 'missing_scope')
      await deliver(D, 'n1')
      await clock.runNext()
      expect(onlyTimerDelay()).toBe(10_000)
      lookupThrows = which

      // A run of throws: one line, one timer at the step each time, no spin and no Slack call.
      for (let i = 0; i < 3; i++) {
        const at = clock.now()
        await clock.runNext()
        expect(clock.now()).toBe(at + 10_000)
        expect(onlyTimerDelay()).toBe(10_000)
      }
      expect(logs).toEqual([startLines()[0]!, lookupLine()])
      // The line keeps the thrown value's message, redacted.
      expect(logs[1]).toContain(`message="lookup failed (${REDACTED_SENTINEL_TAIL})"`)
      expect(stub(D).calls.conversationsOpen).toHaveLength(2)
      expect(hold.view(D.key)).toEqual({ held: true, heldNotices: 1, nextDueAt: clock.now() + 10_000 })

      // A lookup that returns ends the run; a later throw is a new run with its own line.
      lookupThrows = undefined
      await clock.runNext()
      expect(stub(D).calls.conversationsOpen).toHaveLength(3)
      expect(onlyTimerDelay()).toBe(20_000)
      lookupThrows = which
      await clock.runNext()
      expect(logs).toEqual([startLines()[0]!, lookupLine(), lookupLine()])
      expect(onlyTimerDelay()).toBe(20_000)

      lookupThrows = undefined
      unstick(D, 'open')
      await clock.runNext()
      expect(postedTexts(D)).toEqual(['n1'])
      expect(clearedLines()).toHaveLength(1)
      expect(hold.view(D.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
      expect(clock.pendingCount()).toBe(0)
    },
  )

  test('a persona no longer applied when its retry comes due has its held notices dropped with one line, never posted', async () => {
    stick(C, 'post', 'not_in_channel')
    await deliver(C, 'n1')
    await deliver(C, 'n2')
    applied.delete(C.key)

    await clock.runNext()

    expect(logs.slice(1)).toEqual([
      `[slack] persona-destination-hold: persona=${C.key} is no longer applied — 2 held notice(s) dropped, not posted`,
    ])
    expect(posts(C)).toHaveLength(1)
    expect(hold.view(C.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cap
// ---------------------------------------------------------------------------

describe(`held-notice cap (${MAX_HELD_NOTICES_PER_PERSONA} per persona)`, () => {
  test('past the cap the oldest held notice is dropped with one line each and never posted; the rest post in order', async () => {
    stick(C, 'post', 'not_in_channel')
    const texts = Array.from({ length: MAX_HELD_NOTICES_PER_PERSONA + 2 }, (_, i) => `n${i + 1}`)
    for (const text of texts) await deliver(C, text)

    const capLines = logs.filter((l) => l.includes('persona-destination-hold:'))
    expect(capLines).toEqual(
      ['n1', 'n2'].map(
        (dropped) =>
          `[slack] persona-destination-hold: more than ${MAX_HELD_NOTICES_PER_PERSONA} notices held for ` +
          `${renderPersonaRef(C.name, C.key)} while its destination fails — oldest held notice dropped, not posted: ${dropped}`,
      ),
    )
    expect(hold.view(C.key).heldNotices).toBe(MAX_HELD_NOTICES_PER_PERSONA)

    unstick(C, 'post')
    await clock.runNext()
    expect(postedTexts(C).slice(1)).toEqual(texts.slice(2))
  })

  test('the notice being retried is never the one the cap drops', async () => {
    const retry = makeDeferredWebApiCall()
    stub(C).script.post.push({ kind: 'platform', error: 'not_in_channel' }, retry.outcome)
    await deliver(C, 'n1')
    await clock.runNext()
    for (let i = 2; i <= MAX_HELD_NOTICES_PER_PERSONA + 1; i++) await deliver(C, `n${i}`)

    expect(logs.filter((l) => l.includes('persona-destination-hold:')).map((l) => l.split(': ').at(-1))).toEqual(['n2'])

    retry.settle()
    await clock.flush()
    expect(postedTexts(C).slice(2)).toEqual(Array.from({ length: MAX_HELD_NOTICES_PER_PERSONA - 1 }, (_, i) => `n${i + 3}`))
    expect(postedTexts(C).filter((t) => t === 'n1')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

describe('cancel and cancelAll', () => {
  const droppedLine = (why: string, count: number, ref: string): string =>
    `[slack] persona-destination-hold: ${why} — ${count} held notice(s) for ${ref} dropped, not posted`

  test('cancel drops the persona\'s held notices with one hold-cancelled line naming the count, clears its timer, and makes no further attempt', async () => {
    stick(D, 'open', 'missing_scope')
    await deliver(D, 'n1')
    await deliver(D, 'n2')
    const callsBefore = stub(D).callLog.length

    hold.cancel(D.key)

    expect(logs.slice(1)).toEqual([droppedLine('hold cancelled', 2, renderPersonaRef(D.name, D.key))])
    expect(clock.pendingCount()).toBe(0)
    expect(hold.view(D.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    // Idempotent: a second cancel has nothing to drop and logs nothing.
    hold.cancel(D.key)
    await clock.advance(3_600_000)
    expect(stub(D).callLog).toHaveLength(callsBefore)
    expect(logs).toHaveLength(2)
    expect(postedTexts(D)).toEqual([])
  })

  test('cancel of a persona with no notices held (a gate-only episode, or none at all) logs nothing', async () => {
    stick(C, 'post', 'not_in_channel')
    await hold.begin(C.key)!.post(C, client(C), { text: 'p' })
    expect(hold.view(C.key).held).toBe(true)

    hold.cancel(C.key)
    hold.cancel(E.key)

    expect(logs).toEqual(startLines())
    expect(hold.view(C.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(hold.begin(C.key)).toBeDefined()
  })

  test('a persona whose name the hold never learned is named by key in the cancel line', async () => {
    stick(C, 'post', 'not_in_channel')
    await deliver(C, 'n1')
    // The last notice handed over names the persona for the cancel line; this one carries no name.
    const nameless = { ...C, name: undefined } as unknown as Persona
    await hold.deliver(nameless, client(C), notice('n2'))

    hold.cancel(C.key)

    expect(logs.slice(1)).toEqual([droppedLine('hold cancelled', 2, `persona=${C.key}`)])
  })

  test('cancelAll cancels every persona: one shutting-down line per persona with notices held, none for a gate-only episode, no timer, no further call', async () => {
    stick(D, 'open', 'missing_scope')
    stick(C, 'post', 'not_in_channel')
    stick(E, 'open', 'missing_scope')
    await deliver(D, 'd1')
    await deliver(C, 'c1')
    await deliver(C, 'c2')
    await hold.begin(E.key)!.post(E, client(E), { text: 'e prompt' })
    expect(startLines()).toHaveLength(3)
    expect(clock.pendingCount()).toBe(2)

    hold.cancelAll()

    expect(logs.slice(3)).toEqual([
      droppedLine('shutting down', 1, renderPersonaRef(D.name, D.key)),
      droppedLine('shutting down', 2, renderPersonaRef(C.name, C.key)),
    ])
    expect(clock.pendingCount()).toBe(0)
    await clock.advance(3_600_000)
    expect(stub(D).callLog).toHaveLength(1)
    expect(stub(C).callLog).toHaveLength(1)
    expect(stub(E).callLog).toHaveLength(1)
    expect(logs).toHaveLength(5)
  })

  test.each<[string, string, 'retry' | 'deliver', SettledWebApiOutcome | undefined]>([
    ['a held-notice retry', 'succeeds', 'retry', undefined],
    ['a held-notice retry', 'fails', 'retry', { kind: 'platform', error: 'not_in_channel' }],
    ['an immediate deliver() attempt', 'succeeds', 'deliver', undefined],
    ['an immediate deliver() attempt', 'fails', 'deliver', { kind: 'platform', error: 'not_in_channel' }],
  ])('%s in flight at cancel that then %s changes nothing: no persona-destination-failed line, only the shutdown line when notices were held', async (_what, _how, via, outcome) => {
    const slow = makeDeferredWebApiCall()
    const gated = makeDeferredWebApiCall()
    stub(D).script.post.push(gated.outcome)
    let delivered: Promise<void> = Promise.resolve()
    if (via === 'retry') {
      stub(C).script.post.push({ kind: 'platform', error: 'not_in_channel' }, slow.outcome)
      await deliver(C, 'n1')
      await deliver(C, 'n2')
      await clock.runNext()
    } else {
      stub(C).script.post.push(slow.outcome)
      delivered = deliver(C, 'n1')
    }
    const gatedPost = hold.begin(D.key)!.post(D, client(D), { text: 'prompt' })
    await clock.flush()
    const linesBefore = logs.length
    const failuresBefore = failures.length

    hold.cancelAll()
    slow.settle(outcome)
    gated.settle(outcome)
    await delivered
    await gatedPost
    await clock.flush()

    expect(logs.slice(linesBefore)).toEqual(
      via === 'retry' ? [droppedLine('shutting down', 2, renderPersonaRef(C.name, C.key))] : [],
    )
    expect(logs.filter((l) => l.includes('persona-destination-failed'))).toHaveLength(via === 'retry' ? 1 : 0)
    expect(failures).toHaveLength(failuresBefore)
    expect(postedTexts(C)).toEqual(via === 'retry' ? ['n1', 'n1'] : ['n1'])
    expect(hold.view(C.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(hold.view(D.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Not destination failures
// ---------------------------------------------------------------------------

describe('failures that open no episode', () => {
  test.each<[string, 'deliver' | 'begin']>([
    ['invalid_blocks', 'deliver'],
    ['msg_too_long', 'deliver'],
    ['msg_too_long', 'begin'],
  ])('a %s payload error (through %s) is not held: no episode, no line, no timer', async (error, via) => {
    stub(C).script.post.push({ kind: 'platform', error })

    if (via === 'deliver') {
      await deliver(C, 'n1')
      expect(failures).toEqual([{ notice: 'n1', step: 'chat.postMessage', code: error, first: true, held: false }])
    } else {
      expect(await hold.begin(C.key)!.post(C, client(C), { text: 'p' })).toMatchObject({ outcome: 'failed', code: error })
    }

    expect(logs.filter((l) => l.includes('persona-destination-failed'))).toEqual([])
    expect(hold.view(C.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(clock.pendingCount()).toBe(0)
    // Not held: the next item goes straight through.
    await deliver(C, 'n2')
    expect(postedTexts(C)).toEqual([via === 'deliver' ? 'n1' : 'p', 'n2'])
  })

  test('a payload error during a held-notice retry drops that notice only; the ones behind it post', async () => {
    stub(C).script.post.push(
      { kind: 'platform', error: 'not_in_channel' },
      { kind: 'ok' },
      { kind: 'platform', error: 'invalid_blocks' },
    )
    await deliver(C, 'n1')
    await deliver(C, 'n2')
    await deliver(C, 'n3')

    await clock.runNext()

    expect(postedTexts(C)).toEqual(['n1', 'n1', 'n2', 'n3'])
    expect(failures.filter((f) => f.notice === 'n2')).toEqual([
      { notice: 'n2', step: 'chat.postMessage', code: 'invalid_blocks', first: true, held: false },
    ])
    expect(startLines()).toHaveLength(1)
    expect(hold.view(C.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
  })

  test('a refused dm destination (DMs off) makes no Slack call and opens no episode', async () => {
    await deliver(R, 'n1')
    const gated = await hold.begin(R.key)!.post(R, client(R), { text: 'p' })

    expect(gated).toEqual({ outcome: 'refused', reason: 'dm_disabled' })
    expect(stub(R).callLog).toEqual([])
    expect(failures).toEqual([])
    expect(logs.filter((l) => l.includes('persona-destination-failed'))).toEqual([])
    expect(hold.view(R.key)).toEqual({ held: false, heldNotices: 0, nextDueAt: undefined })
    expect(hold.begin(R.key)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Isolation and secrecy
// ---------------------------------------------------------------------------

describe('isolation (SR-3.3) and secrecy (SR-10.3)', () => {
  test('persona D in a missing_scope episode neither delays, holds nor logs for E or C: theirs post at once through their own clients', async () => {
    stick(D, 'open', 'missing_scope')
    await deliver(D, 'd1')

    await deliver(E, 'e1')
    await deliver(C, 'c1')
    const gated = hold.begin(E.key)!
    await gated.post(E, client(E), { text: 'e prompt' })

    expect(clock.now()).toBe(0)
    expect(posts(E)).toEqual([
      { channel: stubOpenedDmId('U0EFF0001'), text: 'e1' },
      { channel: stubOpenedDmId('U0EFF0001'), text: 'e prompt' },
    ])
    expect(posts(C)).toEqual([{ channel: 'C0CEE0001', text: 'c1' }])
    expect(posts(D)).toEqual([])
    expect(logs.filter((l) => l.includes(E.key) || l.includes(C.key))).toEqual([])
    expect(hold.view(E.key).held).toBe(false)
    expect(hold.view(C.key).held).toBe(false)
    expect(hold.view(D.key)).toEqual({ held: true, heldNotices: 1, nextDueAt: 5000 })
    expect(onlyTimerDelay()).toBe(5000)
  })

  test('an error code that is not a short identifier (here a token-like value) is logged as unknown_error; the line carries the code only', async () => {
    stub(C).script.post.push({ kind: 'platform', error: fakeToken(BOT_TOKEN_PREFIX, 'code') })
    await deliver(C, 'n1')

    expect(startLines()).toHaveLength(1)
    expect(startLines()[0]).toContain('chat.postMessage failed for destination=C0CEE0001 with error unknown_error;')
    expect(failures).toHaveLength(1)
    // The callback gets the raw failure (its caller logs it token-safely), so keep that copy out of the leak check.
    failures.length = 0

    await clock.runNext()
    expect(clearedLines()[0]).toContain('(was chat.postMessage error unknown_error)')
  })
})
