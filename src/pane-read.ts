/**
 * Outcome-only probes of a persona's own row. The caller uses AD's success
 * or error class; pane content never leaves the probe and never grants keys.
 * A successful probe may refer to a leftover session, so readiness still
 * comes from a fresh AD row and AD's send-keys refusals.
 */

import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_GONE,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  classifyAdError,
  describeAdFailureForLog,
  isAdErrorInstance,
  type AdErrorClass,
} from './ad-error-class.ts'
import { ErrSpawnNotFound } from './agent-director-errors.ts'

/**
 * Trailing pane lines a one-line probe asks for (`n_lines`
 * at the contract reconnect verdict, `promptRowReconnectVerdict` in
 * `src/server.ts`, and ladder action, `launchOnPromptRow`,
 *). These read whether agent-director answers a pane at all, not what
 * it shows; the pane may be a single leftover's, so its
 * answer is no proof that the worker's own session is there.
 * table gives the same count to the latch re-check probe and the
 * CLI precheck; neither reads a pane through this module today.
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

/** Every failure kind {@link paneReadFailureOf} answers, in the contract column order. */
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
 * The read succeeded. It may be a single leftover's, so it
 * is never proof on its own that the worker's own session is there; the `send-keys` that follows it is the backstop (see the module
 * comment).
 */
export interface PaneReadPane {
  readonly kind: typeof PANE_READ_PANE
}

/** What every failure outcome carries. */
interface PaneReadFailureFields {
  /** The class `classifyAdError` gave the thrown value. */
  readonly errorClass: AdErrorClass
  /** The value as `describeAdFailureForLog` renders it: the reported name, redacted, on one line, capped. */
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
 * version re-check decided that the server stops:
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
 * The persona is latched: `cause` is the CONFLICT or
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
 * own row; see the module comment. Decided by class
 * through `src/ad-error-class.ts`. Pure; never throws.
 */
export function paneReadFailureOf(value: unknown): PaneReadFailure {
  const { errorClass } = classifyAdError(value)
  const description = describeAdFailureForLog(value)
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
      return isAdErrorInstance(value, ErrSpawnNotFound)
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
