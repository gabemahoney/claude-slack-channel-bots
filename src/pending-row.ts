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
 * that reader. For a `status` result the raw value is the one E9's raw
 * reader carries (`pendingLaunchStartOf`, `src/liveness-reading.ts`), and a
 * `get` or `list` row is read the same way. The row-read rule
 * (`decideOwnRowRead`, `src/row-read-rules.ts`) latches a configured
 * persona's own such row with the case "launch start not recorded"
 * (SRJ-513); a row under a key no configured persona uses latches nothing.
 *
 * Where later work plugs in: E28 builds the launch start's uses and the
 * row's ageing on this reader, E29 adds the pending-row rule to this module,
 * and E17 (the dialog approver) and E21 (the live-row sequence) read the
 * launch start through it.
 *
 * Pure: no module-scope state, no clock, no I/O, no agent-director call, no
 * log line, nothing run at import. Nothing names an export only the Phase 1
 * client has; the result field is typed through CSCB's own Phase 1
 * declarations (`src/ad-phase1-types.ts`, a type-only import).
 *
 * SPDX-License-Identifier: MIT
 */

import type { Phase1StatusResult } from './ad-phase1-types.ts'
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
 * (`pendingLaunchStartOf`, E9's raw reader) is absent or does not parse
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
