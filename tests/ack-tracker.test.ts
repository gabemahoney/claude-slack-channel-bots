/**
 * ack-tracker.test.ts — Tests for the ack-tracker module (Task t3.xrm.9d.ap.2h)
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, jest } from 'bun:test'
import { trackAck, consumeAck, _resetAckTracker } from '../src/ack-tracker.ts'

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
    trackAck('C_TEST', '1234567890.000100')

    const result = consumeAck('C_TEST', '1234567890.000100')

    expect(result).toBe(true)
  })

  test('second consumeAck on the same entry returns false', () => {
    trackAck('C_TEST', '1234567890.000200')
    consumeAck('C_TEST', '1234567890.000200')

    const result = consumeAck('C_TEST', '1234567890.000200')

    expect(result).toBe(false)
  })

  test('consumeAck on an untracked message returns false', () => {
    const result = consumeAck('C_TEST', 'never-tracked.000300')

    expect(result).toBe(false)
  })

  test('entries from a different channel are independent', () => {
    trackAck('C_ALPHA', '1234567890.000400')

    expect(consumeAck('C_BETA', '1234567890.000400')).toBe(false)
    expect(consumeAck('C_ALPHA', '1234567890.000400')).toBe(true)
  })
})

describe('pruning expired entries', () => {
  test('entries older than 30 days are pruned on the next trackAck call', () => {
    const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000

    // Track an ack at the current time
    trackAck('C_TEST', '1234567890.000500')

    // Advance the clock past the 30-day expiry window
    jest.setSystemTime(Date.now() + thirtyOneDaysMs)

    // Trigger pruning via a new trackAck call
    trackAck('C_TEST', '1234567890.000600')

    // The old entry should have been pruned
    expect(consumeAck('C_TEST', '1234567890.000500')).toBe(false)

    // The new entry should still be present
    expect(consumeAck('C_TEST', '1234567890.000600')).toBe(true)

    // Restore system time so parallel tests aren't affected
    jest.setSystemTime()
  })
})

describe('_resetAckTracker', () => {
  test('_resetAckTracker clears all entries', () => {
    trackAck('C_ALPHA', '1234567890.000700')
    trackAck('C_BETA', '1234567890.000800')

    _resetAckTracker()

    expect(consumeAck('C_ALPHA', '1234567890.000700')).toBe(false)
    expect(consumeAck('C_BETA', '1234567890.000800')).toBe(false)
  })
})
