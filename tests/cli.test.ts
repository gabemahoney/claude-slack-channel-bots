/**
 * cli.test.ts — Minimal coverage for the library-backed CLI surface.
 *
 * The pre-rewrite tmux-direct tests have been removed (SR-7.1). The new
 * surface (directorStatus / directorPause / directorKill) is exercised
 * here at the createCli factory level, with all I/O injected.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'path'
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
  /** When true, existsSync returns true for every path (e.g. daemonize needs the state dir + config). */
  existsAll?: boolean
  pidFileContent?: string
  isProcessRunning?: (pid: number) => boolean
  /** Override the resolved state dir (daemonize openSync()s <stateDir>/server.log for real). */
  resolveStateDir?: () => string
  loadConfig?: () => ReturnType<typeof makeRoutingConfig>
  directorStatus?: (channelId: string) => Promise<{ state: string } | null>
  directorPause?: (channelId: string) => Promise<void>
  directorKill?: (channelId: string) => Promise<void>
  /** Called on every deps.kill(pid, signal) — lets tests observe SIGTERM/SIGKILL to the server pid. */
  killFn?: (pid: number, signal: string) => void
}

interface Bundle {
  deps: CliDeps
  exitCodes: number[]
  spawnCalls: Array<{ cmd: string; args: string[] }>
  pauseCalls: string[]
  killCalls: string[]
  statusCalls: string[]
  /** Signals sent to the server pid via deps.kill(), in order (e.g. 'SIGTERM'). */
  serverSignals: string[]
  /** Named side-effect events in call order — used to pin server-stop-vs-teardown ordering. */
  events: string[]
  /** Whether deps.startServer() was invoked (in-place server run). */
  readonly startServerCalled: boolean
}

function makeDeps(o: Overrides = {}): Bundle {
  const exitCodes: number[] = []
  const spawnCalls: Array<{ cmd: string; args: string[] }> = []
  const pauseCalls: string[] = []
  const killCalls: string[] = []
  const statusCalls: string[] = []
  const serverSignals: string[] = []
  const events: string[] = []
  let startServerCalled = false
  const existing = new Set(o.existingPaths ?? [CONFIG_JSON])
  const deps: CliDeps = {
    spawnSync: (cmd, args) => {
      spawnCalls.push({ cmd, args })
      if (o.spawnSyncFn) return o.spawnSyncFn(cmd, args)
      return { status: o.spawnSyncStatus !== undefined ? o.spawnSyncStatus : 0 }
    },
    env: o.env ?? { SLACK_BOT_TOKEN: 'xoxb', SLACK_APP_TOKEN: 'xapp' },
    existsSync: (p) => (o.existsAll ? true : existing.has(p)),
    readFileSync: (p) => {
      if (p === PID_FILE && o.pidFileContent !== undefined) return o.pidFileContent
      throw new Error('unexpected readFileSync ' + p)
    },
    unlinkSync: () => { /* no-op */ },
    isProcessRunning: o.isProcessRunning ?? (() => false),
    kill: (pid, signal) => {
      serverSignals.push(String(signal))
      events.push(`server:${String(signal)}`)
      o.killFn?.(pid as number, String(signal))
    },
    resolveStateDir: o.resolveStateDir ?? (() => STATE_DIR),
    startServer: async () => { startServerCalled = true },
    exit: (code) => { exitCodes.push(code); throw new ExitError(code) },
    loadConfig: o.loadConfig ?? (() => makeRoutingConfig()),
    directorStatus: async (channelId) => {
      statusCalls.push(channelId)
      if (o.directorStatus) return o.directorStatus(channelId)
      return null
    },
    directorPause: async (channelId) => {
      pauseCalls.push(channelId)
      events.push(`pause:${channelId}`)
      if (o.directorPause) return o.directorPause(channelId)
    },
    directorKill: async (channelId) => {
      killCalls.push(channelId)
      events.push(`kill:${channelId}`)
      if (o.directorKill) return o.directorKill(channelId)
    },
  }
  return {
    deps, exitCodes, spawnCalls, pauseCalls, killCalls, statusCalls, serverSignals, events,
    get startServerCalled() { return startServerCalled },
  }
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
// start — session-leader daemonize guard (b.acn)
//
// The bug: a leaked _CLI_DAEMON_CHILD marker in the launcher's environment made
// `start` trust the marker and run the server in-place (child path), inheriting
// the launcher's session/PGID so killing the launcher's group killed the server.
// The fix: only trust the marker when the process is ALSO a session leader; a
// set-but-not-leader marker is treated as a leak, cleared, and the parent path
// re-detaches via a real detached spawn.
//
// Under `bun test` the test process is NOT a session leader (its session id
// differs from its pid — verified: a real daemon child spawned with
// detached:true would be a leader, we are not). So with the marker preset we
// exercise exactly the leaked-marker scenario the bug describes:
//   - fixed code  -> parent path: detached spawn + exit(0), startServer NOT run
//   - pre-fix code -> child path: startServer run in-place (the bug)
//
// child_process.spawn is stubbed so no real server process is ever launched
// (shared-infra safety); the daemonize path uses a dynamic import of
// child_process, which mock.module intercepts.
// ---------------------------------------------------------------------------

/**
 * Read the session id (field 4 after comm) from /proc/self/stat, the same way
 * src/cli.ts isSessionLeader() does. Returns null when /proc is unavailable.
 */
function readOwnSessionId(): number | null {
  try {
    const stat = require('node:fs').readFileSync('/proc/self/stat', 'utf8') as string
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    const session = parseInt(fields[3] ?? '', 10)
    return Number.isNaN(session) ? null : session
  } catch {
    return null
  }
}

describe('start — daemonize session-leader guard (b.acn)', () => {
  let scratchDir: string
  // Each fake-spawn call records the real detach arguments so tests can assert
  // that the respawn is a genuine `detached:true` background launch.
  let spawnedCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>

  beforeAll(async () => {
    const real = await import('node:child_process')
    // Fake spawn: record (cmd, args, opts), never launch a real process; return
    // a minimal child with unref() and a pid so the parent path completes.
    const fakeSpawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnedCalls.push({ cmd, args, opts })
      return { unref: () => { /* no-op */ }, pid: 999999 }
    }
    mock.module('node:child_process', () => ({ ...real, spawn: fakeSpawn }))
    mock.module('child_process', () => ({ ...real, spawn: fakeSpawn }))
  })

  afterAll(() => {
    mock.restore()
  })

  beforeEach(() => {
    // PRECONDITION (b.acn, reviewer finding #2): both leaked-marker tests below
    // assume the `bun test` runner is NOT a session leader (its session id
    // differs from its pid) — that is what makes a preset marker look "leaked".
    // If the suite ever runs with bun AS a session leader (e.g. PID 1 under
    // docker), the guard would trust the marker and run in-place, and these
    // tests would fail confusingly. Fail loudly with a self-diagnosing message.
    const sid = readOwnSessionId()
    if (sid !== null && sid === process.pid) {
      throw new Error(
        `b.acn precondition violated: the test runner IS a session leader ` +
        `(session id ${sid} === pid ${process.pid}). The leaked-marker guard ` +
        `tests require a non-session-leader runner. Run the suite as a child ` +
        `process (not PID 1 / not a session leader).`,
      )
    }

    spawnedCalls = []
    scratchDir = mkdtempSync(join(tmpdir(), 'cscb-acn-'))
    // The daemonize parent path openSync()s <stateDir>/server.log for real, so
    // the state dir must exist on disk.
  })

  afterEach(() => {
    delete process.env['_CLI_DAEMON_CHILD']
    try { rmSync(scratchDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // Assert the recorded spawn is a real detach matching src/cli.ts (~line 159):
  // detached:true, the _CLI_DAEMON_CHILD marker set in the child env, and stdio
  // NOT inherited (so the child survives its parent's exit).
  function expectRealDetach(call: { cmd: string; args: string[]; opts: Record<string, unknown> }) {
    expect(call.opts['detached']).toBe(true)
    const childEnv = call.opts['env'] as NodeJS.ProcessEnv
    expect(childEnv['_CLI_DAEMON_CHILD']).toBe('1')
    const stdio = call.opts['stdio']
    expect(stdio).not.toBe('inherit')
    if (Array.isArray(stdio)) {
      expect(stdio).not.toContain('inherit')
    }
    // Respawn re-invokes this CLI with the `start` subcommand.
    expect(call.args).toContain('start')
  }

  // REGRESSION (b.acn): fails with pre-fix code, passes with the fix.
  test('leaked _CLI_DAEMON_CHILD marker (not a session leader) re-detaches instead of running in-place', async () => {
    const bundle = makeDeps({ existsAll: true, resolveStateDir: () => scratchDir })
    // Simulate the leaked marker inherited from a launcher wrapper.
    process.env['_CLI_DAEMON_CHILD'] = '1'

    await expect(createCli(bundle.deps).start()).rejects.toBeInstanceOf(ExitError)

    // Fix: parent (re-detach) path — a detached child is spawned and we exit(0).
    expect(spawnedCalls).toHaveLength(1)
    expectRealDetach(spawnedCalls[0]!)
    expect(bundle.exitCodes).toContain(0)
    // The server must NOT be started in-place under the leaked marker.
    expect(bundle.startServerCalled).toBe(false)
  })

  // Baseline: with no marker, the parent always detaches (unchanged by the fix).
  // This anchors the regression test — it proves the spawn/exit(0) reflect the
  // detach path and not some unrelated failure, and that the leaked-marker case
  // above ends up in the SAME detach path a fresh launch takes.
  test('no marker at all: parent detaches and exits (baseline)', async () => {
    const bundle = makeDeps({ existsAll: true, resolveStateDir: () => scratchDir })
    delete process.env['_CLI_DAEMON_CHILD']

    await expect(createCli(bundle.deps).start()).rejects.toBeInstanceOf(ExitError)

    expect(spawnedCalls).toHaveLength(1)
    expectRealDetach(spawnedCalls[0]!)
    expect(bundle.exitCodes).toContain(0)
    expect(bundle.startServerCalled).toBe(false)
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
// stop — b.4dk `--stop-bots` graceful bot teardown before server stop
//
// `stop({ stopBots: true })` reuses clean_restart's per-route pause/poll/kill
// teardown (extracted into teardownBots) BEFORE stopping the server. Plain
// `stop()` must never touch the director verbs — bots survive server restarts.
// ---------------------------------------------------------------------------

describe('stop --stop-bots (b.4dk)', () => {
  /**
   * Configure a `stop` bundle whose server is already gone (stale PID file →
   * exit(0)) so the test focuses on the pre-stop bot-teardown behavior. The
   * teardown runs BEFORE the server-stop block, so it completes regardless.
   */
  function makeStopDeps(o: Overrides = {}): Bundle {
    return makeDeps({
      // existsAll makes the PID file "present"; isProcessRunning defaults false
      // → stale-PID branch → exit(0). No real signals are ever sent.
      existsAll: true,
      pidFileContent: '4242',
      isProcessRunning: () => false,
      ...o,
    })
  }

  test('stopBots: per-route pause runs and server still stops', async () => {
    let n = 0
    const { deps, pauseCalls, killCalls, statusCalls, exitCodes } = makeStopDeps({
      loadConfig: () => makeRoutingConfig({ routes: { C: { cwd: '/x' } } }),
      directorStatus: async () => {
        n++
        return n === 1 ? { state: 'waiting' } : { state: 'ended' } // precheck → post-pause terminal
      },
    })
    await expect(createCli(deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(pauseCalls).toEqual(['C'])
    expect(killCalls).toEqual([])
    expect(statusCalls[0]).toBe('C') // teardown precheck ran
    expect(exitCodes).toContain(0) // server stop still reached (stale PID → exit 0)
  })

  test('stopBots: pause timeout escalates to kill, server still stops', async () => {
    const { deps, pauseCalls, killCalls, exitCodes } = makeStopDeps({
      loadConfig: () => makeRoutingConfig({ routes: { C: { cwd: '/x' } }, exit_timeout: 0 }),
      directorStatus: async () => ({ state: 'waiting' }), // never reaches terminal
    })
    await expect(createCli(deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(pauseCalls).toEqual(['C'])
    expect(killCalls).toEqual(['C']) // exit_timeout=0 → immediate kill escalation
    expect(exitCodes).toContain(0)
  })

  test('stopBots: teardown error does NOT block server stop', async () => {
    const { deps, exitCodes } = makeStopDeps({
      // loadConfig throws inside the stopBots block → caught, logged, server stop proceeds.
      loadConfig: () => { throw new Error('config boom') },
    })
    await expect(createCli(deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    expect(exitCodes).toContain(0)
  })

  // b.4dk ordering guarantee: the server must be stopped BEFORE any bot teardown
  // begins, so the live daemon's onsessionclosed→scheduleRestart cannot respawn a
  // bot mid-teardown. A regression to teardown-first would put pause:C before the
  // server SIGTERM and fail this test. A LIVE server pid (isProcessRunning true
  // then false) forces a real SIGTERM through deps.kill so the ordering is
  // observable in the shared `events` log.
  test('stopBots: server SIGTERM precedes any director verb (teardown-first regression guard)', async () => {
    let alive = true
    const { deps, events } = makeDeps({
      existsAll: true,
      pidFileContent: '4242',
      isProcessRunning: () => { const was = alive; alive = false; return was }, // live once, then gone
      loadConfig: () => makeRoutingConfig({ routes: { C: { cwd: '/x' } }, stop_timeout: 1, exit_timeout: 0 }),
      directorStatus: async () => ({ state: 'waiting' }), // stays live → pause fires, poll times out fast (exit_timeout=0)
    })
    await expect(createCli(deps).stop({ stopBots: true })).rejects.toBeInstanceOf(ExitError)
    const firstServer = events.indexOf('server:SIGTERM')
    const firstPause = events.findIndex((e) => e.startsWith('pause:'))
    expect(firstServer).toBeGreaterThanOrEqual(0) // server was signalled
    expect(firstPause).toBeGreaterThanOrEqual(0) // bot teardown ran
    expect(firstServer).toBeLessThan(firstPause) // server stop happened FIRST
  })

  test.each([[undefined], [{}]])(
    'plain stop(%p) never touches director verbs (bots survive server restarts)',
    async (opts) => {
      const { deps, pauseCalls, killCalls, statusCalls } = makeStopDeps({
        loadConfig: () => makeRoutingConfig({ routes: { C: { cwd: '/x' } } }),
        directorStatus: async () => ({ state: 'waiting' }),
      })
      await expect(createCli(deps).stop(opts)).rejects.toBeInstanceOf(ExitError)
      expect(pauseCalls).toEqual([])
      expect(killCalls).toEqual([])
      expect(statusCalls).toEqual([]) // no teardown precheck at all
    },
  )
})

// ---------------------------------------------------------------------------
// clean_restart — regression: teardown still runs via the extracted closure
// ---------------------------------------------------------------------------

describe('clean_restart teardown-via-closure regression (b.4dk)', () => {
  test('clean_restart still pauses each live route (shared teardownBots closure)', async () => {
    let n = 0
    const { deps, pauseCalls, killCalls } = makeDeps({
      loadConfig: () => makeRoutingConfig({ routes: { C: { cwd: '/x' } } }),
      directorStatus: async () => {
        n++
        return n === 1 ? { state: 'waiting' } : { state: 'ended' }
      },
    })
    await createCli(deps).clean_restart()
    expect(pauseCalls).toEqual(['C']) // same pause/poll/kill teardown as before the extraction
    expect(killCalls).toEqual([])
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
