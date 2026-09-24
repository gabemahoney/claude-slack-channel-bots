/**
 * restart.test.ts — Tests for auto-restart scheduling logic.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { _buildKillSessionAdapter, _buildReconnectSessionAdapter } from '../src/server.ts'
import {
  _resetFindMissingMemo,
  _setTmuxServerEnsurer,
  _resetTmuxServerEnsurer,
  _resetInFlightLaunches,
  _setTmuxCapturePane,
  _setTmuxSendEnter,
  _resetTmuxDialogHelpers,
  _setTmuxSessionProber,
  _resetTmuxSessionProber,
  _setDialogPollIntervalMs,
  _resetDialogPollIntervalMs,
  _setDialogReadyTimeoutMs,
  _resetDialogReadyTimeoutMs,
  _setSpawnHomeDir,
  _resetSpawnHomeDir,
  isLaunchInFlight,
  launchSession as launchPersonaSession,
  notifyRestartCapReached,
  setSessionNotifier,
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
import { errGeneric, errTmuxSendKeys, holdSpawns, type SpawnHold } from './test-helpers/agent-director-stub.ts'
import type { Client } from 'agent-director'
import type { FindMissingParams, KillParams, SendKeysParams, SpawnParams, StatusParams } from 'agent-director'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness, type NotifierHarness } from './test-helpers/persona-notifier.ts'
import type { Persona, PersonaConfig } from '../src/config.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_DELAY_S = 0.01  // 10 ms timer — fast enough for tests
const SLOW_DELAY_S = 9999  // large enough to never fire during a test
const WAIT_MS = 50         // wait after scheduling; long enough for FAST_DELAY_S to fire
const CAP_BASE_DELAY_S = 0.001  // 1 ms base for the cap-driving helper below
const CAP_MARGIN_MS = 40        // margin above each computed backoff delay

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type DepsOpts = {
  isSessionAliveResult?: boolean  // default: false (session is dead)
  isSessionConnectedResult?: boolean  // default: false (not yet reconnected)
  hasSessionStreamResult?: boolean  // default: true (stream present — prior semantics)
  launchSessionResult?: boolean   // default: true (launch succeeds)
  launchSession?: (key: string, cwd: string, sessionId?: string) => Promise<boolean>  // override entire launchSession
  killSession?: (key: string) => Promise<void>  // runs after the capture (e.g. the real kill adapter)
  restartDelay?: number           // default: FAST_DELAY_S
  isShuttingDown?: boolean        // default: false
  onCapReached?: (key: string) => void  // called after the capture (e.g. the real cap-notice function)
}

function makeDeps(opts: DepsOpts = {}): RestartDeps & {
  isSessionAliveCalls: string[]
  killSessionCalls: string[]
  launchSessionCalls: Array<{ key: string; cwd: string; sessionId: string | undefined }>
  reconnectSessionCalls: string[]
  onCapReachedCalls: string[]
} {
  const isSessionAliveCalls: string[] = []
  const killSessionCalls: string[] = []
  const launchSessionCalls: Array<{ key: string; cwd: string; sessionId: string | undefined }> = []
  const reconnectSessionCalls: string[] = []
  const onCapReachedCalls: string[] = []

  return {
    isSessionAliveCalls,
    killSessionCalls,
    launchSessionCalls,
    reconnectSessionCalls,
    onCapReachedCalls,

    async isSessionAlive(key) {
      isSessionAliveCalls.push(key)
      return opts.isSessionAliveResult ?? false
    },
    isSessionConnected(_key) {
      return opts.isSessionConnectedResult ?? false
    },
    hasSessionStream(_key) {
      return opts.hasSessionStreamResult ?? true
    },
    async reconnectSession(key) {
      reconnectSessionCalls.push(key)
    },
    async killSession(key) {
      killSessionCalls.push(key)
      await opts.killSession?.(key)
    },
    async launchSession(key, cwd, sessionId) {
      launchSessionCalls.push({ key, cwd, sessionId })
      if (opts.launchSession) return opts.launchSession(key, cwd, sessionId)
      return opts.launchSessionResult ?? true
    },
    getRestartDelay: () => opts.restartDelay ?? FAST_DELAY_S,
    isShuttingDown: () => opts.isShuttingDown ?? false,
    onCapReached: (key) => {
      onCapReachedCalls.push(key)
      opts.onCapReached?.(key)
    },
  }
}

/**
 * Drive `count` consecutive failed launches for persona `key` (deps must fail
 * its launches and use CAP_BASE_DELAY_S), waiting out each backoff delay from
 * the persona's own current failure count.
 */
async function driveFailures(key: string, cwd: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const backoffDelayMs = Math.min(CAP_BASE_DELAY_S * Math.pow(2, getFailureCount(key)), 900) * 1000
    scheduleRestart(key, cwd)
    await Bun.sleep(backoffDelayMs + CAP_MARGIN_MS)
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

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].key).toBe('test_bot_1')
    expect(deps.launchSessionCalls[0].cwd).toBe('/cwd/test')
  })

  test('2. delay = 0 — no timer scheduled, launchSession never called', async () => {
    const deps = makeDeps({ restartDelay: 0 })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(0)
  })

  test('3. timer fires, session already alive — reconnectSession called, launchSession NOT called', async () => {
    const deps = makeDeps({ isSessionAliveResult: true })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toHaveLength(1)
    expect(deps.reconnectSessionCalls).toHaveLength(1)
    expect(deps.reconnectSessionCalls[0]).toBe('test_bot_1')
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

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(reconnectCalled).toBe(true)
    expect(deps.launchSessionCalls).toHaveLength(0)
  })

  test('timer fires but isShuttingDown=true — launchSession never called', async () => {
    const deps = makeDeps({ isShuttingDown: true })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(0)
  })

  // b.9cj: the "already reconnected" early return is only taken when the session
  // is connected AND its standalone GET stream is present. A connected-but-
  // streamless session (the exact state scheduleRestart is invoked for) must NOT
  // be waved through — it proceeds to recovery.
  test('b.9cj: alive + connected + stream present — skips reconnect (already-healed guard holds)', async () => {
    const deps = makeDeps({
      isSessionAliveResult: true,
      isSessionConnectedResult: true,
      hasSessionStreamResult: true,
    })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // Genuinely healed: the guard returns before any recovery action.
    expect(deps.reconnectSessionCalls).toHaveLength(0)
    expect(deps.launchSessionCalls).toHaveLength(0)
    expect(deps.killSessionCalls).toHaveLength(0)
  })

  test('b.9cj REGRESSION: alive + connected but STREAMLESS — recovery proceeds (no already-reconnected short-circuit)', async () => {
    // Pre-fix, restart.ts skipped whenever isSessionConnected was true, so this
    // connected-but-streamless session took the "already reconnected" early
    // return and never recovered. Post-fix the guard also requires the stream,
    // so recovery proceeds: alive → reconnectSession is called.
    const deps = makeDeps({
      isSessionAliveResult: true,
      isSessionConnectedResult: true,
      hasSessionStreamResult: false,
    })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // The alive branch ran reconnectSession — the guard did NOT short-circuit.
    expect(deps.reconnectSessionCalls).toEqual(['test_bot_1'])
    expect(deps.launchSessionCalls).toHaveLength(0)
  })

  test('4. timer fires, session dead — killSession then launchSession called', async () => {
    const deps = makeDeps({ isSessionAliveResult: false })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.killSessionCalls).toHaveLength(1)
    expect(deps.killSessionCalls[0]).toBe('test_bot_1')
    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].key).toBe('test_bot_1')
  })

  test('8. restart with stored session ID — launchSession receives session ID argument', async () => {
    const deps = makeDeps()
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test', 'saved-session-123')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].key).toBe('test_bot_1')
    expect(deps.launchSessionCalls[0].cwd).toBe('/cwd/test')
    expect(deps.launchSessionCalls[0].sessionId).toBe('saved-session-123')
  })

  test('9. restart without stored session ID — launchSession called without session ID', async () => {
    const deps = makeDeps()
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].sessionId).toBeUndefined()
  })

  test('10. launchSession succeeds — no failure state accumulates', async () => {
    const deps = makeDeps({ launchSessionResult: true })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test', 'saved-session-123')
    await Bun.sleep(WAIT_MS)

    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.launchSessionCalls[0].sessionId).toBe('saved-session-123')
    // No failure tracking exists — restart retries indefinitely on death
    expect(isRestartPendingOrActive('test_bot_1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// cancelAllRestartTimers
// ---------------------------------------------------------------------------

describe('cancelAllRestartTimers', () => {
  test('8. clears all pending timers — launchSession never called after cancel', async () => {
    const deps = makeDeps() // FAST_DELAY_S = 10 ms
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/one')
    scheduleRestart('test_bot_2', '/cwd/two')

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
  test('returns false for persona with no timer and no active launch', () => {
    expect(isRestartPendingOrActive('test_bot_1')).toBe(false)
  })

  test('returns true after scheduleRestart is called (timer pending, not yet fired)', () => {
    const deps = makeDeps({ restartDelay: SLOW_DELAY_S })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')

    expect(isRestartPendingOrActive('test_bot_1')).toBe(true)
  })

  test('returns true while launchSession is in progress', async () => {
    let launchResolve!: (ok: boolean) => void
    const launchPromise = new Promise<boolean>((res) => { launchResolve = res })

    const deps = makeDeps({ launchSession: () => launchPromise })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS) // timer has fired; launchSession is now awaiting

    expect(isRestartPendingOrActive('test_bot_1')).toBe(true)

    launchResolve(true)
    await Bun.sleep(1) // let finally block run
  })

  test('returns false after launchSession completes successfully', async () => {
    let launchResolve!: (ok: boolean) => void
    const launchPromise = new Promise<boolean>((res) => { launchResolve = res })

    const deps = makeDeps({ launchSession: () => launchPromise })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    launchResolve(true)
    await Bun.sleep(1)

    expect(isRestartPendingOrActive('test_bot_1')).toBe(false)
  })

  test('returns false after launchSession completes with failure', async () => {
    let launchResolve!: (ok: boolean) => void
    const launchPromise = new Promise<boolean>((res) => { launchResolve = res })

    const deps = makeDeps({ launchSession: () => launchPromise })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    launchResolve(false)
    await Bun.sleep(1)

    expect(isRestartPendingOrActive('test_bot_1')).toBe(false)
  })

  test('returns false for different persona while another has restart in progress', async () => {
    let launchResolve!: (ok: boolean) => void
    const launchPromise = new Promise<boolean>((res) => { launchResolve = res })

    const deps = makeDeps({ launchSession: () => launchPromise })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(isRestartPendingOrActive('test_bot_1')).toBe(true)
    expect(isRestartPendingOrActive('test_bot_2')).toBe(false)

    launchResolve(true)
    await Bun.sleep(1)
  })

  test('returns false after cancelAllRestartTimers clears pending timer', () => {
    const deps = makeDeps({ restartDelay: SLOW_DELAY_S })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    expect(isRestartPendingOrActive('test_bot_1')).toBe(true)

    cancelAllRestartTimers()

    expect(isRestartPendingOrActive('test_bot_1')).toBe(false)
  })

  test('regression b.2ir: returns true while isSessionAlive is pending (race window between pendingRestartTimers.delete and activeLaunches.add is closed)', async () => {
    // Before the fix, activeLaunches.add happened after pendingRestartTimers.delete
    // but before the first await (isSessionAlive). During that gap,
    // isRestartPendingOrActive returned false even though a restart was in progress.
    // The fix moves activeLaunches.add immediately after pendingRestartTimers.delete.
    let aliveResolve!: (alive: boolean) => void
    const alivePromise = new Promise<boolean>((res) => { aliveResolve = res })

    const deps: RestartDeps = {
      isSessionAlive: (_key) => alivePromise,  // never resolves until we say so
      isSessionConnected: () => false,
      hasSessionStream: () => true,
      reconnectSession: async () => {},
      killSession: async () => {},
      launchSession: async () => true,
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: (_key) => { /* no-op stub */ },
    }
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS) // timer has fired; isSessionAlive is now awaiting

    // pendingRestartTimers no longer has test_bot_1 (timer removed itself),
    // so the only thing keeping isRestartPendingOrActive true is activeLaunches.
    // Before the fix this returned false; after the fix it must return true.
    expect(isRestartPendingOrActive('test_bot_1')).toBe(true)

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

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS) // launch is now in progress

    expect(isRestartPendingOrActive('test_bot_1')).toBe(true)

    _resetRestartState()

    expect(isRestartPendingOrActive('test_bot_1')).toBe(false)

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

    scheduleRestart('backoff_bot', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(getFailureCount('backoff_bot')).toBe(1)
  })

  test('(1b) launchSession=true resets getFailureCount to 0', async () => {
    const deps = makeDeps({ launchSessionResult: false })
    initRestart(deps)

    // Accumulate a failure first
    scheduleRestart('backoff_bot', '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(getFailureCount('backoff_bot')).toBe(1)

    // Now succeed — deps returns true by default once opts is refreshed
    // Re-init with success result and fire again
    const deps2 = makeDeps({ launchSessionResult: true })
    initRestart(deps2)
    scheduleRestart('backoff_bot', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(getFailureCount('backoff_bot')).toBe(0)
  })

  // -------------------------------------------------------------------------
  // (2) 5 consecutive failures → onCapReached exactly once, no 6th launch
  // -------------------------------------------------------------------------

  test('(2) 5 consecutive failures → onCapReached EXACTLY once; no pending timer after cap', async () => {
    const KEY = 'cap_bot'
    const CAP = 5
    let launchCount = 0

    // Use a custom launchSession that always fails and counts attempts.
    // Use a tiny base delay; each iteration waits long enough for the current
    // backoff delay to fire (min(base*2^i, 900) * 1000 ms + margin).
    const BASE_DELAY_S = 0.001  // 1 ms base — keeps all iterations fast
    const MARGIN_MS = 40        // margin above the computed backoff delay

    const deps = makeDeps({
      restartDelay: BASE_DELAY_S,
      launchSession: async (_key) => {
        launchCount++
        return false
      },
    })
    initRestart(deps)

    // Drive 5 sequential failures: each scheduleRestart fires, fails, increments counter.
    // Wait per iteration = min(BASE_DELAY_S * 2^i, 900) * 1000 ms + MARGIN_MS.
    for (let i = 0; i < CAP; i++) {
      const backoffDelayMs = Math.min(BASE_DELAY_S * Math.pow(2, i), 900) * 1000
      scheduleRestart(KEY, '/cwd/test')
      await Bun.sleep(backoffDelayMs + MARGIN_MS)
    }

    // onCapReached fired exactly once (on the 5th failure)
    expect(deps.onCapReachedCalls).toHaveLength(1)
    expect(deps.onCapReachedCalls[0]).toBe(KEY)

    // getFailureCount is at cap
    expect(getFailureCount(KEY)).toBe(CAP)
    expect(isAtCap(KEY, CAP)).toBe(true)

    // No pending timer after cap — restart.ts returned early without scheduling.
    // This is the load-bearing assertion alongside onCapReachedCalls length 1:
    // once at cap, restart.ts arms no further timer.
    expect(isRestartPendingOrActive(KEY)).toBe(false)

    // NOTE: this test drives exactly CAP scheduleRestart calls, so launchCount==CAP
    // is guaranteed by the driver, not proven by restart.ts. The "no 6th launch"
    // property — that a subsequent health tick does NOT re-launch a capped persona —
    // is the tick-guard's job and is covered in health-check.test.ts.
  })

  // -------------------------------------------------------------------------
  // (3) Post-cap explicit scheduleRestart re-attempts; success resets;
  //     onCapReached did NOT re-fire during the capped episode
  // -------------------------------------------------------------------------

  test('(3) post-cap scheduleRestart re-attempt: success resets isAtCap; onCapReached not re-fired', async () => {
    const KEY = 'cap_then_recover_bot'
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
      scheduleRestart(KEY, '/cwd/test')
      await Bun.sleep(backoffDelayMs + MARGIN_MS)
    }

    expect(isAtCap(KEY, CAP)).toBe(true)
    expect(failingDeps.onCapReachedCalls).toHaveLength(1)

    // Phase 2: an inbound trigger (explicit scheduleRestart — simulates user message
    // re-entering recovery path) causes a successful launch.
    // At this point the failure count is CAP, so nextBackoffDelay = min(0.001 * 2^5, 900) = 0.032s.
    // Use MARGIN_MS=40 which is > 32ms, so the timer fires.
    const recoveringDeps = makeDeps({ restartDelay: BASE_DELAY_S, launchSessionResult: true })
    initRestart(recoveringDeps)

    const backoffAtCap = Math.min(BASE_DELAY_S * Math.pow(2, CAP), 900) * 1000
    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(backoffAtCap + MARGIN_MS)

    // Successful launch resets the cap
    expect(isAtCap(KEY, CAP)).toBe(false)
    expect(getFailureCount(KEY)).toBe(0)

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
    const KEY = 'reconnect_success_bot'

    // Pre-seed a failure count so there is something to reset
    const failDeps = makeDeps({ launchSessionResult: false })
    initRestart(failDeps)
    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(getFailureCount(KEY)).toBe(1)

    // Now simulate alive=true with reconnect returning 'success'
    const reconnectDeps = makeDeps({ isSessionAliveResult: true })
    reconnectDeps.reconnectSession = async (_key) => 'success'
    initRestart(reconnectDeps)

    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(getFailureCount(KEY)).toBe(0)
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
    const KEY = 'reconnect_escalate_bot'

    // Pre-seed a failure so "unchanged" is distinguishable from "reset to 0"
    const failDeps = makeDeps({ launchSessionResult: false })
    initRestart(failDeps)
    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(getFailureCount(KEY)).toBe(1)

    // Simulate alive=true with reconnect returning 'escalate-dead'
    const escapingDeps = makeDeps({ isSessionAliveResult: true })
    escapingDeps.reconnectSession = async (_key) => 'escalate-dead'
    initRestart(escapingDeps)

    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // Counter UNCHANGED at the reconnect site — neither incremented nor reset.
    // No cap accumulation (b.7u6): the escalate-dead tick did not climb the
    // failure count toward the 5-spawn cap, and onCapReached never fired.
    expect(getFailureCount(KEY)).toBe(1)
    expect(isAtCap(KEY, RESTART_FAILURE_CAP)).toBe(false)
    expect(escapingDeps.onCapReachedCalls).toHaveLength(0)
  })

  test('(4c) reconnect result=transient leaves counter unchanged at reconnect site', async () => {
    const KEY = 'reconnect_transient_bot'

    // Pre-seed a failure so "unchanged" is distinguishable from "reset to 0"
    const failDeps = makeDeps({ launchSessionResult: false })
    initRestart(failDeps)
    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(getFailureCount(KEY)).toBe(1)

    const transientDeps = makeDeps({ isSessionAliveResult: true })
    transientDeps.reconnectSession = async (_key) => 'transient'
    initRestart(transientDeps)

    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // Counter unchanged — counting is not done at the reconnect site
    expect(getFailureCount(KEY)).toBe(1)
  })

  test('(4d) reconnect throws (undefined result) — counter unchanged at reconnect site', async () => {
    const KEY = 'reconnect_throw_bot'

    // Pre-seed a failure so "unchanged" is distinguishable from "reset to 0"
    const failDeps = makeDeps({ launchSessionResult: false })
    initRestart(failDeps)
    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(getFailureCount(KEY)).toBe(1)

    const throwingDeps = makeDeps({ isSessionAliveResult: true })
    throwingDeps.reconnectSession = async (_key) => {
      throw new Error('sendKeys failed')
    }
    initRestart(throwingDeps)

    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // Counter unchanged — the catch block sets result=undefined, no recordFailure
    expect(getFailureCount(KEY)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // (5) SR-25.4 no-stacking: pending-timer dedupe still works alongside
  //     backoff. A second scheduleRestart for the same persona cancels the
  //     first timer (cancel-and-replace semantic).
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // (6) b.9a7 — reconnect defer contract. A tick-driven reconnect that returns
  //     'transient' (e.g. the server.ts adapter deferring a `working` session,
  //     hazard 2 / b.rmy) or that fails must not consume the b.7u6 cap and must
  //     leave the persona free for a later tick to retry: no launchSession, no
  //     killSession, no recordFailure, no onCapReached, and no pending timer
  //     re-armed from restart.ts (the tick is the retry driver, not re-entry).
  // -------------------------------------------------------------------------

  test('(6a) b.9a7: alive + reconnect="transient" (working-state defer) does not relaunch or re-arm', async () => {
    // Unique to this case (the "transient leaves the counter unchanged" behavior
    // is already pinned by 4c): the working-state defer takes NO recovery action
    // and restart.ts does NOT re-enter scheduleRestart — the tick is the retry
    // driver. This asserts the observable no-op side of the defer contract.
    const KEY = 'defer_9a7_bot'
    const deps = makeDeps({ isSessionAliveResult: true })
    deps.reconnectSession = async (key) => {
      deps.reconnectSessionCalls.push(key)
      return 'transient'
    }
    initRestart(deps)

    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // Reconnect was attempted, but the defer path leaves the turn undisturbed:
    // no kill, no relaunch.
    expect(deps.reconnectSessionCalls).toEqual([KEY])
    expect(deps.killSessionCalls).toHaveLength(0)
    expect(deps.launchSessionCalls).toHaveLength(0)
    // restart.ts does NOT re-enter scheduleRestart — no pending timer remains;
    // the next health-check tick is the retry driver.
    expect(isRestartPendingOrActive(KEY)).toBe(false)
  })

  test('(6b) b.9a7: repeated reconnect failures never consume the cap (single counting site)', async () => {
    const KEY = 'retry_9a7_bot'
    const deps = makeDeps({ isSessionAliveResult: true })
    // Every reconnect attempt fails (throws → undefined result). Simulate the
    // tick re-driving scheduleRestart many times over.
    deps.reconnectSession = async (key) => {
      deps.reconnectSessionCalls.push(key)
      throw new Error('sendKeys failed')
    }
    initRestart(deps)

    for (let i = 0; i < RESTART_FAILURE_CAP + 3; i++) {
      scheduleRestart(KEY, '/cwd/test')
      await Bun.sleep(WAIT_MS)
    }

    // Reconnect was attempted every time, but the reconnect path never counts a
    // failure, so the cap is never reached despite far more than CAP attempts.
    expect(deps.reconnectSessionCalls.length).toBe(RESTART_FAILURE_CAP + 3)
    expect(getFailureCount(KEY)).toBe(0)
    expect(isAtCap(KEY, RESTART_FAILURE_CAP)).toBe(false)
    expect(deps.onCapReachedCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // (7) b.av2 SR-6.3 — backoff, cap latch and pending timers are per persona
  //     key: capping persona A leaves persona B's state untouched.
  // -------------------------------------------------------------------------

  test('(7) two personas: capping A fires onCapReached once for A; B\'s count, cap latch and pending timer are untouched and B still launches', async () => {
    const A = 'persona_a'
    const B = 'persona_b'
    let bLaunchOk = false
    const deps = makeDeps({
      restartDelay: CAP_BASE_DELAY_S,
      launchSession: async (key) => (key === B ? bLaunchOk : false),
    })
    initRestart(deps)

    // B: one failure on record, then a pending (never-firing) timer.
    await driveFailures(B, '/cwd/b', 1)
    deps.getRestartDelay = () => SLOW_DELAY_S
    scheduleRestart(B, '/cwd/b')
    deps.getRestartDelay = () => CAP_BASE_DELAY_S

    // A: fail to the cap.
    await driveFailures(A, '/cwd/a', RESTART_FAILURE_CAP)

    expect(deps.onCapReachedCalls).toEqual([A])
    expect(getFailureCount(A)).toBe(RESTART_FAILURE_CAP)
    expect(isRestartPendingOrActive(A)).toBe(false)
    // B is exactly as it was: one failure, not at cap, timer still pending.
    expect(getFailureCount(B)).toBe(1)
    expect(isAtCap(B, RESTART_FAILURE_CAP)).toBe(false)
    expect(isRestartPendingOrActive(B)).toBe(true)
    expect(deps.launchSessionCalls.filter((c) => c.key === B)).toHaveLength(1)

    // B still schedules (replacing its pending timer) and launches.
    bLaunchOk = true
    await driveFailures(B, '/cwd/b', 1)
    expect(deps.launchSessionCalls.filter((c) => c.key === B)).toHaveLength(2)
    expect(getFailureCount(B)).toBe(0)
    expect(getFailureCount(A)).toBe(RESTART_FAILURE_CAP)

    // A's cap latch is A's alone: B reaching the cap notifies for B too.
    bLaunchOk = false
    await driveFailures(B, '/cwd/b', RESTART_FAILURE_CAP)
    expect(deps.onCapReachedCalls).toEqual([A, B])
  })

  test('(5) SR-25.4 no-stacking: second scheduleRestart cancels first pending timer (cancel-and-replace)', async () => {
    const deps = makeDeps({ restartDelay: SLOW_DELAY_S, launchSessionResult: false })
    initRestart(deps)

    scheduleRestart('nostack_bot', '/cwd/test')
    expect(isRestartPendingOrActive('nostack_bot')).toBe(true)

    // A second call cancels the first and replaces it — still one pending timer
    scheduleRestart('nostack_bot', '/cwd/test')
    expect(isRestartPendingOrActive('nostack_bot')).toBe(true)

    // Only one pending timer exists (cancel-and-replace): counter has not changed
    // because no timer has fired yet
    expect(getFailureCount('nostack_bot')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Restart cap notice (b.av2 SR-7.2) — `onCapReached` calls the session
// manager's `notifyRestartCapReached`, which goes through the real per-persona
// notifier installed with `setSessionNotifier`. Each persona has its own stub
// Slack, so the post's client, destination and text are all observable.
// ---------------------------------------------------------------------------

describe('restart cap notice goes to the persona destination (b.av2 SR-7.2)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restart-cap-notice-'))
  })

  afterEach(() => {
    setSessionNotifier(undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Two personas and the real notifier over one stub Slack each, installed
   * with `setSessionNotifier`. A's destination is its second channel, so a
   * post to "the channel" (its first) is distinguishable from a post to the
   * destination.
   */
  function setupCapNotice(): { a: Persona; b: Persona; h: NotifierHarness } {
    const config = makeMultiPersonaConfig([
      {
        name: 'Alpha Bot',
        channels: [{ id: 'C0ALPHA01', delivery: 'all' }, { id: 'C0ALPHAPR', delivery: 'all' }],
        permission_prompts: 'C0ALPHAPR',
      },
      { name: 'beta_bot' },
    ], dir)
    const [a, b] = config.personas as [Persona, Persona]
    const h = makeNotifierHarness(config)
    setSessionNotifier(h.notifier.notify)
    return { a, b, h }
  }

  /** Let the fire-and-forget cap notice post settle. */
  async function settleNotices(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  test('cap for persona A posts exactly one notice on A\'s client to A\'s permission_prompts channel, naming A; nothing on B', async () => {
    const { a, b, h } = setupCapNotice()

    const deps = makeDeps({
      restartDelay: CAP_BASE_DELAY_S,
      launchSessionResult: false,
      onCapReached: notifyRestartCapReached,
    })
    initRestart(deps)

    await driveFailures(a.key, a.working_directory, RESTART_FAILURE_CAP)

    expect(deps.onCapReachedCalls).toEqual([a.key])
    const posts = h.posts(a.key)
    expect(posts).toEqual([{ channel: 'C0ALPHAPR', text: expect.any(String) }])
    expect(h.posts(b.key)).toHaveLength(0)
    expect(h.logs).toEqual([])

    const text = posts[0]!.text
    expect(text.startsWith(`Persona ${renderPersonaRef(a.name, a.key)}: `)).toBe(true)
    expect(text).toContain('`SpawnCapReached`')
    expect(text).not.toMatch(/this channel/i)
    for (const id of ['C0ALPHA01', 'C0ALPHAPR']) expect(text).not.toContain(id)
  })

  test('a further failed re-attempt after the cap was reached and notified does not notify again (PM N7)', async () => {
    const { a, b, h } = setupCapNotice()

    const deps = makeDeps({
      restartDelay: CAP_BASE_DELAY_S,
      launchSessionResult: false,
      onCapReached: notifyRestartCapReached,
    })
    initRestart(deps)

    await driveFailures(a.key, a.working_directory, RESTART_FAILURE_CAP)
    await settleNotices()
    expect(deps.onCapReachedCalls).toEqual([a.key])
    expect(h.posts(a.key)).toHaveLength(1)

    // An explicit re-attempt (e.g. an inbound message) while capped fails again:
    // the failure is counted, but the once-per-episode latch holds.
    await driveFailures(a.key, a.working_directory, 1)
    await settleNotices()

    expect(deps.launchSessionCalls.filter((c) => c.key === a.key)).toHaveLength(RESTART_FAILURE_CAP + 1)
    expect(getFailureCount(a.key)).toBe(RESTART_FAILURE_CAP + 1)
    expect(deps.onCapReachedCalls).toEqual([a.key])
    expect(h.posts(a.key)).toHaveLength(1)
    expect(h.posts(b.key)).toHaveLength(0)
    expect(h.logs).toEqual([])
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
    statusCalls: StatusParams[]
    sendKeysCalls: SendKeysParams[]
    setAlive: (v: boolean) => void
  } {
    let alive = true
    const killSessionCalls: string[] = []
    const launchSessionCalls: string[] = []
    const findMissingCalls: FindMissingParams[] = []
    const statusCalls: StatusParams[] = []
    const sendKeysCalls: SendKeysParams[] = []

    // Non-working status → adapter falls through to reconnectMcp; persistent
    // ErrTmuxSendKeys on send-keys (ensurer stubbed no-op) → 'dead-session'
    // → adapter maps to 'escalate-dead' and fires the internal sweep.
    const stub = makeStubClient({
      statusFn: () => ({ state: 'waiting' }),
      statusCalls,
      sendKeysError: errTmuxSendKeys(),
      sendKeysCalls,
      findMissingCalls,
    })
    _resetOutageState()
    initOutageState({
      notify: () => {},
      getClient: () => stub as unknown as Client,
    })
    setClientForTests(stub as unknown as Client)
    _setTmuxServerEnsurer(async () => {})

    // The adapter resolves the instance ID from the persona key alone
    // (b.av2 SR-2.2) — the stand-in key is the channel ID, C_DEADTMUX.
    const reconnectSession = _buildReconnectSessionAdapter()

    const deps: RestartDeps & { killSessionCalls: string[]; launchSessionCalls: string[] } = {
      killSessionCalls,
      launchSessionCalls,
      async isSessionAlive() { return alive },
      isSessionConnected() { return false },
      hasSessionStream() { return true },
      reconnectSession,
      async killSession(key) { killSessionCalls.push(key) },
      async launchSession(key) { launchSessionCalls.push(key); return true },
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: () => {},
    }
    return { deps, findMissingCalls, statusCalls, sendKeysCalls, setAlive: (v: boolean) => { alive = v } }
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
    const KEY = 'C_DEADTMUX'
    const { deps, findMissingCalls, statusCalls, sendKeysCalls, setAlive } = makeRealAdapterDeps()
    initRestart(deps)

    // --- Tick 1: row still looks alive; the real adapter runs reconnectMcp,
    // which returns 'dead-session' → 'escalate-dead', firing the internal sweep.
    setAlive(true)
    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // The existing memoized sweep ran exactly once — this is CSCB's own recovery,
    // not the external loop (absent by construction). The escalate-dead verdict
    // takes NO relaunch action on this tick.
    expect(findMissingCalls).toHaveLength(1)
    expect(deps.killSessionCalls).toHaveLength(0)
    expect(deps.launchSessionCalls).toHaveLength(0)
    // Single counting site: escalate-dead never records a failure.
    expect(getFailureCount(KEY)).toBe(0)
    expect(isAtCap(KEY, RESTART_FAILURE_CAP)).toBe(false)
    // The adapter's AD calls address the persona's cscb_<key> instance: one
    // status probe, then the send-keys reconnect and its one self-heal retry.
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(KEY)])
    expect(sendKeysCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C_DEADTMUX', 'cscb_C_DEADTMUX'])

    // --- Tick 2: the sweep has (in production) reconciled the row to `missing`,
    // so the next tick observes the session dead. The normal kill+relaunch
    // branch runs. Reset the memo so this tick's semantics don't depend on the
    // prior sweep's TTL — we are simulating a LATER tick past the memo window.
    _resetFindMissingMemo()
    setAlive(false)
    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.killSessionCalls).toEqual([KEY])
    expect(deps.launchSessionCalls).toEqual([KEY])
  })
})

// ---------------------------------------------------------------------------
// Restart-triggered launches: one in flight per persona (b.av2 SR-6.3, SR-6.6,
// SR-14 row 4). `RestartDeps.launchSession` is the session manager's REAL
// launch adapter, so each restart launch goes through `spawnForPersona`'s
// per-persona single-flight, and `RestartDeps.killSession` is server.ts's REAL
// kill adapter (`_buildKillSessionAdapter`). restart.ts itself does not stop a
// second timer for a persona whose launch is still running: the kill adapter
// must not kill the session that launch is bringing up, and the session
// manager must join that launch instead of starting a second ladder.
//
// `holdSpawns` keeps the stub AD client's `spawn` open per instance ID, so a
// launch can be kept in flight while a second restart fires. `status` answers
// `waiting`, so the dialog approver returns at once. Every raw-tmux seam is a
// no-op, the `config_dir` label derives from a temp home, and every persona
// path lies under a temp directory removed in afterEach.
// ---------------------------------------------------------------------------

describe('restart: one in-flight launch per persona (b.av2 SR-6.3, SR-6.6)', () => {
  let dir: string
  let config: PersonaConfig
  let a: Persona
  let b: Persona
  /** Instance IDs whose `spawn` is held open until released. */
  let holdIds: Set<string>
  let hold: SpawnHold
  /** Every `kill` the stub AD client received. */
  let killCalls: KillParams[]
  /** Each boolean restart received from `launchSession`, in settle order. */
  let launchResults: Array<{ key: string; ok: boolean }>
  /** Session-manager notices (spawn-failure notices land here). */
  let notices: Array<{ key: string; text: string }>
  /** console.error lines written during the test. */
  let errLines: string[]
  let origConsoleError: typeof console.error

  function spawnsFor(p: Persona): SpawnParams[] {
    return hold.calls.filter((c) => c.claude_instance_id === personaInstanceId(p.key))
  }

  function killsFor(p: Persona): number {
    return killCalls.filter((k) => k.claude_instance_id === personaInstanceId(p.key)).length
  }

  function skipLine(p: Persona): string {
    return `[slack] killSession (restart adapter): launch already in flight for persona=${p.key} — not killing`
  }

  /** Restart deps over the real kill and launch adapters, recording each boolean restart receives. */
  function makeInFlightDeps(): ReturnType<typeof makeDeps> {
    return makeDeps({
      killSession: _buildKillSessionAdapter(),
      launchSession: async (key) => {
        const ok = await launchPersonaSession(key, config)
        launchResults.push({ key, ok })
        return ok
      },
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restart-inflight-'))
    config = makeMultiPersonaConfig([{ name: 'alpha_bot' }, { name: 'beta_bot' }], dir)
    ;[a, b] = config.personas as [Persona, Persona]
    holdIds = new Set()
    killCalls = []
    launchResults = []
    notices = []
    errLines = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }

    const stub = makeStubClient({ statusFn: () => ({ state: 'waiting' }), killCalls })
    hold = holdSpawns(stub, (id) => holdIds.has(id))
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    setSessionNotifier((key, text) => { notices.push({ key, text }) })

    _resetInFlightLaunches()
    _setSpawnHomeDir(dir)
    _setDialogPollIntervalMs(1)
    _setDialogReadyTimeoutMs(200)
    _setTmuxCapturePane(async () => '')
    _setTmuxSendEnter(async () => {})
    _setTmuxSessionProber(async () => true)
    _setTmuxServerEnsurer(async () => {})
  })

  afterEach(async () => {
    // Let any launch a failed assertion left held settle before tearing down.
    hold.releaseAll()
    await Bun.sleep(WAIT_MS)
    console.error = origConsoleError
    cancelAllRestartTimers()
    _resetInFlightLaunches()
    resetClientForTests()
    _resetOutageState()
    setSessionNotifier(undefined)
    _resetSpawnHomeDir()
    _resetDialogPollIntervalMs()
    _resetDialogReadyTimeoutMs()
    _resetTmuxDialogHelpers()
    _resetTmuxSessionProber()
    _resetTmuxServerEnsurer()
    rmSync(dir, { recursive: true, force: true })
  })

  test('kill adapter: no kill for a persona whose launch is in flight (skip logged); another persona is killed meanwhile; kills once the launch settles', async () => {
    holdIds.add(personaInstanceId(a.key))
    const launch = launchPersonaSession(a.key, config)
    await hold.entered(personaInstanceId(a.key))
    expect(isLaunchInFlight(a.key)).toBe(true)
    const killSession = _buildKillSessionAdapter()

    await killSession(a.key)
    expect(killCalls).toEqual([])
    expect(errLines).toContain(skipLine(a))

    await killSession(b.key)
    expect(killCalls.map((k) => k.claude_instance_id)).toEqual([personaInstanceId(b.key)])
    expect(errLines).not.toContain(skipLine(b))

    hold.release(personaInstanceId(a.key))
    expect(await launch).toBe(true)
    expect(isLaunchInFlight(a.key)).toBe(false)
    await killSession(a.key)
    expect(killCalls.map((k) => k.claude_instance_id)).toEqual([personaInstanceId(b.key), personaInstanceId(a.key)])
    expect(errLines.filter((l) => l === skipLine(a))).toHaveLength(1)
  })

  test('same persona: a second restart while the first launch is held neither kills it nor spawns again — it joins; both launches resolve alike; a later restart kills and spawns again', async () => {
    const deps = makeInFlightDeps()
    initRestart(deps)
    holdIds.add(personaInstanceId(a.key))

    // First restart: nothing in flight, so A is killed; its launch is then held inside `spawn`.
    scheduleRestart(a.key, a.working_directory)
    await Bun.sleep(WAIT_MS)
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([a.key])
    expect(killsFor(a)).toBe(1)
    expect(spawnsFor(a)).toHaveLength(1)
    expect(launchResults).toEqual([])

    // Second restart for A fires while the first launch is still in flight:
    // restart asks for a kill, the adapter skips it, and the launch joins.
    scheduleRestart(a.key, a.working_directory)
    await Bun.sleep(WAIT_MS)
    expect(deps.killSessionCalls).toEqual([a.key, a.key])
    expect(killsFor(a)).toBe(1)
    expect(errLines).toContain(skipLine(a))
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([a.key, a.key])
    expect(spawnsFor(a)).toHaveLength(1)
    expect(hold.held()).toHaveLength(1)
    expect(launchResults).toEqual([])

    // Release the one held spawn: both launchSession calls resolve true.
    hold.release(personaInstanceId(a.key))
    await Bun.sleep(WAIT_MS)
    expect(launchResults).toEqual([{ key: a.key, ok: true }, { key: a.key, ok: true }])
    expect(spawnsFor(a)).toHaveLength(1)
    expect(getFailureCount(a.key)).toBe(0)
    expect(isRestartPendingOrActive(a.key)).toBe(false)

    // The launch has settled: a further restart for A kills and starts a new ladder.
    holdIds.clear()
    scheduleRestart(a.key, a.working_directory)
    await Bun.sleep(WAIT_MS)
    expect(killsFor(a)).toBe(2)
    expect(spawnsFor(a)).toHaveLength(2)
    expect(launchResults).toHaveLength(3)
    expect(launchResults[2]).toEqual({ key: a.key, ok: true })
    expect(hold.calls.every((c) => c.claude_instance_id === personaInstanceId(a.key))).toBe(true)
    expect(errLines.filter((l) => l === skipLine(a))).toHaveLength(1)
  })

  test('same persona: a joined launch that fails counts one failure per launchSession boolean restart receives (single counting site)', async () => {
    const deps = makeInFlightDeps()
    initRestart(deps)
    holdIds.add(personaInstanceId(a.key))

    scheduleRestart(a.key, a.working_directory)
    await Bun.sleep(WAIT_MS)
    scheduleRestart(a.key, a.working_directory)
    await Bun.sleep(WAIT_MS)
    expect(deps.launchSessionCalls).toHaveLength(2)
    expect(killsFor(a)).toBe(1)
    expect(spawnsFor(a)).toHaveLength(1)
    expect(getFailureCount(a.key)).toBe(0)

    // The one held spawn fails: the one shared ladder returns `failed`, so
    // each launchSession call hands restart `false`, and each is counted.
    hold.fail(personaInstanceId(a.key), errGeneric('spawn', 'ErrSomethingElse', 'spawn blew up'))
    await Bun.sleep(WAIT_MS)
    expect(launchResults).toEqual([{ key: a.key, ok: false }, { key: a.key, ok: false }])
    expect(getFailureCount(a.key)).toBe(2)
    expect(spawnsFor(a)).toHaveLength(1)
    // One ladder ran, so one spawn-failure notice, for A.
    expect(notices.map((n) => n.key)).toEqual([a.key])
    expect(notices[0]!.text).toContain('ErrSomethingElse')
  })

  test('different persona: while A\'s launch is held, a restart for B kills and spawns B and completes without waiting for A', async () => {
    const deps = makeInFlightDeps()
    initRestart(deps)
    holdIds.add(personaInstanceId(a.key))

    scheduleRestart(a.key, a.working_directory)
    await Bun.sleep(WAIT_MS)
    expect(spawnsFor(a)).toHaveLength(1)
    expect(launchResults).toEqual([])

    scheduleRestart(b.key, b.working_directory)
    await Bun.sleep(WAIT_MS)
    // B was killed (no launch of B in flight), its spawn was issued, addressed
    // to B, and B's launch completed while A's spawn is still held.
    expect(killsFor(b)).toBe(1)
    expect(errLines).not.toContain(skipLine(b))
    expect(spawnsFor(b)).toHaveLength(1)
    expect(spawnsFor(b)[0]!.cwd).toBe(b.working_directory)
    expect(launchResults).toEqual([{ key: b.key, ok: true }])
    expect(hold.held()).toEqual([personaInstanceId(a.key)])
    expect(getFailureCount(b.key)).toBe(0)

    hold.release(personaInstanceId(a.key))
    await Bun.sleep(WAIT_MS)
    expect(launchResults).toEqual([{ key: b.key, ok: true }, { key: a.key, ok: true }])
    expect(spawnsFor(a)).toHaveLength(1)
    expect(spawnsFor(b)).toHaveLength(1)
  })
})
