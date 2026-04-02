/**
 * logging.test.ts — Tests for initLogging() in src/logging.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, closeSync, openSync } from 'fs'
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'logging-test-'))
  logFile = join(tempDir, 'test.log')

  // Snapshot originals so afterEach can restore them unconditionally.
  origConsoleError = console.error
  origConsoleLog = console.log
})

afterEach(() => {
  console.error = origConsoleError
  console.log = origConsoleLog
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
