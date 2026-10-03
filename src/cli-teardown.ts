/**
 * cli-teardown.ts — The pure pieces of the CLI's persona teardown commands,
 * `stop --stop-bots` and `clean_restart` (`src/cli.ts`): the precheck's
 * verdict over one answer, its tries and spacing, its two operator lines,
 * `stop --stop-bots`' too-old line and the config-file display name (b.jg5
 * SRJ-901, SRJ-902, SRJ-117, SRJ-908).
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
 * The precheck has no side effects (SRJ-114, SRJ-115, SRJ-801): nothing
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
import { ERR_SPAWN_NOT_FOUND_NAME } from './agent-director-errors.ts'
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
    description: `agent-director refuses its config file ${AD_CONFIG_FILE_DISPLAY_NAME}: ${description}`,
  }
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
