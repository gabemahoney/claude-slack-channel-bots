/**
 * tmux-unresponsive.test.ts — The per-persona `tmux-unresponsive` condition
 * and its three notices (b.jg5 SRJ-307 to SRJ-310, SRJ-1006; AC 25, AC 26,
 * AC 27, AC 80, AC 64's no-post half).
 *
 * Every case runs on `makeRecoveryHarness` (both settings 0 unless a case
 * turns the health check on), with the condition installed in the outage
 * state as `main()` installs it and its errors built by E4's by-name stub
 * builders. Launches go through the real
 * `spawnForPersona` over the stub; the direct cases call the outage state's
 * wrapper (`withOutageDetection`) with the call the site declares, inside an
 * attempt (`runInAttempt`) where the case needs one.
 *
 * - What starts it: each UNAVAILABLE form but `ErrTmuxKillFailed` at one of
 *   the tmux-touching calls the launch ladder makes, every such call met by
 *   at least one form, inside the launch; at the step-1 kill of the live-row
 *   sequence a launch starts at a replacement site over a row read live
 *   (b.jg5 SRJ-707; the ladder makes no kill), once its tries' refusal
 *   stands, inside the sequence's recovery attempt; each such form at the restart
 *   run's one `read-pane` of a live `working`, `waiting` or
 *   `check_permission` row (b.jg5 SRJ-603, SRJ-604, SRJ-606), inside its
 *   recovery attempt, and at the one-line `read-pane` of the `ask_user` row
 *   a launch meets (b.jg5 SRJ-607), inside the launch, with nothing counted;
 *   each UNAVAILABLE answer of the reuse spawn (unresponsive, still stopping,
 *   still starting) at the live-row sequence's final launch, inside the
 *   sequence's recovery attempt, counting nothing and posting nothing before
 *   the next health tick (b.jg5 SRJ-105, SRJ-112, SRJ-707);
 *   and a wrapped `read-pane` inside a recovery attempt; nothing else (the
 *   kill-failure cause, read and sweep
 *   errors inside an attempt, kills not of a row read live, calls outside
 *   every attempt, the dialog approver's `status`, `read-pane` and
 *   `send-keys` among them: it runs after its launch call returned).
 * - Held apart from the outages: no flag raised or cleared, no onset or
 *   all-clear, and an outage's own all-clear neither held back nor joined.
 * - What ends it: a tmux-touching success or GONE, in any context (a later
 *   launch's spawn and the live-row sequence's final reuse spawn among them,
 *   each with the pending reading; a later
 *   restart run's `read-pane` of a live `working`, `waiting` or
 *   `check_permission` row answering a pane or GONE among them, with the
 *   recovery post only after an onset),
 *   and the tick's end; a read's success does not. Ends are idempotent, and
 *   each end of a holding condition reaches the retry timer's condition-end
 *   entry once.
 * - Isolation: the other persona's condition, ends and notices are untouched.
 * - A lost message (SRJ-1011), through the harness's lost-message driver (the
 *   real routing bound as `main()` binds it): while P's condition holds it
 *   reports `not-answering` with no restart and no call, B's reports its own
 *   state, and after a tmux-touching success ends the condition it does not;
 *   after `ErrTmuxKillFailed`, which starts no condition, it never does. The
 *   states are identified by `stateOf` and the wording is the exported
 *   `STATE_WORDING`.
 *
 * The cases above reach no onset (no health tick, no retry past the floor, no
 * alert threshold), so each asserts that nothing is posted yet. The notice
 * cases:
 *
 * - SRJ-1006's texts: one pin case holds the file's only literals (the three
 *   texts for a sample session name, the 120 s floor, "over 6 minutes" at
 *   agent-director's defaults and "over 3 minutes" at AC 80's settings);
 *   every other case builds its texts with the exported builders and its
 *   times from the exported floor and E6's threshold accessor. The log
 *   lines have no exported builder, so the recovery harness's line builders
 *   (`conditionOnsetLine`, `conditionAlertLine`, `conditionEndedLine`,
 *   `conditionRecoveryLine`, `conditionSilentEndLine`) and this file's
 *   (`onsetHeldLine`, `alertCancelledLine`, `alertRearmedLine`,
 *   `onsetStoppedLine`, and the health tick's `tickArmingLine`) hold their
 *   fixed words; their seconds come from the clock and the threshold in effect, and the notice cases assert every notice and
 *   ended line exactly, in order.
 * - The onset (SRJ-308): with the health check on, at the end of the first
 *   health tick that started after the first refusal while the condition
 *   still holds; with it off, at the first retry at least the floor after
 *   the first refusal, a retry skipped for a launch in flight, a running
 *   live-row sequence (b.jg5 SRJ-706) or an old-life wait step for a hold
 *   the persona waits on (b.jg5 SRJ-811, E27 T2) included; once
 *   per episode, and never for `ErrTmuxKillFailed`.
 * - The alert (SRJ-309): once the condition has lasted strictly longer than
 *   the threshold in effect, once per episode, with no onset needed; retries
 *   go on and nothing is counted. Once it has posted, no onset follows in
 *   the episode, at a tick or at a retry (one `onset not posted` line).
 * - The alert and the retry timer (SRJ-309): every real stop of P's timer
 *   while the condition holds (the restart cap, not up, not applied, a
 *   teardown) cancels a pending alert check with one line naming the stop;
 *   an alert already posted stays. A later refusal in the episode arms the
 *   check again from the first refusal (one line), unless the stop was
 *   terminal (`UNAVAILABLE_RETRY_TERMINAL_STOPS`); a teardown after a not-up
 *   stop that already cancelled the check withdraws that re-arm.
 * - The onset and the retry timer (SRJ-305, SRJ-308; AC 28): while a stop
 *   of P's timer (the restart cap, not up) holds, no tick and no retry past
 *   the floor posts the onset (one `onset not posted` line per episode); a
 *   later refusal lets the next one post it. An arm that is not a refusal
 *   (the health tick's `armMissingRetryTimer`, an ENVIRONMENT trigger)
 *   allows nothing. After a removal, a teardown or the shutdown it never
 *   posts, and a later non-terminal stop does not weaken that; the mark ends
 *   with its episode.
 * - The recovery (SRJ-310): one at the end, after an onset or an alert;
 *   none at a silent end or an end with neither. A new episode posts all
 *   three again; a teardown and the shutdown post nothing more.
 * - A CONFLICT's silent end (SRJ-310, SRJ-502), through the latch composed as
 *   `main()` composes it: a retry's launch answering CONFLICT, after the onset
 *   or before any, stops the retry timer (cancelling the alert check) and
 *   ends the condition with no recovery before the one CONFLICT post, which
 *   is compared through `conflictNoticeForPersona` (`expectedConflictNotice`'s
 *   text); nothing posts past the threshold.
 *
 * Tick-mode cases drive the tick's two hooks as `main()` binds them
 * (`tickEnd` for a persona the tick finds healthy, then `tickOnset` with the
 * tick's start). Every notice case asserts the whole list of posts: only
 * these texts, and no outage onset or all-clear (`ONSET_TEMPLATES`,
 * `ALL_CLEAR_TEMPLATE`).
 *
 * No retry timer is real: the clock is the harness's fake clock, and the
 * only real-time waits are the spawn path's bounded 1 ms polls and the
 * working-row wait's `WAIT_POLL_MS` sleep after a failed poll. The
 * `armMissingRetryTimer` case runs one health tick body through the health
 * check's tick seam (`healthTick`), with no interval; the tick's start is
 * read from the fake clock.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'

import {
  AD_CALL_KILL_ROW_NOT_READ_LIVE,
  AD_CALL_KILL_ROW_READ_LIVE,
  type AdCall,
} from '../src/ad-error-class.ts'
import { adAlertThresholdMs, adAlertThresholdMsInEffect, DEFAULT_AD_SETTINGS_IN_EFFECT } from '../src/ad-settings.ts'
import { ErrCwdNotFound } from '../src/agent-director-errors.ts'
import { doublingBackoffDelay, getFailureCount, isAtCap, recordFailure } from '../src/backoff.ts'
import type { Persona } from '../src/config.ts'
import { _resetHealthCheckState, _runHealthCheckTickForTest, initHealthCheck, type HealthCheckDeps } from '../src/health-check.ts'
import { LIVENESS_DEAD_ROW_ENDED, LIVENESS_LIVE, LIVENESS_READING_DEAD, LIVENESS_READING_LIVE, LIVENESS_READING_UNKNOWN } from '../src/liveness-reading.ts'
import {
  ALL_CLEAR_TEMPLATE,
  getOutageFlags,
  ONSET_TEMPLATES,
  withOutageDetection,
  type OutageClass,
} from '../src/outage-state.ts'
import {
  PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE,
  TMUX_UNRESPONSIVE_END_LATCHED,
  TMUX_UNRESPONSIVE_END_TEXT,
  TMUX_UNRESPONSIVE_END_TICK,
  TMUX_UNRESPONSIVE_END_TMUX_VERB,
  TMUX_UNRESPONSIVE_ONSET_FLOOR_MS,
  tmuxUnresponsiveAlertText,
  tmuxUnresponsiveOnsetText,
  tmuxUnresponsiveRecoveryText,
  type TmuxUnresponsiveEndReason,
} from '../src/persona-episodes.ts'
import { personaInstanceId } from '../src/persona-identity.ts'
import { RESTART_FAILURE_CAP } from '../src/restart.ts'
import { _buildIsSessionAliveAdapter } from '../src/server.ts'
import { KILL_CONTEXT_TEARDOWN, killPersonaInstance, personaRetryBlockCause, reconcileOrphans, SPAWN_ACTION_RETRYING, TRUST_DIALOG_NEEDLE, type ApproverVerb } from '../src/session-manager.ts'
import { RETRY_BLOCK_OLD_LIFE_WAIT } from '../src/unavailable-retry.ts'
import { KILL_OUTCOME_NOT_KILLED } from '../src/checked-kill.ts'
import { KILL_RETRY_SPACING_MS, KILL_RETRY_TRIES } from '../src/kill-retry.ts'
import {
  runInAttempt,
  UNAVAILABLE_RETRY_BASE_S,
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
  UNAVAILABLE_RETRY_CAUSE_KILL_FAILED,
  UNAVAILABLE_RETRY_CAUSE_PENDING_ROW,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CEILING_S,
  UNAVAILABLE_RETRY_ROW_PENDING,
  UNAVAILABLE_RETRY_STOP_CAPPED,
  UNAVAILABLE_RETRY_STOP_LATCHED,
  UNAVAILABLE_RETRY_STOP_NOT_APPLIED,
  UNAVAILABLE_RETRY_STOP_NOT_UP,
  UNAVAILABLE_RETRY_STOP_SHUTDOWN,
  UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED,
  UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  UNAVAILABLE_RETRY_TERMINAL_STOPS,
  type UnavailableRetryConditionEndResult,
} from '../src/unavailable-retry.ts'
import {
  cannedErr,
  cannedKillResult,
  cannedListRow,
  cannedOk,
  cannedGetResult,
  cannedStatusResult,
  errCallTimeout,
  errInstanceIdCollision,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSendKeys,
  errTmuxUnresponsive,
  errTmuxUnresponsiveStillStopping,
  cannedFindMissing,
  holdFindMissing,
  holdSpawns,
  unavailableForms,
} from './test-helpers/agent-director-stub.ts'
import { LIVE_ROW_OUTCOME_ABORTED, LIVE_ROW_OUTCOME_LAUNCHED, LIVE_ROW_SEQUENCE_ENTRY_GET } from '../src/live-row-sequence.ts'
import type { AdConfigTables } from './test-helpers/ad-settings.ts'
import { APPROVER_VERB_CALLS, conflictForPersona, conflictNoticeForPersona } from './test-helpers/conflict-cases.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import {
  callCounts,
  callCountsSince,
  collided,
  conditionAlertLine,
  conditionEndedLine,
  conditionEndedLines,
  conditionLinePrefix,
  conditionLines,
  conditionOnsetLine,
  conditionRecoveryLine,
  conditionSilentEndLine,
  conditionStartedLines,
  expectLostMessageReports,
  expectPendingOnlyWatch,
  killFailureNotice,
  launchThroughSequence,
  makeRecoveryHarness,
  ordinaryAlertContent,
  ownRowsLiveThenMissing,
  personaOf,
  retryNow,
  scriptLiveRowElsewhere,
  startSequenceHeldAtRun,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
  type RecoveryNotice,
  type RecoveryStubScript,
} from './test-helpers/recovery-harness.ts'
import { PRE_PERSONA_ID, holdOldAt } from './test-helpers/old-life.ts'

const KIND = PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE

let harness: RecoveryHarness | undefined

afterEach(() => {
  const h = harness
  harness = undefined
  if (h === undefined) return
  assertNoLeak(h.captured())
  h.cleanup()
  expect(h.clock.pendingCount()).toBe(0)
})

/** A harness with both settings 0 unless `options` say otherwise; returns it with its two persona keys, P first. */
function build(options?: RecoveryHarnessOptions): { h: RecoveryHarness; p: string; b: string } {
  const h = (harness = makeRecoveryHarness(options))
  const [p, b] = h.keys as [string, string]
  return { h, p, b }
}

/** The working-row wait's poll interval in the launch cases, in real ms: a wait that goes on past a failed poll (b.jg5 SRJ-605) polls again at once. */
const WAIT_POLL_MS = 1

/** Half the retry timer's first wait, in ms: a clock step that fires no retry. */
function halfFirstWaitMs(): number {
  return (doublingBackoffDelay(UNAVAILABLE_RETRY_BASE_S, 0, UNAVAILABLE_RETRY_CEILING_S) * 1000) / 2
}

/** Persona `key`'s condition holds, started once by `verb`, with its first refusal at `at`. */
function expectHolds(h: RecoveryHarness, key: string, verb: string, at: number): void {
  expect(h.tmuxUnresponsive.holds(key)).toBe(true)
  expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBe(at)
  const started = conditionStartedLines(h, key)
  expect(started).toHaveLength(1)
  expect(started[0]).toContain(` — ${verb} failed: `)
}

/** Persona `key`'s condition does not hold, never started and never ended. */
function expectNeverStarted(h: RecoveryHarness, key: string): void {
  expect(h.tmuxUnresponsive.holds(key)).toBe(false)
  expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBeUndefined()
  expect(conditionStartedLines(h, key)).toEqual([])
  expect(conditionEndedLines(h, key)).toEqual([])
  expect(h.conditionEnds.filter((end) => end.key === key)).toEqual([])
}

/**
 * No notice yet: the condition's start and its end post nothing of their own
 * (the onset waits for a later health tick or a retry past the floor, which
 * the start and end cases never reach, so no recovery follows either), and no
 * outage onset or all-clear is posted.
 */
function expectNoPostYet(h: RecoveryHarness): void {
  expect(h.episodeNotices).toEqual([])
  expect(h.outageNotices).toEqual([])
}

/**
 * Start (or continue) persona `key`'s condition: a launch whose optimistic
 * spawn is refused `make('spawn')` (`ErrTmuxUnresponsive` by default).
 * Resolves with the refusal's time.
 */
async function refuse(h: RecoveryHarness, key: string, make: (verb: string) => Error = errTmuxUnresponsive): Promise<number> {
  h.script({ spawnError: make('spawn') })
  const at = h.clock.now()
  await h.launch(key)
  h.script({ spawnError: undefined })
  expect(h.tmuxUnresponsive.holds(key)).toBe(true)
  return at
}

// ---------------------------------------------------------------------------
// What starts it (SRJ-307; AC 25, AC 27)
// ---------------------------------------------------------------------------

/** E4's UNAVAILABLE forms of agent-director's own errors other than `ErrTmuxKillFailed`, each built for the verb that meets it. */
const TMUX_STARTING_FORMS = unavailableForms(
  'ErrTmuxUnresponsive',
  'ErrTmuxUnresponsive, still stopping',
  'ErrTmuxUnresponsive, still starting',
  'ErrTmuxUnresponsive, launch timeout',
  'ErrCallTimeout',
  ['ErrUnknownErrorName', 'an unknown error name from a later binary'],
  'a wrapped UnknownError',
)

/**
 * A tmux-touching call the launch ladder makes, and the stub answers that make
 * it meet `err`. The dialog approver's calls are not here: they come after the
 * launch call returned, outside every attempt (b.jg5 SRJ-401, SRJ-307). The
 * restart run's pane reads, its one `read-pane` of a live `working`,
 * `waiting` or `check_permission` row (b.jg5 SRJ-603, SRJ-604, SRJ-606),
 * have their own rows below (`restartRunPaneReads`), each run inside its
 * recovery attempt, and so does the launch's one-line `read-pane` of an
 * `ask_user` row (b.jdc's ladder action, b.jg5 SRJ-607).
 */
interface TmuxSite {
  readonly name: string
  readonly verb: string
  script(h: RecoveryHarness, persona: Persona, err: Error): RecoveryStubScript
}

const TMUX_SITES: readonly TmuxSite[] = [
  { name: 'the optimistic spawn', verb: 'spawn', script: (_h, _p, err) => ({ spawnError: err }) },
  { name: 'the resume of an ended row', verb: 'resume', script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), resumeError: err }) },
  { name: 'the reconnect of a waiting row', verb: 'send-keys', script: (h, p, err) => ({ ...collided(h, p, { state: 'waiting' }), sendKeysError: err }) },
]

/** When the step-1 kill's UNAVAILABLE refusal of a row read live stands: after its tries (b.jg5 SRJ-702), from the sequence's start. */
const KILL_STANDS_AFTER_MS = (KILL_RETRY_TRIES - 1) * KILL_RETRY_SPACING_MS

/**
 * The live rows whose pane the restart run reads with one `read-pane` before
 * any reconnect (b.jg5 SRJ-603, SRJ-604), a prompt row among them (b.jdc's
 * one-line read, b.jg5 SRJ-606).
 */
const RESTART_RUN_ROWS = ['working', 'waiting', 'check_permission'] as const

/**
 * One restart run's calls on P's live `row` (not connected) whose `read-pane`
 * is refused: the liveness read and the reconnect adapter's state read, the
 * one `read-pane`, and on a `waiting` row the reconnect's `send-keys`, which
 * the refused read lets go ahead (a `check_permission` row's refused read is
 * taken as alive and deferred). No raw tmux call, kill or spawn.
 */
function restartRunPaneReadCalls(row: (typeof RESTART_RUN_ROWS)[number]): Record<string, number> {
  return { statusCalls: 2, readPaneCalls: 1, ...(row === 'waiting' ? { sendKeysCalls: 1 } : {}) }
}

describe('tmux-unresponsive: what starts it (SRJ-307)', () => {
  // Every form at one site and every site with at least one form: the shorter
  // list cycles under the longer. The full form × site matrix is
  // session-manager's; the by-name classifier is outage-state's.
  const paired = Array.from({ length: Math.max(TMUX_STARTING_FORMS.length, TMUX_SITES.length) }, (_, i) => {
    const [what, make] = TMUX_STARTING_FORMS[i % TMUX_STARTING_FORMS.length]!
    const site = TMUX_SITES[i % TMUX_SITES.length]!
    return [what, site.name, make, site] as const
  })

  test.each(paired)('%s at %s inside a launch starts P’s condition at the time its refusal stands; a second refusal keeps it; B’s never starts', async (_what, _site, make, site) => {
    const { h, p, b } = build()
    const firstAt = h.clock.now()
    h.script(site.script(h, personaOf(h, p), make(site.verb)))

    await h.drive(h.launch(p))

    expectHolds(h, p, site.verb, firstAt)

    await h.advance(halfFirstWaitMs())
    h.script({ spawnQueue: [], spawnError: errTmuxUnresponsive('spawn') })
    await h.drive(h.launch(p))

    expect(h.clock.now()).toBeGreaterThan(firstAt)
    expectHolds(h, p, site.verb, firstAt)
    expect(h.conditionEnds).toEqual([])
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  // A live row's kill is the live-row sequence's (b.jg5 SRJ-707, SRJ-705):
  // P's launch meets its row read `waiting` in another directory and starts
  // P's sequence, whose step-1 kill is tried up to 3 times 2 s apart (b.jg5
  // SRJ-702) inside the sequence's recovery attempt; its refusal that stands
  // aborts the sequence, so no later call of it touches tmux.
  test.each(TMUX_STARTING_FORMS.slice(0, 3))('%s at the step-1 kill of the live-row sequence P\'s launch starts over its row read live in another directory starts P’s condition when its refusal stands, after the tries; a second refusal keeps it; B’s never starts', async (_what, make) => {
    const { h, p, b } = build()
    const firstAt = h.clock.now() + KILL_STANDS_AFTER_MS
    scriptLiveRowElsewhere(h, p, { killError: make('kill') })

    expect(await launchThroughSequence(h, p)).toMatchObject({ kind: LIVE_ROW_OUTCOME_ABORTED, step: 1 })

    expect(h.stub.calls.killCalls).toHaveLength(KILL_RETRY_TRIES)
    expectHolds(h, p, 'kill', firstAt)

    await h.advance(halfFirstWaitMs())
    h.script({ spawnQueue: [], spawnError: errTmuxUnresponsive('spawn') })
    await h.drive(h.launch(p))

    expect(h.clock.now()).toBeGreaterThan(firstAt)
    expectHolds(h, p, 'kill', firstAt)
    expect(h.conditionEnds).toEqual([])
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  // The restart run (the harness's default retry action) reads a live
  // `working`, `waiting` or `check_permission` row's pane with one
  // `read-pane` (b.jg5 SRJ-603, SRJ-604, SRJ-606) inside its recovery
  // attempt. A `waiting` row's refused read lets the reconnect go ahead, so
  // its `send-keys` is refused too here: a `send-keys` that succeeded would
  // end the condition in the same run.
  const restartRunPaneReads = RESTART_RUN_ROWS.flatMap((row) =>
    TMUX_STARTING_FORMS.map(([what, make]) => [what, row, make] as const),
  )

  test.each(restartRunPaneReads)('%s answering the restart run’s read-pane of P’s live %s row starts P’s condition at the first refusal’s time; a second run’s refusal keeps it; B’s never starts; nothing is counted', async (_what, row, make) => {
    const { h, p, b } = build()
    h.script({
      statusResult: cannedStatusResult({ state: row }),
      readPaneError: make('read-pane'),
      ...(row === 'waiting' ? { sendKeysError: make('send-keys') } : {}),
    })
    h.controller.arm(p, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })

    const firstAt = await retryNow(h, p)

    expectHolds(h, p, 'read-pane', firstAt)
    expect(callCounts(h)).toEqual(restartRunPaneReadCalls(row))
    expect(h.controller.isArmed(p)).toBe(true)

    const before = callCounts(h)
    const secondAt = await retryNow(h, p)

    expect(secondAt).toBeGreaterThan(firstAt)
    expect(callCountsSince(callCounts(h), before)).toEqual(restartRunPaneReadCalls(row))
    expectHolds(h, p, 'read-pane', firstAt)
    expect(h.conditionEnds).toEqual([])
    expect(h.triggers.filter((t) => t.key !== p)).toEqual([])
    expect(getFailureCount(p)).toBe(0)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  // b.jdc's ladder action (b.jg5 SRJ-607): a launch meeting P's colliding
  // `ask_user` row reads its pane with one one-line `read-pane` inside the
  // launch; a refused read is taken as alive (no action).
  test.each(TMUX_STARTING_FORMS)('%s answering the one-line read-pane of the ask_user row a launch meets starts P’s condition at the first refusal’s time; a second launch’s refusal keeps it; B’s never starts; nothing is counted', async (_what, make) => {
    const { h, p, b } = build()
    const promptRow = (): RecoveryStubScript => ({ ...collided(h, personaOf(h, p), { state: 'ask_user' }), readPaneError: make('read-pane') })
    const firstAt = h.clock.now()
    h.script(promptRow())

    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'no-op' })

    expectHolds(h, p, 'read-pane', firstAt)
    expect(callCounts(h)).toEqual({ spawnCalls: 1, getCalls: 1, readPaneCalls: 1 })

    await h.advance(halfFirstWaitMs())
    h.script(promptRow())
    expect(await h.launch(p)).toStrictEqual({ key: p, action: 'no-op' })

    expect(h.clock.now()).toBeGreaterThan(firstAt)
    expectHolds(h, p, 'read-pane', firstAt)
    expect(h.conditionEnds).toEqual([])
    expect(getFailureCount(p)).toBe(0)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  // b.jg5 SRJ-105, SRJ-112, SRJ-707's Test line: the reuse spawn is a
  // tmux-touching verb. Reached through the live-row sequence's final launch,
  // entered at its step-2 `get` so no kill comes before it, its UNAVAILABLE
  // answer starts P's condition inside the sequence's recovery attempt; the
  // refusal posts nothing itself and counts nothing, and the onset comes only
  // at the next health tick that started after it.
  test.each(unavailableForms('ErrTmuxUnresponsive', 'ErrTmuxUnresponsive, still stopping', 'ErrTmuxUnresponsive, still starting'))('%s answering the reuse spawn at the live-row sequence’s final launch starts P’s condition at that time, counting nothing; nothing is posted before the next health tick, whose onset check posts the onset; B’s never starts', async (_what, make) => {
    const { h, p, b } = build(TICK_MODE)
    h.script({ getResult: cannedGetResult({ state: LIVENESS_DEAD_ROW_ENDED }, personaOf(h, p), h.home), spawnError: make('spawn') })
    const at = h.clock.now()

    const outcome = await h.runSequence(p, { lastReadState: cannedStatusResult().state, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, result: { key: p, action: SPAWN_ACTION_RETRYING } })
    expectHolds(h, p, 'spawn', at)
    expect([h.reuseSpawns().length, h.stub.calls.killCalls.length, getFailureCount(p)]).toEqual([1, 0, 0])
    // A tick started at the refusal's own time posts no onset.
    h.tickOnset(at)
    expectNoPostYet(h)

    await h.advance(tickMs(h))
    tick(h)

    expectPosts(h, [onset(p)])
    expectNeverStarted(h, b)
  })

  // b.jg5 SRJ-307, SRJ-704, SRJ-1011: ErrTmuxKillFailed goes to the
  // kill-failure alert, never to the condition. Its ordinary version is the
  // one post, and the episode it opens gives a message lost afterwards state 4.
  test('ErrTmuxKillFailed from the live-row sequence\'s kill of a row read live (started at a replacement site), at every try, starts nothing; its one post is the ordinary kill-failure alert (the kill-failure cause only, once); a message lost after it reports kill failed, never not answering (SRJ-1011)', async () => {
    const { h, p, b } = build()
    const err = errTmuxKillFailed()
    scriptLiveRowElsewhere(h, p, { killError: err })

    await launchThroughSequence(h, p)

    expect(h.stub.calls.killCalls).toHaveLength(KILL_RETRY_TRIES)
    expect(h.triggers.filter((t) => t.kind === UNAVAILABLE_RETRY_CAUSE_KILL_FAILED)).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED }])
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectPosts(h, [killFailureNotice(p, ordinaryAlertContent(p, { last: err }))])

    // No condition, no outage: not state 5; P's kill-failure episode is open: state 4.
    expect(getOutageFlags(p).size).toBe(0)
    await expectLostMessageReports(h, p, 'kill-failed')
    expectNeverStarted(h, p)
  })

  // b.jg5 SRJ-702, SRJ-704, SRJ-307: after a survivor-naming failure, tries
  // that end in ErrTmuxUnresponsive raise the ordinary version, and the last
  // outcome keeps its own handling besides: it starts the condition once, at
  // the time it stands (the earlier try's ErrTmuxKillFailed started nothing).
  test('a survivor-naming ErrTmuxKillFailed, then ErrTmuxUnresponsive twice, at the live-row sequence\'s kill of a row read live: the condition starts once, when the last outcome stands, beside one ordinary alert quoting the survivor-naming description; B’s never starts', async () => {
    const { h, p, b } = build()
    const survivor = errTmuxKillFailed(undefined, 'pane-process-survived')
    scriptLiveRowElsewhere(h, p, {
      killQueue: [cannedErr(survivor), cannedErr(errTmuxUnresponsive('kill')), cannedErr(errTmuxUnresponsive('kill'))],
    })
    const standsAt = h.clock.now() + KILL_STANDS_AFTER_MS

    await launchThroughSequence(h, p)

    expect(h.stub.calls.killCalls).toHaveLength(KILL_RETRY_TRIES)
    expectHolds(h, p, 'kill', standsAt)
    expectNeverStarted(h, b)
    expectPosts(h, [killFailureNotice(p, ordinaryAlertContent(p, { earlierSurvivor: survivor }))])
  })

  // b.jg5 SRJ-307, SRJ-1016: the kill-failure episode and the condition are
  // kept apart: the alert neither ends a condition that holds nor is held
  // back by it, and the condition's own onset still posts at its next tick.
  test('a condition already holding for P is neither ended nor held back by the ordinary alert: the alert posts, the condition keeps its first refusal, and its onset still posts at the next tick', async () => {
    const { h, p } = build(TICK_MODE)
    const at = await refuse(h, p)
    const err = errTmuxKillFailed()
    scriptLiveRowElsewhere(h, p, { spawnError: undefined, killError: err })

    await launchThroughSequence(h, p)

    const killAlert = killFailureNotice(p, ordinaryAlertContent(p, { last: err }))
    expectHolds(h, p, 'spawn', at)
    expect(h.conditionEnds).toEqual([])
    expectPosts(h, [killAlert])

    await h.advance(tickMs(h))
    tick(h)

    expectHolds(h, p, 'spawn', at)
    expectPosts(h, [killAlert, onset(p)])
  })

  // b.jg5 SRJ-702, SRJ-307: only the outcome that stands reaches the
  // condition. A try's UNAVAILABLE that a later try's success replaces starts
  // nothing and arms no cause of its own, and the own-row `status` read
  // between the tries (not tmux-touching) neither starts the condition nor
  // ends it. The only arm is the sequence's successful launch's pending-only
  // watch on its new row (b.jg5 SRJ-301, SRJ-409).
  test('an ErrTmuxUnresponsive try then a success at the live-row sequence\'s kill of a row read live starts no condition and arms only the launch\'s pending-only watch; the sequence\'s run and reuse spawn follow, with no delete', async () => {
    const { h, p, b } = build()
    scriptLiveRowElsewhere(h, p, { killQueue: [cannedErr(errTmuxUnresponsive('kill')), cannedOk(cannedKillResult(true))] })

    expect(await launchThroughSequence(h, p)).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, result: { key: p, action: 'spawned' } })

    expect(h.stub.calls.killCalls).toHaveLength(2)
    expect(h.stub.calls.deleteCalls).toEqual([])
    expect(h.stub.calls.spawnCalls).toHaveLength(2)
    expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_PENDING_ROW }])
    expectPendingOnlyWatch(h, p)
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  test.each<[string, RecoveryStubScript['statusQueue']]>([
    ['a read that finds the row live', [cannedOk(cannedStatusResult({ state: 'waiting' }))]],
    ['a read that fails (ErrCallTimeout)', [cannedErr(errCallTimeout('status'))]],
  ])('with P’s condition holding, %s between the live-row sequence’s kill’s tries neither starts nor ends it; the standing refusal keeps it', async (_label, statusQueue) => {
    const { h, p, b } = build()
    const at = await refuse(h, p)
    scriptLiveRowElsewhere(h, p, {
      spawnError: undefined,
      killError: errTmuxUnresponsive('kill'),
      statusQueue: [...(statusQueue ?? []), cannedOk(cannedStatusResult({ state: 'waiting' }))],
    })

    await launchThroughSequence(h, p)

    expect(h.stub.calls.killCalls).toHaveLength(KILL_RETRY_TRIES)
    expectHolds(h, p, 'spawn', at)
    expect(h.conditionEnds).toEqual([])
    expect(conditionEndedLines(h, p)).toEqual([])
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  test.each<[string, string, (h: RecoveryHarness, persona: Persona) => RecoveryStubScript]>([
    ['the collision get', 'get', () => ({ spawnQueue: [cannedErr(errInstanceIdCollision())], getError: errCallTimeout('get') })],
    // b.jg5 SRJ-605: the working-row wait goes on past its failed poll; its
    // next poll reads the stub's default `waiting` row and the launch
    // reconnects, so the launch ends.
    ['the working-row read', 'status', (h, p) => ({ ...collided(h, p, { state: 'working' }), statusQueue: [cannedErr(errCallTimeout('status'))] })],
    ['the sweep before a working-row wait', 'find-missing', (h, p) => ({ ...collided(h, p, { state: 'working' }), findMissingError: errCallTimeout('find-missing') })],
  ])('AC 27: ErrCallTimeout from %s (%s) inside a launch starts nothing and posts nothing; the retry timer is armed', async (_site, _verb, script) => {
    const { h, p, b } = build()
    // The working-row wait sleeps its poll interval in real time between polls.
    h.config.agent_director_poll_interval_ms = WAIT_POLL_MS
    h.script(script(h, personaOf(h, p)))

    await h.launch(p)

    expect(h.triggers).toContainEqual({ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
    expect(getFailureCount(p)).toBe(0)
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  test.each<[string, AdCall]>([
    ['status', 'status'],
    ['get', 'get'],
    ['list', 'list'],
    ['find-missing', 'find-missing'],
    ['delete', 'delete'],
    ['a kill of a row not read live', AD_CALL_KILL_ROW_NOT_READ_LIVE],
  ])('inside a launch attempt, a wrapped %s call refused ErrTmuxUnresponsive starts nothing (the timer is armed)', async (_what, call) => {
    const { h, p, b } = build()

    await runInAttempt(p, 'launch', () =>
      expect(withOutageDetection(p, undefined, call, () => Promise.reject(errTmuxUnresponsive()))).rejects.toThrow(),
    )

    expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }])
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  test('inside a recovery attempt, a wrapped read-pane call refused ErrTmuxUnresponsive starts P’s condition at its time', async () => {
    const { h, p, b } = build()
    const at = h.clock.now()

    await runInAttempt(p, 'recovery', () =>
      expect(withOutageDetection(p, undefined, 'read-pane', () => Promise.reject(errTmuxUnresponsive('read-pane')))).rejects.toThrow(),
    )

    expectHolds(h, p, 'read-pane', at)
    expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }])
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  // The dialog approver runs after its launch call returned, outside every
  // launch or recovery attempt (SRJ-401, SRJ-307; hatch A2), as the tick's
  // read does: none of its calls starts the condition or arms the timer. One
  // starting form per pane verb, and AC 27's form at its status. The only arm
  // is the launch's own pending-only watch on its new row (b.jg5 SRJ-301,
  // SRJ-409), with no cause of the approver's added to it.
  test.each<[string, ApproverVerb, (verb: string) => Error]>([
    ['ErrTmuxUnresponsive', 'read-pane', errTmuxUnresponsive],
    ['ErrTmuxUnresponsive', 'send-keys', errTmuxUnresponsive],
    ['AC 27: ErrCallTimeout', 'status', errCallTimeout],
  ])('%s answering the dialog approver’s %s, after the launch returned, starts nothing, posts nothing and arms nothing beyond the launch’s pending-only watch', async (_what, verb, make) => {
    const { h, p, b } = build()
    const pending = { statusResult: cannedStatusResult({ state: 'pending' }) }
    h.script(
      verb === 'status'
        ? { statusError: make(verb) }
        : verb === 'read-pane'
          ? { ...pending, readPaneError: make(verb) }
          : { ...pending, readPaneResults: [{ pane: TRUST_DIALOG_NEEDLE }], sendKeysError: make(verb) },
    )

    expect(await h.launch(p)).toMatchObject({ key: p, action: 'spawned' })
    await h.settle()

    expect(h.stub.calls[APPROVER_VERB_CALLS[verb]]).toHaveLength(1)
    expect(h.approverRunning(p)).toBe(true)
    expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_PENDING_ROW }])
    expectPendingOnlyWatch(h, p)
    expect(h.controller.view(p)?.causes).toEqual([UNAVAILABLE_RETRY_CAUSE_PENDING_ROW])
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>, number]>([
    // b.jg5 SRJ-110 (hatch A3): the teardown's kill answers its outcome and
    // arms nothing, even run inside a recovery attempt. Its tries are E25's:
    // today one call.
    ['a persona teardown’s kill, even inside a recovery attempt (b.jg5 SRJ-110: it answers its outcome and arms nothing)', async (h, key) => {
      const err = errTmuxUnresponsive('kill')
      h.script({ killError: err })
      await runInAttempt(key, 'recovery', async () => {
        expect(await killPersonaInstance(key, { context: KILL_CONTEXT_TEARDOWN })).toMatchObject({ kind: KILL_OUTCOME_NOT_KILLED, error: err })
      })
    }, 1],
    // b.jg5 SRJ-702: the sweep's kill of a row listed live makes its tries,
    // with the status reads between them; none of it starts or arms anything.
    ['a start-sweep kill of the persona’s row in another directory, at every try', async (h, key) => {
      h.script({
        listResult: { spawns: [cannedListRow({ cwd: h.home, state: 'waiting' }, personaOf(h, key), h.home)] },
        killError: errTmuxUnresponsive('kill'),
      })
      await h.drive(reconcileOrphans(h.config, h.killRetryClock))
    }, KILL_RETRY_TRIES],
  ])('%s answering ErrTmuxUnresponsive starts nothing and arms nothing', async (_what, run, kills) => {
    const { h, p, b } = build()

    await run(h, p)

    expect(h.stub.calls.killCalls).toHaveLength(kills)
    expect(h.triggers).toEqual([])
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  test('the health tick’s liveness read, outside every attempt, answering ErrTmuxUnresponsive starts nothing', async () => {
    const { h, p, b } = build()
    h.script({ statusError: errTmuxUnresponsive('status') })

    expect(await _buildIsSessionAliveAdapter(() => h.config)(p)).toEqual(LIVENESS_READING_UNKNOWN)

    expect(h.stub.calls.statusCalls).toHaveLength(1)
    expect(h.triggers).toEqual([])
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  test('with no condition sink installed, a launch refused ErrTmuxUnresponsive starts nothing', async () => {
    const h = (harness = makeRecoveryHarness({ conditionSink: false }))
    const [p] = h.keys as [string]
    h.script({ spawnError: errTmuxUnresponsive('spawn') })

    await h.launch(p)

    expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }])
    expectNeverStarted(h, p)
    expectNoPostYet(h)
  })
})

// ---------------------------------------------------------------------------
// Held apart from the outages (SRJ-307; AC 25, AC 27)
// ---------------------------------------------------------------------------

/**
 * Raise an outage for persona `key` the way a wrapped `status` read does when
 * it answers `err`, and return the one flag it raised (taken from the outage
 * state, so no class label is written here).
 */
async function raiseOutage(key: string, workingDirectory: string | undefined, err: Error): Promise<OutageClass> {
  await expect(withOutageDetection(key, workingDirectory, 'status', () => Promise.reject(err))).rejects.toBe(err)
  const flags = [...getOutageFlags(key)]
  expect(flags).toHaveLength(1)
  return flags[0]!
}

describe('tmux-unresponsive: held apart from the outages', () => {
  test('raising and ending it leaves P’s outage flags as they were and posts no onset and no all-clear', async () => {
    const { h, p, b } = build()

    await refuse(h, p)
    expect([...getOutageFlags(p)]).toEqual([])

    // A tmux-unavailable outage raised while the condition holds.
    const raised = await raiseOutage(p, undefined, errTmuxNotAvailable(undefined, 'status'))

    // The condition's end hook alone; the health tick's own clear of
    // tmux-unavailable (SRJ-312) is health-check's, not the condition's.
    expect(h.tickEnd(p)).toBe('ended')

    expect([...getOutageFlags(p)]).toEqual([raised])
    expect(h.outageNotices).toEqual([{ key: p, text: ONSET_TEMPLATES[raised]() }])
    expect(h.episodeNotices).toEqual([])
    expectNeverStarted(h, b)
  })

  // b.jg5 SRJ-312: only tmux answering clears tmux-unavailable (a
  // tmux-touching success or GONE, or a check that finds the row live and
  // connected), and each of those ends the condition too. The wrapper's
  // success and GONE branches clear the outage first and end the condition
  // after, in the same call, so its all-clear is posted while the condition
  // still holds; the tick and the retry end the condition first. The case
  // records whether the condition holds at each outage post.
  test.each<[string, (key: string) => Promise<void>]>([
    ['a send-keys that succeeds', (key) => wrapped(key, 'send-keys', RESOLVES)],
    ['a read-pane that answers GONE (ErrTmuxCaptureFailed)', (key) => wrapped(key, 'read-pane', { rejects: () => errTmuxCaptureFailed() })],
  ])('a tmux-unavailable outage raised while the condition holds, cleared by %s, posts its single all-clear while the condition still holds, neither held back nor joined; the condition, untouched by the outage, then ends by its own reason with its own recovery', async (_what, clear) => {
    const { h, p, b } = build(TICK_MODE)
    const at = await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)
    expectPosts(h, [onset(p)])

    const raised = await raiseOutage(p, undefined, errTmuxNotAvailable(undefined, 'status'))

    // The outage's onset leaves the condition as it was.
    expectHolds(h, p, 'spawn', at)
    expect(conditionEndedLines(h, p)).toEqual([])
    expect(h.conditionEnds).toEqual([])

    const holdsAtOutagePost: boolean[] = []
    const post = h.outageNotices.push.bind(h.outageNotices)
    h.outageNotices.push = (...notices: RecoveryNotice[]) => {
      holdsAtOutagePost.push(h.tmuxUnresponsive.holds(p))
      return post(...notices)
    }

    await clear(p)

    // The outage: cleared, with one all-clear naming it alone, posted while the condition held.
    expect([...getOutageFlags(p)]).toEqual([])
    expect(h.outageNotices).toEqual([
      { key: p, text: ONSET_TEMPLATES[raised]() },
      { key: p, text: ALL_CLEAR_TEMPLATE(new Map([[raised, { detail: undefined }]])) },
    ])
    expect(holdsAtOutagePost).toEqual([true])
    // The clear came first: it reached the retry timer's condition-end entry
    // and stopped P's timer (SRJ-306), which, as every real stop while the
    // condition holds, cancelled its pending alert check (SRJ-309).
    expect(h.outageClears).toEqual([{ key: p, reading: undefined, result: 'stopped' }])

    // The condition: its own end (the tmux verb), once, with its own recovery,
    // apart from the all-clear; the timer was already stopped when it ended.
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.episodeNotices).toEqual([onset(p), recovery(p)])
    expect(noticeAndEndLines(h, p)).toEqual([
      conditionOnsetLine(p, 'a health tick', tickMs(h)),
      alertCancelledLine(p, UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TMUX_VERB),
      conditionRecoveryLine(p),
    ])
    expect(h.conditionEnds).toEqual([{ key: p, reading: undefined, result: 'not-armed' }])
    expectNeverStarted(h, b)
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>]>([
    ['a wrapped status', async (_h, key) => {
      await withOutageDetection(key, undefined, 'status', () => Promise.resolve(cannedStatusResult({ state: 'waiting' })))
    }],
    ['the health tick’s liveness read (its bare status)', async (h, key) => {
      h.script({ statusResult: cannedStatusResult({ state: 'waiting' }) })
      const before = h.stub.calls.statusCalls.length
      expect(await _buildIsSessionAliveAdapter(() => h.config)(key)).toEqual(LIVENESS_READING_LIVE)
      expect(h.stub.calls.statusCalls).toHaveLength(before + 1)
    }],
  ])('SRJ-312: %s that succeeds while the tmux-unavailable outage and the condition are both active clears neither and posts nothing', async (_what, read) => {
    const { h, p, b } = build()
    const at = await refuse(h, p)
    const raised = await raiseOutage(p, undefined, errTmuxNotAvailable(undefined, 'status'))

    await read(h, p)

    expect([...getOutageFlags(p)]).toEqual([raised])
    expect(h.outageNotices).toEqual([{ key: p, text: ONSET_TEMPLATES[raised]() }])
    expect(h.outageClears).toEqual([])
    expect(h.controller.isArmed(p)).toBe(true)
    expectHolds(h, p, 'spawn', at)
    expect(conditionEndedLines(h, p)).toEqual([])
    expect(h.conditionEnds).toEqual([])
    expect(h.episodeNotices).toEqual([])
    expectNeverStarted(h, b)
  })

  test('a cwd-unreachable outage raised before the condition keeps its flag and bad stretch through the start and the end', async () => {
    const { h, p, b } = build()
    const dir = personaOf(h, p).working_directory
    const raised = await raiseOutage(p, dir, new ErrCwdNotFound('status', 'ErrCwdNotFound', 'cwd not found'))

    await refuse(h, p)
    expect(h.tickEnd(p)).toBe('ended')

    expect([...getOutageFlags(p)]).toEqual([raised])
    expect(h.outageNotices).toEqual([{ key: p, text: ONSET_TEMPLATES[raised](dir) }])

    // A later launch whose spawn succeeds clears the flag: the all-clear
    // names the cwd outage alone, so the condition added nothing to the stretch.
    await h.advance(halfFirstWaitMs())
    await h.launch(p)

    expect([...getOutageFlags(p)]).toEqual([])
    expect(h.outageNotices).toEqual([
      { key: p, text: ONSET_TEMPLATES[raised](dir) },
      { key: p, text: ALL_CLEAR_TEMPLATE(new Map([[raised, { detail: dir }]])) },
    ])
    expect(h.episodeNotices).toEqual([])
    expectNeverStarted(h, b)
  })
})

// ---------------------------------------------------------------------------
// What ends it (SRJ-310)
// ---------------------------------------------------------------------------

/** A wrapped call's outcome: it resolves, or rejects with an error built at the call. */
type CallOutcome = { readonly resolves: true } | { readonly rejects: () => Error }

const RESOLVES: CallOutcome = { resolves: true }

/** Make the wrapped `call` for persona `key`, outside every attempt, with `outcome`. */
async function wrapped(key: string, call: AdCall, outcome: CallOutcome): Promise<void> {
  const fn = 'resolves' in outcome ? () => Promise.resolve({}) : () => Promise.reject(outcome.rejects())
  try {
    await withOutageDetection(key, undefined, call, fn)
  } catch {
    /* the wrapper rethrows; the case reads the condition */
  }
}

describe('tmux-unresponsive: what ends it (SRJ-310)', () => {
  test.each<[string, AdCall, CallOutcome, string | undefined, UnavailableRetryConditionEndResult]>([
    ['a spawn succeeds', 'spawn', RESOLVES, UNAVAILABLE_RETRY_ROW_PENDING, 'kept'],
    ['a resume succeeds', 'resume', RESOLVES, UNAVAILABLE_RETRY_ROW_PENDING, 'kept'],
    ['a read-pane succeeds', 'read-pane', RESOLVES, undefined, 'stopped'],
    ['a send-keys succeeds', 'send-keys', RESOLVES, undefined, 'stopped'],
    ['a pause succeeds', 'pause', RESOLVES, undefined, 'stopped'],
    ['a kill of a row read live succeeds', AD_CALL_KILL_ROW_READ_LIVE, RESOLVES, undefined, 'stopped'],
    ['a send-keys answers GONE (ErrTmuxSendKeys)', 'send-keys', { rejects: errTmuxSendKeys }, undefined, 'stopped'],
    ['a read-pane answers GONE (ErrTmuxCaptureFailed)', 'read-pane', { rejects: () => errTmuxCaptureFailed() }, undefined, 'stopped'],
  ])('%s, outside every attempt: the condition ends once, and the retry timer’s condition-end entry is called once with its reading', async (_what, call, outcome, reading, result) => {
    const { h, p, b } = build()
    await refuse(h, p)

    await wrapped(p, call, outcome)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBeUndefined()
    expect(conditionEndedLines(h, p)).toHaveLength(1)
    expect(h.conditionEnds).toEqual([{ key: p, reading, result }])
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  test.each<[string, AdCall, CallOutcome]>([
    ['a status succeeds', 'status', RESOLVES],
    ['a get succeeds', 'get', RESOLVES],
    ['a list succeeds', 'list', RESOLVES],
    ['a find-missing succeeds', 'find-missing', RESOLVES],
    ['a delete succeeds', 'delete', RESOLVES],
    ['a kill of a row not read live succeeds', AD_CALL_KILL_ROW_NOT_READ_LIVE, RESOLVES],
    ['a status answers GONE (ErrTmuxCaptureFailed)', 'status', { rejects: () => errTmuxCaptureFailed(undefined, 'status') }],
  ])('%s: the condition still holds, with its first refusal’s time', async (_what, call, outcome) => {
    const { h, p, b } = build()
    const at = await refuse(h, p)

    await wrapped(p, call, outcome)

    expectHolds(h, p, 'spawn', at)
    expect(conditionEndedLines(h, p)).toEqual([])
    expect(h.conditionEnds).toEqual([])
    expectNeverStarted(h, b)
    expect(h.episodeNotices).toEqual([])
  })

  test('a later launch whose spawn succeeds ends it with the pending reading, and the retry timer is kept', async () => {
    const { h, p, b } = build()
    await refuse(h, p)

    await h.advance(halfFirstWaitMs())
    await h.launch(p)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.conditionEnds).toEqual([{ key: p, reading: UNAVAILABLE_RETRY_ROW_PENDING, result: 'kept' }])
    expect(h.controller.isArmed(p)).toBe(true)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  // b.jg5 SRJ-112, SRJ-310: the reuse spawn's success at the live-row
  // sequence's final launch, entered at its step-2 `get` so no kill comes
  // before it, is the first tmux-touching success: it ends the condition with
  // the pending reading, as a launch's spawn does.
  test('the live-row sequence’s final reuse spawn succeeding ends it with the pending reading, and the retry timer is kept', async () => {
    const { h, p, b } = build()
    await refuse(h, p)

    await h.advance(halfFirstWaitMs())
    h.script({ getResult: cannedGetResult({ state: LIVENESS_DEAD_ROW_ENDED }, personaOf(h, p), h.home) })
    const outcome = await h.runSequence(p, { lastReadState: cannedStatusResult().state, entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })

    expect(outcome).toMatchObject({ kind: LIVE_ROW_OUTCOME_LAUNCHED, result: { key: p, action: 'spawned' } })
    expect(h.reuseSpawns()).toHaveLength(1)
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.conditionEnds).toEqual([{ key: p, reading: UNAVAILABLE_RETRY_ROW_PENDING, result: 'kept' }])
    expect(h.controller.isArmed(p)).toBe(true)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  test('a later launch whose reconnect send-keys answers GONE ends it with no reading, before the launch’s own resume', async () => {
    const { h, p, b } = build()
    await refuse(h, p)

    h.script({ ...collided(h, personaOf(h, p), { state: 'waiting' }), sendKeysError: errTmuxSendKeys() })
    await h.launch(p)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.stub.calls.resumeCalls).toHaveLength(1)
    expect(h.conditionEnds).toEqual([{ key: p, reading: undefined, result: 'stopped' }])
    expect(conditionEndedLines(h, p)).toHaveLength(1)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  // The restart run's `read-pane` of a live `working`, `waiting` or
  // `check_permission` row (b.jg5 SRJ-603, SRJ-604, SRJ-606) is
  // tmux-touching: a pane or GONE ends the
  // condition its earlier refusal started, while the run is in progress (the
  // end is deferred to the run's end). With both settings 0 the onset comes
  // only at a retry past the floor, and the end posts the recovery only after
  // it (no alert check here, so the onset is the only notice). A pane on a
  // `waiting` row lets the reconnect go ahead, and on a `check_permission`
  // row defers; GONE types nothing and sweeps, and the re-probe reads the row
  // live again.
  const restartRunEnds = RESTART_RUN_ROWS.flatMap((row) =>
    ([
      ['a pane', { readPaneResults: [{ pane: '' }] }, { statusCalls: 2, readPaneCalls: 1, ...(row === 'waiting' ? { sendKeysCalls: 1 } : {}) }],
      ['GONE (ErrTmuxCaptureFailed)', { readPaneError: errTmuxCaptureFailed() }, { statusCalls: 3, readPaneCalls: 1, findMissingCalls: 1 }],
    ] satisfies Array<[string, RecoveryStubScript, Record<string, number>]>).flatMap(([what, answer, calls]) => [
      [what, row, 'before any onset', answer, calls, false],
      [what, row, 'after its onset', answer, calls, true],
    ] as const),
  )

  test.each(restartRunEnds)('%s answering a later restart run’s read-pane of P’s live %s row, %s, ends P’s condition once, with the recovery post only after an onset; nothing is counted; B’s never starts', async (_what, row, _when, answer, calls, withOnset) => {
    const { h, p, b } = build({ alertThresholdMs: false })
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    h.script({
      statusResult: cannedStatusResult({ state: row }),
      readPaneError: errTmuxUnresponsive('read-pane'),
      ...(row === 'waiting' ? { sendKeysError: errTmuxUnresponsive('send-keys') } : {}),
    })
    h.controller.arm(p, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
    const at = await retryNow(h, p)
    expectHolds(h, p, 'read-pane', at)

    const lines: string[] = []
    if (withOnset) {
      let firedAt = at
      while (firedAt - at < FLOOR_MS) firedAt = await retryNow(h, p)
      expectPosts(h, [onset(p)])
      lines.push(conditionOnsetLine(p, 'a retry', firedAt - at))
    }
    expect(noticeAndEndLines(h, p)).toEqual(lines)
    expect(h.tmuxUnresponsive.holds(p)).toBe(true)
    h.script({ readPaneError: undefined, sendKeysError: undefined, ...answer })
    const before = callCounts(h)

    await retryNow(h, p)

    expect(callCountsSince(callCounts(h), before)).toEqual(calls)
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBeUndefined()
    expect(conditionStartedLines(h, p)).toHaveLength(1)
    expect(conditionEndedLines(h, p)).toEqual([conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TMUX_VERB)])
    expect(h.conditionEnds).toEqual([{ key: p, reading: undefined, result: 'deferred' }])
    expect(noticeAndEndLines(h, p)).toEqual([
      ...lines,
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TMUX_VERB),
      ...(withOnset ? [conditionRecoveryLine(p)] : []),
    ])
    expectPosts(h, withOnset ? [onset(p), recovery(p)] : [])
    expect(getFailureCount(p)).toBe(0)
    expectNeverStarted(h, b)
  })

  test('ends are idempotent: a second end, by any reason, does nothing', async () => {
    const { h, p, b } = build()
    await refuse(h, p)

    expect(h.tickEnd(p)).toBe('ended')
    expect(h.tickEnd(p)).toBe('not-holding')
    await wrapped(p, 'spawn', RESOLVES)

    expect(conditionEndedLines(h, p)).toHaveLength(1)
    expect(h.conditionEnds).toEqual([{ key: p, reading: LIVENESS_LIVE, result: 'stopped' }])
    expectNoPostYet(h)
    expectNeverStarted(h, b)
  })

  test('after an end, a new refusal opens a new episode with a new first-refusal time', async () => {
    const { h, p, b } = build()
    const firstAt = await refuse(h, p)
    const firstEpisode = h.episodes.view(p, KIND)!.episode
    h.tickEnd(p)

    await h.advance(halfFirstWaitMs())
    const secondAt = await refuse(h, p)

    expect(secondAt).toBeGreaterThan(firstAt)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(secondAt)
    expect(h.episodes.view(p, KIND)!.episode).not.toBe(firstEpisode)
    expect(conditionStartedLines(h, p)).toHaveLength(2)
    expect(conditionEndedLines(h, p)).toHaveLength(1)
    expectNoPostYet(h)
    expectNeverStarted(h, b)
  })
})

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe('tmux-unresponsive: isolation', () => {
  test('P and B each keep their own condition: ending P’s leaves B’s with its own first refusal’s time', async () => {
    const { h, p, b } = build()
    const pAt = await refuse(h, p)
    await h.advance(halfFirstWaitMs())
    const bAt = await refuse(h, b)

    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(pAt)
    expect(h.tmuxUnresponsive.firstRefusalAt(b)).toBe(bAt)

    await wrapped(p, 'send-keys', RESOLVES)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expectHolds(h, b, 'spawn', bAt)
    expect(conditionEndedLines(h, b)).toEqual([])
    expect(h.conditionEnds.map((end) => end.key)).toEqual([p])
    expectNoPostYet(h)
  })
})

// ---------------------------------------------------------------------------
// The notices (SRJ-308, SRJ-309, SRJ-310's recovery, SRJ-1006)
// ---------------------------------------------------------------------------

/** AC 80's agent-director settings: the alert threshold is the longer of the two plus E6's addend. */
const AC_80_TMUX = { stopping_window_seconds: 30n, starting_session_seconds: 120n } as const satisfies AdConfigTables['tmux']

/** The health check on (any interval but 0); the harness has no tick of its own, so a case runs each tick with `tick`. */
const HEALTH_CHECK_S = 60

/** Health check off, every retry refused, no alert check: the onset comes at a retry past the floor. */
const RETRY_MODE: RecoveryHarnessOptions = { action: 'scripted', alertThresholdMs: false }

/** Health check on, every retry refused, the alert check over E6's threshold in effect. */
const TICK_MODE: RecoveryHarnessOptions = { action: 'scripted', healthCheckInterval: HEALTH_CHECK_S }

const FLOOR_MS = TMUX_UNRESPONSIVE_ONSET_FLOOR_MS

function onset(key: string): RecoveryNotice {
  return { key, text: tmuxUnresponsiveOnsetText(key) }
}

function alert(key: string, thresholdMs: number): RecoveryNotice {
  return { key, text: tmuxUnresponsiveAlertText(key, thresholdMs) }
}

function recovery(key: string): RecoveryNotice {
  return { key, text: tmuxUnresponsiveRecoveryText(key) }
}

/** Every notice the episodes posted, in order, is `expected`, and no outage onset or all-clear was posted. */
function expectPosts(h: RecoveryHarness, expected: readonly RecoveryNotice[]): void {
  expect(h.episodeNotices).toEqual([...expected])
  expect(h.outageNotices).toEqual([])
}

/** The health tick's spacing, in ms, from the configuration. */
function tickMs(h: RecoveryHarness): number {
  return h.config.health_check_interval * 1000
}

/**
 * One health tick, as `main()` binds its hooks: the tick starts now, its
 * healthy branch ends the condition of each persona in `live`, and its end
 * runs the onset check for the tick's start.
 */
function tick(h: RecoveryHarness, live: readonly string[] = []): void {
  const startedAt = h.clock.now()
  for (const key of live) h.tickEnd(key)
  h.tickOnset(startedAt)
}

/** Move the clock to persona `key`'s next retry and run it, unsettled; resolves with the time it was due. */
async function nextRetry(h: RecoveryHarness, key: string): Promise<number> {
  const due = await retryNow(h, key, { settle: false })
  expect(h.attempts.at(-1)).toMatchObject({ key, at: due })
  return due
}

/** How many retries persona `key`'s timer has run. */
function retriesOf(h: RecoveryHarness, key: string): number {
  return h.attempts.filter((attempt) => attempt.key === key).length
}

/** Persona `key`'s condition lines after its started lines, in order: its notice lines and its ended lines. */
function noticeAndEndLines(h: RecoveryHarness, key: string): string[] {
  return conditionLines(h, key).filter((line) => !line.startsWith(`${conditionLinePrefix(key)}started`))
}

describe('tmux-unresponsive: SRJ-1006’s texts (pin)', () => {
  test('the one pin case: the three texts for a sample session name, the 120 s floor, "over 6 minutes" at agent-director’s defaults and "over 3 minutes" (180 s) at AC 80’s settings', () => {
    const ac80 = { ...DEFAULT_AD_SETTINGS_IN_EFFECT, tmux: { ...DEFAULT_AD_SETTINGS_IN_EFFECT.tmux, ...AC_80_TMUX } }

    expect(tmuxUnresponsiveOnsetText('sample')).toBe(
      ':hourglass_flowing_sand: *Not answering* — agent-director or tmux is not answering for this persona\'s session "slack_bot_sample". CSCB keeps retrying; nothing is needed yet.',
    )
    expect(tmuxUnresponsiveAlertText('sample', adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT))).toBe(
      ':rotating_light: *Still not answering* — this persona has not reached its session "slack_bot_sample" for over 6 minutes. CSCB keeps retrying and takes no destructive action. If this persists, a human should check the host\'s tmux server and agent-director.',
    )
    expect(tmuxUnresponsiveRecoveryText('sample')).toBe(
      ':white_check_mark: *Answering again* — this persona reaches its session "slack_bot_sample" again.',
    )
    expect(TMUX_UNRESPONSIVE_ONSET_FLOOR_MS).toBe(120_000)
    expect(adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT)).toBe(360_000)
    expect(adAlertThresholdMs(ac80)).toBe(180_000)
    expect(tmuxUnresponsiveAlertText('sample', adAlertThresholdMs(ac80))).toContain(' for over 3 minutes. ')
  })
})

describe('tmux-unresponsive: the onset with the health check on (SRJ-308; AC 25)', () => {
  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>]>([
    ['a tmux-touching success before the next tick', (_h, key) => wrapped(key, 'send-keys', RESOLVES)],
    ['the next tick finding it live, before that tick’s onset check', async (h, key) => {
      await h.advance(tickMs(h))
      tick(h, [key])
    }],
  ])('a single still-stopping refusal cleared by %s posts nothing, then or at any later tick', async (_what, clear) => {
    const { h, p, b } = build(TICK_MODE)
    await refuse(h, p, errTmuxUnresponsiveStillStopping)

    await clear(h, p)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    // Ticks until past the alert threshold: no onset, and no alert either.
    const ticks = Math.ceil(adAlertThresholdMsInEffect() / tickMs(h)) + 1
    for (let n = 0; n < ticks; n++) {
      await h.advance(tickMs(h))
      tick(h)
    }
    expectPosts(h, [])
    expectNeverStarted(h, b)
  })

  test('a refusal that holds posts one onset, the builder’s text, at the first tick that started after it, and none at later ticks; a tick started before it or at its own time posts none', async () => {
    const { h, p, b } = build(TICK_MODE)
    const earlierTick = h.clock.now()
    await h.advance(1)
    const at = await refuse(h, p, errTmuxUnresponsiveStillStopping)

    h.tickOnset(earlierTick)
    h.tickOnset(at)
    expectPosts(h, [])

    await h.advance(tickMs(h))
    const tickAt = h.clock.now()
    tick(h)
    expectPosts(h, [onset(p)])
    const lines = [conditionOnsetLine(p, 'a health tick', tickAt - at)]
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    for (let n = 0; n < 3; n++) {
      await h.advance(tickMs(h))
      tick(h)
    }
    expect(h.clock.now() - at).toBeLessThan(adAlertThresholdMsInEffect())
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expectNeverStarted(h, b)
  })

  test('the mode is read at each check: with the health check on, a retry past the floor posts nothing; turned off, a tick posts nothing and the next retry posts the onset', async () => {
    const { h, p } = build({ ...TICK_MODE, alertThresholdMs: false })
    const at = await refuse(h, p)

    while (h.clock.now() - at < FLOOR_MS) await nextRetry(h, p)
    expectPosts(h, [])

    h.setHealthCheckInterval(0)
    h.tickOnset()
    expectPosts(h, [])

    const firedAt = await nextRetry(h, p)
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual([conditionOnsetLine(p, 'a retry', firedAt - at)])
  })
})

describe('tmux-unresponsive: the onset with the health check off (SRJ-308)', () => {
  test('no onset at the retries before the floor; one, the builder’s text, at the first retry at or past it; none at later retries', async () => {
    const { h, p, b } = build(RETRY_MODE)
    const at = await refuse(h, p)

    let firedAt = at
    while (firedAt - at < FLOOR_MS) {
      expectPosts(h, [])
      firedAt = await nextRetry(h, p)
    }
    expect(retriesOf(h, p)).toBeGreaterThan(1)
    expectPosts(h, [onset(p)])
    const lines = [conditionOnsetLine(p, 'a retry', firedAt - at)]
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    for (let n = 0; n < 3; n++) await nextRetry(h, p)
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
    expectNeverStarted(h, b)
  })

  test.each([
    ['1 ms short of the floor posts nothing; the next retry posts the onset', 1],
    ['exactly the floor after the first refusal posts the onset', 0],
  ])('a retry %s', async (_what, shortMs) => {
    const { h, p } = build(RETRY_MODE)
    h.controller.arm(p, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
    while (h.controller.view(p)!.dueAt! - h.clock.now() < FLOOR_MS) await nextRetry(h, p)
    const due = h.controller.view(p)!.dueAt!
    await h.advance(due - FLOOR_MS + shortMs - h.clock.now())
    expect(h.tmuxUnresponsive.start(p, 'spawn', errTmuxUnresponsive('spawn'))).toBe('started')

    const at = h.tmuxUnresponsive.firstRefusalAt(p)!
    expect(await nextRetry(h, p)).toBe(due)
    expect(due - at).toBe(FLOOR_MS - shortMs)
    expectPosts(h, shortMs === 0 ? [onset(p)] : [])
    const lines = shortMs === 0 ? [conditionOnsetLine(p, 'a retry', FLOOR_MS)] : []
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    const nextAt = await nextRetry(h, p)
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual(shortMs === 0 ? lines : [conditionOnsetLine(p, 'a retry', nextAt - at)])
  })

  test('a retry skipped because P’s launch is in flight, at or past the floor, posts the onset and makes no agent-director call', async () => {
    const { h, p, b } = build(RETRY_MODE)
    const at = await refuse(h, p)
    while (h.controller.view(p)!.dueAt! - at < FLOOR_MS) await nextRetry(h, p)
    expectPosts(h, [])

    const hold = holdSpawns(h.stub.client)
    const launch = h.launch(p)
    await hold.entered(personaInstanceId(p))
    // The server's retry action, which skips a retry while a launch is in flight.
    h.setAction(undefined)
    const calls = h.stub.callCount()

    const firedAt = await nextRetry(h, p)

    expect(h.stub.callCount()).toBe(calls)
    expect(h.controller.isArmed(p)).toBe(true)
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual([conditionOnsetLine(p, 'a retry', firedAt - at)])

    hold.fail(personaInstanceId(p), errTmuxUnresponsive('spawn'))
    await launch
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expectPosts(h, [onset(p)])
    expectNeverStarted(h, b)
  })

  // E10's hatch note carried by E21 (SRJ-308, hatch A2): the retry skipped
  // because P's live-row sequence is in flight (it blocks a retry, SRJ-303,
  // SRJ-706) still posts the onset. The sequence enters at its step-2 `get`,
  // so it makes no kill, and its first run is held.
  test('a retry skipped because P’s live-row sequence runs, at or past the floor, posts the onset and makes no agent-director call', async () => {
    const { h, p, b } = build(RETRY_MODE)
    const at = await refuse(h, p)
    while (h.controller.view(p)!.dueAt! - at < FLOOR_MS) await nextRetry(h, p)
    expectPosts(h, [])

    const hold = holdFindMissing(h.stub.client)
    ownRowsLiveThenMissing(h)
    const run = await startSequenceHeldAtRun(h, p, hold, { entryStep: LIVE_ROW_SEQUENCE_ENTRY_GET })
    expect(h.tmuxUnresponsive.holds(p)).toBe(true)
    // The server's retry action, which skips a retry while P's sequence runs.
    h.setAction(undefined)
    const calls = h.stub.callCount()

    const firedAt = await nextRetry(h, p)

    expect([h.stub.callCount(), hold.calls.length]).toEqual([calls, 1])
    expect(h.controller.isArmed(p)).toBe(true)
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual([conditionOnsetLine(p, 'a retry', firedAt - at)])

    hold.release(cannedFindMissing({ rows: { [personaInstanceId(p)]: 'ids' } }))
    await h.driveSequence(run.outcome)
    expectNeverStarted(h, b)
  })

  // E10's hatch note carried by E27 T2 (SRJ-308, hatch A2): the retry skipped
  // because an old-life wait step runs for a hold P waits on (it blocks a
  // retry, SRJ-303, SRJ-811) still posts the onset. The wait runs on a
  // pre-persona row held in P's working directory, started through the
  // session manager's ensure entry, and its first run is held; its calls are
  // on the old id only.
  test('a retry skipped because an old-life wait step runs for a hold P waits on, at or past the floor, posts the onset once and makes no agent-director call for P', async () => {
    const { h, p, b } = build(RETRY_MODE)
    const at = await refuse(h, p)
    while (h.controller.view(p)!.dueAt! - at < FLOOR_MS) await nextRetry(h, p)
    expectPosts(h, [])

    const oldId = PRE_PERSONA_ID
    holdOldAt(h, oldId, oldId, p)
    h.script({ getResult: cannedGetResult({ claude_instance_id: oldId, cwd: personaOf(h, p).working_directory }) })
    const hold = holdFindMissing(h.stub.client)
    const outcome = h.startOldLifeWait(oldId)
    await h.driveSequence(hold.entered(1))
    expect([h.tmuxUnresponsive.holds(p), personaRetryBlockCause(p)]).toEqual([true, RETRY_BLOCK_OLD_LIFE_WAIT])
    // The server's retry action, which skips a retry while a wait step P waits on runs.
    h.setAction(undefined)
    const calls = h.stub.callCount()

    const firedAt = await nextRetry(h, p)

    expect([h.stub.callCount(), hold.calls.length]).toEqual([calls, 1])
    expect(firedAt - at).toBeGreaterThanOrEqual(FLOOR_MS)
    expect(h.controller.isArmed(p)).toBe(true)
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual([conditionOnsetLine(p, 'a retry', firedAt - at)])

    await nextRetry(h, p)
    expectPosts(h, [onset(p)])
    hold.release(cannedFindMissing({ rows: { [oldId]: 'ids' } }))
    await h.driveSequence(outcome)
    expectNeverStarted(h, b)
  })

  // b.jg5 SRJ-307, SRJ-704 (AC 64): its one post is the kill-failure alert.
  test('ErrTmuxKillFailed never posts a tmux-unresponsive notice: not at retries past the floor and the threshold, nor at a tick; its one post is the ordinary kill-failure alert', async () => {
    const { h, p } = build({ action: 'scripted' })
    const err = errTmuxKillFailed()
    h.script({ ...collided(h, personaOf(h, p), { cwd: h.home, state: 'waiting' }), killError: err })
    await h.drive(h.launch(p))

    await h.advance(2 * adAlertThresholdMsInEffect())
    h.setHealthCheckInterval(HEALTH_CHECK_S)
    tick(h)

    expect(retriesOf(h, p)).toBeGreaterThan(1)
    expectNeverStarted(h, p)
    expectPosts(h, [killFailureNotice(p, ordinaryAlertContent(p, { last: err }))])
  })
})

describe('tmux-unresponsive: the alert (SRJ-309; AC 26, AC 80)', () => {
  test('at agent-director’s defaults, with no onset: nothing at exactly the threshold, one alert 1 ms past it, none again however far the clock moves; retries go on and nothing is counted; B stays silent', async () => {
    const { h, p, b } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    expect(thresholdMs).toBe(adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT))
    const at = await refuse(h, p)

    await h.advance(at + thresholdMs - h.clock.now())
    expectPosts(h, [])

    await h.advance(1)
    expectPosts(h, [alert(p, thresholdMs)])
    const lines = [conditionAlertLine(p, h.clock.now() - at, thresholdMs)]
    expect(h.clock.now() - at).toBe(thresholdMs + 1)
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    const retries = retriesOf(h, p)
    await h.advance(10 * thresholdMs)
    expectPosts(h, [alert(p, thresholdMs)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
    expect(retriesOf(h, p)).toBeGreaterThan(retries)
    expect(h.controller.isArmed(p)).toBe(true)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expect(getFailureCount(p)).toBe(0)
    expect(h.capReached).toEqual([])
    expectNeverStarted(h, b)
  })

  test('AC 80: with the settings in effect read from agent-director’s file before the first refusal, the alert comes just past their threshold, not the defaults’, and its minutes are theirs', async () => {
    const { h, p } = build({ ...TICK_MODE, adSettings: { tmux: AC_80_TMUX } })
    expect(h.settings().tmux).toMatchObject(AC_80_TMUX)
    const thresholdMs = adAlertThresholdMsInEffect()
    expect(thresholdMs).toBe(adAlertThresholdMs(h.settings()))
    expect(thresholdMs).toBeLessThan(adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT))
    const at = await refuse(h, p)

    await h.advance(at + thresholdMs - h.clock.now())
    expectPosts(h, [])

    await h.advance(1)
    expectPosts(h, [alert(p, thresholdMs)])
    expect(noticeAndEndLines(h, p)).toEqual([conditionAlertLine(p, thresholdMs + 1, thresholdMs)])
  })

  test('a condition that ends before the threshold posts no alert and leaves nothing pending', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    await refuse(h, p)

    await h.advance(thresholdMs / 2)
    expect(h.tickEnd(p)).toBe('ended')

    expect(h.controller.isArmed(p)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    await h.advance(2 * thresholdMs)
    expectPosts(h, [])
  })
})

describe('tmux-unresponsive: the recovery (SRJ-310)', () => {
  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>, TmuxUnresponsiveEndReason]>([
    ['a health tick finding it live', async (h, key) => tick(h, [key]), TMUX_UNRESPONSIVE_END_TICK],
    ['a tmux-touching success', (_h, key) => wrapped(key, 'send-keys', RESOLVES), TMUX_UNRESPONSIVE_END_TMUX_VERB],
  ])('%s after the onset posts one recovery, the builder’s text; a later end posts nothing more', async (_what, end, reason) => {
    const { h, p, b } = build(TICK_MODE)
    const at = await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)
    expectPosts(h, [onset(p)])

    await end(h, p)
    expectPosts(h, [onset(p), recovery(p)])
    const lines = [conditionOnsetLine(p, 'a health tick', tickMs(h)), conditionEndedLine(p, reason), conditionRecoveryLine(p)]
    expect(h.clock.now() - at).toBe(tickMs(h))
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    expect(h.tickEnd(p)).toBe('not-holding')
    await wrapped(p, 'send-keys', RESOLVES)
    expectPosts(h, [onset(p), recovery(p)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
    expect(h.conditionEnds).toHaveLength(1)
    expectNeverStarted(h, b)
  })

  test('after the onset and the alert, the end posts one recovery', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)
    await h.advance(at + thresholdMs + 1 - h.clock.now())
    expectPosts(h, [onset(p), alert(p, thresholdMs)])

    expect(h.tickEnd(p)).toBe('ended-after-notice')

    expectPosts(h, [onset(p), alert(p, thresholdMs), recovery(p)])
    expect(noticeAndEndLines(h, p)).toEqual([
      conditionOnsetLine(p, 'a health tick', tickMs(h)),
      conditionAlertLine(p, thresholdMs + 1, thresholdMs),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TICK),
      conditionRecoveryLine(p),
    ])
  })

  test('an end after the alert alone (no onset) posts one recovery; a later end posts nothing more', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await h.advance(at + thresholdMs + 1 - h.clock.now())
    expectPosts(h, [alert(p, thresholdMs)])

    expect(h.tickEnd(p)).toBe('ended-after-notice')

    expectPosts(h, [alert(p, thresholdMs), recovery(p)])
    const lines = [conditionAlertLine(p, thresholdMs + 1, thresholdMs), conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TICK), conditionRecoveryLine(p)]
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    expect(h.tickEnd(p)).toBe('not-holding')
    expectPosts(h, [alert(p, thresholdMs), recovery(p)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
  })

  test('an end with neither the onset nor the alert posted answers `ended` and posts no recovery', async () => {
    const { h, p } = build(TICK_MODE)
    await refuse(h, p)

    expect(h.tickEnd(p)).toBe('ended')

    expectPosts(h, [])
    expect(noticeAndEndLines(h, p)).toEqual([conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TICK)])
  })

  test('a silent end after the alert alone posts no recovery and answers `ended-after-notice`', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await h.advance(at + thresholdMs + 1 - h.clock.now())

    expect(h.tmuxUnresponsive.end(p, TMUX_UNRESPONSIVE_END_TMUX_VERB, undefined, { silent: true })).toBe('ended-after-notice')

    expectPosts(h, [alert(p, thresholdMs)])
    expect(noticeAndEndLines(h, p)).toEqual([
      conditionAlertLine(p, thresholdMs + 1, thresholdMs),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TMUX_VERB),
      conditionSilentEndLine(p),
    ])
  })

  test('a silent end (a CONFLICT answer ends it) posts no recovery after the onset; the condition still ends once', async () => {
    const { h, p } = build(TICK_MODE)
    await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)

    expect(h.tmuxUnresponsive.end(p, TMUX_UNRESPONSIVE_END_TMUX_VERB, undefined, { silent: true })).toBe('ended-after-notice')

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionEndedLines(h, p)).toHaveLength(1)
    expect(h.conditionEnds).toEqual([{ key: p, reading: undefined, result: 'stopped' }])
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual([
      conditionOnsetLine(p, 'a health tick', tickMs(h)),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TMUX_VERB),
      conditionSilentEndLine(p),
    ])
  })

  test('a new episode posts its onset, alert and recovery again', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const episode = [onset(p), alert(p, thresholdMs), recovery(p)]
    const episodeLines = [
      conditionOnsetLine(p, 'a health tick', tickMs(h)),
      conditionAlertLine(p, thresholdMs + 1, thresholdMs),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TICK),
      conditionRecoveryLine(p),
    ]

    for (let n = 1; n <= 2; n++) {
      const at = await refuse(h, p)
      await h.advance(tickMs(h))
      tick(h)
      await h.advance(at + thresholdMs + 1 - h.clock.now())
      tick(h, [p])
      expectPosts(h, Array.from({ length: n }, () => episode).flat())
      expect(noticeAndEndLines(h, p)).toEqual(Array.from({ length: n }, () => episodeLines).flat())
    }
    expect(conditionStartedLines(h, p)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// The alert before the onset (SRJ-308, SRJ-309)
// ---------------------------------------------------------------------------

/** The line when the onset is held back because the episode's alert already posted: once per episode. */
function onsetHeldLine(key: string): string {
  return `${conditionLinePrefix(key)}onset not posted — its alert already posted`
}

/** The line when a stop of the persona's retry timer cancels its pending alert check. */
function alertCancelledLine(key: string, stopReason: string): string {
  return `${conditionLinePrefix(key)}alert check cancelled — its retry timer stopped: ${stopReason}`
}

/** The line when a later refusal arms a cancelled alert check again. */
function alertRearmedLine(key: string): string {
  return `${conditionLinePrefix(key)}alert check armed again — a new refusal armed its retry timer again`
}

describe('tmux-unresponsive: the alert before the onset (SRJ-308, SRJ-309)', () => {
  test('AC 80’s settings with the health check off: the alert, then the recovery, and no onset; the retries past the floor log the held onset once', async () => {
    const { h, p, b } = build({ action: 'scripted', adSettings: { tmux: AC_80_TMUX } })
    expect(h.config.health_check_interval).toBe(0)
    const thresholdMs = adAlertThresholdMsInEffect()
    expect(thresholdMs).toBe(adAlertThresholdMs(h.settings()))
    const at = await refuse(h, p)

    await h.advance(at + thresholdMs + 1 - h.clock.now())
    // Every retry so far fell short of the floor, so none could post the onset.
    const early = h.attempts.filter((attempt) => attempt.key === p)
    expect(early.length).toBeGreaterThan(0)
    for (const attempt of early) expect(attempt.at - at).toBeLessThan(FLOOR_MS)
    expectPosts(h, [alert(p, thresholdMs)])

    const firedAt = await nextRetry(h, p)
    expect(firedAt - at).toBeGreaterThanOrEqual(FLOOR_MS)
    await nextRetry(h, p)
    expectPosts(h, [alert(p, thresholdMs)])

    await wrapped(p, 'send-keys', RESOLVES)

    expectPosts(h, [alert(p, thresholdMs), recovery(p)])
    expect(noticeAndEndLines(h, p)).toEqual([
      conditionAlertLine(p, thresholdMs + 1, thresholdMs),
      onsetHeldLine(p),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TMUX_VERB),
      conditionRecoveryLine(p),
    ])
    expect(h.conditionEnds).toEqual([{ key: p, reading: undefined, result: 'stopped' }])
    expectNeverStarted(h, b)
  })

  test('with the health check on, the ticks after the alert post no onset and log the held onset once per episode', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const posts: RecoveryNotice[] = []
    const lines: string[] = []

    for (let n = 1; n <= 2; n++) {
      const at = await refuse(h, p)
      await h.advance(at + thresholdMs + 1 - h.clock.now())
      for (let t = 0; t < 3; t++) {
        await h.advance(tickMs(h))
        tick(h)
      }
      expect(h.tmuxUnresponsive.holds(p)).toBe(true)
      posts.push(alert(p, thresholdMs))
      lines.push(conditionAlertLine(p, thresholdMs + 1, thresholdMs), onsetHeldLine(p))
      expectPosts(h, posts)
      expect(noticeAndEndLines(h, p)).toEqual(lines)

      expect(h.tickEnd(p)).toBe('ended-after-notice')
      posts.push(recovery(p))
      lines.push(conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TICK), conditionRecoveryLine(p))
    }
    expectPosts(h, posts)
    expect(noticeAndEndLines(h, p)).toEqual(lines)
  })
})

// ---------------------------------------------------------------------------
// The alert and the retry timer's stops (SRJ-309)
// ---------------------------------------------------------------------------

/**
 * Run persona `key`'s next retry through the server's full-mode action, which
 * stops the timer before any agent-director call (after `prepare` sets up the
 * stop), then go back to the scripted action for every persona.
 */
async function stopAtNextRetry(h: RecoveryHarness, key: string, prepare: () => void): Promise<void> {
  prepare()
  // Only this persona's retry runs the full-mode action; any other persona's stays scripted.
  h.setAction((k, attempt) => (k === key ? h.fullModeAction : h.scriptedAction)(k, attempt))
  const calls = h.stub.callCount()
  await retryNow(h, key)
  expect(h.controller.isArmed(key)).toBe(false)
  expect(h.stub.callCount()).toBe(calls)
  h.setAction(h.scriptedAction)
}

/** A stop of persona `key`'s retry timer the harness drives, its reason, and whether that reason is terminal. */
interface TimerStop {
  readonly reason: string
  readonly terminal: boolean
  drive(h: RecoveryHarness, key: string): Promise<void>
}

const STOP_AT_CAP: TimerStop = {
  reason: UNAVAILABLE_RETRY_STOP_CAPPED,
  terminal: false,
  // Counted launch failures up to the restart cap: the next retry stops at it.
  drive: (h, key) =>
    stopAtNextRetry(h, key, () => {
      while (!isAtCap(key, RESTART_FAILURE_CAP)) recordFailure(key)
    }),
}

const STOP_NOT_UP: TimerStop = {
  reason: UNAVAILABLE_RETRY_STOP_NOT_UP,
  terminal: false,
  drive: (h, key) => stopAtNextRetry(h, key, () => h.setUp(key, false)),
}

const STOP_NOT_APPLIED: TimerStop = {
  reason: UNAVAILABLE_RETRY_STOP_NOT_APPLIED,
  terminal: true,
  drive: (h, key) => stopAtNextRetry(h, key, () => h.remove(key)),
}

const STOP_TORN_DOWN: TimerStop = {
  reason: UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  terminal: true,
  drive: async (h, key) => h.teardown(key),
}

const TIMER_STOPS: readonly [string, TimerStop][] = [
  ['the restart cap', STOP_AT_CAP],
  ['the persona not up', STOP_NOT_UP],
  ['the persona not in the applied configuration', STOP_NOT_APPLIED],
  ['a teardown', STOP_TORN_DOWN],
]

// The health check is on in these cases and no tick runs, so no onset posts:
// the alert is the only notice the stops can touch.
describe('tmux-unresponsive: the alert and the retry timer’s stops (SRJ-309)', () => {
  test.each(TIMER_STOPS)('each stop’s terminal class is the one src declares: %s', (_what, stop) => {
    expect(UNAVAILABLE_RETRY_TERMINAL_STOPS.has(stop.reason)).toBe(stop.terminal)
  })

  test.each(TIMER_STOPS)('a stop of P’s retry timer by %s while the condition holds cancels its pending alert check with one line: nothing posts at the threshold; B’s alert still posts', async (_what, stop) => {
    const { h, p, b } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    expect(await refuse(h, b)).toBe(at)

    await stop.drive(h, p)

    expect(h.clock.now() - at).toBeLessThan(thresholdMs)
    expect(h.controller.isArmed(p)).toBe(false)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expect(noticeAndEndLines(h, p)).toEqual([alertCancelledLine(p, stop.reason)])

    await h.advance(at + 2 * thresholdMs - h.clock.now())

    expectPosts(h, [alert(b, thresholdMs)])
    expect(noticeAndEndLines(h, p)).toEqual([alertCancelledLine(p, stop.reason)])
    expect(noticeAndEndLines(h, b)).toEqual([conditionAlertLine(b, thresholdMs + 1, thresholdMs)])
    expect(h.tmuxUnresponsive.holds(b)).toBe(true)
  })

  test.each(TIMER_STOPS)('an alert already posted stays after a stop by %s: no cancel line and no retraction post', async (_what, stop) => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await h.advance(at + thresholdMs + 1 - h.clock.now())
    expectPosts(h, [alert(p, thresholdMs)])

    await stop.drive(h, p)
    await h.advance(2 * thresholdMs)

    expect(h.controller.isArmed(p)).toBe(false)
    expectPosts(h, [alert(p, thresholdMs)])
    expect(noticeAndEndLines(h, p)).toEqual([conditionAlertLine(p, thresholdMs + 1, thresholdMs)])
  })

  test.each<[string, string, TimerStop, boolean]>([
    ['the restart cap', 'before the threshold', STOP_AT_CAP, false],
    ['the restart cap', 'after the threshold', STOP_AT_CAP, true],
    ['the persona not up', 'before the threshold', STOP_NOT_UP, false],
  ])('after a stop by %s, a later refusal %s arms the alert check again from the first refusal, with one line; it posts once the condition has lasted past the threshold', async (_what, _when, stop, pastThreshold) => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await stop.drive(h, p)

    await h.advance(at + (pastThreshold ? thresholdMs + halfFirstWaitMs() : thresholdMs / 2) - h.clock.now())
    expectPosts(h, [])
    const laterAt = await refuse(h, p)

    expect(h.controller.isArmed(p)).toBe(true)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expect(noticeAndEndLines(h, p)).toEqual([alertCancelledLine(p, stop.reason), alertRearmedLine(p)])

    let lastedMs: number
    if (pastThreshold) {
      // Already past it: the check fires at the clock's next step (a 0 ms wait is 1 ms on the fake clock).
      await h.advance(1)
      lastedMs = laterAt + 1 - at
    } else {
      await h.advance(at + thresholdMs - h.clock.now())
      expectPosts(h, [])
      await h.advance(1)
      lastedMs = thresholdMs + 1
    }
    expectPosts(h, [alert(p, thresholdMs)])
    const lines = [alertCancelledLine(p, stop.reason), alertRearmedLine(p), conditionAlertLine(p, lastedMs, thresholdMs)]
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    // A further refusal in the episode arms nothing more.
    await h.advance(halfFirstWaitMs())
    await refuse(h, p)
    await h.advance(thresholdMs)
    expectPosts(h, [alert(p, thresholdMs)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
  })

  test.each<[string, TimerStop]>([
    ['a teardown (teardown(key))', STOP_TORN_DOWN],
    ['the persona not in the applied configuration', STOP_NOT_APPLIED],
  ])('after a terminal stop by %s, a later refusal arms the retry timer but never the alert check', async (_what, stop) => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await stop.drive(h, p)

    await h.advance(halfFirstWaitMs())
    await refuse(h, p)

    expect(h.controller.isArmed(p)).toBe(true)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    await h.advance(at + 2 * thresholdMs - h.clock.now())

    expectPosts(h, [])
    expect(noticeAndEndLines(h, p)).toEqual([alertCancelledLine(p, stop.reason)])
  })
})

// ---------------------------------------------------------------------------
// The onset and the retry timer's stops (SRJ-305, SRJ-308; AC 28)
// ---------------------------------------------------------------------------

/** The line when a stop of the persona's retry timer holds its onset back: once per episode. */
function onsetStoppedLine(key: string): string {
  return `${conditionLinePrefix(key)}onset not posted — its retry timer stopped and no refusal has re-armed it`
}

/** The health tick's line when it arms the retry timer of a persona held off on `tmux-unavailable` (`armMissingRetryTimer`). */
function tickArmingLine(key: string): string {
  return `[slack] health-check: persona=${key} has its tmux-unavailable outage raised with no retry timer — arming one`
}

/** The `tmux-unavailable` outage's onset for persona `key`. */
function tmuxUnavailableOnset(key: string): RecoveryNotice {
  return { key, text: ONSET_TEMPLATES['tmux-unavailable']() }
}

/**
 * Raise persona `key`'s `tmux-unavailable` outage the way any call outside
 * every attempt does: a `status` answering ENVIRONMENT (`ErrTmuxNotAvailable`).
 * Its trigger arms the persona's retry timer with the ENVIRONMENT cause when
 * none is armed (b.jg5 SRJ-311): an arm that is not a refusal of the
 * condition.
 */
async function raiseTmuxUnavailable(key: string): Promise<void> {
  await wrapped(key, 'status', { rejects: () => errTmuxNotAvailable(undefined, 'status') })
  expect([...getOutageFlags(key)]).toEqual(['tmux-unavailable'])
}

/**
 * One health tick body (`src/health-check.ts`, run once through its tick seam
 * `_runHealthCheckTickForTest`, with no interval) over persona `key` alone,
 * which it reads `dead`, with the deps the cases need bound as `main()` binds
 * them: the retry deps over the harness's controller (`isRetryArmed` is its
 * `isArmed`; `armRetryTimer` arms it with
 * `UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT`), so a persona held off on its raised
 * `tmux-unavailable` outage with no timer armed gets one
 * (`armMissingRetryTimer`); the restart cap over `isAtCap`; the tick-end hook
 * the condition's onset check (`tickOnset`); and the tick's start read from
 * the harness clock. Resolves, once the body and its tick-end hook have run,
 * with the keys the tick scheduled a restart for.
 */
async function healthTick(h: RecoveryHarness, key: string): Promise<string[]> {
  const scheduled: string[] = []
  let bodies = 0
  let hookEnds = 0
  const deps: HealthCheckDeps = {
    getPersonas: () => ({ [key]: personaOf(h, key).working_directory }),
    isShuttingDown: () => false,
    now: () => {
      bodies++
      return h.clock.now()
    },
    isSessionAlive: async () => LIVENESS_READING_DEAD,
    isSessionConnected: () => false,
    hasSessionStream: () => false,
    isRestartPendingOrActive: () => false,
    isLaunchInFlight: () => false,
    isAtCap: (k) => isAtCap(k, RESTART_FAILURE_CAP),
    statRoute: async () => true,
    scheduleRestart: (k) => void scheduled.push(k),
    isRetryArmed: (k) => h.controller.isArmed(k),
    armRetryTimer: (k) => {
      h.controller.arm(k, { kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT })
    },
    onTickEnd: (tickStartedAt) => {
      h.tickOnset(tickStartedAt)
      hookEnds++
    },
  }
  initHealthCheck(deps)
  try {
    await _runHealthCheckTickForTest()
  } finally {
    _resetHealthCheckState()
  }
  expect(bodies).toBe(1)
  expect(hookEnds).toBe(1)
  return scheduled
}

describe('tmux-unresponsive: the onset and the retry timer’s stops (SRJ-305, SRJ-308; AC 28)', () => {
  test.each<[string, TimerStop]>([
    ['the restart cap', STOP_AT_CAP],
    ['the persona not up', STOP_NOT_UP],
  ])('with the health check on, while P’s retry timer is stopped by %s the ticks post no onset (one line); after a later refusal re-arms the timer the next tick posts it, once; B’s onset is untouched', async (_what, stop) => {
    const { h, p, b } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    expect(await refuse(h, b)).toBe(at)
    await stop.drive(h, p)

    for (let n = 0; n < 3; n++) {
      await h.advance(tickMs(h))
      tick(h)
    }

    expect(h.tmuxUnresponsive.holds(p)).toBe(true)
    expect(h.controller.isArmed(p)).toBe(false)
    expectPosts(h, [onset(b)])
    expect(noticeAndEndLines(h, p)).toEqual([alertCancelledLine(p, stop.reason), onsetStoppedLine(p)])

    await refuse(h, p)
    expect(h.controller.isArmed(p)).toBe(true)
    await h.advance(tickMs(h))
    const tickAt = h.clock.now()
    tick(h)

    expectPosts(h, [onset(b), onset(p)])
    const lines = [
      alertCancelledLine(p, stop.reason),
      onsetStoppedLine(p),
      alertRearmedLine(p),
      conditionOnsetLine(p, 'a health tick', tickAt - at),
    ]
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    await h.advance(tickMs(h))
    tick(h)
    expect(h.clock.now() - at).toBeLessThan(thresholdMs)
    expectPosts(h, [onset(b), onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
  })

  test.each<[string, TimerStop]>([
    ['a removal from the applied configuration', STOP_NOT_APPLIED],
    ['a teardown’s submit (teardown(key), the condition kept)', STOP_TORN_DOWN],
  ])('with the health check on, after P’s retry timer is stopped by %s no tick posts its onset, not even after a later refusal arms the timer again', async (_what, stop) => {
    const { h, p, b } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    expect(await refuse(h, b)).toBe(at)
    await stop.drive(h, p)

    await h.advance(tickMs(h))
    tick(h)
    expectPosts(h, [onset(b)])
    const lines = [alertCancelledLine(p, stop.reason), onsetStoppedLine(p)]
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    // A refusal landing after it (a launch still in flight) arms the timer again.
    await refuse(h, p)
    expect(h.controller.isArmed(p)).toBe(true)
    for (let n = 0; n < 3; n++) {
      await h.advance(tickMs(h))
      tick(h)
    }

    expect(h.clock.now() - at).toBeLessThan(thresholdMs)
    expect(h.tmuxUnresponsive.holds(p)).toBe(true)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expectPosts(h, [onset(b)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
  })

  test('a later non-terminal stop never weakens a teardown’s: after the teardown, a refusal, a not-up stop and another refusal, no tick posts the onset', async () => {
    const { h, p } = build(TICK_MODE)
    const at = await refuse(h, p)
    await STOP_TORN_DOWN.drive(h, p)

    await h.advance(halfFirstWaitMs())
    await refuse(h, p)
    await STOP_NOT_UP.drive(h, p)
    expect(h.stops.filter((s) => s.key === p).map((s) => s.reason)).toEqual([UNAVAILABLE_RETRY_STOP_TORN_DOWN, UNAVAILABLE_RETRY_STOP_NOT_UP])
    await refuse(h, p)
    expect(h.controller.isArmed(p)).toBe(true)

    for (let n = 0; n < 3; n++) {
      await h.advance(tickMs(h))
      tick(h)
    }

    expect(h.clock.now() - at).toBeLessThan(adAlertThresholdMsInEffect())
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expectPosts(h, [])
    expect(noticeAndEndLines(h, p)).toEqual([alertCancelledLine(p, UNAVAILABLE_RETRY_STOP_TORN_DOWN), onsetStoppedLine(p)])
  })

  test('a teardown after a not-up stop that already cancelled P’s alert check withdraws its re-arm: a later refusal arms the retry timer but neither the check nor the onset, and past the threshold nothing posts', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await STOP_NOT_UP.drive(h, p)
    await STOP_TORN_DOWN.drive(h, p)

    await h.advance(halfFirstWaitMs())
    await refuse(h, p)
    expect(h.controller.isArmed(p)).toBe(true)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)

    await h.advance(at + 2 * thresholdMs - h.clock.now())
    tick(h)

    expect(h.tmuxUnresponsive.holds(p)).toBe(true)
    expectPosts(h, [])
    // No `alert check armed again` line: the not-up cancel, then the held onset.
    expect(noticeAndEndLines(h, p)).toEqual([alertCancelledLine(p, UNAVAILABLE_RETRY_STOP_NOT_UP), onsetStoppedLine(p)])
  })

  test('with the health check on, the shutdown’s stop of P’s retry timer leaves no onset to post: no later tick posts it, and a later refusal opens nothing', async () => {
    const { h, p } = build(TICK_MODE)
    await refuse(h, p)

    h.shutdown()

    expect(h.stops).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_SHUTDOWN }])
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.tmuxUnresponsive.start(p, 'spawn', errTmuxUnresponsive('spawn'))).toBe('closed')
    for (let n = 0; n < 3; n++) {
      await h.advance(tickMs(h))
      tick(h)
    }
    expectPosts(h, [])
    expect(noticeAndEndLines(h, p)).toEqual([alertCancelledLine(p, UNAVAILABLE_RETRY_STOP_SHUTDOWN)])
    expect(h.clock.pendingCount()).toBe(0)
  })

  test('the health tick’s own arm of P’s stopped timer (armMissingRetryTimer, its tmux-unavailable outage raised) is not a refusal: that tick and later ones post no onset; a later refusal does, at the next tick', async () => {
    const { h, p, b } = build({ ...TICK_MODE, alertThresholdMs: false })
    const at = await refuse(h, p)
    await raiseTmuxUnavailable(p)
    await STOP_NOT_UP.drive(h, p)
    // Up again, so the tick's work list holds P (a not-up persona is left out of it).
    h.setUp(p, true)

    await h.advance(tickMs(h))
    expect(await healthTick(h, p)).toEqual([])

    expect(h.errors.filter((line) => line === tickArmingLine(p))).toHaveLength(1)
    expect(h.controller.view(p)).toMatchObject({ phase: 'waiting', causes: [UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT] })
    expect(h.episodeNotices).toEqual([])
    // No alert check: the stop is recorded with none pending.
    expect(noticeAndEndLines(h, p)).toEqual([onsetStoppedLine(p)])

    // The tick-armed timer's retry runs, and a later tick finds it armed.
    await nextRetry(h, p)
    await h.advance(tickMs(h))
    expect(await healthTick(h, p)).toEqual([])
    expect(h.errors.filter((line) => line === tickArmingLine(p))).toHaveLength(1)
    expect(h.episodeNotices).toEqual([])
    expect(noticeAndEndLines(h, p)).toEqual([onsetStoppedLine(p)])

    await refuse(h, p)
    await h.advance(tickMs(h))
    const tickAt = h.clock.now()
    expect(await healthTick(h, p)).toEqual([])

    expect(h.episodeNotices).toEqual([onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual([onsetStoppedLine(p), conditionOnsetLine(p, 'a health tick', tickAt - at)])
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(p)])
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expectNeverStarted(h, b)
  })

  test('with the health check off, a retry past the floor fired by a timer armed again after a not-up stop with no refusal (an ENVIRONMENT trigger) posts no onset; after a later refusal the next retry posts it', async () => {
    const { h, p, b } = build(RETRY_MODE)
    const at = await refuse(h, p)
    await STOP_NOT_UP.drive(h, p)
    h.setUp(p, true)

    await raiseTmuxUnavailable(p)
    expect(h.controller.view(p)).toMatchObject({ phase: 'waiting', causes: [UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT] })
    while (h.controller.view(p)!.dueAt! - at < FLOOR_MS) await nextRetry(h, p)
    const firedAt = await nextRetry(h, p)
    expect(firedAt - at).toBeGreaterThanOrEqual(FLOOR_MS)
    await nextRetry(h, p)

    expect(h.tmuxUnresponsive.holds(p)).toBe(true)
    expect(h.episodeNotices).toEqual([])
    expect(noticeAndEndLines(h, p)).toEqual([onsetStoppedLine(p)])

    await refuse(h, p)
    const onsetAt = await nextRetry(h, p)

    expect(h.episodeNotices).toEqual([onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual([onsetStoppedLine(p), conditionOnsetLine(p, 'a retry', onsetAt - at)])
    expect(h.outageNotices).toEqual([tmuxUnavailableOnset(p)])
    expectNeverStarted(h, b)
  })

  test('the stop mark ends with its episode: after a not-up stop and the condition’s end, a new episode’s first tick posts its onset', async () => {
    const { h, p } = build(TICK_MODE)
    await refuse(h, p)
    await STOP_NOT_UP.drive(h, p)
    await h.advance(tickMs(h))
    tick(h)
    expect(h.tickEnd(p)).toBe('ended')
    expectPosts(h, [])

    await h.advance(halfFirstWaitMs())
    const secondAt = await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)

    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual([
      alertCancelledLine(p, UNAVAILABLE_RETRY_STOP_NOT_UP),
      onsetStoppedLine(p),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TICK),
      conditionOnsetLine(p, 'a health tick', h.clock.now() - secondAt),
    ])
  })
})

describe('tmux-unresponsive: teardown and shutdown post nothing more', () => {
  test.each<[string, (h: RecoveryHarness, key: string) => void]>([
    ['the teardown’s submit (retry timer stopped, alert check cancelled, the condition kept), then its turn’s forget', (h, key) => {
      h.teardown(key)
      expect(h.tmuxUnresponsive.holds(key)).toBe(true)
      expect(h.clock.pendingCount()).toBe(0)
      h.episodes.forget(key)
    }],
    ['the teardown’s forget alone', (h, key) => h.episodes.forget(key)],
  ])('%s: no alert, no recovery, no condition-end call', async (_what, tearDown) => {
    const { h, p, b } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)
    expectPosts(h, [onset(p)])

    tearDown(h, p)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    await h.advance(2 * thresholdMs)
    tick(h, [p])
    expectPosts(h, [onset(p)])
    expect(h.conditionEnds).toEqual([])
    expectNeverStarted(h, b)
  })

  test('shutdown drops P’s condition with no recovery and nothing pending; B’s launch still in flight, refused after it, opens no condition and arms no alert check', async () => {
    const { h, p, b } = build(TICK_MODE)
    await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)
    const hold = holdSpawns(h.stub.client)
    const launch = h.launch(b)
    await hold.entered(personaInstanceId(b))

    h.shutdown()

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    hold.fail(personaInstanceId(b), errTmuxUnresponsive('spawn'))
    await launch
    expectNeverStarted(h, b)
    expect(h.tmuxUnresponsive.start(b, 'spawn', errTmuxUnresponsive('spawn'))).toBe('closed')
    expect(h.clock.pendingCount()).toBe(0)

    await h.advance(2 * adAlertThresholdMsInEffect())
    tick(h, [p, b])
    expectPosts(h, [onset(p)])
    expect(h.conditionEnds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A CONFLICT ends it silently (SRJ-310, SRJ-502)
// ---------------------------------------------------------------------------

/**
 * Settings whose alert threshold in effect falls after the retry that
 * follows the onset's retry: `starting_session_seconds` twice the retry
 * timer's ceiling.
 */
const LATE_ALERT: RecoveryHarnessOptions = { adSettings: { tmux: { starting_session_seconds: BigInt(2 * UNAVAILABLE_RETRY_CEILING_S) } } }

/** Whether persona `key`'s condition still held at each post of `text` to it, recorded as the post lands. */
function holdsAtPosts(h: RecoveryHarness, key: string, text: string): boolean[] {
  const held: boolean[] = []
  const push = h.episodeNotices.push.bind(h.episodeNotices)
  h.episodeNotices.push = (...notices: RecoveryNotice[]): number => {
    for (const notice of notices) if (notice.key === key && notice.text === text) held.push(h.tmuxUnresponsive.holds(key))
    return push(...notices)
  }
  return held
}

describe('tmux-unresponsive: a CONFLICT ends it silently (SRJ-310, SRJ-502)', () => {
  test.each<[string, boolean]>([
    ['after its onset', true],
    ['before any onset', false],
  ])('%s, a later retry’s launch answering CONFLICT ends P’s condition before the one CONFLICT post, with no recovery post; its alert check is cancelled, so past the threshold nothing more posts', async (_when, withOnset) => {
    const { h, p, b } = build(LATE_ALERT)
    expect(h.config.health_check_interval).toBe(0)
    const thresholdMs = adAlertThresholdMsInEffect()
    // Every row read finds P's row missing, so each retry launches, and each launch's spawn is refused.
    h.script({ statusResult: cannedStatusResult({ state: 'missing' }), spawnError: errTmuxUnresponsive('spawn') })
    const at = h.clock.now()
    await h.launch(p)
    expectHolds(h, p, 'spawn', at)

    const lines: string[] = []
    if (withOnset) {
      let firedAt = at
      while (firedAt - at < FLOOR_MS) firedAt = await retryNow(h, p)
      expectPosts(h, [onset(p)])
      lines.push(conditionOnsetLine(p, 'a retry', firedAt - at))
    }
    expect(noticeAndEndLines(h, p)).toEqual(lines)
    const err = conflictForPersona(p)
    h.script({ spawnError: err })
    const held = holdsAtPosts(h, p, conflictNoticeForPersona(p, err).text)

    const conflictAt = await retryNow(h, p)

    expect(conflictAt - at).toBeLessThan(thresholdMs)
    expect(withOnset || conflictAt - at < FLOOR_MS).toBe(true)
    expect(h.latch.isLatched(p)).toBe(true)
    expect(held).toEqual([false])
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    const posts = [...(withOnset ? [onset(p)] : []), conflictNoticeForPersona(p, err)]
    expectPosts(h, posts)
    // The latch's timer stop cancels the alert check, then its silent end ends the condition.
    lines.push(
      alertCancelledLine(p, UNAVAILABLE_RETRY_STOP_LATCHED),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_LATCHED),
      ...(withOnset ? [conditionSilentEndLine(p)] : []),
    )
    expect(noticeAndEndLines(h, p)).toEqual(lines)
    expect(conditionEndedLines(h, p)).toHaveLength(1)
    // The end still reaches the condition-end entry once, which finds the timer already stopped by the latch.
    expect(h.conditionEnds).toEqual([{ key: p, reading: undefined, result: 'not-armed' }])
    expect(h.stops).toEqual([{ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED }])
    expect(h.clock.pendingCount()).toBe(0)

    await h.advance(at + 2 * thresholdMs - h.clock.now())
    expectPosts(h, posts)
    expect(noticeAndEndLines(h, p)).toEqual(lines)
    expect(h.notices).toEqual([])
    expect(getFailureCount(p)).toBe(0)
    expectNeverStarted(h, b)
  })
})

// ---------------------------------------------------------------------------
// A lost message reads the holds query (b.jg5 SRJ-1011, SRJ-307; AC 68),
// through the recovery harness's driver: the real routing's no-session
// branch, bound as `main()` binds it, both settings 0
// ---------------------------------------------------------------------------

describe('tmux-unresponsive: a lost message reads the holds query (SRJ-1011, SRJ-307)', () => {
  test('a launch’s spawn refused ErrTmuxUnresponsive starts P’s condition: a message lost while it holds reports not answering, with no restart and no call, and B’s reports its own state; once a tmux-touching success ends it, the next lost message reports auto-restart disabled', async () => {
    const { h, p, b } = build()
    await refuse(h, p)
    // The condition alone: no outage flag is raised beside it.
    expect(getOutageFlags(p).size).toBe(0)

    await expectLostMessageReports(h, p, 'not-answering')
    await expectLostMessageReports(h, b, 'auto-restart-disabled')
    expect(h.tmuxUnresponsive.holds(p)).toBe(true)

    await wrapped(p, 'read-pane', RESOLVES)
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.conditionEnds).toEqual([{ key: p, reading: undefined, result: 'stopped' }])

    await expectLostMessageReports(h, p, 'auto-restart-disabled')
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })
})
