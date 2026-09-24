/**
 * persona-relaunch-gate.test.ts — The relaunch gate (b.av2 SR-6.1: a persona
 * whose Slack connection is not serving is never launched by the restart
 * path) and its place in the health-check tick.
 *
 * Covers `createPersonaRelaunchGate` (src/persona-start.ts):
 *   - the truth table over every connection status, including a persona the
 *     manager does not know (its credentials or directory check failed), and
 *     with the bring-up outcomes (`isUp`) the server passes: a serving
 *     connection whose outcome is not up is refused;
 *   - its two lines: `its Slack connection is <state>` while the connection
 *     is not serving, `its bring-up has not succeeded` while it serves but the
 *     outcome is not `up`; each once per persona per reason (a change of
 *     reason logs again), re-armed once the persona is eligible, with no token
 *     in it;
 *   - end to end over the real connection manager (the shared connection
 *     harness), the real bring-up controller and the real health check with
 *     the gate as the work-list filter, wired as server.ts wires them: a
 *     persona whose first Slack attempt was unreachable at the start is left
 *     out of every tick; once the manager's retry brings it up, the
 *     controller launches it from that retry and the next tick schedules it.
 *
 * Also covers `composePersonaStatusListeners` (src/persona-start.ts): every
 * listener runs even when an earlier one throws or rejects, the result waits
 * for every listener to settle (even after one has failed), and it rejects
 * with the first failure by listener order, not by time.
 *
 * `launchSession`'s use of the gate (`'skipped'`) is pinned in
 * tests/session-manager.test.ts and restart.ts's handling of `'skipped'` in
 * tests/restart.test.ts; the work-list filter alone in tests/health-check.test.ts.
 *
 * Isolation (b.av2 SR-13.2): every path is under a `mkdtempSync` directory
 * removed in afterEach; tokens are sentinel-bearing fakes and the token
 * environment variables hold fakes for the whole file. The health check runs
 * on a short real interval, one tick at a time, and is reset after each test.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _resetHealthCheckState, buildPersonaWorkList, initHealthCheck, startHealthCheck } from '../src/health-check.ts'
import { _resetOutageState, getOutageFlags, initOutageState } from '../src/outage-state.ts'
import { createPersonaBringUpController, type PersonaBringUpController } from '../src/persona-bringup-controller.ts'
import type { PersonaConnectionManager, PersonaConnectionStatus, PersonaStatusListener } from '../src/persona-connections.ts'
import { composePersonaStatusListeners, createPersonaRelaunchGate } from '../src/persona-start.ts'
import { APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { makeConnectionHarness } from './test-helpers/persona-connection-harness.ts'

const ENV_KEYS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const

let dir: string
let savedEnv: Array<readonly [string, string | undefined]>
let managers: PersonaConnectionManager[]
let controllers: PersonaBringUpController[]

beforeEach(() => {
  savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  process.env['SLACK_BOT_TOKEN'] = fakeToken(BOT_TOKEN_PREFIX, 'env')
  process.env['SLACK_APP_TOKEN'] = fakeToken(APP_TOKEN_PREFIX, 'env')
  dir = mkdtempSync(join(tmpdir(), 'cscb-relaunch-gate-'))
  managers = []
  controllers = []
  _resetHealthCheckState()
  _resetOutageState()
  initOutageState({ notify: () => {}, getClient: () => null as never })
})

afterEach(async () => {
  _resetHealthCheckState()
  _resetOutageState()
  for (const c of controllers) c.cancelAll()
  await Promise.all(managers.map((m) => m.stopAll()))
  rmSync(dir, { recursive: true, force: true })
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** The gate's line for a persona whose connection is in `state`. */
const gateLine = (key: string, state: string) =>
  `[slack] persona=${key}: not relaunched — its Slack connection is ${state}; eligible again once it is up`

/** The gate's line for a persona whose connection serves but whose bring-up outcome is not `up`. */
const bringUpLine = (key: string) =>
  `[slack] persona=${key}: not relaunched — its bring-up has not succeeded; eligible again once it is up`

// Status fixtures: only `state` and `phase` matter to the gate.
const UNREACHABLE = { kind: 'slack-unreachable' } as never
const REFUSED = { kind: 'credentials-refused' } as never
const UP: PersonaConnectionStatus = { state: 'up', identity: { botUserId: 'U0GATE', botId: 'B0GATE' } }
const CONNECTING: PersonaConnectionStatus = { state: 'connecting' }

// ---------------------------------------------------------------------------
// Truth table and line
// ---------------------------------------------------------------------------

describe('createPersonaRelaunchGate: true only while the persona\'s connection is serving', () => {
  test.each<[string, boolean, PersonaConnectionStatus | undefined, string | undefined]>([
    ['up', true, UP, undefined],
    ['lost (the Web API still serves)', true, { state: 'lost' }, undefined],
    ['retrying a reopen', true, { state: 'retrying', phase: 'reopen', outcome: UNREACHABLE, retryInMs: 5_000, nextAttemptAt: 5_000 }, undefined],
    ['unknown to the manager (a failed credentials or directory check)', false, undefined, 'not brought up'],
    ['connecting', false, CONNECTING, 'connecting'],
    ['retrying its bring-up', false, { state: 'retrying', phase: 'bring-up', outcome: UNREACHABLE, retryInMs: 5_000, nextAttemptAt: 5_000 }, 'retrying its bring-up'],
    ['broken at bring-up', false, { state: 'broken', phase: 'bring-up', outcome: REFUSED }, 'broken'],
    ['broken at a reopen', false, { state: 'broken', phase: 'reopen', outcome: REFUSED }, 'broken'],
    ['stopped', false, { state: 'stopped' }, 'stopped'],
  ])('%s → may relaunch: %p', (_label, allowed, status, state) => {
    const lines: string[] = []
    const asked: string[] = []
    const canRelaunch = createPersonaRelaunchGate({ status: (key) => (asked.push(key), status) }, (line) => void lines.push(line))

    expect(canRelaunch('persona_a')).toBe(allowed)

    expect(asked).toEqual(['persona_a'])
    expect(lines).toEqual(state === undefined ? [] : [gateLine('persona_a', state)])
  })

  test('the line is logged once per persona per non-serving state; serving again re-arms it; personas are independent', () => {
    const statuses = new Map<string, PersonaConnectionStatus>()
    const lines: string[] = []
    const canRelaunch = createPersonaRelaunchGate({ status: (key) => statuses.get(key) }, (line) => void lines.push(line))

    expect([canRelaunch('persona_a'), canRelaunch('persona_a')]).toEqual([false, false])
    statuses.set('persona_a', CONNECTING)
    expect([canRelaunch('persona_a'), canRelaunch('persona_a')]).toEqual([false, false])
    expect(canRelaunch('persona_b')).toBe(false)
    statuses.set('persona_a', UP)
    expect(canRelaunch('persona_a')).toBe(true)
    statuses.set('persona_a', CONNECTING)
    expect(canRelaunch('persona_a')).toBe(false)

    expect(lines).toEqual([
      gateLine('persona_a', 'not brought up'),
      gateLine('persona_a', 'connecting'),
      gateLine('persona_b', 'not brought up'),
      gateLine('persona_a', 'connecting'),
    ])
  })

  // With the bring-up outcomes (server.ts passes the bring-up controller), both must agree.
  // A connection that is not serving is named first; a serving one with an outcome not `up` names the bring-up.
  test.each<[string, PersonaConnectionStatus | undefined, boolean, boolean, string | undefined]>([
    ['serving and up', UP, true, true, undefined],
    ['serving but its outcome is not up (unknown to the controller, or broken or retrying there)', UP, false, false, bringUpLine('persona_a')],
    ['lost (still serving) but its outcome is not up', { state: 'lost' }, false, false, bringUpLine('persona_a')],
    ['up per the controller but its connection is retrying its bring-up', { state: 'retrying', phase: 'bring-up', outcome: UNREACHABLE, retryInMs: 5_000, nextAttemptAt: 5_000 }, true, false, gateLine('persona_a', 'retrying its bring-up')],
    ['unknown to the manager, outcome not up', undefined, false, false, gateLine('persona_a', 'not brought up')],
    ['unknown to the manager, outcome up', undefined, true, false, gateLine('persona_a', 'not brought up')],
    ['connecting and its outcome is not up', CONNECTING, false, false, gateLine('persona_a', 'connecting')],
  ])('with outcomes: %s → may relaunch: %p', (_label, status, isUp, allowed, line) => {
    const lines: string[] = []
    const canRelaunch = createPersonaRelaunchGate({ status: () => status }, (l) => void lines.push(l), { isUp: () => isUp })

    expect(canRelaunch('persona_a')).toBe(allowed)
    expect(lines).toEqual(line === undefined ? [] : [line])
  })

  test('with outcomes: each reason logs once per persona; a change of reason logs again; being up re-arms it; personas are independent', () => {
    const statuses = new Map<string, PersonaConnectionStatus>()
    const up = new Set<string>()
    const lines: string[] = []
    const canRelaunch = createPersonaRelaunchGate(
      { status: (key) => statuses.get(key) },
      (line) => void lines.push(line),
      { isUp: (key) => up.has(key) },
    )
    const ask = (key: string, times = 2) => Array.from({ length: times }, () => canRelaunch(key))

    // Serving, outcome not up: the bring-up reason, once.
    statuses.set('persona_a', UP)
    expect(ask('persona_a')).toEqual([false, false])
    // The connection drops out of serving: the connection reason, once.
    statuses.set('persona_a', CONNECTING)
    expect(ask('persona_a')).toEqual([false, false])
    // Serving again, outcome still not up: back to the bring-up reason, logged again.
    statuses.set('persona_a', UP)
    expect(ask('persona_a')).toEqual([false, false])
    // B is independent: its own bring-up line although A's reason is the same.
    statuses.set('persona_b', UP)
    expect(ask('persona_b')).toEqual([false, false])
    // A is up: eligible, silent; then its outcome is no longer up: the same reason logs again.
    up.add('persona_a')
    expect(ask('persona_a')).toEqual([true, true])
    up.delete('persona_a')
    expect(ask('persona_a')).toEqual([false, false])

    expect(lines).toEqual([
      bringUpLine('persona_a'),
      gateLine('persona_a', 'connecting'),
      bringUpLine('persona_a'),
      bringUpLine('persona_b'),
      bringUpLine('persona_a'),
    ])
    assertNoLeak({ lines })
  })
})

// ---------------------------------------------------------------------------
// composePersonaStatusListeners
// ---------------------------------------------------------------------------

describe('composePersonaStatusListeners: every listener runs; the result rejects with the first failure', () => {
  /** Call the composed listener and hand back its result as a promise (the listener type returns void). */
  const run = (listener: PersonaStatusListener, key: string, status: PersonaConnectionStatus) =>
    listener(key, status) as unknown as Promise<void>

  test('every listener gets (key, status) in order; the result resolves undefined once every listener has settled', async () => {
    const calls: Array<[string, string, PersonaConnectionStatus]> = []
    let release!: () => void
    const slow = new Promise<void>((resolve) => (release = resolve))
    let settled = false
    const composed = composePersonaStatusListeners(
      (key, status) => void calls.push(['first', key, status]),
      (key, status) => (calls.push(['second', key, status]), slow) as unknown as void,
      (key, status) => void calls.push(['third', key, status]),
    )

    const result = run(composed, 'persona_a', UP).then((value) => ((settled = true), value))

    expect(calls).toEqual([
      ['first', 'persona_a', UP],
      ['second', 'persona_a', UP],
      ['third', 'persona_a', UP],
    ])
    await new Promise((r) => setTimeout(r, 5))
    expect(settled).toBe(false)
    release()
    expect(await result).toBeUndefined()
  })

  test('a first listener that rejects: the second is still called with (key, status); the result rejects with the first error', async () => {
    const first = new Error('first listener failed')
    const second: Array<[string, PersonaConnectionStatus]> = []
    const composed = composePersonaStatusListeners(
      () => Promise.reject(first) as unknown as void,
      (key, status) => void second.push([key, status]),
    )

    const result = run(composed, 'persona_a', CONNECTING)

    expect(second).toEqual([['persona_a', CONNECTING]])
    await expect(result).rejects.toBe(first)
  })

  test('a first listener that throws synchronously: the composed call does not throw, the second is still called, the result rejects with that error', async () => {
    const first = new Error('first listener threw')
    const second: Array<[string, PersonaConnectionStatus]> = []
    const composed = composePersonaStatusListeners(
      () => {
        throw first
      },
      (key, status) => void second.push([key, status]),
    )

    let result: Promise<void> | undefined
    expect(() => {
      result = run(composed, 'persona_a', UP)
    }).not.toThrow()

    expect(second).toEqual([['persona_a', UP]])
    await expect(result!).rejects.toBe(first)
  })

  test('a listener rejects while an earlier one is still pending: the result does not settle until the pending one settles, then rejects with the rejecting listener\'s error', async () => {
    const failure = new Error('second listener failed')
    let release!: () => void
    const slow = new Promise<void>((resolve) => (release = resolve))
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending'
    // Read through a function: the callbacks assign it, which TypeScript's narrowing does not see.
    const currentOutcome = () => outcome
    const composed = composePersonaStatusListeners(
      () => slow as unknown as void,
      () => Promise.reject(failure) as unknown as void,
    )

    const result = run(composed, 'persona_a', UP)
    result.then(
      () => void (outcome = 'resolved'),
      () => void (outcome = 'rejected'),
    )

    await new Promise((r) => setTimeout(r, 5))
    expect(currentOutcome()).toBe('pending')
    release()
    await expect(result).rejects.toBe(failure)
    expect(currentOutcome()).toBe('rejected')
  })

  test('the first failure is by listener order, not time: listener 1 rejects after listener 2 has thrown synchronously, and the result rejects with listener 1\'s error', async () => {
    const first = new Error('first listener failed later')
    const second = new Error('second listener threw at once')
    const order: string[] = []
    const composed = composePersonaStatusListeners(
      () =>
        new Promise<void>((_resolve, reject) =>
          setTimeout(() => {
            order.push('first rejected')
            reject(first)
          }, 5),
        ) as unknown as void,
      () => {
        order.push('second threw')
        throw second
      },
    )

    let result: Promise<void> | undefined
    expect(() => {
      result = run(composed, 'persona_a', UP)
    }).not.toThrow()

    await expect(result!).rejects.toBe(first)
    expect(order).toEqual(['second threw', 'first rejected'])
  })

  test('listener 1 returns an already-rejected promise and listener 2 throws synchronously: the result rejects with listener 1\'s error', async () => {
    const first = new Error('first listener rejected')
    const second = new Error('second listener threw')
    const composed = composePersonaStatusListeners(
      () => Promise.reject(first) as unknown as void,
      () => {
        throw second
      },
    )

    let result: Promise<void> | undefined
    expect(() => {
      result = run(composed, 'persona_a', UP)
    }).not.toThrow()

    await expect(result!).rejects.toBe(first)
  })
})

// ---------------------------------------------------------------------------
// End to end: the gate filters the health-check tick
// ---------------------------------------------------------------------------

/**
 * Start the real health check over `getPersonas` with every session dead, so
 * each persona in a tick's work list is scheduled. Ticks run one at a time:
 * `tick()` lets exactly one more tick body run and waits for it.
 */
function startTicks(getPersonas: () => Record<string, string>) {
  let allowed = 0
  let ticks = 0
  const calls = { stat: [] as string[], alive: [] as string[], scheduled: [] as string[] }
  initHealthCheck({
    isSessionAlive: async (key) => (calls.alive.push(key), false),
    isSessionConnected: () => false,
    hasSessionStream: () => false,
    isRestartPendingOrActive: () => false,
    isAtCap: () => false,
    statRoute: async (cwd) => (calls.stat.push(cwd), false),
    scheduleRestart: (key) => void calls.scheduled.push(key),
    isShuttingDown: () => ticks >= allowed,
    getPersonas: () => {
      ticks++
      return getPersonas()
    },
  })
  startHealthCheck(0.002)
  async function tick(): Promise<void> {
    allowed++
    for (let waited = 0; ticks < allowed && waited < 500; waited++) await new Promise((r) => setTimeout(r, 1))
    expect(ticks).toBe(allowed)
    // The tick body awaits only settled promises; let it finish.
    await new Promise((r) => setTimeout(r, 10))
  }
  return { calls, tick }
}

describe('end to end: the relaunch gate on the health-check work list', () => {
  test('a persona whose first Slack attempt was unreachable is left out of every tick (no stat, no probe, no restart); once the manager\'s retry brings it up, the controller launches it and the next tick schedules it', async () => {
    const h = makeConnectionHarness([{ name: 'Alpha Desk' }, { name: 'Beta Ops' }], dir, {
      files: true,
      stubOptions: { 'Alpha Desk': { authTest: [{ kind: 'network' }] } },
    })
    managers.push(h.manager)
    const [a, b] = h.personas
    const lines: string[] = []
    const log = (line: string) => void lines.push(line)

    // The server's wiring: the bring-up controller as the manager's status listener, recording its launches.
    const launches: string[] = []
    const controller = createPersonaBringUpController({
      connections: h.manager,
      dryRun: false,
      log,
      clock: h.clock,
      launch: async (persona) => void launches.push(persona.key),
    })
    controllers.push(controller)
    h.onStatus = (key, status) => controller.onConnectionStatus(key, status)

    // The start's steps 1–3: A is retrying (the manager keeps retrying it); B is up.
    expect(await controller.bringUp(a, h.personas)).toMatchObject({
      outcome: 'retrying',
      failures: [{ step: 'slack', class: 'persona-slack-unreachable' }],
    })
    expect(await controller.bringUp(b, h.personas)).toEqual({ outcome: 'up', failures: [] })

    // The gate over the manager and the controller filters the tick's work list.
    const canRelaunch = createPersonaRelaunchGate(h.manager, log, controller)
    const { calls, tick } = startTicks(() => buildPersonaWorkList(h.config!, canRelaunch))

    await tick()
    await tick()
    expect(calls.scheduled).toEqual([b.key, b.key])
    expect(calls.alive).toEqual([b.key, b.key])
    expect(calls.stat).toEqual([b.working_directory, b.working_directory])
    // A is absent from the whole tick: not even its cwd-unreachable flag is raised.
    expect(getOutageFlags(a.key).size).toBe(0)
    expect(lines.filter((line) => line.startsWith('[slack] persona=')).filter((line) => line.includes(a.key))).toEqual([
      gateLine(a.key, 'retrying its bring-up'),
    ])

    expect(launches).toEqual([])

    // The manager's retry, 5 s later on its clock, brings A up; the controller launches it from there, before any tick.
    await h.clock.advance(5_000)
    expect(h.manager.status(a.key)?.state).toBe('up')
    expect(controller.isUp(a.key)).toBe(true)
    expect(launches).toEqual([a.key])

    await tick()
    expect(calls.scheduled).toEqual([b.key, b.key, a.key, b.key])
    expect(calls.stat.slice(2)).toEqual([a.working_directory, b.working_directory])
    assertNoLeak({ lines, managerLines: h.lines, calls })
  })
})
