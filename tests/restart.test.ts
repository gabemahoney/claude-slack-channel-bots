/**
 * restart.test.ts — Tests for auto-restart scheduling logic.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  initRestart,
  scheduleRestart,
  cancelAllRestartTimers,
  _resetRestartState,
  isRestartPendingOrActive,
  type RestartDeps,
} from '../src/restart.ts'
import { _resetBackoffState } from '../src/backoff.ts'

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
  isSessionConnectedResult?: boolean  // default: false (not yet reconnected)
  launchSessionResult?: boolean   // default: true (launch succeeds)
  launchSession?: (channelId: string, cwd: string, sessionId?: string) => Promise<boolean>  // override entire launchSession
  restartDelay?: number           // default: FAST_DELAY_S
  isShuttingDown?: boolean        // default: false
}

function makeDeps(opts: DepsOpts = {}): RestartDeps & {
  isSessionAliveCalls: string[]
  killSessionCalls: string[]
  launchSessionCalls: Array<{ channelId: string; cwd: string; sessionId: string | undefined }>
  reconnectSessionCalls: string[]
} {
  const isSessionAliveCalls: string[] = []
  const killSessionCalls: string[] = []
  const launchSessionCalls: Array<{ channelId: string; cwd: string; sessionId: string | undefined }> = []
  const reconnectSessionCalls: string[] = []

  return {
    isSessionAliveCalls,
    killSessionCalls,
    launchSessionCalls,
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
    async launchSession(channelId, cwd, sessionId) {
      launchSessionCalls.push({ channelId, cwd, sessionId })
      if (opts.launchSession) return opts.launchSession(channelId, cwd, sessionId)
      return opts.launchSessionResult ?? true
    },
    getRestartDelay: () => opts.restartDelay ?? FAST_DELAY_S,
    isShuttingDown: () => opts.isShuttingDown ?? false,
    onCapReached: (_channelId) => { /* no-op stub — behavioral coverage in Task C */ },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRestartState()
  _resetBackoffState()
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

  test('3. timer fires, session already alive — reconnectSession called, launchSession NOT called', async () => {
    const deps = makeDeps({ isSessionAliveResult: true })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toHaveLength(1)
    expect(deps.reconnectSessionCalls).toHaveLength(1)
    expect(deps.reconnectSessionCalls[0]).toBe('C_TEST1')
    expect(deps.launchSessionCalls).toHaveLength(0)
  })

  test('3b. session alive but reconnectSession throws — does not propagate, launchSession NOT called', async () => {
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
    expect(deps.launchSessionCalls).toHaveLength(0)
  })

  test('timer fires but isShuttingDown=true — launchSession never called', async () => {
    const deps = makeDeps({ isShuttingDown: true })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(0)
  })

  test('4. timer fires, session dead — killSession then launchSession called (SR-21.4: dead-probe adapter feeds this branch)', async () => {
    // SR-21.4: the _buildIsSessionAliveAdapter in server.ts feeds isSessionAlive
    // here. When the adapter returns false (dead tmux session or ErrSpawnNotFound),
    // scheduleRestart fires killSession then launchSession — this is the
    // dead-branch that the probe now reaches via the liveness matrix.
    const deps = makeDeps({ isSessionAliveResult: false })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.killSessionCalls).toHaveLength(1)
    expect(deps.killSessionCalls[0]).toBe('C_TEST1')
    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].channelId).toBe('C_TEST1')
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

  // SR-26.1 / SR-21.4 — DELIBERATE SEMANTIC (t3.a3g.yn.5o.cj)
  //
  // scheduleRestart() during activeLaunches DOES set a new pending timer.
  // This is intentional: cancel-and-replace applies only to pending timers
  // (pendingRestartTimers). The double-spawn protection lives entirely at the
  // CALL SITES in server.ts — the three guard sites (onsessionclosed, dispatch
  // no-GET-stream miss, SSE-abort detector) each call isRestartPendingOrActive()
  // and skip if true (SR-26.1). restart.ts itself has no guard because it would
  // create an unwanted dependency on its own state from within the timer callback.
  //
  // This test pins the semantic so future edits do not silently add an intra-
  // restart.ts guard and break the layering contract.
  test('A1. DELIBERATE: scheduleRestart during activeLaunches sets a new pending timer (SR-26.1: guard lives at call sites, not inside scheduleRestart)', async () => {
    let launchResolve!: (ok: boolean) => void
    const launchPromise = new Promise<boolean>((res) => { launchResolve = res })

    const deps = makeDeps({ launchSession: () => launchPromise })
    initRestart(deps)

    // First scheduleRestart — starts the timer with FAST_DELAY_S
    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)  // timer fires; activeLaunches now has C_TEST1

    // At this point: activeLaunches has C_TEST1, no pending timer
    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)

    // Calling scheduleRestart again (as a call site WOULD if it lacked the guard)
    // DOES register a new pending timer — the semantic is cancel-and-replace for
    // pending timers only; activeLaunches is orthogonal.
    scheduleRestart('C_TEST1', '/cwd/test')

    // Both activeLaunches (from first) AND pendingRestartTimers (from second) are
    // now active — isRestartPendingOrActive remains true.
    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)

    launchResolve(true)
    await Bun.sleep(WAIT_MS)  // second timer fires too

    // Two launchSession calls total (the second timer fired after first resolved)
    // This confirms that restart.ts itself does NOT suppress the second call —
    // the server.ts call sites must do so (SR-26.1).
    expect(deps.launchSessionCalls.length).toBeGreaterThanOrEqual(2)
  })

  // ---------------------------------------------------------------------------
  // Adapter escalation-routing tests (SR-25.1 / t3.a3g.u4.mp.wm)
  //
  // The real reconnectSession adapter (inside main() in server.ts) wraps
  // reconnectMcp and on 'escalate-dead' calls:
  //
  //   if (!isRestartPendingOrActive(channelId)) scheduleRestart(channelId, cwd)
  //
  // That adapter closure is NOT unit-reachable (it is constructed inside main()).
  // These tests prove the ROUTING CONTRACT at the reachable seam by modelling
  // the adapter: a reconnectSession dep that mirrors what the real adapter does.
  //
  // What is MODELLED (not directly reached):
  //   - The adapter's conditional isRestartPendingOrActive guard before scheduleRestart
  //   - The cwd-resolution path (routingConfig.routes[channelId].cwd)
  //
  // What IS directly asserted on the real restart.ts exports:
  //   - isRestartPendingOrActive truth value at each stage
  //   - scheduleRestart / launchSession call counts
  //   - pendingRestartTimers dedupe (cancel-and-replace semantic)
  // ---------------------------------------------------------------------------

  // SR-25.1 / t3.a3g.u4.mp.wm
  //
  // Alive-branch escalation DEDUPED by isRestartPendingOrActive:
  //   1. scheduleRestart fires its timer (C_TEST1 enters activeLaunches)
  //   2. isSessionAlive=true → reconnectSession (adapter model) is called
  //   3. Adapter would escalate, but isRestartPendingOrActive(C_TEST1) is true
  //      (activeLaunches has it) → adapter skips scheduleRestart
  //   4. reconnectSession returns → alive-branch return (line 99) → no launch
  //   5. finally: activeLaunches.delete → clean state
  //
  // Contract: launchSession is NEVER called; after completion isRestartPendingOrActive=false.
  test('A2. adapter escalation dedupe: reconnectSession that escalates is blocked by isRestartPendingOrActive (activeLaunches guard)', async () => {
    // Track what the adapter-model attempted
    let escalateAttempted = false
    let escalateSkipped = false

    // Adapter model: mirrors real reconnectSession in server.ts
    // On 'escalate-dead': check isRestartPendingOrActive before calling scheduleRestart
    const adaptedReconnectSession = async (channelId: string): Promise<void> => {
      escalateAttempted = true
      // At this point we are inside the restart.ts timer callback:
      // activeLaunches has channelId → isRestartPendingOrActive returns true
      if (isRestartPendingOrActive(channelId)) {
        escalateSkipped = true
        return  // adapter guard fires — no second scheduleRestart
      }
      // Would call scheduleRestart here if guard had not fired
      scheduleRestart(channelId, '/escalated/cwd')
    }

    const deps = makeDeps({ isSessionAliveResult: true })
    deps.reconnectSession = adaptedReconnectSession
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // Adapter fired and was deduped
    expect(escalateAttempted).toBe(true)
    expect(escalateSkipped).toBe(true)

    // No launchSession — alive-branch returns without launching
    expect(deps.launchSessionCalls).toHaveLength(0)

    // State is clean after the timer callback's finally block
    expect(isRestartPendingOrActive('C_TEST1')).toBe(false)
  })

  // SR-25.1 / t3.a3g.u4.mp.wm
  //
  // Adapter escalation PROCEEDS when guard is false (baseline contrast test):
  // If isRestartPendingOrActive were false at escalation time, the adapter
  // WOULD call scheduleRestart — this pins that the contract is conditional,
  // not that escalation is unconditionally suppressed.
  //
  // Scenario: first scheduleRestart fires → dead path (isSessionAlive=false) →
  // launchSession is long-running → reconnectSession (adapter model) called for
  // a DIFFERENT channel where isRestartPendingOrActive is false → adapter DOES
  // schedule the second restart.
  //
  // This test uses two channels to produce the "guard=false → proceeds" branch.
  test('A3. adapter escalation PROCEEDS when isRestartPendingOrActive is false (contrast: guard is conditional, not unconditional suppression)', async () => {
    const scheduledVia: string[] = []

    // Model adapter for C_TEST2: escalates unconditionally to a sub-call that
    // records whether it reached scheduleRestart (isRestartPendingOrActive is
    // false for C_TEST2 at the time it fires).
    const adaptedReconnectSession = async (_channelId: string): Promise<void> => {
      const target = 'C_TEST2'
      if (isRestartPendingOrActive(target)) {
        return  // would skip
      }
      scheduledVia.push(target)
      scheduleRestart(target, '/escalated/cwd/c2')
    }

    // C_TEST2 will fire reconnectSession (alive=true); C_TEST1 path has nothing to do
    const deps = makeDeps({ isSessionAliveResult: true, restartDelay: SLOW_DELAY_S })
    deps.reconnectSession = adaptedReconnectSession
    initRestart(deps)

    // Directly set up C_TEST1 as pending (SLOW_DELAY_S — won't fire during test)
    scheduleRestart('C_TEST1', '/cwd/c1')
    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)

    // C_TEST2 is NOT pending
    expect(isRestartPendingOrActive('C_TEST2')).toBe(false)

    // Directly invoke the adapter model (simulating what restart.ts would call
    // after isSessionAlive returned true for C_TEST2)
    await deps.reconnectSession('C_TEST2')

    // Guard was false for C_TEST2 → escalation PROCEEDED → scheduleRestart called
    expect(scheduledVia).toHaveLength(1)
    expect(scheduledVia[0]).toBe('C_TEST2')

    // C_TEST2 now has a pending timer (SLOW_DELAY_S — won't fire)
    expect(isRestartPendingOrActive('C_TEST2')).toBe(true)

    // C_TEST1 still pending (unchanged)
    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)
  })

  // SR-25.1 / t3.a3g.u4.mp.wm
  //
  // Exactly-one-launch: adapter escalates (guard=false) → second scheduleRestart
  // fires its timer → launchSession called exactly once.
  //
  // This proves the end-to-end escalation path: a reconnectSession that escalates
  // (because isRestartPendingOrActive was false at the time) ultimately produces
  // exactly one launchSession call when the timer fires.
  //
  // Model: reconnectSession is called directly (outside timer callback, so
  // activeLaunches does NOT have the channelId — guard=false → escalation proceeds).
  test('A4. adapter escalation with guard=false produces exactly one launchSession via the escalated scheduleRestart timer', async () => {
    const launchCalls: Array<{ channelId: string; cwd: string }> = []

    const deps: RestartDeps & { launchSessionCalls: typeof launchCalls } = {
      launchSessionCalls: launchCalls,
      async isSessionAlive(_channelId) { return false },
      isSessionConnected(_channelId) { return false },
      async reconnectSession(_channelId) { /* not called in dead path */ },
      async killSession(_channelId) { /* ignore */ },
      async launchSession(channelId, cwd, _sessionId) {
        launchCalls.push({ channelId, cwd })
        return true
      },
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: (_channelId) => { /* no-op stub */ },
    }
    initRestart(deps)

    // Adapter model for escalation: simulate what server.ts reconnectSession does
    // when reconnectMcp returns 'escalate-dead' and isRestartPendingOrActive=false.
    const escalatingAdapter = async (channelId: string): Promise<void> => {
      const cwd = '/escalated/route/cwd'
      if (!isRestartPendingOrActive(channelId)) {
        scheduleRestart(channelId, cwd)  // adapter escalates — schedules restart
      }
    }

    // isRestartPendingOrActive is false for C_TEST1 at call time (no active restart)
    expect(isRestartPendingOrActive('C_TEST1')).toBe(false)

    // Adapter call (modelling what the real adapter does on 'escalate-dead')
    await escalatingAdapter('C_TEST1')

    // Timer is now pending
    expect(isRestartPendingOrActive('C_TEST1')).toBe(true)

    // Wait for timer to fire → launchSession called (isSessionAlive=false → kill+launch)
    await Bun.sleep(WAIT_MS)

    // Exactly one launch — the escalated scheduleRestart fired once
    expect(launchCalls).toHaveLength(1)
    expect(launchCalls[0].channelId).toBe('C_TEST1')
    expect(launchCalls[0].cwd).toBe('/escalated/route/cwd')

    // Clean after completion
    expect(isRestartPendingOrActive('C_TEST1')).toBe(false)
  })

  test('10. launchSession succeeds — no failure state accumulates', async () => {
    const deps = makeDeps({ launchSessionResult: true })
    initRestart(deps)

    scheduleRestart('C_TEST1', '/cwd/test', 'saved-session-123')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].sessionId).toBe('saved-session-123')
    // No failure tracking exists — restart retries indefinitely on death
    expect(isRestartPendingOrActive('C_TEST1')).toBe(false)
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
      isSessionConnected: () => false,
      reconnectSession: async () => {},
      killSession: async () => {},
      launchSession: async () => true,
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: (_channelId) => { /* no-op stub */ },
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
