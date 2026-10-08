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

// ---------------------------------------------------------------------------
// E11: integrity and secret-scan (b.t6s E11)
// ---------------------------------------------------------------------------
//
// b.uqm SR-13.1, SR-13.2, SR-15.2, SR-15.3; AC 60–68, the Epic's demo. The
// integrity entry, `runIntegrity`, runs in process on a run directory built
// here. Every case starts from `integrityRun`, a clean run of N shards that
// passes every check, and makes one stated change: to a shard's files, its
// start record or inspection data, the assignment, the faults, the run state
// or the run directory. Shard files come from E1's run-directory builder; the
// status file and runner log come from the runner's own writers; script names
// come from the repository's listing. Credentials are `fakeToken` values.
// Every failure line and every runner-log line written from the scan's start
// pass `assertNoLeak` (`runEntry`), and so do the written results file,
// summary and verdict. Planted inputs hold values on purpose and are not
// checked. The entry takes no spawn or docker dependency, so that it spawns
// nothing is a static audit of the runner's E11 section (`source-audit.ts`):
// it names no spawn and no runner function that spawns. This region's imports are a namespace or aliased with `e11`, so no
// other region's import can collide with them.

import * as e11Runner from '../scripts/ci-run.ts'
import * as e11Helper from './test-helpers/ci-run.ts'
import { assertNoLeak as e11AssertNoLeak, fakeToken as e11FakeToken, writtenFile as e11WrittenFile } from './test-helpers/credentials.ts'
import { createFakeClock as e11CreateFakeClock, type FakeClock as E11FakeClock } from './test-helpers/fake-clock.ts'
import { makeFifo as e11MakeFifo, mkfifoAvailable as e11MkfifoAvailable } from './test-helpers/fifo.ts'
import { treeSnapshot as e11TreeSnapshot } from './test-helpers/tree-snapshot.ts'
import { callsOf as e11CallsOf, maskLiterals as e11MaskLiterals, stripComments as e11StripComments } from './test-helpers/source-audit.ts'

/** The runner's source, read for the audit that the integrity entry spawns nothing. */
const E11_RUNNER_PATH = join(import.meta.dir, '..', 'scripts', 'ci-run.ts')
/** The banner lines that open the runner's E11 section and the section after it. */
const E11_SECTION_START = '// 15. Integrity and secret-scan (E11)'
const E11_SECTION_END = '// 16. Faults (E12)'
/** Code that spawns or holds what spawns: `Bun.spawn`, `Bun.$`, a `.spawn(` method, the runner's dependencies, docker context and spawn types. */
const E11_SPAWN_CODE = /\bBun\s*\.\s*(?:spawn|\$)|\.\s*spawn(?:Sync)?\s*\(|\b(?:RunnerDeps|DockerContext|SpawnFn|SpawnRequest)\b/

/**
 * The runner's top-level functions that spawn, from its comment-stripped,
 * literal-masked code: each whose text holds `E11_SPAWN_CODE`, then each that
 * calls one of those, until none is added. A function's text runs from its
 * declaration to its closing brace at column 0.
 */
function e11SpawningFunctions(code: string): Set<string> {
  const functions = new Map<string, string>()
  for (const match of code.matchAll(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/gm)) {
    const close = code.indexOf('\n}', match.index)
    if (close < 0) throw new Error(`e11SpawningFunctions: ${match[1]} has no closing brace at column 0`)
    functions.set(match[1] as string, code.slice(match.index, close + 2))
  }
  const spawning = new Set([...functions].filter(([, text]) => E11_SPAWN_CODE.test(text)).map(([name]) => name))
  for (let added = true; added; ) {
    added = false
    for (const [name, text] of functions) {
      if (!spawning.has(name) && [...spawning].some((callee) => e11CallsOf(text, callee).length > 0)) {
        spawning.add(name)
        added = true
      }
    }
  }
  return spawning
}

describe('E11: integrity checks and secret-scan (b.uqm SR-13, SR-15.2, SR-15.3)', () => {
  type Failure = e11Runner.Failure
  type Fault = e11Runner.Fault
  type FiringRecord = e11Runner.FiringRecord
  type InspectionData = e11Runner.InspectionData
  type IntegrityCheck = e11Runner.IntegrityCheck
  type IntegrityEntryInputs = e11Runner.IntegrityEntryInputs
  type IntegrityRunState = e11Runner.IntegrityRunState
  type IntegrityShard = e11Runner.IntegrityShard
  type ShardDirSpec = e11Helper.ShardDirSpec
  type SpawnRecorder = e11Helper.SpawnRecorder

  const {
    createEndFileRedactor,
    createRunnerLog,
    DOCKER_LOG_FILE_NAME,
    faultText,
    INTEGRITY_CHECK_ORDER,
    INTEGRITY_RESULTS_MOUNT_TARGET,
    INTEGRITY_TARBALL_MOUNT_TARGET,
    integrityFailure,
    MARKER_REFUSAL_LINE,
    NO_FIRING_RECORD_REASON,
    numberFormOf,
    PACKAGE_DIR_NAME,
    REDACTION_PLACEHOLDER,
    RUNNER_LOG_FILE_NAME,
    runIntegrity,
    scannedSecretValues,
    SCRIPT_LOG_SUFFIX,
    STATUS_FILE_NAME,
    STILL_DUE_FIRING_REASON,
    SUMMARY_FILE_NAME,
    writeRedactedVerdictFile,
    writeWholeFile,
  } = e11Runner
  const { createSpawnRecorder, makeStatus, realScriptNumbers, writeRunnerLog, writeStatus } = e11Helper

  /**
   * Test data, not a runner constant: the raw Anthropic key's prefix (b.uqm
   * SR-15.1), as the E1 tests build the key. Temporary: the runner exports no
   * constant for it yet; E2 (t1.t6s.sy) adds the export `RAW_KEY_PREFIX`, and
   * this local const is replaced by that import at merge.
   */
  const RAW_KEY_PREFIX = 'sk-ant-'
  /** The run's secret values, each a `fakeToken` with its own suffix: the key, `GH_TOKEN` and the base-build token. */
  const SECRETS = {
    key: e11FakeToken(RAW_KEY_PREFIX, 'key'),
    ghToken: e11FakeToken('', 'gh'),
    baseBuildToken: e11FakeToken('', 'base'),
  }
  /** Test data: the base URL and model, constructed placeholders holding no sentinel and nothing token-like; never scanned. */
  const BASE_URL = 'https://anthropic-base-url.invalid/v1'
  const MODEL = 'e11-model-placeholder'
  /** The runner's environment as the scanned values are read from it. */
  const SECRET_ENV = { ANTHROPIC_API_KEY: SECRETS.key, GH_TOKEN: SECRETS.ghToken, ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_MODEL: MODEL }
  /** Test data: the tarball's file name in `package/`; the runner hashes it and never parses it. */
  const TARBALL_FILE_NAME = 'claude-slack-channel-bots-e11.tgz'
  /** Test data: the run's start, for its status file and start records. */
  const START_MS = Date.UTC(2026, 9, 8, 12, 0, 0)
  /** Test data: every script's time in a result line. */
  const SCRIPT_SECONDS = 1.5
  const PACKAGE_SHA256 = hexValue('e11-package', SHA256_HEX_LENGTH)
  const FINGERPRINT = hexValue('e11-fingerprint', SHA256_HEX_LENGTH)
  const PINNED_IMAGE_ID = `sha256:${hexValue('e11-pinned-image', SHA256_HEX_LENGTH)}`
  /** A run without a stop or a failed build. */
  const NO_STOP: IntegrityRunState = { shardsScheduled: true, imageBuildFailed: false, stopTime: null }
  const P = REDACTION_PLACEHOLDER

  let recorders: SpawnRecorder[] = []

  afterEach(() => {
    const built = recorders
    recorders = []
    for (const recorder of built) recorder.assertNoFailures()
  })

  /** A spawn recorder whose spawns must all be answered, checked in `afterEach`. */
  function newRecorder(clock: E11FakeClock): SpawnRecorder {
    const recorder = createSpawnRecorder({ clock })
    recorders.push(recorder)
    return recorder
  }

  /** `shard-<k>`. */
  function shardName(k: number): string {
    return `${SHARD_DIR_PREFIX}${k}`
  }

  /** A script's log file name in its shard subdirectory. */
  function logName(script: string): string {
    return `${script}${SCRIPT_LOG_SUFFIX}`
  }

  /** Shard k's canary: 32 lowercase hex characters, as the runner draws one. */
  function canaryOf(k: number): string {
    return hexValue(`e11-canary-${k}`, CANARY_LENGTH)
  }

  /** The run's scripts, real names looked up by number: test-1, two of its own per shard, and one more that is not expected. */
  interface RunScripts {
    readonly testOne: string
    readonly others: readonly string[]
    readonly unexpected: string
  }

  function runScripts(n: number): RunScripts {
    const pool = realScriptNumbers()
      .filter((number) => number > 1)
      .map(realScriptFileName)
    const unexpected = pool[2 * n]
    if (unexpected === undefined) throw new Error(`runScripts: the repository has too few scripts for ${n} shards`)
    return { testOne: realScriptFileName(1), others: pool.slice(0, 2 * n), unexpected }
  }

  /** A result file's events: a passing start and end for each script, a `notrun` for each of `notRun`, then the end marker. */
  function resultEvents(passed: readonly string[], notRun: readonly string[] = []): ResultEvent[] {
    return [...passed.flatMap((name) => [startEvent(name), endEvent(name, RESULT_WORD_PASS, SCRIPT_SECONDS)]), ...notRun.map(notRunEvent), DONE_EVENT]
  }

  /** A shard spec without the named files. */
  function withoutFiles(spec: ShardDirSpec, ...keys: (keyof ShardDirSpec)[]): ShardDirSpec {
    const copy: Record<string, unknown> = { ...spec }
    for (const key of keys) delete copy[key]
    return copy as unknown as ShardDirSpec
  }

  /** The clean status file's content. */
  function cleanStatus(): e11Runner.RunStatus {
    return makeStatus({ runId: RUN_ID, pid: RUNNER_PID, startMs: START_MS, deadlineMinutes: 120, phase: 'merge' })
  }

  /** A clean run's options, and each case's one stated change. */
  interface RunChange {
    /** N; default 2. */
    readonly shards?: number
    /** Each shard's assigned scripts in run order, replacing the default: test-1, then two scripts of its own. */
    readonly assigned?: (scripts: RunScripts) => readonly (readonly string[])[]
    /** Shard k's files, from its clean spec. */
    readonly files?: Readonly<Record<number, (clean: ShardDirSpec, scripts: RunScripts) => ShardDirSpec>>
    /** A change to the built run directory, before the entry runs. */
    readonly disk?: (run: IntegrityRun) => void
    /** A change to the entry's inputs. */
    readonly inputs?: (inputs: IntegrityEntryInputs, run: IntegrityRun) => IntegrityEntryInputs
  }

  interface IntegrityRun {
    readonly runDir: string
    readonly scripts: RunScripts
    /** The clean inputs, the runner-log writer among them. */
    readonly inputs: IntegrityEntryInputs
    shardDir(k: number): string
  }

  /**
   * The E11 region's shared fixture: a clean run of N shards that passes every
   * check. The run directory holds only `status.json`, `runner.log`,
   * `package/` with the tarball, and the shard subdirectories. Each shard
   * subdirectory holds only its owned files: its canary, its result file with
   * a pass for each assigned script and the end marker, the tarball hash and
   * fingerprint (equal across shards), its script logs and `docker.log`. Each
   * shard started from the pinned image under a name not in use, and its
   * inspection data holds exactly the two mounts. The scanned values are the
   * key, `GH_TOKEN` and the base-build token.
   */
  function integrityRun(change: RunChange = {}): IntegrityRun {
    const n = change.shards ?? 2
    const scripts = runScripts(n)
    const assigned =
      change.assigned?.(scripts) ??
      Array.from({ length: n }, (_, index) => [scripts.testOne, scripts.others[2 * index] as string, scripts.others[2 * index + 1] as string])
    const runDir = newRunDir()
    writeStatus(runDir, cleanStatus())
    const logPath = writeRunnerLog(runDir, { runId: RUN_ID, pid: RUNNER_PID })
    mkdirSync(join(runDir, PACKAGE_DIR_NAME))
    const tarballPath = join(runDir, PACKAGE_DIR_NAME, TARBALL_FILE_NAME)
    writeFileSync(tarballPath, 'the packed package\n')
    const shards = assigned.map((names, index): IntegrityShard => {
      const k = index + 1
      const clean: ShardDirSpec = {
        shard: k,
        resultFile: resultEvents(names),
        canary: canaryOf(k),
        packageSha256: PACKAGE_SHA256,
        dependencyFingerprint: FINGERPRINT,
        scriptLogs: Object.fromEntries(names.map((name) => [name, `${name}: the script's output\n`])),
        dockerLog: `${shardName(k)}: the container's output\n`,
      }
      const shardDir = writeShardDir(runDir, change.files?.[k]?.(clean, scripts) ?? clean)
      const mounts = [
        { source: tarballPath, target: INTEGRITY_TARBALL_MOUNT_TARGET, readOnly: true },
        { source: shardDir, target: INTEGRITY_RESULTS_MOUNT_TARGET, readOnly: false },
      ]
      return {
        shard: k,
        endedNormally: true,
        start: { kind: 'started', shard: k, imageId: PINNED_IMAGE_ID, mounts, nameInUse: false, canary: canaryOf(k), startedAtMs: START_MS },
        canary: canaryOf(k),
        inspection: {
          name: shardName(k),
          imageId: PINNED_IMAGE_ID,
          mounts,
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
      }
    })
    const inputs: IntegrityEntryInputs = {
      runDir,
      expectedScripts: [scripts.testOne, ...scripts.others],
      assignment: assigned.map((names, index) => ({ shard: index + 1, assigned: names, expectedSeconds: 60 * names.length, limitMinutes: 30 })),
      shards,
      pinnedImageId: PINNED_IMAGE_ID,
      packageSha256: PACKAGE_SHA256,
      tarballPath,
      faults: [],
      firingRecords: [],
      runState: NO_STOP,
      values: scannedSecretValues(SECRET_ENV, { baseBuildToken: SECRETS.baseBuildToken }),
      log: createRunnerLog(logPath, {
        onAppendError: (error) => {
          throw new Error(`runner log: ${error}`)
        },
      }),
    }
    return { runDir, scripts, inputs, shardDir: (k) => join(runDir, shardName(k)) }
  }

  /** The inputs with shard k's start record and inspection data changed. */
  function withShard(inputs: IntegrityEntryInputs, k: number, change: (shard: IntegrityShard) => IntegrityShard): IntegrityEntryInputs {
    return { ...inputs, shards: inputs.shards.map((shard) => (shard.shard === k ? change(shard) : shard)) }
  }

  /** A shard with fields of its inspection data changed. */
  function withInspection(shard: IntegrityShard, change: (inspection: InspectionData) => Partial<InspectionData>): IntegrityShard {
    if (shard.inspection === null) throw new Error('withInspection: the shard has no inspection data')
    return { ...shard, inspection: { ...shard.inspection, ...change(shard.inspection) } }
  }

  /** A shard that did not end normally. */
  function endedAbnormally(shard: IntegrityShard): IntegrityShard {
    return { ...shard, endedNormally: false }
  }

  /** What the entry returned, and the runner log before it ran and what it added. */
  interface EntryOutcome extends e11Runner.IntegrityChecksResult {
    readonly logBefore: string
    readonly logAdded: string
  }

  /** Runs the integrity entry, checks the log before it is left as it was, and passes every failure line and every line it added to the log through `assertNoLeak`. */
  function runEntry(inputs: IntegrityEntryInputs): EntryOutcome {
    const logBefore = readFileSync(inputs.log.path, 'utf-8')
    const result = runIntegrity(inputs)
    const logAfter = readFileSync(inputs.log.path, 'utf-8')
    expect(logAfter.startsWith(logBefore)).toBe(true)
    const logAdded = logAfter.slice(logBefore.length)
    e11AssertNoLeak({ failures: result.failures, logAdded }, 'integrity entry')
    return { ...result, logBefore, logAdded }
  }

  /** Builds a run with one stated change and runs the entry on it. */
  function entryWith(change: RunChange = {}): { readonly run: IntegrityRun; readonly outcome: EntryOutcome } {
    const run = integrityRun(change)
    change.disk?.(run)
    return { run, outcome: runEntry(change.inputs === undefined ? run.inputs : change.inputs(run.inputs, run)) }
  }

  /** One check's case: a stated change, and the entry's whole failure list, with no check skipped. */
  type CheckRow = readonly [what: string, change: RunChange, expected: (scripts: RunScripts) => readonly Failure[]]

  function expectFailures(change: RunChange, expected: (scripts: RunScripts) => readonly Failure[]): void {
    const { run, outcome } = entryWith(change)
    expect(outcome.failures).toEqual([...expected(run.scripts)])
    expect(outcome.skippedChecks).toEqual([])
  }

  // T3.S1: the clean run, the order, the granularity, the skip rules, fault-fired and the entry spawning nothing.

  describe('the entry as a whole (b.uqm SR-13.1, SR-13.2)', () => {
    test.each([1, 2, 3])('a clean run of %p shard(s) gives no failure, skips no check and adds nothing to the runner log', (n) => {
      const { outcome } = entryWith({ shards: n })
      expect(outcome).toMatchObject({ failures: [], skippedChecks: [], logAdded: '' })
    })

    test('the checks are SR-13.2’s twelve, in its order, secret-scan last', () => {
      expect(INTEGRITY_CHECK_ORDER).toEqual([
        'fault-fired',
        'schedule-coverage',
        'isolation-mounts',
        'isolation-config',
        'results-canary',
        'results-ownership',
        'image-drift',
        'name-collision',
        'result-coverage',
        'package-hash',
        'dependency-set',
        'secret-scan',
      ])
    })

    test('failures from several checks come in SR-13.2’s order, secret-scan last, each line FAIL: integrity: <check>: <detail>', () => {
      const kill: Fault = { kind: 'kill', shard: 2 }
      const stray = 'stray-artifact.txt'
      const { outcome } = entryWith({
        files: { 1: (clean) => ({ ...clean, dockerLog: `${clean.dockerLog}${SECRETS.key}\n`, foreignFiles: { [stray]: 'a stray artifact\n' } }) },
        inputs: (inputs) => ({
          ...withShard(
            withShard(inputs, 1, (shard) => ({ ...shard, start: shard.start === null ? null : { ...shard.start, nameInUse: true } })),
            2,
            (shard) => withInspection(shard, () => ({ privileged: true })),
          ),
          faults: [kill],
        }),
      })
      const expected: [IntegrityCheck, string, number | null][] = [
        ['fault-fired', `${faultText(kill)} did not fire (${NO_FIRING_RECORD_REASON})`, null],
        ['isolation-config', `${shardName(2)} runs in privileged mode`, 2],
        ['results-ownership', `${shardName(1)} holds the file ${stray}, which is not one of its files`, 1],
        ['name-collision', `${shardName(1)}'s container name was already in use when it started`, 1],
        ['secret-scan', `${shardName(1)}/${DOCKER_LOG_FILE_NAME}`, null],
      ]
      expect(outcome.failures.map((failure) => failure.line)).toEqual(expected.map(([check, detail]) => `${FAIL_PREFIX}integrity: ${check}: ${detail}`))
      expect(outcome.failures.map((failure) => failure.shard)).toEqual(expected.map(([, , shard]) => shard))
      expect(outcome.failures.map((failure) => failure.failureClass)).toEqual(expected.map(([check]) => ({ kind: 'integrity', check })))
    })

    test('inside one check: one failure per problem; a one-shard problem carries its shard, a run-directory one null; shard order, then the null ones', () => {
      expectFailures(
        {
          files: {
            1: (clean) => ({ ...clean, foreignFiles: { 'stray-b.txt': 'stray\n' } }),
            2: (clean) => ({ ...clean, foreignFiles: { 'stray-b.txt': 'stray\n', 'stray-a.txt': 'stray\n' } }),
          },
          disk: (run) => writeFileSync(join(run.runDir, 'stray-run.txt'), 'stray\n'),
        },
        () => [
          integrityFailure('results-ownership', `${shardName(1)} holds the file stray-b.txt, which is not one of its files`, 1),
          integrityFailure('results-ownership', `${shardName(2)} holds the file stray-a.txt, which is not one of its files`, 2),
          integrityFailure('results-ownership', `${shardName(2)} holds the file stray-b.txt, which is not one of its files`, 2),
          integrityFailure('results-ownership', 'the run directory holds the file stray-run.txt, which is not one of its entries', null),
        ],
      )
    })

    test('the whole entry spawns nothing: the runner’s E11 section names no spawn, no spawn or docker dependency, and no runner function that spawns', () => {
      const source = readFileSync(E11_RUNNER_PATH, 'utf-8')
      const start = source.indexOf(E11_SECTION_START)
      const end = source.indexOf(E11_SECTION_END)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      const section = e11MaskLiterals(e11StripComments(source.slice(start, end)))
      expect(section).toMatch(/\bfunction runIntegrity\s*\(/)

      const spawning = e11SpawningFunctions(e11MaskLiterals(e11StripComments(source)))
      // The derivation is not vacuous: it finds the spawn binding, the docker layer and the token lookup.
      for (const name of ['startChild', 'spawnChild', 'createRealRunnerDeps', 'startDocker', 'runDocker', 'readContainerInspection', 'runContainer', 'startTestImageBuild', 'lookUpBaseBuildToken']) {
        expect(spawning.has(name)).toBe(true)
      }
      expect(section).not.toMatch(E11_SPAWN_CODE)
      expect([...spawning].filter((name) => new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(section))).toEqual([])
      expect(['spawnSync', 'execSync', 'execFileSync', 'execFile', 'spawn'].filter((name) => e11CallsOf(section, name).length > 0)).toEqual([])
    })
  })

  describe('the skip rules (b.uqm SR-13.1, SR-5.6)', () => {
    const KILL_1: Fault = { kind: 'kill', shard: 1 }
    /** Test data: E12's reason for a fault that did not fire. */
    const NOT_FIRED_REASON = 'its shard had ended before it was due'

    /** The stated change for a run whose shards were never scheduled: no assignment, no shard, no shard subdirectory. */
    function unscheduled(run: IntegrityRun): IntegrityEntryInputs {
      for (const shard of run.inputs.shards) rmSync(run.shardDir(shard.shard), { recursive: true })
      return { ...run.inputs, assignment: null, shards: [] }
    }

    const ROWS: [string, IntegrityRunState, IntegrityCheck[]][] = [
      ['an image build failure before scheduling', { shardsScheduled: false, imageBuildFailed: true, stopTime: null }, ['fault-fired', 'schedule-coverage']],
      ['a run-level stop before scheduling', { shardsScheduled: false, imageBuildFailed: false, stopTime: 'before-end-of-run' }, ['fault-fired', 'schedule-coverage']],
      ['a run-level stop after scheduling, before the end-of-run sequence', { shardsScheduled: true, imageBuildFailed: false, stopTime: 'before-end-of-run' }, ['fault-fired']],
      ['a run-level stop during the end-of-run sequence', { shardsScheduled: true, imageBuildFailed: false, stopTime: 'during-end-of-run' }, []],
      ['no stop', NO_STOP, []],
    ]

    test.each(ROWS.flatMap(([what, state, skipped]) => (['injected', 'uninjected'] as const).map((injection) => [what, injection, state, skipped] as const)))(
      '%s, %s run: exactly its checks are skipped, a skipped check gives no failure, and secret-scan still runs, finding the key planted in the runner log',
      (_what, injection, state, skipped) => {
        const run = integrityRun()
        const inputs = state.shardsScheduled ? run.inputs : unscheduled(run)
        run.inputs.log(`a line before the scan: ${SECRETS.key}`)
        const injected = injection === 'injected'
        const record: FiringRecord = { fault: KILL_1, shard: 1, leakSourceShard: null, state: 'not-fired', reason: NOT_FIRED_REASON }
        const outcome = runEntry({ ...inputs, runState: state, faults: injected ? [KILL_1] : [], firingRecords: injected ? [record] : [] })
        expect(outcome.skippedChecks).toEqual(skipped)
        // A schedule-coverage that ran on no assignment, or a fault-fired that ran on the unfired fault, would fail.
        const firing = injected && !skipped.includes('fault-fired') ? [integrityFailure('fault-fired', `${faultText(KILL_1)} did not fire (${NOT_FIRED_REASON})`, null)] : []
        expect(outcome.failures).toEqual([...firing, integrityFailure('secret-scan', RUNNER_LOG_FILE_NAME, null)])
      },
    )
  })

  describe('fault-fired (b.uqm SR-13.2 check 1, SR-14.3)', () => {
    const FAIL_2: Fault = { kind: 'fail', script: numberFormOf(2) }
    const KILL_2: Fault = { kind: 'kill', shard: 2 }
    /** Test data: E12's reasons, written verbatim into the line. */
    const ENDED_REASON = 'shard-2 had ended before it was due'
    const OTHER_FAULT_REASON = `${faultText(FAIL_2)} ended its shard first`

    function record(fault: Fault, state: FiringRecord['state'], reason: string | null = null): FiringRecord {
      return { fault, shard: fault.kind === 'kill' ? fault.shard : 1, leakSourceShard: null, state, reason }
    }

    function notFired(fault: Fault, why: string): Failure {
      return integrityFailure('fault-fired', `${faultText(fault)} did not fire (${why})`, null)
    }

    test.each([
      ['every fault fired', [FAIL_2, KILL_2], [record(FAIL_2, 'fired'), record(KILL_2, 'fired')], []],
      ['a fault that did not fire, with its recorded reason', [FAIL_2, KILL_2], [record(FAIL_2, 'fired'), record(KILL_2, 'not-fired', ENDED_REASON)], [notFired(KILL_2, ENDED_REASON)]],
      ['a recorded reason that names another fault, kept verbatim', [FAIL_2, KILL_2], [record(FAIL_2, 'fired'), record(KILL_2, 'not-fired', OTHER_FAULT_REASON)], [notFired(KILL_2, OTHER_FAULT_REASON)]],
      ['a fault with no firing record, which counts as not fired', [FAIL_2, KILL_2], [record(FAIL_2, 'fired')], [notFired(KILL_2, NO_FIRING_RECORD_REASON)]],
      ['a fault still due when the run ended', [FAIL_2, KILL_2], [record(FAIL_2, 'fired'), record(KILL_2, 'due')], [notFired(KILL_2, STILL_DUE_FIRING_REASON)]],
      ['two faults that did not fire, in the faults’ order', [KILL_2, FAIL_2], [record(FAIL_2, 'not-fired', ENDED_REASON), record(KILL_2, 'not-fired', OTHER_FAULT_REASON)], [notFired(KILL_2, OTHER_FAULT_REASON), notFired(FAIL_2, ENDED_REASON)]],
      ['a run with no faults: no failure, and fault-fired is not named skipped', [], [], []],
    ] as [string, Fault[], FiringRecord[], Failure[]][])('%s', (_what, faults, firingRecords, expected) => {
      expectFailures({ inputs: (inputs) => ({ ...inputs, faults, firingRecords }) }, () => expected)
    })
  })

  // T3.S2: schedule-coverage and result-coverage.

  describe('schedule-coverage (b.uqm SR-13.2 check 2; AC 60)', () => {
    test.each([
      ['an assignment that misses an expected script', { assigned: ({ testOne, others }) => [[testOne, others[0], others[1]], [testOne, others[2]]] }, ({ others }) => [
        integrityFailure('schedule-coverage', `${others[3]} is assigned to no shard`, null),
      ]],
      ['an assignment that puts one script in two shards', { assigned: ({ testOne, others }) => [[testOne, others[0], others[1]], [testOne, others[2], others[3], others[0]]] }, ({ others }) => [
        integrityFailure('schedule-coverage', `${others[0]} is assigned more than once: ${shardName(1)}, ${shardName(2)}`, null),
      ]],
      ['an assignment that leaves test-1 out of a shard used', { assigned: ({ testOne, others }) => [[testOne, others[0], others[1]], [others[2], others[3]]] }, ({ testOne }) => [
        integrityFailure('schedule-coverage', `${testOne} is not assigned to ${shardName(2)}`, 2),
      ]],
      ['an assignment that adds a script that is not expected', { assigned: ({ testOne, others, unexpected }) => [[testOne, others[0], others[1], unexpected], [testOne, others[2], others[3]]] }, ({ unexpected }) => [
        integrityFailure('schedule-coverage', `${unexpected} is not an expected script but is assigned to ${shardName(1)}`, 1),
      ]],
      ['a correct assignment', {}, () => []],
    ] as CheckRow[])('%s', (_what, change, expected) => {
      expectFailures(change, expected)
    })
  })

  describe('result-coverage (b.uqm SR-13.2 check 9; AC 65)', () => {
    /** Shard 2's result file, changed. */
    function shard2Results(events: (scripts: RunScripts) => ShardDirSpec['resultFile']): RunChange['files'] {
      return { 2: (clean, scripts) => ({ ...clean, resultFile: events(scripts) }) }
    }

    test.each([
      ['a normally ended shard missing an assigned script’s result', { files: shard2Results(({ testOne, others }) => resultEvents([testOne, others[2] as string])) }, ({ others }) => [
        integrityFailure('result-coverage', `${others[3]} has no result in ${shardName(2)}`, 2),
      ]],
      ['a normally ended shard missing test-1’s result', { files: shard2Results(({ others }) => resultEvents([others[2] as string, others[3] as string])) }, ({ testOne }) => [
        integrityFailure('result-coverage', `${testOne} has no result in ${shardName(2)}`, 2),
      ]],
      ['a shard holding a result for a script assigned to another shard, so it has results from two shards', { files: shard2Results(({ testOne, others }) => resultEvents([testOne, others[2] as string, others[3] as string, others[0] as string])) }, ({ others }) => [
        integrityFailure('result-coverage', `${others[0]} has a result in ${shardName(2)}, which it is not assigned to`, 2),
      ]],
      ['a shard holding two results for one script', { files: shard2Results(({ testOne, others }) => resultEvents([testOne, others[2] as string, others[3] as string, others[3] as string])) }, ({ others }) => [
        integrityFailure('result-coverage', `${others[3]} has 2 results in ${shardName(2)}`, 2),
      ]],
      ['a normally ended shard with no result file', { files: { 2: (clean: ShardDirSpec) => withoutFiles(clean, 'resultFile') } }, () => [
        integrityFailure('result-coverage', `${shardName(2)} has no ${RESULT_FILE_NAME}`, 2),
      ]],
      ['notrun lines, which count as results', { files: shard2Results(({ testOne, others }) => resultEvents([testOne, others[2] as string], [others[3] as string])) }, () => []],
      ['a shard that did not end normally, with results missing, which is not judged', {
        files: shard2Results(({ testOne }) => [startEvent(testOne), endEvent(testOne, RESULT_WORD_PASS, SCRIPT_SECONDS)]),
        inputs: (inputs: IntegrityEntryInputs) => withShard(inputs, 2, endedAbnormally),
      }, () => []],
    ] as CheckRow[])('%s', (_what, change, expected) => {
      expectFailures(change, expected)
    })
  })

  // T3.S3: the checks that read inspection data and the start records.

  describe('isolation-mounts, isolation-config, image-drift and name-collision, from the captured data only (b.uqm SR-13.2 checks 3, 4, 7, 8, SR-10.5; AC 61, AC 64)', () => {
    const EXTRA_TARGET = '/host-extra'
    const LEAK_TARGET = '/leaked-results'
    const OTHER_CONTAINER_MODE = `container:${hexValue('e11-other-container', SHA256_HEX_LENGTH)}`
    const DRIFT_IMAGE_ID = `sha256:${hexValue('e11-drift-image', SHA256_HEX_LENGTH)}`

    /** One row: shard 2's inspection data changed, and the one failure it gives. */
    type InspectionRow = readonly [check: IntegrityCheck, what: string, change: (inspection: InspectionData) => Partial<InspectionData>, detail: string]

    const mountsWithout = (target: string) => (inspection: InspectionData) => ({ mounts: inspection.mounts.filter((mount) => mount.target !== target) })

    test.each([
      ['isolation-mounts', 'a missing tarball mount', mountsWithout(INTEGRITY_TARBALL_MOUNT_TARGET), `${shardName(2)} has no tarball mount at ${INTEGRITY_TARBALL_MOUNT_TARGET}`],
      ['isolation-mounts', 'a missing mount of its results subdirectory', mountsWithout(INTEGRITY_RESULTS_MOUNT_TARGET), `${shardName(2)} has no mount of its results subdirectory at ${INTEGRITY_RESULTS_MOUNT_TARGET}`],
      ['isolation-mounts', 'a tarball mount that is not read-only', (inspection) => ({ mounts: inspection.mounts.map((mount) => ({ ...mount, readOnly: mount.target === INTEGRITY_TARBALL_MOUNT_TARGET ? false : mount.readOnly })) }), `${shardName(2)}'s tarball mount at ${INTEGRITY_TARBALL_MOUNT_TARGET} is not read-only`],
      ['isolation-mounts', 'an extra mount', (inspection) => ({ mounts: [...inspection.mounts, { source: join(root, 'host-extra'), target: EXTRA_TARGET, readOnly: true }] }), `${shardName(2)} has an extra mount at ${EXTRA_TARGET}`],
      ['isolation-config', 'host network mode', () => ({ networkMode: 'host' }), `${shardName(2)} uses host network mode`],
      ['isolation-config', 'privileged mode', () => ({ privileged: true }), `${shardName(2)} runs in privileged mode`],
      ['isolation-config', 'a PID namespace shared with the host', () => ({ pidMode: 'host' }), `${shardName(2)} shares its PID namespace with the host`],
      ['isolation-config', 'an IPC namespace shared with the host', () => ({ ipcMode: 'host' }), `${shardName(2)} shares its IPC namespace with the host`],
      ['isolation-config', 'a network namespace shared with another container', () => ({ networkMode: OTHER_CONTAINER_MODE }), `${shardName(2)} shares its network namespace with another container`],
      ['isolation-config', 'a PID namespace shared with another container', () => ({ pidMode: OTHER_CONTAINER_MODE }), `${shardName(2)} shares its PID namespace with another container`],
      ['isolation-config', 'an IPC namespace shared with another container', () => ({ ipcMode: OTHER_CONTAINER_MODE }), `${shardName(2)} shares its IPC namespace with another container`],
      ['image-drift', 'an image ID other than the pinned one', () => ({ imageId: DRIFT_IMAGE_ID }), `${shardName(2)}'s image is not the pinned image`],
    ] as InspectionRow[])('%s fails, naming the shard, for %s', (check, _what, change, detail) => {
      expectFailures({ inputs: (inputs) => withShard(inputs, 2, (shard) => withInspection(shard, change)) }, () => [integrityFailure(check, detail, 2)])
    })

    test('shard 2 mounting shard 1’s subdirectory gives the PRD’s line, once, and no separate extra-mount line', () => {
      const { outcome } = entryWith({
        inputs: (inputs, run) =>
          withShard(inputs, 2, (shard) => withInspection(shard, (inspection) => ({ mounts: [...inspection.mounts, { source: run.shardDir(1), target: LEAK_TARGET, readOnly: false }] }))),
      })
      expect(outcome.failures.map((failure) => failure.line)).toEqual([`${FAIL_PREFIX}integrity: isolation-mounts: ${SHARD_DIR_PREFIX}2 mounts ${SHARD_DIR_PREFIX}1's results subdirectory`])
      expect(outcome.failures.map((failure) => failure.shard)).toEqual([2])
    })

    test('name-collision fails, naming the shard, when it started under a name already in use', () => {
      expectFailures(
        { inputs: (inputs) => withShard(inputs, 2, (shard) => ({ ...shard, start: shard.start === null ? null : { ...shard.start, nameInUse: true } })) },
        () => [integrityFailure('name-collision', `${shardName(2)}'s container name was already in use when it started`, 2)],
      )
    })

    test('a started shard with no inspection data gives shard-<k> could not be inspected for isolation-mounts, isolation-config and image-drift, once each', () => {
      expectFailures({ inputs: (inputs) => withShard(inputs, 2, (shard) => ({ ...shard, inspection: null })) }, () =>
        (['isolation-mounts', 'isolation-config', 'image-drift'] as const).map((check) => integrityFailure(check, `${shardName(2)} could not be inspected`, 2)),
      )
    })

    test.each([
      ['never created', (shard: IntegrityShard): IntegrityShard => ({ ...shard, start: null })],
      ['created but failed to start', (shard: IntegrityShard): IntegrityShard => {
        if (shard.start === null) throw new Error('the clean shard has a start record')
        const { startedAtMs: _startedAt, ...common } = shard.start as e11Runner.ShardStarted
        return { ...shard, start: { ...common, kind: 'failed-to-start', detail: 'test data: the daemon refused the start' } }
      }],
    ])('a shard whose container was %s, with no inspection data, gives no could-not-be-inspected failure', (_what, change) => {
      expectFailures({ inputs: (inputs) => withShard(inputs, 2, (shard) => ({ ...endedAbnormally(change(shard)), inspection: null })) }, () => [])
    })

    test('a shard stopped at its limit is judged from the inspection data captured for it: an extra mount in that data is reported (AC 67)', () => {
      const { outcome } = entryWith({
        inputs: (inputs) =>
          withShard(inputs, 2, (shard) =>
            withInspection(endedAbnormally(shard), (inspection) => ({ mounts: [...inspection.mounts, { source: join(root, 'host-extra'), target: EXTRA_TARGET, readOnly: true }] })),
          ),
      })
      expect(outcome.failures).toEqual([integrityFailure('isolation-mounts', `${shardName(2)} has an extra mount at ${EXTRA_TARGET}`, 2)])
    })
  })

  // T3.S4: the shard-file evidence checks and the evidence rule.

  describe('results-canary (b.uqm SR-13.2 check 5; AC 62)', () => {
    /** Shard 2's result file when its test-1 failed: the rest not run. */
    const testOneFailed = (clean: ShardDirSpec, { testOne, others }: RunScripts): ShardDirSpec => ({
      ...clean,
      resultFile: [startEvent(testOne), endEvent(testOne, RESULT_WORD_FAIL, SCRIPT_SECONDS), notRunEvent(others[2] as string), notRunEvent(others[3] as string), DONE_EVENT],
    })

    test.each([
      ['a file in shard 2 holding shard 1’s canary', { files: { 2: (clean, { others }) => ({ ...clean, scriptLogs: { ...clean.scriptLogs, [others[2] as string]: `found ${canaryOf(1)}\n` } }) } }, ({ others }) => [
        integrityFailure('results-canary', `${shardName(2)}'s ${logName(others[2] as string)} holds ${shardName(1)}'s canary`, 2),
      ]],
      ['a normally ended shard, test-1 passed, with no canary.txt', { files: { 2: (clean) => withoutFiles(clean, 'canary') } }, () => [
        integrityFailure('results-canary', `${shardName(2)} has no ${CANARY_FILE_NAME}`, 2),
      ]],
      ['a normally ended shard, test-1 passed, with a canary.txt holding another value', { files: { 2: (clean) => ({ ...clean, canary: hexValue('e11-wrong-canary', CANARY_LENGTH) }) } }, () => [
        integrityFailure('results-canary', `${shardName(2)}'s ${CANARY_FILE_NAME} does not hold its canary`, 2),
      ]],
      ['a normally ended shard, test-1 passed, with a malformed canary.txt', { files: { 2: (clean) => ({ ...clean, canary: { value: canaryOf(2), change: 'uppercase' } }) } }, () => [
        integrityFailure('results-canary', `${shardName(2)}'s ${CANARY_FILE_NAME} does not hold its canary`, 2),
      ]],
      ['an abnormally ended shard without a canary', { files: { 2: (clean) => withoutFiles(clean, 'canary') }, inputs: (inputs) => withShard(inputs, 2, endedAbnormally) }, () => []],
      ['a normally ended shard whose test-1 failed, without a canary', { files: { 2: (clean, scripts) => withoutFiles(testOneFailed(clean, scripts), 'canary') } }, () => []],
      ['the canaries in the runner log', { disk: (run) => run.inputs.log(`canaries: ${canaryOf(1)} ${canaryOf(2)}`) }, () => []],
      ['correct canaries', {}, () => []],
    ] as CheckRow[])('%s', (_what, change, expected) => {
      expectFailures(change, expected)
    })

    test('a canary in an entry’s name is masked in the line', () => {
      expectFailures({ files: { 2: (clean) => ({ ...clean, foreignFiles: { [canaryOf(1)]: 'named after a canary\n' } }) } }, () => [
        integrityFailure('results-ownership', `${shardName(2)} holds the file ${P}, which is not one of its files`, 2),
      ])
    })
  })

  describe('results-ownership (b.uqm SR-13.2 check 6, SR-5.9; AC 63)', () => {
    const outside = (name: string): string => join(root, name)

    test.each([
      ['a log of a script not assigned to the shard', { files: { 2: (clean, { others }) => ({ ...clean, scriptLogs: { ...clean.scriptLogs, [others[0] as string]: 'not its script\n' } }) } }, ({ others }) => [
        integrityFailure('results-ownership', `${shardName(2)} holds the file ${logName(others[0] as string)}, which is not one of its files`, 2),
      ]],
      ['a verdict.txt in a shard subdirectory', { disk: (run) => writeVerdict(run.shardDir(2), 'test data: a verdict line') }, () => [
        integrityFailure('results-ownership', `${shardName(2)} holds the file ${VERDICT_FILE_NAME}, which is not one of its files`, 2),
      ]],
      ['a stray artifact', { files: { 2: (clean) => ({ ...clean, foreignFiles: { 'judgment.json': '{}\n' } }) } }, () => [
        integrityFailure('results-ownership', `${shardName(2)} holds the file judgment.json, which is not one of its files`, 2),
      ]],
      ['a nested directory, named once whatever it holds', {
        disk: (run) => {
          mkdirSync(join(run.shardDir(2), 'nested'))
          writeFileSync(join(run.shardDir(2), 'nested', 'inner.txt'), 'inner\n')
        },
      }, () => [integrityFailure('results-ownership', `${shardName(2)} holds the directory nested, which is not one of its files`, 2)]],
      ['a symbolic link', { disk: (run) => symlinkSync(outside('outside.txt'), join(run.shardDir(2), 'link')) }, () => [
        integrityFailure('results-ownership', `${shardName(2)} holds the symbolic link link, which is not one of its files`, 2),
      ]],
      ['an owned name that is a symbolic link', {
        files: { 2: (clean) => withoutFiles(clean, 'dockerLog') },
        disk: (run) => symlinkSync(outside('outside.log'), join(run.shardDir(2), DOCKER_LOG_FILE_NAME)),
      }, () => [integrityFailure('results-ownership', `${shardName(2)}'s ${DOCKER_LOG_FILE_NAME} is a symbolic link, not a regular file`, 2)]],
      ['an unexpected file in the run directory', { disk: (run) => writeFileSync(join(run.runDir, 'notes.txt'), 'notes\n') }, () => [
        integrityFailure('results-ownership', 'the run directory holds the file notes.txt, which is not one of its entries', null),
      ]],
      ['an unexpected directory in the run directory', { disk: (run) => mkdirSync(join(run.runDir, 'test-results')) }, () => [
        integrityFailure('results-ownership', 'the run directory holds the directory test-results, which is not one of its entries', null),
      ]],
      ['owned files only, docker.log included', {}, () => []],
      ['owned files with the optional ones absent (no docker.log, no script log)', { files: { 2: (clean) => withoutFiles(clean, 'dockerLog', 'scriptLogs') } }, () => []],
    ] as CheckRow[])('%s', (_what, change, expected) => {
      expectFailures(change, expected)
    })
  })

  describe('package-hash and dependency-set (b.uqm SR-13.2 checks 10, 11; AC 66)', () => {
    const OTHER_SHA256 = hexValue('e11-other-package', SHA256_HEX_LENGTH)
    const OTHER_FINGERPRINT = hexValue('e11-other-fingerprint', SHA256_HEX_LENGTH)

    test.each([
      ['a well-formed tarball hash that differs, in a normally ended shard', { files: { 2: (clean) => ({ ...clean, packageSha256: OTHER_SHA256 }) } }, () => [
        integrityFailure('package-hash', `${shardName(2)}'s ${PACKAGE_SHA256_FILE_NAME} differs from the run's tarball hash`, 2),
      ]],
      ['a well-formed tarball hash that differs, in an abnormally ended shard', { files: { 2: (clean) => ({ ...clean, packageSha256: OTHER_SHA256 }) }, inputs: (inputs) => withShard(inputs, 2, endedAbnormally) }, () => [
        integrityFailure('package-hash', `${shardName(2)}'s ${PACKAGE_SHA256_FILE_NAME} differs from the run's tarball hash`, 2),
      ]],
      ['no tarball hash in a normally ended shard whose test-1 passed', { files: { 2: (clean) => withoutFiles(clean, 'packageSha256') } }, () => [
        integrityFailure('package-hash', `${shardName(2)} has no ${PACKAGE_SHA256_FILE_NAME}`, 2),
      ]],
      ['a malformed tarball hash in a normally ended shard whose test-1 passed', { files: { 2: (clean) => ({ ...clean, packageSha256: { value: PACKAGE_SHA256, change: 'short' } }) } }, () => [
        integrityFailure('package-hash', `${shardName(2)}'s ${PACKAGE_SHA256_FILE_NAME} is malformed`, 2),
      ]],
      ['no tarball hash in an abnormally ended shard', { files: { 2: (clean) => withoutFiles(clean, 'packageSha256') }, inputs: (inputs) => withShard(inputs, 2, endedAbnormally) }, () => []],
      ['differing fingerprints, named in groups of equal ones', { shards: 3, files: { 2: (clean) => ({ ...clean, dependencyFingerprint: OTHER_FINGERPRINT }) } }, () => [
        integrityFailure('dependency-set', `the dependency fingerprints differ between (${shardName(1)}, ${shardName(3)}), (${shardName(2)})`, null),
      ]],
      ['no fingerprint in a normally ended shard whose test-1 passed', { files: { 2: (clean) => withoutFiles(clean, 'dependencyFingerprint') } }, () => [
        integrityFailure('dependency-set', `${shardName(2)} has no ${DEPENDENCY_FINGERPRINT_FILE_NAME}`, 2),
      ]],
    ] as CheckRow[])('%s', (_what, change, expected) => {
      expectFailures(change, expected)
    })
  })

  describe('the evidence rule (b.uqm SR-13.1; AC 67, its integrity half)', () => {
    test('a shard whose test-1 failed inside its package install, and so wrote no fingerprint, gives no dependency-set failure, and no integrity failure at all', () => {
      expectFailures(
        {
          files: {
            2: (clean, { testOne, others }) =>
              withoutFiles(
                { ...clean, resultFile: [startEvent(testOne), endEvent(testOne, RESULT_WORD_FAIL, SCRIPT_SECONDS), notRunEvent(others[2] as string), notRunEvent(others[3] as string), DONE_EVENT] },
                'dependencyFingerprint',
              ),
          },
        },
        () => [],
      )
    })

    test('a shard whose container exited 2 with the marker refusal in its docker.log, and wrote nothing else, gives no integrity failure of any kind', () => {
      expectFailures(
        {
          files: { 2: () => ({ shard: 2, dockerLog: `${MARKER_REFUSAL_LINE}\n` }) },
          inputs: (inputs) => withShard(inputs, 2, endedAbnormally),
        },
        () => [],
      )
    })
  })

  // T3.S5: secret-scan, the masking writers and the runner log's masking.

  describe('secret-scan (b.uqm SR-13.2 check 12, SR-15.2, SR-15.3; AC 68)', () => {
    /** Shard k's docker.log with `text` added. */
    const inDockerLog = (k: number, text: string): RunChange['files'] => ({ [k]: (clean: ShardDirSpec) => ({ ...clean, dockerLog: `${clean.dockerLog}${text}\n` }) })
    const inRunnerLog = (text: string) => (run: IntegrityRun): void => run.inputs.log(`a line before the scan: ${text}`)

    test('the scanned values are the key, GH_TOKEN and the base-build token when looked up; never the base URL or the model', () => {
      expect(scannedSecretValues(SECRET_ENV, { baseBuildToken: SECRETS.baseBuildToken })).toEqual([SECRETS.key, SECRETS.ghToken, SECRETS.baseBuildToken])
      expect(scannedSecretValues(SECRET_ENV)).toEqual([SECRETS.key, SECRETS.ghToken])
    })

    test.each([
      ['the key in a script log', { files: { 1: (clean, { testOne }) => ({ ...clean, scriptLogs: { ...clean.scriptLogs, [testOne]: `output ${SECRETS.key}\n` } }) } }, ({ testOne }) => [`${shardName(1)}/${logName(testOne)}`]],
      ['the key in a docker.log', { files: inDockerLog(1, SECRETS.key) }, () => [`${shardName(1)}/${DOCKER_LOG_FILE_NAME}`]],
      ['the key in the runner log', { disk: inRunnerLog(SECRETS.key) }, () => [RUNNER_LOG_FILE_NAME]],
      ['the key in the status file', { disk: (run) => writeStatus(run.runDir, cleanStatus(), { kind: 'set-key', key: 'planted', value: SECRETS.key }) }, () => [STATUS_FILE_NAME]],
      ['the key in two files, both named in bytewise order', { files: inDockerLog(2, SECRETS.key), disk: inRunnerLog(SECRETS.key) }, () => [`${RUNNER_LOG_FILE_NAME}, ${shardName(2)}/${DOCKER_LOG_FILE_NAME}`]],
      ['GH_TOKEN in the runner log', { disk: inRunnerLog(SECRETS.ghToken) }, () => [RUNNER_LOG_FILE_NAME]],
      ['the base-build token in the runner log, on a run that looked it up', { disk: inRunnerLog(SECRETS.baseBuildToken) }, () => [RUNNER_LOG_FILE_NAME]],
      ['the key in a file under package/ other than the tarball', { disk: (run) => writeFileSync(join(run.runDir, PACKAGE_DIR_NAME, 'npm-pack.log'), `${SECRETS.key}\n`) }, () => [`${PACKAGE_DIR_NAME}/npm-pack.log`]],
      ['the key inside the tarball, which is not scanned', { disk: (run) => writeFileSync(run.inputs.tarballPath as string, `packed ${SECRETS.key}\n`) }, () => []],
      ['the base-build token in the runner log, on a run that did not look it up', { disk: inRunnerLog(SECRETS.baseBuildToken), inputs: (inputs) => ({ ...inputs, values: scannedSecretValues(SECRET_ENV) }) }, () => []],
      ['the base URL and model in the runner log, a docker.log and a script log', {
        files: { 1: (clean, { testOne }) => ({ ...clean, dockerLog: `${BASE_URL} ${MODEL}\n`, scriptLogs: { ...clean.scriptLogs, [testOne]: `${BASE_URL} ${MODEL}\n` } }) },
        disk: inRunnerLog(`${BASE_URL} ${MODEL}`),
      }, () => []],
      ['a symbolic link to a file outside the run directory that holds the key, which is not followed', {
        disk: (run) => {
          writeFileSync(join(root, 'outside-secret.txt'), `${SECRETS.key}\n`)
          symlinkSync(join(root, 'outside-secret.txt'), join(run.runDir, PACKAGE_DIR_NAME, 'link-out'))
        },
      }, () => []],
    ] as [string, RunChange, (scripts: RunScripts) => string[]][])('%s', (_what, change, paths) => {
      expectFailures(change, (scripts) => paths(scripts).map((detail) => integrityFailure('secret-scan', detail, null)))
    })

    test('an interrupted run is still scanned: with a run-level stop recorded and partial shard evidence, a planted key is found', () => {
      const { outcome } = entryWith({
        files: {
          2: (_clean, { testOne }) => ({
            shard: 2,
            canary: canaryOf(2),
            resultFile: { events: [startEvent(testOne)], partial: { event: endEvent(testOne, RESULT_WORD_PASS, SCRIPT_SECONDS) } },
            dockerLog: `stopped: ${SECRETS.key}\n`,
          }),
        },
        inputs: (inputs) => ({ ...withShard(inputs, 2, endedAbnormally), runState: { shardsScheduled: true, imageBuildFailed: false, stopTime: 'before-end-of-run' } }),
      })
      expect(outcome.skippedChecks).toEqual(['fault-fired'])
      expect(outcome.failures).toEqual([integrityFailure('secret-scan', `${shardName(2)}/${DOCKER_LOG_FILE_NAME}`, null)])
    })

    test('a value across a read boundary of a large file is found: one file per power-of-two boundary from 64 KiB to 4 MiB', () => {
      const paths: string[] = []
      const { outcome } = entryWith({
        disk: (run) => {
          for (let power = 16; power <= 22; power += 1) {
            const name = `large-${power}.bin`
            const before = Buffer.alloc(2 ** power - Math.floor(SECRETS.key.length / 2), 'x')
            writeFileSync(join(run.runDir, PACKAGE_DIR_NAME, name), Buffer.concat([before, Buffer.from(SECRETS.key), Buffer.alloc(16, 'x')]))
            paths.push(`${PACKAGE_DIR_NAME}/${name}`)
          }
        },
      })
      expect(outcome.failures).toEqual([integrityFailure('secret-scan', paths.join(', '), null)])
    })

    test('an entry named after a value never shows it: every line from the entry is masked, checks 1–11 included', () => {
      expectFailures({ files: { 1: (clean) => ({ ...clean, foreignFiles: { [SECRETS.key]: `${SECRETS.key}\n` } }) } }, () => [
        integrityFailure('results-ownership', `${shardName(1)} holds the file ${P}, which is not one of its files`, 1),
        integrityFailure('secret-scan', `${shardName(1)}/${P}`, null),
      ])
    })

    test.skipIf(!e11MkfifoAvailable())('a file the scan cannot read (a FIFO, named after a value) gives the not-readable failure, and its runner-log line is masked (skipped where mkfifo is missing)', () => {
      const { outcome } = entryWith({ disk: (run) => e11MakeFifo(join(run.runDir, PACKAGE_DIR_NAME, SECRETS.ghToken)) })
      expect(outcome.failures).toEqual([integrityFailure('secret-scan', `${PACKAGE_DIR_NAME}/${P} not readable`, null)])
      expect(outcome.logAdded).toContain(`${PACKAGE_DIR_NAME}/${P}`)
    })

    test('while the entry runs, no scanned file but the runner log changes', () => {
      const run = integrityRun({ files: { 1: (clean, { testOne }) => ({ ...clean, dockerLog: `${SECRETS.key}\n`, scriptLogs: { ...clean.scriptLogs, [testOne]: `${SECRETS.ghToken}\n` } }) } })
      run.inputs.log(`a line before the scan: ${SECRETS.baseBuildToken}`)
      const snapshot = (): string[] => e11TreeSnapshot(run.runDir, { extended: true }).filter((line) => !line.startsWith(`${RUNNER_LOG_FILE_NAME}:`))
      const before = snapshot()
      expect(runEntry(run.inputs).failures).toHaveLength(1)
      expect(snapshot()).toEqual(before)
    })
  })

  describe('the masked end files (b.uqm SR-15.3, SR-16.1; AC 68)', () => {
    /** A text holding every scanned value and the base URL and model. */
    const holding = (text: string): string => `${text}: ${SECRETS.key} ${SECRETS.ghToken} ${SECRETS.baseBuildToken} ${BASE_URL} ${MODEL}`
    /** That text as written: each value `<redacted>`, the base URL and model as they are. */
    const masked = (text: string): string => `${text}: ${P} ${P} ${P} ${BASE_URL} ${MODEL}`

    test('a results object, a summary and a verdict line holding the values are written with <redacted> in their place; the results file still parses', () => {
      const run = integrityRun()
      const results = (shown: (text: string) => string): Results =>
        makeResults(
          {
            runId: RUN_ID,
            pid: RUNNER_PID,
            verdict: shown('verdict'),
            invocation: { args: [shown('argument')], selective: false, faults: [] },
            failures: [{ line: shown('failure'), shard: null }],
            skippedChecks: [shown('skipped')],
            cleanupFailures: [shown('cleanup')],
            timingSummary: [shown('timing')],
          },
          run.runDir,
        )
      const redactor = createEndFileRedactor(run.inputs.values)
      const resultsPath = writeResults(run.runDir, redactor.results(results(holding)))
      expect(writeWholeFile(run.runDir, SUMMARY_FILE_NAME, redactor.summary(`${holding('summary')}\n`))).toEqual({ ok: true })
      expect(writeRedactedVerdictFile(run.runDir, holding('verdict'), run.inputs.values)).toEqual({ ok: true })

      expect(parseResults(readFileSync(resultsPath, 'utf-8'))).toEqual({ ok: true, value: results(masked) })
      expect(readFileSync(join(run.runDir, SUMMARY_FILE_NAME), 'utf-8')).toBe(`${masked('summary')}\n`)
      expect(readFileSync(join(run.runDir, VERDICT_FILE_NAME), 'utf-8')).toBe(`${masked('verdict')}\n`)
      e11AssertNoLeak(
        { results: e11WrittenFile(resultsPath), summary: e11WrittenFile(join(run.runDir, SUMMARY_FILE_NAME)), verdict: e11WrittenFile(join(run.runDir, VERDICT_FILE_NAME)) },
        'end files',
      )
    })

    test('the verdict writer replaces the verdict whole through a temporary file, masked, at WRITTEN_FILE_MODE, leaving no temporary file', () => {
      const run = integrityRun()
      const path = join(run.runDir, VERDICT_FILE_NAME)
      expect(writeRedactedVerdictFile(run.runDir, holding('first'), run.inputs.values)).toEqual({ ok: true })
      const first = statSync(path).ino
      expect(writeRedactedVerdictFile(run.runDir, holding('second'), run.inputs.values)).toEqual({ ok: true })
      expect(readFileSync(path, 'utf-8')).toBe(`${masked('second')}\n`)
      expect(statSync(path).ino).not.toBe(first)
      expect(statSync(path).mode & 0o777).toBe(WRITTEN_FILE_MODE)
      expect(existsSync(join(run.runDir, atomicTempFileName(VERDICT_FILE_NAME)))).toBe(false)
      e11AssertNoLeak(e11WrittenFile(path), 'verdict')
    })
  })

  describe('the runner log from the scan’s start (b.uqm SR-15.3; contributes to SR-5.4)', () => {
    test('lines written before the scan are left as they were; from its start every line is masked, child output through the spawn recorder included', async () => {
      const recorder = newRecorder(e11CreateFakeClock({ start: START_MS }))
      const run = integrityRun()
      const log = run.inputs.log
      const before = `a line before the scan: ${SECRETS.key}`
      log(before)
      expect(runEntry(run.inputs).logBefore.endsWith(`${before}\n`)).toBe(true)
      const mark = readFileSync(log.path, 'utf-8').length

      log(`a line: ${SECRETS.ghToken}`)
      log.childOutput(`child output: ${SECRETS.baseBuildToken}\n`)
      log.error(new Error(`an error: ${SECRETS.key}`))
      const argv = ['e11-child']
      recorder.answer(argv, { stdout: `stdout: ${SECRETS.key}\n`, stderr: `stderr: ${SECRETS.ghToken}\n` })
      await recorder.spawn({ argv, env: {}, cwd: root, ownProcessGroup: false, onOutputLine: (line) => log(line) }).result

      const added = readFileSync(log.path, 'utf-8').slice(mark)
      expect(added.split('\n').slice(0, 3)).toEqual([`a line: ${P}`, `child output: ${P}`, `error: Error: an error: ${P}`])
      expect(added.split('\n').slice(-3)).toEqual([`stdout: ${P}`, `stderr: ${P}`, ''])
      e11AssertNoLeak({ added }, 'runner log after the scan')
      expect(readFileSync(log.path, 'utf-8').slice(0, mark).endsWith(`${before}\n`)).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// E12: faults (b.t6s E12)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// E13: the run's end and the tests/runner.sh source audit (b.t6s E13)
// ---------------------------------------------------------------------------
