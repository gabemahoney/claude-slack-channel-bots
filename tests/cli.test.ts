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
  sendKeys?: (session: string, keys: string) => Promise<void>
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
    sendKeys: async (session, keys) => {
      sendKeysCalls.push({ session, keys })
      await (overrides.sendKeys ?? (() => Promise.resolve()))(session, keys)
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
// Shared session fixtures for clean_restart tests
// ---------------------------------------------------------------------------

const SESSION_A = { tmuxSession: 'slack_bot_a', lastLaunch: '2026-01-01T00:00:00Z' }
const SESSION_B = { tmuxSession: 'slack_bot_b', lastLaunch: '2026-01-01T00:00:00Z' }
const SESSION_C = { tmuxSession: 'slack_bot_c', lastLaunch: '2026-01-01T00:00:00Z' }

// ---------------------------------------------------------------------------
// clean_restart — all sessions exit cleanly in parallel
// ---------------------------------------------------------------------------

describe('clean_restart — all sessions exit cleanly in parallel', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    result = makeDeps({
      sessions: { C1: SESSION_A, C2: SESSION_B },
      hasSession: async () => true,
      isClaudeRunning: async () => false, // both exit immediately on first poll
    })
    cli = createCli(result.deps)
  })

  test('sends /exit to every session', async () => {
    await cli.clean_restart()
    const exitTargets = new Set(
      result.sendKeysCalls.filter((c) => c.keys === '/exit').map((c) => c.session),
    )
    expect(exitTargets).toEqual(new Set([SESSION_A.tmuxSession, SESSION_B.tmuxSession]))
  })

  test('sends Enter to every session', async () => {
    await cli.clean_restart()
    const enterTargets = new Set(
      result.sendKeysCalls.filter((c) => c.keys === 'Enter').map((c) => c.session),
    )
    expect(enterTargets).toEqual(new Set([SESSION_A.tmuxSession, SESSION_B.tmuxSession]))
  })

  test('does not force-kill any session', async () => {
    await cli.clean_restart()
    expect(result.killSessionCalls).toHaveLength(0)
  })

  test('calls stop before start', async () => {
    await cli.clean_restart()
    const subcommands = result.spawnCalls.map((c) => c.args[c.args.length - 1])
    expect(subcommands.indexOf('stop')).toBeLessThan(subcommands.indexOf('start'))
  })

  test('does not call exit with an error code', async () => {
    const err = await runHandler(() => cli.clean_restart())
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
    result = makeDeps({
      sessions: { C1: SESSION_A, C2: SESSION_B },
      hasSession: async () => true,
      // B never exits; A exits immediately on first poll
      isClaudeRunning: async (session) => session === SESSION_B.tmuxSession,
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
    expect(exitTargets).toEqual(new Set([SESSION_A.tmuxSession, SESSION_B.tmuxSession]))
  })

  test('force-kills only the timed-out session', async () => {
    const p = cli.clean_restart()
    await drainFakeTimers(p)
    expect(result.killSessionCalls).toEqual([SESSION_B.tmuxSession])
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
// clean_restart — sessions.json missing (no entries)
// ---------------------------------------------------------------------------

describe('clean_restart — sessions.json missing', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    result = makeDeps({
      sessions: {}, // no sessions → file missing or empty
    })
    cli = createCli(result.deps)
  })

  test('makes no tmux calls', async () => {
    await cli.clean_restart()
    expect(result.sendKeysCalls).toHaveLength(0)
    expect(result.killSessionCalls).toHaveLength(0)
  })

  test('proceeds to stop and start', async () => {
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
// clean_restart — server not running (tmux sessions gone)
// ---------------------------------------------------------------------------

describe('clean_restart — server not running', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    result = makeDeps({
      sessions: { C1: SESSION_A },
      hasSession: async () => false, // tmux sessions no longer exist
    })
    cli = createCli(result.deps)
  })

  test('makes no sendKeys calls when tmux sessions are gone', async () => {
    await cli.clean_restart()
    expect(result.sendKeysCalls).toHaveLength(0)
  })

  test('stop exits 0', async () => {
    await cli.clean_restart()
    const stopCall = result.spawnCalls.find((c) => c.args[c.args.length - 1] === 'stop')
    expect(stopCall).toBeDefined()
  })

  test('start exits 0 and no error is surfaced', async () => {
    const err = await runHandler(() => cli.clean_restart())
    expect(err).toBeNull()
    const startCall = result.spawnCalls.find((c) => c.args[c.args.length - 1] === 'start')
    expect(startCall).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// clean_restart — all sessions force-killed
// ---------------------------------------------------------------------------

describe('clean_restart — all sessions force-killed', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    jest.useFakeTimers()
    result = makeDeps({
      sessions: { C1: SESSION_A, C2: SESSION_B },
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
    expect(new Set(result.killSessionCalls)).toEqual(
      new Set([SESSION_A.tmuxSession, SESSION_B.tmuxSession]),
    )
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
// clean_restart — start fails after stop
// ---------------------------------------------------------------------------

describe('clean_restart — start fails after stop', () => {
  let cli: CliHandlers
  let result: DepsBundle

  beforeEach(() => {
    result = makeDeps({
      sessions: {},
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
// clean_restart — mixed: clean exit, timeout, sendKeys error
// ---------------------------------------------------------------------------

describe('clean_restart — mixed success/failure', () => {
  // A: exits cleanly; B: times out, force-killed; C: sendKeys throws, treated as best-effort

  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function makeMixedDeps() {
    return makeDeps({
      sessions: { C1: SESSION_A, C2: SESSION_B, C3: SESSION_C },
      hasSession: async () => true,
      sendKeys: async (session, _keys) => {
        if (session === SESSION_C.tmuxSession) throw new Error('sendKeys failed')
      },
      isClaudeRunning: async (session) => session === SESSION_B.tmuxSession,
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

  test('B is force-killed, A and C are not', async () => {
    const result = makeMixedDeps()
    const p = createCli(result.deps).clean_restart()
    await drainFakeTimers(p)
    expect(result.killSessionCalls).toContain(SESSION_B.tmuxSession)
    expect(result.killSessionCalls).not.toContain(SESSION_A.tmuxSession)
    expect(result.killSessionCalls).not.toContain(SESSION_C.tmuxSession)
  })

  test('does not surface individual session errors as a process exit', async () => {
    const result = makeMixedDeps()
    const p = createCli(result.deps).clean_restart()
    const err = await runHandler(() => drainFakeTimers(p))
    expect(err).toBeNull()
    expect(result.exitCodes).toHaveLength(0)
  })
})
