/**
 * cron-bootstrap.test.ts — Tests for the crontable bootstrap I/O module.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CRONTABLE_TEMPLATE_HEADER, ensureCrontableExists } from '../src/cron-bootstrap.ts'
import { parseCrontable } from '../src/crontable.ts'

// ---------------------------------------------------------------------------
// Test isolation
// ---------------------------------------------------------------------------

let tempDir: string
let cronPath: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cron-bootstrap-test-'))
  cronPath = join(tempDir, 'crontable')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Group 1 — missing file: created with exact template header
// ---------------------------------------------------------------------------

describe('ensureCrontableExists — missing file', () => {
  test('reports created', () => {
    expect(ensureCrontableExists(cronPath)).toEqual({ outcome: 'created' })
  })

  test('file exists after create', () => {
    ensureCrontableExists(cronPath)
    expect(existsSync(cronPath)).toBe(true)
  })

  test('file content equals the exported template header exactly', () => {
    ensureCrontableExists(cronPath)
    expect(readFileSync(cronPath, 'utf-8')).toBe(CRONTABLE_TEMPLATE_HEADER)
  })
})

// ---------------------------------------------------------------------------
// Group 2 — pre-existing adversarial content: untouched, already-exists
// ---------------------------------------------------------------------------

describe('ensureCrontableExists — pre-existing adversarial content', () => {
  test.each([
    ['no trailing newline', '0 9 * * * /p/a.md'],
    ['trailing whitespace', '0 9 * * * /p/a.md   \n'],
    ['CRLF line endings', '0 9 * * * /p/a.md\r\n0 * * * * /p/b.md\r\n'],
    ['non-header junk bytes', '\x00\x01not a crontable\xff\n'],
  ])('%s → already-exists, byte-for-byte untouched', (_label, content) => {
    writeFileSync(cronPath, content, 'latin1')
    const before = readFileSync(cronPath) // Buffer

    expect(ensureCrontableExists(cronPath)).toEqual({ outcome: 'already-exists' })

    const after = readFileSync(cronPath) // Buffer
    expect(after.equals(before)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Group 3 — EEXIST race (real fs): swallowed, content intact
// ---------------------------------------------------------------------------

describe('ensureCrontableExists — EEXIST race', () => {
  test('pre-created file forces wx EEXIST → already-exists, content intact', () => {
    const raced = '# a competing writer got here first\n0 * * * * /p/c.md\n'
    writeFileSync(cronPath, raced, 'utf-8')

    expect(ensureCrontableExists(cronPath)).toEqual({ outcome: 'already-exists' })
    expect(readFileSync(cronPath, 'utf-8')).toBe(raced)
  })
})

// ---------------------------------------------------------------------------
// Group 4 — non-EEXIST fs error: failed, no throw, no mkdir
// ---------------------------------------------------------------------------

describe('ensureCrontableExists — non-EEXIST fs error', () => {
  test('missing parent dir → failed with a cause; nothing thrown; no mkdir', () => {
    const missingParent = join(tempDir, 'does-not-exist')
    const target = join(missingParent, 'crontable')

    let result: ReturnType<typeof ensureCrontableExists>
    expect(() => {
      result = ensureCrontableExists(target)
    }).not.toThrow()

    expect(result!.outcome).toBe('failed')
    expect(result!.outcome === 'failed' && result!.cause.length).toBeGreaterThan(0)

    // No parent directory was created and no file was written.
    expect(existsSync(missingParent)).toBe(false)
    expect(existsSync(target)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Group 5 — header/parser integration
// ---------------------------------------------------------------------------

describe('CRONTABLE_TEMPLATE_HEADER — parser integration', () => {
  test('parseCrontable yields zero schedules and zero errors', () => {
    const result = parseCrontable(CRONTABLE_TEMPLATE_HEADER)
    expect(result.schedules).toEqual([])
    expect(result.errors).toEqual([])
  })
})
