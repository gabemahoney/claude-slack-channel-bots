/**
 * test-helpers/old-life.ts — The fixtures and line helpers the old-life hold
 * and wait cases share (b.jg5 SRJ-809, SRJ-810, SRJ-811), over the recovery
 * harness (`makeRecoveryHarness`), so each lives once.
 *
 * - The pre-persona row a hold is begun on (b.1ix: only the `service` and
 *   `channel` labels): `PRE_PERSONA_ID`, its labels `PRE_PERSONA_LABELS` and
 *   its session `PRE_PERSONA_SESSION`.
 * - Start-sweep rows and the sweep: `listed` (a persona's own row as the
 *   `list` gives it), `absentRow` (a row a spawn of an absent persona left,
 *   in the harness's first persona's directory) and `sweepOver` (the sweep
 *   over those rows as `main()` runs it, with the calls in order and what the
 *   first kill met).
 * - Holds begun by hand: `beginApplyHold` (apply step 1's hold on a
 *   persona's own row at its declared directory, or at another persona's for
 *   a destructive modify that moved it out of there) and `holdOldAt` (an id held
 *   at a persona's directory, as a start-sweep kill that did not succeed
 *   begins it).
 * - The old-life gate (SRJ-810, SRJ-1502): `gateLine` / `oldLifeGateLine`
 *   (its launch line, built by `oldLifeHoldLaunchLine`), `gateLinesIn` (the
 *   gate lines among the harness's errors, matched on the builder's own
 *   fixed words) and `heldBack` (`spawnForPersona`'s answer for a persona it
 *   holds back).
 * - The wait's end line (SRJ-811): `waitEndLine` (one round's line, built by
 *   `oldLifeWaitEndLine` from the decision's end kind and whether the hold
 *   goes on and is marked) and `waitEndLinePrefix` (the head every end line
 *   of one old row shares, cut from two builder outputs).
 * - The end-retry observer's settled line (SRJ-810):
 *   `settledRetryLinePrefix` (the head of a persona's settled line, retried
 *   or not, cut from the builder's two forms).
 *
 * Labels, line texts and answers come from `src/`; no line is typed here.
 * No module-scope state.
 *
 * SPDX-License-Identifier: MIT
 */

import { realpathSync } from 'node:fs'

import type { ListRow } from 'agent-director'
import type { PersonaConfig } from '../../src/config.ts'
import {
  OLD_LIFE_WAIT_END_HOLD_ENDED,
  OLD_LIFE_WAIT_END_ROW_FINISHED,
  oldLifeWaitEndLine,
  type OldLifeWaitEndDecision,
  type OldLifeWaitEndKind,
} from '../../src/old-life-wait.ts'
import { personaInstanceId, personaTmuxSessionName, renderPersonaRef } from '../../src/persona-identity.ts'
import { OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1, OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL, type OldLifeHold } from '../../src/retired-keys.ts'
import {
  OLD_LIFE_HOLD_END_NOT_RETRIED_LATCHED,
  SEQUENCE_WAITING_CAUSE_OLD_LIFE_HOLD,
  oldLifeHoldEndSettledRetryLine,
  oldLifeHoldLaunchLine,
  reconcileOrphans,
  spawnForPersona,
  type OldLifeHoldWaitStart,
  type SpawnPersonaResult,
} from '../../src/session-manager.ts'
import { cannedListRow } from './agent-director-stub.ts'
import { personaOf, recordCallOrder, type RecoveryHarness } from './recovery-harness.ts'

// ---------------------------------------------------------------------------
// The pre-persona row
// ---------------------------------------------------------------------------

/** The `channel` label of the pre-persona row the cases hold. */
const PRE_PERSONA_CHANNEL = 'C0OLD'

/** A pre-persona row's instance id (b.1ix): no persona label; its old key is the id itself (SRJ-809). */
export const PRE_PERSONA_ID = `cscb_old_${PRE_PERSONA_CHANNEL}`

/** The pre-persona row's labels: `service` and `channel` only. */
export const PRE_PERSONA_LABELS: Readonly<Record<string, string>> = { service: 'cscb', channel: PRE_PERSONA_CHANNEL }

/** The pre-persona row's tmux session, as the pre-persona naming gave it. */
export const PRE_PERSONA_SESSION = personaTmuxSessionName(PRE_PERSONA_ID.replace(/^cscb_/, ''))

// ---------------------------------------------------------------------------
// The start sweep's rows and the sweep
// ---------------------------------------------------------------------------

/** Persona `key`'s own row as the start sweep's `list` gives it (its id, labels and directory; `waiting`), with `overrides`. */
export function listed(h: RecoveryHarness, key: string, overrides: Partial<ListRow> = {}): ListRow {
  return cannedListRow(overrides, personaOf(h, key), h.home)
}

/**
 * A row a spawn of `key`, a persona absent from the configuration, left
 * (`cscb_<key>`, labelled `key`, in the harness's first persona's working
 * directory), with `overrides`.
 */
export function absentRow(h: RecoveryHarness, key: string, overrides: Partial<ListRow> = {}): ListRow {
  return cannedListRow(overrides, { ...personaOf(h, h.keys[0]!), key }, h.home)
}

/** What one start sweep did: its result, every stub call in order, and the record writes made and the personas latched when its first kill was sent. */
export interface SweepRun {
  readonly result: Awaited<ReturnType<typeof reconcileOrphans>>
  readonly order: string[]
  readonly atFirstKill: { readonly writes: number; readonly latched: string[] } | undefined
}

/**
 * Run the start sweep over `rows` with `config` (the harness's own by
 * default), as `main()` runs it, its kill retries on the harness clock, with
 * `isShuttingDown` as its shutdown query when given (b.jg5 SRJ-714).
 */
export async function sweepOver(
  h: RecoveryHarness,
  rows: readonly ListRow[],
  config: PersonaConfig = h.config,
  isShuttingDown?: () => boolean,
): Promise<SweepRun> {
  h.script({ listResult: { spawns: [...rows] } })
  let atFirstKill: SweepRun['atFirstKill']
  const kill = h.stub.client.kill.bind(h.stub.client)
  h.stub.client.kill = (params) => {
    atFirstKill ??= { writes: h.retiredKeyWrites.length, latched: h.keys.filter((key) => h.latch.isLatched(key)) }
    return kill(params)
  }
  const order = recordCallOrder(h)
  const result = await h.drive(reconcileOrphans(config, h.killRetryClock, isShuttingDown))
  return { result, order, atFirstKill }
}

// ---------------------------------------------------------------------------
// Holds begun by hand
// ---------------------------------------------------------------------------

/**
 * Apply step 1's hold on persona `key`'s own row, as the reload controller
 * begins it, at the old declaration's working directory: persona `dirOf`'s
 * (`key`'s own declared directory by default; another persona's for a
 * destructive modify that moved `key` out of the directory `dirOf` now names).
 */
export function beginApplyHold(h: RecoveryHarness, key: string, dirOf: string = key): OldLifeHold {
  return h.beginOldLifeHold({ instanceId: personaInstanceId(key), oldKey: key, directory: personaOf(h, dirOf).working_directory, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
}

/** Hold `instanceId` (old key `oldKey`) at persona `dirOf`'s working directory, as a start-sweep kill that did not succeed begins it. */
export function holdOldAt(h: RecoveryHarness, instanceId: string, oldKey: string, dirOf: string): OldLifeHold {
  return h.beginOldLifeHold({ instanceId, oldKey, directory: personaOf(h, dirOf).working_directory, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })
}

// ---------------------------------------------------------------------------
// The old-life gate's lines and answer
// ---------------------------------------------------------------------------

/**
 * The old-life gate's launch line at `site` for the persona rendered `ref`,
 * held at `realDirectory` by the hold on `instanceId`, its wait `wait`, its
 * timer armed (`oldLifeHoldLaunchLine`).
 */
export function oldLifeGateLine(site: string, ref: string, realDirectory: string, instanceId: string, wait: OldLifeHoldWaitStart): string {
  return oldLifeHoldLaunchLine(site, ref, realDirectory, [{ instanceId, wait }], true)
}

/**
 * The gate's line for persona `key` of the harness, held by the hold on
 * `instanceId`, its wait `wait`, its timer armed: at `spawnForPersona`, the
 * persona's name-and-key ref, by default.
 */
export function gateLine(
  h: RecoveryHarness,
  key: string,
  instanceId: string,
  wait: OldLifeHoldWaitStart,
  site: string = spawnForPersona.name,
  ref: string = renderPersonaRef(personaOf(h, key).name, key),
): string {
  return oldLifeGateLine(site, ref, realpathSync(personaOf(h, key).working_directory), instanceId, wait)
}

/** The fixed words of the gate's line, cut from the builder's own output around marker arguments. */
const GATE_PROBE = oldLifeHoldLaunchLine('SITE', 'REF', 'DIR', [], true)
/** The words between the site and the ref. */
const GATE_HEAD = GATE_PROBE.slice(GATE_PROBE.indexOf('SITE') + 'SITE'.length, GATE_PROBE.indexOf('REF'))
/** The words between the quoted directory and the held ids. */
const GATE_HELD = GATE_PROBE.slice(GATE_PROBE.indexOf('"DIR"') + '"DIR"'.length, GATE_PROBE.indexOf('()'))

/** The old-life gate's launch lines among the harness's errors, in order. */
export function gateLinesIn(h: RecoveryHarness): string[] {
  return h.errors.filter((line) => line.includes(GATE_HEAD) && line.includes(GATE_HELD))
}

/** `spawnForPersona`'s answer for persona `key` when the old-life gate holds it back. */
export function heldBack(key: string): SpawnPersonaResult {
  return { key, action: 'sequence-waiting', sequenceWaitingCause: SEQUENCE_WAITING_CAUSE_OLD_LIFE_HOLD }
}

// ---------------------------------------------------------------------------
// The wait's end line
// ---------------------------------------------------------------------------

/** How a round ended, as its end line names it: the end kind, whether the hold goes on and whether it is marked kill-failed. */
export interface WaitEnd {
  readonly kind: OldLifeWaitEndKind
  readonly kept: boolean
  readonly marked?: boolean
}

/** The decision a round's end line is built from (its notices and report do not reach the line). */
function endDecision(end: WaitEnd): OldLifeWaitEndDecision {
  const marked = end.marked === true
  return { kind: end.kind, holdGoesOn: end.kept, markKillFailed: marked, armWaiting: end.kept, notices: [], reportUnclassified: false }
}

/** One round's end line for the old row `instanceId` (old key `oldKey`) that ended as `end`, the waiting personas `armed` armed (`oldLifeWaitEndLine`). */
export function waitEndLine(instanceId: string, oldKey: string, end: WaitEnd, armed: readonly string[]): string {
  return oldLifeWaitEndLine({ instanceId, oldKey, decision: endDecision(end), armed })
}

/** The head every end line of the old row `instanceId` (old key `oldKey`) starts with: the common start of two end lines whose ends differ from their first word. */
export function waitEndLinePrefix(instanceId: string, oldKey: string): string {
  return commonStart(
    waitEndLine(instanceId, oldKey, { kind: OLD_LIFE_WAIT_END_ROW_FINISHED, kept: false }, []),
    waitEndLine(instanceId, oldKey, { kind: OLD_LIFE_WAIT_END_HOLD_ENDED, kept: false }, []),
  )
}

// ---------------------------------------------------------------------------
// The end-retry observer's settled line
// ---------------------------------------------------------------------------

/**
 * The head every settled line for persona `key` of the stopped wait on
 * `instanceId` starts with (`oldLifeHoldEndSettledRetryLine`, retried or
 * not): the common start of its two forms.
 */
export function settledRetryLinePrefix(instanceId: string, key: string): string {
  return commonStart(oldLifeHoldEndSettledRetryLine(instanceId, key, undefined), oldLifeHoldEndSettledRetryLine(instanceId, key, OLD_LIFE_HOLD_END_NOT_RETRIED_LATCHED))
}

/** The longest common start of `a` and `b`. */
function commonStart(a: string, b: string): string {
  let at = 0
  while (at < a.length && a[at] === b[at]) at++
  return a.slice(0, at)
}
