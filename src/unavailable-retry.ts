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
 * - `runNow(key, cause, why)`: the persona's retry runs at once (b.jg5
 *   SRJ-810: an old-life hold that ends retries each persona that waited on
 *   it at once). A waiting timer is cleared and its retry runs now in its
 *   mode, its wait count carrying on; a retry already running is left to
 *   re-arm the timer; a persona not armed is armed with `cause` and run at
 *   once; after `close` nothing runs. One line; never throws.
 * - `conditionEnded(key, condition, reading?)`: the end of
 *   `tmux-unresponsive` or the clearing of `tmux-unavailable` stops the
 *   timer, unless its last row read was `pending` or a `kill-failed` cause is
 *   recorded (b.jg5 SRJ-306); then it is kept with its due time and one kept
 *   line says why. A `reading` the end brings (a health tick or a retry that
 *   found the row live out of `pending`, connected with its stream, or
 *   `pending` from a successful launch call) becomes the last row read
 *   first, so a stale `pending` read does not keep the timer and a launch's
 *   fresh `pending` row does. While the persona's retry is running, the end and its reading are
 *   recorded (`deferred`, no line) and the same rule is applied once the
 *   run's answer has set the last row read and the mode, before the re-arm.
 *   The row the run's answer carries (a successful launch's `pending` row, a
 *   row it read) is the later state and wins over the recorded reading, which
 *   becomes the last row read only when the answer carries no row, or when
 *   the reading is `pending` (a launch call's end during the run, which the
 *   run cannot order against its own read; `deferredReadingApplies`). An
 *   `arm` (full mode) that lands later in the same run (a refusal that
 *   started the condition again) cancels the recorded end and its reading,
 *   so the timer is not stopped while the condition holds; an end that lands
 *   after such an arm is recorded and applied as above. An `armPendingOnly`
 *   in the run is no refusal and cancels nothing: the `pending` row it marks
 *   keeps the timer when the end is applied. A
 *   `stop` answer makes it moot,
 *   but a pending-only stop that yields to a full-mode cause counts as
 *   `again` here, and when the rule stops the timer the yielded stop's
 *   hand-off runs after that stop. Its callers are the `tmux-unresponsive`
 *   condition's end (`createTmuxUnresponsiveCondition` in
 *   `src/persona-episodes.ts`, bound in `main()`) and each real clear of the
 *   `tmux-unavailable` outage (the outage state's cleared-flag observer,
 *   `OutageStateDeps.onFlagCleared`, bound in `main()`), which passes on the
 *   reading the clear brought: a tick's or retry's live reading, or a launch
 *   call's `pending`. A silent boot or teardown reset of the outage flags
 *   reaches neither. The exceptions hold against this entry only; every
 *   other stop is unaffected.
 * - The optional retry observer (`UnavailableRetryDeps.onRetryFire`) is
 *   called once at every retry, a retry the action skips for work in flight
 *   included, before the action runs (b.jg5 SRJ-308: the
 *   `tmux-unresponsive` onset with the health check off). It reads nothing
 *   back and changes nothing here.
 * - The optional stop observer (`UnavailableRetryDeps.onStopped`) is called
 *   once per real stop of a persona's timer, with the stop's reason, after
 *   its stopped line: every `stop`, `stopAll` and `close`, a `stop` answer,
 *   the condition-end rule's stop, and a timer forgotten because its re-arm
 *   failed (`UNAVAILABLE_RETRY_STOP_RUN_FAILED`). A no-op call (nothing
 *   armed), a first arm that failed (no timer ever ran) and a pending-only
 *   stop that yielded to a full-mode cause are not stops. It runs before a
 *   stop's hand-off (b.jg5 SRJ-305, SRJ-308, SRJ-309: the
 *   `tmux-unresponsive` onset is held back and its alert check cancelled with
 *   the timer, since both say CSCB keeps retrying, and a later refusal
 *   allows the onset and arms the check again unless the reason is one of
 *   `UNAVAILABLE_RETRY_TERMINAL_STOPS`; b.jg5 SRJ-313: the persona's
 *   unclassified-error episode ends on the stops that mean the retries are
 *   over because the persona's state got better:
 *   `UNAVAILABLE_RETRY_STOP_RECOVERED`, `UNAVAILABLE_RETRY_STOP_ROW_LIVE`,
 *   `UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED`,
 *   `UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED` and
 *   `UNAVAILABLE_RETRY_STOP_ROW_GONE`, and on no other). It reads nothing
 *   back and changes nothing here.
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
 * run, else kept as it is when the answer sets `keepsLastRow` (the
 * liveness-unknown `again`, which read no row), else cleared by the `again`;
 * a failed retry keeps it, and
 * `armPendingOnly` sets it `pending`. A `stop` answer may carry a hand-off,
 * run once, awaited, after the stop. A pending-only retry's stop that rests
 * on its row read (`yieldsToFullMode`) is not taken when `arm` recorded a
 * cause during the run: it counts as `again` in full mode (as `mayTakeSwitch`
 * keeps a full-mode cause from being dropped), with no hand-off unless a
 * condition end deferred to that run then stops the timer (the hand-off then
 * runs after that stop).
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
 * persona teardown, and the dialog approver, which a launch attempt starts
 * through `runOutsideAttempts`, b.jg5 SRJ-401), is not inside one.
 * `reportAttemptError(key, value, verb, sink)` is the one reporting step,
 * which the agent-director wrappers and the liveness adapter reach through
 * `src/outage-state.ts`: inside an attempt for `key`, the arming predicate
 * `unavailableRetryCauseFor(value, verb)` decides the cause (UNAVAILABLE from
 * any verb, `ErrTmuxKillFailed` told apart by class; ENVIRONMENT from any
 * verb; CONFIG from any verb; UNCLASSIFIED from any verb but the reads,
 * b.jg5 SRJ-313; any other `status`, `get` or `list` error but
 * `ErrSpawnNotFound` and UNUSABLE NAME), the trigger sink
 * (`UnavailableRetryTriggerSink`, which the controller is) arms the persona's
 * timer with it, and the innermost attempt records the error as its last,
 * with whether it armed. The ENVIRONMENT cause (`ErrTmuxNotAvailable`, b.jg5
 * SRJ-311) and the CONFIG cause (`ErrConfigMalformed`, SRJ-316) arm the
 * persona's timer outside an attempt for it too; no other cause does. A
 * trigger while armed keeps the due time (`arm` above). A second arming path is the restart work's arm hook,
 * `RestartDeps.armRetryTimer` (wired in `main()`): it arms the persona's
 * timer with `UNAVAILABLE_RETRY_CAUSE_READ_ERROR` on every `unknown` liveness
 * reading at the restart work, the re-probe's included, that leaves the
 * persona unlatched (a probe that throws included, which the arming predicate
 * above does not arm on). The restart work asks the latch first: an UNUSABLE
 * NAME answer (b.jg5 SRJ-512), or the persona's own row reading `pending`
 * with no launch start (SRJ-513), latches the persona, so its `unknown` reading
 * stops there and arms nothing. A third is
 * the health tick's (`HealthCheckDeps.armRetryTimer`, wired in `main()`): a
 * persona held off on its `tmux-unavailable` outage that the tick does not
 * find healthy, with no timer armed, is armed with
 * `UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT` (a retry that stopped as not up, on
 * a declined launch or on a failed run leaves the flag raised). A fourth is
 * the outage state's launch-failure arm (`armPendingOnlyAfterLaunchFailure`,
 * `src/outage-state.ts`): inside a launch or recovery attempt for the
 * persona, a launch's `ErrTmuxSessionCreate` (a plain spawn's, a reuse's or
 * a `resume`'s, the collision ladder's and the live-row sequence's alike)
 * arms its timer at once in pending-only mode through the sink's optional
 * `armPendingOnly` (b.jg5 SRJ-111, SRJ-112, SRJ-113, SRJ-301, SRJ-409). It records
 * no attempt error, so the counted launch failure stays counted.
 *
 * The retry action (b.jg5 SRJ-303, SRJ-305). The server's action is
 * `createFullModeRetryAction(deps)`, for both modes: at each retry, before
 * any call, the shutdown flag, the applied-persona lookup, the optional
 * latched query (b.jg5 SRJ-303: no attempt while the persona is latched), the
 * optional held query (b.jg5 SRJ-207, SRJ-303: no attempt while the persona
 * is held on `ErrInvalidFlags`), the not-up gate (the relaunch gate) and the
 * at-cap check each stop the timer with their reason
 * (`UNAVAILABLE_RETRY_STOP_*`).
 *
 * The latch (b.jg5 SRJ-305, SRJ-502). When a persona latches, whatever the
 * case, its timer stops through `stop` with `UNAVAILABLE_RETRY_STOP_LATCHED`
 * (`main()`'s latch hold), in either mode and whatever its causes: the
 * condition-end entry's `pending` and kill-failure exceptions never keep a
 * latched persona's timer. A timer armed after the latch stops at its first
 * retry on the latched query, with no agent-director call, and a full-mode
 * retry whose restart work answers `latched` stops the same way.
 *
 * The latch re-check scope (b.jg5 SRJ-505). A latched persona's re-check
 * runs through `runInLatchRecheck(scope, fn)`, a third context beside the
 * attempt context and the retry marker, carried the same way. While the
 * persona is still latched (`isInsideLatchRecheck`), the reporting step arms
 * nothing for any cause, in any context, and the controller's `arm` and
 * `armPendingOnly` arm nothing for it, whoever asks (one `not armed … —
 * inside its latch re-check` line), so an answer to the re-check's read,
 * probe or retry, or to a call inside a launch or recovery attempt opened
 * within it, gives no information; the outage wrappers honour the same query
 * (`src/outage-state.ts`). `latchRecheckScopeOf` hands the caller's scope
 * object back. `runOutsideAttempts` leaves it.
 *
 * The `ErrInvalidFlags` hold (b.jg5 SRJ-207, SRJ-303, SRJ-305). When a
 * persona is held, its timer stops through `stop` with
 * `UNAVAILABLE_RETRY_STOP_HELD` (`main()`'s hold reaction), never the
 * condition-end entry, so neither of its exceptions keeps it. A timer armed
 * while the persona is held stops at its first retry on the held query, in
 * either mode and whatever its causes, with no agent-director call, and a
 * full-mode retry whose restart work answers `held` stops the same way.
 *
 * In full mode the restart module's retry entry then reruns the restart
 * path's decision, with the "blocks a retry" check (`isInFlight`) as its
 * first step, and
 * its outcome decides: a persona already connected with its stream, or
 * reconnected, has nothing left to recover (stop; a persona already
 * connected with its stream, whose row read `live`, also ends its
 * `tmux-unresponsive` condition through the optional end hook,
 * `FullModeRetryDeps.endTmuxUnresponsive`, b.jg5 SRJ-310); capped, not up, a declined
 * launch or shutting down stop too; a launch in flight, a refused launch, a
 * counted launch failure below the cap, a deferred reconnect, a row found
 * `pending` (by the liveness probe, whatever the session's connection shows,
 * or by the reconnect's or b.d61's re-probe's read; recorded as the last row
 * read, and never "nothing left to recover"), a liveness reading of `unknown` (b.jg5
 * SRJ-314; it read no row, so the last row read is kept), a run that found
 * the persona's live-row sequence running (`sequence-waiting`, b.jg5
 * SRJ-706) and a successful
 * launch retry again at the next wait. A successful launch records the row
 * read `pending` and
 * switches the timer to pending-only mode, the wait count carrying on,
 * unless another cause armed during that retry or a `kill-failed` cause is
 * recorded. Each `again` carries its again-reason
 * (the labels under "Again-reasons" below: `launch-in-flight`,
 * `live-row-sequence-in-flight` and `old-life-wait-in-flight`, which name
 * what blocks the retry, `launch-failed`, `reconnect-deferred`, `pending-deferred`, `launched`,
 * `restart-not-initialised`, `liveness-unknown`,
 * `live-row-sequence-waiting`) for the re-armed line, except a refused launch,
 * whose line names the UNAVAILABLE cause that armed during the run. The
 * in-flight skip is still a refusal for the schedule: the wait doubles. A
 * retry never counts toward the restart cap itself: only a launch failure
 * the restart work counts does.
 *
 * In pending-only mode, a retry that finds the in-flight predicate true (a
 * throw counts as in flight) makes no agent-director call and is a refusal
 * (`launch-in-flight`, `live-row-sequence-in-flight` or
 * `old-life-wait-in-flight` by what blocks it, the row kept `pending`). Otherwise it reads the
 * persona's row (`readRow`, one `status` call) inside a recovery attempt for
 * the persona, and the state decides:
 * still `pending`, a refusal (`row-pending`) with no other call, or, with the
 * pending-row step given (`FullModeRetryDeps.stepPendingRow`, bound in
 * `main()`), one `get` that decides the row (b.jg5 SRJ-409, SRJ-411): a
 * covered or undecided row is armed pending-only and kept (`row-pending`); a
 * row that is not covered (a retired key's old life before its new life, a
 * `cwd` or `config_dir` mismatch) starts the live-row sequence, a refusal
 * naming it (`live-row-sequence-started`, the row kept `pending`) with no
 * launch or approver of the retry's own; a read that latched stops as
 * latched; another state the `get` read is answered as below; live out of
 * `pending`, a stop with no other call (and, when the optional connection
 * and stream probes both answer true, the end hook ends the persona's
 * `tmux-unresponsive` condition with the row's state as its reading); `ended`, `missing` or no row, a stop
 * that hands the persona to one run of the restart module's retry entry once
 * the timer is stopped, so a refused launch in that run arms a fresh timer.
 * Either stop yields to a cause `arm` recorded during the retry (another
 * attempt for the persona met UNAVAILABLE meanwhile): the timer stays armed
 * in full mode and re-arms at the next wait, naming that cause, and the
 * hand-off is not run, unless a condition end deferred to that run then
 * stops the timer (the hand-off then runs after that stop).
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
 * log only; nothing is posted to Slack. The server's retry action
 * (`createFullModeRetryAction`) logs one line of its own, to the server log
 * (`latched query failed: <thrown> — taken as latched`, or `held query
 * failed: <thrown> — taken as held`), when its latched or held query throws.
 * A cause's thrown value reaches a line only through
 * `describeThrownValueWithoutStack` (one line, no stack frames), and a failed
 * action only through `describeThrownValue` (each with its message redacted
 * by `redactSlackLogText`). A cause kind, an again-reason and a row
 * state are labels (anything else is logged as `unnamed`) and a stop reason
 * is CSCB-written text; none carries agent-director failure text.
 *
 * SPDX-License-Identifier: MIT
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  AD_READ_VERBS,
  classifyAdError,
  isAdErrorInstance,
} from './ad-error-class.ts'
import { ErrSpawnNotFound, ErrTmuxKillFailed } from './agent-director-errors.ts'
import { doublingBackoffDelay } from './backoff.ts'
import { AGENT_DIRECTOR_LIVE_STATES, LIVENESS_LIVE } from './liveness-reading.ts'
import { describeThrownValue, describeThrownValueWithoutStack } from './persona-connection-errors.ts'
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

/** The cause of an `ErrTmuxKillFailed` in an attempt: UNAVAILABLE, told apart by class. */
export const UNAVAILABLE_RETRY_CAUSE_KILL_FAILED = 'kill-failed'

/**
 * The cause of an ENVIRONMENT answer (`ErrTmuxNotAvailable`) from any verb
 * for the persona (b.jg5 SRJ-301, SRJ-311, SRJ-105), in or out of an attempt:
 * the only cause that arms outside a launch or recovery attempt for the
 * persona (`reportAttemptError`), and the cause the health tick arms with
 * for a raised `tmux-unavailable` outage that has no timer
 * (`HealthCheckDeps.armRetryTimer`). Never counted, and it never starts or
 * continues the `tmux-unresponsive` condition (SRJ-307: only UNAVAILABLE
 * does).
 */
export const UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT = 'environment'

/**
 * The cause of a CONFIG answer (`ErrConfigMalformed`, an
 * `ErrUnknownErrorName` recognised by its `unknownName`) from any verb for the persona
 * (b.jg5 SRJ-301, SRJ-316, SRJ-105), in or out of an attempt, as the
 * ENVIRONMENT cause arms: the persona is retried on its timer whatever
 * `session_restart_delay` and `health_check_interval` are. Never counted, and
 * it never starts or continues the `tmux-unresponsive` condition (SRJ-307:
 * only UNAVAILABLE does).
 */
export const UNAVAILABLE_RETRY_CAUSE_CONFIG = 'config'

/**
 * The cause of an UNCLASSIFIED outcome (b.jg5 SRJ-104: an `ErrInternal` other
 * than an unusable recorded name, a store-open name, `ErrSystemInstallDisappeared`
 * or any name CSCB gives no handling) from any verb but `status`, `get` and
 * `list`, inside a launch or recovery attempt for the persona (b.jg5 SRJ-301,
 * SRJ-313). A read's UNCLASSIFIED answer keeps the read-error cause. Never
 * counted, it arms nothing outside an attempt for the persona, and it never
 * starts or continues the `tmux-unresponsive` condition (SRJ-307: only
 * UNAVAILABLE does).
 */
export const UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED = 'unclassified'

/**
 * The causes that arm the persona's timer in any context
 * (`reportAttemptError`): ENVIRONMENT (b.jg5 SRJ-311) and CONFIG (SRJ-316).
 * Every other cause arms only inside a launch or recovery attempt for the
 * persona.
 */
export const UNAVAILABLE_RETRY_ANY_CONTEXT_CAUSES: ReadonlySet<string> = new Set<string>([
  UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT,
  UNAVAILABLE_RETRY_CAUSE_CONFIG,
])

/**
 * The cause of any other `status`, `get` or `list` error in an attempt (b.jg5
 * SRJ-301, SRJ-105), CONFIG excepted (its own cause, above). Also the cause
 * the restart work's arm hook (`RestartDeps.armRetryTimer`, wired in
 * `main()`) arms with, on every `unknown` liveness reading at the restart
 * work that leaves the persona unlatched, a thrown probe included (b.jg5
 * SRJ-314); an UNUSABLE NAME answer (b.jg5 SRJ-512), or the persona's own
 * row reading `pending` with no launch start (SRJ-513), latches the persona and
 * the restart work stops at its latch check first, arming nothing; a CONFIG
 * `status` has armed the CONFIG cause first through the reporting point, and
 * a trigger while armed keeps the due time.
 */
export const UNAVAILABLE_RETRY_CAUSE_READ_ERROR = 'read-error'

/** The cause `armPendingOnly` records: a covered `pending` row (b.jg5 SRJ-303, SRJ-409). */
export const UNAVAILABLE_RETRY_CAUSE_PENDING_ROW = 'pending-row'

/**
 * The cause a live-row sequence arms with when a run left its `pending` row
 * in neither `ids` nor `unverified_ids` and the episode stopped (b.jg5
 * SRJ-717, SRJ-301; `src/live-row-sequence.ts`). Never counted.
 */
export const UNAVAILABLE_RETRY_CAUSE_SEQUENCE_NOT_JUDGED = 'sequence-not-judged'

/**
 * The cause a live-row sequence arms with when it ends without its launch for
 * any other reason (b.jg5 SRJ-705, SRJ-301): a failed `get`, a refused run,
 * a kill's abort that did not latch the persona, step 5 (with or without its
 * alert), no kill under the `ad-config-malformed` rule, a launch not made, or
 * a final launch that failed or threw. A stop for a latch, a teardown or
 * shutdown, a launch that latched the persona or stops the server, a reuse
 * collision (`UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION`), a final `resume`'s
 * `ErrSpawnNotResumable` whose re-read found a lost race
 * (`UNAVAILABLE_RETRY_CAUSE_LOST_RACE`; one whose re-read found the row
 * `pending` arms this cause, b.jg5 SRJ-710) and a final launch
 * whose `ErrTmuxSessionCreate` armed the timer in pending-only mode
 * (`armPendingOnly`; SRJ-112, SRJ-113, SRJ-409) arm nothing with it. Never
 * counted.
 */
export const UNAVAILABLE_RETRY_CAUSE_SEQUENCE_ENDED = 'sequence-ended-without-launch'

/**
 * The cause of a launch's collision (`ErrInstanceIdCollision`, b.jg5
 * SRJ-112, SRJ-111, SRJ-301): the row is live, so the reuse spawn or plain
 * spawn launched nothing. Armed when a collision at the live-row sequence's
 * final launch (its reuse, or the plain spawn after its `resume`'s
 * `ErrSpawnNotFound`) ends the sequence without its launch (SRJ-705,
 * SRJ-706), when a second collision at a collision ladder reuse site (the
 * replace step's or the no-transcript step's, in the one re-run of
 * get-then-act the first gave) ends the launch attempt, and when a plain
 * spawn's collision in the one re-run of get-then-act a plain spawn's
 * collision gave ends it (`reportReuseCollisionAtSite`,
 * `src/outage-state.ts`). Never counted.
 */
export const UNAVAILABLE_RETRY_CAUSE_REUSE_COLLISION = 'reuse-collision'

/**
 * The cause of a lost race on `resume`'s `ErrSpawnNotResumable` (b.jg5
 * SRJ-710, SRJ-301): the row was not finished when the `resume` ran, so
 * nothing was killed, deleted or launched, and the persona is re-evaluated
 * at its next health tick or retry. Armed when the collision ladder's
 * not-resumable step, or a resume site's replacement after its re-read,
 * ends in a lost race (`reportLostRaceAtSite`, `src/outage-state.ts`), and
 * when the live-row sequence's own step-6 `resume` meets it and its re-read
 * finds a lost race (the sequence's end, `LIVE_ROW_ARM_LOST_RACE`). Never
 * counted.
 */
export const UNAVAILABLE_RETRY_CAUSE_LOST_RACE = 'spawn-not-resumable-lost-race'

/**
 * The cause of a persona held for an old life (b.jg5 SRJ-811, SRJ-810,
 * SRJ-301): an old-life wait it waits on ended with its hold going on (an
 * UNAVAILABLE, ENVIRONMENT, CONFIG or UNCLASSIFIED answer, a kill failure, a
 * CONFLICT or an unusable recorded name met for the old key, a run that did
 * not judge the old row, or the old row still live after runs that judged
 * it), or its launch was refused because a wait runs on its own row
 * (`sequence-waiting`). Armed outside any launch or recovery attempt for the
 * persona, by the session manager's old-life wait (`src/session-manager.ts`;
 * the same string as `OLD_LIFE_WAIT_ARM_CAUSE`, `src/old-life-wait.ts`).
 * Never counted, and it never starts or continues the `tmux-unresponsive`
 * condition. No timer is ever armed with it for the old key itself (SRJ-1512).
 */
export const UNAVAILABLE_RETRY_CAUSE_OLD_LIFE_HOLD = 'held-for-old-life'

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

/**
 * What the row read answers (b.jg5 SRJ-303, SRJ-115): the row's `state` as
 * agent-director reports it, or `UNAVAILABLE_RETRY_ROW_ABSENT` when there is
 * no row, and, on a `pending` row only, its launch start as the `status`
 * result showed it (raw, never parsed or aged here; absent when not shown).
 */
export interface UnavailableRetryRowRead {
  readonly state: string
  readonly launchStartedAt?: string
}

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

/**
 * A retry, in either mode, that found the persona's live-row sequence running
 * (its "blocks a retry" check, b.jg5 SRJ-303, SRJ-706), and made no call: a
 * refusal (SRJ-302).
 */
export const UNAVAILABLE_RETRY_AGAIN_SEQUENCE_IN_FLIGHT = 'live-row-sequence-in-flight'

/**
 * A retry, in either mode, that found an old-life wait step running for a
 * hold the persona waits on (its "blocks a retry" check, b.jg5 SRJ-303,
 * SRJ-811), and made no call: a refusal (SRJ-302).
 */
export const UNAVAILABLE_RETRY_AGAIN_OLD_LIFE_WAIT_IN_FLIGHT = 'old-life-wait-in-flight'

/** "Blocks a retry" cause: a launch call is in flight for the persona (b.jg5 SRJ-303). */
export const RETRY_BLOCK_LAUNCH = 'launch'
/** "Blocks a retry" cause: the persona's live-row sequence runs (b.jg5 SRJ-303, SRJ-706). */
export const RETRY_BLOCK_LIVE_ROW_SEQUENCE = 'live-row-sequence'
/** "Blocks a retry" cause: an old-life wait step runs for a hold the persona waits on (b.jg5 SRJ-303, SRJ-811). */
export const RETRY_BLOCK_OLD_LIFE_WAIT = 'old-life-wait'

/** Which work in flight blocks a retry of the persona's timer (b.jg5 SRJ-303). */
export type RetryBlockCause = typeof RETRY_BLOCK_LAUNCH | typeof RETRY_BLOCK_LIVE_ROW_SEQUENCE | typeof RETRY_BLOCK_OLD_LIFE_WAIT

/**
 * The again-reason of a retry skipped because `cause` blocks it (b.jg5
 * SRJ-302, SRJ-303): `launch-in-flight`, `live-row-sequence-in-flight` or
 * `old-life-wait-in-flight`; `launch-in-flight` when the cause is not known.
 * Pure.
 */
export function retryBlockAgainReason(cause: RetryBlockCause | undefined): string {
  switch (cause) {
    case RETRY_BLOCK_LIVE_ROW_SEQUENCE:
      return UNAVAILABLE_RETRY_AGAIN_SEQUENCE_IN_FLIGHT
    case RETRY_BLOCK_OLD_LIFE_WAIT:
      return UNAVAILABLE_RETRY_AGAIN_OLD_LIFE_WAIT_IN_FLIGHT
    default:
      return UNAVAILABLE_RETRY_AGAIN_LAUNCH_IN_FLIGHT
  }
}

/**
 * What the restart retry's skip line says blocks it (b.jg5 SRJ-303; the
 * line's `<what>`): `a launch is in flight`, `its live-row sequence runs` or
 * `an old-life wait step it waits on runs`; the first when the cause is not
 * known. Pure.
 */
export function retryBlockSkipText(cause: RetryBlockCause | undefined): string {
  switch (cause) {
    case RETRY_BLOCK_LIVE_ROW_SEQUENCE:
      return 'its live-row sequence runs'
    case RETRY_BLOCK_OLD_LIFE_WAIT:
      return 'an old-life wait step it waits on runs'
    default:
      return 'a launch is in flight'
  }
}

/**
 * The again-reason of a full-mode retry whose restart run answered
 * `sequence-waiting` (b.jg5 SRJ-302, SRJ-706, SRJ-810), by what blocks a
 * retry once the run is over (`cause`): `old-life-wait-in-flight` when it is
 * an old-life wait step the persona waits on (the restart path's old-life
 * gate started it, or the wait runs on the persona's own row), otherwise
 * `live-row-sequence-waiting`. Pure.
 */
export function sequenceWaitingAgainReason(cause: RetryBlockCause | undefined): string {
  return cause === RETRY_BLOCK_OLD_LIFE_WAIT ? UNAVAILABLE_RETRY_AGAIN_OLD_LIFE_WAIT_IN_FLIGHT : UNAVAILABLE_RETRY_AGAIN_SEQUENCE_WAITING
}

/** The cause of a "blocks a retry" check (`FullModeRetryDeps.retryBlockCause`), a throw and an answer that is not a cause counted as not known. Never throws. */
export function readRetryBlockCause(key: string, query: ((key: string) => RetryBlockCause | undefined) | undefined): RetryBlockCause | undefined {
  if (query === undefined) return undefined
  try {
    const cause = query(key)
    return cause === RETRY_BLOCK_LAUNCH || cause === RETRY_BLOCK_LIVE_ROW_SEQUENCE || cause === RETRY_BLOCK_OLD_LIFE_WAIT
      ? cause
      : undefined
  } catch {
    return undefined
  }
}

/** A full-mode retry whose launch failed and was counted, below the restart cap. */
export const UNAVAILABLE_RETRY_AGAIN_LAUNCH_FAILED = 'launch-failed'

/** A full-mode retry whose reconnect of a live row did not succeed or was deferred. */
export const UNAVAILABLE_RETRY_AGAIN_RECONNECT_DEFERRED = 'reconnect-deferred'

/** A full-mode retry whose launch succeeded: the timer runs on at the next wait, on the launch's `pending` row. */
export const UNAVAILABLE_RETRY_AGAIN_LAUNCHED = 'launched'

/** A full-mode retry that ran before the restart module was initialised, and did nothing. */
export const UNAVAILABLE_RETRY_AGAIN_RESTART_NOT_INITIALISED = 'restart-not-initialised'

/**
 * A full-mode retry whose run found the row `pending` and deferred it (the
 * liveness probe read it `pending`, whatever the session's connection showed,
 * or the reconnect's or b.d61's re-probe's read did): no reconnect, kill or
 * launch.
 */
export const UNAVAILABLE_RETRY_AGAIN_PENDING_DEFERRED = 'pending-deferred'

/**
 * A full-mode retry whose liveness read `unknown` (b.jg5 SRJ-314, SRJ-302: a
 * refusal): agent-director could not report on the persona, so nothing was
 * done and no row was read.
 */
export const UNAVAILABLE_RETRY_AGAIN_LIVENESS_UNKNOWN = 'liveness-unknown'

/** A pending-only retry that read the row still `pending` (b.jg5 SRJ-302: a refusal). */
export const UNAVAILABLE_RETRY_AGAIN_ROW_PENDING = 'row-pending'

/**
 * A full-mode retry whose restart run found the persona's live-row sequence
 * running (`sequence-waiting`, b.jg5 SRJ-706, SRJ-303, SRJ-302: a refusal):
 * no agent-director call, nothing recorded; the timer re-arms at the doubled
 * wait and never stops for it.
 */
export const UNAVAILABLE_RETRY_AGAIN_SEQUENCE_WAITING = 'live-row-sequence-waiting'

/**
 * A pending-only retry whose row read `pending` and whose pending-row step
 * started the live-row sequence for it: the row was not covered (b.jg5
 * SRJ-411: a retired key's old life before its new life, or a `cwd` or
 * `config_dir` mismatch), or the pending-row rule aborted CSCB's own stuck
 * launch, whose sequence enters at its second step (b.jg5 SRJ-412). No
 * launch or approver of the retry's own; the last row read stays `pending`,
 * and the timer re-arms at the doubled wait (SRJ-302: a refusal). Kept apart
 * from `live-row-sequence-waiting`, a full-mode run that found a sequence
 * already running.
 */
export const UNAVAILABLE_RETRY_AGAIN_SEQUENCE_STARTED = 'live-row-sequence-started'

// ---------------------------------------------------------------------------
// The pending-only retry's pending-row step (b.jg5 SRJ-409, SRJ-411)
// ---------------------------------------------------------------------------

/** The step kept the row: covered or undecided (P armed pending-only), or its read was refused. */
export const UNAVAILABLE_RETRY_PENDING_STEP_KEPT = 'kept'
/** The step started the live-row sequence: the row was not covered (SRJ-411), or the pending-row rule aborted CSCB's own stuck launch (SRJ-412). */
export const UNAVAILABLE_RETRY_PENDING_STEP_SEQUENCE_STARTED = 'sequence-started'
/** The step's read latched the persona (SRJ-114, SRJ-513), or found it latched. */
export const UNAVAILABLE_RETRY_PENDING_STEP_LATCHED = 'latched'
/** The step's read found the row in another state, or no row (`UNAVAILABLE_RETRY_ROW_ABSENT`). */
export const UNAVAILABLE_RETRY_PENDING_STEP_ROW = 'row'

/**
 * What the pending-only retry's pending-row step answers
 * (`FullModeRetryDeps.stepPendingRow`; production: the session manager's
 * `retryPendingRowStep`).
 */
export type UnavailableRetryPendingStep =
  | { readonly kind: typeof UNAVAILABLE_RETRY_PENDING_STEP_KEPT }
  | { readonly kind: typeof UNAVAILABLE_RETRY_PENDING_STEP_SEQUENCE_STARTED }
  | { readonly kind: typeof UNAVAILABLE_RETRY_PENDING_STEP_LATCHED }
  | { readonly kind: typeof UNAVAILABLE_RETRY_PENDING_STEP_ROW; readonly state: string }

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

/** The stop observer's reason for a timer forgotten because the clock failed at its re-arm (the `retry run failed` line). */
export const UNAVAILABLE_RETRY_STOP_RUN_FAILED = 'its retry run failed'

/**
 * The persona latched, whatever the case (b.jg5 SRJ-305, SRJ-502): the
 * latch's hold stops its timer through `stop` (never the condition-end
 * entry, so neither SRJ-306 exception keeps it), and a retry that finds it
 * latched, before any call, stops with it too. Not terminal (not in
 * `UNAVAILABLE_RETRY_TERMINAL_STOPS`): a later refusal may arm the timer
 * again; while the persona is latched that timer stops at its first retry,
 * and once its latch is gone (the latch's `forget`) it runs as usual. A
 * re-check that clears a latch is not built.
 */
export const UNAVAILABLE_RETRY_STOP_LATCHED = 'the persona is latched'

/**
 * The persona is held on `ErrInvalidFlags` (b.jg5 SRJ-207, SRJ-303,
 * SRJ-305): the hold's reaction stops its timer through `stop` (never the
 * condition-end entry, so neither SRJ-306 exception keeps it), and a retry
 * that finds it held, before any call, stops with it too, as does a
 * full-mode retry whose restart work answers `held`. Not terminal (not in
 * `UNAVAILABLE_RETRY_TERMINAL_STOPS`): once the hold ends, a later refusal
 * may arm the timer again.
 */
export const UNAVAILABLE_RETRY_STOP_HELD = 'the persona is held on ErrInvalidFlags'

/**
 * The terminal stop reasons (b.jg5 SRJ-309): the persona is going away or the
 * server is, so no later refusal may bring its retrying back. The
 * `tmux-unresponsive` condition's `cancelAlert` (`src/persona-episodes.ts`)
 * never arms the alert check again, and never lets the onset post again in
 * the episode, after a stop for one of these (SRJ-305, SRJ-308). Every other
 * stop reason (the cap, not up, a pending-only row read, a failed run, ...)
 * leaves a later refusal free to arm the timer, and the check, again, and to
 * allow the onset again.
 */
export const UNAVAILABLE_RETRY_TERMINAL_STOPS: ReadonlySet<string> = new Set([
  UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  UNAVAILABLE_RETRY_STOP_NOT_APPLIED,
  UNAVAILABLE_RETRY_STOP_SHUTDOWN,
])

// ---------------------------------------------------------------------------
// Run now (b.jg5 SRJ-810)
// ---------------------------------------------------------------------------

/** `runNow`: the pending retry was run at once, its wait count carried on. */
export const UNAVAILABLE_RETRY_RUN_NOW_RAN = 'ran'
/** `runNow`: the persona was not armed; it was armed with the given cause and its retry run at once. */
export const UNAVAILABLE_RETRY_RUN_NOW_ARMED = 'armed'
/** `runNow`: the persona's retry was running; nothing was done (that run's answer re-arms it). */
export const UNAVAILABLE_RETRY_RUN_NOW_RUNNING = 'running'
/** `runNow`: the controller is closed; nothing was done. */
export const UNAVAILABLE_RETRY_RUN_NOW_CLOSED = 'closed'

/** What `runNow` did. */
export type UnavailableRetryRunNowResult =
  | typeof UNAVAILABLE_RETRY_RUN_NOW_RAN
  | typeof UNAVAILABLE_RETRY_RUN_NOW_ARMED
  | typeof UNAVAILABLE_RETRY_RUN_NOW_RUNNING
  | typeof UNAVAILABLE_RETRY_RUN_NOW_CLOSED

/** `runNow`'s label when an old-life hold the persona waited on has ended (b.jg5 SRJ-810). */
export const UNAVAILABLE_RETRY_RUN_NOW_HOLD_ENDED = 'old-life-hold-ended'

/** What `runNow` did, with what its line names beside it (`unavailableRetryRunNowLine`). */
export type UnavailableRetryRunNowLineInput =
  | { readonly result: typeof UNAVAILABLE_RETRY_RUN_NOW_CLOSED; readonly closedReason: string }
  | { readonly result: typeof UNAVAILABLE_RETRY_RUN_NOW_RUNNING }
  | { readonly result: typeof UNAVAILABLE_RETRY_RUN_NOW_RAN; readonly pendingOnly: boolean }
  | { readonly result: typeof UNAVAILABLE_RETRY_RUN_NOW_ARMED; readonly description: string }

/** The head of every line the retry controller logs for persona `key`. */
function unavailableRetryLineHead(key: string): string {
  return `[slack] unavailable-retry: persona=${key}`
}

/**
 * The arm line (b.jg5 SRJ-302, SRJ-1014), `description` the cause's
 * description (`<kind>`, or `<kind>: <one-line error>` with no stack frame):
 *
 *   [slack] unavailable-retry: persona=<key> armed[ in pending-only mode] (<description>) — first retry in <s> s
 *
 * Pure.
 */
export function unavailableRetryArmedLine(key: string, pendingOnly: boolean, description: string | undefined, waitMs: number): string {
  const inMode = pendingOnly ? ` in ${UNAVAILABLE_RETRY_MODE_PENDING_ONLY} mode` : ''
  return `${unavailableRetryLineHead(key)} armed${inMode} (${description}) — first retry in ${waitMs / 1000} s`
}

/**
 * The retry line (b.jg5 SRJ-302, SRJ-1014), at the start of retry `retry`:
 *
 *   [slack] unavailable-retry: persona=<key> retry <n> — rerunning its recovery
 *   [slack] unavailable-retry: persona=<key> retry <n> (pending-only) — reading its row
 *
 * Pure.
 */
export function unavailableRetryRetryLine(key: string, retry: number, pendingOnly: boolean): string {
  return pendingOnly
    ? `${unavailableRetryLineHead(key)} retry ${retry} (${UNAVAILABLE_RETRY_MODE_PENDING_ONLY}) — reading its row`
    : `${unavailableRetryLineHead(key)} retry ${retry} — rerunning its recovery`
}

/**
 * The re-armed line (b.jg5 SRJ-302, SRJ-1014): retry `retry`, run in
 * pending-only mode when `ranPendingOnly`, answered `reason`; `newMode` names
 * the mode when the retry changed it:
 *
 *   [slack] unavailable-retry: persona=<key> retry <n>[ (pending-only)]: <reason> — re-armed[ in <mode> mode], next retry in <s> s
 *
 * Pure.
 */
export function unavailableRetryReArmedLine(
  key: string,
  retry: number,
  ranPendingOnly: boolean,
  reason: string,
  newMode: UnavailableRetryMode | undefined,
  waitMs: number,
): string {
  const ran = ranPendingOnly ? ` (${UNAVAILABLE_RETRY_MODE_PENDING_ONLY})` : ''
  const next = newMode === undefined ? '' : ` in ${newMode} mode`
  return `${unavailableRetryLineHead(key)} retry ${retry}${ran}: ${reason} — re-armed${next}, next retry in ${waitMs / 1000} s`
}

/**
 * The mode line (b.jg5 SRJ-301, SRJ-1014): a full-mode arm promoted a
 * pending-only timer, `description` the cause's:
 *
 *   [slack] unavailable-retry: persona=<key> promoted to full mode (<description>) — its due time is kept
 *
 * Pure.
 */
export function unavailableRetryPromotedLine(key: string, description: string | undefined): string {
  return `${unavailableRetryLineHead(key)} promoted to ${UNAVAILABLE_RETRY_MODE_FULL} mode (${description}) — its due time is kept`
}

/**
 * The stop line (b.jg5 SRJ-305, SRJ-1014), naming a pending-only mode and the
 * row read, when given:
 *
 *   [slack] unavailable-retry: persona=<key> stopped[ (pending-only[, row <state>])] — <reason>
 *
 * Pure.
 */
export function unavailableRetryStoppedLine(key: string, pendingOnly: boolean, row: string | undefined, reason: string): string {
  const tags: string[] = []
  if (pendingOnly) tags.push(UNAVAILABLE_RETRY_MODE_PENDING_ONLY)
  if (row !== undefined) tags.push(`row ${row}`)
  const tagged = tags.length > 0 ? ` (${tags.join(', ')})` : ''
  return `${unavailableRetryLineHead(key)} stopped${tagged} — ${reason}`
}

/**
 * The kept line (b.jg5 SRJ-306, SRJ-1014): a condition ended, but the timer
 * is kept for `kept` (its last row read `pending`, a `kill-failed` cause):
 *
 *   [slack] unavailable-retry: persona=<key> kept — <condition ended>, but <why>[ and <why>]
 *
 * Pure.
 */
export function unavailableRetryKeptLine(key: string, ended: string, kept: readonly string[]): string {
  return `${unavailableRetryLineHead(key)} kept — ${ended}, but ${kept.join(' and ')}`
}

/**
 * The line of an arm of persona `key` refused because the controller is
 * closed (`close(reason)`, the server's shutdown), `cause` the refused
 * cause's description (its kind, with its error's description when it
 * carries one) and `closedReason` the reason `close` was given:
 *
 *   [slack] unavailable-retry: persona=<key> not armed (<cause>) — <closedReason>
 *
 * Pure.
 */
export function unavailableRetryNotArmedClosedLine(key: string, cause: string, closedReason: string): string {
  return `[slack] unavailable-retry: persona=${key} not armed (${cause}) — ${closedReason}`
}

/**
 * The line of an arm of persona `key` refused inside its latch re-check
 * (b.jg5 SRJ-505), `cause` the refused cause's description (its kind, with
 * its error's description when it carries one):
 *
 *   [slack] unavailable-retry: persona=<key> not armed (<cause>) — inside its latch re-check, an answer gives no information
 *
 * Pure.
 */
export function unavailableRetryNotArmedInLatchRecheckLine(key: string, cause: string): string {
  return `[slack] unavailable-retry: persona=${key} not armed (${cause}) — inside its latch re-check, an answer gives no information`
}

/**
 * The one line of a `runNow` of persona `key` (b.jg5 SRJ-810), `why` its
 * label (a label that is not a short lower-case one is logged as `unnamed`):
 *
 *   [slack] unavailable-retry: persona=<key> not retried now (<why>) — <closed reason>
 *   [slack] unavailable-retry: persona=<key> not retried now (<why>) — its retry is running; that run's answer re-arms it
 *   [slack] unavailable-retry: persona=<key> retrying now[ (pending-only)] (<why>) — its pending retry is run at once, its wait count carried on
 *   [slack] unavailable-retry: persona=<key> retrying now (<why>) — armed (<cause description>) and run at once
 *
 * Pure.
 */
export function unavailableRetryRunNowLine(key: string, why: string, input: UnavailableRetryRunNowLineInput): string {
  const reason = labelOf(why)
  const head = `[slack] unavailable-retry: persona=${key}`
  switch (input.result) {
    case UNAVAILABLE_RETRY_RUN_NOW_CLOSED:
      return `${head} not retried now (${reason}) — ${input.closedReason}`
    case UNAVAILABLE_RETRY_RUN_NOW_RUNNING:
      return `${head} not retried now (${reason}) — its retry is running; that run's answer re-arms it`
    case UNAVAILABLE_RETRY_RUN_NOW_RAN:
      return `${head} retrying now${input.pendingOnly ? ' (pending-only)' : ''} (${reason}) — its pending retry is run at once, its wait count carried on`
    case UNAVAILABLE_RETRY_RUN_NOW_ARMED:
      return `${head} retrying now (${reason}) — armed (${input.description}) and run at once`
  }
}

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
 *   run, keeps it as it is when the answer `keepsLastRow`, and clears it
 *   otherwise. A `stop` answer's is named in the stopped line.
 * - `keepsLastRow` (`again`): true when the retry read no row (a liveness
 *   reading of `unknown`, b.jg5 SRJ-314), so an answer without `row` keeps
 *   the timer's last row read instead of clearing it.
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
      readonly keepsLastRow?: boolean
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
  /**
   * b.jg5 SRJ-308: called once at every retry of a persona's timer, in
   * either mode, with the clock's time, after its retry line and before its
   * action runs, so a retry the action skips for work in flight (SRJ-303)
   * is observed too (production: the `tmux-unresponsive` condition's
   * `onsetAtRetry`). A timer stopped before its retry runs is not observed.
   * A throw is swallowed. Absent: nothing is called.
   */
  onRetryFire?: (key: string, firedAt: number) => unknown
  /**
   * b.jg5 SRJ-309: called once per real stop of a persona's timer, with the
   * stop's reason (the stopped line's, or `UNAVAILABLE_RETRY_STOP_RUN_FAILED`
   * for a timer forgotten because its re-arm failed), after the stopped line
   * and before any hand-off. Production binds two consumers in one observer:
   * the `tmux-unresponsive` condition's `cancelAlert` (which holds the
   * condition's onset back and cancels its pending alert check), then the
   * unclassified-error episodes' `retryStopped` (b.jg5 SRJ-313), which ends
   * the persona's episode only for the stops that mean the retries are over
   * because the persona's state got better (`UNAVAILABLE_RETRY_STOP_RECOVERED`,
   * `UNAVAILABLE_RETRY_STOP_ROW_LIVE`,
   * `UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED`,
   * `UNAVAILABLE_RETRY_STOP_TMUX_UNRESPONSIVE_ENDED` and
   * `UNAVAILABLE_RETRY_STOP_ROW_GONE`). Each
   * reason is one of the `UNAVAILABLE_RETRY_STOP_*` constants (or the text a
   * `stop`, `stopAll` or `close` caller gives), so a consumer tells them
   * apart by equality. Not called for a no-op stop, a first arm that failed
   * or a pending-only stop that yielded to a full-mode cause. A throw is
   * swallowed. Absent: nothing is called.
   */
  onStopped?: (key: string, reason: string) => unknown
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
 * `close`, or the first timer could not be set), and false inside a latch
 * re-check of the latched persona (`isInsideLatchRecheck`), where the call
 * arms and records nothing, even when a timer is already armed. Must not
 * throw; a throw is caught by the reporting point and counts as not armed.
 */
export interface UnavailableRetryTriggerSink {
  arm(key: string, cause: UnavailableRetryCause): boolean
  /**
   * Arm persona `key`'s timer in pending-only mode with the `pending-row`
   * cause (the controller's `armPendingOnly`). The outage state's
   * launch-failure arm (`armPendingOnlyAfterLaunchFailure`) calls it for a
   * launch's `ErrTmuxSessionCreate` (b.jg5 SRJ-112, SRJ-113, SRJ-301,
   * SRJ-409). Optional: a sink without it arms nothing that way. Must not
   * throw; a throw counts as not armed.
   */
  armPendingOnly?(key: string): void
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
   * after `close` and when the first timer could not be set. Inside a latch
   * re-check of the latched persona (`isInsideLatchRecheck`, b.jg5 SRJ-505)
   * nothing is armed or recorded and one not-armed line is logged; the
   * answer is false, even when a timer is already armed, which is left as
   * it was: the call armed nothing.
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
   * answer's stopped line), as does a stop during the run. An `arm` (full
   * mode) later in the same run cancels the recorded end and its reading
   * (the condition started again), so nothing is applied for it; an end
   * after that arm is recorded again. An `armPendingOnly` in the run cancels
   * nothing: its `pending` row keeps the timer when the end is applied. A pending-only
   * stop that yields to a full-mode cause armed during the run counts as
   * `again` here: the rule is applied, and when it stops the timer the
   * yielded stop's hand-off runs after that stop. Answers what it
   * did; `not-armed`, with no line, when no timer is armed. Every other stop
   * is unaffected by these exceptions.
   *
   * `reading` is the row read the end brings, when it came from a health tick
   * or a retry that found the row live out of `pending` (a row state, or the
   * `live` reading), or from a successful launch call (`spawn` or `resume`,
   * whose row it leaves `pending`, so the `pending` exception keeps the
   * timer; b.jg5 SRJ-305): it becomes the last row read before the rule is
   * applied, now. While a run is in flight it is applied after the run's
   * answer has set the last row read, and only when that answer carries no
   * row of its own or the reading is `pending` (the run's own row is the
   * later state otherwise). An end with no reading (any other tmux-touching success, or GONE)
   * leaves the last row read as it is.
   */
  conditionEnded(key: string, condition: UnavailableRetryCondition, reading?: string): UnavailableRetryConditionEndResult
  /**
   * Run persona `key`'s retry at once (b.jg5 SRJ-810: once an old-life hold
   * ends, each persona that waited on it is retried at once), with `why`, a
   * short CSCB-written label, named in its one line:
   *   - waiting for its due time: the pending timer is cleared and the retry
   *     runs now, in its current mode, its wait count carrying on (a later
   *     refusal re-arms at the next wait of the one sequence); `ran`;
   *   - its retry running: nothing is done, since that run's answer re-arms
   *     or stops the timer; `running`;
   *   - not armed: it is armed with `cause` (full mode, wait count 0) and its
   *     retry runs now; `armed`;
   *   - after `close`: nothing is done; `closed`.
   * Two runs never overlap for one persona (the run waits for one still in
   * flight from before a `stop`). One line each:
   *
   *   [slack] unavailable-retry: persona=<key> retrying now[ (pending-only)] (<why>) — its pending retry is run at once, its wait count carried on
   *   [slack] unavailable-retry: persona=<key> retrying now (<why>) — armed (<cause>) and run at once
   *   [slack] unavailable-retry: persona=<key> not retried now (<why>) — its retry is running; that run's answer re-arms it
   *   [slack] unavailable-retry: persona=<key> not retried now (<why>) — <close reason>
   *
   * Never throws.
   */
  runNow(key: string, cause: UnavailableRetryCause, why: string): UnavailableRetryRunNowResult
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
  /** A condition whose end `conditionEnded` was told of during the current run; applied, then cleared, with the run's answer; cleared by an arm (either mode) later in the run. */
  endedInRun: UnavailableRetryCondition | undefined
  /** The reading an end told of during the current run brought, if any; applied with the end as `deferredReadingApplies` decides. */
  endedReadingInRun: string | undefined
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

  /** Forget `entry` if it is still current, clearing any timer it holds. Answers whether it was. Never throws. */
  function forget(entry: RetryEntry): boolean {
    if (!isCurrent(entry)) return false
    entries.delete(entry.key)
    try {
      clearTimer(entry)
    } catch {
      /* the entry is gone, so a timer the clock failed to clear fires into a no-op */
    }
    return true
  }

  /** Tell the stop observer of a real stop of persona `key`'s timer. Never throws. */
  function stopped(key: string, reason: string): void {
    try {
      deps.onStopped?.(key, reason)
    } catch {
      /* an observer must not change what a stop does */
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
        const wasCurrent = forget(entry)
        log(`[slack] unavailable-retry: persona=${entry.key} retry run failed: ${describeThrownValue(err)}`)
        if (wasCurrent) stopped(entry.key, UNAVAILABLE_RETRY_STOP_RUN_FAILED)
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
    log(unavailableRetryRetryLine(entry.key, retry, mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY))
    try {
      deps.onRetryFire?.(entry.key, clock.now())
    } catch {
      /* an observer must not change what the retry does */
    }
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
    /** The row the run's own answer carries (one it read or left), if any; see `deferredReadingApplies`. */
    let answerRow: string | undefined
    if (outcome?.kind === 'stop') {
      const handOff = handOffOf(outcome)
      if (!mayOverrideStop(entry, mode, outcome)) {
        stopEntry(entry, outcome.reason, rowOf(outcome))
        if (handOff !== undefined) await runHandOff(entry.key, handOff)
        return
      }
      heldHandOff = handOff
      entry.mode = UNAVAILABLE_RETRY_MODE_FULL
      answerRow = rowOf(outcome)
      entry.lastRow = answerRow ?? (entry.pendingArmedInRun ? UNAVAILABLE_RETRY_ROW_PENDING : undefined)
      reason = entry.runCause ?? NO_CAUSE_GIVEN
    } else {
      const answered = outcome?.kind === 'again' ? againReason(outcome) : undefined
      const unexpected = failure === undefined && outcome?.kind !== 'again' ? 'the retry gave no answer' : undefined
      reason = answered ?? failure ?? unexpected ?? entry.runCause ?? NO_CAUSE_GIVEN
      if (outcome?.kind === 'again') {
        const row = rowOf(outcome)
        answerRow = row
        if (row !== undefined) entry.lastRow = row
        else if (entry.pendingArmedInRun) entry.lastRow = UNAVAILABLE_RETRY_ROW_PENDING
        else if (!keepsLastRow(outcome)) entry.lastRow = undefined
        if (switchesToPendingOnly(outcome) && mayTakeSwitch(entry)) entry.mode = UNAVAILABLE_RETRY_MODE_PENDING_ONLY
      }
    }
    const ended = entry.endedInRun
    const endedReading = entry.endedReadingInRun
    entry.runCause = undefined
    entry.fullArmedInRun = false
    entry.pendingArmedInRun = false
    entry.endedInRun = undefined
    entry.endedReadingInRun = undefined
    if (ended !== undefined && endedReading !== undefined && deferredReadingApplies(answerRow, endedReading)) {
      entry.lastRow = endedReading
    }
    if (ended !== undefined && !applyConditionEnd(entry, ended)) {
      if (heldHandOff !== undefined) await runHandOff(entry.key, heldHandOff)
      return
    }
    entry.refusals += 1
    const waitMs = waitAfter(entry.refusals)
    schedule(entry, waitMs)
    log(
      unavailableRetryReArmedLine(
        entry.key,
        retry,
        mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
        reason,
        entry.mode !== mode ? entry.mode : undefined,
        waitMs,
      ),
    )
  }

  /**
   * Whether the reading a condition end deferred to a run brought becomes
   * the last row read once the run's answer is applied (b.jg5 SRJ-305,
   * SRJ-306). The run's answer is applied at the run's end, so the row it
   * carries (`answerRow`: an `again` answer's `row`, such as a successful
   * launch's `pending` row, or a yielded pending-only stop's row read) wins
   * over the deferred reading, and the reading applies only when the answer
   * carries no row of its own (a failed retry, the liveness-unknown `again`,
   * an `again` without `row`). One exception: a deferred `pending` reading
   * (only a successful launch call's end brings one) wins over a row the
   * answer carries, since the run cannot order its own row read against a
   * launch that ended the condition meanwhile. Keeping the timer on a
   * `pending` row costs one more retry, which reads the row again and stops
   * when it is live; dropping it would lose SRJ-305's pending-only watch on
   * that row, which nothing restores. An end outside a run is not affected:
   * its reading replaces the last row read at once (`conditionEnded`).
   */
  function deferredReadingApplies(answerRow: string | undefined, endedReading: string): boolean {
    return answerRow === undefined || endedReading === UNAVAILABLE_RETRY_ROW_PENDING
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
      log(unavailableRetryKeptLine(entry.key, ended, kept))
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

  /**
   * Stop `entry`, logging one stopped line naming a pending-only mode and the
   * row read, when given, then telling the stop observer.
   */
  function stopEntry(entry: RetryEntry, reason: string, row?: string): void {
    clearTimer(entry)
    entries.delete(entry.key)
    log(unavailableRetryStoppedLine(entry.key, entry.mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY, row, reason))
    stopped(entry.key, reason)
  }

  /** A fresh, unscheduled entry for persona `key` in `mode`, its wait count at 0. */
  function newEntry(key: string, mode: UnavailableRetryMode): RetryEntry {
    return {
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
      endedReadingInRun: undefined,
    }
  }

  /**
   * Run persona `key`'s retry at once (see `runNow` on the controller). Never
   * throws: a clock that throws while the pending timer is cleared leaves the
   * timer to fire into a no-op, since the run now replaces it.
   */
  function runNowFor(key: string, cause: UnavailableRetryCause, why: string): UnavailableRetryRunNowResult {
    if (closedReason !== undefined) {
      log(unavailableRetryRunNowLine(key, why, { result: UNAVAILABLE_RETRY_RUN_NOW_CLOSED, closedReason }))
      return UNAVAILABLE_RETRY_RUN_NOW_CLOSED
    }
    const existing = entries.get(key)
    if (existing !== undefined && existing.timer === undefined) {
      log(unavailableRetryRunNowLine(key, why, { result: UNAVAILABLE_RETRY_RUN_NOW_RUNNING }))
      return UNAVAILABLE_RETRY_RUN_NOW_RUNNING
    }
    if (existing !== undefined) {
      try {
        clearTimer(existing)
      } catch {
        /* the run below replaces the timer; one that still fires finds no timer of its own and does nothing */
      }
      log(unavailableRetryRunNowLine(key, why, { result: UNAVAILABLE_RETRY_RUN_NOW_RAN, pendingOnly: existing.mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY }))
      fire(existing)
      return UNAVAILABLE_RETRY_RUN_NOW_RAN
    }
    const entry = newEntry(key, UNAVAILABLE_RETRY_MODE_FULL)
    entries.set(key, entry)
    const armedWith = cause ?? UNNAMED_CAUSE
    record(entry, armedWith)
    log(unavailableRetryRunNowLine(key, why, { result: UNAVAILABLE_RETRY_RUN_NOW_ARMED, description: describeCause(armedWith) }))
    fire(entry)
    return UNAVAILABLE_RETRY_RUN_NOW_ARMED
  }

  /**
   * Arm persona `key` with `cause` in `mode` (see `arm` and `armPendingOnly`).
   * An armed entry keeps its due time; a full-mode arm promotes a
   * pending-only entry. During a run, a full-mode arm cancels a condition
   * end deferred to that run (`conditionEnded`); a pending-only arm does not. Answers true when the persona has a timer after the
   * call; inside a latch re-check of the latched persona it arms and records
   * nothing and answers false, an armed timer included (see `arm`). Never
   * throws.
   */
  function armIn(key: string, cause: UnavailableRetryCause, mode: UnavailableRetryMode): boolean {
    if (closedReason !== undefined) {
      log(unavailableRetryNotArmedClosedLine(key, describeCause(cause), closedReason))
      return false
    }
    // b.jg5 SRJ-505: inside a latch re-check of a latched persona no cause
    // arms its timer, whichever path asks (the reporting step, the restart
    // work's arm hook, a gate's own arm).
    if (isInsideLatchRecheck(key)) {
      log(unavailableRetryNotArmedInLatchRecheckLine(key, describeCause(cause)))
      return false
    }
    const existing = entries.get(key)
    if (existing !== undefined) {
      const description = record(existing, cause)
      if (existing.timer === undefined) {
        existing.runCause = description
        if (mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY) {
          // A covered `pending` row is no refusal: a condition end deferred
          // to this run still applies, and the row this arm marks `pending`
          // keeps the timer when it does (b.jg5 SRJ-306).
          existing.pendingArmedInRun = true
        } else {
          existing.fullArmedInRun = true
          // A full-mode arm after a condition end deferred to this run is the
          // later state (a refusal that started the condition again): it
          // cancels that end, so the timer is not stopped while the
          // condition holds. An end that lands after this arm is recorded,
          // and applied, as usual.
          existing.endedInRun = undefined
          existing.endedReadingInRun = undefined
        }
      }
      if (mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY) {
        existing.lastRow = UNAVAILABLE_RETRY_ROW_PENDING
      } else if (existing.mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY) {
        existing.mode = UNAVAILABLE_RETRY_MODE_FULL
        log(unavailableRetryPromotedLine(key, description))
      }
      return true
    }
    const entry = newEntry(key, mode)
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
    log(unavailableRetryArmedLine(key, mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY, description, waitMs))
    return true
  }

  return {
    arm(key, given) {
      return armIn(key, given ?? UNNAMED_CAUSE, UNAVAILABLE_RETRY_MODE_FULL)
    },

    armPendingOnly(key) {
      armIn(key, PENDING_ROW_CAUSE, UNAVAILABLE_RETRY_MODE_PENDING_ONLY)
    },

    conditionEnded(key, condition, reading) {
      const entry = entries.get(key)
      if (entry === undefined) return 'not-armed'
      const row = reading === undefined ? undefined : rowOf({ row: reading })
      if (entry.timer === undefined) {
        entry.endedInRun = condition
        if (row !== undefined) entry.endedReadingInRun = row
        return 'deferred'
      }
      if (row !== undefined) entry.lastRow = row
      return applyConditionEnd(entry, condition) ? 'kept' : 'stopped'
    },

    runNow(key, cause, why) {
      try {
        return runNowFor(key, cause, why)
      } catch (err) {
        // Not reached: the steps above never throw.
        log(`[slack] unavailable-retry: persona=${key} not retried now — ${describeThrownValue(err)}`)
        return UNAVAILABLE_RETRY_RUN_NOW_CLOSED
      }
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
   * persona's row, answering its state or `UNAVAILABLE_RETRY_ROW_ABSENT`, with
   * a `pending` row's raw launch start when shown (`UnavailableRetryRowRead`),
   * and throwing any other error. A pending-only retry makes it inside a
   * recovery attempt for the persona and acts on the state.
   */
  readRow: (key: string) => Promise<UnavailableRetryRowRead>
  /**
   * The restart module's retry entry (`runRestartRetry`): the restart path's
   * decision for the persona, through its serializer, without the delay gate,
   * with `isInFlight` as its first step; `blockCause`, when given, names what
   * blocks it in the entry's skip line (b.jg5 SRJ-303).
   */
  retry: (
    key: string,
    cwd: string,
    isInFlight: (key: string) => boolean,
    blockCause?: (key: string) => RetryBlockCause | undefined,
  ) => Promise<RestartRetryOutcome>
  /** The applied persona with this key (its working directory), or `undefined` when it is not applied. */
  appliedPersona: (key: string) => { readonly working_directory: string } | undefined
  /** The not-up gate (the server's relaunch gate): false while the persona is not up. */
  canRelaunch: (key: string) => boolean
  /** Whether the persona is at the restart cap (`isAtCap(key, RESTART_FAILURE_CAP)`). */
  isAtCap: (key: string) => boolean
  /** Whether the server is shutting down (the flag `shutdown()` raises). */
  isShuttingDown: () => boolean
  /**
   * The latched query (b.jg5 SRJ-303, SRJ-305; production: the server's
   * latch's `isLatched`): a retry, in either mode, that finds the persona
   * latched makes no agent-director call and stops the timer with
   * `UNAVAILABLE_RETRY_STOP_LATCHED`, so a timer armed after the latch (a
   * latch-time read error, an ENVIRONMENT answer from any verb) stops at its
   * first fire. An answer of exactly `true` is latched, and so is a query
   * that throws (fail safe: the same stop, with one line naming the persona
   * and what it threw); any other answer is not. Absent: no persona is
   * latched.
   */
  isLatched?: (key: string) => boolean
  /**
   * The held query (b.jg5 SRJ-207, SRJ-303, SRJ-305; production: the
   * server's `ErrInvalidFlags` hold's `isHeld`): a retry, in either mode,
   * that finds the persona held makes no agent-director call and stops the
   * timer with `UNAVAILABLE_RETRY_STOP_HELD`, so a timer armed while the
   * persona is held stops at its first fire, whatever its causes. Asked
   * right after the latched query. An answer of exactly `true` is held, and
   * so is a query that throws (fail safe: the same stop, with one line naming
   * the persona and what it threw); any other answer is not. Absent: no
   * persona is held.
   */
  isHeld?: (key: string) => boolean
  /**
   * Whether work in flight for the persona blocks a retry (b.jg5 SRJ-303;
   * production: the server's `isPersonaRetryBlocked`: a launch call,
   * `isLaunchInFlight`, a running live-row sequence,
   * `isLiveRowSequenceRunning`, or an old-life wait step for a hold the
   * persona waits on, `isOldLifeWaitRunningFor`). A running dialog approver never counts here: it
   * runs after its launch call has returned and never blocks a retry
   * (SRJ-401). A retry in either mode that finds it true makes no
   * agent-director call and is a refusal; a throw counts as in flight.
   */
  isInFlight: (key: string) => boolean
  /**
   * Which work in flight blocks a retry (b.jg5 SRJ-303; production: the
   * session manager's `personaRetryBlockCause`): a launch call, the
   * persona's live-row sequence, or an old-life wait step for a hold it waits
   * on. Asked only when `isInFlight` answered true (or a full-mode run
   * answered `in-flight`), to name the cause in the again-reason
   * (`retryBlockAgainReason`) and the restart retry's skip line. Absent, or
   * an answer that is not a cause: `launch-in-flight`.
   */
  retryBlockCause?: (key: string) => RetryBlockCause | undefined
  /**
   * Whether the persona's session is connected (production: its registry
   * entry with `connected === true`). Read only by a pending-only retry that
   * read the row live out of `pending`, to decide whether to call
   * `endTmuxUnresponsive`. Absent: not connected (nothing is ended there).
   */
  isSessionConnected?: (key: string) => boolean
  /**
   * Whether the persona's session has its message stream (production:
   * `hasSessionStream`). Read as `isSessionConnected` is. Absent: no stream.
   */
  hasSessionStream?: (key: string) => boolean
  /**
   * End the persona's `tmux-unresponsive` condition (b.jg5 SRJ-310 rule 2,
   * retry half), with the live reading the retry found: called when a
   * full-mode retry finds the persona already connected with its stream on a
   * `live` reading (`LIVENESS_LIVE`), and when a pending-only retry reads the
   * row live out of `pending` (its state) with the session connected with its
   * stream. Production binds the condition's end (reason `retry`) and the
   * clear of the persona's `tmux-unavailable` outage with the same reading
   * (b.jg5 SRJ-311, SRJ-312). Absent: nothing is called. A throw is
   * swallowed and changes nothing about the retry's answer.
   */
  endTmuxUnresponsive?: (key: string, reading: string) => void
  /**
   * The pending-row step (b.jg5 SRJ-409, SRJ-411; production: the session
   * manager's `retryPendingRowStep` over the applied persona): called by a
   * pending-only retry, inside its recovery attempt, when its `status` read
   * answered `pending`. It makes one `get` through the shared own-row read
   * (its note and launch-start latches and its old-life read entry applying)
   * and decides whether the row is covered: a covered or undecided row arms
   * the persona's timer pending-only; a covered row then gets the
   * pending-row rule's one run of this retry (b.jg5 SRJ-410), whose answer
   * maps here: a refusal or the held post is `kept`, a row the rule read
   * gone or live is `row` with that state, a latch is `latched`, and the
   * own-launch abort's sequence is `sequence-started`; an undecided row is
   * kept with no rule run (a read the shared read refused is kept too); a
   * row that is not covered starts the live-row sequence
   * (`sequence-started`); a read that latched the persona answers
   * `latched`; another state, or no row, answers `row` with what it read.
   * The `get`'s row supersedes the `status` read's, its launch start
   * included. Absent: the `status` read's `pending` is a refusal, as before.
   * A step that throws or rejects rejects the action, which the controller
   * counts as `again`.
   */
  stepPendingRow?: (key: string) => Promise<UnavailableRetryPendingStep>
}

/**
 * The server's retry action, for both modes (b.jg5 SRJ-303, SRJ-305; see
 * the module comment). Before any call, in either mode, stops on shutdown, a
 * persona not applied, latched, held on `ErrInvalidFlags`, not up or at the
 * cap, in that order. Then, in full
 * mode, runs the retry entry once and answers from its outcome; in
 * pending-only mode, answers a `launch-in-flight` refusal with no call when
 * the in-flight predicate answers true or throws, else reads the row inside
 * a recovery attempt for the persona, asks the latched query again (a read
 * that latched the persona, b.jg5 SRJ-512, SRJ-513, stops with the latch's reason and
 * hands nothing on) and answers from its state (`pendingOnlyAnswer`); a
 * `pending` state goes to the optional pending-row step, inside a recovery
 * attempt too, and its answer decides (`pendingStepAnswer`). The launch start
 * the `status` read carried is superseded by the step's `get`; ageing the row
 * at the retries is the pending-row rule's, not this action's: the step runs
 * it on a covered row. The whole run, in either mode, is marked as a retry
 * of the persona's timer (`runInTimerRetry`, b.jg5 SRJ-410): the pending-row
 * rule runs only inside one, at most once per retry, whether reached here
 * (pending-only) or through the restart path's deferral or the ladder's
 * `pending` step (full mode). A latched query that throws counts as latched
 * (logged, with what it threw), and so does a held query that throws. A
 * dependency that throws (but the in-flight predicate and the latched and
 * held queries),
 * an entry that rejects, or a row read that throws rejects the action, which
 * the controller counts as `again`.
 */
export function createFullModeRetryAction(deps: FullModeRetryDeps): UnavailableRetryAction {
  // b.jg5 SRJ-410: the whole run is a retry of the persona's timer, in either
  // mode (`runInTimerRetry`), so the pending-row rule may run once in it.
  return (key, attempt) => runInTimerRetry(key, () => retryActionRun(deps, key, attempt))
}

/**
 * What the gate before any call of a run for persona P reads
 * (`retryRunGateStop`): the members of `FullModeRetryDeps` the retry action
 * asks first. The pending-row rule's one run at a dialog approver's stop is
 * given the same object (`PendingRowRuleInstall.gate`, `src/session-manager.ts`).
 */
export type RetryRunGateDeps = Pick<
  FullModeRetryDeps,
  'isShuttingDown' | 'appliedPersona' | 'isLatched' | 'isHeld' | 'canRelaunch' | 'isAtCap'
>

/**
 * The gate before any call of a run for persona `key` (b.jg5 SRJ-303,
 * SRJ-305; b.av2 SR-8.6), in order: the server shutting down, the persona
 * not in the applied configuration, latched, held on `ErrInvalidFlags`, not
 * up, at the restart cap. Answers the stop reason of the first that holds
 * (`UNAVAILABLE_RETRY_STOP_SHUTDOWN`, `…_NOT_APPLIED`, `…_LATCHED`,
 * `…_HELD`, `…_NOT_UP`, `…_CAPPED`), or `undefined` when none does. A
 * latched or held query that throws counts as latched or held, with its one
 * line; any other dependency that throws throws. Used by the retry action
 * (`createFullModeRetryAction`) and by the pending-row rule's run at a
 * dialog approver's stop.
 */
export function retryRunGateStop(deps: RetryRunGateDeps, key: string): string | undefined {
  if (deps.isShuttingDown()) return UNAVAILABLE_RETRY_STOP_SHUTDOWN
  // b.av2 SR-8.6 (b.jg5 SRJ-1512): a retry does nothing for a key outside
  // the applied set. Its one exception, an old-life wait's kill and
  // find-missing steps on a retired key (SRJ-811), runs in the session
  // manager's live-row sequence registry, never on this timer, and never
  // launches that key; no timer is armed for the old key.
  if (deps.appliedPersona(key) === undefined) return UNAVAILABLE_RETRY_STOP_NOT_APPLIED
  if (latched(key, deps.isLatched)) return UNAVAILABLE_RETRY_STOP_LATCHED
  // b.jg5 SRJ-207, SRJ-303: no attempt while the persona is held on ErrInvalidFlags.
  if (held(key, deps.isHeld)) return UNAVAILABLE_RETRY_STOP_HELD
  if (!deps.canRelaunch(key)) return UNAVAILABLE_RETRY_STOP_NOT_UP
  if (deps.isAtCap(key)) return UNAVAILABLE_RETRY_STOP_CAPPED
  return undefined
}

/** One run of the retry action (`createFullModeRetryAction`) for persona `key`, inside its retry marker. */
async function retryActionRun(
  deps: FullModeRetryDeps,
  key: string,
  attempt: UnavailableRetryAttempt,
): Promise<UnavailableRetryOutcome> {
  const gateStop = retryRunGateStop(deps, key)
  if (gateStop !== undefined) return stopWith(gateStop)
  const persona = deps.appliedPersona(key)
  if (persona === undefined) return stopWith(UNAVAILABLE_RETRY_STOP_NOT_APPLIED)
  const cwd = persona.working_directory
  if (attempt.mode === UNAVAILABLE_RETRY_MODE_PENDING_ONLY) {
    if (inFlight(key, deps.isInFlight)) {
      // b.jg5 SRJ-303: the again-reason names what blocks the retry.
      const reason = retryBlockAgainReason(readRetryBlockCause(key, deps.retryBlockCause))
      return { kind: 'again', reason, row: UNAVAILABLE_RETRY_ROW_PENDING }
    }
    const row = await runInAttempt(key, 'recovery', () => deps.readRow(key))
    // b.jg5 SRJ-305, SRJ-512, SRJ-513: a row read that latched the persona
    // stops the timer with the latch's reason; nothing is handed to the
    // restart path. A configured persona's own `pending` row with no launch
    // start latches at that read, so it never reaches `pendingOnlyAnswer`;
    // a row under an unconfigured key latches nothing and still does.
    if (latched(key, deps.isLatched)) return stopWith(UNAVAILABLE_RETRY_STOP_LATCHED)
    if (isLiveOutOfPending(row.state) && probe(key, deps.isSessionConnected) && probe(key, deps.hasSessionStream)) {
      endCondition(key, row.state, deps.endTmuxUnresponsive)
    }
    const restart = (): Promise<unknown> => deps.retry(key, cwd, deps.isInFlight, deps.retryBlockCause)
    // b.jg5 SRJ-409, SRJ-411: a `pending` row is decided by the pending-row
    // step's one `get`, whose row supersedes this `status` read's (the
    // carried launch start included; ageing at the retries is the
    // pending-row rule's).
    if (row.state === UNAVAILABLE_RETRY_ROW_PENDING && deps.stepPendingRow !== undefined) {
      const stepPendingRow = deps.stepPendingRow
      const step = await runInAttempt(key, 'recovery', () => stepPendingRow(key))
      return pendingStepAnswer(key, step, deps.isLatched, restart)
    }
    return pendingOnlyAnswer(row.state, restart)
  }
  const outcome = await deps.retry(key, cwd, deps.isInFlight, deps.retryBlockCause)
  // b.jg5 SRJ-303, SRJ-310: `already-connected` is answered only for a `live`
  // reading (never `pending`) whose session is connected with its stream.
  if (outcome === 'already-connected') endCondition(key, LIVENESS_LIVE, deps.endTmuxUnresponsive)
  return answerFor(outcome, () => readRetryBlockCause(key, deps.retryBlockCause))
}

/** True when `state` is a live row state other than `pending`. */
function isLiveOutOfPending(state: string): boolean {
  return state !== UNAVAILABLE_RETRY_ROW_PENDING && AGENT_DIRECTOR_LIVE_STATES.has(state)
}

/** An optional probe's answer: exactly true, else false (absent or throwing included). Never throws. */
function probe(key: string, check: ((key: string) => boolean) | undefined): boolean {
  try {
    return check?.(key) === true
  } catch {
    return false
  }
}

/** Call the optional end hook with the retry's live reading; a throw is swallowed. */
function endCondition(key: string, reading: string, end: ((key: string, reading: string) => void) | undefined): void {
  try {
    end?.(key, reading)
  } catch {
    /* ending the condition never changes the retry's answer */
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

/**
 * What a pending-only retry answers for its pending-row step's `step`
 * (b.jg5 SRJ-409, SRJ-411, SRJ-305): `kept` is today's refusal
 * (`row-pending`, the row kept `pending`); `sequence-started` (an uncovered
 * row's sequence, or the abort of CSCB's own stuck launch, b.jg5 SRJ-412) is
 * a refusal naming the sequence it started (`live-row-sequence-started`),
 * the row kept `pending`, with no launch or approver of its own; `latched`, or a persona
 * the latched query now answers latched, stops with the latch's reason and
 * hands nothing on; `row` answers as the `status` read would have for that
 * state (`pendingOnlyAnswer`): `ended`, `missing` or no row stops and hands
 * the persona to the restart path once. A `step` that is not one of these is
 * taken as `kept`.
 */
function pendingStepAnswer(
  key: string,
  step: UnavailableRetryPendingStep,
  isLatched: ((key: string) => boolean) | undefined,
  restart: () => Promise<unknown>,
): UnavailableRetryOutcome {
  if (step?.kind === UNAVAILABLE_RETRY_PENDING_STEP_LATCHED || latched(key, isLatched)) {
    return stopWith(UNAVAILABLE_RETRY_STOP_LATCHED)
  }
  if (step?.kind === UNAVAILABLE_RETRY_PENDING_STEP_SEQUENCE_STARTED) {
    return { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_SEQUENCE_STARTED, row: UNAVAILABLE_RETRY_ROW_PENDING }
  }
  if (step?.kind === UNAVAILABLE_RETRY_PENDING_STEP_ROW && typeof step.state === 'string') {
    return pendingOnlyAnswer(step.state, restart)
  }
  return pendingOnlyAnswer(UNAVAILABLE_RETRY_ROW_PENDING, restart)
}

/**
 * The optional latched query for persona `key`: exactly `true` is latched;
 * absent is not; a query that throws counts as latched (fail safe, b.jg5
 * SRJ-502), with one `[slack] unavailable-retry: persona=<key> …` line
 * naming what it threw (`describeThrownValue`). Never throws.
 */
function latched(key: string, isLatched: ((key: string) => boolean) | undefined): boolean {
  if (isLatched === undefined) return false
  try {
    return isLatched(key) === true
  } catch (err) {
    try {
      console.error(`[slack] unavailable-retry: persona=${key} the latched query failed: ${describeThrownValue(err)} — taken as latched; no agent-director call`)
    } catch {
      /* a failing logger never changes the answer */
    }
    return true
  }
}

/**
 * The optional held query for persona `key` (b.jg5 SRJ-207): exactly `true`
 * is held; absent is not; a query that throws counts as held (fail safe),
 * with one `[slack] unavailable-retry: persona=<key> …` line naming what it
 * threw (`describeThrownValue`). Never throws.
 */
function held(key: string, isHeld: ((key: string) => boolean) | undefined): boolean {
  if (isHeld === undefined) return false
  try {
    return isHeld(key) === true
  } catch (err) {
    try {
      console.error(`[slack] unavailable-retry: persona=${key} the held query failed: ${describeThrownValue(err)} — taken as held; no agent-director call`)
    } catch {
      /* a failing logger never changes the answer */
    }
    return true
  }
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
 * What a full-mode retry answers for the retry entry's outcome. A run
 * skipped for work in flight, and a run the old-life gate or a running
 * live-row sequence held, name what blocks the retry (b.jg5 SRJ-303,
 * SRJ-810, SRJ-302): `blockCause` reads it (`readRetryBlockCause`), asked
 * only for those two outcomes. A refused
 * launch gives no reason of its own: the UNAVAILABLE outcome that refused it
 * armed the timer during the run, and the re-armed line names that cause. A
 * run that found the row `pending` and deferred it (b.jg5 SRJ-302, SRJ-305:
 * a refusal, never "nothing left to recover", even for a session connected
 * with its stream) records the row read `pending`. A
 * liveness reading of `unknown` (b.jg5 SRJ-314) is a refusal that read no
 * row: the last row read is kept as it is. A successful launch records the row read `pending` too (the launch's row,
 * whether or not the switch is taken) and asks to switch the timer to
 * pending-only mode; the controller takes the switch only when no other
 * cause armed during the run and no `kill-failed` cause is recorded.
 */
function answerFor(outcome: RestartRetryOutcome, blockCause: () => RetryBlockCause | undefined): UnavailableRetryOutcome {
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
    case 'latched':
      // b.jg5 SRJ-305: the persona is latched, or latched during this retry.
      return stopWith(UNAVAILABLE_RETRY_STOP_LATCHED)
    case 'held':
      // b.jg5 SRJ-207, SRJ-305: the persona is held on ErrInvalidFlags, or
      // held during this retry.
      return stopWith(UNAVAILABLE_RETRY_STOP_HELD)
    case 'in-flight':
      // b.jg5 SRJ-303: a run skipped for work in flight names what blocked it.
      return againWith(retryBlockAgainReason(blockCause()))
    case 'sequence-waiting':
      // b.jg5 SRJ-706, SRJ-303: the restart path made no call while P's
      // live-row sequence runs; a refusal (SRJ-302), never a stop. b.jg5
      // SRJ-810, SRJ-302: a run the old-life gate held, which started the
      // hold's wait, names that wait, as a run skipped for it does.
      return againWith(sequenceWaitingAgainReason(blockCause()))
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
    case 'liveness-unknown':
      // b.jg5 SRJ-302, SRJ-305: a refusal, never "nothing left to recover".
      // It read no row, so the last row read is kept as it is.
      return { kind: 'again', reason: UNAVAILABLE_RETRY_AGAIN_LIVENESS_UNKNOWN, keepsLastRow: true }
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

/** True when an `again` answer keeps the timer's last row read (its field is exactly `true`). Never throws. */
function keepsLastRow(outcome: { readonly keepsLastRow?: unknown }): boolean {
  try {
    return outcome.keepsLastRow === true
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

/**
 * `<kind>`, or `<kind>: <describeThrownValueWithoutStack(error)>` when the
 * cause carries a thrown value: one line with no stack frames, so the armed,
 * promoted and not-armed lines carry no host path. Never throws.
 */
function describeCause(cause: UnavailableRetryCause): string {
  const kind = causeKind(cause)
  try {
    return 'error' in cause && cause.error !== undefined ? `${kind}: ${describeThrownValueWithoutStack(cause.error)}` : kind
  } catch {
    return kind
  }
}

// ---------------------------------------------------------------------------
// The arming predicate (b.jg5 SRJ-301)
// ---------------------------------------------------------------------------

/**
 * What arms persona P's retry timer when `value` is thrown by an
 * agent-director call made with `verb` for P (b.jg5 SRJ-301), classified by
 * `classifyAdError`, in this order:
 *
 * - UNAVAILABLE from any verb: an `unavailable` cause, or a `kill-failed`
 *   cause when the value is an `ErrTmuxKillFailed` instance (an
 *   `ErrUnknownErrorName` carrying that name is an `unavailable` cause);
 * - ENVIRONMENT (`ErrTmuxNotAvailable`) from any verb, `kill` and the read
 *   verbs included: an `environment` cause
 *   (`UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT`, SRJ-311). It is decided before
 *   the read-error rule, so a `status`, `get` or `list` answering it records
 *   this cause, not `read-error`;
 * - CONFIG (`ErrConfigMalformed`) from any verb, `kill` and the read verbs
 *   included: a `config` cause (`UNAVAILABLE_RETRY_CAUSE_CONFIG`, SRJ-316),
 *   also decided before the read-error rule;
 * - UNCLASSIFIED from any declared verb but `status`, `get` and `list` (an
 *   unknown verb, which might be a read, arms nothing): an `unclassified` cause
 *   (`UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED`, SRJ-301, SRJ-313). An
 *   `ErrInvalidFlags` is STATE here; the resume path, the shared pane reader
 *   and the reconnect's `send-keys`, which give it no meaning, arm through
 *   the outage state's site entry (`reportUnclassifiedAtSite`) after their
 *   re-check;
 * - any other `status`, `get` or `list` error: a `read-error` cause, except
 *   `ErrSpawnNotFound` (each site keeps its meaning) and an UNUSABLE NAME
 *   answer (its own handling, SRJ-105);
 * - `undefined` (nothing arms) otherwise.
 *
 * The ENVIRONMENT and CONFIG causes (`UNAVAILABLE_RETRY_ANY_CONTEXT_CAUSES`)
 * arm in any context; every other cause arms only inside a launch or
 * recovery attempt for P (`reportAttemptError`).
 *
 * The cause carries `value`, which reaches a line only through
 * `describeThrownValue`. `verb` is agent-director's verb name (`status`,
 * `get`, `list`, `kill`, `spawn`, `read-pane` …); the read verbs are
 * `AD_READ_VERBS` (`src/ad-error-class.ts`), and an unknown verb is never a
 * read. Never throws.
 */
export function unavailableRetryCauseFor(value: unknown, verb: string | undefined): UnavailableRetryCause | undefined {
  try {
    const { errorClass } = classifyAdError(value)
    if (errorClass === AD_ERROR_CLASS_UNAVAILABLE) {
      const kind = isAdErrorInstance(value, ErrTmuxKillFailed)
        ? UNAVAILABLE_RETRY_CAUSE_KILL_FAILED
        : UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE
      return { kind, error: value }
    }
    if (errorClass === AD_ERROR_CLASS_ENVIRONMENT) return { kind: UNAVAILABLE_RETRY_CAUSE_ENVIRONMENT, error: value }
    if (errorClass === AD_ERROR_CLASS_CONFIG) return { kind: UNAVAILABLE_RETRY_CAUSE_CONFIG, error: value }
    if (verb === undefined) return undefined
    if (!AD_READ_VERBS.has(verb)) {
      return errorClass === AD_ERROR_CLASS_UNCLASSIFIED ? { kind: UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED, error: value } : undefined
    }
    if (errorClass === AD_ERROR_CLASS_UNUSABLE_NAME) return undefined
    if (isAdErrorInstance(value, ErrSpawnNotFound)) return undefined
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
 * awaits and timers). It holds only the
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

/**
 * Run `fn` outside every launch or recovery attempt, and answer what it
 * answers: inside `fn`, and in every await, timer and microtask it starts,
 * no attempt is running, for any persona, whatever attempt the caller runs
 * in. For work that is part of no attempt but is started from one: the
 * dialog approver, which a launch attempt starts as its launch call returns
 * (b.jg5 SRJ-401). An agent-director error met there then arms a retry
 * timer only with the ENVIRONMENT or CONFIG cause, and starts no
 * `tmux-unresponsive` condition and no unclassified-error episode (both are
 * attempt-scoped, `src/outage-state.ts`).
 */
export function runOutsideAttempts<T>(fn: () => T): T {
  // Outside every retry too: work a retry starts and does not await (a
  // dialog approver, a live-row sequence) is no retry of the timer. And
  // outside every latch re-check: such work is no part of the re-check, so
  // it gets no re-check scope and no re-check permit (b.jg5 SRJ-502, SRJ-505).
  return attemptContext.exit(() => timerRetryContext.exit(() => latchRecheckContext.exit(fn)))
}

/**
 * Run `fn` as a recovery attempt for persona `key` of its own, detached from
 * whatever attempt the caller runs in (`runOutsideAttempts`, then
 * `runInAttempt`): an error met in it is recorded there only and arms by the
 * attempt rule for `key`, never turning the caller's launch into `retrying`. For
 * work a caller starts in the background and does not await: each live-row
 * sequence (b.jg5 SRJ-706, the registry's attempt runner in
 * `src/live-row-sequence.ts`).
 */
export function runDetachedRecoveryAttempt<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideAttempts(() => runInAttempt(key, 'recovery', fn))
}

// ---------------------------------------------------------------------------
// The retry marker (b.jg5 SRJ-410, SRJ-303)
// ---------------------------------------------------------------------------

/**
 * One retry of a persona's retry timer as the marker holds it: its parent
 * is the nearest retry still running when it was started, if any; `ruleRan`
 * is set by the first pending-row rule run claimed in it.
 */
interface TimerRetryFrame {
  readonly key: string
  readonly parent: TimerRetryFrame | undefined
  /** False once the retry's function has settled; a continuation that outlives it is then outside it. */
  open: boolean
  ruleRan: boolean
}

/**
 * The retry of a persona's retry timer the current call runs in (b.jg5
 * SRJ-410: the pending-row rule runs only inside one, in either mode),
 * carried across awaits, timers and microtasks by `AsyncLocalStorage`, as
 * the attempt context is. Set by the retry action (`createFullModeRetryAction`)
 * around its whole run, in both modes; `runOutsideAttempts` leaves it, so a
 * dialog approver or a live-row sequence a retry starts is outside it. It
 * holds only the running retries' frames.
 */
const timerRetryContext = new AsyncLocalStorage<TimerRetryFrame>()

/**
 * Run `fn` as a retry of persona `key`'s retry timer (b.jg5 SRJ-303,
 * SRJ-410), and settle with its result: inside `fn`, and in every await it
 * makes, `isInsideTimerRetry(key)` answers true, and the pending-row rule
 * may be run once (`claimTimerRetryRuleRun`). A continuation of `fn` that
 * outlives it (a timer it set, the hand-off run the controller makes after
 * the action answered) is outside the retry.
 */
export async function runInTimerRetry<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  let parent = timerRetryContext.getStore()
  while (parent !== undefined && !parent.open) parent = parent.parent
  const frame: TimerRetryFrame = { key, parent, open: true, ruleRan: false }
  try {
    return await timerRetryContext.run(frame, fn)
  } finally {
    frame.open = false
  }
}

/** The innermost running retry for persona `key` the current call is inside, if any. */
function innermostRetryFrame(key: string): TimerRetryFrame | undefined {
  for (let frame = timerRetryContext.getStore(); frame !== undefined; frame = frame.parent) {
    if (frame.open && frame.key === key) return frame
  }
  return undefined
}

/**
 * True when the current call runs inside a retry of persona `key`'s retry
 * timer, in either mode (b.jg5 SRJ-410: the restart path's deferral and the
 * ladder's `pending` step run the pending-row rule only then; reached from
 * any other origin they only arm). Read-only; never throws.
 */
export function isInsideTimerRetry(key: string): boolean {
  try {
    return innermostRetryFrame(key) !== undefined
  } catch {
    return false
  }
}

/**
 * Claim the one pending-row rule run of the retry of persona `key`'s timer
 * the current call runs in (b.jg5 SRJ-410: at most one rule run per retry,
 * even when a retry reaches both the restart path's deferral and the
 * ladder's `pending` step): true the first time in a retry, false after,
 * and false outside every retry for `key`. Never throws.
 */
export function claimTimerRetryRuleRun(key: string): boolean {
  try {
    const frame = innermostRetryFrame(key)
    if (frame === undefined || frame.ruleRan) return false
    frame.ruleRan = true
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The latch re-check scope (b.jg5 SRJ-505, SRJ-307, SRJ-313)
// ---------------------------------------------------------------------------

/**
 * What a latch re-check of one persona opens its scope with
 * (`runInLatchRecheck`): the persona's key and the latch's query. The scope
 * applies only while that query answers the persona latched, so once a
 * retry's answer clears the latch the rest of that path is handled as
 * ordinary. A caller may extend it with its own fields (the session
 * manager's round carries its permit and its clear hook) and read them back
 * through `latchRecheckScopeOf`.
 */
export interface LatchRecheckScope {
  readonly key: string
  /** The latch's own query (never one a re-check permit passes). A throw counts as latched. */
  readonly isLatched: (key: string) => boolean
  /**
   * The re-check's permit (b.jg5 SRJ-502's "beyond the re-check"), present
   * only in the scope of the re-check's own run of the restart path's
   * decision (`runRestartWorkInTurn`, `src/restart.ts`).
   */
  readonly permit?: LatchRecheckPermit
}

/**
 * The latch re-check's permit for one run of the restart path's decision
 * (b.jg5 SRJ-502, SRJ-505): while `holds()` answers true, the latched gates
 * and mid-path stops that run reaches let it through for the persona; the
 * re-check revokes it at the run's first refusal (any latch set for the
 * persona) and when the run's launch answers with no information while the
 * persona is still latched, so a run that leaves the persona latched makes
 * no further call.
 */
export interface LatchRecheckPermit {
  holds(): boolean
}

/**
 * True when the current call runs inside a latch re-check of persona `key`
 * whose scope carries a permit that still holds (b.jg5 SRJ-502, SRJ-505):
 * the re-check's own run of the restart path's decision, until its first
 * refusal. Every latched gate asks it, and only such a call passes; the
 * retry timer, the health tick, the start sweep, the live-row sequence, the
 * dialog approver and the pending-row rule never run inside a re-check
 * (`runOutsideAttempts` leaves it). A permit that throws does not hold.
 * Never throws.
 */
export function holdsLatchRecheckPermit(key: string): boolean {
  const permit = latchRecheckScopeOf(key)?.permit
  if (permit === undefined) return false
  try {
    return permit.holds() === true
  } catch {
    return false
  }
}

/** One running re-check as the scope holds it. */
interface LatchRecheckFrame {
  readonly scope: LatchRecheckScope
  readonly parent: LatchRecheckFrame | undefined
  /** False once the re-check's function has settled; a continuation that outlives it is then outside it. */
  open: boolean
}

/**
 * The latch re-check the current call runs in (b.jg5 SRJ-505), carried
 * across awaits, timers and microtasks by `AsyncLocalStorage`, as the attempt
 * context is, so it covers every agent-director call the re-check makes for
 * its persona, a call inside a launch or recovery attempt opened within it
 * included. `runOutsideAttempts` leaves it. It holds only the running
 * re-checks' frames.
 */
const latchRecheckContext = new AsyncLocalStorage<LatchRecheckFrame>()

/**
 * Run `fn` as a latch re-check of persona `scope.key` (b.jg5 SRJ-505), and
 * settle with its result. While `fn` runs, and in every await it makes, the
 * persona is inside its re-check scope (`latchRecheckScopeOf`), and, while
 * it is latched, the reporting point and the outage wrappers treat each of
 * its answers as giving no information (`isInsideLatchRecheck`): no retry
 * timer is armed for any cause, no `tmux-unresponsive` condition starts or
 * continues, no `tmux-unavailable` outage is raised (a `find-missing` run's
 * excepted, b.jg5 SRJ-506) and no unclassified-error episode is fed. The
 * CONFIG outage, `ad-unreachable` and `cwd-unreachable` are raised as ever,
 * and every clear on a success is made as ever. A continuation of `fn` that
 * outlives it (a timer it set) is outside the re-check.
 */
export async function runInLatchRecheck<T>(scope: LatchRecheckScope, fn: () => T | Promise<T>): Promise<T> {
  let parent = latchRecheckContext.getStore()
  while (parent !== undefined && !parent.open) parent = parent.parent
  const frame: LatchRecheckFrame = { scope, parent, open: true }
  try {
    return await latchRecheckContext.run(frame, fn)
  } finally {
    frame.open = false
  }
}

/**
 * The scope of the innermost running latch re-check of persona `key` the
 * current call is inside, latched or not, or `undefined` outside every one.
 * The object `runInLatchRecheck` was given, so a caller reads back its own
 * fields. Read-only; never throws.
 */
export function latchRecheckScopeOf(key: string): LatchRecheckScope | undefined {
  try {
    for (let frame = latchRecheckContext.getStore(); frame !== undefined; frame = frame.parent) {
      if (frame.open && frame.scope.key === key) return frame.scope
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * True when the current call runs inside a latch re-check of persona `key`
 * and the persona is still latched (b.jg5 SRJ-505): an answer met here gives
 * no information, so nothing is armed, started, raised (CONFIG's outage
 * aside) or fed for it, and no further call follows a launch's UNAVAILABLE
 * answer (SRJ-407's `get`). A latch query that throws counts as latched.
 * False outside every re-check of `key`, and once the latch has cleared.
 * Never throws.
 */
export function isInsideLatchRecheck(key: string): boolean {
  const scope = latchRecheckScopeOf(key)
  if (scope === undefined) return false
  try {
    return scope.isLatched(key) === true
  } catch {
    return true
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
 * The last agent-director error the innermost running attempt for persona
 * `key` recorded so far, or `undefined` when the current call runs inside no
 * attempt for `key` or none was recorded. For a step that makes a further
 * call after a launch's error and must know what that error armed before the
 * further call's answer is recorded in its place (b.jg5 SRJ-407). Read-only;
 * never throws.
 */
export function currentAttemptLastError(key: string): AttemptErrorRecord | undefined {
  try {
    return innermostFrame(key)?.lastError
  } catch {
    return undefined
  }
}

/**
 * Report an agent-director error for persona `key`, thrown by a call made
 * with `verb` (b.jg5 SRJ-301, SRJ-311). When the arming predicate answers a
 * cause and `sink` is given, the sink is called once with `key` and the
 * cause, inside an attempt for `key`, and for the ENVIRONMENT and CONFIG
 * causes (`UNAVAILABLE_RETRY_ANY_CONTEXT_CAUSES`, b.jg5 SRJ-311, SRJ-316) in
 * any context too: inside another persona's attempt or outside every attempt
 * (the health tick, the permission poller and click handler, the JSONL
 * safeguard, a teardown's kill). A stray
 * arm there (a torn-down persona, one not applied or not up) stops at its
 * first retry through the action's stop checks, with no agent-director call.
 * Outside an attempt for `key`, any other cause arms nothing. Inside one,
 * the innermost attempt then records the error as its last, armed when the
 * sink answered true (the persona has a timer after the call), so a launch
 * ended by it answers `retrying` (b.jg5 SRJ-1015); a sink that answers anything else, or throws, armed
 * nothing. Answers whether the sink armed. Never throws.
 */
export function reportAttemptError(
  key: string,
  value: unknown,
  verb: string | undefined,
  sink: UnavailableRetryTriggerSink | undefined,
): boolean {
  let cause: UnavailableRetryCause | undefined
  try {
    cause = unavailableRetryCauseFor(value, verb)
  } catch {
    cause = undefined
  }
  return reportAttemptCause(key, cause, verb, sink)
}

/**
 * The reporting step of {@link reportAttemptError} for a cause the caller
 * decided itself: a site that classifies an outcome on its own (the resume
 * path's `ErrInvalidFlags`, UNCLASSIFIED after its re-check, b.jg5 SRJ-104,
 * SRJ-313) passes `UNAVAILABLE_RETRY_CAUSE_UNCLASSIFIED`. The same context
 * rule applies: inside an attempt for `key` the sink arms with `cause` and
 * the innermost attempt records it as its last error; outside one, only the
 * ENVIRONMENT and CONFIG causes arm. Inside a latch re-check of a latched
 * persona (`isInsideLatchRecheck`, b.jg5 SRJ-505) no cause arms, in any
 * context: the sink is not called, and an attempt records the error as not
 * armed. Answers whether the sink armed. Never throws.
 */
export function reportAttemptCause(
  key: string,
  cause: UnavailableRetryCause | undefined,
  verb: string | undefined,
  sink: UnavailableRetryTriggerSink | undefined,
): boolean {
  try {
    const frame = innermostFrame(key)
    // b.jg5 SRJ-505: inside a latch re-check of a latched persona an answer
    // gives no information, so no cause arms its timer, in any context.
    const noInformation = isInsideLatchRecheck(key)
    if (frame === undefined && (noInformation || cause === undefined || !UNAVAILABLE_RETRY_ANY_CONTEXT_CAUSES.has(cause.kind))) return false
    let armed = false
    if (cause !== undefined && sink !== undefined && !noInformation) {
      try {
        armed = sink.arm(key, cause) === true
      } catch {
        /* a failing sink arms nothing; the call's own error is what its caller sees */
      }
    }
    if (frame === undefined) return armed
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
