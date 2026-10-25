/**
 * displayed-states-liveness.test.ts — agent-director's Displayed States
 * (`needs_intelligence` over raw `check_permission`, `idle_screen` over raw
 * `working`) read through the client CSCB installs (`setClient`) behave as
 * their raw states on the liveness and recovery paths: the health tick's
 * liveness read and the bring-up collision ladder. Each displayed state runs
 * beside its raw state as the control.
 *
 * SPDX-License-Identifier: MIT
 */

import type { Client } from 'agent-director'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetClientForTests, setClient } from '../src/agent-director-client.ts'
import {
  _resetHealthCheckState,
  _runHealthCheckTickForTest,
  buildPersonaWorkList,
  initHealthCheck,
  type HealthCheckDeps,
} from '../src/health-check.ts'
import { LIVENESS_READING_LIVE } from '../src/liveness-reading.ts'
import { _resetOutageState, getOutageFlags, initOutageState, setOutageFlag } from '../src/outage-state.ts'
import { personaInstanceId } from '../src/persona-identity.ts'
import { _buildIsSessionAliveAdapter } from '../src/server.ts'
import { cannedErr, cannedStatusResult, errInstanceIdCollision, makeStubClient } from './test-helpers/agent-director-stub.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { useImmediateTypingLifecycle } from './test-helpers/legacy-typing.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeRecoveryHarness, personaRow, type RecoveryHarness } from './test-helpers/recovery-harness.ts'
useImmediateTypingLifecycle()

/** [state agent-director answers, the raw state it shows over]; each raw state is its own control. */
const STATES = [
  ['check_permission', 'check_permission'],
  ['needs_intelligence', 'check_permission'],
  ['working', 'working'],
  ['idle_screen', 'working'],
] as const

/** Install `client` as CSCB's agent-director client, through the production installer. */
function install(client: unknown): void {
  setClient(client as Client)
}

/** Run `work` with `console.error` recorded; answers the lines. */
async function capturingErrors(work: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const saved = console.error
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  try {
    await work()
  } finally {
    console.error = saved
  }
  return lines
}

describe('health tick: a displayed state reads live, as its raw state', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'cscb-displayed-health-'))
    _resetHealthCheckState()
    _resetOutageState()
    initOutageState({ notify: () => {}, getClient: () => null as never })
  })

  afterEach(() => {
    resetClientForTests()
    _resetHealthCheckState()
    _resetOutageState()
    rmSync(baseDir, { recursive: true, force: true })
  })

  /** Deps over the real liveness adapter for one persona whose `status` answers `state`; connected as given. */
  function tickDeps(state: string, connected: boolean) {
    const config = makeMultiPersonaConfig([{ name: 'P' }], baseDir)
    const key = config.personas[0]!.key
    const statusCalls: string[] = []
    install(makeStubClient({ statusFn: ({ instance_id }) => { statusCalls.push(String(instance_id)); return cannedStatusResult({ state }) } }))
    const adapter = _buildIsSessionAliveAdapter(() => config)
    const personas = buildPersonaWorkList(config)
    const scheduled: Array<{ key: string; cwd: string }> = []
    const healthy: string[] = []
    const deps: HealthCheckDeps = {
      isSessionAlive: adapter,
      isSessionConnected: () => connected,
      isRestartPendingOrActive: () => false,
      isAtCap: () => false,
      statRoute: async () => true,
      scheduleRestart: (k, cwd) => void scheduled.push({ key: k, cwd }),
      isShuttingDown: () => false,
      getPersonas: () => personas,
      resetSlowRecoveryCount: (k) => void healthy.push(k),
    }
    initHealthCheck(deps)
    return { key, cwd: personas[key]!, adapter, statusCalls, scheduled, healthy }
  }

  test.each(STATES)('status answers %s (raw %s), session connected: the adapter reads live and two ticks take the healthy branch, clearing tmux-unavailable; nothing scheduled', async (state) => {
    const { key, adapter, statusCalls, scheduled, healthy } = tickDeps(state, true)
    setOutageFlag(key, 'tmux-unavailable')
    let reading: unknown
    const lines = await capturingErrors(async () => {
      reading = await adapter(key)
      await _runHealthCheckTickForTest()
      await _runHealthCheckTickForTest()
    })
    expect(reading).toEqual(LIVENESS_READING_LIVE)
    expect(statusCalls).toEqual(Array(3).fill(personaInstanceId(key)))
    expect(healthy).toEqual([key, key])
    expect(getOutageFlags(key).size).toBe(0)
    expect(scheduled).toHaveLength(0)
    expect(lines).toHaveLength(0)
    assertNoLeak({ lines })
  })

  test.each(STATES)('status answers %s (raw %s), session disconnected: the second tick schedules its restart (the reconnect)', async (state) => {
    const { key, cwd, scheduled, healthy } = tickDeps(state, false)
    const lines = await capturingErrors(async () => {
      await _runHealthCheckTickForTest()
      expect(scheduled).toHaveLength(0)
      await _runHealthCheckTickForTest()
    })
    expect(scheduled).toEqual([{ key, cwd }])
    expect(healthy).toHaveLength(0)
    expect(lines).toHaveLength(0)
    assertNoLeak({ lines })
  })
})

describe('bring-up collision ladder: a displayed state takes its raw state\'s branch', () => {
  const runs: RecoveryHarness[] = []
  afterEach(() => {
    for (const h of runs.splice(0)) {
      try {
        assertNoLeak(h.captured())
      } finally {
        h.cleanup()
      }
    }
  })

  /**
   * A harness whose persona P's optimistic spawn collides with its own row
   * reading `state`. Its first `status` read answers `state` too; from then
   * on every `get` and `status` read answers `waiting`, as a turn that ends.
   */
  function collidedOn(state: string) {
    const h = makeRecoveryHarness({ personas: [{}] })
    runs.push(h)
    const p = h.keys[0]!
    h.config.agent_director_poll_interval_ms = 1
    let rowState: string = state
    h.script({
      spawnQueue: [cannedErr(errInstanceIdCollision())],
      getFn: () => personaRow(h, p, { state: rowState }),
      statusFn: () => {
        const answered = rowState
        rowState = 'waiting'
        return cannedStatusResult({ state: answered })
      },
    })
    install(h.stub.client)
    return { h, p }
  }

  const reconnectTexts = (h: RecoveryHarness): string[] =>
    h.stub.calls.sendKeysCalls.map((call) => String(call.text)).filter((text) => text.includes('/mcp reconnect'))

  test.each(STATES.filter(([, raw]) => raw === 'working'))('collision row reads %s (raw %s): the ladder waits for waiting, then reconnects', async (state) => {
    const { h, p } = collidedOn(state)
    const result = await h.launch(p)
    await h.settle()
    expect(result).toEqual({ key: p, action: 'reconnected' })
    expect(h.stub.calls.statusCalls).toHaveLength(2)
    expect(reconnectTexts(h)).toHaveLength(1)
    expect(h.stub.calls.spawnCalls).toHaveLength(1)
    expect(h.stub.calls.killCalls).toHaveLength(0)
    expect(h.stub.calls.resumeCalls).toHaveLength(0)
    expect(h.errors.filter((line) => line.includes('unexpected state='))).toHaveLength(0)
  })

  test.each(STATES.filter(([, raw]) => raw === 'check_permission'))('collision row reads %s (raw %s): the ladder checks the prompt row\'s pane and types nothing', async (state) => {
    const { h, p } = collidedOn(state)
    const result = await h.launch(p)
    await h.settle()
    expect(result).toEqual({ key: p, action: 'no-op' })
    expect(h.stub.calls.readPaneCalls.map((call) => call.instance_id)).toEqual([personaInstanceId(p)])
    expect(h.stub.calls.sendKeysCalls).toHaveLength(0)
    expect(h.stub.calls.spawnCalls).toHaveLength(1)
    expect(h.stub.calls.killCalls).toHaveLength(0)
    expect(h.stub.calls.resumeCalls).toHaveLength(0)
    expect(h.errors.filter((line) => line.includes('unexpected state='))).toHaveLength(0)
  })
})
