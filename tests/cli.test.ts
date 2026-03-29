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

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { join } from 'path'
import type { CliDeps, CliHandlers } from '../cli.ts'

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
  const mod = await import('../cli.ts')
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
  env?: NodeJS.ProcessEnv
  existingPaths?: string[]
  pidFileContent?: string
  isProcessRunning?: (pid: number) => boolean
}

interface DepsBundle {
  deps: CliDeps
  exitCodes: number[]
  unlinkedPaths: string[]
  killedPids: Array<{ pid: number; signal: string | number }>
  startServerCalled: boolean[]
}

/** Build a fully-stubbed CliDeps with sensible passing defaults. */
function makeDeps(overrides: DepsOverrides = {}): DepsBundle {
  const exitCodes: number[] = []
  const unlinkedPaths: string[] = []
  const killedPids: Array<{ pid: number; signal: string | number }> = []
  const startServerCalled: boolean[] = []

  const existingPaths = new Set(overrides.existingPaths ?? [ROUTING_JSON])

  const deps: CliDeps = {
    spawnSync: (_cmd, _args) => ({
      status: overrides.spawnSyncStatus !== undefined ? overrides.spawnSyncStatus : 0,
    }),
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
  }

  return { deps, exitCodes, unlinkedPaths, killedPids, startServerCalled }
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
