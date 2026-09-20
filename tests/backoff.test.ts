/**
 * backoff.test.ts — Pure-module tests for src/backoff.ts (SR-29.3).
 *
 * All assertions are deterministic: no sleeps, no timers, no mock.module.
 * Delay assertions use getFailureCount/nextBackoffDelay directly.
 * Base delay sourced from makeRoutingConfig, not literals.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  recordFailure,
  recordSuccess,
  getFailureCount,
  nextBackoffDelay,
  isAtCap,
  shouldNotifyCap,
  _resetBackoffState,
} from '../src/backoff.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'

// ---------------------------------------------------------------------------
// Constants — base sourced from makeRoutingConfig, not literals
// ---------------------------------------------------------------------------

const config = makeRoutingConfig()
const BASE_S = config.session_restart_delay  // 60 s per routing-config.ts default

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
// nextBackoffDelay — ladder from makeRoutingConfig base
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

describe('nextBackoffDelay — exponential ladder (base from makeRoutingConfig)', () => {
  // Table columns: [base, preCount, expected]. Two bases prove the formula is
  // parametric (not hard-coded to the default): BASE_S (60) from makeRoutingConfig
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
