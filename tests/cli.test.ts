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
  getClient,
} from '../src/agent-director-client.ts'

// ---------------------------------------------------------------------------
// SR-29.2 #1 — import the not-yet-existing export surface.
//
// The Engineer (subtasks t3.a3g.g5.mx.x1 / t3.a3g.g5.mx.ug) must extract
// resolveCscbInstanceId + the director* lambdas from import.meta.main into a
// named export:
//
//   export function buildRealDirectorDeps(
//     getClientFn: () => import('agent-director').Client,
//   ): Pick<CliDeps, 'directorStatus' | 'directorPause' | 'directorKill'>
//
// Until that extraction lands, the destructure below evaluates to `undefined`
// at runtime and both SR-29.2 tests FAIL with the root-cause message:
//
//   TypeError: buildRealDirectorDeps is not a function
//
// This is the expected RED state. After the extraction lands, both tests must
// turn GREEN without any other test changes.
// ---------------------------------------------------------------------------
import { buildRealDirectorDeps } from '../src/cli.ts'

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
// SR-29.2 #1a — clean_restart rows-present: real getClient path
//
// Root-cause: resolveCscbInstanceId lives in import.meta.main, not called by
// createCli(). Even with setClientForTests installing a stub, clean_restart
// never reaches getClient() for directorStatus — the EXISTING tests stub
// directorStatus directly and completely bypass the bug.
//
// Pre-fix failure mode (RED): buildRealDirectorDeps is not yet exported from
// src/cli.ts, so this suite fails immediately with:
//   TypeError: buildRealDirectorDeps is not a function
//
// Post-fix (GREEN): Engineer extracts resolveCscbInstanceId + director*
// lambdas into buildRealDirectorDeps(getClientFn) and exports it. The stub
// Client installed via setClientForTests is reached through getClientFn, the
// list() call resolves a row, status() returns waiting→ended, and the test
// asserts zero "no spawn row — skipping" messages.
//
// SR-29.2 root-cause #1: resolveCscbInstanceId not reachable from createCli
// ---------------------------------------------------------------------------

describe('SR-29.2 #1a — clean_restart rows-present via real getClient path', () => {
  test('pause/poll loop executes and zero "no spawn row" for channels with rows', async () => {
    // SR-29.2 root-cause #1: this test drives the REAL resolveCscbInstanceId
    // path via buildRealDirectorDeps(getClientFn). The stub Client holds one
    // cscb row for channel C. status() returns waiting (precheck) then ended
    // (poll), so the teardown completes without kill.
    //
    // PRE-FIX RED RUN EXPECTATION:
    //   TypeError: buildRealDirectorDeps is not a function
    // The export does not exist until the Engineer lands subtask x1/ug.
    //
    // POST-FIX GREEN: pause is called for C, kill is never called, zero
    // "no spawn row — skipping" log lines are emitted for channel C.

    const listCalls: StubClientOptions['listCalls'] = []
    const pauseParams: StubClientOptions['pauseCalls'] = []
    const stub = makeStubClient({
      // list() returns one row matching channel=C label.
      listResult: {
        spawns: [cannedListRow({
          claude_instance_id: 'cscb_C_real_path',
          labels: { service: 'cscb', channel: 'C' },
        })],
      },
      listCalls,
      // status(): first call → 'waiting' (precheck passes through to teardown);
      // second call → 'ended' (poll exits cleanly, no escalation to kill).
      statusQueue: [
        { kind: 'resolve', value: { state: 'waiting' } },
        { kind: 'resolve', value: { state: 'ended' } },
      ],
      pauseCalls: pauseParams,
    })

    // Install stub as the module-level singleton so getClientFn() returns it.
    setClientForTests(stub as unknown as import('agent-director').Client)

    // buildRealDirectorDeps(getClientFn) is the intended extraction:
    // it returns { directorStatus, directorPause, directorKill } wired through
    // the REAL resolveCscbInstanceId lambda (not a stub override).
    // PRE-FIX: this throws TypeError — EXPECTED RED.
    const realDirectorDeps = buildRealDirectorDeps(getClient)

    const pauseCalls: string[] = []
    const killCalls: string[] = []
    const logLines: string[] = []
    const origConsoleError = console.error.bind(console)
    console.error = (...args: unknown[]) => {
      logLines.push(args.join(' '))
      origConsoleError(...args)
    }

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
      getClient: () => stub as unknown as import('agent-director').Client,
      // Wire the REAL director* lambdas returned by the extracted factory.
      directorStatus: realDirectorDeps.directorStatus,
      directorPause: async (channelId) => {
        pauseCalls.push(channelId)
        return realDirectorDeps.directorPause(channelId)
      },
      directorKill: async (channelId) => {
        killCalls.push(channelId)
        return realDirectorDeps.directorKill(channelId)
      },
    }

    try {
      const { createCli: createCliLocal } = await import('../src/cli.ts')
      await createCliLocal(deps).clean_restart()
    } finally {
      console.error = origConsoleError
    }

    // list() was reached via the real resolveCscbInstanceId path.
    expect(listCalls.length).toBeGreaterThan(0)
    // pause was called for channel C (teardown loop ran).
    expect(pauseCalls).toContain('C')
    // kill was NOT called (status ended cleanly).
    expect(killCalls).toEqual([])
    // No "no spawn row — skipping" log for channel C.
    const skipLines = logLines.filter((l) => l.includes('no spawn row') && l.includes('channel=C'))
    expect(skipLines).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// SR-29.2 #1b — clean_restart AD-unreachable: distinct non-zero exit
//
// Root-cause: resolveCscbInstanceId has a bare `catch { return null }` that
// swallows ALL errors including connection-refused. When AD is unreachable,
// every channel silently skips ("no spawn row — skipping") and clean_restart
// exits 0 as if everything was fine. SR-27.2 requires this path to exit
// loudly with a non-zero code BEFORE entering the per-channel loop.
//
// Pre-fix failure mode (RED): buildRealDirectorDeps is not yet exported,
// same as the rows-present suite above:
//   TypeError: buildRealDirectorDeps is not a function
//
// Post-fix (GREEN): the narrowed catch rethrows connection-class errors;
// clean_restart catches it at the outer level and exits non-zero before any
// per-channel processing; no "start" spawnSync is called; the failure is
// clearly distinct from the silent-skip path.
//
// SR-29.2 root-cause #1: bare catch in resolveCscbInstanceId collapses
// AD-unreachable to silent null, indistinguishable from "no row".
// ---------------------------------------------------------------------------

describe('SR-29.2 #1b — clean_restart AD-unreachable: loud non-zero exit', () => {
  test('connection-refused error → non-zero exit, no pause/kill, no start spawnSync', async () => {
    // SR-29.2 root-cause #1: with AD unreachable, getClient().list() throws a
    // connection-refused-class error. The REAL resolveCscbInstanceId (bare catch)
    // swallows it and returns null → clean_restart silently skips the channel.
    // After the SR-27.2 fix, the narrowed catch rethrows it, and clean_restart
    // fails loudly with a non-zero exit BEFORE the per-channel start loop.
    //
    // PRE-FIX RED RUN EXPECTATION:
    //   TypeError: buildRealDirectorDeps is not a function
    // The export does not exist until the Engineer lands subtask x1/ug.
    //
    // POST-FIX GREEN: ExitError is thrown with code !== 0; no spawnSync call
    // with 'start'; no directorPause/directorKill invocations; the error is
    // distinguishable from the "no spawn row — skipping" silent path.

    // Stub list() to throw a connection-refused-class error (the real error
    // type from ECONNREFUSED / ErrSystemInstallUnreachable or equivalent).
    const connectionError = new Error('connect ECONNREFUSED 127.0.0.1:7777')
    connectionError.name = 'ConnectionRefusedError'
    const stub = makeStubClient({
      listError: connectionError,
    })

    setClientForTests(stub as unknown as import('agent-director').Client)

    // PRE-FIX: this throws TypeError — EXPECTED RED.
    const realDirectorDeps = buildRealDirectorDeps(getClient)

    const pauseCalls: string[] = []
    const killCalls: string[] = []
    const spawnCalls: Array<{ cmd: string; args: string[] }> = []
    const exitCodes: number[] = []

    const deps: CliDeps = {
      spawnSync: (cmd, args) => {
        spawnCalls.push({ cmd, args })
        return { status: 0 }
      },
      env: { SLACK_BOT_TOKEN: 'xoxb', SLACK_APP_TOKEN: 'xapp' },
      existsSync: () => true,
      readFileSync: () => { throw new Error('unexpected') },
      unlinkSync: () => { /* no-op */ },
      isProcessRunning: () => false,
      kill: () => { /* no-op */ },
      resolveStateDir: () => STATE_DIR,
      startServer: async () => { /* no-op */ },
      exit: (code) => { exitCodes.push(code); throw new ExitError(code) },
      loadConfig: () => makeRoutingConfig({ routes: { C: { cwd: '/x' } } }),
      getClient: () => stub as unknown as import('agent-director').Client,
      directorStatus: realDirectorDeps.directorStatus,
      directorPause: async (channelId) => {
        pauseCalls.push(channelId)
        return realDirectorDeps.directorPause(channelId)
      },
      directorKill: async (channelId) => {
        killCalls.push(channelId)
        return realDirectorDeps.directorKill(channelId)
      },
    }

    const { createCli: createCliLocal } = await import('../src/cli.ts')
    await expect(createCliLocal(deps).clean_restart()).rejects.toBeInstanceOf(ExitError)

    // Non-zero exit code required (AD-unreachable must not be silent).
    expect(exitCodes.length).toBeGreaterThan(0)
    expect(exitCodes[0]).not.toBe(0)

    // No pause or kill should have been called (fail BEFORE per-channel loop).
    expect(pauseCalls).toEqual([])
    expect(killCalls).toEqual([])

    // No 'start' spawnSync (server must not restart after AD-unreachable failure).
    const startCalls = spawnCalls.filter((c) => c.args.includes('start'))
    expect(startCalls).toHaveLength(0)
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
