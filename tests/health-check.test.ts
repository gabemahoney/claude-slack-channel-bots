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
  _runHealthCheckTickForTest,
  buildPersonaWorkList,
  forgetDisconnectedStreak,
  healthCheckAtCapSkipLine,
  type HealthCheckDeps,
} from '../src/health-check.ts'
import {
  _resetOutageState,
  initOutageState,
  getOutageFlags,
  setOutageFlag,
  clearOutageFlag,
  resetAllToHealthy,
  ONSET_TEMPLATES,
  ALL_CLEAR_TEMPLATE,
  adConfigMalformedOnset,
} from '../src/outage-state.ts'
import type { Client } from 'agent-director'
import { _buildIsSessionAliveAdapter, _buildStatRouteImpl } from '../src/server.ts'
import { resetClientForTests, setClientForTests } from '../src/agent-director-client.ts'
import { personaInstanceId } from '../src/persona-identity.ts'
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
  setConflictLatch,
  setConfiguredPersonaQuery,
  _resetConfiguredPersonaQuery,
  setSessionNotifier,
} from '../src/session-manager.ts'
import {
  LATCH_CASE_LAUNCH_START_NOT_RECORDED,
  bindConflictNotice,
  createConflictLatch,
  launchStartNotRecordedNoticeText,
  type ConflictLatch,
  type ConflictLatchRecord,
} from '../src/conflict-latch.ts'
import { describeAdFailureForLog } from '../src/ad-error-class.ts'
import { createPersonaEpisodes } from '../src/persona-episodes.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { NO_LAUNCH_START_FORMS, UNUSABLE_NAME_CASE_ROWS, launchStartRecord } from './test-helpers/conflict-cases.ts'
import { createPersonaRelaunchGate } from '../src/persona-start.ts'
import {
  AGENT_DIRECTOR_DEAD_STATES,
  AGENT_DIRECTOR_PENDING_STATE,
  LIVENESS_LIVE,
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
import {
  SAMPLE_LAUNCH_START_FRACTIONAL,
  SAMPLE_LAUNCH_START_WHOLE,
  cannedStatusResult,
  errConfigMalformed,
  errInternal,
  errSpawnNotFound,
  makeStubClient,
} from './test-helpers/agent-director-stub.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_INTERVAL_S = 0.01  // the interval the arming cases pass to startHealthCheck

// ---------------------------------------------------------------------------
// Driving ticks
//
// No case here waits on the real interval. Each tick body runs through the
// module's test seam (`_runHealthCheckTickForTest`, the body the interval
// runs) and is awaited to its end, so a case drives exactly the ticks it
// needs. The cases about `startHealthCheck` itself catch the interval it arms
// (`armedIntervals`) and run its callback by hand.
// ---------------------------------------------------------------------------

/** Run `n` tick bodies with the installed deps, one after another, each awaited to its end. */
async function driveTicks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await _runHealthCheckTickForTest()
}

/**
 * Run `arm` with the global `setInterval` swapped for a recorder, restored
 * before this returns, and answer every interval it set (callback and
 * period), none of them scheduled.
 */
function armedIntervals(arm: () => void): Array<{ callback: () => unknown; ms: number }> {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = g.setInterval
  const armed: Array<{ callback: () => unknown; ms: number }> = []
  g.setInterval = (callback: () => unknown, ms: number) => {
    armed.push({ callback, ms })
    return 0
  }
  try {
    arm()
  } finally {
    g.setInterval = saved
  }
  return armed
}

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
  // sequence of observations across ticks (e.g. [false, true, false]) however
  // many ticks the case drives past its end. When the queue
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
  // b.jg5 SRJ-311: when set, `isRetryArmed` is present, answers this for every
  // persona and records each key asked (isRetryArmedCalls). Absent: the dep
  // is absent, as every case that leaves it alone expects.
  retryArmedResult?: boolean
  // b.jg5 SRJ-311: when true, `armRetryTimer` is present and records each arm
  // with the tick it came on (armRetryTimerCalls). Otherwise it is absent.
  recordRetryArms?: boolean
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
  /** b.jg5 SRJ-311: every key `isRetryArmed` was asked for (present only with `retryArmedResult`). */
  isRetryArmedCalls: string[]
  /** b.jg5 SRJ-311: every `armRetryTimer` call, with its tick number (present only with `recordRetryArms`). */
  armRetryTimerCalls: Array<{ key: string; tick: number }>
} {
  const scheduleRestartCalls: Array<{ key: string; cwd: string }> = []
  const isSessionAliveCalls: string[] = []
  const isSessionConnectedCalls: string[] = []
  const hasSessionStreamCalls: string[] = []
  const statRouteCalls: string[] = []
  const scheduleRestartAtConnectedCount: number[] = []
  const scheduleRestartAtStreamCount: number[] = []
  const isRetryArmedCalls: string[] = []
  const armRetryTimerCalls: Array<{ key: string; tick: number }> = []
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
    isRetryArmedCalls,
    armRetryTimerCalls,

    ...(opts.retryArmedResult === undefined ? {} : {
      isRetryArmed(key: string) {
        isRetryArmedCalls.push(key)
        return opts.retryArmedResult!
      },
    }),
    ...(opts.recordRetryArms === true ? {
      armRetryTimer(key: string) {
        armRetryTimerCalls.push({ key, tick: ticks })
      },
    } : {}),

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
// The tick body: dead-session detection, the skips, per-persona error
// isolation and shutdown, each driven through the tick seam.
// ---------------------------------------------------------------------------

describe('the tick body: dead-session detection, skips, per-persona error isolation and shutdown', () => {
  test('1. normal dead-session detection — scheduleRestart called for dead session', async () => {
    const deps = makeDeps()  // isSessionAlive reads dead by default; statRoute defaults to true
    initHealthCheck(deps)

    await driveTicks(1)

    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }])
  })

  test('2a. skip pending — restart timer scheduled, not yet fired → scheduleRestart never called', async () => {
    const deps = makeDeps({ isRestartPendingResult: true })
    initHealthCheck(deps)

    await driveTicks(3)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
  })

  test('2b. skip active launch — launchSession in progress → scheduleRestart never called', async () => {
    const deps = makeDeps({ isActiveLaunchingResult: true })
    initHealthCheck(deps)

    await driveTicks(3)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
  })

  test('3. skip alive — isSessionAlive reads live → scheduleRestart never called', async () => {
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
    initHealthCheck(deps)

    await driveTicks(3)

    expect(deps.scheduleRestartCalls).toHaveLength(0)
  })

  test('5. transient error isolation — one persona throws, other personas still restarted', async () => {
    const deps = makeDeps({
      personas: workList('failing_bot', 'dead_bot'),
      throwOnKey: 'failing_bot',
      isSessionAliveResult: LIVENESS_READING_DEAD,
    })
    initHealthCheck(deps)

    await driveTicks(1)

    expect(deps.scheduleRestartCalls.map((c) => c.key)).toEqual(['dead_bot'])
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
      await driveTicks(1)
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

  test('7. shutdown halts cycles — isShuttingDown true → no checks run', async () => {
    const deps = makeDeps({ isShuttingDownResult: true })
    initHealthCheck(deps)

    await driveTicks(3)

    expect(deps.isSessionAliveCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// startHealthCheck: the interval it arms (caught by `armedIntervals`).
// ---------------------------------------------------------------------------

describe('startHealthCheck', () => {
  test('6. zero interval disables poller — no interval armed, isSessionAlive never called', () => {
    const deps = makeDeps()
    initHealthCheck(deps)

    expect(armedIntervals(() => startHealthCheck(0))).toEqual([])

    expect(deps.isSessionAliveCalls).toHaveLength(0)
  })

  // T26: Health check starts only after sessions.json is written.
  // Architectural invariant enforced in server.ts: startHealthCheck() is called
  // only after startupSessionManager() returns and writeSessions() completes.
  // The unit-level guarantee is that initHealthCheck() alone does NOT start the
  // poller — the poller only starts when startHealthCheck() is explicitly called.
  test('T26: initHealthCheck alone does not start poller — no interval armed, isSessionAlive not called until startHealthCheck is invoked', () => {
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_DEAD })

    // Deliberately do NOT call startHealthCheck — simulate the window between
    // initHealthCheck (called before startup) and startHealthCheck (called after
    // writeSessions completes).
    expect(armedIntervals(() => initHealthCheck(deps))).toEqual([])

    expect(deps.isSessionAliveCalls).toHaveLength(0)
  })

  test('T26: poller starts once startHealthCheck is called after writeSessions phase — one interval at the given period, whose callback runs a tick body', async () => {
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE })
    initHealthCheck(deps)

    // Simulate the writeSessions phase completing — then start health check
    const armed = armedIntervals(() => startHealthCheck(FAST_INTERVAL_S))
    expect(armed.map((a) => a.ms)).toEqual([FAST_INTERVAL_S * 1000])
    expect(deps.isSessionAliveCalls).toHaveLength(0)
    // The callback answers the tick body's promise; one firing is one body.
    await armed[0]!.callback()

    // The one firing ran one tick body, which probed the persona once.
    expect(deps.isSessionAliveCalls).toEqual([KEY])
    expect(deps.tickCount()).toBe(1)
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

    await driveTicks(3)

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

    await driveTicks(3)

    expect(getOutageFlags(KEY).has('cwd-unreachable')).toBe(true)
    // The stat target is the persona's working directory, and the one onset
    // (deduped across ticks) carries it as detail, raised for the persona key.
    expect(deps.statRouteCalls).toEqual([WD, WD, WD])
    expect(notices).toEqual([{ key: KEY, text: ONSET_TEMPLATES['cwd-unreachable'](WD) }])
  })

  test('(c) scheduleRestart is called when isSessionAlive reads dead', async () => {
    const deps = makeDeps({ statRouteResult: true, isSessionAliveResult: LIVENESS_READING_DEAD })
    initHealthCheck(deps)

    await driveTicks(1)

    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }])
  })

  test('(d) tick-in-flight guard: 5th consecutive skip emits exactly one warning', async () => {
    // statRoute never resolves — first tick body hangs forever, all subsequent
    // ticks hit the tickInFlight guard and increment skippedTicks. The hung
    // body is never awaited; the next case's reset clears its in-flight mark.
    const deps = makeDeps({ statRouteHangs: true })
    initHealthCheck(deps)

    const capturedErrors: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map(a => String(a)).join(' '))
    }
    const warnings = () => capturedErrors.filter(e =>
      e.includes('tick body in flight; skipped 5 consecutive ticks'),
    )

    let afterFourSkips: string[]
    try {
      void _runHealthCheckTickForTest()  // starts the hung body
      await driveTicks(4)
      afterFourSkips = warnings()
      // The 5th skip, then 14 more.
      await driveTicks(15)
    } finally {
      console.error = origError
    }

    expect(deps.tickCount()).toBe(1)
    expect(afterFourSkips).toEqual([])
    // Warning fires exactly once at the 4→5 skip boundary; further skips are silent.
    expect(warnings()).toHaveLength(1)
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

    await driveTicks(3)

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

    await driveTicks(1)

    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }])
  })

  // b.4q8: the tick's own liveness read can count the persona's resumed
  // launch as failed (its row ended before reporting in) and reach the cap;
  // the cap is asked again right after the read.
  test('b.4q8: a dead persona below the cap before the read and at it right after: the read is made, then the persona is skipped with one at-cap line and no scheduleRestart', async () => {
    const deps = makeDeps({
      atCapSequence: [false, true],
      isSessionAliveResult: LIVENESS_READING_DEAD,  // would trigger restart if not capped
      maxTicks: 1,
    })

    const lines = await capturingErrors(() => runTicks(deps, 1))

    expect(deps.isSessionAliveCalls).toEqual([KEY])
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(lines).toEqual([healthCheckAtCapSkipLine(KEY)])
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
    await driveTicks(2)

    // dead_bot (not capped, dead) is probed and scheduled on each of the two
    // ticks; capped_bot is skipped before the probe, so never probed or
    // scheduled.
    expect(scheduleRestartCalls.map((c) => c.key)).toEqual(['dead_bot', 'dead_bot'])
    expect(isSessionAliveCalls).toEqual(['dead_bot', 'dead_bot'])
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

    await driveTicks(4)

    // A stranded alive-but-disconnected persona IS scheduled within a bounded
    // number of ticks — no inbound message, no server restart (AC 2/5).
    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }, { key: KEY, cwd: WD }])
    // Each fire happened on the 2nd disconnected observation of its streak,
    // never the 1st (AC 6 debounce): connected-call-counts 2 and 4.
    expect(deps.scheduleRestartAtConnectedCount).toEqual([2, 4])
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

    await driveTicks(6)

    // No two CONSECUTIVE disconnected observations ever occurred.
    expect(deps.scheduleRestartCalls).toHaveLength(0)
    // Anti-vacuity: prove the ticks actually ran through the scripted sequence
    // (the post-reset fresh blip was genuinely observed, not skipped).
    expect(deps.isSessionConnectedCalls).toHaveLength(6)
  })

  test('3. streak dropped on fire: after scheduling on tick 2, streak resets (next fire needs 2 more)', async () => {
    // Persistently disconnected. Since the scheduleRestart stub does NOT set
    // isRestartPendingOrActive, ticks keep running. The streak is consumed on
    // fire, so fires land on the 2nd, 4th, 6th... disconnected observation —
    // never on consecutive observations. This exercises the `disconnectedStreak
    // .delete` on the schedule branch.
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: false })
    initHealthCheck(deps)

    await driveTicks(6)

    // The fires are at connected-call-counts 2, 4 and 6: the streak was
    // dropped after each fire and had to re-accumulate two observations.
    expect(deps.scheduleRestartAtConnectedCount).toEqual([2, 4, 6])
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

    await driveTicks(3)

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

    await driveTicks(3)

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

    await driveTicks(2)

    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }, { key: KEY, cwd: WD }])
    // Dead path does not consult isSessionConnected: count stays 0 at each fire.
    expect(deps.scheduleRestartAtConnectedCount).toEqual([0, 0])
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

    await driveTicks(3)

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
      // one tick, so exactly one disconnected observation — leaves streak at 1
      connectedSequence: { [KEY]: [false, true] },
    })
    initHealthCheck(deps1)
    await driveTicks(1)
    expect(deps1.scheduleRestartCalls).toHaveLength(0)
    // Anti-vacuity: the phase-1 run must actually have observed the persona
    // once (accumulating the streak of 1) — otherwise the reset below would be
    // clearing nothing and the test would pass vacuously.
    expect(deps1.isSessionConnectedCalls).toEqual([KEY])

    _resetHealthCheckState()

    // Fresh run: one disconnected observation then connected. If the streak had
    // leaked (still 1), this single false would reach 2 and fire. It must not.
    const deps2 = makeDeps({
      isSessionAliveResult: LIVENESS_READING_LIVE,
      connectedSequence: { [KEY]: [false, true] },
    })
    initHealthCheck(deps2)
    await driveTicks(2)

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

    await driveTicks(4)

    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }])
    // Fire required TWO fresh post-skip observations — the pre-skip streak did
    // not carry across the restart cycle.
    expect(deps.scheduleRestartAtConnectedCount).toEqual([3])
  })

  test('11. streak cleared on cap-skip: a pre-cap disconnected tick does NOT carry across the cap window', async () => {
    // Analogous to test 10 for the isAtCap skip. The cap skip also clears the
    // streak, so a fresh uncapped observation starts a new consecutive count.
    // A tick that reaches the liveness read asks the cap twice, before the
    // read and right after it (b.4q8); a tick capped before the read, once.
    //   tick1: cap=false, false → !connected → streak=1 (connected call 1)
    //   tick2: cap=true         → SKIP (streak cleared; no connected probe)
    //   tick3: cap=false, false → !connected → fresh streak=1 (call 2)
    //   tick4: cap=false, false → !connected → streak=2 → FIRE (call 3)
    const deps = makeDeps({
      isSessionAliveResult: LIVENESS_READING_LIVE,
      isSessionConnectedResult: false,
      atCapSequence: [false, false, true, false],  // last (false) repeats
    })
    initHealthCheck(deps)

    await driveTicks(4)

    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }])
    // Two fresh post-cap observations were required — the pre-cap streak of 1
    // was cleared by the cap skip rather than carried across.
    expect(deps.scheduleRestartAtConnectedCount).toEqual([3])
  })

  test('11b. b.4q8: streak cleared on a cap-skip after the read: a tick whose own liveness read took the persona to the cap does NOT carry a pre-cap streak across', async () => {
    // As test 11, but the cap is met by the cap asked right after tick 2's
    // read (the read counted the persona's resumed launch as failed).
    //   tick1: cap=false, false → !connected → streak=1 (connected call 1)
    //   tick2: cap=false, true  → read made, then SKIP (streak cleared; no connected probe)
    //   tick3: cap=false, false → !connected → fresh streak=1 (call 2)
    //   tick4: cap=false, false → !connected → streak=2 → FIRE (call 3)
    const deps = makeDeps({
      isSessionAliveResult: LIVENESS_READING_LIVE,
      isSessionConnectedResult: false,
      atCapSequence: [false, false, false, true, false],  // last (false) repeats
    })

    const lines = await capturingErrors(() => runTicks(deps, 4))

    expect(deps.isSessionAliveCalls).toEqual([KEY, KEY, KEY, KEY])
    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }])
    // Two fresh observations after the skip were required: the pre-cap streak
    // of 1 was cleared by the skip after the read rather than carried across.
    expect(deps.scheduleRestartAtConnectedCount).toEqual([3])
    expect(lines.filter((line) => line === healthCheckAtCapSkipLine(KEY))).toHaveLength(1)
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

    await driveTicks(4)

    // Anti-vacuity: tick 2 ran without DROP (not probed), STAY probed on every tick.
    expect(deps.isSessionConnectedCalls).toEqual([DROP, STAY, STAY, DROP, STAY, DROP, STAY])
    expect(deps.scheduleRestartCalls).toEqual([{ key: DROP, cwd: full[DROP] }])
    // Two fresh observations after it came back were required — no reconnect
    // or restart was scheduled on the first one.
    expect(deps.scheduleRestartAtConnectedCount).toEqual([3])
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

    await driveTicks(4)

    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }, { key: KEY, cwd: WD }])
    // Each fire landed on the 2nd streamless observation of its streak, never the 1st.
    expect(deps.scheduleRestartAtStreamCount).toEqual([2, 4])
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

    await driveTicks(6)

    // No two CONSECUTIVE streamless observations ever occurred — the healthy
    // (stream-present) branch cleared the streak each time.
    expect(deps.scheduleRestartCalls).toHaveLength(0)
    // Anti-vacuity: the scripted sequence was actually observed, once per tick.
    expect(deps.hasSessionStreamCalls).toHaveLength(6)
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

    await driveTicks(6)

    // Proof of short-circuit: the stream probe was never consulted for the persona.
    expect(deps.hasSessionStreamCalls).toHaveLength(0)
    // The disconnected session was recovered on the 2nd, 4th and 6th
    // CONNECTED observations: the shared streak is consumed on fire and must
    // re-accumulate two observations.
    expect(deps.scheduleRestartAtConnectedCount).toEqual([2, 4, 6])
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
    await driveTicks(1)

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
    await driveTicks(2)

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

/** Install `deps` and run `n` tick bodies through the seam, each awaited to its end; `deps` must have begun exactly `n`. */
async function runTicks(deps: ReturnType<typeof makeDeps>, n: number): Promise<void> {
  initHealthCheck(deps)
  await driveTicks(n)
  expect(deps.tickCount()).toBe(n)
}

/** Run `fn` with console.error captured; answers the lines it logged. */
async function capturingErrors(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const saved = console.error
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  try { await fn() } finally { console.error = saved }
  return lines
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
// launch in flight) owns its session: the tick still reads the persona but
// makes no attempt of its own for it (b.jg5 SRJ-315; the full rule is pinned
// in the SRJ-315 describe below). With session_restart_delay 0, scheduleRestart only logs and
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

  test('a persona whose launch is in flight is still stat\'d and probed but not scheduled (b.jg5 SRJ-315), and its streak does not carry across the launch', async () => {
    //   tick1: not in flight → alive && !connected → streak 1 (connected call 1)
    //   tick2: in flight     → stat'd and probed (call 2), no attempt, streak cleared
    //   tick3: → fresh streak 1 (call 3); tick4: → streak 2 → scheduled (call 4)
    // A streak kept or advanced across tick 2 would schedule at call 3 (or 2).
    const deps = makeDeps({ isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: false, maxTicks: 4 })
    const inFlight = [false, true, false, false]
    const asked: string[] = []
    deps.isLaunchInFlight = (key) => inFlight[Math.min(asked.push(key) - 1, inFlight.length - 1)]!

    await runTicks(deps, 4)

    expect(asked).toEqual([KEY, KEY, KEY, KEY])
    expect(deps.statRouteCalls).toEqual([WD, WD, WD, WD])
    expect(deps.isSessionAliveCalls).toEqual([KEY, KEY, KEY, KEY])
    expect(deps.isSessionConnectedCalls).toEqual([KEY, KEY, KEY, KEY])
    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }])
    expect(deps.scheduleRestartAtConnectedCount).toEqual([4])
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

/**
 * Every tick reading that is not healthy (b.jg5 SRJ-310, SRJ-312), each row
 * scripting `persona`'s answers. It takes a name fixed when the table is
 * built, not the file's KEY: KEY is only set in beforeAll, after the table
 * exists.
 */
function notHealthyReadings(persona: string): Array<[string, DepsOpts]> {
  return [
    ['pending (no launch start), connected with its stream', { aliveSequence: { [persona]: [LIVENESS_READING_PENDING] } }],
    ['pending (a launch start), connected with its stream', { aliveSequence: { [persona]: [pendingLivenessReading(SAMPLE_LAUNCH_START_WHOLE)] } }],
    ['unknown', { aliveSequence: { [persona]: [LIVENESS_READING_UNKNOWN] } }],
    ['a thrown probe', { aliveSequence: { [persona]: [new Error('simulated status failure')] } }],
    ['dead', { aliveSequence: { [persona]: [LIVENESS_READING_DEAD] } }],
    ['live but disconnected', { isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: false }],
    ['live and connected but streamless', { isSessionAliveResult: LIVENESS_READING_LIVE, hasSessionStreamResult: false }],
  ]
}

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

  test.each(notHealthyReadings(P))('%s: over two ticks the hook is never called', async (_label, opts) => {
    const deps = makeDeps({ personas: workList(P), ...opts, maxTicks: 2 })
    const ended: string[] = []
    deps.endTmuxUnresponsive = (key) => void ended.push(key)

    await runTicks(deps, 2)

    expect(deps.isSessionAliveCalls).toEqual([P, P])
    expect(ended).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-311, SRJ-312 — the healthy branch clears tmux-unavailable
//
// A tick that finds the persona `live`, connected and with its stream clears
// its `tmux-unavailable` outage through the real outage state: one all-clear
// over its bad stretch when that empties its flags, and the cleared-flag
// observer told once with the class and the tick's `live` reading (production
// binds the observer to the retry timer's condition-end entry; the binding is
// pinned in tests/server-startup-wiring.test.ts). `pending` (never healthy),
// `unknown`, a thrown probe, `dead`, and a live session that is disconnected
// or connected but streamless leave it raised and post nothing. Another
// persona's flag is never touched. The flag is raised with no detail, as the
// wrappers raise it.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-312: a live, connected tick with its stream clears the persona\'s tmux-unavailable outage', () => {
  const P = 'healed_bot'
  const B = 'other_bot'

  /** The cleared-flag observer's calls during the current test, in order. */
  let cleared: Array<[string, string, string | undefined]>

  beforeEach(() => {
    // The file's capturing notice hook, plus a recording cleared-flag observer.
    cleared = []
    initOutageState({
      notify: (key, text) => { notices.push({ key, text }) },
      getClient: () => null as any,
      onFlagCleared: (key, cls, reading) => { cleared.push([key, cls, reading]) },
    })
  })

  test('P live, connected and with its stream, beside B live but disconnected with its flag raised: over two ticks P\'s flag clears once with one all-clear over its history and the live reading told to the observer; B\'s stays raised', async () => {
    // B is checked first, so a clear made with the wrong persona's key would
    // lower B's flag and leave P's raised.
    setOutageFlag(B, 'tmux-unavailable')
    setOutageFlag(P, 'tmux-unavailable')
    const deps = makeDeps({
      personas: workList(B, P),
      aliveSequence: { [B]: [LIVENESS_READING_LIVE], [P]: [LIVENESS_READING_LIVE] },
      connectedSequence: { [B]: [false], [P]: [true] },
      maxTicks: 2,
    })

    await runTicks(deps, 2)

    expect(deps.isSessionAliveCalls).toEqual([B, P, B, P])
    expect(getOutageFlags(P).has('tmux-unavailable')).toBe(false)
    expect(getOutageFlags(B).has('tmux-unavailable')).toBe(true)
    expect(notices).toEqual([
      { key: B, text: ONSET_TEMPLATES['tmux-unavailable']() },
      { key: P, text: ONSET_TEMPLATES['tmux-unavailable']() },
      { key: P, text: ALL_CLEAR_TEMPLATE(new Map([['tmux-unavailable', { detail: undefined }]])) },
    ])
    expect(cleared).toEqual([[P, 'tmux-unavailable', LIVENESS_LIVE]])
  })

  test('with ad-unreachable also raised for P: the healthy tick lowers only tmux-unavailable, posts no all-clear, and tells the observer with the live reading', async () => {
    setOutageFlag(P, 'ad-unreachable')
    setOutageFlag(P, 'tmux-unavailable')
    const deps = makeDeps({ personas: workList(P), isSessionAliveResult: LIVENESS_READING_LIVE, maxTicks: 1 })

    await runTicks(deps, 1)

    expect([...getOutageFlags(P)]).toEqual(['ad-unreachable'])
    expect(notices).toEqual([
      { key: P, text: ONSET_TEMPLATES['ad-unreachable']() },
      { key: P, text: ONSET_TEMPLATES['tmux-unavailable']() },
    ])
    expect(cleared).toEqual([[P, 'tmux-unavailable', LIVENESS_LIVE]])
  })

  test.each(notHealthyReadings(P))('%s: over two ticks the flag stays raised, nothing is posted after its onset and the observer is never told', async (_label, opts) => {
    setOutageFlag(P, 'tmux-unavailable')
    const deps = makeDeps({ personas: workList(P), ...opts, maxTicks: 2 })

    await runTicks(deps, 2)

    expect(deps.isSessionAliveCalls).toEqual([P, P])
    expect(getOutageFlags(P).has('tmux-unavailable')).toBe(true)
    expect(notices).toEqual([{ key: P, text: ONSET_TEMPLATES['tmux-unavailable']() }])
    expect(cleared).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-610 — a live healthy tick resets the persona's slow-recovery count
//
// A tick that finds the persona `live`, connected and with its stream calls
// `resetSlowRecoveryCount(key)` for that persona, last in the healthy branch,
// after the tmux-unavailable clear (production binds it to the slow-recovery
// tracker's `noteHealthy`; the binding is pinned in
// tests/server-startup-wiring.test.ts, and what the tracker does in
// tests/slow-recovery.test.ts). `pending` (never healthy), `unknown`, a
// thrown probe, `dead`, and a live session that is disconnected or connected
// but streamless never call it. A throwing hook is the persona's error for
// the tick: logged, and the tick goes on to the next persona. Every other
// case in this file leaves the hook at its default (absent).
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-610: a live, connected tick with its stream resets the persona\'s slow-recovery count', () => {
  const P = 'healed_bot'
  const Q = 'healthy_bot'
  const B = 'other_bot'

  test.each(notHealthyReadings(B))('P and Q live, connected and with their streams, beside B %s, over two ticks: the hook is called once per healthy persona per tick, never for B', async (_label, opts) => {
    // B is checked first, so a hook fired with the wrong persona's key would
    // show B's key. B's reading, scripted per persona; P and Q read live and
    // are connected with their streams (the defaults).
    const deps = makeDeps({
      personas: workList(B, P, Q),
      aliveSequence: {
        [B]: opts.aliveSequence?.[B] ?? [opts.isSessionAliveResult!],
        [P]: [LIVENESS_READING_LIVE],
        [Q]: [LIVENESS_READING_LIVE],
      },
      connectedSequence: { [B]: [opts.isSessionConnectedResult ?? true] },
      streamSequence: { [B]: [opts.hasSessionStreamResult ?? true] },
      maxTicks: 2,
    })
    const reset: string[] = []
    deps.resetSlowRecoveryCount = (key) => void reset.push(key)

    await runTicks(deps, 2)

    expect(deps.isSessionAliveCalls).toEqual([B, P, Q, B, P, Q])
    expect(reset).toEqual([P, Q, P, Q])
  })

  test('the hook is called on every tick that finds the persona live and deliverable, and on no other, after the tick clears its tmux-unavailable outage', async () => {
    //   tick 1: live, deliverable            → called
    //   tick 2: pending, deliverable         → not called
    //   tick 3: live, disconnected           → not called
    //   tick 4: live, deliverable            → called
    const order: string[] = []
    initOutageState({
      notify: (key, text) => { notices.push({ key, text }) },
      getClient: () => null as any,
      onFlagCleared: (key) => void order.push(`cleared ${key}`),
    })
    setOutageFlag(KEY, 'tmux-unavailable')
    const deps = makeDeps({
      aliveSequence: { [KEY]: [LIVENESS_READING_LIVE, LIVENESS_READING_PENDING, LIVENESS_READING_LIVE, LIVENESS_READING_LIVE] },
      connectedSequence: { [KEY]: [true, true, false, true] },
      maxTicks: 4,
    })
    deps.endNotConnectedEpisode = (key) => void order.push(`not-connected ${key}`)
    deps.endTmuxUnresponsive = (key) => void order.push(`unresponsive ${key}`)
    deps.resetSlowRecoveryCount = (key) => void order.push(`reset ${key} at tick ${deps.isSessionAliveCalls.length}`)

    await runTicks(deps, 4)

    expect(order).toEqual([
      `not-connected ${KEY}`,
      `unresponsive ${KEY}`,
      `cleared ${KEY}`,
      `reset ${KEY} at tick 1`,
      `not-connected ${KEY}`,
      `unresponsive ${KEY}`,
      `reset ${KEY} at tick 4`,
    ])
  })

  test('a throwing hook is logged once per tick as the persona\'s error, described and redacted; the tick goes on to the next persona, and the next tick runs', async () => {
    // P is checked first; B, read dead after it, is still scheduled each tick.
    const personas = workList(P, B)
    const deps = makeDeps({
      personas,
      aliveSequence: { [P]: [LIVENESS_READING_LIVE], [B]: [LIVENESS_READING_DEAD] },
      maxTicks: 2,
    })
    const thrown = Object.assign(new Error(`reset refused (${sentinelInMessage('reset')})`), { note: LEAK_SENTINEL })
    const reset: string[] = []
    deps.resetSlowRecoveryCount = (key) => {
      reset.push(key)
      throw thrown
    }
    const errArgs: unknown[][] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errArgs.push(args) }
    try {
      await runTicks(deps, 2)
    } finally {
      console.error = orig
    }

    expect(reset).toEqual([P, P])
    expect(deps.scheduleRestartCalls).toEqual([{ key: B, cwd: personas[B] }, { key: B, cwd: personas[B] }])
    const lines = errArgs.filter((args) => String(args[0]).includes(`persona=${P}`))
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line).toHaveLength(1)
      expect(String(line[0])).toStartWith(`[slack] health-check: error checking persona=${P}: Error message="reset refused (${REDACTED_SENTINEL_TAIL})" at `)
    }
    assertNoLeak({ errArgs, notices })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-312, SRJ-314, SRJ-316 — a CONFIG answer at the health tick
//
// On the tick's path only the real liveness adapter raises and clears
// `ad-config-malformed`, so these cases plug `_buildIsSessionAliveAdapter`
// over the stub client into the deps' liveness read. A CONFIG answer
// (`ErrConfigMalformed`) reads `unknown`, so the tick skips P (SRJ-314): one
// onset for the episode, nothing scheduled and no not-connected notice
// (SRJ-316). A `status` that succeeds, or that answers `ErrSpawnNotFound`,
// clears it with one all-clear listing the bare class (SRJ-312). B, read dead
// beside P, is scheduled on every tick and never flagged.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-316: a CONFIG answer at the health tick', () => {
  const P = 'config_bot'
  const B = 'other_bot'
  const CONFIG = errConfigMalformed()
  const ONSET = adConfigMalformedOnset(CONFIG)
  const ALL_CLEAR = ALL_CLEAR_TEMPLATE(new Map([['ad-config-malformed', { detail: undefined }]]))
  const DEAD_ROW = cannedStatusResult({ state: [...AGENT_DIRECTOR_DEAD_STATES][0]! })

  afterEach(() => {
    resetClientForTests()
  })

  /**
   * The file's deps, their liveness read the real adapter over a stub client:
   * P's `status` answers `pAnswers` in order (the last repeats), B's reads a
   * dead row. Auto-restart disabled, recording each not-connected notice asked for.
   */
  function configDeps(pAnswers: Array<Error | ReturnType<typeof cannedStatusResult>>, opts: DepsOpts) {
    const config = makeMultiPersonaConfig([{ name: P }, { name: B }], baseDir)
    let pCalls = 0
    setClientForTests(makeStubClient({
      statusFn: ({ claude_instance_id }) => claude_instance_id === personaInstanceId(P)
        ? pAnswers[Math.min(pCalls++, pAnswers.length - 1)]!
        : DEAD_ROW,
    }) as unknown as Client)
    const adapter = _buildIsSessionAliveAdapter(() => config)
    const personas = buildPersonaWorkList(config)
    const deps = makeDeps({ personas, ...opts })
    deps.isSessionAlive = (key) => {
      deps.isSessionAliveCalls.push(key)
      return adapter(key)
    }
    deps.isAutoRestartDisabled = () => true
    const notified: string[] = []
    deps.notifyNotConnected = (key) => void notified.push(key)
    return { deps, notified, personas }
  }

  test('CONFIG on every tick: one onset for P and its flag kept raised, nothing scheduled for P, no not-connected notice; B, read dead, is scheduled on each tick with no flag', async () => {
    // P's session is disconnected: read live, tick 2 would schedule P and ask
    // for the notice (auto-restart disabled); read dead, tick 1 would.
    const { deps, notified, personas } = configDeps([CONFIG], { connectedSequence: { [P]: [false] }, maxTicks: 3 })

    const lines = await capturingErrors(() => runTicks(deps, 3))

    expect(deps.isSessionAliveCalls).toEqual([P, B, P, B, P, B])
    const scheduledB = { key: B, cwd: personas[B]! }
    expect(deps.scheduleRestartCalls).toEqual([scheduledB, scheduledB, scheduledB])
    expect(notified).toEqual([])
    expect(deps.isSessionConnectedCalls).toEqual([])
    expect(notices).toEqual([{ key: P, text: ONSET }])
    expect([...getOutageFlags(P)]).toEqual(['ad-config-malformed'])
    expect([...getOutageFlags(B)]).toEqual([])
    expect(lines.filter((line) => line.startsWith(`[slack] health-check: liveness unknown for persona=${P}`))).toHaveLength(3)
    assertNoLeak({ lines, notices })
  })

  test.each<[string, Error | ReturnType<typeof cannedStatusResult>, boolean]>([
    ['a status that succeeds with P live, connected and with its stream', cannedStatusResult(), false],
    ['a status answering ErrSpawnNotFound', errSpawnNotFound(), true],
  ])('with the flag raised by a CONFIG tick, %s on the next tick clears it with one all-clear', async (_label, answer, readDead) => {
    const { deps, notified, personas } = configDeps([CONFIG, answer], { maxTicks: 2 })

    const lines = await capturingErrors(() => runTicks(deps, 2))

    expect(deps.isSessionAliveCalls).toEqual([P, B, P, B])
    expect([...getOutageFlags(P)]).toEqual([])
    expect(notices).toEqual([{ key: P, text: ONSET }, { key: P, text: ALL_CLEAR }])
    // Nothing for P on the CONFIG tick; a dead reading after the clear schedules at once.
    const scheduledB = { key: B, cwd: personas[B]! }
    expect(deps.scheduleRestartCalls).toEqual(
      readDead ? [scheduledB, { key: P, cwd: personas[P]! }, scheduledB] : [scheduledB, scheduledB],
    )
    expect(notified).toEqual([])
    assertNoLeak({ lines, notices })
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-315 — no attempt, still read
//
// While a persona is latched (`isLatched`, b.jg5 SRJ-502; checked first), is
// held on `ErrInvalidFlags` (`isHeld`, b.jg5 SRJ-207; checked next), has
// work in flight (`isLaunchInFlight`) or has its
// `tmux-unavailable` outage raised, the tick makes no attempt of its own for
// it: no `scheduleRestart` and no not-connected notice. It still runs the
// working-directory check and reads liveness, connection and stream, so a
// healthy persona takes the healthy branch (episode and tmux-unresponsive
// ended, tmux-unavailable cleared). Any other reading clears its streak. A
// restart pending or active, and the cap, still skip it before any read, and
// come first. The tick-end (onset) hook runs once per tick under every rule
// (pinned in the SRJ-308 cases below). Another persona under neither rule is
// checked as today. Under `tmux-unavailable` only, a tick that reads the
// persona not healthy with no retry timer armed (`isRetryArmed` false) arms
// one (`armRetryTimer`, b.jg5 SRJ-311; production binds both to the retry
// controller, pinned in tests/server-startup-wiring.test.ts).
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-315: no attempt, still read', () => {
  const P = 'held_bot'
  const B = 'other_bot'
  const ONSET = ONSET_TEMPLATES['tmux-unavailable']()
  const ALL_CLEAR = ALL_CLEAR_TEMPLATE(new Map([['tmux-unavailable', { detail: undefined }]]))

  type Deps = ReturnType<typeof makeDeps>
  /**
   * A no-attempt rule for P. With `active`, the rule holds on the ticks it
   * accepts (by tick number) and is lifted on the others; without it, it holds
   * from the start (`tmux-unavailable` is raised once, before the first tick,
   * so a healthy tick can clear it).
   */
  type NoAttemptRule = (deps: Deps, active?: (tick: number) => boolean) => void

  const inFlight: NoAttemptRule = (deps, active = () => true) => {
    deps.isLaunchInFlight = (key) => key === P && active(deps.tickCount())
  }
  const tmuxUnavailable: NoAttemptRule = (deps, active) => {
    if (active === undefined) {
      setOutageFlag(P, 'tmux-unavailable')
      return
    }
    // Raised or lowered at each tick body's start, before P's work.
    const getPersonas = deps.getPersonas
    deps.getPersonas = () => {
      const personas = getPersonas()
      const raised = getOutageFlags(P).has('tmux-unavailable')
      const holds = active(deps.tickCount())
      if (holds && !raised) setOutageFlag(P, 'tmux-unavailable')
      if (!holds && raised) clearOutageFlag(P, 'tmux-unavailable')
      return personas
    }
  }
  // b.jg5 SRJ-502: production binds `isLatched` to the server's latch
  // (pinned in tests/server-startup-wiring.test.ts); the tick only asks it.
  const latched: NoAttemptRule = (deps, active = () => true) => {
    deps.isLatched = (key) => key === P && active(deps.tickCount())
  }
  // b.jg5 SRJ-207: production binds `isHeld` to the server's ErrInvalidFlags
  // hold (pinned in tests/server-startup-wiring.test.ts); the tick only asks it.
  const held: NoAttemptRule = (deps, active = () => true) => {
    deps.isHeld = (key) => key === P && active(deps.tickCount())
  }
  const RULES: Array<[string, NoAttemptRule, boolean]> = [
    ['a launch in flight', inFlight, false],
    ['tmux-unavailable raised', tmuxUnavailable, true],
    ['P latched (b.jg5 SRJ-502)', latched, false],
    ['P held on ErrInvalidFlags (b.jg5 SRJ-207)', held, false],
  ]

  /** Auto-restart disabled, with every attempt-side and healthy-side hook recorded. */
  function recording(deps: Deps) {
    const notified: Array<[string, string]> = []
    const episodesEnded: string[] = []
    const conditionsEnded: string[] = []
    deps.isAutoRestartDisabled = () => true
    deps.notifyNotConnected = (key, why) => void notified.push([key, why])
    deps.endNotConnectedEpisode = (key) => void episodesEnded.push(key)
    deps.endTmuxUnresponsive = (key) => void conditionsEnded.push(key)
    return { notified, episodesEnded, conditionsEnded }
  }

  // Each row but `unknown` would be attempted without a rule: dead on the
  // first tick, the others on the second (the two-tick debounce), with the
  // notice at delay 0. `unknown` is never attempted; under a rule it is still
  // read, and the rule's outage stays as it was.
  // The rows key their scripted answers by P, a name fixed when the table is
  // built: the file's KEY is only set in beforeAll, after the table exists.
  const NOT_HEALTHY: Array<[string, DepsOpts, string[]]> = [
    ['dead', { aliveSequence: { [P]: [LIVENESS_READING_DEAD] } }, []],
    ['live but disconnected', { isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: false }, [P, P]],
    ['live and connected but streamless', { isSessionAliveResult: LIVENESS_READING_LIVE, hasSessionStreamResult: false }, [P, P]],
    ['pending, connected with its stream', { aliveSequence: { [P]: [LIVENESS_READING_PENDING] } }, [P, P]],
    // Skipped after the read (b.jg5 SRJ-314), so never probed for its connection.
    ['unknown', { aliveSequence: { [P]: [LIVENESS_READING_UNKNOWN] } }, []],
  ]

  test.each(RULES.flatMap(([rule, apply, flag]) => NOT_HEALTHY.map(([reading, opts, connectedCalls]) =>
    [rule, reading, apply, flag, opts, connectedCalls] as [string, string, NoAttemptRule, boolean, DepsOpts, string[]],
  )))('%s, read %s on two ticks with auto-restart disabled: the directory is stat\'d and P probed each tick, nothing scheduled, no not-connected notice, nothing ended', async (_rule, _reading, apply, flag, opts, connectedCalls) => {
    const personas = workList(P)
    const deps = makeDeps({ personas, ...opts, maxTicks: 2 })
    apply(deps)
    const { notified, episodesEnded, conditionsEnded } = recording(deps)

    // An unknown reading logs a line per tick.
    await capturingErrors(() => runTicks(deps, 2))

    expect(deps.statRouteCalls).toEqual([personas[P]!, personas[P]!])
    expect(deps.isSessionAliveCalls).toEqual([P, P])
    expect(deps.isSessionConnectedCalls).toEqual(connectedCalls)
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(notified).toEqual([])
    expect(episodesEnded).toEqual([])
    expect(conditionsEnded).toEqual([])
    expect(getOutageFlags(P).has('tmux-unavailable')).toBe(flag)
    expect(notices).toEqual(flag ? [{ key: P, text: ONSET }] : [])
  })

  test.each(RULES)('%s: the working-directory check still runs, raising cwd-unreachable for an unreachable directory', async (_rule, apply) => {
    const personas = workList(P)
    const deps = makeDeps({ personas, statRouteResult: false, maxTicks: 1 })
    apply(deps)

    await runTicks(deps, 1)

    expect(deps.statRouteCalls).toEqual([personas[P]!])
    expect(getOutageFlags(P).has('cwd-unreachable')).toBe(true)
    expect(deps.scheduleRestartCalls).toEqual([])
  })

  test.each(RULES)('%s, read live, connected and with its stream: the healthy branch ends the not-connected episode and tmux-unresponsive and clears tmux-unavailable with one all-clear; nothing scheduled', async (_rule, apply, flag) => {
    const deps = makeDeps({ personas: workList(P), isSessionAliveResult: LIVENESS_READING_LIVE, maxTicks: 1 })
    apply(deps)
    const { notified, episodesEnded, conditionsEnded } = recording(deps)

    await runTicks(deps, 1)

    expect(deps.isSessionAliveCalls).toEqual([P])
    expect(episodesEnded).toEqual([P])
    expect(conditionsEnded).toEqual([P])
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(notified).toEqual([])
    expect(getOutageFlags(P).size).toBe(0)
    expect(notices).toEqual(flag ? [{ key: P, text: ONSET }, { key: P, text: ALL_CLEAR }] : [])
  })

  test('once a healthy tick has cleared tmux-unavailable, the next dead tick schedules at once', async () => {
    const personas = workList(P)
    const deps = makeDeps({ personas, aliveSequence: { [P]: [LIVENESS_READING_LIVE, LIVENESS_READING_DEAD] }, maxTicks: 2 })
    tmuxUnavailable(deps)

    await runTicks(deps, 2)

    expect(deps.isSessionAliveCalls).toEqual([P, P])
    expect(deps.scheduleRestartCalls).toEqual([{ key: P, cwd: personas[P]! }])
  })

  test.each(RULES)('%s on tick 1 only, read dead on both ticks: nothing on tick 1, scheduled at once on tick 2 once it lifts', async (_rule, apply) => {
    const personas = workList(P)
    const deps = makeDeps({ personas, maxTicks: 2 })
    apply(deps, (tick) => tick === 1)
    const fired: number[] = []
    const schedule = deps.scheduleRestart
    deps.scheduleRestart = (key, cwd) => { fired.push(deps.tickCount()); schedule(key, cwd) }

    await runTicks(deps, 2)

    expect(deps.isSessionAliveCalls).toEqual([P, P])
    expect(fired).toEqual([2])
    expect(deps.scheduleRestartCalls).toEqual([{ key: P, cwd: personas[P]! }])
  })

  test.each(RULES)('streak: %s on tick 2 only, P live but disconnected on four ticks: the held tick leaves no streak, so the first tick after it lifts does not schedule; the second does', async (_rule, apply) => {
    //   tick1: no rule → streak 1 (connected call 1)
    //   tick2: rule    → read (call 2), no attempt, streak cleared
    //   tick3: lifted  → fresh streak 1 (call 3), not scheduled
    //   tick4:         → streak 2 → scheduled (call 4)
    const deps = makeDeps({ personas: workList(P), isSessionAliveResult: LIVENESS_READING_LIVE, isSessionConnectedResult: false, maxTicks: 4 })
    apply(deps, (tick) => tick === 2)

    await runTicks(deps, 4)

    expect(deps.isSessionConnectedCalls).toEqual([P, P, P, P])
    expect(deps.scheduleRestartAtConnectedCount).toEqual([4])
  })

  test.each(RULES)('isolation: P under %s and B under neither, both dead, over two ticks: B is probed and scheduled each tick as today, P never', async (_rule, apply) => {
    const personas = workList(P, B)
    const deps = makeDeps({ personas, maxTicks: 2 })
    apply(deps)

    await runTicks(deps, 2)

    expect(deps.isSessionAliveCalls).toEqual([P, B, P, B])
    expect(deps.scheduleRestartCalls).toEqual([{ key: B, cwd: personas[B]! }, { key: B, cwd: personas[B]! }])
    expect(getOutageFlags(B).size).toBe(0)
  })

  // The restart-pending/active and cap skips come before the no-attempt
  // decision: P reads healthy, so were it read it would be probed, end its
  // episode and condition, and (when raised) clear tmux-unavailable.
  const READ_FREE_SKIPS: Array<[string, DepsOpts]> = [
    ['a restart pending or active', { isRestartPendingResult: true }],
    ['at the restart cap', { isAtCapResult: true }],
  ]
  test.each(READ_FREE_SKIPS.flatMap(([skip, skipOpts]) => RULES.map(([rule, apply, flag]) =>
    [skip, rule, skipOpts, apply, flag] as [string, string, DepsOpts, NoAttemptRule, boolean],
  )))('%s, with %s too: P is skipped before any read on each of two ticks (not stat\'d, probed, scheduled or cleared)', async (_skip, _rule, skipOpts, apply, flag) => {
    const deps = makeDeps({ personas: workList(P), isSessionAliveResult: LIVENESS_READING_LIVE, ...skipOpts, maxTicks: 2 })
    apply(deps)
    const { notified, episodesEnded, conditionsEnded } = recording(deps)

    await capturingErrors(() => runTicks(deps, 2))

    expect(deps.statRouteCalls).toEqual([])
    expect(deps.isSessionAliveCalls).toEqual([])
    expect(deps.isSessionConnectedCalls).toEqual([])
    expect(deps.hasSessionStreamCalls).toEqual([])
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(notified).toEqual([])
    expect(episodesEnded).toEqual([])
    expect(conditionsEnded).toEqual([])
    expect(getOutageFlags(P).has('tmux-unavailable')).toBe(flag)
  })

  test('a throwing in-flight predicate ends P\'s work for the tick before any read, logged; B is still checked', async () => {
    const personas = workList(P, B)
    const deps = makeDeps({ personas, maxTicks: 1 })
    deps.isLaunchInFlight = (key) => {
      if (key === P) throw new Error('simulated in-flight failure')
      return false
    }

    const lines = await capturingErrors(() => runTicks(deps, 1))

    expect(deps.statRouteCalls).toEqual([personas[B]!])
    expect(deps.isSessionAliveCalls).toEqual([B])
    expect(deps.scheduleRestartCalls).toEqual([{ key: B, cwd: personas[B]! }])
    expect(lines.filter((l) => l.includes(`persona=${P}`) && l.includes('simulated in-flight failure'))).toHaveLength(1)
  })

  test('b.jg5 SRJ-502: a throwing latched query ends P\'s work for the tick before any read, logged; B is still checked', async () => {
    const personas = workList(P, B)
    const deps = makeDeps({ personas, maxTicks: 1 })
    deps.isLatched = (key) => {
      if (key === P) throw new Error('simulated latch failure')
      return false
    }

    const lines = await capturingErrors(() => runTicks(deps, 1))

    expect(deps.statRouteCalls).toEqual([personas[B]!])
    expect(deps.isSessionAliveCalls).toEqual([B])
    expect(deps.scheduleRestartCalls).toEqual([{ key: B, cwd: personas[B]! }])
    expect(lines.filter((l) => l.includes(`persona=${P}`) && l.includes('simulated latch failure'))).toHaveLength(1)
  })

  test('b.jg5 SRJ-207: a throwing held query ends P\'s work for the tick before any read, logged; B is still checked', async () => {
    const personas = workList(P, B)
    const deps = makeDeps({ personas, maxTicks: 1 })
    deps.isHeld = (key) => {
      if (key === P) throw new Error('simulated held-query failure')
      return false
    }

    const lines = await capturingErrors(() => runTicks(deps, 1))

    expect(deps.statRouteCalls).toEqual([personas[B]!])
    expect(deps.isSessionAliveCalls).toEqual([B])
    expect(deps.scheduleRestartCalls).toEqual([{ key: B, cwd: personas[B]! }])
    expect(lines.filter((l) => l.includes(`persona=${P}`) && l.includes('simulated held-query failure'))).toHaveLength(1)
  })

  test('b.jg5 SRJ-207: the held query is asked right after the latched one and before the in-flight one: P held, with an in-flight predicate that would throw for it, is still read and makes no attempt; a latched P is never asked it', async () => {
    const personas = workList(P)
    const deps = makeDeps({ personas, maxTicks: 1 })
    held(deps)
    const inFlightAsked: string[] = []
    deps.isLaunchInFlight = (key) => {
      inFlightAsked.push(key)
      throw new Error('simulated in-flight failure')
    }

    await capturingErrors(() => runTicks(deps, 1))

    expect(inFlightAsked).toEqual([])
    expect(deps.isSessionAliveCalls).toEqual([P])
    expect(deps.scheduleRestartCalls).toEqual([])

    const latchedDeps = makeDeps({ personas, maxTicks: 1 })
    latched(latchedDeps)
    const heldAsked: string[] = []
    latchedDeps.isHeld = (key) => {
      heldAsked.push(key)
      return false
    }
    await capturingErrors(() => runTicks(latchedDeps, 1))
    expect(heldAsked).toEqual([])
    expect(latchedDeps.scheduleRestartCalls).toEqual([])
  })

  test('b.jg5 SRJ-502: the latch is asked first: P latched, with an in-flight predicate that would throw for it, is still read and makes no attempt', async () => {
    const personas = workList(P)
    const deps = makeDeps({ personas, maxTicks: 1 })
    latched(deps)
    const inFlightAsked: string[] = []
    deps.isLaunchInFlight = (key) => {
      inFlightAsked.push(key)
      throw new Error('simulated in-flight failure')
    }

    const lines = await capturingErrors(() => runTicks(deps, 1))

    expect(inFlightAsked).toEqual([])
    expect(deps.statRouteCalls).toEqual([personas[P]!])
    expect(deps.isSessionAliveCalls).toEqual([P])
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(lines).toEqual([])
  })

  // b.jg5 SRJ-311: a raised tmux-unavailable outage does not guarantee a retry
  // timer, so a tick that reads P not healthy under that rule with none armed
  // (`isRetryArmed` answers exactly false) arms one, logging one line before
  // it, and still schedules nothing and posts nothing. A healthy tick clears
  // the flag instead; a reading the tick skips (`unknown`, a thrown probe), an
  // armed timer, an absent `isRetryArmed` and work in flight arm nothing.
  // Only these cases set `retryArmedResult` / `recordRetryArms`; every other
  // case in this file leaves both deps absent.
  const armingLine = (key: string) =>
    `[slack] health-check: persona=${key} has its tmux-unavailable outage raised with no retry timer — arming one`
  const armMark = (key: string) => `arm ${key}`

  /** Log a mark at each arm, so the captured lines show each arm's place beside its line. */
  function markingArms(deps: Deps): void {
    const arm = deps.armRetryTimer!
    deps.armRetryTimer = (key) => {
      console.error(armMark(key))
      arm(key)
    }
  }

  /** The rows of `notHealthyReadings(P)` with these labels; throws (failing the file) if one is missing. */
  function readingsLabelled(...labels: string[]): Array<[string, DepsOpts]> {
    const rows = notHealthyReadings(P).filter(([label]) => labels.includes(label))
    if (rows.length !== labels.length) throw new Error(`notHealthyReadings has no row for one of: ${labels.join(', ')}`)
    return rows
  }
  // Read and not healthy: the tick reaches its no-attempt branch.
  const READ_NOT_HEALTHY = readingsLabelled(
    'pending (no launch start), connected with its stream',
    'pending (a launch start), connected with its stream',
    'dead',
    'live but disconnected',
    'live and connected but streamless',
  )
  // Skipped after the read (b.jg5 SRJ-314): never reaches that branch.
  const SKIPPED_READINGS = readingsLabelled('unknown', 'a thrown probe')

  test.each(READ_NOT_HEALTHY)('tmux-unavailable raised with no retry timer armed, read %s on two ticks with auto-restart disabled: the tick arms P\'s timer once per tick, each after its line; nothing scheduled, no not-connected notice, the flag stays raised', async (_label, opts) => {
    const deps = makeDeps({ personas: workList(P), ...opts, retryArmedResult: false, recordRetryArms: true, maxTicks: 2 })
    tmuxUnavailable(deps)
    markingArms(deps)
    const { notified, episodesEnded, conditionsEnded } = recording(deps)

    const lines = await capturingErrors(() => runTicks(deps, 2))

    expect(deps.isSessionAliveCalls).toEqual([P, P])
    expect(deps.isRetryArmedCalls).toEqual([P, P])
    expect(deps.armRetryTimerCalls).toEqual([{ key: P, tick: 1 }, { key: P, tick: 2 }])
    expect(lines).toEqual([armingLine(P), armMark(P), armingLine(P), armMark(P)])
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(notified).toEqual([])
    expect(episodesEnded).toEqual([])
    expect(conditionsEnded).toEqual([])
    expect(getOutageFlags(P).has('tmux-unavailable')).toBe(true)
    expect(notices).toEqual([{ key: P, text: ONSET }])
  })

  test('a timer the tick armed is seen as armed on the next tick: tmux-unavailable raised, read dead on three ticks, P\'s timer is armed once, on tick 1', async () => {
    const deps = makeDeps({ personas: workList(P), retryArmedResult: false, recordRetryArms: true, maxTicks: 3 })
    tmuxUnavailable(deps)
    deps.isRetryArmed = (key) => deps.armRetryTimerCalls.some((call) => call.key === key)

    const lines = await capturingErrors(() => runTicks(deps, 3))

    expect(deps.isSessionAliveCalls).toEqual([P, P, P])
    expect(deps.armRetryTimerCalls).toEqual([{ key: P, tick: 1 }])
    expect(lines).toEqual([armingLine(P)])
    expect(deps.scheduleRestartCalls).toEqual([])
  })

  test.each(READ_NOT_HEALTHY)('tmux-unavailable raised with a retry timer armed, read %s on two ticks: nothing is armed and no line logged', async (_label, opts) => {
    const deps = makeDeps({ personas: workList(P), ...opts, retryArmedResult: true, recordRetryArms: true, maxTicks: 2 })
    tmuxUnavailable(deps)

    const lines = await capturingErrors(() => runTicks(deps, 2))

    expect(deps.isRetryArmedCalls).toEqual([P, P])
    expect(deps.armRetryTimerCalls).toEqual([])
    expect(lines).not.toContain(armingLine(P))
    expect(deps.scheduleRestartCalls).toEqual([])
  })

  test('tmux-unavailable raised with no isRetryArmed (armRetryTimer present), read dead on two ticks: nothing is armed and no line logged', async () => {
    const deps = makeDeps({ personas: workList(P), recordRetryArms: true, maxTicks: 2 })
    tmuxUnavailable(deps)
    expect(deps.isRetryArmed).toBeUndefined()

    const lines = await capturingErrors(() => runTicks(deps, 2))

    expect(deps.isSessionAliveCalls).toEqual([P, P])
    expect(deps.armRetryTimerCalls).toEqual([])
    expect(lines).not.toContain(armingLine(P))
    expect(deps.scheduleRestartCalls).toEqual([])
  })

  test('tmux-unavailable raised with no retry timer armed, read live, connected and with its stream: nothing is armed and the flag clears instead, with one all-clear', async () => {
    const deps = makeDeps({ personas: workList(P), isSessionAliveResult: LIVENESS_READING_LIVE, retryArmedResult: false, recordRetryArms: true, maxTicks: 1 })
    tmuxUnavailable(deps)

    const lines = await capturingErrors(() => runTicks(deps, 1))

    expect(deps.isRetryArmedCalls).toEqual([])
    expect(deps.armRetryTimerCalls).toEqual([])
    expect(lines).not.toContain(armingLine(P))
    expect(getOutageFlags(P).size).toBe(0)
    expect(notices).toEqual([{ key: P, text: ONSET }, { key: P, text: ALL_CLEAR }])
  })

  test.each(SKIPPED_READINGS)('tmux-unavailable raised with no retry timer armed, read %s on two ticks: the persona is skipped after the read, nothing is armed and the flag stays raised', async (_label, opts) => {
    const deps = makeDeps({ personas: workList(P), ...opts, retryArmedResult: false, recordRetryArms: true, maxTicks: 2 })
    tmuxUnavailable(deps)

    // Each skipped reading logs a line per tick.
    const lines = await capturingErrors(() => runTicks(deps, 2))

    expect(deps.isSessionAliveCalls).toEqual([P, P])
    expect(deps.isRetryArmedCalls).toEqual([])
    expect(deps.armRetryTimerCalls).toEqual([])
    expect(lines).not.toContain(armingLine(P))
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(getOutageFlags(P).has('tmux-unavailable')).toBe(true)
  })

  test.each(READ_NOT_HEALTHY)('a launch in flight with tmux-unavailable raised too and no retry timer armed, read %s on two ticks: the in-flight reason wins, so nothing is armed', async (_label, opts) => {
    const deps = makeDeps({ personas: workList(P), ...opts, retryArmedResult: false, recordRetryArms: true, maxTicks: 2 })
    inFlight(deps)
    tmuxUnavailable(deps)

    const lines = await capturingErrors(() => runTicks(deps, 2))

    expect(deps.isSessionAliveCalls).toEqual([P, P])
    expect(deps.isRetryArmedCalls).toEqual([])
    expect(deps.armRetryTimerCalls).toEqual([])
    expect(lines).not.toContain(armingLine(P))
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(getOutageFlags(P).has('tmux-unavailable')).toBe(true)
  })

  // b.jg5 SRJ-502, SRJ-207: the latch and the ErrInvalidFlags hold each stop
  // P's retry timer, so the tick never arms a new one for a latched or held
  // P, even with its tmux-unavailable outage raised.
  test.each(READ_NOT_HEALTHY.flatMap(([label, opts]) => ([['latched', latched], ['held on ErrInvalidFlags', held]] as const).map(([rule, apply]) => [rule, label, opts, apply] as const)))('b.jg5 SRJ-502, SRJ-207: P %s with tmux-unavailable raised too and no retry timer armed, read %s on two ticks: that reason wins, so nothing is armed, nothing scheduled and the flag stays raised', async (_rule, _label, opts, apply) => {
    const deps = makeDeps({ personas: workList(P), ...opts, retryArmedResult: false, recordRetryArms: true, maxTicks: 2 })
    apply(deps)
    tmuxUnavailable(deps)
    const { notified } = recording(deps)

    const lines = await capturingErrors(() => runTicks(deps, 2))

    expect(deps.isSessionAliveCalls).toEqual([P, P])
    expect(deps.isRetryArmedCalls).toEqual([])
    expect(deps.armRetryTimerCalls).toEqual([])
    expect(lines).not.toContain(armingLine(P))
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(notified).toEqual([])
    expect(getOutageFlags(P).has('tmux-unavailable')).toBe(true)
  })

  // b.jg5 SRJ-311: the tick decides P's no-attempt reason before awaiting its
  // reads, so the arm re-checks it at arm time. Here the reason changes inside
  // the `isSessionAlive` read, after the tick decided `tmux-unavailable` (so
  // the tick still takes its no-attempt branch on the `dead` reading): the
  // flag is cleared, or a launch goes in flight. Nothing is armed, no arming
  // line is logged and `isRetryArmed` is never asked.
  /** Wrap P's liveness read so `change` runs just before it answers. */
  function changingAtRead(deps: Deps, change: () => void): void {
    const read = deps.isSessionAlive
    deps.isSessionAlive = async (key) => {
      if (key === P) change()
      return read(key)
    }
  }

  // [how the flag is cleared, the clear, the outage notices it leaves]
  const CLEARS_DURING_READ: Array<[string, () => void, string[]]> = [
    // A teardown's `resetOutageState` (production binds it to resetAllToHealthy): silent.
    ['by a teardown (resetAllToHealthy)', () => resetAllToHealthy([P]), [ONSET]],
    ['by a real clear (clearOutageFlag)', () => clearOutageFlag(P, 'tmux-unavailable'), [ONSET, ALL_CLEAR]],
  ]

  test.each(CLEARS_DURING_READ)('b.jg5 SRJ-311: tmux-unavailable raised with no retry timer armed, the flag cleared %s during P\'s liveness read, which then reads dead: nothing is armed and no arming line logged', async (_how, clear, texts) => {
    const deps = makeDeps({ personas: workList(P), retryArmedResult: false, recordRetryArms: true, maxTicks: 1 })
    tmuxUnavailable(deps)
    changingAtRead(deps, clear)

    const lines = await capturingErrors(() => runTicks(deps, 1))

    expect(deps.isSessionAliveCalls).toEqual([P])
    expect(deps.isRetryArmedCalls).toEqual([])
    expect(deps.armRetryTimerCalls).toEqual([])
    expect(lines).toEqual([])
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(getOutageFlags(P).has('tmux-unavailable')).toBe(false)
    expect(notices).toEqual(texts.map((text) => ({ key: P, text })))
  })

  test('b.jg5 SRJ-311: tmux-unavailable raised with no retry timer armed, a launch going in flight during P\'s liveness read, which then reads dead: nothing is armed and no arming line logged; the flag stays raised', async () => {
    const deps = makeDeps({ personas: workList(P), retryArmedResult: false, recordRetryArms: true, maxTicks: 1 })
    tmuxUnavailable(deps)
    let launched = false
    deps.isLaunchInFlight = (key) => key === P && launched
    changingAtRead(deps, () => { launched = true })

    const lines = await capturingErrors(() => runTicks(deps, 1))

    expect(deps.isSessionAliveCalls).toEqual([P])
    expect(deps.isRetryArmedCalls).toEqual([])
    expect(deps.armRetryTimerCalls).toEqual([])
    expect(lines).toEqual([])
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(getOutageFlags(P).has('tmux-unavailable')).toBe(true)
    expect(notices).toEqual([{ key: P, text: ONSET }])
  })

  test('b.jg5 SRJ-502: tmux-unavailable raised with no retry timer armed, P latching during its liveness read, which then reads dead: nothing is armed and no arming line logged; the flag stays raised', async () => {
    const deps = makeDeps({ personas: workList(P), retryArmedResult: false, recordRetryArms: true, maxTicks: 1 })
    tmuxUnavailable(deps)
    let isLatched = false
    deps.isLatched = (key) => key === P && isLatched
    changingAtRead(deps, () => { isLatched = true })

    const lines = await capturingErrors(() => runTicks(deps, 1))

    expect(deps.isSessionAliveCalls).toEqual([P])
    expect(deps.isRetryArmedCalls).toEqual([])
    expect(deps.armRetryTimerCalls).toEqual([])
    expect(lines).toEqual([])
    expect(deps.scheduleRestartCalls).toEqual([])
    expect(getOutageFlags(P).has('tmux-unavailable')).toBe(true)
  })

  test('isolation: P with tmux-unavailable raised and B under neither rule, both dead with no retry timer armed, over two ticks: only P\'s timer is armed (once per tick); B is never asked about, armed for or logged, and is scheduled each tick as today', async () => {
    const personas = workList(P, B)
    const deps = makeDeps({ personas, retryArmedResult: false, recordRetryArms: true, maxTicks: 2 })
    tmuxUnavailable(deps)

    const lines = await capturingErrors(() => runTicks(deps, 2))

    expect(deps.isSessionAliveCalls).toEqual([P, B, P, B])
    expect(deps.isRetryArmedCalls).toEqual([P, P])
    expect(deps.armRetryTimerCalls).toEqual([{ key: P, tick: 1 }, { key: P, tick: 2 }])
    expect(lines).toEqual([armingLine(P), armingLine(P)])
    expect(deps.scheduleRestartCalls).toEqual([{ key: B, cwd: personas[B]! }, { key: B, cwd: personas[B]! }])
    expect(getOutageFlags(B).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// b.jg5 SRJ-308 — the tick-end hook (the onset check with the health check on)
//
// Each tick body reads its start time from `now` once, before any of its work,
// and calls `onTickEnd(tickStartedAt)` once when the body ends, after every
// persona's work (production binds it to the tmux-unresponsive condition's
// `onsetAtTick`; the binding is pinned in tests/server-startup-wiring.test.ts
// and the onset's posting in tests/tmux-unresponsive.test.ts). It is called
// however the body ends: every persona skipped, a persona's work throwing, or
// the body exiting early through a throw outside the per-persona work (logged
// as `the tick failed`, never rethrown). The hook called is the one of the
// deps the tick started with, even if `initHealthCheck` swaps them mid-tick.
// A tick skipped because a body is still in flight or the server is shutting
// down reads no start time and calls nothing. A throwing hook is logged and
// the next tick runs; a throwing `now` is logged and that tick calls no hook.
// Every other case in this file leaves both deps at their defaults (absent).
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-308: the tick-end hook runs once per tick body with the tick\'s start time', () => {
  const TICK_END_FAILED = '[slack] health-check: the tick-end hook failed: '
  const START_UNREAD = '[slack] health-check: the tick\'s start time could not be read: '
  const TICK_FAILED = '[slack] health-check: the tick failed: '

  /**
   * Bind an injected clock and a recording tick-end hook to `deps`. The clock
   * answers `startTimes` in order, one per read (the last repeats once
   * exhausted), and records how many tick bodies had begun at each read. The
   * hook records its argument with the tick bodies begun and liveness probes
   * made by then.
   */
  function withTickEnd(deps: ReturnType<typeof makeDeps>, startTimes: number[]) {
    const reads: number[] = []
    const ends: Array<{ tickStartedAt: number; ticks: number; probes: number }> = []
    deps.now = () => {
      reads.push(deps.tickCount())
      return startTimes[Math.min(reads.length - 1, startTimes.length - 1)]!
    }
    deps.onTickEnd = (tickStartedAt) => {
      ends.push({ tickStartedAt, ticks: deps.tickCount(), probes: deps.isSessionAliveCalls.length })
    }
    return { reads, ends }
  }

  test('two personas over three ticks: one call per tick body, after both personas\' work, with that tick\'s start time from now; now is read once per body, before its work', async () => {
    const deps = makeDeps({ personas: workList('persona_a', 'persona_b'), maxTicks: 3 })
    const { reads, ends } = withTickEnd(deps, [1_000, 2_000, 3_000])

    await runTicks(deps, 3)

    // Read at each body's start, before its work list was even asked for.
    expect(reads).toEqual([0, 1, 2])
    // A per-persona hook would show six calls; one before the work, zero probes.
    expect(ends).toEqual([
      { tickStartedAt: 1_000, ticks: 1, probes: 2 },
      { tickStartedAt: 2_000, ticks: 2, probes: 4 },
      { tickStartedAt: 3_000, ticks: 3, probes: 6 },
    ])
    expect(deps.scheduleRestartCalls).toHaveLength(6)
  })

  test('the hook gets the start time read at the body\'s start, not a time read when the body ends', async () => {
    // A clock that moves on during the body: were the hook's argument read at
    // the end, it would show the later value.
    const deps = makeDeps({ maxTicks: 1 })
    const { ends } = withTickEnd(deps, [5_000, 9_000])
    const probe = deps.isSessionAlive
    deps.isSessionAlive = async (key) => {
      deps.now!()  // the clock's next read answers 9 000
      return probe(key)
    }

    await runTicks(deps, 1)

    expect(ends.map((e) => e.tickStartedAt)).toEqual([5_000])
  })

  test('with now absent the start time is the system clock\'s, read at the body\'s start', async () => {
    const deps = makeDeps({ maxTicks: 1 })
    const ends: number[] = []
    deps.onTickEnd = (tickStartedAt) => void ends.push(tickStartedAt)
    const before = Date.now()

    await runTicks(deps, 1)

    expect(ends).toHaveLength(1)
    expect(ends[0]!).toBeGreaterThanOrEqual(before)
    expect(ends[0]!).toBeLessThanOrEqual(Date.now())
  })

  const bindNothing = (_deps: ReturnType<typeof makeDeps>): void => {}
  test.each<[string, DepsOpts, (deps: ReturnType<typeof makeDeps>) => void]>([
    ['a restart pending', { isRestartPendingResult: true }, bindNothing],
    ['a launch in flight', {}, (deps) => { deps.isLaunchInFlight = () => true }],
    ['latched (b.jg5 SRJ-502)', {}, (deps) => { deps.isLatched = () => true }],
    ['held on ErrInvalidFlags (b.jg5 SRJ-207)', {}, (deps) => { deps.isHeld = () => true }],
    ['tmux-unavailable raised', {}, () => {
      setOutageFlag('persona_a', 'tmux-unavailable')
      setOutageFlag('persona_b', 'tmux-unavailable')
    }],
    ['at the restart cap', { isAtCapResult: true }, bindNothing],
    ['an unknown reading', { aliveSequence: { persona_a: [LIVENESS_READING_UNKNOWN], persona_b: [LIVENESS_READING_UNKNOWN] } }, bindNothing],
  ])('no persona attempted (%s) on each of two ticks: the hook is still called once per tick, with that tick\'s start time', async (_label, opts, bind) => {
    const deps = makeDeps({ ...opts, personas: workList('persona_a', 'persona_b'), maxTicks: 2 })
    bind(deps)
    const { ends } = withTickEnd(deps, [10_000, 20_000])

    await capturingErrors(() => runTicks(deps, 2))

    expect(deps.scheduleRestartCalls).toEqual([])
    expect(ends.map((e) => [e.tickStartedAt, e.ticks])).toEqual([[10_000, 1], [20_000, 2]])
  })

  test('an empty work list (every persona left out by the relaunch gate): the hook is still called once per tick', async () => {
    const deps = makeDeps({ personas: {}, maxTicks: 2 })
    const { ends } = withTickEnd(deps, [10_000, 20_000])

    await runTicks(deps, 2)

    expect(deps.statRouteCalls).toEqual([])
    expect(ends.map((e) => [e.tickStartedAt, e.ticks])).toEqual([[10_000, 1], [20_000, 2]])
  })

  test('one persona skipped, one checked, in the same tick: the hook is called once for the tick, not per checked persona', async () => {
    const personas = workList('capped_bot', 'dead_bot')
    const deps = makeDeps({ personas, maxTicks: 2 })
    deps.isAtCap = (key) => key === 'capped_bot'
    const { ends } = withTickEnd(deps, [10_000, 20_000])

    await capturingErrors(() => runTicks(deps, 2))

    expect(deps.scheduleRestartCalls.map((c) => c.key)).toEqual(['dead_bot', 'dead_bot'])
    expect(ends).toEqual([
      { tickStartedAt: 10_000, ticks: 1, probes: 1 },
      { tickStartedAt: 20_000, ticks: 2, probes: 2 },
    ])
  })

  test('a persona\'s work throws: the tick logs it, checks the next persona, and still calls the hook once, after both', async () => {
    const personas = workList('failing_bot', 'dead_bot')
    const deps = makeDeps({ personas, maxTicks: 2 })
    const stat = deps.statRoute
    deps.statRoute = async (cwd) => {
      if (cwd === personas.failing_bot) throw new Error('simulated stat failure')
      return stat(cwd)
    }
    const { ends } = withTickEnd(deps, [10_000, 20_000])

    const lines = await capturingErrors(() => runTicks(deps, 2))

    expect(lines.filter((l) => l.includes('error checking persona=failing_bot'))).toHaveLength(2)
    expect(deps.scheduleRestartCalls.map((c) => c.key)).toEqual(['dead_bot', 'dead_bot'])
    expect(ends).toEqual([
      { tickStartedAt: 10_000, ticks: 1, probes: 1 },
      { tickStartedAt: 20_000, ticks: 2, probes: 2 },
    ])
  })

  test('getPersonas throws an error carrying fake tokens: one "the tick failed" line describing it, redacted; the hook is still called once with that tick\'s start time; the next tick runs normally; no rejection escapes; nothing leaks', async () => {
    const deps = makeDeps({ maxTicks: 2 })
    const { ends } = withTickEnd(deps, [10_000, 20_000])
    const thrown = Object.assign(new Error(`personas unreadable (${sentinelInMessage('msg')})`), {
      code: 'EIO',
      detail: fakeToken(APP_TOKEN_PREFIX, 'detail'),
      note: LEAK_SENTINEL,
    })
    const getPersonas = deps.getPersonas
    deps.getPersonas = () => {
      const personas = getPersonas()
      if (deps.tickCount() === 1) throw thrown
      return personas
    }
    // A test-scoped listener; the runner also fails a case that leaves one.
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => void rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    let lines: string[]
    try {
      lines = await capturingErrors(async () => {
        await runTicks(deps, 2)
        // One macrotask turn: a rejection left unhandled is reported here.
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    } finally {
      process.off('unhandledRejection', onRejection)
    }

    // Named by position only: an escaped reason could hold a token.
    expect(rejections.map((_, i) => `rejection ${i}`)).toEqual([])
    const failed = lines.filter((l) => l.startsWith(TICK_FAILED))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toStartWith(
      `${TICK_FAILED}Error code=EIO message="personas unreadable (${REDACTED_SENTINEL_TAIL})" at `,
    )
    // The first body ended before any persona's work; the second (the reset
    // in-flight guard let it start) checked the persona as usual.
    expect(ends).toEqual([
      { tickStartedAt: 10_000, ticks: 1, probes: 0 },
      { tickStartedAt: 20_000, ticks: 2, probes: 1 },
    ])
    expect(deps.scheduleRestartCalls).toEqual([{ key: KEY, cwd: WD }])
    expect(lines.filter((l) => l.startsWith(TICK_END_FAILED) || l.startsWith(START_UNREAD))).toEqual([])
    assertNoLeak({ lines, notices })
  })

  test('deps swapped by initHealthCheck mid-tick: the tick calls the hook of the deps it started with, with its start time; the new deps\' hook gets only its own ticks\' start times', async () => {
    const first = makeDeps()
    const firstTicks = withTickEnd(first, [10_000])
    let release: ((reachable: boolean) => void) | undefined
    first.statRoute = () => new Promise<boolean>((resolve) => { release = resolve })
    const second = makeDeps({ maxTicks: 1 })
    const secondTicks = withTickEnd(second, [20_000])
    initHealthCheck(first)

    await capturingErrors(async () => {
      // The first body hangs on the first deps' statRoute, called before the
      // body's first await.
      const firstBody = _runHealthCheckTickForTest()
      expect(release).toBeDefined()
      expect(first.tickCount()).toBe(1)
      initHealthCheck(second)
      release!(true)
      await firstBody
      // The next tick runs on the second deps.
      await driveTicks(1)
    })

    expect(firstTicks.reads).toEqual([0])
    expect(firstTicks.ends.map((e) => [e.tickStartedAt, e.ticks])).toEqual([[10_000, 1]])
    expect(secondTicks.reads).toEqual([0])
    expect(secondTicks.ends.map((e) => [e.tickStartedAt, e.ticks])).toEqual([[20_000, 1]])
  })

  test('a throwing hook is logged once per tick and never breaks the tick: each tick\'s work is done and the next tick runs', async () => {
    const deps = makeDeps({ maxTicks: 3 })
    const { reads } = withTickEnd(deps, [10_000, 20_000, 30_000])
    const called: number[] = []
    deps.onTickEnd = (tickStartedAt) => {
      called.push(tickStartedAt)
      throw new Error(`simulated hook failure at ${tickStartedAt}`)
    }

    const lines = await capturingErrors(() => runTicks(deps, 3))

    expect(reads).toHaveLength(3)
    expect(called).toEqual([10_000, 20_000, 30_000])
    expect(deps.scheduleRestartCalls).toHaveLength(3)
    const failures = lines.filter((l) => l.startsWith(TICK_END_FAILED))
    expect(failures).toHaveLength(3)
    for (const [i, line] of failures.entries()) expect(line).toContain(`simulated hook failure at ${called[i]}`)
  })

  test('a throwing now is logged and that tick calls no hook; its work is still done, and the ticks either side call the hook', async () => {
    const deps = makeDeps({ maxTicks: 3 })
    const { ends } = withTickEnd(deps, [10_000, 20_000, 30_000])
    const clock = deps.now!
    let reads = 0
    deps.now = () => {
      const t = clock()
      if (++reads === 2) throw new Error('simulated clock failure')
      return t
    }

    const lines = await capturingErrors(() => runTicks(deps, 3))

    expect(ends.map((e) => [e.tickStartedAt, e.ticks])).toEqual([[10_000, 1], [30_000, 3]])
    expect(deps.scheduleRestartCalls).toHaveLength(3)
    const unread = lines.filter((l) => l.startsWith(START_UNREAD))
    expect(unread).toHaveLength(1)
    expect(unread[0]).toContain('simulated clock failure')
    expect(unread[0]).toContain('no tick-end hook this tick')
    expect(lines.filter((l) => l.startsWith(TICK_END_FAILED))).toEqual([])
  })

  test('ticks skipped while a body is still in flight read no start time and call no hook; the body in flight calls it once when it ends', async () => {
    const deps = makeDeps()
    const { reads, ends } = withTickEnd(deps, [10_000, 20_000])
    let release: ((reachable: boolean) => void) | undefined
    deps.statRoute = () => new Promise<boolean>((resolve) => { release = resolve })
    // Every tick asks isShuttingDown first; counting those counts the
    // fires, the skipped ones included. Shutdown stays off until the hung body
    // is released, so every fire meanwhile reaches the in-flight guard.
    let fires = 0
    let stopping = false
    deps.isShuttingDown = () => (fires++, stopping)
    initHealthCheck(deps)

    const lines = await capturingErrors(async () => {
      // The first body hangs on statRoute; five skipped ticks follow it.
      const hungBody = _runHealthCheckTickForTest()
      expect(release).toBeDefined()
      await driveTicks(5)
      expect(fires).toBe(6)
      expect(deps.tickCount()).toBe(1)
      expect(reads).toEqual([0])
      expect(ends).toEqual([])
      // No further body may start once this one ends.
      stopping = true
      release!(true)
      await hungBody
    })

    // The fires were in-flight skips (the fifth logs the guard's warning).
    expect(lines.filter((l) => l.includes('tick body in flight; skipped 5 consecutive ticks'))).toHaveLength(1)
    expect(deps.tickCount()).toBe(1)
    expect(reads).toEqual([0])
    expect(ends).toEqual([{ tickStartedAt: 10_000, ticks: 1, probes: 1 }])
    expect(lines.filter((l) => l.startsWith(TICK_END_FAILED) || l.startsWith(START_UNREAD))).toEqual([])
  })

  test('ticks skipped while shutting down read no start time and call no hook', async () => {
    const deps = makeDeps({ isShuttingDownResult: true })
    const { reads, ends } = withTickEnd(deps, [10_000])
    const shuttingDown = deps.isShuttingDown
    let fires = 0
    deps.isShuttingDown = () => (fires++, shuttingDown())
    initHealthCheck(deps)

    await driveTicks(3)

    expect(fires).toBe(3)
    expect(deps.tickCount()).toBe(0)
    expect(reads).toEqual([])
    expect(ends).toEqual([])
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
   * Install the real health check's deps over `getPersonas`, every session
   * dead, with the real statRoute on the real file system (a missing path
   * answers as a non-directory rather than through the factory's error log).
   * `tick()` runs exactly one more tick body through the seam and resolves
   * once it has ended, checking that every persona in its work list finished
   * (scheduled, or skipped at cap), so the assertions after it see the whole
   * tick.
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
    async function tick(): Promise<void> {
      allowed++
      await _runHealthCheckTickForTest()
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

    // Only the up persona reached any tick step, once per tick (the cap
    // twice: before the read and right after it, b.4q8).
    expect(calls.pending).toEqual([up.key, up.key, up.key])
    expect(calls.atCap).toEqual([up.key, up.key, up.key, up.key, up.key, up.key])
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

    // At the restart cap the tick skips it, as for any capped persona: one ask
    // of the cap, before any read (each earlier tick asked twice, before the
    // read and right after it, b.4q8).
    capped = true
    await tick()
    expect(calls.atCap).toEqual([up.key, up.key, up.key, up.key, up.key])
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

// ---------------------------------------------------------------------------
// b.jg5 SRJ-502, SRJ-512, SRJ-513 — a tick whose own liveness read latches P
//
// The real liveness adapter applies the own-row `status` step, with the
// configured-persona query installed as `main()` installs it (here: P and
// B). So P latches on the first tick through the installed latch (whose
// notice reaction, bound as `main()` binds it over a real episodes instance,
// posts once per episode) when P's `status` answers UNUSABLE NAME (SRJ-512:
// "unusable recorded name", the state unreadable, SRJ-1019) or P's own row
// reads `pending` with no launch start (SRJ-513: "launch start not recorded",
// the state `pending`, SRJ-1020). The read gives `unknown`: the tick skips
// P, schedules nothing and asks for no not-connected notice, whether P's
// session is connected or not. P is still read on each later tick, as a
// latched persona is (SRJ-315); each read meets the same case again, which
// posts nothing more. The tick asks the latch again after its own read, so P
// latched while the read ran (here by another path, the read itself
// answering dead) is not scheduled either. Controls: a phrase-less
// `ErrInternal` latches no one and keeps E9's skip on `unknown`; a `pending`
// row with a launch start latches no one and keeps E9's two-tick streak,
// then `scheduleRestart`. B beside P, read dead, is scheduled on every tick.
// Each hold case runs one fault row or one no-launch-start form per
// connection here: every fault and form is covered at the adapters, in
// tests/server.test.ts. The ticks run through the tick seam (`runTicks`),
// each awaited to its end.
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-512, SRJ-513: a tick whose own liveness read latches P', () => {
  const P = 'held_bot'
  const B = 'other_bot'
  const DEAD_ROW = cannedStatusResult({ state: [...AGENT_DIRECTOR_DEAD_STATES][0]! })
  /** The first `status` row of the unusable-name table. */
  const ROW = UNUSABLE_NAME_CASE_ROWS.find((row) => row.site === 'status')!
  /** P's own row `pending` with the launch start `start` (the key left out for `undefined`). */
  const pendingRow = (start: string | null | undefined) =>
    cannedStatusResult({ state: AGENT_DIRECTOR_PENDING_STATE, launch_started_at: start })

  let latch: ConflictLatch
  let unbindNotice: () => void
  /** The latch's and the episodes' own lines. */
  let latchLines: string[]
  /** Every notice the episodes' sink received. */
  let posts: Array<{ key: string; text: string }>

  beforeEach(() => {
    latchLines = []
    posts = []
    latch = createConflictLatch({ log: (line) => { latchLines.push(line) } })
    unbindNotice = bindConflictNotice(latch, createPersonaEpisodes({
      sink: (key, text) => { posts.push({ key, text }) },
      log: (line) => { latchLines.push(line) },
      clock: createFakeClock(),
    }))
    setConflictLatch(latch)
    setConfiguredPersonaQuery((key) => key === P || key === B)
  })

  afterEach(() => {
    unbindNotice()
    setConflictLatch(undefined)
    _resetConfiguredPersonaQuery()
    resetClientForTests()
  })

  /**
   * The file's deps, their liveness read the real adapter over a stub client:
   * P's `status` answers `pAnswer` on every read, B's reads a dead row. P's
   * session is connected (with its stream) or not as given (default: not, so
   * read live its second tick would schedule it and ask for the notice),
   * auto-restart is disabled, the latched query is the installed latch's, and
   * each not-connected notice asked for is recorded with its reason.
   */
  function latchDeps(pAnswer: Error | ReturnType<typeof cannedStatusResult>, maxTicks: number, connected = false) {
    const config = makeMultiPersonaConfig([{ name: P }, { name: B }], baseDir)
    const statusCalls: string[] = []
    setClientForTests(makeStubClient({
      statusFn: ({ claude_instance_id }) => {
        statusCalls.push(String(claude_instance_id))
        return claude_instance_id === personaInstanceId(P) ? pAnswer : DEAD_ROW
      },
    }) as unknown as Client)
    const adapter = _buildIsSessionAliveAdapter(() => config)
    const personas = buildPersonaWorkList(config)
    const deps = makeDeps({ personas, connectedSequence: { [P]: [connected] }, maxTicks })
    deps.isSessionAlive = (key) => {
      deps.isSessionAliveCalls.push(key)
      return adapter(key)
    }
    deps.isLatched = (key) => latch.isLatched(key)
    deps.isAutoRestartDisabled = () => true
    const notified: Array<[string, string]> = []
    deps.notifyNotConnected = (key, why) => void notified.push([key, why])
    return { deps, notified, personas, statusCalls, adapter }
  }

  /** P's own-row `status` step line at the liveness read for an UNUSABLE NAME answer `err`. */
  const unusableStepLine = (err: unknown) => (outcome: string): string =>
    `[slack] isSessionAlive: status for persona=${P}: ${describeAdFailureForLog(err)} — UNUSABLE NAME: ${outcome}; nothing more is called for it (b.jg5 SRJ-105, SRJ-512)`
  /** P's own-row `status` step line at the liveness read for its `pending` row with no launch start. */
  const launchStartStepLine = (outcome: string): string =>
    `[slack] isSessionAlive: status for persona=${P}: its row read latches the persona (case=${LATCH_CASE_LAUNCH_START_NOT_RECORDED}, state=${AGENT_DIRECTOR_PENDING_STATE}) — ${outcome}; nothing more is called for it (b.jg5 SRJ-115, SRJ-501)`

  /** [label, P's status answer, P connected, P's expected record, its one post, its step line by outcome]. */
  const HOLD_CASES: ReadonlyArray<readonly [string, () => Error | ReturnType<typeof cannedStatusResult>, boolean, () => ConflictLatchRecord, () => string, (err: unknown) => (outcome: string) => string]> = [
    [`P's status answers UNUSABLE NAME (${ROW.name}), P disconnected`, () => ROW.build(), false, () => ROW.record(P), () => ROW.notice(P), unusableStepLine],
    ["P's own row pending, launch start absent, P connected with its stream", () => pendingRow(NO_LAUNCH_START_FORMS.absent), true, () => launchStartRecord(P), () => launchStartNotRecordedNoticeText(P), () => launchStartStepLine],
    ["P's own row pending, launch start null, P disconnected", () => pendingRow(NO_LAUNCH_START_FORMS.null), false, () => launchStartRecord(P), () => launchStartNotRecordedNoticeText(P), () => launchStartStepLine],
  ]

  test.each(HOLD_CASES)(
    '%s, on three ticks: P latches on the first and its notice is posted once; P is read each tick but never scheduled, no not-connected notice; B, read dead, is scheduled each tick',
    async (_label, answer, connected, record, notice, stepLineOf) => {
      const pAnswer = answer()
      const stepLine = stepLineOf(pAnswer)
      const { deps, notified, personas, statusCalls } = latchDeps(pAnswer, 3, connected)

      const lines = await capturingErrors(() => runTicks(deps, 3))

      expect(deps.isSessionAliveCalls).toEqual([P, B, P, B, P, B])
      expect(statusCalls).toEqual([P, B, P, B, P, B].map(personaInstanceId))
      const scheduledB = { key: B, cwd: personas[B]! }
      expect(deps.scheduleRestartCalls).toEqual([scheduledB, scheduledB, scheduledB])
      expect(notified).toEqual([])
      // Skipped on unknown, P's connection is never probed (B, read dead, neither).
      expect(deps.isSessionConnectedCalls).toEqual([])
      expect(latch.record(P)).toEqual(record())
      expect(latch.isLatched(B)).toBe(false)
      expect(posts).toEqual([{ key: P, text: notice() }])
      // The first tick's read latched P; the next two met the same case.
      expect(lines.filter((line) => line.startsWith(`[slack] isSessionAlive: status for persona=${P}: `))).toEqual([
        stepLine('the persona latched'),
        stepLine('the persona was already latched with this case'),
        stepLine('the persona was already latched with this case'),
      ])
      expect(latchLines.filter((line) => line.startsWith(`[slack] conflict-latch: persona=${P} latched`))).toHaveLength(1)
      expect(lines.filter((line) => line.startsWith(`[slack] health-check: liveness unknown for persona=${P}`))).toHaveLength(3)
      expect(notices).toEqual([])
      expect(getOutageFlags(P).size).toBe(0)
      assertNoLeak({ lines, latchLines, posts, notices })
    },
  )

  // A latch set elsewhere while the tick's read ran: the read answers dead,
  // which would schedule P at once, but the latch is asked again after it.
  test('P latched by another path while its tick\'s liveness read runs, the read answering dead: nothing scheduled for P; B is scheduled as today', async () => {
    const { deps, notified, personas, adapter } = latchDeps(DEAD_ROW, 1)
    deps.isSessionAlive = async (key) => {
      deps.isSessionAliveCalls.push(key)
      const reading = await adapter(key)
      if (key === P) latch.setFromUnusableName(P, ROW.build(), ROW.rowState)
      return reading
    }

    const lines = await capturingErrors(() => runTicks(deps, 1))

    expect(deps.isSessionAliveCalls).toEqual([P, B])
    expect(deps.scheduleRestartCalls).toEqual([{ key: B, cwd: personas[B]! }])
    expect(notified).toEqual([])
    expect(latch.isLatched(P)).toBe(true)
    expect(posts).toEqual([{ key: P, text: ROW.notice(P) }])
    assertNoLeak({ lines, latchLines, posts, notices })
  })

  // Control (b.jg5 SRJ-313): without the phrase the answer is not UNUSABLE
  // NAME: P latches no one and nothing is posted; E9's skip on `unknown`
  // stands on every tick.
  test('control: P\'s status answers a phrase-less ErrInternal on three ticks: no latch, no post; P is skipped on unknown each tick, never scheduled; B is scheduled each tick', async () => {
    const { deps, notified, personas } = latchDeps(errInternal(), 3)

    const lines = await capturingErrors(() => runTicks(deps, 3))

    expect(deps.isSessionAliveCalls).toEqual([P, B, P, B, P, B])
    const scheduledB = { key: B, cwd: personas[B]! }
    expect(deps.scheduleRestartCalls).toEqual([scheduledB, scheduledB, scheduledB])
    expect(notified).toEqual([])
    expect(latch.isLatched(P)).toBe(false)
    expect(latchLines).toEqual([])
    expect(posts).toEqual([])
    expect(lines.filter((line) => line.startsWith(`[slack] health-check: liveness unknown for persona=${P}`))).toHaveLength(3)
    expect(lines.filter((line) => line.includes('UNUSABLE NAME'))).toEqual([])
    assertNoLeak({ lines, latchLines, posts, notices })
  })

  // Control (b.jg5 SRJ-314, SRJ-408): with a launch start the row latches no
  // one; read `pending`, it is never healthy and takes the two-tick streak,
  // then scheduleRestart (whose run defers it), asking for the notice only
  // when disconnected.
  test.each<[string, boolean, Array<[string, string]>]>([
    ['connected with its stream', true, []],
    ['disconnected', false, [[P, 'disconnected']]],
  ])('control: P\'s own row pending with a launch start, P %s, on two ticks: no latch, no post; P is scheduled on its second tick, never its first; B is scheduled each tick', async (_conn, connected, expectedNotices) => {
    const { deps, notified, personas } = latchDeps(pendingRow(SAMPLE_LAUNCH_START_FRACTIONAL), 2, connected)

    const lines = await capturingErrors(() => runTicks(deps, 2))

    const scheduledB = { key: B, cwd: personas[B]! }
    expect(deps.scheduleRestartCalls).toEqual([scheduledB, { key: P, cwd: personas[P]! }, scheduledB])
    expect(deps.isSessionConnectedCalls).toEqual([P, P])
    expect(notified).toEqual(expectedNotices)
    expect(latch.isLatched(P)).toBe(false)
    expect(latchLines).toEqual([])
    expect(posts).toEqual([])
    expect(lines.filter((line) => line.includes('liveness unknown'))).toEqual([])
    assertNoLeak({ lines, latchLines, posts, notices })
  })
})
