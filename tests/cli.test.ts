/**
 * cli.test.ts — Minimal coverage for the library-backed CLI surface.
 *
 * The pre-rewrite tmux-direct tests have been removed (SR-7.1). The new
 * surface (directorStatus / directorPause / directorKill) is exercised
 * here at the createCli factory level, with all I/O injected.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'path'
import type { CliDeps, CliHandlers } from '../src/cli.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'
import { makeStubClient, cannedListRow, type StubClientOptions } from './test-helpers/agent-director-stub.ts'
import {
  setClientForTests,
  resetClientForTests,
} from '../src/agent-director-client.ts'

process.env['SLACK_BOT_TOKEN'] = 'xoxb-test-placeholder'
process.env['SLACK_APP_TOKEN'] = 'xapp-test-placeholder'

let createCli: (deps: CliDeps) => CliHandlers

beforeAll(async () => {
  const mod = await import('../src/cli.ts')
  createCli = mod.createCli
})

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`)
  }
}

const STATE_DIR = '/fake/state'
const PID_FILE = join(STATE_DIR, 'server.pid')
const CONFIG_JSON = join(STATE_DIR, 'config.json')

interface Overrides {
  spawnSyncStatus?: number | null
  spawnSyncFn?: (cmd: string, args: string[]) => { status: number | null }
  env?: NodeJS.ProcessEnv
  existingPaths?: string[]
  pidFileContent?: string
  isProcessRunning?: (pid: number) => boolean
  loadConfig?: () => ReturnType<typeof makeRoutingConfig>
  directorStatus?: (channelId: string) => Promise<{ state: string } | null>
  directorPause?: (channelId: string) => Promise<void>
  directorKill?: (channelId: string) => Promise<void>
}

interface Bundle {
  deps: CliDeps
  exitCodes: number[]
  spawnCalls: Array<{ cmd: string; args: string[] }>
  pauseCalls: string[]
  killCalls: string[]
  statusCalls: string[]
}

function makeDeps(o: Overrides = {}): Bundle {
  const exitCodes: number[] = []
  const spawnCalls: Array<{ cmd: string; args: string[] }> = []
  const pauseCalls: string[] = []
  const killCalls: string[] = []
  const statusCalls: string[] = []
  const existing = new Set(o.existingPaths ?? [CONFIG_JSON])
  const deps: CliDeps = {
    spawnSync: (cmd, args) => {
      spawnCalls.push({ cmd, args })
      if (o.spawnSyncFn) return o.spawnSyncFn(cmd, args)
      return { status: o.spawnSyncStatus !== undefined ? o.spawnSyncStatus : 0 }
    },
    env: o.env ?? { SLACK_BOT_TOKEN: 'xoxb', SLACK_APP_TOKEN: 'xapp' },
    existsSync: (p) => existing.has(p),
    readFileSync: (p) => {
      if (p === PID_FILE && o.pidFileContent !== undefined) return o.pidFileContent
      throw new Error('unexpected readFileSync ' + p)
    },
    unlinkSync: () => { /* no-op */ },
    isProcessRunning: o.isProcessRunning ?? (() => false),
    kill: () => { /* no-op */ },
    resolveStateDir: () => STATE_DIR,
    startServer: async () => { /* no-op */ },
    exit: (code) => { exitCodes.push(code); throw new ExitError(code) },
    loadConfig: o.loadConfig ?? (() => makeRoutingConfig()),
    directorStatus: async (channelId) => {
      statusCalls.push(channelId)
      if (o.directorStatus) return o.directorStatus(channelId)
      return null
    },
    directorPause: async (channelId) => {
      pauseCalls.push(channelId)
      if (o.directorPause) return o.directorPause(channelId)
    },
    directorKill: async (channelId) => {
      killCalls.push(channelId)
      if (o.directorKill) return o.directorKill(channelId)
    },
    // Stub out the getClient seam with a minimal no-op client.
    // Tests that exercise the seam directly (see "getClient seam" suite below)
    // override this slot by wiring deps.getClient() to a real StubClient.
    getClient: () => makeStubClient() as unknown as import('agent-director').Client,
  }
  return { deps, exitCodes, spawnCalls, pauseCalls, killCalls, statusCalls }
}

afterEach(() => {
  delete process.env['_CLI_DAEMON_CHILD']
  // Reset the agent-director-client singleton so stub installs don't leak
  // between tests (mirrors the contract for setClientForTests users).
  resetClientForTests()
})

// ---------------------------------------------------------------------------
// start — pre-flight checks
// ---------------------------------------------------------------------------

describe('start', () => {
  test('rejects when SLACK_BOT_TOKEN missing', async () => {
    const { deps, exitCodes } = makeDeps({ env: { SLACK_APP_TOKEN: 'xapp' } })
    await expect(createCli(deps).start()).rejects.toBeInstanceOf(ExitError)
    expect(exitCodes).toContain(1)
  })

  test('rejects when SLACK_APP_TOKEN missing', async () => {
    const { deps, exitCodes } = makeDeps({ env: { SLACK_BOT_TOKEN: 'xoxb' } })
    await expect(createCli(deps).start()).rejects.toBeInstanceOf(ExitError)
    expect(exitCodes).toContain(1)
  })

  test('rejects when config.json missing', async () => {
    const { deps, exitCodes } = makeDeps({ existingPaths: [] })
    await expect(createCli(deps).start()).rejects.toBeInstanceOf(ExitError)
    expect(exitCodes).toContain(1)
  })

  test('does NOT probe tmux on PATH (Epic 2: SR-5.1 owns runtime checks)', async () => {
    const { deps, spawnCalls } = makeDeps()
    process.env['_CLI_DAEMON_CHILD'] = '1'
    try {
      await createCli(deps).start()
    } catch { /* daemonized path */ }
    const tmuxProbes = spawnCalls.filter((c) => c.cmd === 'tmux')
    expect(tmuxProbes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// clean_restart — SR-11 Event 12 — pause + poll + escalate
// ---------------------------------------------------------------------------

describe('clean_restart', () => {
  test('skips channels with no spawn row', async () => {
    const { deps, statusCalls, pauseCalls, killCalls } = makeDeps({
      loadConfig: () => makeRoutingConfig({ routes: { C: { cwd: '/x' } } }),
      directorStatus: async () => null, // ErrSpawnNotFound branch
    })
    await createCli(deps).clean_restart()
    expect(statusCalls).toEqual(['C'])
    expect(pauseCalls).toEqual([])
    expect(killCalls).toEqual([])
  })

  test('skips channels already in terminal state', async () => {
    const { deps, pauseCalls } = makeDeps({
      loadConfig: () => makeRoutingConfig({ routes: { C: { cwd: '/x' } } }),
      directorStatus: async () => ({ state: 'ended' }),
    })
    await createCli(deps).clean_restart()
    expect(pauseCalls).toEqual([])
  })

  test('pauses + reports cleanly when status transitions to terminal', async () => {
    let callCount = 0
    const { deps, pauseCalls, killCalls } = makeDeps({
      loadConfig: () => makeRoutingConfig({ routes: { C: { cwd: '/x' } } }),
      directorStatus: async () => {
        callCount++
        if (callCount === 1) return { state: 'waiting' } // precheck
        return { state: 'ended' } // post-pause poll terminal
      },
    })
    await createCli(deps).clean_restart()
    expect(pauseCalls).toEqual(['C'])
    expect(killCalls).toEqual([])
  })

  test('escalates to kill on pause failure', async () => {
    const { deps, killCalls } = makeDeps({
      loadConfig: () => makeRoutingConfig({ routes: { C: { cwd: '/x' } } }),
      directorStatus: async () => ({ state: 'waiting' }),
      directorPause: async () => { throw new Error('pause failed') },
    })
    await createCli(deps).clean_restart()
    expect(killCalls).toEqual(['C'])
  })
})

// ---------------------------------------------------------------------------
// getClient seam-routing — proves the stub installed via setClientForTests
// is the same client that deps.getClient() returns, and that clean_restart
// deps wired through deps.getClient() reach the stub's list/status verbs.
//
// SCOPE: plumbing-only. The real resolveCscbInstanceId (which calls
// realDeps.getClient().list()) lives in the import.meta.main block and is NOT
// reachable via createCli(). What IS reachable here:
//
//   1. getClient() (from agent-director-client.ts) returns whatever
//      setClientForTests installed — identity test.
//   2. CliDeps.getClient() slot is plumbed: when deps.directorStatus is wired
//      to call deps.getClient().list() then deps.getClient().status(), the
//      stub's list/status verbs are the ones clean_restart reaches.
//   3. No "no spawn row — skipping" log for channels whose list() returns a
//      real row (i.e. the teardown precheck does NOT short-circuit on null).
//
// Behavioral red→green tests (AD-unreachable loud-failure / exit-code
// assertions) are deferred to Epic g5 (SR-27.2).
// ---------------------------------------------------------------------------

describe('getClient seam', () => {
  test('setClientForTests installs the stub returned by getClient()', async () => {
    const { getClient } = await import('../src/agent-director-client.ts')
    const stub = makeStubClient()
    setClientForTests(stub as unknown as import('agent-director').Client)
    // getClient() must return the exact stub instance we installed.
    expect(getClient() as unknown).toBe(stub)
    // afterEach calls resetClientForTests() — no explicit reset needed here.
  })

  test('clean_restart reaches stub list() + status() when deps.getClient() routes through stub', async () => {
    // Arrange: stub with one cscb row for channel C; status returns 'waiting'
    // then 'ended' so clean_restart completes the teardown path without kill.
    const listCalls: StubClientOptions['listCalls'] = []
    const statusCalls: StubClientOptions['statusCalls'] = []
    let statusCallCount = 0
    const stub = makeStubClient({
      // list() returns one row for the channel — resolveCscbInstanceId-equivalent
      // in the wired deps returns the instance id from this row.
      listResult: { spawns: [cannedListRow({ claude_instance_id: 'cscb_C_test' })] },
      listCalls,
      // status(): first call → 'waiting' (precheck passes); second → 'ended'
      // (poll succeeds; no kill needed).
      statusCalls,
      statusQueue: [
        { kind: 'resolve', value: { state: 'waiting' } },
        { kind: 'resolve', value: { state: 'ended' } },
      ],
    })

    // Install the stub as the module-level singleton.
    setClientForTests(stub as unknown as import('agent-director').Client)

    // Build deps whose director* verbs call deps.getClient() — this is
    // structurally equivalent to the realDeps wiring in import.meta.main,
    // minus resolveCscbInstanceId (which lives only in that block).
    const pauseCalls: string[] = []
    const killCalls: string[] = []
    const deps: CliDeps = {
      spawnSync: () => ({ status: 0 }),
      env: { SLACK_BOT_TOKEN: 'xoxb', SLACK_APP_TOKEN: 'xapp' },
      existsSync: () => true,
      readFileSync: () => { throw new Error('unexpected') },
      unlinkSync: () => { /* no-op */ },
      isProcessRunning: () => false,
      kill: () => { /* no-op */ },
      resolveStateDir: () => STATE_DIR,
      startServer: async () => { /* no-op */ },
      exit: (code) => { throw new ExitError(code) },
      loadConfig: () => makeRoutingConfig({ routes: { C: { cwd: '/x' } } }),
      getClient: () => {
        // This is the seam: import from the singleton module, not a closure.
        const { getClient } = require('../src/agent-director-client.ts')
        return getClient()
      },
      // directorStatus wired to call deps.getClient().list() then .status()
      // (mirrors realDeps pattern: list to resolve instance id, then status).
      directorStatus: async (_channelId) => {
        const client = deps.getClient()
        // Resolve instance id via list (mirrors resolveCscbInstanceId shape).
        const listResult = await client.list({ label: ['service=cscb', `channel=${_channelId}`] })
        if (listResult.spawns.length === 0) return null
        const instanceId = listResult.spawns[0].claude_instance_id
        const r = await client.status({ claude_instance_id: instanceId })
        statusCallCount++
        return { state: r.state }
      },
      directorPause: async (channelId) => {
        pauseCalls.push(channelId)
      },
      directorKill: async (channelId) => {
        killCalls.push(channelId)
      },
    }

    // Act
    const { createCli: createCliLocal } = await import('../src/cli.ts')
    await createCliLocal(deps).clean_restart()

    // Assert: list() was called (seam reached the stub)
    expect(listCalls.length).toBeGreaterThan(0)
    // Assert: status() was called (precheck did NOT short-circuit on null)
    expect(statusCallCount).toBeGreaterThan(0)
    // Assert: pause was called (non-terminal precheck → teardown path)
    expect(pauseCalls).toContain('C')
    // Assert: kill was NOT called (status transitioned to 'ended' cleanly)
    expect(killCalls).toEqual([])
  })

  test('clean_restart logs "skipping" only for channels with NO list() rows', async () => {
    // Stub returns empty list → resolveCscbInstanceId-equivalent returns null
    // → directorStatus returns null → precheck hits the skip branch.
    const stub = makeStubClient({
      listResult: { spawns: [] },
    })
    setClientForTests(stub as unknown as import('agent-director').Client)

    const pauseCalls: string[] = []
    const statusCalled: boolean[] = []
    const deps: CliDeps = {
      spawnSync: () => ({ status: 0 }),
      env: { SLACK_BOT_TOKEN: 'xoxb', SLACK_APP_TOKEN: 'xapp' },
      existsSync: () => true,
      readFileSync: () => { throw new Error('unexpected') },
      unlinkSync: () => { /* no-op */ },
      isProcessRunning: () => false,
      kill: () => { /* no-op */ },
      resolveStateDir: () => STATE_DIR,
      startServer: async () => { /* no-op */ },
      exit: (code) => { throw new ExitError(code) },
      loadConfig: () => makeRoutingConfig({ routes: { C: { cwd: '/x' } } }),
      getClient: () => {
        const { getClient } = require('../src/agent-director-client.ts')
        return getClient()
      },
      directorStatus: async (_channelId) => {
        const client = deps.getClient()
        const listResult = await client.list({ label: ['service=cscb', `channel=${_channelId}`] })
        if (listResult.spawns.length === 0) return null
        statusCalled.push(true)
        const instanceId = listResult.spawns[0].claude_instance_id
        const r = await client.status({ claude_instance_id: instanceId })
        return { state: r.state }
      },
      directorPause: async (channelId) => { pauseCalls.push(channelId) },
      directorKill: async () => { /* no-op */ },
    }

    const { createCli: createCliLocal } = await import('../src/cli.ts')
    await createCliLocal(deps).clean_restart()

    // No rows → directorStatus returned null → precheck skipped → no pause.
    expect(pauseCalls).toEqual([])
    // status() verb on the stub was NOT called (short-circuited at list=empty).
    expect(statusCalled).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// unknown subcommand — regression for b.8tm (trail subcommand removed)
// ---------------------------------------------------------------------------

describe('unknown subcommand', () => {
  const CLI_SCRIPT = resolve(import.meta.dir, '..', 'src', 'cli.ts')

  test('`trail` subcommand hits the unknown-subcommand error path (non-zero exit, no "trail" in usage)', () => {
    const result = spawnSync('bun', [CLI_SCRIPT, 'trail'], {
      encoding: 'utf-8',
      env: { ...process.env, SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' },
    })
    // Must exit non-zero
    expect(result.status).not.toBe(0)
    // Usage text must not list `trail` as a valid subcommand
    const output = (result.stderr ?? '') + (result.stdout ?? '')
    expect(output).not.toMatch(/\btrail\b/)
    // Usage text should mention the valid subcommands
    expect(output).toContain('start')
  })
})
