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

// ---------------------------------------------------------------------------
// E12: faults (b.t6s E12)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// E13: the run's end and the tests/runner.sh source audit (b.t6s E13)
// ---------------------------------------------------------------------------
