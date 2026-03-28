/**
 * restart.test.ts — Tests for auto-restart scheduling logic.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  initRestart,
  scheduleRestart,
  resetFailureCounter,
  cancelAllRestartTimers,
  _resetRestartState,
  type RestartDeps,
  MAX_CONSECUTIVE_FAILURES,
} from './restart.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_DELAY_S = 0.01  // 10 ms timer — fast enough for tests
const WAIT_MS = 50         // wait after scheduling; long enough for FAST_DELAY_S to fire

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type DepsOpts = {
  isSessionAliveResult?: boolean  // default: false (session is dead)
  launchSessionResult?: boolean   // default: true (launch succeeds)
  restartDelay?: number           // default: FAST_DELAY_S
  isShuttingDown?: boolean        // default: false
}

function makeDeps(opts: DepsOpts = {}): RestartDeps & {
  isSessionAliveCalls: string[]
  killSessionCalls: string[]
  launchSessionCalls: Array<{ channelId: string; cwd: string }>
} {
  const isSessionAliveCalls: string[] = []
  const killSessionCalls: string[] = []
  const launchSessionCalls: Array<{ channelId: string; cwd: string }> = []

  return {
    isSessionAliveCalls,
    killSessionCalls,
    launchSessionCalls,

    async isSessionAlive(channelId) {
      isSessionAliveCalls.push(channelId)
      return opts.isSessionAliveResult ?? false
    },
    async killSession(channelId) {
      killSessionCalls.push(channelId)
    },
    async launchSession(channelId, cwd) {
      launchSessionCalls.push({ channelId, cwd })
      return opts.launchSessionResult ?? true
    },
    getRestartDelay: () => opts.restartDelay ?? FAST_DELAY_S,
    isShuttingDown: () => opts.isShuttingDown ?? false,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRestartState()
})

// ---------------------------------------------------------------------------
// scheduleRestart
// ---------------------------------------------------------------------------

describe('scheduleRestart', () => {
  test('1. delay > 0 — timer fires, launchSession called with correct args', async () => {
    const deps = makeDeps()
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].channelId).toBe('C_TEST1')
    expect(deps.launchSessionCalls[0].cwd).toBe('/cwd/test')
  })

  test('2. delay = 0 — no timer scheduled, launchSession never called', async () => {
    const deps = makeDeps({ restartDelay: 0 })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(0)
  })

  test('3. timer fires, session already alive — launchSession NOT called', async () => {
    const deps = makeDeps({ isSessionAliveResult: true })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toHaveLength(1)
    expect(deps.launchSessionCalls).toHaveLength(0)
  })

  test('4. timer fires, session dead — killSession then launchSession called', async () => {
    const deps = makeDeps({ isSessionAliveResult: false })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.killSessionCalls).toHaveLength(1)
    expect(deps.killSessionCalls[0]).toBe('C_TEST1')
    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].channelId).toBe('C_TEST1')
  })

  test('5. 3 consecutive launch failures — scheduleRestart on 4th death skips timer', async () => {
    const deps = makeDeps({ launchSessionResult: false })
    initRestart(deps)

    // Drive MAX_CONSECUTIVE_FAILURES failures
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      scheduleRestart('C_TEST1', '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }
    expect(deps.launchSessionCalls).toHaveLength(MAX_CONSECUTIVE_FAILURES)

    // 4th death: failure count is now >= MAX, timer must NOT be scheduled
    const callsBefore = deps.launchSessionCalls.length
    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls.length).toBe(callsBefore)
  })

  test('6. resetFailureCounter between failures — counter resets, next death schedules timer normally', async () => {
    const deps = makeDeps({ launchSessionResult: false })
    initRestart(deps)

    // Drive MAX_CONSECUTIVE_FAILURES failures
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      scheduleRestart('C_TEST1', '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }

    // Confirm 4th is blocked
    const callsBeforeReset = deps.launchSessionCalls.length
    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(deps.launchSessionCalls.length).toBe(callsBeforeReset)

    // Reset counter — next restart should succeed
    resetFailureCounter('C_TEST1')
    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls.length).toBe(callsBeforeReset + 1)
  })

  test('7. failure counter does NOT increment on session death — only on failed launchSession', async () => {
    // launchSession always succeeds — failure counter must never accumulate
    const deps = makeDeps({ launchSessionResult: true })
    initRestart(deps)

    // Call scheduleRestart more times than MAX_CONSECUTIVE_FAILURES allows
    const iterations = MAX_CONSECUTIVE_FAILURES + 1
    for (let i = 0; i < iterations; i++) {
      scheduleRestart('C_TEST1', '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }

    // Every death should have produced a launchSession call
    expect(deps.launchSessionCalls.length).toBe(iterations)
  })
})

// ---------------------------------------------------------------------------
// cancelAllRestartTimers
// ---------------------------------------------------------------------------

describe('cancelAllRestartTimers', () => {
  test('8. clears all pending timers — launchSession never called after cancel', async () => {
    const deps = makeDeps() // FAST_DELAY_S = 10 ms
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/one')
    scheduleRestart('C_TEST2', '/cwd/two')

    // Cancel synchronously before the 10 ms timers can fire
    cancelAllRestartTimers()

    // Wait longer than the timer delay to confirm they did not fire
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(0)
  })
})
