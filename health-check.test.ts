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
} from './health-check.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_INTERVAL_S = 0.01  // 10 ms interval — fast enough for tests
const WAIT_MS = 50             // wait after starting; long enough for several ticks

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type DepsOpts = {
  isSessionAliveResult?: boolean           // default: false (session is dead)
  isRestartPendingResult?: boolean         // simulates: timer scheduled, not yet fired
  isActiveLaunchingResult?: boolean        // simulates: launchSession actively in progress
  hasReachedMaxFailuresResult?: boolean    // default: false
  isShuttingDownResult?: boolean           // default: false
  routes?: Record<string, string>          // default: { C_TEST1: '/cwd/test' }
  throwOnChannel?: string                  // isSessionAlive throws for this channel
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
      return opts.routes ?? { C_TEST1: '/cwd/test' }
    },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetHealthCheckState()
})

// ---------------------------------------------------------------------------
// startHealthCheck
// ---------------------------------------------------------------------------

describe('startHealthCheck', () => {
  test('1. normal dead-session detection — scheduleRestart called for dead session', async () => {
    const deps = makeDeps()  // isSessionAlive defaults to false
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

  test('4. skip at failure limit — hasReachedMaxFailures true → scheduleRestart never called', async () => {
    const deps = makeDeps({ hasReachedMaxFailuresResult: true })
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
})
