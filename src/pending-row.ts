/**
 * pending-row.ts — A `pending` row's launch start (b.jg5 SRJ-406, SRJ-408),
 * the pending-with-no-launch-start predicate (b.jg5 SRJ-513), and the
 * stuck-launch post's texts, posters and episode end (b.jg5 SRJ-1017,
 * SRJ-1016).
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
 * A launch call's window (b.jg5 SRJ-407): the session manager records, for
 * each launch call, when it made the call and when the call returned success
 * or ended in a launch timeout ({@link LaunchCallWindow}).
 * {@link isLaunchStartInWindow} answers whether a row's launch start lies
 * inside such a window, both ends included; a row whose launch start does so
 * after a launch timeout is that launch's own row.
 * {@link describeLaunchStartForLog} is the one renderer of a launch start,
 * for a log line and for the stuck-launch post: an ISO 8601 UTC timestamp
 * ending in `Z`, the same for both launch-start forms of one instant
 * ({@link launchStartInstantOf}).
 *
 * The stuck-launch post (b.jg5 SRJ-1017, SRJ-1016, SRJ-1001), made by the
 * pending-row rule at B (SRJ-410 step 3) to P's destination, naming P's
 * session (`quotedPersonaSessionName`, `src/persona-identity.ts`):
 * {@link stuckLaunchRelaunchingText} for CSCB's own stuck launch, with B in
 * whole minutes, and {@link stuckLaunchHeldText} for any other `pending` row,
 * with its three remedy lines and its human-only line, the attach line left
 * out and {@link STUCK_LAUNCH_NOT_STARTED_BY_CSCB_CLAUSE} added when a
 * `send-keys` on the row answered `ErrSpawnNotInteractive` during its current
 * launch. Neither names a command that ends a session. The fixed pieces are
 * exported. Each text has one poster ({@link postStuckLaunchRelaunching},
 * {@link postStuckLaunchHeld}) over injected dependencies (the server's one
 * episodes instance, a `tmux-unavailable` query and a log sink): while P's
 * `tmux-unavailable` outage is raised it posts nothing and begins no episode;
 * otherwise it begins or keeps P's stuck-launch episode
 * (`PERSONA_EPISODE_KIND_STUCK_LAUNCH`, `src/persona-episodes.ts`) and posts
 * its text at most once in it, under its own mark
 * ({@link STUCK_LAUNCH_MARK_RELAUNCHING}, {@link STUCK_LAUNCH_MARK_HELD}),
 * through the episodes' sink (the persona notifier), never straight to
 * Slack, with one line per call ({@link stuckLaunchPostLine}). The episode
 * and its marks live only in the episodes instance. The episode ends
 * silently ({@link endStuckLaunchEpisode}) at a read of P's own row in
 * `waiting`, `working`, `ask_user` or `check_permission`
 * ({@link isStuckLaunchEpisodeEndState}; the session manager's shared
 * own-row reads), when P latches ({@link endStuckLaunchEpisodeForLatch}, the
 * latch's hold observer), and at P's teardown (the episodes' `forget`); a
 * read of `pending`, `ended`, `missing` or no row does not end it.
 *
 * No module-scope state, no I/O, no agent-director call and nothing run at
 * import; the clock is always passed in. Every function but the posters and
 * the episode's end is pure; those act only through the dependencies they
 * are given. Nothing names an export only the Phase 1 client has; the
 * result field is typed through CSCB's own Phase 1 declarations
 * (`src/ad-phase1-types.ts`, a type-only import).
 *
 * SPDX-License-Identifier: MIT
 */

import type { Phase1StatusResult } from './ad-phase1-types.ts'
import { armNeverEarlyWait, wholeMinutes, type NeverEarlyWaitClock, type NeverEarlyWaitLength } from './ad-settings.ts'
import { AGENT_DIRECTOR_LIVE_STATES, AGENT_DIRECTOR_PENDING_STATE, pendingLaunchStartOf } from './liveness-reading.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import type { MUTED_BY_TEARDOWN, PERSONA_EPISODE_KIND_STUCK_LAUNCH, PersonaEpisodes } from './persona-episodes.ts'
import { personaTmuxSessionName, quotedPersonaSessionName, tmuxExactSessionTarget } from './persona-identity.ts'

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

// ---------------------------------------------------------------------------
// A launch call's window (b.jg5 SRJ-407)
// ---------------------------------------------------------------------------

/**
 * One launch call's window (b.jg5 SRJ-407), in wall-clock epoch milliseconds
 * on the session manager's clock: `startMs`, taken just before the call, and
 * `endMs`, taken when the call returned success or ended in a launch timeout
 * (when CSCB received the `ErrTmuxUnresponsive` answer, or when the client
 * threw `ErrCallTimeout`). A call that ended any other way has no end.
 */
export interface LaunchCallWindow {
  readonly startMs: number
  readonly endMs?: number
}

/**
 * True when the raw launch start `rawLaunchStart` ({@link parseLaunchStart})
 * lies inside `window`, both ends included (b.jg5 SRJ-407): the window's
 * start is at or before it and its end at or after it. False for a launch
 * start that is absent or does not parse, for no window, for a window with
 * no end, and for a bound that is not a finite time. The check fails safe:
 * a clock stepped between the call and agent-director's write makes this
 * launch's row read as another launch's. Pure; never throws.
 */
export function isLaunchStartInWindow(rawLaunchStart: unknown, window: LaunchCallWindow | undefined): boolean {
  try {
    if (window === undefined) return false
    const { startMs, endMs } = window
    if (endMs === undefined || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return false
    const launchStartMs = parseLaunchStart(rawLaunchStart)
    if (launchStartMs === undefined) return false
    return startMs <= launchStartMs && launchStartMs <= endMs
  } catch {
    return false
  }
}

/**
 * The instant of a launch start given in either form CSCB holds one in: a
 * number is taken as that instant (epoch ms, as {@link parseLaunchStart}
 * answers it); anything else is read by {@link parseLaunchStart}. Answers
 * `undefined` for a launch start that is absent, does not parse or is not a
 * finite time, so two forms of one instant (with and without fractional
 * seconds, `Z` or an offset, or the parsed number) give one answer. Pure;
 * never throws.
 */
export function launchStartInstantOf(launchStart: unknown): number | undefined {
  const launchStartMs = typeof launchStart === 'number' ? launchStart : parseLaunchStart(launchStart)
  return launchStartMs !== undefined && Number.isFinite(launchStartMs) ? launchStartMs : undefined
}

/**
 * The one renderer of a launch start, for a log line and for the stuck-launch
 * post's held text (b.jg5 SRJ-1017: `<the launch start>`), only in a form
 * CSCB builds itself: the instant {@link launchStartInstantOf} reads, as an
 * ISO 8601 UTC timestamp ending in `Z`, so both launch-start forms of one
 * instant render alike; `none` for a launch start that is absent, does not
 * parse or is not a finite time. The raw text agent-director wrote never
 * reaches a line or a post. Pure; never throws.
 */
export function describeLaunchStartForLog(launchStart: unknown): string {
  const launchStartMs = launchStartInstantOf(launchStart)
  if (launchStartMs === undefined) return 'none'
  try {
    return new Date(launchStartMs).toISOString()
  } catch {
    return 'none'
  }
}

// ---------------------------------------------------------------------------
// The stuck-launch post's two texts (b.jg5 SRJ-1017, SRJ-1001)
// ---------------------------------------------------------------------------

/** The relaunching text's head (b.jg5 SRJ-1017): CSCB's own stuck launch. */
export const STUCK_LAUNCH_RELAUNCHING_HEAD = ':hourglass_flowing_sand: *Launch stuck*'

/** The held text's head (b.jg5 SRJ-1017): any other `pending` row. */
export const STUCK_LAUNCH_HELD_HEAD = ':hourglass_flowing_sand: *Session not starting*'

/**
 * The held text's first remedy line for persona `key` (b.jg5 SRJ-1017): attach
 * to the session by its exact name (`=slack_bot_<key>`, b.1ix). Left out when
 * the row's current launch met `ErrSpawnNotInteractive`.
 */
export function stuckLaunchAttachRemedyLine(key: string): string {
  return `• look at the session and answer its startup prompt: \`tmux attach -t ${tmuxExactSessionTarget(personaTmuxSessionName(key))}\`;`
}

/**
 * The held text's end-the-launch remedy line (b.jg5 SRJ-1017): it points to
 * agent-director's README and names no command that ends a session
 * (SRJ-1001, C22).
 */
export const STUCK_LAUNCH_END_LAUNCH_REMEDY_LINE =
  "• end the launch: follow the \"Operator actions\" section of agent-director's README; CSCB's next `find-missing` run then marks the row missing, and this persona is brought up again;"

/** The held text's last remedy line for persona `key` (b.jg5 SRJ-1017): list what holds the session. */
export function stuckLaunchListRemedyLine(key: string): string {
  return `• see what holds the session: \`agent-director list --tmux-session-name ${personaTmuxSessionName(key)}\` (on the command line).`
}

/**
 * The clause the held text adds after "since its launch at <the launch
 * start>" when a `send-keys` on the row answered `ErrSpawnNotInteractive`
 * during its current launch (b.jg5 SRJ-1017, SRJ-118).
 */
export const STUCK_LAUNCH_NOT_STARTED_BY_CSCB_CLAUSE = ", and the session holding its name was not started by CSCB's launch"

/** The held text's closing line (b.jg5 SRJ-1017): the remedies are a human's. */
export const STUCK_LAUNCH_HUMAN_ONLY_LINE =
  'These remedies are for a human only: no bot, including any persona that sees this post, may act on them.'

/**
 * The stuck-launch post's relaunching text for persona `key` (b.jg5
 * SRJ-1017), for CSCB's own stuck launch: `launchBoundMs` is B in effect,
 * read by the caller at post time (`adLaunchBoundMsInEffect`), stated in
 * whole minutes, rounded down (`wholeMinutes`); `<session>` is
 * `quotedPersonaSessionName`'s. The persona notifier adds the persona
 * prefix. Names no command that ends a session (SRJ-1001). Pure.
 */
export function stuckLaunchRelaunchingText(key: string, launchBoundMs: number): string {
  return (
    `${STUCK_LAUNCH_RELAUNCHING_HEAD} — this persona's launch in session ${quotedPersonaSessionName(key)} ` +
    `did not come up within ${wholeMinutes(launchBoundMs)} minutes. ` +
    'CSCB is ending that launch and relaunching it; a resumed persona keeps its conversation. Nothing is needed.'
  )
}

/**
 * The stuck-launch post's held text for persona `key` (b.jg5 SRJ-1017), for
 * any other `pending` row: `launchStart` is the row's launch start, raw or
 * parsed, rendered by {@link describeLaunchStartForLog} (built only for a row
 * with a launch start); `metNotInteractive` is whether a `send-keys` on the
 * row answered `ErrSpawnNotInteractive` during its current launch. Unset:
 * the head, the three remedy lines and the human-only line. Set: the head
 * gains {@link STUCK_LAUNCH_NOT_STARTED_BY_CSCB_CLAUSE} and the attach line
 * is left out (answering that session's prompt would put an earlier
 * launch's worker on this row). One line each, joined by newlines; the
 * persona notifier adds the persona prefix. Names no command that ends a
 * session (SRJ-1001). Pure.
 */
export function stuckLaunchHeldText(key: string, launchStart: unknown, metNotInteractive: boolean): string {
  const clause = metNotInteractive ? STUCK_LAUNCH_NOT_STARTED_BY_CSCB_CLAUSE : ''
  const head =
    `${STUCK_LAUNCH_HELD_HEAD} — this persona's session ${quotedPersonaSessionName(key)} ` +
    `has not reported in since its launch at ${describeLaunchStartForLog(launchStart)}${clause}, ` +
    "and may be held at a startup prompt CSCB cannot answer. CSCB keeps checking. A human's remedies:"
  const remedies = metNotInteractive
    ? [STUCK_LAUNCH_END_LAUNCH_REMEDY_LINE, stuckLaunchListRemedyLine(key)]
    : [stuckLaunchAttachRemedyLine(key), STUCK_LAUNCH_END_LAUNCH_REMEDY_LINE, stuckLaunchListRemedyLine(key)]
  return [head, ...remedies, STUCK_LAUNCH_HUMAN_ONLY_LINE].join('\n')
}

// ---------------------------------------------------------------------------
// The stuck-launch poster (b.jg5 SRJ-1017, SRJ-1016)
// ---------------------------------------------------------------------------

/**
 * The stuck-launch episode kind (`PERSONA_EPISODE_KIND_STUCK_LAUNCH`,
 * `src/persona-episodes.ts`). Held here under that constant's own literal
 * type, so the compiler refuses any other value, because this module loads
 * no server-side module at run time (the live-row sequence, which loads it,
 * must not load the episodes module).
 */
const STUCK_LAUNCH_KIND: typeof PERSONA_EPISODE_KIND_STUCK_LAUNCH = 'stuck-launch'

/** `MUTED_BY_TEARDOWN` (`src/persona-episodes.ts`) under its own literal type, for the same reason as {@link STUCK_LAUNCH_KIND}. */
const MUTED_BY_TEARDOWN_TEXT: typeof MUTED_BY_TEARDOWN = 'muted, its persona teardown was submitted'

/** The relaunching text's mark in the stuck-launch episode, and its name in the poster's lines. */
export const STUCK_LAUNCH_MARK_RELAUNCHING = 'relaunching'
/** The held text's mark in the stuck-launch episode, and its name in the poster's lines. */
export const STUCK_LAUNCH_MARK_HELD = 'held'

/** One of the stuck-launch post's two texts, by its mark. */
export type StuckLaunchTextMark = typeof STUCK_LAUNCH_MARK_RELAUNCHING | typeof STUCK_LAUNCH_MARK_HELD

/** A poster's answer: the text was handed to the episodes' sink (or muted by a submitted teardown, counting as posted). */
export const STUCK_LAUNCH_POSTED = 'posted'
/** A poster's answer: the text was already posted in this stuck-launch episode, so nothing was handed on. */
export const STUCK_LAUNCH_ALREADY_POSTED = 'already-posted'
/** A poster's answer: P's `tmux-unavailable` outage is raised, so nothing was posted and no episode begun. */
export const STUCK_LAUNCH_SUPPRESSED = 'suppressed'
/** A poster's answer: the episodes are closed (shutdown), so nothing was posted. */
export const STUCK_LAUNCH_NOT_POSTED_CLOSED = 'closed'

/** What a stuck-launch poster answers. */
export type StuckLaunchPostAnswer =
  | typeof STUCK_LAUNCH_POSTED
  | typeof STUCK_LAUNCH_ALREADY_POSTED
  | typeof STUCK_LAUNCH_SUPPRESSED
  | typeof STUCK_LAUNCH_NOT_POSTED_CLOSED

/** What the posters use of the server's one episodes instance (`createPersonaEpisodes`, `src/persona-episodes.ts`). */
export type StuckLaunchPostEpisodes = Pick<PersonaEpisodes, 'begin' | 'post' | 'teardownWindowState'>

/** The posters' injected dependencies. */
export interface StuckLaunchPosterDeps {
  /** The server's one episodes instance (production: `main()`'s notice episodes over the persona notifier). */
  readonly episodes: StuckLaunchPostEpisodes
  /**
   * Whether persona `key`'s `tmux-unavailable` outage is raised now
   * (production: `getOutageFlags(key)`, `src/outage-state.ts`). A throw is
   * taken as raised.
   */
  readonly tmuxUnavailableRaised: (key: string) => boolean
  /** Receives each `[slack] pending-row:` line (the server log). A throwing log is swallowed. */
  readonly log: (line: string) => void
}

/** The head of every stuck-launch line for persona `key`. */
function stuckLaunchLineHead(key: string): string {
  return `[slack] pending-row: persona=${key} stuck-launch`
}

/** The text's name in a poster line: its mark, and for the held text which form. */
function stuckLaunchTextName(mark: StuckLaunchTextMark, metNotInteractive: boolean): string {
  if (mark === STUCK_LAUNCH_MARK_RELAUNCHING) return `${mark} text`
  return metNotInteractive ? `${mark} text (no attach line: the session holding its name was not started by CSCB's launch)` : `${mark} text`
}

/**
 * The line of a stuck-launch poster's answer for persona `key` (b.jg5
 * SRJ-1017, SRJ-1003), one per call:
 *
 *   [slack] pending-row: persona=<key> stuck-launch <text> posted
 *   [slack] pending-row: persona=<key> stuck-launch <text> not posted — muted, its persona teardown was submitted; it counts as posted in its episode
 *   [slack] pending-row: persona=<key> stuck-launch <text> not posted — already posted in this stuck-launch episode
 *   [slack] pending-row: persona=<key> stuck-launch <text> not posted — its tmux-unavailable outage is raised, whose onset is its notice; no episode begun
 *   [slack] pending-row: persona=<key> stuck-launch <text> not posted — the server is shutting down
 *
 * where `<text>` is `relaunching text`, `held text`, or `held text (no attach
 * line: the session holding its name was not started by CSCB's launch)`.
 * `muted` is true for a post its submitted persona teardown muted. Pure.
 */
export function stuckLaunchPostLine(
  key: string,
  mark: StuckLaunchTextMark,
  answer: StuckLaunchPostAnswer,
  options: { readonly metNotInteractive?: boolean; readonly muted?: boolean } = {},
): string {
  const head = `${stuckLaunchLineHead(key)} ${stuckLaunchTextName(mark, options.metNotInteractive === true)}`
  switch (answer) {
    case STUCK_LAUNCH_POSTED:
      return options.muted === true ? `${head} not posted — ${MUTED_BY_TEARDOWN_TEXT}; it counts as posted in its episode` : `${head} posted`
    case STUCK_LAUNCH_ALREADY_POSTED:
      return `${head} not posted — already posted in this stuck-launch episode`
    case STUCK_LAUNCH_SUPPRESSED:
      return `${head} not posted — its tmux-unavailable outage is raised, whose onset is its notice; no episode begun`
    case STUCK_LAUNCH_NOT_POSTED_CLOSED:
      return `${head} not posted — the server is shutting down`
  }
}

/** The line for a `tmux-unavailable` query that threw for persona `key`: taken as raised. */
export function stuckLaunchOutageQueryFailedLine(key: string, described: string): string {
  return `${stuckLaunchLineHead(key)} tmux-unavailable query failed: ${described} — taken as raised`
}

/** The line for a poster call on persona `key` that threw inside (an episodes call): nothing more was done. */
export function stuckLaunchPostFailedLine(key: string, described: string): string {
  return `${stuckLaunchLineHead(key)} post failed: ${described}`
}

/** The line for an end of persona `key`'s stuck-launch episode that threw inside (an episodes call): nothing more was done. */
export function stuckLaunchEpisodeEndFailedLine(key: string, described: string): string {
  return `${stuckLaunchLineHead(key)} episode end failed: ${described}`
}

/** Hand `line` to `log`; a throwing log is swallowed. */
function safePendingRowLog(log: (line: string) => void, line: string): void {
  try {
    log(line)
  } catch {
    /* a failing logger must not change what a poster does */
  }
}

/** Whether persona `key`'s `tmux-unavailable` outage is raised by the injected query; a throw is taken as raised, with one line. */
function tmuxUnavailableRaisedFor(deps: StuckLaunchPosterDeps, key: string): boolean {
  try {
    return deps.tmuxUnavailableRaised(key) === true
  } catch (err) {
    safePendingRowLog(deps.log, stuckLaunchOutageQueryFailedLine(key, describeThrownValue(err)))
    return true
  }
}

/**
 * Post `text` under `mark` in persona `key`'s stuck-launch episode (b.jg5
 * SRJ-1017, SRJ-1016): nothing, and no episode begun, while `tmux-unavailable`
 * is raised; otherwise begin or keep the episode and post at most once per
 * mark in it. One line per call ({@link stuckLaunchPostLine}). Never throws:
 * an episodes call that throws logs {@link stuckLaunchPostFailedLine} and
 * answers suppressed.
 */
function postStuckLaunchText(
  deps: StuckLaunchPosterDeps,
  key: string,
  mark: StuckLaunchTextMark,
  buildText: () => string,
  metNotInteractive: boolean,
): StuckLaunchPostAnswer {
  const line = (answer: StuckLaunchPostAnswer, muted = false): StuckLaunchPostAnswer => {
    safePendingRowLog(deps.log, stuckLaunchPostLine(key, mark, answer, { metNotInteractive, muted }))
    return answer
  }
  try {
    if (tmuxUnavailableRaisedFor(deps, key)) return line(STUCK_LAUNCH_SUPPRESSED)
    const { episodes } = deps
    if (episodes.begin(key, STUCK_LAUNCH_KIND) === 'closed') return line(STUCK_LAUNCH_NOT_POSTED_CLOSED)
    // b.jg5 SRJ-1003: read before the post, which a submitted teardown mutes
    // (the episode still counts it as posted).
    const muted = episodes.teardownWindowState(key) === 'submitted'
    if (!episodes.post(key, STUCK_LAUNCH_KIND, buildText(), mark)) return line(STUCK_LAUNCH_ALREADY_POSTED)
    return line(STUCK_LAUNCH_POSTED, muted)
  } catch (err) {
    safePendingRowLog(deps.log, stuckLaunchPostFailedLine(key, describeThrownValue(err)))
    return STUCK_LAUNCH_SUPPRESSED
  }
}

/**
 * Post the relaunching text ({@link stuckLaunchRelaunchingText}, B from
 * `launchBoundMs`) for persona `key`'s own stuck launch, at most once per
 * stuck-launch episode, under {@link STUCK_LAUNCH_MARK_RELAUNCHING} (b.jg5
 * SRJ-1017): see {@link postStuckLaunchText}. The `ad-config-malformed` gate
 * is the caller's. Goes through `deps.episodes` only, never straight to
 * Slack. Never throws.
 */
export function postStuckLaunchRelaunching(deps: StuckLaunchPosterDeps, key: string, launchBoundMs: number): StuckLaunchPostAnswer {
  return postStuckLaunchText(deps, key, STUCK_LAUNCH_MARK_RELAUNCHING, () => stuckLaunchRelaunchingText(key, launchBoundMs), false)
}

/**
 * Post the held text ({@link stuckLaunchHeldText}) for persona `key`'s
 * `pending` row with the launch start `launchStart`, in the form
 * `metNotInteractive` picks, at most once per stuck-launch episode, under
 * {@link STUCK_LAUNCH_MARK_HELD} (b.jg5 SRJ-1017): see
 * {@link postStuckLaunchText}. Goes through `deps.episodes` only, never
 * straight to Slack. Never throws.
 */
export function postStuckLaunchHeld(
  deps: StuckLaunchPosterDeps,
  key: string,
  launchStart: unknown,
  metNotInteractive: boolean,
): StuckLaunchPostAnswer {
  return postStuckLaunchText(deps, key, STUCK_LAUNCH_MARK_HELD, () => stuckLaunchHeldText(key, launchStart, metNotInteractive), metNotInteractive)
}

// ---------------------------------------------------------------------------
// The stuck-launch episode's end (b.jg5 SRJ-1016)
// ---------------------------------------------------------------------------

/**
 * True for a row state whose read ends the stuck-launch episode (b.jg5
 * SRJ-1016): `waiting`, `working`, `ask_user` or `check_permission`, the
 * live states out of `pending`. False for `pending`, `ended`, `missing`, any
 * other value and no row. Pure; never throws.
 */
export function isStuckLaunchEpisodeEndState(state: unknown): boolean {
  return typeof state === 'string' && state !== AGENT_DIRECTOR_PENDING_STATE && AGENT_DIRECTOR_LIVE_STATES.has(state)
}

/** What ended a stuck-launch episode, in its line: a read of the row in `state`, live out of `pending`. */
export function stuckLaunchEndRowLiveReason(state: string): string {
  return `its own row read ${state}, live out of pending`
}

/** What ended a stuck-launch episode, in its line: the persona latched. */
export const STUCK_LAUNCH_END_LATCHED = 'the persona latched'

/** The line for persona `key`'s open stuck-launch episode ended for `reason`. */
export function stuckLaunchEpisodeEndedLine(key: string, reason: string): string {
  return `${stuckLaunchLineHead(key)} episode ended — ${reason}`
}

/**
 * End persona `key`'s open stuck-launch episode silently (b.jg5 SRJ-1016):
 * nothing is posted; one line ({@link stuckLaunchEpisodeEndedLine}) when one
 * was open. A later post begins a new episode, whose texts post again.
 * Answers whether one was open. Never throws.
 */
export function endStuckLaunchEpisode(
  episodes: Pick<PersonaEpisodes, 'end'>,
  key: string,
  reason: string,
  log: (line: string) => void,
): boolean {
  try {
    if (!episodes.end(key, STUCK_LAUNCH_KIND)) return false
    safePendingRowLog(log, stuckLaunchEpisodeEndedLine(key, reason))
    return true
  } catch (err) {
    safePendingRowLog(log, stuckLaunchEpisodeEndFailedLine(key, describeThrownValue(err)))
    return false
  }
}

/**
 * The latch's hold for the stuck-launch episode (b.jg5 SRJ-1016): end
 * persona `key`'s episode silently, with {@link STUCK_LAUNCH_END_LATCHED}.
 * `main()` binds it into the latch's hold observer
 * (`ConflictLatchHolds.endStuckLaunch`, `src/conflict-latch.ts`) over its
 * notice episodes; the recovery harness composes the same call. Never throws.
 */
export function endStuckLaunchEpisodeForLatch(episodes: Pick<PersonaEpisodes, 'end'>, key: string, log: (line: string) => void): void {
  endStuckLaunchEpisode(episodes, key, STUCK_LAUNCH_END_LATCHED, log)
}
