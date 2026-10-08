/**
 * ci-run-results.test.ts — Tests for the sharded `/ci` runner's in-shard
 * formats, how it reads them, and what it writes at the end of a run
 * (`scripts/ci-run.ts`; b.uqm SR-21.6's "results" file).
 *
 * One region per Epic that adds to this file, in this fixed order: E1, E9,
 * E10, E11, E12, E13 (Plan b.t6s). Each lane writes only in its own region.
 *
 * E1's region (b.uqm SR-11.3, SR-11.5, SR-16.1, the verdict write of SR-5.7):
 * - result-file lines are built from the exported words, fields single-spaced,
 *   and a script time is digits, a point and exactly three digits;
 * - a result file is read by lines: a last line without its line feed is
 *   still being written and is ignored; a complete line of no known form, a
 *   carriage return included, makes the file unreadable; a missing file reads
 *   as missing, never as unreadable;
 * - a hex record is exactly its length of lowercase hexadecimal characters
 *   and one line feed, else malformed (an unreadable one included);
 * - the file-text read tells content, missing and unreadable apart;
 * - the verdict is written whole through a temporary file and a rename, at
 *   WRITTEN_FILE_MODE over a leftover temporary file, never through a link
 *   planted at the temporary path, and not at all over a directory there;
 * - `results.json`'s serializer writes SR-16.1's keys in order, its parser
 *   reads that text back to the same value, and refuses any other shape.
 *
 * Every file is built by the run-directory builder in
 * `tests/test-helpers/ci-run.ts` or by the runner's own writers; an invalid
 * one is a valid one with a stated change. Script names come from the
 * repository's listing. Each case runs under its own `mkdtempSync` root,
 * removed in `afterEach`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  atomicTempFileName,
  CANARY_FILE_NAME,
  CANARY_LENGTH,
  CI_LABEL,
  CI_LABEL_VALUE,
  CPUS_PER_SHARD,
  DEPENDENCY_FINGERPRINT_FILE_NAME,
  FAIL_PREFIX,
  formatHexRecord,
  formatResultFile,
  formatResultLine,
  formatResultSeconds,
  INJECTED_FAILURE_TEXT,
  injectedFailureLine,
  PACKAGE_SHA256_FILE_NAME,
  parseHexRecord,
  parseResultFileText,
  parseResultLine,
  parseResults,
  readFileText,
  readHexRecord,
  readResultFile,
  RESULT_FILE_NAME,
  RESULT_WORD_DONE,
  RESULT_WORD_END,
  RESULT_WORD_FAIL,
  RESULT_WORD_NOTRUN,
  RESULT_WORD_PASS,
  RESULT_WORD_START,
  RESULTS_FORMAT_VERSION,
  SHA256_HEX_LENGTH,
  SHARD_DIR_PREFIX,
  SHARD_MEMORY_CAP_BYTES,
  SHARD_PIDS_LIMIT,
  serializeResults,
  UNREADABLE_READING,
  VERDICT_FILE_NAME,
  WRITTEN_FILE_MODE,
  writeVerdictFile,
  type ResultEvent,
  type Results,
  type ScriptResult,
} from '../scripts/ci-run.ts'
import {
  hexValue,
  makeResults,
  makeRunDir,
  realScriptFileName,
  writeLeftoverTempFile,
  writeResults,
  writeShardDir,
  writeVerdict,
  type HexRecordChange,
  type JsonFileChange,
  type ResultLineChange,
} from './test-helpers/ci-run.ts'

// Shared by every region: each case's own temp root, removed after it.

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ci-run-results-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Whether this process can read a mode-000 file anyway (root), which makes the permission rows meaningless. */
const READS_ANY_FILE = process.getuid?.() === 0

// ---------------------------------------------------------------------------
// E1: in-shard formats, result-file reading, the file-text read, the verdict
// write and results.json (b.t6s E1 T9; b.uqm SR-11.3, SR-11.5, SR-16.1)
// ---------------------------------------------------------------------------

/** A RUN_ID of the SR-5.1 form, for the run directories built here. */
const RUN_ID = '20261008t120000z-results1'
/** A runner PID for results files; no process is ever signalled or probed. */
const RUNNER_PID = 4242

/** The case's run directory, mode 0700, in its own temp directory. */
function newRunDir(): string {
  return makeRunDir(root, RUN_ID)
}

/** The repository's first three real script file names, test-1 first, looked up when a case runs. */
function scripts(): [string, string, string] {
  return [realScriptFileName(1), realScriptFileName(2), realScriptFileName(3)]
}

function startEvent(fileName: string): ResultEvent {
  return { kind: RESULT_WORD_START, fileName }
}

function endEvent(fileName: string, result: ScriptResult, seconds: number): ResultEvent {
  return { kind: RESULT_WORD_END, fileName, result, seconds }
}

function notRunEvent(fileName: string): ResultEvent {
  return { kind: RESULT_WORD_NOTRUN, fileName }
}

const DONE_EVENT: ResultEvent = { kind: RESULT_WORD_DONE }

/** A shard that ran two scripts, stopped at the second's failure and wrote its end marker: every line form once. */
function everyLineForm(): ResultEvent[] {
  const [first, second, third] = scripts()
  return [
    startEvent(first),
    endEvent(first, RESULT_WORD_PASS, 21.347),
    startEvent(second),
    endEvent(second, RESULT_WORD_FAIL, 0.512),
    notRunEvent(third),
    DONE_EVENT,
  ]
}

/** A valid line with its `index`-th single-space-separated field replaced. */
function withField(line: string, index: number, value: string): string {
  const fields = line.split(' ')
  fields[index] = value
  return fields.join(' ')
}

describe('E1: result-file lines (b.uqm SR-11.3, SR-11.5)', () => {
  test.each([
    ['start', () => startEvent(scripts()[0]), () => [RESULT_WORD_START, scripts()[0]]],
    ['end … pass', () => endEvent(scripts()[0], RESULT_WORD_PASS, 21.347), () => [RESULT_WORD_END, scripts()[0], RESULT_WORD_PASS, formatResultSeconds(21.347)]],
    ['end … fail', () => endEvent(scripts()[0], RESULT_WORD_FAIL, 0), () => [RESULT_WORD_END, scripts()[0], RESULT_WORD_FAIL, formatResultSeconds(0)]],
    ['notrun', () => notRunEvent(scripts()[0]), () => [RESULT_WORD_NOTRUN, scripts()[0]]],
    ['done', () => DONE_EVENT, () => [RESULT_WORD_DONE]],
  ] as const)('a %s line is the exported words, single-spaced, and reads back as its event', (_name, event, fields) => {
    const line = formatResultLine(event())
    expect(line).toBe(fields().join(' '))
    expect(parseResultLine(line)).toEqual(event())
  })

  test.each([
    [0, '0.000'],
    [0.512, '0.512'],
    [21.347, '21.347'],
    [21.3474, '21.347'],
    [1200.5, '1200.500'],
  ])('a script time of %p s is written %p: digits, a point and exactly three digits', (seconds, text) => {
    expect(formatResultSeconds(seconds)).toBe(text)
  })

  test.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY]])('a script time of %p is refused, so no writer writes a line no reader reads', (seconds) => {
    expect(() => formatResultSeconds(seconds)).toThrow()
    expect(() => formatResultLine(endEvent(scripts()[0], RESULT_WORD_PASS, seconds))).toThrow()
  })

  test.each([
    ['a number with a leading zero', (name: string) => name.replace(/^test-/, 'test-0')],
    ['a name without its .sh', (name: string) => name.replace(/\.sh$/, '')],
  ])('an event naming %s is refused by the line builder', (_what, rename) => {
    const bad = rename(scripts()[0])
    expect(() => formatResultLine(startEvent(bad))).toThrow()
    expect(() => formatResultLine(notRunEvent(bad))).toThrow()
    expect(() => formatResultLine(endEvent(bad, RESULT_WORD_PASS, 1))).toThrow()
  })

  test('the injected-failure line is FAIL: <file name>: injected failure, from the exported texts', () => {
    const name = scripts()[1]
    expect(injectedFailureLine(name)).toBe(`${FAIL_PREFIX}${name}: ${INJECTED_FAILURE_TEXT}`)
  })
})

describe('E1: reading a result file (b.uqm SR-11.3)', () => {
  test('each valid line form is read, in order', () => {
    const events = everyLineForm()
    const shardDir = writeShardDir(newRunDir(), { shard: 1, resultFile: events })
    expect(readResultFile(shardDir)).toEqual({ kind: 'events', events })
  })

  test('an empty result file reads as no events yet', () => {
    const shardDir = writeShardDir(newRunDir(), { shard: 1, resultFile: [] })
    expect(readResultFile(shardDir)).toEqual({ kind: 'events', events: [] })
  })

  test.each([
    [
      'the end marker without its line feed',
      () => ({ complete: everyLineForm().slice(0, -1), event: DONE_EVENT, cut: 0 }),
    ],
    [
      'an end line cut inside its seconds',
      () => ({ complete: [startEvent(scripts()[0])], event: endEvent(scripts()[0], RESULT_WORD_PASS, 21.347), cut: 2 }),
    ],
    [
      'the first character of a start line',
      () => ({ complete: everyLineForm().slice(0, 2), event: startEvent(scripts()[1]), cut: -1 }),
    ],
  ])('a last line without its line feed is still being written and is ignored: %s', (_what, spec) => {
    const { complete, event, cut } = spec()
    const whole = formatResultLine(event).length
    const length = cut < 0 ? 1 : whole - cut
    const shardDir = writeShardDir(newRunDir(), { shard: 1, resultFile: { events: complete, partial: { event, length } } })
    expect(readResultFile(shardDir)).toEqual({ kind: 'events', events: complete })
  })

  test.each([
    ['carriage-return', 5],
    ['carriage-return', 0],
    ['double-space', 1],
    ['uppercase-word', 3],
    ['empty-line', 4],
    ['empty-line', 5],
  ] as [ResultLineChange, number][])('a complete line made malformed by %s (line %p) makes the file unreadable', (change, at) => {
    const shardDir = writeShardDir(newRunDir(), { shard: 1, resultFile: { events: everyLineForm(), malformed: { at, change } } })
    expect(readResultFile(shardDir).kind).toBe('unreadable')
  })

  test('a malformed complete line still makes the file unreadable when a partial last line follows it', () => {
    const [first] = scripts()
    const shardDir = writeShardDir(newRunDir(), {
      shard: 1,
      resultFile: { events: [startEvent(first)], malformed: { at: 0, change: 'carriage-return' }, partial: { event: endEvent(first, RESULT_WORD_PASS, 1) } },
    })
    expect(readResultFile(shardDir).kind).toBe('unreadable')
  })

  // Each row changes one valid line into a line of no known form. Seconds
  // changes apply to `end <test-1> pass 1.000`.
  const endLine = (): string => formatResultLine(endEvent(scripts()[0], RESULT_WORD_PASS, 1))
  const seconds = (): string => formatResultSeconds(1)
  test.each([
    ['seconds with a leading zero', () => withField(endLine(), 3, `0${seconds()}`)],
    ['seconds with two decimals', () => withField(endLine(), 3, seconds().slice(0, -1))],
    ['seconds with four decimals', () => withField(endLine(), 3, `${seconds()}0`)],
    ['seconds without a point', () => withField(endLine(), 3, seconds().split('.')[0] as string)],
    ['seconds without an integer part', () => withField(endLine(), 3, seconds().slice(seconds().indexOf('.')))],
    ['seconds with a sign', () => withField(endLine(), 3, `+${seconds()}`)],
    ['an end line without its seconds', () => endLine().split(' ').slice(0, 3).join(' ')],
    ['an end line with an unknown result word', () => withField(endLine(), 2, `${RESULT_WORD_PASS}ed`)],
    ['a file name with a leading-zero number', () => withField(formatResultLine(startEvent(scripts()[0])), 1, scripts()[0].replace(/^test-/, 'test-0'))],
    ['a file name without its .sh', () => withField(formatResultLine(notRunEvent(scripts()[0])), 1, scripts()[0].replace(/\.sh$/, ''))],
    ['a start line with an extra field', () => `${formatResultLine(startEvent(scripts()[0]))} ${scripts()[1]}`],
    ['an end marker naming a file', () => `${formatResultLine(DONE_EVENT)} ${scripts()[0]}`],
    ['a trailing space', () => `${formatResultLine(DONE_EVENT)} `],
    ['a tab between fields', () => formatResultLine(startEvent(scripts()[0])).replace(' ', '\t')],
  ])('a complete line with %s is of no known form and makes the file unreadable', (_what, line) => {
    const changed = line()
    expect(parseResultLine(changed)).toBeNull()
    const complete = formatResultFile([startEvent(scripts()[0])])
    expect(parseResultFileText(`${complete}${changed}\n`).kind).toBe('unreadable')
    // The same line still being written is ignored.
    expect(parseResultFileText(`${complete}${changed}`)).toEqual({ kind: 'events', events: [startEvent(scripts()[0])] })
  })

  test.each([
    ['its shard subdirectory has no result file', (runDir: string) => writeShardDir(runDir, { shard: 1, canary: hexValue('canary', CANARY_LENGTH) })],
    ['its shard subdirectory does not exist', (runDir: string) => join(runDir, `${SHARD_DIR_PREFIX}1`)],
  ])('a missing result file reads as missing, never as unreadable: %s', (_what, shardDirOf) => {
    expect(readResultFile(shardDirOf(newRunDir()))).toEqual({ kind: 'missing' })
  })

  test('a result file that cannot be read (a directory at its path) is unreadable', () => {
    const shardDir = writeShardDir(newRunDir(), { shard: 1 })
    mkdirSync(join(shardDir, RESULT_FILE_NAME))
    expect(readResultFile(shardDir).kind).toBe('unreadable')
  })

  test.skipIf(READS_ANY_FILE)('a result file without read permission is unreadable (skipped as root, which reads any file)', () => {
    const shardDir = writeShardDir(newRunDir(), { shard: 1, resultFile: everyLineForm() })
    chmodSync(join(shardDir, RESULT_FILE_NAME), 0o000)
    expect(readResultFile(shardDir).kind).toBe('unreadable')
  })
})

describe('E1: in-shard hex records (b.uqm SR-11.3)', () => {
  const RECORDS = [
    [CANARY_FILE_NAME, CANARY_LENGTH, 'canary'],
    [PACKAGE_SHA256_FILE_NAME, SHA256_HEX_LENGTH, 'packageSha256'],
    [DEPENDENCY_FINGERPRINT_FILE_NAME, SHA256_HEX_LENGTH, 'dependencyFingerprint'],
  ] as const

  test.each(RECORDS)('a valid %s (%p characters) is its value and one line feed, and reads as its value', (fileName, length, key) => {
    const value = hexValue(fileName, length)
    const shardDir = writeShardDir(newRunDir(), { shard: 1, [key]: value })
    const path = join(shardDir, fileName)
    expect(readFileSync(path, 'utf-8')).toBe(`${value}\n`)
    expect(readHexRecord(path, length)).toEqual({ kind: 'value', value })
  })

  const CHANGES: HexRecordChange[] = ['no-final-line-feed', 'uppercase', 'short', 'extra-line-feed']
  test.each(RECORDS.flatMap(([fileName, length, key]) => CHANGES.map((change) => [fileName, change, length, key] as const)))(
    'a %s changed by %s reads as malformed',
    (fileName, change, length, key) => {
      const shardDir = writeShardDir(newRunDir(), { shard: 1, [key]: { value: hexValue(fileName, length), change } })
      expect(readHexRecord(join(shardDir, fileName), length).kind).toBe('malformed')
    },
  )

  test('a valid 64-character record read as a canary is the wrong length, so malformed', () => {
    const shardDir = writeShardDir(newRunDir(), { shard: 1, packageSha256: hexValue('package', SHA256_HEX_LENGTH) })
    expect(readHexRecord(join(shardDir, PACKAGE_SHA256_FILE_NAME), CANARY_LENGTH).kind).toBe('malformed')
  })

  test('a missing record reads as missing; one that cannot be read reads as malformed', () => {
    const shardDir = writeShardDir(newRunDir(), { shard: 1 })
    expect(readHexRecord(join(shardDir, CANARY_FILE_NAME), CANARY_LENGTH)).toEqual({ kind: 'missing' })
    mkdirSync(join(shardDir, CANARY_FILE_NAME))
    expect(readHexRecord(join(shardDir, CANARY_FILE_NAME), CANARY_LENGTH).kind).toBe('malformed')
  })

  test('the record builder refuses a value of another form, and the parser reads only what it builds', () => {
    const value = hexValue('canary', CANARY_LENGTH)
    expect(() => formatHexRecord(value.toUpperCase(), CANARY_LENGTH)).toThrow()
    expect(() => formatHexRecord(value.slice(1), CANARY_LENGTH)).toThrow()
    expect(parseHexRecord(formatHexRecord(value, CANARY_LENGTH), CANARY_LENGTH)).toEqual({ ok: true, value })
  })
})

describe('E1: the file-text read', () => {
  test.each([
    ['text on several lines', 'first\nsecond\n'],
    ['an empty file', ''],
  ])('a readable file reads as its exact content: %s', (_what, content) => {
    const path = join(root, 'file.txt')
    writeFileSync(path, content)
    expect(readFileText(path)).toEqual({ kind: 'text', text: content })
  })

  test.each([
    ['no file at the path', () => join(root, 'absent.txt')],
    ['no directory above it', () => join(root, 'absent', 'file.txt')],
  ])('a path with %s reads as missing', (_what, path) => {
    expect(readFileText(path())).toEqual({ kind: 'missing' })
  })

  test('a directory at the path is unreadable, with its error on one line', () => {
    const read = readFileText(root)
    expect(read.kind).toBe('unreadable')
    if (read.kind === 'unreadable') expect(read.error).not.toMatch(/[\r\n]/)
  })

  test.skipIf(READS_ANY_FILE)('a file without read permission is unreadable, never missing (skipped as root, which reads any file)', () => {
    const path = join(root, 'file.txt')
    writeFileSync(path, 'content\n')
    chmodSync(path, 0o000)
    expect(readFileText(path).kind).toBe('unreadable')
  })
})

describe('E1: the verdict write (b.uqm SR-5.7)', () => {
  const FIRST_LINE = 'the first verdict line'
  const SECOND_LINE = 'the second verdict line'

  function verdictPath(runDir: string): string {
    return join(runDir, VERDICT_FILE_NAME)
  }

  test('writes exactly its line and one line feed, mode WRITTEN_FILE_MODE, leaving no temporary file', () => {
    const runDir = newRunDir()
    expect(writeVerdictFile(runDir, FIRST_LINE)).toEqual({ ok: true })
    expect(readFileSync(verdictPath(runDir), 'utf-8')).toBe(`${FIRST_LINE}\n`)
    expect(statSync(verdictPath(runDir)).mode & 0o777).toBe(WRITTEN_FILE_MODE)
    expect(readdirSync(runDir)).toEqual([VERDICT_FILE_NAME])
  })

  test('replaces the file whole through a temporary file and a rename: a new inode, no temporary file left', () => {
    const runDir = newRunDir()
    const before = statSync(writeVerdict(runDir, FIRST_LINE)).ino
    expect(writeVerdictFile(runDir, SECOND_LINE)).toEqual({ ok: true })
    expect(readFileSync(verdictPath(runDir), 'utf-8')).toBe(`${SECOND_LINE}\n`)
    expect(statSync(verdictPath(runDir)).ino).not.toBe(before)
    expect(readdirSync(runDir)).toEqual([VERDICT_FILE_NAME])
  })

  test('a leftover temporary file of an interrupted write, at another mode, is replaced: the verdict comes out at WRITTEN_FILE_MODE, no temporary file left', () => {
    const runDir = newRunDir()
    const leftover = writeLeftoverTempFile(runDir, VERDICT_FILE_NAME, FIRST_LINE.slice(0, 5))
    chmodSync(leftover, 0o644)
    expect(statSync(leftover).mode & 0o777).not.toBe(WRITTEN_FILE_MODE)
    expect(writeVerdictFile(runDir, SECOND_LINE)).toEqual({ ok: true })
    expect(readFileSync(verdictPath(runDir), 'utf-8')).toBe(`${SECOND_LINE}\n`)
    expect(statSync(verdictPath(runDir)).mode & 0o777).toBe(WRITTEN_FILE_MODE)
    expect(readdirSync(runDir)).toEqual([VERDICT_FILE_NAME])
  })

  test.each([
    ['an existing file outside the run directory', true],
    ['a path that does not exist (a dangling link)', false],
  ])('a symlink planted at the temporary path to %s is not followed: its target is untouched and the verdict is a regular file', (_what, targetExists) => {
    const runDir = newRunDir()
    const target = join(root, 'link-target.txt')
    const targetText = 'the link target, never written\n'
    if (targetExists) {
      writeFileSync(target, targetText)
      chmodSync(target, 0o644)
    }
    const targetBefore = targetExists ? { text: readFileSync(target, 'utf-8'), ino: statSync(target).ino, mode: statSync(target).mode } : null
    symlinkSync(target, join(runDir, atomicTempFileName(VERDICT_FILE_NAME)))

    expect(writeVerdictFile(runDir, FIRST_LINE)).toEqual({ ok: true })

    const verdict = lstatSync(verdictPath(runDir))
    expect(verdict.isFile()).toBe(true)
    expect(verdict.isSymbolicLink()).toBe(false)
    expect(verdict.mode & 0o777).toBe(WRITTEN_FILE_MODE)
    expect(readFileSync(verdictPath(runDir), 'utf-8')).toBe(`${FIRST_LINE}\n`)
    expect(readdirSync(runDir)).toEqual([VERDICT_FILE_NAME])
    if (targetBefore === null) expect(existsSync(target)).toBe(false)
    else expect({ text: readFileSync(target, 'utf-8'), ino: statSync(target).ino, mode: statSync(target).mode }).toEqual(targetBefore)
  })

  test('a directory at the temporary path makes the write fail, with its error on one line, and leaves the previous verdict as it was', () => {
    const runDir = newRunDir()
    const path = writeVerdict(runDir, FIRST_LINE)
    const before = { text: readFileSync(path, 'utf-8'), ino: statSync(path).ino, mode: statSync(path).mode }
    mkdirSync(join(runDir, atomicTempFileName(VERDICT_FILE_NAME)))

    const written = writeVerdictFile(runDir, SECOND_LINE)

    expect(written.ok).toBe(false)
    if (!written.ok) expect(written.error).not.toMatch(/[\r\n]/)
    expect({ text: readFileSync(path, 'utf-8'), ino: statSync(path).ino, mode: statSync(path).mode }).toEqual(before)
  })

  test.each([
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
  ])('a line holding %s is refused and the verdict already there is left as it was', (_what, lineBreak) => {
    const runDir = newRunDir()
    const before = statSync(writeVerdict(runDir, FIRST_LINE)).ino
    const written = writeVerdictFile(runDir, `${SECOND_LINE}${lineBreak}${FIRST_LINE}`)
    expect(written.ok).toBe(false)
    expect(readFileSync(verdictPath(runDir), 'utf-8')).toBe(`${FIRST_LINE}\n`)
    expect(statSync(verdictPath(runDir)).ino).toBe(before)
    expect(readdirSync(runDir)).toEqual([VERDICT_FILE_NAME])
  })

  test('a write into a run directory that does not exist fails with its error on one line and creates nothing', () => {
    const runDir = join(root, 'absent')
    const written = writeVerdictFile(runDir, FIRST_LINE)
    expect(written.ok).toBe(false)
    if (!written.ok) expect(written.error).not.toMatch(/[\r\n]/)
    expect(existsSync(runDir)).toBe(false)
  })
})

describe('E1: results.json (b.uqm SR-16.1)', () => {
  /** SR-16.1's top-level keys, in its order. */
  const SR_16_1_KEYS = [
    'version',
    'runId',
    'pid',
    'packageSha256',
    'images',
    'verdict',
    'invocation',
    'scripts',
    'shards',
    'shardCount',
    'cap',
    'workingSet',
    'failedReadings',
    'modes',
    'failures',
    'skippedChecks',
    'cleanupFailures',
    'timing',
    'timingSummary',
  ]

  /** The results of a two-shard run in `runDir` whose shard 1 stopped at an injected failure: every nullable key once null and once set, every union once in each form. */
  function twoShardResults(runDir: string): Results {
    const [first, second, third] = scripts()
    writeShardDir(runDir, { shard: 2 })
    writeShardDir(runDir, { shard: 1 })
    const failLine = injectedFailureLine(second)
    const base = makeResults({ runId: RUN_ID, pid: RUNNER_PID }, runDir)
    const shardCommon = {
      expectedSeconds: 1800,
      limitMinutes: 75,
      packageSha256: hexValue('package', SHA256_HEX_LENGTH),
      imageId: `sha256:${hexValue('pinned', SHA256_HEX_LENGTH)}`,
    }
    return makeResults(
      {
        runId: RUN_ID,
        pid: RUNNER_PID,
        packageSha256: hexValue('package', SHA256_HEX_LENGTH),
        images: { pinned: shardCommon.imageId, drift: null, retag: null, retagMoved: false },
        verdict: failLine,
        invocation: { args: ['--shards', '2'], selective: false, faults: [] },
        scripts: [
          { script: first, shard: 1, result: RESULT_WORD_PASS, seconds: 21.347, failLine: null },
          { script: second, shard: 1, result: RESULT_WORD_FAIL, seconds: 0, failLine },
          { script: first, shard: 2, result: RESULT_WORD_PASS, seconds: 3.5, failLine: null },
          { script: third, shard: 2, result: RESULT_WORD_NOTRUN, seconds: null, failLine: null },
        ],
        shards: [
          {
            ...shardCommon,
            shard: 1,
            assigned: [first, second],
            endedNormally: true,
            end: 'normal',
            seconds: 22.5,
            anonPeak: { bytes: SHARD_MEMORY_CAP_BYTES / 2, pageCacheBytes: 0, mark: null },
            peakPids: 40,
            final: { oomKilled: false, oomKillCount: 0 },
            failedReadings: 0,
            dependencyFingerprint: hexValue('fingerprint', SHA256_HEX_LENGTH),
            inspection: {
              name: `${SHARD_DIR_PREFIX}1`,
              imageId: shardCommon.imageId,
              mounts: [{ source: join(runDir, `${SHARD_DIR_PREFIX}1`), target: '/results', readOnly: false }],
              networkMode: 'none',
              pidMode: '',
              ipcMode: 'private',
              privileged: false,
              memoryBytes: SHARD_MEMORY_CAP_BYTES,
              memorySwapBytes: SHARD_MEMORY_CAP_BYTES,
              pidsLimit: SHARD_PIDS_LIMIT,
              nanoCpus: CPUS_PER_SHARD * 1e9,
              labels: { [CI_LABEL]: CI_LABEL_VALUE },
              autoRemove: false,
            },
            inspectionError: null,
          },
          {
            ...shardCommon,
            shard: 2,
            assigned: [first, third],
            endedNormally: false,
            end: 'a shard end line',
            seconds: null,
            anonPeak: { bytes: null, pageCacheBytes: null, mark: 'unknown' },
            peakPids: null,
            final: { oomKilled: UNREADABLE_READING, oomKillCount: UNREADABLE_READING },
            failedReadings: 2,
            dependencyFingerprint: null,
            inspection: null,
            inspectionError: 'container never started',
          },
        ],
        shardCount: { requested: 2, effective: 2, admitted: 2, started: 1, reasons: ['a reason'] },
        workingSet: { before: { bytes: 3, anonBytes: 2, activeFileBytes: 1 }, peak: null, after: null },
        failedReadings: 2,
        modes: { ...base.modes, tarball: '0444' },
        failures: [{ line: failLine, shard: 1 }],
        skippedChecks: ['a check'],
        cleanupFailures: ['a cleanup failure'],
        timing: { buildSeconds: 60.25, baseBuildSeconds: 0, totalSeconds: 90 },
        timingSummary: ['first summary line', 'second summary line'],
      },
      runDir,
    )
  }

  test.each([
    ['a run stopped before packing (no tarball, no shards)', (runDir: string) => makeResults({ runId: RUN_ID, pid: RUNNER_PID }, runDir)],
    ['a two-shard run', twoShardResults],
  ])('the serializer’s text parses back to the same value and serializes to the same bytes: %s', (_what, build) => {
    const runDir = newRunDir()
    const results = build(runDir)
    const path = writeResults(runDir, results)
    const text = readFileSync(path, 'utf-8')
    expect(text).toBe(serializeResults(results))
    const parsed = parseResults(text)
    expect(parsed).toEqual({ ok: true, value: results })
    if (parsed.ok) expect(serializeResults(parsed.value)).toBe(text)
  })

  test('the serializer writes exactly SR-16.1’s keys in its order, whatever the value’s own key order', () => {
    const results = twoShardResults(newRunDir())
    const reordered = Object.fromEntries(Object.entries(results).reverse()) as unknown as Results
    const text = serializeResults(results)
    expect(Object.keys(JSON.parse(text) as object)).toEqual(SR_16_1_KEYS)
    expect(serializeResults(reordered)).toBe(text)
    const shardDirs = (JSON.parse(text) as Results).modes.shardDirs
    expect(Object.keys(shardDirs)).toEqual([`${SHARD_DIR_PREFIX}1`, `${SHARD_DIR_PREFIX}2`])
  })

  /** A change to the parsed object of a valid results file, as a named JSON change. */
  function editJson(what: string, edit: (object: Record<string, Record<string, unknown>>) => void): JsonFileChange {
    return {
      kind: 'edit',
      what,
      edit: (valid) => {
        const object = JSON.parse(valid) as Record<string, Record<string, unknown>>
        edit(object)
        return `${JSON.stringify(object, null, 2)}\n`
      },
    }
  }

  test.each([
    ['unparseable content', { kind: 'unparseable' }],
    ['another version', { kind: 'version', version: RESULTS_FORMAT_VERSION + 1 }],
    ['the version as a string', { kind: 'version', version: String(RESULTS_FORMAT_VERSION) }],
    ['an extra top-level key', { kind: 'set-key', key: 'extra', value: null }],
    ['a missing top-level key (timingSummary)', { kind: 'drop-key', key: 'timingSummary' }],
    ['a missing top-level key (modes)', { kind: 'drop-key', key: 'modes' }],
    ['an extra nested key', editJson('modes.extra added', (object) => {
      ;(object.modes as Record<string, unknown>).extra = null
    })],
    ['a missing nested key', editJson('images.retagMoved removed', (object) => {
      delete (object.images as Record<string, unknown>).retagMoved
    })],
  ] as [string, JsonFileChange][])('a results file with %s parses as invalid', (_what, change) => {
    const runDir = newRunDir()
    const path = writeResults(runDir, twoShardResults(runDir), change)
    expect(parseResults(readFileSync(path, 'utf-8')).ok).toBe(false)
  })

  test.each([
    ['an extra key', (valid: Results) => ({ ...valid, extra: null })],
    ['a missing key', (valid: Results) => {
      const { timingSummary: _dropped, ...rest } = valid
      return rest
    }],
    ['another version', (valid: Results) => ({ ...valid, version: RESULTS_FORMAT_VERSION + 1 })],
    ['a PID of 0', (valid: Results) => ({ ...valid, pid: 0 })],
    ['a package hash in uppercase', (valid: Results) => ({ ...valid, packageSha256: (valid.packageSha256 as string).toUpperCase() })],
    ['a run-directory mode of three digits', (valid: Results) => ({ ...valid, modes: { ...valid.modes, runDir: valid.modes.runDir.slice(1) } })],
  ])('the serializer refuses results with %s, so it never writes a file its parser refuses', (_what, change) => {
    const bad = change(twoShardResults(newRunDir())) as unknown as Results
    expect(() => serializeResults(bad)).toThrow()
  })

})

// ---------------------------------------------------------------------------
// E9: shard containers (b.t6s E9)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// E10: outcomes, verdict and results (b.t6s E10)
// ---------------------------------------------------------------------------
//
// E10's region (b.t6s E10 T4; b.uqm SR-3.6, SR-12.1, SR-12.3, SR-12.4,
// SR-12.5, SR-16.1, SR-16.2, SR-19.6), through section 14's exports:
// - shard outcomes: the end marker decides, the causes' precedence, the two
//   end-line forms, an out-of-memory line in place of any end line, and the
//   scripts each shard records;
// - a failing prerequisite and the pass condition;
// - each script's line, the failure ranking and the chosen line;
// - the verdict's shapes, the double guard and N = 1;
// - `results.json`'s value and the one redacted writer of it and
//   `summary.txt`; the summary and the timing summary.
//
// The other Epics' lines (run-level, image build, integrity, out-of-memory,
// timing, cap and shard-count lines) are constructed, opaque inputs whose
// wording is never asserted. Each cause text and each line form is pinned
// once against the SRD's wording; every other expected line comes from
// section 14's builders. Script names come from the repository's listing.
// The region's imports are namespaces and its helpers live inside its
// describe, so no name can collide with another region's.

import * as e10 from '../scripts/ci-run.ts'
import * as e10Credentials from './test-helpers/credentials.ts'
import * as e10Helpers from './test-helpers/ci-run.ts'

describe('E10: outcomes, verdict and results (b.t6s E10 T4)', () => {
  // --- Factories and the file-name lookup (T4.S1; extended by T4.S2–T4.S6) ---

  /** The repository's real file name for script number n, looked up when a case runs. */
  const script = (n: number): string => realScriptFileName(n)
  /** Script number n's number form, `test-<n>`, through E1's builder. */
  const numberForm = (n: number): string => e10.numberFormOf(n)
  /** A fault's normalized text, through E1's builder. */
  const faultTextOf = (fault: e10.Fault): string => e10.faultText(fault)

  /** A script that ran to its end: its `start` and `end` lines. */
  const ran = (fileName: string, result: ScriptResult = RESULT_WORD_PASS, seconds = 1.5): ResultEvent[] => [startEvent(fileName), endEvent(fileName, result, seconds)]

  const pinnedId = (): string => `sha256:${hexValue('e10-pinned', SHA256_HEX_LENGTH)}`

  const startCommon = (shard: number) => ({ shard, imageId: pinnedId(), mounts: [], nameInUse: false, canary: hexValue(`e10-canary-${shard}`, CANARY_LENGTH) })
  const started = (shard: number): e10.ShardStart => ({ kind: 'started', ...startCommon(shard), startedAtMs: 0 })
  const failedStart = (shard: number, detail: string): e10.ShardStart => ({ kind: 'failed-to-start', ...startCommon(shard), detail })

  const wallTime = (minutes = 30): e10.ShardCause => ({ kind: 'wall-time-limit', minutes, fixedByRunner: true })
  const killed = (): e10.ShardCause => ({ kind: 'killed', fixedByRunner: true })
  const stoppedBy = (by: e10.StopKind): e10.ShardCause => ({ kind: 'stopped', by, fixedByRunner: true })
  const exitedWith = (code: number): e10.ShardCause => ({ kind: 'container-exited', code, fixedByRunner: false })
  const failedToStart = (detail: string): e10.ShardCause => ({ kind: 'failed-to-start', detail, fixedByRunner: false })
  const MARKER_MISSING: e10.ShardCause = { kind: 'image-marker-missing', fixedByRunner: false }
  const NO_RESULT_FILE: e10.ShardCause = { kind: 'no-result-file', fixedByRunner: false }
  const RESULT_FILE_UNREADABLE: e10.ShardCause = { kind: 'result-file-unreadable', fixedByRunner: false }

  /** Every cause the runner fixes itself before a stop it makes (b.uqm SR-12.1). */
  const RUNNER_FIXED_CAUSES: [string, e10.ShardCause][] = [
    ['its wall-time limit', wallTime()],
    ['a kill: fault', killed()],
    ['an interrupt', stoppedBy('interrupt')],
    ['the memory watchdog', stoppedBy('memory-watchdog')],
    ['the run deadline', stoppedBy('run-deadline')],
  ]

  // Constructed lines of other Epics: opaque, distinct, each beginning FAIL:.
  const RUN_LEVEL_LINE = `${FAIL_PREFIX}constructed run-level stop line`
  const IMAGE_BUILD_LINE = `${FAIL_PREFIX}constructed image build line`
  /** An integrity failure; its check name only satisfies the type, and no case relies on it. */
  const integrityFailure = (n: number, check: e10.IntegrityCheck): e10.Failure => ({ line: `${FAIL_PREFIX}constructed integrity line ${n}`, shard: null, failureClass: { kind: 'integrity', check } })
  const oomShardLine = (shard: number): string => `${FAIL_PREFIX}${SHARD_DIR_PREFIX}${shard}: constructed out-of-memory kill line`
  const oomScriptLine = (fileName: string, shard: number): string => `${FAIL_PREFIX}${fileName}: constructed out-of-memory kill line in ${SHARD_DIR_PREFIX}${shard}`
  const oomUnreadableLine = (shard: number): string => `${FAIL_PREFIX}${SHARD_DIR_PREFIX}${shard}: constructed out-of-memory status unreadable line`
  /** The FAIL line a constructed script log holds, distinct per script and shard. */
  const scriptFailLine = (fileName: string, shard: number): string => `${FAIL_PREFIX}${fileName}: constructed failure, shard ${shard}`

  /** Inspection data with recognizable values, for the summary's no-inspection case. */
  function inspectionData(shard: number): e10.InspectionData {
    return {
      name: `e10-inspection-name-${hexValue(`e10-name-${shard}`, 12)}`,
      imageId: pinnedId(),
      mounts: [{ source: join(root, `e10-mount-source-${hexValue(`e10-mount-${shard}`, 12)}`), target: '/results', readOnly: false }],
      networkMode: 'none',
      pidMode: '',
      ipcMode: 'private',
      privileged: false,
      memoryBytes: SHARD_MEMORY_CAP_BYTES,
      memorySwapBytes: SHARD_MEMORY_CAP_BYTES,
      pidsLimit: SHARD_PIDS_LIMIT,
      nanoCpus: CPUS_PER_SHARD * 1e9,
      labels: { [CI_LABEL]: CI_LABEL_VALUE, 'e10-inspection-label': hexValue(`e10-label-${shard}`, 16) },
      autoRemove: false,
    }
  }

  type EvidenceChange = Partial<Omit<e10.ShardEvidence, 'shard'>>

  /** A shard's whole evidence: by default started, assigned test-1 to test-3, with no recorded cause, exit or out-of-memory line; and a stated change. */
  function evidenceOf(shard: number, change: EvidenceChange = {}): e10.ShardEvidence {
    return {
      shard,
      assigned: [script(1), script(2), script(3)],
      expectedSeconds: 600,
      limitMinutes: 30,
      endedNormally: false,
      end: e10.NORMAL_SHARD_END,
      seconds: 61.5,
      anonPeak: { bytes: 1_073_741_824, pageCacheBytes: 268_435_456, mark: null },
      peakPids: 40,
      final: { oomKilled: false, oomKillCount: 0 },
      failedReadings: 0,
      packageSha256: hexValue('e10-package', SHA256_HEX_LENGTH),
      dependencyFingerprint: hexValue('e10-fingerprint', SHA256_HEX_LENGTH),
      imageId: pinnedId(),
      inspection: null,
      inspectionError: null,
      start: started(shard),
      canary: hexValue(`e10-canary-${shard}`, CANARY_LENGTH),
      resultFile: { kind: 'missing' },
      fixedCause: null,
      exitCode: null,
      oomLine: null,
      ...change,
    }
  }

  type ShardDirContent = Omit<e10Helpers.ShardDirSpec, 'shard'>

  /** A shard's outcome read from its subdirectory, built by E1's run-directory builder; null content: the subdirectory was never made. */
  function outcomeOnDisk(evidence: e10.ShardEvidence, content: ShardDirContent | null): e10.ShardOutcome {
    const runDir = newRunDir()
    const shardDir = content === null ? join(runDir, `${SHARD_DIR_PREFIX}${evidence.shard}`) : writeShardDir(runDir, { ...content, shard: evidence.shard })
    return e10.readShardOutcome(evidence, shardDir)
  }

  /** A shard in memory: its evidence, its result file's events (none: no result file) and its script logs by file name. */
  interface ShardSpec {
    readonly evidence: e10.ShardEvidence
    readonly events?: readonly ResultEvent[]
    readonly logs?: Readonly<Record<string, string>>
  }

  /** Every assigned script passed and the end marker was written. */
  const passingShard = (shard: number, assigned: readonly string[], change: EvidenceChange = {}): ShardSpec => ({
    evidence: evidenceOf(shard, { ...change, assigned }),
    events: [...assigned.flatMap((fileName) => ran(fileName)), DONE_EVENT],
  })

  /** The shard stopped at `failing`'s failure (its log holds `scriptFailLine`), recorded the rest `notrun` and wrote the end marker. */
  function failingShard(shard: number, assigned: readonly string[], failing: string, change: EvidenceChange = {}): ShardSpec {
    const at = assigned.indexOf(failing)
    if (at < 0) throw new Error(`failingShard: ${failing} is not assigned`)
    return {
      evidence: evidenceOf(shard, { ...change, assigned }),
      events: [...assigned.slice(0, at).flatMap((fileName) => ran(fileName)), ...ran(failing, RESULT_WORD_FAIL), ...assigned.slice(at + 1).map((fileName) => notRunEvent(fileName)), DONE_EVENT],
      logs: { [failing]: `constructed output\n${scriptFailLine(failing, shard)}\n` },
    }
  }

  /** The runner stopped the shard with `inProgress` running, its cause recorded first. */
  function stoppedShard(shard: number, assigned: readonly string[], inProgress: string, cause: e10.ShardCause, change: EvidenceChange = {}): ShardSpec {
    const at = assigned.indexOf(inProgress)
    if (at < 0) throw new Error(`stoppedShard: ${inProgress} is not assigned`)
    return { evidence: evidenceOf(shard, { ...change, assigned, fixedCause: cause }), events: [...assigned.slice(0, at).flatMap((fileName) => ran(fileName)), startEvent(inProgress)] }
  }

  /** No result file, and the container exited on its own: a shard line. */
  const exitedShard = (shard: number, assigned: readonly string[], code = 1): ShardSpec => ({ evidence: evidenceOf(shard, { assigned, exitCode: code }) })

  function outcomeOf(spec: ShardSpec): e10.ShardOutcome {
    const read: e10.ResultFileRead = spec.events === undefined ? { kind: 'missing' } : { kind: 'events', events: spec.events }
    const scripts = e10.shardScriptsOf(read, spec.evidence.assigned, (fileName): e10.FileTextRead => {
      const text = spec.logs?.[fileName]
      return text === undefined ? { kind: 'missing' } : { kind: 'text', text }
    })
    return e10.decideShardOutcome(spec.evidence, scripts, false)
  }

  /** The invocation of `/ci <args>`, through E1's parser. */
  function invocationOf(args: readonly string[]): e10.Invocation {
    const parsed = e10.parseCiArguments(args)
    if (!parsed.ok) throw new Error(`invocationOf: ${parsed.failures.map((failure) => failure.reason).join('; ')}`)
    return parsed.invocation
  }

  /** A run's context: its `/ci` arguments, its shards, its expected scripts (default: every assigned one) and the other Epics' lines. */
  interface RunSpec {
    readonly args?: readonly string[]
    readonly shards: readonly ShardSpec[]
    readonly expected?: readonly string[]
    readonly runLevelLine?: string
    readonly imageBuildLine?: string
    readonly integrity?: readonly e10.Failure[]
  }

  interface DecidedRun {
    readonly invocation: e10.Invocation
    readonly outcomes: readonly e10.ShardOutcome[]
    readonly shardInputs: readonly e10.ResultsShardInput[]
    readonly ranked: readonly e10.Failure[]
    readonly passed: boolean
    readonly expected: readonly string[]
  }

  /** Decides every shard's outcome, ranks every failure and decides the pass condition, through section 14. */
  function decideRun(spec: RunSpec): DecidedRun {
    const invocation = invocationOf(spec.args ?? [])
    const outcomes = spec.shards.map(outcomeOf)
    const expected = spec.expected ?? [...new Set(spec.shards.flatMap((shard) => shard.evidence.assigned))]
    const sources: e10.FailureSources = { runLevelLine: spec.runLevelLine ?? null, imageBuildLine: spec.imageBuildLine ?? null, integrityFailures: spec.integrity ?? [], outcomes }
    return {
      invocation,
      outcomes,
      shardInputs: spec.shards.map((shard, index) => ({ evidence: shard.evidence, outcome: outcomes[index] as e10.ShardOutcome })),
      ranked: e10.rankFailures(sources),
      passed: e10.runPasses({ expectedScripts: expected, shardsUsed: outcomes.map((outcome) => outcome.shard), outcomes, otherFailures: e10.otherFailuresOf(sources) }),
      expected,
    }
  }

  const verdictOf = (run: DecidedRun): string => e10.buildVerdictLine({ invocation: run.invocation, scripts: run.expected, passed: run.passed, ranked: run.ranked })
  const linesOf = (failures: readonly e10.Failure[]): string[] => failures.map((failure) => failure.line)

  /** The timing summary's groups, recognizable lines whose wording is never asserted; the duration-table block holds real tabs. */
  function timingGroups(change: Partial<e10.TimingSummaryGroups> = {}): e10.TimingSummaryGroups {
    return {
      shardCountLine: 'constructed shard-count line',
      runTimes: ['constructed build time line', 'constructed shard time line', 'constructed total time line'],
      scriptTimes: ['constructed script time line 1', 'constructed script time line 2'],
      durationTableBlock: ['constructed block intro line', 'constructed\tblock\trow'],
      slowLines: ['constructed slow line'],
      tableNotes: ['constructed table note'],
      capLine: 'constructed cap line',
      ...change,
    }
  }

  /** Everything `results.json` is assembled from, for a decided run, with recognizable figures; and a stated change. */
  function resultsInputsOf(run: DecidedRun, change: Partial<e10.ResultsInputs> = {}): e10.ResultsInputs {
    return {
      runId: RUN_ID,
      pid: RUNNER_PID,
      invocation: run.invocation,
      packageSha256: hexValue('e10-package', SHA256_HEX_LENGTH),
      images: { pinnedId: pinnedId(), driftId: null, retagId: null, retagMoved: false },
      verdict: verdictOf(run),
      shards: run.shardInputs,
      shardCount: { requested: 5, effective: 4, admitted: 3, started: 3, reasons: ['constructed shard-count reason'] },
      cap: { usedBytes: 12_884_901_888, peakBytes: 9_663_676_416, peakShard: 2, peakPageCacheBytes: 1_288_490_188, peakFromKill: false, derivedBytes: 11_811_160_064, suffix: 'constructed cap suffix' },
      workingSet: { before: { bytes: 31_000_000_001, anonBytes: 21_000_000_001, activeFileBytes: 10_000_000_001 }, peak: { bytes: 41_000_000_002, anonBytes: 30_000_000_002, activeFileBytes: 11_000_000_002 }, after: null },
      failedReadings: 7,
      modes: { runDir: e10.RUN_DIR_MODE, tarball: 0o444, shardDirs: Object.fromEntries(run.outcomes.map((outcome) => [`${SHARD_DIR_PREFIX}${outcome.shard}`, e10.RUN_DIR_MODE])) },
      failures: run.ranked,
      skippedChecks: ['schedule-coverage'],
      cleanupFailures: ['constructed cleanup failure line'],
      timing: { buildSeconds: 61.25, baseBuildSeconds: 12.5, totalSeconds: 905.75 },
      timingGroups: timingGroups(),
      ...change,
    }
  }

  /**
   * A three-shard full run, given out of shard order: shard 3 stopped at its
   * limit with test-5 in progress; shard 1 stopped at test-2's failure (with
   * inspection data); shard 2 passed but has an out-of-memory line; and one
   * integrity failure.
   */
  function standardRunSpec(): RunSpec {
    const [t1, t2, t3, t4, t5] = [1, 2, 3, 4, 5].map(script) as [string, string, string, string, string]
    return {
      args: ['--shards', '3'],
      integrity: [integrityFailure(1, 'results-canary')],
      shards: [
        stoppedShard(3, [t1, t5], t5, wallTime(), { final: { oomKilled: UNREADABLE_READING, oomKillCount: UNREADABLE_READING }, failedReadings: 5, anonPeak: { bytes: null, pageCacheBytes: null, mark: 'unknown' } }),
        failingShard(1, [t1, t2, t3], t2, { inspection: inspectionData(1), seconds: 333.25 }),
        passingShard(2, [t1, t4], { oomLine: oomShardLine(2), failedReadings: 3, inspectionError: 'constructed inspect error\nits second line', anonPeak: { bytes: 2_147_483_648, pageCacheBytes: 536_870_912, mark: 'partial' }, peakPids: 77 }),
      ],
    }
  }

  const identityRedactor: e10.ResultsRedactor = { results: (results) => results, text: (text) => text }

  /** Writes the run's files through the one writer, asserting both writes succeed, and answers their paths. */
  function writeBoth(runDir: string, results: Results, redactor: e10.ResultsRedactor = identityRedactor): { results: string; summary: string } {
    expect(e10.writeResultsFiles(runDir, results, redactor)).toEqual({ results: { ok: true }, summary: { ok: true } })
    return { results: join(runDir, e10.RESULTS_FILE_NAME), summary: join(runDir, e10.SUMMARY_FILE_NAME) }
  }

  /** `results.json` read back through E1's strict parser. */
  function parsedResults(path: string): Results {
    const parsed = parseResults(readFileSync(path, 'utf-8'))
    if (!parsed.ok) throw new Error(`parsedResults: ${path} does not parse`)
    return parsed.value
  }

  /** The standard run's `results.json` value, with a stated change to its inputs. */
  const assembled = (change: Partial<e10.ResultsInputs> = {}): Results => e10.assembleResults(resultsInputsOf(decideRun(standardRunSpec()), change))

  /** A redactor, built here (E11 owns the real one), masking `values` in the results and `values` plus `textOnly` in the summary text. */
  function maskingRedactor(values: readonly string[], textOnly: readonly string[] = []): e10.ResultsRedactor {
    const masked = (text: string, all: readonly string[]): string => all.reduce((out, value) => out.replaceAll(value, e10.REDACTION_PLACEHOLDER), text)
    const deep = (value: unknown): unknown => {
      if (typeof value === 'string') return masked(value, values)
      if (Array.isArray(value)) return value.map(deep)
      if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, deep(inner)]))
      return value
    }
    return { results: (results) => deep(results) as Results, text: (text) => masked(text, [...values, ...textOnly]) }
  }

  /** Every string and number of a results value, `inspection` data left out: what the summary must show. */
  function shownValuesOf(results: Results): string[] {
    const values: string[] = []
    const walk = (value: unknown, key: string): void => {
      if (key === 'inspection') return
      if (typeof value === 'string' || typeof value === 'number') values.push(String(value))
      else if (Array.isArray(value)) for (const inner of value) walk(inner, key)
      else if (value !== null && typeof value === 'object') for (const [innerKey, inner] of Object.entries(value)) walk(inner, innerKey)
    }
    walk(results, '')
    return values
  }

  // --- T4.S1: shard outcomes and the precedence of their causes (b.uqm SR-12.1) ---

  describe('E10: shard outcomes and their causes (b.uqm SR-12.1)', () => {
    test.each([
      ['a wall-time limit', wallTime(93), 'wall-time limit of 93 min exceeded'],
      ['an exit', exitedWith(137), 'container exited 137'],
      ['a kill: fault', killed(), 'killed'],
      ['an interrupt', stoppedBy('interrupt'), 'stopped by interrupt'],
      ['the memory watchdog', stoppedBy('memory-watchdog'), 'stopped by memory watchdog'],
      ['the run deadline', stoppedBy('run-deadline'), 'stopped by run deadline'],
      ['a failed start', failedToStart('constructed start error'), 'container failed to start: constructed start error'],
      ['a missing image marker', MARKER_MISSING, 'image marker missing'],
      ['a missing result file', NO_RESULT_FILE, 'no result file'],
      ['an unreadable result file', RESULT_FILE_UNREADABLE, 'result file unreadable'],
    ] as [string, e10.ShardCause, string][])('pin: the cause text of %s is SR-12.1’s wording', (_what, cause, text) => {
      expect(e10.shardCauseText(cause)).toBe(text)
    })

    test('pin: the end-line forms are SR-12.1’s, and a normal end is "normal" (SR-16.1)', () => {
      const fileName = script(23)
      expect(e10.scriptEndLine(fileName, 2, killed())).toBe(`FAIL: ${fileName}: killed in shard-2`)
      expect(e10.shardEndLine(2, killed())).toBe('FAIL: shard-2: killed')
      expect(e10.NORMAL_SHARD_END).toBe('normal')
    })

    test.each([
      ['an exit 0', { exitCode: 0 }],
      ['an exit 1', { exitCode: 1 }],
      ['an exit 137', { exitCode: 137 }],
      ['a recorded interrupt stop and exit 137', { exitCode: 137, fixedCause: stoppedBy('interrupt') }],
      ['a recorded wall-time limit with the container still running', { fixedCause: wallTime() }],
    ] as [string, EvidenceChange][])('a readable result file holding the end marker ended normally, with no cause and no failure, after %s', (_what, change) => {
      const evidence = evidenceOf(1, change)
      const outcome = outcomeOnDisk(evidence, { resultFile: [...evidence.assigned.flatMap((fileName) => ran(fileName)), DONE_EVENT] })
      expect(outcome).toMatchObject({ endedNormally: true, cause: null, end: e10.NORMAL_SHARD_END, endFailure: null, failures: [] })
      expect(outcome.scripts.map((entry) => entry.result)).toEqual(evidence.assigned.map(() => RESULT_WORD_PASS))
    })

    test.each([
      ['its wall-time limit', { fixedCause: wallTime() }, wallTime()],
      ['an exit on its own', { exitCode: 1 }, exitedWith(1)],
      ['a kill: fault', { fixedCause: killed() }, killed()],
      ['an interrupt', { fixedCause: stoppedBy('interrupt') }, stoppedBy('interrupt')],
      ['the memory watchdog', { fixedCause: stoppedBy('memory-watchdog') }, stoppedBy('memory-watchdog')],
      ['the run deadline', { fixedCause: stoppedBy('run-deadline') }, stoppedBy('run-deadline')],
    ] as [string, EvidenceChange, e10.ShardCause][])('an end by %s with a script in progress takes the script form, ranked as that script’s failure', (_what, change, cause) => {
      const evidence = evidenceOf(2, change)
      const [first, second] = evidence.assigned
      const outcome = outcomeOnDisk(evidence, { resultFile: [...ran(first), startEvent(second)] })
      const line = e10.scriptEndLine(second, 2, cause)
      expect(e10.causeTakesScriptEndLine(cause)).toBe(true)
      expect(outcome.cause).toEqual(cause)
      expect(outcome.end).toBe(line)
      expect(outcome.endFailure).toEqual({ line, shard: 2, failureClass: { kind: 'script', fileName: second } })
    })

    test.each([
      ['its wall-time limit, no script in progress', { fixedCause: wallTime() }, (assigned: readonly string[]) => ({ resultFile: ran(assigned[0] as string) }), wallTime()],
      ['an exit on its own, no result file', { exitCode: 1 }, () => ({}), exitedWith(1)],
      ['a kill: fault, an empty result file', { fixedCause: killed() }, () => ({ resultFile: [] }), killed()],
      ['an interrupt, no result file', { fixedCause: stoppedBy('interrupt') }, () => ({}), stoppedBy('interrupt')],
      ['the memory watchdog, no result file', { fixedCause: stoppedBy('memory-watchdog') }, () => ({}), stoppedBy('memory-watchdog')],
      ['the run deadline, no result file', { fixedCause: stoppedBy('run-deadline') }, () => ({}), stoppedBy('run-deadline')],
      ['a failed start whose detail spans lines', { start: failedStart(3, 'constructed start error\n  its second line\r\n') }, null, failedToStart('constructed start error\n  its second line\r\n')],
      ['no result file and no other cause', {}, () => ({}), NO_RESULT_FILE],
      ['an unreadable result file', {}, (assigned: readonly string[]) => ({ resultFile: { events: ran(assigned[0] as string), malformed: { at: 1, change: 'carriage-return' as const } } }), RESULT_FILE_UNREADABLE],
    ] as [string, EvidenceChange, ((assigned: readonly string[]) => ShardDirContent) | null, e10.ShardCause][])(
      'an end by %s takes the shard form, FAIL: shard-<k>: <cause>, on one line',
      (_what, change, content, cause) => {
        const evidence = evidenceOf(3, change)
        const outcome = outcomeOnDisk(evidence, content === null ? null : content(evidence.assigned))
        const line = e10.shardEndLine(3, cause)
        expect(outcome.cause).toEqual(cause)
        expect(outcome.end).toBe(line)
        expect(line).not.toMatch(/[\r\n]/)
        expect(outcome.endFailure).toEqual({ line, shard: 3, failureClass: { kind: 'shard' } })
      },
    )

    test('a failed start’s multi-line detail is written on one line', () => {
      expect(e10.shardEndLine(3, failedToStart('constructed start error\n  its second line\r\n'))).toBe(e10.shardEndLine(3, failedToStart('constructed start error its second line')))
    })

    test('a cause that never takes the script form gives the shard form even with a script in progress, and that script is fail with the shard line', () => {
      const evidence = evidenceOf(4, { exitCode: e10.MARKER_REFUSAL_EXIT_STATUS })
      const [first, second, third] = evidence.assigned
      const outcome = outcomeOnDisk(evidence, { resultFile: [startEvent(first)], dockerLog: `${e10.MARKER_REFUSAL_LINE}\n` })
      const line = e10.shardEndLine(4, MARKER_MISSING)
      expect(e10.causeTakesScriptEndLine(MARKER_MISSING)).toBe(false)
      expect(outcome.end).toBe(line)
      expect(outcome.scripts).toEqual([
        { script: first, shard: 4, result: RESULT_WORD_FAIL, seconds: null, failLine: line },
        { script: second, shard: 4, result: RESULT_WORD_NOTRUN, seconds: null, failLine: null },
        { script: third, shard: 4, result: RESULT_WORD_NOTRUN, seconds: null, failLine: null },
      ])
      expect(outcome.failures).toEqual([{ line, shard: 4, failureClass: { kind: 'shard' } }])
    })

    // SR-12.1's precedence, one case per adjacent pair with both causes
    // present, each end in the shard form. (5) and (6) cannot both hold, a
    // result file being either unreadable or missing.
    test.each([
      ['(1) a cause the runner fixed over (2) a failed start', { fixedCause: stoppedBy('interrupt'), start: failedStart(1, 'constructed start error') }, null, stoppedBy('interrupt')],
      ['(2) a failed start over (3) a missing image marker', { start: failedStart(1, 'constructed start error'), exitCode: e10.MARKER_REFUSAL_EXIT_STATUS }, () => ({ dockerLog: `${e10.MARKER_REFUSAL_LINE}\n` }), failedToStart('constructed start error')],
      ['(3) a missing image marker over (4) its exit 2', { exitCode: e10.MARKER_REFUSAL_EXIT_STATUS }, () => ({ dockerLog: `${e10.MARKER_REFUSAL_LINE}\n` }), MARKER_MISSING],
      ['(4) an exit over (5) an unreadable result file', { exitCode: 1 }, () => ({ resultFile: { events: [DONE_EVENT], malformed: { at: 0, change: 'uppercase-word' as const } } }), exitedWith(1)],
    ] as [string, EvidenceChange, (() => ShardDirContent) | null, e10.ShardCause][])('precedence: %s', (_what, change, content, cause) => {
      const outcome = outcomeOnDisk(evidenceOf(1, change), content === null ? null : content())
      expect(outcome.cause).toEqual(cause)
      expect(outcome.end).toBe(e10.shardEndLine(1, cause))
    })

    test.each(RUNNER_FIXED_CAUSES)('a stop by %s followed by exit 137 keeps its recorded cause: no line says container exited 137 (AC 37)', (_what, cause) => {
      const evidence = evidenceOf(2, { fixedCause: cause, exitCode: 137 })
      const [first, second] = evidence.assigned
      const outcome = outcomeOnDisk(evidence, { resultFile: [...ran(first), startEvent(second)] })
      expect(outcome.cause).toEqual(cause)
      expect(outcome.end).toBe(e10.scriptEndLine(second, 2, cause))
      const lines = [outcome.end, ...outcome.scripts.map((entry) => entry.failLine ?? ''), ...linesOf(outcome.failures)]
      expect(lines.filter((line) => line.includes(e10.containerExitedCauseText(137)))).toEqual([])
    })

    test.each([
      ['exit 2 with Docker logs that lack the line', e10.MARKER_REFUSAL_EXIT_STATUS, () => 'constructed docker output\n', exitedWith(e10.MARKER_REFUSAL_EXIT_STATUS)],
      ['exit 2 with the line only inside another line', e10.MARKER_REFUSAL_EXIT_STATUS, () => `prefix ${e10.MARKER_REFUSAL_LINE}\n`, exitedWith(e10.MARKER_REFUSAL_EXIT_STATUS)],
      ['exit 2 with no saved Docker logs', e10.MARKER_REFUSAL_EXIT_STATUS, () => undefined, exitedWith(e10.MARKER_REFUSAL_EXIT_STATUS)],
      ['exit 1 with the line in its Docker logs', 1, () => `${e10.MARKER_REFUSAL_LINE}\n`, exitedWith(1)],
    ] as [string, number, () => string | undefined, e10.ShardCause][])('image marker missing needs exit 2 and the marker refusal line: %s gives container exited', (_what, exitCode, dockerLog, cause) => {
      const log = dockerLog()
      const outcome = outcomeOnDisk(evidenceOf(1, { exitCode }), log === undefined ? {} : { dockerLog: log })
      expect(outcome.cause).toEqual(cause)
      expect(outcome.end).toBe(e10.shardEndLine(1, cause))
    })

    test('a shard never created after a run-level stop takes that stop’s cause, recorded for it, and every assigned script is notrun', () => {
      const cause = stoppedBy('run-deadline')
      const evidence = evidenceOf(5, { start: null, fixedCause: cause })
      const outcome = outcomeOnDisk(evidence, null)
      expect(outcome).toMatchObject({ endedNormally: false, cause, end: e10.shardEndLine(5, cause) })
      expect(outcome.scripts.map((entry) => [entry.script, entry.result])).toEqual(evidence.assigned.map((fileName) => [fileName, RESULT_WORD_NOTRUN]))
      expect(outcome.failures).toEqual([{ line: e10.shardEndLine(5, cause), shard: 5, failureClass: { kind: 'shard' } }])
    })

    test.each([
      ['a shard that ended normally with every script passed', {}, (assigned: readonly string[]) => ({ resultFile: [...assigned.flatMap((fileName) => ran(fileName)), DONE_EVENT] }), true],
      ['a shard stopped with a script in progress', { fixedCause: stoppedBy('interrupt') }, (assigned: readonly string[]) => ({ resultFile: [...ran(assigned[0] as string), startEvent(assigned[1] as string)] }), false],
      ['a shard with no result file that exited', { exitCode: 137 }, () => ({}), false],
    ] as [string, EvidenceChange, (assigned: readonly string[]) => ShardDirContent, boolean][])('an out-of-memory line takes the place of any end line: %s', (_what, change, content, endedNormally) => {
      const oomLine = oomShardLine(6)
      const evidence = evidenceOf(6, { ...change, oomLine })
      const outcome = outcomeOnDisk(evidence, content(evidence.assigned))
      expect(outcome.endedNormally).toBe(endedNormally)
      expect(outcome.end).toBe(oomLine)
      expect(outcome.failures).toEqual([{ line: oomLine, shard: 6, failureClass: { kind: 'out-of-memory' } }])
      expect(outcome.endFailure).toEqual(outcome.failures[0] as e10.Failure)
    })

    test('an assigned script without a result is notrun; the script in progress is fail with no seconds and the end line, its only failure', () => {
      const evidence = evidenceOf(2, { fixedCause: killed() })
      const [first, second, third] = evidence.assigned
      const outcome = outcomeOnDisk(evidence, { resultFile: [...ran(first, RESULT_WORD_PASS, 21.347), startEvent(second)] })
      const line = e10.scriptEndLine(second, 2, killed())
      expect(outcome.scripts).toEqual([
        { script: first, shard: 2, result: RESULT_WORD_PASS, seconds: 21.347, failLine: null },
        { script: second, shard: 2, result: RESULT_WORD_FAIL, seconds: null, failLine: line },
        { script: third, shard: 2, result: RESULT_WORD_NOTRUN, seconds: null, failLine: null },
      ])
      expect(linesOf(outcome.failures)).toEqual([line])
    })
  })

  // --- T4.S2: a failing prerequisite and the pass condition (b.uqm SR-3.6, SR-12.3) ---

  describe('E10: a failing prerequisite and the pass condition (b.uqm SR-3.6, SR-12.3)', () => {
    test('a failing prerequisite: test-3 is notrun after test-2 fails, the only failure is test-2’s line, and the run fails', () => {
      const [t1, t2, t3] = [script(1), script(2), script(3)]
      const evidence = evidenceOf(1, { assigned: [t1, t2, t3] })
      const line = scriptFailLine(t2, 1)
      const outcome = outcomeOnDisk(evidence, { resultFile: [...ran(t1), ...ran(t2, RESULT_WORD_FAIL), notRunEvent(t3), DONE_EVENT], scriptLogs: { [t2]: `${line}\n` } })
      expect(outcome).toMatchObject({ endedNormally: true, end: e10.NORMAL_SHARD_END })
      expect(outcome.scripts.map((entry) => [entry.script, entry.result, entry.failLine])).toEqual([
        [t1, RESULT_WORD_PASS, null],
        [t2, RESULT_WORD_FAIL, line],
        [t3, RESULT_WORD_NOTRUN, null],
      ])
      const sources: e10.FailureSources = { runLevelLine: null, imageBuildLine: null, integrityFailures: [], outcomes: [outcome] }
      expect(e10.rankFailures(sources)).toEqual([{ line, shard: 1, failureClass: { kind: 'script', fileName: t2 } }])
      expect(e10.runPasses({ expectedScripts: [t1, t2, t3], shardsUsed: [1], outcomes: [outcome], otherFailures: [] })).toBe(false)
    })

    test.each([
      ['every expected script passed, test-1 in every shard used', (): RunSpec => ({ shards: [passingShard(1, [script(1), script(2)]), passingShard(2, [script(1), script(3)])] })],
      ['a selective run, with no result for any script outside its expected list', (): RunSpec => ({ args: [numberForm(23)], shards: [passingShard(1, [script(1), script(23)])] })],
    ])('the run passes: %s', (_what, spec) => {
      expect(decideRun(spec()).passed).toBe(true)
    })

    test.each([
      ['test-1 has no pass in one shard used', (): RunSpec => ({ shards: [passingShard(1, [script(1), script(2)]), passingShard(2, [script(3)])] })],
      ['an expected script is notrun', (): RunSpec => ({ shards: [{ evidence: evidenceOf(1), events: [...ran(script(1)), ...ran(script(2)), notRunEvent(script(3)), DONE_EVENT] }] })],
      ['an expected script has no result anywhere', (): RunSpec => ({ shards: [passingShard(1, [script(1), script(2)])], expected: [script(1), script(2), script(3)] })],
      ['an all-pass shard has an out-of-memory line', (): RunSpec => ({ shards: [passingShard(1, [script(1), script(2)], { oomLine: oomShardLine(1) })] })],
      ['an all-pass shard has a shard line', (): RunSpec => ({ shards: [{ evidence: evidenceOf(1, { fixedCause: stoppedBy('run-deadline') }), events: [...ran(script(1)), ...ran(script(2)), ...ran(script(3))] }] })],
      ['an integrity line is given while every script passed', (): RunSpec => ({ shards: [passingShard(1, [script(1), script(2)])], integrity: [integrityFailure(1, 'package-hash')] })],
      ['an image build line is given while every script passed', (): RunSpec => ({ shards: [passingShard(1, [script(1), script(2)])], imageBuildLine: IMAGE_BUILD_LINE })],
      ['a run-level line is given while every script passed', (): RunSpec => ({ shards: [passingShard(1, [script(1), script(2)])], runLevelLine: RUN_LEVEL_LINE })],
      ['the expected scripts lack test-1', (): RunSpec => ({ shards: [passingShard(1, [script(1), script(2)])], expected: [script(2)] })],
    ])('the run fails: %s', (_what, spec) => {
      expect(decideRun(spec()).passed).toBe(false)
    })
  })

  // --- T4.S3: each script's line, the ranking and the chosen line (b.uqm SR-12.4) ---

  describe('E10: the failure ranking and the chosen line (b.uqm SR-12.4)', () => {
    test('pin: the fallback line is SR-12.4’s wording', () => {
      const fileName = script(2)
      expect(e10.noFailLineFallback(fileName)).toBe(`FAIL: ${fileName}: exited non-zero without explicit FAIL line`)
    })

    test.each([
      ['the first FAIL: line wins over later ones', (f: string) => `setup\n${FAIL_PREFIX}${f}: the first\n${FAIL_PREFIX}${f}: the second\n`, (f: string) => `${FAIL_PREFIX}${f}: the first`],
      ['a line with text before FAIL: is not taken', (f: string) => `note ${FAIL_PREFIX}${f}: quoted\n  ${FAIL_PREFIX}${f}: indented\n${FAIL_PREFIX}${f}: the real one\n`, (f: string) => `${FAIL_PREFIX}${f}: the real one`],
      ['the line is kept unchanged, spaces and tabs included', (f: string) => `${FAIL_PREFIX}${f}:  two  spaces\tand a tab \n`, (f: string) => `${FAIL_PREFIX}${f}:  two  spaces\tand a tab `],
      ['a last line without its line feed counts', (f: string) => `output\n${FAIL_PREFIX}${f}: no line feed`, (f: string) => `${FAIL_PREFIX}${f}: no line feed`],
      ['FAIL: with no space after it is still a FAIL line, kept verbatim', (f: string) => `${FAIL_PREFIX.trimEnd()}${f}\n`, (f: string) => `${FAIL_PREFIX.trimEnd()}${f}`],
      ['a log with no FAIL: line gives the fallback', (_f: string) => 'only output\nfail: in lower case\n', (f: string) => e10.noFailLineFallback(f)],
      ['an empty log gives the fallback', (_f: string) => '', (f: string) => e10.noFailLineFallback(f)],
      ['a missing log gives the fallback', (_f: string) => undefined, (f: string) => e10.noFailLineFallback(f)],
    ] as [string, (fileName: string) => string | undefined, (fileName: string) => string][])('a failing script’s line: %s', (_what, log, expected) => {
      const [t1, t2, t3] = [script(1), script(2), script(3)]
      const text = log(t2)
      const outcome = outcomeOnDisk(evidenceOf(1), { resultFile: [...ran(t1), ...ran(t2, RESULT_WORD_FAIL), notRunEvent(t3), DONE_EVENT], ...(text === undefined ? {} : { scriptLogs: { [t2]: text } }) })
      expect(outcome.scripts[1]?.failLine).toBe(expected(t2))
      expect(linesOf(outcome.failures)).toEqual([expected(t2)])
    })

    test.each([
      ['the run-level line over the image build line', (): RunSpec => ({ shards: [passingShard(1, [script(1)])], runLevelLine: RUN_LEVEL_LINE, imageBuildLine: IMAGE_BUILD_LINE }), () => [RUN_LEVEL_LINE, IMAGE_BUILD_LINE]],
      ['the image build line over an integrity line', (): RunSpec => ({ shards: [passingShard(1, [script(1)])], imageBuildLine: IMAGE_BUILD_LINE, integrity: [integrityFailure(1, 'secret-scan')] }), () => [IMAGE_BUILD_LINE, integrityFailure(1, 'secret-scan').line]],
      ['an integrity line over an out-of-memory line', (): RunSpec => ({ shards: [passingShard(1, [script(1)], { oomLine: oomShardLine(1) })], integrity: [integrityFailure(1, 'secret-scan')] }), () => [integrityFailure(1, 'secret-scan').line, oomShardLine(1)]],
      ['an out-of-memory line over a lower shard’s shard line', (): RunSpec => ({ shards: [exitedShard(1, [script(1)]), passingShard(2, [script(1)], { oomLine: oomShardLine(2) })] }), () => [oomShardLine(2), e10.shardEndLine(1, exitedWith(1))]],
      ['a shard line over a lower shard’s script failure', (): RunSpec => ({ shards: [failingShard(1, [script(1), script(2)], script(2)), exitedShard(2, [script(1)])] }), () => [e10.shardEndLine(2, exitedWith(1)), scriptFailLine(script(2), 1)]],
    ])('the ladder: %s, and the chosen line is the higher', (_what, spec, expected) => {
      const run = decideRun(spec())
      expect(linesOf(run.ranked)).toEqual(expected())
      expect(verdictOf(run)).toBe(expected()[0] as string)
    })

    test.each([
      [
        'integrity lines keep their given order',
        (): RunSpec => ({ shards: [passingShard(1, [script(1)])], integrity: [integrityFailure(3, 'secret-scan'), integrityFailure(1, 'fault-fired'), integrityFailure(2, 'package-hash')] }),
        () => [3, 1, 2].map((n) => `${FAIL_PREFIX}constructed integrity line ${n}`),
      ],
      ['out-of-memory lines go by shard number', (): RunSpec => ({ shards: [passingShard(3, [script(1)], { oomLine: oomShardLine(3) }), passingShard(1, [script(1)], { oomLine: oomShardLine(1) })] }), () => [oomShardLine(1), oomShardLine(3)]],
      ['shard lines go by shard number', (): RunSpec => ({ shards: [exitedShard(3, [script(1)]), exitedShard(2, [script(1)])] }), () => [e10.shardEndLine(2, exitedWith(1)), e10.shardEndLine(3, exitedWith(1))]],
      ['script failures go in canonical order, so test-0’s ranks after test-4’s', (): RunSpec => ({ shards: [failingShard(1, [script(1), script(0)], script(0)), failingShard(2, [script(1), script(4)], script(4))] }), () => [scriptFailLine(script(4), 2), scriptFailLine(script(0), 1)]],
      ['a test-1 failure in two shards gives the lower shard’s line first', (): RunSpec => ({ shards: [failingShard(3, [script(1), script(2)], script(1)), failingShard(2, [script(1), script(3)], script(1))] }), () => [scriptFailLine(script(1), 2), scriptFailLine(script(1), 3)]],
      [
        'a script end line ranks among script failures by its script',
        (): RunSpec => ({ shards: [stoppedShard(1, [script(1), script(5)], script(5), stoppedBy('interrupt')), failingShard(2, [script(1), script(3)], script(3))] }),
        () => [scriptFailLine(script(3), 2), e10.scriptEndLine(script(5), 1, stoppedBy('interrupt'))],
      ],
    ])('within a tier: %s', (_what, spec, expected) => {
      expect(linesOf(decideRun(spec()).ranked)).toEqual(expected())
    })

    test.each([
      ['the shard form', (): ShardSpec => passingShard(3, [script(1), script(5)], { oomLine: oomShardLine(3) }), () => oomShardLine(3)],
      ['the script form', (): ShardSpec => ({ evidence: evidenceOf(3, { assigned: [script(1), script(5)], exitCode: 137, oomLine: oomScriptLine(script(5), 3) }), events: [...ran(script(1)), startEvent(script(5))] }), () => oomScriptLine(script(5), 3)],
    ])('AC 52: an out-of-memory kill line in %s outranks another shard’s shard line and another shard’s test-1 failure', (_what, killedShard, killLine) => {
      const run = decideRun({ shards: [failingShard(1, [script(1), script(2)], script(1)), exitedShard(2, [script(1)]), killedShard()] })
      expect(linesOf(run.ranked)).toEqual([killLine(), e10.shardEndLine(2, exitedWith(1)), scriptFailLine(script(1), 1)])
      expect(verdictOf(run)).toBe(killLine())
    })

    test('AC 53: out-of-memory status unreadable ranks with the kill lines by shard number, over shard lines and script failures', () => {
      const run = decideRun({
        shards: [
          failingShard(4, [script(1), script(2)], script(2)),
          passingShard(3, [script(1)], { oomLine: oomShardLine(3) }),
          exitedShard(5, [script(1)]),
          passingShard(2, [script(1)], { oomLine: oomUnreadableLine(2) }),
          passingShard(1, [script(1)], { oomLine: oomShardLine(1) }),
        ],
      })
      expect(linesOf(run.ranked)).toEqual([oomShardLine(1), oomUnreadableLine(2), oomShardLine(3), e10.shardEndLine(5, exitedWith(1)), scriptFailLine(script(2), 4)])
    })

    test('AC 67, verdict half: a test-1 whose log’s first FAIL: line reports an install failure, with no fingerprint recorded, gives that line', () => {
      const [t1, t2] = [script(1), script(2)]
      const installLine = `${FAIL_PREFIX}${t1}: constructed package install failure`
      const evidence = evidenceOf(1, { assigned: [t1, t2], dependencyFingerprint: null })
      const outcome = outcomeOnDisk(evidence, {
        resultFile: [...ran(t1, RESULT_WORD_FAIL), notRunEvent(t2), DONE_EVENT],
        scriptLogs: { [t1]: `constructed install output\n${installLine}\n${FAIL_PREFIX}${t1}: a later line\n` },
      })
      const ranked = e10.rankFailures({ runLevelLine: null, imageBuildLine: null, integrityFailures: [], outcomes: [outcome] })
      const passed = e10.runPasses({ expectedScripts: [t1, t2], shardsUsed: [1], outcomes: [outcome], otherFailures: [] })
      expect(e10.buildVerdictLine({ invocation: invocationOf([]), scripts: [], passed, ranked })).toBe(installLine)
    })

    test('AC 37, ranking: the run-level interrupt line outranks every … stopped by interrupt in shard-<k> line', () => {
      const interrupt = stoppedBy('interrupt')
      const run = decideRun({
        runLevelLine: RUN_LEVEL_LINE,
        shards: [stoppedShard(2, [script(1), script(23)], script(23), interrupt), stoppedShard(1, [script(1), script(2)], script(2), interrupt)],
      })
      expect(linesOf(run.ranked)).toEqual([RUN_LEVEL_LINE, e10.scriptEndLine(script(2), 1, interrupt), e10.scriptEndLine(script(23), 2, interrupt)])
      expect(verdictOf(run)).toBe(RUN_LEVEL_LINE)
    })

    test('every failure is kept in the ranked list, once, each with its shard or null', () => {
      const run = decideRun({
        runLevelLine: RUN_LEVEL_LINE,
        imageBuildLine: IMAGE_BUILD_LINE,
        integrity: [integrityFailure(2, 'secret-scan'), integrityFailure(1, 'fault-fired')],
        shards: [
          stoppedShard(4, [script(1), script(3)], script(3), wallTime()),
          failingShard(3, [script(1), script(2)], script(2)),
          exitedShard(2, [script(1)]),
          passingShard(1, [script(1)], { oomLine: oomShardLine(1) }),
        ],
      })
      expect(run.ranked.map((failure) => ({ line: failure.line, shard: failure.shard }))).toEqual([
        { line: RUN_LEVEL_LINE, shard: null },
        { line: IMAGE_BUILD_LINE, shard: null },
        { line: integrityFailure(2, 'secret-scan').line, shard: null },
        { line: integrityFailure(1, 'fault-fired').line, shard: null },
        { line: oomShardLine(1), shard: 1 },
        { line: e10.shardEndLine(2, exitedWith(1)), shard: 2 },
        { line: scriptFailLine(script(2), 3), shard: 3 },
        { line: e10.scriptEndLine(script(3), 4, wallTime()), shard: 4 },
      ])
    })
  })

  // --- T4.S4: verdict shapes, the double guard and N = 1 (b.uqm SR-12.5, SR-19.6) ---

  describe('E10: verdict shapes, the double guard and N = 1 (b.uqm SR-12.5, SR-19.6)', () => {
    test('pin: the passing verdict is PASS and the selective prefix is SR-12.5’s', () => {
      expect(e10.PASS_VERDICT).toBe('PASS')
      expect(e10.selectiveVerdictPrefix([script(1)])).toBe('SELECTIVE (test-1): ')
    })

    test.each([
      ['no arguments', () => []],
      ['--shards', () => ['--shards', '3']],
      ['--shard-timeout', () => ['--shard-timeout', '90']],
      ['--shards and --shard-timeout', () => ['--shard-timeout', '90', '--shards', '1']],
    ])('a passing full run without --inject (%s) writes exactly PASS', (_what, args) => {
      const run = decideRun({ args: args(), shards: [passingShard(1, [script(1), script(2)]), passingShard(2, [script(1), script(3)])] })
      expect(verdictOf(run)).toBe(e10.PASS_VERDICT)
    })

    test.each([
      ['its script’s FAIL: line', (f: string) => ({ [f]: `${scriptFailLine(f, 2)}\n` }), (f: string) => scriptFailLine(f, 2)],
      ['the fallback line', (_f: string) => ({}), (f: string) => e10.noFailLineFallback(f)],
    ])('a failing full run without --inject writes %s exactly (SR-19.6)', (_what, logs, expected) => {
      const failing = failingShard(2, [script(1), script(3)], script(3))
      const run = decideRun({ args: ['--shards', '2'], shards: [passingShard(1, [script(1), script(2)]), { ...failing, logs: logs(script(3)) }] })
      expect(verdictOf(run)).toBe(expected(script(3)))
    })

    /** The prefix of a selective run of the given script numbers: number forms in canonical order. */
    const selectivePrefixOf = (numbers: readonly number[]): string => `SELECTIVE (${numbers.map(numberForm).join(' ')}): `

    test.each([
      ['a selective run', () => [numberForm(3)], () => selectivePrefixOf([1, 3])],
      ['a selective run with --shards 1', () => ['--shards', '1', numberForm(3)], () => selectivePrefixOf([1, 3])],
      ['an injected full run', () => ['--inject', faultTextOf({ kind: 'retag' })], () => e10.injectedVerdictPrefix([{ kind: 'retag' }])],
      ['an injected full run with --shards', () => ['--shards', '2', '--inject', faultTextOf({ kind: 'kill', shard: 2 })], () => e10.injectedVerdictPrefix([{ kind: 'kill', shard: 2 }])],
      ['an injected selective run', () => ['--inject', faultTextOf({ kind: 'kill', shard: 1 }), script(3)], () => `${e10.injectedVerdictPrefix([{ kind: 'kill', shard: 1 }])}${selectivePrefixOf([1, 3])}`],
    ])('the double guard: %s that passes never writes exactly PASS, only its prefix before PASS', (_what, args, prefix) => {
      const run = decideRun({ args: args(), shards: [passingShard(1, [script(1), script(3)])] })
      expect(run.passed).toBe(true)
      expect(e10.isGateEligible(run.invocation)).toBe(false)
      expect(verdictOf(run)).not.toBe(e10.PASS_VERDICT)
      expect(verdictOf(run)).toBe(`${prefix()}${e10.PASS_VERDICT}`)
    })

    test.each([
      ['a passing run with a failure line', () => ({ invocation: invocationOf([]), scripts: [], passed: true, ranked: [e10.runLevelFailure(RUN_LEVEL_LINE)] })],
      ['a failing run with no failure line', () => ({ invocation: invocationOf([]), scripts: [], passed: false, ranked: [] })],
      ['a top line that does not begin FAIL:', () => ({ invocation: invocationOf([]), scripts: [], passed: false, ranked: [e10.runLevelFailure('constructed line without the prefix')] })],
      ['a top line holding a line feed', () => ({ invocation: invocationOf([]), scripts: [], passed: false, ranked: [e10.runLevelFailure(`${RUN_LEVEL_LINE}\nsecond line`)] })],
      ['a selective run whose scripts lack test-1', () => ({ invocation: invocationOf([numberForm(3)]), scripts: [script(3)], passed: false, ranked: [e10.runLevelFailure(RUN_LEVEL_LINE)] })],
      ['a selective run whose scripts lack a selected script', () => ({ invocation: invocationOf([numberForm(3), numberForm(5)]), scripts: [script(1), script(3)], passed: false, ranked: [e10.runLevelFailure(RUN_LEVEL_LINE)] })],
    ] as [string, () => e10.VerdictInputs][])('the double guard: %s is an internal error, never a verdict', (_what, inputs) => {
      expect(() => e10.buildVerdictLine(inputs())).toThrow()
    })

    test('the selective list is the run’s scripts as number forms in canonical order, test-1 and prerequisites included, however given', () => {
      // test-3 selected (as a number form) with test-0 (as a file name) listed after it; test-2 a prerequisite; test-1 resolved last.
      const run = decideRun({
        args: [numberForm(3), script(0)],
        shards: [passingShard(1, [script(1), script(2), script(3)]), passingShard(2, [script(1), script(0)])],
        expected: [script(3), script(0), script(2), script(1)],
      })
      expect(verdictOf(run)).toBe(`${selectivePrefixOf([1, 2, 3, 0])}${e10.PASS_VERDICT}`)
    })

    test.each([
      ['a script’s FAIL: line', (): RunSpec => ({ args: [numberForm(3)], shards: [failingShard(1, [script(1), script(3)], script(3))] }), [1, 3], () => scriptFailLine(script(3), 1)],
      ['the run-level line', (): RunSpec => ({ args: [numberForm(3)], shards: [passingShard(1, [script(1), script(3)])], runLevelLine: RUN_LEVEL_LINE }), [1, 3], () => RUN_LEVEL_LINE],
      [
        'AC 52: /ci test-23 whose shard has an out-of-memory line',
        (): RunSpec => ({ args: [numberForm(23)], shards: [passingShard(1, [script(1), script(23)], { oomLine: oomShardLine(1) })] }),
        [1, 23],
        () => oomShardLine(1),
      ],
    ] as [string, () => RunSpec, number[], () => string][])('a failing selective run writes SELECTIVE (<scripts>): <its line>: %s', (_what, spec, numbers, line) => {
      expect(verdictOf(decideRun(spec()))).toBe(`${selectivePrefixOf(numbers)}${line()}`)
    })

    test.each([
      ['over a full run’s line', () => ['--inject', faultTextOf({ kind: 'fail', script: numberForm(3) })], () => scriptFailLine(script(3), 1)],
      ['over a selective run’s line', () => ['--inject', faultTextOf({ kind: 'fail', script: numberForm(3) }), script(3)], () => `${selectivePrefixOf([1, 3])}${scriptFailLine(script(3), 1)}`],
    ])('an injected run writes INJECTED (<faults>): %s', (_what, args, inner) => {
      const run = decideRun({ args: args(), shards: [failingShard(1, [script(1), script(3)], script(3))] })
      expect(verdictOf(run)).toBe(`${e10.injectedVerdictPrefix(run.invocation.faults)}${inner()}`)
    })

    test('the INJECTED faults are joined by single spaces in the order E1’s normalizer gives, a repeat dropped', () => {
      const retag: e10.Fault = { kind: 'retag' }
      const kill: e10.Fault = { kind: 'kill', shard: 2 }
      const fail: e10.Fault = { kind: 'fail', script: numberForm(3) }
      const run = decideRun({
        args: ['--inject', faultTextOf(retag), '--inject', faultTextOf(kill), '--inject', faultTextOf(retag), '--inject', faultTextOf({ kind: 'fail', script: script(3) })],
        shards: [failingShard(1, [script(1), script(3)], script(3))],
      })
      expect(verdictOf(run)).toBe(`INJECTED (${[retag, kill, fail].map(faultTextOf).join(' ')}): ${scriptFailLine(script(3), 1)}`)
    })

    test.each([
      ['a full run', () => [] as string[], () => ''],
      ['a selective run', () => [script(5), numberForm(3)], () => selectivePrefixOf([1, 3, 5])],
    ])('N = 1: %s whose mid-order script fails, later ones notrun, writes that script’s line as a serial run does', (_what, args, prefix) => {
      const given = args()
      const assigned = given.length === 0 ? e10Helpers.realScriptFileNames() : [script(1), script(3), script(5)]
      const failing = assigned[Math.floor(assigned.length / 2)] as string
      const run = decideRun({ args: ['--shards', '1', ...given], shards: [failingShard(1, assigned, failing)] })
      const at = assigned.indexOf(failing)
      expect((run.outcomes[0] as e10.ShardOutcome).scripts.map((entry) => entry.result)).toEqual(
        assigned.map((_name, index) => (index < at ? RESULT_WORD_PASS : index === at ? RESULT_WORD_FAIL : RESULT_WORD_NOTRUN)),
      )
      expect(verdictOf(run)).toBe(`${prefix()}${scriptFailLine(failing, 1)}`)
    })
  })

  // --- T4.S5: results.json and the writer (b.uqm SR-16.1) ---

  describe('E10: results.json and its writer (b.uqm SR-16.1)', () => {
    const sortedKeys = (object: object): string[] => Object.keys(object).sort()

    test('the top level holds exactly SR-16.1’s keys', () => {
      expect(sortedKeys(assembled())).toEqual(
        ['version', 'runId', 'pid', 'packageSha256', 'images', 'verdict', 'invocation', 'scripts', 'shards', 'shardCount', 'cap', 'workingSet', 'failedReadings', 'modes', 'failures', 'skippedChecks', 'cleanupFailures', 'timing', 'timingSummary'].sort(),
      )
    })

    test.each([
      ['images', (r: Results) => [r.images], ['pinned', 'drift', 'retag', 'retagMoved']],
      ['invocation', (r: Results) => [r.invocation], ['args', 'selective', 'faults']],
      ['each scripts[] entry', (r: Results) => r.scripts, ['script', 'shard', 'result', 'seconds', 'failLine']],
      [
        'each shards[] entry',
        (r: Results) => r.shards,
        ['shard', 'assigned', 'expectedSeconds', 'limitMinutes', 'endedNormally', 'end', 'seconds', 'anonPeak', 'peakPids', 'final', 'failedReadings', 'packageSha256', 'dependencyFingerprint', 'imageId', 'inspection', 'inspectionError'],
      ],
      ['each anonPeak', (r: Results) => r.shards.map((shard) => shard.anonPeak), ['bytes', 'pageCacheBytes', 'mark']],
      ['each final', (r: Results) => r.shards.map((shard) => shard.final), ['oomKilled', 'oomKillCount']],
      ['shardCount', (r: Results) => [r.shardCount], ['requested', 'effective', 'admitted', 'started', 'reasons']],
      ['cap', (r: Results) => [r.cap], ['usedBytes', 'peakBytes', 'peakShard', 'peakPageCacheBytes', 'peakFromKill', 'derivedBytes', 'suffix']],
      ['workingSet', (r: Results) => [r.workingSet], ['before', 'peak', 'after']],
      ['each working-set reading', (r: Results) => [r.workingSet.before, r.workingSet.peak].filter((reading) => reading !== null), ['bytes', 'anonBytes', 'activeFileBytes']],
      ['modes', (r: Results) => [r.modes], ['runDir', 'tarball', 'shardDirs']],
      ['each failures[] entry', (r: Results) => r.failures, ['line', 'shard']],
      ['timing', (r: Results) => [r.timing], ['buildSeconds', 'baseBuildSeconds', 'totalSeconds']],
    ] as [string, (results: Results) => object[], string[]][])('%s holds exactly its SR-16.1 keys, whatever else its input carried', (_what, pick, keys) => {
      const objects = pick(assembled())
      expect(objects.length).toBeGreaterThan(0)
      for (const object of objects) expect(sortedKeys(object)).toEqual([...keys].sort())
    })

    test.each([
      ['packageSha256 is the tarball’s hash', () => ({}), (r: Results) => r.packageSha256, () => hexValue('e10-package', SHA256_HEX_LENGTH)],
      ['packageSha256 is null when no tarball was packed', () => ({ packageSha256: null }), (r: Results) => r.packageSha256, () => null],
      ['an image the run did not build is null', () => ({}), (r: Results) => r.images, () => ({ pinned: pinnedId(), drift: null, retag: null, retagMoved: false })],
      [
        'every image built and retagMoved as given',
        () => ({ images: { pinnedId: pinnedId(), driftId: 'sha256:e10-drift', retagId: 'sha256:e10-retag', retagMoved: true } }),
        (r: Results) => r.images,
        () => ({ pinned: pinnedId(), drift: 'sha256:e10-drift', retag: 'sha256:e10-retag', retagMoved: true }),
      ],
      [
        'invocation: args as given, not selective, the normalized faults in order',
        () => ({ invocation: invocationOf(['--inject', faultTextOf({ kind: 'retag' }), '--shards', '2', '--inject', faultTextOf({ kind: 'fail', script: script(3) }), '--inject', faultTextOf({ kind: 'retag' })]) }),
        (r: Results) => r.invocation,
        () => ({
          args: ['--inject', faultTextOf({ kind: 'retag' }), '--shards', '2', '--inject', faultTextOf({ kind: 'fail', script: script(3) }), '--inject', faultTextOf({ kind: 'retag' })],
          selective: false,
          faults: [faultTextOf({ kind: 'retag' }), faultTextOf({ kind: 'fail', script: numberForm(3) })],
        }),
      ],
      ['a full run’s cap is written as given', () => ({}), (r: Results) => r.cap, () => resultsInputsOf(decideRun(standardRunSpec())).cap],
      [
        'a selective run’s cap is null but for usedBytes',
        () => ({ invocation: invocationOf([numberForm(2)]) }),
        (r: Results) => [r.invocation.selective, r.cap],
        () => [true, { ...resultsInputsOf(decideRun(standardRunSpec())).cap, peakBytes: null, peakShard: null, peakPageCacheBytes: null, peakFromKill: null, derivedBytes: null, suffix: null }],
      ],
    ] as [string, () => Partial<e10.ResultsInputs>, (results: Results) => unknown, () => unknown][])('%s', (_what, change, pick, expected) => {
      expect(pick(assembled(change()))).toEqual(expected())
    })

    test('scripts: shard order, then run order, test-1 once per shard, each with seconds and failLine or null; the script in progress is fail with no seconds and its end line', () => {
      const [t1, t2, t3, t4, t5] = [1, 2, 3, 4, 5].map(script) as [string, string, string, string, string]
      expect(assembled().scripts).toEqual([
        { script: t1, shard: 1, result: RESULT_WORD_PASS, seconds: 1.5, failLine: null },
        { script: t2, shard: 1, result: RESULT_WORD_FAIL, seconds: 1.5, failLine: scriptFailLine(t2, 1) },
        { script: t3, shard: 1, result: RESULT_WORD_NOTRUN, seconds: null, failLine: null },
        { script: t1, shard: 2, result: RESULT_WORD_PASS, seconds: 1.5, failLine: null },
        { script: t4, shard: 2, result: RESULT_WORD_PASS, seconds: 1.5, failLine: null },
        { script: t1, shard: 3, result: RESULT_WORD_PASS, seconds: 1.5, failLine: null },
        { script: t5, shard: 3, result: RESULT_WORD_FAIL, seconds: null, failLine: e10.scriptEndLine(t5, 3, wallTime()) },
      ])
    })

    test('shards, in shard order: end is "normal" after a failing script, the out-of-memory line on a shard that ended normally, else the end line; inspectionError by its rule', () => {
      expect(assembled().shards.map((shard) => [shard.shard, shard.endedNormally, shard.end, shard.inspectionError])).toEqual([
        [1, true, e10.NORMAL_SHARD_END, null],
        [2, true, oomShardLine(2), 'constructed inspect error its second line'],
        [3, false, e10.scriptEndLine(script(5), 3, wallTime()), e10.INSPECTION_NOT_READ_TEXT],
      ])
    })

    test.each([
      ['a shard with inspection data: null', () => ({ start: started(1), inspection: inspectionData(1), inspectionError: 'constructed inspect error' }), () => null],
      ['a shard never created: container never started', () => ({ start: null, inspection: null, inspectionError: null }), () => 'container never started'],
      ['a shard that failed to start: container never started', () => ({ start: failedStart(1, 'constructed start error'), inspection: null, inspectionError: 'constructed inspect error' }), () => e10.CONTAINER_NEVER_STARTED_TEXT],
      ['a started shard whose read failed: the error, on one line', () => ({ start: started(1), inspection: null, inspectionError: 'constructed inspect error\r\n  its second line' }), () => 'constructed inspect error its second line'],
      ['a started shard with no failed read recorded', () => ({ start: started(1), inspection: null, inspectionError: null }), () => e10.INSPECTION_NOT_READ_TEXT],
    ] as [string, () => Pick<e10.ShardEvidence, 'start' | 'inspection' | 'inspectionError'>, () => string | null][])('inspectionError for %s', (_what, evidence, expected) => {
      expect(e10.inspectionErrorOf(evidence())).toBe(expected())
    })

    test.each([
      ['a packed tarball', 0o444, '0444'],
      ['no tarball', null, null],
    ] as [string, number | null, string | null][])('modes are four-digit octal strings such as "0700", from the full modes read: %s', (_what, tarballMode, tarballText) => {
      const runDir = newRunDir()
      const shardDir = writeShardDir(runDir, { shard: 1 })
      const tarball = join(root, 'e10-package.tgz')
      writeFileSync(tarball, '')
      if (tarballMode !== null) chmodSync(tarball, tarballMode)
      const modes = { runDir: statSync(runDir).mode, tarball: tarballMode === null ? null : statSync(tarball).mode, shardDirs: { [`${SHARD_DIR_PREFIX}1`]: statSync(shardDir).mode } }
      expect(assembled({ modes }).modes).toEqual({ runDir: '0700', tarball: tarballText, shardDirs: { [`${SHARD_DIR_PREFIX}1`]: '0700' } })
    })

    test('failures is the ranked list as given, each line with its shard; a cleanup failure appears only in cleanupFailures', () => {
      const run = decideRun(standardRunSpec())
      const results = e10.assembleResults(resultsInputsOf(run))
      expect(results.failures).toEqual(run.ranked.map((failure) => ({ line: failure.line, shard: failure.shard })))
      expect(results.failures).toEqual([
        { line: integrityFailure(1, 'results-canary').line, shard: null },
        { line: oomShardLine(2), shard: 2 },
        { line: scriptFailLine(script(2), 1), shard: 1 },
        { line: e10.scriptEndLine(script(5), 3, wallTime()), shard: 3 },
      ])
      expect(results.cleanupFailures).toEqual(['constructed cleanup failure line'])
      expect(results.failures.map((failure) => failure.line)).not.toContain('constructed cleanup failure line')
    })

    test('timingSummary is written as an array of strings and reads back through E1’s parser', () => {
      const parsed = parsedResults(writeBoth(newRunDir(), assembled()).results)
      expect(parsed.timingSummary.length).toBeGreaterThan(0)
      expect(parsed.timingSummary.filter((line) => typeof line !== 'string')).toEqual([])
    })

    test('the writer applies the redactor it is given: a fake token in the verdict and a failure line is written <redacted> in both files', () => {
      const token = e10Credentials.fakeToken(e10Credentials.BOT_TOKEN_PREFIX, 'e10-results')
      const [t1, t2] = [script(1), script(2)]
      const leakyLine = `${FAIL_PREFIX}${t2}: constructed failure quoting ${token}`
      const results = e10.assembleResults(resultsInputsOf(decideRun({ shards: [{ ...failingShard(1, [t1, t2], t2), logs: { [t2]: `${leakyLine}\n` } }] })))
      expect(results.verdict).toBe(leakyLine)
      expect(() => e10Credentials.assertNoLeak(results)).toThrow()
      const runDir = newRunDir()
      // The summary text redactor alone also masks the cleanup failure line, so the summary shows it applied.
      const paths = writeBoth(runDir, results, maskingRedactor([token], ['constructed cleanup failure line']))

      const masked = leakyLine.replaceAll(token, e10.REDACTION_PLACEHOLDER)
      const parsed = parsedResults(paths.results)
      expect([parsed.verdict, parsed.failures[0]?.line]).toEqual([masked, masked])
      expect(parsed.cleanupFailures).toEqual(['constructed cleanup failure line'])
      const summary = readFileSync(paths.summary, 'utf-8')
      expect(summary).toContain(masked)
      expect(summary).not.toContain('constructed cleanup failure line')
      expect(readdirSync(runDir).sort()).toEqual([e10.RESULTS_FILE_NAME, e10.SUMMARY_FILE_NAME].sort())
      e10Credentials.assertNoLeak({ results: e10Credentials.writtenFile(paths.results), summary: e10Credentials.writtenFile(paths.summary) })
    })

    test('a second call replaces both files whole, each through a rename, leaving no temporary file', () => {
      const runDir = newRunDir()
      const paths = writeBoth(runDir, assembled())
      const before = [statSync(paths.results).ino, statSync(paths.summary).ino]
      const second = assembled({ verdict: RUN_LEVEL_LINE, cleanupFailures: [] })
      writeBoth(runDir, second)
      expect(readFileSync(paths.results, 'utf-8')).toBe(serializeResults(second))
      expect(readFileSync(paths.summary, 'utf-8')).toBe(e10.renderSummary(second))
      expect(statSync(paths.results).ino).not.toBe(before[0])
      expect(statSync(paths.summary).ino).not.toBe(before[1])
      expect(readdirSync(runDir).sort()).toEqual([e10.RESULTS_FILE_NAME, e10.SUMMARY_FILE_NAME].sort())
      e10Credentials.assertNoLeak({ results: e10Credentials.writtenFile(paths.results), summary: e10Credentials.writtenFile(paths.summary) })
    })

    test('a redactor that throws fails both files and writes neither, so nothing unredacted is written', () => {
      const runDir = newRunDir()
      const throwing: e10.ResultsRedactor = {
        results: () => {
          throw new Error('constructed redactor failure')
        },
        text: (text) => text,
      }
      const written = e10.writeResultsFiles(runDir, assembled(), throwing)
      expect([written.results.ok, written.summary.ok]).toEqual([false, false])
      expect(readdirSync(runDir)).toEqual([])
    })
  })

  // --- T4.S6: summary.txt and the timing summary (b.uqm SR-16.2) ---

  describe('E10: summary.txt and the timing summary (b.uqm SR-16.2)', () => {
    test.each([
      ['a full run, the cap line last', () => [] as string[], (groups: e10.TimingSummaryGroups) => [groups.capLine as string]],
      ['an injected full run, which keeps the cap line', () => ['--inject', faultTextOf({ kind: 'retag' })], (groups: e10.TimingSummaryGroups) => [groups.capLine as string]],
      ['a selective run, which has no cap line', () => [numberForm(3)], () => []],
    ])('the timing summary’s groups come in SR-16.2’s order: %s', (_what, args, capLines) => {
      const groups = timingGroups()
      expect(e10.assembleTimingSummary(groups, e10.runKindOf(invocationOf(args())))).toEqual([
        groups.shardCountLine,
        ...groups.runTimes,
        ...groups.scriptTimes,
        ...groups.durationTableBlock,
        ...groups.slowLines,
        ...groups.tableNotes,
        ...capLines(groups),
      ])
    })

    test('empty groups and empty lines leave no blank line, a given text holding line breaks is split into its lines, and tabs survive', () => {
      const groups = timingGroups({ runTimes: [], scriptTimes: ['constructed script line a\r\nconstructed script line b\n'], durationTableBlock: ['constructed\tblock\trow\n', ''], slowLines: [], tableNotes: ['\n'] })
      expect(e10.assembleTimingSummary(groups, e10.runKindOf(invocationOf([])))).toEqual([
        groups.shardCountLine,
        'constructed script line a',
        'constructed script line b',
        'constructed\tblock\trow',
        groups.capLine as string,
      ])
    })

    test('results.json’s timingSummary is the summary’s timing lines one for one, verbatim, with the duration-table block of a failing full run', () => {
      const results = assembled()
      expect(results.verdict.startsWith(FAIL_PREFIX)).toBe(true)
      const paths = writeBoth(newRunDir(), results)
      const parsed = parsedResults(paths.results)
      const summaryLines = readFileSync(paths.summary, 'utf-8').split('\n')
      const heading = summaryLines.indexOf(e10.SUMMARY_TIMING_HEADING)
      expect(heading).toBeGreaterThan(0)
      expect(summaryLines.slice(heading + 1, -1)).toEqual([...parsed.timingSummary])
      expect(parsed.timingSummary).toEqual(e10.assembleTimingSummary(timingGroups(), e10.runKindOf(invocationOf([]))))
      expect(parsed.timingSummary).toContain('constructed\tblock\trow')
      e10Credentials.assertNoLeak({ summary: e10Credentials.writtenFile(paths.summary) })
    })

    test('the summary shows every results value but the inspection data: each failure with its shard, the skipped checks, the cleanup failures and the failed-reading counts', () => {
      const results = assembled()
      const paths = writeBoth(newRunDir(), results)
      const summary = readFileSync(paths.summary, 'utf-8')
      expect(shownValuesOf(results).filter((value) => !summary.includes(value))).toEqual([])
      const failuresWithShards = results.failures.map((failure) => (failure.shard === null ? failure.line : `${SHARD_DIR_PREFIX}${failure.shard}: ${failure.line}`))
      expect(failuresWithShards.filter((text) => !summary.includes(text))).toEqual([])
      e10Credentials.assertNoLeak({ summary: e10Credentials.writtenFile(paths.summary) })
    })

    test('the summary holds no inspection field: no container name, mount source or label', () => {
      const results = assembled()
      const inspection = results.shards[0]?.inspection ?? null
      expect(inspection).not.toBeNull()
      const fields = inspection === null ? [] : [inspection.name, ...inspection.mounts.map((mount) => mount.source), ...Object.entries(inspection.labels).filter(([key]) => key !== CI_LABEL).flat()]
      expect(fields.length).toBeGreaterThan(2)
      const summary = e10.renderSummary(results)
      expect(fields.filter((field) => summary.includes(field))).toEqual([])
    })

    test('AC 37, summary half: test-23 in progress at an interrupt is listed as its … stopped by interrupt in shard-<k> line with its shard, beside the run-level line', () => {
      const interrupt = stoppedBy('interrupt')
      const t23 = script(23)
      const run = decideRun({ runLevelLine: RUN_LEVEL_LINE, shards: [stoppedShard(1, [script(1), script(2)], script(2), interrupt), stoppedShard(2, [script(1), t23], t23, interrupt)] })
      const results = e10.assembleResults(resultsInputsOf(run))
      const paths = writeBoth(newRunDir(), results)
      const summary = readFileSync(paths.summary, 'utf-8')
      const t23Line = e10.scriptEndLine(t23, 2, interrupt)
      expect(results.verdict).toBe(RUN_LEVEL_LINE)
      expect(results.failures).toContainEqual({ line: t23Line, shard: 2 })
      expect(summary).toContain(`${SHARD_DIR_PREFIX}2: ${t23Line}`)
      expect(results.failures[0]).toEqual({ line: RUN_LEVEL_LINE, shard: null })
      e10Credentials.assertNoLeak({ summary: e10Credentials.writtenFile(paths.summary) })
    })
  })
})

// ---------------------------------------------------------------------------
// E11: integrity and secret-scan (b.t6s E11)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// E12: faults (b.t6s E12)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// E13: the run's end and the tests/runner.sh source audit (b.t6s E13)
// ---------------------------------------------------------------------------
