/**
 * pid.test.ts — Tests for PID file lifecycle management.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isProcessRunning, checkPidConflict, writePidFile, removePidFile } from './pid.ts'

// ---------------------------------------------------------------------------
// Test isolation helpers
// ---------------------------------------------------------------------------

let tempDir: string
let pidFile: string

/** Capture arrays for stubbed side effects. */
let errorMessages: string[]
let exitCodes: number[]

/** Storage for original globals replaced in beforeEach. */
let orig_console_error: typeof console.error
let orig_process_exit: typeof process.exit

/** Sentinel error thrown by our process.exit stub so tests can catch it. */
class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`)
    this.name = 'ExitError'
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'pid-test-'))
  pidFile = join(tempDir, 'server.pid')

  errorMessages = []
  exitCodes = []

  orig_console_error = console.error
  console.error = (...args: unknown[]) => {
    errorMessages.push(args.map(String).join(' '))
  }

  orig_process_exit = process.exit
  process.exit = ((code?: number) => {
    exitCodes.push(code ?? 0)
    throw new ExitError(code ?? 0)
  }) as typeof process.exit
})

afterEach(() => {
  console.error = orig_console_error
  process.exit = orig_process_exit
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run checkPidConflict() catching ExitError, return the error or null. */
function runCheckPidConflict(path: string): ExitError | null {
  try {
    checkPidConflict(path)
    return null
  } catch (e) {
    if (e instanceof ExitError) return e
    throw e
  }
}

// ---------------------------------------------------------------------------
// writePidFile()
// ---------------------------------------------------------------------------

describe('writePidFile', () => {
  test('file exists after write', () => {
    writePidFile(pidFile)
    expect(existsSync(pidFile)).toBe(true)
  })

  test('file contains the current process PID', () => {
    writePidFile(pidFile)
    const raw = readFileSync(pidFile, 'utf-8')
    expect(parseInt(raw.trim(), 10)).toBe(process.pid)
  })

  test('file content ends with a trailing newline', () => {
    writePidFile(pidFile)
    const raw = readFileSync(pidFile, 'utf-8')
    expect(raw.endsWith('\n')).toBe(true)
  })

  test('file contains exactly "<pid>\\n" with no extra whitespace', () => {
    writePidFile(pidFile)
    const raw = readFileSync(pidFile, 'utf-8')
    expect(raw).toBe(`${process.pid}\n`)
  })
})

// ---------------------------------------------------------------------------
// removePidFile()
// ---------------------------------------------------------------------------

describe('removePidFile', () => {
  test('file is removed after cleanup call', () => {
    writePidFile(pidFile)
    removePidFile(pidFile)
    expect(existsSync(pidFile)).toBe(false)
  })

  test('does not throw when file is already gone', () => {
    expect(() => removePidFile(pidFile)).not.toThrow()
  })

  test('does not throw when called twice on the same path', () => {
    writePidFile(pidFile)
    removePidFile(pidFile)
    expect(() => removePidFile(pidFile)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// isProcessRunning()
// ---------------------------------------------------------------------------

describe('isProcessRunning', () => {
  test('returns true for the current process PID', () => {
    expect(isProcessRunning(process.pid)).toBe(true)
  })

  test('returns false for a PID that is not running', () => {
    // PID 0 is the kernel scheduler — kill(0, 0) sends to the process group,
    // which would return true. Use a large PID that is almost certainly unused.
    // We rely on isProcessRunning returning false for a clearly invalid PID.
    expect(isProcessRunning(999999999)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// checkPidConflict() — no PID file
// ---------------------------------------------------------------------------

describe('checkPidConflict — no PID file', () => {
  test('does not exit when no PID file is present', () => {
    const exitError = runCheckPidConflict(pidFile)
    expect(exitError).toBeNull()
  })

  test('does not call process.exit when no PID file is present', () => {
    runCheckPidConflict(pidFile)
    expect(exitCodes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// checkPidConflict() — stale PID (process not running)
// ---------------------------------------------------------------------------

describe('checkPidConflict — stale PID file', () => {
  test('stale PID file is removed when process is not running', () => {
    writeFileSync(pidFile, '999999999\n', 'utf-8')
    runCheckPidConflict(pidFile)
    expect(existsSync(pidFile)).toBe(false)
  })

  test('does not exit when PID file contains a stale PID', () => {
    writeFileSync(pidFile, '999999999\n', 'utf-8')
    const exitError = runCheckPidConflict(pidFile)
    expect(exitError).toBeNull()
  })

  test('does not call process.exit for a stale PID', () => {
    writeFileSync(pidFile, '999999999\n', 'utf-8')
    runCheckPidConflict(pidFile)
    expect(exitCodes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// checkPidConflict() — running PID (conflict detected)
// ---------------------------------------------------------------------------

describe('checkPidConflict — running PID (conflict)', () => {
  test('calls process.exit(1) when PID file contains the running current PID', () => {
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8')
    const exitError = runCheckPidConflict(pidFile)
    expect(exitError).not.toBeNull()
    expect(exitError!.code).toBe(1)
  })

  test('exit code is 1 when a conflict is detected', () => {
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8')
    runCheckPidConflict(pidFile)
    expect(exitCodes).toEqual([1])
  })

  test('logs a [slack]-prefixed error message on conflict', () => {
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8')
    runCheckPidConflict(pidFile)
    expect(errorMessages.some(m => m.includes('[slack]'))).toBe(true)
  })

  test('error message mentions the conflicting PID', () => {
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8')
    runCheckPidConflict(pidFile)
    expect(errorMessages.some(m => m.includes(String(process.pid)))).toBe(true)
  })

  test('PID file is not removed when process is still running', () => {
    writeFileSync(pidFile, `${process.pid}\n`, 'utf-8')
    runCheckPidConflict(pidFile)
    expect(existsSync(pidFile)).toBe(true)
  })
})
