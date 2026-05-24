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
import { join } from 'path'
import type { CliDeps, CliHandlers } from '../src/cli.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'

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
  }
  return { deps, exitCodes, spawnCalls, pauseCalls, killCalls, statusCalls }
}

afterEach(() => {
  delete process.env['_CLI_DAEMON_CHILD']
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
