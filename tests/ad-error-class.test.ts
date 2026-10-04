/**
 * ad-error-class.test.ts — the one classifier of agent-director errors
 * (b.jg5 SRJ-104), which recognises every error the client declares as a
 * class by `instanceof` that class (b.jg5 SRJ-101), never by its `errName` or
 * `name`; the by-class helper `isAdErrorInstance` and the GONE label
 * `goneErrNameOf`; the `ErrInvalidFlags` step beside it; the re-bound-socket
 * predicate `isDifferentTmuxServerError` (b.jg5 SRJ-311, SRJ-1021; class plus
 * phrase); the CONFLICT description accessor `conflictDescriptionOf` (b.jg5
 * SRJ-501, SRJ-507) and the kill-failure description accessor
 * `killFailedDescriptionOf` (b.jg5 SRJ-110, SRJ-702), each answering only
 * for an instance of its class (an `ErrUnknownErrorName` carrying the name,
 * UNAVAILABLE by SRJ-104, answers nothing); the launch-timeout predicate
 * `isLaunchTimeoutError` / `launchTimeoutFormOf` (b.jg5 SRJ-407; class plus
 * phrase and the declared call: an `ErrCallTimeout` instance, or an
 * `ErrTmuxUnresponsive` instance whose description carries
 * `LAUNCH_TIMEOUT_PHRASE`, only at a launch call; both forms stay
 * UNAVAILABLE); the one-line description `describeReportedAdFailure` (b.jg5
 * SRJ-104: what agent-director reported, else
 * `describeAgentDirectorFailure`'s description); and the stub's error
 * builders it is fed with (b.jg5 SRJ-1303; their shape checks live here).
 *
 * Every value is built with the stub's builders; a value of a class with a
 * description no builder takes has that description set on the builder's
 * value. The one exception is `RC_KILL_FAILED_DESCRIPTIONS`, the release
 * candidate's kill-failure descriptions as literals, which pins the survivor
 * pattern to agent-director's own wording. A base `AgentDirectorError` named like a class (`errGeneric`), an
 * `Error` named like one and an object shaped like one are the by-class
 * negatives. The client's classes, the bindings of the three Phase-1-only
 * classes (`ErrTmuxKillFailed`, `ErrTmuxUnresponsive`,
 * `ErrTmuxSessionConflict`: the host client's stand-ins) and the name
 * constants come from `src/agent-director-errors.ts`. Class labels come from
 * `src/ad-error-class.ts`, the description words, the survivor pattern and
 * `survivorPids` from `src/ad-description-phrases.ts` and the cap from
 * `src/persona-connection-errors.ts`.
 *
 * The step's re-check is either an injected recording trigger or E3's
 * installed re-check over `makeStubResolveSystemBinary` on `createFakeClock`;
 * the installed re-check and the client singleton are reset in `afterEach`.
 * No process, no real timer, no top-level mock.module(), no value import of
 * `Client` or `resolveSystemBinary`.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'

import {
  AD_CALL_KILL_ROW_NOT_READ_LIVE,
  AD_CALL_KILL_ROW_READ_LIVE,
  AD_ERROR_CLASSES,
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
  AD_GONE_ERR_NAMES,
  AD_GONE_ERROR_CLASSES,
  AD_LAUNCH_VERBS,
  AD_VERBS,
  AD_VERB_KILL,
  CSCB_UNKNOWN_ERROR_NAME,
  LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT,
  LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE,
  TRIGGER_FAILED_DESCRIPTION,
  classifyAdError,
  classifyWithInvalidFlagsRecheck,
  conflictDescriptionOf,
  describeAdErrorClassification,
  describeAdFailureForLog,
  describeAgentDirectorFailure,
  describeReportedAdFailure,
  goneErrNameOf,
  isAdErrorInstance,
  isDifferentTmuxServerError,
  isInvalidFlagsError,
  isLaunchTimeoutError,
  killFailedDescriptionOf,
  launchTimeoutFormOf,
  unclassifiedClassificationOf,
  type AdCall,
  type AdErrorClass,
  type AdErrorClassification,
  type AdErrorConstructor,
  type AdVerb,
  type AdVersionRecheckTrigger,
  type LaunchTimeoutForm,
} from '../src/ad-error-class.ts'
import {
  CONFLICT_ANOTHER_STORE_PHRASE,
  CONFLICT_CONFLICTING_LABELS_PHRASE,
  CONFLICT_DIFFERENT_ID_PHRASE,
  CONFLICT_LEFTOVER_PHRASE,
  CONFLICT_NEVER_REPORTED_IN_PHRASE,
  CONFLICT_NOT_THIS_LAUNCH_PHRASE,
  CONFLICT_NO_VALID_ID_PHRASE,
  CONFLICT_OWN_ID_PHRASE,
  CONFLICT_PANE_NOT_FOUND_PHRASE,
  DIFFERENT_TMUX_SERVER_PHRASE,
  LAUNCH_TIMEOUT_PHRASE,
  NEVER_DELETE_ROW_PHRASE,
  NEW_ROW_ENDED_PHRASE,
  NO_KILL_SENT_PHRASE,
  NOTHING_WRITTEN_PHRASE,
  PANE_NOT_ADOPTED_PHRASE,
  PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE,
  PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE,
  RETRY_KILL_LATER_PHRASE,
  STILL_STARTING_PHRASE,
  STILL_STOPPING_PHRASE,
  SURVIVOR_CLAUSE_MANY_PHRASE,
  SURVIVOR_CLAUSE_ONE_PHRASE,
  SURVIVOR_PID_PATTERN,
  UNUSABLE_RECORDED_NAME_PHRASE,
  survivorPids,
} from '../src/ad-description-phrases.ts'
import {
  RECHECK_OUTCOME_COULD_NOT_RUN,
  RECHECK_OUTCOME_NOT_RUNNING,
  RECHECK_OUTCOME_PASS,
  RECHECK_OUTCOME_STOP,
  installAdVersionRecheck,
  resetAdVersionRecheckForTests,
  type AdVersionRecheckTriggerAnswer,
} from '../src/ad-version-gate.ts'
import { resetClientForTests, setClientForTests } from '../src/agent-director-client.ts'
import {
  AgentDirectorError,
  ERR_SCHEMA_MIGRATION_REQUIRED_NAME,
  ERR_SCHEMA_MISMATCH_NAME,
  ERR_SPAWN_NOT_FOUND_NAME,
  ERR_STORE_OPEN_NAME,
  ERR_TMUX_KILL_FAILED_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
  ERR_TMUX_UNRESPONSIVE_NAME,
  ErrCallTimeout,
  ErrCwdNotADirectory,
  ErrCwdNotFound,
  ErrInstanceIdCollision,
  ErrInvalidFlags,
  ErrJsonlMissing,
  ErrJsonlNeverWritten,
  ErrNoSessionId,
  ErrSpawnNotFound,
  ErrSpawnNotInteractive,
  ErrSpawnNotPausable,
  ErrSpawnNotResumable,
  ErrTmuxCaptureFailed,
  ErrTmuxKillFailed,
  ErrTmuxNotAvailable,
  ErrTmuxSendKeys,
  ErrTmuxSessionConflict,
  ErrTmuxSessionCreate,
  ErrTmuxUnresponsive,
  ErrUnknownErrorName,
  PHASE1_ONLY_ERR_NAMES,
  STORE_OPEN_ERR_NAMES,
} from '../src/agent-director-errors.ts'
import { REQUIRED_ERR_NAMES } from '../src/agent-director-startup.ts'
import { AD_BELOW_PHASE1_FLOOR } from '../src/install-check.ts'
import { MAX_LOGGED_MESSAGE_LENGTH } from '../src/persona-connection-errors.ts'
import { REDACTED_TOKEN_PLACEHOLDER } from '../src/slack-log-redaction.ts'
import {
  CONFLICT_CASES,
  KILL_FAILED_DESCRIPTIONS,
  STUB_RESOLVE_DEFAULT_PATH,
  STUB_SURVIVOR_PIDS,
  STUB_WORKER_PID,
  STUB_TMUX_SESSION_ID,
  STUB_TMUX_SESSION_NAME,
  STUB_TMUX_SOCKET_PATH,
  UNUSABLE_NAME_FAULTS,
  errCallTimeout,
  errConfigMalformed,
  errCwdNotADirectory,
  errCwdNotFound,
  errGeneric,
  errInstanceIdCollision,
  errInternal,
  errInvalidFlags,
  errJsonlMissing,
  errJsonlNeverWritten,
  errNoSessionId,
  errSchemaMismatch,
  errSendKeysWhileRelayed,
  errSpawnNotFound,
  errSpawnNotInteractive,
  errSpawnNotInteractiveLeftover,
  errSpawnNotInteractiveNoLaunchStart,
  errSpawnNotPausable,
  errSpawnNotResumable,
  errSystemInstallDisappeared,
  errTmuxCaptureFailed,
  errTmuxKillFailed,
  NEW_ROW_ENDED_RETRY,
  errTmuxNotAvailable,
  errTmuxNotAvailableDifferentServer,
  errTmuxNotAvailableNewRowEnded,
  errTmuxSendKeys,
  errTmuxSessionConflict,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  errTmuxUnresponsiveAfterDuplicateSession,
  errTmuxUnresponsiveLaunchTimeout,
  errTmuxUnresponsiveNewRowEnded,
  errTmuxUnresponsiveStillStarting,
  errTmuxUnresponsiveStillStopping,
  errUnknownErrorName,
  errUnusableName,
  makeStubCallLog,
  makeStubClient,
  makeStubResolveSystemBinary,
  stubCallCount,
  type ConflictCase,
  type ConflictOptions,
  type StubResolveSystemBinaryOutcome,
} from './test-helpers/agent-director-stub.ts'
import { OLD_AD_VERSION, PHASE1_RC_VERSION } from './test-helpers/agent-director-versions.ts'
import {
  BOT_TOKEN_PREFIX,
  LEAK_SENTINEL,
  REDACTED_SENTINEL_TAIL,
  assertNoLeak,
  fakeToken,
  sentinelInMessage,
} from './test-helpers/credentials.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'

afterEach(() => {
  resetAdVersionRecheckForTests()
  resetClientForTests()
})

// ---------------------------------------------------------------------------
// Names and fixtures
// ---------------------------------------------------------------------------

/** `ErrInternal` and `ErrConfigMalformed`, as the builders name them (no class in any client). */
const ERR_INTERNAL = errInternal().unknownName
const ERR_CONFIG_MALFORMED = errConfigMalformed().unknownName

/** The classes whose classification carries a reported name and message (b.jg5 SRJ-104). */
const REPORTING_CLASSES: readonly AdErrorClass[] = [
  AD_ERROR_CLASS_UNCLASSIFIED,
  AD_ERROR_CLASS_UNUSABLE_NAME,
  AD_ERROR_CLASS_CONFIG,
]

/** An `Error` whose `name` is `name` (not an `AgentDirectorError`). */
function plainErrorNamed(name: string): Error {
  const err = new Error('boom')
  err.name = name
  return err
}

/** An `AgentDirectorError` of the client's base class with this `errName` and its default `name`. */
function baseError(errName: string, description = 'described'): AgentDirectorError {
  return errGeneric('resume', errName, description)
}

/** `value` (a builder's error, of its class) with its `errDescription` set to `description`. */
function withErrDescription<T extends AgentDirectorError>(value: T, description: string): T {
  return Object.defineProperty(value, 'errDescription', { value: description })
}

// ---------------------------------------------------------------------------
// Every row of SRJ-104's table
// ---------------------------------------------------------------------------

type Row = readonly [label: string, build: () => unknown, expected: AdErrorClass]

const ROWS: readonly Row[] = [
  // GONE
  ['errTmuxSendKeys', () => errTmuxSendKeys(), AD_ERROR_CLASS_GONE],
  ['errTmuxCaptureFailed', () => errTmuxCaptureFailed(), AD_ERROR_CLASS_GONE],
  // UNAVAILABLE
  ['errTmuxUnresponsive', () => errTmuxUnresponsive(), AD_ERROR_CLASS_UNAVAILABLE],
  ['errTmuxUnresponsiveLaunchTimeout (spawn)', () => errTmuxUnresponsiveLaunchTimeout('spawn'), AD_ERROR_CLASS_UNAVAILABLE],
  ['errTmuxUnresponsiveLaunchTimeout (resume)', () => errTmuxUnresponsiveLaunchTimeout('resume'), AD_ERROR_CLASS_UNAVAILABLE],
  ['errTmuxUnresponsiveStillStopping', () => errTmuxUnresponsiveStillStopping(), AD_ERROR_CLASS_UNAVAILABLE],
  ['errTmuxUnresponsiveStillStarting', () => errTmuxUnresponsiveStillStarting(), AD_ERROR_CLASS_UNAVAILABLE],
  // HO rev 26: a plain spawn's re-lookup after "duplicate session" that could not answer, its new row ended.
  ['errTmuxUnresponsiveNewRowEnded', () => errTmuxUnresponsiveNewRowEnded(), AD_ERROR_CLASS_UNAVAILABLE],
  ...KILL_FAILED_DESCRIPTIONS.map((d): Row => [
    `errTmuxKillFailed (${d})`,
    () => errTmuxKillFailed(STUB_TMUX_SESSION_NAME, d),
    AD_ERROR_CLASS_UNAVAILABLE,
  ]),
  ['errCallTimeout', () => errCallTimeout(), AD_ERROR_CLASS_UNAVAILABLE],
  ['errUnknownErrorName with a later name', () => errUnknownErrorName(), AD_ERROR_CLASS_UNAVAILABLE],
  ...PHASE1_ONLY_ERR_NAMES.map((name): Row => [
    `errUnknownErrorName with the Phase-1-only name ${name}`,
    () => errUnknownErrorName(name),
    AD_ERROR_CLASS_UNAVAILABLE,
  ]),
  ['a wrapped UnknownError', () => baseError(CSCB_UNKNOWN_ERROR_NAME, 'Error: boom'), AD_ERROR_CLASS_UNAVAILABLE],
  ['a plain Error', () => new Error('boom'), AD_ERROR_CLASS_UNAVAILABLE],
  ['a string', () => 'boom', AD_ERROR_CLASS_UNAVAILABLE],
  ['undefined', () => undefined, AD_ERROR_CLASS_UNAVAILABLE],
  ['null', () => null, AD_ERROR_CLASS_UNAVAILABLE],
  // CONFLICT
  ...CONFLICT_CASES.map((c): Row => [
    `errTmuxSessionConflict (resume, ${c})`,
    () => errTmuxSessionConflict('resume', c),
    AD_ERROR_CLASS_CONFLICT,
  ]),
  ['errTmuxSessionConflict (kill, not-this-launch)', () => errTmuxSessionConflict('kill', 'not-this-launch'), AD_ERROR_CLASS_CONFLICT],
  ['errTmuxSessionConflict (kill, never-reported-in)', () => errTmuxSessionConflict('kill', 'never-reported-in'), AD_ERROR_CLASS_CONFLICT],
  ...(['different-id', 'another-store'] as const).map((c): Row => [
    `errTmuxSessionConflict (spawn, ${c}, plain spawn)`,
    () => errTmuxSessionConflict('spawn', c, STUB_TMUX_SESSION_NAME, { plainSpawn: true }),
    AD_ERROR_CLASS_CONFLICT,
  ]),
  [
    'errTmuxSessionConflict (read-pane, pane-not-found, not adopted)',
    () => errTmuxSessionConflict('read-pane', 'pane-not-found', STUB_TMUX_SESSION_NAME, { notAdopted: true }),
    AD_ERROR_CLASS_CONFLICT,
  ],
  [
    'errTmuxSessionConflict (spawn, conflicting-labels, scan)',
    () => errTmuxSessionConflict('spawn', 'conflicting-labels', STUB_TMUX_SESSION_NAME, { scan: true }),
    AD_ERROR_CLASS_CONFLICT,
  ],
  // UNUSABLE NAME
  ...UNUSABLE_NAME_FAULTS.map((f): Row => [`errUnusableName (${f})`, () => errUnusableName(f), AD_ERROR_CLASS_UNUSABLE_NAME]),
  // CONFIG
  ['errConfigMalformed', () => errConfigMalformed(), AD_ERROR_CLASS_CONFIG],
  // ENVIRONMENT
  ['errTmuxNotAvailable', () => errTmuxNotAvailable(), AD_ERROR_CLASS_ENVIRONMENT],
  ['errTmuxNotAvailable with a socket', () => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH), AD_ERROR_CLASS_ENVIRONMENT],
  ['errTmuxNotAvailableDifferentServer', () => errTmuxNotAvailableDifferentServer(), AD_ERROR_CLASS_ENVIRONMENT],
  ['errTmuxNotAvailableNewRowEnded', () => errTmuxNotAvailableNewRowEnded(), AD_ERROR_CLASS_ENVIRONMENT],
  // LAUNCH FAILURE
  ['errTmuxSessionCreate (spawn)', () => errTmuxSessionCreate('spawn'), AD_ERROR_CLASS_LAUNCH_FAILURE],
  ['errTmuxSessionCreate (resume)', () => errTmuxSessionCreate('resume'), AD_ERROR_CLASS_LAUNCH_FAILURE],
  // STATE
  ['errSpawnNotFound', () => errSpawnNotFound(), AD_ERROR_CLASS_STATE],
  ['errInstanceIdCollision', () => errInstanceIdCollision(), AD_ERROR_CLASS_STATE],
  ['errSpawnNotResumable', () => errSpawnNotResumable(), AD_ERROR_CLASS_STATE],
  ['errSpawnNotInteractive', () => errSpawnNotInteractive(), AD_ERROR_CLASS_STATE],
  ['errSpawnNotInteractiveLeftover', () => errSpawnNotInteractiveLeftover(), AD_ERROR_CLASS_STATE],
  ['errSpawnNotInteractiveNoLaunchStart', () => errSpawnNotInteractiveNoLaunchStart(), AD_ERROR_CLASS_STATE],
  ['errSpawnNotPausable', () => errSpawnNotPausable(), AD_ERROR_CLASS_STATE],
  ['errNoSessionId', () => errNoSessionId(), AD_ERROR_CLASS_STATE],
  ['errJsonlMissing', () => errJsonlMissing(), AD_ERROR_CLASS_STATE],
  ['errJsonlNeverWritten', () => errJsonlNeverWritten(), AD_ERROR_CLASS_STATE],
  ['errInvalidFlags (decide)', () => errInvalidFlags('decide'), AD_ERROR_CLASS_STATE],
  ['errInvalidFlags (resume)', () => errInvalidFlags('resume'), AD_ERROR_CLASS_STATE],
  // DIRECTORY
  ['errCwdNotFound', () => errCwdNotFound(), AD_ERROR_CLASS_DIRECTORY],
  ['errCwdNotADirectory', () => errCwdNotADirectory(), AD_ERROR_CLASS_DIRECTORY],
  // UNCLASSIFIED
  ['errInternal without the phrase', () => errInternal(), AD_ERROR_CLASS_UNCLASSIFIED],
  ['errSchemaMismatch', () => errSchemaMismatch(), AD_ERROR_CLASS_UNCLASSIFIED],
  [
    `errUnknownErrorName with ${ERR_SCHEMA_MIGRATION_REQUIRED_NAME}`,
    () => errUnknownErrorName(ERR_SCHEMA_MIGRATION_REQUIRED_NAME, 'the store needs the install script\'s migration'),
    AD_ERROR_CLASS_UNCLASSIFIED,
  ],
  [
    `errUnknownErrorName with ${ERR_STORE_OPEN_NAME}`,
    () => errUnknownErrorName(ERR_STORE_OPEN_NAME, 'the store could not be opened'),
    AD_ERROR_CLASS_UNCLASSIFIED,
  ],
  ['errSystemInstallDisappeared', () => errSystemInstallDisappeared(), AD_ERROR_CLASS_UNCLASSIFIED],
  [
    'errSendKeysWhileRelayed (a name CSCB gives no handling)',
    () => errSendKeysWhileRelayed(),
    AD_ERROR_CLASS_UNCLASSIFIED,
  ],
]

describe('classifyAdError: every row of SRJ-104', () => {
  test.each(ROWS.map(([label, build, expected]) => [label, expected, build] as const))('%s is %s', (_label, expected, build) => {
    const classification = classifyAdError(build())
    expect(classification.errorClass).toBe(expected)
    if (!REPORTING_CLASSES.includes(expected)) expect(classification).toEqual({ errorClass: expected })
  })

  test('every exported class has at least one row', () => {
    expect(new Set(ROWS.map(([, , expected]) => expected))).toEqual(new Set(AD_ERROR_CLASSES))
  })

  test('the default errInternal description lacks the phrase (the UNCLASSIFIED row stands)', () => {
    expect((errInternal().envelope as { err_description: string }).err_description).not.toContain(
      UNUSABLE_RECORDED_NAME_PHRASE,
    )
  })
})

// ---------------------------------------------------------------------------
// ErrInternal, ErrConfigMalformed and Assumption A-13
// ---------------------------------------------------------------------------

/** An `ErrUnknownErrorName` built as the client does, with any envelope. */
function unknownWithEnvelope(unknownName: string, envelope: unknown): ErrUnknownErrorName {
  return new ErrUnknownErrorName(unknownName, envelope)
}

describe('classifyAdError: ErrInternal by its envelope description', () => {
  test('the phrase in the envelope description is UNUSABLE NAME', () => {
    expect(classifyAdError(errInternal(`the row: ${UNUSABLE_RECORDED_NAME_PHRASE} is empty`)).errorClass).toBe(
      AD_ERROR_CLASS_UNUSABLE_NAME,
    )
  })

  test('the phrase only in the error\'s own errDescription is UNCLASSIFIED', () => {
    const err = errInternal('the store could not be read')
    Object.defineProperty(err, 'errDescription', { value: `the row: ${UNUSABLE_RECORDED_NAME_PHRASE} is empty` })
    expect(classifyAdError(err).errorClass).toBe(AD_ERROR_CLASS_UNCLASSIFIED)
  })

  test.each([
    ['no err_description', { err_name: ERR_INTERNAL }],
    ['a numeric err_description', { err_name: ERR_INTERNAL, err_description: 42 }],
    ['an object err_description', { err_name: ERR_INTERNAL, err_description: { text: UNUSABLE_RECORDED_NAME_PHRASE } }],
    ['a string envelope', UNUSABLE_RECORDED_NAME_PHRASE],
    ['a null envelope', null],
    ['an undefined envelope', undefined],
  ])('%s is UNCLASSIFIED with no message and nothing thrown', (_label, envelope) => {
    expect(classifyAdError(unknownWithEnvelope(ERR_INTERNAL, envelope))).toEqual({
      errorClass: AD_ERROR_CLASS_UNCLASSIFIED,
      reportedName: ERR_INTERNAL,
    })
  })

  test('ErrConfigMalformed with no envelope description is CONFIG with no message', () => {
    expect(classifyAdError(unknownWithEnvelope(ERR_CONFIG_MALFORMED, null))).toEqual({
      errorClass: AD_ERROR_CLASS_CONFIG,
      reportedName: ERR_CONFIG_MALFORMED,
    })
  })

  test.each([
    ['ErrInternal lower-cased', ERR_INTERNAL.toLowerCase()],
    ['ErrInternal upper-cased', ERR_INTERNAL.toUpperCase()],
    ['ErrConfigMalformed lower-cased', ERR_CONFIG_MALFORMED.toLowerCase()],
    ['ErrConfigMalformed upper-cased', ERR_CONFIG_MALFORMED.toUpperCase()],
    ...STORE_OPEN_ERR_NAMES.flatMap((name) => [
      [`${name} lower-cased`, name.toLowerCase()],
      [`${name} upper-cased`, name.toUpperCase()],
    ]),
  ])('an unknownName that is %s is UNAVAILABLE', (_label, unknownName) => {
    expect(classifyAdError(errUnknownErrorName(unknownName, UNUSABLE_RECORDED_NAME_PHRASE))).toEqual({
      errorClass: AD_ERROR_CLASS_UNAVAILABLE,
    })
  })
})

describe('classifyAdError: A-13 (a client class named ErrInternal, ErrConfigMalformed or a store-open name)', () => {
  test.each([
    ['ErrInternal without the phrase', ERR_INTERNAL, 'the store could not be read', AD_ERROR_CLASS_UNCLASSIFIED],
    ['ErrInternal with the phrase', ERR_INTERNAL, `${UNUSABLE_RECORDED_NAME_PHRASE} is empty`, AD_ERROR_CLASS_UNUSABLE_NAME],
    ['ErrConfigMalformed', ERR_CONFIG_MALFORMED, 'config refused', AD_ERROR_CLASS_CONFIG],
    ...STORE_OPEN_ERR_NAMES.map((name) => [name, name, 'the store could not be opened', AD_ERROR_CLASS_UNCLASSIFIED] as const),
  ] as const)('a base error whose errName is %s classifies as the ErrUnknownErrorName form', (_label, name, description, expected) => {
    const byErrName = classifyAdError(baseError(name, description))
    expect(byErrName.errorClass).toBe(expected)
    expect(byErrName).toEqual(classifyAdError(errUnknownErrorName(name, description)))
  })
})

/** A description carrying the UNUSABLE NAME phrase, so a base `ErrInternal` takes its most specific answer. */
const NAMED_BY_ERRNAME_DESCRIPTION = `${UNUSABLE_RECORDED_NAME_PHRASE} is empty`

/** Each `errName` the classifier reads only off a value of no table class, with a base error's answer for it. */
const ERRNAME_ROWS: ReadonlyArray<readonly [name: string, baseAnswer: AdErrorClass]> = [
  [ERR_INTERNAL, AD_ERROR_CLASS_UNUSABLE_NAME],
  [ERR_CONFIG_MALFORMED, AD_ERROR_CLASS_CONFIG],
  ...STORE_OPEN_ERR_NAMES.map((name) => [name, AD_ERROR_CLASS_UNCLASSIFIED] as const),
  [CSCB_UNKNOWN_ERROR_NAME, AD_ERROR_CLASS_UNAVAILABLE],
]

/** Table classes of differing answers, each built with a given `errName` and description. */
const ERRNAME_CLASS_ROWS: ReadonlyArray<readonly [build: (name: string, description: string) => AgentDirectorError, classAnswer: AdErrorClass]> = [
  [(name, description) => new ErrTmuxSendKeys('send-keys', name, description), AD_ERROR_CLASS_GONE],
  [(name, description) => new ErrSpawnNotFound('get', name, description), AD_ERROR_CLASS_STATE],
  [(name, description) => new ErrTmuxUnresponsive('resume', name, description), AD_ERROR_CLASS_UNAVAILABLE],
]

describe('classifyAdError: a table class wins over an A-13 or UnknownError errName', () => {
  test.each(
    ERRNAME_ROWS.flatMap(([name, baseAnswer]) =>
      ERRNAME_CLASS_ROWS.map(([build, classAnswer]) => {
        const value = build(name, NAMED_BY_ERRNAME_DESCRIPTION)
        return [value.constructor.name, name, classAnswer, baseAnswer, value] as const
      }),
    ),
  )('an %s whose errName is %s is %s (a base error so named is %s)', (_className, name, classAnswer, baseAnswer, value) => {
    expect(value.errName).toBe(name)
    expect(classifyAdError(value)).toEqual({ errorClass: classAnswer })
    expect(classifyAdError(baseError(name, NAMED_BY_ERRNAME_DESCRIPTION)).errorClass).toBe(baseAnswer)
  })
})

// ---------------------------------------------------------------------------
// The store-open names (b.jg5 SRJ-104; A-32, Q-15)
// ---------------------------------------------------------------------------

/** The three store-open names as the SRD spells them, the wire names the Phase 1 CLI returns. */
const SRD_STORE_OPEN_NAMES = ['ErrSchemaMismatch', 'ErrSchemaMigrationRequired', 'ErrStoreOpen']

/** Each store-open name with the stub call that builds it around a description. */
const STORE_OPEN_BUILDERS: ReadonlyArray<readonly [string, (description: string) => ErrUnknownErrorName]> = [
  [ERR_SCHEMA_MISMATCH_NAME, (description) => errSchemaMismatch(description)],
  [ERR_SCHEMA_MIGRATION_REQUIRED_NAME, (description) => errUnknownErrorName(ERR_SCHEMA_MIGRATION_REQUIRED_NAME, description)],
  [ERR_STORE_OPEN_NAME, (description) => errUnknownErrorName(ERR_STORE_OPEN_NAME, description)],
]

describe('classifyAdError: the store-open names', () => {
  test('the constants are the SRD\'s three names', () => {
    expect<readonly string[]>(STORE_OPEN_ERR_NAMES).toEqual(SRD_STORE_OPEN_NAMES)
  })

  test.each(STORE_OPEN_BUILDERS)('%s is UNCLASSIFIED with its reported name and its description redacted', (name, build) => {
    const classification = classifyAdError(build(`store not opened (${sentinelInMessage('store')})`))
    const expected: AdErrorClassification = {
      errorClass: AD_ERROR_CLASS_UNCLASSIFIED,
      reportedName: name,
      message: `store not opened (${REDACTED_SENTINEL_TAIL})`,
    }
    expect(classification).toEqual(expected)
    const line = describeAdErrorClassification(classification)
    expect(line).toBe(`class=${AD_ERROR_CLASS_UNCLASSIFIED} name=${name} message=${JSON.stringify(expected.message)}`)
    assertNoLeak({ classification, line })
  })

  test('no store-open name is a Phase-1-only name or a name the startup gate requires as a class', () => {
    for (const name of STORE_OPEN_ERR_NAMES) {
      expect(PHASE1_ONLY_ERR_NAMES as readonly string[]).not.toContain(name)
      expect(REQUIRED_ERR_NAMES as readonly string[]).not.toContain(name)
    }
  })
})

// ---------------------------------------------------------------------------
// By class, never by `errName` or `name` (b.jg5 SRJ-101)
// ---------------------------------------------------------------------------

/** A class the classifier decides by `instanceof`, a stub value of it, and that class's answer. */
type ClassRow = readonly [errorClass: AdErrorConstructor, build: () => AgentDirectorError, expected: AdErrorClass]

/** Every class the classifier decides by `instanceof`: SRJ-104's classes and `ErrUnknownErrorName`. */
const BY_CLASS_ROWS: readonly ClassRow[] = [
  [ErrTmuxSendKeys, () => errTmuxSendKeys(), AD_ERROR_CLASS_GONE],
  [ErrTmuxCaptureFailed, () => errTmuxCaptureFailed(), AD_ERROR_CLASS_GONE],
  [ErrTmuxUnresponsive, () => errTmuxUnresponsive(), AD_ERROR_CLASS_UNAVAILABLE],
  [ErrTmuxKillFailed, () => errTmuxKillFailed(), AD_ERROR_CLASS_UNAVAILABLE],
  [ErrCallTimeout, () => errCallTimeout(), AD_ERROR_CLASS_UNAVAILABLE],
  [ErrUnknownErrorName, () => errUnknownErrorName(), AD_ERROR_CLASS_UNAVAILABLE],
  [ErrTmuxSessionConflict, () => errTmuxSessionConflict('resume', 'own-id'), AD_ERROR_CLASS_CONFLICT],
  [ErrTmuxNotAvailable, () => errTmuxNotAvailable(), AD_ERROR_CLASS_ENVIRONMENT],
  [ErrTmuxSessionCreate, () => errTmuxSessionCreate(), AD_ERROR_CLASS_LAUNCH_FAILURE],
  [ErrSpawnNotFound, () => errSpawnNotFound(), AD_ERROR_CLASS_STATE],
  [ErrInstanceIdCollision, () => errInstanceIdCollision(), AD_ERROR_CLASS_STATE],
  [ErrSpawnNotResumable, () => errSpawnNotResumable(), AD_ERROR_CLASS_STATE],
  [ErrSpawnNotInteractive, () => errSpawnNotInteractive(), AD_ERROR_CLASS_STATE],
  [ErrSpawnNotPausable, () => errSpawnNotPausable(), AD_ERROR_CLASS_STATE],
  [ErrNoSessionId, () => errNoSessionId(), AD_ERROR_CLASS_STATE],
  [ErrJsonlMissing, () => errJsonlMissing(), AD_ERROR_CLASS_STATE],
  [ErrJsonlNeverWritten, () => errJsonlNeverWritten(), AD_ERROR_CLASS_STATE],
  [ErrInvalidFlags, () => errInvalidFlags(), AD_ERROR_CLASS_STATE],
  [ErrCwdNotFound, () => errCwdNotFound(), AD_ERROR_CLASS_DIRECTORY],
  [ErrCwdNotADirectory, () => errCwdNotADirectory(), AD_ERROR_CLASS_DIRECTORY],
]

/** The by-class rows labelled by their stub value's `errName`. */
const NAMED_CLASS_ROWS = BY_CLASS_ROWS.map(([errorClass, build, expected]) => [build().errName, errorClass, build, expected] as const)

/**
 * The three look-alikes of a class's stub value, none an instance of it: a
 * base `AgentDirectorError` with its `errName` and description (UNCLASSIFIED,
 * reporting both, as every other agent-director error), an `Error` named for
 * it and an object with its fields (neither an agent-director error:
 * UNAVAILABLE).
 */
const LOOK_ALIKES: ReadonlyArray<readonly [label: string, make: (like: AgentDirectorError) => unknown, expected: (like: AgentDirectorError) => AdErrorClassification]> = [
  [
    'a base AgentDirectorError whose errName is',
    (like) => errGeneric(like.verb, like.errName, like.errDescription),
    (like) => ({ errorClass: AD_ERROR_CLASS_UNCLASSIFIED, reportedName: like.errName, message: like.errDescription }),
  ],
  ['an Error named', (like) => Object.assign(plainErrorNamed(like.errName), { message: like.errDescription }), () => ({ errorClass: AD_ERROR_CLASS_UNAVAILABLE })],
  [
    'an object shaped like',
    (like) => ({ verb: like.verb, errName: like.errName, errDescription: like.errDescription, name: like.errName }),
    () => ({ errorClass: AD_ERROR_CLASS_UNAVAILABLE }),
  ],
]

describe('classifyAdError: by class', () => {
  test.each(NAMED_CLASS_ROWS)('the stub\'s %s is an instance of its class and is %s', (_name, errorClass, build, expected) => {
    const value = build()
    expect(value).toBeInstanceOf(errorClass)
    expect(isAdErrorInstance(value, errorClass)).toBe(true)
    expect(classifyAdError(value).errorClass).toBe(expected)
  })

  test('the table holds every class SRJ-104 decides: each classified row that is an agent-director error, CSCB\'s wrapper aside, is an instance of one of its classes', () => {
    const decided = ROWS
      .filter(([, , expected]) => expected !== AD_ERROR_CLASS_UNCLASSIFIED)
      .map(([label, build]) => [label, build()] as const)
      .filter(([, value]) => value instanceof AgentDirectorError && value.errName !== CSCB_UNKNOWN_ERROR_NAME)
    expect(decided.length).toBeGreaterThan(0)
    for (const [label, value] of decided) {
      expect({ label, covered: BY_CLASS_ROWS.some(([errorClass]) => value instanceof errorClass) }).toEqual({ label, covered: true })
    }
    expect(BY_CLASS_ROWS.filter(([, , expected]) => expected === AD_ERROR_CLASS_GONE).map(([errorClass]) => errorClass)).toEqual([
      ...AD_GONE_ERROR_CLASSES,
    ])
  })

  test.each(
    NAMED_CLASS_ROWS.flatMap(([name, errorClass, build, expected]) =>
      LOOK_ALIKES.map(([form, make, answer]) => [`${form} ${name}`, expected, errorClass, build, make, answer] as const),
    ),
  )('%s is not of that class (whose answer is %s)', (_label, _expected, errorClass, build, make, answer) => {
    const like = build()
    const value = make(like)
    expect(isAdErrorInstance(value, errorClass)).toBe(false)
    expect(classifyAdError(value)).toEqual(answer(like))
  })

  test('a value whose name is a Phase-1-only name but which is an ErrSpawnNotFound is STATE', () => {
    const err = errSpawnNotFound()
    err.name = ERR_TMUX_SESSION_CONFLICT_NAME
    expect(classifyAdError(err)).toEqual({ errorClass: AD_ERROR_CLASS_STATE })
  })

  test('an ErrTmuxCaptureFailed behind a proxy whose every read throws is still GONE: instanceof reads no property', () => {
    const value = new Proxy(errTmuxCaptureFailed(), { get: () => { throw new Error('boom') } })
    expect(classifyAdError(value)).toEqual({ errorClass: AD_ERROR_CLASS_GONE })
  })
})

// ---------------------------------------------------------------------------
// Builder shape (SRJ-1303)
// ---------------------------------------------------------------------------

/** Every CONFLICT case word, and every word ADSRD SR-1.4 sets beside one. */
const CONFLICT_WORDS: readonly string[] = [
  CONFLICT_CONFLICTING_LABELS_PHRASE,
  CONFLICT_PANE_NOT_FOUND_PHRASE,
  CONFLICT_NOT_THIS_LAUNCH_PHRASE,
  CONFLICT_LEFTOVER_PHRASE,
  CONFLICT_NEVER_REPORTED_IN_PHRASE,
  CONFLICT_OWN_ID_PHRASE,
  CONFLICT_NO_VALID_ID_PHRASE,
  CONFLICT_DIFFERENT_ID_PHRASE,
  CONFLICT_ANOTHER_STORE_PHRASE,
  PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE,
  PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE,
  NEW_ROW_ENDED_PHRASE,
  NOTHING_WRITTEN_PHRASE,
  PANE_NOT_ADOPTED_PHRASE,
  NO_KILL_SENT_PHRASE,
]

/** The words each case carries from a verb other than `kill` and with no options (ADSRD SR-1.4 with its extras). */
const CASE_WORDS: Readonly<Record<ConflictCase, readonly string[]>> = {
  'no-valid-id': [CONFLICT_NO_VALID_ID_PHRASE],
  'different-id': [CONFLICT_DIFFERENT_ID_PHRASE],
  'another-store': [CONFLICT_ANOTHER_STORE_PHRASE],
  'own-id': [CONFLICT_OWN_ID_PHRASE],
  'leftover': [CONFLICT_LEFTOVER_PHRASE],
  'scan-leftover': [CONFLICT_LEFTOVER_PHRASE, NOTHING_WRITTEN_PHRASE],
  'duplicate-session-leftover': [CONFLICT_LEFTOVER_PHRASE, PLAIN_SPAWN_LABEL_NAMES_THIS_ID_PHRASE, NEW_ROW_ENDED_PHRASE],
  'not-this-launch': [CONFLICT_NOT_THIS_LAUNCH_PHRASE],
  'pane-not-found': [CONFLICT_PANE_NOT_FOUND_PHRASE, CONFLICT_OWN_ID_PHRASE],
  'conflicting-labels': [CONFLICT_CONFLICTING_LABELS_PHRASE],
  'never-reported-in': [CONFLICT_NEVER_REPORTED_IN_PHRASE, CONFLICT_OWN_ID_PHRASE, NO_KILL_SENT_PHRASE],
  'unrecognised': [],
}

/** The two cases whose session must not be ended: they point to no "Operator actions" (ADSRD SR-1.4; SRJ-1004). */
const NO_POINTER_CASES: readonly ConflictCase[] = ['different-id', 'another-store']

/** A session name other than the default, to show the builders carry the one they are given. */
const OTHER_SESSION_NAME = `${STUB_TMUX_SESSION_NAME}_other`

/**
 * The `list --tmux-session-name` line naming `sessionName`: agent-director
 * puts it in every CONFLICT message, including the two with no "Operator
 * actions" pointer (handoff; SRJ-1303).
 */
function listLineFor(sessionName: string): string {
  return `list --tmux-session-name ${JSON.stringify(sessionName)}`
}

function wordsIn(description: string): string[] {
  return CONFLICT_WORDS.filter((w) => description.includes(w)).sort()
}

/**
 * The description with the one allowed "no kill was sent" removed: any other
 * mention of a kill in a CONFLICT description names a command that ends a
 * session (SRJ-507).
 */
function withoutNoKillSent(description: string): string {
  return description.replace(NO_KILL_SENT_PHRASE, '')
}

/** The builder calls the options argument selects, with the words each carries and whether it points to "Operator actions". */
const CONFLICT_VARIANTS: ReadonlyArray<readonly [label: string, verb: string, c: ConflictCase, options: ConflictOptions, words: readonly string[], pointer: boolean]> = [
  [
    'different-id, plain spawn',
    'spawn',
    'different-id',
    { plainSpawn: true },
    [CONFLICT_DIFFERENT_ID_PHRASE, PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE, NEW_ROW_ENDED_PHRASE],
    false,
  ],
  [
    'another-store, plain spawn',
    'spawn',
    'another-store',
    { plainSpawn: true },
    [CONFLICT_ANOTHER_STORE_PHRASE, PLAIN_SPAWN_LABEL_NOT_THIS_ID_PHRASE, NEW_ROW_ENDED_PHRASE],
    false,
  ],
  [
    'pane-not-found, not adopted',
    'read-pane',
    'pane-not-found',
    { notAdopted: true },
    [CONFLICT_PANE_NOT_FOUND_PHRASE, CONFLICT_OWN_ID_PHRASE, PANE_NOT_ADOPTED_PHRASE],
    true,
  ],
  [
    'conflicting-labels, scan',
    'spawn',
    'conflicting-labels',
    { scan: true },
    [CONFLICT_CONFLICTING_LABELS_PHRASE, NOTHING_WRITTEN_PHRASE],
    true,
  ],
]

/** Each option key with the cases it applies to (SRJ-1303). */
const OPTION_CASES: ReadonlyArray<readonly [keyof ConflictOptions, readonly ConflictCase[]]> = [
  ['plainSpawn', ['different-id', 'another-store']],
  ['notAdopted', ['pane-not-found']],
  ['scan', ['conflicting-labels']],
]

/**
 * Every builder of the three Phase-1-only errors, with the binding of
 * `src/agent-director-errors.ts` it builds on, its name constant and the verb
 * it carries.
 */
const PHASE1_BUILDS: ReadonlyArray<readonly [label: string, errorClass: AdErrorConstructor, name: string, verb: string, build: () => AgentDirectorError]> = [
  ['errTmuxUnresponsive', ErrTmuxUnresponsive, ERR_TMUX_UNRESPONSIVE_NAME, 'kill', () => errTmuxUnresponsive('kill')],
  ['errTmuxUnresponsiveAfterDuplicateSession', ErrTmuxUnresponsive, ERR_TMUX_UNRESPONSIVE_NAME, 'resume', () => errTmuxUnresponsiveAfterDuplicateSession('resume')],
  ['errTmuxUnresponsiveLaunchTimeout', ErrTmuxUnresponsive, ERR_TMUX_UNRESPONSIVE_NAME, 'spawn', () => errTmuxUnresponsiveLaunchTimeout('spawn')],
  ['errTmuxUnresponsiveStillStopping', ErrTmuxUnresponsive, ERR_TMUX_UNRESPONSIVE_NAME, 'resume', () => errTmuxUnresponsiveStillStopping('resume')],
  ['errTmuxUnresponsiveStillStarting', ErrTmuxUnresponsive, ERR_TMUX_UNRESPONSIVE_NAME, 'resume', () => errTmuxUnresponsiveStillStarting('resume')],
  ['errTmuxUnresponsiveNewRowEnded', ErrTmuxUnresponsive, ERR_TMUX_UNRESPONSIVE_NAME, 'spawn', () => errTmuxUnresponsiveNewRowEnded('spawn')],
  ...KILL_FAILED_DESCRIPTIONS.map((d) => [`errTmuxKillFailed (${d})`, ErrTmuxKillFailed, ERR_TMUX_KILL_FAILED_NAME, 'kill', () => errTmuxKillFailed(STUB_TMUX_SESSION_NAME, d)] as const),
  ...CONFLICT_CASES.map((c) => [`errTmuxSessionConflict (${c})`, ErrTmuxSessionConflict, ERR_TMUX_SESSION_CONFLICT_NAME, 'read-pane', () => errTmuxSessionConflict('read-pane', c)] as const),
]

/**
 * One row per `ErrTmuxKillFailed` description, and one for the survivor
 * description with the worker-and-survivor option, each with the default
 * pids: the survivor pids its survivor clause names (none for the three
 * descriptions without one) and whether it names the worker's pid. The forms
 * are agent-director 0.11.0-rc.1's (commit `d787cb4`,
 * `pkg/api/kill_errors.go`): the worker's pid is named in the
 * `outlived-exit-wait` and `no-session-no-kill` descriptions and beside the
 * survivor clause with the option, and is never a survivor.
 */
const KILL_FAILED_BUILDS: ReadonlyArray<
  readonly [label: string, build: (sessionName: string) => AgentDirectorError, survivors: readonly number[], namesWorker: boolean]
> = [
  ...KILL_FAILED_DESCRIPTIONS.map(
    (d) =>
      [
        d,
        (sessionName: string) => errTmuxKillFailed(sessionName, d),
        d === 'pane-process-survived' ? STUB_SURVIVOR_PIDS : [],
        d === 'outlived-exit-wait' || d === 'no-session-no-kill',
      ] as const,
  ),
  [
    'pane-process-survived, worker also running',
    (sessionName: string) => errTmuxKillFailed(sessionName, 'pane-process-survived', STUB_SURVIVOR_PIDS, { workerAlsoRunning: true }),
    STUB_SURVIVOR_PIDS,
    true,
  ],
]

describe('stub builders: shape (SRJ-1303)', () => {
  test.each(PHASE1_BUILDS)(
    '%s builds an instance of its binding, with the name constant as errName, its verb and a description',
    (_label, errorClass, name, verb, build) => {
      const err = build()
      expect(err).toBeInstanceOf(errorClass)
      expect(err).toBeInstanceOf(AgentDirectorError)
      expect(err.errName).toBe(name)
      expect(err.verb).toBe(verb)
      expect(typeof err.errDescription).toBe('string')
      expect(err.errDescription).not.toBe('')
    },
  )

  test.each(KILL_FAILED_BUILDS)(
    'errTmuxKillFailed (%s) carries the quoted session name and verb kill, and ends "retry kill later", then "never delete this row"',
    (_label, build) => {
      const err = build(OTHER_SESSION_NAME)
      expect(err.verb).toBe('kill')
      expect(err.errDescription).toContain(JSON.stringify(OTHER_SESSION_NAME))
      expect(err.errDescription).toContain(RETRY_KILL_LATER_PHRASE)
      expect(err.errDescription.endsWith(NEVER_DELETE_ROW_PHRASE)).toBe(true)
      expect(err.errDescription.lastIndexOf(RETRY_KILL_LATER_PHRASE)).toBeLessThan(err.errDescription.lastIndexOf(NEVER_DELETE_ROW_PHRASE))
    },
  )

  test('the four errTmuxKillFailed descriptions differ', () => {
    const texts = KILL_FAILED_DESCRIPTIONS.map((d) => errTmuxKillFailed(STUB_TMUX_SESSION_NAME, d).errDescription)
    expect(texts).toHaveLength(4)
    expect(new Set(texts).size).toBe(KILL_FAILED_DESCRIPTIONS.length)
  })

  test.each(KILL_FAILED_BUILDS)(
    'errTmuxKillFailed (%s): SURVIVOR_PID_PATTERN matches only a survivor clause, survivorPids reads its pids, and the worker\'s pid is never among them',
    (_label, build, survivors, namesWorker) => {
      const { errDescription } = build(STUB_TMUX_SESSION_NAME)
      expect(STUB_SURVIVOR_PIDS).not.toContain(STUB_WORKER_PID)
      expect(SURVIVOR_PID_PATTERN.test(errDescription)).toBe(survivors.length > 0)
      expect(survivorPids(errDescription)).toEqual([...survivors])
      expect(errDescription.includes(String(STUB_WORKER_PID))).toBe(namesWorker)
      expect(survivorPids(errDescription)).not.toContain(STUB_WORKER_PID)
    },
  )

  test.each(
    (
      [
        ['one pid', [4194401], SURVIVOR_CLAUSE_ONE_PHRASE, SURVIVOR_CLAUSE_MANY_PHRASE],
        ['two pids, in the order given', [4194403, 4194402], SURVIVOR_CLAUSE_MANY_PHRASE, SURVIVOR_CLAUSE_ONE_PHRASE],
        ['three pids, in the order given', [4194404, 4194401, 4194403], SURVIVOR_CLAUSE_MANY_PHRASE, SURVIVOR_CLAUSE_ONE_PHRASE],
      ] as const
    ).flatMap(([label, pids, clause, otherClause]) => [false, true].map((workerAlsoRunning) => [label, workerAlsoRunning, pids, clause, otherClause] as const)),
  )(
    'the survivor description built with %s (worker also running: %p) carries its clause\'s words and names each pid once, in order, never the worker\'s',
    (_label, workerAlsoRunning, pids, clause, otherClause) => {
      const { errDescription } = errTmuxKillFailed(STUB_TMUX_SESSION_NAME, 'pane-process-survived', pids, { workerAlsoRunning })
      expect(errDescription).toContain(clause)
      expect(errDescription).not.toContain(otherClause)
      expect(SURVIVOR_PID_PATTERN.test(errDescription)).toBe(true)
      expect(survivorPids(errDescription)).toEqual([...pids])
      expect(errDescription.includes(String(STUB_WORKER_PID))).toBe(workerAlsoRunning)
      expect(survivorPids(errDescription)).not.toContain(STUB_WORKER_PID)
    },
  )

  test.each(KILL_FAILED_DESCRIPTIONS.filter((d) => d !== 'pane-process-survived'))(
    'errTmuxKillFailed (%s) ignores the pids it is given and names none',
    (d) => {
      expect(survivorPids(errTmuxKillFailed(STUB_TMUX_SESSION_NAME, d, [4194401, 4194402]).errDescription)).toEqual([])
    },
  )

  test('errTmuxKillFailed (pane-process-survived) given no pids throws', () => {
    expect(() => errTmuxKillFailed(STUB_TMUX_SESSION_NAME, 'pane-process-survived', [])).toThrow('one or more pids')
  })

  test.each(KILL_FAILED_DESCRIPTIONS.filter((d) => d !== 'pane-process-survived'))(
    'errTmuxKillFailed (%s) with the worker-and-survivor option throws',
    (d) => {
      expect(() => errTmuxKillFailed(STUB_TMUX_SESSION_NAME, d, STUB_SURVIVOR_PIDS, { workerAlsoRunning: true })).toThrow('workerAlsoRunning')
    },
  )

  test.each([...CONFLICT_CASES])('errTmuxSessionConflict (%s) carries the verb, the quoted name and exactly its case words', (c) => {
    const err = errTmuxSessionConflict('resume', c, OTHER_SESSION_NAME)
    expect(err.verb).toBe('resume')
    expect(err.errDescription).toContain(JSON.stringify(OTHER_SESSION_NAME))
    expect(wordsIn(err.errDescription)).toEqual([...CASE_WORDS[c]].sort())
    expect(withoutNoKillSent(err.errDescription)).not.toMatch(/kill/i)
  })

  test.each([...CONFLICT_CASES])('errTmuxSessionConflict (%s) gives the list --tmux-session-name line naming the session', (c) => {
    expect(errTmuxSessionConflict('resume', c, OTHER_SESSION_NAME).errDescription).toContain(listLineFor(OTHER_SESSION_NAME))
  })

  test.each(CONFLICT_CASES.map((c) => [c, !NO_POINTER_CASES.includes(c)] as const))(
    'errTmuxSessionConflict (%s) points to "Operator actions": %p',
    (c, pointer) => {
      expect(errTmuxSessionConflict('resume', c).errDescription.includes('Operator actions')).toBe(pointer)
    },
  )

  test.each([...NO_POINTER_CASES])(
    'errTmuxSessionConflict (%s) says the session must not be ended and gives the list --tmux-session-name line',
    (c) => {
      const { errDescription } = errTmuxSessionConflict('resume', c, OTHER_SESSION_NAME)
      expect(errDescription).toContain('must not be ended')
      expect(errDescription).toContain(listLineFor(OTHER_SESSION_NAME))
    },
  )

  test('errTmuxSessionConflict (scan-leftover) names the session\'s tmux id and says no row was ended', () => {
    const { errDescription } = errTmuxSessionConflict('spawn', 'scan-leftover', OTHER_SESSION_NAME)
    expect(errDescription).toContain(STUB_TMUX_SESSION_ID)
    expect(errDescription).not.toMatch(/ended/)
  })

  test('errTmuxSessionConflict (kill, not-this-launch) also carries this row\'s own id and "no kill was sent"', () => {
    const err = errTmuxSessionConflict('kill', 'not-this-launch', OTHER_SESSION_NAME)
    expect(err.verb).toBe('kill')
    expect(err.errDescription).toContain(JSON.stringify(OTHER_SESSION_NAME))
    expect(wordsIn(err.errDescription)).toEqual([CONFLICT_NOT_THIS_LAUNCH_PHRASE, CONFLICT_OWN_ID_PHRASE, NO_KILL_SENT_PHRASE].sort())
    expect(err.errDescription).toContain(listLineFor(OTHER_SESSION_NAME))
    expect(withoutNoKillSent(err.errDescription)).not.toMatch(/kill/i)
  })

  test.each(CONFLICT_VARIANTS)(
    'errTmuxSessionConflict (%s) carries the quoted name and exactly its words',
    (_label, verb, c, options, words, pointer) => {
      const err = errTmuxSessionConflict(verb, c, OTHER_SESSION_NAME, options)
      expect(err.verb).toBe(verb)
      expect(err.errDescription).toContain(JSON.stringify(OTHER_SESSION_NAME))
      expect(wordsIn(err.errDescription)).toEqual([...words].sort())
      expect(err.errDescription).toContain(listLineFor(OTHER_SESSION_NAME))
      expect(err.errDescription.includes('Operator actions')).toBe(pointer)
      expect(withoutNoKillSent(err.errDescription)).not.toMatch(/kill/i)
    },
  )

  test.each(
    OPTION_CASES.flatMap(([key, cases]) =>
      CONFLICT_CASES.filter((c) => !cases.includes(c)).map((c) => [key, c] as const),
    ),
  )('errTmuxSessionConflict with %s on %s throws', (key, c) => {
    expect(() => errTmuxSessionConflict('spawn', c, STUB_TMUX_SESSION_NAME, { [key]: true })).toThrow(key)
  })

  test.each([
    ['plain', () => errTmuxUnresponsive('kill'), 'kill', []],
    ['launch timeout (spawn)', () => errTmuxUnresponsiveLaunchTimeout('spawn'), 'spawn', [LAUNCH_TIMEOUT_PHRASE]],
    ['launch timeout (resume)', () => errTmuxUnresponsiveLaunchTimeout('resume'), 'resume', [LAUNCH_TIMEOUT_PHRASE]],
    ['still stopping', () => errTmuxUnresponsiveStillStopping('resume', OTHER_SESSION_NAME), 'resume', [STILL_STOPPING_PHRASE, JSON.stringify(OTHER_SESSION_NAME)]],
    ['still starting', () => errTmuxUnresponsiveStillStarting('resume', OTHER_SESSION_NAME), 'resume', [STILL_STARTING_PHRASE, JSON.stringify(OTHER_SESSION_NAME)]],
    ['new row ended (HO rev 26)', () => errTmuxUnresponsiveNewRowEnded(), 'spawn', [NEW_ROW_ENDED_PHRASE, NEW_ROW_ENDED_RETRY, JSON.stringify(STUB_TMUX_SESSION_NAME)]],
  ] as const)('errTmuxUnresponsive %s carries the verb and its words', (_label, build, verb, words) => {
    const err = build()
    expect(err.verb).toBe(verb)
    for (const w of words) expect(err.errDescription).toContain(w)
    const variantWords = [LAUNCH_TIMEOUT_PHRASE, STILL_STOPPING_PHRASE, STILL_STARTING_PHRASE]
    expect(variantWords.filter((w) => err.errDescription.includes(w))).toEqual(
      variantWords.filter((w) => (words as readonly string[]).includes(w)),
    )
  })

  test('errTmuxNotAvailableDifferentServer carries the different-server phrase and the socket; the socket form of errTmuxNotAvailable does not carry the phrase', () => {
    const socketPath = '/tmp/tmux-1000/other'
    const different = errTmuxNotAvailableDifferentServer(socketPath)
    expect(different.errDescription).toContain(DIFFERENT_TMUX_SERVER_PHRASE)
    expect(different.errDescription).toContain(socketPath)
    expect(errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH).errDescription).not.toContain(DIFFERENT_TMUX_SERVER_PHRASE)
  })

  test('errTmuxNotAvailableNewRowEnded (HO rev 26) carries the verb, the quoted name, the new-row-ended words and the reuse_finished retry, and none of the launch-timeout, still-stopping, still-starting or different-server words', () => {
    const err = errTmuxNotAvailableNewRowEnded('spawn', OTHER_SESSION_NAME)
    expect(err.verb).toBe('spawn')
    for (const w of [NEW_ROW_ENDED_PHRASE, NEW_ROW_ENDED_RETRY, JSON.stringify(OTHER_SESSION_NAME)]) expect(err.errDescription).toContain(w)
    expect(NEW_ROW_ENDED_RETRY).toContain('reuse_finished')
    expect([LAUNCH_TIMEOUT_PHRASE, STILL_STOPPING_PHRASE, STILL_STARTING_PHRASE, DIFFERENT_TMUX_SERVER_PHRASE].filter((w) => err.errDescription.includes(w))).toEqual([])
  })

  test('errConfigMalformed names a [tmux] key, its value and its minimum', () => {
    const err = errConfigMalformed('launch_timeout_ms', '1500', '2000', 'ms')
    const description = (err.envelope as { err_description: string }).err_description
    expect(description).toContain('[tmux] launch_timeout_ms = 1500')
    expect(description).toContain('2000 ms')
  })

  test.each([...UNUSABLE_NAME_FAULTS])('errUnusableName (%s) is an ErrInternal carrying the phrase', (f) => {
    const err = errUnusableName(f)
    expect(err.unknownName).toBe(ERR_INTERNAL)
    expect((err.envelope as { err_description: string }).err_description).toContain(UNUSABLE_RECORDED_NAME_PHRASE)
  })

  test.each([
    ['errInternal', () => errInternal('the store could not be read'), ERR_INTERNAL, 'the store could not be read'],
    ['errUnknownErrorName', () => errUnknownErrorName('ErrFromALaterBinary', 'later words'), 'ErrFromALaterBinary', 'later words'],
    ['errSchemaMismatch', () => errSchemaMismatch('store words'), ERR_SCHEMA_MISMATCH_NAME, 'store words'],
  ] as const)('%s puts the name and description where the client does', (_label, build, name, description) => {
    const err = build()
    const envelope = { err_name: name, err_description: description }
    const asClientBuildsIt = new ErrUnknownErrorName(name, envelope)
    expect(err).toBeInstanceOf(ErrUnknownErrorName)
    expect(err.errName).toBe(ErrUnknownErrorName.name)
    expect(err.unknownName).toBe(name)
    expect(err.envelope).toEqual(envelope)
    expect(err.verb).toBe(asClientBuildsIt.verb)
    expect(err.errDescription).toBe(asClientBuildsIt.errDescription)
  })
})

// ---------------------------------------------------------------------------
// The survivor-naming form
// ---------------------------------------------------------------------------

/**
 * The release candidate's `ErrTmuxKillFailed` descriptions as written: each
 * row is the full text the client delivers (agent-director's `err.Error()`,
 * `tmux: agent process still running: instance <id>: tmux session "<name>":
 * …`), copied by hand from agent-director 0.11.0-rc.1 (commit `d787cb4`,
 * `pkg/api/kill_errors.go`: `waitExpiredError`, `uncheckableError`,
 * `noPaneError`), with the survivor clause each names (none for a row
 * without one) and the pids `survivorPids` reads from it. This is the one
 * place the release candidate's wording is written out as literals, never
 * built from `src/ad-description-phrases.ts`, so a change to
 * `SURVIVOR_CLAUSE_ONE_PHRASE` or `SURVIVOR_CLAUSE_MANY_PHRASE` that
 * agent-director does not share fails here. It is the check E51 re-runs
 * against 0.11.0. The worker's pid, 4321, is never a survivor.
 */
const RC_KILL_FAILED_DESCRIPTIONS: ReadonlyArray<readonly [label: string, description: string, clause: string | undefined, survivors: readonly number[]]> = [
  [
    'worker only',
    'tmux: agent process still running: instance cscb_alpha: tmux session "slack_bot_alpha": a kill was sent to the agent\'s pane and to its labelled session, and the agent process (pid 4321) was still running after the kill exit wait of 5 s; retry kill later; never delete this row',
    undefined,
    [],
  ],
  [
    'one survivor',
    'tmux: agent process still running: instance cscb_alpha: tmux session "slack_bot_alpha": a kill was sent to the agent\'s pane and to its labelled session, and another process of a pane of the labelled session (pid 4400) was still running after the kill exit wait of 5 s; retry kill later; never delete this row',
    'another process of a pane of the labelled session (pid 4400)',
    [4400],
  ],
  [
    'several survivors',
    'tmux: agent process still running: instance cscb_alpha: tmux session "slack_bot_alpha": a kill was sent to its labelled session, and other processes of panes of the labelled session (pids 4400, 4401) were still running after the kill exit wait of 5 s; retry kill later; never delete this row',
    'other processes of panes of the labelled session (pids 4400, 4401)',
    [4400, 4401],
  ],
  [
    'the worker and one survivor',
    'tmux: agent process still running: instance cscb_alpha: tmux session "slack_bot_alpha": a kill was sent to the agent\'s pane, and the agent process (pid 4321) and another process of a pane of the labelled session (pid 4400) were still running after the kill exit wait of 0.3 s; retry kill later; never delete this row',
    'another process of a pane of the labelled session (pid 4400)',
    [4400],
  ],
  [
    'the worker and several survivors',
    'tmux: agent process still running: instance cscb_alpha: tmux session "slack_bot_alpha": a kill was sent to the agent\'s pane and to its labelled session, and the agent process (pid 4321) and other processes of panes of the labelled session (pids 4402, 4400, 4401) were still running after the kill exit wait of 5 s; retry kill later; never delete this row',
    'other processes of panes of the labelled session (pids 4402, 4400, 4401)',
    [4402, 4400, 4401],
  ],
  [
    'uncheckable',
    'tmux: agent process still running: instance cscb_alpha: tmux session "slack_bot_alpha": a kill was sent to the agent\'s pane and to its labelled session, but the agent process cannot be checked and its labelled session is still there; retry kill later; never delete this row',
    undefined,
    [],
  ],
  [
    'no session (pid N)',
    'tmux: agent process still running: instance cscb_alpha: tmux session "slack_bot_alpha": no session or pane of this launch was found while its agent process still runs (pid 4321), so no kill was sent; a human can find and look at the process, see "Operator actions" in the agent-director README; retry kill later; never delete this row',
    undefined,
    [],
  ],
]

/**
 * The survivor clause's forms are agent-director 0.11.0-rc.1's (commit
 * `d787cb4`, `pkg/api/kill_errors.go`): one survivor named after
 * `SURVIVOR_CLAUSE_ONE_PHRASE`, two or more after
 * `SURVIVOR_CLAUSE_MANY_PHRASE`. Apart from the release candidate's literal
 * descriptions (`RC_KILL_FAILED_DESCRIPTIONS`), every description is built by
 * the stub's `errTmuxKillFailed`; a clause whose words and pid form disagree
 * is a stub description with the other clause's words swapped in.
 */
describe('SURVIVOR_PID_PATTERN and survivorPids (b.jg5 SRJ-702)', () => {
  test.each(RC_KILL_FAILED_DESCRIPTIONS)(
    'the release candidate\'s description (%s): SURVIVOR_PID_PATTERN matches only its survivor clause and survivorPids reads exactly the survivor pids, never the worker\'s',
    (_label, description, clause, survivors) => {
      const matches = [...description.matchAll(new RegExp(SURVIVOR_PID_PATTERN.source, 'g'))].map((m) => m[0])
      expect(matches).toEqual(clause === undefined ? [] : [clause])
      expect(SURVIVOR_PID_PATTERN.test(description)).toBe(clause !== undefined)
      expect(survivorPids(description)).toEqual([...survivors])
      expect(survivorPids(description)).not.toContain(4321)
    },
  )

  const oneSurvivor = errTmuxKillFailed(STUB_TMUX_SESSION_NAME, 'pane-process-survived', [4194401]).errDescription
  const twoSurvivors = errTmuxKillFailed(STUB_TMUX_SESSION_NAME, 'pane-process-survived', [4194403, 4194402]).errDescription

  test('SURVIVOR_PID_PATTERN has no flags, so .test() keeps no state between calls', () => {
    expect(SURVIVOR_PID_PATTERN.flags).toBe('')
  })

  test.each([
    ['one survivor', oneSurvivor],
    ['two survivors', twoSurvivors],
  ])('two .test() calls in a row on the %s description both match', (_label, description) => {
    expect(SURVIVOR_PID_PATTERN.test(description)).toBe(true)
    expect(SURVIVOR_PID_PATTERN.test(description)).toBe(true)
  })

  test.each([
    ['rapid 12', 'rapid 12'],
    ['pid', 'pid'],
    ['pid x', 'pid x'],
    ['a kill was sent', 'a kill was sent'],
    ['a bare pid with no clause words', `pid ${STUB_WORKER_PID}`],
    ['the one-survivor words with no pid', SURVIVOR_CLAUSE_ONE_PHRASE],
    ['the several-survivors words with no pids', SURVIVOR_CLAUSE_MANY_PHRASE],
    ['the one-survivor words before a list of pids', twoSurvivors.replace(SURVIVOR_CLAUSE_MANY_PHRASE, SURVIVOR_CLAUSE_ONE_PHRASE)],
    ['the several-survivors words before a single pid', oneSurvivor.replace(SURVIVOR_CLAUSE_ONE_PHRASE, SURVIVOR_CLAUSE_MANY_PHRASE)],
  ])('SURVIVOR_PID_PATTERN does not match %s, and survivorPids reads none from it', (_label, text) => {
    expect(SURVIVOR_PID_PATTERN.test(text)).toBe(false)
    expect(survivorPids(text)).toEqual([])
  })

  test('survivorPids lists every pid of the several-survivors clause in order, the same on two calls in a row', () => {
    expect(survivorPids(twoSurvivors)).toEqual([4194403, 4194402])
    expect(survivorPids(twoSurvivors)).toEqual([4194403, 4194402])
  })
})

// ---------------------------------------------------------------------------
// Reported name and message
// ---------------------------------------------------------------------------

describe('classifyAdError: reported name and message', () => {
  test('an ErrUnknownErrorName reports its unknownName and its envelope description', () => {
    expect(classifyAdError(errInternal('the store could not be read'))).toEqual({
      errorClass: AD_ERROR_CLASS_UNCLASSIFIED,
      reportedName: ERR_INTERNAL,
      message: 'the store could not be read',
    })
  })

  test('an error of its own class reports its errName and its errDescription', () => {
    const err = errSendKeysWhileRelayed()
    expect(classifyAdError(err)).toEqual({
      errorClass: AD_ERROR_CLASS_UNCLASSIFIED,
      reportedName: err.errName,
      message: err.errDescription,
    })
  })

  test('a description carrying a token comes out redacted in every reporting class', async () => {
    const secret = `failed (${sentinelInMessage('desc')})`
    const redacted = `failed (${REDACTED_SENTINEL_TAIL})`
    // Every error also carries the sentinel bare where nothing is reported: a
    // `note` property and, on the ErrUnknownErrorName forms, an extra
    // envelope key.
    const unknownNamed = (name: string, description: string): ErrUnknownErrorName =>
      Object.assign(
        new ErrUnknownErrorName(name, { err_name: name, err_description: description, detail: LEAK_SENTINEL }),
        { note: LEAK_SENTINEL },
      )
    const secretOf = <T extends AgentDirectorError>(value: T): T => Object.assign(withErrDescription(value, secret), { note: LEAK_SENTINEL })
    const cases = [
      [classifyAdError(unknownNamed(ERR_INTERNAL, secret)), ERR_INTERNAL, redacted],
      [
        classifyAdError(unknownNamed(ERR_INTERNAL, `${UNUSABLE_RECORDED_NAME_PHRASE} ${secret}`)),
        ERR_INTERNAL,
        `${UNUSABLE_RECORDED_NAME_PHRASE} ${redacted}`,
      ],
      [classifyAdError(unknownNamed(ERR_CONFIG_MALFORMED, secret)), ERR_CONFIG_MALFORMED, redacted],
      [classifyAdError(secretOf(errSendKeysWhileRelayed())), errSendKeysWhileRelayed().errName, redacted],
      [
        (await classifyWithInvalidFlagsRecheck(secretOf(errInvalidFlags()), recordingTrigger(PASS).trigger)).classification,
        errInvalidFlags().errName,
        redacted,
      ],
    ] as const
    const lines = cases.map(([c]) => describeAdErrorClassification(c))
    expect(cases.map(([c]) => c.errorClass)).toEqual([
      AD_ERROR_CLASS_UNCLASSIFIED,
      AD_ERROR_CLASS_UNUSABLE_NAME,
      AD_ERROR_CLASS_CONFIG,
      AD_ERROR_CLASS_UNCLASSIFIED,
      AD_ERROR_CLASS_UNCLASSIFIED,
    ])
    for (const [c] of cases) expect(REPORTING_CLASSES).toContain(c.errorClass)
    expect(lines).toEqual(
      cases.map(([c, name, message]) => `class=${c.errorClass} name=${name} message=${JSON.stringify(message)}`),
    )
    assertNoLeak({ classifications: cases.map(([c]) => c), lines })
  })

  test('a multi-line description comes out on one line', () => {
    const { message } = classifyAdError(errInternal('first line\nsecond line\r\nthird line'))
    expect(message).toBe('first line second line third line')
  })

  test('a description longer than MAX_LOGGED_MESSAGE_LENGTH is capped', () => {
    const long = 'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH * 2)
    const { message } = classifyAdError(errConfigMalformed(long))
    expect(message).toHaveLength(MAX_LOGGED_MESSAGE_LENGTH)
  })

  test.each([
    ['token-shaped', () => fakeToken(BOT_TOKEN_PREFIX, 'name')],
    ['with a space', () => 'Err Name'],
    ['overlong', () => `Err${'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH)}`],
  ])('an unsafe errName (%s) is never reported', (_label, buildName) => {
    const name = buildName()
    const classification = classifyAdError(baseError(name))
    expect(classification.errorClass).toBe(AD_ERROR_CLASS_UNCLASSIFIED)
    expect(classification.reportedName).toBeUndefined()
    const line = describeAdErrorClassification(classification)
    expect(line).not.toContain(name)
    assertNoLeak({ classification, line })
  })

  test('an unknownName carrying a token is UNAVAILABLE and reports nothing', () => {
    const classification = classifyAdError(errUnknownErrorName(fakeToken(BOT_TOKEN_PREFIX, 'unknown'), sentinelInMessage('d')))
    expect(classification).toEqual({ errorClass: AD_ERROR_CLASS_UNAVAILABLE })
    assertNoLeak(classification)
  })

  test('describeAdErrorClassification renders the class, the name and the JSON-quoted message', () => {
    const classification = classifyAdError(errInternal('said "no"'))
    expect(describeAdErrorClassification(classification)).toBe(
      `class=${AD_ERROR_CLASS_UNCLASSIFIED} name=${ERR_INTERNAL} message=${JSON.stringify('said "no"')}`,
    )
    expect(describeAdErrorClassification(classifyAdError(errTmuxSendKeys()))).toBe(`class=${AD_ERROR_CLASS_GONE}`)
  })

  test('the redaction placeholder is what stands in for the token', () => {
    const { message } = classifyAdError(errInternal(`token ${fakeToken(BOT_TOKEN_PREFIX, 'bare')} here`))
    expect(message).toBe(`token ${REDACTED_TOKEN_PLACEHOLDER} here`)
    assertNoLeak(message)
  })
})

// ---------------------------------------------------------------------------
// Values that fight back: nothing throws
// ---------------------------------------------------------------------------

describe('classifyAdError: never throws', () => {
  test.each([
    [
      'an ErrSpawnNotFound whose errName getter throws (the class decides)',
      () => Object.defineProperty(errSpawnNotFound(), 'errName', { get: () => { throw new Error('boom') } }),
      { errorClass: AD_ERROR_CLASS_STATE },
    ],
    [
      'a base error whose errName getter throws',
      () => Object.defineProperty(baseError(ERR_SPAWN_NOT_FOUND_NAME), 'errName', { get: () => { throw new Error('boom') } }),
      { errorClass: AD_ERROR_CLASS_UNCLASSIFIED, message: baseError(ERR_SPAWN_NOT_FOUND_NAME).errDescription },
    ],
    [
      'an envelope whose err_description getter throws',
      () => unknownWithEnvelope(ERR_INTERNAL, Object.defineProperty({}, 'err_description', { get: () => { throw new Error('boom') } })),
      { errorClass: AD_ERROR_CLASS_UNCLASSIFIED, reportedName: ERR_INTERNAL },
    ],
    [
      'a proxy whose every trap throws',
      () => new Proxy({}, { get: () => { throw new Error('boom') }, getPrototypeOf: () => { throw new Error('boom') } }),
      { errorClass: AD_ERROR_CLASS_UNAVAILABLE },
    ],
  ] as const)('%s', (_label, build, expected) => {
    expect(classifyAdError(build())).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// isInvalidFlagsError
// ---------------------------------------------------------------------------

describe('isInvalidFlagsError', () => {
  test.each([
    ['the client\'s ErrInvalidFlags', true, () => errInvalidFlags()],
    ['the client\'s ErrInvalidFlags whose errName getter throws (the class decides)', true, () => Object.defineProperty(errInvalidFlags(), 'errName', { get: () => { throw new Error('boom') } })],
    ['a base error with that errName', false, () => baseError(errInvalidFlags().errName)],
    ['an Error named ErrInvalidFlags', false, () => plainErrorNamed(errInvalidFlags().errName)],
    ['an object with that errName', false, () => ({ errName: errInvalidFlags().errName })],
    ['another agent-director error', false, () => errSpawnNotFound()],
    ['undefined', false, () => undefined],
    ['a proxy whose every trap throws', false, () => hostileProxy()],
  ])('%s → %p', (_label, expected, build) => {
    expect(isInvalidFlagsError(build())).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// isAdErrorInstance and goneErrNameOf
// ---------------------------------------------------------------------------

describe('isAdErrorInstance', () => {
  test.each<[string, boolean, () => unknown, AdErrorConstructor]>([
    ['errSpawnNotFound against ErrSpawnNotFound', true, () => errSpawnNotFound(), ErrSpawnNotFound],
    ['errSpawnNotFound against the base AgentDirectorError', true, () => errSpawnNotFound(), AgentDirectorError],
    ['errTmuxKillFailed against the ErrTmuxKillFailed binding', true, () => errTmuxKillFailed(), ErrTmuxKillFailed],
    ['errTmuxUnresponsive against the ErrTmuxUnresponsive binding', true, () => errTmuxUnresponsive(), ErrTmuxUnresponsive],
    ['errTmuxSessionConflict against the ErrTmuxSessionConflict binding', true, () => errTmuxSessionConflict('resume', 'own-id'), ErrTmuxSessionConflict],
    ['an ErrSpawnNotFound whose errName getter throws (the class decides)', true, () => Object.defineProperty(errSpawnNotFound(), 'errName', { get: () => { throw new Error('boom') } }), ErrSpawnNotFound],
    ['an ErrUnknownErrorName carrying ErrTmuxKillFailed', false, () => errUnknownErrorName(ERR_TMUX_KILL_FAILED_NAME), ErrTmuxKillFailed],
    ['errSpawnNotFound against ErrTmuxKillFailed', false, () => errSpawnNotFound(), ErrTmuxKillFailed],
    ['errTmuxKillFailed against ErrSpawnNotFound', false, () => errTmuxKillFailed(), ErrSpawnNotFound],
    ['errTmuxUnresponsive against ErrTmuxKillFailed', false, () => errTmuxUnresponsive(), ErrTmuxKillFailed],
    ['an agent-director error whose name, not class, matches', false, () => Object.assign(baseError(ERR_INTERNAL), { name: ERR_SPAWN_NOT_FOUND_NAME }), ErrSpawnNotFound],
    ['undefined', false, () => undefined, ErrSpawnNotFound],
    ['a string of that name', false, () => ERR_SPAWN_NOT_FOUND_NAME, ErrSpawnNotFound],
    ['a proxy whose every trap throws', false, () => hostileProxy(), ErrSpawnNotFound],
  ])('%s → %p', (_label, expected, build, errorClass) => {
    const value = build()
    expect(() => isAdErrorInstance(value, errorClass)).not.toThrow()
    expect(isAdErrorInstance(value, errorClass)).toBe(expected)
  })

  test('ERR_SPAWN_NOT_FOUND_NAME is the errName of the client\'s ErrSpawnNotFound', () => {
    expect(errSpawnNotFound().errName).toBe(ERR_SPAWN_NOT_FOUND_NAME)
  })
})

describe('goneErrNameOf', () => {
  test('AD_GONE_ERR_NAMES labels AD_GONE_ERROR_CLASSES in order: each GONE builder\'s errName', () => {
    expect<readonly string[]>([...AD_GONE_ERR_NAMES]).toEqual([errTmuxSendKeys().errName, errTmuxCaptureFailed().errName])
    expect([...AD_GONE_ERROR_CLASSES]).toEqual([ErrTmuxSendKeys, ErrTmuxCaptureFailed])
  })

  test.each<[string, () => unknown, string | undefined]>([
    ['errTmuxSendKeys', () => errTmuxSendKeys(), errTmuxSendKeys().errName],
    ['errTmuxCaptureFailed', () => errTmuxCaptureFailed(), errTmuxCaptureFailed().errName],
    ['a base error named ErrTmuxSendKeys', () => baseError(errTmuxSendKeys().errName), undefined],
    ['an Error named ErrTmuxCaptureFailed', () => plainErrorNamed(errTmuxCaptureFailed().errName), undefined],
    ['an ErrUnknownErrorName carrying ErrTmuxSendKeys', () => errUnknownErrorName(errTmuxSendKeys().errName), undefined],
    ['errSpawnNotFound', () => errSpawnNotFound(), undefined],
    ['undefined', () => undefined, undefined],
    ['a proxy whose every trap throws', () => hostileProxy(), undefined],
  ])('%s → %p', (_label, build, expected) => {
    const value = build()
    expect(() => goneErrNameOf(value)).not.toThrow()
    expect<string | undefined>(goneErrNameOf(value)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// isDifferentTmuxServerError (b.jg5 SRJ-311, SRJ-1021)
// ---------------------------------------------------------------------------

/** `ErrTmuxNotAvailable`, as the stub's builder names it. */
const ERR_TMUX_NOT_AVAILABLE = errTmuxNotAvailable().errName

/** A socket other than the stub's default, to show the predicate does not depend on it. */
const OTHER_SOCKET_PATH = `${STUB_TMUX_SOCKET_PATH}-other`

/** A description carrying the different-server words, as the stub's builder writes it. */
const DIFFERENT_SERVER_DESCRIPTION = errTmuxNotAvailableDifferentServer().errDescription

/** The stub's different-server `ErrTmuxNotAvailable` with its `errDescription` replaced by `descriptor`. */
function differentServerWithDescription(descriptor: PropertyDescriptor): AgentDirectorError {
  return Object.defineProperty(errTmuxNotAvailableDifferentServer(), 'errDescription', descriptor)
}

describe('isDifferentTmuxServerError', () => {
  test.each<[string, () => unknown]>([
    ['the stub\'s different-server form', () => errTmuxNotAvailableDifferentServer()],
    ['the different-server form on another socket', () => errTmuxNotAvailableDifferentServer(OTHER_SOCKET_PATH)],
    ['the different-server form from read-pane', () => errTmuxNotAvailableDifferentServer(STUB_TMUX_SOCKET_PATH, 'read-pane')],
    ['an ErrTmuxNotAvailable whose description is exactly the words', () => differentServerWithDescription({ value: DIFFERENT_TMUX_SERVER_PHRASE })],
    [
      'the different-server form whose errName getter throws (the class decides)',
      () => Object.defineProperty(errTmuxNotAvailableDifferentServer(), 'errName', { get: () => { throw new Error('boom') } }),
    ],
  ])('%s is the re-bound form', (_label, build) => {
    const value = build()
    expect(classifyAdError(value).errorClass).toBe(AD_ERROR_CLASS_ENVIRONMENT)
    expect(isDifferentTmuxServerError(value)).toBe(true)
  })

  test.each<[string, () => unknown]>([
    ['plain ENVIRONMENT without a socket', () => errTmuxNotAvailable()],
    ['plain ENVIRONMENT with the stub\'s socket', () => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH)],
    ['plain ENVIRONMENT with another socket', () => errTmuxNotAvailable(OTHER_SOCKET_PATH, 'resume')],
    ['a plain spawn\'s re-lookup that could not run tmux, its new row ended (HO rev 26)', () => errTmuxNotAvailableNewRowEnded()],
  ])('%s is ENVIRONMENT but not the re-bound form', (_label, build) => {
    const value = build()
    expect(classifyAdError(value).errorClass).toBe(AD_ERROR_CLASS_ENVIRONMENT)
    expect(isDifferentTmuxServerError(value)).toBe(false)
  })

  test.each<[string, () => unknown, AdErrorClass]>([
    ['a base error named ErrTmuxNotAvailable', () => baseError(ERR_TMUX_NOT_AVAILABLE, DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_UNCLASSIFIED],
    ['an ErrTmuxUnresponsive', () => errTmuxUnresponsive('resume', DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_UNAVAILABLE],
    ['an ErrTmuxSessionConflict', () => conflictWithDescription({ value: DIFFERENT_SERVER_DESCRIPTION }), AD_ERROR_CLASS_CONFLICT],
    ['an ErrTmuxSessionCreate', () => withErrDescription(errTmuxSessionCreate(), DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_LAUNCH_FAILURE],
    ['an ErrSpawnNotFound', () => withErrDescription(errSpawnNotFound(), DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_STATE],
    ['an ErrTmuxSendKeys', () => withErrDescription(errTmuxSendKeys(), DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_GONE],
    ['CSCB\'s wrapped UnknownError', () => baseError(CSCB_UNKNOWN_ERROR_NAME, DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_UNAVAILABLE],
    ['an ErrInternal (envelope description)', () => errInternal(DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_UNCLASSIFIED],
    ['an ErrConfigMalformed (envelope description)', () => errUnknownErrorName(ERR_CONFIG_MALFORMED, DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_CONFIG],
    [
      'an ErrUnknownErrorName whose unknownName is ErrTmuxNotAvailable (envelope description)',
      () => {
        const err = errUnknownErrorName(ERR_TMUX_NOT_AVAILABLE, DIFFERENT_SERVER_DESCRIPTION)
        // Precondition: the words really are in the envelope's description.
        expect((err.envelope as { err_description: string }).err_description).toContain(DIFFERENT_TMUX_SERVER_PHRASE)
        return err
      },
      AD_ERROR_CLASS_UNAVAILABLE,
    ],
  ])('%s carrying the words is %s-classed and not the re-bound form', (_label, build, expected) => {
    const value = build()
    expect(classifyAdError(value).errorClass).toBe(expected)
    expect(isDifferentTmuxServerError(value)).toBe(false)
  })

  test.each<[string, PropertyDescriptor]>([
    ['missing (undefined)', { value: undefined }],
    ['null', { value: null }],
    ['a number', { value: 42 }],
    ['an object carrying the words', { value: { text: DIFFERENT_TMUX_SERVER_PHRASE } }],
    ['an array of the words', { value: [DIFFERENT_TMUX_SERVER_PHRASE] }],
    ['a getter that throws', { get: () => { throw new Error('boom') } }],
  ])('an ErrTmuxNotAvailable whose description is %s is not the re-bound form, and nothing throws', (_label, descriptor) => {
    const value = differentServerWithDescription(descriptor)
    expect(classifyAdError(value).errorClass).toBe(AD_ERROR_CLASS_ENVIRONMENT)
    expect(() => isDifferentTmuxServerError(value)).not.toThrow()
    expect(isDifferentTmuxServerError(value)).toBe(false)
  })

  test.each<[string, () => unknown]>([
    ['an Error named ErrTmuxNotAvailable whose message carries the words', () => Object.assign(plainErrorNamed(ERR_TMUX_NOT_AVAILABLE), { message: DIFFERENT_SERVER_DESCRIPTION })],
    [
      'an object shaped like the different-server form',
      () => ({ verb: 'resume', errName: ERR_TMUX_NOT_AVAILABLE, errDescription: DIFFERENT_SERVER_DESCRIPTION, name: ERR_TMUX_NOT_AVAILABLE }),
    ],
    ['the description string itself', () => DIFFERENT_SERVER_DESCRIPTION],
    ['undefined', () => undefined],
    ['null', () => null],
    ['a proxy whose every trap throws', () => new Proxy({}, { get: () => { throw new Error('boom') }, getPrototypeOf: () => { throw new Error('boom') } })],
  ])('%s is not an agent-director error: false, and nothing throws', (_label, build) => {
    const value = build()
    expect(() => isDifferentTmuxServerError(value)).not.toThrow()
    expect(isDifferentTmuxServerError(value)).toBe(false)
  })

})

// ---------------------------------------------------------------------------
// conflictDescriptionOf (b.jg5 SRJ-501, SRJ-507)
// ---------------------------------------------------------------------------

/** A thrown value and its label, for the accessor's tables. */
type Built = readonly [label: string, build: () => unknown]

/**
 * Every CONFLICT value the stub builds: SRJ-104's CONFLICT rows above (every
 * case from `resume`, the two `kill` forms, the options variants), and every
 * case and options variant again on another session name and verb.
 */
const CONFLICT_BUILDS: readonly Built[] = [
  ...ROWS.filter(([, , expected]) => expected === AD_ERROR_CLASS_CONFLICT).map(([label, build]): Built => [label, build]),
  ...CONFLICT_CASES.map((c): Built => [
    `errTmuxSessionConflict (spawn, ${c}, another session)`,
    () => errTmuxSessionConflict('spawn', c, OTHER_SESSION_NAME),
  ]),
  ...CONFLICT_VARIANTS.map(([label, verb, c, options]): Built => [
    `errTmuxSessionConflict (${label}, another session)`,
    () => errTmuxSessionConflict(verb, c, OTHER_SESSION_NAME, options),
  ]),
]

/** A proxy whose every trap throws. */
function hostileProxy(): unknown {
  return new Proxy({}, { get: () => { throw new Error('boom') }, getPrototypeOf: () => { throw new Error('boom') } })
}

/** The stub's CONFLICT for `c` with its `errDescription` replaced by `descriptor`. */
function conflictWithDescription(descriptor: PropertyDescriptor, c: ConflictCase = 'own-id'): AgentDirectorError {
  return Object.defineProperty(errTmuxSessionConflict('resume', c), 'errDescription', descriptor)
}

describe('conflictDescriptionOf', () => {
  test('the CONFLICT table is not vacuous: the stub cases and options variants its values carry the words of are exactly the stub\'s CONFLICT_CASES and every options variant', () => {
    // A stub value's case, read back from its description: the case (or
    // variant) whose words are exactly the description's CONFLICT words. Only
    // the stub's values carry the list --tmux-session-name line; the base
    // error, whose description carries no CONFLICT word, is left out.
    const sameWords = (description: string, words: readonly string[]) =>
      JSON.stringify(wordsIn(description)) === JSON.stringify([...words].sort())
    const descriptions = CONFLICT_BUILDS
      .map(([, build]) => (build() as AgentDirectorError).errDescription)
      .filter((d) => d.includes('list --tmux-session-name '))
    const caseOf = (d: string) => (Object.keys(CASE_WORDS) as ConflictCase[]).find((c) => sameWords(d, CASE_WORDS[c]))
    const cases = new Set(descriptions.map(caseOf).filter((c) => c !== undefined))
    const variants = new Set(CONFLICT_VARIANTS.filter(([, , , , words]) => descriptions.some((d) => sameWords(d, words))).map(([label]) => label))
    expect(cases).toEqual(new Set(CONFLICT_CASES))
    expect(variants).toEqual(new Set(CONFLICT_VARIANTS.map(([label]) => label)))
  })

  test.each(CONFLICT_BUILDS)('%s answers its own errDescription, read from the value', (_label, build) => {
    const value = build() as AgentDirectorError
    expect(classifyAdError(value).errorClass).toBe(AD_ERROR_CLASS_CONFLICT)
    const expected = value.errDescription
    expect(typeof expected).toBe('string')
    expect(expected).not.toBe('')
    expect(conflictDescriptionOf(value)).toBe(expected)
  })

  test.each([...CONFLICT_CASES])('errTmuxSessionConflict (%s): two values of one case answer each its own session', (c) => {
    const ours = conflictDescriptionOf(errTmuxSessionConflict('resume', c))
    const other = conflictDescriptionOf(errTmuxSessionConflict('resume', c, OTHER_SESSION_NAME))
    expect(ours).toContain(JSON.stringify(STUB_TMUX_SESSION_NAME))
    expect(other).toContain(JSON.stringify(OTHER_SESSION_NAME))
    expect(ours).not.toBe(other)
  })

  test('the description comes back raw: not redacted onto one line, not capped, a case word past the cap kept', () => {
    const description = `first line\nsecond line\r\n${'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH)} ${CONFLICT_ANOTHER_STORE_PHRASE}`
    const value = conflictWithDescription({ value: description })
    expect(conflictDescriptionOf(value)).toBe(description)
  })

  test('an empty CONFLICT description comes back as the empty string', () => {
    expect(conflictDescriptionOf(conflictWithDescription({ value: '' }))).toBe('')
  })

  test('a CONFLICT whose errName getter throws still answers its description: the class decides', () => {
    const expected = errTmuxSessionConflict('resume', 'own-id').errDescription
    const value = Object.defineProperty(errTmuxSessionConflict('resume', 'own-id'), 'errName', { get: () => { throw new Error('boom') } })
    expect(classifyAdError(value)).toEqual({ errorClass: AD_ERROR_CLASS_CONFLICT })
    expect(conflictDescriptionOf(value)).toBe(expected)
  })

  test('a base error with the CONFLICT errName, carrying a CONFLICT description, is UNCLASSIFIED and answers nothing', () => {
    const value = baseError(ERR_TMUX_SESSION_CONFLICT_NAME, errTmuxSessionConflict('resume', 'own-id').errDescription)
    expect(classifyAdError(value).errorClass).toBe(AD_ERROR_CLASS_UNCLASSIFIED)
    expect(conflictDescriptionOf(value)).toBeUndefined()
  })

  // SRJ-104: an ErrUnknownErrorName whose unknownName is not one of the five
  // names the table gives their own handling is UNAVAILABLE, the CONFLICT name
  // included, so it has no CONFLICT description.
  test.each([...CONFLICT_CASES])(
    'an ErrUnknownErrorName whose unknownName is the CONFLICT name, carrying the %s description, is UNAVAILABLE and answers nothing',
    (c) => {
      const description = errTmuxSessionConflict('resume', c).errDescription
      const value = errUnknownErrorName(ERR_TMUX_SESSION_CONFLICT_NAME, description)
      // Precondition: the description really is in the envelope.
      expect((value.envelope as { err_description: string }).err_description).toBe(description)
      expect(value.unknownName).toBe(ERR_TMUX_SESSION_CONFLICT_NAME)
      expect(classifyAdError(value)).toEqual({ errorClass: AD_ERROR_CLASS_UNAVAILABLE })
      expect(conflictDescriptionOf(value)).toBeUndefined()
    },
  )

  test('an ErrUnknownErrorName for the CONFLICT name whose own errDescription is set answers nothing either', () => {
    const value = errUnknownErrorName(ERR_TMUX_SESSION_CONFLICT_NAME, errTmuxSessionConflict('resume', 'own-id').errDescription)
    Object.defineProperty(value, 'errDescription', { value: errTmuxSessionConflict('resume', 'leftover').errDescription })
    expect(conflictDescriptionOf(value)).toBeUndefined()
  })

  test.each(
    ROWS.filter(([, , expected]) => expected !== AD_ERROR_CLASS_CONFLICT).map(([label, build, expected]) => [label, expected, build] as const),
  )('%s (%s) answers nothing', (_label, _expected, build) => {
    expect(conflictDescriptionOf(build())).toBeUndefined()
  })

  test.each<[string, () => unknown, AdErrorClass]>([
    ['an ErrTmuxUnresponsive', () => errTmuxUnresponsive('resume', errTmuxSessionConflict('resume', 'own-id').errDescription), AD_ERROR_CLASS_UNAVAILABLE],
    ['an ErrTmuxKillFailed', () => withErrDescription(errTmuxKillFailed(), errTmuxSessionConflict('kill', 'not-this-launch').errDescription), AD_ERROR_CLASS_UNAVAILABLE],
    ['an ErrSpawnNotFound', () => withErrDescription(errSpawnNotFound(), errTmuxSessionConflict('resume', 'leftover').errDescription), AD_ERROR_CLASS_STATE],
    ['an ErrTmuxSessionCreate', () => withErrDescription(errTmuxSessionCreate(), errTmuxSessionConflict('spawn', 'conflicting-labels').errDescription), AD_ERROR_CLASS_LAUNCH_FAILURE],
    ['an ErrInternal (envelope description)', () => errInternal(errTmuxSessionConflict('resume', 'another-store').errDescription), AD_ERROR_CLASS_UNCLASSIFIED],
  ])('%s carrying a CONFLICT description answers nothing: the class decides, never the words', (_label, build, expected) => {
    const value = build()
    expect(classifyAdError(value).errorClass).toBe(expected)
    expect(conflictDescriptionOf(value)).toBeUndefined()
  })

  test.each<Built>([
    ['an Error named ErrTmuxSessionConflict whose message is a CONFLICT description', () => Object.assign(plainErrorNamed(ERR_TMUX_SESSION_CONFLICT_NAME), { message: errTmuxSessionConflict('resume', 'own-id').errDescription })],
    [
      'an object shaped like a CONFLICT',
      () => ({ verb: 'resume', errName: ERR_TMUX_SESSION_CONFLICT_NAME, errDescription: errTmuxSessionConflict('resume', 'own-id').errDescription, name: ERR_TMUX_SESSION_CONFLICT_NAME }),
    ],
    ['a CONFLICT description string itself', () => errTmuxSessionConflict('resume', 'own-id').errDescription],
    ['undefined', () => undefined],
    ['null', () => null],
    ['a number', () => 42],
  ])('%s is not an agent-director error: nothing, and nothing throws', (_label, build) => {
    const value = build()
    expect(() => conflictDescriptionOf(value)).not.toThrow()
    expect(conflictDescriptionOf(value)).toBeUndefined()
  })

  test.each<[string, PropertyDescriptor]>([
    ['missing (undefined)', { value: undefined }],
    ['null', { value: null }],
    ['a number', { value: 42 }],
    ['an object carrying case words', { value: { text: CONFLICT_OWN_ID_PHRASE } }],
    ['an array of case words', { value: [CONFLICT_OWN_ID_PHRASE] }],
    ['a getter that throws', { get: () => { throw new Error('boom') } }],
  ])('a CONFLICT whose errDescription is %s answers nothing, and nothing throws', (_label, descriptor) => {
    const value = conflictWithDescription(descriptor)
    expect(classifyAdError(value).errorClass).toBe(AD_ERROR_CLASS_CONFLICT)
    expect(() => conflictDescriptionOf(value)).not.toThrow()
    expect(conflictDescriptionOf(value)).toBeUndefined()
  })

  test.each<Built>([
    ['a proxy whose every trap throws', hostileProxy],
    [
      'a proxy over a CONFLICT whose every read throws',
      () => new Proxy(errTmuxSessionConflict('resume', 'own-id'), { get: () => { throw new Error('boom') } }),
    ],
  ])('%s answers nothing, and nothing throws', (_label, build) => {
    const value = build()
    expect(() => conflictDescriptionOf(value)).not.toThrow()
    expect(conflictDescriptionOf(value)).toBeUndefined()
  })

  test("the CONFLICT classification is unchanged: no description in it, so its log line carries none", () => {
    const secret = `${CONFLICT_OWN_ID_PHRASE} (${sentinelInMessage('conflict')})`
    const value = conflictWithDescription({ value: secret })
    const before = classifyAdError(value)
    expect(conflictDescriptionOf(value)).toBe(secret)
    const after = classifyAdError(value)
    expect(before).toEqual({ errorClass: AD_ERROR_CLASS_CONFLICT })
    expect(after).toEqual(before)
    const line = describeAdErrorClassification(after)
    expect(line).toBe(`class=${AD_ERROR_CLASS_CONFLICT}`)
    assertNoLeak({ classification: after, line })
  })

  test('reading the description changes no value, makes no agent-director call and answers the same twice', () => {
    const log = makeStubCallLog()
    setClientForTests(makeStubClient(log) as unknown as Parameters<typeof setClientForTests>[0])
    for (const [label, build] of CONFLICT_BUILDS) {
      const value = build()
      const before = snapshot(value)
      const first = conflictDescriptionOf(value)
      expect({ label, same: conflictDescriptionOf(value) }).toEqual({ label, same: first })
      expect({ label, value: snapshot(value) }).toEqual({ label, value: before })
    }
    expect(stubCallCount(log)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// killFailedDescriptionOf (b.jg5 SRJ-110, SRJ-702)
// ---------------------------------------------------------------------------

/** The ROWS labels that build an `ErrTmuxKillFailed` instance: one per description. */
const KILL_FAILED_ROW_LABELS: ReadonlySet<string> = new Set(KILL_FAILED_DESCRIPTIONS.map((d) => `errTmuxKillFailed (${d})`))

/** An `ErrUnknownErrorName` carrying the `ErrTmuxKillFailed` name and the stub's description `d` in its envelope. */
function unknownNamedKillFailed(d: (typeof KILL_FAILED_DESCRIPTIONS)[number], sessionName = STUB_TMUX_SESSION_NAME): ErrUnknownErrorName {
  return errUnknownErrorName(ERR_TMUX_KILL_FAILED_NAME, errTmuxKillFailed(sessionName, d).errDescription)
}

describe('killFailedDescriptionOf', () => {
  test.each([...KILL_FAILED_DESCRIPTIONS])('errTmuxKillFailed (%s) answers its own errDescription, read from the value', (d) => {
    for (const sessionName of [STUB_TMUX_SESSION_NAME, OTHER_SESSION_NAME]) {
      const value = errTmuxKillFailed(sessionName, d)
      const expected = value.errDescription
      expect(expected).toContain(JSON.stringify(sessionName))
      expect(killFailedDescriptionOf(value)).toBe(expected)
    }
  })

  test('an ErrTmuxKillFailed whose errName getter throws still answers its description: the class decides', () => {
    const expected = errTmuxKillFailed().errDescription
    const value = Object.defineProperty(errTmuxKillFailed(), 'errName', { get: () => { throw new Error('boom') } })
    expect(killFailedDescriptionOf(value)).toBe(expected)
  })

  // b.jg5 SRJ-104: an ErrUnknownErrorName carrying the kill-failure name is
  // UNAVAILABLE and no kill failure, whatever its envelope says.
  test.each([...KILL_FAILED_DESCRIPTIONS])(
    'an ErrUnknownErrorName whose unknownName is ErrTmuxKillFailed, carrying the %s description in its envelope, is UNAVAILABLE and answers nothing',
    (d) => {
      const value = unknownNamedKillFailed(d, OTHER_SESSION_NAME)
      // Precondition: the envelope holds the stub's description under the kill-failure name.
      expect(value.unknownName).toBe(ERR_TMUX_KILL_FAILED_NAME)
      expect((value.envelope as { err_description: string }).err_description).toBe(errTmuxKillFailed(OTHER_SESSION_NAME, d).errDescription)
      expect(classifyAdError(value)).toEqual({ errorClass: AD_ERROR_CLASS_UNAVAILABLE })
      expect(killFailedDescriptionOf(value)).toBeUndefined()
    },
  )

  test.each(
    ROWS.filter(([label]) => !KILL_FAILED_ROW_LABELS.has(label)).map(([label, build, expected]) => [label, expected, build] as const),
  )('%s (%s) answers nothing', (_label, _expected, build) => {
    expect(killFailedDescriptionOf(build())).toBeUndefined()
  })

  test.each<Built>([
    ['a base error named ErrTmuxKillFailed', () => baseError(ERR_TMUX_KILL_FAILED_NAME, errTmuxKillFailed().errDescription)],
    ['an ErrTmuxSessionConflict (kill, not-this-launch)', () => withErrDescription(errTmuxSessionConflict('kill', 'not-this-launch'), errTmuxKillFailed().errDescription)],
    ['an ErrTmuxUnresponsive', () => errTmuxUnresponsive('kill', errTmuxKillFailed().errDescription)],
    ['an ErrSpawnNotFound', () => withErrDescription(errSpawnNotFound(), errTmuxKillFailed().errDescription)],
    ['an ErrInternal (envelope description)', () => errInternal(errTmuxKillFailed().errDescription)],
    ['an ErrUnknownErrorName of another name', () => errUnknownErrorName('ErrFromALaterBinary', errTmuxKillFailed().errDescription)],
  ])('%s carrying a kill-failure description answers nothing: the class decides, never the words', (_label, build) => {
    expect(killFailedDescriptionOf(build())).toBeUndefined()
  })

  test.each<Built>([
    ['an Error named ErrTmuxKillFailed whose message is a kill-failure description', () => Object.assign(plainErrorNamed(ERR_TMUX_KILL_FAILED_NAME), { message: errTmuxKillFailed().errDescription })],
    ['an object shaped like an ErrTmuxKillFailed', () => ({ verb: 'kill', errName: ERR_TMUX_KILL_FAILED_NAME, errDescription: errTmuxKillFailed().errDescription, name: ERR_TMUX_KILL_FAILED_NAME })],
    ['a kill-failure description string itself', () => errTmuxKillFailed().errDescription],
    ['undefined', () => undefined],
    ['null', () => null],
  ])('%s is not an agent-director error: nothing, and nothing throws', (_label, build) => {
    const value = build()
    expect(() => killFailedDescriptionOf(value)).not.toThrow()
    expect(killFailedDescriptionOf(value)).toBeUndefined()
  })

  test.each<Built>([
    ['an errDescription getter that throws', () => Object.defineProperty(errTmuxKillFailed(), 'errDescription', { get: () => { throw new Error('boom') } })],
    ['an errDescription that is not a string', () => Object.defineProperty(errTmuxKillFailed(), 'errDescription', { value: 42 })],
    ['a proxy whose every trap throws', hostileProxy],
    ['a proxy over an ErrTmuxKillFailed whose every read throws', () => new Proxy(errTmuxKillFailed(), { get: () => { throw new Error('boom') } })],
  ])('%s answers nothing, and nothing throws', (_label, build) => {
    const value = build()
    expect(() => killFailedDescriptionOf(value)).not.toThrow()
    expect(killFailedDescriptionOf(value)).toBeUndefined()
  })

  test('the description comes back raw: not redacted, not put on one line, not capped', () => {
    const description = `${RETRY_KILL_LATER_PHRASE}\n${sentinelInMessage('kill')}\r\n${'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH)} ${NEVER_DELETE_ROW_PHRASE}`
    expect(killFailedDescriptionOf(withErrDescription(errTmuxKillFailed(), description))).toBe(description)
  })

  test('reading the description changes no value and makes no agent-director call', () => {
    const log = makeStubCallLog()
    setClientForTests(makeStubClient(log) as unknown as Parameters<typeof setClientForTests>[0])
    for (const d of KILL_FAILED_DESCRIPTIONS) {
      for (const value of [errTmuxKillFailed(STUB_TMUX_SESSION_NAME, d), unknownNamedKillFailed(d)]) {
        const before = snapshot(value)
        const first = killFailedDescriptionOf(value)
        expect({ d, same: killFailedDescriptionOf(value) }).toEqual({ d, same: first })
        expect({ d, value: snapshot(value) }).toEqual({ d, value: before })
      }
    }
    expect(stubCallCount(log)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// isLaunchTimeoutError / launchTimeoutFormOf (b.jg5 SRJ-407): a launch call's
// `ErrCallTimeout`, or its `ErrTmuxUnresponsive` carrying the launch-timeout
// words; recognised by class, the declared call deciding whether it is a launch
// ---------------------------------------------------------------------------

/** The launch calls a site declares (`AD_LAUNCH_VERBS`): `spawn`, plain or reuse alike, and `resume`. */
const LAUNCH_CALLS: readonly AdCall[] = AD_VERBS.filter((verb): verb is Exclude<AdVerb, typeof AD_VERB_KILL> => verb !== AD_VERB_KILL && AD_LAUNCH_VERBS.has(verb))

/** Every other declared call: each verb that is no launch (`status` and `get` among them), and `kill` in both declarations. */
const NON_LAUNCH_CALLS: readonly AdCall[] = [
  ...AD_VERBS.filter((verb): verb is Exclude<AdVerb, typeof AD_VERB_KILL> => verb !== AD_VERB_KILL && !AD_LAUNCH_VERBS.has(verb)),
  AD_CALL_KILL_ROW_READ_LIVE,
  AD_CALL_KILL_ROW_NOT_READ_LIVE,
]

/** A declared call as a case label names it. */
const callLabel = (call: AdCall): string => (typeof call === 'string' ? call : `${call.verb} (row read live: ${call.rowReadLive})`)

/** One launch-timeout form, built for the declared launch call `verb`, and the form it is. */
type LaunchTimeoutRow = readonly [label: string, build: (verb: string) => unknown, form: LaunchTimeoutForm]

/**
 * Every value that ends a launch call as a launch timeout: an `ErrCallTimeout`
 * instance (whatever verb it carries: the site's declared call decides), and
 * an `ErrTmuxUnresponsive` instance carrying the phrase (class plus phrase).
 */
const LAUNCH_TIMEOUT_ROWS: readonly LaunchTimeoutRow[] = [
  ['errCallTimeout', (verb) => errCallTimeout(verb), LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT],
  ['errCallTimeout carrying another verb (the client\'s default)', () => errCallTimeout(), LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT],
  ['errTmuxUnresponsiveLaunchTimeout', (verb) => errTmuxUnresponsiveLaunchTimeout(verb), LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE],
  [
    'errTmuxUnresponsiveLaunchTimeout on another instance id',
    (verb) => errTmuxUnresponsiveLaunchTimeout(verb, `${STUB_TMUX_SESSION_NAME}_other_id`),
    LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE,
  ],
  ['an ErrTmuxUnresponsive whose description is exactly the phrase', (verb) => errTmuxUnresponsive(verb, LAUNCH_TIMEOUT_PHRASE), LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE],
]

/** The ROWS labels that are launch timeouts when declared at a launch call. */
const LAUNCH_TIMEOUT_ROW_LABELS: ReadonlySet<string> = new Set([
  'errCallTimeout',
  'errTmuxUnresponsiveLaunchTimeout (spawn)',
  'errTmuxUnresponsiveLaunchTimeout (resume)',
])

describe('isLaunchTimeoutError and launchTimeoutFormOf (b.jg5 SRJ-407)', () => {
  test('the forms are the two names, by value: ErrCallTimeout\'s and ErrTmuxUnresponsive\'s', () => {
    expect([LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT, LAUNCH_TIMEOUT_FORM_TMUX_UNRESPONSIVE]).toEqual([errCallTimeout().errName, ERR_TMUX_UNRESPONSIVE_NAME])
    expect(LAUNCH_CALLS).toEqual(['spawn', 'resume'])
    expect(NON_LAUNCH_CALLS).toContain('status')
    expect(NON_LAUNCH_CALLS).toContain('get')
  })

  test('the ROWS labels taken as launch timeouts are all in the table (none is vacuous)', () => {
    expect(ROWS.filter(([label]) => LAUNCH_TIMEOUT_ROW_LABELS.has(label)).map(([label]) => label).sort()).toEqual([...LAUNCH_TIMEOUT_ROW_LABELS].sort())
  })

  test.each(LAUNCH_TIMEOUT_ROWS.flatMap(([label, build, form]) => LAUNCH_CALLS.map((call) => [`${label} from ${callLabel(call)}`, call, form, build] as const)))(
    '%s is a launch timeout in its form, and still UNAVAILABLE',
    (_label, call, form, build) => {
      const value = build(callLabel(call))
      expect(launchTimeoutFormOf(value, call)).toBe(form)
      expect(isLaunchTimeoutError(value, call)).toBe(true)
      expect(classifyAdError(value)).toEqual({ errorClass: AD_ERROR_CLASS_UNAVAILABLE })
    },
  )

  test.each(LAUNCH_TIMEOUT_ROWS.flatMap(([label, build]) => NON_LAUNCH_CALLS.map((call) => [`${label} declared at ${callLabel(call)}`, call, build] as const)))(
    '%s is no launch timeout: only a launch call times out as a launch',
    (_label, call, build) => {
      const value = build(callLabel(call))
      expect(launchTimeoutFormOf(value, call)).toBeUndefined()
      expect(isLaunchTimeoutError(value, call)).toBe(false)
    },
  )

  test.each<Built>([
    ['errTmuxUnresponsive (plain: a tmux call that did not answer and did nothing)', () => errTmuxUnresponsive()],
    ['errTmuxUnresponsiveStillStopping', () => errTmuxUnresponsiveStillStopping()],
    ['errTmuxUnresponsiveStillStarting', () => errTmuxUnresponsiveStillStarting()],
    ['errTmuxUnresponsiveAfterDuplicateSession (its holder could not be read)', () => errTmuxUnresponsiveAfterDuplicateSession()],
    ...ROWS.filter(([label]) => !LAUNCH_TIMEOUT_ROW_LABELS.has(label)).map(([label, build]): Built => [`${label} (SRJ-104's row)`, build]),
  ])('%s, at either launch call, is no launch timeout', (_label, build) => {
    for (const call of LAUNCH_CALLS) {
      const value = build()
      expect({ call, form: launchTimeoutFormOf(value, call) }).toEqual({ call, form: undefined })
      expect({ call, timeout: isLaunchTimeoutError(value, call) }).toEqual({ call, timeout: false })
    }
  })

  test.each<Built>([
    ['an ErrCallTimeout whose errName getter throws', () => Object.defineProperty(errCallTimeout('spawn'), 'errName', { get: () => { throw new Error('boom') } })],
    ['an ErrCallTimeout behind a proxy whose every read throws', () => new Proxy(errCallTimeout('spawn'), { get: () => { throw new Error('boom') } })],
  ])('%s is the ErrCallTimeout form at either launch call: the class decides, and nothing throws', (_label, build) => {
    for (const call of LAUNCH_CALLS) {
      const value = build()
      expect(() => launchTimeoutFormOf(value, call)).not.toThrow()
      expect({ call, form: launchTimeoutFormOf(value, call) }).toEqual({ call, form: LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT })
    }
  })

  test.each<Built>([
    ['a base error named ErrTmuxUnresponsive', () => baseError(ERR_TMUX_UNRESPONSIVE_NAME, errTmuxUnresponsiveLaunchTimeout().errDescription)],
    ['a base error named ErrCallTimeout', () => baseError(errCallTimeout().errName, LAUNCH_TIMEOUT_PHRASE)],
    [
      'an ErrUnknownErrorName carrying ErrTmuxUnresponsive (envelope description)',
      () => {
        const err = errUnknownErrorName(ERR_TMUX_UNRESPONSIVE_NAME, errTmuxUnresponsiveLaunchTimeout().errDescription)
        // Precondition: the phrase is in the envelope's description, under the ErrTmuxUnresponsive name.
        expect(err.unknownName).toBe(ERR_TMUX_UNRESPONSIVE_NAME)
        expect((err.envelope as { err_description: string }).err_description).toContain(LAUNCH_TIMEOUT_PHRASE)
        return err
      },
    ],
    ['an ErrTmuxKillFailed', () => withErrDescription(errTmuxKillFailed(), LAUNCH_TIMEOUT_PHRASE)],
    ['an ErrTmuxSessionCreate', () => withErrDescription(errTmuxSessionCreate('spawn'), errTmuxUnresponsiveLaunchTimeout().errDescription)],
    ['an ErrTmuxSessionConflict', () => conflictWithDescription({ value: LAUNCH_TIMEOUT_PHRASE })],
    ['an ErrSpawnNotFound', () => withErrDescription(errSpawnNotFound(), LAUNCH_TIMEOUT_PHRASE)],
    ['CSCB\'s wrapped UnknownError', () => baseError(CSCB_UNKNOWN_ERROR_NAME, LAUNCH_TIMEOUT_PHRASE)],
    ['an ErrInternal (envelope description)', () => errInternal(LAUNCH_TIMEOUT_PHRASE)],
    ['an ErrUnknownErrorName of another name (envelope description)', () => errUnknownErrorName('ErrFromALaterBinary', LAUNCH_TIMEOUT_PHRASE)],
  ])('%s carrying the phrase is no launch timeout: the class decides, never the words alone', (_label, build) => {
    for (const call of LAUNCH_CALLS) {
      const value = build()
      expect({ call, form: launchTimeoutFormOf(value, call), timeout: isLaunchTimeoutError(value, call) }).toEqual({ call, form: undefined, timeout: false })
    }
  })

  test.each<Built>([
    ['an Error named ErrCallTimeout', () => plainErrorNamed(LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT)],
    ['an Error named ErrTmuxUnresponsive whose message carries the phrase', () => Object.assign(plainErrorNamed(ERR_TMUX_UNRESPONSIVE_NAME), { message: LAUNCH_TIMEOUT_PHRASE })],
    [
      'an object shaped like the launch-timeout ErrTmuxUnresponsive',
      () => ({ verb: 'spawn', errName: ERR_TMUX_UNRESPONSIVE_NAME, errDescription: errTmuxUnresponsiveLaunchTimeout().errDescription, name: ERR_TMUX_UNRESPONSIVE_NAME }),
    ],
    ['an object shaped like an ErrCallTimeout', () => ({ errName: LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT, name: LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT })],
    ['the launch-timeout description string itself', () => errTmuxUnresponsiveLaunchTimeout().errDescription],
    ['undefined', () => undefined],
    ['null', () => null],
    ['an errDescription getter that throws', () => Object.defineProperty(errTmuxUnresponsiveLaunchTimeout(), 'errDescription', { get: () => { throw new Error('boom') } })],
    ['an errDescription that is not a string', () => Object.defineProperty(errTmuxUnresponsiveLaunchTimeout(), 'errDescription', { value: [LAUNCH_TIMEOUT_PHRASE] })],
    ['a proxy whose every trap throws', hostileProxy],
    ['an ErrTmuxUnresponsive carrying the phrase behind a proxy whose every read throws', () => new Proxy(errTmuxUnresponsiveLaunchTimeout(), { get: () => { throw new Error('boom') } })],
  ])('%s is no launch timeout at either launch call, and nothing throws', (_label, build) => {
    for (const call of LAUNCH_CALLS) {
      const value = build()
      expect(() => launchTimeoutFormOf(value, call)).not.toThrow()
      expect({ call, form: launchTimeoutFormOf(value, call), timeout: isLaunchTimeoutError(value, call) }).toEqual({ call, form: undefined, timeout: false })
    }
  })

  test('deciding changes no value, makes no agent-director call and answers the same twice', () => {
    const log = makeStubCallLog()
    setClientForTests(makeStubClient(log) as unknown as Parameters<typeof setClientForTests>[0])
    for (const [label, build] of LAUNCH_TIMEOUT_ROWS) {
      for (const call of [...LAUNCH_CALLS, ...NON_LAUNCH_CALLS]) {
        const value = build(callLabel(call))
        const before = snapshot(value)
        const first = launchTimeoutFormOf(value, call)
        expect({ label, call, same: launchTimeoutFormOf(value, call), timeout: isLaunchTimeoutError(value, call) }).toEqual({ label, call, same: first, timeout: first !== undefined })
        expect({ label, call, value: snapshot(value) }).toEqual({ label, call, value: before })
      }
    }
    expect(stubCallCount(log)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// unclassifiedClassificationOf (b.jg5 SRJ-104, SRJ-110): the UNCLASSIFIED
// classification a kill site reports for a class it has no row for
// ---------------------------------------------------------------------------

describe('unclassifiedClassificationOf (b.jg5 SRJ-104, SRJ-110)', () => {
  test.each<[string, () => AgentDirectorError & { errName: string; errDescription: string }, AdErrorClass]>([
    ['errInstanceIdCollision', () => errInstanceIdCollision(), AD_ERROR_CLASS_STATE],
    ['errSpawnNotResumable', () => errSpawnNotResumable(), AD_ERROR_CLASS_STATE],
    ['errTmuxSessionCreate', () => errTmuxSessionCreate('kill'), AD_ERROR_CLASS_LAUNCH_FAILURE],
    ['errCwdNotFound', () => errCwdNotFound('kill'), AD_ERROR_CLASS_DIRECTORY],
  ])('%s (classified %s) → UNCLASSIFIED, carrying its errName and its description', (_label, build, classified) => {
    const value = build()
    // Precondition: the classifier gives it another class.
    expect(classifyAdError(value).errorClass).toBe(classified)
    expect(unclassifiedClassificationOf(value)).toEqual({
      errorClass: AD_ERROR_CLASS_UNCLASSIFIED,
      reportedName: value.errName,
      message: value.errDescription,
    })
  })

  test('an ErrInvalidFlags → the same classification the ErrInvalidFlags step gives', () => {
    expect(unclassifiedClassificationOf(errInvalidFlags())).toEqual(expectedInvalidFlagsClassification())
  })

  test('an ErrUnknownErrorName → its unknownName and the envelope description, not the client\'s own text', () => {
    const value = errUnknownErrorName('ErrFromALaterBinary', 'a later binary\'s description')
    expect(unclassifiedClassificationOf(value)).toEqual({
      errorClass: AD_ERROR_CLASS_UNCLASSIFIED,
      reportedName: value.unknownName,
      message: (value.envelope as { err_description: string }).err_description,
    })
  })

  test('a description carrying a token and a ticket URL comes out redacted, on one line', () => {
    const classification = unclassifiedClassificationOf(errGeneric('kill', 'ErrKillBroken', `line one\n${sentinelInMessage('unclassified')}`))
    expect(classification.message).toContain(REDACTED_SENTINEL_TAIL)
    expect(classification.message).not.toMatch(/[\r\n]/)
    assertNoLeak({ classification })
  })

  test('an errName that is not a safe identifier is not reported; an empty description gives no message', () => {
    expect(unclassifiedClassificationOf(errGeneric('kill', 'not a safe name', ''))).toEqual({ errorClass: AD_ERROR_CLASS_UNCLASSIFIED })
  })

  test.each<Built>([
    ['a plain Error', () => new Error('boom')],
    ['undefined', () => undefined],
    ['a proxy whose every trap throws', hostileProxy],
  ])('%s → UNCLASSIFIED alone, and nothing throws', (_label, build) => {
    const value = build()
    expect(() => unclassifiedClassificationOf(value)).not.toThrow()
    expect(unclassifiedClassificationOf(value)).toEqual({ errorClass: AD_ERROR_CLASS_UNCLASSIFIED })
  })
})

// ---------------------------------------------------------------------------
// describeReportedAdFailure (b.jg5 SRJ-104): the one-line description that
// names what agent-director reported
// ---------------------------------------------------------------------------

describe('describeReportedAdFailure (b.jg5 SRJ-104)', () => {
  /** The envelope's `err_description` of an `ErrUnknownErrorName`. */
  const envelopeDescription = (value: ErrUnknownErrorName): string => (value.envelope as { err_description: string }).err_description

  test.each<readonly [string, () => ErrUnknownErrorName, AdErrorClass]>([
    ['a plain ErrInternal', () => errInternal(), AD_ERROR_CLASS_UNCLASSIFIED],
    ['the unusable-name ErrInternal', () => errUnusableName(), AD_ERROR_CLASS_UNUSABLE_NAME],
    ['ErrConfigMalformed', () => errConfigMalformed(), AD_ERROR_CLASS_CONFIG],
    ['ErrSchemaMismatch', () => errSchemaMismatch(), AD_ERROR_CLASS_UNCLASSIFIED],
    [ERR_STORE_OPEN_NAME, () => errUnknownErrorName(ERR_STORE_OPEN_NAME, 'the store could not be opened'), AD_ERROR_CLASS_UNCLASSIFIED],
  ])('an ErrUnknownErrorName (%s, %s) → its unknownName and the envelope description, not the client\'s own text', (_label, build, classified) => {
    const value = build()
    expect(classifyAdError(value).errorClass).toBe(classified)
    const line = describeReportedAdFailure(value)
    expect(line).toBe(`${value.unknownName} message=${JSON.stringify(envelopeDescription(value))}`)
    expect(line).not.toContain(value.errName)
    expect(line).not.toContain(value.errDescription)
    expect(line).not.toBe(describeAgentDirectorFailure(value))
  })

  test('an error of its own class with a name CSCB gives no handling → its errName and its errDescription', () => {
    const value = errSendKeysWhileRelayed()
    expect(describeReportedAdFailure(value)).toBe(`${value.errName} message=${JSON.stringify(value.errDescription)}`)
  })

  test.each([
    ['empty', ''],
    ['whitespace only', ' \n '],
  ])('an %s description → the name alone', (_label, description) => {
    expect(describeReportedAdFailure(errInternal(description))).toBe(ERR_INTERNAL)
    expect(describeReportedAdFailure(errGeneric('get', 'ErrNoHandlingInCscb', description))).toBe('ErrNoHandlingInCscb')
  })

  test.each([
    ['with a space', () => 'not a safe name'],
    ['token-shaped', () => fakeToken(BOT_TOKEN_PREFIX, 'name')],
    ['overlong', () => `Err${'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH)}`],
  ])('an errName that is not a safe identifier (%s) → the message alone, never the name', (_label, buildName) => {
    const name = buildName()
    const value = errGeneric('get', name, 'described')
    expect(classifyAdError(value).errorClass).toBe(AD_ERROR_CLASS_UNCLASSIFIED)
    const line = describeReportedAdFailure(value)
    expect(line).toBe(`message=${JSON.stringify('described')}`)
    expect(line).not.toContain(name)
    assertNoLeak(line)
  })

  test.each<Built>([
    ...CONFLICT_CASES.map((c): Built => [`CONFLICT (${c})`, () => errTmuxSessionConflict('read-pane', c)]),
    ['GONE (errTmuxSendKeys)', () => errTmuxSendKeys()],
    ['STATE (errSpawnNotFound)', () => errSpawnNotFound()],
    ['UNAVAILABLE (errTmuxUnresponsive)', () => errTmuxUnresponsive()],
    ['UNAVAILABLE (an ErrUnknownErrorName with a later name)', () => errUnknownErrorName()],
    ['a wrapped UnknownError', () => baseError(CSCB_UNKNOWN_ERROR_NAME, 'Error: boom')],
    ['a plain Error', () => new Error('boom')],
    ['a string', () => 'boom'],
    ['undefined', () => undefined],
    ['null', () => null],
  ])('%s, which reports no name or message → describeAgentDirectorFailure\'s description', (_label, build) => {
    const value = build()
    const classification = classifyAdError(value)
    expect([classification.reportedName, classification.message]).toEqual([undefined, undefined])
    expect(describeReportedAdFailure(value)).toBe(describeAgentDirectorFailure(value))
  })

  test('a CONFLICT is described by its own errName and errDescription', () => {
    const value = errTmuxSessionConflict('read-pane', 'not-this-launch')
    expect(describeReportedAdFailure(value)).toBe(`${ERR_TMUX_SESSION_CONFLICT_NAME} message=${JSON.stringify(value.errDescription)}`)
  })

  // What is still readable is reported; a value that reports nothing gets describeAgentDirectorFailure's description.
  test.each<readonly [string, () => unknown, (value: unknown) => string]>([
    [
      'a base error whose errName getter throws (its description is still reported)',
      () => Object.defineProperty(baseError(ERR_SPAWN_NOT_FOUND_NAME), 'errName', { get: () => { throw new Error('boom') } }),
      (value) => `message=${JSON.stringify((value as { readonly errDescription: string }).errDescription)}`,
    ],
    [
      'an ErrSpawnNotFound whose errName getter throws (STATE by class: nothing is reported)',
      () => Object.defineProperty(errSpawnNotFound(), 'errName', { get: () => { throw new Error('boom') } }),
      (value) => describeAgentDirectorFailure(value),
    ],
    [
      'an envelope whose err_description getter throws (its name is still reported)',
      () => unknownWithEnvelope(ERR_INTERNAL, Object.defineProperty({}, 'err_description', { get: () => { throw new Error('boom') } })),
      () => ERR_INTERNAL,
    ],
    [
      'an unknownName getter that throws (nothing is reported)',
      () => Object.defineProperty(errInternal(), 'unknownName', { get: () => { throw new Error('boom') } }),
      (value) => describeAgentDirectorFailure(value),
    ],
    ['a proxy whose every trap throws (nothing is reported)', hostileProxy, (value) => describeAgentDirectorFailure(value)],
  ])('%s: never throws', (_label, build, expected) => {
    const value = build()
    expect(() => describeReportedAdFailure(value)).not.toThrow()
    expect(describeReportedAdFailure(value)).toBe(expected(value))
  })

  test('a description carrying a token comes out redacted; nothing bare leaks', () => {
    const secret = `failed (${sentinelInMessage('reported')})`
    const redacted = `failed (${REDACTED_SENTINEL_TAIL})`
    // Every value also carries the sentinel bare where nothing is reported.
    const unknownNamed = (name: string): ErrUnknownErrorName =>
      Object.assign(
        new ErrUnknownErrorName(name, { err_name: name, err_description: secret, detail: LEAK_SENTINEL }),
        { note: LEAK_SENTINEL },
      )
    const ownClass = Object.assign(errGeneric('get', 'ErrNoHandlingInCscb', secret), { note: LEAK_SENTINEL })
    const cases = [
      [unknownNamed(ERR_INTERNAL), ERR_INTERNAL],
      [unknownNamed(ERR_CONFIG_MALFORMED), ERR_CONFIG_MALFORMED],
      [ownClass, ownClass.errName],
    ] as const
    const lines = cases.map(([value]) => describeReportedAdFailure(value))
    expect(lines).toEqual(cases.map(([, name]) => `${name} message=${JSON.stringify(redacted)}`))
    // A token-shaped unknownName reports nothing: the fallback describes it, still token-safe.
    const tokenNamed = unknownNamed(fakeToken(BOT_TOKEN_PREFIX, 'unknown'))
    const fallback = describeReportedAdFailure(tokenNamed)
    expect(fallback).toBe(describeAgentDirectorFailure(tokenNamed))
    assertNoLeak({ lines, fallback })
  })
})

// ---------------------------------------------------------------------------
// describeAdFailureForLog (b.jg5 SRJ-104, SRJ-1014): the reported name when
// the classifier gives one, else describeAgentDirectorFailure's description
// ---------------------------------------------------------------------------

describe('describeAdFailureForLog (b.jg5 SRJ-104, SRJ-1014)', () => {
  test.each<Built>([
    ['a plain ErrInternal', () => errInternal()],
    ['the unusable-name ErrInternal', () => errUnusableName()],
    ['ErrConfigMalformed', () => errConfigMalformed()],
    ['ErrSchemaMismatch', () => errSchemaMismatch()],
    [ERR_STORE_OPEN_NAME, () => errUnknownErrorName(ERR_STORE_OPEN_NAME, 'the store could not be opened')],
    ['an error of its own class with a name CSCB gives no handling', () => errSendKeysWhileRelayed()],
  ])('%s, which reports a name → describeReportedAdFailure\'s description, naming the reported name', (_label, build) => {
    const value = build()
    const { reportedName } = classifyAdError(value)
    expect(reportedName).toBeDefined()
    const line = describeAdFailureForLog(value)
    expect(line).toBe(describeReportedAdFailure(value))
    expect(line.startsWith(`${reportedName!} `)).toBe(true)
  })

  test('an ErrUnknownErrorName carrying a store-open name shows that name, never the client\'s placeholder name or text', () => {
    const value = errUnknownErrorName(ERR_STORE_OPEN_NAME, 'the store could not be opened')
    const line = describeAdFailureForLog(value)
    expect(line).not.toContain(value.errName)
    expect(line).not.toContain(value.errDescription)
    expect(line).not.toBe(describeAgentDirectorFailure(value))
  })

  test.each<Built>([
    ...CONFLICT_CASES.map((c): Built => [`CONFLICT (${c})`, () => errTmuxSessionConflict('read-pane', c)]),
    ['GONE (errTmuxSendKeys)', () => errTmuxSendKeys()],
    ['STATE (errSpawnNotFound)', () => errSpawnNotFound()],
    ['UNAVAILABLE (errTmuxUnresponsive)', () => errTmuxUnresponsive()],
    ['UNAVAILABLE (an ErrUnknownErrorName with a later name)', () => errUnknownErrorName()],
    ['a plain Error', () => new Error('boom')],
    ['a string', () => 'boom'],
    ['undefined', () => undefined],
  ])('%s, which reports no name → describeAgentDirectorFailure\'s description', (_label, build) => {
    const value = build()
    expect(classifyAdError(value).reportedName).toBeUndefined()
    expect(describeAdFailureForLog(value)).toBe(describeAgentDirectorFailure(value))
  })

  test.each([
    ['with a space', () => 'not a safe name'],
    ['token-shaped', () => fakeToken(BOT_TOKEN_PREFIX, 'name')],
    ['overlong', () => `Err${'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH)}`],
  ])('an errName that is not a safe identifier (%s) → describeAgentDirectorFailure\'s description, keeping the value\'s type, never the message-only reported form', (_label, buildName) => {
    const name = buildName()
    const value = errGeneric('get', name, `described (${sentinelInMessage('unsafe-name')})`)
    expect(classifyAdError(value).reportedName).toBeUndefined()
    const line = describeAdFailureForLog(value)
    expect(line).toBe(describeAgentDirectorFailure(value))
    expect(line).not.toBe(describeReportedAdFailure(value))
    expect(line.startsWith(`${value.constructor.name} `)).toBe(true)
    assertNoLeak(line)
  })

  test('a proxy whose every trap throws: never throws, and gives describeAgentDirectorFailure\'s description', () => {
    const value = hostileProxy()
    expect(() => describeAdFailureForLog(value)).not.toThrow()
    expect(describeAdFailureForLog(value)).toBe(describeAgentDirectorFailure(value))
  })
})

// ---------------------------------------------------------------------------
// The ErrInvalidFlags step
// ---------------------------------------------------------------------------

const PASS: AdVersionRecheckTriggerAnswer = { kind: RECHECK_OUTCOME_PASS, version: PHASE1_RC_VERSION, binaryPath: STUB_RESOLVE_DEFAULT_PATH }
const STOP: AdVersionRecheckTriggerAnswer = { kind: RECHECK_OUTCOME_STOP, classLabel: AD_BELOW_PHASE1_FLOOR, message: 'refused' }
const COULD_NOT_RUN: AdVersionRecheckTriggerAnswer = { kind: RECHECK_OUTCOME_COULD_NOT_RUN, description: 'the binary could not be resolved' }
const NOT_RUNNING: AdVersionRecheckTriggerAnswer = { kind: RECHECK_OUTCOME_NOT_RUNNING }

/** A trigger that answers `answer` (or rejects / throws with it) and counts its calls. */
function recordingTrigger(answer: AdVersionRecheckTriggerAnswer | 'reject' | 'throw'): { trigger: AdVersionRecheckTrigger; calls: () => number } {
  let calls = 0
  const trigger: AdVersionRecheckTrigger = () => {
    calls += 1
    if (answer === 'throw') throw new Error('trigger threw')
    if (answer === 'reject') return Promise.reject(new Error('trigger rejected'))
    return Promise.resolve(answer)
  }
  return { trigger, calls: () => calls }
}

/** The UNCLASSIFIED classification the step gives the default `errInvalidFlags()`. */
function expectedInvalidFlagsClassification(): AdErrorClassification {
  const err = errInvalidFlags()
  return { errorClass: AD_ERROR_CLASS_UNCLASSIFIED, reportedName: err.errName, message: err.errDescription }
}

/** E3's re-check installed on a fake clock over a stub resolve; returns the resolve's call list and the stop codes. */
function installStubRecheck(outcomes?: readonly StubResolveSystemBinaryOutcome[]): { resolveCalls: unknown[]; stops: number[] } {
  const resolveCalls: Array<object | undefined> = []
  const stops: number[] = []
  installAdVersionRecheck({
    resolveSystemBinary: makeStubResolveSystemBinary(outcomes ? { calls: resolveCalls, outcomes } : { calls: resolveCalls }),
    baselineVersion: PHASE1_RC_VERSION,
    recordStartupError: () => {},
    stop: (code) => { stops.push(code) },
    log: () => {},
    clock: createFakeClock(),
  })
  return { resolveCalls, stops }
}

describe('classifyWithInvalidFlagsRecheck', () => {
  test.each([
    ['passes', PASS],
    ['stops', STOP],
    ['could not run', COULD_NOT_RUN],
    ['is not running', NOT_RUNNING],
  ])('an ErrInvalidFlags makes one re-check, which %s, then is UNCLASSIFIED', async (_label, answer) => {
    const t = recordingTrigger(answer)
    const result = await classifyWithInvalidFlagsRecheck(errInvalidFlags(), t.trigger)
    expect(t.calls()).toBe(1)
    expect(result).toEqual({ classification: expectedInvalidFlagsClassification(), recheck: answer })
  })

  test.each(['reject', 'throw'] as const)('a trigger that %ss still gives UNCLASSIFIED after one call', async (mode) => {
    const t = recordingTrigger(mode)
    const result = await classifyWithInvalidFlagsRecheck(errInvalidFlags('resume'), t.trigger)
    expect(t.calls()).toBe(1)
    expect(result.classification.errorClass).toBe(AD_ERROR_CLASS_UNCLASSIFIED)
    expect(result.recheck).toEqual({ kind: RECHECK_OUTCOME_COULD_NOT_RUN, description: TRIGGER_FAILED_DESCRIPTION })
  })

  test.each([
    ['errTmuxSendKeys', () => errTmuxSendKeys()],
    ['errSpawnNotFound', () => errSpawnNotFound()],
    ['errInternal', () => errInternal()],
    ['errTmuxSessionConflict', () => errTmuxSessionConflict('resume', 'leftover')],
    ['a plain Error named ErrInvalidFlags', () => plainErrorNamed(errInvalidFlags().errName)],
    ['a base error named ErrInvalidFlags', () => baseError(errInvalidFlags().errName)],
  ])('%s makes no re-check and gives its table class', async (_label, build) => {
    const t = recordingTrigger(PASS)
    const result = await classifyWithInvalidFlagsRecheck(build(), t.trigger)
    expect(t.calls()).toBe(0)
    expect(result).toStrictEqual({ classification: classifyAdError(build()) })
  })

  test.each([
    ['passes', [{ version: PHASE1_RC_VERSION }], RECHECK_OUTCOME_PASS, 0],
    ['stops', [{ version: OLD_AD_VERSION }], RECHECK_OUTCOME_STOP, 1],
  ] as const)('through E3\'s installed re-check, which %s: one resolve, then UNCLASSIFIED', async (_label, outcomes, kind, stopCount) => {
    const rig = installStubRecheck(outcomes)
    const result = await classifyWithInvalidFlagsRecheck(errInvalidFlags('resume'))
    expect(rig.resolveCalls).toHaveLength(1)
    expect(rig.stops).toHaveLength(stopCount)
    expect(result.recheck?.kind).toBe(kind)
    expect(result.classification.errorClass).toBe(AD_ERROR_CLASS_UNCLASSIFIED)
  })

  test('the client\'s ErrInvalidFlags narrowed by isInvalidFlagsError gets an answer whose re-check is always present', async () => {
    const value: unknown = errInvalidFlags('resume')
    if (!isInvalidFlagsError(value)) throw new Error('isInvalidFlagsError did not recognise the value')
    const t = recordingTrigger(STOP)
    const answer = await classifyWithInvalidFlagsRecheck(value, t.trigger)
    // Type-level check: only the narrowed value's overload makes `recheck` non-optional, so this assignment typechecks.
    const recheck: AdVersionRecheckTriggerAnswer = answer.recheck
    expect(t.calls()).toBe(1)
    expect(recheck).toEqual(STOP)
  })

  test('with no re-check installed the default trigger answers not running, and the value is UNCLASSIFIED', async () => {
    expect(await classifyWithInvalidFlagsRecheck(errInvalidFlags())).toEqual({
      classification: expectedInvalidFlagsClassification(),
      recheck: NOT_RUNNING,
    })
  })

  test('the pure classifier gives STATE for ErrInvalidFlags with no re-check', () => {
    const rig = installStubRecheck()
    expect(classifyAdError(errInvalidFlags('resume'))).toEqual({ errorClass: AD_ERROR_CLASS_STATE })
    expect(rig.resolveCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

/** What a value looks like from outside: its own properties, name and message. */
function snapshot(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const err = value as { name?: unknown; message?: unknown }
  return structuredClone({ ...value, name: err.name, message: err.message })
}

describe('classifyAdError: pure', () => {
  test('classifying every row makes no agent-director call and no re-check, changes no value and answers the same twice', () => {
    const log = makeStubCallLog()
    setClientForTests(makeStubClient(log) as unknown as Parameters<typeof setClientForTests>[0])
    const rig = installStubRecheck()
    for (const [label, build] of ROWS) {
      const value = build()
      const before = snapshot(value)
      const first = classifyAdError(value)
      const second = classifyAdError(value)
      expect({ label, same: second }).toEqual({ label, same: first })
      expect({ label, value: snapshot(value) }).toEqual({ label, value: before })
    }
    expect(stubCallCount(log)).toBe(0)
    expect(rig.resolveCalls).toHaveLength(0)
  })
})
