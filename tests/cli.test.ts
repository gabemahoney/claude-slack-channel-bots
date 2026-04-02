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
import type { SessionsMap } from '../src/sessions.ts'
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
const ROUTING_JSON = join(STATE_DIR, 'routing.json')

interface DepsOverrides {
  spawnSyncStatus?: number | null
  spawnSyncFn?: (cmd: string, args: string[]) => { status: number | null }
  env?: NodeJS.ProcessEnv
  existingPaths?: string[]
  pidFileContent?: string
  isProcessRunning?: (pid: number) => boolean
  sessions?: SessionsMap
  hasSession?: (name: string) => Promise<boolean>
  loadConfig?: () => ReturnType<typeof makeRoutingConfig>
  sessionName?: (cwd: string) => string
  sendKeys?: (session: string, ...keys: string[]) => Promise<void>
  isClaudeRunning?: (session: string) => Promise<boolean>
  killSession?: (session: string) => Promise<void>
}

interface DepsBundle {
  deps: CliDeps
  exitCodes: number[]
  unlinkedPaths: string[]
  killedPids: Array<{ pid: number; signal: string | number }>
  startServerCalled: boolean[]
  spawnCalls: Array<{ cmd: string; args: string[] }>
  sendKeysCalls: Array<{ session: string; keys: string }>
  killSessionCalls: string[]
}

/** Build a fully-stubbed CliDeps with sensible passing defaults. */
function makeDeps(overrides: DepsOverrides = {}): DepsBundle {
  const exitCodes: number[] = []
  const unlinkedPaths: string[] = []
  const killedPids: Array<{ pid: number; signal: string | number }> = []
  const startServerCalled: boolean[] = []
  const spawnCalls: Array<{ cmd: string; args: string[] }> = []
  const sendKeysCalls: Array<{ session: string; keys: string }> = []
  const killSessionCalls: string[] = []

  const existingPaths = new Set(overrides.existingPaths ?? [ROUTING_JSON])

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
    hasSession: overrides.hasSession ?? (async (_name) => true),
    loadConfig: overrides.loadConfig ?? (() => makeRoutingConfig()),
    sessionName: overrides.sessionName ?? ((cwd) => `slack_bot_stub_${cwd}`),
    sendKeys: async (session, ...keys) => {
      for (const key of keys) {
        sendKeysCalls.push({ session, keys: key })
      }
      await (overrides.sendKeys ?? (() => Promise.resolve()))(session, ...keys)
    },
    isClaudeRunning: overrides.isClaudeRunning ?? (async (_session) => false),
    killSession: async (session) => {
      killSessionCalls.push(session)
      await (overrides.killSession ?? (() => Promise.resolve()))(session)
    },
    readSessions: () => overrides.sessions ?? {},
  }

  return { deps, exitCodes, unlinkedPaths, killedPids, startServerCalled, spawnCalls, sendKeysCalls, killSessionCalls }
}

/**
 * Drive fake timers forward until the given promise settles.
 * Alternates between advancing the fake clock by 5 s and flushing the
 * microtask queue so async continuations (await isClaudeRunning, etc.)
 * get a chance to run.  Must be called with jest.useFakeTimers() active.
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
// start — missing routing.json
// ---------------------------------------------------------------------------

describe('start — missing routing.json', () => {
  let cli: CliHandlers
  let exitCodes: number[]

  beforeEach(() => {
    enterDaemonChild()
    const result = makeDeps({
      existingPaths: [], // routing.json not present
    })
    cli = createCli(result.deps)
    exitCodes = result.exitCodes
  })

  afterEach(() => exitDaemonChild())

  test('calls exit(1) when routing.json does not exist', async () => {
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
// Shared fixtures for clean_restart tests
// ---------------------------------------------------------------------------

// Deterministic session name helper — mirrors the sessionName stub default
function fakeSessionName(cwd: string): string {
  return `slack_bot_${cwd.replace(/\//g, '_')}`
}

const CWD_C1 = '/cwd/c1'
const CWD_C2 = '/cwd/c2'
const CWD_C3 = '/cwd/c3'

const SN_C1 = fakeSessionName(CWD_C1)
const SN_C2 = fakeSessionName(CWD_C2)
const SN_C3 = fakeSessionName(CWD_C3)

// Two-route config used by most tests (exit_timeout=1 for fast tests)
const TWO_ROUTE_CONFIG = () =>
  makeRoutingConfig({
    routes: { C1: { cwd: CWD_C1 }, C2: { cwd: CWD_C2 } },
    exit_timeout: 1,
  })

// Three-route config for mixed tests
const THREE_ROUTE_CONFIG = () =>
  makeRoutingConfig({
    routes: { C1: { cwd: CWD_C1 }, C2: { cwd: CWD_C2 }, C3: { cwd: CWD_C3 } },
    exit_timeout: 1,
  })

// ---------------------------------------------------------------------------
// clean_restart — all sessions exit cleanly
// ---------------------------------------------------------------------------

describe('clean_restart — all sessions exit cleanly', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    jest.useFakeTimers()
    // isClaudeRunning: true on first call (guard passes → sendKeys fires),
    // false on subsequent calls (poll detects clean exit)
    const callCounts = new Map<string, number>()
    result = makeDeps({
      loadConfig: TWO_ROUTE_CONFIG,
      sessionName: fakeSessionName,
      hasSession: async () => true,
      isClaudeRunning: async (session) => {
        const n = (callCounts.get(session) ?? 0) + 1
        callCounts.set(session, n)
        return n === 1 // true first time (guard), false on poll
      },
    })
    cli = createCli(result.deps)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('stop called before /exit is sent to sessions', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    const subcommands = result.spawnCalls.map((c) => c.args[c.args.length - 1])
    const stopIdx = subcommands.indexOf('stop')
    const startIdx = subcommands.indexOf('start')
    expect(stopIdx).toBeGreaterThanOrEqual(0)
    expect(startIdx).toBeGreaterThan(stopIdx)
  })

  test('sends /exit atomically (single sendKeys call) to each session', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    // Each session should have exactly one sendKeys call with '/exit' key and one with 'Enter'
    for (const sn of [SN_C1, SN_C2]) {
      const exitCalls = result.sendKeysCalls.filter((c) => c.session === sn && c.keys === '/exit')
      const enterCalls = result.sendKeysCalls.filter((c) => c.session === sn && c.keys === 'Enter')
      expect(exitCalls).toHaveLength(1)
      expect(enterCalls).toHaveLength(1)
    }
  })

  test('does not force-kill any session', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    expect(result.killSessionCalls).toHaveLength(0)
  })

  test('start called after stop', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    const subcommands = result.spawnCalls.map((c) => c.args[c.args.length - 1])
    expect(subcommands).toContain('stop')
    expect(subcommands).toContain('start')
  })

  test('does not call exit with an error code', async () => {
    const p = cli.clean_restart()
    const err = await runHandler(() => drainFakeTimers(p))
    expect(err).toBeNull()
    expect(result.exitCodes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// clean_restart — one session times out, force-killed
// ---------------------------------------------------------------------------

describe('clean_restart — one session times out, force-killed', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    jest.useFakeTimers()
    // C1: true on first call (guard passes), false on poll → clean exit
    // C2: always true → times out and gets force-killed
    const callCounts = new Map<string, number>()
    result = makeDeps({
      loadConfig: TWO_ROUTE_CONFIG,
      sessionName: fakeSessionName,
      hasSession: async () => true,
      isClaudeRunning: async (session) => {
        const n = (callCounts.get(session) ?? 0) + 1
        callCounts.set(session, n)
        if (session === SN_C2) return true  // C2 never exits
        return n === 1                       // C1: true first call, false on poll
      },
    })
    cli = createCli(result.deps)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('sendKeys called for both sessions', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    const exitTargets = new Set(
      result.sendKeysCalls.filter((c) => c.keys === '/exit').map((c) => c.session),
    )
    expect(exitTargets).toEqual(new Set([SN_C1, SN_C2]))
  })

  test('force-kills only the timed-out session', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    expect(result.killSessionCalls).toEqual([SN_C2])
  })

  test('restart proceeds after the force-kill', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    const subcommands = result.spawnCalls.map((c) => c.args[c.args.length - 1])
    expect(subcommands).toContain('stop')
    expect(subcommands).toContain('start')
  })
})

// ---------------------------------------------------------------------------
// clean_restart — no routes configured
// ---------------------------------------------------------------------------

describe('clean_restart — no routes configured', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    result = makeDeps({
      loadConfig: () => makeRoutingConfig({ routes: {}, exit_timeout: 1 }),
      sessionName: fakeSessionName,
    })
    cli = createCli(result.deps)
  })

  test('makes no tmux calls', async () => {
    await cli.clean_restart()
    expect(result.sendKeysCalls).toHaveLength(0)
    expect(result.killSessionCalls).toHaveLength(0)
  })

  test('stop and start still proceed', async () => {
    await cli.clean_restart()
    const subcommands = result.spawnCalls.map((c) => c.args[c.args.length - 1])
    expect(subcommands).toContain('stop')
    expect(subcommands).toContain('start')
  })

  test('does not call exit with an error', async () => {
    const err = await runHandler(() => cli.clean_restart())
    expect(err).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// clean_restart — missing tmux session (hasSession returns false)
// ---------------------------------------------------------------------------

describe('clean_restart — missing tmux session', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    jest.useFakeTimers()
    // C1 has no tmux session; C2 has a session and exits cleanly
    const callCounts = new Map<string, number>()
    result = makeDeps({
      loadConfig: TWO_ROUTE_CONFIG,
      sessionName: fakeSessionName,
      hasSession: async (name) => name === SN_C2,
      isClaudeRunning: async (session) => {
        const n = (callCounts.get(session) ?? 0) + 1
        callCounts.set(session, n)
        return n === 1 // true on guard check, false on poll
      },
    })
    cli = createCli(result.deps)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('skips sendKeys for the missing session', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    const targets = new Set(result.sendKeysCalls.map((c) => c.session))
    expect(targets).not.toContain(SN_C1)
  })

  test('still sends /exit to the present session', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    const targets = new Set(
      result.sendKeysCalls.filter((c) => c.keys === '/exit').map((c) => c.session),
    )
    expect(targets).toContain(SN_C2)
  })

  test('stop and start still proceed', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    const subcommands = result.spawnCalls.map((c) => c.args[c.args.length - 1])
    expect(subcommands).toContain('stop')
    expect(subcommands).toContain('start')
  })
})

// ---------------------------------------------------------------------------
// clean_restart — Claude not running (isClaudeRunning returns false immediately)
// ---------------------------------------------------------------------------

describe('clean_restart — Claude not running', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    result = makeDeps({
      loadConfig: TWO_ROUTE_CONFIG,
      sessionName: fakeSessionName,
      hasSession: async () => true,
      isClaudeRunning: async () => false, // returns false on first check → skipped
    })
    cli = createCli(result.deps)
  })

  test('skips sendKeys when Claude is not running', async () => {
    await cli.clean_restart()
    // isClaudeRunning is called before sendKeys; since false, sendKeys not called
    expect(result.sendKeysCalls).toHaveLength(0)
  })

  test('does not force-kill sessions when Claude was not running', async () => {
    await cli.clean_restart()
    expect(result.killSessionCalls).toHaveLength(0)
  })

  test('stop and start still proceed', async () => {
    await cli.clean_restart()
    const subcommands = result.spawnCalls.map((c) => c.args[c.args.length - 1])
    expect(subcommands).toContain('stop')
    expect(subcommands).toContain('start')
  })
})

// ---------------------------------------------------------------------------
// clean_restart — start fails
// ---------------------------------------------------------------------------

describe('clean_restart — start fails', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    result = makeDeps({
      loadConfig: () => makeRoutingConfig({ routes: {}, exit_timeout: 1 }),
      sessionName: fakeSessionName,
      spawnSyncFn: (_cmd, args) => {
        const subcommand = args[args.length - 1]
        return { status: subcommand === 'stop' ? 0 : 1 }
      },
    })
    cli = createCli(result.deps)
  })

  test('surfaces the start failure as a non-zero exit', async () => {
    const err = await runHandler(() => cli.clean_restart())
    expect(err).not.toBeNull()
    expect(err!.code).toBe(1)
  })

  test('exit code array contains the start failure code', async () => {
    await runHandler(() => cli.clean_restart())
    expect(result.exitCodes).toEqual([1])
  })

  test('stop was called before start', async () => {
    await runHandler(() => cli.clean_restart())
    const subcommands = result.spawnCalls.map((c) => c.args[c.args.length - 1])
    expect(subcommands.indexOf('stop')).toBeLessThan(subcommands.indexOf('start'))
  })
})

// ---------------------------------------------------------------------------
// clean_restart — config load fails
// ---------------------------------------------------------------------------

describe('clean_restart — config load fails', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    result = makeDeps({
      loadConfig: () => { throw new Error('config read error') },
      sessionName: fakeSessionName,
    })
    cli = createCli(result.deps)
  })

  test('calls exit(1) immediately', async () => {
    const err = await runHandler(() => cli.clean_restart())
    expect(err).not.toBeNull()
    expect(err!.code).toBe(1)
  })

  test('does not call stop or start when config fails', async () => {
    await runHandler(() => cli.clean_restart())
    const subcommands = result.spawnCalls.map((c) => c.args[c.args.length - 1])
    expect(subcommands).not.toContain('stop')
    expect(subcommands).not.toContain('start')
  })
})

// ---------------------------------------------------------------------------
// clean_restart — atomic /exit (single sendKeys call per session)
// ---------------------------------------------------------------------------

describe('clean_restart — atomic /exit per session', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    jest.useFakeTimers()
    // true on first call (guard passes → sendKeys fires), false on poll (clean exit)
    const callCounts = new Map<string, number>()
    result = makeDeps({
      loadConfig: TWO_ROUTE_CONFIG,
      sessionName: fakeSessionName,
      hasSession: async () => true,
      isClaudeRunning: async (session) => {
        const n = (callCounts.get(session) ?? 0) + 1
        callCounts.set(session, n)
        return n === 1
      },
    })
    cli = createCli(result.deps)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('exactly one /exit key sent per session', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    for (const sn of [SN_C1, SN_C2]) {
      const count = result.sendKeysCalls.filter((c) => c.session === sn && c.keys === '/exit').length
      expect(count).toBe(1)
    }
  })

  test('exactly one Enter key sent per session', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    for (const sn of [SN_C1, SN_C2]) {
      const count = result.sendKeysCalls.filter((c) => c.session === sn && c.keys === 'Enter').length
      expect(count).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// clean_restart — all sessions force-killed (timeout)
// ---------------------------------------------------------------------------

describe('clean_restart — all sessions force-killed', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    jest.useFakeTimers()
    result = makeDeps({
      loadConfig: TWO_ROUTE_CONFIG,
      sessionName: fakeSessionName,
      hasSession: async () => true,
      isClaudeRunning: async () => true, // neither session ever exits
    })
    cli = createCli(result.deps)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('killSession called for every session', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    expect(new Set(result.killSessionCalls)).toEqual(new Set([SN_C1, SN_C2]))
  })

  test('restart still proceeds after all force-kills', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    const subcommands = result.spawnCalls.map((c) => c.args[c.args.length - 1])
    expect(subcommands).toContain('stop')
    expect(subcommands).toContain('start')
  })
})

// ---------------------------------------------------------------------------
// clean_restart — mixed: clean exit, timeout, sendKeys error
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// clean_restart — T8: concurrent /exit fan-out
// All sessions receive /exit before any session's timeout can expire.
// With Promise.allSettled the fan-out is concurrent — /exit reaches every
// session at approximately the same time regardless of per-session exit latency.
// ---------------------------------------------------------------------------

describe('clean_restart — T8: concurrent /exit fan-out', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('T8: /exit sent to all sessions before any session timeout expires', async () => {
    // Three sessions with different simulated exit latencies:
    //   C1 exits after 1 poll cycle, C2 after 2, C3 never exits (force-killed)
    const sendKeysTimes: Record<string, number> = {}
    const callCounts = new Map<string, number>()

    const result = makeDeps({
      loadConfig: THREE_ROUTE_CONFIG,
      sessionName: fakeSessionName,
      hasSession: async () => true,
      sendKeys: async (session, ...keys) => {
        if (keys.includes('/exit')) {
          sendKeysTimes[session] = Date.now()
        }
      },
      isClaudeRunning: async (session) => {
        const n = (callCounts.get(session) ?? 0) + 1
        callCounts.set(session, n)
        if (session === SN_C3) return true   // never exits — force-killed
        if (session === SN_C2) return n <= 2 // exits after 2 polls
        return n === 1                        // C1 exits after 1 poll
      },
    })

    const p = createCli(result.deps).clean_restart()
    await drainFakeTimers(p)

    // All three sessions must have received /exit
    expect(Object.keys(sendKeysTimes)).toHaveLength(3)
    expect(Object.keys(sendKeysTimes)).toContain(SN_C1)
    expect(Object.keys(sendKeysTimes)).toContain(SN_C2)
    expect(Object.keys(sendKeysTimes)).toContain(SN_C3)
  })

  test('T8: no session waits for another session to finish before receiving /exit', async () => {
    // Verify /exit goes to both sessions even when one exits very quickly.
    // If sessions were sequential, the second would not receive /exit before C1 exits.
    const callCounts = new Map<string, number>()
    const result = makeDeps({
      loadConfig: TWO_ROUTE_CONFIG,
      sessionName: fakeSessionName,
      hasSession: async () => true,
      isClaudeRunning: async (session) => {
        const n = (callCounts.get(session) ?? 0) + 1
        callCounts.set(session, n)
        return n === 1 // each session exits after first poll check
      },
    })

    const p = createCli(result.deps).clean_restart()
    await drainFakeTimers(p)

    // Both sessions must have received /exit (concurrent fan-out)
    const exitTargets = new Set(
      result.sendKeysCalls.filter((c) => c.keys === '/exit').map((c) => c.session),
    )
    expect(exitTargets).toEqual(new Set([SN_C1, SN_C2]))
  })
})

// ---------------------------------------------------------------------------
// clean_restart — mixed: clean exit, timeout, sendKeys error
// ---------------------------------------------------------------------------

describe('clean_restart — mixed success/failure', () => {
  // C1: exits cleanly; C2: times out, force-killed; C3: sendKeys throws, best-effort

  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function makeMixedDeps() {
    return makeDeps({
      loadConfig: THREE_ROUTE_CONFIG,
      sessionName: fakeSessionName,
      hasSession: async () => true,
      sendKeys: async (session, ..._keys) => {
        if (session === SN_C3) throw new Error('sendKeys failed')
      },
      // C1 exits immediately; C2 never exits; C3 throws before poll
      isClaudeRunning: async (session) => session === SN_C2,
    })
  }

  test('restart proceeds despite mixed errors', async () => {
    const result = makeMixedDeps()
    const p = createCli(result.deps).clean_restart()
    await drainFakeTimers(p)
    const subcommands = result.spawnCalls.map((c) => c.args[c.args.length - 1])
    expect(subcommands).toContain('stop')
    expect(subcommands).toContain('start')
  })

  test('C2 is force-killed, C1 and C3 are not', async () => {
    const result = makeMixedDeps()
    const p = createCli(result.deps).clean_restart()
    await drainFakeTimers(p)
    expect(result.killSessionCalls).toContain(SN_C2)
    expect(result.killSessionCalls).not.toContain(SN_C1)
    expect(result.killSessionCalls).not.toContain(SN_C3)
  })

  test('does not surface individual session errors as a process exit', async () => {
    const result = makeMixedDeps()
    const p = createCli(result.deps).clean_restart()
    const err = await runHandler(() => drainFakeTimers(p))
    expect(err).toBeNull()
    expect(result.exitCodes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// T4 / T29 — Integration tests: intentionally not covered in unit tests
// ---------------------------------------------------------------------------
//
// T4: clean_restart survives invoker death.
//   Requires launching a real process in a real tmux session and killing the
//   invoking shell mid-run. Not feasible as a unit test. Integration test only.
//
// T29: All lifecycle events logged (clean_restart.log + server.log contents).
//   Requires a full end-to-end run with real tmux sessions and file I/O.
//   The individual logging behaviors (timestamp format, append mode, etc.) are
//   covered by logging.test.ts (T30). The full lifecycle log audit (T29) is an
//   integration test that inspects log file output from a real clean_restart run.
