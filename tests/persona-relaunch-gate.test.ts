/**
 * persona-relaunch-gate.test.ts — The relaunch gate (b.av2 SR-6.1: a persona
 * whose Slack connection is not serving is never launched by the restart
 * path) and its place in the health-check tick.
 *
 * Covers `createPersonaRelaunchGate` (src/persona-start.ts):
 *   - the truth table over every connection status, including a persona the
 *     manager does not know (its credentials or directory check failed);
 *   - its line: once per persona per non-serving state, re-armed once the
 *     persona serves again, with no token in it;
 *   - end to end over the real connection manager (the shared connection
 *     harness) and the real health check with the gate as the work-list
 *     filter: a persona whose first Slack attempt was unreachable at the start
 *     is left out of every tick; once the manager's retry brings it up, the
 *     next tick schedules it.
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
import type { PersonaConnectionManager, PersonaConnectionStatus } from '../src/persona-connections.ts'
import { connectPersona, createPersonaRelaunchGate } from '../src/persona-start.ts'
import { APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { makeConnectionHarness } from './test-helpers/persona-connection-harness.ts'

const ENV_KEYS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const

let dir: string
let savedEnv: Array<readonly [string, string | undefined]>
let managers: PersonaConnectionManager[]

beforeEach(() => {
  savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  process.env['SLACK_BOT_TOKEN'] = fakeToken(BOT_TOKEN_PREFIX, 'env')
  process.env['SLACK_APP_TOKEN'] = fakeToken(APP_TOKEN_PREFIX, 'env')
  dir = mkdtempSync(join(tmpdir(), 'cscb-relaunch-gate-'))
  managers = []
  _resetHealthCheckState()
  _resetOutageState()
  initOutageState({ notify: () => {}, getClient: () => null as never })
})

afterEach(async () => {
  _resetHealthCheckState()
  _resetOutageState()
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
  test('a persona whose first Slack attempt was unreachable is left out of every tick (no stat, no probe, no restart); once the manager\'s retry brings it up, the next tick schedules it', async () => {
    const h = makeConnectionHarness([{ name: 'Alpha Desk' }, { name: 'Beta Ops' }], dir, {
      files: true,
      stubOptions: { 'Alpha Desk': { authTest: [{ kind: 'network' }] } },
    })
    managers.push(h.manager)
    const [a, b] = h.personas
    const lines: string[] = []
    const log = (line: string) => void lines.push(line)

    // The start's steps 1–3: A is not brought up (the manager keeps retrying it); B is.
    const deps = { applied: h.personas, dryRun: false, log, connections: h.connections }
    expect(await connectPersona(a, deps)).toMatchObject({
      outcome: 'not-brought-up',
      failures: [{ step: 'slack', class: 'persona-slack-unreachable' }],
    })
    expect(await connectPersona(b, deps)).toEqual({ outcome: 'connected' })

    // The server's wiring: the gate over the manager filters the tick's work list.
    const canRelaunch = createPersonaRelaunchGate(h.manager, log)
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

    // The manager's retry, 5 s later on its clock, brings A up.
    await h.clock.advance(5_000)
    expect(h.manager.status(a.key)?.state).toBe('up')

    await tick()
    expect(calls.scheduled).toEqual([b.key, b.key, a.key, b.key])
    expect(calls.stat.slice(2)).toEqual([a.working_directory, b.working_directory])
    assertNoLeak({ lines, managerLines: h.lines, calls })
  })
})
