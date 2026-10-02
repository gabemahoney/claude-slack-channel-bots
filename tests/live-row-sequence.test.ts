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
 * never early, at a G beyond the timer maximum too; no wait without a launch
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
 * Every spacing, limit, outcome, cause, context, state and class is
 * imported from `src/` or the stub builders, and every expected alert text
 * is built with `src/kill-failure-alert.ts`'s builders (through the
 * harness's helpers). `afterEach` checks that no call was a `delete` or set
 * `include_finished`, runs `assertNoLeak` over the harness's `captured()`
 * and cleans it up, which fails while any timer is still pending.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'

import type { FindMissingResult } from 'agent-director'

import {
  AD_SETTING_MINIMUMS,
  DEFAULT_AD_SETTINGS,
  adGraceMsInEffect,
  pendingGraceMinimumSeconds,
} from '../src/ad-settings.ts'
import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  describeAgentDirectorFailure,
} from '../src/ad-error-class.ts'
import type { Phase1GetResult } from '../src/ad-phase1-types.ts'
import { getFailureCount } from '../src/backoff.ts'
import { killOutcomeOf, type KillFailureClass } from '../src/checked-kill.ts'
import {
  KILL_FAILURE_CLOSING_DESTINATION,
  KILL_FAILURE_CLOSING_DESTINATION_LATCHED,
  KILL_FAILURE_CONTEXT_RECOVERY,
  KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT,
  KILL_FAILURE_ROUTE_NOT_CONFIGURED,
  KILL_FAILURE_VERSION_ORDINARY,
  PERSONA_KILL_FAILED_LABEL,
} from '../src/kill-failure-alert.ts'
import { KILL_RETRY_ALERT_NONE, KILL_RETRY_END_SETTLED, KILL_RETRY_SPACING_MS, KILL_RETRY_TRIES } from '../src/kill-retry.ts'
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
  LIVE_ROW_LAUNCH_REASON_RETIRED_KEY,
  LIVE_ROW_LAUNCH_RESUME,
  LIVE_ROW_LAUNCH_REUSE,
  LIVE_ROW_NOT_LAUNCHED_NOT_APPLIED,
  LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE,
  LIVE_ROW_NOT_LAUNCHED_NOT_RESUMABLE_PENDING,
  LIVE_ROW_NOT_LAUNCHED_REUSE_COLLISION,
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
  LIVE_ROW_SEQUENCE_LOG_PREFIX,
  LIVE_ROW_SEQUENCE_MAX_KILLS,
  LIVE_ROW_SEQUENCE_MAX_RUNS,
  LIVE_ROW_SEQUENCE_RUN_SPACING_MS,
  LIVE_ROW_SEQUENCE_STEP3_RUNS,
  LIVE_ROW_SEQUENCE_STEP4_PAUSE_MS,
  LIVE_ROW_START_ALREADY_RUNNING,
  LIVE_ROW_START_CLOSED,
  LIVE_ROW_START_STARTED,
  LIVE_ROW_STOP_LATCHED,
  LIVE_ROW_STOP_SHUTDOWN,
  LIVE_ROW_STOP_TEARDOWN,
  createLiveRowSequenceStop,
  decideLiveRowLaunchKind,
  liveRowLaunchSucceeded,
  liveRowSequenceDroppedLine,
  liveRowSequenceEndLine,
  liveRowSequenceFailedLine,
  liveRowSequenceGetLine,
  liveRowSequenceKillLine,
  liveRowSequenceNotStartedLine,
  liveRowSequenceRunLine,
  liveRowSequenceStartLine,
  liveRowSequenceStopAskedLine,
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
} from '../src/live-row-sequence.ts'
import { AGENT_DIRECTOR_PENDING_STATE, LIVENESS_DEAD_ROW_ENDED, LIVENESS_DEAD_ROW_MISSING } from '../src/liveness-reading.ts'
import { parseLaunchStart } from '../src/pending-row.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { KILL_FAILURE_END_ROW_FINISHED } from '../src/persona-episodes.ts'
import { MAX_TIMER_DELAY_MS } from '../src/persona-retry-schedule.ts'
import {
  ESCALATE_DEAD_WAITING_ROW_PANE_GONE,
  _resetFindMissingMemo,
  _resetNow,
  _setNow,
  isLaunchInFlight,
  launchSession,
  readPersonaRowState,
  ROW_REREAD_FINISHED,
  ROW_REREAD_LATCHED,
  ROW_REREAD_LIVE,
  ROW_REREAD_PENDING,
  ROW_REREAD_REFUSED,
  SEQUENCE_NOT_RESUMABLE_LATCHED_OUTCOME,
  SEQUENCE_NOT_RESUMABLE_LOST_RACE_OUTCOME,
  SEQUENCE_NOT_RESUMABLE_PENDING_OUTCOME,
  spawnNotResumableLine,
  startLiveRowSequence,
  sweepDeadTmuxChannel,
  type PersonaRowReread,
  type SpawnPersonaResult,
} from '../src/session-manager.ts'
import {
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
  startSequenceHeldAtRun,
  startupEntriesOf,
  survivorAlertContent,
  unavailableAt,
  unclassifiedStartedLines,
  expectUntouched,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
  type RecoverySequenceRequest,
} from './test-helpers/recovery-harness.ts'

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
function runWithDeps(h: RecoveryHarness, key: string, stop: LiveRowSequenceStopHandle, replaced: Partial<LiveRowSequenceDeps>): Promise<LiveRowSequenceOutcome> {
  const request: LiveRowSequenceRequest = {
    key,
    instanceId: personaInstanceId(key),
    lastReadState: LIVE,
    entryStep: LIVE_ROW_SEQUENCE_ENTRY_KILL,
    keepsConversation: false,
    retiredKey: false,
    launches: true,
    alertContext: KILL_FAILURE_CONTEXT_RECOVERY,
  }
  return h.driveSequence(runInAttempt(key, 'recovery', () => runLiveRowSequence(request, { ...h.sequenceDeps, ...replaced }, stop)))
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
    // No reuse after the resume succeeded, and no sequence cause, or any other, armed (SRJ-301).
    expect(h.stub.calls.spawnCalls).toEqual([])
    expect(outcome.armed).toBeUndefined()
    expect([h.triggers, h.controller.armedKeys(), h.notices]).toEqual([[], [], []])
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
  resumed: true,
  reconnected: true,
  'not-reconnected': true,
  'no-op': true,
  'fresh-after-amnesia': true,
  'fresh-after-inconclusive-amnesia': true,
  failed: false,
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
  /** The end line's words for the launch, and for the arm. */
  readonly said: string
  readonly armedSaid: string
}

const REUSE_FAILED = 'the launch failed (reuse; result=failed)'
const REUSE_REFUSED = 'the launch failed (reuse; result=failed, refused)'
const ENDED_ARMED = `the retry timer armed (${LIVE_ROW_ARM_ENDED})`
const PENDING_ONLY_ARMED = 'the retry timer armed by the launch (pending-only)'
const REFUSED_ANSWER = { action: 'failed', refused: true } as const

/** A reuse refused by `cause`'s class: the refusal's own cause, then the sequence's. */
const refusedBy = (make: () => Error, cause: string, unclassified?: true): ReuseEnd => ({
  make,
  answer: REFUSED_ANSWER,
  armed: LIVE_ROW_ARM_ENDED,
  triggers: [cause, UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED],
  counted: 0,
  ...(unclassified === undefined ? {} : { unclassified }),
  said: REUSE_REFUSED,
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
  ['succeeds', { make: () => undefined, answer: { action: 'spawned' }, triggers: [], counted: 0, said: 'launched (reuse; result=spawned)', armedSaid: 'no retry timer armed' }],
  // SRJ-112, SRJ-602: a directory error is one counted launch failure, with no notice.
  [
    'fails with a directory error (ErrCwdNotFound), counted once',
    { make: () => errCwdNotFound(), answer: { action: 'failed', countedClass: true }, armed: LIVE_ROW_ARM_ENDED, triggers: [UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED], counted: 1, said: REUSE_FAILED, armedSaid: ENDED_ARMED },
  ],
  ['fails with UNAVAILABLE (ErrTmuxUnresponsive), refused', refusedBy(() => errTmuxUnresponsive('spawn'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)],
  ['fails with ENVIRONMENT (ErrTmuxNotAvailable), refused', refusedBy(() => errTmuxNotAvailable(), UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT)],
  ['fails with CONFIG (ErrConfigMalformed), refused', refusedBy(() => errConfigMalformed(), UNAVAILABLE_RETRY_CAUSE_CONFIG)],
  ['fails with UNCLASSIFIED (ErrInternal), refused', refusedBy(() => errInternal(), UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, true)],
  ['fails with ErrTmuxSessionCreate, armed pending-only', launchFailure()],
  ['of an id with no row (step 3\'s get read none) fails with ErrTmuxSessionCreate, armed pending-only', launchFailure(true)],
  [
    'fails with ErrInvalidFlags whose re-check stops the server',
    { make: () => errInvalidFlags('spawn'), answer: { action: 'failed', stopping: true }, triggers: [], counted: 0, said: 'the launch failed (reuse; result=failed, stopping)', armedSaid: 'no retry timer armed' },
  ],
]

describe('the launch\'s end: the outcome carries the launch\'s result, and the end line says whether it launched (SRJ-705 step 6, SRJ-301, SRJ-112)', () => {
  test.each(Object.entries(LAUNCH_ACTION_SUCCEEDS))('a launch result %s is a success: %p', (action, succeeds) => {
    expect(liveRowLaunchSucceeded({ key: 'p', action })).toBe(succeeds)
  })

  // The reuse's answer to each outcome class (b.jg5 SRJ-112) as the sequence
  // ends with it, and what it arms and counts through the retry controller
  // (SRJ-301); every class row at the entry is
  // tests/session-manager.test.ts's.
  test.each(REUSE_ENDS)('a reuse that %s: the outcome is launched with its result and the arm, its one end line says so, the reuse is the last call, and P\'s triggers, count and notice are its class\'s; Q is untouched', async (_label, row) => {
    const { h, p, q } = build()
    const stops = row.answer.stopping === true ? h.recheckAnswers(OLD_AD_VERSION).stops : []
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
    // One reuse, the last call: never a kill, delete, resume or second launch after it.
    const calls = ['kill', 'get', 'findMissing', 'get', 'spawn']
    if (row.answer.action === 'spawned') expectCallsThenApprover(order, calls)
    else expect(order).toEqual(calls)
    expectOneReuseOf(h, p)
    expect(stops).toHaveLength(row.answer.stopping === true ? 1 : 0)
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
    if (row.answer.stopping === true) expect(h.clock.pendingCount()).toBe(0)
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
// Started at the collision ladder's ErrSpawnNotResumable with dead evidence
// (b.jg5 SRJ-710, SRJ-611, SRJ-705, SRJ-706; E23)
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
// Step 6's own `resume` follows SRJ-113's table at the entry (its rows are
// tests/session-manager.test.ts's, its latches' records
// tests/conflict-latch.test.ts's): here what the sequence does with each
// answer: a CONFLICT ends it latched with no further call; ErrSpawnNotFound
// launches by one plain spawn; ErrSpawnNotResumable makes one re-read, starts
// no second sequence and ends the sequence without its launch, arming the
// not-resumable end's cause (nothing when the re-read latches P).
// ---------------------------------------------------------------------------

describe('started at the ladder\'s ErrSpawnNotResumable with dead evidence: the launch answers while the sequence runs, the conversation is kept, and step 6\'s resume answers end it by SRJ-113 and SRJ-710 (E23)', () => {
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

  test('a not-judged stop arms P\'s timer; its next retry, through the restart path\'s escalate-dead relaunch, reaches the not-resumable site again and begins a new sequence episode, which ends in resume', async () => {
    const { h, p } = build()
    await pastSampleGrace(h)
    const calls = h.stub.calls
    // Episode 1: the sequence reads P's own pending row (past its wait), and its run leaves it in neither list.
    scriptGoneNotResumable(h, p, personaRow(h, p, { state: PENDING }))
    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'sequence-waiting' })
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_NOT_JUDGED })
    expect(h.controller.view(p)?.causes).toEqual([UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED])

    // Episode 2: the retry's run reads the row waiting until its escalate-dead
    // sweep (the reconnect's GONE: verdict dead-session) and ended after it;
    // its checked kill, then its relaunch: the collision get reads ended, the
    // resume answers ErrSpawnNotResumable, the re-read finds the row waiting.
    const sweptAfter = calls.findMissingCalls.length
    h.script({
      statusFn: () => cannedStatusResult({ state: calls.findMissingCalls.length > sweptAfter ? ENDED : LIVE }),
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getQueue: [cannedOk(personaRow(h, p, { state: ENDED })), cannedOk(personaRow(h, p))],
      getResult: personaRow(h, p, { state: ENDED, claude_session_id: SESSION_ID }),
      resumeQueue: [cannedErr(errSpawnNotResumable())],
    })
    // The escalate-dead sweep is a new run, not the memo's answer from episode 1.
    _resetFindMissingMemo()
    await retryNow(h, p)
    expect(await h.driveSequence(h.sequenceSettled(p))).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_RESUME, result: { key: p, action: 'resumed' } })

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

  test('step 6\'s resume answering ErrSpawnNotFound: one plain spawn of the id (no reuse flag) and the sequence launches; no spawn-failure notice, nothing counted, nothing armed', async () => {
    const { h, p } = build()

    const { outcome, order } = await runToStep6Resume(h, p, errSpawnNotFound())

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_RESUME, result: { key: p, action: 'spawned' } })
    expect(outcome.armed).toBeUndefined()
    expectCallsThenApprover(order, [...SEQUENCE_CALLS, 'spawn'])
    expect(h.stub.calls.spawnCalls.map((call) => [call.claude_instance_id, call.reuse_finished])).toEqual([[personaInstanceId(p), undefined]])
    expect([h.notices, h.triggers, getFailureCount(p)]).toEqual([[], [], 0])
    await h.runApproverToStop(p)
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
