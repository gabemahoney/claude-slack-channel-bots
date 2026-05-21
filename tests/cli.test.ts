/**
 * cli.test.ts — Unit tests for createCli() factory.
 *
 * All external dependencies (fs, process.kill, startServer, etc.) are
 * injected via CliDeps stubs so no real system calls or servers are made.
 *
 * Because cli.ts statically imports server.ts, which calls loadTokens() at
 * module scope, we must set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in process.env
 * before those modules initialize. We do this by importing cli.ts dynamically
 * inside a lazy initializer so we control when the module evaluates.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from 'bun:test'
import { join } from 'path'
import type { CliDeps, CliHandlers } from '../src/cli.ts'
import {
  status as directorStatusFn,
  pause as directorPauseFn,
  kill as directorKillFn,
  type StatusResult,
  type PauseResult,
  type KillResult,
} from '../src/claude-director-cli.ts'
import { ClaudeDirectorStub, makeSpawnRow } from './test-helpers/claude-director-stub.ts'
import { makeRoutingConfig } from './test-helpers/routing-config.ts'

// ---------------------------------------------------------------------------
// Env bootstrapping — must happen before cli.ts (and server.ts) are loaded
// ---------------------------------------------------------------------------

// Set placeholder tokens so server.ts loadTokens() succeeds at module-init
process.env['SLACK_BOT_TOKEN'] = 'xoxb-test-placeholder'
process.env['SLACK_APP_TOKEN'] = 'xapp-test-placeholder'

// ---------------------------------------------------------------------------
// Lazy module reference — populated in beforeAll after env is set
// ---------------------------------------------------------------------------

let createCli: (deps: CliDeps) => CliHandlers

beforeAll(async () => {
  // Dynamic import defers module evaluation until after env vars are set above
  const mod = await import('../src/cli.ts')
  createCli = mod.createCli
})

// ---------------------------------------------------------------------------
// Sentinel error thrown by the exit stub so async handlers terminate cleanly
// ---------------------------------------------------------------------------

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`)
    this.name = 'ExitError'
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const STATE_DIR = '/fake/state'
const PID_FILE = join(STATE_DIR, 'server.pid')
const CONFIG_JSON = join(STATE_DIR, 'config.json')

interface DepsOverrides {
  spawnSyncStatus?: number | null
  spawnSyncFn?: (cmd: string, args: string[]) => { status: number | null }
  env?: NodeJS.ProcessEnv
  existingPaths?: string[]
  pidFileContent?: string
  isProcessRunning?: (pid: number) => boolean
  loadConfig?: () => ReturnType<typeof makeRoutingConfig>
  directorStatus?: (channelId: string) => Promise<StatusResult>
  directorPause?: (channelId: string) => Promise<PauseResult>
  directorKill?: (channelId: string) => Promise<KillResult>
}

interface DepsBundle {
  deps: CliDeps
  exitCodes: number[]
  unlinkedPaths: string[]
  killedPids: Array<{ pid: number; signal: string | number }>
  startServerCalled: boolean[]
  spawnCalls: Array<{ cmd: string; args: string[] }>
}

/** Build a fully-stubbed CliDeps with sensible passing defaults. */
function makeDeps(overrides: DepsOverrides = {}): DepsBundle {
  const exitCodes: number[] = []
  const unlinkedPaths: string[] = []
  const killedPids: Array<{ pid: number; signal: string | number }> = []
  const startServerCalled: boolean[] = []
  const spawnCalls: Array<{ cmd: string; args: string[] }> = []

  const existingPaths = new Set(overrides.existingPaths ?? [CONFIG_JSON])

  const deps: CliDeps = {
    spawnSync: (cmd, args) => {
      spawnCalls.push({ cmd, args })
      if (overrides.spawnSyncFn) return overrides.spawnSyncFn(cmd, args)
      return { status: overrides.spawnSyncStatus !== undefined ? overrides.spawnSyncStatus : 0 }
    },
    env: overrides.env ?? {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_APP_TOKEN: 'xapp-test',
    },
    existsSync: (path) => existingPaths.has(path),
    readFileSync: (path) => {
      if (overrides.pidFileContent !== undefined && path === PID_FILE) {
        return overrides.pidFileContent
      }
      throw new Error(`readFileSync: unexpected path ${path}`)
    },
    unlinkSync: (path) => {
      unlinkedPaths.push(path)
    },
    isProcessRunning: overrides.isProcessRunning ?? ((_pid) => false),
    kill: (pid, signal) => {
      killedPids.push({ pid, signal })
    },
    resolveStateDir: () => STATE_DIR,
    startServer: async () => {
      startServerCalled.push(true)
    },
    exit: (code) => {
      exitCodes.push(code)
      throw new ExitError(code)
    },
    loadConfig: overrides.loadConfig ?? (() => makeRoutingConfig()),
    directorStatus: overrides.directorStatus ?? ((_channelId) => Promise.resolve({ ok: true, data: { claudeInstanceId: `cscb_${_channelId}`, state: 'ended' } })),
    directorPause: overrides.directorPause ?? ((_channelId) => Promise.resolve({ ok: true, data: {} })),
    directorKill: overrides.directorKill ?? ((_channelId) => Promise.resolve({ ok: true, data: {} })),
  }

  return { deps, exitCodes, unlinkedPaths, killedPids, startServerCalled, spawnCalls }
}

/**
 * Drive fake timers forward until the given promise settles.
 * Alternates between advancing the fake clock by 5 s and flushing the
 * microtask queue so async continuations can run.
 * Must be called with jest.useFakeTimers() active.
 */
async function drainFakeTimers(p: Promise<void>): Promise<void> {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  // Flush initial microtasks (fan-out phase, poll-loop setup)
  for (let i = 0; i < 30; i++) await Promise.resolve()
  // Step through fake time until the handler settles
  for (let step = 0; step < 25 && !done; step++) {
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 15; i++) await Promise.resolve()
  }
  return p
}

/** Run an async handler and catch ExitError; returns it or null. */
async function runHandler(fn: () => Promise<void>): Promise<ExitError | null> {
  try {
    await fn()
    return null
  } catch (e) {
    if (e instanceof ExitError) return e
    throw e
  }
}

// ---------------------------------------------------------------------------
// Helpers for daemon-child env management
// ---------------------------------------------------------------------------

let savedDaemonEnv: string | undefined

function enterDaemonChild(): void {
  savedDaemonEnv = process.env['_CLI_DAEMON_CHILD']
  process.env['_CLI_DAEMON_CHILD'] = '1'
}

function exitDaemonChild(): void {
  if (savedDaemonEnv === undefined) {
    delete process.env['_CLI_DAEMON_CHILD']
  } else {
    process.env['_CLI_DAEMON_CHILD'] = savedDaemonEnv
  }
}

// ---------------------------------------------------------------------------
// start — missing tmux
// ---------------------------------------------------------------------------

describe('start — missing tmux', () => {
  let cli: CliHandlers
  let exitCodes: number[]

  beforeEach(() => {
    enterDaemonChild()
    const result = makeDeps({ spawnSyncStatus: 1 })
    cli = createCli(result.deps)
    exitCodes = result.exitCodes
  })

  afterEach(() => exitDaemonChild())

  test('calls exit(1) when tmux exits with non-zero status', async () => {
    const err = await runHandler(() => cli.start())
    expect(err).not.toBeNull()
    expect(err!.code).toBe(1)
  })

  test('exit code array contains 1', async () => {
    await runHandler(() => cli.start())
    expect(exitCodes).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// start — missing SLACK_BOT_TOKEN
// ---------------------------------------------------------------------------

describe('start — missing SLACK_BOT_TOKEN', () => {
  let cli: CliHandlers
  let exitCodes: number[]

  beforeEach(() => {
    enterDaemonChild()
    const result = makeDeps({
      env: { SLACK_APP_TOKEN: 'xapp-test' }, // SLACK_BOT_TOKEN absent
    })
    cli = createCli(result.deps)
    exitCodes = result.exitCodes
  })

  afterEach(() => exitDaemonChild())

  test('calls exit(1) when SLACK_BOT_TOKEN is missing from deps.env', async () => {
    const err = await runHandler(() => cli.start())
    expect(err).not.toBeNull()
    expect(err!.code).toBe(1)
  })

  test('exit code array contains 1', async () => {
    await runHandler(() => cli.start())
    expect(exitCodes).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// start — missing SLACK_APP_TOKEN
// ---------------------------------------------------------------------------

describe('start — missing SLACK_APP_TOKEN', () => {
  let cli: CliHandlers
  let exitCodes: number[]

  beforeEach(() => {
    enterDaemonChild()
    const result = makeDeps({
      env: { SLACK_BOT_TOKEN: 'xoxb-test' }, // SLACK_APP_TOKEN absent
    })
    cli = createCli(result.deps)
    exitCodes = result.exitCodes
  })

  afterEach(() => exitDaemonChild())

  test('calls exit(1) when SLACK_APP_TOKEN is missing from deps.env', async () => {
    const err = await runHandler(() => cli.start())
    expect(err).not.toBeNull()
    expect(err!.code).toBe(1)
  })

  test('exit code array contains 1', async () => {
    await runHandler(() => cli.start())
    expect(exitCodes).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// start — dry-run mode skips token prerequisite checks
// ---------------------------------------------------------------------------

describe('start — dry-run mode skips token checks', () => {
  let cli: CliHandlers
  let exitCodes: number[]
  let savedDryRun: string | undefined

  beforeEach(() => {
    savedDryRun = process.env['SLACK_DRY_RUN']
    process.env['SLACK_DRY_RUN'] = '1'
    enterDaemonChild()
    const result = makeDeps({
      env: {}, // No SLACK_BOT_TOKEN or SLACK_APP_TOKEN
      existingPaths: [], // config.json missing → will exit(1) at config check, not token check
    })
    cli = createCli(result.deps)
    exitCodes = result.exitCodes
  })

  afterEach(() => {
    if (savedDryRun === undefined) {
      delete process.env['SLACK_DRY_RUN']
    } else {
      process.env['SLACK_DRY_RUN'] = savedDryRun
    }
    exitDaemonChild()
  })

  test('does not exit on missing tokens when SLACK_DRY_RUN=1 — reaches config.json check', async () => {
    // With no tokens and SLACK_DRY_RUN=1, the token prerequisite is skipped.
    // The next check (config.json) will fail since existingPaths is empty.
    // If this exits with code 1, we know it got past the token check.
    const err = await runHandler(() => cli.start())
    expect(err).not.toBeNull()
    expect(exitCodes).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// start — missing config.json
// ---------------------------------------------------------------------------

describe('start — missing config.json', () => {
  let cli: CliHandlers
  let exitCodes: number[]

  beforeEach(() => {
    enterDaemonChild()
    const result = makeDeps({
      existingPaths: [], // config.json not present
    })
    cli = createCli(result.deps)
    exitCodes = result.exitCodes
  })

  afterEach(() => exitDaemonChild())

  test('calls exit(1) when config.json does not exist', async () => {
    const err = await runHandler(() => cli.start())
    expect(err).not.toBeNull()
    expect(err!.code).toBe(1)
  })

  test('exit code array contains 1', async () => {
    await runHandler(() => cli.start())
    expect(exitCodes).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// start — all prerequisites met (daemon child path)
// ---------------------------------------------------------------------------

describe('start — all prerequisites met', () => {
  let cli: CliHandlers
  let startServerCalled: boolean[]

  beforeEach(() => {
    enterDaemonChild()
    const result = makeDeps() // all defaults pass
    cli = createCli(result.deps)
    startServerCalled = result.startServerCalled
  })

  afterEach(() => exitDaemonChild())

  test('does not call exit when all prerequisites are satisfied', async () => {
    const err = await runHandler(() => cli.start())
    expect(err).toBeNull()
  })

  test('calls startServer exactly once', async () => {
    await cli.start()
    expect(startServerCalled).toHaveLength(1)
    expect(startServerCalled[0]).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// stop — no PID file
// ---------------------------------------------------------------------------

describe('stop — no PID file', () => {
  let cli: CliHandlers
  let exitCodes: number[]

  beforeEach(() => {
    const result = makeDeps({
      existingPaths: [], // PID file absent
    })
    cli = createCli(result.deps)
    exitCodes = result.exitCodes
  })

  test('calls exit(0) when no PID file exists', async () => {
    const err = await runHandler(() => cli.stop())
    expect(err).not.toBeNull()
    expect(err!.code).toBe(0)
  })

  test('exit code is 0 (server not running)', async () => {
    await runHandler(() => cli.stop())
    expect(exitCodes).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// stop — stale PID file
// ---------------------------------------------------------------------------

describe('stop — stale PID file', () => {
  let cli: CliHandlers
  let exitCodes: number[]
  let unlinkedPaths: string[]

  beforeEach(() => {
    const result = makeDeps({
      existingPaths: [PID_FILE],
      pidFileContent: '999999999\n',
      isProcessRunning: (_pid) => false, // process is gone
    })
    cli = createCli(result.deps)
    exitCodes = result.exitCodes
    unlinkedPaths = result.unlinkedPaths
  })

  test('calls exit(0) for a stale PID file', async () => {
    const err = await runHandler(() => cli.stop())
    expect(err).not.toBeNull()
    expect(err!.code).toBe(0)
  })

  test('removes the stale PID file via unlinkSync', async () => {
    await runHandler(() => cli.stop())
    expect(unlinkedPaths).toContain(PID_FILE)
  })

  test('exit code is 0 after removing stale PID', async () => {
    await runHandler(() => cli.stop())
    expect(exitCodes).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// stop — live process (SIGTERM)
// ---------------------------------------------------------------------------

describe('stop — live process', () => {
  let cli: CliHandlers
  let killedPids: Array<{ pid: number; signal: string | number }>

  beforeEach(() => {
    let callCount = 0

    const result = makeDeps({
      existingPaths: [PID_FILE],
      pidFileContent: '12345\n',
      // Running on first poll; stops on subsequent polls so the while-loop exits
      isProcessRunning: (_pid) => {
        callCount++
        return callCount <= 1
      },
    })
    cli = createCli(result.deps)
    killedPids = result.killedPids
  })

  test('sends SIGTERM to the live process PID', async () => {
    await runHandler(() => cli.stop())
    expect(killedPids).toHaveLength(1)
    expect(killedPids[0]!.pid).toBe(12345)
  })

  test('uses SIGTERM as the kill signal', async () => {
    await runHandler(() => cli.stop())
    expect(killedPids[0]!.signal).toBe('SIGTERM')
  })
})

// ---------------------------------------------------------------------------
// stop — normal SIGTERM shutdown (process dies within timeout)
// ---------------------------------------------------------------------------

describe('stop — normal SIGTERM shutdown', () => {
  let cli: CliHandlers
  let killedPids: Array<{ pid: number; signal: string | number }>
  let exitCodes: number[]
  let unlinkedPaths: string[]

  beforeEach(() => {
    jest.useFakeTimers()
    let callCount = 0
    const result = makeDeps({
      existingPaths: [PID_FILE],
      pidFileContent: '54321\n',
      // Alive for first check, dead on subsequent checks
      isProcessRunning: (_pid) => {
        callCount++
        return callCount <= 1
      },
    })
    cli = createCli(result.deps)
    killedPids = result.killedPids
    exitCodes = result.exitCodes
    unlinkedPaths = result.unlinkedPaths
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('sends only SIGTERM (no SIGKILL) when process exits within timeout', async () => {
    const p = cli.stop()
    jest.advanceTimersByTime(200)
    await p.catch(() => {})
    const signals = killedPids.map((k) => k.signal)
    expect(signals).toContain('SIGTERM')
    expect(signals).not.toContain('SIGKILL')
  })

  test('removes PID file after clean SIGTERM shutdown', async () => {
    const p = cli.stop()
    jest.advanceTimersByTime(200)
    await p.catch(() => {})
    expect(unlinkedPaths).toContain(PID_FILE)
  })

  test('exits with code 0 after clean SIGTERM shutdown', async () => {
    const p = cli.stop()
    jest.advanceTimersByTime(200)
    await runHandler(() => p)
    expect(exitCodes).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// stop — SIGKILL escalation after stop_timeout
// ---------------------------------------------------------------------------

describe('stop — SIGKILL escalation after stop_timeout', () => {
  let cli: CliHandlers
  let killedPids: Array<{ pid: number; signal: string | number }>
  let exitCodes: number[]
  let unlinkedPaths: string[]

  beforeEach(() => {
    jest.useFakeTimers()
    // Process stays alive through SIGTERM window, dies after SIGKILL
    let killedWithSigkill = false
    const result = makeDeps({
      existingPaths: [PID_FILE],
      pidFileContent: '77777\n',
      // Always running until SIGKILL is sent; detected via killedPids length
      isProcessRunning: (_pid) => !killedWithSigkill,
      loadConfig: () => makeRoutingConfig({ stop_timeout: 1 }), // 1s timeout
    })
    // Intercept kill to detect SIGKILL
    const originalKill = result.deps.kill
    result.deps.kill = (pid, signal) => {
      originalKill(pid, signal)
      if (signal === 'SIGKILL') killedWithSigkill = true
    }
    cli = createCli(result.deps)
    killedPids = result.killedPids
    exitCodes = result.exitCodes
    unlinkedPaths = result.unlinkedPaths
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('sends SIGTERM first, then SIGKILL after stop_timeout', async () => {
    const p = cli.stop()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await p.catch(() => {})
    const signals = killedPids.map((k) => k.signal)
    expect(signals[0]).toBe('SIGTERM')
    expect(signals).toContain('SIGKILL')
  })

  test('SIGKILL is sent to the correct PID', async () => {
    const p = cli.stop()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await p.catch(() => {})
    const sigkillEntry = killedPids.find((k) => k.signal === 'SIGKILL')
    expect(sigkillEntry).toBeDefined()
    expect(sigkillEntry!.pid).toBe(77777)
  })

  test('PID file is removed after SIGKILL and confirmed death', async () => {
    const p = cli.stop()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await p.catch(() => {})
    expect(unlinkedPaths).toContain(PID_FILE)
  })

  test('exits with code 0 after confirmed SIGKILL death', async () => {
    const p = cli.stop()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await runHandler(() => p)
    expect(exitCodes).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// stop — SIGKILL escalation but process survives (no death confirmation)
// ---------------------------------------------------------------------------

describe('stop — SIGKILL sent but process never dies', () => {
  let cli: CliHandlers
  let killedPids: Array<{ pid: number; signal: string | number }>
  let exitCodes: number[]

  beforeEach(() => {
    jest.useFakeTimers()
    const result = makeDeps({
      existingPaths: [PID_FILE],
      pidFileContent: '88888\n',
      isProcessRunning: (_pid) => true, // never dies
      loadConfig: () => makeRoutingConfig({ stop_timeout: 1 }), // 1s timeout
    })
    cli = createCli(result.deps)
    killedPids = result.killedPids
    exitCodes = result.exitCodes
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('still sends SIGKILL after stop_timeout even when process survives', async () => {
    const p = cli.stop()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await p.catch(() => {})
    expect(killedPids.some((k) => k.signal === 'SIGKILL')).toBe(true)
  })

  test('exits with code 1 when process survives SIGKILL', async () => {
    const p = cli.stop()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await runHandler(() => p)
    expect(exitCodes).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// stop — falls back to 30s default when loadConfig throws
// ---------------------------------------------------------------------------

describe('stop — loadConfig throws, falls back to 30s default', () => {
  let cli: CliHandlers
  let killedPids: Array<{ pid: number; signal: string | number }>
  let exitCodes: number[]
  let unlinkedPaths: string[]

  beforeEach(() => {
    jest.useFakeTimers()
    let killedWithSigkill = false
    const result = makeDeps({
      existingPaths: [PID_FILE],
      pidFileContent: '66666\n',
      isProcessRunning: (_pid) => !killedWithSigkill,
      loadConfig: () => { throw new Error('config file not found') },
    })
    const originalKill = result.deps.kill
    result.deps.kill = (pid, signal) => {
      originalKill(pid, signal)
      if (signal === 'SIGKILL') killedWithSigkill = true
    }
    cli = createCli(result.deps)
    killedPids = result.killedPids
    exitCodes = result.exitCodes
    unlinkedPaths = result.unlinkedPaths
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('still sends SIGTERM initially even when loadConfig throws', async () => {
    const p = cli.stop()
    // Advance past 30s default timeout
    jest.advanceTimersByTime(35_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await p.catch(() => {})
    expect(killedPids[0]!.signal).toBe('SIGTERM')
  })

  test('escalates to SIGKILL after the 30s default timeout', async () => {
    const p = cli.stop()
    // Advance only 10s — should NOT have SIGKILL yet (within 30s default window)
    jest.advanceTimersByTime(10_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(killedPids.some((k) => k.signal === 'SIGKILL')).toBe(false)
    // Now advance past the 30s default
    jest.advanceTimersByTime(25_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await p.catch(() => {})
    expect(killedPids.some((k) => k.signal === 'SIGKILL')).toBe(true)
  })

  test('removes PID file after SIGKILL death even with missing config', async () => {
    const p = cli.stop()
    jest.advanceTimersByTime(35_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await p.catch(() => {})
    expect(unlinkedPaths).toContain(PID_FILE)
  })

  test('exits with code 0 after SIGKILL death with default timeout', async () => {
    const p = cli.stop()
    jest.advanceTimersByTime(35_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    jest.advanceTimersByTime(5_000)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await runHandler(() => p)
    expect(exitCodes).toEqual([0])
  })
})

// ---------------------------------------------------------------------------
// clean_restart — shared fixtures
// ---------------------------------------------------------------------------

// Channel IDs used across clean_restart tests
const CH1 = 'C1'
const CH2 = 'C2'
const CH3 = 'C3'

// Two-route config (exit_timeout=1s for fast tests)
const TWO_ROUTE_CONFIG = () =>
  makeRoutingConfig({
    routes: { [CH1]: { cwd: '/cwd/c1' }, [CH2]: { cwd: '/cwd/c2' } },
    exit_timeout: 1,
  })

// Three-route config for concurrent/mixed tests
const THREE_ROUTE_CONFIG = () =>
  makeRoutingConfig({
    routes: { [CH1]: { cwd: '/cwd/c1' }, [CH2]: { cwd: '/cwd/c2' }, [CH3]: { cwd: '/cwd/c3' } },
    exit_timeout: 1,
  })

/**
 * Factory for clean_restart-specific deps.
 * Creates a fresh ClaudeDirectorStub, wires directorStatus/Pause/Kill into CliDeps,
 * and returns the stub alongside the standard DepsBundle for assertions.
 */
interface CleanRestartBundle extends DepsBundle {
  stub: ClaudeDirectorStub
}

function makeCleanRestartDeps(opts: {
  loadConfig?: () => ReturnType<typeof makeRoutingConfig>
  spawnSyncFn?: (cmd: string, args: string[]) => { status: number | null }
  stubOpts?: ConstructorParameters<typeof ClaudeDirectorStub>[0]
} = {}): CleanRestartBundle {
  const stub = new ClaudeDirectorStub(opts.stubOpts ?? {})
  stub.install()

  const base = makeDeps({
    loadConfig: opts.loadConfig ?? TWO_ROUTE_CONFIG,
    spawnSyncFn: opts.spawnSyncFn,
    // Route directorStatus/Pause/Kill through the real wrappers so they use
    // the stub's installed SpawnRunner — this validates argv-style discipline.
    directorStatus: (channelId) => Promise.resolve(directorStatusFn({ channelId })),
    directorPause: (channelId) => Promise.resolve(directorPauseFn({ channelId })),
    directorKill: (channelId) => Promise.resolve(directorKillFn({ channelId })),
  })

  return { ...base, stub }
}

// ---------------------------------------------------------------------------
// clean_restart — SR-1.5 invariant: no `delete` calls ever
// (afterEach at describe-block level catches every test below)
// ---------------------------------------------------------------------------

describe('clean_restart', () => {
  let result: CleanRestartBundle

  afterEach(() => {
    // SR-1.5: clean_restart must NEVER call delete on any spawn
    expect(result.stub.calls.filter((c) => c.verb === 'delete').length).toBe(0)
    result.stub.uninstall()
    jest.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // stop/start delegation
  // -------------------------------------------------------------------------

  describe('stop/start delegation', () => {
    test('stop is called before start', async () => {
      result = makeCleanRestartDeps({
        loadConfig: () => makeRoutingConfig({ routes: {}, exit_timeout: 1 }),
      })
      await createCli(result.deps).clean_restart()
      const subcmds = result.spawnCalls.map((c) => c.args[c.args.length - 1])
      expect(subcmds.indexOf('stop')).toBeGreaterThanOrEqual(0)
      expect(subcmds.indexOf('start')).toBeGreaterThan(subcmds.indexOf('stop'))
    })

    test('start fails → exits with start exit code', async () => {
      result = makeCleanRestartDeps({
        loadConfig: () => makeRoutingConfig({ routes: {}, exit_timeout: 1 }),
        spawnSyncFn: (_cmd, args) => {
          const sub = args[args.length - 1]
          return { status: sub === 'stop' ? 0 : 1 }
        },
      })
      const err = await runHandler(() => createCli(result.deps).clean_restart())
      expect(err).not.toBeNull()
      expect(err!.code).toBe(1)
      expect(result.exitCodes).toEqual([1])
    })

    test('stop was called before start when start fails', async () => {
      result = makeCleanRestartDeps({
        loadConfig: () => makeRoutingConfig({ routes: {}, exit_timeout: 1 }),
        spawnSyncFn: (_cmd, args) => {
          const sub = args[args.length - 1]
          return { status: sub === 'stop' ? 0 : 1 }
        },
      })
      await runHandler(() => createCli(result.deps).clean_restart())
      const subcmds = result.spawnCalls.map((c) => c.args[c.args.length - 1])
      expect(subcmds.indexOf('stop')).toBeLessThan(subcmds.indexOf('start'))
    })
  })

  // -------------------------------------------------------------------------
  // config load failure
  // -------------------------------------------------------------------------

  describe('config load fails', () => {
    test('calls exit(1) immediately and skips stop/start', async () => {
      result = makeCleanRestartDeps({
        loadConfig: () => { throw new Error('config read error') },
      })
      const err = await runHandler(() => createCli(result.deps).clean_restart())
      expect(err).not.toBeNull()
      expect(err!.code).toBe(1)
      const subcmds = result.spawnCalls.map((c) => c.args[c.args.length - 1])
      expect(subcmds).not.toContain('stop')
      expect(subcmds).not.toContain('start')
    })
  })

  // -------------------------------------------------------------------------
  // no routes configured
  // -------------------------------------------------------------------------

  describe('no routes configured', () => {
    test('makes no director calls; stop and start still proceed', async () => {
      result = makeCleanRestartDeps({
        loadConfig: () => makeRoutingConfig({ routes: {}, exit_timeout: 1 }),
      })
      await createCli(result.deps).clean_restart()
      // No status/pause/kill calls when there are zero routes
      const directorVerbs = result.stub.calls.map((c) => c.verb)
      expect(directorVerbs).toHaveLength(0)
      const subcmds = result.spawnCalls.map((c) => c.args[c.args.length - 1])
      expect(subcmds).toContain('stop')
      expect(subcmds).toContain('start')
    })

    test('does not call exit with an error', async () => {
      result = makeCleanRestartDeps({
        loadConfig: () => makeRoutingConfig({ routes: {}, exit_timeout: 1 }),
      })
      const err = await runHandler(() => createCli(result.deps).clean_restart())
      expect(err).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // ErrSpawnNotFound precheck → skip (no pause, no kill)
  // -------------------------------------------------------------------------

  describe('precheck: ErrSpawnNotFound → skip', () => {
    test('no kill called when spawn row not found; start/stop proceed', async () => {
      // No spawn rows in stub → status returns ErrSpawnNotFound for both channels
      result = makeCleanRestartDeps()
      await createCli(result.deps).clean_restart()
      const killCalls = result.stub.calls.filter((c) => c.verb === 'kill')
      expect(killCalls).toHaveLength(0)
      const subcmds = result.spawnCalls.map((c) => c.args[c.args.length - 1])
      expect(subcmds).toContain('stop')
      expect(subcmds).toContain('start')
    })

    test('no pause called when spawn row not found', async () => {
      result = makeCleanRestartDeps()
      await createCli(result.deps).clean_restart()
      const pauseCalls = result.stub.calls.filter((c) => c.verb === 'pause')
      expect(pauseCalls).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // terminal state precheck (ended / missing) → skip
  // -------------------------------------------------------------------------

  describe('precheck: ended/missing state → skip', () => {
    test('ended state → no pause, no kill', async () => {
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [
            makeSpawnRow({ channelId: CH1, state: 'ended' }),
            makeSpawnRow({ channelId: CH2, state: 'missing' }),
          ],
        },
      })
      await createCli(result.deps).clean_restart()
      const pauseCalls = result.stub.calls.filter((c) => c.verb === 'pause')
      const killCalls = result.stub.calls.filter((c) => c.verb === 'kill')
      expect(pauseCalls).toHaveLength(0)
      expect(killCalls).toHaveLength(0)
    })

    test('stop and start still proceed when all channels are terminal', async () => {
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [
            makeSpawnRow({ channelId: CH1, state: 'ended' }),
            makeSpawnRow({ channelId: CH2, state: 'ended' }),
          ],
        },
      })
      await createCli(result.deps).clean_restart()
      const subcmds = result.spawnCalls.map((c) => c.args[c.args.length - 1])
      expect(subcmds).toContain('stop')
      expect(subcmds).toContain('start')
    })
  })

  // -------------------------------------------------------------------------
  // precheck other error → fall through to kill directly
  // -------------------------------------------------------------------------

  describe('precheck: other error → kill directly', () => {
    test('status ErrNonZeroExit → kill called, no pause', async () => {
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [
            makeSpawnRow({ channelId: CH1, state: 'waiting' }),
            makeSpawnRow({ channelId: CH2, state: 'waiting' }),
          ],
        },
      })
      // Queue a non-ErrSpawnNotFound error on precheck status for both channels
      result.stub.setStatusResponseQueue(`cscb_${CH1}`, [
        { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 2, stderr: 'crash' } },
      ])
      result.stub.setStatusResponseQueue(`cscb_${CH2}`, [
        { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 2, stderr: 'crash' } },
      ])
      await createCli(result.deps).clean_restart()
      const pauseCalls = result.stub.calls.filter((c) => c.verb === 'pause')
      expect(pauseCalls).toHaveLength(0)
      const killCalls = result.stub.calls.filter((c) => c.verb === 'kill')
      expect(killCalls.length).toBeGreaterThanOrEqual(1)
    })

    test('start/stop still proceed after precheck failure', async () => {
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [makeSpawnRow({ channelId: CH1, state: 'waiting' })],
        },
        loadConfig: () => makeRoutingConfig({
          routes: { [CH1]: { cwd: '/cwd/c1' } },
          exit_timeout: 1,
        }),
      })
      result.stub.setStatusResponseQueue(`cscb_${CH1}`, [
        { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 2, stderr: 'crash' } },
      ])
      await createCli(result.deps).clean_restart()
      const subcmds = result.spawnCalls.map((c) => c.args[c.args.length - 1])
      expect(subcmds).toContain('stop')
      expect(subcmds).toContain('start')
    })
  })

  // -------------------------------------------------------------------------
  // waiting state → pause → poll until ended → clean exit
  // -------------------------------------------------------------------------

  describe('waiting state → pause → poll until ended', () => {
    test('pause called, then poll resolves to ended → no kill', async () => {
      jest.useFakeTimers()
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [makeSpawnRow({ channelId: CH1, state: 'waiting' })],
        },
        loadConfig: () => makeRoutingConfig({
          routes: { [CH1]: { cwd: '/cwd/c1' } },
          exit_timeout: 5,
        }),
      })
      // Queue: [{ ok: true }] lets the precheck fall through to spawnRow state=waiting.
      // The second entry (ErrSpawnNotFound) is consumed by the first poll → clean exit.
      result.stub.setStatusResponseQueue(`cscb_${CH1}`, [
        { ok: true },
        { ok: false, error: { kind: 'ErrSpawnNotFound', message: 'gone' } },
      ])
      const p = createCli(result.deps).clean_restart()
      await drainFakeTimers(p)
      const pauseCalls = result.stub.calls.filter((c) => c.verb === 'pause')
      expect(pauseCalls.length).toBeGreaterThanOrEqual(1)
      const killCalls = result.stub.calls.filter((c) => c.verb === 'kill')
      expect(killCalls).toHaveLength(0)
    })

    test('all calls go through the stub (argv-style discipline)', async () => {
      jest.useFakeTimers()
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [makeSpawnRow({ channelId: CH1, state: 'waiting' })],
        },
        loadConfig: () => makeRoutingConfig({
          routes: { [CH1]: { cwd: '/cwd/c1' } },
          exit_timeout: 5,
        }),
      })
      result.stub.setStatusResponseQueue(`cscb_${CH1}`, [
        { ok: true },
        { ok: false, error: { kind: 'ErrSpawnNotFound', message: 'gone' } },
      ])
      const p = createCli(result.deps).clean_restart()
      await drainFakeTimers(p)
      // Every director call must appear in stub.calls
      const verbs = result.stub.calls.map((c) => c.verb)
      expect(verbs).toContain('status')
      expect(verbs).toContain('pause')
    })
  })

  // -------------------------------------------------------------------------
  // pause failure → fall through to kill
  // -------------------------------------------------------------------------

  describe('pause fails → kill escalation', () => {
    test('kill called after pause failure', async () => {
      jest.useFakeTimers()
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [makeSpawnRow({ channelId: CH1, state: 'waiting' })],
        },
        loadConfig: () => makeRoutingConfig({
          routes: { [CH1]: { cwd: '/cwd/c1' } },
          exit_timeout: 5,
        }),
      })
      result.stub.setPauseResponseQueue(`cscb_${CH1}`, [
        { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 1, stderr: 'pause failed' } },
      ])
      const p = createCli(result.deps).clean_restart()
      await drainFakeTimers(p)
      const killCalls = result.stub.calls.filter((c) => c.verb === 'kill')
      expect(killCalls.length).toBeGreaterThanOrEqual(1)
    })

    test('start/stop proceed after pause failure', async () => {
      jest.useFakeTimers()
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [makeSpawnRow({ channelId: CH1, state: 'waiting' })],
        },
        loadConfig: () => makeRoutingConfig({
          routes: { [CH1]: { cwd: '/cwd/c1' } },
          exit_timeout: 5,
        }),
      })
      result.stub.setPauseResponseQueue(`cscb_${CH1}`, [
        { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 1, stderr: 'pause failed' } },
      ])
      const p = createCli(result.deps).clean_restart()
      await drainFakeTimers(p)
      const subcmds = result.spawnCalls.map((c) => c.args[c.args.length - 1])
      expect(subcmds).toContain('stop')
      expect(subcmds).toContain('start')
    })
  })

  // -------------------------------------------------------------------------
  // poll timeout → directorKill + force-kill log
  // -------------------------------------------------------------------------

  describe('poll timeout → force kill', () => {
    test('directorKill called after exit_timeout expires', async () => {
      jest.useFakeTimers()
      // CH1 stays in 'waiting' forever so poll never finds a terminal state
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [makeSpawnRow({ channelId: CH1, state: 'waiting' })],
        },
        loadConfig: () => makeRoutingConfig({
          routes: { [CH1]: { cwd: '/cwd/c1' } },
          exit_timeout: 1,
        }),
      })
      const p = createCli(result.deps).clean_restart()
      await drainFakeTimers(p)
      const killCalls = result.stub.calls.filter((c) => c.verb === 'kill')
      expect(killCalls.length).toBeGreaterThanOrEqual(1)
    })

    test('restart proceeds after kill escalation', async () => {
      jest.useFakeTimers()
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [makeSpawnRow({ channelId: CH1, state: 'waiting' })],
        },
        loadConfig: () => makeRoutingConfig({
          routes: { [CH1]: { cwd: '/cwd/c1' } },
          exit_timeout: 1,
        }),
      })
      const p = createCli(result.deps).clean_restart()
      await drainFakeTimers(p)
      const subcmds = result.spawnCalls.map((c) => c.args[c.args.length - 1])
      expect(subcmds).toContain('stop')
      expect(subcmds).toContain('start')
    })
  })

  // -------------------------------------------------------------------------
  // backoff cadence: 500ms start / 5000ms ceiling
  // -------------------------------------------------------------------------

  describe('backoff cadence', () => {
    test('first poll fires after 500ms delay (not immediately after pause)', async () => {
      jest.useFakeTimers()
      let pollCount = 0

      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [makeSpawnRow({ channelId: CH1, state: 'waiting' })],
        },
        loadConfig: () => makeRoutingConfig({
          routes: { [CH1]: { cwd: '/cwd/c1' } },
          exit_timeout: 10,
        }),
      })

      // Wrap directorStatus to count poll calls (after precheck)
      let precheckDone = false
      const origStatus = result.deps.directorStatus
      result.deps.directorStatus = async (channelId) => {
        if (!precheckDone) {
          precheckDone = true
        } else {
          pollCount++
        }
        return origStatus(channelId)
      }

      const p = createCli(result.deps).clean_restart()
      // Flush microtasks: precheck + pause should have run
      for (let i = 0; i < 20; i++) await Promise.resolve()
      // At t=0, no poll yet (first poll scheduled at t+500ms)
      expect(pollCount).toBe(0)

      // Advance only 400ms — still before the 500ms first poll
      jest.advanceTimersByTime(400)
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(pollCount).toBe(0)

      // Advance past 500ms — first poll should now have fired
      jest.advanceTimersByTime(200)
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(pollCount).toBeGreaterThanOrEqual(1)

      await drainFakeTimers(p)
    })

    test('under exit_timeout multiple polls occur (backoff does not prevent progression)', async () => {
      jest.useFakeTimers()
      let pollCount = 0
      let precheckDone = false

      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [makeSpawnRow({ channelId: CH1, state: 'waiting' })],
        },
        loadConfig: () => makeRoutingConfig({
          routes: { [CH1]: { cwd: '/cwd/c1' } },
          exit_timeout: 30,
        }),
      })

      const origStatus = result.deps.directorStatus
      result.deps.directorStatus = async (channelId) => {
        if (!precheckDone) { precheckDone = true } else { pollCount++ }
        return origStatus(channelId)
      }

      const p = createCli(result.deps).clean_restart()
      // Advance 30s (exit_timeout) in chunks to allow async polls to interleave
      for (let step = 0; step < 10; step++) {
        jest.advanceTimersByTime(3_000)
        for (let i = 0; i < 15; i++) await Promise.resolve()
      }
      await drainFakeTimers(p)

      // 30s with 500ms → 1s → 2s → 4s → 5s (ceiling) intervals:
      // approx: 500+1000+2000+4000+5000+5000+5000+5000 = 27500 < 30000
      // So at least 7 polls should have fired within exit_timeout
      expect(pollCount).toBeGreaterThanOrEqual(5)
      // But NOT more than 30s / 500ms = 60 polls (ceiling keeps count low)
      expect(pollCount).toBeLessThan(60)
    })
  })

  // -------------------------------------------------------------------------
  // concurrent fan-out: Promise.allSettled
  // -------------------------------------------------------------------------

  describe('concurrent fan-out (Promise.allSettled)', () => {
    test('both channels get a status call (concurrent, not sequential)', async () => {
      jest.useFakeTimers()
      // Both channels in waiting state; each exits cleanly on first poll
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [
            makeSpawnRow({ channelId: CH1, state: 'waiting' }),
            makeSpawnRow({ channelId: CH2, state: 'waiting' }),
          ],
        },
      })
      // { ok: true } lets precheck fall through to spawnRow; ErrSpawnNotFound is consumed by first poll
      result.stub.setStatusResponseQueue(`cscb_${CH1}`, [
        { ok: true },
        { ok: false, error: { kind: 'ErrSpawnNotFound', message: 'gone' } },
      ])
      result.stub.setStatusResponseQueue(`cscb_${CH2}`, [
        { ok: true },
        { ok: false, error: { kind: 'ErrSpawnNotFound', message: 'gone' } },
      ])
      const p = createCli(result.deps).clean_restart()
      await drainFakeTimers(p)
      const statusCalls = result.stub.calls.filter((c) => c.verb === 'status')
      const channels = new Set(statusCalls.map((c) => {
        const idx = c.argv.indexOf('--claude-instance-id')
        return idx >= 0 ? c.argv[idx + 1] : ''
      }))
      expect(channels).toContain(`cscb_${CH1}`)
      expect(channels).toContain(`cscb_${CH2}`)
    })

    test('one channel failure does not block the other channel', async () => {
      jest.useFakeTimers()
      // CH1: pause fails → kill; CH2: exits cleanly after first poll
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [
            makeSpawnRow({ channelId: CH1, state: 'waiting' }),
            makeSpawnRow({ channelId: CH2, state: 'waiting' }),
          ],
        },
      })
      result.stub.setPauseResponseQueue(`cscb_${CH1}`, [
        { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 1, stderr: 'pause fail' } },
      ])
      // { ok: true } lets precheck fall through; ErrSpawnNotFound is consumed by first poll
      result.stub.setStatusResponseQueue(`cscb_${CH2}`, [
        { ok: true },
        { ok: false, error: { kind: 'ErrSpawnNotFound', message: 'gone' } },
      ])
      const p = createCli(result.deps).clean_restart()
      await drainFakeTimers(p)
      // CH1 kill happened
      const killCalls = result.stub.calls.filter((c) => c.verb === 'kill')
      const killedChannels = new Set(killCalls.map((c) => {
        const idx = c.argv.indexOf('--claude-instance-id')
        return idx >= 0 ? c.argv[idx + 1] : ''
      }))
      expect(killedChannels).toContain(`cscb_${CH1}`)
      // CH2 handled independently — restart still happened
      const subcmds = result.spawnCalls.map((c) => c.args[c.args.length - 1])
      expect(subcmds).toContain('stop')
      expect(subcmds).toContain('start')
    })

    test('does not surface per-channel errors as a process exit', async () => {
      jest.useFakeTimers()
      // All channels in 'waiting', pause fails on all → kill escalation
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [
            makeSpawnRow({ channelId: CH1, state: 'waiting' }),
            makeSpawnRow({ channelId: CH2, state: 'waiting' }),
          ],
        },
      })
      result.stub.setPauseResponseQueue(`cscb_${CH1}`, [
        { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 1, stderr: 'oops' } },
      ])
      result.stub.setPauseResponseQueue(`cscb_${CH2}`, [
        { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 1, stderr: 'oops' } },
      ])
      const p = createCli(result.deps).clean_restart()
      const err = await runHandler(() => drainFakeTimers(p))
      expect(err).toBeNull()
      expect(result.exitCodes).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // three-channel: mixed clean / timeout / precheck-error
  // -------------------------------------------------------------------------

  describe('mixed outcomes across three channels', () => {
    test('CH1 clean, CH2 times out (kill), CH3 precheck error (kill) — restart proceeds', async () => {
      jest.useFakeTimers()
      result = makeCleanRestartDeps({
        stubOpts: {
          spawnRows: [
            makeSpawnRow({ channelId: CH1, state: 'waiting' }),
            makeSpawnRow({ channelId: CH2, state: 'waiting' }),
            makeSpawnRow({ channelId: CH3, state: 'waiting' }),
          ],
        },
        loadConfig: THREE_ROUTE_CONFIG,
      })
      // CH1: exits cleanly after pause — { ok: true } lets precheck fall through;
      //       ErrSpawnNotFound is consumed by first poll → clean exit
      result.stub.setStatusResponseQueue(`cscb_${CH1}`, [
        { ok: true },
        { ok: false, error: { kind: 'ErrSpawnNotFound', message: 'gone' } },
      ])
      // CH2: stays waiting → times out → kill
      // (no queue override, status always returns current spawnRow state = waiting)
      // CH3: precheck returns non-ErrSpawnNotFound error → kill directly
      result.stub.setStatusResponseQueue(`cscb_${CH3}`, [
        { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 2, stderr: 'bad' } },
      ])

      const p = createCli(result.deps).clean_restart()
      await drainFakeTimers(p)

      const subcmds = result.spawnCalls.map((c) => c.args[c.args.length - 1])
      expect(subcmds).toContain('stop')
      expect(subcmds).toContain('start')
      // CH1 should have been paused
      const pauseCalls = result.stub.calls.filter((c) => c.verb === 'pause')
      const pausedChannels = new Set(pauseCalls.map((c) => {
        const idx = c.argv.indexOf('--claude-instance-id')
        return idx >= 0 ? c.argv[idx + 1] : ''
      }))
      expect(pausedChannels).toContain(`cscb_${CH1}`)
      // No delete calls (SR-1.5 checked in afterEach)
    })
  })
})

// ---------------------------------------------------------------------------
// T4 — Integration test: intentionally not covered in unit tests
// ---------------------------------------------------------------------------
//
// T4: clean_restart survives invoker death.
//   Requires launching a real process in a real tmux session and killing the
//   invoking shell mid-run. Not feasible as a unit test. Integration test only.
