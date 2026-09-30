/**
 * ad-error-class.test.ts — the one classifier of agent-director errors
 * (b.jg5 SRJ-104), the `ErrInvalidFlags` step beside it, and the stub's error
 * builders it is fed with (b.jg5 SRJ-1303; their shape checks live here).
 *
 * Every value is built with the stub's builders; a value the stub has no
 * builder for (`ErrCwdNotFound`, `ErrCwdNotADirectory`,
 * `ErrSendKeysWhileRelayed`) is built with `new` on the 0.10.0 client's own
 * class, imported through `src/agent-director-errors.ts`, its `errName` taken
 * from the class name. The three Phase-1-only names and the three store-open
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
  describeAdErrorClassification,
  isInvalidFlagsError,
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
  ERR_STORE_OPEN_NAME,
  ERR_TMUX_KILL_FAILED_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
  ERR_TMUX_UNRESPONSIVE_NAME,
  ErrCwdNotADirectory,
  ErrCwdNotFound,
  ErrSendKeysWhileRelayed,
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
  errGeneric,
  errInstanceIdCollision,
  errInternal,
  errInvalidFlags,
  errJsonlMissing,
  errJsonlNeverWritten,
  errNoSessionId,
  errSchemaMismatch,
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

/** A value of the 0.10.0 client's own class that the stub has no builder for; `errName` is the class name. */
function clientError<T extends AgentDirectorError>(
  Cls: new (verb: string, errName: string, description: string) => T,
  verb: string,
  description: string,
): T {
  return new Cls(verb, Cls.name, description)
}

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
  ['ErrCwdNotFound', () => clientError(ErrCwdNotFound, 'spawn', 'cwd not found'), AD_ERROR_CLASS_DIRECTORY],
  ['ErrCwdNotADirectory', () => clientError(ErrCwdNotADirectory, 'spawn', 'cwd not a directory'), AD_ERROR_CLASS_DIRECTORY],
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
    'ErrSendKeysWhileRelayed (a name CSCB gives no handling)',
    () => clientError(ErrSendKeysWhileRelayed, 'send-keys', 'relay is on'),
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
    expect(STORE_OPEN_BUILDERS.map(([name]) => name)).toEqual(SRD_STORE_OPEN_NAMES)
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

  test('the UNAVAILABLE row\'s later name is none of the names the classifier handles by unknownName', () => {
    expect([...STORE_OPEN_ERR_NAMES, ERR_INTERNAL, ERR_CONFIG_MALFORMED]).not.toContain(errUnknownErrorName().unknownName)
  })

  test('no store-open name is a Phase-1-only name or a name the startup gate requires as a class', () => {
    for (const name of STORE_OPEN_ERR_NAMES) {
      expect(PHASE1_ONLY_ERR_NAMES as readonly string[]).not.toContain(name)
      expect(REQUIRED_ERR_NAMES as readonly string[]).not.toContain(name)
    }
  })

  test('errSchemaMismatch\'s default description says the store could not be opened', () => {
    expect((errSchemaMismatch().envelope as { err_description: string }).err_description).toContain('could not be opened')
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
    const err = clientError(ErrSendKeysWhileRelayed, 'send-keys', 'relay is on')
    expect(classifyAdError(err)).toEqual({
      errorClass: AD_ERROR_CLASS_UNCLASSIFIED,
      reportedName: ErrSendKeysWhileRelayed.name,
      message: 'relay is on',
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
      [classifyAdError(errNamed(ErrSendKeysWhileRelayed.name)), ErrSendKeysWhileRelayed.name, redacted],
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
  ])('%s → %p', (_label, expected, build) => {
    expect(isInvalidFlagsError(build())).toBe(expected)
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
