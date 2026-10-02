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
  runRestartRetry,
  RESTART_FAILURE_CAP,
  RESTART_OUTCOME_ALREADY_CONNECTED,
  RESTART_OUTCOME_CAPPED,
  RESTART_OUTCOME_COUNTED_FAILURE,
  RESTART_OUTCOME_IN_FLIGHT,
  RESTART_OUTCOME_HELD,
  RESTART_OUTCOME_LATCHED,
  RESTART_OUTCOME_LAUNCHED,
  RESTART_OUTCOME_LAUNCH_SKIPPED,
  RESTART_OUTCOME_LIVENESS_UNKNOWN,
  RESTART_OUTCOME_NOT_INITIALISED,
  RESTART_OUTCOME_NOT_UP,
  RESTART_OUTCOME_PENDING_DEFERRED,
  RESTART_OUTCOME_RECONNECTED,
  RESTART_OUTCOME_RECONNECT_DEFERRED,
  RESTART_OUTCOME_REFUSED,
  RESTART_OUTCOME_SEQUENCE_WAITING,
  RESTART_OUTCOME_SHUTTING_DOWN,
  KILL_SESSION_NOT_KILLED_GUARD,
  RESTART_SLOW_RECOVERY_OTHER_PENDING_PROBE,
  RESTART_SLOW_RECOVERY_OTHER_PENDING_REPROBE,
  RESTART_SLOW_RECOVERY_OTHER_VERDICT,
  killNotSucceededLine,
  killStopsServerLine,
  relaunchAfterKillLine,
  relaunchWithoutKillLine,
  RELAUNCH_KILL_NONE,
  reprobeDeadLine,
  reprobeLiveLine,
  reprobePendingLine,
  reprobeUnhandledLine,
  reprobeUnknownLine,
  type KillSessionResult,
  type LaunchSessionResult,
  type ReconnectEscalateDead,
  type ReconnectSessionResult,
  type RestartDeps,
  type RestartRetryOutcome,
  type RestartWorkOutcome,
  type RestartSlowRecoveryObserver,
  type SlowRecoveryOtherReason,
} from '../src/restart.ts'
import {
  _resetBackoffState,
  getFailureCount,
  isAtCap,
  recordFailure,
} from '../src/backoff.ts'
import { _buildIsSessionAliveAdapter, _buildKillSessionAdapter, _buildReconnectSessionAdapter, deferPendingRow } from '../src/server.ts'
import {
  KILL_OUTCOME_KILLED,
  KILL_OUTCOME_NOT_KILLED,
  KILL_OUTCOME_ROW_FINISHED,
  KILL_OUTCOME_ROW_GONE,
  KILL_OUTCOME_SESSION_GONE,
  KILL_ROW_FINISHED_ENDED,
  describeKillOutcome,
  killOutcomeOf,
  type KillOutcome,
} from '../src/checked-kill.ts'
import type { Phase1SpawnParams } from '../src/ad-phase1-types.ts'
import { createPersonaRelaunchGate } from '../src/persona-start.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import { createPersonaSerializer, type PersonaSerialize } from '../src/persona-serializer.ts'
import type { PersonaConnectionStatus } from '../src/persona-connections.ts'
import {
  _resetFindMissingMemo,
  _resetInFlightLaunches,
  _whenDialogApproverStopped,
  stopAllDialogApprovers,
  _setTmuxCommandRunner,
  _resetTmuxCommandRunner,
  _setDialogReadyTimeoutMs,
  _resetDialogReadyTimeoutMs,
  _setSpawnHomeDir,
  _resetSpawnHomeDir,
  isLaunchInFlight,
  launchSession as launchPersonaSession,
  _resetNotConnectedEpisodes,
  notifyRestartCapReached,
  setSessionNotifier,
  _resetPreLaunchReplyGuard,
  _setConfigDirFs,
  _resetConfigDirFs,
  checkLaunchConfigDir,
  setConfigDirUnresolvableHook,
  spawnForPersona,
  setConfiguredPersonaQuery,
  _resetConfiguredPersonaQuery,
  ESCALATE_DEAD_EVIDENCE,
  ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ,
  ESCALATE_DEAD_WAITING_ROW_PANE_GONE,
  FIND_MISSING_MEMO_TTL_MS,
  PROMPT_ROW_STATES,
  _setNow,
  _resetNow,
  setConflictLatch,
  type ConfigDirUnresolvableHook,
  CARRIED_DEAD_EVIDENCE_NONE,
  carriedDeadEvidenceOf,
  DEAD_SESSION_CAUSE_ROW_READ_FINISHED,
  deadSessionRouteLine,
  describeDeadEvidence,
  ESCALATE_DEAD_VERDICTS,
  isDeadEvidence,
  isLiveRowSequenceRunning,
  lostRaceOutcome,
  ROW_REREAD_FINISHED,
  spawnNotResumableLine,
  type PersonaRowReread,
  type CarriedDeadEvidence,
  type DeadEvidenceSource,
  type EscalateDeadVerdict,
} from '../src/session-manager.ts'
import { FULL_PANE_READ_LINES, PROBE_PANE_READ_LINES } from '../src/pane-read.ts'
import {
  LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION,
  LIVE_ROW_LAUNCH_RESUME,
  LIVE_ROW_OUTCOME_LAUNCHED,
  liveRowSequenceStartLine,
} from '../src/live-row-sequence.ts'
import { KILL_FAILURE_ROUTE_NOT_CONFIGURED, KILL_FAILURE_VERSION_ORDINARY, PERSONA_KILL_FAILED_LABEL } from '../src/kill-failure-alert.ts'
import {
  conflictNoticeText,
  createConflictLatch,
  LATCH_CASE_LEFTOVER,
  latchRowStateRead,
  launchStartNotRecordedNoticeText,
  REFUSED_OPERATION_PLAIN_SPAWN,
  type ConflictLatch,
  type ConflictLatchRecord,
} from '../src/conflict-latch.ts'
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
import { AD_ERROR_CLASS_UNAVAILABLE, AD_ERROR_CLASS_UNCLASSIFIED, CSCB_UNKNOWN_ERROR_NAME, describeAgentDirectorFailure } from '../src/ad-error-class.ts'
import {
  cannedErr,
  cannedOk,
  cannedFindMissing,
  cannedGetResult,
  cannedStatusResult,
  errCallTimeout,
  errConfigMalformed,
  errGeneric,
  errInstanceIdCollision,
  errInternal,
  errInvalidFlags,
  errSpawnNotFound,
  errSpawnNotInteractive,
  errSpawnNotResumable,
  errSystemInstallDisappeared,
  errTmuxKillFailed,
  errTmuxCaptureFailed,
  errUnusableName,
  cannedKillResult,
  KILL_FAILED_DESCRIPTIONS,
  errTmuxNotAvailable,
  errTmuxSendKeys,
  errTmuxSessionConflict,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  holdFindMissing,
  holdSpawns,
  UNAVAILABLE_FORMS,
  unavailableForms,
  makeStubCallLog,
  makeStubResolveSystemBinary,
  nonLatchingNotes,
  provenanceNote,
  SAMPLE_LAUNCH_START_FRACTIONAL,
  SAMPLE_LAUNCH_START_NONE,
  SAMPLE_LAUNCH_START_WHOLE,
  stubCallCount,
  type SpawnHold,
  type StubCallLog,
  type StubResolveSystemBinaryOutcome,
  type UnavailableForm,
} from './test-helpers/agent-director-stub.ts'
import type { Client } from 'agent-director'
import type { DeleteParams, FindMissingParams, KillParams, ReadPaneParams, ResumeParams, SendKeysParams, SpawnParams, SpawnResult, StatusParams } from 'agent-director'
import { configDirLabelValue, personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeNotifierHarness, type NotifierHarness } from './test-helpers/persona-notifier.ts'
import { stubOpenedDmId, type StubWebMethod } from './test-helpers/slack-stub.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import type { Persona, PersonaConfig } from '../src/config.ts'
import {
  createUnavailableRetryController,
  UNAVAILABLE_RETRY_BASE_S,
  UNAVAILABLE_RETRY_CAUSE_KILL_FAILED,
  UNAVAILABLE_RETRY_CAUSE_LOST_RACE,
  UNAVAILABLE_RETRY_CAUSE_PENDING_ROW,
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED,
  UNAVAILABLE_RETRY_MODE_FULL,
  UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
  type UnavailableRetryController,
} from '../src/unavailable-retry.ts'
import { RECHECK_OUTCOME_PASS, RECHECK_OUTCOME_STOP, installAdVersionRecheck, resetAdVersionRecheckForTests } from '../src/ad-version-gate.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import {
  callCounts,
  callCountsSince,
  killFailureEndedLine,
  killFailureLines,
  killFailureLoggedLine,
  killFailureNotice,
  killFailureRecoveryEntry,
  collided,
  makeRecoveryHarness,
  ordinaryAlertContent,
  personaCallCounts,
  startupEntriesOf,
  retryNow,
  rowReadsUntilSpawn,
  type RecoveryHarness,
  type RecoveryStubScript,
} from './test-helpers/recovery-harness.ts'
import {
  NO_LAUNCH_START_FORMS,
  NO_LAUNCH_START_FORM_NAMES,
  RESTART_KILL_CONFLICT_CASE_ROWS,
  RESTART_KILL_UNUSABLE_NAME_CASE_ROWS,
  UNUSABLE_NAME_CASE_ROWS,
  launchStartRecord,
  reconnectConflictRowsAt,
  tmuxTouchingCallsIn,
} from './test-helpers/conflict-cases.ts'
import {
  createPersonaEpisodes,
  KILL_FAILURE_END_ROW_FINISHED,
  TMUX_UNRESPONSIVE_ONSET_FLOOR_MS,
  tmuxUnresponsiveOnsetText,
} from '../src/persona-episodes.ts'
import {
  createSlowRecoveryTracker,
  SLOW_RECOVERY_POST_THRESHOLD,
  SLOW_RECOVERY_RESET_OTHER_VERDICT,
  slowRecoveryCountResetLine,
  slowRecoveryNoticePostedLine,
  slowRecoveryText,
} from '../src/slow-recovery.ts'
import { OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import { createInvalidFlagsHold, INVALID_FLAGS_HOLD_LOG_PREFIX, type InvalidFlagsHold } from '../src/invalid-flags-hold.ts'
import {
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_ENDED,
  LIVENESS_DEAD_ROW_MISSING,
  LIVENESS_READING_DEAD,
  LIVENESS_READING_DEAD_ENDED,
  LIVENESS_READING_DEAD_INSTALL_GONE,
  LIVENESS_READING_DEAD_MISSING,
  LIVENESS_READING_DEAD_NO_ROW,
  LIVENESS_READING_LIVE,
  LIVENESS_READING_PENDING,
  LIVENESS_READING_UNKNOWN,
  LIVENESS_PENDING,
  pendingLivenessReading,
  type DeadLivenessReading,
  type LivenessReading,
  type PendingLivenessReading,
} from '../src/liveness-reading.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_DELAY_S = 0.01  // 10 ms timer — fast enough for tests
const SLOW_DELAY_S = 9999  // large enough to never fire during a test
const WAIT_MS = 50         // wait after scheduling; long enough for FAST_DELAY_S to fire
const CAP_BASE_DELAY_S = 0.001  // 1 ms base for the cap-driving helper below
const CAP_MARGIN_MS = 40        // margin above each computed backoff delay

/**
 * Stop every dialog approver a real launch started and wait until each has
 * stopped (after any call in progress returned), then forget them and every
 * launch still marked in flight: no approver outlives the case (b.jg5
 * SRJ-401: a launch returns before its approver's first lap, so one may still
 * be running when the case ends).
 */
async function stopApproversAndForgetLaunches(): Promise<void> {
  await stopAllDialogApprovers()
  _resetInFlightLaunches()
}

/**
 * The restart work's line for a kill that did not succeed and latched nothing
 * (b.jg5 SRJ-110, SRJ-701): no relaunch, nothing counted.
 */
const KILL_REFUSED_LINE = (key: string, outcome: KillOutcome) => killNotSucceededLine(key, describeKillOutcome(outcome), false)

/** The head of the restart work's not-succeeded kill line for `key`, from its builder. */
function killNotSucceededHead(key: string): string {
  const marker = '\u0000'
  const line = killNotSucceededLine(key, marker, false)
  return line.slice(0, line.indexOf(marker))
}

/** The kill's success the hand-built `killSession` stand-ins answer: `kill_sent: true` (b.jg5 SRJ-701: only a success lets the launch follow). */
const KILL_SUCCEEDED: KillOutcome = { kind: KILL_OUTCOME_KILLED, killSent: true }

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type DepsOpts = {
  isSessionAliveResult?: LivenessReading  // default: LIVENESS_READING_DEAD (session is dead)
  isSessionConnectedResult?: boolean  // default: false (not yet reconnected)
  hasSessionStreamResult?: boolean  // default: true (stream present — prior semantics)
  launchSessionResult?: LaunchSessionResult  // default: true (launch succeeds); 'skipped': the relaunch gate declined
  launchSession?: (key: string, cwd: string, sessionId?: string, deadEvidence?: CarriedDeadEvidence) => Promise<LaunchSessionResult>  // override entire launchSession
  killSession?: (key: string, lastRead: DeadLivenessReading) => Promise<KillSessionResult>  // runs after the capture (e.g. the real kill adapter), given the run's dead reading; its answer is the kill's (default: KILL_SUCCEEDED)
  restartDelay?: number           // default: FAST_DELAY_S
  isShuttingDown?: boolean        // default: false
  onCapReached?: (key: string) => void  // called after the capture (e.g. the real cap-notice function)
}

/** One `RestartDeps.launchSession` call: `deadEvidence` is present only when the call passed a verdict (b.jg5 SRJ-611). */
type LaunchSessionCall = { key: string; cwd: string; sessionId: string | undefined; deadEvidence?: CarriedDeadEvidence }

/**
 * The reconnect adapter's escalate-dead answer carrying `verdict`, the
 * verdict it swept with, decided by the session manager's own builder (b.jg5
 * SRJ-611).
 */
function escalateDeadWith(verdict: DeadEvidenceSource): ReconnectEscalateDead {
  return { outcome: 'escalate-dead', deadEvidence: carriedDeadEvidenceOf(verdict) }
}

/**
 * The escalate-dead answer of b.d61's GONE-based verdict (a `working` row's
 * `read-pane` answered GONE): dead evidence, so a `dead` re-probe after it
 * leads to the checked kill and then the relaunch (b.jg5 SRJ-611).
 */
const ESCALATE_DEAD_WORKING_GONE = escalateDeadWith('working-tmux-gone')

function makeDeps(opts: DepsOpts = {}): RestartDeps & {
  isSessionAliveCalls: string[]
  killSessionCalls: string[]
  /** The `dead` reading each `killSession` call was handed (b.jg5 SRJ-501), in call order. */
  killSessionReads: DeadLivenessReading[]
  /** Each launch call; `deadEvidence` only on a call that carried a verdict (b.jg5 SRJ-611). */
  launchSessionCalls: LaunchSessionCall[]
  reconnectSessionCalls: string[]
  onCapReachedCalls: string[]
  armRetryTimerCalls: string[]
} {
  const isSessionAliveCalls: string[] = []
  const killSessionCalls: string[] = []
  const killSessionReads: DeadLivenessReading[] = []
  const launchSessionCalls: LaunchSessionCall[] = []
  const reconnectSessionCalls: string[] = []
  const onCapReachedCalls: string[] = []
  const armRetryTimerCalls: string[] = []

  return {
    isSessionAliveCalls,
    killSessionCalls,
    killSessionReads,
    launchSessionCalls,
    reconnectSessionCalls,
    onCapReachedCalls,
    armRetryTimerCalls,

    canRestart: () => true,
    async isSessionAlive(key) {
      isSessionAliveCalls.push(key)
      return opts.isSessionAliveResult ?? LIVENESS_READING_DEAD
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
    async killSession(key, lastRead) {
      killSessionCalls.push(key)
      killSessionReads.push(lastRead)
      return opts.killSession ? opts.killSession(key, lastRead) : KILL_SUCCEEDED
    },
    async launchSession(key, cwd, sessionId, deadEvidence) {
      launchSessionCalls.push({ key, cwd, sessionId, ...(deadEvidence === undefined ? {} : { deadEvidence }) })
      if (opts.launchSession) return opts.launchSession(key, cwd, sessionId, deadEvidence)
      return opts.launchSessionResult ?? true
    },
    getRestartDelay: () => opts.restartDelay ?? FAST_DELAY_S,
    isShuttingDown: () => opts.isShuttingDown ?? false,
    onCapReached: (key) => {
      onCapReachedCalls.push(key)
      opts.onCapReached?.(key)
    },
    armRetryTimer: (key) => {
      armRetryTimerCalls.push(key)
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

/** One call the restart work made to the slow-recovery observer: the note, the persona key and, for `noteOther`, its reason. */
type SlowRecoveryNote = readonly [note: keyof RestartSlowRecoveryObserver, key: string, reason?: SlowRecoveryOtherReason]

/** A slow-recovery observer (b.jg5 SRJ-610) that appends each note it is told to `into`, in call order. */
function recordingSlowRecovery(into: unknown[]): RestartSlowRecoveryObserver {
  return {
    noteLive: (key) => { into.push(['noteLive', key]) },
    noteDead: (key) => { into.push(['noteDead', key]) },
    noteInstallGone: (key) => { into.push(['noteInstallGone', key]) },
    noteOther: (key, reason) => { into.push(['noteOther', key, reason]) },
  }
}

/**
 * Make each restart run of `deps` awaitable: installs a `serialize` that runs
 * the work at once and records its outcome in `outcomes`. `tick(key, cwd)`
 * schedules a restart and resolves once its work has run and one event-loop
 * turn has passed (in which the timer body releases its active marker), or at
 * once when `scheduleRestart` armed no timer; never a fixed sleep.
 */
function awaitRuns(deps: RestartDeps): { outcomes: unknown[]; tick: (key: string, cwd: string) => Promise<void> } {
  const outcomes: unknown[] = []
  let workDone = Promise.withResolvers<void>()
  deps.serialize = async <T>(_key: string, operation: () => T | Promise<T>): Promise<T> => {
    try {
      const outcome = await operation()
      outcomes.push(outcome)
      return outcome
    } catch (err) {
      workDone.reject(err)
      throw err
    } finally {
      workDone.resolve()
    }
  }
  const tick = async (key: string, cwd: string): Promise<void> => {
    workDone = Promise.withResolvers<void>()
    scheduleRestart(key, cwd)
    if (!isRestartPendingOrActive(key)) return
    await workDone.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return { outcomes, tick }
}

/**
 * The stub calls in `log` that are one persona's, by verb, leaving out verbs
 * with none: those naming its instance `instanceId`, and those naming no
 * instance (the whole-store `find-missing`). A call another case left running
 * for another persona is never counted.
 */
function ownStubCalls(log: StubCallLog, instanceId: string): Record<string, number> {
  const isOwn = (params: unknown): boolean => {
    const named = (params as { claude_instance_id?: unknown } | undefined)?.claude_instance_id
    return named === undefined || named === instanceId
  }
  return Object.fromEntries(
    Object.entries(log)
      .map(([verb, calls]) => [verb, (calls as unknown[]).filter(isOwn).length] as const)
      .filter(([, count]) => count > 0),
  )
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
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
    initRestart(deps)

    scheduleRestart('test_bot_1', '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toHaveLength(1)
    expect(deps.reconnectSessionCalls).toHaveLength(1)
    expect(deps.reconnectSessionCalls[0]).toBe('test_bot_1')
    expect(deps.launchSessionCalls).toHaveLength(0)
  })

  test('3b. session alive but reconnectSession throws — does not propagate, launchSession NOT called', async () => {
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
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
  // argument is kept unformatted. A thrown liveness probe reads `unknown`
  // (b.jg5 SRJ-314): its line is the unknown line naming the failure, nothing
  // is killed or launched, and the arm hook is called once.
  const describedFailure = (dep: string) => `Error code=EIO message="${dep} refused (${REDACTED_SENTINEL_TAIL})" at `
  test.each<[string, 'isSessionAlive' | 'reconnectSession' | 'launchSession', DepsOpts, string, string, string[], string[]]>([
    ['isSessionAlive throws', 'isSessionAlive', {}, 'isSessionAlive failed',
      `[slack] Liveness unknown for persona=test_bot_1 (isSessionAlive failed: ${describedFailure('isSessionAlive')}`, [], ['test_bot_1']],
    ['reconnectSession throws (session alive)', 'reconnectSession', { isSessionAliveResult: LIVENESS_READING_LIVE }, 'reconnectSession failed',
      `[slack] restart: reconnectSession failed for persona=test_bot_1: ${describedFailure('reconnectSession')}`, [], []],
    ['launchSession throws', 'launchSession', {}, 'launchSession threw',
      `[slack] restart: launchSession threw for persona=test_bot_1: ${describedFailure('launchSession')}`, ['test_bot_1'], []],
  ])('AC 20: %s with an error carrying fake tokens — one line naming its type, code and redacted message; nothing leaks', async (_label, dep, opts, phrase, linePrefix, kills, armed) => {
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
    expect(String(lines[0]![0])).toStartWith(linePrefix)
    expect(deps.killSessionCalls).toEqual(kills)
    // The launchSession row replaces the recording launch; no other row launches.
    if (dep !== 'launchSession') expect(deps.launchSessionCalls).toEqual([])
    expect(deps.armRetryTimerCalls).toEqual(armed)
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
      isSessionAliveResult: LIVENESS_READING_LIVE,
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
      isSessionAliveResult: LIVENESS_READING_LIVE,
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
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_DEAD })
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
      expect(bLines).toEqual([relaunchAfterKillLine(B, '/cwd/b', KILL_SUCCEEDED)])
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
    let aliveResolve!: (reading: LivenessReading) => void
    const alivePromise = new Promise<LivenessReading>((res) => { aliveResolve = res })

    const deps: RestartDeps = {
      canRestart: () => true,
      isSessionAlive: (_key) => alivePromise,  // never resolves until we say so
      isSessionConnected: () => false,
      hasSessionStream: () => true,
      reconnectSession: async () => {},
      killSession: async () => KILL_SUCCEEDED,
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

    aliveResolve(LIVENESS_READING_DEAD) // avoid dangling promise
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
  //     liveness again and, when the row reads dead, relaunches at once,
  //     its checked kill first only after a verdict that is dead evidence
  //     (b.d61, b.jg5 SRJ-611; a row that still reads alive is left to a later
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
    const reconnectDeps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
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
    const escapingDeps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
    escapingDeps.reconnectSession = async (_key) => ESCALATE_DEAD_WORKING_GONE
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

  // b.jg5 SRJ-303: 'pending' (the row reads `pending`, nothing typed) is a
  // deferral like 'transient' on the restart timer's path: nothing counted.
  test.each<[string, 'transient' | 'pending']>([
    ['transient', 'transient'],
    ['pending (b.jg5 SRJ-303: a row not started yet)', 'pending'],
  ])('(4c) reconnect result=%s leaves counter unchanged at reconnect site', async (_label, verdict) => {
    const KEY = 'reconnect_transient_bot'

    // Pre-seed a failure so "unchanged" is distinguishable from "reset to 0"
    const failDeps = makeDeps({ launchSessionResult: false })
    initRestart(failDeps)
    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(getFailureCount(KEY)).toBe(1)

    const transientDeps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
    transientDeps.reconnectSession = async (_key) => verdict
    initRestart(transientDeps)

    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // Counter unchanged — counting is not done at the reconnect site
    expect(getFailureCount(KEY)).toBe(1)
    expect(isAtCap(KEY, RESTART_FAILURE_CAP)).toBe(false)
    expect(transientDeps.onCapReachedCalls).toHaveLength(0)
  })

  test('(4d) reconnect throws (undefined result) — counter unchanged at reconnect site', async () => {
    const KEY = 'reconnect_throw_bot'

    // Pre-seed a failure so "unchanged" is distinguishable from "reset to 0"
    const failDeps = makeDeps({ launchSessionResult: false })
    initRestart(failDeps)
    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)
    expect(getFailureCount(KEY)).toBe(1)

    const throwingDeps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
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

  // b.jg5 SRJ-303: a 'pending' deferral (the row not started yet) takes the
  // same no-op path.
  test.each<[string, 'transient' | 'pending']>([
    ['"transient" (working-state defer)', 'transient'],
    ['"pending" (b.jg5 SRJ-303: a row not started yet)', 'pending'],
  ])('(6a) b.9a7: alive + reconnect=%s does not relaunch or re-arm', async (_label, verdict) => {
    // Unique to this case (the "transient leaves the counter unchanged" behavior
    // is already pinned by 4c): the working-state defer takes NO recovery action
    // and restart.ts does NOT re-enter scheduleRestart — the tick is the retry
    // driver. This asserts the observable no-op side of the defer contract.
    const KEY = 'defer_9a7_bot'
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
    deps.reconnectSession = async (key) => {
      deps.reconnectSessionCalls.push(key)
      return verdict
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
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
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

  test.each<[string, LivenessReading]>([
    ['its session dead (the kill + relaunch branch)', LIVENESS_READING_DEAD],
    ['its session alive (the reconnect branch)', LIVENESS_READING_LIVE],
  ])('a restart scheduled while up, whose persona is no longer up when the timer fires, probes, reconnects, kills and launches nothing; its count and cap latch are unchanged; the skip is logged — %s', async (_label, reading) => {
    // One failure short of the cap: a counted failure would cap and notify.
    for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(KEY)
    const deps = makeGatedDeps({ isSessionAliveResult: reading, launchSessionResult: false })
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
    if (reading === LIVENESS_READING_LIVE) {
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

  test.each<[string, LivenessReading]>([
    ['the probe answers dead (the kill + relaunch branch)', LIVENESS_READING_DEAD],
    ['the probe answers alive and disconnected (the reconnect branch)', LIVENESS_READING_LIVE],
    ['the probe answers unknown (b.jg5 SRJ-314: the not-up skip comes first, so the arm hook is not called)', LIVENESS_READING_UNKNOWN],
  ])('the persona stops being up while the liveness probe is pending: once the probe settles nothing is reconnected, killed or launched; its count and cap latch are unchanged; the skip is logged once — %s', async (_label, reading) => {
    // One failure short of the cap: a counted failure would cap and notify.
    for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(KEY)
    const deps = makeGatedDeps({ launchSessionResult: false })
    // Hold the probe open until the test settles it.
    let settleProbe!: () => void
    const probeEntered = new Promise<void>((entered) => {
      deps.isSessionAlive = (key) => {
        deps.isSessionAliveCalls.push(key)
        entered()
        return new Promise<LivenessReading>((res) => { settleProbe = () => res(reading) })
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
    expect(deps.armRetryTimerCalls).toEqual([])
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
    _resetFindMissingMemo()
  })

  afterEach(() => {
    console.error = origConsoleError
    cancelAllRestartTimers()
    resetClientForTests()
    _resetOutageState()
    setSessionNotifier(undefined)
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
// Seams only: the reconnect is one send-keys through the stub, with no tmux
// server start and no retry (b.jg5 SRJ-609), so no live tmux/fleet is ever
// touched. The findMissing memo is reset per test so the call count is
// deterministic (the TTL setter alone does not clear the memo).
// ---------------------------------------------------------------------------

describe('escalate-dead internal recovery via real adapter (b.sv7)', () => {
  /**
   * Build restart deps whose `reconnectSession` is the REAL adapter, plus a
   * mutable liveness reading so a test can flip it between simulated ticks.
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
    setAlive: (v: LivenessReading) => void
  } {
    let alive: LivenessReading = LIVENESS_READING_LIVE
    const killSessionCalls: string[] = []
    const launchSessionCalls: string[] = []
    const findMissingCalls: FindMissingParams[] = []
    const statusCalls: StatusParams[] = []
    const sendKeysCalls: SendKeysParams[] = []

    // Non-working status → adapter falls through to the reconnect; one
    // ErrTmuxSendKeys on send-keys → 'dead-session' (`tmux-gone`) at once →
    // adapter maps to 'escalate-dead' and fires the internal sweep.
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
      async killSession(key) { killSessionCalls.push(key); return KILL_SUCCEEDED },
      async launchSession(key) { launchSessionCalls.push(key); return true },
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: () => {},
    }
    return { deps, findMissingCalls, statusCalls, sendKeysCalls, setAlive: (v: LivenessReading) => { alive = v } }
  }

  beforeEach(() => {
    _resetFindMissingMemo()
  })

  afterEach(() => {
    resetClientForTests()
    _resetOutageState()
    _resetFindMissingMemo()
  })

  test('tick 1: alive+dead-tmux verdict fires exactly one internal findMissing sweep; the re-probe still reads alive (no kill/relaunch); tick 2: session dead → kill+relaunch', async () => {
    const KEY = 'C_DEADTMUX'
    const { deps, findMissingCalls, statusCalls, sendKeysCalls, setAlive } = makeRealAdapterDeps()
    initRestart(deps)

    // --- Tick 1: row still looks alive; the real adapter runs reconnectMcp,
    // which returns 'dead-session' → 'escalate-dead', firing the internal sweep.
    setAlive(LIVENESS_READING_LIVE)
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
    // status probe, then exactly one send-keys reconnect (no second try).
    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(KEY)])
    expect(sendKeysCalls.map((c) => c.claude_instance_id)).toEqual(['cscb_C_DEADTMUX'])

    // --- Tick 2: the row has since been reconciled to `missing`, so the next
    // tick observes the session dead. The normal kill+relaunch branch runs.
    // Reset the memo so this tick's semantics don't depend on the prior sweep's
    // TTL — we are simulating a LATER tick past the memo window.
    _resetFindMissingMemo()
    setAlive(LIVENESS_READING_DEAD)
    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    expect(deps.killSessionCalls).toEqual([KEY])
    expect(deps.launchSessionCalls).toEqual([KEY])
    // Tick 2 found the session dead at its first probe: no reconnect, so still one send-keys.
    expect(sendKeysCalls).toHaveLength(1)
  })

  test('b.d61: the sweep reconciles the row before the re-probe → the same run kills and relaunches once, with no second relaunch', async () => {
    const KEY = 'C_DEADTMUX'
    const { deps, findMissingCalls, sendKeysCalls } = makeRealAdapterDeps()
    // The row reads alive until the sweep has run and dead after it (what AD
    // does for a row whose tmux session is gone).
    deps.isSessionAlive = async () => (findMissingCalls.length === 0 ? LIVENESS_READING_LIVE : LIVENESS_READING_DEAD)
    initRestart(deps)

    scheduleRestart(KEY, '/cwd/test')
    await Bun.sleep(WAIT_MS)

    // 'dead-session' → 'escalate-dead': the one send-keys reconnect answered
    // GONE and the sweep ran once; the re-probe read the row dead, so this
    // one run killed and relaunched it and armed nothing further.
    expect(sendKeysCalls).toHaveLength(1)
    expect(findMissingCalls).toHaveLength(1)
    expect(deps.killSessionCalls).toEqual([KEY])
    expect(deps.launchSessionCalls).toEqual([KEY])
    expect(getFailureCount(KEY)).toBe(0)
    expect(isRestartPendingOrActive(KEY)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-610, SRJ-1010 (HO C14 Verify, AC 66): a row the escalate-dead
// sweep leaves live for several ticks.
//
// P's row reads `working` on every `status`; its `read-pane` answers GONE
// (`ErrTmuxCaptureFailed`), so the reconnect adapter sweeps and answers
// 'escalate-dead'; every `find-missing` leaves P's own row in
// `unverified_ids`, so the run reads that row with one `get` (b.jg5 SRJ-120),
// whose note latches no one; and the re-probe still reads the row live. P
// reads disconnected, except on a run a case marks healed, where it reads
// connected with its stream and the run stops as already connected. The
// liveness probe and the reconnect adapter are the REAL ones over one stub
// client, the slow-recovery observer is the real tracker over a real episodes
// instance on a fake clock, whose sink records each post, and the latch and
// the configured-persona query are installed as `main()` installs them. Kill
// and launch are recording fakes. The findMissing memo runs on the same fake
// clock (`_setNow`), moved past `FIND_MISSING_MEMO_TTL_MS` between runs, so
// every run sweeps. Each run is awaited (`awaitRuns`), and only P's own stub
// calls are counted (`ownStubCalls`). No tmux is asked: the raw runner records
// every argv.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-610, SRJ-1010: a row the escalate-dead sweep leaves in unverified_ids for several ticks (HO C14 Verify, AC 66)', () => {
  /** Two runs past the post, so a second post or one before the threshold shows. */
  const RUNS = SLOW_RECOVERY_POST_THRESHOLD + 2
  let dir: string
  let clock: FakeClock
  let latch: ConflictLatch
  let errLines: string[]
  /** Every argv the raw tmux runner was asked to run. */
  let rawTmux: string[][]
  /** The persona keys the session manager raised a spawn-failure notice for. */
  let raised: string[]
  let origConsoleError: typeof console.error

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restart-slow-recovery-'))
    _resetFindMissingMemo()
    clock = createFakeClock()
    _setNow(() => clock.now())
    errLines = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }
    rawTmux = []
    _setTmuxCommandRunner(async (args) => {
      rawTmux.push([...args])
      return { code: 1, stdout: '' }
    })
    raised = []
    setSessionNotifier((key) => { raised.push(key) })
    latch = createConflictLatch({ log: (line) => { errLines.push(line) } })
    setConflictLatch(latch)
  })

  afterEach(() => {
    console.error = origConsoleError
    cancelAllRestartTimers()
    resetClientForTests()
    _resetOutageState()
    _resetTmuxCommandRunner()
    _resetFindMissingMemo()
    _resetNow()
    setConflictLatch(undefined)
    _resetConfiguredPersonaQuery()
    setSessionNotifier(undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * P's restart deps as the describe comment says; the `get` after each
   * sweep carries `noteOfRun(run)` (runs count from 1). On a run
   * `connectedOnRun(run)` answers true for, P reads connected with its
   * stream (it healed on its own), so that run stops at its first probe as
   * already connected. `nextRun()` moves the clock past the memo window,
   * then schedules P's restart and awaits it.
   */
  function slowRecoveryRuns(noteOfRun: (run: number) => string, connectedOnRun: (run: number) => boolean = () => false) {
    const config = makeMultiPersonaConfig([{ name: 'alpha_bot' }], dir)
    const persona = config.personas[0]!
    const KEY = persona.key
    const instanceId = personaInstanceId(KEY)
    setConfiguredPersonaQuery((key) => key === KEY)
    let run = 0
    const log = makeStubCallLog()
    const stub = makeStubClient({
      ...log,
      statusFn: () => ({ state: 'working' }),
      readPaneError: errTmuxCaptureFailed(),
      findMissingResult: cannedFindMissing({ rows: { [instanceId]: 'unverified_ids' } }),
      getFn: () => cannedGetResult({ claude_instance_id: instanceId, state: 'working', liveness_note: noteOfRun(run) }),
    })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    const posts: Array<[string, string]> = []
    const episodes = createPersonaEpisodes({ sink: (key, text) => { posts.push([key, text]) }, log: (line) => { errLines.push(line) }, clock })
    const kills: string[] = []
    const launches: string[] = []
    const armed: string[] = []
    const deps: RestartDeps = {
      canRestart: () => true,
      isSessionAlive: _buildIsSessionAliveAdapter(() => config),
      isSessionConnected: () => connectedOnRun(run),
      hasSessionStream: () => connectedOnRun(run),
      reconnectSession: _buildReconnectSessionAdapter(),
      async killSession(key) { kills.push(key); return KILL_SUCCEEDED },
      async launchSession(key) { launches.push(key); return true },
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: () => {},
      armRetryTimer: (key) => { armed.push(key) },
      isLatched: (key) => latch.isLatched(key),
      slowRecovery: createSlowRecoveryTracker({ episodes, log: (line) => { errLines.push(line) } }),
    }
    const { outcomes, tick } = awaitRuns(deps)
    initRestart(deps)
    const nextRun = async (): Promise<void> => {
      await clock.advance(FIND_MISSING_MEMO_TTL_MS)
      run++
      await tick(KEY, persona.working_directory)
    }
    return { KEY, posts, kills, launches, armed, outcomes, nextRun, stubCalls: () => ownStubCalls(log, instanceId) }
  }

  test(`demo: ${SLOW_RECOVERY_POST_THRESHOLD + 2} ticks, each an escalate-dead verdict whose re-probe still reads the row live → one sweep and one get per tick, no delete, kill or launch, no counted failure, no spawn-failure notice, and exactly one slow-recovery post, after tick ${SLOW_RECOVERY_POST_THRESHOLD}, with SRJ-1010's text`, async () => {
    const runs = slowRecoveryRuns((run) => nonLatchingNotes[(run - 1) % nonLatchingNotes.length]!)

    for (let run = 1; run <= RUNS; run++) {
      await runs.nextRun()
      // The probe, the adapter's state read, its read-pane, the sweep and its
      // get of P's own row, then the re-probe: nothing typed, deleted, killed
      // or launched.
      expect(runs.stubCalls()).toEqual({ statusCalls: 3 * run, readPaneCalls: run, findMissingCalls: run, getCalls: run })
      expect(runs.posts).toEqual(run >= SLOW_RECOVERY_POST_THRESHOLD ? [[runs.KEY, slowRecoveryText(runs.KEY)]] : [])
      expect(errLines.filter((l) => l === reprobeLiveLine(runs.KEY))).toHaveLength(run)
    }

    expect(runs.outcomes).toEqual(Array(RUNS).fill(RESTART_OUTCOME_RECONNECT_DEFERRED))
    // b.jg5 SRJ-610, SRJ-611: no kill outside the live-row sequence, and no
    // sequence started for P either: the escalate-dead verdict (GONE-based,
    // dead evidence) leads to no kill, delete or launch while the row reads live.
    expect(runs.kills).toEqual([])
    expect(isLiveRowSequenceRunning(runs.KEY)).toBe(false)
    expect(runs.launches).toEqual([])
    expect(getFailureCount(runs.KEY)).toBe(0)
    expect(raised).toEqual([])
    expect(runs.armed).toEqual([])
    expect(latch.isLatched(runs.KEY)).toBe(false)
    expect(isRestartPendingOrActive(runs.KEY)).toBe(false)
    expect(rawTmux).toEqual([])
    expect(clock.pendingCount()).toBe(0)
    assertNoLeak({ errLines, posts: runs.posts })
  })

  // SRJ-1010's "consecutive": a run between them that finds P healed on its
  // own (connected with its stream) resets the count, so the post waits for
  // threshold-many escalate-dead runs in a row after it.
  test(`a run that finds P already connected with its stream, after ${SLOW_RECOVERY_POST_THRESHOLD - 1} escalate-dead ticks whose re-probe reads live, resets the count: no post until ${SLOW_RECOVERY_POST_THRESHOLD} more such ticks in a row, then exactly one`, async () => {
    const healedRun = SLOW_RECOVERY_POST_THRESHOLD
    const total = 2 * SLOW_RECOVERY_POST_THRESHOLD
    const runs = slowRecoveryRuns(() => nonLatchingNotes[0]!, (run) => run === healedRun)

    for (let run = 1; run <= total; run++) {
      await runs.nextRun()
      expect(runs.posts).toEqual(run === total ? [[runs.KEY, slowRecoveryText(runs.KEY)]] : [])
    }

    expect(runs.outcomes).toEqual([
      ...Array(healedRun - 1).fill(RESTART_OUTCOME_RECONNECT_DEFERRED),
      RESTART_OUTCOME_ALREADY_CONNECTED,
      ...Array(total - healedRun).fill(RESTART_OUTCOME_RECONNECT_DEFERRED),
    ])
    // The healed run's probe only: no state read, read-pane, sweep or get.
    const escalated = total - 1
    expect(runs.stubCalls()).toEqual({ statusCalls: 3 * escalated + 1, readPaneCalls: escalated, findMissingCalls: escalated, getCalls: escalated })
    expect(errLines.filter((l) => l === slowRecoveryCountResetLine(runs.KEY, healedRun - 1, SLOW_RECOVERY_RESET_OTHER_VERDICT))).toHaveLength(1)
    expect(errLines.filter((l) => l === slowRecoveryNoticePostedLine(runs.KEY, SLOW_RECOVERY_POST_THRESHOLD))).toHaveLength(1)
    expect(runs.kills).toEqual([])
    expect(runs.launches).toEqual([])
    expect(getFailureCount(runs.KEY)).toBe(0)
    expect(raised).toEqual([])
    expect(rawTmux).toEqual([])
    expect(clock.pendingCount()).toBe(0)
    assertNoLeak({ errLines, posts: runs.posts })
  })

  // The second tick, and the tick that would post: a re-probe after the
  // latch would count that tick and post.
  test.each([2, SLOW_RECOVERY_POST_THRESHOLD])('a provenance_conflict note on the get after tick %p\'s sweep latches P (E14): that run stops before its re-probe, the later ticks schedule nothing (E13), and no slow-recovery post is made', async (latchRun) => {
    const runs = slowRecoveryRuns((run) => (run === latchRun ? provenanceNote : nonLatchingNotes[0]!))

    for (let run = 1; run <= RUNS; run++) await runs.nextRun()

    expect(latch.isLatched(runs.KEY)).toBe(true)
    // The ticks before as in the demo; the latching tick with no re-probe; no
    // agent-director call after it.
    expect(runs.stubCalls()).toEqual({ statusCalls: 3 * latchRun - 1, readPaneCalls: latchRun, findMissingCalls: latchRun, getCalls: latchRun })
    expect(runs.outcomes).toEqual([...Array(latchRun - 1).fill(RESTART_OUTCOME_RECONNECT_DEFERRED), RESTART_OUTCOME_LATCHED])
    expect(errLines.filter((l) => l.startsWith(`[slack] Not scheduling restart for persona=${runs.KEY} — the persona is latched`))).toHaveLength(RUNS - latchRun)
    expect(runs.posts).toEqual([])
    expect(runs.kills).toEqual([])
    expect(runs.launches).toEqual([])
    expect(getFailureCount(runs.KEY)).toBe(0)
    expect(raised).toEqual([])
    expect(rawTmux).toEqual([])
    expect(clock.pendingCount()).toBe(0)
    assertNoLeak({ errLines, posts: runs.posts })
  })
})

// ---------------------------------------------------------------------------
// b.d61, b.jg5 SRJ-603, SRJ-604: a persona killed mid-turn is relaunched, not
// deferred forever.
//
// The live Check 7 shape: the persona's session is killed while it is
// `working`, so its MCP session drops and AD's row stays frozen at `working`
// until a findMissing sweep reconciles it. The liveness probe and the reconnect
// adapter are the REAL ones over one stub AD client whose row reads `working`
// (or `waiting`) until a findMissing sweep has run and `missing` after it (what
// AD does for a row whose session is gone). The row's evidence is the one
// `read-pane` the reconnect adapter makes of it: GONE (`ErrTmuxCaptureFailed`)
// sweeps and escalates with nothing typed, and the restart run's liveness
// re-probe after the 'escalate-dead' verdict reads the reconciled row, so the
// checked kill and the relaunch happen in that same run (b.jg5 SRJ-611). An
// UNAVAILABLE `read-pane` of a `working` row is no proof the session is gone:
// the run defers, with no sweep, kill, launch or accounting. Kill and launch
// are recording fakes. No tmux is asked: the raw runner records every argv
// here. Each case awaits its restart work's end, not a
// fixed sleep, and counts only the run's own calls (its persona's instance
// and the whole-store sweep), so neither a late timer nor another persona's
// call made while the case runs changes a count.
// ---------------------------------------------------------------------------

describe('b.d61: a working persona whose tmux session is gone is relaunched in the same restart run', () => {
  let dir: string
  /** Every argv the raw tmux runner was asked to run. */
  let rawTmux: string[][]
  let errLines: string[]
  let origConsoleError: typeof console.error

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restart-d61-'))
    _resetFindMissingMemo()
    rawTmux = []
    _setTmuxCommandRunner(async (args) => {
      rawTmux.push([...args])
      return { code: 1, stdout: '' }
    })
    errLines = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.error = origConsoleError
    cancelAllRestartTimers()
    resetClientForTests()
    _resetOutageState()
    _resetTmuxCommandRunner()
    _resetFindMissingMemo()
    rmSync(dir, { recursive: true, force: true })
  })

  /** P's `status` answer, by whether the findMissing sweep has run yet. */
  type RowAnswer = (swept: boolean) => { state: string } | Error

  /**
   * One persona's restart deps over the real liveness and reconnect adapters
   * and one stub client: its `status` answers `row`, its `read-pane` rejects
   * with `readPaneError`, kill and launch record (the launch answering
   * `launchResult`, and `carriedIn` the verdict each launch was handed, b.jg5
   * SRJ-611), and the arm hook, the slow-recovery observer's notes
   * (`notes`, b.jg5 SRJ-610) and the serialized work's outcome are
   * recorded. `tick()` schedules the persona's restart and resolves once its
   * work has run (`awaitRuns`), whenever the timer fires. `stubCalls()`
   * is the run's stub calls by verb (`ownStubCalls`): those naming the
   * persona's own instance, and the whole-store `find-missing`, which names
   * none. The stub is the process's agent-director client while the case
   * runs, so a call another case left running (another persona's launch
   * wait, which polls until its timeout) is never counted as the run's.
   */
  function d61Run(row: RowAnswer, readPaneError: Error, launchResult = true) {
    const config = makeMultiPersonaConfig([{ name: 'alpha_bot' }], dir)
    const persona = config.personas[0]!
    const instanceId = personaInstanceId(persona.key)
    const log = makeStubCallLog()
    const stub = makeStubClient({ ...log, statusFn: () => row(log.findMissingCalls.length > 0), readPaneError })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    const kills: string[] = []
    const launches: string[] = []
    const carriedIn: Array<CarriedDeadEvidence | undefined> = []
    const armed: string[] = []
    const notes: SlowRecoveryNote[] = []
    const deps: RestartDeps = {
      canRestart: () => true,
      isSessionAlive: _buildIsSessionAliveAdapter(() => config),
      isSessionConnected: () => false,
      hasSessionStream: () => false,
      reconnectSession: _buildReconnectSessionAdapter(),
      async killSession(key) { kills.push(key); return KILL_SUCCEEDED },
      async launchSession(key, _cwd, _sessionId, deadEvidence) { launches.push(key); carriedIn.push(deadEvidence); return launchResult },
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: () => {},
      armRetryTimer: (key) => { armed.push(key) },
      slowRecovery: recordingSlowRecovery(notes),
    }
    const { outcomes, tick } = awaitRuns(deps)
    initRestart(deps)
    const stubCalls = (): Record<string, number> => ownStubCalls(log, instanceId)
    /** The run's pane reads, as `[instance id, lines]`. */
    const paneReads = (): Array<[string, number | undefined]> =>
      log.readPaneCalls.filter((c) => c.claude_instance_id === instanceId).map((c) => [c.claude_instance_id, c.n_lines])
    return { KEY: persona.key, CWD: persona.working_directory, kills, launches, carriedIn, armed, notes, outcomes, tick: () => tick(persona.key, persona.working_directory), stubCalls, paneReads }
  }

  /** The escalate-dead verdict lines (one per sweep the adapter fires); only `verdict`'s, with its evidence text, when given. */
  const escalateLines = (verdict?: EscalateDeadVerdict): string[] =>
    errLines
      .filter((l) => l.startsWith('[slack] escalate-dead: ') && l.includes(' verdict='))
      .filter((l) => verdict === undefined || l.includes(` verdict=${verdict} — ${ESCALATE_DEAD_EVIDENCE[verdict]},`))

  /** A row reading `state` until the sweep and `missing` after it. */
  const untilSwept = (state: string): RowAnswer => (swept) => ({ state: swept ? 'missing' : state })

  const WORKING_TMUX_GONE: EscalateDeadVerdict = 'working-tmux-gone'

  test.each<[string, EscalateDeadVerdict]>([
    ['working', WORKING_TMUX_GONE],
    ['waiting', ESCALATE_DEAD_WAITING_ROW_PANE_GONE],
  ])('alive (%s) but disconnected, its read-pane answering GONE → one read-pane of its own row, one findMissing sweep (verdict %s, dead evidence) and no send-keys; the re-probe reads the row missing → one noteDead, then one kill and one relaunch carrying the verdict in that run, no failure counted, nothing armed, no tmux asked', async (state, verdict) => {
    const run = d61Run(untilSwept(state), errTmuxCaptureFailed())

    await run.tick()

    // The probe, the adapter's state read, its read-pane and sweep, then the
    // re-probe; nothing is typed into a pane that no longer exists.
    expect(run.stubCalls()).toEqual({ statusCalls: 3, readPaneCalls: 1, findMissingCalls: 1 })
    expect(run.paneReads()).toEqual([[personaInstanceId(run.KEY), FULL_PANE_READ_LINES]])
    expect(escalateLines()).toHaveLength(1)
    expect(escalateLines(verdict)).toHaveLength(1)
    expect(run.kills).toEqual([run.KEY])
    expect(run.launches).toEqual([run.KEY])
    // b.jg5 SRJ-611: the relaunch carries the GONE-based verdict the adapter swept with.
    expect(run.carriedIn).toEqual([carriedDeadEvidenceOf(verdict)])
    expect(run.outcomes).toEqual([RESTART_OUTCOME_LAUNCHED])
    // b.jg5 SRJ-610: the re-probe's row read of `missing` ends any slow recovery.
    expect(run.notes).toEqual([['noteDead', run.KEY]])
    // The successful launch counts no failure.
    expect(getFailureCount(run.KEY)).toBe(0)
    // The run armed no further timer: nothing relaunches the persona again.
    expect(run.armed).toEqual([])
    expect(isRestartPendingOrActive(run.KEY)).toBe(false)
    expect(rawTmux).toEqual([])
  })

  // b.jg5 SRJ-117: the row absent at the read-pane takes the GONE column
  // without being a GONE. b.jg5 SRJ-611: its verdict is a row read, never dead
  // evidence, so the re-probe that reads the row missing leads to the
  // relaunch alone, carrying the verdict, with no kill.
  test.each(['working', 'waiting'])('alive (%s) but disconnected, its read-pane answering ErrSpawnNotFound → one findMissing sweep with the row-absent verdict and no send-keys; the re-probe reads the row missing → no kill, one relaunch carrying the row-absent verdict; no failure counted, no tmux asked', async (state) => {
    const run = d61Run(untilSwept(state), errSpawnNotFound())

    await run.tick()

    expect(run.stubCalls()).toEqual({ statusCalls: 3, readPaneCalls: 1, findMissingCalls: 1 })
    expect(escalateLines()).toHaveLength(1)
    expect(escalateLines(ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ)).toHaveLength(1)
    expect(run.kills).toEqual([])
    expect(run.launches).toEqual([run.KEY])
    const carried = carriedDeadEvidenceOf(ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ)
    expect(run.carriedIn).toEqual([carried])
    expect(isDeadEvidence(ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ)).toBe(false)
    expect(errLines.filter((l) => l === relaunchWithoutKillLine(run.KEY, carried))).toHaveLength(1)
    expect(run.outcomes).toEqual([RESTART_OUTCOME_LAUNCHED])
    expect(getFailureCount(run.KEY)).toBe(0)
    expect(run.armed).toEqual([])
    expect(rawTmux).toEqual([])
  })

  // b.jg5 SRJ-603 (HO C18 Verify, AC 77): a `working` row's read-pane that
  // could not run is never proof the session is gone. Every UNAVAILABLE form
  // a read can meet (the kill-failure form is a kill's only).
  const READ_PANE_UNAVAILABLE_FORMS = UNAVAILABLE_FORMS.filter(([, , cause]) => cause === UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)

  test.each(READ_PANE_UNAVAILABLE_FORMS)('alive (working) but disconnected, its read-pane answering UNAVAILABLE (%s) → the run defers: no sweep, send-keys, kill or launch, nothing counted or reset, nothing armed, no tmux asked; the transient verdict resets the slow-recovery count', async (_label, make) => {
    const run = d61Run(() => ({ state: 'working' }), make('read-pane'))
    // One failure on record, so a reset or a counted launch would show.
    recordFailure(run.KEY)

    await run.tick()

    expect(run.stubCalls()).toEqual({ statusCalls: 2, readPaneCalls: 1 })
    expect(escalateLines()).toEqual([])
    expect(run.kills).toEqual([])
    expect(run.launches).toEqual([])
    expect(run.outcomes).toEqual([RESTART_OUTCOME_RECONNECT_DEFERRED])
    expect(run.notes).toEqual([['noteOther', run.KEY, RESTART_SLOW_RECOVERY_OTHER_VERDICT]])
    expect(getFailureCount(run.KEY)).toBe(1)
    expect(run.armed).toEqual([])
    expect(isRestartPendingOrActive(run.KEY)).toBe(false)
    expect(rawTmux).toEqual([])
  })

  // b.jdc (/ci-live run 6), b.jg5 SRJ-606 (AC 38): a persona whose session
  // died while its row read `ask_user` or `check_permission`. agent-director
  // only refreshes the row at SessionEnd, so it keeps reading the prompt state
  // until a findMissing sweep reaps it. Before the fix the adapter deferred
  // the row as blocked on a prompt on every run and raised a *Waiting on a
  // prompt* notice about the dead session, and nothing relaunched the persona
  // (Checks 24-teardown, 25 and 27 then lost their messages). The row's
  // evidence is now the adapter's one one-line `read-pane` of it: GONE sweeps
  // and escalates with no notice, and the run's re-probe relaunches the
  // persona; UNAVAILABLE is taken as alive, so the run defers with the
  // notice and relaunches nothing. Every not-connected notice is recorded.
  describe('b.jdc: a persona whose session died under a prompt', () => {
    /** Every not-connected notice raised, by persona. */
    let raised: string[]

    beforeEach(() => {
      _resetNotConnectedEpisodes()
      raised = []
      setSessionNotifier((key) => { raised.push(key) })
    })

    afterEach(() => {
      setSessionNotifier(undefined)
      _resetNotConnectedEpisodes()
    })

    test.each([...PROMPT_ROW_STATES])('REPRO: alive (%s) but disconnected, its one-line read-pane answering GONE → one read-pane of its own row, one findMissing sweep (verdict prompt-row-tmux-gone), no send-keys and no Waiting on a prompt notice; the re-probe reads the row missing → one kill and one relaunch in that run, no failure counted, nothing armed, no tmux asked', async (state) => {
      const run = d61Run(untilSwept(state), errTmuxCaptureFailed())

      await run.tick()

      expect(run.stubCalls()).toEqual({ statusCalls: 3, readPaneCalls: 1, findMissingCalls: 1 })
      expect(run.paneReads()).toEqual([[personaInstanceId(run.KEY), PROBE_PANE_READ_LINES]])
      expect(escalateLines()).toHaveLength(1)
      expect(escalateLines('prompt-row-tmux-gone')).toHaveLength(1)
      expect(raised).toEqual([])
      expect(run.kills).toEqual([run.KEY])
      expect(run.launches).toEqual([run.KEY])
      // b.jg5 SRJ-611: GONE-based, dead evidence: the relaunch carries it.
      expect(run.carriedIn).toEqual([carriedDeadEvidenceOf('prompt-row-tmux-gone')])
      expect(run.outcomes).toEqual([RESTART_OUTCOME_LAUNCHED])
      expect(getFailureCount(run.KEY)).toBe(0)
      expect(run.armed).toEqual([])
      expect(isRestartPendingOrActive(run.KEY)).toBe(false)
      expect(rawTmux).toEqual([])
    })

    test.each([...PROMPT_ROW_STATES].flatMap((state) => READ_PANE_UNAVAILABLE_FORMS.map(([label, make]) => [state, label, make] as const)))('alive (%s) but disconnected, its one-line read-pane answering UNAVAILABLE (%s) → taken as alive: the run defers with the Waiting on a prompt notice; no sweep, send-keys, kill or launch, nothing counted or reset, nothing armed, no tmux asked', async (state, _label, make) => {
      const run = d61Run(untilSwept(state), make('read-pane'))
      // One failure on record, so a reset or a counted launch would show.
      recordFailure(run.KEY)

      await run.tick()

      expect(run.stubCalls()).toEqual({ statusCalls: 2, readPaneCalls: 1 })
      expect(run.paneReads()).toEqual([[personaInstanceId(run.KEY), PROBE_PANE_READ_LINES]])
      expect(escalateLines()).toEqual([])
      expect(raised).toEqual([run.KEY])
      expect(run.kills).toEqual([])
      expect(run.launches).toEqual([])
      expect(run.outcomes).toEqual([RESTART_OUTCOME_RECONNECT_DEFERRED])
      expect(getFailureCount(run.KEY)).toBe(1)
      expect(run.armed).toEqual([])
      expect(isRestartPendingOrActive(run.KEY)).toBe(false)
      expect(rawTmux).toEqual([])
    })
  })

  // b.jg5 SRJ-314 (AC 37, HO C12): the real liveness adapter over the stub
  // reads a `status` error `unknown` unless it is ErrSpawnNotFound or
  // ErrSystemInstallDisappeared, at the first probe and at b.d61's re-probe
  // alike. `unknown` kills and launches nothing, counts nothing and calls the
  // arm hook once; the two dead errors still relaunch in that run. b.jg5
  // SRJ-610: the slow-recovery observer is told ErrSpawnNotFound (no row) as
  // `noteDead`, ErrSystemInstallDisappeared (which reads no row) as
  // `noteInstallGone`, and an `unknown` reading not at all.
  const STATUS_ERRORS: ReadonlyArray<[string, 'noteDead' | 'noteInstallGone' | undefined, () => Error]> = [
    ['a plain Error', undefined, () => new Error('status blew up')],
    ['ErrCallTimeout', undefined, () => errCallTimeout('status')],
    ['a wrapped UnknownError', undefined, () => errGeneric('status', CSCB_UNKNOWN_ERROR_NAME, 'Error: boom')],
    ['CONFIG (ErrConfigMalformed)', undefined, () => errConfigMalformed()],
    ['ErrTmuxNotAvailable', undefined, () => errTmuxNotAvailable(undefined, 'status')],
    ['ErrSpawnNotFound', 'noteDead', () => errSpawnNotFound()],
    ['ErrSystemInstallDisappeared', 'noteInstallGone', () => errSystemInstallDisappeared('status')],
  ]
  const PROBES: ReadonlyArray<['first probe' | 're-probe']> = [['first probe'], ['re-probe']]
  const STATUS_ERROR_CASES = PROBES.flatMap(([probe]) => STATUS_ERRORS.map(([label, note, build]) => [probe, label, note, build] as const))

  test.each(STATUS_ERROR_CASES)('b.jg5 SRJ-314, SRJ-610: the %s\'s status answers %s → slow-recovery note %p (a kill and a relaunch only after a dead note; unknown arms the hook once, counts nothing and tells the observer nothing)', async (probe, _label, note, build) => {
    const dead = note !== undefined
    // First probe: status fails at once. Re-probe: the row reads `working`
    // (the reconnect adapter's read-pane answers GONE and it sweeps) until
    // the sweep, and status fails after it.
    const run = d61Run((swept) => (probe === 'first probe' || swept ? build() : { state: 'working' }), errTmuxCaptureFailed(), false)
    // One failure on record, so a reset or a counted launch would show.
    recordFailure(run.KEY)

    await run.tick()

    // The first probe, the reconnect adapter's state read and read-pane, and
    // the re-probe (the first-probe case stops, or goes straight to the kill,
    // after one).
    expect(run.stubCalls()).toEqual(probe === 'first probe' ? { statusCalls: 1 } : { statusCalls: 3, readPaneCalls: 1, findMissingCalls: 1 })
    expect(run.kills).toEqual(dead ? [run.KEY] : [])
    expect(run.launches).toEqual(dead ? [run.KEY] : [])
    // A failed launch counts; an unknown run counts nothing and resets nothing.
    expect(getFailureCount(run.KEY)).toBe(dead ? 2 : 1)
    expect(run.armed).toEqual(dead ? [] : [run.KEY])
    expect(run.notes).toEqual(dead ? [[note, run.KEY]] : [])
    expect(isRestartPendingOrActive(run.KEY)).toBe(false)
    expect(rawTmux).toEqual([])
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
// are recording fakes. The reconnect answers 'dead-session' (cause
// `row-not-interactive`) after one `send-keys`, the adapter sweeps and
// answers escalate-dead carrying the `row-not-interactive` verdict, which is
// not dead evidence (b.jg5 SRJ-611), and the re-probe (b.d61) decides: a row
// read `missing` is relaunched in that same run with no kill, the relaunch
// carrying the verdict (b.jg5 SRJ-609, SRJ-611, hatch A2: the refusal never
// by itself leads to a kill); a
// row read `pending` (another process's launch may hold it) is left alone,
// with nothing killed, launched or counted. Before the fix the adapter
// answered 'transient' after a spawn-failure notice, and the persona stayed
// down until a later tick. Each run is awaited (`runRestartRetry`).
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
    _resetFindMissingMemo()
    setSessionNotifier(undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * One restart run for a persona whose row reads `waiting` until its
   * keystrokes are refused (ErrSpawnNotInteractive), and `afterRefusal`
   * from then on (what the sweep that ended it, or another launch, left).
   * One failure is counted for it first, so a recordFailure or a
   * recordSuccess in the run shows. Answers the run's outcome, its calls,
   * the spawn-failure notices raised and its console.error lines.
   */
  async function refusedRun(afterRefusal: string) {
    const config = makeMultiPersonaConfig([{ name: 'alpha_bot' }], dir)
    const KEY = config.personas[0]!.key
    let rowState = 'waiting'
    const sendKeysCalls: SendKeysParams[] = []
    const findMissingCalls: FindMissingParams[] = []
    const stub = makeStubClient({ statusFn: () => cannedStatusResult({ state: rowState }), findMissingCalls })
    stub.sendKeys = async (params) => {
      sendKeysCalls.push(params)
      rowState = afterRefusal // a findMissing sweep, or another launch, landed just before the keystrokes
      throw errSpawnNotInteractive('send-keys')
    }
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
    setClientForTests(stub as unknown as Client)
    const raised: string[] = []
    setSessionNotifier((key) => { raised.push(key) })
    recordFailure(KEY)

    const killSessionCalls: string[] = []
    const launchSessionCalls: string[] = []
    const carriedIn: Array<CarriedDeadEvidence | undefined> = []
    initRestart({
      canRestart: () => true,
      isSessionAlive: _buildIsSessionAliveAdapter(() => config),
      isSessionConnected: () => false,
      hasSessionStream: () => false,
      reconnectSession: _buildReconnectSessionAdapter(),
      async killSession(key) { killSessionCalls.push(key); return KILL_SUCCEEDED },
      async launchSession(key, _cwd, _sessionId, deadEvidence) { launchSessionCalls.push(key); carriedIn.push(deadEvidence); return true },
      getRestartDelay: () => FAST_DELAY_S,
      isShuttingDown: () => false,
      onCapReached: () => {},
    })

    const lines: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    const CWD = config.personas[0]!.working_directory
    let outcome: RestartRetryOutcome
    try {
      outcome = await runRestartRetry(KEY, CWD, () => false)
    } finally {
      console.error = orig
    }
    assertNoLeak({ lines })
    return { KEY, CWD, outcome, sendKeysCalls, findMissingCalls, killSessionCalls, launchSessionCalls, carriedIn, raised, lines }
  }

  test('REPRO: alive (waiting) but disconnected; the keystrokes are refused (ErrSpawnNotInteractive) → one send-keys and one sweep; the re-probe reads the row missing → one relaunch carrying the row-not-interactive verdict and zero kills in that run (b.jg5 SRJ-609, SRJ-611, hatch A2); no spawn-failure notice, no failure counted', async () => {
    const run = await refusedRun('missing')

    expect(run.outcome).toBe(RESTART_OUTCOME_LAUNCHED)
    expect(run.sendKeysCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(run.KEY)])
    expect(run.findMissingCalls).toHaveLength(1)
    expect(run.killSessionCalls).toEqual([])
    expect(run.launchSessionCalls).toEqual([run.KEY])
    // b.jg5 SRJ-611: the relaunch carries the verdict, which the session
    // manager's decision reads as no dead evidence.
    const carried = carriedDeadEvidenceOf('row-not-interactive')
    expect(run.carriedIn).toEqual([carried])
    expect(isDeadEvidence(run.carriedIn[0]?.source)).toBe(false)
    expect(run.lines.filter((l) => l === relaunchWithoutKillLine(run.KEY, carried))).toHaveLength(1)
    // The no-kill line's one literal pin: it names the verdict carried and says it is not dead evidence.
    expect(relaunchWithoutKillLine(run.KEY, carried)).toBe(
      `[slack] No kill before the relaunch for persona=${run.KEY} — its escalate-dead verdict (verdict=row-not-interactive) is not dead evidence, which never by itself leads to a kill; the relaunch's own row read decides (b.jg5 SRJ-609, SRJ-611)`,
    )
    expect(relaunchWithoutKillLine(run.KEY)).toBe(
      `[slack] No kill before the relaunch for persona=${run.KEY} — its escalate-dead verdict (none carried) is not dead evidence, which never by itself leads to a kill; the relaunch's own row read decides (b.jg5 SRJ-609, SRJ-611)`,
    )
    // The relaunch line names no kill, built by the relaunch-line builder's
    // no-kill form (b.jg5 SRJ-611); its text is pinned literally.
    const noKillLine = relaunchAfterKillLine(run.KEY, run.CWD, RELAUNCH_KILL_NONE)
    expect(noKillLine).toBe(`[slack] Relaunching session for persona=${run.KEY} cwd="${run.CWD}" — kill: none (b.jg5 SRJ-611)`)
    expect(run.lines.filter((l) => l === noKillLine)).toHaveLength(1)
    expect(run.lines.filter((l) => l.startsWith(`[slack] Relaunching session for persona=${run.KEY} `))).toEqual([noKillLine])
    expect(run.raised).toEqual([])
    // The relaunch's success is the run's only accounting.
    expect(getFailureCount(run.KEY)).toBe(0)
    expect(isRestartPendingOrActive(run.KEY)).toBe(false)
  })

  test('the keystrokes are refused (ErrSpawnNotInteractive) and the re-probe reads the row pending (another process\'s launch may hold it) → one send-keys and one sweep; no kill, no launch, no recordFailure or recordSuccess, no spawn-failure notice', async () => {
    const run = await refusedRun(AGENT_DIRECTOR_PENDING_STATE)

    expect(run.outcome).toBe(RESTART_OUTCOME_PENDING_DEFERRED)
    expect(run.sendKeysCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(run.KEY)])
    expect(run.findMissingCalls).toHaveLength(1)
    expect(run.killSessionCalls).toEqual([])
    expect(run.launchSessionCalls).toEqual([])
    expect(run.lines.filter((l) => l.startsWith(`[slack] No kill before the relaunch for persona=${run.KEY} `))).toEqual([])
    expect(run.lines.filter((l) => l.startsWith(`[slack] Relaunching session for persona=${run.KEY} `))).toEqual([])
    expect(run.raised).toEqual([])
    expect(getFailureCount(run.KEY)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-611 (and SRJ-1304: the harness binds the restart dependencies as
// `main()` binds them): the relaunch after an escalate-dead answer hands the
// ladder the verdict the reconnect adapter swept with. P's row reads
// `working` until that sweep and `missing` after it, and its `read-pane`
// answers the case's failure. The relaunch's optimistic spawn collides, its
// collision `get` reads the row `missing` and its `resume` answers
// `ErrSpawnNotResumable`, whose re-read (b.jg5 SRJ-710) reads it `missing`
// again, so the ladder's finished-row route logs the verdict carried in
// (`deadSessionRouteLine`) and the not-resumable step's lost race names the
// dead evidence the path holds; the launch is refused and counted nowhere. A
// GONE-based verdict keeps its checked kill; a row-absent one makes none.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-611: on the recovery harness, the relaunch after escalate-dead hands the ladder its verdict', () => {
  let harness: RecoveryHarness | undefined

  afterEach(() => {
    const h = harness
    harness = undefined
    if (h === undefined) return
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
    expect(h.clock.pendingCount()).toBe(0)
  })

  test.each<[string, () => Error, EscalateDeadVerdict, number]>([
    ['GONE (ErrTmuxCaptureFailed): its verdict is dead evidence → one checked kill, then the relaunch', () => errTmuxCaptureFailed(), 'working-tmux-gone', 1],
    ['the row absent (ErrSpawnNotFound): its verdict is a row read → no kill, the relaunch alone', () => errSpawnNotFound(), ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ, 0],
  ])('P\'s working row\'s read-pane answers %s carrying the verdict into the ladder', async (_label, answer, verdict, kills) => {
    const h = (harness = makeRecoveryHarness({ alertThresholdMs: false }))
    const persona = h.config.personas[0]!
    const p = persona.key
    const calls = h.stub.calls
    h.script({
      ...collided(h, persona, { state: LIVENESS_DEAD_ROW_MISSING }),
      statusFn: () => cannedStatusResult({ state: calls.findMissingCalls.length > 0 ? LIVENESS_DEAD_ROW_MISSING : 'working' }),
      readPaneError: answer(),
      resumeError: errSpawnNotResumable(),
    })

    expect(await runRestartRetry(p, persona.working_directory, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)

    const carried = carriedDeadEvidenceOf(verdict)
    const ref = renderPersonaRef(persona.name, p)
    expect(calls.killCalls).toHaveLength(kills)
    expect(calls.resumeCalls).toHaveLength(1)
    expect(h.errors.filter((l) => l.startsWith(`[slack] spawnForPersona: dead session for ${ref} `))).toEqual([
      deadSessionRouteLine(ref, LIVENESS_DEAD_ROW_MISSING, CARRIED_DEAD_EVIDENCE_NONE, carried),
    ])
    const reread: PersonaRowReread = { kind: ROW_REREAD_FINISHED, lastRead: latchRowStateRead(LIVENESS_DEAD_ROW_MISSING) }
    expect(h.errors.filter((l) => l.includes(` on resume for ${ref} — re-read: `))).toEqual([
      spawnNotResumableLine('[slack] spawnForPersona:', ref, describeAgentDirectorFailure(errSpawnNotResumable()), reread, carried, lostRaceOutcome(true)),
    ])
    expect(calls.getCalls).toHaveLength(2)
    expect(calls.deleteCalls).toEqual([])
    await h.settle()
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-611's Test line (homed in T1, observed here), SRJ-710, SRJ-609's
// AC 59 half (E23 T2): the restart path's relaunch after each escalate-dead
// verdict meets ErrSpawnNotResumable on a row its re-read finds live.
//
// On the recovery harness (the real liveness, reconnect and kill adapters
// over one stub, the restart deps bound as `main()` binds them, E21's
// registry installed). Each verdict comes from the reconnect adapter's own
// reads, P disconnected: its row reads the verdict's state until the
// escalate-dead sweep and `missing` after it, so the run's re-probe reads it
// finished. The relaunch's optimistic spawn collides, its collision `get`
// reads the row `ended`, its `resume` answers ErrSpawnNotResumable once and
// its re-read finds the row `waiting`; every later `get` (a sequence's) reads
// it `ended` with a session id. A GONE-based verdict keeps the restart
// path's checked kill, and the relaunch's ladder starts one live-row
// sequence with the conversation kept (alert context `recovery`), which
// ends in one `resume` of the row; nothing is recorded as a failure. A
// verdict that is not dead evidence makes no kill at any point, no sequence
// and no launch over the live row: a lost race, nothing counted, no
// spawn-failure notice, P armed with the lost-race cause (AC 59). A covered
// `pending` re-read starts no sequence and makes no kill after the relaunch,
// whatever the verdict. A second run for P while the sequence runs answers
// `sequence-waiting` with no call.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-611, SRJ-710: the restart path\'s relaunch after each escalate-dead verdict meets ErrSpawnNotResumable on a row re-read live', () => {
  let harness: RecoveryHarness | undefined

  afterEach(() => {
    const h = harness
    harness = undefined
    if (h === undefined) return
    try {
      expect(h.stub.calls.deleteCalls).toEqual([])
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
    expect(h.clock.pendingCount()).toBe(0)
  })

  /** One escalate-dead verdict and the reconnect adapter's reads that give it: P's row state before the sweep and the adapter's failing answer. */
  interface VerdictReach {
    readonly verdict: EscalateDeadVerdict
    readonly state: string
    readonly script: RecoveryStubScript
  }

  /** Every escalate-dead verdict, as the reconnect adapter reaches it. */
  const VERDICT_REACHES: readonly VerdictReach[] = [
    { verdict: 'working-tmux-gone', state: 'working', script: { readPaneError: errTmuxCaptureFailed() } },
    { verdict: ESCALATE_DEAD_WAITING_ROW_PANE_GONE, state: 'waiting', script: { readPaneError: errTmuxCaptureFailed() } },
    { verdict: 'dead-session', state: 'waiting', script: { sendKeysError: errTmuxSendKeys() } },
    { verdict: 'prompt-row-tmux-gone', state: 'check_permission', script: { readPaneError: errTmuxCaptureFailed() } },
    { verdict: 'row-not-interactive', state: 'waiting', script: { sendKeysError: errSpawnNotInteractive('send-keys') } },
    { verdict: ESCALATE_DEAD_ROW_ABSENT_AT_PANE_READ, state: 'working', script: { readPaneError: errSpawnNotFound() } },
  ]

  /** The GONE-based verdicts (b.jg5 SRJ-611), written out by hand rather than asked of the code under test. */
  const GONE_BASED: ReadonlySet<EscalateDeadVerdict> = new Set<EscalateDeadVerdict>(['working-tmux-gone', ESCALATE_DEAD_WAITING_ROW_PANE_GONE, 'dead-session', 'prompt-row-tmux-gone'])

  test('every escalate-dead verdict has a reach here', () => {
    expect(new Set(VERDICT_REACHES.map((reach) => reach.verdict))).toEqual(new Set(ESCALATE_DEAD_VERDICTS))
  })

  /**
   * A harness over P's row as `reach` gives its verdict, with the relaunch's
   * re-read answering `reread`; P's key and working directory.
   */
  function build(reach: VerdictReach, reread: (h: RecoveryHarness, persona: Persona) => Record<string, unknown>) {
    const h = (harness = makeRecoveryHarness({ alertThresholdMs: false }))
    const persona = h.config.personas[0]!
    const calls = h.stub.calls
    h.script({
      spawnQueue: [cannedErr<SpawnResult>(errInstanceIdCollision())],
      getQueue: [
        cannedOk(cannedGetResult({ state: LIVENESS_DEAD_ROW_ENDED }, persona, h.home)),
        cannedOk(cannedGetResult(reread(h, persona), persona, h.home)),
      ],
      getResult: cannedGetResult({ state: LIVENESS_DEAD_ROW_ENDED, claude_session_id: 'a-session-id' }, persona, h.home),
      statusFn: () => cannedStatusResult({ state: calls.findMissingCalls.length > 0 ? LIVENESS_DEAD_ROW_MISSING : reach.state }),
      resumeQueue: [cannedErr(errSpawnNotResumable())],
      ...reach.script,
    })
    return { h, p: persona.key, cwd: persona.working_directory }
  }

  const WAITING = (): Record<string, unknown> => ({ state: 'waiting' })

  test.each(VERDICT_REACHES.map((reach) => [reach.verdict, reach] as const))('verdict %s, the re-read finding the row waiting: a GONE-based verdict\'s checked kill, the relaunch, then one sequence ending in resume; any other verdict: no kill, no sequence, no launch over the live row, P armed with the lost-race cause; never a recordFailure or a spawn-failure notice', async (verdict, reach) => {
    const { h, p, cwd } = build(reach, WAITING)
    const gone = GONE_BASED.has(verdict)

    const outcome = await runRestartRetry(p, cwd, isLaunchInFlight)

    expect(getFailureCount(p)).toBe(0)
    expect(h.notices).toEqual([])
    if (!gone) {
      expect(outcome).toBe(RESTART_OUTCOME_REFUSED)
      expect(h.stub.calls.resumeCalls).toHaveLength(1)
      expect([h.stub.calls.killCalls, isLiveRowSequenceRunning(p)]).toEqual([[], false])
      // The relaunch's optimistic spawn, which collided, is its only spawn.
      expect(h.stub.calls.spawnCalls).toHaveLength(1)
      expect(h.triggers.filter((t) => t.key === p).map((t) => t.kind)).toEqual([UNAVAILABLE_RETRY_CAUSE_LOST_RACE])
      return
    }
    expect(outcome).toBe(RESTART_OUTCOME_SEQUENCE_WAITING)
    expect(h.lines).toContain(liveRowSequenceStartLine(renderPersonaRef(h.config.personas[0]!.name, p), h.sequenceRequest(p, { lastReadState: 'waiting', keepsConversation: true })))
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({
      kind: LIVE_ROW_OUTCOME_LAUNCHED,
      launchKind: LIVE_ROW_LAUNCH_RESUME,
      reason: LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION,
      result: { key: p, action: 'resumed' },
    })
    // The restart path's checked kill before the relaunch, then the sequence's own kill and its resume of the row: never a reuse.
    expect(h.stub.calls.killCalls).toHaveLength(2)
    expect(h.stub.calls.resumeCalls).toEqual([{ claude_instance_id: personaInstanceId(p) }, { claude_instance_id: personaInstanceId(p) }])
    expect(h.stub.calls.spawnCalls).toHaveLength(1)
    expect(getFailureCount(p)).toBe(0)
    await h.settle()
  })

  test.each(VERDICT_REACHES.map((reach) => [reach.verdict, reach] as const))('verdict %s, the re-read finding a covered pending row (a launch in progress): no sequence and no kill after the relaunch; nothing counted or posted', async (verdict, reach) => {
    const { h, p, cwd } = build(reach, () => ({ state: AGENT_DIRECTOR_PENDING_STATE }))

    await runRestartRetry(p, cwd, isLaunchInFlight)

    expect(isLiveRowSequenceRunning(p)).toBe(false)
    // Only a GONE-based verdict's checked kill, before the relaunch.
    expect(h.stub.calls.killCalls).toHaveLength(GONE_BASED.has(verdict) ? 1 : 0)
    expect([getFailureCount(p), h.notices, h.episodeNotices]).toEqual([0, [], []])
    expect(h.triggers.filter((t) => t.key === p && t.kind === UNAVAILABLE_RETRY_CAUSE_LOST_RACE)).toEqual([])
  })

  test('a second run for P while the sequence its relaunch started runs answers sequence-waiting with no agent-director call', async () => {
    const reach = VERDICT_REACHES[0]!
    const { h, p, cwd } = build(reach, WAITING)
    const hold = holdFindMissing(h.stub.client)
    // The held runs are not in the stub's own log: the row reads finished once the escalate-dead sweep was made.
    h.script({ statusFn: () => cannedStatusResult({ state: hold.calls.length > 0 ? LIVENESS_DEAD_ROW_MISSING : reach.state }) })

    const first = runRestartRetry(p, cwd, isLaunchInFlight)
    await hold.entered(1)
    hold.release(cannedFindMissing())
    expect(await first).toBe(RESTART_OUTCOME_SEQUENCE_WAITING)
    // The sequence's first run, held.
    await h.driveSequence(hold.entered(2))
    expect(isLiveRowSequenceRunning(p)).toBe(true)
    const before = personaCallCounts(h, p)

    expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_SEQUENCE_WAITING)

    expect(personaCallCounts(h, p)).toEqual(before)
    hold.release(cannedFindMissing({ rows: { [personaInstanceId(p)]: 'ids' } }))
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, result: { key: p, action: 'resumed' } })
    await h.settle()
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-118, SRJ-609: the reconnect's transient and latching answers in
// the restart run, on the recovery harness (the real adapters over one stub,
// the latch composed as `main()` composes it). P's row reads `waiting` and P
// is disconnected, so the run reaches the reconnect adapter's one
// `send-keys`. An UNAVAILABLE answer is `transient`: no sweep, kill, launch,
// notice or counted failure in the run (its retry timer is E8's case above).
// A CONFLICT answer latches P with one post, and the next run for P makes no
// agent-director call and counts nothing. One failure is counted for P
// first, so a recordFailure or a recordSuccess in the run shows. Each run is
// awaited (`runRestartRetry`).
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-118, SRJ-609: the reconnect\'s transient and latching answers in the restart run', () => {
  let harness: RecoveryHarness | undefined

  afterEach(() => {
    const h = harness
    harness = undefined
    if (h === undefined) return
    assertNoLeak(h.captured())
    h.cleanup()
    expect(h.clock.pendingCount()).toBe(0)
  })

  /** A harness with no alert check; P's row reads `waiting` and its send-keys answers `err`; one failure counted for P. */
  function build(err: Error): { h: RecoveryHarness; p: string; cwd: string } {
    const h = (harness = makeRecoveryHarness({ alertThresholdMs: false }))
    const p = h.keys[0]!
    recordFailure(p)
    h.script({ statusResult: cannedStatusResult({ state: 'waiting' }), sendKeysError: err })
    return { h, p, cwd: h.config.personas[0]!.working_directory }
  }

  /** P's run made exactly one send-keys and nothing after it: no sweep, kill or launch; nothing counted or posted as a spawn failure. */
  function expectOneSendKeysAndNothingAfter(h: RecoveryHarness, p: string): void {
    expect(h.stub.calls.sendKeysCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(p)])
    expect(h.stub.calls.findMissingCalls).toEqual([])
    expect(h.stub.calls.killCalls).toEqual([])
    expect(h.stub.spawnedIds()).toEqual([])
    expect(h.stub.calls.resumeCalls).toEqual([])
    expect(getFailureCount(p)).toBe(1)
    expect(h.capReached).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
  }

  const SEND_KEYS_UNAVAILABLE = UNAVAILABLE_FORMS.filter(([, , cause]) => cause !== UNAVAILABLE_RETRY_CAUSE_KILL_FAILED)

  test.each(SEND_KEYS_UNAVAILABLE)('the reconnect\'s send-keys answers %s → the run defers: one send-keys, then no sweep, kill, launch, notice or counted failure', async (_label, make) => {
    const { h, p, cwd } = build(make('send-keys'))

    expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_RECONNECT_DEFERRED)

    expectOneSendKeysAndNothingAfter(h, p)
    expect(h.latch.isLatched(p)).toBe(false)
    expect(h.episodeNotices).toEqual([])
  })

  test('the reconnect\'s send-keys answers CONFLICT → P latched with one post; the next scheduled run and the retry entry for P make no agent-director call and count nothing', async () => {
    const row = reconnectConflictRowsAt('waiting')[0]!
    const { h, p, cwd } = build(row.build())

    expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_RECONNECT_DEFERRED)

    expectOneSendKeysAndNothingAfter(h, p)
    expect(h.latch.isLatched(p)).toBe(true)
    expect(h.latch.record(p)?.latchCase).toBe(row.latchCase)
    expect(h.episodeNotices).toEqual([{ key: p, text: row.notice.text }])

    const calls = h.stub.callCount()
    scheduleRestart(p, cwd)
    expect(isRestartPendingOrActive(p)).toBe(false)
    expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_LATCHED)
    expect(h.stub.callCount()).toBe(calls)
    expect(getFailureCount(p)).toBe(1)
    expect(h.episodeNotices).toHaveLength(1)
    expect(h.notices).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.d61: the liveness re-probe after an 'escalate-dead' reconnect. The
// reconnect adapter has already run the findMissing sweep when it answers
// 'escalate-dead', so the restart run probes liveness once more: only a row
// that now reads `dead` goes on to the kill and relaunch in the same run, with
// the launch's usual accounting. A row that still reads `live` (b.jg5 SRJ-610:
// it may stay live for further ticks, each sweeping again), or reads
// `pending`, gets no relaunch in this run; a re-probe that reads `unknown`,
// throws, or answers a kind no reading names (b.jg5 SRJ-314: never read as
// dead; the probe reads such a kind as `unknown`, so the switch's
// unhandled-kind default is never reached and its line never logged)
// relaunches nothing, counts nothing and calls the arm hook. Shutdown and the not-up gate are asked again
// after the re-probe, since it is an async agent-director call. Each run tells
// a recording slow-recovery observer what it read (b.jg5 SRJ-610). The deps
// are `makeDeps` fakes: the first probe reads `live` and the reconnect answers
// escalate-dead carrying b.d61's GONE-based verdict (`working-tmux-gone`)
// unless a case gives another answer. b.jg5 SRJ-611: the relaunch carries
// the verdict the answer carried into the ladder, and only a GONE-based
// verdict, dead evidence, is preceded by the checked kill; after any other
// verdict, or a bare 'escalate-dead' that carries none, a `dead` re-probe
// leads to the relaunch alone. Each case awaits its run's end (`awaitRuns`).
// The re-probe lines are the exported builders'.
// ---------------------------------------------------------------------------

describe('b.d61: after an escalate-dead reconnect, the restart run probes liveness again', () => {
  const KEY = 'reprobe_bot'
  const CWD = '/cwd/reprobe'
  const RELAUNCH = reprobeDeadLine(KEY)
  const STILL_LIVE = reprobeLiveLine(KEY)
  const PENDING = reprobePendingLine(KEY)
  const UNKNOWN = reprobeUnknownLine(KEY)
  /** The unknown line of a re-probe that threw, up to where what it threw begins. */
  const THROWN_MARK = '\u0001'
  const UNKNOWN_THROWN_HEAD = reprobeUnknownLine(KEY, THROWN_MARK).split(THROWN_MARK)[0]!
  /** The unhandled-kind line, up to where the kind begins. */
  const UNHANDLED_HEAD = reprobeUnhandledLine(KEY, THROWN_MARK).split(THROWN_MARK)[0]!
  /** Every raw console.error argument list, so a leak in an error object shows. */
  let errArgs: unknown[][]
  let origConsoleError: typeof console.error

  const lines = () => errArgs.map((args) => args.map(String).join(' '))
  const linesStarting = (prefix: string) => lines().filter((l) => l.startsWith(prefix) && l.includes(`persona=${KEY}`))
  /** The re-probe's lines for KEY: any builder's line, an unknown line naming what the re-probe threw, or an unhandled-kind line. */
  const reprobeLines = () =>
    lines().filter((l) => [RELAUNCH, STILL_LIVE, PENDING, UNKNOWN].includes(l) || l.startsWith(UNKNOWN_THROWN_HEAD) || l.startsWith(UNHANDLED_HEAD))

  /**
   * makeDeps whose first liveness probe reads `live`, whose reconnect answers
   * `answer` (default: escalate-dead carrying the GONE-based
   * `working-tmux-gone`), and whose re-probe runs `reprobe`.
   */
  function makeEscalateDeps(
    reprobe: () => Promise<LivenessReading>,
    opts: DepsOpts = {},
    answer: ReconnectSessionResult = ESCALATE_DEAD_WORKING_GONE,
  ): ReturnType<typeof makeDeps> {
    const deps = makeDeps(opts)
    deps.isSessionAlive = async (key) => {
      deps.isSessionAliveCalls.push(key)
      return deps.isSessionAliveCalls.length === 1 ? LIVENESS_READING_LIVE : reprobe()
    }
    deps.reconnectSession = async (key) => {
      deps.reconnectSessionCalls.push(key)
      return answer
    }
    return deps
  }

  /**
   * `DepsOpts` whose kill and failing launch append `['kill', key]` and
   * `['launch', key]` to `timeline`, where a recording observer's notes go
   * too, so the order of the notes and the instance calls shows.
   */
  const timelineOpts = (timeline: unknown[]): DepsOpts => ({
    killSession: async (key) => { timeline.push(['kill', key]); return KILL_SUCCEEDED },
    launchSession: async (key) => { timeline.push(['launch', key]); return false },
  })

  beforeEach(() => {
    errArgs = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args) }
  })

  afterEach(() => {
    console.error = origConsoleError
    cancelAllRestartTimers()
  })

  test.each<[string, () => Promise<LivenessReading>, boolean, string, string, SlowRecoveryNote[]]>([
    ['reads dead (a row read) → noteDead, then the same run kills and relaunches once', async () => LIVENESS_READING_DEAD, true, RELAUNCH, '', [['noteDead', KEY]]],
    [
      'reads dead from ErrSystemInstallDisappeared, which reads no row → noteInstallGone (never noteDead), then the same run kills and relaunches once',
      async () => LIVENESS_READING_DEAD_INSTALL_GONE,
      true,
      RELAUNCH,
      '',
      [['noteInstallGone', KEY]],
    ],
    [
      'throws → b.jg5 SRJ-314: read unknown, never dead: nothing is killed or launched, nothing counted, the arm hook is called once, the observer is told nothing; the failure is logged as its redacted description',
      async () => {
        throw Object.assign(new Error(`status refused (${sentinelInMessage('reprobe')})`), { code: 'EIO', note: LEAK_SENTINEL })
      },
      false,
      `${UNKNOWN_THROWN_HEAD}Error code=EIO message="status refused (${REDACTED_SENTINEL_TAIL})" at `,
      KEY,
      [],
    ],
    ['reads unknown → b.jg5 SRJ-314: nothing is killed or launched, nothing counted, the arm hook is called once, the observer is told nothing', async () => LIVENESS_READING_UNKNOWN, false, UNKNOWN, KEY, []],
    [
      'answers a reading of a kind no reading names (cast) → read unknown, never the unhandled-kind line: nothing is killed or launched, nothing counted, the arm hook is called once, the observer is told nothing',
      async () => ({ kind: 'zombie' }) as unknown as LivenessReading,
      false,
      UNKNOWN,
      KEY,
      [],
    ],
    [
      'reads pending → its session has not started: nothing is killed or launched, nothing counted, nothing armed; noteOther with the pending re-probe reason, never noteLive',
      async () => LIVENESS_READING_PENDING,
      false,
      PENDING,
      '',
      [['noteOther', KEY, RESTART_SLOW_RECOVERY_OTHER_PENDING_REPROBE]],
    ],
    [
      'still reads live → b.jg5 SRJ-610: noteLive; nothing is killed or launched, nothing counted or armed; the row may stay live for further ticks',
      async () => LIVENESS_READING_LIVE,
      false,
      STILL_LIVE,
      '',
      [['noteLive', KEY]],
    ],
  ])('the re-probe %s', async (_label, reprobe, relaunched, line, armedKey, notes) => {
    // One failure on record and a failed launch, so the count shows whether the
    // launch was attempted, and a reset would show too (the escalate-dead
    // verdict itself never counts: single counting site).
    recordFailure(KEY)
    const timeline: unknown[] = []
    const deps = makeEscalateDeps(reprobe, timelineOpts(timeline))
    deps.slowRecovery = recordingSlowRecovery(timeline)
    const run = awaitRuns(deps)
    initRestart(deps)

    await run.tick(KEY, CWD)

    expect(deps.isSessionAliveCalls).toEqual([KEY, KEY])
    expect(deps.reconnectSessionCalls).toEqual([KEY])
    expect(deps.killSessionCalls).toEqual(relaunched ? [KEY] : [])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual(relaunched ? [KEY] : [])
    // b.jg5 SRJ-611: the relaunch carries the GONE-based verdict the answer carried.
    expect(deps.launchSessionCalls.map((c) => c.deadEvidence)).toEqual(relaunched ? [ESCALATE_DEAD_WORKING_GONE.deadEvidence] : [])
    // The re-probe's note, told before the same run's kill and relaunch.
    expect(timeline).toEqual([...notes, ...(relaunched ? [['kill', KEY], ['launch', KEY]] : [])])
    expect(getFailureCount(KEY)).toBe(relaunched ? 2 : 1)
    expect(deps.armRetryTimerCalls).toEqual(armedKey === '' ? [] : [armedKey])
    // restart.ts re-arms nothing either way: the health-check tick is the retry driver.
    expect(isRestartPendingOrActive(KEY)).toBe(false)
    // Exactly one of the re-probe's lines, and it is this case's.
    const reprobed = reprobeLines()
    expect(reprobed).toHaveLength(1)
    expect(reprobed[0]).toStartWith(line)
    assertNoLeak({ errArgs })
  })

  test.each<[string, 'shutdown' | 'not-up', string, number]>([
    ['the server starts shutting down', 'shutdown', `[slack] Skipping restart — server is shutting down (persona=${KEY})`, 3],
    ['the persona stops being up', 'not-up', `[slack] Skipping restart for persona=${KEY} — the persona is no longer up; its instance is left as it is`, 4],
  ])('%s while the re-probe is pending: though the row now reads dead, nothing is killed or launched; the count is unchanged; the skip is logged once; the observer is told nothing', async (_label, flip, skipLine, gateAsks) => {
    // One failure on record, so a reset or a counted launch would show.
    recordFailure(KEY)
    let shuttingDown = false
    let up = true
    const asked: string[] = []
    const notes: SlowRecoveryNote[] = []
    const deps = makeEscalateDeps(async () => {
      if (flip === 'shutdown') shuttingDown = true
      else up = false
      return LIVENESS_READING_DEAD
    }, { launchSessionResult: false })
    deps.isShuttingDown = () => shuttingDown
    deps.canRestart = (key) => { asked.push(key); return up }
    deps.slowRecovery = recordingSlowRecovery(notes)
    const run = awaitRuns(deps)
    initRestart(deps)

    await run.tick(KEY, CWD)

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
    // b.jg5 SRJ-610: a run its gates stop after the re-probe tells nothing.
    expect(notes).toEqual([])
  })

  // b.jg5 SRJ-611, SRJ-609 (hatch A2): every verdict the reconnect adapter
  // can answer escalate-dead with (each `EscalateDeadVerdict`, and the prompt
  // row's 10-minute sweep's `row-read-finished`), and the bare
  // 'escalate-dead' that carries none, then a `dead` re-probe: exactly one
  // relaunch, which receives the verdict unchanged (none for the bare
  // answer). Only a GONE-based verdict gets the checked kill first; any
  // other gets no kill and the no-kill line naming it.
  const GONE_BASED_VERDICTS: ReadonlySet<DeadEvidenceSource> = new Set<EscalateDeadVerdict>(['dead-session', 'working-tmux-gone', ESCALATE_DEAD_WAITING_ROW_PANE_GONE, 'prompt-row-tmux-gone'])
  const ADAPTER_VERDICTS: readonly DeadEvidenceSource[] = [...ESCALATE_DEAD_VERDICTS, DEAD_SESSION_CAUSE_ROW_READ_FINISHED]
  const CARRIED_VERDICTS: ReadonlyArray<readonly [string, ReconnectSessionResult, CarriedDeadEvidence | undefined, boolean]> = [
    ...ADAPTER_VERDICTS.map((verdict) => [`the verdict ${verdict}`, escalateDeadWith(verdict), carriedDeadEvidenceOf(verdict), GONE_BASED_VERDICTS.has(verdict)] as const),
    ['no verdict (a bare escalate-dead)', 'escalate-dead', undefined, false],
  ]

  test.each(CARRIED_VERDICTS)('b.jg5 SRJ-611: escalate-dead carrying %s, then a dead re-probe → exactly one relaunch, which receives that verdict; the checked kill before it only for a GONE-based verdict (dead evidence)', async (_label, answer, carried, killed) => {
    const timeline: unknown[] = []
    const deps = makeEscalateDeps(async () => LIVENESS_READING_DEAD_MISSING, timelineOpts(timeline), answer)
    const run = awaitRuns(deps)
    initRestart(deps)

    await run.tick(KEY, CWD)

    expect(deps.isSessionAliveCalls).toEqual([KEY, KEY])
    expect(timeline).toEqual([...(killed ? [['kill', KEY]] : []), ['launch', KEY]])
    expect(deps.launchSessionCalls).toEqual([{ key: KEY, cwd: CWD, sessionId: undefined, ...(carried === undefined ? {} : { deadEvidence: carried }) }])
    // The session manager's decision reads the carried verdict as the run did.
    expect(carried !== undefined && isDeadEvidence(carried.source)).toBe(killed)
    expect(lines().filter((l) => l === relaunchWithoutKillLine(KEY, carried))).toHaveLength(killed ? 0 : 1)
    expect(lines().filter((l) => l.startsWith(`[slack] Relaunching session for persona=${KEY} `))).toEqual([
      relaunchAfterKillLine(KEY, CWD, killed ? KILL_SUCCEEDED : RELAUNCH_KILL_NONE),
    ])
    assertNoLeak({ errArgs })
  })

  // b.jg5 SRJ-610 (no kill outside the live-row sequence): after any
  // escalate-dead answer, a re-probe that does not read `dead` kills and
  // relaunches nothing.
  test.each(CARRIED_VERDICTS.flatMap(([label, answer]) => ([
    ['live', LIVENESS_READING_LIVE],
    ['pending', LIVENESS_READING_PENDING],
    ['unknown', LIVENESS_READING_UNKNOWN],
  ] as const).map(([reads, reading]) => [label, reads, answer, reading] as const)))('b.jg5 SRJ-611: escalate-dead carrying %s, then a re-probe reading %s → no kill and no relaunch', async (_label, _reads, answer, reading) => {
    const deps = makeEscalateDeps(async () => reading, {}, answer)
    const run = awaitRuns(deps)
    initRestart(deps)

    await run.tick(KEY, CWD)

    expect(deps.isSessionAliveCalls).toEqual([KEY, KEY])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
  })

  // b.jg5 SRJ-610: the slow-recovery observer (`RestartDeps.slowRecovery`)
  // beyond the re-probe: a dead first probe, a reconnect ending with another
  // verdict, a pending first probe and a session already connected, the runs
  // that tell nothing, a note that throws, and a run with no observer.
  describe('b.jg5 SRJ-610: what each restart run tells the slow-recovery observer', () => {
    test.each<[string, LivenessReading, SlowRecoveryNote]>([
      ['a row read (ended, missing or no row) → noteDead', LIVENESS_READING_DEAD, ['noteDead', KEY]],
      ['ErrSystemInstallDisappeared, which reads no row → noteInstallGone, never noteDead', LIVENESS_READING_DEAD_INSTALL_GONE, ['noteInstallGone', KEY]],
    ])('a first liveness probe reading dead from %s, told before the kill and the relaunch; no reconnect', async (_label, reading, note) => {
      const timeline: unknown[] = []
      const deps = makeDeps({ isSessionAliveResult: reading, ...timelineOpts(timeline) })
      deps.slowRecovery = recordingSlowRecovery(timeline)
      const run = awaitRuns(deps)
      initRestart(deps)

      await run.tick(KEY, CWD)

      expect(deps.isSessionAliveCalls).toEqual([KEY])
      expect(deps.reconnectSessionCalls).toEqual([])
      expect(timeline).toEqual([note, ['kill', KEY], ['launch', KEY]])
      // b.jg5 SRJ-611: no escalate-dead answer, so the relaunch carries no verdict.
      expect(deps.launchSessionCalls).toEqual([{ key: KEY, cwd: CWD, sessionId: undefined }])
      expect(run.outcomes).toEqual([RESTART_OUTCOME_COUNTED_FAILURE])
    })

    test.each<[string, (key: string) => Promise<ReconnectSessionResult>, RestartWorkOutcome]>([
      ['success', async () => 'success', RESTART_OUTCOME_RECONNECTED],
      ['transient', async () => 'transient', RESTART_OUTCOME_RECONNECT_DEFERRED],
      ['pending (its own read found the row pending)', async () => 'pending', RESTART_OUTCOME_PENDING_DEFERRED],
      ['nothing', async () => undefined, RESTART_OUTCOME_RECONNECT_DEFERRED],
      ['by throwing', async () => { throw new Error('reconnect broke') }, RESTART_OUTCOME_RECONNECT_DEFERRED],
    ])('a first probe reading live and a reconnect answering %s → one noteOther with the other-verdict reason; no re-probe, kill or launch', async (_label, reconnect, outcome) => {
      const notes: SlowRecoveryNote[] = []
      const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
      deps.reconnectSession = reconnect
      deps.slowRecovery = recordingSlowRecovery(notes)
      const run = awaitRuns(deps)
      initRestart(deps)

      await run.tick(KEY, CWD)

      expect(notes).toEqual([['noteOther', KEY, RESTART_SLOW_RECOVERY_OTHER_VERDICT]])
      expect(deps.isSessionAliveCalls).toEqual([KEY])
      expect(deps.killSessionCalls).toEqual([])
      expect(deps.launchSessionCalls).toEqual([])
      expect(run.outcomes).toEqual([outcome])
      assertNoLeak({ errArgs })
    })

    /** Changes the escalate-dead deps (whose re-probe reads dead) so the run stops before its reconnect. */
    type StopBeforeTelling = (deps: ReturnType<typeof makeDeps>) => void
    test.each<[string, StopBeforeTelling, RestartWorkOutcome, SlowRecoveryOtherReason]>([
      ['the first probe reads pending', (deps) => { deps.isSessionAlive = async () => LIVENESS_READING_PENDING }, RESTART_OUTCOME_PENDING_DEFERRED, RESTART_SLOW_RECOVERY_OTHER_PENDING_PROBE],
      ['the session is already connected with its stream', (deps) => { deps.isSessionConnected = () => true }, RESTART_OUTCOME_ALREADY_CONNECTED, RESTART_SLOW_RECOVERY_OTHER_VERDICT],
    ])('%s → one noteOther with reason %p; no reconnect, kill or launch', async (_label, stop, outcome, reason) => {
      const notes: SlowRecoveryNote[] = []
      const deps = makeEscalateDeps(async () => LIVENESS_READING_DEAD)
      stop(deps)
      deps.slowRecovery = recordingSlowRecovery(notes)
      const run = awaitRuns(deps)
      initRestart(deps)

      await run.tick(KEY, CWD)

      expect(run.outcomes).toEqual([outcome])
      expect(notes).toEqual([['noteOther', KEY, reason]])
      expect(deps.reconnectSessionCalls).toEqual([])
      expect(deps.killSessionCalls).toEqual([])
      expect(deps.launchSessionCalls).toEqual([])
    })

    test.each<[string, StopBeforeTelling, RestartWorkOutcome]>([
      ['the first probe reads unknown', (deps) => { deps.isSessionAlive = async () => LIVENESS_READING_UNKNOWN }, RESTART_OUTCOME_LIVENESS_UNKNOWN],
      ['the first probe throws', (deps) => { deps.isSessionAlive = async () => { throw new Error('status broke') } }, RESTART_OUTCOME_LIVENESS_UNKNOWN],
      [
        'the persona stops being up during a first probe that reads dead',
        (deps) => {
          let up = true
          deps.canRestart = () => up
          deps.isSessionAlive = async () => { up = false; return LIVENESS_READING_DEAD }
        },
        RESTART_OUTCOME_NOT_UP,
      ],
      [
        'the escalate-dead reconnect\'s sweep latches the persona',
        (deps) => {
          let latched = false
          deps.isLatched = () => latched
          deps.reconnectSession = async () => { latched = true; return ESCALATE_DEAD_WORKING_GONE }
        },
        RESTART_OUTCOME_LATCHED,
      ],
      [
        'the persona latches during a re-probe that reads dead',
        (deps) => {
          let latched = false
          deps.isLatched = () => latched
          const probe = deps.isSessionAlive
          deps.isSessionAlive = async (key) => {
            const reading = await probe(key)
            if (deps.isSessionAliveCalls.length === 2) latched = true
            return reading
          }
        },
        RESTART_OUTCOME_LATCHED,
      ],
    ])('%s → the observer is told nothing; nothing is killed or launched', async (_label, stop, outcome) => {
      const notes: SlowRecoveryNote[] = []
      const deps = makeEscalateDeps(async () => LIVENESS_READING_DEAD)
      stop(deps)
      deps.slowRecovery = recordingSlowRecovery(notes)
      const run = awaitRuns(deps)
      initRestart(deps)

      await run.tick(KEY, CWD)

      expect(run.outcomes).toEqual([outcome])
      expect(notes).toEqual([])
      expect(deps.killSessionCalls).toEqual([])
      expect(deps.launchSessionCalls).toEqual([])
    })

    test.each<[keyof RestartSlowRecoveryObserver, LivenessReading, boolean, RestartWorkOutcome]>([
      ['noteLive', LIVENESS_READING_LIVE, false, RESTART_OUTCOME_RECONNECT_DEFERRED],
      ['noteDead', LIVENESS_READING_DEAD, true, RESTART_OUTCOME_LAUNCHED],
    ])('a %s that throws is logged once as its redacted description and changes nothing else: the run goes on as without the observer', async (note, reading, relaunched, outcome) => {
      const broke = (): never => {
        throw Object.assign(new Error(`note broke (${sentinelInMessage('note')})`), { note: LEAK_SENTINEL })
      }
      const deps = makeEscalateDeps(async () => reading)
      deps.slowRecovery = { noteLive: broke, noteDead: broke, noteInstallGone: broke, noteOther: broke }
      const run = awaitRuns(deps)
      initRestart(deps)

      await run.tick(KEY, CWD)

      const failed = lines().filter((l) => l.startsWith('[slack] restart: the slow-recovery '))
      expect(failed).toHaveLength(1)
      expect(failed[0]).toStartWith(`[slack] restart: the slow-recovery ${note} failed for persona=${KEY}: Error message="note broke (${REDACTED_SENTINEL_TAIL})" at `)
      expect(run.outcomes).toEqual([outcome])
      expect(deps.killSessionCalls).toEqual(relaunched ? [KEY] : [])
      expect(deps.launchSessionCalls.map((c) => c.key)).toEqual(relaunched ? [KEY] : [])
      expect(getFailureCount(KEY)).toBe(0)
      assertNoLeak({ errArgs })
    })

    test.each<[string, LivenessReading]>([
      ['live', LIVENESS_READING_LIVE],
      ['pending', LIVENESS_READING_PENDING],
      ['dead (a row read)', LIVENESS_READING_DEAD],
      ['dead (ErrSystemInstallDisappeared)', LIVENESS_READING_DEAD_INSTALL_GONE],
    ])('with no observer, a run whose re-probe reads %s makes the same calls, logs the same lines and answers the same outcome as with one', async (_label, reading) => {
      /** One run from a clean restart and backoff state, with or without a recording observer. */
      const runOnce = async (withObserver: boolean) => {
        _resetRestartState()
        _resetBackoffState()
        errArgs = []
        const notes: SlowRecoveryNote[] = []
        const deps = makeEscalateDeps(async () => reading)
        if (withObserver) deps.slowRecovery = recordingSlowRecovery(notes)
        const run = awaitRuns(deps)
        initRestart(deps)
        await run.tick(KEY, CWD)
        const { isSessionAliveCalls, reconnectSessionCalls, killSessionCalls, launchSessionCalls, onCapReachedCalls, armRetryTimerCalls } = deps
        const recorded = { isSessionAliveCalls, reconnectSessionCalls, killSessionCalls, launchSessionCalls, onCapReachedCalls, armRetryTimerCalls }
        return { notes, run: { recorded, outcomes: run.outcomes, failures: getFailureCount(KEY), lines: lines() } }
      }

      const withOne = await runOnce(true)
      const withNone = await runOnce(false)

      // The observer was told the reading, so the run is one that tells it something.
      expect(withOne.notes).toHaveLength(1)
      expect(withNone.run).toEqual(withOne.run)
    })
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
// `waiting`, so the dialog approver a launch starts after it returns (b.jg5
// SRJ-401) stops at its first lap; a case awaits that stop
// (`_whenDialogApproverStopped`) before it asserts on what followed the
// launch, and afterEach stops any still running. No launch path runs tmux,
// the `config_dir` label derives from a temp home, and every persona path
// lies under a temp directory removed in afterEach.
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
  let launchResults: Array<{ key: string; ok: LaunchSessionResult }>
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
    _setDialogReadyTimeoutMs(200)
  })

  afterEach(async () => {
    // Let any launch a failed assertion left held settle before tearing down.
    hold.releaseAll()
    await Bun.sleep(WAIT_MS)
    await stopApproversAndForgetLaunches()
    console.error = origConsoleError
    cancelAllRestartTimers()
    resetClientForTests()
    _resetOutageState()
    setSessionNotifier(undefined)
    _resetSpawnHomeDir()
    _resetDialogReadyTimeoutMs()
    rmSync(dir, { recursive: true, force: true })
  })

  test('kill adapter: no kill for a persona whose launch is in flight (skip logged); another persona is killed meanwhile; kills once the launch settles', async () => {
    holdIds.add(personaInstanceId(a.key))
    const launch = launchPersonaSession(a.key, config)
    await hold.entered(personaInstanceId(a.key))
    expect(isLaunchInFlight(a.key)).toBe(true)
    const killSession = _buildKillSessionAdapter()

    await killSession(a.key, LIVENESS_READING_DEAD_ENDED)
    expect(killCalls).toEqual([])
    expect(errLines).toContain(skipLine(a))

    await killSession(b.key, LIVENESS_READING_DEAD_ENDED)
    expect(killCalls.map((k) => k.claude_instance_id)).toEqual([personaInstanceId(b.key)])
    expect(errLines).not.toContain(skipLine(b))

    hold.release(personaInstanceId(a.key))
    expect(await launch).toBe(true)
    expect(isLaunchInFlight(a.key)).toBe(false)
    await _whenDialogApproverStopped(a.key)
    await killSession(a.key, LIVENESS_READING_DEAD_ENDED)
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
    await _whenDialogApproverStopped(a.key)
    expect(spawnsFor(a)).toHaveLength(1)
    expect(getFailureCount(a.key)).toBe(0)
    expect(isRestartPendingOrActive(a.key)).toBe(false)

    // The launch has settled: a further restart for A kills and starts a new ladder.
    holdIds.clear()
    scheduleRestart(a.key, a.working_directory)
    await Bun.sleep(WAIT_MS)
    await _whenDialogApproverStopped(a.key)
    expect(killsFor(a)).toBe(2)
    expect(spawnsFor(a)).toHaveLength(2)
    expect(launchResults).toHaveLength(3)
    expect(launchResults[2]).toEqual({ key: a.key, ok: true })
    expect(hold.calls.every((c) => c.claude_instance_id === personaInstanceId(a.key))).toBe(true)
    expect(errLines.filter((l) => l === skipLine(a))).toHaveLength(1)
  })

  test('same persona: a joined launch that fails with a LAUNCH FAILURE counts one failure per launchSession boolean restart receives (single counting site); nothing is killed and no spawn is made in its place', async () => {
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

    // The one held spawn fails with a LAUNCH FAILURE (ErrTmuxSessionCreate,
    // b.jg5 SRJ-602): the one shared ladder answers `failed` with no kill and
    // no spawn in its place, so each launchSession call hands restart
    // `false`, and each is counted.
    const launchFailure = errTmuxSessionCreate('spawn')
    hold.fail(personaInstanceId(a.key), launchFailure)
    await Bun.sleep(WAIT_MS)
    expect(launchResults).toEqual([{ key: a.key, ok: false }, { key: a.key, ok: false }])
    expect(getFailureCount(a.key)).toBe(2)
    // One ladder ran: its one spawn, one spawn-failure notice for A, and no
    // kill after the restart run's own.
    expect(spawnsFor(a)).toHaveLength(1)
    expect(killsFor(a)).toBe(1)
    expect(hold.held()).toEqual([])
    expect(notices.map((n) => n.key)).toEqual([a.key])
    expect(notices[0]!.text).toContain(launchFailure.errName)
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
    await _whenDialogApproverStopped(b.key)
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
    await _whenDialogApproverStopped(a.key)
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
    _setDialogReadyTimeoutMs(200)
  })

  afterEach(async () => {
    await stopApproversAndForgetLaunches()
    console.error = origConsoleError
    cancelAllRestartTimers()
    resetClientForTests()
    _resetOutageState()
    setSessionNotifier(undefined)
    _resetSpawnHomeDir()
    _resetDialogReadyTimeoutMs()
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
    const results: LaunchSessionResult[] = []
    const deps = makeDeps({
      isSessionAliveResult: LIVENESS_READING_DEAD,
      launchSession: async (key) => {
        const ok = await launchPersonaSession(key, config)
        results.push(ok)
        return ok
      },
    })
    initRestart(deps)

    scheduleRestart(a.key, a.working_directory)
    await waitFor(() => results.length > 0)
    await _whenDialogApproverStopped(a.key)

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
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
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
  test('claude_config_dir and stop_hook_bootstrap changed between two restarts: the first relaunch uses the old values; the second gives the old-label row a reuse spawn of the same id with the new CLAUDE_CONFIG_DIR (not created yet), deletes nothing and writes the new record', async () => {
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
    const results: LaunchSessionResult[] = []
    initRestart(makeDeps({
      launchSession: async (key) => {
        const ok = await launchPersonaSession(key, applied)
        results.push(ok)
        return ok
      },
    }))

    scheduleRestart(a.key, a.working_directory)
    await waitFor(() => results.length === 1)
    await _whenDialogApproverStopped(a.key)
    expect(results).toEqual([true])
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]!.extra_env?.['CLAUDE_CONFIG_DIR']).toBe(configDir)
    expect(spawnCalls[0]!.label).toContain(`config_dir=${oldRow.labels['config_dir']}`)
    expect(rg.readRecord(a.key)).toBe('true')

    // Step 1 of a confirmed apply: the applied set now holds the new values.
    applied = configFor(newDir, false)
    scheduleRestart(a.key, a.working_directory)
    await waitFor(() => results.length === 2)
    await _whenDialogApproverStopped(a.key)

    expect(results).toEqual([true, true])
    expect(resumeCalls).toEqual([])
    // b.jg5 SRJ-707, SRJ-1504: the finished old-label row is replaced by a reuse spawn of the same id; nothing is deleted.
    expect(deleteCalls).toEqual([])
    expect(spawnCalls).toHaveLength(3)
    expect((spawnCalls as Phase1SpawnParams[]).map((call) => [call.claude_instance_id, call.reuse_finished])).toEqual([
      [personaInstanceId(a.key), undefined],
      [personaInstanceId(a.key), undefined],
      [personaInstanceId(a.key), true],
    ])
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
    _setDialogReadyTimeoutMs(200)
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
    await stopApproversAndForgetLaunches()
    resetClientForTests()
    _resetOutageState()
    setSessionNotifier(undefined)
    _resetSpawnHomeDir()
    _resetDialogReadyTimeoutMs()
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
    await _whenDialogApproverStopped(b.key)

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
    await _whenDialogApproverStopped(a.key)

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

    await kill(a.key, LIVENESS_READING_DEAD_ENDED)

    expect(Object.values(calls).flat()).toEqual([])
    expect(adapterLines()).toEqual([
      `[slack] killSession (restart adapter): persona=${a.key} claude_config_dir cannot be resolved to a real path — not killing; its row is kept`,
    ])
    assertNoLeak({ errArgs, held })
  })

  // A plain `Error` is no agent-director error, so it classifies UNAVAILABLE
  // (b.jg5 SRJ-105); a base AgentDirectorError of a name CSCB gives no
  // handling is UNCLASSIFIED (b.jg5 SRJ-313); each answers its non-success
  // outcome with the adapter's one outcome line, its message redacted. A GONE
  // name (by name) is the session-gone success (b.jg5 SRJ-104: for `kill`,
  // gone is success): its line names the outcome and the GONE name only, so
  // the description's token never reaches it.
  test.each<[string, () => Error, (key: string) => string, object]>([
    [
      'a plain error with a safe code (UNAVAILABLE, b.jg5 SRJ-105) — one outcome line; the adapter answers the non-success',
      () => Object.assign(new Error(`kill refused (${sentinelInMessage('kill')})`), { code: 'ECONNRESET', detail: LEAK_SENTINEL }),
      (key) =>
        `[slack] killSession (restart adapter): kill for persona=${key}: outcome=${KILL_OUTCOME_NOT_KILLED} class=${AD_ERROR_CLASS_UNAVAILABLE} Error code=ECONNRESET message="kill refused (${REDACTED_SENTINEL_TAIL})"`,
      { kind: KILL_OUTCOME_NOT_KILLED, errorClass: AD_ERROR_CLASS_UNAVAILABLE },
    ],
    [
      'a base AgentDirectorError of a name CSCB gives no handling (UNCLASSIFIED, b.jg5 SRJ-313) whose description carries a fake token — one outcome line; the adapter answers the non-success',
      () => errGeneric('kill', 'ErrKillBroken', `kill refused (${sentinelInMessage('kill', APP_TOKEN_PREFIX)})`),
      (key) =>
        `[slack] killSession (restart adapter): kill for persona=${key}: outcome=${KILL_OUTCOME_NOT_KILLED} class=${AD_ERROR_CLASS_UNCLASSIFIED} name=ErrKillBroken message="kill refused (${REDACTED_SENTINEL_TAIL})"`,
      { kind: KILL_OUTCOME_NOT_KILLED, errorClass: AD_ERROR_CLASS_UNCLASSIFIED },
    ],
    [
      'b.jg5 SRJ-104, SRJ-110: a base AgentDirectorError of a GONE name (ErrTmuxCaptureFailed) whose description carries a fake token — one outcome line; the adapter answers the session-gone success (for kill, gone is success)',
      () => errGeneric('kill', 'ErrTmuxCaptureFailed', `capture failed (${sentinelInMessage('kill', APP_TOKEN_PREFIX)})`),
      (key) => `[slack] killSession (restart adapter): kill for persona=${key}: outcome=${KILL_OUTCOME_SESSION_GONE} (ErrTmuxCaptureFailed)`,
      { kind: KILL_OUTCOME_SESSION_GONE, name: 'ErrTmuxCaptureFailed' },
    ],
  ])('AC 20: the kill answers %s; the line names the outcome with any message redacted; no captured argument carries a credential value', async (_label, makeError, line, expected) => {
    const config = makeMultiPersonaConfig([{ name: 'Alpha Desk' }], dir)
    const [a] = config.personas as [Persona]
    const killCalls: KillParams[] = []
    const failing = makeStubClient({ killError: makeError(), killCalls })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => failing as unknown as Client })

    expect(await _buildKillSessionAdapter()(a.key, LIVENESS_READING_DEAD_ENDED)).toMatchObject(expected)

    expect(killCalls.map((k) => k.claude_instance_id)).toEqual([personaInstanceId(a.key)])
    // b.jg5 SRJ-702: the kill's one try (the run read the row dead) has its
    // own line from the bounded retry; then the adapter's outcome line.
    const [tryLine, ...outcomeLines] = adapterLines()
    expect(tryLine).toContain(`: kill try 1 of 1 for ${personaInstanceId(a.key)}: `)
    // The error's stack frames (' at …', up to the line's tail) are left out.
    expect(outcomeLines.map((l) => l.replace(/ at .*?(?= — |$)/, ''))).toEqual([line(a.key)])
    assertNoLeak({ errArgs })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-301, SRJ-302: the restart run is a recovery attempt. Its
// liveness read, its reconnect (the status read, the pane read and the
// `/mcp reconnect` send-keys), its kill and its relaunch run inside it, so an
// UNAVAILABLE outcome from any of them, or a `status` read error, arms the
// persona's UNAVAILABLE retry timer. A relaunch answered UNAVAILABLE is
// `'refused'`: the timer owns the persona and restart.ts never counts it, so
// the cap is never reached on UNAVAILABLE alone. A LAUNCH FAILURE (`false`)
// still counts and caps, and arms P's timer at once in pending-only mode.
//
// The adapters are server.ts's and the session manager's REAL ones over the
// stub AD client, and a real retry controller is installed as the outage
// wrappers' trigger sink (`initOutageState({ triggerSink })`), on a fake clock
// that is never moved: no retry ever runs, and no real retry timer exists.
// The restart timer is the file's accepted real one; each run is awaited with
// a foreground poll until the persona's restart is neither pending nor active.
// Two personas are configured: P (`alpha_bot`) is restarted and Q
// (`beta_bot`) never is, so each case shows Q's timer left alone.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-301, SRJ-302: the restart run arms the UNAVAILABLE retry timer, and a refused relaunch is never counted', () => {
  let dir: string
  let config: PersonaConfig
  let p: Persona
  let q: Persona
  let clock: FakeClock
  let retry: UnavailableRetryController
  /** Every line the retry controller logged. */
  let retryLines: string[]
  /** console.error lines written during the test. */
  let errLines: string[]
  let origConsoleError: typeof console.error
  /** Each result restart received from the real launch adapter, in settle order. */
  let launchResults: LaunchSessionResult[]

  const REFUSED_LINE = (key: string) =>
    `[slack] Session relaunch refused for persona=${key} — not counted; its UNAVAILABLE retry timer owns the persona`
  const FAILED_LINE = (key: string) => `[slack] Session relaunch failed for persona=${key}`

  /** The controller's armed lines for `key` (one per first arm; a trigger while armed logs none). */
  const armedLines = (key: string) => retryLines.filter((l) => l.startsWith(`[slack] unavailable-retry: persona=${key} armed (`))

  /** A plain `Error` (not an agent-director error, so UNAVAILABLE) whose message carries a fake token. */
  const plainError = () => new Error(`agent-director went away (${sentinelInMessage('unavailable')})`)

  /** Install a stub AD client built from `opts` (status answers `waiting` unless overridden), with the controller as the trigger sink. */
  function installStub(opts: Parameters<typeof makeStubClient>[0]): void {
    const stub = makeStubClient({ statusFn: () => ({ state: 'waiting' }), ...opts })
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client, triggerSink: retry })
    setClientForTests(stub as unknown as Client)
  }

  /** The real launch adapter over the applied config, recording each result restart receives. */
  const realLaunch = async (key: string): Promise<LaunchSessionResult> => {
    const ok = await launchPersonaSession(key, config)
    launchResults.push(ok)
    return ok
  }

  /** Schedule one restart of `key` and wait (foreground poll) until its run has finished. */
  async function runRestart(key: string, ms = 2000): Promise<void> {
    scheduleRestart(key, config.personas.find((x) => x.key === key)!.working_directory)
    const deadline = Date.now() + ms
    while (isRestartPendingOrActive(key) && Date.now() < deadline) await Bun.sleep(5)
    expect(isRestartPendingOrActive(key)).toBe(false)
  }

  /** P's timer is armed once, with `cause` only, its first retry `UNAVAILABLE_RETRY_BASE_S` out; Q's is not armed. */
  function expectArmedOnce(cause: string): void {
    expect(armedLines(p.key)).toHaveLength(1)
    expect(retry.armedKeys()).toEqual([p.key])
    expect(retry.view(p.key)).toEqual({
      phase: 'waiting',
      dueAt: UNAVAILABLE_RETRY_BASE_S * 1000,
      waitMs: UNAVAILABLE_RETRY_BASE_S * 1000,
      refusals: 0,
      causes: [cause],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
    })
    expect(clock.pendingCount()).toBe(1)
    expect(retry.isArmed(q.key)).toBe(false)
    expect(armedLines(q.key)).toEqual([])
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restart-unavailable-'))
    config = makeMultiPersonaConfig([{ name: 'alpha_bot' }, { name: 'beta_bot' }], dir)
    ;[p, q] = config.personas as [Persona, Persona]
    clock = createFakeClock()
    retryLines = []
    retry = createUnavailableRetryController({
      log: (line) => { retryLines.push(line) },
      // Never reached: the fake clock is never moved.
      action: () => ({ kind: 'stop', reason: 'test action' }),
      clock,
    })
    launchResults = []
    errLines = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }
    setSessionNotifier(() => {})
    _resetInFlightLaunches()
    _resetFindMissingMemo()
    _setSpawnHomeDir(dir)
    _setDialogReadyTimeoutMs(200)
  })

  afterEach(async () => {
    await stopApproversAndForgetLaunches()
    console.error = origConsoleError
    retry.stopAll('test end')
    // Checked after the cleanup below, so a failed check never skips it.
    const pendingAfterStop = clock.pendingCount()
    cancelAllRestartTimers()
    resetAdVersionRecheckForTests()
    _resetFindMissingMemo()
    resetClientForTests()
    _resetOutageState()
    setSessionNotifier(undefined)
    _resetSpawnHomeDir()
    _resetDialogReadyTimeoutMs()
    rmSync(dir, { recursive: true, force: true })
    // Every case: no retry timer outlives the test, and no line the retry
    // controller or console.error wrote carries a credential value.
    expect(pendingAfterStop).toBe(0)
    assertNoLeak({ retryLines, errLines })
  })

  // Each site answers UNAVAILABLE with each generic value, and the kill with
  // ErrTmuxKillFailed, the kill-failure cause told apart by name.
  type Site = 'kill' | 'send-keys' | 'read-pane' | 'spawn'
  const UNAVAILABLE_VALUES: ReadonlyArray<[string, (verb: string) => Error]> = [
    ['a plain Error', () => plainError()],
    ['ErrCallTimeout', (verb) => errCallTimeout(verb)],
    ['ErrTmuxUnresponsive', (verb) => errTmuxUnresponsive(verb)],
  ]
  const SITE_CASES: Array<[Site, string, () => Error, string]> = [
    ...(['kill', 'send-keys', 'read-pane', 'spawn'] as const).flatMap((site) =>
      UNAVAILABLE_VALUES.map(([label, make]): [Site, string, () => Error, string] => [site, label, () => make(site), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE]),
    ),
    ['kill', 'ErrTmuxKillFailed', () => errTmuxKillFailed(), UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
  ]

  test.each(SITE_CASES)('SRJ-301: the restart run\'s %s answers %s → P\'s retry timer is armed once (cause %s is recorded); Q\'s is left alone; b.jg5 SRJ-105: a refused kill is followed by no launch', async (site, _label, makeError, cause) => {
    const err = makeError()
    const sendKeysCalls: SendKeysParams[] = []
    const readPaneCalls: ReadPaneParams[] = []
    const spawnCalls: SpawnParams[] = []
    const killCalls: KillParams[] = []
    installStub({
      sendKeysCalls,
      readPaneCalls,
      spawnCalls,
      killCalls,
      ...(site === 'kill' ? { killError: err } : {}),
      ...(site === 'send-keys' ? { sendKeysError: err } : {}),
      ...(site === 'read-pane' ? { readPaneError: err } : {}),
      ...(site === 'spawn' ? { spawnError: err } : {}),
    })
    // The kill and spawn sites take the dead branch (kill, then relaunch); the
    // reconnect sites take the alive-but-disconnected branch through the real
    // reconnect adapter (a `waiting` row: its pane is read, then the keystrokes typed).
    const reconnectSite = site === 'send-keys' || site === 'read-pane'
    const deps = makeDeps({
      isSessionAliveResult: reconnectSite ? LIVENESS_READING_LIVE : LIVENESS_READING_DEAD,
      killSession: site === 'kill' ? _buildKillSessionAdapter() : undefined,
      launchSession: site === 'spawn' ? realLaunch : undefined,
    })
    if (reconnectSite) deps.reconnectSession = _buildReconnectSessionAdapter()
    initRestart(deps)

    await runRestart(p.key)

    // The failing call was made, addressed to P.
    const reached: Record<Site, number> = {
      kill: killCalls.length,
      'send-keys': sendKeysCalls.length,
      'read-pane': readPaneCalls.length,
      spawn: spawnCalls.length,
    }
    expect(reached[site]).toBeGreaterThan(0)
    expectArmedOnce(cause)
    if (site === 'spawn') expect(launchResults).toEqual(['refused'])
    // b.jg5 SRJ-105: the kill's UNAVAILABLE stops the run before its launch.
    if (site === 'kill') {
      expect(deps.launchSessionCalls).toEqual([])
      expect(spawnCalls).toEqual([])
      expect(errLines).toContain(KILL_REFUSED_LINE(p.key, killOutcomeOf({ thrown: err })))
    }
    // No retry ran, and nothing was counted at the restart counting site.
    expect(retryLines.filter((l) => l.includes(' retry 1 '))).toEqual([])
    expect(getFailureCount(p.key)).toBe(0)
    expect(errLines.filter((l) => l === FAILED_LINE(p.key))).toEqual([])
  })

  test('SRJ-301: the reconnect adapter\'s status read fails with a non-UNAVAILABLE error → a read-error cause arms P\'s timer once; nothing is typed', async () => {
    const sendKeysCalls: SendKeysParams[] = []
    const statusCalls: StatusParams[] = []
    installStub({ statusFn: undefined, statusError: errGeneric('status', 'ErrStatusBroken', 'the store could not be read'), statusCalls, sendKeysCalls })
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
    deps.reconnectSession = _buildReconnectSessionAdapter()
    initRestart(deps)

    await runRestart(p.key)

    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(p.key)])
    expect(sendKeysCalls).toEqual([])
    expectArmedOnce(UNAVAILABLE_RETRY_CAUSE_READ_ERROR)
  })

  // Ruling (a): the liveness adapter's `status` error inside a restart run
  // arms the timer (E8's adapter report). b.jg5 SRJ-314: the error reads
  // `unknown`, never dead, so the run kills and launches nothing, counts
  // nothing, and calls the arm hook once besides.
  test.each<[string, () => Error, string]>([
    ['UNAVAILABLE (ErrTmuxUnresponsive)', () => errTmuxUnresponsive('status'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['UNAVAILABLE (ErrCallTimeout)', () => errCallTimeout('status'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['a read error (an unclassified name)', () => errGeneric('status', 'ErrStatusBroken', 'the store could not be read'), UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
  ])('b.jg5 SRJ-301, SRJ-314: the liveness adapter\'s status throws %s inside the restart run → P\'s timer is armed once (cause %s), the arm hook is called once and nothing is killed, launched or counted; Q\'s is left alone', async (_label, makeError, cause) => {
    const statusCalls: StatusParams[] = []
    const killCalls: KillParams[] = []
    const spawnCalls: SpawnParams[] = []
    installStub({ statusFn: undefined, statusError: makeError(), statusCalls, killCalls, spawnCalls })
    // One failure on record, so a counted launch or a reset would show.
    recordFailure(p.key)
    const deps = makeDeps()
    deps.isSessionAlive = _buildIsSessionAliveAdapter(() => config)
    initRestart(deps)

    await runRestart(p.key)

    expect(statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(p.key)])
    expectArmedOnce(cause)
    expect(deps.armRetryTimerCalls).toEqual([p.key])
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
    expect(killCalls).toEqual([])
    expect(spawnCalls).toEqual([])
    expect(getFailureCount(p.key)).toBe(1)
  })

  test('SRJ-301: the liveness adapter\'s status throws ErrSpawnNotFound inside the restart run → nothing is armed (the site keeps its meaning)', async () => {
    installStub({ statusFn: undefined, statusError: errSpawnNotFound() })
    const deps = makeDeps()
    deps.isSessionAlive = _buildIsSessionAliveAdapter(() => config)
    initRestart(deps)

    await runRestart(p.key)

    expect(retry.armedKeys()).toEqual([])
    expect(retryLines).toEqual([])
    // It reads dead: the kill and the launch run, and the arm hook is not called.
    expect(deps.killSessionCalls).toEqual([p.key])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([p.key])
    expect(deps.armRetryTimerCalls).toEqual([])
  })

  test('SRJ-301: the liveness adapter\'s status throws UNAVAILABLE outside any attempt (the health tick\'s call) → nothing is armed; b.jg5 SRJ-314: it reads unknown, never dead', async () => {
    installStub({ statusFn: undefined, statusError: errTmuxUnresponsive('status') })

    expect(await _buildIsSessionAliveAdapter(() => config)(p.key)).toBe(LIVENESS_READING_UNKNOWN)

    expect(retry.armedKeys()).toEqual([])
    expect(retryLines).toEqual([])
  })

  test(`SRJ-302: every relaunch answered UNAVAILABLE is 'refused' — across ${RESTART_FAILURE_CAP + 2} restart runs the failure count stays 0, the cap is never reached and onCapReached never fires; P's timer was armed once`, async () => {
    const spawnCalls: SpawnParams[] = []
    installStub({ spawnError: errTmuxUnresponsive('spawn'), spawnCalls })
    const deps = makeDeps({ launchSession: realLaunch })
    initRestart(deps)

    const runs = RESTART_FAILURE_CAP + 2
    for (let i = 0; i < runs; i++) await runRestart(p.key)

    expect(spawnCalls).toHaveLength(runs)
    expect(launchResults).toEqual(Array(runs).fill('refused'))
    expect(getFailureCount(p.key)).toBe(0)
    expect(isAtCap(p.key, RESTART_FAILURE_CAP)).toBe(false)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(errLines.filter((l) => l === REFUSED_LINE(p.key))).toHaveLength(runs)
    expect(errLines.filter((l) => l === FAILED_LINE(p.key))).toEqual([])
    // Later triggers while armed keep the first arm's due time.
    expectArmedOnce(UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)
  })

  // b.jg5 SRJ-602, SRJ-105's LAUNCH FAILURE row: a launch's
  // ErrTmuxSessionCreate is one counted failure per run, with no kill because
  // of it and no launch in its place; it arms P's timer at once in
  // pending-only mode (SRJ-111, SRJ-113, SRJ-409), which never marks the
  // launch refused, so each run still counts.
  test.each<[string, (stubOpts: { spawnCalls: SpawnParams[]; resumeCalls: ResumeParams[]; killCalls: KillParams[] }) => Parameters<typeof makeStubClient>[0], { spawns: number; resumes: number }]>([
    ['the first spawn', (calls) => ({ ...calls, spawnError: errTmuxSessionCreate('spawn') }), { spawns: 1, resumes: 0 }],
    [
      'a resume of an ended row',
      (calls) => ({
        ...calls,
        spawnError: errInstanceIdCollision(),
        getResult: cannedGetResult({ state: LIVENESS_DEAD_ROW_ENDED, claude_session_id: 'a-session-id' }, p, dir),
        resumeError: errTmuxSessionCreate('resume'),
      }),
      { spawns: 1, resumes: 1 },
    ],
  ])('a relaunch whose %s fails with a LAUNCH FAILURE (ErrTmuxSessionCreate) answers false: each run counts once with one launch call at the failing site and no kill or launch after it, the cap is reached and onCapReached fires once; P\'s timer is armed once, pending-only', async (_label, stubOpts, perRun) => {
    const calls = { spawnCalls: [] as SpawnParams[], resumeCalls: [] as ResumeParams[], killCalls: [] as KillParams[] }
    installStub(stubOpts(calls))
    const deps = makeDeps({ restartDelay: CAP_BASE_DELAY_S, launchSession: realLaunch })
    initRestart(deps)

    for (let i = 0; i < RESTART_FAILURE_CAP; i++) {
      await runRestart(p.key)
      expect(getFailureCount(p.key)).toBe(i + 1)
    }

    expect(launchResults).toEqual(Array(RESTART_FAILURE_CAP).fill(false))
    expect([calls.spawnCalls.length, calls.resumeCalls.length]).toEqual([perRun.spawns * RESTART_FAILURE_CAP, perRun.resumes * RESTART_FAILURE_CAP])
    // The run's own kill comes before its launch; nothing kills after the failure.
    expect(deps.killSessionCalls).toEqual(Array(RESTART_FAILURE_CAP).fill(p.key))
    expect(calls.killCalls).toEqual([])
    expect(isAtCap(p.key, RESTART_FAILURE_CAP)).toBe(true)
    expect(deps.onCapReachedCalls).toEqual([p.key])
    expect(errLines.filter((l) => l === REFUSED_LINE(p.key))).toEqual([])
    expect(errLines.filter((l) => l === FAILED_LINE(p.key))).toHaveLength(RESTART_FAILURE_CAP)
    // One arm: later arms while armed log nothing and keep its due time.
    expect(retryLines.filter((l) => l.startsWith(`[slack] unavailable-retry: persona=${p.key} armed`))).toEqual([
      expect.stringContaining(`persona=${p.key} armed in pending-only mode (`),
    ])
    expect(retry.armedKeys()).toEqual([p.key])
    expect(retry.view(p.key)).toMatchObject({ mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, causes: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW] })
    expect(retry.isArmed(q.key)).toBe(false)
  })

  // The restart counting site alone: `'refused'` from the deps is neither a
  // success nor a failure, like `'skipped'`, and logs its one line.
  test('SRJ-302: launchSession=refused is neither a success nor a failure (no reset, no count, no cap) and logs the refused line; a later false launch counts and caps', async () => {
    for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(p.key)
    let outcome: LaunchSessionResult = 'refused'
    const deps = makeDeps({ restartDelay: CAP_BASE_DELAY_S, launchSession: async () => outcome })
    initRestart(deps)

    // Two refused runs one short of the cap: a counted one would cap it.
    await runRestart(p.key)
    await runRestart(p.key)

    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([p.key, p.key])
    expect(getFailureCount(p.key)).toBe(RESTART_FAILURE_CAP - 1)
    expect(isAtCap(p.key, RESTART_FAILURE_CAP)).toBe(false)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(errLines.filter((l) => l === REFUSED_LINE(p.key))).toHaveLength(2)
    expect(errLines.filter((l) => l === FAILED_LINE(p.key))).toEqual([])

    outcome = false
    await runRestart(p.key)

    expect(getFailureCount(p.key)).toBe(RESTART_FAILURE_CAP)
    expect(deps.onCapReachedCalls).toEqual([p.key])
  })

  // The E8 resume item's restart half: a resume answered ErrInvalidFlags whose
  // immediate version re-check decided the stop makes the real launch adapter
  // answer 'skipped', which records no failure. The real re-check is installed
  // over a stub resolveSystemBinary that answers a version below the floor,
  // on its own fake clock that is never moved; its stop is recorded, not run.
  test('E8: the relaunch\'s resume answers ErrInvalidFlags and the version re-check decides the stop → the launch is \'skipped\': no failure is recorded, the count is unchanged, no cap and no timer', async () => {
    const stops: number[] = []
    installAdVersionRecheck({
      resolveSystemBinary: makeStubResolveSystemBinary({ outcomes: [{ version: OLD_AD_VERSION }] }),
      baselineVersion: PHASE1_RC_VERSION,
      recordStartupError: () => {},
      stop: (exitCode) => { stops.push(exitCode) },
      log: () => {},
      clock: createFakeClock(),
    })
    const resumeCalls: ResumeParams[] = []
    installStub({
      spawnQueue: [cannedErr<SpawnResult>(errInstanceIdCollision())],
      getResult: cannedGetResult({ state: 'ended' }, p, dir),
      resumeError: errInvalidFlags('resume'),
      resumeCalls,
    })
    // One failure on record, so a counted launch or a reset would show.
    recordFailure(p.key)
    const deps = makeDeps({ launchSession: realLaunch })
    initRestart(deps)

    await runRestart(p.key)

    expect(resumeCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(p.key)])
    expect(stops).toHaveLength(1)
    expect(launchResults).toEqual(['skipped'])
    expect(getFailureCount(p.key)).toBe(1)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(errLines.filter((l) => l === FAILED_LINE(p.key))).toEqual([])
    expect(errLines.filter((l) => l === REFUSED_LINE(p.key))).toEqual([])
    expect(retry.armedKeys()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-303: the retry entry (`runRestartRetry`). The UNAVAILABLE retry
// timer's full-mode retries rerun the restart work for P: the shutdown and
// not-up checks, the liveness read, then a reconnect, or a kill and a launch,
// with today's accounting. The entry bypasses only the restart delay and the
// restart timer, so every case here runs with `getRestartDelay` answering 0
// and calls the entry directly. Its first step, inside its own serialized
// work, is the caller's in-flight check: while a launch is in flight for P it
// answers in-flight with no agent-director call. Its second is the restart
// cap: a retry whose turn starts with P at the cap answers capped with no
// agent-director call, nothing counted and no notice (the cap re-check).
//
// Every wait is a microtask flush or a controllable promise; the per-key
// active-count cases alone fire one real restart timer, the file's accepted
// real-timer exception.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-303: runRestartRetry reruns the restart decision without the delay gate or a restart timer', () => {
  const P = 'persona_p'
  const CWD = '/cwd/p'
  const skipLine = `[slack] Restart retry skipped for persona=${P} — a launch is in flight; no agent-director call`
  const capSkipLine = `[slack] Restart retry skipped for persona=${P} — the persona is at the restart cap; nothing killed or launched`
  let errLines: string[]
  let errArgs: unknown[][]
  let origConsoleError: typeof console.error
  /** How many times the deps' `getRestartDelay` was read. */
  let delayReads: number
  /** Each key the in-flight predicate was asked about. */
  let inFlightAsked: string[]

  const notInFlight = (key: string): boolean => { inFlightAsked.push(key); return false }

  /** Let every continuation queued so far run (no timer, no real delay). */
  async function flush(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  /** The file's deps with the restart delay at 0 (unless `opts` says otherwise), counting its reads. */
  function retryDeps(opts: DepsOpts = {}): ReturnType<typeof makeDeps> {
    const deps = makeDeps({ restartDelay: 0, ...opts })
    const delay = deps.getRestartDelay
    deps.getRestartDelay = () => { delayReads++; return delay() }
    return deps
  }

  /** A launch that stays pending until the test settles it; each call's settle, in call order. */
  function heldLaunches(): { launch: () => Promise<LaunchSessionResult>; settle: Array<(ok: LaunchSessionResult) => void> } {
    const settle: Array<(ok: LaunchSessionResult) => void> = []
    return { settle, launch: () => new Promise<LaunchSessionResult>((res) => { settle.push(res) }) }
  }

  /** Nothing was probed, reconnected, killed or launched. */
  function expectNoWork(deps: ReturnType<typeof makeDeps>): void {
    expect(deps.isSessionAliveCalls).toEqual([])
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
  }

  beforeEach(() => {
    delayReads = 0
    inFlightAsked = []
    errLines = []
    errArgs = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args); errLines.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.error = origConsoleError
    cancelAllRestartTimers()
  })

  test('before initRestart: answers not-initialised, asks nothing, logs once and leaves P inactive', async () => {
    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_NOT_INITIALISED)
    expect(inFlightAsked).toEqual([])
    expect(isRestartPendingOrActive(P)).toBe(false)
    expect(errLines).toEqual([`[slack] runRestartRetry: deps not initialized — skipping the retry for persona=${P}`])
  })

  test('with the restart delay at 0 scheduleRestart arms nothing, yet the retry kills and launches P at once: it reads no delay and arms no restart timer', async () => {
    const held = heldLaunches()
    const order: string[] = []
    const deps = retryDeps({
      killSession: async () => { order.push('kill'); return KILL_SUCCEEDED },
      launchSession: () => { order.push('launch'); return held.launch() },
    })
    initRestart(deps)

    scheduleRestart(P, CWD)
    expect(isRestartPendingOrActive(P)).toBe(false)
    expect(delayReads).toBe(1)

    const retry = runRestartRetry(P, CWD, notInFlight)
    await flush()
    // The launch is held: P is active, yet no restart timer is pending.
    expect(order).toEqual(['kill', 'launch'])
    expect(deps.launchSessionCalls).toEqual([{ key: P, cwd: CWD, sessionId: undefined }])
    expect(isRestartPendingOrActive(P)).toBe(true)
    expect(cancelRestartTimer(P)).toBe(false)

    held.settle[0]!(true)
    expect(await retry).toBe(RESTART_OUTCOME_LAUNCHED)
    expect(isRestartPendingOrActive(P)).toBe(false)
    expect(delayReads).toBe(1)
    expect(errLines.filter((l) => l.startsWith('[slack] Scheduling restart'))).toEqual([])
  })

  test('a restart timer already pending for P is left pending by a retry: neither cleared nor re-armed', async () => {
    const deps = retryDeps({ restartDelay: SLOW_DELAY_S })
    initRestart(deps)
    scheduleRestart(P, CWD)
    const scheduledLines = () => errLines.filter((l) => l.startsWith('[slack] Scheduling restart'))
    expect(scheduledLines()).toHaveLength(1)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_LAUNCHED)

    expect(delayReads).toBe(1)
    expect(scheduledLines()).toHaveLength(1)
    expect(isRestartPendingOrActive(P)).toBe(true)
    expect(cancelRestartTimer(P)).toBe(true)
  })

  // The failure count starts at 1, so a recorded success or failure would show.
  test.each<[string, (deps: ReturnType<typeof makeDeps>) => void, RestartRetryOutcome, number]>([
    ['the server is shutting down', (deps) => { deps.isShuttingDown = () => true }, RESTART_OUTCOME_SHUTTING_DOWN, 0],
    ['P is not up', (deps) => { deps.canRestart = () => false }, RESTART_OUTCOME_NOT_UP, 0],
    ['P stops being up during the liveness read', (deps) => {
      let asked = 0
      deps.canRestart = () => ++asked === 1
    }, RESTART_OUTCOME_NOT_UP, 1],
  ])('%s → no reconnect, kill or launch, nothing counted, and the matching outcome', async (_label, setUp, outcome, probes) => {
    recordFailure(P)
    const deps = retryDeps({ isSessionAliveResult: LIVENESS_READING_LIVE, launchSessionResult: false })
    setUp(deps)
    initRestart(deps)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(outcome)

    expect(deps.isSessionAliveCalls).toHaveLength(probes)
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
    expect(getFailureCount(P)).toBe(1)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(isRestartPendingOrActive(P)).toBe(false)
  })

  test('the row reads live and P is connected with its stream → already-connected: no reconnect, kill or launch, nothing counted', async () => {
    recordFailure(P)
    const deps = retryDeps({ isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: true, hasSessionStreamResult: true })
    initRestart(deps)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_ALREADY_CONNECTED)

    expect(deps.isSessionAliveCalls).toEqual([P])
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
    expect(getFailureCount(P)).toBe(1)
  })

  // The row reads live but P is not connected: a reconnect. Its verdict decides
  // the rest; an 'escalate-dead' is followed by a second liveness read.
  test.each<[string, ReconnectSessionResult, LivenessReading, RestartRetryOutcome, number]>([
    ['the reconnect succeeds → reconnected, a success recorded', 'success', LIVENESS_READING_LIVE, RESTART_OUTCOME_RECONNECTED, 0],
    ['the reconnect is transient → reconnect-deferred, nothing counted', 'transient', LIVENESS_READING_LIVE, RESTART_OUTCOME_RECONNECT_DEFERRED, 1],
    ['the reconnect answers pending (b.jg5 SRJ-303: the row not started yet) → pending-deferred, nothing counted', 'pending', LIVENESS_READING_LIVE, RESTART_OUTCOME_PENDING_DEFERRED, 1],
    ['the reconnect gives no answer → reconnect-deferred, nothing counted', undefined, LIVENESS_READING_LIVE, RESTART_OUTCOME_RECONNECT_DEFERRED, 1],
    ['a GONE-based escalate-dead and the row still reads live → reconnect-deferred, nothing counted', ESCALATE_DEAD_WORKING_GONE, LIVENESS_READING_LIVE, RESTART_OUTCOME_RECONNECT_DEFERRED, 1],
    ['a GONE-based escalate-dead and the row now reads dead → a kill and a launch carrying the verdict in the same retry, launched', ESCALATE_DEAD_WORKING_GONE, LIVENESS_READING_DEAD, RESTART_OUTCOME_LAUNCHED, 0],
  ])('alive but not connected: %s', async (_label, verdict, reprobe, outcome, count) => {
    recordFailure(P)
    const deps = retryDeps()
    const readings = [LIVENESS_READING_LIVE, reprobe]
    deps.isSessionAlive = async (key) => { deps.isSessionAliveCalls.push(key); return readings.shift()! }
    deps.reconnectSession = async (key) => { deps.reconnectSessionCalls.push(key); return verdict }
    initRestart(deps)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(outcome)

    expect(deps.reconnectSessionCalls).toEqual([P])
    const relaunched = outcome === RESTART_OUTCOME_LAUNCHED
    expect(deps.isSessionAliveCalls).toHaveLength(verdict === ESCALATE_DEAD_WORKING_GONE ? 2 : 1)
    expect(deps.killSessionCalls).toEqual(relaunched ? [P] : [])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual(relaunched ? [P] : [])
    expect(deps.launchSessionCalls.map((c) => c.deadEvidence)).toEqual(relaunched ? [ESCALATE_DEAD_WORKING_GONE.deadEvidence] : [])
    expect(getFailureCount(P)).toBe(count)
  })

  test('b.jg5 SRJ-303: a pending reconnect logs exactly what a transient one does; only the outcome differs', async () => {
    const linesFor = async (verdict: 'transient' | 'pending'): Promise<{ outcome: RestartRetryOutcome; lines: string[] }> => {
      errLines = []
      const deps = retryDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
      deps.reconnectSession = async (key) => { deps.reconnectSessionCalls.push(key); return verdict }
      initRestart(deps)
      const outcome = await runRestartRetry(P, CWD, notInFlight)
      expect(deps.killSessionCalls).toEqual([])
      expect(deps.launchSessionCalls).toEqual([])
      return { outcome, lines: [...errLines] }
    }

    const transient = await linesFor('transient')
    const pending = await linesFor('pending')

    expect(transient.outcome).toBe(RESTART_OUTCOME_RECONNECT_DEFERRED)
    expect(pending.outcome).toBe(RESTART_OUTCOME_PENDING_DEFERRED)
    expect(pending.lines).toEqual(transient.lines)
    expect(pending.lines).toEqual([`[slack] Session alive but disconnected — reconnecting MCP for persona=${P}`])
  })

  // The row reads dead: a kill, then a launch, whose answer decides the
  // accounting. The count starts at 1.
  test.each<[string, LaunchSessionResult, RestartRetryOutcome, number]>([
    ['the launch succeeds → launched, a success recorded', true, RESTART_OUTCOME_LAUNCHED, 0],
    ['the launch fails → counted-failure, recordFailure once', false, RESTART_OUTCOME_COUNTED_FAILURE, 2],
    ['the launch answers UNAVAILABLE → refused, the count unchanged', 'refused', RESTART_OUTCOME_REFUSED, 1],
    ['the launch is declined by its own gate → launch-skipped, the count unchanged', 'skipped', RESTART_OUTCOME_LAUNCH_SKIPPED, 1],
  ])('dead: a kill then a launch — %s', async (_label, result, outcome, count) => {
    recordFailure(P)
    const order: string[] = []
    const deps = retryDeps({
      killSession: async () => { order.push('kill'); return KILL_SUCCEEDED },
      launchSession: async () => { order.push('launch'); return result },
    })
    initRestart(deps)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(outcome)

    expect(order).toEqual(['kill', 'launch'])
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(getFailureCount(P)).toBe(count)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(isRestartPendingOrActive(P)).toBe(false)
  })

  // The retry past the cap is skipped by the entry's cap re-check: no kill,
  // no launch, nothing counted and no second notice.
  test('counted failures up to RESTART_FAILURE_CAP: the one that reaches it answers capped and fires onCapReached once; a retry after it answers capped by the cap re-check, with no kill, no launch, no count and no second notice', async () => {
    for (let i = 0; i < RESTART_FAILURE_CAP - 2; i++) recordFailure(P)
    const deps = retryDeps({ launchSessionResult: false })
    initRestart(deps)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_COUNTED_FAILURE)
    expect(deps.onCapReachedCalls).toEqual([])

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_CAPPED)
    expect(getFailureCount(P)).toBe(RESTART_FAILURE_CAP)
    expect(deps.onCapReachedCalls).toEqual([P])
    expect(deps.killSessionCalls).toEqual([P, P])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([P, P])
    expect(errLines).not.toContain(capSkipLine)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_CAPPED)
    expect(getFailureCount(P)).toBe(RESTART_FAILURE_CAP)
    expect(deps.onCapReachedCalls).toEqual([P])
    expect(deps.killSessionCalls).toEqual([P, P])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([P, P])
    expect(errLines.filter((l) => l === capSkipLine)).toHaveLength(1)
  })

  test('cap re-check: a retry for P already at RESTART_FAILURE_CAP answers capped after the in-flight check, with no shutdown or not-up check, no probe, reconnect, kill or launch, nothing counted, no notice, and one skip line', async () => {
    for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(P)
    const asked: string[] = []
    const deps = retryDeps({ launchSessionResult: false })
    deps.isShuttingDown = () => { asked.push('shutdown'); return false }
    deps.canRestart = () => { asked.push('gate'); return true }
    initRestart(deps)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_CAPPED)

    expect(inFlightAsked).toEqual([P])
    expect(asked).toEqual([])
    expectNoWork(deps)
    expect(getFailureCount(P)).toBe(RESTART_FAILURE_CAP)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(isRestartPendingOrActive(P)).toBe(false)
    expect(errLines).toEqual([capSkipLine])
  })

  test('cap re-check: two retries queued through serialize one failure short of the cap — the first\'s launch fails and answers capped; the second answers capped with no launch (exactly one launch, one notice)', async () => {
    for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(P)
    const held = heldLaunches()
    const serializer = createPersonaSerializer()
    const deps = retryDeps({ launchSession: held.launch })
    deps.serialize = (key, op) => serializer.run(key, op)
    initRestart(deps)

    const first = runRestartRetry(P, CWD, notInFlight)
    const second = runRestartRetry(P, CWD, notInFlight)
    await flush()
    // The first holds P's turn in its launch; the second waits, asking nothing.
    expect(held.settle).toHaveLength(1)
    expect(inFlightAsked).toEqual([P])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([P])

    held.settle[0]!(false)
    expect(await first).toBe(RESTART_OUTCOME_CAPPED)
    expect(await second).toBe(RESTART_OUTCOME_CAPPED)

    expect(inFlightAsked).toEqual([P, P])
    expect(deps.killSessionCalls).toEqual([P])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([P])
    expect(getFailureCount(P)).toBe(RESTART_FAILURE_CAP)
    expect(deps.onCapReachedCalls).toEqual([P])
    expect(errLines.filter((l) => l === capSkipLine)).toHaveLength(1)
    expect(isRestartPendingOrActive(P)).toBe(false)
  })

  // The restart timer here is the file's accepted real one (a 16 ms backoff
  // from four recorded failures at CAP_BASE_DELAY_S), polled until it has
  // submitted its work behind the gated operation.
  test('cap re-check: a fired restart timer\'s work queued ahead of a retry one failure short of the cap — the timer\'s launch fails and reaches the cap; the retry then makes no launch and answers capped', async () => {
    for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(P)
    const submitted: string[] = []
    const serializer = createPersonaSerializer()
    const deps = retryDeps({ restartDelay: CAP_BASE_DELAY_S, launchSessionResult: false })
    deps.serialize = (key, op) => { submitted.push(key); return serializer.run(key, op) }
    initRestart(deps)

    // An earlier operation for P holds P's turn while both are queued.
    const gate = Promise.withResolvers<void>()
    const earlier = serializer.run(P, () => gate.promise)
    scheduleRestart(P, CWD)
    const deadline = Date.now() + 2000
    while (submitted.length === 0 && Date.now() < deadline) await Bun.sleep(5)
    expect(submitted).toEqual([P])
    const retry = runRestartRetry(P, CWD, notInFlight)
    await flush()
    expect(submitted).toEqual([P, P])
    expectNoWork(deps)

    gate.resolve()
    await earlier
    expect(await retry).toBe(RESTART_OUTCOME_CAPPED)

    // The timer's work ran first: one kill, one launch, the failure that reached the cap and its one notice.
    expect(deps.killSessionCalls).toEqual([P])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([P])
    expect(getFailureCount(P)).toBe(RESTART_FAILURE_CAP)
    expect(deps.onCapReachedCalls).toEqual([P])
    expect(inFlightAsked).toEqual([P])
    expect(errLines.filter((l) => l === capSkipLine)).toHaveLength(1)
    await flush()
    expect(isRestartPendingOrActive(P)).toBe(false)
  })

  // The in-flight check is the first step: nothing else is asked, and a check
  // that throws counts as in flight. The thrown error carries a fake token.
  test.each<[string, boolean]>([
    ['the in-flight check answers true', false],
    ['the in-flight check throws (treated as in flight)', true],
  ])('%s → in-flight: no shutdown or not-up check, no probe, reconnect, kill or launch, nothing counted', async (_label, throws) => {
    recordFailure(P)
    const asked: string[] = []
    const deps = retryDeps({ launchSessionResult: false })
    deps.isShuttingDown = () => { asked.push('shutdown'); return false }
    deps.canRestart = () => { asked.push('gate'); return true }
    initRestart(deps)

    const isInFlight = (key: string): boolean => {
      inFlightAsked.push(key)
      if (throws) throw new Error(`in-flight check broke (${sentinelInMessage('in-flight')})`)
      return true
    }
    expect(await runRestartRetry(P, CWD, isInFlight)).toBe(RESTART_OUTCOME_IN_FLIGHT)

    expect(inFlightAsked).toEqual([P])
    expect(asked).toEqual([])
    expectNoWork(deps)
    expect(getFailureCount(P)).toBe(1)
    expect(isRestartPendingOrActive(P)).toBe(false)
    if (throws) {
      expect(errLines).toHaveLength(2)
      expect(errLines[0]).toStartWith(`[slack] restart retry: in-flight check failed for persona=${P}: Error message="in-flight check broke (${REDACTED_SENTINEL_TAIL})" at `)
      expect(errLines[0]).toEndWith(' — treated as in flight')
      expect(errLines[1]).toBe(skipLine)
    } else {
      expect(errLines).toEqual([skipLine])
    }
    assertNoLeak({ errArgs })
  })

  test.each<[string, 'none' | 'not-up' | 'in-flight', RestartRetryOutcome]>([
    ['nothing changes while queued: its turn runs the in-flight check, the gate, the probe, the kill and the launch', 'none', RESTART_OUTCOME_LAUNCHED],
    ['P stops being up while queued: its turn stops at the not-up check', 'not-up', RESTART_OUTCOME_NOT_UP],
    ['a launch goes in flight for P while queued: its turn stops at the in-flight check', 'in-flight', RESTART_OUTCOME_IN_FLIGHT],
  ])('through serialize: the retry waits behind a gated operation for P, asking nothing meanwhile, and runs its checks when its turn starts — %s', async (_label, change, outcome) => {
    let up = true
    let launching = false
    const gateAsked: string[] = []
    const submitted: string[] = []
    const serializer = createPersonaSerializer()
    const deps = retryDeps()
    deps.canRestart = (key) => { gateAsked.push(key); return up }
    deps.serialize = (key, op) => { submitted.push(key); return serializer.run(key, op) }
    initRestart(deps)

    // An earlier operation for P (a teardown, a bring-up retry's launch) holds P's turn.
    const gate = Promise.withResolvers<void>()
    const earlier = serializer.run(P, () => gate.promise)
    const retry = runRestartRetry(P, CWD, (key) => { inFlightAsked.push(key); return launching })
    await flush()

    expect(submitted).toEqual([P])
    expect(inFlightAsked).toEqual([])
    expect(gateAsked).toEqual([])
    expectNoWork(deps)
    expect(isRestartPendingOrActive(P)).toBe(true)

    if (change === 'not-up') up = false
    if (change === 'in-flight') launching = true
    gate.resolve()
    await earlier
    expect(await retry).toBe(outcome)

    expect(inFlightAsked).toEqual([P])
    if (change === 'none') {
      expect(gateAsked).toEqual([P, P])
      expect(deps.killSessionCalls).toEqual([P])
      expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([P])
    } else {
      expect(gateAsked).toEqual(change === 'not-up' ? [P] : [])
      expectNoWork(deps)
    }
    expect(isRestartPendingOrActive(P)).toBe(false)
  })

  // P is active while any restart work for it runs: one ending never hides
  // another. The restart timer here is the file's accepted real one (a 2 ms
  // backoff from one recorded failure), waited out with `Bun.sleep(WAIT_MS)`.
  test.each<[string, 'retry' | 'timer']>([
    ['the retry finishes first: P stays active while the fired restart timer\'s work still runs', 'retry'],
    ['the fired restart timer\'s work finishes first: P stays active while the retry still runs', 'timer'],
  ])('per-key active count, a retry and a fired restart timer\'s work running at once for P — %s', async (_label, first) => {
    recordFailure(P)
    const held = heldLaunches()
    const deps = retryDeps({ restartDelay: CAP_BASE_DELAY_S, launchSession: held.launch })
    initRestart(deps)

    const retry = runRestartRetry(P, CWD, notInFlight)
    scheduleRestart(P, CWD)
    await Bun.sleep(WAIT_MS)
    // Both launches are held: the retry's first, then the timer's.
    expect(held.settle).toHaveLength(2)
    const [retryLaunch, timerLaunch] = held.settle as [(ok: LaunchSessionResult) => void, (ok: LaunchSessionResult) => void]
    expect(isRestartPendingOrActive(P)).toBe(true)
    expect(cancelRestartTimer(P)).toBe(false)

    if (first === 'retry') {
      retryLaunch(true)
      expect(await retry).toBe(RESTART_OUTCOME_LAUNCHED)
      expect(isRestartPendingOrActive(P)).toBe(true)
      timerLaunch(true)
      await flush()
    } else {
      timerLaunch(true)
      await flush()
      expect(getFailureCount(P)).toBe(0)                 // the timer's work recorded its success
      expect(isRestartPendingOrActive(P)).toBe(true)
      retryLaunch(true)
      expect(await retry).toBe(RESTART_OUTCOME_LAUNCHED)
    }
    expect(isRestartPendingOrActive(P)).toBe(false)
  })

  // The real launch adapter and `isLaunchInFlight` over one stub AD client
  // whose `spawn` is held (`holdSpawns`), with every other adapter real too,
  // so any agent-director call the retry made would land in the stub's log.
  // Every raw-tmux seam is a no-op and every persona path lies under a temp
  // directory removed in afterEach.
  describe('a launch call in flight for P, through the real adapters', () => {
    let dir: string
    let config: PersonaConfig
    let a: Persona
    let log: StubCallLog
    let hold: SpawnHold

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'restart-retry-'))
      config = makeMultiPersonaConfig([{ name: 'alpha_bot' }], dir)
      ;[a] = config.personas as [Persona]
      log = makeStubCallLog()
      const stub = makeStubClient({ ...log, statusFn: () => ({ state: 'waiting' }) })
      hold = holdSpawns(stub)
      _resetOutageState()
      initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
      setClientForTests(stub as unknown as Client)
      setSessionNotifier(() => {})
      _resetInFlightLaunches()
      _setSpawnHomeDir(dir)
      _setDialogReadyTimeoutMs(200)
    })

    afterEach(async () => {
      hold.releaseAll()
      await stopApproversAndForgetLaunches()
      resetClientForTests()
      _resetOutageState()
      setSessionNotifier(undefined)
      _resetSpawnHomeDir()
      _resetDialogReadyTimeoutMs()
      rmSync(dir, { recursive: true, force: true })
    })

    test('the retry makes no agent-director call at all and answers in-flight; the held launch still completes', async () => {
      const deps = retryDeps({
        killSession: _buildKillSessionAdapter(),
        launchSession: (key) => launchPersonaSession(key, config),
      })
      deps.isSessionAlive = _buildIsSessionAliveAdapter(() => config)
      deps.reconnectSession = _buildReconnectSessionAdapter()
      initRestart(deps)

      const id = personaInstanceId(a.key)
      const launch = launchPersonaSession(a.key, config)
      await hold.entered(id)
      expect(isLaunchInFlight(a.key)).toBe(true)
      const before = stubCallCount(log)

      expect(await runRestartRetry(a.key, a.working_directory, isLaunchInFlight)).toBe(RESTART_OUTCOME_IN_FLIGHT)

      expect(stubCallCount(log)).toBe(before)
      expect(hold.calls).toHaveLength(1)
      expect(deps.killSessionCalls).toEqual([])
      expect(deps.launchSessionCalls).toEqual([])
      expect(getFailureCount(a.key)).toBe(0)

      hold.release(id)
      expect(await launch).toBe(true)
      expect(isLaunchInFlight(a.key)).toBe(false)
      await _whenDialogApproverStopped(a.key)
    })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-314 (AC 37, HO C12): only a `dead` reading leads to a kill and a
// launch. A liveness probe that reads `unknown`, throws, or answers something
// that is not a reading, at the first probe or at b.d61's re-probe after an
// 'escalate-dead' reconnect, reconnects, kills and launches nothing, records
// no success or failure, answers `RESTART_OUTCOME_LIVENESS_UNKNOWN` and calls
// the arm hook (`RestartDeps.armRetryTimer`, a recording double here) once
// with the key. A re-probe that reads `pending` relaunches nothing and arms
// nothing. Each case runs through the retry entry (`runRestartRetry`, called
// directly with the delay at 0) and, where the outcome is not needed, through
// the restart timer (the file's `Bun.sleep(WAIT_MS)` wait). The failure count
// starts at 1, so a recorded success (a reset) or failure shows.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-314: an unknown or thrown liveness probe kills and launches nothing, counts nothing and calls the arm hook', () => {
  const P = 'persona_p'
  const CWD = '/cwd/p'
  const UNKNOWN_LINE = `[slack] Liveness unknown for persona=${P}`
  const NOTHING_DONE = ' — no reconnect, kill or launch; nothing counted'
  let errLines: string[]
  let errArgs: unknown[][]
  let origConsoleError: typeof console.error

  const notInFlight = (): boolean => false
  /** A probe failure whose message and properties carry fake tokens. */
  const probeError = () =>
    Object.assign(new Error(`status refused (${sentinelInMessage('probe')})`), { code: 'EIO', note: LEAK_SENTINEL })
  const probeFailure = `(isSessionAlive failed: Error code=EIO message="status refused (${REDACTED_SENTINEL_TAIL})" at `

  beforeEach(() => {
    errLines = []
    errArgs = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args); errLines.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.error = origConsoleError
    cancelAllRestartTimers()
  })

  /** Nothing was reconnected, killed or launched, and the failure count is still 1. */
  function expectNothingDone(deps: ReturnType<typeof makeDeps>): void {
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
    expect(getFailureCount(P)).toBe(1)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(isRestartPendingOrActive(P)).toBe(false)
  }

  // A live row with P connected and its stream would answer already-connected,
  // and a dead one would kill and launch: P is neither connected nor streaming,
  // so any reading other than `unknown` would act.
  const FIRST_PROBES: ReadonlyArray<[string, () => Promise<LivenessReading>, string]> = [
    ['reads unknown', async () => LIVENESS_READING_UNKNOWN, `${UNKNOWN_LINE}${NOTHING_DONE}`],
    ['throws', async () => { throw probeError() }, `${UNKNOWN_LINE} ${probeFailure}`],
    ['answers something that is not a reading (a boolean)', async () => true as unknown as LivenessReading, `${UNKNOWN_LINE}${NOTHING_DONE}`],
  ]
  const ENTRIES: ReadonlyArray<['the retry entry' | 'the restart timer']> = [['the retry entry'], ['the restart timer']]
  const FIRST_PROBE_CASES = ENTRIES.flatMap(([entry]) => FIRST_PROBES.map(([label, probe, line]) => [entry, label, probe, line] as const))

  test.each(FIRST_PROBE_CASES)('through %s, the first probe %s → no reconnect, kill or launch; nothing counted; the arm hook is called once with the key; one unknown line', async (entry, _label, probe, line) => {
    recordFailure(P)
    const deps = makeDeps({ restartDelay: entry === 'the retry entry' ? 0 : FAST_DELAY_S, launchSessionResult: false })
    deps.isSessionAlive = async (key) => { deps.isSessionAliveCalls.push(key); return probe() }
    initRestart(deps)

    if (entry === 'the retry entry') {
      expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_LIVENESS_UNKNOWN)
    } else {
      scheduleRestart(P, CWD)
      await Bun.sleep(WAIT_MS)
    }

    expect(deps.isSessionAliveCalls).toEqual([P])
    expectNothingDone(deps)
    expect(deps.armRetryTimerCalls).toEqual([P])
    const unknownLines = errLines.filter((l) => l.startsWith(UNKNOWN_LINE))
    expect(unknownLines).toHaveLength(1)
    expect(unknownLines[0]).toStartWith(line)
    if (!line.includes('isSessionAlive failed')) expect(unknownLines[0]).toBe(line)
    expect(errLines.filter((l) => l.startsWith('[slack] Relaunching session'))).toEqual([])
    assertNoLeak({ errArgs })
  })

  // b.d61's re-probe, through the retry entry so its outcome shows (the
  // restart timer's path is pinned in the b.d61 re-probe describe above).
  test.each<[string, () => Promise<LivenessReading>, RestartRetryOutcome, boolean]>([
    ['reads unknown → liveness-unknown: no kill, no relaunch, nothing counted, the arm hook called once', async () => LIVENESS_READING_UNKNOWN, RESTART_OUTCOME_LIVENESS_UNKNOWN, true],
    ['throws → liveness-unknown: no kill, no relaunch, nothing counted, the arm hook called once', async () => { throw probeError() }, RESTART_OUTCOME_LIVENESS_UNKNOWN, true],
    ['reads pending → pending-deferred: no kill, no relaunch, nothing counted, nothing armed', async () => LIVENESS_READING_PENDING, RESTART_OUTCOME_PENDING_DEFERRED, false],
  ])('after an escalate-dead reconnect, the re-probe %s', async (_label, reprobe, outcome, armed) => {
    recordFailure(P)
    const deps = makeDeps({ restartDelay: 0, launchSessionResult: false })
    deps.isSessionAlive = async (key) => {
      deps.isSessionAliveCalls.push(key)
      return deps.isSessionAliveCalls.length === 1 ? LIVENESS_READING_LIVE : reprobe()
    }
    deps.reconnectSession = async (key) => { deps.reconnectSessionCalls.push(key); return ESCALATE_DEAD_WORKING_GONE }
    initRestart(deps)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(outcome)

    expect(deps.isSessionAliveCalls).toEqual([P, P])
    expect(deps.reconnectSessionCalls).toEqual([P])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
    expect(getFailureCount(P)).toBe(1)
    expect(deps.armRetryTimerCalls).toEqual(armed ? [P] : [])
    assertNoLeak({ errArgs })
  })

  // The hook is optional, and one that throws is logged by its redacted
  // description and changes nothing else: the outcome is still liveness-unknown.
  test.each<[string, 'absent' | 'throws']>([
    ['absent: nothing is armed and nothing more is logged', 'absent'],
    ['throws: one redacted line, and nothing else changes', 'throws'],
  ])('the arm hook %s', async (_label, hook) => {
    recordFailure(P)
    const deps = makeDeps({ restartDelay: 0, isSessionAliveResult: LIVENESS_READING_UNKNOWN })
    if (hook === 'absent') {
      delete deps.armRetryTimer
    } else {
      deps.armRetryTimer = (key) => {
        deps.armRetryTimerCalls.push(key)
        throw Object.assign(new Error(`arm refused (${sentinelInMessage('arm')})`), { note: LEAK_SENTINEL })
      }
    }
    initRestart(deps)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_LIVENESS_UNKNOWN)

    expectNothingDone(deps)
    expect(deps.armRetryTimerCalls).toEqual(hook === 'absent' ? [] : [P])
    const armFailed = errLines.filter((l) => l.startsWith(`[slack] restart: arming the retry timer failed for persona=${P}`))
    if (hook === 'absent') {
      expect(armFailed).toEqual([])
    } else {
      expect(armFailed).toHaveLength(1)
      expect(armFailed[0]).toStartWith(`[slack] restart: arming the retry timer failed for persona=${P}: Error message="arm refused (${REDACTED_SENTINEL_TAIL})" at `)
    }
    assertNoLeak({ errArgs })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-115, SRJ-314: a liveness probe that reads `pending` (the row's
// session has not started) hands the row to the `pending` deferral
// (`RestartDeps.deferPendingRow`) once, with its reading (the launch start
// carried), whatever the session's connection shows: connected with its
// stream (never "already reconnected"), connected but streamless, or
// disconnected. Nothing is reconnected, killed or launched, no success or
// failure is recorded, nothing is armed, and the work answers
// `RESTART_OUTCOME_PENDING_DEFERRED`. The connection is never read. A
// deferral that throws is logged by its redacted description and changes
// nothing else; an absent one is skipped with the same outcome. `live` and
// `dead` are unchanged and never reach the deferral. A row with no launch
// start is deferred the same way (its latch is E16's). The failure count
// starts at 1, so a recorded success (a reset) or failure shows.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-115: a pending reading goes to the pending deferral whatever the connection shows', () => {
  const P = 'persona_p'
  const CWD = '/cwd/p'
  const DEFER_FAILED = `[slack] restart: the pending deferral failed for persona=${P}`
  let errLines: string[]
  let errArgs: unknown[][]
  let origConsoleError: typeof console.error

  const notInFlight = (): boolean => false

  beforeEach(() => {
    errLines = []
    errArgs = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args); errLines.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.error = origConsoleError
    cancelAllRestartTimers()
  })

  /** P's connection as the registry shows it: [label, connected, stream present]. */
  const CONNECTIONS: ReadonlyArray<readonly [string, boolean, boolean]> = [
    ['connected with its stream', true, true],
    ['connected but streamless', true, false],
    ['disconnected', false, true],
  ]
  const LAUNCH_STARTS: ReadonlyArray<readonly [string, string | undefined]> = [
    ['with a launch start', SAMPLE_LAUNCH_START_FRACTIONAL],
    ['with no launch start', SAMPLE_LAUNCH_START_NONE],
  ]
  const ENTRIES: ReadonlyArray<'the retry entry' | 'the restart timer'> = ['the retry entry', 'the restart timer']

  /**
   * The file's deps with a recording `pending` deferral, the probe answering
   * `reading`, P's connection as given (each read recorded) and launches
   * failing, so a launch would be counted.
   */
  function pendingDeps(reading: LivenessReading, connected: boolean, stream: boolean, restartDelay = 0): {
    deps: ReturnType<typeof makeDeps>
    deferred: Array<[string, PendingLivenessReading]>
    connectionReads: string[]
  } {
    const deps = makeDeps({ restartDelay, isSessionAliveResult: reading, launchSessionResult: false })
    const deferred: Array<[string, PendingLivenessReading]> = []
    const connectionReads: string[] = []
    deps.isSessionConnected = (key) => { connectionReads.push(`connected:${key}`); return connected }
    deps.hasSessionStream = (key) => { connectionReads.push(`stream:${key}`); return stream }
    deps.deferPendingRow = (key, r) => { deferred.push([key, r]) }
    return { deps, deferred, connectionReads }
  }

  /** Nothing reconnected, killed, launched, counted, notified or armed; no restart line beyond the scheduling one. */
  function expectNothingDone(deps: ReturnType<typeof makeDeps>): void {
    expect(deps.isSessionAliveCalls).toEqual([P])
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls).toEqual([])
    expect(deps.launchSessionCalls).toEqual([])
    expect(getFailureCount(P)).toBe(1)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(deps.armRetryTimerCalls).toEqual([])
    expect(isRestartPendingOrActive(P)).toBe(false)
  }

  /** The lines other than the restart timer's scheduling line and a deferral failure. */
  const otherLines = (): string[] =>
    errLines.filter((l) => !l.startsWith('[slack] Scheduling restart') && !l.startsWith(DEFER_FAILED))

  const DEFER_CASES = ENTRIES.flatMap((entry) =>
    CONNECTIONS.flatMap(([conn, connected, stream]) =>
      LAUNCH_STARTS.map(([startLabel, start]) => [entry, conn, startLabel, connected, stream, start] as const)))

  test.each(DEFER_CASES)('through %s, a pending first probe, P %s, %s → the deferral once with the key and the reading; no reconnect, kill or launch; nothing counted or armed; the connection never read; pending-deferred', async (entry, _conn, _startLabel, connected, stream, start) => {
    recordFailure(P)
    const reading = pendingLivenessReading(start)
    const { deps, deferred, connectionReads } = pendingDeps(reading, connected, stream, entry === 'the retry entry' ? 0 : FAST_DELAY_S)
    initRestart(deps)

    if (entry === 'the retry entry') {
      expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_PENDING_DEFERRED)
    } else {
      scheduleRestart(P, CWD)
      await Bun.sleep(WAIT_MS)
    }

    expect(deferred).toHaveLength(1)
    const [key, handed] = deferred[0]!
    expect(key).toBe(P)
    expect(handed.kind).toBe(LIVENESS_PENDING)
    expect(handed.launchStartedAt).toBe(start)
    expect(handed).toEqual(reading)
    expect(connectionReads).toEqual([])
    expectNothingDone(deps)
    expect(otherLines()).toEqual([])
  })

  // The launch start is read off the probe's reading raw; one that is not a
  // non-empty string is handed on as none.
  test.each<[string, unknown, string | undefined]>([
    ['a whole-second launch start → handed on raw', SAMPLE_LAUNCH_START_WHOLE, SAMPLE_LAUNCH_START_WHOLE],
    ['an empty launch start → handed on as none', '', undefined],
    ['a launch start that is not a string → handed on as none', 42, undefined],
  ])('the probe\'s pending reading carries %s', async (_label, raw, handedStart) => {
    recordFailure(P)
    const reading = { kind: LIVENESS_PENDING, launchStartedAt: raw } as unknown as LivenessReading
    const { deps, deferred } = pendingDeps(reading, true, true)
    initRestart(deps)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_PENDING_DEFERRED)

    expect(deferred).toEqual([[P, pendingLivenessReading(handedStart)]])
    expect(deferred[0]![1].launchStartedAt).toBe(handedStart)
    if (handedStart === undefined) expect(deferred[0]![1]).toEqual(LIVENESS_READING_PENDING)
    expectNothingDone(deps)
  })

  test.each(CONNECTIONS)('a deferral that throws, P %s → one redacted line; still no reconnect, kill or launch, nothing counted or armed; pending-deferred', async (_conn, connected, stream) => {
    recordFailure(P)
    const { deps, deferred, connectionReads } = pendingDeps(pendingLivenessReading(SAMPLE_LAUNCH_START_FRACTIONAL), connected, stream)
    deps.deferPendingRow = (key, r) => {
      deferred.push([key, r])
      throw Object.assign(new Error(`defer refused (${sentinelInMessage('defer')})`), { note: LEAK_SENTINEL })
    }
    initRestart(deps)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_PENDING_DEFERRED)

    expect(deferred).toHaveLength(1)
    expect(connectionReads).toEqual([])
    expectNothingDone(deps)
    const failed = errLines.filter((l) => l.startsWith(DEFER_FAILED))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toStartWith(`${DEFER_FAILED}: Error message="defer refused (${REDACTED_SENTINEL_TAIL})" at `)
    expect(otherLines()).toEqual([])
    assertNoLeak({ errArgs })
  })

  test.each(CONNECTIONS)('no deferral member, P %s → nothing called or logged; still no reconnect, kill or launch, nothing counted or armed; pending-deferred', async (_conn, connected, stream) => {
    recordFailure(P)
    const { deps, connectionReads } = pendingDeps(pendingLivenessReading(SAMPLE_LAUNCH_START_FRACTIONAL), connected, stream)
    delete deps.deferPendingRow
    initRestart(deps)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(RESTART_OUTCOME_PENDING_DEFERRED)

    expect(connectionReads).toEqual([])
    expectNothingDone(deps)
    expect(errLines).toEqual([])
  })

  // `live` and `dead` never reach the deferral: a connected `live` row with
  // its stream is still already-connected, another `live` row is reconnected,
  // and a `dead` one is killed and launched and counted, as before.
  test.each<[string, LivenessReading, boolean, boolean, RestartRetryOutcome]>([
    ['live, connected with its stream → already-connected, no reconnect', LIVENESS_READING_LIVE, true, true, RESTART_OUTCOME_ALREADY_CONNECTED],
    ['live, connected but streamless → reconnected', LIVENESS_READING_LIVE, true, false, RESTART_OUTCOME_RECONNECTED],
    ['live, disconnected → reconnected', LIVENESS_READING_LIVE, false, true, RESTART_OUTCOME_RECONNECTED],
    ['dead → a kill and a launch, the failed launch counted', LIVENESS_READING_DEAD, false, true, RESTART_OUTCOME_COUNTED_FAILURE],
  ])('%s; the deferral is never called', async (_label, reading, connected, stream, outcome) => {
    recordFailure(P)
    const { deps, deferred } = pendingDeps(reading, connected, stream)
    deps.reconnectSession = async (key) => { deps.reconnectSessionCalls.push(key); return 'success' }
    initRestart(deps)

    expect(await runRestartRetry(P, CWD, notInFlight)).toBe(outcome)

    expect(deferred).toEqual([])
    const reconnected = outcome === RESTART_OUTCOME_RECONNECTED
    const launched = outcome === RESTART_OUTCOME_COUNTED_FAILURE
    expect(deps.reconnectSessionCalls).toEqual(reconnected ? [P] : [])
    expect(deps.killSessionCalls).toEqual(launched ? [P] : [])
    expect(deps.launchSessionCalls.map((c) => c.key)).toEqual(launched ? [P] : [])
    expect(getFailureCount(P)).toBe(reconnected ? 0 : launched ? 2 : 1)
    expect(deps.armRetryTimerCalls).toEqual([])
  })

  // Through the real liveness and reconnect adapters over the stub, with the
  // deferral bound as `main()` binds it: `status` answers `pending`, with or
  // without a launch start, under a key no configured persona uses (the
  // configured-persona query counts no key), so the row latches no one
  // (b.jg5 SRJ-408); a configured persona's own such row with no launch
  // start latches it instead (the SRJ-513 describe below). One `status` read
  // (the liveness probe's) and no other agent-director call: no send-keys,
  // kill, spawn or resume. One deferral line, naming the launch start when
  // there is one.
  describe('through the real adapters over the stub, under a key no configured persona uses', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'restart-pending-'))
      setConfiguredPersonaQuery(() => false)
    })

    afterEach(() => {
      resetClientForTests()
      _resetOutageState()
      _resetConfiguredPersonaQuery()
      rmSync(dir, { recursive: true, force: true })
    })

    const REAL_CASES = CONNECTIONS.flatMap(([conn, connected, stream]) =>
      LAUNCH_STARTS.map(([startLabel, start]) => [conn, startLabel, connected, stream, start] as const))

    test.each(REAL_CASES)('status answers pending, P %s, %s, its key one no configured persona uses → one status read and no other agent-director call; no kill or launch; nothing counted; one deferral line; pending-deferred', async (_conn, _startLabel, connected, stream, start) => {
      const config = makeMultiPersonaConfig([{ name: 'alpha_bot' }], dir)
      const KEY = config.personas[0]!.key
      const log = makeStubCallLog()
      const stub = makeStubClient({ ...log, statusResult: cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: start }) })
      _resetOutageState()
      initOutageState({ notify: () => {}, getClient: () => stub as unknown as Client })
      setClientForTests(stub as unknown as Client)

      recordFailure(KEY)
      const killSessionCalls: string[] = []
      const launchSessionCalls: string[] = []
      const armed: string[] = []
      const deferred: Array<[string, PendingLivenessReading]> = []
      initRestart({
        canRestart: () => true,
        isSessionAlive: _buildIsSessionAliveAdapter(() => config),
        isSessionConnected: () => connected,
        hasSessionStream: () => stream,
        reconnectSession: _buildReconnectSessionAdapter(),
        async killSession(key) { killSessionCalls.push(key); return KILL_SUCCEEDED },
        async launchSession(key) { launchSessionCalls.push(key); return false },
        getRestartDelay: () => 0,
        isShuttingDown: () => false,
        onCapReached: () => {},
        armRetryTimer: (key) => { armed.push(key) },
        // As main() binds it.
        deferPendingRow: (key, reading) => {
          deferred.push([key, reading])
          deferPendingRow(key, reading.launchStartedAt)
        },
      })

      expect(await runRestartRetry(KEY, config.personas[0]!.working_directory, notInFlight)).toBe(RESTART_OUTCOME_PENDING_DEFERRED)

      expect(log.statusCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(KEY)])
      expect(stubCallCount(log)).toBe(1)
      expect(deferred).toEqual([[KEY, pendingLivenessReading(start)]])
      expect(killSessionCalls).toEqual([])
      expect(launchSessionCalls).toEqual([])
      expect(armed).toEqual([])
      expect(getFailureCount(KEY)).toBe(1)
      expect(errLines).toHaveLength(1)
      expect(errLines[0]).toStartWith(`[slack] Deferring persona=${KEY}`)
      if (start !== undefined) expect(errLines[0]).toContain(start)
    })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-105 (AC 25, HO C3 Verify): the restart run's kill, reconnect and
// relaunch answered UNAVAILABLE. b.jg5 SRJ-110, SRJ-701: the kill's answer is
// its outcome, and only a success (`kill_sent` true, false or absent,
// `row-gone`, `row-finished`) or a guard's answer lets the launch follow; a
// CONFLICT or an UNUSABLE NAME ends the run with `RESTART_OUTCOME_LATCHED`,
// every other non-success, an answer that is not an outcome and a kill that
// throws with `RESTART_OUTCOME_REFUSED`: no launch, no success or failure
// recorded, no `onCapReached`. (That such a kill starts no
// `tmux-unresponsive` condition is server.test.ts's `_buildKillSessionAdapter`
// case.) Through the real adapters, each value of HO C2's non-success list at
// the kill launches, counts and deletes nothing, a success with any
// `kill_sent` launches once with no notice, and a CONFLICT is never sent
// again (AC 9). An UNAVAILABLE `send-keys` in the reconnect is never 'escalate-dead': no
// re-probe, no kill, no launch. An UNAVAILABLE relaunch is never counted.
// None of them posts a spawn-failure notice. b.jg5 SRJ-313 (AC 69): an
// UNCLASSIFIED answer (an `ErrInternal`, a name CSCB gives no handling) at
// the kill, the reconnect's `send-keys` or the relaunch is the same refusal,
// arms the timer with the UNCLASSIFIED cause and is never counted toward the
// cap. Only a kill answering `ErrSpawnNotFound` still goes on to the launch.
//
// The RestartDeps cases run on the file's `makeDeps` through the retry entry
// (`runRestartRetry`) with the delay at 0. The adapter cases run on
// `makeRecoveryHarness`: the real liveness, reconnect, kill and launch
// adapters over the stub, the retry timer and the episodes on its fake
// clock, no alert check (`alertThresholdMs: false`), and every captured line
// checked with `assertNoLeak`. P has `RESTART_FAILURE_CAP - 1` failures on
// record, so one counted failure would reach the cap.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-105, SRJ-313: an UNAVAILABLE or UNCLASSIFIED kill, send-keys or relaunch in the restart run launches nothing, counts nothing and posts no spawn-failure notice', () => {

  describe('RestartDeps.killSession\'s answer', () => {
    const P = 'persona_p'
    const CWD = '/cwd/p'
    let errLines: string[]
    let origConsoleError: typeof console.error

    beforeEach(() => {
      errLines = []
      origConsoleError = console.error
      console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }
    })

    afterEach(() => {
      console.error = origConsoleError
      cancelAllRestartTimers()
      assertNoLeak({ errLines })
    })

    /** A row of the kill's answers: its label, the answer, the work's outcome and the one line naming the answer. */
    type AnswerRow = readonly [label: string, answer: () => Promise<KillSessionResult>, outcome: RestartWorkOutcome, line: () => string]

    /** A success form (or the guard's answer): the launch follows, after the relaunch line naming it. */
    const goesOn = (label: string, answer: KillOutcome | typeof KILL_SESSION_NOT_KILLED_GUARD): AnswerRow =>
      [label, async () => answer, RESTART_OUTCOME_CAPPED, () => relaunchAfterKillLine(P, CWD, answer as Parameters<typeof relaunchAfterKillLine>[2])]

    /** A non-success outcome of what the kill threw: no launch, the work answers `outcome`. */
    const stops = (label: string, thrown: Error, outcome: RestartWorkOutcome): AnswerRow => {
      const answer = killOutcomeOf({ thrown })
      return [label, async () => answer, outcome, () => killNotSucceededLine(P, describeKillOutcome(answer), outcome === RESTART_OUTCOME_LATCHED)]
    }

    const KILL_THREW = new Error('the kill broke')

    /** Whether the stand-in kill of the latched-after-the-kill cases has returned. */
    let killed = false

    /** An `ErrInvalidFlags` non-success whose immediate version re-check decided that the server stops (b.jg5 SRJ-204, SRJ-205). */
    const STOPPING_KILL = { ...killOutcomeOf({ thrown: errInvalidFlags('kill') }), recheck: RECHECK_OUTCOME_STOP } as KillOutcome

    test.each<AnswerRow>([
      goesOn('b.jg5 SRJ-701, SRJ-703: answers killed with kill_sent true → the run goes on', { kind: KILL_OUTCOME_KILLED, killSent: true }),
      goesOn('b.jg5 SRJ-701, SRJ-703: answers killed with kill_sent false → the run goes on', { kind: KILL_OUTCOME_KILLED, killSent: false }),
      goesOn('b.jg5 SRJ-701, SRJ-703: answers killed with no kill_sent → the run goes on', { kind: KILL_OUTCOME_KILLED }),
      goesOn('b.jg5 SRJ-701: answers row-gone (ErrSpawnNotFound) → the run goes on', { kind: KILL_OUTCOME_ROW_GONE }),
      goesOn('b.jg5 SRJ-701: answers row-finished → the run goes on', { kind: KILL_OUTCOME_ROW_FINISHED, read: KILL_ROW_FINISHED_ENDED }),
      goesOn('b.jg5 SRJ-104, SRJ-110: answers session-gone (GONE: for kill, gone is success) → the run goes on', killOutcomeOf({ thrown: errTmuxSendKeys() })),
      goesOn('b.jg5 SRJ-110: answers the guard result (no call made) → the run goes on as before', KILL_SESSION_NOT_KILLED_GUARD),
      stops('b.jg5 SRJ-110: answers UNAVAILABLE (ErrTmuxKillFailed) → refused', errTmuxKillFailed(), RESTART_OUTCOME_REFUSED),
      stops('b.jg5 SRJ-110: answers ENVIRONMENT → refused', errTmuxNotAvailable(undefined, 'kill'), RESTART_OUTCOME_REFUSED),
      stops('b.jg5 SRJ-110: answers CONFIG → refused', errConfigMalformed(), RESTART_OUTCOME_REFUSED),
      stops('b.jg5 SRJ-110: answers UNCLASSIFIED (ErrSystemInstallDisappeared) → refused', errSystemInstallDisappeared('kill'), RESTART_OUTCOME_REFUSED),
      stops('b.jg5 SRJ-110, SRJ-501: answers CONFLICT → latched', errTmuxSessionConflict('kill', 'not-this-launch'), RESTART_OUTCOME_LATCHED),
      stops('b.jg5 SRJ-110, SRJ-512: answers UNUSABLE NAME → latched', errUnusableName(), RESTART_OUTCOME_LATCHED),
      stops('b.jg5 SRJ-110, SRJ-313: answers a class the kill has no row for (ErrInstanceIdCollision, UNCLASSIFIED) → refused', errInstanceIdCollision(), RESTART_OUTCOME_REFUSED),
      stops('b.jg5 SRJ-104, SRJ-204: answers ErrInvalidFlags whose re-check did not stop (UNCLASSIFIED) → refused', errInvalidFlags('kill'), RESTART_OUTCOME_REFUSED),
      [
        'b.jg5 SRJ-104, SRJ-205: answers ErrInvalidFlags whose re-check decided that the server stops → shutting-down, nothing more called',
        async () => STOPPING_KILL,
        RESTART_OUTCOME_SHUTTING_DOWN,
        () => killStopsServerLine(P, describeKillOutcome(STOPPING_KILL)),
      ],
      [
        'b.jg5 SRJ-701: resolves nothing (no kill outcome) → refused (no longer goes on)',
        async () => undefined as unknown as KillSessionResult,
        RESTART_OUTCOME_REFUSED,
        () => killNotSucceededLine(P, 'killSession answered no kill outcome', false),
      ],
      [
        'b.jg5 SRJ-701: throws → refused (no longer goes on)',
        async () => { throw KILL_THREW },
        RESTART_OUTCOME_REFUSED,
        () => killNotSucceededLine(P, `killSession threw: ${describeThrownValue(KILL_THREW)}`, false),
      ],
    ])('a kill after a dead reading that %s: to the launch (a failed launch counted and capped) or not (nothing counted)', async (_label, killSession, outcome, line) => {
      for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(P)
      const deps = makeDeps({ restartDelay: 0, killSession, launchSessionResult: false })
      initRestart(deps)

      expect(await runRestartRetry(P, CWD, () => false)).toBe(outcome)

      const launched = outcome === RESTART_OUTCOME_CAPPED
      expect(deps.isSessionAliveCalls).toEqual([P])
      expect(deps.killSessionCalls).toEqual([P])
      expect(deps.launchSessionCalls.map((c) => c.key)).toEqual(launched ? [P] : [])
      expect(getFailureCount(P)).toBe(launched ? RESTART_FAILURE_CAP : RESTART_FAILURE_CAP - 1)
      expect(deps.onCapReachedCalls).toEqual(launched ? [P] : [])
      expect(deps.armRetryTimerCalls).toEqual([])
      expect(errLines.filter((l) => l === line())).toHaveLength(1)
      // Exactly one of the two kill lines: the relaunch line or the not-succeeded line.
      expect(errLines.filter((l) => l.startsWith(killNotSucceededHead(P)))).toHaveLength(launched ? 0 : 1)
    })

    // b.jg5 SRJ-702, SRJ-502: a kill whose tries were stopped because P
    // latched meanwhile (a `status` read between them latched it, or a latch
    // set elsewhere while the kill ran) answers its last non-success; the
    // work then asks the latched query again and answers latched, with no
    // launch and nothing counted. A query that throws counts as latched.
    test.each<[string, () => boolean]>([
      ['the latched query answering true once the kill has returned', () => killed],
      ['the latched query throwing once the kill has returned', () => { if (killed) throw new Error('query failed'); return false }],
    ])('b.jg5 SRJ-702, SRJ-502: a non-success kill (UNAVAILABLE) after which P is latched, %s → latched: no launch, nothing counted', async (_label, isLatched) => {
      killed = false
      for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(P)
      const answer = killOutcomeOf({ thrown: errTmuxUnresponsive('kill') })
      const deps = makeDeps({
        restartDelay: 0,
        killSession: async () => {
          killed = true
          return answer
        },
      })
      initRestart({ ...deps, isLatched })

      expect(await runRestartRetry(P, CWD, () => false)).toBe(RESTART_OUTCOME_LATCHED)

      expect(deps.killSessionCalls).toEqual([P])
      expect(deps.launchSessionCalls).toEqual([])
      expect(getFailureCount(P)).toBe(RESTART_FAILURE_CAP - 1)
      expect(deps.onCapReachedCalls).toEqual([])
      expect(errLines.filter((l) => l === killNotSucceededLine(P, describeKillOutcome(answer), true))).toHaveLength(1)
    })

    // b.jg5 SRJ-501: the kill is handed the run's last `dead` reading, which
    // carries the row state the run read (or none), so a latch it sets
    // records the state the path last read.
    test.each<[string, DeadLivenessReading]>([
      ['ended', LIVENESS_READING_DEAD_ENDED],
      ['missing', LIVENESS_READING_DEAD_MISSING],
      ['no row (ErrSpawnNotFound)', LIVENESS_READING_DEAD_NO_ROW],
      ['the install-gone source (no row read)', LIVENESS_READING_DEAD_INSTALL_GONE],
      ['no status call (no row read)', LIVENESS_READING_DEAD],
    ])('b.jg5 SRJ-501: a dead reading of %s → killSession is handed that reading', async (_label, reading) => {
      const deps = makeDeps({ restartDelay: 0, isSessionAliveResult: reading })
      initRestart(deps)

      await runRestartRetry(P, CWD, () => false)

      expect(deps.killSessionCalls).toEqual([P])
      expect(deps.killSessionReads).toEqual([reading])
    })

    test('b.jg5 SRJ-501, b.d61: after an escalate-dead reconnect, the kill is handed the re-probe\'s dead reading, not the first one', async () => {
      const readings: LivenessReading[] = [LIVENESS_READING_LIVE, LIVENESS_READING_DEAD_MISSING]
      const deps = makeDeps({ restartDelay: 0 })
      deps.isSessionAlive = async (key) => {
        deps.isSessionAliveCalls.push(key)
        return readings.shift() ?? LIVENESS_READING_UNKNOWN
      }
      deps.reconnectSession = async (key) => {
        deps.reconnectSessionCalls.push(key)
        return ESCALATE_DEAD_WORKING_GONE
      }
      initRestart(deps)

      await runRestartRetry(P, CWD, () => false)

      expect(deps.isSessionAliveCalls).toEqual([P, P])
      expect(deps.killSessionReads).toEqual([LIVENESS_READING_DEAD_MISSING])
    })
  })

  describe('through the real adapters over the stub, on the recovery harness', () => {
    let harness: RecoveryHarness | undefined

    afterEach(() => {
      const h = harness
      harness = undefined
      if (h === undefined) return
      assertNoLeak(h.captured())
      h.cleanup()
      expect(h.clock.pendingCount()).toBe(0)
    })

    /** A harness with no alert check; P first, its failure count one short of the cap. */
    function build(): { h: RecoveryHarness; p: string; cwd: string } {
      const h = (harness = makeRecoveryHarness({ alertThresholdMs: false }))
      const p = h.keys[0]!
      for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(p)
      return { h, p, cwd: h.config.personas[0]!.working_directory }
    }

    /** Nothing counted for `key`, no cap notice, no spawn-failure notice and no startup-errors entry. */
    function expectNothingCounted(h: RecoveryHarness, key: string): void {
      expect(getFailureCount(key)).toBe(RESTART_FAILURE_CAP - 1)
      expect(h.capReached).toEqual([])
      expect(h.notices).toEqual([])
      expect(h.startupErrors()).toEqual([])
      expect(h.outageNotices).toEqual([])
    }

    /**
     * The refusing answers, each built for the verb that meets it, and the
     * cause each arms: E4's UNAVAILABLE forms of agent-director's own errors,
     * then the UNCLASSIFIED ones (b.jg5 SRJ-104, SRJ-313, AC 69).
     */
    const REFUSING_ANSWERS: ReadonlyArray<UnavailableForm> = [
      ...unavailableForms('ErrUnknownErrorName', 'ErrCallTimeout', 'a wrapped UnknownError', 'ErrTmuxUnresponsive', 'ErrTmuxKillFailed'),
      ['ErrInternal (UNCLASSIFIED)', () => errInternal(), UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED],
      ['an AgentDirectorError of a name CSCB gives no handling (UNCLASSIFIED)', (verb) => errGeneric(verb, 'ErrSomethingElse', 'it broke'), UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED],
    ]

    // b.jg5 SRJ-110, SRJ-313 (AC 69 for the UNCLASSIFIED rows; HO C2 Verify,
    // AC 24's restart-path half, for these classes): the kill's refusal is the
    // adapter's, so no step follows it (no launch, spawn, resume or delete:
    // the exact call counts) and nothing is counted (P's failure count one
    // short of the cap stays, with no recordFailure, recordSuccess or cap).
    // b.jg5 SRJ-704: of these, only an ErrTmuxKillFailed raises the ordinary
    // kill-failure alert at P's destination (each description: the alert
    // describe below); every other answer posts nothing.
    test.each(REFUSING_ANSWERS)('the kill after a dead reading answers %s → refused: no launch, spawn, resume or delete; no recordFailure, recordSuccess or onCapReached; nothing latched; nothing posted but an ErrTmuxKillFailed\'s kill-failure alert; the timer is armed (cause %s)', async (_label, make, cause) => {
      const { h, p, cwd } = build()
      rowReadsUntilSpawn(h, 'ended')
      const err = make('kill')
      h.script({ killError: err })

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
      await h.settle()

      expect(callCounts(h)).toEqual({ statusCalls: 1, killCalls: 1 })
      expect(h.latch.isLatched(p)).toBe(false)
      expect(h.stub.calls.killCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(p)])
      expect(h.stub.spawnedIds()).toEqual([])
      expect(h.errors).toContain(KILL_REFUSED_LINE(p, killOutcomeOf({ thrown: err })))
      expect(h.triggers).toEqual([{ key: p, kind: cause }])
      expectNothingCounted(h, p)
      expect(h.episodeNotices).toEqual(cause === UNAVAILABLE_RETRY_CAUSE_KILL_FAILED ? [killFailureNotice(p, ordinaryAlertContent(p, { last: err }))] : [])
    })

    // b.jg5 SRJ-702 (reconcile note): the restart path kills only after a
    // `dead` reading, so its kill is one try of the bounded retry: an
    // UNAVAILABLE outcome stands at once, a later answer is never reached, no
    // `status` read is made between tries and no wait is asked of the clock
    // (the only timer is the retry timer the refusal armed, once).
    test.each<[string, () => Error, string]>([
      ['ErrTmuxUnresponsive', () => errTmuxUnresponsive('kill'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      ['a survivor-naming ErrTmuxKillFailed', () => errTmuxKillFailed(undefined, 'pane-process-survived'), UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
    ])('b.jg5 SRJ-702: the kill after a dead reading answers %s with a success queued behind it → one kill, refused: no launch, no read between tries, no wait; the timer armed once; only the ErrTmuxKillFailed posts its ordinary alert, quoting it', async (_label, make, cause) => {
      const { h, p, cwd } = build()
      rowReadsUntilSpawn(h, 'ended')
      const err = make()
      h.script({ killQueue: [cannedErr(err), cannedOk(cannedKillResult(true))] })

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)

      expect(callCounts(h)).toEqual({ statusCalls: 1, killCalls: 1 })
      expect(h.stub.spawnedIds()).toEqual([])
      expect(h.triggers).toEqual([{ key: p, kind: cause }])
      expect(h.clock.pendingCount()).toBe(1)
      expect(h.controller.isArmed(p)).toBe(true)
      expectNothingCounted(h, p)
      // b.jg5 SRJ-702, SRJ-704: one try, so a survivor-naming ErrTmuxKillFailed
      // is the standing outcome and the ordinary version quotes it alone.
      expect(h.episodeNotices).toEqual(cause === UNAVAILABLE_RETRY_CAUSE_KILL_FAILED ? [killFailureNotice(p, ordinaryAlertContent(p, { last: err }))] : [])
    })

    test('the kill after a dead reading answers ErrSpawnNotFound (regression) → the run still launches P; no refusal', async () => {
      const { h, p, cwd } = build()
      rowReadsUntilSpawn(h, 'ended')
      h.script({ killError: errSpawnNotFound() })

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_LAUNCHED)
      await h.settle()

      expect(h.stub.calls.killCalls).toHaveLength(1)
      expect(h.stub.spawnedIds()).toEqual([personaInstanceId(p)])
      expect(getFailureCount(p)).toBe(0)
      expect(h.errors.filter((l) => l.startsWith(killNotSucceededHead(p)))).toEqual([])
      expect(h.triggers).toEqual([])
      expect(h.notices).toEqual([])
    })

    // b.jg5 SRJ-110 at the restart path (HO C2 Verify; AC 24's restart-path
    // half): after a `dead` reading, a kill answering each value of HO C2's
    // non-success list, the unusable-name value or `ErrConfigMalformed`
    // launches nothing, records no success or failure, reaches no cap and
    // deletes nothing; the outcome is `refused` for UNAVAILABLE, ENVIRONMENT,
    // CONFIG and UNCLASSIFIED and `latched` for CONFLICT and UNUSABLE NAME.
    // P's failure count starts one short of the cap, so a recordFailure would
    // cap it and a recordSuccess would reset it. The UNAVAILABLE values and
    // `ErrInternal` are `REFUSING_ANSWERS`' rows above.
    test.each<[string, () => Error, RestartWorkOutcome]>([
      ...RESTART_KILL_CONFLICT_CASE_ROWS.map((row): [string, () => Error, RestartWorkOutcome] => [`ErrTmuxSessionConflict (${row.name})`, row.build, RESTART_OUTCOME_LATCHED]),
      ['ErrTmuxNotAvailable', () => errTmuxNotAvailable(undefined, 'kill'), RESTART_OUTCOME_REFUSED],
      ...RESTART_KILL_UNUSABLE_NAME_CASE_ROWS.map((row): [string, () => Error, RestartWorkOutcome] => [`UNUSABLE NAME (${row.name})`, row.build, RESTART_OUTCOME_LATCHED]),
      ['ErrConfigMalformed', () => errConfigMalformed(), RESTART_OUTCOME_REFUSED],
      ['ErrSystemInstallDisappeared (UNCLASSIFIED)', () => errSystemInstallDisappeared('kill'), RESTART_OUTCOME_REFUSED],
    ])('b.jg5 SRJ-110: the kill after a dead reading answers %s → %s: no launch, spawn, resume or delete; no recordFailure, recordSuccess or cap; no spawn-failure notice', async (_label, make, outcome) => {
      const { h, p, cwd } = build()
      rowReadsUntilSpawn(h, 'ended')
      h.script({ killError: make() })

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(outcome)
      await h.settle()

      expect(h.stub.calls.killCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(p)])
      expect(h.stub.calls.spawnCalls).toEqual([])
      expect(h.stub.calls.resumeCalls).toEqual([])
      expect(h.stub.calls.deleteCalls).toEqual([])
      expect(getFailureCount(p)).toBe(RESTART_FAILURE_CAP - 1)
      expect(h.capReached).toEqual([])
      expect(h.notices).toEqual([])
      expect(h.startupErrors()).toEqual([])
      expect(h.latch.isLatched(p)).toBe(outcome === RESTART_OUTCOME_LATCHED)
    })

    // b.jg5 SRJ-104, SRJ-110: for `kill`, gone is success. A GONE answer at
    // the restart path's kill lets the relaunch run once, rendered
    // session-gone; nothing is armed, counted or posted.
    test.each([
      ['ErrTmuxSendKeys', () => errTmuxSendKeys()],
      ['ErrTmuxCaptureFailed', () => errTmuxCaptureFailed(undefined, 'kill')],
    ] as const)('b.jg5 SRJ-104, SRJ-110: the kill after a dead reading answers GONE (%s) → the session-gone success: P is relaunched once; nothing armed, counted or posted', async (_label, make) => {
      const { h, p, cwd } = build()
      rowReadsUntilSpawn(h, 'ended')
      const err = make()
      h.script({ killError: err })

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_LAUNCHED)
      await h.settle()

      expect(h.stub.calls.killCalls).toHaveLength(1)
      expect(h.stub.spawnedIds()).toEqual([personaInstanceId(p)])
      expect(h.errors).toContain(relaunchAfterKillLine(p, cwd, { kind: KILL_OUTCOME_SESSION_GONE, name: err.errName }))
      expect(h.errors.filter((l) => l.startsWith(killNotSucceededHead(p)))).toEqual([])
      expect(h.triggers).toEqual([])
      expect(h.unclassifiedErrorOpen(p)).toBe(false)
      expect(getFailureCount(p)).toBe(0)
      expect(h.notices).toEqual([])
      expect(h.capReached).toEqual([])
    })

    // b.jg5 SRJ-110, SRJ-105, SRJ-313: a class the kill has no row for (a
    // STATE name other than ErrSpawnNotFound, LAUNCH FAILURE) is UNCLASSIFIED
    // inside the restart run's attempt: refused, never counted; P's retry timer
    // armed with the UNCLASSIFIED cause and its unclassified-error episode fed;
    // no delete, spawn, resume or launch.
    test.each([
      ['ErrInstanceIdCollision (STATE)', () => errInstanceIdCollision()],
      ['ErrSpawnNotResumable (STATE)', () => errSpawnNotResumable()],
      ['ErrTmuxSessionCreate (LAUNCH FAILURE)', () => errTmuxSessionCreate('kill')],
    ] as const)('b.jg5 SRJ-110, SRJ-313: the kill after a dead reading answers a class it has no row for, %s → refused: nothing counted, no cap; the timer armed with the UNCLASSIFIED cause; the unclassified episode fed; no delete, spawn, resume or launch', async (_label, make) => {
      const { h, p, cwd } = build()
      rowReadsUntilSpawn(h, 'ended')
      h.script({ killError: make() })

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
      await h.settle()

      expect(callCounts(h)).toEqual({ statusCalls: 1, killCalls: 1 })
      expect(h.stub.spawnedIds()).toEqual([])
      expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED }])
      expect(h.unclassifiedErrorOpen(p)).toBe(true)
      expect(h.latch.isLatched(p)).toBe(false)
      expectNothingCounted(h, p)
    })

    // b.jg5 SRJ-104, SRJ-204, SRJ-205: an ErrInvalidFlags at the restart
    // path's kill gets exactly one immediate version re-check. A pass leaves it
    // UNCLASSIFIED (refused, the timer armed, the episode fed); a stop ends the
    // work with shutting-down and nothing more called, armed or recorded.
    describe('an ErrInvalidFlags at the restart path\'s kill', () => {
      let resolveCalls: Array<object | undefined>
      let stops: number[]

      function installRecheck(outcome: StubResolveSystemBinaryOutcome): void {
        resetAdVersionRecheckForTests()
        installAdVersionRecheck({
          resolveSystemBinary: makeStubResolveSystemBinary({ calls: resolveCalls, outcomes: [outcome] }),
          baselineVersion: PHASE1_RC_VERSION,
          recordStartupError: () => {},
          stop: (exitCode) => { stops.push(exitCode) },
          log: () => {},
          clock: createFakeClock(),
        })
      }

      beforeEach(() => {
        resolveCalls = []
        stops = []
      })

      afterEach(() => {
        resetAdVersionRecheckForTests()
      })

      test('b.jg5 SRJ-104, SRJ-204: the re-check passes → exactly one re-check, no stop; refused (UNCLASSIFIED): nothing counted, the timer armed with the UNCLASSIFIED cause, the episode fed; no launch', async () => {
        installRecheck({ version: PHASE1_RC_VERSION })
        const { h, p, cwd } = build()
        rowReadsUntilSpawn(h, 'ended')
        h.script({ killError: errInvalidFlags('kill') })

        expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
        await h.settle()

        expect(resolveCalls).toHaveLength(1)
        expect(stops).toEqual([])
        expect(callCounts(h)).toEqual({ statusCalls: 1, killCalls: 1 })
        expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED }])
        expect(h.unclassifiedErrorOpen(p)).toBe(true)
        expect(h.errors.filter((l) => l.startsWith(killNotSucceededHead(p)) && l.includes(`recheck=${RECHECK_OUTCOME_PASS}`))).toHaveLength(1)
        expectNothingCounted(h, p)
      })

      test('b.jg5 SRJ-104, SRJ-205: the re-check decides that the server stops → exactly one re-check and one stop; shutting-down: nothing more called, armed, counted or posted; the episode not fed', async () => {
        installRecheck({ version: OLD_AD_VERSION })
        const { h, p, cwd } = build()
        rowReadsUntilSpawn(h, 'ended')
        const err = errInvalidFlags('kill')
        h.script({ killError: err })

        expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_SHUTTING_DOWN)
        await h.settle()

        expect(resolveCalls).toHaveLength(1)
        expect(stops).toHaveLength(1)
        expect(callCounts(h)).toEqual({ statusCalls: 1, killCalls: 1 })
        expect(h.triggers).toEqual([])
        expect(h.unclassifiedErrorOpen(p)).toBe(false)
        expect(h.latch.isLatched(p)).toBe(false)
        const stopLines = h.errors.filter((l) => l.startsWith(killNotSucceededHead(p)))
        expect(stopLines).toEqual([
          killStopsServerLine(p, describeKillOutcome({ ...killOutcomeOf({ thrown: err }), recheck: RECHECK_OUTCOME_STOP } as KillOutcome)),
        ])
        expectNothingCounted(h, p)
      })
    })

    // b.jg5 SRJ-701, SRJ-703 (HO rev 15): a success with any `kill_sent` lets
    // the relaunch run once; `kill_sent: false` (another store's session, or
    // one with no valid label, holding the name, is GONE for the row) raises
    // no notice of any kind by itself.
    test.each([
      ['true', true],
      ['false', false],
      ['absent', undefined],
    ] as const)('b.jg5 SRJ-701, SRJ-703: the kill after a dead reading succeeds with kill_sent %s → P is relaunched once; nothing counted, no notice posted', async (_label, killSent) => {
      const { h, p, cwd } = build()
      rowReadsUntilSpawn(h, 'ended')
      h.script({ killResult: cannedKillResult(killSent) })

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_LAUNCHED)
      await h.settle()

      expect(h.stub.calls.killCalls).toHaveLength(1)
      expect(h.stub.spawnedIds()).toEqual([personaInstanceId(p)])
      expect(h.errors).toContain(relaunchAfterKillLine(p, cwd, killSent === undefined ? { kind: KILL_OUTCOME_KILLED } : { kind: KILL_OUTCOME_KILLED, killSent }))
      expect(h.triggers).toEqual([])
      expect(h.notices).toEqual([])
      expect(h.episodeNotices).toEqual([])
      expect(h.outageNotices).toEqual([])
      expect(h.capReached).toEqual([])
    })

    // b.jg5 SRJ-110, SRJ-505 (AC 9): a CONFLICT at the restart path's kill
    // latches P and is never sent again: the run makes exactly one kill, and
    // the next run for the latched P makes no kill (no call at all).
    test('b.jg5 SRJ-110, SRJ-505 (AC 9): a CONFLICT at the kill → latched with exactly one kill; the next run for the latched P makes no kill', async () => {
      const { h, p, cwd } = build()
      rowReadsUntilSpawn(h, 'ended')
      const [row] = RESTART_KILL_CONFLICT_CASE_ROWS
      h.script({ killError: row!.build() })

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_LATCHED)
      expect(h.stub.calls.killCalls).toHaveLength(1)
      expect(h.latch.isLatched(p)).toBe(true)
      const before = callCounts(h)

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_LATCHED)
      await h.settle()

      expect(callCountsSince(callCounts(h), before)).toEqual({})
      expect(h.stub.calls.killCalls).toHaveLength(1)
      expect(h.stub.spawnedIds()).toEqual([])
    })

    // AC 69: retried, an UNCLASSIFIED relaunch is still never counted, so P
    // never reaches the cap on it; a later retry that launches clears nothing
    // it did not count.
    test('b.jg5 SRJ-313, AC 69: a relaunch that keeps answering ErrInternal across several retries never counts a failure or reaches the cap; once it succeeds P is launched with nothing counted', async () => {
      const { h, p, cwd } = build()
      rowReadsUntilSpawn(h, 'ended')
      h.script({ spawnError: errInternal() })

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
      for (let i = 0; i < RESTART_FAILURE_CAP + 1; i++) await retryNow(h, p)

      expect(h.attempts).toHaveLength(RESTART_FAILURE_CAP + 1)
      expect(h.stub.calls.spawnCalls).toHaveLength(RESTART_FAILURE_CAP + 2)
      expect(new Set(h.triggers.map((t) => t.kind))).toEqual(new Set([UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED]))
      expectNothingCounted(h, p)

      h.script({ spawnError: undefined })
      await retryNow(h, p)
      expect(h.stub.calls.spawnCalls).toHaveLength(RESTART_FAILURE_CAP + 3)
      expect(getFailureCount(p)).toBe(0)
      expect(h.capReached).toEqual([])
      expect(h.notices).toEqual([])
    })

    // b.jg5 SRJ-113, SRJ-313 (AC 69 for the UNCLASSIFIED rows): a refusing
    // `send-keys` in the reconnect is never 'escalate-dead'.
    test.each(REFUSING_ANSWERS)('the reconnect\'s send-keys on a live row answers %s → no escalate-dead, no re-probe, no sweep, no kill, no launch; nothing counted, no spawn-failure notice; the timer is armed (cause %s)', async (_label, make, cause) => {
      const { h, p, cwd } = build()
      h.script({ statusFn: () => cannedStatusResult({ state: 'waiting' }), sendKeysError: make('send-keys') })

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_RECONNECT_DEFERRED)

      // The liveness read and the reconnect adapter's own read: no re-probe,
      // no sweep, no kill, no spawn or resume.
      expect(h.stub.calls.statusCalls).toHaveLength(2)
      expect(h.stub.calls.sendKeysCalls).toHaveLength(1)
      expect(Object.keys(callCounts(h)).sort()).toEqual(['readPaneCalls', 'sendKeysCalls', 'statusCalls'])
      expect(h.errors.filter((l) => l.startsWith('[slack] escalate-dead'))).toEqual([])
      expect(h.triggers).toEqual([{ key: p, kind: cause }])
      expectNothingCounted(h, p)
      expect(h.episodeNotices).toEqual([])
    })

    // b.jg5 SRJ-111, SRJ-313 (AC 69 for the UNCLASSIFIED rows): a refusing
    // relaunch is never counted toward the cap and posts no spawn-failure
    // notice.
    test.each(REFUSING_ANSWERS)('the relaunch after a dead reading answers %s → refused: one spawn and nothing after it, no recordFailure, no onCapReached, no spawn-failure notice; the timer is armed (cause %s)', async (_label, make, cause) => {
      const { h, p, cwd } = build()
      rowReadsUntilSpawn(h, 'ended')
      h.script({ spawnError: make('spawn') })

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
      await h.settle()

      expect(h.stub.calls.killCalls).toHaveLength(1)
      expect(h.stub.calls.spawnCalls).toHaveLength(1)
      expect(h.stub.spawnedIds()).toEqual([personaInstanceId(p)])
      expect(h.stub.calls.resumeCalls).toEqual([])
      expect(h.stub.calls.deleteCalls).toEqual([])
      expect(h.triggers).toEqual([{ key: p, kind: cause }])
      expect(h.errors.filter((l) => l.startsWith(killNotSucceededHead(p)))).toEqual([])
      expectNothingCounted(h, p)
      expect(h.episodeNotices).toEqual([])
    })

    test('HO C3 Verify, AC 25: a relaunch that keeps answering ErrTmuxUnresponsive across several retries posts one onset for P and nothing more, and counts nothing', async () => {
      const { h, p, cwd } = build()
      rowReadsUntilSpawn(h, 'ended')
      h.script({ spawnError: errTmuxUnresponsive('spawn') })
      const firstAt = h.clock.now()

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
      // Retries until twice the onset floor has passed since the first refusal.
      while (h.clock.now() - firstAt < 2 * TMUX_UNRESPONSIVE_ONSET_FLOOR_MS) await retryNow(h, p)

      expect(h.attempts.length).toBeGreaterThan(2)
      expect(h.stub.calls.spawnCalls).toHaveLength(h.attempts.length + 1)
      expect(h.tmuxUnresponsive.holds(p)).toBe(true)
      expect(h.episodeNotices).toEqual([{ key: p, text: tmuxUnresponsiveOnsetText(p) }])
      expectNothingCounted(h, p)
    })

    test('HO C3 Verify, AC 25: a relaunch refused once that succeeds at the next retry posts nothing', async () => {
      const { h, p, cwd } = build()
      rowReadsUntilSpawn(h, 'ended')
      h.script({ spawnError: errTmuxUnresponsive('spawn') })

      expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
      expect(h.tmuxUnresponsive.holds(p)).toBe(true)
      h.script({ spawnError: undefined })
      await retryNow(h, p)

      expect(h.attempts).toHaveLength(1)
      expect(h.stub.calls.spawnCalls).toHaveLength(2)
      expect(h.tmuxUnresponsive.holds(p)).toBe(false)
      expect(getFailureCount(p)).toBe(0)
      expect(h.episodeNotices).toEqual([])
      expect(h.notices).toEqual([])
      expect(h.outageNotices).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-502 — the restart path holds back for a latched persona
//
// While P is latched, a scheduled restart or a human-triggered restart request
// arms no timer (its latched query is asked before every other gate, and one
// line says no restart was scheduled), and the one gate at the start of the
// restart work (before the liveness read) answers `RESTART_OUTCOME_LATCHED`
// for the UNAVAILABLE retry entry (before its in-flight and cap checks) and
// for a restart timer armed before P latched: nothing is probed, reconnected,
// killed or launched, nothing is counted, the cap state is left as it was and
// nothing is armed. A launch that latches P (a CONFLICT at its spawn, which
// the session manager answers as 'skipped') ends the run latched, counted
// nothing. No automated path's recorded calls then include a kill of P (AC
// 46). Another persona restarts as before. Every line is leak-checked.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-502: the restart path makes no attempt for a latched persona', () => {
  /**
   * A latched line's two parts: for a latched persona the line is
   * `head + tail`; for a latched query that threw, ` (the latched query
   * failed: … — taken as latched)` sits between them.
   */
  type LatchedLine = { head: string; tail: string }
  /** The restart work's line for a latched persona (its gates before the probe, after it, and before the kill). */
  const skipLine = (key: string): LatchedLine => ({
    head: `[slack] Skipping restart for persona=${key} — the persona is latched`,
    tail: '; no agent-director call, nothing recorded (b.jg5 SRJ-502)',
  })
  /** The restart work's line for a launch that answered skipped for a latched persona. */
  const atLaunchLine = (key: string): LatchedLine => ({
    head: `[slack] Session relaunch for persona=${key} ended latched`,
    tail: ' — not counted; nothing more is done for it',
  })
  /** scheduleRestart's line for a latched persona: no timer armed. */
  const notSchedulingLine = (key: string): LatchedLine => ({
    head: `[slack] Not scheduling restart for persona=${key} — the persona is latched`,
    tail: '; no timer armed (b.jg5 SRJ-502)',
  })
  const fullLine = (line: LatchedLine): string => `${line.head}${line.tail}`
  /** agent-director's CONFLICT (by name): the pre-spawn scan found a session left over from an earlier life. */
  const conflict = () => errTmuxSessionConflict('spawn', 'scan-leftover')

  describe('over the file\'s deps', () => {
    const P = 'persona_p'
    const Q = 'persona_q'
    const CWD: Record<string, string> = { [P]: '/cwd/p', [Q]: '/cwd/q' }
    let errLines: string[]
    let origConsoleError: typeof console.error
    let latch: ConflictLatch
    /** Each serialized work's outcome, in order. */
    let outcomes: Array<{ key: string; outcome: unknown }>

    beforeEach(() => {
      errLines = []
      outcomes = []
      origConsoleError = console.error
      console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }
      latch = createConflictLatch({ log: (line) => { errLines.push(line) } })
    })

    afterEach(() => {
      console.error = origConsoleError
      cancelAllRestartTimers()
      assertNoLeak({ errLines })
    })

    /** Latch `key` as a refused plain spawn latches it. */
    function latchPersona(key: string): void {
      latch.setFromConflict(key, conflict(), { refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN, rowState: latchRowStateRead('ended') })
    }

    /**
     * The file's deps over a dead row, P's launch failing (a counted one would
     * show in P's failure count) and Q's succeeding, with the latched query over
     * the case's latch and a serializer that records each work's outcome.
     */
    function latchedDeps(opts: DepsOpts = {}): ReturnType<typeof makeDeps> {
      const deps = makeDeps({ launchSession: async (key) => key !== P, ...opts })
      deps.isLatched = (key) => latch.isLatched(key)
      deps.serialize = async <T>(key: string, operation: () => T | Promise<T>): Promise<T> => {
        const outcome = await operation()
        outcomes.push({ key, outcome })
        return outcome
      }
      return deps
    }

    /** The two scheduleRestart entries: a scheduled restart and a human-triggered restart request. */
    const SCHEDULE_ENTRIES: Array<[string, { humanTrigger: true } | undefined]> = [
      ['a scheduled restart', undefined],
      ['a human-triggered restart request', { humanTrigger: true }],
    ]

    /**
     * Record, by key, each read of the delay setting, the shutdown flag and the
     * relaunch gate, the gates scheduleRestart asks after the latched query.
     */
    function recordGates(deps: ReturnType<typeof makeDeps>): string[] {
      const asked: string[] = []
      const [delay, shutdown, gate] = [deps.getRestartDelay, deps.isShuttingDown, deps.canRestart]
      deps.getRestartDelay = () => { asked.push('delay'); return delay() }
      deps.isShuttingDown = () => { asked.push('shutdown'); return shutdown() }
      deps.canRestart = (key) => { asked.push(`gate:${key}`); return gate(key) }
      return asked
    }

    // A latched query that throws counts as latched (fail safe): the same
    // gates answer latched with nothing more done or recorded, and the one
    // line names what it threw (redacted). The thrown error carries a fake
    // token in its message and the bare sentinel in a field CSCB never reads.
    const queryBroke = () => Object.assign(new Error(`latched query broke (${sentinelInMessage('latched')})`), { note: LEAK_SENTINEL })
    const THROWN_PREFIX = `(the latched query failed: Error message="latched query broke (${REDACTED_SENTINEL_TAIL})" at `
    /** P's latched query throws; Q's answers false. */
    const throwingForP = (key: string): boolean => {
      if (key === P) throw queryBroke()
      return false
    }

    type MakeLatched = (deps: ReturnType<typeof makeDeps>) => void
    type ExpectLatchedLine = (line: LatchedLine) => void
    /**
     * The two ways P counts as latched from the moment `makeLatched(deps)` is
     * called: P latched (as a refused plain spawn latches it), or P's latched
     * query starting to throw. `expectLine(line)` checks the one line of that
     * kind: exactly the latched line, or one naming what the query threw.
     */
    const LATCH_SOURCES: Array<[string, MakeLatched, ExpectLatchedLine]> = [
      ['P latched', () => latchPersona(P), (line) => {
        expect(errLines.filter((l) => l.startsWith(line.head))).toEqual([fullLine(line)])
      }],
      ['P\'s latched query throwing', (deps) => { deps.isLatched = throwingForP }, (line) => {
        const matching = errLines.filter((l) => l.startsWith(line.head))
        expect(matching).toHaveLength(1)
        expect(matching[0]).toStartWith(`${line.head} ${THROWN_PREFIX}`)
        expect(matching[0]).toEndWith(` — taken as latched)${line.tail}`)
      }],
    ]
    /** LATCH_SOURCES crossed with SCHEDULE_ENTRIES. */
    const LATCH_SOURCES_X_ENTRIES = LATCH_SOURCES.flatMap(([source, makeLatched, expectLine]) =>
      SCHEDULE_ENTRIES.map(([entry, opts]): [string, string, MakeLatched, ExpectLatchedLine, { humanTrigger: true } | undefined] => [source, entry, makeLatched, expectLine, opts]),
    )

    // P's one recorded failure keeps its backoff (20 ms) inside WAIT_MS.
    test.each(LATCH_SOURCES_X_ENTRIES)('%s: %s for P arms no timer: one not-scheduling line and nothing else for P, the delay, shutdown and relaunch gates never asked, no probe, reconnect, kill or launch, nothing counted, the cap state unchanged; Q beside it restarts as before', async (_source, _entry, makeLatched, expectLine, opts) => {
      recordFailure(P)
      const deps = latchedDeps()
      makeLatched(deps)
      const asked = recordGates(deps)
      initRestart(deps)
      const from = errLines.length

      scheduleRestart(P, CWD[P]!, undefined, opts)

      expect(isRestartPendingOrActive(P)).toBe(false)
      expect(asked).toEqual([])
      expect(errLines.slice(from)).toHaveLength(1)
      await Bun.sleep(WAIT_MS)

      scheduleRestart(Q, CWD[Q]!, undefined, opts)
      expect(isRestartPendingOrActive(Q)).toBe(true)
      await Bun.sleep(WAIT_MS)

      expect(outcomes).toEqual([{ key: Q, outcome: RESTART_OUTCOME_LAUNCHED }])
      expect(deps.isSessionAliveCalls).toEqual([Q])
      expect(deps.reconnectSessionCalls).toEqual([])
      expect(deps.killSessionCalls).toEqual([Q])
      expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([Q])
      expect(getFailureCount(P)).toBe(1)
      expect(getFailureCount(Q)).toBe(0)
      expect(deps.onCapReachedCalls).toEqual([])
      expect(deps.armRetryTimerCalls).toEqual([])
      expect(isRestartPendingOrActive(P)).toBe(false)
      expectLine(notSchedulingLine(P))
      // Since P counted as latched, the not-scheduling line is the only line naming P.
      expect(errLines.slice(from).filter((l) => l.includes(`persona=${P}`))).toHaveLength(1)
      expect(errLines.filter((l) => l.includes(`persona=${Q}`) && l.includes('latched'))).toEqual([])
    })

    test.each(LATCH_SOURCES)('%s: the UNAVAILABLE retry entry (runRestartRetry) for P answers latched: no probe, reconnect, kill or launch, nothing counted, the cap state unchanged, nothing armed, one skip line; Q beside it restarts as before', async (_source, makeLatched, expectLine) => {
      recordFailure(P)
      const deps = latchedDeps()
      makeLatched(deps)
      initRestart(deps)

      await runRestartRetry(P, CWD[P]!, () => false)
      await runRestartRetry(Q, CWD[Q]!, () => false)

      expect(outcomes).toEqual([{ key: P, outcome: RESTART_OUTCOME_LATCHED }, { key: Q, outcome: RESTART_OUTCOME_LAUNCHED }])
      expect(deps.isSessionAliveCalls).toEqual([Q])
      expect(deps.reconnectSessionCalls).toEqual([])
      expect(deps.killSessionCalls).toEqual([Q])
      expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([Q])
      expect(getFailureCount(P)).toBe(1)
      expect(getFailureCount(Q)).toBe(0)
      expect(deps.onCapReachedCalls).toEqual([])
      expect(deps.armRetryTimerCalls).toEqual([])
      expect(isRestartPendingOrActive(P)).toBe(false)
      expectLine(skipLine(P))
      expect(errLines.filter((l) => l.startsWith(`[slack] Not scheduling restart for persona=${P}`))).toEqual([])
      expect(errLines.filter((l) => l.includes(`persona=${Q}`) && l.includes('latched'))).toEqual([])
    })

    test.each(LATCH_SOURCES_X_ENTRIES)('%s only after %s for P was armed: it is left pending; a later request logs the not-scheduling line and leaves it as it is; when it fires its work answers latched with no probe, reconnect, kill or launch, nothing counted', async (_source, _entry, makeLatched, expectLine, opts) => {
      recordFailure(P)
      const deps = latchedDeps()
      initRestart(deps)

      scheduleRestart(P, CWD[P]!, undefined, opts)
      expect(isRestartPendingOrActive(P)).toBe(true)
      makeLatched(deps)
      const from = errLines.length
      scheduleRestart(P, CWD[P]!, undefined, opts)

      expect(errLines.slice(from)).toHaveLength(1)
      expect(isRestartPendingOrActive(P)).toBe(true)
      await Bun.sleep(WAIT_MS)

      expect(outcomes).toEqual([{ key: P, outcome: RESTART_OUTCOME_LATCHED }])
      expect(deps.isSessionAliveCalls).toEqual([])
      expect(deps.reconnectSessionCalls).toEqual([])
      expect(deps.killSessionCalls).toEqual([])
      expect(deps.launchSessionCalls).toEqual([])
      expect(getFailureCount(P)).toBe(1)
      expect(deps.onCapReachedCalls).toEqual([])
      expect(deps.armRetryTimerCalls).toEqual([])
      expect(isRestartPendingOrActive(P)).toBe(false)
      expect(errLines.filter((l) => l.startsWith('[slack] Scheduling restart for persona='))).toHaveLength(1)
      expectLine(notSchedulingLine(P))
      expectLine(skipLine(P))
    })

    test.each(LATCH_SOURCES)('%s: the retry entry for P, at the cap and with a launch in flight, answers latched first: the in-flight, shutdown and not-up checks are never asked, nothing is done, and the skip line is its only line', async (_source, makeLatched, expectLine) => {
      for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(P)
      const asked: string[] = []
      const deps = latchedDeps()
      makeLatched(deps)
      deps.isShuttingDown = () => { asked.push('shutdown'); return false }
      deps.canRestart = () => { asked.push('gate'); return true }
      initRestart(deps)
      const from = errLines.length

      const outcome = await runRestartRetry(P, CWD[P]!, () => { asked.push('in-flight'); return true })

      expect(outcome).toBe(RESTART_OUTCOME_LATCHED)
      expect(asked).toEqual([])
      expect(deps.isSessionAliveCalls).toEqual([])
      expect(deps.reconnectSessionCalls).toEqual([])
      expect(deps.killSessionCalls).toEqual([])
      expect(deps.launchSessionCalls).toEqual([])
      expect(getFailureCount(P)).toBe(RESTART_FAILURE_CAP)
      expect(deps.onCapReachedCalls).toEqual([])
      expect(deps.armRetryTimerCalls).toEqual([])
      expect(errLines.slice(from)).toHaveLength(1)
      expectLine(skipLine(P))
    })

    test.each(LATCH_SOURCES)('%s from P\'s launch on (a CONFLICT, answered as skipped): the run answers latched: one kill before the launch and nothing after it, nothing counted, no cap notice, no restart timer, one ended-latched line; a later retry or scheduled restart makes no attempt', async (_source, makeLatched, expectLine) => {
      recordFailure(P)
      const deps = latchedDeps({
        launchSession: async () => {
          makeLatched(deps)
          return 'skipped'
        },
      })
      initRestart(deps)

      expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_LATCHED)

      expect(deps.isSessionAliveCalls).toEqual([P])
      expect(deps.reconnectSessionCalls).toEqual([])
      expect(deps.killSessionCalls).toEqual([P])
      expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([P])
      expect(getFailureCount(P)).toBe(1)
      expect(deps.onCapReachedCalls).toEqual([])
      expect(deps.armRetryTimerCalls).toEqual([])
      expect(isRestartPendingOrActive(P)).toBe(false)
      expectLine(atLaunchLine(P))
      expect(errLines.filter((l) => l.startsWith('[slack] Skipping restart'))).toEqual([])
      expect(errLines.filter((l) => l.startsWith('[slack] Scheduling restart'))).toEqual([])

      // AC 46: no later automated attempt probes, kills or launches P; a
      // scheduled restart arms no timer at all.
      expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_LATCHED)
      scheduleRestart(P, CWD[P]!)
      expect(isRestartPendingOrActive(P)).toBe(false)
      await Bun.sleep(WAIT_MS)

      expect(outcomes.map((o) => o.outcome)).toEqual([RESTART_OUTCOME_LATCHED, RESTART_OUTCOME_LATCHED])
      expectLine(notSchedulingLine(P))
      expectLine(skipLine(P))
      expect(errLines.filter((l) => l.startsWith('[slack] Scheduling restart'))).toEqual([])
      expect(deps.isSessionAliveCalls).toEqual([P])
      expect(deps.killSessionCalls).toEqual([P])
      expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([P])
      expect(getFailureCount(P)).toBe(1)
    })

    test('a launch declined by its own gate (skipped) while P is not latched still answers launch-skipped, with the latched query present', async () => {
      recordFailure(P)
      const deps = latchedDeps({ launchSessionResult: 'skipped', launchSession: undefined })
      initRestart(deps)

      expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_LAUNCH_SKIPPED)

      expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([P])
      expect(getFailureCount(P)).toBe(1)
      expect(errLines.filter((l) => l.startsWith(atLaunchLine(P).head))).toEqual([])
    })

    // A launch outside the serializer can latch P while the work awaits
    // agent-director, so the latch is asked again after the liveness probe
    // and right before the kill: a persona latched by then is never
    // reconnected or killed, and nothing is armed or deferred for its reading.
    const PROBE_READINGS: Array<[string, LivenessReading]> = [
      ['dead', LIVENESS_READING_DEAD],
      ['live (P disconnected)', LIVENESS_READING_LIVE],
      ['unknown', LIVENESS_READING_UNKNOWN],
      ['pending', LIVENESS_READING_PENDING],
    ]
    const LATCH_SOURCES_X_READINGS = LATCH_SOURCES.flatMap(([source, makeLatched, expectLine]) =>
      PROBE_READINGS.map(([label, reading]): [string, string, MakeLatched, ExpectLatchedLine, LivenessReading] => [source, label, makeLatched, expectLine, reading]),
    )

    test.each(LATCH_SOURCES_X_READINGS)('%s from during the liveness probe, which reads %s: the work answers latched with no reconnect, kill or launch, nothing armed or deferred, nothing counted, and the skip line its only line for P', async (_source, _reading, makeLatched, expectLine, reading) => {
      recordFailure(P)
      const deferred: string[] = []
      const deps = latchedDeps()
      deps.isSessionAlive = async (key) => {
        deps.isSessionAliveCalls.push(key)
        makeLatched(deps)
        return reading
      }
      deps.deferPendingRow = (key) => { deferred.push(key) }
      initRestart(deps)
      const from = errLines.length

      expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_LATCHED)

      expect(deps.isSessionAliveCalls).toEqual([P])
      expect(deps.reconnectSessionCalls).toEqual([])
      expect(deps.killSessionCalls).toEqual([])
      expect(deps.launchSessionCalls).toEqual([])
      expect(deps.armRetryTimerCalls).toEqual([])
      expect(deferred).toEqual([])
      expect(getFailureCount(P)).toBe(1)
      expect(deps.onCapReachedCalls).toEqual([])
      expect(isRestartPendingOrActive(P)).toBe(false)
      expectLine(skipLine(P))
      // The latch's own line aside, the skip line is the only line naming P.
      expect(errLines.slice(from).filter((l) => l.includes(`persona=${P}`) && !l.startsWith('[slack] conflict-latch:'))).toHaveLength(1)
    })

    const LATCH_SOURCES_X_ESCALATE = LATCH_SOURCES.flatMap(([source, makeLatched, expectLine]) =>
      (['reconnect', 're-probe'] as const).map((during): [string, string, MakeLatched, ExpectLatchedLine] => [source, during, makeLatched, expectLine]),
    )

    // Latched during the reconnect (its findMissing sweep's post-run `get` can
    // latch P, b.jg5 SRJ-120): no re-probe follows. Latched during the
    // re-probe (which would read dead): no kill follows.
    test.each(LATCH_SOURCES_X_ESCALATE)('%s from during the escalate-dead path\'s %s: the work answers latched with no re-probe after a latching reconnect, no kill or launch, nothing counted, nothing armed, one skip line', async (_source, during, makeLatched, expectLine) => {
      recordFailure(P)
      const deps = latchedDeps()
      const readings = [LIVENESS_READING_LIVE, LIVENESS_READING_DEAD]
      deps.isSessionAlive = async (key) => {
        deps.isSessionAliveCalls.push(key)
        if (during === 're-probe' && readings.length === 1) makeLatched(deps)
        return readings.shift()!
      }
      deps.reconnectSession = async (key) => {
        deps.reconnectSessionCalls.push(key)
        if (during === 'reconnect') makeLatched(deps)
        return ESCALATE_DEAD_WORKING_GONE
      }
      initRestart(deps)

      expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_LATCHED)

      expect(deps.isSessionAliveCalls).toEqual(during === 'reconnect' ? [P] : [P, P])
      expect(deps.reconnectSessionCalls).toEqual([P])
      expect(deps.killSessionCalls).toEqual([])
      expect(deps.launchSessionCalls).toEqual([])
      expect(getFailureCount(P)).toBe(1)
      expect(deps.onCapReachedCalls).toEqual([])
      expect(deps.armRetryTimerCalls).toEqual([])
      expect(isRestartPendingOrActive(P)).toBe(false)
      expectLine(skipLine(P))
      expect(errLines.filter((l) => l.startsWith(`[slack] Relaunching session for persona=${P}`))).toEqual([])
    })

    // A success resets the failure count and a counted failure raises it, so
    // Q's one failure on record shows which was recorded: none for a latched
    // persona (above), a success here.
    const UNLATCHED_ESCALATE: Array<[string, (deps: ReturnType<typeof makeDeps>) => void]> = [
      ['with the latched query present, answering false for Q', () => {}],
      ['with a hand-built RestartDeps that has no latched query', (deps) => {
        delete deps.isLatched
      }],
    ]

    test.each(UNLATCHED_ESCALATE)('an unlatched persona on the escalate-dead path, %s: the reconnect, the re-probe that reads dead, one kill and one launch, launched, a success recorded', async (_label, setLatchQuery) => {
      recordFailure(Q)
      const deps = latchedDeps()
      setLatchQuery(deps)
      const readings = [LIVENESS_READING_LIVE, LIVENESS_READING_DEAD]
      deps.isSessionAlive = async (key) => {
        deps.isSessionAliveCalls.push(key)
        return readings.shift()!
      }
      deps.reconnectSession = async (key) => {
        deps.reconnectSessionCalls.push(key)
        return ESCALATE_DEAD_WORKING_GONE
      }
      initRestart(deps)

      expect(await runRestartRetry(Q, CWD[Q]!, () => false)).toBe(RESTART_OUTCOME_LAUNCHED)

      expect(deps.isSessionAliveCalls).toEqual([Q, Q])
      expect(deps.reconnectSessionCalls).toEqual([Q])
      expect(deps.killSessionCalls).toEqual([Q])
      expect(deps.launchSessionCalls.map((c) => c.key)).toEqual([Q])
      expect(getFailureCount(Q)).toBe(0)
      expect(deps.armRetryTimerCalls).toEqual([])
      expect(errLines.filter((l) => l.includes(`persona=${Q}`) && l.includes('latched'))).toEqual([])
    })
  })

  describe('through the real adapters over the stub, on the recovery harness', () => {
    let harness: RecoveryHarness | undefined

    afterEach(() => {
      const h = harness
      harness = undefined
      if (h === undefined) return
      try {
        assertNoLeak(h.captured())
      } finally {
        h.cleanup()
      }
      expect(h.clock.pendingCount()).toBe(0)
    })

    test('a relaunch whose spawn answers a CONFLICT latches P (a plain spawn, the row as read then), counts nothing, posts no spawn-failure notice and arms or schedules nothing; no later restart reaches agent-director for P, while Q restarts as before', async () => {
      const h = (harness = makeRecoveryHarness({ alertThresholdMs: false }))
      const [p, q] = [h.keys[0]!, h.keys[1]!]
      const cwdOf = (key: string): string => h.config.personas.find((persona) => persona.key === key)!.working_directory
      for (let i = 0; i < RESTART_FAILURE_CAP - 1; i++) recordFailure(p)
      rowReadsUntilSpawn(h, 'ended')
      h.script({ spawnError: conflict() })

      expect(await runRestartRetry(p, cwdOf(p), isLaunchInFlight)).toBe(RESTART_OUTCOME_LATCHED)
      await h.settle()

      const record = h.latch.record(p)
      expect(record).toMatchObject({
        latchCase: LATCH_CASE_LEFTOVER,
        refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN,
        rowState: latchRowStateRead('ended'),
      })
      // The harness's latch, wired as main() wires it: the set, then the three holds, then the one CONFLICT post.
      expect(h.latchEvents.map((event) => (event.step === 'hold' ? [event.step, event.key, event.hold] : [event.step, event.key]))).toEqual([
        ['set', p],
        ['hold', p, 'retry timer stop'],
        ['hold', p, 'tmux-unresponsive end'],
        ['hold', p, 'unclassified-error end'],
        ['notice', p],
      ])
      expect(h.episodeNotices).toEqual([
        { key: p, text: conflictNoticeText({ sessionName: record!.sessionName, latchCase: LATCH_CASE_LEFTOVER, description: record!.description }) },
      ])
      expect(h.stub.calls.killCalls).toHaveLength(1)
      expect(h.stub.calls.spawnCalls).toHaveLength(1)
      expect(h.stub.calls.resumeCalls).toEqual([])
      expect(h.stub.calls.deleteCalls).toEqual([])
      expect(getFailureCount(p)).toBe(RESTART_FAILURE_CAP - 1)
      expect(h.capReached).toEqual([])
      expect(h.notices).toEqual([])
      expect(h.startupErrors()).toEqual([])
      expect(h.triggers).toEqual([])
      expect(h.controller.armedKeys()).toEqual([])
      expect(isRestartPendingOrActive(p)).toBe(false)

      // AC 46: with the stub answering again, a later retry for P still makes no call.
      h.script({ spawnError: undefined })
      const before = callCounts(h)
      expect(await runRestartRetry(p, cwdOf(p), isLaunchInFlight)).toBe(RESTART_OUTCOME_LATCHED)
      expect(callCounts(h)).toEqual(before)
      // A scheduled restart for P arms no timer.
      scheduleRestart(p, cwdOf(p))
      expect(isRestartPendingOrActive(p)).toBe(false)
      expect(h.errors.filter((line) => line.startsWith(`[slack] Not scheduling restart for persona=${p} `))).toEqual([
        `[slack] Not scheduling restart for persona=${p} — the persona is latched; no timer armed (b.jg5 SRJ-502)`,
      ])
      expect(callCounts(h)).toEqual(before)

      // Q, not latched, is killed and relaunched as before.
      expect(await runRestartRetry(q, cwdOf(q), isLaunchInFlight)).toBe(RESTART_OUTCOME_LAUNCHED)
      await h.settle()
      expect(h.latch.isLatched(q)).toBe(false)
      expect(h.stub.calls.killCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(p), personaInstanceId(q)])
      expect(h.stub.spawnedIds()).toEqual([personaInstanceId(p), personaInstanceId(q)])
      expect(getFailureCount(q)).toBe(0)
      expect(h.latchEvents).toHaveLength(5)
      expect(h.episodeNotices).toHaveLength(1)
    })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-207, SRJ-303 — the restart path holds back for a persona held on
// ErrInvalidFlags
//
// Over the file's deps, with the optional held query (`RestartDeps.isHeld`)
// over a real hold (`createInvalidFlagsHold`). While P is held, a scheduled
// restart and a human-triggered restart request arm no timer; the work's
// held gate, right after its latched gate, answers `RESTART_OUTCOME_HELD` for
// the retry entry (before its in-flight and cap checks) and for a restart
// timer armed before P was held: nothing is probed, reconnected, killed or
// launched, nothing is recorded, the cap state is left as it was. A launch
// that answers 'skipped' because its reuse held P ends the run held. A held
// query that throws counts as held. Q restarts as before, and deps with no
// query behave as before. On the recovery harness, P held through a real
// reuse: the retry entry makes no stub call for P. Every line is
// leak-checked; the retry timer's reading of the outcome is
// tests/unavailable-retry.test.ts's.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-207, SRJ-303: the restart path makes no attempt for a persona held on ErrInvalidFlags', () => {
  const P = 'persona_p'
  const Q = 'persona_q'
  const CWD: Record<string, string> = { [P]: '/cwd/p', [Q]: '/cwd/q' }
  /** What every line the restart module logs for a held persona says. */
  const HELD_WORDS = 'held on ErrInvalidFlags'
  let errLines: string[]
  let origConsoleError: typeof console.error
  let hold: InvalidFlagsHold
  /** Each serialized work's outcome, in order. */
  let outcomes: Array<{ key: string; outcome: unknown }>

  beforeEach(() => {
    errLines = []
    outcomes = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }
    hold = createInvalidFlagsHold({ log: (line) => { errLines.push(line) } })
  })

  afterEach(() => {
    console.error = origConsoleError
    cancelAllRestartTimers()
    assertNoLeak({ errLines })
  })

  /**
   * The file's deps over a dead row, every launch succeeding (P's would
   * reset its failure on record), the held query over the case's hold and a
   * serializer that records each work's outcome.
   */
  function heldDeps(opts: DepsOpts = {}): ReturnType<typeof makeDeps> {
    const deps = makeDeps(opts)
    deps.isHeld = (key) => hold.isHeld(key)
    deps.serialize = async <T>(key: string, operation: () => T | Promise<T>): Promise<T> => {
      const outcome = await operation()
      outcomes.push({ key, outcome })
      return outcome
    }
    return deps
  }

  /** P made no call and recorded nothing: its one failure on record kept, no cap notice, nothing armed. */
  function expectNothingForP(deps: ReturnType<typeof makeDeps>): void {
    expect(deps.isSessionAliveCalls.filter((key) => key === P)).toEqual([])
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls.filter((key) => key === P)).toEqual([])
    expect(deps.launchSessionCalls.filter((call) => call.key === P)).toEqual([])
    expect(getFailureCount(P)).toBe(1)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(deps.armRetryTimerCalls).toEqual([])
    expect(isRestartPendingOrActive(P)).toBe(false)
  }

  /** P's lines that say it is held: exactly `count`. */
  function expectHeldLines(count: number): void {
    expect(errLines.filter((line) => line.includes(`persona=${P}`) && line.includes(HELD_WORDS) && !line.startsWith(INVALID_FLAGS_HOLD_LOG_PREFIX))).toHaveLength(count)
  }

  const SCHEDULE_ENTRIES: Array<[string, { humanTrigger: true } | undefined]> = [
    ['a scheduled restart', undefined],
    ['a human-triggered restart request', { humanTrigger: true }],
  ]

  test.each(SCHEDULE_ENTRIES)('%s for a held P arms no timer: one line, no probe, reconnect, kill or launch, nothing recorded; Q beside it restarts as before', async (_entry, opts) => {
    recordFailure(P)
    hold.set(P, PHASE1_RC_VERSION)
    const deps = heldDeps()
    initRestart(deps)

    scheduleRestart(P, CWD[P]!, undefined, opts)
    expect(isRestartPendingOrActive(P)).toBe(false)
    scheduleRestart(Q, CWD[Q]!, undefined, opts)
    await Bun.sleep(WAIT_MS)

    expect(outcomes).toEqual([{ key: Q, outcome: RESTART_OUTCOME_LAUNCHED }])
    expect(deps.launchSessionCalls.map((call) => call.key)).toEqual([Q])
    expectNothingForP(deps)
    expectHeldLines(1)
  })

  test('the retry entry (runRestartRetry) for a held P answers held: nothing probed, reconnected, killed or launched, nothing recorded, one line; Q beside it restarts as before', async () => {
    recordFailure(P)
    hold.set(P, PHASE1_RC_VERSION)
    const deps = heldDeps()
    initRestart(deps)

    expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_HELD)
    expect(await runRestartRetry(Q, CWD[Q]!, () => false)).toBe(RESTART_OUTCOME_LAUNCHED)

    expect(outcomes).toEqual([{ key: P, outcome: RESTART_OUTCOME_HELD }, { key: Q, outcome: RESTART_OUTCOME_LAUNCHED }])
    expectNothingForP(deps)
    expectHeldLines(1)
  })

  test('the retry entry for a held P at the cap and with a launch in flight answers held first: the in-flight, shutdown and relaunch checks are never asked', async () => {
    for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(P)
    hold.set(P, PHASE1_RC_VERSION)
    const asked: string[] = []
    const deps = heldDeps()
    deps.isShuttingDown = () => { asked.push('shutdown'); return false }
    deps.canRestart = () => { asked.push('gate'); return true }
    initRestart(deps)

    expect(await runRestartRetry(P, CWD[P]!, () => { asked.push('in-flight'); return true })).toBe(RESTART_OUTCOME_HELD)

    expect(asked).toEqual([])
    expect([deps.isSessionAliveCalls, deps.killSessionCalls, deps.launchSessionCalls]).toEqual([[], [], []])
    expect(getFailureCount(P)).toBe(RESTART_FAILURE_CAP)
    expect(deps.onCapReachedCalls).toEqual([])
  })

  test('a restart timer armed before P was held: when it fires, its work answers held with no call, nothing recorded', async () => {
    recordFailure(P)
    const deps = heldDeps()
    initRestart(deps)

    scheduleRestart(P, CWD[P]!)
    expect(isRestartPendingOrActive(P)).toBe(true)
    hold.set(P, PHASE1_RC_VERSION)
    await Bun.sleep(WAIT_MS)

    expect(outcomes).toEqual([{ key: P, outcome: RESTART_OUTCOME_HELD }])
    expectNothingForP(deps)
  })

  test('a run whose launch answers \'skipped\' because its reuse held P answers held: the kill before it, nothing after it, nothing counted, no cap notice and no restart scheduled; a later retry makes no attempt', async () => {
    recordFailure(P)
    const deps = heldDeps({
      launchSession: async (key) => {
        hold.set(key, PHASE1_RC_VERSION)
        return 'skipped'
      },
    })
    initRestart(deps)

    expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_HELD)

    expect(deps.isSessionAliveCalls).toEqual([P])
    expect(deps.killSessionCalls).toEqual([P])
    expect(deps.launchSessionCalls.map((call) => call.key)).toEqual([P])
    expect(getFailureCount(P)).toBe(1)
    expect([deps.onCapReachedCalls, deps.armRetryTimerCalls]).toEqual([[], []])
    expect(isRestartPendingOrActive(P)).toBe(false)

    expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_HELD)
    expect(deps.launchSessionCalls).toHaveLength(1)
    expect(deps.isSessionAliveCalls).toEqual([P])
  })

  test('held during the liveness probe: the work answers held with no reconnect, kill or launch, nothing armed, nothing recorded', async () => {
    recordFailure(P)
    const deps = heldDeps()
    deps.isSessionAlive = async (key) => {
      deps.isSessionAliveCalls.push(key)
      hold.set(key, PHASE1_RC_VERSION)
      return LIVENESS_READING_UNKNOWN
    }
    initRestart(deps)

    expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_HELD)

    expect(deps.isSessionAliveCalls).toEqual([P])
    expect([deps.reconnectSessionCalls, deps.killSessionCalls, deps.launchSessionCalls, deps.armRetryTimerCalls]).toEqual([[], [], [], []])
    expect(getFailureCount(P)).toBe(1)
  })

  test('a held query that throws counts as held (fail safe): no call, held, one line naming what it threw, redacted', async () => {
    recordFailure(P)
    const deps = heldDeps()
    deps.isHeld = (key) => {
      if (key === P) throw Object.assign(new Error(`held query broke (${sentinelInMessage('held')})`), { note: LEAK_SENTINEL })
      return false
    }
    initRestart(deps)

    expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_HELD)
    expect(await runRestartRetry(Q, CWD[Q]!, () => false)).toBe(RESTART_OUTCOME_LAUNCHED)

    expectNothingForP(deps)
    const lines = errLines.filter((line) => line.includes(`persona=${P}`) && line.includes(HELD_WORDS))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`held query failed: Error message="held query broke (${REDACTED_SENTINEL_TAIL})"`)
  })

  test.each([
    ['with the held query present, answering false', (_deps: ReturnType<typeof makeDeps>) => {}],
    ['with a hand-built RestartDeps that has no held query', (deps: ReturnType<typeof makeDeps>) => { delete deps.isHeld }],
  ] as const)('%s: P restarts as before, its success recorded', async (_label, shape) => {
    recordFailure(P)
    const deps = heldDeps()
    shape(deps)
    initRestart(deps)

    expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_LAUNCHED)
    expect(getFailureCount(P)).toBe(0)
    expectHeldLines(0)
  })

  describe('on the recovery harness', () => {
    let h: RecoveryHarness | undefined

    afterEach(() => {
      if (h === undefined) return
      assertNoLeak(h.captured())
      h.cleanup()
      h = undefined
    })

    test('P held through a real reuse: the retry entry and a scheduled restart make no status, kill, send-keys, spawn, resume or delete for cscb_<key>, record nothing and arm nothing', async () => {
      h = makeRecoveryHarness()
      const [p] = h.keys as [string]
      const persona = h.config.personas.find((x) => x.key === p)!
      h.script(collided(h, persona, { cwd: h.home, state: LIVENESS_DEAD_ROW_ENDED }, errInvalidFlags('spawn')))
      expect(await h.launch(p)).toStrictEqual({ key: p, action: 'held' })
      const before = personaCallCounts(h, p)

      expect(await runRestartRetry(p, persona.working_directory, () => false)).toBe(RESTART_OUTCOME_HELD)
      scheduleRestart(p, persona.working_directory)
      expect(isRestartPendingOrActive(p)).toBe(false)
      await h.settle()

      expect(personaCallCounts(h, p)).toEqual(before)
      expect([getFailureCount(p), h.controller.isArmed(p), h.capReached]).toEqual([0, false, []])
    })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-706, SRJ-303 — the restart path makes no attempt while P's
// live-row sequence runs
//
// Over the file's deps, with the optional running query
// (`RestartDeps.isLiveRowSequenceRunning`) answering for P. Right after the
// first latched gate of the serialized work, a running sequence answers
// `RESTART_OUTCOME_SEQUENCE_WAITING` for a fired restart timer (a scheduled
// restart or a human-triggered restart request) and for the retry entry:
// nothing is probed, reconnected, killed or launched, nothing is recorded
// and nothing counts toward the cap. The retry entry's own in-flight check
// and a latched P answer first. Q restarts as before, and fixtures with no
// query, or one answering false, behave as before. Every line is
// leak-checked. The retry timer's reading of the outcome is
// tests/unavailable-retry.test.ts's.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-706, SRJ-303: the restart path makes no attempt while P\'s live-row sequence runs', () => {
  const P = 'persona_p'
  const Q = 'persona_q'
  const CWD: Record<string, string> = { [P]: '/cwd/p', [Q]: '/cwd/q' }
  /** The restart work's one line for a persona whose sequence runs. */
  const sequenceSkipLine = (key: string, failure = ''): string =>
    `[slack] Skipping restart for persona=${key} — its live-row sequence runs${failure}; no agent-director call, nothing recorded (sequence-waiting; b.jg5 SRJ-706, SRJ-303)`
  /** The restart work's one line for a persona whose sequence is found running when the gate is asked again, at `where`. */
  const sequenceFurtherLine = (key: string, where: string): string =>
    `[slack] Restart for persona=${key} goes no further ${where} — its live-row sequence runs; nothing more is called for it, nothing recorded (sequence-waiting; b.jg5 SRJ-706, SRJ-303)`
  /**
   * Q's asks of the running query in one run over a dead row that launches: at the work's start, after its probe,
   * before its kill and before its launch (b.jg5 SRJ-706: asked again wherever the latched gate is, and before the launch).
   */
  const Q_RUN_ASKS = [Q, Q, Q, Q]
  let errLines: string[]
  let origConsoleError: typeof console.error
  /** Each serialized work's outcome, in order. */
  let outcomes: Array<{ key: string; outcome: unknown }>
  /** Every ask of the running query, by key. */
  let asked: string[]

  beforeEach(() => {
    errLines = []
    outcomes = []
    asked = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.error = origConsoleError
    cancelAllRestartTimers()
    assertNoLeak({ errLines })
  })

  /**
   * The file's deps over a dead row, every launch succeeding, the running
   * query answering `running(key)` (each ask recorded) and a serializer that
   * records each work's outcome.
   */
  function sequenceDeps(running: (key: string) => boolean): ReturnType<typeof makeDeps> {
    const deps = makeDeps()
    deps.isLiveRowSequenceRunning = (key) => {
      asked.push(key)
      return running(key)
    }
    deps.serialize = async <T>(key: string, operation: () => T | Promise<T>): Promise<T> => {
      const outcome = await operation()
      outcomes.push({ key, outcome })
      return outcome
    }
    return deps
  }

  /**
   * P made no agent-director call and recorded nothing: its one failure on
   * record kept (a success would reset it, a counted failure raise it; one
   * keeps P's backoff inside WAIT_MS), no cap notice, nothing armed.
   */
  function expectNothingForP(deps: ReturnType<typeof makeDeps>): void {
    expect(deps.isSessionAliveCalls.filter((key) => key === P)).toEqual([])
    expect(deps.reconnectSessionCalls).toEqual([])
    expect(deps.killSessionCalls.filter((key) => key === P)).toEqual([])
    expect(deps.launchSessionCalls.filter((call) => call.key === P)).toEqual([])
    expect(getFailureCount(P)).toBe(1)
    expect(deps.onCapReachedCalls).toEqual([])
    expect(deps.armRetryTimerCalls).toEqual([])
    expect(isRestartPendingOrActive(P)).toBe(false)
    expect(errLines.filter((line) => line.includes(`persona=${P}`) && line.startsWith('[slack] Skipping restart'))).toEqual([sequenceSkipLine(P)])
  }

  test.each<[string, { humanTrigger: true } | undefined]>([
    ['a scheduled restart', undefined],
    ['a human-triggered restart request', { humanTrigger: true }],
  ])('%s for P whose timer fires while its sequence runs: the work answers sequence-waiting with no probe, reconnect, kill or launch, nothing recorded and nothing toward the cap; Q beside it restarts as before', async (_entry, opts) => {
    recordFailure(P)
    const deps = sequenceDeps((key) => key === P)
    initRestart(deps)

    scheduleRestart(P, CWD[P]!, undefined, opts)
    scheduleRestart(Q, CWD[Q]!, undefined, opts)
    await Bun.sleep(WAIT_MS)

    // Q, with no failure on record, fires first.
    expect(outcomes).toEqual([{ key: Q, outcome: RESTART_OUTCOME_LAUNCHED }, { key: P, outcome: RESTART_OUTCOME_SEQUENCE_WAITING }])
    expectNothingForP(deps)
    expect(deps.killSessionCalls).toEqual([Q])
    expect(deps.launchSessionCalls.map((call) => call.key)).toEqual([Q])
    expect(asked).toEqual([...Q_RUN_ASKS, P])
  })

  test.each<[string, boolean, RestartRetryOutcome]>([
    ['its in-flight predicate answering false: sequence-waiting', false, RESTART_OUTCOME_SEQUENCE_WAITING],
    ['its in-flight predicate answering true (a running sequence counts there too): that check answers first, in-flight', true, RESTART_OUTCOME_IN_FLIGHT],
  ])('the retry entry for P while its sequence runs, %s, with no agent-director call and nothing recorded', async (_label, inFlight, outcome) => {
    recordFailure(P)
    const deps = sequenceDeps((key) => key === P)
    initRestart(deps)

    expect(await runRestartRetry(P, CWD[P]!, () => inFlight)).toBe(outcome)
    expect(await runRestartRetry(Q, CWD[Q]!, () => false)).toBe(RESTART_OUTCOME_LAUNCHED)

    expect(deps.isSessionAliveCalls).toEqual([Q])
    expect(deps.killSessionCalls).toEqual([Q])
    expect(deps.launchSessionCalls.map((call) => call.key)).toEqual([Q])
    expect(getFailureCount(P)).toBe(1)
    expect([deps.onCapReachedCalls, deps.armRetryTimerCalls]).toEqual([[], []])
    // The in-flight check answers before the serialized work: the running query is not asked for P then.
    expect(asked).toEqual(inFlight ? Q_RUN_ASKS : [P, ...Q_RUN_ASKS])
  })

  // b.jg5 SRJ-706: the running query is asked again wherever the latched
  // gate is (after the probe, after an 'escalate-dead' reconnect, after its
  // re-probe, before the kill) and once more before the launch, since a
  // launch outside the serializer can start P's sequence during the work's
  // awaits (a collision ladder's replacement site, b.jg5 SRJ-707). Driven on
  // the escalate-dead path (a live row whose reconnect answers
  // 'escalate-dead', then a dead re-probe), where every gate is asked: the
  // query first answers running at the given ask, and the work goes no
  // further: sequence-waiting, nothing recorded, nothing armed.
  test.each<[number, string, { probes: number; reconnects: number; kills: number }]>([
    [2, 'after its liveness probe', { probes: 1, reconnects: 0, kills: 0 }],
    [3, 'after its escalate-dead reconnect', { probes: 1, reconnects: 1, kills: 0 }],
    [4, 'after its re-probe', { probes: 2, reconnects: 1, kills: 0 }],
    [5, 'before its kill', { probes: 2, reconnects: 1, kills: 0 }],
    [6, 'before its launch', { probes: 2, reconnects: 1, kills: 1 }],
  ])('the running query first answering true at ask %i (%s): the work goes no further, answers sequence-waiting, records nothing and arms nothing', async (runningFrom, where, made) => {
    recordFailure(P)
    const deps = sequenceDeps((key) => key === P && asked.filter((k) => k === P).length >= runningFrom)
    const probes = [LIVENESS_READING_LIVE, LIVENESS_READING_DEAD]
    deps.isSessionAlive = async (key) => {
      deps.isSessionAliveCalls.push(key)
      return probes[deps.isSessionAliveCalls.length - 1] ?? LIVENESS_READING_DEAD
    }
    deps.reconnectSession = async (key) => {
      deps.reconnectSessionCalls.push(key)
      return ESCALATE_DEAD_WORKING_GONE
    }
    initRestart(deps)

    expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_SEQUENCE_WAITING)

    expect(asked).toEqual(Array(runningFrom).fill(P))
    expect({
      probes: deps.isSessionAliveCalls.length,
      reconnects: deps.reconnectSessionCalls.length,
      kills: deps.killSessionCalls.length,
    }).toEqual(made)
    expect(deps.launchSessionCalls).toEqual([])
    expect(getFailureCount(P)).toBe(1)
    expect([deps.onCapReachedCalls, deps.armRetryTimerCalls]).toEqual([[], []])
    expect(errLines.filter((line) => line.includes('live-row sequence'))).toEqual([sequenceFurtherLine(P, where)])
  })

  // b.jg5 SRJ-706, SRJ-707: the restart's own launch reaches a collision
  // ladder replacement site over a live row, which starts P's sequence and
  // answers sequence-waiting (`launchSession`'s uncounted 'refused'): the work
  // answers sequence-waiting too, so a retry's re-armed line names the
  // sequence. Control: a refused launch with no sequence running stays the
  // refused outcome.
  test.each<[string, boolean, RestartRetryOutcome]>([
    ['its ladder starts P\'s sequence: sequence-waiting', true, RESTART_OUTCOME_SEQUENCE_WAITING],
    ['no sequence runs (control): refused', false, RESTART_OUTCOME_REFUSED],
  ])('a restart whose own launch answers refused while %s; nothing recorded, nothing armed', async (_label, startsSequence, outcome) => {
    recordFailure(P)
    let started = false
    const deps = sequenceDeps((key) => key === P && started)
    deps.launchSession = async (key, cwd, sessionId) => {
      deps.launchSessionCalls.push({ key, cwd, sessionId })
      started = startsSequence
      return 'refused'
    }
    initRestart(deps)

    expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(outcome)

    expect([deps.isSessionAliveCalls, deps.killSessionCalls, deps.launchSessionCalls.map((call) => call.key)]).toEqual([[P], [P], [P]])
    expect(asked).toEqual([P, P, P, P, P])
    expect(getFailureCount(P)).toBe(1)
    expect([deps.onCapReachedCalls, deps.armRetryTimerCalls]).toEqual([[], []])
    expect(errLines.filter((line) => line.includes('live-row sequence'))).toEqual(startsSequence ? [sequenceFurtherLine(P, 'after its launch')] : [])
  })

  test('a latched P whose sequence runs answers latched first: the running query is not asked', async () => {
    const latch = createConflictLatch({ log: (line) => { errLines.push(line) } })
    latch.setFromConflict(P, errTmuxSessionConflict('spawn', 'scan-leftover'), { refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN, rowState: latchRowStateRead(LIVENESS_DEAD_ROW_ENDED) })
    const deps = sequenceDeps(() => true)
    deps.isLatched = (key) => latch.isLatched(key)
    initRestart(deps)

    expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_LATCHED)

    expect(asked).toEqual([])
    expect([deps.isSessionAliveCalls, deps.killSessionCalls, deps.launchSessionCalls]).toEqual([[], [], []])
  })

  test('a running query that throws counts as running (fail safe): sequence-waiting, its one line naming what it threw, redacted', async () => {
    recordFailure(P)
    const deps = sequenceDeps((key) => {
      if (key === P) throw Object.assign(new Error(`running query broke (${sentinelInMessage('sequence')})`), { note: LEAK_SENTINEL })
      return false
    })
    initRestart(deps)

    expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_SEQUENCE_WAITING)

    const lines = errLines.filter((line) => line.startsWith(`[slack] Skipping restart for persona=${P} — its live-row sequence runs (the running query failed: `))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`Error message="running query broke (${REDACTED_SENTINEL_TAIL})"`)
    expect(lines[0]).toEndWith(' — taken as running); no agent-director call, nothing recorded (sequence-waiting; b.jg5 SRJ-706, SRJ-303)')
    expect([deps.isSessionAliveCalls, deps.killSessionCalls, deps.launchSessionCalls]).toEqual([[], [], []])
    expect(getFailureCount(P)).toBe(1)
  })

  test.each<[string, (deps: ReturnType<typeof makeDeps>) => void]>([
    ['a hand-built RestartDeps with no running query', (deps) => { delete deps.isLiveRowSequenceRunning }],
    ['the running query answering false', () => {}],
  ])('%s: P\'s retry runs as before — one probe, one kill, one launch, launched', async (_label, setQuery) => {
    const deps = sequenceDeps(() => false)
    setQuery(deps)
    initRestart(deps)

    expect(await runRestartRetry(P, CWD[P]!, () => false)).toBe(RESTART_OUTCOME_LAUNCHED)

    expect([deps.isSessionAliveCalls, deps.killSessionCalls, deps.launchSessionCalls.map((call) => call.key)]).toEqual([[P], [P], [P]])
    expect(errLines.filter((line) => line.includes('live-row sequence'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-502, SRJ-512, SRJ-513 — a restart run whose own liveness read
// latches P
//
// The real liveness adapter applies the own-row `status` step with the
// configured-persona query the recovery harness installs (as `main()` does),
// so P's own read latches P and reads `unknown` when it answers UNUSABLE NAME
// (the case "unusable recorded name", the state unreadable) or reads P's own
// row `pending` with no launch start (absent, `null` or one that does not
// parse: "launch start not recorded", refused operation "none", the state
// `pending`). The restart work asks the latch again right after each probe:
// after the first probe, and (UNUSABLE NAME) after b.d61's re-probe that
// follows an escalate-dead reconnect (a `working` row whose one `read-pane`
// answers GONE, swept once). Either way the run answers
// `RESTART_OUTCOME_LATCHED` with no `pending` deferral, no further reconnect,
// no kill, spawn, `resume` or send-keys, no tmux-touching call after that
// read-pane, no arm hook and nothing recorded (P's one failure on record
// stays one: a success would reset it, a counted failure raise it), for a
// scheduled restart, a human-triggered restart request and E8's retry entry
// alike. The latch's holds and its one SRJ-1019 or SRJ-1020 post run as
// `main()` binds them. Control: P's pending row with a launch start latches
// no one and is handed to the `pending` deferral as E9 left it. Q beside P,
// whose row reads `ended`, is killed and relaunched as before. One fault row
// and one no-launch-start form per entry: every fault and form is covered at
// the adapters, in tests/server.test.ts. The scheduled entries wait out their
// short restart timers with `Bun.sleep(WAIT_MS)`.
// ---------------------------------------------------------------------------

/** The restart work's line for a latched persona. */
const latchedSkipLine = (key: string): string =>
  `[slack] Skipping restart for persona=${key} — the persona is latched; no agent-director call, nothing recorded (b.jg5 SRJ-502)`

/** How each entry runs persona `key`'s restart work, waiting for it as the file does. */
type RestartEntry = (key: string, cwd: string) => Promise<void>
const RESTART_ENTRIES: ReadonlyArray<readonly [string, RestartEntry]> = [
  ['a scheduled restart', async (key, cwd) => {
    scheduleRestart(key, cwd)
    await Bun.sleep(WAIT_MS)
  }],
  ['a human-triggered restart request', async (key, cwd) => {
    scheduleRestart(key, cwd, undefined, { humanTrigger: true })
    await Bun.sleep(WAIT_MS)
  }],
  ["E8's retry entry (runRestartRetry)", async (key, cwd) => {
    await runRestartRetry(key, cwd, isLaunchInFlight)
  }],
]

/** P's `status` answer for its `read`-th own-row read (from 0). */
type OwnStatusAnswer = (read: number) => ReturnType<typeof cannedStatusResult> | Error

/**
 * A recovery harness whose restart deps record each `pending` deferral, each
 * arm-hook call and each run's outcome. P's `status` answers `ownStatus` for
 * each of its reads; Q's (every other persona's) reads `ended` until its
 * relaunch's spawn, then `waiting`. P has one failure on record.
 */
function ownReadLatchHarness(ownStatus: OwnStatusAnswer) {
  const deferred: string[] = []
  const armHook: string[] = []
  const outcomes: Array<{ key: string; outcome: unknown }> = []
  const h = makeRecoveryHarness({
    alertThresholdMs: false,
    restartDeps: {
      getRestartDelay: () => FAST_DELAY_S,
      deferPendingRow: (key) => { deferred.push(key) },
      armRetryTimer: (key) => { armHook.push(key) },
      serialize: async <T>(key: string, operation: () => T | Promise<T>): Promise<T> => {
        const outcome = await operation()
        outcomes.push({ key, outcome })
        return outcome
      },
    },
  })
  const [p, q] = [h.keys[0]!, h.keys[1]!]
  const cwdOf = (key: string): string => h.config.personas.find((persona) => persona.key === key)!.working_directory
  const othersRow = rowReadsUntilSpawn(h, 'ended')
  let ownReads = 0
  h.script({
    statusFn: (params) => params.claude_instance_id === personaInstanceId(p) ? ownStatus(ownReads++) : othersRow(params),
  })
  recordFailure(p)
  return { h, p, q, cwdOf, deferred, armHook, outcomes }
}

describe('b.jg5 SRJ-512, SRJ-513: a restart run whose own liveness read latches P stops there', () => {
  /** The first `status` row of the unusable-name table. */
  const UNUSABLE_NAME_ROW = UNUSABLE_NAME_CASE_ROWS.find((row) => row.site === 'status')!

  let harness: RecoveryHarness | undefined

  afterEach(() => {
    cancelAllRestartTimers()
    const h = harness
    harness = undefined
    if (h === undefined) return
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
    expect(h.clock.pendingCount()).toBe(0)
  })

  /** What a latching case expects of P: its stub calls by verb, its latch record and its one notice. */
  interface LatchExpectation {
    readonly calls: Record<string, number>
    readonly record: (key: string) => ConflictLatchRecord
    readonly notice: (key: string) => string
  }

  /** Run P's restart work through `run`, expect it latched as `expected` says, then Q's, relaunched as before. */
  async function expectLatchedThenOtherRelaunched(
    rig: ReturnType<typeof ownReadLatchHarness>,
    run: RestartEntry,
    expected: LatchExpectation,
  ): Promise<void> {
    const { h, p, q, cwdOf, deferred, armHook, outcomes } = rig

    await run(p, cwdOf(p))

    // The sweep's findMissing names no instance; every other call is P's own.
    const { findMissingCalls: _sweeps, ...ownCalls } = expected.calls
    // The only tmux-touching call is the read-pane whose GONE escalated, made
    // before P latched; none follows the latch.
    const tmuxBeforeLatch = expected.calls.readPaneCalls === undefined ? [] : [['read-pane', personaInstanceId(p)]]

    expect(outcomes).toEqual([{ key: p, outcome: RESTART_OUTCOME_LATCHED }])
    expect(callCounts(h)).toEqual(expected.calls)
    expect(personaCallCounts(h, p)).toEqual(ownCalls)
    expect(tmuxTouchingCallsIn(h.stub.calls).map((c) => [c.verb, (c.params as { claude_instance_id?: string }).claude_instance_id])).toEqual(tmuxBeforeLatch)
    expect(h.latch.record(p)).toEqual(expected.record(p))
    expect(h.latchEvents.filter((event) => event.step === 'set').map((event) => event.key)).toEqual([p])
    expect(h.episodeNotices).toEqual([{ key: p, text: expected.notice(p) }])
    expect(deferred).toEqual([])
    expect(armHook).toEqual([])
    expect(h.controller.armedKeys()).toEqual([])
    expect(h.triggers).toEqual([])
    expect(getFailureCount(p)).toBe(1)
    expect(h.capReached).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.errors.filter((line) => line === latchedSkipLine(p))).toHaveLength(1)
    expect(h.errors.filter((line) => line.startsWith(`[slack] Deferring persona=${p}`))).toEqual([])
    expect(h.errors.filter((line) => line.startsWith(`[slack] Relaunching session for persona=${p}`))).toEqual([])

    // Q, not latched, is killed and relaunched through the same entry.
    await run(q, cwdOf(q))
    await h.settle()

    expect(outcomes).toEqual([{ key: p, outcome: RESTART_OUTCOME_LATCHED }, { key: q, outcome: RESTART_OUTCOME_LAUNCHED }])
    expect(h.latch.isLatched(q)).toBe(false)
    expect(h.stub.calls.killCalls.map((c) => c.claude_instance_id)).toEqual([personaInstanceId(q)])
    expect(h.stub.spawnedIds()).toEqual([personaInstanceId(q)])
    expect(personaCallCounts(h, p)).toEqual(ownCalls)
    expect(getFailureCount(q)).toBe(0)
    expect(h.episodeNotices).toHaveLength(1)
    expect(deferred).toEqual([])
    expect(armHook).toEqual([])
  }

  /**
   * Where P's own `status` answers UNUSABLE NAME: `liveReads` is how many of
   * P's reads answer a live `working` row before it, and `paneGone` whether
   * the reconnect adapter's one `read-pane` of P's row answers GONE (so it
   * sweeps once and escalates); `calls` is every stub call the run makes for
   * P, by verb.
   */
  const PROBES: Array<[string, { liveReads: number; paneGone: boolean; calls: Record<string, number> }]> = [
    ['the first probe', { liveReads: 0, paneGone: false, calls: { statusCalls: 1 } }],
    // The probe reads working (live, P not connected), the reconnect adapter
    // reads working too; its read-pane answers GONE and it sweeps once.
    ["b.d61's re-probe after an escalate-dead reconnect", { liveReads: 2, paneGone: true, calls: { statusCalls: 3, readPaneCalls: 1, findMissingCalls: 1 } }],
  ]

  test.each(RESTART_ENTRIES.flatMap(([entry, run]) => PROBES.map(([probe, opts]) => [entry, probe, run, opts] as const)))(
    '%s, P\'s status answering UNUSABLE NAME at %s: P latches once with one SRJ-1019 post; the run answers latched with no deferral, kill, spawn, resume or send-keys, no arm hook, nothing counted; Q beside it restarts as before',
    async (_entry, _probe, run, opts) => {
      const err = UNUSABLE_NAME_ROW.build()
      const rig = ownReadLatchHarness((read) => read < opts.liveReads ? cannedStatusResult({ state: 'working' }) : err)
      harness = rig.h
      // P's read-pane is the run's first: GONE, once; Q's launch reads the stub's default pane.
      if (opts.paneGone) rig.h.script({ readPaneQueue: [cannedErr(errTmuxCaptureFailed())] })

      await expectLatchedThenOtherRelaunched(rig, run, {
        calls: opts.calls,
        record: UNUSABLE_NAME_ROW.record,
        notice: UNUSABLE_NAME_ROW.notice,
      })
    },
  )

  // One no-launch-start form per entry, rotated so each form runs once.
  test.each(RESTART_ENTRIES.map(([entry, run], i) => [entry, NO_LAUNCH_START_FORM_NAMES[i % NO_LAUNCH_START_FORM_NAMES.length]!, run] as const))(
    '%s, P\'s own row pending with its launch start %s: P latches once with state pending and one SRJ-1020 post; the run answers latched with no deferral, kill, spawn, resume or send-keys, no arm hook, nothing counted; Q beside it restarts as before',
    async (_entry, form, run) => {
      const rig = ownReadLatchHarness(() =>
        cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: NO_LAUNCH_START_FORMS[form] }))
      harness = rig.h

      await expectLatchedThenOtherRelaunched(rig, run, {
        calls: { statusCalls: 1 },
        record: launchStartRecord,
        notice: launchStartNotRecordedNoticeText,
      })
    },
  )

  test.each(RESTART_ENTRIES)(
    'control, %s, P\'s own row pending with a launch start: no latch, no post; the row is handed to the pending deferral as E9 left it, with no kill, spawn, resume or send-keys, nothing counted',
    async (_entry, run) => {
      const rig = ownReadLatchHarness(() =>
        cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: SAMPLE_LAUNCH_START_FRACTIONAL }))
      const { h, p, cwdOf, deferred, armHook, outcomes } = rig
      harness = h

      await run(p, cwdOf(p))

      expect(outcomes).toEqual([{ key: p, outcome: RESTART_OUTCOME_PENDING_DEFERRED }])
      expect(deferred).toEqual([p])
      expect(callCounts(h)).toEqual({ statusCalls: 1 })
      expect(h.latch.isLatched(p)).toBe(false)
      expect(h.latchEvents).toEqual([])
      expect(h.episodeNotices).toEqual([])
      expect(armHook).toEqual([])
      expect(getFailureCount(p)).toBe(1)
      expect(h.errors.filter((line) => line === latchedSkipLine(p))).toEqual([])
    },
  )
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-704, SRJ-1007, SRJ-1016: the kill-failure alert at the restart
// path's kill (E20 T3)
//
// The restart path kills only after a `dead` reading, so its kill is one try
// of the bounded retry (b.jg5 SRJ-702; E20 T2's reconcile note): an
// `ErrTmuxKillFailed` stands at once and raises the ordinary version through
// the harness's kill-failure alerts, installed as `main()` installs them,
// with the context `recovery`. On the recovery harness (both settings 0): P's
// liveness read answers `ended` (`rowReadsUntilSpawn`) and its kill answers
// through the stub. Every expected text is built with
// `src/kill-failure-alert.ts`'s builders (the harness's `killFailureNotice`,
// `ordinaryAlertContent`, `killFailureRecoveryEntry`). The tries of a row read
// live (the survivor matrix, the latching reads, AC 64's three tries) and
// "a later failure in the same episode posts nothing" are proved at the
// live-row sequence's kill, in tests/session-manager.test.ts and
// tests/live-row-sequence.test.ts: here
// each run's own liveness read of `ended` ends the episode before its kill
// (b.jg5 SRJ-704), so a later run's failure opens a new one. The lost-message
// legs are in tests/inbound-recovery-drop-branch.test.ts.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-704, SRJ-1007: the kill-failure alert at the restart path\'s kill (one try)', () => {
  let harness: RecoveryHarness | undefined

  afterEach(() => {
    const h = harness
    harness = undefined
    if (h === undefined) return
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
    expect(h.clock.pendingCount()).toBe(0)
  })

  /** A harness whose P reads `ended` until its spawn; P first. */
  function build(): { h: RecoveryHarness; p: string; cwd: string } {
    const h = (harness = makeRecoveryHarness())
    const p = h.keys[0]!
    rowReadsUntilSpawn(h, 'ended')
    return { h, p, cwd: h.config.personas[0]!.working_directory }
  }

  /** The restart run for P, the stub's `kill` answering `err`. */
  async function runWithKill(h: RecoveryHarness, p: string, cwd: string, err: Error): Promise<RestartRetryOutcome> {
    h.script({ killError: err })
    return runRestartRetry(p, cwd, isLaunchInFlight)
  }

  // AC 64, demo bullet 8 (reconcile note 2: one try at the restart path).
  test.each([...KILL_FAILED_DESCRIPTIONS])('an ErrTmuxKillFailed (%s) that stands at the one try: one ordinary alert at P\'s destination quoting it, with the not-latched closing; no tmux-unresponsive condition or notice; no launch; P\'s timer armed with the kill-failed cause; P\'s episode open', async (form) => {
    const { h, p, cwd } = build()
    const err = errTmuxKillFailed(undefined, form)

    expect(await runWithKill(h, p, cwd, err)).toBe(RESTART_OUTCOME_REFUSED)

    expect(h.episodeNotices).toEqual([killFailureNotice(p, ordinaryAlertContent(p, { last: err }))])
    expect(h.stub.calls.killCalls).toHaveLength(1)
    expect(h.stub.spawnedIds()).toEqual([])
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.outageNotices).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED }])
    expect(h.controller.isArmed(p)).toBe(true)
    expect(h.killFailureOpen(p)).toBe(true)
    expect(h.startupErrors()).toEqual([])
    expect(killFailureLines(h, p)).toHaveLength(1)
  })

  // b.jg5 SRJ-704, SRJ-1016: the episode runs until P's row reads `ended` or
  // `missing`, or is gone. The next run's own liveness read of `ended` ends
  // it, silently, before that run's kill, whose failure then opens a new
  // episode with its own alert.
  test('a later run\'s liveness read of ended ends the episode silently; that run\'s kill failure posts a new alert', async () => {
    const { h, p, cwd } = build()
    const err = errTmuxKillFailed()
    await runWithKill(h, p, cwd, err)
    const alert = killFailureNotice(p, ordinaryAlertContent(p, { last: err }))
    const firstLines = killFailureLines(h, p)

    await retryNow(h, p)

    expect(h.stub.calls.killCalls).toHaveLength(2)
    expect(h.episodeNotices).toEqual([alert, alert])
    const added = killFailureLines(h, p).slice(firstLines.length)
    expect(added).toHaveLength(2)
    expect(added[0]).toBe(killFailureEndedLine(p, KILL_FAILURE_END_ROW_FINISHED))
    expect(added[1]).toBe(firstLines[0])
    expect(h.killFailureOpen(p)).toBe(true)
  })

  // b.jg5 SRJ-704, SRJ-1013, SRJ-1007 (hatch A2): a persona no longer in the
  // applied configuration when the alert is raised gets the server-log line
  // and one persona-kill-failed entry carrying the context `recovery`.
  test('P removed from the applied configuration during its kill: the ordinary version goes to one persona-kill-failed entry with the recovery context and the log-only closing; nothing posted; no episode', async () => {
    const { h, p, cwd } = build()
    const err = errTmuxKillFailed(undefined, 'unverifiable-session-present')
    const kill = h.stub.client.kill.bind(h.stub.client)
    h.stub.client.kill = async (params) => {
      try {
        return await kill(params)
      } finally {
        h.remove(p)
      }
    }

    expect(await runWithKill(h, p, cwd, err)).toBe(RESTART_OUTCOME_REFUSED)

    expect(startupEntriesOf(h, PERSONA_KILL_FAILED_LABEL)).toEqual([killFailureRecoveryEntry(p, ordinaryAlertContent(p, { last: err }))])
    expect(h.startupErrors()).toHaveLength(1)
    expect(h.episodeNotices).toEqual([])
    expect(h.killFailureOpen(p)).toBe(false)
    expect(killFailureLines(h, p)).toEqual([killFailureLoggedLine(p, KILL_FAILURE_VERSION_ORDINARY, PERSONA_KILL_FAILED_LABEL, KILL_FAILURE_ROUTE_NOT_CONFIGURED)])
  })

  // b.jg5 SRJ-703, SRJ-702: a success with no survivor-naming failure before
  // it raises no alert of either version, and the run launches P.
  test.each<[string, () => RecoveryStubScript]>([
    ['a success with kill_sent false', () => ({ killResult: cannedKillResult(false) })],
    ['ErrSpawnNotFound (the row-gone success)', () => ({ killError: errSpawnNotFound() })],
  ])('%s at the one try: no alert of either version; P is launched', async (_label, knobs) => {
    const { h, p, cwd } = build()
    h.script(knobs())

    expect(await runRestartRetry(p, cwd, isLaunchInFlight)).toBe(RESTART_OUTCOME_LAUNCHED)
    await h.settle()

    expect(h.stub.spawnedIds()).toEqual([personaInstanceId(p)])
    expect(h.episodeNotices).toEqual([])
    expect(killFailureLines(h, p)).toEqual([])
    expect(h.killFailureOpen(p)).toBe(false)
    expect(h.startupErrors()).toEqual([])
  })
})
