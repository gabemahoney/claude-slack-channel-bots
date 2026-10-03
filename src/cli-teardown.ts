/**
 * cli-teardown.ts — The pure pieces of the CLI's persona teardown commands,
 * `stop --stop-bots` and `clean_restart` (`src/cli.ts`): the precheck's
 * verdict over one answer, its tries and spacing, its two operator lines,
 * `stop --stop-bots`' too-old line and the config-file display name (b.jg5
 * SRJ-901, SRJ-902, SRJ-117, SRJ-908); and the teardown's per-persona
 * outcome, its pause verdict and its state-read verdict (SRJ-903, SRJ-119,
 * SRJ-316; hatch note E12).
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
 * poll or kill), the classifier's class (never relabelled UNCLASSIFIED, as
 * the precheck's `get` relabels), the redacted one-line description
 * `describeReportedAdFailure` renders (SRJ-104) and whether it is a CONFIG
 * failure naming {@link AD_CONFIG_FILE_DISPLAY_NAME} (SRJ-316).
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
 * The precheck and the teardown have no side effects beyond the teardown's
 * own `pause` and `kill` (SRJ-114, SRJ-115, SRJ-801, SRJ-1002): nothing
 * latches, no record is written and no retired-key entry is cleared. This
 * module therefore imports only pure modules and never the session manager,
 * the conflict latch, the retired-key record or `src/cli.ts`.
 *
 * Pure: no module-scope state, no I/O, no timer, no agent-director call, no
 * log line. Never throws.
 *
 * SPDX-License-Identifier: MIT
 */

import { join } from 'node:path'

import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  classifyAdError,
  describeReportedAdFailure,
  hasAdErrorName,
  type AdErrorClass,
} from './ad-error-class.ts'
import { AD_SETTINGS_RELATIVE_PATH } from './ad-settings.ts'
import { ERR_INTERNAL_NAME, ERR_SPAWN_NOT_FOUND_NAME } from './agent-director-errors.ts'
import { AGENT_DIRECTOR_DEAD_STATES } from './liveness-reading.ts'
import {
  PANE_READ_ABSENT,
  PANE_READ_CONFIG,
  PANE_READ_GONE,
  PANE_READ_UNAVAILABLE,
  PANE_READ_UNCLASSIFIED,
  paneReadFailureOf,
} from './pane-read.ts'
import { personaTmuxSessionName, renderPersonaRef } from './persona-identity.ts'

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
 * `~/.agent-director/config.toml` (b.jg5 SRJ-901, SRJ-316).
 */
export const AD_CONFIG_FILE_DISPLAY_NAME = join('~', AD_SETTINGS_RELATIVE_PATH)

// ---------------------------------------------------------------------------
// Tries
// ---------------------------------------------------------------------------

/** Most calls the precheck makes of one `get` or `read-pane` that answers UNAVAILABLE (b.jg5 SRJ-901 step 3). */
export const PRECHECK_TRIES = 3

/** The wait between two tries of one precheck call, on the CLI's injected clock (b.jg5 SRJ-901, SRJ-908). */
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

/** The step of a persona's teardown that failed. */
export type TeardownStep =
  | typeof TEARDOWN_STEP_STATE_READ
  | typeof TEARDOWN_STEP_PAUSE
  | typeof TEARDOWN_STEP_POLL
  | typeof TEARDOWN_STEP_KILL

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
  /** True for a CONFIG failure, whose description names the config file (b.jg5 SRJ-316). */
  readonly namesConfigFile: boolean
}

/** A persona's teardown that stopped it. */
export interface TeardownStoppedOutcome {
  readonly kind: typeof TEARDOWN_OUTCOME_STOPPED
  readonly reason: TeardownStoppedReason
}

/** A persona's teardown that failed, at `step`, with what the answer reports. */
export interface TeardownFailedOutcome extends TeardownErrorReport {
  readonly kind: typeof TEARDOWN_OUTCOME_FAILED
  readonly step: TeardownStep
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
    namesConfigFile: report.namesConfigFile,
  }
}

/**
 * What a teardown failure reports for a value an agent-director call threw
 * (b.jg5 SRJ-104, SRJ-316; hatch note E12): the classifier's class, unchanged,
 * and `describeReportedAdFailure`'s description, after a lead naming
 * {@link AD_CONFIG_FILE_DISPLAY_NAME} for a CONFIG answer. Pure; never throws.
 */
export function teardownErrorReportOf(error: unknown): TeardownErrorReport {
  const { errorClass } = classifyAdError(error)
  const description = describeReportedAdFailure(error)
  if (errorClass === AD_ERROR_CLASS_CONFIG) {
    return { errorClass, description: configFailureDescription(description), namesConfigFile: true }
  }
  return { errorClass, description, namesConfigFile: false }
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

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/**
 * One persona's precheck failure line (b.jg5 SRJ-901):
 * `<command>: precheck failed for persona "<name>" (key=<key>), session "slack_bot_<key>": <class>: <description>`.
 */
export function precheckFailureLine(
  command: CliTeardownCommand,
  persona: { readonly name: string; readonly key: string },
  failure: PrecheckFailure,
): string {
  const session = JSON.stringify(personaTmuxSessionName(persona.key))
  return (
    `${command}: precheck failed for persona ${renderPersonaRef(persona.name, persona.key)}, ` +
    `session ${session}: ${failure.errorClass}: ${failure.description}`
  )
}

/** The last line of a failed precheck (b.jg5 SRJ-901): `<command>: nothing was stopped`. */
export function precheckNothingStoppedLine(command: CliTeardownCommand): string {
  return `${command}: nothing was stopped`
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
