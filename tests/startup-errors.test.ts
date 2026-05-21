/**
 * startup-errors.test.ts — Tests for recordStartupError() in src/startup-errors.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Stderr capture via mock.module
//
// startup-errors.ts uses `writeSync(2, ...)` for all stderr output — a direct
// fd-2 write that bypasses process.stderr.write entirely.  The only reliable
// way to intercept it in Bun is to replace the writeSync export before the
// module under test is loaded.
//
// Strategy:
//   1. Define a mutable capture array that tests can drain.
//   2. Replace 'node:fs' writeSync with a spy that records fd-2 writes to the
//      array and forwards all other fd writes to the real writeSync.
//   3. Import the module AFTER mock.module() so the spy is in scope.
// ---------------------------------------------------------------------------

import { writeSync as realWriteSync } from 'node:fs'

const stderrCapture: string[] = []

mock.module('node:fs', () => {
  // Re-export everything from the real node:fs, but replace writeSync.
  const realFs = require('node:fs') as typeof import('node:fs')
  return {
    ...realFs,
    writeSync: (fd: number, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      if (fd === 2 && typeof data === 'string') {
        stderrCapture.push(data)
        return data.length
      }
      // Forward all other fd writes to the real implementation.
      return (realFs.writeSync as Function)(fd, data, ...rest)
    },
  }
})

// Import AFTER mock.module so the spy is wired in.
import { recordStartupError } from '../src/startup-errors.ts'

// ---------------------------------------------------------------------------
// ISO-8601 timestamp regex (same style as logging.test.ts)
// ---------------------------------------------------------------------------

const ISO_TIMESTAMP_RE = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'startup-errors-test-'))
  stderrCapture.length = 0
})

afterEach(() => {
  stderrCapture.length = 0
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Factory helpers (shared fixture shape used by multiple tests)
// ---------------------------------------------------------------------------

/** Return the path to the log file inside a given directory. */
function logFilePath(dir: string): string {
  return join(dir, 'startup-errors.log')
}

/** Read lines from the log file, filtering empty trailing lines. */
function readLogLines(dir: string): string[] {
  const raw = readFileSync(logFilePath(dir), 'utf-8')
  return raw.split('\n').filter(l => l.length > 0)
}

/** Drain stderr captures, filtering empty trailing entries (newlines produce empty strings). */
function drainStderr(): string[] {
  // Each writeStderr call appends `line + '\n'` as one string; split on newline.
  const result: string[] = []
  for (const entry of stderrCapture) {
    for (const part of entry.split('\n')) {
      if (part.length > 0) result.push(part)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('recordStartupError — happy path', () => {
  test('single call writes exactly one line to the log file', () => {
    recordStartupError('config', 'token missing', undefined, { logDir: tempDir })
    const lines = readLogLines(tempDir)
    expect(lines).toHaveLength(1)
  })

  test('single call writes exactly one line to captured stderr', () => {
    recordStartupError('config', 'token missing', undefined, { logDir: tempDir })
    const lines = drainStderr()
    expect(lines).toHaveLength(1)
  })

  test('log file line contains the message text', () => {
    recordStartupError('config', 'token missing', undefined, { logDir: tempDir })
    const lines = readLogLines(tempDir)
    expect(lines[0]).toContain('token missing')
  })

  test('stderr line contains the message text', () => {
    recordStartupError('config', 'token missing', undefined, { logDir: tempDir })
    const lines = drainStderr()
    expect(lines[0]).toContain('token missing')
  })
})

// ---------------------------------------------------------------------------
// Recursive mkdir
// ---------------------------------------------------------------------------

describe('recordStartupError — recursive mkdir', () => {
  test('creates two missing directory levels and writes the log file', () => {
    const deepDir = join(tempDir, 'level1', 'level2')
    // deepDir does not exist yet
    recordStartupError('init', 'deep dir test', undefined, { logDir: deepDir })
    const lines = readLogLines(deepDir)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('deep dir test')
  })

  test('creates three missing directory levels and writes succeed', () => {
    const deepDir = join(tempDir, 'a', 'b', 'c')
    recordStartupError('init', 'triple deep', undefined, { logDir: deepDir })
    const lines = readLogLines(deepDir)
    expect(lines).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// File creation and append semantics
// ---------------------------------------------------------------------------

describe('recordStartupError — file creation and append', () => {
  test('creates the log file when it does not exist', () => {
    recordStartupError('token', 'first write', undefined, { logDir: tempDir })
    const raw = readFileSync(logFilePath(tempDir), 'utf-8')
    expect(raw.length).toBeGreaterThan(0)
  })

  test('appends when file already has content; prior content is preserved', () => {
    const preContent = 'pre-existing content\n'
    writeFileSync(logFilePath(tempDir), preContent, 'utf-8')

    recordStartupError('token', 'appended line', undefined, { logDir: tempDir })

    const raw = readFileSync(logFilePath(tempDir), 'utf-8')
    expect(raw.startsWith(preContent)).toBe(true)
    expect(raw).toContain('appended line')
  })

  test('two successive calls produce exactly two non-empty lines (no truncation)', () => {
    recordStartupError('token', 'first', undefined, { logDir: tempDir })
    recordStartupError('token', 'second', undefined, { logDir: tempDir })
    const lines = readLogLines(tempDir)
    expect(lines).toHaveLength(2)
  })

  test('prior single-line content is preserved after a second call', () => {
    recordStartupError('token', 'first', undefined, { logDir: tempDir })
    const afterFirst = readFileSync(logFilePath(tempDir), 'utf-8')

    recordStartupError('token', 'second', undefined, { logDir: tempDir })
    const afterSecond = readFileSync(logFilePath(tempDir), 'utf-8')

    expect(afterSecond.startsWith(afterFirst)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Ordered append across N calls
// ---------------------------------------------------------------------------

describe('recordStartupError — ordered append', () => {
  test('two calls produce lines in call order', () => {
    recordStartupError('order', 'first call', undefined, { logDir: tempDir })
    recordStartupError('order', 'second call', undefined, { logDir: tempDir })
    const lines = readLogLines(tempDir)
    expect(lines[0]).toContain('first call')
    expect(lines[1]).toContain('second call')
  })

  test('five calls produce five lines in call order', () => {
    const messages = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    for (const msg of messages) {
      recordStartupError('order', msg, undefined, { logDir: tempDir })
    }
    const lines = readLogLines(tempDir)
    expect(lines).toHaveLength(5)
    for (let i = 0; i < messages.length; i++) {
      expect(lines[i]).toContain(messages[i])
    }
  })
})

// ---------------------------------------------------------------------------
// Stderr mirroring
// ---------------------------------------------------------------------------

describe('recordStartupError — stderr mirroring', () => {
  test('every call writes a corresponding line to stderr', () => {
    recordStartupError('mirror', 'first', undefined, { logDir: tempDir })
    recordStartupError('mirror', 'second', undefined, { logDir: tempDir })
    const stderrLines = drainStderr()
    expect(stderrLines).toHaveLength(2)
  })

  test('stderr line contains the same message text as the file line', () => {
    recordStartupError('mirror', 'unique-message-xyz', undefined, { logDir: tempDir })
    const fileLines = readLogLines(tempDir)
    const stderrLines = drainStderr()
    expect(stderrLines[0]).toContain('unique-message-xyz')
    expect(fileLines[0]).toContain('unique-message-xyz')
  })

  test('stderr line has the same timestamp shape as the file line', () => {
    recordStartupError('mirror', 'ts-check', undefined, { logDir: tempDir })
    const fileLines = readLogLines(tempDir)
    const stderrLines = drainStderr()
    expect(ISO_TIMESTAMP_RE.test(stderrLines[0])).toBe(true)
    expect(ISO_TIMESTAMP_RE.test(fileLines[0])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Timestamp format
// ---------------------------------------------------------------------------

describe('recordStartupError — timestamp format', () => {
  test('each log line starts with a bracketed ISO-8601 timestamp', () => {
    recordStartupError('ts', 'timestamp test', undefined, { logDir: tempDir })
    const lines = readLogLines(tempDir)
    expect(ISO_TIMESTAMP_RE.test(lines[0])).toBe(true)
  })

  test('timestamp value inside brackets is a valid date', () => {
    recordStartupError('ts', 'valid date', undefined, { logDir: tempDir })
    const lines = readLogLines(tempDir)
    const match = lines[0].match(/^\[([^\]]+)\]/)
    expect(match).not.toBeNull()
    const ts = new Date(match![1])
    expect(isNaN(ts.getTime())).toBe(false)
  })

  test('timestamp has millisecond precision (.NNNz)', () => {
    recordStartupError('ts', 'ms precision', undefined, { logDir: tempDir })
    const lines = readLogLines(tempDir)
    expect(lines[0]).toMatch(/\.\d{3}Z\]/)
  })

  test('stderr line also starts with a bracketed ISO-8601 timestamp', () => {
    recordStartupError('ts', 'stderr ts', undefined, { logDir: tempDir })
    const stderrLines = drainStderr()
    expect(ISO_TIMESTAMP_RE.test(stderrLines[0])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Class label verbatim
// ---------------------------------------------------------------------------

describe('recordStartupError — class label', () => {
  test('supplied class label appears verbatim as a parseable field', () => {
    recordStartupError('my-class-label', 'label test', undefined, { logDir: tempDir })
    const lines = readLogLines(tempDir)
    expect(lines[0]).toContain('[my-class-label]')
  })

  test('class label appears in stderr line too', () => {
    recordStartupError('my-class-label', 'label test', undefined, { logDir: tempDir })
    const stderrLines = drainStderr()
    expect(stderrLines[0]).toContain('[my-class-label]')
  })

  test('different class labels produce different fields', () => {
    recordStartupError('label-a', 'msg a', undefined, { logDir: tempDir })
    recordStartupError('label-b', 'msg b', undefined, { logDir: tempDir })
    const lines = readLogLines(tempDir)
    expect(lines[0]).toContain('[label-a]')
    expect(lines[1]).toContain('[label-b]')
  })
})

// ---------------------------------------------------------------------------
// Idempotency / safe re-init
// ---------------------------------------------------------------------------

describe('recordStartupError — idempotency', () => {
  test('calling repeatedly does not throw', () => {
    expect(() => {
      for (let i = 0; i < 5; i++) {
        recordStartupError('repeat', `call ${i}`, undefined, { logDir: tempDir })
      }
    }).not.toThrow()
  })

  test('calling repeatedly does not truncate the file', () => {
    recordStartupError('repeat', 'first', undefined, { logDir: tempDir })
    const afterFirst = readFileSync(logFilePath(tempDir), 'utf-8')

    recordStartupError('repeat', 'second', undefined, { logDir: tempDir })
    const afterSecond = readFileSync(logFilePath(tempDir), 'utf-8')

    // Second call must only add to the file, never shrink it
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length)
    expect(afterSecond.startsWith(afterFirst)).toBe(true)
  })

  test('calling repeatedly does not duplicate the first line', () => {
    recordStartupError('repeat', 'idempotent-msg', undefined, { logDir: tempDir })
    recordStartupError('repeat', 'idempotent-msg', undefined, { logDir: tempDir })
    const lines = readLogLines(tempDir)
    // Two separate calls → two lines, but each should only be written once
    expect(lines).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// mkdir failure — parent path component is a file
// ---------------------------------------------------------------------------

describe('recordStartupError — mkdir failure fallback', () => {
  test('does not throw when parent directory creation is impossible', () => {
    // Place a regular file at a path that would need to be a directory.
    const blockingFile = join(tempDir, 'blocker')
    writeFileSync(blockingFile, 'i am a file, not a dir\n', 'utf-8')
    const impossibleDir = join(blockingFile, 'subdir')

    expect(() => {
      recordStartupError('fail', 'cannot mkdir', undefined, { logDir: impossibleDir })
    }).not.toThrow()
  })

  test('stderr-only fallback still occurs when mkdir fails', () => {
    const blockingFile = join(tempDir, 'blocker2')
    writeFileSync(blockingFile, 'i am a file\n', 'utf-8')
    const impossibleDir = join(blockingFile, 'subdir')

    stderrCapture.length = 0
    recordStartupError('fail', 'no-disk-write', undefined, { logDir: impossibleDir })

    // The main message AND the warning should both appear on stderr.
    const stderrLines = drainStderr()
    expect(stderrLines.length).toBeGreaterThanOrEqual(1)
    const combined = stderrLines.join('\n')
    expect(combined).toContain('no-disk-write')
  })

  test('documented warning line is emitted to stderr identifying the target path', () => {
    const blockingFile = join(tempDir, 'blocker3')
    writeFileSync(blockingFile, 'file\n', 'utf-8')
    const impossibleDir = join(blockingFile, 'subdir')
    const expectedLogPath = join(impossibleDir, 'startup-errors.log')

    stderrCapture.length = 0
    recordStartupError('fail', 'warn-test', undefined, { logDir: impossibleDir })

    const stderrLines = drainStderr()
    // At least one warning line must reference the target log path
    const combined = stderrLines.join('\n')
    expect(combined).toContain(expectedLogPath)
  })

  test('no exception propagates on any I/O failure path', () => {
    // Even with a completely inaccessible path (component is a file), no throw.
    const blockingFile = join(tempDir, 'blocker4')
    writeFileSync(blockingFile, 'x\n', 'utf-8')
    const impossibleDir = join(blockingFile, 'deep', 'path')

    expect(() => {
      recordStartupError('nothrow', 'io failure', new Error('simulated'), { logDir: impossibleDir })
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// cause field
// ---------------------------------------------------------------------------

describe('recordStartupError — cause field', () => {
  test('Error cause appears in log line', () => {
    const cause = new Error('root cause here')
    recordStartupError('err', 'with cause', cause, { logDir: tempDir })
    const lines = readLogLines(tempDir)
    expect(lines[0]).toContain('root cause here')
  })

  test('string cause appears in log line', () => {
    recordStartupError('err', 'with string cause', 'string-cause-value', { logDir: tempDir })
    const lines = readLogLines(tempDir)
    expect(lines[0]).toContain('string-cause-value')
  })

  test('undefined cause does not add extraneous text', () => {
    recordStartupError('err', 'no cause', undefined, { logDir: tempDir })
    const lines = readLogLines(tempDir)
    // Line should just end after the message — no ' — ' separator without a cause
    expect(lines[0]).not.toContain(' — ')
  })
})
