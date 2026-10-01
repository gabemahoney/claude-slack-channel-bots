/**
 * session-disconnect.test.ts — the session-disconnect handler
 * (`_buildRestartDisconnectedPersona`) and the `tmux-unavailable` retry check
 * it decides through (`armMissingTmuxUnavailableRetry`), both called directly
 * over recording dependencies (b.jg5 SRJ-311, SRJ-502, SRJ-315, SRJ-1501).
 *
 * - The check: the first branch that applies, in its order (the flag not
 *   raised; a timer armed; latched; work in flight; no controller; else it
 *   logs its arm line and arms once), with exactly the asks each branch makes
 *   (the armed read made once, before the latch and in-flight checks; a
 *   missing controller told apart from "not armed" only after them).
 * - The handler: a key that is not an applied persona gets one line and
 *   nothing more; otherwise it logs the persona and its working directory;
 *   while shutting down it logs one skip line and does nothing more, flag
 *   raised or not; with the flag not raised it schedules the restart in the
 *   persona's working directory; with it raised it schedules none and logs
 *   one line per branch, arming the timer only in the last.
 *
 * The handler's lines are built from their parts (`via`, the persona's
 * `renderPersonaRef` and the raised-outage head); the branch table holds the
 * only literal suffixes. Which production holders `server.ts` binds into the
 * one handler and the routing's arm is pinned by the source audit in
 * tests/server-startup-wiring.test.ts; what an arm does through the real
 * controller is tested in tests/unavailable-retry.test.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Persona } from '../src/config.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import {
  _buildRestartDisconnectedPersona,
  armMissingTmuxUnavailableRetry,
  type RestartDisconnectedPersonaDeps,
  type TmuxUnavailableRetryBranch,
} from '../src/server.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'

/** What the recording dependencies answer; every ask is recorded by member name. */
interface RigState {
  persona?: Persona
  raised?: boolean
  armed?: boolean | undefined
  latched?: boolean
  inFlight?: boolean
  shuttingDown?: boolean
}

/** Recording dependencies of the handler (and so of the check). */
interface Rig {
  readonly deps: RestartDisconnectedPersonaDeps
  /** Every member asked or called, by name, in order. */
  readonly asks: string[]
  readonly logs: string[]
  readonly restarts: Array<[string, string]>
  readonly arms: string[]
}

function makeRig(state: RigState): Rig {
  const asks: string[] = []
  const logs: string[] = []
  const restarts: Array<[string, string]> = []
  const arms: string[] = []
  const deps: RestartDisconnectedPersonaDeps = {
    getPersona: (key) => (asks.push('getPersona'), state.persona?.key === key ? state.persona : undefined),
    isShuttingDown: () => (asks.push('isShuttingDown'), state.shuttingDown ?? false),
    isTmuxUnavailable: () => (asks.push('isTmuxUnavailable'), state.raised ?? false),
    isRetryArmed: () => (asks.push('isRetryArmed'), 'armed' in state ? state.armed : false),
    isLatched: () => (asks.push('isLatched'), state.latched ?? false),
    isWorkInFlight: () => (asks.push('isWorkInFlight'), state.inFlight ?? false),
    armRetryTimer: (key) => {
      asks.push('armRetryTimer')
      arms.push(key)
    },
    scheduleRestart: (key, cwd) => {
      asks.push('scheduleRestart')
      restarts.push([key, cwd])
    },
    log: (line) => {
      asks.push('log')
      logs.push(line)
    },
  }
  return { deps, asks, logs, restarts, arms }
}

let dir: string
let persona: Persona

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cscb-session-disconnect-'))
  // A display name whose key differs, so the persona reference shows both.
  persona = makeMultiPersonaConfig([{ name: 'Disconnect Bot' }], dir).personas[0]!
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The asks the check makes before deciding, in its order. */
const CHECK_ASKS = ['isTmuxUnavailable', 'isRetryArmed', 'isLatched', 'isWorkInFlight'] as const

describe('armMissingTmuxUnavailableRetry: the first branch that applies, in order, with only the asks it needs (b.jg5 SRJ-311)', () => {
  const ARM_LINE = 'the arm line'

  // Each row sets every later check to the answer that would pick another
  // branch, so a reordered check fails the row.
  test.each<[string, RigState, TmuxUnavailableRetryBranch, number]>([
    ['the flag not raised (armed false, latched, in flight)', { raised: false, armed: false, latched: true, inFlight: true }, 'not-raised', 1],
    ['a timer armed (latched, in flight)', { raised: true, armed: true, latched: true, inFlight: true }, 'retry-armed', 2],
    ['latched, not armed (in flight)', { raised: true, armed: false, latched: true, inFlight: true }, 'latched', 3],
    ['latched, no controller (in flight)', { raised: true, armed: undefined, latched: true, inFlight: true }, 'latched', 3],
    ['in flight, not armed', { raised: true, armed: false, latched: false, inFlight: true }, 'in-flight', 4],
    ['in flight, no controller', { raised: true, armed: undefined, latched: false, inFlight: true }, 'in-flight', 4],
    ['no controller', { raised: true, armed: undefined, latched: false, inFlight: false }, 'no-controller', 4],
  ])('%s: answers %s, asks only the first checks, logs and arms nothing', (_what, state, branch, asked) => {
    const rig = makeRig(state)
    expect(armMissingTmuxUnavailableRetry(persona.key, rig.deps, ARM_LINE)).toBe(branch)
    expect(rig.asks).toEqual(CHECK_ASKS.slice(0, asked))
    expect([rig.logs, rig.arms]).toEqual([[], []])
  })

  test('raised, not armed, not latched, nothing in flight: logs the arm line, then arms the persona\'s timer once, and answers armed; the armed read is made once', () => {
    const rig = makeRig({ raised: true, armed: false, latched: false, inFlight: false })
    expect(armMissingTmuxUnavailableRetry(persona.key, rig.deps, ARM_LINE)).toBe('armed')
    expect(rig.asks).toEqual([...CHECK_ASKS, 'log', 'armRetryTimer'])
    expect([rig.logs, rig.arms]).toEqual([[ARM_LINE], [persona.key]])
  })
})

describe('_buildRestartDisconnectedPersona: the session-disconnect handler (b.jg5 SRJ-311, SRJ-502, SRJ-315)', () => {
  const VIA = ' (SSE abort)'

  /** The persona's disconnect line, naming its working directory. */
  const cwdLine = (via: string): string =>
    `[slack] Session disconnected${via}: persona ${renderPersonaRef(persona.name, persona.key)} cwd="${persona.working_directory}"`
  /** The head of every raised-outage line. */
  const head = (via: string): string =>
    `[slack] Session disconnected${via}: persona ${renderPersonaRef(persona.name, persona.key)} has its tmux-unavailable outage raised`

  test.each(['', VIA])('a key that is not an applied persona (via %p): one line naming the key, nothing else asked, no restart, no arm', (via) => {
    const rig = makeRig({ raised: true, armed: false })
    _buildRestartDisconnectedPersona(rig.deps)(persona.key, via)
    expect(rig.logs).toEqual([`[slack] Session disconnected${via}: persona=${persona.key} is not an applied persona`])
    expect(rig.asks).toEqual(['getPersona', 'log'])
    expect([rig.restarts, rig.arms]).toEqual([[], []])
  })

  test.each([false, true])('while the server is shutting down (flag raised: %p): the persona line, then one skip line, and nothing more: no flag read, no restart, no arm', (raised) => {
    const rig = makeRig({ persona, raised, armed: false, shuttingDown: true })
    _buildRestartDisconnectedPersona(rig.deps)(persona.key, VIA)
    expect(rig.logs).toEqual([cwdLine(VIA), `[slack] Skipping restart — server is shutting down (persona=${persona.key})`])
    expect(rig.asks).toEqual(['getPersona', 'log', 'isShuttingDown', 'log'])
    expect([rig.restarts, rig.arms]).toEqual([[], []])
  })

  test.each(['', VIA])('the flag not raised (via %p): the persona line, then the restart scheduled for the persona in its working directory, and nothing else asked', (via) => {
    const rig = makeRig({ persona, raised: false, armed: false })
    _buildRestartDisconnectedPersona(rig.deps)(persona.key, via)
    expect(rig.logs).toEqual([cwdLine(via)])
    expect(rig.restarts).toEqual([[persona.key, persona.working_directory]])
    expect(rig.asks).toEqual(['getPersona', 'log', 'isShuttingDown', 'isTmuxUnavailable', 'scheduleRestart'])
    expect(rig.arms).toEqual([])
  })

  // The one place this file holds the handler's literal suffixes.
  test.each<[string, RigState, string]>([
    ['a timer armed', { armed: true }, ' — no restart scheduled; its retry timer recovers it (b.jg5 SRJ-311)'],
    ['latched', { armed: false, latched: true }, ' and is latched — no restart scheduled, no retry timer armed (b.jg5 SRJ-311, SRJ-502)'],
    ['work in flight', { armed: false, inFlight: true }, ' with work in flight — no restart scheduled, no retry timer armed (b.jg5 SRJ-311, SRJ-315)'],
    ['no retry controller', { armed: undefined }, ' and no retry controller — no restart scheduled, no retry timer armed (b.jg5 SRJ-311)'],
  ])('the flag raised, %s: the persona line, then one line saying what was done instead; no restart, no arm', (_what, state, suffix) => {
    const rig = makeRig({ persona, raised: true, ...state })
    _buildRestartDisconnectedPersona(rig.deps)(persona.key, VIA)
    expect(rig.logs).toEqual([cwdLine(VIA), `${head(VIA)}${suffix}`])
    expect([rig.restarts, rig.arms]).toEqual([[], []])
  })

  test('the flag raised with no timer armed, not latched, nothing in flight: the persona line, then the arm line, and the timer armed once; no restart', () => {
    const rig = makeRig({ persona, raised: true, armed: false })
    _buildRestartDisconnectedPersona(rig.deps)(persona.key, VIA)
    expect(rig.logs).toEqual([cwdLine(VIA), `${head(VIA)} with no retry timer — no restart scheduled; arming one (b.jg5 SRJ-311)`])
    expect(rig.arms).toEqual([persona.key])
    expect(rig.restarts).toEqual([])
    expect(rig.asks.slice(-2)).toEqual(['log', 'armRetryTimer'])
  })
})
