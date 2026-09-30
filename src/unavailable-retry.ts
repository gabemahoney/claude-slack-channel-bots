/**
 * unavailable-retry.ts — The per-persona UNAVAILABLE retry timer (b.jg5
 * SRJ-301 code line, SRJ-302, SRJ-303, SRJ-304, SRJ-305, SRJ-306).
 *
 * `createUnavailableRetryController(deps)` builds a controller that keeps at
 * most one retry timer per persona key:
 *
 * - `arm(key, cause)`: when the persona has no timer, its first retry is due
 *   `UNAVAILABLE_RETRY_BASE_S` after now, in full mode. When it already has
 *   one, waiting or running its retry, the due time and the wait count stay
 *   as they are and the cause is recorded; a timer in pending-only mode is
 *   promoted to full mode. A missing cause is recorded as `unnamed`.
 * - `armPendingOnly(key)`: the same, for a covered `pending` row, in
 *   pending-only mode: it records the `pending-row` cause and the last row
 *   read `pending`, and leaves a timer already in full mode in full mode.
 * - At the due time the injected retry action runs once for the persona. An
 *   `again` answer re-arms the timer at the next wait of the one sequence,
 *   measured from the end of the run: 30, 60, 120, 240, 300, 300 … s, from
 *   `doublingBackoffDelay` over `UNAVAILABLE_RETRY_BASE_S` and
 *   `UNAVAILABLE_RETRY_CEILING_S`, with no attempt cap (so the retries fall at
 *   30, 90, 210, 450 and 750 s after the arm, then every 300 s). A `stop`
 *   answer stops the timer. An action that throws or rejects, or answers
 *   anything else, counts as `again`.
 * - An `again` answer is an outcome of the retry, not a cause: its optional
 *   `reason` (a short CSCB-written label) is only named in the re-armed line
 *   and is never recorded. Causes are recorded only through `arm`. The
 *   re-armed line names the again-reason, else the action's failure (a throw,
 *   a rejection, or no answer), else the last cause armed during the run,
 *   else `no cause given`.
 * - If the clock fails while a timer is being set, the persona is forgotten
 *   rather than left armed with no timer: a failed re-arm logs one
 *   `retry run failed` line, a failed first arm logs one `arm failed … — not
 *   armed` line and returns (`arm` never throws), and either way the next
 *   `arm` starts again at the first wait.
 * - Two runs never overlap for one persona: a timer that falls due while an
 *   earlier run for the same key is still in flight (a run that outlived a
 *   `stop` and a new `arm`) waits for that run to settle first.
 * - `stop(key, reason)` clears the pending timer and forgets the persona, so
 *   the next `arm` starts again at the first wait. A run in flight when it is
 *   stopped finishes, but its answer is dropped: it neither re-arms nor stops
 *   a later timer. `stopAll(reason)` stops every persona. `close(reason)`,
 *   the server's shutdown, stops every persona and refuses every later `arm`
 *   (one `not armed` line each), so no timer is pending after it.
 * - `conditionEnded(key, condition)`: the end of `tmux-unresponsive` or the
 *   clearing of `tmux-unavailable` stops the timer, unless its last row read
 *   was `pending` or a `kill-failed` cause is recorded (b.jg5 SRJ-306); then
 *   it is kept with its due time and one kept line says why. While the
 *   persona's retry is running, the end is recorded (`deferred`, no line)
 *   and the same rule is applied once the run's answer has set the last row
 *   read and the mode, before the re-arm; a `stop` answer makes it moot,
 *   but a pending-only stop that yields to a full-mode cause counts as
 *   `again` here, and when the rule stops the timer the yielded stop's
 *   hand-off runs after that stop. It has no caller yet: the conditions' owners call it when they end. The
 *   exceptions hold against this entry only; every other stop is unaffected.
 * - `view(key)`, `isArmed(key)` and `armedKeys()` are read-only queries;
 *   `whenRunSettled(key)` awaits the persona's in-flight run, with its re-arm
 *   or stop, and a stop's hand-off.
 *
 * Modes (b.jg5 SRJ-301, SRJ-303, SRJ-305). Each timer runs in full mode or
 * pending-only mode; the action is told the mode at each retry. A timer
 * enters pending-only mode through `armPendingOnly`, or when a full-mode
 * retry's answer sets `switchToPendingOnly` (a launch that succeeded), with
 * its wait count carrying on; that switch is not taken when `arm` recorded a
 * cause during the run (another cause armed it too) or a `kill-failed` cause
 * is recorded. It leaves pending-only mode only when `arm` records a cause,
 * which keeps its due time. The last row read is the `row` of the latest
 * `again` answer (`pending` for a launch that succeeded, the launch's row,
 * switched or not), else `pending` when `armPendingOnly` landed during that
 * run, else cleared by the `again`; a failed retry keeps it, and
 * `armPendingOnly` sets it `pending`. A `stop` answer may carry a hand-off,
 * run once, awaited, after the stop. A pending-only retry's stop that rests
 * on its row read (`yieldsToFullMode`) is not taken when `arm` recorded a
 * cause during the run: it counts as `again` in full mode, with no hand-off
 * (as `mayTakeSwitch` keeps a full-mode cause from being dropped).
 *
 * UNAVAILABLE is never a failure here: the restart module's per-persona
 * failure counter and cap latch (`backoff.ts`) are neither read nor written,
 * and nothing gives a persona up. Only the stateless `doublingBackoffDelay`
 * is imported. The timer runs whatever the persona's restart delay and
 * health-check interval are, 0 included: this module reads neither.
 *
 * Each controller keeps its own per-persona entries, and no persona state is
 * kept at module scope, so nothing spans two personas or two controllers.
 * Nothing is armed, read or logged at import or at creation. The clock and
 * timers, the log sink and the retry action are injected; the real clock is
 * the default.
 *
 * What arms a timer (b.jg5 SRJ-301). A launch attempt (a run of a persona's
 * collision ladder, whoever starts it) and a recovery attempt (a run of its
 * restart work) run through `runInAttempt(key, kind, fn)`, an attempt context
 * carried by `AsyncLocalStorage` across the attempt's awaits and timers; it
 * holds the running attempts only. `isInsideAttempt(key)` reads it; an
 * attempt for another persona, or a call outside every attempt (the health
 * tick, the permission poller, the JSONL safeguard, the start sweep, a
 * persona teardown), is not inside one.
 * `reportAttemptError(key, value, verb, sink)` is the one reporting step,
 * which the agent-director wrappers and the liveness adapter reach through
 * `src/outage-state.ts`: inside an attempt for `key`, the arming predicate
 * `unavailableRetryCauseFor(value, verb)` decides the cause (UNAVAILABLE from
 * any verb, `ErrTmuxKillFailed` told apart by name; any other `status`, `get`
 * or `list` error but `ErrSpawnNotFound`, CONFIG and UNUSABLE NAME), the
 * trigger sink (`UnavailableRetryTriggerSink`, which the controller is) arms
 * the persona's timer with it, and the innermost attempt records the error as
 * its last, with whether it armed. A trigger while armed keeps the due time
 * (`arm` above).
 *
 * The retry action (b.jg5 SRJ-303, SRJ-305). The server's action is
 * `createFullModeRetryAction(deps)`, for both modes: at each retry, before
 * any call, the shutdown flag, the applied-persona lookup, the not-up gate
 * (the relaunch gate) and the at-cap check each stop the timer with their
 * reason (`UNAVAILABLE_RETRY_STOP_*`).
 *
 * In full mode the restart module's retry entry then reruns the restart
 * path's decision, with the one in-flight predicate as its first step, and
 * its outcome decides: a persona already connected with its stream, or
 * reconnected, has nothing left to recover (stop); capped, not up, a declined
 * launch or shutting down stop too; a launch in flight, a refused launch, a
 * counted launch failure below the cap, a deferred reconnect (on a `pending`
 * row, recorded as the last row read) and a successful launch retry again at
 * the next wait. A successful launch records the row read `pending` and
 * switches the timer to pending-only mode, the wait count carrying on,
 * unless another cause armed during that retry or a `kill-failed` cause is
 * recorded. Each `again` carries its again-reason
 * (the labels under "Again-reasons" below: `launch-in-flight`,
 * `launch-failed`, `reconnect-deferred`, `pending-deferred`, `launched`,
 * `restart-not-initialised`) for the re-armed line, except a refused launch,
 * whose line names the UNAVAILABLE cause that armed during the run. The
 * in-flight skip is still a refusal for the schedule: the wait doubles. A
 * retry never counts toward the restart cap itself: only a launch failure
 * the restart work counts does.
 *
 * In pending-only mode, a retry that finds the in-flight predicate true (a
 * throw counts as in flight) makes no agent-director call and is a refusal
 * (`launch-in-flight`, the row kept `pending`). Otherwise it reads the
 * persona's row (`readRow`, one `status` call) inside a recovery attempt for
 * the persona, and the state decides:
 * still `pending`, a refusal (`row-pending`) with no other call; live out of
 * `pending`, a stop with no other call; `ended`, `missing` or no row, a stop
 * that hands the persona to one run of the restart module's retry entry once
 * the timer is stopped, so a refused launch in that run arms a fresh timer.
 * Either stop yields to a cause `arm` recorded during the retry (another
 * attempt for the persona met UNAVAILABLE meanwhile): the timer stays armed
 * in full mode and re-arms at the next wait, naming that cause, and the
 * hand-off is not run.
 * A read error is a `status` error inside the attempt: it arms the timer
 * with its cause, which promotes it to full mode, and the retry counts as
 * `again`.
 *
 * Log lines (`[slack] unavailable-retry: persona=<key> …`), one each for
 * armed (`armed in pending-only mode …` in that mode), retry (`retry <n>
 * (pending-only) — reading its row` in that mode), re-armed (`retry <n>[
 * (pending-only)]: <reason> — re-armed[ in <mode> mode], next retry in <s>
 * s`, the mode named when the retry changed it), promoted (`promoted to full
 * mode (<cause>) — its due time is kept`), stopped (`stopped[ (pending-only[,
 * row <state>])] — <reason>`), kept (`kept — <condition ended>, but <why>`),
 * `hand-off after the stop failed`, `retry run failed` (the clock failed at
 * a re-arm), `arm failed … — not armed` (the clock failed at the first arm)
 * and `not armed (<cause>) — …` (an arm after `close`), go to the injected
 * log only; nothing is posted to Slack. A cause's thrown value and a failed
 * action reach a line only through `describeThrownValue` (its message
 * redacted by `redactSlackLogText`). A cause kind, an again-reason and a row
 * state are labels (anything else is logged as `unnamed`) and a stop reason
 * is CSCB-written text; none carries agent-director failure text.
 *
 * SPDX-License-Identifier: MIT
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  classifyAdError,
  hasAdErrorName,
} from './ad-error-class.ts'
import { ERR_SPAWN_NOT_FOUND_NAME, ERR_TMUX_KILL_FAILED_NAME } from './agent-director-errors.ts'
import { doublingBackoffDelay } from './backoff.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import { SYSTEM_PERSONA_CONNECTION_CLOCK, type PersonaConnectionClock } from './persona-connections.ts'
import type { RestartRetryOutcome } from './restart.ts'

// ---------------------------------------------------------------------------
// SRJ-302 constants
// ---------------------------------------------------------------------------

/** First retry wait after the arming outcome, in seconds (b.jg5 SRJ-302). */
export const UNAVAILABLE_RETRY_BASE_S = 30

/** Retry wait ceiling, in seconds (b.jg5 SRJ-302). There is no attempt cap. */
export const UNAVAILABLE_RETRY_CEILING_S = 300

/** The cause of an UNAVAILABLE outcome from any verb in an attempt (b.jg5 SRJ-301). */
export const UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE = 'unavailable'

/** The cause of an `ErrTmuxKillFailed` in an attempt: UNAVAILABLE, told apart by name. */
export const UNAVAILABLE_RETRY_CAUSE_KILL_FAILED = 'kill-failed'

/** The cause of any other `status`, `get` or `list` error in an attempt (b.jg5 SRJ-301, SRJ-105). */
export const UNAVAILABLE_RETRY_CAUSE_READ_ERROR = 'read-error'

/** The cause `armPendingOnly` records: a covered `pending` row (b.jg5 SRJ-303, SRJ-409). */
export const UNAVAILABLE_RETRY_CAUSE_PENDING_ROW = 'pending-row'

// ---------------------------------------------------------------------------
// Modes (b.jg5 SRJ-301, SRJ-303)
// ---------------------------------------------------------------------------

/** Full mode: each retry reruns the restart path's decision. */
export const UNAVAILABLE_RETRY_MODE_FULL = 'full'

/** Pending-only mode: each retry reads the persona's row and acts only on its state. */
export const UNAVAILABLE_RETRY_MODE_PENDING_ONLY = 'pending-only'

/** The mode a persona's timer runs its retries in. */
export type UnavailableRetryMode = typeof UNAVAILABLE_RETRY_MODE_FULL | typeof UNAVAILABLE_RETRY_MODE_PENDING_ONLY

// ---------------------------------------------------------------------------
// Row readings
// ---------------------------------------------------------------------------

/** The row read's answer when the persona has no row (`ErrSpawnNotFound`). */
export const UNAVAILABLE_RETRY_ROW_ABSENT = 'absent'

/** The row state of a launch whose session has not started. */
export const UNAVAILABLE_RETRY_ROW_PENDING = 'pending'

/** The row states that say the persona's claude process is gone. */
const GONE_ROW_STATES: ReadonlySet<string> = new Set(['ended', 'missing', UNAVAILABLE_RETRY_ROW_ABSENT])

// ---------------------------------------------------------------------------
// Conditions whose end the condition-end entry is told of (b.jg5 SRJ-306)
// ---------------------------------------------------------------------------

/** The `tmux-unresponsive` condition, which ends. */
export const UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE = 'tmux-unresponsive'

/** The `tmux-unavailable` condition, which clears. */
export const UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE = 'tmux-unavailable'

/** A condition `conditionEnded` is told has ended. */
export type UnavailableRetryCondition =
  | typeof UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE
  | typeof UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE

/**
 * What `conditionEnded` did: stopped the timer, kept it (an exception held),
 * deferred the decision to the end of the retry running now, or found none
 * armed.
 */
export type UnavailableRetryConditionEndResult = 'stopped' | 'kept' | 'deferred' | 'not-armed'

/** A condition-end refusal's reason: the persona's row last read `pending`. */
export const UNAVAILABLE_RETRY_KEPT_ROW_PENDING = 'its row last read pending'

/** A condition-end refusal's reason: a `kill-failed` cause is recorded. */
export const UNAVAILABLE_RETRY_KEPT_KILL_FAILED = 'a kill-failed cause is recorded'

// ---------------------------------------------------------------------------
// Again-reasons: outcomes of a full-mode retry, named in the re-armed line and
// never recorded as causes
// ---------------------------------------------------------------------------

/** A retry, in either mode, that found a launch call in flight for the persona, and made no call (b.jg5 SRJ-302, SRJ-303: a refusal). */
export const UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT = 'launch-in-flight'

/** A full-mode retry whose launch failed and was counted, below the restart cap. */
export const UNAVAILABLE_RETRY_AGAIN_LAUNCH_FAILED = 'launch-failed'

/** A full-mode retry whose reconnect of a live row did not succeed or was deferred. */
export const UNAVAILABLE_RETRY_AGAIN_RECONNECT_DEFERRED = 'reconnect-deferred'

/** A full-mode retry whose launch succeeded: the timer runs on at the next wait, on the launch's `pending` row. */
export const UNAVAILABLE_RETRY_AGAIN_LAUNCHED = 'launched'

/** A full-mode retry that ran before the restart module was initialised, and did nothing. */
export const UNAVAILABLE_RETRY_AGAIN_RESTART_NOT_INITIALISED = 'restart-not-initialised'

/** A full-mode retry whose reconnect was deferred because the row reads `pending`. */
export const UNAVAILABLE_RETRY_AGAIN_PENDING_DEFERRED = 'pending-deferred'

/** A pending-only retry that read the row still `pending` (b.jg5 SRJ-302: a refusal). */
export const UNAVAILABLE_RETRY_AGAIN_ROW_PENDING = 'row-pending'

// ---------------------------------------------------------------------------
// Stop reasons (b.jg5 SRJ-305)
// ---------------------------------------------------------------------------

/** A retry found the persona connected with its stream, or its reconnect succeeded. */
export const UNAVAILABLE_RETRY_STOP_RECOVERED = 'nothing left to recover'

/** The persona is at the restart cap, reached through counted launch failures. */
export const UNAVAILABLE_RETRY_STOP_CAPPED = 'the persona is at the restart cap'

/** The persona is not up: its bring-up owns it. */
export const UNAVAILABLE_RETRY_STOP_NOT_UP = 'the persona is not up; its bring-up owns it'

/** The persona is not in the applied configuration. */
export const UNAVAILABLE_RETRY_STOP_NOT_APPLIED = 'the persona is not in the applied configuration'

/** A retry's relaunch was declined by the launch's own gate. */
export const UNAVAILABLE_RETRY_STOP_LAUNCH_SKIPPED = 'its relaunch was declined (the persona is not up, or the server is stopping)'

/** The persona was torn down. */
export const UNAVAILABLE_RETRY_STOP_TORN_DOWN = 'the persona was torn down'

/** The server is shutting down. */
export const UNAVAILABLE_RETRY_STOP_SHUTDOWN = 'the server is shutting down'

/** A pending-only retry read the row live out of `pending`: nothing else is called. */
export const UNAVAILABLE_RETRY_STOP_ROW_LIVE = 'its row is live out of pending; nothing else is called'

/** A pending-only retry read the row `ended` or `missing`, or found none: the restart path's decision runs once. */
export const UNAVAILABLE_RETRY_STOP_ROW_GONE = "its row is ended, missing or gone; the restart path's decision runs once"

/** The `tmux-unresponsive` condition ended. */
export const UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED = 'the tmux-unresponsive condition ended'

/** The `tmux-unavailable` condition cleared. */
export const UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED = 'the tmux-unavailable condition cleared'

/** A cause kind that is not a short lower-case label is logged as this. */
const UNNAMED_CAUSE_KIND = 'unnamed'

/** A cause kind as logged: a short lower-case label (`unavailable`, `read-error`). */
const CAUSE_KIND_RE = /^[a-z][a-z0-9-]{0,63}$/

/** What `arm` records when it is given no cause (possible from untyped callers). */
const UNNAMED_CAUSE: UnavailableRetryCause = { kind: UNNAMED_CAUSE_KIND }

/** What `armPendingOnly` records. */
const PENDING_ROW_CAUSE: UnavailableRetryCause = { kind: UNAVAILABLE_RETRY_CAUSE_PENDING_ROW }

/** A row state as logged and recorded: a short lower-case label (`pending`, `check_permission`). */
const ROW_STATE_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** What a re-armed line names when the answer gave no reason, the action did not fail and no cause armed during the run. */
const NO_CAUSE_GIVEN = 'no cause given'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The clock and timers the controller uses (the shared fake clock satisfies it in tests). */
export type UnavailableRetryClock = PersonaConnectionClock

/** What armed a persona's timer. Recorded only through `arm`. */
export interface UnavailableRetryCause {
  /**
   * A fixed, token-free label for the cause, lower case with hyphens (for
   * example `unavailable` or `read-error`). Recorded once per timer in the
   * order first seen; logged as `unnamed` when it is not such a label.
   */
  readonly kind: string
  /** The thrown value behind the cause, if any. Logged only through `describeThrownValue`, never kept. */
  readonly error?: unknown
}

/**
 * A retry's answer. `again` re-arms at the next wait; its optional `reason`
 * is an outcome of the retry, not a cause: a short CSCB-written label (lower
 * case with hyphens, for example `launch-in-flight`), named only in the
 * re-armed line (as `unnamed` when it is not such a label) and never
 * recorded. `stop` ends the timer with a CSCB-written reason.
 *
 * - `row` (either kind): the state the retry's row read gave (`pending`,
 *   `waiting` …, or `UNAVAILABLE_RETRY_ROW_ABSENT`), or the state the retry
 *   left the row in (`pending` after a launch that succeeded). An `again`
 *   answer's `row` becomes the timer's last row read; an `again` answer
 *   without one leaves it `pending` when `armPendingOnly` landed during the
 *   run, and clears it otherwise. A `stop` answer's is named in the stopped
 *   line.
 * - `switchToPendingOnly` (`again`): true switches the timer to pending-only
 *   mode, the wait count carrying on (a full-mode retry whose launch
 *   succeeded), unless `arm` recorded a cause during the run or a
 *   `kill-failed` cause is recorded; then the timer stays in full mode.
 * - `handOff` (`stop`): run once, awaited, after the timer is stopped (a
 *   pending-only retry that found the row gone hands the persona to one run
 *   of the restart path's decision). A throw or rejection is logged.
 * - `yieldsToFullMode` (`stop`): true when the stop rests only on a
 *   pending-only retry's row read (the row live out of `pending`, or gone).
 *   When the retry ran in pending-only mode and `arm` recorded a cause during
 *   the run, the stop is not taken: the answer counts as `again` in full
 *   mode, its `row` becomes the last row read, the re-armed line names that
 *   cause, and the hand-off is not run, unless a condition end deferred to
 *   this run then stops the timer (the hand-off then runs after that stop).
 */
export type UnavailableRetryOutcome =
  | {
      readonly kind: 'again'
      readonly reason?: string
      readonly row?: string
      readonly switchToPendingOnly?: boolean
    }
  | {
      readonly kind: 'stop'
      readonly reason: string
      readonly row?: string
      readonly handOff?: () => Promise<unknown>
      readonly yieldsToFullMode?: boolean
    }

/** What the retry action is told about the retry it runs. */
export interface UnavailableRetryAttempt {
  /** Which retry of this timer this is, from 1. */
  readonly retry: number
  /** The cause kinds `arm` recorded since the arm, in the order first seen. */
  readonly causes: readonly string[]
  /** The mode this retry runs in. */
  readonly mode: UnavailableRetryMode
}

/**
 * The retry action: one retry for persona `key`. Answers `again`, with an
 * optional again-reason label, or `stop` with a CSCB-written reason. A throw
 * or rejection counts as `again`.
 */
export type UnavailableRetryAction = (
  key: string,
  attempt: UnavailableRetryAttempt,
) => UnavailableRetryOutcome | Promise<UnavailableRetryOutcome>

/** Dependencies of `createUnavailableRetryController`. */
export interface UnavailableRetryDeps {
  /** Receives each `[slack]` line the controller logs (the server log). */
  log: (line: string) => void
  /** The retry action run at each due time. */
  action: UnavailableRetryAction
  /** Clock and timers; `SYSTEM_PERSONA_CONNECTION_CLOCK` by default. */
  clock?: UnavailableRetryClock
}

/** A read-only view of one persona's timer. */
export interface UnavailableRetryView {
  /** `waiting` for its due time, or `running` its retry. */
  readonly phase: 'waiting' | 'running'
  /** When the next retry is due, in clock milliseconds; absent while running. */
  readonly dueAt?: number
  /** The wait that `dueAt` ends, in milliseconds; absent while running. */
  readonly waitMs?: number
  /** Retries answered `again` since the arm. */
  readonly refusals: number
  /** The cause kinds `arm` recorded since the arm, in the order first seen. */
  readonly causes: readonly string[]
  /** The mode its retries run in. */
  readonly mode: UnavailableRetryMode
  /** The state its last row read gave, when one is recorded. */
  readonly lastRow?: string
}

/**
 * Where a trigger inside a launch or recovery attempt is sent (b.jg5
 * SRJ-301): the persona key and the cause the arming predicate answered. The
 * controller is one: its `arm` arms the persona's timer with the cause.
 * `arm` answers true when the persona has a timer after the call (armed now,
 * or already armed or running), false when nothing is armed (refused after
 * `close`, or the first timer could not be set). Must not throw; a throw is
 * caught by the reporting point and counts as not armed.
 */
export interface UnavailableRetryTriggerSink {
  arm(key: string, cause: UnavailableRetryCause): boolean
}

/** The per-persona UNAVAILABLE retry timers of one server. */
export interface UnavailableRetryController extends UnavailableRetryTriggerSink {
  /**
   * Arm persona `key`'s timer with `cause`, in full mode. When not armed, its
   * first retry is due `UNAVAILABLE_RETRY_BASE_S` from now and one armed line
   * is logged. When armed or running, the due time and wait count are kept
   * and the cause is recorded; a timer in pending-only mode is promoted to
   * full mode (one promoted line), any other logs no line; while running, the
   * run's switch to pending-only mode is not taken. A missing cause is
   * recorded as `unnamed`. Never throws: if the clock throws while setting
   * the first timer, the persona is forgotten and one arm failed line is
   * logged. Answers true when the persona has a timer after the call; false
   * after `close` and when the first timer could not be set.
   */
  arm(key: string, cause: UnavailableRetryCause): boolean
  /**
   * Arm persona `key`'s timer in pending-only mode, for a covered `pending`
   * row (b.jg5 SRJ-303, SRJ-409): the `pending-row` cause is recorded and the
   * last row read is `pending`. When not armed, its first retry is due
   * `UNAVAILABLE_RETRY_BASE_S` from now, in pending-only mode, and one armed
   * line is logged. When armed or running, the due time, the wait count and
   * the mode are kept (no line): a timer in full mode stays in full mode.
   * While running, the run's `again` answer's own `row` still wins; an
   * answer without one leaves the last row read `pending`. After `close`,
   * one not armed line. Never throws, as `arm`.
   */
  armPendingOnly(key: string): void
  /**
   * The end of a condition for persona `key` (the end of `tmux-unresponsive`,
   * the clearing of `tmux-unavailable`; b.jg5 SRJ-306). Stops the timer, as
   * `stop` does with the condition's reason, unless its last row read was
   * `pending` or a `kill-failed` cause is recorded: then the timer is kept
   * with its due time, and one kept line names why. While the persona's
   * retry is running, it records the condition, logs nothing and answers
   * `deferred`: once the run's `again` answer (or a failed run) has set the
   * last row read and the mode, the same rule is applied before the re-arm,
   * with its kept or stopped line; a `stop` answer makes it moot (only the
   * answer's stopped line), as does a stop during the run. A pending-only
   * stop that yields to a full-mode cause armed during the run counts as
   * `again` here: the rule is applied, and when it stops the timer the
   * yielded stop's hand-off runs after that stop. Answers what it
   * did; `not-armed`, with no line, when no timer is armed. Every other stop
   * is unaffected by these exceptions.
   */
  conditionEnded(key: string, condition: UnavailableRetryCondition): UnavailableRetryConditionEndResult
  /**
   * Stop persona `key`'s timer: clear the pending timer and forget the
   * persona, logging one stopped line with `reason` (CSCB-written text).
   * A no-op, with no line, when it is not armed. A run in flight finishes,
   * but its answer is dropped.
   */
  stop(key: string, reason: string): void
  /** Stop every persona's timer, as `stop` does for each. */
  stopAll(reason: string): void
  /**
   * Stop every persona's timer, as `stopAll` does, and refuse every later
   * `arm` with one not armed line naming `reason` (the server's shutdown).
   * Nothing is armed again on this controller. Idempotent.
   */
  close(reason: string): void
  /** A snapshot of persona `key`'s timer, or `undefined` when not armed. */
  view(key: string): UnavailableRetryView | undefined
  /** True while persona `key` has a timer, waiting or running. */
  isArmed(key: string): boolean
  /** The keys of every armed persona, in arming order. */
  armedKeys(): string[]
  /**
   * Resolves once persona `key`'s in-flight retry run has settled and its
   * re-arm or stop is done; at once when none is in flight. Never rejects.
   */
  whenRunSettled(key: string): Promise<void>
}

/** A timer handle, boxed so any value the clock returns (even `undefined`) is a handle. */
interface TimerBox {
  handle: unknown
}

/** One persona's timer. Replaced, never reused, after a stop. */
interface RetryEntry {
  readonly key: string
  /** The pending timer while waiting; `undefined` while running. */
  timer: TimerBox | undefined
  dueAt: number | undefined
  waitMs: number | undefined
  refusals: number
  /** Cause kinds `arm` recorded since the arm, first seen first. */
  readonly causes: string[]
  /** The description of the last cause armed during the current run, for the re-armed line. */
  runCause: string | undefined
  /** The mode its retries run in. */
  mode: UnavailableRetryMode
  /** The state its last row read gave, if recorded. */
  lastRow: string | undefined
  /** True when `arm` (full mode) landed during the current run; cleared once the run's answer is applied. */
  fullArmedInRun: boolean
  /** True when `armPendingOnly` landed during the current run; cleared once the run's answer is applied. */
  pendingArmedInRun: boolean
  /** A condition whose end `conditionEnded` was told of during the current run; applied, then cleared, with the run's answer. */
  endedInRun: UnavailableRetryCondition | undefined
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** Build one server's UNAVAILABLE retry controller; see the module comment. */
export function createUnavailableRetryController(deps: UnavailableRetryDeps): UnavailableRetryController {
  const clock = deps.clock ?? SYSTEM_PERSONA_CONNECTION_CLOCK
  const entries = new Map<string, RetryEntry>()
  /** Each persona's latest retry run, until it settles. Kept apart from `entries` so a run outlives a stop. */
  const runs = new Map<string, Promise<void>>()
  /** Set by `close`: why every later `arm` is refused. */
  let closedReason: string | undefined

  function log(line: string): void {
    try {
      deps.log(line)
    } catch {
      /* a failing logger must not stop a persona's retries */
    }
  }

  function isCurrent(entry: RetryEntry): boolean {
    return entries.get(entry.key) === entry
  }

  /** The wait after `refusals` refused retries, in milliseconds. */
  function waitAfter(refusals: number): number {
    return doublingBackoffDelay(UNAVAILABLE_RETRY_BASE_S, refusals, UNAVAILABLE_RETRY_CEILING_S) * 1000
  }

  /**
   * Set `entry`'s timer for `waitMs`. The entry's timer fields change only
   * once the clock has returned a handle, so a clock that throws leaves them
   * untouched for the caller to forget the entry.
   */
  function schedule(entry: RetryEntry, waitMs: number): void {
    const dueAt = clock.now() + waitMs
    const box: TimerBox = { handle: undefined }
    box.handle = clock.setTimeout(() => {
      if (!isCurrent(entry) || entry.timer !== box) return
      fire(entry)
    }, waitMs)
    entry.timer = box
    entry.waitMs = waitMs
    entry.dueAt = dueAt
  }

  /** Forget `entry` if it is still current, clearing any timer it holds. Never throws. */
  function forget(entry: RetryEntry): void {
    if (!isCurrent(entry)) return
    entries.delete(entry.key)
    try {
      clearTimer(entry)
    } catch {
      /* the entry is gone, so a timer the clock failed to clear fires into a no-op */
    }
  }

  function clearTimer(entry: RetryEntry): void {
    const box = entry.timer
    entry.timer = undefined
    entry.dueAt = undefined
    entry.waitMs = undefined
    if (box !== undefined) clock.clearTimeout(box.handle)
  }

  /** Record `cause`'s kind once, and return its description for a line. */
  function record(entry: RetryEntry, cause: UnavailableRetryCause | undefined): string | undefined {
    if (cause === undefined) return undefined
    const kind = causeKind(cause)
    if (!entry.causes.includes(kind)) entry.causes.push(kind)
    return describeCause(cause)
  }

  function fire(entry: RetryEntry): void {
    clearTimer(entry)
    const prior = runs.get(entry.key)
    const run = (prior ?? Promise.resolve())
      .then(() => runRetry(entry))
      .catch((err) => {
        forget(entry)
        log(`[slack] unavailable-retry: persona=${entry.key} retry run failed: ${describeThrownValue(err)}`)
      })
    runs.set(entry.key, run)
    void run.then(() => {
      if (runs.get(entry.key) === run) runs.delete(entry.key)
    })
  }

  /**
   * One retry: the action once, in the entry's mode, then a re-arm or a
   * stop (and the stop's hand-off). Never rejects but for a failing clock.
   */
  async function runRetry(entry: RetryEntry): Promise<void> {
    if (!isCurrent(entry)) return
    const retry = entry.refusals + 1
    const mode = entry.mode
    log(
      mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY
        ? `[slack] unavailable-retry: persona=${entry.key} retry ${retry} (pending-only) — reading its row`
        : `[slack] unavailable-retry: persona=${entry.key} retry ${retry} — rerunning its recovery`,
    )
    let outcome: UnavailableRetryOutcome | undefined
    let failure: string | undefined
    try {
      outcome = await deps.action(entry.key, { retry, causes: [...entry.causes], mode })
    } catch (err) {
      failure = `the retry failed: ${describeThrownValue(err)}`
    }
    if (!isCurrent(entry)) return
    // A pending-only stop that rests on the row read yields to a full-mode
    // cause armed during the run: the timer stays, in full mode, and its
    // hand-off is held back (run only if a deferred condition end below then
    // stops the timer).
    let heldHandOff: (() => Promise<unknown>) | undefined
    let reason: string
    if (outcome?.kind === 'stop') {
      const handOff = handOffOf(outcome)
      if (!mayOverrideStop(entry, mode, outcome)) {
        stopEntry(entry, outcome.reason, rowOf(outcome))
        if (handOff !== undefined) await runHandOff(entry.key, handOff)
        return
      }
      heldHandOff = handOff
      entry.mode = UNAVAILABLE_RETRY_MODE_FULL
      entry.lastRow = rowOf(outcome) ?? (entry.pendingArmedInRun ? UNAVAILABLE_RETRY_ROW_PENDING : undefined)
      reason = entry.runCause ?? NO_CAUSE_GIVEN
    } else {
      const answered = outcome?.kind === 'again' ? againReason(outcome) : undefined
      const unexpected = failure === undefined && outcome?.kind !== 'again' ? 'the retry gave no answer' : undefined
      reason = answered ?? failure ?? unexpected ?? entry.runCause ?? NO_CAUSE_GIVEN
      if (outcome?.kind === 'again') {
        const row = rowOf(outcome)
        entry.lastRow = row ?? (entry.pendingArmedInRun ? UNAVAILABLE_RETRY_ROW_PENDING : undefined)
        if (switchesToPendingOnly(outcome) && mayTakeSwitch(entry)) entry.mode = UNAVAILABLE_RETRY_MODE_PENDING_ONLY
      }
    }
    const ended = entry.endedInRun
    entry.runCause = undefined
    entry.fullArmedInRun = false
    entry.pendingArmedInRun = false
    entry.endedInRun = undefined
    if (ended !== undefined && !applyConditionEnd(entry, ended)) {
      if (heldHandOff !== undefined) await runHandOff(entry.key, heldHandOff)
      return
    }
    entry.refusals += 1
    const waitMs = waitAfter(entry.refusals)
    schedule(entry, waitMs)
    const ran = mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY ? ' (pending-only)' : ''
    const next = entry.mode !== mode ? ` in ${entry.mode} mode` : ''
    log(`[slack] unavailable-retry: persona=${entry.key} retry ${retry}${ran}: ${reason} — re-armed${next}, next retry in ${waitMs / 1000} s`)
  }

  /**
   * Whether a run's `switchToPendingOnly` answer is taken (b.jg5 SRJ-301,
   * SRJ-306): only when no `arm` (full mode) landed during the run and no
   * `kill-failed` cause is recorded.
   */
  function mayTakeSwitch(entry: RetryEntry): boolean {
    return !entry.fullArmedInRun && !entry.causes.includes(UNAVAILABLE_RETRY_CAUSE_KILL_FAILED)
  }

  /**
   * Whether a run's `stop` answer yields to a full-mode cause (b.jg5 SRJ-301,
   * SRJ-303): only when the retry ran in pending-only mode, the stop rests on
   * its row read (`yieldsToFullMode`), and `arm` (full mode) landed during the
   * run. Then the stop is taken as `again` in full mode.
   */
  function mayOverrideStop(entry: RetryEntry, mode: UnavailableRetryMode, outcome: { readonly yieldsToFullMode?: unknown }): boolean {
    return mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY && entry.fullArmedInRun && yieldsToFullMode(outcome)
  }

  /**
   * The condition-end rule (b.jg5 SRJ-306) for `entry`, now: keep the timer,
   * with one kept line, when its last row read is `pending` or a
   * `kill-failed` cause is recorded; else stop it with the condition's
   * reason. Answers true when the timer is kept.
   */
  function applyConditionEnd(entry: RetryEntry, condition: UnavailableRetryCondition): boolean {
    const ended = conditionEndedReason(condition)
    const kept: string[] = []
    if (entry.lastRow === UNAVAILABLE_RETRY_ROW_PENDING) kept.push(UNAVAILABLE_RETRY_KEPT_ROW_PENDING)
    if (entry.causes.includes(UNAVAILABLE_RETRY_CAUSE_KILL_FAILED)) kept.push(UNAVAILABLE_RETRY_KEPT_KILL_FAILED)
    if (kept.length > 0) {
      log(`[slack] unavailable-retry: persona=${entry.key} kept — ${ended}, but ${kept.join(' and ')}`)
      return true
    }
    stopEntry(entry, ended)
    return false
  }

  /** Run a stop's hand-off once; a throw or rejection is logged. Never rejects. */
  async function runHandOff(key: string, handOff: () => Promise<unknown>): Promise<void> {
    try {
      await handOff()
    } catch (err) {
      log(`[slack] unavailable-retry: persona=${key} hand-off after the stop failed: ${describeThrownValue(err)}`)
    }
  }

  /** Stop `entry`, logging one stopped line naming a pending-only mode and the row read, when given. */
  function stopEntry(entry: RetryEntry, reason: string, row?: string): void {
    clearTimer(entry)
    entries.delete(entry.key)
    const tags: string[] = []
    if (entry.mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY) tags.push(UNAVAILABLE_RETRY_MODE_PENDING_ONLY)
    if (row !== undefined) tags.push(`row ${row}`)
    const tagged = tags.length > 0 ? ` (${tags.join(', ')})` : ''
    log(`[slack] unavailable-retry: persona=${entry.key} stopped${tagged} — ${reason}`)
  }

  /**
   * Arm persona `key` with `cause` in `mode` (see `arm` and `armPendingOnly`).
   * An armed entry keeps its due time; a full-mode arm promotes a
   * pending-only entry. Answers true when the persona has a timer after the
   * call. Never throws.
   */
  function armIn(key: string, cause: UnavailableRetryCause, mode: UnavailableRetryMode): boolean {
    if (closedReason !== undefined) {
      log(`[slack] unavailable-retry: persona=${key} not armed (${describeCause(cause)}) — ${closedReason}`)
      return false
    }
    const existing = entries.get(key)
    if (existing !== undefined) {
      const description = record(existing, cause)
      if (existing.timer === undefined) {
        existing.runCause = description
        if (mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY) existing.pendingArmedInRun = true
        else existing.fullArmedInRun = true
      }
      if (mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY) {
        existing.lastRow = UNAVAILABLE_RETRY_ROW_PENDING
      } else if (existing.mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY) {
        existing.mode = UNAVAILABLE_RETRY_MODE_FULL
        log(`[slack] unavailable-retry: persona=${key} promoted to full mode (${description}) — its due time is kept`)
      }
      return true
    }
    const entry: RetryEntry = {
      key,
      timer: undefined,
      dueAt: undefined,
      waitMs: undefined,
      refusals: 0,
      causes: [],
      runCause: undefined,
      mode,
      lastRow: mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY ? UNAVAILABLE_RETRY_ROW_PENDING : undefined,
      fullArmedInRun: false,
      pendingArmedInRun: false,
      endedInRun: undefined,
    }
    entries.set(key, entry)
    const description = record(entry, cause)
    const waitMs = waitAfter(0)
    try {
      schedule(entry, waitMs)
    } catch (err) {
      forget(entry)
      log(`[slack] unavailable-retry: persona=${key} arm failed: ${describeThrownValue(err)} — not armed`)
      return false
    }
    const inMode = mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY ? ' in pending-only mode' : ''
    log(`[slack] unavailable-retry: persona=${key} armed${inMode} (${description}) — first retry in ${waitMs / 1000} s`)
    return true
  }

  return {
    arm(key, given) {
      return armIn(key, given ?? UNNAMED_CAUSE, UNAVAILABLE_RETRY_MODE_FULL)
    },

    armPendingOnly(key) {
      armIn(key, PENDING_ROW_CAUSE, UNAVAILABLE_RETRY_MODE_PENDING_ONLY)
    },

    conditionEnded(key, condition) {
      const entry = entries.get(key)
      if (entry === undefined) return 'not-armed'
      if (entry.timer === undefined) {
        entry.endedInRun = condition
        return 'deferred'
      }
      return applyConditionEnd(entry, condition) ? 'kept' : 'stopped'
    },

    stop(key, reason) {
      const entry = entries.get(key)
      if (entry !== undefined) stopEntry(entry, reason)
    },

    stopAll(reason) {
      for (const entry of [...entries.values()]) stopEntry(entry, reason)
    },

    close(reason) {
      if (closedReason !== undefined) return
      closedReason = reason
      for (const entry of [...entries.values()]) stopEntry(entry, reason)
    },

    view(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      const common = {
        refusals: entry.refusals,
        causes: [...entry.causes],
        mode: entry.mode,
        ...(entry.lastRow !== undefined ? { lastRow: entry.lastRow } : {}),
      }
      if (entry.timer === undefined) return { phase: 'running', ...common }
      return { phase: 'waiting', dueAt: entry.dueAt, waitMs: entry.waitMs, ...common }
    },

    isArmed: (key) => entries.has(key),

    armedKeys: () => [...entries.keys()],

    async whenRunSettled(key) {
      await runs.get(key)
    },
  }
}

// ---------------------------------------------------------------------------
// The full-mode retry action (b.jg5 SRJ-303, SRJ-305)
// ---------------------------------------------------------------------------

/** Dependencies of `createFullModeRetryAction`, each read at every retry. */
export interface FullModeRetryDeps {
  /**
   * The row read (`readPersonaRowState`): one `status` call for the
   * persona's row, answering its state or `UNAVAILABLE_RETRY_ROW_ABSENT`, and
   * throwing any other error. A pending-only retry makes it inside a recovery
   * attempt for the persona.
   */
  readRow: (key: string) => Promise<string>
  /**
   * The restart module's retry entry (`runRestartRetry`): the restart path's
   * decision for the persona, through its serializer, without the delay gate,
   * with `isInFlight` as its first step.
   */
  retry: (key: string, cwd: string, isInFlight: (key: string) => boolean) => Promise<RestartRetryOutcome>
  /** The applied persona with this key (its working directory), or `undefined` when it is not applied. */
  appliedPersona: (key: string) => { readonly working_directory: string } | undefined
  /** The not-up gate (the server's relaunch gate): false while the persona is not up. */
  canRelaunch: (key: string) => boolean
  /** Whether the persona is at the restart cap (`isAtCap(key, RESTART_FAILURE_CAP)`). */
  isAtCap: (key: string) => boolean
  /** Whether the server is shutting down (the flag `shutdown()` raises). */
  isShuttingDown: () => boolean
  /**
   * The one in-flight predicate: true while work that owns the persona's
   * session is in flight (today a launch call, `isLaunchInFlight`). A retry
   * in either mode that finds it true makes no agent-director call and is a
   * refusal; a throw counts as in flight.
   */
  isInFlight: (key: string) => boolean
}

/**
 * The server's retry action, for both modes (b.jg5 SRJ-303, SRJ-305; see
 * the module comment). Before any call, in either mode, stops on shutdown, a
 * persona not applied, not up or at the cap, in that order. Then, in full
 * mode, runs the retry entry once and answers from its outcome; in
 * pending-only mode, answers a `launch-in-flight` refusal with no call when
 * the in-flight predicate answers true or throws, else reads the row inside
 * a recovery attempt for the persona and answers from its state
 * (`pendingOnlyAnswer`). A dependency that throws (but the in-flight
 * predicate),
 * an entry that rejects, or a row read that throws rejects the action, which
 * the controller counts as `again`.
 */
export function createFullModeRetryAction(deps: FullModeRetryDeps): UnavailableRetryAction {
  return async (key, attempt) => {
    if (deps.isShuttingDown()) return stopWith(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
    const persona = deps.appliedPersona(key)
    if (persona === undefined) return stopWith(UNAVAILABLE_RETRY_STOP_NOT_APPLIED)
    if (!deps.canRelaunch(key)) return stopWith(UNAVAILABLE_RETRY_STOP_NOT_UP)
    if (deps.isAtCap(key)) return stopWith(UNAVAILABLE_RETRY_STOP_CAPPED)
    const cwd = persona.working_directory
    if (attempt.mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY) {
      if (inFlight(key, deps.isInFlight)) {
        return { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT, row: UNAVAILABLE_RETRY_ROW_PENDING }
      }
      const row = await runInAttempt(key, 'recovery', () => deps.readRow(key))
      return pendingOnlyAnswer(row, () => deps.retry(key, cwd, deps.isInFlight))
    }
    return answerFor(await deps.retry(key, cwd, deps.isInFlight))
  }
}

/**
 * What a pending-only retry answers for the row read's `row` (b.jg5
 * SRJ-303, SRJ-305): still `pending`, a refusal with no other call; `ended`,
 * `missing` or absent, a stop whose hand-off is `restart` (one run of the
 * restart path's decision, after the timer is stopped, so that a refused
 * launch in it arms a fresh timer); any other state, live out of `pending`, a
 * stop with no other call. Both stops rest on the row read alone
 * (`yieldsToFullMode`): a full-mode cause armed during the retry overrides
 * them.
 */
function pendingOnlyAnswer(row: string, restart: () => Promise<unknown>): UnavailableRetryOutcome {
  if (row === UNAVAILABLE_RETRY_ROW_PENDING) {
    return { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_ROW_PENDING, row }
  }
  if (GONE_ROW_STATES.has(row)) {
    return { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_GONE, row, handOff: restart, yieldsToFullMode: true }
  }
  return { kind: 'stop', reason: UNAVAILABLE_RETRY_STOP_ROW_LIVE, row, yieldsToFullMode: true }
}

/** The in-flight predicate for a pending-only retry: `isInFlight(key)`, with a throw counted as in flight. */
function inFlight(key: string, isInFlight: (key: string) => boolean): boolean {
  try {
    return isInFlight(key)
  } catch {
    return true
  }
}

function stopWith(reason: string): UnavailableRetryOutcome {
  return { kind: 'stop', reason }
}

function againWith(reason: string | undefined): UnavailableRetryOutcome {
  return reason === undefined ? { kind: 'again' } : { kind: 'again', reason }
}

/**
 * What a full-mode retry answers for the retry entry's outcome. A refused
 * launch gives no reason of its own: the UNAVAILABLE outcome that refused it
 * armed the timer during the run, and the re-armed line names that cause. A
 * reconnect deferred on a `pending` row records the row read `pending`. A
 * successful launch records the row read `pending` too (the launch's row,
 * whether or not the switch is taken) and asks to switch the timer to
 * pending-only mode; the controller takes the switch only when no other
 * cause armed during the run and no `kill-failed` cause is recorded.
 */
function answerFor(outcome: RestartRetryOutcome): UnavailableRetryOutcome {
  switch (outcome) {
    case 'already-connected':
    case 'reconnected':
      return stopWith(UNAVAILABLE_RETRY_STOP_RECOVERED)
    case 'capped':
      return stopWith(UNAVAILABLE_RETRY_STOP_CAPPED)
    case 'not-up':
      return stopWith(UNAVAILABLE_RETRY_STOP_NOT_UP)
    case 'launch-skipped':
      return stopWith(UNAVAILABLE_RETRY_STOP_LAUNCH_SKIPPED)
    case 'shutting-down':
      return stopWith(UNAVAILABLE_RETRY_STOP_SHUTDOWN)
    case 'in-flight':
      return againWith(UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT)
    case 'refused':
      return againWith(undefined)
    case 'counted-failure':
      return againWith(UNAVAILABLE_RETRY_AGAIN_LAUNCH_FAILED)
    case 'reconnect-deferred':
      return againWith(UNAVAILABLE_RETRY_AGAIN_RECONNECT_DEFERRED)
    case 'pending-deferred':
      return { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_PENDING_DEFERRED, row: UNAVAILABLE_RETRY_ROW_PENDING }
    case 'launched':
      return {
        kind: 'again',
        reason: UNAVAILABLE_RETRY_AGAIN_LAUNCHED,
        row: UNAVAILABLE_RETRY_ROW_PENDING,
        switchToPendingOnly: true,
      }
    case 'not-initialised':
      return againWith(UNAVAILABLE_RETRY_AGAIN_RESTART_NOT_INITIALISED)
    default: {
      const unknown: never = outcome
      throw new Error(`unknown restart retry outcome: ${String(unknown)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A cause's kind as recorded and logged: the label, or `unnamed` when it is not one. */
function causeKind(cause: UnavailableRetryCause): string {
  try {
    return labelOf(cause.kind)
  } catch {
    return UNNAMED_CAUSE_KIND
  }
}

/**
 * An `again` answer's reason as logged: `undefined` when it gives none, the
 * label, or `unnamed` when it is not one. Never throws.
 */
function againReason(outcome: { readonly reason?: unknown }): string | undefined {
  try {
    const reason = outcome.reason
    return reason === undefined ? undefined : labelOf(reason)
  } catch {
    return UNNAMED_CAUSE_KIND
  }
}

/** `value` when it is a short lower-case label, else `unnamed`. */
function labelOf(value: unknown): string {
  return typeof value === 'string' && CAUSE_KIND_RE.test(value) ? value : UNNAMED_CAUSE_KIND
}

/**
 * An answer's row reading as recorded and logged: `undefined` when it gives
 * none, the state when it is a short lower-case label, else `unnamed`. Never
 * throws.
 */
function rowOf(outcome: { readonly row?: unknown }): string | undefined {
  try {
    const row = outcome.row
    if (row === undefined) return undefined
    return typeof row === 'string' && ROW_STATE_RE.test(row) ? row : UNNAMED_CAUSE_KIND
  } catch {
    return UNNAMED_CAUSE_KIND
  }
}

/** True when an `again` answer switches the timer to pending-only mode (its field is exactly `true`). Never throws. */
function switchesToPendingOnly(outcome: { readonly switchToPendingOnly?: unknown }): boolean {
  try {
    return outcome.switchToPendingOnly === true
  } catch {
    return false
  }
}

/** True when a `stop` answer rests only on a pending-only row read (its field is exactly `true`). Never throws. */
function yieldsToFullMode(outcome: { readonly yieldsToFullMode?: unknown }): boolean {
  try {
    return outcome.yieldsToFullMode === true
  } catch {
    return false
  }
}

/** A `stop` answer's hand-off, when it gives a function. Never throws. */
function handOffOf(outcome: { readonly handOff?: unknown }): (() => Promise<unknown>) | undefined {
  try {
    const handOff = outcome.handOff
    return typeof handOff === 'function' ? (handOff as () => Promise<unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The stop reason for the end of `condition`; an unknown condition is named as a label. */
function conditionEndedReason(condition: unknown): string {
  if (condition === UNAVAILABLE_RETRY_CONDITION_TMUX_UNAVAILABLE) return UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED
  if (condition === UNAVAILABLE_RETRY_CONDITION_TMUX_UNRESPONSIVE) return UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED
  return `the ${labelOf(condition)} condition ended`
}

/** `<kind>`, or `<kind>: <describeThrownValue(error)>` when the cause carries a thrown value. Never throws. */
function describeCause(cause: UnavailableRetryCause): string {
  const kind = causeKind(cause)
  try {
    return 'error' in cause && cause.error !== undefined ? `${kind}: ${describeThrownValue(cause.error)}` : kind
  } catch {
    return kind
  }
}

// ---------------------------------------------------------------------------
// The arming predicate (b.jg5 SRJ-301)
// ---------------------------------------------------------------------------

/** The verbs whose error inside an attempt is a read error (b.jg5 SRJ-301, SRJ-105). */
const READ_VERBS: ReadonlySet<string> = new Set(['status', 'get', 'list'])

/**
 * What arms persona P's retry timer when `value` is thrown by an
 * agent-director call made with `verb` inside a launch or recovery attempt
 * for P (b.jg5 SRJ-301), classified by `classifyAdError`:
 *
 * - UNAVAILABLE from any verb: an `unavailable` cause, or a `kill-failed`
 *   cause when the value's name is `ErrTmuxKillFailed`;
 * - any other `status`, `get` or `list` error: a `read-error` cause, except
 *   `ErrSpawnNotFound` (each site keeps its meaning) and a CONFIG or UNUSABLE
 *   NAME answer (each takes its own handling, SRJ-105);
 * - `undefined` (nothing arms) otherwise.
 *
 * The cause carries `value`, which reaches a line only through
 * `describeThrownValue`. `verb` is agent-director's verb name (`status`,
 * `get`, `list`, `kill`, `spawn`, `read-pane` …); an unknown verb is never a
 * read. Never throws.
 */
export function unavailableRetryCauseFor(value: unknown, verb: string | undefined): UnavailableRetryCause | undefined {
  try {
    const { errorClass } = classifyAdError(value)
    if (errorClass === AD_ERROR_CLASS_UNAVAILABLE) {
      const kind = hasAdErrorName(value, ERR_TMUX_KILL_FAILED_NAME)
        ? UNAVAILABLE_RETRY_CAUSE_KILL_FAILED
        : UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE
      return { kind, error: value }
    }
    if (verb === undefined || !READ_VERBS.has(verb)) return undefined
    if (errorClass === AD_ERROR_CLASS_CONFIG || errorClass === AD_ERROR_CLASS_UNUSABLE_NAME) return undefined
    if (hasAdErrorName(value, ERR_SPAWN_NOT_FOUND_NAME)) return undefined
    return { kind: UNAVAILABLE_RETRY_CAUSE_READ_ERROR, error: value }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// The attempt context (b.jg5 SRJ-301)
// ---------------------------------------------------------------------------

/**
 * A launch attempt (a run of the persona's collision ladder, whoever starts
 * it) or a recovery attempt (a run of its restart work, with its adapters).
 */
export type AttemptKind = 'launch' | 'recovery'

/** The last agent-director error an attempt met. */
export interface AttemptErrorRecord {
  /** The verb the failed call was made with, when known. */
  readonly verb?: string
  /** The cause kind the arming predicate answered; absent when it answered nothing. */
  readonly causeKind?: string
  /** True when the error was sent to a trigger sink and the sink answered that the persona has a timer. */
  readonly armed: boolean
}

/** A read-only view of one running attempt. */
export interface AttemptView {
  readonly key: string
  readonly kind: AttemptKind
  /** The last agent-director error met inside this attempt (not inside one nested in it), if any. */
  readonly lastError: AttemptErrorRecord | undefined
}

/**
 * One attempt as the context holds it: its parent is the nearest attempt still
 * running when it was started, if any.
 */
interface AttemptFrame {
  readonly key: string
  readonly kind: AttemptKind
  readonly parent: AttemptFrame | undefined
  /** False once the attempt's function has settled; a continuation that outlives it is then outside it. */
  open: boolean
  lastError: AttemptErrorRecord | undefined
}

/**
 * The attempt the current call runs in, carried across awaits, timers and
 * microtasks by `AsyncLocalStorage` (Bun carries it on the launch path's
 * awaits, the dialog approver's timer polls included). It holds only the
 * running attempts' frames, never a persona's state between attempts.
 */
const attemptContext = new AsyncLocalStorage<AttemptFrame>()

/**
 * Run `fn` as a launch or recovery attempt for persona `key`, and settle with
 * its result. Attempts nest: one started inside another (for the same key or
 * another) is the innermost for its key while it runs, and an error met in it
 * is recorded there only. A continuation of `fn` that outlives it (a timer it
 * set) is outside the attempt.
 */
export async function runInAttempt<T>(
  key: string,
  kind: AttemptKind,
  fn: (attempt: AttemptView) => T | Promise<T>,
): Promise<T> {
  // Link to the nearest open ancestor: a closed frame is never an innermost
  // attempt, and skipping it here keeps a timer armed inside an attempt from
  // retaining the frames that have since closed.
  let parent = attemptContext.getStore()
  while (parent !== undefined && !parent.open) parent = parent.parent
  const frame: AttemptFrame = { key, kind, parent, open: true, lastError: undefined }
  try {
    return await attemptContext.run(frame, () => fn(viewOf(frame)))
  } finally {
    frame.open = false
  }
}

/** A live view of `frame`: its `lastError` reads the frame's current record. */
function viewOf(frame: AttemptFrame): AttemptView {
  return {
    key: frame.key,
    kind: frame.kind,
    get lastError() {
      return frame.lastError
    },
  }
}

/** The innermost running attempt for persona `key` the current call is inside, if any. */
function innermostFrame(key: string): AttemptFrame | undefined {
  for (let frame = attemptContext.getStore(); frame !== undefined; frame = frame.parent) {
    if (frame.open && frame.key === key) return frame
  }
  return undefined
}

/** True when the current call runs inside a launch or recovery attempt for persona `key`. */
export function isInsideAttempt(key: string): boolean {
  return innermostFrame(key) !== undefined
}

/**
 * Report an agent-director error for persona `key`, thrown by a call made
 * with `verb` (b.jg5 SRJ-301). Outside an attempt for `key` it does nothing.
 * Inside one, when the arming predicate answers a cause and `sink` is given,
 * the sink is called once with `key` and the cause; the innermost attempt
 * then records the error as its last, armed when the sink answered true (the
 * persona has a timer after the call); a sink that answers anything else, or
 * throws, armed nothing. Answers whether the sink armed. Never throws.
 */
export function reportAttemptError(
  key: string,
  value: unknown,
  verb: string | undefined,
  sink: UnavailableRetryTriggerSink | undefined,
): boolean {
  try {
    const frame = innermostFrame(key)
    if (frame === undefined) return false
    const cause = unavailableRetryCauseFor(value, verb)
    let armed = false
    if (cause !== undefined && sink !== undefined) {
      try {
        armed = sink.arm(key, cause) === true
      } catch {
        /* a failing sink arms nothing; the call's own error is what its caller sees */
      }
    }
    frame.lastError = {
      ...(verb !== undefined ? { verb } : {}),
      ...(cause !== undefined ? { causeKind: cause.kind } : {}),
      armed,
    }
    return armed
  } catch {
    return false
  }
}
