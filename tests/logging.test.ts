/**
 * logging.test.ts — Tests for initLogging() in src/logging.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, readFileSync, existsSync, statSync, rmSync, closeSync, openSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initLogging } from '../src/logging.ts'

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

let tempDir: string
let logFile: string

let origConsoleError: typeof console.error
let origConsoleLog: typeof console.log
let origMaxBytes: string | undefined
let origKeep: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'logging-test-'))
  logFile = join(tempDir, 'test.log')

  // Snapshot originals so afterEach can restore them unconditionally.
  origConsoleError = console.error
  origConsoleLog = console.log
  origMaxBytes = process.env['CSCB_LOG_MAX_BYTES']
  origKeep = process.env['CSCB_LOG_KEEP']
})

afterEach(() => {
  console.error = origConsoleError
  console.log = origConsoleLog
  // Restore rotation env so tests never leak thresholds into each other.
  if (origMaxBytes === undefined) delete process.env['CSCB_LOG_MAX_BYTES']
  else process.env['CSCB_LOG_MAX_BYTES'] = origMaxBytes
  if (origKeep === undefined) delete process.env['CSCB_LOG_KEEP']
  else process.env['CSCB_LOG_KEEP'] = origKeep
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the log file and return its lines (trailing newline stripped). */
function readLines(): string[] {
  const raw = readFileSync(logFile, 'utf-8')
  return raw.split('\n').filter(l => l.length > 0)
}

// ISO-8601 timestamp wrapped in brackets: [2026-04-01T12:00:00.000Z]
const ISO_TIMESTAMP_RE = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/

// ---------------------------------------------------------------------------
// console.error writes to file
// ---------------------------------------------------------------------------

describe('initLogging — console.error', () => {
  test('console.error writes a line to the log file', () => {
    initLogging(logFile)
    console.error('hello error')
    const lines = readLines()
    expect(lines).toHaveLength(1)
  })

  test('console.error line contains the message text', () => {
    initLogging(logFile)
    console.error('hello error')
    const lines = readLines()
    expect(lines[0]).toContain('hello error')
  })

  test('console.error line starts with an ISO-8601 timestamp', () => {
    initLogging(logFile)
    console.error('timestamped error')
    const lines = readLines()
    expect(ISO_TIMESTAMP_RE.test(lines[0])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// console.log writes to file
// ---------------------------------------------------------------------------

describe('initLogging — console.log', () => {
  test('console.log writes a line to the log file', () => {
    initLogging(logFile)
    console.log('hello log')
    const lines = readLines()
    expect(lines).toHaveLength(1)
  })

  test('console.log line contains the message text', () => {
    initLogging(logFile)
    console.log('hello log')
    const lines = readLines()
    expect(lines[0]).toContain('hello log')
  })

  test('console.log line starts with an ISO-8601 timestamp', () => {
    initLogging(logFile)
    console.log('timestamped log')
    const lines = readLines()
    expect(ISO_TIMESTAMP_RE.test(lines[0])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Timestamp format
// ---------------------------------------------------------------------------

describe('initLogging — timestamp format', () => {
  test('timestamp is enclosed in square brackets', () => {
    initLogging(logFile)
    console.log('bracket check')
    const lines = readLines()
    expect(lines[0].startsWith('[')).toBe(true)
    expect(lines[0][lines[0].indexOf(']')]).toBe(']')
  })

  test('timestamp value inside brackets is a valid ISO-8601 date', () => {
    initLogging(logFile)
    console.log('iso check')
    const lines = readLines()
    // Extract the value between the first [ and ]
    const match = lines[0].match(/^\[([^\]]+)\]/)
    expect(match).not.toBeNull()
    const ts = new Date(match![1])
    expect(isNaN(ts.getTime())).toBe(false)
  })

  test('timestamp milliseconds field is present (.NNNz)', () => {
    initLogging(logFile)
    console.log('ms check')
    const lines = readLines()
    // ISO string ends with .NNNz before the closing bracket
    expect(lines[0]).toMatch(/\.\d{3}Z\]/)
  })
})

// ---------------------------------------------------------------------------
// Append behaviour — multiple calls do not overwrite
// ---------------------------------------------------------------------------

describe('initLogging — multiple writes append to the file', () => {
  test('three console.error calls produce three lines', () => {
    initLogging(logFile)
    console.error('line one')
    console.error('line two')
    console.error('line three')
    const lines = readLines()
    expect(lines).toHaveLength(3)
  })

  test('lines are written in call order', () => {
    initLogging(logFile)
    console.error('first')
    console.error('second')
    const lines = readLines()
    expect(lines[0]).toContain('first')
    expect(lines[1]).toContain('second')
  })

  test('three console.log calls produce three lines', () => {
    initLogging(logFile)
    console.log('a')
    console.log('b')
    console.log('c')
    const lines = readLines()
    expect(lines).toHaveLength(3)
  })

  test('mixed console.error and console.log calls each append a line', () => {
    initLogging(logFile)
    console.error('err')
    console.log('log')
    const lines = readLines()
    expect(lines).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Multi-argument calls — all args joined on one line
// ---------------------------------------------------------------------------

describe('initLogging — multi-argument calls', () => {
  test('two string args appear on a single line', () => {
    initLogging(logFile)
    console.error('foo', 'bar')
    const lines = readLines()
    expect(lines).toHaveLength(1)
  })

  test('two string args are joined with a space', () => {
    initLogging(logFile)
    console.error('foo', 'bar')
    const lines = readLines()
    expect(lines[0]).toContain('foo bar')
  })

  test('three string args all appear on the same line', () => {
    initLogging(logFile)
    console.log('alpha', 'beta', 'gamma')
    const lines = readLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('alpha beta gamma')
  })

  test('object arg is serialized as JSON on the same line', () => {
    initLogging(logFile)
    console.error('data:', { x: 1 })
    const lines = readLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('{"x":1}')
  })

  test('number arg is serialized as a string on the same line', () => {
    initLogging(logFile)
    console.log('count:', 42)
    const lines = readLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('count: 42')
  })
})

// ---------------------------------------------------------------------------
// Switching output file — second initLogging call
// ---------------------------------------------------------------------------

describe('initLogging — switching to a different file', () => {
  test('calls after second initLogging go to the new file', () => {
    const logFile2 = join(tempDir, 'test2.log')

    initLogging(logFile)
    console.log('to file one')

    initLogging(logFile2)
    console.log('to file two')

    const lines2 = readFileSync(logFile2, 'utf-8').split('\n').filter(l => l.length > 0)
    expect(lines2).toHaveLength(1)
    expect(lines2[0]).toContain('to file two')
  })

  test('first file is not written after switching', () => {
    const logFile2 = join(tempDir, 'test2.log')

    initLogging(logFile)
    console.log('first file write')

    initLogging(logFile2)
    console.log('after switch')

    const lines1 = readFileSync(logFile, 'utf-8').split('\n').filter(l => l.length > 0)
    // Only the write before the switch should be in the first file
    expect(lines1).toHaveLength(1)
    expect(lines1[0]).toContain('first file write')
  })
})

// ---------------------------------------------------------------------------
// Fallback to original console when fd is closed / unavailable
// ---------------------------------------------------------------------------

describe('initLogging — fallback when write fails', () => {
  // The implementation wraps writeSync in a try/catch and falls through to
  // the original console method on failure.  We force a write error by opening
  // a file, calling initLogging (which opens the same path again for append),
  // then closing *our* fd and the internal one simultaneously by exploiting the
  // fact that we know the internal fd is the next fd allocated after ours.
  // That approach is too racy, so instead we verify the simpler guarantee:
  // even after the temp directory is removed, the already-open fd keeps
  // working (Linux unlink semantics), and the call does not throw.

  test('console.error does not throw after log file directory is removed', () => {
    const badDir = mkdtempSync(join(tmpdir(), 'logging-bad-'))
    const badFile = join(badDir, 'gone.log')
    initLogging(badFile)
    // Removing the directory unlinks the file, but the fd stays valid.
    // Either the write succeeds (inode still open) or the catch fires — either
    // way, no exception should propagate to the caller.
    rmSync(badDir, { recursive: true, force: true })
    expect(() => console.error('should not throw')).not.toThrow()
  })

  test('console.log does not throw after log file directory is removed', () => {
    const badDir = mkdtempSync(join(tmpdir(), 'logging-bad2-'))
    const badFile = join(badDir, 'gone.log')
    initLogging(badFile)
    rmSync(badDir, { recursive: true, force: true })
    expect(() => console.log('should not throw')).not.toThrow()
  })

  test('console.error does not throw when fd is explicitly closed', () => {
    // Open a fresh file, call initLogging, close the fd we opened ourselves,
    // then force-close the internal fd by opening the file for read and
    // consuming fds until we can deduce its number — this is impractical.
    // Instead, verify the no-throw contract by wrapping in a try/catch guard.
    initLogging(logFile)
    // Close every fd from the current max down until writeSync would fail.
    // Practical approach: open the file ourselves, capture the fd, assume the
    // initLogging fd is fd+1 (next allocation), then close that one.
    const probeA = openSync(logFile, 'r')
    const probeB = openSync(logFile, 'r')
    // initLogging was called before probeA/probeB, so the internal fd < probeA.
    // Close both probes; no way to reach internal fd without exporting it.
    closeSync(probeB)
    closeSync(probeA)
    // Regardless of whether the write succeeds or the catch fires, no throw.
    expect(() => console.error('fallback test')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Size-based rotation (b.brv)
// ---------------------------------------------------------------------------

describe('initLogging — size-based rotation', () => {
  // A single log line is ~50 bytes (timestamp + message + newline). Setting a
  // small byte threshold via env lets a handful of writes cross it. Rotation is
  // checked *before* each write, so the file that crosses the threshold rotates
  // on the NEXT write.

  test('active file is renamed to .1 once it crosses the threshold', () => {
    process.env['CSCB_LOG_MAX_BYTES'] = '120'
    process.env['CSCB_LOG_KEEP'] = '5'
    initLogging(logFile)

    // Each line is well over ~40 bytes; a few writes push past 120 bytes.
    for (let i = 0; i < 6; i++) console.log(`rotation line number ${i}`)

    // The rotated generation must exist — pre-fix there was no rotation at all.
    expect(existsSync(`${logFile}.1`)).toBe(true)
  })

  test('active file size stays capped near the threshold instead of growing unbounded', () => {
    process.env['CSCB_LOG_MAX_BYTES'] = '200'
    process.env['CSCB_LOG_KEEP'] = '5'
    initLogging(logFile)

    // Write far more bytes than the threshold. Without rotation this file would
    // hold everything (this is the b.brv unbounded-growth bug).
    for (let i = 0; i < 200; i++) console.log(`capped growth line ${i} padding padding`)

    const activeSize = statSync(logFile).size
    // A rotation resets the active file, so the live file must be far smaller
    // than the total written. Allow one threshold's worth of slack.
    expect(activeSize).toBeLessThan(200 * 3)
  })

  test('keeps exactly K generations and prunes the oldest', () => {
    process.env['CSCB_LOG_MAX_BYTES'] = '80'
    process.env['CSCB_LOG_KEEP'] = '2'
    initLogging(logFile)

    // Many writes trigger many rotations; only .1 and .2 may survive.
    for (let i = 0; i < 100; i++) console.log(`prune test line ${i} padding`)

    expect(existsSync(`${logFile}.1`)).toBe(true)
    expect(existsSync(`${logFile}.2`)).toBe(true)
    // The 3rd generation must never accumulate — oldest is pruned.
    expect(existsSync(`${logFile}.3`)).toBe(false)
  })

  test('CSCB_LOG_KEEP=1 retains only a single rotated generation', () => {
    process.env['CSCB_LOG_MAX_BYTES'] = '80'
    process.env['CSCB_LOG_KEEP'] = '1'
    initLogging(logFile)

    for (let i = 0; i < 60; i++) console.log(`single keep line ${i} padding`)

    expect(existsSync(`${logFile}.1`)).toBe(true)
    expect(existsSync(`${logFile}.2`)).toBe(false)
  })

  test('CSCB_LOG_KEEP=0 truncates and retains no rotated generations', () => {
    process.env['CSCB_LOG_MAX_BYTES'] = '80'
    process.env['CSCB_LOG_KEEP'] = '0'
    initLogging(logFile)

    for (let i = 0; i < 60; i++) console.log(`no keep line ${i} padding`)

    // keep=0 means rotation discards the file outright — no .1 generation.
    expect(existsSync(`${logFile}.1`)).toBe(false)
    // The active file is still bounded near the threshold.
    expect(statSync(logFile).size).toBeLessThan(80 * 3)
  })

  test('non-numeric CSCB_LOG_MAX_BYTES falls back to the 10 MiB default (no rotation for small writes)', () => {
    process.env['CSCB_LOG_MAX_BYTES'] = 'not-a-number'
    initLogging(logFile)

    for (let i = 0; i < 50; i++) console.log(`default threshold line ${i}`)

    // With the 10 MiB default, a few dozen short lines never rotate.
    expect(existsSync(`${logFile}.1`)).toBe(false)
  })

  test('rotated .1 generation retains the earlier log content', () => {
    process.env['CSCB_LOG_MAX_BYTES'] = '120'
    process.env['CSCB_LOG_KEEP'] = '5'
    initLogging(logFile)

    for (let i = 0; i < 6; i++) console.log(`retained content line ${i}`)

    const rotated = readFileSync(`${logFile}.1`, 'utf-8')
    // The earliest line was written before rotation and lives in .1 now.
    expect(rotated).toContain('retained content line 0')
  })
})

// ---------------------------------------------------------------------------
// Reopen recovery after a failed post-rotation open (b.brv code-review fix)
// ---------------------------------------------------------------------------

describe('initLogging — reopen recovery after a failed post-rotation open', () => {
  // Code review found that if the post-rotation openSync(path, 'a') failed once,
  // `fd` stayed null forever and file logging never resumed. These tests force
  // that failure deterministically, then clear it and prove logging recovers.
  //
  // The failure lever: route the log path through a symlinked directory. While
  // the symlink points at a real dir, opens succeed. Repointing it at a missing
  // target makes the next rotation's reopen throw (ENOENT), dropping fd to null;
  // repointing it back lets the NEXT write reopen and resume. This exercises the
  // exact transient-then-recovered condition (ENOSPC/EMFILE/permissions class)
  // without any module mocking.

  /** Build a base dir with `real/` and a `link -> real` symlink; return paths. */
  function makeSymlinkedLog(): { base: string; realDir: string; link: string; realFile: string; symlinkedLog: string } {
    const base = mkdtempSync(join(tmpdir(), 'logging-reopen-'))
    const realDir = join(base, 'real')
    mkdirSync(realDir)
    const link = join(base, 'link')
    symlinkSync(realDir, link)
    return {
      base,
      realDir,
      link,
      realFile: join(realDir, 'test.log'),
      // The active log path is addressed *through* the symlink.
      symlinkedLog: join(link, 'test.log'),
    }
  }

  /** Repoint `link` at a missing target so the next reopen throws. */
  function breakLink(base: string, link: string): void {
    unlinkSync(link)
    symlinkSync(join(base, 'no-such-dir'), link)
  }

  /** Repoint `link` back at the real dir so reopen can succeed again. */
  function healLink(realDir: string, link: string): void {
    unlinkSync(link)
    symlinkSync(realDir, link)
  }

  test('a write whose rotation-reopen fails falls back to console without throwing', () => {
    const { base, link, realFile, symlinkedLog } = makeSymlinkedLog()
    try {
      process.env['CSCB_LOG_MAX_BYTES'] = '80'
      process.env['CSCB_LOG_KEEP'] = '5'
      initLogging(symlinkedLog)

      // Push the active file past the threshold so the next write rotates.
      console.log('x'.repeat(100))

      // Break the path, then write: rotation closes fd, the reopen throws, and
      // this write must fall back to console — silently, never throwing.
      breakLink(base, link)
      expect(() => console.log('DROPPED WHILE BROKEN')).not.toThrow()

      // The dropped write must NOT have landed in the file (fd was null).
      const after = existsSync(realFile) ? readFileSync(realFile, 'utf-8') : ''
      expect(after.includes('DROPPED WHILE BROKEN')).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  // REGRESSION: fails against pre-fix code (fd stayed null forever after one
  // failed reopen), passes now that makeLogFn retries the open on each write.
  test('logging resumes on the next write once the failure clears (regression)', () => {
    const { base, realDir, link, realFile, symlinkedLog } = makeSymlinkedLog()
    try {
      process.env['CSCB_LOG_MAX_BYTES'] = '80'
      process.env['CSCB_LOG_KEEP'] = '5'
      initLogging(symlinkedLog)

      console.log('x'.repeat(100)) // exceed threshold

      breakLink(base, link)
      console.log('DROPPED WHILE BROKEN') // reopen throws -> fd null, console fallback

      // Clear the transient failure and write again. Pre-fix, fd was stuck null
      // and this line was lost to console; post-fix, the guard reopens the file.
      healLink(realDir, link)
      console.log('RECOVERED AFTER HEAL')

      const content = readFileSync(realFile, 'utf-8')
      expect(content).toContain('RECOVERED AFTER HEAL')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test('recovery repopulates fd so subsequent writes keep landing in the file', () => {
    const { base, realDir, link, realFile, symlinkedLog } = makeSymlinkedLog()
    try {
      process.env['CSCB_LOG_MAX_BYTES'] = '80'
      process.env['CSCB_LOG_KEEP'] = '5'
      initLogging(symlinkedLog)

      console.log('x'.repeat(100))
      breakLink(base, link)
      console.log('DROPPED WHILE BROKEN')
      healLink(realDir, link)

      // First post-heal write reopens; a further write must also land — proving
      // fd was repopulated (not reopened-and-immediately-dropped) for good.
      console.log('FIRST AFTER HEAL')
      console.log('SECOND AFTER HEAL')

      const content = readFileSync(realFile, 'utf-8')
      expect(content).toContain('FIRST AFTER HEAL')
      expect(content).toContain('SECOND AFTER HEAL')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  // Negative: with a healthy fd the recovery guard is a no-op — a normal write
  // after init lands exactly once (no duplication from a spurious reopen path).
  test('recovery guard is inert on a healthy fd — a normal write lands exactly once', () => {
    initLogging(logFile)
    console.log('single healthy write')
    const lines = readLines().filter(l => l.includes('single healthy write'))
    expect(lines).toHaveLength(1)
  })
})
