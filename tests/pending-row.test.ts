import { useImmediateTypingLifecycle } from './test-helpers/legacy-typing.ts'
useImmediateTypingLifecycle()

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AD_ERROR_CLASS_UNAVAILABLE, LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT } from '../src/ad-error-class.ts'
import {
  AD_SETTING_INTEGER_MAX,
  AD_WAIT_NEVER_ENDS,
  adGraceMsInEffect,
  adLaunchBoundMs,
  adLaunchBoundMsInEffect,
  DEFAULT_AD_SETTINGS,
  DEFAULT_AD_SETTINGS_IN_EFFECT,
  installAdSettings,
  pendingGraceMinimumSeconds,
  resetAdSettingsForTests,
  wholeMinutes,
  type AdSettingsReader,
} from '../src/ad-settings.ts'
import { getFailureCount } from '../src/backoff.ts'
import { describeKillOutcome, KILL_OUTCOME_KILLED } from '../src/checked-kill.ts'
import type { ConflictLatchRecord } from '../src/conflict-latch.ts'
import { KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT } from '../src/kill-failure-alert.ts'
import { KILL_RETRY_ALERT_NONE, KILL_RETRY_SPACING_MS, KILL_RETRY_TRIES } from '../src/kill-retry.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_LIVE_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_DEAD_ROW_ENDED,
  LIVENESS_DEAD_ROW_MISSING,
  LIVENESS_DEAD_ROW_NO_ROW,
} from '../src/liveness-reading.ts'
import { clearOutageFlag, getOutageFlags } from '../src/outage-state.ts'
import { armPendingRowWait, decidePendingRowCover, decidePendingRowStepThree, describeLaunchStartForLog, endStuckLaunchEpisode, isPendingRowAged, isPendingWithNoLaunchStart, isStuckLaunchEpisodeEndState, parseLaunchStart, PENDING_ROW_AGE_AT_B, PENDING_ROW_AGE_FROM_G, PENDING_ROW_AGE_NO_LAUNCH_START, PENDING_ROW_AGE_YOUNGER_THAN_G, PENDING_ROW_COVERED, PENDING_ROW_GET_ABSENT, PENDING_ROW_GET_LATCHED, PENDING_ROW_GET_REFUSED, PENDING_ROW_GET_ROW, PENDING_ROW_NO_LAUNCH_START, PENDING_ROW_NOT_COVERED, PENDING_ROW_READING_GONE, PENDING_ROW_READING_LATCHED, PENDING_ROW_READING_LIVE, PENDING_ROW_READING_PENDING, PENDING_ROW_READING_READ_REFUSED, PENDING_ROW_READING_RUN_REFUSED, PENDING_ROW_READING_UNKNOWN_STATE, PENDING_ROW_REASON_CONFIG_DIR_MISMATCH, PENDING_ROW_REASON_CONFIG_DIR_UNRESOLVED, PENDING_ROW_REASON_CWD_MISMATCH, PENDING_ROW_REASON_CWD_UNRESOLVED, PENDING_ROW_REASON_RETIRED_OLD_LIFE, PENDING_ROW_RELAUNCH_KEPT, PENDING_ROW_RULE_LOG_HEAD, PENDING_ROW_RULE_ORIGIN_RETRY, PENDING_ROW_RUN_FAILED, PENDING_ROW_RUN_JUDGED_ALIVE, PENDING_ROW_RUN_LATCHED, PENDING_ROW_RUN_LEFT_LIVE, PENDING_ROW_RUN_MARKED_MISSING, PENDING_ROW_RUN_NOT_JUDGED, PENDING_ROW_RUN_REFUSED, PENDING_ROW_STEP3_CONFIG_MALFORMED, PENDING_ROW_STEP3_HELD, PENDING_ROW_STEP3_LATCHED, PENDING_ROW_STEP3_RELAUNCH, PENDING_ROW_STEP3_TMUX_UNAVAILABLE, PENDING_ROW_UNDECIDED, PENDING_ROW_WAIT_NOT_ARMED, pendingRowAgeOf, postStuckLaunchHeld, postStuckLaunchRelaunching, readPendingRowRun, STUCK_LAUNCH_ABORT_KILL_FAILED, STUCK_LAUNCH_ABORT_KILL_SUCCEEDED, STUCK_LAUNCH_ABORT_KILL_TRY_LATER, STUCK_LAUNCH_ABORT_SKIP_POST_FAILED, STUCK_LAUNCH_ALREADY_POSTED, STUCK_LAUNCH_END_LAUNCH_REMEDY_LINE, STUCK_LAUNCH_HELD_HEAD, STUCK_LAUNCH_HUMAN_ONLY_LINE, STUCK_LAUNCH_MARK_HELD, STUCK_LAUNCH_MARK_RELAUNCHING, STUCK_LAUNCH_NOT_POSTED_CLOSED, STUCK_LAUNCH_NOT_STARTED_BY_CSCB_CLAUSE, STUCK_LAUNCH_POST_FAILED, STUCK_LAUNCH_POSTED, STUCK_LAUNCH_RELAUNCHING_HEAD, STUCK_LAUNCH_SUPPRESSED, stuckLaunchAbortKillLine, stuckLaunchAbortSkippedLine, stuckLaunchAttachRemedyLine, stuckLaunchEndRowLiveReason, stuckLaunchEpisodeEndedLine, stuckLaunchEpisodeEndFailedLine, stuckLaunchHeldText, stuckLaunchListRemedyLine, stuckLaunchOutageQueryFailedLine, stuckLaunchPostFailedLine, stuckLaunchPostLine, stuckLaunchRelaunchingText, type PendingRowComparison, type PendingRowCover, type PendingRowCoverInput, type PendingRowFields, type PendingRowNotCoveredReason, type PendingRowRuleGet, type PendingRowRuleInput, type PendingRowRunPlacement, type PendingRowRunReading, type PendingRowStepThree, type PendingRowStepThreeInput, type PendingRowUndecidedReason, type PendingRowWaitArmed, type StuckLaunchAbortKillAnswer, type StuckLaunchPostAnswer, type StuckLaunchPostEpisodes, type StuckLaunchPosterDeps, type StuckLaunchTextMark } from '../src/pending-row.ts'
import { describeThrownValue } from '../src/persona-connection-errors.ts'
import { createPersonaEpisodes, killFailureStoppedRetryText, PERSONA_EPISODE_KIND_STUCK_LAUNCH, type PersonaEpisodes } from '../src/persona-episodes.ts'
import {
  personaTmuxSessionName,
  quotedPersonaSessionName,
  renderPersonaRef,
  tmuxExactSessionTarget
} from '../src/persona-identity.ts'
import type { PersonaTeardownWindowState } from '../src/persona-notifier.ts'
import { MAX_TIMER_DELAY_MS } from '../src/persona-retry-schedule.ts'
import { OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL } from '../src/retired-keys.ts'
import { decideOwnRowRead, ROW_READ_LAUNCH_START_NOT_RECORDED } from '../src/row-read-rules.ts'
import { _resetConfigDirFs, _resetFindMissingMemo, _setConfigDirFs, _setFindMissingMemoTtlMs, buildPendingRowRuleDeps, isCscbOwnLaunch, LAUNCH_CALL_END_LAUNCH_TIMEOUT, ownLaunchRecordOf, pendingRowComparisonFor, pendingRowRuleNoEpisodesLine, pendingRowRuleNoEpisodesRelaunchingLine, PERSONA_KILL_STOP_CAUSE_NOT_UP, readPersonaOwnRow, setStuckLaunchEpisodes, type RowPersonaComparison } from '../src/session-manager.ts'
import {
  UNAVAILABLE_RETRY_AGAIN_ROW_PENDING,
  UNAVAILABLE_RETRY_AGAIN_SEQUENCE_STARTED,
  UNAVAILABLE_RETRY_BASE_S,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CEILING_S,
  UNAVAILABLE_RETRY_MODE_PENDING_ONLY,
  UNAVAILABLE_RETRY_ROW_PENDING,
  UNAVAILABLE_RETRY_STOP_LATCHED,
  UNAVAILABLE_RETRY_STOP_ROW_GONE
} from '../src/unavailable-retry.ts'
import { settingsLinesOtherThanValues, writeAgentDirectorConfig, type AdConfigTables } from './test-helpers/ad-settings.ts'
import {
  cannedFindMissing,
  cannedGetResult,
  cannedKillResult,
  cannedListRow,
  cannedStatusResult,
  errCallTimeout,
  errConfigMalformed,
  errInstanceIdCollision,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSessionCreateStaysPending,
  errTmuxUnresponsive,
  holdFindMissing,
  SAMPLE_LAUNCH_START_FRACTIONAL,
  SAMPLE_LAUNCH_START_WHOLE,
  SAMPLE_LAUNCH_STARTS,
  type CannedRowPersona,
  type StubClientOptions
} from './test-helpers/agent-director-stub.ts'
import {
  CSCB_OWN_LINE_FORBIDDEN,
  cscbOwnLineForbiddenIn,
  expectedLatchRecord,
  LAUNCH_START_CASE_ROWS,
  SESSION_ENDING_COMMAND_FORMS,
  sessionEndingCommandsIn,
  STUCK_LAUNCH_ABORT_CONFLICT_CASE_ROWS,
  STUCK_LAUNCH_ABORT_UNUSABLE_NAME_CASE_ROWS,
} from './test-helpers/conflict-cases.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, sentinelInMessage, withoutName } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { PRE_PERSONA_ID } from './test-helpers/old-life.ts'
import {
  judgeMissingFrom,
  judgeMissingFromG,
  judgeNotJudged,
  judgeUnverified,
  launchStartText,
  makePendingRowModel,
  PENDING_ROW_MODEL_NO_ROW,
  type PendingRowModel,
  type PendingRowModelOptions,
  type PendingRowModelVerb
} from './test-helpers/pending-row-model.ts'
import {
  adConfigMalformedRaiseLines,
  DISPATCHER_BUG_WORDING,
  dispatcherBugWordingIn,
  expectPendingOnlyWatch,
  killFailureLines,
  killFailureNotice,
  killFailurePostedLine,
  launchByAnotherProcess,
  launchOwnPending,
  makeRecoveryHarness,
  ordinaryAlertContent,
  personaOf,
  reArmedLine,
  recordSequenceStarts,
  retryLinesOf,
  retryNow,
  scriptModelLaunch,
  type RecoveryHarness,
  type RecoveryHarnessOptions
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
// parseLaunchStart — valid forms (with or without the fraction)
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
// parseLaunchStart — no launch start (absent or unparseable = none)
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
// isPendingWithNoLaunchStart
// ---------------------------------------------------------------------------

/** A `status` result, `get` row and `list` row with the given fields. */
const ROW_FORMS: ReadonlyArray<[string, (fields: PendingRowFields) => PendingRowFields]> = [
  ['status result', (fields) => cannedStatusResult(fields)],
  ['get row', (fields) => cannedGetResult({ instance_id: 'cscb_alpha', ...fields })],
  ['list row', (fields) => cannedListRow({ instance_id: 'cscb_alpha', ...fields })],
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
// parseLaunchStart over the stub's rows
// ---------------------------------------------------------------------------

/**
 * Launch starts as a row carries them, with the instant each names: the
 * stub's sample forms (with fractional seconds, without, none), a
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
// A `pending` row's ageing
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
    expect(settingsLinesOtherThanValues(lines, settingsHome)).toEqual([])
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
 * may read.
 */
function resumedRow(raw: string, startedAtMs: number): ReturnType<typeof cannedGetResult> {
  return cannedGetResult({
    instance_id: 'cscb_alpha',
    state: 'pending',
    launch_started_at: raw,
    started_at: new Date(startedAtMs).toISOString(),
  })
}

/** Both forms of G a check or an arm takes: the accessor itself, and its value read as a number. */
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

  test('a G beyond the timer maximum at the pending wait\'s arm (; the rule\'s harness has its own case at a retry): no fire after 1 ms, one timer at a time none asking more than the maximum, and one fire exactly at launch start + G', async () => {
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
// own-row leg: a configured persona's own row with no launch start
// ---------------------------------------------------------------------------

describe('a configured persona\'s own pending row with no launch start latches through \'s decision and is never aged or armed', () => {
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
// Whether a `pending` row is covered
// ---------------------------------------------------------------------------

/** A row comparison that matches P: `cwd` and `config_dir` label both P's, both directories resolved. */
const MATCHING: PendingRowComparison = { cwdMatches: true, cwdCheckDeferred: false, configDirResolved: true, configDirMatches: true }
/** The comparison of a row whose `cwd` resolves elsewhere. */
const CWD_ELSEWHERE: Partial<PendingRowComparison> = { cwdMatches: false }
/** The comparison when neither P's working directory nor the row's `cwd` resolves now. */
const CWD_UNRESOLVED: Partial<PendingRowComparison> = { cwdMatches: false, cwdCheckDeferred: true }
/** The comparison when P's `claude_config_dir` does not resolve: no label verdict. */
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

describe('decidePendingRowCover: whether a pending row is P\'s current life, never for an own row with no launch start', () => {
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

  // (ruling R8): at a status-only site a directory that cannot be
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

  // (the design note): every shape, covered or not, answers "no launch start".
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
// The status-only sites' comparison (design A3)
// ---------------------------------------------------------------------------

/** A row comparison as `compareRowToPersona` answers it: both directories resolved and the row matching P, unless `overrides` says otherwise. */
function rowComparison(overrides: Partial<RowPersonaComparison> = {}): RowPersonaComparison {
  return {
    ...MATCHING,
    workingDirectoryResolved: true,
    tagPrompt: true,
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
// The stuck-launch post's texts, pinned: the one literal block
// ---------------------------------------------------------------------------

describe('the stuck-launch post\'s texts, pinned', () => {
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
// The stuck-launch post's builders, through the exports
// ---------------------------------------------------------------------------

/** Persona keys for the builder cases: two that prefix one another, and one with no digit. */
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

describe('stuckLaunchRelaunchingText: B in whole minutes, rounded down, and P\'s quoted session', () => {
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

})

describe('both texts name P\'s own session, quoted', () => {
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

describe('stuckLaunchHeldText: with and without the attach line', () => {
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

describe('the launch start in the held text: one renderer, ISO 8601 UTC ending in Z (hatch A3)', () => {
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

describe('neither stuck-launch text names a session-ending command (C22)', () => {
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
    // Every `-t` target any line names is an exact one (no tmux target without `=`).
    const targets = lines.flatMap((line) => [...line.matchAll(/-t\s+(\S+)/g)].map((match) => match[1]!))
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) expect(target.startsWith(tmuxExactSessionTarget(''))).toBe(true)
  })

  test('no text calls anything a "dispatcher bug"', () => {
    for (const text of everyStuckLaunchText()) expect(text).not.toMatch(DISPATCHER_BUG_WORDING)
  })
})

// ---------------------------------------------------------------------------
// The stuck-launch posters
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

describe('the stuck-launch posters: each text at most once per stuck-launch episode', () => {
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

describe('the stuck-launch posters: nothing posted and no episode begun while tmux-unavailable is raised (step 3)', () => {
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

describe('the stuck-launch posters: closed episodes, a submitted teardown, and failures', () => {
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

  test('an episodes call that throws: failed (never suppressed, the tmux-unavailable gate\'s answer), with its one line, and nothing posted', () => {
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

    for (const text of TEXT_CASES) expect(text.post(deps, P)).toBe(STUCK_LAUNCH_POST_FAILED)
    expect(STUCK_LAUNCH_POST_FAILED).not.toBe(STUCK_LAUNCH_SUPPRESSED)

    expect(posts).toEqual([])
    expect(lines).toEqual(TEXT_CASES.map(() => stuckLaunchPostFailedLine(P, describeThrownValue(err))))
    assertNoLeak(lines)
  })

  test('the session manager\'s held poster with no episodes instance: failed (never suppressed, the tmux-unavailable gate\'s answer), with its one line', () => {
    setStuckLaunchEpisodes(undefined)
    const lines: string[] = []
    const deps = buildPendingRowRuleDeps({ appliedPersona: () => undefined, log: (line) => void lines.push(line) })

    expect(deps.postHeld(P, RULE_START, false)).toBe(STUCK_LAUNCH_POST_FAILED)

    expect(lines).toEqual([pendingRowRuleNoEpisodesLine(P)])
  })

  test('the session manager\'s relaunching poster with no episodes instance: its line, then the abort skipped for the failed post; kept, no kill', async () => {
    setStuckLaunchEpisodes(undefined)
    const lines: string[] = []
    const deps = buildPendingRowRuleDeps({ appliedPersona: () => undefined, log: (line) => void lines.push(line) })

    expect(await deps.ownLaunch!.relaunch(P, renderPersonaRef(P), RULE_START)).toEqual({ kind: PENDING_ROW_RELAUNCH_KEPT, why: STUCK_LAUNCH_ABORT_SKIP_POST_FAILED })

    expect(lines).toEqual([pendingRowRuleNoEpisodesRelaunchingLine(P), stuckLaunchAbortSkippedLine(P, STUCK_LAUNCH_ABORT_SKIP_POST_FAILED)])
  })

  test('an episode end that throws: one line describing the error, no episode reported ended, nothing posted', () => {
    const err = new Error(`episodes end refused (${sentinelInMessage('episode-end')})`)
    const lines: string[] = []
    const episodes = { end: (): boolean => { throw err } }

    expect(endStuckLaunchEpisode(episodes, P, stuckLaunchEndRowLiveReason(LIVE_OUT_OF_PENDING), (line) => void lines.push(line))).toBe(false)

    expect(lines).toEqual([stuckLaunchEpisodeEndFailedLine(P, describeThrownValue(err))])
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

describe('isStuckLaunchEpisodeEndState: a live state out of pending ends the episode; pending, ended, missing and no row do not', () => {
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

describe('assertNoLeak over the stuck-launch texts and lines', () => {
  test('a key carrying a fake token: every text and line carries it only as the key, and nothing else token-like', () => {
    const key = `p_${fakeToken(BOT_TOKEN_PREFIX, 'key')}`
    const texts = [
      stuckLaunchRelaunchingText(key, adLaunchBoundMsInEffect()),
      ...HELD_FORMS.map(([, flagged]) => stuckLaunchHeldText(key, POSTED_LAUNCH_START, flagged)),
    ]
    const answers: StuckLaunchPostAnswer[] = [STUCK_LAUNCH_POSTED, STUCK_LAUNCH_ALREADY_POSTED, STUCK_LAUNCH_SUPPRESSED, STUCK_LAUNCH_NOT_POSTED_CLOSED, STUCK_LAUNCH_POST_FAILED]
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

// ---------------------------------------------------------------------------
// The pending-row rule's pure decisions
// ---------------------------------------------------------------------------

describe('pendingRowAgeOf: the rule\'s step from the launch start, G before B, with the derived waits read at each call', () => {
  test.each(VALID_LAUNCH_STARTS)('%s launch start at the defaults: younger than G one tick before G, from G at G and one tick before B, at B at B', (_form, raw) => {
    const launchStartMs = parseLaunchStart(raw)!
    const graceMs = adGraceMsInEffect()
    const boundMs = adLaunchBoundMsInEffect()
    expect(boundMs).toBeGreaterThan(graceMs)

    expect(pendingRowAgeOf(raw, launchStartMs + graceMs - 1)).toBe(PENDING_ROW_AGE_YOUNGER_THAN_G)
    expect(pendingRowAgeOf(raw, launchStartMs + graceMs)).toBe(PENDING_ROW_AGE_FROM_G)
    expect(pendingRowAgeOf(raw, launchStartMs + boundMs - 1)).toBe(PENDING_ROW_AGE_FROM_G)
    expect(pendingRowAgeOf(raw, launchStartMs + boundMs)).toBe(PENDING_ROW_AGE_AT_B)
  })

  test.each(NONE_LAUNCH_STARTS)('a launch start %s: no launch start at any time, with any waits', (_label, raw) => {
    expect(pendingRowAgeOf(raw, Number.MAX_SAFE_INTEGER)).toBe(PENDING_ROW_AGE_NO_LAUNCH_START)
    expect(pendingRowAgeOf(raw, Number.MAX_SAFE_INTEGER, { graceMs: 0, launchBoundMs: 0 })).toBe(PENDING_ROW_AGE_NO_LAUNCH_START)
  })

  test('G is checked first: with B shorter than G, a row past B but not past G is younger than G', () => {
    const waits = { graceMs: 10 * MINUTE_MS, launchBoundMs: MINUTE_MS }
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + 5 * MINUTE_MS, waits)).toBe(PENDING_ROW_AGE_YOUNGER_THAN_G)
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + 10 * MINUTE_MS, waits)).toBe(PENDING_ROW_AGE_AT_B)
  })

  test.each<[string, number | (() => number)]>([
    ['AD_WAIT_NEVER_ENDS', AD_WAIT_NEVER_ENDS],
    ['NaN', Number.NaN],
    ['an accessor answering NaN', () => Number.NaN],
    [
      'an accessor that throws',
      () => {
        throw new Error('unreadable wait')
      },
    ],
  ])('a G of %s: the row is never past G, so neither a lap nor a run is ever due', (_label, graceMs) => {
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, Number.MAX_SAFE_INTEGER, { graceMs, launchBoundMs: 0 })).toBe(PENDING_ROW_AGE_YOUNGER_THAN_G)
  })

  test('a B of AD_WAIT_NEVER_ENDS: from G at any later time, never at B', () => {
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, Number.MAX_SAFE_INTEGER, { graceMs: 0, launchBoundMs: AD_WAIT_NEVER_ENDS })).toBe(PENDING_ROW_AGE_FROM_G)
  })

  test('a G beyond the timer maximum is compared, never armed: younger one tick before launch start + G, from G at it ()', () => {
    const graceMs = MAX_TIMER_DELAY_MS + MINUTE_MS
    const waits = { graceMs, launchBoundMs: graceMs + MINUTE_MS }
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + graceMs - 1, waits)).toBe(PENDING_ROW_AGE_YOUNGER_THAN_G)
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + graceMs, waits)).toBe(PENDING_ROW_AGE_FROM_G)
  })

  test('the accessors are read at each call: a G raised in the settings file moves the next answer', () => {
    const reader = installSettings()
    const oldGraceMs = adGraceMsInEffect()
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + oldGraceMs)).toBe(PENDING_ROW_AGE_FROM_G)

    writeAgentDirectorConfig(settingsHome!, G_DOUBLED)
    reader.read()
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + oldGraceMs)).toBe(PENDING_ROW_AGE_YOUNGER_THAN_G)
    expect(pendingRowAgeOf(SAMPLE_LAUNCH_START_WHOLE, WHOLE_INSTANT + adGraceMsInEffect())).toBe(PENDING_ROW_AGE_FROM_G)
  })
})

describe('readPendingRowRun: the round\'s reading of its run and its get; never step 3 on an earlier read', () => {
  const pendingGet: PendingRowRuleGet = { kind: PENDING_ROW_GET_ROW, state: AGENT_DIRECTOR_PENDING_STATE, launchStartedAt: SAMPLE_LAUNCH_START_WHOLE }
  const refusedErr = errCallTimeout('get')

  test.each<[string, PendingRowRunPlacement, PendingRowRuleGet, PendingRowRunReading]>([
    ['the run latched P (the get is never read)', PENDING_ROW_RUN_LATCHED, pendingGet, { kind: PENDING_ROW_READING_LATCHED }],
    ['the run was refused (the get is never read)', PENDING_ROW_RUN_REFUSED, pendingGet, { kind: PENDING_ROW_READING_RUN_REFUSED }],
    ['the get latched P', PENDING_ROW_RUN_NOT_JUDGED, { kind: PENDING_ROW_GET_LATCHED }, { kind: PENDING_ROW_READING_LATCHED }],
    ['the get failed', PENDING_ROW_RUN_NOT_JUDGED, { kind: PENDING_ROW_GET_REFUSED, error: refusedErr }, { kind: PENDING_ROW_READING_READ_REFUSED, error: refusedErr }],
    ['the get found no row', PENDING_ROW_RUN_MARKED_MISSING, { kind: PENDING_ROW_GET_ABSENT }, { kind: PENDING_ROW_READING_GONE, state: LIVENESS_DEAD_ROW_NO_ROW }],
    ['the get read ended', PENDING_ROW_RUN_NOT_JUDGED, { kind: PENDING_ROW_GET_ROW, state: LIVENESS_DEAD_ROW_ENDED, launchStartedAt: undefined }, { kind: PENDING_ROW_READING_GONE, state: LIVENESS_DEAD_ROW_ENDED }],
    ['the get read missing', PENDING_ROW_RUN_MARKED_MISSING, { kind: PENDING_ROW_GET_ROW, state: LIVENESS_DEAD_ROW_MISSING, launchStartedAt: undefined }, { kind: PENDING_ROW_READING_GONE, state: LIVENESS_DEAD_ROW_MISSING }],
    ['the get read a state CSCB does not know', PENDING_ROW_RUN_NOT_JUDGED, { kind: PENDING_ROW_GET_ROW, state: 'starting', launchStartedAt: undefined }, { kind: PENDING_ROW_READING_UNKNOWN_STATE, state: 'starting' }],
  ])('%s', (_label, run, get, reading) => {
    expect(readPendingRowRun(run, get)).toEqual(reading)
  })

  test.each([...AGENT_DIRECTOR_LIVE_STATES].filter((state) => state !== AGENT_DIRECTOR_PENDING_STATE))('the get read %s: live, no action from the rule', (state) => {
    expect(readPendingRowRun(PENDING_ROW_RUN_NOT_JUDGED, { kind: PENDING_ROW_GET_ROW, state, launchStartedAt: undefined })).toEqual({ kind: PENDING_ROW_READING_LIVE, state })
  })

  test.each<[PendingRowRunPlacement, boolean]>([
    [PENDING_ROW_RUN_MARKED_MISSING, true],
    [PENDING_ROW_RUN_LEFT_LIVE, true],
    [PENDING_ROW_RUN_JUDGED_ALIVE, true],
    [PENDING_ROW_RUN_NOT_JUDGED, false],
    [PENDING_ROW_RUN_FAILED, false],
  ])('the run placed the row %s and the get still reads pending: judged %p, with the get\'s own launch start', (run, judged) => {
    expect(readPendingRowRun(run, { ...pendingGet, launchStartedAt: SAMPLE_LAUNCH_START_FRACTIONAL })).toEqual({
      kind: PENDING_ROW_READING_PENDING,
      judged,
      launchStartedAt: SAMPLE_LAUNCH_START_FRACTIONAL,
    })
  })
})

describe('decidePendingRowStepThree: still pending at B, judged or not', () => {
  const quiet: PendingRowStepThreeInput = {
    tmuxUnavailableRaised: false,
    latched: false,
    ownLaunch: false,
    configMalformedRaised: false,
    abortAvailable: false,
    metNotInteractive: false,
  }
  const flags = ['latched', 'ownLaunch', 'configMalformedRaised', 'abortAvailable', 'metNotInteractive'] as const

  test('tmux-unavailable raised wins over every other input, in every combination', () => {
    for (let mask = 0; mask < 1 << flags.length; mask++) {
      const input = { ...quiet, tmuxUnavailableRaised: true, ...Object.fromEntries(flags.map((flag, i) => [flag, (mask & (1 << i)) !== 0])) }
      expect(decidePendingRowStepThree(input)).toEqual({ kind: PENDING_ROW_STEP3_TMUX_UNAVAILABLE })
    }
  })

  test.each<[string, Partial<PendingRowStepThreeInput>, PendingRowStepThree]>([
    ['P latched (whatever else)', { latched: true, ownLaunch: true, abortAvailable: true }, { kind: PENDING_ROW_STEP3_LATCHED }],
    ['CSCB\'s own launch, its abort available', { ownLaunch: true, abortAvailable: true }, { kind: PENDING_ROW_STEP3_RELAUNCH }],
    ['CSCB\'s own launch, its abort available, ad-config-malformed raised', { ownLaunch: true, abortAvailable: true, configMalformedRaised: true }, { kind: PENDING_ROW_STEP3_CONFIG_MALFORMED }],
    ['CSCB\'s own launch, its abort spent: the held text', { ownLaunch: true }, { kind: PENDING_ROW_STEP3_HELD, attachLine: true }],
    ['CSCB\'s own launch, its abort spent, ad-config-malformed raised: neither text', { ownLaunch: true, configMalformedRaised: true }, { kind: PENDING_ROW_STEP3_CONFIG_MALFORMED }],
    ['any other row: the held text with the attach line', {}, { kind: PENDING_ROW_STEP3_HELD, attachLine: true }],
    ['any other row, ad-config-malformed raised: still the held text', { configMalformedRaised: true }, { kind: PENDING_ROW_STEP3_HELD, attachLine: true }],
    ['any other row whose launch met ErrSpawnNotInteractive: the held text without the attach line', { metNotInteractive: true }, { kind: PENDING_ROW_STEP3_HELD, attachLine: false }],
  ])('%s', (_label, input, expected) => {
    expect(decidePendingRowStepThree({ ...quiet, ...input })).toEqual(expected)
  })
})
const RULE_START = SAMPLE_LAUNCH_START_WHOLE

/** A kill answer of `kind` (`try-later` as UNAVAILABLE), with a fixed description. */
function abortKillAnswer(kind: StuckLaunchAbortKillAnswer['kind'], killSent?: boolean): StuckLaunchAbortKillAnswer {
  const description = `the case's ${kind} outcome`
  if (kind === STUCK_LAUNCH_ABORT_KILL_TRY_LATER) return { kind, errorClass: AD_ERROR_CLASS_UNAVAILABLE, description }
  if (kind === STUCK_LAUNCH_ABORT_KILL_SUCCEEDED && killSent !== undefined) return { kind, killSent, description }
  return { kind, description } as StuckLaunchAbortKillAnswer
}

/** The fixed start of the abort's kill line for `answer` (everything before what follows). */
const abortKillLineStart = (answer: StuckLaunchAbortKillAnswer, key = P): string => stuckLaunchAbortKillLine(key, answer, '').split(' — ')[0]!

// ---------------------------------------------------------------------------
// The pending-row rule on the recovery harness
// ---------------------------------------------------------------------------

/** The harness of the rule's harness cases; `afterEach` leak-checks and cleans it up. */
let ruleHarness: RecoveryHarness | undefined

/** A rule harness (both settings 0, the rule installed as `main()` installs it), with `options`. */
function ruleHarnessOf(options: RecoveryHarnessOptions = {}): { h: RecoveryHarness; p: string } {
  const h = (ruleHarness = makeRecoveryHarness(options))
  expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
  // Every run must make a new find-missing call however long the memo window (bypassing).
  _setFindMissingMemoTtlMs(Number.MAX_SAFE_INTEGER)
  return { h, p: h.keys[0]! }
}

/** Replace the model's knob `name` with `wrap` over it (the model's own answer stays reachable). */
function wrapModelKnob<K extends 'spawnFn' | 'resumeFn' | 'getFn' | 'readPaneFn' | 'findMissingFn' | 'killFn'>(
  h: RecoveryHarness,
  name: K,
  wrap: (model: NonNullable<StubClientOptions[K]>) => NonNullable<StubClientOptions[K]>,
): void {
  const model = (h.stub.calls as StubClientOptions)[name]
  if (model === undefined) throw new Error(`wrapModelKnob: the model installed no ${name}`)
  h.script({ [name]: wrap(model as NonNullable<StubClientOptions[K]>) } as Partial<StubClientOptions>)
}

/** Whether a stub call's params ask the lap's read: the rule's `read-pane` (40 lines, `allow_pending`). */
const isLapRead = (params: unknown): boolean => (params as { allow_pending?: unknown }).allow_pending === true

/** One origin of a covered `pending` row for how P's row comes to read `pending` with P's timer armed pending-only. */
interface RuleOrigin {
  readonly name: string
  /** Bring P's row about over `model` (P's own options merged in) and settle; answers the row. */
  begin(h: RecoveryHarness, p: string, model: PendingRowModelOptions): Promise<PendingRowModel>
}

/** P's row found `pending` at the start pass: its launch start now, the start pass's spawn colliding with it. */
const ORIGIN_START_PASS: RuleOrigin = {
  name: 'a row found pending at the start pass',
  async begin(h, p, model) {
    const row = makePendingRowModel(h, p, { launchStartedAt: launchStartText(h.clock.now()), launches: [errInstanceIdCollision()], ...model })
    await h.launch(p)
    await h.settle()
    return row
  },
}

/** A launch call that fails having left P's row `pending` (HO rev 28): which call of P's own id, and its answer. */
interface FailedLaunch {
  /** A plain spawn, a reuse spawn (`reuse_finished`) or a `resume`. */
  readonly call: 'plain spawn' | 'reuse spawn' | 'resume'
  readonly error: () => Error
}

/** P's next `launch.call` leaves `row` `pending`, its launch start the clock's now, and answers `launch.error()`; every other call is the model's. */
function failNextLaunch(h: RecoveryHarness, row: PendingRowModel, launch: FailedLaunch): void {
  let used = false
  const fail = (): Error => {
    used = true
    row.setState(AGENT_DIRECTOR_PENDING_STATE)
    row.setLaunchStartedAt(launchStartText(h.clock.now()))
    return launch.error()
  }
  if (launch.call === 'resume') {
    wrapModelKnob(h, 'resumeFn', (modelResume) => (params) => (used || params.instance_id !== row.instanceId ? modelResume(params) : fail()))
    return
  }
  const reuse = launch.call === 'reuse spawn'
  wrapModelKnob(h, 'spawnFn', (modelSpawn) => (params) => (used || params.instance_id !== row.instanceId || 'reuse_finished' in params !== reuse ? modelSpawn(params) : fail()))
}

/** A failed fresh spawn: no row, then the spawn leaves the row `pending` and answers `ErrTmuxSessionCreate` (`launchError`, for the outage case). */
function failedSpawnOrigin(launchError: () => Error = () => errTmuxSessionCreateStaysPending('spawn')): RuleOrigin {
  return {
    name: 'a failed fresh spawn',
    async begin(h, p, model) {
      const row = makePendingRowModel(h, p, { ...model, state: PENDING_ROW_MODEL_NO_ROW })
      failNextLaunch(h, row, { call: 'plain spawn', error: launchError })
      await h.launch(p)
      await h.settle()
      return row
    },
  }
}

const ORIGIN_SERVER_RESTART: RuleOrigin = {
  name: 'a server restart mid-launch',
  async begin(h, p, model) {
    const row = makePendingRowModel(h, p, { ...model, state: PENDING_ROW_MODEL_NO_ROW })
    await h.launch(p)
    await h.settle()
    expect(row.state()).toBe(AGENT_DIRECTOR_PENDING_STATE)
    await h.restartServer(p)
    row.scriptLaunches(errInstanceIdCollision())
    await h.launch(p)
    await h.settle()
    return row
  },
}

const RULE_ORIGINS: ReadonlyArray<readonly [string, RuleOrigin]> = [ORIGIN_START_PASS, failedSpawnOrigin(), ORIGIN_SERVER_RESTART].map((origin) => [origin.name, origin] as const)

/** One retry of P's timer as a case saw it: when, after which wait, and what P's row was asked. */
interface RuleRound {
  readonly at: number
  readonly waitMs: number
  readonly verbs: PendingRowModelVerb[]
  /** Refusals in a row once it settled (undefined once the timer stopped). */
  readonly refusals: number | undefined
  /** P's held posts so far. */
  readonly posts: number
  /** The retry's number on P's timer (`h.attempts`). */
  readonly retry: number
  /** The retry timer's last line for P after the round (its re-armed or stopped line). */
  readonly retryLine: string | undefined
}

/** Every post to P's destination in `h`, in order: the session manager's, the outage state's, the episodes' and the lost-message driver's. */
const noticesOf = (h: RecoveryHarness, p: string): string[] =>
  [...h.notices, ...h.outageNotices, ...h.episodeNotices, ...h.lostMessageNotices].filter((notice) => notice.key === p).map((notice) => notice.text)

const readPaneTimesOf = (h: RecoveryHarness, row: PendingRowModel, fromMs = 0): number[] =>
  h.timedCalls.filter((call) => call.verb === 'readPane' && call.instanceId === row.instanceId && call.at >= fromMs).map((call) => call.at)

/** P's stuck-launch held posts in `h`. */
const heldPostsOf = (h: RecoveryHarness, p: string): string[] =>
  h.episodeNotices.filter((notice) => notice.key === p && notice.text.startsWith(STUCK_LAUNCH_HELD_HEAD)).map((notice) => notice.text)

/** The number of P's last retry in `h`. */
const lastRetryOf = (h: RecoveryHarness, p: string): number => h.attempts.filter((attempt) => attempt.key === p).at(-1)!.retry

/** The retry timer's re-armed line for a pending-only retry `retry` of P that its rule kept on the pending row (`reason`), after `refusals` refusals. */
const pendingOnlyReArmedLine = (p: string, retry: number, refusals: number, reason: string = UNAVAILABLE_RETRY_AGAIN_ROW_PENDING): string =>
  reArmedLine(p, retry, reason, refusals, { ranPendingOnly: true })

/** Run `count` retries of P's timer, each settled, recording each round. */
async function runRounds(h: RecoveryHarness, p: string, row: PendingRowModel, count: number): Promise<RuleRound[]> {
  const rounds: RuleRound[] = []
  for (let i = 0; i < count; i++) {
    const waitMs = h.controller.view(p)!.waitMs!
    const before = row.calls.length
    const at = await retryNow(h, p)
    rounds.push({
      at,
      waitMs,
      verbs: row.calls.slice(before).map((call) => call.verb),
      refusals: h.controller.view(p)?.refusals,
      posts: heldPostsOf(h, p).length,
      retry: lastRetryOf(h, p),
      retryLine: retryLinesOf(h, p).at(-1),
    })
  }
  return rounds
}

/** The waits of P's timer from its arm: the base, doubling, up to the ceiling (`src/unavailable-retry.ts`). */
const timerWaits = (count: number): number[] =>
  Array.from({ length: count }, (_, i) => Math.min(UNAVAILABLE_RETRY_BASE_S * 2 ** i, UNAVAILABLE_RETRY_CEILING_S) * MS_PER_SECOND)

/** The verbs of a retry that reads P's `pending` row and stops there (a refusal): its `status`, then the read-and-step `get`. */
const READ_ONLY_ROUND: PendingRowModelVerb[] = ['status', 'get']
/** The verbs of a retry whose rule round laps an empty pane, runs and reads: no keystroke. */
const LAP_RUN_ROUND: PendingRowModelVerb[] = ['status', 'get', 'find-missing', 'get']
/** The model's verbs of such a round whose lap read-pane a case answered itself (an error, never reaching the model). */
const FAILED_LAP_RUN_ROUND: PendingRowModelVerb[] = ['status', 'get', 'find-missing', 'get']

/** P's rule round lines (`[slack] pending-row: <ref> rule (<origin>)`) in `h.errors`. */
function ruleLinesOf(h: RecoveryHarness, p: string, origin: PendingRowInputOrigin = PENDING_ROW_RULE_ORIGIN_RETRY): string[] {
  const ref = renderPersonaRef(personaOf(h, p).name, p)
  const head = `${PENDING_ROW_RULE_LOG_HEAD} ${ref} rule (${origin})`
  return h.errors.filter((line) => line.startsWith(head))
}

/** A rule input's origin. */
type PendingRowInputOrigin = PendingRowRuleInput['origin']

/** The launch-path verbs that must never reach a `pending` row: no kill and no launch over it. */
const KILL_OR_LAUNCH: readonly PendingRowModelVerb[] = ['kill', 'spawn', 'resume']

/** `afterEach` of the rule's harness cases: the seams reset, the case's harness leak-checked and cleaned up. */
function cleanUpRuleHarness(): void {
  const h = ruleHarness
  ruleHarness = undefined
  _resetConfigDirFs()
  _resetFindMissingMemo()
  if (h === undefined) return
  try {
    assertNoLeak(h.captured())
  } finally {
    h.cleanup()
  }
}

describe('the pending-row rule on the recovery harness', () => {
  afterEach(cleanUpRuleHarness)

  //.
  test.each(RULE_ORIGINS)(', %s: nothing before G; from G a lap and a bypassing run, then the get, on the timer; nothing more before B; waits doubling to the ceiling; one held post at B naming the session; no kill or launch while pending; the post is the persona\'s only notice; brought up once marked missing', async (_name, origin) => {
    const { h, p } = ruleHarnessOf()
    const row = await origin.begin(h, p, { judgment: judgeNotJudged })
    expectPendingOnlyWatch(h, p)
    const launchStartMs = row.launchStartMs()!
    const graceMs = adGraceMsInEffect()
    const boundMs = adLaunchBoundMsInEffect()
    const fromOrigin = row.calls.length
    const findMissingBefore = h.callTimes('findMissing').length
    const noticesBefore = noticesOf(h, p)

    const rounds = await runRounds(h, p, row, 6)

    // Each round before G only reads; from G the lap, the bypassing run and the get, each round a refusal.
    expect(rounds.some((round) => round.at < launchStartMs + graceMs)).toBe(true)
    expect(rounds.some((round) => round.at >= launchStartMs + graceMs && round.at < launchStartMs + boundMs)).toBe(true)
    for (const round of rounds) expect(round.verbs).toEqual(round.at < launchStartMs + graceMs ? READ_ONLY_ROUND : LAP_RUN_ROUND)
    expect(rounds.map((round) => round.refusals)).toEqual(rounds.map((_, i) => i + 1))
    expect(rounds.map((round) => round.waitMs)).toEqual(timerWaits(rounds.length))
    // Every round, before G, from G and at B alike, re-arms the timer on the pending row, pending-only.
    expect(rounds.map((round) => round.retryLine)).toEqual(rounds.map((round) => pendingOnlyReArmedLine(p, round.retry, round.refusals!)))
    expect(h.controller.view(p)).toMatchObject({ phase: 'waiting', mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
    // A new find-missing call at every round from G, the memo notwithstanding.
    expect(h.callTimes('findMissing').slice(findMissingBefore)).toEqual(rounds.filter((round) => round.at >= launchStartMs + graceMs).map((round) => round.at))
    // One round line per acting round; none for a round younger than G.
    expect(ruleLinesOf(h, p)).toHaveLength(rounds.filter((round) => round.at >= launchStartMs + graceMs).length)

    // The held post at the first round at or past B, once, naming P's session.
    for (const round of rounds) expect(round.posts).toBe(round.at >= launchStartMs + boundMs ? 1 : 0)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), false)])
    expect(heldPostsOf(h, p)[0]).toContain(quotedPersonaSessionName(p))
    // while the launch does not report in, the held post is the persona's only post about it.
    expect(noticesOf(h, p).slice(noticesBefore.length)).toEqual(heldPostsOf(h, p))
    // Never a kill or a launch while pending.
    expect(row.calls.slice(fromOrigin).filter((call) => KILL_OR_LAUNCH.includes(call.verb))).toEqual([])

    // Marked missing: the retry hands P to the restart path's decision, which brings P up with no kill.
    row.setJudgment(judgeMissingFrom(h.clock.now()))
    const before = row.calls.length
    await retryNow(h, p)
    const verbs = row.calls.slice(before).map((call) => call.verb)
    expect(verbs.slice(0, LAP_RUN_ROUND.length)).toEqual(LAP_RUN_ROUND)
    expect(verbs).toContain('spawn')
    expect(verbs).not.toContain('kill')
    expect(h.stops).toContainEqual({ key: p, reason: UNAVAILABLE_RETRY_STOP_ROW_GONE })
    expect(row.state()).toBe(AGENT_DIRECTOR_PENDING_STATE)
    expect(row.launchStartMs()).toBeGreaterThan(launchStartMs)
    // (unit half): no post or line of the whole case, the origin's own included, calls anything a "dispatcher bug".
    expect(dispatcherBugWordingIn(h)).toEqual([])
  })

  // conditions: the timer keeps running while the row is pending.

  // outage: no held post while tmux-unavailable is raised; step 3 at the first retry after it clears.
  test(', a row left pending by a plain spawn\'s ErrTmuxNotAvailable: no held post while tmux-unavailable stays raised past B; the held post at the first retry after it clears', async () => {
    const { h, p } = ruleHarnessOf()
    const row = await failedSpawnOrigin(() => errTmuxNotAvailable(undefined, 'spawn')).begin(h, p, { })
    expect(getOutageFlags(p).has('tmux-unavailable')).toBe(true)
    const launchStartMs = row.launchStartMs()!
    const boundMs = adLaunchBoundMsInEffect()
    // Every lap's read-pane answers ENVIRONMENT until the case stops it: the outage stays raised.
    let failLaps = true
    wrapModelKnob(h, 'readPaneFn', (modelReadPane) => (params) => (failLaps && isLapRead(params) ? errTmuxNotAvailable(undefined, 'read-pane') : modelReadPane(params)))

    await retryUntil(h, p, launchStartMs + boundMs)
    const [pastB] = await runRounds(h, p, row, 1)
    expect(pastB!.at).toBeGreaterThanOrEqual(launchStartMs + boundMs)
    expect(pastB!.verbs).toEqual(FAILED_LAP_RUN_ROUND)
    expect(readPaneTimesOf(h, row, pastB!.at)).toEqual([])
    expect(getOutageFlags(p).has('tmux-unavailable')).toBe(true)
    expect(heldPostsOf(h, p)).toEqual([])

    failLaps = false
    clearOutageFlag(p, 'tmux-unavailable')
    const [cleared] = await runRounds(h, p, row, 1)
    expect(getOutageFlags(p).has('tmux-unavailable')).toBe(false)
    expect(cleared!.posts).toBe(1)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), false)])
    // The failed spawn was answered by the case itself, so the model saw no kill or launch at all.
    expect(row.calls.filter((call) => KILL_OR_LAUNCH.includes(call.verb))).toEqual([])
  })

  //.

  //.
  test('from the harness\'s call times, the laps and the runs are never closer than the timer\'s interval in effect', async () => {
    const { h, p } = ruleHarnessOf()
    const row = await ORIGIN_START_PASS.begin(h, p, { })
    const findMissingBefore = h.callTimes('findMissing').length
    const rounds = await runRounds(h, p, row, 7)

    const runs = h.callTimes('findMissing').slice(findMissingBefore)
    const laps = h.timedCalls.filter((call) => call.verb === 'readPane' && call.instanceId === row.instanceId).map((call) => call.at)
    expect(runs.length).toBeGreaterThan(3)
    expect(laps).toEqual([])
    for (let i = 1; i < runs.length; i++) {
      const waitMs = rounds.find((round) => round.at === runs[i])!.waitMs
      expect(runs[i]! - runs[i - 1]!).toBeGreaterThanOrEqual(waitMs)
      expect(waitMs).toBeGreaterThanOrEqual(UNAVAILABLE_RETRY_BASE_S * MS_PER_SECOND)
    }
  })

  // (HO C21 steps 2 and 3).
  test.each<[string, bigint, PendingRowModelOptions['judgment']]>([
    ['pending_grace_seconds at its minimum, the runs leaving the row in neither list', pendingGraceMinimumSeconds(DEFAULT_AD_SETTINGS.tmux.create_timeout_ms, DEFAULT_AD_SETTINGS.tmux.pipe_close_wait_ms), judgeNotJudged],
    ['pending_grace_seconds 400 (B 460 s), the runs leaving the row in neither list', 400n, judgeNotJudged],
    ['pending_grace_seconds 400 (B 460 s), the runs judging the row (unverified_ids) while it stays pending', 400n, judgeUnverified],
  ])(', %s: no escalation, post or kill before B; at B, judged or not, one held post and no kill', async (_label, graceSeconds, judgment) => {
    expect(graceSeconds).not.toBe(DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds)
    const { h, p } = ruleHarnessOf({ adSettings: { tmux: { pending_grace_seconds: graceSeconds } } })
    expect(adGraceMsInEffect()).toBe(Number(graceSeconds) * MS_PER_SECOND)
    const starts = recordSequenceStarts()
    const row = await ORIGIN_START_PASS.begin(h, p, { judgment })
    const launchStartMs = row.launchStartMs()!
    const boundMs = adLaunchBoundMsInEffect()

    const rounds: RuleRound[] = []
    while (rounds.length === 0 || rounds.at(-1)!.at < launchStartMs + boundMs) rounds.push(...(await runRounds(h, p, row, 1)))
    rounds.push(...(await runRounds(h, p, row, 1)))

    expect(rounds.filter((round) => round.at >= launchStartMs + adGraceMsInEffect() && round.at < launchStartMs + boundMs).length).toBeGreaterThan(0)
    for (const round of rounds) expect(round.posts).toBe(round.at >= launchStartMs + boundMs ? 1 : 0)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), false)])
    expect([starts, row.callTimes('kill'), h.notices.filter((n) => n.key === p)]).toEqual([[], [], []])
  })

  // ( bullet 1): the rule's legs measure from the launch start, never from started_at.
  test.each([
    ['whole', 10 * MINUTE_MS],
    ['fractional', 10 * MINUTE_MS + 123],
  ])(', a resumed row whose started_at is older than G and whose launch start (%s form) is recent: no lap, run or post before G from the launch start, and no held post before B from it', async (_form, launchStartMs) => {
    const { h, p } = ruleHarnessOf()
    await h.clock.advanceTo(launchStartMs)
    const graceMs = adGraceMsInEffect()
    const boundMs = adLaunchBoundMsInEffect()
    const row = await ORIGIN_START_PASS.begin(h, p, { startedAt: new Date(launchStartMs - 2 * boundMs).toISOString() })
    expect(row.launchStartedAt()).toBe(launchStartText(launchStartMs))
    expect(row.launchStartMs()).toBe(launchStartMs)
    expect(row.getRow().started_at).toBe(new Date(launchStartMs - 2 * boundMs).toISOString())

    const rounds = await runRounds(h, p, row, 5)
    const lapsAt = h.timedCalls.filter((call) => call.verb === 'readPane' && call.instanceId === row.instanceId).map((call) => call.at)
    expect(rounds[0]!.at).toBeLessThan(launchStartMs + graceMs)
    expect(lapsAt).toEqual([])
    expect(lapsAt.every((at) => at >= launchStartMs + graceMs)).toBe(true)
    expect(h.callTimes('findMissing').every((at) => at >= launchStartMs + graceMs)).toBe(true)
    expect(rounds.some((round) => round.at < launchStartMs + boundMs && round.at >= launchStartMs + graceMs)).toBe(true)
    for (const round of rounds) expect(round.posts).toBe(round.at >= launchStartMs + boundMs ? 1 : 0)
  })

  // never-early waits through the accessors.
  test(', a G raised while P\'s timer waits delays the first lap and run past the old G to the new one', async () => {
    const { h, p } = ruleHarnessOf()
    const row = await ORIGIN_START_PASS.begin(h, p, { })
    const launchStartMs = row.launchStartMs()!
    const oldGraceMs = adGraceMsInEffect()
    h.rewriteAdSettings({ tmux: { pending_grace_seconds: DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds * 2n } })
    const newGraceMs = adGraceMsInEffect()
    expect(newGraceMs).toBe(2 * oldGraceMs)

    const rounds = await runRounds(h, p, row, 4)
    expect(rounds.some((round) => round.at >= launchStartMs + oldGraceMs && round.at < launchStartMs + newGraceMs)).toBe(true)
    for (const round of rounds) expect(round.verbs).toEqual(round.at < launchStartMs + newGraceMs ? READ_ONLY_ROUND : LAP_RUN_ROUND)
  })

  test.each<[string, bigint]>([
    ['a derived G beyond MAX_TIMER_DELAY_MS', BigInt(Math.ceil(MAX_TIMER_DELAY_MS / MS_PER_SECOND)) + 60n],
    ['G at AD_WAIT_NEVER_ENDS', AD_SETTING_INTEGER_MAX],
  ])('E6, %s: retries well past the default G and B make no lap, run or post, and the timer keeps running', async (_label, graceSeconds) => {
    const { h, p } = ruleHarnessOf({ adSettings: { tmux: { pending_grace_seconds: graceSeconds } } })
    expect(adGraceMsInEffect()).toBeGreaterThan(MAX_TIMER_DELAY_MS)
    const row = await ORIGIN_START_PASS.begin(h, p, { })
    const rounds = await runRounds(h, p, row, 8)
    expect(rounds.at(-1)!.at - row.launchStartMs()!).toBeGreaterThan(2 * adLaunchBoundMs(DEFAULT_AD_SETTINGS_IN_EFFECT))
    for (const round of rounds) expect(round.verbs).toEqual(READ_ONLY_ROUND)
    expect([h.callTimes('findMissing'), heldPostsOf(h, p), ruleLinesOf(h, p)]).toEqual([[], [], []])
    expect(h.controller.isArmed(p)).toBe(true)
  })

  // lap column, end to end: what is typed, whether the run follows,
  // and the answer's own effect (tmux-unavailable raised, or CONFIG's cause armed).

  // (R13): after a send-keys answered ErrSpawnNotInteractive, no further lap on that launch.
  test.each<[string, number, (h: RecoveryHarness, p: string) => Promise<PendingRowModel>]>([

  ])('after %s answered ErrSpawnNotInteractive: no further lap on that launch (the run still follows each retry), and the held post at B drops the attach line', async (_label, lapsBefore, begin) => {
    const { h, p } = ruleHarnessOf()
    const row = await begin(h, p)
    const launchStartMs = row.launchStartMs()!
    const boundMs = adLaunchBoundMsInEffect()
    const rounds: RuleRound[] = []
    while (rounds.length === 0 || rounds.at(-1)!.at < launchStartMs + boundMs) rounds.push(...(await runRounds(h, p, row, 1)))

    // The one Enter that met it, and at most the one lap that made it; none after.
    expect(h.stub.calls.sendKeysCalls).toHaveLength(1)
    expect(readPaneTimesOf(h, row, launchStartMs + adGraceMsInEffect())).toHaveLength(lapsBefore * 2)
    expect(rounds.filter((round) => round.at >= launchStartMs + adGraceMsInEffect()).every((round) => round.verbs.includes('find-missing'))).toBe(true)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), true)])
    expect(heldPostsOf(h, p)[0]).not.toContain(stuckLaunchAttachRemedyLine(p))
  })

  // no lap, run or kill for a latched P.

  // an own pending row with no launch start latches through read.
  test('an own pending row with no launch start latches through \'s read: no lap, run or kill, and none as time passes', async () => {
    const { h, p } = ruleHarnessOf()
    const row = await ORIGIN_START_PASS.begin(h, p, { launchStartedAt: SAMPLE_LAUNCH_STARTS.none, })
    expect(h.latch.isLatched(p)).toBe(true)
    expect(h.controller.isArmed(p)).toBe(false)
    await h.advance(2 * adLaunchBoundMsInEffect())
    await h.settle()
    expect(row.calls.map((call) => call.verb)).toEqual(['spawn', 'get'])
    expect([h.stub.calls.readPaneCalls, h.callTimes('findMissing'), heldPostsOf(h, p)]).toEqual([[], [], []])
  })

  // bullet 2, no post for an uncovered row; undecided rows get no rule run.
  test('an uncovered pending row past B (its cwd elsewhere): its live-row sequence is started; no lap, run or stuck-launch post', async () => {
    const { h, p } = ruleHarnessOf()
    const row = makePendingRowModel(h, p, { launchStartedAt: launchStartText(0), row: { cwd: h.home } })
    const starts = recordSequenceStarts()
    await h.clock.advanceTo(adLaunchBoundMsInEffect() + MINUTE_MS)
    h.controller.armPendingOnly(p)
    await retryNow(h, p)

    expect(starts).toHaveLength(1)
    expect(row.calls.map((call) => call.verb)).toEqual(['status', 'get'])
    expect([h.stub.calls.readPaneCalls, h.callTimes('findMissing'), heldPostsOf(h, p), ruleLinesOf(h, p)]).toEqual([[], [], [], []])
  })

  test('an undecided pending row past B (its claude_config_dir unresolvable): armed only, with no lap, run or post at any retry', async () => {
    const { h, p } = ruleHarnessOf()
    const row = makePendingRowModel(h, p, { launchStartedAt: launchStartText(0), })
    _setConfigDirFs({ realpath: () => { throw Object.assign(new Error('no such directory'), { code: 'ENOENT' }) } })
    await h.clock.advanceTo(adLaunchBoundMsInEffect() + MINUTE_MS)
    h.controller.armPendingOnly(p)
    const rounds = await runRounds(h, p, row, 3)

    for (const round of rounds) expect(round.verbs).toEqual(READ_ONLY_ROUND)
    expect([h.stub.calls.readPaneCalls, h.callTimes('findMissing'), heldPostsOf(h, p), ruleLinesOf(h, p)]).toEqual([[], [], [], []])
    expect(h.controller.isArmed(p)).toBe(true)
  })

  // The section's ruling: a failed get after the run ends the round; never step 3 on an earlier read.
  test('a failed get after the run at B: nothing more that round and no post; the next retry\'s round posts', async () => {
    const { h, p } = ruleHarnessOf()
    const row = await ORIGIN_START_PASS.begin(h, p, { })
    const launchStartMs = row.launchStartMs()!
    await retryUntil(h, p, launchStartMs + adLaunchBoundMsInEffect())
    // The get right after this round's run (and only this round's) answers UNAVAILABLE.
    let failThisRound = true
    let failNextGet = false
    wrapModelKnob(h, 'findMissingFn', (modelFindMissing) => async (params) => {
      failNextGet = failThisRound
      failThisRound = false
      return modelFindMissing(params)
    })
    wrapModelKnob(h, 'getFn', (modelGet) => (params) => {
      if (!failNextGet || params.instance_id !== row.instanceId) return modelGet(params)
      failNextGet = false
      return errCallTimeout('get')
    })

    const [failed] = await runRounds(h, p, row, 1)
    expect(failed!.verbs).toEqual(['status', 'get', 'find-missing'])
    expect(heldPostsOf(h, p)).toEqual([])
    expect(h.controller.isArmed(p)).toBe(true)
    expect(ruleLinesOf(h, p).at(-1)).toContain(errCallTimeout('get').errName)

    await runRounds(h, p, row, 1)
    expect(heldPostsOf(h, p)).toHaveLength(1)
  })

  // (section reconcile note): no lap, run or post while P's working directory is held for an old life.
  test('while P\'s working directory is held for an old life, a retry on P\'s covered pending row past G makes no read-pane, send-keys or find-missing of its own and posts nothing; once the hold ends, the next retry runs the rule', async () => {
    const { h, p } = ruleHarnessOf()
    const directory = personaOf(h, p).working_directory
    // The old life's row reads live in P's directory, so its wait keeps the hold until its run lists it.
    h.script({ getFn: (params) => (params.instance_id === PRE_PERSONA_ID ? cannedGetResult({ instance_id: PRE_PERSONA_ID, cwd: directory, state: 'waiting' }) : undefined) })
    const row = await ORIGIN_START_PASS.begin(h, p, { })
    const launchStartMs = row.launchStartMs()!
    h.beginOldLifeHold({ instanceId: PRE_PERSONA_ID, oldKey: PRE_PERSONA_ID, directory, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })
    const hold = holdFindMissing(h.stub.client)
    const waited = h.startOldLifeWait(PRE_PERSONA_ID)
    await hold.entered(1)

    while (h.controller.view(p)!.dueAt! < launchStartMs + adLaunchBoundMsInEffect()) {
      await retryNow(h, p, { settle: false })
      await h.advance(0)
    }
    expect(h.clock.now()).toBeGreaterThanOrEqual(launchStartMs + adGraceMsInEffect())
    expect([h.stub.calls.readPaneCalls, h.stub.calls.sendKeysCalls, hold.calls.length, heldPostsOf(h, p)]).toEqual([[], [], 1, []])

    // The old life is listed missing: the hold ends with its wait.
    hold.release(cannedFindMissing({ rows: { [PRE_PERSONA_ID]: 'ids' } }))
    await waited
    expect(h.oldLifeHolds.holdOf(PRE_PERSONA_ID)).toBeUndefined()
    await h.settle()

    await retryNow(h, p, { settle: false })
    await hold.entered(2)
    hold.release(cannedFindMissing({ rows: { [row.instanceId]: 'neither' } }))
    await h.settle()
    expect(h.stub.calls.readPaneCalls!.filter(isLapRead)).toHaveLength(0)
    expect(ruleLinesOf(h, p)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// CSCB's own stuck launch at B on the recovery harness
// ---------------------------------------------------------------------------

/** The session id of the row CSCB's own launch resumed, so the abort's sequence ends in a `resume` that keeps it. */
const OWN_SESSION_ID = 'a-resumed-session'

/** P's relaunching text with B in effect. */
const relaunchingTextOf = (p: string): string => stuckLaunchRelaunchingText(p, adLaunchBoundMsInEffect())

/** P's stuck-launch relaunching posts in `h`. */
const relaunchingPostsOf = (h: RecoveryHarness, p: string): string[] =>
  h.episodeNotices.filter((notice) => notice.key === p && notice.text === relaunchingTextOf(p)).map((notice) => notice.text)

const ABORT_ORIGIN_RETRY = 'a retry of P\'s timer'
type AbortOrigin = typeof ABORT_ORIGIN_RETRY
const ABORT_ORIGINS: readonly AbortOrigin[] = [ABORT_ORIGIN_RETRY]

function ownStuckLaunchOf(
  options: PendingRowModelOptions = {},
  origin: AbortOrigin = ABORT_ORIGIN_RETRY,
  harness: RecoveryHarnessOptions = {},
): { h: RecoveryHarness; p: string; row: PendingRowModel } {
  const { h, p } = ruleHarnessOf({ harnessNow: true, ...harness })
  const row = makePendingRowModel(h, p, {
    state: LIVENESS_DEAD_ROW_ENDED,
    sessionId: OWN_SESSION_ID,
    launches: [errInstanceIdCollision()],
    ...options,
  })
  return { h, p, row }
}

/** One retry of P's timer, its abort kill's waits between tries and any sequence it started driven on the harness clock; answers the retry's time. */
async function retryDriven(h: RecoveryHarness, p: string): Promise<number> {
  const at = await h.drive(retryNow(h, p, { settle: false }))
  await h.drive(h.settle())
  await h.driveSequence(h.sequenceSettled(p))
  return at
}

/** Retry P's timer (each retry settled) until its next retry is the first at or past `atMs`. */
async function retryUntil(h: RecoveryHarness, p: string, atMs: number): Promise<void> {
  while (h.controller.view(p)!.dueAt! < atMs) await retryNow(h, p)
}

/** Retry P's timer until its next retry is the first at or past B from the row's launch start now; answers that B. */
async function retryUntilB(h: RecoveryHarness, p: string, row: PendingRowModel): Promise<number> {
  const atB = row.launchStartMs()! + adLaunchBoundMsInEffect()
  while (h.controller.view(p)!.dueAt! < atB) await retryDriven(h, p)
  return atB
}

async function abortRoundAtB(h: RecoveryHarness, p: string, row: PendingRowModel, _origin: AbortOrigin): Promise<number> {
  await retryUntilB(h, p, row)
  return retryDriven(h, p)
}

/** P's model with no row, so P's launch is a plain spawn the case may time (`scriptModelLaunch`). */
const PLAIN_SPAWN_LAUNCH: PendingRowModelOptions = { state: PENDING_ROW_MODEL_NO_ROW, launches: [] }

const roundVerbsFrom = (h: RecoveryHarness, row: PendingRowModel, fromMs: number): PendingRowModelVerb[] =>
  row.calls.filter((call) => call.at >= fromMs).map((call) => call.verb)

/** The abort's sequence from step 2 after its one kill: a get, a run, a get, then the `resume` keeping the conversation. */
const ABORT_ROUND_TO_RESUME: PendingRowModelVerb[] = ['status', 'get', 'find-missing', 'get', 'kill', 'get', 'find-missing', 'get', 'resume']

/** P's model calls of a launch or a delete (no `delete` is modelled: the stub's own record is read too). */
const launchesOf = (row: PendingRowModel): PendingRowModelVerb[] => row.calls.filter((call) => call.verb === 'spawn' || call.verb === 'resume').map((call) => call.verb)

/** P's abort kill lines in `h`, each up to what follows (its kind and the kill's described outcome). */
function abortKillLinesOf(h: RecoveryHarness, p: string): string[] {
  const head = stuckLaunchAbortKillLine(p, abortKillAnswer(STUCK_LAUNCH_ABORT_KILL_FAILED), '').split(STUCK_LAUNCH_ABORT_KILL_FAILED)[0]!
  return h.errors.filter((line) => line.startsWith(head)).map((line) => line.split(' — ')[0]!)
}

/** The start of P's abort kill line for a success with `kill_sent` as given, its outcome described by `src/checked-kill.ts`. */
const killedLineStart = (p: string, killSent: boolean): string =>
  abortKillLineStart({ kind: STUCK_LAUNCH_ABORT_KILL_SUCCEEDED, killSent, description: describeKillOutcome({ kind: KILL_OUTCOME_KILLED, killSent }) }, p)

/** P's kill-failure alerts with the abort's context as the alerts' own lines record them. */
const abortAlertLinesOf = (h: RecoveryHarness, p: string): string[] =>
  killFailureLines(h, p).filter((line) => line.includes(`(${KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT}`))

/** Everything P's destination got that is not a stuck-launch text: the alerts, the latch notices and any other notice. */
const otherNoticesOf = (h: RecoveryHarness, p: string): string[] =>
  noticesOf(h, p).filter((text) => text !== relaunchingTextOf(p) && !text.startsWith(STUCK_LAUNCH_HELD_HEAD))

describe('CSCB\'s own stuck launch at B: the relaunching post, one checked kill, the live-row sequence from step 2 (recovery harness)', () => {
  afterEach(cleanUpRuleHarness)

  // and step 2 / at B, judged or not, the own launch is aborted.
  test.each<[string, PendingRowModelOptions['judgment']]>([
    ['its runs leaving the row in neither ids nor unverified_ids', judgeNotJudged],
    ['its runs judging it and leaving it live (unverified_ids)', judgeUnverified],
  ])(', a resumed launch CSCB started, held at an unrecognised prompt, %s: at B one relaunching post, one kill with kill_sent true, the sequence from step 2 (no step-1 kill) and a resume of the same row; nothing counted', async (_label, judgment) => {
    const { h, p, row } = ownStuckLaunchOf({ judgment })
    const launchStart = await launchOwnPending(h, row)
    expect(h.stub.calls.resumeCalls).toEqual([{ instance_id: row.instanceId }])

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)

    expect(atB).toBeGreaterThanOrEqual(parseLaunchStart(launchStart)! + adLaunchBoundMsInEffect())
    expect(roundVerbsFrom(h, row, atB).slice(0, ABORT_ROUND_TO_RESUME.length)).toEqual(ABORT_ROUND_TO_RESUME)
    expect(row.callTimes('kill')).toEqual([atB])
    expect(abortKillLinesOf(h, p)).toEqual([killedLineStart(p, true)])
    // The resume of the same row (its session id kept), and no reuse spawn or delete.
    expect(row.getRow().session_id).toBe(OWN_SESSION_ID)
    expect(h.stub.calls.resumeCalls).toEqual([{ instance_id: row.instanceId }, { instance_id: row.instanceId }])
    expect([h.reuseSpawns(), h.stub.calls.deleteCalls]).toEqual([[], []])
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
    expect([heldPostsOf(h, p), otherNoticesOf(h, p), getFailureCount(p)]).toEqual([[], [], 0])
    expect(h.stuckLaunchAbortUsed(p)).toBe(true)
    // The returned launch is recorded when AD's row is next observed.
    await readPersonaOwnRow(p, { site: 'pending-row.test', what: 'observe resumed row' })
    expect([row.state(), row.launchStartMs(), isCscbOwnLaunch(p, row.launchStartedAt())]).toEqual([AGENT_DIRECTOR_PENDING_STATE, atB, true])
  })

  // (HO C21 steps 2 and 3), the own-launch half at non-default
  // G (the held half is in the rule's harness describe above).
  test.each<[string, bigint, PendingRowModelOptions['judgment']]>([
    ['pending_grace_seconds at its minimum, the runs leaving the row in neither list', pendingGraceMinimumSeconds(DEFAULT_AD_SETTINGS.tmux.create_timeout_ms, DEFAULT_AD_SETTINGS.tmux.pipe_close_wait_ms), judgeNotJudged],
    ['pending_grace_seconds 400 (B 460 s), the runs leaving the row in neither list', 400n, judgeNotJudged],
    ['pending_grace_seconds 400 (B 460 s), the runs judging the row (unverified_ids) while it stays pending', 400n, judgeUnverified],
  ])(', CSCB\'s own stuck launch with %s: no post, kill or alert before B while the retries run; at B, judged or not, one relaunching post and one abort, no held post', async (_label, graceSeconds, judgment) => {
    expect(graceSeconds).not.toBe(DEFAULT_AD_SETTINGS.tmux.pending_grace_seconds)
    const { h, p, row } = ownStuckLaunchOf({ judgment }, ABORT_ORIGIN_RETRY, { adSettings: { tmux: { pending_grace_seconds: graceSeconds } } })
    expect(adGraceMsInEffect()).toBe(Number(graceSeconds) * MS_PER_SECOND)
    await launchOwnPending(h, row)
    const launchStartMs = row.launchStartMs()!

    const atB = await retryUntilB(h, p, row)

    expect(h.callTimes('findMissing').some((at) => at >= launchStartMs + adGraceMsInEffect() && at < atB)).toBe(true)
    expect([relaunchingPostsOf(h, p), heldPostsOf(h, p), otherNoticesOf(h, p), row.callTimes('kill')]).toEqual([[], [], [], []])
    expect(h.stuckLaunchAbortUsed(p)).toBe(false)

    const roundAt = await retryDriven(h, p)

    expect(roundAt).toBeGreaterThanOrEqual(atB)
    expect(row.callTimes('kill')).toEqual([roundAt])
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
    expect([heldPostsOf(h, p), otherNoticesOf(h, p), getFailureCount(p)]).toEqual([[], [], 0])
    expect(h.stuckLaunchAbortUsed(p)).toBe(true)
    // The retry is a refusal naming the live-row sequence its rule started, the last row read kept pending.
    expect(retryLinesOf(h, p)).toContain(pendingOnlyReArmedLine(p, lastRetryOf(h, p), h.controller.view(p)!.refusals, UNAVAILABLE_RETRY_AGAIN_SEQUENCE_STARTED))
    expect(h.controller.view(p)).toMatchObject({ mode: UNAVAILABLE_RETRY_MODE_PENDING_ONLY, lastRow: UNAVAILABLE_RETRY_ROW_PENDING })
  })

  // a later launch call of P that answers
  // ErrInstanceIdCollision started no launch, so CSCB's own launch keeps its
  // record and still gets the relaunching post and its abort at B.
  test('a later spawn of P colliding with CSCB\'s own pending launch keeps that launch\'s own-launch record: at B the relaunching post and the abort\'s one kill, no held post', async () => {
    const { h, p, row } = ownStuckLaunchOf({}, ABORT_ORIGIN_RETRY)
    const launchStart = await launchOwnPending(h, row)
    const record = ownLaunchRecordOf(p)
    expect(record).toBeDefined()
    const spawnsBefore = h.stub.calls.spawnCalls.length
    row.scriptLaunches(errInstanceIdCollision())

    await h.launch(p)
    await h.settle()

    expect(h.stub.calls.spawnCalls).toHaveLength(spawnsBefore + 1)
    expect([row.state(), row.launchStartedAt()]).toEqual([AGENT_DIRECTOR_PENDING_STATE, launchStart])
    expect(ownLaunchRecordOf(p)).toEqual(record)
    expect(isCscbOwnLaunch(p, launchStart)).toBe(true)

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)

    expect(row.callTimes('kill')).toEqual([atB])
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
    expect(heldPostsOf(h, p)).toEqual([])
    expect(h.stuckLaunchAbortUsed(p)).toBe(true)
  })

  // a timed-out launch inside its window is CSCB's own; a kill_sent false success goes on to the sequence.
  test(', a launch that timed out with its launch start inside its window: aborted at B; its kill answering kill_sent false goes on to the sequence and its resume', async () => {
    const { h, p, row } = ownStuckLaunchOf({ ...PLAIN_SPAWN_LAUNCH, kill: [cannedKillResult(false)] })
    scriptModelLaunch(h, row, { takesMs: MINUTE_MS, end: LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT })
    await launchOwnPending(h, row)
    expect(ownLaunchRecordOf(p)?.window.end).toBe(LAUNCH_CALL_END_LAUNCH_TIMEOUT)

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)

    expect(row.callTimes('kill')).toEqual([atB])
    expect(abortKillLinesOf(h, p)).toEqual([killedLineStart(p, false)])
    expect(roundVerbsFrom(h, row, atB).slice(0, ABORT_ROUND_TO_RESUME.length)).toEqual(ABORT_ROUND_TO_RESUME)
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
    expect(heldPostsOf(h, p)).toEqual([])
  })

  // every other pending row at B gets the held post and is never killed.
  type NotOwnArrange = (h: RecoveryHarness, p: string, row: PendingRowModel) => Promise<void>
  test.each<[string, PendingRowModelOptions, NotOwnArrange, boolean]>([

    [
      'another process\'s launch over CSCB\'s own',
      {},
      async (h, _p, row) => {
        await launchOwnPending(h, row)
        await h.advance(MS_PER_SECOND)
        launchByAnotherProcess(h, row)
      },
      false,
    ],
    ...(['before', 'after'] as const).map((placement): [string, PendingRowModelOptions, NotOwnArrange, boolean] => [
      `a launch whose launch start lies ${placement} its call's window`,
      PLAIN_SPAWN_LAUNCH,
      async (h, p, row) => {
        scriptModelLaunch(h, row, { takesMs: MINUTE_MS, launchStart: placement })
        await h.launch(p)
        await h.settle()
        expect(ownLaunchRecordOf(p)).toBeUndefined()
      },
      false,
    ]),
  ])('%s: at B the held post, with no relaunching post and no kill', async (_label, model, arrange, flagged) => {
    const { h, p, row } = ownStuckLaunchOf(model, ABORT_ORIGIN_RETRY)
    await arrange(h, p, row)
    const launches = launchesOf(row)

    await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)
    await retryDriven(h, p)

    expect([row.state(), isCscbOwnLaunch(p, row.launchStartedAt())]).toEqual([AGENT_DIRECTOR_PENDING_STATE, false])
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), flagged)])
    expect([relaunchingPostsOf(h, p), row.callTimes('kill'), launchesOf(row)]).toEqual([[], [], launches])
  })

  // Test clause; at most one abort per stuck-launch episode.
  test('a relaunch still pending at B in the same episode: the held text once and no kill, and no second relaunching post', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    await launchOwnPending(h, row)
    await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)
    const relaunchStart = row.launchStartedAt()
    await readPersonaOwnRow(p, { site: 'pending-row.test', what: 'observe resumed row' })
    expect(isCscbOwnLaunch(p, relaunchStart)).toBe(true)

    await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)
    await retryDriven(h, p)

    expect(row.launchStartedAt()).toBe(relaunchStart)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, relaunchStart, false)])
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
    expect(row.callTimes('kill')).toHaveLength(1)
    expect(h.stuckLaunchAbortUsed(p)).toBe(true)
  })

  // ErrTmuxKillFailed after its tries uses the abort; one alert; then the held text once.
  test('the abort kill answering ErrTmuxKillFailed at each of its 3 tries, 2 s apart: one ordinary alert with the stuck-launch abort context; not retried; no launch or delete; the held text once at the next retry, never in the same round', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    const failed = errTmuxKillFailed(personaTmuxSessionName(p))
    row.scriptKill(...Array.from({ length: KILL_RETRY_TRIES }, () => failed))
    await launchOwnPending(h, row)
    const launches = launchesOf(row)

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)

    expect(row.callTimes('kill')).toEqual(Array.from({ length: KILL_RETRY_TRIES }, (_, i) => atB + i * KILL_RETRY_SPACING_MS))
    const alert = ordinaryAlertContent(p, { last: failed })
    expect(otherNoticesOf(h, p)).toEqual([killFailureNotice(p, alert).text])
    expect(abortAlertLinesOf(h, p)).toEqual([killFailurePostedLine(p, alert, KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT)])
    expect([launchesOf(row), h.stub.calls.deleteCalls, heldPostsOf(h, p)]).toEqual([launches, [], []])
    expect(h.stuckLaunchAbortUsed(p)).toBe(true)

    await retryDriven(h, p)
    await retryDriven(h, p)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, row.launchStartedAt(), false)])
    expect([row.callTimes('kill').length, otherNoticesOf(h, p).length, relaunchingPostsOf(h, p).length, launchesOf(row)]).toEqual([KILL_RETRY_TRIES, 1, 1, launches])
  })

  // the abort kill's CONFLICT and UNUSABLE NAME latch P, never retried.
  // End to end kill backstop ("not this launch's session") and one
  // UNUSABLE NAME row; every row is session-manager.test.ts's at unit level.
  const ABORT_KILL_LATCHES: ReadonlyArray<readonly [string, () => Error, (key: string) => ConflictLatchRecord, (key: string) => string]> = [
    ...STUCK_LAUNCH_ABORT_CONFLICT_CASE_ROWS.filter((caseRow) => caseRow.killBackstop === true).map((caseRow) => [
      `CONFLICT (${caseRow.name}kill backstop)`,
      caseRow.build,
      (key: string) =>
        expectedLatchRecord(key, {
          latchCase: caseRow.latchCase,
          refusedOperation: caseRow.refusedOperation,
          rowState: caseRow.rowState,
          sessionName: caseRow.sessionName,
          description: caseRow.build().errDescription,
        }),
      () => caseRow.notice.text,
    ] as const),
    ...STUCK_LAUNCH_ABORT_UNUSABLE_NAME_CASE_ROWS.slice(0, 1).map((caseRow) => [`UNUSABLE NAME (${caseRow.name})`, caseRow.build, caseRow.record, caseRow.notice] as const),
  ]

  test.each(ABORT_KILL_LATCHES)('the abort kill answering %s: P latches with the row\'s record and one post; nothing is sent after the kill (no launch, delete or further call), and it is never tried again', async (_label, error, record, notice) => {
    const { h, p, row } = ownStuckLaunchOf()
    row.scriptKill(error())
    await launchOwnPending(h, row)
    const launches = launchesOf(row)

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)

    expect(roundVerbsFrom(h, row, atB)).toEqual(['status', 'get', 'find-missing', 'get', 'kill'])
    expect(h.latch.record(p)).toEqual(record(p))
    expect(otherNoticesOf(h, p)).toEqual([notice(p)])
    expect(relaunchingPostsOf(h, p)).toEqual([relaunchingTextOf(p)])
    expect(h.stops).toContainEqual({ key: p, reason: UNAVAILABLE_RETRY_STOP_LATCHED })

    await h.advance(2 * adLaunchBoundMsInEffect())
    await h.drive(h.settle())
    expect([row.callTimes('kill'), launchesOf(row), h.stub.calls.deleteCalls, heldPostsOf(h, p), otherNoticesOf(h, p).length]).toEqual([[atB], launches, [], [], 1])
  })

  // contract design A2 and Q-12: the abort's kill is part of the round's attempt; a kill that did nothing is made again at the next retry reaching step 3.
  const ABORT_KILL_ATTEMPTS: ReadonlyArray<readonly [string, () => Error, (h: RecoveryHarness, p: string) => boolean]> = [
    ['ErrTmuxUnresponsive, a tmux-touching UNAVAILABLE: starts tmux-unresponsive', () => errTmuxUnresponsive('kill'), (h, p) => h.tmuxUnresponsive.holds(p)],
    ['ErrCallTimeout, UNAVAILABLE: arms its cause', () => errCallTimeout('kill'), (h, p) => h.triggers.some((t) => t.key === p && t.kind === UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)],
  ]

  test.each(ABORT_ORIGINS.flatMap((origin) => ABORT_KILL_ATTEMPTS.map(([label, make, holds]) => [origin, label, make, holds] as const)))('from %s, the abort kill answering %s at each try: no alert, the abort not used, no launch; the next retry reaching step 3 makes the same abort with no second relaunching post', async (origin, _label, make, holds) => {
    const { h, p, row } = ownStuckLaunchOf({}, origin)
    row.scriptKill(...Array.from({ length: KILL_RETRY_TRIES }, make))
    await launchOwnPending(h, row)
    const launches = launchesOf(row)

    const atB = await abortRoundAtB(h, p, row, origin)

    expect(row.callTimes('kill')).toEqual(Array.from({ length: KILL_RETRY_TRIES }, (_, i) => atB + i * KILL_RETRY_SPACING_MS))
    expect(holds(h, p)).toBe(true)
    expect([h.stuckLaunchAbortUsed(p), launchesOf(row), h.stub.calls.deleteCalls, abortAlertLinesOf(h, p), heldPostsOf(h, p)]).toEqual([false, launches, [], [], []])

    await retryDriven(h, p)
    expect(row.callTimes('kill')).toHaveLength(KILL_RETRY_TRIES + 1)
    expect(launchesOf(row)).toEqual([...launches, 'resume'])
    expect([relaunchingPostsOf(h, p), heldPostsOf(h, p), h.stuckLaunchAbortUsed(p)]).toEqual([[relaunchingTextOf(p)], [], true])
  })

  // ErrTmuxNotAvailable row: no abort while tmux-unavailable is raised; the same abort once it clears.

  // a CONFIG answer raises ad-config-malformed, and the abort waits for it to clear.
  test('the abort kill answering CONFIG: ad-config-malformed raised, no further try, the abort not used and no launch; the next retry\'s reads clear it, and the same abort follows with no second relaunching post', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    row.scriptKill(errConfigMalformed())
    await launchOwnPending(h, row)
    const launches = launchesOf(row)

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)
    expect([row.callTimes('kill'), adConfigMalformedRaiseLines(h, p).length, h.stuckLaunchAbortUsed(p), launchesOf(row)]).toEqual([[atB], 1, false, launches])

    const retryAt = await retryDriven(h, p)
    expect(getOutageFlags(p).has('ad-config-malformed')).toBe(false)
    expect(row.callTimes('kill')).toEqual([atB, retryAt])
    expect([relaunchingPostsOf(h, p), heldPostsOf(h, p), h.stuckLaunchAbortUsed(p)]).toEqual([[relaunchingTextOf(p)], [], true])
  })

  // an abort kill stop rule stopped uses up no abort and raises no alert.
  test('the abort kill\'s tries stopped because P stopped being up: no alert of either version, the abort not used; once P is up, the next retry reaching step 3 makes the same abort with no second relaunching post', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    row.scriptKill(errTmuxUnresponsive('kill'))
    await launchOwnPending(h, row)
    const launches = launchesOf(row)
    let stopsUp = true
    wrapModelKnob(h, 'killFn', (modelKill) => (params) => {
      if (stopsUp) h.setUp(p, false)
      return modelKill(params)
    })

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)
    expect(row.callTimes('kill')).toEqual([atB])
    // the stop's one record, naming its cause and the last outcome's class; no alert text.
    const stoppedLine = killFailureStoppedRetryText({
      key: p,
      decision: { kind: KILL_RETRY_ALERT_NONE },
      context: KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT,
      lastOutcomeClass: AD_ERROR_CLASS_UNAVAILABLE,
      stopCause: PERSONA_KILL_STOP_CAUSE_NOT_UP,
    }).line
    expect([abortAlertLinesOf(h, p), otherNoticesOf(h, p), h.killFailureOpen(p), h.stuckLaunchAbortUsed(p)]).toEqual([[stoppedLine], [], false, false])

    h.setUp(p, true)
    stopsUp = false
    const retryAt = await retryDriven(h, p)
    expect(row.callTimes('kill')).toEqual([atB, retryAt])
    expect([relaunchingPostsOf(h, p), h.stuckLaunchAbortUsed(p), launchesOf(row)]).toEqual([[relaunchingTextOf(p)], true, [...launches, 'resume']])
  })

  // a survivor-naming failure, then a non-success: the ordinary alert, once.
  test('the abort kill naming a survivor at its first try, then ErrTmuxUnresponsive: one ordinary alert with the stuck-launch abort context, quoting the survivor-naming description; the abort not used', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    const survivor = errTmuxKillFailed(personaTmuxSessionName(p), 'pane-process-survived')
    row.scriptKill(survivor, errTmuxUnresponsive('kill'), errTmuxUnresponsive('kill'))
    await launchOwnPending(h, row)

    await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)

    const alert = ordinaryAlertContent(p, { earlierSurvivor: survivor })
    expect(row.callTimes('kill')).toHaveLength(KILL_RETRY_TRIES)
    expect(otherNoticesOf(h, p)).toEqual([killFailureNotice(p, alert).text])
    expect(abortAlertLinesOf(h, p)).toEqual([killFailurePostedLine(p, alert, KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT)])
    expect(h.stuckLaunchAbortUsed(p)).toBe(false)
  })

  // an own stuck launch at B while a lap's read-pane raised tmux-unavailable: neither text and no kill until it clears.

  // no abort for a latched P.

  // the record is in memory only; a server restart forgets it.
  test('after a server restart the same pending row is no longer CSCB\'s own: at B the held post, no relaunching post and no kill', async () => {
    const { h, p, row } = ownStuckLaunchOf({}, ABORT_ORIGIN_RETRY)
    const launchStart = await launchOwnPending(h, row)
    await h.restartServer(p)
    row.scriptLaunches(errInstanceIdCollision())
    await h.launch(p)
    await h.settle()
    expect([row.launchStartedAt(), ownLaunchRecordOf(p)]).toEqual([launchStart, undefined])

    await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)
    await retryDriven(h, p)

    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, launchStart, false)])
    expect([relaunchingPostsOf(h, p), row.callTimes('kill')]).toEqual([[], []])
  })

  /** The model's row stays `pending` (its launch start kept) after each of its kills succeeds. */
  function keepPendingAfterKill(h: RecoveryHarness, row: PendingRowModel): void {
    wrapModelKnob(h, 'killFn', (modelKill) => (params) => {
      const answer = modelKill(params)
      if (params.instance_id === row.instanceId) row.setState(AGENT_DIRECTOR_PENDING_STATE)
      return answer
    })
  }

  // after the abort's kill: the sequence stops on an unjudged run; the abort is used; the held text once.
  test('the abort\'s sequence stopping at its first run that leaves the row pending in neither list: no alert and no launch; the held text once at the next retry, and no further kill', async () => {
    const { h, p, row } = ownStuckLaunchOf()
    await launchOwnPending(h, row)
    keepPendingAfterKill(h, row)
    const launches = launchesOf(row)
    const launchStart = row.launchStartedAt()

    const atB = await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)
    expect(roundVerbsFrom(h, row, atB)).toEqual(['status', 'get', 'find-missing', 'get', 'kill', 'get', 'find-missing'])
    expect([launchesOf(row), abortAlertLinesOf(h, p), otherNoticesOf(h, p), heldPostsOf(h, p), h.stuckLaunchAbortUsed(p)]).toEqual([launches, [], [], [], true])

    await retryDriven(h, p)
    await retryDriven(h, p)
    expect(heldPostsOf(h, p)).toEqual([stuckLaunchHeldText(p, launchStart, false)])
    expect([row.callTimes('kill'), relaunchingPostsOf(h, p).length]).toEqual([[atB], 1])
  })

  // step 5 with the abort's context.
  test('the abort\'s sequence reaching step 5 (the row still pending after runs that judged it and its step-4 kill): the ordinary alert with no description and the stuck-launch abort context; no launch', async () => {
    const { h, p, row } = ownStuckLaunchOf({ judgment: judgeUnverified })
    await launchOwnPending(h, row)
    keepPendingAfterKill(h, row)
    const launches = launchesOf(row)

    await abortRoundAtB(h, p, row, ABORT_ORIGIN_RETRY)

    const alert = ordinaryAlertContent(p)
    expect(row.callTimes('kill')).toHaveLength(2)
    expect(otherNoticesOf(h, p)).toEqual([killFailureNotice(p, alert).text])
    expect(abortAlertLinesOf(h, p)).toEqual([killFailurePostedLine(p, alert, KILL_FAILURE_CLOSING_DESTINATION, KILL_FAILURE_CONTEXT_STUCK_LAUNCH_ABORT)])
    expect(launchesOf(row)).toEqual(launches)
  })

  // design A3: the abort stops P's running approver first, with its own stop reason, and no rule run follows that stop.

})

describe('a failed launch\'s pending row, never CSCB\'s own, waited out through the rule until it reads missing (recovery harness)', () => {
  afterEach(cleanUpRuleHarness)

  test('HO rev 18: a lost-reply row (its launch call timed out) marked missing past G, before B, by the rule\'s run: that step hands P to the restart decision, whose get-then-act resumes the row, keeping its conversation; no kill, no post, nothing counted', async () => {
    const { h, p } = ruleHarnessOf({ harnessNow: true })
    const row = makePendingRowModel(h, p, { ...PLAIN_SPAWN_LAUNCH, sessionId: OWN_SESSION_ID, judgment: judgeMissingFromG() })
    scriptModelLaunch(h, row, { end: LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT })
    await h.launch(p)
    await h.settle()
    const launchStartMs = row.launchStartMs()!
    // agent-director answers the restart path's plain spawn of the finished row with a collision.
    row.scriptLaunches(errInstanceIdCollision())

    const rounds: RuleRound[] = []
    while (h.stub.calls.resumeCalls.length === 0 && rounds.length < 12) rounds.push(...(await runRounds(h, p, row, 1)))

    const recovered = rounds.at(-1)!
    expect(recovered.at).toBeGreaterThanOrEqual(launchStartMs + adGraceMsInEffect())
    expect(recovered.at).toBeLessThan(launchStartMs + adLaunchBoundMsInEffect())
    // The round's lap, run and get read the row missing; then the restart decision's plain spawn collides, its get reads the row and it resumes.
    expect(recovered.verbs.slice(0, LAP_RUN_ROUND.length + 3)).toEqual([...LAP_RUN_ROUND, 'spawn', 'get', 'resume'])
    expect(h.stub.calls.resumeCalls).toEqual([{ instance_id: row.instanceId }])
    expect([row.getRow().session_id, h.reuseSpawns(), row.callTimes('kill')]).toEqual([OWN_SESSION_ID, [], []])
    expect([heldPostsOf(h, p), relaunchingPostsOf(h, p), getFailureCount(p)]).toEqual([[], [], 0])
    expect(dispatcherBugWordingIn(h)).toEqual([])
  })
})
