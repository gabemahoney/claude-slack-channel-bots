/**
 * health-check.test.ts — Tests for the periodic liveness poller.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  initHealthCheck,
  startHealthCheck,
  _resetHealthCheckState,
  type HealthCheckDeps,
} from '../src/health-check.ts'
import {
  _resetOutageState,
  initOutageState,
  getOutageFlags,
  setOutageFlag,
} from '../src/outage-state.ts'
import { _buildStatRouteImpl } from '../src/server.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_INTERVAL_S = 0.01  // 10 ms interval — fast enough for tests
const WAIT_MS = 50             // wait after starting; long enough for several ticks

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type DepsOpts = {
  isSessionAliveResult?: boolean     // default: false (session is dead)
  isRestartPendingResult?: boolean   // simulates: timer scheduled, not yet fired
  isActiveLaunchingResult?: boolean  // simulates: launchSession actively in progress
  statRouteResult?: boolean          // default: true (route cwd is reachable)
  statRouteHangs?: boolean           // if true, statRoute never resolves
  isShuttingDownResult?: boolean     // default: false
  routes?: Record<string, string>    // default: { C_TEST1: '/cwd/test' }
  throwOnChannel?: string            // isSessionAlive throws for this channel
}

function makeDeps(opts: DepsOpts = {}): HealthCheckDeps & {
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
      if (opts.throwOnChannel === channelId) {
        throw new Error(`simulated error for channel=${channelId}`)
      }
      return opts.isSessionAliveResult ?? false
    },
    isRestartPendingOrActive(_channelId) {
      return (opts.isRestartPendingResult ?? false) || (opts.isActiveLaunchingResult ?? false)
    },
    statRoute(_cwd) {
      if (opts.statRouteHangs) return new Promise<boolean>(() => {})
      return Promise.resolve(opts.statRouteResult ?? true)
    },
    scheduleRestart(channelId, cwd) {
      scheduleRestartCalls.push({ channelId, cwd })
    },
    isShuttingDown() {
      return opts.isShuttingDownResult ?? false
    },
    getRoutes() {
      return opts.routes ?? { C_TEST1: '/cwd/test' }
    },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetHealthCheckState()
  _resetOutageState()
  // Wire outage-state with no-op Slack emit so setOutageFlag / clearOutageFlag
  // can mutate flags without side effects in tests that don't care about Slack.
  initOutageState({
    postToChannel: () => {},
    getClient: () => null as any,
  })
})

// ---------------------------------------------------------------------------
// startHealthCheck
// ---------------------------------------------------------------------------

describe('startHealthCheck', () => {
  test('1. normal dead-session detection — scheduleRestart called for dead session', async () => {
    const deps = makeDeps()  // isSessionAlive defaults to false; statRoute defaults to true
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length >= 1).toBe(true)
    expect(deps.scheduleRestartCalls[0].channelId).toBe('C_TEST1')
    expect(deps.scheduleRestartCalls[0].cwd).toBe('/cwd/test')
  })

  test('2a. skip pending — restart timer scheduled, not yet fired → scheduleRestart never called', async () => {
    const deps = makeDeps({ isRestartPendingResult: true })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
  })

  test('2b. skip active launch — launchSession in progress → scheduleRestart never called', async () => {
    const deps = makeDeps({ isActiveLaunchingResult: true })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
  })

  test('3. skip alive — isSessionAlive returns true → scheduleRestart never called', async () => {
    const deps = makeDeps({ isSessionAliveResult: true })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
  })

  test('5. transient error isolation — one route throws, other routes still restarted', async () => {
    const deps = makeDeps({
      routes: {
        C_FAILING: '/cwd/failing',
        C_DEAD: '/cwd/dead',
      },
      throwOnChannel: 'C_FAILING',
      isSessionAliveResult: false,
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.some(c => c.channelId === 'C_DEAD')).toBe(true)
    expect(deps.scheduleRestartCalls.some(c => c.channelId === 'C_FAILING')).toBe(false)
  })

  test('6. zero interval disables poller — isSessionAlive never called', async () => {
    const deps = makeDeps()
    initHealthCheck(deps)

    startHealthCheck(0)
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toHaveLength(0)
  })

  test('7. shutdown halts cycles — isShuttingDown true → no checks run', async () => {
    const deps = makeDeps({ isShuttingDownResult: true })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toHaveLength(0)
  })

  // T26: Health check starts only after sessions.json is written.
  // Architectural invariant enforced in server.ts: startHealthCheck() is called
  // only after startupSessionManager() returns and writeSessions() completes.
  // The unit-level guarantee is that initHealthCheck() alone does NOT start the
  // poller — the poller only starts when startHealthCheck() is explicitly called.
  test('T26: initHealthCheck alone does not start poller — isSessionAlive not called until startHealthCheck is invoked', async () => {
    const deps = makeDeps({ isSessionAliveResult: false })
    initHealthCheck(deps)

    // Deliberately do NOT call startHealthCheck — simulate the window between
    // initHealthCheck (called before startup) and startHealthCheck (called after
    // writeSessions completes).
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toHaveLength(0)
  })

  test('T26: poller starts immediately once startHealthCheck is called after writeSessions phase', async () => {
    const deps = makeDeps({ isSessionAliveResult: true })
    initHealthCheck(deps)

    // Simulate the writeSessions phase completing — then start health check
    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    // Poller fired at least once after startHealthCheck was called
    expect(deps.isSessionAliveCalls.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// New cases: cwd-unreachable flag management, scheduleRestart, tick guard, timeout
// ---------------------------------------------------------------------------

describe('cwd-unreachable flag management + tick-in-flight guard', () => {
  test('(a) statRoute returns true → clearOutageFlag("cwd-unreachable") called for that channel', async () => {
    // Pre-raise the flag so clearOutageFlag has a visible effect
    setOutageFlag('C_TEST1', 'cwd-unreachable', '/cwd/test')
    expect(getOutageFlags('C_TEST1').has('cwd-unreachable')).toBe(true)

    const deps = makeDeps({ statRouteResult: true, isSessionAliveResult: true })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(getOutageFlags('C_TEST1').has('cwd-unreachable')).toBe(false)
  })

  test('(b) statRoute returns false → setOutageFlag("cwd-unreachable", cwd) called for that channel', async () => {
    expect(getOutageFlags('C_TEST1').has('cwd-unreachable')).toBe(false)

    // isSessionAliveResult: true so scheduleRestart is NOT called — isolates statRoute effect
    const deps = makeDeps({ statRouteResult: false, isSessionAliveResult: true })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(getOutageFlags('C_TEST1').has('cwd-unreachable')).toBe(true)
  })

  test('(c) scheduleRestart is called when isSessionAlive returns false', async () => {
    const deps = makeDeps({ statRouteResult: true, isSessionAliveResult: false })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].channelId).toBe('C_TEST1')
    expect(deps.scheduleRestartCalls[0].cwd).toBe('/cwd/test')
  })

  test('(d) tick-in-flight guard: 5th consecutive skip emits exactly one warning', async () => {
    // statRoute never resolves — first tick body hangs forever, all subsequent
    // interval firings hit the tickInFlight guard and increment skippedTicks.
    const deps = makeDeps({ statRouteHangs: true })
    initHealthCheck(deps)

    const capturedErrors: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map(a => String(a)).join(' '))
    }

    try {
      startHealthCheck(FAST_INTERVAL_S)  // 10 ms interval
      // Need 6+ firings: 1 starts the hung body, then 5 are skips.
      // At 10 ms/tick, 200 ms → ~20 firings → 1 body + 19 skips.
      await Bun.sleep(200)
    } finally {
      console.error = origError
    }

    const warnings = capturedErrors.filter(e =>
      e.includes('tick body in flight; skipped 5 consecutive ticks'),
    )
    // Warning fires exactly once at the 4→5 skip boundary; further skips are silent.
    expect(warnings).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // (e) default-impl 5 s timeout — exercises the REAL _buildStatRouteImpl
  // factory from src/server.ts via its dep-injection seam (stat / setTimeout /
  // clearTimeout). Bun 1.x useFakeTimers only fakes Date/Date.now, not
  // setTimeout, so we inject a controlled setTimeout/clearTimeout pair directly.
  // ---------------------------------------------------------------------------
  test('(e) default-impl 5s timeout: hung stat resolves false after 5s budget', async () => {
    // Capture the timeout callback so we can fire it manually.
    let capturedCallback: (() => void) | undefined
    let capturedDelay: number | undefined

    const fakeSetTimeout = (fn: () => void, ms: number) => {
      capturedCallback = fn
      capturedDelay = ms
      return 0 as unknown as ReturnType<typeof setTimeout>
    }
    const fakeClearTimeout = (_h: ReturnType<typeof setTimeout> | undefined) => {}

    // stat that never resolves — simulates a hung NFS / unreachable mount
    const hangingStat = (): Promise<{ isDirectory(): boolean }> =>
      new Promise(() => {})

    const statRoute = _buildStatRouteImpl({
      stat: hangingStat,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    })

    const resultPromise = statRoute('/some/cwd')

    // Verify the timeout was registered with the correct budget
    expect(capturedDelay).toBe(5_000)
    expect(capturedCallback).toBeDefined()

    // Fire the timeout — simulates 5 s elapsing
    capturedCallback!()

    const result = await resultPromise
    expect(result).toBe(false)
  })
})
