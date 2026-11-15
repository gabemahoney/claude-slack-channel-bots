/**
 * ack-tracker.test.ts — Tests for the ack-tracker module (section;
 * persona-keyed entries, section)
 *
 * Entries are keyed by (persona key, conversation ID, message ts); only an exact match consumes one. The per-key forget drops one
 * persona's entries at its teardown. The react claim (claimReactAnswer) answers from the same kept-answer memory consumeAck
 * records, in the step that records it.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach, jest, spyOn } from 'bun:test'
import { trackAck, consumeAck, claimReactAnswer, forgetPersonaAcks, _resetAckTracker, addDeliveryAck, EARLY_REPLY_EXPIRY_MS, createQueuedAckCallback, createDeliveryAckCallback } from '../src/ack-tracker.ts'
import { DEFAULT_ACK_REACTION, DEFAULT_QUEUED_ACK_REACTION } from '../src/config.ts'
import type { AcceptedInput, QueueItem } from '../src/delivery-queue.ts'
import { slackInput } from './test-helpers/delivery-queue.ts'
import { THREAD_ROOTS, THREAD_STAMP } from './test-helpers/thread-memory.ts'
import { makeStubSlack } from './test-helpers/slack-stub.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { makeQueuedAckHarness, type QueuedAckHarness } from './test-helpers/queued-ack.ts'

type Triple = [personaKey: string, channelId: string, messageTs: string]

function threadAckItem(ts: string, overrides: Partial<AcceptedInput> = {}): QueueItem {
  return {
    accepted: { ...slackInput({ via: 'thread', thread_ts: THREAD_ROOTS.primary,
      key: { chat_id: slackInput().channel!, ts }, queued_ack_reaction: DEFAULT_QUEUED_ACK_REACTION, ...overrides }),
      v: 1, kind: 'accepted', seq: 1, received_at: 1000, ts },
    records: [], delivered: false, unknownSend: false, retypeCount: 0, nextAttempt: 1,
  }
}

describe('joined thread reaction identity', () => {
  test('a root mention and its thread-selected reply keep separate queued and delivered reactions', async () => {
    const slack = makeStubSlack()
    const queued = createQueuedAckCallback({ getReaction: () => DEFAULT_QUEUED_ACK_REACTION, clientFor: () => slack.web })
    const delivered = createDeliveryAckCallback({ getReaction: () => DEFAULT_ACK_REACTION, clientFor: () => slack.web })
    const root = threadAckItem(THREAD_ROOTS.primary, { via: 'mention',
      thread_join: { thread_ts: THREAD_ROOTS.primary, stamp: { ...THREAD_STAMP }, at: 1000 } })
    const reply = threadAckItem(THREAD_ROOTS.secondary)
    const args = (timestamp: string, name: string) => ({ channel: root.accepted.channel!, timestamp, name })
    for (const item of [root, reply]) await queued('alpha', item)
    for (const item of [root, reply]) await delivered('alpha', { ...item, delivered: true })
    expect(slack.calls.reactionsAdd).toEqual([
      args(root.accepted.ts, DEFAULT_QUEUED_ACK_REACTION), args(reply.accepted.ts, DEFAULT_QUEUED_ACK_REACTION),
      args(root.accepted.ts, DEFAULT_ACK_REACTION), args(reply.accepted.ts, DEFAULT_ACK_REACTION),
    ])
    await consumeAck('alpha', reply.accepted.channel!, reply.accepted.ts, async () => {})
    expect(consumeAck('alpha', reply.accepted.channel!, reply.accepted.ts)).toBe(false)
    expect(slack.calls.reactionsRemove).toEqual([
      args(root.accepted.ts, DEFAULT_QUEUED_ACK_REACTION), args(reply.accepted.ts, DEFAULT_QUEUED_ACK_REACTION),
      args(reply.accepted.ts, DEFAULT_ACK_REACTION),
    ])
    await consumeAck('alpha', root.accepted.channel!, root.accepted.ts, async () => {})
    expect(slack.calls.reactionsRemove.at(-1)).toEqual(args(root.accepted.ts, DEFAULT_ACK_REACTION))
    expect(slack.calls.reactionsRemove).toHaveLength(4)
  })

  test('the same thread-selected reply is consumed independently for two joined personas', async () => {
    const stubs = { alpha: makeStubSlack(), beta: makeStubSlack() }
    const queued = createQueuedAckCallback({ getReaction: () => DEFAULT_QUEUED_ACK_REACTION, clientFor: key => stubs[key as keyof typeof stubs].web })
    const delivered = createDeliveryAckCallback({ getReaction: () => DEFAULT_ACK_REACTION, clientFor: key => stubs[key as keyof typeof stubs].web })
    const reply = threadAckItem(THREAD_ROOTS.secondary)
    const args = (name: string) => ({ channel: reply.accepted.channel!, timestamp: reply.accepted.ts, name })
    for (const key of ['alpha', 'beta']) {
      await queued(key, reply)
      await delivered(key, { ...reply, delivered: true })
    }
    await consumeAck('alpha', reply.accepted.channel!, reply.accepted.ts, async () => {})
    expect(consumeAck('alpha', reply.accepted.channel!, reply.accepted.ts)).toBe(false)
    expect(stubs.alpha.calls.reactionsRemove).toEqual([args(DEFAULT_QUEUED_ACK_REACTION), args(DEFAULT_ACK_REACTION)])
    expect(stubs.beta.calls.reactionsRemove).toEqual([args(DEFAULT_QUEUED_ACK_REACTION)])
    await consumeAck('beta', reply.accepted.channel!, reply.accepted.ts, async () => {})
    expect(stubs.beta.calls.reactionsRemove).toEqual([args(DEFAULT_QUEUED_ACK_REACTION), args(DEFAULT_ACK_REACTION)])
    for (const stub of Object.values(stubs)) expect(stub.calls.reactionsAdd).toEqual([args(DEFAULT_QUEUED_ACK_REACTION), args(DEFAULT_ACK_REACTION)])
  })
})

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetAckTracker()
  jest.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('trackAck + consumeAck', () => {
  test('trackAck followed by consumeAck returns true', () => {
    trackAck('A', 'C_TEST', '1234567890.000100')

    expect(consumeAck('A', 'C_TEST', '1234567890.000100')).toBe(true)
  })

  test('second consumeAck on the same entry returns false', () => {
    trackAck('A', 'C_TEST', '1234567890.000200')
    consumeAck('A', 'C_TEST', '1234567890.000200')

    expect(consumeAck('A', 'C_TEST', '1234567890.000200')).toBe(false)
  })

  test('consumeAck on an untracked message returns false', () => {
    expect(consumeAck('A', 'C_TEST', 'never-tracked.000300')).toBe(false)
  })
})

describe('only an exact (persona, conversation, ts) match consumes', () => {
  const tracked: Triple = ['A', 'C_ALPHA', '1234567890.000400']

  test.each<[string, Triple]>([
    ['a different persona', ['B', 'C_ALPHA', '1234567890.000400']],
    ['a different conversation', ['A', 'C_BETA', '1234567890.000400']],
    ['a different ts', ['A', 'C_ALPHA', '1234567890.000401']],
  ])('a consume for %s returns false and leaves the entry', (_label, mismatched) => {
    trackAck(...tracked)

    expect(consumeAck(...mismatched)).toBe(false)
    expect(consumeAck(...tracked)).toBe(true)
  })

  test('two personas on one shared message hold independent entries', () => {
    trackAck('A', 'C_SHARED', '1234567890.000450')
    trackAck('B', 'C_SHARED', '1234567890.000450')

    expect(consumeAck('A', 'C_SHARED', '1234567890.000450')).toBe(true)
    expect(consumeAck('A', 'C_SHARED', '1234567890.000450')).toBe(false)
    expect(consumeAck('B', 'C_SHARED', '1234567890.000450')).toBe(true)
    expect(consumeAck('B', 'C_SHARED', '1234567890.000450')).toBe(false)
  })

  // Each pair joins to one string under a naive separator (`:`, `,`, an
  // unescaped JSON-style `","` join, or a `[p][c][t]` join); the tracker must
  // keep them apart.
  test.each<[string, Triple, Triple]>([
    ['`:` between persona and conversation', ['a:b', 'C1', '1.000500'], ['a', 'b:C1', '1.000500']],
    ['`:` between conversation and ts', ['a', 'C1:1', '000500'], ['a', 'C1', '1:000500']],
    ['`,` between persona and conversation', ['a,b', 'C1', '1.000500'], ['a', 'b,C1', '1.000500']],
    ['`","` between persona and conversation', ['a","b', 'C1', '1.000500'], ['a', 'b","C1', '1.000500']],
    ['`][` between persona and conversation', ['a][b', 'C1', '1.000500'], ['a', 'b][C1', '1.000500']],
  ])('triples that collide under a naive join stay independent (%s)', (_label, first, second) => {
    trackAck(...first)
    expect(consumeAck(...second)).toBe(false)
    expect(consumeAck(...first)).toBe(true)

    trackAck(...first)
    trackAck(...second)
    expect(consumeAck(...first)).toBe(true)
    expect(consumeAck(...second)).toBe(true)
  })
})

describe('forgetPersonaAcks — per-persona forget at teardown', () => {
  test("drops only that persona's entries, silently", () => {
    trackAck('A', 'C_ALPHA', '1234567890.000600')
    trackAck('A', 'C_BETA', '1234567890.000610')
    trackAck('B', 'C_ALPHA', '1234567890.000600')
    const logs = [
      spyOn(console, 'log').mockImplementation(() => {}),
      spyOn(console, 'warn').mockImplementation(() => {}),
      spyOn(console, 'error').mockImplementation(() => {}),
    ]

    forgetPersonaAcks('A')
    forgetPersonaAcks('NO_SUCH_PERSONA')

    for (const log of logs) expect(log).not.toHaveBeenCalled()
    expect(consumeAck('A', 'C_ALPHA', '1234567890.000600')).toBe(false)
    expect(consumeAck('A', 'C_BETA', '1234567890.000610')).toBe(false)
    expect(consumeAck('B', 'C_ALPHA', '1234567890.000600')).toBe(true)
  })

  test('a key re-added after the forget starts clean and tracks again', () => {
    trackAck('A', 'C_ALPHA', '1234567890.000700')
    forgetPersonaAcks('A')

    trackAck('A', 'C_ALPHA', '1234567890.000710')

    expect(consumeAck('A', 'C_ALPHA', '1234567890.000700')).toBe(false)
    expect(consumeAck('A', 'C_ALPHA', '1234567890.000710')).toBe(true)
  })
})

describe('pruning expired entries', () => {
  test('a burst does not iterate tracking maps before any entry can expire', () => {
    const iterator = Map.prototype[Symbol.iterator]
    let visited = 0
    const walking = spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (this: Map<unknown, unknown>): Generator<[unknown, unknown], undefined> {
      for (const pair of iterator.call(this)) { visited++; yield pair }
      return undefined
    })
    try {
      for (let i = 0; i < 64; i++) trackAck('A', 'C_TEST', String(i))
      for (let i = 0; i < 64; i++) expect(consumeAck('A', 'C_TEST', String(i))).toBe(true)
    } finally { walking.mockRestore() }
    expect(visited).toBe(0)
  })

  test('entries older than 30 days are pruned on the next trackAck call', () => {
    const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000

    try {
      // Track an ack at the current time
      trackAck('A', 'C_TEST', '1234567890.000800')

      // Advance the clock past the 30-day expiry window
      jest.setSystemTime(Date.now() + thirtyOneDaysMs)

      // Trigger pruning via a new trackAck call (another persona's record prunes too)
      trackAck('B', 'C_TEST', '1234567890.000900')

      // The old entry should have been pruned
      expect(consumeAck('A', 'C_TEST', '1234567890.000800')).toBe(false)

      // The new entry should still be present
      expect(consumeAck('B', 'C_TEST', '1234567890.000900')).toBe(true)
    } finally {
      // Restore system time so other tests aren't affected
      jest.setSystemTime()
    }
  })

  test('an expired entry busy in Slack is reconsidered after its tail settles', async () => {
    const at = Date.now(), days = 31 * 24 * 60 * 60 * 1000
    let release!: () => void, entered!: () => void, didRemove!: () => void, removed = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { entered = resolve })
    const removal = new Promise<void>(resolve => { didRemove = resolve })
    try {
      jest.setSystemTime(at)
      const pending = addDeliveryAck('A', 'C_TEST', 'busy', async () => { entered(); await gate }, async () => { removed++; didRemove() })
      await reached
      jest.setSystemTime(at + days)
      trackAck('B', 'C_TEST', 'trigger')
      expect(removed).toBe(0)
      release(); await pending
      trackAck('B', 'C_TEST', 'trigger-again')
      expect(consumeAck('A', 'C_TEST', 'busy')).toBe(false)
      await removal
      expect(removed).toBe(1)
      expect(consumeAck('B', 'C_TEST', 'trigger')).toBe(true)
    } finally { release(); jest.setSystemTime() }
  })
})

describe('_resetAckTracker', () => {
  test('_resetAckTracker clears all entries', () => {
    trackAck('A', 'C_ALPHA', '1234567890.001000')
    trackAck('B', 'C_BETA', '1234567890.001100')

    _resetAckTracker()

    expect(consumeAck('A', 'C_ALPHA', '1234567890.001000')).toBe(false)
    expect(consumeAck('B', 'C_BETA', '1234567890.001100')).toBe(false)
  })
})

// successful replies have a separate, memory-only 24h lifetime.
describe('early successful replies', () => {
  test.each([['other persona', 'B', 'C_ALPHA', 'early'], ['other channel', 'A', 'C_OTHER', 'early'], ['other message', 'A', 'C_ALPHA', 'other']])('%s does not suppress another delivery', async (_label, persona, channel, ts) => {
    consumeAck('A', 'C_ALPHA', 'early')
    let adds = 0
    await addDeliveryAck(persona!, channel!, ts!, async () => { adds++ }, async () => {})
    expect(adds).toBe(1)
  })
  test('reply without an ack suppresses a later add through exactly 24 hours, then expires', async () => {
    const at = Date.now()
    try {
      jest.setSystemTime(at)
      expect(consumeAck('A', 'C_ALPHA', 'early')).toBe(false)
      trackAck('B', 'C_ALPHA', 'existing')
      let adds = 0
      const add = () => addDeliveryAck('A', 'C_ALPHA', 'early', async () => { adds++ }, async () => {})
      jest.setSystemTime(at + EARLY_REPLY_EXPIRY_MS)
      await add(); expect(adds).toBe(0)
      jest.setSystemTime(at + EARLY_REPLY_EXPIRY_MS + 1)
      await add(); expect(adds).toBe(1)
      // Existing pending acks retain their 30-day contract.
      expect(consumeAck('B', 'C_ALPHA', 'existing')).toBe(true)
    } finally { jest.setSystemTime() }
  })
  test.each(['reset', 'teardown'])('%s clears early replies while a sibling remains suppressed after teardown', async kind => {
    consumeAck('A', 'C_ALPHA', 'early'); consumeAck('B', 'C_ALPHA', 'early')
    if (kind === 'reset') _resetAckTracker()
    else forgetPersonaAcks('A')
    const adds: string[] = []
    for (const key of ['A', 'B']) await addDeliveryAck(key, 'C_ALPHA', 'early', async () => { adds.push(key) }, async () => {})
    expect(adds).toEqual(kind === 'reset' ? ['A', 'B'] : ['A'])
  })
})

// SR-6.4: a react's claim answers `alreadyHeld` from consumeAck's own
// kept-answer memory and records the answer in the same synchronous step.
describe('claimReactAnswer — the react claim', () => {
  const T: Triple = ['A', 'C_ALPHA', '1234567890.002000']
  const harnesses: QueuedAckHarness[] = []
  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.cleanup()
    _resetAckTracker()
  })

  /** Alpha's ordinary Slack message with its real automatic queued ack visible. */
  async function queuedAck(): Promise<QueuedAckHarness> {
    const h = await makeQueuedAckHarness(); harnesses.push(h)
    await h.receive()
    expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
    return h
  }
  const acked = (h: QueuedAckHarness): Triple => ['alpha', h.event.channel as string, h.event.ts as string]

  /** Run `body` with Date.now on a fresh fake clock, restored however it ends. */
  async function onFakeClock(body: (clock: FakeClock) => Promise<void>): Promise<void> {
    const clock = createFakeClock()
    const now = spyOn(Date, 'now').mockImplementation(clock.now)
    try { await body(clock) } finally { now.mockRestore() }
  }

  test('two claims with no turn between them answer false then true; cleanup is detached, held and started once', async () => {
    const h = await queuedAck()
    const held = h.hold('reactionsRemove')
    expect([claimReactAnswer(...acked(h), 'thumbsup'), claimReactAnswer(...acked(h), 'thumbsup')]).toEqual([false, true])
    expect(h.stub().calls.reactionsRemove).toEqual([])
    await h.e.clock.flush()
    const removal = { channel: h.event.channel, timestamp: h.event.ts, name: h.settings.queued_ack_reaction }
    expect(h.stub().calls.reactionsRemove).toEqual([removal])
    // While that removal is still held, later claims answer at once and start no other cleanup.
    expect([claimReactAnswer(...acked(h), 'thumbsup'), claimReactAnswer(...acked(h), 'tada')]).toEqual([true, false])
    await h.e.clock.flush()
    expect(held.settled).toBe(false)
    expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
    held.settle(); await h.e.clock.flush()
    expect(h.visible()).toEqual([])
    expect(h.stub().calls.reactionsRemove).toEqual([removal])
    expect(h.stub('beta').calls.reactionsRemove).toEqual([])
  })

  test("consumeAck's react answer with an emoji holds the claim of that emoji only", async () => {
    await consumeAck(...T, async () => {}, 'thumbsup')
    expect([claimReactAnswer(...T, 'thumbsup'), claimReactAnswer(...T, 'tada')]).toEqual([true, false])
  })

  test("a claim, then consumeAck with another kept emoji: both emoji are held and a third is still first", async () => {
    expect(claimReactAnswer(...T, 'thumbsup')).toBe(false)
    await consumeAck(...T, async () => {}, 'tada')
    expect([claimReactAnswer(...T, 'thumbsup'), claimReactAnswer(...T, 'tada'), claimReactAnswer(...T, 'eyes')]).toEqual([true, true, false])
  })

  test.each<[string, () => void]>([
    ['an untracked target', () => {}],
    ['an earlier text answer with no kept name', () => { expect(consumeAck(...T)).toBe(false) }],
    ['an earlier text answer that consumed a tracked ack', () => { trackAck(...T); expect(consumeAck(...T)).toBe(true) }],
  ])('%s leaves the first claim first', (_label, before) => {
    before()
    expect([claimReactAnswer(...T, 'thumbsup'), claimReactAnswer(...T, 'thumbsup')]).toEqual([false, true])
  })

  test.each<[string, Triple, string]>([
    ['persona', ['B', T[1], T[2]], 'thumbsup'],
    ['conversation', [T[0], 'C_BETA', T[2]], 'thumbsup'],
    ['message', [T[0], T[1], '1234567890.002001'], 'thumbsup'],
    ['emoji', T, 'tada'],
  ])('a claim differing only in its %s is first on its own and leaves the original held', (_label, other, emoji) => {
    expect(claimReactAnswer(...T, 'thumbsup')).toBe(false)
    expect(claimReactAnswer(...other, emoji)).toBe(false)
    expect([claimReactAnswer(...T, 'thumbsup'), claimReactAnswer(...other, emoji)]).toEqual([true, true])
  })

  test("a deliberate claim of the visible automatic ack's own emoji is first, keeps that reaction and stops later stages", async () => {
    const h = await queuedAck()
    const name = h.settings.queued_ack_reaction
    expect([claimReactAnswer(...acked(h), name), claimReactAnswer(...acked(h), name)]).toEqual([false, true])
    await h.deliver()
    expect(h.visible()).toEqual([name])
    expect(h.stub().calls.reactionsRemove).toEqual([])
    expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual([name])
  })

  // L6. Each row is its own setup, because a probe is itself a claim that refreshes the answer.
  test.each<[string, number, boolean]>([
    ['exactly', 0, true],
    ['1 ms more than', 1, false],
  ])('a repeat claim %s EARLY_REPLY_EXPIRY_MS (+%d ms) after the first answers alreadyHeld=%p', (_label, past, held) => onFakeClock(async clock => {
    expect(claimReactAnswer(...T, 'thumbsup')).toBe(false)
    await clock.advance(EARLY_REPLY_EXPIRY_MS + past)
    expect(claimReactAnswer(...T, 'thumbsup')).toBe(held)
  }))

  test('a losing claim refreshes the kept answer, as consumeAck does', () => onFakeClock(async clock => {
    expect(claimReactAnswer(...T, 'thumbsup')).toBe(false)
    await clock.advance(EARLY_REPLY_EXPIRY_MS)
    expect(claimReactAnswer(...T, 'thumbsup')).toBe(true)
    await clock.advance(1)
    expect(claimReactAnswer(...T, 'thumbsup')).toBe(true)
  }))

  test("the 30-day ack entry's kept name holds no claim once the early answer expires", () => onFakeClock(async clock => {
    let adds = 0
    const add = () => addDeliveryAck(...T, async () => { adds++ }, async () => {})
    await add()
    expect(adds).toBe(1)
    expect(claimReactAnswer(...T, 'thumbsup')).toBe(false)
    await clock.advance(EARLY_REPLY_EXPIRY_MS + 1)
    // The answered entry outlives the early answer: it still stops a later stage.
    await add()
    expect(adds).toBe(1)
    expect(claimReactAnswer(...T, 'thumbsup')).toBe(false)
  }))

  test.each(['teardown', 'restart'] as const)('%s forgets the kept answers it covers, so the next claim is first; only teardown leaves a sibling persona held', kind => {
    const sibling: Triple = ['B', T[1], T[2]]
    expect([claimReactAnswer(...T, 'thumbsup'), claimReactAnswer(...sibling, 'thumbsup')]).toEqual([false, false])
    if (kind === 'teardown') forgetPersonaAcks('A')
    else _resetAckTracker()
    expect([claimReactAnswer(...T, 'thumbsup'), claimReactAnswer(...sibling, 'thumbsup')]).toEqual([false, kind === 'teardown'])
  })
})
