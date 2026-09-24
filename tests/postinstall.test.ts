/**
 * postinstall.test.ts — Tests for runPostinstall() scaffold function.
 *
 * Every runPostinstall() and probe call runs in a child `bun` process
 * launched with HOME set to a fresh temp dir (`runInFakeHome`,
 * tests/test-helpers/fake-home-subprocess.ts). runPostinstall links skills
 * into `~/.claude/skills` and the probe opens `~/.agent-director/state.db`;
 * Bun reads HOME only at launch, so running them in this process would write
 * under the real home (b.av2 SR-13.2). The child also gets SLACK_STATE_DIR
 * from the test, never from the parent env. All temp dirs are removed in
 * afterEach.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { readAdDependencyRange, type PostinstallOptions } from '../src/postinstall.ts'
import { defaultAccess } from '../src/lib.ts'
import { MCP_SERVER_NAME, loadPersonaConfig } from '../src/config.ts'
import { runInFakeHome } from './test-helpers/fake-home-subprocess.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POSTINSTALL_SRC = fileURLToPath(new URL('../src/postinstall.ts', import.meta.url))

let tempDirs: string[] = []

afterEach(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  tempDirs = []
})

/** Create a fresh temp dir, removed in afterEach. */
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'postinstall-test-'))
  tempDirs.push(d)
  return d
}

/** The child's launch-time HOME and SLACK_STATE_DIR. */
interface ChildEnv {
  home: string
  envStateDir: string
}

/**
 * A fresh fake home. `envStateDir` is the child's SLACK_STATE_DIR; by default
 * a path nothing creates, so a stray write to it shows up in `existsSync`.
 */
function makeChildEnv(envStateDir?: string): ChildEnv {
  const home = makeTempDir()
  return { home, envStateDir: envStateDir ?? join(home, 'unused-env-state') }
}

/** Run a call against the postinstall module in a child under `env`; fail on a non-zero exit. */
function runInChild(call: string, input: unknown, env: ChildEnv): void {
  const res = runInFakeHome({
    modulePath: POSTINSTALL_SRC,
    call,
    input,
    home: env.home,
    stateDir: env.envStateDir,
  })
  // Control: the child really ran under the fake HOME.
  expect(res.observedHomedir).toBe(env.home)
  if (res.status !== 0) {
    throw new Error(`postinstall child exited with status ${res.status}\nstderr:\n${res.stderr}`)
  }
}

/** runPostinstall(opts) in a child whose HOME is `env.home` (a fresh one by default). */
function postinstall(opts: PostinstallOptions, env: ChildEnv = makeChildEnv()): void {
  runInChild('mod.runPostinstall(input)', opts, env)
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

    postinstall({ stateDir, mcpConfigPath: join(baseDir, 'slack-mcp.json') })

    expect(existsSync(stateDir)).toBe(true)
  })

  test('creates MCP config parent directory when it does not exist', () => {
    const baseDir = makeTempDir()
    const stateDir = join(baseDir, 'state')
    const mcpConfigPath = join(baseDir, 'deep', 'nested', 'slack-mcp.json')

    postinstall({ stateDir, mcpConfigPath })

    expect(existsSync(join(baseDir, 'deep', 'nested'))).toBe(true)
  })

  test('does not throw when STATE_DIR already exists', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()

    expect(() =>
      postinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

describe('config.json — creation', () => {
  test('a fresh install writes config.json as {"personas": []}, which loads through the persona loader with zero personas (b.av2 SR-1.7)', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const loaderHome = makeTempDir()

    postinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    const configPath = join(stateDir, 'config.json')
    expect(readJson(configPath)).toEqual({ personas: [] })
    // Explicit path and injected temp home: nothing resolves under the real home.
    const cfg = loadPersonaConfig(configPath, loaderHome)
    expect(cfg.personas).toEqual([])
    expect(Object.hasOwn(cfg, 'routes')).toBe(false)
  })
})

describe('config.json — skip if exists', () => {
  test('does not overwrite config.json when it already exists', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const configPath = join(stateDir, 'config.json')

    // First run creates it
    postinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })
    const originalContent = readFileSync(configPath, 'utf-8')

    // Manually modify the file
    const edited = {
      personas: [
        {
          name: 'edited',
          credentials_file: '/tmp/postinstall-test-unused/credentials.json',
          working_directory: '/tmp',
          channels: [{ id: 'C0TEST1', delivery: 'all' }],
          permission_prompts: 'C0TEST1',
        },
      ],
    }
    writeFileSync(configPath, JSON.stringify(edited, null, 2) + '\n')
    const modifiedContent = readFileSync(configPath, 'utf-8')

    // Second run — should not overwrite
    postinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })
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

    postinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

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

    postinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    // config.json is unchanged and routing.json is left in place
    expect(readFileSync(configPath, 'utf-8')).toBe(existingContent)
    expect(existsSync(legacyPath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// access.json
// ---------------------------------------------------------------------------

describe('access.json — creation', () => {
  test('creates access.json in STATE_DIR', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()

    postinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    expect(existsSync(join(stateDir, 'access.json'))).toBe(true)
  })

  test('access.json content matches defaultAccess()', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()

    postinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    const content = readJson(join(stateDir, 'access.json'))
    expect(content).toEqual(defaultAccess())
  })

  test('access.json has permissions 0o600', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()

    postinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    expect(fileMode(join(stateDir, 'access.json'))).toBe(0o600)
  })
})

describe('access.json — skip if exists', () => {
  test('does not overwrite access.json when it already exists', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const accessPath = join(stateDir, 'access.json')

    // First run creates it
    postinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })

    // Manually modify the file

    const customContent = JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U123'], channels: {}, pending: {} }, null, 2) + '\n'
    writeFileSync(accessPath, customContent, { mode: 0o600 })

    // Second run — should not overwrite
    postinstall({ stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') })
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

    postinstall({ stateDir, mcpConfigPath })

    expect(existsSync(mcpConfigPath)).toBe(true)
  })

  test('slack-mcp.json contains mcpServers.slack-channel-router with http type', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const mcpConfigPath = join(mcpDir, 'slack-mcp.json')

    postinstall({ stateDir, mcpConfigPath })

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

    postinstall({ stateDir, mcpConfigPath })

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
    postinstall({ stateDir, mcpConfigPath })

    // Manually modify the file

    const customContent = JSON.stringify({ mcpServers: { custom: { type: 'stdio', command: 'foo' } } }, null, 2) + '\n'
    writeFileSync(mcpConfigPath, customContent)

    // Second run — should not overwrite
    postinstall({ stateDir, mcpConfigPath })
    const afterSecondRun = readFileSync(mcpConfigPath, 'utf-8')

    expect(afterSecondRun).toBe(customContent)
  })
})

// ---------------------------------------------------------------------------
// SLACK_STATE_DIR override
// ---------------------------------------------------------------------------

describe('SLACK_STATE_DIR env override', () => {
  test('without a stateDir option, the config.json skeleton and access.json go to SLACK_STATE_DIR', () => {
    const customStateDir = makeTempDir()
    const mcpDir = makeTempDir()

    postinstall({ mcpConfigPath: join(mcpDir, 'slack-mcp.json') }, makeChildEnv(customStateDir))

    expect(readJson(join(customStateDir, 'config.json'))).toEqual({ personas: [] })
    expect(existsSync(join(customStateDir, 'access.json'))).toBe(true)
  })

  test('an empty SLACK_STATE_DIR counts as unset: the files go to <HOME>/.claude/channels/slack', () => {
    const env = makeChildEnv('')
    const mcpDir = makeTempDir()

    postinstall({ mcpConfigPath: join(mcpDir, 'slack-mcp.json') }, env)

    const homeStateDir = join(env.home, '.claude', 'channels', 'slack')
    expect(readJson(join(homeStateDir, 'config.json'))).toEqual({ personas: [] })
    expect(existsSync(join(homeStateDir, 'access.json'))).toBe(true)
  })

  test('a relative SLACK_STATE_DIR resolves against the working directory, as the server resolves it', () => {
    const env = makeChildEnv(join('rel', 'state'))
    const cwd = makeTempDir()
    const mcpDir = makeTempDir()

    runInChild(
      'process.chdir(input.cwd); mod.runPostinstall(input.opts)',
      { cwd, opts: { mcpConfigPath: join(mcpDir, 'slack-mcp.json') } },
      env,
    )

    expect(readJson(join(cwd, 'rel', 'state', 'config.json'))).toEqual({ personas: [] })
    expect(existsSync(join(env.home, '.claude', 'channels', 'slack'))).toBe(false)
  })

  test('stateDir option takes precedence over SLACK_STATE_DIR env var', () => {
    const envStateDir = makeTempDir()
    const optStateDir = makeTempDir()
    const mcpDir = makeTempDir()

    postinstall(
      { stateDir: optStateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') },
      makeChildEnv(envStateDir),
    )

    // Files should appear in optStateDir, not envStateDir
    expect(existsSync(join(optStateDir, 'config.json'))).toBe(true)
    expect(existsSync(join(envStateDir, 'config.json'))).toBe(false)
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
    const env = makeChildEnv()

    postinstall(opts, env)
    const afterFirst = readFileSync(join(stateDir, 'config.json'), 'utf-8')

    postinstall(opts, env)
    const afterSecond = readFileSync(join(stateDir, 'config.json'), 'utf-8')

    expect(afterSecond).toBe(afterFirst)
  })

  test('access.json is unchanged after second run', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const opts = { stateDir, mcpConfigPath: join(mcpDir, 'slack-mcp.json') }
    const env = makeChildEnv()

    postinstall(opts, env)
    const afterFirst = readFileSync(join(stateDir, 'access.json'), 'utf-8')

    postinstall(opts, env)
    const afterSecond = readFileSync(join(stateDir, 'access.json'), 'utf-8')

    expect(afterSecond).toBe(afterFirst)
  })

  test('slack-mcp.json is unchanged after second run', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const mcpConfigPath = join(mcpDir, 'slack-mcp.json')
    const opts = { stateDir, mcpConfigPath }
    const env = makeChildEnv()

    postinstall(opts, env)
    const afterFirst = readFileSync(mcpConfigPath, 'utf-8')

    postinstall(opts, env)
    const afterSecond = readFileSync(mcpConfigPath, 'utf-8')

    expect(afterSecond).toBe(afterFirst)
  })

  test('all three files exist after second run', () => {
    const stateDir = makeTempDir()
    const mcpDir = makeTempDir()
    const mcpConfigPath = join(mcpDir, 'slack-mcp.json')
    const opts = { stateDir, mcpConfigPath }
    const env = makeChildEnv()

    postinstall(opts, env)
    postinstall(opts, env)

    expect(existsSync(join(stateDir, 'config.json'))).toBe(true)
    expect(existsSync(join(stateDir, 'access.json'))).toBe(true)
    expect(existsSync(mcpConfigPath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SR-5.2: best-effort agent-director probe
// ---------------------------------------------------------------------------

describe('runAgentDirectorPostinstallProbe (SR-5.2)', () => {
  test('never throws; failures surface only as warnings', () => {
    // Whatever the host's state, the probe must complete without throwing —
    // postinstall must NEVER fail the npm install. We can't reliably make
    // the probe succeed in unit tests (real FFI + native libs), but we can
    // verify the no-throw contract under both happy and unhappy paths.
    // The child exits non-zero if the probe rejects or resolves to a value;
    // its `~/.agent-director` is the fake home's.
    runInChild(
      'const r = await mod.runAgentDirectorPostinstallProbe(); if (r !== undefined) process.exit(3);',
      null,
      makeChildEnv(),
    )
  })
})

// ---------------------------------------------------------------------------
// b.s4f: AD-missing warning derives range from package.json (no hard-coding)
// ---------------------------------------------------------------------------

describe('readAdDependencyRange (b.s4f)', () => {
  test('returns the range declared in this package.json', () => {
    const pkgPath = join(import.meta.dir, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>
    }
    const expected = pkg.dependencies?.['agent-director']

    expect(typeof expected).toBe('string')
    expect(readAdDependencyRange()).toBe(expected as string)
  })
})
