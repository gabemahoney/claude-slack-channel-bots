/**
 * postinstall.test.ts — Tests for runPostinstall() scaffold function.
 *
 * Uses mkdtempSync() temp directories so no real home-directory files are
 * created or modified.  process.env is saved and restored after each test
 * so SLACK_STATE_DIR overrides do not bleed across tests.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runPostinstall } from '../src/postinstall.ts'
import { defaultAccess } from '../src/lib.ts'
import { MCP_SERVER_NAME } from '../src/config.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save/restore process.env around each test. */
let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
})

afterEach(() => {
  process.env = savedEnv as NodeJS.ProcessEnv
})

/** Create a fresh temp dir for each test invocation. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'postinstall-test-'))
}

/** Read and parse a JSON file from disk. */
function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf-8'))
}

/** Return the octal permissions bits for a file (e.g. 0o600). */
function fileMode(filePath: string): number {
  return statSync(filePath).mode & 0o777
}

// ---------------------------------------------------------------------------
// Directory creation
// ---------------------------------------------------------------------------

describe('directory creation', () => {
  test('creates STATE_DIR when it does not exist', () => {
    const baseDir = makeTempDir()
    const stateDir = join(baseDir, 'nested', 'state')

    runPostinstall({ stateDir, mcpConfigPath: join(baseDir, 'slack-mcp.json') })

    expect(existsSync(stateDir)).toBe(true)
  })

  test('creates MCP config parent directory when it does not exist', () => {
    const baseDir = makeTempDir()
    const stateDir = join(baseDir, 'state')
    const mcpConfigPath = join(baseDir, 'deep', 'nested', 'slack-mcp.json')

    runPostinstall({ stateDir, mcpConfigPath })

    expect(existsSync(join(baseDir, 'deep', 'nested'))).toBe(true)
  })

  test('does not throw when STATE_DIR already exists', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()

    expect(() =>
      runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

describe('config.json — creation', () => {
  test('creates config.json in STATE_DIR', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()

    runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    expect(existsSync(join(stateDir, 'config.json'))).toBe(true)
  })

  test('config.json contains {"routes": {}}', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()

    runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    const content = readJson(join(stateDir, 'config.json'))
    expect(content).toEqual({ routes: {} })
  })
})

describe('config.json — skip if exists', () => {
  test('does not overwrite config.json when it already exists', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const configPath = join(stateDir, 'config.json')

    // First run creates it
    runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })
    const originalContent = readFileSync(configPath, 'utf-8')

    // Manually modify the file

    writeFileSync(configPath, JSON.stringify({ routes: { C_TEST: { cwd: '/tmp' } } }, null, 2) + '\n')
    const modifiedContent = readFileSync(configPath, 'utf-8')

    // Second run — should not overwrite
    runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })
    const afterSecondRun = readFileSync(configPath, 'utf-8')

    expect(afterSecondRun).toBe(modifiedContent)
    expect(afterSecondRun).not.toBe(originalContent)
  })
})

// ---------------------------------------------------------------------------
// routing.json → config.json migration
// ---------------------------------------------------------------------------

describe('migration: routing.json → config.json', () => {
  test('renames routing.json to config.json when routing.json exists and config.json does not', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const legacyPath = join(stateDir, 'routing.json')
    const configPath = join(stateDir, 'config.json')

    // Seed a legacy routing.json
    const legacyContent = JSON.stringify({ routes: { C_OLD: { cwd: '/tmp/old' } } }, null, 2) + '\n'
    writeFileSync(legacyPath, legacyContent)

    runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    // routing.json should be gone and config.json should exist with same content
    expect(existsSync(legacyPath)).toBe(false)
    expect(existsSync(configPath)).toBe(true)
    expect(readFileSync(configPath, 'utf-8')).toBe(legacyContent)
  })

  test('does not overwrite config.json when both routing.json and config.json exist', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const legacyPath = join(stateDir, 'routing.json')
    const configPath = join(stateDir, 'config.json')

    // Seed both files with distinct content
    const legacyContent = JSON.stringify({ routes: { C_OLD: { cwd: '/tmp/old' } } }, null, 2) + '\n'
    const existingContent = JSON.stringify({ routes: { C_NEW: { cwd: '/tmp/new' } } }, null, 2) + '\n'
    writeFileSync(legacyPath, legacyContent)
    writeFileSync(configPath, existingContent)

    runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    // config.json is unchanged and routing.json is left in place
    expect(readFileSync(configPath, 'utf-8')).toBe(existingContent)
    expect(existsSync(legacyPath)).toBe(true)
  })

  test('fresh install (neither file exists) creates skeleton config.json', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const configPath = join(stateDir, 'config.json')

    runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    expect(existsSync(configPath)).toBe(true)
    const content = readJson(configPath)
    expect(content).toEqual({ routes: {} })
  })
})

// ---------------------------------------------------------------------------
// access.json
// ---------------------------------------------------------------------------

describe('access.json — creation', () => {
  test('creates access.json in STATE_DIR', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()

    runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    expect(existsSync(join(stateDir, 'access.json'))).toBe(true)
  })

  test('access.json content matches defaultAccess()', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()

    runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    const content = readJson(join(stateDir, 'access.json'))
    expect(content).toEqual(defaultAccess())
  })

  test('access.json has permissions 0o600', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()

    runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    expect(fileMode(join(stateDir, 'access.json'))).toBe(0o600)
  })
})

describe('access.json — skip if exists', () => {
  test('does not overwrite access.json when it already exists', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const accessPath = join(stateDir, 'access.json')

    // First run creates it
    runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    // Manually modify the file

    const customContent = JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U123'], channels: {}, pending: {} }, null, 2) + '\n'
    writeFileSync(accessPath, customContent, { mode: 0o600 })

    // Second run — should not overwrite
    runPostinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })
    const afterSecondRun = readFileSync(accessPath, 'utf-8')

    expect(afterSecondRun).toBe(customContent)
  })
})

// ---------------------------------------------------------------------------
// slack-mcp.json
// ---------------------------------------------------------------------------

describe('slack-mcp.json — creation', () => {
  test('creates slack-mcp.json at the specified path', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const mcpConfigPath = join(mcpDir, 'slack-mcp.json')

    runPostinstall({ stateDir, mcpConfigPath })

    expect(existsSync(mcpConfigPath)).toBe(true)
  })

  test('slack-mcp.json contains mcpServers.slack-channel-router with http type', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const mcpConfigPath = join(mcpDir, 'slack-mcp.json')

    runPostinstall({ stateDir, mcpConfigPath })

    const content = readJson(mcpConfigPath) as Record<string, unknown>
    const servers = content['mcpServers'] as Record<string, unknown>
    expect(servers).toBeDefined()
    expect(servers[MCP_SERVER_NAME]).toBeDefined()
    const router = servers[MCP_SERVER_NAME] as Record<string, unknown>
    expect(router['type']).toBe('http')
  })

  test('slack-mcp.json router url points to localhost 3100', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const mcpConfigPath = join(mcpDir, 'slack-mcp.json')

    runPostinstall({ stateDir, mcpConfigPath })

    const content = readJson(mcpConfigPath) as Record<string, unknown>
    const servers = content['mcpServers'] as Record<string, unknown>
    const router = servers[MCP_SERVER_NAME] as Record<string, unknown>
    expect(router['url']).toBe('http://127.0.0.1:3100/mcp')
  })
})

describe('slack-mcp.json — skip if exists', () => {
  test('does not overwrite slack-mcp.json when it already exists', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const mcpConfigPath = join(mcpDir, 'slack-mcp.json')

    // First run creates it
    runPostinstall({ stateDir, mcpConfigPath })

    // Manually modify the file

    const customContent = JSON.stringify({ mcpServers: { custom: { type: 'stdio', command: 'foo' } } }, null, 2) + '\n'
    writeFileSync(mcpConfigPath, customContent)

    // Second run — should not overwrite
    runPostinstall({ stateDir, mcpConfigPath })
    const afterSecondRun = readFileSync(mcpConfigPath, 'utf-8')

    expect(afterSecondRun).toBe(customContent)
  })
})

// ---------------------------------------------------------------------------
// SLACK_STATE_DIR override
// ---------------------------------------------------------------------------

describe('SLACK_STATE_DIR env override', () => {
  test('uses SLACK_STATE_DIR when no stateDir option is provided', () => {
    const customStateDir = makeTempDir()
    const mcpDir = makeTempDir()

    process.env['SLACK_STATE_DIR'] = customStateDir

    runPostinstall({ mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    expect(existsSync(join(customStateDir, 'config.json'))).toBe(true)
  })

  test('stateDir option takes precedence over SLACK_STATE_DIR env var', () => {
    const envStateDir = makeTempDir()
    const optStateDir = makeTempDir()
    const mcpDir = makeTempDir()

    process.env['SLACK_STATE_DIR'] = envStateDir

    runPostinstall({ stateDir: optStateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    // Files should appear in optStateDir, not envStateDir
    expect(existsSync(join(optStateDir, 'config.json'))).toBe(true)
    expect(existsSync(join(envStateDir, 'config.json'))).toBe(false)
  })

  test('creates config.json in SLACK_STATE_DIR path', () => {
    const customStateDir = makeTempDir()
    const mcpDir = makeTempDir()

    process.env['SLACK_STATE_DIR'] = customStateDir

    runPostinstall({ mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    const content = readJson(join(customStateDir, 'config.json'))
    expect(content).toEqual({ routes: {} })
  })

  test('creates access.json in SLACK_STATE_DIR path', () => {
    const customStateDir = makeTempDir()
    const mcpDir = makeTempDir()

    process.env['SLACK_STATE_DIR'] = customStateDir

    runPostinstall({ mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    expect(existsSync(join(customStateDir, 'access.json'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// No-overwrite: running twice doesn't modify existing files
// ---------------------------------------------------------------------------

describe('no-overwrite — running twice', () => {
  test('config.json is unchanged after second run', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const opts = { stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') }

    runPostinstall(opts)
    const afterFirst = readFileSync(join(stateDir, 'config.json'), 'utf-8')

    runPostinstall(opts)
    const afterSecond = readFileSync(join(stateDir, 'config.json'), 'utf-8')

    expect(afterSecond).toBe(afterFirst)
  })

  test('access.json is unchanged after second run', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const opts = { stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') }

    runPostinstall(opts)
    const afterFirst = readFileSync(join(stateDir, 'access.json'), 'utf-8')

    runPostinstall(opts)
    const afterSecond = readFileSync(join(stateDir, 'access.json'), 'utf-8')

    expect(afterSecond).toBe(afterFirst)
  })

  test('slack-mcp.json is unchanged after second run', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const mcpConfigPath = join(mcpDir, 'slack-mcp.json')
    const opts = { stateDir, mcpConfigPath }

    runPostinstall(opts)
    const afterFirst = readFileSync(mcpConfigPath, 'utf-8')

    runPostinstall(opts)
    const afterSecond = readFileSync(mcpConfigPath, 'utf-8')

    expect(afterSecond).toBe(afterFirst)
  })

  test('all three files exist after second run', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const mcpConfigPath = join(mcpDir, 'slack-mcp.json')
    const opts = { stateDir, mcpConfigPath }

    runPostinstall(opts)
    runPostinstall(opts)

    expect(existsSync(join(stateDir, 'config.json'))).toBe(true)
    expect(existsSync(join(stateDir, 'access.json'))).toBe(true)
    expect(existsSync(mcpConfigPath)).toBe(true)
  })
})
