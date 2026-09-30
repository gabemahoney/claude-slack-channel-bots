/**
 * unavailable-retry.test.ts — The per-persona UNAVAILABLE retry timer
 * (b.jg5 SRJ-301 code line, SRJ-302, SRJ-304).
 *
 * The schedule, the never-give-up rule, arming while armed and isolation run
 * on the bare controller over `createFakeClock` with a scripted action;
 * settings independence runs on `makeRecoveryHarness` and a comment-stripped
 * source audit. Only the pin case holds the SRD's numbers; every other case
 * derives its waits from the exported base and ceiling through
 * `doublingBackoffDelay`. No case sleeps or starts a real timer.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { _resetBackoffState, doublingBackoffDelay, getFailureCount, isAtCap, recordFailure } from '../src/backoff.ts'
import { _resetRestartState, isRestartPendingOrActive, RESTART_FAILURE_CAP, scheduleRestart } from '../src/restart.ts'
import {
  createUnavailableRetryController,
  UNAVAILABLE_RETRY_BASE_S,
  UNAVAILABLE_RETRY_CEILING_S,
  type UnavailableRetryAction,
  type UnavailableRetryCause,
  type UnavailableRetryController,
  type UnavailableRetryOutcome,
} from '../src/unavailable-retry.ts'
import { errGeneric } from './test-helpers/agent-director-stub.ts'
import {
  assertNoLeak,
  BOT_TOKEN_PREFIX,
  fakeToken,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { makeRecoveryHarness, type RecoveryAttempt, type RecoveryHarness } from './test-helpers/recovery-harness.ts'
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
