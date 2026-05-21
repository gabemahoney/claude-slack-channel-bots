/**
 * restart.test.ts — Tests for auto-restart scheduling logic.
 *
 * Drives restart behavior through a spawnForRoute spy (not tmux-based mocks).
 * The RestartDeps.launchSession slot is wired to this spy; all other deps
 * (isSessionAlive, reconnectSession, killSession, isShuttingDown) remain
 * individually injectable for targeted behavioral tests.
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
import { ClaudeDirectorStub, makeSpawnRow } from './test-helpers/claude-director-stub.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_DELAY_S = 0.01  // 10 ms timer — fast enough for tests
const SLOW_DELAY_S = 9999  // large enough to never fire during a test
const WAIT_MS = 50         // wait after scheduling; long enough for FAST_DELAY_S to fire

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type SpawnForRouteCall = {
  channelId: string
  cwd: string
}

type DepsOpts = {
  isSessionAliveResult?: boolean       // default: false (session is dead)
  isSessionConnectedResult?: boolean   // default: false (not yet reconnected)
  spawnForRouteResult?: boolean        // default: true (spawn succeeds)
  spawnForRoute?: (channelId: string, cwd: string) => Promise<boolean>  // override entire spy
  restartDelay?: number                // default: FAST_DELAY_S
  isShuttingDown?: boolean             // default: false
}

function makeDeps(opts: DepsOpts = {}): RestartDeps & {
  isSessionAliveCalls: string[]
  killSessionCalls: string[]
  spawnForRouteCalls: SpawnForRouteCall[]
  reconnectSessionCalls: string[]
} {
  const routingConfig = makeRoutingConfig()

  const isSessionAliveCalls: string[] = []
  const killSessionCalls: string[] = []
  const spawnForRouteCalls: SpawnForRouteCall[] = []
  const reconnectSessionCalls: string[] = []

  return {
    isSessionAliveCalls,
    killSessionCalls,
    spawnForRouteCalls,
    reconnectSessionCalls,

    async isSessionAlive(channelId) {
      isSessionAliveCalls.push(channelId)
      return opts.isSessionAliveResult ?? false
    },
    isSessionConnected(_channelId) {
      return opts.isSessionConnectedResult ?? false
    },
    async reconnectSession(channelId) {
      reconnectSessionCalls.push(channelId)
    },
    async killSession(channelId) {
      killSessionCalls.push(channelId)
    },
    async launchSession(channelId, cwd) {
      const route = routingConfig.routes[channelId]
      const effectiveCwd = route?.cwd ?? cwd
      spawnForRouteCalls.push({ channelId, cwd: effectiveCwd })
      if (opts.spawnForRoute) return opts.spawnForRoute(channelId, effectiveCwd)
      return opts.spawnForRouteResult ?? true
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
  test('delay > 0 — timer fires, spawnForRoute called with correct args', async () => {
    const deps = makeDeps()
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.spawnForRouteCalls).toHaveLength(1)
    expect(deps.spawnForRouteCalls[0].channelId).toBe('C_TEST1')
  })

  test('delay = 0 — no timer scheduled, spawnForRoute never called', async () => {
    const deps = makeDeps({ restartDelay: 0 })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.spawnForRouteCalls).toHaveLength(0)
  })

  test('timer fires, session already alive — reconnectSession called, spawnForRoute NOT called', async () => {
    const deps = makeDeps({ isSessionAliveResult: true })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toHaveLength(1)
    expect(deps.reconnectSessionCalls).toHaveLength(1)
    expect(deps.reconnectSessionCalls[0]).toBe('C_TEST1')
    expect(deps.spawnForRouteCalls).toHaveLength(0)
  })

  test('session alive but reconnectSession throws — does not propagate, spawnForRoute NOT called', async () => {
    const deps = makeDeps({ isSessionAliveResult: true })
    let reconnectCalled = false
    deps.reconnectSession = async () => {
      reconnectCalled = true
      throw new Error('sendKeys failed')
    }
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(reconnectCalled).toBe(true)
    expect(deps.spawnForRouteCalls).toHaveLength(0)
  })

  test('timer fires but isShuttingDown=true — spawnForRoute never called', async () => {
    const deps = makeDeps({ isShuttingDown: true })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.spawnForRouteCalls).toHaveLength(0)
  })

  test('timer fires, session dead — killSession then spawnForRoute called', async () => {
    const deps = makeDeps({ isSessionAliveResult: false })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.killSessionCalls).toHaveLength(1)
    expect(deps.killSessionCalls[0]).toBe('C_TEST1')
    expect(deps.spawnForRouteCalls).toHaveLength(1)
    expect(deps.spawnForRouteCalls[0].channelId).toBe('C_TEST1')
  })

  test('3 consecutive launch failures — scheduleRestart on 4th death skips timer', async () => {
    const deps = makeDeps({ spawnForRouteResult: false })
    initRestart(deps)

    // Drive MAX_CONSECUTIVE_FAILURES failures
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      scheduleRestart('C_TEST1', '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }
    expect(deps.spawnForRouteCalls).toHaveLength(MAX_CONSECUTIVE_FAILURES)

    // 4th death: failure count is now >= MAX, timer must NOT be scheduled
    const callsBefore = deps.spawnForRouteCalls.length
    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.spawnForRouteCalls.length).toBe(callsBefore)
  })

  test('resetFailureCounter between failures — counter resets, next death schedules timer normally', async () => {
    const deps = makeDeps({ spawnForRouteResult: false })
    initRestart(deps)

    // Drive MAX_CONSECUTIVE_FAILURES failures
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      scheduleRestart('C_TEST1', '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }

    // Confirm 4th is blocked
    const callsBeforeReset = deps.spawnForRouteCalls.length
    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(deps.spawnForRouteCalls.length).toBe(callsBeforeReset)

    // Reset counter — next restart should succeed
    resetFailureCounter('C_TEST1')
    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.spawnForRouteCalls.length).toBe(callsBeforeReset + 1)
  })

  test('failure counter does NOT increment on success — scheduling continues past MAX', async () => {
    // spawnForRoute always succeeds — failure counter must never accumulate
    const deps = makeDeps({ spawnForRouteResult: true })
    initRestart(deps)

    // Call scheduleRestart more times than MAX_CONSECUTIVE_FAILURES allows
    const iterations = MAX_CONSECUTIVE_FAILURES + 1
    for (let i = 0; i < iterations; i++) {
      scheduleRestart('C_TEST1', '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }

    // Every death should have produced a spawnForRoute call
    expect(deps.spawnForRouteCalls.length).toBe(iterations)
  })

  test('delegation invariant — scheduleRestart never calls wrapper subcommands directly', async () => {
    // Install a real ClaudeDirectorStub to capture any CLI invocations.
    // spawnForRoute in the spy never reaches the wrapper — the stub should
    // record zero calls for spawn/resume/kill/delete after timer-fire.
    const stub = new ClaudeDirectorStub({
      spawnRows: [makeSpawnRow({ channelId: 'C_TEST1', state: 'waiting' })],
    })
    stub.install()

    const deps = makeDeps({ spawnForRouteResult: true })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // spawnForRoute spy was called (verifies timer fired)
    expect(deps.spawnForRouteCalls).toHaveLength(1)

    // The stub must have received zero CLI calls
    const spawnCalls = stub.calls.filter((c) => c.verb === 'spawn')
    const resumeCalls = stub.calls.filter((c) => c.verb === 'resume')
    const killCalls = stub.calls.filter((c) => c.verb === 'kill')
    const deleteCalls = stub.calls.filter((c) => c.verb === 'delete')

    expect(spawnCalls).toHaveLength(0)
    expect(resumeCalls).toHaveLength(0)
    expect(killCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)

    stub.uninstall()
  })
})

// ---------------------------------------------------------------------------
// cancelAllRestartTimers
// ---------------------------------------------------------------------------

describe('cancelAllRestartTimers', () => {
  test('clears all pending timers — spawnForRoute never called after cancel', async () => {
    const deps = makeDeps() // FAST_DELAY_S = 10 ms
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/one')
    scheduleRestart('C_TEST2', '/cwd/two')

    // Cancel synchronously before the 10 ms timers can fire
    cancelAllRestartTimers()

    // Wait longer than the timer delay to confirm they did not fire
    await Bun.sleep(WAIT_MS)

    expect(deps.spawnForRouteCalls).toHaveLength(0)
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

  test('returns true while spawnForRoute is in progress', async () => {
    let spawnResolve!: (ok: boolean) => void
    const spawnPromise = new Promise<boolean>((res) => { spawnResolve = res })

    const deps = makeDeps({ spawnForRoute: () => spawnPromise })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS) // timer has fired; launchSession (spawnForRoute) is now awaiting

    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)

    spawnResolve(true)
    await Bun.sleep(1) // let finally block run
  })

  test('returns false after spawnForRoute completes successfully', async () => {
    let spawnResolve!: (ok: boolean) => void
    const spawnPromise = new Promise<boolean>((res) => { spawnResolve = res })

    const deps = makeDeps({ spawnForRoute: () => spawnPromise })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    spawnResolve(true)
    await Bun.sleep(1)

    expect(isRestartPendingOrActive('C_TEST1')).toBe(false)
  })

  test('returns false after spawnForRoute completes with failure', async () => {
    let spawnResolve!: (ok: boolean) => void
    const spawnPromise = new Promise<boolean>((res) => { spawnResolve = res })

    const deps = makeDeps({ spawnForRoute: () => spawnPromise })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    spawnResolve(false)
    await Bun.sleep(1)

    expect(isRestartPendingOrActive('C_TEST1')).toBe(false)
  })

  test('returns false for different channel while another has restart in progress', async () => {
    let spawnResolve!: (ok: boolean) => void
    const spawnPromise = new Promise<boolean>((res) => { spawnResolve = res })

    const deps = makeDeps({ spawnForRoute: () => spawnPromise })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)
    expect(isRestartPendingOrActive('C_TEST2')).toBe(false)

    spawnResolve(true)
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
      isSessionConnected: () => false,
      reconnectSession: async () => {},
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
    const deps = makeDeps({ spawnForRouteResult: false })
    initRestart(deps)

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) {
      scheduleRestart('C_TEST1', '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }

    expect(hasReachedMaxFailures('C_TEST1')).toBe(false)
  })

  test('returns true after exactly MAX_CONSECUTIVE_FAILURES failures', async () => {
    const deps = makeDeps({ spawnForRouteResult: false })
    initRestart(deps)

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      scheduleRestart('C_TEST1', '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }

    expect(hasReachedMaxFailures('C_TEST1')).toBe(true)
  })

  test('returns false after resetFailureCounter is called', async () => {
    const deps = makeDeps({ spawnForRouteResult: false })
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
    let spawnResolve!: (ok: boolean) => void
    const spawnPromise = new Promise<boolean>((res) => { spawnResolve = res })

    const deps = makeDeps({ spawnForRoute: () => spawnPromise })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS) // launch is now in progress

    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)

    _resetRestartState()

    expect(isRestartPendingOrActive('C_TEST1')).toBe(false)

    spawnResolve(true) // resolve to avoid dangling promise
  })
})
