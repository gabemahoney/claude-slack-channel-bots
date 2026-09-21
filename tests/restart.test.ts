/**
 * restart.test.ts — Tests for auto-restart scheduling logic.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  initRestart,
  scheduleRestart,
  cancelAllRestartTimers,
  _resetRestartState,
  isRestartPendingOrActive,
  RESTART_FAILURE_CAP,
  type RestartDeps,
} from '../src/restart.ts'
import {
  _resetBackoffState,
  getFailureCount,
  isAtCap,
} from '../src/backoff.ts'
import { _buildReconnectSessionAdapter } from '../src/server.ts'
import {
  _resetFindMissingMemo,
  _setTmuxServerEnsurer,
  _resetTmuxServerEnsurer,
} from '../src/session-manager.ts'
import {
  setClientForTests,
  resetClientForTests,
} from '../src/agent-director-client.ts'
import {
  _resetOutageState,
  initOutageState,
} from '../src/outage-state.ts'
import { makeStubClient } from './test-helpers/agent-director-stub.ts'
import { errTmuxSendKeys } from './test-helpers/agent-director-stub.ts'
import type { Client } from 'agent-director'
import type { WebClient } from '@slack/web-api'
import type { FindMissingParams } from 'agent-director'

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
  onCapReachedCalls: string[]
} {
  const isSessionAliveCalls: string[] = []
  const killSessionCalls: string[] = []
  const launchSessionCalls: Array<{ channelId: string; cwd: string; sessionId: string | undefined }> = []
  const reconnectSessionCalls: string[] = []
  const onCapReachedCalls: string[] = []

  return {
    isSessionAliveCalls,
    killSessionCalls,
    launchSessionCalls,
    reconnectSessionCalls,
    onCapReachedCalls,

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
    onCapReached: (channelId) => { onCapReachedCalls.push(channelId) },
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

// ---------------------------------------------------------------------------
// Backoff integration (SR-29.3) — Task C subtask 2t
//
// Asserts via pure-module state (getFailureCount / isAtCap), not setTimeout
// spies. The numeric ladder lives in backoff.test.ts; these tests focus on:
//   (1) launchSession=false increments counter; launchSession=true resets it
//   (2) 5 consecutive failures → onCapReached exactly once, no pending timer
//       after cap (the tick-level no-6th-launch property lives in health-check)
//   (3) post-cap scheduleRestart re-attempt resets on success; no re-fire of
//       onCapReached within the same episode
//   (4) reconnect 'success' resets counter; escalated/failed reconnect leaves
//       counter unchanged at that site (single-counting-site pin)
//   (5) SR-25.4 no-stacking: pending-timer dedupe still works alongside backoff
// ---------------------------------------------------------------------------

describe('backoff integration (SR-29.3)', () => {
  // -------------------------------------------------------------------------
  // (1) Counter increments on failure, resets on success
  // -------------------------------------------------------------------------

  test('(1a) launchSession=false increments getFailureCount by 1 per call', async () => {
    const deps = makeDeps({ launchSessionResult: false })
    initRestart(deps)

    scheduleRestart('C_BACKOFF', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(getFailureCount('C_BACKOFF')).toBe(1)
  })

  test('(1b) launchSession=true resets getFailureCount to 0', async () => {
    const deps = makeDeps({ launchSessionResult: false })
    initRestart(deps)

    // Accumulate a failure first
    scheduleRestart('C_BACKOFF', '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(getFailureCount('C_BACKOFF')).toBe(1)

    // Now succeed — deps returns true by default once opts is refreshed
    // Re-init with success result and fire again
    const deps2 = makeDeps({ launchSessionResult: true })
    initRestart(deps2)
    scheduleRestart('C_BACKOFF', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(getFailureCount('C_BACKOFF')).toBe(0)
  })

  // -------------------------------------------------------------------------
  // (2) 5 consecutive failures → onCapReached exactly once, no 6th launch
  // -------------------------------------------------------------------------

  test('(2) 5 consecutive failures → onCapReached EXACTLY once; no pending timer after cap', async () => {
    const CHANNEL = 'C_CAP'
    const CAP = 5
    let launchCount = 0

    // Use a custom launchSession that always fails and counts attempts.
    // Use a tiny base delay; each iteration waits long enough for the current
    // backoff delay to fire (min(base*2^i, 900) * 1000 ms + margin).
    const BASE_DELAY_S = 0.001  // 1 ms base — keeps all iterations fast
    const MARGIN_MS = 40        // margin above the computed backoff delay

    const deps = makeDeps({
      restartDelay: BASE_DELAY_S,
      launchSession: async (_channelId) => {
        launchCount++
        return false
      },
    })
    initRestart(deps)

    // Drive 5 sequential failures: each scheduleRestart fires, fails, increments counter.
    // Wait per iteration = min(BASE_DELAY_S * 2^i, 900) * 1000 ms + MARGIN_MS.
    for (let i = 0; i < CAP; i++) {
      const backoffDelayMs = Math.min(BASE_DELAY_S * Math.pow(2, i), 900) * 1000
      scheduleRestart(CHANNEL, '/cwd/test')
      await Bun.sleep(backoffDelayMs + MARGIN_MS)
    }

    // onCapReached fired exactly once (on the 5th failure)
    expect(deps.onCapReachedCalls).toHaveLength(1)
    expect(deps.onCapReachedCalls[0]).toBe(CHANNEL)

    // getFailureCount is at cap
    expect(getFailureCount(CHANNEL)).toBe(CAP)
    expect(isAtCap(CHANNEL, CAP)).toBe(true)

    // No pending timer after cap — restart.ts returned early without scheduling.
    // This is the load-bearing assertion alongside onCapReachedCalls length 1:
    // once at cap, restart.ts arms no further timer.
    expect(isRestartPendingOrActive(CHANNEL)).toBe(false)

    // NOTE: this test drives exactly CAP scheduleRestart calls, so launchCount==CAP
    // is guaranteed by the driver, not proven by restart.ts. The "no 6th launch"
    // property — that a subsequent health tick does NOT re-launch a capped channel —
    // is the tick-guard's job and is covered in health-check.test.ts.
  })

  // -------------------------------------------------------------------------
  // (3) Post-cap explicit scheduleRestart re-attempts; success resets;
  //     onCapReached did NOT re-fire during the capped episode
  // -------------------------------------------------------------------------

  test('(3) post-cap scheduleRestart re-attempt: success resets isAtCap; onCapReached not re-fired', async () => {
    const CHANNEL = 'C_CAP_THEN_RECOVER'
    const CAP = 5
    let launchCount = 0

    // Use a tiny base delay so backoff stays within a few ms per iteration.
    const BASE_DELAY_S = 0.001  // 1 ms base
    const MARGIN_MS = 40

    // Phase 1: reach the cap (5 failures)
    const failingDeps = makeDeps({
      restartDelay: BASE_DELAY_S,
      launchSession: async () => {
        launchCount++
        return false
      },
    })
    initRestart(failingDeps)

    for (let i = 0; i < CAP; i++) {
      const backoffDelayMs = Math.min(BASE_DELAY_S * Math.pow(2, i), 900) * 1000
      scheduleRestart(CHANNEL, '/cwd/test')
      await Bun.sleep(backoffDelayMs + MARGIN_MS)
    }

    expect(isAtCap(CHANNEL, CAP)).toBe(true)
    expect(failingDeps.onCapReachedCalls).toHaveLength(1)

    // Phase 2: an inbound trigger (explicit scheduleRestart — simulates user message
    // re-entering recovery path) causes a successful launch.
    // At this point the failure count is CAP, so nextBackoffDelay = min(0.001 * 2^5, 900) = 0.032s.
    // Use MARGIN_MS=40 which is > 32ms, so the timer fires.
    const recoveringDeps = makeDeps({ restartDelay: BASE_DELAY_S, launchSessionResult: true })
    initRestart(recoveringDeps)

    const backoffAtCap = Math.min(BASE_DELAY_S * Math.pow(2, CAP), 900) * 1000
    scheduleRestart(CHANNEL, '/cwd/test')
    await Bun.sleep(backoffAtCap + MARGIN_MS)

    // Successful launch resets the cap
    expect(isAtCap(CHANNEL, CAP)).toBe(false)
    expect(getFailureCount(CHANNEL)).toBe(0)

    // onCapReached did NOT re-fire during this recovery (new deps, no calls)
    expect(recoveringDeps.onCapReachedCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // (4) Reconnect path: 'success' resets counter; non-success does NOT
  //     record a failure at the reconnect site (single-counting-site pin).
  //
  //     Single-counting-site pin: the reconnect path never calls recordFailure.
  //     On main, a non-success reconnect outcome ('escalate-dead' or 'transient')
  //     does NOT re-enter scheduleRestart. For 'escalate-dead' (dead-tmux) the
  //     adapter upstream fires CSCB's internal reconcileMissingSweep so the frozen
  //     `working` row reconciles to `missing` and the NEXT health tick takes the
  //     kill+relaunch branch (Epic t1.tkk.e4 / b.sv7) — recovery is internal, not
  //     deferred to the external ~/startup/find-missing-loop.sh (belt-and-braces
  //     only). Whether or not that sweep fires, the reconnect verdict path still
  //     records neither success nor failure: the one and only place a failure is
  //     counted is the launchSession boolean on the dead-session relaunch path.
  //     Recording a failure at the reconnect site too would be a spurious second
  //     count of the same episode, and escalate-dead ticks must not accumulate
  //     toward the b.7u6 5-spawn cap.
  //
  //     These tests pin the negative: a non-success reconnect leaves the counter
  //     untouched. To distinguish "left unchanged" from "erroneously reset to 0
  //     by recordSuccess", each pre-seeds one failure and asserts the count stays 1.
  // -------------------------------------------------------------------------

  test('(4a) reconnect result=success resets getFailureCount to 0', async () => {
    const CHANNEL = 'C_RECONNECT_SUCCESS'

    // Pre-seed a failure count so there is something to reset
    const failDeps = makeDeps({ launchSessionResult: false })
    initRestart(failDeps)
    scheduleRestart(CHANNEL, '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(getFailureCount(CHANNEL)).toBe(1)

    // Now simulate alive=true with reconnect returning 'success'
    const reconnectDeps = makeDeps({ isSessionAliveResult: true })
    reconnectDeps.reconnectSession = async (_channelId) => 'success'
    initRestart(reconnectDeps)

    scheduleRestart(CHANNEL, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(getFailureCount(CHANNEL)).toBe(0)
  })

  test('(4b) reconnect result=escalate-dead leaves counter unchanged at reconnect site (single-counting-site pin; no cap accumulation)', async () => {
    // Single-counting-site pin: the reconnect path does NOT call recordFailure.
    // 'escalate-dead' does NOT re-enter scheduleRestart; internal recovery flows
    // through the adapter's reconcileMissingSweep so the next health tick relaunches
    // (Epic t1.tkk.e4 / b.sv7). The lone place failures are counted is the
    // launchSession boolean on the relaunch path. This test also proves the
    // reconnect path does not erroneously RESET the counter: it pre-seeds one
    // failure and asserts the count remains 1 — so escalate-dead ticks never
    // accumulate toward the b.7u6 5-spawn cap (a pre-seeded failure stays put,
    // and repeated escalate-dead ticks would leave it there rather than climbing).
    const CHANNEL = 'C_RECONNECT_ESCALATE'

    // Pre-seed a failure so "unchanged" is distinguishable from "reset to 0"
    const failDeps = makeDeps({ launchSessionResult: false })
    initRestart(failDeps)
    scheduleRestart(CHANNEL, '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(getFailureCount(CHANNEL)).toBe(1)

    // Simulate alive=true with reconnect returning 'escalate-dead'
    const escapingDeps = makeDeps({ isSessionAliveResult: true })
    escapingDeps.reconnectSession = async (_channelId) => 'escalate-dead'
    initRestart(escapingDeps)

    scheduleRestart(CHANNEL, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // Counter UNCHANGED at the reconnect site — neither incremented nor reset.
    // No cap accumulation (b.7u6): the escalate-dead tick did not climb the
    // failure count toward the 5-spawn cap, and onCapReached never fired.
    expect(getFailureCount(CHANNEL)).toBe(1)
    expect(isAtCap(CHANNEL, RESTART_FAILURE_CAP)).toBe(false)
    expect(escapingDeps.onCapReachedCalls).toHaveLength(0)
  })

  test('(4c) reconnect result=transient leaves counter unchanged at reconnect site', async () => {
    const CHANNEL = 'C_RECONNECT_TRANSIENT'

    // Pre-seed a failure so "unchanged" is distinguishable from "reset to 0"
    const failDeps = makeDeps({ launchSessionResult: false })
    initRestart(failDeps)
    scheduleRestart(CHANNEL, '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(getFailureCount(CHANNEL)).toBe(1)

    const transientDeps = makeDeps({ isSessionAliveResult: true })
    transientDeps.reconnectSession = async (_channelId) => 'transient'
    initRestart(transientDeps)

    scheduleRestart(CHANNEL, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // Counter unchanged — counting is not done at the reconnect site
    expect(getFailureCount(CHANNEL)).toBe(1)
  })

  test('(4d) reconnect throws (undefined result) — counter unchanged at reconnect site', async () => {
    const CHANNEL = 'C_RECONNECT_THROW'

    // Pre-seed a failure so "unchanged" is distinguishable from "reset to 0"
    const failDeps = makeDeps({ launchSessionResult: false })
    initRestart(failDeps)
    scheduleRestart(CHANNEL, '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(getFailureCount(CHANNEL)).toBe(1)

    const throwingDeps = makeDeps({ isSessionAliveResult: true })
    throwingDeps.reconnectSession = async (_channelId) => {
      throw new Error('sendKeys failed')
    }
    initRestart(throwingDeps)

    scheduleRestart(CHANNEL, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // Counter unchanged — the catch block sets result=undefined, no recordFailure
    expect(getFailureCount(CHANNEL)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // (5) SR-25.4 no-stacking: pending-timer dedupe still works alongside
  //     backoff. A second scheduleRestart for the same channel cancels the
  //     first timer (cancel-and-replace semantic).
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // (6) b.9a7 — reconnect defer contract. A tick-driven reconnect that returns
  //     'transient' (e.g. the server.ts adapter deferring a `working` session,
  //     hazard 2 / b.rmy) or that fails must not consume the b.7u6 cap and must
  //     leave the channel free for a later tick to retry: no launchSession, no
  //     killSession, no recordFailure, no onCapReached, and no pending timer
  //     re-armed from restart.ts (the tick is the retry driver, not re-entry).
  // -------------------------------------------------------------------------

  test('(6a) b.9a7: alive + reconnect="transient" (working-state defer) does not relaunch or re-arm', async () => {
    // Unique to this case (the "transient leaves the counter unchanged" behavior
    // is already pinned by 4c): the working-state defer takes NO recovery action
    // and restart.ts does NOT re-enter scheduleRestart — the tick is the retry
    // driver. This asserts the observable no-op side of the defer contract.
    const CHANNEL = 'C_9A7_DEFER'
    const deps = makeDeps({ isSessionAliveResult: true })
    deps.reconnectSession = async (channelId) => {
      deps.reconnectSessionCalls.push(channelId)
      return 'transient'
    }
    initRestart(deps)

    scheduleRestart(CHANNEL, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // Reconnect was attempted, but the defer path leaves the turn undisturbed:
    // no kill, no relaunch.
    expect(deps.reconnectSessionCalls).toEqual([CHANNEL])
    expect(deps.killSessionCalls).toHaveLength(0)
    expect(deps.launchSessionCalls).toHaveLength(0)
    // restart.ts does NOT re-enter scheduleRestart — no pending timer remains;
    // the next health-check tick is the retry driver.
    expect(isRestartPendingOrActive(CHANNEL)).toBe(false)
  })

  test('(6b) b.9a7: repeated reconnect failures never consume the cap (single counting site)', async () => {
    const CHANNEL = 'C_9A7_RETRY'
    const deps = makeDeps({ isSessionAliveResult: true })
    // Every reconnect attempt fails (throws → undefined result). Simulate the
    // tick re-driving scheduleRestart many times over.
    deps.reconnectSession = async (channelId) => {
      deps.reconnectSessionCalls.push(channelId)
      throw new Error('sendKeys failed')
    }
    initRestart(deps)

    for (let i = 0; i < RESTART_FAILURE_CAP + 3; i++) {
      scheduleRestart(CHANNEL, '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }

    // Reconnect was attempted every time, but the reconnect path never counts a
    // failure, so the cap is never reached despite far more than CAP attempts.
    expect(deps.reconnectSessionCalls.length).toBe(RESTART_FAILURE_CAP + 3)
    expect(getFailureCount(CHANNEL)).toBe(0)
    expect(isAtCap(CHANNEL, RESTART_FAILURE_CAP)).toBe(false)
    expect(deps.onCapReachedCalls).toHaveLength(0)
  })

  test('(5) SR-25.4 no-stacking: second scheduleRestart cancels first pending timer (cancel-and-replace)', async () => {
    const deps = makeDeps({ restartDelay: SLOW_DELAY_S, launchSessionResult: false })
    initRestart(deps)

    scheduleRestart('C_NOSTACK', '/cwd/test')
    expect(isRestartPendingOrActive('C_NOSTACK')).toBe(true)

    // A second call cancels the first and replaces it — still one pending timer
    scheduleRestart('C_NOSTACK', '/cwd/test')
    expect(isRestartPendingOrActive('C_NOSTACK')).toBe(true)

    // Only one pending timer exists (cancel-and-replace): counter has not changed
    // because no timer has fired yet
    expect(getFailureCount('C_NOSTACK')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Escalate-dead internal recovery (Epic t1.tkk.e4 / b.sv7) — two-tick relaunch
//
// The fake-deps tests above inject a fake `reconnectSession` that returns
// 'escalate-dead' directly, so they never touch the real adapter or the
// session-manager sweep wrapper. This block instead composes the REAL
// `_buildReconnectSessionAdapter` as the injected `deps.reconnectSession`, wired
// to a single stub AD client via setClientForTests + initOutageState. That is
// the seam Epic AC 2 demands: a dead-tmux verdict driven through the stub's
// send-keys failures ('dead-session' → 'escalate-dead') must fire CSCB's OWN
// memoized reconcileMissingSweep (observed as exactly one findMissing call — the
// external ~/startup/find-missing-loop.sh is absent by construction, never
// referenced here). Then, once that sweep has (in production) reconciled the
// frozen `working` row to `missing`, a SUBSEQUENT tick with the session reported
// dead takes the normal kill+relaunch branch.
//
// Seams only — the tmux-server ensurer is stubbed to a no-op so reconnectMcp's
// self-heal retry never shells out to a real tmux server; no live tmux/fleet is
// ever touched. The findMissing memo is reset per test so the call count is
// deterministic (the TTL setter alone does not clear the memo).
// ---------------------------------------------------------------------------

describe('escalate-dead internal recovery via real adapter (b.sv7)', () => {
  /**
   * Build restart deps whose `reconnectSession` is the REAL adapter, plus a
   * mutable `alive` flag so a test can flip liveness between simulated ticks.
   * The stub client is shared by the adapter's status probe and reconnectMcp's
   * send-keys (both flow through withOutageDetection's getClient), and its
   * findMissing capture is the observable seam for "the sweep ran".
   */
  function makeRealAdapterDeps(): {
    deps: RestartDeps & {
      killSessionCalls: string[]
      launchSessionCalls: string[]
    }
    findMissingCalls: FindMissingParams[]
    setAlive: (v: boolean) => void
  } {
    let alive = true
    const killSessionCalls: string[] = []
    const launchSessionCalls: string[] = []
    const findMissingCalls: FindMissingParams[] = []

    // Non-working status → adapter falls through to reconnectMcp; persistent
    // ErrTmuxSendKeys on send-keys (ensurer stubbed no-op) → 'dead-session'
    // → adapter maps to 'escalate-dead' and fires the internal sweep.
    const stub = makeStubClient({
      statusFn: () => ({ state: 'waiting' }),
      sendKeysError: errTmuxSendKeys(),
      findMissingCalls,
    })
    _resetOutageState()
    initOutageState({
      postToChannel: () => {},
      getClient: () => stub as unknown as Client,
    })
    setClientForTests(stub as unknown as Client)
    _setTmuxServerEnsurer(async () => {})

    const fakeConfig = { routes: { C_DEADTMUX: { normalizedName: 'dead-tmux' } } }
    const reconnectSession = _buildReconnectSessionAdapter(
      () => fakeConfig as never,
      {} as unknown as WebClient,
    )

    const deps: RestartDeps & { killSessionCalls: string[]; launchSessionCalls: string[] } = {
      killSessionCalls,
      launchSessionCalls,
      async isSessionAlive() { return alive },
      isSessionConnected() { return false },
      reconnectSession,
      async killSession(channelId) { killSessionCalls.push(channelId) },
      async launchSession(channelId) { launchSessionCalls.push(channelId); return true },
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: () => {},
    }
    return { deps, findMissingCalls, setAlive: (v: boolean) => { alive = v } }
  }

  beforeEach(() => {
    _resetFindMissingMemo()
  })

  afterEach(() => {
    resetClientForTests()
    _resetOutageState()
    _resetTmuxServerEnsurer()
    _resetFindMissingMemo()
  })

  test('tick 1: alive+dead-tmux verdict fires exactly one internal findMissing sweep (no kill/relaunch); tick 2: session dead → kill+relaunch', async () => {
    const CHANNEL = 'C_DEADTMUX'
    const { deps, findMissingCalls, setAlive } = makeRealAdapterDeps()
    initRestart(deps)

    // --- Tick 1: row still looks alive; the real adapter runs reconnectMcp,
    // which returns 'dead-session' → 'escalate-dead', firing the internal sweep.
    setAlive(true)
    scheduleRestart(CHANNEL, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // The existing memoized sweep ran exactly once — this is CSCB's own recovery,
    // not the external loop (absent by construction). The escalate-dead verdict
    // takes NO relaunch action on this tick.
    expect(findMissingCalls).toHaveLength(1)
    expect(deps.killSessionCalls).toHaveLength(0)
    expect(deps.launchSessionCalls).toHaveLength(0)
    // Single counting site: escalate-dead never records a failure.
    expect(getFailureCount(CHANNEL)).toBe(0)
    expect(isAtCap(CHANNEL, RESTART_FAILURE_CAP)).toBe(false)

    // --- Tick 2: the sweep has (in production) reconciled the row to `missing`,
    // so the next tick observes the session dead. The normal kill+relaunch
    // branch runs. Reset the memo so this tick's semantics don't depend on the
    // prior sweep's TTL — we are simulating a LATER tick past the memo window.
    _resetFindMissingMemo()
    setAlive(false)
    scheduleRestart(CHANNEL, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.killSessionCalls).toEqual([CHANNEL])
    expect(deps.launchSessionCalls).toEqual([CHANNEL])
  })
})
