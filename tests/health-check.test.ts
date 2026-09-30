/**
 * health-check.test.ts — Tests for the periodic liveness poller.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { stat as fsStat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initHealthCheck,
  startHealthCheck,
  _resetHealthCheckState,
  buildPersonaWorkList,
  forgetDisconnectedStreak,
  stopHealthCheck,
  type HealthCheckDeps,
} from '../src/health-check.ts'
import {
  _resetOutageState,
  initOutageState,
  getOutageFlags,
  setOutageFlag,
  ONSET_TEMPLATES,
  ALL_CLEAR_TEMPLATE,
} from '../src/outage-state.ts'
import { _buildStatRouteImpl } from '../src/server.ts'
import { _resetBackoffState } from '../src/backoff.ts'
import { makeMultiPersonaConfig, makePersonaConfig } from './test-helpers/persona-config.ts'
import type { Persona } from '../src/config.ts'
import type { PersonaConnectionManager } from '../src/persona-connections.ts'
import { checkPersonaConfigDir } from '../src/persona-bringup.ts'
import {
  _resetNotConnectedEpisodes,
  forgetNotConnectedEpisode,
  notifyDisconnectedWithAutoRestartDisabled,
  notifyPersonaNotConnected,
  setSessionNotifier,
} from '../src/session-manager.ts'
import { createPersonaRelaunchGate } from '../src/persona-start.ts'
import {
  LIVENESS_READING_DEAD,
  LIVENESS_READING_LIVE,
  LIVENESS_READING_PENDING,
  LIVENESS_READING_UNKNOWN,
  pendingLivenessReading,
  type LivenessReading,
} from '../src/liveness-reading.ts'
import {
  createPersonaBringUpController,
  type PersonaBringUpController,
} from '../src/persona-bringup-controller.ts'
import {
  makeConnectionHarness,
  type ConnectionHarness,
  type ConnectionHarnessOptions,
} from './test-helpers/persona-connection-harness.ts'
import {
  APP_TOKEN_PREFIX,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
import { SAMPLE_LAUNCH_START_WHOLE } from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_INTERVAL_S = 0.01  // 10 ms interval — fast enough for tests
const WAIT_MS = 50             // wait after starting; long enough for several ticks

// ---------------------------------------------------------------------------
// Persona fixtures (b.av2 SR-6.3): the tick's work list is persona key →
// working directory. `KEY` / `WD` are the default persona's key and working
// directory, from `makePersonaConfig` under this file's own temp directory.
// ---------------------------------------------------------------------------

let baseDir: string
let KEY: string
let WD: string

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'health-check-test-'))
  const persona = makePersonaConfig({}, baseDir).personas[0]
  KEY = persona.key
  WD = persona.working_directory
})

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

/** Work list for one single-channel persona per name, built as production builds it. */
function workList(...names: string[]): Record<string, string> {
  return buildPersonaWorkList(makeMultiPersonaConfig(names.map((name) => ({ name })), baseDir))
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type DepsOpts = {
  isSessionAliveResult?: LivenessReading  // default: LIVENESS_READING_DEAD (b.jg5 SRJ-314)
  // b.jg5 SRJ-314: per-persona scripted liveness answers, consumed
  // one-per-isSessionAlive call like connectedSequence (the last repeats once
  // exhausted). An `Error` entry is thrown instead of answered. Takes
  // precedence over isSessionAliveResult and throwOnKey for that persona.
  aliveSequence?: Record<string, Array<LivenessReading | Error>>
  isRestartPendingResult?: boolean   // simulates: timer scheduled, not yet fired
  isActiveLaunchingResult?: boolean  // simulates: launchSession actively in progress
  isAtCapResult?: boolean            // default: false; set true to simulate a capped persona
  // b.9a7: per-call scripted skip flags. Each is a queue consumed
  // one-per-isRestartPendingOrActive / isAtCap call across ticks, with the last
  // value repeating once exhausted. Lets a test open a skip window for a bounded
  // number of ticks (e.g. [false, true, false, false]) and assert the streak was
  // cleared by the skip. When set, these take precedence over the static
  // isRestartPendingResult / isActiveLaunchingResult / isAtCapResult knobs.
  pendingSequence?: boolean[]
  atCapSequence?: boolean[]
  isSessionConnectedResult?: boolean // default: true (MCP connected); false → alive-but-disconnected (b.9a7)
  // b.9a7: per-persona scripted connectedness. Each entry is a queue of results
  // consumed one-per-isSessionConnected-call, so a test can drive an exact
  // sequence of observations across ticks (e.g. [false, true, false]) without
  // depending on how many times the free-running timer fired. When the queue
  // for a persona is exhausted, the LAST scripted value repeats.
  connectedSequence?: Record<string, boolean[]>
  hasSessionStreamResult?: boolean   // default: true (stream present — prior semantics; b.9cj)
  // b.9cj: per-persona scripted stream-presence, consumed one-per-hasSessionStream
  // call like connectedSequence. When the queue is exhausted the LAST value repeats.
  streamSequence?: Record<string, boolean[]>
  statRouteResult?: boolean          // default: true (working directory is reachable)
  statRouteHangs?: boolean           // if true, statRoute never resolves
  isShuttingDownResult?: boolean     // default: false
  personas?: Record<string, string>  // work list; default: { [KEY]: WD }
  // Per-tick work lists, consumed one per tick (getPersonas call); the last
  // repeats once exhausted. Takes precedence over `personas`. Lets a test drop
  // a persona out of the work list for a bounded number of ticks, as the
  // relaunch gate does for a persona that is not up.
  personasSequence?: Array<Record<string, string>>
  throwOnKey?: string               // isSessionAlive throws for this persona key
  maxTicks?: number                  // stop after this many tick bodies (isShuttingDown turns true)
}

function makeDeps(opts: DepsOpts = {}): HealthCheckDeps & {
  scheduleRestartCalls: Array<{ key: string; cwd: string }>
  isSessionAliveCalls: string[]
  isSessionConnectedCalls: string[]
  hasSessionStreamCalls: string[]
  statRouteCalls: string[]
  /** Number of tick bodies run so far (getPersonas calls). */
  tickCount(): number
  // For each scheduleRestart fire, how many times isSessionConnected had been
  // called for that persona at fire time. Lets a test assert a reconnect was
  // scheduled on the Nth disconnected observation (streak semantics).
  scheduleRestartAtConnectedCount: number[]
  // b.9cj: same idea keyed on hasSessionStream call count — lets a streamless
  // test assert the fire landed on the Nth stream observation (streak debounce).
  scheduleRestartAtStreamCount: number[]
} {
  const scheduleRestartCalls: Array<{ key: string; cwd: string }> = []
  const isSessionAliveCalls: string[] = []
  const isSessionConnectedCalls: string[] = []
  const hasSessionStreamCalls: string[] = []
  const statRouteCalls: string[] = []
  const scheduleRestartAtConnectedCount: number[] = []
  const scheduleRestartAtStreamCount: number[] = []
  const connectedCallCount = new Map<string, number>()
  const streamCallCount = new Map<string, number>()
  const aliveCallCount = new Map<string, number>()
  let pendingCallCount = 0
  let atCapCallCount = 0
  let ticks = 0

  return {
    scheduleRestartCalls,
    isSessionAliveCalls,
    isSessionConnectedCalls,
    hasSessionStreamCalls,
    statRouteCalls,
    tickCount: () => ticks,
    scheduleRestartAtConnectedCount,
    scheduleRestartAtStreamCount,

    async isSessionAlive(key) {
      isSessionAliveCalls.push(key)
      const n = (aliveCallCount.get(key) ?? 0) + 1
      aliveCallCount.set(key, n)
      const seq = opts.aliveSequence?.[key]
      if (seq && seq.length > 0) {
        const answer = seq[Math.min(n - 1, seq.length - 1)]!
        if (answer instanceof Error) throw answer
        return answer
      }
      if (opts.throwOnKey === key) {
        throw new Error(`simulated error for persona=${key}`)
      }
      return opts.isSessionAliveResult ?? LIVENESS_READING_DEAD
    },
    isSessionConnected(key) {
      isSessionConnectedCalls.push(key)
      const n = (connectedCallCount.get(key) ?? 0) + 1
      connectedCallCount.set(key, n)
      const seq = opts.connectedSequence?.[key]
      if (seq && seq.length > 0) {
        // Consume one per call; repeat the last value once exhausted.
        return seq[Math.min(n - 1, seq.length - 1)]
      }
      return opts.isSessionConnectedResult ?? true
    },
    hasSessionStream(key) {
      hasSessionStreamCalls.push(key)
      const n = (streamCallCount.get(key) ?? 0) + 1
      streamCallCount.set(key, n)
      const seq = opts.streamSequence?.[key]
      if (seq && seq.length > 0) {
        return seq[Math.min(n - 1, seq.length - 1)]
      }
      return opts.hasSessionStreamResult ?? true
    },
    isRestartPendingOrActive(_key) {
      const seq = opts.pendingSequence
      if (seq && seq.length > 0) {
        const n = pendingCallCount++
        return seq[Math.min(n, seq.length - 1)]
      }
      return (opts.isRestartPendingResult ?? false) || (opts.isActiveLaunchingResult ?? false)
    },
    isAtCap(_key) {
      const seq = opts.atCapSequence
      if (seq && seq.length > 0) {
        const n = atCapCallCount++
        return seq[Math.min(n, seq.length - 1)]
      }
      return opts.isAtCapResult ?? false
    },
    statRoute(cwd) {
      statRouteCalls.push(cwd)
      if (opts.statRouteHangs) return new Promise<boolean>(() => {})
      return Promise.resolve(opts.statRouteResult ?? true)
    },
    scheduleRestart(key, cwd) {
      scheduleRestartCalls.push({ key, cwd })
      scheduleRestartAtConnectedCount.push(connectedCallCount.get(key) ?? 0)
      scheduleRestartAtStreamCount.push(streamCallCount.get(key) ?? 0)
    },
    isShuttingDown() {
      if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) return true
      return opts.isShuttingDownResult ?? false
    },
    getPersonas() {
      ticks++
      const seq = opts.personasSequence
      if (seq && seq.length > 0) return seq[Math.min(ticks - 1, seq.length - 1)]
      return opts.personas ?? { [KEY]: WD }
    },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** Outage notices raised during the current test, in order. */
let notices: Array<{ key: string; text: string }>

beforeEach(() => {
  _resetHealthCheckState()
  _resetOutageState()
  _resetBackoffState()
  // Wire outage-state with a capturing notice hook so setOutageFlag /
  // clearOutageFlag mutate flags without Slack, and the cwd-unreachable cases
  // can check which persona each notice was raised for.
  notices = []
  initOutageState({
    notify: (key, text) => { notices.push({ key, text }) },
    getClient: () => null as any,
  })
})

// ---------------------------------------------------------------------------
// startHealthCheck
// ---------------------------------------------------------------------------

describe('startHealthCheck', () => {
  test('1. normal dead-session detection — scheduleRestart called for dead session', async () => {
    const deps = makeDeps()  // isSessionAlive reads dead by default; statRoute defaults to true
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length >= 1).toBe(true)
    expect(deps.scheduleRestartCalls[0].key).toBe(KEY)
    expect(deps.scheduleRestartCalls[0].cwd).toBe(WD)
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

  test('3. skip alive — isSessionAlive reads live → scheduleRestart never called', async () => {
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
  })

  test('5. transient error isolation — one persona throws, other personas still restarted', async () => {
    const deps = makeDeps({
      personas: workList('failing_bot', 'dead_bot'),
      throwOnKey: 'failing_bot',
      isSessionAliveResult: LIVENESS_READING_DEAD,
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.some(c => c.key === 'dead_bot')).toBe(true)
    expect(deps.scheduleRestartCalls.some(c => c.key === 'failing_bot')).toBe(false)
  })

  // AC 20 (b.av2 SR-10.3): the per-persona catch logs the error's description
  // (type, safe code, message through `redactSlackLogText`, frames), never the
  // error itself. The message carries the leak marker only inside a fake token
  // and a `ticket=` URL, both of which redaction replaces. Every console.error
  // argument is kept unformatted, so a raw error fails the leak check. b.jg5
  // SRJ-314: a throwing liveness probe no longer reaches that catch; its line
  // is the tick's `liveness unknown` skip, which describes the error the same
  // way.
  test.each<[string, 'statRoute' | 'isSessionAlive', string]>([
    ['the working-directory stat', 'statRoute', '[slack] health-check: error checking persona=failing_bot: '],
    ['the liveness probe (read as unknown)', 'isSessionAlive', '[slack] health-check: liveness unknown for persona=failing_bot (isSessionAlive failed: '],
  ])('AC 20: %s throws an error carrying fake tokens — one line naming its type, code and redacted message; the other persona is still restarted; nothing leaks', async (_label, site, prefix) => {
    const personas = workList('failing_bot', 'dead_bot')
    const deps = makeDeps({ personas, maxTicks: 1 })
    const thrown = Object.assign(new Error(`status failed (${sentinelInMessage('msg')})`), {
      code: 'EIO',
      detail: fakeToken(APP_TOKEN_PREFIX, 'detail'),
      note: LEAK_SENTINEL,
    })
    const alive = deps.isSessionAlive
    const stat = deps.statRoute
    if (site === 'isSessionAlive') {
      deps.isSessionAlive = async (key) => {
        if (key !== 'failing_bot') return alive(key)
        throw thrown
      }
    } else {
      deps.statRoute = async (cwd) => {
        if (cwd !== personas.failing_bot) return stat(cwd)
        throw thrown
      }
    }
    initHealthCheck(deps)
    const errArgs: unknown[][] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args) }
    try {
      startHealthCheck(FAST_INTERVAL_S)
      await Bun.sleep(WAIT_MS)
    } finally {
      console.error = orig
    }

    expect(deps.scheduleRestartCalls.map((c) => c.key)).toEqual(['dead_bot'])
    const lines = errArgs.filter((args) => String(args[0]).includes('persona=failing_bot'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toHaveLength(1)
    expect(String(lines[0]![0])).toStartWith(
      `${prefix}Error code=EIO message="status failed (${REDACTED_SENTINEL_TAIL})" at `,
    )
    assertNoLeak({ errArgs, notices })
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
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_DEAD })
    initHealthCheck(deps)

    // Deliberately do NOT call startHealthCheck — simulate the window between
    // initHealthCheck (called before startup) and startHealthCheck (called after
    // writeSessions completes).
    await Bun.sleep(WAIT_MS)

    expect(deps.isSessionAliveCalls).toHaveLength(0)
  })

  test('T26: poller starts immediately once startHealthCheck is called after writeSessions phase', async () => {
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
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
  test('(a) statRoute returns true → cwd-unreachable cleared under the persona key', async () => {
    // Pre-raise the flag so clearOutageFlag has a visible effect
    setOutageFlag(KEY, 'cwd-unreachable', WD)
    expect(getOutageFlags(KEY).has('cwd-unreachable')).toBe(true)

    const deps = makeDeps({ statRouteResult: true, isSessionAliveResult: LIVENESS_READING_LIVE })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(getOutageFlags(KEY).has('cwd-unreachable')).toBe(false)
    // The pre-raise onset, then exactly one all-clear — both for the persona key.
    expect(notices).toEqual([
      { key: KEY, text: ONSET_TEMPLATES['cwd-unreachable'](WD) },
      { key: KEY, text: ALL_CLEAR_TEMPLATE(new Map([['cwd-unreachable', { detail: WD }]])) },
    ])
  })

  test('(b) statRoute returns false → cwd-unreachable raised under the persona key with its working directory', async () => {
    expect(getOutageFlags(KEY).has('cwd-unreachable')).toBe(false)

    // A `live` reading, so scheduleRestart is NOT called — isolates statRoute effect
    const deps = makeDeps({ statRouteResult: false, isSessionAliveResult: LIVENESS_READING_LIVE })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(getOutageFlags(KEY).has('cwd-unreachable')).toBe(true)
    // The stat target is the persona's working directory, and the one onset
    // (deduped across ticks) carries it as detail, raised for the persona key.
    expect(deps.statRouteCalls.length).toBeGreaterThan(0)
    expect(new Set(deps.statRouteCalls)).toEqual(new Set([WD]))
    expect(notices).toEqual([{ key: KEY, text: ONSET_TEMPLATES['cwd-unreachable'](WD) }])
  })

  test('(c) scheduleRestart is called when isSessionAlive reads dead', async () => {
    const deps = makeDeps({ statRouteResult: true, isSessionAliveResult: LIVENESS_READING_DEAD })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].key).toBe(KEY)
    expect(deps.scheduleRestartCalls[0].cwd).toBe(WD)
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
// The health-check tick must skip capped personas (isAtCap=true) and not call
// scheduleRestart for them. Other personas in the same tick are unaffected.
// A persona with isAtCap=false continues to behave as before this feature.
// ---------------------------------------------------------------------------

describe('isAtCap tick-guard (SR-25.3/25.4)', () => {
  // -------------------------------------------------------------------------
  // Cap-guard: capped persona is skipped (no scheduleRestart, no isSessionAlive)
  // -------------------------------------------------------------------------

  test('SR-25.3: capped persona is SKIPPED — scheduleRestart not called, isSessionAlive not called', async () => {
    // SR-25.3/25.4: once a persona is at cap, the health-check tick must not
    // re-schedule restarts. The tick logs a message and continues past the persona.
    const deps = makeDeps({
      isAtCapResult: true,
      isSessionAliveResult: LIVENESS_READING_DEAD,  // would trigger restart if not capped
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    // scheduleRestart must not have been called — capped persona is skipped
    expect(deps.scheduleRestartCalls).toHaveLength(0)
    // isSessionAlive must not have been called — skip fires before the probe
    expect(deps.isSessionAliveCalls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Cap-guard: un-capped persona proceeds normally (isAtCap=false baseline)
  // -------------------------------------------------------------------------

  test('SR-25.3: non-capped persona proceeds — dead session triggers scheduleRestart', async () => {
    const deps = makeDeps({
      isAtCapResult: false,
      isSessionAliveResult: LIVENESS_READING_DEAD,
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].key).toBe(KEY)
  })

  // -------------------------------------------------------------------------
  // Cap-guard: mixed personas — capped persona skipped, live persona processed
  // -------------------------------------------------------------------------

  test('SR-25.4: mixed personas — capped persona skipped while uncapped dead persona gets scheduleRestart', async () => {
    // capped_bot is at cap (isAtCap=true) → must be skipped
    // dead_bot is not at cap (isAtCap=false) and dead → scheduleRestart must be called
    const cappedKeys = new Set(['capped_bot'])
    const personas = workList('capped_bot', 'dead_bot')

    const scheduleRestartCalls: Array<{ key: string; cwd: string }> = []
    const isSessionAliveCalls: string[] = []

    const deps: HealthCheckDeps & {
      scheduleRestartCalls: typeof scheduleRestartCalls
      isSessionAliveCalls: typeof isSessionAliveCalls
    } = {
      scheduleRestartCalls,
      isSessionAliveCalls,

      async isSessionAlive(key) {
        isSessionAliveCalls.push(key)
        return LIVENESS_READING_DEAD  // both personas are dead
      },
      isSessionConnected(_key) {
        return true
      },
      hasSessionStream(_key) {
        return true
      },
      isRestartPendingOrActive(_key) {
        return false
      },
      isAtCap(key) {
        // SR-25.3/25.4: capped personas are skipped by the tick
        return cappedKeys.has(key)
      },
      statRoute(_cwd) {
        return Promise.resolve(true)
      },
      scheduleRestart(key, cwd) {
        scheduleRestartCalls.push({ key, cwd })
      },
      isShuttingDown() { return false },
      getPersonas() {
        return personas
      },
    }

    initHealthCheck(deps)
    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    // dead_bot: scheduleRestart called (not capped, dead)
    expect(scheduleRestartCalls.some(c => c.key === 'dead_bot')).toBe(true)

    // capped_bot: scheduleRestart NOT called (skipped due to cap)
    expect(scheduleRestartCalls.some(c => c.key === 'capped_bot')).toBe(false)

    // capped_bot: isSessionAlive NOT called (skip fires before the probe)
    expect(isSessionAliveCalls.some(k => k === 'capped_bot')).toBe(false)

    // dead_bot: isSessionAlive WAS called (not skipped)
    expect(isSessionAliveCalls.some(k => k === 'dead_bot')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// b.9a7 — alive-but-disconnected tick recovery
//
// Before b.9a7 the tick did `if (!alive) scheduleRestart(...)`, so a persona in
// an AD live state (e.g. `waiting`) whose MCP session was disconnected
// (isSessionAlive reads live, isSessionConnected === false) was NEVER scheduled
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
    // scheduleRestart is NEVER called for this persona. Post-fix it is called —
    // and specifically on the SECOND disconnected observation (the debounce
    // covers the freshly-launched, not-yet-connected window, AC 6).
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: false })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    // A stranded alive-but-disconnected persona IS scheduled within a bounded
    // number of ticks — no inbound message, no server restart (AC 2/5).
    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].key).toBe(KEY)
    expect(deps.scheduleRestartCalls[0].cwd).toBe(WD)
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
      isSessionAliveResult: LIVENESS_READING_LIVE,
      connectedSequence: { [KEY]: [false, true, false, true] },
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
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: false })
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
    // persona entirely — even when alive && !connected. This is the existing
    // isRestartPendingOrActive skip; it must cover the new reconnect path too.
    const deps = makeDeps({
      isSessionAliveResult: LIVENESS_READING_LIVE,
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
      isSessionAliveResult: LIVENESS_READING_LIVE,
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
    // dead session (isSessionAlive reads dead) must still schedule on the first tick,
    // as before b.9a7. isSessionConnected is irrelevant on the dead path — the
    // fire happens with connected-call-count 0 (never probed).
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_DEAD, isSessionConnectedResult: false })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].key).toBe(KEY)
    // Dead path does not consult isSessionConnected: count stays 0 at fire.
    expect(deps.scheduleRestartAtConnectedCount[0]).toBe(0)
    expect(deps.isSessionConnectedCalls).toHaveLength(0)
  })

  test('7. capped persona fully skipped including reconnects (alive && !connected on consecutive ticks)', async () => {
    // AC 7 / design decision 1: a capped persona gets NO tick-driven reconnect,
    // even when alive && !connected across many ticks. The isAtCap skip precedes
    // the connectedness probe.
    const deps = makeDeps({
      isAtCapResult: true,
      isSessionAliveResult: LIVENESS_READING_LIVE,
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
      isSessionAliveResult: LIVENESS_READING_LIVE,
      // exactly one disconnected observation then connected — leaves streak at 1
      connectedSequence: { [KEY]: [false, true] },
    })
    initHealthCheck(deps1)
    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)
    expect(deps1.scheduleRestartCalls).toHaveLength(0)
    // Anti-vacuity: the phase-1 run must actually have observed the persona at
    // least once (accumulating the streak of 1) — otherwise the reset below
    // would be clearing nothing and the test would pass vacuously.
    expect(deps1.isSessionConnectedCalls.length).toBeGreaterThanOrEqual(1)

    _resetHealthCheckState()

    // Fresh run: one disconnected observation then connected. If the streak had
    // leaked (still 1), this single false would reach 2 and fire. It must not.
    const deps2 = makeDeps({
      isSessionAliveResult: LIVENESS_READING_LIVE,
      connectedSequence: { [KEY]: [false, true] },
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
      isSessionAliveResult: LIVENESS_READING_LIVE,
      isSessionConnectedResult: false,
      pendingSequence: [false, true, false, false],  // last (false) repeats
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].key).toBe(KEY)
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
      isSessionAliveResult: LIVENESS_READING_LIVE,
      isSessionConnectedResult: false,
      atCapSequence: [false, true, false, false],  // last (false) repeats
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].key).toBe(KEY)
    // Two fresh post-cap observations were required — the pre-cap streak of 1
    // was cleared by the cap skip rather than carried across.
    expect(deps.scheduleRestartAtConnectedCount[0]).toBe(3)
  })

  test('12. streak cleared on not-up skip: a persona the relaunch gate leaves out of a tick\'s work list does NOT carry its disconnected streak back in (b.av2 SR-6.4)', async () => {
    // The third count-resetting skip, beside pending (10) and cap (11): the
    // relaunch gate leaves a persona that is not up out of the work list, and
    // the tick drops its streak. STAY is in every tick's list and healthy, so
    // tick 2's list is not empty — only DROP is missing from it.
    //   tick1: [DROP, STAY] → DROP !connected → streak=1 (DROP connected call 1)
    //   tick2: [STAY]       → DROP not in the list (streak cleared; no probe)
    //   tick3: [DROP, STAY] → DROP !connected → FRESH streak=1 (call 2) — no fire
    //   tick4: [DROP, STAY] → DROP !connected → streak=2 → FIRE (call 3)
    // Without the clear, the streak of 1 from before DROP went down would
    // survive, so its first observation after coming back (call 2) would fire.
    const full = workList('Gate Drop', 'Gate Stay')
    const [DROP, STAY] = Object.keys(full)
    const onlyStay = { [STAY]: full[STAY] }
    const deps = makeDeps({
      isSessionAliveResult: LIVENESS_READING_LIVE,
      connectedSequence: { [DROP]: [false], [STAY]: [true] },
      personasSequence: [full, onlyStay, full, full],  // last (full) repeats
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    // Anti-vacuity: tick 2 ran without DROP (not probed), STAY probed on every tick.
    expect(deps.isSessionConnectedCalls.slice(0, 6)).toEqual([DROP, STAY, STAY, DROP, STAY, DROP])
    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls.every((c) => c.key === DROP)).toBe(true)
    expect(deps.scheduleRestartCalls[0].cwd).toBe(full[DROP])
    // Two fresh observations after it came back were required — no reconnect
    // or restart was scheduled on the first one.
    expect(deps.scheduleRestartAtConnectedCount[0]).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// b.9cj — connected-but-streamless tick recovery
//
// Before b.9cj the alive-tick's unhealthy condition was `!isSessionConnected`
// alone. A session that was alive AND connected but whose standalone GET SSE
// stream had been silently dropped (`hasSessionStream === false`) landed in the
// healthy `else` and was never recovered. The fix widens the unhealthy
// condition to `!isSessionConnected || !hasSessionStream`, composing with the
// EXISTING two-consecutive-tick disconnectedStreak debounce (no new streak
// map). These tests pin: (a) a streamless session fires on the 2nd consecutive
// streamless tick, not the 1st; (b) a stream-present session is healthy and
// resets the streak.
// ---------------------------------------------------------------------------

describe('b.9cj connected-but-streamless tick recovery', () => {
  test('REGRESSION: alive + connected but STREAMLESS → scheduleRestart fires on the 2nd consecutive tick, not the 1st', async () => {
    // Pre-fix, a connected session was "healthy" regardless of stream presence,
    // so scheduleRestart was NEVER called here. Post-fix it fires — and only on
    // the SECOND streamless observation (shares the b.9a7 debounce for the
    // freshly-launched, stream-not-yet-open window).
    const deps = makeDeps({
      isSessionAliveResult: LIVENESS_READING_LIVE,
      isSessionConnectedResult: true,   // connected …
      hasSessionStreamResult: false,    // … but streamless
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    expect(deps.scheduleRestartCalls[0].key).toBe(KEY)
    expect(deps.scheduleRestartCalls[0].cwd).toBe(WD)
    // First fire landed on the 2nd streamless observation, never the 1st.
    expect(deps.scheduleRestartAtStreamCount[0]).toBe(2)
  })

  test('alive + connected + stream present → healthy: no scheduleRestart and streak resets', async () => {
    // A fully healthy session (alive, connected, stream present) is never
    // scheduled. Prove it also RESETS the streak: a lone streamless blip
    // followed by a stream-present tick never reaches two consecutive.
    const deps = makeDeps({
      isSessionAliveResult: LIVENESS_READING_LIVE,
      isSessionConnectedResult: true,
      // false (streak→1), true (reset), false (fresh streak→1), true (reset) …
      streamSequence: { [KEY]: [false, true, false, true] },
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    // No two CONSECUTIVE streamless observations ever occurred — the healthy
    // (stream-present) branch cleared the streak each time.
    expect(deps.scheduleRestartCalls).toHaveLength(0)
    // Anti-vacuity: the scripted sequence was actually observed.
    expect(deps.hasSessionStreamCalls.length).toBeGreaterThanOrEqual(4)
  })

  test('DISCONNECTED (connected===false) short-circuits the OR: hasSessionStream is never consulted, recovery still fires on every 2nd tick', async () => {
    // The unhealthy condition is `!isSessionConnected || !hasSessionStream`
    // (health-check.ts:184). When connected===false the FIRST operand is already
    // true, so JS short-circuits and hasSessionStream is NEVER called for this
    // persona — the disconnected path (b.9a7) and the streamless path (b.9cj)
    // share the same debounced branch and streak map. hasSessionStreamResult is
    // set false here only to prove it is irrelevant when disconnected.
    const deps = makeDeps({
      isSessionAliveResult: LIVENESS_READING_LIVE,
      isSessionConnectedResult: false,   // disconnected — first operand short-circuits
      hasSessionStreamResult: false,     // would also route here, but is never reached
    })
    initHealthCheck(deps)

    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    // The disconnected session was recovered.
    expect(deps.scheduleRestartCalls.length).toBeGreaterThan(0)
    // Proof of short-circuit: the stream probe was never consulted for the persona.
    expect(deps.hasSessionStreamCalls).toHaveLength(0)
    // Every fire lands at an even CONNECTED-observation count (2, 4, 6…): the
    // shared streak is consumed on fire and must re-accumulate two observations.
    for (const n of deps.scheduleRestartAtConnectedCount) {
      expect(n % 2).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.3 — the tick's work list and streaks are keyed by persona
//
// A persona listed in two channels is one instance, so it is checked once per
// tick. Ticks are bounded with `maxTicks` so per-tick counts are exact.
// ---------------------------------------------------------------------------

describe('persona-keyed work list and streaks (b.av2 SR-6.3)', () => {
  test('buildPersonaWorkList: a two-channel persona is one entry; one tick probes and schedules once per persona key', async () => {
    // A name that is not already in key form, so key ≠ name ≠ any channel ID.
    const config = makeMultiPersonaConfig([
      { name: 'Alpha Bot', channels: [{ id: 'C0ALPHA01', delivery: 'all' }, { id: 'C0ALPHA02', delivery: 'mentions' }] },
      { name: 'beta_bot' },
    ], baseDir)
    const [a, b] = config.personas
    const channelIds = config.personas.flatMap((p) => p.channels.map((c) => c.id))

    const personas = buildPersonaWorkList(config)
    expect(personas).toEqual({ [a.key]: a.working_directory, [b.key]: b.working_directory })

    const deps = makeDeps({ personas, isSessionAliveResult: LIVENESS_READING_DEAD, maxTicks: 1 })
    initHealthCheck(deps)
    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.tickCount()).toBe(1)
    // Exactly one liveness probe and one stat per persona, never per channel.
    expect(deps.isSessionAliveCalls).toEqual([a.key, b.key])
    expect(deps.statRouteCalls).toEqual([a.working_directory, b.working_directory])
    expect(deps.scheduleRestartCalls).toEqual([
      { key: a.key, cwd: a.working_directory },
      { key: b.key, cwd: b.working_directory },
    ])
    expect(deps.scheduleRestartCalls.some((c) => channelIds.includes(c.key))).toBe(false)
  })

  test('buildPersonaWorkList with include (the server passes the relaunch gate): only the personas it accepts, each asked once by key, in config order', () => {
    const config = makeMultiPersonaConfig([{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }], baseDir)
    const [alpha, , gamma] = config.personas
    const asked: string[] = []

    const personas = buildPersonaWorkList(config, (key) => (asked.push(key), key !== 'beta'))

    expect(personas).toEqual({ alpha: alpha.working_directory, gamma: gamma.working_directory })
    expect(asked).toEqual(['alpha', 'beta', 'gamma'])
    expect(buildPersonaWorkList(config, () => false)).toEqual({})
  })

  test('streak isolation: only the alive-but-disconnected persona advances its streak and is scheduled', async () => {
    // Over two ticks A is disconnected both times; B is connected on tick 1 and
    // disconnected on tick 2. Keyed streaks: A reaches 2 and fires, B is at 1.
    // A shared streak would instead be reset by B's healthy tick 1 (A never
    // fires) and carried into B's tick-2 observation (B fires).
    const personas = workList('persona_a', 'persona_b')
    const deps = makeDeps({
      personas,
      isSessionAliveResult: LIVENESS_READING_LIVE,
      connectedSequence: { persona_a: [false], persona_b: [true, false] },
      maxTicks: 2,
    })
    initHealthCheck(deps)
    startHealthCheck(FAST_INTERVAL_S)
    await Bun.sleep(WAIT_MS)

    expect(deps.tickCount()).toBe(2)
    expect(deps.isSessionConnectedCalls).toEqual(['persona_a', 'persona_b', 'persona_a', 'persona_b'])
    expect(deps.scheduleRestartCalls).toEqual([{ key: 'persona_a', cwd: personas.persona_a }])
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.5 — a teardown forgets the persona's disconnected streak
//
// `forgetDisconnectedStreak(key)` drops one persona's streak at once, while it
// may still be in the next tick's work list; the tick itself drops the streak
// of a persona missing from its work list (case 12 above).
// ---------------------------------------------------------------------------

/** Start the check and wait until `deps` has run `n` tick bodies (bounded by its `maxTicks`). */
async function runTicks(deps: ReturnType<typeof makeDeps>, n: number): Promise<void> {
  initHealthCheck(deps)
  startHealthCheck(FAST_INTERVAL_S)
  for (let waited = 0; deps.tickCount() < n && waited < 500; waited++) await Bun.sleep(1)
  await Bun.sleep(20)  // let the last tick body settle; later ticks stop at maxTicks
  stopHealthCheck()
  expect(deps.tickCount()).toBe(n)
}

describe('forgetDisconnectedStreak — per-persona teardown (b.av2 SR-6.5)', () => {
  test('B\'s streak is dropped at once and silently, A\'s is kept; B then leaves the work list (not probed) and is re-added with a fresh streak', async () => {
    const full = workList('persona_a', 'persona_b')
    const onlyA = { persona_a: full.persona_a }
    const disconnected = { isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: false }

    // One tick: both alive-but-disconnected, so each has a streak of 1.
    const before = makeDeps({ ...disconnected, personas: full, maxTicks: 1 })
    await runTicks(before, 1)
    expect(before.scheduleRestartCalls).toEqual([])

    const lines: string[] = []
    const savedError = console.error
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
    try { forgetDisconnectedStreak('persona_b') } finally { console.error = savedError }
    expect(lines).toEqual([])

    //   tick1 [A, B]: A streak 2 → scheduled; B forgotten → fresh streak 1, not scheduled
    //   tick2 [A]:    B torn down, out of the work list → not stat'd or probed
    //   tick3 [A, B]: B re-added → checked again, fresh streak 1, not scheduled
    //   tick4 [A, B]: B streak 2 → scheduled
    const after = makeDeps({ ...disconnected, personasSequence: [full, onlyA, full, full], maxTicks: 4 })
    await runTicks(after, 4)

    const [A, B] = ['persona_a', 'persona_b']
    expect(after.isSessionAliveCalls).toEqual([A, B, A, A, B, A, B])
    expect(after.statRouteCalls).toEqual([full[A], full[B], full[A], full[A], full[B], full[A], full[B]])
    expect(after.scheduleRestartCalls).toEqual([
      { key: A, cwd: full[A] },
      { key: A, cwd: full[A] },
      { key: B, cwd: full[B] },
    ])
    // Each fire's own connectedness observation: A on its 1st (tick 1, its kept
    // streak) and 3rd (tick 3); B on its 3rd (tick 4), two fresh observations
    // after the forget and the re-add.
    expect(after.scheduleRestartAtConnectedCount).toEqual([1, 3, 3])
  })
})

// ---------------------------------------------------------------------------
// b.f2b — a launch in flight, the delay-0 not-connected notice, and pending
// working-row evidence
//
// A start launch still waiting in the background for a `working` row (or any
// launch in flight) owns its session: the tick skips the persona as it skips a
// pending restart. With session_restart_delay 0, scheduleRestart only logs and
// returns, so an alive persona the tick would reconnect gets the not-connected
// notice, worded for why it is undeliverable (the real session-manager
// notifier here: once per episode, and a healthy tick ends the episode). While the
// reconnect adapter holds an idle run for a persona's `working` row, one more
// attempt can find the row stale, so the tick schedules it on the first
// undeliverable observation instead of the second.
// ---------------------------------------------------------------------------

describe('b.f2b: launches in flight, the delay-0 not-connected notice, pending working-row evidence', () => {
  afterEach(() => {
    setSessionNotifier(undefined)
    _resetNotConnectedEpisodes()
  })

  test('a persona whose launch is in flight is skipped like a pending restart (not stat\'d, probed or scheduled), and its streak does not carry across the launch', async () => {
    //   tick1: not in flight → alive && !connected → streak 1 (connected call 1)
    //   tick2: in flight     → skipped, streak cleared
    //   tick3: → fresh streak 1 (call 2); tick4: → streak 2 → scheduled (call 3)
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: false, maxTicks: 4 })
    const inFlight = [false, true, false, false]
    const asked: string[] = []
    deps.isLaunchInFlight = (key) => inFlight[Math.min(asked.push(key) - 1, inFlight.length - 1)]!

    await runTicks(deps, 4)

    expect(asked).toEqual([KEY, KEY, KEY, KEY])
    expect(deps.statRouteCalls).toHaveLength(3)
    expect(deps.isSessionAliveCalls).toHaveLength(3)
    expect(deps.scheduleRestartAtConnectedCount).toEqual([3])
  })

  test.each<[string, boolean, DepsOpts, 'disconnected' | 'streamless', string[]]>([
    ['disabled (session_restart_delay 0), disconnected', true, { isSessionConnectedResult: false }, 'disconnected', [':warning: *Not connected*', 'its connection has been down on two health checks in a row']],
    ['disabled (session_restart_delay 0), connected with its stream gone', true, { hasSessionStreamResult: false }, 'streamless', [':warning: *Not receiving messages*', 'its message stream is gone']],
    ['enabled, disconnected', false, { isSessionConnectedResult: false }, 'disconnected', []],
    ['enabled, connected with its stream gone', false, { hasSessionStreamResult: false }, 'streamless', []],
  ])('auto-restart %s: the alive persona is scheduled every second tick; with auto-restart disabled each schedule asks for the not-connected notice with the persona and why, raised once for the episode', async (_label, disabled, down, cause, notice) => {
    const raised: Array<{ key: string; text: string }> = []
    setSessionNotifier((key, text) => { raised.push({ key, text }) })
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE, ...down, maxTicks: 6 })
    deps.isAutoRestartDisabled = () => disabled
    const asked: Array<[number, string, string]> = []
    deps.notifyNotConnected = (key, why) => {
      asked.push([deps.isSessionConnectedCalls.length, key, why])
      notifyDisconnectedWithAutoRestartDisabled(key, why)
    }

    await runTicks(deps, 6)

    expect(deps.scheduleRestartAtConnectedCount).toEqual([2, 4, 6])
    expect(asked).toEqual(disabled ? [[2, KEY, cause], [4, KEY, cause], [6, KEY, cause]] : [])
    expect(raised.map((n) => n.key)).toEqual(disabled ? [KEY] : [])
    if (disabled) {
      const [head, detail] = notice
      expect(raised[0]!.text).toStartWith(head!)
      expect(raised[0]!.text).toContain(detail!)
    }
  })

  test('one latch for every notice: an unproven-idle notice already raised in the episode (a launch wait that gave up on the working row at delay 0) is the episode\'s one; the tick\'s delay-0 notice raises nothing more', async () => {
    const raised: Array<{ key: string; text: string }> = []
    setSessionNotifier((key, text) => { raised.push({ key, text }) })
    expect(notifyPersonaNotConnected(KEY, { reason: 'unproven-idle', autoRestartDisabled: true, heldMs: 10 * 60_000 })).toBe(true)
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: false, maxTicks: 4 })
    deps.isAutoRestartDisabled = () => true
    let asked = 0
    deps.notifyNotConnected = (key, why) => {
      asked++
      notifyDisconnectedWithAutoRestartDisabled(key, why)
    }

    await runTicks(deps, 4)

    expect(deps.scheduleRestartAtConnectedCount).toEqual([2, 4])
    expect(asked).toBe(2)
    expect(raised.map((n) => n.key)).toEqual([KEY])
    expect(raised[0]!.text).toContain('its session reads working but CSCB can\'t prove it\'s idle')
  })

  test('a healthy tick, and only a healthy one, ends the persona\'s not-connected episode (endNotConnectedEpisode): a later episode is reported again', async () => {
    //   ticks 1–2: disconnected → scheduled at tick 2, the notice raised
    //   tick 3:    healthy      → the episode ends
    //   ticks 4–5: disconnected → scheduled at tick 5, the notice raised again
    const raised: Array<{ key: string; text: string }> = []
    setSessionNotifier((key, text) => { raised.push({ key, text }) })
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE, connectedSequence: { [KEY]: [false, false, true, false, false] }, maxTicks: 5 })
    deps.isAutoRestartDisabled = () => true
    deps.notifyNotConnected = notifyDisconnectedWithAutoRestartDisabled
    const ended: Array<[number, string]> = []
    deps.endNotConnectedEpisode = (key) => {
      ended.push([deps.isSessionConnectedCalls.length, key])
      forgetNotConnectedEpisode(key)
    }

    await runTicks(deps, 5)

    expect(deps.scheduleRestartAtConnectedCount).toEqual([2, 5])
    expect(ended).toEqual([[3, KEY]])
    expect(raised.map((n) => n.key)).toEqual([KEY, KEY])
  })

  test.each<[string, boolean, number[]]>([
    ['pending', true, [1, 2]],
    ['none', false, [2]],
  ])('working-row evidence %s: an alive persona not deliverable is scheduled from its first undeliverable tick when evidence is pending, else from its second', async (_label, pending, scheduledAt) => {
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: false, maxTicks: 2 })
    deps.hasPendingWorkingRowEvidence = () => pending

    await runTicks(deps, 2)

    expect(deps.scheduleRestartAtConnectedCount).toEqual(scheduledAt)
  })

  test('pending working-row evidence schedules nothing for a persona that is connected with its stream', async () => {
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE, maxTicks: 2 })
    deps.hasPendingWorkingRowEvidence = () => true

    await runTicks(deps, 2)

    expect(deps.scheduleRestartCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-314 — an `unknown` reading, or a probe that threw, skips the tick
//
// Only `dead` schedules a restart. An `unknown` reading (a `status` error
// agent-director could not answer) or a thrown probe skips the persona for the
// tick: nothing is scheduled, no not-connected notice is asked for, the
// episode is not ended, and its disconnected streak is cleared, as every skip
// clears it (ruling (b)). The tick has no retry-timer hook, so it arms nothing.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-314: an unknown reading or a thrown probe skips the persona for the tick', () => {
  const UNSURE: Array<[string, LivenessReading | Error]> = [
    ['an unknown reading', LIVENESS_READING_UNKNOWN],
    ['a thrown probe', new Error('simulated status failure')],
    ['an answer that is not a reading', true as unknown as LivenessReading],
  ]

  test.each(UNSURE.flatMap(([label, answer]) => [
    [`${label}, the session connected with its stream`, answer, {}],
    [`${label}, the session disconnected`, answer, { isSessionConnectedResult: false }],
  ] as Array<[string, LivenessReading | Error, DepsOpts]>))('%s: over three ticks nothing is scheduled, no notice asked for and no episode ended; connectedness is never probed; each tick logs its skip once, naming the persona', async (_label, answer, conn) => {
    // Were the answer read as dead, tick 1 would schedule; read as alive, a
    // connected session would end its episode each tick and a disconnected
    // one would be scheduled (and noticed, auto-restart disabled) on tick 2.
    const deps = makeDeps({ ...conn, aliveSequence: { [KEY]: [answer] }, maxTicks: 3 })
    deps.isAutoRestartDisabled = () => true
    const notified: string[] = []
    const ended: string[] = []
    deps.notifyNotConnected = (key) => void notified.push(key)
    deps.endNotConnectedEpisode = (key) => void ended.push(key)
    const lines: string[] = []
    const savedError = console.error
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '))

    try { await runTicks(deps, 3) } finally { console.error = savedError }

    expect(deps.isSessionAliveCalls).toEqual([KEY, KEY, KEY])
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(notified).toEqual([])
    expect(ended).toEqual([])
    expect(deps.isSessionConnectedCalls).toEqual([])
    expect(deps.hasSessionStreamCalls).toEqual([])
    const skips = lines.filter((line) => line.includes('liveness unknown'))
    expect(skips).toHaveLength(3)
    for (const line of skips) {
      expect(line).toStartWith(`[slack] health-check: liveness unknown for persona=${KEY}`)
      expect(line).toContain('skipping it this tick')
    }
  })

  test.each(UNSURE)('the streak is cleared by %s: undeliverable, then unsure, then undeliverable schedules nothing; a second undeliverable tick after it schedules', async (_label, answer) => {
    //   tick1: live, !connected → streak 1 (connected call 1)
    //   tick2: unsure           → skipped, streak cleared (not probed)
    //   tick3: live, !connected → fresh streak 1 (call 2) — nothing scheduled
    //   tick4: live, !connected → streak 2 → scheduled (call 3)
    // A streak kept across tick 2 would schedule at call 2 (tick 3).
    const deps = makeDeps({
      isSessionConnectedResult: false,
      aliveSequence: { [KEY]: [LIVENESS_READING_LIVE, answer, LIVENESS_READING_LIVE] },
      maxTicks: 4,
    })

    await runTicks(deps, 4)

    expect(deps.isSessionAliveCalls).toHaveLength(4)
    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }])
    expect(deps.scheduleRestartAtConnectedCount).toEqual([3])
  })

  test.each(UNSURE)('%s for one persona in a tick: the other persona, read dead, is still scheduled in the same tick', async (_label, answer) => {
    const personas = workList('unsure_bot', 'dead_bot')
    const deps = makeDeps({ personas, aliveSequence: { unsure_bot: [answer] }, maxTicks: 1 })

    await runTicks(deps, 1)

    expect(deps.isSessionAliveCalls).toEqual(['unsure_bot', 'dead_bot'])
    expect(deps.scheduleRestartCalls).toEqual([{ key: 'dead_bot', cwd: personas.dead_bot! }])
  })

  test.each(UNSURE)('%s on one tick, then dead on the next: the restart is scheduled at once on the dead tick', async (_label, answer) => {
    const deps = makeDeps({ aliveSequence: { [KEY]: [answer, LIVENESS_READING_DEAD] }, maxTicks: 2 })

    await runTicks(deps, 2)

    expect(deps.isSessionAliveCalls).toEqual([KEY, KEY])
    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-314 — a `pending` row is never counted healthy
//
// A `pending` reading takes the alive branches, but only `live` is healthy. A
// `pending` row connected with its stream takes the not-deliverable path (the
// two-tick streak, then scheduleRestart, whose run defers it: pinned in
// tests/restart.test.ts), never ends the not-connected episode and gets no
// delay-0 notice, whose "disconnected" or "streamless" wording would be false.
// A disconnected or streamless `pending` row keeps the alive branch, notice
// included. Each case runs with and without a launch start on the reading.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-314: a pending row is never counted healthy', () => {
  const PENDING_READINGS: Array<[string, LivenessReading]> = [
    ['no launch start', LIVENESS_READING_PENDING],
    ['a launch start', pendingLivenessReading(SAMPLE_LAUNCH_START_WHOLE)],
  ]

  /** Deps with auto-restart disabled, recording notices asked for and episodes ended with the connectedness-call count at the time. */
  function pendingDeps(opts: DepsOpts) {
    const deps = makeDeps(opts)
    deps.isAutoRestartDisabled = () => true
    const notified: Array<[number, string, string]> = []
    const ended: Array<[number, string]> = []
    deps.notifyNotConnected = (key, why) => void notified.push([deps.isSessionConnectedCalls.length, key, why])
    deps.endNotConnectedEpisode = (key) => void ended.push([deps.isSessionConnectedCalls.length, key])
    return { deps, notified, ended }
  }

  test.each(PENDING_READINGS)('pending (%s), connected with its stream: scheduled on its second consecutive tick, never its first; no notice; only a live healthy tick between resets the streak and ends the episode', async (_label, pending) => {
    //   ticks 1–2: pending, deliverable → streak 1, then 2 → scheduled (call 2)
    //   tick 3:    live, deliverable    → healthy: streak reset, episode ended
    //   ticks 4–5: pending, deliverable → fresh streak 1, then 2 → scheduled (call 5)
    // Counted healthy, pending would end the episode each tick and never be
    // scheduled; read dead, it would be scheduled on every tick from the first.
    const { deps, notified, ended } = pendingDeps({
      aliveSequence: { [KEY]: [pending, pending, LIVENESS_READING_LIVE, pending] },
      maxTicks: 5,
    })

    await runTicks(deps, 5)

    expect(deps.isSessionConnectedCalls).toHaveLength(5)
    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }, { key: KEY, cwd: WD }])
    expect(deps.scheduleRestartAtConnectedCount).toEqual([2, 5])
    expect(ended).toEqual([[3, KEY]])
    expect(notified).toEqual([])
  })

  test.each(PENDING_READINGS.flatMap(([label, pending]) => [
    [`${label}, disconnected`, pending, { isSessionConnectedResult: false }, 'disconnected'],
    [`${label}, connected with its stream gone`, pending, { hasSessionStreamResult: false }, 'streamless'],
  ] as Array<[string, LivenessReading, DepsOpts, 'disconnected' | 'streamless']>))('pending (%s): the alive branch — scheduled every second tick, each schedule asking for the notice with its true reason, no episode ended', async (_label, pending, down, cause) => {
    const { deps, notified, ended } = pendingDeps({ ...down, aliveSequence: { [KEY]: [pending] }, maxTicks: 4 })

    await runTicks(deps, 4)

    expect(deps.scheduleRestartAtConnectedCount).toEqual([2, 4])
    expect(notified).toEqual([[2, KEY, cause], [4, KEY, cause]])
    expect(ended).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-310 rule 2 (tick half) — a live healthy tick ends tmux-unresponsive
//
// A tick that finds the persona `live`, connected and with its stream calls
// `endTmuxUnresponsive(key)` for that persona (production binds it to the
// condition's end with reason `tick` and the `live` reading; the binding is
// pinned in tests/server-startup-wiring.test.ts). `pending` (never healthy),
// `unknown`, a thrown probe, `dead`, and a live session that is disconnected
// or connected but streamless never call it. Every other case in this file
// leaves the hook at its default (absent).
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-310: a live, connected tick with its stream ends the persona\'s tmux-unresponsive condition', () => {
  const P = 'healed_bot'
  const B = 'other_bot'

  test.each<[string, LivenessReading, boolean]>([
    ['live but disconnected', LIVENESS_READING_LIVE, false],
    ['pending, connected with its stream', LIVENESS_READING_PENDING, true],
  ])('P live, connected and with its stream, beside B %s in the same tick: the hook is called once, for P only', async (_label, bReading, bConnected) => {
    // B is checked first, so a hook fired with the wrong persona's key would
    // show B's key.
    const personas = workList(B, P)
    const deps = makeDeps({
      personas,
      aliveSequence: { [B]: [bReading], [P]: [LIVENESS_READING_LIVE] },
      connectedSequence: { [B]: [bConnected], [P]: [true] },
      maxTicks: 1,
    })
    const ended: string[] = []
    deps.endTmuxUnresponsive = (key) => void ended.push(key)

    await runTicks(deps, 1)

    expect(deps.isSessionAliveCalls).toEqual([B, P])
    expect(ended).toEqual([P])
  })

  test('the hook is called on every tick that finds the persona live and deliverable, and on no other', async () => {
    //   tick 1: live, deliverable            → called
    //   tick 2: pending, deliverable         → not called
    //   tick 3: live, disconnected           → not called
    //   tick 4: live, deliverable            → called
    const deps = makeDeps({
      aliveSequence: { [KEY]: [LIVENESS_READING_LIVE, LIVENESS_READING_PENDING, LIVENESS_READING_LIVE, LIVENESS_READING_LIVE] },
      connectedSequence: { [KEY]: [true, true, false, true] },
      maxTicks: 4,
    })
    const ended: Array<[number, string]> = []
    deps.endTmuxUnresponsive = (key) => void ended.push([deps.isSessionAliveCalls.length, key])

    await runTicks(deps, 4)

    expect(ended).toEqual([[1, KEY], [4, KEY]])
  })

  test.each<[string, DepsOpts]>([
    ['pending (no launch start), connected with its stream', { aliveSequence: { [KEY]: [LIVENESS_READING_PENDING] } }],
    ['pending (a launch start), connected with its stream', { aliveSequence: { [KEY]: [pendingLivenessReading(SAMPLE_LAUNCH_START_WHOLE)] } }],
    ['unknown', { aliveSequence: { [KEY]: [LIVENESS_READING_UNKNOWN] } }],
    ['a thrown probe', { aliveSequence: { [KEY]: [new Error('simulated status failure')] } }],
    ['dead', { aliveSequence: { [KEY]: [LIVENESS_READING_DEAD] } }],
    ['live but disconnected', { isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: false }],
    ['live and connected but streamless', { isSessionAliveResult: LIVENESS_READING_LIVE, hasSessionStreamResult: false }],
  ])('%s: over two ticks the hook is never called', async (_label, opts) => {
    const deps = makeDeps({ ...opts, maxTicks: 2 })
    const ended: string[] = []
    deps.endTmuxUnresponsive = (key) => void ended.push(key)

    await runTicks(deps, 2)

    expect(deps.isSessionAliveCalls).toEqual([KEY, KEY])
    expect(ended).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.av2 SR-6.3 / SR-6.4 / SR-7.2 / SR-11 — only personas that are up are checked
//
// The server builds the tick's work list as
// `buildPersonaWorkList(config, canRelaunch)`, where `canRelaunch` is
// `createPersonaRelaunchGate(manager, log, bringUpController)`. These cases
// run that wiring for real (the shared connection harness's manager and fake
// clock, the real bring-up controller, the real gate, the real statRoute) and
// drive the real health check one tick at a time with every session dead, so
// any persona that reached a tick would be stat'd, probed and scheduled.
//
// The Slack-unreachable retrying leg is in tests/persona-relaunch-gate.test.ts;
// here are the credentials-broken rows (local check and Slack refusal), the
// directory-broken retrying row and its recovery, and a running persona whose
// directory disappears after it came up (today's cwd-unreachable path).
// ---------------------------------------------------------------------------

/**
 * The bring-up controller's claude_config_dir check against a scratch home
 * `<base>/home` holding a real `.claude`, so no bring-up here depends on the
 * process home (a dangling `$HOME/.claude` would hold every persona).
 */
function configDirCheckUnder(base: string): (persona: Persona) => ReturnType<typeof checkPersonaConfigDir> {
  const home = join(base, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  return (persona) => checkPersonaConfigDir(persona, { home })
}

describe('only personas that are up are checked (b.av2 SR-6.3, SR-6.4, SR-11)', () => {
  let dir: string
  let managers: PersonaConnectionManager[]
  let controllers: PersonaBringUpController[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'health-check-up-'))
    managers = []
    controllers = []
  })

  afterEach(async () => {
    _resetHealthCheckState()
    for (const c of controllers) c.cancelAll()
    await Promise.all(managers.map((m) => m.stopAll()))
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * The server's bring-up wiring over a connection harness: the controller
   * (on the harness clock, recording retry launches) as the manager's status
   * listener, and the relaunch gate over both. `breakPersona` runs after the
   * harness wrote every persona's files and before any bring-up.
   */
  async function bringUpAll(names: string[], opts: {
    stubOptions?: ConnectionHarnessOptions['stubOptions']
    breakPersona?: (h: ConnectionHarness) => void
  } = {}) {
    const h = makeConnectionHarness(names.map((name) => ({ name })), dir, { files: true, stubOptions: opts.stubOptions })
    managers.push(h.manager)
    opts.breakPersona?.(h)
    const lines: string[] = []
    const log = (line: string) => void lines.push(line)
    const launches: string[] = []
    const controller = createPersonaBringUpController({
      connections: h.manager,
      dryRun: false,
      log,
      clock: h.clock,
      checkConfigDir: configDirCheckUnder(dir),
      launch: async (persona: Persona) => void launches.push(persona.key),
    })
    controllers.push(controller)
    h.onStatus = (key, status) => controller.onConnectionStatus(key, status)
    const outcomes: Record<string, string> = {}
    for (const persona of h.personas) outcomes[persona.name] = (await controller.bringUp(persona, h.personas)).outcome
    const canRelaunch = createPersonaRelaunchGate(h.manager, log, controller)
    return { h, controller, canRelaunch, outcomes, launches, lines }
  }

  /**
   * Start the real health check over `getPersonas`, every session dead, with
   * the real statRoute on the real file system (a missing path answers as a
   * non-directory rather than through the factory's error log). `tick()` lets exactly one more tick body run and
   * resolves once every persona in its work list has finished (scheduled, or
   * skipped at cap), so the assertions after it see the whole tick.
   */
  function startSteppedTicks(getPersonas: () => Record<string, string>, atCap: (key: string) => boolean = () => false) {
    const statRoute = _buildStatRouteImpl({
      stat: (path) => fsStat(path).catch(() => ({ isDirectory: () => false })),
    })
    const calls = {
      stat: [] as string[], alive: [] as string[], pending: [] as string[], atCap: [] as string[], scheduled: [] as string[],
    }
    let allowed = 0
    let ticks = 0
    let expectedDone = 0
    let done = 0
    initHealthCheck({
      isSessionAlive: async (key) => (calls.alive.push(key), LIVENESS_READING_DEAD),
      isSessionConnected: () => false,
      hasSessionStream: () => false,
      isRestartPendingOrActive: (key) => (calls.pending.push(key), false),
      isAtCap: (key) => {
        calls.atCap.push(key)
        const capped = atCap(key)
        if (capped) done++
        return capped
      },
      statRoute: (cwd) => (calls.stat.push(cwd), statRoute(cwd)),
      scheduleRestart: (key) => {
        calls.scheduled.push(key)
        done++
      },
      isShuttingDown: () => ticks >= allowed,
      getPersonas: () => {
        ticks++
        const personas = getPersonas()
        expectedDone += Object.keys(personas).length
        return personas
      },
    })
    startHealthCheck(0.002)
    async function tick(): Promise<void> {
      allowed++
      for (let waited = 0; (ticks < allowed || done < expectedDone) && waited < 500; waited++) await Bun.sleep(1)
      expect(ticks).toBe(allowed)
      expect(done).toBe(expectedDone)
    }
    return { calls, tick }
  }

  const BROKEN_SPECS = ['Up Desk', 'Creds Missing', 'Slack Refused', 'Dir Missing']
  const brokenRows = {
    stubOptions: { 'Slack Refused': { authTest: [{ kind: 'platform' as const, error: 'invalid_auth' }] } },
    breakPersona: (h: ConnectionHarness) => {
      rmSync(h.p('Creds Missing').credentials_file)
      rmSync(h.p('Dir Missing').working_directory, { recursive: true, force: true })
    },
  }

  test('broken (credentials missing, Slack refused) and directory-retrying personas beside an up one: no tick stats, probes, schedules, caps or flags them; the up persona is checked every tick', async () => {
    const { h, controller, canRelaunch, outcomes, launches, lines } = await bringUpAll(BROKEN_SPECS, brokenRows)
    const up = h.p('Up Desk')
    const notUp = ['Creds Missing', 'Slack Refused', 'Dir Missing'].map((name) => h.p(name))
    expect(outcomes).toEqual({ 'Up Desk': 'up', 'Creds Missing': 'broken', 'Slack Refused': 'broken', 'Dir Missing': 'retrying' })
    // Neither local failure opened a Slack connection (SR-6.4).
    expect([h.manager.status(notUp[0].key), h.manager.status(notUp[2].key)]).toEqual([undefined, undefined])

    const { calls, tick } = startSteppedTicks(() => buildPersonaWorkList(h.config!, canRelaunch))
    for (let i = 0; i < 3; i++) await tick()

    // Only the up persona reached any tick step, once per tick.
    expect(calls.pending).toEqual([up.key, up.key, up.key])
    expect(calls.atCap).toEqual([up.key, up.key, up.key])
    expect(calls.stat).toEqual([up.working_directory, up.working_directory, up.working_directory])
    expect(calls.alive).toEqual([up.key, up.key, up.key])
    expect(calls.scheduled).toEqual([up.key, up.key, up.key])
    // No outage flag and no notice for anyone: Dir Missing's absent directory
    // raised no cwd-unreachable, and nothing reached Slack (SR-7.2).
    for (const p of [up, ...notUp]) expect(getOutageFlags(p.key).size).toBe(0)
    expect(notices).toEqual([])
    // The tick left every outcome as it was; no retry launched anyone.
    expect(notUp.map((p) => controller.state(p.key)?.outcome)).toEqual(['broken', 'broken', 'retrying'])
    expect(launches).toEqual([])
    assertNoLeak({ lines, managerLines: h.lines, calls })
  })

  test('a directory-retrying persona is excluded until its directory retry brings it up, then the next tick checks it; the broken ones stay out', async () => {
    const { h, controller, canRelaunch, launches, lines } = await bringUpAll(BROKEN_SPECS, brokenRows)
    const up = h.p('Up Desk')
    const retrying = h.p('Dir Missing')

    const { calls, tick } = startSteppedTicks(() => buildPersonaWorkList(h.config!, canRelaunch))
    await tick()
    // First re-check (5 s on the SR-3.2 schedule): still missing, still retrying.
    await h.clock.advance(5_000)
    expect(controller.state(retrying.key)?.outcome).toBe('retrying')
    await tick()
    expect(calls.scheduled).toEqual([up.key, up.key])

    // The directory appears; the next re-check (10 s later) brings it up and
    // the controller launches it from its own retry, not from the tick.
    mkdirSync(retrying.working_directory, { recursive: true })
    await h.clock.advance(10_000)
    expect(controller.isUp(retrying.key)).toBe(true)
    expect(launches).toEqual([retrying.key])

    await tick()
    expect(calls.scheduled).toEqual([up.key, up.key, up.key, retrying.key])
    expect(calls.stat.slice(2)).toEqual([up.working_directory, retrying.working_directory])
    expect(new Set(calls.alive)).toEqual(new Set([up.key, retrying.key]))
    expect(getOutageFlags(retrying.key).size).toBe(0)
    expect(notices).toEqual([])
    assertNoLeak({ lines, managerLines: h.lines, calls })
  })

  test('SR-11: an up persona whose directory vanishes after it came up keeps today\'s path — cwd-unreachable raised once with a notice, restarts scheduled, then skipped at cap; no directory retry opens', async () => {
    let capped = false
    const { h, controller, canRelaunch, launches, lines } = await bringUpAll(['Up Desk'])
    const up = h.p('Up Desk')
    expect(controller.isUp(up.key)).toBe(true)
    const pendingBefore = h.clock.pendingCount()

    rmSync(up.working_directory, { recursive: true, force: true })
    const { calls, tick } = startSteppedTicks(() => buildPersonaWorkList(h.config!, canRelaunch), () => capped)
    await tick()
    await tick()

    // Still in the work list; stat fails, the flag is raised under its key
    // with its directory, one onset notice across ticks, and each tick hands
    // it to restart (whose backoff and counter apply).
    expect(calls.stat).toEqual([up.working_directory, up.working_directory])
    expect(getOutageFlags(up.key).has('cwd-unreachable')).toBe(true)
    expect(notices).toEqual([{ key: up.key, text: ONSET_TEMPLATES['cwd-unreachable'](up.working_directory) }])
    expect(calls.scheduled).toEqual([up.key, up.key])

    // At the restart cap the tick skips it, as for any capped persona.
    capped = true
    await tick()
    expect(calls.atCap).toEqual([up.key, up.key, up.key])
    expect(calls.stat).toHaveLength(2)
    expect(calls.scheduled).toEqual([up.key, up.key])

    // The bring-up controller never took it over: still up, no directory
    // cause, no re-check timer, no retry launch.
    expect(controller.state(up.key)).toEqual({ outcome: 'up', causes: {} })
    expect(h.clock.pendingCount()).toBe(pendingBefore)
    expect(launches).toEqual([])
    assertNoLeak({ lines, managerLines: h.lines, calls })
  })
})
