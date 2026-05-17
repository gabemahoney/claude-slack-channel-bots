/**
 * trust-bootstrap.test.ts — Tests for bootstrapTrust()
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bootstrapTrust } from '../src/trust-bootstrap.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'trust-bootstrap-test-'))
}

function writeClaudeJson(dir: string, content: object): void {
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(content, null, 2), 'utf-8')
}

function readClaudeJson(dir: string): object {
  return JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf-8'))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let dirs: string[] = []

beforeEach(() => {
  dirs = []
})

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
})

describe('bootstrapTrust', () => {
  test('1. missing project entry → created with both flags true, unrelated entry untouched', () => {
    const dir = makeTempDir()
    dirs.push(dir)

    writeClaudeJson(dir, {
      projects: {
        '/some/other': { hasTrustDialogAccepted: true },
      },
    })

    const config = makeRoutingConfig({
      claude_config_dir: dir,
      routes: {
        'C_TEST1': { cwd: '/the/cwd' },
      },
    })

    bootstrapTrust(config)

    const result = readClaudeJson(dir) as { projects: Record<string, Record<string, unknown>> }
    expect(result.projects['/the/cwd'].hasTrustDialogAccepted).toBe(true)
    expect(result.projects['/the/cwd'].hasCompletedProjectOnboarding).toBe(true)
    expect(result.projects['/some/other'].hasTrustDialogAccepted).toBe(true)
  })

  test('2. existing entry with flags false → flipped to true, other fields preserved', () => {
    const dir = makeTempDir()
    dirs.push(dir)

    writeClaudeJson(dir, {
      projects: {
        '/the/cwd': {
          hasTrustDialogAccepted: false,
          hasCompletedProjectOnboarding: false,
          someOtherField: 'keep-me',
        },
      },
    })

    const config = makeRoutingConfig({
      claude_config_dir: dir,
      routes: {
        'C_TEST1': { cwd: '/the/cwd' },
      },
    })

    bootstrapTrust(config)

    const result = readClaudeJson(dir) as { projects: Record<string, Record<string, unknown>> }
    expect(result.projects['/the/cwd'].hasTrustDialogAccepted).toBe(true)
    expect(result.projects['/the/cwd'].hasCompletedProjectOnboarding).toBe(true)
    expect(result.projects['/the/cwd'].someOtherField).toBe('keep-me')
  })

  test('3. both flags already true → file bytes unchanged (idempotent)', () => {
    const dir = makeTempDir()
    dirs.push(dir)

    writeClaudeJson(dir, {
      projects: {
        '/the/cwd': {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    })

    const before = readFileSync(join(dir, '.claude.json'), 'utf-8')

    const config = makeRoutingConfig({
      claude_config_dir: dir,
      routes: {
        'C_TEST1': { cwd: '/the/cwd' },
      },
    })

    bootstrapTrust(config)

    const after = readFileSync(join(dir, '.claude.json'), 'utf-8')
    expect(after).toBe(before)
  })

  test('4. missing .claude.json → soft skip with log, no throw, no file created', () => {
    const dir = makeTempDir()
    dirs.push(dir)
    // No .claude.json written — dir is empty

    const originalError = console.error
    const logs: string[] = []
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '))

    let threw = false
    try {
      const config = makeRoutingConfig({
        claude_config_dir: dir,
        routes: {
          'C_TEST1': { cwd: '/the/cwd' },
        },
      })
      bootstrapTrust(config)
    } catch {
      threw = true
    } finally {
      console.error = originalError
    }

    expect(threw).toBe(false)
    expect(existsSync(join(dir, '.claude.json'))).toBe(false)
    expect(logs.some(l => l.includes('not found'))).toBe(true)
  })

  test('5. per-route claude_config_dir overrides top-level', () => {
    const dirA = makeTempDir()
    const dirB = makeTempDir()
    dirs.push(dirA, dirB)

    writeClaudeJson(dirA, { projects: {} })
    writeClaudeJson(dirB, { projects: {} })

    const config = makeRoutingConfig({
      claude_config_dir: dirA,
      routes: {
        'C_ROUTE1': { cwd: '/cwd/route1' },
        'C_ROUTE2': { cwd: '/cwd/route2', claude_config_dir: dirB },
      },
    })

    bootstrapTrust(config)

    const jsonA = readClaudeJson(dirA) as { projects: Record<string, Record<string, unknown>> }
    const jsonB = readClaudeJson(dirB) as { projects: Record<string, Record<string, unknown>> }

    // Route1 (no per-route override) → patched in dirA
    expect(jsonA.projects['/cwd/route1'].hasTrustDialogAccepted).toBe(true)
    expect(jsonA.projects['/cwd/route1'].hasCompletedProjectOnboarding).toBe(true)

    // Route2 (per-route override = dirB) → patched in dirB
    expect(jsonB.projects['/cwd/route2'].hasTrustDialogAccepted).toBe(true)
    expect(jsonB.projects['/cwd/route2'].hasCompletedProjectOnboarding).toBe(true)

    // Route2's cwd must NOT appear in dirA
    expect(jsonA.projects['/cwd/route2']).toBeUndefined()
  })

  test('6. multiple routes sharing a config dir, both already trusted → file unchanged (grouping + idempotency)', () => {
    const dir = makeTempDir()
    dirs.push(dir)

    writeClaudeJson(dir, {
      projects: {
        '/cwd/a': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
        '/cwd/b': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      },
    })

    const before = readFileSync(join(dir, '.claude.json'), 'utf-8')

    const config = makeRoutingConfig({
      claude_config_dir: dir,
      routes: {
        'C_A': { cwd: '/cwd/a' },
        'C_B': { cwd: '/cwd/b' },
      },
    })

    bootstrapTrust(config)

    const after = readFileSync(join(dir, '.claude.json'), 'utf-8')
    expect(after).toBe(before)
  })

  test('7. malformed JSON → soft skip, file content unchanged', () => {
    const dir = makeTempDir()
    dirs.push(dir)

    const badContent = 'not valid json'
    writeFileSync(join(dir, '.claude.json'), badContent, 'utf-8')

    const originalError = console.error
    const logs: string[] = []
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '))

    let threw = false
    try {
      const config = makeRoutingConfig({
        claude_config_dir: dir,
        routes: {
          'C_TEST1': { cwd: '/the/cwd' },
        },
      })
      bootstrapTrust(config)
    } catch {
      threw = true
    } finally {
      console.error = originalError
    }

    expect(threw).toBe(false)
    const afterContent = readFileSync(join(dir, '.claude.json'), 'utf-8')
    expect(afterContent).toBe(badContent)
    expect(logs.some(l => l.includes('malformed'))).toBe(true)
  })
})
