/**
 * tmux-unresponsive.test.ts — The per-persona `tmux-unresponsive` condition
 * and its three notices (b.jg5 SRJ-307 to SRJ-310, SRJ-1006; AC 25, AC 26,
 * AC 27, AC 80, AC 64's no-post half).
 *
 * Every case runs on `makeRecoveryHarness` (both settings 0 unless a case
 * turns the health check on), with the condition installed in the outage
 * state as `main()` installs it and its errors built by E4's by-name stub
 * builders. Launches go through the real
 * `spawnForPersona` over the stub; the direct cases call the outage state's
 * wrapper (`withOutageDetection`) with the call the site declares, inside an
 * attempt (`runInAttempt`) where the case needs one.
 *
 * - What starts it: each UNAVAILABLE form but `ErrTmuxKillFailed` at one of
 *   the tmux-touching calls the launch ladder makes, every such call met by
 *   at least one form, inside the launch; nothing
 *   else (the kill-failure cause, read and sweep errors inside an attempt,
 *   kills not of a row read live, calls outside every attempt).
 * - Held apart from the outages: no flag raised or cleared, no onset or
 *   all-clear, and an outage's own all-clear neither held back nor joined.
 * - What ends it: a tmux-touching success or GONE, in any context, and the
 *   tick's end; a read's success does not. Ends are idempotent, and each end
 *   of a holding condition reaches the retry timer's condition-end entry once.
 * - Isolation: the other persona's condition, ends and notices are untouched.
 *
 * The cases above reach no onset (no health tick, no retry past the floor, no
 * alert threshold), so each asserts that nothing is posted yet. The notice
 * cases:
 *
 * - SRJ-1006's texts: one pin case holds the file's only literals (the three
 *   texts for a sample session name, the 120 s floor, "over 6 minutes" at
 *   agent-director's defaults and "over 3 minutes" at AC 80's settings);
 *   every other case builds its texts with the exported builders and its
 *   times from the exported floor and E6's threshold accessor. The log
 *   lines have no exported builder, so the recovery harness's line builders
 *   (`conditionOnsetLine`, `conditionAlertLine`, `conditionEndedLine`,
 *   `conditionRecoveryLine`, `conditionSilentEndLine`) and this file's
 *   (`onsetHeldLine`, `alertCancelledLine`, `alertRearmedLine`) hold their
 *   fixed words; their seconds come from the clock and the threshold in effect, and the notice cases assert every notice and
 *   ended line exactly, in order.
 * - The onset (SRJ-308): with the health check on, at the end of the first
 *   health tick that started after the first refusal while the condition
 *   still holds; with it off, at the first retry at least the floor after
 *   the first refusal, a retry skipped for a launch in flight included; once
 *   per episode, and never for `ErrTmuxKillFailed`.
 * - The alert (SRJ-309): once the condition has lasted strictly longer than
 *   the threshold in effect, once per episode, with no onset needed; retries
 *   go on and nothing is counted. Once it has posted, no onset follows in
 *   the episode, at a tick or at a retry (one `onset not posted` line).
 * - The alert and the retry timer (SRJ-309): every real stop of P's timer
 *   while the condition holds (the restart cap, not up, not applied, a
 *   teardown) cancels a pending alert check with one line naming the stop;
 *   an alert already posted stays. A later refusal in the episode arms the
 *   check again from the first refusal (one line), unless the stop was
 *   terminal (`UNAVAILABLE_RETRY_TERMINAL_STOPS`).
 * - The recovery (SRJ-310): one at the end, after an onset or an alert;
 *   none at a silent end or an end with neither. A new episode posts all
 *   three again; a teardown and the shutdown post nothing more.
 *
 * Tick-mode cases drive the tick's two hooks as `main()` binds them
 * (`tickEnd` for a persona the tick finds healthy, then `tickOnset` with the
 * tick's start). Every notice case asserts the whole list of posts: only
 * these texts, and no outage onset or all-clear (`ONSET_TEMPLATES`,
 * `ALL_CLEAR_TEMPLATE`).
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
  type AdCall,
} from '../src/ad-error-class.ts'
import { adAlertThresholdMs, adAlertThresholdMsInEffect, DEFAULT_AD_SETTINGS_IN_EFFECT } from '../src/ad-settings.ts'
import { ErrCwdNotFound } from '../src/agent-director-errors.ts'
import { doublingBackoffDelay, getFailureCount, isAtCap, recordFailure } from '../src/backoff.ts'
import type { Persona } from '../src/config.ts'
import { LIVENESS_LIVE, LIVENESS_READING_LIVE, LIVENESS_READING_UNKNOWN } from '../src/liveness-reading.ts'
import {
  ALL_CLEAR_TEMPLATE,
  getOutageFlags,
  ONSET_TEMPLATES,
  withOutageDetection,
  type OutageClass,
} from '../src/outage-state.ts'
import {
  PERSONA_EPISODE_KIND_TMUX_UNRESPONSIVE,
  TMUX_UNRESPONSIVE_END_TEXT,
  TMUX_UNRESPONSIVE_END_TICK,
  TMUX_UNRESPONSIVE_END_TMUX_VERB,
  TMUX_UNRESPONSIVE_ONSET_FLOOR_MS,
  tmuxUnresponsiveAlertText,
  tmuxUnresponsiveOnsetText,
  tmuxUnresponsiveRecoveryText,
  type TmuxUnresponsiveEndReason,
} from '../src/persona-episodes.ts'
import { personaInstanceId } from '../src/persona-identity.ts'
import { RESTART_FAILURE_CAP } from '../src/restart.ts'
import { _buildIsSessionAliveAdapter } from '../src/server.ts'
import { killPersonaInstance, reconcileOrphans } from '../src/session-manager.ts'
import {
  runInAttempt,
  UNAVAILABLE_RETRY_BASE_S,
  UNAVAILABLE_RETRY_CAUSE_KILL_FAILED,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CEILING_S,
  UNAVAILABLE_RETRY_ROW_PENDING,
  UNAVAILABLE_RETRY_STOP_CAPPED,
  UNAVAILABLE_RETRY_STOP_NOT_APPLIED,
  UNAVAILABLE_RETRY_STOP_NOT_UP,
  UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED,
  UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  UNAVAILABLE_RETRY_TERMINAL_STOPS,
  type UnavailableRetryConditionEndResult,
} from '../src/unavailable-retry.ts'
import {
  cannedErr,
  cannedListRow,
  cannedOk,
  cannedStatusResult,
  errCallTimeout,
  errInstanceIdCollision,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSendKeys,
  errTmuxUnresponsive,
  errTmuxUnresponsiveStillStopping,
  holdSpawns,
  unavailableForms,
} from './test-helpers/agent-director-stub.ts'
import type { AdConfigTables } from './test-helpers/ad-settings.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import {
  collided,
  conditionAlertLine,
  conditionEndedLine,
  conditionEndedLines,
  conditionLinePrefix,
  conditionLines,
  conditionOnsetLine,
  conditionRecoveryLine,
  conditionSilentEndLine,
  conditionStartedLines,
  makeRecoveryHarness,
  personaOf,
  retryNow,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
  type RecoveryNotice,
  type RecoveryStubScript,
} from './test-helpers/recovery-harness.ts'

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

/** A harness with both settings 0 unless `options` say otherwise; returns it with its two persona keys, P first. */
function build(options?: RecoveryHarnessOptions): { h: RecoveryHarness; p: string; b: string } {
  const h = (harness = makeRecoveryHarness(options))
  const [p, b] = h.keys as [string, string]
  return { h, p, b }
}

/** Half the retry timer's first wait, in ms: a clock step that fires no retry. */
function halfFirstWaitMs(): number {
  return (doublingBackoffDelay(UNAVAILABLE_RETRY_BASE_S, 0, UNAVAILABLE_RETRY_CEILING_S) * 1000) / 2
}

/** Persona `key`'s condition holds, started once by `verb`, with its first refusal at `at`. */
function expectHolds(h: RecoveryHarness, key: string, verb: string, at: number): void {
  expect(h.tmuxUnresponsive.holds(key)).toBe(true)
  expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBe(at)
  const started = conditionStartedLines(h, key)
  expect(started).toHaveLength(1)
  expect(started[0]).toContain(` — ${verb} failed: `)
}

/** Persona `key`'s condition does not hold, never started and never ended. */
function expectNeverStarted(h: RecoveryHarness, key: string): void {
  expect(h.tmuxUnresponsive.holds(key)).toBe(false)
  expect(h.tmuxUnresponsive.firstRefusalAt(key)).toBeUndefined()
  expect(conditionStartedLines(h, key)).toEqual([])
  expect(conditionEndedLines(h, key)).toEqual([])
  expect(h.conditionEnds.filter((end) => end.key === key)).toEqual([])
}

/**
 * No notice yet: the condition's start and its end post nothing of their own
 * (the onset waits for a later health tick or a retry past the floor, which
 * the start and end cases never reach, so no recovery follows either), and no
 * outage onset or all-clear is posted.
 */
function expectNoPostYet(h: RecoveryHarness): void {
  expect(h.episodeNotices).toEqual([])
  expect(h.outageNotices).toEqual([])
}

/**
 * Start (or continue) persona `key`'s condition: a launch whose optimistic
 * spawn is refused `make('spawn')` (`ErrTmuxUnresponsive` by default).
 * Resolves with the refusal's time.
 */
async function refuse(h: RecoveryHarness, key: string, make: (verb: string) => Error = errTmuxUnresponsive): Promise<number> {
  h.script({ spawnError: make('spawn') })
  const at = h.clock.now()
  await h.launch(key)
  h.script({ spawnError: undefined })
  expect(h.tmuxUnresponsive.holds(key)).toBe(true)
  return at
}

// ---------------------------------------------------------------------------
// What starts it (SRJ-307; AC 25, AC 27)
// ---------------------------------------------------------------------------

/** E4's UNAVAILABLE forms of agent-director's own errors other than `ErrTmuxKillFailed`, each built for the verb that meets it. */
const TMUX_STARTING_FORMS = unavailableForms(
  'ErrTmuxUnresponsive',
  'ErrTmuxUnresponsive, still stopping',
  'ErrTmuxUnresponsive, still starting',
  'ErrTmuxUnresponsive, launch timeout',
  'ErrCallTimeout',
  ['ErrUnknownErrorName', 'an unknown error name from a later binary'],
  'a wrapped UnknownError',
)

/** A tmux-touching call the launch ladder makes, and the stub answers that make it meet `err`. */
interface TmuxSite {
  readonly name: string
  readonly verb: string
  script(h: RecoveryHarness, persona: Persona, err: Error): RecoveryStubScript
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
    // The row is `waiting` (read live) in another directory. The refused kill
    // stops the ladder at once (b.jg5 SRJ-105): no delete and no spawn follow,
    // so no later launch call touches tmux in this launch.
    name: 'the replacement kill of a row read live in another directory',
    verb: 'kill',
    script: (h, p, err) => ({ ...collided(h, p, { cwd: h.home, state: 'waiting' }), killError: err }),
  },
]

describe('tmux-unresponsive: what starts it (SRJ-307)', () => {
  // Every form at one site and every site with at least one form: the shorter
  // list cycles under the longer. The full form × site matrix is
  // session-manager's; the by-name classifier is outage-state's.
  const paired = Array.from({ length: Math.max(TMUX_STARTING_FORMS.length, TMUX_SITES.length) }, (_, i) => {
    const [what, make] = TMUX_STARTING_FORMS[i % TMUX_STARTING_FORMS.length]!
    const site = TMUX_SITES[i % TMUX_SITES.length]!
    return [what, site.name, make, site] as const
  })

  test.each(paired)('%s at %s inside a launch starts P’s condition at the first refusal’s time; a second refusal keeps it; B’s never starts', async (_what, _site, make, site) => {
    const { h, p, b } = build()
    const firstAt = h.clock.now()
    h.script(site.script(h, personaOf(h, p), make(site.verb)))

    await h.launch(p)

    expectHolds(h, p, site.verb, firstAt)

    await h.advance(halfFirstWaitMs())
    h.script({ spawnQueue: [], spawnError: errTmuxUnresponsive('spawn') })
    await h.launch(p)

    expect(h.clock.now()).toBeGreaterThan(firstAt)
    expectHolds(h, p, site.verb, firstAt)
    expect(h.conditionEnds).toEqual([])
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  test('ErrTmuxKillFailed from the replacement kill of a row read live starts nothing and posts nothing (the kill-failure cause only)', async () => {
    const { h, p, b } = build()
    h.script({ ...collided(h, personaOf(h, p), { cwd: h.home, state: 'waiting' }), killError: errTmuxKillFailed() })

    await h.launch(p)

    expect(h.stub.calls.killCalls).toHaveLength(1)
    expect(h.triggers).toContainEqual({ key: p, kind: UNAVAILABLE_RETRY_CAUSE_KILL_FAILED })
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
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
    expectNoPostYet(h)
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
    expectNoPostYet(h)
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>, boolean]>([
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
    expectNoPostYet(h)
  })

  test('the health tick’s liveness read, outside every attempt, answering ErrTmuxUnresponsive starts nothing', async () => {
    const { h, p, b } = build()
    h.script({ statusError: errTmuxUnresponsive('status') })

    expect(await _buildIsSessionAliveAdapter(() => h.config)(p)).toEqual(LIVENESS_READING_UNKNOWN)

    expect(h.stub.calls.statusCalls).toHaveLength(1)
    expect(h.triggers).toEqual([])
    expectNeverStarted(h, p)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  test('with no condition sink installed, a launch refused ErrTmuxUnresponsive starts nothing', async () => {
    const h = (harness = makeRecoveryHarness({ conditionSink: false }))
    const [p] = h.keys as [string]
    h.script({ spawnError: errTmuxUnresponsive('spawn') })

    await h.launch(p)

    expect(h.triggers).toEqual([{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }])
    expectNeverStarted(h, p)
    expectNoPostYet(h)
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

    // The condition's end hook alone; the health tick's own clear of
    // tmux-unavailable (SRJ-312) is health-check's, not the condition's.
    expect(h.tickEnd(p)).toBe('ended')

    expect([...getOutageFlags(p)]).toEqual([raised])
    expect(h.outageNotices).toEqual([{ key: p, text: ONSET_TEMPLATES[raised]() }])
    expect(h.episodeNotices).toEqual([])
    expectNeverStarted(h, b)
  })

  // b.jg5 SRJ-312: only tmux answering clears tmux-unavailable (a
  // tmux-touching success or GONE, or a check that finds the row live and
  // connected), and each of those ends the condition too. The wrapper's
  // success and GONE branches clear the outage first and end the condition
  // after, in the same call, so its all-clear is posted while the condition
  // still holds; the tick and the retry end the condition first. The case
  // records whether the condition holds at each outage post.
  test.each<[string, (key: string) => Promise<void>]>([
    ['a send-keys that succeeds', (key) => wrapped(key, 'send-keys', RESOLVES)],
    ['a read-pane that answers GONE (ErrTmuxCaptureFailed)', (key) => wrapped(key, 'read-pane', { rejects: () => errTmuxCaptureFailed() })],
  ])('a tmux-unavailable outage raised while the condition holds, cleared by %s, posts its single all-clear while the condition still holds, neither held back nor joined; the condition, untouched by the outage, then ends by its own reason with its own recovery', async (_what, clear) => {
    const { h, p, b } = build(TICK_MODE)
    const at = await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)
    expectPosts(h, [onset(p)])

    const raised = await raiseOutage(p, undefined, errTmuxNotAvailable(undefined, 'status'))

    // The outage's onset leaves the condition as it was.
    expectHolds(h, p, 'spawn', at)
    expect(conditionEndedLines(h, p)).toEqual([])
    expect(h.conditionEnds).toEqual([])

    const holdsAtOutagePost: boolean[] = []
    const post = h.outageNotices.push.bind(h.outageNotices)
    h.outageNotices.push = (...notices: RecoveryNotice[]) => {
      holdsAtOutagePost.push(h.tmuxUnresponsive.holds(p))
      return post(...notices)
    }

    await clear(p)

    // The outage: cleared, with one all-clear naming it alone, posted while the condition held.
    expect([...getOutageFlags(p)]).toEqual([])
    expect(h.outageNotices).toEqual([
      { key: p, text: ONSET_TEMPLATES[raised]() },
      { key: p, text: ALL_CLEAR_TEMPLATE(new Map([[raised, { detail: undefined }]])) },
    ])
    expect(holdsAtOutagePost).toEqual([true])
    // The clear came first: it reached the retry timer's condition-end entry
    // and stopped P's timer (SRJ-306), which, as every real stop while the
    // condition holds, cancelled its pending alert check (SRJ-309).
    expect(h.outageClears).toEqual([{ key: p, reading: undefined, result: 'stopped' }])

    // The condition: its own end (the tmux verb), once, with its own recovery,
    // apart from the all-clear; the timer was already stopped when it ended.
    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.episodeNotices).toEqual([onset(p), recovery(p)])
    expect(noticeAndEndLines(h, p)).toEqual([
      conditionOnsetLine(p, 'a health tick', tickMs(h)),
      alertCancelledLine(p, UNAVAILABLE_RETRY_STOP_TMUX_UNAVAILABLE_CLEARED),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TMUX_VERB),
      conditionRecoveryLine(p),
    ])
    expect(h.conditionEnds).toEqual([{ key: p, reading: undefined, result: 'not-armed' }])
    expectNeverStarted(h, b)
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>]>([
    ['a wrapped status', async (_h, key) => {
      await withOutageDetection(key, undefined, 'status', () => Promise.resolve(cannedStatusResult({ state: 'waiting' })))
    }],
    ['the health tick’s liveness read (its bare status)', async (h, key) => {
      h.script({ statusResult: cannedStatusResult({ state: 'waiting' }) })
      const before = h.stub.calls.statusCalls.length
      expect(await _buildIsSessionAliveAdapter(() => h.config)(key)).toEqual(LIVENESS_READING_LIVE)
      expect(h.stub.calls.statusCalls).toHaveLength(before + 1)
    }],
  ])('SRJ-312: %s that succeeds while the tmux-unavailable outage and the condition are both active clears neither and posts nothing', async (_what, read) => {
    const { h, p, b } = build()
    const at = await refuse(h, p)
    const raised = await raiseOutage(p, undefined, errTmuxNotAvailable(undefined, 'status'))

    await read(h, p)

    expect([...getOutageFlags(p)]).toEqual([raised])
    expect(h.outageNotices).toEqual([{ key: p, text: ONSET_TEMPLATES[raised]() }])
    expect(h.outageClears).toEqual([])
    expect(h.controller.isArmed(p)).toBe(true)
    expectHolds(h, p, 'spawn', at)
    expect(conditionEndedLines(h, p)).toEqual([])
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

    // A later launch whose spawn succeeds clears the flag: the all-clear
    // names the cwd outage alone, so the condition added nothing to the stretch.
    await h.advance(halfFirstWaitMs())
    await h.launch(p)

    expect([...getOutageFlags(p)]).toEqual([])
    expect(h.outageNotices).toEqual([
      { key: p, text: ONSET_TEMPLATES[raised](dir) },
      { key: p, text: ALL_CLEAR_TEMPLATE(new Map([[raised, { detail: dir }]])) },
    ])
    expect(h.episodeNotices).toEqual([])
    expectNeverStarted(h, b)
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
    expect(conditionEndedLines(h, p)).toHaveLength(1)
    expect(h.conditionEnds).toEqual([{ key: p, reading, result }])
    expectNeverStarted(h, b)
    expectNoPostYet(h)
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
    expect(conditionEndedLines(h, p)).toEqual([])
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
    expectNoPostYet(h)
  })

  test('a later launch whose reconnect send-keys answers GONE ends it with no reading, before the launch’s own resume', async () => {
    const { h, p, b } = build()
    await refuse(h, p)

    h.script({ ...collided(h, personaOf(h, p), { state: 'waiting' }), sendKeysError: errTmuxSendKeys() })
    await h.launch(p)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.stub.calls.resumeCalls).toHaveLength(1)
    expect(h.conditionEnds).toEqual([{ key: p, reading: undefined, result: 'stopped' }])
    expect(conditionEndedLines(h, p)).toHaveLength(1)
    expectNeverStarted(h, b)
    expectNoPostYet(h)
  })

  test('ends are idempotent: a second end, by any reason, does nothing', async () => {
    const { h, p, b } = build()
    await refuse(h, p)

    expect(h.tickEnd(p)).toBe('ended')
    expect(h.tickEnd(p)).toBe('not-holding')
    await wrapped(p, 'spawn', RESOLVES)

    expect(conditionEndedLines(h, p)).toHaveLength(1)
    expect(h.conditionEnds).toEqual([{ key: p, reading: LIVENESS_LIVE, result: 'stopped' }])
    expectNoPostYet(h)
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
    expect(conditionStartedLines(h, p)).toHaveLength(2)
    expect(conditionEndedLines(h, p)).toHaveLength(1)
    expectNoPostYet(h)
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
    expect(conditionEndedLines(h, b)).toEqual([])
    expect(h.conditionEnds.map((end) => end.key)).toEqual([p])
    expectNoPostYet(h)
  })
})

// ---------------------------------------------------------------------------
// The notices (SRJ-308, SRJ-309, SRJ-310's recovery, SRJ-1006)
// ---------------------------------------------------------------------------

/** AC 80's agent-director settings: the alert threshold is the longer of the two plus E6's addend. */
const AC_80_TMUX = { stopping_window_seconds: 30n, starting_session_seconds: 120n } as const satisfies AdConfigTables['tmux']

/** The health check on (any interval but 0); the harness has no tick of its own, so a case runs each tick with `tick`. */
const HEALTH_CHECK_S = 60

/** Health check off, every retry refused, no alert check: the onset comes at a retry past the floor. */
const RETRY_MODE: RecoveryHarnessOptions = { action: 'scripted', alertThresholdMs: false }

/** Health check on, every retry refused, the alert check over E6's threshold in effect. */
const TICK_MODE: RecoveryHarnessOptions = { action: 'scripted', healthCheckInterval: HEALTH_CHECK_S }

const FLOOR_MS = TMUX_UNRESPONSIVE_ONSET_FLOOR_MS

function onset(key: string): RecoveryNotice {
  return { key, text: tmuxUnresponsiveOnsetText(key) }
}

function alert(key: string, thresholdMs: number): RecoveryNotice {
  return { key, text: tmuxUnresponsiveAlertText(key, thresholdMs) }
}

function recovery(key: string): RecoveryNotice {
  return { key, text: tmuxUnresponsiveRecoveryText(key) }
}

/** Every notice the episodes posted, in order, is `expected`, and no outage onset or all-clear was posted. */
function expectPosts(h: RecoveryHarness, expected: readonly RecoveryNotice[]): void {
  expect(h.episodeNotices).toEqual([...expected])
  expect(h.outageNotices).toEqual([])
}

/** The health tick's spacing, in ms, from the configuration. */
function tickMs(h: RecoveryHarness): number {
  return h.config.health_check_interval * 1000
}

/**
 * One health tick, as `main()` binds its hooks: the tick starts now, its
 * healthy branch ends the condition of each persona in `live`, and its end
 * runs the onset check for the tick's start.
 */
function tick(h: RecoveryHarness, live: readonly string[] = []): void {
  const startedAt = h.clock.now()
  for (const key of live) h.tickEnd(key)
  h.tickOnset(startedAt)
}

/** Move the clock to persona `key`'s next retry and run it, unsettled; resolves with the time it was due. */
async function nextRetry(h: RecoveryHarness, key: string): Promise<number> {
  const due = await retryNow(h, key, { settle: false })
  expect(h.attempts.at(-1)).toMatchObject({ key, at: due })
  return due
}

/** How many retries persona `key`'s timer has run. */
function retriesOf(h: RecoveryHarness, key: string): number {
  return h.attempts.filter((attempt) => attempt.key === key).length
}

/** Persona `key`'s condition lines after its started lines, in order: its notice lines and its ended lines. */
function noticeAndEndLines(h: RecoveryHarness, key: string): string[] {
  return conditionLines(h, key).filter((line) => !line.startsWith(`${conditionLinePrefix(key)}started`))
}

describe('tmux-unresponsive: SRJ-1006’s texts (pin)', () => {
  test('the one pin case: the three texts for a sample session name, the 120 s floor, "over 6 minutes" at agent-director’s defaults and "over 3 minutes" (180 s) at AC 80’s settings', () => {
    const ac80 = { ...DEFAULT_AD_SETTINGS_IN_EFFECT, tmux: { ...DEFAULT_AD_SETTINGS_IN_EFFECT.tmux, ...AC_80_TMUX } }

    expect(tmuxUnresponsiveOnsetText('sample')).toBe(
      ':hourglass_flowing_sand: *Not answering* — agent-director or tmux is not answering for this persona\'s session "slack_bot_sample". CSCB keeps retrying; nothing is needed yet.',
    )
    expect(tmuxUnresponsiveAlertText('sample', adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT))).toBe(
      ':rotating_light: *Still not answering* — this persona has not reached its session "slack_bot_sample" for over 6 minutes. CSCB keeps retrying and takes no destructive action. If this persists, a human should check the host\'s tmux server and agent-director.',
    )
    expect(tmuxUnresponsiveRecoveryText('sample')).toBe(
      ':white_check_mark: *Answering again* — this persona reaches its session "slack_bot_sample" again.',
    )
    expect(TMUX_UNRESPONSIVE_ONSET_FLOOR_MS).toBe(120_000)
    expect(adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT)).toBe(360_000)
    expect(adAlertThresholdMs(ac80)).toBe(180_000)
    expect(tmuxUnresponsiveAlertText('sample', adAlertThresholdMs(ac80))).toContain(' for over 3 minutes. ')
  })
})

describe('tmux-unresponsive: the onset with the health check on (SRJ-308; AC 25)', () => {
  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>]>([
    ['a tmux-touching success before the next tick', (_h, key) => wrapped(key, 'send-keys', RESOLVES)],
    ['the next tick finding it live, before that tick’s onset check', async (h, key) => {
      await h.advance(tickMs(h))
      tick(h, [key])
    }],
  ])('a single still-stopping refusal cleared by %s posts nothing, then or at any later tick', async (_what, clear) => {
    const { h, p, b } = build(TICK_MODE)
    await refuse(h, p, errTmuxUnresponsiveStillStopping)

    await clear(h, p)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    // Ticks until past the alert threshold: no onset, and no alert either.
    const ticks = Math.ceil(adAlertThresholdMsInEffect() / tickMs(h)) + 1
    for (let n = 0; n < ticks; n++) {
      await h.advance(tickMs(h))
      tick(h)
    }
    expectPosts(h, [])
    expectNeverStarted(h, b)
  })

  test('a refusal that holds posts one onset, the builder’s text, at the first tick that started after it, and none at later ticks; a tick started before it or at its own time posts none', async () => {
    const { h, p, b } = build(TICK_MODE)
    const earlierTick = h.clock.now()
    await h.advance(1)
    const at = await refuse(h, p, errTmuxUnresponsiveStillStopping)

    h.tickOnset(earlierTick)
    h.tickOnset(at)
    expectPosts(h, [])

    await h.advance(tickMs(h))
    const tickAt = h.clock.now()
    tick(h)
    expectPosts(h, [onset(p)])
    const lines = [conditionOnsetLine(p, 'a health tick', tickAt - at)]
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    for (let n = 0; n < 3; n++) {
      await h.advance(tickMs(h))
      tick(h)
    }
    expect(h.clock.now() - at).toBeLessThan(adAlertThresholdMsInEffect())
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expectNeverStarted(h, b)
  })

  test('the mode is read at each check: with the health check on, a retry past the floor posts nothing; turned off, a tick posts nothing and the next retry posts the onset', async () => {
    const { h, p } = build({ ...TICK_MODE, alertThresholdMs: false })
    const at = await refuse(h, p)

    while (h.clock.now() - at < FLOOR_MS) await nextRetry(h, p)
    expectPosts(h, [])

    h.setHealthCheckInterval(0)
    h.tickOnset()
    expectPosts(h, [])

    const firedAt = await nextRetry(h, p)
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual([conditionOnsetLine(p, 'a retry', firedAt - at)])
  })
})

describe('tmux-unresponsive: the onset with the health check off (SRJ-308)', () => {
  test('no onset at the retries before the floor; one, the builder’s text, at the first retry at or past it; none at later retries', async () => {
    const { h, p, b } = build(RETRY_MODE)
    const at = await refuse(h, p)

    let firedAt = at
    while (firedAt - at < FLOOR_MS) {
      expectPosts(h, [])
      firedAt = await nextRetry(h, p)
    }
    expect(retriesOf(h, p)).toBeGreaterThan(1)
    expectPosts(h, [onset(p)])
    const lines = [conditionOnsetLine(p, 'a retry', firedAt - at)]
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    for (let n = 0; n < 3; n++) await nextRetry(h, p)
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
    expectNeverStarted(h, b)
  })

  test.each([
    ['1 ms short of the floor posts nothing; the next retry posts the onset', 1],
    ['exactly the floor after the first refusal posts the onset', 0],
  ])('a retry %s', async (_what, shortMs) => {
    const { h, p } = build(RETRY_MODE)
    h.controller.arm(p, { kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })
    while (h.controller.view(p)!.dueAt! - h.clock.now() < FLOOR_MS) await nextRetry(h, p)
    const due = h.controller.view(p)!.dueAt!
    await h.advance(due - FLOOR_MS + shortMs - h.clock.now())
    expect(h.tmuxUnresponsive.start(p, 'spawn', errTmuxUnresponsive('spawn'))).toBe('started')

    const at = h.tmuxUnresponsive.firstRefusalAt(p)!
    expect(await nextRetry(h, p)).toBe(due)
    expect(due - at).toBe(FLOOR_MS - shortMs)
    expectPosts(h, shortMs === 0 ? [onset(p)] : [])
    const lines = shortMs === 0 ? [conditionOnsetLine(p, 'a retry', FLOOR_MS)] : []
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    const nextAt = await nextRetry(h, p)
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual(shortMs === 0 ? lines : [conditionOnsetLine(p, 'a retry', nextAt - at)])
  })

  test('a retry skipped because P’s launch is in flight, at or past the floor, posts the onset and makes no agent-director call', async () => {
    const { h, p, b } = build(RETRY_MODE)
    const at = await refuse(h, p)
    while (h.controller.view(p)!.dueAt! - at < FLOOR_MS) await nextRetry(h, p)
    expectPosts(h, [])

    const hold = holdSpawns(h.stub.client)
    const launch = h.launch(p)
    await hold.entered(personaInstanceId(p))
    // The server's retry action, which skips a retry while a launch is in flight.
    h.setAction(undefined)
    const calls = h.stub.callCount()

    const firedAt = await nextRetry(h, p)

    expect(h.stub.callCount()).toBe(calls)
    expect(h.controller.isArmed(p)).toBe(true)
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual([conditionOnsetLine(p, 'a retry', firedAt - at)])

    hold.fail(personaInstanceId(p), errTmuxUnresponsive('spawn'))
    await launch
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expectPosts(h, [onset(p)])
    expectNeverStarted(h, b)
  })

  test('ErrTmuxKillFailed never posts a tmux-unresponsive notice: not at retries past the floor and the threshold, nor at a tick', async () => {
    const { h, p } = build({ action: 'scripted' })
    h.script({ ...collided(h, personaOf(h, p), { cwd: h.home, state: 'waiting' }), killError: errTmuxKillFailed() })
    await h.launch(p)

    await h.advance(2 * adAlertThresholdMsInEffect())
    h.setHealthCheckInterval(HEALTH_CHECK_S)
    tick(h)

    expect(retriesOf(h, p)).toBeGreaterThan(1)
    expectNeverStarted(h, p)
    expectPosts(h, [])
  })
})

describe('tmux-unresponsive: the alert (SRJ-309; AC 26, AC 80)', () => {
  test('at agent-director’s defaults, with no onset: nothing at exactly the threshold, one alert 1 ms past it, none again however far the clock moves; retries go on and nothing is counted; B stays silent', async () => {
    const { h, p, b } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    expect(thresholdMs).toBe(adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT))
    const at = await refuse(h, p)

    await h.advance(at + thresholdMs - h.clock.now())
    expectPosts(h, [])

    await h.advance(1)
    expectPosts(h, [alert(p, thresholdMs)])
    const lines = [conditionAlertLine(p, h.clock.now() - at, thresholdMs)]
    expect(h.clock.now() - at).toBe(thresholdMs + 1)
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    const retries = retriesOf(h, p)
    await h.advance(10 * thresholdMs)
    expectPosts(h, [alert(p, thresholdMs)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
    expect(retriesOf(h, p)).toBeGreaterThan(retries)
    expect(h.controller.isArmed(p)).toBe(true)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expect(getFailureCount(p)).toBe(0)
    expect(h.capReached).toEqual([])
    expectNeverStarted(h, b)
  })

  test('AC 80: with the settings in effect read from agent-director’s file before the first refusal, the alert comes just past their threshold, not the defaults’, and its minutes are theirs', async () => {
    const { h, p } = build({ ...TICK_MODE, adSettings: { tmux: AC_80_TMUX } })
    expect(h.settings().tmux).toMatchObject(AC_80_TMUX)
    const thresholdMs = adAlertThresholdMsInEffect()
    expect(thresholdMs).toBe(adAlertThresholdMs(h.settings()))
    expect(thresholdMs).toBeLessThan(adAlertThresholdMs(DEFAULT_AD_SETTINGS_IN_EFFECT))
    const at = await refuse(h, p)

    await h.advance(at + thresholdMs - h.clock.now())
    expectPosts(h, [])

    await h.advance(1)
    expectPosts(h, [alert(p, thresholdMs)])
    expect(noticeAndEndLines(h, p)).toEqual([conditionAlertLine(p, thresholdMs + 1, thresholdMs)])
  })

  test('a condition that ends before the threshold posts no alert and leaves nothing pending', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    await refuse(h, p)

    await h.advance(thresholdMs / 2)
    expect(h.tickEnd(p)).toBe('ended')

    expect(h.controller.isArmed(p)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    await h.advance(2 * thresholdMs)
    expectPosts(h, [])
  })
})

describe('tmux-unresponsive: the recovery (SRJ-310)', () => {
  test.each<[string, (h: RecoveryHarness, key: string) => Promise<void>, TmuxUnresponsiveEndReason]>([
    ['a health tick finding it live', async (h, key) => tick(h, [key]), TMUX_UNRESPONSIVE_END_TICK],
    ['a tmux-touching success', (_h, key) => wrapped(key, 'send-keys', RESOLVES), TMUX_UNRESPONSIVE_END_TMUX_VERB],
  ])('%s after the onset posts one recovery, the builder’s text; a later end posts nothing more', async (_what, end, reason) => {
    const { h, p, b } = build(TICK_MODE)
    const at = await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)
    expectPosts(h, [onset(p)])

    await end(h, p)
    expectPosts(h, [onset(p), recovery(p)])
    const lines = [conditionOnsetLine(p, 'a health tick', tickMs(h)), conditionEndedLine(p, reason), conditionRecoveryLine(p)]
    expect(h.clock.now() - at).toBe(tickMs(h))
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    expect(h.tickEnd(p)).toBe('not-holding')
    await wrapped(p, 'send-keys', RESOLVES)
    expectPosts(h, [onset(p), recovery(p)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
    expect(h.conditionEnds).toHaveLength(1)
    expectNeverStarted(h, b)
  })

  test('after the onset and the alert, the end posts one recovery', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)
    await h.advance(at + thresholdMs + 1 - h.clock.now())
    expectPosts(h, [onset(p), alert(p, thresholdMs)])

    expect(h.tickEnd(p)).toBe('ended-after-notice')

    expectPosts(h, [onset(p), alert(p, thresholdMs), recovery(p)])
    expect(noticeAndEndLines(h, p)).toEqual([
      conditionOnsetLine(p, 'a health tick', tickMs(h)),
      conditionAlertLine(p, thresholdMs + 1, thresholdMs),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TICK),
      conditionRecoveryLine(p),
    ])
  })

  test('an end after the alert alone (no onset) posts one recovery; a later end posts nothing more', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await h.advance(at + thresholdMs + 1 - h.clock.now())
    expectPosts(h, [alert(p, thresholdMs)])

    expect(h.tickEnd(p)).toBe('ended-after-notice')

    expectPosts(h, [alert(p, thresholdMs), recovery(p)])
    const lines = [conditionAlertLine(p, thresholdMs + 1, thresholdMs), conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TICK), conditionRecoveryLine(p)]
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    expect(h.tickEnd(p)).toBe('not-holding')
    expectPosts(h, [alert(p, thresholdMs), recovery(p)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
  })

  test('an end with neither the onset nor the alert posted answers `ended` and posts no recovery', async () => {
    const { h, p } = build(TICK_MODE)
    await refuse(h, p)

    expect(h.tickEnd(p)).toBe('ended')

    expectPosts(h, [])
    expect(noticeAndEndLines(h, p)).toEqual([conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TICK)])
  })

  test('a silent end after the alert alone posts no recovery and answers `ended-after-notice`', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await h.advance(at + thresholdMs + 1 - h.clock.now())

    expect(h.tmuxUnresponsive.end(p, TMUX_UNRESPONSIVE_END_TMUX_VERB, undefined, { silent: true })).toBe('ended-after-notice')

    expectPosts(h, [alert(p, thresholdMs)])
    expect(noticeAndEndLines(h, p)).toEqual([
      conditionAlertLine(p, thresholdMs + 1, thresholdMs),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TMUX_VERB),
      conditionSilentEndLine(p),
    ])
  })

  test('a silent end (a CONFLICT answer ends it) posts no recovery after the onset; the condition still ends once', async () => {
    const { h, p } = build(TICK_MODE)
    await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)

    expect(h.tmuxUnresponsive.end(p, TMUX_UNRESPONSIVE_END_TMUX_VERB, undefined, { silent: true })).toBe('ended-after-notice')

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(conditionEndedLines(h, p)).toHaveLength(1)
    expect(h.conditionEnds).toEqual([{ key: p, reading: undefined, result: 'stopped' }])
    expectPosts(h, [onset(p)])
    expect(noticeAndEndLines(h, p)).toEqual([
      conditionOnsetLine(p, 'a health tick', tickMs(h)),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TMUX_VERB),
      conditionSilentEndLine(p),
    ])
  })

  test('a new episode posts its onset, alert and recovery again', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const episode = [onset(p), alert(p, thresholdMs), recovery(p)]
    const episodeLines = [
      conditionOnsetLine(p, 'a health tick', tickMs(h)),
      conditionAlertLine(p, thresholdMs + 1, thresholdMs),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TICK),
      conditionRecoveryLine(p),
    ]

    for (let n = 1; n <= 2; n++) {
      const at = await refuse(h, p)
      await h.advance(tickMs(h))
      tick(h)
      await h.advance(at + thresholdMs + 1 - h.clock.now())
      tick(h, [p])
      expectPosts(h, Array.from({ length: n }, () => episode).flat())
      expect(noticeAndEndLines(h, p)).toEqual(Array.from({ length: n }, () => episodeLines).flat())
    }
    expect(conditionStartedLines(h, p)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// The alert before the onset (SRJ-308, SRJ-309)
// ---------------------------------------------------------------------------

/** The line when the onset is held back because the episode's alert already posted: once per episode. */
function onsetHeldLine(key: string): string {
  return `${conditionLinePrefix(key)}onset not posted — its alert already posted`
}

/** The line when a stop of the persona's retry timer cancels its pending alert check. */
function alertCancelledLine(key: string, stopReason: string): string {
  return `${conditionLinePrefix(key)}alert check cancelled — its retry timer stopped: ${stopReason}`
}

/** The line when a later refusal arms a cancelled alert check again. */
function alertRearmedLine(key: string): string {
  return `${conditionLinePrefix(key)}alert check armed again — a new refusal armed its retry timer again`
}

describe('tmux-unresponsive: the alert before the onset (SRJ-308, SRJ-309)', () => {
  test('AC 80’s settings with the health check off: the alert, then the recovery, and no onset; the retries past the floor log the held onset once', async () => {
    const { h, p, b } = build({ action: 'scripted', adSettings: { tmux: AC_80_TMUX } })
    expect(h.config.health_check_interval).toBe(0)
    const thresholdMs = adAlertThresholdMsInEffect()
    expect(thresholdMs).toBe(adAlertThresholdMs(h.settings()))
    const at = await refuse(h, p)

    await h.advance(at + thresholdMs + 1 - h.clock.now())
    // Every retry so far fell short of the floor, so none could post the onset.
    const early = h.attempts.filter((attempt) => attempt.key === p)
    expect(early.length).toBeGreaterThan(0)
    for (const attempt of early) expect(attempt.at - at).toBeLessThan(FLOOR_MS)
    expectPosts(h, [alert(p, thresholdMs)])

    const firedAt = await nextRetry(h, p)
    expect(firedAt - at).toBeGreaterThanOrEqual(FLOOR_MS)
    await nextRetry(h, p)
    expectPosts(h, [alert(p, thresholdMs)])

    await wrapped(p, 'send-keys', RESOLVES)

    expectPosts(h, [alert(p, thresholdMs), recovery(p)])
    expect(noticeAndEndLines(h, p)).toEqual([
      conditionAlertLine(p, thresholdMs + 1, thresholdMs),
      onsetHeldLine(p),
      conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TMUX_VERB),
      conditionRecoveryLine(p),
    ])
    expect(h.conditionEnds).toEqual([{ key: p, reading: undefined, result: 'stopped' }])
    expectNeverStarted(h, b)
  })

  test('with the health check on, the ticks after the alert post no onset and log the held onset once per episode', async () => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const posts: RecoveryNotice[] = []
    const lines: string[] = []

    for (let n = 1; n <= 2; n++) {
      const at = await refuse(h, p)
      await h.advance(at + thresholdMs + 1 - h.clock.now())
      for (let t = 0; t < 3; t++) {
        await h.advance(tickMs(h))
        tick(h)
      }
      expect(h.tmuxUnresponsive.holds(p)).toBe(true)
      posts.push(alert(p, thresholdMs))
      lines.push(conditionAlertLine(p, thresholdMs + 1, thresholdMs), onsetHeldLine(p))
      expectPosts(h, posts)
      expect(noticeAndEndLines(h, p)).toEqual(lines)

      expect(h.tickEnd(p)).toBe('ended-after-notice')
      posts.push(recovery(p))
      lines.push(conditionEndedLine(p, TMUX_UNRESPONSIVE_END_TICK), conditionRecoveryLine(p))
    }
    expectPosts(h, posts)
    expect(noticeAndEndLines(h, p)).toEqual(lines)
  })
})

// ---------------------------------------------------------------------------
// The alert and the retry timer's stops (SRJ-309)
// ---------------------------------------------------------------------------

/**
 * Run persona `key`'s next retry through the server's full-mode action, which
 * stops the timer before any agent-director call (after `prepare` sets up the
 * stop), then go back to the scripted action for every persona.
 */
async function stopAtNextRetry(h: RecoveryHarness, key: string, prepare: () => void): Promise<void> {
  prepare()
  // Only this persona's retry runs the full-mode action; any other persona's stays scripted.
  h.setAction((k, attempt) => (k === key ? h.fullModeAction : h.scriptedAction)(k, attempt))
  const calls = h.stub.callCount()
  await retryNow(h, key)
  expect(h.controller.isArmed(key)).toBe(false)
  expect(h.stub.callCount()).toBe(calls)
  h.setAction(h.scriptedAction)
}

/** A stop of persona `key`'s retry timer the harness drives, its reason, and whether that reason is terminal. */
interface TimerStop {
  readonly reason: string
  readonly terminal: boolean
  drive(h: RecoveryHarness, key: string): Promise<void>
}

const STOP_AT_CAP: TimerStop = {
  reason: UNAVAILABLE_RETRY_STOP_CAPPED,
  terminal: false,
  // Counted launch failures up to the restart cap: the next retry stops at it.
  drive: (h, key) =>
    stopAtNextRetry(h, key, () => {
      while (!isAtCap(key, RESTART_FAILURE_CAP)) recordFailure(key)
    }),
}

const STOP_NOT_UP: TimerStop = {
  reason: UNAVAILABLE_RETRY_STOP_NOT_UP,
  terminal: false,
  drive: (h, key) => stopAtNextRetry(h, key, () => h.setUp(key, false)),
}

const STOP_NOT_APPLIED: TimerStop = {
  reason: UNAVAILABLE_RETRY_STOP_NOT_APPLIED,
  terminal: true,
  drive: (h, key) => stopAtNextRetry(h, key, () => h.remove(key)),
}

const STOP_TORN_DOWN: TimerStop = {
  reason: UNAVAILABLE_RETRY_STOP_TORN_DOWN,
  terminal: true,
  drive: async (h, key) => h.teardown(key),
}

const TIMER_STOPS: readonly [string, TimerStop][] = [
  ['the restart cap', STOP_AT_CAP],
  ['the persona not up', STOP_NOT_UP],
  ['the persona not in the applied configuration', STOP_NOT_APPLIED],
  ['a teardown', STOP_TORN_DOWN],
]

// The health check is on in these cases and no tick runs, so no onset posts:
// the alert is the only notice the stops can touch.
describe('tmux-unresponsive: the alert and the retry timer’s stops (SRJ-309)', () => {
  test.each(TIMER_STOPS)('each stop’s terminal class is the one src declares: %s', (_what, stop) => {
    expect(UNAVAILABLE_RETRY_TERMINAL_STOPS.has(stop.reason)).toBe(stop.terminal)
  })

  test.each(TIMER_STOPS)('a stop of P’s retry timer by %s while the condition holds cancels its pending alert check with one line: nothing posts at the threshold; B’s alert still posts', async (_what, stop) => {
    const { h, p, b } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    expect(await refuse(h, b)).toBe(at)

    await stop.drive(h, p)

    expect(h.clock.now() - at).toBeLessThan(thresholdMs)
    expect(h.controller.isArmed(p)).toBe(false)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expect(noticeAndEndLines(h, p)).toEqual([alertCancelledLine(p, stop.reason)])

    await h.advance(at + 2 * thresholdMs - h.clock.now())

    expectPosts(h, [alert(b, thresholdMs)])
    expect(noticeAndEndLines(h, p)).toEqual([alertCancelledLine(p, stop.reason)])
    expect(noticeAndEndLines(h, b)).toEqual([conditionAlertLine(b, thresholdMs + 1, thresholdMs)])
    expect(h.tmuxUnresponsive.holds(b)).toBe(true)
  })

  test.each(TIMER_STOPS)('an alert already posted stays after a stop by %s: no cancel line and no retraction post', async (_what, stop) => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await h.advance(at + thresholdMs + 1 - h.clock.now())
    expectPosts(h, [alert(p, thresholdMs)])

    await stop.drive(h, p)
    await h.advance(2 * thresholdMs)

    expect(h.controller.isArmed(p)).toBe(false)
    expectPosts(h, [alert(p, thresholdMs)])
    expect(noticeAndEndLines(h, p)).toEqual([conditionAlertLine(p, thresholdMs + 1, thresholdMs)])
  })

  test.each<[string, string, TimerStop, boolean]>([
    ['the restart cap', 'before the threshold', STOP_AT_CAP, false],
    ['the restart cap', 'after the threshold', STOP_AT_CAP, true],
    ['the persona not up', 'before the threshold', STOP_NOT_UP, false],
  ])('after a stop by %s, a later refusal %s arms the alert check again from the first refusal, with one line; it posts once the condition has lasted past the threshold', async (_what, _when, stop, pastThreshold) => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await stop.drive(h, p)

    await h.advance(at + (pastThreshold ? thresholdMs + halfFirstWaitMs() : thresholdMs / 2) - h.clock.now())
    expectPosts(h, [])
    const laterAt = await refuse(h, p)

    expect(h.controller.isArmed(p)).toBe(true)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    expect(noticeAndEndLines(h, p)).toEqual([alertCancelledLine(p, stop.reason), alertRearmedLine(p)])

    let lastedMs: number
    if (pastThreshold) {
      // Already past it: the check fires at the clock's next step (a 0 ms wait is 1 ms on the fake clock).
      await h.advance(1)
      lastedMs = laterAt + 1 - at
    } else {
      await h.advance(at + thresholdMs - h.clock.now())
      expectPosts(h, [])
      await h.advance(1)
      lastedMs = thresholdMs + 1
    }
    expectPosts(h, [alert(p, thresholdMs)])
    const lines = [alertCancelledLine(p, stop.reason), alertRearmedLine(p), conditionAlertLine(p, lastedMs, thresholdMs)]
    expect(noticeAndEndLines(h, p)).toEqual(lines)

    // A further refusal in the episode arms nothing more.
    await h.advance(halfFirstWaitMs())
    await refuse(h, p)
    await h.advance(thresholdMs)
    expectPosts(h, [alert(p, thresholdMs)])
    expect(noticeAndEndLines(h, p)).toEqual(lines)
  })

  test.each<[string, TimerStop]>([
    ['a teardown (teardown(key))', STOP_TORN_DOWN],
    ['the persona not in the applied configuration', STOP_NOT_APPLIED],
  ])('after a terminal stop by %s, a later refusal arms the retry timer but never the alert check', async (_what, stop) => {
    const { h, p } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    const at = await refuse(h, p)
    await stop.drive(h, p)

    await h.advance(halfFirstWaitMs())
    await refuse(h, p)

    expect(h.controller.isArmed(p)).toBe(true)
    expect(h.tmuxUnresponsive.firstRefusalAt(p)).toBe(at)
    await h.advance(at + 2 * thresholdMs - h.clock.now())

    expectPosts(h, [])
    expect(noticeAndEndLines(h, p)).toEqual([alertCancelledLine(p, stop.reason)])
  })
})

describe('tmux-unresponsive: teardown and shutdown post nothing more', () => {
  test.each<[string, (h: RecoveryHarness, key: string) => void]>([
    ['the teardown’s submit (retry timer stopped, alert check cancelled, the condition kept), then its turn’s forget', (h, key) => {
      h.teardown(key)
      expect(h.tmuxUnresponsive.holds(key)).toBe(true)
      expect(h.clock.pendingCount()).toBe(0)
      h.episodes.forget(key)
    }],
    ['the teardown’s forget alone', (h, key) => h.episodes.forget(key)],
  ])('%s: no alert, no recovery, no condition-end call', async (_what, tearDown) => {
    const { h, p, b } = build(TICK_MODE)
    const thresholdMs = adAlertThresholdMsInEffect()
    await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)
    expectPosts(h, [onset(p)])

    tearDown(h, p)

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    await h.advance(2 * thresholdMs)
    tick(h, [p])
    expectPosts(h, [onset(p)])
    expect(h.conditionEnds).toEqual([])
    expectNeverStarted(h, b)
  })

  test('shutdown drops P’s condition with no recovery and nothing pending; B’s launch still in flight, refused after it, opens no condition and arms no alert check', async () => {
    const { h, p, b } = build(TICK_MODE)
    await refuse(h, p)
    await h.advance(tickMs(h))
    tick(h)
    const hold = holdSpawns(h.stub.client)
    const launch = h.launch(b)
    await hold.entered(personaInstanceId(b))

    h.shutdown()

    expect(h.tmuxUnresponsive.holds(p)).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
    hold.fail(personaInstanceId(b), errTmuxUnresponsive('spawn'))
    await launch
    expectNeverStarted(h, b)
    expect(h.tmuxUnresponsive.start(b, 'spawn', errTmuxUnresponsive('spawn'))).toBe('closed')
    expect(h.clock.pendingCount()).toBe(0)

    await h.advance(2 * adAlertThresholdMsInEffect())
    tick(h, [p, b])
    expectPosts(h, [onset(p)])
    expect(h.conditionEnds).toEqual([])
  })
})
