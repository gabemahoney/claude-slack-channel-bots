/**
 * pane-read.ts — The outcome of one `read-pane` of a persona's own row, its
 * class under b.jg5 SRJ-117's table, and the line counts (the full read and
 * the one-line probe).
 *
 * Every site that reads persona P's pane reads P's own row `cscb_<key>`.
 * agent-director answers by the row's current launch: the worker's pane, or,
 * when no session of the current launch is there and exactly one leftover of
 * the persona is, that leftover's pane, the one agent-director's own per-pane
 * label marks with the leftover's token. CSCB never reads or sets that label.
 * With neither there the answer is GONE (`ErrTmuxCaptureFailed`); when the
 * worker's pane is not found, the one leftover has no pane carrying its
 * token, or several leftovers run, it is CONFLICT.
 *
 * A pane may be a single leftover's: it never proves on its own that the
 * worker's own session is there (b.jg5 SRJ-117, SRJ-613), and no site acts
 * on a pane alone. A pane leads at most to a deferral (b.jdc's reconnect
 * verdict), no action (b.jdc's ladder action), a positive-idle fold that
 * also needs the transcript (the working-row verdict and the launch wait's
 * evidence read), the reconnect (the waiting-row check) or Enter (the dialog
 * approver and the pending-row rule's lap). The backstop is the `send-keys`
 * that follows, which
 * agent-director answers by the row's current launch and which types nothing
 * when it refuses:
 *   - the reconnect's `/mcp reconnect` (`reconnectMcpWithCause`) on a live
 *     row that is not `pending` answers CONFLICT "not this launch's
 *     session": nothing is typed, CSCB latches P (b.jg5 SRJ-501) and posts
 *     its CONFLICT notice once (SRJ-508), and the refused `send-keys` is
 *     never retried (SRJ-118, SRJ-505);
 *   - the approver's Enter on a `pending` row answers
 *     `ErrSpawnNotInteractive`: the approver stops with nothing typed, no
 *     kill and one log line (b.jg5 SRJ-404);
 *   - the pending-row rule's lap Enter (`sendPendingRowLapEnter`) on a
 *     `pending` row answers `ErrSpawnNotInteractive` the same way: nothing
 *     is typed, the lap ends, no further lap is made on that launch, and the
 *     rule's run goes on (b.jg5 SRJ-410).
 * A pane that leads to a deferral or to no action is followed by no
 * keystroke at all; once a later tick reads the row `waiting`, or shows a
 * `working` row stale, the reconnect's `send-keys` is the backstop again.
 * Each site's own comment names its backstop.
 *
 * The users of {@link PaneReadOutcome} are the shared reader
 * `readPersonaOwnPane` in `src/session-manager.ts` and, through it, the
 * b.d61 working-row verdict (`workingReconnectVerdict` in `src/server.ts`,
 * whose pane `checkWorkingRowPane` folds), the b.f2b waiting-row check
 * (`checkWaitingRowPane`), the launch wait's evidence read
 * (`staleWorkingRowIsIdle`), and b.jdc's two prompt-row paths: the reconnect
 * verdict (`promptRowReconnectVerdict` in `src/server.ts`) and the ladder
 * action (`launchOnPromptRow`), which read with the one-line probe count
 * ({@link PROBE_PANE_READ_LINES}); both of b.jdc's columns of SRJ-117's
 * table are built; and the pending-row rule's lap (`readPendingRowLapPane`,
 * 40 lines, the only read made with `allow_pending`), whose pane leads at
 * most to Enter. b.jg5 SRJ-117 holds the full table of sites
 * that read a persona's pane and how each handles each outcome. The dialog
 * approver (`approvePreSessionDialogs`) keeps its own classification and
 * does not use this module.
 *
 * {@link paneReadFailureOf} maps a value thrown by `read-pane` to exactly one
 * failure outcome, by class and by name through `src/ad-error-class.ts`
 * (b.jg5 SRJ-104; never by testing the value against an error class). What
 * each outcome means at a site is the caller's to decide:
 *
 *   GONE          `ErrTmuxCaptureFailed` (any GONE class)
 *   ABSENT        `ErrSpawnNotFound`: the row is absent
 *   CONFLICT      `ErrTmuxSessionConflict`, the thrown value kept so the
 *                 caller can latch (b.jg5 SRJ-501)
 *   UNUSABLE NAME an `ErrInternal` naming the recorded tmux session name, the
 *                 thrown value kept so the caller can latch (b.jg5 SRJ-512)
 *   CONFIG        `ErrConfigMalformed` (the outage is raised by the caller's
 *                 agent-director wrapper, not here)
 *   ENVIRONMENT   `ErrTmuxNotAvailable`
 *   UNAVAILABLE   timeouts included: `ErrTmuxUnresponsive`, `ErrCallTimeout`,
 *                 an `ErrUnknownErrorName` of a later name, CSCB's own
 *                 `UnknownError` wrapper and any value that is not an
 *                 agent-director error
 *   UNCLASSIFIED  every other value: an `ErrInternal` without that phrase,
 *                 the store-open names, `ErrSystemInstallDisappeared`, any
 *                 STATE name but `ErrSpawnNotFound`, LAUNCH FAILURE,
 *                 DIRECTORY and every name CSCB gives no handling
 *
 * A pane is {@link PANE_READ_PANE}; the shared reader in
 * `src/session-manager.ts` (`readPersonaOwnPane`) answers
 * {@link PANE_READ_LATCHED} for a persona it did not read because it is
 * latched, or that its CONFLICT or UNUSABLE NAME answer latched.
 *
 * Each failure outcome carries the classifier's class and the redacted
 * one-line description `describeAgentDirectorFailure` renders (the safe
 * `errName`, then the description through `redactSlackLogText`, on one line,
 * capped); {@link paneReadClassNote} renders the class for the end of a
 * site's log line. An UNCLASSIFIED outcome the shared reader answers for an
 * `ErrInvalidFlags` whose version re-check decided that the server stops
 * carries the stop mark `stopping: true` ({@link PaneReadUnclassified}).
 * The module is pure: no agent-director call, no latch, no module state, no
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
  AD_ERROR_CLASS_UNUSABLE_NAME,
  classifyAdError,
  describeAgentDirectorFailure,
  hasAdErrorName,
  type AdErrorClass,
} from './ad-error-class.ts'
import { ERR_SPAWN_NOT_FOUND_NAME } from './agent-director-errors.ts'

/**
 * Trailing pane lines a full read asks for (b.jg5 SRJ-117's `n_lines` at the
 * working-row verdict, the waiting-row check and the launch wait's evidence
 * read).
 */
export const FULL_PANE_READ_LINES = 40

/**
 * Trailing pane lines a one-line probe asks for (b.jg5 SRJ-117's `n_lines`
 * at b.jdc's reconnect verdict, `promptRowReconnectVerdict` in
 * `src/server.ts`, and b.jdc's ladder action, `launchOnPromptRow`; SRJ-606,
 * SRJ-607). These read whether agent-director answers a pane at all, not what
 * it shows; the pane may be a single leftover's (b.jg5 SRJ-613), so its
 * answer is no proof that the worker's own session is there. SRJ-117's
 * table gives the same count to the latch re-check probe (SRJ-505) and the
 * CLI precheck (SRJ-901); neither reads a pane through this module today.
 */
export const PROBE_PANE_READ_LINES = 1

// ---------------------------------------------------------------------------
// Outcome kinds
// ---------------------------------------------------------------------------

/** The read answered a pane. */
export const PANE_READ_PANE = 'pane'
/** GONE: the session is not there (`ErrTmuxCaptureFailed`). */
export const PANE_READ_GONE = 'gone'
/** The row is absent (`ErrSpawnNotFound`). */
export const PANE_READ_ABSENT = 'absent'
/** CONFLICT (`ErrTmuxSessionConflict`). */
export const PANE_READ_CONFLICT = 'conflict'
/** UNUSABLE NAME: the row's recorded tmux session name cannot be used. */
export const PANE_READ_UNUSABLE_NAME = 'unusable-name'
/** CONFIG: agent-director's config file is malformed. */
export const PANE_READ_CONFIG = 'config'
/** ENVIRONMENT: tmux is not available. */
export const PANE_READ_ENVIRONMENT = 'environment'
/** UNAVAILABLE: agent-director or tmux could not answer (timeouts included). */
export const PANE_READ_UNAVAILABLE = 'unavailable'
/** UNCLASSIFIED: an answer CSCB gives no handling at a pane read. */
export const PANE_READ_UNCLASSIFIED = 'unclassified'
/** The persona is latched: it was not read, or its CONFLICT or UNUSABLE NAME answer latched it. */
export const PANE_READ_LATCHED = 'latched'

/** Every failure kind {@link paneReadFailureOf} answers, in SRJ-117's column order. */
export const PANE_READ_FAILURE_KINDS = [
  PANE_READ_GONE,
  PANE_READ_ABSENT,
  PANE_READ_UNAVAILABLE,
  PANE_READ_CONFLICT,
  PANE_READ_UNUSABLE_NAME,
  PANE_READ_CONFIG,
  PANE_READ_ENVIRONMENT,
  PANE_READ_UNCLASSIFIED,
] as const

/** One failure kind. */
export type PaneReadFailureKind = (typeof PANE_READ_FAILURE_KINDS)[number]

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * The read answered a pane (its text). It may be a single leftover's, so it
 * is never proof on its own that the worker's own session is there (b.jg5
 * SRJ-613); the `send-keys` that follows it is the backstop (see the module
 * comment).
 */
export interface PaneReadPane {
  readonly kind: typeof PANE_READ_PANE
  readonly pane: string
}

/** What every failure outcome carries. */
interface PaneReadFailureFields {
  /** The class `classifyAdError` gave the thrown value (b.jg5 SRJ-104). */
  readonly errorClass: AdErrorClass
  /** The value as `describeAgentDirectorFailure` renders it: redacted, on one line, capped. */
  readonly description: string
}

/** A failure whose thrown value the caller does not need, UNCLASSIFIED aside. */
export interface PaneReadPlainFailure extends PaneReadFailureFields {
  readonly kind: Exclude<
    PaneReadFailureKind,
    typeof PANE_READ_CONFLICT | typeof PANE_READ_UNUSABLE_NAME | typeof PANE_READ_UNCLASSIFIED
  >
}

/**
 * An UNCLASSIFIED answer. `stopping` marks one whose `ErrInvalidFlags`
 * version re-check decided that the server stops (b.jg5 SRJ-204, SRJ-205):
 * only the shared reader `readPersonaOwnPane` sets it, never
 * {@link paneReadFailureOf}. A caller given a marked outcome types nothing
 * and calls nothing more for the persona.
 */
export interface PaneReadUnclassified extends PaneReadFailureFields {
  readonly kind: typeof PANE_READ_UNCLASSIFIED
  readonly stopping?: true
}

/** A CONFLICT, the thrown value kept so the caller can latch through the latch's CONFLICT entry. */
export interface PaneReadConflict extends PaneReadFailureFields {
  readonly kind: typeof PANE_READ_CONFLICT
  readonly error: unknown
}

/** An UNUSABLE NAME, the thrown value kept so the caller can latch through the latch's unusable-name entry. */
export interface PaneReadUnusableName extends PaneReadFailureFields {
  readonly kind: typeof PANE_READ_UNUSABLE_NAME
  readonly error: unknown
}

/** What {@link paneReadFailureOf} answers: exactly one failure outcome. */
export type PaneReadFailure = PaneReadPlainFailure | PaneReadUnclassified | PaneReadConflict | PaneReadUnusableName

/**
 * The persona is latched (b.jg5 SRJ-502): `cause` is the CONFLICT or
 * UNUSABLE NAME answer that latched it, absent when the persona was latched
 * before the read and so was not read.
 */
export interface PaneReadLatched {
  readonly kind: typeof PANE_READ_LATCHED
  readonly cause?: PaneReadConflict | PaneReadUnusableName
}

/** The outcome of one `read-pane` of a persona's own row. */
export type PaneReadOutcome = PaneReadPane | PaneReadFailure | PaneReadLatched

/** The outcome of a read not made because the persona is latched. */
export const PANE_READ_NOT_READ_LATCHED: PaneReadLatched = Object.freeze({ kind: PANE_READ_LATCHED })

// ---------------------------------------------------------------------------
// The mapper
// ---------------------------------------------------------------------------

/**
 * The failure outcome of a value thrown by one `read-pane` of a persona's
 * own row (b.jg5 SRJ-104, SRJ-117); see the module comment. Decided by class
 * and by name through `src/ad-error-class.ts`. Pure; never throws.
 */
export function paneReadFailureOf(value: unknown): PaneReadFailure {
  const { errorClass } = classifyAdError(value)
  const description = describeAgentDirectorFailure(value)
  switch (errorClass) {
    case AD_ERROR_CLASS_GONE:
      return { kind: PANE_READ_GONE, errorClass, description }
    case AD_ERROR_CLASS_UNAVAILABLE:
      return { kind: PANE_READ_UNAVAILABLE, errorClass, description }
    case AD_ERROR_CLASS_CONFLICT:
      return { kind: PANE_READ_CONFLICT, errorClass, description, error: value }
    case AD_ERROR_CLASS_UNUSABLE_NAME:
      return { kind: PANE_READ_UNUSABLE_NAME, errorClass, description, error: value }
    case AD_ERROR_CLASS_CONFIG:
      return { kind: PANE_READ_CONFIG, errorClass, description }
    case AD_ERROR_CLASS_ENVIRONMENT:
      return { kind: PANE_READ_ENVIRONMENT, errorClass, description }
    default:
      // STATE: only `ErrSpawnNotFound` has a meaning here (ABSENT); every
      // other STATE name, LAUNCH FAILURE, DIRECTORY and UNCLASSIFIED map to
      // UNCLASSIFIED.
      return hasAdErrorName(value, ERR_SPAWN_NOT_FOUND_NAME)
        ? { kind: PANE_READ_ABSENT, errorClass, description }
        : { kind: PANE_READ_UNCLASSIFIED, errorClass, description }
  }
}

/**
 * A failed pane read's class for the end of a log line (the description is
 * rendered where the line names the failure): `read-pane class=<class>`.
 */
export function paneReadClassNote(failure: PaneReadFailure): string {
  return `read-pane class=${failure.errorClass}`
}
