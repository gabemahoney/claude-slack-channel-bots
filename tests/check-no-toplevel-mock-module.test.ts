/**
 * check-no-toplevel-mock-module.test.ts — exercises the CI gate script.
 *
 * Two cases:
 *   1. Clean: invoke the script with repo root as cwd → exit 0, OK on stderr.
 *   2. Dirty: create a temp dir with a leaky tests/ file, invoke script there
 *      → exit 1, violation message on stderr.
 *
 * Uses real spawnSync on the real script — no mock.module() usage, which is
 * exactly the pattern this gate enforces.
 *
 * Bug reference: b.5wd — "add CI gate against top-level mock.module() in tests/"
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = resolve(import.meta.dir, '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-no-toplevel-mock-module.ts')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runScript(cwd: string): { exitCode: number; stderr: string } {
  const result = spawnSync('bun', [SCRIPT], { cwd, encoding: 'utf-8' })
  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? '',
  }
}

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let tempDir: string | null = null

afterEach(() => {
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('check-no-toplevel-mock-module CI gate', () => {
  test('clean repo root: exits 0 and emits OK message', () => {
    const { exitCode, stderr } = runScript(REPO_ROOT)
    expect(exitCode).toBe(0)
    expect(stderr).toContain('OK')
    expect(stderr).toContain('0 violations')
  })

  test('dirty temp dir with top-level mock.module(): exits 1 and reports violation', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'b5wd-gate-test-'))
    const testsDir = join(tempDir, 'tests')
    mkdirSync(testsDir, { recursive: true })

    // Write a leaky test file — top-level mock.module() at column 0
    writeFileSync(
      join(testsDir, 'leaky.test.ts'),
      [
        "import { describe, test, expect } from 'bun:test'",
        "import { mock } from 'bun:test'",
        '',
        "mock.module('child_process', () => ({}))",
        '',
        "describe('leaky', () => {",
        "  test('noop', () => { expect(true).toBe(true) })",
        '})',
      ].join('\n'),
    )

    const { exitCode, stderr } = runScript(tempDir)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('violation')
    expect(stderr).toContain('leaky.test.ts')
  })

  test('dirty temp dir with top-level mock.restore(): exits 1 and reports violation', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'b5wd-gate-test-'))
    const testsDir = join(tempDir, 'tests')
    mkdirSync(testsDir, { recursive: true })

    // Write a leaky test file — top-level mock.restore() at column 0
    writeFileSync(
      join(testsDir, 'leaky-restore.test.ts'),
      [
        "import { describe, test, expect } from 'bun:test'",
        "import { mock } from 'bun:test'",
        '',
        'mock.restore()',
        '',
        "describe('leaky-restore', () => {",
        "  test('noop', () => { expect(true).toBe(true) })",
        '})',
      ].join('\n'),
    )

    const { exitCode, stderr } = runScript(tempDir)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('violation')
    expect(stderr).toContain('mock.restore')
    expect(stderr).toContain('leaky-restore.test.ts')
  })
})
