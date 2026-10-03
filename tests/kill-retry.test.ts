/**
 * kill-retry.test.ts — the bounded retry of a live row's kill
 * (`src/kill-retry.ts`; b.jg5 SRJ-702, SRJ-110's survivor rule and CONFIG
 * bullet, SRJ-703, SRJ-704's and SRJ-1007's alert decision, SRJ-1014's lines).
 *
 * Every case runs `runKillRetry` on `createFakeClock`: each try is one
 * checked kill (`checkedKill`) through the stub client's kill queue, and
 * each read between tries is the stub client's `status` (its queue), or a
 * read the caller's own read would answer (latched, no row). The clock is
 * moved only to the retry's own pending wait (`driveToEnd`), whose requested
 * delay is recorded, so the schedule is asserted on what the code asked for
 * and no case waits in real time. Every value (the try count, the spacing,
 * the ends, the alert kinds, the class labels) comes from `src/`; every
 * description from the stub's builders. A caller whose checked kill counts
 * GONE as no success (`goneIsFailure`, the CLI's teardown) runs the same
 * retry; its GONE answer ends the tries as a failure, beside the server
 * default's session-gone success. The alert decision carries
 * agent-director's descriptions raw by design (T3 redacts at its post), so
 * the leak check covers the log lines, never the decision.
 *
 * The module's import boundary is checked by walking its runtime imports
 * through `src/` (`forbiddenServerLoads`, `tests/test-helpers/source-audit.ts`).
 *
 * No process, no real timer, no top-level mock.module(), no value import of
 * `Client` or `resolveSystemBinary`, no Phase-1-only named import.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'

import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_GONE,
  AD_ERROR_CLASS_UNAVAILABLE,
} from '../src/ad-error-class.ts'
import type { Phase1KillResult, Phase1StatusResult } from '../src/ad-phase1-types.ts'
import {
  KILL_OUTCOME_KILLED,
  KILL_OUTCOME_NOT_KILLED,
  KILL_OUTCOME_ROW_FINISHED,
  KILL_OUTCOME_ROW_GONE,
  KILL_OUTCOME_SESSION_GONE,
  KILL_ROW_FINISHED_ENDED,
  KILL_ROW_FINISHED_MISSING,
  KILL_ROW_FINISHED_NO_ROW,
  checkedKill,
  killOutcomeOf,
  type AnyKillOutcome,
  type CheckedKillOptions,
  type KillOutcome,
  type KillRowFinishedRead,
  type PlainKillParams,
} from '../src/checked-kill.ts'
import {
  KILL_RETRY_ALERT_NONE,
  KILL_RETRY_ALERT_ORDINARY,
  KILL_RETRY_ALERT_SURVIVOR,
  KILL_RETRY_END_BUDGET_SPENT,
  KILL_RETRY_END_EXHAUSTED,
  KILL_RETRY_END_READ_CONFIG,
  KILL_RETRY_END_READ_LATCHED,
  KILL_RETRY_END_ROW_FINISHED,
  KILL_RETRY_END_SETTLED,
  KILL_RETRY_END_STOPPED,
  KILL_RETRY_NEXT_NOT_RETRIED,
  KILL_RETRY_NEXT_SUCCESS,
  KILL_RETRY_READ_FAILED,
  KILL_RETRY_READ_LATCHED,
  KILL_RETRY_READ_NO_ROW,
  KILL_RETRY_READ_STATE,
  KILL_RETRY_SEED_LIVE_UNREAD,
  KILL_RETRY_SEED_NOT_LIVE_VALUE,
  KILL_RETRY_SPACING_MS,
  KILL_RETRY_TRIES,
  createKillRetryPassBudget,
  killRetryEndLine,
  killRetrySeedIsLive,
  killRetrySeedOfState,
  killRetryStopped,
  killRetryTryLine,
  runKillRetry,
  type KillRetryAlert,
  type KillRetryPassBudget,
  type KillRetryRead,
  type KillRetryResult,
  type KillRetrySeed,
} from '../src/kill-retry.ts'
import { REDACTED_TOKEN_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import {
  STUB_INSTANCE_ID,
  STUB_SURVIVOR_PIDS,
  cannedErr,
  cannedKillResult,
  cannedOk,
  cannedStatusResult,
  errCallTimeout,
  errConfigMalformed,
  errInternal,
  errSpawnNotFound,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSendKeys,
  errTmuxSessionConflict,
  errTmuxUnresponsive,
  errUnusableName,
  makeStubClient,
  unavailableForms,
  type CannedResponse,
} from './test-helpers/agent-director-stub.ts'
import {
  BOT_TOKEN_PREFIX,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { forbiddenServerLoads } from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The head of every line in this file. */
const PREFIX = '[slack] kill-retry-test'

/** A row last read in a live state other than `pending`. */
const SEED_WAITING = killRetrySeedOfState('waiting')
/** A row last read `pending`. */
const SEED_PENDING = killRetrySeedOfState('pending')

/** One read between tries: a stub `status` answer, or what a caller's own read answers (latched, no row). */
type ReadStep = CannedResponse<Phase1StatusResult> | KillRetryRead

/** One bounded retry, scripted. */
interface RunSpec {
  /** The kill's answers, one per try, through the stub's kill queue. */
  readonly kills: CannedResponse<Phase1KillResult>[]
  /** The reads' answers, one per read; once they run out the stub reads the row `waiting`. */
  readonly reads?: ReadStep[]
  /** The state the path last read; a row read `waiting` by default. */
  readonly lastRead?: KillRetrySeed
  readonly keepGoing?: () => boolean
  readonly budget?: KillRetryPassBudget
  /** The checked kill's options for every try; absent, none (every server site). */
  readonly killOptions?: CheckedKillOptions
}

/** What one scripted retry did. */
interface Run {
  readonly result: KillRetryResult<AnyKillOutcome>
  /** `kill` and `status` in call order. */
  readonly calls: string[]
  /** The clock time of each kill. */
  readonly killTimes: number[]
  /** The delay each wait asked the clock for, in order. */
  readonly delays: number[]
  readonly lines: string[]
}

/** Every line a case captured, leak-checked after it. */
let captured: string[] = []

afterEach(() => {
  assertNoLeak(captured)
  captured = []
})

/** A stub canned response is `resolve` or `reject`; a caller's read carries one of the read kinds. */
function isCanned(step: ReadStep): step is CannedResponse<Phase1StatusResult> {
  return step.kind === 'resolve' || step.kind === 'reject'
}

/**
 * Move `clock` until `work` settles, one pending timer at a time, recording
 * each timer's requested delay. Fails the case if `work` neither settles nor
 * waits on the clock.
 */
async function driveToEnd(clock: FakeClock, work: Promise<unknown>): Promise<number[]> {
  let settled = false
  void work.then(() => { settled = true }, () => { settled = true })
  const delays: number[] = []
  for (let step = 0; step < 10; step++) {
    await clock.flush()
    if (settled) return delays
    const next = clock.pending()[0]
    if (next === undefined) throw new Error('the retry neither settled nor waits on the clock')
    delays.push(next.delayMs)
    await clock.runNext()
  }
  throw new Error('the retry waited more than 10 times')
}

/** Run one bounded retry of `STUB_INSTANCE_ID`'s kill as `spec` scripts it. */
async function run(spec: RunSpec): Promise<Run> {
  const clock = createFakeClock()
  const calls: string[] = []
  const killTimes: number[] = []
  const lines: string[] = []
  const statusQueue: CannedResponse<Phase1StatusResult>[] = []
  const client = makeStubClient({ killQueue: [...spec.kills], statusQueue })
  const reads = [...(spec.reads ?? [])]
  const work = runKillRetry<AnyKillOutcome>({
    instanceId: STUB_INSTANCE_ID,
    kill: () => {
      calls.push('kill')
      killTimes.push(clock.now())
      const kill = (params: PlainKillParams): Promise<unknown> => client.kill(params)
      return spec.killOptions === undefined ? checkedKill(STUB_INSTANCE_ID, kill) : checkedKill(STUB_INSTANCE_ID, kill, spec.killOptions)
    },
    read: async (): Promise<KillRetryRead> => {
      calls.push('status')
      const step = reads.shift()
      if (step !== undefined && !isCanned(step)) return step
      if (step !== undefined) statusQueue.push(step)
      try {
        const row = await client.status({ claude_instance_id: STUB_INSTANCE_ID })
        return { kind: KILL_RETRY_READ_STATE, state: row.state }
      } catch (error) {
        return { kind: KILL_RETRY_READ_FAILED, error }
      }
    },
    wait: clock,
    lastRead: spec.lastRead ?? SEED_WAITING,
    ...(spec.keepGoing === undefined ? {} : { keepGoing: spec.keepGoing }),
    ...(spec.budget === undefined ? {} : { budget: spec.budget }),
    log: (line) => {
      lines.push(line)
    },
    logPrefix: PREFIX,
  })
  const delays = await driveToEnd(clock, work)
  const result = await work
  expect(clock.pendingCount()).toBe(0)
  captured.push(...lines)
  return { result, calls, killTimes, delays, lines }
}

/** `n` copies of the kill answer rejecting with `make()`'s value (a fresh value each). */
function failing(n: number, make: () => Error): CannedResponse<Phase1KillResult>[] {
  return Array.from({ length: n }, () => cannedErr<Phase1KillResult>(make()))
}

/** The not-killed outcome a kill answering `err` gives. */
const notKilled = (err: unknown): KillOutcome => killOutcomeOf({ thrown: err })

/** The row-finished success a read of `read` gives. */
const rowFinished = (read: KillRowFinishedRead): KillOutcome => ({ kind: KILL_OUTCOME_ROW_FINISHED, read })

/** A survivor-naming `ErrTmuxKillFailed` naming `pids`. */
const survivorKillFailed = (pids: readonly number[] = STUB_SURVIVOR_PIDS): Error => errTmuxKillFailed(undefined, 'pane-process-survived', pids)

/** An `ErrTmuxKillFailed` naming no survivor. */
const plainKillFailed = (): Error => errTmuxKillFailed(undefined, 'outlived-exit-wait')

/** An error's agent-director description. */
const descriptionOf = (err: Error): string => (err as Error & { errDescription: string }).errDescription

/** A read of the row in `state`, through the stub. */
const readState = (state: string): CannedResponse<Phase1StatusResult> => cannedOk(cannedStatusResult({ state }))

/** The kill's UNAVAILABLE forms (b.jg5 SRJ-104), each tried again (SRJ-702). */
const RETRIED_FORMS = unavailableForms(
  ['ErrTmuxKillFailed', 'ErrTmuxKillFailed (naming no survivor)'],
  'ErrTmuxUnresponsive',
  ['ErrUnknownErrorName', 'ErrUnknownErrorName (a name from a later binary)'],
  'ErrCallTimeout',
  'a wrapped UnknownError',
)

// ---------------------------------------------------------------------------
// The schedule (AC 56)
// ---------------------------------------------------------------------------

describe('runKillRetry: the schedule (b.jg5 SRJ-702, AC 56)', () => {
  test('pin: SRJ-702\'s 3 tries 2 s apart', () => {
    expect(KILL_RETRY_TRIES).toBe(3)
    expect(KILL_RETRY_SPACING_MS).toBe(2_000)
  })

  test.each(RETRIED_FORMS)('%s at every try: exactly the exported try count, spaced by the exported spacing, with one read before each further try; the last outcome stands, exhausted', async (_label, make) => {
    const errors = Array.from({ length: KILL_RETRY_TRIES }, () => make('kill'))

    const r = await run({ kills: errors.map((e) => cannedErr<Phase1KillResult>(e)) })

    expect(r.result.tries).toBe(KILL_RETRY_TRIES)
    expect(r.result.reads).toBe(KILL_RETRY_TRIES - 1)
    expect(r.killTimes).toEqual(Array.from({ length: KILL_RETRY_TRIES }, (_, i) => i * KILL_RETRY_SPACING_MS))
    expect(r.delays).toEqual(Array.from({ length: KILL_RETRY_TRIES - 1 }, () => KILL_RETRY_SPACING_MS))
    expect(r.result.end).toBe(KILL_RETRY_END_EXHAUSTED)
    expect(r.result.outcome).toEqual(notKilled(errors[KILL_RETRY_TRIES - 1]))
    expect(killRetryStopped(r.result)).toBe(false)
  })

  test('a success on the second try ends the tries: two kills, one read, that success stands with no alert', async () => {
    const r = await run({ kills: [cannedErr(errTmuxUnresponsive('kill')), cannedOk(cannedKillResult(true))] })

    expect(r.calls).toEqual(['kill', 'status', 'kill'])
    expect(r.killTimes).toEqual([0, KILL_RETRY_SPACING_MS])
    expect(r.result).toEqual({
      outcome: { kind: KILL_OUTCOME_KILLED, killSent: true },
      end: KILL_RETRY_END_SETTLED,
      tries: 2,
      reads: 1,
      alert: { kind: KILL_RETRY_ALERT_NONE },
    })
  })

  test('the wait may be a sleep function: it is asked for the exported spacing before each further try', async () => {
    const asked: number[] = []
    const result = await runKillRetry({
      instanceId: STUB_INSTANCE_ID,
      kill: async () => notKilled(errTmuxUnresponsive('kill')),
      read: async () => ({ kind: KILL_RETRY_READ_STATE, state: 'waiting' }),
      wait: async (ms) => {
        asked.push(ms)
      },
      lastRead: SEED_WAITING,
      log: (line) => {
        captured.push(line)
      },
      logPrefix: PREFIX,
    })

    expect(asked).toEqual(Array.from({ length: KILL_RETRY_TRIES - 1 }, () => KILL_RETRY_SPACING_MS))
    expect(result.tries).toBe(KILL_RETRY_TRIES)
  })

  test('a kill that throws is taken as its outcome and tried again; a read that throws is a failed read and the try goes ahead; a log sink that throws changes nothing', async () => {
    const clock = createFakeClock()
    let kills = 0
    const work = runKillRetry({
      instanceId: STUB_INSTANCE_ID,
      kill: () => {
        kills++
        throw errTmuxUnresponsive('kill')
      },
      read: () => {
        throw errCallTimeout('status')
      },
      wait: clock,
      lastRead: SEED_WAITING,
      log: () => {
        throw new Error('sink failed')
      },
      logPrefix: PREFIX,
    })
    await driveToEnd(clock, work)
    const result = await work

    expect(kills).toBe(KILL_RETRY_TRIES)
    expect(result).toMatchObject({ end: KILL_RETRY_END_EXHAUSTED, tries: KILL_RETRY_TRIES, reads: KILL_RETRY_TRIES - 1 })
    expect(result.outcome).toMatchObject({ kind: KILL_OUTCOME_NOT_KILLED, errorClass: AD_ERROR_CLASS_UNAVAILABLE })
    expect(clock.pendingCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Which outcomes are tried again
// ---------------------------------------------------------------------------

describe('runKillRetry: only UNAVAILABLE of a row last read live is tried again (b.jg5 SRJ-702, SRJ-110)', () => {
  test.each<[string, () => Error, KillOutcome['kind'], string | undefined]>([
    ['CONFLICT (never retried as a kill, AC 9)', () => errTmuxSessionConflict('kill', 'not-this-launch'), KILL_OUTCOME_NOT_KILLED, AD_ERROR_CLASS_CONFLICT],
    ['UNUSABLE NAME', () => errUnusableName(), KILL_OUTCOME_NOT_KILLED, undefined],
    ['CONFIG', () => errConfigMalformed(), KILL_OUTCOME_NOT_KILLED, AD_ERROR_CLASS_CONFIG],
    ['ErrTmuxNotAvailable (ENVIRONMENT)', () => errTmuxNotAvailable(undefined, 'kill'), KILL_OUTCOME_NOT_KILLED, AD_ERROR_CLASS_ENVIRONMENT],
    ['ErrInternal (UNCLASSIFIED)', () => errInternal(), KILL_OUTCOME_NOT_KILLED, undefined],
    ['ErrSpawnNotFound (the row-gone success)', () => errSpawnNotFound(), KILL_OUTCOME_ROW_GONE, undefined],
    ['GONE (the session-gone success)', () => errTmuxCaptureFailed(undefined, 'kill'), KILL_OUTCOME_SESSION_GONE, undefined],
  ])('%s at the first try: one kill, no read, no wait; its outcome stands', async (_label, make, kind, errorClass) => {
    const err = make()

    const r = await run({ kills: [cannedErr(err), ...failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill'))] })

    expect(r.calls).toEqual(['kill'])
    expect(r.delays).toEqual([])
    expect(r.result).toMatchObject({ end: KILL_RETRY_END_SETTLED, tries: 1, reads: 0, alert: { kind: KILL_RETRY_ALERT_NONE } })
    expect(r.result.outcome).toEqual(notKilled(err))
    expect(r.result.outcome.kind).toBe(kind)
    if (errorClass !== undefined) expect(r.result.outcome).toMatchObject({ errorClass })
  })

  test.each<[string, KillRetrySeed]>([
    ['read ended', killRetrySeedOfState('ended')],
    ['read missing', killRetrySeedOfState('missing')],
    ['not read live (no row, or not read)', KILL_RETRY_SEED_NOT_LIVE_VALUE],
  ])('a row last %s gets one kill: its UNAVAILABLE outcome stands at once, no read, no wait', async (_label, lastRead) => {
    const err = errTmuxUnresponsive('kill')

    const r = await run({ kills: [cannedErr(err), ...failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill'))], lastRead })

    expect(r.calls).toEqual(['kill'])
    expect(r.delays).toEqual([])
    expect(r.result).toEqual({ outcome: notKilled(err), end: KILL_RETRY_END_SETTLED, tries: 1, reads: 0, alert: { kind: KILL_RETRY_ALERT_NONE } })
  })

  test.each<[string, KillRetrySeed, boolean]>([
    ['pending', SEED_PENDING, true],
    ['waiting', SEED_WAITING, true],
    ['a state CSCB does not know', killRetrySeedOfState('hibernating'), true],
    ['live, its state not read (agent-director called it live)', KILL_RETRY_SEED_LIVE_UNREAD, true],
    ['ended', killRetrySeedOfState('ended'), false],
    ['missing', killRetrySeedOfState('missing'), false],
    ['not live', KILL_RETRY_SEED_NOT_LIVE_VALUE, false],
  ])('a seed of %s is live: %p', (_label, seed, live) => {
    expect(killRetrySeedIsLive(seed)).toBe(live)
  })

  // b.jg5 SRJ-702 (HO rev 23): a tmux server that is exiting after a kill
  // ended its last session answers by class.
  test('HO rev 23: a first try\'s ErrTmuxUnresponsive then a second try\'s ErrTmuxNotAvailable ends the tries at once with the ENVIRONMENT outcome standing', async () => {
    const gone = errTmuxNotAvailable(undefined, 'kill')

    const r = await run({ kills: [cannedErr(errTmuxUnresponsive('kill')), cannedErr(gone), ...failing(1, () => errTmuxUnresponsive('kill'))] })

    expect(r.calls).toEqual(['kill', 'status', 'kill'])
    expect(r.result).toEqual({ outcome: notKilled(gone), end: KILL_RETRY_END_SETTLED, tries: 2, reads: 1, alert: { kind: KILL_RETRY_ALERT_NONE } })
    expect(r.result.outcome).toMatchObject({ errorClass: AD_ERROR_CLASS_ENVIRONMENT })
  })
})

// ---------------------------------------------------------------------------
// The read before each further try (AC 84)
// ---------------------------------------------------------------------------

describe('runKillRetry: one status read before each further try (b.jg5 SRJ-702, SRJ-110, AC 84)', () => {
  test.each<[string, ReadStep, KillRowFinishedRead]>([
    ['ended', readState('ended'), KILL_ROW_FINISHED_ENDED],
    ['missing', readState('missing'), KILL_ROW_FINISHED_MISSING],
    ['ErrSpawnNotFound (by name)', cannedErr(errSpawnNotFound()), KILL_ROW_FINISHED_NO_ROW],
    ['no row (the caller\'s read answered it)', { kind: KILL_RETRY_READ_NO_ROW }, KILL_ROW_FINISHED_NO_ROW],
  ])('a read of %s ends the tries as the row-finished success with no further kill and, with no survivor-naming failure before it, no alert', async (_label, read, finished) => {
    const r = await run({ kills: failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill')), reads: [read] })

    expect(r.calls).toEqual(['kill', 'status'])
    expect(r.result).toEqual({ outcome: rowFinished(finished), end: KILL_RETRY_END_ROW_FINISHED, tries: 1, reads: 1, alert: { kind: KILL_RETRY_ALERT_NONE } })
  })

  test.each<[string, Error]>([
    ['UNAVAILABLE (ErrCallTimeout)', errCallTimeout('status')],
    ['UNCLASSIFIED (ErrInternal)', errInternal()],
    ['UNUSABLE NAME that latched nothing', errUnusableName()],
  ])('a failed read (%s) lets the next try go ahead', async (_label, readErr) => {
    const r = await run({ kills: failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill')), reads: [cannedErr(readErr), cannedErr(readErr)] })

    expect(r.calls).toEqual(['kill', 'status', 'kill', 'status', 'kill'])
    expect(r.result.end).toBe(KILL_RETRY_END_EXHAUSTED)
  })

  test('a CONFIG read on a row last read pending ends the tries with no further kill; the last try\'s outcome stands', async () => {
    const last = errTmuxUnresponsive('kill')

    const r = await run({ kills: [cannedErr(last), ...failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill'))], reads: [cannedErr(errConfigMalformed())], lastRead: SEED_PENDING })

    expect(r.calls).toEqual(['kill', 'status'])
    expect(r.result).toEqual({ outcome: notKilled(last), end: KILL_RETRY_END_READ_CONFIG, tries: 1, reads: 1, alert: { kind: KILL_RETRY_ALERT_NONE } })
    expect(killRetryStopped(r.result)).toBe(false)
  })

  test('a CONFIG read on a row last read waiting lets the next try go ahead', async () => {
    const r = await run({ kills: failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill')), reads: [cannedErr(errConfigMalformed()), cannedErr(errConfigMalformed())], lastRead: SEED_WAITING })

    expect(r.calls).toEqual(['kill', 'status', 'kill', 'status', 'kill'])
    expect(r.result.end).toBe(KILL_RETRY_END_EXHAUSTED)
  })

  // The state last read is the seed, then each live read: a later CONFIG
  // read follows the state read just before it.
  test.each<[string, KillRetrySeed, string, string[], KillRetryResult['end']]>([
    ['seeded waiting, read pending, then CONFIG: the tries end', SEED_WAITING, 'pending', ['kill', 'status', 'kill', 'status'], KILL_RETRY_END_READ_CONFIG],
    ['seeded pending, read waiting, then CONFIG: the try goes ahead', SEED_PENDING, 'waiting', ['kill', 'status', 'kill', 'status', 'kill'], KILL_RETRY_END_EXHAUSTED],
  ])('%s', async (_label, lastRead, readBetween, calls, end) => {
    const r = await run({ kills: failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill')), reads: [readState(readBetween), cannedErr(errConfigMalformed())], lastRead })

    expect(r.calls).toEqual(calls)
    expect(r.result.end).toBe(end)
  })

  test('a read that latched the persona ends the tries with no further kill; the last try\'s outcome stands and the tries count as stopped', async () => {
    const last = errTmuxUnresponsive('kill')

    const r = await run({ kills: [cannedErr(last), ...failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill'))], reads: [{ kind: KILL_RETRY_READ_LATCHED }] })

    expect(r.calls).toEqual(['kill', 'status'])
    expect(r.result).toEqual({ outcome: notKilled(last), end: KILL_RETRY_END_READ_LATCHED, tries: 1, reads: 1, alert: { kind: KILL_RETRY_ALERT_NONE } })
    expect(killRetryStopped(r.result)).toBe(true)
  })

  test.each<[string, (asks: number) => boolean, string[], number]>([
    ['false after the wait: no read and no further kill', () => false, ['kill'], 0],
    ['true after the wait, false after the read: no further kill', (asks) => asks < 2, ['kill', 'status'], 1],
    ['a throw (counted as false): no read and no further kill', () => { throw new Error('query failed') }, ['kill'], 0],
  ])('the keep-going check answering %s; the last outcome stands and the tries count as stopped', async (_label, answer, calls, reads) => {
    const last = errTmuxUnresponsive('kill')
    let asks = 0

    const r = await run({
      kills: [cannedErr(last), ...failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill'))],
      keepGoing: () => answer(++asks),
    })

    expect(r.calls).toEqual(calls)
    expect(r.result).toEqual({ outcome: notKilled(last), end: KILL_RETRY_END_STOPPED, tries: 1, reads, alert: { kind: KILL_RETRY_ALERT_NONE } })
    expect(killRetryStopped(r.result)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The survivor rule and the alert decision (AC 63's half, AC 64)
// ---------------------------------------------------------------------------

describe('runKillRetry: the survivor rule and the alert decision (b.jg5 SRJ-702, SRJ-704, SRJ-1007, AC 64)', () => {
  /** The survivor-naming first try, its description, and the survivor decision quoting it. */
  function survivorFirst(): { err: Error; description: string; survivor: KillRetryAlert } {
    const err = survivorKillFailed()
    return { err, description: descriptionOf(err), survivor: { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: descriptionOf(err) } }
  }

  test.each<[string, ReadStep, KillRowFinishedRead]>([
    ['a read of ended', readState('ended'), KILL_ROW_FINISHED_ENDED],
    ['a read of missing', readState('missing'), KILL_ROW_FINISHED_MISSING],
    ['ErrSpawnNotFound at the read', cannedErr(errSpawnNotFound()), KILL_ROW_FINISHED_NO_ROW],
  ])('a survivor-naming first try, then %s: the success stands with no further kill, and the decision is the survivor version quoting that description', async (_label, read, finished) => {
    const { err, survivor } = survivorFirst()

    const r = await run({ kills: [cannedErr(err), ...failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill'))], reads: [read] })

    expect(r.calls).toEqual(['kill', 'status'])
    expect(r.result).toEqual({ outcome: rowFinished(finished), end: KILL_RETRY_END_ROW_FINISHED, tries: 1, reads: 1, alert: survivor })
  })

  const LATER_SUCCESSES: ReadonlyArray<readonly [string, CannedResponse<Phase1KillResult>, KillOutcome]> = [
    ['succeeding with kill_sent false', cannedOk(cannedKillResult(false)), { kind: KILL_OUTCOME_KILLED, killSent: false }],
    ['succeeding with kill_sent true', cannedOk(cannedKillResult(true)), { kind: KILL_OUTCOME_KILLED, killSent: true }],
  ]
  const READS_BEFORE: ReadonlyArray<readonly [string, ReadStep]> = [
    ['a read that found the row live', readState('waiting')],
    ['a read that failed', cannedErr(errCallTimeout('status'))],
  ]

  test.each([
    ...LATER_SUCCESSES.flatMap(([what, kill, outcome]) => READS_BEFORE.map(([before, read]) => [`${what}, after ${before}`, kill, read, outcome] as const)),
    ['answering ErrSpawnNotFound, after a read that found the row live', cannedErr<Phase1KillResult>(errSpawnNotFound()), readState('waiting'), { kind: KILL_OUTCOME_ROW_GONE } as KillOutcome] as const,
  ])('a survivor-naming first try, then a second try %s: that success stands, the decision is the survivor version quoting the survivor-naming description, and both tries are logged', async (_label, second, read, outcome) => {
    const { err, description, survivor } = survivorFirst()

    const r = await run({ kills: [cannedErr(err), second, ...failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill'))], reads: [read] })

    expect(r.calls).toEqual(['kill', 'status', 'kill'])
    expect(r.result).toEqual({ outcome, end: KILL_RETRY_END_SETTLED, tries: 2, reads: 1, alert: survivor })
    const tryLines = r.lines.filter((l) => /kill try \d+ of \d+/.test(l))
    expect(tryLines).toHaveLength(2)
    expect(tryLines[0]).toContain(JSON.stringify(description))
    expect(tryLines[1]).not.toContain(JSON.stringify(description))
  })

  test('a survivor-naming first try, then ErrTmuxUnresponsive twice: the ordinary decision quoting the survivor-naming description only; never the survivor version', async () => {
    const { err, description } = survivorFirst()

    const r = await run({ kills: [cannedErr(err), ...failing(2, () => errTmuxUnresponsive('kill'))] })

    expect(r.result.end).toBe(KILL_RETRY_END_EXHAUSTED)
    expect(r.result.alert).toEqual({ kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: description })
  })

  test.each<[string, () => Error, string]>([
    ['CONFLICT, kept as the outcome', () => errTmuxSessionConflict('kill', 'not-this-launch'), AD_ERROR_CLASS_CONFLICT],
    ['CONFIG, kept as the outcome', () => errConfigMalformed(), AD_ERROR_CLASS_CONFIG],
    ['ErrTmuxNotAvailable, kept as the outcome', () => errTmuxNotAvailable(undefined, 'kill'), AD_ERROR_CLASS_ENVIRONMENT],
  ])('a survivor-naming first try, then a second try answering %s: no third try; the ordinary decision quoting the survivor-naming description', async (_label, make, errorClass) => {
    const { err, description } = survivorFirst()
    const second = make()

    const r = await run({ kills: [cannedErr(err), cannedErr(second), ...failing(1, () => errTmuxUnresponsive('kill'))] })

    expect(r.calls).toEqual(['kill', 'status', 'kill'])
    expect(r.result.outcome).toEqual(notKilled(second))
    expect(r.result.outcome).toMatchObject({ errorClass })
    expect(r.result.alert).toEqual({ kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: description })
  })

  test.each<[string, Pick<RunSpec, 'keepGoing' | 'reads'>, KillRetryResult['end']]>([
    ['the keep-going check', { keepGoing: () => false }, KILL_RETRY_END_STOPPED],
    ['a read that latched the persona', { reads: [{ kind: KILL_RETRY_READ_LATCHED }] }, KILL_RETRY_END_READ_LATCHED],
  ])('a survivor-naming first try, then a stop by %s: no further kill; the survivor-naming failure stands, quoted as the ordinary decision\'s last description', async (_label, stop, end) => {
    const { err, description } = survivorFirst()

    const r = await run({ kills: [cannedErr(err), ...failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill'))], ...stop })

    expect(r.result.end).toBe(end)
    expect(r.result.tries).toBe(1)
    expect(r.result.outcome).toEqual(notKilled(err))
    expect(r.result.alert).toEqual({ kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: description })
  })

  // b.jg5 SRJ-704 (hatch A2): a status read between tries that latched P
  // after an ErrTmuxKillFailed naming no survivor leaves that failure as the
  // outcome, so the ordinary version quotes its description (T3 posts it with
  // the closing sentence for a latched persona).
  test('an ErrTmuxKillFailed naming no survivor, then a read that latched the persona: no further kill; the ordinary decision quoting that description alone', async () => {
    const first = plainKillFailed()

    const r = await run({ kills: [cannedErr(first), ...failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill'))], reads: [{ kind: KILL_RETRY_READ_LATCHED }] })

    expect(r.calls).toEqual(['kill', 'status'])
    expect(r.result).toEqual({
      outcome: notKilled(first),
      end: KILL_RETRY_END_READ_LATCHED,
      tries: 1,
      reads: 1,
      alert: { kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: descriptionOf(first) },
    })
    expect(killRetryStopped(r.result)).toBe(true)
  })

  test('a survivor-naming first try, then a plain ErrTmuxUnresponsive and a stop by the keep-going check: the ordinary decision quoting the survivor-naming description', async () => {
    const { err, description } = survivorFirst()
    let asks = 0

    const r = await run({ kills: [cannedErr(err), ...failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill'))], keepGoing: () => ++asks <= 2 })

    expect(r.result).toMatchObject({ end: KILL_RETRY_END_STOPPED, tries: 2 })
    expect(r.result.alert).toEqual({ kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: description })
  })

  test('a survivor-naming first try, then ErrTmuxKillFailed naming no survivor to the end: the ordinary decision quoting both descriptions', async () => {
    const { err, description } = survivorFirst()
    const last = plainKillFailed()

    const r = await run({ kills: [cannedErr(err), cannedErr(plainKillFailed()), cannedErr(last)] })

    expect(r.result.end).toBe(KILL_RETRY_END_EXHAUSTED)
    expect(r.result.alert).toEqual({ kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: descriptionOf(last), earlierSurvivorDescription: description })
  })

  test('two survivor-naming failures with different pids, then ErrTmuxUnresponsive: the latest survivor-naming description is quoted', async () => {
    const first = survivorKillFailed([4194401])
    const second = survivorKillFailed([4194402, 4194403])
    expect(descriptionOf(first)).not.toBe(descriptionOf(second))

    const r = await run({ kills: [cannedErr(first), cannedErr(second), cannedErr(errTmuxUnresponsive('kill'))] })

    expect(r.result.alert).toEqual({ kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: descriptionOf(second) })
  })

  test('two survivor-naming failures with different pids, then a read of ended: the survivor version quotes the latest', async () => {
    const second = survivorKillFailed([4194402])

    const r = await run({ kills: [cannedErr(survivorKillFailed([4194401])), cannedErr(second), ...failing(1, () => errTmuxUnresponsive('kill'))], reads: [readState('waiting'), readState('ended')] })

    expect(r.result.alert).toEqual({ kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: descriptionOf(second) })
  })

  test('survivor-naming failures to the end: the ordinary decision quotes the last one (itself survivor-naming) alone', async () => {
    const last = survivorKillFailed([4194409])

    const r = await run({ kills: [cannedErr(survivorKillFailed([4194401])), cannedErr(survivorKillFailed([4194402])), cannedErr(last)] })

    expect(r.result.alert).toEqual({ kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: descriptionOf(last) })
  })

  test('no survivor-naming failure: ErrTmuxKillFailed naming no survivor to the end gives the ordinary decision quoting its own description', async () => {
    const last = plainKillFailed()

    const r = await run({ kills: [...failing(KILL_RETRY_TRIES - 1, plainKillFailed), cannedErr(last)] })

    expect(r.result.alert).toEqual({ kind: KILL_RETRY_ALERT_ORDINARY, lastKillFailedDescription: descriptionOf(last) })
  })

  // b.jg5 SRJ-704: the ordinary version fires when the kill "still returns
  // ErrTmuxKillFailed" after the tries, or after a survivor-naming failure;
  // an earlier ErrTmuxKillFailed naming no survivor that a later UNAVAILABLE
  // outcome replaced calls for none (SRJ-1007 quotes the last outcome's).
  test('no survivor-naming failure: an ErrTmuxKillFailed naming no survivor, then ErrTmuxUnresponsive to the end: no alert decision', async () => {
    const r = await run({ kills: [cannedErr(plainKillFailed()), ...failing(KILL_RETRY_TRIES - 1, () => errTmuxUnresponsive('kill'))] })

    expect(r.result.end).toBe(KILL_RETRY_END_EXHAUSTED)
    expect(r.result.alert).toEqual({ kind: KILL_RETRY_ALERT_NONE })
  })

  test.each<[string, CannedResponse<Phase1KillResult>[]]>([
    ['at the first try', [cannedOk(cannedKillResult(false))]],
    ['after an ErrTmuxKillFailed naming no survivor', [cannedErr(plainKillFailed()), cannedOk(cannedKillResult(false))]],
  ])('b.jg5 SRJ-703: a success with kill_sent false %s and no survivor-naming failure gives no alert decision', async (_label, kills) => {
    const r = await run({ kills })

    expect(r.result.outcome).toEqual({ kind: KILL_OUTCOME_KILLED, killSent: false })
    expect(r.result.alert).toEqual({ kind: KILL_RETRY_ALERT_NONE })
  })
})

// ---------------------------------------------------------------------------
// A caller whose checked kill counts GONE as no success (goneIsFailure; the
// CLI's teardown, b.jg5 SRJ-904)
// ---------------------------------------------------------------------------

describe('runKillRetry over checked kills with goneIsFailure (b.jg5 SRJ-702, SRJ-904, SRJ-1007; hatch A3)', () => {
  const GONE_IS_FAILURE: CheckedKillOptions = { goneIsFailure: true }

  const GONE_ANSWERS: ReadonlyArray<readonly [string, () => Error]> = [
    ['ErrTmuxSendKeys', () => errTmuxSendKeys()],
    ['ErrTmuxCaptureFailed', () => errTmuxCaptureFailed(undefined, 'kill')],
  ]

  test.each(GONE_ANSWERS)('GONE (%s) at the first try: one kill, no read, no wait; the GONE non-success stands with no alert, logged as not tried again, with no end line', async (_label, make) => {
    const err = make()

    const r = await run({ kills: [cannedErr(err), ...failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill'))], killOptions: GONE_IS_FAILURE })

    const outcome = killOutcomeOf({ thrown: err }, GONE_IS_FAILURE)
    expect(outcome).toMatchObject({ kind: KILL_OUTCOME_NOT_KILLED, errorClass: AD_ERROR_CLASS_GONE })
    expect(r.calls).toEqual(['kill'])
    expect(r.delays).toEqual([])
    expect(r.result).toEqual({ outcome, end: KILL_RETRY_END_SETTLED, tries: 1, reads: 0, alert: { kind: KILL_RETRY_ALERT_NONE } })
    expect(r.lines).toEqual([killRetryTryLine(PREFIX, STUB_INSTANCE_ID, 1, KILL_RETRY_TRIES, outcome, KILL_RETRY_NEXT_NOT_RETRIED)])
  })

  // The same answers with no options (every server site): GONE is the session-gone success.
  test.each(GONE_ANSWERS.flatMap(([label, make]) => [
    [label, 'with goneIsFailure', make, GONE_IS_FAILURE] as const,
    [label, 'with no options (the server default)', make, undefined] as const,
  ]))('a survivor-naming first try, then GONE (%s) at the 2nd try %s: no third try; the decision and the end line follow that outcome', async (_label, _how, make, killOptions) => {
    const first = survivorKillFailed()
    const err = make()

    const r = await run({ kills: [cannedErr(first), cannedErr(err), ...failing(1, () => errTmuxUnresponsive('kill'))], ...(killOptions === undefined ? {} : { killOptions }) })

    const outcome = killOptions === undefined ? killOutcomeOf({ thrown: err }) : killOutcomeOf({ thrown: err }, killOptions)
    const alert: KillRetryAlert = killOptions === undefined
      ? { kind: KILL_RETRY_ALERT_SURVIVOR, survivorDescription: descriptionOf(first) }
      : { kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: descriptionOf(first) }
    expect(outcome.kind).toBe(killOptions === undefined ? KILL_OUTCOME_SESSION_GONE : KILL_OUTCOME_NOT_KILLED)
    expect(r.calls).toEqual(['kill', 'status', 'kill'])
    expect(r.result).toEqual({ outcome, end: KILL_RETRY_END_SETTLED, tries: 2, reads: 1, alert })
    const next = killOptions === undefined ? KILL_RETRY_NEXT_SUCCESS : KILL_RETRY_NEXT_NOT_RETRIED
    expect(r.lines.slice(-2)).toEqual([
      killRetryTryLine(PREFIX, STUB_INSTANCE_ID, 2, KILL_RETRY_TRIES, outcome, next),
      killRetryEndLine(PREFIX, STUB_INSTANCE_ID, r.result),
    ])
  })
})

// ---------------------------------------------------------------------------
// The start sweep's pass budget (AC 56)
// ---------------------------------------------------------------------------

describe('runKillRetry: the pass budget (b.jg5 SRJ-702, AC 56)', () => {
  test('a kill that uses its tries on UNAVAILABLE spends the budget; a later kill with it makes one try, no read and no wait', async () => {
    const budget = createKillRetryPassBudget()
    expect(budget.isSpent()).toBe(false)

    const first = await run({ kills: failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill')), budget })
    expect(first.result.tries).toBe(KILL_RETRY_TRIES)
    expect(budget.isSpent()).toBe(true)

    const later = errTmuxUnresponsive('kill')
    const second = await run({ kills: [cannedErr(later), ...failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill'))], budget })

    expect(second.calls).toEqual(['kill'])
    expect(second.delays).toEqual([])
    expect(second.result).toEqual({ outcome: notKilled(later), end: KILL_RETRY_END_BUDGET_SPENT, tries: 1, reads: 0, alert: { kind: KILL_RETRY_ALERT_NONE } })
  })

  test('a spent budget still lets a later kill succeed on its one try', async () => {
    const budget = createKillRetryPassBudget()
    budget.spend()

    const r = await run({ kills: [cannedOk(cannedKillResult(true))], budget })

    expect(r.result).toMatchObject({ outcome: { kind: KILL_OUTCOME_KILLED, killSent: true }, end: KILL_RETRY_END_SETTLED, tries: 1 })
  })

  test.each<[string, RunSpec['kills'], ReadStep[]]>([
    ['a success on a retry', [cannedErr(errTmuxUnresponsive('kill')), cannedOk(cannedKillResult(true))], []],
    ['a non-UNAVAILABLE outcome (CONFLICT) at the first try', [cannedErr(errTmuxSessionConflict('kill', 'not-this-launch'))], []],
    ['ErrTmuxNotAvailable after an UNAVAILABLE try', [cannedErr(errTmuxUnresponsive('kill')), cannedErr(errTmuxNotAvailable(undefined, 'kill'))], []],
    ['a read that found the row finished', failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill')), [readState('ended')]],
  ])('%s leaves the budget unspent', async (_label, kills, reads) => {
    const budget = createKillRetryPassBudget()

    await run({ kills, reads, budget })

    expect(budget.isSpent()).toBe(false)
  })

  test('a kill of a row not last read live spends no budget, and a fresh budget is independent of a spent one', async () => {
    const budget = createKillRetryPassBudget()

    await run({ kills: [cannedErr(errTmuxUnresponsive('kill'))], lastRead: KILL_RETRY_SEED_NOT_LIVE_VALUE, budget })

    expect(budget.isSpent()).toBe(false)
    const other = createKillRetryPassBudget()
    other.spend()
    expect(budget.isSpent()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Log lines (SRJ-1014)
// ---------------------------------------------------------------------------

describe('runKillRetry: each try and each read is logged, redacted (b.jg5 SRJ-702, SRJ-1014)', () => {
  test('one line per try naming its answer, and one per read; every line carries the prefix and the instance id', async () => {
    const r = await run({ kills: failing(KILL_RETRY_TRIES, () => errTmuxUnresponsive('kill')), reads: [readState('waiting'), cannedErr(errCallTimeout('status'))] })

    const tryLines = r.lines.filter((l) => /kill try \d+ of \d+/.test(l))
    const readLines = r.lines.filter((l) => l.includes('status read before kill try'))
    expect(tryLines).toHaveLength(KILL_RETRY_TRIES)
    expect(readLines).toHaveLength(KILL_RETRY_TRIES - 1)
    for (const line of tryLines) expect(line).toContain(errTmuxUnresponsive('kill').errName)
    expect(readLines[0]).toContain('waiting')
    expect(readLines[1]).toContain(errCallTimeout('status').errName)
    for (const line of r.lines) {
      expect(line.startsWith(`${PREFIX}: `)).toBe(true)
      expect(line).toContain(STUB_INSTANCE_ID)
      expect(line).not.toMatch(/[\r\n]/)
    }
  })

  test('a fake token in a try\'s description (through the stub builder\'s session name) and in a read\'s failure comes out redacted', async () => {
    const token = fakeToken(BOT_TOKEN_PREFIX, 'kill-retry')
    const survivor = errTmuxKillFailed(token, 'pane-process-survived')

    const r = await run({
      kills: [cannedErr(survivor), ...failing(KILL_RETRY_TRIES - 1, () => errTmuxUnresponsive('kill'))],
      reads: [cannedErr(errInternal(`the store could not be read (${sentinelInMessage('kill-retry-read')})`))],
    })

    const tryLines = r.lines.filter((l) => /kill try 1 of \d+/.test(l))
    expect(tryLines).toHaveLength(1)
    expect(tryLines[0]).toContain(REDACTED_TOKEN_PLACEHOLDER)
    expect(r.lines.filter((l) => l.includes('status read before kill try'))[0]).toContain(REDACTED_SENTINEL_TAIL)
    // The decision quotes the raw description for T3 to redact at its post.
    expect(r.result.alert).toEqual({ kind: KILL_RETRY_ALERT_ORDINARY, earlierSurvivorDescription: descriptionOf(survivor) })
    assertNoLeak(r.lines)
  })
})

// ---------------------------------------------------------------------------
// Import boundary: no server-only module (E21, E25 to E33 and the CLI reuse it)
// ---------------------------------------------------------------------------

describe('kill-retry: import boundary', () => {
  test('the module loads, through its runtime imports in src/, no server-only module, no Slack module and no @slack/ package', () => {
    const { loads, forbidden } = forbiddenServerLoads('kill-retry.ts')
    // Not vacuous: the walk reaches the checked kill and the one survivor detector.
    expect(loads.modules.has('checked-kill.ts')).toBe(true)
    expect(loads.modules.has('ad-description-phrases.ts')).toBe(true)
    expect(forbidden).toEqual([])
  })
})
