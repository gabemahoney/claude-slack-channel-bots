/**
 * cli-teardown.ts — The pure pieces of the CLI's persona teardown commands,
 * `stop --stop-bots` and `clean_restart` (`src/cli.ts`): the precheck's
 * verdict over one answer, its tries and spacing, its two operator lines,
 * `stop --stop-bots`' too-old line and the config-file display name (b.jg5
 * SRJ-901, SRJ-902, SRJ-117, SRJ-908); the teardown's per-persona
 * outcome, its pause verdict, its state-read verdict, its kill's options
 * and mapping, and the bounds of its cost (SRJ-903, SRJ-904, SRJ-119,
 * SRJ-316, SRJ-908; hatch note E12); the teardown's report: each persona's
 * failure line, kill-failure alert and startup-errors entry, and the last
 * line (SRJ-907, SRJ-909, SRJ-1013); `clean_restart`'s answer check line,
 * not-restarted alert and its class, and its restart lines (SRJ-906,
 * SRJ-1013); and both commands' initialization-failed line.
 *
 * The precheck. Before either command stops anything, it reads each persona
 * of the configuration the server runs: one `get` of `cscb_<key>`, then, for
 * a live row, one `read-pane` of `PROBE_PANE_READ_LINES` line
 * (`src/pane-read.ts`). {@link precheckVerdictOf} decides each answer:
 *
 *   - a `get` with no row (`ErrSpawnNotFound`) or a finished row
 *     (`AGENT_DIRECTOR_DEAD_STATES`: `ended`, `missing`): skip;
 *   - a `get` of a row in any other state, one CSCB does not know included
 *     (SRJ-901 step 2), whatever its `liveness_note` (a note alone fails
 *     nothing, SRJ-114): pass, and the `read-pane` follows;
 *   - a `read-pane` answering a pane, GONE or `ErrSpawnNotFound`: pass;
 *   - UNAVAILABLE (timeouts included), from either call: retry;
 *   - CONFIG (`ErrConfigMalformed`), from either call: fail at once, naming
 *     the config file;
 *   - CONFLICT, UNUSABLE NAME, ENVIRONMENT or UNCLASSIFIED, from either call:
 *     fail, with no retry.
 *
 * At a `get` every other class (GONE, a STATE name other than
 * `ErrSpawnNotFound`, LAUNCH FAILURE, DIRECTORY) fails with no retry as
 * UNCLASSIFIED; at a `read-pane` those are UNCLASSIFIED by SRJ-117's table.
 * A failure carries the class label it is reported under and the redacted
 * one-line description `describeReportedAdFailure` renders (SRJ-104: an
 * UNCLASSIFIED, UNUSABLE NAME or CONFIG error shows the name and description
 * agent-director reported, an `ErrUnknownErrorName` its `unknownName` and
 * the envelope's `err_description`); a CONFIG failure's description names
 * {@link AD_CONFIG_FILE_DISPLAY_NAME}.
 * Recognition is by class and name through `src/ad-error-class.ts`, never by
 * an error class or a message text.
 *
 * A call that answers UNAVAILABLE is made at most {@link PRECHECK_TRIES}
 * times, {@link PRECHECK_TRY_SPACING_MS} apart, on the CLI's injected clock
 * (`CliDeps.sleep`), then counts as a failure; only that call is repeated.
 *
 * A failed precheck prints, per persona it could not reach,
 * {@link precheckFailureLine}, then {@link precheckNothingStoppedLine}.
 * When the client refuses the binary as too old, `stop --stop-bots` stops
 * only the server and ends with {@link onlyServerStoppedLine} (SRJ-902).
 *
 * The teardown. After a passed precheck and the server stop, each persona's
 * teardown (`teardownPersona`) answers one {@link PersonaTeardownOutcome}:
 * stopped, with its reason (no row, already finished, exited after the
 * pause, killed), or failed, with the step that failed (state read, pause,
 * poll or kill; or an unexpected rejection of the teardown itself, which the
 * CLI maps to a failed outcome), the classifier's class (never relabelled
 * UNCLASSIFIED, as the precheck's `get` relabels) and the redacted one-line
 * description `describeReportedAdFailure` renders (SRJ-104), a CONFIG
 * failure's naming {@link AD_CONFIG_FILE_DISPLAY_NAME} (SRJ-316).
 *
 * {@link stateReadVerdictOf} decides each of the teardown's own `status`
 * reads (the read before the pause and every read of the poll): a finished
 * row (`ended`, `missing`) or no row (`ErrSpawnNotFound`, by name) ends the
 * persona's teardown as stopped; any other state is live and goes on; any
 * other error fails the persona at once with its class, with no retry.
 *
 * {@link pauseVerdictOf} decides each `pause` answer on a live row by class
 * (SRJ-903; hatch note E12: every answer through `classifyAdError`):
 *
 *   - success: done, and the poll follows;
 *   - UNAVAILABLE (`ErrCallTimeout` and a non-agent-director throw
 *     included): retry, only the `pause` being repeated, at most
 *     {@link PRECHECK_TRIES} calls {@link PRECHECK_TRY_SPACING_MS} apart on
 *     the CLI's injected clock, then escalate to the kill
 *     ({@link pauseVerdictAfterLastTry});
 *   - CONFLICT, ENVIRONMENT, UNUSABLE NAME or another `ErrInternal` (an
 *     UNCLASSIFIED answer whose reported name is `ERR_INTERNAL_NAME`): fail
 *     at once, with no kill;
 *   - CONFIG (`ErrConfigMalformed`): fail at once, naming the config file;
 *   - GONE (`ErrTmuxSendKeys`), STATE (`ErrSpawnNotPausable` on a `pending`
 *     row, `ErrSpawnNotFound`), `ErrPauseTimeout`, the three store names and
 *     every other UNCLASSIFIED name, LAUNCH FAILURE and DIRECTORY: escalate
 *     to the kill.
 *
 * `pause` waits up to the host's `[pause] timeout_seconds` for the row to
 * end; CSCB's call timeout is sized above that wait (SRJ-213), so a slow
 * `/exit` ends in `ErrPauseTimeout`, which escalates, rather than in
 * `ErrCallTimeout` (SRJ-119).
 *
 * The kill (SRJ-904, SRJ-702, SRJ-110), after an escalated pause or at
 * `exit_timeout`, is one bounded retry (`runKillRetry`, `src/kill-retry.ts`)
 * of checked kills (`checkedKill`, `src/checked-kill.ts`), run by the CLI
 * under {@link TEARDOWN_KILL_OPTIONS} (`goneIsFailure`), so a GONE answer is
 * a non-success that ends the tries at once in the retry's own lines and
 * alert decision, and under {@link TEARDOWN_KILL_RETRY_OPTIONS}
 * (`configReadEndsTries`), so a CONFIG answer at a `status` read between
 * tries ends them (`read-config`) whatever state was last read.
 * {@link teardownKillReadOf} maps each read (no row, a state, or a failed
 * read; never a latching read). {@link teardownKillOutcomeOf} maps the
 * retry's result to the persona's outcome: a success stops it, every
 * non-success class (GONE included) and a CONFIG read fail it with the
 * classifier's class, and the outcome carries the kill's report with the
 * retry's kill-failure alert decision (the retry gives the survivor version
 * only on a success end and the ordinary version only on a failure end).
 *
 * The report (SRJ-907, SRJ-909, SRJ-1013, SRJ-704, SRJ-1007): after every
 * persona has settled, {@link personaTeardownReportOf} gives each persona's
 * lines to print, lines to append to `server.log` and at most one
 * `startup-errors.log` entry. A failed persona gets
 * {@link teardownFailureLine}; where its outcome's alert decision is the
 * ordinary version, that line is followed by the kill-failure alert's
 * ordinary version with the CLI closing sentence, recorded together as one
 * `persona-kill-failed` entry, and any other failure is recorded as one
 * {@link CLI_TEARDOWN_FAILED_LABEL} entry. A persona stopped with the
 * survivor decision gets no failure line: the survivor version, with its CLI
 * closing sentence, is printed, logged and recorded as one
 * `persona-kill-survivor` entry. The alert's text, closing sentence, route
 * and class come from `src/kill-failure-alert.ts`; its log-line and entry
 * form names the command as the context. When any persona failed, the
 * command ends with {@link teardownNotStoppedLine}, printed only.
 *
 * The restart (SRJ-906): when any persona of a `clean_restart` failed, the
 * CLI checks that agent-director answers, one `list` of `service=cscb` rows
 * made at most {@link PRECHECK_TRIES} times {@link PRECHECK_TRY_SPACING_MS}
 * apart, any error being a failed try, and starts the server when it does.
 * When it does not, the server is not started, and
 * {@link cleanRestartNotRestartedAlert}, which names every failed persona
 * with its session and class and ends with
 * {@link CLEAN_RESTART_NOT_STARTED_SENTENCE}, is printed, appended as one
 * `server.log` line and recorded as one
 * {@link CLEAN_RESTART_NOT_RESTARTED_LABEL} entry. The last line follows the
 * restart's outcome.
 *
 * The cost (SRJ-908): {@link teardownBoundMs} bounds one persona's teardown
 * and {@link precheckBoundMs} its precheck, each call taking the call
 * timeout, from {@link PRECHECK_TRIES}, {@link PRECHECK_TRY_SPACING_MS},
 * `KILL_RETRY_TRIES`, `KILL_RETRY_SPACING_MS` and `exit_timeout`.
 *
 * The precheck and the teardown have no side effects beyond the teardown's
 * own `pause` and `kill` (SRJ-114, SRJ-115, SRJ-801, SRJ-1002): nothing
 * latches, no record is written and no retired-key entry is cleared. This
 * module therefore never imports the session manager, the conflict latch,
 * the retired-key record, the settings reader (`src/ad-settings.ts`; the
 * config file's name comes from `src/ad-config-file.ts`) or `src/cli.ts`.
 *
 * Pure: no module-scope state, no I/O, no timer, no agent-director call, no
 * log line. Never throws.
 *
 * SPDX-License-Identifier: MIT
 */

import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_GONE,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  classifyAdError,
  describeReportedAdFailure,
  hasAdErrorName,
  type AdErrorClass,
} from './ad-error-class.ts'
import { AD_CONFIG_FILE_DISPLAY_NAME } from './ad-config-file.ts'
import { ERR_INTERNAL_NAME, ERR_SPAWN_NOT_FOUND_NAME } from './agent-director-errors.ts'
import {
  KILL_OUTCOME_KILLED,
  KILL_OUTCOME_NOT_KILLED,
  KILL_OUTCOME_ROW_FINISHED,
  KILL_OUTCOME_ROW_GONE,
  KILL_OUTCOME_SESSION_GONE,
  type AnyKillFailure,
  type AnyKillOutcome,
  type CheckedKillOptions,
} from './checked-kill.ts'
import {
  KILL_RETRY_ALERT_ORDINARY,
  KILL_RETRY_ALERT_SURVIVOR,
  KILL_RETRY_END_READ_CONFIG,
  KILL_RETRY_READ_FAILED,
  KILL_RETRY_READ_NO_ROW,
  KILL_RETRY_READ_STATE,
  KILL_RETRY_SPACING_MS,
  KILL_RETRY_TRIES,
  type KillRetryAlert,
  type KillRetryEnd,
  type KillRetryOptions,
  type KillRetryRead,
  type KillRetryResult,
} from './kill-retry.ts'
import { AGENT_DIRECTOR_DEAD_STATES } from './liveness-reading.ts'
import {
  PANE_READ_ABSENT,
  PANE_READ_CONFIG,
  PANE_READ_GONE,
  PANE_READ_UNAVAILABLE,
  PANE_READ_UNCLASSIFIED,
  paneReadFailureOf,
} from './pane-read.ts'
import {
  KILL_FAILURE_CONTEXT_CLI_TEARDOWN,
  killFailureAlertContentOf,
  killFailureAlertEntryText,
  killFailureAlertText,
  killFailureCliTeardownEntryContext,
  selectKillFailureAlertRoute,
} from './kill-failure-alert.ts'
import { personaInstanceId, personaTmuxSessionName, renderPersonaRef } from './persona-identity.ts'

// ---------------------------------------------------------------------------
// Commands and names
// ---------------------------------------------------------------------------

/** `stop --stop-bots`, as its lines name it. */
export const CLI_COMMAND_STOP_BOTS = 'stop --stop-bots'

/** `clean_restart`, as its lines name it. */
export const CLI_COMMAND_CLEAN_RESTART = 'clean_restart'

/** A command that runs the precheck and the teardown. */
export type CliTeardownCommand = typeof CLI_COMMAND_STOP_BOTS | typeof CLI_COMMAND_CLEAN_RESTART

/**
 * agent-director's config file as the CLI's lines name it,
 * `~/.agent-director/config.toml` (b.jg5 SRJ-901, SRJ-316; defined in
 * `src/ad-config-file.ts`).
 */
export { AD_CONFIG_FILE_DISPLAY_NAME }

// ---------------------------------------------------------------------------
// Tries
// ---------------------------------------------------------------------------

/**
 * Most calls the precheck makes of one `get` or `read-pane` that answers
 * UNAVAILABLE (b.jg5 SRJ-901 step 3); also the most `pause` calls of one
 * persona's teardown (SRJ-903) and the most `list` calls of `clean_restart`'s
 * answer check (SRJ-906).
 */
export const PRECHECK_TRIES = 3

/**
 * The wait between two tries of one precheck call, of one teardown's `pause`
 * and of `clean_restart`'s answer check, on the CLI's injected clock (b.jg5
 * SRJ-901, SRJ-903, SRJ-906, SRJ-908).
 */
export const PRECHECK_TRY_SPACING_MS = 2_000

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** The precheck's `get` of a persona's row. */
export const PRECHECK_CALL_GET = 'get'

/** The precheck's one-line `read-pane` of a persona's live row. */
export const PRECHECK_CALL_READ_PANE = 'read-pane'

/** One of the precheck's two calls. */
export type PrecheckCall = typeof PRECHECK_CALL_GET | typeof PRECHECK_CALL_READ_PANE

/**
 * What the precheck reads of a `get` row: its state, and, unused by the
 * verdict, its `liveness_note` and launch start.
 */
export interface PrecheckRow {
  readonly state: string
  readonly liveness_note?: string | null
  readonly launch_started_at?: string | null
}

/** A `get` that answered: the row, or null for no row (`ErrSpawnNotFound`). */
export interface PrecheckGetAnswer {
  readonly call: typeof PRECHECK_CALL_GET
  readonly row: PrecheckRow | null
}

/** A `read-pane` that answered a pane. */
export interface PrecheckPaneAnswer {
  readonly call: typeof PRECHECK_CALL_READ_PANE
  readonly pane: string
}

/** A call that threw or rejected: the value as thrown. */
export interface PrecheckErrorAnswer {
  readonly call: PrecheckCall
  readonly error: unknown
}

/** One answer to one precheck call. */
export type PrecheckAnswer = PrecheckGetAnswer | PrecheckPaneAnswer | PrecheckErrorAnswer

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** A `get` with no row or a finished row: the persona passes with no `read-pane`. */
export const PRECHECK_VERDICT_SKIP = 'skip'
/** A `get` of a live row (the `read-pane` follows), or a `read-pane` that passes the persona. */
export const PRECHECK_VERDICT_PASS = 'pass'
/** UNAVAILABLE: the same call is made again, up to {@link PRECHECK_TRIES} calls in all. */
export const PRECHECK_VERDICT_RETRY = 'retry'
/** The persona fails, with no retry. */
export const PRECHECK_VERDICT_FAIL = 'fail'
/** CONFIG: the persona fails at once, its description naming the config file. */
export const PRECHECK_VERDICT_FAIL_AT_ONCE = 'fail-at-once'

/** What a precheck failure reports on its line. */
export interface PrecheckFailure {
  /** The class label the failure is reported under. */
  readonly errorClass: AdErrorClass
  /** The redacted one-line description; a CONFIG failure's names {@link AD_CONFIG_FILE_DISPLAY_NAME}. */
  readonly description: string
}

/** The verdict over a `get` with no row or a finished row. */
export interface PrecheckSkipVerdict {
  readonly kind: typeof PRECHECK_VERDICT_SKIP
}

/** The verdict over a `get` of a live row, or a `read-pane` that passes. */
export interface PrecheckPassVerdict {
  readonly kind: typeof PRECHECK_VERDICT_PASS
}

/** A verdict that retries or fails, with what the failure reports. */
export interface PrecheckFailureVerdict extends PrecheckFailure {
  readonly kind: typeof PRECHECK_VERDICT_RETRY | typeof PRECHECK_VERDICT_FAIL | typeof PRECHECK_VERDICT_FAIL_AT_ONCE
}

/** The verdict over one precheck answer. */
export type PrecheckVerdict = PrecheckSkipVerdict | PrecheckPassVerdict | PrecheckFailureVerdict

const VERDICT_SKIP: PrecheckSkipVerdict = Object.freeze({ kind: PRECHECK_VERDICT_SKIP })
const VERDICT_PASS: PrecheckPassVerdict = Object.freeze({ kind: PRECHECK_VERDICT_PASS })

/**
 * The verdict over one precheck answer (b.jg5 SRJ-901 steps 2 to 5,
 * SRJ-117's CLI-precheck row); see the module comment. Pure; never throws.
 */
export function precheckVerdictOf(answer: PrecheckAnswer): PrecheckVerdict {
  if ('error' in answer) {
    return answer.call === PRECHECK_CALL_GET ? getErrorVerdict(answer.error) : readPaneErrorVerdict(answer.error)
  }
  if (answer.call === PRECHECK_CALL_GET) {
    // A finished row is skipped; every other state, one CSCB does not know
    // included, is live and gets the read-pane. The note decides nothing.
    if (answer.row === null || AGENT_DIRECTOR_DEAD_STATES.has(answer.row.state)) return VERDICT_SKIP
    return VERDICT_PASS
  }
  // A pane passes but proves nothing: it may be a single leftover's
  // (b.jg5 SRJ-613). The backstop is the teardown's pause, or on a `pending`
  // row its kill, which answers CONFLICT for a leftover and fails that
  // persona's teardown (SRJ-903, SRJ-904).
  return VERDICT_PASS
}

/** The verdict over a value a `get` threw. */
function getErrorVerdict(error: unknown): PrecheckVerdict {
  if (hasAdErrorName(error, ERR_SPAWN_NOT_FOUND_NAME)) return VERDICT_SKIP
  const { errorClass } = classifyAdError(error)
  const description = describeReportedAdFailure(error)
  if (errorClass === AD_ERROR_CLASS_UNAVAILABLE) return { kind: PRECHECK_VERDICT_RETRY, errorClass, description }
  if (errorClass === AD_ERROR_CLASS_CONFIG) return configVerdict(description)
  return { kind: PRECHECK_VERDICT_FAIL, errorClass: reportedClassOf(errorClass), description }
}

/**
 * The verdict over a value a `read-pane` threw: its kind through
 * `src/pane-read.ts`'s mapper, its description the precheck's own.
 */
function readPaneErrorVerdict(error: unknown): PrecheckVerdict {
  const failure = paneReadFailureOf(error)
  const description = describeReportedAdFailure(error)
  switch (failure.kind) {
    case PANE_READ_GONE:
    case PANE_READ_ABSENT:
      return VERDICT_PASS
    case PANE_READ_UNAVAILABLE:
      return { kind: PRECHECK_VERDICT_RETRY, errorClass: failure.errorClass, description }
    case PANE_READ_CONFIG:
      return configVerdict(description)
    case PANE_READ_UNCLASSIFIED:
      return { kind: PRECHECK_VERDICT_FAIL, errorClass: AD_ERROR_CLASS_UNCLASSIFIED, description }
    default:
      // CONFLICT, UNUSABLE NAME, ENVIRONMENT.
      return { kind: PRECHECK_VERDICT_FAIL, errorClass: failure.errorClass, description }
  }
}

/** A CONFIG answer's verdict: fail at once, the description naming the config file. */
function configVerdict(description: string): PrecheckFailureVerdict {
  return {
    kind: PRECHECK_VERDICT_FAIL_AT_ONCE,
    errorClass: AD_ERROR_CLASS_CONFIG,
    description: configFailureDescription(description),
  }
}

/** A CONFIG failure's description: the reported description, after a lead naming the config file. */
function configFailureDescription(description: string): string {
  return `agent-director refuses its config file ${AD_CONFIG_FILE_DISPLAY_NAME}: ${description}`
}

/** The classes a failed `get` keeps on its line; every other is reported UNCLASSIFIED. */
const GET_FAILURE_CLASSES: ReadonlySet<AdErrorClass> = new Set<AdErrorClass>([
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_UNCLASSIFIED,
])

/** The class a failed `get` is reported under: its own when the precheck names it, else UNCLASSIFIED. */
function reportedClassOf(errorClass: AdErrorClass): AdErrorClass {
  return GET_FAILURE_CLASSES.has(errorClass) ? errorClass : AD_ERROR_CLASS_UNCLASSIFIED
}

// ---------------------------------------------------------------------------
// The teardown's per-persona outcome
// ---------------------------------------------------------------------------

/** The teardown's `status` read of the row before the pause. */
export const TEARDOWN_STEP_STATE_READ = 'state read'
/** The teardown's `pause` of a live row. */
export const TEARDOWN_STEP_PAUSE = 'pause'
/** The teardown's `status` reads after a pause, waiting for `ended` or `missing`. */
export const TEARDOWN_STEP_POLL = 'poll'
/** The teardown's `kill`, after an escalated pause or at `exit_timeout`. */
export const TEARDOWN_STEP_KILL = 'kill'

/**
 * A persona's teardown that rejected rather than answering its outcome, at no
 * known step: the CLI waits for every persona to settle, and such a
 * rejection fails that persona ({@link teardownRejectedOutcomeOf}).
 */
export const TEARDOWN_STEP_UNEXPECTED = 'unexpected rejection'

/** The step of a persona's teardown that failed. */
export type TeardownStep =
  | typeof TEARDOWN_STEP_STATE_READ
  | typeof TEARDOWN_STEP_PAUSE
  | typeof TEARDOWN_STEP_POLL
  | typeof TEARDOWN_STEP_KILL
  | typeof TEARDOWN_STEP_UNEXPECTED

/** The state read found no row (`ErrSpawnNotFound`). */
export const TEARDOWN_STOPPED_NO_ROW = 'no row'
/** The state read found the row finished (`ended`, `missing`). */
export const TEARDOWN_STOPPED_ALREADY_FINISHED = 'already finished'
/** After the pause, the poll found the row finished or gone. */
export const TEARDOWN_STOPPED_EXITED = 'exited after the pause'
/** The kill ended the persona's teardown as a success. */
export const TEARDOWN_STOPPED_KILLED = 'killed'

/** Why a persona's teardown counts as stopped. */
export type TeardownStoppedReason =
  | typeof TEARDOWN_STOPPED_NO_ROW
  | typeof TEARDOWN_STOPPED_ALREADY_FINISHED
  | typeof TEARDOWN_STOPPED_EXITED
  | typeof TEARDOWN_STOPPED_KILLED

/** The persona was stopped. */
export const TEARDOWN_OUTCOME_STOPPED = 'stopped'
/** The persona could not be stopped. */
export const TEARDOWN_OUTCOME_FAILED = 'failed'

/** What a teardown failure reports about the agent-director answer that failed it. */
export interface TeardownErrorReport {
  /** The classifier's class, as reported (never relabelled). */
  readonly errorClass: AdErrorClass
  /**
   * `describeReportedAdFailure` of the answer: redacted, on one line; a
   * CONFIG failure's names {@link AD_CONFIG_FILE_DISPLAY_NAME}.
   */
  readonly description: string
}

/**
 * What a persona's teardown kill did (b.jg5 SRJ-904, SRJ-702): the outcome
 * that stood at the end of the bounded retry (`runKillRetry`,
 * `src/kill-retry.ts`), how the tries ended, the kills and `status` reads
 * made, and the retry's kill-failure alert decision (b.jg5 SRJ-1007): for a
 * stopped persona none or the survivor version, for a failed one none or the
 * ordinary version. Every description in it is raw as agent-director wrote
 * it (redact before any line, record or print).
 */
export interface TeardownKillReport {
  readonly outcome: AnyKillOutcome
  readonly end: KillRetryEnd
  readonly tries: number
  readonly reads: number
  readonly alert: KillRetryAlert
}

/** A persona's teardown that stopped it; `kill` is present when the kill stopped it. */
export interface TeardownStoppedOutcome {
  readonly kind: typeof TEARDOWN_OUTCOME_STOPPED
  readonly reason: TeardownStoppedReason
  readonly kill?: TeardownKillReport
}

/**
 * A persona's teardown that failed, at `step`, with what the answer reports;
 * `kill` is present when the kill failed it.
 */
export interface TeardownFailedOutcome extends TeardownErrorReport {
  readonly kind: typeof TEARDOWN_OUTCOME_FAILED
  readonly step: TeardownStep
  readonly kill?: TeardownKillReport
}

/** One persona's teardown outcome. */
export type PersonaTeardownOutcome = TeardownStoppedOutcome | TeardownFailedOutcome

/** The stopped outcome for `reason`. */
export function teardownStopped(reason: TeardownStoppedReason): TeardownStoppedOutcome {
  return { kind: TEARDOWN_OUTCOME_STOPPED, reason }
}

/** The failed outcome at `step`, reporting `report`. */
export function teardownFailed(step: TeardownStep, report: TeardownErrorReport): TeardownFailedOutcome {
  return {
    kind: TEARDOWN_OUTCOME_FAILED,
    step,
    errorClass: report.errorClass,
    description: report.description,
  }
}

/**
 * What a teardown failure reports for a value an agent-director call threw
 * (b.jg5 SRJ-104, SRJ-316; hatch note E12): the classifier's class, unchanged,
 * and `describeReportedAdFailure`'s description, after a lead naming
 * {@link AD_CONFIG_FILE_DISPLAY_NAME} for a CONFIG answer. Pure; never throws.
 */
export function teardownErrorReportOf(error: unknown): TeardownErrorReport {
  return errorReportOfClass(classifyAdError(error).errorClass, error)
}

/**
 * The failed outcome of a persona's teardown that rejected with `reason`
 * instead of answering its outcome: step {@link TEARDOWN_STEP_UNEXPECTED},
 * reporting {@link teardownErrorReportOf} of `reason`. Pure; never throws.
 */
export function teardownRejectedOutcomeOf(reason: unknown): TeardownFailedOutcome {
  return teardownFailed(TEARDOWN_STEP_UNEXPECTED, teardownErrorReportOf(reason))
}

/** What a teardown failure of `errorClass` reports for `error`: see {@link teardownErrorReportOf}. */
function errorReportOfClass(errorClass: AdErrorClass, error: unknown): TeardownErrorReport {
  const description = describeReportedAdFailure(error)
  return { errorClass, description: errorClass === AD_ERROR_CLASS_CONFIG ? configFailureDescription(description) : description }
}

// ---------------------------------------------------------------------------
// The teardown's state reads
// ---------------------------------------------------------------------------

/** What the teardown reads of a `status` row: its state. */
export interface TeardownStateRow {
  readonly state: string
}

/** A `status` read that answered: the row, or null for no row (`ErrSpawnNotFound`). */
export interface StateReadRowAnswer {
  readonly row: TeardownStateRow | null
}

/** A `status` read that threw or rejected: the value as thrown. */
export interface StateReadErrorAnswer {
  readonly error: unknown
}

/** One answer to one of the teardown's `status` reads. */
export type StateReadAnswer = StateReadRowAnswer | StateReadErrorAnswer

/** No row (`ErrSpawnNotFound`): the persona is stopped. */
export const STATE_READ_VERDICT_ABSENT = 'absent'
/** A finished row (`ended`, `missing`): the persona is stopped. */
export const STATE_READ_VERDICT_FINISHED = 'finished'
/** A row in any other state, one CSCB does not know included: the teardown goes on. */
export const STATE_READ_VERDICT_LIVE = 'live'
/** Any other error: the persona's teardown fails at once, with no retry. */
export const STATE_READ_VERDICT_FAIL = 'fail'

/** The verdict over a read that found no row. */
export interface StateReadAbsentVerdict {
  readonly kind: typeof STATE_READ_VERDICT_ABSENT
}

/** The verdict over a read that found a row, finished or live, with its state. */
export interface StateReadRowVerdict {
  readonly kind: typeof STATE_READ_VERDICT_FINISHED | typeof STATE_READ_VERDICT_LIVE
  readonly state: string
}

/** The verdict over a read that failed, with what the failure reports. */
export interface StateReadFailVerdict extends TeardownErrorReport {
  readonly kind: typeof STATE_READ_VERDICT_FAIL
}

/** The verdict over one of the teardown's `status` reads. */
export type StateReadVerdict = StateReadAbsentVerdict | StateReadRowVerdict | StateReadFailVerdict

const STATE_READ_ABSENT: StateReadAbsentVerdict = Object.freeze({ kind: STATE_READ_VERDICT_ABSENT })

/**
 * The verdict over one of the teardown's own `status` reads, the read before
 * the pause and each read of the poll (b.jg5 SRJ-903, SRJ-316): no row
 * (`ErrSpawnNotFound`, by name) is absent; a finished row is finished; any
 * other state is live; any other error fails at once with its class, a
 * CONFIG answer naming the config file. Pure; never throws.
 */
export function stateReadVerdictOf(answer: StateReadAnswer): StateReadVerdict {
  if ('error' in answer) {
    if (hasAdErrorName(answer.error, ERR_SPAWN_NOT_FOUND_NAME)) return STATE_READ_ABSENT
    return { kind: STATE_READ_VERDICT_FAIL, ...teardownErrorReportOf(answer.error) }
  }
  if (answer.row === null) return STATE_READ_ABSENT
  const { state } = answer.row
  return { kind: AGENT_DIRECTOR_DEAD_STATES.has(state) ? STATE_READ_VERDICT_FINISHED : STATE_READ_VERDICT_LIVE, state }
}

// ---------------------------------------------------------------------------
// The teardown's pause
// ---------------------------------------------------------------------------

/** A `pause` that answered success. */
export interface PauseDoneAnswer {
  readonly paused: true
}

/** A `pause` that threw or rejected: the value as thrown. */
export interface PauseErrorAnswer {
  readonly error: unknown
}

/** One answer to one `pause` call. */
export type PauseAnswer = PauseDoneAnswer | PauseErrorAnswer

/** The pause succeeded: the poll follows. */
export const PAUSE_VERDICT_DONE = 'done'
/** UNAVAILABLE: the `pause` alone is made again, up to {@link PRECHECK_TRIES} calls in all. */
export const PAUSE_VERDICT_RETRY = 'retry'
/** The teardown goes on to the kill. */
export const PAUSE_VERDICT_ESCALATE = 'escalate'
/** The persona's teardown fails at once, with no kill. */
export const PAUSE_VERDICT_FAIL = 'fail'

/** The verdict over a `pause` that succeeded. */
export interface PauseDoneVerdict {
  readonly kind: typeof PAUSE_VERDICT_DONE
}

/** A verdict that retries or escalates, with the answer's class and description for the log. */
export interface PauseEscalationVerdict {
  readonly kind: typeof PAUSE_VERDICT_RETRY | typeof PAUSE_VERDICT_ESCALATE
  readonly errorClass: AdErrorClass
  /** `describeReportedAdFailure` of the answer: redacted, on one line. */
  readonly description: string
}

/** The verdict that fails the persona's teardown at once, with what the failure reports. */
export interface PauseFailVerdict extends TeardownErrorReport {
  readonly kind: typeof PAUSE_VERDICT_FAIL
}

/** The verdict over one `pause` answer. */
export type PauseVerdict = PauseDoneVerdict | PauseEscalationVerdict | PauseFailVerdict

const PAUSE_DONE: PauseDoneVerdict = Object.freeze({ kind: PAUSE_VERDICT_DONE })

/** The classes whose `pause` answer fails the persona's teardown at once, with no kill (b.jg5 SRJ-903). */
const PAUSE_FAIL_CLASSES: ReadonlySet<AdErrorClass> = new Set<AdErrorClass>([
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  AD_ERROR_CLASS_CONFIG,
])

/**
 * The verdict over one `pause` answer on a live row (b.jg5 SRJ-903,
 * SRJ-119); see the module comment. "Another `ErrInternal`" is an
 * UNCLASSIFIED classification whose reported name is `ERR_INTERNAL_NAME`.
 * Pure; never throws.
 */
export function pauseVerdictOf(answer: PauseAnswer): PauseVerdict {
  if (!('error' in answer)) return PAUSE_DONE
  const { errorClass, reportedName } = classifyAdError(answer.error)
  if (PAUSE_FAIL_CLASSES.has(errorClass) || (errorClass === AD_ERROR_CLASS_UNCLASSIFIED && reportedName === ERR_INTERNAL_NAME)) {
    return { kind: PAUSE_VERDICT_FAIL, ...teardownErrorReportOf(answer.error) }
  }
  const description = describeReportedAdFailure(answer.error)
  if (errorClass === AD_ERROR_CLASS_UNAVAILABLE) return { kind: PAUSE_VERDICT_RETRY, errorClass, description }
  // Every other class escalates: GONE, STATE (`ErrSpawnNotPausable` on a
  // `pending` row, `ErrSpawnNotFound`), LAUNCH FAILURE, DIRECTORY, and every
  // UNCLASSIFIED name but `ErrInternal` (`ErrPauseTimeout` and the three store
  // names included), which the kill then decides.
  return { kind: PAUSE_VERDICT_ESCALATE, errorClass, description }
}

/**
 * The verdict that stands after the last of the {@link PRECHECK_TRIES}
 * `pause` calls (b.jg5 SRJ-903): a retry escalates to the kill; any other
 * verdict stands as it is. Pure; never throws.
 */
export function pauseVerdictAfterLastTry(verdict: PauseVerdict): PauseVerdict {
  return verdict.kind === PAUSE_VERDICT_RETRY ? { ...verdict, kind: PAUSE_VERDICT_ESCALATE } : verdict
}

// ---------------------------------------------------------------------------
// The teardown's poll
// ---------------------------------------------------------------------------

/** The poll's first wait after a successful pause; each later wait doubles, up to {@link TEARDOWN_POLL_MAX_WAIT_MS}. */
export const TEARDOWN_POLL_FIRST_WAIT_MS = 100

/** The poll's longest wait between two `status` reads; the last wait is also cut short at `exit_timeout`. */
export const TEARDOWN_POLL_MAX_WAIT_MS = 2_000

/** Milliseconds in one second, for `exit_timeout`, which the configuration gives in seconds. */
const MS_PER_SECOND = 1_000

/**
 * `exit_timeout` (seconds) in milliseconds: how long the poll after a
 * successful pause waits for the row to end before the kill. A negative or
 * non-finite value is 0. Pure; never throws.
 */
export function exitTimeoutMsOf(exitTimeoutSeconds: number): number {
  return Number.isFinite(exitTimeoutSeconds) && exitTimeoutSeconds > 0 ? exitTimeoutSeconds * MS_PER_SECOND : 0
}

// ---------------------------------------------------------------------------
// The teardown's kill
// ---------------------------------------------------------------------------

/**
 * The read between kill tries as the bounded retry takes it (b.jg5 SRJ-904,
 * SRJ-702, SRJ-115), from one `status` answer: no row → `KILL_RETRY_READ_NO_ROW`;
 * a row → `KILL_RETRY_READ_STATE` with its state, `pending` with no launch
 * start being a live read; a thrown value → `KILL_RETRY_READ_FAILED`, an
 * UNUSABLE NAME answer included. Never `KILL_RETRY_READ_LATCHED`: nothing
 * latches in the CLI, so each of those lets the next try go ahead (the
 * retry itself ends the tries as a success on `ended`, `missing` or a thrown
 * `ErrSpawnNotFound`). Pure; never throws.
 */
export function teardownKillReadOf(answer: StateReadAnswer): KillRetryRead {
  if ('error' in answer) return { kind: KILL_RETRY_READ_FAILED, error: answer.error }
  if (answer.row === null) return { kind: KILL_RETRY_READ_NO_ROW }
  return { kind: KILL_RETRY_READ_STATE, state: answer.row.state }
}

/**
 * The checked kill's options for every try of the teardown's kill (b.jg5
 * SRJ-904, SRJ-110; hatch A3): only SRJ-110's success forms stop a persona in
 * the CLI, so a GONE answer is a non-success. The bounded retry then never
 * tries it again (SRJ-702), logs the try and the end as that failure, and
 * decides the ordinary alert version (quoting a survivor-naming description
 * of an earlier try) rather than the survivor version.
 */
export const TEARDOWN_KILL_OPTIONS: CheckedKillOptions = Object.freeze({ goneIsFailure: true })

/**
 * The bounded retry's options for the teardown's kill (b.jg5 SRJ-904,
 * SRJ-702, SRJ-316): a CONFIG answer at a `status` read between tries ends
 * them (`read-config`), with no further kill, whatever state was last read,
 * and the result keeps that read's error (`configRead`), which fails the
 * persona with class CONFIG ({@link teardownKillOutcomeOf}).
 */
export const TEARDOWN_KILL_RETRY_OPTIONS: Pick<KillRetryOptions<AnyKillOutcome>, 'configReadEndsTries'> = Object.freeze({
  configReadEndsTries: true,
})

/**
 * The persona's teardown outcome from its kill's bounded retry, run under
 * {@link TEARDOWN_KILL_OPTIONS} and {@link TEARDOWN_KILL_RETRY_OPTIONS}
 * (b.jg5 SRJ-904, SRJ-702, SRJ-907; hatch A3). Pure; never throws.
 *
 *   - a `read-config` end (a CONFIG answer at a read between tries, whatever
 *     state was last read): failed, class CONFIG, its description the read's
 *     error naming {@link AD_CONFIG_FILE_DISPLAY_NAME};
 *   - `not-killed`: failed with its class (UNAVAILABLE after its tries,
 *     GONE (`ErrTmuxSendKeys`, `ErrTmuxCaptureFailed`; the checked kill's
 *     `goneIsFailure` non-success, never tried again), CONFLICT, ENVIRONMENT,
 *     UNUSABLE NAME, CONFIG, UNCLASSIFIED with the three store names and
 *     `ErrInternal`), an unlisted class (a STATE name other than
 *     `ErrSpawnNotFound`, DIRECTORY, LAUNCH FAILURE) reported under the
 *     classifier's class, never relabelled UNCLASSIFIED;
 *   - a success (`killed`, whatever its `kill_sent`, absent included;
 *     `row-gone`; `row-finished`): stopped, reason killed. Only these stop
 *     a persona in the CLI;
 *   - `session-gone`, which a checked kill under `goneIsFailure` never
 *     answers: failed, class GONE, its description the GONE name (the
 *     class's own name when the GONE name cannot be read);
 *   - any other outcome: failed, class UNCLASSIFIED.
 * A failure's description is `describeReportedAdFailure` of the thrown value
 * (SRJ-104): redacted, on one line. The outcome carries the retry's alert
 * decision as it is: none or the survivor version for a stopped persona,
 * none or the ordinary version for a failed one.
 */
export function teardownKillOutcomeOf(result: KillRetryResult<AnyKillOutcome>): PersonaTeardownOutcome {
  const { outcome } = result
  const kill: TeardownKillReport = { outcome, end: result.end, tries: result.tries, reads: result.reads, alert: result.alert }
  if (result.end === KILL_RETRY_END_READ_CONFIG && result.configRead !== undefined) {
    return { ...teardownFailed(TEARDOWN_STEP_KILL, errorReportOfClass(AD_ERROR_CLASS_CONFIG, result.configRead.error)), kill }
  }
  switch (outcome.kind) {
    case KILL_OUTCOME_KILLED:
    case KILL_OUTCOME_ROW_GONE:
    case KILL_OUTCOME_ROW_FINISHED:
      return { ...teardownStopped(TEARDOWN_STOPPED_KILLED), kill }
    case KILL_OUTCOME_SESSION_GONE:
      return {
        ...teardownFailed(TEARDOWN_STEP_KILL, { errorClass: AD_ERROR_CLASS_GONE, description: outcome.name ?? AD_ERROR_CLASS_GONE }),
        kill,
      }
    case KILL_OUTCOME_NOT_KILLED:
      return { ...teardownFailed(TEARDOWN_STEP_KILL, errorReportOfClass(killFailureClassOf(outcome), outcome.error)), kill }
  }
  // Any outcome kind not listed above fails the persona: only the listed successes stop it.
  return { ...teardownFailed(TEARDOWN_STEP_KILL, errorReportOfClass(AD_ERROR_CLASS_UNCLASSIFIED, undefined)), kill }
}

/** A non-success's class as the CLI reports it: the classifier's own for an unlisted class. */
function killFailureClassOf(outcome: AnyKillFailure): AdErrorClass {
  if (outcome.errorClass === AD_ERROR_CLASS_UNAVAILABLE || outcome.errorClass === AD_ERROR_CLASS_GONE) return outcome.errorClass
  return outcome.unlistedClass ?? outcome.errorClass
}

// ---------------------------------------------------------------------------
// Bounded cost (b.jg5 SRJ-908)
// ---------------------------------------------------------------------------

/** The precheck's calls of one persona, each with its own tries: the `get`, then the `read-pane`. */
const PRECHECK_CALLS_PER_PERSONA: readonly PrecheckCall[] = [PRECHECK_CALL_GET, PRECHECK_CALL_READ_PANE]

/** A call timeout as a bound: a negative or non-finite value is 0. */
function callBoundMs(callTimeoutMs: number): number {
  return Number.isFinite(callTimeoutMs) && callTimeoutMs > 0 ? callTimeoutMs : 0
}

/**
 * The longest time `tries` calls of one call take, `spacingMs` apart, each
 * call taking `callMs`, with `readsBetween` further calls (the bounded kill
 * retry's `status` read) after each wait.
 */
function triesBoundMs(tries: number, spacingMs: number, callMs: number, readsBetween: number): number {
  return tries * callMs + (tries - 1) * (spacingMs + readsBetween * callMs)
}

/**
 * The longest time, in ms, one persona's precheck takes (b.jg5 SRJ-908,
 * SRJ-901), each call taking `callTimeoutMs`: its `get`'s
 * {@link PRECHECK_TRIES} calls {@link PRECHECK_TRY_SPACING_MS} apart, then its
 * `read-pane`'s. Personas are checked in parallel, so this also bounds the
 * precheck of a persona set. Pure; never throws.
 */
export function precheckBoundMs(callTimeoutMs: number): number {
  const call = callBoundMs(callTimeoutMs)
  return PRECHECK_CALLS_PER_PERSONA.length * triesBoundMs(PRECHECK_TRIES, PRECHECK_TRY_SPACING_MS, call, 0)
}

/**
 * The longest time, in ms, one persona's teardown takes (b.jg5 SRJ-908), each
 * call taking `callTimeoutMs`. Personas are torn down in parallel, so this
 * also bounds the teardown of a persona set. Pure; never throws.
 *
 *   the state read                     1 call
 *   the pause                          PRECHECK_TRIES calls, PRECHECK_TRY_SPACING_MS apart
 *   the poll                           exit_timeout, then its last `status` call
 *   the kill                           KILL_RETRY_TRIES calls, KILL_RETRY_SPACING_MS apart,
 *                                      one `status` read after each wait
 *
 * The poll's last wait is cut short at `exit_timeout`, so a read that starts
 * before it is the poll's last; a pause that escalates goes to the kill with
 * no poll, so the sum is an upper bound of every path.
 */
export function teardownBoundMs(exitTimeoutSeconds: number, callTimeoutMs: number): number {
  const call = callBoundMs(callTimeoutMs)
  const stateRead = call
  const pause = triesBoundMs(PRECHECK_TRIES, PRECHECK_TRY_SPACING_MS, call, 0)
  const poll = exitTimeoutMsOf(exitTimeoutSeconds) + call
  const kill = triesBoundMs(KILL_RETRY_TRIES, KILL_RETRY_SPACING_MS, call, 1)
  return stateRead + pause + poll + kill
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** A persona as the CLI's lines name it. */
export interface CliTeardownPersona {
  readonly name: string
  readonly key: string
}

/** `persona "<name>" (key=<key>), session "slack_bot_<key>"`: a persona and its session, as the CLI's lines name them. */
function personaWithSession(persona: CliTeardownPersona): string {
  return `persona ${renderPersonaRef(persona.name, persona.key)}, session ${JSON.stringify(personaTmuxSessionName(persona.key))}`
}

/**
 * One persona's precheck failure line (b.jg5 SRJ-901):
 * `<command>: precheck failed for persona "<name>" (key=<key>), session "slack_bot_<key>": <class>: <description>`.
 */
export function precheckFailureLine(
  command: CliTeardownCommand,
  persona: CliTeardownPersona,
  failure: PrecheckFailure,
): string {
  return `${command}: precheck failed for ${personaWithSession(persona)}: ${failure.errorClass}: ${failure.description}`
}

/** The last line of a failed precheck (b.jg5 SRJ-901): `<command>: nothing was stopped`. */
export function precheckNothingStoppedLine(command: CliTeardownCommand): string {
  return `${command}: nothing was stopped`
}

/**
 * The line of a failed agent-director initialization, before anything is
 * stopped (b.jg5 SRJ-901 step 1, SRJ-902, SRJ-203):
 * `[slack] <command>: agent-director initialization failed: <description>`,
 * `description` being the CLI's one-line description of the failure (the
 * startup gate's own message, or the thrown value's redacted message).
 * Pure; never throws.
 */
export function agentDirectorInitFailedLine(command: CliTeardownCommand, description: string): string {
  return `[slack] ${command}: agent-director initialization failed: ${description}`
}

/**
 * The last line of `stop --stop-bots` when the agent-director client refuses
 * the binary as too old (b.jg5 SRJ-902): no agent-director call can be made,
 * so the server alone is stopped and every worker and row is left as it is.
 * It follows the initialization-failed line that carries the gate's too-old
 * message (the version found, the version required and the switch-over
 * section).
 */
export function onlyServerStoppedLine(): string {
  return `${CLI_COMMAND_STOP_BOTS}: only the server was stopped; every worker and row was left as it is`
}

// ---------------------------------------------------------------------------
// The teardown's report (b.jg5 SRJ-907, SRJ-909, SRJ-1013)
// ---------------------------------------------------------------------------

/**
 * The `startup-errors.log` class of a CLI teardown failure whose line the
 * kill-failure alert does not follow (b.jg5 SRJ-1013, SRJ-909).
 */
export const CLI_TEARDOWN_FAILED_LABEL = 'cli-teardown-failed'

/** What a failure line reports: the outcome's class and its redacted one-line description. */
export type TeardownFailureLineReport = Pick<TeardownErrorReport, 'errorClass' | 'description'>

/**
 * One persona's teardown failure line (b.jg5 SRJ-907):
 * `<command>: could not stop persona "<name>" (key=<key>), session "slack_bot_<key>": <class>: <description>`.
 * The class is the outcome's (the classifier's, never relabelled); the
 * description is the outcome's `describeReportedAdFailure` rendering,
 * redacted on one line, a CONFIG failure's naming
 * {@link AD_CONFIG_FILE_DISPLAY_NAME}. Pure; never throws.
 */
export function teardownFailureLine(
  command: CliTeardownCommand,
  persona: CliTeardownPersona,
  failure: TeardownFailureLineReport,
): string {
  return `${command}: could not stop ${personaWithSession(persona)}: ${failure.errorClass}: ${failure.description}`
}

/**
 * The teardown's last line when at least one persona could not be stopped
 * (b.jg5 SRJ-907): `<command>: could not stop <N> persona(s); rows are never
 * deleted, so running the command again is safe`. `failedCount` counts only
 * the failed personas, never one stopped with the survivor version. Printed
 * only, never logged or recorded. Pure; never throws.
 */
export function teardownNotStoppedLine(command: CliTeardownCommand, failedCount: number): string {
  return `${command}: could not stop ${failedCount} persona(s); rows are never deleted, so running the command again is safe`
}

/** A startup-errors entry the report records: its class and its one-line message. */
export interface CliTeardownStartupErrorEntry {
  readonly classLabel: string
  readonly message: string
}

/**
 * One persona's report (b.jg5 SRJ-907, SRJ-909): the lines to print (stderr;
 * for `clean_restart` also `clean_restart.log`), the lines to append to
 * `server.log`, and at most one `startup-errors.log` entry.
 */
export interface PersonaTeardownReport {
  /** True when the persona could not be stopped: it has a failure line and counts in the last line. */
  readonly failed: boolean
  /** The lines to print, in order. */
  readonly printed: readonly string[]
  /** The lines to append to `server.log`, one line each, in order. */
  readonly logged: readonly string[]
  /** The startup-errors entry, when the persona has one. */
  readonly entry?: CliTeardownStartupErrorEntry
}

const NOTHING_TO_REPORT: PersonaTeardownReport = Object.freeze({ failed: false, printed: [], logged: [] })

/** A kill-failure alert as the CLI teardown's route gives it: printed, logged and recorded. */
interface CliTeardownAlert {
  /** The alert in the log-line and entry form, its context naming the command. */
  readonly line: string
  /** The route's startup-errors class. */
  readonly classLabel: string
}

/**
 * The kill-failure alert for `decision`, routed for a CLI teardown (b.jg5
 * SRJ-704, SRJ-1007, SRJ-1013): the route selection's closing sentence and
 * class, the text unescaped (`forSlack` false), in the log-line and entry
 * form with the persona and the CLI teardown's context naming `command`.
 * Undefined for a `none` decision. The CLI teardown's route always prints
 * the alert and always has a class.
 */
function cliTeardownAlertOf(
  command: CliTeardownCommand,
  persona: CliTeardownPersona,
  decision: KillRetryAlert,
): CliTeardownAlert | undefined {
  const content = killFailureAlertContentOf(decision, personaTmuxSessionName(persona.key), personaInstanceId(persona.key))
  if (content === undefined) return undefined
  // The CLI-teardown context matches before the configured and latched
  // inputs are read (SRJ-704's first match).
  const route = selectKillFailureAlertRoute({
    version: content.version,
    context: KILL_FAILURE_CONTEXT_CLI_TEARDOWN,
    configured: true,
    latched: false,
  })
  const text = killFailureAlertText(content, route.closing, false)
  const line = killFailureAlertEntryText(
    `persona ${renderPersonaRef(persona.name, persona.key)}`,
    killFailureCliTeardownEntryContext(command),
    text,
  )
  return { line, classLabel: route.classLabel }
}

/**
 * One persona's report from its teardown outcome under `command` (b.jg5
 * SRJ-907, SRJ-909, SRJ-1013), following the outcome's own alert decision:
 * a stopped persona's survivor version and a failed persona's ordinary
 * version are reported, and nothing else is. Pure; never throws.
 *
 *   - stopped with no alert: nothing;
 *   - stopped with the survivor decision: the survivor text with its CLI
 *     closing sentence, printed and logged as one line, and one
 *     `persona-kill-survivor` entry holding that line; not failed, so no
 *     failure line and not counted;
 *   - failed with the ordinary decision: the failure line, then the ordinary
 *     text with its CLI closing sentence, printed and logged as two lines,
 *     and one `persona-kill-failed` entry holding the failure line followed
 *     by the alert line;
 *   - any other failure: the failure line, printed and logged, and one
 *     {@link CLI_TEARDOWN_FAILED_LABEL} entry.
 *
 * The alert line is E20's log-line and entry form
 * (`persona "<name>" (key=<key>) (CLI teardown, <command>): <text>`); its
 * route, closing sentence and class come from `selectKillFailureAlertRoute`.
 */
export function personaTeardownReportOf(
  command: CliTeardownCommand,
  persona: CliTeardownPersona,
  outcome: PersonaTeardownOutcome,
): PersonaTeardownReport {
  if (outcome.kind === TEARDOWN_OUTCOME_STOPPED) {
    const decision = outcome.kill?.alert
    const alert = decision?.kind === KILL_RETRY_ALERT_SURVIVOR ? cliTeardownAlertOf(command, persona, decision) : undefined
    if (alert === undefined) return NOTHING_TO_REPORT
    return {
      failed: false,
      printed: [alert.line],
      logged: [alert.line],
      entry: { classLabel: alert.classLabel, message: alert.line },
    }
  }
  const failureLine = teardownFailureLine(command, persona, outcome)
  const decision = outcome.kill?.alert
  const alert = decision?.kind === KILL_RETRY_ALERT_ORDINARY ? cliTeardownAlertOf(command, persona, decision) : undefined
  if (alert === undefined) {
    return {
      failed: true,
      printed: [failureLine],
      logged: [failureLine],
      entry: { classLabel: CLI_TEARDOWN_FAILED_LABEL, message: failureLine },
    }
  }
  return {
    failed: true,
    printed: [failureLine, alert.line],
    logged: [failureLine, alert.line],
    entry: { classLabel: alert.classLabel, message: `${failureLine} ${alert.line}` },
  }
}

// ---------------------------------------------------------------------------
// clean_restart's restart after a failed teardown (b.jg5 SRJ-906, SRJ-1013)
// ---------------------------------------------------------------------------

/**
 * The `startup-errors.log` class of a `clean_restart` whose teardown failed
 * and whose answer check found agent-director not answering, so the server
 * was not started (b.jg5 SRJ-906, SRJ-1013).
 */
export const CLEAN_RESTART_NOT_RESTARTED_LABEL = 'clean-restart-not-restarted'

/** The sentence the not-restarted alert ends with (b.jg5 SRJ-1013). */
export const CLEAN_RESTART_NOT_STARTED_SENTENCE = 'the server was not started: start it once agent-director answers'

/** A persona `clean_restart` could not stop, with the class its teardown failed under. */
export interface CleanRestartFailedPersona {
  readonly persona: CliTeardownPersona
  readonly errorClass: AdErrorClass
}

/**
 * The one not-restarted alert of a `clean_restart` run (b.jg5 SRJ-906,
 * SRJ-1013): printed, appended as one `server.log` line and recorded as one
 * {@link CLEAN_RESTART_NOT_RESTARTED_LABEL} entry, the same text on all three
 * routes. It names every persona that could not be stopped, in the order
 * given, with its session and class, and ends with
 * {@link CLEAN_RESTART_NOT_STARTED_SENTENCE}:
 *
 *   `clean_restart: could not stop persona "<name>" (key=<key>), session "slack_bot_<key>": <class>;
 *    persona "<name>" (key=<key>), session "slack_bot_<key>": <class>; agent-director did not answer,
 *    so the server was not started: start it once agent-director answers`
 *
 * (one line). It carries no agent-director description: each persona's own
 * failure line carries that, redacted. Pure; never throws.
 */
export function cleanRestartNotRestartedAlert(failures: readonly CleanRestartFailedPersona[]): string {
  const personas = failures.map(({ persona, errorClass }) => `${personaWithSession(persona)}: ${errorClass}`).join('; ')
  return (
    `${CLI_COMMAND_CLEAN_RESTART}: could not stop ${personas}; ` +
    `agent-director did not answer, so ${CLEAN_RESTART_NOT_STARTED_SENTENCE}`
  )
}

/**
 * One failed try of `clean_restart`'s answer check (b.jg5 SRJ-906), printed
 * only:
 * `[slack] clean_restart: agent-director answer check: list try <n> of 3 failed: <class>: <description>`,
 * the class and description being {@link teardownErrorReportOf}'s, redacted
 * on one line. Pure; never throws.
 */
export function answerCheckFailedTryLine(tryNumber: number, report: TeardownFailureLineReport): string {
  return (
    `[slack] ${CLI_COMMAND_CLEAN_RESTART}: agent-director answer check: list try ${tryNumber} of ${PRECHECK_TRIES} failed: ` +
    `${report.errorClass}: ${report.description}`
  )
}

/**
 * The line before `clean_restart` starts the server after a failed teardown,
 * once agent-director answered (b.jg5 SRJ-906):
 * `[slack] clean_restart: agent-director answers — starting server after the failed teardown`.
 */
export function cleanRestartStartingAfterFailedTeardownLine(): string {
  return `[slack] ${CLI_COMMAND_CLEAN_RESTART}: agent-director answers — starting server after the failed teardown`
}

/**
 * `clean_restart`'s line when the `start` it spawned exits non-zero, or
 * cannot be spawned (`status` null) (b.jg5 SRJ-906):
 * `[slack] clean_restart: start failed with exit code <status>`.
 */
export function cleanRestartStartFailedLine(status: number | null): string {
  return `[slack] ${CLI_COMMAND_CLEAN_RESTART}: start failed with exit code ${status}`
}
