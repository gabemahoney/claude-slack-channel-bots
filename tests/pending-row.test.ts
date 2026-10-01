/**
 * pending-row.test.ts — `src/pending-row.ts`: the launch-start reader and the
 * pending-with-no-launch-start predicate (b.jg5 SRJ-406, SRJ-408, SRJ-513).
 *
 * Covered now: `parseLaunchStart` gives the instant of both of the stub's
 * sample forms (with and without the fraction), a numeric-offset form,
 * fractions of other lengths (first three digits kept, the rest dropped, never
 * rounded) and lower-case `t`/`z`; it range-checks each field (Feb 30, a
 * non-leap Feb 29 and out-of-range fields give none; a leap-year Feb 29 and a
 * `:60` leap second give an instant); absent, `null`, empty, non-string and
 * malformed values give none. Expected instants are derived from the samples'
 * own components (`Date.parse` of an ECMAScript date-time string, `Date.UTC`
 * of the parts), never typed as epoch numbers.
 * `isPendingWithNoLaunchStart` holds for a `pending` `status` result, `get`
 * row or `list` row with no, a `null` or an unparseable launch start, and for
 * none with a valid one, in any other state, or for no row.
 *
 * E28 (the launch start's uses and the row's ageing, SRJ-406/SRJ-408's own
 * Test lines) and E29 (the pending-row rule) extend this file.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import { isPendingWithNoLaunchStart, parseLaunchStart, type PendingRowFields } from '../src/pending-row.ts'
import {
  cannedGetResult,
  cannedListRow,
  cannedStatusResult,
  SAMPLE_LAUNCH_START_FRACTIONAL,
  SAMPLE_LAUNCH_START_WHOLE,
  SAMPLE_LAUNCH_STARTS,
} from './test-helpers/agent-director-stub.ts'

const MINUTE_MS = 60_000

/** The whole sample with `suffix` in place of its `Z` (a fraction, a zone). */
function wholeWith(suffix: string): string {
  return SAMPLE_LAUNCH_START_WHOLE.replace(/Z$/, suffix)
}

/** The whole sample's instant, from its own ECMAScript date-time form. */
const WHOLE_INSTANT = Date.parse(SAMPLE_LAUNCH_START_WHOLE)

/** An RFC 3339 UTC date-time on `date` (`YYYY-MM-DD`) at `time`. */
function utcAt(date: string, time = '12:00:00'): string {
  return `${date}T${time}Z`
}

// ---------------------------------------------------------------------------
// parseLaunchStart — valid forms (SRJ-406: with or without the fraction)
// ---------------------------------------------------------------------------

describe('parseLaunchStart: a valid launch start gives its instant', () => {
  test.each([
    ['fractional', SAMPLE_LAUNCH_START_FRACTIONAL],
    ['whole', SAMPLE_LAUNCH_START_WHOLE],
  ])('the stub\'s %s sample', (_form, sample) => {
    expect(parseLaunchStart(sample)).toBe(Date.parse(sample))
  })

  test('the fractional sample is its fraction\'s milliseconds after the same second', () => {
    const fraction = /\.(\d{3})Z$/.exec(SAMPLE_LAUNCH_START_FRACTIONAL)?.[1]
    const sameSecond = SAMPLE_LAUNCH_START_FRACTIONAL.replace(/\.\d+Z$/, 'Z')
    expect(fraction).toBeDefined()
    expect(parseLaunchStart(SAMPLE_LAUNCH_START_FRACTIONAL)).toBe(Date.parse(sameSecond) + Number(fraction))
  })

  test.each([
    ['+05:30', -(5 * 60 + 30)],
    ['-08:00', 8 * 60],
    ['+00:00', 0],
  ])('a numeric offset %s gives the same instant as UTC shifted by it', (offset, shiftMinutes) => {
    expect(parseLaunchStart(wholeWith(offset))).toBe(WHOLE_INSTANT + shiftMinutes * MINUTE_MS)
  })

  test('a fraction with a numeric offset', () => {
    expect(parseLaunchStart(wholeWith('.250-08:00'))).toBe(WHOLE_INSTANT + 250 + 8 * 60 * MINUTE_MS)
  })

  test.each([
    ['1 digit', '5', 500],
    ['2 digits', '12', 120],
    ['3 zero digits', '000', 0],
    ['6 digits (first 3 kept)', '123456', 123],
    ['9 digits (dropped, not rounded)', '987654321', 987],
  ])('a fraction of %s', (_label, fraction, ms) => {
    expect(parseLaunchStart(wholeWith(`.${fraction}Z`))).toBe(WHOLE_INSTANT + ms)
  })

  test('lower-case `t` and `z` read as `T` and `Z`', () => {
    expect(parseLaunchStart(SAMPLE_LAUNCH_START_FRACTIONAL.replace('T', 't').replace('Z', 'z'))).toBe(
      Date.parse(SAMPLE_LAUNCH_START_FRACTIONAL),
    )
  })

  test.each([
    ['Feb 29 in a leap year', 2024, 2, 29],
    ['Feb 29 in a century leap year', 2000, 2, 29],
    ['the last day of a 31-day month', 2026, 12, 31],
  ])('%s', (_label, year, month, day) => {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    expect(parseLaunchStart(utcAt(date))).toBe(Date.UTC(year, month - 1, day, 12, 0, 0))
  })

  test('a `:60` leap second is accepted, as the next minute\'s start', () => {
    expect(parseLaunchStart(utcAt('2016-12-31', '23:59:60'))).toBe(Date.UTC(2017, 0, 1, 0, 0, 0))
  })

  test('a year below 100 is that year, not 19xx', () => {
    const raw = utcAt('0050-01-01', '00:00:00')
    expect(parseLaunchStart(raw)).toBe(Date.parse(raw))
    expect(new Date(parseLaunchStart(raw) as number).getUTCFullYear()).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// parseLaunchStart — no launch start (SRJ-408: absent or unparseable = none)
// ---------------------------------------------------------------------------

describe('parseLaunchStart: an absent or unparseable launch start gives none', () => {
  test.each([
    ['absent (undefined)', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a number (the sample\'s epoch ms)', Date.parse(SAMPLE_LAUNCH_START_WHOLE)],
    ['a Date', new Date(SAMPLE_LAUNCH_START_WHOLE)],
    ['an object', { launch_started_at: SAMPLE_LAUNCH_START_WHOLE }],
    ['a boolean', true],
  ])('%s', (_label, raw) => {
    expect(parseLaunchStart(raw)).toBeUndefined()
  })

  test.each([
    ['no time part', SAMPLE_LAUNCH_START_WHOLE.slice(0, 10)],
    ['no zone', SAMPLE_LAUNCH_START_WHOLE.replace(/Z$/, '')],
    ['no zone, with a fraction', SAMPLE_LAUNCH_START_FRACTIONAL.replace(/Z$/, '')],
    ['not a date', 'not a date'],
    ['no seconds', SAMPLE_LAUNCH_START_WHOLE.replace(/:00Z$/, 'Z')],
    ['an empty fraction', wholeWith('.Z')],
    ['an offset without a colon', wholeWith('+0530')],
    ['surrounding whitespace', ` ${SAMPLE_LAUNCH_START_WHOLE} `],
    ['trailing text', `${SAMPLE_LAUNCH_START_WHOLE}x`],
  ])('a malformed string: %s', (_label, raw) => {
    expect(parseLaunchStart(raw)).toBeUndefined()
  })

  test.each([
    ['Feb 30', utcAt('2024-02-30')],
    ['Feb 29 in a non-leap year', utcAt('2026-02-29')],
    ['Feb 29 in a non-leap century year', utcAt('1900-02-29')],
    ['Apr 31', utcAt('2026-04-31')],
    ['month 00', utcAt('2026-00-10')],
    ['month 13', utcAt('2026-13-10')],
    ['day 00', utcAt('2026-05-00')],
    ['hour 24', utcAt('2026-05-24', '24:00:00')],
    ['minute 60', utcAt('2026-05-24', '12:60:00')],
    ['second 61', utcAt('2026-05-24', '12:00:61')],
    ['offset hour 24', wholeWith('+24:00')],
    ['offset minute 60', wholeWith('+05:60')],
  ])('a field out of range: %s', (_label, raw) => {
    expect(parseLaunchStart(raw)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// isPendingWithNoLaunchStart (SRJ-408, SRJ-513)
// ---------------------------------------------------------------------------

/** A `status` result, `get` row and `list` row with the given fields. */
const ROW_FORMS: ReadonlyArray<[string, (fields: PendingRowFields) => PendingRowFields]> = [
  ['status result', (fields) => cannedStatusResult(fields)],
  ['get row', (fields) => cannedGetResult({ claude_instance_id: 'cscb_alpha', ...fields })],
  ['list row', (fields) => cannedListRow({ claude_instance_id: 'cscb_alpha', ...fields })],
]

/** Launch starts that are none: absent, `null`, empty and unparseable. */
const NO_LAUNCH_STARTS: ReadonlyArray<[string, string | null | undefined]> = [
  ['absent', SAMPLE_LAUNCH_STARTS.none],
  ['null', null],
  ['empty', ''],
  ['no zone', SAMPLE_LAUNCH_START_WHOLE.replace(/Z$/, '')],
  ['Feb 30', utcAt('2024-02-30')],
]

/** Valid launch starts: the stub's two sample forms. */
const VALID_LAUNCH_STARTS: ReadonlyArray<[string, string]> = [
  ['fractional', SAMPLE_LAUNCH_START_FRACTIONAL],
  ['whole', SAMPLE_LAUNCH_START_WHOLE],
]

const OTHER_STATES = ['waiting', 'working', 'ask_user', 'check_permission', 'ended', 'missing']

describe('isPendingWithNoLaunchStart', () => {
  test.each(ROW_FORMS.flatMap(([form, build]) => NO_LAUNCH_STARTS.map(([label, start]) => [form, label, build, start] as const)))(
    'a pending %s whose launch start is %s satisfies it',
    (_form, _label, build, start) => {
      expect(isPendingWithNoLaunchStart(build({ state: 'pending', launch_started_at: start }))).toBe(true)
    },
  )

  test.each(ROW_FORMS.flatMap(([form, build]) => VALID_LAUNCH_STARTS.map(([label, start]) => [form, label, build, start] as const)))(
    'a pending %s with the %s launch start does not',
    (_form, _label, build, start) => {
      expect(isPendingWithNoLaunchStart(build({ state: 'pending', launch_started_at: start }))).toBe(false)
    },
  )

  test.each(
    OTHER_STATES.flatMap((state) =>
      [...NO_LAUNCH_STARTS, ...VALID_LAUNCH_STARTS].map(([label, start]) => [state, label, start] as const),
    ),
  )('a %s row whose launch start is %s does not', (state, _label, start) => {
    expect(isPendingWithNoLaunchStart(cannedStatusResult({ state, launch_started_at: start }))).toBe(false)
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
  ])('no row (%s) does not', (_label, row) => {
    expect(isPendingWithNoLaunchStart(row)).toBe(false)
  })
})
