/**
 * tests/ci-run-schedule.test.ts — The sharded `/ci` runner's scheduling
 * (`scripts/ci-run.ts` section 8; b.uqm SR-21.6's schedule file, E4).
 *
 * - The duration table (b.uqm SR-4.1): every line rule (final LF, CR, empty,
 *   malformed, repeat, out of order, missing entry, unknown entry), each
 *   unreadable cause giving every script the default, entries keyed by number
 *   form, and the committed `tests/ci-durations.tsv` pinned by its form and a
 *   clean parse, never by its seconds (an ordinary refresh commit stays green).
 * - The assignment (b.uqm SR-4.2): unit durations, longest first, both tie
 *   rules, determinism, every script placed, the small cases and SR-4.1's
 *   6-shard example on a constructed worktree of its 29 scripts.
 * - Shard limits (b.uqm SR-4.3): the formula and floor, `--shard-timeout`, T,
 *   the half-up rounding of the limit cause's minutes, and the limit timer on
 *   the fake clock, end marker just before the limit included.
 * - Timing (b.uqm SR-4.4): the timing values and lines, the `slow:` lines,
 *   the duration-table block with its introducing line, and its round trip.
 * - One pin case per section 8 wording and for `DURATION_TABLE_HEADER`: the
 *   only place their text is typed.
 *
 * Everything runs in process through the runner's exports: no child process,
 * no docker, no top-level `mock.module`. Worktrees and run directories come
 * from E1's builders (`tests/test-helpers/ci-run.ts`, used read-only) under a
 * `mkdtempSync` root removed in `afterEach`; every wait is on `createFakeClock`.
 * Real script names are looked up by number in the repository's listing.
 * Runner constants are imported, never typed; the only figures typed are test
 * data and the SRD's example figures in the cases that pin them (SR-4.1's
 * initial table in the 6-shard case, 93.4 and 84.5 min, `--shard-timeout 5`).
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_ESTIMATE_SECONDS,
  DURATION_TABLE_HEADER,
  DURATION_TABLE_PATH,
  LIMIT_ADDEND_MINUTES,
  LIMIT_FACTOR,
  LIMIT_FLOOR_MINUTES,
  NUMBER_FORM_PATTERN,
  RAW_KEY_PREFIX,
  SAMPLE_INTERVAL_MS,
  SHARD_DIR_PREFIX,
  SLOW_FACTOR,
  armShardLimitTimer,
  assignShards,
  buildTimeLine,
  durationLineIgnoredNote,
  durationLineOutOfOrderNote,
  durationTableBlock,
  durationTableBlockIntro,
  durationTableMissingNote,
  durationTableReadFailedNote,
  durationTableWrongHeaderNote,
  fileNameNumberForm,
  isWholeNumber,
  numberFormOf,
  parseCiArguments,
  parseDurationTable,
  readFileText,
  roundMinutesHalfUp,
  scheduleRun,
  scriptTimeLine,
  scriptTimeLines,
  shardLimitMinutes,
  shardLimitMs,
  shardTimeLine,
  slowLine,
  slowLines,
  sortCanonical,
  timingLines,
  timingReport,
  timingValues,
  totalTimeLine,
  validateRun,
  wallTimeLimitCause,
  type ChildEnvironmentSource,
  type DurationLineProblem,
  type DurationTableSource,
  type EndEvent,
  type Invocation,
  type LimitTimerOutcome,
  type ResultEvent,
  type ResultFileRead,
  type Schedule,
  type SchedulingUnit,
  type Script,
  type ScriptResult,
  type ShardTimingRecord,
  type TimingRecord,
  type ValidatedRun,
} from '../scripts/ci-run.ts'
import {
  buildWorktree,
  durationTableLine,
  durationTableText,
  makeRunDir,
  realScriptFileName,
  realScriptFileNames,
  realScriptNumbers,
  writeShardDir,
  type DurationRow,
  type DurationTableSpec,
  type ShardDirSpec,
} from './test-helpers/ci-run.ts'
import { assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'

/** The repository root: this file sits in `tests/`. */
const REPO_ROOT = join(import.meta.dir, '..')

/** Unit facts, not runner constants: milliseconds in a second and in a minute, seconds in a minute. */
const MS_PER_SECOND = 1_000
const MS_PER_MINUTE = 60_000
const SECONDS_PER_MINUTE = MS_PER_MINUTE / MS_PER_SECOND

/** Test data: the run's start, and every clock's start. */
const START_MS = Date.UTC(2026, 9, 8, 12, 0, 0)
/** Test data: the RUN_ID of every run directory built here. */
const RUN_ID = '20261008t120000z-e4sched1'

// ---------------------------------------------------------------------------
// The real-name lookup and shared factories
// ---------------------------------------------------------------------------

/** The repository's real file name for script number `n`, looked up in its `tests/integration` listing (b.uqm SR-21.2). */
function scriptFile(n: number): string {
  return realScriptFileName(n)
}

/** The real file names of scripts `ns`, in the order given. */
function files(...ns: readonly number[]): string[] {
  return ns.map(scriptFile)
}

/** `test-<n>`. */
function nf(n: number): string {
  return numberFormOf(n)
}

function scriptOf(n: number): Script {
  return { fileName: scriptFile(n), number: n, numberForm: nf(n) }
}

/** A scheduling unit of scripts `ns`, kept in the order given. */
function unitOf(ns: readonly number[]): SchedulingUnit {
  return { scripts: ns.map(scriptOf) }
}

/** One table row per `[n, seconds]` pair. */
function rowsOf(pairs: readonly (readonly [number, number | string])[]): DurationRow[] {
  return pairs.map(([script, seconds]) => ({ script, seconds }))
}

/** A table's text from E1's builder: the header, then the rows in the order given (or canonical). */
function tableText(pairs: readonly (readonly [number, number | string])[], options: { order?: 'as-given' | 'canonical' | 'reversed'; finalNewline?: boolean } = {}): string {
  return durationTableText({ kind: 'rows', header: DURATION_TABLE_HEADER, rows: rowsOf(pairs), ...options })
}

/** A table as the image read-back hands its text over. */
function textSource(text: string): DurationTableSource {
  return { kind: 'text', text }
}

/** Lines as a file's text, each ended by a line feed. */
function textOf(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join('')
}

/** The `/ci` arguments parsed, failing the case when they are refused. */
function invocationOf(args: readonly string[] = []): Invocation {
  const parsed = parseCiArguments(args)
  if (!parsed.ok) throw new Error(`refused: ${JSON.stringify(parsed.failures)}`)
  return parsed.invocation
}

/** Fake credentials for a valid run (b.uqm SR-21.2): what `validateRun`'s step 2 checks. */
function validEnv(): ChildEnvironmentSource {
  return { ANTHROPIC_API_KEY: fakeToken(RAW_KEY_PREFIX, 'raw'), GH_TOKEN: fakeToken('', 'gh') }
}

/** E2's validated run over a built worktree, failing the case when it is refused. */
function validated(worktreeRoot: string, args: readonly string[] = []): ValidatedRun {
  const validation = validateRun(args, worktreeRoot, validEnv())
  assertNoLeak(validation)
  if (!validation.ok) throw new Error(`refused: ${JSON.stringify(validation.refusal)}`)
  return validation.validated
}

/** A map's entries as an ordered list, so a comparison also checks the order. */
function entriesOf<K, V>(map: ReadonlyMap<K, V>): [K, V][] {
  return [...map]
}

/** The estimates SR-4.1 gives `pinned`, in canonical order: each script's seconds from `given` (by number form), else the default. */
function expectedEstimates(pinned: readonly string[], given: Readonly<Record<string, number>>): [string, number][] {
  return sortCanonical(pinned).map((fileName) => [fileName, given[fileNameNumberForm(fileName) ?? ''] ?? DEFAULT_ESTIMATE_SECONDS])
}

interface ScheduleCase {
  /** `[n, seconds]` table rows, written in canonical order. */
  readonly rows: readonly (readonly [number, number])[]
  /** Units by script numbers. */
  readonly units: readonly (readonly number[])[]
  readonly shards: number
  readonly args?: readonly string[]
  /** Default: test-1 and every unit's scripts. */
  readonly pinned?: readonly string[]
}

/** The scheduling entry point over constructed units and a canonical table. */
function scheduleOf(c: ScheduleCase): Schedule {
  return scheduleRun({
    pinned: c.pinned ?? files(1, ...c.units.flat()),
    table: textSource(tableText(c.rows, { order: 'canonical' })),
    units: c.units.map(unitOf),
    invocation: invocationOf(c.args),
    shards: c.shards,
  })
}

/** Each shard's number, file names in run order and expected seconds. */
function compositionOf(schedule: Schedule): { shard: number; assigned: readonly string[]; expectedSeconds: number }[] {
  return schedule.assignment.map(({ shard, assigned, expectedSeconds }) => ({ shard, assigned, expectedSeconds }))
}

/** An `end` event for script `n`. */
function endOf(n: number, result: ScriptResult, seconds: number): EndEvent {
  return { kind: 'end', fileName: scriptFile(n), result, seconds }
}

/** A result file read with these events. */
function eventsRead(events: readonly ResultEvent[]): ResultFileRead {
  return { kind: 'events', events }
}

/** One shard's timing record. */
function shardRecord(shard: number, startedAtMs: number | null, finalReadingAtMs: number | null, resultFile: ResultFileRead): ShardTimingRecord {
  return { shard, startedAtMs, finalReadingAtMs, resultFile }
}

/** A timing record whose every step ran, at fixed moments after START_MS, with the shards given. */
function recordWith(shards: readonly ShardTimingRecord[]): TimingRecord {
  return {
    runnerStartAtMs: START_MS,
    packingStartAtMs: START_MS + 2_000,
    baseBuild: { startedAtMs: START_MS + 3_000, endedAtMs: START_MS + 63_500 },
    pinnedKnownAtMs: START_MS + 125_250,
    shards,
    verdictAtMs: START_MS + 260_000,
  }
}

/** A timing record of one shard per event list, every shard timed. */
function recordOfShards(...shardEvents: readonly (readonly ResultEvent[])[]): TimingRecord {
  return recordWith(shardEvents.map((events, i) => shardRecord(i + 1, START_MS + 130_000, START_MS + 190_000, eventsRead([...events, { kind: 'done' }]))))
}

describe('the duration table header (b.uqm SR-4.1)', () => {
  test('DURATION_TABLE_HEADER is script, a tab, seconds', () => {
    expect(DURATION_TABLE_HEADER).toBe('script\tseconds')
  })
})

// ---------------------------------------------------------------------------
// T3.S1: the duration table (b.uqm SR-4.1; AC 77's table half, AC 78's 2400 s half)
// ---------------------------------------------------------------------------

describe('the duration table (b.uqm SR-4.1)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-run-schedule-table-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** The pinned list of the parsing cases: real scripts, in an order that is not canonical. */
  function pinned(): string[] {
    return files(6, 5, 0, 4, 3, 2, 1)
  }

  function parse(source: DurationTableSource, list: readonly string[] = pinned()): ReturnType<typeof parseDurationTable> {
    const table = parseDurationTable(source, list)
    assertNoLeak(table)
    return table
  }

  /** The source a built worktree's table gives through the runner's own read. */
  function builtSource(spec: DurationTableSpec): DurationTableSource {
    return readFileText(buildWorktree(root, { durationTable: spec }).durationTablePath)
  }

  test.each([
    ['with its final line feed', true],
    ['without its final line feed', false],
  ] as const)('a well-formed table, %s, gives each listed script its seconds, keyed by number form, in canonical order, with no note', (_label, finalNewline) => {
    const table = parse(builtSource({ kind: 'rows', header: DURATION_TABLE_HEADER, rows: rowsOf([[1, 23], [2, 5], [3, 21], [4, 7], [0, 156], [5, 9], [6, 15]]), finalNewline }))

    expect(table.readable).toBe(true)
    expect(table.notes).toEqual([])
    expect(entriesOf(table.estimates)).toEqual(files(1, 2, 3, 4, 0, 5, 6).map((f, i) => [f, [23, 5, 21, 7, 156, 9, 15][i]]))
    expect(entriesOf(table.entries)).toEqual([[nf(1), 23], [nf(2), 5], [nf(3), 21], [nf(4), 7], [nf(0), 156], [nf(5), 9], [nf(6), 15]])
  })

  test('a missing entry gets the default estimate, with no note', () => {
    const table = parse(textSource(tableText([[1, 23], [5, 9]])))

    expect(table.notes).toEqual([])
    expect(entriesOf(table.estimates)).toEqual(expectedEstimates(pinned(), { [nf(1)]: 23, [nf(5)]: 9 }))
    expect(entriesOf(table.entries)).toEqual([[nf(1), 23], [nf(5), 9]])
  })

  test('a line holding a carriage return is ignored and noted with its line number; the rest is used', () => {
    const table = parse(builtSource({ kind: 'rows', header: DURATION_TABLE_HEADER, rows: rowsOf([[1, 23], [5, 9], [6, 15]]), carriageReturns: [3] }))

    expect(table.readable).toBe(true)
    expect(table.notes).toEqual([durationLineIgnoredNote(3, { kind: 'carriage-return' })])
    expect(entriesOf(table.estimates)).toEqual(expectedEstimates(pinned(), { [nf(1)]: 23, [nf(6)]: 15 }))
  })

  test.each([
    ['between two entries', () => textOf([DURATION_TABLE_HEADER, durationTableLine({ script: 1, seconds: 23 }), '', durationTableLine({ script: 6, seconds: 15 })]), 3],
    ['after the last line feed', () => `${tableText([[1, 23], [6, 15]])}\n`, 4],
  ] as const)('an empty line %s is ignored and noted; the rest is used', (_label, text, line) => {
    const table = parse(textSource(text()))

    expect(table.notes).toEqual([durationLineIgnoredNote(line, { kind: 'empty' })])
    expect(entriesOf(table.estimates)).toEqual(expectedEstimates(pinned(), { [nf(1)]: 23, [nf(6)]: 15 }))
  })

  const MALFORMED: readonly (readonly [string, () => string, () => DurationLineProblem])[] = [
    ['zero seconds', () => `${nf(5)}\t0`, () => ({ kind: 'bad-seconds', seconds: '0' })],
    ['leading-zero seconds', () => `${nf(5)}\t09`, () => ({ kind: 'bad-seconds', seconds: '09' })],
    ['plus-signed seconds', () => `${nf(5)}\t+9`, () => ({ kind: 'bad-seconds', seconds: '+9' })],
    ['minus-signed seconds', () => `${nf(5)}\t-9`, () => ({ kind: 'bad-seconds', seconds: '-9' })],
    ['decimal seconds', () => `${nf(5)}\t9.5`, () => ({ kind: 'bad-seconds', seconds: '9.5' })],
    ['seconds with a trailing space', () => `${nf(5)}\t9 `, () => ({ kind: 'bad-seconds', seconds: '9 ' })],
    ['seconds past Number.MAX_SAFE_INTEGER', () => `${nf(5)}\t${Number.MAX_SAFE_INTEGER + 1}`, () => ({ kind: 'bad-seconds', seconds: String(Number.MAX_SAFE_INTEGER + 1) })],
    ['a leading-zero number form', () => `test-05\t9`, () => ({ kind: 'bad-script', script: 'test-05' })],
    ['a file name instead of a number form', () => `${scriptFile(5)}\t9`, () => ({ kind: 'bad-script', script: scriptFile(5) })],
    ['a number form with a leading space', () => ` ${nf(5)}\t9`, () => ({ kind: 'bad-script', script: ` ${nf(5)}` })],
    ['a missing tab', () => `${nf(5)} 9`, () => ({ kind: 'no-tab' })],
  ]

  test.each(MALFORMED)('a malformed line (%s) is ignored and noted with its line number and reason; the rest is used', (_label, line, problem) => {
    const text = textOf([DURATION_TABLE_HEADER, durationTableLine({ script: 1, seconds: 23 }), line(), durationTableLine({ script: 6, seconds: 15 })])

    const table = parse(textSource(text))

    expect(table.readable).toBe(true)
    expect(table.notes).toEqual([durationLineIgnoredNote(3, problem())])
    expect(entriesOf(table.estimates)).toEqual(expectedEstimates(pinned(), { [nf(1)]: 23, [nf(6)]: 15 }))
  })

  test('seconds of exactly Number.MAX_SAFE_INTEGER are used', () => {
    const table = parse(textSource(tableText([[5, Number.MAX_SAFE_INTEGER]])))

    expect(table.notes).toEqual([])
    expect(table.entries.get(nf(5))).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('a repeated script: the first line of the table form is used, the repeat ignored and noted; a malformed earlier line does not count', () => {
    const text = textOf([
      DURATION_TABLE_HEADER,
      durationTableLine({ script: 5, seconds: 9 }),
      durationTableLine({ script: 5, seconds: 99 }),
      durationTableLine({ script: 6, seconds: 0 }),
      durationTableLine({ script: 6, seconds: 15 }),
    ])

    const table = parse(textSource(text))

    expect(table.notes).toEqual([
      durationLineIgnoredNote(3, { kind: 'repeated', numberForm: nf(5), firstLine: 2 }),
      durationLineIgnoredNote(4, { kind: 'bad-seconds', seconds: '0' }),
    ])
    expect(entriesOf(table.entries)).toEqual([[nf(5), 9], [nf(6), 15]])
  })

  test('an entry for a script not in the pinned list is ignored and noted', () => {
    const table = parse(textSource(tableText([[1, 23], [7, 40], [5, 9]])))

    expect(table.notes).toEqual([durationLineIgnoredNote(3, { kind: 'not-listed', numberForm: nf(7) })])
    expect(entriesOf(table.entries)).toEqual([[nf(1), 23], [nf(5), 9]])
    expect(table.estimates.has(scriptFile(7))).toBe(false)
  })

  test('an out-of-order line is used and noted against the earlier used line it follows; an ignored line is no reference', () => {
    // test-7 (line 3) is not pinned, so test-5 after it is in order; test-2 (line 5) sorts before test-5 (line 4).
    const table = parse(textSource(tableText([[1, 23], [7, 40], [5, 9], [2, 5], [6, 15]])))

    expect(table.notes).toEqual([
      durationLineIgnoredNote(3, { kind: 'not-listed', numberForm: nf(7) }),
      durationLineOutOfOrderNote(5, nf(2), nf(5), 4),
    ])
    expect(entriesOf(table.entries)).toEqual([[nf(1), 23], [nf(2), 5], [nf(5), 9], [nf(6), 15]])
  })

  test('a table in reversed canonical order: every line used, each after the first noted against the first', () => {
    const table = parse(builtSource({ kind: 'rows', header: DURATION_TABLE_HEADER, rows: rowsOf([[1, 23], [2, 5], [0, 156], [6, 15]]), order: 'reversed' }))

    expect(table.notes).toEqual([
      durationLineOutOfOrderNote(3, nf(0), nf(6), 2),
      durationLineOutOfOrderNote(4, nf(2), nf(6), 2),
      durationLineOutOfOrderNote(5, nf(1), nf(6), 2),
    ])
    expect(entriesOf(table.entries)).toEqual([[nf(1), 23], [nf(2), 5], [nf(0), 156], [nf(6), 15]])
  })

  test("an entry keyed by number form applies to the pinned script whose slug has changed", () => {
    const renamed = `${nf(5)}-a-renamed-slug.sh`
    const list = [scriptFile(1), renamed]

    const table = parse(textSource(tableText([[1, 23], [5, 9]])), list)

    expect(table.notes).toEqual([])
    expect(entriesOf(table.estimates)).toEqual([[scriptFile(1), 23], [renamed, 9]])
  })

  const UNREADABLE: readonly (readonly [string, () => DurationTableSpec, (source: DurationTableSource) => string])[] = [
    ['missing', () => ({ kind: 'absent' }), () => durationTableMissingNote()],
    ['cannot be read', () => ({ kind: 'unreadable' }), (source) => durationTableReadFailedNote(source.kind === 'unreadable' ? source.error : 'not unreadable')],
    ['a wrong header', () => ({ kind: 'rows', header: 'script seconds', rows: rowsOf([[1, 23]]) }), () => durationTableWrongHeaderNote()],
    ['no header', () => ({ kind: 'rows', header: null, rows: rowsOf([[1, 23]]) }), () => durationTableWrongHeaderNote()],
    ['a header holding a carriage return', () => ({ kind: 'rows', header: DURATION_TABLE_HEADER, rows: rowsOf([[1, 23]]), carriageReturns: [1] }), () => durationTableWrongHeaderNote()],
    ['an empty file', () => ({ kind: 'text', text: '' }), () => durationTableWrongHeaderNote()],
  ]

  test.each(UNREADABLE)('an unreadable table (%s) gives every pinned script the default estimate and one note', (label, spec, note) => {
    const source = builtSource(spec())
    if (label === 'cannot be read') expect(source.kind).toBe('unreadable')

    const table = parse(source)

    expect(table.readable).toBe(false)
    expect(table.notes).toEqual([note(source)])
    expect(entriesOf(table.estimates)).toEqual(expectedEstimates(pinned(), {}))
    expect(table.entries.size).toBe(0)
  })

  test('the committed tests/ci-durations.tsv is in the file format and parses cleanly against the repository listing', () => {
    const source = readFileText(join(REPO_ROOT, DURATION_TABLE_PATH))
    if (source.kind !== 'text') throw new Error(`${DURATION_TABLE_PATH} is ${source.kind}`)
    const text = source.text

    const table = parse(source, realScriptFileNames())

    expect(table.readable).toBe(true)
    expect(table.notes).toEqual([])
    expect(text.includes('\r')).toBe(false)
    expect(text.endsWith('\n')).toBe(true)
    const [header, ...lines] = text.slice(0, -1).split('\n')
    expect(header).toBe(DURATION_TABLE_HEADER)
    for (const line of lines) {
      const fields = line.split('\t')
      expect(fields.length).toBe(2)
      expect(NUMBER_FORM_PATTERN.test(fields[0])).toBe(true)
      expect(isWholeNumber(fields[1]) && Number(fields[1]) > 0).toBe(true)
    }
    expect(table.entries.size).toBe(lines.length)
  })
})

// ---------------------------------------------------------------------------
// T3.S2: assignment (b.uqm SR-4.2; AC 78's ties and determinism)
// ---------------------------------------------------------------------------

/** SR-4.1's initial table: 29 number-form/seconds pairs in canonical order, typed only here and used only by the 6-shard case. */
const SR_4_1_INITIAL_TABLE: readonly (readonly [number, number])[] = [
  [1, 23], [2, 1], [3, 21], [4, 5], [0, 156], [5, 1], [6, 15], [7, 3], [8, 35], [9, 21],
  [10, 111], [12, 32], [13, 244], [14, 258], [15, 67], [16, 541], [17, 448], [18, 495], [19, 506], [20, 1060],
  [21, 386], [22, 523], [23, 2047], [24, 1210], [25, 12], [26, 2330], [27, 371], [28, 1380], [29, 86],
]

describe('the assignment (b.uqm SR-4.2)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-run-schedule-assign-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("a unit's duration is the sum of its scripts' estimates, and every shard starts with test-1's estimate", () => {
    const schedule = scheduleOf({ rows: [[1, 10], [5, 100], [6, 30], [7, 40]], units: [[5], [6, 7]], shards: 2 })

    expect(compositionOf(schedule)).toEqual([
      { shard: 1, assigned: files(1, 5), expectedSeconds: 110 },
      { shard: 2, assigned: files(1, 6, 7), expectedSeconds: 80 },
    ])
  })

  test('with no entry for test-1, every shard starts with the default estimate', () => {
    const schedule = scheduleOf({ rows: [[5, 100], [6, 30]], units: [[5], [6]], shards: 2 })

    expect(schedule.assignment.map((entry) => entry.expectedSeconds)).toEqual([DEFAULT_ESTIMATE_SECONDS + 100, DEFAULT_ESTIMATE_SECONDS + 30])
  })

  test('units are taken longest first, each to the shard with the smallest total', () => {
    // In canonical order (5, 6, 7, 8) the shards would be {5, 7} and {6, 8}.
    const schedule = scheduleOf({ rows: [[1, 10], [5, 20], [6, 30], [7, 40], [8, 50]], units: [[5], [6], [7], [8]], shards: 2 })

    expect(compositionOf(schedule)).toEqual([
      { shard: 1, assigned: files(1, 5, 8), expectedSeconds: 80 },
      { shard: 2, assigned: files(1, 6, 7), expectedSeconds: 80 },
    ])
  })

  test('units of equal duration are taken in canonical order: test-4 before test-0', () => {
    const schedule = scheduleOf({ rows: [[1, 10], [4, 50], [0, 50]], units: [[0], [4]], shards: 2 })

    expect(compositionOf(schedule)).toEqual([
      { shard: 1, assigned: files(1, 4), expectedSeconds: 60 },
      { shard: 2, assigned: files(1, 0), expectedSeconds: 60 },
    ])
  })

  test('a multi-script unit is keyed by its first script in canonical order, and its scripts run in canonical order', () => {
    // The unit {test-9, test-0} is keyed by test-0, which sorts before test-5; keyed by test-9 it would sort after.
    const schedule = scheduleOf({ rows: [[1, 10], [0, 25], [9, 25], [5, 50]], units: [[5], [9, 0]], shards: 2 })

    expect(compositionOf(schedule)).toEqual([
      { shard: 1, assigned: files(1, 0, 9), expectedSeconds: 60 },
      { shard: 2, assigned: files(1, 5), expectedSeconds: 60 },
    ])
  })

  test('on equal shard totals the lowest shard number wins', () => {
    // After 30, 20 and 10 the totals tie at 40; the 5 goes to shard 1.
    const schedule = scheduleOf({ rows: [[1, 10], [5, 30], [6, 20], [7, 10], [8, 5]], units: [[5], [6], [7], [8]], shards: 2 })

    expect(compositionOf(schedule)).toEqual([
      { shard: 1, assigned: files(1, 5, 8), expectedSeconds: 45 },
      { shard: 2, assigned: files(1, 6, 7), expectedSeconds: 40 },
    ])
  })

  test('the assignment is the same across repeated calls, reordered units, reordered table lines and a reordered pinned list', () => {
    const rows: readonly (readonly [number, number])[] = [[1, 10], [2, 20], [3, 20], [4, 40], [0, 40], [5, 15], [6, 25], [7, 25], [8, 5], [9, 60], [10, 60]]
    const units = [[2, 3], [4], [0], [5], [6], [7], [8], [9], [10]] as const
    const pinned = files(1, 2, 3, 4, 0, 5, 6, 7, 8, 9, 10)
    const base = scheduleRun({ pinned, table: textSource(tableText(rows, { order: 'canonical' })), units: units.map(unitOf), invocation: invocationOf(), shards: 3 })

    const variants = [
      scheduleRun({ pinned, table: textSource(tableText(rows, { order: 'canonical' })), units: units.map(unitOf), invocation: invocationOf(), shards: 3 }),
      scheduleRun({ pinned, table: textSource(tableText(rows, { order: 'canonical' })), units: [...units].reverse().map((u) => unitOf([...u].reverse())), invocation: invocationOf(), shards: 3 }),
      scheduleRun({ pinned, table: textSource(tableText(rows, { order: 'reversed' })), units: units.map(unitOf), invocation: invocationOf(), shards: 3 }),
      scheduleRun({ pinned: [...pinned].reverse(), table: textSource(tableText(rows, { order: 'canonical' })), units: units.map(unitOf), invocation: invocationOf(), shards: 3 }),
    ]

    for (const variant of variants) {
      expect(variant.assignment).toEqual(base.assignment)
      expect(entriesOf(variant.limitsMs)).toEqual(entriesOf(base.limitsMs))
    }
  })

  test("a selective run's assignment is the same across validations and argument orders", () => {
    const built = buildWorktree(root, { prerequisites: { 3: [{ names: [2] }] }, durationTable: { kind: 'rows', header: DURATION_TABLE_HEADER, rows: rowsOf([[1, 10], [2, 30], [3, 30], [5, 60], [7, 60]]) } })
    const scheduleFor = (args: readonly string[]): Schedule => {
      const run = validated(built.root, args)
      return scheduleRun({ pinned: built.scriptFileNames, table: readFileText(built.durationTablePath), units: run.units, invocation: run.invocation, shards: run.effectiveShards })
    }

    const first = scheduleFor([nf(7), nf(5), nf(3)])

    expect(compositionOf(first)).toEqual([
      { shard: 1, assigned: files(1, 2, 3), expectedSeconds: 70 },
      { shard: 2, assigned: files(1, 5), expectedSeconds: 70 },
      { shard: 3, assigned: files(1, 7), expectedSeconds: 70 },
    ])
    expect(scheduleFor([nf(7), nf(5), nf(3)]).assignment).toEqual(first.assignment)
    expect(scheduleFor([nf(3), nf(5), nf(7)]).assignment).toEqual(first.assignment)
    assertNoLeak(first)
  })

  const PLACEMENT_TABLES: readonly (readonly [string, () => DurationTableSpec])[] = [
    ['a readable table', () => ({ kind: 'rows', header: DURATION_TABLE_HEADER, rows: realScriptNumbers().map((n) => ({ script: n, seconds: n + 1 })), order: 'canonical' })],
    ['an unreadable table', () => ({ kind: 'unreadable' })],
    ['an absent table', () => ({ kind: 'absent' })],
    ['a table missing most entries, test-1 included', () => ({ kind: 'rows', header: DURATION_TABLE_HEADER, rows: rowsOf([[5, 100], [6, 7]]) })],
  ]

  test.each(PLACEMENT_TABLES)('with %s every run script but test-1 is in exactly one shard and test-1 heads every shard (AC 78)', (_label, spec) => {
    const built = buildWorktree(root, { prerequisites: { 3: [{ names: [2] }] }, durationTable: spec() })
    const run = validated(built.root)

    const schedule = scheduleRun({ pinned: built.scriptFileNames, table: readFileText(built.durationTablePath), units: run.units, invocation: run.invocation, shards: run.effectiveShards })

    expect(schedule.assignment.map((entry) => entry.shard)).toEqual(Array.from({ length: run.effectiveShards }, (_, i) => i + 1))
    expect(schedule.assignment.every((entry) => entry.assigned[0] === scriptFile(1))).toBe(true)
    const placed = schedule.assignment.flatMap((entry) => entry.assigned.slice(1))
    expect(sortCanonical(placed)).toEqual(run.runScripts.map((script) => script.fileName).filter((fileName) => fileName !== scriptFile(1)))
    assertNoLeak({ schedule, notes: schedule.notes })
  })

  test('N = 1 puts every unit in shard 1, its scripts in run order', () => {
    const schedule = scheduleOf({ rows: [[1, 10], [0, 5], [4, 6], [7, 7]], units: [[7], [0], [4]], shards: 1 })

    expect(compositionOf(schedule)).toEqual([{ shard: 1, assigned: files(1, 4, 0, 7), expectedSeconds: 28 }])
  })

  test('zero units give one shard holding only test-1', () => {
    const schedule = scheduleOf({ rows: [[1, 10]], units: [], shards: 1 })

    expect(compositionOf(schedule)).toEqual([{ shard: 1, assigned: files(1), expectedSeconds: 10 }])
  })

  test.each([
    ['N above the number of units', [[5], [6]], 3],
    ['N 2 over zero units', [], 2],
    ['N 0', [[5]], 0],
    ['N not a whole number', [[5], [6]], 1.5],
  ] as const)('assignShards throws for %s', (_label, units, shards) => {
    const estimates = new Map(files(1, 5, 6).map((f) => [f, 10]))

    expect(() => assignShards(scriptFile(1), estimates, units.map(unitOf), shards, null)).toThrow()
  })

  test('scheduleRun throws when the pinned list holds no test-1', () => {
    expect(() => scheduleOf({ rows: [[5, 10]], units: [[5]], shards: 1, pinned: files(5) })).toThrow()
  })

  test("SR-4.1's 6-shard example: SR-4.1's 29 scripts and initial table, test-3 requiring test-2, N = 6", () => {
    const built = buildWorktree(root, {
      scripts: files(...SR_4_1_INITIAL_TABLE.map(([n]) => n)),
      prerequisites: { 3: [{ names: [2] }] },
      durationTable: { kind: 'rows', header: DURATION_TABLE_HEADER, rows: rowsOf(SR_4_1_INITIAL_TABLE) },
    })
    const run = validated(built.root)
    expect(run.units.length).toBe(27)
    expect(run.effectiveShards).toBe(6)

    const schedule = scheduleRun({ pinned: built.scriptFileNames, table: readFileText(built.durationTablePath), units: run.units, invocation: run.invocation, shards: 6 })

    expect(schedule.notes).toEqual([])
    expect(compositionOf(schedule)).toEqual([
      { shard: 1, assigned: files(1, 26), expectedSeconds: 2353 },
      { shard: 2, assigned: files(1, 23), expectedSeconds: 2070 },
      { shard: 3, assigned: files(1, 0, 5, 7, 15, 21, 28), expectedSeconds: 2016 },
      { shard: 4, assigned: files(1, 13, 17, 24, 25, 29), expectedSeconds: 2023 },
      { shard: 5, assigned: files(1, 4, 9, 10, 12, 14, 19, 20), expectedSeconds: 2016 },
      { shard: 6, assigned: files(1, 2, 3, 6, 8, 16, 18, 22, 27), expectedSeconds: 2025 },
    ])
    const again = scheduleRun({ pinned: [...built.scriptFileNames].reverse(), table: readFileText(built.durationTablePath), units: [...run.units].reverse(), invocation: run.invocation, shards: 6 })
    expect(again.assignment).toEqual(schedule.assignment)
    assertNoLeak(schedule)
  })
})

// ---------------------------------------------------------------------------
// T3.S3: shard limits, rounding, --shard-timeout and the limit timer
// (b.uqm SR-4.3; AC 37's rounding half, AC 78's --shard-timeout 5)
// ---------------------------------------------------------------------------

/** The expected total whose limit by SR-4.3's formula is `limitMinutes`, from the imported factor and addend. */
function expectedSecondsForLimit(limitMinutes: number): number {
  const limitMs = Math.round(limitMinutes * MS_PER_MINUTE)
  const seconds = (limitMs - LIMIT_ADDEND_MINUTES * MS_PER_MINUTE) / (LIMIT_FACTOR * MS_PER_SECOND)
  if (!Number.isSafeInteger(seconds)) throw new Error(`no whole expected total gives a limit of ${limitMinutes} min`)
  return seconds
}

/** SR-4.3's example limits (AC 37), typed only here: 93.4 min prints as 93, 84.5 min as 85. */
const LIMIT_93_4 = 93.4
const LIMIT_84_5 = 84.5

/** A schedule of two shards whose limits are 93.4 and 84.5 min: test-1's estimate plus one unit each. */
function roundingSchedule(): Schedule {
  const test1 = 52
  return scheduleOf({ rows: [[1, test1], [5, expectedSecondsForLimit(LIMIT_93_4) - test1], [6, expectedSecondsForLimit(LIMIT_84_5) - test1]], units: [[5], [6]], shards: 2 })
}

describe('shard limits (b.uqm SR-4.3)', () => {
  /** SR-4.3's formula over the imported constants: LIMIT_FACTOR × the total + the addend, at least the floor. */
  function formulaMinutes(expectedSeconds: number): number {
    return Math.max(LIMIT_FLOOR_MINUTES, (LIMIT_FACTOR * expectedSeconds) / SECONDS_PER_MINUTE + LIMIT_ADDEND_MINUTES)
  }

  test('a shard holding only test-1 gets the floor', () => {
    const schedule = scheduleOf({ rows: [[1, 10]], units: [], shards: 1 })

    expect(schedule.assignment[0].limitMinutes).toBe(LIMIT_FLOOR_MINUTES)
    expect(schedule.limitsMs.get(1)).toBe(LIMIT_FLOOR_MINUTES * MS_PER_MINUTE)
  })

  test.each([
    ['below the floor', 60],
    ['exactly at the floor', ((LIMIT_FLOOR_MINUTES - LIMIT_ADDEND_MINUTES) * SECONDS_PER_MINUTE) / LIMIT_FACTOR],
    ['above the floor', 1200],
  ] as const)("a shard's limit is the factor × its total + the addend, raised to the floor: a total %s", (_label, total) => {
    const schedule = scheduleOf({ rows: [[1, 10], [5, total - 10]], units: [[5]], shards: 1 })

    expect(schedule.assignment[0].expectedSeconds).toBe(total)
    expect(schedule.assignment[0].limitMinutes).toBe(formulaMinutes(total))
    expect(schedule.limitsMs.get(1)).toBe(formulaMinutes(total) * MS_PER_MINUTE)
    expect(shardLimitMinutes(total, null)).toBe(formulaMinutes(total))
    expect(shardLimitMs(total, null)).toBe(formulaMinutes(total) * MS_PER_MINUTE)
  })

  test("--shard-timeout 5 sets every shard's limit to 5 min, below the floor and whatever its total (AC 78)", () => {
    const timeout = 5
    expect(timeout).toBeLessThan(LIMIT_FLOOR_MINUTES)

    const schedule = scheduleOf({ rows: [[1, 10], [5, 3000], [6, 1]], units: [[5], [6]], shards: 2, args: ['--shard-timeout', String(timeout)] })

    expect(schedule.assignment.map((entry) => entry.limitMinutes)).toEqual([timeout, timeout])
    expect(entriesOf(schedule.limitsMs)).toEqual([[1, timeout * MS_PER_MINUTE], [2, timeout * MS_PER_MINUTE]])
    expect(schedule.largestLimitMinutes).toBe(timeout)
    expect(schedule.largestLimitMs).toBe(timeout * MS_PER_MINUTE)
  })

  test('limits of 93.4 and 84.5 min are exact, and the limit cause names 93 and 85 min, rounded halves up (AC 37)', () => {
    const schedule = roundingSchedule()

    expect(schedule.assignment.map((entry) => entry.limitMinutes)).toEqual([LIMIT_93_4, LIMIT_84_5])
    expect(roundMinutesHalfUp(LIMIT_93_4)).toBe(93)
    expect(roundMinutesHalfUp(LIMIT_84_5)).toBe(85)
    expect(schedule.assignment.map((entry) => wallTimeLimitCause(entry.limitMinutes))).toEqual([
      { kind: 'wall-time-limit', minutes: 93, fixedByRunner: true },
      { kind: 'wall-time-limit', minutes: 85, fixedByRunner: true },
    ])
  })

  test("T, the run's largest limit, is the largest shard limit, here shard 2's, not shard 1's", () => {
    // The longest unit (test-5) goes to shard 1 (1010 s); test-6 and test-7 both go to shard 2 (1210 s).
    const schedule = scheduleOf({ rows: [[1, 10], [5, 1000], [6, 600], [7, 600]], units: [[5], [6], [7]], shards: 2 })
    const shard1Minutes = formulaMinutes(10 + 1000)
    const largestMinutes = formulaMinutes(10 + 600 + 600)

    expect(compositionOf(schedule).map((entry) => entry.expectedSeconds)).toEqual([1010, 1210])
    expect(schedule.largestLimitMinutes).toBe(largestMinutes)
    expect(schedule.largestLimitMs).toBe(largestMinutes * MS_PER_MINUTE)
    expect(schedule.limitsMs.get(2)).toBe(schedule.largestLimitMs)
    expect(schedule.limitsMs.get(1)).toBe(shard1Minutes * MS_PER_MINUTE)
    expect(schedule.limitsMs.get(1)).not.toBe(schedule.largestLimitMs)
  })
})

describe('the limit timer (b.uqm SR-4.3)', () => {
  /** The runtime's largest timer delay, 2^31 − 1 ms: a runtime fact, not a runner constant. */
  const MAX_TIMER_DELAY_MS = 2 ** 31 - 1
  /** Test data: the shard containers' starts, after the build. */
  const CONTAINER_START_MS = START_MS + 45_000

  let root: string
  let runDir: string
  let clock: FakeClock
  let fired: { outcome: LimitTimerOutcome; atMs: number }[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-run-schedule-timer-'))
    runDir = makeRunDir(root, RUN_ID)
    clock = createFakeClock({ start: START_MS })
    fired = []
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** The limit of the 93.4-min shard, in ms: not a multiple of the sample interval. */
  function limitMs(): number {
    const ms = roundingSchedule().limitsMs.get(1)
    if (ms === undefined) throw new Error('no shard 1')
    return ms
  }

  function arm(options: { shard?: number; startedAtMs?: number; limitMs?: number } = {}): ReturnType<typeof armShardLimitTimer> {
    return armShardLimitTimer({
      clock,
      runDir,
      shard: options.shard ?? 1,
      startedAtMs: options.startedAtMs ?? CONTAINER_START_MS,
      limitMs: options.limitMs ?? limitMs(),
      onFire: (outcome) => fired.push({ outcome, atMs: clock.now() }),
    })
  }

  /** A complete run of script 5 in shard `shard`'s result file. */
  function finishedEvents(): ResultEvent[] {
    return [{ kind: 'start', fileName: scriptFile(5) }, endOf(5, 'pass', 20), { kind: 'done' }]
  }

  test('armed at the container start, it has not fired 1 ms before start + limit and fires exactly then; the limit is no multiple of the sample interval', async () => {
    const limit = limitMs()
    expect(limit % SAMPLE_INTERVAL_MS).not.toBe(0)
    await clock.advanceTo(CONTAINER_START_MS)
    writeShardDir(runDir, { shard: 1, resultFile: [{ kind: 'start', fileName: scriptFile(5) }] })
    arm()

    await clock.advanceTo(CONTAINER_START_MS + limit - 1)
    expect(fired).toEqual([])
    await clock.advanceTo(CONTAINER_START_MS + limit)

    expect(fired).toEqual([{ outcome: { kind: 'over-limit', shard: 1 }, atMs: CONTAINER_START_MS + limit }])
    expect(clock.pendingCount()).toBe(0)
  })

  test("armed after the container start, it still fires at the container's start + limit, not the run's or the arming's", async () => {
    const limit = limitMs()
    await clock.advanceTo(CONTAINER_START_MS + 10_000)
    arm()

    await clock.advanceTo(CONTAINER_START_MS + limit + 10_000)

    expect(fired.map((f) => f.atMs)).toEqual([CONTAINER_START_MS + limit])
  })

  test('armed after start + limit has passed, it fires on the next tick, 1 ms later', async () => {
    const late = CONTAINER_START_MS + limitMs() + 5_000
    await clock.advanceTo(late)
    arm()

    await clock.advanceTo(late + 1)

    expect(fired.map((f) => f.atMs)).toEqual([late + 1])
  })

  test('a limit above 2^31 − 1 ms is waited in steps no longer than that and fires exactly on time', async () => {
    const longLimit = 2 * MAX_TIMER_DELAY_MS + 12_345
    await clock.advanceTo(CONTAINER_START_MS)
    arm({ limitMs: longLimit })

    expect(clock.pendingCount()).toBe(1)
    expect(clock.pending().every((timer) => timer.delayMs <= MAX_TIMER_DELAY_MS)).toBe(true)
    await clock.advanceTo(CONTAINER_START_MS + MAX_TIMER_DELAY_MS)
    expect(fired).toEqual([])
    expect(clock.pendingCount()).toBe(1)
    expect(clock.pending().every((timer) => timer.delayMs <= MAX_TIMER_DELAY_MS)).toBe(true)
    await clock.advanceTo(CONTAINER_START_MS + longLimit - 1)
    expect(fired).toEqual([])
    expect(clock.pendingCount()).toBe(1)
    expect(clock.pending().every((timer) => timer.delayMs <= MAX_TIMER_DELAY_MS)).toBe(true)
    await clock.advanceTo(CONTAINER_START_MS + longLimit)

    expect(fired.map((f) => f.atMs)).toEqual([CONTAINER_START_MS + longLimit])
    expect(clock.pendingCount()).toBe(0)
  })

  test('two shards fire at their own moments with their own outcomes', async () => {
    const secondStart = CONTAINER_START_MS + 7_000
    const secondLimit = LIMIT_FLOOR_MINUTES * MS_PER_MINUTE
    writeShardDir(runDir, { shard: 1, resultFile: finishedEvents() })
    writeShardDir(runDir, { shard: 2, resultFile: [{ kind: 'start', fileName: scriptFile(6) }] })
    await clock.advanceTo(CONTAINER_START_MS)
    arm({ shard: 1 })
    await clock.advanceTo(secondStart)
    arm({ shard: 2, startedAtMs: secondStart, limitMs: secondLimit })

    await clock.advanceTo(CONTAINER_START_MS + limitMs())

    expect(fired).toEqual([
      { outcome: { kind: 'over-limit', shard: 2 }, atMs: secondStart + secondLimit },
      { outcome: { kind: 'ended', shard: 1 }, atMs: CONTAINER_START_MS + limitMs() },
    ])
  })

  test('an end marker written 1 ms before the limit gives "ended": the final reading is due, not over limit', async () => {
    const due = CONTAINER_START_MS + limitMs()
    await clock.advanceTo(CONTAINER_START_MS)
    arm()

    await clock.advanceTo(due - 1)
    writeShardDir(runDir, { shard: 1, resultFile: finishedEvents() })
    await clock.advanceTo(due)

    expect(fired).toEqual([{ outcome: { kind: 'ended', shard: 1 }, atMs: due }])
  })

  test('an end marker before other lines still gives "ended"', async () => {
    writeShardDir(runDir, { shard: 1, resultFile: [{ kind: 'done' }, { kind: 'start', fileName: scriptFile(5) }] })
    await clock.advanceTo(CONTAINER_START_MS)
    arm()

    await clock.advanceTo(CONTAINER_START_MS + limitMs())

    expect(fired.map((f) => f.outcome)).toEqual([{ kind: 'ended', shard: 1 }])
  })

  const OVER_LIMIT: readonly (readonly [string, () => ShardDirSpec | null])[] = [
    ['no end marker', () => ({ shard: 1, resultFile: [{ kind: 'start', fileName: scriptFile(5) }, endOf(5, 'pass', 20)] })],
    ['a done line without its line feed', () => ({ shard: 1, resultFile: { events: [{ kind: 'start', fileName: scriptFile(5) }, endOf(5, 'pass', 20)], partial: { event: { kind: 'done' } } } })],
    ['no result file', () => ({ shard: 1 })],
    ['no shard directory', () => null],
    ['an unreadable result file, its end marker included', () => ({ shard: 1, resultFile: { events: finishedEvents(), malformed: { at: 0, change: 'uppercase-word' } } })],
  ]

  test.each(OVER_LIMIT)('%s gives "over limit"', async (_label, spec) => {
    const shardDir = spec()
    if (shardDir !== null) writeShardDir(runDir, shardDir)
    await clock.advanceTo(CONTAINER_START_MS)
    arm()

    await clock.advanceTo(CONTAINER_START_MS + limitMs())

    expect(fired.map((f) => f.outcome)).toEqual([{ kind: 'over-limit', shard: 1 }])
  })

  test('a cancelled timer never fires and leaves no timer pending', async () => {
    await clock.advanceTo(CONTAINER_START_MS)
    const timer = arm()

    timer.cancel()
    timer.cancel()
    await clock.advanceTo(CONTAINER_START_MS + 2 * limitMs())

    expect(fired).toEqual([])
    expect(clock.pendingCount()).toBe(0)
  })

  test('cancelling after it fired is harmless: it fired once', async () => {
    await clock.advanceTo(CONTAINER_START_MS)
    const timer = arm()
    await clock.advanceTo(CONTAINER_START_MS + limitMs())

    timer.cancel()
    timer.cancel()
    await clock.advanceTo(CONTAINER_START_MS + 2 * limitMs())

    expect(fired.length).toBe(1)
    expect(clock.pendingCount()).toBe(0)
  })

  test.each([
    ['startedAtMs NaN', { startedAtMs: Number.NaN }],
    ['startedAtMs infinite', { startedAtMs: Number.POSITIVE_INFINITY }],
    ['limitMs NaN', { limitMs: Number.NaN }],
    ['limitMs infinite', { limitMs: Number.POSITIVE_INFINITY }],
    ['limitMs negative', { limitMs: -1 }],
    ['shard 0', { shard: 0 }],
    ['shard not whole', { shard: 1.5 }],
    ['shard negative', { shard: -1 }],
  ] as const)('arming with %s throws and arms nothing', (_label, options) => {
    expect(() => arm(options)).toThrow()
    expect(clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// T3.S4: timing, slow: lines and the duration-table block
// (b.uqm SR-4.4; AC 77's block half)
// ---------------------------------------------------------------------------

describe('timing (b.uqm SR-4.4)', () => {
  /** Two shards, test-1 in each; shard 2's `end` lines include a repeat, of which the first counts. */
  function twoShardRecord(): TimingRecord {
    return recordWith([
      shardRecord(2, START_MS + 131_000, START_MS + 200_000, eventsRead([endOf(1, 'pass', 24.001), endOf(6, 'fail', 12.5), endOf(6, 'pass', 99), { kind: 'notrun', fileName: scriptFile(7) }, { kind: 'done' }])),
      shardRecord(1, START_MS + 130_000, START_MS + 190_123, eventsRead([{ kind: 'start', fileName: scriptFile(1) }, endOf(1, 'pass', 23.456), endOf(5, 'pass', 21.347), { kind: 'done' }])),
    ])
  }

  test('the timing values: build with its base build, each shard from its container start to its final reading, each script per shard to the millisecond, and the total', () => {
    const values = timingValues(twoShardRecord())

    expect(values.timing).toEqual({ buildSeconds: 123.25, baseBuildSeconds: 60.5, totalSeconds: 260 })
    expect(values.shards).toEqual([
      { shard: 1, seconds: 60.123 },
      { shard: 2, seconds: 69 },
    ])
    expect(values.scripts).toEqual([
      { shard: 1, script: scriptFile(1), result: 'pass', ms: 23_456, seconds: 23.456 },
      { shard: 1, script: scriptFile(5), result: 'pass', ms: 21_347, seconds: 21.347 },
      { shard: 2, script: scriptFile(1), result: 'pass', ms: 24_001, seconds: 24.001 },
      { shard: 2, script: scriptFile(6), result: 'fail', ms: 12_500, seconds: 12.5 },
    ])
  })

  test('the timing lines in their fixed order, and the script time lines', () => {
    const values = timingValues(twoShardRecord())

    expect(timingLines(values)).toEqual([buildTimeLine(123.25, 60.5), shardTimeLine(1, 60.123), shardTimeLine(2, 69), totalTimeLine(260)])
    expect(scriptTimeLines(values)).toEqual([
      scriptTimeLine({ shard: 1, script: scriptFile(1), result: 'pass', ms: 23_456, seconds: 23.456 }),
      scriptTimeLine({ shard: 1, script: scriptFile(5), result: 'pass', ms: 21_347, seconds: 21.347 }),
      scriptTimeLine({ shard: 2, script: scriptFile(1), result: 'pass', ms: 24_001, seconds: 24.001 }),
      scriptTimeLine({ shard: 2, script: scriptFile(6), result: 'fail', ms: 12_500, seconds: 12.5 }),
    ])
    assertNoLeak({ timing: timingLines(values), scripts: scriptTimeLines(values) })
  })

  test.each([
    ['the base build did not run: 0', { baseBuild: null }, { baseBuildSeconds: 0 }],
    ['the base build never ended: it runs to the verdict', { baseBuild: { startedAtMs: START_MS + 3_000, endedAtMs: null } }, { baseBuildSeconds: 257 }],
    ['packing never started: the build is 0', { packingStartAtMs: null, pinnedKnownAtMs: null }, { buildSeconds: 0 }],
    ['the pinned ID was never known: the build runs to the verdict', { pinnedKnownAtMs: null }, { buildSeconds: 258 }],
  ] as const)('a step that never started counts 0, one that never ended runs to the verdict: %s', (_label, change, expected) => {
    const values = timingValues({ ...recordWith([]), ...change })

    expect(values.timing).toEqual({ buildSeconds: 123.25, baseBuildSeconds: 60.5, totalSeconds: 260, ...expected })
  })

  test("a shard with no container start or no final reading is not timed, and an unreadable or missing result file gives no script times", () => {
    const values = timingValues(
      recordWith([
        shardRecord(1, null, null, { kind: 'missing' }),
        shardRecord(2, START_MS + 130_000, null, { kind: 'unreadable', error: 'line 1 is of no result-file form' }),
      ]),
    )

    expect(values.shards).toEqual([
      { shard: 1, seconds: null },
      { shard: 2, seconds: null },
    ])
    expect(values.scripts).toEqual([])
    expect(timingLines(values).slice(1, 3)).toEqual([shardTimeLine(1, null), shardTimeLine(2, null)])
  })
})

describe('the slow: lines (b.uqm SR-4.4)', () => {
  test('one line per script over SLOW_FACTOR × its estimate, in canonical order, seconds rounded up, test-1 once on its highest time, from the middle shard', () => {
    // Shards: 1 holds test-7 (the default estimate), 2 holds test-5, 3 holds test-6; test-1's highest time, 17.5 s, is in shard 2.
    const schedule = scheduleOf({ rows: [[1, 10], [5, 20], [6, 20]], units: [[5], [6], [7]], shards: 3 })
    expect(compositionOf(schedule).map((entry) => entry.assigned)).toEqual([files(1, 7), files(1, 5), files(1, 6)])
    const overDefault = SLOW_FACTOR * DEFAULT_ESTIMATE_SECONDS + 0.001
    const record = recordOfShards(
      [endOf(1, 'pass', 16), endOf(7, 'pass', overDefault)],
      [endOf(1, 'pass', 17.5), endOf(5, 'pass', SLOW_FACTOR * 20 + 0.001)],
      [endOf(1, 'pass', 16.2), endOf(6, 'pass', SLOW_FACTOR * 20)],
    )
    const expected = [
      slowLine(scriptFile(1), 18, 10),
      slowLine(scriptFile(5), Math.ceil(SLOW_FACTOR * 20 + 0.001), 20),
      slowLine(scriptFile(7), Math.ceil(overDefault), DEFAULT_ESTIMATE_SECONDS),
    ]

    const report = timingReport(record, schedule)

    expect(report.slowLines).toEqual(expected)
    expect(slowLines(schedule.estimates, timingValues(record).scripts)).toEqual(expected)
    assertNoLeak(report)
  })
})

describe('the duration-table block (b.uqm SR-4.4)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-run-schedule-block-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** Nine pinned scripts in one shard; the table has entries for five of them and one unlisted script. */
  function blockSchedule(): Schedule {
    return scheduleRun({
      pinned: files(8, 7, 6, 5, 0, 4, 3, 2, 1),
      table: textSource(tableText([[1, 10], [2, 5], [3, 7], [4, 9], [6, 40], [8, 30], [9, 50]])),
      units: [[2, 3], [4], [0], [5], [6], [7], [8]].map(unitOf),
      invocation: invocationOf(),
      shards: 1,
    })
  }

  function blockRecord(): TimingRecord {
    return recordOfShards([
      endOf(1, 'pass', 12.345),
      endOf(2, 'pass', 0),
      endOf(3, 'pass', 0.4),
      endOf(4, 'fail', 3),
      endOf(0, 'pass', 21.001),
      { kind: 'notrun', fileName: scriptFile(5) },
      { kind: 'notrun', fileName: scriptFile(6) },
      endOf(7, 'fail', 4),
      endOf(8, 'pass', 35),
    ])
  }

  test("the header, then the pinned list in canonical order: passed scripts' times rounded up and never below 1, failed and notrun scripts' entries kept, no line without either, unlisted entries left out", () => {
    const block = durationTableBlock(blockSchedule(), timingValues(blockRecord()).scripts)

    expect(block).toEqual([
      DURATION_TABLE_HEADER,
      `${nf(1)}\t13`,
      `${nf(2)}\t1`,
      `${nf(3)}\t1`,
      `${nf(4)}\t9`,
      `${nf(0)}\t22`,
      `${nf(6)}\t40`,
      `${nf(8)}\t35`,
    ])
  })

  /** Per case: the table rows, then test-1's events in shards 1, 2 and 3, then the block's expected test-1 lines. */
  const TEST_1_RUNS: readonly (readonly [string, readonly (readonly [number, number])[], () => readonly (readonly ResultEvent[])[], () => string[]])[] = [
    ['passed in every shard: its highest time, from the middle shard', [[1, 10]], () => [[endOf(1, 'pass', 16)], [endOf(1, 'pass', 17.5)], [endOf(1, 'pass', 16.2)]], () => [`${nf(1)}\t18`]],
    ['failed in one shard: its entry', [[1, 10]], () => [[endOf(1, 'pass', 12.2)], [endOf(1, 'fail', 17.5)], [endOf(1, 'pass', 16.2)]], () => [`${nf(1)}\t10`]],
    ['no end line in one shard: its entry', [[1, 10]], () => [[endOf(1, 'pass', 12.2)], [{ kind: 'start', fileName: scriptFile(1) }], [endOf(1, 'pass', 16.2)]], () => [`${nf(1)}\t10`]],
    ['failed in one shard, with no entry: no line', [], () => [[endOf(1, 'pass', 12.2)], [endOf(1, 'fail', 17.5)], [endOf(1, 'pass', 16.2)]], () => []],
  ]

  test.each(TEST_1_RUNS)('test-1 over three shards, %s', (_label, rows, shardEvents, expected) => {
    const schedule = scheduleOf({ rows, units: [[5], [6], [7]], shards: 3 })

    const block = durationTableBlock(schedule, timingValues(recordOfShards(...shardEvents())).scripts)

    expect(block.filter((line) => line.startsWith(`${nf(1)}\t`))).toEqual(expected())
  })

  test("a selective run's block keeps every unselected script's entry", () => {
    const built = buildWorktree(root, { durationTable: { kind: 'rows', header: DURATION_TABLE_HEADER, rows: realScriptNumbers().map((n) => ({ script: n, seconds: n + 10 })) } })
    const run = validated(built.root, [nf(5)])
    const schedule = scheduleRun({ pinned: built.scriptFileNames, table: readFileText(built.durationTablePath), units: run.units, invocation: run.invocation, shards: run.effectiveShards })

    const block = durationTableBlock(schedule, timingValues(recordOfShards([endOf(1, 'pass', 50), endOf(5, 'pass', 99.5)])).scripts)

    const measured: Readonly<Record<number, number>> = { 1: 50, 5: 100 }
    const kept = realScriptNumbers().map((n) => `${nf(n)}\t${measured[n] ?? n + 10}`)
    expect(block).toEqual([DURATION_TABLE_HEADER, ...kept])
    assertNoLeak({ schedule, block })
  })

  test('printed: exactly one introducing line naming the block, real tabs, and the table notes alongside', () => {
    const schedule = blockSchedule()
    expect(schedule.notes.length).toBeGreaterThan(0)

    const report = timingReport(blockRecord(), schedule)

    const [intro, ...block] = report.blockLines
    expect(intro).toBe(durationTableBlockIntro(block.length))
    expect(block).toEqual(durationTableBlock(schedule, report.values.scripts))
    expect(block.every((line) => line.split('\t').length === 2)).toBe(true)
    expect(report.notes).toEqual(schedule.notes)
    expect(report.timingLines).toEqual(timingLines(report.values))
    expect(report.scriptLines).toEqual(scriptTimeLines(report.values))
    assertNoLeak(report)
  })

  test('round trip: the block, parsed back against the same list, gives no notes and the printed seconds', () => {
    const schedule = blockSchedule()
    const block = durationTableBlock(schedule, timingValues(blockRecord()).scripts)

    const table = parseDurationTable(textSource(textOf(block)), files(8, 7, 6, 5, 0, 4, 3, 2, 1))

    expect(table.readable).toBe(true)
    expect(table.notes).toEqual([])
    expect(entriesOf(table.entries)).toEqual(block.slice(1).map((line) => {
      const [form, seconds] = line.split('\t')
      return [form, Number(seconds)]
    }))
  })

  test('a run never scheduled has no block, no slow: lines and no notes, and its timing values are numbers', () => {
    const report = timingReport({ ...recordWith([]), pinnedKnownAtMs: null }, null)

    expect({ blockLines: report.blockLines, slowLines: report.slowLines, notes: report.notes }).toEqual({ blockLines: [], slowLines: [], notes: [] })
    expect(report.values.timing).toEqual({ buildSeconds: 258, baseBuildSeconds: 60.5, totalSeconds: 260 })
  })
})

// ---------------------------------------------------------------------------
// Section 8's wordings: the only place their text is typed
// ---------------------------------------------------------------------------

describe("section 8's wordings (b.uqm SR-4.1, SR-4.4)", () => {
  const TABLE = `duration table ${DURATION_TABLE_PATH}`
  const DEFAULTS = `every script gets the default estimate, ${DEFAULT_ESTIMATE_SECONDS} s`

  const WORDINGS: readonly (readonly [string, () => string, () => string])[] = [
    ['missing table', () => durationTableMissingNote(), () => `${TABLE} is missing: ${DEFAULTS}`],
    ['table read failed, its error on one line', () => durationTableReadFailedNote('EISDIR: illegal operation on a directory,\n  read'), () => `${TABLE} cannot be read (EISDIR: illegal operation on a directory, read): ${DEFAULTS}`],
    ['wrong header', () => durationTableWrongHeaderNote(), () => `${TABLE} is unreadable: line 1 is not the header "script\\tseconds": ${DEFAULTS}`],
    ['carriage return', () => durationLineIgnoredNote(4, { kind: 'carriage-return' }), () => `${TABLE} line 4 ignored: it holds a carriage return`],
    ['empty line', () => durationLineIgnoredNote(4, { kind: 'empty' }), () => `${TABLE} line 4 ignored: it is empty`],
    ['no tab', () => durationLineIgnoredNote(4, { kind: 'no-tab' }), () => `${TABLE} line 4 ignored: no tab separates the script from its seconds`],
    ['bad script', () => durationLineIgnoredNote(4, { kind: 'bad-script', script: 'test-05' }), () => `${TABLE} line 4 ignored: test-05 is not a number form test-<n>, n a whole number`],
    ['bad script with a leading space, quoted', () => durationLineIgnoredNote(4, { kind: 'bad-script', script: ' test-5' }), () => `${TABLE} line 4 ignored: " test-5" is not a number form test-<n>, n a whole number`],
    ['bad seconds', () => durationLineIgnoredNote(4, { kind: 'bad-seconds', seconds: '9.5' }), () => `${TABLE} line 4 ignored: seconds 9.5 is not a whole number above 0`],
    ['bad seconds with a trailing space, quoted', () => durationLineIgnoredNote(4, { kind: 'bad-seconds', seconds: '9 ' }), () => `${TABLE} line 4 ignored: seconds "9 " is not a whole number above 0`],
    [
      'bad seconds past the bound, which it names',
      () => durationLineIgnoredNote(4, { kind: 'bad-seconds', seconds: '9007199254740992' }),
      () => `${TABLE} line 4 ignored: seconds 9007199254740992 is not a whole number above 0 and at most 9007199254740991`,
    ],
    ['repeated', () => durationLineIgnoredNote(4, { kind: 'repeated', numberForm: 'test-5', firstLine: 2 }), () => `${TABLE} line 4 ignored: test-5 is already listed on line 2`],
    ['not listed', () => durationLineIgnoredNote(4, { kind: 'not-listed', numberForm: 'test-9' }), () => `${TABLE} line 4 ignored: test-9 is not in the test image's script list`],
    ['out of order', () => durationLineOutOfOrderNote(5, 'test-2', 'test-5', 3), () => `${TABLE} line 5 is out of canonical order: test-2 follows test-5 on line 3; its entry is used`],
    ['block intro', () => durationTableBlockIntro(3), () => `duration table block, the next 3 lines: paste them as ${DURATION_TABLE_PATH} to refresh the table`],
    ['build time', () => buildTimeLine(123.25, 0), () => 'build: 123.250 s (base build 0.000 s)'],
    ['shard time', () => shardTimeLine(2, 61.25), () => `${SHARD_DIR_PREFIX}2: 61.250 s`],
    ['shard not timed', () => shardTimeLine(3, null), () => `${SHARD_DIR_PREFIX}3: not timed`],
    ['total time', () => totalTimeLine(260), () => 'total: 260.000 s'],
    ['script time, pass', () => scriptTimeLine({ shard: 1, script: scriptFile(5), result: 'pass', ms: 21_347, seconds: 21.347 }), () => `${SHARD_DIR_PREFIX}1 ${scriptFile(5)}: 21.347 s (pass)`],
    ['script time, fail', () => scriptTimeLine({ shard: 2, script: scriptFile(6), result: 'fail', ms: 500, seconds: 0.5 }), () => `${SHARD_DIR_PREFIX}2 ${scriptFile(6)}: 0.500 s (fail)`],
    ['slow line', () => slowLine(scriptFile(5), 31, 20), () => `slow: ${scriptFile(5)} took 31 s, estimate 20 s`],
  ]

  test.each(WORDINGS)('%s', (_label, actual, expected) => {
    const text = actual()

    expect(text).toBe(expected())
    expect(text.includes('\n')).toBe(false)
    assertNoLeak(text)
  })
})
