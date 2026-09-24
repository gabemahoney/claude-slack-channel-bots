/**
 * inbound-dedupe.test.ts — One persona's inbound dedupe store (b.av2 SR-4.1,
 * including the edited-event key, SR-4.2 no count or rate state, SR-13.1
 * injected clock).
 *
 * Imports the module directly: no server, no `mock.module`, no I/O. Time
 * moves only through the shared fake clock's `now()`; nothing sleeps and no
 * timer is scheduled. Pruning is observed through the store's `size`.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { INBOUND_DEDUPE_RETENTION_MS, createInboundDedupeStore } from '../src/inbound-dedupe.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'

const TEN_MINUTES_MS = 10 * 60 * 1000
const CHANNEL = 'C0DEDUPE01'
const TS = '1700000000.000100'
/** Two edit ts values for the same message. */
const EDIT = '1700000060.000100'
const EDIT2 = '1700000120.000100'

/** A store on a fresh fake clock starting at 0. */
function makeStore() {
  const clock = createFakeClock()
  return { clock, store: createInboundDedupeStore(clock.now) }
}

describe('inbound dedupe: new vs duplicate', () => {
  test('the first sighting of a key is new and a repeat is a duplicate', () => {
    const { store } = makeStore()
    expect(store.record(CHANNEL, TS)).toBe('new')
    expect(store.record(CHANNEL, TS)).toBe('duplicate')
    expect(store.record(CHANNEL, TS)).toBe('duplicate')
    expect(store.size).toBe(1)
  })

  // Each row records (CHANNEL, TS, edit ts) first, then its own key with the
  // same edit ts: the three-part rows prove every part of an edited key counts.
  test.each<[string, string, string, string | undefined]>([
    ['only the conversation differs', 'C0DEDUPE02', TS, undefined],
    ['only the ts differs', CHANNEL, '1700000000.000200', undefined],
    ['a DM conversation with the same ts', 'D0DEDUPE01', TS, undefined],
    ['an edit with the same conversation and edit ts but a different ts', CHANNEL, '1700000000.000200', EDIT],
    ['an edit with the same ts and edit ts but a different conversation', 'C0DEDUPE02', TS, EDIT],
  ])('a key where %s is new', (_label, conversation, ts, editedTs) => {
    const { store } = makeStore()
    expect(store.record(CHANNEL, TS, editedTs)).toBe('new')
    expect(store.record(conversation, ts, editedTs)).toBe('new')
    expect(store.record(conversation, ts, editedTs)).toBe('duplicate')
    expect(store.size).toBe(2)
  })

  test('the split between the parts is part of the key: "a:b"/"c", "a"/"b:c", "ab"/"c", "a"/"bc" and "a"/"b"/"c" are distinct', () => {
    const { store } = makeStore()
    expect(store.record('a:b', 'c')).toBe('new')
    expect(store.record('a', 'b:c')).toBe('new')
    expect(store.record('ab', 'c')).toBe('new')
    expect(store.record('a', 'bc')).toBe('new')
    expect(store.record('a', 'b', 'c')).toBe('new')
    expect(store.record('a', 'b', 'c')).toBe('duplicate')
    expect(store.size).toBe(5)
  })
})

describe('inbound dedupe: edited event dedupe (conversation, ts, edit ts)', () => {
  test('after (conversation, ts) is seen, an edit of it is new, its repeat a duplicate, another edit new, and an unedited repeat still a duplicate', () => {
    const { store } = makeStore()
    expect(store.record(CHANNEL, TS)).toBe('new')
    expect(store.record(CHANNEL, TS, EDIT)).toBe('new')
    expect(store.record(CHANNEL, TS, EDIT)).toBe('duplicate')
    expect(store.record(CHANNEL, TS, EDIT2)).toBe('new')
    expect(store.record(CHANNEL, TS)).toBe('duplicate')
    expect(store.size).toBe(3)
  })

  test.each([
    ['empty', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 1700000060.0001],
    ['an object', { ts: EDIT }],
  ])('an edit ts that is %s is keyed as unedited: a duplicate of the original', (_label, editedTs) => {
    const { store } = makeStore()
    expect(store.record(CHANNEL, TS)).toBe('new')
    expect(store.record(CHANNEL, TS, editedTs)).toBe('duplicate')
    expect(store.size).toBe(1)
  })

  test('an edited key has its own window from its first sighting', async () => {
    const { clock, store } = makeStore()
    store.record(CHANNEL, TS)
    await clock.advanceTo(60_000)
    expect(store.record(CHANNEL, TS, EDIT)).toBe('new')
    await clock.advanceTo(60_000 + INBOUND_DEDUPE_RETENTION_MS - 1)
    expect(store.record(CHANNEL, TS)).toBe('new') // the original's window has ended
    expect(store.record(CHANNEL, TS, EDIT)).toBe('duplicate')
    await clock.advanceTo(60_000 + INBOUND_DEDUPE_RETENTION_MS)
    expect(store.record(CHANNEL, TS, EDIT)).toBe('new')
  })

  test('an edit ts does not make an event without a conversation or ts keyable', () => {
    const { store } = makeStore()
    expect(store.record(undefined, TS, EDIT)).toBe('unkeyable')
    expect(store.record(CHANNEL, '', EDIT)).toBe('unkeyable')
    expect(store.size).toBe(0)
  })
})

describe('inbound dedupe: retention window', () => {
  test('the retention constant is at least 10 minutes', () => {
    expect(INBOUND_DEDUPE_RETENTION_MS).toBeGreaterThanOrEqual(TEN_MINUTES_MS)
  })

  test('a repeat just under 10 minutes after the first sighting is still a duplicate', async () => {
    const { clock, store } = makeStore()
    expect(store.record(CHANNEL, TS)).toBe('new')
    await clock.advanceTo(TEN_MINUTES_MS - 1)
    expect(store.record(CHANNEL, TS)).toBe('duplicate')
  })

  test('a duplicate does not restart the window: expiry counts from the first sighting', async () => {
    const { clock, store } = makeStore()
    store.record(CHANNEL, TS)
    for (const at of [1, TEN_MINUTES_MS / 2, INBOUND_DEDUPE_RETENTION_MS - 1]) {
      await clock.advanceTo(at)
      expect(store.record(CHANNEL, TS)).toBe('duplicate')
    }
    await clock.advanceTo(INBOUND_DEDUPE_RETENTION_MS)
    expect(store.record(CHANNEL, TS)).toBe('new')
  })

  test('a key re-recorded after expiry gets a fresh window from its new first sighting', async () => {
    const { clock, store } = makeStore()
    store.record(CHANNEL, TS)
    await clock.advanceTo(INBOUND_DEDUPE_RETENTION_MS)
    expect(store.record(CHANNEL, TS)).toBe('new')
    await clock.advanceTo(2 * INBOUND_DEDUPE_RETENTION_MS - 1)
    expect(store.record(CHANNEL, TS)).toBe('duplicate')
    await clock.advanceTo(2 * INBOUND_DEDUPE_RETENTION_MS)
    expect(store.record(CHANNEL, TS)).toBe('new')
  })
})

describe('inbound dedupe: per-persona instances', () => {
  test('a key recorded in one store is new in another, and each store keeps its own duplicates', () => {
    const clock = createFakeClock()
    const a = createInboundDedupeStore(clock.now)
    const b = createInboundDedupeStore(clock.now)
    expect(a.record(CHANNEL, TS)).toBe('new')
    expect(b.size).toBe(0)
    expect(b.record(CHANNEL, TS)).toBe('new')
    expect(a.record(CHANNEL, TS)).toBe('duplicate')
    expect(b.record(CHANNEL, TS)).toBe('duplicate')
    expect(a.size).toBe(1)
    expect(b.size).toBe(1)
  })

  test("each store reads its own clock: one store's expiry leaves the other's key a duplicate", async () => {
    const early = createFakeClock()
    const late = createFakeClock()
    const a = createInboundDedupeStore(early.now)
    const b = createInboundDedupeStore(late.now)
    a.record(CHANNEL, TS)
    b.record(CHANNEL, TS)
    await early.advanceTo(INBOUND_DEDUPE_RETENTION_MS)
    expect(a.record(CHANNEL, TS)).toBe('new')
    expect(b.record(CHANNEL, TS)).toBe('duplicate')
  })
})

describe('inbound dedupe: no count or rate state (SR-4.2)', () => {
  test('20 distinct keys at the same instant are all new, and each repeats as a duplicate', () => {
    const { store } = makeStore()
    const keys = Array.from({ length: 20 }, (_, i) => `1700000000.${String(i).padStart(6, '0')}`)
    expect(keys.map((ts) => store.record(CHANNEL, ts))).toEqual(keys.map(() => 'new'))
    expect(store.size).toBe(20)
    expect(keys.map((ts) => store.record(CHANNEL, ts))).toEqual(keys.map(() => 'duplicate'))
  })

  test('a burst of 1000 distinct keys at the same instant is all new', () => {
    const { store } = makeStore()
    const outcomes = Array.from({ length: 1000 }, (_, i) => store.record(`C0BURST${i % 7}`, `1700000000.${i}`))
    expect(outcomes).toEqual(Array(1000).fill('new'))
    expect(store.size).toBe(1000)
  })
})

describe('inbound dedupe: lazy pruning', () => {
  test('expired keys leave the store on the next record, and unexpired keys stay', async () => {
    const { clock, store } = makeStore()
    store.record(CHANNEL, 'ts-0')
    await clock.advanceTo(60_000)
    store.record(CHANNEL, 'ts-1')
    expect(store.size).toBe(2)

    // ts-0 has expired; ts-1 has 1 minute left.
    await clock.advanceTo(INBOUND_DEDUPE_RETENTION_MS)
    expect(store.record(CHANNEL, 'ts-2')).toBe('new')
    expect(store.size).toBe(2)
    expect(store.record(CHANNEL, 'ts-1')).toBe('duplicate')

    // Both remaining keys expire; a repeat of ts-2 is new again.
    await clock.advanceTo(2 * INBOUND_DEDUPE_RETENTION_MS)
    expect(store.record(CHANNEL, 'ts-2')).toBe('new')
    expect(store.size).toBe(1)
  })

  test('a duplicate sighting also prunes the expired keys ahead of it', async () => {
    const { clock, store } = makeStore()
    for (let i = 0; i < 5; i++) store.record(CHANNEL, `old-${i}`)
    await clock.advanceTo(INBOUND_DEDUPE_RETENTION_MS - 1)
    store.record(CHANNEL, 'young')
    await clock.advanceTo(INBOUND_DEDUPE_RETENTION_MS)
    expect(store.size).toBe(6)
    expect(store.record(CHANNEL, 'young')).toBe('duplicate')
    expect(store.size).toBe(1)
  })
})

describe('inbound dedupe: unkeyable events', () => {
  test.each([
    ['conversation missing', undefined, TS],
    ['ts missing', CHANNEL, undefined],
    ['both missing', undefined, undefined],
    ['conversation null', null, TS],
    ['ts empty', CHANNEL, ''],
    ['conversation empty', '', TS],
    ['ts a number', CHANNEL, 1700000000.0001],
    ['conversation an object', { id: CHANNEL }, TS],
  ])('%s: unkeyable every time, nothing recorded', (_label, conversation, ts) => {
    const { store } = makeStore()
    expect(store.record(conversation, ts)).toBe('unkeyable')
    expect(store.record(conversation, ts)).toBe('unkeyable')
    expect(store.size).toBe(0)
  })

  test('a keyed event after unkeyable ones is unaffected, including one whose values are the strings "undefined"', () => {
    const { store } = makeStore()
    store.record(undefined, undefined)
    store.record(CHANNEL, undefined)
    store.record(undefined, TS)
    expect(store.record(CHANNEL, TS)).toBe('new')
    expect(store.record('undefined', 'undefined')).toBe('new')
    expect(store.record(CHANNEL, 'undefined')).toBe('new')
    expect(store.record('undefined', TS)).toBe('new')
    expect(store.size).toBe(4)
  })
})
