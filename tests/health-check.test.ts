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
  // b.9a7: per-call scripted skip flags. Each is a queue consumed
  // one-per-isRestartPendingOrActive / isAtCap call across ticks, with the last
  // value repeating once exhausted. Lets a test open a skip window for a bounded
  // number of ticks (e.g. [false, true, false, false]) and assert the streak was
  // cleared by the skip. When set, these take precedence over the static
  // isRestartPendingResult / isActiveLaunchingResult / isAtCapResult knobs.
  pendingSequence?: boolean[]
  atCapSequence?: boolean[]
  isSessionConnectedResult?: boolean // default: true (MCP connected); false → alive-but-disconnected (b.9a7)
  // b.9a7: per-channel scripted connectedness. Each entry is a queue of results
  // consumed one-per-isSessionConnected-call, so a test can drive an exact
  // sequence of observations across ticks (e.g. [false, true, false]) without
  // depending on how many times the free-running timer fired. When the queue
  // for a channel is exhausted, the LAST scripted value repeats.
  connectedSequence?: Record<string, boolean[]>
  statRouteResult?: boolean          // default: true (route cwd is reachable)
  statRouteHangs?: boolean           // if true, statRoute never resolves
  isShuttingDownResult?: boolean     // default: false
  routes?: Record<string, string>    // default: { C_TEST1: '/cwd/test' }
  throwOnChannel?: string            // isSessionAlive throws for this channel
}

function makeDeps(opts: DepsOpts = {}): HealthCheckDeps & {
  scheduleRestartCalls: Array<{ channelId: string; cwd: string }>
  isSessionAliveCalls: string[]
  isSessionConnectedCalls: string[]
  // For each scheduleRestart fire, how many times isSessionConnected had been
  // called for that channel at fire time. Lets a test assert a reconnect was
  // scheduled on the Nth disconnected observation (streak semantics).
  scheduleRestartAtConnectedCount: number[]
} {
  const scheduleRestartCalls: Array<{ channelId: string; cwd: string }> = []
  const isSessionAliveCalls: string[] = []
  const isSessionConnectedCalls: string[] = []
  const scheduleRestartAtConnectedCount: number[] = []
  const connectedCallCount = new Map<string, number>()
  let pendingCallCount = 0
  let atCapCallCount = 0

  return {
    scheduleRestartCalls,
    isSessionAliveCalls,
    isSessionConnectedCalls,
    scheduleRestartAtConnectedCount,

    async isSessionAlive(channelId) {
      isSessionAliveCalls.push(channelId)
      if (opts.throwOnChannel === channelId) {
        throw new Error(`simulated error for channel=${channelId}`)
      }
      return opts.isSessionAliveResult ?? false
    },
    isSessionConnected(channelId) {
      isSessionConnectedCalls.push(channelId)
      const n = (connectedCallCount.get(channelId) ?? 0) + 1
      connectedCallCount.set(channelId, n)
      const seq = opts.connectedSequence?.[channelId]
      if (seq && seq.length > 0) {
        // Consume one per call; repeat the last value once exhausted.
        return seq[Math.min(n - 1, seq.length - 1)]
      }
      return opts.isSessionConnectedResult ?? true
    },
    isRestartPendingOrActive(_channelId) {
      const seq = opts.pendingSequence
      if (seq && seq.length > 0) {
        const n = pendingCallCount++
        return seq[Math.min(n, seq.length - 1)]
      }
      return (opts.isRestartPendingResult ?? false) || (opts.isActiveLaunchingResult ?? false)
    },
    isAtCap(_channelId) {
      const seq = opts.atCapSequence
      if (seq && seq.length > 0) {
        const n = atCapCallCount++
        return seq[Math.min(n, seq.length - 1)]
      }
      return opts.isAtCapResult ?? false
    },
    statRoute(_cwd) {
      if (opts.statRouteHangs) return new Promise<boolean>(() => {})
      return Promise.resolve(opts.statRouteResult ?? true)
    },
    scheduleRestart(channelId, cwd) {
      scheduleRestartCalls.push({ channelId, cwd })
      scheduleRestartAtConnectedCount.push(connectedCallCount.get(channelId) ?? 0)
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
      isSessionConnected(_channelId) {
        return true
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

// ---------------------------------------------------------------------------
// b.9a7 — alive-but-disconnected tick recovery
//
// Before b.9a7 the tick did `if (!alive) scheduleRestart(...)`, so a channel in
// an AD live state (e.g. `waiting`) whose MCP session was disconnected
// (isSessionAlive === true, isSessionConnected === false) was NEVER scheduled
// for recovery by any periodic mechanism — the gap was unbounded. The fix routes
// alive-but-disconnected rows through scheduleRestart, but only after TWO
// consecutive disconnected observations (design decision 2: the freshly-launched
// window). These tests assert that debounce, its resets, and its interactions
// with the dead-session and cap paths.
// ---------------------------------------------------------------------------

describe('b.9a7 alive-but-disconnected tick recovery', () => {
  test('1/5. REGRESSION: alive but !connected → scheduleRestart fires on the 2nd consecutive tick, not the 1st', async () => {
    // Core fails-before/passes-after test. With the pre-b.9a7 condition
    // (`if (!alive) scheduleRestart`), alive===true short-circuits and
    // scheduleRestart is NEVER called for this channel. Post-fix it is called —
    // and specifically on the SECOND disconnected observation (the debounce
    // covers the freshly-launched, not-yet-connected window, AC 6).
    const deps = makeDeps({ isSessionAliveResult: true, isSessionConnectedResult: false })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    // A stranded alive-but-disconnected channel IS scheduled within a bounded
    // number of ticks — no inbound message, no server restart (AC 2/5).
    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].channelId).toBe('C_TEST1')
    expect(deps.scheduleRestartCalls[0].cwd).toBe('/cwd/test')
    // The FIRST fire happened on the 2nd disconnected observation, never the 1st
    // (AC 6 debounce). connected-call-count at first fire === 2.
    expect(deps.scheduleRestartAtConnectedCount[0]).toBe(2)
  })

  test('2. streak reset: disconnected → connected → later blip does NOT schedule', async () => {
    // Sequence per isSessionConnected call: false (streak→1), true (reset to 0),
    // false (streak→1 again), then true (connected) forever once the queue is
    // exhausted. The lone post-reset blip is a FRESH streak of 1 — it never
    // reaches 2 consecutive disconnected observations because the trailing `true`
    // resets it again. This asserts the reset actually wipes the streak: without
    // the `disconnectedStreak.delete` on the connected branch, the leading false
    // would carry forward and the post-reset false would fire on the 2nd call.
    const deps = makeDeps({
      isSessionAliveResult: true,
      connectedSequence: { C_TEST1: [false, true, false, true] },
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    // No two CONSECUTIVE disconnected observations ever occurred.
    expect(deps.scheduleRestartCalls).toHaveLength(0)
    // Anti-vacuity: prove the ticks actually ran through the scripted sequence
    // (the post-reset fresh blip was genuinely observed, not skipped).
    expect(deps.isSessionConnectedCalls.length).toBeGreaterThanOrEqual(4)
  })

  test('3. streak dropped on fire: after scheduling on tick 2, streak resets (next fire needs 2 more)', async () => {
    // Persistently disconnected. Since the scheduleRestart stub does NOT set
    // isRestartPendingOrActive, ticks keep running. The streak is consumed on
    // fire, so fires land on the 2nd, 4th, 6th... disconnected observation —
    // never on consecutive observations. This exercises the `disconnectedStreak
    // .delete` on the schedule branch.
    const deps = makeDeps({ isSessionAliveResult: true, isSessionConnectedResult: false })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    // Every fire is at an even connected-call-count (2, 4, 6...): the streak was
    // dropped after each fire and had to re-accumulate two observations.
    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    for (const n of deps.scheduleRestartAtConnectedCount) {
      expect(n % 2).toBe(0)
    }
  })

  test('4. no racing reconnect: restart pending/active suppresses tick-driven scheduling', async () => {
    // AC 4: while a restart is pending or a launch is active, the tick skips the
    // channel entirely — even when alive && !connected. This is the existing
    // isRestartPendingOrActive skip; it must cover the new reconnect path too.
    const deps = makeDeps({
      isSessionAliveResult: true,
      isSessionConnectedResult: false,
      isRestartPendingResult: true,
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
    // The skip fires before the connectedness probe.
    expect(deps.isSessionConnectedCalls).toHaveLength(0)
  })

  test('4b. active launch (freshly-launched window) suppresses tick-driven scheduling', async () => {
    // AC 6: a launch in progress is the freshly-launched window; the tick must
    // not poke it. isActiveLaunchingResult drives isRestartPendingOrActive true.
    const deps = makeDeps({
      isSessionAliveResult: true,
      isSessionConnectedResult: false,
      isActiveLaunchingResult: true,
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
    expect(deps.isSessionConnectedCalls).toHaveLength(0)
  })

  test('4c. dead session still schedules immediately on the FIRST tick (no debounce regression)', async () => {
    // The two-tick debounce applies ONLY to the alive-but-disconnected path. A
    // dead session (isSessionAlive false) must still schedule on the first tick,
    // as before b.9a7. isSessionConnected is irrelevant on the dead path — the
    // fire happens with connected-call-count 0 (never probed).
    const deps = makeDeps({ isSessionAliveResult: false, isSessionConnectedResult: false })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].channelId).toBe('C_TEST1')
    // Dead path does not consult isSessionConnected: count stays 0 at fire.
    expect(deps.scheduleRestartAtConnectedCount[0]).toBe(0)
    expect(deps.isSessionConnectedCalls).toHaveLength(0)
  })

  test('7. capped channel fully skipped including reconnects (alive && !connected on consecutive ticks)', async () => {
    // AC 7 / design decision 1: a capped channel gets NO tick-driven reconnect,
    // even when alive && !connected across many ticks. The isAtCap skip precedes
    // the connectedness probe.
    const deps = makeDeps({
      isAtCapResult: true,
      isSessionAliveResult: true,
      isSessionConnectedResult: false,
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
    // Skip fires before both probes.
    expect(deps.isSessionAliveCalls).toHaveLength(0)
    expect(deps.isSessionConnectedCalls).toHaveLength(0)
  })

  test('9. isolation: _resetHealthCheckState clears the disconnected streak (no leak across tests)', async () => {
    // Accumulate a streak of 1 (one disconnected observation, no fire yet), then
    // reset. A fresh deps must start from streak 0 — so a single disconnected
    // observation after reset does NOT immediately fire (it would if the old
    // streak leaked as 1).
    const deps1 = makeDeps({
      isSessionAliveResult: true,
      // exactly one disconnected observation then connected — leaves streak at 1
      connectedSequence: { C_TEST1: [false, true] },
    })
    initHealthCheck(deps1)
    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)
    expect(deps1.scheduleRestartCalls).toHaveLength(0)
    // Anti-vacuity: the phase-1 run must actually have observed the channel at
    // least once (accumulating the streak of 1) — otherwise the reset below
    // would be clearing nothing and the test would pass vacuously.
    expect(deps1.isSessionConnectedCalls.length).toBeGreaterThanOrEqual(1)

    _resetHealthCheckState()

    // Fresh run: one disconnected observation then connected. If the streak had
    // leaked (still 1), this single false would reach 2 and fire. It must not.
    const deps2 = makeDeps({
      isSessionAliveResult: true,
      connectedSequence: { C_TEST1: [false, true] },
    })
    initHealthCheck(deps2)
    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps2.scheduleRestartCalls).toHaveLength(0)
  })

  test('10. streak cleared on pending-skip: a pre-skip disconnected tick does NOT carry across a restart cycle', async () => {
    // b.9a7 round-2 fix: "consecutive" means consecutive *observed* ticks, not
    // observations separated by a whole restart cycle. Timeline (per tick):
    //   tick1: pending=false → alive && !connected → streak=1 (connected call 1)
    //   tick2: pending=true  → SKIP (streak must be cleared; no connected probe)
    //   tick3: pending=false → alive && !connected → FRESH streak=1 (call 2)
    //   tick4: pending=false → alive && !connected → streak=2 → FIRE (call 3)
    // The fire lands at cumulative connected-call-count 3. Without the
    // clear-on-pending-skip fix the pre-skip streak of 1 would survive the skip,
    // so the very first post-skip disconnected tick (call 2) would reach 2 and
    // fire at connected-call-count 2. Asserting 3 pins the fix.
    const deps = makeDeps({
      isSessionAliveResult: true,
      isSessionConnectedResult: false,
      pendingSequence: [false, true, false, false],  // last (false) repeats
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].channelId).toBe('C_TEST1')
    // Fire required TWO fresh post-skip observations — the pre-skip streak did
    // not carry across the restart cycle.
    expect(deps.scheduleRestartAtConnectedCount[0]).toBe(3)
  })

  test('11. streak cleared on cap-skip: a pre-cap disconnected tick does NOT carry across the cap window', async () => {
    // Analogous to test 10 for the isAtCap skip. The cap skip also clears the
    // streak, so a fresh uncapped observation starts a new consecutive count.
    //   tick1: cap=false → !connected → streak=1 (connected call 1)
    //   tick2: cap=true  → SKIP (streak cleared; no connected probe)
    //   tick3: cap=false → !connected → fresh streak=1 (call 2)
    //   tick4: cap=false → !connected → streak=2 → FIRE (call 3)
    const deps = makeDeps({
      isSessionAliveResult: true,
      isSessionConnectedResult: false,
      atCapSequence: [false, true, false, false],  // last (false) repeats
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].channelId).toBe('C_TEST1')
    // Two fresh post-cap observations were required — the pre-cap streak of 1
    // was cleared by the cap skip rather than carried across.
    expect(deps.scheduleRestartAtConnectedCount[0]).toBe(3)
  })
})
