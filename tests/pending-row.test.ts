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
 * The stub's sample forms (fractional, whole, none), a numeric offset and a
 * fraction longer than milliseconds read the same from a `status` result, a
 * `get` row and a `list` row.
 *
 * Ageing (b.jg5 SRJ-406, SRJ-408; AC 30, AC 80), with G from the E6 accessor
 * (`adGraceMsInEffect`), never a literal: `isPendingRowAged` is false one
 * tick before launch start + G and true at it, for a fixed wait and for the
 * accessor, in both forms (a fractional and a whole launch start naming the
 * same instant age identically), and never from `started_at`; a launch start
 * of none is never aged, even with a wait of 0; `AD_WAIT_NEVER_ENDS`, NaN
 * and a throwing accessor are never aged. `armPendingRowWait` on
 * `createFakeClock`, on a resumed row whose `started_at` is older than G and
 * whose launch start is the arm time: fires once at launch start + G and not
 * one tick earlier, in both forms; a launch start of none answers
 * `PENDING_ROW_WAIT_NOT_ARMED`, leaves no timer and throws nothing; G raised
 * while armed (a settings file rewritten under a temp HOME and read by the
 * installed reader) is honoured; a G beyond `MAX_TIMER_DELAY_MS` does not
 * fire after 1 ms and fires at its deadline (E28's one case beyond the timer
 * maximum, E6's hatch note); `AD_WAIT_NEVER_ENDS`, fixed or from the
 * accessor, never fires; cancel stops it; a NaN wait still throws
 * `RangeError` and arms nothing. `afterEach` asserts the case's clock has no
 * pending timer and passes the settings reader's log lines to `assertNoLeak`.
 *
 * SRJ-408's own-row leg: a configured persona's own `pending` row with no
 * launch start (each form; P's current life, the covered shape, and a row
 * whose `cwd` is not P's, from `LAUNCH_START_CASE_ROWS`; each read shape)
 * gets E16's "launch start not recorded" decision (`decideOwnRowRead`) and
 * is never aged or armed. The old-key leg is `tests/old-life-wait.test.ts`'s.
 *
 * Whether a `pending` row is covered (b.jg5 SRJ-409, SRJ-411, SRJ-408,
 * SRJ-513; AC 30, AC 33, AC 35): a table over `decidePendingRowCover`, its
 * answers and reasons the exported ones: P's own current life is covered; a
 * retired key's row before its mark is not (its old life), after its mark it
 * is; a `cwd` or `config_dir` mismatch is not; an unresolved directory is
 * undecided; a configured persona's own row with no launch start answers "no
 * launch start" in every shape, never covered; the order of the checks, the
 * same at every site except that a status-only site decides an unresolved
 * directory before a `cwd` that resolves elsewhere (the ladder, the other
 * way round). Then
 * the session manager's read-and-step entry (`readAndStepPendingRow`) on
 * `makeRecoveryHarness` (`session_restart_delay` and `health_check_interval`
 * 0), after one `get`: a covered row (the key not recorded, recorded and
 * marked, or its mark held in memory after a failed write) and an undecided
 * one (its `claude_config_dir` unresolvable, or its working directory with no
 * real path whatever the row's `cwd`: one with no real path, P's configured
 * path lexically, or an existing directory elsewhere; the comparison these
 * status-only sites read is `pendingRowComparisonFor`'s, a pure table) arm P's
 * retry timer in pending-only mode with the controller's own armed line, with
 * no kill, launch, approver or sequence; a row that is not covered logs its
 * line and makes exactly one start request (step 1, the conversation not
 * kept, context `recovery`, the retired-key flag for an old life), with no
 * arm and no approver; P's own row with no launch start latches P and arms
 * nothing. Where the step is called from (the deferral, the pending-only
 * retry, the ladder) is tests/server.test.ts's,
 * tests/unavailable-retry.test.ts's and tests/session-manager.test.ts's.
 *
 * The stuck-launch post (b.jg5 SRJ-1017, SRJ-1016, SRJ-1001; AC 67). One pin
 * case holds SRJ-1017's texts literally (the file's only literal text): the
 * relaunching text at the default settings (B 5 minutes) and with
 * `pending_grace_seconds` 300 (6 minutes), and the held text with and
 * without the attach line. Every other case builds its expectation from
 * `src/`'s exports: B as `wholeMinutes(adLaunchBoundMsInEffect())`, rounded
 * down (a B that is not whole minutes); the session through
 * `quotedPersonaSessionName`, keys that prefix one another kept apart; the
 * held text's lines from the exported pieces, the flagged form with the
 * clause after the launch start and no attach line, the unflagged one with
 * all three remedies and the human-only line; the launch start through the
 * one renderer (`describeLaunchStartForLog`): an ISO 8601 UTC timestamp
 * ending in `Z`, one string for the stub's two sample forms, a numeric
 * offset and the parsed number of one instant, and never the raw text.
 * SRJ-1001: neither text in any form matches a session-ending command form
 * (`SESSION_ENDING_COMMAND_FORMS`), no line names anything of
 * `CSCB_OWN_LINE_FORBIDDEN` (kill-pane, set-option, agent-director delete,
 * clear-latch, has-session, a label option), every tmux target is exact
 * (`=`), and no text says "dispatcher bug" (SRJ-713). The posters over a real
 * `createPersonaEpisodes` on `createFakeClock`: each text once per
 * episode (both held forms share one mark), the other text still once; a
 * new episode after `endStuckLaunchEpisode` posts each again; nothing posted
 * and no episode begun while the injected `tmux-unavailable` query answers
 * raised or throws; `closed` after `close()`; a submitted teardown mutes the
 * post, which still counts; an episodes call that throws answers
 * suppressed; two personas are independent; one line per call, from the
 * exported line builders. The episode-end predicate's table. `assertNoLeak`
 * over every text and line, with a key carrying a fake token (masked by
 * `withoutName`), a raw launch start carrying one, and thrown values
 * carrying the leak marker. Where the episode ends at the session manager's
 * reads and at a latch is tests/session-manager.test.ts's and
 * tests/conflict-latch.test.ts's.
 *
 * E29 (the pending-row rule) extends this file.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AD_SETTING_INTEGER_MAX,
  AD_WAIT_NEVER_ENDS,
  adGraceMsInEffect,
  adLaunchBoundMsInEffect,
  DEFAULT_AD_SETTINGS,
  installAdSettings,
  resetAdSettingsForTests,
  wholeMinutes,
  type AdSettingsReader,
} from '../src/ad-settings.ts'
import {
  armPendingRowWait,
  decidePendingRowCover,
  describeLaunchStartForLog,
  endStuckLaunchEpisode,
  isPendingRowAged,
  isStuckLaunchEpisodeEndState,
  postStuckLaunchHeld,
  postStuckLaunchRelaunching,
  STUCK_LAUNCH_ALREADY_POSTED,
  STUCK_LAUNCH_END_LAUNCH_REMEDY_LINE,
  STUCK_LAUNCH_HELD_HEAD,
  STUCK_LAUNCH_HUMAN_ONLY_LINE,
  STUCK_LAUNCH_MARK_HELD,
  STUCK_LAUNCH_MARK_RELAUNCHING,
  STUCK_LAUNCH_NOT_POSTED_CLOSED,
  STUCK_LAUNCH_NOT_STARTED_BY_CSCB_CLAUSE,
  STUCK_LAUNCH_POSTED,
  STUCK_LAUNCH_RELAUNCHING_HEAD,
  STUCK_LAUNCH_SUPPRESSED,
  stuckLaunchAttachRemedyLine,
  stuckLaunchEndRowLiveReason,
  stuckLaunchEpisodeEndedLine,
  stuckLaunchHeldText,
  stuckLaunchListRemedyLine,
  stuckLaunchOutageQueryFailedLine,
  stuckLaunchPostFailedLine,
  stuckLaunchPostLine,
  stuckLaunchRelaunchingText,
  type StuckLaunchPostAnswer,
  type StuckLaunchPostEpisodes,
  type StuckLaunchPosterDeps,
  type StuckLaunchTextMark,
  isPendingWithNoLaunchStart,
  parseLaunchStart,
  PENDING_ROW_COVERED,
  PENDING_ROW_NO_LAUNCH_START,
  PENDING_ROW_NOT_COVERED,
  PENDING_ROW_REASON_CONFIG_DIR_MISMATCH,
  PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED,
  PENDING_ROW_REASON_CWD_MISMATCH,
  PENDING_ROW_REASON_CWD_UNRESOLVED,
  PENDING_ROW_REASON_RETIRED_OLD_LIFE,
  PENDING_ROW_UNDECIDED,
  PENDING_ROW_WAIT_NOT_ARMED,
  type PendingRowComparison,
  type PendingRowCover,
  type PendingRowCoverInput,
  type PendingRowFields,
  type PendingRowNotCoveredReason,
  type PendingRowUndecidedReason,
  type PendingRowWaitArmed,
} from '../src/pending-row.ts'
import { AGENT_DIRECTOR_DEAD_STATES, AGENT_DIRECTOR_LIVE_STATES, AGENT_DIRECTOR_PENDING_STATE } from '../src/liveness-reading.ts'
import { KILL_FAILURE_CONTEXT_RECOVERY } from '../src/kill-failure-alert.ts'
import { LIVE_ROW_SEQUENCE_ENTRY_KILL, LIVE_ROW_START_STARTED, type LiveRowSequenceRequest } from '../src/live-row-sequence.ts'
import {
  CONFIG_DIR_LABEL_PREFIX,
  personaInstanceId,
  personaTmuxSessionName,
  quotedPersonaSessionName,
  renderPersonaRef,
  tmuxExactSessionTarget,
} from '../src/persona-identity.ts'
import { createPersonaEpisodes, PERSONA_EPISODE_KIND_STUCK_LAUNCH, type PersonaEpisodes } from '../src/persona-episodes.ts'
import type { PersonaTeardownWindowState } from '../src/persona-notifier.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import {
  _resetConfigDirFs,
  _setConfigDirFs,
  PENDING_ROW_STEP_LATCHED,
  pendingRowComparisonFor,
  readAndStepPendingRow,
  type RowPersonaComparison,
  uncoveredPendingRowLine,
  undecidedPendingRowLine,
} from '../src/session-manager.ts'
import { UNAVAILABLE_RETRY_CAUSE_PENDING_ROW } from '../src/unavailable-retry.ts'
import { MAX_TIMER_DELAY_MS } from '../src/persona-retry-schedule.ts'
import { decideOwnRowRead, ROW_READ_LAUNCH_START_NOT_RECORDED } from '../src/row-read-rules.ts'
import {
  cannedGetResult,
  cannedListRow,
  cannedStatusResult,
  SAMPLE_LAUNCH_START_FRACTIONAL,
  SAMPLE_LAUNCH_START_WHOLE,
  SAMPLE_LAUNCH_STARTS,
  type CannedRowPersona,
  type PersonaGetResultOverrides,
} from './test-helpers/agent-director-stub.ts'
import { writeAgentDirectorConfig, type AdConfigTables } from './test-helpers/ad-settings.ts'
import {
  CSCB_OWN_LINE_FORBIDDEN,
  cscbOwnLineForbiddenIn,
  LAUNCH_START_CASE_ROWS,
  SESSION_ENDING_COMMAND_FORMS,
  sessionEndingCommandsIn,
} from './test-helpers/conflict-cases.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, sentinelInMessage, withoutName } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import {
  expectPendingOnlyWatch,
  makeRecoveryHarness,
  personaOf,
  personaRow,
  recordSequenceStarts,
  type RecoveryHarness,
} from './test-helpers/recovery-harness.ts'

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

// ---------------------------------------------------------------------------
// parseLaunchStart over the stub's rows (SRJ-406, SRJ-1303)
// ---------------------------------------------------------------------------

/**
 * Launch starts as a row carries them, with the instant each names: the
 * stub's sample forms (SRJ-1303: with fractional seconds, without, none), a
 * numeric offset and a fraction longer than milliseconds.
 */
const ROW_LAUNCH_STARTS: ReadonlyArray<readonly [string, string | undefined, number | undefined]> = [
  ['fractional', SAMPLE_LAUNCH_STARTS.fractional, Date.parse(SAMPLE_LAUNCH_START_FRACTIONAL)],
  ['whole', SAMPLE_LAUNCH_STARTS.whole, WHOLE_INSTANT],
  ['none', SAMPLE_LAUNCH_STARTS.none, undefined],
  ['numeric-offset', wholeWith('-08:00'), WHOLE_INSTANT + 8 * 60 * MINUTE_MS],
  ['9-digit-fraction', wholeWith('.123456789Z'), WHOLE_INSTANT + 123],
]

describe('parseLaunchStart: a launch start reads the same from a status result, a get row and a list row', () => {
  test.each(
    ROW_FORMS.flatMap(([form, build]) => ROW_LAUNCH_STARTS.map(([label, raw, instant]) => [form, label, build, raw, instant] as const)),
  )('a pending %s with the %s launch start', (_form, _label, build, raw, instant) => {
    expect(parseLaunchStart(build({ state: 'pending', launch_started_at: raw }).launch_started_at)).toBe(instant)
  })
})

// ---------------------------------------------------------------------------
// A `pending` row's ageing (SRJ-406, SRJ-408; AC 30, AC 80)
// ---------------------------------------------------------------------------

/** The clock of the case, if it made one; `afterEach` asserts it has no timer left. */
let caseClock: FakeClock | undefined
/** The temp HOME the case's agent-director settings are written under, once it installs the reader. */
let settingsHome: string | undefined
/** The settings reader's log lines. */
let settingsLines: string[] = []
/** The directory the own-row leg's persona rows are built against (nothing is written there). */
let rowsHome: string | undefined

afterEach(() => {
  const pendingTimers = caseClock?.pending() ?? []
  const lines = settingsLines
  caseClock = undefined
  settingsLines = []
  try {
    expect(pendingTimers).toEqual([])
    expect(lines).toEqual([])
    assertNoLeak(lines)
  } finally {
    resetAdSettingsForTests()
    for (const dir of [settingsHome, rowsHome]) if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    settingsHome = undefined
    rowsHome = undefined
  }
})

/** A fake clock starting at `startMs`, checked in `afterEach`. */
function clockAt(startMs: number): FakeClock {
  caseClock = createFakeClock({ start: startMs })
  return caseClock
}

/**
 * Install the settings reader over a temp HOME, with agent-director's
 * settings file written there first when `tables` is given. `afterEach`
 * resets the reader and removes the HOME.
 */
function installSettings(tables?: AdConfigTables): AdSettingsReader {
  settingsHome ??= mkdtempSync(join(tmpdir(), 'cscb-pending-row-home-'))
  const home = settingsHome
  if (tables !== undefined) writeAgentDirectorConfig(home, tables)
  return installAdSettings({
    home: () => home,
    log: (line) => {
      settingsLines.push(line)
    },
  })
}

/** Milliseconds per second, to write a G from a wait in milliseconds. */
const MS_PER_SECOND = 1000

/** Twice agent-director's default G. */
const G_DOUBLED: AdConfigTables = { tmux: { pending_grace_seconds: DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds * 2n } }

/**
 * A resumed launch's `pending` `get` row: launch start `raw`, and a
 * `started_at` at `startedAtMs`, the original spawn's time, which no wait
 * may read (SRJ-406).
 */
function resumedRow(raw: string, startedAtMs: number): ReturnType<typeof cannedGetResult> {
  return cannedGetResult({
    claude_instance_id: 'cscb_alpha',
    state: 'pending',
    launch_started_at: raw,
    started_at: new Date(startedAtMs).toISOString(),
  })
}

/** Both forms of G a check or an arm takes: the E6 accessor itself, and its value read as a number. */
const GRACE_WAITS: ReadonlyArray<readonly [string, () => number | (() => number)]> = [
  ['the G accessor', () => adGraceMsInEffect],
  ['G as a number', () => adGraceMsInEffect()],
]

/** Launch starts that are none: {@link NO_LAUNCH_STARTS} and a value that is not a string. */
const NONE_LAUNCH_STARTS: ReadonlyArray<readonly [string, unknown]> = [
  ...NO_LAUNCH_STARTS,
  ['a number (the sample\'s epoch ms)', WHOLE_INSTANT],
]

describe('isPendingRowAged: measured from the launch start, never from started_at', () => {
  test.each(VALID_LAUNCH_STARTS.flatMap(([form, raw]) => GRACE_WAITS.map(([wait, waitOf]) => [form, wait, raw, waitOf] as const)))(
    '%s launch start, %s, on a resumed row whose started_at is older than G: not aged one tick before launch start + G, aged at it',
    (_form, _wait, raw, waitOf) => {
      const graceMs = adGraceMsInEffect()
      const launchStartMs = parseLaunchStart(raw)!
      const row = resumedRow(raw, launchStartMs - 2 * graceMs)
      const oneTickBefore = launchStartMs + graceMs - 1
      // Measured from started_at, the row would already be aged.
      expect(Date.parse(row.started_at!) + graceMs).toBeLessThan(oneTickBefore)

      expect(isPendingRowAged(row.launch_started_at, waitOf(), oneTickBefore)).toBe(false)
      expect(isPendingRowAged(row.launch_started_at, waitOf(), launchStartMs + graceMs)).toBe(true)
    },
  )

  test.each([-1, 0])('a fractional and a whole launch start naming the same instant age identically (G %p ms from it)', (offsetMs) => {
    const fractional = wholeWith('.000Z')
    expect(parseLaunchStart(fractional)).toBe(parseLaunchStart(SAMPLE_LAUNCH_START_WHOLE))
    const nowMs = WHOLE_INSTANT + adGraceMsInEffect() + offsetMs
    expect(isPendingRowAged(fractional, adGraceMsInEffect, nowMs)).toBe(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect, nowMs))
    expect(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect, nowMs)).toBe(offsetMs === 0)
  })

  test.each(NONE_LAUNCH_STARTS.flatMap(([label, raw]) => [0, adGraceMsInEffect()].map((waitMs) => [label, waitMs, raw] as const)))(
    'a launch start %s is never aged, even with a wait of %p ms',
    (_label, waitMs, raw) => {
      expect(isPendingRowAged(raw, waitMs, Number.MAX_SAFE_INTEGER)).toBe(false)
    },
  )

  test.each([
    ['AD_WAIT_NEVER_ENDS', AD_WAIT_NEVER_ENDS],
    ['an accessor at AD_WAIT_NEVER_ENDS', () => AD_WAIT_NEVER_ENDS],
    ['NaN', Number.NaN],
    ['an accessor answering NaN', () => Number.NaN],
    [
      'an accessor that throws',
      () => {
        throw new Error('unreadable wait')
      },
    ],
  ])('a wait of %s is never aged and throws nothing', (_label, waitMs) => {
    expect(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, waitMs, Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  test('the accessor is read at the call: a G raised after one check moves the next one', () => {
    const reader = installSettings()
    const oldGraceMs = adGraceMsInEffect()
    expect(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect, WHOLE_INSTANT + oldGraceMs)).toBe(true)

    writeAgentDirectorConfig(settingsHome!, G_DOUBLED)
    reader.read()
    const newGraceMs = adGraceMsInEffect()
    expect(newGraceMs).toBe(2 * oldGraceMs)

    expect(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect, WHOLE_INSTANT + oldGraceMs)).toBe(false)
    expect(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect, WHOLE_INSTANT + newGraceMs - 1)).toBe(false)
    expect(isPendingRowAged(SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect, WHOLE_INSTANT + newGraceMs)).toBe(true)
  })
})

describe('armPendingRowWait: never early, from the launch start, on createFakeClock', () => {
  /** Arm on `clock` with `waitMs`, recording each callback's time in the answer's `fired`. */
  function arm(clock: FakeClock, raw: unknown, waitMs: number | (() => number)) {
    const fired: number[] = []
    const armed = armPendingRowWait(clock, raw, waitMs, () => {
      fired.push(clock.now())
    })
    return { armed, fired }
  }

  /** The handle of an armed wait; fails the case for `PENDING_ROW_WAIT_NOT_ARMED`. */
  function handleOf(armed: ReturnType<typeof armPendingRowWait>): PendingRowWaitArmed {
    if (armed === PENDING_ROW_WAIT_NOT_ARMED) throw new Error('the wait was not armed')
    return armed
  }

  test.each(VALID_LAUNCH_STARTS)(
    '%s launch start, on a resumed row whose started_at is older than G, armed at the launch start with the G accessor: fires once at launch start + G, not one tick earlier',
    async (_form, raw) => {
      const graceMs = adGraceMsInEffect()
      const launchStartMs = parseLaunchStart(raw)!
      const row = resumedRow(raw, launchStartMs - 2 * graceMs)
      const clock = clockAt(launchStartMs)
      const { armed, fired } = arm(clock, row.launch_started_at, adGraceMsInEffect)
      expect(handleOf(armed).launchStartMs).toBe(launchStartMs)

      await clock.advanceTo(launchStartMs + graceMs - 1)
      expect(fired).toEqual([])
      await clock.advance(1)
      expect(fired).toEqual([launchStartMs + graceMs])
      expect(clock.pendingCount()).toBe(0)
    },
  )

  test.each(NONE_LAUNCH_STARTS)('a launch start %s: answers "not armed", arms no timer, throws nothing and never fires', async (_label, raw) => {
    const graceMs = adGraceMsInEffect()
    const clock = clockAt(WHOLE_INSTANT)
    const { armed, fired } = arm(clock, raw, adGraceMsInEffect)

    expect(armed).toBe(PENDING_ROW_WAIT_NOT_ARMED)
    expect(clock.pendingCount()).toBe(0)
    await clock.advance(2 * graceMs)
    expect(fired).toEqual([])
  })

  test('G raised while armed: no fire at the old deadline, once at the new one', async () => {
    const reader = installSettings()
    const oldGraceMs = adGraceMsInEffect()
    const launchStartMs = parseLaunchStart(SAMPLE_LAUNCH_START_FRACTIONAL)!
    const clock = clockAt(launchStartMs)
    const { fired } = arm(clock, SAMPLE_LAUNCH_START_FRACTIONAL, adGraceMsInEffect)
    await clock.advanceTo(launchStartMs + oldGraceMs - 1)

    writeAgentDirectorConfig(settingsHome!, G_DOUBLED)
    reader.read()
    const newGraceMs = adGraceMsInEffect()
    expect(newGraceMs).toBe(2 * oldGraceMs)

    await clock.advanceTo(launchStartMs + newGraceMs - 1)
    expect(fired).toEqual([])
    await clock.advance(1)
    expect(fired).toEqual([launchStartMs + newGraceMs])
  })

  test('a G beyond the timer maximum (the one such case here, E6): no fire after 1 ms, one timer at a time none asking more than the maximum, and one fire exactly at launch start + G', async () => {
    installSettings({ tmux: { pending_grace_seconds: BigInt(Math.ceil(MAX_TIMER_DELAY_MS / MS_PER_SECOND)) } })
    const graceMs = adGraceMsInEffect()
    expect(graceMs).toBeGreaterThan(MAX_TIMER_DELAY_MS)
    const launchStartMs = parseLaunchStart(SAMPLE_LAUNCH_START_WHOLE)!
    const clock = clockAt(launchStartMs)
    const { fired } = arm(clock, SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect)

    await clock.advance(1)
    expect(fired).toEqual([])
    for (let step = 0; fired.length === 0; step++) {
      expect(step).toBeLessThan(5)
      expect(clock.pendingCount()).toBe(1)
      expect(clock.pending()[0]!.delayMs).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
      await clock.runNext()
    }
    expect(fired).toEqual([launchStartMs + graceMs])
  })

  test('a fixed wait of AD_WAIT_NEVER_ENDS arms no timer and never fires', async () => {
    const clock = clockAt(WHOLE_INSTANT)
    const { armed, fired } = arm(clock, SAMPLE_LAUNCH_START_WHOLE, AD_WAIT_NEVER_ENDS)

    expect(clock.pendingCount()).toBe(0)
    await clock.advance(2 * MAX_TIMER_DELAY_MS)
    expect(fired).toEqual([])
    handleOf(armed).cancel()
  })

  test('the G accessor at AD_WAIT_NEVER_ENDS keeps one timer of the maximum pending and never fires; cancel leaves none', async () => {
    installSettings({ tmux: { pending_grace_seconds: AD_SETTING_INTEGER_MAX } })
    expect(adGraceMsInEffect()).toBe(AD_WAIT_NEVER_ENDS)
    const clock = clockAt(WHOLE_INSTANT)
    const { armed, fired } = arm(clock, SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect)

    for (let step = 0; step < 3; step++) {
      expect(clock.pending().map((timer) => timer.delayMs)).toEqual([MAX_TIMER_DELAY_MS])
      await clock.runNext()
    }
    expect(fired).toEqual([])
    handleOf(armed).cancel()
    expect(clock.pendingCount()).toBe(0)
  })

  test('cancel before the deadline: no timer is left and it never fires; a second cancel does nothing', async () => {
    const graceMs = adGraceMsInEffect()
    const clock = clockAt(WHOLE_INSTANT)
    const { armed, fired } = arm(clock, SAMPLE_LAUNCH_START_WHOLE, adGraceMsInEffect)
    await clock.advanceTo(WHOLE_INSTANT + graceMs - 1)

    const { cancel } = handleOf(armed)
    cancel()
    expect(clock.pendingCount()).toBe(0)
    cancel()
    await clock.advance(graceMs)
    expect(fired).toEqual([])
  })

  test('a NaN wait with a launch start throws RangeError and arms nothing', () => {
    const clock = clockAt(WHOLE_INSTANT)
    expect(() => arm(clock, SAMPLE_LAUNCH_START_WHOLE, Number.NaN)).toThrow(RangeError)
    expect(clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// SRJ-408's own-row leg: a configured persona's own row with no launch start
// ---------------------------------------------------------------------------

describe('a configured persona\'s own pending row with no launch start latches through E16\'s decision and is never aged or armed (SRJ-408, SRJ-513)', () => {
  /** P's own rows: its current life (the covered shape) and a row whose cwd is not P's, each read shape and form. */
  const OWN_ROWS = LAUNCH_START_CASE_ROWS.filter((row) => row.variant === 'current life' || row.variant === 'other cwd').map(
    (row) => [row.name, row] as const,
  )

  /** Persona P, its directories under the case's rows home (not created). */
  function personaP(): { persona: CannedRowPersona; home: string } {
    rowsHome ??= mkdtempSync(join(tmpdir(), 'cscb-pending-row-rows-'))
    const home = rowsHome
    return { persona: { key: 'alpha', working_directory: join(home, 'alpha', 'work'), claude_config_dir: join(home, 'alpha', 'claude') }, home }
  }

  test.each(OWN_ROWS)('%s', async (_name, row) => {
    const { persona, home } = personaP()
    expect(decideOwnRowRead(row.decisionInput(persona, home))).toEqual(ROW_READ_LAUNCH_START_NOT_RECORDED)

    const raw = row.build(persona, home).launch_started_at
    expect(isPendingRowAged(raw, 0, Number.MAX_SAFE_INTEGER)).toBe(false)
    const clock = clockAt(WHOLE_INSTANT)
    let fired = 0
    expect(armPendingRowWait(clock, raw, adGraceMsInEffect, () => fired++)).toBe(PENDING_ROW_WAIT_NOT_ARMED)
    expect(clock.pendingCount()).toBe(0)
    await clock.advance(2 * adGraceMsInEffect())
    expect(fired).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Whether a `pending` row is covered (b.jg5 SRJ-409, SRJ-411, SRJ-408, SRJ-513)
// ---------------------------------------------------------------------------

/** A row comparison that matches P: `cwd` and `config_dir` label both P's, both directories resolved. */
const MATCHING: PendingRowComparison = { cwdMatches: true, cwdCheckDeferred: false, configDirResolved: true, configDirMatches: true }
/** The comparison of a row whose `cwd` resolves elsewhere. */
const CWD_ELSEWHERE: Partial<PendingRowComparison> = { cwdMatches: false }
/** The comparison when neither P's working directory nor the row's `cwd` resolves now (b.av2 SR-6.4). */
const CWD_UNRESOLVED: Partial<PendingRowComparison> = { cwdMatches: false, cwdCheckDeferred: true }
/** The comparison when P's `claude_config_dir` does not resolve (b.g57): no label verdict. */
const CONFIG_DIR_UNRESOLVED: Partial<PendingRowComparison> = { configDirResolved: false, configDirMatches: undefined }
/** The comparison of a row whose `config_dir` label is missing or differs. */
const CONFIG_DIR_ELSEWHERE: Partial<PendingRowComparison> = { configDirMatches: false }

/** The retired-key store's readings of a key. */
const NOT_RECORDED = { recorded: false, marked: false } as const
const RECORDED_UNMARKED = { recorded: true, marked: false } as const
const RECORDED_MARKED = { recorded: true, marked: true } as const

/**
 * The cover input for a `pending` `get` row with `launch` (the stub's
 * default sample unless given; `undefined` leaves it out), a configured
 * persona's own unless `ownConfigured` is false, the key not recorded and the
 * row matching P unless `retired` or `comparison` says otherwise; the site
 * flag `statusOnlySite` is left out unless given.
 */
function coverInput(
  options: {
    launch?: string | null | undefined
    ownConfigured?: boolean
    retired?: PendingRowCoverInput['retired']
    comparison?: Partial<PendingRowComparison>
    statusOnlySite?: boolean
  } = {},
): PendingRowCoverInput {
  const launch = 'launch' in options ? options.launch : SAMPLE_LAUNCH_START_WHOLE
  const [, getRow] = ROW_FORMS.find(([form]) => form === 'get row')!
  return {
    row: getRow({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: launch }),
    ownConfigured: options.ownConfigured ?? true,
    retired: options.retired ?? NOT_RECORDED,
    comparison: { ...MATCHING, ...options.comparison },
    ...(options.statusOnlySite === undefined ? {} : { statusOnlySite: options.statusOnlySite }),
  }
}

const COVERED: PendingRowCover = { answer: PENDING_ROW_COVERED }
const NO_LAUNCH_START: PendingRowCover = { answer: PENDING_ROW_NO_LAUNCH_START }
const notCovered = (reason: PendingRowNotCoveredReason): PendingRowCover => ({ answer: PENDING_ROW_NOT_COVERED, reason })
const undecided = (reason: PendingRowUndecidedReason): PendingRowCover => ({ answer: PENDING_ROW_UNDECIDED, reason })

/** `coverInput`'s options, without the site flag the tables set themselves. */
type CoverOptions = Omit<NonNullable<Parameters<typeof coverInput>[0]>, 'statusOnlySite'>

/** The site flag as each kind of site passes it: the collision ladder (absent or false) and a status-only site (true). */
const SITES: ReadonlyArray<readonly [string, boolean | undefined]> = [
  ['the ladder (no site flag)', undefined],
  ['the ladder (site flag false)', false],
  ['a status-only site', true],
]

describe('decidePendingRowCover: whether a pending row is P\'s current life (SRJ-409, SRJ-411), never for an own row with no launch start (SRJ-408, SRJ-513)', () => {
  // None of these inputs pairs a cwd that resolves elsewhere with a directory
  // that does not resolve, so every site answers the same (the site's order
  // is the table below).
  const COVER_CASES: ReadonlyArray<readonly [string, CoverOptions, PendingRowCover]> = [
    ['P\'s own current life, cwd and config_dir matching (whole launch start)', {}, COVERED],
    ['P\'s own current life, its launch start with fractional seconds', { launch: SAMPLE_LAUNCH_START_FRACTIONAL }, COVERED],
    ['a recorded key with no mark: its old life', { retired: RECORDED_UNMARKED }, notCovered(PENDING_ROW_REASON_RETIRED_OLD_LIFE)],
    ['a recorded key after its mark (written, or held in memory after a failed write)', { retired: RECORDED_MARKED }, COVERED],
    ['a cwd that resolves elsewhere', { comparison: CWD_ELSEWHERE }, notCovered(PENDING_ROW_REASON_CWD_MISMATCH)],
    ['a config_dir label missing or different', { comparison: CONFIG_DIR_ELSEWHERE }, notCovered(PENDING_ROW_REASON_CONFIG_DIR_MISMATCH)],
    ['a working directory and row cwd that do not resolve now', { comparison: CWD_UNRESOLVED }, undecided(PENDING_ROW_REASON_CWD_UNRESOLVED)],
    ['a claude_config_dir that does not resolve now', { comparison: CONFIG_DIR_UNRESOLVED }, undecided(PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED)],
    // The order: the directories first, then the retired key, then the label.
    ['a cwd elsewhere on a recorded key with no mark: the cwd decides', { retired: RECORDED_UNMARKED, comparison: CWD_ELSEWHERE }, notCovered(PENDING_ROW_REASON_CWD_MISMATCH)],
    ['an unresolved cwd on a recorded key with no mark: undecided', { retired: RECORDED_UNMARKED, comparison: CWD_UNRESOLVED }, undecided(PENDING_ROW_REASON_CWD_UNRESOLVED)],
    ['an unresolved claude_config_dir on a recorded key with no mark: undecided', { retired: RECORDED_UNMARKED, comparison: CONFIG_DIR_UNRESOLVED }, undecided(PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED)],
    ['a config_dir label elsewhere on a recorded key with no mark: the old life decides', { retired: RECORDED_UNMARKED, comparison: CONFIG_DIR_ELSEWHERE }, notCovered(PENDING_ROW_REASON_RETIRED_OLD_LIFE)],
    ['a config_dir label elsewhere on a marked key', { retired: RECORDED_MARKED, comparison: CONFIG_DIR_ELSEWHERE }, notCovered(PENDING_ROW_REASON_CONFIG_DIR_MISMATCH)],
    ['a cwd and a config_dir label both elsewhere: the cwd decides', { comparison: { ...CWD_ELSEWHERE, ...CONFIG_DIR_ELSEWHERE } }, notCovered(PENDING_ROW_REASON_CWD_MISMATCH)],
    // Not a configured persona's own row: it latches nothing, so its fields decide.
    ['a row with no launch start that is no configured persona\'s own, matching', { launch: SAMPLE_LAUNCH_STARTS.none, ownConfigured: false }, COVERED],
  ]
  test.each(COVER_CASES.flatMap(([label, options, expected]) => SITES.map(([site, flag]) => [label, site, options, flag, expected] as const)))(
    '%s, at %s',
    (_label, _site, options, statusOnlySite, expected) => {
      expect(decidePendingRowCover(coverInput({ ...options, statusOnlySite }))).toEqual(expected)
    },
  )

  // SRJ-409 (ruling R8): at a status-only site a directory that cannot be
  // resolved leaves the row undecided before any mismatch is checked; the
  // ladder keeps its order, a cwd that resolves elsewhere first.
  const CONFIG_DIR_UNDECIDED = undecided(PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED)
  test.each<[string, CoverOptions, PendingRowCover, PendingRowCover]>([
    // [label, options, the ladder's answer, a status-only site's answer]
    ['a cwd elsewhere, P\'s claude_config_dir unresolvable', { comparison: { ...CWD_ELSEWHERE, ...CONFIG_DIR_UNRESOLVED } }, notCovered(PENDING_ROW_REASON_CWD_MISMATCH), CONFIG_DIR_UNDECIDED],
    [
      'a cwd elsewhere, P\'s claude_config_dir unresolvable, on a recorded key with no mark',
      { retired: RECORDED_UNMARKED, comparison: { ...CWD_ELSEWHERE, ...CONFIG_DIR_UNRESOLVED } },
      notCovered(PENDING_ROW_REASON_CWD_MISMATCH),
      CONFIG_DIR_UNDECIDED,
    ],
    // Both directories unresolved: the cwd is decided first at every site.
    ['an unresolved cwd and claude_config_dir', { comparison: { ...CWD_UNRESOLVED, ...CONFIG_DIR_UNRESOLVED } }, undecided(PENDING_ROW_REASON_CWD_UNRESOLVED), undecided(PENDING_ROW_REASON_CWD_UNRESOLVED)],
    // The own row with no launch start still answers first.
    ['P\'s own row with no launch start, a cwd elsewhere, P\'s claude_config_dir unresolvable', { launch: SAMPLE_LAUNCH_STARTS.none, comparison: { ...CWD_ELSEWHERE, ...CONFIG_DIR_UNRESOLVED } }, NO_LAUNCH_START, NO_LAUNCH_START],
  ])('the site\'s order: %s → the ladder\'s answer at the ladder, the status-only answer at a status-only site', (_label, options, ladder, statusOnly) => {
    expect(decidePendingRowCover(coverInput(options))).toEqual(ladder)
    expect(decidePendingRowCover(coverInput({ ...options, statusOnlySite: false }))).toEqual(ladder)
    expect(decidePendingRowCover(coverInput({ ...options, statusOnlySite: true }))).toEqual(statusOnly)
  })

  // SRJ-408, SRJ-513 (the E16 hatch note): every shape, covered or not, answers "no launch start".
  const NO_LAUNCH_START_SHAPES: ReadonlyArray<readonly [string, Parameters<typeof coverInput>[0]]> = [
    ['P\'s current life (the covered shape)', {}],
    ['a recorded key after its mark', { retired: RECORDED_MARKED }],
    ['a recorded key with no mark', { retired: RECORDED_UNMARKED }],
    ['a cwd elsewhere', { comparison: CWD_ELSEWHERE }],
    ['a config_dir label elsewhere', { comparison: CONFIG_DIR_ELSEWHERE }],
    ['an unresolved cwd', { comparison: CWD_UNRESOLVED }],
    ['an unresolved claude_config_dir', { comparison: CONFIG_DIR_UNRESOLVED }],
  ]
  test.each(NO_LAUNCH_START_SHAPES.flatMap(([shape, options]) => NO_LAUNCH_STARTS.map(([form, launch]) => [shape, form, options, launch] as const)))(
    'a configured persona\'s own row with no launch start, %s, its launch start %s: no launch start, never covered',
    (_shape, _form, options, launch) => {
      expect(decidePendingRowCover(coverInput({ ...options, launch }))).toEqual(NO_LAUNCH_START)
    },
  )
})

// ---------------------------------------------------------------------------
// The status-only sites' comparison (b.jg5 SRJ-411, hatch A3; b.av2 SR-6.4)
// ---------------------------------------------------------------------------

/** A row comparison as `compareRowToPersona` answers it: both directories resolved and the row matching P, unless `overrides` says otherwise. */
function rowComparison(overrides: Partial<RowPersonaComparison> = {}): RowPersonaComparison {
  return {
    ...MATCHING,
    workingDirectoryResolved: true,
    configDirLabel: 'the label',
    expectedConfigDirLabel: 'the label',
    ...overrides,
  }
}

describe('pendingRowComparisonFor: a working directory with no real path leaves the cwd condition unresolved at a status-only site, whatever the row\'s cwd', () => {
  const UNRESOLVED_CWD = { cwdMatches: false, cwdCheckDeferred: true } as const

  test.each<[string, RowPersonaComparison, RowPersonaComparison, PendingRowCover]>([
    ['resolved, the row matching P: as is (covered)', rowComparison(), rowComparison(), COVERED],
    ['resolved, the row\'s cwd elsewhere: as is (a cwd mismatch)', rowComparison({ cwdMatches: false }), rowComparison({ cwdMatches: false }), notCovered(PENDING_ROW_REASON_CWD_MISMATCH)],
    ['not resolved, the row\'s cwd lexically P\'s path', rowComparison({ workingDirectoryResolved: false, cwdMatches: true, cwdCheckDeferred: true }), rowComparison({ workingDirectoryResolved: false, ...UNRESOLVED_CWD }), undecided(PENDING_ROW_REASON_CWD_UNRESOLVED)],
    ['not resolved, the row\'s cwd an existing directory elsewhere', rowComparison({ workingDirectoryResolved: false, cwdMatches: false, cwdCheckDeferred: false }), rowComparison({ workingDirectoryResolved: false, ...UNRESOLVED_CWD }), undecided(PENDING_ROW_REASON_CWD_UNRESOLVED)],
    ['not resolved, the row\'s cwd with no real path either', rowComparison({ workingDirectoryResolved: false, ...UNRESOLVED_CWD }), rowComparison({ workingDirectoryResolved: false, ...UNRESOLVED_CWD }), undecided(PENDING_ROW_REASON_CWD_UNRESOLVED)],
  ])('%s', (_label, comparison, expected, cover) => {
    const forSite = pendingRowComparisonFor(comparison)
    expect(forSite).toEqual(expected)
    expect(decidePendingRowCover({ ...coverInput(), comparison: forSite })).toEqual(cover)
  })
})

// ---------------------------------------------------------------------------
// The read-and-step entry (b.jg5 SRJ-409, SRJ-411, SRJ-513)
// ---------------------------------------------------------------------------

describe('readAndStepPendingRow: one get, then a covered or undecided row armed pending-only, an uncovered one sent to the live-row sequence (recovery harness; SRJ-409, SRJ-411)', () => {
  let harness: RecoveryHarness | undefined

  afterEach(() => {
    const h = harness
    harness = undefined
    _resetConfigDirFs()
    if (h === undefined) return
    try {
      assertNoLeak(h.captured())
    } finally {
      h.cleanup()
    }
  })

  /** A harness over P and Q, its restart delay and health-check interval 0, P's `get` reading P's own `pending` row with `row`. */
  function pendingP(row: PersonaGetResultOverrides = {}): { h: RecoveryHarness; p: string; q: string } {
    const h = (harness = makeRecoveryHarness())
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [p, q] = h.keys as [string, string]
    h.script({ getResult: personaRow(h, p, { state: AGENT_DIRECTOR_PENDING_STATE, ...row }) })
    return { h, p, q }
  }

  /** P's reference, as the step's lines name it. */
  const refOf = (h: RecoveryHarness, key: string): string => renderPersonaRef(personaOf(h, key).name, key)

  /** The retry controller's own armed lines for persona `key` in pending-only mode with the pending-row cause. */
  const pendingOnlyArmedLines = (h: RecoveryHarness, key: string): string[] =>
    h.lines.filter((line) => line.startsWith(`[slack] unavailable-retry: persona=${key} armed in pending-only mode (${UNAVAILABLE_RETRY_CAUSE_PENDING_ROW}) — `))

  /** One `get` of P's row and nothing else for it: no kill, launch, keystroke or pane read; no approver; no sequence. */
  function expectOneGetOnly(h: RecoveryHarness, key: string): void {
    const id = personaInstanceId(key)
    const { getCalls, killCalls, spawnCalls, resumeCalls, sendKeysCalls, readPaneCalls, statusCalls } = h.stub.calls
    expect(getCalls).toEqual([{ claude_instance_id: id }])
    expect([killCalls, spawnCalls, resumeCalls, sendKeysCalls, readPaneCalls, statusCalls]).toEqual([[], [], [], [], [], []])
    expect([h.approverRunning(key), h.sequenceRunning(key)]).toEqual([false, false])
  }

  test.each<[string, (h: RecoveryHarness, key: string) => void]>([
    ['the key not recorded', () => {}],
    ['the key recorded and marked', (h, key) => h.retireKey(key, { mark: true })],
    [
      'the key recorded, its mark held in memory after its write failed',
      (h, key) => {
        h.retireKey(key)
        h.failRetiredKeyWrites()
        h.retiredKeys.mark(key)
        expect(h.retiredKeyWrites.at(-1)?.ok).toBe(false)
        expect(h.retiredEntry(key).marked).toBe(true)
      },
    ],
  ])('P\'s own covered pending row, %s: covered and armed; the controller\'s armed line in pending-only mode with the pending-row cause; no kill, launch, approver or sequence', async (_label, arrange) => {
    const { h, p, q } = pendingP()
    arrange(h, p)

    expect(await readAndStepPendingRow(personaOf(h, p))).toEqual({ kind: PENDING_ROW_COVERED, armed: true })

    expectPendingOnlyWatch(h, p)
    expect(pendingOnlyArmedLines(h, p)).toHaveLength(1)
    expectOneGetOnly(h, p)
    expect(h.controller.isArmed(q)).toBe(false)
  })

  /** P's working directory removed, its `get` reading P's `pending` row with `cwd` (P's configured path, lexically equal, when undefined). */
  function workingDirectoryGone(h: RecoveryHarness, key: string, cwd?: string): void {
    rmSync(personaOf(h, key).working_directory, { recursive: true, force: true })
    h.script({ getResult: personaRow(h, key, { state: AGENT_DIRECTOR_PENDING_STATE, ...(cwd === undefined ? {} : { cwd }) }) })
  }

  // b.jg5 SRJ-411 (hatch A3), b.av2 SR-6.4: at the status-only sites a
  // working directory with no real path leaves the row undecided whatever its
  // `cwd` is: a lexically equal `cwd` is never taken as covered, and a `cwd`
  // that resolves elsewhere is not sent to the sequence.
  test.each<[string, PendingRowUndecidedReason, (h: RecoveryHarness, key: string) => void]>([
    [
      'its working directory gone, the row\'s cwd another directory that does not exist',
      PENDING_ROW_REASON_CWD_UNRESOLVED,
      (h, key) => workingDirectoryGone(h, key, join(h.home, 'gone-elsewhere')),
    ],
    ['its working directory gone, the row\'s cwd lexically its configured path', PENDING_ROW_REASON_CWD_UNRESOLVED, (h, key) => workingDirectoryGone(h, key)],
    ['its working directory gone, the row\'s cwd another existing directory', PENDING_ROW_REASON_CWD_UNRESOLVED, (h, key) => workingDirectoryGone(h, key, h.home)],
    [
      'its claude_config_dir unresolvable',
      PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED,
      () => _setConfigDirFs({ realpath: () => { throw Object.assign(new Error('no such directory'), { code: 'ENOENT' }) } }),
    ],
  ])('P\'s pending row with %s: undecided and armed only, with its one line; no kill, launch, approver or sequence', async (_label, reason, arrange) => {
    const { h, p } = pendingP()
    arrange(h, p)
    const starts = recordSequenceStarts()

    expect(await readAndStepPendingRow(personaOf(h, p))).toEqual({ kind: PENDING_ROW_UNDECIDED, reason, armed: true })

    expectPendingOnlyWatch(h, p)
    expect(pendingOnlyArmedLines(h, p)).toHaveLength(1)
    expect(h.errors.filter((line) => line === undecidedPendingRowLine(refOf(h, p), reason, true))).toHaveLength(1)
    expect(starts).toEqual([])
    expectOneGetOnly(h, p)
  })

  /** Row labels without the `config_dir` label: a label missing is a mismatch (SRJ-1504). */
  const withoutConfigDir = (labels: Record<string, string> | undefined): Record<string, string> =>
    Object.fromEntries(Object.entries(labels ?? {}).filter(([name]) => `${name}=` !== CONFIG_DIR_LABEL_PREFIX))

  test.each<[string, PendingRowNotCoveredReason, (h: RecoveryHarness, key: string) => PersonaGetResultOverrides, boolean]>([
    [
      'the key recorded with no mark (its old life)',
      PENDING_ROW_REASON_RETIRED_OLD_LIFE,
      (h, key) => {
        h.retireKey(key)
        return {}
      },
      true,
    ],
    ['its cwd another existing directory', PENDING_ROW_REASON_CWD_MISMATCH, (h) => ({ cwd: h.home }), false],
    ['its config_dir label missing', PENDING_ROW_REASON_CONFIG_DIR_MISMATCH, (h, key) => ({ labels: withoutConfigDir(personaRow(h, key).labels) }), false],
  ])('P\'s pending row, %s: not covered; its one line and exactly one sequence start (step 1, the conversation not kept, context recovery); no pending-only arm, no approver, no kill or launch of its own', async (_label, reason, mismatch, retiredKey) => {
    const { h, p } = pendingP()
    h.script({ getResult: personaRow(h, p, { state: AGENT_DIRECTOR_PENDING_STATE, ...mismatch(h, p) }) })
    const starts = recordSequenceStarts()

    expect(await readAndStepPendingRow(personaOf(h, p))).toEqual({ kind: PENDING_ROW_NOT_COVERED, reason, startAnswer: LIVE_ROW_START_STARTED })

    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      key: p,
      instanceId: personaInstanceId(p),
      lastReadState: AGENT_DIRECTOR_PENDING_STATE,
      entryStep: LIVE_ROW_SEQUENCE_ENTRY_KILL,
      keepsConversation: false,
      retiredKey,
      launches: true,
      alertContext: KILL_FAILURE_CONTEXT_RECOVERY,
    } satisfies Partial<LiveRowSequenceRequest>)
    expect(h.errors.filter((line) => line === uncoveredPendingRowLine(refOf(h, p), reason))).toHaveLength(1)
    expect([h.triggers, h.controller.isArmed(p), pendingOnlyArmedLines(h, p)]).toEqual([[], false, []])
    expectOneGetOnly(h, p)
  })

  /** The launch starts a harness row can carry that are none: absent, empty, and unparseable. */
  const ROW_NO_LAUNCH_STARTS = NO_LAUNCH_STARTS.filter((entry): entry is [string, string | undefined] => entry[1] !== null)

  test.each(ROW_NO_LAUNCH_STARTS)('P\'s own pending row with no launch start (%s), covered in every other way: P latches; nothing armed, no sequence', async (_form, launch) => {
    const { h, p } = pendingP({ launch_started_at: launch })
    const starts = recordSequenceStarts()

    expect(await readAndStepPendingRow(personaOf(h, p))).toEqual({ kind: PENDING_ROW_STEP_LATCHED })

    expect(h.latch.isLatched(p)).toBe(true)
    expect([starts, h.triggers, h.controller.isArmed(p), pendingOnlyArmedLines(h, p)]).toEqual([[], [], false, []])
    expectOneGetOnly(h, p)
  })
})

// ---------------------------------------------------------------------------
// The stuck-launch post's texts, pinned (b.jg5 SRJ-1017): the one literal block
// ---------------------------------------------------------------------------

describe('the stuck-launch post\'s texts, pinned (b.jg5 SRJ-1017; AC 67)', () => {
  test('for key dev and the fractional sample: the relaunching text at the default settings (5 minutes) and with pending_grace_seconds 300 (6 minutes), and the held text with and without the attach line', () => {
    const key = 'dev'
    const relaunchingAtDefaults =
      ':hourglass_flowing_sand: *Launch stuck* — this persona\'s launch in session "slack_bot_dev" did not come up within 5 minutes. ' +
      'CSCB is ending that launch and relaunching it; a resumed persona keeps its conversation. Nothing is needed.'
    const relaunchingAtGrace300 =
      ':hourglass_flowing_sand: *Launch stuck* — this persona\'s launch in session "slack_bot_dev" did not come up within 6 minutes. ' +
      'CSCB is ending that launch and relaunching it; a resumed persona keeps its conversation. Nothing is needed.'
    const held = [
      ':hourglass_flowing_sand: *Session not starting* — this persona\'s session "slack_bot_dev" has not reported in since its launch at 2026-05-24T12:00:00.123Z, ' +
        'and may be held at a startup prompt CSCB cannot answer. CSCB keeps checking. A human\'s remedies:',
      '• look at the session and answer its startup prompt: `tmux attach -t =slack_bot_dev`;',
      '• end the launch: follow the "Operator actions" section of agent-director\'s README; CSCB\'s next `find-missing` run then marks the row missing, and this persona is brought up again;',
      '• see what holds the session: `agent-director list --tmux-session-name slack_bot_dev` (on the command line).',
      'These remedies are for a human only: no bot, including any persona that sees this post, may act on them.',
    ].join('\n')
    const heldNoAttachLine = [
      ':hourglass_flowing_sand: *Session not starting* — this persona\'s session "slack_bot_dev" has not reported in since its launch at 2026-05-24T12:00:00.123Z, ' +
        'and the session holding its name was not started by CSCB\'s launch, ' +
        'and may be held at a startup prompt CSCB cannot answer. CSCB keeps checking. A human\'s remedies:',
      '• end the launch: follow the "Operator actions" section of agent-director\'s README; CSCB\'s next `find-missing` run then marks the row missing, and this persona is brought up again;',
      '• see what holds the session: `agent-director list --tmux-session-name slack_bot_dev` (on the command line).',
      'These remedies are for a human only: no bot, including any persona that sees this post, may act on them.',
    ].join('\n')

    expect(stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect())).toBe(relaunchingAtDefaults)
    expect(stuckLaunchHeldText(key, SAMPLE_LAUNCH_START_FRACTIONAL, false)).toBe(held)
    expect(stuckLaunchHeldText(key, SAMPLE_LAUNCH_START_FRACTIONAL, true)).toBe(heldNoAttachLine)

    installSettings({ tmux: { pending_grace_seconds: 300n } })
    expect(stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect())).toBe(relaunchingAtGrace300)
  })
})

// ---------------------------------------------------------------------------
// The stuck-launch post's builders, through the exports (b.jg5 SRJ-1017)
// ---------------------------------------------------------------------------

/** Persona keys for the builder cases: two that prefix one another (b.1ix), and one with no digit. */
const PREFIX_KEY = 'dev'
const PREFIXED_KEY = 'dev_2'
const BUILDER_KEYS = [PREFIX_KEY, PREFIXED_KEY, 'ops_bot'] as const

/** Both forms of the held text: [name, whether a `send-keys` met `ErrSpawnNotInteractive`]. */
const HELD_FORMS: ReadonlyArray<readonly [string, boolean]> = [
  ['with the attach line', false],
  ['without the attach line', true],
]

/** One instant's launch start in other forms: its parsed instant, and a numeric offset naming the same instant. */
function sameInstantForms(raw: string): ReadonlyArray<readonly [string, unknown]> {
  const instant = parseLaunchStart(raw)!
  const offsetHours = 2
  const shifted = new Date(instant + offsetHours * 60 * MINUTE_MS).toISOString()
  return [
    ['its parsed instant (epoch ms)', instant],
    [`a +0${offsetHours}:00 offset`, shifted.replace(/Z$/, `+0${offsetHours}:00`)],
  ]
}

describe('stuckLaunchRelaunchingText: B in whole minutes, rounded down, and P\'s quoted session (b.jg5 SRJ-1017, SRJ-210)', () => {
  /** [settings, the agent-director settings written (none: the defaults), whether B is whole minutes there]. */
  const B_SETTINGS: ReadonlyArray<readonly [string, AdConfigTables | undefined, boolean]> = [
    ['the default settings', undefined, true],
    ['pending_grace_seconds 300', { tmux: { pending_grace_seconds: 300n } }, true],
    ['a G that leaves B short of a whole minute', { tmux: { pending_grace_seconds: 359n } }, false],
  ]

  test.each(B_SETTINGS)('at %s: B is wholeMinutes(adLaunchBoundMsInEffect()), the text\'s only number, rounded down', (_label, tables, wholeMinute) => {
    if (tables !== undefined) installSettings(tables)
    const boundMs = adLaunchBoundMsInEffect()
    const minutes = wholeMinutes(boundMs)
    expect(boundMs % MINUTE_MS === 0).toBe(wholeMinute)
    expect(minutes).toBe(Math.floor(boundMs / MINUTE_MS))

    const text = stuckLaunchRelaunchingText(PREFIX_KEY, boundMs)
    expect(text.startsWith(`${STUCK_LAUNCH_RELAUNCHING_HEAD} `)).toBe(true)
    expect(text.replace(quotedPersonaSessionName(PREFIX_KEY), '').match(/\d+/g)).toEqual([String(minutes)])
    // Rounded down: B's text is its whole minutes' text, never the next minute's.
    expect(text).toBe(stuckLaunchRelaunchingText(PREFIX_KEY, minutes * MINUTE_MS))
    expect(text).not.toBe(stuckLaunchRelaunchingText(PREFIX_KEY, (minutes + 1) * MINUTE_MS))
  })

  test('pending_grace_seconds 300 states one minute more than the defaults (5 → 6)', () => {
    const atDefaults = wholeMinutes(adLaunchBoundMsInEffect())
    installSettings({ tmux: { pending_grace_seconds: 300n } })
    expect(wholeMinutes(adLaunchBoundMsInEffect())).toBe(atDefaults + 1)
  })
})

describe('both texts name P\'s own session, quoted (b.jg5 SRJ-1017, SRJ-1001; b.1ix)', () => {
  test.each([
    [PREFIX_KEY, PREFIXED_KEY],
    [PREFIXED_KEY, PREFIX_KEY],
  ])('persona %s: its quoted session in every text, never %s\'s', (key, other) => {
    const texts = [
      stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect()),
      ...HELD_FORMS.map(([, flagged]) => stuckLaunchHeldText(key, SAMPLE_LAUNCH_START_FRACTIONAL, flagged)),
    ]
    for (const text of texts) {
      expect(text.split(quotedPersonaSessionName(key))).toHaveLength(2)
      expect(text).not.toContain(quotedPersonaSessionName(other))
    }
  })

  test.each([
    [PREFIX_KEY, PREFIXED_KEY],
    [PREFIXED_KEY, PREFIX_KEY],
  ])('persona %s: the attach line targets its exact session (=<name>) and the list line names its session once; each differs from %s\'s only in the name', (key, other) => {
    const attach = stuckLaunchAttachRemedyLine(key)
    const list = stuckLaunchListRemedyLine(key)
    expect(attach.split(tmuxExactSessionTarget(personaTmuxSessionName(key)))).toHaveLength(2)
    expect(list.split(personaTmuxSessionName(key))).toHaveLength(2)
    expect(list).not.toContain(tmuxExactSessionTarget(personaTmuxSessionName(key)))
    expect(attach.replace(personaTmuxSessionName(key), personaTmuxSessionName(other))).toBe(stuckLaunchAttachRemedyLine(other))
    expect(list.replace(personaTmuxSessionName(key), personaTmuxSessionName(other))).toBe(stuckLaunchListRemedyLine(other))
  })
})

describe('stuckLaunchHeldText: with and without the attach line (b.jg5 SRJ-1017)', () => {
  test.each(BUILDER_KEYS.flatMap((key) => VALID_LAUNCH_STARTS.map(([form, raw]) => [key, form, raw] as const)))(
    'persona %s, the %s launch start: unflagged, the head and all three remedies and the human-only line; flagged, the clause after the launch start and no attach line',
    (key, _form, raw) => {
      const rendered = describeLaunchStartForLog(raw)
      const [head, ...rest] = stuckLaunchHeldText(key, raw, false).split('\n')
      const [flaggedHead, ...flaggedRest] = stuckLaunchHeldText(key, raw, true).split('\n')

      expect(rest).toEqual([
        stuckLaunchAttachRemedyLine(key),
        STUCK_LAUNCH_END_LAUNCH_REMEDY_LINE,
        stuckLaunchListRemedyLine(key),
        STUCK_LAUNCH_HUMAN_ONLY_LINE,
      ])
      expect(flaggedRest).toEqual([STUCK_LAUNCH_END_LAUNCH_REMEDY_LINE, stuckLaunchListRemedyLine(key), STUCK_LAUNCH_HUMAN_ONLY_LINE])

      expect(head!.startsWith(`${STUCK_LAUNCH_HELD_HEAD} `)).toBe(true)
      expect(head).toContain(quotedPersonaSessionName(key))
      expect(head!.split(rendered)).toHaveLength(2)
      expect(head).not.toContain(STUCK_LAUNCH_NOT_STARTED_BY_CSCB_CLAUSE)
      // The flagged head is the unflagged one with the clause right after the launch start.
      expect(flaggedHead).toBe(head!.replace(rendered, `${rendered}${STUCK_LAUNCH_NOT_STARTED_BY_CSCB_CLAUSE}`))

      const target = tmuxExactSessionTarget(personaTmuxSessionName(key))
      expect(stuckLaunchHeldText(key, raw, false)).toContain(target)
      expect(stuckLaunchHeldText(key, raw, true)).not.toContain(target)
    },
  )
})

describe('the launch start in the held text: one renderer, ISO 8601 UTC ending in Z (b.jg5 SRJ-1017, hatch A3)', () => {
  /** An ISO 8601 UTC timestamp with milliseconds, ending in `Z`, as `Date.prototype.toISOString` writes one. */
  const ISO_UTC_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

  test.each(VALID_LAUNCH_STARTS)('the stub\'s %s sample renders as its instant in ISO 8601 UTC with Z, in the held text', (_form, raw) => {
    const rendered = describeLaunchStartForLog(raw)
    expect(rendered).toMatch(ISO_UTC_Z)
    expect(rendered).toBe(new Date(parseLaunchStart(raw)!).toISOString())
    for (const [, flagged] of HELD_FORMS) expect(stuckLaunchHeldText(PREFIX_KEY, raw, flagged)).toContain(rendered)
  })

  test.each(VALID_LAUNCH_STARTS.flatMap(([form, raw]) => sameInstantForms(raw).map(([other, value]) => [form, other, raw, value] as const)))(
    'the %s sample and %s naming the same instant give one held text, in both forms, and the raw offset text never reaches it',
    (_form, _other, raw, value) => {
      for (const [, flagged] of HELD_FORMS) {
        const text = stuckLaunchHeldText(PREFIX_KEY, value, flagged)
        expect(text).toBe(stuckLaunchHeldText(PREFIX_KEY, raw, flagged))
        if (typeof value === 'string') expect(text).not.toContain(value)
      }
    },
  )

  test('the whole sample\'s raw text does not reach the held text: its instant does, with milliseconds', () => {
    const text = stuckLaunchHeldText(PREFIX_KEY, SAMPLE_LAUNCH_START_WHOLE, false)
    expect(text).not.toContain(SAMPLE_LAUNCH_START_WHOLE)
    expect(text).toContain(new Date(WHOLE_INSTANT).toISOString())
  })
})

describe('neither stuck-launch text names a session-ending command (b.jg5 SRJ-1001, C22)', () => {
  /** Every text, in every form, for every key and launch start, at the default B and with `pending_grace_seconds` 300. */
  function everyStuckLaunchText(): string[] {
    const texts: string[] = []
    for (const key of BUILDER_KEYS) {
      texts.push(stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect()))
      for (const [, raw] of VALID_LAUNCH_STARTS) for (const [, flagged] of HELD_FORMS) texts.push(stuckLaunchHeldText(key, raw, flagged))
    }
    installSettings({ tmux: { pending_grace_seconds: 300n } })
    for (const key of BUILDER_KEYS) texts.push(stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect()))
    return texts
  }

  test('every text, in every form, for every key, launch start and B, matches none of SESSION_ENDING_COMMAND_FORMS', () => {
    const texts = everyStuckLaunchText()
    expect(SESSION_ENDING_COMMAND_FORMS.length).toBeGreaterThan(0)
    expect(texts.flatMap(sessionEndingCommandsIn)).toEqual([])
  })

  test('no line of any text names kill-pane, set-option, agent-director delete, clear-latch, has-session or a label option (CSCB_OWN_LINE_FORBIDDEN); a tmux target is always exact (=)', () => {
    const lines = everyStuckLaunchText().flatMap((text) => text.split('\n'))
    expect(CSCB_OWN_LINE_FORBIDDEN.length).toBeGreaterThan(0)
    expect(lines.flatMap(cscbOwnLineForbiddenIn)).toEqual([])
    // Every `-t` target any line names is an exact one (SRJ-1001: no tmux target without `=`).
    const targets = lines.flatMap((line) => [...line.matchAll(/-t\s+(\S+)/g)].map((match) => match[1]!))
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) expect(target.startsWith(tmuxExactSessionTarget(''))).toBe(true)
  })

  test('no text calls anything a "dispatcher bug" (b.jg5 SRJ-713)', () => {
    for (const text of everyStuckLaunchText()) expect(text).not.toMatch(/dispatcher\s+bug/i)
  })
})

// ---------------------------------------------------------------------------
// The stuck-launch posters (b.jg5 SRJ-1017, SRJ-1016)
// ---------------------------------------------------------------------------

/** One stuck-launch text as a poster posts it: its mark, its held form, its poster and its text for a key. */
interface StuckLaunchTextCase {
  readonly name: string
  readonly mark: StuckLaunchTextMark
  readonly flagged: boolean
  readonly post: (deps: StuckLaunchPosterDeps, key: string) => StuckLaunchPostAnswer
  readonly text: (key: string) => string
}

/** The launch start the held posts carry: the stub's default sample. */
const POSTED_LAUNCH_START = SAMPLE_LAUNCH_START_FRACTIONAL

const RELAUNCHING: StuckLaunchTextCase = {
  name: 'the relaunching text',
  mark: STUCK_LAUNCH_MARK_RELAUNCHING,
  flagged: false,
  post: (deps, key) => postStuckLaunchRelaunching(deps, key, adLaunchBoundMsInEffect()),
  text: (key) => stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect()),
}

/** The held text's poster in the form `flagged` picks. */
function heldCase(flagged: boolean): StuckLaunchTextCase {
  return {
    name: flagged ? 'the held text without the attach line' : 'the held text with the attach line',
    mark: STUCK_LAUNCH_MARK_HELD,
    flagged,
    post: (deps, key) => postStuckLaunchHeld(deps, key, POSTED_LAUNCH_START, flagged),
    text: (key) => stuckLaunchHeldText(key, POSTED_LAUNCH_START, flagged),
  }
}

const HELD = heldCase(false)
const HELD_NO_ATTACH = heldCase(true)
const TEXT_CASES: readonly StuckLaunchTextCase[] = [RELAUNCHING, HELD, HELD_NO_ATTACH]

/** The poster's line for `text` posted for `key` with `answer`. */
function posterLine(key: string, text: StuckLaunchTextCase, answer: StuckLaunchPostAnswer, muted = false): string {
  return stuckLaunchPostLine(key, text.mark, answer, { metNotInteractive: text.flagged, muted })
}

/** Two personas. */
const P = 'alpha'
const Q = 'beta'

/** A posters' rig: a real episodes instance on the case's fake clock, recording its sink and lines; the outage query and teardown state set by the case. */
interface PosterRig {
  readonly episodes: PersonaEpisodes
  readonly deps: StuckLaunchPosterDeps
  /** What the episodes' sink received (the persona notifier in production). */
  readonly posts: Array<{ readonly key: string; readonly text: string }>
  /** The posters' lines (their injected log). */
  readonly lines: string[]
  /** The episodes' own lines. */
  readonly episodeLines: string[]
  /** The keys whose `tmux-unavailable` outage the injected query answers raised. */
  readonly raised: Set<string>
  /** Each key's persona-teardown state (none unless set). */
  readonly teardown: Map<string, PersonaTeardownWindowState>
}

function posterRig(overrides: Partial<StuckLaunchPosterDeps> = {}): PosterRig {
  const clock = clockAt(WHOLE_INSTANT)
  const posts: Array<{ key: string; text: string }> = []
  const lines: string[] = []
  const episodeLines: string[] = []
  const raised = new Set<string>()
  const teardown = new Map<string, PersonaTeardownWindowState>()
  const episodes = createPersonaEpisodes({
    sink: (key, text) => {
      posts.push({ key, text })
    },
    log: (line) => {
      episodeLines.push(line)
    },
    clock,
    teardownWindow: (key) => teardown.get(key) ?? 'none',
  })
  const deps: StuckLaunchPosterDeps = {
    episodes,
    tmuxUnavailableRaised: (key) => raised.has(key),
    log: (line) => {
      lines.push(line)
    },
    ...overrides,
  }
  return { episodes, deps, posts, lines, episodeLines, raised, teardown }
}

/** Whether `key`'s stuck-launch episode is open in `rig`. */
const isOpen = (rig: PosterRig, key: string): boolean => rig.episodes.isOpen(key, PERSONA_EPISODE_KIND_STUCK_LAUNCH)

/** A row state whose read ends the episode (a live state out of `pending`). */
const LIVE_OUT_OF_PENDING = [...AGENT_DIRECTOR_LIVE_STATES].find((state) => state !== AGENT_DIRECTOR_PENDING_STATE)!

describe('the stuck-launch posters: each text at most once per stuck-launch episode (b.jg5 SRJ-1017, SRJ-1016; AC 67)', () => {
  /** Each text against each text with the other mark, in both orders. */
  const ORDERED_PAIRS = TEXT_CASES.flatMap((first) =>
    TEXT_CASES.filter((second) => second.mark !== first.mark).map((second) => [first.name, second.name, first, second] as const),
  )

  test.each(ORDERED_PAIRS)('%s, then %s: each posts once, a second post of it posts nothing, and one episode holds both marks', (_first, _second, first, second) => {
    const rig = posterRig()

    expect(first.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(first.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)
    expect(second.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(second.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)
    expect(first.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)

    expect(rig.posts).toEqual([
      { key: P, text: first.text(P) },
      { key: P, text: second.text(P) },
    ])
    expect(rig.lines).toEqual([
      posterLine(P, first, STUCK_LAUNCH_POSTED),
      posterLine(P, first, STUCK_LAUNCH_ALREADY_POSTED),
      posterLine(P, second, STUCK_LAUNCH_POSTED),
      posterLine(P, second, STUCK_LAUNCH_ALREADY_POSTED),
      posterLine(P, first, STUCK_LAUNCH_ALREADY_POSTED),
    ])
    expect(rig.episodes.view(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH)?.posted).toEqual([first.mark, second.mark])
    expect(rig.episodeLines).toEqual([])
    assertNoLeak({ posts: rig.posts, lines: rig.lines })
  })

  test.each([
    [HELD.name, HELD_NO_ATTACH.name, HELD, HELD_NO_ATTACH],
    [HELD_NO_ATTACH.name, HELD.name, HELD_NO_ATTACH, HELD],
  ])('%s, then %s: the held text\'s two forms share one mark, so the second posts nothing', (_first, _second, first, second) => {
    const rig = posterRig()

    expect(first.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(second.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)

    expect(rig.posts).toEqual([{ key: P, text: first.text(P) }])
    expect(rig.lines).toEqual([posterLine(P, first, STUCK_LAUNCH_POSTED), posterLine(P, second, STUCK_LAUNCH_ALREADY_POSTED)])
  })

  test('after the episode ends (silently, with its one line), a new episode posts each text again', () => {
    const rig = posterRig()
    const reason = stuckLaunchEndRowLiveReason(LIVE_OUT_OF_PENDING)
    // No episode open yet: the end does nothing and logs nothing.
    expect(endStuckLaunchEpisode(rig.episodes, P, reason, rig.deps.log)).toBe(false)

    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(HELD.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    const firstEpisode = rig.episodes.view(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH)!.episode

    expect(endStuckLaunchEpisode(rig.episodes, P, reason, rig.deps.log)).toBe(true)
    expect(isOpen(rig, P)).toBe(false)
    expect(rig.posts).toHaveLength(2)

    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(HELD_NO_ATTACH.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(rig.episodes.view(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH)!.episode).toBeGreaterThan(firstEpisode)

    expect(rig.posts).toEqual([
      { key: P, text: RELAUNCHING.text(P) },
      { key: P, text: HELD.text(P) },
      { key: P, text: RELAUNCHING.text(P) },
      { key: P, text: HELD_NO_ATTACH.text(P) },
    ])
    expect(rig.lines).toEqual([
      posterLine(P, RELAUNCHING, STUCK_LAUNCH_POSTED),
      posterLine(P, HELD, STUCK_LAUNCH_POSTED),
      stuckLaunchEpisodeEndedLine(P, reason),
      posterLine(P, RELAUNCHING, STUCK_LAUNCH_POSTED),
      posterLine(P, HELD_NO_ATTACH, STUCK_LAUNCH_POSTED),
    ])
  })

  test('two personas are independent: each posts its own texts once, and ending one\'s episode leaves the other\'s', () => {
    const rig = posterRig()
    for (const key of [P, Q]) for (const text of [RELAUNCHING, HELD]) expect(text.post(rig.deps, key)).toBe(STUCK_LAUNCH_POSTED)

    expect(endStuckLaunchEpisode(rig.episodes, P, stuckLaunchEndRowLiveReason(LIVE_OUT_OF_PENDING), rig.deps.log)).toBe(true)
    expect([isOpen(rig, P), isOpen(rig, Q)]).toEqual([false, true])
    expect(RELAUNCHING.post(rig.deps, Q)).toBe(STUCK_LAUNCH_ALREADY_POSTED)
    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)

    expect(rig.posts).toEqual([
      { key: P, text: RELAUNCHING.text(P) },
      { key: P, text: HELD.text(P) },
      { key: Q, text: RELAUNCHING.text(Q) },
      { key: Q, text: HELD.text(Q) },
      { key: P, text: RELAUNCHING.text(P) },
    ])
  })
})

describe('the stuck-launch posters: nothing posted and no episode begun while tmux-unavailable is raised (b.jg5 SRJ-1017, SRJ-410 step 3)', () => {
  test.each(TEXT_CASES.map((text) => [text.name, text] as const))('%s while P\'s outage is raised: suppressed, nothing posted, no episode begun; Q still posts', (_name, text) => {
    const rig = posterRig()
    rig.raised.add(P)

    expect(text.post(rig.deps, P)).toBe(STUCK_LAUNCH_SUPPRESSED)
    expect(text.post(rig.deps, Q)).toBe(STUCK_LAUNCH_POSTED)

    expect(isOpen(rig, P)).toBe(false)
    expect(rig.episodes.view(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH)).toBeUndefined()
    expect(rig.posts).toEqual([{ key: Q, text: text.text(Q) }])
    expect(rig.lines).toEqual([posterLine(P, text, STUCK_LAUNCH_SUPPRESSED), posterLine(Q, text, STUCK_LAUNCH_POSTED)])
  })

  test('raised while an episode is open: the post is suppressed and the episode keeps its marks; once cleared, the text not yet posted posts', () => {
    const rig = posterRig()
    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)

    rig.raised.add(P)
    expect(HELD.post(rig.deps, P)).toBe(STUCK_LAUNCH_SUPPRESSED)
    expect(rig.episodes.view(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH)?.posted).toEqual([RELAUNCHING.mark])

    rig.raised.delete(P)
    expect(HELD.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)
    expect(rig.posts).toEqual([
      { key: P, text: RELAUNCHING.text(P) },
      { key: P, text: HELD.text(P) },
    ])
  })

  test.each(TEXT_CASES.map((text) => [text.name, text] as const))('%s with a tmux-unavailable query that throws: taken as raised, with its line; nothing posted and no episode begun', (_name, text) => {
    const err = new Error(`outage query refused (${sentinelInMessage('outage')})`)
    const rig = posterRig({
      tmuxUnavailableRaised: () => {
        throw err
      },
    })

    expect(text.post(rig.deps, P)).toBe(STUCK_LAUNCH_SUPPRESSED)

    expect(isOpen(rig, P)).toBe(false)
    expect(rig.posts).toEqual([])
    expect(rig.lines).toEqual([stuckLaunchOutageQueryFailedLine(P, describeThrownValue(err)), posterLine(P, text, STUCK_LAUNCH_SUPPRESSED)])
    assertNoLeak(rig.lines)
  })
})

describe('the stuck-launch posters: closed episodes, a submitted teardown, and failures (b.jg5 SRJ-1017, SRJ-1003)', () => {
  test.each(TEXT_CASES.map((text) => [text.name, text] as const))('%s after the episodes are closed (shutdown): closed, nothing posted', (_name, text) => {
    const rig = posterRig()
    rig.episodes.close()

    expect(text.post(rig.deps, P)).toBe(STUCK_LAUNCH_NOT_POSTED_CLOSED)

    expect(rig.posts).toEqual([])
    expect(rig.lines).toEqual([posterLine(P, text, STUCK_LAUNCH_NOT_POSTED_CLOSED)])
  })

  test.each(TEXT_CASES.map((text) => [text.name, text] as const))('%s while P\'s teardown is submitted: muted, with its muted line, and it counts as posted in its episode', (_name, text) => {
    const rig = posterRig()
    rig.teardown.set(P, 'submitted')

    expect(text.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(text.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)

    expect(rig.posts).toEqual([])
    expect(rig.episodes.hasPosted(P, PERSONA_EPISODE_KIND_STUCK_LAUNCH, text.mark)).toBe(true)
    expect(rig.lines).toEqual([posterLine(P, text, STUCK_LAUNCH_POSTED, true), posterLine(P, text, STUCK_LAUNCH_ALREADY_POSTED)])
    // The episodes log their own mute line once.
    expect(rig.episodeLines).toHaveLength(1)
  })

  test('an episodes call that throws: suppressed, with its one line, and nothing posted', () => {
    const err = new Error(`episodes refused (${sentinelInMessage('episodes')})`)
    const posts: string[] = []
    const episodes: StuckLaunchPostEpisodes = {
      begin: () => {
        throw err
      },
      post: (_key, _kind, text) => {
        posts.push(text)
        return true
      },
      teardownWindowState: () => 'none',
    }
    const lines: string[] = []
    const deps: StuckLaunchPosterDeps = { episodes, tmuxUnavailableRaised: () => false, log: (line) => void lines.push(line) }

    for (const text of TEXT_CASES) expect(text.post(deps, P)).toBe(STUCK_LAUNCH_SUPPRESSED)

    expect(posts).toEqual([])
    expect(lines).toEqual(TEXT_CASES.map(() => stuckLaunchPostFailedLine(P, describeThrownValue(err))))
    assertNoLeak(lines)
  })

  test('a log that throws changes nothing: the text posts once, then posts nothing', () => {
    const rig = posterRig({
      log: () => {
        throw new Error('log refused')
      },
    })

    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_POSTED)
    expect(RELAUNCHING.post(rig.deps, P)).toBe(STUCK_LAUNCH_ALREADY_POSTED)
    expect(rig.posts).toEqual([{ key: P, text: RELAUNCHING.text(P) }])
  })
})

describe('isStuckLaunchEpisodeEndState: a live state out of pending ends the episode; pending, ended, missing and no row do not (b.jg5 SRJ-1016)', () => {
  test.each([...AGENT_DIRECTOR_LIVE_STATES].filter((state) => state !== AGENT_DIRECTOR_PENDING_STATE))('%s ends it', (state) => {
    expect(isStuckLaunchEpisodeEndState(state)).toBe(true)
  })

  test.each<[string, unknown]>([
    [AGENT_DIRECTOR_PENDING_STATE, AGENT_DIRECTOR_PENDING_STATE],
    ...[...AGENT_DIRECTOR_DEAD_STATES].map((state): [string, unknown] => [state, state]),
    ['no row (undefined)', undefined],
    ['null', null],
    ['an unknown state', 'starting'],
    ['a non-string', 1],
  ])('%s does not', (_label, state) => {
    expect(isStuckLaunchEpisodeEndState(state)).toBe(false)
  })
})

describe('assertNoLeak over the stuck-launch texts and lines (b.jg5 SRJ-1017)', () => {
  test('a key carrying a fake token: every text and line carries it only as the key, and nothing else token-like', () => {
    const key = `p_${fakeToken(BOT_TOKEN_PREFIX, 'key')}`
    const texts = [
      stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect()),
      ...HELD_FORMS.map(([, flagged]) => stuckLaunchHeldText(key, POSTED_LAUNCH_START, flagged)),
    ]
    const answers: StuckLaunchPostAnswer[] = [STUCK_LAUNCH_POSTED, STUCK_LAUNCH_ALREADY_POSTED, STUCK_LAUNCH_SUPPRESSED, STUCK_LAUNCH_NOT_POSTED_CLOSED]
    const lines = [
      ...TEXT_CASES.flatMap((text) => answers.map((answer) => posterLine(key, text, answer))),
      posterLine(key, RELAUNCHING, STUCK_LAUNCH_POSTED, true),
      stuckLaunchEpisodeEndedLine(key, stuckLaunchEndRowLiveReason(LIVE_OUT_OF_PENDING)),
    ]

    // The key is in them (the check would fail unmasked), and nothing else is token-like.
    expect(() => assertNoLeak({ texts, lines })).toThrow()
    assertNoLeak(withoutName({ texts, lines }, key, key))
  })

  test('a raw launch start carrying a fake token never reaches the held text: it renders as no launch start', () => {
    const raw = `${SAMPLE_LAUNCH_START_WHOLE}${fakeToken(BOT_TOKEN_PREFIX, 'launch')}`
    expect(describeLaunchStartForLog(raw)).toBe(describeLaunchStartForLog(undefined))
    assertNoLeak(HELD_FORMS.map(([, flagged]) => stuckLaunchHeldText(PREFIX_KEY, raw, flagged)))
  })
})
