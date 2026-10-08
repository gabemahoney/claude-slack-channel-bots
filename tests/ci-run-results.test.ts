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
//
// The fault controller (b.uqm SR-14.1, SR-14.2, SR-14.3), run in process.
// Each case builds one controller with `faultRig`: the faults come from an
// invocation the runner's argument parser read, the assignment is E1's
// data-model value, every wait runs on `createFakeClock`, a recording handler
// keeps every notice, and the result files are real files in a run directory
// under the case's temp root. After each case the region checks every record
// and notice with `assertNoLeak` and that no fault poll is left pending.
// Reasons are compared through the runner's builders; each builder's text is
// typed once, in its pin case. Nothing here asserts the `fault-fired` line
// (E11) or a rendered cause (E10).

import {
  createFaultController,
  driftBuildFailedReason,
  FAULT_POLL_INTERVAL_MS,
  faultStoppedShardFirstReason,
  faultText,
  fileNameNumberForm,
  leakMountTarget,
  parseCiArguments,
  parseFault,
  retagBuildFailedReason,
  runStoppedFirstReason,
  SCRIPT_LOG_SUFFIX,
  shardEndedFirstReason,
  shardLimitReachedFirstReason,
  shardNeverStartedReason,
  shardStartedWithoutItReason,
  tagMoveFailedReason,
  type Assignment,
  type Fault,
  type FaultController,
  type FaultNotice,
  type FiringRecord,
  type FiringState,
  type ShardCause,
  type ShardMount,
  type ShardStart,
} from '../scripts/ci-run.ts'
import { resultFileText, type ResultFileSpec, type ShardDirSpec } from './test-helpers/ci-run.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'

/** One case's fault controller and everything it was built from. */
interface FaultRig {
  readonly controller: FaultController
  readonly clock: FakeClock
  readonly runDir: string
  /** The invocation's normalized faults, in order. */
  readonly faults: readonly Fault[]
  /** Every notice the handler was given, in order. */
  readonly notices: FaultNotice[]
}

/** The rigs the running case built, checked and dropped after it. */
let faultRigs: FaultRig[] = []

/** The pinned and drift image IDs the shard starts carry, and the retag image's ID, which differs from both (b.uqm SR-14.2). */
const FAULT_PINNED_IMAGE_ID = `sha256:${hexValue('fault-pinned', SHA256_HEX_LENGTH)}`
const FAULT_DRIFT_IMAGE_ID = `sha256:${hexValue('fault-drift', SHA256_HEX_LENGTH)}`
const FAULT_RETAG_IMAGE_ID = `sha256:${hexValue('fault-retag', SHA256_HEX_LENGTH)}`

/** A `kill:` firing's cause, and a `timeout:` firing's for m minutes (b.uqm SR-12.1, SR-14.2). */
const FAULT_KILLED_CAUSE: ShardCause = { kind: 'killed', fixedByRunner: true }
function faultWallTimeCause(minutes: number): ShardCause {
  return { kind: 'wall-time-limit', minutes, fixedByRunner: true }
}

/** Script n's number form, from its file name in the repository's listing. */
function faultNumberForm(n: number): string {
  return fileNameNumberForm(realScriptFileName(n)) as string
}

/**
 * A fault controller over `/ci --inject <each of inject>` and an assignment
 * of shards 1, 2, … holding the looked-up scripts numbered in `shards`, in
 * order. Its run directory is new, under the case's temp root; no shard
 * subdirectory exists until a result file is written.
 */
function faultRig(spec: { readonly inject?: readonly string[]; readonly shards: readonly (readonly number[])[] }): FaultRig {
  const parsed = parseCiArguments((spec.inject ?? []).flatMap((value) => ['--inject', value]))
  if (!parsed.ok) throw new Error(`faultRig: ${parsed.failures.map((failure) => failure.reason).join('; ')}`)
  const assignment: Assignment = spec.shards.map((numbers, index) => ({
    shard: index + 1,
    assigned: numbers.map((n) => realScriptFileName(n)),
    expectedSeconds: 60 * numbers.length,
    limitMinutes: 30,
  }))
  const runDir = makeRunDir(mkdtempSync(join(root, 'faults-')), RUN_ID)
  const clock = createFakeClock()
  const notices: FaultNotice[] = []
  const faults = parsed.invocation.faults
  const controller = createFaultController({ faults, assignment, clock, runDir, handler: (notice) => notices.push(notice) })
  const rig = { controller, clock, runDir, faults, notices }
  faultRigs.push(rig)
  return rig
}

/** The rig's i-th normalized fault. */
function faultAt(rig: FaultRig, index: number): Fault {
  const fault = rig.faults[index]
  if (fault === undefined) throw new Error(`faultAt: the rig has no fault ${index}`)
  return fault
}

function faultShardDir(rig: FaultRig, shard: number): string {
  return join(rig.runDir, `${SHARD_DIR_PREFIX}${shard}`)
}

/** Writes shard k's result file: the first write builds its subdirectory with the run-directory builder (with any other files given), a later one replaces the file with the builder's text. */
function writeFaultResult(
  rig: FaultRig,
  shard: number,
  resultFile: readonly ResultEvent[] | ResultFileSpec,
  files: Omit<ShardDirSpec, 'shard' | 'resultFile'> = {},
): void {
  const shardDir = faultShardDir(rig, shard)
  if (!existsSync(shardDir)) {
    writeShardDir(rig.runDir, { ...files, shard, resultFile })
    return
  }
  if (Object.keys(files).length > 0) throw new Error('writeFaultResult: other files are written only with the first result file')
  writeFileSync(join(shardDir, RESULT_FILE_NAME), resultFileText('events' in resultFile ? resultFile : { events: resultFile }))
}

/** Shard k's container started, at the clock's time unless given; from the pinned image with no mount unless given. */
function faultShardStart(
  rig: FaultRig,
  shard: number,
  options: { readonly imageId?: string; readonly mounts?: readonly ShardMount[]; readonly startedAtMs?: number } = {},
): ShardStart {
  return {
    kind: 'started',
    shard,
    imageId: options.imageId ?? FAULT_PINNED_IMAGE_ID,
    mounts: options.mounts ?? [],
    nameInUse: false,
    canary: hexValue(`fault-canary-${shard}`, CANARY_LENGTH),
    startedAtMs: options.startedAtMs ?? rig.clock.now(),
  }
}

/** Shard k's container did not start. */
function faultShardFailedStart(shard: number): ShardStart {
  return {
    kind: 'failed-to-start',
    shard,
    imageId: FAULT_PINNED_IMAGE_ID,
    mounts: [],
    nameInUse: false,
    canary: hexValue(`fault-canary-${shard}`, CANARY_LENGTH),
    detail: 'the shard container did not start',
  }
}

/** Reports each shard started now. */
function startFaultShards(rig: FaultRig, ...shards: number[]): void {
  for (const shard of shards) rig.controller.noteShardStart(faultShardStart(rig, shard))
}

/** A `leak:1,<j>` mount: shard 1's subdirectory, read-only, at its leak target, with any field changed. */
function shardOneLeakMount(rig: FaultRig, change: Partial<ShardMount> = {}): ShardMount {
  return { source: faultShardDir(rig, 1), target: leakMountTarget(1), readOnly: true, ...change }
}

/** A decision notice for a `timeout:` or `kill:` fault. */
function faultDecisionNotice(shard: number, fault: Fault, cause: ShardCause): FaultNotice {
  if (fault.kind !== 'timeout' && fault.kind !== 'kill') throw new Error(`faultDecisionNotice: ${faultText(fault)} is handed no decision`)
  return { kind: 'decision', decision: { shard, fault, cause } }
}

/** A record as most cases compare it: its fault's normalized text, its state and its reason. */
interface FaultOutcome {
  readonly fault: string
  readonly state: FiringState
  readonly reason: string | null
}

function faultOutcomes(records: readonly FiringRecord[]): FaultOutcome[] {
  return records.map((record) => ({ fault: faultText(record.fault), state: record.state, reason: record.reason }))
}

function dueFaultOutcome(fault: Fault): FaultOutcome {
  return { fault: faultText(fault), state: 'due', reason: null }
}

function firedFaultOutcome(fault: Fault): FaultOutcome {
  return { fault: faultText(fault), state: 'fired', reason: null }
}

function notFiredFaultOutcome(fault: Fault, reason: string): FaultOutcome {
  return { fault: faultText(fault), state: 'not-fired', reason }
}

describe('E12: faults (b.t6s E12; b.uqm SR-14.1, SR-14.2, SR-14.3)', () => {
  afterEach(() => {
    const rigs = faultRigs
    faultRigs = []
    for (const rig of rigs) {
      assertNoLeak({ records: rig.controller.records(), notices: rig.notices }, 'fault controller')
      expect(rig.clock.pending()).toEqual([])
    }
  })

  describe('activation, target shards and --fail lists (SR-14.1, SR-14.2)', () => {
    test('with no --inject: no record, no --fail entry, no poll timer and no notice, though a fault-like variable and fault-like files are present', async () => {
      const names = ['INJECT', 'KILL'] as const
      const saved = names.map((name) => process.env[name])
      process.env.INJECT = 'kill:1'
      process.env.KILL = '1'
      try {
        const rig = faultRig({ shards: [[1, 2], [1, 3]] })
        const [first] = scripts()
        for (const shard of [1, 2]) {
          writeFaultResult(rig, shard, [startEvent(first)], { foreignFiles: { [`fail:${faultNumberForm(1)}`]: '', retag: '' } })
        }
        writeFileSync(join(rig.runDir, 'kill:1'), '')
        startFaultShards(rig, 1, 2)
        await rig.clock.advance(3 * FAULT_POLL_INTERVAL_MS)
        expect(rig.controller.records()).toEqual([])
        expect([1, 2].map((shard) => rig.controller.failFileNames(shard))).toEqual([[], []])
        expect(rig.clock.pending()).toEqual([])
        expect(rig.clock.firedCount()).toBe(0)
        expect(rig.notices).toEqual([])
      } finally {
        names.forEach((name, index) => {
          const value = saved[index]
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        })
      }
    })

    // Shards: 1 holds test-1 and test-2, 2 holds test-1 and test-3, 3 holds test-1 and test-4.
    test.each([
      ['fail: on test-1, in every shard', 1, null, () => `fail:${faultNumberForm(1)}`],
      ['timeout: on test-1, in every shard', 1, null, () => `timeout:${faultNumberForm(1)}`],
      ['fail: on test-3, given by file name', 2, null, () => `fail:${realScriptFileName(3)}`],
      ['timeout: on test-4', 3, null, () => `timeout:${faultNumberForm(4)}`],
      ['leak:3,2', 2, 3, () => 'leak:3,2'],
      ['image-drift:3', 3, null, () => 'image-drift:3'],
      ['kill:2', 2, null, () => 'kill:2'],
      ['retag', null, null, () => 'retag'],
      ['fail: on a script the assignment does not place', null, null, () => `fail:${faultNumberForm(5)}`],
    ] as [string, number | null, number | null, () => string][])('%s starts due and acts on shard %p (source shard %p)', (_what, shard, leakSourceShard, inject) => {
      const rig = faultRig({ inject: [inject()], shards: [[1, 2], [1, 3], [1, 4]] })
      expect(rig.controller.records()).toEqual([{ fault: faultAt(rig, 0), shard, leakSourceShard, state: 'due', reason: null }])
    })

    test('each shard’s --fail list is exactly the file names of the fail: faults acting on it, in normalized order; no other fault adds one', () => {
      const rig = faultRig({
        inject: [
          `fail:${faultNumberForm(5)}`,
          `timeout:${faultNumberForm(4)}`,
          `fail:${realScriptFileName(2)}`,
          'kill:2',
          `fail:${faultNumberForm(3)}`,
          'leak:3,2',
          'image-drift:1',
          'retag',
          `fail:${faultNumberForm(1)}`,
        ],
        shards: [[1, 2, 5], [1, 3], [1, 4]],
      })
      expect([1, 2, 3, 4].map((shard) => rig.controller.failFileNames(shard))).toEqual([
        [realScriptFileName(5), realScriptFileName(2), realScriptFileName(1)],
        [realScriptFileName(3)],
        [],
        [],
      ])
    })
  })

  describe('fail: firing and the result lines read back (SR-14.2, SR-11.3)', () => {
    test('the injected script’s start, end … fail 0.000 and injected-failure log are read back, and finalization records the fail: fired', () => {
      const rig = faultRig({ inject: [`fail:${faultNumberForm(2)}`], shards: [[1, 2, 3]] })
      const [first, second, third] = scripts()
      const events = [startEvent(first), endEvent(first, RESULT_WORD_PASS, 1.5), startEvent(second), endEvent(second, RESULT_WORD_FAIL, 0), notRunEvent(third), DONE_EVENT]
      startFaultShards(rig, 1)
      writeFaultResult(rig, 1, events, { scriptLogs: { [second]: `${injectedFailureLine(second)}\n` } })
      rig.controller.noteShardEnded(1)
      expect(readResultFile(faultShardDir(rig, 1))).toEqual({ kind: 'events', events })
      expect(readFileText(join(faultShardDir(rig, 1), `${second}${SCRIPT_LOG_SUFFIX}`))).toEqual({ kind: 'text', text: `${injectedFailureLine(second)}\n` })
      expect(faultOutcomes(rig.controller.finalize())).toEqual([firedFaultOutcome(faultAt(rig, 0))])
    })

    test('a start line still being written, with no final line feed, does not fire the fail:', () => {
      const rig = faultRig({ inject: [`fail:${faultNumberForm(2)}`], shards: [[1, 2]] })
      const [first, second] = scripts()
      startFaultShards(rig, 1)
      writeFaultResult(rig, 1, { events: [startEvent(first), endEvent(first, RESULT_WORD_PASS, 1)], partial: { event: startEvent(second) } })
      expect(rig.controller.finalize().map((record) => record.state)).toEqual(['not-fired'])
    })

    test.each([
      [1, 'fired'],
      [2, 'not-fired'],
    ] as [number, FiringState][])('fail:test-1 with its start line in shard %p only is %p: it is read from shard 1 alone', (shardWithLine, state) => {
      const rig = faultRig({ inject: [`fail:${faultNumberForm(1)}`], shards: [[1, 2], [1, 3]] })
      startFaultShards(rig, 1, 2)
      writeFaultResult(rig, shardWithLine, [startEvent(scripts()[0])])
      expect(rig.controller.finalize().map((record) => record.state)).toEqual([state])
    })

    test('a second finalization leaves the record as the first left it, though the start line was written since', () => {
      const rig = faultRig({ inject: [`fail:${faultNumberForm(1)}`], shards: [[1, 2]] })
      const [first] = scripts()
      startFaultShards(rig, 1)
      writeFaultResult(rig, 1, { events: [], partial: { event: startEvent(first) } })
      const before = rig.controller.finalize()
      writeFaultResult(rig, 1, [startEvent(first)])
      expect(rig.controller.finalize()).toEqual(before)
      expect(before.map((record) => record.state)).toEqual(['not-fired'])
    })
  })

  describe('timeout: and kill: decisions, and the fault polls (SR-14.2)', () => {
    test.each([
      ['timeout:test-1', () => `timeout:${faultNumberForm(1)}`, faultWallTimeCause(1)],
      ['kill:1', () => 'kill:1', FAULT_KILLED_CAUSE],
    ] as [string, () => string, ShardCause][])('AC 51: with test-1 in progress 3 s after shard 1’s container start, %s hands one decision for shard 1 with its cause', async (_what, inject, cause) => {
      const rig = faultRig({ inject: [inject()], shards: [[1, 2]] })
      startFaultShards(rig, 1)
      await rig.clock.advanceTo(3_000 - FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([])
      writeFaultResult(rig, 1, [startEvent(scripts()[0])])
      await rig.clock.advanceTo(3_000)
      expect(rig.clock.now()).toBe(3_000)
      expect(rig.notices).toEqual([faultDecisionNotice(1, faultAt(rig, 0), cause)])
      expect(rig.clock.pending()).toEqual([])
    })

    // The container started `startedBeforeMs` before clock time 0. Its start is reported at `60_000 % FAULT_POLL_INTERVAL_MS`,
    // so whatever the interval, a poll comes at clock time 60 000, `startedBeforeMs` past a whole minute of the container's run.
    test.each([
      ['exactly 1 min', 1, 0],
      ['1 min and 1 ms', 2, 1],
    ])('a timeout: on a script after test-1 waits out test-1 and fires at the first poll that sees it in progress; at %s it names m = %p', async (_what, minutes, startedBeforeMs) => {
      const rig = faultRig({ inject: [`timeout:${faultNumberForm(23)}`], shards: [[1, 23]] })
      const [first] = scripts()
      const later = realScriptFileName(23)
      const startedAtMs = rig.clock.now() - startedBeforeMs
      await rig.clock.advanceTo(60_000 % FAULT_POLL_INTERVAL_MS)
      rig.controller.noteShardStart(faultShardStart(rig, 1, { startedAtMs }))
      writeFaultResult(rig, 1, [startEvent(first)])
      await rig.clock.advanceTo(60_000 - FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([])
      writeFaultResult(rig, 1, [startEvent(first), endEvent(first, RESULT_WORD_PASS, 58), startEvent(later)])
      await rig.clock.advanceTo(60_000)
      expect(rig.clock.now() - startedAtMs).toBe(60_000 + startedBeforeMs)
      expect(rig.notices).toEqual([faultDecisionNotice(1, faultAt(rig, 0), faultWallTimeCause(minutes))])
    })

    test('kill:2 fires at the first poll that sees any script in progress in shard 2; progress in shard 1, which it never reads, fires nothing', async () => {
      const rig = faultRig({ inject: ['kill:2'], shards: [[1, 2], [1, 3]] })
      const [first] = scripts()
      startFaultShards(rig, 1, 2)
      expect(rig.clock.pendingCount()).toBe(1)
      writeFaultResult(rig, 1, [startEvent(first)])
      writeFaultResult(rig, 2, [])
      await rig.clock.advance(3 * FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([])
      writeFaultResult(rig, 2, [startEvent(first)])
      await rig.clock.advance(FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([faultDecisionNotice(2, faultAt(rig, 0), FAULT_KILLED_CAUSE)])
    })

    test('a decision is handed at most once, and none for a shard a firing already stopped', async () => {
      const rig = faultRig({ inject: [`timeout:${faultNumberForm(1)}`, `timeout:${faultNumberForm(2)}`], shards: [[1, 2]] })
      const [first, second] = scripts()
      startFaultShards(rig, 1)
      writeFaultResult(rig, 1, [startEvent(first)])
      await rig.clock.advance(3 * FAULT_POLL_INTERVAL_MS)
      writeFaultResult(rig, 1, [startEvent(first), endEvent(first, RESULT_WORD_PASS, 3), startEvent(second)])
      await rig.clock.advance(3 * FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([faultDecisionNotice(1, faultAt(rig, 0), faultWallTimeCause(1))])
      rig.controller.finalize()
    })

    test.each([
      ['a start line still being written', (): ResultFileSpec | null => ({ events: [], partial: { event: startEvent(scripts()[0]) } })],
      ['a missing result file', (): ResultFileSpec | null => null],
      ['an unreadable result file', (): ResultFileSpec | null => ({ events: [startEvent(scripts()[0])], malformed: { at: 0, change: 'carriage-return' } })],
    ])('%s fires nothing and polling goes on', async (_what, resultFile) => {
      const rig = faultRig({ inject: ['kill:1'], shards: [[1, 2]] })
      startFaultShards(rig, 1)
      const spec = resultFile()
      if (spec !== null) writeFaultResult(rig, 1, spec)
      await rig.clock.advance(3 * FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([])
      expect(rig.clock.pendingCount()).toBe(1)
      writeFaultResult(rig, 1, [startEvent(scripts()[0])])
      await rig.clock.advance(FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([faultDecisionNotice(1, faultAt(rig, 0), FAULT_KILLED_CAUSE)])
    })

    test('a poll timer, one interval out, is pending only for a started shard with a due timeout: or kill: aimed at it', async () => {
      const rig = faultRig({ inject: ['kill:1', 'kill:2'], shards: [[1], [1, 2], [1, 3]] })
      expect(rig.clock.pending()).toEqual([])
      rig.controller.noteShardStart(faultShardStart(rig, 3))
      rig.controller.noteShardStart(faultShardFailedStart(2))
      expect(rig.clock.pending()).toEqual([])
      startFaultShards(rig, 1)
      expect(rig.clock.pending()).toEqual([{ id: expect.any(Number), delayMs: FAULT_POLL_INTERVAL_MS, scheduledAt: 0, dueAt: FAULT_POLL_INTERVAL_MS }])
      await rig.clock.advance(FAULT_POLL_INTERVAL_MS)
      expect(rig.clock.pending()).toEqual([
        { id: expect.any(Number), delayMs: FAULT_POLL_INTERVAL_MS, scheduledAt: FAULT_POLL_INTERVAL_MS, dueAt: 2 * FAULT_POLL_INTERVAL_MS },
      ])
      rig.controller.finalize()
    })

    test('a poll that finds the end marker hands one end-marker notice, exactly once, and polling stops', async () => {
      const rig = faultRig({ inject: ['kill:1'], shards: [[1, 2]] })
      const [first, second] = scripts()
      startFaultShards(rig, 1)
      writeFaultResult(rig, 1, [startEvent(first), endEvent(first, RESULT_WORD_PASS, 0.5), startEvent(second), endEvent(second, RESULT_WORD_PASS, 0.25), DONE_EVENT])
      await rig.clock.advance(FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([{ kind: 'end-marker', shard: 1 }])
      expect(rig.clock.pending()).toEqual([])
      await rig.clock.advance(3 * FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toHaveLength(1)
    })

    test.each([
      ['a reported end of shard 1', (controller: FaultController) => controller.noteShardEnded(1), 1],
      ['shard 1 reaching its limit', (controller: FaultController) => controller.noteShardLimit(1), 1],
      ['a run-level stop, which leaves no timer', (controller: FaultController) => controller.noteRunStop(), 0],
    ] as [string, (controller: FaultController) => void, number][])('polling of shard 1 stops at %s', async (_what, stop, pendingAfter) => {
      const rig = faultRig({ inject: ['kill:1', 'kill:2'], shards: [[1, 2], [1, 3]] })
      startFaultShards(rig, 1, 2)
      expect(rig.clock.pendingCount()).toBe(2)
      stop(rig.controller)
      expect(rig.clock.pendingCount()).toBe(pendingAfter)
      writeFaultResult(rig, 1, [startEvent(scripts()[0])])
      await rig.clock.advance(3 * FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([])
      rig.controller.finalize()
    })

    test.each([
      ['fail:', () => [`fail:${faultNumberForm(1)}`]],
      ['leak', () => ['leak:2,1']],
      ['image-drift', () => ['image-drift:1']],
      ['retag', () => ['retag']],
      ['all four', () => [`fail:${faultNumberForm(1)}`, 'leak:2,1', 'image-drift:1', 'retag']],
    ])('a run whose only faults are %s never sets a poll timer', async (_what, inject) => {
      const rig = faultRig({ inject: inject(), shards: [[1, 2], [1, 3]] })
      for (const shard of [1, 2]) writeFaultResult(rig, shard, [startEvent(scripts()[0])])
      startFaultShards(rig, 1, 2)
      await rig.clock.advance(3 * FAULT_POLL_INTERVAL_MS)
      expect(rig.clock.firedCount()).toBe(0)
      expect(rig.clock.pending()).toEqual([])
      expect(rig.notices).toEqual([])
      rig.controller.finalize()
    })
  })

  describe('leak, image-drift and retag records (SR-14.2, SR-14.3)', () => {
    test('a leak mount’s target is /leak-shard-<k>', () => {
      expect(leakMountTarget(3)).toBe('/leak-shard-3')
    })

    interface FaultEventRow {
      readonly label: string
      readonly inject: string
      readonly act: (rig: FaultRig) => void
      readonly expected: (fault: Fault) => FaultOutcome
    }
    // Shards: 1 holds test-1 and test-2, 2 holds test-1 and test-3.
    const start = (rig: FaultRig, shard: number, options: Parameters<typeof faultShardStart>[2] = {}): void => rig.controller.noteShardStart(faultShardStart(rig, shard, options))
    const ROWS: FaultEventRow[] = [
      { label: 'leak:1,2: shard 2 starts with shard 1’s subdirectory read-only at /leak-shard-1', inject: 'leak:1,2', act: (rig) => start(rig, 2, { mounts: [shardOneLeakMount(rig)] }), expected: firedFaultOutcome },
      {
        label: 'leak:1,2: the mount’s source is spelled another way that resolves to shard 1’s subdirectory',
        inject: 'leak:1,2',
        act: (rig) => start(rig, 2, { mounts: [shardOneLeakMount(rig, { source: `${faultShardDir(rig, 2)}/../${SHARD_DIR_PREFIX}1/` })] }),
        expected: firedFaultOutcome,
      },
      { label: 'leak:1,2: the mount is read-write', inject: 'leak:1,2', act: (rig) => start(rig, 2, { mounts: [shardOneLeakMount(rig, { readOnly: false })] }), expected: (fault) => notFiredFaultOutcome(fault, shardStartedWithoutItReason(2)) },
      { label: 'leak:1,2: the mount is at another target', inject: 'leak:1,2', act: (rig) => start(rig, 2, { mounts: [shardOneLeakMount(rig, { target: leakMountTarget(2) })] }), expected: (fault) => notFiredFaultOutcome(fault, shardStartedWithoutItReason(2)) },
      { label: 'leak:1,2: the mount’s source is shard 2’s own subdirectory', inject: 'leak:1,2', act: (rig) => start(rig, 2, { mounts: [shardOneLeakMount(rig, { source: faultShardDir(rig, 2) })] }), expected: (fault) => notFiredFaultOutcome(fault, shardStartedWithoutItReason(2)) },
      { label: 'leak:1,2: shard 2 starts with no mount', inject: 'leak:1,2', act: (rig) => start(rig, 2), expected: (fault) => notFiredFaultOutcome(fault, shardStartedWithoutItReason(2)) },
      { label: 'leak:1,2: shard 2 fails to start', inject: 'leak:1,2', act: (rig) => rig.controller.noteShardStart(faultShardFailedStart(2)), expected: (fault) => notFiredFaultOutcome(fault, shardNeverStartedReason(2)) },
      { label: 'leak:1,2: only shard 1 starts, carrying the mount', inject: 'leak:1,2', act: (rig) => start(rig, 1, { mounts: [shardOneLeakMount(rig)] }), expected: dueFaultOutcome },
      {
        label: 'image-drift:2: shard 2 starts from the drift image',
        inject: 'image-drift:2',
        act: (rig) => {
          rig.controller.noteDriftBuild({ kind: 'built', imageId: FAULT_DRIFT_IMAGE_ID })
          start(rig, 2, { imageId: FAULT_DRIFT_IMAGE_ID })
        },
        expected: firedFaultOutcome,
      },
      {
        label: 'image-drift:2: the drift image is built and shard 2 starts from the pinned ID',
        inject: 'image-drift:2',
        act: (rig) => {
          rig.controller.noteDriftBuild({ kind: 'built', imageId: FAULT_DRIFT_IMAGE_ID })
          start(rig, 2)
        },
        expected: (fault) => notFiredFaultOutcome(fault, shardStartedWithoutItReason(2)),
      },
      { label: 'image-drift:2: no drift build is reported and shard 2 starts from the pinned ID', inject: 'image-drift:2', act: (rig) => start(rig, 2), expected: (fault) => notFiredFaultOutcome(fault, shardStartedWithoutItReason(2)) },
      {
        label: 'image-drift:2: the drift build fails, then shard 2 starts from the pinned ID',
        inject: 'image-drift:2',
        act: (rig) => {
          rig.controller.noteDriftBuild({ kind: 'failed', exitCode: 7 })
          start(rig, 2)
        },
        expected: (fault) => notFiredFaultOutcome(fault, driftBuildFailedReason(7)),
      },
      {
        label: 'image-drift:2: the drift image is built and shard 2 fails to start',
        inject: 'image-drift:2',
        act: (rig) => {
          rig.controller.noteDriftBuild({ kind: 'built', imageId: FAULT_DRIFT_IMAGE_ID })
          rig.controller.noteShardStart(faultShardFailedStart(2))
        },
        expected: (fault) => notFiredFaultOutcome(fault, shardNeverStartedReason(2)),
      },
      {
        label: 'image-drift:2: only shard 1 starts, from the drift image',
        inject: 'image-drift:2',
        act: (rig) => {
          rig.controller.noteDriftBuild({ kind: 'built', imageId: FAULT_DRIFT_IMAGE_ID })
          start(rig, 1, { imageId: FAULT_DRIFT_IMAGE_ID })
        },
        expected: dueFaultOutcome,
      },
      {
        label: 'retag: the -test tag is moved',
        inject: 'retag',
        act: (rig) => {
          rig.controller.noteRetagBuild({ kind: 'built', imageId: FAULT_RETAG_IMAGE_ID })
          rig.controller.noteTagMove({ kind: 'moved' })
        },
        expected: firedFaultOutcome,
      },
      { label: 'retag: the retag build fails', inject: 'retag', act: (rig) => rig.controller.noteRetagBuild({ kind: 'failed', exitCode: 5 }), expected: (fault) => notFiredFaultOutcome(fault, retagBuildFailedReason(5)) },
      {
        label: 'retag: the retag image is built and the tag move fails',
        inject: 'retag',
        act: (rig) => {
          rig.controller.noteRetagBuild({ kind: 'built', imageId: FAULT_RETAG_IMAGE_ID })
          rig.controller.noteTagMove({ kind: 'failed', exitCode: 6 })
        },
        expected: (fault) => notFiredFaultOutcome(fault, tagMoveFailedReason(6)),
      },
      {
        label: 'retag: the retag image is built and no tag move is tried',
        inject: 'retag',
        act: (rig) => {
          rig.controller.noteRetagBuild({ kind: 'built', imageId: FAULT_RETAG_IMAGE_ID })
          rig.controller.noteTagMove({ kind: 'not-tried' })
        },
        expected: dueFaultOutcome,
      },
    ]
    test.each(ROWS)('$label', ({ inject, act, expected }) => {
      const rig = faultRig({ inject: [inject], shards: [[1, 2], [1, 3]] })
      act(rig)
      expect(faultOutcomes(rig.controller.records())).toEqual([expected(faultAt(rig, 0))])
    })

    test('a terminal record never changes, and one fault’s outcome leaves the others’ records as they were', () => {
      const rig = faultRig({ inject: ['leak:1,2', 'image-drift:2', 'retag'], shards: [[1, 2], [1, 3]] })
      const [leak, drift, retag] = [faultAt(rig, 0), faultAt(rig, 1), faultAt(rig, 2)]
      const outcomes = (): FaultOutcome[] => faultOutcomes(rig.controller.records())

      rig.controller.noteDriftBuild({ kind: 'built', imageId: FAULT_DRIFT_IMAGE_ID })
      start(rig, 2, { imageId: FAULT_DRIFT_IMAGE_ID })
      const afterStart = [notFiredFaultOutcome(leak, shardStartedWithoutItReason(2)), firedFaultOutcome(drift), dueFaultOutcome(retag)]
      expect(outcomes()).toEqual(afterStart)

      rig.controller.noteDriftBuild({ kind: 'failed', exitCode: 7 })
      start(rig, 2, { mounts: [shardOneLeakMount(rig)] })
      rig.controller.noteRetagBuild({ kind: 'built', imageId: FAULT_RETAG_IMAGE_ID })
      expect(outcomes()).toEqual(afterStart)

      rig.controller.noteTagMove({ kind: 'moved' })
      const afterMove = [notFiredFaultOutcome(leak, shardStartedWithoutItReason(2)), firedFaultOutcome(drift), firedFaultOutcome(retag)]
      expect(outcomes()).toEqual(afterMove)

      rig.controller.noteTagMove({ kind: 'failed', exitCode: 3 })
      rig.controller.noteRetagBuild({ kind: 'failed', exitCode: 4 })
      rig.controller.noteRunStop()
      expect(faultOutcomes(rig.controller.finalize())).toEqual(afterMove)
    })
  })

  describe('faults that never fire: reasons, ties, finalization and the reason texts (SR-14.3)', () => {
    test('AC 55: kill:1 when shard 1 writes its end marker before any script is seen in progress gives shard-1 ended first', async () => {
      const rig = faultRig({ inject: ['kill:1'], shards: [[1, 2]] })
      const [first, second] = scripts()
      startFaultShards(rig, 1)
      writeFaultResult(rig, 1, [startEvent(first), endEvent(first, RESULT_WORD_PASS, 0.5), startEvent(second), endEvent(second, RESULT_WORD_PASS, 0.25), DONE_EVENT])
      await rig.clock.advance(FAULT_POLL_INTERVAL_MS)
      expect(faultOutcomes(rig.controller.finalize())).toEqual([notFiredFaultOutcome(faultAt(rig, 0), shardEndedFirstReason(1))])
    })

    test('AC 55: fail: on a script left notrun because an earlier script failed gives shard-1 ended first', () => {
      const rig = faultRig({ inject: [`fail:${faultNumberForm(3)}`], shards: [[1, 2, 3]] })
      const [first, second, third] = scripts()
      startFaultShards(rig, 1)
      writeFaultResult(rig, 1, [startEvent(first), endEvent(first, RESULT_WORD_PASS, 1), startEvent(second), endEvent(second, RESULT_WORD_FAIL, 2), notRunEvent(third), DONE_EVENT])
      rig.controller.noteShardEnded(1)
      expect(faultOutcomes(rig.controller.finalize())).toEqual([notFiredFaultOutcome(faultAt(rig, 0), shardEndedFirstReason(1))])
    })

    test('AC 51: kill:2 fires while test-1 runs, so a timeout: on a later shard-2 script is stopped by it; a timeout: on shard 1 still fires', async () => {
      const rig = faultRig({ inject: ['kill:2', `timeout:${faultNumberForm(23)}`, `timeout:${faultNumberForm(2)}`], shards: [[1, 2], [1, 23]] })
      const [kill, laterTimeout, otherTimeout] = [faultAt(rig, 0), faultAt(rig, 1), faultAt(rig, 2)]
      const [first, second] = scripts()
      startFaultShards(rig, 1, 2)
      writeFaultResult(rig, 1, [startEvent(first), endEvent(first, RESULT_WORD_PASS, 0.5), startEvent(second)])
      writeFaultResult(rig, 2, [startEvent(first)])
      await rig.clock.advance(FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([faultDecisionNotice(1, otherTimeout, faultWallTimeCause(1)), faultDecisionNotice(2, kill, FAULT_KILLED_CAUSE)])
      expect(faultOutcomes(rig.controller.finalize())).toEqual([
        firedFaultOutcome(kill),
        notFiredFaultOutcome(laterTimeout, faultStoppedShardFirstReason(kill, 2)),
        firedFaultOutcome(otherTimeout),
      ])
    })

    test.each([
      ['kill:1 given first', () => ['kill:1', `timeout:${faultNumberForm(1)}`]],
      ['timeout:test-1 given first', () => [`timeout:${faultNumberForm(1)}`, 'kill:1']],
    ])('a tie of timeout:test-1 and kill:1 (%s): only kill:1 is handed, and timeout:test-1 names it', async (_what, inject) => {
      const rig = faultRig({ inject: inject(), shards: [[1, 2]] })
      const kill = rig.faults.find((fault) => fault.kind === 'kill') as Fault
      startFaultShards(rig, 1)
      writeFaultResult(rig, 1, [startEvent(scripts()[0])])
      await rig.clock.advance(FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([faultDecisionNotice(1, kill, FAULT_KILLED_CAUSE)])
      expect(faultOutcomes(rig.controller.finalize())).toEqual(
        rig.faults.map((fault) => (fault === kill ? firedFaultOutcome(fault) : notFiredFaultOutcome(fault, faultStoppedShardFirstReason(kill, 1)))),
      )
    })

    // Shard 1 holds test-1, test-2 and test-3; its whole result file is written before the first poll.
    test.each([
      [
        'a fired fail:test-2 is named by a timeout: on test-3, after it',
        () => [`fail:${faultNumberForm(2)}`, `timeout:${faultNumberForm(3)}`],
        (): ResultEvent[] => {
          const [first, second, third] = scripts()
          return [startEvent(first), endEvent(first, RESULT_WORD_PASS, 1), startEvent(second), endEvent(second, RESULT_WORD_FAIL, 0), notRunEvent(third), DONE_EVENT]
        },
        (rig: FaultRig) => [firedFaultOutcome(faultAt(rig, 0)), notFiredFaultOutcome(faultAt(rig, 1), faultStoppedShardFirstReason(faultAt(rig, 0), 1))],
      ],
      [
        'a fired fail:test-1 is named by kill:1',
        () => ['kill:1', `fail:${faultNumberForm(1)}`],
        (): ResultEvent[] => {
          const [first, second, third] = scripts()
          return [startEvent(first), endEvent(first, RESULT_WORD_FAIL, 0), notRunEvent(second), notRunEvent(third), DONE_EVENT]
        },
        (rig: FaultRig) => [notFiredFaultOutcome(faultAt(rig, 0), faultStoppedShardFirstReason(faultAt(rig, 1), 1)), firedFaultOutcome(faultAt(rig, 1))],
      ],
      [
        'a timeout: on test-2, which ended before the fail:test-3 script, gives shard-1 ended first',
        () => [`timeout:${faultNumberForm(2)}`, `fail:${faultNumberForm(3)}`],
        (): ResultEvent[] => {
          const [first, second, third] = scripts()
          return [startEvent(first), endEvent(first, RESULT_WORD_PASS, 1), startEvent(second), endEvent(second, RESULT_WORD_PASS, 1), startEvent(third), endEvent(third, RESULT_WORD_FAIL, 0), DONE_EVENT]
        },
        (rig: FaultRig) => [notFiredFaultOutcome(faultAt(rig, 0), shardEndedFirstReason(1)), firedFaultOutcome(faultAt(rig, 1))],
      ],
    ] as [string, () => string[], () => ResultEvent[], (rig: FaultRig) => FaultOutcome[]][])('%s', async (_what, inject, events, expected) => {
      const rig = faultRig({ inject: inject(), shards: [[1, 2, 3]] })
      startFaultShards(rig, 1)
      writeFaultResult(rig, 1, events())
      await rig.clock.advance(FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([{ kind: 'end-marker', shard: 1 }])
      expect(faultOutcomes(rig.controller.finalize())).toEqual(expected(rig))
    })

    test('a timeout: that stops shard 1 before the fail: script is reached is named by the fail:', async () => {
      const rig = faultRig({ inject: [`timeout:${faultNumberForm(2)}`, `fail:${faultNumberForm(3)}`], shards: [[1, 2, 3]] })
      const [timeout, fail] = [faultAt(rig, 0), faultAt(rig, 1)]
      const [first, second] = scripts()
      startFaultShards(rig, 1)
      writeFaultResult(rig, 1, [startEvent(first), endEvent(first, RESULT_WORD_PASS, 0.5), startEvent(second)])
      await rig.clock.advance(FAULT_POLL_INTERVAL_MS)
      expect(rig.notices).toEqual([faultDecisionNotice(1, timeout, faultWallTimeCause(1))])
      expect(faultOutcomes(rig.controller.finalize())).toEqual([firedFaultOutcome(timeout), notFiredFaultOutcome(fail, faultStoppedShardFirstReason(timeout, 1))])
    })

    // Shard 1 holds test-1 and test-2.
    const END_STATES: [string, (rig: FaultRig) => void, () => string][] = [
      [
        'shard 1 reaching its limit first',
        (rig) => {
          startFaultShards(rig, 1)
          writeFaultResult(rig, 1, [startEvent(scripts()[0])])
          rig.controller.noteShardLimit(1)
        },
        () => shardLimitReachedFirstReason(1),
      ],
      ['shard 1 failing to start', (rig) => rig.controller.noteShardStart(faultShardFailedStart(1)), () => shardNeverStartedReason(1)],
    ]
    const SHARD_ONE_FAULTS: [string, () => string][] = [
      ['fail:test-2', () => `fail:${faultNumberForm(2)}`],
      ['timeout:test-2', () => `timeout:${faultNumberForm(2)}`],
      ['kill:1', () => 'kill:1'],
    ]
    test.each(END_STATES.flatMap(([state, act, reason]) => SHARD_ONE_FAULTS.map(([fault, inject]) => [fault, state, inject, act, reason] as const)))(
      '%s is given its reason after %s',
      async (_fault, _state, inject, act, reason) => {
        const rig = faultRig({ inject: [inject()], shards: [[1, 2]] })
        act(rig)
        await rig.clock.advance(3 * FAULT_POLL_INTERVAL_MS)
        expect(rig.notices).toEqual([])
        expect(faultOutcomes(rig.controller.finalize())).toEqual([notFiredFaultOutcome(faultAt(rig, 0), reason())])
      },
    )

    test('a run-level stop gives the run was stopped first: to a started shard’s faults, a due retag, a shard never attempted and a shard started after it', () => {
      const rig = faultRig({
        inject: ['kill:1', `fail:${faultNumberForm(2)}`, `timeout:${faultNumberForm(3)}`, 'retag', 'kill:3'],
        shards: [[1, 2], [1, 3], [1, 4]],
      })
      startFaultShards(rig, 1)
      writeFaultResult(rig, 1, [startEvent(scripts()[0])])
      rig.controller.noteRunStop()
      startFaultShards(rig, 3)
      expect(rig.clock.pending()).toEqual([])
      expect(faultOutcomes(rig.controller.finalize())).toEqual(rig.faults.map((fault) => notFiredFaultOutcome(fault, runStoppedFirstReason())))
      expect(rig.notices).toEqual([])
    })

    test('finalization answers a terminal record for every fault, in normalized order and form, and is idempotent', () => {
      const rig = faultRig({
        inject: [`fail:${realScriptFileName(2)}`, 'kill:1', `fail:${faultNumberForm(2)}`, 'retag', 'leak:2,1', `timeout:${realScriptFileName(3)}`, 'image-drift:2', 'kill:1'],
        shards: [[1, 2], [1, 3]],
      })
      const records = rig.controller.finalize()
      expect(records.map((record) => faultText(record.fault))).toEqual([
        `fail:${faultNumberForm(2)}`,
        'kill:1',
        'retag',
        'leak:2,1',
        `timeout:${faultNumberForm(3)}`,
        'image-drift:2',
      ])
      expect(records.map(({ shard, leakSourceShard }) => ({ shard, leakSourceShard }))).toEqual([
        { shard: 1, leakSourceShard: null },
        { shard: 1, leakSourceShard: null },
        { shard: null, leakSourceShard: null },
        { shard: 1, leakSourceShard: 2 },
        { shard: 2, leakSourceShard: null },
        { shard: 2, leakSourceShard: null },
      ])
      expect(records.map((record) => record.state)).toEqual(Array(records.length).fill('not-fired'))
      rig.controller.noteTagMove({ kind: 'moved' })
      startFaultShards(rig, 1, 2)
      expect(rig.controller.finalize()).toEqual(records)
      expect(rig.controller.records()).toEqual(records)
    })

    test('a controller with no faults finalizes to an empty record list', () => {
      expect(faultRig({ shards: [[1, 2]] }).controller.finalize()).toEqual([])
    })

    test.each([
      ['driftBuildFailedReason', 'drift image build failed (exit 3)', () => driftBuildFailedReason(3)],
      ['retagBuildFailedReason', 'retag image build failed (exit 4)', () => retagBuildFailedReason(4)],
      ['tagMoveFailedReason', 'tag move failed (exit 125)', () => tagMoveFailedReason(125)],
      ['shardNeverStartedReason', 'shard-2 never started', () => shardNeverStartedReason(2)],
      ['shardStartedWithoutItReason', 'shard-3 started without it', () => shardStartedWithoutItReason(3)],
      ['shardEndedFirstReason', 'shard-4 ended first', () => shardEndedFirstReason(4)],
      ['shardLimitReachedFirstReason', 'shard-5 reached its wall-time limit first', () => shardLimitReachedFirstReason(5)],
      ['runStoppedFirstReason', 'the run was stopped first', () => runStoppedFirstReason()],
      [
        'faultStoppedShardFirstReason',
        'kill:2 stopped shard-2 first',
        () => {
          const parsed = parseFault('kill:2')
          if (!parsed.ok) throw new Error(parsed.reason)
          return faultStoppedShardFirstReason(parsed.fault, 2)
        },
      ],
    ])('pin: %s gives %p', (_builder, text, reason) => {
      expect(reason()).toBe(text)
    })
  })
})

// ---------------------------------------------------------------------------
// E13: the run's end and the tests/runner.sh source audit (b.t6s E13)
// ---------------------------------------------------------------------------
