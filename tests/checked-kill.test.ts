/**
 * checked-kill.test.ts — a kill's outcome, its class under b.jg5 SRJ-110,
 * whether the caller's next step may run, the one checked kill and its log
 * rendering (`src/checked-kill.ts`; b.jg5 SRJ-110, SRJ-701, SRJ-703).
 *
 * Every kill goes through the stub client's `kill` (its result, error and
 * queue members and `cannedKillResult`), every error is built by name with
 * the stub's builders (a DIRECTORY value, which the stub has no builder for,
 * with `new` on the client's own class), and every class and outcome label is
 * imported from `src/`. Only a success (`kill_sent` true, false or absent),
 * `ErrSpawnNotFound` and GONE (SRJ-104: for `kill`, gone is success) pass the
 * predicate, GONE only with no options (every server site); under
 * `goneIsFailure` (the CLI's teardown, SRJ-904) GONE is the GONE non-success
 * and every other answer gives the same outcome as with no options; each
 * value of HO C2's non-success list, the unusable-name value,
 * `ErrConfigMalformed`, a value that is not an agent-director error and a
 * value of a class SRJ-110 has no kill row for (UNCLASSIFIED, its class kept
 * as `unlistedClass`) keep their thrown value and their class. The
 * module's import boundary is checked by walking its runtime imports through
 * `src/` (`forbiddenServerLoads`, `tests/test-helpers/source-audit.ts`).
 * The two notices built from a kill's outcome where nothing latches on it
 * (a CONFLICT or UNUSABLE NAME refusal, and a non-success no other notice
 * records; b.jg5 SRJ-1003, SRJ-110) are pinned here once; their routing is
 * tests/persona-lifecycle.test.ts's.
 *
 * No process, no real timer, no top-level mock.module(), no value import of
 * `Client` or `resolveSystemBinary`, no Phase-1-only named import.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import {
  AD_ERROR_CLASS_CONFIG,
  AD_ERROR_CLASS_CONFLICT,
  AD_ERROR_CLASS_DIRECTORY,
  AD_ERROR_CLASS_ENVIRONMENT,
  AD_ERROR_CLASS_GONE,
  AD_ERROR_CLASS_LAUNCH_FAILURE,
  AD_ERROR_CLASS_STATE,
  AD_ERROR_CLASS_UNAVAILABLE,
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  classifyAdError,
  type AdErrorClass,
} from '../src/ad-error-class.ts'
import {
  RECHECK_OUTCOME_COULD_NOT_RUN,
  RECHECK_OUTCOME_PASS,
  RECHECK_OUTCOME_STOP,
} from '../src/ad-version-gate.ts'
import { ERR_TMUX_KILL_FAILED_NAME, ErrCwdNotADirectory, ErrCwdNotFound } from '../src/agent-director-errors.ts'
import {
  KILL_FAILURE_CLASSES,
  KILL_OUTCOME_KILLED,
  KILL_OUTCOME_NOT_KILLED,
  KILL_OUTCOME_ROW_FINISHED,
  KILL_OUTCOME_ROW_GONE,
  KILL_OUTCOME_SESSION_GONE,
  KILL_REFUSAL_AT_KILL,
  KILL_REFUSAL_AT_READ,
  KILL_ROW_FINISHED_ENDED,
  KILL_ROW_FINISHED_HOLD_ENDED,
  KILL_ROW_FINISHED_MISSING,
  KILL_ROW_FINISHED_NO_ROW,
  KILL_UNLISTED_CLASSES,
  checkedKill,
  describeKillOutcome,
  isKillOutcome,
  killLetsNextStepRun,
  killOutcomeOf,
  killOutcomeStopsServer,
  teardownKillNotSucceededNoticeText,
  teardownKillRefusalNoticeText,
  type AnyKillOutcome,
  type CheckedKillOptions,
  type KillFailure,
  type KillOutcome,
  type KillRecheckKind,
  type KillRowFinishedRead,
  type KillUnlistedClass,
} from '../src/checked-kill.ts'
import { REDACTED_TOKEN_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import {
  CONFLICT_CASES,
  KILL_FAILED_DESCRIPTIONS,
  STUB_INSTANCE_ID,
  UNUSABLE_NAME_FAULTS,
  cannedErr,
  cannedKillResult,
  cannedOk,
  errCallTimeout,
  errConfigMalformed,
  errInternal,
  errInvalidFlags,
  errSpawnNotFound,
  errSpawnNotResumable,
  errSystemInstallDisappeared,
  errInstanceIdCollision,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  errTmuxNotAvailable,
  errTmuxSendKeys,
  errTmuxSessionConflict,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  errUnknownErrorName,
  errUnusableName,
  makeStubClient,
  type StubClientOptions,
} from './test-helpers/agent-director-stub.ts'
import {
  BOT_TOKEN_PREFIX,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
import { forbiddenServerLoads } from './test-helpers/source-audit.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One checked kill of `STUB_INSTANCE_ID` through a stub client scripted by `opts`, with the recorded kill calls. */
async function killThroughStub(opts: StubClientOptions): Promise<{ outcome: KillOutcome; calls: unknown[] }> {
  const calls: unknown[] = []
  const client = makeStubClient({ ...opts, killCalls: calls as NonNullable<StubClientOptions['killCalls']> })
  const outcome = await checkedKill(STUB_INSTANCE_ID, (params) => client.kill(params))
  return { outcome, calls }
}

/** The same checked kill under `options`, with the recorded kill calls. */
async function killThroughStubWith(opts: StubClientOptions, options: CheckedKillOptions): Promise<{ outcome: AnyKillOutcome; calls: unknown[] }> {
  const calls: unknown[] = []
  const client = makeStubClient({ ...opts, killCalls: calls as NonNullable<StubClientOptions['killCalls']> })
  const outcome = await checkedKill(STUB_INSTANCE_ID, (params) => client.kill(params), options)
  return { outcome, calls }
}

/** The CLI teardown's rule: a GONE answer is no success (b.jg5 SRJ-904). */
const GONE_IS_FAILURE: CheckedKillOptions = { goneIsFailure: true }

/** A DIRECTORY value the stub has no builder for, built with `new` on the client's own class, its `errName` the class name. */
function errCwd(Cls: typeof ErrCwdNotFound | typeof ErrCwdNotADirectory): Error {
  return new Cls('kill', Cls.name, 'the working directory is gone')
}

/** The one call every checked kill makes: the instance id alone, no `include_finished` (SRJ-106). */
const PLAIN_KILL_CALL = { claude_instance_id: STUB_INSTANCE_ID }

/**
 * A non-success row: its label, the value the kill throws, the SRJ-110 class
 * it must carry and, for a value of a class SRJ-110 has no kill row for, that
 * class (kept as `unlistedClass`).
 */
type NonSuccessRow = readonly [label: string, build: () => unknown, expected: AdErrorClass, unlistedClass?: KillUnlistedClass]

/**
 * HO C2's non-success list (SRJ-110's Test line), each built by name, plus the
 * unusable-name value, `ErrConfigMalformed`, a value that is not an
 * agent-director error, and values of a class SRJ-110 gives no row
 * (UNCLASSIFIED: no step follows).
 */
const NON_SUCCESS_ROWS: readonly NonSuccessRow[] = [
  ...KILL_FAILED_DESCRIPTIONS.map((d): NonSuccessRow => [`errTmuxKillFailed (${d})`, () => errTmuxKillFailed(undefined, d), AD_ERROR_CLASS_UNAVAILABLE]),
  ['errTmuxUnresponsive', () => errTmuxUnresponsive('kill'), AD_ERROR_CLASS_UNAVAILABLE],
  ...CONFLICT_CASES.map((c): NonSuccessRow => [`errTmuxSessionConflict (${c})`, () => errTmuxSessionConflict('kill', c), AD_ERROR_CLASS_CONFLICT]),
  ['errTmuxNotAvailable', () => errTmuxNotAvailable(undefined, 'kill'), AD_ERROR_CLASS_ENVIRONMENT],
  ['errInternal', () => errInternal(), AD_ERROR_CLASS_UNCLASSIFIED],
  ['errUnknownErrorName', () => errUnknownErrorName(), AD_ERROR_CLASS_UNAVAILABLE],
  ['errCallTimeout', () => errCallTimeout('kill'), AD_ERROR_CLASS_UNAVAILABLE],
  ...UNUSABLE_NAME_FAULTS.map((f): NonSuccessRow => [`errUnusableName (${f})`, () => errUnusableName(f), AD_ERROR_CLASS_UNUSABLE_NAME]),
  ['errConfigMalformed', () => errConfigMalformed(), AD_ERROR_CLASS_CONFIG],
  ['a plain Error (not an agent-director error)', () => new Error('boom'), AD_ERROR_CLASS_UNAVAILABLE],
  ['errSystemInstallDisappeared', () => errSystemInstallDisappeared('kill'), AD_ERROR_CLASS_UNCLASSIFIED],
  ['errTmuxSessionCreate (LAUNCH FAILURE: no SRJ-110 row)', () => errTmuxSessionCreate('kill'), AD_ERROR_CLASS_UNCLASSIFIED, AD_ERROR_CLASS_LAUNCH_FAILURE],
  ['errSpawnNotResumable (a STATE name other than ErrSpawnNotFound)', () => errSpawnNotResumable(), AD_ERROR_CLASS_UNCLASSIFIED, AD_ERROR_CLASS_STATE],
  ['errInstanceIdCollision (a STATE name other than ErrSpawnNotFound)', () => errInstanceIdCollision(), AD_ERROR_CLASS_UNCLASSIFIED, AD_ERROR_CLASS_STATE],
  ['errInvalidFlags (a STATE name other than ErrSpawnNotFound)', () => errInvalidFlags('kill'), AD_ERROR_CLASS_UNCLASSIFIED, AD_ERROR_CLASS_STATE],
  ['ErrCwdNotFound (DIRECTORY: no SRJ-110 row)', () => errCwd(ErrCwdNotFound), AD_ERROR_CLASS_UNCLASSIFIED, AD_ERROR_CLASS_DIRECTORY],
  ['ErrCwdNotADirectory (DIRECTORY: no SRJ-110 row)', () => errCwd(ErrCwdNotADirectory), AD_ERROR_CLASS_UNCLASSIFIED, AD_ERROR_CLASS_DIRECTORY],
]

/** The GONE values (SRJ-104: for `kill`, gone is success), each built by name with the stub. */
const GONE_ROWS: readonly (readonly [label: string, build: () => Error & { errName: string }])[] = [
  ['errTmuxSendKeys', () => errTmuxSendKeys()],
  ['errTmuxCaptureFailed', () => errTmuxCaptureFailed(undefined, 'kill')],
]

/** The success forms, one per `kill_sent` (absent included). */
const KILL_SENT_VALUES: readonly (boolean | undefined)[] = [true, false, undefined]

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

describe('checkedKill: success (SRJ-110, SRJ-703)', () => {
  test.each(KILL_SENT_VALUES.map((v) => [String(v), v] as const))(
    'a kill result with kill_sent %s is the killed success carrying kill_sent as given, and lets the next step run',
    async (_label, killSent) => {
      const { outcome, calls } = await killThroughStub({ killResult: cannedKillResult(killSent) })
      expect(outcome).toEqual(killSent === undefined ? { kind: KILL_OUTCOME_KILLED } : { kind: KILL_OUTCOME_KILLED, killSent })
      // Absent stays absent: no key, not a key holding undefined.
      expect('killSent' in outcome).toBe(killSent !== undefined)
      expect(killLetsNextStepRun(outcome)).toBe(true)
      expect(isKillOutcome(outcome)).toBe(true)
      expect(calls).toEqual([PLAIN_KILL_CALL])
    },
  )

  test('ErrSpawnNotFound is the row-gone success and lets the next step run', async () => {
    const { outcome, calls } = await killThroughStub({ killError: errSpawnNotFound() })
    expect(outcome).toEqual({ kind: KILL_OUTCOME_ROW_GONE })
    expect(killLetsNextStepRun(outcome)).toBe(true)
    expect(calls).toEqual([PLAIN_KILL_CALL])
  })

  test.each<[string, unknown]>([
    ['a kill_sent that is not a boolean', { kill_sent: 'yes' }],
    ['null', null],
    ['a kill_sent getter that throws', Object.defineProperty({}, 'kill_sent', { get: () => { throw new Error('boom') }, enumerable: true })],
  ])('a resolved kill whose result is %s is a success with kill_sent absent', (_label, result) => {
    const outcome = killOutcomeOf({ result })
    expect(outcome).toEqual({ kind: KILL_OUTCOME_KILLED })
    expect(killLetsNextStepRun(outcome)).toBe(true)
  })

  test.each(GONE_ROWS.map(([label, build]) => [label, build] as const))(
    'b.jg5 SRJ-104, SRJ-110: %s (GONE) at a kill is the session-gone success carrying its name, and lets the next step run',
    async (_label, build) => {
      const thrown = build()
      // Precondition: the classifier gives it GONE, by name.
      expect(classifyAdError(thrown).errorClass).toBe(AD_ERROR_CLASS_GONE)
      const { outcome, calls } = await killThroughStub({ killError: thrown })
      expect(outcome).toEqual({ kind: KILL_OUTCOME_SESSION_GONE, name: thrown.errName })
      expect(killLetsNextStepRun(outcome)).toBe(true)
      expect(isKillOutcome(outcome)).toBe(true)
      expect(killOutcomeStopsServer(outcome)).toBe(false)
      expect(calls).toEqual([PLAIN_KILL_CALL])
    },
  )

  // KILL_ROW_FINISHED_HOLD_ENDED: an old-life wait's kill whose hold ended while its tries ran (b.jg5 SRJ-702, SRJ-811; option A).
  test.each<KillRowFinishedRead>([KILL_ROW_FINISHED_ENDED, KILL_ROW_FINISHED_MISSING, KILL_ROW_FINISHED_NO_ROW, KILL_ROW_FINISHED_HOLD_ENDED])(
    'the row-finished success (read %s) lets the next step run',
    (read) => {
      const outcome: KillOutcome = { kind: KILL_OUTCOME_ROW_FINISHED, read }
      expect(killLetsNextStepRun(outcome)).toBe(true)
      expect(isKillOutcome(outcome)).toBe(true)
    },
  )
})

// ---------------------------------------------------------------------------
// Non-success
// ---------------------------------------------------------------------------

describe('checkedKill: non-success (SRJ-110, SRJ-701)', () => {
  test('KILL_FAILURE_CLASSES is SRJ-110\'s six non-success classes', () => {
    expect(new Set(KILL_FAILURE_CLASSES)).toEqual(new Set([
      AD_ERROR_CLASS_UNAVAILABLE,
      AD_ERROR_CLASS_CONFLICT,
      AD_ERROR_CLASS_UNUSABLE_NAME,
      AD_ERROR_CLASS_CONFIG,
      AD_ERROR_CLASS_ENVIRONMENT,
      AD_ERROR_CLASS_UNCLASSIFIED,
    ]))
  })

  test.each(NON_SUCCESS_ROWS.map(([label, build, expected, unlistedClass]) => [label, expected, build, unlistedClass] as const))(
    '%s is not-killed with class %s, keeps the thrown value and never lets the next step run',
    async (_label, expected, build, unlistedClass) => {
      const thrown = build()
      const { outcome, calls } = await killThroughStub({ killError: thrown as Error })
      expect(outcome.kind).toBe(KILL_OUTCOME_NOT_KILLED)
      if (outcome.kind !== KILL_OUTCOME_NOT_KILLED) return
      expect(outcome.errorClass as AdErrorClass).toBe(expected)
      expect(outcome.error).toBe(thrown)
      expect(killLetsNextStepRun(outcome)).toBe(false)
      expect(isKillOutcome(outcome)).toBe(true)
      expect(calls).toEqual([PLAIN_KILL_CALL])
      // The class is the classifier's, by name, wherever SRJ-110 has a row for it.
      const classified = classifyAdError(thrown).errorClass
      if ((KILL_FAILURE_CLASSES as readonly string[]).includes(classified)) expect(outcome.errorClass as AdErrorClass).toBe(classified)
      // A class SRJ-110 has no row for (b.jg5 SRJ-104, SRJ-110) is UNCLASSIFIED
      // with that class kept as `unlistedClass`, and nothing else; every other
      // value carries none.
      expect('unlistedClass' in outcome ? outcome.unlistedClass : undefined).toBe(unlistedClass)
      if (unlistedClass !== undefined) expect(outcome).toEqual({ kind: KILL_OUTCOME_NOT_KILLED, errorClass: AD_ERROR_CLASS_UNCLASSIFIED, error: thrown, unlistedClass })
      // No re-check is made here (the caller's), and no stop is decided.
      expect('recheck' in outcome).toBe(false)
      expect(killOutcomeStopsServer(outcome)).toBe(false)
    },
  )

  test('KILL_UNLISTED_CLASSES is the three classes SRJ-110 has no kill row for (SRJ-104, SRJ-110)', () => {
    expect(new Set(KILL_UNLISTED_CLASSES)).toEqual(new Set([AD_ERROR_CLASS_LAUNCH_FAILURE, AD_ERROR_CLASS_STATE, AD_ERROR_CLASS_DIRECTORY]))
  })

  test.each([...KILL_FAILED_DESCRIPTIONS])('errTmuxKillFailed (%s) is told apart and carries its own description, read from the value', async (d) => {
    const thrown = errTmuxKillFailed(undefined, d)
    const { outcome } = await killThroughStub({ killError: thrown })
    expect(outcome).toEqual({
      kind: KILL_OUTCOME_NOT_KILLED,
      errorClass: AD_ERROR_CLASS_UNAVAILABLE,
      error: thrown,
      killFailed: true,
      killFailedDescription: thrown.errDescription,
    })
  })

  test('an ErrUnknownErrorName carrying the ErrTmuxKillFailed name is told apart with its envelope description', () => {
    const description = errTmuxKillFailed(undefined, 'no-session-no-kill').errDescription
    const thrown = errUnknownErrorName(ERR_TMUX_KILL_FAILED_NAME, description)
    expect(killOutcomeOf({ thrown })).toEqual({
      kind: KILL_OUTCOME_NOT_KILLED,
      errorClass: AD_ERROR_CLASS_UNAVAILABLE,
      error: thrown,
      killFailed: true,
      killFailedDescription: description,
    })
  })

  test('any other UNAVAILABLE value is not told apart as a kill failure and carries no description', () => {
    const thrown = errTmuxUnresponsive('kill')
    expect(killOutcomeOf({ thrown })).toEqual({
      kind: KILL_OUTCOME_NOT_KILLED,
      errorClass: AD_ERROR_CLASS_UNAVAILABLE,
      error: thrown,
      killFailed: false,
    })
  })
})

// ---------------------------------------------------------------------------
// One call, never throws, never retries
// ---------------------------------------------------------------------------

describe('checkedKill: one plain call that never throws (SRJ-106, SRJ-701)', () => {
  test('a failed kill is not retried: the queue\'s later success is never reached', async () => {
    const { outcome, calls } = await killThroughStub({
      killQueue: [cannedErr(errTmuxUnresponsive('kill')), cannedOk(cannedKillResult(true))],
    })
    expect(calls).toEqual([PLAIN_KILL_CALL])
    expect(killLetsNextStepRun(outcome)).toBe(false)
  })

  test('the recorded call carries the instance id alone: no include_finished key at all', async () => {
    const { calls } = await killThroughStub({ killResult: cannedKillResult(true) })
    expect(calls).toHaveLength(1)
    expect(Object.keys(calls[0] as object)).toEqual(['claude_instance_id'])
  })

  test.each<[string, () => Promise<unknown>]>([
    ['throws synchronously', () => { throw errTmuxUnresponsive('kill') }],
    ['throws a value whose every read throws', () => { throw new Proxy({}, { get: () => { throw new Error('boom') }, getPrototypeOf: () => { throw new Error('boom') } }) }],
    ['rejects with undefined', () => Promise.reject(undefined)],
  ])('a kill call that %s gives a not-killed outcome; checkedKill neither throws nor rejects', async (_label, kill) => {
    let calls = 0
    const outcome = await checkedKill(STUB_INSTANCE_ID, () => {
      calls += 1
      return kill()
    })
    expect(calls).toBe(1)
    expect(outcome.kind).toBe(KILL_OUTCOME_NOT_KILLED)
    expect(killLetsNextStepRun(outcome)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A caller's rule: GONE is no success (the CLI's teardown; b.jg5 SRJ-904)
// ---------------------------------------------------------------------------

describe('checkedKill with goneIsFailure (b.jg5 SRJ-904, SRJ-110; hatch A3)', () => {
  test.each(GONE_ROWS.map(([label, build]) => [label, build] as const))(
    '%s (GONE) is the GONE non-success carrying the thrown value and its name, and never lets the next step run',
    async (_label, build) => {
      const thrown = build()
      const { outcome, calls } = await killThroughStubWith({ killError: thrown }, GONE_IS_FAILURE)
      expect(outcome).toEqual({ kind: KILL_OUTCOME_NOT_KILLED, errorClass: AD_ERROR_CLASS_GONE, error: thrown, name: thrown.errName })
      if (outcome.kind === KILL_OUTCOME_NOT_KILLED) expect(outcome.error).toBe(thrown)
      expect(killLetsNextStepRun(outcome)).toBe(false)
      expect(isKillOutcome(outcome)).toBe(true)
      expect(killOutcomeStopsServer(outcome)).toBe(false)
      expect(calls).toEqual([PLAIN_KILL_CALL])
    },
  )

  // The server's sites pass no options: GONE stays the session-gone success there.
  test.each(GONE_ROWS.flatMap(([label, build]) => ([
    ['no options', undefined],
    ['empty options', {}],
    ['goneIsFailure false', { goneIsFailure: false }],
  ] as const).map(([how, options]) => [label, how, build, options] as const)))(
    '%s (GONE) with %s is the session-gone success, exactly as with no options',
    async (_label, _how, build, options) => {
      const thrown = build()
      const { outcome } = options === undefined ? await killThroughStub({ killError: thrown }) : await killThroughStubWith({ killError: thrown }, options)
      expect(outcome).toEqual({ kind: KILL_OUTCOME_SESSION_GONE, name: thrown.errName })
      expect(killLetsNextStepRun(outcome)).toBe(true)
    },
  )

  test.each<[string, StubClientOptions]>([
    ...KILL_SENT_VALUES.map((v): [string, StubClientOptions] => [`a kill result with kill_sent ${String(v)}`, { killResult: cannedKillResult(v) }]),
    ['ErrSpawnNotFound', { killError: errSpawnNotFound() }],
    ...NON_SUCCESS_ROWS.map(([label, build]): [string, StubClientOptions] => [label, { killError: build() as Error }]),
  ])('%s: the same outcome with and without goneIsFailure', async (_label, opts) => {
    const [withOption, without] = await Promise.all([killThroughStubWith(opts, GONE_IS_FAILURE), killThroughStub(opts)])
    expect(withOption.outcome).toEqual(without.outcome)
    expect(withOption.calls).toEqual([PLAIN_KILL_CALL])
  })
})

// ---------------------------------------------------------------------------
// The predicate on answers that are not outcomes
// ---------------------------------------------------------------------------

describe('killOutcomeStopsServer (b.jg5 SRJ-204, SRJ-205)', () => {
  const invalidFlags = (): KillOutcome => killOutcomeOf({ thrown: errInvalidFlags('kill') })

  test.each<[KillRecheckKind, boolean]>([
    [RECHECK_OUTCOME_STOP, true],
    [RECHECK_OUTCOME_PASS, false],
    [RECHECK_OUTCOME_COULD_NOT_RUN, false],
  ])('an ErrInvalidFlags non-success whose re-check answered %s: stops the server %p', (recheck, stops) => {
    expect(killOutcomeStopsServer({ ...invalidFlags(), recheck } as KillOutcome)).toBe(stops)
  })

  test.each<[string, unknown]>([
    ['an ErrInvalidFlags non-success with no re-check', killOutcomeOf({ thrown: errInvalidFlags('kill') })],
    ['a success carrying a stop recheck key', { kind: KILL_OUTCOME_KILLED, recheck: RECHECK_OUTCOME_STOP }],
    ['undefined', undefined],
    ['a recheck getter that throws', Object.defineProperty({ kind: KILL_OUTCOME_NOT_KILLED }, 'recheck', { get: () => { throw new Error('boom') } })],
    ['a proxy whose every trap throws', new Proxy({}, { get: () => { throw new Error('boom') } })],
  ])('%s: never stops the server, and nothing throws', (_label, value) => {
    expect(() => killOutcomeStopsServer(value)).not.toThrow()
    expect(killOutcomeStopsServer(value)).toBe(false)
  })
})

describe('killLetsNextStepRun and isKillOutcome: an answer that is not an outcome', () => {
  test.each<[string, unknown, boolean]>([
    ['undefined', undefined, false],
    ['null', null, false],
    ['the success kind as a bare string', KILL_OUTCOME_KILLED, false],
    ['an object of an unknown kind', { kind: `${KILL_OUTCOME_KILLED}-not` }, false],
    ['a kind getter that throws', Object.defineProperty({}, 'kind', { get: () => { throw new Error('boom') } }), false],
    ['a proxy whose every trap throws', new Proxy({}, { get: () => { throw new Error('boom') }, getPrototypeOf: () => { throw new Error('boom') } }), false],
    ['a bare not-killed kind', { kind: KILL_OUTCOME_NOT_KILLED }, true],
  ])('%s: never lets the next step run; is an outcome only when its kind is one (%p)', (_label, value, isOutcome) => {
    expect(() => killLetsNextStepRun(value)).not.toThrow()
    expect(killLetsNextStepRun(value)).toBe(false)
    expect(isKillOutcome(value)).toBe(isOutcome)
  })
})

// ---------------------------------------------------------------------------
// Log rendering (SRJ-701, SRJ-1014)
// ---------------------------------------------------------------------------

describe('describeKillOutcome', () => {
  test('pin: each form\'s one line', () => {
    const killFailed = errTmuxKillFailed(undefined, 'outlived-exit-wait')
    const unresponsive = errTmuxUnresponsive('kill')
    const unusable = errUnusableName('empty')
    expect(KILL_SENT_VALUES.map((v) => describeKillOutcome(killOutcomeOf({ result: cannedKillResult(v) })))).toEqual([
      `outcome=${KILL_OUTCOME_KILLED} kill_sent=true`,
      `outcome=${KILL_OUTCOME_KILLED} kill_sent=false`,
      `outcome=${KILL_OUTCOME_KILLED} kill_sent=absent`,
    ])
    expect(describeKillOutcome({ kind: KILL_OUTCOME_ROW_GONE })).toBe(`outcome=${KILL_OUTCOME_ROW_GONE} (ErrSpawnNotFound)`)
    expect(describeKillOutcome(killOutcomeOf({ thrown: errTmuxSendKeys() }))).toBe(`outcome=${KILL_OUTCOME_SESSION_GONE} (${errTmuxSendKeys().errName})`)
    expect(describeKillOutcome(killOutcomeOf({ thrown: errTmuxCaptureFailed() }))).toBe(
      `outcome=${KILL_OUTCOME_SESSION_GONE} (${errTmuxCaptureFailed().errName})`,
    )
    expect(describeKillOutcome({ kind: KILL_OUTCOME_SESSION_GONE })).toBe(`outcome=${KILL_OUTCOME_SESSION_GONE}`)
    expect(describeKillOutcome({ kind: KILL_OUTCOME_SESSION_GONE, name: 'NotAGoneName' })).toBe(`outcome=${KILL_OUTCOME_SESSION_GONE}`)
    const sendKeys = errTmuxSendKeys()
    expect(describeKillOutcome(killOutcomeOf({ thrown: sendKeys }, GONE_IS_FAILURE))).toBe(
      `outcome=${KILL_OUTCOME_NOT_KILLED} class=${AD_ERROR_CLASS_GONE} ${sendKeys.errName} message=${JSON.stringify(sendKeys.errDescription)}`,
    )
    const collision = errInstanceIdCollision()
    const unlisted = killOutcomeOf({ thrown: collision })
    expect(describeKillOutcome(unlisted)).toBe(
      `outcome=${KILL_OUTCOME_NOT_KILLED} class=${AD_ERROR_CLASS_UNCLASSIFIED} from=${AD_ERROR_CLASS_STATE} ${collision.errName} message=${JSON.stringify(collision.errDescription)}`,
    )
    const invalid = errInvalidFlags('kill')
    expect(describeKillOutcome({ ...killOutcomeOf({ thrown: invalid }), recheck: RECHECK_OUTCOME_STOP } as KillOutcome)).toBe(
      `outcome=${KILL_OUTCOME_NOT_KILLED} class=${AD_ERROR_CLASS_UNCLASSIFIED} from=${AD_ERROR_CLASS_STATE} ${invalid.errName} message=${JSON.stringify(invalid.errDescription)} recheck=${RECHECK_OUTCOME_STOP}`,
    )
    expect(describeKillOutcome({ kind: KILL_OUTCOME_ROW_FINISHED, read: KILL_ROW_FINISHED_MISSING })).toBe(
      `outcome=${KILL_OUTCOME_ROW_FINISHED} read=${KILL_ROW_FINISHED_MISSING}`,
    )
    // b.jg5 SRJ-702, SRJ-811 (option A): the old-life hold's end, named as its read; a read of no known kind is `unknown`.
    expect(describeKillOutcome({ kind: KILL_OUTCOME_ROW_FINISHED, read: KILL_ROW_FINISHED_HOLD_ENDED })).toBe(
      `outcome=${KILL_OUTCOME_ROW_FINISHED} read=${KILL_ROW_FINISHED_HOLD_ENDED}`,
    )
    expect(describeKillOutcome({ kind: KILL_OUTCOME_ROW_FINISHED, read: 'not-a-read' } as unknown as KillOutcome)).toBe(
      `outcome=${KILL_OUTCOME_ROW_FINISHED} read=unknown`,
    )
    expect(describeKillOutcome(killOutcomeOf({ thrown: killFailed }))).toBe(
      `outcome=${KILL_OUTCOME_NOT_KILLED} class=${AD_ERROR_CLASS_UNAVAILABLE} ${ERR_TMUX_KILL_FAILED_NAME} message=${JSON.stringify(killFailed.errDescription)}`,
    )
    expect(describeKillOutcome(killOutcomeOf({ thrown: unresponsive }))).toBe(
      `outcome=${KILL_OUTCOME_NOT_KILLED} class=${AD_ERROR_CLASS_UNAVAILABLE} ${unresponsive.errName} message=${JSON.stringify(unresponsive.errDescription)}`,
    )
    expect(describeKillOutcome(killOutcomeOf({ thrown: unusable }))).toBe(
      `outcome=${KILL_OUTCOME_NOT_KILLED} class=${AD_ERROR_CLASS_UNUSABLE_NAME} name=${unusable.unknownName} message=${JSON.stringify((unusable.envelope as { err_description: string }).err_description)}`,
    )
  })

  test.each(NON_SUCCESS_ROWS.map(([label, build, expected]) => [label, expected, build] as const))(
    '%s renders on one line with its class (%s)',
    (_label, expected, build) => {
      const line = describeKillOutcome(killOutcomeOf({ thrown: build() }))
      expect(line).not.toMatch(/[\r\n]/)
      expect(line.startsWith(`outcome=${KILL_OUTCOME_NOT_KILLED} class=${expected}`)).toBe(true)
      assertNoLeak({ line })
    },
  )

  const TOKEN_SESSION = fakeToken(BOT_TOKEN_PREFIX, 'session')

  test.each<[string, () => unknown]>([
    ...KILL_FAILED_DESCRIPTIONS.map((d): [string, () => unknown] => [`errTmuxKillFailed (${d})`, () => errTmuxKillFailed(TOKEN_SESSION, d)]),
    [
      'an ErrUnknownErrorName carrying the ErrTmuxKillFailed name',
      () => errUnknownErrorName(ERR_TMUX_KILL_FAILED_NAME, errTmuxKillFailed(TOKEN_SESSION, 'unverifiable-session-present').errDescription),
    ],
    ['errTmuxSessionConflict (not-this-launch)', () => errTmuxSessionConflict('kill', 'not-this-launch', TOKEN_SESSION)],
    ['errTmuxUnresponsive (still stopping)', () => errTmuxUnresponsive('kill', `the agent in tmux session ${JSON.stringify(TOKEN_SESSION)} is still stopping`)],
  ])('%s: a fake token in its session name comes out redacted, on one line', (_label, build) => {
    const line = describeKillOutcome(killOutcomeOf({ thrown: build() }))
    expect(line).toContain(REDACTED_TOKEN_PLACEHOLDER)
    expect(line).not.toMatch(/[\r\n]/)
    assertNoLeak({ line })
  })

  test('the GONE non-success (goneIsFailure) of errTmuxCaptureFailed: a fake token in its session name comes out redacted, on one line, never as the session-gone form', () => {
    const line = describeKillOutcome(killOutcomeOf({ thrown: errTmuxCaptureFailed(TOKEN_SESSION, 'kill') }, GONE_IS_FAILURE))
    expect(line.startsWith(`outcome=${KILL_OUTCOME_NOT_KILLED} class=${AD_ERROR_CLASS_GONE} `)).toBe(true)
    expect(line).not.toContain(KILL_OUTCOME_SESSION_GONE)
    expect(line).toContain(REDACTED_TOKEN_PLACEHOLDER)
    expect(line).not.toMatch(/[\r\n]/)
    assertNoLeak({ line })
  })

  test.each<[string, () => unknown]>([
    ['an ErrInternal', () => errInternal(`line one\n${sentinelInMessage('internal')}`)],
    ['a plain Error', () => new Error(`line one\n${sentinelInMessage('plain')}`)],
  ])('%s whose message carries a token and a ticket URL renders them redacted on one line', (_label, build) => {
    const line = describeKillOutcome(killOutcomeOf({ thrown: build() }))
    expect(line).toContain(REDACTED_SENTINEL_TAIL)
    expect(line).not.toMatch(/[\r\n]/)
    assertNoLeak({ line })
  })

  test('a value that is not an outcome renders the fixed unknown text and nothing throws', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom') } }) as KillOutcome
    expect(() => describeKillOutcome(hostile)).not.toThrow()
    expect(describeKillOutcome(hostile)).toBe('outcome=unknown')
  })
})

// ---------------------------------------------------------------------------
// The notices built from a kill's outcome (b.jg5 SRJ-1003, SRJ-1002, SRJ-110)
// ---------------------------------------------------------------------------

describe('the notices built from a kill\'s outcome where nothing latches on it', () => {
  test('pin: the refusal notice met at a try and at a status read, and the not-succeeded notice, each the instance id with the outcome\'s one-line rendering', () => {
    const conflict = errTmuxSessionConflict('kill', 'not-this-launch')
    const unusable = errUnusableName('empty')
    const unresponsive = errTmuxUnresponsive('kill')
    const notKilled = killOutcomeOf({ thrown: unresponsive }) as KillFailure
    expect([KILL_REFUSAL_AT_KILL, KILL_REFUSAL_AT_READ]).toEqual(['kill', 'status read'])
    expect([
      teardownKillRefusalNoticeText('cscb_sample', { at: KILL_REFUSAL_AT_KILL, errorClass: AD_ERROR_CLASS_CONFLICT, error: conflict }),
      teardownKillRefusalNoticeText('cscb_sample', { at: KILL_REFUSAL_AT_READ, errorClass: AD_ERROR_CLASS_UNUSABLE_NAME, error: unusable }),
      teardownKillNotSucceededNoticeText('cscb_sample', notKilled, 3),
    ]).toEqual([
      `agent-director kill of cscb_sample refused at a try: ${describeKillOutcome(killOutcomeOf({ thrown: conflict }))}`,
      `agent-director kill of cscb_sample refused at a status read between its tries: ${describeKillOutcome(killOutcomeOf({ thrown: unusable }))}`,
      `agent-director kill of cscb_sample did not succeed after 3 kill(s); the row is kept: ${describeKillOutcome(notKilled)}`,
    ])
  })

  test.each<[string, number]>([
    ['a negative count', -1],
    ['a fractional count', 1.5],
    ['NaN', Number.NaN],
  ])('the not-succeeded notice with %s of kills names "its tries" instead', (_label, tries) => {
    const outcome = killOutcomeOf({ thrown: errInternal() }) as KillFailure
    expect(teardownKillNotSucceededNoticeText('cscb_sample', outcome, tries)).toBe(
      `agent-director kill of cscb_sample did not succeed after its tries; the row is kept: ${describeKillOutcome(outcome)}`,
    )
  })

  test('a description carrying a token comes out redacted, on one line, in both notices', () => {
    const plain = new Error(`line one\n${sentinelInMessage('notice')}`)
    const conflict = errTmuxSessionConflict('kill', 'not-this-launch', fakeToken(BOT_TOKEN_PREFIX, 'notice'))
    const lines = [
      teardownKillNotSucceededNoticeText('cscb_sample', killOutcomeOf({ thrown: plain }) as KillFailure, 1),
      teardownKillRefusalNoticeText('cscb_sample', { at: KILL_REFUSAL_AT_KILL, errorClass: AD_ERROR_CLASS_CONFLICT, error: conflict }),
    ]
    for (const line of lines) expect(line).not.toMatch(/[\r\n]/)
    assertNoLeak({ lines })
  })
})

// ---------------------------------------------------------------------------
// Import boundary: no server-only module (so E33's CLI can use it)
// ---------------------------------------------------------------------------

describe('checked-kill: import boundary', () => {
  test('the module loads, through its runtime imports in src/, no server-only module, no Slack module and no @slack/ package', () => {
    const { loads, forbidden } = forbiddenServerLoads('checked-kill.ts')
    // Not vacuous: the walk reaches the classifier it decides every class through.
    expect(loads.modules.has('ad-error-class.ts')).toBe(true)
    expect(forbidden).toEqual([])
  })
})
