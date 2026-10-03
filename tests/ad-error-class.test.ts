/**
 * ad-error-class.test.ts — the one classifier of agent-director errors
 * (b.jg5 SRJ-104), the `ErrInvalidFlags` step beside it, the re-bound-socket
 * predicate `isDifferentTmuxServerError` (b.jg5 SRJ-311, SRJ-1021), the
 * CONFLICT description accessor `conflictDescriptionOf` (b.jg5 SRJ-501,
 * SRJ-507; by class, so an `ErrUnknownErrorName` carrying the CONFLICT name,
 * UNAVAILABLE by SRJ-104, answers nothing), the kill-failure description
 * accessor `killFailedDescriptionOf` (b.jg5 SRJ-110, SRJ-702; by name, so an
 * `ErrUnknownErrorName` carrying the `ErrTmuxKillFailed` name answers its
 * envelope's description), the one-line description
 * `describeReportedAdFailure` (b.jg5 SRJ-104: what agent-director reported,
 * else `describeAgentDirectorFailure`'s description), and the
 * stub's error builders it is fed with (b.jg5 SRJ-1303; their shape checks
 * live here).
 *
 * Every value is built with the stub's builders. The three Phase-1-only names and the three store-open
 * names come from `src/agent-director-errors.ts` as strings; no class of
 * theirs is imported. Class labels come from `src/ad-error-class.ts`, the
 * description words, the survivor pattern and `survivorPids` from
 * `src/ad-description-phrases.ts` and the cap from
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
  CSCB_UNKNOWN_ERROR_NAME,
  TRIGGER_FAILED_DESCRIPTION,
  classifyAdError,
  classifyWithInvalidFlagsRecheck,
  conflictDescriptionOf,
  describeAdErrorClassification,
  describeAgentDirectorFailure,
  describeReportedAdFailure,
  hasAdErrorName,
  isDifferentTmuxServerError,
  isInvalidFlagsError,
  killFailedDescriptionOf,
  unclassifiedClassificationOf,
  type AdErrorClass,
  type AdErrorClassification,
  type AdVersionRecheckTrigger,
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
  errTmuxNotAvailable,
  errTmuxNotAvailableDifferentServer,
  errTmuxSendKeys,
  errTmuxSessionConflict,
  errTmuxSessionCreate,
  errTmuxUnresponsive,
  errTmuxUnresponsiveLaunchTimeout,
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
  ...PHASE1_ONLY_ERR_NAMES.map((name): Row => [
    `a plain Error named ${name}`,
    () => plainErrorNamed(name),
    AD_ERROR_CLASS_UNAVAILABLE,
  ]),
  ['a string', () => 'boom', AD_ERROR_CLASS_UNAVAILABLE],
  ['undefined', () => undefined, AD_ERROR_CLASS_UNAVAILABLE],
  ['null', () => null, AD_ERROR_CLASS_UNAVAILABLE],
  [
    'an object shaped like an agent-director error',
    () => ({ verb: 'resume', errName: ERR_TMUX_SESSION_CONFLICT_NAME, errDescription: 'x', name: ERR_TMUX_SESSION_CONFLICT_NAME }),
    AD_ERROR_CLASS_UNAVAILABLE,
  ],
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
// By name, never by `name`
// ---------------------------------------------------------------------------

const PHASE1_BUILDERS: ReadonlyArray<readonly [string, () => AgentDirectorError]> = [
  [ERR_TMUX_UNRESPONSIVE_NAME, () => errTmuxUnresponsive()],
  [ERR_TMUX_KILL_FAILED_NAME, () => errTmuxKillFailed()],
  [ERR_TMUX_SESSION_CONFLICT_NAME, () => errTmuxSessionConflict('resume', 'own-id')],
]

describe('classifyAdError: recognised by errName', () => {
  test.each(PHASE1_BUILDERS)('the %s builder gives an AgentDirectorError named for it', (name, build) => {
    const err = build()
    expect(err).toBeInstanceOf(AgentDirectorError)
    expect(err.name).toBe(name)
    expect(err.errName).toBe(name)
  })

  test.each(PHASE1_BUILDERS)('a base error with errName %s and its default name classifies as the builder\'s', (name, build) => {
    const err = baseError(name)
    expect(err.name).not.toBe(name)
    expect(classifyAdError(err)).toEqual(classifyAdError(build()))
  })

  test('a value whose name is a Phase-1-only name but whose errName is a STATE name is STATE', () => {
    const err = errSpawnNotFound()
    err.name = ERR_TMUX_SESSION_CONFLICT_NAME
    expect(classifyAdError(err)).toEqual({ errorClass: AD_ERROR_CLASS_STATE })
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

describe('stub builders: shape (SRJ-1303)', () => {
  test.each([...KILL_FAILED_DESCRIPTIONS])(
    'errTmuxKillFailed (%s) carries the quoted session name, verb kill, "retry kill later" and "never delete this row"',
    (d) => {
      const err = errTmuxKillFailed(OTHER_SESSION_NAME, d)
      expect(err.verb).toBe('kill')
      expect(err.errDescription).toContain(JSON.stringify(OTHER_SESSION_NAME))
      expect(err.errDescription).toContain(RETRY_KILL_LATER_PHRASE)
      expect(err.errDescription).toContain(NEVER_DELETE_ROW_PHRASE)
    },
  )

  test('the four errTmuxKillFailed descriptions differ', () => {
    const texts = KILL_FAILED_DESCRIPTIONS.map((d) => errTmuxKillFailed(STUB_TMUX_SESSION_NAME, d).errDescription)
    expect(texts).toHaveLength(4)
    expect(new Set(texts).size).toBe(KILL_FAILED_DESCRIPTIONS.length)
  })

  test.each(KILL_FAILED_DESCRIPTIONS.map((d) => [d, d === 'pane-process-survived'] as const))(
    'SURVIVOR_PID_PATTERN on the errTmuxKillFailed (%s) description matches: %p',
    (d, matches) => {
      expect(SURVIVOR_PID_PATTERN.test(errTmuxKillFailed(STUB_TMUX_SESSION_NAME, d).errDescription)).toBe(matches)
    },
  )

  test.each([
    ['the default pid', undefined, STUB_SURVIVOR_PIDS],
    ['one pid', [4194401], [4194401]],
    ['two pids, in the order given', [4194403, 4194402], [4194403, 4194402]],
  ] as const)('the survivor description built with %s names each pid once, in order', (_label, pids, expected) => {
    const description = errTmuxKillFailed(STUB_TMUX_SESSION_NAME, 'pane-process-survived', pids).errDescription
    expect(survivorPids(description)).toEqual([...expected])
  })

  test.each(KILL_FAILED_DESCRIPTIONS.filter((d) => d !== 'pane-process-survived'))(
    'errTmuxKillFailed (%s) ignores the pids it is given and names none',
    (d) => {
      expect(survivorPids(errTmuxKillFailed(STUB_TMUX_SESSION_NAME, d, [4194401, 4194402]).errDescription)).toEqual([])
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

describe('SURVIVOR_PID_PATTERN and survivorPids (b.jg5 SRJ-702)', () => {
  test('SURVIVOR_PID_PATTERN has no flags, so .test() keeps no state between calls', () => {
    expect(SURVIVOR_PID_PATTERN.flags).toBe('')
  })

  test('two .test() calls in a row on "pid 4242" both match', () => {
    expect(SURVIVOR_PID_PATTERN.test('pid 4242')).toBe(true)
    expect(SURVIVOR_PID_PATTERN.test('pid 4242')).toBe(true)
  })

  test.each(['pids 12', 'rapid 12', 'pid', 'pid x', 'a kill was sent'])(
    'SURVIVOR_PID_PATTERN does not match %p',
    (text) => {
      expect(SURVIVOR_PID_PATTERN.test(text)).toBe(false)
    },
  )

  test('survivorPids lists every named pid in order, the same on two calls in a row', () => {
    const description = 'the kill left survivors: pid 11, pid 22 still run'
    expect(survivorPids(description)).toEqual([11, 22])
    expect(survivorPids(description)).toEqual([11, 22])
  })

  test('survivorPids is empty when no pid is named in the form', () => {
    expect(survivorPids('rapid 12; pids 13')).toEqual([])
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
    const errNamed = (errName: string): AgentDirectorError =>
      Object.assign(baseError(errName, secret), { note: LEAK_SENTINEL })
    const cases = [
      [classifyAdError(unknownNamed(ERR_INTERNAL, secret)), ERR_INTERNAL, redacted],
      [
        classifyAdError(unknownNamed(ERR_INTERNAL, `${UNUSABLE_RECORDED_NAME_PHRASE} ${secret}`)),
        ERR_INTERNAL,
        `${UNUSABLE_RECORDED_NAME_PHRASE} ${redacted}`,
      ],
      [classifyAdError(unknownNamed(ERR_CONFIG_MALFORMED, secret)), ERR_CONFIG_MALFORMED, redacted],
      [classifyAdError(errNamed(errSendKeysWhileRelayed().errName)), errSendKeysWhileRelayed().errName, redacted],
      [
        (await classifyWithInvalidFlagsRecheck(errNamed(errInvalidFlags().errName), recordingTrigger(PASS).trigger)).classification,
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
      'an errName getter that throws',
      () => Object.defineProperty(errSpawnNotFound(), 'errName', { get: () => { throw new Error('boom') } }),
      { errorClass: AD_ERROR_CLASS_UNCLASSIFIED, message: 'spawn not found' },
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
    ['a base error with that errName', true, () => baseError(errInvalidFlags().errName)],
    ['an Error named ErrInvalidFlags', false, () => plainErrorNamed(errInvalidFlags().errName)],
    ['an object with that errName', false, () => ({ errName: errInvalidFlags().errName })],
    ['another agent-director error', false, () => errSpawnNotFound()],
    ['undefined', false, () => undefined],
    ['its errName getter throws', false, () => Object.defineProperty(errInvalidFlags(), 'errName', { get: () => { throw new Error('boom') } })],
  ])('%s → %p', (_label, expected, build) => {
    expect(isInvalidFlagsError(build())).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// hasAdErrorName
// ---------------------------------------------------------------------------

describe('hasAdErrorName', () => {
  test.each<[string, boolean, () => unknown, string]>([
    ['errSpawnNotFound against ERR_SPAWN_NOT_FOUND_NAME', true, () => errSpawnNotFound(), ERR_SPAWN_NOT_FOUND_NAME],
    ['errTmuxKillFailed against ERR_TMUX_KILL_FAILED_NAME', true, () => errTmuxKillFailed(), ERR_TMUX_KILL_FAILED_NAME],
    ['a base error with that errName', true, () => baseError(ERR_SPAWN_NOT_FOUND_NAME), ERR_SPAWN_NOT_FOUND_NAME],
    ['errSpawnNotFound against another name', false, () => errSpawnNotFound(), ERR_TMUX_KILL_FAILED_NAME],
    ['errTmuxKillFailed against another name', false, () => errTmuxKillFailed(), ERR_SPAWN_NOT_FOUND_NAME],
    ['an agent-director error whose name, not errName, matches', false, () => Object.assign(baseError(ERR_INTERNAL), { name: ERR_SPAWN_NOT_FOUND_NAME }), ERR_SPAWN_NOT_FOUND_NAME],
    ['an Error named for it', false, () => plainErrorNamed(ERR_SPAWN_NOT_FOUND_NAME), ERR_SPAWN_NOT_FOUND_NAME],
    ['a plain object with a matching errName', false, () => ({ errName: ERR_TMUX_KILL_FAILED_NAME }), ERR_TMUX_KILL_FAILED_NAME],
    ['undefined', false, () => undefined, ERR_SPAWN_NOT_FOUND_NAME],
    ['a string of that name', false, () => ERR_SPAWN_NOT_FOUND_NAME, ERR_SPAWN_NOT_FOUND_NAME],
    ['an errName getter that throws', false, () => Object.defineProperty(errSpawnNotFound(), 'errName', { get: () => { throw new Error('boom') } }), ERR_SPAWN_NOT_FOUND_NAME],
    ['a proxy whose every trap throws', false, () => new Proxy({}, { get: () => { throw new Error('boom') }, getPrototypeOf: () => { throw new Error('boom') } }), ERR_SPAWN_NOT_FOUND_NAME],
  ])('%s → %p', (_label, expected, build, name) => {
    expect(hasAdErrorName(build(), name)).toBe(expected)
  })

  test('ERR_SPAWN_NOT_FOUND_NAME is the errName of the client\'s ErrSpawnNotFound', () => {
    expect(errSpawnNotFound().errName).toBe(ERR_SPAWN_NOT_FOUND_NAME)
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
    ['a base error named ErrTmuxNotAvailable carrying the words', () => baseError(ERR_TMUX_NOT_AVAILABLE, DIFFERENT_SERVER_DESCRIPTION)],
    ['an ErrTmuxNotAvailable whose description is exactly the words', () => errGeneric('resume', ERR_TMUX_NOT_AVAILABLE, DIFFERENT_TMUX_SERVER_PHRASE)],
  ])('%s is the re-bound form', (_label, build) => {
    const value = build()
    expect(classifyAdError(value).errorClass).toBe(AD_ERROR_CLASS_ENVIRONMENT)
    expect(isDifferentTmuxServerError(value)).toBe(true)
  })

  test.each<[string, () => unknown]>([
    ['plain ENVIRONMENT without a socket', () => errTmuxNotAvailable()],
    ['plain ENVIRONMENT with the stub\'s socket', () => errTmuxNotAvailable(STUB_TMUX_SOCKET_PATH)],
    ['plain ENVIRONMENT with another socket', () => errTmuxNotAvailable(OTHER_SOCKET_PATH, 'resume')],
  ])('%s is ENVIRONMENT but not the re-bound form', (_label, build) => {
    const value = build()
    expect(classifyAdError(value).errorClass).toBe(AD_ERROR_CLASS_ENVIRONMENT)
    expect(isDifferentTmuxServerError(value)).toBe(false)
  })

  test.each<[string, () => unknown, AdErrorClass]>([
    ['ErrTmuxUnresponsive', () => baseError(ERR_TMUX_UNRESPONSIVE_NAME, DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_UNAVAILABLE],
    ['ErrTmuxSessionConflict', () => baseError(ERR_TMUX_SESSION_CONFLICT_NAME, DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_CONFLICT],
    ['ErrTmuxSessionCreate', () => baseError(errTmuxSessionCreate().errName, DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_LAUNCH_FAILURE],
    ['ErrSpawnNotFound', () => baseError(ERR_SPAWN_NOT_FOUND_NAME, DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_STATE],
    ['ErrTmuxSendKeys', () => baseError(errTmuxSendKeys().errName, DIFFERENT_SERVER_DESCRIPTION), AD_ERROR_CLASS_GONE],
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

  test('an errName getter that throws answers false and throws nothing', () => {
    const value = Object.defineProperty(errTmuxNotAvailableDifferentServer(), 'errName', { get: () => { throw new Error('boom') } })
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
  ['a base error with the CONFLICT errName and its default name', () => baseError(ERR_TMUX_SESSION_CONFLICT_NAME, 'a session conflict')],
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
    const value = baseError(ERR_TMUX_SESSION_CONFLICT_NAME, description)
    expect(conflictDescriptionOf(value)).toBe(description)
  })

  test('an empty CONFLICT description comes back as the empty string', () => {
    expect(conflictDescriptionOf(baseError(ERR_TMUX_SESSION_CONFLICT_NAME, ''))).toBe('')
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
    ['ErrTmuxUnresponsive', () => baseError(ERR_TMUX_UNRESPONSIVE_NAME, errTmuxSessionConflict('resume', 'own-id').errDescription), AD_ERROR_CLASS_UNAVAILABLE],
    ['ErrTmuxKillFailed', () => baseError(ERR_TMUX_KILL_FAILED_NAME, errTmuxSessionConflict('kill', 'not-this-launch').errDescription), AD_ERROR_CLASS_UNAVAILABLE],
    ['ErrSpawnNotFound', () => baseError(ERR_SPAWN_NOT_FOUND_NAME, errTmuxSessionConflict('resume', 'leftover').errDescription), AD_ERROR_CLASS_STATE],
    ['ErrTmuxSessionCreate', () => baseError(errTmuxSessionCreate().errName, errTmuxSessionConflict('spawn', 'conflicting-labels').errDescription), AD_ERROR_CLASS_LAUNCH_FAILURE],
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
    ['an errName getter that throws', () => Object.defineProperty(errTmuxSessionConflict('resume', 'own-id'), 'errName', { get: () => { throw new Error('boom') } })],
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
    const value = baseError(ERR_TMUX_SESSION_CONFLICT_NAME, secret)
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

/** The ROWS labels that build an `ErrTmuxKillFailed` by name: the four descriptions and the `ErrUnknownErrorName` envelope form. */
const KILL_FAILED_ROW_LABELS: ReadonlySet<string> = new Set([
  ...KILL_FAILED_DESCRIPTIONS.map((d) => `errTmuxKillFailed (${d})`),
  `errUnknownErrorName with the Phase-1-only name ${ERR_TMUX_KILL_FAILED_NAME}`,
])

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

  test.each([...KILL_FAILED_DESCRIPTIONS])(
    'an ErrUnknownErrorName whose unknownName is ErrTmuxKillFailed, carrying the %s description, answers the envelope description, not its own errDescription',
    (d) => {
      const value = unknownNamedKillFailed(d, OTHER_SESSION_NAME)
      const expected = (value.envelope as { err_description: string }).err_description
      // Precondition: the envelope holds the stub's description and the client's own text differs.
      expect(expected).toBe(errTmuxKillFailed(OTHER_SESSION_NAME, d).errDescription)
      expect(value.errDescription).not.toBe(expected)
      expect(killFailedDescriptionOf(value)).toBe(expected)
    },
  )

  test.each(
    ROWS.filter(([label]) => !KILL_FAILED_ROW_LABELS.has(label)).map(([label, build, expected]) => [label, expected, build] as const),
  )('%s (%s) answers nothing', (_label, _expected, build) => {
    expect(killFailedDescriptionOf(build())).toBeUndefined()
  })

  test.each<Built>([
    ['ErrTmuxSessionConflict (kill, not-this-launch)', () => baseError(ERR_TMUX_SESSION_CONFLICT_NAME, errTmuxKillFailed().errDescription)],
    ['ErrTmuxUnresponsive', () => baseError(ERR_TMUX_UNRESPONSIVE_NAME, errTmuxKillFailed().errDescription)],
    ['ErrSpawnNotFound', () => baseError(ERR_SPAWN_NOT_FOUND_NAME, errTmuxKillFailed().errDescription)],
    ['an ErrInternal (envelope description)', () => errInternal(errTmuxKillFailed().errDescription)],
    ['an ErrUnknownErrorName of another name', () => errUnknownErrorName('ErrFromALaterBinary', errTmuxKillFailed().errDescription)],
  ])('%s carrying a kill-failure description answers nothing: the name decides, never the words', (_label, build) => {
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
    ['an errName getter that throws', () => Object.defineProperty(errTmuxKillFailed(), 'errName', { get: () => { throw new Error('boom') } })],
    ['an errDescription getter that throws', () => Object.defineProperty(errTmuxKillFailed(), 'errDescription', { get: () => { throw new Error('boom') } })],
    ['an errDescription that is not a string', () => Object.defineProperty(errTmuxKillFailed(), 'errDescription', { value: 42 })],
    ['an envelope getter that throws', () => Object.defineProperty(unknownNamedKillFailed('outlived-exit-wait'), 'envelope', { get: () => { throw new Error('boom') } })],
    ['an envelope with no description', () => Object.defineProperty(unknownNamedKillFailed('outlived-exit-wait'), 'envelope', { value: { err_name: ERR_TMUX_KILL_FAILED_NAME } })],
    ['a proxy whose every trap throws', hostileProxy],
    ['a proxy over an ErrTmuxKillFailed whose every read throws', () => new Proxy(errTmuxKillFailed(), { get: () => { throw new Error('boom') } })],
  ])('%s answers nothing, and nothing throws', (_label, build) => {
    const value = build()
    expect(() => killFailedDescriptionOf(value)).not.toThrow()
    expect(killFailedDescriptionOf(value)).toBeUndefined()
  })

  test('the description comes back raw: not redacted, not put on one line, not capped', () => {
    const description = `${RETRY_KILL_LATER_PHRASE}\n${sentinelInMessage('kill')}\r\n${'x'.repeat(MAX_LOGGED_MESSAGE_LENGTH)} ${NEVER_DELETE_ROW_PHRASE}`
    expect(killFailedDescriptionOf(baseError(ERR_TMUX_KILL_FAILED_NAME, description))).toBe(description)
    expect(killFailedDescriptionOf(errUnknownErrorName(ERR_TMUX_KILL_FAILED_NAME, description))).toBe(description)
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
      'an errName getter that throws (its description is still reported)',
      () => Object.defineProperty(errSpawnNotFound(), 'errName', { get: () => { throw new Error('boom') } }),
      (value) => `message=${JSON.stringify((value as { readonly errDescription: string }).errDescription)}`,
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

  test.each([
    ['the client\'s ErrInvalidFlags', () => errInvalidFlags('resume')],
    ['a base error with that errName', () => baseError(errInvalidFlags().errName)],
  ])('%s narrowed by isInvalidFlagsError gets an answer whose re-check is always present', async (_label, build) => {
    const value: unknown = build()
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
