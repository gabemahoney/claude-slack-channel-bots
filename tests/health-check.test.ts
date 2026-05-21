/**
 * health-check.test.ts — Tests for the periodic liveness poller.
 *
 * ## Design
 *
 * The isSessionAlive state→liveness tests drive a local replica of the
 * isSessionAliveAdapter logic from server.ts through ClaudeDirectorStub.
 * We cannot import server.ts (module-scope side effects), so we replicate
 * the same logic inline — it is intentionally thin (4 branches).
 *
 * The startHealthCheck tests inject the stub-backed isSessionAlive into
 * HealthCheckDeps; the scheduler under test is unchanged.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test'
import {
  initHealthCheck,
  startHealthCheck,
  _resetHealthCheckState,
  type HealthCheckDeps,
} from '../src/health-check.ts'
import {
  status as cliStatus,
} from '../src/claude-director-cli.ts'
import { CLAUDE_DIRECTOR_LIVE_STATES } from '../src/session-manager.ts'
import {
  ClaudeDirectorStub,
  makeSpawnRow,
} from './test-helpers/claude-director-stub.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_INTERVAL_S = 0.01  // 10 ms interval — fast enough for real-timer tests
const WAIT_MS = 50             // wait after starting; long enough for several ticks
const TEST_CHANNEL = 'C_TEST1'
const TEST_CWD = '/cwd/test'

// ---------------------------------------------------------------------------
// Local replica of isSessionAliveAdapter (server.ts lines ~1512-1531)
//
// Mirrors the production adapter exactly so we can test state→liveness mapping
// without importing server.ts (which has module-scope side effects).
// ---------------------------------------------------------------------------

async function isSessionAlive(channelId: string): Promise<boolean> {
  try {
    const result = cliStatus({ channelId })
    if (result.ok) {
      const { state } = result.data
      if ((CLAUDE_DIRECTOR_LIVE_STATES as Set<string>).has(state)) return true
      if (state === 'ended' || state === 'missing') return false
      // Unexpected state — treat as dead
      console.error(`[slack] isSessionAlive: unexpected state '${state}' for channel=${channelId} — treating as dead`)
      return false
    }
    if (result.error.kind === 'ErrSpawnNotFound') return false
    console.error(`[slack] isSessionAlive: status error for channel=${channelId}: ${result.error.kind} — treating as dead`)
    return false
  } catch (err) {
    console.error(`[slack] isSessionAlive: unexpected throw for channel=${channelId}:`, err)
    return false
  }
}

// ---------------------------------------------------------------------------
// makeDeps factory
// ---------------------------------------------------------------------------

type DepsOpts = {
  stub: ClaudeDirectorStub
  isRestartPendingResult?: boolean
  isActiveLaunchingResult?: boolean
  hasReachedMaxFailuresResult?: boolean
  isShuttingDownResult?: boolean
  routes?: Record<string, string>
}

function makeDeps(opts: DepsOpts): HealthCheckDeps & {
  scheduleRestartCalls: Array<{ channelId: string; cwd: string }>
  isSessionAliveCalls: string[]
} {
  const scheduleRestartCalls: Array<{ channelId: string; cwd: string }> = []
  const isSessionAliveCalls: string[] = []

  return {
    scheduleRestartCalls,
    isSessionAliveCalls,

    async isSessionAlive(channelId) {
      isSessionAliveCalls.push(channelId)
      return isSessionAlive(channelId)
    },
    isRestartPendingOrActive(_channelId) {
      return (opts.isRestartPendingResult ?? false) || (opts.isActiveLaunchingResult ?? false)
    },
    hasReachedMaxFailures(_channelId) {
      return opts.hasReachedMaxFailuresResult ?? false
    },
    scheduleRestart(channelId, cwd) {
      scheduleRestartCalls.push({ channelId, cwd })
    },
    isShuttingDown() {
      return opts.isShuttingDownResult ?? false
    },
    getRoutes() {
      return opts.routes ?? { [TEST_CHANNEL]: TEST_CWD }
    },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let stub: ClaudeDirectorStub

beforeEach(() => {
  stub = new ClaudeDirectorStub()
  stub.install()
  _resetHealthCheckState()
})

afterEach(() => {
  _resetHealthCheckState()
  stub.uninstall()
})

// ---------------------------------------------------------------------------
// isSessionAlive — state→liveness mapping
// ---------------------------------------------------------------------------

describe('isSessionAlive — state→liveness mapping', () => {
  // Live states → true
  for (const state of ['pending', 'waiting', 'working', 'ask_user', 'check_permission']) {
    test(`live state '${state}' → returns true`, async () => {
      stub.setSpawnRows([makeSpawnRow({ channelId: TEST_CHANNEL, state })])

      const result = await isSessionAlive(TEST_CHANNEL)

      expect(result).toBe(true)
      // Exactly one status call issued
      const statusCalls = stub.calls.filter(c => c.verb === 'status')
      expect(statusCalls).toHaveLength(1)
    })
  }

  // Terminal states → false
  for (const state of ['ended', 'missing']) {
    test(`terminal state '${state}' → returns false`, async () => {
      stub.setSpawnRows([makeSpawnRow({ channelId: TEST_CHANNEL, state })])

      const result = await isSessionAlive(TEST_CHANNEL)

      expect(result).toBe(false)
      const statusCalls = stub.calls.filter(c => c.verb === 'status')
      expect(statusCalls).toHaveLength(1)
    })
  }

  test('ErrSpawnNotFound → returns false, no exception', async () => {
    // No rows → stub returns ErrSpawnNotFound
    const result = await isSessionAlive(TEST_CHANNEL)

    expect(result).toBe(false)
  })

  test('non-classified status error → returns false, console.error logged', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: TEST_CHANNEL, state: 'waiting' })])
    stub.setStatusResponseQueue(`cscb_${TEST_CHANNEL}`, [
      { ok: false, error: { kind: 'ErrNonZeroExit', exitCode: 2, stderr: 'some unexpected error' } },
    ])

    const errors: unknown[][] = []
    const origError = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      const result = await isSessionAlive(TEST_CHANNEL)
      expect(result).toBe(false)
      // Should log at least once
      expect(errors.length).toBeGreaterThanOrEqual(1)
    } finally {
      console.error = origError
    }
  })

  test('isSessionAlive invokes status with --claude-instance-id cscb_<channelId>', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: TEST_CHANNEL, state: 'waiting' })])

    await isSessionAlive(TEST_CHANNEL)

    const statusCalls = stub.calls.filter(c => c.verb === 'status')
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0].argv).toContain('--claude-instance-id')
    expect(statusCalls[0].argv).toContain(`cscb_${TEST_CHANNEL}`)
  })
})

// ---------------------------------------------------------------------------
// startHealthCheck
// ---------------------------------------------------------------------------

describe('startHealthCheck', () => {
  test('1. normal dead-session detection — scheduleRestart called for dead session', async () => {
    // No rows → isSessionAlive returns false → scheduleRestart triggered
    const deps = makeDeps({ stub })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length >= 1).toBe(true)
    expect(deps.scheduleRestartCalls[0].channelId).toBe(TEST_CHANNEL)
    expect(deps.scheduleRestartCalls[0].cwd).toBe(TEST_CWD)
  })

  test('2a. skip pending — restart timer scheduled, not yet fired → scheduleRestart never called', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: TEST_CHANNEL, state: 'waiting' })])
    const deps = makeDeps({ stub, isRestartPendingResult: true })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
  })

  test('2b. skip active launch — launchSession in progress → scheduleRestart never called', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: TEST_CHANNEL, state: 'waiting' })])
    const deps = makeDeps({ stub, isActiveLaunchingResult: true })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
  })

  test('3. skip alive — isSessionAlive returns true → scheduleRestart never called', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: TEST_CHANNEL, state: 'working' })])
    const deps = makeDeps({ stub })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
  })

  test('4. skip at failure limit — hasReachedMaxFailures true → scheduleRestart never called', async () => {
    // Session is dead but hasReachedMaxFailures is true — no restart
    const deps = makeDeps({ stub, hasReachedMaxFailuresResult: true })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
  })

  test('5. transient error isolation — one route throws, other routes still restarted', async () => {
    // C_DEAD: no spawn row → returns false → scheduleRestart called
    // C_FAILING: session exists but status returns a non-classified error → isSessionAlive
    //   returns false too; but the health-check error-catch is around the whole block.
    // Actually: health-check wraps each channel in try/catch. We simulate an error
    // by having the isSessionAlive call throw for C_FAILING using a custom override.
    const FAILING_CH = 'C_FAILING'
    const DEAD_CH = 'C_DEAD'

    // Use a custom makeDeps variant that injects a throwing isSessionAlive for C_FAILING
    const scheduleRestartCalls: Array<{ channelId: string; cwd: string }> = []
    const customDeps: HealthCheckDeps & { scheduleRestartCalls: typeof scheduleRestartCalls } = {
      scheduleRestartCalls,
      async isSessionAlive(channelId) {
        if (channelId === FAILING_CH) throw new Error('simulated error for channel=' + channelId)
        return isSessionAlive(channelId)
      },
      isRestartPendingOrActive() { return false },
      hasReachedMaxFailures() { return false },
      scheduleRestart(channelId, cwd) { scheduleRestartCalls.push({ channelId, cwd }) },
      isShuttingDown() { return false },
      getRoutes() {
        return {
          [FAILING_CH]: '/cwd/failing',
          [DEAD_CH]: '/cwd/dead',
        }
      },
    }

    // C_DEAD has no row → isSessionAlive returns false
    initHealthCheck(customDeps)
    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(customDeps.scheduleRestartCalls.some(c => c.channelId === DEAD_CH)).toBe(true)
    expect(customDeps.scheduleRestartCalls.some(c => c.channelId === FAILING_CH)).toBe(false)
  })

  test('6. zero interval disables poller — isSessionAlive never called', async () => {
    const deps = makeDeps({ stub })
    initHealthCheck(deps)

    startHealthCheck(0)
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toHaveLength(0)
  })

  test('7. shutdown halts cycles — isShuttingDown true → no checks run', async () => {
    const deps = makeDeps({ stub, isShuttingDownResult: true })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toHaveLength(0)
  })

  // T26: Health check starts only after sessions.json is written.
  test('T26: initHealthCheck alone does not start poller — isSessionAlive not called until startHealthCheck is invoked', async () => {
    const deps = makeDeps({ stub })
    initHealthCheck(deps)

    // Deliberately do NOT call startHealthCheck
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toHaveLength(0)
  })

  test('T26: poller starts immediately once startHealthCheck is called after writeSessions phase', async () => {
    stub.setSpawnRows([makeSpawnRow({ channelId: TEST_CHANNEL, state: 'working' })])
    const deps = makeDeps({ stub })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls.length).toBeGreaterThan(0)
  })

  test('cadence — poller ticks at health_check_interval via fake clock', async () => {
    // Use fake timers to verify setInterval fires at exactly the configured interval.
    // The health-check runs setInterval(fn, intervalSeconds * 1000).
    // We verify that N advances of the interval each produce exactly N ticks.
    jest.useFakeTimers()
    try {
      stub.setSpawnRows([makeSpawnRow({ channelId: TEST_CHANNEL, state: 'working' })])
      const deps = makeDeps({ stub })
      initHealthCheck(deps)

      const INTERVAL_S = 5
      startHealthCheck(INTERVAL_S)

      // No ticks yet
      expect(deps.isSessionAliveCalls).toHaveLength(0)

      // Advance by 3 intervals, flush microtasks between each
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(INTERVAL_S * 1000)
        for (let j = 0; j < 10; j++) await Promise.resolve()
      }

      expect(deps.isSessionAliveCalls).toHaveLength(3)
    } finally {
      jest.useRealTimers()
    }
  })
})
