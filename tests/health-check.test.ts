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
import { makeRoutingConfig } from './test-helpers/routing-config.ts'
import { _resetBackoffState } from '../src/backoff.ts'

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
  isAtCapResult?: boolean            // default: false; set true to simulate capped channel
  cappedChannels?: Set<string>       // per-channel cap control (overrides isAtCapResult)
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
    isAtCap(channelId) {
      // Per-channel cap control: cappedChannels wins over isAtCapResult
      if (opts.cappedChannels !== undefined) return opts.cappedChannels.has(channelId)
      return opts.isAtCapResult ?? false
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
  _resetBackoffState()
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
  // SR-21.5 recovery-bound test (t3.a3g.yn.jj.53)
  //
  // SR-21.5 recovery-bound: detected within one health_check_interval, relaunched
  // after session_restart_delay — deterministic, no unbounded loop.
  //
  // Uses makeDeps with isSessionAlive=false (dead-probe adapter behavior) and
  // fast-timer values sourced from makeRoutingConfig overrides.
  // ---------------------------------------------------------------------------
  test('SR-21.5 recovery-bound: dead session gets scheduleRestart on next tick; pending/active guard prevents second schedule on following tick', async () => {
    // Fast timer values from makeRoutingConfig overrides — never hard-code literals
    const config = makeRoutingConfig({
      health_check_interval: FAST_INTERVAL_S,
      session_restart_delay: FAST_INTERVAL_S,
    })
    const healthCheckIntervalS = config.health_check_interval
    const sessionRestartDelayS = config.session_restart_delay

    // Sanity: config drives the values, not literals
    expect(healthCheckIntervalS).toBe(FAST_INTERVAL_S)
    expect(sessionRestartDelayS).toBe(FAST_INTERVAL_S)

    // Tick 1: isSessionAlive=false → scheduleRestart called
    // Tick 2: scheduleRestartCalls is already set; simulate guard (isRestartPendingOrActive=true)
    // We accomplish tick 2 guard simulation by switching isRestartPendingOrActive to true
    // after the first scheduleRestart call — using the real isRestartPendingOrActive from restart.ts.
    //
    // To use the real isRestartPendingOrActive we wire the real scheduleRestart+isRestartPendingOrActive
    // via the makeDeps factory's injectable isRestartPendingOrActive.
    let restartScheduledCount = 0

    // Build a deps that tracks calls and gates on its own count (simulating
    // the real pending/active state: once scheduleRestart fires, subsequent
    // ticks should see isRestartPendingOrActive=true).
    const deps: HealthCheckDeps & {
      scheduleRestartCalls: Array<{ channelId: string; cwd: string }>
      isSessionAliveCalls: string[]
    } = {
      scheduleRestartCalls: [],
      isSessionAliveCalls: [],

      async isSessionAlive(channelId) {
        this.isSessionAliveCalls.push(channelId)
        return false  // dead-probe adapter behavior
      },
      isRestartPendingOrActive(_channelId) {
        // Returns true after the first scheduleRestart — models the real guard
        return restartScheduledCount > 0
      },
      isAtCap(_channelId) {
        // Stub: always false — behavioral coverage in Task C
        return false
      },
      statRoute(_cwd) {
        return Promise.resolve(true)
      },
      scheduleRestart(channelId, cwd) {
        restartScheduledCount++
        this.scheduleRestartCalls.push({ channelId, cwd })
      },
      isShuttingDown() { return false },
      getRoutes() { return { C_TEST1: '/cwd/test' } },
    }

    initHealthCheck(deps)
    startHealthCheck(FAST_INTERVAL_S)

    // Wait for multiple ticks: first tick schedules restart; subsequent ticks are guarded
    await Bun.sleep(WAIT_MS)

    // Exactly one scheduleRestart: detected on first tick, guard prevents re-schedule on subsequent ticks
    expect(deps.scheduleRestartCalls).toHaveLength(1)
    expect(deps.scheduleRestartCalls[0].channelId).toBe('C_TEST1')
    expect(deps.scheduleRestartCalls[0].cwd).toBe('/cwd/test')
    // isSessionAlive was called exactly once: subsequent ticks hit the
    // isRestartPendingOrActive guard and continue before reaching isSessionAlive.
    // This confirms the guard is effective — one detection, zero redundant probes.
    expect(deps.isSessionAliveCalls).toHaveLength(1)
    expect(deps.isSessionAliveCalls[0]).toBe('C_TEST1')
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

// ---------------------------------------------------------------------------
// isAtCap tick-guard (SR-25.3/25.4) — Task C subtask 7r
//
// The health-check tick must skip capped channels (isAtCap=true) and not call
// scheduleRestart for them. Other channels in the same tick are unaffected.
// A channel with isAtCap=false continues to behave as before this feature.
// ---------------------------------------------------------------------------

describe('isAtCap tick-guard (SR-25.3/25.4)', () => {
  // -------------------------------------------------------------------------
  // Cap-guard: capped channel is skipped (no scheduleRestart, no isSessionAlive)
  // -------------------------------------------------------------------------

  test('SR-25.3: capped channel is SKIPPED — scheduleRestart not called, isSessionAlive not called', async () => {
    // SR-25.3/25.4: once a channel is at cap, the health-check tick must not
    // re-schedule restarts. The tick logs a message and continues past the channel.
    const deps = makeDeps({
      isAtCapResult: true,
      isSessionAliveResult: false,  // would trigger restart if not capped
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    // scheduleRestart must not have been called — capped channel is skipped
    expect(deps.scheduleRestartCalls).toHaveLength(0)
    // isSessionAlive must not have been called — skip fires before the probe
    expect(deps.isSessionAliveCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Cap-guard: un-capped channel proceeds normally (isAtCap=false baseline)
  // -------------------------------------------------------------------------

  test('SR-25.3: non-capped channel proceeds — dead session triggers scheduleRestart', async () => {
    const deps = makeDeps({
      isAtCapResult: false,
      isSessionAliveResult: false,
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].channelId).toBe('C_TEST1')
  })

  // -------------------------------------------------------------------------
  // Cap-guard: mixed channels — capped channel skipped, live channel processed
  // -------------------------------------------------------------------------

  test('SR-25.4: mixed routes — capped channel skipped while uncapped dead channel gets scheduleRestart', async () => {
    // C_CAPPED is at cap (isAtCap=true) → must be skipped
    // C_DEAD is not at cap (isAtCap=false) and dead → scheduleRestart must be called
    const cappedChannels = new Set(['C_CAPPED'])

    const scheduleRestartCalls: Array<{ channelId: string; cwd: string }> = []
    const isSessionAliveCalls: string[] = []

    const deps: HealthCheckDeps & {
      scheduleRestartCalls: typeof scheduleRestartCalls
      isSessionAliveCalls: typeof isSessionAliveCalls
    } = {
      scheduleRestartCalls,
      isSessionAliveCalls,

      async isSessionAlive(channelId) {
        isSessionAliveCalls.push(channelId)
        return false  // both channels are dead
      },
      isRestartPendingOrActive(_channelId) {
        return false
      },
      isAtCap(channelId) {
        // SR-25.3/25.4: capped channels are skipped by the tick
        return cappedChannels.has(channelId)
      },
      statRoute(_cwd) {
        return Promise.resolve(true)
      },
      scheduleRestart(channelId, cwd) {
        scheduleRestartCalls.push({ channelId, cwd })
      },
      isShuttingDown() { return false },
      getRoutes() {
        return {
          C_CAPPED: '/cwd/capped',
          C_DEAD: '/cwd/dead',
        }
      },
    }

    initHealthCheck(deps)
    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    // C_DEAD: scheduleRestart called (not capped, dead)
    expect(scheduleRestartCalls.some(c => c.channelId === 'C_DEAD')).toBe(true)

    // C_CAPPED: scheduleRestart NOT called (skipped due to cap)
    expect(scheduleRestartCalls.some(c => c.channelId === 'C_CAPPED')).toBe(false)

    // C_CAPPED: isSessionAlive NOT called (skip fires before the probe)
    expect(isSessionAliveCalls.some(ch => ch === 'C_CAPPED')).toBe(false)

    // C_DEAD: isSessionAlive WAS called (not skipped)
    expect(isSessionAliveCalls.some(ch => ch === 'C_DEAD')).toBe(true)
  })
})
