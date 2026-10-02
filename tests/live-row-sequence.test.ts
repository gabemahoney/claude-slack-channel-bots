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
 * refusal split, E14 build), the kills (SRJ-110, SRJ-702, SRJ-703, SRJ-1007),
 * the `ad-config-malformed` rule (SRJ-316), the reads (SRJ-114, SRJ-513), a
 * failed `get` (hatch A2), the alert's episode (SRJ-704), the launch kind
 * (step 6, its pure decision and through the sequence), the launch's end
 * (which launch results are a success, the outcome and its end line after a
 * launch that succeeds, fails or throws), the entries and forms, the stop
 * signal (SRJ-706: an answer after the stop, a kill's, its latch's or a
 * dependency's throw, is dropped; a latched persona gets no call), the lines
 * that carry agent-director text, and the module's import boundary. This
 * file asserts that the sequence stops; the latches it causes
 * (each kill's CONFLICT and UNUSABLE NAME rows, SRJ-613's kill backstop among
 * them, with their records and posts) are in tests/conflict-latch.test.ts,
 * the `resume` leg's fallbacks and the sequence-launch entry in
 * tests/session-manager.test.ts, and the retry cause each end arms (with no
 * reuse builder installed among them) and step 4's `ad-config-malformed`
 * no-kill in tests/unavailable-retry.test.ts.
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
  LIVE_ROW_ARM_NOT_JUDGED,
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
  liveRowSequenceRunLine,
  runLiveRowSequence,
  type LiveRowLaunchKindInput,
  type LiveRowSequenceLaunchReason,
  type LiveRowSequenceArmCause,
  type LiveRowSequenceDeps,
  type LiveRowSequenceOutcome,
  type LiveRowSequenceRequest,
  type LiveRowSequenceStopHandle,
} from '../src/live-row-sequence.ts'
import { AGENT_DIRECTOR_PENDING_STATE, LIVENESS_DEAD_ROW_ENDED, LIVENESS_DEAD_ROW_MISSING } from '../src/liveness-reading.ts'
import { parseLaunchStart } from '../src/pending-row.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import { personaInstanceId } from '../src/persona-identity.ts'
import { KILL_FAILURE_END_ROW_FINISHED } from '../src/persona-episodes.ts'
import { MAX_TIMER_DELAY_MS } from '../src/persona-retry-schedule.ts'
import {
  ESCALATE_DEAD_WAITING_ROW_PANE_GONE,
  _resetNow,
  _setNow,
  sweepDeadTmuxChannel,
  type SpawnPersonaResult,
} from '../src/session-manager.ts'
import { runInAttempt, UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED } from '../src/unavailable-retry.ts'
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
  errGeneric,
  errInternal,
  errSpawnNotFound,
  errSystemInstallDisappeared,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSessionConflict,
  errTmuxUnresponsive,
  errUnknownErrorName,
  errUnusableName,
  KILL_FAILED_DESCRIPTIONS,
  provenanceNote,
  SAMPLE_LAUNCH_START_DEFAULT,
  SAMPLE_LAUNCH_START_FRACTIONAL,
  SAMPLE_LAUNCH_START_NONE,
  SAMPLE_LAUNCH_START_WHOLE,
  STUB_SURVIVOR_PIDS,
  unavailableForms,
  type FindMissingRowPlacement,
  type PersonaGetResultOverrides,
} from './test-helpers/agent-director-stub.ts'
import { UNPARSEABLE_LAUNCH_START } from './test-helpers/conflict-cases.ts'
import { assertNoLeak, isTokenLike, LEAK_SENTINEL, REDACTED_SENTINEL_TAIL, sentinelInMessage } from './test-helpers/credentials.ts'
import { forbiddenServerLoads } from './test-helpers/source-audit.ts'
import {
  callsBeforeSequenceKill,
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
  personaOf,
  recordCallOrder,
  runSequenceStoppedAtKill,
  scriptSequenceKillFailure,
  startupEntriesOf,
  survivorAlertContent,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
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

/** Persona `key`'s own row as a `get` reads it (its `cwd`, labels and id), with `overrides`. */
function rowOf(h: RecoveryHarness, key: string, overrides: PersonaGetResultOverrides = {}): Phase1GetResult {
  return cannedGetResult(overrides, personaOf(h, key), h.home)
}

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

/** The persona's kill-failure posts at its destination (`episodeNotices` holds every episode kind's posts). */
function killFailurePosts(h: RecoveryHarness, key: string): string[] {
  return killFailureLines(h, key).filter((line) => line.includes(' alert posted to its destination '))
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
    h.script({ getResult: rowOf(h, p), findMissingResult: placed(p, 'unverified_ids') })
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
    expect([h.stub.calls.resumeCalls, h.stub.calls.spawnCalls, h.reuses]).toEqual([[], [], []])
  })

  test('a live row other than pending that every run leaves in neither list is judged alive by each run and reaches the alert', async () => {
    const { h, p } = build()
    h.script({ getResult: rowOf(h, p) })

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_ESCALATED,
      runs: LIVE_ROW_SEQUENCE_MAX_RUNS,
      kills: LIVE_ROW_SEQUENCE_MAX_KILLS,
      judgedRuns: LIVE_ROW_SEQUENCE_MAX_RUNS,
      armed: LIVE_ROW_ARM_ENDED,
    })
    expect(h.episodeNotices).toEqual([killFailureNotice(p, ordinaryAlertContent(p))])
  })

  test('each run bypasses the memo: with a fresh result from an ordinary run inside the memo window, every sequence run still makes a new find-missing call', async () => {
    const { h, p } = build()
    _setNow(h.clock.now)
    h.script({ getResult: rowOf(h, p) })
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
  [ENDED, (h, key) => rowOf(h, key, { state: ENDED })],
  [MISSING, (h, key) => rowOf(h, key, { state: MISSING })],
  ['no row (ErrSpawnNotFound)', () => errSpawnNotFound()],
]

/** Each run whose `get` can read the row finished: 1 to 3 at step 3, then step 4's. */
const EXIT_RUNS = Array.from({ length: LIVE_ROW_SEQUENCE_MAX_RUNS }, (_, i) => i + 1)

describe('step exits: a get after a run reading the row finished goes to step 6 (SRJ-705 steps 3 and 4)', () => {
  test.each(EXIT_RUNS.flatMap((run) => FINISHED_READS.map(([label, read]) => [run, label, read] as const)))(
    'the get after run %d reads %s: no further run or kill, no alert, and the launch (a reuse of the same id)',
    async (run, _label, read) => {
      const { h, p } = build()
      // Step 2's get and each earlier run's read the row live; the run's own get reads it finished.
      gets(h, ...Array.from({ length: run }, () => rowOf(h, p)), read(h, p))
      const order = recordCallOrder(h)

      const outcome = await h.runSequence(p, { lastReadState: LIVE })

      const kills = run > LIVE_ROW_SEQUENCE_STEP3_RUNS ? LIVE_ROW_SEQUENCE_MAX_KILLS : 1
      expect(order).toEqual([
        'kill',
        'get',
        ...runAndGet(Math.min(run, LIVE_ROW_SEQUENCE_STEP3_RUNS)),
        ...(run > LIVE_ROW_SEQUENCE_STEP3_RUNS ? ['kill', ...runAndGet(1)] : []),
      ])
      expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, runs: run, kills, judgedRuns: run })
      expect(outcome.armed).toBeUndefined()
      expect(h.reuses).toEqual([expect.objectContaining({ key: p, instanceId: personaInstanceId(p) })])
      expect(h.episodeNotices).toEqual([])
    },
  )

  test.each(FINISHED_READS)('a step-2 get reading %s still leads to one run at once, then its get, then the launch', async (_label, read) => {
    const { h, p } = build()
    gets(h, read(h, p), read(h, p))
    const calls = recordCallTimes(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(calls).toEqual([['kill', 0], ['get', 0], ['findMissing', 0], ['get', 0]])
    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, runs: 1, kills: 1 })
    expect(h.reuses).toHaveLength(1)
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
    gets(h, rowOf(h, key, { state: PENDING, ...row }), rowOf(h, key, { state: MISSING }))
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
    const grace = adGraceMsInEffect()
    await clockAt(h, LAUNCH_START_MS + grace)
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
  /** P's `pending` row, its launch start G in the past: no wait at step 2. */
  async function pendingPastGrace(h: RecoveryHarness): Promise<void> {
    await clockAt(h, LAUNCH_START_MS + adGraceMsInEffect())
  }

  test.each([
    ['a step-3 run', 1, ['kill', 'get', 'findMissing']],
    ["step 4's run", LIVE_ROW_SEQUENCE_MAX_RUNS, ['kill', 'get', ...runAndGet(LIVE_ROW_SEQUENCE_STEP3_RUNS), 'kill', 'findMissing']],
  ] as const)('%s leaves the pending row in neither list: no further run or kill, no alert, nothing counted, no launch; P\'s timer armed with the not-judged cause', async (_label, run, calls) => {
    const { h, p } = build()
    await pendingPastGrace(h)
    h.script({ getResult: rowOf(h, p, { state: PENDING }) })
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
    expect(getFailureCount(p)).toBe(0)
    expect([h.reuses, h.stub.calls.resumeCalls, h.stub.calls.spawnCalls]).toEqual([[], [], []])
    expect(h.controller.isArmed(p)).toBe(true)
  })

  test('runs that put the pending row in unverified_ids while it stays live judged it: the sequence reaches the alert', async () => {
    const { h, p } = build()
    await pendingPastGrace(h)
    h.script({ getResult: rowOf(h, p, { state: PENDING }), findMissingResult: placed(p, 'unverified_ids') })

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
    await pendingPastGrace(h)
    h.script({ getResult: rowOf(h, p, { state: PENDING }), findMissingResult: placed(p, 'neither') })

    const outcome = await h.runSequence(p, { lastReadState: PENDING })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_NOT_JUDGED, runs: 1, kills: 1 })
    expect(h.stub.calls.killCalls).toHaveLength(1)
    expect([h.episodeNotices, killFailureLines(h, p)]).toEqual([[], []])
  })
})

// ---------------------------------------------------------------------------
// Failed runs (SRJ-120's refusal split, E14 build; HO rev 28 / apply21)
// ---------------------------------------------------------------------------

/** A `find-missing` failure of each class SRJ-120 refuses the run for. */
const REFUSED_RUNS: ReadonlyArray<readonly [string, () => Error]> = [
  [AD_ERROR_CLASS_UNAVAILABLE, () => unavailableForms('ErrCallTimeout')[0]![1]('find-missing')],
  [AD_ERROR_CLASS_ENVIRONMENT, () => errTmuxNotAvailable(undefined, 'find-missing')],
  [AD_ERROR_CLASS_CONFIG, () => errConfigMalformed()],
  [AD_ERROR_CLASS_UNCLASSIFIED, () => errSystemInstallDisappeared('find-missing')],
]

describe('failed runs: a refused run ends the sequence; any other failed run judges nothing and the step goes on (SRJ-120)', () => {
  test.each([1, LIVE_ROW_SEQUENCE_MAX_RUNS].flatMap((run) => REFUSED_RUNS.map(([label, make]) => [run, label, make] as const)))(
    'run %d refused (%s): the sequence ends at once with no further run, kill or launch and nothing counted; the other-end cause armed',
    async (run, _label, make) => {
      const { h, p } = build()
      h.script({ getResult: rowOf(h, p) })
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
      expect(getFailureCount(p)).toBe(0)
      expect([h.reuses, h.episodeNotices]).toEqual([[], []])
    },
  )

  test('every run failing otherwise (an UNUSABLE NAME answer): no run judged the row, so no alert and no launch; the timer armed', async () => {
    const { h, p } = build()
    h.script({ getResult: rowOf(h, p), findMissingError: errUnusableName() })

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_NO_JUDGED_RUN,
      runs: LIVE_ROW_SEQUENCE_MAX_RUNS,
      kills: LIVE_ROW_SEQUENCE_MAX_KILLS,
      judgedRuns: 0,
      armed: LIVE_ROW_ARM_ENDED,
    })
    expect([h.reuses, h.episodeNotices, killFailureLines(h, p)]).toEqual([[], [], []])
    expect(h.latch.isLatched(p)).toBe(false)
    expect(h.controller.isArmed(p)).toBe(true)
  })

  test('one such failed run among judged ones: the step goes on, and the row still live leads to the alert', async () => {
    const { h, p } = build()
    h.script({ getResult: rowOf(h, p) })
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
      h.script({ getResult: rowOf(h, p) })
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
      expect(h.reuses).toEqual([])
      expect(h.episodeNotices).toEqual([])
      expect(getFailureCount(p)).toBe(0)
    },
  )

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
      h.script({ getResult: rowOf(h, p) })
      scriptSequenceKillFailure(h, step, err)

      const outcome = await h.runSequence(p, { lastReadState: LIVE })

      expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_ABORTED, step, errorClass: AD_ERROR_CLASS_UNAVAILABLE, latched: false })
      expect(h.episodeNotices).toEqual([killFailureNotice(p, ordinaryAlertContent(p, { last: err() }))])
      expect(killFailurePosts(h, p)).toHaveLength(1)
    },
  )

  test.each([ENDED, MISSING])('a step-1 success with kill_sent false whose next get reads %s: no alert, and the launch (SRJ-703)', async (state) => {
    const { h, p } = build()
    h.script({ killResult: cannedKillResult(false), getResult: rowOf(h, p, { state }) })

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, kills: 1 })
    expect([h.episodeNotices, killFailureLines(h, p)]).toEqual([[], []])
    expect(h.reuses).toHaveLength(1)
  })

  test('ErrSpawnNotFound at a kill counts as a success: the sequence goes on to its get', async () => {
    const { h, p } = build()
    h.script({ killError: errSpawnNotFound(), getResult: rowOf(h, p, { state: ENDED }) })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(order).toEqual(['kill', 'get', 'findMissing', 'get'])
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
    h.script({ killQueue: [cannedErr(survivor), cannedOk(cannedKillResult(true))], getResult: rowOf(h, p, { state: ENDED }) })

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
  })

  test('a step-4 kill whose between-try status read answers CONFIG, on a row last read pending: its tries end with no further kill, the last try\'s outcome standing', async () => {
    const { h, p } = build()
    await clockAt(h, LAUNCH_START_MS + adGraceMsInEffect())
    h.script({
      getResult: rowOf(h, p, { state: PENDING }),
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
// Reads through the shared own-row read (SRJ-114, SRJ-513; the E14, E16 notes)
// ---------------------------------------------------------------------------

describe('the reads: a get that latches P stops the sequence with no further call (SRJ-114, SRJ-513)', () => {
  test.each([
    ['the step-2 get', 0, ['kill', 'get']],
    ['a confirming get', 1, ['kill', 'get', 'findMissing', 'get']],
  ] as const)('a provenance_conflict note at %s: stopped for the latch, no further call, nothing armed', async (_label, before, calls) => {
    const { h, p } = build()
    gets(h, ...Array.from({ length: before }, () => rowOf(h, p)), rowOf(h, p, { liveness_note: provenanceNote }))
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(order).toEqual([...calls])
    expect(outcome).toEqual({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED, runs: before, kills: 1, judgedRuns: before })
    expect(h.controller.isArmed(p)).toBe(false)
  })

  test('a configured persona\'s own pending row with no launch start at the step-2 get: stopped for the latch, with no wait and no run', async () => {
    const { h, p } = build()
    h.script({ getResult: rowOf(h, p, { state: PENDING, launch_started_at: SAMPLE_LAUNCH_START_NONE }) })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(order).toEqual(['kill', 'get'])
    expect(outcome).toEqual({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_LATCHED, runs: 0, kills: 1, judgedRuns: 0 })
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
  // ErrSpawnNotFound reads as no row: the step exits above.
  test.each(GET_SITES)('%s answering UNAVAILABLE: no further run, kill or launch, nothing counted; P\'s retry timer armed', async (_label, before, step) => {
    const { h, p } = build()
    gets(h, ...Array.from({ length: before }, () => rowOf(h, p)), unavailableForms('ErrCallTimeout')[0]![1]('get'))

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
    expect([h.reuses, h.stub.calls.resumeCalls]).toEqual([[], []])
    expect(getFailureCount(p)).toBe(0)
    expect(h.controller.isArmed(p)).toBe(true)
  })

  test.each(GET_SITES)('%s answering UNUSABLE NAME: P latched, which stops the sequence; no timer armed', async (_label, before, step) => {
    const { h, p } = build()
    gets(h, ...Array.from({ length: before }, () => rowOf(h, p)), errUnusableName())

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
    h.script({ getResult: rowOf(h, p) })
    expect(await h.runSequence(p, { lastReadState: LIVE })).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED })
    h.script({ killResult: cannedKillResult(true) })
    expect(await h.runSequence(p, { lastReadState: LIVE })).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED, kills: LIVE_ROW_SEQUENCE_MAX_KILLS })
    expect(h.episodeNotices).toEqual([killFailureNotice(p, content)])

    h.script({ getResult: rowOf(h, p, { state: ENDED }) })
    expect(await h.runSequence(p, { lastReadState: LIVE })).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED })
    h.script({ getResult: rowOf(h, p) })
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
    h.script({ getResult: rowOf(h, p) })
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
    h.script({ getResult: rowOf(h, p) })

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
  h.script(read instanceof Error ? { getError: read } : { getResult: rowOf(h, key, { state: ENDED, ...read }) })
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
    expect([h.reuses, h.stub.calls.spawnCalls]).toEqual([[], []])
    await h.runApproverToStop(p)
  })

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
        const { config_dir: _dropped, ...labels } = rowOf(h, key).labels
        return { claude_session_id: SESSION_ID, labels }
      },
      false,
    ],
    [
      'a config_dir label that differs',
      LIVE_ROW_LAUNCH_REASON_CONFIG_DIR_MISMATCH,
      {},
      (h, key) => ({ claude_session_id: SESSION_ID, labels: { ...rowOf(h, key).labels, config_dir: h.stateDir } }),
      false,
    ],
    ['a retired key', LIVE_ROW_LAUNCH_REASON_RETIRED_KEY, {}, () => ({ claude_session_id: SESSION_ID }), true],
  ])('%s: one reuse of the same id through the reuse builder, and no resume', async (_label, reason, options, overrides, retiredKey) => {
    const { h, p } = build(options)
    finishedAtRun1(h, p, overrides(h, p))

    const outcome = await h.runSequence(p, { lastReadState: LIVE, keepsConversation: true, retiredKey })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, launchKind: LIVE_ROW_LAUNCH_REUSE, reason, result: { key: p } })
    expect(h.reuses).toEqual([expect.objectContaining({ key: p, instanceId: personaInstanceId(p), resumeError: undefined })])
    expect([h.stub.calls.resumeCalls, h.stub.calls.spawnCalls]).toEqual([[], []])
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
}

describe('the launch\'s end: the outcome carries the launch\'s result, and the end line says whether it launched (SRJ-705 step 6, SRJ-301)', () => {
  test.each(Object.entries(LAUNCH_ACTION_SUCCEEDS))('a launch result %s is a success: %p', (action, succeeds) => {
    expect(liveRowLaunchSucceeded({ key: 'p', action })).toBe(succeeds)
  })

  test.each<[string, Omit<SpawnPersonaResult, 'key'>, LiveRowSequenceArmCause | undefined, string]>([
    ['succeeds', { action: 'spawned' }, undefined, 'launched (reuse; result=spawned)'],
    ['fails', { action: 'failed' }, LIVE_ROW_ARM_ENDED, 'the launch failed (reuse; result=failed)'],
    ['fails, refused', { action: 'failed', refused: true }, LIVE_ROW_ARM_ENDED, 'the launch failed (reuse; result=failed, refused)'],
    ['fails, stopping', { action: 'failed', stopping: true }, undefined, 'the launch failed (reuse; result=failed, stopping)'],
  ])('a reuse that %s: the outcome is launched with its result and the arm, and its one end line says so', async (_label, answer, armed, said) => {
    const { h, p } = build()
    h.script({ getResult: rowOf(h, p, { state: ENDED }) })
    const result: SpawnPersonaResult = { key: p, ...answer }
    h.answerReuse(() => ({ result }))

    const outcome = await h.runSequence(p, { lastReadState: LIVE })

    expect(outcome).toEqual({
      kind: LIVE_ROW_OUTCOME_LAUNCHED,
      launchKind: LIVE_ROW_LAUNCH_REUSE,
      reason: LIVE_ROW_LAUNCH_REASON_NOT_KEPT,
      result,
      runs: 1,
      kills: 1,
      judgedRuns: 1,
      ...(armed === undefined ? {} : { armed }),
    })
    const endLine = liveRowSequenceEndLine(`persona=${p}`, outcome)
    expect(endLine).toContain(`: ${said} — runs=1 kills=1 judged=1; ${armed === undefined ? 'no retry timer armed' : `the retry timer armed (${armed})`} `)
    expect(h.lines.filter((line) => line === endLine)).toHaveLength(1)
  })

  test.each([
    ['before any stop: the sequence ends internal-error with P\'s timer armed', false],
    ['after a stop for teardown: the failure is dropped too, and the sequence ends stopped with nothing armed', true],
  ] as const)('a launch dependency that throws %s; its failure is logged redacted before the end line', async (_label, stopped) => {
    const { h, p } = build()
    h.script({ getResult: rowOf(h, p, { state: ENDED }) })
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
    expect(h.reuses).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Entries and forms
// ---------------------------------------------------------------------------

describe('entries and forms: the step-2 entry and the no-launch form', () => {
  test('entered at step 2: no kill before its get, and one kill at most (step 4\'s)', async () => {
    const { h, p } = build()
    h.script({ getResult: rowOf(h, p) })
    const order = recordCallOrder(h)

    const outcome = await h.runSequence(p, { lastReadState: LIVE, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET, alertContext: KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT })

    expect(order).toEqual(['get', ...runAndGet(LIVE_ROW_SEQUENCE_STEP3_RUNS), 'kill', ...runAndGet(1)])
    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_ESCALATED, kills: 1, runs: LIVE_ROW_SEQUENCE_MAX_RUNS })
  })

  test('the no-launch form makes no launch call and ends as "row finished", arming nothing', async () => {
    const { h, p } = build()
    h.script({ getResult: rowOf(h, p, { state: ENDED }) })

    const outcome = await h.runSequence(p, { lastReadState: LIVE, launches: false })

    expect(outcome).toEqual({ kind: LIVE_ROW_OUTCOME_ROW_FINISHED, runs: 1, kills: 1, judgedRuns: 1 })
    expect([h.reuses, h.stub.calls.resumeCalls, h.stub.calls.spawnCalls, h.triggers]).toEqual([[], [], [], []])
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

describe('the stop signal: a result that arrives after the sequence was stopped is dropped, with no further call', () => {
  test('a stop set while a run is in progress: the run\'s answer is dropped, and no get, kill or launch follows', async () => {
    const { h, p } = build()
    h.script({ getResult: rowOf(h, p, { state: ENDED }) })
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const findMissing = h.stub.client.findMissing.bind(h.stub.client)
    h.stub.client.findMissing = async (params) => {
      await released
      return findMissing(params)
    }
    const order = recordCallOrder(h)
    const run = h.startSequence(p, { lastReadState: LIVE })
    for (let flushes = 0; flushes < 20 && !order.includes('findMissing'); flushes++) await h.clock.flush()
    expect(order).toEqual(['kill', 'get', 'findMissing'])

    run.stop.stop(LIVE_ROW_STOP_TEARDOWN)
    release()

    expect(await run.outcome).toEqual({ kind: LIVE_ROW_OUTCOME_STOPPED, reason: LIVE_ROW_STOP_TEARDOWN, runs: 1, kills: 1, judgedRuns: 0 })
    expect(order).toEqual(['kill', 'get', 'findMissing'])
    expect(h.reuses).toEqual([])
  })

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
