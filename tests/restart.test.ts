/**
 * restart.test.ts — Tests for auto-restart scheduling logic.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initRestart,
  scheduleRestart,
  cancelAllRestartTimers,
  cancelRestartTimer,
  _resetRestartState,
  isRestartPendingOrActive,
  RESTART_FAILURE_CAP,
  type RestartDeps,
} from '../src/restart.ts'
import {
  _resetBackoffState,
  getFailureCount,
  isAtCap,
  recordFailure,
} from '../src/backoff.ts'
import { _buildIsSessionAliveAdapter, _buildKillSessionAdapter, _buildReconnectSessionAdapter } from '../src/server.ts'
import { createPersonaRelaunchGate } from '../src/persona-start.ts'
import { createPersonaSerializer, type PersonaSerialize } from '../src/persona-serializer.ts'
import type { PersonaConnectionStatus } from '../src/persona-connections.ts'
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
  _resetPreLaunchReplyGuard,
  _setConfigDirFs,
  _resetConfigDirFs,
  checkLaunchConfigDir,
  setConfigDirUnresolvableHook,
  spawnForPersona,
  type ConfigDirUnresolvableHook,
} from '../src/session-manager.ts'
import { createPersonaBringUpController, type PersonaBringUpController } from '../src/persona-bringup-controller.ts'
import { PERSONA_CONFIG_DIR_UNRESOLVABLE } from '../src/persona-diagnostics.ts'
import { makeConnectionHarness, type ConnectionHarness } from './test-helpers/persona-connection-harness.ts'
import { APP_TOKEN_PREFIX, LEAK_SENTINEL, REDACTED_SENTINEL_TAIL, assertNoLeak, fakeToken, sentinelInMessage } from './test-helpers/credentials.ts'
import { _resetLaunchedWithDirs, getLaunchedWithDir } from '../src/stop-hook-bootstrap.ts'
import { makeReplyGuardRecordDir, type ReplyGuardRecordDir } from './test-helpers/reply-guard-record.ts'
import { installRecordingReplyGuard, observeLaunchCalls, type LaunchCall } from './test-helpers/reply-guard-launch.ts'
import {
  setClientForTests,
  resetClientForTests,
} from '../src/agent-director-client.ts'
import {
  _resetOutageState,
  initOutageState,
} from '../src/outage-state.ts'
import { makeStubClient } from './test-helpers/agent-director-stub.ts'
import {
  cannedErr,
  cannedOk,
  cannedGetResult,
  errGeneric,
  errInstanceIdCollision,
  errSpawnNotFound,
  errSpawnNotInteractive,
  errTmuxSendKeys,
  holdSpawns,
  makeStubCallLog,
  type SpawnHold,
  type StubCallLog,
} from './test-helpers/agent-director-stub.ts'
import type { Client } from 'agent-director'
import type { DeleteParams, FindMissingParams, KillParams, ResumeParams, SendKeysParams, SpawnParams, SpawnResult, StatusParams } from 'agent-director'
import { configDirLabelValue, personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness, type NotifierHarness } from './test-helpers/persona-notifier.ts'
import { stubOpenedDmId, type StubWebMethod } from './test-helpers/slack-stub.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
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
  launchSessionResult?: boolean | 'skipped'  // default: true (launch succeeds); 'skipped': the relaunch gate declined
  launchSession?: (key: string, cwd: string, sessionId?: string) => Promise<boolean | 'skipped'>  // override entire launchSession
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

    canRestart: () => true,
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

// No test outside the reply-guard block installs the pre-launch reply guard,
// so no other launch here writes a record; reset it (and the launched-with
// dirs) after every test all the same.
afterEach(() => {
  _resetPreLaunchReplyGuard()
  _resetLaunchedWithDirs()
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

  // AC 20 (b.av2 SR-10.3): each dep failure the timer's work catches is logged
  // as its description (type, safe code, message through `redactSlackLogText`,
  // frames), never the error itself. The thrown error carries fake tokens in
  // its message (with a `ticket=` URL) and properties, and every console.error
  // argument is kept unformatted.
  test.each<[string, 'isSessionAlive' | 'reconnectSession' | 'launchSession', DepsOpts, string]>([
    ['isSessionAlive throws', 'isSessionAlive', {}, 'isSessionAlive failed'],
    ['reconnectSession throws (session alive)', 'reconnectSession', { isSessionAliveResult: true }, 'reconnectSession failed'],
    ['launchSession throws', 'launchSession', {}, 'launchSession threw'],
  ])('AC 20: %s with an error carrying fake tokens — one line naming its type, code and redacted message; nothing leaks', async (_label, dep, opts, phrase) => {
    const deps = makeDeps(opts)
    deps[dep] = async () => {
      throw Object.assign(new Error(`${dep} refused (${sentinelInMessage('msg')})`), {
        code: 'EIO',
        detail: fakeToken(APP_TOKEN_PREFIX, 'detail'),
        note: LEAK_SENTINEL,
      })
    }
    initRestart(deps)
    const errArgs: unknown[][] = []
    const origConsoleError = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args) }
    try {
      scheduleRestart('test_bot_1', '/cwd/test')
      await Bun.sleep(WAIT_MS)
    } finally {
      console.error = origConsoleError
    }

    const lines = errArgs.filter((args) => String(args[0]).includes(phrase))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveLength(1)
    expect(String(lines[0]![0])).toStartWith(
      `[slack] restart: ${phrase} for persona=test_bot_1: Error code=EIO message="${dep} refused (${REDACTED_SENTINEL_TAIL})" at `,
    )
    assertNoLeak({ errArgs })
  })

  // Shutdown at schedule time (no timer armed, the gate not asked) is pinned in
  // the not-up guard block below; this is shutdown starting after scheduling.
  test('shutdown starts after the restart was scheduled — the timer fires, asks neither the gate nor the probe, and kills, reconnects and launches nothing', async () => {
    let shuttingDown = false
    const gateAsked: string[] = []
    const deps = makeDeps()
    deps.isShuttingDown = () => shuttingDown
    deps.canRestart = (key) => { gateAsked.push(key); return true }
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    expect(isRestartPendingOrActive('test_bot_1')).toBe(true)
    expect(gateAsked).toEqual(['test_bot_1'])

    shuttingDown = true
    const lines: string[] = []
    const origConsoleError = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    try {
      await Bun.sleep(WAIT_MS)
    } finally {
      console.error = origConsoleError
    }

    // Only the schedule-time gate check: the timer returned at its shutdown check.
    expect(lines).toEqual(['[slack] Skipping restart — server is shutting down (persona=test_bot_1)'])
    expect(gateAsked).toEqual(['test_bot_1'])
    expect(deps.isSessionAliveCalls).toHaveLength(0)
    expect(deps.reconnectSessionCalls).toHaveLength(0)
    expect(deps.killSessionCalls).toHaveLength(0)
    expect(deps.launchSessionCalls).toHaveLength(0)
    expect(getFailureCount('test_bot_1')).toBe(0)
    expect(isRestartPendingOrActive('test_bot_1')).toBe(false)
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
// cancelRestartTimer — one persona's pending timer (b.av2 SR-6.5, a teardown)
//
// The teardown cancels the persona's pending timer; its failure count and cap
// latch are forgotten separately (`forgetFailures`, backoff.test.ts), so the
// cancel itself records no success or failure.
// ---------------------------------------------------------------------------

describe('cancelRestartTimer — per-persona clear (b.av2 SR-6.5)', () => {
  const A = 'persona_a'
  const B = 'persona_b'
  let errLines: string[]
  let origConsoleError: typeof console.error

  beforeEach(() => {
    errLines = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.error = origConsoleError
  })

  const cancelledLines = () => errLines.filter((l) => l.startsWith('[slack] Cancelled restart timer'))

  test('cancels B\'s pending timer so it never fires (no probe, reconnect, kill or launch; B\'s count untouched); A\'s timer still fires and A restarts; logged once, only when a timer was pending', async () => {
    recordFailure(A)
    recordFailure(B)
    recordFailure(B)
    const deps = makeDeps({ restartDelay: CAP_BASE_DELAY_S })
    initRestart(deps)
    scheduleRestart(A, '/cwd/a')
    scheduleRestart(B, '/cwd/b')

    expect(cancelRestartTimer(B)).toBe(true)
    expect(isRestartPendingOrActive(B)).toBe(false)
    expect(isRestartPendingOrActive(A)).toBe(true)
    expect(cancelRestartTimer(B)).toBe(false)           // nothing pending any more
    expect(cancelRestartTimer('never_scheduled')).toBe(false)
    expect(cancelledLines()).toEqual([`[slack] Cancelled restart timer for persona=${B}`])

    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toEqual([A])
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls).toEqual([A])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([A])
    expect(getFailureCount(A)).toBe(0)                  // A's launch succeeded
    expect(getFailureCount(B)).toBe(2)                  // the cancel is neither success nor failure
    expect(isRestartPendingOrActive(B)).toBe(false)
    expect(cancelledLines()).toHaveLength(1)
  })

  test('work that already started is left alone: cancelRestartTimer returns false and the running restart still launches', async () => {
    let releaseLaunch!: (ok: boolean) => void
    const deps = makeDeps({ launchSession: () => new Promise<boolean>((res) => { releaseLaunch = res }) })
    initRestart(deps)
    scheduleRestart(B, '/cwd/b')
    await Bun.sleep(WAIT_MS)                            // fired; the launch is held

    expect(cancelRestartTimer(B)).toBe(false)
    expect(isRestartPendingOrActive(B)).toBe(true)
    expect(cancelledLines()).toEqual([])

    releaseLaunch(true)
    await Bun.sleep(1)
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([B])
    expect(isRestartPendingOrActive(B)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// RestartDeps.serialize — a fired timer's work runs through the per-persona
// lifecycle serializer (b.av2 SR-6.6). While it waits behind another
// operation for the same persona the restart counts as active, and its
// shutdown and not-up checks run when the work starts, not when it fired.
// ---------------------------------------------------------------------------

describe('RestartDeps.serialize — the timer\'s work waits behind the persona\'s running operation (b.av2 SR-6.6)', () => {
  const A = 'persona_a'
  const B = 'persona_b'
  const skipLine = `[slack] Skipping restart for persona=${B} — the persona is no longer up; its instance is left as it is`
  const shutdownLine = `[slack] Skipping restart — server is shutting down (persona=${B})`
  let errLines: string[]
  let origConsoleError: typeof console.error

  beforeEach(() => {
    errLines = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.error = origConsoleError
  })

  test.each<[string, 'none' | 'shutdown' | 'not-up']>([
    ['nothing changes while queued: the work probes, kills and relaunches B once released', 'none'],
    ['shutdown starts while queued: the work skips at its shutdown check, before the gate', 'shutdown'],
    ['B stops being up while queued: the work skips at its not-up check', 'not-up'],
  ])('B\'s fired restart is submitted for B, does nothing while B\'s earlier operation runs, and counts as active; A restarts meanwhile — %s', async (_label, change) => {
    let shuttingDown = false
    const up = new Set([A, B])
    const asked: string[] = []
    const submitted: string[] = []
    const serializer = createPersonaSerializer()
    const serialize: PersonaSerialize = (key, op) => { submitted.push(key); return serializer.run(key, op) }
    const deps = makeDeps({ restartDelay: CAP_BASE_DELAY_S })
    deps.isShuttingDown = () => shuttingDown
    deps.canRestart = (key) => { asked.push(key); return up.has(key) }
    deps.serialize = serialize
    initRestart(deps)

    // An earlier operation for B (a teardown, a bring-up retry's launch) is running.
    let releaseEarlier!: () => void
    const earlier = serializer.run(B, () => new Promise<void>((res) => { releaseEarlier = res }))

    scheduleRestart(B, '/cwd/b')
    scheduleRestart(A, '/cwd/a')
    await Bun.sleep(WAIT_MS)

    // Both timers fired and submitted their work; A's ran, B's waits.
    expect(submitted.sort()).toEqual([A, B])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([A])
    expect(deps.isSessionAliveCalls).toEqual([A])
    expect(asked.filter((k) => k === B)).toEqual([B])   // only at scheduling
    expect(isRestartPendingOrActive(B)).toBe(true)
    expect(isRestartPendingOrActive(A)).toBe(false)

    if (change === 'shutdown') shuttingDown = true
    if (change === 'not-up') up.delete(B)
    releaseEarlier()
    await earlier
    await Bun.sleep(WAIT_MS)

    const bLines = errLines.filter((l) => l.includes(`persona=${B}`) && !l.startsWith('[slack] Scheduling restart'))
    if (change === 'none') {
      expect(deps.isSessionAliveCalls).toEqual([A, B])
      expect(deps.killSessionCalls).toEqual([A, B])
      expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([A, B])
      expect(asked.filter((k) => k === B)).toEqual([B, B, B])
      expect(bLines).toEqual([`[slack] Relaunching session for persona=${B} cwd="/cwd/b"`])
    } else {
      expect(deps.isSessionAliveCalls).toEqual([A])
      expect(deps.killSessionCalls).toEqual([A])
      expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([A])
      expect(asked.filter((k) => k === B)).toEqual(change === 'shutdown' ? [B] : [B, B])
      expect(bLines).toEqual([change === 'shutdown' ? shutdownLine : skipLine])
    }
    expect(getFailureCount(B)).toBe(0)
    expect(isRestartPendingOrActive(B)).toBe(false)
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
      canRestart: () => true,
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
  //     A non-success reconnect outcome ('escalate-dead' or 'transient') does NOT
  //     re-enter scheduleRestart. For 'escalate-dead' (dead-tmux) the adapter
  //     upstream fires CSCB's internal reconcileMissingSweep so the frozen
  //     `working` row reconciles to `missing`; the same restart run then probes
  //     liveness again and, when the row reads dead, takes the kill+relaunch
  //     branch at once (b.d61; a row that still reads alive is left to a later
  //     tick) — recovery is internal, not deferred to the external
  //     ~/startup/find-missing-loop.sh (belt-and-braces only; Epic t1.tkk.e4 /
  //     b.sv7). Whether or not that sweep fires, the reconnect verdict path still
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
    // through the adapter's reconcileMissingSweep (Epic t1.tkk.e4 / b.sv7). Here
    // the liveness re-probe that follows the verdict (b.d61) still reads alive,
    // so this run relaunches nothing and a later tick retries; the re-probe that
    // reads dead and relaunches in the same run is pinned in the b.d61 re-probe
    // block below. The lone place failures are counted is the
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

  // -------------------------------------------------------------------------
  // (8) The relaunch gate at the launch: launchSession answers 'skipped' when
  //     the persona stopped being up after the timer's last `canRestart`
  //     check (the one right after the liveness probe; true here, the
  //     makeDeps default), i.e. during the kill, before the launch. Nothing
  //     was attempted, so the counter, backoff and cap latch are left exactly
  //     as they were. A persona that is not up at either timer check (before
  //     or after the probe) never reaches the kill or the launch: see the
  //     not-up guard block below.
  // -------------------------------------------------------------------------

  const GATED = 'gated_bot'
  test.each<[string, boolean, number, string[]]>([
    ['a failed launch counts: the count reaches the cap and the cap notice fires once', false, RESTART_FAILURE_CAP, [GATED]],
    ['a successful launch resets the count', true, 0, []],
  ])('(8) launchSession=skipped is neither a success nor a failure (no reset, no count, no cap); the next serving restart counts — %s', async (_label, next, count, capCalls) => {
    for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(GATED)
    let outcome: boolean | 'skipped' = 'skipped'
    const deps = makeDeps({ restartDelay: CAP_BASE_DELAY_S, launchSession: async () => outcome })
    initRestart(deps)

    // Two declined restarts: one short of the cap, a counted failure would cap it.
    await driveFailures(GATED, '/cwd/gated', 2)

    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([GATED, GATED])
    // The gate was still open at both timer checks (before and after the
    // liveness probe), so the kill ran; only the launch saw the flip. (Not up
    // at either check: no kill, pinned in the not-up guard block below.)
    expect(deps.killSessionCalls).toEqual([GATED, GATED])
    expect(getFailureCount(GATED)).toBe(RESTART_FAILURE_CAP - 1)
    expect(isAtCap(GATED, RESTART_FAILURE_CAP)).toBe(false)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(isRestartPendingOrActive(GATED)).toBe(false)

    // Serving again: the next restart's launch counts as usual.
    outcome = next
    await driveFailures(GATED, '/cwd/gated', 1)

    expect(deps.launchSessionCalls).toHaveLength(3)
    expect(getFailureCount(GATED)).toBe(count)
    expect(deps.onCapReachedCalls).toEqual(capCalls)
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
// The not-up guard (b.av2 SR-6.3, SR-6.4): a persona that is not up (broken,
// or retrying its bring-up) keeps its agent-director row and its running
// instance. `RestartDeps.canRestart` is asked when a restart is scheduled
// (unless restarts are disabled or the server is shutting down), when
// its timer fires (before the liveness probe) and again after the probe
// (before the reconnect or the kill). The case that matters is a restart scheduled while the persona was
// up that fires after it became broken (e.g. Slack refused a token on a
// reopen, SR-3.3). The persona's failure count and cap latch are never
// touched by the guard, so an up persona follows today's backoff and cap.
// ---------------------------------------------------------------------------

describe('not-up guard: a persona that is not up is never restarted (b.av2 SR-6.4)', () => {
  const KEY = 'notup_bot'
  const OTHER = 'up_bot'
  /** Personas the fake gate answers true for. */
  let up: Set<string>
  /** Every key `canRestart` was asked about, in order. */
  let asked: string[]
  let errLines: string[]
  let origConsoleError: typeof console.error

  const skipLine = (key: string) =>
    `[slack] Skipping restart for persona=${key} — the persona is no longer up; its instance is left as it is`
  const refuseLine = (key: string) =>
    `[slack] Not scheduling restart for persona=${key} — the relaunch gate refused it (the persona is not up, or is no longer in the applied configuration)`
  const linesFor = (key: string, prefix: string) =>
    errLines.filter((l) => l.startsWith(prefix) && l.includes(`persona=${key}`))

  /** makeDeps with `canRestart` answering from `up` and recording each key asked. */
  function makeGatedDeps(opts: DepsOpts = {}): ReturnType<typeof makeDeps> {
    const deps = makeDeps({ restartDelay: CAP_BASE_DELAY_S, ...opts })
    deps.canRestart = (key) => {
      asked.push(key)
      return up.has(key)
    }
    return deps
  }

  /** Wait out the timer `scheduleRestart(key)` armed from the key's current failure count. */
  async function waitForTimer(key: string): Promise<void> {
    await Bun.sleep(Math.min(CAP_BASE_DELAY_S * Math.pow(2, getFailureCount(key)), 900) * 1000 + CAP_MARGIN_MS)
  }

  beforeEach(() => {
    up = new Set([KEY, OTHER])
    asked = []
    errLines = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.error = origConsoleError
    cancelAllRestartTimers()
  })

  test.each<[string, boolean]>([
    ['its session dead (the kill + relaunch branch)', false],
    ['its session alive (the reconnect branch)', true],
  ])('a restart scheduled while up, whose persona is no longer up when the timer fires, probes, reconnects, kills and launches nothing; its count and cap latch are unchanged; the skip is logged — %s', async (_label, alive) => {
    // One failure short of the cap: a counted failure would cap and notify.
    for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(KEY)
    const deps = makeGatedDeps({ isSessionAliveResult: alive, launchSessionResult: false })
    initRestart(deps)

    scheduleRestart(KEY, '/cwd/notup')
    expect(isRestartPendingOrActive(KEY)).toBe(true)
    expect(linesFor(KEY, '[slack] Scheduling restart')).toHaveLength(1)

    // The persona stops being up before the timer fires.
    up.delete(KEY)
    await waitForTimer(KEY)

    // Asked once when scheduled (up) and once when the timer fired (not up).
    expect(asked).toEqual([KEY, KEY])
    expect(deps.isSessionAliveCalls).toEqual([])
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
    expect(getFailureCount(KEY)).toBe(RESTART_FAILURE_CAP - 1)
    expect(isAtCap(KEY, RESTART_FAILURE_CAP)).toBe(false)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(isRestartPendingOrActive(KEY)).toBe(false)
    expect(errLines.filter((l) => l === skipLine(KEY))).toHaveLength(1)
    expect(linesFor(KEY, '[slack] Relaunching session')).toEqual([])

    // Up again: the next restart runs as today, and its failed launch is the
    // one that reaches the cap, since the guard left the count as it was.
    up.add(KEY)
    scheduleRestart(KEY, '/cwd/notup')
    await waitForTimer(KEY)
    expect(deps.isSessionAliveCalls).toEqual([KEY])
    if (alive) {
      expect(deps.reconnectSessionCalls).toEqual([KEY])
      expect(deps.launchSessionCalls).toEqual([])
      expect(getFailureCount(KEY)).toBe(RESTART_FAILURE_CAP - 1)
    } else {
      expect(deps.killSessionCalls).toEqual([KEY])
      expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([KEY])
      expect(getFailureCount(KEY)).toBe(RESTART_FAILURE_CAP)
      expect(deps.onCapReachedCalls).toEqual([KEY])
    }
  })

  test.each<[string, boolean]>([
    ['the probe answers dead (the kill + relaunch branch)', false],
    ['the probe answers alive and disconnected (the reconnect branch)', true],
  ])('the persona stops being up while the liveness probe is pending: once the probe settles nothing is reconnected, killed or launched; its count and cap latch are unchanged; the skip is logged once — %s', async (_label, alive) => {
    // One failure short of the cap: a counted failure would cap and notify.
    for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(KEY)
    const deps = makeGatedDeps({ launchSessionResult: false })
    // Hold the probe open until the test settles it.
    let settleProbe!: () => void
    const probeEntered = new Promise<void>((entered) => {
      deps.isSessionAlive = (key) => {
        deps.isSessionAliveCalls.push(key)
        entered()
        return new Promise<boolean>((res) => { settleProbe = () => res(alive) })
      }
    })
    initRestart(deps)

    scheduleRestart(KEY, '/cwd/notup')
    await probeEntered

    // Up at scheduling and when the timer fired, so the probe ran.
    expect(asked).toEqual([KEY, KEY])
    expect(deps.isSessionAliveCalls).toEqual([KEY])
    expect(isRestartPendingOrActive(KEY)).toBe(true)

    // The persona stops being up mid-probe; then the probe answers.
    up.delete(KEY)
    settleProbe()
    await Bun.sleep(WAIT_MS)

    // Asked a third time after the probe (not up): it returned there.
    expect(asked).toEqual([KEY, KEY, KEY])
    expect(deps.isSessionAliveCalls).toEqual([KEY])
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
    expect(getFailureCount(KEY)).toBe(RESTART_FAILURE_CAP - 1)
    expect(isAtCap(KEY, RESTART_FAILURE_CAP)).toBe(false)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(isRestartPendingOrActive(KEY)).toBe(false)
    expect(errLines.filter((l) => l === skipLine(KEY))).toHaveLength(1)
    expect(linesFor(KEY, '[slack] Session alive but disconnected')).toEqual([])
    expect(linesFor(KEY, '[slack] Relaunching session')).toEqual([])
  })

  test.each<[string, { humanTrigger?: boolean } | undefined]>([
    ['a disconnect or health-check restart', undefined],
    ['the human trigger', { humanTrigger: true }],
  ])('scheduleRestart for a persona that is not up arms no timer and touches nothing, however often it is asked; each refusal is logged — %s', async (_label, opts) => {
    up.delete(KEY)
    recordFailure(KEY)
    const deps = makeGatedDeps({ launchSessionResult: false })
    initRestart(deps)

    // More requests than the cap: none may count toward it.
    const REQUESTS = RESTART_FAILURE_CAP + 1
    for (let i = 0; i < REQUESTS; i++) {
      scheduleRestart(KEY, '/cwd/notup', undefined, opts)
      expect(isRestartPendingOrActive(KEY)).toBe(false)
    }
    await waitForTimer(KEY)

    expect(asked).toEqual(Array(REQUESTS).fill(KEY))
    expect(errLines.filter((l) => l === refuseLine(KEY))).toHaveLength(REQUESTS)
    expect(linesFor(KEY, '[slack] Scheduling restart')).toEqual([])
    expect(deps.isSessionAliveCalls).toEqual([])
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
    expect(getFailureCount(KEY)).toBe(1)
    expect(isAtCap(KEY, RESTART_FAILURE_CAP)).toBe(false)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(isRestartPendingOrActive(KEY)).toBe(false)
  })

  test('with restarts disabled (delay 0) the gate is not asked and the disabled line is the only one', async () => {
    up.delete(KEY)
    const deps = makeGatedDeps({ restartDelay: 0 })
    initRestart(deps)

    scheduleRestart(KEY, '/cwd/notup')

    expect(asked).toEqual([])
    expect(errLines).toEqual([`[slack] Auto-restart disabled (delay=0) — skipping restart for persona=${KEY}`])
    expect(isRestartPendingOrActive(KEY)).toBe(false)
  })

  test('during shutdown (every bring-up cancelled, so no persona is up) an MCP stream abort\'s scheduleRestart arms no timer and does not ask the gate; the shutdown skip is the only line, never the not-up refusal', async () => {
    // Graceful shutdown cancels the bring-up controller before the HTTP
    // server's stop aborts every MCP stream: the gate would answer false.
    up.clear()
    recordFailure(KEY)
    const deps = makeGatedDeps({ isShuttingDown: true, launchSessionResult: false })
    initRestart(deps)

    scheduleRestart(KEY, '/cwd/notup')
    scheduleRestart(OTHER, '/cwd/up', undefined, { humanTrigger: true })
    expect(isRestartPendingOrActive(KEY)).toBe(false)
    expect(isRestartPendingOrActive(OTHER)).toBe(false)
    await waitForTimer(KEY)

    expect(asked).toEqual([])
    expect(errLines).toEqual([
      `[slack] Skipping restart — server is shutting down (persona=${KEY})`,
      `[slack] Skipping restart — server is shutting down (persona=${OTHER})`,
    ])
    expect(deps.isSessionAliveCalls).toEqual([])
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
    expect(getFailureCount(KEY)).toBe(1)
    expect(getFailureCount(OTHER)).toBe(0)
    expect(deps.onCapReachedCalls).toEqual([])
  })

  test('an up persona beside a not-up one restarts exactly as today — killed, relaunched, each failure counted, the cap reached and notified once — while the not-up one\'s pending restart does nothing', async () => {
    const deps = makeGatedDeps({ launchSessionResult: false })
    initRestart(deps)

    // KEY's restart is scheduled while it is up; it stops being up before it fires.
    scheduleRestart(KEY, '/cwd/notup')
    up.delete(KEY)

    await driveFailures(OTHER, '/cwd/up', RESTART_FAILURE_CAP)

    expect(deps.killSessionCalls).toEqual(Array(RESTART_FAILURE_CAP).fill(OTHER))
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual(Array(RESTART_FAILURE_CAP).fill(OTHER))
    expect(deps.launchSessionCalls.every((c) => c.cwd === '/cwd/up')).toBe(true)
    expect(getFailureCount(OTHER)).toBe(RESTART_FAILURE_CAP)
    expect(isAtCap(OTHER, RESTART_FAILURE_CAP)).toBe(true)
    expect(deps.onCapReachedCalls).toEqual([OTHER])
    expect(isRestartPendingOrActive(OTHER)).toBe(false)

    expect(deps.isSessionAliveCalls.filter((k) => k === KEY)).toEqual([])
    expect(getFailureCount(KEY)).toBe(0)
    expect(isRestartPendingOrActive(KEY)).toBe(false)
    expect(errLines.filter((l) => l === skipLine(KEY))).toHaveLength(1)
    expect(errLines.filter((l) => l === skipLine(OTHER) || l === refuseLine(OTHER))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The not-up guard through the real gate and the real adapters (b.av2 SR-6.4).
// `canRestart` is the server's relaunch gate (`createPersonaRelaunchGate` over
// a fake connection status and bring-up outcome), and the liveness probe,
// reconnect, kill and launch are the real adapters over one stub
// agent-director client, so "left alone" is observed as no agent-director
// call of any kind for that persona's instance.
// ---------------------------------------------------------------------------

describe('not-up guard through the real relaunch gate and adapters: no agent-director call for a persona that is not up (b.av2 SR-6.4)', () => {
  let dir: string
  let config: PersonaConfig
  let a: Persona
  let b: Persona
  /** The fake connection manager's status per persona key. */
  let statuses: Map<string, PersonaConnectionStatus>
  /** Keys whose bring-up outcome is `up` (the bring-up controller's query). */
  let outcomesUp: Set<string>
  /** Keys in the applied persona set (the bring-up controller's live `isApplied`). */
  let applied: Set<string>
  /** Keys `onCapReached` was called for. */
  let capCalls: string[]
  let gateLines: string[]
  let statusCalls: StatusParams[]
  let sendKeysCalls: SendKeysParams[]
  let killCalls: KillParams[]
  let deleteCalls: DeleteParams[]
  let spawnCalls: SpawnParams[]
  let findMissingCalls: FindMissingParams[]
  let errLines: string[]
  let origConsoleError: typeof console.error

  const UP: PersonaConnectionStatus = { state: 'up', identity: { botUserId: 'U0GUARD', botId: 'B0GUARD' } }
  const REFUSED = { kind: 'credentials-refused' } as never

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restart-notup-'))
    config = makeMultiPersonaConfig([{ name: 'alpha_bot' }, { name: 'beta_bot' }], dir)
    ;[a, b] = config.personas as [Persona, Persona]
    statuses = new Map([[a.key, UP], [b.key, UP]])
    outcomesUp = new Set([a.key, b.key])
    applied = new Set([a.key, b.key])
    capCalls = []
    gateLines = []
    statusCalls = []
    sendKeysCalls = []
    killCalls = []
    deleteCalls = []
    spawnCalls = []
    findMissingCalls = []
    errLines = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }

    // A's row is gone (a restart would kill and relaunch it); B's is live and
    // idle (a restart reconnects it).
    const stub = makeStubClient({
      statusFn: (p) => (p.claude_instance_id === personaInstanceId(a.key) ? errSpawnNotFound() : { state: 'waiting' }),
      statusCalls,
      sendKeysCalls,
      killCalls,
      deleteCalls,
      spawnCalls,
      findMissingCalls,
    })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    setSessionNotifier(() => {})
    _setTmuxServerEnsurer(async () => {})
    _resetFindMissingMemo()
  })

  afterEach(() => {
    console.error = origConsoleError
    cancelAllRestartTimers()
    resetClientForTests()
    _resetOutageState()
    setSessionNotifier(undefined)
    _resetTmuxServerEnsurer()
    _resetFindMissingMemo()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRealDeps(): RestartDeps {
    const gate = createPersonaRelaunchGate(
      { status: (key) => statuses.get(key) },
      (line) => { gateLines.push(line) },
      { isUp: (key) => outcomesUp.has(key), isApplied: (key) => applied.has(key) },
    )
    return {
      canRestart: gate,
      isSessionAlive: _buildIsSessionAliveAdapter(() => config),
      isSessionConnected: () => false,
      hasSessionStream: () => false,
      reconnectSession: _buildReconnectSessionAdapter(),
      killSession: _buildKillSessionAdapter(),
      launchSession: (key) => launchPersonaSession(key, config, { canLaunch: gate }),
      getRestartDelay: () => CAP_BASE_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: (key) => { capCalls.push(key) },
    }
  }

  const callsFor = (calls: Array<StatusParams | SendKeysParams>, p: Persona) =>
    calls.filter((c) => c.claude_instance_id === personaInstanceId(p.key))

  test.each<[string, () => void, string]>([
    // The gate names the reason: the connection when it is not serving, the
    // bring-up when the connection is serving but the outcome is not `up`.
    ['Slack refused its token on a reopen (connection broken)', () => { statuses.set(a.key, { state: 'broken', phase: 'reopen', outcome: REFUSED }) }, 'its Slack connection is broken'],
    ['its bring-up outcome stopped being up (connection still up)', () => { outcomesUp.delete(a.key) }, 'its bring-up has not succeeded'],
  ])('A\'s restart, scheduled while up, fires after %s: A gets no status, send-keys, kill, delete, find-missing or spawn call and no count; B beside it is probed and reconnected as today', async (_label, flip, reason) => {
    recordFailure(a.key)
    initRestart(makeRealDeps())

    scheduleRestart(a.key, a.working_directory)
    scheduleRestart(b.key, b.working_directory)
    expect(isRestartPendingOrActive(a.key)).toBe(true)
    flip()
    await Bun.sleep(WAIT_MS)

    // Nothing reached agent-director for A: no probe, no `/mcp reconnect`, and
    // (for anyone) no kill, delete, spawn or find-missing sweep.
    expect(callsFor(statusCalls, a)).toEqual([])
    expect(callsFor(sendKeysCalls, a)).toEqual([])
    expect(killCalls).toEqual([])
    expect(deleteCalls).toEqual([])
    expect(spawnCalls).toEqual([])
    expect(findMissingCalls).toEqual([])
    expect(getFailureCount(a.key)).toBe(1)
    expect(isRestartPendingOrActive(a.key)).toBe(false)
    expect(gateLines).toEqual([`[slack] persona=${a.key}: not relaunched — ${reason}; eligible again once it is up`])
    expect(errLines).toContain(`[slack] Skipping restart for persona=${a.key} — the persona is no longer up; its instance is left as it is`)

    // B: the liveness probe and the reconnect adapter's probe, then one
    // `/mcp reconnect`; never killed or respawned.
    expect(callsFor(statusCalls, b)).toHaveLength(2)
    expect(callsFor(sendKeysCalls, b)).toHaveLength(1)
    expect(getFailureCount(b.key)).toBe(0)
  })

  // b.av2 SR-8.6: from a confirmed apply's step 1 on, a key outside the
  // applied set is never restarted, even while its connection still serves and
  // its bring-up outcome is still `up` (until its teardown). The applied check
  // lives in the relaunch gate (`canRestart`), so RestartDeps is unchanged.
  // A refused request logs the gate's removal line (once per persona) and
  // restart.ts's own "Not scheduling restart" line (per request; its wording
  // names both reasons the gate can refuse, PM N5).
  const removedLine = (key: string) => `[slack] persona=${key}: not relaunched — it is no longer in the applied configuration`
  const refuseLine = (key: string) =>
    `[slack] Not scheduling restart for persona=${key} — the relaunch gate refused it (the persona is not up, or is no longer in the applied configuration)`

  test.each<[string, { humanTrigger?: boolean } | undefined]>([
    ['a disconnect or health-check restart', undefined],
    ['the human trigger', { humanTrigger: true }],
  ])('SR-8.6: scheduleRestart for a key outside the applied set, still up and serving, arms no timer and makes no agent-director call; the gate logs the removal once; B, still applied, restarts as before — %s', async (_label, opts) => {
    recordFailure(a.key)
    applied.delete(a.key)
    initRestart(makeRealDeps())

    scheduleRestart(a.key, a.working_directory, undefined, opts)
    expect(isRestartPendingOrActive(a.key)).toBe(false)
    scheduleRestart(a.key, a.working_directory, undefined, opts)
    expect(isRestartPendingOrActive(a.key)).toBe(false)
    scheduleRestart(b.key, b.working_directory, undefined, opts)
    expect(isRestartPendingOrActive(b.key)).toBe(true)
    await Bun.sleep(WAIT_MS)

    expect(callsFor(statusCalls, a)).toEqual([])
    expect(callsFor(sendKeysCalls, a)).toEqual([])
    expect(killCalls).toEqual([])
    expect(deleteCalls).toEqual([])
    expect(spawnCalls).toEqual([])
    expect(findMissingCalls).toEqual([])
    expect(getFailureCount(a.key)).toBe(1)
    expect(capCalls).toEqual([])
    expect(gateLines).toEqual([removedLine(a.key)])
    expect(errLines.filter((l) => l === refuseLine(a.key))).toHaveLength(2)
    expect(errLines.filter((l) => l.startsWith('[slack] Scheduling restart'))).toEqual([
      expect.stringContaining(`persona=${b.key} `),
    ])

    // Control: B is probed and reconnected exactly as today.
    expect(callsFor(statusCalls, b)).toHaveLength(2)
    expect(callsFor(sendKeysCalls, b)).toHaveLength(1)
    expect(getFailureCount(b.key)).toBe(0)
    expect(isRestartPendingOrActive(b.key)).toBe(false)
  })

  test('SR-8.6: a restart armed while A is applied, whose key then leaves the applied set (still up and serving), fires with no probe, reconnect, kill or launch; its count and cap latch are unchanged and no cap notice is raised; B, still applied, restarts as before', async () => {
    // One failure short of the cap: a counted failure would cap and notify.
    for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(a.key)
    initRestart(makeRealDeps())

    scheduleRestart(a.key, a.working_directory)
    scheduleRestart(b.key, b.working_directory)
    expect(isRestartPendingOrActive(a.key)).toBe(true)
    expect(gateLines).toEqual([])

    // Step 1 of a confirmed apply removes A; its connection and outcome stay up.
    applied.delete(a.key)
    await Bun.sleep(WAIT_MS)

    expect(callsFor(statusCalls, a)).toEqual([])
    expect(callsFor(sendKeysCalls, a)).toEqual([])
    expect(killCalls).toEqual([])
    expect(deleteCalls).toEqual([])
    expect(spawnCalls).toEqual([])
    expect(findMissingCalls).toEqual([])
    expect(getFailureCount(a.key)).toBe(RESTART_FAILURE_CAP - 1)
    expect(isAtCap(a.key, RESTART_FAILURE_CAP)).toBe(false)
    expect(capCalls).toEqual([])
    expect(isRestartPendingOrActive(a.key)).toBe(false)
    expect(gateLines).toEqual([removedLine(a.key)])
    expect(errLines.filter((l) => l === `[slack] Skipping restart for persona=${a.key} — the persona is no longer up; its instance is left as it is`)).toHaveLength(1)
    expect(errLines.filter((l) => l.startsWith('[slack] Relaunching session'))).toEqual([])

    // Control: B is probed and reconnected exactly as today.
    expect(callsFor(statusCalls, b)).toHaveLength(2)
    expect(callsFor(sendKeysCalls, b)).toHaveLength(1)
    expect(getFailureCount(b.key)).toBe(0)
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
  function setupCapNotice(alphaDestination: Pick<Persona, 'dm' | 'permission_prompts'> = {
    dm: { enabled: false },
    permission_prompts: 'C0ALPHAPR',
  }): { a: Persona; b: Persona; h: NotifierHarness; bodies: string[] } {
    const config = makeMultiPersonaConfig([
      {
        name: 'Alpha Bot',
        channels: [{ id: 'C0ALPHA01', delivery: 'all' }, { id: 'C0ALPHAPR', delivery: 'all' }],
        ...alphaDestination,
      },
      { name: 'beta_bot' },
    ], dir)
    const [a, b] = config.personas as [Persona, Persona]
    const h = makeNotifierHarness(config)
    // The notice bodies the session manager raised, in order.
    const bodies: string[] = []
    setSessionNotifier((key, text, options) => {
      bodies.push(text)
      return h.notifier.notify(key, text, options)
    })
    return { a, b, h, bodies }
  }

  const DM_CONTACT = 'U0ALPHADM'

  /** Let the fire-and-forget cap notice post settle. */
  async function settleNotices(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  test.each([
    {
      label: 'A\'s permission_prompts channel',
      destination: { dm: { enabled: false }, permission_prompts: 'C0ALPHAPR' },
      channel: 'C0ALPHAPR',
      methods: ['chat.postMessage'],
    },
    {
      // b.av2 SR-7.2 DM destination: the DM with A's contact, opened on A's
      // client, posted to the returned D… conversation (never the user ID).
      label: 'A\'s DM with its contact',
      destination: { dm: { enabled: true, contact: DM_CONTACT }, permission_prompts: 'dm' },
      channel: stubOpenedDmId(DM_CONTACT),
      methods: ['conversations.open', 'chat.postMessage'],
    },
  ] as Array<{ label: string; destination: Pick<Persona, 'dm' | 'permission_prompts'>; channel: string; methods: StubWebMethod[] }>)(
    'cap for persona A posts exactly one notice on A\'s client to $label, naming A; nothing on B',
    async ({ destination, channel, methods }) => {
      const { a, b, h, bodies } = setupCapNotice(destination)

      const deps = makeDeps({
        restartDelay: CAP_BASE_DELAY_S,
        launchSessionResult: false,
        onCapReached: notifyRestartCapReached,
      })
      initRestart(deps)

      await driveFailures(a.key, a.working_directory, RESTART_FAILURE_CAP)
      await settleNotices()

      expect(deps.onCapReachedCalls).toEqual([a.key])
      const posts = h.posts(a.key)
      expect(posts).toEqual([{ channel, text: expect.any(String) }])
      expect(h.stub(a.key).web.callLog.map((c) => c.method)).toEqual(methods)
      if (destination.permission_prompts === 'dm') {
        expect(h.stub(a.key).calls.conversationsOpen).toEqual([{ users: DM_CONTACT }])
      }
      expect(h.stub(b.key).callLog).toEqual([])
      expect(h.logs).toEqual([])

      // The same text for either destination: the persona reference + the raised body.
      expect(bodies).toHaveLength(1)
      const text = posts[0]!.text
      expect(text).toBe(formatPersonaNotice(a, bodies[0]!))
      expect(text.startsWith(`Persona ${renderPersonaRef(a.name, a.key)}: `)).toBe(true)
      expect(text).toContain('`SpawnCapReached`')
      expect(text).not.toMatch(/this channel/i)
      for (const id of ['C0ALPHA01', 'C0ALPHAPR', channel, DM_CONTACT]) expect(text).not.toContain(id)
    },
  )

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
// Escalate-dead internal recovery (Epic t1.tkk.e4 / b.sv7, b.d61)
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
// referenced here). The restart run then probes liveness again (b.d61): once
// that sweep has (in production) reconciled the frozen `working` row to
// `missing`, the re-probe reads it dead and the same run takes the normal
// kill+relaunch branch; while the row still reads alive, the run relaunches
// nothing and a SUBSEQUENT tick that sees the session dead does.
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
    // (b.av2 SR-2.2) — here the persona key C_DEADTMUX.
    const reconnectSession = _buildReconnectSessionAdapter()

    const deps: RestartDeps & { killSessionCalls: string[]; launchSessionCalls: string[] } = {
      killSessionCalls,
      launchSessionCalls,
      canRestart: () => true,
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

  test('tick 1: alive+dead-tmux verdict fires exactly one internal findMissing sweep; the re-probe still reads alive (no kill/relaunch); tick 2: session dead → kill+relaunch', async () => {
    const KEY = 'C_DEADTMUX'
    const { deps, findMissingCalls, statusCalls, sendKeysCalls, setAlive } = makeRealAdapterDeps()
    initRestart(deps)

    // --- Tick 1: row still looks alive; the real adapter runs reconnectMcp,
    // which returns 'dead-session' → 'escalate-dead', firing the internal sweep.
    setAlive(true)
    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // The existing memoized sweep ran exactly once — this is CSCB's own recovery,
    // not the external loop (absent by construction). The liveness re-probe
    // that follows the escalate-dead verdict (b.d61) still reads alive here (the
    // sweep did not reconcile the row), so this tick takes NO relaunch action.
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

    // --- Tick 2: the row has since been reconciled to `missing`, so the next
    // tick observes the session dead. The normal kill+relaunch branch runs.
    // Reset the memo so this tick's semantics don't depend on the prior sweep's
    // TTL — we are simulating a LATER tick past the memo window.
    _resetFindMissingMemo()
    setAlive(false)
    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.killSessionCalls).toEqual([KEY])
    expect(deps.launchSessionCalls).toEqual([KEY])
  })

  test('b.d61: the sweep reconciles the row before the re-probe → the same run kills and relaunches once, with no second relaunch', async () => {
    const KEY = 'C_DEADTMUX'
    const { deps, findMissingCalls, sendKeysCalls } = makeRealAdapterDeps()
    // The row reads alive until the sweep has run and dead after it (what AD
    // does for a row whose tmux session is gone).
    deps.isSessionAlive = async () => findMissingCalls.length === 0
    initRestart(deps)

    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // 'dead-session' → 'escalate-dead': the send-keys reconnect and its retry
    // failed and the sweep ran once; the re-probe read the row dead, so this
    // one run killed and relaunched it and armed nothing further.
    expect(sendKeysCalls).toHaveLength(2)
    expect(findMissingCalls).toHaveLength(1)
    expect(deps.killSessionCalls).toEqual([KEY])
    expect(deps.launchSessionCalls).toEqual([KEY])
    expect(getFailureCount(KEY)).toBe(0)
    expect(isRestartPendingOrActive(KEY)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// b.d61: a persona killed mid-turn is relaunched, not deferred forever.
//
// The live Check 7 shape: the persona's tmux session is killed while it is
// `working`, so its MCP session drops and AD's row stays frozen at `working`
// until a findMissing sweep reconciles it. The liveness probe and the reconnect
// adapter are the REAL ones over one stub AD client whose row reads `working`
// until a findMissing sweep has run and `missing` after it (what AD does for a
// row whose tmux session is gone). The tmux-session prober reports the
// persona's session gone. Kill and launch are recording fakes. The restart
// run's liveness re-probe after the 'escalate-dead' verdict reads the
// reconciled row, so the relaunch happens in that same run.
// ---------------------------------------------------------------------------

describe('b.d61: a working persona whose tmux session is gone is relaunched in the same restart run', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restart-d61-'))
    _resetFindMissingMemo()
  })

  afterEach(() => {
    cancelAllRestartTimers()
    resetClientForTests()
    _resetOutageState()
    _resetTmuxServerEnsurer()
    _resetTmuxSessionProber()
    _resetFindMissingMemo()
    rmSync(dir, { recursive: true, force: true })
  })

  test('alive (working) but disconnected → one findMissing sweep and no send-keys; the re-probe reads the row missing → one kill and one relaunch in that run, and no second relaunch', async () => {
    const config = makeMultiPersonaConfig([{ name: 'alpha_bot' }], dir)
    const KEY = config.personas[0]!.key
    const sendKeysCalls: SendKeysParams[] = []
    const findMissingCalls: FindMissingParams[] = []
    const stub = makeStubClient({
      statusFn: () => ({ state: findMissingCalls.length > 0 ? 'missing' : 'working' }),
      sendKeysCalls,
      findMissingCalls,
    })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    _setTmuxServerEnsurer(async () => {})
    _setTmuxSessionProber(async () => false)

    const killSessionCalls: string[] = []
    const launchSessionCalls: string[] = []
    initRestart({
      canRestart: () => true,
      isSessionAlive: _buildIsSessionAliveAdapter(() => config),
      isSessionConnected: () => false,
      hasSessionStream: () => false,
      reconnectSession: _buildReconnectSessionAdapter(),
      async killSession(key) { killSessionCalls.push(key) },
      async launchSession(key) { launchSessionCalls.push(key); return true },
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: () => {},
    })

    // One restart run: the frozen `working` row reads alive; the reconnect
    // adapter finds the tmux session gone and sweeps instead of deferring; the
    // sweep reconciled the row to `missing`, so the re-probe reads dead and the
    // normal kill + relaunch branch runs at once.
    scheduleRestart(KEY, config.personas[0]!.working_directory)
    await Bun.sleep(WAIT_MS)

    expect(findMissingCalls).toHaveLength(1)
    // Nothing is typed into a pane that no longer exists.
    expect(sendKeysCalls).toEqual([])
    expect(killSessionCalls).toEqual([KEY])
    expect(launchSessionCalls).toEqual([KEY])
    // The successful launch counts no failure.
    expect(getFailureCount(KEY)).toBe(0)
    // The run armed no further timer: nothing relaunches the persona again.
    expect(isRestartPendingOrActive(KEY)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// b.dup: a findMissing sweep ends the row just before the reconnect lands.
//
// The liveness probe and the reconnect adapter read the persona's row
// `waiting`; a findMissing sweep (another persona's launch wait starts with
// one, b.m4r) marks it `missing` just before the `/mcp reconnect` keystrokes
// land, and agent-director refuses them with ErrSpawnNotInteractive. The probe
// and the adapter are the REAL ones over one stub AD client; kill and launch
// are recording fakes. reconnectMcp answers 'dead-session', the adapter
// escalates, and the re-probe (b.d61) reads the row dead, so the persona is
// relaunched in that same run. Before the fix the adapter answered
// 'transient' after a spawn-failure notice, and the persona stayed down until
// a later tick.
// ---------------------------------------------------------------------------

describe('b.dup: a persona whose row is ended just before its reconnect lands is relaunched in the same restart run', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restart-dup-'))
    _resetFindMissingMemo()
  })

  afterEach(() => {
    cancelAllRestartTimers()
    resetClientForTests()
    _resetOutageState()
    _resetTmuxServerEnsurer()
    _resetFindMissingMemo()
    setSessionNotifier(undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  test('REPRO: alive (waiting) but disconnected; the keystrokes are refused (ErrSpawnNotInteractive) → one send-keys and one sweep; the re-probe reads the row missing → one kill and one relaunch in that run; no spawn-failure notice, no failure counted', async () => {
    const config = makeMultiPersonaConfig([{ name: 'alpha_bot' }], dir)
    const KEY = config.personas[0]!.key
    let rowState = 'waiting'
    const sendKeysCalls: SendKeysParams[] = []
    const findMissingCalls: FindMissingParams[] = []
    const stub = makeStubClient({ statusFn: () => ({ state: rowState }), findMissingCalls })
    stub.sendKeys = async (params) => {
      sendKeysCalls.push(params)
      rowState = 'missing' // a findMissing sweep landed just before the keystrokes
      throw errSpawnNotInteractive('send-keys')
    }
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    _setTmuxServerEnsurer(async () => {})
    const raised: string[] = []
    setSessionNotifier((key) => { raised.push(key) })

    const killSessionCalls: string[] = []
    const launchSessionCalls: string[] = []
    initRestart({
      canRestart: () => true,
      isSessionAlive: _buildIsSessionAliveAdapter(() => config),
      isSessionConnected: () => false,
      hasSessionStream: () => false,
      reconnectSession: _buildReconnectSessionAdapter(),
      async killSession(key) { killSessionCalls.push(key) },
      async launchSession(key) { launchSessionCalls.push(key); return true },
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: () => {},
    })

    scheduleRestart(KEY, config.personas[0]!.working_directory)
    await Bun.sleep(WAIT_MS)

    expect(sendKeysCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(KEY)])
    expect(findMissingCalls).toHaveLength(1)
    expect(killSessionCalls).toEqual([KEY])
    expect(launchSessionCalls).toEqual([KEY])
    expect(raised).toEqual([])
    expect(getFailureCount(KEY)).toBe(0)
    expect(isRestartPendingOrActive(KEY)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// b.d61: the liveness re-probe after an 'escalate-dead' reconnect. The
// reconnect adapter has already run the findMissing sweep when it answers
// 'escalate-dead', so the restart run probes liveness once more: a row that now
// reads dead, or a re-probe that throws (counted as not alive, as the first
// probe's throw is), goes on to the kill and relaunch in the same run, with the
// launch's usual accounting; a row that still reads alive is left to a later
// tick. Shutdown and the not-up gate are asked again after the re-probe, since
// it is an async agent-director call. The deps are `makeDeps` fakes: the first
// probe reads alive and the reconnect answers 'escalate-dead'.
// ---------------------------------------------------------------------------

describe('b.d61: after an escalate-dead reconnect, the restart run probes liveness again', () => {
  const KEY = 'reprobe_bot'
  const RELAUNCH = '[slack] Session reads dead after escalate-dead reconciliation — relaunching in this restart run'
  const STILL_ALIVE = '[slack] Session still reads alive after escalate-dead — leaving the relaunch to a later tick'
  /** Every raw console.error argument list, so a leak in an error object shows. */
  let errArgs: unknown[][]
  let origConsoleError: typeof console.error

  const lines = () => errArgs.map((args) => args.map(String).join(' '))
  const linesStarting = (prefix: string) => lines().filter((l) => l.startsWith(prefix) && l.includes(`persona=${KEY}`))

  /**
   * makeDeps whose first liveness probe reads alive, whose reconnect answers
   * 'escalate-dead', and whose re-probe runs `reprobe`.
   */
  function makeEscalateDeps(reprobe: () => Promise<boolean>, opts: DepsOpts = {}): ReturnType<typeof makeDeps> {
    const deps = makeDeps(opts)
    deps.isSessionAlive = async (key) => {
      deps.isSessionAliveCalls.push(key)
      return deps.isSessionAliveCalls.length === 1 ? true : reprobe()
    }
    deps.reconnectSession = async (key) => {
      deps.reconnectSessionCalls.push(key)
      return 'escalate-dead'
    }
    return deps
  }

  beforeEach(() => {
    errArgs = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args) }
  })

  afterEach(() => {
    console.error = origConsoleError
    cancelAllRestartTimers()
  })

  test.each<[string, () => Promise<boolean>, boolean, string | undefined]>([
    ['reads dead → the same run kills and relaunches once', async () => false, true, undefined],
    [
      'throws → counted as not alive: the same run kills and relaunches once; the failure is logged as its redacted description',
      async () => {
        throw Object.assign(new Error(`status refused (${sentinelInMessage('reprobe')})`), { code: 'EIO', note: LEAK_SENTINEL })
      },
      true,
      `[slack] restart: isSessionAlive failed after escalate-dead for persona=${KEY}: Error code=EIO message="status refused (${REDACTED_SENTINEL_TAIL})" at `,
    ],
    ['still reads alive → nothing is killed or launched; the relaunch is left to a later tick', async () => true, false, undefined],
  ])('the re-probe %s', async (_label, reprobe, relaunched, failedLine) => {
    // A failed launch, so the count shows whether the launch was attempted (the
    // escalate-dead verdict itself never counts: single counting site).
    const deps = makeEscalateDeps(reprobe, { launchSessionResult: false })
    initRestart(deps)

    scheduleRestart(KEY, '/cwd/reprobe')
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toEqual([KEY, KEY])
    expect(deps.reconnectSessionCalls).toEqual([KEY])
    expect(deps.killSessionCalls).toEqual(relaunched ? [KEY] : [])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual(relaunched ? [KEY] : [])
    expect(getFailureCount(KEY)).toBe(relaunched ? 1 : 0)
    // restart.ts re-arms nothing either way: the health-check tick is the retry driver.
    expect(isRestartPendingOrActive(KEY)).toBe(false)
    expect(linesStarting(RELAUNCH)).toHaveLength(relaunched ? 1 : 0)
    expect(linesStarting(STILL_ALIVE)).toHaveLength(relaunched ? 0 : 1)
    const failed = linesStarting('[slack] restart: isSessionAlive failed')
    expect(failed).toHaveLength(failedLine === undefined ? 0 : 1)
    if (failedLine !== undefined) expect(failed[0]).toStartWith(failedLine)
    assertNoLeak({ errArgs })
  })

  test.each<[string, 'shutdown' | 'not-up', string, number]>([
    ['the server starts shutting down', 'shutdown', `[slack] Skipping restart — server is shutting down (persona=${KEY})`, 3],
    ['the persona stops being up', 'not-up', `[slack] Skipping restart for persona=${KEY} — the persona is no longer up; its instance is left as it is`, 4],
  ])('%s while the re-probe is pending: though the row now reads dead, nothing is killed or launched; the count is unchanged; the skip is logged once', async (_label, flip, skipLine, gateAsks) => {
    // One failure on record, so a reset or a counted launch would show.
    recordFailure(KEY)
    let shuttingDown = false
    let up = true
    const asked: string[] = []
    const deps = makeEscalateDeps(async () => {
      if (flip === 'shutdown') shuttingDown = true
      else up = false
      return false
    }, { launchSessionResult: false })
    deps.isShuttingDown = () => shuttingDown
    deps.canRestart = (key) => { asked.push(key); return up }
    initRestart(deps)

    scheduleRestart(KEY, '/cwd/reprobe')
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toEqual([KEY, KEY])
    expect(deps.reconnectSessionCalls).toEqual([KEY])
    // Asked when scheduled, when the timer fired and after the first probe; the
    // not-up case is asked once more after the re-probe, while shutdown returns
    // before the gate is asked.
    expect(asked).toEqual(Array(gateAsks).fill(KEY))
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
    expect(getFailureCount(KEY)).toBe(1)
    expect(isRestartPendingOrActive(KEY)).toBe(false)
    expect(lines().filter((l) => l === skipLine)).toHaveLength(1)
    expect(linesStarting(RELAUNCH)).toEqual([])
    expect(linesStarting('[slack] Relaunching session')).toEqual([])
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
  /** Each result restart received from `launchSession`, in settle order. */
  let launchResults: Array<{ key: string; ok: boolean | 'skipped' }>
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

// ---------------------------------------------------------------------------
// Restart-triggered relaunch: the reply-guard record precedes the launch
// (b.av2 SR-6.2, SR-9.4). `RestartDeps.launchSession` is the session
// manager's REAL launch adapter, and the REAL `preLaunchReplyGuard` is
// installed with `setPreLaunchReplyGuard` over a `mkdtempSync` state
// directory (`makeReplyGuardRecordDir`), removed in afterEach with every
// persona path. The persona has its own temp claude_config_dir, so the
// launch-time hook pass writes only there. At each spawn or resume the stub
// snapshots the persona's record and launched-with dir; the installed step
// and its undo log to the same order log (`installRecordingReplyGuard` and
// `observeLaunchCalls`, tests/test-helpers/reply-guard-launch.ts).
// ---------------------------------------------------------------------------

describe('restart: the reply-guard record holds the effective value before the relaunch reaches agent-director (b.av2 SR-6.2, SR-9.4)', () => {
  let dir: string
  let rg: ReplyGuardRecordDir
  let configDir: string
  let errLines: string[]
  let origConsoleError: typeof console.error
  /** The installed step ('guard'), its undo ('undo') and the stub's 'spawn' / 'resume', in order. */
  let events: string[]
  /** The record text (null when absent) and launched-with dir at each spawn or resume. */
  let seen: Array<{ call: LaunchCall; record: string | null; launchedWith: string | undefined }>
  let spawnCalls: SpawnParams[]
  let resumeCalls: ResumeParams[]
  let sendKeysCalls: SendKeysParams[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restart-reply-guard-'))
    rg = makeReplyGuardRecordDir()
    configDir = join(dir, 'claude-config')
    mkdirSync(configDir)
    events = []
    seen = []
    spawnCalls = []
    resumeCalls = []
    sendKeysCalls = []
    errLines = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }
    setSessionNotifier(() => {})
    _resetInFlightLaunches()
    _setSpawnHomeDir(dir)
    _setDialogPollIntervalMs(1)
    _setDialogReadyTimeoutMs(200)
    _setTmuxCapturePane(async () => '')
    _setTmuxSendEnter(async () => {})
    _setTmuxSessionProber(async () => true)
    _setTmuxServerEnsurer(async () => {})
  })

  afterEach(() => {
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
    rg.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * One persona, `Alpha Desk` (a hashed key), with the given effective
   * stop_hook_bootstrap and its own claude_config_dir; the real reply guard
   * installed over it; and a stub AD client whose row is gone (`row: 'gone'`,
   * the spawn succeeds) or `ended` (the spawn collides and the row resumes).
   */
  function setup(stopHookBootstrap: boolean, row: 'gone' | 'ended'): { config: PersonaConfig; a: Persona } {
    const config = makeMultiPersonaConfig(
      [{ name: 'Alpha Desk', claude_config_dir: configDir, stop_hook_bootstrap: stopHookBootstrap }],
      dir,
      { agent_director_poll_interval_ms: 1 },
    )
    const [a] = config.personas as [Persona]
    mkdirSync(a.working_directory, { recursive: true })
    installRecordingReplyGuard(config.personas, rg.stateDir, events)
    const stub = observeLaunchCalls(makeStubClient({
      statusFn: () => ({ state: 'waiting' }),
      spawnCalls,
      resumeCalls,
      sendKeysCalls,
      spawnQueue: row === 'ended' ? [cannedErr<SpawnResult>(errInstanceIdCollision())] : undefined,
      getResult: cannedGetResult({ state: 'ended' }, a, dir),
    }), (call) => {
      events.push(call)
      seen.push({ call, record: rg.readRecord(a.key), launchedWith: getLaunchedWithDir(a.key) })
    })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    return { config, a }
  }

  /** Poll (foreground) until `cond` holds or `ms` elapse. */
  async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
    const deadline = Date.now() + ms
    while (!cond() && Date.now() < deadline) await Bun.sleep(5)
  }

  // One relaunch through the real adapter; every launch path and both values
  // are covered against the ladder in session-manager.test.ts.
  test('dead session, ended row, stop_hook_bootstrap false: the record reads false before each relaunch call (the optimistic spawn is undone, then resume)', async () => {
    const { config, a } = setup(false, 'ended')
    const results: Array<boolean | 'skipped'> = []
    const deps = makeDeps({
      isSessionAliveResult: false,
      launchSession: async (key) => {
        const ok = await launchPersonaSession(key, config)
        results.push(ok)
        return ok
      },
    })
    initRestart(deps)

    scheduleRestart(a.key, a.working_directory)
    await waitFor(() => results.length > 0)

    expect(deps.killSessionCalls).toEqual([a.key])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([a.key])
    expect(results).toEqual([true])
    expect(events).toEqual(['guard', 'spawn', 'undo', 'guard', 'resume'])
    expect(seen.map((s) => s.call)).toEqual(['spawn', 'resume'])
    for (const snap of seen) expect(snap).toEqual({ call: snap.call, record: 'false', launchedWith: configDir })
    expect(resumeCalls).toHaveLength(1)
    expect(rg.readRecord(a.key)).toBe('false')
    expect(getFailureCount(a.key)).toBe(0)
  })

  test('live session: the restart reconnects through the real adapter — no launch, no reply-guard step, no record', async () => {
    const { a } = setup(true, 'gone')
    const deps = makeDeps({ isSessionAliveResult: true })
    deps.reconnectSession = _buildReconnectSessionAdapter()
    initRestart(deps)

    scheduleRestart(a.key, a.working_directory)
    await waitFor(() => sendKeysCalls.length > 0 && !isRestartPendingOrActive(a.key))

    expect(sendKeysCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(a.key)])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
    expect(events).toEqual([])
    expect(spawnCalls).toEqual([])
    expect(rg.readRecord(a.key)).toBeNull()
    expect(getLaunchedWithDir(a.key)).toBeUndefined()
  })

  // b.av2 SR-8.6 next-launch rows (AC 59): restart.ts keeps no persona
  // values; each relaunch goes through the launch adapter, handed the applied
  // set at that moment (the server's `personaConfig`, which a confirmed
  // apply's step 1 swaps), and the reply guard reads the live applied set.
  test('claude_config_dir and stop_hook_bootstrap changed between two restarts: the first relaunch uses the old values; the second deletes the old-label row and spawns fresh with the new CLAUDE_CONFIG_DIR (not created yet) and writes the new record', async () => {
    const newDir = join(dir, 'claude-config-new')
    const configFor = (claude_config_dir: string, stop_hook_bootstrap: boolean) =>
      makeMultiPersonaConfig([{ name: 'Alpha Desk', claude_config_dir, stop_hook_bootstrap }], dir, { agent_director_poll_interval_ms: 1 })
    const before = configFor(configDir, true)
    let applied = before
    const [a] = before.personas as [Persona]
    mkdirSync(a.working_directory, { recursive: true })
    installRecordingReplyGuard(() => applied.personas, rg.stateDir, events)
    // The row the first relaunch leaves behind, labelled for the old directory.
    const oldRow = cannedGetResult({ state: 'ended' }, a, dir)
    const deleteCalls: DeleteParams[] = []
    const stub = makeStubClient({
      statusFn: () => ({ state: 'waiting' }),
      spawnCalls,
      resumeCalls,
      deleteCalls,
      spawnQueue: [
        cannedOk<SpawnResult>({ claude_instance_id: personaInstanceId(a.key) }),
        cannedErr<SpawnResult>(errInstanceIdCollision()),
        cannedOk<SpawnResult>({ claude_instance_id: personaInstanceId(a.key) }),
      ],
      getResult: oldRow,
    })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    const results: Array<boolean | 'skipped'> = []
    initRestart(makeDeps({
      launchSession: async (key) => {
        const ok = await launchPersonaSession(key, applied)
        results.push(ok)
        return ok
      },
    }))

    scheduleRestart(a.key, a.working_directory)
    await waitFor(() => results.length === 1)
    expect(results).toEqual([true])
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]!.extra_env?.['CLAUDE_CONFIG_DIR']).toBe(configDir)
    expect(spawnCalls[0]!.label).toContain(`config_dir=${oldRow.labels['config_dir']}`)
    expect(rg.readRecord(a.key)).toBe('true')

    // Step 1 of a confirmed apply: the applied set now holds the new values.
    applied = configFor(newDir, false)
    scheduleRestart(a.key, a.working_directory)
    await waitFor(() => results.length === 2)

    expect(results).toEqual([true, true])
    expect(resumeCalls).toEqual([])
    expect(deleteCalls.map((d) => d.claude_instance_id)).toEqual([[personaInstanceId(a.key)]])
    expect(spawnCalls).toHaveLength(3)
    expect(spawnCalls[2]!.extra_env?.['CLAUDE_CONFIG_DIR']).toBe(newDir)
    expect(spawnCalls[2]!.label).toEqual([
      'service=cscb',
      `persona=${a.key}`,
      `config_dir=${configDirLabelValue(join(realpathSync(dir), 'claude-config-new'))}`,
    ])
    expect(rg.readRecord(a.key)).toBe('false')
    expect(getFailureCount(a.key)).toBe(0)
    expect(errLines.filter((l) => l.includes(PERSONA_CONFIG_DIR_UNRESOLVABLE))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Bug b.g57 — a restart of a persona whose claude_config_dir cannot be
// resolved to a real path, wired as server.ts wires it: the real relaunch
// gate over the real bring-up controller (on the connection harness's fake
// clock, the personas brought up on the stub Slack), the real liveness, kill
// (with the applied-persona getter) and launch adapters, the controller's
// `holdForConfigDir` installed as the session manager's hook and its
// pre-launch check (`checkLaunchConfigDir`) as the controller's re-check. The
// controller gets the manager's `stop` (recorded) as production wires it, so
// a hold that starts at the restart closes the persona's Slack connection
// (b.av2 SR-6.4's directory-broken shape), and its recovery connects again
// before the launch. The failing realpath is injected through
// `_setConfigDirFs`. Every persona path is under a temp dir removed in
// afterEach.
// ---------------------------------------------------------------------------

describe('b.g57: a restart with an unresolvable claude_config_dir', () => {
  let dir: string
  let h: ConnectionHarness
  let controller: PersonaBringUpController
  let a: Persona
  let b: Persona
  let aConfigDir: string
  /** Whether the injected realpath fails for A's claude_config_dir. */
  let broken: boolean
  let calls: StubCallLog
  let controllerLines: string[]
  let gateLines: string[]
  let errLines: string[]
  let leftUp: string[]
  let capCalls: string[]
  /** Every key the controller stopped (its connection closed), in call order. */
  let stops: string[]
  let origConsoleError: typeof console.error

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'restart-g57-'))
    aConfigDir = join(dir, 'claude-a')
    const bConfigDir = join(dir, 'claude-b')
    mkdirSync(aConfigDir)
    mkdirSync(bConfigDir)
    h = makeConnectionHarness(
      [{ name: 'Alpha Desk', claude_config_dir: aConfigDir }, { name: 'Beta Ops', claude_config_dir: bConfigDir }],
      dir,
      { files: true, overrides: { agent_director_poll_interval_ms: 1 } },
    )
    ;[a, b] = h.personas as [Persona, Persona]
    controllerLines = []
    gateLines = []
    errLines = []
    leftUp = []
    capCalls = []
    stops = []
    broken = false
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }

    _setSpawnHomeDir(dir)
    _resetInFlightLaunches()
    _setDialogPollIntervalMs(1)
    _setDialogReadyTimeoutMs(200)
    _setTmuxCapturePane(async () => '')
    _setTmuxSendEnter(async () => {})
    _setTmuxSessionProber(async () => true)
    _setTmuxServerEnsurer(async () => {})
    _setConfigDirFs({
      realpath: (path) => {
        if (broken && (path === aConfigDir || path.startsWith(`${aConfigDir}/`))) {
          throw Object.assign(new Error('EIO: injected'), { code: 'EIO' })
        }
        return realpathSync(path)
      },
    })

    // A's session is dead and its row `ended`, labelled for its directory (a
    // spawn collides with it); B's row is gone. Each reports `waiting` once relaunched.
    calls = makeStubCallLog()
    const launched = (p: Persona) =>
      calls.resumeCalls.some((r) => r.claude_instance_id === personaInstanceId(p.key)) ||
      calls.spawnCalls.some((s) => s.claude_instance_id === personaInstanceId(p.key))
    const stub = makeStubClient({
      ...calls,
      getResult: cannedGetResult({ state: 'ended' }, a, dir),
      statusFn: (p) => {
        const persona = p.claude_instance_id === personaInstanceId(a.key) ? a : b
        if (persona === a && calls.resumeCalls.length > 0) return { state: 'waiting' }
        if (persona === a) return { state: 'ended' }
        return launched(b) ? { state: 'waiting' } : errSpawnNotFound()
      },
    })
    const realSpawn = stub.spawn.bind(stub)
    stub.spawn = async (params) => {
      if (params.claude_instance_id !== personaInstanceId(a.key)) return realSpawn(params)
      calls.spawnCalls.push(params)
      throw errInstanceIdCollision()
    }
    // The resume joins the shared step log, after the harness's `slack:<key>` markers.
    const realResume = stub.resume.bind(stub)
    stub.resume = async (params) => {
      h.order.push(`resume:${String(params.claude_instance_id)}`)
      return realResume(params)
    }
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    setSessionNotifier(() => {})

    controller = createPersonaBringUpController({
      connections: {
        bringUp: h.connections.bringUp,
        status: (key) => h.manager.status(key),
        // A recording stand-in for the manager's `stop`, which it then runs.
        stop: (key) => {
          stops.push(key)
          h.order.push(`stop:${key}`)
          return h.manager.stop(key)
        },
      },
      dryRun: false,
      log: (line) => void controllerLines.push(line),
      launch: (persona) => spawnForPersona(persona, h.config!, false),
      checkConfigDir: checkLaunchConfigDir,
      appliedPersonas: () => h.config?.personas ?? [],
      onLeftUp: (persona) => void leftUp.push(persona.key),
      clock: h.clock,
    })
    h.onStatus = (key, status) => controller.onConnectionStatus(key, status)
    setConfigDirUnresolvableHook(controller.holdForConfigDir)
    for (const persona of h.personas) expect((await controller.bringUp(persona, h.personas)).outcome).toBe('up')
  })

  afterEach(async () => {
    console.error = origConsoleError
    cancelAllRestartTimers()
    controller.cancelAll()
    await h.manager.stopAll()
    setConfigDirUnresolvableHook(undefined)
    _resetConfigDirFs()
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

  function makeRealDeps(): RestartDeps {
    const gate = createPersonaRelaunchGate(
      { status: (key) => h.manager.status(key) },
      (line) => void gateLines.push(line),
      { isUp: (key) => controller.isUp(key), isApplied: (key) => controller.isApplied(key) },
    )
    return {
      canRestart: gate,
      isSessionAlive: _buildIsSessionAliveAdapter(() => h.config),
      isSessionConnected: () => false,
      hasSessionStream: () => false,
      reconnectSession: _buildReconnectSessionAdapter(),
      killSession: _buildKillSessionAdapter((key) => h.getPersona(key)),
      launchSession: (key) => launchPersonaSession(key, h.config!, { canLaunch: gate }),
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: (key) => void capCalls.push(key),
    }
  }

  /** Poll (foreground, real time) until `cond` holds or `ms` elapse. */
  async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
    const deadline = Date.now() + ms
    while (!cond() && Date.now() < deadline) await Bun.sleep(1)
  }

  /** The calls in `list` addressed to `p`'s instance. */
  const idsFor = <T extends { claude_instance_id?: unknown }>(list: T[], p: Persona): T[] =>
    list.filter((c) => c.claude_instance_id === personaInstanceId(p.key))

  /** Every `persona-config-dir-unresolvable` line, from the controller and the console. */
  const classLines = () => [...controllerLines, ...errLines].filter((l) => l.includes(`${PERSONA_CONFIG_DIR_UNRESOLVABLE}:`))

  test('b.g57: realpath throwing for A\'s claude_config_dir at a restart — no kill, delete, spawn or resume for A (its row untouched), one line naming A and the path, A\'s Slack connection closed, A not up and its count unchanged, the gate refuses its launch; once it resolves (fake clock) A reconnects to Slack, then resumes the same row with no confirmation; B restarts as before', async () => {
    recordFailure(a.key)
    initRestart(makeRealDeps())
    const orderAtStart = h.order.length
    broken = true

    scheduleRestart(a.key, a.working_directory)
    scheduleRestart(b.key, b.working_directory)
    await waitFor(() => !isRestartPendingOrActive(a.key) && !isRestartPendingOrActive(b.key))

    // A: only the liveness probe reached agent-director.
    expect(idsFor(calls.killCalls, a)).toEqual([])
    expect(calls.deleteCalls).toEqual([])
    expect(idsFor(calls.spawnCalls, a)).toEqual([])
    expect(calls.resumeCalls).toEqual([])
    expect(idsFor(calls.statusCalls, a)).toHaveLength(1)
    // Class, persona, path and reason; the whole sentence is pinned in tests/persona-bringup.test.ts.
    expect(classLines()).toHaveLength(1)
    expect(classLines()[0]).toStartWith(
      `[slack] ${PERSONA_CONFIG_DIR_UNRESOLVABLE}: personas[${a.index}] ${renderPersonaRef(a.name, a.key)} path=${JSON.stringify(aConfigDir)}: `,
    )
    expect(classLines()[0]).toContain('(EIO)')
    expect(controller.isUp(a.key)).toBe(false)
    expect(controller.state(a.key)).toEqual({
      outcome: 'retrying',
      causes: { configDir: { step: 'claude-config-dir', class: PERSONA_CONFIG_DIR_UNRESOLVABLE, cause: expect.stringContaining('(EIO)') } },
    })
    expect(leftUp).toEqual([a.key])
    expect(getFailureCount(a.key)).toBe(1)
    expect(capCalls).toEqual([])
    // The hold closed A's connection before the launch, so the gate refuses it for that.
    expect(gateLines).toEqual([`[slack] persona=${a.key}: not relaunched — its Slack connection is not brought up; eligible again once it is up`])
    // The hold closed A's Slack connection (the manager forgot it); B's is untouched.
    expect(stops).toEqual([a.key])
    expect(h.manager.status(a.key)).toBeUndefined()
    expect(h.manager.status(b.key)?.state).toBe('up')
    // B, beside it: killed and spawned fresh, still up, nothing counted.
    expect(idsFor(calls.killCalls, b)).toHaveLength(1)
    expect(idsFor(calls.spawnCalls, b)).toHaveLength(1)
    expect(controller.isUp(b.key)).toBe(true)
    expect(getFailureCount(b.key)).toBe(0)

    // Still unresolvable at the first re-check (5 s): nothing more, no second line.
    await h.clock.advance(5_000)
    expect(calls.resumeCalls).toEqual([])
    expect(idsFor(calls.spawnCalls, a)).toEqual([])
    expect(classLines()).toHaveLength(1)
    expect(controller.isUp(a.key)).toBe(false)
    expect(h.manager.status(a.key)).toBeUndefined()
    expect(h.order.slice(orderAtStart)).toEqual([`stop:${a.key}`])

    // It resolves: the next re-check (10 s on) clears the hold and launches A,
    // whose row still carries the matching label, so the ladder resumes it.
    broken = false
    await h.clock.advance(10_000)
    await waitFor(() => calls.resumeCalls.length > 0 && !isLaunchInFlight(a.key))

    expect(calls.resumeCalls.map((r) => r.claude_instance_id)).toEqual([personaInstanceId(a.key)])
    expect(calls.deleteCalls).toEqual([])
    expect(idsFor(calls.killCalls, a)).toEqual([])
    expect(idsFor(calls.spawnCalls, a)).toHaveLength(1) // the spawn that collided with the row
    expect(controller.isUp(a.key)).toBe(true)
    expect(classLines()).toEqual([expect.any(String), expect.stringContaining(': cleared: claude_config_dir resolves to a real path again')])
    // A connected again with its own held tokens, before the resume reached agent-director.
    expect(h.order.slice(orderAtStart)).toEqual([`stop:${a.key}`, `slack:${a.key}`, `resume:${personaInstanceId(a.key)}`])
    expect(h.bringUpCalls.filter((c) => c.key === a.key)).toEqual([
      { key: a.key, gotTokens: true, ownTokens: true },
      { key: a.key, gotTokens: true, ownTokens: true },
    ])
    expect(h.manager.status(a.key)?.state).toBe('up')
    expect(stops).toEqual([a.key])
    expect(idsFor(calls.spawnCalls, b)).toHaveLength(1)
    assertNoLeak({ controllerLines, gateLines, errLines, managerLines: h.lines })
  })
})

// ---------------------------------------------------------------------------
// AC 20 (b.av2 SR-10.3): the kill adapter's lines carry no credential value:
// the "not killing" line for a persona whose claude_config_dir cannot be
// resolved (bug b.g57), and the generic "error for persona" line for a kill
// that fails, which keeps the error's message only through
// `redactSlackLogText`. The adapter is called directly; the failing realpath
// is injected through `_setConfigDirFs` and the failing kill through the stub
// client, and each error carries fake tokens in its message and properties
// (in a message, the marker sits only inside a fake token and a URL).
// Every raw console.error argument is kept (errors whole), so a line that
// echoed the thrown error would fail the check. The configured
// claude_config_dir path is not a credential (paths stay echoed on purpose),
// so it stays a plain temp path.
// ---------------------------------------------------------------------------

describe('AC 20: the restart kill adapter\'s lines carry no credential value', () => {
  let dir: string
  let calls: StubCallLog
  /** Every console.error call, its arguments unformatted. */
  let errArgs: unknown[][]
  let origConsoleError: typeof console.error

  /** A realpath failure whose message, path and syscall carry fake tokens (its errno code is real). */
  function sentinelRealpathError(): NodeJS.ErrnoException {
    return Object.assign(new Error(`EIO: i/o error, realpath (${sentinelInMessage('realpath')})`), {
      code: 'EIO',
      path: fakeToken(APP_TOKEN_PREFIX, 'path'),
      syscall: LEAK_SENTINEL,
    })
  }

  /** The one persona, whose claude_config_dir is `<dir>/claude-a`, and its adapter over the applied-persona getter. */
  function setUp() {
    const config = makeMultiPersonaConfig([{ name: 'Alpha Desk', claude_config_dir: join(dir, 'claude-a') }], dir)
    const [a] = config.personas as [Persona]
    _setConfigDirFs({ realpath: () => { throw sentinelRealpathError() } })
    const kill = _buildKillSessionAdapter((key) => config.personas.find((p) => p.key === key))
    return { a, kill }
  }

  const adapterLines = () =>
    errArgs.map((args) => args.map(String).join(' ')).filter((l) => l.startsWith('[slack] killSession (restart adapter):'))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restart-ac20-'))
    errArgs = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args) }
    calls = makeStubCallLog()
    const stub = makeStubClient({ ...calls })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    _resetInFlightLaunches()
    _setSpawnHomeDir(dir)
  })

  afterEach(() => {
    console.error = origConsoleError
    setConfigDirUnresolvableHook(undefined)
    _resetConfigDirFs()
    _resetInFlightLaunches()
    resetClientForTests()
    _resetOutageState()
    _resetSpawnHomeDir()
    rmSync(dir, { recursive: true, force: true })
  })

  test.each<[string, ConfigDirUnresolvableHook | undefined]>([
    ['no hold hook (the session manager logs the failure line)', undefined],
    ['a hook that holds the persona', () => true],
    [
      'a hook that throws an error carrying a fake token',
      () => {
        throw Object.assign(new Error(`hold failed (${sentinelInMessage('hook')})`), { detail: LEAK_SENTINEL })
      },
    ],
  ])('AC 20: realpath throws an error carrying fake tokens, %s — the kill is skipped with its one line; no captured argument carries a credential value', async (_label, hook) => {
    const { a, kill } = setUp()
    const held: Array<Parameters<ConfigDirUnresolvableHook>> = []
    if (hook !== undefined) setConfigDirUnresolvableHook((...args) => (held.push(args), hook(...args)))

    await kill(a.key)

    expect(Object.values(calls).flat()).toEqual([])
    expect(adapterLines()).toEqual([
      `[slack] killSession (restart adapter): persona=${a.key} claude_config_dir cannot be resolved to a real path — not killing; its row is kept`,
    ])
    assertNoLeak({ errArgs, held })
  })

  test.each<[string, () => Error, string]>([
    [
      'a plain error with a safe code',
      () => Object.assign(new Error(`kill refused (${sentinelInMessage('kill')})`), { code: 'ECONNRESET', detail: LEAK_SENTINEL }),
      `Error code=ECONNRESET message="kill refused (${REDACTED_SENTINEL_TAIL})"`,
    ],
    [
      'a base AgentDirectorError whose description carries a fake token',
      () => errGeneric('kill', 'ErrKillBroken', `kill refused (${sentinelInMessage('kill', APP_TOKEN_PREFIX)})`),
      `AgentDirectorError errName=ErrKillBroken message="ErrKillBroken: kill refused (${REDACTED_SENTINEL_TAIL})"`,
    ],
  ])('AC 20: the kill fails with %s — one "error for persona" line naming the error with its message redacted; no captured argument carries a credential value', async (_label, makeError, shown) => {
    const config = makeMultiPersonaConfig([{ name: 'Alpha Desk' }], dir)
    const [a] = config.personas as [Persona]
    const killCalls: KillParams[] = []
    const failing = makeStubClient({ killError: makeError(), killCalls })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => failing as unknown as Client })

    await _buildKillSessionAdapter()(a.key)

    expect(killCalls.map((k) => k.claude_instance_id)).toEqual([personaInstanceId(a.key)])
    expect(adapterLines().map((l) => l.split(' at ')[0])).toEqual([
      `[slack] killSession (restart adapter): error for persona=${a.key}: ${shown}`,
    ])
    assertNoLeak({ errArgs })
  })
})
