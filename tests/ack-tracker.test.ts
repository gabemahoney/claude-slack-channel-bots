/**
 * ack-tracker.test.ts — Tests for the ack-tracker module (Task t3.xrm.9d.ap.2h;
 * persona-keyed entries, Task t3.ob2.gg.fa.k8)
 *
 * Entries are keyed by (persona key, conversation ID, message ts) (b.av2
 * SR-4.5); only an exact match consumes one. The per-key forget drops one
 * persona's entries at its teardown (b.av2 SR-6.5).
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, jest, spyOn } from 'bun:test'
import { trackAck, consumeAck, forgetPersonaAcks, _resetAckTracker } from '../src/ack-tracker.ts'

type Triple = [personaKey: string, channelId: string, messageTs: string]

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

describe('only an exact (persona, conversation, ts) match consumes (b.av2 SR-4.5)', () => {
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

describe('forgetPersonaAcks — per-persona forget at teardown (b.av2 SR-6.5)', () => {
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
