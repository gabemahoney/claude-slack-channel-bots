/**
 * tmux-unresponsive.test.ts — The per-persona `tmux-unresponsive` condition
 * (b.jg5 SRJ-307, SRJ-310; AC 25, AC 27, AC 64's no-post half).
 *
 * Every case runs on `makeRecoveryHarness` (both settings 0), with the
 * condition installed in the outage state as `main()` installs it and its
 * errors built by E4's by-name stub builders. Launches go through the real
 * `spawnForPersona` over the stub; the direct cases call the outage state's
 * wrapper (`withOutageDetection`) with the call the site declares, inside an
 * attempt (`runInAttempt`) where the case needs one.
 *
 * - What starts it: each UNAVAILABLE form but `ErrTmuxKillFailed`, from each
 *   tmux-touching call the launch ladder makes, inside the launch; nothing
 *   else (the kill-failure cause, read and sweep errors inside an attempt,
 *   kills not of a row read live, calls outside every attempt).
 * - Held apart from the outages: no flag raised or cleared, no onset or
 *   all-clear, and an outage's own all-clear neither held back nor joined.
 * - What ends it: a tmux-touching success or GONE, in any context, and the
 *   tick's end; a read's success does not. Ends are idempotent, and each end
 *   of a holding condition reaches the retry timer's condition-end entry once.
 * - Isolation: the other persona's condition, ends and notices are untouched.
 *
 * T2 posts nothing: every case asserts no episode notice. The onset, alert
 * and recovery cases extend this file in their own describes.
 *
 * No retry timer is real: the clock is the harness's fake clock, and the
 * only real-time waits are the spawn path's bounded 1 ms polls.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'

import {
  AD_CALL_KILL_ROW_NOT_READ_LIVE,
  AD_CALL_KILL_ROW_READ_LIVE,
  CSCB_UNKNOWN_ERROR_NAME,
  type AdCall,
} from '../src/ad-error-class.ts'
import { ErrCwdNotFound } from '../src/agent-director-errors.ts'
import { doublingBackoffDelay } from '../src/backoff.ts'
import type { Persona } from '../src/config.ts'
import { LIVENESS_LIVE, LIVENESS_READING_UNKNOWN } from '../src/liveness-reading.ts'
import {
  ALL_CLEAR_TEMPLATE,
  getOutageFlags,
  ONSET_TEMPLATES,
  withOutageDetection,
  type OutageClass,
} from '../src/outage-state.ts'
import { PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE } from '../src/persona-episodes.ts'
import { _buildIsSessionAliveAdapter, _buildKillSessionAdapter } from '../src/server.ts'
import { killPersonaInstance, reconcileOrphans } from '../src/session-manager.ts'
import {
  runInAttempt,
  UNAVAILABLE_RETRY_BASE_S,
  UNAVAILABLE_RETRY_CAUSE_KILL_FAILED,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CEILING_S,
  UNAVAILABLE_RETRY_ROW_PENDING,
  type UnavailableRetryConditionEndResult,
} from '../src/unavailable-retry.ts'
import {
  cannedErr,
  cannedGetResult,
  cannedListRow,
  cannedOk,
  cannedStatusResult,
  errCallTimeout,
  errGeneric,
  errInstanceIdCollision,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSendKeys,
  errTmuxUnresponsive,
  errTmuxUnresponsiveLaunchTimeout,
  errTmuxUnresponsiveStillStarting,
  errTmuxUnresponsiveStillStopping,
  errUnknownErrorName,
  type PersonaGetResultOverrides,
} from './test-helpers/agent-director-stub.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makeRecoveryHarness, type RecoveryHarness, type RecoveryStubScript } from './test-helpers/recovery-harness.ts'

const KIND = PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE

let harness: RecoveryHarness | undefined

afterEach(() => {
  const h = harness
  harness = undefined
  if (h === undefined) return
  assertNoLeak(h.captured())
  h.cleanup()
  expect(h.clock.pendingCount()).toBe(0)
})

/** A harness with both settings 0 (the harness default); returns it with its two persona keys, P first. */
function build(): { h: RecoveryHarness; p: string; b: string } {
  const h = (harness = makeRecoveryHarness())
  const [p, b] = h.keys as [string, string]
  return { h, p, b }
}

/** Half the retry timer's first wait, in ms: a clock step that fires no retry. */
function halfFirstWaitMs(): number {
  return (doublingBackoffDelay(UNAVAILABLE_RETRY_BASE_S, 0, UNAVAILABLE_RETRY_CEILING_S) * 1000) / 2
}

/** Persona `key` of the harness's configuration. */
function personaOf(h: RecoveryHarness, key: string): Persona {
  return h.config.personas.find((p) => p.key === key)!
}

/** The stub answers of a launch whose optimistic spawn collides and whose collision `get` reads `row`. */
function collided(h: RecoveryHarness, persona: Persona, row: PersonaGetResultOverrides): RecoveryStubScript {
  return {
    spawnQueue: [cannedErr(errInstanceIdCollision())],
    getResult: cannedGetResult(row, persona, h.home),
  }
}

/** Persona `key`'s condition started lines. */
function startedLines(h: RecoveryHarness, key: string): string[] {
  return h.lines.filter((line) => line.includes(`persona=${key} ${KIND} started`))
}

/** Persona `key`'s condition ended lines. */
function endedLines(h: RecoveryHarness, key: string): string[] {
  return h.lines.filter((line) => line.includes(`persona=${key} ${KIND} ended`))
}

/** Persona `key`'s condition holds, started once by `verb`, with its first refusal at `at`. */
function expectHolds(h: RecoveryHarness, key: string, verb: string, at: number): void {
  expect(h.tmuxUnresponsive.holds(key)).toBe(true)
  expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBe(at)
  const started = startedLines(h, key)
  expect(started).toHaveLength(1)
  expect(started[0]).toContain(` — ${verb} failed: `)
}

/** Persona `key`'s condition does not hold, never started and never ended. */
function expectNeverStarted(h: RecoveryHarness, key: string): void {
  expect(h.tmuxUnresponsive.holds(key)).toBe(false)
  expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBeUndefined()
  expect(startedLines(h, key)).toEqual([])
  expect(endedLines(h, key)).toEqual([])
  expect(h.conditionEnds.filter((end) => end.key === key)).toEqual([])
}

/** Nothing was posted for the condition, and no outage onset or all-clear was posted. */
function expectNoPosts(h: RecoveryHarness): void {
  expect(h.episodeNotices).toEqual([])
  expect(h.outageNotices).toEqual([])
}

/** Start P's condition: a launch whose optimistic spawn is refused `ErrTmuxUnresponsive`. Resolves with the refusal's time. */
async function refuse(h: RecoveryHarness, key: string): Promise<number> {
  h.script({ spawnError: errTmuxUnresponsive('spawn') })
  const at = h.clock.now()
  await h.launch(key)
  h.script({ spawnError: undefined })
  expect(h.tmuxUnresponsive.holds(key)).toBe(true)
  return at
}

// ---------------------------------------------------------------------------
// What starts it (SRJ-307; AC 25, AC 27)
// ---------------------------------------------------------------------------

/** E4's UNAVAILABLE forms other than `ErrTmuxKillFailed`, each built for the verb that meets it. */
const UNAVAILABLE_FORMS: ReadonlyArray<readonly [string, (verb: string) => Error]> = [
  ['ErrTmuxUnresponsive', (verb) => errTmuxUnresponsive(verb)],
  ['ErrTmuxUnresponsive, still stopping', (verb) => errTmuxUnresponsiveStillStopping(verb)],
  ['ErrTmuxUnresponsive, still starting', (verb) => errTmuxUnresponsiveStillStarting(verb)],
  ['ErrTmuxUnresponsive, launch timeout', (verb) => errTmuxUnresponsiveLaunchTimeout(verb)],
  ['ErrCallTimeout', (verb) => errCallTimeout(verb)],
  ['an unknown error name from a later binary', () => errUnknownErrorName()],
  ['a wrapped UnknownError', (verb) => errGeneric(verb, CSCB_UNKNOWN_ERROR_NAME, 'Error: boom')],
]

/** A tmux-touching call the launch ladder makes, and the stub answers that make it meet `err`. */
interface TmuxSite {
  readonly name: string
  readonly verb: string
  script(h: RecoveryHarness, persona: Persona, err: Error, make: (verb: string) => Error): RecoveryStubScript
}

const TMUX_SITES: readonly TmuxSite[] = [
  { name: 'the optimistic spawn', verb: 'spawn', script: (_h, _p, err) => ({ spawnError: err }) },
  { name: 'the resume of an ended row', verb: 'resume', script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), resumeError: err }) },
  {
    name: 'the dialog approver’s pane read after a spawn',
    verb: 'read-pane',
    script: (_h, _p, err) => ({ statusQueue: [cannedOk(cannedStatusResult({ state: 'pending' }))], readPaneError: err }),
  },
  { name: 'the reconnect of a waiting row', verb: 'send-keys', script: (h, p, err) => ({ ...collided(h, p, { state: 'waiting' }), sendKeysError: err }) },
  {
    // The row is `waiting` (read live) in another directory; its delete fails
    // too, so no later launch call touches tmux in this launch.
    name: 'the replacement kill of a row read live in another directory',
    verb: 'kill',
    script: (h, p, err, make) => ({ ...collided(h, p, { cwd: h.home, state: 'waiting' }), killError: err, deleteError: make('delete') }),
  },
]

describe('tmux-unresponsive: what starts it (SRJ-307)', () => {
  const cross = UNAVAILABLE_FORMS.flatMap(([what, make]) => TMUX_SITES.map((site) => [what, site.name, make, site] as const))

  test.each(cross)('%s at %s inside a launch starts P’s condition at the first refusal’s time; a second refusal keeps it; B’s never starts', async (_what, _site, make, site) => {
    const { h, p, b } = build()
    const firstAt = h.clock.now()
    h.script(site.script(h, personaOf(h, p), make(site.verb), make))

    await h.launch(p)

    expectHolds(h, p, site.verb, firstAt)

    await h.advance(halfFirstWaitMs())
    h.script({ spawnQueue: [], spawnError: errTmuxUnresponsive('spawn') })
    await h.launch(p)

    expect(h.clock.now()).toBeGreaterThan(firstAt)
    expectHolds(h, p, site.verb, firstAt)
    expect(h.conditionEnds).toEqual([])
    expectNeverStarted(h, b)
    expectNoPosts(h)
  })

  test('ErrTmuxKillFailed from the replacement kill of a row read live starts nothing and posts nothing (the kill-failure cause only)', async () => {
    const { h, p, b } = build()
    h.script({ ...collided(h, personaOf(h, p), { cwd: h.home, state: 'waiting' }), killError: errTmuxKillFailed() })

    await h.launch(p)

    expect(h.stub.calls.killCalls).toHaveLength(1)
    expect(h.triggers).toContainEqual({ key: p, kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED })
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPosts(h)
  })

  test.each<[string, string, (h: RecoveryHarness, persona: Persona) => RecoveryStubScript]>([
    ['the collision get', 'get', () => ({ spawnQueue: [cannedErr(errInstanceIdCollision())], getError: errCallTimeout('get') })],
    ['the readiness read after a spawn', 'status', () => ({ statusQueue: [cannedErr(errCallTimeout('status'))] })],
    ['the working-row read', 'status', (h, p) => ({ ...collided(h, p, { state: 'working' }), statusError: errCallTimeout('status') })],
    ['the sweep before a working-row wait', 'find-missing', (h, p) => ({ ...collided(h, p, { state: 'working' }), findMissingError: errCallTimeout('find-missing') })],
  ])('AC 27: ErrCallTimeout from %s (%s) inside a launch starts nothing and posts nothing; the retry timer is armed', async (_site, _verb, script) => {
    const { h, p, b } = build()
    h.script(script(h, personaOf(h, p)))

    await h.launch(p)

    expect(h.triggers).toContainEqual({ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPosts(h)
  })

  test.each<[string, AdCall]>([
    ['status', 'status'],
    ['get', 'get'],
    ['list', 'list'],
    ['find-missing', 'find-missing'],
    ['delete', 'delete'],
    ['a kill of a row not read live', AD_CALL_KILL_ROW_NOT_READ_LIVE],
  ])('inside a launch attempt, a wrapped %s call refused ErrTmuxUnresponsive starts nothing (the timer is armed)', async (_what, call) => {
    const { h, p, b } = build()

    await runInAttempt(p, 'launch', () =>
      expect(withOutageDetection(p, undefined, call, () => Promise.reject(errTmuxUnresponsive()))).rejects.toThrow(),
    )

    expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }])
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPosts(h)
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>, boolean]>([
    ['the restart path’s kill (after a dead reading), inside a recovery attempt', async (h, key) => {
      h.script({ killError: errTmuxUnresponsive('kill') })
      await runInAttempt(key, 'recovery', () => _buildKillSessionAdapter((k) => personaOf(h, k))(key))
    }, true],
    ['a persona teardown’s kill, even inside a recovery attempt', async (h, key) => {
      const err = errTmuxUnresponsive('kill')
      h.script({ killError: err })
      await runInAttempt(key, 'recovery', () => expect(killPersonaInstance(key)).rejects.toBe(err))
    }, true],
    ['a start-sweep kill of the persona’s row in another directory', async (h, key) => {
      h.script({
        listResult: { spawns: [cannedListRow({ cwd: h.home, state: 'waiting' }, personaOf(h, key), h.home)] },
        killError: errTmuxUnresponsive('kill'),
      })
      await reconcileOrphans(h.config)
    }, false],
  ])('%s answering ErrTmuxUnresponsive starts nothing', async (_what, run, insideAttempt) => {
    const { h, p, b } = build()

    await run(h, p)

    expect(h.stub.calls.killCalls).toHaveLength(1)
    expect(h.triggers).toEqual(insideAttempt ? [{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }] : [])
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPosts(h)
  })

  test('the health tick’s liveness read, outside every attempt, answering ErrTmuxUnresponsive starts nothing', async () => {
    const { h, p, b } = build()
    h.script({ statusError: errTmuxUnresponsive('status') })

    expect(await _buildIsSessionAliveAdapter(() => h.config)(p)).toEqual(LIVENESS_READING_UNKNOWN)

    expect(h.stub.calls.statusCalls).toHaveLength(1)
    expect(h.triggers).toEqual([])
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPosts(h)
  })

  test('with no condition sink installed, a launch refused ErrTmuxUnresponsive starts nothing', async () => {
    const h = (harness = makeRecoveryHarness({ conditionSink: false }))
    const [p] = h.keys as [string]
    h.script({ spawnError: errTmuxUnresponsive('spawn') })

    await h.launch(p)

    expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }])
    expectNeverStarted(h, p)
    expectNoPosts(h)
  })
})

// ---------------------------------------------------------------------------
// Held apart from the outages (SRJ-307; AC 25, AC 27)
// ---------------------------------------------------------------------------

/**
 * Raise an outage for persona `key` the way a wrapped `status` read does when
 * it answers `err`, and return the one flag it raised (taken from the outage
 * state, so no class label is written here).
 */
async function raiseOutage(key: string, workingDirectory: string | undefined, err: Error): Promise<OutageClass> {
  await expect(withOutageDetection(key, workingDirectory, 'status', () => Promise.reject(err))).rejects.toBe(err)
  const flags = [...getOutageFlags(key)]
  expect(flags).toHaveLength(1)
  return flags[0]!
}

describe('tmux-unresponsive: held apart from the outages', () => {
  test('raising and ending it leaves P’s outage flags as they were and posts no onset and no all-clear', async () => {
    const { h, p, b } = build()

    await refuse(h, p)
    expect([...getOutageFlags(p)]).toEqual([])

    // A tmux-unavailable outage raised while the condition holds.
    const raised = await raiseOutage(p, undefined, errTmuxNotAvailable(undefined, 'status'))

    expect(h.tickEnd(p)).toBe('ended')

    expect([...getOutageFlags(p)]).toEqual([raised])
    expect(h.outageNotices).toEqual([{ key: p, text: ONSET_TEMPLATES[raised]() }])
    expect(h.episodeNotices).toEqual([])
    expectNeverStarted(h, b)
  })

  test('a tmux-unavailable outage raised and cleared while the condition holds posts its single all-clear, neither held back nor joined; the condition still holds', async () => {
    const { h, p, b } = build()
    const at = await refuse(h, p)

    const raised = await raiseOutage(p, undefined, errTmuxNotAvailable(undefined, 'status'))
    await withOutageDetection(p, undefined, 'status', () => Promise.resolve(cannedStatusResult({ state: 'waiting' })))

    expect([...getOutageFlags(p)]).toEqual([])
    expect(h.outageNotices).toEqual([
      { key: p, text: ONSET_TEMPLATES[raised]() },
      { key: p, text: ALL_CLEAR_TEMPLATE(new Map([[raised, { detail: undefined }]])) },
    ])
    expectHolds(h, p, 'spawn', at)
    expect(h.conditionEnds).toEqual([])
    expect(h.episodeNotices).toEqual([])
    expectNeverStarted(h, b)
  })

  test('a cwd-unreachable outage raised before the condition keeps its flag and bad stretch through the start and the end', async () => {
    const { h, p, b } = build()
    const dir = personaOf(h, p).working_directory
    const raised = await raiseOutage(p, dir, new ErrCwdNotFound('status', 'ErrCwdNotFound', 'cwd not found'))

    await refuse(h, p)
    expect(h.tickEnd(p)).toBe('ended')

    expect([...getOutageFlags(p)]).toEqual([raised])
    expect(h.outageNotices).toEqual([{ key: p, text: ONSET_TEMPLATES[raised](dir) }])
    expect(h.episodeNotices).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// What ends it (SRJ-310)
// ---------------------------------------------------------------------------

/** A wrapped call's outcome: it resolves, or rejects with an error built at the call. */
type CallOutcome = { readonly resolves: true } | { readonly rejects: () => Error }

const RESOLVES: CallOutcome = { resolves: true }

/** Make the wrapped `call` for persona `key`, outside every attempt, with `outcome`. */
async function wrapped(key: string, call: AdCall, outcome: CallOutcome): Promise<void> {
  const fn = 'resolves' in outcome ? () => Promise.resolve({}) : () => Promise.reject(outcome.rejects())
  try {
    await withOutageDetection(key, undefined, call, fn)
  } catch {
    /* the wrapper rethrows; the case reads the condition */
  }
}

describe('tmux-unresponsive: what ends it (SRJ-310)', () => {
  test.each<[string, AdCall, CallOutcome, string | undefined, UnavailableRetryConditionEndResult]>([
    ['a spawn succeeds', 'spawn', RESOLVES, UNAVAILABLE_RETRY_ROW_PENDING, 'kept'],
    ['a resume succeeds', 'resume', RESOLVES, UNAVAILABLE_RETRY_ROW_PENDING, 'kept'],
    ['a read-pane succeeds', 'read-pane', RESOLVES, undefined, 'stopped'],
    ['a send-keys succeeds', 'send-keys', RESOLVES, undefined, 'stopped'],
    ['a pause succeeds', 'pause', RESOLVES, undefined, 'stopped'],
    ['a kill of a row read live succeeds', AD_CALL_KILL_ROW_READ_LIVE, RESOLVES, undefined, 'stopped'],
    ['a send-keys answers GONE (ErrTmuxSendKeys)', 'send-keys', { rejects: errTmuxSendKeys }, undefined, 'stopped'],
    ['a read-pane answers GONE (ErrTmuxCaptureFailed)', 'read-pane', { rejects: () => errTmuxCaptureFailed() }, undefined, 'stopped'],
  ])('%s, outside every attempt: the condition ends once, and the retry timer’s condition-end entry is called once with its reading', async (_what, call, outcome, reading, result) => {
    const { h, p, b } = build()
    await refuse(h, p)

    await wrapped(p, call, outcome)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBeUndefined()
    expect(endedLines(h, p)).toHaveLength(1)
    expect(h.conditionEnds).toEqual([{ key: p, reading, result }])
    expectNeverStarted(h, b)
    expectNoPosts(h)
  })

  test.each<[string, AdCall, CallOutcome]>([
    ['a status succeeds', 'status', RESOLVES],
    ['a get succeeds', 'get', RESOLVES],
    ['a list succeeds', 'list', RESOLVES],
    ['a find-missing succeeds', 'find-missing', RESOLVES],
    ['a delete succeeds', 'delete', RESOLVES],
    ['a kill of a row not read live succeeds', AD_CALL_KILL_ROW_NOT_READ_LIVE, RESOLVES],
    ['a status answers GONE (ErrTmuxCaptureFailed)', 'status', { rejects: () => errTmuxCaptureFailed(undefined, 'status') }],
  ])('%s: the condition still holds, with its first refusal’s time', async (_what, call, outcome) => {
    const { h, p, b } = build()
    const at = await refuse(h, p)

    await wrapped(p, call, outcome)

    expectHolds(h, p, 'spawn', at)
    expect(endedLines(h, p)).toEqual([])
    expect(h.conditionEnds).toEqual([])
    expectNeverStarted(h, b)
    expect(h.episodeNotices).toEqual([])
  })

  test('a later launch whose spawn succeeds ends it with the pending reading, and the retry timer is kept', async () => {
    const { h, p, b } = build()
    await refuse(h, p)

    await h.advance(halfFirstWaitMs())
    await h.launch(p)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.conditionEnds).toEqual([{ key: p, reading: UNAVAILABLE_RETRY_ROW_PENDING, result: 'kept' }])
    expect(h.controller.isArmed(p)).toBe(true)
    expectNeverStarted(h, b)
    expectNoPosts(h)
  })

  test('a later launch whose reconnect send-keys answers GONE ends it with no reading, before the launch’s own resume', async () => {
    const { h, p, b } = build()
    await refuse(h, p)

    h.script({ ...collided(h, personaOf(h, p), { state: 'waiting' }), sendKeysError: errTmuxSendKeys() })
    await h.launch(p)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.stub.calls.resumeCalls).toHaveLength(1)
    expect(h.conditionEnds).toEqual([{ key: p, reading: undefined, result: 'stopped' }])
    expect(endedLines(h, p)).toHaveLength(1)
    expectNeverStarted(h, b)
    expectNoPosts(h)
  })

  test('ends are idempotent: a second end, by any reason, does nothing', async () => {
    const { h, p, b } = build()
    await refuse(h, p)

    expect(h.tickEnd(p)).toBe('ended')
    expect(h.tickEnd(p)).toBe('not-holding')
    await wrapped(p, 'spawn', RESOLVES)

    expect(endedLines(h, p)).toHaveLength(1)
    expect(h.conditionEnds).toEqual([{ key: p, reading: LIVENESS_LIVE, result: 'stopped' }])
    expectNoPosts(h)
    expectNeverStarted(h, b)
  })

  test('after an end, a new refusal opens a new episode with a new first-refusal time', async () => {
    const { h, p, b } = build()
    const firstAt = await refuse(h, p)
    const firstEpisode = h.episodes.view(p, KIND)!.episode
    h.tickEnd(p)

    await h.advance(halfFirstWaitMs())
    const secondAt = await refuse(h, p)

    expect(secondAt).toBeGreaterThan(firstAt)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(secondAt)
    expect(h.episodes.view(p, KIND)!.episode).not.toBe(firstEpisode)
    expect(startedLines(h, p)).toHaveLength(2)
    expect(endedLines(h, p)).toHaveLength(1)
    expectNoPosts(h)
    expectNeverStarted(h, b)
  })
})

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe('tmux-unresponsive: isolation', () => {
  test('P and B each keep their own condition: ending P’s leaves B’s with its own first refusal’s time', async () => {
    const { h, p, b } = build()
    const pAt = await refuse(h, p)
    await h.advance(halfFirstWaitMs())
    const bAt = await refuse(h, b)

    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(pAt)
    expect(h.tmuxUnresponsive.firstRefusalAt(b)).toBe(bAt)

    await wrapped(p, 'send-keys', RESOLVES)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expectHolds(h, b, 'spawn', bAt)
    expect(endedLines(h, b)).toEqual([])
    expect(h.conditionEnds.map((end) => end.key)).toEqual([p])
    expectNoPosts(h)
  })
})
