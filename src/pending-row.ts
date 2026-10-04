/**
 * pending-row.ts — A `pending` row's launch start (b.jg5 SRJ-406, SRJ-408),
 * the pending-with-no-launch-start predicate (b.jg5 SRJ-513), the
 * stuck-launch post's texts, posters and episode end (b.jg5 SRJ-1017,
 * SRJ-1016), and the pending-row rule (b.jg5 SRJ-410): its pure decisions
 * and its driver.
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
 * read of `pending`, `ended`, `missing` or no row does not end it. The
 * stuck-launch post is P's only post about a launch that does not report
 * in (b.jg5 SRJ-405, SRJ-1010): the dialog approver posts nothing at B, and
 * a `pending` re-probe counts toward no slow-recovery notice.
 *
 * The pending-row rule (b.jg5 SRJ-410). While P's covered row reads
 * `pending`, P is not latched and no launch call, live-row sequence or
 * old-life wait step for P is in flight, the rule acts on the row's age from
 * its launch start, at each retry of P's retry timer and once when P's
 * dialog approver stops with the row still `pending`: nothing before G
 * ({@link pendingRowAgeOf}); from G, one approver lap when no approver runs
 * and the launch has not met `ErrSpawnNotInteractive`
 * ({@link isPendingRowLapEligible}, {@link decidePendingRowLapPane},
 * {@link decidePendingRowLapEnter}), then one bypassing `find-missing` run
 * and one `get` ({@link readPendingRowRun}: before B a run that did not judge
 * the row leads to nothing that round); still `pending` at B, judged or not,
 * step 3 ({@link decidePendingRowStepThree}): nothing while `tmux-unavailable`
 * is raised, nothing for CSCB's own stuck launch while `ad-config-malformed`
 * is raised, CSCB's own stuck launch through the own-launch slot, any other
 * row the held text, never a kill. The driver
 * ({@link createPendingRowRule}) is a factory over injected dependencies
 * (the session manager builds the production ones), runs one round per
 * call, and never kills, launches or reuses the row itself.
 *
 * CSCB's own stuck launch (b.jg5 SRJ-412): the own-launch slot is filled by
 * {@link createStuckLaunchAbort}, a factory over injected dependencies that
 * holds the per-episode abort state (one abort per stuck-launch episode,
 * disposed when the episode closes) and makes the relaunching post, the stop
 * of P's dialog approver, one checked kill (the session manager's, with the
 * bounded retry and the kill-failure alert, context 'stuck-launch abort')
 * and the live-row sequence's start at its second step, by the kill's typed
 * answer ({@link StuckLaunchAbortKillAnswer}). The lap's pane is no
 * proof that this launch's session shows a dialog (b.jg5 SRJ-613): it leads
 * at most to Enter through `send-keys`, which is the backstop, answering
 * `ErrSpawnNotInteractive` with nothing typed on a `pending` row whose
 * session is not this launch's; no further lap is then made on that launch.
 *
 * No module-scope state, no I/O, no agent-director call and nothing run at
 * import; the clock is always passed in. Every function but the posters, the
 * episode's end, the rule's driver and the abort is pure; those act only
 * through the dependencies they are given (the abort's per-episode state
 * lives in its instance). Errors are classified by class and name
 * through `src/ad-error-class.ts`. Nothing names an export only the Phase 1
 * client has; the result field is typed through CSCB's own Phase 1
 * declarations (`src/ad-phase1-types.ts`, a type-only import).
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
import type { Phase1StatusResult } from './ad-phase1-types.ts'
import {
  adGraceMsInEffect,
  adLaunchBoundMsInEffect,
  armNeverEarlyWait,
  wholeMinutes,
  type NeverEarlyWaitClock,
  type NeverEarlyWaitLength,
} from './ad-settings.ts'
import { ERR_SPAWN_NOT_FOUND_NAME, ERR_SPAWN_NOT_INTERACTIVE_NAME } from './agent-director-errors.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_NO_ROW,
  pendingLaunchStartOf,
  type DeadRowRead,
} from './liveness-reading.ts'
import {
  PANE_READ_ABSENT,
  PANE_READ_CONFIG,
  PANE_READ_CONFLICT,
  PANE_READ_ENVIRONMENT,
  PANE_READ_GONE,
  PANE_READ_LATCHED,
  PANE_READ_PANE,
  PANE_READ_UNAVAILABLE,
  PANE_READ_UNCLASSIFIED,
  PANE_READ_UNUSABLE_NAME,
  type PaneReadOutcome,
} from './pane-read.ts'
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
/**
 * A poster's answer: an episodes call threw, so nothing was posted (its one
 * line, {@link stuckLaunchPostFailedLine}). Kept apart from
 * {@link STUCK_LAUNCH_SUPPRESSED}, so a caller never takes a failed post for
 * the `tmux-unavailable` gate, nor the gate for a failed post (the abort of
 * CSCB's own stuck launch follows only a relaunching text posted, b.jg5
 * SRJ-412).
 */
export const STUCK_LAUNCH_POST_FAILED = 'failed'

/** What a stuck-launch poster answers. */
export type StuckLaunchPostAnswer =
  | typeof STUCK_LAUNCH_POSTED
  | typeof STUCK_LAUNCH_ALREADY_POSTED
  | typeof STUCK_LAUNCH_SUPPRESSED
  | typeof STUCK_LAUNCH_NOT_POSTED_CLOSED
  | typeof STUCK_LAUNCH_POST_FAILED

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
 *   [slack] pending-row: persona=<key> stuck-launch <text> not posted — an episodes call failed
 *
 * (a poster whose episodes call threw logs {@link stuckLaunchPostFailedLine}
 * instead, with what it threw), where `<text>` is `relaunching text`, `held text`, or `held text (no attach
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
    case STUCK_LAUNCH_POST_FAILED:
      return `${head} not posted — an episodes call failed`
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

/** No stuck-launch text for CSCB's own launch, its abort available: `ad-config-malformed` is raised; the relaunching text and the abort follow once it clears. */
export const STUCK_LAUNCH_POST_SKIP_CONFIG_MALFORMED =
  "its ad-config-malformed outage is raised, and CSCB's own stuck launch gets neither text while it is; the relaunching text and the abort follow once it clears"
/** No stuck-launch text for CSCB's own launch, its abort used: `ad-config-malformed` is raised; the held text follows once it clears. */
export const STUCK_LAUNCH_POST_SKIP_CONFIG_MALFORMED_ABORT_USED =
  "its ad-config-malformed outage is raised, and CSCB's own stuck launch gets neither text while it is; its one abort is used, so the held text follows once it clears"

/**
 * The line of a stuck-launch text not posted for persona `key` at step 3
 * (b.jg5 SRJ-1017), with why (one of the `STUCK_LAUNCH_POST_SKIP_*` texts):
 *
 *   [slack] pending-row: persona=<key> stuck-launch post not made — <why> (b.jg5 SRJ-1017)
 *
 * Pure.
 */
export function stuckLaunchPostSkippedLine(key: string, why: string): string {
  return `${stuckLaunchLineHead(key)} post not made — ${why} (b.jg5 SRJ-1017)`
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
 * answers {@link STUCK_LAUNCH_POST_FAILED}.
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
    return STUCK_LAUNCH_POST_FAILED
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

// ---------------------------------------------------------------------------
// The pending-row lap's Enter: its outcome by class (b.jg5 SRJ-118, SRJ-410)
// ---------------------------------------------------------------------------

/** The lap's Enter was typed: `send-keys` answered success. */
export const PENDING_ROW_LAP_ENTER_SENT = 'sent'
/** GONE (`ErrTmuxSendKeys`): nothing was typed. */
export const PENDING_ROW_LAP_ENTER_GONE = 'gone'
/** `ErrSpawnNotFound`: the row is absent; nothing was typed. */
export const PENDING_ROW_LAP_ENTER_ABSENT = 'absent'
/**
 * `ErrSpawnNotInteractive`: the session holding the name is not this
 * launch's (by its label's token), or the row has no launch start; nothing
 * was typed (b.jg5 SRJ-118, SRJ-613).
 */
export const PENDING_ROW_LAP_ENTER_NOT_INTERACTIVE = 'not-interactive'
/** CONFLICT, the thrown value kept so the caller can latch (b.jg5 SRJ-501). */
export const PENDING_ROW_LAP_ENTER_CONFLICT = 'conflict'
/** UNUSABLE NAME, the thrown value kept so the caller can latch (b.jg5 SRJ-512). */
export const PENDING_ROW_LAP_ENTER_UNUSABLE_NAME = 'unusable-name'
/** CONFIG: the wrapper raised `ad-config-malformed`; otherwise the UNAVAILABLE column (b.jg5 SRJ-316). */
export const PENDING_ROW_LAP_ENTER_CONFIG = 'config'
/** ENVIRONMENT (`ErrTmuxNotAvailable`): the wrapper raised `tmux-unavailable`. */
export const PENDING_ROW_LAP_ENTER_ENVIRONMENT = 'environment'
/** UNAVAILABLE, timeouts included. */
export const PENDING_ROW_LAP_ENTER_UNAVAILABLE = 'unavailable'
/** UNCLASSIFIED (`ErrSendKeysWhileRelayed` included): nothing was typed. */
export const PENDING_ROW_LAP_ENTER_UNCLASSIFIED = 'unclassified'
/** The persona is latched: no call was made, or the Enter's CONFLICT or UNUSABLE NAME latched it. */
export const PENDING_ROW_LAP_ENTER_LATCHED = 'latched'

/** What every failed Enter carries: the class `classifyAdError` gave it and its redacted one-line description. */
interface PendingRowLapEnterFailureFields {
  readonly errorClass: AdErrorClass
  readonly description: string
}

/** A failed Enter whose thrown value the caller does not need. */
export interface PendingRowLapEnterPlainFailure extends PendingRowLapEnterFailureFields {
  readonly kind:
    | typeof PENDING_ROW_LAP_ENTER_GONE
    | typeof PENDING_ROW_LAP_ENTER_ABSENT
    | typeof PENDING_ROW_LAP_ENTER_NOT_INTERACTIVE
    | typeof PENDING_ROW_LAP_ENTER_CONFIG
    | typeof PENDING_ROW_LAP_ENTER_ENVIRONMENT
    | typeof PENDING_ROW_LAP_ENTER_UNAVAILABLE
}

/**
 * An UNCLASSIFIED Enter. `stopping` marks one whose `ErrInvalidFlags`
 * version re-check decided that the server stops (b.jg5 SRJ-204, SRJ-205):
 * only the session manager's Enter (`sendPendingRowLapEnter`) sets it; the
 * caller then calls nothing more for the persona.
 */
export interface PendingRowLapEnterUnclassified extends PendingRowLapEnterFailureFields {
  readonly kind: typeof PENDING_ROW_LAP_ENTER_UNCLASSIFIED
  readonly stopping?: true
}

/** A CONFLICT Enter, the thrown value kept so the caller can latch through the latch's CONFLICT entry. */
export interface PendingRowLapEnterConflict extends PendingRowLapEnterFailureFields {
  readonly kind: typeof PENDING_ROW_LAP_ENTER_CONFLICT
  readonly error: unknown
}

/** An UNUSABLE NAME Enter, the thrown value kept so the caller can latch through the unusable-name entry. */
export interface PendingRowLapEnterUnusableName extends PendingRowLapEnterFailureFields {
  readonly kind: typeof PENDING_ROW_LAP_ENTER_UNUSABLE_NAME
  readonly error: unknown
}

/** A CONFLICT or UNUSABLE NAME Enter: either latches the persona. */
export type PendingRowLapEnterLatching = PendingRowLapEnterConflict | PendingRowLapEnterUnusableName

/** What {@link pendingRowLapEnterFailureOf} answers: exactly one failure. */
export type PendingRowLapEnterFailure = PendingRowLapEnterPlainFailure | PendingRowLapEnterUnclassified | PendingRowLapEnterLatching

/** The persona is latched: `cause` is the answer that latched it, absent when it was latched before the call and none was made. */
export interface PendingRowLapEnterLatched {
  readonly kind: typeof PENDING_ROW_LAP_ENTER_LATCHED
  readonly cause?: PendingRowLapEnterLatching
}

/** The outcome of the lap's one Enter (`sendPendingRowLapEnter`, `src/session-manager.ts`). */
export type PendingRowLapEnterOutcome =
  | { readonly kind: typeof PENDING_ROW_LAP_ENTER_SENT }
  | PendingRowLapEnterPlainFailure
  | PendingRowLapEnterUnclassified
  | PendingRowLapEnterLatched

/** The Enter not made because the persona is latched. */
export const PENDING_ROW_LAP_ENTER_NOT_SENT_LATCHED: PendingRowLapEnterLatched = Object.freeze({ kind: PENDING_ROW_LAP_ENTER_LATCHED })

/**
 * The failure of a value thrown by the lap's Enter (`send-keys` with an
 * empty text and `allow_pending`, b.jg5 SRJ-118's approver-and-lap row), by
 * class and by name through `src/ad-error-class.ts`, never by testing the
 * value against an error class: GONE; `ErrSpawnNotFound` (absent);
 * `ErrSpawnNotInteractive`; CONFLICT; UNUSABLE NAME; CONFIG; ENVIRONMENT;
 * UNAVAILABLE; and every other value UNCLASSIFIED (`ErrSendKeysWhileRelayed`
 * included). Pure; never throws.
 */
export function pendingRowLapEnterFailureOf(value: unknown): PendingRowLapEnterFailure {
  const { errorClass } = classifyAdError(value)
  const description = describeAgentDirectorFailure(value)
  if (errorClass === AD_ERROR_CLASS_GONE) return { kind: PENDING_ROW_LAP_ENTER_GONE, errorClass, description }
  if (hasAdErrorName(value, ERR_SPAWN_NOT_FOUND_NAME)) return { kind: PENDING_ROW_LAP_ENTER_ABSENT, errorClass, description }
  if (hasAdErrorName(value, ERR_SPAWN_NOT_INTERACTIVE_NAME)) {
    return { kind: PENDING_ROW_LAP_ENTER_NOT_INTERACTIVE, errorClass, description }
  }
  switch (errorClass) {
    case AD_ERROR_CLASS_CONFLICT:
      return { kind: PENDING_ROW_LAP_ENTER_CONFLICT, errorClass, description, error: value }
    case AD_ERROR_CLASS_UNUSABLE_NAME:
      return { kind: PENDING_ROW_LAP_ENTER_UNUSABLE_NAME, errorClass, description, error: value }
    case AD_ERROR_CLASS_CONFIG:
      return { kind: PENDING_ROW_LAP_ENTER_CONFIG, errorClass, description }
    case AD_ERROR_CLASS_ENVIRONMENT:
      return { kind: PENDING_ROW_LAP_ENTER_ENVIRONMENT, errorClass, description }
    case AD_ERROR_CLASS_UNAVAILABLE:
      return { kind: PENDING_ROW_LAP_ENTER_UNAVAILABLE, errorClass, description }
    default:
      return { kind: PENDING_ROW_LAP_ENTER_UNCLASSIFIED, errorClass, description }
  }
}

// ---------------------------------------------------------------------------
// The pending-row rule's pure decisions (b.jg5 SRJ-410, SRJ-117, SRJ-118)
// ---------------------------------------------------------------------------

/** {@link pendingRowAgeOf}: the row has no launch start (absent, or it does not parse): never aged (SRJ-408). */
export const PENDING_ROW_AGE_NO_LAUNCH_START = 'no-launch-start'
/** {@link pendingRowAgeOf}: younger than G: step 1, nothing (a refusal). */
export const PENDING_ROW_AGE_YOUNGER_THAN_G = 'younger-than-g'
/** {@link pendingRowAgeOf}: G or older, younger than B: step 2. */
export const PENDING_ROW_AGE_FROM_G = 'from-g'
/** {@link pendingRowAgeOf}: B or older: step 2, then step 3 for a row still `pending`. */
export const PENDING_ROW_AGE_AT_B = 'at-b'

/** What {@link pendingRowAgeOf} answers. */
export type PendingRowAge =
  | typeof PENDING_ROW_AGE_NO_LAUNCH_START
  | typeof PENDING_ROW_AGE_YOUNGER_THAN_G
  | typeof PENDING_ROW_AGE_FROM_G
  | typeof PENDING_ROW_AGE_AT_B

/** The waits the rule's age reads: G and B, each a fixed number or the derived-wait accessor itself. */
export interface PendingRowRuleWaits {
  /** G (default `adGraceMsInEffect`, read at each call). */
  readonly graceMs?: NeverEarlyWaitLength
  /** B (default `adLaunchBoundMsInEffect`, read at each call). */
  readonly launchBoundMs?: NeverEarlyWaitLength
}

/**
 * The pending-row rule's step for a `pending` row whose raw launch start is
 * `rawLaunchStart`, at `nowMs` (b.jg5 SRJ-410, SRJ-406, SRJ-408): no launch
 * start (it never ages); younger than G (step 1); G or older (step 2); B or
 * older. G and B are read from their accessors at this call (b.jg5
 * SRJ-210), through {@link isPendingRowAged}, so a wait of
 * `AD_WAIT_NEVER_ENDS`, NaN or a throwing accessor never ages the row early,
 * and a wait beyond the timer maximum is compared, never armed. G is
 * checked first: a row not past G is younger than G whatever B says. Pure;
 * never throws.
 */
export function pendingRowAgeOf(rawLaunchStart: unknown, nowMs: number, waits: PendingRowRuleWaits = {}): PendingRowAge {
  if (parseLaunchStart(rawLaunchStart) === undefined) return PENDING_ROW_AGE_NO_LAUNCH_START
  if (!isPendingRowAged(rawLaunchStart, waits.graceMs ?? adGraceMsInEffect, nowMs)) return PENDING_ROW_AGE_YOUNGER_THAN_G
  return isPendingRowAged(rawLaunchStart, waits.launchBoundMs ?? adLaunchBoundMsInEffect, nowMs)
    ? PENDING_ROW_AGE_AT_B
    : PENDING_ROW_AGE_FROM_G
}

/**
 * Whether step 2 makes its approver lap (b.jg5 SRJ-410, SRJ-118): only when
 * no dialog approver runs for P and the row's current launch has not met a
 * `send-keys` that answered `ErrSpawnNotInteractive` ("no further lap is
 * made on the row until it leaves `pending`"). Pure.
 */
export function isPendingRowLapEligible(input: { readonly approverRunning: boolean; readonly metNotInteractive: boolean }): boolean {
  return !input.approverRunning && !input.metNotInteractive
}

/** {@link PendingRowLapDecision}: press Enter (a pane showing a startup dialog the approver recognises). */
export const PENDING_ROW_LAP_NEXT_ENTER = 'enter'
/** {@link PendingRowLapDecision}: the lap is over; step 2's run goes on (a "Stop" cell ends the lap only, hatch A3). */
export const PENDING_ROW_LAP_NEXT_RUN = 'run'
/** {@link PendingRowLapDecision}: P latched: no run, no further call this round. */
export const PENDING_ROW_LAP_NEXT_LATCHED = 'latched'
/** {@link PendingRowLapDecision}: the version re-check decided that the server stops: no further call this round. */
export const PENDING_ROW_LAP_NEXT_STOPPING = 'stopping'

/** What follows one lap call. */
export type PendingRowLapNext =
  | typeof PENDING_ROW_LAP_NEXT_ENTER
  | typeof PENDING_ROW_LAP_NEXT_RUN
  | typeof PENDING_ROW_LAP_NEXT_LATCHED
  | typeof PENDING_ROW_LAP_NEXT_STOPPING

/**
 * What the lap does after one call (b.jg5 SRJ-117's pending-row lap column,
 * SRJ-118's approver-and-lap row): what follows, whether to set the record
 * of a launch whose `send-keys` met `ErrSpawnNotInteractive`, and the lap's
 * words for the round's line (descriptions already redacted, on one line).
 */
export interface PendingRowLapDecision {
  readonly next: PendingRowLapNext
  readonly setNotInteractiveRecord: boolean
  readonly note: string
}

/** A lap decision with no record set. */
function lapDecision(next: PendingRowLapNext, note: string): PendingRowLapDecision {
  return { next, setNotInteractiveRecord: false, note }
}

/**
 * The lap's decision over its `read-pane` outcome (b.jg5 SRJ-117's
 * pending-row lap column), with `showsStartupDialog` the approver's
 * recognition of a startup dialog on a pane (the session manager's
 * `paneShowsStartupDialog`, over the approver's needles):
 *
 *   | outcome                       | next                                     |
 *   |-------------------------------|------------------------------------------|
 *   | a pane showing a dialog        | Enter                                    |
 *   | a pane showing none            | the run (nothing typed)                  |
 *   | GONE, `ErrSpawnNotFound`       | the run (nothing typed; GONE's column)   |
 *   | UNAVAILABLE, CONFIG            | the run (nothing typed; CONFIG is UNAVAILABLE's column) |
 *   | ENVIRONMENT                    | the run (the outage was raised)          |
 *   | UNCLASSIFIED                   | the run (SRJ-105); with the stop mark, nothing more |
 *   | CONFLICT, UNUSABLE NAME, latched | latched: no run                        |
 *
 * A pane never proves that this launch's session shows the dialog (b.jg5
 * SRJ-613): it leads at most to Enter, whose `send-keys` is the backstop.
 * Pure; never throws (a predicate that throws counts as no dialog).
 */
export function decidePendingRowLapPane(outcome: PaneReadOutcome, showsStartupDialog: (pane: string) => boolean): PendingRowLapDecision {
  switch (outcome.kind) {
    case PANE_READ_PANE: {
      let shows = false
      try {
        shows = showsStartupDialog(outcome.pane) === true
      } catch {
        shows = false
      }
      return shows
        ? lapDecision(PENDING_ROW_LAP_NEXT_ENTER, 'read-pane: a startup dialog shows')
        : lapDecision(PENDING_ROW_LAP_NEXT_RUN, 'read-pane: no startup dialog shows, nothing typed')
    }
    case PANE_READ_GONE:
      return lapDecision(PENDING_ROW_LAP_NEXT_RUN, `read-pane GONE (${outcome.description}), nothing typed`)
    case PANE_READ_ABSENT:
      return lapDecision(PENDING_ROW_LAP_NEXT_RUN, `read-pane found no row (${outcome.description}), nothing typed`)
    case PANE_READ_UNAVAILABLE:
      return lapDecision(PENDING_ROW_LAP_NEXT_RUN, `read-pane UNAVAILABLE (${outcome.description}), nothing typed`)
    case PANE_READ_CONFIG:
      return lapDecision(PENDING_ROW_LAP_NEXT_RUN, `read-pane CONFIG (${outcome.description}): ad-config-malformed raised, nothing typed`)
    case PANE_READ_ENVIRONMENT:
      return lapDecision(PENDING_ROW_LAP_NEXT_RUN, `read-pane ENVIRONMENT (${outcome.description}): tmux-unavailable raised, nothing typed`)
    case PANE_READ_UNCLASSIFIED:
      return outcome.stopping === true
        ? lapDecision(PENDING_ROW_LAP_NEXT_STOPPING, `read-pane UNCLASSIFIED (${outcome.description}): the version re-check decided that the server stops, nothing typed`)
        : lapDecision(PENDING_ROW_LAP_NEXT_RUN, `read-pane UNCLASSIFIED (${outcome.description}), nothing typed`)
    case PANE_READ_CONFLICT:
    case PANE_READ_UNUSABLE_NAME:
      // The shared reader latches on both and answers latched; taken the same here.
      return lapDecision(PENDING_ROW_LAP_NEXT_LATCHED, `read-pane ${outcome.kind} (${outcome.description}): the persona latches, nothing typed`)
    case PANE_READ_LATCHED:
      return lapDecision(
        PENDING_ROW_LAP_NEXT_LATCHED,
        outcome.cause === undefined
          ? 'read-pane: none, the persona is latched'
          : `read-pane ${outcome.cause.kind} (${outcome.cause.description}): the persona latched, nothing typed`,
      )
  }
}

/**
 * The lap's decision over its Enter's outcome (b.jg5 SRJ-118's
 * approver-and-lap row; SRJ-410: a "Stop" cell ends the lap only, and the
 * run goes on unless the answer latched P):
 *
 *   | outcome                    | next                                                       |
 *   |----------------------------|------------------------------------------------------------|
 *   | success                    | the run (the lap is done)                                  |
 *   | GONE, `ErrSpawnNotFound`   | the run (nothing typed)                                    |
 *   | `ErrSpawnNotInteractive`   | the run (nothing typed); set the record: no further lap on this launch |
 *   | UNAVAILABLE, CONFIG        | the run (nothing typed)                                    |
 *   | ENVIRONMENT                | the run (the outage was raised)                            |
 *   | UNCLASSIFIED               | the run (SRJ-105); with the stop mark, nothing more         |
 *   | CONFLICT, UNUSABLE NAME, latched | latched: no run                                      |
 *
 * Pure; never throws.
 */
export function decidePendingRowLapEnter(outcome: PendingRowLapEnterOutcome): PendingRowLapDecision {
  switch (outcome.kind) {
    case PENDING_ROW_LAP_ENTER_SENT:
      return lapDecision(PENDING_ROW_LAP_NEXT_RUN, 'Enter typed')
    case PENDING_ROW_LAP_ENTER_GONE:
      return lapDecision(PENDING_ROW_LAP_NEXT_RUN, `Enter GONE (${outcome.description}), nothing typed`)
    case PENDING_ROW_LAP_ENTER_ABSENT:
      return lapDecision(PENDING_ROW_LAP_NEXT_RUN, `Enter found no row (${outcome.description}), nothing typed`)
    case PENDING_ROW_LAP_ENTER_NOT_INTERACTIVE:
      return {
        next: PENDING_ROW_LAP_NEXT_RUN,
        setNotInteractiveRecord: true,
        note: `Enter refused as not interactive (${outcome.description}), nothing typed: the session holding the name is not this launch's, no further lap on this launch`,
      }
    case PENDING_ROW_LAP_ENTER_UNAVAILABLE:
      return lapDecision(PENDING_ROW_LAP_NEXT_RUN, `Enter UNAVAILABLE (${outcome.description}), nothing typed`)
    case PENDING_ROW_LAP_ENTER_CONFIG:
      return lapDecision(PENDING_ROW_LAP_NEXT_RUN, `Enter CONFIG (${outcome.description}): ad-config-malformed raised, nothing typed`)
    case PENDING_ROW_LAP_ENTER_ENVIRONMENT:
      return lapDecision(PENDING_ROW_LAP_NEXT_RUN, `Enter ENVIRONMENT (${outcome.description}): tmux-unavailable raised, nothing typed`)
    case PENDING_ROW_LAP_ENTER_UNCLASSIFIED:
      return outcome.stopping === true
        ? lapDecision(PENDING_ROW_LAP_NEXT_STOPPING, `Enter UNCLASSIFIED (${outcome.description}): the version re-check decided that the server stops, nothing typed`)
        : lapDecision(PENDING_ROW_LAP_NEXT_RUN, `Enter UNCLASSIFIED (${outcome.description}), nothing typed`)
    case PENDING_ROW_LAP_ENTER_LATCHED:
      return lapDecision(
        PENDING_ROW_LAP_NEXT_LATCHED,
        outcome.cause === undefined
          ? 'Enter: none, the persona is latched'
          : `Enter ${outcome.cause.kind} (${outcome.cause.description}): the persona latched, nothing typed`,
      )
  }
}

/** Where step 2's bypassing `find-missing` run put P's row: marked `missing` (in `ids`). */
export const PENDING_ROW_RUN_MARKED_MISSING = 'marked-missing'
/** Judged and left live (in `unverified_ids`). */
export const PENDING_ROW_RUN_LEFT_LIVE = 'judged-left-live'
/** In neither list while last read `pending`: the run did not judge it (b.jg5 SRJ-120). */
export const PENDING_ROW_RUN_NOT_JUDGED = 'not-judged'
/** In neither list while last read in another state: judged alive. */
export const PENDING_ROW_RUN_JUDGED_ALIVE = 'judged-alive'
/** The run, or the post-run `get` of P's row, was refused by class (b.jg5 SRJ-105, SRJ-120): the round ends. */
export const PENDING_ROW_RUN_REFUSED = 'refused'
/** P is latched once the run is done (b.jg5 SRJ-502): no further call. */
export const PENDING_ROW_RUN_LATCHED = 'latched'
/** The run failed in any other way (logged, not memoized): the caller goes on, with no judgment of the row. */
export const PENDING_ROW_RUN_FAILED = 'failed'

/** Where step 2's run put P's row, or how it failed (the session manager maps `bypassingFindMissingSweep`'s answer). */
export type PendingRowRunPlacement =
  | typeof PENDING_ROW_RUN_MARKED_MISSING
  | typeof PENDING_ROW_RUN_LEFT_LIVE
  | typeof PENDING_ROW_RUN_NOT_JUDGED
  | typeof PENDING_ROW_RUN_JUDGED_ALIVE
  | typeof PENDING_ROW_RUN_REFUSED
  | typeof PENDING_ROW_RUN_LATCHED
  | typeof PENDING_ROW_RUN_FAILED

/** Step 2's `get` read P's row: its state and raw launch start. */
export const PENDING_ROW_GET_ROW = 'row'
/** Step 2's `get` answered `ErrSpawnNotFound`: no row. */
export const PENDING_ROW_GET_ABSENT = 'absent'
/** Step 2's `get` latched P (a note, UNUSABLE NAME, a configured persona's own `pending` row with no launch start), or found it latched. */
export const PENDING_ROW_GET_LATCHED = 'latched'
/** Step 2's `get` failed with any other error (its own error rows applied, b.jg5 SRJ-105). */
export const PENDING_ROW_GET_REFUSED = 'refused'

/** What step 2's one `get` of P's row answered, through the shared own-row read. */
export type PendingRowRuleGet =
  | { readonly kind: typeof PENDING_ROW_GET_ROW; readonly state: string; readonly launchStartedAt: unknown }
  | { readonly kind: typeof PENDING_ROW_GET_ABSENT }
  | { readonly kind: typeof PENDING_ROW_GET_LATCHED }
  | { readonly kind: typeof PENDING_ROW_GET_REFUSED; readonly error: unknown }

/** {@link readPendingRowRun}: P is latched: nothing more. */
export const PENDING_ROW_READING_LATCHED = 'latched'
/** {@link readPendingRowRun}: the run was refused: the round ends with nothing more (a refusal). */
export const PENDING_ROW_READING_RUN_REFUSED = 'run-refused'
/** {@link readPendingRowRun}: the `get` failed: the round ends with nothing more, never step 3 on an earlier read. */
export const PENDING_ROW_READING_READ_REFUSED = 'read-refused'
/** {@link readPendingRowRun}: the row reads `ended` or `missing`, or there is no row: the restart path's decision recovers it. */
export const PENDING_ROW_READING_GONE = 'gone'
/** {@link readPendingRowRun}: the row is live out of `pending`: no action from this rule. */
export const PENDING_ROW_READING_LIVE = 'live'
/** {@link readPendingRowRun}: the row reads a state CSCB does not know: nothing more this round. */
export const PENDING_ROW_READING_UNKNOWN_STATE = 'unknown-state'
/** {@link readPendingRowRun}: the row is still `pending`; `judged` says whether the run judged it. */
export const PENDING_ROW_READING_PENDING = 'pending'

/** The round's reading of its run and `get`. */
export type PendingRowRunReading =
  | { readonly kind: typeof PENDING_ROW_READING_LATCHED }
  | { readonly kind: typeof PENDING_ROW_READING_RUN_REFUSED }
  | { readonly kind: typeof PENDING_ROW_READING_READ_REFUSED; readonly error: unknown }
  | { readonly kind: typeof PENDING_ROW_READING_GONE; readonly state: DeadRowRead }
  | { readonly kind: typeof PENDING_ROW_READING_LIVE; readonly state: string }
  | { readonly kind: typeof PENDING_ROW_READING_UNKNOWN_STATE; readonly state: string }
  | { readonly kind: typeof PENDING_ROW_READING_PENDING; readonly judged: boolean; readonly launchStartedAt: unknown }

/**
 * Whether the round stops at its run, before its `get` (b.jg5 SRJ-410,
 * SRJ-120): latched, or refused by class (a refusal: the round ends).
 * `undefined` when the `get` follows: every placement, and a failure of any
 * other kind. Pure.
 */
export function pendingRowRunStops(
  run: PendingRowRunPlacement,
): { readonly kind: typeof PENDING_ROW_READING_LATCHED } | { readonly kind: typeof PENDING_ROW_READING_RUN_REFUSED } | undefined {
  if (run === PENDING_ROW_RUN_LATCHED) return { kind: PENDING_ROW_READING_LATCHED }
  if (run === PENDING_ROW_RUN_REFUSED) return { kind: PENDING_ROW_READING_RUN_REFUSED }
  return undefined
}

/**
 * The round's reading over step 2's run (`run`) and the `get` after it
 * (`get`) (b.jg5 SRJ-410, SRJ-120, SRJ-105):
 *
 *   - the run latched or was refused: {@link pendingRowRunStops}' answer;
 *   - the `get` latched: latched; failed: read refused (nothing more, never
 *     step 3 on an earlier read);
 *   - no row, `ended` or `missing`: gone, with what it read;
 *   - live out of `pending`: live; a state CSCB does not know: unknown;
 *   - `pending`: still pending, `judged` true when the run put the row in
 *     `ids` or `unverified_ids` (or judged it alive), false when it was in
 *     neither list while `pending` (not judged), or the run failed in a way
 *     that is no refusal (no judgment either).
 *
 * Pure; never throws.
 */
export function readPendingRowRun(run: PendingRowRunPlacement, get: PendingRowRuleGet): PendingRowRunReading {
  const stops = pendingRowRunStops(run)
  if (stops !== undefined) return stops
  switch (get.kind) {
    case PENDING_ROW_GET_LATCHED:
      return { kind: PENDING_ROW_READING_LATCHED }
    case PENDING_ROW_GET_REFUSED:
      return { kind: PENDING_ROW_READING_READ_REFUSED, error: get.error }
    case PENDING_ROW_GET_ABSENT:
      return { kind: PENDING_ROW_READING_GONE, state: LIVENESS_DEAD_ROW_NO_ROW }
    case PENDING_ROW_GET_ROW:
      break
  }
  const { state } = get
  if (AGENT_DIRECTOR_DEAD_STATES.has(state)) return { kind: PENDING_ROW_READING_GONE, state: state as DeadRowRead }
  if (state === AGENT_DIRECTOR_PENDING_STATE) {
    const judged = run === PENDING_ROW_RUN_MARKED_MISSING || run === PENDING_ROW_RUN_LEFT_LIVE || run === PENDING_ROW_RUN_JUDGED_ALIVE
    return { kind: PENDING_ROW_READING_PENDING, judged, launchStartedAt: get.launchStartedAt }
  }
  if (AGENT_DIRECTOR_LIVE_STATES.has(state)) return { kind: PENDING_ROW_READING_LIVE, state }
  return { kind: PENDING_ROW_READING_UNKNOWN_STATE, state }
}

/** {@link decidePendingRowStepThree}: P's `tmux-unavailable` outage is raised: no stuck-launch post and no abort (its onset is P's notice). */
export const PENDING_ROW_STEP3_TMUX_UNAVAILABLE = 'tmux-unavailable'
/** {@link decidePendingRowStepThree}: P is latched: nothing (SRJ-502). */
export const PENDING_ROW_STEP3_LATCHED = 'latched'
/** {@link decidePendingRowStepThree}: CSCB's own stuck launch while `ad-config-malformed` is raised, its abort available or used: neither text and no abort until it clears. */
export const PENDING_ROW_STEP3_CONFIG_MALFORMED = 'config-malformed'
/** {@link decidePendingRowStepThree}: CSCB's own stuck launch: the relaunching text, then the abort (SRJ-412). */
export const PENDING_ROW_STEP3_RELAUNCH = 'relaunch'
/** {@link decidePendingRowStepThree}: any other `pending` row: the held text; the row is left and never killed. */
export const PENDING_ROW_STEP3_HELD = 'held'

/** What step 3 decides on, for a row still `pending` at B or older after step 2's lap and run. */
export interface PendingRowStepThreeInput {
  /** P's `tmux-unavailable` outage is raised. */
  readonly tmuxUnavailableRaised: boolean
  /** P is latched. */
  readonly latched: boolean
  /** The row's current launch is CSCB's own (SRJ-412): the own-launch slot's answer; false with no slot filled. */
  readonly ownLaunch: boolean
  /** P's `ad-config-malformed` outage is raised. */
  readonly configMalformedRaised: boolean
  /** The stuck-launch episode's one abort is still available. */
  readonly abortAvailable: boolean
  /** A `send-keys` on the row answered `ErrSpawnNotInteractive` during its current launch: the held text drops the attach line. */
  readonly metNotInteractive: boolean
}

/** What step 3 answers. */
export type PendingRowStepThree =
  | { readonly kind: typeof PENDING_ROW_STEP3_TMUX_UNAVAILABLE }
  | { readonly kind: typeof PENDING_ROW_STEP3_LATCHED }
  | { readonly kind: typeof PENDING_ROW_STEP3_CONFIG_MALFORMED }
  | { readonly kind: typeof PENDING_ROW_STEP3_RELAUNCH }
  | { readonly kind: typeof PENDING_ROW_STEP3_HELD; readonly attachLine: boolean }

/**
 * Step 3 of the pending-row rule (b.jg5 SRJ-410, SRJ-412, SRJ-1017), for a
 * row still `pending` at B or older after step 2, whether or not the run
 * judged it (HO C21 steps 2 and 3):
 *   1. `tmux-unavailable` raised: nothing, whatever else holds;
 *   2. P latched: nothing;
 *   3. CSCB's own stuck launch while `ad-config-malformed` is raised:
 *      nothing, neither text and no abort, whether or not its one abort is
 *      still available (SRJ-1017);
 *   4. CSCB's own stuck launch with its one abort still available: the
 *      relaunching text and the abort;
 *   5. any other row, and CSCB's own launch once its abort is used: the held
 *      text, with the attach line unless the launch met
 *      `ErrSpawnNotInteractive`.
 * Pure; never throws.
 */
export function decidePendingRowStepThree(input: PendingRowStepThreeInput): PendingRowStepThree {
  if (input.tmuxUnavailableRaised) return { kind: PENDING_ROW_STEP3_TMUX_UNAVAILABLE }
  if (input.latched) return { kind: PENDING_ROW_STEP3_LATCHED }
  if (input.ownLaunch && input.configMalformedRaised) return { kind: PENDING_ROW_STEP3_CONFIG_MALFORMED }
  if (input.ownLaunch && input.abortAvailable) return { kind: PENDING_ROW_STEP3_RELAUNCH }
  return { kind: PENDING_ROW_STEP3_HELD, attachLine: !input.metNotInteractive }
}

// ---------------------------------------------------------------------------
// The pending-row rule's driver (b.jg5 SRJ-410, SRJ-404, SRJ-502, SRJ-810)
// ---------------------------------------------------------------------------

/** The rule runs at a retry of P's retry timer (either mode). */
export const PENDING_ROW_RULE_ORIGIN_RETRY = 'retry'
/** The rule's one run when P's dialog approver stops with the row still `pending` (b.jg5 SRJ-404). */
export const PENDING_ROW_RULE_ORIGIN_APPROVER_STOP = 'approver-stop'

/** Where the rule runs from. */
export type PendingRowRuleOrigin = typeof PENDING_ROW_RULE_ORIGIN_RETRY | typeof PENDING_ROW_RULE_ORIGIN_APPROVER_STOP

/** The row read the caller holds: its state and its raw launch start. */
export interface PendingRowRuleRow {
  readonly state: string
  readonly launchStartedAt: unknown
}

/** One run of the rule for P. */
export interface PendingRowRuleInput {
  readonly key: string
  /** P's log reference. */
  readonly ref: string
  /** The row read the caller holds, decided covered (`decidePendingRowCover`), or the approver's last read. */
  readonly row: PendingRowRuleRow
  readonly origin: PendingRowRuleOrigin
  /**
   * The run is made from inside P's own launch (the collision ladder's
   * `pending` step), which has made no launch call of its own then: that
   * launch's in-flight state does not count as work in flight here.
   */
  readonly withinOwnLaunch?: boolean
}

/** {@link PendingRowRelaunchAnswer}: the abort's live-row sequence started. */
export const PENDING_ROW_RELAUNCH_SEQUENCE_STARTED = 'sequence-started'
/** {@link PendingRowRelaunchAnswer}: the abort latched P. */
export const PENDING_ROW_RELAUNCH_LATCHED = 'latched'
/** {@link PendingRowRelaunchAnswer}: the abort did not end the launch this round; the row is kept `pending`. */
export const PENDING_ROW_RELAUNCH_KEPT = 'kept'

/** What step 3's own-launch branch (the relaunching post and the abort) answers. */
export type PendingRowRelaunchAnswer =
  | { readonly kind: typeof PENDING_ROW_RELAUNCH_SEQUENCE_STARTED }
  | { readonly kind: typeof PENDING_ROW_RELAUNCH_LATCHED }
  | { readonly kind: typeof PENDING_ROW_RELAUNCH_KEPT; readonly why: string }

/**
 * The slot for step 3's own-launch branch (b.jg5 SRJ-412): whether the row's
 * current launch is CSCB's own, whether the stuck-launch episode's one abort
 * is still available, and the branch itself (the relaunching post and the
 * abort). Production fills it with {@link createStuckLaunchAbort} (the
 * session manager's `buildPendingRowRuleDeps`). Absent: no row is CSCB's
 * own, and every row at B takes the held branch.
 */
export interface PendingRowOwnLaunchHooks {
  readonly isOwnLaunch: (key: string, launchStart: unknown) => boolean
  readonly isAbortAvailable: (key: string) => boolean
  readonly relaunch: (key: string, ref: string, launchStart: unknown) => Promise<PendingRowRelaunchAnswer>
}

/**
 * The rule's injected dependencies (production: the session manager's one
 * builder, `buildPendingRowRuleDeps`). Every agent-director call is made
 * through them; the rule itself makes none.
 */
export interface PendingRowRuleDeps {
  /** The wall clock the launch start is compared with (epoch ms). */
  readonly now: () => number
  /** Receives the rule's `[slack] pending-row:` lines (the server log). A throwing log is swallowed. */
  readonly log: (line: string) => void
  /** The latch's latched query (SRJ-502). A throw counts as latched. */
  readonly isLatched: (key: string) => boolean
  /**
   * What work in flight blocks a retry of P (SRJ-303: a launch call, a
   * live-row sequence or an old-life wait step), by name, or `undefined`;
   * `withinOwnLaunch` leaves out P's own launch in flight. A running dialog
   * approver never counts. A throw counts as blocked.
   */
  readonly retryBlockedBy: (key: string, withinOwnLaunch: boolean) => string | undefined
  /** Whether P's working directory is held for an old life (SRJ-810). A throw counts as held. */
  readonly isHeldForOldLife: (key: string) => boolean
  /** Whether a dialog approver runs for P (SRJ-401). A throw counts as running (no lap). */
  readonly isApproverRunning: (key: string) => boolean
  /** Whether the launch with this launch start met a `send-keys` that answered `ErrSpawnNotInteractive`. A throw counts as met. */
  readonly launchMetNotInteractive: (key: string, launchStart: unknown) => boolean
  /** Record that the launch with this launch start met a `send-keys` that answered `ErrSpawnNotInteractive`. */
  readonly recordNotInteractive: (key: string, launchStart: unknown) => void
  /** The lap's one `read-pane` (40 lines, `allow_pending`), through the shared reader (it latches on CONFLICT and UNUSABLE NAME). */
  readonly readLapPane: (key: string, ref: string) => Promise<PaneReadOutcome>
  /** The approver's recognition of a startup dialog on a pane. */
  readonly paneShowsStartupDialog: (pane: string) => boolean
  /** The lap's one Enter (`send-keys`, empty text, `allow_pending`; it latches on CONFLICT and UNUSABLE NAME). */
  readonly sendLapEnter: (key: string, ref: string) => Promise<PendingRowLapEnterOutcome>
  /** Step 2's one bypassing `find-missing` run, P's key as its next-step `get`, read against `pending`. */
  readonly runFindMissing: (key: string, ref: string) => Promise<PendingRowRunPlacement>
  /** Step 2's one `get` of P's row through the shared own-row read. */
  readonly readRow: (key: string, ref: string) => Promise<PendingRowRuleGet>
  /** Whether P's `tmux-unavailable` outage is raised. A throw counts as raised. */
  readonly isTmuxUnavailableRaised: (key: string) => boolean
  /** Whether P's `ad-config-malformed` outage is raised. A throw counts as raised. */
  readonly isConfigMalformedRaised: (key: string) => boolean
  /** The held text's poster ({@link postStuckLaunchHeld} over the server's one episodes instance). */
  readonly postHeld: (key: string, launchStart: unknown, metNotInteractive: boolean) => StuckLaunchPostAnswer
  /** G and B (default: the derived waits' accessors, read at each check). */
  readonly waits?: PendingRowRuleWaits
  /** Step 3's own-launch branch. Absent: every row at B takes the held branch. */
  readonly ownLaunch?: PendingRowOwnLaunchHooks
}

/** The rule's answer: a refusal (the row kept `pending`; the retry is a refusal, SRJ-302). */
export const PENDING_ROW_RULE_REFUSAL = 'refusal'
/** The rule's answer: the row reads `ended` or `missing`, or there is no row: the restart path's decision recovers it. */
export const PENDING_ROW_RULE_GONE = 'gone'
/** The rule's answer: the row is live out of `pending`: no action from this rule. */
export const PENDING_ROW_RULE_LIVE = 'live'
/** The rule's answer: P is latched (before the round, or by one of its calls): no further call. */
export const PENDING_ROW_RULE_LATCHED = 'latched'
/** The rule's answer: the `get` after the run failed: nothing more this round. */
export const PENDING_ROW_RULE_READ_REFUSED = 'read-refused'
/** The rule's answer: at B, the held text's poster was called; the row is left. */
export const PENDING_ROW_RULE_HELD = 'held'
/** The rule's answer: at B, step 3's own-launch branch ran. */
export const PENDING_ROW_RULE_RELAUNCH = 'relaunch'

/** Why the rule answered a refusal. */
export const PENDING_ROW_RULE_REFUSAL_REASONS = [
  'blocked',
  'held-for-old-life',
  'not-pending',
  'no-launch-start',
  'younger-than-g',
  'lap-only',
  'run-refused',
  'not-judged',
  'still-pending',
  'unknown-state',
  'tmux-unavailable',
  'config-malformed',
  'failed',
] as const

/** One refusal reason. */
export type PendingRowRuleRefusalReason = (typeof PENDING_ROW_RULE_REFUSAL_REASONS)[number]

/** What one run of the rule answers. */
export type PendingRowRuleAnswer =
  | { readonly kind: typeof PENDING_ROW_RULE_REFUSAL; readonly reason: PendingRowRuleRefusalReason }
  | { readonly kind: typeof PENDING_ROW_RULE_GONE; readonly state: DeadRowRead }
  | { readonly kind: typeof PENDING_ROW_RULE_LIVE; readonly state: string }
  | { readonly kind: typeof PENDING_ROW_RULE_LATCHED }
  | { readonly kind: typeof PENDING_ROW_RULE_READ_REFUSED; readonly error: unknown }
  | { readonly kind: typeof PENDING_ROW_RULE_HELD; readonly post: StuckLaunchPostAnswer }
  | { readonly kind: typeof PENDING_ROW_RULE_RELAUNCH; readonly answer: PendingRowRelaunchAnswer }

/** One rule instance: run the rule once for P. */
export interface PendingRowRule {
  readonly run: (input: PendingRowRuleInput) => Promise<PendingRowRuleAnswer>
}

/** The head of every pending-row rule line. */
export const PENDING_ROW_RULE_LOG_HEAD = '[slack] pending-row:'

/** The head of the rule's lines for P (`ref`) at `origin`. */
function pendingRowRuleLineHead(ref: string, origin: PendingRowRuleOrigin): string {
  return `${PENDING_ROW_RULE_LOG_HEAD} ${ref} rule (${origin})`
}

/**
 * The rule's one line for an acting round (b.jg5 SRJ-410): P's reference,
 * where it runs from, the launch start (the one renderer,
 * {@link describeLaunchStartForLog}), what each step did (`steps`, whose
 * agent-director descriptions are already redacted and on one line) and
 * what follows:
 *
 *   [slack] pending-row: <ref> rule (<origin>): launch started <ISO>; <step>; <step>… — <follows> (b.jg5 SRJ-410)
 *
 * Pure.
 */
export function pendingRowRuleRoundLine(
  ref: string,
  origin: PendingRowRuleOrigin,
  launchStart: unknown,
  steps: readonly string[],
  follows: string,
): string {
  return `${pendingRowRuleLineHead(ref, origin)}: launch started ${describeLaunchStartForLog(launchStart)}; ${steps.join('; ')} — ${follows} (b.jg5 SRJ-410)`
}

/**
 * The rule's line for a run its gate refused before any call (b.jg5
 * SRJ-410, SRJ-502, SRJ-303, SRJ-810), with why:
 *
 *   [slack] pending-row: <ref> rule (<origin>): no lap, run or post — <why> (b.jg5 SRJ-410)
 *
 * None is logged for a row younger than G. Pure.
 */
export function pendingRowRuleGateLine(ref: string, origin: PendingRowRuleOrigin, why: string): string {
  return `${pendingRowRuleLineHead(ref, origin)}: no lap, run or post — ${why} (b.jg5 SRJ-410)`
}

/** The rule's line for a run that threw inside (`described`, through `describeThrownValue`): nothing more was done. */
export function pendingRowRuleFailedLine(ref: string, origin: PendingRowRuleOrigin, described: string): string {
  return `${pendingRowRuleLineHead(ref, origin)}: failed: ${described} — nothing more this round (b.jg5 SRJ-410)`
}

/** The rule's answer in words, for a caller's line. Pure. */
export function describePendingRowRuleAnswer(answer: PendingRowRuleAnswer): string {
  switch (answer.kind) {
    case PENDING_ROW_RULE_REFUSAL:
      return `refusal (${answer.reason})`
    case PENDING_ROW_RULE_GONE:
      return `gone (${answer.state})`
    case PENDING_ROW_RULE_LIVE:
      return `live (${answer.state})`
    case PENDING_ROW_RULE_LATCHED:
      return 'latched'
    case PENDING_ROW_RULE_READ_REFUSED:
      return 'read refused'
    case PENDING_ROW_RULE_HELD:
      return `held (${answer.post})`
    case PENDING_ROW_RULE_RELAUNCH:
      return `relaunch (${answer.answer.kind})`
  }
}

/** A query's answer: exactly `true` is true; a throw answers `onThrow`. */
function askQuery(query: () => boolean, onThrow: boolean): boolean {
  try {
    return query() === true
  } catch {
    return onThrow
  }
}

/** What step 2's `get` answered, in the round's line. */
function describeRuleGet(get: PendingRowRuleGet): string {
  switch (get.kind) {
    case PENDING_ROW_GET_ROW:
      return `get: ${AGENT_DIRECTOR_LIVE_STATES.has(get.state) || AGENT_DIRECTOR_DEAD_STATES.has(get.state) ? get.state : 'unknown state'}`
    case PENDING_ROW_GET_ABSENT:
      return 'get: no row (ErrSpawnNotFound)'
    case PENDING_ROW_GET_LATCHED:
      return 'get: the persona latched'
    case PENDING_ROW_GET_REFUSED:
      return `get failed (${describeAgentDirectorFailure(get.error)})`
  }
}

/** A refusal answer. */
function refusal(reason: PendingRowRuleRefusalReason): PendingRowRuleAnswer {
  return { kind: PENDING_ROW_RULE_REFUSAL, reason }
}

/** The latched answer. */
const RULE_LATCHED: PendingRowRuleAnswer = Object.freeze({ kind: PENDING_ROW_RULE_LATCHED })

/**
 * Build one pending-row rule instance over `deps` (b.jg5 SRJ-410). Its one
 * entry, `run`, runs the rule once for P on the row read the caller holds
 * (a row the cover decision answered covered, or the dialog approver's last
 * read), and answers what it found:
 *
 *   - **Gate**, before any call: P latched (SRJ-502) answers latched; work
 *     in flight that blocks a retry (a launch call, a live-row sequence or
 *     an old-life wait step, SRJ-303; P's own launch left out from its
 *     ladder), P's working directory held for an old life (SRJ-810), a row
 *     not `pending`, or a row with no launch start (SRJ-408) answer a
 *     refusal, each with one gate line.
 *   - **Step 1**, younger than G: a refusal, no call and no line.
 *   - **Step 2**, G or older: when no approver runs and the launch has not
 *     met `ErrSpawnNotInteractive`, one lap (`read-pane`, then Enter when a
 *     startup dialog shows; a lap's `ErrSpawnNotInteractive` sets the
 *     record); a lap answer that stops polling ends the lap only, and the
 *     run goes on unless it latched P (hatch A3); then one bypassing
 *     `find-missing` run and one `get`. A refused run or a failed `get` ends
 *     the round (never step 3 on an earlier read); a row gone or live is
 *     answered; before B, a row still `pending` is a refusal, judged or not.
 *   - **Step 3**, still `pending` at B or older, judged or not
 *     ({@link decidePendingRowStepThree}): nothing while `tmux-unavailable`
 *     is raised; nothing for CSCB's own stuck launch while
 *     `ad-config-malformed` is raised, one {@link stuckLaunchPostSkippedLine}
 *     said; CSCB's own stuck launch through the own-launch slot (none until
 *     it is filled); any other row the held text through its poster, and
 *     nothing else: the row is never killed.
 *
 * The latched query is asked again after every call, and no further call is
 * made once P latched. The rule never kills, launches or reuses the row. One
 * line per acting round ({@link pendingRowRuleRoundLine}); one gate line for
 * a gate refusal ({@link pendingRowRuleGateLine}); none for a row younger
 * than G. A dependency that throws ends the round with one line
 * ({@link pendingRowRuleFailedLine}) and a refusal. Never rejects.
 *
 * The lap's pane may be a single leftover's (b.jg5 SRJ-613): it leads at
 * most to Enter, and the Enter's `send-keys` is the backstop, answering
 * `ErrSpawnNotInteractive` with nothing typed on a `pending` row whose
 * session is not this launch's.
 */
export function createPendingRowRule(deps: PendingRowRuleDeps): PendingRowRule {
  const log = (line: string): void => safePendingRowLog(deps.log, line)
  const latchedNow = (key: string): boolean => askQuery(() => deps.isLatched(key), true)

  const blockedBy = (key: string, withinOwnLaunch: boolean): string | undefined => {
    try {
      return deps.retryBlockedBy(key, withinOwnLaunch)
    } catch (err) {
      return `the work-in-flight query failed (${describeThrownValue(err)}), taken as blocked`
    }
  }

  /** Step 2's lap; answers what follows it and its words. */
  const lap = async (key: string, ref: string, launchStart: unknown): Promise<PendingRowLapDecision> => {
    const paneDecision = decidePendingRowLapPane(await deps.readLapPane(key, ref), (pane) => deps.paneShowsStartupDialog(pane))
    if (paneDecision.next !== PENDING_ROW_LAP_NEXT_ENTER) return paneDecision
    if (latchedNow(key)) return lapDecision(PENDING_ROW_LAP_NEXT_LATCHED, `${paneDecision.note}; Enter: none, the persona is latched`)
    const enterDecision = decidePendingRowLapEnter(await deps.sendLapEnter(key, ref))
    if (enterDecision.setNotInteractiveRecord) deps.recordNotInteractive(key, launchStart)
    return { ...enterDecision, note: `${paneDecision.note}; ${enterDecision.note}` }
  }

  const runRound = async (input: PendingRowRuleInput): Promise<PendingRowRuleAnswer> => {
    const { key, ref, row, origin } = input
    const gate = (why: string, answer: PendingRowRuleAnswer): PendingRowRuleAnswer => {
      log(pendingRowRuleGateLine(ref, origin, why))
      return answer
    }
    if (latchedNow(key)) return gate('the persona is latched', RULE_LATCHED)
    const blocked = blockedBy(key, input.withinOwnLaunch === true)
    if (blocked !== undefined) return gate(`work in flight blocks it (${blocked})`, refusal('blocked'))
    if (askQuery(() => deps.isHeldForOldLife(key), true)) {
      return gate('its working directory is held for an old life, SRJ-810', refusal('held-for-old-life'))
    }
    if (row.state !== AGENT_DIRECTOR_PENDING_STATE) return gate('the row it was given is not pending', refusal('not-pending'))
    const launchStart = row.launchStartedAt
    const age = pendingRowAgeOf(launchStart, deps.now(), deps.waits)
    if (age === PENDING_ROW_AGE_NO_LAUNCH_START) return gate('the row has no launch start, so it is never aged, SRJ-408', refusal('no-launch-start'))
    if (age === PENDING_ROW_AGE_YOUNGER_THAN_G) return refusal('younger-than-g')

    const steps: string[] = []
    const round = (follows: string, answer: PendingRowRuleAnswer): PendingRowRuleAnswer => {
      log(pendingRowRuleRoundLine(ref, origin, launchStart, steps, follows))
      return answer
    }
    const latchedAfterCall = (): PendingRowRuleAnswer | undefined =>
      latchedNow(key) ? round('the persona latched: nothing more', RULE_LATCHED) : undefined

    // Step 2: the lap, when no approver runs and the launch has not met ErrSpawnNotInteractive.
    const approverRunning = askQuery(() => deps.isApproverRunning(key), true)
    const metNotInteractive = askQuery(() => deps.launchMetNotInteractive(key, launchStart), true)
    if (isPendingRowLapEligible({ approverRunning, metNotInteractive })) {
      const decision = await lap(key, ref, launchStart)
      steps.push(`lap: ${decision.note}`)
      if (decision.next === PENDING_ROW_LAP_NEXT_LATCHED) return round('the persona latched: no run', RULE_LATCHED)
      if (decision.next === PENDING_ROW_LAP_NEXT_STOPPING) return round('the server stops: no run', refusal('lap-only'))
      const latched = latchedAfterCall()
      if (latched !== undefined) return latched
    } else {
      steps.push(approverRunning ? 'lap: none, a dialog approver runs' : "lap: none, this launch's send-keys met ErrSpawnNotInteractive")
    }

    // Step 2: one bypassing find-missing run, then one get.
    const placement = await deps.runFindMissing(key, ref)
    steps.push(`find-missing: ${placement}`)
    const stops = pendingRowRunStops(placement)
    if (stops?.kind === PENDING_ROW_READING_LATCHED) return round('the persona latched: nothing more', RULE_LATCHED)
    if (stops?.kind === PENDING_ROW_READING_RUN_REFUSED) return round('the run was refused: nothing more this round', refusal('run-refused'))
    const latchedAfterRun = latchedAfterCall()
    if (latchedAfterRun !== undefined) return latchedAfterRun
    const get = await deps.readRow(key, ref)
    steps.push(describeRuleGet(get))
    const reading = readPendingRowRun(placement, get)
    if (reading.kind !== PENDING_ROW_READING_LATCHED) {
      const latchedAfterGet = latchedAfterCall()
      if (latchedAfterGet !== undefined) return latchedAfterGet
    }
    switch (reading.kind) {
      case PENDING_ROW_READING_LATCHED:
        return round('the persona latched: nothing more', RULE_LATCHED)
      case PENDING_ROW_READING_RUN_REFUSED:
        return round('the run was refused: nothing more this round', refusal('run-refused'))
      case PENDING_ROW_READING_READ_REFUSED:
        return round('the get failed: nothing more this round', { kind: PENDING_ROW_RULE_READ_REFUSED, error: reading.error })
      case PENDING_ROW_READING_GONE:
        return round('the row is gone: the restart path decides', { kind: PENDING_ROW_RULE_GONE, state: reading.state })
      case PENDING_ROW_READING_LIVE:
        return round('the row left pending: no action from this rule', { kind: PENDING_ROW_RULE_LIVE, state: reading.state })
      case PENDING_ROW_READING_UNKNOWN_STATE:
        return round('nothing more this round', refusal('unknown-state'))
      case PENDING_ROW_READING_PENDING:
        break
    }
    const currentStart = reading.launchStartedAt
    if (pendingRowAgeOf(currentStart, deps.now(), deps.waits) !== PENDING_ROW_AGE_AT_B) {
      return reading.judged
        ? round('still pending before B: nothing more this round', refusal('still-pending'))
        : round('not judged before B: nothing more this round', refusal('not-judged'))
    }

    // Step 3: still pending at B or older, judged or not.
    const metNow = askQuery(() => deps.launchMetNotInteractive(key, currentStart), true)
    const hooks = deps.ownLaunch
    const ownLaunch = hooks !== undefined && askQuery(() => hooks.isOwnLaunch(key, currentStart), false)
    // Asked in this order: tmux-unavailable, latched, ad-config-malformed, then the abort.
    const tmuxUnavailableRaised = askQuery(() => deps.isTmuxUnavailableRaised(key), true)
    const latched = latchedNow(key)
    const configMalformedRaised = askQuery(() => deps.isConfigMalformedRaised(key), true)
    const abortAvailable = ownLaunch && hooks !== undefined && askQuery(() => hooks.isAbortAvailable(key), false)
    const branch = decidePendingRowStepThree({
      tmuxUnavailableRaised,
      latched,
      ownLaunch,
      configMalformedRaised,
      abortAvailable,
      metNotInteractive: metNow,
    })
    switch (branch.kind) {
      case PENDING_ROW_STEP3_TMUX_UNAVAILABLE:
        return round('at B: its tmux-unavailable outage is raised, whose onset is its notice: no stuck-launch post', refusal('tmux-unavailable'))
      case PENDING_ROW_STEP3_LATCHED:
        return round('the persona latched: nothing more', RULE_LATCHED)
      case PENDING_ROW_STEP3_CONFIG_MALFORMED:
        log(stuckLaunchPostSkippedLine(key, abortAvailable ? STUCK_LAUNCH_POST_SKIP_CONFIG_MALFORMED : STUCK_LAUNCH_POST_SKIP_CONFIG_MALFORMED_ABORT_USED))
        return round(
          abortAvailable
            ? "at B: CSCB's own stuck launch while ad-config-malformed is raised: neither text and no abort until it clears"
            : "at B: CSCB's own stuck launch, its abort used, while ad-config-malformed is raised: neither text until it clears",
          refusal('config-malformed'),
        )
      case PENDING_ROW_STEP3_RELAUNCH: {
        // Reached only with the own-launch slot filled (`ownLaunch` is false without it).
        if (hooks === undefined) return round('nothing more this round', refusal('still-pending'))
        const answer = await hooks.relaunch(key, ref, currentStart)
        return round(`at B: CSCB's own stuck launch: the relaunching post and the abort (${answer.kind})`, { kind: PENDING_ROW_RULE_RELAUNCH, answer })
      }
      case PENDING_ROW_STEP3_HELD: {
        // SRJ-412: CSCB's own launch reaches the held branch only once its
        // episode's one abort is used; said here, where the held text is the outcome.
        if (ownLaunch) log(stuckLaunchAbortSkippedLine(key, STUCK_LAUNCH_ABORT_SKIP_EARLIER_ABORT))
        const text = branch.attachLine ? 'the held text' : 'the held text without the attach line'
        log(pendingRowRuleRoundLine(ref, origin, launchStart, steps, `at B: ${text}; the row is left, never killed`))
        return { kind: PENDING_ROW_RULE_HELD, post: deps.postHeld(key, currentStart, !branch.attachLine) }
      }
    }
  }

  return {
    run: async (input) => {
      try {
        return await runRound(input)
      } catch (err) {
        log(pendingRowRuleFailedLine(input.ref, input.origin, describeThrownValue(err)))
        return refusal('failed')
      }
    },
  }
}

// ---------------------------------------------------------------------------
// CSCB's own stuck launch: its one abort per stuck-launch episode (b.jg5 SRJ-412)
// ---------------------------------------------------------------------------

/** The abort kill succeeded (`kill_sent` true or false, the row already gone, the session gone, or a read between tries found the row finished): the sequence follows. */
export const STUCK_LAUNCH_ABORT_KILL_SUCCEEDED = 'succeeded'
/** The abort kill's `ErrTmuxKillFailed` stands after its tries: the kill-failure alert was raised; the episode's one abort is used. */
export const STUCK_LAUNCH_ABORT_KILL_FAILED = 'kill-failed'
/** The abort kill's CONFLICT or UNUSABLE NAME latched P, or a read between its tries did: the episode's one abort is used. */
export const STUCK_LAUNCH_ABORT_KILL_LATCHED = 'latched'
/**
 * The abort kill did nothing (another UNAVAILABLE outcome, ENVIRONMENT,
 * CONFIG or UNCLASSIFIED): the abort is not used, and the same abort is made
 * again at the next retry that reaches step 3 (Q-12).
 */
export const STUCK_LAUNCH_ABORT_KILL_TRY_LATER = 'try-later'
/**
 * The abort kill's tries were stopped by SRJ-702's stop rule (P's teardown, P
 * no longer up, a server shutdown, or a version re-check that stops the
 * server): no alert of either version was raised, and the abort is not used.
 */
export const STUCK_LAUNCH_ABORT_KILL_STOPPED = 'stopped'

/**
 * What the abort's one checked kill answers (the session manager's
 * `abortKillOwnStuckLaunch`), decided by class and name through
 * `src/ad-error-class.ts`. `description` is the standing outcome as one log
 * line renders it (`describeKillOutcome`: redacted, `kill_sent` included).
 */
export type StuckLaunchAbortKillAnswer =
  | { readonly kind: typeof STUCK_LAUNCH_ABORT_KILL_SUCCEEDED; readonly killSent?: boolean; readonly description: string }
  | { readonly kind: typeof STUCK_LAUNCH_ABORT_KILL_FAILED; readonly description: string }
  | { readonly kind: typeof STUCK_LAUNCH_ABORT_KILL_LATCHED; readonly description: string }
  | { readonly kind: typeof STUCK_LAUNCH_ABORT_KILL_TRY_LATER; readonly errorClass: string; readonly description: string }
  | { readonly kind: typeof STUCK_LAUNCH_ABORT_KILL_STOPPED; readonly description: string }

/**
 * Whether the abort kill's answer uses up the stuck-launch episode's one
 * abort (b.jg5 SRJ-412, Q-12): a success, `ErrTmuxKillFailed` after tries no
 * stop ended, and a latch do; "try again later" and a stopped kill do not.
 * Pure.
 */
export function stuckLaunchAbortKillUsesAbort(answer: StuckLaunchAbortKillAnswer): boolean {
  return (
    answer.kind === STUCK_LAUNCH_ABORT_KILL_SUCCEEDED ||
    answer.kind === STUCK_LAUNCH_ABORT_KILL_FAILED ||
    answer.kind === STUCK_LAUNCH_ABORT_KILL_LATCHED
  )
}

/** The abort's live-row sequence started (entry at step 2). */
export const STUCK_LAUNCH_ABORT_SEQUENCE_STARTED = 'started'
/** The abort's live-row sequence did not start; `why` is the start entry's answer. */
export const STUCK_LAUNCH_ABORT_SEQUENCE_NOT_STARTED = 'not-started'

/** What the start of the abort's live-row sequence answers. */
export type StuckLaunchAbortSequenceStart =
  | { readonly kind: typeof STUCK_LAUNCH_ABORT_SEQUENCE_STARTED }
  | { readonly kind: typeof STUCK_LAUNCH_ABORT_SEQUENCE_NOT_STARTED; readonly why: string }

/** The abort was not made: the stuck-launch episode's one abort was used, so the row is any other `pending` row. */
export const STUCK_LAUNCH_ABORT_SKIP_EARLIER_ABORT = "the stuck-launch episode's one abort was used, so the row is any other pending row and gets the held text"
/** The abort was not made: P's `tmux-unavailable` outage is raised. */
export const STUCK_LAUNCH_ABORT_SKIP_TMUX_UNAVAILABLE = 'its tmux-unavailable outage is raised; the abort waits until it clears'
/** The abort was not made: P's `ad-config-malformed` outage is raised (SRJ-316: no kill of a row read `pending`). */
export const STUCK_LAUNCH_ABORT_SKIP_CONFIG_MALFORMED = 'its ad-config-malformed outage is raised, and no row read pending is killed while it is; the abort waits until it clears'
/** The abort was not made: an abort of this persona's launch is already in progress. */
export const STUCK_LAUNCH_ABORT_SKIP_IN_PROGRESS = 'an abort of its launch is already in progress'
/** The abort was not made: the server is shutting down (the relaunching post answered closed). */
export const STUCK_LAUNCH_ABORT_SKIP_SHUTDOWN = 'the server is shutting down'
/** The abort was not made: the relaunching post failed (an episodes call threw); the abort waits for a post. */
export const STUCK_LAUNCH_ABORT_SKIP_POST_FAILED = 'the relaunching post failed, and no abort is made without it; tried again at the next retry that reaches step 3'
/** The abort was not made: no stuck-launch episode was open to hold its one abort. */
export const STUCK_LAUNCH_ABORT_SKIP_NO_EPISODE = 'no stuck-launch episode is open to hold its one abort; tried again at the next retry that reaches step 3'

/** Why the abort, once its kill answered, makes no relaunch this round: `ErrTmuxKillFailed` after its tries. */
export const STUCK_LAUNCH_ABORT_KEPT_KILL_FAILED =
  "the abort kill failed after its tries: the kill-failure alert was raised, the episode's one abort is used, and the held text follows at the next retry that reaches step 3"
/** Why: the abort kill did nothing; Q-12. */
export const STUCK_LAUNCH_ABORT_KEPT_TRY_LATER =
  'the abort kill did nothing: the abort is not used, and the same abort is made at the next retry that reaches step 3, with no second relaunching post'
/** Why: the abort kill's tries were stopped by SRJ-702's stop rule. */
export const STUCK_LAUNCH_ABORT_KEPT_STOPPED =
  "the abort kill's tries were stopped: no alert, the abort is not used, and the same abort is made at the next retry that reaches step 3, with no second relaunching post"

/** The head of every abort line for persona `key`. */
function stuckLaunchAbortLineHead(key: string): string {
  return `${stuckLaunchLineHead(key)} abort`
}

/**
 * The abort's start line (b.jg5 SRJ-412), after the relaunching post:
 *
 *   [slack] pending-row: persona=<key> stuck-launch abort started for <ref> (launch started <ISO>) — its dialog approver is stopped if one runs, then one checked kill of its row (b.jg5 SRJ-412)
 *
 * Pure.
 */
export function stuckLaunchAbortStartedLine(key: string, ref: string, launchStart: unknown): string {
  return `${stuckLaunchAbortLineHead(key)} started for ${ref} (launch started ${describeLaunchStartForLog(launchStart)}) — its dialog approver is stopped if one runs, then one checked kill of its row (b.jg5 SRJ-412)`
}

/**
 * The line of an abort not made for persona `key` (b.jg5 SRJ-412), with why
 * (one of the `STUCK_LAUNCH_ABORT_SKIP_*` texts):
 *
 *   [slack] pending-row: persona=<key> stuck-launch abort not made — <why> (b.jg5 SRJ-412)
 *
 * Pure.
 */
export function stuckLaunchAbortSkippedLine(key: string, why: string): string {
  return `${stuckLaunchAbortLineHead(key)} not made — ${why} (b.jg5 SRJ-412)`
}

/**
 * The line of the abort kill's answer for persona `key` (b.jg5 SRJ-412,
 * SRJ-702, SRJ-704), with what follows:
 *
 *   [slack] pending-row: persona=<key> stuck-launch abort kill: <kind> (<description>) — <follows> (b.jg5 SRJ-412)
 *
 * `<description>` is the answer's own, already redacted. Pure.
 */
export function stuckLaunchAbortKillLine(key: string, answer: StuckLaunchAbortKillAnswer, follows: string): string {
  return `${stuckLaunchAbortLineHead(key)} kill: ${answer.kind} (${answer.description}) — ${follows} (b.jg5 SRJ-412)`
}

/**
 * The line of the abort's live-row sequence start for persona `key` (b.jg5
 * SRJ-412, SRJ-705):
 *
 *   [slack] pending-row: persona=<key> stuck-launch abort: the live-row sequence started at its second step, keeping a resumed launch's conversation (b.jg5 SRJ-412, SRJ-705)
 *   [slack] pending-row: persona=<key> stuck-launch abort: the live-row sequence did not start (<why>) — nothing more this round (b.jg5 SRJ-412, SRJ-705)
 *
 * Pure.
 */
export function stuckLaunchAbortSequenceLine(key: string, start: StuckLaunchAbortSequenceStart): string {
  return start.kind === STUCK_LAUNCH_ABORT_SEQUENCE_STARTED
    ? `${stuckLaunchAbortLineHead(key)}: the live-row sequence started at its second step, keeping a resumed launch's conversation (b.jg5 SRJ-412, SRJ-705)`
    : `${stuckLaunchAbortLineHead(key)}: the live-row sequence did not start (${start.why}) — nothing more this round (b.jg5 SRJ-412, SRJ-705)`
}

/** What the abort uses of the server's one episodes instance: the close hook of the stuck-launch episode. */
export type StuckLaunchAbortEpisodes = Pick<PersonaEpisodes, 'whenClosed'>

/**
 * The abort's injected dependencies (production: the session manager's
 * builder, `buildPendingRowRuleDeps`). Every agent-director call is made
 * through them; the abort itself makes none.
 */
export interface StuckLaunchAbortDeps {
  /** Receives the abort's lines (the server log). A throwing log is swallowed. */
  readonly log: (line: string) => void
  /**
   * Whether P's row's current launch, with this launch start as read now, is
   * CSCB's own (production: `isCscbOwnLaunch`: the own-launch record, the
   * unchanged launch start, no `send-keys` `ErrSpawnNotInteractive`). A throw
   * counts as not own.
   */
  readonly isOwnLaunch: (key: string, launchStart: unknown) => boolean
  /** The latch's latched query (SRJ-502). A throw counts as latched. */
  readonly isLatched: (key: string) => boolean
  /** Whether P's `tmux-unavailable` outage is raised. A throw counts as raised. */
  readonly isTmuxUnavailableRaised: (key: string) => boolean
  /** Whether P's `ad-config-malformed` outage is raised. A throw counts as raised. */
  readonly isConfigMalformedRaised: (key: string) => boolean
  /** The relaunching text's poster ({@link postStuckLaunchRelaunching} over the server's one episodes instance, B in effect). */
  readonly postRelaunching: (key: string) => StuckLaunchPostAnswer
  /** The server's one episodes instance: the stuck-launch episode's close hook holds the abort's per-episode state. */
  readonly episodes: StuckLaunchAbortEpisodes
  /** Stop P's running dialog approver with the abort's stop reason, if one runs; resolves once it has stopped. */
  readonly stopApprover: (key: string) => Promise<unknown>
  /** The abort's one checked kill of P's row with the bounded retry and its alert. */
  readonly abortKill: (key: string, ref: string) => Promise<StuckLaunchAbortKillAnswer>
  /** Start the live-row sequence at its second step, the conversation kept, after the abort's own kill. */
  readonly startSequence: (key: string, ref: string) => StuckLaunchAbortSequenceStart
}

/** One persona's abort state in its open stuck-launch episode. */
interface StuckLaunchAbortState {
  /** The episode's one abort is used (SRJ-412). */
  used: boolean
  /** An abort is running now (its approver stop, kill or sequence start). */
  inProgress: boolean
}

/** What {@link createStuckLaunchAbort} answers: the pending-row rule's own-launch slot, and a read of the abort state. */
export interface StuckLaunchAbort extends PendingRowOwnLaunchHooks {
  /** Whether persona `key`'s open stuck-launch episode has used its one abort. Read-only. */
  readonly isAbortUsed: (key: string) => boolean
}

/** A kept answer. */
function relaunchKept(why: string): PendingRowRelaunchAnswer {
  return { kind: PENDING_ROW_RELAUNCH_KEPT, why }
}

/** The latched answer of the abort. */
const RELAUNCH_LATCHED: PendingRowRelaunchAnswer = Object.freeze({ kind: PENDING_ROW_RELAUNCH_LATCHED })

/**
 * Build the abort of CSCB's own stuck launch (b.jg5 SRJ-412, SRJ-410 step 3)
 * over `deps`: the pending-row rule's own-launch slot
 * ({@link PendingRowOwnLaunchHooks}), with the per-episode abort state.
 *
 *   - `isOwnLaunch`: `deps.isOwnLaunch` (a throw is not own).
 *   - `isAbortAvailable`: false once P's open stuck-launch episode has used
 *     its one abort; a pure query that logs nothing (the rule logs
 *     {@link STUCK_LAUNCH_ABORT_SKIP_EARLIER_ABORT} only when its step 3
 *     then takes the held branch), so a relaunch still `pending` at B
 *     in the same episode gets the held text once and is never killed. The
 *     state lives in this instance, per persona, and is disposed when the
 *     episode closes (`whenClosed` of the stuck-launch kind: a read of the
 *     row live out of `pending`, a latch, P's teardown, shutdown), so a new
 *     episode has its abort again.
 *   - `relaunch`, in order: the relaunching post (once per episode; a second
 *     call in the episode posts nothing); no abort unless the post was made
 *     or already made in this episode (an outage that suppressed it, a
 *     shutdown and a failed post each make none, with one line); the state
 *     is kept for the open episode; P's running dialog approver is stopped
 *     (`deps.stopApprover`, its stop reason outside the stops the rule runs
 *     after); the latch and both outages are asked again (no kill while P is
 *     latched, while `tmux-unavailable` is raised, or of a row read `pending`
 *     while `ad-config-malformed` is raised; SRJ-316); the one checked kill
 *     (`deps.abortKill`). Then by the kill's answer:
 *       - success: the abort is used, and the live-row sequence starts at
 *         step 2 (`deps.startSequence`), answering "sequence started";
 *       - `ErrTmuxKillFailed`: the abort is used; nothing more this round
 *         (the held text comes at the next retry that reaches step 3);
 *       - latched: the abort is used; answers latched;
 *       - try again later, or stopped by SRJ-702's stop rule: the abort is
 *         not used; nothing more this round; the next retry that reaches
 *         step 3 makes the same abort with no second relaunching post (Q-12).
 * At most one abort of a persona runs at a time: a call while one runs
 * makes nothing. One line per decision and outcome. Every answer but
 * "sequence started" and latched is kept (no held post that round). Never
 * rejects: a dependency that throws ends the round as kept, with its line.
 */
export function createStuckLaunchAbort(deps: StuckLaunchAbortDeps): StuckLaunchAbort {
  const log = (line: string): void => safePendingRowLog(deps.log, line)
  const states = new Map<string, StuckLaunchAbortState>()

  const skip = (key: string, why: string): PendingRowRelaunchAnswer => {
    log(stuckLaunchAbortSkippedLine(key, why))
    return relaunchKept(why)
  }

  /** P's state for its open stuck-launch episode, made and tied to the episode's close when absent; `undefined` when no episode is open. */
  const stateFor = (key: string): StuckLaunchAbortState | undefined => {
    const current = states.get(key)
    if (current !== undefined) return current
    const state: StuckLaunchAbortState = { used: false, inProgress: false }
    const kept = deps.episodes.whenClosed(key, STUCK_LAUNCH_KIND, () => {
      if (states.get(key) === state) states.delete(key)
    })
    if (!kept) return undefined
    states.set(key, state)
    return state
  }

  const abort = async (key: string, ref: string, launchStart: unknown): Promise<PendingRowRelaunchAnswer> => {
    if (states.get(key)?.inProgress === true) return skip(key, STUCK_LAUNCH_ABORT_SKIP_IN_PROGRESS)
    const post = deps.postRelaunching(key)
    switch (post) {
      case STUCK_LAUNCH_POSTED:
      case STUCK_LAUNCH_ALREADY_POSTED:
        break
      case STUCK_LAUNCH_SUPPRESSED:
        return skip(key, STUCK_LAUNCH_ABORT_SKIP_TMUX_UNAVAILABLE)
      case STUCK_LAUNCH_NOT_POSTED_CLOSED:
        return skip(key, STUCK_LAUNCH_ABORT_SKIP_SHUTDOWN)
      case STUCK_LAUNCH_POST_FAILED:
        return skip(key, STUCK_LAUNCH_ABORT_SKIP_POST_FAILED)
    }
    const state = stateFor(key)
    if (state === undefined) return skip(key, STUCK_LAUNCH_ABORT_SKIP_NO_EPISODE)
    if (state.used) return skip(key, STUCK_LAUNCH_ABORT_SKIP_EARLIER_ABORT)
    if (state.inProgress) return skip(key, STUCK_LAUNCH_ABORT_SKIP_IN_PROGRESS)
    state.inProgress = true
    try {
      log(stuckLaunchAbortStartedLine(key, ref, launchStart))
      await deps.stopApprover(key)
      // b.jg5 SRJ-502, SRJ-316, SRJ-412: asked again after the stop, which waited on the approver's call in progress.
      if (askQuery(() => deps.isLatched(key), true)) {
        log(stuckLaunchAbortSkippedLine(key, 'the persona is latched'))
        return RELAUNCH_LATCHED
      }
      if (askQuery(() => deps.isTmuxUnavailableRaised(key), true)) return skip(key, STUCK_LAUNCH_ABORT_SKIP_TMUX_UNAVAILABLE)
      if (askQuery(() => deps.isConfigMalformedRaised(key), true)) return skip(key, STUCK_LAUNCH_ABORT_SKIP_CONFIG_MALFORMED)
      const killed = await deps.abortKill(key, ref)
      if (stuckLaunchAbortKillUsesAbort(killed)) state.used = true
      switch (killed.kind) {
        case STUCK_LAUNCH_ABORT_KILL_SUCCEEDED: {
          log(stuckLaunchAbortKillLine(key, killed, "the episode's one abort is used; the live-row sequence follows from its second step"))
          const started = deps.startSequence(key, ref)
          log(stuckLaunchAbortSequenceLine(key, started))
          return started.kind === STUCK_LAUNCH_ABORT_SEQUENCE_STARTED
            ? { kind: PENDING_ROW_RELAUNCH_SEQUENCE_STARTED }
            : relaunchKept(`the abort kill succeeded, but the live-row sequence did not start (${started.why})`)
        }
        case STUCK_LAUNCH_ABORT_KILL_FAILED:
          log(stuckLaunchAbortKillLine(key, killed, STUCK_LAUNCH_ABORT_KEPT_KILL_FAILED))
          return relaunchKept(STUCK_LAUNCH_ABORT_KEPT_KILL_FAILED)
        case STUCK_LAUNCH_ABORT_KILL_LATCHED:
          log(stuckLaunchAbortKillLine(key, killed, "the persona latched: the episode's one abort is used, and the kill is never tried again"))
          return RELAUNCH_LATCHED
        case STUCK_LAUNCH_ABORT_KILL_TRY_LATER:
          log(stuckLaunchAbortKillLine(key, killed, STUCK_LAUNCH_ABORT_KEPT_TRY_LATER))
          return relaunchKept(STUCK_LAUNCH_ABORT_KEPT_TRY_LATER)
        case STUCK_LAUNCH_ABORT_KILL_STOPPED:
          log(stuckLaunchAbortKillLine(key, killed, STUCK_LAUNCH_ABORT_KEPT_STOPPED))
          return relaunchKept(STUCK_LAUNCH_ABORT_KEPT_STOPPED)
      }
    } finally {
      state.inProgress = false
    }
  }

  return {
    isOwnLaunch: (key, launchStart) => askQuery(() => deps.isOwnLaunch(key, launchStart), false),
    isAbortAvailable: (key) => states.get(key)?.used !== true,
    isAbortUsed: (key) => states.get(key)?.used === true,
    relaunch: async (key, ref, launchStart) => {
      try {
        return await abort(key, ref, launchStart)
      } catch (err) {
        return skip(key, `the abort failed: ${describeThrownValue(err)}; nothing more this round`)
      }
    },
  }
}
