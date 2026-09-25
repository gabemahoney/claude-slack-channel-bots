/**
 * backoff.test.ts — Pure-module tests for src/backoff.ts (SR-29.3).
 *
 * All assertions are deterministic: no sleeps, no timers, no mock.module.
 * Delay assertions use getFailureCount/nextBackoffDelay directly.
 * Base delay sourced from makePersonaConfig, not literals.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  recordFailure,
  recordSuccess,
  forgetFailures,
  getFailureCount,
  nextBackoffDelay,
  doublingBackoffDelay,
  isAtCap,
  shouldNotifyCap,
  _resetBackoffState,
} from '../src/backoff.ts'
import { makePersonaConfig } from './test-helpers/persona-config.ts'

// ---------------------------------------------------------------------------
// Constants — base sourced from makePersonaConfig, not literals
// ---------------------------------------------------------------------------

const config = makePersonaConfig()
const BASE_S = config.session_restart_delay  // 60 s per persona-config.ts default

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetBackoffState()
})

// ---------------------------------------------------------------------------
// getFailureCount — default 0
// ---------------------------------------------------------------------------

describe('getFailureCount', () => {
  test('returns 0 for a channel with no recorded failures', () => {
    expect(getFailureCount('C_NEW')).toBe(0)
  })

  test('returns 0 for different channel after another channel fails', () => {
    recordFailure('C_A')
    expect(getFailureCount('C_B')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// recordFailure / recordSuccess — basic counter semantics
// ---------------------------------------------------------------------------

describe('recordFailure', () => {
  test('increments counter from 0 to 1 and returns new count', () => {
    const count = recordFailure('C1')
    expect(count).toBe(1)
    expect(getFailureCount('C1')).toBe(1)
  })

  test('increments monotonically on repeated calls', () => {
    recordFailure('C1')
    recordFailure('C1')
    const count = recordFailure('C1')
    expect(count).toBe(3)
    expect(getFailureCount('C1')).toBe(3)
  })
})

describe('recordSuccess', () => {
  test('resets failure count to 0', () => {
    recordFailure('C1')
    recordFailure('C1')
    recordSuccess('C1')
    expect(getFailureCount('C1')).toBe(0)
  })

  test('calling on a channel with no failures is a no-op', () => {
    recordSuccess('C_CLEAN')
    expect(getFailureCount('C_CLEAN')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// nextBackoffDelay — ladder from makePersonaConfig base
//
// Formula: min(base * 2^preFailureCount, 900)
// preFailureCount = getFailureCount(channelId) at the time of the call.
//
// Ladder for base=60, preCount 0..5:
//   0 →  60s     (60 * 2^0 = 60)
//   1 → 120s     (60 * 2^1 = 120)
//   2 → 240s     (60 * 2^2 = 240)
//   3 → 480s     (60 * 2^3 = 480)
//   4 → 900s     (60 * 2^4 = 960 → clamped)
//   5 → 900s     (60 * 2^5 = 1920 → clamped)
// ---------------------------------------------------------------------------

describe('nextBackoffDelay — exponential ladder (base from makePersonaConfig)', () => {
  // Table columns: [base, preCount, expected]. Two bases prove the formula is
  // parametric (not hard-coded to the default): BASE_S (60) from makePersonaConfig
  // and a non-default 30. Each row records `preCount` failures, then asserts the
  // next delay = min(base * 2^preCount, 900).
  test.each([
    // default base (60): 60·2^n, clamped at 900
    [BASE_S, 0, BASE_S],       // 60
    [BASE_S, 1, BASE_S * 2],   // 120
    [BASE_S, 2, BASE_S * 4],   // 240
    [BASE_S, 3, BASE_S * 8],   // 480
    [BASE_S, 4, 900],          // 960 → clamped
    [BASE_S, 5, 900],          // 1920 → clamped
    // non-default base (30): 30·2^n, clamped at 900
    [30, 0, 30],
    [30, 1, 60],
    [30, 2, 120],
    [30, 3, 240],
    [30, 4, 480],
    [30, 5, 900],              // 960 → clamped
  ])('base=%p, preCount=%p → %p', (base, preCount, expected) => {
    for (let i = 0; i < preCount; i++) recordFailure('C1')
    expect(nextBackoffDelay('C1', base)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// doublingBackoffDelay — pure, stateless arithmetic
//
// Formula: min(base * 2^priorAttempts, ceiling). The ceiling is a parameter,
// not the restart ladder's fixed 900. Slack retry-schedule rows (SR-3.2) are
// covered by the retry-schedule tests, not here.
// ---------------------------------------------------------------------------

describe('doublingBackoffDelay — doubling per prior attempt, clamped to ceiling', () => {
  // Table columns: [base, priorAttempts, ceiling, expected]. Two ceilings
  // (900 and 300) prove the clamp is the argument, not a hard-coded constant.
  test.each([
    // ceiling 900, base BASE_S (60): same ladder as nextBackoffDelay
    [BASE_S, 0, 900, BASE_S],        // 60
    [BASE_S, 3, 900, BASE_S * 8],    // 480
    [BASE_S, 4, 900, 900],           // 960 → clamped
    // ceiling 300, base 7: 7·2^n, clamped at 300
    [7, 0, 300, 7],
    [7, 1, 300, 14],
    [7, 5, 300, 224],
    [7, 6, 300, 300],                // 448 → clamped
    // exactly at the ceiling is returned as-is
    [75, 2, 300, 300],               // 300
    // very large count: 2^10000 overflows, result is still the ceiling
    [BASE_S, 10_000, 900, 900],
    [7, 10_000, 300, 300],
  ])('base=%p, priorAttempts=%p, ceiling=%p → %p', (base, priorAttempts, ceiling, expected) => {
    const delay = doublingBackoffDelay(base, priorAttempts, ceiling)
    expect(delay).toBe(expected)
    expect(Number.isFinite(delay)).toBe(true)
  })

  test('does not read or change the per-channel counters', () => {
    recordFailure('C1')
    expect(doublingBackoffDelay(BASE_S, 0, 900)).toBe(BASE_S)
    expect(getFailureCount('C1')).toBe(1)
    expect(nextBackoffDelay('C1', BASE_S)).toBe(BASE_S * 2)
  })
})

// ---------------------------------------------------------------------------
// isAtCap
// ---------------------------------------------------------------------------

describe('isAtCap', () => {
  const CAP = 5

  // Table columns: [failures, expected]. isAtCap is true iff count >= CAP.
  test.each([
    [0, false],        // below cap
    [CAP - 1, false],  // one below cap
    [CAP, true],       // at cap
    [CAP + 2, true],   // above cap
  ])('%p failures → isAtCap=%p', (failures, expected) => {
    for (let i = 0; i < failures; i++) recordFailure('C1')
    expect(isAtCap('C1', CAP)).toBe(expected)
  })

  test('returns false after recordSuccess resets count', () => {
    for (let i = 0; i < CAP; i++) recordFailure('C1')
    expect(isAtCap('C1', CAP)).toBe(true)
    recordSuccess('C1')
    expect(isAtCap('C1', CAP)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// shouldNotifyCap — fires once per episode, re-arms after recordSuccess
// ---------------------------------------------------------------------------

describe('shouldNotifyCap — once-per-episode latch', () => {
  const CAP = 5

  test('returns false when count is below cap', () => {
    for (let i = 0; i < CAP - 1; i++) recordFailure('C1')
    expect(shouldNotifyCap('C1', CAP)).toBe(false)
  })

  test('returns true exactly once when cap is reached (first call)', () => {
    for (let i = 0; i < CAP; i++) recordFailure('C1')
    expect(shouldNotifyCap('C1', CAP)).toBe(true)
  })

  test('returns false on subsequent calls within the same episode (latch)', () => {
    for (let i = 0; i < CAP; i++) recordFailure('C1')
    shouldNotifyCap('C1', CAP)  // fires once (latch set)
    expect(shouldNotifyCap('C1', CAP)).toBe(false)
    expect(shouldNotifyCap('C1', CAP)).toBe(false)
  })

  test('re-arms after recordSuccess + re-accumulation', () => {
    // Episode 1
    for (let i = 0; i < CAP; i++) recordFailure('C1')
    expect(shouldNotifyCap('C1', CAP)).toBe(true)   // latch set
    expect(shouldNotifyCap('C1', CAP)).toBe(false)  // latched

    // Recovery
    recordSuccess('C1')

    // Episode 2 — latch is cleared; accumulate again
    for (let i = 0; i < CAP; i++) recordFailure('C1')
    expect(shouldNotifyCap('C1', CAP)).toBe(true)   // re-arms
    expect(shouldNotifyCap('C1', CAP)).toBe(false)  // latched again
  })

  test('latch is per-channel: one channel latched does not affect another', () => {
    for (let i = 0; i < CAP; i++) recordFailure('C1')
    shouldNotifyCap('C1', CAP)  // C1 latched

    for (let i = 0; i < CAP; i++) recordFailure('C2')
    expect(shouldNotifyCap('C2', CAP)).toBe(true)  // C2 fires independently
  })
})

// ---------------------------------------------------------------------------
// Per-channel isolation
// ---------------------------------------------------------------------------

describe('per-channel isolation', () => {
  test('failure counts for different channels are independent', () => {
    recordFailure('C_A')
    recordFailure('C_A')
    recordFailure('C_B')
    expect(getFailureCount('C_A')).toBe(2)
    expect(getFailureCount('C_B')).toBe(1)
  })

  test('recordSuccess on one channel does not affect another', () => {
    recordFailure('C_A')
    recordFailure('C_B')
    recordSuccess('C_A')
    expect(getFailureCount('C_A')).toBe(0)
    expect(getFailureCount('C_B')).toBe(1)
  })

  test('nextBackoffDelay uses per-channel counter independently', () => {
    recordFailure('C_A')  // C_A: preCount=1 → base*2
    // C_B still at preCount=0 → base*1
    expect(nextBackoffDelay('C_A', BASE_S)).toBe(BASE_S * 2)
    expect(nextBackoffDelay('C_B', BASE_S)).toBe(BASE_S)
  })
})

// ---------------------------------------------------------------------------
// forgetFailures — per-persona forget at a teardown (b.av2 SR-6.5)
// ---------------------------------------------------------------------------

describe('forgetFailures — per-persona forget (b.av2 SR-6.5)', () => {
  const CAP = 5

  /** Run `fn` with console.error/log/warn recorded; returns every line. */
  function captureConsole(fn: () => void): string[] {
    const lines: string[] = []
    const saved = { error: console.error, log: console.log, warn: console.warn }
    const rec = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')) }
    console.error = rec
    console.log = rec
    console.warn = rec
    try { fn() } finally { Object.assign(console, saved) }
    return lines
  }

  test('forgetting B clears its count and cap latch silently; A keeps its count, latch and delay', () => {
    for (let i = 0; i < CAP; i++) recordFailure('A')
    expect(shouldNotifyCap('A', CAP)).toBe(true)  // A latched
    for (let i = 0; i < CAP; i++) recordFailure('B')
    expect(shouldNotifyCap('B', CAP)).toBe(true)  // B latched

    const lines = captureConsole(() => forgetFailures('B'))

    expect(lines).toEqual([])
    expect(getFailureCount('B')).toBe(0)
    expect(isAtCap('B', CAP)).toBe(false)
    expect(nextBackoffDelay('B', BASE_S)).toBe(BASE_S)
    expect(getFailureCount('A')).toBe(CAP)
    expect(nextBackoffDelay('A', BASE_S)).toBe(900)
    expect(shouldNotifyCap('A', CAP)).toBe(false)  // A still latched

    // A later cap episode for B notifies once, as for a fresh key.
    for (let i = 0; i < CAP; i++) recordFailure('B')
    expect(shouldNotifyCap('B', CAP)).toBe(true)
    expect(shouldNotifyCap('B', CAP)).toBe(false)
  })

  test('forgetting an unknown key is a no-op', () => {
    recordFailure('A')
    recordFailure('A')
    const lines = captureConsole(() => forgetFailures('NEVER_SEEN'))
    expect(lines).toEqual([])
    expect(getFailureCount('NEVER_SEEN')).toBe(0)
    expect(getFailureCount('A')).toBe(2)
    expect(nextBackoffDelay('A', BASE_S)).toBe(BASE_S * 4)
  })
})
