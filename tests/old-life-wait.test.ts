/**
 * old-life-wait.test.ts — The old-life hold: start and end (b.jg5 SRJ-809;
 * SRJ-703's old-life clause, SRJ-714's sweep holds, SRJ-715's teardown hold,
 * SRJ-812's kill-failed mark). E27 T1 builds the holds; T2 (the wait's
 * steps, SRJ-811) and T3 (what a hold refuses, SRJ-810, and SRJ-809's
 * admission clause, AC 53) extend this file.
 *
 * - The hold set (`createOldLifeHoldSet`, src/retired-keys.ts) over its own
 *   log: begin, a second begin on one instance id (only the cause changes;
 *   the held directory is kept and the declared one ignored), the directory's
 *   replacement, the end with its observers; directories compared by real
 *   path (a symlinked path) with the lexical fallback (a missing path), both
 *   inside the case's `mkdtempSync` directory, beside a control directory;
 *   two holds on one directory ending apart; who waits on a hold (a persona
 *   in its directory, the persona whose own `cscb_<key>` is held); the
 *   kill-failed mark; the old key a row gives (`oldLifeKeyOf`).
 * - The end rule at the session manager's one read entry
 *   (`noteOldLifeRowRead`): a read of `ended` or `missing`, no row, and a
 *   listing in a `find-missing` run's `ids` end the hold, each with one line
 *   built by the module; `pending`, any live state and a state CSCB does not
 *   know keep it, a live read's `cwd` re-pointing it; another id's read ends
 *   nothing; with no set installed nothing happens. Which reads reach the
 *   entry is tests/session-manager.test.ts's and tests/server.test.ts's.
 * - One case per start: apply step 1's holds (`oldLifeHoldsToBegin`, pure;
 *   which holds a confirmed apply begins, and when, are
 *   tests/reload-apply.test.ts's), and, end to end on the reload harness's
 *   real launch, a removal's or a rename's hold re-pointed to the old row's
 *   `cwd` by a later live read (`run.oldLifeHolds`); the start
 *   sweep's failed kills (an absent persona's row, a live pre-persona row,
 *   a row swept for its instance id and one swept for its `cwd`, Q-9), and
 *   apply step 1 begun later on a row the sweep held at its real `cwd`
 *   (the hold stays there, not on the declared directory); the
 *   sweep's `list` of a live row of a key recorded without its mark, killed,
 *   kept or spared for a latch, `pending` included; none for a marked key, a
 *   finished row or a key not recorded; none once the sweep's shutdown
 *   query answers true.
 * - Ends that are not kill outcomes (AC 54, AC 63): a teardown kill and a
 *   sweep kill, whatever they answer (a success with `kill_sent` true or
 *   false, gone, a CONFLICT, an UNUSABLE NAME, UNAVAILABLE, a failure), end
 *   no hold; only the tries that decided the ordinary kill-failure alert
 *   mark it kill-failed (SRJ-812), a failure after a survivor-naming one
 *   (UNAVAILABLE, a CONFLICT) included, never the survivor version.
 * - The new life: a reuse that begins the key's new life ends its hold,
 *   also when the mark's write failed; another key's reuse ends none.
 * - The restart: holds live in memory; a fresh harness over a record where
 *   P is recorded without its mark (a `credentials_file` destructive modify
 *   whose teardown kill failed) keeps P's own live row, whose `cwd` matches
 *   P, and begins its hold; a row that reads `ended` rebuilds none.
 *
 * Every harness case but one runs on `makeRecoveryHarness`, whose one hold
 * set is built and installed as `main()` builds and installs it; its sweep is
 * `h.startSweep` on the harness clock. The one exception is the start-1 end
 * to end case, which runs on `makeReloadHarness` (its real launch and its
 * hold set, `run.oldLifeHolds`). Each harness case leak-checks everything
 * its harness captured and leaves no fake-clock timer pending. Labels, line
 * texts and read names come from src/retired-keys.ts and
 * src/session-manager.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Phase1ListRow } from '../src/ad-phase1-types.ts'
import type { PersonaConfig, PersonaInput } from '../src/config.ts'
import { KILL_RETRY_TRIES } from '../src/kill-retry.ts'
import { AGENT_DIRECTOR_DEAD_STATES, AGENT_DIRECTOR_LIVE_STATES, AGENT_DIRECTOR_PENDING_STATE } from '../src/liveness-reading.ts'
import { personaInstanceId } from '../src/persona-identity.ts'
import { oldLifeHoldsToBegin } from '../src/reload.ts'
import { buildChangePlan, type ValidChangePlan } from '../src/reload-plan.ts'
import {
  OLD_LIFE_HOLD_BEGAN_AGAIN_TAIL,
  OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1,
  OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL,
  OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING,
  OLD_LIFE_HOLD_END_FIND_MISSING_IDS,
  OLD_LIFE_HOLD_END_NEW_LIFE,
  OLD_LIFE_HOLD_END_READ_ENDED,
  OLD_LIFE_HOLD_END_READ_MISSING,
  OLD_LIFE_HOLD_LOG_PREFIX,
  RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY,
  createOldLifeHoldSet,
  oldLifeHoldBeganLine,
  oldLifeHoldEndedLine,
  oldLifeKeyOf,
  type OldLifeHold,
  type OldLifeHoldBegin,
  type OldLifeHoldCause,
  type OldLifeHoldEndReason,
  type OldLifeHoldSet,
} from '../src/retired-keys.ts'
import {
  OLD_LIFE_NEW_LIFE_READ,
  OLD_LIFE_ROW_READ_FIND_MISSING_IDS,
  OLD_LIFE_ROW_READ_NO_ROW,
  OLD_LIFE_ROW_READ_STATE,
  OWN_ROW_READ_ROW,
  SPAWN_ACTION_FRESH_RETIRED,
  _resetOldLifeHolds,
  killPersonaInstanceForTeardown,
  noteOldLifeRowRead,
  readPersonaOwnRow,
  setOldLifeHolds,
  type OldLifeRowRead,
} from '../src/session-manager.ts'
import {
  cannedErr,
  cannedKillResult,
  cannedListRow,
  cannedOk,
  errSpawnNotFound,
  errTmuxKillFailed,
  errTmuxSessionConflict,
  errTmuxUnresponsive,
  errUnusableName,
  provenanceNote,
} from './test-helpers/agent-director-stub.ts'
import { LAUNCH_START_ABSENT_PERSONA_KEY } from './test-helpers/conflict-cases.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import {
  makeRecoveryHarness,
  personaOf,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
  type RecoveryStubScript,
} from './test-helpers/recovery-harness.ts'
import { makeReloadHarness, type ReloadHarness } from './test-helpers/reload-harness.ts'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** What a case asserts of a hold: everything but the real path and the waiting personas. */
type HoldFields = Pick<OldLifeHold, 'instanceId' | 'oldKey' | 'directory' | 'cause' | 'killFailed'>

/** The fields a case asserts of `view`. */
function fieldsOf(view: OldLifeHold): HoldFields {
  return { instanceId: view.instanceId, oldKey: view.oldKey, directory: view.directory, cause: view.cause, killFailed: view.killFailed }
}

/** A hold as a case expects it. */
function hold(instanceId: string, oldKey: string, directory: string, cause: OldLifeHoldCause, killFailed = false): HoldFields {
  return { instanceId, oldKey, directory, cause, killFailed }
}

/** The lines the hold set logged among `lines`. */
function holdLinesIn(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith(`${OLD_LIFE_HOLD_LOG_PREFIX} `))
}

/** The begin lines among `lines`. */
function beganLinesIn(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith(`${OLD_LIFE_HOLD_LOG_PREFIX} began `))
}

/** The end lines among `lines`. */
function endedLinesIn(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith(`${OLD_LIFE_HOLD_LOG_PREFIX} ended `))
}

/** A began-again line ends, before its closing requirement tag, with the tail saying the one hold is kept on its held directory. */
function expectBeganAgainTail(line: string): void {
  expect(line.replace(/ \([^()]*\)$/, '')).toEndWith(`— ${OLD_LIFE_HOLD_BEGAN_AGAIN_TAIL}`)
}

let harness: RecoveryHarness | undefined

/** A recovery harness over P and B, cleaned up after the case. */
function build(options?: RecoveryHarnessOptions): { h: RecoveryHarness; p: string; b: string } {
  const h = (harness = makeRecoveryHarness(options))
  const [p, b] = h.keys as [string, string]
  return { h, p, b }
}

/** Every harness case: no fake-clock timer left, nothing captured leaks, then the harness is cleaned up. */
function harnessAfterEach(): void {
  const h = harness
  harness = undefined
  if (h === undefined) return
  try {
    expect(h.clock.pendingCount()).toBe(0)
    assertNoLeak(h.captured())
  } finally {
    h.cleanup()
  }
}

/** The harness's holds, in begin order, as a case asserts them. */
const holdsOf = (h: RecoveryHarness): HoldFields[] => h.oldLifeHolds.snapshot().map(fieldsOf)

/** Persona `key`'s own row as the start sweep's `list` gives it (its id, labels and directory; `waiting`), with `overrides`. */
function listed(h: RecoveryHarness, key: string, overrides: Partial<Phase1ListRow> = {}): Phase1ListRow {
  return cannedListRow(overrides, personaOf(h, key), h.home)
}

/** A row a spawn of an absent persona left (`cscb_absent_persona`, labelled with its key, in P's directory), with `overrides`. */
function absentRow(h: RecoveryHarness, overrides: Partial<Phase1ListRow> = {}): Phase1ListRow {
  return cannedListRow(overrides, { ...personaOf(h, h.keys[0]!), key: LAUNCH_START_ABSENT_PERSONA_KEY }, h.home)
}

/** A live pre-persona row (b.1ix): only the `service` and `channel` labels. */
function prePersonaRow(state = 'waiting'): Phase1ListRow {
  const id = `cscb_old_${state}_C0OLD`
  return cannedListRow({ claude_instance_id: id, state, labels: { service: 'cscb', channel: 'C0OLD' }, tmux_session_name: id.replace(/^cscb_/, 'slack_bot_') })
}

/** Run the start sweep over `rows` as `main()` runs it, with `isShuttingDown` as its shutdown query when given. */
async function sweepOver(h: RecoveryHarness, rows: readonly Phase1ListRow[], isShuttingDown?: () => boolean): Promise<void> {
  h.script({ listResult: { spawns: [...rows] } })
  await h.startSweep(isShuttingDown)
}

/** Apply step 1's hold on persona `key`'s own row at its declared working directory, as the reload controller begins it. */
function beginApplyHold(h: RecoveryHarness, key: string): OldLifeHold {
  return h.beginOldLifeHold({ instanceId: personaInstanceId(key), oldKey: key, directory: personaOf(h, key).working_directory, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
}

// ---------------------------------------------------------------------------
// The hold set
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809: the hold set — begin, re-point, end, the real-path queries, who waits and the kill-failed mark', () => {
  let dir: string
  let lines: string[]
  let set: OldLifeHoldSet

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    assertNoLeak(lines)
  })

  /** A fresh set over a fresh temp directory holding `real`, a symlink `link` to it and a control `other`; `missing` is never made. */
  function fresh(): { real: string; link: string; other: string; missing: string } {
    dir = mkdtempSync(join(tmpdir(), 'old-life-holds-'))
    lines = []
    set = createOldLifeHoldSet({ log: (line) => { lines.push(line) } })
    const real = join(dir, 'real')
    const other = join(dir, 'other')
    mkdirSync(real)
    mkdirSync(other)
    const link = join(dir, 'link')
    symlinkSync(real, link)
    return { real, link, other, missing: join(dir, 'missing') }
  }

  test('a begin holds the directory with its old key and cause, unmarked and with no one waiting, and logs one began line naming the real path', () => {
    const { real, link } = fresh()

    const view = set.begin({ instanceId: 'cscb_p', oldKey: 'p', directory: link, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })

    expect(view).toEqual({ instanceId: 'cscb_p', oldKey: 'p', directory: link, realDirectory: realpathSync(real), cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1, killFailed: false, waiting: [] })
    expect(set.snapshot()).toEqual([view])
    expect(lines).toEqual([oldLifeHoldBeganLine(view)])
    expect(lines[0]).toContain(JSON.stringify(realpathSync(real)))
  })

  test('a second begin on one instance id keeps one hold on its held directory: only the cause changes, the declared directory ignored and the old key, mark and waiting personas kept; one began-again line naming the kept directory', () => {
    const { real, other } = fresh()
    set.begin({ instanceId: 'cscb_p', oldKey: 'p', directory: real, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING })
    set.markKillFailed('cscb_p')
    set.recordWaiting('cscb_p', 'q')

    const view = set.begin({ instanceId: 'cscb_p', oldKey: 'other_key', directory: other, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })

    expect(set.snapshot()).toEqual([view])
    expect(fieldsOf(view)).toEqual(hold('cscb_p', 'p', real, OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL, true))
    expect(view.waiting).toEqual(['q'])
    expect(set.holdsOnDirectory(other)).toEqual([])
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe(oldLifeHoldBeganLine(view, true))
    expect(lines[1]).toContain(JSON.stringify(realpathSync(real)))
    expect(lines[1]).not.toContain(other)
    expect(lines[1]).not.toContain(realpathSync(other))
    expectBeganAgainTail(lines[1]!)
  })

  test('replaceDirectory re-points a held id with no line; the same directory or an id not held changes nothing', () => {
    const { real, other } = fresh()
    set.begin({ instanceId: 'cscb_p', oldKey: 'p', directory: real, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })

    expect([set.replaceDirectory('cscb_p', real), set.replaceDirectory('cscb_q', other)]).toEqual([false, false])
    expect(set.replaceDirectory('cscb_p', other)).toBe(true)

    expect(set.holdOf('cscb_p')?.directory).toBe(other)
    expect(set.holdsOnDirectory(real)).toEqual([])
    expect(lines).toHaveLength(1)
  })

  test('directories compare by real path: a hold on a symlink answers for its target and a hold on its target for the symlink; a missing path compares lexically; a control directory answers nothing', () => {
    const { real, link, other, missing } = fresh()
    set.begin({ instanceId: 'cscb_a', oldKey: 'a', directory: link, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    set.begin({ instanceId: 'cscb_b', oldKey: 'b', directory: missing, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })

    expect(set.holdsOnDirectory(real).map((h) => h.instanceId)).toEqual(['cscb_a'])
    expect(set.holdsOnDirectory(link).map((h) => h.instanceId)).toEqual(['cscb_a'])
    expect(set.holdsOnDirectory(join(dir, 'real', '..', 'missing')).map((h) => h.instanceId)).toEqual(['cscb_b'])
    expect(set.holdOf('cscb_b')?.realDirectory).toBe(missing)
    expect(set.holdsOnDirectory(other)).toEqual([])
  })

  test('two holds on one directory end independently: one end line each, observers told once per end in registration order; an id not held ends nothing and logs nothing', () => {
    const { real } = fresh()
    set.begin({ instanceId: 'cscb_a', oldKey: 'a', directory: real, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING })
    set.begin({ instanceId: 'cscb_old', oldKey: 'cscb_old', directory: real, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })
    const told: string[] = []
    set.onEnd((view, reason) => { told.push(`first ${view.instanceId} ${reason}`) })
    set.onEnd((view, reason) => { told.push(`second ${view.instanceId} ${reason}`) })
    const a = set.holdOf('cscb_a')!

    expect(set.end('cscb_a', OLD_LIFE_HOLD_END_READ_ENDED, 'a test read')).toEqual(a)
    expect(set.holdsOnDirectory(real).map((h) => h.instanceId)).toEqual(['cscb_old'])
    expect(set.end('cscb_a', OLD_LIFE_HOLD_END_READ_ENDED)).toBeUndefined()
    const old = set.holdOf('cscb_old')!
    set.end('cscb_old', OLD_LIFE_HOLD_END_FIND_MISSING_IDS)

    expect(set.snapshot()).toEqual([])
    expect(endedLinesIn(lines)).toEqual([
      oldLifeHoldEndedLine(a, OLD_LIFE_HOLD_END_READ_ENDED, 'a test read'),
      oldLifeHoldEndedLine(old, OLD_LIFE_HOLD_END_FIND_MISSING_IDS),
    ])
    expect(told).toEqual([
      `first cscb_a ${OLD_LIFE_HOLD_END_READ_ENDED}`,
      `second cscb_a ${OLD_LIFE_HOLD_END_READ_ENDED}`,
      `first cscb_old ${OLD_LIFE_HOLD_END_FIND_MISSING_IDS}`,
      `second cscb_old ${OLD_LIFE_HOLD_END_FIND_MISSING_IDS}`,
    ])
  })

  test('an observer that throws is logged once and stops neither the end nor the next observer; a removed observer is not told', () => {
    const { real } = fresh()
    set.begin({ instanceId: 'cscb_p', oldKey: 'p', directory: real, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    const told: string[] = []
    const remove = set.onEnd(() => { told.push('removed') })
    set.onEnd(() => {
      throw new Error('observer broken')
    })
    set.onEnd((view) => { told.push(view.instanceId) })
    remove()

    set.end('cscb_p', OLD_LIFE_HOLD_END_READ_MISSING)

    expect(set.holdOf('cscb_p')).toBeUndefined()
    expect(told).toEqual(['cscb_p'])
    const failed = lines.filter((line) => line.startsWith(`${OLD_LIFE_HOLD_LOG_PREFIX} an end observer failed for instanceId="cscb_p": `))
    expect(failed).toHaveLength(1)
  })

  test('who waits: a persona whose working directory is the held directory (by real path) and the persona whose own cscb_<key> is held; the waiting record is named in the end line and forgotten per persona', () => {
    const { real, link, other } = fresh()
    set.begin({ instanceId: 'cscb_old', oldKey: 'old', directory: real, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    set.begin({ instanceId: personaInstanceId('own'), oldKey: 'own', directory: other, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING })

    expect(set.holdsWaitedOnBy({ key: 'neighbour', working_directory: link }).map((h) => h.instanceId)).toEqual(['cscb_old'])
    expect(set.holdsWaitedOnBy({ key: 'own', working_directory: join(dir, 'elsewhere') }).map((h) => h.instanceId)).toEqual([personaInstanceId('own')])
    expect(set.holdsWaitedOnBy({ key: 'stranger', working_directory: join(dir, 'elsewhere') })).toEqual([])

    expect([set.recordWaiting('cscb_old', 'neighbour'), set.recordWaiting('cscb_old', 'gone'), set.recordWaiting('cscb_none', 'neighbour')]).toEqual([true, true, false])
    set.forgetWaiting('gone')
    const view = set.holdOf('cscb_old')!
    expect(view.waiting).toEqual(['neighbour'])
    set.end('cscb_old', OLD_LIFE_HOLD_END_READ_ENDED)
    expect(endedLinesIn(lines)).toEqual([oldLifeHoldEndedLine(view, OLD_LIFE_HOLD_END_READ_ENDED)])
    expect(endedLinesIn(lines)[0]).toContain('waiting personas: neighbour ')
  })

  test('the kill-failed mark: set only on a held id, read through each persona waiting on it, and lasting until the hold ends', () => {
    const { real } = fresh()
    set.begin({ instanceId: 'cscb_old', oldKey: 'old', directory: real, cause: OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL })
    const waiter = { key: 'neighbour', working_directory: real }

    expect(set.waitsOnKillFailed(waiter)).toBe(false)
    expect([set.markKillFailed('cscb_none'), set.markKillFailed('cscb_old')]).toEqual([false, true])
    expect([set.holdOf('cscb_old')?.killFailed, set.waitsOnKillFailed(waiter)]).toEqual([true, true])
    set.end('cscb_old', OLD_LIFE_HOLD_END_READ_MISSING)
    expect(set.waitsOnKillFailed(waiter)).toBe(false)
  })

  test('two sets share nothing', () => {
    const { real } = fresh()
    const second = createOldLifeHoldSet({ log: (line) => { lines.push(line) } })
    set.begin({ instanceId: 'cscb_p', oldKey: 'p', directory: real, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })

    expect(second.snapshot()).toEqual([])
    expect(second.holdsOnDirectory(real)).toEqual([])
  })

  test.each<[string, string, unknown, string]>([
    ['the persona label\'s own cscb_<key>', 'cscb_p', 'p', 'p'],
    ['no persona label (a pre-persona row)', 'cscb_old_C0OLD', undefined, 'cscb_old_C0OLD'],
    ['an empty persona label', 'cscb_p', '', 'cscb_p'],
    ['an instance id that is not the label\'s cscb_<key> (swept for its instance id)', 'cscb_p_old', 'p', 'cscb_p_old'],
  ])('oldLifeKeyOf: %s gives the old key %s→%s', (_label, instanceId, label, oldKey) => {
    expect(oldLifeKeyOf(instanceId, label)).toBe(oldKey)
  })
})

// ---------------------------------------------------------------------------
// The end rule at the one read entry
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809: the one read entry ends a hold only on a read of ended or missing, no row, or a find-missing run\'s ids', () => {
  let dir: string
  let lines: string[]
  let set: OldLifeHoldSet

  /** A set installed as the session manager's, holding `cscb_p` and `cscb_q` in a fresh directory. */
  function installed(): { work: string; other: string } {
    dir = mkdtempSync(join(tmpdir(), 'old-life-entry-'))
    const work = join(dir, 'work')
    const other = join(dir, 'other')
    mkdirSync(work)
    mkdirSync(other)
    lines = []
    set = createOldLifeHoldSet({ log: (line) => { lines.push(line) } })
    setOldLifeHolds(set)
    set.begin({ instanceId: 'cscb_p', oldKey: 'p', directory: work, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    set.begin({ instanceId: 'cscb_q', oldKey: 'q', directory: work, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })
    return { work, other }
  }

  afterEach(() => {
    _resetOldLifeHolds()
    rmSync(dir, { recursive: true, force: true })
    assertNoLeak(lines)
  })

  test.each<[string, OldLifeRowRead, OldLifeHoldEndReason, string]>([
    ['a read of ended', { kind: OLD_LIFE_ROW_READ_STATE, state: 'ended' }, OLD_LIFE_HOLD_END_READ_ENDED, 'site: a read'],
    ['a read of missing', { kind: OLD_LIFE_ROW_READ_STATE, state: 'missing' }, OLD_LIFE_HOLD_END_READ_MISSING, 'site: a read'],
    ['no row (ErrSpawnNotFound)', { kind: OLD_LIFE_ROW_READ_NO_ROW }, OLD_LIFE_HOLD_END_READ_MISSING, 'site: a read: no row'],
    ['a listing in a find-missing run\'s ids', { kind: OLD_LIFE_ROW_READ_FIND_MISSING_IDS }, OLD_LIFE_HOLD_END_FIND_MISSING_IDS, 'site: a read'],
  ])('%s of cscb_p ends its hold with one line naming the read; cscb_q\'s hold on the same directory stays', (_label, read, reason, named) => {
    installed()
    const before = set.holdOf('cscb_p')!

    noteOldLifeRowRead('cscb_p', read, 'site: a read')

    expect(set.snapshot().map((h) => h.instanceId)).toEqual(['cscb_q'])
    expect(endedLinesIn(lines)).toEqual([oldLifeHoldEndedLine(before, reason, named)])
  })

  test.each([AGENT_DIRECTOR_PENDING_STATE, 'waiting', 'working', 'ask_user', 'check_permission', 'hibernating'])('a read of %s keeps the hold, logging nothing; its cwd re-points it, with no line', (state) => {
    const { work, other } = installed()

    noteOldLifeRowRead('cscb_p', { kind: OLD_LIFE_ROW_READ_STATE, state }, 'site: a read')
    expect(set.holdOf('cscb_p')?.directory).toBe(work)
    noteOldLifeRowRead('cscb_p', { kind: OLD_LIFE_ROW_READ_STATE, state, cwd: other }, 'site: a read')

    expect(set.holdOf('cscb_p')?.directory).toBe(other)
    expect(set.holdOf('cscb_q')?.directory).toBe(work)
    expect(holdLinesIn(lines)).toHaveLength(2)
  })

  test('a read of another id ends nothing; with the set removed, a read of ended ends nothing', () => {
    installed()

    noteOldLifeRowRead('cscb_other', { kind: OLD_LIFE_ROW_READ_STATE, state: 'ended' }, 'site: a read')
    _resetOldLifeHolds()
    noteOldLifeRowRead('cscb_p', { kind: OLD_LIFE_ROW_READ_STATE, state: 'ended' }, 'site: a read')

    expect(set.snapshot().map((h) => h.instanceId)).toEqual(['cscb_p', 'cscb_q'])
    expect(endedLinesIn(lines)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Start 1: apply step 1 (the pure begin list)
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809 start 1: apply step 1 holds each key it records at the old declaration\'s working directory (oldLifeHoldsToBegin)', () => {
  let dir: string

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The applied configuration: alpha, beta, gamma and delta, under a fresh directory. */
  function appliedConfig(): PersonaConfig {
    dir = mkdtempSync(join(tmpdir(), 'old-life-apply-'))
    return makeMultiPersonaConfig([{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }, { name: 'delta' }], dir)
  }

  /** The plan of `candidate` over `applied`, paths compared as written. */
  function planOf(applied: PersonaConfig, candidate: PersonaConfig): ValidChangePlan {
    const plan = buildChangePlan(applied, { kind: 'valid', config: candidate }, { realPath: (p) => p, home: dir })
    if (!plan.valid) throw new Error('the candidate is not valid')
    return plan
  }

  /** `applied` with the personas `edit` gives. */
  function edited(applied: PersonaConfig, edit: (personas: PersonaConfig['personas']) => PersonaConfig['personas']): PersonaConfig {
    return { ...applied, personas: edit(applied.personas.map((p) => ({ ...p }))) }
  }

  /** The begin apply step 1 makes for `key` at `directory`. */
  const applyBegin = (key: string, directory: string): OldLifeHoldBegin => ({ instanceId: personaInstanceId(key), oldKey: key, directory, cause: OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1 })

  test.each<[string, (personas: PersonaConfig['personas'], root: string) => PersonaConfig['personas'], (applied: PersonaConfig) => OldLifeHoldBegin[]]>([
    ['a removal (beta)', (ps) => ps.filter((p) => p.key !== 'beta'), (a) => [applyBegin('beta', a.personas[1]!.working_directory)]],
    ['a rename (beta to beta_two: the old key, never the new)', (ps) => ps.map((p) => (p.key === 'beta' ? { ...p, name: 'beta_two', key: 'beta_two' } : p)), (a) => [applyBegin('beta', a.personas[1]!.working_directory)]],
    ['a destructive modify of working_directory (gamma: the old directory)', (ps, root) => ps.map((p) => (p.key === 'gamma' ? { ...p, working_directory: join(root, 'gamma-new') } : p)), (a) => [applyBegin('gamma', a.personas[2]!.working_directory)]],
    ['a destructive modify of credentials_file (delta: its unchanged directory)', (ps, root) => ps.map((p) => (p.key === 'delta' ? { ...p, credentials_file: join(root, 'delta-new.env') } : p)), (a) => [applyBegin('delta', a.personas[3]!.working_directory)]],
    ['an added persona only (none)', (ps, root) => [...ps, { ...ps[0]!, name: 'epsilon', key: 'epsilon', index: 4, working_directory: join(root, 'epsilon') }], () => []],
    ['no change (none)', (ps) => ps, () => []],
  ])('%s', (_label, edit, expected) => {
    const applied = appliedConfig()
    const plan = planOf(applied, edited(applied, (ps) => edit(ps, dir)))

    expect(oldLifeHoldsToBegin(plan, applied)).toEqual(expected(applied))
  })

  test('a removal, a rename and two destructive modifies in one apply: the removed keys first, then the destructive ones in candidate order, each once', () => {
    const applied = appliedConfig()
    const [alpha, beta, gamma, delta] = applied.personas as [PersonaConfig['personas'][number], PersonaConfig['personas'][number], PersonaConfig['personas'][number], PersonaConfig['personas'][number]]
    const candidate = edited(applied, () => [
      { ...delta, credentials_file: join(dir, 'delta-new.env') },
      { ...beta, name: 'beta_two', key: 'beta_two' },
      { ...gamma, working_directory: join(dir, 'gamma-new') },
    ])

    expect(oldLifeHoldsToBegin(planOf(applied, candidate), applied)).toEqual([
      applyBegin('alpha', alpha.working_directory),
      applyBegin('beta', beta.working_directory),
      applyBegin('delta', delta.working_directory),
      applyBegin('gamma', gamma.working_directory),
    ])
  })
})

// ---------------------------------------------------------------------------
// Start 1 end to end: a later live read re-points apply step 1's hold
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809 start 1 end to end: a later read of the old row as live with another cwd re-points apply step 1\'s hold to that cwd (real launch)', () => {
  let rh: ReloadHarness | undefined

  afterEach(async () => {
    const done = rh
    rh = undefined
    await done?.cleanup()
  })

  /** The read the case makes: the shared own-row `get`. */
  const SITE = { site: 'old-life-wait.test', what: 'own-row get' }

  test.each<[string, (alpha: PersonaInput, bravo: PersonaInput) => PersonaInput[]]>([
    ['a removal of bravo', (alpha) => [alpha]],
    ['a rename of bravo to bravo2', (alpha, bravo) => [alpha, { ...bravo, name: 'bravo2' }]],
  ])('%s, its teardown kill answering a CONFLICT (the row stays live): the hold on bravo\'s old directory moves to the row\'s cwd, its old key, cause and mark kept, with no line', async (_label, change) => {
    const r = (rh = makeReloadHarness())
    const alpha = r.persona('alpha')
    const bravo = r.persona('bravo')
    r.materialize(alpha, bravo)
    r.writeRecord({ personas: [alpha, bravo] })
    r.writeConfig({ personas: [alpha, bravo] })
    const run = await r.startDetecting({ realLaunch: true, agentDirector: { killQueue: [cannedErr(errTmuxSessionConflict('kill', 'different-id'))] } })
    await run.ticks.tick()
    const bravoKey = r.key('bravo')
    const bravoId = personaInstanceId(bravoKey)

    r.writeConfig({ personas: change(alpha, bravo) })
    await (await run.confirmPending()).applying

    const begun = run.oldLifeHolds.holdOf(bravoId)!
    expect(fieldsOf(begun)).toEqual(hold(bravoId, bravoKey, bravo.working_directory, OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1))
    expect(r.rowOf('bravo')?.state).toBe('waiting')
    const elsewhere = join(r.root, 'elsewhere')
    mkdirSync(elsewhere)
    r.seedRow(bravo, { cwd: elsewhere })

    expect(await readPersonaOwnRow(bravoKey, SITE)).toMatchObject({ kind: OWN_ROW_READ_ROW, row: { state: 'waiting', cwd: elsewhere } })

    expect(run.oldLifeHolds.snapshot()).toEqual([{ ...begun, directory: elsewhere, realDirectory: realpathSync(elsewhere) }])
    expect(run.oldLifeHolds.holdsOnDirectory(bravo.working_directory)).toEqual([])
    expect(run.oldLifeHolds.holdsWaitedOnBy({ key: r.key('alpha'), working_directory: elsewhere }).map((view) => view.instanceId)).toEqual([bravoId])
    expect(holdLinesIn(run.logs)).toEqual([oldLifeHoldBeganLine(begun)])
    expect(run.slackPosts()).toEqual([])
    expect(run.clock.pendingCount()).toBe(0)
    assertNoLeak(run.captured())
  })
})

// ---------------------------------------------------------------------------
// Starts 2 and 3: the start sweep
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809 starts 2 and 3, SRJ-714: the start sweep holds the cwd of each live row it failed to kill and of each live row of a key recorded without its mark', () => {
  afterEach(harnessAfterEach)

  test('every kill failing (ErrTmuxKillFailed through the tries): an absent persona\'s row, a live pre-persona row, a row swept for its instance id and one swept for its cwd are each held at the row\'s cwd and marked kill-failed; the absent key, just recorded, was held by the listing first; one began line each; nothing ends them', async () => {
    const { h, b } = build()
    h.script({ killError: errTmuxKillFailed() })
    const pre = prePersonaRow()
    const absent = absentRow(h)
    const bOld = listed(h, b, { claude_instance_id: `${personaInstanceId(b)}_old` })
    const bElsewhere = listed(h, b, { cwd: h.home })

    await sweepOver(h, [pre, absent, bOld, bElsewhere])

    expect([...new Set(h.stub.calls.killCalls.map((k) => k.claude_instance_id))]).toEqual([pre, absent, bOld, bElsewhere].map((row) => row.claude_instance_id))
    expect(holdsOf(h)).toEqual([
      hold(absent.claude_instance_id, LAUNCH_START_ABSENT_PERSONA_KEY, absent.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING, true),
      hold(pre.claude_instance_id, pre.claude_instance_id, pre.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL, true),
      hold(bOld.claude_instance_id, bOld.claude_instance_id, bOld.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL, true),
      hold(personaInstanceId(b), b, h.home, OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL, true),
    ])
    expect(beganLinesIn(h.errors)).toEqual(h.oldLifeHolds.snapshot().map((view) => oldLifeHoldBeganLine(view)))
    expect(endedLinesIn(h.errors)).toEqual([])
  })

  test('P\'s own row swept for its cwd D0, its kill failing, then apply step 1 begun on cscb_<P> at P\'s declared directory D1: the one hold stays on D0, now apply step 1\'s and still kill-failed, D1 is not held, and the began-again line names D0, not D1', async () => {
    const { h, p } = build()
    h.script({ killError: errTmuxKillFailed() })
    const d0 = h.home
    const d1 = personaOf(h, p).working_directory
    expect(realpathSync(d0)).not.toBe(realpathSync(d1))

    await sweepOver(h, [listed(h, p, { cwd: d0 })])
    expect(holdsOf(h)).toEqual([hold(personaInstanceId(p), p, d0, OLD_LIFE_HOLD_CAUSE_START_SWEEP_KILL, true)])

    const view = beginApplyHold(h, p)

    expect(holdsOf(h)).toEqual([hold(personaInstanceId(p), p, d0, OLD_LIFE_HOLD_CAUSE_APPLY_STEP_1, true)])
    expect(h.oldLifeHolds.holdsOnDirectory(d1)).toEqual([])
    expect(h.oldLifeHolds.holdsOnDirectory(d0).map((held) => held.instanceId)).toEqual([personaInstanceId(p)])
    const began = beganLinesIn(h.errors)
    expect(began).toHaveLength(2)
    expect(began[1]).toBe(oldLifeHoldBeganLine(view, true))
    expect(began[1]).toContain(JSON.stringify(realpathSync(d0)))
    expect(began[1]).not.toContain(JSON.stringify(realpathSync(d1)))
    expectBeganAgainTail(began[1]!)
    expect(endedLinesIn(h.errors)).toEqual([])
  })

  test.each([...AGENT_DIRECTOR_LIVE_STATES])('an absent persona\'s row listed %s, its kill succeeding: held at its cwd from the listing (its key recorded by this sweep, no mark), unmarked, and the kill ends nothing', async (state) => {
    const { h } = build()
    const row = absentRow(h, { state })

    await sweepOver(h, [row])

    expect(h.stub.calls.killCalls.map((k) => k.claude_instance_id)).toEqual([row.claude_instance_id])
    expect(holdsOf(h)).toEqual([hold(row.claude_instance_id, LAUNCH_START_ABSENT_PERSONA_KEY, row.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING)])
    expect(beganLinesIn(h.errors)).toHaveLength(1)
  })

  test.each<[string, (h: RecoveryHarness, p: string) => Phase1ListRow, (h: RecoveryHarness, p: string) => string]>([
    ['P\'s own row in its directory: kept, with no kill', (h, p) => listed(h, p), (_h, p) => p],
    ['P\'s own row listed pending (a launch start): kept, with no kill', (h, p) => listed(h, p, { state: AGENT_DIRECTOR_PENDING_STATE }), (_h, p) => p],
    ['P\'s own row carrying provenance_conflict: spared for P\'s latch, with no kill', (h, p) => listed(h, p, { liveness_note: provenanceNote }), (_h, p) => p],
    ['P\'s row under another instance id: swept and killed, its instance id the old key', (h, p) => listed(h, p, { claude_instance_id: `${personaInstanceId(p)}_old` }), (_h, p) => `${personaInstanceId(p)}_old`],
  ])('P recorded without its mark, %s: one listing hold at the row\'s cwd', async (_label, row, oldKey) => {
    const { h, p } = build()
    h.retireKey(p)
    const listedRow = row(h, p)

    await sweepOver(h, [listedRow])

    expect(holdsOf(h)).toEqual([hold(listedRow.claude_instance_id, oldKey(h, p), listedRow.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING)])
    expect(beganLinesIn(h.errors)).toEqual([oldLifeHoldBeganLine(h.oldLifeHolds.snapshot()[0]!)])
  })

  test.each<[string, (h: RecoveryHarness, p: string, b: string) => Phase1ListRow[]]>([
    ['P recorded with its mark set, its own row live', (h, p) => {
      h.retireKey(p, { mark: true })
      return [listed(h, p, { state: AGENT_DIRECTOR_PENDING_STATE })]
    }],
    ['an absent persona\'s finished rows (its key recorded)', (h) => [...AGENT_DIRECTOR_DEAD_STATES].map((state, i) => absentRow(h, { state, claude_instance_id: `${personaInstanceId(LAUNCH_START_ABSENT_PERSONA_KEY)}_${i}` }))],
    ['B not recorded: its row under another instance id, killed', (h, _p, b) => [listed(h, b, { claude_instance_id: `${personaInstanceId(b)}_old` })]],
    ['P recorded without its mark, its own row finished', (h, p) => {
      h.retireKey(p)
      return [listed(h, p, { state: 'ended' })]
    }],
  ])('no hold: %s', async (_label, rows) => {
    const { h, p, b } = build()

    await sweepOver(h, rows(h, p, b))

    expect(holdsOf(h)).toEqual([])
    expect(holdLinesIn(h.errors)).toEqual([])
  })

  test.each<[string, (h: RecoveryHarness) => boolean, (h: RecoveryHarness, absent: Phase1ListRow) => HoldFields[]]>([
    ['by the time the list returns', (h) => h.stub.calls.listCalls.length > 0, () => []],
    ['once the absent key is recorded, before the first kill', (h) => h.retiredKeyWrites.length > 0, () => []],
    [
      'during the first kill\'s tries (ErrTmuxKillFailed): the listing hold begun before stands, unmarked; the stopped kill begins and marks nothing, and no later row is killed',
      (h) => h.stub.calls.killCalls.length > 0,
      (_h, absent) => [hold(absent.claude_instance_id, LAUNCH_START_ABSENT_PERSONA_KEY, absent.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING)],
    ],
  ])('the sweep\'s shutdown query answering true %s: no hold begins after it', async (_label, shuttingDown, expected) => {
    const { h, b } = build()
    h.script({ killError: errTmuxKillFailed() })
    const absent = absentRow(h)

    await sweepOver(h, [absent, listed(h, b, { claude_instance_id: `${personaInstanceId(b)}_old` })], () => shuttingDown(h))

    expect(holdsOf(h)).toEqual(expected(h, absent))
    expect(h.stub.calls.killCalls.length).toBeLessThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// No kill outcome ends a hold; only the ordinary alert marks it
// ---------------------------------------------------------------------------

/** One queued answer to a kill. */
type KillAnswer = NonNullable<RecoveryStubScript['killQueue']>[number]

/** Each answer a kill's tries can end with, the script giving it, and whether it decides the ordinary kill-failure alert (SRJ-812). */
const KILL_ANSWERS: ReadonlyArray<readonly [string, () => RecoveryStubScript, boolean]> = [
  ['ErrTmuxKillFailed at every try (the ordinary alert)', () => ({ killError: errTmuxKillFailed() }), true],
  ['a survivor-naming ErrTmuxKillFailed, then a success (the survivor version)', () => ({ killQueue: [cannedErr(errTmuxKillFailed(undefined, 'pane-process-survived')), cannedOk(cannedKillResult(true))] }), false],
  [
    'a survivor-naming ErrTmuxKillFailed, then ErrTmuxUnresponsive for the remaining tries (the ordinary alert)',
    () => ({ killQueue: [cannedErr(errTmuxKillFailed(undefined, 'pane-process-survived')), ...Array.from({ length: KILL_RETRY_TRIES - 1 }, (): KillAnswer => cannedErr(errTmuxUnresponsive('kill')))] }),
    true,
  ],
  [
    'a survivor-naming ErrTmuxKillFailed, then a CONFLICT (also the ordinary alert, SRJ-702)',
    () => ({ killQueue: [cannedErr(errTmuxKillFailed(undefined, 'pane-process-survived')), cannedErr(errTmuxSessionConflict('kill', 'different-id'))] }),
    true,
  ],
  ['a success with kill_sent true', () => ({ killResult: cannedKillResult(true) }), false],
  ['a success with kill_sent false (AC 63)', () => ({ killResult: cannedKillResult(false) }), false],
  ['ErrSpawnNotFound at the kill (gone: a success)', () => ({ killError: errSpawnNotFound() }), false],
  ['a CONFLICT (AC 54)', () => ({ killError: errTmuxSessionConflict('kill', 'different-id') }), false],
  ['an UNUSABLE NAME', () => ({ killError: errUnusableName() }), false],
  ['UNAVAILABLE at every try (ErrTmuxUnresponsive: no ordinary alert)', () => ({ killError: errTmuxUnresponsive('kill') }), false],
]

describe('b.jg5 SRJ-809, SRJ-703, SRJ-812 (AC 54, AC 63): no kill outcome ends a hold; only tries that decided the ordinary kill-failure alert mark it kill-failed', () => {
  afterEach(harnessAfterEach)

  test.each(KILL_ANSWERS)('the persona teardown\'s kill of P\'s held old life answering %s: the hold stays, with no end line', async (_label, script, marks) => {
    const { h, p } = build()
    const begun = beginApplyHold(h, p)
    h.script(script())

    await h.drive(killPersonaInstanceForTeardown(p, { clock: h.killRetryClock }))

    expect(holdsOf(h)).toEqual([{ ...fieldsOf(begun), killFailed: marks }])
    expect(endedLinesIn(h.errors)).toEqual([])
  })

  test.each(KILL_ANSWERS)('the start sweep\'s kill of an absent persona\'s held row answering %s: the listing hold stays through the post-kill find-missing that did not list it, with no end line', async (_label, script, marks) => {
    const { h } = build()
    h.script(script())
    const row = absentRow(h)

    await sweepOver(h, [row])

    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    expect(holdsOf(h)).toEqual([hold(row.claude_instance_id, LAUNCH_START_ABSENT_PERSONA_KEY, row.cwd, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING, marks)])
    expect(endedLinesIn(h.errors)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The new life
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809, SRJ-806: a reuse that begins the key\'s new life ends its hold', () => {
  afterEach(harnessAfterEach)

  test.each<[string, boolean]>([
    ['its mark written', false],
    ['its mark\'s write failed (held in memory)', true],
  ])('P recorded without its mark and held, its reuse answering fresh-retired (%s): P\'s hold ends for its new life with one line; B\'s hold stays', async (_label, failMark) => {
    const { h, p, b } = build()
    h.retireKey(p)
    const pHold = beginApplyHold(h, p)
    const bHold = beginApplyHold(h, b)
    h.script({ getError: errSpawnNotFound(), statusError: errSpawnNotFound() })
    if (failMark) h.failRetiredKeyWrites()

    expect(await h.launch(p)).toStrictEqual({ key: p, action: SPAWN_ACTION_FRESH_RETIRED })
    await h.runApproverToStop(p)

    expect(h.retiredEntry(p).marked).toBe(true)
    expect(holdsOf(h)).toEqual([fieldsOf(bHold)])
    expect(endedLinesIn(h.errors)).toEqual([oldLifeHoldEndedLine(pHold, OLD_LIFE_HOLD_END_NEW_LIFE, OLD_LIFE_NEW_LIFE_READ)])
  })
})

// ---------------------------------------------------------------------------
// The restart
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-809, SRJ-714 (hatch A3): after a restart the start sweep rebuilds the holds still needed from its list and the record', () => {
  afterEach(harnessAfterEach)

  /** P recorded as a destructive modify's old half (a credentials_file change whose teardown kill failed), with no mark, as the record a restart reads. */
  const RECORDED_P: RecoveryHarnessOptions = { retiredKeys: ([p]) => ({ [p!]: { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY } }) }

  test('the first server: apply step 1\'s hold on P and its failed teardown kill mark it kill-failed; the restarted server holds nothing until its sweep keeps P\'s own live row (its cwd still P\'s) and holds P\'s directory, naming cscb_<P>, unmarked', async () => {
    const first = build()
    first.h.retireKey(first.p, { cause: RETIRED_KEY_CAUSE_DESTRUCTIVE_MODIFY })
    beginApplyHold(first.h, first.p)
    first.h.script({ killError: errTmuxKillFailed() })
    await first.h.drive(killPersonaInstanceForTeardown(first.p, { clock: first.h.killRetryClock }))
    expect(holdsOf(first.h).map((h) => h.killFailed)).toEqual([true])
    // The restart: the first server's memory goes with it.
    harnessAfterEach()

    const { h, p } = build(RECORDED_P)
    expect(p).toBe(first.p)
    expect(holdsOf(h)).toEqual([])
    const row = listed(h, p)

    await sweepOver(h, [row])

    expect(h.stub.calls.killCalls).toEqual([])
    expect(holdsOf(h)).toEqual([hold(personaInstanceId(p), p, personaOf(h, p).working_directory, OLD_LIFE_HOLD_CAUSE_START_SWEEP_LISTING)])
    expect(h.oldLifeHolds.holdsWaitedOnBy(personaOf(h, p)).map((view) => view.instanceId)).toEqual([personaInstanceId(p)])
  })

  test.each(['ended', 'missing'])('a restart whose sweep lists P\'s own row %s rebuilds no hold', async (state) => {
    const { h, p } = build(RECORDED_P)

    await sweepOver(h, [listed(h, p, { state })])

    expect(holdsOf(h)).toEqual([])
    expect(holdLinesIn(h.errors)).toEqual([])
  })
})
