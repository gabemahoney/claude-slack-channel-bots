/**
 * unavailable-retry.test.ts — The per-persona UNAVAILABLE retry timer
 * (b.jg5 SRJ-301 code line, SRJ-302, SRJ-304).
 *
 * The schedule, the never-give-up rule, arming while armed and isolation run
 * on the bare controller over `createFakeClock` with a scripted action;
 * settings independence runs on `makeRecoveryHarness` and a comment-stripped
 * source audit. What arms the timer (b.jg5 SRJ-301) runs on the harness with
 * the controller as the outage state's trigger sink: real launches through
 * `spawnForPersona` over the stub, the arming predicate on its own, and the
 * reads made outside every attempt. The shared findMissing sweep runs there
 * too, its one call held open by the test so each caller joins it before it
 * fails.
 * The attempt frames run on the bare context with the controller as the sink.
 * Only the pin case holds the SRD's numbers; every other case derives its
 * waits from the exported base and ceiling through `doublingBackoffDelay`. No
 * retry timer is real; the only real-time waits are the spawn path's 1 ms
 * polls, bounded by the harness, and one 0 ms `setTimeout` a frames case sets
 * inside an attempt and awaits.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CSCB_UNKNOWN_ERROR_NAME } from '../src/ad-error-class.ts'
import { ErrCwdNotFound } from '../src/agent-director-errors.ts'
import { _resetBackoffState, doublingBackoffDelay, getFailureCount, isAtCap, recordFailure } from '../src/backoff.ts'
import type { Persona } from '../src/config.ts'
import { runJsonlPersistenceSafeguard } from '../src/jsonl-persistence-check.ts'
import { _resetPollerState, stopPermissionPoller, type PollerDeps } from '../src/permission-poller.ts'
import { personaInstanceId } from '../src/persona-identity.ts'
import { _resetRestartState, isRestartPendingOrActive, RESTART_FAILURE_CAP, scheduleRestart } from '../src/restart.ts'
import { _buildIsSessionAliveAdapter } from '../src/server.ts'
import {
  _resetConfigDirFs,
  _setConfigDirFs,
  killPersonaInstance,
  reconcileOrphans,
  sweepDeadTmuxChannel,
  type SpawnPersonaResult,
} from '../src/session-manager.ts'
import {
  createUnavailableRetryController,
  isInsideAttempt,
  reportAttemptError,
  runInAttempt,
  type AttemptErrorRecord,
  type AttemptView,
  UNAVAILABLE_RETRY_BASE_S,
  UNAVAILABLE_RETRY_CAUSE_KILL_FAILED,
  UNAVAILABLE_RETRY_CAUSE_READ_ERROR,
  UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE,
  UNAVAILABLE_RETRY_CEILING_S,
  unavailableRetryCauseFor,
  type UnavailableRetryAction,
  type UnavailableRetryCause,
  type UnavailableRetryController,
  type UnavailableRetryOutcome,
} from '../src/unavailable-retry.ts'
import {
  cannedErr,
  cannedGetResult,
  cannedListRow,
  cannedOk,
  cannedStatusResult,
  errCallTimeout,
  errConfigMalformed,
  errGeneric,
  errInstanceIdCollision,
  errJsonlNeverWritten,
  errSpawnNotFound,
  errSpawnNotInteractive,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  errUnknownErrorName,
  errUnusableName,
  holdSpawns,
  type PersonaGetResultOverrides,
} from './test-helpers/agent-director-stub.ts'
import {
  assertNoLeak,
  BOT_TOKEN_PREFIX,
  fakeToken,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { startManualPoller } from './test-helpers/permission-relay-harness.ts'
import {
  makeRecoveryHarness,
  type RecoveryAttempt,
  type RecoveryHarness,
  type RecoveryStubScript,
} from './test-helpers/recovery-harness.ts'
import { stripComments } from './test-helpers/source-audit.ts'

const KEY = 'alpha'
const OTHER = 'beta'
const UNAVAILABLE = { kind: 'unavailable' } as const

/** The wait after `refusals` refused retries, in ms, from the exported base and ceiling. */
function waitMs(refusals: number): number {
  return doublingBackoffDelay(UNAVAILABLE_RETRY_BASE_S, refusals, UNAVAILABLE_RETRY_CEILING_S) * 1000
}

/** Refusals until the wait reaches the ceiling. */
function refusalsToCeiling(): number {
  let n = 0
  while (waitMs(n) < UNAVAILABLE_RETRY_CEILING_S * 1000) n++
  return n
}

/** A bare controller on its own fake clock, with its lines and the retries its action saw. */
interface Rig {
  readonly clock: FakeClock
  readonly controller: UnavailableRetryController
  readonly lines: string[]
  readonly attempts: RecoveryAttempt[]
}

let rigs: Rig[] = []
let harness: RecoveryHarness | undefined

/** Build a rig; its action refuses every retry unless `action` is given. */
function makeRig(action: UnavailableRetryAction = () => ({ kind: 'again', cause: UNAVAILABLE }), clock = createFakeClock()): Rig {
  const lines: string[] = []
  const attempts: RecoveryAttempt[] = []
  const controller = createUnavailableRetryController({
    clock,
    log: (line) => { lines.push(line) },
    action: (key, attempt) => {
      attempts.push({ key, retry: attempt.retry, causes: attempt.causes, at: clock.now() })
      return action(key, attempt)
    },
  })
  const rig = { clock, controller, lines, attempts }
  rigs.push(rig)
  return rig
}

/** An action whose answers the test gives, one retry at a time. */
function heldAction(): { action: UnavailableRetryAction; answer(outcome: UnavailableRetryOutcome): void } {
  const waiting: Array<(outcome: UnavailableRetryOutcome) => void> = []
  return {
    action: () => new Promise<UnavailableRetryOutcome>((resolve) => { waiting.push(resolve) }),
    answer: (outcome) => {
      const next = waiting.shift()
      if (next === undefined) throw new Error('heldAction: no retry is waiting for an answer')
      next(outcome)
    },
  }
}

const delays = (clock: FakeClock): number[] => clock.pending().map((timer) => timer.delayMs)

/** A fake clock whose `setTimeout` throws `err` once, at its first call after `prime()`. */
function throwingClock(err: Error): { clock: FakeClock; prime(): void } {
  const base = createFakeClock()
  let primed = false
  const setTimeout: FakeClock['setTimeout'] = (callback, delayMs) => {
    if (primed) {
      primed = false
      throw err
    }
    return base.setTimeout(callback, delayMs)
  }
  return { clock: { ...base, setTimeout }, prime: () => { primed = true } }
}

beforeEach(() => {
  rigs = []
  harness = undefined
  _resetBackoffState()
  _resetRestartState()
})

afterEach(() => {
  const clocks = rigs.map((rig) => rig.clock)
  try {
    for (const rig of rigs) rig.controller.stopAll('the test is over')
    if (harness !== undefined) {
      clocks.push(harness.clock)
      harness.cleanup()
    }
  } finally {
    _resetBackoffState()
    _resetRestartState()
  }
  for (const clock of clocks) expect(clock.pendingCount()).toBe(0)
  assertNoLeak(rigs.map((rig) => rig.lines), 'retry lines')
})

describe('unavailable retry: the schedule', () => {
  test('arming asks for the first wait and runs nothing yet', () => {
    const { clock, controller, attempts } = makeRig()
    controller.arm(KEY, UNAVAILABLE)

    expect(delays(clock)).toEqual([waitMs(0)])
    expect(controller.view(KEY)).toEqual({ phase: 'waiting', dueAt: waitMs(0), waitMs: waitMs(0), refusals: 0, causes: ['unavailable'] })
    expect(attempts).toEqual([])
  })

  test('each refusal re-arms at the doubled wait up to the ceiling; no retry fires 1 ms early and each fires exactly at its due time', async () => {
    const { clock, controller, attempts } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    const steps = refusalsToCeiling() + 2

    for (let n = 0; n < steps; n++) {
      const dueAt = clock.now() + waitMs(n)
      expect(delays(clock)).toEqual([waitMs(n)])
      await clock.advance(waitMs(n) - 1)
      expect(attempts).toHaveLength(n)
      await clock.advance(1)
      expect(attempts).toHaveLength(n + 1)
      expect(attempts[n]).toEqual({ key: KEY, retry: n + 1, causes: ['unavailable'], at: dueAt })
    }
    expect(controller.view(KEY)).toMatchObject({ phase: 'waiting', waitMs: UNAVAILABLE_RETRY_CEILING_S * 1000, refusals: steps })
  })

  test('the pin: a 30 s base, a 300 s ceiling, and retries at 30, 90, 210, 450 and 750 s after the arm, then every 300 s', async () => {
    expect(UNAVAILABLE_RETRY_BASE_S).toBe(30)
    expect(UNAVAILABLE_RETRY_CEILING_S).toBe(300)
    const { clock, controller, attempts } = makeRig()
    const armedAt = clock.now()
    controller.arm(KEY, UNAVAILABLE)

    for (let i = 0; i < 7; i++) await clock.runNext()

    expect(attempts.map((a) => (a.at - armedAt) / 1000)).toEqual([30, 90, 210, 450, 750, 1050, 1350])
  })

  test('a stop leaves nothing pending and runs nothing more, and a later arm starts at the first wait again', async () => {
    const { clock, controller, attempts } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    await clock.runNext()
    await clock.runNext()
    expect(controller.view(KEY)?.refusals).toBe(2)

    controller.stop(KEY, 'nothing left to recover')
    expect(clock.pendingCount()).toBe(0)
    expect(controller.isArmed(KEY)).toBe(false)
    expect(controller.view(KEY)).toBeUndefined()
    await clock.advance(waitMs(refusalsToCeiling()) * 2)
    expect(attempts).toHaveLength(2)

    controller.arm(KEY, UNAVAILABLE)
    expect(delays(clock)).toEqual([waitMs(0)])
    expect(controller.view(KEY)?.refusals).toBe(0)
  })

  test('a stop answer ends the timer and leaves nothing pending', async () => {
    const { clock, controller, attempts } = makeRig(() => ({ kind: 'stop', reason: 'the persona recovered' }))
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))
    await controller.whenRunSettled(KEY)

    expect(attempts).toHaveLength(1)
    expect(controller.isArmed(KEY)).toBe(false)
    expect(clock.pendingCount()).toBe(0)
  })

  test.each<[string, (err: Error) => UnavailableRetryAction]>([
    ['throws', (err) => () => { throw err }],
    ['rejects', (err) => async () => { throw err }],
  ])('an action that %s counts as a refusal: re-armed at the next wait, its error logged only as its redacted description', async (_how, make) => {
    const err = Object.assign(errGeneric('spawn', 'ErrTmuxNotAvailable', `spawn refused (${sentinelInMessage('retry')})`), { detail: LEAK_SENTINEL })
    const { clock, controller, lines } = makeRig(make(err))
    controller.arm(KEY, { kind: 'unavailable', error: err })
    await clock.advance(waitMs(0))
    await controller.whenRunSettled(KEY)

    expect(delays(clock)).toEqual([waitMs(1)])
    expect(controller.view(KEY)?.refusals).toBe(1)
    const described = lines.filter((line) => line.includes('errName=ErrTmuxNotAvailable'))
    expect(described).toHaveLength(2)
    for (const line of described) {
      expect(line).toContain('AgentDirectorError errName=ErrTmuxNotAvailable message="')
      expect(line).toContain(`spawn refused (${REDACTED_SENTINEL_TAIL})"`)
    }
    assertNoLeak(lines)
  })

  test.each<[string, unknown]>([
    ['no answer', undefined],
    ['an unknown answer', { kind: 'later' }],
  ])('an action that gives %s counts as a refusal and re-arms at the next wait', async (_what, answer) => {
    const { clock, controller } = makeRig(() => answer as UnavailableRetryOutcome)
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))

    expect(delays(clock)).toEqual([waitMs(1)])
    expect(controller.view(KEY)?.refusals).toBe(1)
  })

  test.each<[string, UnavailableRetryCause]>([
    ['a token-shaped cause kind', { kind: fakeToken(BOT_TOKEN_PREFIX, 'kind') }],
    ['a missing cause (an untyped caller)', undefined as unknown as UnavailableRetryCause],
  ])('%s is recorded and logged as unnamed, so a token in it never reaches a line', (_what, cause) => {
    const { controller, lines } = makeRig()
    controller.arm(KEY, cause)

    expect(controller.view(KEY)?.causes).toEqual(['unnamed'])
    assertNoLeak(lines)
  })

  test.each<[string, string, (rig: Rig, prime: () => void) => Promise<void>]>([
    ['the first arm', 'arm failed', async ({ controller }, prime) => {
      prime()
      expect(() => controller.arm(KEY, UNAVAILABLE)).not.toThrow()
    }],
    ['the re-arm after a refused retry', 'retry run failed', async ({ clock, controller }, prime) => {
      controller.arm(KEY, UNAVAILABLE)
      prime()
      await clock.advance(waitMs(0))
      await controller.whenRunSettled(KEY)
    }],
  ])('a clock that throws at %s forgets the persona with one "%s" line, its error redacted, and the next arm starts at the first wait', async (_when, failed, drive) => {
    const { clock, prime } = throwingClock(new Error(`the clock refused (${sentinelInMessage('clock')})`))
    const rig = makeRig(undefined, clock)
    const { controller, lines } = rig
    await drive(rig, prime)

    const failures = lines.filter((line) => line.includes(failed))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toStartWith(`[slack] unavailable-retry: persona=${KEY} ${failed}: Error message="the clock refused (${REDACTED_SENTINEL_TAIL})"`)
    if (failed === 'arm failed') {
      expect(failures[0]).toEndWith(' — not armed')
      expect(lines).toEqual(failures)
    }
    expect(lines.filter((line) => line.includes('re-armed'))).toEqual([])
    expect(controller.isArmed(KEY)).toBe(false)
    expect(controller.view(KEY)).toBeUndefined()
    expect(clock.pendingCount()).toBe(0)
    assertNoLeak(lines)

    controller.arm(KEY, UNAVAILABLE)
    expect(delays(clock)).toEqual([waitMs(0)])
    expect(controller.view(KEY)).toMatchObject({ phase: 'waiting', refusals: 0 })
  })
})

describe('unavailable retry: never gives up and never uses the restart counter', () => {
  test('after refusals well past RESTART_FAILURE_CAP the timer is still armed at the ceiling and no failure is counted', async () => {
    const { clock, controller, attempts } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    const refusals = RESTART_FAILURE_CAP * 3 + refusalsToCeiling()

    for (let i = 0; i < refusals; i++) await clock.runNext()

    expect(attempts).toHaveLength(refusals)
    expect(controller.view(KEY)).toMatchObject({ phase: 'waiting', waitMs: UNAVAILABLE_RETRY_CEILING_S * 1000, refusals })
    expect(getFailureCount(KEY)).toBe(0)
    expect(isAtCap(KEY, RESTART_FAILURE_CAP)).toBe(false)
  })

  test('a failure count recorded beforehand changes no wait, and the retries leave it as it was', async () => {
    for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(KEY)
    const { clock, controller } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    expect(delays(clock)).toEqual([waitMs(0)])

    await clock.runNext()
    expect(delays(clock)).toEqual([waitMs(1)])
    expect(getFailureCount(KEY)).toBe(RESTART_FAILURE_CAP)
  })
})

describe('unavailable retry: arming while armed', () => {
  test('arming while waiting keeps the due time and the wait count, and records the new cause', async () => {
    const { clock, controller } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    await clock.runNext()
    const before = controller.view(KEY)
    await clock.advance(waitMs(1) / 2)

    controller.arm(KEY, { kind: 'status-error' })

    expect(clock.pending().map((t) => t.dueAt)).toEqual([before!.dueAt!])
    expect(controller.view(KEY)).toEqual({ ...before!, causes: ['unavailable', 'status-error'] })
  })

  test('arming while a run is in flight changes nothing pending; the re-arm is measured from the run’s end and the next retry sees the cause', async () => {
    const held = heldAction()
    const { clock, controller, attempts } = makeRig(held.action)
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))
    expect(controller.view(KEY)?.phase).toBe('running')

    controller.arm(KEY, { kind: 'status-error' })
    expect(clock.pendingCount()).toBe(0)
    expect(controller.view(KEY)).toEqual({ phase: 'running', refusals: 0, causes: ['unavailable', 'status-error'] })

    await clock.advance(waitMs(0) / 2)
    const runEnd = clock.now()
    held.answer({ kind: 'again' })
    await controller.whenRunSettled(KEY)

    expect(clock.pending().map((t) => t.dueAt)).toEqual([runEnd + waitMs(1)])
    await clock.advance(waitMs(1))
    expect(attempts[1]).toEqual({ key: KEY, retry: 2, causes: ['unavailable', 'status-error'], at: runEnd + waitMs(1) })
    held.answer({ kind: 'stop', reason: 'the test is over' })
    await controller.whenRunSettled(KEY)
  })

  test('a run in flight when stopped has its answer dropped, and the next arm’s retry waits for that run to settle', async () => {
    const held = heldAction()
    const { clock, controller, attempts } = makeRig(held.action)
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))
    controller.stop(KEY, 'the persona left the configuration')
    controller.arm(KEY, UNAVAILABLE)
    await clock.advance(waitMs(0))
    expect(attempts).toHaveLength(1)

    held.answer({ kind: 'stop', reason: 'the old run ended' })
    await clock.flush()
    expect(attempts).toHaveLength(2)
    expect(controller.view(KEY)).toEqual({ phase: 'running', refusals: 0, causes: ['unavailable'] })

    held.answer({ kind: 'again' })
    await controller.whenRunSettled(KEY)
    expect(delays(clock)).toEqual([waitMs(1)])
  })
})

describe('unavailable retry: isolation', () => {
  test('two personas keep separate schedules', async () => {
    const { clock, controller } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    await clock.runNext()
    const bArmedAt = clock.now()
    controller.arm(OTHER, UNAVAILABLE)

    expect(controller.view(KEY)).toMatchObject({ refusals: 1, dueAt: bArmedAt + waitMs(1) })
    expect(controller.view(OTHER)).toMatchObject({ refusals: 0, dueAt: bArmedAt + waitMs(0) })
    expect(controller.armedKeys()).toEqual([KEY, OTHER])
  })

  test('stopping one persona leaves the other armed with its due time', async () => {
    const { clock, controller, attempts } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    controller.arm(OTHER, { kind: 'status-error' })
    const otherDue = controller.view(OTHER)!.dueAt!

    controller.stop(KEY, 'nothing left to recover')

    expect(controller.view(OTHER)).toMatchObject({ phase: 'waiting', dueAt: otherDue })
    await clock.advance(waitMs(0))
    expect(attempts.map((a) => a.key)).toEqual([OTHER])
  })

  test('stop-all clears exactly the retry timers', () => {
    const { clock, controller } = makeRig()
    controller.arm(KEY, UNAVAILABLE)
    controller.arm(OTHER, UNAVAILABLE)
    const unrelated = clock.setTimeout(() => {}, waitMs(0))

    controller.stopAll('the server is shutting down')

    expect(clock.pending().map((t) => t.id)).toEqual([unrelated.id])
    expect(controller.armedKeys()).toEqual([])
    clock.clearTimeout(unrelated)
  })

  test('two controllers on two clocks share nothing', async () => {
    const first = makeRig()
    const second = makeRig()
    first.controller.arm(KEY, UNAVAILABLE)
    second.controller.arm(KEY, UNAVAILABLE)

    await first.clock.runNext()
    first.controller.stop(KEY, 'nothing left to recover')

    expect(second.attempts).toEqual([])
    expect(second.controller.view(KEY)).toMatchObject({ phase: 'waiting', dueAt: waitMs(0), refusals: 0 })
    expect(delays(second.clock)).toEqual([waitMs(0)])
  })
})

describe('unavailable retry: settings independence (SRJ-304)', () => {
  test('on the recovery harness with session_restart_delay and health_check_interval 0, an armed persona is retried on the schedule and scheduleRestart arms nothing', async () => {
    harness = makeRecoveryHarness()
    const h = harness
    expect([h.config.session_restart_delay, h.config.health_check_interval]).toEqual([0, 0])
    const [key, other] = h.keys as [string, string]
    const persona = h.config.personas[0]!

    scheduleRestart(key, persona.working_directory)
    expect(isRestartPendingOrActive(key)).toBe(false)

    const armedAt = h.clock.now()
    h.controller.arm(key, UNAVAILABLE)
    const retries = 3
    const expected = Array.from({ length: retries }, (_, i) => Array.from({ length: i + 1 }, (__, j) => waitMs(j)).reduce((a, b) => a + b))
    await h.advance(expected[retries - 1]!)

    expect(h.attempts.map((a) => [a.key, a.at - armedAt])).toEqual(expected.map((at) => [key, at]))
    expect(h.controller.view(key)).toMatchObject({ phase: 'waiting', refusals: retries })
    expect(h.controller.isArmed(other)).toBe(false)
    expect(isRestartPendingOrActive(key)).toBe(false)
    expect(getFailureCount(key)).toBe(0)
    expect(h.stub.callCount()).toBe(0)
    assertNoLeak(h.captured())
  })

  const retrySource = stripComments(readFileSync(join(import.meta.dir, '..', 'src', 'unavailable-retry.ts'), 'utf-8'))

  test.each(['session_restart_delay', 'getRestartDelay', 'health_check_interval'])('src/unavailable-retry.ts names no %s', (name) => {
    expect(retrySource).not.toContain(name)
  })

  test('src/unavailable-retry.ts takes only doublingBackoffDelay from the backoff module and nothing from the restart module', () => {
    const backoffImports = [...retrySource.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/backoff\.ts'/g)].map((m) => m[1]!.split(',').map((s) => s.trim()).filter(Boolean))
    expect(backoffImports).toEqual([['doublingBackoffDelay']])
    expect(retrySource).not.toMatch(/from\s*'\.\/restart\.ts'/)
  })
})

// ---------------------------------------------------------------------------
// What arms the timer (b.jg5 SRJ-301)
// ---------------------------------------------------------------------------

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

/** A site of the launch path where an agent-director call made through the wrappers meets `err`. */
interface LaunchSite {
  readonly name: string
  readonly verb: string
  script(h: RecoveryHarness, persona: Persona, err: Error): RecoveryStubScript
  /** The launch's action when this site's call fails. */
  readonly action: SpawnPersonaResult['action']
}

const LAUNCH_SITES: readonly LaunchSite[] = [
  { name: 'the optimistic spawn', verb: 'spawn', action: 'failed', script: (_h, _p, err) => ({ spawnError: err }) },
  { name: 'the collision get', verb: 'get', action: 'failed', script: (_h, _p, err) => ({ spawnQueue: [cannedErr(errInstanceIdCollision())], getError: err }) },
  { name: 'the readiness read after a spawn', verb: 'status', action: 'spawned', script: (_h, _p, err) => ({ statusQueue: [cannedErr(err)] }) },
  {
    name: 'the dialog pane read after a spawn',
    verb: 'read-pane',
    action: 'spawned',
    script: (_h, _p, err) => ({ statusQueue: [cannedOk(cannedStatusResult({ state: 'pending' }))], readPaneQueue: [cannedErr(err)] }),
  },
  { name: 'the reconnect of a waiting row', verb: 'send-keys', action: 'failed', script: (h, p, err) => ({ ...collided(h, p, { state: 'waiting' }), sendKeysError: err }) },
  { name: 'the sweep before a working-row wait', verb: 'find-missing', action: 'reconnected', script: (h, p, err) => ({ ...collided(h, p, { state: 'working' }), findMissingError: err }) },
  { name: 'the working-row read', verb: 'status', action: 'failed', script: (h, p, err) => ({ ...collided(h, p, { state: 'working' }), statusError: err }) },
  { name: 'the kill of a row in another directory', verb: 'kill', action: 'spawned', script: (h, p, err) => ({ ...collided(h, p, { cwd: h.home }), killError: err }) },
  { name: 'the delete of a row in another directory', verb: 'delete', action: 'failed', script: (h, p, err) => ({ ...collided(h, p, { cwd: h.home }), deleteError: err }) },
  { name: 'the resume of an ended row', verb: 'resume', action: 'failed', script: (h, p, err) => ({ ...collided(h, p, { state: 'ended' }), resumeError: err }) },
]

/** The sites whose verb is a read (`status`, `get`). */
const READ_SITES = LAUNCH_SITES.filter((site) => site.verb === 'status' || site.verb === 'get')

/** E4's UNAVAILABLE values, each with the cause kind it arms. */
const UNAVAILABLE_VALUES: ReadonlyArray<readonly [string, (verb: string) => Error, string]> = [
  ['ErrTmuxUnresponsive', (verb) => errTmuxUnresponsive(verb), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
  ['ErrTmuxKillFailed', () => errTmuxKillFailed(), UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
  ['ErrCallTimeout', (verb) => errCallTimeout(verb), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
  ['an unknown error name from a later binary', () => errUnknownErrorName(), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
  ['a wrapped UnknownError', (verb) => errGeneric(verb, CSCB_UNKNOWN_ERROR_NAME, 'Error: boom'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
  ['a plain Error', () => new Error('boom'), UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
]

/** Read errors that are neither UNAVAILABLE nor excluded: a STATE and a GONE answer. */
const READ_ERRORS: ReadonlyArray<readonly [string, (verb: string) => Error]> = [
  ['a STATE answer (ErrSpawnNotInteractive)', (verb) => errSpawnNotInteractive(verb)],
  ['a GONE answer (ErrTmuxCaptureFailed)', (verb) => errTmuxCaptureFailed(undefined, verb)],
]

/** The result a launch that met an arming error at a site with `action` answers: a failure carries the refusal marker. */
function armedResult(key: string, action: SpawnPersonaResult['action']): SpawnPersonaResult {
  return action === 'failed' ? { key, action, refused: true } : { key, action }
}

/** Persona `key`'s timer was armed once, just now, at the base wait with `kind`; no other persona's was. */
function expectArmedOnce(h: RecoveryHarness, key: string, kind: string): void {
  expect(h.triggers).toEqual([{ key, kind }])
  expect(h.controller.armedKeys()).toEqual([key])
  expect(h.controller.view(key)).toEqual({ phase: 'waiting', dueAt: h.clock.now() + waitMs(0), waitMs: waitMs(0), refusals: 0, causes: [kind] })
  expect(delays(h.clock)).toEqual([waitMs(0)])
  expect(h.attempts).toEqual([])
}

/** No trigger was sent and nothing is armed or pending. */
function expectNothingArmed(h: RecoveryHarness): void {
  expect(h.triggers).toEqual([])
  expect(h.controller.armedKeys()).toEqual([])
  expect(h.clock.pendingCount()).toBe(0)
}

describe('unavailable retry: what arms the timer (SRJ-301)', () => {
  afterEach(() => {
    if (harness !== undefined) assertNoLeak(harness.captured())
  })

  const unavailableCross = UNAVAILABLE_VALUES.flatMap(([what, make, kind]) =>
    LAUNCH_SITES.map((site) => [what, site.name, site.verb, make, kind, site] as const),
  )

  test.each(unavailableCross)('UNAVAILABLE (%s) at %s (%s) inside a launch arms that persona’s timer once, at the base wait', async (_what, _site, verb, make, kind, site) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    h.script(site.script(h, personaOf(h, key), make(verb)))

    const result = await h.launch(key)

    expect(result).toEqual(armedResult(key, site.action))
    expectArmedOnce(h, key, kind)
  })

  const readCross = READ_ERRORS.flatMap(([what, make]) => READ_SITES.map((site) => [what, site.name, make, site] as const))

  test.each(readCross)('%s at %s inside a launch arms that persona’s timer as a read error', async (_what, _site, make, site) => {
    const h = (harness = makeRecoveryHarness())
    const [, key] = h.keys as [string, string]
    h.script(site.script(h, personaOf(h, key), make(site.verb)))

    const result = await h.launch(key)

    expect(result).toEqual(armedResult(key, site.action))
    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_READ_ERROR)
  })

  test.each<[string, () => Error, string | undefined, string | undefined]>([
    ['ErrTmuxUnresponsive from resume', () => errTmuxUnresponsive('resume'), 'resume', UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['ErrCallTimeout from spawn', () => errCallTimeout('spawn'), 'spawn', UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['a plain Error from delete', () => new Error('boom'), 'delete', UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['ErrTmuxUnresponsive with no verb known', () => errTmuxUnresponsive(), undefined, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
    ['ErrTmuxKillFailed from kill', () => errTmuxKillFailed(), 'kill', UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
    ['ErrTmuxKillFailed from status', () => errTmuxKillFailed(), 'status', UNAVAILABLE_RETRY_CAUSE_KILL_FAILED],
    ['a STATE answer from get', () => errSpawnNotInteractive('get'), 'get', UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
    ['a GONE answer from status', () => errTmuxCaptureFailed(undefined, 'status'), 'status', UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
    ['a STATE answer from list', () => errSpawnNotInteractive('list'), 'list', UNAVAILABLE_RETRY_CAUSE_READ_ERROR],
    ['ErrSpawnNotFound from get', () => errSpawnNotFound(), 'get', undefined],
    ['ErrSpawnNotFound from status', () => errSpawnNotFound(), 'status', undefined],
    ['a CONFIG answer from get', () => errConfigMalformed(), 'get', undefined],
    ['an UNUSABLE NAME answer from status', () => errUnusableName(), 'status', undefined],
    ['a STATE answer from read-pane', () => errSpawnNotInteractive('read-pane'), 'read-pane', undefined],
    ['a DIRECTORY answer from spawn', () => new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'cwd not found'), 'spawn', undefined],
    ['a LAUNCH FAILURE answer from resume', () => errTmuxSessionCreate('resume'), 'resume', undefined],
    ['a STATE answer with no verb known', () => errSpawnNotInteractive(), undefined, undefined],
  ])('the arming predicate: %s arms %s', (_what, make, verb, kind) => {
    const value = make()
    const cause = unavailableRetryCauseFor(value, verb)

    if (kind === undefined) expect(cause).toBeUndefined()
    else expect(cause).toEqual({ kind, error: value })
  })

  test.each<[string, (h: RecoveryHarness, persona: Persona) => RecoveryStubScript, SpawnPersonaResult['action']]>([
    ['a STATE answer from resume (ErrJsonlNeverWritten)', (h, p) => ({ ...collided(h, p, { state: 'ended' }), resumeError: errJsonlNeverWritten() }), 'spawned'],
    ['a DIRECTORY answer from spawn', () => ({ spawnError: new ErrCwdNotFound('spawn', 'ErrCwdNotFound', 'cwd not found') }), 'failed'],
    ['a LAUNCH FAILURE answer from resume', (h, p) => ({ ...collided(h, p, { state: 'ended' }), resumeError: errTmuxSessionCreate('resume') }), 'spawned'],
    ['ErrSpawnNotFound from the collision get', () => ({ spawnQueue: [cannedErr(errInstanceIdCollision())], getError: errSpawnNotFound() }), 'spawned'],
    ['ErrSpawnNotFound from the readiness read', () => ({ statusQueue: [cannedErr(errSpawnNotFound())] }), 'spawned'],
  ])('%s inside a launch arms nothing and marks nothing', async (_what, script, action) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    h.script(script(h, personaOf(h, key)))

    const result = await h.launch(key)

    expect(result).toEqual({ key, action })
    expectNothingArmed(h)
  })

  test.each<[string, (h: RecoveryHarness, key: string) => Promise<number>]>([
    ['the permission poller’s get', async (h, key) => {
      h.script({
        listResult: { spawns: [cannedListRow({ state: 'check_permission' }, personaOf(h, key), h.home)] },
        getError: errCallTimeout('get'),
      })
      let failed!: () => void
      const getFailed = new Promise<void>((resolve) => { failed = resolve })
      stopPermissionPoller()
      _resetPollerState()
      const poller = startManualPoller({
        getClient: () => h.stub.client as unknown as ReturnType<PollerDeps['getClient']>,
        clientFor: () => undefined,
        getPersona: (k) => h.config.personas.find((p) => p.key === k),
        emitTrail: () => {},
        log: (...args) => {
          if (args.map(String).join(' ').includes('get failed')) failed()
        },
      })
      try {
        poller.fire()
        await getFailed
      } finally {
        stopPermissionPoller()
        _resetPollerState()
      }
      return h.stub.calls.getCalls.length
    }],
    ['the JSONL safeguard’s get', async (h) => {
      h.script({ getError: errCallTimeout('get') })
      await runJsonlPersistenceSafeguard(h.config, undefined, {
        home: h.home,
        readMountinfo: () => '',
        statFn: () => false,
        archiveCountSince: () => null,
        recordStartupError: () => {},
      })
      return h.stub.calls.getCalls.length
    }],
    ['the health tick’s liveness read', async (h, key) => {
      h.script({ statusError: errCallTimeout('status') })
      expect(await _buildIsSessionAliveAdapter(() => h.config)(key)).toBe(false)
      return h.stub.calls.statusCalls.length
    }],
    ['the start sweep’s list', async (h) => {
      h.script({ listError: errCallTimeout('list') })
      await reconcileOrphans(h.config)
      return h.stub.calls.listCalls.length
    }],
    ['a persona teardown’s kill', async (h, key) => {
      const err = errTmuxKillFailed()
      h.script({ killError: err })
      await expect(killPersonaInstance(key)).rejects.toBe(err)
      return h.stub.calls.killCalls.length
    }],
  ])('an UNAVAILABLE answer to %s, made outside every attempt, arms nothing', async (_site, run) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]

    const calls = await run(h, key)

    expect(calls).toBeGreaterThan(0)
    expectNothingArmed(h)
  })

  test.each<[string, () => () => void, SpawnPersonaResult['action']]>([
    ['deferred by an unresolvable claude_config_dir', () => {
      _setConfigDirFs({ realpath: () => { throw Object.assign(new Error('no such directory'), { code: 'ENOENT' }) } })
      return _resetConfigDirFs
    }, 'deferred'],
    ['in dry run', () => {
      const saved = process.env['SLACK_DRY_RUN']
      process.env['SLACK_DRY_RUN'] = '1'
      return () => {
        if (saved === undefined) delete process.env['SLACK_DRY_RUN']
        else process.env['SLACK_DRY_RUN'] = saved
      }
    }, 'no-op'],
  ])('a launch %s is no attempt: it calls nothing and arms nothing', async (_what, install, action) => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    h.script({ spawnError: errTmuxUnresponsive('spawn') })
    const undo = install()
    let result: SpawnPersonaResult
    try {
      result = await h.launch(key)
    } finally {
      undo()
    }

    expect(result).toMatchObject({ key, action })
    expect(result.refused).toBeUndefined()
    expect(h.stub.callCount()).toBe(0)
    expectNothingArmed(h)
  })

  test('a trigger while armed, midway and 1 ms before the due time, keeps the one due time, and the retry fires at the arm plus the base wait', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    h.script({ spawnError: errTmuxUnresponsive('spawn') })
    const dueAt = h.clock.now() + waitMs(0)
    await h.launch(key)

    await h.advance(waitMs(0) / 2)
    await h.launch(key)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([dueAt])

    await h.advance(dueAt - 1 - h.clock.now())
    await h.launch(key)
    expect(h.clock.pending().map((t) => t.dueAt)).toEqual([dueAt])
    expect(h.triggers).toEqual([1, 2, 3].map(() => ({ key, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE })))
    expect(h.attempts).toEqual([])

    await h.advance(1)
    expect(h.attempts).toEqual([{ key, retry: 1, causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE], at: dueAt }])
  })

  test('a launch that joins one in flight, which then fails UNAVAILABLE, gets the same marked result, and one timer is armed', async () => {
    const h = (harness = makeRecoveryHarness())
    const [key] = h.keys as [string]
    const hold = holdSpawns(h.stub.client)
    const first = h.launch(key)
    await hold.entered(personaInstanceId(key))
    const joined = h.launch(key)

    hold.fail(personaInstanceId(key), errTmuxUnresponsive('spawn'))
    await h.settle()

    const marked: SpawnPersonaResult = { key, action: 'failed', refused: true }
    expect(await first).toEqual(marked)
    expect(await joined).toEqual(marked)
    expect(hold.calls).toHaveLength(1)
    expectArmedOnce(h, key, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)
  })

  test('with no trigger sink installed, a launch fed UNAVAILABLE schedules no timer, throws nothing and is not marked', async () => {
    const h = (harness = makeRecoveryHarness({ triggerSink: false }))
    const [key] = h.keys as [string]
    h.script({ spawnError: errTmuxUnresponsive('spawn') })

    const result = await h.launch(key)

    expect(result).toEqual({ key, action: 'failed' })
    expectNothingArmed(h)
  })
})

// ---------------------------------------------------------------------------
// The shared findMissing sweep (b.jg5 SRJ-301): each persona that met a failed
// sweep inside its own attempt is armed once, whoever started the sweep.
// ---------------------------------------------------------------------------

/** The harness stub's findMissing, held open: every call waits until the test fails them all. */
interface FindMissingHold {
  /** findMissing calls made so far. */
  calls(): number
  /** Resolves at the first findMissing call. */
  readonly entered: Promise<void>
  /** Reject every held call with `err`. */
  failAll(err: Error): void
}

function holdFindMissing(h: RecoveryHarness): FindMissingHold {
  const client = h.stub.client as unknown as { findMissing: (params: unknown) => Promise<unknown> }
  const held: Array<(err: Error) => void> = []
  const entered = Promise.withResolvers<void>()
  let calls = 0
  client.findMissing = () => {
    calls++
    entered.resolve()
    return new Promise((_resolve, reject) => { held.push(reject) })
  }
  return {
    calls: () => calls,
    entered: entered.promise,
    failAll: (err) => {
      for (const reject of held.splice(0)) reject(err)
    },
  }
}

/** One live pre-persona row (no `persona` label), so the start sweep kills it and then runs its findMissing sweep. */
function prePersonaRowScript(): RecoveryStubScript {
  return { listResult: { spawns: [cannedListRow({ claude_instance_id: 'cscb_legacy', labels: { service: 'cscb' } })] } }
}

/** Persona `key`'s escalate-dead sweep, made inside a recovery attempt for it. */
function sweepInAttempt(key: string): Promise<void> {
  return runInAttempt(key, 'recovery', () => sweepDeadTmuxChannel(key, 'dead-session'))
}

describe('unavailable retry: a shared findMissing sweep that fails arms each persona that met it inside its attempt (SRJ-301)', () => {
  afterEach(() => {
    if (harness !== undefined) assertNoLeak(harness.captured())
  })

  test('P and Q, each inside its own attempt, share one findMissing call; when it fails each is armed once with unavailable', async () => {
    const h = (harness = makeRecoveryHarness())
    const [p, q] = h.keys as [string, string]
    const hold = holdFindMissing(h)

    const both = Promise.all([sweepInAttempt(p), sweepInAttempt(q)])
    await hold.entered
    hold.failAll(errCallTimeout('find-missing'))
    await both

    expect(hold.calls()).toBe(1)
    const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key)
    expect([...h.triggers].sort(byKey)).toEqual(
      [{ key: p, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }, { key: q, kind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE }].sort(byKey),
    )
    expect([...h.controller.armedKeys()].sort()).toEqual([p, q].sort())
    for (const key of [p, q]) {
      expect(h.controller.view(key)).toEqual({
        phase: 'waiting',
        dueAt: h.clock.now() + waitMs(0),
        waitMs: waitMs(0),
        refusals: 0,
        causes: [UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE],
      })
    }
    expect(delays(h.clock)).toEqual([waitMs(0), waitMs(0)])
    expect(h.attempts).toEqual([])
  })

  test('a persona inside its attempt that joins the start sweep’s direct findMissing call, which fails, is armed once', async () => {
    const h = (harness = makeRecoveryHarness())
    const [p] = h.keys as [string]
    h.script(prePersonaRowScript())
    const hold = holdFindMissing(h)

    const sweep = reconcileOrphans(h.config)
    await hold.entered
    const joined = sweepInAttempt(p)
    hold.failAll(errCallTimeout('find-missing'))
    const result = await sweep
    await joined

    expect(result.prePersona).toEqual({ kept: 1, live: 1, killFailed: 0 })
    expect(hold.calls()).toBe(1)
    expectArmedOnce(h, p, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)
  })

  test.each<[string, (h: RecoveryHarness, starter: string) => Promise<unknown>, boolean]>([
    ['the start sweep’s direct call', (h) => reconcileOrphans(h.config), false],
    ['another persona’s sweep inside its attempt', (_h, starter) => sweepInAttempt(starter), true],
  ])('a persona outside every attempt that joins %s, which fails, arms nothing for itself', async (_what, start, starterArms) => {
    const h = (harness = makeRecoveryHarness())
    const [starter, joiner] = h.keys as [string, string]
    h.script(prePersonaRowScript())
    const hold = holdFindMissing(h)

    const started = start(h, starter)
    await hold.entered
    const joined = sweepDeadTmuxChannel(joiner, 'dead-session')
    hold.failAll(errCallTimeout('find-missing'))
    await started
    await joined

    expect(hold.calls()).toBe(1)
    expect(h.controller.isArmed(joiner)).toBe(false)
    if (starterArms) expectArmedOnce(h, starter, UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE)
    else expectNothingArmed(h)
  })

  test('the start sweep’s findMissing failing with no persona joined reports nothing', async () => {
    const h = (harness = makeRecoveryHarness())
    h.script({ ...prePersonaRowScript(), findMissingError: errCallTimeout('find-missing') })

    const result = await reconcileOrphans(h.config)

    expect(result.prePersona).toEqual({ kept: 1, live: 1, killFailed: 0 })
    expect(h.stub.calls.findMissingCalls).toHaveLength(1)
    expectNothingArmed(h)
  })
})

// ---------------------------------------------------------------------------
// Attempt frames (b.jg5 SRJ-301): a continuation that outlives its attempt
// ---------------------------------------------------------------------------

describe('unavailable retry: an attempt started from a continuation that outlives a closed attempt', () => {
  const OUTER = 'gamma'

  /** Run `callback` later, from inside the current attempt: after `gate` opens, or on a real 0 ms timer. */
  type Later = (callback: () => void, gate: Promise<void>) => void
  const LATERS: ReadonlyArray<readonly [string, Later]> = [
    ['a timer callback', (callback) => { setTimeout(callback, 0) }],
    ['a promise continuation', (callback, gate) => { void gate.then(callback) }],
  ]
  const CASES = LATERS.flatMap(([how, later]) => [
    [how, 'with an enclosing attempt still open', later, true] as const,
    [how, 'with no enclosing attempt', later, false] as const,
  ])

  /** What the attempt started from the continuation saw. */
  interface Seen {
    readonly inside: { readonly own: boolean; readonly closed: boolean; readonly outer: boolean }
    readonly armed: { readonly own: boolean; readonly closed: boolean; readonly outer: boolean }
    readonly ownLastError: AttemptErrorRecord | undefined
    /** `isInsideAttempt` for each key in the continuation once the new attempt has settled. */
    readonly after: { readonly own: boolean; readonly closed: boolean; readonly outer: boolean }
  }

  test.each(CASES)('%s, %s: the new attempt is not nested in the closed one, and isInsideAttempt answers as before', async (_how, _outer, later, withOuter) => {
    const { controller } = makeRig()
    const err = errCallTimeout('status')
    const gate = Promise.withResolvers<void>()
    const seen = Promise.withResolvers<Seen>()
    let closedView!: AttemptView

    const run = async (): Promise<Seen> => {
      await runInAttempt(KEY, 'launch', (view) => {
        closedView = view
        later(() => {
          void runInAttempt(OTHER, 'recovery', (own) => {
            const inside = { own: isInsideAttempt(OTHER), closed: isInsideAttempt(KEY), outer: isInsideAttempt(OUTER) }
            const armed = {
              own: reportAttemptError(OTHER, err, 'status', controller),
              closed: reportAttemptError(KEY, err, 'status', controller),
              outer: reportAttemptError(OUTER, err, 'status', controller),
            }
            return { inside, armed, ownLastError: own.lastError }
          }).then((partial) => {
            seen.resolve({ ...partial, after: { own: isInsideAttempt(OTHER), closed: isInsideAttempt(KEY), outer: isInsideAttempt(OUTER) } })
          }, seen.reject)
        }, gate.promise)
      })
      expect(isInsideAttempt(KEY)).toBe(false)
      gate.resolve()
      return seen.promise
    }

    let outerView: AttemptView | undefined
    const result = withOuter
      ? await runInAttempt(OUTER, 'recovery', (view) => {
          outerView = view
          return run()
        })
      : await run()

    const armedRecord: AttemptErrorRecord = { verb: 'status', causeKind: UNAVAILABLE_RETRY_CAUSE_UNAVAILABLE, armed: true }
    expect(result.inside).toEqual({ own: true, closed: false, outer: withOuter })
    expect(result.armed).toEqual({ own: true, closed: false, outer: withOuter })
    expect(result.ownLastError).toEqual(armedRecord)
    expect(result.after).toEqual({ own: false, closed: false, outer: withOuter })
    expect(closedView.lastError).toBeUndefined()
    expect(outerView?.lastError).toEqual(withOuter ? armedRecord : undefined)
    expect([...controller.armedKeys()].sort()).toEqual((withOuter ? [OTHER, OUTER] : [OTHER]).sort())
    expect(controller.isArmed(KEY)).toBe(false)
    expect([isInsideAttempt(KEY), isInsideAttempt(OTHER), isInsideAttempt(OUTER)]).toEqual([false, false, false])
  })
})
