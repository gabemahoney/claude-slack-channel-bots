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
  isRestartPendingOrActive,
  hasReachedMaxFailures,
  type RestartDeps,
  MAX_CONSECUTIVE_FAILURES,
} from '../src/restart.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_DELAY_S = 0.01  // 10 ms timer — fast enough for tests
const SLOW_DELAY_S = 9999  // large enough to never fire during a test
const WAIT_MS = 50         // wait after scheduling; long enough for FAST_DELAY_S to fire

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type DepsOpts = {
  isSessionAliveResult?: boolean  // default: false (session is dead)
  launchSessionResult?: boolean   // default: true (launch succeeds)
  launchSession?: (channelId: string, cwd: string, sessionId?: string) => Promise<boolean>  // override entire launchSession
  restartDelay?: number           // default: FAST_DELAY_S
  isShuttingDown?: boolean        // default: false
}

function makeDeps(opts: DepsOpts = {}): RestartDeps & {
  isSessionAliveCalls: string[]
  killSessionCalls: string[]
  launchSessionCalls: Array<{ channelId: string; cwd: string; sessionId: string | undefined }>
} {
  const isSessionAliveCalls: string[] = []
  const killSessionCalls: string[] = []
  const launchSessionCalls: Array<{ channelId: string; cwd: string; sessionId: string | undefined }> = []

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
    async launchSession(channelId, cwd, sessionId) {
      launchSessionCalls.push({ channelId, cwd, sessionId })
      if (opts.launchSession) return opts.launchSession(channelId, cwd, sessionId)
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

  test('timer fires but isShuttingDown=true — launchSession never called', async () => {
    const deps = makeDeps({ isShuttingDown: true })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

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

  test('8. restart with stored session ID — launchSession receives session ID argument', async () => {
    const deps = makeDeps()
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test', 'saved-session-123')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].channelId).toBe('C_TEST1')
    expect(deps.launchSessionCalls[0].cwd).toBe('/cwd/test')
    expect(deps.launchSessionCalls[0].sessionId).toBe('saved-session-123')
  })

  test('9. restart without stored session ID — launchSession called without session ID', async () => {
    const deps = makeDeps()
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].sessionId).toBeUndefined()
  })

  test('10. launchSession succeeds with session ID — failure counter not incremented', async () => {
    const deps = makeDeps({ launchSessionResult: true })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test', 'saved-session-123')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].sessionId).toBe('saved-session-123')
    expect(hasReachedMaxFailures('C_TEST1')).toBe(false)
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

// ---------------------------------------------------------------------------
// isRestartPendingOrActive
// ---------------------------------------------------------------------------

describe('isRestartPendingOrActive', () => {
  test('returns false for channel with no timer and no active launch', () => {
    expect(isRestartPendingOrActive('C_TEST1')).toBe(false)
  })

  test('returns true after scheduleRestart is called (timer pending, not yet fired)', () => {
    const deps = makeDeps({ restartDelay: SLOW_DELAY_S })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')

    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)
  })

  test('returns true while launchSession is in progress', async () => {
    let launchResolve!: (ok: boolean) => void
    const launchPromise = new Promise<boolean>((res) => { launchResolve = res })

    const deps = makeDeps({ launchSession: () => launchPromise })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS) // timer has fired; launchSession is now awaiting

    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)

    launchResolve(true)
    await Bun.sleep(1) // let finally block run
  })

  test('returns false after launchSession completes successfully', async () => {
    let launchResolve!: (ok: boolean) => void
    const launchPromise = new Promise<boolean>((res) => { launchResolve = res })

    const deps = makeDeps({ launchSession: () => launchPromise })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    launchResolve(true)
    await Bun.sleep(1)

    expect(isRestartPendingOrActive('C_TEST1')).toBe(false)
  })

  test('returns false after launchSession completes with failure', async () => {
    let launchResolve!: (ok: boolean) => void
    const launchPromise = new Promise<boolean>((res) => { launchResolve = res })

    const deps = makeDeps({ launchSession: () => launchPromise })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    launchResolve(false)
    await Bun.sleep(1)

    expect(isRestartPendingOrActive('C_TEST1')).toBe(false)
  })

  test('returns false for different channel while another has restart in progress', async () => {
    let launchResolve!: (ok: boolean) => void
    const launchPromise = new Promise<boolean>((res) => { launchResolve = res })

    const deps = makeDeps({ launchSession: () => launchPromise })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)
    expect(isRestartPendingOrActive('C_TEST2')).toBe(false)

    launchResolve(true)
    await Bun.sleep(1)
  })

  test('returns false after cancelAllRestartTimers clears pending timer', () => {
    const deps = makeDeps({ restartDelay: SLOW_DELAY_S })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)

    cancelAllRestartTimers()

    expect(isRestartPendingOrActive('C_TEST1')).toBe(false)
  })

  test('regression b.2ir: returns true while isSessionAlive is pending (race window between pendingRestartTimers.delete and activeLaunches.add is closed)', async () => {
    // Before the fix, activeLaunches.add happened after pendingRestartTimers.delete
    // but before the first await (isSessionAlive). During that gap,
    // isRestartPendingOrActive returned false even though a restart was in progress.
    // The fix moves activeLaunches.add immediately after pendingRestartTimers.delete.
    let aliveResolve!: (alive: boolean) => void
    const alivePromise = new Promise<boolean>((res) => { aliveResolve = res })

    const deps: RestartDeps = {
      isSessionAlive: (_channelId) => alivePromise,  // never resolves until we say so
      killSession: async () => {},
      launchSession: async () => true,
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
    }
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS) // timer has fired; isSessionAlive is now awaiting

    // pendingRestartTimers no longer has C_TEST1 (timer removed itself),
    // so the only thing keeping isRestartPendingOrActive true is activeLaunches.
    // Before the fix this returned false; after the fix it must return true.
    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)

    aliveResolve(false) // avoid dangling promise
    await Bun.sleep(1)  // let finally block run
  })
})

// ---------------------------------------------------------------------------
// hasReachedMaxFailures
// ---------------------------------------------------------------------------

describe('hasReachedMaxFailures', () => {
  test('returns false for channel with no recorded failures', () => {
    expect(hasReachedMaxFailures('C_TEST1')).toBe(false)
  })

  test('returns false after fewer than MAX_CONSECUTIVE_FAILURES failures', async () => {
    const deps = makeDeps({ launchSessionResult: false })
    initRestart(deps)

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) {
      scheduleRestart('C_TEST1', '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }

    expect(hasReachedMaxFailures('C_TEST1')).toBe(false)
  })

  test('returns true after exactly MAX_CONSECUTIVE_FAILURES failures', async () => {
    const deps = makeDeps({ launchSessionResult: false })
    initRestart(deps)

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      scheduleRestart('C_TEST1', '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }

    expect(hasReachedMaxFailures('C_TEST1')).toBe(true)
  })

  test('returns false after resetFailureCounter is called', async () => {
    const deps = makeDeps({ launchSessionResult: false })
    initRestart(deps)

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      scheduleRestart('C_TEST1', '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }
    expect(hasReachedMaxFailures('C_TEST1')).toBe(true)

    resetFailureCounter('C_TEST1')

    expect(hasReachedMaxFailures('C_TEST1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// _resetRestartState
// ---------------------------------------------------------------------------

describe('_resetRestartState', () => {
  test('clears activeLaunches — isRestartPendingOrActive returns false after reset', async () => {
    let launchResolve!: (ok: boolean) => void
    const launchPromise = new Promise<boolean>((res) => { launchResolve = res })

    const deps = makeDeps({ launchSession: () => launchPromise })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS) // launch is now in progress

    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)

    _resetRestartState()

    expect(isRestartPendingOrActive('C_TEST1')).toBe(false)

    launchResolve(true) // resolve to avoid dangling promise
  })
})
