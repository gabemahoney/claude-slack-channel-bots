/**
 * pending-row.ts — A `pending` row's launch start (b.jg5 SRJ-406, SRJ-408)
 * and the pending-with-no-launch-start predicate (b.jg5 SRJ-513).
 *
 * agent-director shows a row's launch start (`launch_started_at`) on `pending`
 * rows only, from `status`, `get` and `list` alike: an RFC 3339 UTC timestamp
 * with millisecond precision whose fractional seconds are shown only when
 * they are not zero (ADSRD SR-22.2). {@link parseLaunchStart} reads one
 * leniently: an RFC 3339 date-time with `Z` or a numeric offset, with or
 * without a fractional part of any length, giving its instant in epoch
 * milliseconds. Absent, `null`, a value that is not a string, an empty
 * string, and anything that does not parse to a finite instant all mean "no
 * launch start" (SRJ-408).
 *
 * {@link isPendingWithNoLaunchStart} is true for a row, or a `status` result
 * as the client returns it, that reads `pending` and has no launch start by
 * that reader. For a `status` result the raw value is the one the raw
 * reader carries (`pendingLaunchStartOf`, `src/liveness-reading.ts`), and a
 * `get` or `list` row is read the same way. The row-read rule
 * (`decideOwnRowRead`, `src/row-read-rules.ts`) latches a configured
 * persona's own such row with the case "launch start not recorded"
 * (SRJ-513); a row under a key no configured persona uses latches nothing.
 *
 * A `pending` row's ageing (b.jg5 SRJ-406, SRJ-408): every wait on a
 * `pending` row is measured from its launch start by this reader, never from
 * `started_at` (a resumed row's `started_at` is its original spawn time, and
 * agent-director counts its grace period from the launch start), and a row
 * with no launch start is never aged. {@link isPendingRowAged} answers
 * whether a wait has passed since a row's launch start at a given now, for a
 * lap or a retry tick; {@link armPendingRowWait} arms such a wait never-early
 * (`armNeverEarlyWait`, `src/ad-settings.ts`, with the derived-wait accessor
 * itself, b.jg5 SRJ-210) and, for a row with no launch start, arms nothing
 * and answers {@link PENDING_ROW_WAIT_NOT_ARMED}, so no caller hands the
 * never-early helper a start that is not a finite time. The dialog approver's
 * B and pace (SRJ-403, SRJ-404) and the live-row sequence's step-2 wait
 * (SRJ-705, which the old-life wait runs too) use them, and SRJ-410's
 * pending-row rule uses them.
 *
 * Whether a `pending` row is covered (b.jg5 SRJ-409, SRJ-411, SRJ-408):
 * {@link decidePendingRowCover} answers, from what its caller read and
 * compared, whether the row is the persona's current life. A configured
 * persona's own row with no launch start answers
 * {@link PENDING_ROW_NO_LAUNCH_START} whatever else is true (it latches,
 * SRJ-513, and is never exempted); a row whose directory could not be
 * resolved answers {@link PENDING_ROW_UNDECIDED} (at a site that read the
 * row with `status` only, before any mismatch is checked); a retired key's old life
 * before its new life has begun, or a row whose `cwd` or `config_dir` label
 * does not match the persona, answers {@link PENDING_ROW_NOT_COVERED} with
 * its reason; any other row answers {@link PENDING_ROW_COVERED}. The session
 * manager's pending-row step acts on the answer: a covered or undecided row
 * arms the persona's retry timer in pending-only mode and is never killed,
 * reused or launched over; a row that is not covered goes through the
 * live-row sequence.
 *
 * Pure: no module-scope state, no I/O, no agent-director call, no log line,
 * nothing run at import; the clock is always passed in. Nothing names an
 * export only the Phase 1 client has; the result field is typed through
 * CSCB's own Phase 1 declarations (`src/ad-phase1-types.ts`, a type-only
 * import).
 *
 * SPDX-License-Identifier: MIT
 */

import type { Phase1StatusResult } from './ad-phase1-types.ts'
import { armNeverEarlyWait, type NeverEarlyWaitClock, type NeverEarlyWaitLength } from './ad-settings.ts'
import { AGENT_DIRECTOR_PENDING_STATE, pendingLaunchStartOf } from './liveness-reading.ts'

// ---------------------------------------------------------------------------
// The launch start (b.jg5 SRJ-406, SRJ-408)
// ---------------------------------------------------------------------------

/**
 * An RFC 3339 date-time: `YYYY-MM-DD`, `T` (either case), `hh:mm:ss`, an
 * optional fraction of any length, then `Z` (either case) or a numeric
 * offset `±hh:mm`.
 */
const RFC3339_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/

/** Whether `year` is a leap year in the proleptic Gregorian calendar. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** The number of days in `month` (1 to 12) of `year`. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/**
 * The instant of a raw launch start, in epoch milliseconds, or `undefined`
 * for "no launch start" (b.jg5 SRJ-406, SRJ-408). Accepts an RFC 3339
 * date-time with `Z` or a numeric offset and with or without a fractional
 * part of any length (milliseconds are its first three digits; further
 * digits are dropped), whose fields are in range (a leap second, `:60`, is
 * accepted). Answers `undefined` for a value that is absent, `null`, not a
 * string, empty, or anything else, and for one that does not give a finite
 * instant. Pure; never throws.
 */
export function parseLaunchStart(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const match = RFC3339_DATE_TIME_RE.exec(raw)
  if (match === null) return undefined
  const [, y, mo, d, h, mi, s, fraction, zulu, sign, offH, offM] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const second = Number(s)
  if (month < 1 || month > 12) return undefined
  if (day < 1 || day > daysInMonth(year, month)) return undefined
  if (hour > 23 || minute > 59 || second > 60) return undefined
  let offsetMinutes = 0
  if (zulu === undefined) {
    const offsetHours = Number(offH)
    const offsetMins = Number(offM)
    if (offsetHours > 23 || offsetMins > 59) return undefined
    offsetMinutes = (sign === '-' ? -1 : 1) * (offsetHours * 60 + offsetMins)
  }
  const millis = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0'))
  // `Date.UTC` maps years 0 to 99 to 1900 to 1999, so the year is set apart.
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, millis)
  const instant = date.getTime() - offsetMinutes * 60_000
  return Number.isFinite(instant) ? instant : undefined
}

// ---------------------------------------------------------------------------
// A `pending` row with no launch start (b.jg5 SRJ-408, SRJ-513)
// ---------------------------------------------------------------------------

/**
 * What the predicate reads of a row: its state and its raw launch start.
 * A `status` result, a `get` result and a `list` row all carry both.
 */
export type PendingRowFields = Pick<Phase1StatusResult, 'state' | 'launch_started_at'>

/**
 * True when `row` (a `get` or `list` row, or a `status` result as the client
 * returns it) reads `pending` and has no launch start: its raw launch start
 * (the raw reader `pendingLaunchStartOf`) is absent or does not parse
 * ({@link parseLaunchStart}). False for a `pending` row with a valid launch
 * start, for a row in any other state, and for no row. Pure; never throws.
 */
export function isPendingWithNoLaunchStart(row: PendingRowFields | null | undefined): boolean {
  try {
    if (row === null || row === undefined || row.state !== AGENT_DIRECTOR_PENDING_STATE) return false
    return parseLaunchStart(pendingLaunchStartOf(row)) === undefined
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// A `pending` row's ageing (b.jg5 SRJ-406, SRJ-408)
// ---------------------------------------------------------------------------

/**
 * True when `waitMs` has passed at `nowMs` since the launch start
 * `rawLaunchStart` names ({@link parseLaunchStart}), by a plain
 * `elapsed >= wait` comparison (b.jg5 SRJ-406). `waitMs` is a fixed number
 * or the derived-wait accessor itself (for example `adGraceMsInEffect`),
 * read once at this call. False for a launch start that is absent or does
 * not parse (a row with no launch start is never aged, SRJ-408), for a wait
 * of `AD_WAIT_NEVER_ENDS`, and for an accessor that throws or answers NaN.
 * Pure; never throws.
 */
export function isPendingRowAged(rawLaunchStart: unknown, waitMs: NeverEarlyWaitLength, nowMs: number): boolean {
  const launchStartMs = parseLaunchStart(rawLaunchStart)
  if (launchStartMs === undefined) return false
  let currentWaitMs: number
  try {
    currentWaitMs = typeof waitMs === 'function' ? waitMs() : waitMs
  } catch {
    return false
  }
  return nowMs - launchStartMs >= currentWaitMs
}

/** {@link armPendingRowWait}'s answer for a row with no launch start: nothing was armed. */
export const PENDING_ROW_WAIT_NOT_ARMED = 'not-armed'

/** A wait {@link armPendingRowWait} armed: the launch start it runs from (epoch ms) and its cancel. */
export interface PendingRowWaitArmed {
  /** The launch start the wait is measured from, as {@link parseLaunchStart} read it: always a finite time. */
  readonly launchStartMs: number
  /** Clears the pending timer and stops the wait; a second call, or one after the callback ran, does nothing. */
  readonly cancel: () => void
}

/** What {@link armPendingRowWait} answers. */
export type PendingRowWaitArm = PendingRowWaitArmed | typeof PENDING_ROW_WAIT_NOT_ARMED

/**
 * Arm a wait of `waitMs` on a `pending` row, measured from the launch start
 * `rawLaunchStart` names ({@link parseLaunchStart}), never from `started_at`
 * (b.jg5 SRJ-406): `armNeverEarlyWait` on `clock` with `waitMs` passed
 * through, so the accessor itself (for example `adGraceMsInEffect` or
 * `adLaunchBoundMsInEffect`) is read at every fire and a value raised while
 * armed is honoured (SRJ-210). `callback` runs once, from a timer, when the
 * wait has passed. Answers the launch start and the cancel.
 *
 * For a launch start that is absent or does not parse, arms nothing, never
 * runs `callback`, and answers {@link PENDING_ROW_WAIT_NOT_ARMED} (SRJ-408:
 * such a row is never aged), so no `RangeError` for the start ever escapes.
 * A fixed `waitMs` that is NaN, or an accessor that answers NaN or throws
 * while arming, throws out of this call as from `armNeverEarlyWait`, before
 * anything is armed.
 */
export function armPendingRowWait(
  clock: NeverEarlyWaitClock,
  rawLaunchStart: unknown,
  waitMs: NeverEarlyWaitLength,
  callback: () => void,
): PendingRowWaitArm {
  const launchStartMs = parseLaunchStart(rawLaunchStart)
  if (launchStartMs === undefined) return PENDING_ROW_WAIT_NOT_ARMED
  const cancel = armNeverEarlyWait(clock, launchStartMs, waitMs, callback)
  return { launchStartMs, cancel }
}

// ---------------------------------------------------------------------------
// Whether a `pending` row is covered (b.jg5 SRJ-409, SRJ-411, SRJ-408)
// ---------------------------------------------------------------------------

/** {@link decidePendingRowCover}: a configured persona's own `pending` row with no launch start. It latches (SRJ-513); never covered, never exempted. */
export const PENDING_ROW_NO_LAUNCH_START = 'no-launch-start'
/** {@link decidePendingRowCover}: the row is the persona's current life, a launch in progress (SRJ-409). */
export const PENDING_ROW_COVERED = 'covered'
/** {@link decidePendingRowCover}: the row is not the persona's current life (SRJ-411); its reason says why. */
export const PENDING_ROW_NOT_COVERED = 'not-covered'
/** {@link decidePendingRowCover}: a directory the decision needs could not be resolved, so there is no verdict yet (b.av2 SR-6.4, b.g57). */
export const PENDING_ROW_UNDECIDED = 'undecided'

/** Not covered: a retired key's old life, read before its new life has begun (SRJ-411, SRJ-805). */
export const PENDING_ROW_REASON_RETIRED_OLD_LIFE = 'retired-key-old-life'
/** Not covered: the row's `cwd` is not the persona's working directory by real path (SRJ-411, SRJ-1503). */
export const PENDING_ROW_REASON_CWD_MISMATCH = 'cwd-mismatch'
/** Not covered: the row's `config_dir` label is missing or differs from the persona's (SRJ-411, SRJ-1504). */
export const PENDING_ROW_REASON_CONFIG_DIR_MISMATCH = 'config-dir-mismatch'
/**
 * Undecided: the `cwd` condition cannot be evaluated now (b.av2 SR-6.4): the
 * working directory has no real path, and the row's `cwd` has none either or
 * equals it lexically; at a status-only site, the working directory has no
 * real path, whatever the row's `cwd` (SRJ-411).
 */
export const PENDING_ROW_REASON_CWD_UNRESOLVED = 'cwd-unresolved'
/**
 * Undecided: the persona's `claude_config_dir` has no real path now (b.g57);
 * at a status-only site, whatever the row's `cwd` (SRJ-409).
 */
export const PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED = 'config-dir-unresolved'

/** Why a `pending` row is not covered. */
export type PendingRowNotCoveredReason =
  | typeof PENDING_ROW_REASON_RETIRED_OLD_LIFE
  | typeof PENDING_ROW_REASON_CWD_MISMATCH
  | typeof PENDING_ROW_REASON_CONFIG_DIR_MISMATCH

/** Why a `pending` row's cover is undecided. */
export type PendingRowUndecidedReason = typeof PENDING_ROW_REASON_CWD_UNRESOLVED | typeof PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED

/** What {@link decidePendingRowCover} answers. */
export type PendingRowCover =
  | { readonly answer: typeof PENDING_ROW_NO_LAUNCH_START }
  | { readonly answer: typeof PENDING_ROW_COVERED }
  | { readonly answer: typeof PENDING_ROW_NOT_COVERED; readonly reason: PendingRowNotCoveredReason }
  | { readonly answer: typeof PENDING_ROW_UNDECIDED; readonly reason: PendingRowUndecidedReason }

/**
 * How the row compares with the persona, as the session manager's one row
 * comparison answers it (`compareRowToPersona`, `src/session-manager.ts`),
 * passed in so this module stays pure.
 */
export interface PendingRowComparison {
  /** The row's `cwd` and the persona's working directory have the same real path. */
  readonly cwdMatches: boolean
  /** The `cwd` condition cannot be evaluated now (b.av2 SR-6.4). */
  readonly cwdCheckDeferred: boolean
  /** The persona's `claude_config_dir` resolved to a real path (b.g57). */
  readonly configDirResolved: boolean
  /** The row carries the persona's `config_dir` label; no verdict while the directory is unresolved. */
  readonly configDirMatches: boolean | undefined
}

/** What {@link decidePendingRowCover} decides on. */
export interface PendingRowCoverInput {
  /** The row as read: its state (`pending`) and its raw launch start. */
  readonly row: PendingRowFields
  /** Whether the row is a configured persona's own (`cscb_<key>` of a persona of the applied configuration). */
  readonly ownConfigured: boolean
  /**
   * The retired-key store's reading of the key (SRJ-805, SRJ-806): recorded,
   * and whether its "new life has begun" mark is set, a mark held only in
   * memory after a failed write counted as set.
   */
  readonly retired: { readonly recorded: boolean; readonly marked: boolean }
  /** The row's comparison with the persona. */
  readonly comparison: PendingRowComparison
  /**
   * The row was read at a site that reads it with `status` only and then one
   * `get` for this decision (the restart path's deferral and its re-probe, a
   * pending-only retry; SRJ-409, SRJ-411). There, a directory that cannot be
   * resolved leaves the row undecided before any mismatch is checked. Absent
   * or false (the collision ladder): the mismatch of a `cwd` that resolves
   * elsewhere is checked first.
   */
  readonly statusOnlySite?: boolean
}

/**
 * Whether a `pending` row is the persona's current life (b.jg5 SRJ-409,
 * SRJ-411, SRJ-408, SRJ-513), decided in this order:
 *   1. a configured persona's own row with no launch start
 *      ({@link isPendingWithNoLaunchStart}): {@link PENDING_ROW_NO_LAUNCH_START},
 *      whatever else is true, so it is never exempted from its latch;
 *   2. a `cwd` that resolves elsewhere: not covered,
 *      {@link PENDING_ROW_REASON_CWD_MISMATCH};
 *   3. a `cwd` that cannot be compared now: undecided,
 *      {@link PENDING_ROW_REASON_CWD_UNRESOLVED};
 *   4. a `claude_config_dir` that cannot be resolved: undecided,
 *      {@link PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED};
 *   5. a key recorded as retired with no mark: not covered,
 *      {@link PENDING_ROW_REASON_RETIRED_OLD_LIFE};
 *   6. a `config_dir` label missing or different: not covered,
 *      {@link PENDING_ROW_REASON_CONFIG_DIR_MISMATCH};
 *   7. otherwise {@link PENDING_ROW_COVERED}.
 * An unresolved directory is decided before the retired-key and label checks,
 * as the collision ladder decides it before them. At a status-only site
 * (`statusOnlySite` true, SRJ-409), steps 3 and 4 come before step 2: a
 * working directory or `claude_config_dir` that cannot be resolved leaves
 * the row undecided before any mismatch is checked, so the order there is
 * 1, 3, 4, 2, 5, 6, 7. Pure: no I/O, clock or module state; calls nothing
 * outside this module. Never throws.
 */
export function decidePendingRowCover(input: PendingRowCoverInput): PendingRowCover {
  const { row, ownConfigured, retired, comparison } = input
  if (ownConfigured && isPendingWithNoLaunchStart(row)) return { answer: PENDING_ROW_NO_LAUNCH_START }
  const cwdUnresolved = !comparison.cwdMatches && comparison.cwdCheckDeferred
  if (input.statusOnlySite === true) {
    if (cwdUnresolved) return { answer: PENDING_ROW_UNDECIDED, reason: PENDING_ROW_REASON_CWD_UNRESOLVED }
    if (!comparison.configDirResolved) return { answer: PENDING_ROW_UNDECIDED, reason: PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED }
  }
  if (!comparison.cwdMatches && !comparison.cwdCheckDeferred) {
    return { answer: PENDING_ROW_NOT_COVERED, reason: PENDING_ROW_REASON_CWD_MISMATCH }
  }
  if (cwdUnresolved) return { answer: PENDING_ROW_UNDECIDED, reason: PENDING_ROW_REASON_CWD_UNRESOLVED }
  if (!comparison.configDirResolved) return { answer: PENDING_ROW_UNDECIDED, reason: PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED }
  if (retired.recorded && !retired.marked) return { answer: PENDING_ROW_NOT_COVERED, reason: PENDING_ROW_REASON_RETIRED_OLD_LIFE }
  if (comparison.configDirMatches !== true) {
    return { answer: PENDING_ROW_NOT_COVERED, reason: PENDING_ROW_REASON_CONFIG_DIR_MISMATCH }
  }
  return { answer: PENDING_ROW_COVERED }
}
