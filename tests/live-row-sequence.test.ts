/**
 * live-row-sequence.test.ts — The live-row sequence (b.jg5 SRJ-705, SRJ-717;
 * AC 61, AC 62, AC 63, AC 84): its steps, its alert, the not-judged stop and
 * its launch, run through `src/live-row-sequence.ts`'s `runLiveRowSequence`
 * over the session manager's production dependencies on
 * `makeRecoveryHarness` (`startSequence`, `runSequence`, `driveSequence`),
 * with `createFakeClock` driving every wait.
 *
 * Pacing and limits: the run spacing, the step-4 pause and the maxima are the
 * exported ones; one `get` per run; every run bypasses the memo. Step exits:
 * a `get` after any run reading `ended`, `missing` or no row goes to step 6;
 * a step-2 `get` reading a finished row still leads to one run. The `pending`
 * wait: measured from the launch start with G in effect (SRJ-406, SRJ-210),
 * never early, at a G beyond the timer maximum too, and when G cannot be read
 * while arming (the accessor throws or answers NaN: logged by the error's
 * name and message with no stack, G named unreadable on the armed line,
 * armed again on the clock, never ended; a stop then ends it false); G at
 * `AD_WAIT_NEVER_ENDS` named beyond any wait; no wait without a launch
 * start (SRJ-408). The not-judged stop (SRJ-717), the failed runs (SRJ-120's
 * refusal split, E14 build), the kills (SRJ-110, SRJ-702, SRJ-703, SRJ-1007;
 * `ErrInvalidFlags`'s one version re-check, SRJ-104), the
 * `ad-config-malformed` rule (SRJ-316), a failed `get` (hatch A2; its line
 * reporting the failure's class, name and redacted message, SRJ-104), the
 * alert's episode (SRJ-704), the launch kind (step 6, its pure decision and
 * through the sequence: every reuse is one stub `spawn` of `cscb_<key>`
 * through the session manager's reuse spawn, carrying the reuse flag and the
 * persona's `extra_env`, read through the harness's `reuseSpawns()`), the
 * launch's end (which launch results are a success, and the outcome, its end
 * line, P's triggers in order, the count and the notice after a reuse that
 * succeeds, fails by each class, collides with a live row or throws; SRJ-112,
 * SRJ-301), the entries and forms, the stop signal (SRJ-706: an answer after
 * the stop, a kill's, its latch's or a dependency's throw, is dropped; a
 * latched persona gets no call), the lines that carry agent-director text,
 * the module's import boundary, and the scheduling (SRJ-706, AC 61: the
 * registry through the session manager's start, running and stop entries,
 * with a run held by the stub's `holdFindMissing`: a start that answers
 * before the first call, one sequence per persona at a time, every other
 * launch of P answering `sequence-waiting` with no call while Q goes ahead, a
 * new sequence after each kind of end, the stops at a teardown and shutdown
 * during a held run, and at a latch, a teardown and shutdown during the
 * waits, `closed` after shutdown, and the sequence's own detached recovery attempt),
 * and the sequence started at the collision ladder's real replacement sites
 * (SRJ-707: the launch answering while it runs, its reuse at step 6, a new
 * episode at the next retry after a not-judged stop, the `recovery`
 * context), and the sequence started at the ladder's `ErrSpawnNotResumable`
 * on a path holding dead evidence (SRJ-710, SRJ-611: the launch answering
 * while it runs, the conversation kept, step 6's launch kind by the row's
 * session id, the `recovery` context, a new episode at the next retry after
 * a not-judged stop) with step 6's `resume` answers through the sequence (a
 * CONFLICT, `ErrSpawnNotFound`'s plain spawn, and `ErrSpawnNotResumable`'s
 * one re-read: never a second sequence; the end armed with its cause, or
 * nothing armed on a latch). Every end without the launch arms P's retry timer with its
 * exported cause, the controller's own label, through the trigger sink
 * (SRJ-301; `expectEndArmed`). Every sequence runs through the registry but
 * `runWithDeps`'s, whose dependencies a case replaces. This file asserts
 * that the sequence stops; the latches it causes (each kill's CONFLICT and
 * UNUSABLE NAME rows, SRJ-613's kill backstop among them, a latching read at
 * a `get`, a latch from another path while a run is held, with their records
 * and posts, and the reuse's CONFLICT and UNUSABLE NAME latches) are in
 * tests/conflict-latch.test.ts; the `resume` leg's fallbacks (a `resume` with
 * no transcript going on to one reuse, after the lost-transcript diagnosis's
 * `get` on `ErrJsonlMissing`, SRJ-712), the sequence-launch entry and the
 * reuse spawn's parameters, steps and outcome table in
 * tests/session-manager.test.ts; and a sequence end keeping an armed timer's
 * due time, what a dropped kill arms, step 4's `ad-config-malformed` no-kill
 * and the step-6 resume's failures in tests/unavailable-retry.test.ts.
 *
 * The final launch ending in a launch timeout (b.jg5 SRJ-407; harness
 * `harnessNow`, `scriptTimedLaunch`): the reuse, or the `resume`, in either
 * timeout form, is followed by its one `get` and no further launch, and the
 * sequence ends launched with the other-end arm; a covered `pending` row
 * inside the window gets the approver (its one lap the only calls after the
 * `get`); a `pending` row in another directory, or a recorded key's old life
 * outside the window, makes the step ask the start entry for the sequence,
 * which answers already-running, so the launch answers `sequence-waiting`
 * with no approver and no mark.
 *
 * A retired key's old life (b.jg5 SRJ-805, SRJ-806, SRJ-1007): with P
 * recorded with no mark (the harness's `retireKey`), the final launch is one
 * reuse and never a `resume`, the flag set by its starter or by the start
 * entry; a reuse that succeeds answers `fresh-retired` and sets the mark, a
 * failed reuse (UNAVAILABLE, a collision, `ErrInvalidFlags`) and a sequence
 * stopped by a latch, a teardown or shutdown set none; an escalation raises
 * the ordinary alert for P's own id on its configured destination.
 *
 * The no-launch form as an old-life wait (b.jg5 SRJ-811, SRJ-1512,
 * SRJ-1007; E27 T2): started through the session manager's ensure entry on
 * a held row, still live after runs that judged it, its step-5 ordinary
 * version for a renamed-away key's own `cscb_<old>` and for a pre-persona
 * row's id is one `persona-kill-failed` entry with the context `old-life
 * wait`, the id and the row's session in the text and the log-only closing,
 * built with `src/kill-failure-alert.ts`'s builders. A no-launch request
 * started from inside a recovery attempt runs outside every attempt (its
 * UNAVAILABLE `get` arms nothing), where a launch-ending one runs in its own;
 * a hold's end stops only a no-launch request on its id, never a
 * launch-ending sequence there, P's own stop never stops a no-launch
 * request, and the no-launch query tells the two apart. The wait's steps
 * and results by class are tests/old-life-wait.test.ts's.
 *
 * Every spacing, limit, outcome, cause, context, state and class is
 * imported from `src/` or the stub builders, and every expected alert text
 * is built with `src/kill-failure-alert.ts`'s builders (through the
 * harness's helpers). `afterEach` checks that no call was a `delete` or set
 * `include_finished` and that nothing captured says "dispatcher bug"
 * (b.jg5 SRJ-713, `dispatcherBugWordingIn`), runs `assertNoLeak` over the
 * harness's `captured()`
 * and cleans it up, which fails while any timer is still pending.
 *
 * SPDX-License-Identifier: MIT
 */

import { resolve } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import type { FindMissingResult } from 'agent-director'

import {
  AD_SETTING_MINIMUMS,
  AD_WAIT_NEVER_ENDS,
  DEFAULT_AD_SETTINGS,
  adGraceMsInEffect,
  armNeverEarlyWait,
  pendingGraceMinimumSeconds,
} from '../src/ad-settings.ts'
import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  describeAgentDirectorFailure,
  LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT,
  LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE,
} from '../src/ad-error-class.ts'
import type { Phase1GetResult } from '../src/ad-phase1-types.ts'
import { getFailureCount } from '../src/backoff.ts'
import { killOutcomeOf, type KillFailureClass } from '../src/checked-kill.ts'
import {
  KILL_FAILURE_CLOSING_DESTINATION,
  KILL_FAILURE_CLOSING_DESTINATION_LATCHED,
  KILL_FAILURE_CLOSING_LOG_ONLY,
  KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT,
  KILL_FAILURE_CONTEXT_RECOVERY,
  KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT,
  KILL_FAILURE_ROUTE_NOT_CONFIGURED,
  KILL_FAILURE_VERSION_ORDINARY,
  PERSONA_KILL_FAILED_LABEL,
  killFailureAlertEntryText,
  killFailureAlertText,
} from '../src/kill-failure-alert.ts'
import { KILL_RETRY_ALERT_NONE, KILL_RETRY_ALERT_ORDINARY, KILL_RETRY_END_SETTLED, KILL_RETRY_END_STOPPED, KILL_RETRY_SPACING_MS, KILL_RETRY_TRIES, type KillRetryResult } from '../src/kill-retry.ts'
import {
  LIVE_ROW_ARM_ENDED,
  LIVE_ROW_ARM_LOST_RACE,
  LIVE_ROW_ARM_NOT_JUDGED,
  LIVE_ROW_ARM_REUSE_COLLISION,
  LIVE_ROW_LAUNCH_REASON_CONFIG_DIR_MISMATCH,
  LIVE_ROW_LAUNCH_REASON_CWD_MISMATCH,
  LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION,
  LIVE_ROW_LAUNCH_REASON_NO_ROW,
  LIVE_ROW_LAUNCH_REASON_NO_SESSION_ID,
  LIVE_ROW_LAUNCH_REASON_NOT_APPLIED,
  LIVE_ROW_LAUNCH_REASON_NOT_KEPT,
  LIVE_ROW_LAUNCH_REASON_RESUME_DISABLED,
  LIVE_ROW_LAUNCH_ANSWER_LAUNCHED,
  LIVE_ROW_LAUNCH_CALL_SUCCESS_ACTIONS,
  LIVE_ROW_LAUNCH_REASON_RETIRED_KEY,
  LIVE_ROW_LAUNCH_RESUME,
  LIVE_ROW_LAUNCH_REUSE,
  LIVE_ROW_NOT_LAUNCHED_NOT_APPLIED,
  LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE,
  LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE_PENDING,
  LIVE_ROW_NOT_LAUNCHED_REUSE_COLLISION,
  LIVE_ROW_NOT_LAUNCHED_SPAWN_COLLISION,
  LIVE_ROW_OUTCOME_ABORTED,
  LIVE_ROW_OUTCOME_CONFIG_MALFORMED,
  LIVE_ROW_OUTCOME_ESCALATED,
  LIVE_ROW_OUTCOME_INTERNAL_ERROR,
  LIVE_ROW_OUTCOME_LAUNCHED,
  LIVE_ROW_OUTCOME_NO_JUDGED_RUN,
  LIVE_ROW_OUTCOME_NOT_JUDGED,
  LIVE_ROW_OUTCOME_NOT_LAUNCHED,
  LIVE_ROW_OUTCOME_READ_REFUSED,
  LIVE_ROW_OUTCOME_ROW_FINISHED,
  LIVE_ROW_OUTCOME_RUN_REFUSED,
  LIVE_ROW_OUTCOME_STOPPED,
  LIVE_ROW_READ_REFUSED,
  LIVE_ROW_RUN_NOT_JUDGED,
  LIVE_ROW_RUN_REFUSED,
  LIVE_ROW_SEQUENCE_ENTRY_GET,
  LIVE_ROW_SEQUENCE_ENTRY_KILL,
  LIVE_ROW_SEQUENCE_GRACE_NEVER_ENDS_TEXT,
  LIVE_ROW_SEQUENCE_GRACE_REARM_LOG_SPACING_MS,
  LIVE_ROW_SEQUENCE_GRACE_REARM_MS,
  LIVE_ROW_SEQUENCE_GRACE_UNREADABLE_TEXT,
  LIVE_ROW_SEQUENCE_LOG_PREFIX,
  LIVE_ROW_SEQUENCE_MAX_KILLS,
  LIVE_ROW_SEQUENCE_MAX_RUNS,
  LIVE_ROW_SEQUENCE_RUN_SPACING_MS,
  LIVE_ROW_SEQUENCE_STEP3_RUNS,
  LIVE_ROW_SEQUENCE_STEP4_PAUSE_MS,
  LIVE_ROW_START_ALREADY_RUNNING,
  LIVE_ROW_START_CLOSED,
  LIVE_ROW_START_STARTED,
  LIVE_ROW_STOP_HOLD_ENDED,
  LIVE_ROW_STOP_LATCHED,
  LIVE_ROW_STOP_NOT_UP,
  LIVE_ROW_STOP_SHUTDOWN,
  LIVE_ROW_STOP_TEARDOWN,
  createLiveRowSequenceStop,
  decideLiveRowLaunchKind,
  liveRowLaunchSucceeded,
  liveRowSequenceDroppedLine,
  liveRowSequenceEndArmText,
  liveRowSequenceEndLine,
  liveRowSequenceFailedLine,
  liveRowSequenceGetLine,
  liveRowSequenceKillLine,
  liveRowSequenceNotStartedLine,
  liveRowSequenceRunLine,
  liveRowSequenceStartLine,
  liveRowSequenceStopAskedLine,
  liveRowSequenceWaitArmedLine,
  liveRowSequenceWaitArmFailedLine,
  liveRowStopCauseText,
  runLiveRowSequence,
  type LiveRowLaunchKindInput,
  type LiveRowSequenceLaunchKind,
  type LiveRowSequenceLaunchReason,
  type LiveRowSequenceNotLaunchedReason,
  type LiveRowSequenceArmCause,
  type LiveRowSequenceDeps,
  type LiveRowSequenceOutcome,
  type LiveRowSequenceRequest,
  type LiveRowSequenceStopHandle,
  type LiveRowSequenceStopReason,
  type RetiredKeyAttemptStart,
} from '../src/live-row-sequence.ts'
import { AGENT_DIRECTOR_PENDING_STATE, LIVENESS_DEAD_ROW_ENDED, LIVENESS_DEAD_ROW_MISSING } from '../src/liveness-reading.ts'
import { oldLifeWaitRef } from '../src/old-life-wait.ts'
import { parseLaunchStart, PENDING_ROW_REASON_CWD_MISMATCH, PENDING_ROW_REASON_RETIRED_OLD_LIFE } from '../src/pending-row.ts'
import { describeLogMessage, describeThrownValue } from '../src/persona-connection-errors.ts'
import { CONFIG_DIR_LABEL_PREFIX, personaInstanceId, personaTmuxSessionName, renderPersonaRef } from '../src/persona-identity.ts'
import { OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL } from '../src/retired-keys.ts'
import { KILL_FAILURE_END_ROW_FINISHED } from '../src/persona-episodes.ts'
import { MAX_TIMER_DELAY_MS } from '../src/persona-retry-schedule.ts'
import {
  ESCALATE_DEAD_WAITING_ROW_PANE_GONE,
  OLD_LIFE_ROW_READ_STATE,
  _resetFindMissingMemo,
  _resetNow,
  _setNow,
  APPROVER_STOP_CAP,
  isLaunchInFlight,
  launchCallWindowOf,
  launchSession,
  launchUnavailableSequenceOutcome,
  noteOldLifeRowRead,
  readPersonaRowState,
  ROW_REREAD_FINISHED,
  ROW_REREAD_LATCHED,
  ROW_REREAD_LIVE,
  ROW_REREAD_PENDING,
  ROW_REREAD_REFUSED,
  SEQUENCE_NOT_RESUMABLE_LATCHED_OUTCOME,
  SEQUENCE_NOT_RESUMABLE_LOST_RACE_OUTCOME,
  SEQUENCE_NOT_RESUMABLE_PENDING_OUTCOME,
  SPAWN_ACTION_FRESH_RETIRED,
  SPAWN_ACTION_RETRYING,
  spawnNotResumableLine,
  startLiveRowSequence,
  sweepDeadTmuxChannel,
  thisLaunchRowOf,
  type PersonaRowReread,
  type SpawnPersonaResult,
} from '../src/session-manager.ts'
import {
  isInsideAttempt,
  runInAttempt,
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
  UNAVAILABLE_RETRY_CAUSE_PENDING_ROW,
  UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION,
  UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED,
  UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED,
  UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
  UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  type AttemptView,
} from '../src/unavailable-retry.ts'
import { raiseAdConfigMalformed } from '../src/outage-state.ts'
import {
  cannedErr,
  cannedFindMissing,
  cannedGetResult,
  cannedKillResult,
  cannedOk,
  cannedStatusResult,
  errCallTimeout,
  errConfigMalformed,
  errCwdNotFound,
  errGeneric,
  errInstanceIdCollision,
  errInvalidFlags,
  errInternal,
  errSpawnNotFound,
  errSpawnNotResumable,
  errSystemInstallDisappeared,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSendKeys,
  errTmuxSessionConflict,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  errUnknownErrorName,
  errUnusableName,
  holdFindMissing,
  KILL_FAILED_DESCRIPTIONS,
  SAMPLE_LAUNCH_START_DEFAULT,
  SAMPLE_LAUNCH_START_FRACTIONAL,
  SAMPLE_LAUNCH_START_NONE,
  SAMPLE_LAUNCH_START_WHOLE,
  STUB_SURVIVOR_PIDS,
  type FindMissingRowPlacement,
  type PersonaGetResultOverrides,
} from './test-helpers/agent-director-stub.ts'
import { UNPARSEABLE_LAUNCH_START, reuseSpawnScanRows, sequenceResumeConflictRowsAt } from './test-helpers/conflict-cases.ts'
import { LATCH_ROW_STATE_NO_ROW, REFUSED_OPERATION_RESUME, latchRowStateRead } from '../src/conflict-latch.ts'
import { OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import { INVALID_FLAGS_HOLD_ALERT_TEXT } from '../src/invalid-flags-hold.ts'
import { AD_VERSION_RECHECK_STOP_EXIT_CODE } from '../src/ad-version-gate.ts'
import { errNoSessionId } from './test-helpers/agent-director-stub.ts'
import { readRetiredKeysRecord } from './test-helpers/retired-keys.ts'
import { assertNoLeak, isTokenLike, LEAK_SENTINEL, REDACTED_SENTINEL_TAIL, sentinelInMessage } from './test-helpers/credentials.ts'
import { forbiddenServerLoads } from './test-helpers/source-audit.ts'
import {
  callsBeforeSequenceKill,
  holdSequenceReuse,
  killFailureEndedLine,
  killFailureHeldLine,
  killFailureLines,
  killFailureLoggedLine,
  killFailureNotice,
  killFailurePostedLine,
  killFailureRecoveryEntry,
  LATE_KILL_ANSWERS,
  makeRecoveryHarness,
  ordinaryAlertContent,
  ownRowsLiveThenMissing,
  pastSampleGrace,
  personaCallCounts,
  personaRow,
  recordCallOrder,
  retryNow,
  reuseSpawnOf,
  runSequenceStoppedAtKill,
  scriptSequenceKillFailure,
  scriptTimedLaunch,
  startSequenceHeldAtRun,
  startupEntriesOf,
  survivorAlertContent,
  unavailableAt,
  unclassifiedStartedLines,
  expectUntouched,
  expectPendingOnlyWatch,
  dispatcherBugWordingIn,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
  type RecoverySequenceRequest,
  type TimedLaunchOptions,
} from './test-helpers/recovery-harness.ts'
import { PRE_PERSONA_ID, PRE_PERSONA_LABELS, PRE_PERSONA_SESSION } from './test-helpers/old-life.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Every harness of this file, checked and cleaned up in `afterEach`. */
let harnesses: RecoveryHarness[] = []

afterEach(() => {
  const built = harnesses
  harnesses = []
  _resetNow()
  for (const h of built) {
    try {
      // b.jg5 SRJ-106, SRJ-705: no call deletes a row or sets include_finished.
      expect(h.stub.calls.deleteCalls).toEqual([])
      const everyCall = Object.values(h.stub.calls).flat() as unknown[]
      expect(everyCall.filter((params) => typeof params === 'object' && params !== null && 'include_finished' in params)).toEqual([])
      // b.jg5 SRJ-713: no post or line, a collision's included, calls anything a "dispatcher bug".
      expect(dispatcherBugWordingIn(h)).toEqual([])
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
  }
})

/** A recovery harness over two personas, P and Q, cleaned up in `afterEach`. */
function build(options?: RecoveryHarnessOptions): { h: RecoveryHarness; p: string; q: string } {
  const h = makeRecoveryHarness(options)
  harnesses.push(h)
  const [p, q] = h.keys as [string, string]
  return { h, p, q }
}

/** The state the stub's default row reads: a live state other than `pending` (`waiting`). */
const LIVE = cannedStatusResult().state
const PENDING = AGENT_DIRECTOR_PENDING_STATE
const ENDED = LIVENESS_DEAD_ROW_ENDED
const MISSING = LIVENESS_DEAD_ROW_MISSING

/** The default sample launch start, in ms. */
const LAUNCH_START_MS = parseLaunchStart(SAMPLE_LAUNCH_START_DEFAULT)!

/** A `find-missing` result that places persona `key`'s row `where`. */
function placed(key: string, where: FindMissingRowPlacement): FindMissingResult {
  return cannedFindMissing({ rows: { [personaInstanceId(key)]: where } })
}

/** The stub's `get` answers, in order: a row, or an error to reject with. */
function gets(h: RecoveryHarness, ...answers: Array<Phase1GetResult | Error>): void {
  h.script({ getQueue: answers.map((answer) => (answer instanceof Error ? cannedErr(answer) : cannedOk(answer))) })
}

/** The stub's `find-missing` answers, in order: a result, or an error to reject with. */
function runs(h: RecoveryHarness, ...answers: Array<FindMissingResult | Error>): void {
  h.script({ findMissingQueue: answers.map((answer) => (answer instanceof Error ? cannedErr(answer) : cannedOk(answer))) })
}

/** Wrap every verb of the stub client so each call also records its verb and the clock time; answers the record. */
function recordCallTimes(h: RecoveryHarness): Array<readonly [string, number]> {
  const calls: Array<readonly [string, number]> = []
  const client = h.stub.client as unknown as Record<string, unknown>
  for (const name of Object.keys(client)) {
    const verb = client[name]
    if (typeof verb !== 'function') continue
    client[name] = (...args: unknown[]): unknown => {
      calls.push([name, h.clock.now()])
      return (verb as (...a: unknown[]) => unknown).apply(client, args)
    }
  }
  return calls
}

/** Move the clock to `at` (no timer is pending yet). */
async function clockAt(h: RecoveryHarness, at: number): Promise<void> {
  expect(h.clock.pendingCount()).toBe(0)
  await h.clock.advanceTo(at)
}

/** The calls of a step-3 run and its `get`, `count` times. */
const runAndGet = (count: number): string[] => Array.from({ length: count }, () => ['findMissing', 'get']).flat()

/** The verbs the dialog approver calls on a launched persona's row (b.jg5 SRJ-401). */
const APPROVER_VERBS: readonly string[] = ['status', 'readPane', 'sendKeys']

/**
 * The calls `order` holds are exactly `expected`, which ends with the launch
 * call, and then only the dialog approver's, which a launch that returned
 * success starts on its own (b.jg5 SRJ-401): no further launch, kill, run
 * or `get`.
 */
function expectCallsThenApprover(order: readonly string[], expected: readonly string[]): void {
  expect(order.slice(0, expected.length)).toEqual([...expected])
  expect(order.slice(expected.length).filter((verb) => !APPROVER_VERBS.includes(verb))).toEqual([])
}

/**
 * Exactly one spawn, persona `key`'s reuse spawn (b.jg5 SRJ-112, SRJ-708):
 * one stub `spawn` of `cscb_<key>` carrying the reuse flag and the persona's
 * `extra_env`, and no plain spawn.
 */
function expectOneReuseOf(h: RecoveryHarness, key: string): void {
  expect(h.reuseSpawns()).toEqual([reuseSpawnOf(h, key)])
  expect(h.stub.calls.spawnCalls).toEqual([...h.reuseSpawns()])
}

/** The persona's kill-failure posts at its destination (`episodeNotices` holds every episode kind's posts). */
function killFailurePosts(h: RecoveryHarness, key: string): string[] {
  return killFailureLines(h, key).filter((line) => line.includes(' alert posted to its destination '))
}

/**
 * P's sequence (the harness's first persona) ended and armed P's retry timer
 * once with `cause`, through the trigger sink (b.jg5 SRJ-301): the outcome's
 * `armed` is that cause, the controller's own label, and its one end line
 * names it; the triggers are `before` (what P's failed calls sent first),
 * then `cause`; only P is armed, nothing is counted for P or Q, and no
 * spawn-failure notice is posted.
 */
function expectEndArmed(h: RecoveryHarness, outcome: LiveRowSequenceOutcome, cause: string, before: readonly string[] = []): void {
  const [p, q] = h.keys as [string, string]
  expect<string | undefined>(outcome.armed).toBe(cause)
  const endLine = liveRowSequenceEndLine(`persona=${p}`, outcome)
  expect(endLine).toContain(`the retry timer armed (${cause})`)
  expect(h.lines.filter((line) => line === endLine)).toHaveLength(1)
  expect(h.triggers).toEqual([...before, cause].map((kind) => ({ key: p, kind })))
  expect(h.controller.view(p)?.causes).toContain(cause)
  expect(h.controller.armedKeys()).toEqual([p])
  expect([getFailureCount(p), getFailureCount(q)]).toEqual([0, 0])
  expect(h.notices).toEqual([])
}

/**
 * Run one sequence for persona `key` as `startSequence` would by default
 * (step 1, a row last read live, ending in a launch, the recovery context),
 * inside its recovery attempt, over the harness's dependencies with `replaced`
 * members and over `stop`; driven to its end.
 */
function runWithDeps(
  h: RecoveryHarness,
  key: string,
  stop: LiveRowSequenceStopHandle,
  replaced: Partial<LiveRowSequenceDeps>,
  requested: Partial<LiveRowSequenceRequest> = {},
): Promise<LiveRowSequenceOutcome> {
  return h.driveSequence(startWithDeps(h, key, stop, replaced, requested))
}

/** As `runWithDeps`, but not driven: the case moves the clock itself. */
function startWithDeps(
  h: RecoveryHarness,
  key: string,
  stop: LiveRowSequenceStopHandle,
  replaced: Partial<LiveRowSequenceDeps>,
  requested: Partial<LiveRowSequenceRequest> = {},
): Promise<LiveRowSequenceOutcome> {
  const request: LiveRowSequenceRequest = {
    key,
    instanceId: personaInstanceId(key),
    lastReadState: LIVE,
    entryStep: LIVE_ROW_SEQUENCE_ENTRY_KILL,
    keepsConversation: false,
    retiredKey: false,
    launches: true,
    alertContext: KILL_FAILURE_CONTEXT_RECOVERY,
    ...requested,
  }
  return runInAttempt(key, 'recovery', () => runLiveRowSequence(request, { ...h.sequenceDeps, ...replaced }, stop))
}

// ---------------------------------------------------------------------------
// Pacing and limits (AC 61)
// ---------------------------------------------------------------------------

describe('pacing and limits: one kill, three runs spaced apart, a second kill, the pause, a fourth run; then the alert (AC 61)', () => {
  test('a live row each run leaves in unverified_ids: the calls in order at the exported spacing and pause, the maxima, one get after each run, then exactly one ordinary alert with no description and the not-latched closing, and no launch', async () => {
    const { h, p } = build()
    const id = personaInstanceId(p)
    h.script({ getResult: personaRow(h, p), findMissingResult: placed(p, 'unverified_ids') })
    const calls = recordCallTimes(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    const S = LIVE_ROW_SEQUENCE_RUN_SPACING_MS
    const lastRunAt = (LIVE_ROW_SEQUENCE_STEP3_RUNS - 1) * S
    expect(calls).toEqual([
      ['kill', 0],
      ['get', 0],
      ...Array.from({ length: LIVE_ROW_SEQUENCE_STEP3_RUNS }, (_, run) => [['findMissing', run * S], ['get', run * S]] as const).flat(),
      ['kill', lastRunAt],
      ['findMissing', lastRunAt + LIVE_ROW_SEQUENCE_STEP4_PAUSE_MS],
      ['get', lastRunAt + LIVE_ROW_SEQUENCE_STEP4_PAUSE_MS],
    ])
    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_ESCALATED,
      runs: LIVE_ROW_SEQUENCE_MAX_RUNS,
      kills: LIVE_ROW_SEQUENCE_MAX_KILLS,
      judgedRuns: LIVE_ROW_SEQUENCE_MAX_RUNS,
      armed: LIVE_ROW_ARM_ENDED,
    })
    // Every read and run has the shared entries' shape: P's own instance, a whole-store run.
    expect(h.stub.calls.getCalls).toEqual(Array.from({ length: LIVE_ROW_SEQUENCE_MAX_RUNS + 1 }, () => ({ claude_instance_id: id })))
    expect(h.stub.calls.killCalls).toEqual(Array.from({ length: LIVE_ROW_SEQUENCE_MAX_KILLS }, () => ({ claude_instance_id: id })))
    expect(h.stub.calls.findMissingCalls).toEqual(Array.from({ length: LIVE_ROW_SEQUENCE_MAX_RUNS }, () => ({})))
    expect(h.stub.calls.statusCalls).toEqual([])
    expect(h.episodeNotices).toEqual([killFailureNotice(p, ordinaryAlertContent(p), KILL_FAILURE_CLOSING_DESTINATION)])
    expect([h.stub.calls.resumeCalls, h.stub.calls.spawnCalls]).toEqual([[], []])
  })

  test('a live row other than pending that every run leaves in neither list is judged alive by each run and reaches the alert; the escalation arms P\'s timer with the other-end cause (SRJ-301)', async () => {
    const { h, p } = build()
    h.script({ getResult: personaRow(h, p) })

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_ESCALATED,
      runs: LIVE_ROW_SEQUENCE_MAX_RUNS,
      kills: LIVE_ROW_SEQUENCE_MAX_KILLS,
      judgedRuns: LIVE_ROW_SEQUENCE_MAX_RUNS,
      armed: LIVE_ROW_ARM_ENDED,
    })
    expect(h.episodeNotices).toEqual([killFailureNotice(p, ordinaryAlertContent(p))])
    expectEndArmed(h, outcome, UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED)
  })

  test('each run bypasses the memo: with a fresh result from an ordinary run inside the memo window, every sequence run still makes a new find-missing call', async () => {
    const { h, p } = build()
    _setNow(h.clock.now)
    h.script({ getResult: personaRow(h, p) })
    await sweepDeadTmuxChannel(p, ESCALATE_DEAD_WAITING_ROW_PANE_GONE)
    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    // An ordinary run now reuses the memo: no new call.
    await sweepDeadTmuxChannel(p, ESCALATE_DEAD_WAITING_ROW_PANE_GONE)
    expect(h.stub.calls.findMissingCalls).toHaveLength(1)

    await h.runSequence(p, { lastReadState: LIVE })

    expect(h.stub.calls.findMissingCalls).toHaveLength(1 + LIVE_ROW_SEQUENCE_MAX_RUNS)
  })
})

// ---------------------------------------------------------------------------
// Step exits: a get after a run reading ended, missing or no row goes to step 6
// ---------------------------------------------------------------------------

/** The `get` answers that go to step 6: `ended`, `missing` and no row (`ErrSpawnNotFound`, SRJ-114). */
const FINISHED_READS: ReadonlyArray<readonly [string, (h: RecoveryHarness, key: string) => Phase1GetResult | Error]> = [
  [ENDED, (h, key) => personaRow(h, key, { state: ENDED })],
  [MISSING, (h, key) => personaRow(h, key, { state: MISSING })],
  ['no row (ErrSpawnNotFound)', () => errSpawnNotFound()],
]

/** Each run whose `get` can read the row finished: 1 to 3 at step 3, then step 4's. */
const EXIT_RUNS = Array.from({ length: LIVE_ROW_SEQUENCE_MAX_RUNS }, (_, i) => i + 1)

describe('step exits: a get after a run reading the row finished goes to step 6 (SRJ-705 steps 3 and 4)', () => {
  test.each(EXIT_RUNS.flatMap((run) => FINISHED_READS.map(([label, read]) => [run, label, read] as const)))(
    'the get after run %d reads %s: no further run or kill, no alert, and the launch: one reuse spawn of the same id',
    async (run, _label, read) => {
      const { h, p } = build()
      // Step 2's get and each earlier run's read the row live; the run's own get reads it finished.
      gets(h, ...Array.from({ length: run }, () => personaRow(h, p)), read(h, p))
      const order = recordCallOrder(h)

      const outcome = await h.runSequence(p, { lastReadState: LIVE })

      const kills = run > LIVE_ROW_SEQUENCE_STEP3_RUNS ? LIVE_ROW_SEQUENCE_MAX_KILLS : 1
      expectCallsThenApprover(order, [
        'kill',
        'get',
        ...runAndGet(Math.min(run, LIVE_ROW_SEQUENCE_STEP3_RUNS)),
        ...(run > LIVE_ROW_SEQUENCE_STEP3_RUNS ? ['kill', ...runAndGet(1)] : []),
        'spawn',
      ])
      expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, runs: run, kills, judgedRuns: run, result: { key: p, action: 'spawned' } })
      expect(outcome.armed).toBeUndefined()
      expectOneReuseOf(h, p)
      expect(h.episodeNotices).toEqual([])
    },
  )

  test.each(FINISHED_READS)('a step-2 get reading %s still leads to one run at once, then its get, then the launch', async (_label, read) => {
    const { h, p } = build()
    gets(h, read(h, p), read(h, p))
    const calls = recordCallTimes(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(calls.slice(0, 5)).toEqual([['kill', 0], ['get', 0], ['findMissing', 0], ['get', 0], ['spawn', 0]])
    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, runs: 1, kills: 1 })
    expectOneReuseOf(h, p)
  })
})

// ---------------------------------------------------------------------------
// The pending wait (SRJ-705 step 2, SRJ-406, SRJ-210; the E6 note)
// ---------------------------------------------------------------------------

describe('the pending wait: until G past the launch start, never early (SRJ-705 step 2, SRJ-406, SRJ-210)', () => {
  /**
   * Persona `key`'s `pending` row with `launchStart` at step 2, then a first
   * run that marks it missing and a `get` that reads it so: the launch
   * follows the first run.
   */
  function pendingThenMarkedMissing(h: RecoveryHarness, key: string, row: PersonaGetResultOverrides): void {
    gets(h, personaRow(h, key, { state: PENDING, ...row }), personaRow(h, key, { state: MISSING }))
    runs(h, placed(key, 'ids'))
  }

  /** The clock time of each `find-missing` call. */
  function runTimes(h: RecoveryHarness): number[] {
    const times: number[] = []
    const findMissing = h.stub.client.findMissing.bind(h.stub.client)
    h.stub.client.findMissing = async (params) => {
      times.push(h.clock.now())
      return findMissing(params)
    }
    return times
  }

  test.each([
    ['with fractional seconds', SAMPLE_LAUNCH_START_FRACTIONAL],
    ['in whole seconds', SAMPLE_LAUNCH_START_WHOLE],
  ])('a launch start %s: no run before G from the launch start; the first exactly at that deadline', async (_label, launchStart) => {
    const { h, p } = build()
    const launchStartMs = parseLaunchStart(launchStart)!
    await clockAt(h, launchStartMs)
    pendingThenMarkedMissing(h, p, { launch_started_at: launchStart })
    const times = runTimes(h)

    const outcome = await h.runSequence(p, { lastReadState: PENDING, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })

    expect(times).toEqual([launchStartMs + adGraceMsInEffect()])
    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, runs: 1, kills: 0, judgedRuns: 1 })
  })

  test('a resumed row whose started_at is older than G still waits from its launch start', async () => {
    const { h, p } = build()
    const grace = adGraceMsInEffect()
    await clockAt(h, LAUNCH_START_MS)
    pendingThenMarkedMissing(h, p, { started_at: new Date(LAUNCH_START_MS - 2 * grace).toISOString() })
    const times = runTimes(h)

    await h.runSequence(p, { lastReadState: PENDING, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })

    expect(times).toEqual([LAUNCH_START_MS + grace])
  })

  test('raising the grace setting while the wait is armed moves the deadline, never earlier', async () => {
    const { h, p } = build()
    const grace = adGraceMsInEffect()
    await clockAt(h, LAUNCH_START_MS)
    pendingThenMarkedMissing(h, p, {})
    const times = runTimes(h)
    const run = h.startSequence(p, { lastReadState: PENDING, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })
    await h.clock.flush()
    expect(h.clock.pending().map((timer) => timer.dueAt)).toEqual([LAUNCH_START_MS + grace])

    const raised = DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds * 2n
    h.rewriteAdSettings({ tmux: { pending_grace_seconds: raised } })
    await h.driveSequence(run.outcome)

    expect(adGraceMsInEffect()).toBe(Number(raised) * 1000)
    expect(times).toEqual([LAUNCH_START_MS + adGraceMsInEffect()])
  })

  test('a launch start already older than G arms a wait that asks for no delay, and the first run follows it', async () => {
    const { h, p } = build()
    await pastSampleGrace(h)
    pendingThenMarkedMissing(h, p, {})
    const run = h.startSequence(p, { lastReadState: PENDING, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })
    await h.clock.flush()

    expect(h.clock.pending().map((timer) => timer.delayMs)).toEqual([0])
    expect(h.stub.calls.findMissingCalls).toEqual([])
    expect(await h.driveSequence(run.outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, runs: 1 })
  })

  test('a G beyond the timer maximum fires nothing early: one pending timer at a time, none above the maximum, the first run exactly at the deadline', async () => {
    const pendingGrace = (BigInt(MAX_TIMER_DELAY_MS) / 1000n + 1n) * 2n
    const { h, p } = build({ adSettings: { tmux: { pending_grace_seconds: pendingGrace } } })
    const grace = adGraceMsInEffect()
    expect(grace).toBeGreaterThan(MAX_TIMER_DELAY_MS)
    await clockAt(h, LAUNCH_START_MS)
    pendingThenMarkedMissing(h, p, {})
    const times = runTimes(h)
    const run = h.startSequence(p, { lastReadState: PENDING, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })
    await h.clock.flush()

    let fires = 0
    while (times.length === 0) {
      const pending = h.clock.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0]!.delayMs).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
      expect(h.clock.now()).toBeLessThan(LAUNCH_START_MS + grace)
      await h.clock.runNext()
      fires++
    }

    expect(fires).toBe(Math.ceil(grace / MAX_TIMER_DELAY_MS))
    expect(times).toEqual([LAUNCH_START_MS + grace])
    expect(await h.driveSequence(run.outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, runs: 1 })
  })

  // SRJ-210: G that cannot be read while arming never ends the wait early.
  // (An accessor that goes bad after arming is `armNeverEarlyWait`'s, in
  // tests/ad-settings.test.ts.)

  /** The repository root: no log line may carry it (a stack frame's file path). */
  const REPO_ROOT = resolve(import.meta.dir, '..')

  /** A G accessor that cannot be read while arming. */
  const UNREADABLE_G: ReadonlyArray<readonly [string, () => number]> = [
    ['throws', () => {
      throw new Error('G could not be read')
    }],
    ['answers NaN', () => Number.NaN],
  ]

  /**
   * Persona `key`'s arm-failed lines in `h`: lines equal to the builder's
   * line over what arming over `unreadable` throws, described by its name and
   * its message only (no stack frame, so no absolute file path).
   */
  function armFailedLines(h: RecoveryHarness, key: string, unreadable: () => number): string[] {
    const expected = armFailedLine(h, key, unreadable)
    return h.lines.filter((line) => line === expected)
  }

  /** Persona `key`'s arm-failed line for what arming over `unreadable` throws (see `armFailedLines`). */
  function armFailedLine(h: RecoveryHarness, key: string, unreadable: () => number): string {
    let thrown: Error | undefined
    try {
      armNeverEarlyWait(h.clock, LAUNCH_START_MS, unreadable, () => {})
    } catch (err) {
      thrown = err as Error
    }
    if (thrown === undefined) throw new Error('the accessor armed a wait')
    return liveRowSequenceWaitArmFailedLine(`persona=${key}`, `${thrown.name} ${describeLogMessage(thrown.message)}`)
  }

  /** Persona `key`'s step-2 armed lines in `h` for a launch start of `LAUNCH_START_MS` (any G). */
  function armedLines(h: RecoveryHarness, key: string): string[] {
    const head = liveRowSequenceWaitArmedLine(`persona=${key}`, LAUNCH_START_MS, Number.NaN).split('G=')[0]!
    return h.lines.filter((line) => line.startsWith(`${head}G=`))
  }

  /** Every `step 2: ` line of persona `key` in `h` (the wait's armed, arm-failed and ended lines). */
  function step2Lines(h: RecoveryHarness, key: string): string[] {
    const head = liveRowSequenceWaitArmFailedLine(`persona=${key}`, '').split(': step 2: ')[0]!
    return h.lines.filter((line) => line.startsWith(`${head}: step 2: `))
  }

  /** Persona `key`'s sequence entered at step 2 on its `pending` row, over the G accessor `graceMs`; not driven. */
  function startOnPendingRow(h: RecoveryHarness, key: string, stop: LiveRowSequenceStopHandle, graceMs: () => number): Promise<LiveRowSequenceOutcome> {
    return startWithDeps(h, key, stop, { graceMs }, { lastReadState: PENDING, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })
  }

  test.each(UNREADABLE_G)('a G accessor that %s while arming: one line at the first failure and no run, the arm tried again every re-arm wait with no line inside the log spacing; once G reads, the first run comes exactly at G past the launch start', async (_label, unreadable) => {
    const { h, p } = build()
    const REARMS = 2
    expect((REARMS + 1) * LIVE_ROW_SEQUENCE_GRACE_REARM_MS).toBeLessThan(adGraceMsInEffect())
    expect(REARMS * LIVE_ROW_SEQUENCE_GRACE_REARM_MS).toBeLessThan(LIVE_ROW_SEQUENCE_GRACE_REARM_LOG_SPACING_MS)
    await clockAt(h, LAUNCH_START_MS)
    pendingThenMarkedMissing(h, p, {})
    const times = runTimes(h)
    let readable = false
    const outcome = startOnPendingRow(h, p, createLiveRowSequenceStop(), () => (readable ? adGraceMsInEffect() : unreadable()))
    await h.clock.flush()

    for (let rearm = 0; rearm < REARMS; rearm++) {
      expect(h.clock.pending().map((timer) => timer.delayMs)).toEqual([LIVE_ROW_SEQUENCE_GRACE_REARM_MS])
      await h.clock.runNext()
    }
    expect(armFailedLines(h, p, unreadable)).toHaveLength(1)
    expect(times).toEqual([])

    readable = true
    expect(await h.driveSequence(outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, runs: 1 })
    expect(times).toEqual([LAUNCH_START_MS + adGraceMsInEffect()])
    expect(armFailedLines(h, p, unreadable)).toHaveLength(1)
  })

  test.each(UNREADABLE_G)('a G accessor that %s while arming: the armed line names G as unreadable with no deadline, and no G line carries a stack frame or a file path', async (_label, unreadable) => {
    const { h, p } = build()
    await clockAt(h, LAUNCH_START_MS)
    pendingThenMarkedMissing(h, p, {})
    const stop = createLiveRowSequenceStop()
    const outcome = startOnPendingRow(h, p, stop, unreadable)
    await h.clock.flush()
    await h.clock.runNext()

    expect(armedLines(h, p)).toEqual([liveRowSequenceWaitArmedLine(`persona=${p}`, LAUNCH_START_MS, Number.NaN)])
    expect(armedLines(h, p)[0]).toContain(`G=${LIVE_ROW_SEQUENCE_GRACE_UNREADABLE_TEXT})`)
    expect(armedLines(h, p)[0]).not.toContain(LIVE_ROW_SEQUENCE_GRACE_NEVER_ENDS_TEXT)
    expect(armedLines(h, p)[0]).not.toContain('deadline=')
    expect(armFailedLines(h, p, unreadable)).toHaveLength(1)
    const lines = step2Lines(h, p)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line).not.toContain(' at ')
      expect(line).not.toContain(' <- ')
      expect(line).not.toMatch(/\.[cm]?[jt]s:\d+/)
      expect(line).not.toContain(REPO_ROOT)
    }

    stop.stop(LIVE_ROW_STOP_TEARDOWN)
    expect(await h.driveSequence(outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN, runs: 0 })
  })

  test('a G accessor at AD_WAIT_NEVER_ENDS: the armed line names G as beyond any wait with no deadline; the wait arms (no arm-failed line, no re-arm) and never runs', async () => {
    const { h, p } = build()
    await clockAt(h, LAUNCH_START_MS)
    pendingThenMarkedMissing(h, p, {})
    const times = runTimes(h)
    const stop = createLiveRowSequenceStop()
    const outcome = startOnPendingRow(h, p, stop, () => AD_WAIT_NEVER_ENDS)
    await h.clock.flush()
    await h.clock.runNext()

    expect(armedLines(h, p)).toEqual([liveRowSequenceWaitArmedLine(`persona=${p}`, LAUNCH_START_MS, AD_WAIT_NEVER_ENDS)])
    expect(armedLines(h, p)[0]).toContain(`G=${LIVE_ROW_SEQUENCE_GRACE_NEVER_ENDS_TEXT})`)
    expect(armedLines(h, p)[0]).not.toContain(LIVE_ROW_SEQUENCE_GRACE_UNREADABLE_TEXT)
    expect(armedLines(h, p)[0]).not.toContain('deadline=')
    expect(step2Lines(h, p)).toEqual(armedLines(h, p))
    expect(h.clock.pending().map((timer) => timer.delayMs)).toEqual([MAX_TIMER_DELAY_MS])
    expect(times).toEqual([])

    stop.stop(LIVE_ROW_STOP_TEARDOWN)
    expect(await h.driveSequence(outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN, runs: 0 })
    expect(h.clock.pendingCount()).toBe(0)
  })

  test.each(UNREADABLE_G)('a G accessor that %s while arming, long past G: no run or other call, one timer at a time, its line once per log spacing from the first failure; a stop ends the wait as stopped and leaves no timer', async (_label, unreadable) => {
    const { h, p } = build()
    await clockAt(h, LAUNCH_START_MS)
    pendingThenMarkedMissing(h, p, {})
    const calls = recordCallTimes(h)
    const stop = createLiveRowSequenceStop()
    const outcome = startOnPendingRow(h, p, stop, unreadable)
    await h.clock.flush()

    // The clock time of each arm-failed line: the re-arm wait divides the spacing, so a try falls on each spacing.
    expect(LIVE_ROW_SEQUENCE_GRACE_REARM_LOG_SPACING_MS % LIVE_ROW_SEQUENCE_GRACE_REARM_MS).toBe(0)
    expect(armFailedLines(h, p, unreadable)).toHaveLength(1)
    const loggedAt = [h.clock.now()]
    while (h.clock.now() < LAUNCH_START_MS + 2 * adGraceMsInEffect()) {
      expect(h.clock.pending().map((timer) => timer.delayMs)).toEqual([LIVE_ROW_SEQUENCE_GRACE_REARM_MS])
      const before = armFailedLines(h, p, unreadable).length
      await h.clock.runNext()
      if (armFailedLines(h, p, unreadable).length > before) loggedAt.push(h.clock.now())
    }
    expect(calls).toEqual([['get', LAUNCH_START_MS]])
    const spacings = Math.floor((h.clock.now() - LAUNCH_START_MS) / LIVE_ROW_SEQUENCE_GRACE_REARM_LOG_SPACING_MS)
    expect(spacings).toBeGreaterThan(1)
    expect(loggedAt).toEqual(Array.from({ length: spacings + 1 }, (_, i) => LAUNCH_START_MS + i * LIVE_ROW_SEQUENCE_GRACE_REARM_LOG_SPACING_MS))
    expect(armFailedLines(h, p, unreadable)).toHaveLength(loggedAt.length)

    stop.stop(LIVE_ROW_STOP_TEARDOWN)

    expect(await h.driveSequence(outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN, runs: 0, kills: 0 })
    expect(h.clock.pendingCount()).toBe(0)
    expect(calls).toEqual([['get', LAUNCH_START_MS]])
  })

  /** The unreadable G accessors by label (see `UNREADABLE_G`). */
  const unreadableG = (label: string): (() => number) => UNREADABLE_G.find(([name]) => name === label)![1]

  test('a G accessor whose failure changes while arming: a line at each failure whose description differs from the last one logged, inside the log spacing, and none for a repeat', async () => {
    const { h, p } = build()
    await clockAt(h, LAUNCH_START_MS)
    pendingThenMarkedMissing(h, p, {})
    const throws = unreadableG('throws')
    const nan = unreadableG('answers NaN')
    // One accessor per try: throws, throws, NaN, NaN, throws.
    const tries = [throws, throws, nan, nan, throws]
    expect((tries.length - 1) * LIVE_ROW_SEQUENCE_GRACE_REARM_MS).toBeLessThan(LIVE_ROW_SEQUENCE_GRACE_REARM_LOG_SPACING_MS)
    let at = 0
    const stop = createLiveRowSequenceStop()
    const outcome = startOnPendingRow(h, p, stop, () => tries[Math.min(at, tries.length - 1)]!())
    await h.clock.flush()
    for (at = 1; at < tries.length; at++) await h.clock.runNext()

    const thrownLine = armFailedLine(h, p, throws)
    const nanLine = armFailedLine(h, p, nan)
    expect(thrownLine).not.toBe(nanLine)
    expect(h.lines.filter((line) => line === thrownLine || line === nanLine)).toEqual([thrownLine, nanLine, thrownLine])
    expect(h.clock.pending().map((timer) => timer.delayMs)).toEqual([LIVE_ROW_SEQUENCE_GRACE_REARM_MS])

    stop.stop(LIVE_ROW_STOP_TEARDOWN)
    expect(await h.driveSequence(outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN, runs: 0 })
    expect(h.clock.pendingCount()).toBe(0)
  })

  test('a clock that cannot be read while G cannot either: the first failure\'s line and then a changed failure\'s only, never a spacing line; the re-arms go on', async () => {
    const { h, p } = build()
    await clockAt(h, LAUNCH_START_MS)
    pendingThenMarkedMissing(h, p, {})
    const clock: LiveRowSequenceDeps['clock'] = {
      now: () => {
        throw new Error('the clock could not be read')
      },
      setTimeout: (callback, ms) => h.clock.setTimeout(callback, ms),
      clearTimeout: (handle) => h.clock.clearTimeout(handle),
    }
    const throws = unreadableG('throws')
    const nan = unreadableG('answers NaN')
    let unreadable = throws
    const stop = createLiveRowSequenceStop()
    const outcome = startWithDeps(h, p, stop, { clock, graceMs: () => unreadable() }, { lastReadState: PENDING, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })
    await h.clock.flush()

    // Past two log spacings on the harness clock, re-arming all the while.
    const rearmsPast = (spacings: number): number => (spacings * LIVE_ROW_SEQUENCE_GRACE_REARM_LOG_SPACING_MS) / LIVE_ROW_SEQUENCE_GRACE_REARM_MS + 1
    const rearm = async (count: number): Promise<void> => {
      for (let i = 0; i < count; i++) {
        expect(h.clock.pending().map((timer) => timer.delayMs)).toEqual([LIVE_ROW_SEQUENCE_GRACE_REARM_MS])
        await h.clock.runNext()
      }
    }
    await rearm(rearmsPast(2))
    expect(armFailedLines(h, p, throws)).toHaveLength(1)

    unreadable = nan
    await rearm(rearmsPast(2))
    expect(armFailedLines(h, p, nan)).toHaveLength(1)
    expect(armFailedLines(h, p, throws)).toHaveLength(1)

    stop.stop(LIVE_ROW_STOP_TEARDOWN)
    expect(await h.driveSequence(outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN, runs: 0 })
    expect(h.clock.pendingCount()).toBe(0)
  })

  test.each([
    ['absent', SAMPLE_LAUNCH_START_NONE],
    ['unparsable', UNPARSEABLE_LAUNCH_START],
  ])('an old key\'s pending row whose launch start is %s: no wait and no RangeError; the runs start at once', async (_label, launchStart) => {
    const { h, p } = build()
    h.remove(p)
    pendingThenMarkedMissing(h, p, { launch_started_at: launchStart })
    const calls = recordCallTimes(h)

    const outcome = await h.runSequence(p, { lastReadState: PENDING })

    expect(calls).toEqual([['kill', 0], ['get', 0], ['findMissing', 0], ['get', 0]])
    // The key is not in the applied configuration: no launch, and no one latched.
    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_NOT_LAUNCHED, notLaunched: LIVE_ROW_NOT_LAUNCHED_NOT_APPLIED, runs: 1 })
    expect(h.latch.isLatched(p)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The not-judged stop (SRJ-717; AC 62, AC 84)
// ---------------------------------------------------------------------------

describe('a run that leaves a pending row in neither list did not judge it: the episode stops at once (SRJ-717, AC 62)', () => {
  test.each([
    ['a step-3 run', 1, ['kill', 'get', 'findMissing']],
    ["step 4's run", LIVE_ROW_SEQUENCE_MAX_RUNS, ['kill', 'get', ...runAndGet(LIVE_ROW_SEQUENCE_STEP3_RUNS), 'kill', 'findMissing']],
  ] as const)('%s leaves the pending row in neither list: no further run or kill, no alert, nothing counted, no launch; P\'s timer armed with the not-judged cause', async (_label, run, calls) => {
    const { h, p } = build()
    await pastSampleGrace(h)
    h.script({ getResult: personaRow(h, p, { state: PENDING }) })
    runs(h, ...Array.from({ length: run - 1 }, () => placed(p, 'unverified_ids')), placed(p, 'neither'))
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: PENDING })

    const step = run > LIVE_ROW_SEQUENCE_STEP3_RUNS ? 4 : 3
    expect(order).toEqual([...calls])
    // The run's one line, with one tag group, which names SRJ-717.
    const runLine = liveRowSequenceRunLine(`persona=${p}`, step, run, LIVE_ROW_RUN_NOT_JUDGED)
    expect(h.lines.filter((line) => line === runLine)).toHaveLength(1)
    expect(runLine.match(/\(b\.jg5 [^)]*\)/g)).toEqual([expect.stringContaining('SRJ-717')])
    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_NOT_JUDGED,
      step,
      runs: run,
      kills: run > LIVE_ROW_SEQUENCE_STEP3_RUNS ? LIVE_ROW_SEQUENCE_MAX_KILLS : 1,
      judgedRuns: run - 1,
      armed: LIVE_ROW_ARM_NOT_JUDGED,
    })
    expect(h.episodeNotices).toEqual([])
    expect(killFailureLines(h, p)).toEqual([])
    expect([h.stub.calls.resumeCalls, h.stub.calls.spawnCalls]).toEqual([[], []])
    expectEndArmed(h, outcome, UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED)
  })

  test('runs that put the pending row in unverified_ids while it stays live judged it: the sequence reaches the alert', async () => {
    const { h, p } = build()
    await pastSampleGrace(h)
    h.script({ getResult: personaRow(h, p, { state: PENDING }), findMissingResult: placed(p, 'unverified_ids') })

    const outcome = await h.runSequence(p, { lastReadState: PENDING })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED, judgedRuns: LIVE_ROW_SEQUENCE_MAX_RUNS })
    expect(h.episodeNotices).toEqual([killFailureNotice(p, ordinaryAlertContent(p))])
  })

  // AC 84: the settings at their minimums, and one set above them.
  const GRACE_MINIMUM = pendingGraceMinimumSeconds(DEFAULT_AD_SETTINGS.tmux.create_timeout_ms, DEFAULT_AD_SETTINGS.tmux.pipe_close_wait_ms)
  test.each([
    ['at their minimums', 0n],
    ['above their minimums', 1n],
  ])('AC 84: with the settings %s, runs that leave the pending row in neither list make no escalation, post or further kill', async (_label, above) => {
    const { h, p } = build({
      adSettings: {
        tmux: {
          pending_grace_seconds: GRACE_MINIMUM + above,
          stopping_window_seconds: AD_SETTING_MINIMUMS.stopping_window_seconds + above,
          starting_session_seconds: AD_SETTING_MINIMUMS.starting_session_seconds + above,
        },
      },
    })
    expect(adGraceMsInEffect()).toBe(Number(GRACE_MINIMUM + above) * 1000)
    await pastSampleGrace(h)
    h.script({ getResult: personaRow(h, p, { state: PENDING }), findMissingResult: placed(p, 'neither') })

    const outcome = await h.runSequence(p, { lastReadState: PENDING })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_NOT_JUDGED, runs: 1, kills: 1 })
    expect(h.stub.calls.killCalls).toHaveLength(1)
    expect([h.episodeNotices, killFailureLines(h, p)]).toEqual([[], []])
  })
})

// ---------------------------------------------------------------------------
// Failed runs (SRJ-120's refusal split, E14 build; HO rev 28 / apply21)
// ---------------------------------------------------------------------------

/** A `find-missing` failure of each class SRJ-120 refuses the run for, and the retry cause its own refusal arms. */
const REFUSED_RUNS: ReadonlyArray<readonly [string, () => Error, string]> = [
  [AD_ERROR_CLASS_UNAVAILABLE, () => unavailableAt('find-missing'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
  [AD_ERROR_CLASS_ENVIRONMENT, () => errTmuxNotAvailable(undefined, 'find-missing'), UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT],
  [AD_ERROR_CLASS_CONFIG, () => errConfigMalformed(), UNAVAILABLE_RETRY_CAUSE_CONFIG],
  [AD_ERROR_CLASS_UNCLASSIFIED, () => errSystemInstallDisappeared('find-missing'), UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED],
]

describe('failed runs: a refused run ends the sequence; any other failed run judges nothing and the step goes on (SRJ-120)', () => {
  test.each([1, LIVE_ROW_SEQUENCE_MAX_RUNS].flatMap((run) => REFUSED_RUNS.map(([label, make, cause]) => [run, label, make, cause] as const)))(
    'run %d refused (%s): the sequence ends at once with no further run, kill or launch and nothing counted; the other-end cause armed after the refusal\'s own',
    async (run, _label, make, cause) => {
      const { h, p } = build()
      h.script({ getResult: personaRow(h, p) })
      runs(h, ...Array.from({ length: run - 1 }, () => cannedFindMissing()), make())
      const order = recordCallOrder(h)

      const outcome = await h.runSequence(p, { lastReadState: LIVE })

      const step4 = run > LIVE_ROW_SEQUENCE_STEP3_RUNS
      expect(order).toEqual(['kill', 'get', ...runAndGet(Math.min(run, LIVE_ROW_SEQUENCE_STEP3_RUNS + 1) - 1), ...(step4 ? ['kill'] : []), 'findMissing'])
      // The run's one line, with one tag group.
      const runLine = liveRowSequenceRunLine(`persona=${p}`, step4 ? 4 : 3, run, LIVE_ROW_RUN_REFUSED)
      expect(h.lines.filter((line) => line === runLine)).toHaveLength(1)
      expect(runLine.match(/\(b\.jg5 [^)]*\)/g)).toHaveLength(1)
      expect(outcome).toEqual({
        kind: LIVE_ROW_OUTCOME_RUN_REFUSED,
        step: step4 ? 4 : 3,
        runs: run,
        kills: step4 ? LIVE_ROW_SEQUENCE_MAX_KILLS : 1,
        judgedRuns: run - 1,
        armed: LIVE_ROW_ARM_ENDED,
      })
      expect([h.stub.calls.spawnCalls, h.episodeNotices]).toEqual([[], []])
      expectEndArmed(h, outcome, UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED, [cause])
    },
  )

  test('every run failing otherwise (an UNUSABLE NAME answer): no run judged the row, so no alert and no launch; the timer armed', async () => {
    const { h, p } = build()
    h.script({ getResult: personaRow(h, p), findMissingError: errUnusableName() })

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_NO_JUDGED_RUN,
      runs: LIVE_ROW_SEQUENCE_MAX_RUNS,
      kills: LIVE_ROW_SEQUENCE_MAX_KILLS,
      judgedRuns: 0,
      armed: LIVE_ROW_ARM_ENDED,
    })
    expect([h.stub.calls.spawnCalls, h.episodeNotices, killFailureLines(h, p)]).toEqual([[], [], []])
    expect(h.latch.isLatched(p)).toBe(false)
    expectEndArmed(h, outcome, UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED)
  })

  test('one such failed run among judged ones: the step goes on, and the row still live leads to the alert', async () => {
    const { h, p } = build()
    h.script({ getResult: personaRow(h, p) })
    runs(h, errUnusableName())

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED, runs: LIVE_ROW_SEQUENCE_MAX_RUNS, judgedRuns: LIVE_ROW_SEQUENCE_MAX_RUNS - 1 })
    expect(h.episodeNotices).toEqual([killFailureNotice(p, ordinaryAlertContent(p))])
  })
})

// ---------------------------------------------------------------------------
// The kills (SRJ-110, SRJ-702, SRJ-703, SRJ-705 steps 1 and 4, SRJ-1007)
// ---------------------------------------------------------------------------

/**
 * HO C2's non-success list at a kill (SRJ-110's Test line), the outcomes that
 * latch no one, with CONFIG and `ErrSystemInstallDisappeared` beside them:
 * each with its class, a value of it built by name and the tries the bounded
 * retry makes of a row last read live (only UNAVAILABLE is tried again).
 * `ErrTmuxKillFailed` has its own cases below; CONFLICT and UNUSABLE NAME
 * latch P: their cases are tests/conflict-latch.test.ts's.
 */
const NON_LATCHING_KILL_FAILURES: ReadonlyArray<readonly [string, KillFailureClass, () => Error, number]> = [
  ['ErrTmuxUnresponsive', AD_ERROR_CLASS_UNAVAILABLE, () => errTmuxUnresponsive('kill'), KILL_RETRY_TRIES],
  ['ErrCallTimeout', AD_ERROR_CLASS_UNAVAILABLE, () => errCallTimeout('kill'), KILL_RETRY_TRIES],
  ['an unknown error name', AD_ERROR_CLASS_UNAVAILABLE, () => errUnknownErrorName(), KILL_RETRY_TRIES],
  ['ErrTmuxNotAvailable', AD_ERROR_CLASS_ENVIRONMENT, () => errTmuxNotAvailable(undefined, 'kill'), 1],
  ['ErrInternal (no unusable recorded name)', AD_ERROR_CLASS_UNCLASSIFIED, () => errInternal(), 1],
  ['ErrConfigMalformed', AD_ERROR_CLASS_CONFIG, () => errConfigMalformed(), 1],
  ['ErrSystemInstallDisappeared', AD_ERROR_CLASS_UNCLASSIFIED, () => errSystemInstallDisappeared('kill'), 1],
]

/** The two kills: step 1's and step 4's, and the calls of a sequence up to that kill. */
const KILL_STEPS = ([1, 4] as const).map((step) => [step, callsBeforeSequenceKill(step)] as const)

describe('the kills: checked, with the bounded retry; a non-success aborts by its class (SRJ-110, SRJ-702, SRJ-705)', () => {
  test.each(KILL_STEPS.flatMap(([step, before]) => NON_LATCHING_KILL_FAILURES.map(([label, errorClass, make, tries]) => [step, label, errorClass, before, make, tries] as const)))(
    'the step-%d kill answering %s (%s) after the bounded retry\'s tries: an abort by class; no launch and no further run or kill',
    async (step, _label, errorClass, before, make, tries) => {
      const { h, p } = build()
      h.script({ getResult: personaRow(h, p) })
      scriptSequenceKillFailure(h, step, make)
      const order = recordCallOrder(h)

      const outcome = await h.runSequence(p, { lastReadState: LIVE })

      // Each further try follows a status read of the row, KILL_RETRY_SPACING_MS after the last.
      expect(order).toEqual([...before, 'kill', ...Array.from({ length: tries - 1 }, () => ['status', 'kill']).flat()])
      expect(outcome).toEqual({
        kind: LIVE_ROW_OUTCOME_ABORTED,
        step,
        errorClass,
        latched: false,
        runs: step === 1 ? 0 : LIVE_ROW_SEQUENCE_STEP3_RUNS,
        kills: step === 1 ? 1 : LIVE_ROW_SEQUENCE_MAX_KILLS,
        judgedRuns: step === 1 ? 0 : LIVE_ROW_SEQUENCE_STEP3_RUNS,
        armed: LIVE_ROW_ARM_ENDED,
      })
      expect(h.stub.calls.spawnCalls).toEqual([])
      expect(h.episodeNotices).toEqual([])
      expect(getFailureCount(p)).toBe(0)
    },
  )

  // SRJ-104, SRJ-204, SRJ-205: ErrInvalidFlags at a kill gets one immediate
  // version re-check, which is not tried again. One that passes leaves the
  // UNCLASSIFIED outcome: the abort, its own cause and then the other-end
  // cause armed. One that decides the server stops ends the sequence stopped
  // for shutdown: nothing armed and no alert.
  test.each(KILL_STEPS)('the step-%d kill answering ErrInvalidFlags whose one re-check passes: an abort by UNCLASSIFIED, no launch and no further run or kill; the other-end cause armed after the UNCLASSIFIED one', async (step, before) => {
    const { h, p } = build()
    const { resolves, stops } = h.recheckAnswers(PHASE1_RC_VERSION)
    h.script({ getResult: personaRow(h, p) })
    scriptSequenceKillFailure(h, step, () => errInvalidFlags('kill'))
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect([resolves.length, stops.length]).toEqual([1, 0])
    expect(order).toEqual([...before, 'kill'])
    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_ABORTED,
      step,
      errorClass: AD_ERROR_CLASS_UNCLASSIFIED,
      latched: false,
      runs: step === 1 ? 0 : LIVE_ROW_SEQUENCE_STEP3_RUNS,
      kills: step === 1 ? 1 : LIVE_ROW_SEQUENCE_MAX_KILLS,
      judgedRuns: step === 1 ? 0 : LIVE_ROW_SEQUENCE_STEP3_RUNS,
      armed: LIVE_ROW_ARM_ENDED,
    })
    expect([h.stub.calls.spawnCalls, h.episodeNotices]).toEqual([[], []])
    expectEndArmed(h, outcome, UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED, [UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED])
  })

  test.each(KILL_STEPS)('the step-%d kill answering ErrInvalidFlags whose one re-check decides that the server stops: the sequence ends stopped for shutdown, with no further call, nothing armed and no alert', async (step, before) => {
    const { h, p } = build()
    const { resolves, stops } = h.recheckAnswers(OLD_AD_VERSION)
    h.script({ getResult: personaRow(h, p) })
    scriptSequenceKillFailure(h, step, () => errInvalidFlags('kill'))
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect([resolves.length, stops.length]).toEqual([1, 1])
    expect(order).toEqual([...before, 'kill'])
    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_STOPPED,
      reason: LIVE_ROW_STOP_SHUTDOWN,
      runs: step === 1 ? 0 : LIVE_ROW_SEQUENCE_STEP3_RUNS,
      kills: step === 1 ? 1 : LIVE_ROW_SEQUENCE_MAX_KILLS,
      judgedRuns: step === 1 ? 0 : LIVE_ROW_SEQUENCE_STEP3_RUNS,
    })
    expect([h.triggers, h.controller.armedKeys(), h.episodeNotices, killFailurePosts(h, p)]).toEqual([[], [], [], []])
    expect([h.stub.calls.spawnCalls, getFailureCount(p)]).toEqual([[], 0])
  })

  test('the tries of an UNAVAILABLE kill are KILL_RETRY_SPACING_MS apart on the clock', async () => {
    const { h, p } = build()
    h.script({ killError: errTmuxUnresponsive('kill') })
    const calls = recordCallTimes(h)

    await h.runSequence(p, { lastReadState: LIVE })

    expect(calls.filter(([verb]) => verb === 'kill')).toEqual(Array.from({ length: KILL_RETRY_TRIES }, (_, i) => ['kill', i * KILL_RETRY_SPACING_MS]))
  })

  test.each(KILL_STEPS.flatMap(([step]) => KILL_FAILED_DESCRIPTIONS.map((description) => [step, description] as const)))(
    'the step-%d kill answering ErrTmuxKillFailed (%s) at every try: one ordinary alert quoting that description, redacted; the abort; no second alert',
    async (step, description) => {
      const { h, p } = build()
      const err = (): Error => errTmuxKillFailed(undefined, description)
      h.script({ getResult: personaRow(h, p) })
      scriptSequenceKillFailure(h, step, err)

      const outcome = await h.runSequence(p, { lastReadState: LIVE })

      expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_ABORTED, step, errorClass: AD_ERROR_CLASS_UNAVAILABLE, latched: false })
      expect(h.episodeNotices).toEqual([killFailureNotice(p, ordinaryAlertContent(p, { last: err() }))])
      expect(killFailurePosts(h, p)).toHaveLength(1)
    },
  )

  test.each([ENDED, MISSING])('a step-1 success with kill_sent false whose next get reads %s: no alert, and the launch (SRJ-703)', async (state) => {
    const { h, p } = build()
    h.script({ killResult: cannedKillResult(false), getResult: personaRow(h, p, { state }) })

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, kills: 1 })
    expect([h.episodeNotices, killFailureLines(h, p)]).toEqual([[], []])
    expectOneReuseOf(h, p)
  })

  test('ErrSpawnNotFound at a kill counts as a success: the sequence goes on to its get', async () => {
    const { h, p } = build()
    h.script({ killError: errSpawnNotFound(), getResult: personaRow(h, p, { state: ENDED }) })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expectCallsThenApprover(order, ['kill', 'get', 'findMissing', 'get', 'spawn'])
    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, kills: 1 })
  })

  /** A survivor-naming `ErrTmuxKillFailed` naming `pids`. */
  const survivorErr = (pids: readonly number[] = STUB_SURVIVOR_PIDS): Error => errTmuxKillFailed(undefined, 'pane-process-survived', pids)

  test.each([
    ['one pid', STUB_SURVIVOR_PIDS],
    ['two pids', [...STUB_SURVIVOR_PIDS, STUB_SURVIVOR_PIDS[0]! + 1]],
  ])('a survivor-naming ErrTmuxKillFailed (%s), then a success: one survivor post, and the sequence goes on to its launch', async (_label, pids) => {
    const { h, p } = build()
    const survivor = survivorErr(pids)
    h.script({ killQueue: [cannedErr(survivor), cannedOk(cannedKillResult(true))], getResult: personaRow(h, p, { state: ENDED }) })

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(h.episodeNotices).toEqual([killFailureNotice(p, survivorAlertContent(p, survivor))])
    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, kills: 1 })
  })

  test.each([
    ['ErrTmuxUnresponsive to the end: one ordinary alert quoting only the survivor-naming description', () => errTmuxUnresponsive('kill'), false],
    ['a non-survivor ErrTmuxKillFailed: one ordinary alert quoting both descriptions', () => errTmuxKillFailed(), true],
  ] as const)('a survivor-naming ErrTmuxKillFailed, then %s; the abort', async (_label, rest, quotesLast) => {
    const { h, p } = build()
    const survivor = survivorErr()
    h.script({ killQueue: [cannedErr(survivor)], killError: rest() })

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_ABORTED, step: 1, errorClass: AD_ERROR_CLASS_UNAVAILABLE })
    const quoted = quotesLast ? { last: rest(), earlierSurvivor: survivor } : { earlierSurvivor: survivor }
    expect(h.episodeNotices).toEqual([killFailureNotice(p, ordinaryAlertContent(p, quoted))])
  })

  test('a survivor-naming ErrTmuxKillFailed, then CONFLICT: the CONFLICT is not tried again, P stops, and the ordinary alert ends with the latched closing sentence', async () => {
    const { h, p } = build()
    const survivor = survivorErr()
    h.script({ killQueue: [cannedErr(survivor), cannedErr(errTmuxSessionConflict('kill', 'not-this-launch'))], killError: errTmuxUnresponsive('kill') })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(order).toEqual(['kill', 'status', 'kill'])
    expect(outcome).toEqual({ kind: LIVE_ROW_OUTCOME_ABORTED, step: 1, errorClass: AD_ERROR_CLASS_CONFLICT, latched: true, runs: 0, kills: 1, judgedRuns: 0 })
    const alert = killFailureNotice(p, ordinaryAlertContent(p, { earlierSurvivor: survivor }), KILL_FAILURE_CLOSING_DESTINATION_LATCHED)
    // The latch's own CONFLICT post comes first (tests/conflict-latch.test.ts); the alert follows it.
    expect(h.episodeNotices.at(-1)).toEqual(alert)
    expect(killFailurePosts(h, p)).toEqual([killFailurePostedLine(p, ordinaryAlertContent(p, { earlierSurvivor: survivor }), KILL_FAILURE_CLOSING_DESTINATION_LATCHED)])
  })
})

// ---------------------------------------------------------------------------
// ad-config-malformed (SRJ-316, SRJ-706; the E12 note)
// ---------------------------------------------------------------------------

describe('ad-config-malformed: no kill of a row last read pending while P\'s outage is raised (SRJ-316, SRJ-706)', () => {
  // Step 4's no-kill, with the outage raised by an earlier call, is
  // tests/unavailable-retry.test.ts's (SRJ-316's pending-row leg).
  test('step 1 on a pending seed with the outage raised: no kill and no call at all; the sequence ends without its launch', async () => {
    const { h, p } = build()
    raiseAdConfigMalformed(p, errConfigMalformed())

    const outcome = await h.runSequence(p, { lastReadState: PENDING })

    expect(outcome).toEqual({ kind: LIVE_ROW_OUTCOME_CONFIG_MALFORMED, step: 1, runs: 0, kills: 0, judgedRuns: 0, armed: LIVE_ROW_ARM_ENDED })
    expect(h.stub.callCount()).toBe(0)
    expectEndArmed(h, outcome, UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED)
  })

  test('a step-4 kill whose between-try status read answers CONFIG, on a row last read pending: its tries end with no further kill, the last try\'s outcome standing', async () => {
    const { h, p } = build()
    await pastSampleGrace(h)
    h.script({
      getResult: personaRow(h, p, { state: PENDING }),
      findMissingResult: placed(p, 'unverified_ids'),
      killQueue: [cannedOk(cannedKillResult(true))],
      killError: errTmuxUnresponsive('kill'),
      statusError: errConfigMalformed(),
    })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(order).toEqual(['kill', 'get', ...runAndGet(LIVE_ROW_SEQUENCE_STEP3_RUNS), 'kill', 'status'])
    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_ABORTED, step: 4, errorClass: AD_ERROR_CLASS_UNAVAILABLE, kills: LIVE_ROW_SEQUENCE_MAX_KILLS })
  })
})

// ---------------------------------------------------------------------------
// A failed get (SRJ-705; hatch A2)
// ---------------------------------------------------------------------------

/** Each `get` of the sequence: the rows read live before it, and its step. */
const GET_SITES = [
  ['the step-2 get', 0, 2],
  ['a step-3 confirming get', 1, 3],
  ["step 4's confirming get", LIVE_ROW_SEQUENCE_MAX_RUNS, 4],
] as const

describe('a failed get: UNAVAILABLE ends the sequence with the timer armed; UNUSABLE NAME latches P instead (SRJ-705; hatch A2)', () => {
  // SRJ-104: a failed get's line reports the failure as the kill line does.
  // An ErrInternal (an unknown name to the client) shows its class, its name
  // and agent-director's own description, redacted.
  test.each(GET_SITES.slice(0, 2))('%s answering an ErrInternal: its one get line carries class=UNCLASSIFIED, name=ErrInternal and the description redacted; the read is refused', async (_label, before, step) => {
    const { h, p } = build()
    const err = Object.assign(errInternal(`the store could not be read (${sentinelInMessage('get')})`), { detail: LEAK_SENTINEL })
    gets(h, ...Array.from({ length: before }, () => personaRow(h, p)), err)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_READ_REFUSED, step, runs: before })
    const line = liveRowSequenceGetLine(`persona=${p}`, step, { kind: LIVE_ROW_READ_REFUSED, error: err })
    expect(err.unknownName).toBe('ErrInternal')
    expect(line).toContain(`: step ${step} get: failed: class=${AD_ERROR_CLASS_UNCLASSIFIED} name=${err.unknownName} message="the store could not be read (${REDACTED_SENTINEL_TAIL})" (b.jg5 `)
    expect(h.lines.filter((logged) => logged === line)).toHaveLength(1)
    assertNoLeak({ line })
  })

  // ErrSpawnNotFound reads as no row: the step exits above.
  test.each(GET_SITES)('%s answering UNAVAILABLE: no further run, kill or launch, nothing counted; P\'s retry timer armed', async (_label, before, step) => {
    const { h, p } = build()
    gets(h, ...Array.from({ length: before }, () => personaRow(h, p)), unavailableAt('get'))

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_READ_REFUSED,
      step,
      runs: before,
      kills: step === 4 ? LIVE_ROW_SEQUENCE_MAX_KILLS : 1,
      judgedRuns: before,
      armed: LIVE_ROW_ARM_ENDED,
    })
    expect(h.stub.calls.findMissingCalls).toHaveLength(before)
    expect([h.stub.calls.spawnCalls, h.stub.calls.resumeCalls]).toEqual([[], []])
    expectEndArmed(h, outcome, UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED, [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE])
  })

  test.each(GET_SITES)('%s answering UNUSABLE NAME: P latched, which stops the sequence; no timer armed', async (_label, before, step) => {
    const { h, p } = build()
    gets(h, ...Array.from({ length: before }, () => personaRow(h, p)), errUnusableName())

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_STOPPED,
      reason: LIVE_ROW_STOP_LATCHED,
      runs: before,
      kills: step === 4 ? LIVE_ROW_SEQUENCE_MAX_KILLS : 1,
      judgedRuns: before,
    })
    expect(h.latch.isLatched(p)).toBe(true)
    expect(h.stub.calls.findMissingCalls).toHaveLength(before)
    expect(h.controller.isArmed(p)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The alert's episode (AC 61, SRJ-704, SRJ-1007)
// ---------------------------------------------------------------------------

describe('the step-5 alert\'s episode: once per episode, routed by the applied configuration, with the request\'s context (AC 61, SRJ-704)', () => {
  test('a later sequence in the same episode posts no second alert though both its kills succeed; a get reading the row ended ends the episode silently, and the next sequence\'s step 5 posts again', async () => {
    // The scripted retry action makes no call, so a retry fired between sequences changes nothing here.
    const { h, p } = build({ action: 'scripted' })
    const content = ordinaryAlertContent(p)
    h.script({ getResult: personaRow(h, p) })
    expect(await h.runSequence(p, { lastReadState: LIVE })).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED })
    h.script({ killResult: cannedKillResult(true) })
    expect(await h.runSequence(p, { lastReadState: LIVE })).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED, kills: LIVE_ROW_SEQUENCE_MAX_KILLS })
    expect(h.episodeNotices).toEqual([killFailureNotice(p, content)])

    h.script({ getResult: personaRow(h, p, { state: ENDED }) })
    expect(await h.runSequence(p, { lastReadState: LIVE })).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED })
    h.script({ getResult: personaRow(h, p) })
    expect(await h.runSequence(p, { lastReadState: LIVE })).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED })

    expect(h.episodeNotices).toEqual([killFailureNotice(p, content), killFailureNotice(p, content)])
    expect(killFailureLines(h, p)).toEqual([
      killFailurePostedLine(p, content),
      killFailureHeldLine(p),
      killFailureEndedLine(p, KILL_FAILURE_END_ROW_FINISHED),
      killFailurePostedLine(p, content),
    ])
  })

  test('P removed from the applied configuration during the sequence: one log line and one persona-kill-failed entry with the not-configured closing; nothing to Slack', async () => {
    const { h, p } = build()
    h.script({ getResult: personaRow(h, p) })
    // The last get's position in the call order: the sequence's 11th call.
    const lastGet = ['kill', 'get', ...runAndGet(LIVE_ROW_SEQUENCE_STEP3_RUNS), 'kill', ...runAndGet(1)].length - 1
    recordCallOrder(h, { at: lastGet, run: () => h.remove(p) })

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED })
    expect(h.episodeNotices).toEqual([])
    expect(startupEntriesOf(h, PERSONA_KILL_FAILED_LABEL)).toEqual([killFailureRecoveryEntry(p, ordinaryAlertContent(p))])
    expect(killFailureLines(h, p)).toEqual([
      killFailureLoggedLine(p, KILL_FAILURE_VERSION_ORDINARY, PERSONA_KILL_FAILED_LABEL, KILL_FAILURE_ROUTE_NOT_CONFIGURED),
    ])
  })

  test.each([
    [KILL_FAILURE_CONTEXT_RECOVERY, undefined],
    [KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT, LIVE_ROW_SEQUENCE_ENTRY_GET],
  ] as const)('the alert carries the request\'s context (%s)', async (alertContext, entryStep) => {
    const { h, p } = build()
    h.script({ getResult: personaRow(h, p) })

    await h.runSequence(p, { lastReadState: LIVE, alertContext, ...(entryStep === undefined ? {} : { entryStep }) })

    expect(killFailurePosts(h, p)).toEqual([killFailurePostedLine(p, ordinaryAlertContent(p), KILL_FAILURE_CLOSING_DESTINATION, alertContext)])
  })
})

// ---------------------------------------------------------------------------
// The launch (SRJ-705 step 6, AC 63)
// ---------------------------------------------------------------------------

/** A session id for a row that has one (fixture data). */
const SESSION_ID = 'a-session-id'

/** A sequence that reaches step 6 at once: step 2's get and run 1's read the row finished, or answer `read` (an error). */
function finishedAtRun1(h: RecoveryHarness, key: string, read: PersonaGetResultOverrides | Error): void {
  h.script(read instanceof Error ? { getError: read } : { getResult: personaRow(h, key, { state: ENDED, ...read }) })
}

/** Step 6's inputs when every condition for a resume holds. */
const RESUMABLE: LiveRowLaunchKindInput = {
  keepsConversation: true,
  retiredKey: false,
  row: { claude_session_id: SESSION_ID },
  persona: { resumeEnabled: true, cwdMatches: true, configDirMatches: true },
}

describe('the launch kind: a resume only when every condition holds; a reuse with the first reason that holds otherwise (SRJ-705 step 6)', () => {
  test('every condition holds: a resume, for the row has a session id and the persona keeps its conversation', () => {
    expect(decideLiveRowLaunchKind(RESUMABLE)).toEqual({ kind: LIVE_ROW_LAUNCH_RESUME, reason: LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION })
  })

  test.each<[string, LiveRowLaunchKindInput, LiveRowSequenceLaunchReason]>([
    ['the key is retired', { ...RESUMABLE, retiredKey: true }, LIVE_ROW_LAUNCH_REASON_RETIRED_KEY],
    ['the persona does not keep its conversation', { ...RESUMABLE, keepsConversation: false }, LIVE_ROW_LAUNCH_REASON_NOT_KEPT],
    ['no row was read, the conversation kept', { ...RESUMABLE, row: undefined }, LIVE_ROW_LAUNCH_REASON_NO_ROW],
    ['the row has no session id', { ...RESUMABLE, row: {} }, LIVE_ROW_LAUNCH_REASON_NO_SESSION_ID],
    ['the row\'s session id is blank', { ...RESUMABLE, row: { claude_session_id: ' ' } }, LIVE_ROW_LAUNCH_REASON_NO_SESSION_ID],
    ['the persona is not applied', { ...RESUMABLE, persona: undefined }, LIVE_ROW_LAUNCH_REASON_NOT_APPLIED],
    ['resume_enabled is false', { ...RESUMABLE, persona: { ...RESUMABLE.persona!, resumeEnabled: false } }, LIVE_ROW_LAUNCH_REASON_RESUME_DISABLED],
    ['the cwd differs', { ...RESUMABLE, persona: { ...RESUMABLE.persona!, cwdMatches: false } }, LIVE_ROW_LAUNCH_REASON_CWD_MISMATCH],
    ['the config_dir label is missing or differs', { ...RESUMABLE, persona: { ...RESUMABLE.persona!, configDirMatches: false } }, LIVE_ROW_LAUNCH_REASON_CONFIG_DIR_MISMATCH],
  ])('%s: a reuse, with that reason', (_label, input, reason) => {
    expect(decideLiveRowLaunchKind(input)).toEqual({ kind: LIVE_ROW_LAUNCH_REUSE, reason })
  })
})

describe('the launch: a resume when the row has a session id and P keeps its conversation, a reuse of the same id otherwise (SRJ-705 step 6, AC 63)', () => {
  test('a row with a session id whose persona keeps its conversation: one resume of the id, no reuse', async () => {
    const { h, p } = build()
    finishedAtRun1(h, p, { claude_session_id: SESSION_ID })

    const outcome = await h.runSequence(p, { lastReadState: LIVE, keepsConversation: true })

    expect(outcome).toMatchObject({
      kind: LIVE_ROW_OUTCOME_LAUNCHED,
      launchKind: LIVE_ROW_LAUNCH_RESUME,
      reason: LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION,
      result: { key: p },
    })
    expect(h.stub.calls.resumeCalls).toEqual([{ claude_instance_id: personaInstanceId(p) }])
    // No reuse after the resume succeeded, and no sequence cause armed (SRJ-301): only the launch's own
    // pending-only arm for the row it left (b.jg5 SRJ-409).
    expect(h.stub.calls.spawnCalls).toEqual([])
    expect(outcome.armed).toBeUndefined()
    expect([h.triggers, h.controller.armedKeys(), h.notices]).toEqual([[{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_PENDING_ROW }], [p], []])
    expectPendingOnlyWatch(h, p)
    await h.runApproverToStop(p)
  })

  // A resume with no transcript to resume goes on to the reuse through the
  // launch entry's resume leg: tests/session-manager.test.ts's SRJ-705
  // step-6 describe.

  test.each<[string, string, RecoveryHarnessOptions, (h: RecoveryHarness, key: string) => PersonaGetResultOverrides | Error, boolean]>([
    ['the last get reading no row (ErrSpawnNotFound)', LIVE_ROW_LAUNCH_REASON_NO_ROW, {}, () => errSpawnNotFound(), false],
    ['no session id', LIVE_ROW_LAUNCH_REASON_NO_SESSION_ID, {}, () => ({}), false],
    ['resume_enabled=false', LIVE_ROW_LAUNCH_REASON_RESUME_DISABLED, { resumeEnabled: false }, () => ({ claude_session_id: SESSION_ID }), false],
    ['a cwd mismatch', LIVE_ROW_LAUNCH_REASON_CWD_MISMATCH, {}, (h) => ({ claude_session_id: SESSION_ID, cwd: h.home }), false],
    [
      'a config_dir label missing',
      LIVE_ROW_LAUNCH_REASON_CONFIG_DIR_MISMATCH,
      {},
      (h, key) => {
        const { config_dir: _dropped, ...labels } = personaRow(h, key).labels
        return { claude_session_id: SESSION_ID, labels }
      },
      false,
    ],
    [
      'a config_dir label that differs',
      LIVE_ROW_LAUNCH_REASON_CONFIG_DIR_MISMATCH,
      {},
      (h, key) => ({ claude_session_id: SESSION_ID, labels: { ...personaRow(h, key).labels, config_dir: h.stateDir } }),
      false,
    ],
    ['a retired key', LIVE_ROW_LAUNCH_REASON_RETIRED_KEY, {}, () => ({ claude_session_id: SESSION_ID }), true],
  ])('%s: one reuse spawn of the same id through the session manager\'s reuse spawn, with the flag and the persona\'s extra_env, and no resume', async (_label, reason, options, overrides, retiredKey) => {
    const { h, p } = build(options)
    finishedAtRun1(h, p, overrides(h, p))

    const outcome = await h.runSequence(p, { lastReadState: LIVE, keepsConversation: true, retiredKey })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, reason, result: { key: p, action: 'spawned' } })
    expectOneReuseOf(h, p)
    expect(h.stub.calls.resumeCalls).toEqual([])
  })

  // b.jg5 SRJ-805, SRJ-806: step 6's retired-key flag is the request's or P's
  // facts' (the store read at step 6, so a key recorded while the sequence
  // ran ends in a reuse), and its launch gets the request's attempt-start
  // reading as it is, for the reuse to compare against. The facts and the
  // launch are replaced; the facts say everything else allows a resume.
  test.each<[string, boolean, boolean | undefined, LiveRowSequenceLaunchKind, LiveRowSequenceLaunchReason]>([
    ['the request not flagged, P\'s facts reading retired at step 6', false, true, LIVE_ROW_LAUNCH_REUSE, LIVE_ROW_LAUNCH_REASON_RETIRED_KEY],
    ['the request flagged, P\'s facts reading not retired', true, false, LIVE_ROW_LAUNCH_REUSE, LIVE_ROW_LAUNCH_REASON_RETIRED_KEY],
    ['the request flagged, P\'s facts with no retired reading', true, undefined, LIVE_ROW_LAUNCH_REUSE, LIVE_ROW_LAUNCH_REASON_RETIRED_KEY],
    ['control: neither, P keeping its conversation', false, false, LIVE_ROW_LAUNCH_RESUME, LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION],
  ])('%s: one launch of the kind that decides, handed the request\'s attempt-start reading unchanged', async (_label, retiredKey, retired, kind, reason) => {
    const { h, p } = build()
    finishedAtRun1(h, p, { claude_session_id: SESSION_ID })
    const retiredAtStart: RetiredKeyAttemptStart = { recorded: true, marked: false, generation: 3 }
    const launches: Array<Parameters<LiveRowSequenceDeps['launch']>> = []

    const outcome = await runWithDeps(
      h,
      p,
      createLiveRowSequenceStop(),
      {
        personaFacts: () => ({ resumeEnabled: true, cwdMatches: true, configDirMatches: true, ...(retired === undefined ? {} : { retired }) }),
        launch: async (...args) => {
          launches.push(args)
          return { kind: LIVE_ROW_LAUNCH_ANSWER_LAUNCHED, result: { key: p, action: 'spawned' } }
        },
      },
      { keepsConversation: true, retiredKey, retiredAtStart },
    )

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: kind, reason, result: { key: p, action: 'spawned' } })
    expect(launches).toHaveLength(1)
    expect(launches[0]![1]).toBe(kind)
    expect(launches[0]![5]).toBe(retiredAtStart)
  })

  // HO rev 15: a reuse of an id with no row is an ordinary fresh spawn, which
  // the pre-spawn scan can refuse; its record and post are
  // tests/conflict-latch.test.ts's.
  test.each(reuseSpawnScanRows().map((row) => [row.name, row] as const))('step 3\'s get reading no row (ErrSpawnNotFound), the reuse refused by the pre-spawn scan (%s): P latched, the launch ends latched with no call after it and nothing armed', async (_name, row) => {
    const { h, p } = build()
    h.script({ getError: errSpawnNotFound(), spawnError: row.build() })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE, keepsConversation: true })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, reason: LIVE_ROW_LAUNCH_REASON_NO_ROW, result: { key: p, action: 'latched' } })
    expect(outcome.armed).toBeUndefined()
    expect(order).toEqual(['kill', 'get', 'findMissing', 'get', 'spawn'])
    expect(h.reuseSpawns()).toHaveLength(1)
    expect(h.latch.isLatched(p)).toBe(true)
    expect(h.controller.isArmed(p)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The launch's end (SRJ-705 step 6, SRJ-301)
// ---------------------------------------------------------------------------

/**
 * Every launch result action, with whether it is a success: the actions
 * `launchSession` maps to true. Typed over the whole action set, so a new
 * action fails the typecheck until it is classified here.
 */
const LAUNCH_ACTION_SUCCEEDS: Readonly<Record<SpawnPersonaResult['action'], boolean>> = {
  spawned: true,
  [SPAWN_ACTION_FRESH_RETIRED]: true,
  resumed: true,
  reconnected: true,
  'not-reconnected': true,
  'no-op': true,
  'fresh-after-amnesia': true,
  'fresh-after-inconclusive-amnesia': true,
  failed: false,
  [SPAWN_ACTION_RETRYING]: false,
  deferred: false,
  latched: false,
  'sequence-waiting': false,
  held: false,
}

/** One step-6 reuse outcome (b.jg5 SRJ-112, SRJ-301) as the sequence ends with it. */
interface ReuseEnd {
  /** The reuse spawn's answer: an error to throw, or success. */
  readonly make: () => Error | undefined
  /** Step 3's get read no row (`ErrSpawnNotFound`): a reuse of an id with no row. Else it read the row `ended`. */
  readonly noRow?: true
  /** The launch's result, but its key. */
  readonly answer: Omit<SpawnPersonaResult, 'key'>
  /** The cause the sequence itself arms, when it arms one. */
  readonly armed?: LiveRowSequenceArmCause
  /** P's triggers, in order: the reuse's own handling's, then the sequence's. */
  readonly triggers: readonly string[]
  /** The failures counted toward the restart cap. */
  readonly counted: number
  /** Whether one spawn-failure notice is posted. */
  readonly notice?: true
  /** Whether the answer is reported once to P's unclassified-error episode. */
  readonly unclassified?: true
  /** Whether the answer is UNAVAILABLE, so its one `get` follows the reuse (b.jg5 SRJ-407), reading the row as step 3's did. */
  readonly getAfter?: true
  /** The end line's words for the launch, and for the arm. */
  readonly said: string
  readonly armedSaid: string
}

const REUSE_FAILED = 'the launch failed (reuse; result=failed)'
const REUSE_RETRYING = `the launch failed (reuse; result=${SPAWN_ACTION_RETRYING})`
const ENDED_ARMED = `the retry timer armed (${LIVE_ROW_ARM_ENDED})`
const PENDING_ONLY_ARMED = 'the retry timer armed by the launch (pending-only)'
const RETRYING_ANSWER = { action: SPAWN_ACTION_RETRYING } as const

/** A step-6 reuse's launched outcome with result `action` (one run, one kill), as the end line reads it. */
function launchedOutcome(action: string): LiveRowSequenceOutcome {
  return {
    kind: LIVE_ROW_OUTCOME_LAUNCHED,
    launchKind: LIVE_ROW_LAUNCH_REUSE,
    reason: LIVE_ROW_LAUNCH_REASON_NOT_KEPT,
    result: { key: 'p', action },
    runs: 1,
    kills: 1,
    judgedRuns: 1,
  }
}

/** The end line's words for an end that armed nothing (here a stop for teardown). */
const NO_ARM_SAID = liveRowSequenceEndArmText({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN, runs: 0, kills: 0, judgedRuns: 0 })

/** The successes that made no launch call: a reconnect, a reconnect that did not connect, and a no-op. */
const NO_LAUNCH_CALL_SUCCESSES: readonly string[] = ['reconnected', 'not-reconnected', 'no-op']

/**
 * A reuse refused by `cause`'s class, answering `retrying` (b.jg5 SRJ-1015):
 * the refusal's own cause, then the sequence's. An UNAVAILABLE refusal is
 * followed by its one `get` (b.jg5 SRJ-407).
 */
const refusedBy = (make: () => Error, cause: string, unclassified?: true): ReuseEnd => ({
  make,
  answer: RETRYING_ANSWER,
  armed: LIVE_ROW_ARM_ENDED,
  triggers: [cause, UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED],
  counted: 0,
  ...(unclassified === undefined ? {} : { unclassified }),
  ...(cause === UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE ? { getAfter: true as const } : {}),
  said: REUSE_RETRYING,
  armedSaid: ENDED_ARMED,
})

/** A reuse answering ErrTmuxSessionCreate (SRJ-112, SRJ-409, HO rev 28): counted once with its notice, P armed at once pending-only; the sequence arms nothing of its own. */
const launchFailure = (noRow?: true): ReuseEnd => ({
  make: () => errTmuxSessionCreate('spawn'),
  ...(noRow === undefined ? {} : { noRow }),
  answer: { action: 'failed', countedClass: true, pendingOnlyArmed: true },
  triggers: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW],
  counted: 1,
  notice: true,
  said: REUSE_FAILED,
  armedSaid: PENDING_ONLY_ARMED,
})

const REUSE_ENDS: ReadonlyArray<readonly [string, ReuseEnd]> = [
  // The launch arms P's timer pending-only for the row it left (b.jg5 SRJ-301, SRJ-409); the sequence arms nothing of its own.
  ['succeeds', { make: () => undefined, answer: { action: 'spawned' }, triggers: [UNAVAILABLE_RETRY_CAUSE_PENDING_ROW], counted: 0, said: 'launched (reuse; result=spawned)', armedSaid: liveRowSequenceEndArmText(launchedOutcome('spawned')) }],
  // SRJ-112, SRJ-602: a directory error is one counted launch failure, with no notice.
  [
    'fails with a directory error (ErrCwdNotFound), counted once',
    { make: () => errCwdNotFound(), answer: { action: 'failed', countedClass: true }, armed: LIVE_ROW_ARM_ENDED, triggers: [UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED], counted: 1, said: REUSE_FAILED, armedSaid: ENDED_ARMED },
  ],
  ['fails with UNAVAILABLE (ErrTmuxUnresponsive), retrying', refusedBy(() => errTmuxUnresponsive('spawn'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)],
  ['fails with ENVIRONMENT (ErrTmuxNotAvailable), retrying', refusedBy(() => errTmuxNotAvailable(), UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT)],
  ['fails with CONFIG (ErrConfigMalformed), retrying', refusedBy(() => errConfigMalformed(), UNAVAILABLE_RETRY_CAUSE_CONFIG)],
  ['fails with UNCLASSIFIED (ErrInternal), retrying', refusedBy(() => errInternal(), UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, true)],
  ['fails with ErrTmuxSessionCreate, armed pending-only', launchFailure()],
  ['of an id with no row (step 3\'s get read none) fails with ErrTmuxSessionCreate, armed pending-only', launchFailure(true)],
]

describe('the launch\'s end: the outcome carries the launch\'s result, and the end line says whether it launched (SRJ-705 step 6, SRJ-301, SRJ-112)', () => {
  test.each(Object.entries(LAUNCH_ACTION_SUCCEEDS))('a launch result %s is a success: %p', (action, succeeds) => {
    expect(liveRowLaunchSucceeded({ key: 'p', action })).toBe(succeeds)
  })

  // b.jg5 SRJ-301, SRJ-409: a launch call's own success (a spawn, a reuse
  // spawn or a resume) arms P's pending-only watch through the after-launch
  // step, so the end line says so rather than that nothing is armed; a
  // success that made no launch call (a reconnect, a no-op) and a failure
  // with nothing armed keep the words of an end that armed nothing.
  test.each(Object.entries(LAUNCH_ACTION_SUCCEEDS).map(([action, succeeds]) => [action, succeeds && !NO_LAUNCH_CALL_SUCCESSES.includes(action)] as const))('a launched outcome whose result is %s, nothing armed (a launch call\'s success: %p): the end line names the launch\'s pending-only arm only for a launch call\'s success', (action, launchCall) => {
    expect(LIVE_ROW_LAUNCH_CALL_SUCCESS_ACTIONS.has(action)).toBe(launchCall)
    const said = liveRowSequenceEndArmText(launchedOutcome(action))
    if (launchCall) {
      expect(said).not.toBe(NO_ARM_SAID)
      expect(said).toContain(`${UNAVAILABLE_RETRY_MODE_PENDING_ONLY} watch (${UNAVAILABLE_RETRY_CAUSE_PENDING_ROW})`)
    } else {
      expect(said).toBe(NO_ARM_SAID)
    }
    expect(liveRowSequenceEndLine('persona=p', launchedOutcome(action))).toContain(`; ${said} (b.jg5 `)
  })

  // The reuse's answer to each outcome class (b.jg5 SRJ-112) as the sequence
  // ends with it, and what it arms and counts through the retry controller
  // (SRJ-301); every class row at the entry is
  // tests/session-manager.test.ts's.
  test.each(REUSE_ENDS)('a reuse that %s: the outcome is launched with its result and the arm, its one end line says so, the reuse is the last call but an UNAVAILABLE answer\'s one get, and P\'s triggers, count and notice are its class\'s; Q is untouched', async (_label, row) => {
    const { h, p, q } = build()
    const err = row.make()
    h.script({
      ...(row.noRow === true ? { getError: errSpawnNotFound() } : { getResult: personaRow(h, p, { state: ENDED }) }),
      ...(err === undefined ? {} : { spawnError: err }),
    })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_LAUNCHED,
      launchKind: LIVE_ROW_LAUNCH_REUSE,
      // The conversation is not kept: the first reason that holds, with a row or none.
      reason: LIVE_ROW_LAUNCH_REASON_NOT_KEPT,
      result: { key: p, ...row.answer },
      runs: 1,
      kills: 1,
      judgedRuns: 1,
      ...(row.armed === undefined ? {} : { armed: row.armed }),
    })
    const endLine = liveRowSequenceEndLine(`persona=${p}`, outcome)
    expect(endLine).toContain(`: ${row.said} — runs=1 kills=1 judged=1; ${row.armedSaid} (b.jg5 `)
    expect(h.lines.filter((line) => line === endLine)).toHaveLength(1)
    // One reuse, the last launch call: never a kill, delete, resume or second
    // launch after it; after an UNAVAILABLE answer only its one get, which
    // reads the row ended (b.jg5 SRJ-407).
    const calls = ['kill', 'get', 'findMissing', 'get', 'spawn', ...(row.getAfter === true ? ['get'] : [])]
    if (row.answer.action === 'spawned') expectCallsThenApprover(order, calls)
    else expect(order).toEqual(calls)
    expectOneReuseOf(h, p)
    // P's timer armed with the causes in order (the reuse's own handling's first), or not at all.
    expect(h.triggers).toEqual(row.triggers.map((kind) => ({ key: p, kind })))
    expect(h.controller.view(p)?.causes ?? []).toEqual([...row.triggers])
    expect(h.controller.armedKeys()).toEqual(row.triggers.length > 0 ? [p] : [])
    if (row.triggers.includes(UNAVAILABLE_RETRY_CAUSE_PENDING_ROW)) expect(h.controller.view(p)).toMatchObject({ phase: 'waiting', mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY })
    // Only a counted class is counted, once; only a LAUNCH FAILURE posts the spawn-failure notice.
    expect([getFailureCount(p), getFailureCount(q)]).toEqual([row.counted, 0])
    expect(h.notices).toEqual(row.notice === true ? [{ key: p, text: expect.stringContaining(`\`${err!.name}\``) }] : [])
    // SRJ-313: an UNCLASSIFIED outcome is reported to P's episode once.
    expect(unclassifiedStartedLines(h, p)).toHaveLength(row.unclassified === true ? 1 : 0)
    if (row.armed !== undefined) {
      // The sequence left no timer of its own: only P's retry timer is pending,
      // and the alert timer of P's tmux-unresponsive condition while it holds.
      expect(h.clock.pending().map((timer) => timer.dueAt)).toContain(h.controller.view(p)!.dueAt!)
      expect(h.clock.pendingCount()).toBe(h.tmuxUnresponsive.holds(p) ? 2 : 1)
    }
    expectUntouched(h, q)
  })

  test('a reuse that collides with a live row (ErrInstanceIdCollision): the sequence ends without its launch, not launched (reuse-collision), with the reuse-collision cause armed and no second spawn; nothing counted or posted', async () => {
    const { h, p } = build()
    h.script({ getResult: personaRow(h, p, { state: ENDED }), spawnError: errInstanceIdCollision() })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_NOT_LAUNCHED,
      launchKind: LIVE_ROW_LAUNCH_REUSE,
      notLaunched: LIVE_ROW_NOT_LAUNCHED_REUSE_COLLISION,
      runs: 1,
      kills: 1,
      judgedRuns: 1,
      armed: LIVE_ROW_ARM_REUSE_COLLISION,
    })
    expect(order).toEqual(['kill', 'get', 'findMissing', 'get', 'spawn'])
    expect(h.reuseSpawns()).toHaveLength(1)
    const endLine = liveRowSequenceEndLine(`persona=${p}`, outcome)
    expect(endLine).toContain(`: not launched (reuse; ${LIVE_ROW_NOT_LAUNCHED_REUSE_COLLISION}) — runs=1 kills=1 judged=1; the retry timer armed (${LIVE_ROW_ARM_REUSE_COLLISION}) `)
    expectEndArmed(h, outcome, UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION)
  })

  test.each([
    ['before any stop: the sequence ends internal-error with P\'s timer armed', false],
    ['after a stop for teardown: the failure is dropped too, and the sequence ends stopped with nothing armed', true],
  ] as const)('a launch dependency that throws %s; its failure is logged redacted before the end line', async (_label, stopped) => {
    const { h, p } = build()
    h.script({ getResult: personaRow(h, p, { state: ENDED }) })
    const err = Object.assign(new Error(`the launch broke (${sentinelInMessage('launch')})`), { detail: LEAK_SENTINEL })
    const stop = createLiveRowSequenceStop()

    const outcome = await runWithDeps(h, p, stop, {
      launch: async () => {
        if (stopped) stop.stop(LIVE_ROW_STOP_TEARDOWN)
        throw err
      },
    })

    const counts = { runs: 1, kills: 1, judgedRuns: 1 }
    expect(outcome).toEqual(
      stopped
        ? { kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN, ...counts }
        : { kind: LIVE_ROW_OUTCOME_INTERNAL_ERROR, ...counts, armed: LIVE_ROW_ARM_ENDED },
    )
    const ref = `persona=${p}`
    const failed = liveRowSequenceFailedLine(ref, 'a step', describeThrownValue(err))
    expect(failed).toContain(`message="the launch broke (${REDACTED_SENTINEL_TAIL})"`)
    const expected = [failed, ...(stopped ? [liveRowSequenceDroppedLine(ref, 'failed step')] : []), liveRowSequenceEndLine(ref, outcome)]
    expect(h.lines.filter((line) => expected.includes(line))).toEqual(expected)
    expect(h.triggers).toEqual(stopped ? [] : [{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED }])
    expect(h.stub.calls.spawnCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Entries and forms
// ---------------------------------------------------------------------------

describe('entries and forms: the step-2 entry and the no-launch form', () => {
  test('entered at step 2: no kill before its get, and one kill at most (step 4\'s)', async () => {
    const { h, p } = build()
    h.script({ getResult: personaRow(h, p) })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET, alertContext: KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT })

    expect(order).toEqual(['get', ...runAndGet(LIVE_ROW_SEQUENCE_STEP3_RUNS), 'kill', ...runAndGet(1)])
    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED, kills: 1, runs: LIVE_ROW_SEQUENCE_MAX_RUNS })
  })

  test('the no-launch form makes no launch call and ends as "row finished", arming nothing', async () => {
    const { h, p } = build()
    h.script({ getResult: personaRow(h, p, { state: ENDED }) })

    const outcome = await h.runSequence(p, { lastReadState: LIVE, launches: false })

    expect(outcome).toEqual({ kind: LIVE_ROW_OUTCOME_ROW_FINISHED, runs: 1, kills: 1, judgedRuns: 1 })
    expect([h.stub.calls.resumeCalls, h.stub.calls.spawnCalls, h.triggers]).toEqual([[], [], []])
  })

  test('a kill CONFLICT in the no-launch form ends the sequence with no latch and nothing armed', async () => {
    const { h, p } = build()
    h.script({ killError: errTmuxSessionConflict('kill', 'not-this-launch') })

    const outcome = await h.runSequence(p, { lastReadState: LIVE, launches: false })

    expect(outcome).toEqual({ kind: LIVE_ROW_OUTCOME_ABORTED, step: 1, errorClass: AD_ERROR_CLASS_CONFLICT, latched: false, runs: 0, kills: 1, judgedRuns: 0 })
    expect(h.latch.isLatched(p)).toBe(false)
    expect([h.latchEvents, h.episodeNotices, h.triggers]).toEqual([[], [], []])
  })
})

// ---------------------------------------------------------------------------
// Import boundary
// ---------------------------------------------------------------------------

describe('live-row-sequence: import boundary', () => {
  test('the module loads, through its runtime imports in src/, neither the session manager, the server, the notifier nor a Slack module', () => {
    const { loads, forbidden } = forbiddenServerLoads('live-row-sequence.ts')
    // Not vacuous: the walk reaches the checked kill, the bounded retry and the settings.
    expect(['checked-kill.ts', 'kill-retry.ts', 'ad-settings.ts'].map((name) => loads.modules.has(name))).toEqual([true, true, true])
    expect(forbidden).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The stop signal (SRJ-706's stop, built in S2)
// ---------------------------------------------------------------------------

// A stop set while a run is in progress (its answer dropped, no further call)
// is the scheduling describe's stop matrix below, through the registry.
describe('the stop signal: a result that arrives after the sequence was stopped is dropped, with no further call', () => {
  // What the dropped kill arms (nothing, and no tmux-unresponsive start) is
  // tests/unavailable-retry.test.ts's.
  test.each(
    KILL_STEPS.flatMap(([step]) =>
      ([LIVE_ROW_STOP_TEARDOWN, LIVE_ROW_STOP_SHUTDOWN] as const).flatMap((reason) => LATE_KILL_ANSWERS.map((answer) => [reason, step, answer[0], answer] as const)),
    ),
  )('a stop for %s set as the step-%d kill\'s last try answers %s: the answer is dropped with one line; no latch, no CONFLICT post, no kill-failure alert, no further call and no timer left', async (reason, step, _label, answer) => {
    const { h, p } = build()

    const { outcome, order } = await runSequenceStoppedAtKill(h, p, step, answer, reason)

    const before = callsBeforeSequenceKill(step)
    const runs = step === 1 ? 0 : LIVE_ROW_SEQUENCE_STEP3_RUNS
    expect(outcome).toEqual({ kind: LIVE_ROW_OUTCOME_STOPPED, reason, runs, kills: step === 1 ? 1 : LIVE_ROW_SEQUENCE_MAX_KILLS, judgedRuns: runs })
    expect(order).toEqual([...before, 'kill', ...Array.from({ length: answer[2] - 1 }, () => ['status', 'kill']).flat()])
    const ref = `persona=${p}`
    const sequenceLines = h.lines.filter((line) => line.startsWith(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${ref}: `))
    expect(sequenceLines.slice(-2)).toEqual([liveRowSequenceDroppedLine(ref, `step ${step} kill`), liveRowSequenceEndLine(ref, outcome)])
    expect([h.latch.isLatched(p), h.latchEvents, h.episodeNotices, killFailureLines(h, p)]).toEqual([false, [], [], []])
    expect(h.clock.pendingCount()).toBe(0)
  })

  test('a stop set while a kill CONFLICT\'s latch runs: the latch and its CONFLICT post stand, and no ordinary alert, arm or further call follows', async () => {
    const { h, p } = build()
    h.script({ killError: errTmuxSessionConflict('kill', 'not-this-launch') })
    const order = recordCallOrder(h)
    const stop = createLiveRowSequenceStop()

    const outcome = await runWithDeps(h, p, stop, {
      latchOnKillOutcome: async (key, killed, lastRead, ref) => {
        const latched = await h.sequenceDeps.latchOnKillOutcome(key, killed, lastRead, ref)
        stop.stop(LIVE_ROW_STOP_TEARDOWN)
        return latched
      },
    })

    expect(outcome).toEqual({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN, runs: 0, kills: 1, judgedRuns: 0 })
    expect(order).toEqual(['kill'])
    expect(h.latch.isLatched(p)).toBe(true)
    // The latch's CONFLICT post is the one post; no kill-failure alert of any version.
    expect(h.latchEvents.filter((event) => event.step === 'notice')).toHaveLength(1)
    expect(h.episodeNotices).toHaveLength(1)
    expect(killFailureLines(h, p)).toEqual([])
    expect(h.lines.filter((line) => line === liveRowSequenceDroppedLine(`persona=${p}`, "step 1 kill's latch"))).toHaveLength(1)
  })

  test.each([
    ['step 1', LIVE_ROW_SEQUENCE_ENTRY_KILL],
    ['step 2', LIVE_ROW_SEQUENCE_ENTRY_GET],
  ] as const)('a sequence entered at %s for a persona already latched makes no call at all and arms nothing', async (_label, entryStep) => {
    const { h, p } = build()
    // Latched through the sequence's own latch entry, as an earlier kill's CONFLICT latches P.
    const conflict = killOutcomeOf({ thrown: errTmuxSessionConflict('kill', 'not-this-launch') })
    expect(await h.sequenceDeps.latchOnKillOutcome(p, conflict, { kind: 'state', state: LIVE }, `persona=${p}`)).toBe(true)
    const before = h.stub.callCount()

    const outcome = await h.runSequence(p, { lastReadState: LIVE, entryStep })

    expect(outcome).toEqual({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED, runs: 0, kills: 0, judgedRuns: 0 })
    expect(h.stub.callCount()).toBe(before)
  })
})


// b.jg5 SRJ-702: a kill retry the sequence's own stop ended raises its alert
// with that stop's cause (`liveRowStopCauseText`), the fifth argument of the
// alert dependency; tries the keep-going check ended with no stop of the
// sequence's own because P latched meanwhile raise it with the latch's cause
// (`liveRowStopCauseText(LIVE_ROW_STOP_LATCHED)`), the keep-going check's
// other stop.
describe('the stop\'s cause of a kill retry the sequence\'s stop ended (b.jg5 SRJ-702)', () => {
  test('each stop reason\'s cause (pin)', () => {
    expect(([LIVE_ROW_STOP_TEARDOWN, LIVE_ROW_STOP_SHUTDOWN, LIVE_ROW_STOP_NOT_UP, LIVE_ROW_STOP_LATCHED] as const).map((reason) => liveRowStopCauseText(reason))).toEqual([
      "its live-row sequence was stopped: the persona's teardown began",
      'its live-row sequence was stopped: the server is shutting down',
      'its live-row sequence was stopped: the persona is not up',
      'its live-row sequence was stopped: the persona latched',
    ])
  })

  /** The step-1 kill's retry: `during` runs while its tries do, which then end stopped over a standing ErrTmuxKillFailed. */
  function stoppedKill(during: () => void): LiveRowSequenceDeps['killWithRetry'] {
    return async (_key, options) => {
      during()
      expect(options.keepGoing()).toBe(false)
      const result: KillRetryResult = {
        outcome: killOutcomeOf({ thrown: errTmuxKillFailed() }),
        end: KILL_RETRY_END_STOPPED,
        tries: 1,
        reads: 0,
        alert: { kind: KILL_RETRY_ALERT_ORDINARY },
      }
      return result
    }
  }

  test.each([LIVE_ROW_STOP_TEARDOWN, LIVE_ROW_STOP_SHUTDOWN, LIVE_ROW_STOP_NOT_UP, LIVE_ROW_STOP_LATCHED] as const)('the sequence stopped for %s while its step-1 kill\'s tries ran: one alert raise, with the recovery context and that stop\'s cause; the sequence ends stopped for it', async (reason) => {
    const { h, p } = build()
    const stop = createLiveRowSequenceStop()
    const raises: unknown[][] = []

    const outcome = await runWithDeps(h, p, stop, {
      killWithRetry: stoppedKill(() => {
        stop.stop(reason)
      }),
      raiseKillAlert: (...args) => {
        raises.push(args)
      },
    })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason })
    expect(raises).toHaveLength(1)
    expect(raises[0]!.slice(0, 1)).toEqual([p])
    expect(raises[0]!.slice(2)).toEqual([KILL_FAILURE_CONTEXT_RECOVERY, `persona=${p}`, liveRowStopCauseText(reason)])
  })

  test('tries the keep-going check ended because P latched, with no stop of the sequence\'s own: one alert raise naming the latch as the stop\'s cause; the sequence ends stopped as latched', async () => {
    const { h, p } = build()
    const stop = createLiveRowSequenceStop()
    const raises: unknown[][] = []
    const conflict = killOutcomeOf({ thrown: errTmuxSessionConflict('kill', 'not-this-launch') })

    const outcome = await runWithDeps(h, p, stop, {
      killWithRetry: async (key, options) => {
        expect(await h.sequenceDeps.latchOnKillOutcome(key, conflict, { kind: 'state', state: LIVE }, `persona=${key}`)).toBe(true)
        return stoppedKill(() => undefined)(key, options)
      },
      raiseKillAlert: (...args) => {
        raises.push(args)
      },
    })

    expect(stop.reason).toBeUndefined()
    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED })
    expect(raises).toHaveLength(1)
    expect(raises[0]!.slice(2)).toEqual([KILL_FAILURE_CONTEXT_RECOVERY, `persona=${p}`, liveRowStopCauseText(LIVE_ROW_STOP_LATCHED)])
  })
})

// ---------------------------------------------------------------------------
// Lines that carry agent-director text (S1)
// ---------------------------------------------------------------------------

describe('the lines that carry agent-director text: redacted, on one line', () => {
  /** A value whose description has a second line and a fake token with a ticket URL. */
  const tokenText = (): string => `line one\n${sentinelInMessage('sequence')}`

  test.each<[string, () => string]>([
    ['a get that failed', () => liveRowSequenceGetLine('persona=p', 2, { kind: LIVE_ROW_READ_REFUSED, error: errGeneric('get', 'ErrTmuxUnresponsive', tokenText()) })],
    [
      'a kill that failed',
      () =>
        liveRowSequenceKillLine('persona=p', 1, {
          outcome: killOutcomeOf({ thrown: errInternal(tokenText()) }),
          end: KILL_RETRY_END_SETTLED,
          tries: 1,
          reads: 0,
          alert: { kind: KILL_RETRY_ALERT_NONE },
        }),
    ],
    ['a dependency that threw', () => liveRowSequenceFailedLine('persona=p', 'a step', describeThrownValue(new Error(tokenText())))],
  ])('%s: one line, with no token-like text', (_label, render) => {
    const line = render()
    expect(line).toContain(REDACTED_SENTINEL_TAIL)
    expect(line).not.toMatch(/[\r\n]/)
    expect(isTokenLike(line)).toBe(false)
    assertNoLeak({ line })
  })
})

// ---------------------------------------------------------------------------
// Scheduling (SRJ-706, AC 61; SRJ-502's latch stop): the registry, reached
// through the session manager's start, running and stop entries
//
// On `makeRecoveryHarness`, whose registry is built and installed as `main()`
// builds and installs it, with P's first run held through the stub's
// `holdFindMissing`. The start pass returning while a sequence runs is
// tests/session-manager.test.ts's; an apply and a teardown through the
// lifecycle, tests/reload-apply.test.ts's; a retry and the restart path,
// tests/unavailable-retry.test.ts's and tests/restart.test.ts's; a message
// lost meanwhile, tests/inbound-recovery-drop-branch.test.ts's; the latch's
// own consequences (its record, its post, no kill on any automated path),
// tests/conflict-latch.test.ts's.
// ---------------------------------------------------------------------------

/** A stop of P's running sequence: how a case makes it, and the reason the sequence ends with. */
type SequenceStopWay = readonly [label: string, stop: (h: RecoveryHarness, key: string) => Promise<unknown> | void, reason: LiveRowSequenceStopReason]

const LATCH_FROM_ANOTHER_PATH: SequenceStopWay = [
  'a latch of P from another path (the retry\'s own-row status read of its pending row with no launch start)',
  async (h, key) => {
    h.script({ statusResult: cannedStatusResult({ state: PENDING, launch_started_at: SAMPLE_LAUNCH_START_NONE }) })
    await readPersonaRowState(key)
    expect(h.latch.isLatched(key)).toBe(true)
  },
  LIVE_ROW_STOP_LATCHED,
]

/** A teardown's and shutdown's stops of P's running sequence. */
const TEARDOWN_AND_SHUTDOWN: readonly SequenceStopWay[] = [
  ['teardown(P)', (h, key) => h.teardown(key), LIVE_ROW_STOP_TEARDOWN],
  ['shutdown()', (h) => h.shutdown(), LIVE_ROW_STOP_SHUTDOWN],
]

const SEQUENCE_STOP_WAYS: readonly SequenceStopWay[] = [LATCH_FROM_ANOTHER_PATH, ...TEARDOWN_AND_SHUTDOWN]

describe('scheduling: each sequence runs in the background, one per persona at a time, holds every other launch of it, and stops at once on a latch, a teardown and shutdown (SRJ-706, AC 61)', () => {
  test('the start entry answers started before the sequence\'s first call; P\'s sequence reads as running while its first run is held, and once released it goes on to its launch and no longer runs', async () => {
    const { h, p } = build()
    const hold = holdFindMissing(h.stub.client)
    ownRowsLiveThenMissing(h)
    const order = recordCallOrder(h)

    const answer = startLiveRowSequence(h.sequenceRequest(p, { lastReadState: LIVE }))

    expect([answer, order, h.sequenceRunning(p)]).toEqual([LIVE_ROW_START_STARTED, [], true])
    await hold.entered()
    expect([order, hold.heldCount(), h.sequenceRunning(p)]).toEqual([['kill', 'get', 'findMissing'], 1, true])

    hold.release(placed(p, 'ids'))
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, runs: 1, kills: 1 })
    expectCallsThenApprover(order, ['kill', 'get', 'findMissing', 'get', 'spawn'])
    expect(h.sequenceRunning(p)).toBe(false)
  })

  test('a second start for P while its sequence runs answers already-running with one line, makes no call and starts no second chain; a start for Q runs beside it', async () => {
    const { h, p, q } = build()
    const hold = holdFindMissing(h.stub.client)
    ownRowsLiveThenMissing(h)
    const pRun = await startSequenceHeldAtRun(h, p, hold)
    const calls = h.stub.callCount()

    expect(startLiveRowSequence(h.sequenceRequest(p, { lastReadState: LIVE, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET }))).toBe(LIVE_ROW_START_ALREADY_RUNNING)
    await h.clock.flush()

    expect([h.stub.callCount(), hold.calls.length]).toEqual([calls, 1])
    const notStarted = liveRowSequenceNotStartedLine(`persona=${p}`, personaInstanceId(p), LIVE_ROW_START_ALREADY_RUNNING)
    expect(h.lines.filter((line) => line === notStarted)).toHaveLength(1)
    const qRun = await startSequenceHeldAtRun(h, q, hold)
    expect([h.sequenceRunning(p), h.sequenceRunning(q)]).toEqual([true, true])

    hold.release(placed(p, 'ids'))
    hold.release(placed(q, 'ids'))
    const outcomes = await h.driveSequence(Promise.all([pRun.outcome, qRun.outcome]))
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([LIVE_ROW_OUTCOME_LAUNCHED, LIVE_ROW_OUTCOME_LAUNCHED])
    // One chain each: one kill and one run per persona.
    expect(h.stub.calls.killCalls).toEqual([{ claude_instance_id: personaInstanceId(p) }, { claude_instance_id: personaInstanceId(q) }])
    expect(hold.calls).toHaveLength(2)
    expect(h.reuseSpawns().map((reuse) => reuse.claude_instance_id)).toEqual([personaInstanceId(p), personaInstanceId(q)])
  })

  test('while P\'s sequence runs, a start-pass launch of P answers sequence-waiting and a restart-path launchSession the uncounted refused, with no agent-director call for P; Q\'s launch and Q\'s own sequence go ahead', async () => {
    const { h, p, q } = build()
    const hold = holdFindMissing(h.stub.client)
    ownRowsLiveThenMissing(h)
    const pRun = await startSequenceHeldAtRun(h, p, hold)
    const pCalls = personaCallCounts(h, p)

    expect(await h.launch(p)).toEqual({ key: p, action: 'sequence-waiting' })
    expect(await launchSession(p, h.config)).toBe('refused')

    expect(personaCallCounts(h, p)).toEqual(pCalls)
    expect([isLaunchInFlight(p), getFailureCount(p), h.notices, h.triggers]).toEqual([false, 0, [], []])
    expect(await h.launch(q)).toEqual({ key: q, action: 'spawned' })
    expect(h.stub.calls.spawnCalls.map((call) => call.claude_instance_id)).toEqual([personaInstanceId(q)])
    await h.runApproverToStop(q)
    const qRun = await startSequenceHeldAtRun(h, q, hold)

    hold.release(placed(p, 'ids'))
    hold.release(placed(q, 'ids'))
    const outcomes = await h.driveSequence(Promise.all([pRun.outcome, qRun.outcome]))
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([LIVE_ROW_OUTCOME_LAUNCHED, LIVE_ROW_OUTCOME_LAUNCHED])
  })

  test('during the sequence\'s own step-6 launch: that launch is a launch in flight and goes ahead, while another launch of P answers sequence-waiting and joins nothing', async () => {
    const { h, p } = build()
    h.script({ getResult: personaRow(h, p, { state: ENDED }) })
    const reuse = holdSequenceReuse(h, p)
    const run = h.startSequence(p, { lastReadState: LIVE })
    await h.driveSequence(reuse.entered)

    expect([isLaunchInFlight(p), h.sequenceRunning(p)]).toEqual([true, true])
    expect(await h.launch(p)).toEqual({ key: p, action: 'sequence-waiting' })

    reuse.release()
    expect(await h.driveSequence(run.outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, result: { key: p, action: 'spawned' } })
    expect([isLaunchInFlight(p), h.sequenceRunning(p)]).toEqual([false, false])
    // The one spawn is the held reuse; the waiting launch joined nothing and made none.
    expect(reuse.calls).toEqual([reuseSpawnOf(h, p)])
  })

  // An episode ends when the sequence launches, aborts by class, stops on a
  // run that did not judge its row, or escalates (SRJ-706); a later start
  // begins a new sequence, which runs its steps again from step 1.
  test.each<[string, (h: RecoveryHarness, key: string) => Promise<RecoverySequenceRequest>, LiveRowSequenceOutcome['kind']]>([
    ['it launches', async (h, key) => {
      h.script({ getResult: personaRow(h, key, { state: ENDED }) })
      return { lastReadState: LIVE }
    }, LIVE_ROW_OUTCOME_LAUNCHED],
    ['it aborts by class (ENVIRONMENT at its kill)', async (h) => {
      h.script({ killError: errTmuxNotAvailable() })
      return { lastReadState: LIVE }
    }, LIVE_ROW_OUTCOME_ABORTED],
    ['it stops on a run that did not judge its pending row', async (h, key) => {
      await pastSampleGrace(h)
      h.script({ getResult: personaRow(h, key, { state: PENDING }) })
      return { lastReadState: PENDING }
    }, LIVE_ROW_OUTCOME_NOT_JUDGED],
    ['it escalates', async (h, key) => {
      h.script({ getResult: personaRow(h, key), findMissingResult: placed(key, 'unverified_ids') })
      return { lastReadState: LIVE }
    }, LIVE_ROW_OUTCOME_ESCALATED],
  ])('after the sequence ends because %s, P\'s sequence no longer runs and a new start begins a new one', async (_label, setup, kind) => {
    const { h, p } = build()
    const request = await setup(h, p)

    expect((await h.runSequence(p, request)).kind).toBe(kind)
    expect(h.sequenceRunning(p)).toBe(false)
    const kills = h.stub.calls.killCalls.length
    expect(kills).toBeGreaterThan(0)

    expect((await h.runSequence(p, request)).kind).toBe(kind)
    expect(h.stub.calls.killCalls).toHaveLength(2 * kills)
    expect(h.sequenceRunning(p)).toBe(false)
  })

  // A latch from another path while the run is held is
  // tests/conflict-latch.test.ts's (a running sequence stops when P latches
  // from another path).
  test.each(TEARDOWN_AND_SHUTDOWN)('%s while P\'s first run is held: once the run is released no get, kill, run or launch follows for P, no alert is raised and no timer is left', async (_label, stopP, reason) => {
    const { h, p } = build()
    const hold = holdFindMissing(h.stub.client)
    ownRowsLiveThenMissing(h)
    const order = recordCallOrder(h)
    const run = await startSequenceHeldAtRun(h, p, hold)
    expect(order).toEqual(['kill', 'get', 'findMissing'])

    await stopP(h, p)
    hold.release(placed(p, 'ids'))

    expect(await h.driveSequence(run.outcome)).toEqual({ kind: LIVE_ROW_OUTCOME_STOPPED, reason, runs: 1, kills: 1, judgedRuns: 0 })
    expect(order.filter((verb) => verb !== 'status')).toEqual(['kill', 'get', 'findMissing'])
    expect([h.stub.calls.spawnCalls, killFailureLines(h, p), h.clock.pendingCount(), h.sequenceRunning(p)]).toEqual([[], [], 0, false])
    expect(h.lines.filter((line) => line === liveRowSequenceStopAskedLine(`persona=${p}`, reason))).toHaveLength(1)
  })

  test.each(SEQUENCE_STOP_WAYS)('%s during the pending wait until G: the wait\'s timer is cancelled and no run follows', async (_label, stopP, reason) => {
    const { h, p } = build()
    await clockAt(h, LAUNCH_START_MS)
    h.script({ getResult: personaRow(h, p, { state: PENDING }) })
    const order = recordCallOrder(h)
    const run = h.startSequence(p, { lastReadState: PENDING, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })
    for (let flushes = 0; flushes < 20 && h.clock.pendingCount() === 0; flushes++) await h.clock.flush()
    expect(h.clock.pending().map((timer) => timer.dueAt)).toEqual([LAUNCH_START_MS + adGraceMsInEffect()])

    await stopP(h, p)

    expect(await run.outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason, runs: 0 })
    expect(h.clock.pendingCount()).toBe(0)
    expect(order.filter((verb) => verb !== 'status')).toEqual(['get'])
    expect(h.sequenceRunning(p)).toBe(false)
  })

  // A teardown's and shutdown's stop during the spacing is
  // tests/unavailable-retry.test.ts's (it arms nothing and cancels the wait).
  test('a latch of P from another path during the spacing between runs cancels the wait, and no further run follows', async () => {
    const { h, p } = build()
    h.script({ getResult: personaRow(h, p) })
    const run = h.startSequence(p, { lastReadState: LIVE })
    for (let flushes = 0; flushes < 20 && h.clock.pendingCount() === 0; flushes++) await h.clock.flush()
    expect(h.stub.calls.findMissingCalls).toHaveLength(1)

    await LATCH_FROM_ANOTHER_PATH[1](h, p)

    expect(await run.outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED, runs: 1 })
    expect([h.clock.pendingCount(), h.stub.calls.findMissingCalls.length]).toEqual([0, 1])
  })

  test('after shutdown, a start answers closed with one line and makes no call', async () => {
    const { h, p } = build()
    h.shutdown()

    expect(startLiveRowSequence(h.sequenceRequest(p, { lastReadState: LIVE }))).toBe(LIVE_ROW_START_CLOSED)

    await h.clock.flush()
    expect([h.stub.callCount(), h.sequenceRunning(p)]).toEqual([0, false])
    const closed = liveRowSequenceNotStartedLine(`persona=${p}`, personaInstanceId(p), LIVE_ROW_START_CLOSED)
    expect(h.lines.filter((line) => line === closed)).toHaveLength(1)
  })

  test('the sequence runs in its own recovery attempt, detached from its starter\'s: an UNAVAILABLE answer at its kill arms P\'s retry timer and is not recorded in the starter\'s launch attempt', async () => {
    const { h, p } = build()
    h.script({ killError: errTmuxUnresponsive('kill') })
    let starter: AttemptView | undefined

    const outcome = await runInAttempt(p, 'launch', async (attempt) => {
      starter = attempt
      return h.driveSequence(h.startSequence(p, { lastReadState: LIVE }).outcome)
    })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_ABORTED, errorClass: AD_ERROR_CLASS_UNAVAILABLE })
    expect(starter?.lastError).toBeUndefined()
    expect(h.triggers[0]).toEqual({ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
    expect(h.controller.isArmed(p)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Started at the collision ladder's real replacement sites (b.jg5 SRJ-707,
// SRJ-705, SRJ-706; E22)
//
// A launch of P (`h.launch`, the start pass's, or the restart path's
// `launchSession`) whose optimistic spawn collides with P's row read live in
// another directory starts P's sequence through the session manager's start
// entry (step 1, the conversation not kept, alert context `recovery`) and
// answers `sequence-waiting` (`launchSession`'s uncounted `'refused'`) while
// the sequence runs in the background. A not-judged stop arms P's timer, and
// the next retry, through the restart path, reaches the same site and begins
// a new sequence episode. Each site's reuse and SRJ-110 at its first kill are
// tests/session-manager.test.ts's.
// ---------------------------------------------------------------------------

describe('started at a collision ladder replacement site: the launch answers while the sequence runs in the background, the sequence ends in a reuse, and a later retry begins a new episode (SRJ-707, SRJ-706)', () => {
  /** P's row in another directory read `state`, with a session id: a resume would keep the conversation. */
  const elsewhereWithSession = (h: RecoveryHarness, key: string, state: string): Phase1GetResult =>
    personaRow(h, key, { cwd: h.home, state, claude_session_id: SESSION_ID })

  /** The start line of P's sequence as the ladder starts it, the state it last read the seed. */
  const ladderStartLine = (h: RecoveryHarness, key: string, lastReadState: string): string =>
    liveRowSequenceStartLine(renderPersonaRef(key, key), h.sequenceRequest(key, { lastReadState }))

  test('a launch over P\'s live row in another directory resolves while the sequence it started runs (its first run held), with no launch of its own, answering sequence-waiting; the restart path\'s launchSession meanwhile answers the uncounted refused with no call; released, the sequence reads the row missing and makes one reuse of cscb_<key> though the row has a session id', async () => {
    const { h, p } = build()
    const hold = holdFindMissing(h.stub.client)
    h.script({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: [cannedOk(elsewhereWithSession(h, p, LIVE))],
      getResult: personaRow(h, p, { state: MISSING, claude_session_id: SESSION_ID }),
    })
    const order = recordCallOrder(h)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'sequence-waiting' })
    await h.driveSequence(hold.entered())
    expect(h.sequenceRunning(p)).toBe(true)
    expect(await launchSession(p, h.config)).toBe('refused')
    expect(order).toEqual(['spawn', 'get', 'kill', 'get', 'findMissing'])
    expect(h.lines).toContain(ladderStartLine(h, p, LIVE))

    hold.release(placed(p, 'ids'))
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, result: { key: p, action: 'spawned' } })

    expectCallsThenApprover(order, ['spawn', 'get', 'kill', 'get', 'findMissing', 'get', 'spawn'])
    expect(h.reuseSpawns()).toEqual([reuseSpawnOf(h, p)])
    expect(h.stub.calls.resumeCalls).toEqual([])
    await h.runApproverToStop(p)
  })

  test('a not-judged stop arms P\'s timer; its next retry reaches the same replacement site through the restart path and begins a new sequence episode, which reaches the reuse; one sequence per episode', async () => {
    const { h, p } = build()
    await pastSampleGrace(h)
    // Episode 1: the ladder's get reads P's pending row in another directory, and the
    // sequence's own gets read it pending; its run leaves it in neither list.
    let episode = 1
    let secondGets = 0
    h.script({
      spawnQueue: [cannedErr(errInstanceIdCollision()), cannedErr(errInstanceIdCollision())],
      getFn: () => {
        if (episode === 1) return elsewhereWithSession(h, p, PENDING)
        return secondGets++ === 0 ? elsewhereWithSession(h, p, LIVE) : personaRow(h, p, { state: ENDED, claude_session_id: SESSION_ID })
      },
    })

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'sequence-waiting' })
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_NOT_JUDGED })
    expect(h.controller.view(p)?.causes).toEqual([UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED])
    expect(h.reuseSpawns()).toEqual([])

    // Episode 2: the retry's restart path reads the row dead, kills it and launches; the
    // ladder's get reads the row live in another directory again, and a new sequence starts.
    episode = 2
    h.script({ statusResult: cannedStatusResult({ state: ENDED }) })
    await retryNow(h, p)
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, result: { key: p, action: 'spawned' } })

    expect(h.lines.filter((line) => line.startsWith(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${renderPersonaRef(p, p)}: started at step `))).toEqual([
      ladderStartLine(h, p, PENDING),
      ladderStartLine(h, p, LIVE),
    ])
    expect(h.reuseSpawns()).toEqual([reuseSpawnOf(h, p)])
    expect(h.stub.calls.resumeCalls).toEqual([])
    await h.runApproverToStop(p)
    h.controller.stop(p, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
  })

  test('a step-5 escalation of the sequence the ladder started carries the recovery context: P removed meanwhile gets one persona-kill-failed entry with it, and nothing to Slack', async () => {
    const { h, p } = build()
    h.script({ spawnQueue: [cannedErr(errInstanceIdCollision())], getQueue: [cannedOk(elsewhereWithSession(h, p, LIVE))], getResult: personaRow(h, p) })
    // The sequence's last get: after the ladder's spawn and get, its kill, get, three runs and gets, kill, and one run.
    const lastGet = ['spawn', 'get', 'kill', 'get', ...runAndGet(LIVE_ROW_SEQUENCE_STEP3_RUNS), 'kill', ...runAndGet(1)].length - 1
    recordCallOrder(h, { at: lastGet, run: () => h.remove(p) })

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'sequence-waiting' })
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED })

    expect(h.lines).toContain(ladderStartLine(h, p, LIVE))
    expect(h.episodeNotices).toEqual([])
    expect(startupEntriesOf(h, PERSONA_KILL_FAILED_LABEL)).toEqual([killFailureRecoveryEntry(p, ordinaryAlertContent(p), KILL_FAILURE_CONTEXT_RECOVERY)])
  })
})

// ---------------------------------------------------------------------------
// SRJ-411's Test line, its mismatch leg (b.jg5 SRJ-411, SRJ-409, SRJ-705; the
// E21 hatch note): a `pending` row whose `cwd` or `config_dir` label differs
// from P's is not covered, so the pending-only retry's read-and-step sends it
// through the live-row sequence (the retry timer is a launch path too), with
// the conversation not kept: its step-1 kill, then its step-2 `get`, which
// still reads the row `pending` and waits until G past the row's launch
// start, never earlier; then its run marks the row missing and the reuse is
// its one and final launch. Nothing is typed and no approver laps before
// that reuse. P's timer is armed pending-only directly; the retry's answer is
// tests/unavailable-retry.test.ts's, the step's start request
// tests/pending-row.test.ts's, the destructive-modify leg
// tests/reload-apply.test.ts's.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-411: a pending row whose cwd or config_dir differs from P\'s goes through the live-row sequence from the pending-only retry, with no lap: its wait until G from the launch start, then one reuse, the final launch', () => {
  /** Row labels without the `config_dir` label (a label missing is a mismatch, SRJ-1504). */
  const withoutConfigDir = (labels: Record<string, string> | undefined): Record<string, string> =>
    Object.fromEntries(Object.entries(labels ?? {}).filter(([name]) => `${name}=` !== CONFIG_DIR_LABEL_PREFIX))

  test.each<[string, (h: RecoveryHarness, key: string) => PersonaGetResultOverrides]>([
    ['its cwd another existing directory', (h) => ({ cwd: h.home })],
    ['its config_dir label missing', (h, key) => ({ labels: withoutConfigDir(personaRow(h, key).labels) })],
  ])('P\'s pending row with %s: the retry starts one sequence; its kill and get, then no run before G from the launch start and the first exactly at it; no send-keys or pane read for P until the reuse, which is made once, last', async (_label, mismatch) => {
    const { h, p, q } = build()
    await clockAt(h, LAUNCH_START_MS)
    const deadline = LAUNCH_START_MS + adGraceMsInEffect()
    // The row reads pending, mismatched, until the sequence's run marks it missing.
    h.script({
      statusResult: cannedStatusResult({ state: PENDING }),
      getFn: () => personaRow(h, p, h.stub.calls.findMissingCalls.length === 0 ? { state: PENDING, ...mismatch(h, p) } : { state: MISSING }),
    })
    runs(h, placed(p, 'ids'))
    h.controller.armPendingOnly(p)
    const calls = recordCallTimes(h)

    const retryAt = await retryNow(h, p)
    expect(retryAt).toBeLessThan(deadline)
    expect(h.sequenceRunning(p)).toBe(true)
    const outcome = await h.driveSequence(h.sequenceSettled(p))

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, reason: LIVE_ROW_LAUNCH_REASON_NOT_KEPT, result: { key: p, action: 'spawned' } })
    // The retry's status and the step's get; the sequence's step-1 kill and step-2 get; its wait; then the run, its get and the reuse.
    const expected: Array<readonly [string, number]> = [
      ['status', retryAt],
      ['get', retryAt],
      ['kill', retryAt],
      ['get', retryAt],
      ['findMissing', deadline],
      ['get', deadline],
      ['spawn', deadline],
    ]
    expect(calls.slice(0, expected.length)).toEqual(expected)
    // After the reuse, only its dialog approver's calls (b.jg5 SRJ-401): no send-keys or pane read for P before it.
    expectCallsThenApprover(calls.map(([verb]) => verb), expected.map(([verb]) => verb))
    expectOneReuseOf(h, p)
    expectUntouched(h, q)
    await h.runApproverToStop(p)
  })
})

// ---------------------------------------------------------------------------
// Started at the collision ladder's ErrSpawnNotResumable with dead evidence
// (b.jg5 SRJ-710, SRJ-611, SRJ-705, SRJ-706)
//
// A launch of P (`h.launch`) reaches the ladder's `waiting` branch; its
// reconnect's one `send-keys` answers `ErrTmuxSendKeys` (`tmux-gone`, dead
// evidence), so after the find-missing run P's `resume` is made; it answers
// `ErrSpawnNotResumable`, and its one re-read finds the row `waiting`. The
// ladder starts P's sequence through the session manager's start entry
// (step 1, seeded `waiting`, the conversation kept, alert context
// `recovery`) and answers `sequence-waiting` while it runs in the
// background. Its step 6 is a `resume` of the row when the row it last read
// has a session id, a reuse of the same id when it has none. A not-judged
// stop arms P's timer, and the next retry, through the restart path's
// escalate-dead relaunch, reaches the same site and begins a new episode.
// Step 6's own `resume` follows SRJ-113's table at the entry (its rows and
// its latches' records are tests/session-manager.test.ts's): here what the sequence does with each
// answer: a CONFLICT ends it latched with no further call; ErrSpawnNotFound
// launches by one plain spawn; ErrSpawnNotResumable makes one re-read, starts
// no second sequence and ends the sequence without its launch, arming the
// not-resumable end's cause (nothing when the re-read latches P).
// ---------------------------------------------------------------------------

describe('started at the ladder\'s ErrSpawnNotResumable with dead evidence: the launch answers while the sequence runs, the conversation is kept, and step 6\'s resume answers end it by SRJ-113 and SRJ-710', () => {
  /** The ladder's calls before the sequence: the colliding spawn, the collision get, the reconnect, the find-missing run, the resume and its re-read. */
  const LADDER_CALLS = ['spawn', 'get', 'sendKeys', 'findMissing', 'resume', 'get'] as const

  /**
   * P's launch over its `waiting` row whose reconnect answers GONE and whose
   * `resume` answers ErrSpawnNotResumable once, its re-read finding the row
   * `waiting`; every later `get` (the sequence's) answers `sequenceRow`.
   */
  function scriptGoneNotResumable(h: RecoveryHarness, key: string, sequenceRow: Phase1GetResult): void {
    h.script({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: [cannedOk(personaRow(h, key)), cannedOk(personaRow(h, key))],
      getResult: sequenceRow,
      sendKeysError: errTmuxSendKeys(),
      resumeQueue: [cannedErr(errSpawnNotResumable())],
    })
  }

  test('the launch resolves while the sequence it started runs (its first run held), answering sequence-waiting with no launch of its own; released, the sequence reads the row missing with a session id and makes one resume of it, no reuse', async () => {
    const { h, p } = build()
    scriptGoneNotResumable(h, p, personaRow(h, p, { state: MISSING, claude_session_id: SESSION_ID }))
    const hold = holdFindMissing(h.stub.client)
    const order = recordCallOrder(h)

    const launched = h.launch(p)
    // The ladder's own find-missing run before its resume.
    await hold.entered(1)
    hold.release(cannedFindMissing())
    expect(await launched).toStrictEqual({ key: p, action: 'sequence-waiting' })
    await h.driveSequence(hold.entered(2))
    expect(h.sequenceRunning(p)).toBe(true)
    expect(order).toEqual([...LADDER_CALLS, 'kill', 'get', 'findMissing'])
    expect(h.lines).toContain(liveRowSequenceStartLine(renderPersonaRef(p, p), h.sequenceRequest(p, { lastReadState: LIVE, keepsConversation: true })))

    hold.release(placed(p, 'ids'))
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({
      kind: LIVE_ROW_OUTCOME_LAUNCHED,
      launchKind: LIVE_ROW_LAUNCH_RESUME,
      reason: LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION,
      result: { key: p, action: 'resumed' },
    })
    expectCallsThenApprover(order, [...LADDER_CALLS, 'kill', 'get', 'findMissing', 'get', 'resume'])
    expect(h.stub.calls.resumeCalls).toEqual([{ claude_instance_id: personaInstanceId(p) }, { claude_instance_id: personaInstanceId(p) }])
    expect(h.reuseSpawns()).toEqual([])
    await h.runApproverToStop(p)
  })

  test.each<[string, PersonaGetResultOverrides, LiveRowSequenceLaunchKind, LiveRowSequenceLaunchReason]>([
    ['ended with a session id', { state: ENDED, claude_session_id: SESSION_ID }, LIVE_ROW_LAUNCH_RESUME, LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION],
    ['missing with a session id', { state: MISSING, claude_session_id: SESSION_ID }, LIVE_ROW_LAUNCH_RESUME, LIVE_ROW_LAUNCH_REASON_KEEPS_CONVERSATION],
    ['ended with no session id', { state: ENDED }, LIVE_ROW_LAUNCH_REUSE, LIVE_ROW_LAUNCH_REASON_NO_SESSION_ID],
  ])('the sequence kills, gets, runs and gets; a row read %s gives step 6\'s launch kind: a resume of the session id, or one reuse of the same id when it has none', async (_label, row, launchKind, reason) => {
    const { h, p } = build()
    scriptGoneNotResumable(h, p, personaRow(h, p, row))
    const order = recordCallOrder(h)

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'sequence-waiting' })
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind, reason, kills: 1, runs: 1 })

    const launch = launchKind === LIVE_ROW_LAUNCH_RESUME ? 'resume' : 'spawn'
    expectCallsThenApprover(order, [...LADDER_CALLS, 'kill', 'get', 'findMissing', 'get', launch])
    if (launchKind === LIVE_ROW_LAUNCH_RESUME) expect(h.reuseSpawns()).toEqual([])
    else expect(h.reuseSpawns()).toEqual([reuseSpawnOf(h, p)])
    expect(getFailureCount(p)).toBe(0)
    await h.runApproverToStop(p)
  })

  test('a step-5 escalation of the sequence the not-resumable step started carries the recovery context: P removed meanwhile gets one persona-kill-failed entry with it, and nothing to Slack', async () => {
    const { h, p } = build()
    scriptGoneNotResumable(h, p, personaRow(h, p))
    // The sequence's last get: after the ladder's calls, its kill, get, three runs and gets, kill, and one run.
    const lastGet = [...LADDER_CALLS, 'kill', 'get', ...runAndGet(LIVE_ROW_SEQUENCE_STEP3_RUNS), 'kill', ...runAndGet(1)].length - 1
    recordCallOrder(h, { at: lastGet, run: () => h.remove(p) })

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'sequence-waiting' })
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED })

    expect(h.episodeNotices).toEqual([])
    expect(startupEntriesOf(h, PERSONA_KILL_FAILED_LABEL)).toEqual([killFailureRecoveryEntry(p, ordinaryAlertContent(p), KILL_FAILURE_CONTEXT_RECOVERY)])
  })

  test('a not-judged stop arms P\'s timer; its next retry, through the restart path\'s escalate-dead relaunch (no kill: its re-probe read the row ended, voiding the verdict), meets a fresh GONE on the row its relaunch reads live, reaches the not-resumable site again and begins a new sequence episode, which ends in resume', async () => {
    const { h, p } = build()
    await pastSampleGrace(h)
    const calls = h.stub.calls
    // Episode 1: the sequence reads P's own pending row (past its wait), and its run leaves it in neither list.
    scriptGoneNotResumable(h, p, personaRow(h, p, { state: PENDING }))
    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'sequence-waiting' })
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_NOT_JUDGED })
    expect(h.controller.view(p)?.causes).toEqual([UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED])

    // Episode 2: the retry's run reads the row waiting until its escalate-dead
    // sweep (the reconnect's GONE: verdict dead-session) and ended after it.
    // That re-probe read the row, which voids the verdict (dead evidence
    // covers one life): no kill, and the relaunch carries none (b.jg5
    // SRJ-110, SRJ-314, SRJ-611). The relaunch's collision get reads the row
    // waiting (a launch the verdict never saw), whose reconnect answers GONE:
    // new evidence of that life; the resume answers ErrSpawnNotResumable and
    // the re-read finds the row waiting.
    const sweptAfter = calls.findMissingCalls.length
    h.script({
      statusFn: () => cannedStatusResult({ state: calls.findMissingCalls.length > sweptAfter ? ENDED : LIVE }),
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: [cannedOk(personaRow(h, p)), cannedOk(personaRow(h, p))],
      getResult: personaRow(h, p, { state: ENDED, claude_session_id: SESSION_ID }),
      sendKeysError: errTmuxSendKeys(),
      resumeQueue: [cannedErr(errSpawnNotResumable())],
    })
    // The escalate-dead sweep is a new run, not the memo's answer from episode 1.
    _resetFindMissingMemo()
    const killsBefore = calls.killCalls.length
    await retryNow(h, p)
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_RESUME, result: { key: p, action: 'resumed' }, kills: 1 })
    // The sequence's own step-1 kill only: none before the relaunch.
    expect(calls.killCalls.length - killsBefore).toBe(1)

    const startLine = liveRowSequenceStartLine(renderPersonaRef(p, p), h.sequenceRequest(p, { lastReadState: LIVE, keepsConversation: true }))
    expect(h.lines.filter((line) => line.startsWith(`${LIVE_ROW_SEQUENCE_LOG_PREFIX} ${renderPersonaRef(p, p)}: started at step `))).toEqual([startLine, startLine])
    expect(h.reuseSpawns()).toEqual([])
    await h.runApproverToStop(p)
    h.controller.stop(p, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
  })

  // Step 6's own `resume` (SRJ-113 at the entry, SRJ-710): each sequence
  // reads the row `ended` with a session id at its step-2 get and after its
  // one run, so its step 6 is a `resume`, after one kill, get, run and get.
  const SEQUENCE_CALLS = ['kill', 'get', 'findMissing', 'get', 'resume'] as const

  /** Run P's sequence to its step-6 `resume`, which answers `err`; the `get` after it (the not-resumable step's re-read) answers `reread`. */
  async function runToStep6Resume(h: RecoveryHarness, key: string, err: Error, reread?: Phase1GetResult | Error): Promise<{ outcome: LiveRowSequenceOutcome; order: string[] }> {
    const row = personaRow(h, key, { state: ENDED, claude_session_id: SESSION_ID })
    h.script({ resumeError: err, getResult: row, ...(reread === undefined ? {} : { getQueue: [cannedOk(row), cannedOk(row), reread instanceof Error ? cannedErr(reread) : cannedOk(reread)] }) })
    const order = recordCallOrder(h)
    const outcome = await h.runSequence(key, { lastReadState: LIVE, keepsConversation: true })
    return { outcome, order }
  }

  test('step 6\'s resume answering CONFLICT: P latched with the refused operation "resume", the sequence ends with no further call and nothing armed', async () => {
    const { h, p } = build()
    const row = sequenceResumeConflictRowsAt(ENDED)[0]!

    const { outcome, order } = await runToStep6Resume(h, p, row.build())

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_RESUME, result: { key: p, action: 'latched' } })
    expect(outcome.armed).toBeUndefined()
    expect(order).toEqual([...SEQUENCE_CALLS])
    expect(h.latch.record(p)?.refusedOperation).toBe(REFUSED_OPERATION_RESUME)
    expect(h.triggers).toEqual([])
  })

  test('step 6\'s resume answering ErrSpawnNotFound: one plain spawn of the id (no reuse flag) and the sequence launches; no spawn-failure notice, nothing counted, and only the launch\'s pending-only arm', async () => {
    const { h, p } = build()

    const { outcome, order } = await runToStep6Resume(h, p, errSpawnNotFound())

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_RESUME, result: { key: p, action: 'spawned' } })
    expect(outcome.armed).toBeUndefined()
    expectCallsThenApprover(order, [...SEQUENCE_CALLS, 'spawn'])
    expect(h.stub.calls.spawnCalls.map((call) => [call.claude_instance_id, call.reuse_finished])).toEqual([[personaInstanceId(p), undefined]])
    expect([h.notices, h.triggers, getFailureCount(p)]).toEqual([[], [{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_PENDING_ROW }], 0])
    await h.runApproverToStop(p)
  })

  // b.jg5 SRJ-111, SRJ-705, SRJ-713 (hatch note E23): the plain spawn after
  // step 6's ErrSpawnNotFound colliding runs no get-then-act inside the
  // sequence; the sequence ends without its launch and the retry it arms is
  // the get-then-act, through the restart path's ladder.
  test('step 6\'s resume answering ErrSpawnNotFound, its plain spawn colliding (ErrInstanceIdCollision): not launched (spawn-collision), the reuse-collision cause armed, no second spawn, nothing counted or posted; the retry it arms makes the ladder\'s get-then-act', async () => {
    const { h, p } = build()
    h.script({ spawnError: errInstanceIdCollision() })

    const { outcome, order } = await runToStep6Resume(h, p, errSpawnNotFound())

    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_NOT_LAUNCHED,
      launchKind: LIVE_ROW_LAUNCH_RESUME,
      notLaunched: LIVE_ROW_NOT_LAUNCHED_SPAWN_COLLISION,
      runs: 1,
      kills: 1,
      judgedRuns: 1,
      armed: LIVE_ROW_ARM_REUSE_COLLISION,
    })
    expect(order).toEqual([...SEQUENCE_CALLS, 'spawn'])
    expect(h.stub.calls.spawnCalls.map((call) => call.reuse_finished)).toEqual([undefined])
    expect(liveRowSequenceEndLine(`persona=${p}`, outcome)).toContain(`: not launched (resume; ${LIVE_ROW_NOT_LAUNCHED_SPAWN_COLLISION}) — `)
    expectEndArmed(h, outcome, UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION)

    // The retry: the row reads ended with its session id; the ladder's plain
    // first spawn collides, its collision get reads the row and resumes it.
    h.script({ spawnError: undefined, spawnQueue: [cannedErr(errInstanceIdCollision())], resumeError: undefined, statusResult: cannedStatusResult({ state: ENDED }) })
    const retryOrder = recordCallOrder(h)
    await retryNow(h, p)

    const launches = retryOrder.filter((verb) => ['spawn', 'get', 'resume'].includes(verb))
    expect(launches.slice(0, 3)).toEqual(['spawn', 'get', 'resume'])
    expect(h.stub.calls.resumeCalls).toHaveLength(2)
    expect(h.stub.calls.spawnCalls.map((call) => call.reuse_finished)).toEqual([undefined, undefined])
    expect([h.notices, getFailureCount(p)]).toEqual([[], 0])
    if (h.approverRunning(p)) await h.runApproverToStop(p)
    h.controller.stop(p, UNAVAILABLE_RETRY_STOP_TORN_DOWN)
  })

  /**
   * Step 6's ErrSpawnNotResumable, by what its re-read finds: the not-launched reason, the line's re-read and outcome, and the cause the end arms (none when the re-read latches P).
   * A re-read in a state CSCB does not know (an unreadable one included) is the SRJ-611 describe's in tests/session-manager.test.ts, on a sequence a GONE-based path started.
   */
  const STEP6_NOT_RESUMABLE: ReadonlyArray<readonly [string, (h: RecoveryHarness, key: string) => Phase1GetResult | Error, LiveRowSequenceNotLaunchedReason, (h: RecoveryHarness, key: string) => PersonaRowReread, string, LiveRowSequenceArmCause | undefined, readonly string[]]> = [
    ['the row ended (a lost race)', (h, key) => personaRow(h, key, { state: ENDED }), LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE, () => ({ kind: ROW_REREAD_FINISHED, lastRead: latchRowStateRead(ENDED) }), SEQUENCE_NOT_RESUMABLE_LOST_RACE_OUTCOME, LIVE_ROW_ARM_LOST_RACE, []],
    ['no row (a lost race)', () => errSpawnNotFound(), LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE, () => ({ kind: ROW_REREAD_FINISHED, lastRead: LATCH_ROW_STATE_NO_ROW }), SEQUENCE_NOT_RESUMABLE_LOST_RACE_OUTCOME, LIVE_ROW_ARM_LOST_RACE, []],
    ['the row waiting (live, yet no second sequence: a lost race)', (h, key) => personaRow(h, key), LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE, (h, key) => ({ kind: ROW_REREAD_LIVE, row: personaRow(h, key), lastRead: latchRowStateRead(LIVE) }), SEQUENCE_NOT_RESUMABLE_LOST_RACE_OUTCOME, LIVE_ROW_ARM_LOST_RACE, []],
    ['a refused read (UNAVAILABLE): a lost race after the read\'s own cause', () => unavailableAt('get'), LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE, () => ({ kind: ROW_REREAD_REFUSED }), SEQUENCE_NOT_RESUMABLE_LOST_RACE_OUTCOME, LIVE_ROW_ARM_LOST_RACE, [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE]],
    ['the row pending (a launch in progress)', (h, key) => personaRow(h, key, { state: PENDING }), LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE_PENDING, (h, key) => ({ kind: ROW_REREAD_PENDING, row: personaRow(h, key, { state: PENDING }), lastRead: latchRowStateRead(PENDING) }), SEQUENCE_NOT_RESUMABLE_PENDING_OUTCOME, LIVE_ROW_ARM_ENDED, []],
  ]

  test.each(STEP6_NOT_RESUMABLE)('step 6\'s resume answering ErrSpawnNotResumable, its re-read finding %s: one get, no second sequence, kill, delete or launch; not launched, nothing counted; the end arms its cause', async (_label, reread, reason, rereadOf, lineOutcome, cause, before) => {
    const { h, p } = build()

    const { outcome, order } = await runToStep6Resume(h, p, errSpawnNotResumable(), reread(h, p))

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_NOT_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_RESUME, notLaunched: reason, kills: 1 })
    expect(order).toEqual([...SEQUENCE_CALLS, 'get'])
    expect(h.errors.filter((line) => line.includes(` on resume for ${renderPersonaRef(p, p)} — re-read: `))).toEqual([
      spawnNotResumableLine(LIVE_ROW_SEQUENCE_LOG_PREFIX, renderPersonaRef(p, p), describeAgentDirectorFailure(errSpawnNotResumable()), rereadOf(h, p), undefined, lineOutcome),
    ])
    expect(h.sequenceRunning(p)).toBe(false)
    expectEndArmed(h, outcome, cause!, before)
  })

  test('step 6\'s resume answering ErrSpawnNotResumable, its re-read latching P (its own pending row with no launch start): the sequence stops for the latch with nothing armed and no further call', async () => {
    const { h, p } = build()

    const { outcome, order } = await runToStep6Resume(h, p, errSpawnNotResumable(), personaRow(h, p, { state: PENDING, launch_started_at: SAMPLE_LAUNCH_START_NONE }))

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED })
    expect(outcome.armed).toBeUndefined()
    expect(order).toEqual([...SEQUENCE_CALLS, 'get'])
    expect(h.latch.isLatched(p)).toBe(true)
    expect(h.errors.filter((line) => line.includes(` on resume for ${renderPersonaRef(p, p)} — re-read: `))).toEqual([
      spawnNotResumableLine(LIVE_ROW_SEQUENCE_LOG_PREFIX, renderPersonaRef(p, p), describeAgentDirectorFailure(errSpawnNotResumable()), { kind: ROW_REREAD_LATCHED }, undefined, SEQUENCE_NOT_RESUMABLE_LATCHED_OUTCOME),
    ])
    expect([h.triggers, h.controller.armedKeys(), getFailureCount(p)]).toEqual([[], [], 0])
  })
})

// ---------------------------------------------------------------------------
// Step 6's reuse answering ErrInvalidFlags (b.jg5 SRJ-112, SRJ-207, SRJ-205)
// ---------------------------------------------------------------------------

/**
 * Step 6 reaching the reuse: a reuse step 6 over the row finished at step 3,
 * or a `resume` step 6 whose no-transcript answer (ErrNoSessionId) goes on to
 * the reuse; with the launch kind, the calls up to and including the reuse
 * and whether the persona keeps its conversation.
 */
const STEP6_REUSES: ReadonlyArray<readonly [string, (h: RecoveryHarness, key: string) => void, LiveRowSequenceLaunchKind, readonly string[], boolean]> = [
  ['a reuse step 6 on a finished row', (h, key) => finishedAtRun1(h, key, {}), LIVE_ROW_LAUNCH_REUSE, ['kill', 'get', 'findMissing', 'get', 'spawn'], false],
  [
    'a resume step 6 whose ErrNoSessionId fallback reaches the reuse',
    (h, key) => h.script({ resumeError: errNoSessionId(), getResult: personaRow(h, key, { state: ENDED, claude_session_id: SESSION_ID }) }),
    LIVE_ROW_LAUNCH_RESUME,
    ['kill', 'get', 'findMissing', 'get', 'resume', 'spawn'],
    true,
  ],
]

describe('step 6\'s reuse answering ErrInvalidFlags holds P: the sequence ends launched with the held result, nothing armed and one alert; below the floor it ends stopping, with no hold (b.jg5 SRJ-112, SRJ-207, SRJ-205)', () => {
  test.each(STEP6_REUSES)('%s, the reuse answering ErrInvalidFlags with a passing binary: P held, one alert, nothing armed or counted; no second launch, no further resume, no plain spawn, no kill after it and no delete; Q untouched', async (_label, script, launchKind, calls, keepsConversation) => {
    const { h, p, q } = build()
    const rc = h.versionRecheck({ version: PHASE1_RC_VERSION })
    script(h, p)
    h.script({ spawnError: errInvalidFlags('spawn') })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE, keepsConversation })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind, result: { key: p, action: 'held' } })
    expect(outcome.armed).toBeUndefined()
    expect(order).toEqual([...calls])
    expect(rc.resolves).toHaveLength(1)
    expect([h.invalidFlagsHold.heldKeys(), h.invalidFlagsHold.beganUnder(p)]).toEqual([[p], PHASE1_RC_VERSION])
    expect(h.episodeNotices).toEqual([{ key: p, text: INVALID_FLAGS_HOLD_ALERT_TEXT }])
    // One reuse, the only spawn: no plain spawn in its place.
    expectOneReuseOf(h, p)
    expect(h.stub.calls.resumeCalls).toHaveLength(launchKind === LIVE_ROW_LAUNCH_RESUME ? 1 : 0)
    expect([h.triggers, h.controller.armedKeys(), getFailureCount(p), h.notices]).toEqual([[], [], 0, []])
    expect(h.unclassifiedErrorOpen(p)).toBe(false)
    expect(h.lines.filter((line) => line === liveRowSequenceEndLine(`persona=${p}`, outcome))).toHaveLength(1)
    expect(h.sequenceRunning(p)).toBe(false)
    // Only the re-check's own timer is left on the clock.
    expect(h.clock.pendingCount()).toBe(rc.pendingTimers())
    expectUntouched(h, q)
  })

  test.each(STEP6_REUSES)('%s, the reuse answering ErrInvalidFlags with a binary below the floor: the server stops once, the launch ends stopping; no hold, no alert, nothing armed or counted', async (_label, script, launchKind, calls, keepsConversation) => {
    const { h, p } = build()
    const rc = h.versionRecheck({ version: OLD_AD_VERSION })
    script(h, p)
    h.script({ spawnError: errInvalidFlags('spawn') })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE, keepsConversation })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind, result: { key: p, action: 'failed', stopping: true } })
    expect(outcome.armed).toBeUndefined()
    expect(order).toEqual([...calls])
    expect([rc.resolves.length, rc.stops]).toEqual([1, [AD_VERSION_RECHECK_STOP_EXIT_CODE]])
    expect([h.invalidFlagsHold.heldKeys(), h.episodeNotices, h.triggers, h.controller.armedKeys(), getFailureCount(p)]).toEqual([[], [], [], [], 0])
    expect(h.clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// A retired key's old life through the sequence (b.jg5 SRJ-805, SRJ-806,
// SRJ-1007)
//
// P is recorded as retired, with no mark, through the harness's store
// (`retireKey`). The sequence's final launch for it is a reuse spawn, never a
// `resume`, whatever its starter's flag (the start entry sets the flag while
// the key is recorded), and only a reuse that succeeds sets the mark; a
// sequence that escalates raises the ordinary alert for P's own id.
// ---------------------------------------------------------------------------

describe('a retired key\'s sequence: its final launch is a reuse that sets the mark only on success, and its step-5 alert names P\'s own id (b.jg5 SRJ-805, SRJ-806, SRJ-1007)', () => {
  /** P and Q, P recorded as retired with no mark; P's row resumable but for the key (resume_enabled true). */
  function retiredBuild(): { h: RecoveryHarness; p: string; q: string } {
    const built = build({ resumeEnabled: true })
    built.h.retireKey(built.p)
    return built
  }

  /** P's mark as the running store and the record file read it. */
  function markOf(h: RecoveryHarness, key: string): [boolean, boolean] {
    return [h.retiredEntry(key).marked, (readRetiredKeysRecord(h.stateDir)?.get(key)?.newLifeBegunAt ?? null) !== null]
  }

  test.each([
    ['the starter set the retired-key flag', true],
    ['the starter did not set it (the start entry sets it while the key is recorded)', false],
  ] as const)('%s: over a live row whose session id P could resume, the sequence ends in one reuse of cscb_<key>, no resume; fresh-retired, and the mark is set', async (_label, retiredKey) => {
    const { h, p } = retiredBuild()
    finishedAtRun1(h, p, { claude_session_id: SESSION_ID })
    // The new life reads pending to the approver, so no read of it clears the entry (b.jg5 SRJ-807).
    h.script({ statusResult: cannedStatusResult({ state: PENDING }) })

    const outcome = await h.runSequence(p, { lastReadState: LIVE, keepsConversation: true, retiredKey })

    expect(outcome).toMatchObject({
      kind: LIVE_ROW_OUTCOME_LAUNCHED,
      launchKind: LIVE_ROW_LAUNCH_REUSE,
      reason: LIVE_ROW_LAUNCH_REASON_RETIRED_KEY,
      result: { key: p, action: SPAWN_ACTION_FRESH_RETIRED },
    })
    expectOneReuseOf(h, p)
    expect(h.stub.calls.resumeCalls).toEqual([])
    expect(markOf(h, p)).toEqual([true, true])
    await h.runApproverToStop(p)
  })

  test.each<[string, () => Error, Partial<LiveRowSequenceOutcome>]>([
    ['UNAVAILABLE (ErrTmuxUnresponsive)', () => errTmuxUnresponsive('spawn'), { kind: LIVE_ROW_OUTCOME_LAUNCHED, result: { key: 'p', action: SPAWN_ACTION_RETRYING } }],
    ['a collision (ErrInstanceIdCollision)', () => errInstanceIdCollision(), { kind: LIVE_ROW_OUTCOME_NOT_LAUNCHED, notLaunched: LIVE_ROW_NOT_LAUNCHED_REUSE_COLLISION }],
    ['ErrInvalidFlags (P held)', () => errInvalidFlags('spawn'), { kind: LIVE_ROW_OUTCOME_LAUNCHED, result: { key: 'p', action: 'held' } }],
  ])('the final reuse answering %s: no resume, and no mark set or held', async (_label, make, ended) => {
    const { h, p } = retiredBuild()
    finishedAtRun1(h, p, { claude_session_id: SESSION_ID })
    h.script({ spawnError: make() })
    const writes = h.retiredKeyWrites.length

    const outcome = await h.runSequence(p, { lastReadState: LIVE, retiredKey: true })

    expect(outcome).toMatchObject({ ...ended, launchKind: LIVE_ROW_LAUNCH_REUSE, ...('result' in ended ? { result: { ...ended.result, key: p } } : {}) })
    expectOneReuseOf(h, p)
    expect(h.stub.calls.resumeCalls).toEqual([])
    expect(markOf(h, p)).toEqual([false, false])
    expect(h.retiredKeyWrites.slice(writes)).toEqual([])
  })

  test.each(SEQUENCE_STOP_WAYS)('%s during the pending wait: the sequence ends stopped with no launch, and no mark', async (_label, stopP, reason) => {
    const { h, p } = retiredBuild()
    await clockAt(h, LAUNCH_START_MS)
    h.script({ getResult: personaRow(h, p, { state: PENDING }) })
    const run = h.startSequence(p, { lastReadState: PENDING, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET, retiredKey: true })
    for (let flushes = 0; flushes < 20 && h.clock.pendingCount() === 0; flushes++) await h.clock.flush()

    await stopP(h, p)

    expect(await run.outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason })
    expect([h.stub.calls.spawnCalls, h.stub.calls.resumeCalls]).toEqual([[], []])
    expect(markOf(h, p)).toEqual([false, false])
  })

  test('a row still live after every run that judged it: the sequence escalates with no launch and no mark, and raises one ordinary alert for cscb_<key> on P\'s configured destination, context recovery, built by the alert\'s builder', async () => {
    const { h, p } = retiredBuild()
    h.script({ getResult: personaRow(h, p), findMissingResult: placed(p, 'unverified_ids') })

    const outcome = await h.runSequence(p, { lastReadState: LIVE, retiredKey: true })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED })
    const content = ordinaryAlertContent(p)
    expect(content).toMatchObject({ instanceId: personaInstanceId(p) })
    expect(h.episodeNotices).toEqual([killFailureNotice(p, content, KILL_FAILURE_CLOSING_DESTINATION)])
    expect(killFailurePosts(h, p)).toEqual([killFailurePostedLine(p, content, KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CONTEXT_RECOVERY)])
    expect([h.stub.calls.spawnCalls, h.stub.calls.resumeCalls]).toEqual([[], []])
    expect(markOf(h, p)).toEqual([false, false])
  })
})

// ---------------------------------------------------------------------------
// The final launch ending in a launch timeout (b.jg5 SRJ-407, SRJ-705 step 6,
// SRJ-301): the sequence's reuse, or its `resume`, is followed by its one
// `get` and by no further launch, and the sequence ends as for any launch
// that did not succeed. What that `get` finds decides the rest: a covered
// `pending` row inside the call's window gets the approver; a `pending` row
// that is not covered (a cwd mismatch, a recorded key's old life outside the
// window) asks for the live-row sequence, which is the one still running, so
// the launch answers sequence-waiting, with no approver and no mark.
// ---------------------------------------------------------------------------

/** Both launch-timeout forms (b.jg5 SRJ-407), by the exported form names. */
const LAUNCH_TIMEOUT_FORMS = [LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT, LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE] as const

/** A final launch of the sequence: its kind, the stub call it makes, the verb timed, and how P's rows and request reach it. */
interface FinalLaunch {
  readonly launchKind: LiveRowSequenceLaunchKind
  readonly call: 'spawn' | 'resume'
  readonly timed: Pick<TimedLaunchOptions, 'verb' | 'reuse'>
  readonly request: RecoverySequenceRequest
  /** Step 2's and run 1's `get` read the row finished (with a session id for a `resume`). */
  setup(h: RecoveryHarness, key: string): void
}

const FINAL_LAUNCHES: ReadonlyArray<readonly [string, FinalLaunch]> = [
  ['reuse', { launchKind: LIVE_ROW_LAUNCH_REUSE, call: 'spawn', timed: { verb: 'spawn', reuse: true }, request: { lastReadState: LIVE }, setup: (h, key) => finishedAtRun1(h, key, {}) }],
  [
    'resume',
    {
      launchKind: LIVE_ROW_LAUNCH_RESUME,
      call: 'resume',
      timed: { verb: 'resume' },
      request: { lastReadState: LIVE, keepsConversation: true },
      setup: (h, key) => finishedAtRun1(h, key, { claude_session_id: SESSION_ID }),
    },
  ],
]

/** The calls of a sequence entered at step 1 up to its final launch, that launch, and the one `get` after its launch timeout. */
const finalLaunchCalls = (launch: FinalLaunch): string[] => ['kill', 'get', 'findMissing', 'get', launch.call, 'get']

/** P's step-6 launch calls: exactly one, the final launch's. */
function expectOneFinalLaunch(h: RecoveryHarness, launch: FinalLaunch): void {
  expect([h.stub.calls.spawnCalls.length, h.stub.calls.resumeCalls.length]).toEqual(launch.call === 'spawn' ? [1, 0] : [0, 1])
}

describe('the final launch ending in a launch timeout: one get, no further launch, and the sequence\'s end with P\'s timer armed (b.jg5 SRJ-407, SRJ-705 step 6, SRJ-301)', () => {
  test.each(FINAL_LAUNCHES.flatMap(([what, launch]) => LAUNCH_TIMEOUT_FORMS.map((form) => [what, form, launch] as const)))(
    'the final %s ending in a launch timeout (%s), its get reading this launch\'s row pending and covered: the launch answers retrying, the sequence ends launched with the other-end arm, and only the approver\'s calls follow the get',
    async (_what, form, launch) => {
      const { h, p, q } = build({ harnessNow: true })
      launch.setup(h, p)
      const t = scriptTimedLaunch(h, p, { ...launch.timed, end: form })
      // The row stays pending at the approver's lap; tmux answers its pane read with no dialog.
      h.script({ statusFn: () => t.statusRow() })
      const order = recordCallOrder(h)

      const outcome = await h.runSequence(p, launch.request)

      expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: launch.launchKind, result: { key: p, action: SPAWN_ACTION_RETRYING }, armed: LIVE_ROW_ARM_ENDED })
      expect(h.lines.filter((line) => line === liveRowSequenceEndLine(`persona=${p}`, outcome))).toHaveLength(1)
      expect(thisLaunchRowOf(p)).toEqual({ launchStartMs: Date.parse(t.launchStartedAt()!), window: launchCallWindowOf(p)! })
      expect(h.approverRunning(p)).toBe(true)
      expect(h.triggers).toEqual([UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, UNAVAILABLE_RETRY_CAUSE_PENDING_ROW, UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED].map((kind) => ({ key: p, kind })))
      expect([getFailureCount(p), h.notices]).toEqual([0, []])

      // The approver's one lap after the launch call returned (its cap comes before its next), then its stop.
      expect(await h.runApproverToStop(p)).toMatchObject({ reason: APPROVER_STOP_CAP })
      expect(order).toEqual([...finalLaunchCalls(launch), 'status', 'readPane'])
      expectOneFinalLaunch(h, launch)
      expectUntouched(h, q)
    },
  )

  // Build-lead ruling (hatch A3): the get after the final launch reads an
  // uncovered `pending` row, so the step asks the start entry for the
  // live-row sequence, which answers already-running (this one is), and the
  // launch answers sequence-waiting; the running sequence then ends without
  // its launch's success, with P's timer armed.
  test.each(FINAL_LAUNCHES.map(([what, launch], i) => [what, LAUNCH_TIMEOUT_FORMS[i % 2]!, launch] as const))(
    'the final %s ending in a launch timeout (%s), its get reading a pending row in another directory (not covered): the launch answers sequence-waiting, no approver runs and no call follows the get; the sequence ends with P\'s timer armed',
    async (_what, form, launch) => {
      const { h, p, q } = build({ harnessNow: true })
      launch.setup(h, p)
      scriptTimedLaunch(h, p, { ...launch.timed, end: form, row: { state: PENDING, cwd: h.home } })
      const order = recordCallOrder(h)

      const outcome = await h.runSequence(p, launch.request)

      expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: launch.launchKind, result: { key: p, action: 'sequence-waiting' }, armed: LIVE_ROW_ARM_ENDED })
      expect(h.errors.filter((line) => line.includes(launchUnavailableSequenceOutcome(PENDING_ROW_REASON_CWD_MISMATCH, LIVE_ROW_START_ALREADY_RUNNING, 'sequence-waiting')))).toHaveLength(1)
      expect(order).toEqual(finalLaunchCalls(launch))
      expect(h.approverRunning(p)).toBe(false)
      // The launch's own UNAVAILABLE cause, then the sequence's end: no pending-row arm for a row that is not covered.
      expectEndArmed(h, outcome, LIVE_ROW_ARM_ENDED, [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE])
      expectOneFinalLaunch(h, launch)
      expectUntouched(h, q)
    },
  )

  test.each(LAUNCH_TIMEOUT_FORMS.map((form) => [form] as const))(
    'a recorded key\'s final reuse ending in a launch timeout (%s), its get reading the old life pending with a launch start before the call\'s window: no approver and no mark; the launch answers sequence-waiting and no call follows the get',
    async (form) => {
      const { h, p, q } = build({ harnessNow: true })
      h.retireKey(p)
      finishedAtRun1(h, p, {})
      scriptTimedLaunch(h, p, { verb: 'spawn', reuse: true, end: form, launchStart: 'before' })
      const writes = h.retiredKeyWrites.length
      const order = recordCallOrder(h)

      const outcome = await h.runSequence(p, { lastReadState: LIVE, retiredKey: true })

      expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, reason: LIVE_ROW_LAUNCH_REASON_RETIRED_KEY, result: { key: p, action: 'sequence-waiting' } })
      expect(h.errors.filter((line) => line.includes(launchUnavailableSequenceOutcome(PENDING_ROW_REASON_RETIRED_OLD_LIFE, LIVE_ROW_START_ALREADY_RUNNING, 'sequence-waiting')))).toHaveLength(1)
      expect(order).toEqual(['kill', 'get', 'findMissing', 'get', 'spawn', 'get'])
      expectOneReuseOf(h, p)
      expect(thisLaunchRowOf(p)).toBeUndefined()
      expect(h.approverRunning(p)).toBe(false)
      expect(h.retiredEntry(p).marked).toBe(false)
      expect(readRetiredKeysRecord(h.stateDir)?.get(p)?.newLifeBegunAt ?? null).toBeNull()
      expect(h.retiredKeyWrites.slice(writes)).toEqual([])
      expectEndArmed(h, outcome, LIVE_ROW_ARM_ENDED, [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE])
      expectUntouched(h, q)
    },
  )
})

// ---------------------------------------------------------------------------
// The no-launch form as an old-life wait (b.jg5 SRJ-811, SRJ-1512, SRJ-1007;
// E27 T2): step 5's alert text for an old key's id and a pre-persona id, the
// attempt rule, and the no-launch-only stop and query. The wait's steps and
// results by class are tests/old-life-wait.test.ts's.
// ---------------------------------------------------------------------------

describe('the no-launch form as an old-life wait: step 5\'s ordinary text for an old key\'s id and a pre-persona row\'s id, with the log-only closing (b.jg5 SRJ-1007, SRJ-811)', () => {
  test.each<[string, (h: RecoveryHarness, p: string, q: string) => { readonly id: string; readonly oldKey: string; readonly session: string; readonly labels: Record<string, string> }]>([
    ['a renamed-away key\'s own cscb_<old> (Q, no longer applied)', (h, _p, q) => {
      h.remove(q)
      return { id: personaInstanceId(q), oldKey: q, session: personaTmuxSessionName(q), labels: { service: 'cscb', persona: q } }
    }],
    ['a pre-persona row\'s id (no persona label)', () => ({ id: PRE_PERSONA_ID, oldKey: PRE_PERSONA_ID, session: PRE_PERSONA_SESSION, labels: { ...PRE_PERSONA_LABELS } })],
  ])('%s: still live after runs that judged it, one persona-kill-failed entry and one log line, the context old-life wait, the id and the row\'s session in the text; nothing to Slack', async (_label, form) => {
    const { h, p, q } = build()
    const old = form(h, p, q)
    h.beginOldLifeHold({ instanceId: old.id, oldKey: old.oldKey, directory: h.home, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })
    h.script({ getResult: cannedGetResult({ claude_instance_id: old.id, cwd: h.home, tmux_session_name: old.session, labels: old.labels }) })

    expect(await h.runOldLifeWait(old.id)).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED })

    const text = killFailureAlertText({ version: KILL_FAILURE_VERSION_ORDINARY, session: old.session, instanceId: old.id, quotes: {} }, KILL_FAILURE_CLOSING_LOG_ONLY, false)
    expect(text).toContain(`--claude-instance-id ${old.id}`)
    expect(startupEntriesOf(h, PERSONA_KILL_FAILED_LABEL)).toEqual([killFailureAlertEntryText(oldLifeWaitRef(old.id, old.oldKey), KILL_FAILURE_CONTEXT_OLD_LIFE_WAIT, text)])
    expect(killFailureLines(h, old.oldKey)).toEqual([
      killFailureLoggedLine(old.oldKey, KILL_FAILURE_VERSION_ORDINARY, PERSONA_KILL_FAILED_LABEL, KILL_FAILURE_ROUTE_NOT_CONFIGURED),
    ])
    expect([h.episodeNotices, h.notices]).toEqual([[], []])
    // The waiting persona has none here (the hold is in the harness HOME): nothing is armed.
    expect(h.triggers).toEqual([])
  })
})

describe('the no-launch form\'s contract (b.jg5 SRJ-811, SRJ-1512): it runs outside every attempt, only the no-launch stop ends it, and the query tells it from a launch-ending sequence', () => {
  test.each<[string, boolean, boolean]>([
    ['a request that ends in a launch runs in its own recovery attempt for P', true, true],
    ['a no-launch request runs outside every attempt, so its UNAVAILABLE get arms nothing for P', false, false],
  ])('started from inside a recovery attempt for P: %s', async (_label, launches, inside) => {
    const { h, p } = build()
    const insideAtGet: boolean[] = []
    const get = h.stub.client.get.bind(h.stub.client)
    h.stub.client.get = (params) => {
      insideAtGet.push(isInsideAttempt(p))
      return get(params)
    }
    h.script({ getError: unavailableAt('get') })

    expect(await runInAttempt(p, 'recovery', async () => startLiveRowSequence(h.sequenceRequest(p, { lastReadState: LIVE, launches })))).toBe(LIVE_ROW_START_STARTED)
    const outcome = await h.driveSequence(h.sequenceSettled(p))

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_READ_REFUSED })
    expect(insideAtGet).toEqual([inside])
    expect(h.triggers).toEqual(launches ? [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED].map((kind) => ({ key: p, kind })) : [])
    expect([h.stub.calls.spawnCalls, h.stub.calls.resumeCalls]).toEqual([[], []])
  })

  test('a hold on cscb_<P> that ends while P\'s launch-ending sequence runs there (its first run held) stops no sequence: the no-launch query answers false, the running query true, and the sequence goes on to its launch', async () => {
    const { h, p } = build()
    const hold = holdFindMissing(h.stub.client)
    ownRowsLiveThenMissing(h)
    const run = await startSequenceHeldAtRun(h, p, hold)
    h.beginOldLifeHold({ instanceId: personaInstanceId(p), oldKey: p, directory: h.home, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })

    noteOldLifeRowRead(personaInstanceId(p), { kind: OLD_LIFE_ROW_READ_STATE, state: ENDED }, 'another call')

    expect([h.oldLifeWaitRunning(personaInstanceId(p)), h.sequenceRunning(p)]).toEqual([false, true])
    hold.release(placed(p, 'ids'))
    expect(await h.driveSequence(run.outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE })
    expectOneReuseOf(h, p)
    await h.runApproverToStop(p)
  })

  test('a no-launch request keyed P on cscb_<P> (its first run held): P\'s stop (a teardown) leaves it running, the no-launch query and the running query both answer true, and the end of a hold on its id stops it before its next call', async () => {
    const { h, p } = build()
    const hold = holdFindMissing(h.stub.client)
    h.script({ getResult: personaRow(h, p) })
    const order = recordCallOrder(h)
    const run = await startSequenceHeldAtRun(h, p, hold, { launches: false })
    h.beginOldLifeHold({ instanceId: personaInstanceId(p), oldKey: p, directory: h.home, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })

    expect(await run.stop(LIVE_ROW_STOP_TEARDOWN)).toBe(false)
    expect([h.oldLifeWaitRunning(personaInstanceId(p)), h.sequenceRunning(p)]).toEqual([true, true])

    noteOldLifeRowRead(personaInstanceId(p), { kind: OLD_LIFE_ROW_READ_STATE, state: ENDED }, 'another call')
    hold.release(cannedFindMissing())

    expect(await h.driveSequence(run.outcome)).toMatchObject({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_HOLD_ENDED })
    expect(order).toEqual(['kill', 'get', 'findMissing'])
    expect([h.oldLifeWaitRunning(personaInstanceId(p)), h.sequenceRunning(p), h.triggers]).toEqual([false, false, []])
  })
})
