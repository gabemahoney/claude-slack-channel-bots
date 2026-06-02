/**
 * trust-bootstrap.test.ts — Unit tests for src/trust-bootstrap.ts
 *
 * Uses real file I/O with mkdtempSync per-test temp directories.
 * Does NOT mock fs or startup-errors. Instead redirects SLACK_STATE_DIR to a
 * temp dir per test so recordStartupError writes are captured via the log file
 * — same pattern as session-manager.test.ts b.yy6 tests.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RoutingConfig } from '../src/config.ts'
import { trustBootstrap } from '../src/trust-bootstrap.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'trust-bootstrap-test-'))
}

function writeClaudeJson(dir: string, data: object): void {
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(data, null, 2), 'utf-8')
}

function readClaudeJson(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf-8')) as Record<string, unknown>
}

function makeConfig(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    routes: {},
    bind: '127.0.0.1',
    port: 3100,
    session_restart_delay: 60,
    health_check_interval: 120,
    exit_timeout: 120,
    stop_timeout: 30,
    mcp_config_path: '/tmp/test-mcp.json',
    cozempic_prescription: 'standard',
    system_prompt_mode: 'append',
    resume_enabled: true,
    agent_director_poll_interval_ms: 1000,
    ...overrides,
  }
}

/**
 * Redirect startup-errors.log into a fresh temp dir and return a reader.
 * Restore SLACK_STATE_DIR in afterEach via savedEnv.
 */
function captureStartupErrors(logDir: string): () => string {
  process.env['SLACK_STATE_DIR'] = logDir
  const logPath = join(logDir, 'startup-errors.log')
  return () => (existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '')
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tempDirs: string[] = []
let savedEnv: typeof process.env

function newTempDir(): string {
  const d = makeTempDir()
  tempDirs.push(d)
  return d
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('trustBootstrap', () => {
  beforeEach(() => {
    savedEnv = { ...process.env }
  })

  afterEach(() => {
    process.env = savedEnv as NodeJS.ProcessEnv
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true }) } catch { /* ignore */ }
    }
    tempDirs = []
  })

  // -------------------------------------------------------------------------
  // Case 1: Missing project entry → created with both flags true
  // -------------------------------------------------------------------------

  test('missing project entry is created with hasTrustDialogAccepted=true and hasCompletedProjectOnboarding=true', async () => {
    const configDir = newTempDir()
    const cwd = '/tmp/test-cwd-missing-entry'

    // .claude.json exists but has no projects entry for this cwd
    writeClaudeJson(configDir, { projects: { '/other/cwd': { hasTrustDialogAccepted: true } } })

    const config = makeConfig({
      claude_config_dir: configDir,
      routes: { 'C_TEST': { cwd } },
    })

    await trustBootstrap(config)

    const doc = readClaudeJson(configDir)
    const projects = doc.projects as Record<string, Record<string, unknown>>
    expect(projects[cwd]).toBeDefined()
    expect(projects[cwd]!.hasTrustDialogAccepted).toBe(true)
    expect(projects[cwd]!.hasCompletedProjectOnboarding).toBe(true)
    // Existing entries are preserved
    expect(projects['/other/cwd']).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // Case 2: Existing false → flipped to true
  // -------------------------------------------------------------------------

  test('existing false flags are flipped to true', async () => {
    const configDir = newTempDir()
    const cwd = '/tmp/test-cwd-false-flags'

    writeClaudeJson(configDir, {
      projects: {
        [cwd]: {
          hasTrustDialogAccepted: false,
          hasCompletedProjectOnboarding: false,
          someOtherKey: 'preserved',
        },
      },
    })

    const config = makeConfig({
      claude_config_dir: configDir,
      routes: { 'C_ALPHA': { cwd } },
    })

    await trustBootstrap(config)

    const doc = readClaudeJson(configDir)
    const projects = doc.projects as Record<string, Record<string, unknown>>
    expect(projects[cwd]!.hasTrustDialogAccepted).toBe(true)
    expect(projects[cwd]!.hasCompletedProjectOnboarding).toBe(true)
    // Unrelated keys survive the patch
    expect(projects[cwd]!.someOtherKey).toBe('preserved')
  })

  // -------------------------------------------------------------------------
  // Case 3: Already true → no rewrite (idempotency via mtime)
  // -------------------------------------------------------------------------

  test('file is not rewritten when both flags are already true (mtime unchanged)', async () => {
    const configDir = newTempDir()
    const cwd = '/tmp/test-cwd-idempotent'

    writeClaudeJson(configDir, {
      projects: {
        [cwd]: {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    })

    const configPath = join(configDir, '.claude.json')
    const mtimeBefore = statSync(configPath).mtimeMs

    const config = makeConfig({
      claude_config_dir: configDir,
      routes: { 'C_IDEM': { cwd } },
    })

    await trustBootstrap(config)

    const mtimeAfter = statSync(configPath).mtimeMs
    expect(mtimeAfter).toBe(mtimeBefore)
  })

  // -------------------------------------------------------------------------
  // Case 4: Missing .claude.json → soft skip + recordStartupError
  // -------------------------------------------------------------------------

  test('missing .claude.json causes recordStartupError and no throw, file not created', async () => {
    const configDir = newTempDir()
    const logDir = newTempDir()
    const cwd = '/tmp/test-cwd-no-file'
    const configPath = join(configDir, '.claude.json')

    const readLog = captureStartupErrors(logDir)

    // Deliberately do NOT write .claude.json

    const config = makeConfig({
      claude_config_dir: configDir,
      routes: { 'C_NOJSON': { cwd } },
    })

    // Must not throw
    await expect(trustBootstrap(config)).resolves.toBeUndefined()

    // File must NOT have been auto-created
    expect(existsSync(configPath)).toBe(false)

    // recordStartupError must have been called with the missing-config tag
    const log = readLog()
    expect(log).toContain('[trust-bootstrap-config-missing]')
    // Message must name the channel and the config path
    expect(log).toContain('C_NOJSON')
    expect(log).toContain(configPath)
  })

  // -------------------------------------------------------------------------
  // Case 5: Per-route claude_config_dir overrides top-level
  // -------------------------------------------------------------------------

  test('per-route claude_config_dir overrides top-level claude_config_dir', async () => {
    const dirA = newTempDir()   // top-level / route A
    const dirB = newTempDir()   // per-route override for route B
    const cwdA = '/tmp/test-cwd-route-a'
    const cwdB = '/tmp/test-cwd-route-b'

    writeClaudeJson(dirA, { projects: {} })
    writeClaudeJson(dirB, { projects: {} })

    const config = makeConfig({
      claude_config_dir: dirA,
      routes: {
        'C_ROUTE_A': { cwd: cwdA },
        'C_ROUTE_B': { cwd: cwdB, claude_config_dir: dirB },
      },
    })

    await trustBootstrap(config)

    // dirA's .claude.json should have cwdA patched (route A uses top-level)
    const docA = readClaudeJson(dirA)
    const projectsA = docA.projects as Record<string, Record<string, unknown>>
    expect(projectsA[cwdA]?.hasTrustDialogAccepted).toBe(true)
    expect(projectsA[cwdA]?.hasCompletedProjectOnboarding).toBe(true)
    // dirA must NOT contain cwdB
    expect(projectsA[cwdB]).toBeUndefined()

    // dirB's .claude.json should have cwdB patched (route B overrides)
    const docB = readClaudeJson(dirB)
    const projectsB = docB.projects as Record<string, Record<string, unknown>>
    expect(projectsB[cwdB]?.hasTrustDialogAccepted).toBe(true)
    expect(projectsB[cwdB]?.hasCompletedProjectOnboarding).toBe(true)
    // dirB must NOT contain cwdA
    expect(projectsB[cwdA]).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Case 6 (additional): Malformed JSON → recordStartupError, no throw
  // -------------------------------------------------------------------------
  // Engineer implemented a dedicated 'trust-bootstrap-config-parse' error tag
  // for malformed JSON. Covered here since it's a real code path not in the
  // original five cases.

  test('malformed JSON in .claude.json causes recordStartupError and no throw', async () => {
    const configDir = newTempDir()
    const logDir = newTempDir()
    const cwd = '/tmp/test-cwd-bad-json'

    writeFileSync(join(configDir, '.claude.json'), '{ not valid json }', 'utf-8')

    const readLog = captureStartupErrors(logDir)

    const config = makeConfig({
      claude_config_dir: configDir,
      routes: { 'C_BADJSON': { cwd } },
    })

    await expect(trustBootstrap(config)).resolves.toBeUndefined()

    const log = readLog()
    expect(log).toContain('[trust-bootstrap-config-parse]')
    expect(log).toContain('C_BADJSON')
  })

  // -------------------------------------------------------------------------
  // Case 7: No claude_config_dir anywhere → silent skip, no error logged
  // -------------------------------------------------------------------------
  // When neither the route nor the top-level RoutingConfig has a
  // claude_config_dir, bootstrapRoute logs an info line and returns
  // silently without calling recordStartupError or touching any file.

  test('no claude_config_dir anywhere causes silent skip with no error logged and no file created', async () => {
    const logDir = newTempDir()
    const tempDir = newTempDir()
    const cwd = '/tmp/test-cwd-no-config-dir'

    const readLog = captureStartupErrors(logDir)

    // No claude_config_dir at top level or per-route
    const config = makeConfig({
      routes: { 'C_NODIR': { cwd } },
    })

    // Must not throw
    await expect(trustBootstrap(config)).resolves.toBeUndefined()

    // No startup error must have been recorded
    const log = readLog()
    expect(log).not.toContain('trust-bootstrap')

    // No .claude.json created in our temp dir (sanity check)
    expect(existsSync(join(tempDir, '.claude.json'))).toBe(false)
  })
})
