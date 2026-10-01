/**
 * unavailable-retry.test.ts — The per-persona UNAVAILABLE retry timer
 * (b.jg5 SRJ-301 code line, SRJ-302, SRJ-303, SRJ-304, SRJ-305, SRJ-306), and
 * the retry's side of the `tmux-unresponsive` condition's end (SRJ-310).
 *
 * The schedule, the never-give-up rule, arming while armed, isolation,
 * again-reasons and `close`, and the switch to pending-only mode, the last row
 * read and a condition that ends during a run, run on the bare controller
 * over `createFakeClock` with a scripted or held action; settings independence runs on `makeRecoveryHarness`
 * with its scripted action and a comment-stripped source audit. What arms the
 * timer (b.jg5 SRJ-301) runs on the harness with the controller as the outage
 * state's trigger sink: real launches through `spawnForPersona` over the
 * stub, the arming predicate on its own, and the reads made outside every
 * attempt. A `status` error at the launch's working-row wait (b.jg5 SRJ-605)
 * runs there too: the wait goes on past a failed poll (polling every
 * `WAIT_POLL_MS` of real time) while P's timer is armed, and its next poll
 * reading `waiting` reconnects; an error that lasts to the timeout read (the
 * wait's own clock, `_setNow`, moved past its timeout by each read) ends it
 * `not-reconnected`; neither is failed, refused or counted, and
 * `ErrSpawnNotFound` there arms nothing. The persona's dialog approver (b.jg5 SRJ-401; hatch A2) runs
 * there too, after its launch call returned and on the harness clock: it is
 * in flight for the persona (a lost message makes no read) but blocks no
 * retry (SRJ-303: the retry makes its row read), and once it stops a lost
 * message reads again; its UNAVAILABLE and UNCLASSIFIED answers (`status`,
 * `read-pane`, `send-keys`) keep it polling, and its `ErrSpawnNotInteractive`
 * and GONE answers at `status` stop it (SRJ-404, SRJ-118); none of them arms
 * a timer, adds a cause, opens an episode or counts anything, while
 * ENVIRONMENT and CONFIG raise their outage and arm as from any verb. The shared findMissing sweep runs on the harness
 * as well, its one call held open by the test so each caller joins it before
 * it fails.
 * The attempt frames run on the bare context with the controller as the sink.
 * The retry action's decisions, in both modes, run over a stand-in row read
 * and retry entry; the full-mode retry end to end (AC 26 with the
 * `tmux-unresponsive` condition's onset, alert and recovery along its
 * schedule, SRJ-302's alert half, and AC 30's alert part; the in-flight skip,
 * the row decisions, the serializer wait, a liveness `status` error read
 * `unknown` with the arm hook wired as `main()` wires it), the stop rules that exist now
 * (AC 28), pending-only mode (armed directly, AC 33's timer half) and the
 * condition-end entry's pending and kill-failure exceptions (called directly,
 * AC 30's timer half) run on the harness's default action, the real row read
 * and restart entry over the production adapters and the stub. The
 * `tmux-unresponsive` condition's ends (b.jg5 SRJ-305, SRJ-306, SRJ-310) run
 * there too, with the condition wired as `main()` wires it: a retry that finds
 * the persona recovered on its own, one that does not, a launch's successful
 * spawn, a plain `read-pane` success through the outage wrapper, and a health
 * tick's end (`tickEnd`, as the harness has no tick), each reaching the
 * condition-end entry once. What `arm`
 * answers (and so what `reportAttemptError` marks), a stop's failing
 * hand-off, and a pending-only stop that yields to a full-mode cause armed
 * during its retry run on the bare controller, the last over the server's
 * retry action on stand-in deps. The retry observer (`onRetryFire`, b.jg5
 * SRJ-308) runs on the bare controller too, over a scripted or held action
 * and, for the in-flight skip, the server's retry action on stand-in deps.
 * The stop observer (`onStopped`, b.jg5 SRJ-309) runs there too, over a
 * scripted, held or failing-clock action and, for the early stops, the
 * server's retry action on stand-in deps, with the pin of
 * `UNAVAILABLE_RETRY_TERMINAL_STOPS` over the exported stop reasons.
 * ENVIRONMENT (`ErrTmuxNotAvailable`, b.jg5 SRJ-311, SRJ-312, AC 27, AC 36)
 * runs on the harness with both settings 0, the outage state's cleared-flag
 * observer bound as `main()` binds it: what arms the timer in a start-pass
 * launch and outside every attempt (the liveness read, a teardown's kill, a
 * read-pane, the permission poller's and the JSONL safeguard's get), a stray
 * arm for a key out of the applied configuration, never counted and retried
 * only on the backoff, a row read that succeeds while the next verb still
 * answers it, the clears that stop the timer (a retry's reconnect, a retry
 * that finds the persona live and connected, a health tick's healthy-branch
 * clear, called as `src/health-check.ts` calls it since the harness has no
 * tick), SRJ-306's pending and kill-failure exceptions against the clear, and
 * the recovery. A kill of the last session on a socket followed by answers
 * from an exiting tmux server (AD handoff rev 23) runs there too, once with
 * `ErrTmuxNotAvailable` and once with `ErrTmuxUnresponsive`.
 * CONFIG (`ErrConfigMalformed`, b.jg5 SRJ-316, SRJ-301, SRJ-305, AC 84) runs
 * on the harness with both settings 0 and the arm hook bound as `main()`
 * binds it: what arms the timer in a start-pass launch and outside every
 * attempt, a trigger while armed, AC 84 end to end (a persona up and
 * connected, and a launch that met it: one onset, no kill, delete or launch
 * while it lasts, nothing counted, the retries on the backoff, and the
 * bring-up with one all-clear once calls succeed), and a clear of the outage
 * that leaves the timer armed.
 * UNCLASSIFIED (b.jg5 SRJ-313, SRJ-1009, AC 69, AC 80) runs on the harness
 * with both settings 0 and the unclassified-error episodes composed as
 * `main()` composes them: SRJ-1009's one pin case (the only copy of its
 * text); an `ErrInternal`, an unhandled name and `ErrSchemaMismatch` in a
 * start-pass launch and in a restart-run recovery, never destructive or
 * counted past the restart cap, retried on the backoff; the one alert at the
 * first retry strictly past the alert threshold in effect (agent-director's
 * defaults and AC 80's settings), derived from the accessor; a collision
 * `get` and every retry's row read (`ErrSchemaMismatch`); the log-only route
 * for a persona removed while its retry spawn is held (AC 69); the episode's
 * ends (nothing left to recover, a pending-only row live, the cap through
 * `onCapReached`, the teardown's forget) and a new episode alerting again;
 * the stop observer once per stop; and nothing armed or opened outside an
 * attempt.
 * The latch (b.jg5 SRJ-305, SRJ-313, SRJ-502) runs on the harness with the
 * latch composed as `main()` composes it (its holds, then the CONFLICT
 * notice): a retry's launch answering CONFLICT stops P's timer with the
 * latch's reason while the other persona's keeps its schedule; a start-pass
 * launch's CONFLICT stops a timer armed in full mode (the kill-failure cause
 * included) or pending-only; a failing latch-time `status` read's arm, and an
 * UNCLASSIFIED one's episode, do not outlive the latch; a timer armed after
 * the latch stops at its first fire with no call; and the latch ends an open
 * unclassified-error episode before its alert. The retry action's latched
 * gate and the restart work's `latched` outcome are rows of the stand-in
 * tables. A latched query that throws counts as latched (SRJ-502, fail
 * safe): the retry action's query, in both modes, over stand-ins and through
 * the bare controller (its one line, then the stop line), and the restart
 * work's query on the harness, each with no call and the other persona's
 * retry untouched.
 * A lost message (b.jg5 SRJ-1011, SRJ-311, SRJ-316, AC 36, AC 68) runs on the
 * harness with both settings 0, through its lost-message driver (the real
 * routing's no-session branch, bound as `main()` binds it): while P's
 * `tmux-unavailable` (ENVIRONMENT) or `ad-config-malformed` (CONFIG) outage
 * from its bring-up is raised, it reports `not-answering` with the exported
 * wording, asks for no restart and makes no call, and the other persona's
 * reports its own state; once calls succeed and the outage clears it reports
 * `auto-restart-disabled`. State 5 applies only while P's retry timer is
 * armed and P is below the restart cap (SRJ-1011 as amended): at the cap,
 * reached through real counted failures, P reports `restart-limit-reached`
 * with either outage raised, its timer armed or not. An UNCLASSIFIED answer on the attempt's row reads,
 * P's unclassified-error episode open, never gives `not-answering`.
 * Only the pin case holds the SRD's numbers; every other case derives its
 * waits from the exported base and ceiling through `doublingBackoffDelay`. No
 * retry timer is real; the only real-time waits are the spawn path's 1 ms
 * polls, bounded by the harness (`settle`), the working-row wait's
 * `WAIT_POLL_MS` sleep after a failed poll, and one 0 ms `setTimeout` a
 * frames case sets inside an attempt and awaits.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { classifyAdError, describeAgentDirectorFailure } from '../src/ad-error-class.ts'
import { adAlertThresholdMs, adAlertThresholdMsInEffect, DEFAULT_AD_SETTINGS_IN_EFFECT } from '../src/ad-settings.ts'
import { ERR_SCHEMA_MISMATCH_NAME, ErrCwdNotFound } from '../src/agent-director-errors.ts'
import { _resetBackoffState, doublingBackoffDelay, getFailureCount, isAtCap, recordFailure } from '../src/backoff.ts'
import type { Persona } from '../src/config.ts'
import {
  CONFLICT_LATCH_SET_LATCHED,
  LATCH_CASE_LEFTOVER,
  LATCH_ROW_STATE_NO_ROW,
  REFUSED_OPERATION_PLAIN_SPAWN,
  launchStartNotRecordedNoticeText,
  type LatchRowState,
} from '../src/conflict-latch.ts'
import { runJsonlPersistenceSafeguard } from '../src/jsonl-persistence-check.ts'
import type { LostMessageState } from '../src/lost-message.ts'
import { LIVENESS_LIVE, LIVENESS_PENDING, LIVENESS_READING_UNKNOWN, type PendingLivenessReading } from '../src/liveness-reading.ts'
import {
  adConfigMalformedOnset,
  ALL_CLEAR_TEMPLATE,
  clearOutageFlag,
  getOutageFlags,
  ONSET_TEMPLATES,
  setOutageFlag,
  tmuxServerChangedOnset,
  withOutageDetection,
  type OutageClass,
} from '../src/outage-state.ts'
import { _resetPollerState, stopPermissionPoller, type PollerDeps } from '../src/permission-poller.ts'
import { MAX_LOGGED_MESSAGE_LENGTH } from '../src/persona-connection-errors.ts'
import { personaInstanceId, personaTmuxSessionName, renderPersonaRef } from '../src/persona-identity.ts'
import {
  PERSONA_UNCLASSIFIED_ERROR_LABEL,
  TMUX_UNRESPONSIVE_END_LATCHED,
  TMUX_UNRESPONSIVE_END_RETRY,
  TMUX_UNRESPONSIVE_END_TICK,
  TMUX_UNRESPONSIVE_END_TMUX_VERB,
  TMUX_UNRESPONSIVE_ONSET_FLOOR_MS,
  tmuxUnresponsiveAlertText,
  tmuxUnresponsiveOnsetText,
  tmuxUnresponsiveRecoveryText,
  UNCLASSIFIED_ERROR_END_CAPPED,
  UNCLASSIFIED_ERROR_END_CONDITION_ENDED,
  UNCLASSIFIED_ERROR_END_LATCHED,
  UNCLASSIFIED_ERROR_END_RECOVERED,
  UNCLASSIFIED_ERROR_END_ROW_LIVE,
  unclassifiedErrorAlertText,
  type TmuxUnresponsiveEndReason,
  type UnclassifiedErrorEndReason,
} from '../src/persona-episodes.ts'
import {
  _resetRestartState,
  isRestartPendingOrActive,
  RESTART_FAILURE_CAP,
  RESTART_OUTCOME_ALREADY_CONNECTED,
  RESTART_OUTCOME_CAPPED,
  RESTART_OUTCOME_COUNTED_FAILURE,
  RESTART_OUTCOME_IN_FLIGHT,
  RESTART_OUTCOME_LATCHED,
  RESTART_OUTCOME_LAUNCH_SKIPPED,
  RESTART_OUTCOME_LAUNCHED,
  RESTART_OUTCOME_LIVENESS_UNKNOWN,
  RESTART_OUTCOME_NOT_INITIALISED,
  RESTART_OUTCOME_NOT_UP,
  RESTART_OUTCOME_PENDING_DEFERRED,
  RESTART_OUTCOME_RECONNECT_DEFERRED,
  RESTART_OUTCOME_RECONNECTED,
  RESTART_OUTCOME_REFUSED,
  RESTART_OUTCOME_SHUTTING_DOWN,
  runRestartRetry,
  scheduleRestart,
  type RestartRetryOutcome,
} from '../src/restart.ts'
import { _buildIsSessionAliveAdapter, deferPendingRow } from '../src/server.ts'
import {
  _resetConfigDirFs,
  _resetNotConnectedEpisodes,
  _resetNow,
  _resetWaitForWaitingTimeoutMs,
  _setConfigDirFs,
  _setNow,
  _setWaitForWaitingTimeoutMs,
  APPROVER_STOP_FINISHED,
  APPROVER_STOP_GONE,
  APPROVER_STOP_LIVE,
  APPROVER_STOP_NOT_INTERACTIVE,
  APPROVER_STOP_TEARDOWN,
  DIALOG_POLL_INTERVAL_MS,
  isLaunchInFlight,
  killPersonaInstance,
  reconcileOrphans,
  stopDialogApprover,
  sweepDeadTmuxChannel,
  TRUST_DIALOG_NEEDLE,
  waitEndedDisconnectedLine,
  waitPollStatusErrorLine,
  waitTimedOutUnreadReport,
  type ApproverStopReason,
  type ApproverVerb,
  type SpawnPersonaResult,
} from '../src/session-manager.ts'
import {
  createFullModeRetryAction,
  createUnavailableRetryController,
  type FullModeRetryDeps,
  isInsideAttempt,
  reportAttemptError,
  runInAttempt,
  type AttemptErrorRecord,
  type AttemptView,
  UNAVAILABLE_RETRY_AGAIN_LAUNCH_FAILED,
  UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT,
  UNAVAILABLE_RETRY_AGAIN_LAUNCHED,
  UNAVAILABLE_RETRY_AGAIN_LIVENESS_UNKNOWN,
  UNAVAILABLE_RETRY_AGAIN_PENDING_DEFERRED,
  UNAVAILABLE_RETRY_AGAIN_RECONNECT_DEFERRED,
  UNAVAILABLE_RETRY_AGAIN_RESTART_NOT_INITIALISED,
  UNAVAILABLE_RETRY_AGAIN_ROW_PENDING,
  UNAVAILABLE_RETRY_BASE_S,
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
  UNAVAILABLE_RETRY_CAUSE_KILL_FAILED,
  UNAVAILABLE_RETRY_CAUSE_PENDING_ROW,
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED,
  UNAVAILABLE_RETRY_CEILING_S,
  UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE,
  UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE,
  UNAVAILABLE_RETRY_KEPT_KILL_FAILED,
  UNAVAILABLE_RETRY_KEPT_ROW_PENDING,
  UNAVAILABLE_RETRY_MODE_FULL,
  UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
  UNAVAILABLE_RETRY_ROW_ABSENT,
  UNAVAILABLE_RETRY_ROW_PENDING,
  UNAVAILABLE_RETRY_STOP_CAPPED,
  UNAVAILABLE_RETRY_STOP_LATCHED,
  UNAVAILABLE_RETRY_STOP_LAUNCH_SKIPPED,
  UNAVAILABLE_RETRY_STOP_NOT_APPLIED,
  UNAVAILABLE_RETRY_STOP_NOT_UP,
  UNAVAILABLE_RETRY_STOP_RECOVERED,
  UNAVAILABLE_RETRY_STOP_ROW_GONE,
  UNAVAILABLE_RETRY_STOP_ROW_LIVE,
  UNAVAILABLE_RETRY_STOP_RUN_FAILED,
  UNAVAILABLE_RETRY_STOP_SHUTDOWN,
  UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED,
  UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED,
  UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  UNAVAILABLE_RETRY_TERMINAL_STOPS,
  unavailableRetryCauseFor,
  type UnavailableRetryAction,
  type UnavailableRetryCause,
  type UnavailableRetryCondition,
  type UnavailableRetryController,
  type UnavailableRetryDeps,
  type UnavailableRetryMode,
  type UnavailableRetryOutcome,
  type UnavailableRetryRowRead,
  type UnavailableRetryTriggerSink,
} from '../src/unavailable-retry.ts'
import type { AdConfigTables } from './test-helpers/ad-settings.ts'
import {
  cannedErr,
  cannedListRow,
  cannedStatusResult,
  errCallTimeout,
  errConfigMalformed,
  errGeneric,
  errInstanceIdCollision,
  errInternal,
  errJsonlNeverWritten,
  errSchemaMismatch,
  errSpawnNotFound,
  errSpawnNotInteractive,
  errSystemInstallDisappeared,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxNotAvailableDifferentServer,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  errUnusableName,
  holdSpawns,
  SAMPLE_LAUNCH_START_FRACTIONAL,
  SAMPLE_LAUNCH_STARTS,
  unavailableForms,
} from './test-helpers/agent-director-stub.ts'
import {
  assertNoLeak,
  BOT_TOKEN_PREFIX,
  fakeToken,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
import {
  APPROVER_VERB_CALLS,
  NO_LAUNCH_START_FORMS,
  NO_LAUNCH_START_FORM_NAMES,
  conflictForPersona,
  conflictNoticeForPersona,
  launchStartRecord,
} from './test-helpers/conflict-cases.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { startManualPoller } from './test-helpers/permission-relay-harness.ts'
import {
  callCounts,
  collided,
  conditionEndedLine,
  conditionLinePrefix,
  conditionLines,
  conditionRecoveryLine,
  adConfigMalformedRaiseLines,
  expectLostMessageReports,
  makeRecoveryHarness,
  personaCallCounts,
  personaOf,
  retryNow,
  unclassifiedEndedLine,
  unclassifiedLines,
  unclassifiedLoggedLine,
  unclassifiedPostedLine,
  unclassifiedStartedLine,
  type RecoveryAttempt,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
  type RecoveryNotice,
  type RecoveryStubScript,
} from './test-helpers/recovery-harness.ts'
import { stripComments } from './test-helpers/source-audit.ts'

const KEY = 'alpha'
const OTHER = 'beta'
const UNAVAILABLE = { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE } as const

/** The wait after `refusals` refused retries, in ms, from the exported base and ceiling. */
function waitMs(refusals: number): number {
  return doublingBackoffDelay(UNAVAILABLE_RETRY_BASE_S, refusals, UNAVAILABLE_RETRY_CEILING_S) * 1000
}

/** Refusals until the wait reaches the ceiling. */
function refusalsToCeiling(): number {
  let n = 0
  while (waitMs(n) < UNAVAILABLE_RETRY_CEILING_S * 1000) n++
  return n
}

/** A bare controller on its own fake clock, with its lines and the retries its action saw. */
interface Rig {
  readonly clock: FakeClock
  readonly controller: UnavailableRetryController
  readonly lines: string[]
  readonly attempts: RecoveryAttempt[]
}

let rigs: Rig[] = []
/** The test's recovery harness, if it built one: checked, leak-checked and cleaned up in `afterEach`. */
let harness: RecoveryHarness | undefined
/** A describe's own end-of-test check on the harness, run in `afterEach` before its leak check (the cleanup runs either way). */
let harnessEndCheck: ((h: RecoveryHarness) => void) | undefined

/**
 * Build a rig; its action refuses every retry unless `action` is given. The
 * retry observer and the stop observer are each passed only when given (else
 * the deps have no such key).
 */
function makeRig(
  action: UnavailableRetryAction = () => ({ kind: 'again' }),
  clock = createFakeClock(),
  onRetryFire?: UnavailableRetryDeps['onRetryFire'],
  onStopped?: UnavailableRetryDeps['onStopped'],
): Rig {
  const lines: string[] = []
  const attempts: RecoveryAttempt[] = []
  const controller = createUnavailableRetryController({
    clock,
    log: (line) => { lines.push(line) },
    action: (key, attempt) => {
      attempts.push({ key, retry: attempt.retry, causes: attempt.causes, mode: attempt.mode, at: clock.now() })
      return action(key, attempt)
    },
    ...(onRetryFire !== undefined ? { onRetryFire } : {}),
    ...(onStopped !== undefined ? { onStopped } : {}),
  })
  const rig = { clock, controller, lines, attempts }
  rigs.push(rig)
  return rig
}

/** An action whose answers (or rejections) the test gives, one retry at a time. */
function heldAction(): {
  action: UnavailableRetryAction
  answer(outcome: UnavailableRetryOutcome): void
  fail(err: Error): void
} {
  const waiting: Array<{ resolve: (outcome: UnavailableRetryOutcome) => void; reject: (err: Error) => void }> = []
  const next = (): { resolve: (outcome: UnavailableRetryOutcome) => void; reject: (err: Error) => void } => {
    const held = waiting.shift()
    if (held === undefined) throw new Error('heldAction: no retry is waiting for an answer')
    return held
  }
  return {
    action: () => new Promise<UnavailableRetryOutcome>((resolve, reject) => { waiting.push({ resolve, reject }) }),
    answer: (outcome) => next().resolve(outcome),
    fail: (err) => next().reject(err),
  }
}

const delays = (clock: FakeClock): number[] => clock.pending().map((timer) => timer.delayMs)

/** A fake clock whose `setTimeout` throws `err` once, at its first call after `prime()`. */
function throwingClock(err: Error): { clock: FakeClock; prime(): void } {
  const base = createFakeClock()
  let primed = false
  const setTimeout: FakeClock['setTimeout'] = (callback, delayMs) => {
    if (primed) {
      primed = false
      throw err
    }
    return base.setTimeout(callback, delayMs)
  }
  return { clock: { ...base, setTimeout }, prime: () => { primed = true } }
}

beforeEach(() => {
  rigs = []
  harness = undefined
  harnessEndCheck = undefined
  _resetBackoffState()
  _resetRestartState()
})

afterEach(() => {
  const clocks = rigs.map((rig) => rig.clock)
  const h = harness
  harness = undefined
  try {
    for (const rig of rigs) rig.controller.stopAll('the test is over')
    if (h !== undefined) {
      clocks.push(h.clock)
      // A failed check must not skip the cleanup: bun runs no later hook once one throws.
      try {
        harnessEndCheck?.(h)
        assertNoLeak(h.captured())
      } finally {
        h.cleanup()
      }
    }
  } finally {
    _resetBackoffState()
    _resetRestartState()
  }
  for (const clock of clocks) expect(clock.pendingCount()).toBe(0)
  assertNoLeak(rigs.map((rig) => rig.lines), 'retry lines')
})

describe('unavailable retry: the schedule', () => {
  test('arming asks for the first wait and runs nothing yet', () => {
    const { clock, controller, attempts } = makeRig()
    controller.arm(KEY, UNAVAILABLE)

    expect(delays(clock)).toEqual([waitMs(0)])
    expect(controller.view(KEY)).toEqual({ phase: 'waiting', dueAt: waitMs(0), waitMs: waitMs(0), refusals: 0, causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE], mode: UNAVAILABLE_RETRY_MODE_FULL })
    expect(attempts).toEqual([])
  })

  test('each refusal re-arms at the doubled wait up to the ceiling; no retry fires 1 ms early and each fires exactly at its due time', async () => {
    const { clock, controller, attempts } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    const steps = refusalsToCeiling() + 2

    for (let n = 0; n < steps; n++) {
      const dueAt = clock.now() + waitMs(n)
      expect(delays(clock)).toEqual([waitMs(n)])
      await clock.advance(waitMs(n) - 1)
      expect(attempts).toHaveLength(n)
      await clock.advance(1)
      expect(attempts).toHaveLength(n + 1)
      expect(attempts[n]).toEqual({ key: KEY, retry: n + 1, causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE], mode: UNAVAILABLE_RETRY_MODE_FULL, at: dueAt })
    }
    expect(controller.view(KEY)).toMatchObject({ phase: 'waiting', waitMs: UNAVAILABLE_RETRY_CEILING_S * 1000, refusals: steps })
  })

  test('the pin: a 30 s base, a 300 s ceiling, and retries at 30, 90, 210, 450 and 750 s after the arm, then every 300 s', async () => {
    expect(UNAVAILABLE_RETRY_BASE_S).toBe(30)
    expect(UNAVAILABLE_RETRY_CEILING_S).toBe(300)
    const { clock, controller, attempts } = makeRig()
    const armedAt = clock.now()
    controller.arm(KEY, UNAVAILABLE)

    for (let i = 0; i < 7; i++) await clock.runNext()

    expect(attempts.map((a) => (a.at - armedAt) / 1000)).toEqual([30, 90, 210, 450, 750, 1050, 1350])
  })

  test('a stop leaves nothing pending and runs nothing more, and a later arm starts at the first wait again', async () => {
    const { clock, controller, attempts } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    await clock.runNext()
    await clock.runNext()
    expect(controller.view(KEY)?.refusals).toBe(2)

    controller.stop(KEY, 'nothing left to recover')
    expect(clock.pendingCount()).toBe(0)
    expect(controller.isArmed(KEY)).toBe(false)
    expect(controller.view(KEY)).toBeUndefined()
    await clock.advance(waitMs(refusalsToCeiling()) * 2)
    expect(attempts).toHaveLength(2)

    controller.arm(KEY, UNAVAILABLE)
    expect(delays(clock)).toEqual([waitMs(0)])
    expect(controller.view(KEY)?.refusals).toBe(0)
  })

  test('a stop answer ends the timer and leaves nothing pending', async () => {
    const { clock, controller, attempts } = makeRig(() => ({ kind: 'stop', reason: 'the persona recovered' }))
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))
    await controller.whenRunSettled(KEY)

    expect(attempts).toHaveLength(1)
    expect(controller.isArmed(KEY)).toBe(false)
    expect(clock.pendingCount()).toBe(0)
  })

  test.each<[string, (err: Error) => UnavailableRetryAction]>([
    ['throws', (err) => () => { throw err }],
    ['rejects', (err) => async () => { throw err }],
  ])('an action that %s counts as a refusal: re-armed at the next wait, its error logged only as its redacted description', async (_how, make) => {
    const err = Object.assign(errGeneric('spawn', 'ErrTmuxNotAvailable', `spawn refused (${sentinelInMessage('retry')})`), { detail: LEAK_SENTINEL })
    const { clock, controller, lines } = makeRig(make(err))
    controller.arm(KEY, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, error: err })
    await clock.advance(waitMs(0))
    await controller.whenRunSettled(KEY)

    expect(delays(clock)).toEqual([waitMs(1)])
    expect(controller.view(KEY)?.refusals).toBe(1)
    const described = lines.filter((line) => line.includes('errName=ErrTmuxNotAvailable'))
    expect(described).toHaveLength(2)
    for (const line of described) {
      expect(line).toContain('AgentDirectorError errName=ErrTmuxNotAvailable message="')
      expect(line).toContain(`spawn refused (${REDACTED_SENTINEL_TAIL})"`)
    }
    assertNoLeak(lines)
  })

  test.each<[string, unknown]>([
    ['no answer', undefined],
    ['an unknown answer', { kind: 'later' }],
  ])('an action that gives %s counts as a refusal and re-arms at the next wait', async (_what, answer) => {
    const { clock, controller } = makeRig(() => answer as UnavailableRetryOutcome)
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))

    expect(delays(clock)).toEqual([waitMs(1)])
    expect(controller.view(KEY)?.refusals).toBe(1)
  })

  test.each<[string, UnavailableRetryCause]>([
    ['a token-shaped cause kind', { kind: fakeToken(BOT_TOKEN_PREFIX, 'kind') }],
    ['a missing cause (an untyped caller)', undefined as unknown as UnavailableRetryCause],
  ])('%s is recorded and logged as unnamed, so a token in it never reaches a line', (_what, cause) => {
    const { controller, lines } = makeRig()
    controller.arm(KEY, cause)

    expect(controller.view(KEY)?.causes).toEqual(['unnamed'])
    assertNoLeak(lines)
  })

  test.each<[string, string, (rig: Rig, prime: () => void) => Promise<void>]>([
    ['the first arm', 'arm failed', async ({ controller }, prime) => {
      prime()
      expect(() => controller.arm(KEY, UNAVAILABLE)).not.toThrow()
    }],
    ['the re-arm after a refused retry', 'retry run failed', async ({ clock, controller }, prime) => {
      controller.arm(KEY, UNAVAILABLE)
      prime()
      await clock.advance(waitMs(0))
      await controller.whenRunSettled(KEY)
    }],
  ])('a clock that throws at %s forgets the persona with one "%s" line, its error redacted, and the next arm starts at the first wait', async (_when, failed, drive) => {
    const { clock, prime } = throwingClock(new Error(`the clock refused (${sentinelInMessage('clock')})`))
    const rig = makeRig(undefined, clock)
    const { controller, lines } = rig
    await drive(rig, prime)

    const failures = lines.filter((line) => line.includes(failed))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toStartWith(`[slack] unavailable-retry: persona=${KEY} ${failed}: Error message="the clock refused (${REDACTED_SENTINEL_TAIL})"`)
    if (failed === 'arm failed') {
      expect(failures[0]).toEndWith(' — not armed')
      expect(lines).toEqual(failures)
    }
    expect(lines.filter((line) => line.includes('re-armed'))).toEqual([])
    expect(controller.isArmed(KEY)).toBe(false)
    expect(controller.view(KEY)).toBeUndefined()
    expect(clock.pendingCount()).toBe(0)
    assertNoLeak(lines)

    controller.arm(KEY, UNAVAILABLE)
    expect(delays(clock)).toEqual([waitMs(0)])
    expect(controller.view(KEY)).toMatchObject({ phase: 'waiting', refusals: 0 })
  })
})

describe('unavailable retry: never gives up and never uses the restart counter', () => {
  test('after refusals well past RESTART_FAILURE_CAP the timer is still armed at the ceiling and no failure is counted', async () => {
    const { clock, controller, attempts } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    const refusals = RESTART_FAILURE_CAP * 3 + refusalsToCeiling()

    for (let i = 0; i < refusals; i++) await clock.runNext()

    expect(attempts).toHaveLength(refusals)
    expect(controller.view(KEY)).toMatchObject({ phase: 'waiting', waitMs: UNAVAILABLE_RETRY_CEILING_S * 1000, refusals })
    expect(getFailureCount(KEY)).toBe(0)
    expect(isAtCap(KEY, RESTART_FAILURE_CAP)).toBe(false)
  })

  test('a failure count recorded beforehand changes no wait, and the retries leave it as it was', async () => {
    for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(KEY)
    const { clock, controller } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    expect(delays(clock)).toEqual([waitMs(0)])

    await clock.runNext()
    expect(delays(clock)).toEqual([waitMs(1)])
    expect(getFailureCount(KEY)).toBe(RESTART_FAILURE_CAP)
  })
})

describe('unavailable retry: arming while armed', () => {
  test('arming while waiting keeps the due time and the wait count, and records the new cause', async () => {
    const { clock, controller } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    await clock.runNext()
    const before = controller.view(KEY)
    await clock.advance(waitMs(1) / 2)

    controller.arm(KEY, { kind: 'status-error' })

    expect(clock.pending().map((t) => t.dueAt)).toEqual([before!.dueAt!])
    expect(controller.view(KEY)).toEqual({ ...before!, causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, 'status-error'] })
  })

  test('arming while a run is in flight changes nothing pending; the re-arm is measured from the run’s end and the next retry sees the cause', async () => {
    const held = heldAction()
    const { clock, controller, attempts } = makeRig(held.action)
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))
    expect(controller.view(KEY)?.phase).toBe('running')

    controller.arm(KEY, { kind: 'status-error' })
    expect(clock.pendingCount()).toBe(0)
    expect(controller.view(KEY)).toEqual({ phase: 'running', refusals: 0, causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, 'status-error'], mode: UNAVAILABLE_RETRY_MODE_FULL })

    await clock.advance(waitMs(0) / 2)
    const runEnd = clock.now()
    held.answer({ kind: 'again' })
    await controller.whenRunSettled(KEY)

    expect(clock.pending().map((t) => t.dueAt)).toEqual([runEnd + waitMs(1)])
    await clock.advance(waitMs(1))
    expect(attempts[1]).toEqual({ key: KEY, retry: 2, causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, 'status-error'], mode: UNAVAILABLE_RETRY_MODE_FULL, at: runEnd + waitMs(1) })
    held.answer({ kind: 'stop', reason: 'the test is over' })
    await controller.whenRunSettled(KEY)
  })

  test('a run in flight when stopped has its answer dropped, and the next arm’s retry waits for that run to settle', async () => {
    const held = heldAction()
    const { clock, controller, attempts } = makeRig(held.action)
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))
    controller.stop(KEY, 'the persona left the configuration')
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))
    expect(attempts).toHaveLength(1)

    held.answer({ kind: 'stop', reason: 'the old run ended' })
    await clock.flush()
    expect(attempts).toHaveLength(2)
    expect(controller.view(KEY)).toEqual({ phase: 'running', refusals: 0, causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE], mode: UNAVAILABLE_RETRY_MODE_FULL })

    held.answer({ kind: 'again' })
    await controller.whenRunSettled(KEY)
    expect(delays(clock)).toEqual([waitMs(1)])
  })
})

describe('unavailable retry: what arm answers (SRJ-301)', () => {
  test.each<[string, () => Promise<readonly [boolean, boolean]>, boolean]>([
    ['newly armed', async () => {
      const { controller } = makeRig()
      return [controller.arm(KEY, UNAVAILABLE), controller.isArmed(KEY)]
    }, true],
    ['already armed and waiting', async () => {
      const { controller } = makeRig()
      controller.arm(KEY, UNAVAILABLE)
      return [controller.arm(KEY, { kind: 'status-error' }), controller.isArmed(KEY)]
    }, true],
    ['running its retry', async () => {
      const { controller, held } = await heldRun(armUnavailable)
      const answered = [controller.arm(KEY, { kind: 'status-error' }), controller.isArmed(KEY)] as const
      held.answer({ kind: 'stop', reason: 'the test is over' })
      await controller.whenRunSettled(KEY)
      return answered
    }, true],
    ['closed', async () => {
      const { controller } = makeRig()
      controller.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
      return [controller.arm(KEY, UNAVAILABLE), controller.isArmed(KEY)]
    }, false],
    ['its clock throwing at the first arm', async () => {
      const { clock, prime } = throwingClock(new Error('the clock refused'))
      const { controller } = makeRig(undefined, clock)
      prime()
      return [controller.arm(KEY, UNAVAILABLE), controller.isArmed(KEY)]
    }, false],
  ])('arm answers whether the persona has a timer after the call: %s', async (_what, arm, expected) => {
    expect(await arm()).toEqual([expected, expected])
  })

  test.each<[string, () => UnavailableRetryTriggerSink]>([
    ['a sink that answers false', () => ({ arm: () => false })],
    ['a sink that answers nothing (an untyped caller)', () => ({ arm: () => undefined as unknown as boolean })],
    ['a closed controller', () => {
      const { controller } = makeRig()
      controller.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
      return controller
    }],
  ])('reportAttemptError inside an attempt with %s answers false and records the error as not armed', async (_what, makeSink) => {
    const sink = makeSink()

    const [answered, record] = await runInAttempt(KEY, 'recovery', (view) => [reportAttemptError(KEY, errCallTimeout('status'), 'status', sink), view.lastError] as const)

    expect(answered).toBe(false)
    expect(record).toEqual({ verb: 'status', causeKind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, armed: false })
  })
})

describe('unavailable retry: isolation', () => {
  test('two personas keep separate schedules', async () => {
    const { clock, controller } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    await clock.runNext()
    const bArmedAt = clock.now()
    controller.arm(OTHER, UNAVAILABLE)

    expect(controller.view(KEY)).toMatchObject({ refusals: 1, dueAt: bArmedAt + waitMs(1) })
    expect(controller.view(OTHER)).toMatchObject({ refusals: 0, dueAt: bArmedAt + waitMs(0) })
    expect(controller.armedKeys()).toEqual([KEY, OTHER])
  })

  test('stopping one persona leaves the other armed with its due time', async () => {
    const { clock, controller, attempts } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    controller.arm(OTHER, { kind: 'status-error' })
    const otherDue = controller.view(OTHER)!.dueAt!

    controller.stop(KEY, 'nothing left to recover')

    expect(controller.view(OTHER)).toMatchObject({ phase: 'waiting', dueAt: otherDue })
    await clock.advance(waitMs(0))
    expect(attempts.map((a) => a.key)).toEqual([OTHER])
  })

  test('stop-all clears exactly the retry timers', () => {
    const { clock, controller } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    controller.arm(OTHER, UNAVAILABLE)
    const unrelated = clock.setTimeout(() => {}, waitMs(0))

    controller.stopAll('the server is shutting down')

    expect(clock.pending().map((t) => t.id)).toEqual([unrelated.id])
    expect(controller.armedKeys()).toEqual([])
    clock.clearTimeout(unrelated)
  })

  test('two controllers on two clocks share nothing', async () => {
    const first = makeRig()
    const second = makeRig()
    first.controller.arm(KEY, UNAVAILABLE)
    second.controller.arm(KEY, UNAVAILABLE)

    await first.clock.runNext()
    first.controller.stop(KEY, 'nothing left to recover')

    expect(second.attempts).toEqual([])
    expect(second.controller.view(KEY)).toMatchObject({ phase: 'waiting', dueAt: waitMs(0), refusals: 0 })
    expect(delays(second.clock)).toEqual([waitMs(0)])
  })
})

describe('unavailable retry: settings independence (SRJ-304)', () => {
  test('on the recovery harness with session_restart_delay and health_check_interval 0, an armed persona is retried on the schedule and scheduleRestart arms nothing', async () => {
    harness = makeRecoveryHarness({ action: 'scripted' })
    const h = harness
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    const persona = h.config.personas[0]!

    scheduleRestart(key, persona.working_directory)
    expect(isRestartPendingOrActive(key)).toBe(false)

    const armedAt = h.clock.now()
    h.controller.arm(key, UNAVAILABLE)
    const retries = 3
    const expected = Array.from({ length: retries }, (_, i) => Array.from({ length: i + 1 }, (__, j) => waitMs(j)).reduce((a, b) => a + b))
    await h.advance(expected[retries - 1]!)

    expect(h.attempts.map((a) => [a.key, a.at - armedAt])).toEqual(expected.map((at) => [key, at]))
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', refusals: retries })
    expect(h.controller.isArmed(other)).toBe(false)
    expect(isRestartPendingOrActive(key)).toBe(false)
    expect(getFailureCount(key)).toBe(0)
    expect(h.stub.callCount()).toBe(0)
    assertNoLeak(h.captured())
  })

  const retrySource = stripComments(readFileSync(join(import.meta.dir, '..', 'src', 'unavailable-retry.ts'), 'utf-8'))

  test.each(['session_restart_delay', 'getRestartDelay', 'health_check_interval'])('src/unavailable-retry.ts names no %s', (name) => {
    expect(retrySource).not.toContain(name)
  })

  test('src/unavailable-retry.ts takes only doublingBackoffDelay from the backoff module and nothing but types from the restart module', () => {
    const backoffImports = [...retrySource.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/backoff\.ts'/g)].map((m) => m[1]!.split(',').map((s) => s.trim()).filter(Boolean))
    expect(backoffImports).toEqual([['doublingBackoffDelay']])
    const restartClauses = [...retrySource.matchAll(/\b(?:import|export)\s+(type\s+)?([^'";=()]*?)\s*from\s*'\.\/restart\.ts'/g)]
    const valueSpecifiers = restartClauses.flatMap(([, typeOnly, clause]) =>
      typeOnly !== undefined ? [] : clause!.replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter((s) => s !== '' && !s.startsWith('type ')),
    )
    expect(valueSpecifiers).toEqual([])
    expect(retrySource).not.toMatch(/import\s*'\.\/restart\.ts'|import\s*\(\s*'\.\/restart\.ts'|require\s*\(\s*'\.\/restart\.ts'/)
  })
})

// ---------------------------------------------------------------------------
// What arms the timer (b.jg5 SRJ-301)
// ---------------------------------------------------------------------------

/** A site of the launch path where an agent-director call made through the wrappers meets `err`. */
interface LaunchSite {
  readonly name: string
  readonly verb: string
  script(h: RecoveryHarness, persona: Persona, err: Error): RecoveryStubScript
  /**
   * The launch's action when this site's call fails: `failed` for a refusal
   * that stops the launch; for the working-row read, whose failed poll lets
   * the wait go on (b.jg5 SRJ-605), the action of the launch whose next poll
   * reads `waiting` and reconnects.
   */
  readonly action: SpawnPersonaResult['action']
  /**
   * For the sites whose refusal stops the launch at once (b.jg5 SRJ-105): the
   * stub calls the launch makes in all. An UNAVAILABLE at the ladder's kill
   * or delete (`ErrTmuxKillFailed` included) means no delete after a refused
   * kill and no spawn after either, so the optimistic spawn is the launch's
   * only one; one at the sweep before a working-row wait means no row read
   * and no reconnect after it.
   */
  readonly ladderCalls?: Readonly<Record<string, number>>
  /**
   * True when this site's call is tmux-touching and nothing after it in the
   * launch touches tmux: the `tmux-unresponsive` condition an UNAVAILABLE
   * refusal here starts still holds when the launch returns (b.jg5 SRJ-307).
   * A kill-failure cause starts no condition.
   */
  readonly leavesConditionHeld?: boolean
  /**
   * True when this site's call is not tmux-touching and the launch stops at
   * its refusal: no `tmux-unresponsive` condition starts (b.jg5 SRJ-307).
   */
  readonly startsNoCondition?: boolean
}

const LAUNCH_SITES: readonly LaunchSite[] = [
  { name: 'the optimistic spawn', verb: 'spawn', action: 'failed', script: (_h, _p, err) => ({ spawnError: err }) },
  { name: 'the collision get', verb: 'get', action: 'failed', script: (_h, _p, err) => ({ spawnQueue: [cannedErr(errInstanceIdCollision())], getError: err }) },
  { name: 'the reconnect of a waiting row', verb: 'send-keys', action: 'failed', script: (h, p, err) => ({ ...collided(h, p, { state: 'waiting' }), sendKeysError: err }) },
  {
    name: 'the sweep before a working-row wait',
    verb: 'find-missing',
    action: 'failed',
    ladderCalls: { spawnCalls: 1, getCalls: 1, findMissingCalls: 1 },
    startsNoCondition: true,
    script: (h, p, err) => ({ ...collided(h, p, { state: 'working' }), findMissingError: err }),
  },
  // b.jg5 SRJ-605: the wait's first poll meets the error and goes on; its next
  // poll reads the stub's default `waiting` row, and the launch reconnects.
  {
    name: 'the working-row read',
    verb: 'status',
    action: 'reconnected',
    script: (h, p, err) => ({ ...collided(h, p, { state: 'working' }), statusQueue: [cannedErr(err)] }),
  },
  // The collision get reads the row `waiting` (live), so its kill is tmux-touching.
  {
    name: 'the kill of a row in another directory',
    verb: 'kill',
    action: 'failed',
    ladderCalls: { spawnCalls: 1, getCalls: 1, killCalls: 1 },
    leavesConditionHeld: true,
    script: (h, p, err) => ({ ...collided(h, p, { cwd: h.home }), killError: err }),
  },
  {
    name: 'the delete of a row in another directory',
    verb: 'delete',
    action: 'failed',
    ladderCalls: { spawnCalls: 1, getCalls: 1, killCalls: 1, deleteCalls: 1 },
    script: (h, p, err) => ({ ...collided(h, p, { cwd: h.home }), deleteError: err }),
  },
  { name: 'the resume of an ended row', verb: 'resume', action: 'failed', script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), resumeError: err }) },
]

/** The sites whose verb is a read (`status`, `get`). */
const READ_SITES = LAUNCH_SITES.filter((site) => site.verb === 'status' || site.verb === 'get')

/** E4's UNAVAILABLE values, each with the cause kind it arms. */
const UNAVAILABLE_VALUES = unavailableForms(
  'ErrTmuxUnresponsive',
  'ErrTmuxKillFailed',
  'ErrCallTimeout',
  ['ErrUnknownErrorName', 'an unknown error name from a later binary'],
  'a wrapped UnknownError',
  'a plain Error',
)

/** Read errors that are neither UNAVAILABLE nor excluded: a STATE and a GONE answer. */
const READ_ERRORS: ReadonlyArray<readonly [string, (verb: string) => Error]> = [
  ['a STATE answer (ErrSpawnNotInteractive)', (verb) => errSpawnNotInteractive(verb)],
  ['a GONE answer (ErrTmuxCaptureFailed)', (verb) => errTmuxCaptureFailed(undefined, verb)],
]

/**
 * The result a launch that met an arming error at a site with `action`
 * answers: a failure carries the refusal marker; any other action (the
 * working-row wait's, which goes on past a failed read, b.jg5 SRJ-605) is
 * the wait's own outcome, unmarked.
 */
function armedResult(key: string, action: SpawnPersonaResult['action']): SpawnPersonaResult {
  return action === 'failed' ? { key, action, refused: true } : { key, action }
}

/**
 * The working-row wait's poll interval in the launch cases, in real ms. The
 * wait sleeps its configuration's `agent_director_poll_interval_ms` between
 * polls on the real timer, so a case whose wait goes on past a failed read
 * (b.jg5 SRJ-605) polls again at once.
 */
const WAIT_POLL_MS = 1

/** A recovery harness for a launch case, its working-row wait polling every `WAIT_POLL_MS`. */
function launchHarness(options?: RecoveryHarnessOptions): RecoveryHarness {
  const h = (harness = makeRecoveryHarness(options))
  h.config.agent_director_poll_interval_ms = WAIT_POLL_MS
  return h
}

/**
 * Persona `key`'s timer was armed once, at the base wait from now, with
 * `kind`; no other persona's was. `triggers` is how many triggers the
 * persona's failed calls sent (one by default; a trigger while armed keeps
 * the one due time). `lastRow` is the row it last read, when one is recorded.
 */
function expectArmedOnce(h: RecoveryHarness, key: string, kind: string, lastRow?: string, triggers = 1): void {
  expect(h.triggers).toEqual(Array.from({ length: triggers }, () => ({ key, kind })))
  expect(h.controller.armedKeys()).toEqual([key])
  expect(h.controller.view(key)).toEqual({
    phase: 'waiting',
    dueAt: h.clock.now() + waitMs(0),
    waitMs: waitMs(0),
    refusals: 0,
    causes: [kind],
    mode: UNAVAILABLE_RETRY_MODE_FULL,
    ...(lastRow !== undefined ? { lastRow } : {}),
  })
  expect(delays(h.clock)).toEqual([waitMs(0)])
  expect(h.attempts).toEqual([])
}

/**
 * Harness options for a case about the retry timer alone, whose refusal
 * starts the `tmux-unresponsive` condition: no alert check is armed
 * (`alertThresholdMs: false`), so the only timer on the clock is the retry
 * timer the case checks. The alert check is covered where it is part of the
 * story: the AC 26 and AC 30 alert cases below and
 * `tests/tmux-unresponsive.test.ts`.
 */
const RETRY_TIMER_ONLY: RecoveryHarnessOptions = { alertThresholdMs: false }

/** No trigger was sent and nothing is armed or pending. */
function expectNothingArmed(h: RecoveryHarness): void {
  expect(h.triggers).toEqual([])
  expect(h.controller.armedKeys()).toEqual([])
  expect(h.clock.pendingCount()).toBe(0)
}

describe('unavailable retry: what arms the timer (SRJ-301)', () => {
  const unavailableCross = UNAVAILABLE_VALUES.flatMap(([what, make, kind]) =>
    LAUNCH_SITES.map((site) => [what, site.name, site.verb, make, kind, site] as const),
  )

  test.each(unavailableCross)('UNAVAILABLE (%s) at %s (%s) inside a launch arms that persona’s timer once, at the base wait', async (_what, _site, verb, make, kind, site) => {
    const h = launchHarness(RETRY_TIMER_ONLY)
    const [key] = h.keys as [string]
    h.script(site.script(h, personaOf(h, key), make(verb)))

    const result = await h.launch(key)

    expect(result).toEqual(armedResult(key, site.action))
    expectArmedOnce(h, key, kind)
    expect(getFailureCount(key)).toBe(0)
    if (site.ladderCalls !== undefined) expect(callCounts(h)).toEqual(site.ladderCalls)
    // No later call in the launch ends a condition this refusal started.
    if (site.leavesConditionHeld === true) expect(h.tmuxUnresponsive.holds(key)).toBe(kind === UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)
    if (site.startsNoCondition === true) {
      expect(h.tmuxUnresponsive.holds(key)).toBe(false)
      expect(conditionLines(h, key)).toEqual([])
    }
    expect(h.conditionEnds).toEqual([])
  })

  const readCross = READ_ERRORS.flatMap(([what, make]) => READ_SITES.map((site) => [what, site.name, make, site] as const))

  test.each(readCross)('%s at %s inside a launch arms that persona’s timer as a read error', async (_what, _site, make, site) => {
    const h = launchHarness()
    const [, key] = h.keys as [string, string]
    h.script(site.script(h, personaOf(h, key), make(site.verb)))

    const result = await h.launch(key)

    expect(result).toEqual(armedResult(key, site.action))
    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_READ_ERROR)
    expect(getFailureCount(key)).toBe(0)
  })

  test.each<[string, () => Error, string | undefined, string | undefined]>([
    ['ErrTmuxUnresponsive from resume', () => errTmuxUnresponsive('resume'), 'resume', UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['ErrCallTimeout from spawn', () => errCallTimeout('spawn'), 'spawn', UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['a plain Error from delete', () => new Error('boom'), 'delete', UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['ErrTmuxUnresponsive with no verb known', () => errTmuxUnresponsive(), undefined, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['ErrTmuxKillFailed from kill', () => errTmuxKillFailed(), 'kill', UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
    ['ErrTmuxKillFailed from status', () => errTmuxKillFailed(), 'status', UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
    ['a STATE answer from get', () => errSpawnNotInteractive('get'), 'get', UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
    ['a GONE answer from status', () => errTmuxCaptureFailed(undefined, 'status'), 'status', UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
    ['a STATE answer from list', () => errSpawnNotInteractive('list'), 'list', UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
    // b.jg5 SRJ-311: ENVIRONMENT is decided before the read-error rule, so
    // the read verbs record the ENVIRONMENT cause too, as every other verb does.
    ['ErrTmuxNotAvailable from status', () => errTmuxNotAvailable(undefined, 'status'), 'status', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['ErrTmuxNotAvailable from get', () => errTmuxNotAvailable(undefined, 'get'), 'get', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['ErrTmuxNotAvailable from list', () => errTmuxNotAvailable(undefined, 'list'), 'list', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['ErrTmuxNotAvailable from kill', () => errTmuxNotAvailable(undefined, 'kill'), 'kill', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['ErrTmuxNotAvailable from spawn', () => errTmuxNotAvailable(), 'spawn', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['ErrTmuxNotAvailable from read-pane', () => errTmuxNotAvailable(undefined, 'read-pane'), 'read-pane', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['ErrTmuxNotAvailable from delete', () => errTmuxNotAvailable(undefined, 'delete'), 'delete', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['ErrTmuxNotAvailable (the re-bound socket) from resume', () => errTmuxNotAvailableDifferentServer(), 'resume', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['ErrTmuxNotAvailable with no verb known', () => errTmuxNotAvailable(), undefined, UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    // b.jg5 SRJ-316, SRJ-301: CONFIG is its own cause from any verb, decided
    // before the read-error rule, so the read verbs record it too.
    ['a CONFIG answer from get', () => errConfigMalformed(), 'get', UNAVAILABLE_RETRY_CAUSE_CONFIG],
    ['a CONFIG answer from status', () => errConfigMalformed(), 'status', UNAVAILABLE_RETRY_CAUSE_CONFIG],
    ['a CONFIG answer from list', () => errConfigMalformed(), 'list', UNAVAILABLE_RETRY_CAUSE_CONFIG],
    ['a CONFIG answer from spawn', () => errConfigMalformed(), 'spawn', UNAVAILABLE_RETRY_CAUSE_CONFIG],
    ['a CONFIG answer from kill', () => errConfigMalformed(), 'kill', UNAVAILABLE_RETRY_CAUSE_CONFIG],
    ['a CONFIG answer from delete', () => errConfigMalformed(), 'delete', UNAVAILABLE_RETRY_CAUSE_CONFIG],
    ['a CONFIG answer from send-keys', () => errConfigMalformed(), 'send-keys', UNAVAILABLE_RETRY_CAUSE_CONFIG],
    ['a CONFIG answer from find-missing', () => errConfigMalformed(), 'find-missing', UNAVAILABLE_RETRY_CAUSE_CONFIG],
    ['a CONFIG answer with no verb known', () => errConfigMalformed(), undefined, UNAVAILABLE_RETRY_CAUSE_CONFIG],
    ['ErrSpawnNotFound from get', () => errSpawnNotFound(), 'get', undefined],
    ['ErrSpawnNotFound from status', () => errSpawnNotFound(), 'status', undefined],
    ['an UNUSABLE NAME answer from status', () => errUnusableName(), 'status', undefined],
    ['a STATE answer from read-pane', () => errSpawnNotInteractive('read-pane'), 'read-pane', undefined],
    ['a DIRECTORY answer from spawn', () => new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'cwd not found'), 'spawn', undefined],
    ['a LAUNCH FAILURE answer from resume', () => errTmuxSessionCreate('resume'), 'resume', undefined],
    ['a STATE answer with no verb known', () => errSpawnNotInteractive(), undefined, undefined],
  ])('the arming predicate: %s arms %s', (_what, make, verb, kind) => {
    const value = make()
    const cause = unavailableRetryCauseFor(value, verb)

    if (kind === undefined) expect(cause).toBeUndefined()
    else expect(cause).toEqual({ kind, error: value })
  })

  test.each<[string, (h: RecoveryHarness, persona: Persona) => RecoveryStubScript, SpawnPersonaResult['action']]>([
    ['a STATE answer from resume (ErrJsonlNeverWritten)', (h, p) => ({ ...collided(h, p, { state: 'ended' }), resumeError: errJsonlNeverWritten() }), 'spawned'],
    ['a DIRECTORY answer from spawn', () => ({ spawnError: new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'cwd not found') }), 'failed'],
    ['a LAUNCH FAILURE answer from resume', (h, p) => ({ ...collided(h, p, { state: 'ended' }), resumeError: errTmuxSessionCreate('resume') }), 'spawned'],
    ['ErrSpawnNotFound from the collision get', () => ({ spawnQueue: [cannedErr(errInstanceIdCollision())], getError: errSpawnNotFound() }), 'spawned'],
    // b.jg5 SRJ-605: the working-row wait's poll reading the row absent is
    // 'dead-session', and the recovery resumes the row the collision read.
    ['ErrSpawnNotFound from the working-row read (status)', (h, p) => ({ ...collided(h, p, { state: 'working' }), statusQueue: [cannedErr(errSpawnNotFound())] }), 'resumed'],
  ])('%s inside a launch arms nothing and marks nothing', async (_what, script, action) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    h.script(script(h, personaOf(h, key)))

    const result = await h.launch(key)

    expect(result).toEqual({ key, action })
    expect(h.triggers).toEqual([])
    expect(h.controller.armedKeys()).toEqual([])
    // A launch that answers spawned starts P's dialog approver, whose cap and
    // sleep timers are on the same clock; driven to its stop, it leaves none,
    // so a timer still pending would be one the launch's answer armed.
    await h.runApproverToStop(key)
    expectNothingArmed(h)
    expect(h.attempts).toEqual([])
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<number>]>([
    ['the permission poller’s get', async (h, key) => {
      h.script({
        listResult: { spawns: [cannedListRow({ state: 'check_permission' }, personaOf(h, key), h.home)] },
        getError: errCallTimeout('get'),
      })
      let failed!: () => void
      const getFailed = new Promise<void>((resolve) => { failed = resolve })
      stopPermissionPoller()
      _resetPollerState()
      const poller = startManualPoller({
        getClient: () => h.stub.client as unknown as ReturnType<PollerDeps['getClient']>,
        clientFor: () => undefined,
        getPersona: (k) => h.config.personas.find((p) => p.key === k),
        emitTrail: () => {},
        log: (...args) => {
          if (args.map(String).join(' ').includes('get failed')) failed()
        },
      })
      try {
        poller.fire()
        await getFailed
      } finally {
        stopPermissionPoller()
        _resetPollerState()
      }
      return h.stub.calls.getCalls.length
    }],
    ['the JSONL safeguard’s get', async (h) => {
      h.script({ getError: errCallTimeout('get') })
      await runJsonlPersistenceSafeguard(h.config, undefined, {
        home: h.home,
        readMountinfo: () => '',
        statFn: () => false,
        archiveCountSince: () => null,
        recordStartupError: () => {},
      })
      return h.stub.calls.getCalls.length
    }],
    ['the health tick’s liveness read', async (h, key) => {
      h.script({ statusError: errCallTimeout('status') })
      expect(await _buildIsSessionAliveAdapter(() => h.config)(key)).toEqual(LIVENESS_READING_UNKNOWN)
      return h.stub.calls.statusCalls.length
    }],
    ['the start sweep’s list', async (h) => {
      h.script({ listError: errCallTimeout('list') })
      await reconcileOrphans(h.config)
      return h.stub.calls.listCalls.length
    }],
    ['a persona teardown’s kill', async (h, key) => {
      const err = errTmuxKillFailed()
      h.script({ killError: err })
      await expect(killPersonaInstance(key)).rejects.toBe(err)
      return h.stub.calls.killCalls.length
    }],
  ])('an UNAVAILABLE answer to %s, made outside every attempt, arms nothing', async (_site, run) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]

    const calls = await run(h, key)

    expect(calls).toBeGreaterThan(0)
    expectNothingArmed(h)
  })

  test.each<[string, () => () => void, SpawnPersonaResult['action']]>([
    ['deferred by an unresolvable claude_config_dir', () => {
      _setConfigDirFs({ realpath: () => { throw Object.assign(new Error('no such directory'), { code: 'ENOENT' }) } })
      return _resetConfigDirFs
    }, 'deferred'],
    ['in dry run', () => {
      const saved = process.env['SLACK_DRY_RUN']
      process.env['SLACK_DRY_RUN'] = '1'
      return () => {
        if (saved === undefined) delete process.env['SLACK_DRY_RUN']
        else process.env['SLACK_DRY_RUN'] = saved
      }
    }, 'no-op'],
  ])('a launch %s is no attempt: it calls nothing and arms nothing', async (_what, install, action) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    h.script({ spawnError: errTmuxUnresponsive('spawn') })
    const undo = install()
    let result: SpawnPersonaResult
    try {
      result = await h.launch(key)
    } finally {
      undo()
    }

    expect(result).toMatchObject({ key, action })
    expect(result.refused).toBeUndefined()
    expect(h.stub.callCount()).toBe(0)
    expectNothingArmed(h)
  })

  test('a trigger while armed, midway and 1 ms before the due time, keeps the one due time, and the retry fires at the arm plus the base wait', async () => {
    const h = (harness = makeRecoveryHarness({ ...RETRY_TIMER_ONLY, action: 'scripted' }))
    const [key] = h.keys as [string]
    h.script({ spawnError: errTmuxUnresponsive('spawn') })
    const dueAt = h.clock.now() + waitMs(0)
    await h.launch(key)

    await h.advance(waitMs(0) / 2)
    await h.launch(key)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([dueAt])

    await h.advance(dueAt - 1 - h.clock.now())
    await h.launch(key)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([dueAt])
    expect(h.triggers).toEqual([1, 2, 3].map(() => ({ key, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })))
    expect(h.attempts).toEqual([])

    await h.advance(1)
    expect(h.attempts).toEqual([{ key, retry: 1, causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE], mode: UNAVAILABLE_RETRY_MODE_FULL, at: dueAt }])
  })

  test('a launch that joins one in flight, which then fails UNAVAILABLE, gets the same marked result, and one timer is armed', async () => {
    const h = (harness = makeRecoveryHarness(RETRY_TIMER_ONLY))
    const [key] = h.keys as [string]
    const hold = holdSpawns(h.stub.client)
    const first = h.launch(key)
    await hold.entered(personaInstanceId(key))
    const joined = h.launch(key)

    hold.fail(personaInstanceId(key), errTmuxUnresponsive('spawn'))
    await h.settle()

    const marked: SpawnPersonaResult = { key, action: 'failed', refused: true }
    expect(await first).toEqual(marked)
    expect(await joined).toEqual(marked)
    expect(hold.calls).toHaveLength(1)
    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)
  })

  test('with no trigger sink installed, a launch fed UNAVAILABLE schedules no timer, throws nothing and is not marked', async () => {
    const h = (harness = makeRecoveryHarness({ ...RETRY_TIMER_ONLY, triggerSink: false }))
    const [key] = h.keys as [string]
    h.script({ spawnError: errTmuxUnresponsive('spawn') })

    const result = await h.launch(key)

    expect(result).toEqual({ key, action: 'failed' })
    expectNothingArmed(h)
  })
})

// ---------------------------------------------------------------------------
// A `status` error at the launch's working-row wait (b.jg5 SRJ-605, SRJ-301):
// the wait goes on with no post and ends `not-reconnected` at its timeout,
// while the wrapper still arms P's timer. `ErrSpawnNotFound` keeps its own
// meaning (above: it arms nothing).
// ---------------------------------------------------------------------------

/**
 * The `status` errors the working-row wait goes on past, each with the cause
 * it arms and whether the wrapper raises the `ad-unreachable` outage for it:
 * E10's UNAVAILABLE values, and `ErrSystemInstallDisappeared`, an
 * UNCLASSIFIED answer that a read records as a read error.
 */
const WAIT_STATUS_ERRORS: ReadonlyArray<readonly [string, (verb: string) => Error, string, boolean]> = [
  ...UNAVAILABLE_VALUES.map(([what, make, kind]) => [what, make, kind, false] as const),
  ['ErrSystemInstallDisappeared', (verb) => errSystemInstallDisappeared(verb), UNAVAILABLE_RETRY_CAUSE_READ_ERROR, true],
]

/**
 * The poll cases beyond what the launch cross above already runs at the
 * working-row read: `ErrSystemInstallDisappeared`, which raises its outage,
 * and one UNAVAILABLE value for the poll line and the retry finding P live.
 */
const WAIT_POLL_STATUS_ERRORS = WAIT_STATUS_ERRORS.filter(([what]) => what === 'ErrTmuxUnresponsive' || what === 'ErrSystemInstallDisappeared')

/** The working-row wait's timeout in the cases that reach it, on the wait's own clock (`_setNow`). */
const WAIT_TIMEOUT_MS = 60_000

/** The line the wait writes for a failed poll read of `err` by persona `persona` (b.jg5 SRJ-605). */
function pollStatusErrorLine(persona: Persona, err: Error): string {
  return waitPollStatusErrorLine(renderPersonaRef(persona.name, persona.key), describeAgentDirectorFailure(err), classifyAdError(err).errorClass)
}

/** The `ad-unreachable` onsets the outage state posted, for the stub's binary. */
function adUnreachableOnsets(h: RecoveryHarness): RecoveryNotice[] {
  return h.outageNotices.filter((notice) => notice.text === ONSET_TEMPLATES['ad-unreachable'](h.stub.client.binaryPath))
}

describe('unavailable retry: a status error at the launch’s working-row wait arms P’s timer while the wait goes on, and never fails or counts the launch (SRJ-605, SRJ-301)', () => {
  beforeEach(() => {
    _resetNotConnectedEpisodes()
  })

  afterEach(() => {
    _resetNow()
    _resetWaitForWaitingTimeoutMs()
    _resetNotConnectedEpisodes()
  })

  test.each(WAIT_POLL_STATUS_ERRORS)('%s at the wait’s poll arms P’s timer once and not Q’s; the next poll reads waiting and the launch reconnects with nothing posted or counted; the timer’s retry then finds P live', async (_what, make, kind, adUnreachable) => {
    const h = launchHarness()
    const [p, q] = h.keys as [string, string]
    const persona = personaOf(h, p)
    const err = make('status')
    h.script({ ...collided(h, persona, { state: 'working' }), statusQueue: [cannedErr(err)] })

    const result = await h.launch(p)

    expect(result).toEqual({ key: p, action: 'reconnected' })
    expectArmedOnce(h, p, kind)
    // The failed poll, then the poll that reads `waiting` and the reconnect's keystrokes.
    expect(personaCallCounts(h, p)).toMatchObject({ statusCalls: 2, sendKeysCalls: 1 })
    expect(h.errors.filter((line) => line === pollStatusErrorLine(persona, err))).toHaveLength(1)
    // ErrSystemInstallDisappeared raises `ad-unreachable` once; the next read's success clears it.
    expect(adUnreachableOnsets(h)).toHaveLength(adUnreachable ? 1 : 0)
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(getFailureCount(p)).toBe(0)
    expect(getFailureCount(q)).toBe(0)

    h.setConnected(p, true)
    const dueAt = await retryNow(h, p)

    expect(h.attempts).toEqual([{ key: p, retry: 1, causes: [kind], mode: UNAVAILABLE_RETRY_MODE_FULL, at: dueAt }])
    expect(h.stops).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_RECOVERED }])
    expect(h.controller.armedKeys()).toEqual([])
    expect(getFailureCount(p)).toBe(0)
  })

  test.each(WAIT_STATUS_ERRORS)('%s persisting from the wait’s poll to its timeout read ends the launch not-reconnected, never failed or counted; both reads arm P’s one timer and not Q’s', async (_what, make, kind, adUnreachable) => {
    const h = launchHarness()
    const [p, q] = h.keys as [string, string]
    const persona = personaOf(h, p)
    const err = make('status')
    // The wait's clock moves past its timeout at each status read, so the
    // wait polls once and then makes its timeout read.
    let waitNow = 0
    _setNow(() => waitNow)
    _setWaitForWaitingTimeoutMs(WAIT_TIMEOUT_MS)
    h.script({
      ...collided(h, persona, { state: 'working' }),
      statusFn: () => {
        waitNow += WAIT_TIMEOUT_MS
        return err
      },
    })

    const result = await h.launch(p)

    expect(result).toEqual({ key: p, action: 'not-reconnected' })
    expectArmedOnce(h, p, kind, undefined, 2)
    expect(personaCallCounts(h, p).statusCalls).toBe(2)
    expect(personaCallCounts(h, p).sendKeysCalls).toBeUndefined()
    const report = waitTimedOutUnreadReport(renderPersonaRef(persona.name, persona.key), WAIT_TIMEOUT_MS, describeAgentDirectorFailure(err), classifyAdError(err).errorClass)
    expect(h.errors.filter((line) => line === pollStatusErrorLine(persona, err))).toHaveLength(1)
    expect(h.errors.filter((line) => line === waitEndedDisconnectedLine(report, h.config.session_restart_delay))).toHaveLength(1)
    // With session_restart_delay 0 the wait's end raises P's one not-connected
    // notice, saying agent-director could not report its state.
    expect(report.notice.reason).toBe('auto-restart-disabled')
    expect(h.notices).toEqual([{ key: p, text: expect.stringContaining((report.notice as { cause: string }).cause) }])
    expect(getOutageFlags(p).has('ad-unreachable')).toBe(adUnreachable)
    expect(h.startupErrors()).toEqual([])
    expect(getFailureCount(p)).toBe(0)
    expect(getFailureCount(q)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// P's dialog approver (b.jg5 SRJ-401; hatch A2) runs after its launch call
// returned: it is in flight for P (the lost-message read gate, as for the
// health tick; SRJ-315, SRJ-1011) but blocks no retry (SRJ-303), and its
// calls are outside every launch or recovery attempt (SRJ-301, SRJ-313).
// ---------------------------------------------------------------------------

/**
 * Stub answers under which a dialog approver's `verb` call meets `err`: the
 * row reads `pending` (with the stub's default launch start) for `read-pane`
 * and `send-keys`, and the pane shows a startup dialog's needle for
 * `send-keys`, so Enter is sent.
 */
function approverCallMeets(verb: ApproverVerb, err: Error): RecoveryStubScript {
  if (verb === 'status') return { statusError: err }
  const pending = { statusResult: cannedStatusResult({ state: 'pending' }) }
  if (verb === 'read-pane') return { ...pending, readPaneError: err }
  return { ...pending, readPaneResults: [{ pane: TRUST_DIALOG_NEEDLE }], sendKeysError: err }
}

describe('unavailable retry: P’s dialog approver is in flight for P, blocks no retry and makes its calls outside every attempt (SRJ-303, SRJ-315, SRJ-401; hatch A2)', () => {
  test('a launch call held in flight both blocks a retry and is in flight for P; once it returns, P’s approver alone is in flight for P (a lost message for P makes no read, one for Q does) and blocks no retry (the retry makes its row read)', async () => {
    // The approver's cap outlasts the retry's second wait, so it still runs when the retry fires.
    const h = (harness = makeRecoveryHarness({ ...RETRY_TIMER_ONLY, approverCapMs: waitMs(0) + 2 * waitMs(1) }))
    const [key, other] = h.keys as [string, string]
    const id = personaInstanceId(key)
    h.script({ statusResult: cannedStatusResult({ state: 'pending' }) })
    const hold = holdSpawns(h.stub.client)
    const launch = h.launch(key)
    await hold.entered(id)
    h.controller.arm(key, UNAVAILABLE)

    // The launch call in flight: no read for the message, and the retry is skipped.
    expect(isLaunchInFlight(key)).toBe(true)
    await expectLostMessageReports(h, key, 'session-starting', { calls: {} })
    await h.advance(waitMs(0))
    expect(h.stub.callCount()).toBe(0)
    expect(h.lines).toContain(reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT, 1))

    hold.release(id)
    expect(await launch).toMatchObject({ key, action: 'spawned' })
    await h.settle()
    expect(isLaunchInFlight(key)).toBe(false)
    expect(h.approverRunning(key)).toBe(true)
    expect(personaCallCounts(h, key)).toMatchObject({ statusCalls: 1, readPaneCalls: 1 })

    // Only the approver runs: in flight for P, and not for Q.
    await expectLostMessageReports(h, key, 'session-starting', { calls: {} })
    await expectLostMessageReports(h, other, 'session-starting')

    // The retry is not skipped: its row read finds the row pending, which defers it.
    await retryNow(h, key)
    expect(h.approverRunning(key)).toBe(true)
    expect(h.attempts.map((a) => [a.key, a.retry])).toEqual([[key, 1], [key, 2]])
    expect(retryLinesOf(h, key).at(-1)).toBe(reArmedLine(key, 2, UNAVAILABLE_RETRY_AGAIN_PENDING_DEFERRED, 2))
    expect(h.triggers).toEqual([])
  })

  test.each<[string, RowState, boolean, ApproverStopReason, LostMessageState]>([
    ['the row reads live', 'waiting', false, APPROVER_STOP_LIVE, 'auto-restart-disabled'],
    ['the row reads ended', 'ended', false, APPROVER_STOP_FINISHED, 'auto-restart-disabled'],
    ['its stop entry, the row still pending', 'pending', true, APPROVER_STOP_TEARDOWN, 'session-starting'],
  ])('once P’s approver stops (%s) it is no longer in flight for P: the next lost message makes its row read', async (_what, state, stopEntry, reason, lostState) => {
    // A cap past the pace, so a second lap reads the row.
    const h = (harness = makeRecoveryHarness({ approverCapMs: 2 * DIALOG_POLL_INTERVAL_MS }))
    const [key] = h.keys as [string]
    h.script({ statusResult: cannedStatusResult({ state: 'pending' }) })
    await h.launch(key)
    await h.settle()
    expect(h.approverRunning(key)).toBe(true)

    h.script({ statusResult: cannedStatusResult({ state }) })
    if (stopEntry) expect(await stopDialogApprover(key, APPROVER_STOP_TEARDOWN)).toBe(true)
    expect((await h.runApproverToStop(key))?.reason).toBe(reason)

    expect(h.approverRunning(key)).toBe(false)
    expect(isLaunchInFlight(key)).toBe(false)
    await expectLostMessageReports(h, key, lostState)
    expectNothingArmed(h)
  })

  // One answer of each class here; the harness-level matrix over every form
  // and verb lives with the session manager's approver cases.
  test.each<[string, ApproverVerb, () => Error]>([
    ['UNAVAILABLE (ErrTmuxUnresponsive)', 'read-pane', () => errTmuxUnresponsive('read-pane')],
    ['UNCLASSIFIED (ErrInternal with no recognised phrase)', 'send-keys', () => errInternal()],
  ])('%s answering the dialog approver’s %s, after the launch returned, arms no timer, adds no cause to an armed one, opens no episode and counts nothing', async (_what, verb, make) => {
    const h = (harness = makeRecoveryHarness(RETRY_TIMER_ONLY))
    const [key, other] = h.keys as [string, string]
    // Q's timer is armed first, with a cause no approver answer gives.
    h.controller.arm(other, { kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED })
    const otherView = h.controller.view(other)
    h.script(approverCallMeets(verb, make()))

    await h.launch(key)
    await h.launch(other)
    await h.settle()

    for (const k of [key, other]) {
      expect([k, personaCallCounts(h, k)[APPROVER_VERB_CALLS[verb]]]).toEqual([k, 1])
      expect(h.approverRunning(k)).toBe(true)
      expect(h.unclassifiedErrorOpen(k)).toBe(false)
      expect(unclassifiedLines(h, k)).toEqual([])
      expect(h.tmuxUnresponsive.holds(k)).toBe(false)
      expect(getFailureCount(k)).toBe(0)
    }
    expect(h.triggers).toEqual([])
    expect(h.controller.armedKeys()).toEqual([other])
    expect(h.controller.view(other)).toEqual(otherView)
    expect(h.episodeNotices).toEqual([])
  })

  // b.jg5 SRJ-404, SRJ-118: GONE stops polling, and `ErrSpawnNotInteractive`
  // stops with nothing typed; either way the answer is outside every attempt.
  test.each<[string, () => Error, ApproverStopReason]>([
    ['a STATE answer (ErrSpawnNotInteractive)', () => errSpawnNotInteractive('status'), APPROVER_STOP_NOT_INTERACTIVE],
    ['a GONE answer (ErrTmuxCaptureFailed)', () => errTmuxCaptureFailed(undefined, 'status'), APPROVER_STOP_GONE],
  ])('%s answering the dialog approver’s status, after the launch returned, stops it by its class with nothing read or typed; it arms no timer, adds no cause to an armed one, opens no episode and counts nothing', async (_what, make, reason) => {
    const h = (harness = makeRecoveryHarness(RETRY_TIMER_ONLY))
    const [key, other] = h.keys as [string, string]
    // Q's timer is armed first, with a cause no approver answer gives.
    h.controller.arm(other, { kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED })
    const otherView = h.controller.view(other)
    h.script(approverCallMeets('status', make()))

    await h.launch(key)
    await h.launch(other)
    await h.settle()

    for (const k of [key, other]) {
      expect([k, (await h.runApproverToStop(k))?.reason]).toEqual([k, reason])
      expect([k, personaCallCounts(h, k)]).toEqual([k, { spawnCalls: 1, statusCalls: 1 }])
      expect(h.unclassifiedErrorOpen(k)).toBe(false)
      expect(unclassifiedLines(h, k)).toEqual([])
      expect(h.tmuxUnresponsive.holds(k)).toBe(false)
      expect(getFailureCount(k)).toBe(0)
    }
    expect(h.triggers).toEqual([])
    expect(h.controller.armedKeys()).toEqual([other])
    expect(h.controller.view(other)).toEqual(otherView)
    expect(h.episodeNotices).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The shared findMissing sweep (b.jg5 SRJ-301): each persona that met a failed
// sweep inside its own attempt is armed once, whoever started the sweep.
// ---------------------------------------------------------------------------

/** The harness stub's findMissing, held open: every call waits until the test fails them all. */
interface FindMissingHold {
  /** findMissing calls made so far. */
  calls(): number
  /** Resolves at the first findMissing call. */
  readonly entered: Promise<void>
  /** Reject every held call with `err`. */
  failAll(err: Error): void
}

function holdFindMissing(h: RecoveryHarness): FindMissingHold {
  const client = h.stub.client as unknown as { findMissing: (params: unknown) => Promise<unknown> }
  const held: Array<(err: Error) => void> = []
  const entered = Promise.withResolvers<void>()
  let calls = 0
  client.findMissing = () => {
    calls++
    entered.resolve()
    return new Promise((_resolve, reject) => { held.push(reject) })
  }
  return {
    calls: () => calls,
    entered: entered.promise,
    failAll: (err) => {
      for (const reject of held.splice(0)) reject(err)
    },
  }
}

/** One live pre-persona row (no `persona` label), so the start sweep kills it and then runs its findMissing sweep. */
function prePersonaRowScript(): RecoveryStubScript {
  return { listResult: { spawns: [cannedListRow({ claude_instance_id: 'cscb_legacy', labels: { service: 'cscb' } })] } }
}

/** Persona `key`'s escalate-dead sweep, made inside a recovery attempt for it. */
function sweepInAttempt(key: string): Promise<void> {
  return runInAttempt(key, 'recovery', () => sweepDeadTmuxChannel(key, 'dead-session'))
}

describe('unavailable retry: a shared findMissing sweep that fails arms each persona that met it inside its attempt (SRJ-301)', () => {
  test('P and Q, each inside its own attempt, share one findMissing call; when it fails each is armed once with unavailable', async () => {
    const h = (harness = makeRecoveryHarness())
    const [p, q] = h.keys as [string, string]
    const hold = holdFindMissing(h)

    const both = Promise.all([sweepInAttempt(p), sweepInAttempt(q)])
    await hold.entered
    hold.failAll(errCallTimeout('find-missing'))
    await both

    expect(hold.calls()).toBe(1)
    const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key)
    expect([...h.triggers].sort(byKey)).toEqual(
      [{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }, { key: q, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }].sort(byKey),
    )
    expect([...h.controller.armedKeys()].sort()).toEqual([p, q].sort())
    for (const key of [p, q]) {
      expect(h.controller.view(key)).toEqual({
        phase: 'waiting',
        dueAt: h.clock.now() + waitMs(0),
        waitMs: waitMs(0),
        refusals: 0,
        causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
        mode: UNAVAILABLE_RETRY_MODE_FULL,
      })
    }
    expect(delays(h.clock)).toEqual([waitMs(0), waitMs(0)])
    expect(h.attempts).toEqual([])
  })

  test('a persona inside its attempt that joins the start sweep’s direct findMissing call, which fails, is armed once', async () => {
    const h = (harness = makeRecoveryHarness())
    const [p] = h.keys as [string]
    h.script(prePersonaRowScript())
    const hold = holdFindMissing(h)

    const sweep = reconcileOrphans(h.config)
    await hold.entered
    const joined = sweepInAttempt(p)
    hold.failAll(errCallTimeout('find-missing'))
    const result = await sweep
    await joined

    expect(result.prePersona).toEqual({ kept: 1, live: 1, killFailed: 0 })
    expect(hold.calls()).toBe(1)
    expectArmedOnce(h, p, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)
  })

  test.each<[string, (h: RecoveryHarness, starter: string) => Promise<unknown>, boolean]>([
    ['the start sweep’s direct call', (h) => reconcileOrphans(h.config), false],
    ['another persona’s sweep inside its attempt', (_h, starter) => sweepInAttempt(starter), true],
  ])('a persona outside every attempt that joins %s, which fails, arms nothing for itself', async (_what, start, starterArms) => {
    const h = (harness = makeRecoveryHarness())
    const [starter, joiner] = h.keys as [string, string]
    h.script(prePersonaRowScript())
    const hold = holdFindMissing(h)

    const started = start(h, starter)
    await hold.entered
    const joined = sweepDeadTmuxChannel(joiner, 'dead-session')
    hold.failAll(errCallTimeout('find-missing'))
    await started
    await joined

    expect(hold.calls()).toBe(1)
    expect(h.controller.isArmed(joiner)).toBe(false)
    if (starterArms) expectArmedOnce(h, starter, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)
    else expectNothingArmed(h)
  })

  test('the start sweep’s findMissing failing with no persona joined reports nothing', async () => {
    const h = (harness = makeRecoveryHarness())
    h.script({ ...prePersonaRowScript(), findMissingError: errCallTimeout('find-missing') })

    const result = await reconcileOrphans(h.config)

    expect(result.prePersona).toEqual({ kept: 1, live: 1, killFailed: 0 })
    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    expectNothingArmed(h)
  })
})

// ---------------------------------------------------------------------------
// Attempt frames (b.jg5 SRJ-301): a continuation that outlives its attempt
// ---------------------------------------------------------------------------

describe('unavailable retry: an attempt started from a continuation that outlives a closed attempt', () => {
  const OUTER = 'gamma'

  /** Run `callback` later, from inside the current attempt: after `gate` opens, or on a real 0 ms timer. */
  type Later = (callback: () => void, gate: Promise<void>) => void
  const LATERS: ReadonlyArray<readonly [string, Later]> = [
    ['a timer callback', (callback) => { setTimeout(callback, 0) }],
    ['a promise continuation', (callback, gate) => { void gate.then(callback) }],
  ]
  const CASES = LATERS.flatMap(([how, later]) => [
    [how, 'with an enclosing attempt still open', later, true] as const,
    [how, 'with no enclosing attempt', later, false] as const,
  ])

  /** What the attempt started from the continuation saw. */
  interface Seen {
    readonly inside: { readonly own: boolean; readonly closed: boolean; readonly outer: boolean }
    readonly armed: { readonly own: boolean; readonly closed: boolean; readonly outer: boolean }
    readonly ownLastError: AttemptErrorRecord | undefined
    /** `isInsideAttempt` for each key in the continuation once the new attempt has settled. */
    readonly after: { readonly own: boolean; readonly closed: boolean; readonly outer: boolean }
  }

  test.each(CASES)('%s, %s: the new attempt is not nested in the closed one, and isInsideAttempt answers as before', async (_how, _outer, later, withOuter) => {
    const { controller } = makeRig()
    const err = errCallTimeout('status')
    const gate = Promise.withResolvers<void>()
    const seen = Promise.withResolvers<Seen>()
    let closedView!: AttemptView

    const run = async (): Promise<Seen> => {
      await runInAttempt(KEY, 'launch', (view) => {
        closedView = view
        later(() => {
          void runInAttempt(OTHER, 'recovery', (own) => {
            const inside = { own: isInsideAttempt(OTHER), closed: isInsideAttempt(KEY), outer: isInsideAttempt(OUTER) }
            const armed = {
              own: reportAttemptError(OTHER, err, 'status', controller),
              closed: reportAttemptError(KEY, err, 'status', controller),
              outer: reportAttemptError(OUTER, err, 'status', controller),
            }
            return { inside, armed, ownLastError: own.lastError }
          }).then((partial) => {
            seen.resolve({ ...partial, after: { own: isInsideAttempt(OTHER), closed: isInsideAttempt(KEY), outer: isInsideAttempt(OUTER) } })
          }, seen.reject)
        }, gate.promise)
      })
      expect(isInsideAttempt(KEY)).toBe(false)
      gate.resolve()
      return seen.promise
    }

    let outerView: AttemptView | undefined
    const result = withOuter
      ? await runInAttempt(OUTER, 'recovery', (view) => {
          outerView = view
          return run()
        })
      : await run()

    const armedRecord: AttemptErrorRecord = { verb: 'status', causeKind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, armed: true }
    expect(result.inside).toEqual({ own: true, closed: false, outer: withOuter })
    expect(result.armed).toEqual({ own: true, closed: false, outer: withOuter })
    expect(result.ownLastError).toEqual(armedRecord)
    expect(result.after).toEqual({ own: false, closed: false, outer: withOuter })
    expect(closedView.lastError).toBeUndefined()
    expect(outerView?.lastError).toEqual(withOuter ? armedRecord : undefined)
    expect([...controller.armedKeys()].sort()).toEqual((withOuter ? [OTHER, OUTER] : [OTHER]).sort())
    expect(controller.isArmed(KEY)).toBe(false)
    expect([isInsideAttempt(KEY), isInsideAttempt(OTHER), isInsideAttempt(OUTER)]).toEqual([false, false, false])
  })
})

// ---------------------------------------------------------------------------
// Again-reasons and close (b.jg5 SRJ-303, SRJ-305) on the bare controller
// ---------------------------------------------------------------------------

/** How a re-armed line names the modes: the retry ran pending-only, and the mode the retry switched the timer to. */
interface ReArmedModes {
  readonly ranPendingOnly?: boolean
  readonly switchedTo?: UnavailableRetryMode
}

/** The line a retry answered `again` logs: its reason and the next wait, after `refusals` refusals. */
function reArmedLine(key: string, retry: number, reason: string, refusals: number, modes: ReArmedModes = {}): string {
  const ran = modes.ranPendingOnly === true ? ` (${UNAVAILABLE_RETRY_MODE_PENDING_ONLY})` : ''
  const switched = modes.switchedTo !== undefined ? ` in ${modes.switchedTo} mode` : ''
  return `[slack] unavailable-retry: persona=${key} retry ${retry}${ran}: ${reason} — re-armed${switched}, next retry in ${waitMs(refusals) / 1000} s`
}

/** The line a stopped timer logs; `tags` are the parenthesised mode and row, when the stop names them. */
function stoppedLine(key: string, reason: string, ...tags: string[]): string {
  const tagged = tags.length > 0 ? ` (${tags.join(', ')})` : ''
  return `[slack] unavailable-retry: persona=${key} stopped${tagged} — ${reason}`
}

/** The stopped line of a pending-only timer, naming the row its retry read when given. */
function pendingOnlyStoppedLine(key: string, reason: string, row?: string): string {
  return row === undefined
    ? stoppedLine(key, reason, UNAVAILABLE_RETRY_MODE_PENDING_ONLY)
    : stoppedLine(key, reason, UNAVAILABLE_RETRY_MODE_PENDING_ONLY, `row ${row}`)
}

describe('unavailable retry: again-reasons and close', () => {
  test.each<[string, unknown, string]>([
    ['a label', UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT, UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT],
    ['a token-shaped reason', fakeToken(BOT_TOKEN_PREFIX, 'reason'), 'unnamed'],
    ['a reason that is no string', 42, 'unnamed'],
  ])('an again answer with %s names it in the re-armed line only; it is never recorded as a cause', async (_what, reason, logged) => {
    const { clock, controller, lines } = makeRig(() => ({ kind: 'again', reason } as UnavailableRetryOutcome))
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))
    await controller.whenRunSettled(KEY)

    expect(lines.at(-1)).toBe(reArmedLine(KEY, 1, logged, 1))
    expect(controller.view(KEY)).toMatchObject({ refusals: 1, causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE] })
    assertNoLeak(lines)
  })

  test('close stops every persona, refuses every later arm with one not-armed line, leaves nothing pending and fires nothing more', async () => {
    const { clock, controller, lines, attempts } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    controller.arm(OTHER, UNAVAILABLE)

    controller.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
    controller.arm(KEY, { kind: 'status-error' })
    controller.close('closed twice')
    await clock.advance(waitMs(refusalsToCeiling()) * 4)

    expect(controller.armedKeys()).toEqual([])
    expect(clock.pendingCount()).toBe(0)
    expect(attempts).toEqual([])
    expect(lines.slice(2)).toEqual([
      stoppedLine(KEY, UNAVAILABLE_RETRY_STOP_SHUTDOWN),
      stoppedLine(OTHER, UNAVAILABLE_RETRY_STOP_SHUTDOWN),
      `[slack] unavailable-retry: persona=${KEY} not armed (status-error) — ${UNAVAILABLE_RETRY_STOP_SHUTDOWN}`,
    ])
  })

  test('a run in flight at close finishes with its answer dropped: nothing re-arms', async () => {
    const held = heldAction()
    const { clock, controller } = makeRig(held.action)
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))

    controller.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
    held.answer({ kind: 'again' })
    await controller.whenRunSettled(KEY)

    expect(controller.isArmed(KEY)).toBe(false)
    expect(clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The retry action (b.jg5 SRJ-303, SRJ-305), in both modes, over a stand-in
// row read and retry entry
// ---------------------------------------------------------------------------

/** Stand-in deps for the retry action: a row read and a retry entry that record each call, every gate open unless overridden. */
interface StandInDeps extends FullModeRetryDeps {
  /** Each retry entry call: the key and the working directory. */
  readonly calls: string[][]
  /** Each row read: the key, and whether it ran inside a recovery attempt for that key. */
  readonly reads: Array<readonly [string, boolean]>
}

/**
 * Stand-in deps whose retry entry answers `outcome` and whose row read answers
 * `row`: a row state (read as `{ state: row }`), a whole row read, or an Error
 * it rejects with.
 */
function fullModeDeps(outcome: RestartRetryOutcome, overrides: Partial<FullModeRetryDeps> = {}, row: string | UnavailableRetryRowRead | Error = 'waiting'): StandInDeps {
  const calls: string[][] = []
  const reads: Array<readonly [string, boolean]> = []
  return {
    calls,
    reads,
    readRow: async (key) => {
      reads.push([key, isInsideAttempt(key)])
      if (row instanceof Error) throw row
      return typeof row === 'string' ? { state: row } : row
    },
    retry: async (key, cwd) => {
      calls.push([key, cwd])
      return outcome
    },
    appliedPersona: (key) => (key === KEY ? { working_directory: `/work/${key}` } : undefined),
    canRelaunch: () => true,
    isAtCap: () => false,
    isShuttingDown: () => false,
    isInFlight: () => false,
    ...overrides,
  }
}

/** The first retry in each mode, as the controller tells the action. */
const FULL_RETRY = { retry: 1, causes: [], mode: UNAVAILABLE_RETRY_MODE_FULL } as const
const PENDING_ONLY_RETRY = { retry: 1, causes: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW], mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY } as const

/** The retry action's early stops, before any call, in order: each gate's stand-in overrides and its stop reason. */
const GATES: ReadonlyArray<readonly [string, Partial<FullModeRetryDeps>, string]> = [
  ['shutting down (before everything else)', { isShuttingDown: () => true, appliedPersona: () => undefined, isLatched: () => true, canRelaunch: () => false, isAtCap: () => true }, UNAVAILABLE_RETRY_STOP_SHUTDOWN],
  ['not applied (before the latched check)', { appliedPersona: () => undefined, isLatched: () => true, canRelaunch: () => false, isAtCap: () => true }, UNAVAILABLE_RETRY_STOP_NOT_APPLIED],
  // b.jg5 SRJ-303, SRJ-305: no attempt while P is latched; the timer stops instead.
  ['latched (before the up check)', { isLatched: () => true, canRelaunch: () => false, isAtCap: () => true }, UNAVAILABLE_RETRY_STOP_LATCHED],
  ['not up (before the cap)', { canRelaunch: () => false, isAtCap: () => true }, UNAVAILABLE_RETRY_STOP_NOT_UP],
  ['at the restart cap', { isAtCap: () => true }, UNAVAILABLE_RETRY_STOP_CAPPED],
]

describe('unavailable retry: the retry action’s decisions over stand-ins', () => {
  test.each<[RestartRetryOutcome, UnavailableRetryOutcome]>([
    [RESTART_OUTCOME_ALREADY_CONNECTED, { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_RECOVERED }],
    [RESTART_OUTCOME_RECONNECTED, { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_RECOVERED }],
    [RESTART_OUTCOME_CAPPED, { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_CAPPED }],
    [RESTART_OUTCOME_NOT_UP, { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_NOT_UP }],
    [RESTART_OUTCOME_LAUNCH_SKIPPED, { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_LAUNCH_SKIPPED }],
    [RESTART_OUTCOME_SHUTTING_DOWN, { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_SHUTDOWN }],
    [RESTART_OUTCOME_LATCHED, { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_LATCHED }],
    [RESTART_OUTCOME_IN_FLIGHT, { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT }],
    [RESTART_OUTCOME_REFUSED, { kind: 'again' }],
    [RESTART_OUTCOME_COUNTED_FAILURE, { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_LAUNCH_FAILED }],
    [RESTART_OUTCOME_RECONNECT_DEFERRED, { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_RECONNECT_DEFERRED }],
    [RESTART_OUTCOME_PENDING_DEFERRED, { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_PENDING_DEFERRED, row: UNAVAILABLE_RETRY_ROW_PENDING }],
    [RESTART_OUTCOME_LAUNCHED, { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_LAUNCHED, row: UNAVAILABLE_RETRY_ROW_PENDING, switchToPendingOnly: true }],
    [RESTART_OUTCOME_NOT_INITIALISED, { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_RESTART_NOT_INITIALISED }],
    [RESTART_OUTCOME_LIVENESS_UNKNOWN, { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_LIVENESS_UNKNOWN, keepsLastRow: true }],
  ])('full mode: a retry entry answering %s answers %o, with no row read', async (outcome, answer) => {
    const deps = fullModeDeps(outcome)

    expect(await createFullModeRetryAction(deps)(KEY, FULL_RETRY)).toEqual(answer)
    expect(deps.calls).toEqual([[KEY, `/work/${KEY}`]])
    expect(deps.reads).toEqual([])
  })

  test.each<[string, UnavailableRetryOutcome]>([
    [UNAVAILABLE_RETRY_ROW_PENDING, { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_ROW_PENDING, row: UNAVAILABLE_RETRY_ROW_PENDING }],
    ['waiting', { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_LIVE, row: 'waiting', yieldsToFullMode: true }],
    ['working', { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_LIVE, row: 'working', yieldsToFullMode: true }],
    ['check_permission', { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_LIVE, row: 'check_permission', yieldsToFullMode: true }],
  ])('pending-only: a row read %s answers %o, from the one read inside a recovery attempt and no retry entry call', async (row, answer) => {
    const deps = fullModeDeps(RESTART_OUTCOME_LAUNCHED, {}, row)

    expect(await createFullModeRetryAction(deps)(KEY, PENDING_ONLY_RETRY)).toEqual(answer)
    expect(deps.reads).toEqual([[KEY, true]])
    expect(deps.calls).toEqual([])
  })

  test.each(Object.entries(SAMPLE_LAUNCH_STARTS))('pending-only: a pending row read carrying a launch start (%s) answers the same row-pending refusal, and no retry entry call', async (_form, launchStartedAt) => {
    const row: UnavailableRetryRowRead = launchStartedAt === undefined
      ? { state: UNAVAILABLE_RETRY_ROW_PENDING }
      : { state: UNAVAILABLE_RETRY_ROW_PENDING, launchStartedAt }
    const deps = fullModeDeps(RESTART_OUTCOME_LAUNCHED, {}, row)

    expect(await createFullModeRetryAction(deps)(KEY, PENDING_ONLY_RETRY)).toEqual({
      kind: 'again',
      reason: UNAVAILABLE_RETRY_AGAIN_ROW_PENDING,
      row: UNAVAILABLE_RETRY_ROW_PENDING,
    })
    expect(deps.reads).toEqual([[KEY, true]])
    expect(deps.calls).toEqual([])
  })

  test.each(['ended', 'missing', UNAVAILABLE_RETRY_ROW_ABSENT])('pending-only: a row read %s answers a stop whose hand-off, run once, is one retry entry call', async (row) => {
    const deps = fullModeDeps(RESTART_OUTCOME_LAUNCHED, {}, row)

    const answer = await createFullModeRetryAction(deps)(KEY, PENDING_ONLY_RETRY)

    expect(answer).toEqual({ kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_GONE, row, handOff: expect.any(Function), yieldsToFullMode: true })
    expect(deps.calls).toEqual([])
    await (answer as { handOff: () => Promise<unknown> }).handOff()
    expect(deps.calls).toEqual([[KEY, `/work/${KEY}`]])
    expect(deps.reads).toEqual([[KEY, true]])
  })

  const gatesByMode = [FULL_RETRY, PENDING_ONLY_RETRY].flatMap((attempt) => GATES.map(([what, overrides, reason]) => [attempt.mode, what, overrides, reason, attempt] as const))

  test.each(gatesByMode)('%s mode: %s stops before the row read or the retry entry runs', async (_mode, _what, overrides, reason, attempt) => {
    const deps = fullModeDeps(RESTART_OUTCOME_LAUNCHED, overrides, UNAVAILABLE_RETRY_ROW_PENDING)

    expect(await createFullModeRetryAction(deps)(KEY, attempt)).toEqual({ kind: 'stop', reason })
    expect(deps.calls).toEqual([])
    expect(deps.reads).toEqual([])
  })

  test('the entry gets the one in-flight predicate, and a retry entry that rejects rejects the action', async () => {
    const isInFlight = (): boolean => true
    const err = new Error('the serializer failed')
    let given: unknown
    const action = createFullModeRetryAction(fullModeDeps(RESTART_OUTCOME_LAUNCHED, {
      isInFlight,
      retry: async (_key, _cwd, predicate) => {
        given = predicate
        throw err
      },
    }))

    await expect(action(KEY, FULL_RETRY)).rejects.toBe(err)
    expect(given).toBe(isInFlight)
  })

  test.each<[string, () => boolean]>([
    ['answers true', () => true],
    ['throws (counted as in flight)', () => { throw new Error('the in-flight lookup failed') }],
  ])('pending-only: an in-flight predicate that %s answers a launch-in-flight refusal on a pending row, with no row read and no retry entry call', async (_what, isInFlight) => {
    const deps = fullModeDeps(RESTART_OUTCOME_LAUNCHED, { isInFlight }, 'waiting')

    expect(await createFullModeRetryAction(deps)(KEY, PENDING_ONLY_RETRY)).toEqual({
      kind: 'again',
      reason: UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT,
      row: UNAVAILABLE_RETRY_ROW_PENDING,
    })
    expect(deps.reads).toEqual([])
    expect(deps.calls).toEqual([])
  })

  test('pending-only: a row read that rejects rejects the action, with no retry entry call', async () => {
    const err = errCallTimeout('status')
    const deps = fullModeDeps(RESTART_OUTCOME_LAUNCHED, {}, err)

    await expect(createFullModeRetryAction(deps)(KEY, PENDING_ONLY_RETRY)).rejects.toBe(err)
    expect(deps.reads).toEqual([[KEY, true]])
    expect(deps.calls).toEqual([])
  })

  // b.jg5 SRJ-305, SRJ-512, SRJ-513: the latched query asked again after the
  // row read. On the harness the latch's hold stops the timer first, so this
  // backstop is reached only here: the persona latches during the read, which
  // answers a row that would otherwise be handed to the restart path.
  test('pending-only: a row read during which the persona latches, answering ended, stops with the latch’s reason, with no hand-off and no retry entry call', async () => {
    let latchedNow = false
    const base = fullModeDeps(RESTART_OUTCOME_LAUNCHED, { isLatched: () => latchedNow }, 'ended')
    const deps: StandInDeps = {
      ...base,
      readRow: async (key) => {
        const row = await base.readRow(key)
        latchedNow = true
        return row
      },
    }

    expect(await createFullModeRetryAction(deps)(KEY, PENDING_ONLY_RETRY)).toEqual({ kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_LATCHED })
    expect(deps.reads).toEqual([[KEY, true]])
    expect(deps.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The full-mode retry end to end (b.jg5 SRJ-302, SRJ-303, SRJ-305) on the
// recovery harness's default action: the real restart entry over the
// production adapters, the relaunch gate and one serializer, against the stub
// ---------------------------------------------------------------------------

/** A row state the stub's `status` can answer. */
type RowState = NonNullable<NonNullable<Parameters<typeof cannedStatusResult>[0]>['state']>

/** The stub's rows, as `modelRow` keeps them. */
interface RowModel {
  /** The clock time of every spawn call, in order, over every persona. */
  readonly spawnedAt: number[]
  /** From now on every instance, spawned ones included, reads `state` until its next spawn resolves. */
  set(state: RowState): void
}

/**
 * Model each persona's row on the harness stub: `status` reads `initial`
 * (`ErrSpawnNotFound` for `UNAVAILABLE_RETRY_ROW_ABSENT`, no row) until a
 * spawn for that instance resolves, and `waiting` from then on; `set` starts
 * that over from another state. Every spawn call's clock time is recorded.
 * While `refuse`, when given, answers an error, every `status` answers that
 * error instead.
 */
function modelRow(h: RecoveryHarness, initial: RowState | typeof UNAVAILABLE_RETRY_ROW_ABSENT, refuse?: () => Error | undefined): RowModel {
  const spawnedAt: number[] = []
  const live = new Set<string>()
  let before = initial
  const client = h.stub.client
  const spawn = client.spawn.bind(client)
  client.spawn = async (params) => {
    spawnedAt.push(h.clock.now())
    const result = await spawn(params)
    live.add(String(params.claude_instance_id))
    return result
  }
  h.script({
    statusFn: (params) => {
      const refused = refuse?.()
      if (refused !== undefined) return refused
      if (live.has(String(params.claude_instance_id))) return cannedStatusResult({ state: 'waiting' })
      return before === UNAVAILABLE_RETRY_ROW_ABSENT ? errSpawnNotFound() : cannedStatusResult({ state: before })
    },
  })
  return {
    spawnedAt,
    set: (state) => {
      before = state
      live.clear()
    },
  }
}

/** The stub's calls made since `before` (a `callCounts` snapshot), by verb, leaving out verbs not called since. */
function callsSince(h: RecoveryHarness, before: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(callCounts(h)).map(([verb, n]) => [verb, n - (before[verb] ?? 0)] as const).filter(([, n]) => n > 0),
  )
}

/** Arm `key` now and `other` half a base wait later, so `other`'s retry falls due after `key`'s first. */
async function armBoth(h: RecoveryHarness, key: string, other: string): Promise<void> {
  h.controller.arm(key, UNAVAILABLE)
  await h.advance(waitMs(0) / 2)
  h.controller.arm(other, UNAVAILABLE)
}

describe('unavailable retry: the full-mode retry on the recovery harness (SRJ-302, SRJ-303, SRJ-305)', () => {
  test('AC 26: with both settings 0 and agent-director’s default settings, a refused bring-up spawns at each due time and never early, counts nothing past the cap, posts one onset at the first retry at or past the onset floor and one alert once past the alert threshold (none at it) while the retries go on, launches once when the refusal clears and posts one recovery, runs on at the next wait in pending-only mode, and its next retry reads the row once and stops with nothing pending', async () => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    expect(h.settings()).toEqual(DEFAULT_AD_SETTINGS_IN_EFFECT)
    const [key] = h.keys as [string]
    const row = modelRow(h, 'missing')
    h.script({ spawnError: errTmuxUnresponsive('spawn') })

    const refusedAt = h.clock.now()
    expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })
    expect(row.spawnedAt).toEqual([refusedAt])
    expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBe(refusedAt)

    // SRJ-302's alert half (b.jg5 SRJ-308 to SRJ-310): the condition's posts
    // so far, in order. The onset comes at the first retry at or past the
    // floor (the health check is off); the alert once the condition has
    // lasted strictly longer than the threshold in effect, between two
    // retries at the defaults.
    const thresholdMs = adAlertThresholdMsInEffect()
    const alertAt = refusedAt + thresholdMs
    const posts: string[] = []
    const expectPosts = (): void => {
      expect(h.episodeNotices).toEqual(posts.map((text) => ({ key, text })))
    }
    const postedLines = (what: string): string[] => conditionLines(h, key).filter((line) => line.includes(` ${what} posted`))
    let onsetDone = false

    const refusals = RESTART_FAILURE_CAP + refusalsToCeiling() + 2
    let dueAt = refusedAt
    for (let n = 0; n < refusals; n++) {
      dueAt += waitMs(n)
      if (h.clock.now() <= alertAt && alertAt < dueAt - 1) {
        await h.advance(alertAt - h.clock.now())
        expectPosts()
        await h.advance(1)
        posts.push(tmuxUnresponsiveAlertText(key, thresholdMs))
        expectPosts()
        expect(postedLines('alert')).toHaveLength(1)
        // The alert check is done: the retry timer is the only timer left,
        // with its due time, and nothing is counted.
        expect(h.clock.pending().map((t) => t.dueAt)).toEqual([dueAt])
        expect(getFailureCount(key)).toBe(0)
      }
      await h.advance(dueAt - 1 - h.clock.now())
      expect(row.spawnedAt).toHaveLength(n + 1)
      expectPosts()
      await h.advance(1)
      await h.settle()
      expect(row.spawnedAt).toHaveLength(n + 2)
      expect(row.spawnedAt[n + 1]).toBe(dueAt)
      // The refused retry re-arms on the refusal it met during its run, at
      // the next wait of the one sequence.
      const retry = n + 1
      const prefix = `[slack] unavailable-retry: persona=${key} retry ${retry}: ${UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE}: `
      const suffix = ` — re-armed, next retry in ${waitMs(retry) / 1000} s`
      expect([retry, h.lines.filter((l) => l.startsWith(prefix) && l.endsWith(suffix))]).toEqual([retry, [expect.any(String)]])
      if (!onsetDone && dueAt - refusedAt >= TMUX_UNRESPONSIVE_ONSET_FLOOR_MS) {
        onsetDone = true
        posts.push(tmuxUnresponsiveOnsetText(key))
      }
      expectPosts()
      expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBe(refusedAt)
    }
    // One onset, then one alert, with every retry above (those after the
    // alert included) made on its schedule.
    expect(posts).toEqual([tmuxUnresponsiveOnsetText(key), tmuxUnresponsiveAlertText(key, thresholdMs)])
    expect(postedLines('onset')).toHaveLength(1)
    expect(postedLines('alert')).toHaveLength(1)
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', dueAt: dueAt + waitMs(refusals), refusals })
    expect(getFailureCount(key)).toBe(0)
    expect(h.capReached).toEqual([])

    h.script({ spawnError: undefined })
    dueAt += waitMs(refusals)
    await h.advance(dueAt - h.clock.now())
    await h.settle()
    expect(row.spawnedAt.slice(refusals + 1)).toEqual([dueAt])
    expect(h.lines).toContain(reArmedLine(key, refusals + 1, UNAVAILABLE_RETRY_AGAIN_LAUNCHED, refusals + 1, { switchedTo: UNAVAILABLE_RETRY_MODE_PENDING_ONLY }))
    // The launch's successful spawn ends the condition after its onset: one
    // recovery.
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    posts.push(tmuxUnresponsiveRecoveryText(key))
    expectPosts()
    expect(postedLines('recovery')).toHaveLength(1)
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: dueAt + waitMs(refusals + 1),
      waitMs: waitMs(refusals + 1),
      refusals: refusals + 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })

    // The launch's row now reads `waiting` and the session is not connected:
    // the pending-only retry reads the row, and nothing else, and stops.
    const before = callCounts(h)
    await retryNow(h, key)
    expect(h.attempts.at(-1)).toMatchObject({ key, retry: refusals + 2, mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY })
    expect(callsSince(h, before)).toEqual({ statusCalls: 1 })
    expect(h.stub.calls.statusCalls.at(-1)).toMatchObject({ claude_instance_id: personaInstanceId(key) })
    expect(row.spawnedAt).toHaveLength(refusals + 2)
    expect(h.lines).toContain(pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting'))
    expect(h.controller.isArmed(key)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    expect(getFailureCount(key)).toBe(0)
    expect(h.capReached).toEqual([])
    expectPosts()
  })

  test('AC 30 (its alert part): with both settings 0, a condition that ends through a successful read-pane after its onset, while a retry last read the row pending, posts one recovery, cancels its alert check and leaves the retry timer armed with its due time; that retry fires and no alert is ever posted', async () => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key] = h.keys as [string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_PENDING)
    const refusedAt = await refuseLaunch(h, key)
    const alertDueAt = refusedAt + adAlertThresholdMsInEffect() + 1

    // Each retry reads the row pending, which ends nothing (its liveness read
    // defers it); the first at or past the onset floor posts the onset.
    while (h.clock.now() - refusedAt < TMUX_UNRESPONSIVE_ONSET_FLOOR_MS) await retryNow(h, key)
    expect(h.tmuxUnresponsive.holds(key)).toBe(true)
    const onset = { key, text: tmuxUnresponsiveOnsetText(key) }
    expect(h.episodeNotices).toEqual([onset])
    const before = h.controller.view(key)!
    expect(before).toMatchObject({ phase: 'waiting', mode: UNAVAILABLE_RETRY_MODE_FULL, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
    // The alert check is still pending beside the retry timer.
    expect(h.clock.now()).toBeLessThan(alertDueAt)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([alertDueAt, before.dueAt!].sort((a, b) => a - b))

    await readPaneSucceeds(h, key)

    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(conditionLines(h, key).slice(-2)).toEqual([
      conditionEndedLine(key, TMUX_UNRESPONSIVE_END_TMUX_VERB),
      conditionRecoveryLine(key),
    ])
    expect(h.episodeNotices).toEqual([onset, { key, text: tmuxUnresponsiveRecoveryText(key) }])
    expect(h.conditionEnds).toEqual([{ key, reading: undefined, result: 'kept' }])
    expect(retryLinesOf(h, key).at(-1)).toBe(keptLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED, UNAVAILABLE_RETRY_KEPT_ROW_PENDING))
    // The alert check is cancelled; the retry timer is armed as it was.
    expect(h.controller.view(key)).toEqual(before)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([before.dueAt!])

    // Past the alert check's due time the retry fires at its due time, and
    // nothing more is posted.
    const attempts = h.attempts.length
    await retryNow(h, key)
    expect(h.clock.now()).toBeGreaterThan(alertDueAt)
    expect(h.attempts.slice(attempts)).toEqual([{ key, retry: before.refusals + 1, causes: before.causes, mode: UNAVAILABLE_RETRY_MODE_FULL, at: before.dueAt! }])
    expect(h.episodeNotices).toEqual([onset, { key, text: tmuxUnresponsiveRecoveryText(key) }])
    expect(conditionLines(h, key).filter((line) => line.includes(' alert posted'))).toEqual([])
    expect(getFailureCount(key)).toBe(0)
  })

  /** A full-mode retry that re-arms: its again-reason, and the mode and last row read it leaves. */
  interface ReArmed {
    readonly reason: string
    readonly mode: UnavailableRetryMode
    readonly lastRow?: string
  }

  test.each<[string, RowState, boolean, Record<string, number>, string | ReArmed]>([
    ['live and connected with its stream: nothing left to recover, no launch', 'waiting', true, { statusCalls: 1 }, UNAVAILABLE_RETRY_STOP_RECOVERED],
    ['live and not connected: a reconnect that succeeds, never a spawn, and nothing left to recover', 'waiting', false, { statusCalls: 2, readPaneCalls: 1, sendKeysCalls: 1 }, UNAVAILABLE_RETRY_STOP_RECOVERED],
    // A `pending` liveness reading is deferred by the restart work itself
    // (b.jg5 SRJ-314), whatever the connection shows: its one status read,
    // and no reconnect (so no second status read), send-keys, kill or spawn.
    ['pending and not connected: the liveness read defers it, no reconnect and never a spawn, and the timer runs on in full mode, its last row read pending', 'pending', false, { statusCalls: 1 }, { reason: UNAVAILABLE_RETRY_AGAIN_PENDING_DEFERRED, mode: UNAVAILABLE_RETRY_MODE_FULL, lastRow: UNAVAILABLE_RETRY_ROW_PENDING }],
    ['pending and connected with its stream: never nothing left to recover; the liveness read defers it, and the timer runs on in full mode, its last row read pending', 'pending', true, { statusCalls: 1 }, { reason: UNAVAILABLE_RETRY_AGAIN_PENDING_DEFERRED, mode: UNAVAILABLE_RETRY_MODE_FULL, lastRow: UNAVAILABLE_RETRY_ROW_PENDING }],
    ['ended: a kill and a launch, and the timer runs on in pending-only mode, its last row read the launch’s pending', 'ended', false, { statusCalls: 2, killCalls: 1, spawnCalls: 1 }, { reason: UNAVAILABLE_RETRY_AGAIN_LAUNCHED, mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING }],
    ['missing: a kill and a launch, and the timer runs on in pending-only mode, its last row read the launch’s pending', 'missing', false, { statusCalls: 2, killCalls: 1, spawnCalls: 1 }, { reason: UNAVAILABLE_RETRY_AGAIN_LAUNCHED, mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING }],
  ])('a retry that finds the row %s', async (_what, state, connected, calls, outcome) => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    modelRow(h, state)
    h.setConnected(key, connected)
    await armBoth(h, key, other)

    await retryNow(h, key)

    expect(callCounts(h)).toEqual(calls)
    expect(h.controller.isArmed(other)).toBe(true)
    if (typeof outcome === 'string') {
      expect(h.lines).toContain(stoppedLine(key, outcome))
      expect(h.controller.isArmed(key)).toBe(false)
    } else {
      const switchedTo = outcome.mode === UNAVAILABLE_RETRY_MODE_FULL ? undefined : outcome.mode
      expect(h.lines).toContain(reArmedLine(key, 1, outcome.reason, 1, { switchedTo }))
      expect(h.controller.view(key)).toEqual({
        phase: 'waiting',
        dueAt: h.clock.now() + waitMs(1),
        waitMs: waitMs(1),
        refusals: 1,
        causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
        mode: outcome.mode,
        ...(outcome.lastRow !== undefined ? { lastRow: outcome.lastRow } : {}),
      })
    }
    expect(getFailureCount(key)).toBe(0)
  })

  test('with both settings 0, a retry that finds the row pending and the session connected with its stream hands it, with its launch start, to the pending deferral once: no kill, spawn, resume or send-keys, nothing counted, re-armed at the next wait in full mode and kept through either condition end; a following retry that finds it live, connected and with its stream stops the timer', async () => {
    // The pending deferral wired as main() wires it: the server's
    // deferPendingRow, given the reading's launch start.
    const deferred: Array<readonly [string, PendingLivenessReading]> = []
    const h = (harness = makeRecoveryHarness({
      restartDeps: {
        deferPendingRow: (k, reading) => {
          deferred.push([k, reading])
          deferPendingRow(k, reading.launchStartedAt)
        },
      },
    }))
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key] = h.keys as [string]
    let state: RowState = UNAVAILABLE_RETRY_ROW_PENDING
    h.script({
      statusFn: () => state === UNAVAILABLE_RETRY_ROW_PENDING
        ? cannedStatusResult({ state, launch_started_at: SAMPLE_LAUNCH_START_FRACTIONAL })
        : cannedStatusResult({ state }),
    })
    h.setConnected(key, true)
    // A failure counted beforehand: a success recorded by the retry would
    // clear it, and a failure would add to it.
    recordFailure(key)
    h.controller.arm(key, UNAVAILABLE)
    const armedAt = h.clock.now()

    await retryNow(h, key)

    expect(h.attempts).toEqual([{ key, retry: 1, causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE], mode: UNAVAILABLE_RETRY_MODE_FULL, at: armedAt + waitMs(0) }])
    // Its liveness read, and nothing else: no reconnect read, send-keys,
    // pane read, kill, spawn or resume.
    expect(callCounts(h)).toEqual({ statusCalls: 1 })
    expect(deferred).toEqual([[key, { kind: LIVENESS_PENDING, launchStartedAt: SAMPLE_LAUNCH_START_FRACTIONAL }]])
    expect(h.errors.filter((line) => line.includes(`persona=${key}`) && line.includes(SAMPLE_LAUNCH_START_FRACTIONAL))).toHaveLength(1)
    expect(getFailureCount(key)).toBe(1)
    expect(h.capReached).toEqual([])
    expect(h.triggers).toEqual([])
    expect(retryLinesOf(h, key).at(-1)).toBe(reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_PENDING_DEFERRED, 1))
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })
    expect(delays(h.clock)).toEqual([waitMs(1)])
    // E8's condition-end entry (SRJ-306) keeps the timer on the pending row.
    expectKeptThroughEveryConditionEnd(h, key, UNAVAILABLE_RETRY_KEPT_ROW_PENDING)

    // The session starts: the row reads live, connected with its stream.
    state = 'waiting'
    const before = callCounts(h)
    await retryNow(h, key)

    expect(h.attempts.map((a) => [a.retry, a.mode])).toEqual([[1, UNAVAILABLE_RETRY_MODE_FULL], [2, UNAVAILABLE_RETRY_MODE_FULL]])
    expect(callsSince(h, before)).toEqual({ statusCalls: 1 })
    expect(deferred).toHaveLength(1)
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_RECOVERED))
    expectStopped(h, key)
  })

  test('a retry that finds the launch in flight makes no agent-director call and re-arms at the doubled wait; once the launch settles the next retry acts', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const hold = holdSpawns(h.stub.client)
    const launch = h.launch(key)
    await hold.entered(personaInstanceId(key))
    h.controller.arm(key, UNAVAILABLE)
    const before = h.stub.callCount()

    await h.advance(waitMs(0))

    expect(h.stub.callCount()).toBe(before)
    expect(h.lines).toContain(reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT, 1))
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', dueAt: h.clock.now() + waitMs(1), refusals: 1 })

    hold.release(personaInstanceId(key))
    expect(await launch).toMatchObject({ key, action: 'spawned' })
    await h.settle()
    h.setConnected(key, true)
    const settled = h.stub.calls.statusCalls.length
    await retryNow(h, key)

    expect(h.stub.calls.statusCalls.length).toBe(settled + 1)
    expect(hold.calls).toHaveLength(1)
    expect(h.lines).toContain(stoppedLine(key, UNAVAILABLE_RETRY_STOP_RECOVERED))
    expect(h.controller.isArmed(key)).toBe(false)
  })

  test('a retry fired while the persona’s serializer turn is held waits, calling nothing, and acts once the turn frees', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    h.setConnected(key, true)
    const gate = Promise.withResolvers<void>()
    const turn = h.serializer.run(key, () => gate.promise)
    h.controller.arm(key, UNAVAILABLE)

    await h.advance(waitMs(0))
    expect(h.attempts).toHaveLength(1)
    expect(h.controller.view(key)?.phase).toBe('running')
    expect(h.stub.callCount()).toBe(0)

    gate.resolve()
    await turn
    await h.settle()

    expect(callCounts(h)).toEqual({ statusCalls: 1 })
    expect(h.lines).toContain(stoppedLine(key, UNAVAILABLE_RETRY_STOP_RECOVERED))
    expect(h.controller.isArmed(key)).toBe(false)
  })

  test.each<[string, () => Error]>([
    ['a plain Error', () => new Error('boom')],
    ['ErrCallTimeout', () => errCallTimeout('status')],
    ['a CONFIG answer', () => errConfigMalformed()],
  ])('a retry whose liveness status answers %s reads unknown: its status call and nothing else, re-armed at the next wait with the last row read kept, never stopped and nothing counted past the cap; once status answers ended the next retry kills and launches once', async (_what, make) => {
    // The arm hook wired as main() wires it: the read-error cause on the controller.
    const hooked: string[] = []
    const h = (harness = makeRecoveryHarness({
      restartDeps: {
        armRetryTimer: (k) => {
          hooked.push(k)
          harness!.controller.arm(k, { kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR })
        },
      },
    }))
    const [key] = h.keys as [string]
    let answer: RowState | Error = 'pending'
    h.script({
      statusFn: () => {
        if (h.stub.calls.spawnCalls.length > 0) return cannedStatusResult({ state: 'waiting' })
        return answer instanceof Error ? answer : cannedStatusResult({ state: answer })
      },
    })
    h.controller.arm(key, UNAVAILABLE)

    // The first retry reads the row pending: its last row read is pending.
    await retryNow(h, key)
    expect(h.controller.view(key)).toMatchObject({ refusals: 1, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })

    answer = make()
    const last = RESTART_FAILURE_CAP + 2
    for (let retry = 2; retry <= last; retry++) {
      const before = callCounts(h)
      await retryNow(h, key)
      expect([retry, callsSince(h, before)]).toEqual([retry, { statusCalls: 1 }])
      expect(h.lines).toContain(reArmedLine(key, retry, UNAVAILABLE_RETRY_AGAIN_LIVENESS_UNKNOWN, retry))
      // The arm hook called during the retry keeps the retry's own backoff.
      expect(h.controller.view(key)).toMatchObject({
        phase: 'waiting',
        dueAt: h.clock.now() + waitMs(retry),
        waitMs: waitMs(retry),
        refusals: retry,
        mode: UNAVAILABLE_RETRY_MODE_FULL,
        lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
      })
    }
    expect(hooked).toEqual(Array<string>(last - 1).fill(key))
    expect(getFailureCount(key)).toBe(0)
    expect(h.capReached).toEqual([])

    answer = 'ended'
    const before = callCounts(h)
    await retryNow(h, key)
    expect(callsSince(h, before)).toEqual({ statusCalls: 2, killCalls: 1, spawnCalls: 1 })
    expect(h.lines).toContain(reArmedLine(key, last + 1, UNAVAILABLE_RETRY_AGAIN_LAUNCHED, last + 1, { switchedTo: UNAVAILABLE_RETRY_MODE_PENDING_ONLY }))
    expect(getFailureCount(key)).toBe(0)
  })
})

describe('unavailable retry: the stop rules that exist now on the recovery harness (SRJ-305, AC 28)', () => {
  test('the restart cap: each counted launch failure re-arms at the doubled wait until the cap stops the timer, with onCapReached once and its notice', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    const row = modelRow(h, 'missing')
    h.script({ spawnError: errTmuxSessionCreate('spawn') })
    h.controller.arm(key, UNAVAILABLE)
    h.controller.arm(other, UNAVAILABLE)
    h.setAction(async (k, attempt) => (k === key ? h.fullModeAction(k, attempt) : { kind: 'again' }))

    for (let n = 1; n < RESTART_FAILURE_CAP; n++) {
      await retryNow(h, key)
      expect(getFailureCount(key)).toBe(n)
      expect(h.lines).toContain(reArmedLine(key, n, UNAVAILABLE_RETRY_AGAIN_LAUNCH_FAILED, n))
      expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', dueAt: h.clock.now() + waitMs(n), refusals: n })
    }
    expect(h.capReached).toEqual([])
    await retryNow(h, key)

    expect(getFailureCount(key)).toBe(RESTART_FAILURE_CAP)
    expect(new Set(row.spawnedAt).size).toBe(RESTART_FAILURE_CAP)
    expect(h.capReached).toEqual([key])
    expect(h.notices.filter((n) => n.text.includes('automatic restarts suspended'))).toEqual([expect.objectContaining({ key })])
    expect(h.lines).toContain(stoppedLine(key, UNAVAILABLE_RETRY_STOP_CAPPED))
    expect(h.controller.isArmed(key)).toBe(false)
    expect(h.controller.isArmed(other)).toBe(true)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([h.controller.view(other)!.dueAt!])
  })

  test('a retry queued behind restart work whose counted failure reaches the cap answers capped from its entry: no second launch, nothing more counted, one cap notice, and the timer stops', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    for (let i = 1; i < RESTART_FAILURE_CAP; i++) recordFailure(key)
    h.script({ statusFn: () => cannedStatusResult({ state: 'missing' }), spawnError: errTmuxSessionCreate('spawn') })
    // Only the first spawn is held; the launch's one spawn retry after
    // ErrTmuxSessionCreate reaches the stub, which fails it too.
    let first = true
    const hold = holdSpawns(h.stub.client, () => {
      const held = first
      first = false
      return held
    })
    h.controller.arm(key, UNAVAILABLE)

    // Restart work for the persona holds its serializer turn at its launch.
    const restart = runRestartRetry(key, personaOf(h, key).working_directory, isLaunchInFlight)
    await hold.entered(personaInstanceId(key))
    // The retry fires one failure short of the cap, so the timer's own cap
    // check lets it call the entry, whose work waits for the turn.
    await h.advance(waitMs(0))
    expect(h.attempts).toHaveLength(1)
    expect(h.controller.view(key)?.phase).toBe('running')

    // The held launch fails, counted: that failure reaches the cap.
    hold.fail(personaInstanceId(key), errTmuxSessionCreate('spawn'))
    expect(await restart).toBe(RESTART_OUTCOME_CAPPED)
    await h.settle()

    expect(h.errors.filter((line) => line.startsWith(`[slack] Relaunching session for persona=${key} `))).toHaveLength(1)
    expect(hold.calls).toHaveLength(2)
    expect(callCounts(h)).toEqual({ statusCalls: 1, killCalls: 1, spawnCalls: 1 })
    expect(getFailureCount(key)).toBe(RESTART_FAILURE_CAP)
    expect(h.capReached).toEqual([key])
    expect(h.notices.filter((n) => n.text.includes('automatic restarts suspended'))).toEqual([expect.objectContaining({ key })])
    expect(h.errors.filter((line) => line.startsWith(`[slack] Restart retry skipped for persona=${key}`))).toEqual([
      `[slack] Restart retry skipped for persona=${key} — the persona is at the restart cap; nothing killed or launched`,
    ])
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_CAPPED))
    expectStopped(h, key)
  })

  test.each<[string, (h: RecoveryHarness, key: string) => void, string]>([
    ['not up (its bring-up owns it)', (h, key) => h.setUp(key, false), UNAVAILABLE_RETRY_STOP_NOT_UP],
    ['out of the applied configuration', (h, key) => h.remove(key), UNAVAILABLE_RETRY_STOP_NOT_APPLIED],
    ['at the restart cap already', (_h, key) => {
      for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(key)
    }, UNAVAILABLE_RETRY_STOP_CAPPED],
  ])('a persona %s: its next retry stops the timer with no agent-director call; the other persona stays armed, and its retry proceeds', async (_what, drive, reason) => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    await armBoth(h, key, other)
    const otherDue = h.controller.view(other)!.dueAt!

    drive(h, key)
    await retryNow(h, key)

    expect(h.attempts.map((a) => a.key)).toEqual([key])
    expect(h.stub.callCount()).toBe(0)
    expect(h.lines).toContain(stoppedLine(key, reason))
    expect(h.controller.isArmed(key)).toBe(false)
    expect(h.controller.view(other)).toMatchObject({ phase: 'waiting', dueAt: otherDue })
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([otherDue])

    h.setConnected(other, true)
    await retryNow(h, other)
    expect(h.stub.calls.statusCalls.map((params) => params.claude_instance_id)).toEqual([personaInstanceId(other)])
    expect(h.lines).toContain(stoppedLine(other, UNAVAILABLE_RETRY_STOP_RECOVERED))
  })

  test('a trigger for a key no longer applied arms it, and its first retry stops it with no agent-director call', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    h.remove(key)
    h.script({ spawnError: errTmuxUnresponsive('spawn') })

    h.controller.arm(key, UNAVAILABLE)
    await retryNow(h, key)

    expect(h.attempts).toHaveLength(1)
    expect(h.stub.callCount()).toBe(0)
    expect(h.lines).toContain(stoppedLine(key, UNAVAILABLE_RETRY_STOP_NOT_APPLIED))
    expect(h.clock.pendingCount()).toBe(0)
  })

  test('teardown stops the persona’s timer at once, and it never fires; the other persona stays armed', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    await armBoth(h, key, other)
    const otherDue = h.controller.view(other)!.dueAt!

    h.teardown(key)
    await h.advance(otherDue - 1 - h.clock.now())

    expect(h.attempts).toEqual([])
    expect(h.stub.callCount()).toBe(0)
    expect(h.lines).toContain(stoppedLine(key, UNAVAILABLE_RETRY_STOP_TORN_DOWN))
    expect(h.controller.isArmed(key)).toBe(false)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([otherDue])
  })

  test('shutdown stops every persona’s timer and arms none again: nothing fires however far the clock goes', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    await armBoth(h, key, other)
    h.script({ spawnError: errTmuxUnresponsive('spawn') })

    h.shutdown()
    // The closed controller refuses the arm (its sink answers false), so the
    // launch is a plain failure, not marked refused.
    expect(await h.launch(key)).toEqual({ key, action: 'failed' })
    await h.advance(waitMs(refusalsToCeiling()) * (RESTART_FAILURE_CAP + 2))

    expect(h.attempts).toEqual([])
    expect(h.controller.armedKeys()).toEqual([])
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.stub.calls.spawnCalls).toHaveLength(1)
    expect(h.lines).toEqual(expect.arrayContaining([
      stoppedLine(key, UNAVAILABLE_RETRY_STOP_SHUTDOWN),
      stoppedLine(other, UNAVAILABLE_RETRY_STOP_SHUTDOWN),
    ]))
    expect(h.lines.filter((line) => line.includes(`persona=${key} not armed (${UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE}`))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Pending-only mode (b.jg5 SRJ-301, SRJ-303, SRJ-305) on the recovery harness's
// default action, armed directly (`armPendingOnly`) until covered `pending`
// rows exist. The pending-row rule's runs and laps are later work: no case
// here asserts one.
// ---------------------------------------------------------------------------

/** The line a direct pending-only arm logs. */
function pendingOnlyArmedLine(key: string): string {
  return `[slack] unavailable-retry: persona=${key} armed in pending-only mode (${UNAVAILABLE_RETRY_CAUSE_PENDING_ROW}) — first retry in ${waitMs(0) / 1000} s`
}

/** The line a pending-only retry logs as it starts. */
function pendingOnlyRetryLine(key: string, retry: number): string {
  return `[slack] unavailable-retry: persona=${key} retry ${retry} (pending-only) — reading its row`
}

/** The retry timer's lines for persona `key`, in order. */
function retryLinesOf(h: RecoveryHarness, key: string): string[] {
  return h.lines.filter((line) => line.startsWith(`[slack] unavailable-retry: persona=${key} `))
}

/** Persona `key`'s timer is stopped and nothing is pending on the clock. */
function expectStopped(h: RecoveryHarness, key: string): void {
  expect(h.controller.isArmed(key)).toBe(false)
  expect(h.clock.pendingCount()).toBe(0)
}

describe('unavailable retry: pending-only mode on the recovery harness (SRJ-301, SRJ-303, SRJ-305)', () => {
  test('a row still pending: armed at the base wait, each retry’s only agent-director call is its one row read, and the next wait doubles', async () => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_PENDING)

    h.controller.armPendingOnly(key)
    expect(retryLinesOf(h, key)).toEqual([pendingOnlyArmedLine(key)])
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(0),
      waitMs: waitMs(0),
      refusals: 0,
      causes: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW],
      mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })

    for (const retry of [1, 2]) {
      const before = callCounts(h)
      await retryNow(h, key)
      expect(callsSince(h, before)).toEqual({ statusCalls: 1 })
      expect(h.stub.calls.statusCalls.at(-1)).toEqual({ claude_instance_id: personaInstanceId(key) })
      expect(retryLinesOf(h, key).slice(-2)).toEqual([
        pendingOnlyRetryLine(key, retry),
        reArmedLine(key, retry, UNAVAILABLE_RETRY_AGAIN_ROW_PENDING, retry, { ranPendingOnly: true }),
      ])
      expect(h.controller.view(key)).toEqual({
        phase: 'waiting',
        dueAt: h.clock.now() + waitMs(retry),
        waitMs: waitMs(retry),
        refusals: retry,
        causes: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW],
        mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
        lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
      })
    }
    expect(h.attempts.map((a) => [a.key, a.mode])).toEqual([[key, UNAVAILABLE_RETRY_MODE_PENDING_ONLY], [key, UNAVAILABLE_RETRY_MODE_PENDING_ONLY]])
    expect(h.triggers).toEqual([])
    expect(h.controller.isArmed(other)).toBe(false)
    expect(getFailureCount(key)).toBe(0)
  })

  test('a row reported in but not connected (waiting): the retry reads the row, makes no other call (no send-keys, spawn, resume or kill), and the timer stops', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    modelRow(h, 'waiting')
    h.setConnected(key, false)
    h.controller.armPendingOnly(key)

    await retryNow(h, key)

    expect(callCounts(h)).toEqual({ statusCalls: 1 })
    expect(retryLinesOf(h, key)).toEqual([
      pendingOnlyArmedLine(key),
      pendingOnlyRetryLine(key, 1),
      pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting'),
    ])
    expectStopped(h, key)
  })

  test.each(['ended', 'missing', UNAVAILABLE_RETRY_ROW_ABSENT] as const)('a row read %s: the timer stops, then one run of the restart decision (one kill, one launch), and the timer is done', async (state) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const row = modelRow(h, state)
    h.controller.armPendingOnly(key)
    const dueAt = h.controller.view(key)!.dueAt!

    await retryNow(h, key)

    // The row read, then the restart decision's liveness read, kill, spawn
    // and readiness read.
    expect(callCounts(h)).toEqual({ statusCalls: 3, killCalls: 1, spawnCalls: 1 })
    expect(row.spawnedAt).toEqual([dueAt])
    expect(retryLinesOf(h, key)).toEqual([
      pendingOnlyArmedLine(key),
      pendingOnlyRetryLine(key, 1),
      pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_ROW_GONE, state),
    ])
    expect(h.triggers).toEqual([])
    expectStopped(h, key)
    expect(getFailureCount(key)).toBe(0)
  })

  test('a refused launch in that restart run arms a fresh full-mode timer through the trigger sink, after the stop', async () => {
    const h = (harness = makeRecoveryHarness(RETRY_TIMER_ONLY))
    const [key] = h.keys as [string]
    modelRow(h, 'ended')
    h.script({ spawnError: errTmuxUnresponsive('spawn') })
    h.controller.armPendingOnly(key)

    await retryNow(h, key)

    expect(h.stub.calls.spawnCalls).toHaveLength(1)
    expect(h.triggers).toEqual([{ key, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }])
    const lines = retryLinesOf(h, key)
    expect(lines.slice(0, 3)).toEqual([
      pendingOnlyArmedLine(key),
      pendingOnlyRetryLine(key, 1),
      pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_ROW_GONE, 'ended'),
    ])
    expect(lines.slice(3)).toEqual([expect.stringMatching(new RegExp(`^\\[slack\\] unavailable-retry: persona=${key} armed \\(${UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE}: .* — first retry in ${waitMs(0) / 1000} s$`))])
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(0),
      waitMs: waitMs(0),
      refusals: 0,
      causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
    })
    expect(delays(h.clock)).toEqual([waitMs(0)])
    expect(getFailureCount(key)).toBe(0)
  })

  test('a full-mode cause while pending-only (a launch refused UNAVAILABLE) promotes the timer to full mode with its due time kept, and the next retry runs the full decision', async () => {
    const h = (harness = makeRecoveryHarness(RETRY_TIMER_ONLY))
    const [key] = h.keys as [string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_PENDING)
    h.controller.armPendingOnly(key)
    const dueAt = h.controller.view(key)!.dueAt!
    await h.advance(waitMs(0) / 2)

    h.script({ spawnError: errTmuxUnresponsive('spawn') })
    expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })
    h.script({ spawnError: undefined })

    expect(retryLinesOf(h, key).slice(1)).toEqual([
      expect.stringMatching(new RegExp(`^\\[slack\\] unavailable-retry: persona=${key} promoted to full mode \\(${UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE}: .* — its due time is kept$`)),
    ])
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt,
      waitMs: waitMs(0),
      refusals: 0,
      causes: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([dueAt])

    // The full decision on a pending row: its liveness read, which defers it
    // (b.jg5 SRJ-314), so one status read, as a pending-only retry's row read
    // would be; the full decision shows in the retry's mode and in its
    // pending-deferred again-reason (a pending-only retry answers row-pending).
    const before = callCounts(h)
    await retryNow(h, key)
    expect(h.attempts).toEqual([{ key, retry: 1, causes: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE], mode: UNAVAILABLE_RETRY_MODE_FULL, at: dueAt }])
    expect(callsSince(h, before)).toEqual({ statusCalls: 1 })
    expect(h.lines).toContain(reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_PENDING_DEFERRED, 1))
    expect(h.controller.view(key)).toMatchObject({ mode: UNAVAILABLE_RETRY_MODE_FULL, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
  })

  test('a pending-only arm while in full mode leaves the timer in full mode with its due time, logs no line, and the next retry runs the full decision', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_PENDING)
    h.controller.arm(key, UNAVAILABLE)
    const dueAt = h.controller.view(key)!.dueAt!
    await h.advance(waitMs(0) / 2)
    const linesBefore = h.lines.length

    h.controller.armPendingOnly(key)

    expect(h.lines.slice(linesBefore)).toEqual([])
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt,
      waitMs: waitMs(0),
      refusals: 0,
      causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, UNAVAILABLE_RETRY_CAUSE_PENDING_ROW],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([dueAt])

    // The full decision: its liveness read defers the pending row (b.jg5
    // SRJ-314), its one status read; it answers pending-deferred, not the
    // pending-only row-pending.
    await retryNow(h, key)
    expect(h.attempts.map((a) => [a.mode, a.at])).toEqual([[UNAVAILABLE_RETRY_MODE_FULL, dueAt]])
    expect(callCounts(h)).toEqual({ statusCalls: 1 })
    expect(h.lines).toContain(reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_PENDING_DEFERRED, 1))
  })

  test('a full-mode retry whose launch succeeds leaves the timer in pending-only mode, the wait count carrying on, and its next retry reads only the launch’s row', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const row = modelRow(h, 'missing')
    h.controller.arm(key, UNAVAILABLE)

    await retryNow(h, key)
    expect(row.spawnedAt).toHaveLength(1)
    expect(h.lines).toContain(reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_LAUNCHED, 1, { switchedTo: UNAVAILABLE_RETRY_MODE_PENDING_ONLY }))
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })

    // The launch's row reads pending: one read, a refusal at the doubled wait.
    row.set(UNAVAILABLE_RETRY_ROW_PENDING)
    const before = callCounts(h)
    await retryNow(h, key)
    expect(h.attempts.map((a) => a.mode)).toEqual([UNAVAILABLE_RETRY_MODE_FULL, UNAVAILABLE_RETRY_MODE_PENDING_ONLY])
    expect(callsSince(h, before)).toEqual({ statusCalls: 1 })
    expect(h.stub.calls.statusCalls.at(-1)).toEqual({ claude_instance_id: personaInstanceId(key) })
    expect(h.lines).toContain(reArmedLine(key, 2, UNAVAILABLE_RETRY_AGAIN_ROW_PENDING, 2, { ranPendingOnly: true }))
    expect(h.controller.view(key)).toMatchObject({ dueAt: h.clock.now() + waitMs(2), refusals: 2, mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
  })

  test('a pending-only retry that finds the launch in flight makes no agent-director call, keeps its row pending and re-arms at the doubled wait; once the launch settles the next retry reads the row once', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    h.controller.armPendingOnly(key)
    const hold = holdSpawns(h.stub.client)
    const launch = h.launch(key)
    await hold.entered(personaInstanceId(key))
    const before = h.stub.callCount()

    await h.advance(h.controller.view(key)!.dueAt! - h.clock.now())

    expect(h.stub.callCount()).toBe(before)
    expect(retryLinesOf(h, key).slice(-2)).toEqual([
      pendingOnlyRetryLine(key, 1),
      `[slack] unavailable-retry: persona=${key} retry 1 (pending-only): ${UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT} — re-armed, next retry in ${waitMs(1) / 1000} s`,
    ])
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW],
      mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })

    // The launch settles and its row reads waiting (the stub's default): the
    // next retry's one call is its row read, and the timer stops.
    hold.release(personaInstanceId(key))
    expect(await launch).toMatchObject({ key, action: 'spawned' })
    await h.settle()
    const settled = callCounts(h)
    await retryNow(h, key)

    expect(callsSince(h, settled)).toEqual({ statusCalls: 1 })
    expect(hold.calls).toHaveLength(1)
    expect(h.attempts.map((a) => [a.retry, a.mode])).toEqual([[1, UNAVAILABLE_RETRY_MODE_PENDING_ONLY], [2, UNAVAILABLE_RETRY_MODE_PENDING_ONLY]])
    expect(retryLinesOf(h, key).at(-1)).toBe(pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting'))
    expectStopped(h, key)
  })

  test.each<[string, () => Error, string]>([
    ['UNAVAILABLE (ErrCallTimeout)', () => errCallTimeout('status'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['a GONE answer (ErrTmuxCaptureFailed)', () => errTmuxCaptureFailed(undefined, 'status'), UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
  ])('a row read that fails with %s is a cause inside the attempt: it promotes the timer to full mode, and the failed retry re-arms at the next wait', async (_what, make, kind) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    h.script({ statusError: make() })
    h.controller.armPendingOnly(key)

    await retryNow(h, key)

    expect(callCounts(h)).toEqual({ statusCalls: 1 })
    expect(h.triggers).toEqual([{ key, kind }])
    expect(retryLinesOf(h, key).slice(1)).toEqual([
      pendingOnlyRetryLine(key, 1),
      expect.stringMatching(new RegExp(`^\\[slack\\] unavailable-retry: persona=${key} promoted to full mode \\(${kind}: .* — its due time is kept$`)),
      expect.stringMatching(new RegExp(`^\\[slack\\] unavailable-retry: persona=${key} retry 1 \\(pending-only\\): the retry failed: .* — re-armed in full mode, next retry in ${waitMs(1) / 1000} s$`)),
    ])
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW, kind],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })

    // The next retry runs the full decision: connected with its stream,
    // nothing left to recover (a pending-only retry would stop on the row).
    h.script({ statusError: undefined })
    h.setConnected(key, true)
    await retryNow(h, key)
    expect(h.attempts.map((a) => a.mode)).toEqual([UNAVAILABLE_RETRY_MODE_PENDING_ONLY, UNAVAILABLE_RETRY_MODE_FULL])
    expect(h.lines).toContain(stoppedLine(key, UNAVAILABLE_RETRY_STOP_RECOVERED))
    expectStopped(h, key)
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>, string, number, boolean]>([
    ['shutdown', async (h) => h.shutdown(), UNAVAILABLE_RETRY_STOP_SHUTDOWN, 0, false],
    ['teardown', async (h, key) => h.teardown(key), UNAVAILABLE_RETRY_STOP_TORN_DOWN, 0, true],
    ['not up (its next retry)', async (h, key) => {
      h.setUp(key, false)
      await retryNow(h, key)
    }, UNAVAILABLE_RETRY_STOP_NOT_UP, 1, true],
    ['out of the applied configuration (its next retry)', async (h, key) => {
      h.remove(key)
      await retryNow(h, key)
    }, UNAVAILABLE_RETRY_STOP_NOT_APPLIED, 1, true],
    ['at the restart cap (its next retry)', async (h, key) => {
      for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(key)
      await retryNow(h, key)
    }, UNAVAILABLE_RETRY_STOP_CAPPED, 1, true],
  ])('%s still stops a pending-only timer, with no agent-director call for it; the other persona’s pending-only retries go on unless the stop is shutdown', async (_what, drive, reason, retries, otherGoesOn) => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_PENDING)
    h.controller.armPendingOnly(key)
    h.controller.armPendingOnly(other)

    await drive(h, key)
    await h.advance(waitMs(refusalsToCeiling()) * 2)

    expect(h.attempts.filter((a) => a.key === key)).toHaveLength(retries)
    expect(h.stub.calls.statusCalls.filter((params) => params.claude_instance_id === personaInstanceId(key))).toEqual([])
    expect(retryLinesOf(h, key).at(-1)).toBe(pendingOnlyStoppedLine(key, reason))
    expect(h.controller.isArmed(key)).toBe(false)

    const otherRetries = h.attempts.filter((a) => a.key === other).length
    if (!otherGoesOn) {
      expect(otherRetries).toBe(0)
      expect(h.stub.callCount()).toBe(0)
      expectStopped(h, other)
      return
    }
    // Each of the other persona's retries made its one row read, and it is
    // still armed, pending-only, with its one timer the only one pending.
    expect(otherRetries).toBeGreaterThan(0)
    expect(callCounts(h)).toEqual({ statusCalls: otherRetries })
    expect(new Set(h.stub.calls.statusCalls.map((params) => params.claude_instance_id))).toEqual(new Set([personaInstanceId(other)]))
    expect(h.controller.view(other)).toMatchObject({ phase: 'waiting', refusals: otherRetries, mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([h.controller.view(other)!.dueAt!])
  })
})

// ---------------------------------------------------------------------------
// The pending and kill-failure exceptions (b.jg5 SRJ-306): the condition-end
// entry, called directly here as the conditions' owners will call it
// ---------------------------------------------------------------------------

/** Each condition, with the reason its end stops a timer under. */
const CONDITION_ENDS: ReadonlyArray<readonly [UnavailableRetryCondition, string]> = [
  [UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED],
  [UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE, UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED],
]

/** The line the condition-end entry logs when an exception keeps the timer. */
function keptLine(key: string, ended: string, why: string): string {
  return `[slack] unavailable-retry: persona=${key} kept — ${ended}, but ${why}`
}

/** Tell the entry each condition ended; each keeps persona `key`'s timer as it was, with one kept line naming `why`. */
function expectKeptThroughEveryConditionEnd(h: RecoveryHarness, key: string, why: string): void {
  const before = h.controller.view(key)!
  for (const [condition, ended] of CONDITION_ENDS) {
    expect(h.controller.conditionEnded(key, condition)).toBe('kept')
    expect(h.lines.at(-1)).toBe(keptLine(key, ended, why))
  }
  expect(h.controller.view(key)).toEqual(before)
  expect(h.clock.pending().map((t) => t.dueAt)).toEqual([before.dueAt!])
}

describe('unavailable retry: the pending and kill-failure exceptions (SRJ-306)', () => {
  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>]>([
    ['armed pending-only directly', async (h, key) => h.controller.armPendingOnly(key)],
    ['a full-mode retry deferred on the pending row', async (h, key) => {
      h.controller.arm(key, UNAVAILABLE)
      await retryNow(h, key)
    }],
  ])('with its last row read pending (%s), the condition-end entry keeps the timer with its due time, for either condition', async (_how, arm) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_PENDING)
    await arm(h, key)
    expect(h.controller.view(key)?.lastRow).toBe(UNAVAILABLE_RETRY_ROW_PENDING)

    expectKeptThroughEveryConditionEnd(h, key, UNAVAILABLE_RETRY_KEPT_ROW_PENDING)
  })

  test('a full-mode retry that finds the row ended and relaunches leaves the timer pending-only on the launch’s pending row, kept through the end of either condition', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const row = modelRow(h, 'ended')
    h.controller.arm(key, UNAVAILABLE)

    await retryNow(h, key)

    expect(row.spawnedAt).toHaveLength(1)
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
    expectKeptThroughEveryConditionEnd(h, key, UNAVAILABLE_RETRY_KEPT_ROW_PENDING)
  })

  test.each(CONDITION_ENDS)('with the row not pending and no other cause, the end of %s stops the timer; with no timer armed the entry answers not-armed and logs nothing', async (condition, ended) => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    h.controller.arm(key, UNAVAILABLE)

    expect(h.controller.conditionEnded(key, condition)).toBe('stopped')
    expect(h.lines.at(-1)).toBe(stoppedLine(key, ended))
    expectStopped(h, key)

    const linesBefore = h.lines.length
    expect(h.controller.conditionEnded(other, condition)).toBe('not-armed')
    expect(h.controller.conditionEnded(key, condition)).toBe('not-armed')
    expect(h.lines.slice(linesBefore)).toEqual([])
    expect(h.attempts).toEqual([])
  })

  test.each<[string, (h: RecoveryHarness, key: string, row: RowModel) => Promise<void>, string]>([
    ['a retry that finds nothing left to recover', async (h, key, row) => {
      // The persona came back on its own: its row reads live and connected.
      row.set('waiting')
      h.setConnected(key, true)
      await retryNow(h, key)
    }, UNAVAILABLE_RETRY_STOP_RECOVERED],
    ['the restart cap', async (h, key) => {
      for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(key)
      await retryNow(h, key)
    }, UNAVAILABLE_RETRY_STOP_CAPPED],
    ['teardown', async (h, key) => h.teardown(key), UNAVAILABLE_RETRY_STOP_TORN_DOWN],
    ['shutdown', async (h) => h.shutdown(), UNAVAILABLE_RETRY_STOP_SHUTDOWN],
  ])('a timer armed by ErrTmuxKillFailed inside a recovery attempt (refused: no launch follows, nothing counted) is kept by the condition-end entry, and stopped by %s', async (_rule, stop, reason) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const row = modelRow(h, 'ended')
    h.script({ killError: errTmuxKillFailed() })

    // b.jg5 SRJ-105: the refused kill stops the restart work before its launch.
    expect(await runRestartRetry(key, personaOf(h, key).working_directory, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
    await h.settle()
    expect(callCounts(h)).toEqual({ statusCalls: 1, killCalls: 1 })
    expect(row.spawnedAt).toEqual([])
    expect(getFailureCount(key)).toBe(0)
    expect(h.triggers).toEqual([{ key, kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED }])
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(0),
      waitMs: waitMs(0),
      refusals: 0,
      causes: [UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
    })
    expectKeptThroughEveryConditionEnd(h, key, UNAVAILABLE_RETRY_KEPT_KILL_FAILED)

    await stop(h, key, row)

    expect(h.lines).toContain(stoppedLine(key, reason))
    expectStopped(h, key)
  })

  test('a full-mode retry whose kill fails with ErrTmuxKillFailed launches nothing and stays in full mode; a later retry whose launch succeeds stays in full mode too, its last row read pending, and the next retry runs the full decision', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const row = modelRow(h, 'ended')
    h.script({ killError: errTmuxKillFailed() })
    h.controller.arm(key, UNAVAILABLE)

    await retryNow(h, key)

    // b.jg5 SRJ-105: the refused kill stops the run before its launch, so the
    // row was read once and nothing was spawned or counted.
    expect(callCounts(h)).toEqual({ statusCalls: 1, killCalls: 1 })
    expect(row.spawnedAt).toEqual([])
    expect(getFailureCount(key)).toBe(0)
    expect(h.triggers).toEqual([{ key, kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED }])
    // A refusal gives no again-reason: the re-armed line names the cause.
    expect(retryLinesOf(h, key).at(-1)).toStartWith(`[slack] unavailable-retry: persona=${key} retry 1: ${UNAVAILABLE_RETRY_CAUSE_KILL_FAILED}`)
    expect(retryLinesOf(h, key).at(-1)).toEndWith(` — re-armed, next retry in ${waitMs(1) / 1000} s`)
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
    })

    // The next retry's kill answers and its launch succeeds: the kill-failure
    // cause recorded before keeps the timer out of pending-only mode.
    h.script({ killError: undefined })
    await retryNow(h, key)

    expect(callCounts(h)).toEqual({ statusCalls: 3, killCalls: 2, spawnCalls: 1 })
    expect(row.spawnedAt).toHaveLength(1)
    expect(h.triggers).toEqual([{ key, kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED }])
    expect(retryLinesOf(h, key).at(-1)).toBe(reArmedLine(key, 2, UNAVAILABLE_RETRY_AGAIN_LAUNCHED, 2))
    expect(h.lines.filter((line) => line.includes(' in pending-only mode'))).toEqual([])
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(2),
      waitMs: waitMs(2),
      refusals: 2,
      causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })
    expectKeptThroughEveryConditionEnd(h, key, `${UNAVAILABLE_RETRY_KEPT_ROW_PENDING} and ${UNAVAILABLE_RETRY_KEPT_KILL_FAILED}`)

    // The full decision on the launch's live row, connected with its stream:
    // one liveness read and nothing left to recover (a pending-only retry
    // would stop on the row read instead).
    h.setConnected(key, true)
    const before = callCounts(h)
    await retryNow(h, key)
    expect(h.attempts.map((a) => a.mode)).toEqual([UNAVAILABLE_RETRY_MODE_FULL, UNAVAILABLE_RETRY_MODE_FULL, UNAVAILABLE_RETRY_MODE_FULL])
    expect(callsSince(h, before)).toEqual({ statusCalls: 1 })
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_RECOVERED))
    expectStopped(h, key)
  })
})

// ---------------------------------------------------------------------------
// The `tmux-unresponsive` condition's ends and the retry timer (b.jg5 SRJ-305,
// SRJ-306, SRJ-310) on the recovery harness, both settings 0: a retry that
// finds the persona recovered on its own, a retry that does not, a launch's
// successful spawn, a plain tmux-touching success and a health tick's end,
// each reaching the condition-end entry as `main()` wires it
// ---------------------------------------------------------------------------

/**
 * A start-pass launch of persona `key` whose optimistic spawn is refused
 * UNAVAILABLE (`ErrTmuxUnresponsive`): it starts the condition and arms the
 * timer in full mode. The stub's spawn answers again afterwards. Resolves with
 * the first refusal's time.
 */
async function refuseLaunch(h: RecoveryHarness, key: string): Promise<number> {
  h.script({ spawnError: errTmuxUnresponsive('spawn') })
  const refusedAt = h.clock.now()
  expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })
  h.script({ spawnError: undefined })
  expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBe(refusedAt)
  expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE], mode: UNAVAILABLE_RETRY_MODE_FULL })
  return refusedAt
}

/** How a case starts persona `key`'s condition and arms its timer. */
type ConditionArm = (h: RecoveryHarness, key: string) => Promise<void>

/** Full mode: a launch refused UNAVAILABLE (`refuseLaunch`). */
const FULL_MODE_ARM: ConditionArm = async (h, key) => {
  await refuseLaunch(h, key)
}

/**
 * Pending-only mode: the condition started and the timer armed pending-only,
 * both directly (pending-only mode is armed directly until covered `pending`
 * rows exist, and no wired path yet leaves a pending-only timer with the
 * condition holding).
 */
const PENDING_ONLY_ARM: ConditionArm = async (h, key) => {
  expect(h.tmuxUnresponsive.start(key, 'read-pane', errTmuxUnresponsive('read-pane'))).toBe('started')
  h.controller.armPendingOnly(key)
}

/** A plain tmux-touching success for persona `key`, outside every attempt: one `read-pane` through the outage wrapper. */
function readPaneSucceeds(h: RecoveryHarness, key: string): Promise<unknown> {
  return withOutageDetection(key, personaOf(h, key).working_directory, 'read-pane', (client) =>
    client.readPane({ claude_instance_id: personaInstanceId(key), n_lines: 1 }))
}

describe('unavailable retry: the tmux-unresponsive condition’s ends and the retry timer (SRJ-305, SRJ-306, SRJ-310)', () => {
  beforeEach(() => {
    harnessEndCheck = (h) => expect(h.episodeNotices).toEqual([])
  })

  test.each<[string, ConditionArm, string, (key: string) => string]>([
    ['in full mode, whose restart decision finds it already connected (a live reading)', FULL_MODE_ARM, LIVENESS_LIVE, (key) => stoppedLine(key, UNAVAILABLE_RETRY_STOP_RECOVERED)],
    ['in pending-only mode, whose row read finds it live out of pending (waiting)', PENDING_ONLY_ARM, 'waiting', (key) => pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting')],
  ])('a retry %s, connected with its stream, ends the condition with that reading, and the timer stops', async (_what, arm, reading, stopped) => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key] = h.keys as [string]
    modelRow(h, 'waiting')
    await arm(h, key)
    h.setConnected(key, true)
    const before = callCounts(h)

    await retryNow(h, key)

    expect(callsSince(h, before)).toEqual({ statusCalls: 1 })
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(conditionLines(h, key).at(-1)).toBe(conditionEndedLine(key, TMUX_UNRESPONSIVE_END_RETRY))
    // The retry is still running when it ends the condition, so the entry
    // defers, and the retry's own stop makes the deferred end moot.
    expect(h.conditionEnds).toEqual([{ key, reading, result: 'deferred' }])
    expect(retryLinesOf(h, key).at(-1)).toBe(stopped(key))
    expect(retryLinesOf(h, key).filter((line) => line.includes(' kept — '))).toEqual([])
    expectStopped(h, key)
  })

  test.each<[string, ConditionArm, RowState, boolean, Record<string, number>, (key: string) => string, boolean]>([
    ['in full mode reads its row pending, connected with its stream (deferred on the pending row; the timer runs on)', FULL_MODE_ARM, 'pending', true, { statusCalls: 1 }, (key) => reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_PENDING_DEFERRED, 1), true],
    ['in full mode reads its row live (check_permission) but not connected (its reconnect is deferred, typing nothing; the timer runs on)', FULL_MODE_ARM, 'check_permission', false, { statusCalls: 2 }, (key) => reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_RECONNECT_DEFERRED, 1), true],
    ['in pending-only mode reads its row pending, connected with its stream (the timer runs on)', PENDING_ONLY_ARM, 'pending', true, { statusCalls: 1 }, (key) => reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_ROW_PENDING, 1, { ranPendingOnly: true }), true],
    ['in pending-only mode reads its row live (waiting) but not connected (the pending-only row rule stops the timer, not a condition end)', PENDING_ONLY_ARM, 'waiting', false, { statusCalls: 1 }, (key) => pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting'), false],
  ])('a retry that %s leaves the condition holding with its first refusal’s time and never reaches the condition-end entry', async (_what, arm, state, connected, calls, last, armed) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    modelRow(h, state)
    await arm(h, key)
    const firstRefusalAt = h.tmuxUnresponsive.firstRefusalAt(key)
    h.setConnected(key, connected)
    const before = callCounts(h)

    await retryNow(h, key)

    expect(callsSince(h, before)).toEqual(calls)
    expect(h.tmuxUnresponsive.holds(key)).toBe(true)
    expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBe(firstRefusalAt!)
    expect(h.conditionEnds).toEqual([])
    expect(conditionLines(h, key).filter((line) => line.includes(' ended — '))).toEqual([])
    expect(retryLinesOf(h, key).at(-1)).toBe(last(key))
    expect(h.controller.isArmed(key)).toBe(armed)
  })

  test('a full-mode retry whose own launch succeeds ends the condition through that spawn, with its pending row: the timer is kept and runs on in pending-only mode, the wait count carrying on', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const row = modelRow(h, 'missing')
    await refuseLaunch(h, key)

    await retryNow(h, key)

    expect(row.spawnedAt).toHaveLength(2)
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(conditionLines(h, key).at(-1)).toBe(conditionEndedLine(key, TMUX_UNRESPONSIVE_END_TMUX_VERB))
    // The spawn succeeds while the retry runs: the end is deferred, then
    // applied on the launch's pending row, before the re-arm.
    expect(h.conditionEnds).toEqual([{ key, reading: UNAVAILABLE_RETRY_ROW_PENDING, result: 'deferred' }])
    expect(retryLinesOf(h, key).slice(-2)).toEqual([
      keptLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED, UNAVAILABLE_RETRY_KEPT_ROW_PENDING),
      reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_LAUNCHED, 1, { switchedTo: UNAVAILABLE_RETRY_MODE_PENDING_ONLY }),
    ])
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })

    // The launch's row reads live and its session connects: the next
    // pending-only retry stops on the row, and with no condition holding the
    // entry is not called again.
    h.setConnected(key, true)
    await retryNow(h, key)
    expect(h.conditionEnds).toHaveLength(1)
    expect(retryLinesOf(h, key).at(-1)).toBe(pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting'))
    expectStopped(h, key)
  })

  test('a start-pass launch whose kill of a live row in another directory is refused UNAVAILABLE stops there (no delete, no spawn), answers refused, leaves the condition holding and arms the timer at the base wait, with no row read and no condition end', async () => {
    const h = (harness = makeRecoveryHarness(RETRY_TIMER_ONLY))
    const [key] = h.keys as [string]
    h.script({ ...collided(h, personaOf(h, key), { cwd: h.home }), killError: errTmuxUnresponsive('kill') })
    const armedAt = h.clock.now()

    // b.jg5 SRJ-105: the refused kill stops the ladder at once.
    expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })

    expect(callCounts(h)).toEqual({ spawnCalls: 1, getCalls: 1, killCalls: 1 })
    expect(getFailureCount(key)).toBe(0)
    expect(h.triggers).toEqual([{ key, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }])
    const lines = conditionLines(h, key)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith(`${conditionLinePrefix(key)}started — kill failed: `)
    expect(h.tmuxUnresponsive.holds(key)).toBe(true)
    expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBe(armedAt)
    expect(h.conditionEnds).toEqual([])
    expect(retryLinesOf(h, key).filter((line) => line.includes(' kept — '))).toEqual([])
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: armedAt + waitMs(0),
      waitMs: waitMs(0),
      refusals: 0,
      causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
    })
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([armedAt + waitMs(0)])
  })

  /** Persona `key`'s condition holding and its full-mode timer's row last read `pending` by a retry. */
  async function holdingOnAPendingRow(h: RecoveryHarness, key: string): Promise<NonNullable<ReturnType<UnavailableRetryController['view']>>> {
    modelRow(h, UNAVAILABLE_RETRY_ROW_PENDING)
    await refuseLaunch(h, key)
    await retryNow(h, key)
    // The retry's status read succeeded: that alone ends nothing.
    expect(h.tmuxUnresponsive.holds(key)).toBe(true)
    const view = h.controller.view(key)!
    expect(view).toMatchObject({ phase: 'waiting', refusals: 1, mode: UNAVAILABLE_RETRY_MODE_FULL, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
    return view
  }

  test('AC 30 (its tmux-unresponsive half): a condition that ends through a successful read-pane while the row was last read pending leaves the timer armed with its due time', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const before = await holdingOnAPendingRow(h, key)

    await readPaneSucceeds(h, key)

    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(conditionLines(h, key).at(-1)).toBe(conditionEndedLine(key, TMUX_UNRESPONSIVE_END_TMUX_VERB))
    expect(h.conditionEnds).toEqual([{ key, reading: undefined, result: 'kept' }])
    expect(retryLinesOf(h, key).at(-1)).toBe(keptLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED, UNAVAILABLE_RETRY_KEPT_ROW_PENDING))
    expect(h.controller.view(key)).toEqual(before)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([before.dueAt!])
  })

  test('an end that brings a health tick’s live reading stops the timer even though a retry last read the row pending: the tick’s reading is the latest row read', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    await holdingOnAPendingRow(h, key)

    expect(h.tickEnd(key)).toBe('ended')

    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(conditionLines(h, key).at(-1)).toBe(conditionEndedLine(key, TMUX_UNRESPONSIVE_END_TICK))
    expect(h.conditionEnds).toEqual([{ key, reading: LIVENESS_LIVE, result: 'stopped' }])
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED))
    expectStopped(h, key)
  })

  /** Swap in a held action and fire persona `key`'s due retry: the run is in flight, waiting for the test's answer. */
  async function holdNextRun(h: RecoveryHarness, key: string): Promise<ReturnType<typeof heldAction>> {
    const held = heldAction()
    h.setAction(held.action)
    await h.advance(h.controller.view(key)!.dueAt! - h.clock.now())
    expect(h.controller.view(key)?.phase).toBe('running')
    return held
  }

  test('a health tick’s end during a full-mode retry whose launch then succeeds is deferred with its live reading; the launch’s pending row is the later read, so the timer is kept and runs on in pending-only mode', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const row = modelRow(h, 'missing')
    await refuseLaunch(h, key)
    // The retry fires while the persona's serializer turn is held: the
    // full-mode retry is blocked mid-run.
    const gate = Promise.withResolvers<void>()
    const turn = h.serializer.run(key, () => gate.promise)
    await h.advance(waitMs(0))
    expect(h.controller.view(key)?.phase).toBe('running')

    expect(h.tickEnd(key)).toBe('ended')
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(h.conditionEnds).toEqual([{ key, reading: LIVENESS_LIVE, result: 'deferred' }])

    gate.resolve()
    await turn
    await h.settle()

    // The retry's launch spawns; the condition no longer holds, so its spawn
    // reaches the condition-end entry no more.
    expect(row.spawnedAt).toHaveLength(2)
    expect(h.conditionEnds).toHaveLength(1)
    expect(retryLinesOf(h, key).filter((line) => line.includes(' kept — '))).toHaveLength(1)
    expect(retryLinesOf(h, key).slice(-2)).toEqual([
      keptLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED, UNAVAILABLE_RETRY_KEPT_ROW_PENDING),
      reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_LAUNCHED, 1, { switchedTo: UNAVAILABLE_RETRY_MODE_PENDING_ONLY }),
    ])
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })
  })

  test.each<[string, (held: ReturnType<typeof heldAction>) => void]>([
    ['fails', (held) => held.fail(new Error('the retry broke'))],
    ['answers a liveness reading of unknown (it keeps the last row read)', (held) => held.answer({ kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_LIVENESS_UNKNOWN, keepsLastRow: true })],
  ])('a health tick’s end deferred during a retry that %s, after a retry read the row pending: the answer carries no row, so the live reading is the latest row read and the timer stops', async (_what, finish) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    await holdingOnAPendingRow(h, key)
    const held = await holdNextRun(h, key)

    expect(h.tickEnd(key)).toBe('ended')
    expect(h.conditionEnds).toEqual([{ key, reading: LIVENESS_LIVE, result: 'deferred' }])
    finish(held)
    await h.controller.whenRunSettled(key)

    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED))
    expect(retryLinesOf(h, key).filter((line) => line.includes(' kept — '))).toEqual([])
    expectStopped(h, key)
  })

  test('a launch’s successful spawn during a retry ends the condition with its pending reading, deferred; it wins over the live row the retry’s answer carries, so the timer is kept', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    await refuseLaunch(h, key)
    const held = await holdNextRun(h, key)

    expect(await h.launch(key)).toEqual({ key, action: 'spawned' })
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(conditionLines(h, key).at(-1)).toBe(conditionEndedLine(key, TMUX_UNRESPONSIVE_END_TMUX_VERB))
    expect(h.conditionEnds).toEqual([{ key, reading: UNAVAILABLE_RETRY_ROW_PENDING, result: 'deferred' }])

    held.answer({ kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_RECONNECT_DEFERRED, row: 'check_permission' })
    await h.controller.whenRunSettled(key)

    expect(retryLinesOf(h, key).slice(-2)).toEqual([
      keptLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED, UNAVAILABLE_RETRY_KEPT_ROW_PENDING),
      reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_RECONNECT_DEFERRED, 1),
    ])
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', refusals: 1, mode: UNAVAILABLE_RETRY_MODE_FULL, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<unknown>, TmuxUnresponsiveEndReason, string | undefined]>([
    ['a successful read-pane (no reading)', readPaneSucceeds, TMUX_UNRESPONSIVE_END_TMUX_VERB, undefined],
    ['a health tick’s live reading', async (h, key) => h.tickEnd(key), TMUX_UNRESPONSIVE_END_TICK, LIVENESS_LIVE],
  ])('a condition that ends after a kill-failure cause, through %s, leaves the timer armed with its due time', async (_what, end, reason, reading) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const row = modelRow(h, 'ended')
    // A recovery attempt whose kill fails with ErrTmuxKillFailed: the
    // kill-failure cause, with no launch after it (b.jg5 SRJ-105).
    h.script({ killError: errTmuxKillFailed() })
    expect(await runRestartRetry(key, personaOf(h, key).working_directory, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
    await h.settle()
    expect(row.spawnedAt).toEqual([])
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    // Its retry's kill answers and its launch is refused UNAVAILABLE: the
    // condition's start, with the kill-failure cause still recorded.
    h.script({ killError: undefined, spawnError: errTmuxUnresponsive('spawn') })
    await retryNow(h, key)
    h.script({ spawnError: undefined })
    expect(row.spawnedAt).toHaveLength(1)
    expect(h.triggers).toEqual([{ key, kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED }, { key, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }])
    expect(h.tmuxUnresponsive.holds(key)).toBe(true)
    const before = h.controller.view(key)!
    expect(before).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_KILL_FAILED, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
    })

    await end(h, key)

    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(conditionLines(h, key).at(-1)).toBe(conditionEndedLine(key, reason))
    expect(h.conditionEnds).toEqual([{ key, reading, result: 'kept' }])
    expect(retryLinesOf(h, key).at(-1)).toBe(keptLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED, UNAVAILABLE_RETRY_KEPT_KILL_FAILED))
    // The end's reading, when it brings one, becomes the last row read; the
    // kill-failure cause keeps the timer whatever it reads.
    expect(h.controller.view(key)).toEqual({ ...before, ...(reading !== undefined ? { lastRow: reading } : {}) })
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([before.dueAt!])
  })

  test('with both settings 0, a retry whose reconnect read-pane succeeds (the end is deferred) and whose send-keys is then refused UNAVAILABLE leaves the condition holding and the timer re-armed at the next wait; the next retry fires at that due time', async () => {
    const h = (harness = makeRecoveryHarness(RETRY_TIMER_ONLY))
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key] = h.keys as [string]
    modelRow(h, 'waiting')
    const firstRefusalAt = await refuseLaunch(h, key)
    h.setConnected(key, false)
    h.script({ sendKeysError: errTmuxUnresponsive('send-keys') })
    const before = callCounts(h)

    await retryNow(h, key)

    // The reconnect's read-pane ends the condition while the retry runs (the
    // end is deferred); its send-keys is refused and starts it again, arming
    // the timer in the same run, which cancels the deferred end.
    expect(callsSince(h, before)).toEqual({ statusCalls: 2, readPaneCalls: 1, sendKeysCalls: 1 })
    expect(h.conditionEnds).toEqual([{ key, reading: undefined, result: 'deferred' }])
    expect(h.triggers).toEqual([{ key, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }, { key, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }])
    const lines = conditionLines(h, key)
    expect(lines.at(-2)).toBe(conditionEndedLine(key, TMUX_UNRESPONSIVE_END_TMUX_VERB))
    expect(lines.at(-1)).toStartWith(`${conditionLinePrefix(key)}started — `)
    expect(h.tmuxUnresponsive.holds(key)).toBe(true)
    expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBe(firstRefusalAt + waitMs(0))
    expect(retryLinesOf(h, key).filter((line) => line.includes(UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED))).toEqual([])
    expect(retryLinesOf(h, key).at(-1)).toEndWith(` — re-armed, next retry in ${waitMs(1) / 1000} s`)
    const view = h.controller.view(key)!
    expect(view).toMatchObject({ phase: 'waiting', dueAt: h.clock.now() + waitMs(1), waitMs: waitMs(1), refusals: 1, mode: UNAVAILABLE_RETRY_MODE_FULL })
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([view.dueAt!])

    // The re-armed timer really fires: the send-keys answers now, the
    // reconnect succeeds and the retry stops the timer.
    h.script({ sendKeysError: undefined })
    const beforeSecond = callCounts(h)
    await h.advance(waitMs(1) - 1)
    expect(callsSince(h, beforeSecond)).toEqual({})
    await retryNow(h, key)
    expect(callsSince(h, beforeSecond)).toEqual({ statusCalls: 2, readPaneCalls: 1, sendKeysCalls: 1 })
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_RECOVERED))
    expectStopped(h, key)
  })
})

// ---------------------------------------------------------------------------
// The switch to pending-only mode, the last row read and a condition that
// ends during a run (b.jg5 SRJ-301, SRJ-305, SRJ-306), on the bare controller
// with a held stand-in action
// ---------------------------------------------------------------------------

/** What the retry action answers for a full-mode retry whose launch succeeded. */
const LAUNCHED_ANSWER: UnavailableRetryOutcome = {
  kind: 'again',
  reason: UNAVAILABLE_RETRY_AGAIN_LAUNCHED,
  row: UNAVAILABLE_RETRY_ROW_PENDING,
  switchToPendingOnly: true,
}

/** A bare rig over a held action whose first retry, armed by `arm`, is running now. */
async function heldRun(arm: (controller: UnavailableRetryController) => void): Promise<Rig & { held: ReturnType<typeof heldAction> }> {
  const held = heldAction()
  const rig = makeRig(held.action)
  arm(rig.controller)
  await rig.clock.advance(waitMs(0))
  expect(rig.controller.view(KEY)?.phase).toBe('running')
  return { ...rig, held }
}

const armUnavailable = (controller: UnavailableRetryController): void => {
  controller.arm(KEY, UNAVAILABLE)
}

describe('unavailable retry: the switch, the last row read and a condition end during a run (SRJ-301, SRJ-306)', () => {
  test.each<[string, (c: UnavailableRetryController) => void, (c: UnavailableRetryController) => void, UnavailableRetryMode, string[]]>([
    ['no other cause: the switch is taken', armUnavailable, () => {}, UNAVAILABLE_RETRY_MODE_PENDING_ONLY, [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE]],
    ['unavailable armed during the run: another cause, so it stays in full mode', armUnavailable, armUnavailable, UNAVAILABLE_RETRY_MODE_FULL, [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE]],
    ['a kill-failed cause recorded before the run: it stays in full mode', (c) => c.arm(KEY, { kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED }), () => {}, UNAVAILABLE_RETRY_MODE_FULL, [UNAVAILABLE_RETRY_CAUSE_KILL_FAILED]],
  ])('a launched answer with %s; the last row read is pending either way, and the next retry runs in that mode', async (_what, arm, during, mode, causes) => {
    const { clock, controller, lines, attempts, held } = await heldRun(arm)
    during(controller)

    held.answer(LAUNCHED_ANSWER)
    await controller.whenRunSettled(KEY)

    const switchedTo = mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY ? mode : undefined
    expect(lines.at(-1)).toBe(reArmedLine(KEY, 1, UNAVAILABLE_RETRY_AGAIN_LAUNCHED, 1, { switchedTo }))
    expect(lines.filter((line) => line.includes('promoted'))).toEqual([])
    expect(controller.view(KEY)).toEqual({
      phase: 'waiting',
      dueAt: clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes,
      mode,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })

    await clock.advance(waitMs(1))
    expect(attempts.map((a) => a.mode)).toEqual([UNAVAILABLE_RETRY_MODE_FULL, mode])
    held.answer({ kind: 'stop', reason: 'the test is over' })
    await controller.whenRunSettled(KEY)
  })

  test.each<[string, boolean, UnavailableRetryOutcome, string | undefined]>([
    ['during the run, then an again with no row: the row stays pending, and a condition end keeps the timer', true, { kind: 'again' }, UNAVAILABLE_RETRY_ROW_PENDING],
    ['during the run, then an again with its own row: the answer’s row wins, and a condition end stops the timer', true, { kind: 'again', row: 'waiting' }, 'waiting'],
    ['before the run, then an again with no row: the again clears it, and a condition end stops the timer', false, { kind: 'again' }, undefined],
    ['before the run, then an again with no row that keeps the last row read (a liveness reading of unknown): the row stays pending, and a condition end keeps the timer', false, { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_LIVENESS_UNKNOWN, keepsLastRow: true }, UNAVAILABLE_RETRY_ROW_PENDING],
  ])('armPendingOnly on a full-mode timer %s', async (_what, duringRun, answer, lastRow) => {
    const { controller, lines, held } = await heldRun((c) => {
      c.arm(KEY, UNAVAILABLE)
      if (!duringRun) c.armPendingOnly(KEY)
    })
    if (duringRun) controller.armPendingOnly(KEY)
    expect(controller.view(KEY)?.lastRow).toBe(UNAVAILABLE_RETRY_ROW_PENDING)

    held.answer(answer)
    await controller.whenRunSettled(KEY)

    const view = controller.view(KEY)!
    expect(view).toMatchObject({ phase: 'waiting', refusals: 1, causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, UNAVAILABLE_RETRY_CAUSE_PENDING_ROW], mode: UNAVAILABLE_RETRY_MODE_FULL })
    expect(view.lastRow).toBe(lastRow)

    const [condition, ended] = CONDITION_ENDS[0]!
    if (lastRow === UNAVAILABLE_RETRY_ROW_PENDING) {
      expect(controller.conditionEnded(KEY, condition)).toBe('kept')
      expect(lines.at(-1)).toBe(keptLine(KEY, ended, UNAVAILABLE_RETRY_KEPT_ROW_PENDING))
      expect(controller.view(KEY)).toEqual(view)
    } else {
      expect(controller.conditionEnded(KEY, condition)).toBe('stopped')
      expect(lines.at(-1)).toBe(stoppedLine(KEY, ended))
      expect(controller.isArmed(KEY)).toBe(false)
    }
  })

  test.each(CONDITION_ENDS)('the end of %s during a run answering launched is deferred with no line, then kept after the answer: one kept line, then the re-armed line in pending-only mode', async (condition, ended) => {
    const { clock, controller, lines, held } = await heldRun(armUnavailable)
    const linesBefore = lines.length

    expect(controller.conditionEnded(KEY, condition)).toBe('deferred')
    expect(lines.slice(linesBefore)).toEqual([])
    expect(controller.view(KEY)?.phase).toBe('running')

    held.answer(LAUNCHED_ANSWER)
    await controller.whenRunSettled(KEY)

    expect(lines.slice(linesBefore)).toEqual([
      keptLine(KEY, ended, UNAVAILABLE_RETRY_KEPT_ROW_PENDING),
      reArmedLine(KEY, 1, UNAVAILABLE_RETRY_AGAIN_LAUNCHED, 1, { switchedTo: UNAVAILABLE_RETRY_MODE_PENDING_ONLY }),
    ])
    expect(controller.view(KEY)).toEqual({
      phase: 'waiting',
      dueAt: clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })
    expect(clock.pending().map((t) => t.dueAt)).toEqual([clock.now() + waitMs(1)])
  })

  test.each<[UnavailableRetryCondition, string, UnavailableRetryOutcome]>([
    [CONDITION_ENDS[0]![0], CONDITION_ENDS[0]![1], { kind: 'again' }],
    [CONDITION_ENDS[1]![0], CONDITION_ENDS[1]![1], { kind: 'again', row: 'waiting' }],
  ])('the end of %s during a run answering %o, with no pending row and no kill-failed cause, stops the timer after the run with the condition’s reason and nothing pending', async (condition, ended, answer) => {
    const { clock, controller, lines, held } = await heldRun(armUnavailable)
    const linesBefore = lines.length

    expect(controller.conditionEnded(KEY, condition)).toBe('deferred')
    held.answer(answer)
    await controller.whenRunSettled(KEY)

    expect(lines.slice(linesBefore)).toEqual([stoppedLine(KEY, ended)])
    expect(controller.isArmed(KEY)).toBe(false)
    expect(clock.pendingCount()).toBe(0)
  })

  test.each<[string, (c: UnavailableRetryController) => void, (held: ReturnType<typeof heldAction>) => void, string, boolean]>([
    ['its row last read pending (armed pending-only), and the run fails', (c) => c.armPendingOnly(KEY), (held) => held.fail(new Error('the retry broke')), UNAVAILABLE_RETRY_KEPT_ROW_PENDING, true],
    ['a kill-failed cause recorded, and the run answers again', (c) => c.arm(KEY, { kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED }), (held) => held.answer({ kind: 'again' }), UNAVAILABLE_RETRY_KEPT_KILL_FAILED, false],
  ])('a condition end deferred during a run is kept after it with %s: one kept line, then the re-armed line', async (_what, arm, finish, why, ranPendingOnly) => {
    const { clock, controller, lines, held } = await heldRun(arm)
    const linesBefore = lines.length
    const [condition, ended] = CONDITION_ENDS[1]!

    expect(controller.conditionEnded(KEY, condition)).toBe('deferred')
    finish(held)
    await controller.whenRunSettled(KEY)

    const ran = ranPendingOnly ? ` (${UNAVAILABLE_RETRY_MODE_PENDING_ONLY})` : ''
    expect(lines.slice(linesBefore)).toEqual([
      keptLine(KEY, ended, why),
      expect.stringMatching(new RegExp(`^\\[slack\\] unavailable-retry: persona=${KEY} retry 1${ran.replace(/[()]/g, '\\$&')}: .* — re-armed, next retry in ${waitMs(1) / 1000} s$`)),
    ])
    expect(controller.view(KEY)).toMatchObject({ phase: 'waiting', dueAt: clock.now() + waitMs(1), refusals: 1 })
  })

  test.each<[string, (c: UnavailableRetryController, held: ReturnType<typeof heldAction>) => void, string]>([
    ['a stop answer', (_c, held) => held.answer({ kind: 'stop', reason: 'the persona recovered' }), 'the persona recovered'],
    ['a stop during the run (its again answer dropped)', (c, held) => {
      c.stop(KEY, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
      held.answer({ kind: 'again' })
    }, UNAVAILABLE_RETRY_STOP_TORN_DOWN],
  ])('a condition end deferred during a run is moot after %s: only that stopped line', async (_what, finish, reason) => {
    const { clock, controller, lines, held } = await heldRun(armUnavailable)
    const linesBefore = lines.length

    expect(controller.conditionEnded(KEY, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE)).toBe('deferred')
    finish(controller, held)
    await controller.whenRunSettled(KEY)

    expect(lines.slice(linesBefore)).toEqual([stoppedLine(KEY, reason)])
    expect(controller.isArmed(KEY)).toBe(false)
    expect(clock.pendingCount()).toBe(0)
  })

  test('two condition ends during one run answering launched: the latest condition, kept once; the next run applies none', async () => {
    const { clock, controller, lines, held } = await heldRun(armUnavailable)
    const linesBefore = lines.length

    expect(controller.conditionEnded(KEY, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE)).toBe('deferred')
    expect(controller.conditionEnded(KEY, UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE)).toBe('deferred')
    held.answer(LAUNCHED_ANSWER)
    await controller.whenRunSettled(KEY)

    expect(lines.slice(linesBefore)).toEqual([
      keptLine(KEY, UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED, UNAVAILABLE_RETRY_KEPT_ROW_PENDING),
      reArmedLine(KEY, 1, UNAVAILABLE_RETRY_AGAIN_LAUNCHED, 1, { switchedTo: UNAVAILABLE_RETRY_MODE_PENDING_ONLY }),
    ])

    // The recorded end was applied once and cleared: a later run whose row is
    // out of pending re-arms with no kept or stopped line.
    await clock.advance(waitMs(1))
    const nextBefore = lines.length
    held.answer({ kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_ROW_PENDING, row: 'waiting' })
    await controller.whenRunSettled(KEY)
    expect(lines.slice(nextBefore)).toEqual([reArmedLine(KEY, 2, UNAVAILABLE_RETRY_AGAIN_ROW_PENDING, 2, { ranPendingOnly: true })])
    expect(controller.view(KEY)).toMatchObject({ phase: 'waiting', refusals: 2, lastRow: 'waiting' })
  })

  test('two condition ends during one run answering again with no row: the latest condition’s reason, stopped once', async () => {
    const { clock, controller, lines, held } = await heldRun(armUnavailable)
    const linesBefore = lines.length

    expect(controller.conditionEnded(KEY, UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE)).toBe('deferred')
    expect(controller.conditionEnded(KEY, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE)).toBe('deferred')
    held.answer({ kind: 'again' })
    await controller.whenRunSettled(KEY)

    expect(lines.slice(linesBefore)).toEqual([stoppedLine(KEY, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED)])
    expect(controller.isArmed(KEY)).toBe(false)
    expect(clock.pendingCount()).toBe(0)
  })

  /** Each arm that can land during a full-mode run, with the cause the re-armed line then names. */
  const ARMS_IN_RUN: ReadonlyArray<readonly [string, (c: UnavailableRetryController) => void, string]> = [
    ['arm', armUnavailable, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['armPendingOnly', (c) => { c.armPendingOnly(KEY) }, UNAVAILABLE_RETRY_CAUSE_PENDING_ROW],
  ]

  test.each(ARMS_IN_RUN)('the tmux-unresponsive condition’s end deferred during a full-mode run, then %s in the same run (a refusal that started the condition again): the arm cancels the end, so no kept or stopped line, and the timer is re-armed at the doubled wait', async (_what, armAgain, cause) => {
    const { clock, controller, lines, held } = await heldRun(armUnavailable)
    const linesBefore = lines.length

    expect(controller.conditionEnded(KEY, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE)).toBe('deferred')
    armAgain(controller)
    held.answer({ kind: 'again' })
    await controller.whenRunSettled(KEY)

    expect(lines.slice(linesBefore)).toEqual([reArmedLine(KEY, 1, cause, 1)])
    expect(lines.filter((line) => line.includes(UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED))).toEqual([])
    expect(controller.view(KEY)).toMatchObject({ phase: 'waiting', dueAt: clock.now() + waitMs(1), waitMs: waitMs(1), refusals: 1, mode: UNAVAILABLE_RETRY_MODE_FULL })
    expect(delays(clock)).toEqual([waitMs(1)])
  })

  test('an end deferred with a live reading, then arm, then an end with no reading, in one run on a row last read pending: the arm drops the first end’s reading too, so the second end keeps the timer on the pending row', async () => {
    const { clock, controller, lines, held } = await heldRun((c) => {
      c.arm(KEY, UNAVAILABLE)
      c.armPendingOnly(KEY)
    })
    const linesBefore = lines.length

    expect(controller.conditionEnded(KEY, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE, LIVENESS_LIVE)).toBe('deferred')
    controller.arm(KEY, UNAVAILABLE)
    expect(controller.conditionEnded(KEY, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE)).toBe('deferred')
    held.answer({ kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_LIVENESS_UNKNOWN, keepsLastRow: true })
    await controller.whenRunSettled(KEY)

    expect(lines.slice(linesBefore)).toEqual([
      keptLine(KEY, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED, UNAVAILABLE_RETRY_KEPT_ROW_PENDING),
      reArmedLine(KEY, 1, UNAVAILABLE_RETRY_AGAIN_LIVENESS_UNKNOWN, 1),
    ])
    expect(controller.view(KEY)).toMatchObject({ phase: 'waiting', refusals: 1, mode: UNAVAILABLE_RETRY_MODE_FULL, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
    expect(delays(clock)).toEqual([waitMs(1)])
  })

  // The mirror: an end that lands after the arm in the same run is still
  // applied. The pending-only-override and kill-failed orders of the same
  // mirror are the hand-off describe's cases below.
  test.each<[string, (c: UnavailableRetryController) => void, (key: string) => string[]]>([
    ['arm, no row read pending: the end stops the timer', armUnavailable, (key) => [stoppedLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED)]],
    ['armPendingOnly, the row last read pending: the end keeps the timer', (c) => { c.armPendingOnly(KEY) }, (key) => [
      keptLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED, UNAVAILABLE_RETRY_KEPT_ROW_PENDING),
      reArmedLine(key, 1, UNAVAILABLE_RETRY_CAUSE_PENDING_ROW, 1),
    ]],
  ])('%s in a full-mode run, then the tmux-unresponsive condition’s end in the same run: the end is still applied after the run', async (_what, armAgain, expected) => {
    const { clock, controller, lines, held } = await heldRun(armUnavailable)
    const linesBefore = lines.length

    armAgain(controller)
    expect(controller.conditionEnded(KEY, UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE)).toBe('deferred')
    held.answer({ kind: 'again' })
    await controller.whenRunSettled(KEY)

    const want = expected(KEY)
    expect(lines.slice(linesBefore)).toEqual(want)
    expect(controller.isArmed(KEY)).toBe(want.length > 1)
    expect(clock.pendingCount()).toBe(want.length > 1 ? 1 : 0)
  })
})

// ---------------------------------------------------------------------------
// A stop's hand-off, and a pending-only stop that yields to a full-mode cause
// armed during its retry (b.jg5 SRJ-301, SRJ-303, SRJ-305, SRJ-306), on the
// bare controller over the server's retry action on stand-in deps
// ---------------------------------------------------------------------------

/** The line a pending-only timer logs when a full-mode cause of kind `kind` (with no error) promotes it. */
function promotedLine(key: string, kind: string): string {
  return `[slack] unavailable-retry: persona=${key} promoted to full mode (${kind}) — its due time is kept`
}

/**
 * A bare rig over the server's retry action on stand-in deps (`fullModeDeps`),
 * armed pending-only. `during` runs inside the retry, as its row read starts;
 * the read then answers `row`. `onRetryEntry` runs at each retry entry call
 * (a hand-off, or a full-mode retry's decision).
 */
function pendingOnlyReadRig(
  row: string,
  during: (rig: Rig) => void,
  onRetryEntry: (rig: Rig) => void = () => {},
): Rig & { deps: StandInDeps } {
  const base = fullModeDeps(RESTART_OUTCOME_LAUNCHED, {}, row)
  const deps: StandInDeps = {
    ...base,
    readRow: async (key) => {
      during(rig)
      return base.readRow(key)
    },
    retry: async (key, cwd, isInFlight) => {
      onRetryEntry(rig)
      return base.retry(key, cwd, isInFlight)
    },
  }
  const rig = makeRig(createFullModeRetryAction(deps))
  rig.controller.armPendingOnly(KEY)
  return { ...rig, deps }
}

describe('unavailable retry: a stop’s hand-off, and a pending-only stop that yields to a full-mode cause (SRJ-301, SRJ-303, SRJ-305, SRJ-306)', () => {
  test.each<[string, (err: Error) => () => Promise<unknown>]>([
    ['throws', (err) => () => { throw err }],
    ['rejects', (err) => async () => { throw err }],
  ])('a hand-off that %s is logged once, redacted, after the stopped line; the run settles with nothing pending and the next arm starts at the first wait', async (_how, make) => {
    const err = Object.assign(new Error(`the hand-off failed (${sentinelInMessage('hand-off')})`), { detail: LEAK_SENTINEL })
    const { clock, controller, lines } = makeRig(() => ({ kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_GONE, handOff: make(err) }))
    controller.arm(KEY, UNAVAILABLE)
    const linesBefore = lines.length

    await clock.advance(waitMs(0))
    await controller.whenRunSettled(KEY)

    const after = lines.slice(linesBefore + 1)
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(stoppedLine(KEY, UNAVAILABLE_RETRY_STOP_ROW_GONE))
    expect(after[1]).toStartWith(`[slack] unavailable-retry: persona=${KEY} hand-off after the stop failed: Error message="the hand-off failed (${REDACTED_SENTINEL_TAIL})"`)
    expect(clock.pendingCount()).toBe(0)
    expect(controller.isArmed(KEY)).toBe(false)
    assertNoLeak(lines)

    controller.arm(KEY, UNAVAILABLE)
    expect(delays(clock)).toEqual([waitMs(0)])
  })

  test.each<[string, string]>([
    ['live out of pending', 'waiting'],
    ['gone', 'ended'],
    ['gone (no row)', UNAVAILABLE_RETRY_ROW_ABSENT],
  ])('a pending-only retry that reads its row %s (%s) while a full-mode cause lands is not stopped: re-armed in full mode naming that cause, its last row read the stop’s row, nothing handed off, and the next retry runs the full decision', async (_what, row) => {
    const { clock, controller, lines, attempts, deps } = pendingOnlyReadRig(row, ({ controller: c }) => {
      c.arm(KEY, UNAVAILABLE)
    })

    await clock.advance(waitMs(0))
    await controller.whenRunSettled(KEY)

    expect(lines).toEqual([
      pendingOnlyArmedLine(KEY),
      pendingOnlyRetryLine(KEY, 1),
      promotedLine(KEY, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE),
      reArmedLine(KEY, 1, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, 1, { ranPendingOnly: true, switchedTo: UNAVAILABLE_RETRY_MODE_FULL }),
    ])
    expect(controller.view(KEY)).toEqual({
      phase: 'waiting',
      dueAt: clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
      lastRow: row,
    })
    expect(deps.calls).toEqual([])

    // The next retry runs the full decision: one retry entry call, no row read.
    await clock.advance(waitMs(1))
    await controller.whenRunSettled(KEY)
    expect(attempts.map((a) => a.mode)).toEqual([UNAVAILABLE_RETRY_MODE_PENDING_ONLY, UNAVAILABLE_RETRY_MODE_FULL])
    expect(deps.reads).toEqual([[KEY, true]])
    expect(deps.calls).toEqual([[KEY, `/work/${KEY}`]])
  })

  test('with a condition end deferred to that retry, the overridden stop counts as again: the rule stops the timer, and then the held hand-off runs once', async () => {
    const [condition, ended] = CONDITION_ENDS[0]!
    const deferred: string[] = []
    const atHandOff: Array<readonly [boolean, string | undefined]> = []
    const { clock, controller, lines, deps } = pendingOnlyReadRig('ended', ({ controller: c }) => {
      c.arm(KEY, UNAVAILABLE)
      deferred.push(c.conditionEnded(KEY, condition))
    }, ({ controller: c, lines: l }) => {
      atHandOff.push([c.isArmed(KEY), l.at(-1)])
    })

    await clock.advance(waitMs(0))
    await controller.whenRunSettled(KEY)

    expect(deferred).toEqual(['deferred'])
    expect(lines.slice(2)).toEqual([promotedLine(KEY, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE), stoppedLine(KEY, ended)])
    expect(atHandOff).toEqual([[false, stoppedLine(KEY, ended)]])
    expect(deps.calls).toEqual([[KEY, `/work/${KEY}`]])
    expect(controller.isArmed(KEY)).toBe(false)
    expect(clock.pendingCount()).toBe(0)
  })

  test('with a condition end deferred to that retry and a kill-failed cause landing in it, the timer is kept and re-armed in full mode, and nothing is handed off', async () => {
    const [condition, ended] = CONDITION_ENDS[1]!
    const { clock, controller, lines, deps } = pendingOnlyReadRig('ended', ({ controller: c }) => {
      c.arm(KEY, { kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED })
      c.conditionEnded(KEY, condition)
    })

    await clock.advance(waitMs(0))
    await controller.whenRunSettled(KEY)

    expect(lines.slice(2)).toEqual([
      promotedLine(KEY, UNAVAILABLE_RETRY_CAUSE_KILL_FAILED),
      keptLine(KEY, ended, UNAVAILABLE_RETRY_KEPT_KILL_FAILED),
      reArmedLine(KEY, 1, UNAVAILABLE_RETRY_CAUSE_KILL_FAILED, 1, { ranPendingOnly: true, switchedTo: UNAVAILABLE_RETRY_MODE_FULL }),
    ])
    expect(controller.view(KEY)).toEqual({
      phase: 'waiting',
      dueAt: clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW, UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
      lastRow: 'ended',
    })
    expect(deps.calls).toEqual([])
  })

  test.each(GATES)('an early stop (%s) is taken even with a full-mode cause armed during the pending-only retry', async (_what, overrides, reason) => {
    const deps = fullModeDeps(RESTART_OUTCOME_LAUNCHED, overrides, UNAVAILABLE_RETRY_ROW_PENDING)
    const action = createFullModeRetryAction(deps)
    const rig: Rig = makeRig((key, attempt) => {
      rig.controller.arm(KEY, UNAVAILABLE)
      return action(key, attempt)
    })
    rig.controller.armPendingOnly(KEY)

    await rig.clock.advance(waitMs(0))
    await rig.controller.whenRunSettled(KEY)

    expect(rig.lines.slice(2)).toEqual([promotedLine(KEY, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE), stoppedLine(KEY, reason)])
    expect(rig.controller.isArmed(KEY)).toBe(false)
    expect(rig.clock.pendingCount()).toBe(0)
    expect(deps.reads).toEqual([])
    expect(deps.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The retry observer (`onRetryFire`, b.jg5 SRJ-308), on the bare controller
// over a scripted or held action, and, for the in-flight skip, over the
// server's retry action on stand-in deps
// ---------------------------------------------------------------------------

/** One call an observed rig saw: the observer's (`fire`) or the action's, with the key, the time given or read, and the last line logged before it. */
type ObservedStep = readonly ['fire' | 'action', string, number, string | undefined]

/**
 * A bare rig whose observer and action each record their calls in one ordered
 * list. The observer throws `observerThrows` after recording, when given.
 */
function observedRig(action: UnavailableRetryAction = () => ({ kind: 'again' }), observerThrows?: Error): Rig & { steps: ObservedStep[] } {
  const steps: ObservedStep[] = []
  const rig: Rig = makeRig((key, attempt) => {
    steps.push(['action', key, rig.clock.now(), rig.lines.at(-1)])
    return action(key, attempt)
  }, undefined, (key, firedAt) => {
    steps.push(['fire', key, firedAt, rig.lines.at(-1)])
    if (observerThrows !== undefined) throw observerThrows
  })
  return { ...rig, steps }
}

/** The line a full-mode retry logs as it starts. */
function fullRetryLine(key: string, retry: number): string {
  return `[slack] unavailable-retry: persona=${key} retry ${retry} — rerunning its recovery`
}

/** The observer's then the action's step for one retry of `key` at `at`, after `retryLine`. */
function observedRetry(key: string, at: number, retryLine: string): ObservedStep[] {
  return [['fire', key, at, retryLine], ['action', key, at, retryLine]]
}

/** An action that answers `outcomes` in turn, then refuses. */
function scriptedAction(...outcomes: UnavailableRetryOutcome[]): UnavailableRetryAction {
  let next = 0
  return () => outcomes[next++] ?? { kind: 'again' }
}

/** A timer's run through its retries: how it is armed, a fresh action for each rig, and how many retries it runs. */
interface ObserverScenario {
  readonly arm: (controller: UnavailableRetryController) => void
  readonly action: () => UnavailableRetryAction
  readonly retries: number
}

const OBSERVER_SCENARIOS: ReadonlyArray<readonly [string, ObserverScenario]> = [
  ['full mode, refused at every retry', {
    arm: (c) => { c.arm(KEY, UNAVAILABLE) },
    action: () => scriptedAction(),
    retries: 3,
  }],
  ['full mode, an action that throws at every retry', {
    arm: (c) => { c.arm(KEY, UNAVAILABLE) },
    action: () => () => { throw new Error('the retry refused') },
    retries: 3,
  }],
  ['full mode, a launch that switches to pending-only, then a live row that stops it', {
    arm: (c) => { c.arm(KEY, UNAVAILABLE) },
    action: () => scriptedAction(
      { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_LAUNCHED, row: UNAVAILABLE_RETRY_ROW_PENDING, switchToPendingOnly: true },
      { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_LIVE, row: 'waiting', yieldsToFullMode: true },
    ),
    retries: 2,
  }],
  ['pending-only, a pending row, then a gone row whose stop hands off', {
    arm: (c) => { c.armPendingOnly(KEY) },
    action: () => scriptedAction(
      { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_ROW_PENDING, row: UNAVAILABLE_RETRY_ROW_PENDING },
      { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_GONE, row: 'ended', handOff: async () => undefined },
    ),
    retries: 2,
  }],
]

/** Arm `rig` as `scenario` does and run its retries, each to its settled re-arm or stop. */
async function runScenario(rig: Rig, scenario: ObserverScenario): Promise<void> {
  scenario.arm(rig.controller)
  for (let i = 0; i < scenario.retries; i++) {
    await rig.clock.runNext()
    await rig.controller.whenRunSettled(KEY)
  }
}

/** What a rig's timer did, to compare one rig with another. */
function timerRecord(rig: Rig): unknown {
  return { lines: rig.lines, attempts: rig.attempts, view: rig.controller.view(KEY), delays: delays(rig.clock), now: rig.clock.now() }
}

describe('unavailable retry: the retry observer (SRJ-308)', () => {
  test('full mode: called exactly once per retry, with the clock’s time at the retry, after its retry line and before its action', async () => {
    const { clock, controller, steps, attempts } = observedRig()
    controller.arm(KEY, UNAVAILABLE)

    const expected: ObservedStep[] = []
    for (let n = 0; n < 3; n++) {
      const dueAt = clock.now() + waitMs(n)
      await clock.advance(waitMs(n) - 1)
      expect(steps).toEqual(expected)
      await clock.advance(1)
      await controller.whenRunSettled(KEY)
      expected.push(...observedRetry(KEY, dueAt, fullRetryLine(KEY, n + 1)))
      expect(steps).toEqual(expected)
    }
    expect(attempts.map((a) => a.at)).toEqual(steps.filter(([step]) => step === 'fire').map(([, , at]) => at))
    expect(delays(clock)).toEqual([waitMs(3)])
  })

  test('each persona’s retry is observed once, with its own key and due time', async () => {
    const { clock, controller, steps } = observedRig()
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(1)
    controller.arm(OTHER, UNAVAILABLE)

    await clock.advance(waitMs(0))
    await controller.whenRunSettled(KEY)
    await controller.whenRunSettled(OTHER)

    expect(steps).toEqual([
      ...observedRetry(KEY, waitMs(0), fullRetryLine(KEY, 1)),
      ...observedRetry(OTHER, waitMs(0) + 1, fullRetryLine(OTHER, 1)),
    ])
  })

  test.each<[string, UnavailableRetryOutcome, boolean]>([
    ['a pending row (again)', { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_ROW_PENDING, row: UNAVAILABLE_RETRY_ROW_PENDING }, true],
    ['a live row (stop)', { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_LIVE, row: 'waiting', yieldsToFullMode: true }, false],
  ])('pending-only: a retry that reads %s is observed once, after its pending-only retry line and before its action', async (_what, outcome, armedAfter) => {
    const { clock, controller, steps, attempts } = observedRig(() => outcome)
    controller.armPendingOnly(KEY)

    await clock.advance(waitMs(0))
    await controller.whenRunSettled(KEY)

    expect(steps).toEqual(observedRetry(KEY, waitMs(0), pendingOnlyRetryLine(KEY, 1)))
    expect(attempts.map((a) => a.mode)).toEqual([UNAVAILABLE_RETRY_MODE_PENDING_ONLY])
    expect(controller.isArmed(KEY)).toBe(armedAfter)
    expect(delays(clock)).toEqual(armedAfter ? [waitMs(1)] : [])
  })

  test.each<[string, (rig: Rig) => void, () => StandInDeps, boolean, ReArmedModes]>([
    ['full mode (the retry entry answers in-flight)', (rig) => { rig.controller.arm(KEY, UNAVAILABLE) }, () => fullModeDeps(RESTART_OUTCOME_IN_FLIGHT), true, {}],
    ['pending-only (the in-flight predicate answers true)', (rig) => { rig.controller.armPendingOnly(KEY) }, () => fullModeDeps(RESTART_OUTCOME_LAUNCHED, { isInFlight: () => true }, UNAVAILABLE_RETRY_ROW_PENDING), false, { ranPendingOnly: true }],
  ])('a retry skipped for work in flight, %s, is observed once before the action answers the launch-in-flight refusal', async (_what, arm, makeDeps, entryCalled, modes) => {
    const deps = makeDeps()
    const rig = observedRig(createFullModeRetryAction(deps))
    arm(rig)
    const retryLine = modes.ranPendingOnly === true ? pendingOnlyRetryLine(KEY, 1) : fullRetryLine(KEY, 1)

    await rig.clock.advance(waitMs(0))
    await rig.controller.whenRunSettled(KEY)

    expect(rig.steps).toEqual(observedRetry(KEY, waitMs(0), retryLine))
    expect(rig.lines.at(-1)).toBe(reArmedLine(KEY, 1, UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT, 1, modes))
    expect(deps.reads).toEqual([])
    expect(deps.calls).toEqual(entryCalled ? [[KEY, `/work/${KEY}`]] : [])
  })

  test('a retry whose timer fires while the persona’s last run (outliving a stop) is in flight is observed once, only when it runs after that run settles', async () => {
    const held = heldAction()
    const { clock, controller, steps } = observedRig(held.action)
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))
    expect(steps).toEqual(observedRetry(KEY, waitMs(0), fullRetryLine(KEY, 1)))

    controller.stop(KEY, 'nothing left to recover')
    controller.arm(KEY, UNAVAILABLE)
    const secondDue = clock.now() + waitMs(0)
    await clock.advance(waitMs(0))
    expect(steps).toHaveLength(2)

    held.answer({ kind: 'again' })
    await clock.flush()
    expect(steps.slice(2)).toEqual(observedRetry(KEY, secondDue, fullRetryLine(KEY, 1)))

    held.answer({ kind: 'again' })
    await controller.whenRunSettled(KEY)
    expect(steps).toHaveLength(4)
    expect(delays(clock)).toEqual([waitMs(1)])
  })

  test.each<[string, (controller: UnavailableRetryController) => void]>([
    ['stop', (c) => { c.stop(KEY, 'nothing left to recover') }],
    ['stopAll', (c) => { c.stopAll('the server is reloading') }],
    ['close', (c) => { c.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN) }],
    ['a condition end', (c) => { expect(c.conditionEnded(KEY, CONDITION_ENDS[0]![0])).toBe('stopped') }],
  ])('a timer stopped by %s before its retry runs is never observed, and nothing runs or is pending', async (_how, stopIt) => {
    const { clock, controller, steps, attempts } = observedRig()
    controller.arm(KEY, UNAVAILABLE)
    await clock.runNext()
    await controller.whenRunSettled(KEY)
    expect(steps).toHaveLength(2)

    stopIt(controller)
    await clock.advance(waitMs(refusalsToCeiling()) * 4)

    expect(steps).toHaveLength(2)
    expect(attempts).toHaveLength(1)
    expect(clock.pendingCount()).toBe(0)
  })

  test.each(OBSERVER_SCENARIOS)('an observer that throws (%s) is swallowed: every retry is observed, and the retry lines, actions, re-arms and stops are those of a rig with no observer, with no line of its error', async (_what, scenario) => {
    const err = Object.assign(new Error(`the observer failed (${sentinelInMessage('observer')})`), { detail: LEAK_SENTINEL })
    const plain = makeRig(scenario.action())
    const throwing = observedRig(scenario.action(), err)

    await runScenario(plain, scenario)
    await runScenario(throwing, scenario)

    expect(timerRecord(throwing)).toEqual(timerRecord(plain))
    expect(throwing.steps.filter(([step]) => step === 'fire')).toHaveLength(scenario.retries)
    expect(throwing.attempts).toHaveLength(scenario.retries)
    expect(throwing.lines.filter((line) => line.includes('observer'))).toEqual([])
    assertNoLeak(throwing.lines)
  })

})

// ---------------------------------------------------------------------------
// The stop observer (`onStopped`, b.jg5 SRJ-309), on the bare controller over
// a scripted or held action, and, for the early stops, over the server's
// retry action on stand-in deps
// ---------------------------------------------------------------------------

/** Every stop reason the module exports. */
const ALL_STOP_REASONS: readonly string[] = [
  UNAVAILABLE_RETRY_STOP_RECOVERED,
  UNAVAILABLE_RETRY_STOP_CAPPED,
  UNAVAILABLE_RETRY_STOP_NOT_UP,
  UNAVAILABLE_RETRY_STOP_NOT_APPLIED,
  UNAVAILABLE_RETRY_STOP_LAUNCH_SKIPPED,
  UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  UNAVAILABLE_RETRY_STOP_SHUTDOWN,
  UNAVAILABLE_RETRY_STOP_ROW_LIVE,
  UNAVAILABLE_RETRY_STOP_ROW_GONE,
  UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED,
  UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED,
  UNAVAILABLE_RETRY_STOP_RUN_FAILED,
  UNAVAILABLE_RETRY_STOP_LATCHED,
]

/** One call a stop-observed run saw: the observer's (key, reason) or a hand-off's (key), each with the last line logged before it. */
type StopStep =
  | readonly ['stopped', string, string, string | undefined]
  | readonly ['hand-off', string, string | undefined]

/** Builds the run's one rig over `action` and `clock`. */
type StopRigBuilder = (action?: UnavailableRetryAction, clock?: FakeClock) => Rig

/** One run of a stop scenario: its rig builder, its ordered steps, and a hand-off that records itself there. */
interface StopRun {
  readonly build: StopRigBuilder
  readonly steps: StopStep[]
  handOff(key: string): () => Promise<unknown>
  rig(): Rig
}

/**
 * A run whose rig has no stop observer (`none`), a recording one, or a
 * recording one that then throws the given error. Its hand-offs record into
 * the same steps, so the order of a stop's observer and hand-off is kept.
 */
function stopRun(observer: 'none' | 'recording' | Error): StopRun {
  const steps: StopStep[] = []
  let built: Rig | undefined
  const onStopped: UnavailableRetryDeps['onStopped'] = observer === 'none'
    ? undefined
    : (key, reason) => {
        steps.push(['stopped', key, reason, built?.lines.at(-1)])
        if (observer instanceof Error) throw observer
      }
  return {
    steps,
    build: (action, clock) => {
      built = makeRig(action, clock, undefined, onStopped)
      return built
    },
    handOff: (key) => async () => { steps.push(['hand-off', key, built?.lines.at(-1)]) },
    rig: () => {
      if (built === undefined) throw new Error('stopRun: no rig was built')
      return built
    },
  }
}

/** Run persona `key`'s due retry to its settled re-arm or stop. */
async function retryOnce(rig: Rig, key = KEY): Promise<void> {
  await rig.clock.runNext()
  await rig.controller.whenRunSettled(key)
}

/** A stop path: how a run reaches it, and the steps it gives (given the run's rig). */
interface StopScenario {
  readonly play: (run: StopRun) => Promise<void>
  readonly expected: (rig: Rig) => StopStep[]
}

const [FIRST_CONDITION, FIRST_ENDED] = CONDITION_ENDS[0]!

/** The line a timer forgotten because its re-arm failed logs, as `rig` logged it. */
function runFailedLine(rig: Rig): string | undefined {
  return rig.lines.find((line) => line.startsWith(`[slack] unavailable-retry: persona=${KEY} retry run failed: `))
}

/** The one error a scenario's failing clock throws, so every run of it logs the same line. */
const CLOCK_REFUSED = new Error('the clock refused')

const STOP_SCENARIOS: ReadonlyArray<readonly [string, StopScenario]> = [
  ['the cap stop (a stop answer, full mode)', {
    play: async (r) => {
      const rig = r.build(() => ({ kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_CAPPED }))
      rig.controller.arm(KEY, UNAVAILABLE)
      await retryOnce(rig)
    },
    expected: () => [['stopped', KEY, UNAVAILABLE_RETRY_STOP_CAPPED, stoppedLine(KEY, UNAVAILABLE_RETRY_STOP_CAPPED)]],
  }],
  ['a full-mode stop answer with a hand-off', {
    play: async (r) => {
      const rig = r.build(() => ({ kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_RECOVERED, handOff: r.handOff(KEY) }))
      rig.controller.arm(KEY, UNAVAILABLE)
      await retryOnce(rig)
    },
    expected: () => [
      ['stopped', KEY, UNAVAILABLE_RETRY_STOP_RECOVERED, stoppedLine(KEY, UNAVAILABLE_RETRY_STOP_RECOVERED)],
      ['hand-off', KEY, stoppedLine(KEY, UNAVAILABLE_RETRY_STOP_RECOVERED)],
    ],
  }],
  ['a pending-only stop, the row live out of pending', {
    play: async (r) => {
      const rig = r.build(() => ({ kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_LIVE, row: 'waiting', yieldsToFullMode: true }))
      rig.controller.armPendingOnly(KEY)
      await retryOnce(rig)
    },
    expected: () => [['stopped', KEY, UNAVAILABLE_RETRY_STOP_ROW_LIVE, pendingOnlyStoppedLine(KEY, UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting')]],
  }],
  ['a pending-only stop, the row gone, handed off', {
    play: async (r) => {
      const rig = r.build(() => ({ kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_GONE, row: 'ended', handOff: r.handOff(KEY), yieldsToFullMode: true }))
      rig.controller.armPendingOnly(KEY)
      await retryOnce(rig)
    },
    expected: () => [
      ['stopped', KEY, UNAVAILABLE_RETRY_STOP_ROW_GONE, pendingOnlyStoppedLine(KEY, UNAVAILABLE_RETRY_STOP_ROW_GONE, 'ended')],
      ['hand-off', KEY, pendingOnlyStoppedLine(KEY, UNAVAILABLE_RETRY_STOP_ROW_GONE, 'ended')],
    ],
  }],
  ...CONDITION_ENDS.map(([condition, ended]): readonly [string, StopScenario] => [`a condition end (${condition}) while waiting`, {
    play: async (r) => {
      const rig = r.build()
      rig.controller.arm(KEY, UNAVAILABLE)
      expect(rig.controller.conditionEnded(KEY, condition)).toBe('stopped')
    },
    expected: () => [['stopped', KEY, ended, stoppedLine(KEY, ended)]],
  }]),
  ['a condition end deferred to a run, applied after its again answer', {
    play: async (r) => {
      const rig = r.build((key) => {
        expect(r.rig().controller.conditionEnded(key, FIRST_CONDITION)).toBe('deferred')
        return { kind: 'again' }
      })
      rig.controller.arm(KEY, UNAVAILABLE)
      await retryOnce(rig)
    },
    expected: () => [['stopped', KEY, FIRST_ENDED, stoppedLine(KEY, FIRST_ENDED)]],
  }],
  ['a yielded pending-only stop whose deferred condition end then stops the timer, before the held hand-off', {
    play: async (r) => {
      const rig = r.build((key) => {
        r.rig().controller.arm(key, UNAVAILABLE)
        r.rig().controller.conditionEnded(key, FIRST_CONDITION)
        return { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_GONE, row: 'ended', handOff: r.handOff(key), yieldsToFullMode: true }
      })
      rig.controller.armPendingOnly(KEY)
      await retryOnce(rig)
    },
    expected: () => [
      ['stopped', KEY, FIRST_ENDED, stoppedLine(KEY, FIRST_ENDED)],
      ['hand-off', KEY, stoppedLine(KEY, FIRST_ENDED)],
    ],
  }],
  ['stopAll, over a full-mode and a pending-only timer', {
    play: async (r) => {
      const rig = r.build()
      rig.controller.arm(KEY, UNAVAILABLE)
      rig.controller.armPendingOnly(OTHER)
      rig.controller.stopAll(UNAVAILABLE_RETRY_STOP_TORN_DOWN)
    },
    expected: () => [
      ['stopped', KEY, UNAVAILABLE_RETRY_STOP_TORN_DOWN, stoppedLine(KEY, UNAVAILABLE_RETRY_STOP_TORN_DOWN)],
      ['stopped', OTHER, UNAVAILABLE_RETRY_STOP_TORN_DOWN, pendingOnlyStoppedLine(OTHER, UNAVAILABLE_RETRY_STOP_TORN_DOWN)],
    ],
  }],
  ['close, called twice, then a refused arm', {
    play: async (r) => {
      const rig = r.build()
      rig.controller.arm(KEY, UNAVAILABLE)
      rig.controller.arm(OTHER, UNAVAILABLE)
      rig.controller.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
      rig.controller.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
      expect(rig.controller.arm(KEY, UNAVAILABLE)).toBe(false)
    },
    expected: () => [
      ['stopped', KEY, UNAVAILABLE_RETRY_STOP_SHUTDOWN, stoppedLine(KEY, UNAVAILABLE_RETRY_STOP_SHUTDOWN)],
      ['stopped', OTHER, UNAVAILABLE_RETRY_STOP_SHUTDOWN, stoppedLine(OTHER, UNAVAILABLE_RETRY_STOP_SHUTDOWN)],
    ],
  }],
  ['a stop during a run, whose later stop answer (with a hand-off) is dropped', {
    play: async (r) => {
      const held = heldAction()
      const rig = r.build(held.action)
      rig.controller.arm(KEY, UNAVAILABLE)
      await rig.clock.runNext()
      rig.controller.stop(KEY, UNAVAILABLE_RETRY_STOP_NOT_UP)
      held.answer({ kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_CAPPED, handOff: r.handOff(KEY) })
      await rig.controller.whenRunSettled(KEY)
    },
    expected: () => [['stopped', KEY, UNAVAILABLE_RETRY_STOP_NOT_UP, stoppedLine(KEY, UNAVAILABLE_RETRY_STOP_NOT_UP)]],
  }],
  ['the run-failed drop (the clock fails at the re-arm)', {
    play: async (r) => {
      const { clock, prime } = throwingClock(CLOCK_REFUSED)
      const rig = r.build(undefined, clock)
      rig.controller.arm(KEY, UNAVAILABLE)
      prime()
      await retryOnce(rig)
    },
    expected: (rig) => [['stopped', KEY, UNAVAILABLE_RETRY_STOP_RUN_FAILED, runFailedLine(rig)]],
  }],
]

/** Paths that are not stops: how a run reaches it, and whether persona `KEY` is armed after. */
const NOT_STOP_SCENARIOS: ReadonlyArray<readonly [string, (run: StopRun) => Promise<void>, boolean]> = [
  ['a stop, stopAll, a condition end and close that find nothing armed', async (r) => {
    const rig = r.build()
    rig.controller.stop(KEY, UNAVAILABLE_RETRY_STOP_RECOVERED)
    rig.controller.stopAll(UNAVAILABLE_RETRY_STOP_TORN_DOWN)
    expect(rig.controller.conditionEnded(KEY, FIRST_CONDITION)).toBe('not-armed')
    rig.controller.close(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
  }, false],
  ['a failed first arm (full mode), then a stop', async (r) => {
    const { clock, prime } = throwingClock(new Error('the clock refused'))
    const rig = r.build(undefined, clock)
    prime()
    expect(rig.controller.arm(KEY, UNAVAILABLE)).toBe(false)
    rig.controller.stop(KEY, UNAVAILABLE_RETRY_STOP_RECOVERED)
  }, false],
  ['a failed first arm (pending-only), then a stop', async (r) => {
    const { clock, prime } = throwingClock(new Error('the clock refused'))
    const rig = r.build(undefined, clock)
    prime()
    rig.controller.armPendingOnly(KEY)
    rig.controller.stop(KEY, UNAVAILABLE_RETRY_STOP_RECOVERED)
  }, false],
  ['a condition end kept for a pending row', async (r) => {
    const rig = r.build()
    rig.controller.armPendingOnly(KEY)
    expect(rig.controller.conditionEnded(KEY, FIRST_CONDITION)).toBe('kept')
  }, true],
  ['a condition end kept for a kill-failed cause', async (r) => {
    const rig = r.build()
    rig.controller.arm(KEY, { kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED })
    expect(rig.controller.conditionEnded(KEY, FIRST_CONDITION)).toBe('kept')
  }, true],
  ...([
    ['live out of pending', UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting'],
    ['gone', UNAVAILABLE_RETRY_STOP_ROW_GONE, 'ended'],
  ] as const).map(([what, reason, row]): readonly [string, (run: StopRun) => Promise<void>, boolean] => [
    `a pending-only stop (the row ${what}) that yields to a full-mode cause armed during its retry`,
    async (r) => {
      const rig = r.build((key) => {
        r.rig().controller.arm(key, UNAVAILABLE)
        return { kind: 'stop', reason, row, handOff: r.handOff(key), yieldsToFullMode: true }
      })
      rig.controller.armPendingOnly(KEY)
      await retryOnce(rig)
      expect(rig.controller.view(KEY)).toMatchObject({ phase: 'waiting', mode: UNAVAILABLE_RETRY_MODE_FULL, refusals: 1 })
    },
    true,
  ]),
]

/** What a stop-observed rig's timers did, to compare one rig with another. */
function stopRecord(rig: Rig): unknown {
  return { lines: rig.lines, attempts: rig.attempts, armed: rig.controller.armedKeys(), view: rig.controller.view(KEY), delays: delays(rig.clock), now: rig.clock.now() }
}

describe('unavailable retry: the stop observer (SRJ-309)', () => {
  test.each(ALL_STOP_REASONS.map((reason) => [reason]))('stop(key, "%s") is observed exactly once per stopped timer, with its reason, after its stopped line; a stop that finds nothing armed is not', (reason) => {
    const run = stopRun('recording')
    const { controller } = run.build()
    controller.arm(KEY, UNAVAILABLE)
    controller.armPendingOnly(OTHER)

    controller.stop(KEY, reason)
    controller.stop(OTHER, reason)
    controller.stop(KEY, reason)
    controller.stop(OTHER, reason)

    expect(run.steps).toEqual([
      ['stopped', KEY, reason, stoppedLine(KEY, reason)],
      ['stopped', OTHER, reason, pendingOnlyStoppedLine(OTHER, reason)],
    ])
    expect(controller.armedKeys()).toEqual([])
  })

  test.each(STOP_SCENARIOS)('%s: observed exactly once per stopped timer, with the stop’s reason, after its stopped line and before any hand-off', async (_what, scenario) => {
    const run = stopRun('recording')
    await scenario.play(run)
    const rig = run.rig()

    expect(run.steps).toEqual(scenario.expected(rig))
    for (const step of run.steps) expect(step.at(-1)).toBeString()

    // Nothing more is observed as time runs on.
    const seen = run.steps.length
    await rig.clock.advance(waitMs(refusalsToCeiling()) * 4)
    expect(run.steps).toHaveLength(seen)
    expect(rig.clock.pendingCount()).toBe(0)
  })

  test.each(GATES)('the server’s retry action’s early stop (%s) is observed once, with its reason, after its stopped line', async (_what, overrides, reason) => {
    const deps = fullModeDeps(RESTART_OUTCOME_LAUNCHED, overrides)
    const run = stopRun('recording')
    const rig = run.build(createFullModeRetryAction(deps))
    rig.controller.arm(KEY, UNAVAILABLE)

    await retryOnce(rig)

    expect(run.steps).toEqual([['stopped', KEY, reason, stoppedLine(KEY, reason)]])
    expect(deps.calls).toEqual([])
  })

  test.each(NOT_STOP_SCENARIOS)('%s is not a stop: the observer is not called', async (_what, play, armedAfter) => {
    const run = stopRun('recording')
    await play(run)

    expect(run.steps).toEqual([])
    expect(run.rig().controller.isArmed(KEY)).toBe(armedAfter)
  })

  test.each(STOP_SCENARIOS)('%s: an observer that throws is swallowed, and with no observer nothing changes: the lines, retries, timers and hand-offs are the same, with no line of its error', async (_what, scenario) => {
    const err = Object.assign(new Error(`the observer failed (${sentinelInMessage('stop-observer')})`), { detail: LEAK_SENTINEL })
    const plain = stopRun('none')
    const recording = stopRun('recording')
    const throwing = stopRun(err)

    await scenario.play(plain)
    await scenario.play(recording)
    await scenario.play(throwing)

    expect(stopRecord(recording.rig())).toEqual(stopRecord(plain.rig()))
    expect(stopRecord(throwing.rig())).toEqual(stopRecord(plain.rig()))
    expect(plain.steps).toEqual(recording.steps.filter(([step]) => step === 'hand-off'))
    expect(throwing.steps).toEqual(recording.steps)
    expect(throwing.rig().lines.filter((line) => line.includes('observer'))).toEqual([])
    assertNoLeak(throwing.rig().lines)
  })

  test('the terminal-stops pin: UNAVAILABLE_RETRY_TERMINAL_STOPS holds exactly the torn-down, not-applied and shutdown reasons', () => {
    const terminal = [UNAVAILABLE_RETRY_STOP_TORN_DOWN, UNAVAILABLE_RETRY_STOP_NOT_APPLIED, UNAVAILABLE_RETRY_STOP_SHUTDOWN]
    expect([...UNAVAILABLE_RETRY_TERMINAL_STOPS].sort()).toEqual([...terminal].sort())
    expect(ALL_STOP_REASONS.filter((reason) => UNAVAILABLE_RETRY_TERMINAL_STOPS.has(reason)).sort()).toEqual([...terminal].sort())
  })
})

// ---------------------------------------------------------------------------
// ENVIRONMENT (`ErrTmuxNotAvailable`, b.jg5 SRJ-311, SRJ-312, AC 27, AC 36) on
// the recovery harness, both settings 0: what arms the timer in and out of an
// attempt, never counted and retried only on the backoff, a read success that
// keeps the outage, the clears that stop the timer (SRJ-305) and SRJ-306's
// exceptions against them, the recovery, and a kill of the last session on a
// socket followed by answers from a tmux server that is exiting (AD handoff
// rev 23)
// ---------------------------------------------------------------------------

/** The `tmux-unavailable` onset, as the outage state posts it. */
function tmuxUnavailableOnset(key: string): { key: string; text: string } {
  return { key, text: ONSET_TEMPLATES['tmux-unavailable']() }
}

/** The single all-clear of a bad stretch that held only `tmux-unavailable`. */
function tmuxUnavailableAllClear(key: string): { key: string; text: string } {
  return { key, text: ALL_CLEAR_TEMPLATE(new Map([['tmux-unavailable', { detail: undefined }]])) }
}

/**
 * A start-pass launch of persona `key` whose optimistic spawn answers
 * ENVIRONMENT: refused, one onset, P's timer armed at the base wait with the
 * ENVIRONMENT cause. The stub's spawn keeps answering ENVIRONMENT. Resolves
 * with the arm's time.
 */
async function environmentLaunch(h: RecoveryHarness, key: string): Promise<number> {
  h.script({ spawnError: errTmuxNotAvailable() })
  const armedAt = h.clock.now()
  expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })
  expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key)])
  expect(h.controller.view(key)).toEqual({
    phase: 'waiting',
    dueAt: armedAt + waitMs(0),
    waitMs: waitMs(0),
    refusals: 0,
    causes: [UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    mode: UNAVAILABLE_RETRY_MODE_FULL,
  })
  return armedAt
}

/** The re-armed line of a retry refused by ENVIRONMENT: its prefix and suffix, after `refusals` refusals. */
function environmentReArmed(h: RecoveryHarness, key: string, retry: number, refusals: number): string[] {
  const prefix = `[slack] unavailable-retry: persona=${key} retry ${retry}: ${UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT}: `
  const suffix = ` — re-armed, next retry in ${waitMs(refusals) / 1000} s`
  return retryLinesOf(h, key).filter((line) => line.startsWith(prefix) && line.endsWith(suffix))
}

/** Record the clock time of every stub `kill` call, in order. */
function recordKills(h: RecoveryHarness): number[] {
  const at: number[] = []
  const client = h.stub.client
  const kill = client.kill.bind(client)
  client.kill = async (params) => {
    at.push(h.clock.now())
    return kill(params)
  }
  return at
}

/** What a health tick's healthy branch does to the outage (`src/health-check.ts`): the clear, with the tick's `live` reading. */
function tickClear(key: string): void {
  clearOutageFlag(key, 'tmux-unavailable', LIVENESS_LIVE)
}

/** Nothing reached persona `other`: no trigger, timer, notice or call. */
function expectUntouched(h: RecoveryHarness, other: string): void {
  expect(h.triggers.filter((t) => t.key === other)).toEqual([])
  expect(h.controller.isArmed(other)).toBe(false)
  expect(h.outageNotices.filter((n) => n.key === other)).toEqual([])
  expect(h.notices.filter((n) => n.key === other)).toEqual([])
  expect(getOutageFlags(other).size).toBe(0)
  const otherId = personaInstanceId(other)
  const calls = Object.values(h.stub.calls).flat() as Array<{ claude_instance_id?: unknown }>
  expect(calls.filter((params) => params?.claude_instance_id === otherId)).toEqual([])
}

describe('unavailable retry: ENVIRONMENT arms from any verb, is never counted, is retried only on the backoff, and its clear stops the timer (SRJ-311, SRJ-312, SRJ-305, SRJ-306, AC 27, AC 36)', () => {
  test('a start-pass launch whose spawn answers ErrTmuxNotAvailable is refused and arms that persona’s timer once at the base wait with the ENVIRONMENT cause: one onset, nothing counted, no other call; the other persona is untouched', async () => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]

    await environmentLaunch(h, key)

    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT)
    expect(callCounts(h)).toEqual({ spawnCalls: 1 })
    expect(getFailureCount(key)).toBe(0)
    expect([...getOutageFlags(key)]).toEqual(['tmux-unavailable'])
    // ENVIRONMENT never starts the tmux-unresponsive condition (SRJ-307).
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expectUntouched(h, other)
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>, Record<string, number>]>([
    ['the health tick’s liveness read (status)', async (h, key) => {
      h.script({ statusError: errTmuxNotAvailable(undefined, 'status') })
      expect(await _buildIsSessionAliveAdapter(() => h.config)(key)).toEqual(LIVENESS_READING_UNKNOWN)
    }, { statusCalls: 1 }],
    ['a persona teardown’s kill', async (h, key) => {
      const err = errTmuxNotAvailable(undefined, 'kill')
      h.script({ killError: err })
      await expect(killPersonaInstance(key)).rejects.toBe(err)
    }, { killCalls: 1 }],
    ['a plain read-pane through the outage wrapper', async (h, key) => {
      const err = errTmuxNotAvailable(undefined, 'read-pane')
      h.script({ readPaneError: err })
      await expect(readPaneSucceeds(h, key)).rejects.toBe(err)
    }, { readPaneCalls: 1 }],
    ['the permission poller’s get', async (h, key) => {
      h.script({
        listResult: { spawns: [cannedListRow({ state: 'check_permission' }, personaOf(h, key), h.home)] },
        getError: errTmuxNotAvailable(undefined, 'get'),
      })
      // The poller skips its per-event line for ENVIRONMENT: its tick is
      // over once its get has been answered and the trigger sent.
      const client = h.stub.client
      const get = client.get.bind(client)
      const answered = Promise.withResolvers<void>()
      client.get = async (params) => {
        try {
          return await get(params)
        } finally {
          answered.resolve()
        }
      }
      stopPermissionPoller()
      _resetPollerState()
      const poller = startManualPoller({
        getClient: () => h.stub.client as unknown as ReturnType<PollerDeps['getClient']>,
        clientFor: () => undefined,
        getPersona: (k) => h.config.personas.find((p) => p.key === k),
        emitTrail: () => {},
        log: () => {},
      })
      try {
        poller.fire()
        await answered.promise
        for (let flushes = 0; flushes < 20 && h.triggers.length === 0; flushes++) await h.clock.flush()
      } finally {
        stopPermissionPoller()
        _resetPollerState()
      }
    }, { listCalls: 1, getCalls: 1 }],
  ])('ErrTmuxNotAvailable from %s, made outside every attempt, raises the outage and arms that persona’s timer once at the base wait with the ENVIRONMENT cause; the other persona is untouched', async (_site, run, calls) => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    expect(isInsideAttempt(key)).toBe(false)

    await run(h, key)

    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT)
    expect(callCounts(h)).toEqual(calls)
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key)])
    expect(getFailureCount(key)).toBe(0)
    expectUntouched(h, other)
  })

  test('ErrTmuxNotAvailable from the JSONL safeguard’s get for each persona, made outside every attempt, arms each persona’s timer once at the base wait with the ENVIRONMENT cause', async () => {
    const h = (harness = makeRecoveryHarness())
    h.script({ getError: errTmuxNotAvailable(undefined, 'get') })

    await runJsonlPersistenceSafeguard(h.config, undefined, {
      home: h.home,
      readMountinfo: () => '',
      statFn: () => false,
      archiveCountSince: () => null,
      recordStartupError: () => {},
    })

    expect(h.triggers).toEqual(h.keys.map((key) => ({ key, kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT })))
    expect([...h.controller.armedKeys()].sort()).toEqual([...h.keys].sort())
    for (const key of h.keys) {
      expect(h.controller.view(key)).toEqual({
        phase: 'waiting',
        dueAt: h.clock.now() + waitMs(0),
        waitMs: waitMs(0),
        refusals: 0,
        causes: [UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
        mode: UNAVAILABLE_RETRY_MODE_FULL,
      })
    }
    expect(h.outageNotices).toEqual(h.keys.map(tmuxUnavailableOnset))
    expect(h.attempts).toEqual([])
  })

  test('a trigger for a key no longer in the applied configuration (its teardown’s kill answers ErrTmuxNotAvailable) arms it, and its first retry stops it with no agent-director call; the other persona is untouched', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    h.remove(key)
    h.script({ killError: errTmuxNotAvailable(undefined, 'kill') })
    await expect(killPersonaInstance(key)).rejects.toThrow()
    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT)
    const before = callCounts(h)

    await retryNow(h, key)

    expect(h.attempts).toHaveLength(1)
    expect(callsSince(h, before)).toEqual({})
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_NOT_APPLIED))
    expectStopped(h, key)
    expectUntouched(h, other)
  })

  test('AC 36: with both settings 0, a spawn that keeps answering ErrTmuxNotAvailable is retried only at each due time from the backoff, never 1 ms early, never counted past the cap, with no delete and no kill or launch outside a retry, and exactly one onset however many retries', async () => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    const row = modelRow(h, 'missing')
    const kills = recordKills(h)
    const armedAt = await environmentLaunch(h, key)
    expect(row.spawnedAt).toEqual([armedAt])

    const retries = RESTART_FAILURE_CAP + refusalsToCeiling() + 2
    const retryTimes: number[] = []
    let dueAt = armedAt
    for (let n = 0; n < retries; n++) {
      dueAt += waitMs(n)
      await h.advance(dueAt - 1 - h.clock.now())
      expect([n, row.spawnedAt.length, kills.length]).toEqual([n, n + 1, n])
      await h.advance(1)
      await h.settle()
      retryTimes.push(dueAt)
      expect([n, row.spawnedAt.at(-1), kills.at(-1)]).toEqual([n, dueAt, dueAt])
      expect([n, environmentReArmed(h, key, n + 1, n + 1)]).toEqual([n, [expect.any(String)]])
      expect(h.controller.view(key)).toEqual({
        phase: 'waiting',
        dueAt: dueAt + waitMs(n + 1),
        waitMs: waitMs(n + 1),
        refusals: n + 1,
        causes: [UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
        mode: UNAVAILABLE_RETRY_MODE_FULL,
      })
    }

    // Every spawn and kill came at the arm or a retry's due time.
    expect(row.spawnedAt).toEqual([armedAt, ...retryTimes])
    expect(kills).toEqual(retryTimes)
    expect(h.attempts.map((a) => a.at)).toEqual(retryTimes)
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(getFailureCount(key)).toBe(0)
    expect(isAtCap(key, RESTART_FAILURE_CAP)).toBe(false)
    expect(h.capReached).toEqual([])
    expect(h.triggers.every((t) => t.key === key && t.kind === UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT)).toBe(true)
    // The row reads succeeded every retry; none cleared the outage.
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key)])
    expect(h.outageClears).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expectUntouched(h, other)
  })

  test.each<[string, RowState | typeof UNAVAILABLE_RETRY_ROW_ABSENT, Record<string, number>]>([
    ['reads the row ended (a status success); its kill answers and its spawn answers ErrTmuxNotAvailable', 'ended', { statusCalls: 1, killCalls: 1, spawnCalls: 1 }],
    ['reads the row missing (a status success); its kill answers and its spawn answers ErrTmuxNotAvailable', 'missing', { statusCalls: 1, killCalls: 1, spawnCalls: 1 }],
    ['reads no row (status answers ErrSpawnNotFound); its kill answers and its spawn answers ErrTmuxNotAvailable', UNAVAILABLE_RETRY_ROW_ABSENT, { statusCalls: 1, killCalls: 1, spawnCalls: 1 }],
  ])('AC 27, AC 36: a retry that %s leaves the outage raised with no all-clear and the timer armed at the doubled wait', async (_what, state, calls) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    modelRow(h, state)
    await environmentLaunch(h, key)
    const before = callCounts(h)

    await retryNow(h, key)

    expect(callsSince(h, before)).toEqual(calls)
    expect([...getOutageFlags(key)]).toEqual(['tmux-unavailable'])
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key)])
    expect(h.outageClears).toEqual([])
    expect(environmentReArmed(h, key, 1, 1)).toHaveLength(1)
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', dueAt: h.clock.now() + waitMs(1), waitMs: waitMs(1), refusals: 1 })
    expect(getFailureCount(key)).toBe(0)
  })

  // b.jg5 SRJ-117, SRJ-604: ENVIRONMENT at a `waiting` row's read-pane types
  // nothing, so the reconnect's send-keys is never reached.
  test('AC 27: a retry whose row reads live (waiting, a status success) and whose reconnect’s read-pane answers ErrTmuxNotAvailable types nothing and leaves the outage raised and the timer armed at the doubled wait, with no kill or spawn and nothing counted', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    modelRow(h, 'waiting')
    await environmentLaunch(h, key)
    h.script({ readPaneError: errTmuxNotAvailable(undefined, 'read-pane') })
    const before = callCounts(h)

    await retryNow(h, key)

    expect(callsSince(h, before)).toEqual({ statusCalls: 2, readPaneCalls: 1 })
    expect([...getOutageFlags(key)]).toEqual(['tmux-unavailable'])
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key)])
    expect(h.outageClears).toEqual([])
    expect(retryLinesOf(h, key).at(-1)).toBe(reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_RECONNECT_DEFERRED, 1))
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', dueAt: h.clock.now() + waitMs(1), refusals: 1 })
    expect(getFailureCount(key)).toBe(0)
  })

  test('a retry whose reconnect of the live row succeeds (tmux answers its read-pane and send-keys) clears the outage with one all-clear, and the timer stops', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    modelRow(h, 'waiting')
    await environmentLaunch(h, key)
    const before = callCounts(h)

    await retryNow(h, key)

    expect(callsSince(h, before)).toEqual({ statusCalls: 2, readPaneCalls: 1, sendKeysCalls: 1 })
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key), tmuxUnavailableAllClear(key)])
    expect(getOutageFlags(key).size).toBe(0)
    // The clear reaches the condition-end entry once, while the retry runs.
    expect(h.outageClears).toEqual([{ key, reading: undefined, result: 'deferred' }])
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_RECOVERED))
    expectStopped(h, key)
    expect(getFailureCount(key)).toBe(0)
    expectUntouched(h, other)
  })

  test('a retry that finds the persona live (not pending) and connected with its stream clears the outage with its live reading and one all-clear, and the timer stops', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    modelRow(h, 'waiting')
    await environmentLaunch(h, key)
    h.setConnected(key, true)
    const before = callCounts(h)

    await retryNow(h, key)

    expect(callsSince(h, before)).toEqual({ statusCalls: 1 })
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key), tmuxUnavailableAllClear(key)])
    expect(h.outageClears).toEqual([{ key, reading: LIVENESS_LIVE, result: 'deferred' }])
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_RECOVERED))
    expectStopped(h, key)
  })

  test('a pending-only retry that reads the row live out of pending, connected with its stream, clears the outage with that reading and one all-clear, and the timer stops', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    modelRow(h, 'waiting')
    // The outage raised as the wrappers raise it, and the timer armed
    // pending-only directly (no wired path yet leaves both).
    setOutageFlag(key, 'tmux-unavailable')
    h.controller.armPendingOnly(key)
    h.setConnected(key, true)

    await retryNow(h, key)

    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key), tmuxUnavailableAllClear(key)])
    expect(h.outageClears).toEqual([{ key, reading: 'waiting', result: 'deferred' }])
    expect(retryLinesOf(h, key).at(-1)).toBe(pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting'))
    expectStopped(h, key)
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>]>([
    ['no retry has read the row', async () => {}],
    ['a retry last read the row pending (the tick’s live reading is the later read)', async (h, key) => {
      modelRow(h, UNAVAILABLE_RETRY_ROW_PENDING)
      await retryNow(h, key)
      expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
    }],
  ])('a health tick’s healthy-branch clear, when %s, posts one all-clear and stops the timer', async (_what, before) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    await environmentLaunch(h, key)
    await before(h, key)

    tickClear(key)

    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key), tmuxUnavailableAllClear(key)])
    expect(h.outageClears).toEqual([{ key, reading: LIVENESS_LIVE, result: 'stopped' }])
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED))
    expectStopped(h, key)

    // A second clear finds nothing raised: no all-clear, no call to the entry.
    tickClear(key)
    expect(h.outageNotices).toHaveLength(2)
    expect(h.outageClears).toHaveLength(1)
  })

  test('AC 30 (its tmux-unavailable half): a successful read-pane that clears the outage while a retry last read the row pending posts one all-clear and leaves the timer armed with its due time; the next retry still runs at it', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_PENDING)
    await environmentLaunch(h, key)
    await retryNow(h, key)
    expect([...getOutageFlags(key)]).toEqual(['tmux-unavailable'])
    const before = h.controller.view(key)!
    expect(before).toMatchObject({ phase: 'waiting', refusals: 1, mode: UNAVAILABLE_RETRY_MODE_FULL, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })

    await readPaneSucceeds(h, key)

    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key), tmuxUnavailableAllClear(key)])
    expect(h.outageClears).toEqual([{ key, reading: undefined, result: 'kept' }])
    expect(retryLinesOf(h, key).at(-1)).toBe(keptLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED, UNAVAILABLE_RETRY_KEPT_ROW_PENDING))
    expect(h.controller.view(key)).toEqual(before)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([before.dueAt!])

    const attempts = h.attempts.length
    await h.advance(before.dueAt! - 1 - h.clock.now())
    expect(h.attempts).toHaveLength(attempts)
    await retryNow(h, key)
    expect(h.attempts.slice(attempts)).toEqual([{ key, retry: 2, causes: before.causes, mode: UNAVAILABLE_RETRY_MODE_FULL, at: before.dueAt! }])
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<unknown>, string | undefined]>([
    ['a successful read-pane', readPaneSucceeds, undefined],
    ['a health tick’s healthy-branch clear', async (_h, key) => tickClear(key), LIVENESS_LIVE],
  ])('with a kill-failure cause recorded, %s clears the outage with one all-clear and leaves the timer armed with its due time', async (_what, clear, reading) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    modelRow(h, 'ended')
    h.script({ killError: errTmuxKillFailed() })
    expect(await runRestartRetry(key, personaOf(h, key).working_directory, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
    await h.settle()
    // The outage is raised by a read-pane outside every attempt.
    h.script({ killError: undefined, readPaneError: errTmuxNotAvailable(undefined, 'read-pane') })
    await expect(readPaneSucceeds(h, key)).rejects.toThrow()
    h.script({ readPaneError: undefined })
    expect(h.triggers).toEqual([{ key, kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED }, { key, kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT }])
    const before = h.controller.view(key)!
    expect(before).toMatchObject({ phase: 'waiting', causes: [UNAVAILABLE_RETRY_CAUSE_KILL_FAILED, UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT] })

    await clear(h, key)

    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key), tmuxUnavailableAllClear(key)])
    expect(h.outageClears).toEqual([{ key, reading, result: 'kept' }])
    expect(retryLinesOf(h, key).at(-1)).toBe(keptLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED, UNAVAILABLE_RETRY_KEPT_KILL_FAILED))
    expect(h.controller.view(key)).toEqual({ ...before, ...(reading !== undefined ? { lastRow: reading } : {}) })
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([before.dueAt!])
  })

  test('recovery: once the spawn answers, the persona comes up once, the outage clears with one all-clear (the launch’s pending row keeps the timer, pending-only), and the next retry finds it live and connected and stops', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const row = modelRow(h, 'missing')
    await environmentLaunch(h, key)
    await retryNow(h, key)
    await retryNow(h, key)
    expect(row.spawnedAt).toHaveLength(3)
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key)])

    h.script({ spawnError: undefined })
    await retryNow(h, key)

    expect(row.spawnedAt).toHaveLength(4)
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key), tmuxUnavailableAllClear(key)])
    expect(h.outageClears).toEqual([{ key, reading: UNAVAILABLE_RETRY_ROW_PENDING, result: 'deferred' }])
    expect(retryLinesOf(h, key).slice(-2)).toEqual([
      keptLine(key, UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED, UNAVAILABLE_RETRY_KEPT_ROW_PENDING),
      reArmedLine(key, 3, UNAVAILABLE_RETRY_AGAIN_LAUNCHED, 3, { switchedTo: UNAVAILABLE_RETRY_MODE_PENDING_ONLY }),
    ])
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })

    h.setConnected(key, true)
    const before = callCounts(h)
    await retryNow(h, key)
    expect(callsSince(h, before)).toEqual({ statusCalls: 1 })
    expect(row.spawnedAt).toHaveLength(4)
    expect(retryLinesOf(h, key).at(-1)).toBe(pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting'))
    expectStopped(h, key)
    expect(h.outageNotices).toHaveLength(2)
    expect(getFailureCount(key)).toBe(0)
    expect(h.capReached).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A re-bound tmux socket (b.jg5 SRJ-1021, SRJ-311's AC 86 Test line): the
// `ErrTmuxNotAvailable` whose description says the socket's server is not the
// one the worker was launched on posts SRJ-1021's onset, not today's. The row
// stays live, so each retry reruns the restart path's reconnect: never a kill,
// delete or launch, nothing counted, and the retries on the backoff until
// tmux answers.
// ---------------------------------------------------------------------------

describe('unavailable retry: a re-bound tmux socket gives SRJ-1021’s onset and no kill, delete or launch (SRJ-1021, SRJ-311, AC 86)', () => {
  test('AC 86: with both settings 0, a live, unconnected row whose every tmux-touching verb answers the re-bound ErrTmuxNotAvailable posts one onset, SRJ-1021’s, across several retries at the backoff’s due times, with no kill, delete, spawn or resume and nothing counted; once tmux answers, the reconnect clears it with today’s all-clear and the timer stops', async () => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    modelRow(h, 'waiting')
    h.setConnected(key, false)
    h.script({
      readPaneError: errTmuxNotAvailableDifferentServer(undefined, 'read-pane'),
      sendKeysError: errTmuxNotAvailableDifferentServer(undefined, 'send-keys'),
      killError: errTmuxNotAvailableDifferentServer(undefined, 'kill'),
      deleteError: errTmuxNotAvailableDifferentServer(undefined, 'delete'),
      spawnError: errTmuxNotAvailableDifferentServer(undefined, 'spawn'),
      resumeError: errTmuxNotAvailableDifferentServer(undefined, 'resume'),
    })
    const reBoundOnset = { key, text: tmuxServerChangedOnset() }

    // A read-pane outside every attempt meets the re-bound socket: the
    // outage is raised with SRJ-1021's onset and P's timer armed.
    const armedAt = h.clock.now()
    await expect(readPaneSucceeds(h, key)).rejects.toThrow()
    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT)
    expect(h.outageNotices).toEqual([reBoundOnset])
    expect([...getOutageFlags(key)]).toEqual(['tmux-unavailable'])

    // Several retries, each at its due time and never 1 ms early. Each reads
    // the row live (waiting); its reconnect's read-pane meets the re-bound
    // socket, so nothing is typed (b.jg5 SRJ-117, SRJ-604), and it re-arms at
    // the doubled wait and posts nothing more.
    const retries = 4
    let dueAt = armedAt
    for (let n = 0; n < retries; n++) {
      dueAt += waitMs(n)
      await h.advance(dueAt - 1 - h.clock.now())
      expect([n, h.attempts.length]).toEqual([n, n])
      const before = callCounts(h)
      expect(await retryNow(h, key)).toBe(dueAt)
      expect([n, h.attempts.at(-1)]).toEqual([n, { key, retry: n + 1, causes: [UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT], mode: UNAVAILABLE_RETRY_MODE_FULL, at: dueAt }])
      expect([n, callsSince(h, before)]).toEqual([n, { statusCalls: 2, readPaneCalls: 1 }])
      expect([n, retryLinesOf(h, key).at(-1)]).toEqual([n, reArmedLine(key, n + 1, UNAVAILABLE_RETRY_AGAIN_RECONNECT_DEFERRED, n + 1)])
      expect([n, h.controller.view(key)]).toEqual([n, expect.objectContaining({ phase: 'waiting', dueAt: dueAt + waitMs(n + 1), waitMs: waitMs(n + 1), refusals: n + 1 })])
      expect([n, getFailureCount(key)]).toEqual([n, 0])
    }

    // One onset for the stretch, SRJ-1021's; never today's install-or-repair onset.
    expect(h.outageNotices).toEqual([reBoundOnset])
    expect(h.outageNotices.map((n) => n.text)).not.toContain(ONSET_TEMPLATES['tmux-unavailable']())
    expect(h.outageClears).toEqual([])
    // No kill, delete or launch in the whole run, and nothing counted or escalated.
    expect(h.stub.calls.killCalls).toEqual([])
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(h.stub.calls.spawnCalls).toEqual([])
    expect(h.stub.calls.resumeCalls).toEqual([])
    expect(getFailureCount(key)).toBe(0)
    expect(isAtCap(key, RESTART_FAILURE_CAP)).toBe(false)
    expect(h.capReached).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)

    // tmux answers again: the next retry's reconnect succeeds, clearing the
    // outage with today's all-clear, and the timer stops.
    h.script({ readPaneError: undefined, sendKeysError: undefined })
    dueAt += waitMs(retries)
    const before = callCounts(h)
    expect(await retryNow(h, key)).toBe(dueAt)

    expect(callsSince(h, before)).toEqual({ statusCalls: 2, readPaneCalls: 1, sendKeysCalls: 1 })
    expect(h.outageNotices).toEqual([reBoundOnset, tmuxUnavailableAllClear(key)])
    expect(getOutageFlags(key).size).toBe(0)
    expect(h.outageClears).toEqual([{ key, reading: undefined, result: 'deferred' }])
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_RECOVERED))
    expectStopped(h, key)
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.stub.calls.killCalls).toEqual([])
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(h.stub.calls.spawnCalls).toEqual([])
    expect(h.stub.calls.resumeCalls).toEqual([])
    expect(getFailureCount(key)).toBe(0)
    expectUntouched(h, other)
  })
})

// ---------------------------------------------------------------------------
// A kill of the last session on a tmux socket, then a tmux server that is
// exiting (AD handoff rev 23): right after the kill, the calls that follow on
// that socket can briefly answer `ErrTmuxNotAvailable` or
// `ErrTmuxUnresponsive`. CSCB handles each by its class (b.jg5 SRJ-311,
// SRJ-307): one onset per episode, one all-clear or recovery when tmux
// answers, nothing posted twice, nothing latched, and the retry timer on its
// schedule (SRJ-302, SRJ-305, SRJ-306).
// ---------------------------------------------------------------------------

describe('unavailable retry: a kill of the last session on a socket, then answers from a tmux server that is exiting (AD handoff rev 23)', () => {
  test('ErrTmuxNotAvailable after the kill: one onset for the episode however many calls answer it, the retries on the backoff with nothing counted, deleted or launched while it lasts, one all-clear when tmux answers, the timer stopped once the persona is up; a later episode posts its own onset', async () => {
    const h = (harness = makeRecoveryHarness(RETRY_TIMER_ONLY))
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    const row = modelRow(h, 'ended')
    const kills = recordKills(h)

    // The restart kills the persona's session, the last on its socket (the
    // kill answers); the tmux server exits and the launch's spawn answers
    // ErrTmuxNotAvailable.
    h.script({ spawnError: errTmuxNotAvailable() })
    const killedAt = h.clock.now()
    expect(await runRestartRetry(key, personaOf(h, key).working_directory, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
    await h.settle()
    expect(kills).toEqual([killedAt])
    expect(row.spawnedAt).toEqual([killedAt])
    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT)
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key)])

    // More calls on the socket answer it while the server exits: a read-pane
    // outside every attempt, and each retry's kill. None posts again; the
    // trigger keeps the due time.
    h.script({ killError: errTmuxNotAvailable(undefined, 'kill'), readPaneError: errTmuxNotAvailable(undefined, 'read-pane') })
    await expect(readPaneSucceeds(h, key)).rejects.toThrow()
    expect(h.controller.view(key)).toMatchObject({ dueAt: killedAt + waitMs(0), refusals: 0 })
    let dueAt = killedAt
    for (let n = 0; n < 2; n++) {
      dueAt += waitMs(n)
      await h.advance(dueAt - 1 - h.clock.now())
      expect(h.attempts).toHaveLength(n)
      await retryNow(h, key)
      expect(h.attempts.at(-1)).toEqual({ key, retry: n + 1, causes: [UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT], mode: UNAVAILABLE_RETRY_MODE_FULL, at: dueAt })
      expect(environmentReArmed(h, key, n + 1, n + 1)).toHaveLength(1)
    }
    // Each refused kill stopped its retry: no spawn followed it.
    expect(kills).toEqual([killedAt, killedAt + waitMs(0), killedAt + waitMs(0) + waitMs(1)])
    expect(row.spawnedAt).toEqual([killedAt])
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key)])
    expect(h.outageClears).toEqual([])

    // tmux answers again: the next retry's kill and spawn succeed. The
    // spawn's success clears the outage with one all-clear; its pending row
    // keeps the timer, now pending-only.
    h.script({ killError: undefined, readPaneError: undefined, spawnError: undefined })
    dueAt += waitMs(2)
    expect(await retryNow(h, key)).toBe(dueAt)
    expect(row.spawnedAt).toEqual([killedAt, dueAt])
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key), tmuxUnavailableAllClear(key)])
    expect(h.outageClears).toEqual([{ key, reading: UNAVAILABLE_RETRY_ROW_PENDING, result: 'deferred' }])
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', dueAt: dueAt + waitMs(3), refusals: 3, mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })

    // The persona connects: the next retry reads its row live and stops.
    h.setConnected(key, true)
    await retryNow(h, key)
    expect(retryLinesOf(h, key).at(-1)).toBe(pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting'))
    expectStopped(h, key)

    // Never counted, deleted or escalated; the condition never started.
    expect(getFailureCount(key)).toBe(0)
    expect(h.capReached).toEqual([])
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(conditionLines(h, key)).toEqual([])
    expect(h.episodeNotices).toEqual([])

    // Nothing latched: a later ErrTmuxNotAvailable is a new episode, with its
    // own onset and arm, and its own all-clear.
    h.script({ readPaneError: errTmuxNotAvailable(undefined, 'read-pane') })
    await expect(readPaneSucceeds(h, key)).rejects.toThrow()
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key), tmuxUnavailableAllClear(key), tmuxUnavailableOnset(key)])
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', dueAt: h.clock.now() + waitMs(0), refusals: 0, causes: [UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT] })
    tickClear(key)
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(key), tmuxUnavailableAllClear(key), tmuxUnavailableOnset(key), tmuxUnavailableAllClear(key)])
    expectStopped(h, key)
    expectUntouched(h, other)
  })

  test('ErrTmuxUnresponsive after the kill: the tmux-unresponsive condition, not the outage, with the retries on the backoff and nothing counted, deleted or launched while it lasts; each post at most once, and the timer stopped once the persona is up', async () => {
    const h = (harness = makeRecoveryHarness(RETRY_TIMER_ONLY))
    const [key, other] = h.keys as [string, string]
    const row = modelRow(h, 'ended')
    const kills = recordKills(h)

    h.script({ spawnError: errTmuxUnresponsive('spawn') })
    const killedAt = h.clock.now()
    expect(await runRestartRetry(key, personaOf(h, key).working_directory, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
    await h.settle()
    expect(kills).toEqual([killedAt])
    expect(row.spawnedAt).toEqual([killedAt])
    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)
    expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBe(killedAt)

    // Each retry's kill answers ErrTmuxUnresponsive while the server exits:
    // refused, no spawn. The retries run past the onset floor and one more,
    // so the onset is posted at the first retry at or past it, and only then.
    h.script({ killError: errTmuxUnresponsive('kill') })
    const onset = { key, text: tmuxUnresponsiveOnsetText(key) }
    let dueAt = killedAt
    let onsetAt: number | undefined
    for (let n = 0; onsetAt === undefined || dueAt === onsetAt; n++) {
      dueAt += waitMs(n)
      await h.advance(dueAt - 1 - h.clock.now())
      expect(h.attempts).toHaveLength(n)
      await retryNow(h, key)
      expect(h.attempts.at(-1)).toMatchObject({ key, retry: n + 1, mode: UNAVAILABLE_RETRY_MODE_FULL, at: dueAt })
      if (onsetAt === undefined && dueAt - killedAt >= TMUX_UNRESPONSIVE_ONSET_FLOOR_MS) onsetAt = dueAt
      expect([n, h.episodeNotices]).toEqual([n, onsetAt === undefined ? [] : [onset]])
    }
    const refused = h.attempts.length
    expect(row.spawnedAt).toEqual([killedAt])
    expect(h.tmuxUnresponsive.holds(key)).toBe(true)
    expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBe(killedAt)

    // tmux answers again: the retry's kill and spawn succeed; the spawn ends
    // the condition with its pending row (one recovery), keeping the timer.
    h.script({ killError: undefined, spawnError: undefined })
    dueAt += waitMs(refused)
    expect(await retryNow(h, key)).toBe(dueAt)
    expect(row.spawnedAt).toEqual([killedAt, dueAt])
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expect(h.conditionEnds).toEqual([{ key, reading: UNAVAILABLE_RETRY_ROW_PENDING, result: 'deferred' }])
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })

    h.setConnected(key, true)
    await retryNow(h, key)
    expectStopped(h, key)

    // One onset and one recovery, and never the outage's posts.
    expect(h.episodeNotices).toEqual([onset, { key, text: tmuxUnresponsiveRecoveryText(key) }])
    expect(h.outageNotices).toEqual([])
    expect(h.outageClears).toEqual([])
    expect(getFailureCount(key)).toBe(0)
    expect(h.capReached).toEqual([])
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(h.notices).toEqual([])
    expectUntouched(h, other)
  })
})

// ---------------------------------------------------------------------------
// CONFIG (`ErrConfigMalformed`, b.jg5 SRJ-316, SRJ-301, SRJ-305, AC 84) on the
// recovery harness, both settings 0, the arm hook bound as `main()` binds it:
// what arms the timer in a start-pass launch and outside every attempt, a
// trigger while armed, AC 84 end to end (a persona up and connected, and a
// launch that met CONFIG), and a clear of the outage that is not a timer
// stop. The `pending`-row and C21 halves of SRJ-316's Test line are later
// work; these cases assert no kill of any kind while calls answer CONFIG.
// ---------------------------------------------------------------------------

/** The `ad-config-malformed` class, typed against `OutageClass`. */
const AD_CONFIG_MALFORMED: OutageClass = 'ad-config-malformed'

/** The `ad-config-malformed` onset for the thrown CONFIG value `err`, as the outage state posts it. */
function configOnset(key: string, err: unknown): { key: string; text: string } {
  return { key, text: adConfigMalformedOnset(err) }
}

/** The single all-clear of a bad stretch that held only `ad-config-malformed`: the bare class. */
function configAllClear(key: string): { key: string; text: string } {
  return { key, text: ALL_CLEAR_TEMPLATE(new Map([[AD_CONFIG_MALFORMED, { detail: undefined }]])) }
}

/** The stub's error knob for every verb CSCB wraps but `status` (the row model answers it), each set to `err`. */
function everyVerbButStatusAnswers(err: Error | undefined): RecoveryStubScript {
  return {
    spawnError: err,
    resumeError: err,
    getError: err,
    listError: err,
    killError: err,
    deleteError: err,
    findMissingError: err,
    readPaneError: err,
    sendKeysError: err,
    pauseError: err,
    decideError: err,
    getPermissionError: err,
  }
}

/** agent-director refusing its config file on the harness stub. */
interface ConfigRefusal {
  /** The one CONFIG value every call answers. */
  readonly err: Error
  /** The persona rows behind it, read once the file is fixed. */
  readonly row: RowModel
  /** The file is fixed: every call answers, and `status` reads the modelled row. */
  fix(): void
}

/**
 * Every agent-director call, for every persona, answers CONFIG (one
 * `errConfigMalformed` value): `status` through the row model over `initial`,
 * every other wrapped verb through its error knob. `version` is never wrapped
 * and stays as it is.
 */
function refuseConfig(h: RecoveryHarness, initial: RowState | typeof UNAVAILABLE_RETRY_ROW_ABSENT): ConfigRefusal {
  const err = errConfigMalformed()
  let refusing = true
  const row = modelRow(h, initial, () => (refusing ? err : undefined))
  h.script(everyVerbButStatusAnswers(err))
  return {
    err,
    row,
    fix: () => {
      refusing = false
      h.script(everyVerbButStatusAnswers(undefined))
    },
  }
}

/**
 * A start-pass launch of persona `key` whose optimistic spawn answers `err`
 * (CONFIG): refused, one onset, P's timer armed at the base wait with the
 * CONFIG cause. Resolves with the arm's time.
 */
async function configLaunch(h: RecoveryHarness, key: string, err: Error): Promise<number> {
  const armedAt = h.clock.now()
  expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })
  expect(h.outageNotices).toEqual([configOnset(key, err)])
  expect(h.controller.view(key)).toEqual({
    phase: 'waiting',
    dueAt: armedAt + waitMs(0),
    waitMs: waitMs(0),
    refusals: 0,
    causes: [UNAVAILABLE_RETRY_CAUSE_CONFIG],
    mode: UNAVAILABLE_RETRY_MODE_FULL,
  })
  return armedAt
}

/**
 * No action was taken for persona `key` because of CONFIG: no kill or delete
 * call, nothing counted and no cap reached, no spawn-failure notice, no
 * startup entry, and no `tmux-unresponsive` condition or post.
 */
function expectNoActionTaken(h: RecoveryHarness, key: string): void {
  expect(h.stub.calls.killCalls).toEqual([])
  expect(h.stub.calls.deleteCalls).toEqual([])
  expect(getFailureCount(key)).toBe(0)
  expect(isAtCap(key, RESTART_FAILURE_CAP)).toBe(false)
  expect(h.capReached).toEqual([])
  expect(h.notices).toEqual([])
  expect(h.startupErrors()).toEqual([])
  expect(h.tmuxUnresponsive.holds(key)).toBe(false)
  expect(conditionLines(h, key)).toEqual([])
  expect(h.episodeNotices).toEqual([])
}

/**
 * Drive persona `key`'s `retries` retries from `armedAt` while every call
 * answers CONFIG: each fires exactly at its due time from the backoff, with
 * nothing run or called 1 ms before it; each makes its liveness `status` call
 * and nothing else, reads `unknown` and re-arms at the doubled wait, its
 * causes the CONFIG trigger and the arm hook's read error. Resolves with the
 * last retry's due time.
 */
async function retriesRefusedByConfig(h: RecoveryHarness, key: string, armedAt: number, retries: number): Promise<number> {
  let dueAt = armedAt
  for (let n = 0; n < retries; n++) {
    dueAt += waitMs(n)
    const before = callCounts(h)
    await h.advance(dueAt - 1 - h.clock.now())
    expect([n, h.attempts.length, callsSince(h, before)]).toEqual([n, n, {}])
    await h.advance(1)
    await h.settle()
    expect([n, h.attempts.at(-1)]).toEqual([n, expect.objectContaining({ key, retry: n + 1, mode: UNAVAILABLE_RETRY_MODE_FULL, at: dueAt })])
    expect([n, callsSince(h, before)]).toEqual([n, { statusCalls: 1 }])
    expect([n, retryLinesOf(h, key).at(-1)]).toEqual([n, reArmedLine(key, n + 1, UNAVAILABLE_RETRY_AGAIN_LIVENESS_UNKNOWN, n + 1)])
    expect([n, h.controller.view(key)]).toEqual([n, {
      phase: 'waiting',
      dueAt: dueAt + waitMs(n + 1),
      waitMs: waitMs(n + 1),
      refusals: n + 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_CONFIG, UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
      mode: UNAVAILABLE_RETRY_MODE_FULL,
    }])
  }
  return dueAt
}

describe('unavailable retry: CONFIG arms from any verb in any context, takes no action, is never counted, is retried only on the backoff, and its clear stops no timer (SRJ-316, SRJ-301, SRJ-305, AC 84)', () => {
  test('a start-pass launch whose spawn answers ErrConfigMalformed is refused and arms that persona’s timer once at the base wait with the CONFIG cause: one onset, the flag raised, no other call, nothing counted, no spawn-failure notice or spawn-failed entry; the other persona is untouched', async () => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    const err = errConfigMalformed()
    h.script({ spawnError: err })

    await configLaunch(h, key, err)

    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_CONFIG)
    expect(callCounts(h)).toEqual({ spawnCalls: 1 })
    expect([...getOutageFlags(key)]).toEqual([AD_CONFIG_MALFORMED])
    expect(adConfigMalformedRaiseLines(h, key)).toHaveLength(1)
    expectNoActionTaken(h, key)
    expectUntouched(h, other)
  })

  test.each<[string, (h: RecoveryHarness, key: string, err: Error) => Promise<void>, Record<string, number>]>([
    ['the health tick’s liveness read (status), which still reads unknown', async (h, key, err) => {
      h.script({ statusError: err })
      expect(await _buildIsSessionAliveAdapter(() => h.config)(key)).toEqual(LIVENESS_READING_UNKNOWN)
    }, { statusCalls: 1 }],
    ['a persona teardown’s kill', async (h, key, err) => {
      h.script({ killError: err })
      await expect(killPersonaInstance(key)).rejects.toBe(err)
    }, { killCalls: 1 }],
    ['a plain read-pane through the outage wrapper', async (h, key, err) => {
      h.script({ readPaneError: err })
      await expect(readPaneSucceeds(h, key)).rejects.toBe(err)
    }, { readPaneCalls: 1 }],
  ])('ErrConfigMalformed from %s, made outside every attempt, raises the outage and arms that persona’s timer once at the base wait with the CONFIG cause; the other persona is untouched', async (_site, run, calls) => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    const err = errConfigMalformed()
    expect(isInsideAttempt(key)).toBe(false)

    await run(h, key, err)

    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_CONFIG)
    expect(callCounts(h)).toEqual(calls)
    expect(h.outageNotices).toEqual([configOnset(key, err)])
    expect([...getOutageFlags(key)]).toEqual([AD_CONFIG_MALFORMED])
    expect(getFailureCount(key)).toBe(0)
    expectUntouched(h, other)
  })

  test('a CONFIG trigger while armed, midway and 1 ms before the due time, keeps the one due time and posts nothing more, and the retry fires at the arm plus the base wait', async () => {
    const h = (harness = makeRecoveryHarness({ action: 'scripted' }))
    const [key, other] = h.keys as [string, string]
    const err = errConfigMalformed()
    h.script({ spawnError: err, readPaneError: err, statusError: err })
    const dueAt = (await configLaunch(h, key, err)) + waitMs(0)

    await h.advance(waitMs(0) / 2)
    await expect(readPaneSucceeds(h, key)).rejects.toBe(err)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([dueAt])

    await h.advance(dueAt - 1 - h.clock.now())
    expect(await _buildIsSessionAliveAdapter(() => h.config)(key)).toEqual(LIVENESS_READING_UNKNOWN)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([dueAt])
    expect(h.triggers).toEqual([1, 2, 3].map(() => ({ key, kind: UNAVAILABLE_RETRY_CAUSE_CONFIG })))
    expect(h.outageNotices).toEqual([configOnset(key, err)])
    expect(adConfigMalformedRaiseLines(h, key)).toHaveLength(1)
    expect(h.attempts).toEqual([])

    await h.advance(1)
    expect(h.attempts).toEqual([{ key, retry: 1, causes: [UNAVAILABLE_RETRY_CAUSE_CONFIG], mode: UNAVAILABLE_RETRY_MODE_FULL, at: dueAt }])
    expectUntouched(h, other)
  })

  test('AC 84, a persona up: with both settings 0, P up and connected with its stream, then every call answering ErrConfigMalformed, gives exactly one onset across retries past the restart cap, each only at its due time from the backoff; no kill, delete, spawn or resume, nothing counted, no other post; once agent-director reads its config again, the next retry finds P live and connected, the status success clears the outage with one all-clear, and the timer stops', async () => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    const config = refuseConfig(h, 'waiting')
    h.setConnected(key, true)

    // A health tick's liveness read meets it first, outside every attempt.
    const armedAt = h.clock.now()
    expect(await _buildIsSessionAliveAdapter(() => h.config)(key)).toEqual(LIVENESS_READING_UNKNOWN)
    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_CONFIG)

    const retries = RESTART_FAILURE_CAP + 2
    let dueAt = await retriesRefusedByConfig(h, key, armedAt, retries)

    expect(h.outageNotices).toEqual([configOnset(key, config.err)])
    expect(adConfigMalformedRaiseLines(h, key)).toHaveLength(1)
    expect(h.triggers.every((t) => t.key === key && t.kind === UNAVAILABLE_RETRY_CAUSE_CONFIG)).toBe(true)
    expect(h.stub.calls.spawnCalls).toEqual([])
    expect(h.stub.calls.resumeCalls).toEqual([])
    expectNoActionTaken(h, key)
    expectUntouched(h, other)

    config.fix()
    dueAt += waitMs(retries)
    const before = callCounts(h)
    expect(await retryNow(h, key)).toBe(dueAt)

    expect(callsSince(h, before)).toEqual({ statusCalls: 1 })
    expect(h.outageNotices).toEqual([configOnset(key, config.err), configAllClear(key)])
    expect(getOutageFlags(key).size).toBe(0)
    // The clear of this class never reaches the condition-end entry.
    expect(h.outageClears).toEqual([])
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_RECOVERED))
    expectStopped(h, key)
    expect(h.stub.calls.spawnCalls).toEqual([])
    expect(h.stub.calls.resumeCalls).toEqual([])
    expectNoActionTaken(h, key)
    expectUntouched(h, other)
  })

  test('AC 84, a launch that met it: with both settings 0, a start-pass launch whose spawn answers ErrConfigMalformed, with every later call answering it too, gives one onset and no kill, delete, spawn or resume but that launch across retries past the restart cap, nothing counted; once agent-director reads its config again, the next retry brings P up with one all-clear listing the class, and the timer stops only at the retry that finds nothing left to recover', async () => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    const config = refuseConfig(h, 'missing')
    const armedAt = await configLaunch(h, key, config.err)
    expect(config.row.spawnedAt).toEqual([armedAt])

    const retries = RESTART_FAILURE_CAP + 2
    let dueAt = await retriesRefusedByConfig(h, key, armedAt, retries)

    expect(config.row.spawnedAt).toEqual([armedAt])
    expect(h.stub.calls.spawnCalls).toHaveLength(1)
    expect(h.stub.calls.resumeCalls).toEqual([])
    expect(h.outageNotices).toEqual([configOnset(key, config.err)])
    expect(adConfigMalformedRaiseLines(h, key)).toHaveLength(1)
    expectNoActionTaken(h, key)
    expectUntouched(h, other)

    // The file is fixed: the next retry reads the row missing (the status
    // success clears the outage), and the restart path kills and launches.
    config.fix()
    dueAt += waitMs(retries)
    const before = callCounts(h)
    expect(await retryNow(h, key)).toBe(dueAt)

    expect(callsSince(h, before)).toEqual({ statusCalls: 2, killCalls: 1, spawnCalls: 1 })
    expect(config.row.spawnedAt).toEqual([armedAt, dueAt])
    expect(h.outageNotices).toEqual([configOnset(key, config.err), configAllClear(key)])
    expect(getOutageFlags(key).size).toBe(0)
    expect(h.outageClears).toEqual([])
    // The launch's pending row keeps the timer, now pending-only.
    expect(retryLinesOf(h, key).at(-1)).toBe(reArmedLine(key, retries + 1, UNAVAILABLE_RETRY_AGAIN_LAUNCHED, retries + 1, { switchedTo: UNAVAILABLE_RETRY_MODE_PENDING_ONLY }))
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })

    // The next retry reads the row live: nothing left to recover.
    const launched = callCounts(h)
    await retryNow(h, key)
    expect(callsSince(h, launched)).toEqual({ statusCalls: 1 })
    expect(retryLinesOf(h, key).at(-1)).toBe(pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_ROW_LIVE, 'waiting'))
    expectStopped(h, key)
    expect(h.outageNotices).toHaveLength(2)
    expect(getFailureCount(key)).toBe(0)
    expect(h.capReached).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.startupErrors()).toEqual([])
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(h.stub.calls.resumeCalls).toEqual([])
    expectUntouched(h, other)
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>]>([
    ['a successful read-pane through the outage wrapper', async (h, key) => {
      h.script({ readPaneError: undefined })
      await readPaneSucceeds(h, key)
    }],
    ['the liveness read’s successful status', async (h, key) => {
      h.script({ statusError: undefined, statusResult: cannedStatusResult({ state: 'waiting' }) })
      await _buildIsSessionAliveAdapter(() => h.config)(key)
    }],
    ['the liveness read’s status answering ErrSpawnNotFound', async (h, key) => {
      h.script({ statusError: errSpawnNotFound() })
      await _buildIsSessionAliveAdapter(() => h.config)(key)
    }],
  ])('a clear is not a stop: %s clears the outage with one all-clear and leaves the timer armed with its due time, and the next retry still runs at it', async (_what, clear) => {
    const h = (harness = makeRecoveryHarness({ action: 'scripted' }))
    const [key] = h.keys as [string]
    const err = errConfigMalformed()
    h.script({ spawnError: err, readPaneError: err, statusError: err })
    await configLaunch(h, key, err)
    await h.advance(waitMs(0) / 2)
    const before = h.controller.view(key)!
    const retryLines = retryLinesOf(h, key)

    await clear(h, key)

    expect(h.outageNotices).toEqual([configOnset(key, err), configAllClear(key)])
    expect(getOutageFlags(key).size).toBe(0)
    expect(h.outageClears).toEqual([])
    expect(retryLinesOf(h, key)).toEqual(retryLines)
    expect(h.controller.view(key)).toEqual(before)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([before.dueAt!])

    await h.advance(before.dueAt! - 1 - h.clock.now())
    expect(h.attempts).toEqual([])
    await h.advance(1)
    expect(h.attempts).toEqual([{ key, retry: 1, causes: [UNAVAILABLE_RETRY_CAUSE_CONFIG], mode: UNAVAILABLE_RETRY_MODE_FULL, at: before.dueAt! }])
  })
})

// ---------------------------------------------------------------------------
// UNCLASSIFIED outcomes (b.jg5 SRJ-313, SRJ-1009, SRJ-105, SRJ-301, AC 69,
// AC 80) on the recovery harness, both settings 0, with the unclassified-error
// episodes composed as `main()` composes them: never destructive, never
// counted, retried on the backoff, one alert per episode at the first
// UNCLASSIFIED outcome met strictly past the alert threshold in effect, the
// log-only route for a persona no longer configured, and the episode's ends.
// The reuse spawn half is E22's and the latch end E13's.
// ---------------------------------------------------------------------------

/** AC 80's agent-director settings (the AC's input): an alert threshold below the defaults'. */
const AC_80_TMUX = { stopping_window_seconds: 30n, starting_session_seconds: 120n } as const satisfies AdConfigTables['tmux']

/** UNCLASSIFIED values (b.jg5 SRJ-104), each built by the stub for the verb whose call meets it. */
const UNCLASSIFIED_ERRORS: ReadonlyArray<readonly [string, (verb: string) => Error]> = [
  ['ErrInternal without the unusable-name phrase', () => errInternal()],
  ['an error name CSCB gives no handling', (verb) => errGeneric(verb, 'ErrKillBroken', 'the kill is broken')],
  ['ErrSchemaMismatch (a store that cannot be opened)', () => errSchemaMismatch()],
]

/** The alert for persona `key` quoting the outcome `err`, as the notice episodes post it. */
function unclassifiedAlert(key: string, err: unknown): { key: string; text: string } {
  return { key, text: unclassifiedErrorAlertText(classifyAdError(err)) }
}

/**
 * The retry of a timer armed at `armedAt`, its first outcome then, that is
 * the first strictly more than `thresholdMs` after it: its number and due
 * time, from the exported base and ceiling.
 */
function alertRetry(armedAt: number, thresholdMs: number): { retry: number; dueAt: number } {
  let dueAt = armedAt
  for (let n = 0; ; n++) {
    dueAt += waitMs(n)
    if (dueAt - armedAt > thresholdMs) return { retry: n + 1, dueAt }
  }
}

/**
 * A start-pass launch of persona `key` whose optimistic spawn answers the
 * UNCLASSIFIED `err` (the stub keeps answering it): refused, P's timer armed
 * at the base wait with the UNCLASSIFIED cause, and an episode begun with
 * one started line. Resolves with the arm's time.
 */
async function unclassifiedLaunch(h: RecoveryHarness, key: string, err: Error): Promise<number> {
  h.script({ spawnError: err })
  const armedAt = h.clock.now()
  expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })
  expect(h.controller.view(key)).toEqual({
    phase: 'waiting',
    dueAt: armedAt + waitMs(0),
    waitMs: waitMs(0),
    refusals: 0,
    causes: [UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED],
    mode: UNAVAILABLE_RETRY_MODE_FULL,
  })
  expect(h.unclassifiedErrorOpen(key)).toBe(true)
  expect(unclassifiedLines(h, key).at(-1)).toBe(unclassifiedStartedLine(key, err))
  return armedAt
}

/**
 * Nothing destructive or counted for persona `key`: no delete, no failure
 * counted and no cap reached, no spawn-failure notice or startup entry, and
 * no outage or `tmux-unresponsive` condition or post.
 */
function expectNeverDestructive(h: RecoveryHarness, key: string): void {
  expect(h.stub.calls.deleteCalls).toEqual([])
  expect(getFailureCount(key)).toBe(0)
  expect(isAtCap(key, RESTART_FAILURE_CAP)).toBe(false)
  expect(h.capReached).toEqual([])
  expect(h.notices).toEqual([])
  expect(h.startupErrors()).toEqual([])
  expect(h.outageNotices).toEqual([])
  expect(getOutageFlags(key).size).toBe(0)
  expect(h.tmuxUnresponsive.holds(key)).toBe(false)
  expect(conditionLines(h, key)).toEqual([])
}

/** Persona `other` was untouched, its unclassified-error episode included. */
function expectUntouchedEpisode(h: RecoveryHarness, other: string): void {
  expectUntouched(h, other)
  expect(h.unclassifiedErrorOpen(other)).toBe(false)
  expect(unclassifiedLines(h, other)).toEqual([])
  expect(h.episodeNotices.filter((n) => n.key === other)).toEqual([])
  expect(h.stops.filter((s) => s.key === other)).toEqual([])
}

/** One kind of attempt that meets an UNCLASSIFIED outcome, and what each of its retries calls. */
interface UnclassifiedAttempt {
  /** The verb whose call answers it. */
  readonly verb: string
  /** The persona's row before any spawn. */
  readonly row: RowState | typeof UNAVAILABLE_RETRY_ROW_ABSENT
  /** The stub's answer of that verb. */
  readonly script: (err: Error) => RecoveryStubScript
  /** Run the first attempt for persona `key`; it meets the outcome and is refused. */
  readonly run: (h: RecoveryHarness, key: string) => Promise<void>
  /** The calls the first attempt makes, ending at the refused one. */
  readonly firstCalls: Record<string, number>
  /** The calls each retry makes, ending at the refused one. */
  readonly retryCalls: Record<string, number>
}

const UNCLASSIFIED_ATTEMPTS: ReadonlyArray<readonly [string, UnclassifiedAttempt]> = [
  ['a start-pass launch (its optimistic spawn)', {
    verb: 'spawn',
    row: UNAVAILABLE_RETRY_ROW_ABSENT,
    script: (err) => ({ spawnError: err }),
    run: async (h, key) => {
      expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })
    },
    firstCalls: { spawnCalls: 1 },
    // The dead reading's kill comes before the relaunch; the refused spawn is the retry's last call.
    retryCalls: { statusCalls: 1, killCalls: 1, spawnCalls: 1 },
  }],
  ['a restart-run recovery (its kill of an ended row)', {
    verb: 'kill',
    row: 'ended',
    script: (err) => ({ killError: err }),
    run: async (h, key) => {
      expect(await runRestartRetry(key, personaOf(h, key).working_directory, isLaunchInFlight)).toBe(RESTART_OUTCOME_REFUSED)
      await h.settle()
    },
    firstCalls: { statusCalls: 1, killCalls: 1 },
    // The refused kill ends each retry: no launch follows it.
    retryCalls: { statusCalls: 1, killCalls: 1 },
  }],
]

describe('unavailable retry: UNCLASSIFIED outcomes are never destructive or counted, are retried, and post one alert per episode past the threshold (SRJ-313, SRJ-1009, AC 69, AC 80)', () => {
  test('SRJ-1009: the one pin case, the alert’s exact text for a sample name and message', () => {
    const text = unclassifiedErrorAlertText({ reportedName: 'ErrInternal', message: 'the store could not be read' })

    expect(text).toBe(
      ':warning: *Unclassified agent-director error* — agent-director returned an error CSCB cannot classify for this persona: ErrInternal "the store could not be read". CSCB keeps retrying and takes no destructive action; a human should check the host\'s agent-director.',
    )
    assertNoLeak(text)
  })

  const neverDestructiveCross = UNCLASSIFIED_ERRORS.flatMap(([what, make]) =>
    UNCLASSIFIED_ATTEMPTS.map(([where, attempt]) => [what, where, make, attempt] as const),
  )

  test.each(neverDestructiveCross)('%s in %s, with both settings 0: no delete, no kill or launch outside a retry and no call after it in any attempt, never counted past the restart cap, no spawn-failure notice, spawn-failed entry or condition post; the timer armed with the UNCLASSIFIED cause and each retry exactly at its due time from the backoff; the other persona untouched', async (_what, _where, make, attempt) => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    const err = make(attempt.verb)
    modelRow(h, attempt.row)
    h.script(attempt.script(err))
    const armedAt = h.clock.now()

    await attempt.run(h, key)

    expect(callCounts(h)).toEqual(attempt.firstCalls)
    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED)
    expect(h.unclassifiedErrorOpen(key)).toBe(true)
    expect(unclassifiedLines(h, key)).toEqual([unclassifiedStartedLine(key, err)])

    let dueAt = armedAt
    const retries = RESTART_FAILURE_CAP + 2
    for (let n = 0; n < retries; n++) {
      dueAt += waitMs(n)
      const before = callCounts(h)
      await h.advance(dueAt - 1 - h.clock.now())
      expect([n, h.attempts.length, callsSince(h, before)]).toEqual([n, n, {}])
      await h.advance(1)
      await h.settle()
      expect([n, h.attempts.at(-1)]).toEqual([n, expect.objectContaining({ key, retry: n + 1, mode: UNAVAILABLE_RETRY_MODE_FULL, at: dueAt })])
      expect([n, callsSince(h, before)]).toEqual([n, attempt.retryCalls])
      expect([n, h.controller.view(key)]).toEqual([n, {
        phase: 'waiting',
        dueAt: dueAt + waitMs(n + 1),
        waitMs: waitMs(n + 1),
        refusals: n + 1,
        causes: [UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED],
        mode: UNAVAILABLE_RETRY_MODE_FULL,
      }])
    }

    expect(h.triggers).toEqual(Array.from({ length: retries + 1 }, () => ({ key, kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED })))
    expectNeverDestructive(h, key)
    // The episode lasts through every retry and posts its one alert.
    expect(h.unclassifiedErrorOpen(key)).toBe(true)
    expect(h.episodeNotices).toEqual([unclassifiedAlert(key, err)])
    expectUntouchedEpisode(h, other)
  })

  test.each<[string, RecoveryHarnessOptions, () => number]>([
    ['agent-director’s defaults', {}, () => adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT)],
    ['AC 80’s settings, in effect before the first outcome', { adSettings: { tmux: AC_80_TMUX } }, () => adAlertThresholdMs({ ...DEFAULT_AD_SETTINGS_IN_EFFECT, tmux: { ...DEFAULT_AD_SETTINGS_IN_EFFECT.tmux, ...AC_80_TMUX } })],
  ])('the alert at %s: none at any retry up to the threshold; exactly one, quoting the redacted and capped message, at the first retry strictly past the accessor’s threshold; none again however far the clock goes while the retries go on', async (_settings, options, expectedThreshold) => {
    const h = (harness = makeRecoveryHarness(options))
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    const thresholdMs = adAlertThresholdMsInEffect()
    expect(thresholdMs).toBe(expectedThreshold())
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const description = `the store could not be read (${sentinelInMessage('unclassified')}) ${'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH)}`
    const err = errInternal(description)
    const armedAt = await unclassifiedLaunch(h, key, err)
    const alert = alertRetry(armedAt, thresholdMs)

    let dueAt = armedAt
    for (let n = 0; n < alert.retry - 1; n++) {
      dueAt += waitMs(n)
      expect(await retryNow(h, key)).toBe(dueAt)
      expect([n, dueAt - armedAt <= thresholdMs, h.episodeNotices]).toEqual([n, true, []])
    }
    expect(await retryNow(h, key)).toBe(alert.dueAt)

    expect(h.episodeNotices).toEqual([unclassifiedAlert(key, err)])
    const quoted = classifyAdError(err).message!
    expect(quoted).toContain(REDACTED_SENTINEL_TAIL)
    expect(quoted.length).toBeLessThanOrEqual(MAX_LOGGED_MESSAGE_LENGTH)
    expect(description.length).toBeGreaterThan(MAX_LOGGED_MESSAGE_LENGTH)
    expect(unclassifiedLines(h, key)).toEqual([
      unclassifiedStartedLine(key, err),
      unclassifiedPostedLine(key, alert.dueAt - armedAt, thresholdMs, err),
    ])

    const attempts = h.attempts.length
    for (let n = 0; n < RESTART_FAILURE_CAP; n++) await retryNow(h, key)
    expect(h.attempts).toHaveLength(attempts + RESTART_FAILURE_CAP)
    expect(h.controller.isArmed(key)).toBe(true)
    expect(h.unclassifiedErrorOpen(key)).toBe(true)
    expect(h.episodeNotices).toEqual([unclassifiedAlert(key, err)])
    expect(unclassifiedLines(h, key)).toHaveLength(2)
    expectNeverDestructive(h, key)
    expectUntouchedEpisode(h, other)
  })

  test('an UNCLASSIFIED answer to the collision get inside a launch opens the episode and arms with the read-error cause; one inside a later launch before the threshold continues it with no new line or alert', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    const persona = personaOf(h, key)
    const err = errInternal()
    h.script({ ...collided(h, persona, { state: 'waiting' }), getError: err })

    expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })
    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_READ_ERROR)
    expect(callCounts(h)).toEqual({ spawnCalls: 1, getCalls: 1 })
    expect(h.unclassifiedErrorOpen(key)).toBe(true)
    expect(unclassifiedLines(h, key)).toEqual([unclassifiedStartedLine(key, err)])

    await h.advance(waitMs(0) - 1)
    h.script({ ...collided(h, persona, { state: 'waiting' }), getError: err })
    expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })

    expect(callCounts(h)).toEqual({ spawnCalls: 2, getCalls: 2 })
    expect(h.unclassifiedErrorOpen(key)).toBe(true)
    expect(unclassifiedLines(h, key)).toEqual([unclassifiedStartedLine(key, err)])
    expect(h.episodeNotices).toEqual([])
    expectNeverDestructive(h, key)
    expectUntouchedEpisode(h, other)
  })

  test('ErrSchemaMismatch from every row read (SRJ-303, A-32), both settings 0: the retries read the row and call nothing else, nothing is counted past the restart cap, and the one alert past the threshold names ErrSchemaMismatch and quotes its description', async () => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    const err = errSchemaMismatch()
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT, () => err)
    const armedAt = await unclassifiedLaunch(h, key, err)
    const thresholdMs = adAlertThresholdMsInEffect()
    const alert = alertRetry(armedAt, thresholdMs)
    const retries = Math.max(alert.retry, RESTART_FAILURE_CAP) + 1

    let dueAt = armedAt
    for (let n = 0; n < retries; n++) {
      dueAt += waitMs(n)
      const before = callCounts(h)
      expect(await retryNow(h, key)).toBe(dueAt)
      expect([n, callsSince(h, before)]).toEqual([n, { statusCalls: 1 }])
      expect([n, retryLinesOf(h, key).at(-1)]).toEqual([n, reArmedLine(key, n + 1, UNAVAILABLE_RETRY_AGAIN_LIVENESS_UNKNOWN, n + 1)])
      expect([n, h.episodeNotices.length]).toEqual([n, n + 1 < alert.retry ? 0 : 1])
    }

    expect(h.stub.calls.spawnCalls).toHaveLength(1)
    expect(h.stub.calls.killCalls).toEqual([])
    expect(h.episodeNotices).toEqual([unclassifiedAlert(key, err)])
    expect(h.episodeNotices[0]!.text).toContain(`${ERR_SCHEMA_MISMATCH_NAME} "${classifyAdError(err).message}"`)
    expect(unclassifiedLines(h, key)).toEqual([
      unclassifiedStartedLine(key, err),
      unclassifiedPostedLine(key, alert.dueAt - armedAt, thresholdMs, err),
    ])
    expectNeverDestructive(h, key)
    expectUntouchedEpisode(h, other)
  })

  test('AC 69, a persona no longer configured: P’s retry spawn held past the threshold, P removed from the applied configuration without a teardown, then the spawn failing ErrInternal, gives one server-log line and one persona-unclassified-error entry naming P and the alert’s text, and nothing to Slack for any persona; the removal’s stop leaves the episode open with no second entry', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const armedAt = await unclassifiedLaunch(h, key, errInternal())
    const thresholdMs = adAlertThresholdMsInEffect()
    const alert = alertRetry(armedAt, thresholdMs)
    for (let n = 0; n < alert.retry - 1; n++) await retryNow(h, key)
    expect(h.episodeNotices).toEqual([])

    const id = personaInstanceId(key)
    const hold = holdSpawns(h.stub.client)
    expect(await retryNow(h, key, { settle: false })).toBe(alert.dueAt)
    await hold.entered(id)
    h.remove(key)
    const err = errInternal(`the store could not be read (${sentinelInMessage('removed')})`)
    hold.fail(id, err)
    await h.settle()

    expect(h.episodeNotices).toEqual([])
    expect(h.notices).toEqual([])
    expect(h.outageNotices).toEqual([])
    const entries = h.startupErrors()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.endsWith(`] [${PERSONA_UNCLASSIFIED_ERROR_LABEL}] persona=${key}: ${unclassifiedErrorAlertText(classifyAdError(err), { escapeForSlack: false })}`)).toBe(true)
    expect(unclassifiedLines(h, key).at(-1)).toBe(unclassifiedLoggedLine(key, alert.dueAt - armedAt, thresholdMs, err))
    expect(unclassifiedLines(h, key).filter((line) => line.includes(' alert '))).toHaveLength(1)
    assertNoLeak([entries, h.lines])

    await retryNow(h, key)
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_NOT_APPLIED))
    expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_NOT_APPLIED }])
    expect(h.unclassifiedErrorOpen(key)).toBe(true)
    expect(h.startupErrors()).toHaveLength(1)
    expect(h.episodeNotices).toEqual([])
    expectUntouchedEpisode(h, other)
  })
})

describe('unavailable retry: the unclassified-error episode’s ends and the stop observer (SRJ-313, SRJ-305)', () => {
  test('a retry that finds nothing left to recover ends the episode silently after its alert; a later UNCLASSIFIED outcome begins a new episode that alerts again only past the threshold from its own first outcome', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    const row = modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const err = errInternal()
    const thresholdMs = adAlertThresholdMsInEffect()
    const firstAt = await unclassifiedLaunch(h, key, err)
    const first = alertRetry(firstAt, thresholdMs)
    for (let n = 0; n < first.retry; n++) await retryNow(h, key)
    expect(h.episodeNotices).toEqual([unclassifiedAlert(key, err)])

    // P came back on its own: its row reads live and it is connected.
    row.set('waiting')
    h.setConnected(key, true)
    await retryNow(h, key)

    expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_RECOVERED }])
    expect(h.unclassifiedErrorOpen(key)).toBe(false)
    expect(unclassifiedLines(h, key).at(-1)).toBe(unclassifiedEndedLine(key, UNCLASSIFIED_ERROR_END_RECOVERED))
    expect(h.episodeNotices).toEqual([unclassifiedAlert(key, err)])

    // P is lost again, and its next launch meets UNCLASSIFIED once more.
    h.setConnected(key, false)
    row.set('missing')
    const secondAt = await unclassifiedLaunch(h, key, err)
    const second = alertRetry(secondAt, thresholdMs)
    for (let n = 0; n < second.retry - 1; n++) await retryNow(h, key)
    expect(h.episodeNotices).toHaveLength(1)
    expect(await retryNow(h, key)).toBe(second.dueAt)

    expect(h.episodeNotices).toEqual([unclassifiedAlert(key, err), unclassifiedAlert(key, err)])
    expect(unclassifiedLines(h, key).slice(-2)).toEqual([
      unclassifiedStartedLine(key, err),
      unclassifiedPostedLine(key, second.dueAt - secondAt, thresholdMs, err),
    ])
    expectNeverDestructive(h, key)
    expectUntouchedEpisode(h, other)
  })

  test('a pending-only retry that reads the row live out of pending ends the episode silently, before any alert', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const err = errInternal()
    await unclassifiedLaunch(h, key, err)

    // The next retry's launch succeeds: the timer goes on pending-only, the episode still open.
    h.script({ spawnError: undefined })
    await retryNow(h, key)
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY })
    expect(h.unclassifiedErrorOpen(key)).toBe(true)

    await retryNow(h, key)

    expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_ROW_LIVE }])
    expect(h.unclassifiedErrorOpen(key)).toBe(false)
    expect(unclassifiedLines(h, key)).toEqual([unclassifiedStartedLine(key, err), unclassifiedEndedLine(key, UNCLASSIFIED_ERROR_END_ROW_LIVE)])
    expect(h.episodeNotices).toEqual([])
    expectUntouchedEpisode(h, other)
  })

  test('counted LAUNCH FAILUREs at the retries reaching the restart cap end the episode silently through onCapReached, with no unclassified alert', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const err = errInternal()
    await unclassifiedLaunch(h, key, err)

    h.script({ spawnError: errTmuxSessionCreate('spawn') })
    for (let n = 0; n < RESTART_FAILURE_CAP; n++) await retryNow(h, key)

    expect(getFailureCount(key)).toBe(RESTART_FAILURE_CAP)
    expect(h.capReached).toEqual([key])
    expect(h.unclassifiedErrorOpen(key)).toBe(false)
    expect(unclassifiedLines(h, key)).toEqual([unclassifiedStartedLine(key, err), unclassifiedEndedLine(key, UNCLASSIFIED_ERROR_END_CAPPED)])
    expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_CAPPED }])
    expectStopped(h, key)
    expect(h.episodeNotices).toEqual([])
    expectUntouchedEpisode(h, other)
  })

  test('the teardown (its submit, then its turn’s forget) ends the episode with no line, and no alert comes however far the clock goes', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const err = errInternal()
    await unclassifiedLaunch(h, key, err)

    h.teardown(key)
    expect(h.unclassifiedErrorOpen(key)).toBe(true)
    h.episodes.forget(key)

    expect(h.unclassifiedErrorOpen(key)).toBe(false)
    expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_TORN_DOWN }])
    await h.advance(2 * adAlertThresholdMsInEffect())
    expect(h.attempts).toEqual([])
    expect(unclassifiedLines(h, key)).toEqual([unclassifiedStartedLine(key, err)])
    expect(h.episodeNotices).toEqual([])
    expectUntouchedEpisode(h, other)
  })

  test.each<[string, (h: RecoveryHarness, key: string, row: RowModel) => Promise<void>, string, boolean]>([
    ['a retry that finds nothing left to recover', async (h, key, row) => {
      row.set('waiting')
      h.setConnected(key, true)
      await retryNow(h, key)
    }, UNAVAILABLE_RETRY_STOP_RECOVERED, false],
    // A read-pane outside every attempt raises tmux-unavailable; the health
    // tick's healthy-branch clear then ends the condition and stops the timer.
    ['the tmux-unavailable condition clearing', async (h, key) => {
      h.script({ readPaneError: errTmuxNotAvailable(undefined, 'read-pane') })
      await expect(readPaneSucceeds(h, key)).rejects.toThrow()
      expect([...getOutageFlags(key)]).toEqual(['tmux-unavailable'])
      tickClear(key)
    }, UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED, false],
    // The cap's end of the episode is onCapReached's (the case above); the stop alone leaves it.
    ['the restart cap', async (h, key) => {
      for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(key)
      await retryNow(h, key)
    }, UNAVAILABLE_RETRY_STOP_CAPPED, true],
    ['the persona not up', async (h, key) => {
      h.setUp(key, false)
      await retryNow(h, key)
    }, UNAVAILABLE_RETRY_STOP_NOT_UP, true],
    // The teardown's forget is its turn's step, after the stop.
    ['a teardown’s submit', async (h, key) => h.teardown(key), UNAVAILABLE_RETRY_STOP_TORN_DOWN, true],
    ['a removal from the applied configuration', async (h, key) => {
      h.remove(key)
      await retryNow(h, key)
    }, UNAVAILABLE_RETRY_STOP_NOT_APPLIED, true],
    // Shutdown then closes the episodes.
    ['shutdown', async (h) => h.shutdown(), UNAVAILABLE_RETRY_STOP_SHUTDOWN, false],
  ])('the stop observer fires once for %s, with its reason; only the reasons that end the episode close it, silently', async (_what, stop, reason, openAfter) => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    const row = modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const err = errInternal()
    await unclassifiedLaunch(h, key, err)

    await stop(h, key, row)

    expect(h.stops).toEqual([{ key, reason }])
    expectStopped(h, key)
    expect(h.unclassifiedErrorOpen(key)).toBe(openAfter)
    const endedBy: Record<string, UnclassifiedErrorEndReason> = {
      [UNAVAILABLE_RETRY_STOP_RECOVERED]: UNCLASSIFIED_ERROR_END_RECOVERED,
      [UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED]: UNCLASSIFIED_ERROR_END_CONDITION_ENDED,
    }
    const ended = endedBy[reason] !== undefined ? [unclassifiedEndedLine(key, endedBy[reason])] : []
    expect(unclassifiedLines(h, key)).toEqual([unclassifiedStartedLine(key, err), ...ended])
    expect(h.episodeNotices).toEqual([])
    expectUntouchedEpisode(h, other)
  })

  test.each<[string, (h: RecoveryHarness, key: string, err: Error) => Promise<void>, Record<string, number>]>([
    ['the health tick’s liveness read (status), which reads unknown', async (h, key, err) => {
      h.script({ statusError: err })
      expect(await _buildIsSessionAliveAdapter(() => h.config)(key)).toEqual(LIVENESS_READING_UNKNOWN)
    }, { statusCalls: 1 }],
    ['a persona teardown’s kill', async (h, key, err) => {
      h.script({ killError: err })
      await expect(killPersonaInstance(key)).rejects.toBe(err)
    }, { killCalls: 1 }],
    ['a plain read-pane through the outage wrapper', async (h, key, err) => {
      h.script({ readPaneError: err })
      await expect(readPaneSucceeds(h, key)).rejects.toBe(err)
    }, { readPaneCalls: 1 }],
  ])('an UNCLASSIFIED answer to %s, made outside every attempt, arms nothing and opens no episode', async (_site, run, calls) => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    expect(isInsideAttempt(key)).toBe(false)

    await run(h, key, errInternal())

    expect(callCounts(h)).toEqual(calls)
    expectNothingArmed(h)
    expect(h.unclassifiedErrorOpen(key)).toBe(false)
    expect(unclassifiedLines(h, key)).toEqual([])
    expect(h.episodeNotices).toEqual([])
    expect(getFailureCount(key)).toBe(0)
    expectUntouchedEpisode(h, other)
  })
})

// ---------------------------------------------------------------------------
// The latch's holds on the timer and the unclassified-error episode (b.jg5
// SRJ-305, SRJ-313, SRJ-502), on the recovery harness with both settings 0:
// the latch composed as `main()` composes it (the holds, then the notice)
// ---------------------------------------------------------------------------

/**
 * Persona `key` latched once, at a plain spawn, on `err`, recording
 * `rowState`; on that set the three holds ran, in order, before its one
 * CONFLICT notice; it is not armed, and nothing failed or was counted: no
 * spawn-failure notice, no startup-errors entry, no failure, no cap.
 */
function expectLatchedOnce(h: RecoveryHarness, key: string, err: ReturnType<typeof conflictForPersona>, rowState: LatchRowState): void {
  expect(h.latch.isLatched(key)).toBe(true)
  expect(h.latch.record(key)).toMatchObject({
    sessionName: personaTmuxSessionName(key),
    latchCase: LATCH_CASE_LEFTOVER,
    refusedOperation: REFUSED_OPERATION_PLAIN_SPAWN,
    rowState,
  })
  const steps = h.latchEvents.filter((event) => event.key === key).map((event) =>
    event.step === 'set' ? [event.step, event.outcome] : event.step === 'hold' ? [event.step, event.hold] : [event.step, event.text])
  expect(steps).toEqual([
    ['set', CONFLICT_LATCH_SET_LATCHED],
    ['hold', 'retry timer stop'],
    ['hold', 'tmux-unresponsive end'],
    ['hold', 'unclassified-error end'],
    ['notice', conflictNoticeForPersona(key, err).text],
  ])
  expect(h.episodeNotices.filter((notice) => notice.key === key)).toEqual([conflictNoticeForPersona(key, err)])
  expect(h.controller.isArmed(key)).toBe(false)
  expect(h.notices).toEqual([])
  expect(h.startupErrors()).toEqual([])
  expect(getFailureCount(key)).toBe(0)
  expect(h.capReached).toEqual([])
}

/** How a case arms persona `key`'s timer before the latch: full mode with a cause, or pending-only. */
const ARMED_MODES: ReadonlyArray<readonly [string, (h: RecoveryHarness, key: string) => void]> = [
  ['in full mode (an UNAVAILABLE cause)', (h, key) => { h.controller.arm(key, UNAVAILABLE) }],
  // SRJ-306's exceptions keep such a timer through a condition end; never through a latch.
  ['in full mode (the kill-failure cause)', (h, key) => { h.controller.arm(key, { kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED }) }],
  ['in pending-only mode', (h, key) => { h.controller.armPendingOnly(key) }],
]

describe('unavailable retry: a latch stops the timer and ends the unclassified-error episode (SRJ-305, SRJ-313, SRJ-502)', () => {
  test('a retry whose launch answers CONFLICT latches P and stops its timer with the latch’s reason, nothing pending for P; past several backoff waits nothing fires or is called for P, and the other persona’s timer keeps its schedule', async () => {
    const h = (harness = makeRecoveryHarness(RETRY_TIMER_ONLY))
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const refusal = errCallTimeout('spawn')
    h.script({ spawnError: refusal })
    const armedAt = h.clock.now()
    expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })
    await h.advance(waitMs(0) / 2)
    const otherArmedAt = h.clock.now()
    expect(await h.launch(other)).toEqual({ key: other, action: 'failed', refused: true })
    expect(h.controller.armedKeys()).toEqual([key, other])
    const otherView = h.controller.view(other)

    // P's first retry: its liveness read finds no row, so it launches; the spawn answers CONFLICT.
    const err = conflictForPersona(key)
    h.script({ spawnError: err })
    const before = callCounts(h)
    expect(await retryNow(h, key)).toBe(armedAt + waitMs(0))
    h.script({ spawnError: refusal })

    // The liveness read, the kill of the dead reading and the spawn; after the
    // CONFLICT no kill, delete, resume or second spawn (at most a status read).
    const since = callsSince(h, before)
    expect(since).toMatchObject({ killCalls: 1, spawnCalls: 1 })
    expect(Object.keys(since).sort()).toEqual(['killCalls', 'spawnCalls', 'statusCalls'])
    expectLatchedOnce(h, key, err, LATCH_ROW_STATE_NO_ROW)
    expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_LATCHED))
    expect(h.controller.view(key)).toBeUndefined()
    expect(h.controller.view(other)).toEqual(otherView)

    const pCalls = personaCallCounts(h, key)
    const pAttempts = h.attempts.filter((attempt) => attempt.key === key).length
    let otherDue = otherArmedAt
    for (let n = 0; n < 4; n++) {
      otherDue += waitMs(n)
      expect(await retryNow(h, other)).toBe(otherDue)
      expect([n, h.controller.view(other)]).toEqual([n, expect.objectContaining({ phase: 'waiting', dueAt: otherDue + waitMs(n + 1), refusals: n + 1 })])
    }
    expect(otherDue - armedAt).toBeGreaterThan(waitMs(0) + waitMs(1) + waitMs(2))
    expect(personaCallCounts(h, key)).toEqual(pCalls)
    expect(h.attempts.filter((attempt) => attempt.key === key)).toHaveLength(pAttempts)
    expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(h.controller.armedKeys()).toEqual([other])
    expect(h.clock.pendingCount()).toBe(1)
    expect(h.latch.isLatched(other)).toBe(false)
  })

  test.each(ARMED_MODES)('a start-pass launch answering CONFLICT while P’s timer is armed %s stops it with the latch’s reason; nothing fires for P however far the clock goes', async (_mode, arm) => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    arm(h, key)
    await h.advance(waitMs(0) / 2)
    const err = conflictForPersona(key)
    h.script({ spawnError: err })

    expect(await h.launch(key)).toEqual({ key, action: 'latched' })

    expect(callCounts(h)).toEqual({ spawnCalls: 1, statusCalls: 1 })
    expectLatchedOnce(h, key, err, LATCH_ROW_STATE_NO_ROW)
    expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(h.clock.pendingCount()).toBe(0)
    await h.advance(10 * UNAVAILABLE_RETRY_CEILING_S * 1000)
    expect(h.attempts).toEqual([])
    expect(callCounts(h)).toEqual({ spawnCalls: 1, statusCalls: 1 })
    expectUntouchedEpisode(h, other)
  })

  test.each(ARMED_MODES)('a timer armed for P after the latch %s stops at its first fire with the latch’s reason and no agent-director call', async (_mode, arm) => {
    const h = (harness = makeRecoveryHarness())
    const [key, other] = h.keys as [string, string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const err = conflictForPersona(key)
    h.script({ spawnError: err })
    expect(await h.launch(key)).toEqual({ key, action: 'latched' })
    expectLatchedOnce(h, key, err, LATCH_ROW_STATE_NO_ROW)
    expect(h.stops).toEqual([])

    arm(h, key)
    const before = callCounts(h)
    const due = await retryNow(h, key)

    expect(h.attempts).toEqual([expect.objectContaining({ key, retry: 1, at: due })])
    expect(callsSince(h, before)).toEqual({})
    expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(retryLinesOf(h, key).at(-1)).toContain(` — ${UNAVAILABLE_RETRY_STOP_LATCHED}`)
    expect(h.controller.isArmed(key)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    await h.advance(10 * UNAVAILABLE_RETRY_CEILING_S * 1000)
    expect(h.attempts).toHaveLength(1)
    expect(h.episodeNotices).toEqual([conflictNoticeForPersona(key, err)])
    expectUntouchedEpisode(h, other)
  })

  test('P’s retries meet ErrInternal, so its episode is open; a later retry refused with CONFLICT ends it with the latch’s reason, and past the alert threshold in effect no unclassified alert posts: one CONFLICT post, nothing counted', async () => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    const unclassified = errInternal()
    const armedAt = await unclassifiedLaunch(h, key, unclassified)
    const thresholdMs = adAlertThresholdMsInEffect()
    const alert = alertRetry(armedAt, thresholdMs)
    // At least one retry meets ErrInternal, and the CONFLICT retry still comes before the alert's.
    expect(alert.retry).toBeGreaterThan(2)
    for (let n = 0; n < alert.retry - 2; n++) await retryNow(h, key)
    expect(h.unclassifiedErrorOpen(key)).toBe(true)
    expect(h.episodeNotices).toEqual([])

    const err = conflictForPersona(key)
    h.script({ spawnError: err })
    const conflictAt = await retryNow(h, key)

    expect(conflictAt).toBeLessThan(alert.dueAt)
    expectLatchedOnce(h, key, err, LATCH_ROW_STATE_NO_ROW)
    expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(h.unclassifiedErrorOpen(key)).toBe(false)
    expect(unclassifiedLines(h, key)).toEqual([
      unclassifiedStartedLine(key, unclassified),
      unclassifiedEndedLine(key, UNCLASSIFIED_ERROR_END_LATCHED),
    ])

    const attempts = h.attempts.length
    await h.advance(armedAt + 2 * thresholdMs - h.clock.now())
    expect(h.attempts).toHaveLength(attempts)
    expect(h.episodeNotices).toEqual([conflictNoticeForPersona(key, err)])
    expect(unclassifiedLines(h, key)).toHaveLength(2)
    expect(h.clock.pendingCount()).toBe(0)
    expectNeverDestructive(h, key)
    expectUntouchedEpisode(h, other)
  })
})

// ---------------------------------------------------------------------------
// The retry's row read finds P's own `pending` row with no launch start
// (b.jg5 SRJ-303, SRJ-305, SRJ-513), on the recovery harness with both
// settings 0 and the configured-persona query it installs as `main()` does:
// the read latches P with "launch start not recorded" (refused operation
// "none", the state `pending`), the latch's hold stops the timer with the
// latch's reason, its one SRJ-1020 post is made, and no call follows the
// read (no send-keys, kill, `find-missing` or launch). In pending-only mode
// the read is the timer's own row read; in full mode (armed by an
// UNAVAILABLE launch) it is the retry entry's liveness probe. Nothing fires
// for P however far the clock goes. Control: with a launch start the
// pending-only retry refuses on the row as E8 T4 left it.
// ---------------------------------------------------------------------------

/** From now on persona `key`'s `status` reads its own row `pending` with `launchStartedAt` (the key left out for `undefined`); every other persona has no row. */
function pendingRowFor(h: RecoveryHarness, key: string, launchStartedAt: string | null | undefined): void {
  h.script({
    statusFn: (params) => params.claude_instance_id === personaInstanceId(key)
      ? cannedStatusResult({ state: UNAVAILABLE_RETRY_ROW_PENDING, launch_started_at: launchStartedAt })
      : errSpawnNotFound(),
  })
}

/**
 * The retry's read latched persona `key` once with "launch start not
 * recorded" (`launchStartRecord`), and the latch's holds, the retry timer's
 * stop first, ran before its one SRJ-1020 post; the timer stopped with the
 * latch's reason; nothing counted.
 */
function expectRetryStoppedByLaunchStartLatch(h: RecoveryHarness, key: string): void {
  expect(h.latch.record(key)).toEqual(launchStartRecord(key))
  const steps = h.latchEvents.filter((event) => event.key === key).map((event) =>
    event.step === 'set' ? [event.step, event.outcome] : event.step === 'hold' ? [event.step, event.hold] : [event.step, event.text])
  expect(steps).toEqual([
    ['set', CONFLICT_LATCH_SET_LATCHED],
    ['hold', 'retry timer stop'],
    ['hold', 'tmux-unresponsive end'],
    ['hold', 'unclassified-error end'],
    ['notice', launchStartNotRecordedNoticeText(key)],
  ])
  expect(h.episodeNotices).toEqual([{ key, text: launchStartNotRecordedNoticeText(key) }])
  expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
  expect(h.stub.calls.deleteCalls).toEqual([])
  expect(getFailureCount(key)).toBe(0)
  expect(h.capReached).toEqual([])
  expect(h.notices).toEqual([])
  expect(h.startupErrors()).toEqual([])
  expect(h.tmuxUnresponsive.holds(key)).toBe(false)
}

describe('unavailable retry: a retry whose row read finds P’s own pending row with no launch start latches P and stops (SRJ-303, SRJ-305, SRJ-513)', () => {
  test.each([...NO_LAUNCH_START_FORM_NAMES])('pending-only, launch start %s: the retry’s one row read latches P once and stops the timer with the latch’s reason; no call follows the read; nothing fires for P past several waits', async (form) => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    pendingRowFor(h, key, NO_LAUNCH_START_FORMS[form])
    h.controller.armPendingOnly(key)

    await retryNow(h, key)

    expect(callCounts(h)).toEqual({ statusCalls: 1 })
    expect(h.stub.calls.statusCalls).toEqual([{ claude_instance_id: personaInstanceId(key) }])
    expectRetryStoppedByLaunchStartLatch(h, key)
    expectNeverDestructive(h, key)
    expect(retryLinesOf(h, key)).toEqual([
      pendingOnlyArmedLine(key),
      pendingOnlyRetryLine(key, 1),
      pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_LATCHED),
    ])
    expectStopped(h, key)

    await h.advance(waitMs(0) + waitMs(1) + waitMs(2) + waitMs(3))
    expect(h.attempts).toHaveLength(1)
    expect(callCounts(h)).toEqual({ statusCalls: 1 })
    expect(h.episodeNotices).toHaveLength(1)
    expect(h.clock.pendingCount()).toBe(0)
    expectUntouchedEpisode(h, other)
  })

  test.each([...NO_LAUNCH_START_FORM_NAMES])('full mode (armed by an UNAVAILABLE launch), launch start %s: the next retry’s liveness read latches P once and stops the timer with the latch’s reason; no call follows the read; nothing fires for P past several waits', async (form) => {
    const h = (harness = makeRecoveryHarness(RETRY_TIMER_ONLY))
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    h.script({ spawnError: errCallTimeout('spawn') })
    expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', mode: UNAVAILABLE_RETRY_MODE_FULL })
    h.script({ spawnError: undefined })
    pendingRowFor(h, key, NO_LAUNCH_START_FORMS[form])

    const before = callCounts(h)
    await retryNow(h, key)

    expect(h.attempts.map((a) => [a.key, a.mode])).toEqual([[key, UNAVAILABLE_RETRY_MODE_FULL]])
    expect(callsSince(h, before)).toEqual({ statusCalls: 1 })
    expect(h.stub.calls.statusCalls.at(-1)).toEqual({ claude_instance_id: personaInstanceId(key) })
    expectRetryStoppedByLaunchStartLatch(h, key)
    // The launch's UNAVAILABLE spawn started the tmux-unresponsive condition; the latch's hold ended it.
    expect(conditionLines(h, key).at(-1)).toBe(conditionEndedLine(key, TMUX_UNRESPONSIVE_END_LATCHED))
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_LATCHED))
    expectStopped(h, key)

    const after = callCounts(h)
    await h.advance(waitMs(0) + waitMs(1) + waitMs(2) + waitMs(3))
    expect(h.attempts).toHaveLength(1)
    expect(callCounts(h)).toEqual(after)
    expect(h.episodeNotices).toHaveLength(1)
    expect(h.clock.pendingCount()).toBe(0)
    expectUntouchedEpisode(h, other)
  })

  test('control: pending-only, P’s own pending row with a launch start: no latch, no post; the retry’s one row read refuses on the row and re-arms at the doubled wait, as E8 T4 left it', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    pendingRowFor(h, key, SAMPLE_LAUNCH_START_FRACTIONAL)
    h.controller.armPendingOnly(key)

    await retryNow(h, key)

    expect(callCounts(h)).toEqual({ statusCalls: 1 })
    expect(retryLinesOf(h, key).at(-1)).toBe(reArmedLine(key, 1, UNAVAILABLE_RETRY_AGAIN_ROW_PENDING, 1, { ranPendingOnly: true }))
    expect(h.controller.view(key)).toEqual({
      phase: 'waiting',
      dueAt: h.clock.now() + waitMs(1),
      waitMs: waitMs(1),
      refusals: 1,
      causes: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW],
      mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
      lastRow: UNAVAILABLE_RETRY_ROW_PENDING,
    })
    expect(h.latch.isLatched(key)).toBe(false)
    expect(h.latchEvents).toEqual([])
    expect(h.episodeNotices).toEqual([])
    expect(h.stops).toEqual([])
    h.teardown(key)
    expectStopped(h, key)
  })
})

// ---------------------------------------------------------------------------
// A latched query that throws counts as latched (b.jg5 SRJ-502, fail safe):
// the retry action's own query, in both modes, over stand-ins and through the
// bare controller; and the restart work's query, on the recovery harness
// ---------------------------------------------------------------------------

/** The thrown latched query's error: a fake token in its message, the bare sentinel in a field CSCB never reads. */
function latchedQueryBroke(): Error {
  return Object.assign(new Error(`latched query broke (${sentinelInMessage('latched')})`), { note: LEAK_SENTINEL })
}

/** KEY's latched query throws; OTHER's answers false. */
function throwingForKey(key: string): boolean {
  if (key === KEY) throw latchedQueryBroke()
  return false
}

/** The retry action's line for KEY's thrown latched query begins with this (then its stack frames). */
const LATCHED_QUERY_FAILED_PREFIX =
  `[slack] unavailable-retry: persona=${KEY} the latched query failed: Error message="latched query broke (${REDACTED_SENTINEL_TAIL})" at `
/** …and ends with this. */
const LATCHED_QUERY_FAILED_SUFFIX = ' — taken as latched; no agent-director call'

/** The first retry for persona `key` in each mode, and how a bare controller arms it. */
const LATCHED_QUERY_MODES = [
  [UNAVAILABLE_RETRY_MODE_FULL, FULL_RETRY, (c: UnavailableRetryController, key: string) => { c.arm(key, UNAVAILABLE) }, (key: string) => stoppedLine(key, UNAVAILABLE_RETRY_STOP_LATCHED)],
  [UNAVAILABLE_RETRY_MODE_PENDING_ONLY, PENDING_ONLY_RETRY, (c: UnavailableRetryController, key: string) => { c.armPendingOnly(key) }, (key: string) => pendingOnlyStoppedLine(key, UNAVAILABLE_RETRY_STOP_LATCHED)],
] as const

describe('unavailable retry: a latched query that throws counts as latched (SRJ-502, fail safe)', () => {
  let errLines: string[]
  let origConsoleError: typeof console.error

  beforeEach(() => {
    errLines = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.error = origConsoleError
    assertNoLeak({ errLines })
  })

  /** Stand-ins over both personas, KEY's latched query throwing, recording which later gates were asked. */
  function throwingQueryDeps(asked: string[]): StandInDeps {
    return fullModeDeps(RESTART_OUTCOME_LAUNCHED, {
      isLatched: throwingForKey,
      appliedPersona: (key) => ({ working_directory: `/work/${key}` }),
      canRelaunch: (key) => { asked.push(`up ${key}`); return true },
      isAtCap: (key) => { asked.push(`cap ${key}`); return false },
      isInFlight: (key) => { asked.push(`in-flight ${key}`); return false },
    }, UNAVAILABLE_RETRY_ROW_PENDING)
  }

  test.each(LATCHED_QUERY_MODES)('%s mode, over stand-ins: KEY stops with the latch’s reason before the up and cap checks, the row read and the retry entry, logging one line naming what the query threw; OTHER’s retry runs as before', async (mode, attempt) => {
    const asked: string[] = []
    const deps = throwingQueryDeps(asked)
    const action = createFullModeRetryAction(deps)

    expect(await action(KEY, attempt)).toEqual({ kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_LATCHED })

    expect(asked).toEqual([])
    expect(deps.calls).toEqual([])
    expect(deps.reads).toEqual([])
    expect(errLines).toHaveLength(1)
    expect(errLines[0]).toStartWith(LATCHED_QUERY_FAILED_PREFIX)
    expect(errLines[0]).toEndWith(LATCHED_QUERY_FAILED_SUFFIX)

    const answer = await action(OTHER, attempt)
    if (mode === UNAVAILABLE_RETRY_MODE_FULL) {
      expect(answer).toMatchObject({ kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_LAUNCHED })
      expect(deps.calls).toEqual([[OTHER, `/work/${OTHER}`]])
      expect(deps.reads).toEqual([])
    } else {
      expect(answer).toMatchObject({ kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_ROW_PENDING })
      expect(deps.calls).toEqual([])
      expect(deps.reads).toEqual([[OTHER, true]])
    }
    expect(asked).toEqual([`up ${OTHER}`, `cap ${OTHER}`, ...(mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY ? [`in-flight ${OTHER}`] : [])])
    expect(errLines).toHaveLength(1)
  })

  test.each(LATCHED_QUERY_MODES)('%s mode, through the bare controller: KEY’s timer logs the query’s line, then its usual stopped line, and is observed stopped once with the latch’s reason; nothing more fires for KEY, and OTHER stays armed', async (_mode, _attempt, arm, stopLine) => {
    const asked: string[] = []
    const deps = throwingQueryDeps(asked)
    const run = stopRun('recording')
    const rig = run.build(createFullModeRetryAction(deps))
    // One ordered list: the action's console line and the controller's lines.
    console.error = (...args: unknown[]) => {
      const line = args.map(String).join(' ')
      errLines.push(line)
      rig.lines.push(line)
    }
    arm(rig.controller, KEY)
    await rig.clock.advance(waitMs(0) / 2)
    arm(rig.controller, OTHER)

    await retryOnce(rig, KEY)

    const keyLines = rig.lines.filter((line) => line.startsWith(`[slack] unavailable-retry: persona=${KEY} `))
    expect(keyLines.at(-1)).toBe(stopLine(KEY))
    expect(keyLines.at(-2)).toStartWith(LATCHED_QUERY_FAILED_PREFIX)
    expect(keyLines.at(-2)).toEndWith(LATCHED_QUERY_FAILED_SUFFIX)
    expect(keyLines.filter((line) => line.includes('the latched query failed'))).toHaveLength(1)
    expect(run.steps).toEqual([['stopped', KEY, UNAVAILABLE_RETRY_STOP_LATCHED, stopLine(KEY)]])
    expect(rig.controller.isArmed(KEY)).toBe(false)
    expect(deps.calls).toEqual([])
    expect(deps.reads).toEqual([])
    expect(asked).toEqual([])

    // OTHER's retry, due later, runs as before and is not stopped.
    expect(rig.attempts.map((a) => a.key)).toEqual([KEY])
    await retryOnce(rig, OTHER)
    expect(rig.attempts.map((a) => a.key)).toEqual([KEY, OTHER])
    expect(rig.controller.isArmed(OTHER)).toBe(true)
    expect([...deps.calls.map(([key]) => key), ...deps.reads.map(([key]) => key)]).toEqual([OTHER])
    expect(run.steps).toHaveLength(1)
    expect(errLines).toHaveLength(1)
  })
})

describe('unavailable retry: a restart work whose latched query throws stops the timer (SRJ-502, fail safe), on the harness', () => {
  test('a full-mode retry whose restart work’s latched query throws for P stops P’s timer with the latch’s reason: no agent-director call, nothing counted, one skip line naming what it threw; the other persona’s timer keeps its schedule', async () => {
    const h = (harness = makeRecoveryHarness({
      restartDeps: {
        isLatched: (key) => {
          if (key === h.keys[0]) throw latchedQueryBroke()
          return false
        },
      },
    }))
    const [key, other] = h.keys as [string, string]
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT)
    h.controller.arm(key, UNAVAILABLE)
    await h.advance(waitMs(0) / 2)
    h.controller.arm(other, UNAVAILABLE)
    const otherView = h.controller.view(other)

    const before = callCounts(h)
    await retryNow(h, key)

    expect(callsSince(h, before)).toEqual({})
    expect(personaCallCounts(h, key)).toEqual({})
    expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_LATCHED))
    expect(h.controller.isArmed(key)).toBe(false)
    const skip = h.errors.filter((line) => line.startsWith(`[slack] Skipping restart for persona=${key} `))
    expect(skip).toHaveLength(1)
    expect(skip[0]).toStartWith(
      `[slack] Skipping restart for persona=${key} — the persona is latched (the latched query failed: Error message="latched query broke (${REDACTED_SENTINEL_TAIL})" at `,
    )
    expect(skip[0]).toEndWith(' — taken as latched); no agent-director call, nothing recorded (b.jg5 SRJ-502)')
    expectNeverDestructive(h, key)
    expect(h.latch.isLatched(key)).toBe(false)

    // The other persona's timer was not touched, and its retry still runs.
    expect(h.controller.view(other)).toEqual(otherView)
    const attempts = h.attempts.length
    await retryNow(h, other)
    expect(h.attempts).toHaveLength(attempts + 1)
    expect(h.attempts.at(-1)).toMatchObject({ key: other })
    expect(personaCallCounts(h, other)).not.toEqual({})
    expect(h.stops).toEqual([{ key, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(personaCallCounts(h, key)).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// A lost message (b.jg5 SRJ-1011, SRJ-311, SRJ-316; AC 36, AC 68) through the
// recovery harness's driver: the real routing's no-session branch, bound as
// `main()` binds it, both settings 0. State 5 comes before
// `auto-restart-disabled`, so the delay 0 also checks the order.
// ---------------------------------------------------------------------------

describe('unavailable retry: a message lost while P’s tmux-unavailable or ad-config-malformed outage is raised reports not answering, with no restart (SRJ-1011, SRJ-311, SRJ-316, AC 36, AC 68)', () => {
  test.each<[string, () => Error, OutageClass, string]>([
    ['ErrTmuxNotAvailable (tmux-unavailable)', () => errTmuxNotAvailable(), 'tmux-unavailable', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['a CONFIG answer (ad-config-malformed)', () => errConfigMalformed(), AD_CONFIG_MALFORMED, UNAVAILABLE_RETRY_CAUSE_CONFIG],
  ])('%s on P’s bring-up, both settings 0: a message lost meanwhile reports not answering, schedules no restart and makes no call, the timer untouched; once calls succeed and the outage clears, one lost for the still-unregistered P reports auto-restart disabled', async (_what, make, raised, cause) => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    const row = modelRow(h, 'missing')
    h.script({ spawnError: make() })
    expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })
    expect([...getOutageFlags(key)]).toEqual([raised])
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    expectArmedOnce(h, key, cause)
    const timer = h.controller.view(key)

    await expectLostMessageReports(h, key, 'not-answering')

    expect(h.controller.view(key)).toEqual(timer)
    expect(h.stub.calls.spawnCalls).toHaveLength(1)
    expect([h.stub.calls.killCalls, h.stub.calls.deleteCalls]).toEqual([[], []])
    // The flags are P's own: the other persona's message reports its own state.
    await expectLostMessageReports(h, other, 'auto-restart-disabled')

    // Calls succeed: the retry reads the row missing and relaunches P, and
    // the outage clears; P is still unregistered.
    h.script({ spawnError: undefined })
    await retryNow(h, key)
    expect(row.spawnedAt).toHaveLength(2)
    expect(getOutageFlags(key).size).toBe(0)

    await expectLostMessageReports(h, key, 'auto-restart-disabled')

    // The next retry reads the row live: nothing left to recover.
    await retryNow(h, key)
    expectStopped(h, key)
    expect(h.stub.calls.deleteCalls).toEqual([])
  })

  test.each(UNCLASSIFIED_ERRORS)('no unclassified input: %s answering P’s attempt’s row reads, P’s unclassified-error episode open, a message lost meanwhile reports auto-restart disabled, never not answering', async (_what, make) => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key] = h.keys as [string]
    const readErr = make('status')
    modelRow(h, UNAVAILABLE_RETRY_ROW_ABSENT, () => readErr)
    await unclassifiedLaunch(h, key, make('spawn'))
    const before = callCounts(h)
    await retryNow(h, key)
    expect(callsSince(h, before)).toEqual({ statusCalls: 1 })
    expect(h.unclassifiedErrorOpen(key)).toBe(true)
    expect(getOutageFlags(key).size).toBe(0)
    expect(h.tmuxUnresponsive.holds(key)).toBe(false)
    const timer = h.controller.view(key)
    const triggers = h.triggers.length

    // The message's one row read answers the same error, outside any attempt
    // (SRJ-1011, hatch A2): a failed read, so not state 6, and it arms
    // nothing: the timer keeps its due time and no trigger is sent.
    await expectLostMessageReports(h, key, 'auto-restart-disabled')

    expect(h.controller.view(key)).toEqual(timer)
    expect(h.triggers).toHaveLength(triggers)
    expect(h.unclassifiedErrorOpen(key)).toBe(true)
    expectNeverDestructive(h, key)
  })
})

// ---------------------------------------------------------------------------
// A lost message arms a missing retry timer (b.jg5 SRJ-311, SRJ-1501): the
// driver's `armRetryTimerIfMissing`, bound as `main()` binds it, both
// settings 0, so no health tick and no restart would ever attempt for P.
// Its `isRetryArmed` is the controller's `isArmed`, as `main()` binds it
// (b.jg5 SRJ-1011 as amended: state 5 applies only while P's retry timer is
// armed), so a state-5 condition with no timer armed that this path does
// not arm falls through to a later state, and a P at the restart cap
// (reached through real counted failures) reports restart limit reached
// whatever is raised, with nothing armed by the message.
// ---------------------------------------------------------------------------

describe('unavailable retry: a message lost in not answering with P’s tmux-unavailable outage raised and no retry timer arms one, never a restart, and never at the restart cap (SRJ-311, SRJ-1501, SRJ-305)', () => {
  /** The driver's arm lines for persona `key` since `from` (the one line `armRetryTimerIfMissing` logs when it arms). */
  const armLinesSince = (h: RecoveryHarness, key: string, from: number): string[] =>
    h.errors.slice(from).filter((line) => line.startsWith(`[slack] Lost message: persona=${key} `))

  /**
   * P's bring-up refused with `make()` raises `flag` and arms its timer with
   * `cause`; P then stops being up, so its retry stops as not up with the flag
   * still raised; P is up again, with no timer and nothing pending.
   */
  async function stoppedWithFlagRaised(h: RecoveryHarness, key: string, make: () => Error, flag: OutageClass, cause: string): Promise<void> {
    h.script({ spawnError: make() })
    expect(await h.launch(key)).toEqual({ key, action: 'failed', refused: true })
    expectArmedOnce(h, key, cause)
    h.setUp(key, false)
    await retryNow(h, key)
    expect(h.lines).toContain(stoppedLine(key, UNAVAILABLE_RETRY_STOP_NOT_UP))
    h.setUp(key, true)
    expect([...getOutageFlags(key)]).toEqual([flag])
    expectStopped(h, key)
  }

  test('raised with no timer (its retry stopped as not up): a message lost while P is not up arms nothing; once P is up, the message reports not answering, asks for no restart, makes no call, and arms P’s timer once at the base wait with the ENVIRONMENT cause, straight to the controller, with one line; a second, with that timer armed, arms nothing new; the other persona is untouched', async () => {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    await stoppedWithFlagRaised(h, key, () => errTmuxNotAvailable(), 'tmux-unavailable', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT)
    const triggers = h.triggers.length
    const errorsBefore = h.errors.length

    // Only a message lost in not answering arms: P not up reports not up and arms nothing.
    h.setUp(key, false)
    await expectLostMessageReports(h, key, 'not-up')
    expect(h.controller.armedKeys()).toEqual([])
    h.setUp(key, true)

    await expectLostMessageReports(h, key, 'not-answering')

    expect(h.controller.armedKeys()).toEqual([key])
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', dueAt: h.clock.now() + waitMs(0), refusals: 0, causes: [UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT] })
    expect(delays(h.clock)).toEqual([waitMs(0)])
    expect(h.triggers).toHaveLength(triggers)
    expect(armLinesSince(h, key, errorsBefore)).toHaveLength(1)
    expect(isRestartPendingOrActive(key)).toBe(false)

    const timer = h.controller.view(key)
    const errorsAfterArm = h.errors.length
    await expectLostMessageReports(h, key, 'not-answering')
    expect(h.controller.view(key)).toEqual(timer)
    expect(delays(h.clock)).toEqual([waitMs(0)])
    expect(armLinesSince(h, key, errorsAfterArm)).toEqual([])

    expect([...getOutageFlags(other)]).toEqual([])
    expect(h.controller.isArmed(other)).toBe(false)
    h.teardown(key)
    expectStopped(h, key)
  })

  // b.jg5 SRJ-1011 as amended: state 5 applies only while P's retry timer is
  // armed, and this path arms only for tmux-unavailable, so the message falls
  // through: its one row read (the row missing, not pending), then auto-restart
  // disabled at the delay 0.
  test('ad-config-malformed raised alone with no timer: not state 5 (no timer armed), so the message makes its one read and reports auto-restart disabled, and arms nothing through this path', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    await stoppedWithFlagRaised(h, key, () => errConfigMalformed(), AD_CONFIG_MALFORMED, UNAVAILABLE_RETRY_CAUSE_CONFIG)
    const errorsBefore = h.errors.length

    await expectLostMessageReports(h, key, 'auto-restart-disabled')

    expect(h.controller.armedKeys()).toEqual([])
    expect(armLinesSince(h, key, errorsBefore)).toEqual([])
    expectStopped(h, key)
  })

  // b.jg5 SRJ-1011 as amended: the check arms nothing while a launch for P
  // is in flight, so no timer is armed and state 5 does not apply; the launch
  // running is state 6, with no read.
  test('raised while a launch for P is in flight, no timer: the check arms nothing, so not state 5: the message reports session starting, with no read', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const id = personaInstanceId(key)
    const hold = holdSpawns(h.stub.client)
    const launch = h.launch(key)
    await hold.entered(id)
    setOutageFlag(key, 'tmux-unavailable')
    expect(isLaunchInFlight(key)).toBe(true)
    const errorsBefore = h.errors.length

    await expectLostMessageReports(h, key, 'session-starting', { calls: {} })

    expect(h.controller.armedKeys()).toEqual([])
    expect(armLinesSince(h, key, errorsBefore)).toEqual([])
    hold.release(id)
    await launch
    await h.settle()
    expect(h.controller.armedKeys()).toEqual([])
    expectStopped(h, key)
  })

  test('raised while P is latched, no timer: the message reports held for a human and arms nothing', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    h.script({ spawnError: conflictForPersona(key), statusError: errSpawnNotFound() })
    expect(await h.launch(key)).toEqual({ key, action: 'latched' })
    setOutageFlag(key, 'tmux-unavailable')
    const errorsBefore = h.errors.length

    await expectLostMessageReports(h, key, 'held-for-human')

    expect(h.controller.armedKeys()).toEqual([])
    expect(armLinesSince(h, key, errorsBefore)).toEqual([])
    expectStopped(h, key)
  })

  // b.jg5 SRJ-1011 as amended (orchestrator ruling): "A persona whose retry
  // timer is stopped at the restart cap reports restart-limit-reached, never
  // state 5's 'CSCB is retrying', whatever condition or flag is raised."
  // P reaches the cap through real counted launch failures on its own retry
  // timer, which the cap stops; `session_restart_delay` is above 0 (and
  // never fires), so auto-restart disabled does not come first.

  /**
   * Drive P to the restart cap as the cap stop rule's case does: its retry
   * timer armed, each retry's launch failing with `ErrTmuxSessionCreate`
   * (counted) over a missing row, until the cap stops the timer with one cap
   * notice, nothing pending on the clock and no restart pending. `refuse`
   * (see `modelRow`) answers every `status` once it returns an error.
   */
  async function cappedByLaunchFailures(h: RecoveryHarness, key: string, refuse?: () => Error | undefined): Promise<void> {
    modelRow(h, 'missing', refuse)
    h.script({ spawnError: errTmuxSessionCreate('spawn') })
    h.controller.arm(key, UNAVAILABLE)
    for (let n = 1; n <= RESTART_FAILURE_CAP; n++) await retryNow(h, key)
    expect(getFailureCount(key)).toBe(RESTART_FAILURE_CAP)
    expect(isAtCap(key, RESTART_FAILURE_CAP)).toBe(true)
    expect(h.capReached).toEqual([key])
    expect(h.lines).toContain(stoppedLine(key, UNAVAILABLE_RETRY_STOP_CAPPED))
    expectStopped(h, key)
    expect(isRestartPendingOrActive(key)).toBe(false)
  }

  /** Both settings as the cases above, but a restart delay above 0 that never fires. */
  const cappedHarness = (): RecoveryHarness => (harness = makeRecoveryHarness({ sessionRestartDelay: 9999 }))

  test.each<[OutageClass]>([['tmux-unavailable'], [AD_CONFIG_MALFORMED]])(
    'P at the restart cap by real counted failures, its timer stopped there, then its %s flag raised: the message makes its one read (failing UNAVAILABLE, so it raises and clears nothing) and reports restart limit reached, never not answering; no restart is asked for, no timer is armed and nothing is pending',
    async (flag) => {
      const h = cappedHarness()
      const [key, other] = h.keys as [string, string]
      let refusal: Error | undefined
      await cappedByLaunchFailures(h, key, () => refusal)
      setOutageFlag(key, flag)
      refusal = errTmuxUnresponsive('status')
      const spawns = h.stub.calls.spawnCalls.length
      const errorsBefore = h.errors.length

      await expectLostMessageReports(h, key, 'restart-limit-reached')

      expect([...getOutageFlags(key)]).toEqual([flag])
      expect(h.controller.armedKeys()).toEqual([])
      expect(armLinesSince(h, key, errorsBefore)).toEqual([])
      expect(h.stub.calls.spawnCalls).toHaveLength(spawns)
      expect(isRestartPendingOrActive(key)).toBe(false)
      expectStopped(h, key)
      // The other persona, below the cap, is not held at it.
      expect(isAtCap(other, RESTART_FAILURE_CAP)).toBe(false)
    },
  )

  test.each<[string, () => Error, OutageClass, string]>([
    ['ErrTmuxNotAvailable (ENVIRONMENT)', () => errTmuxNotAvailable(undefined, 'status'), 'tmux-unavailable', UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
    ['a CONFIG answer (ErrConfigMalformed)', () => errConfigMalformed(), AD_CONFIG_MALFORMED, UNAVAILABLE_RETRY_CAUSE_CONFIG],
  ])(
    'P at the restart cap, the message\'s own read answering %s, which raises %s and arms P\'s timer as from any verb: the message still reports restart limit reached (the cap wins over the armed timer), as does a second with the timer still armed; no restart, no arm through the lost-message path; the timer stops at its next retry with no call',
    async (_label, make, flag, cause) => {
      const h = cappedHarness()
      const [key] = h.keys as [string]
      let refusal: Error | undefined
      await cappedByLaunchFailures(h, key, () => refusal)
      refusal = make()
      const triggers = h.triggers.length
      const errorsBefore = h.errors.length

      await expectLostMessageReports(h, key, 'restart-limit-reached')

      expect([...getOutageFlags(key)]).toEqual([flag])
      expect(h.triggers.slice(triggers)).toEqual([{ key, kind: cause }])
      expect(h.controller.armedKeys()).toEqual([key])
      const timer = h.controller.view(key)

      // The window the cap closes: the flag raised and the timer armed.
      await expectLostMessageReports(h, key, 'restart-limit-reached')

      expect(h.controller.view(key)).toEqual(timer)
      expect(armLinesSince(h, key, errorsBefore)).toEqual([])
      expect(isRestartPendingOrActive(key)).toBe(false)

      // That timer stops at its next retry, at the cap, with no call.
      const before = callCounts(h)
      await retryNow(h, key)
      expect(callsSince(h, before)).toEqual({})
      expect(retryLinesOf(h, key).at(-1)).toBe(stoppedLine(key, UNAVAILABLE_RETRY_STOP_CAPPED))
      expectStopped(h, key)
    },
  )

  // Positive control for `restartRequested`: at the delay 0 the restart module
  // arms nothing, so only the harness's record of the latched-query ask can
  // show a request; a direct `scheduleRestart` must appear there.
  test('positive control, delay 0: a direct scheduleRestart for P is recorded in restartAsks, with no restart pending', () => {
    const h = (harness = makeRecoveryHarness())
    expect(h.config.session_restart_delay).toBe(0)
    const [key] = h.keys as [string]
    const before = h.restartAsks.length

    scheduleRestart(key, personaOf(h, key).working_directory)

    expect(h.restartAsks.slice(before)).toEqual([key])
    expect(isRestartPendingOrActive(key)).toBe(false)
  })
})
