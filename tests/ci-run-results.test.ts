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
  /** An integrity failure, with its shard number or null as E11 gives it; its check name only satisfies the type, and no case relies on it. */
  const integrityFailure = (n: number, check: e10.IntegrityCheck, shard: number | null = null): e10.Failure => ({ line: `${FAIL_PREFIX}constructed integrity line ${n}`, shard, failureClass: { kind: 'integrity', check } })
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

  /** A leaf's place in a results value: its keys and array indexes from the top. */
  type LeafPath = readonly (string | number)[]

  /** Every leaf of a results value (string, number, boolean or null) with its path, `inspection` data left out. */
  function leavesOf(results: Results): { path: LeafPath; value: unknown }[] {
    const leaves: { path: LeafPath; value: unknown }[] = []
    const walk = (value: unknown, path: LeafPath): void => {
      if (path[path.length - 1] === 'inspection') return
      if (Array.isArray(value)) value.forEach((inner, index) => walk(inner, [...path, index]))
      else if (value !== null && typeof value === 'object') for (const [key, inner] of Object.entries(value)) walk(inner, [...path, key])
      else leaves.push({ path, value })
    }
    walk(results, [])
    return leaves
  }

  /** The first of the seven-digit numbers `distinctiveResults` gives. */
  const DISTINCT_NUMBER_BASE = 7_300_000

  /**
   * A results value with every string and number but the `inspection` data
   * replaced by its own value: numbers by seven-digit numbers, strings by
   * fixed-width marks, none inside another or inside the summary's own text.
   * A value found in the summary can then only have come from its own place,
   * and the verdict differs from every failure line. Only for rendering: the
   * value no longer satisfies E1's shape.
   */
  function distinctiveResults(results: Results): Results {
    let next = 0
    const remap = (value: unknown, key: string | number | null): unknown => {
      if (key === 'inspection') return value
      if (typeof value === 'number') return DISTINCT_NUMBER_BASE + next++
      if (typeof value === 'string') return `e10-shown-${String(next++).padStart(4, '0')}`
      if (Array.isArray(value)) return value.map((inner, index) => remap(inner, index))
      if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([innerKey, inner]) => [innerKey, remap(inner, innerKey)]))
      return value
    }
    return remap(results, null) as Results
  }

  /** A copy of a results value with the boolean at `path` flipped. */
  function withFlipped(results: Results, path: LeafPath): Results {
    type Node = Record<string | number, unknown>
    const copy = structuredClone(results)
    const parent = path.slice(0, -1).reduce<Node>((at, key) => at[key] as Node, copy as unknown as Node)
    const last = path[path.length - 1] as string | number
    parent[last] = !parent[last]
    return copy
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
    test('a failing prerequisite: test-3 is notrun after test-2 fails, the only failure is test-2’s line, the run fails, and the verdict is test-2’s line', () => {
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
      const ranked = e10.rankFailures(sources)
      expect(ranked).toEqual([{ line, shard: 1, failureClass: { kind: 'script', fileName: t2 } }])
      const passed = e10.runPasses({ expectedScripts: [t1, t2, t3], shardsUsed: [1], outcomes: [outcome], otherFailures: [] })
      expect(passed).toBe(false)
      expect(e10.buildVerdictLine({ invocation: invocationOf([]), scripts: [], passed, ranked })).toBe(line)
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
      [
        'integrity lines with mixed shards keep their given order, not sorted by shard',
        (): RunSpec => ({ shards: [passingShard(1, [script(1)])], integrity: [integrityFailure(3, 'secret-scan', 3), integrityFailure(1, 'fault-fired', null), integrityFailure(2, 'package-hash', 1)] }),
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

    test('an integrity failure carrying a shard number keeps it, and still ranks over a lower shard’s out-of-memory line', () => {
      const run = decideRun({ shards: [passingShard(1, [script(1)], { oomLine: oomShardLine(1) })], integrity: [integrityFailure(1, 'results-canary', 2)] })
      expect(run.ranked.map((failure) => ({ line: failure.line, shard: failure.shard }))).toEqual([
        { line: integrityFailure(1, 'results-canary').line, shard: 2 },
        { line: oomShardLine(1), shard: 1 },
      ])
    })

    test.each([
      ['a failure of the wrong class, run-level stop, in the integrity list', (): Partial<e10.FailureSources> => ({ integrityFailures: [{ line: RUN_LEVEL_LINE, shard: 1, failureClass: { kind: 'run-level-stop' } }] })],
      ['a failure of the wrong class, image build, in the integrity list', (): Partial<e10.FailureSources> => ({ integrityFailures: [{ line: IMAGE_BUILD_LINE, shard: 1, failureClass: { kind: 'image-build' } }] })],
      ['a failure of the wrong class, run-level stop, in a shard outcome', (outcome: e10.ShardOutcome): Partial<e10.FailureSources> => ({ outcomes: [{ ...outcome, failures: [{ line: RUN_LEVEL_LINE, shard: 1, failureClass: { kind: 'run-level-stop' } }] }] })],
      ['a failure of the wrong class, image build, in a shard outcome', (outcome: e10.ShardOutcome): Partial<e10.FailureSources> => ({ outcomes: [{ ...outcome, failures: [{ line: IMAGE_BUILD_LINE, shard: 1, failureClass: { kind: 'image-build' } }] }] })],
      ['a script failure with no shard in a shard outcome', (outcome: e10.ShardOutcome): Partial<e10.FailureSources> => ({ outcomes: [{ ...outcome, failures: [{ line: scriptFailLine(script(1), 1), shard: null, failureClass: { kind: 'script', fileName: script(1) } }] }] })],
      ['an out-of-memory failure with no shard in a shard outcome', (outcome: e10.ShardOutcome): Partial<e10.FailureSources> => ({ outcomes: [{ ...outcome, failures: [{ line: oomShardLine(1), shard: null, failureClass: { kind: 'out-of-memory' } }] }] })],
    ] as [string, (outcome: e10.ShardOutcome) => Partial<e10.FailureSources>][])('rankFailures throws for %s', (_what, change) => {
      const outcome = decideRun({ shards: [passingShard(1, [script(1)])] }).outcomes[0] as e10.ShardOutcome
      const sources: e10.FailureSources = { runLevelLine: null, imageBuildLine: null, integrityFailures: [], outcomes: [outcome], ...change(outcome) }
      expect(() => e10.rankFailures(sources)).toThrow()
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

    test('the summary shows every string and number of the results but the inspection data, each from its own place: the verdict, each failure with its shard, every shard figure and the failed-reading counts of the run and each shard', () => {
      const results = distinctiveResults(assembled())
      expect(results.failures.map((failure) => failure.line)).not.toContain(results.verdict)
      const shown = leavesOf(results).filter(({ value }) => typeof value === 'string' || typeof value === 'number')
      const shownPaths = shown.map(({ path }) => path.join('.'))
      const shardFigures = results.shards.flatMap((_shard, index) => ['expectedSeconds', 'limitMinutes', 'peakPids', 'failedReadings'].map((key) => `shards.${index}.${key}`))
      expect(shownPaths).toEqual(expect.arrayContaining(['verdict', 'failedReadings', 'skippedChecks.0', 'cleanupFailures.0', ...shardFigures]))
      const summary = e10.renderSummary(results)
      expect(shown.filter(({ value }) => !summary.includes(String(value))).map(({ path }) => path.join('.'))).toEqual([])
      const failuresWithShards = results.failures.map((failure) => (failure.shard === null ? failure.line : `${SHARD_DIR_PREFIX}${failure.shard}: ${failure.line}`))
      expect(failuresWithShards.filter((text) => !summary.includes(text))).toEqual([])
    })

    test('each yes-or-no value is shown on its own line, a shard’s among that shard’s lines: flipping it changes exactly that one line', () => {
      const results = distinctiveResults(assembled())
      const before = e10.renderSummary(results).split('\n')
      const flags = leavesOf(results).filter(({ value }) => typeof value === 'boolean')
      const flagPaths = flags.map(({ path }) => path.join('.'))
      expect(flagPaths).toEqual(expect.arrayContaining(['invocation.selective', 'images.retagMoved', 'cap.peakFromKill', ...results.shards.map((_shard, index) => `shards.${index}.endedNormally`), 'shards.0.final.oomKilled']))
      // A shard's lines: from the first to the last summary line holding one of its own values and no other shard's.
      const shardValues = results.shards.map((_shard, index) =>
        leavesOf(results)
          .filter(({ path, value }) => path[0] === 'shards' && path[1] === index && (typeof value === 'string' || typeof value === 'number'))
          .map(({ value }) => String(value)),
      )
      const holds = (line: string, index: number): boolean => (shardValues[index] as string[]).some((value) => line.includes(value))
      const shardSpans = shardValues.map((_values, index) => {
        const own = before.flatMap((line, at) => (holds(line, index) && shardValues.every((_other, other) => other === index || !holds(line, other)) ? [at] : []))
        return [Math.min(...own), Math.max(...own)] as const
      })
      const placed = flags.map(({ path }) => {
        const after = e10.renderSummary(withFlipped(results, path)).split('\n')
        const changed = before.flatMap((line, at) => (line === after[at] ? [] : [at]))
        const inShards = shardSpans.flatMap(([first, last], index) => (changed.length === 1 && (changed[0] as number) >= first && (changed[0] as number) <= last ? [index] : []))
        return { path: path.join('.'), lineCount: after.length, changedLines: changed.length, inShards: inShards as (string | number)[] }
      })
      expect(placed).toEqual(flags.map(({ path }) => ({ path: path.join('.'), lineCount: before.length, changedLines: 1, inShards: path[0] === 'shards' ? [path[1]] : [] })))
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
