/**
 * phase1-client-check.test.ts — the pure checker `checkPhase1Client` of the
 * image-side fixture `tests/integration/fixtures/phase1-client-check.ts`
 * (b.jg5 SRJ-101, SRJ-103, SRJ-104).
 *
 * Only the checker, its problem kinds and its fail-line helper are imported;
 * the fixture's entry point never runs (it runs only when the file is executed
 * directly, in a cscb-ci image). No case reads `/etc/cscb-ci-image` or an
 * installed package, starts a process or reads the real agent-director
 * client: the client is a file-local fake namespace whose three Phase-1-only
 * classes are `src/agent-director-errors.ts`'s bindings, whose 0.10.0 classes
 * are that module's re-exports, and whose `errorFromEnvelope` builds each
 * error from those classes. The package's modules are this worktree's
 * `src/agent-director-errors.ts` (its presence flag set true),
 * `src/ad-error-class.ts` and `src/ad-description-phrases.ts`, patched per
 * case. Covers:
 *
 *   1. That consistent input gives no problem.
 *   2. One mismatched input per rule, each named by its problem kind: an
 *      export the checker needs missing; the presence flag not true; an
 *      export that is not the client's own, or a class the client lacks; a
 *      client-built error that is no instance of its export, or a build that
 *      throws; a wrong class from the classifier; a description
 *      `conflictDescriptionOf` or `killFailedDescriptionOf` does not return;
 *      the launch-timeout predicate false; the re-bound-socket predicate
 *      false. Each case's `FAIL:` lines carry no credential.
 *   3. A module whose every read throws: problems, never a throw.
 *   4. The `FAIL:` line for a problem.
 *
 * Phrases, names and class labels come from `src/`, never literals.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'

import * as adDescriptionPhrases from '../src/ad-description-phrases.ts'
import { CONFLICT_NOT_THIS_LAUNCH_PHRASE, RETRY_KILL_LATER_PHRASE } from '../src/ad-description-phrases.ts'
import * as adErrorClass from '../src/ad-error-class.ts'
import { AD_ERROR_CLASS_GONE, LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT, classifyAdError } from '../src/ad-error-class.ts'
import * as agentDirectorErrors from '../src/agent-director-errors.ts'
import {
  AgentDirectorError,
  ERR_TMUX_KILL_FAILED_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
  ERR_TMUX_UNRESPONSIVE_NAME,
  ErrTmuxCaptureFailed,
  ErrTmuxKillFailed,
  ErrTmuxNotAvailable,
  ErrTmuxSendKeys,
  ErrTmuxSessionConflict,
  ErrTmuxSessionCreate,
  ErrTmuxUnresponsive,
  ErrUnknownErrorName,
  PHASE1_ONLY_ERR_NAMES,
} from '../src/agent-director-errors.ts'
import type { AdErrorClassConstructor, Phase1OnlyErrName } from '../src/agent-director-errors.ts'
import {
  PHASE1_CLIENT_CHECK_TEST_NAME,
  PROBLEM_CLASSIFICATION,
  PROBLEM_CONFLICT_DESCRIPTION,
  PROBLEM_DIFFERENT_TMUX_SERVER,
  PROBLEM_ENVELOPE_BUILD,
  PROBLEM_IDENTITY,
  PROBLEM_KILL_FAILED_DESCRIPTION,
  PROBLEM_LAUNCH_TIMEOUT,
  PROBLEM_MISSING_EXPORT,
  PROBLEM_PRESENCE_FLAG,
  checkPhase1Client,
  phase1ClientCheckFailLine,
} from './integration/fixtures/phase1-client-check.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import type { ModuleNamespace, Phase1ClientCheckModules, Phase1ClientCheckProblem, Phase1ClientCheckProblemKind } from './integration/fixtures/phase1-client-check.ts'

// ---------------------------------------------------------------------------
// Fake modules
// ---------------------------------------------------------------------------

/** Each Phase-1-only binding of `src/agent-director-errors.ts`, by name. */
const BINDINGS: Readonly<Record<Phase1OnlyErrName, AdErrorClassConstructor>> = {
  [ERR_TMUX_KILL_FAILED_NAME]: ErrTmuxKillFailed,
  [ERR_TMUX_UNRESPONSIVE_NAME]: ErrTmuxUnresponsive,
  [ERR_TMUX_SESSION_CONFLICT_NAME]: ErrTmuxSessionConflict,
}

/** The classes the fake client's `errorFromEnvelope` builds, by err_name: the four the checker builds. */
const ENVELOPE_CLASSES: Readonly<Record<string, AdErrorClassConstructor>> = {
  ...BINDINGS,
  [ErrTmuxNotAvailable.name]: ErrTmuxNotAvailable,
}

/** A fake client's `errorFromEnvelope`: builds `classes[err_name]`, a base `AgentDirectorError` for any other name. */
function fakeErrorFromEnvelope(classes: Readonly<Record<string, AdErrorClassConstructor>> = ENVELOPE_CLASSES) {
  return (verb: string, errName: string, description: string): AgentDirectorError => new (classes[errName] ?? AgentDirectorError)(verb, errName, description)
}

/** A fake agent-director namespace consistent with `src/agent-director-errors.ts`. */
function fakeClient(): ModuleNamespace {
  return {
    ...BINDINGS,
    AgentDirectorError,
    ErrTmuxSendKeys,
    ErrTmuxCaptureFailed,
    ErrTmuxSessionCreate,
    ErrUnknownErrorName,
    ErrTmuxNotAvailable,
    errorFromEnvelope: fakeErrorFromEnvelope(),
  }
}

/** Per-module overrides over the consistent input. */
interface ModulePatch {
  readonly errors?: ModuleNamespace
  readonly errorClass?: ModuleNamespace
  readonly phrases?: ModuleNamespace
  readonly client?: ModuleNamespace
}

/** The consistent input, with `patch` spread over each module. */
function modulesWith(patch: ModulePatch = {}): Phase1ClientCheckModules {
  return {
    errors: { ...agentDirectorErrors, PHASE1_ERROR_CLASSES_FROM_CLIENT: true, ...patch.errors },
    errorClass: { ...adErrorClass, ...patch.errorClass },
    phrases: { ...adDescriptionPhrases, ...patch.phrases },
    client: { ...fakeClient(), ...patch.client },
  }
}

/** A function that throws when called. */
function throwing(): never {
  throw new Error('refused by the test')
}

/** A class that is not the client's. */
class Impostor extends AgentDirectorError {}

/** The checker's problem kinds, in order. */
function kindsOf(problems: readonly Phase1ClientCheckProblem[]): Phase1ClientCheckProblemKind[] {
  return problems.map((p) => p.kind)
}

// ---------------------------------------------------------------------------
// 1. Consistent input
// ---------------------------------------------------------------------------

describe('checkPhase1Client: consistent input', () => {
  test('reports no problem', () => {
    expect(checkPhase1Client(modulesWith())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. One mismatch per rule
// ---------------------------------------------------------------------------

interface MismatchCase {
  readonly label: string
  readonly patch: ModulePatch
  /** The problem kinds expected, in the checker's order. */
  readonly kinds: readonly Phase1ClientCheckProblemKind[]
  /** What the first problem's detail names. */
  readonly names: string
}

const MISMATCHES: readonly MismatchCase[] = [
  // An export the checker needs.
  { label: 'agent-director-errors lacks a Phase-1-only name constant', patch: { errors: { ERR_TMUX_SESSION_CONFLICT_NAME: undefined } }, kinds: [PROBLEM_MISSING_EXPORT], names: 'ERR_TMUX_SESSION_CONFLICT_NAME' },
  { label: 'ad-error-class has a non-function classifyAdError', patch: { errorClass: { classifyAdError: AD_ERROR_CLASS_GONE } }, kinds: [PROBLEM_MISSING_EXPORT], names: 'classifyAdError' },
  { label: 'ad-description-phrases lacks LAUNCH_TIMEOUT_PHRASE', patch: { phrases: { LAUNCH_TIMEOUT_PHRASE: undefined } }, kinds: [PROBLEM_MISSING_EXPORT], names: 'LAUNCH_TIMEOUT_PHRASE' },
  { label: 'the client lacks errorFromEnvelope', patch: { client: { errorFromEnvelope: undefined } }, kinds: [PROBLEM_MISSING_EXPORT], names: 'errorFromEnvelope' },

  // The presence flag.
  { label: 'the presence flag is false', patch: { errors: { PHASE1_ERROR_CLASSES_FROM_CLIENT: false } }, kinds: [PROBLEM_PRESENCE_FLAG], names: 'PHASE1_ERROR_CLASSES_FROM_CLIENT' },
  { label: 'the presence flag is missing', patch: { errors: { PHASE1_ERROR_CLASSES_FROM_CLIENT: undefined } }, kinds: [PROBLEM_PRESENCE_FLAG], names: 'PHASE1_ERROR_CLASSES_FROM_CLIENT' },

  // Identity: a Phase-1-only export that is not the client's also builds no instance of it.
  ...PHASE1_ONLY_ERR_NAMES.map((name): MismatchCase => ({
    label: `agent-director-errors ${name} is not the client's class`,
    patch: { errors: { [name]: Impostor } },
    kinds: [PROBLEM_IDENTITY, PROBLEM_ENVELOPE_BUILD],
    names: name,
  })),
  ...[ErrTmuxSendKeys, ErrTmuxCaptureFailed, ErrTmuxSessionCreate, ErrUnknownErrorName].map(({ name }): MismatchCase => ({
    label: `agent-director-errors ${name} is not the client's class`,
    patch: { errors: { [name]: Impostor } },
    kinds: [PROBLEM_IDENTITY],
    names: name,
  })),
  { label: 'the client exports no ErrTmuxCaptureFailed', patch: { client: { [ErrTmuxCaptureFailed.name]: undefined } }, kinds: [PROBLEM_IDENTITY], names: ErrTmuxCaptureFailed.name },

  // A client-built error that is no instance of its export.
  ...[...PHASE1_ONLY_ERR_NAMES, ErrTmuxNotAvailable.name].map((name): MismatchCase => ({
    label: `errorFromEnvelope builds a base AgentDirectorError for ${name}`,
    patch: { client: { errorFromEnvelope: fakeErrorFromEnvelope({ ...ENVELOPE_CLASSES, [name]: AgentDirectorError }) } },
    kinds: [PROBLEM_ENVELOPE_BUILD],
    names: name,
  })),
  { label: 'errorFromEnvelope throws', patch: { client: { errorFromEnvelope: throwing } }, kinds: [PROBLEM_ENVELOPE_BUILD, PROBLEM_ENVELOPE_BUILD, PROBLEM_ENVELOPE_BUILD, PROBLEM_ENVELOPE_BUILD], names: 'threw' },

  // A wrong class from the classifier.
  ...PHASE1_ONLY_ERR_NAMES.map((name): MismatchCase => ({
    label: `classifyAdError answers GONE for ${name}`,
    patch: { errorClass: { classifyAdError: (value: unknown) => (value instanceof BINDINGS[name] ? { errorClass: AD_ERROR_CLASS_GONE } : classifyAdError(value)) } },
    kinds: [PROBLEM_CLASSIFICATION],
    names: name,
  })),
  { label: 'classifyAdError throws', patch: { errorClass: { classifyAdError: throwing } }, kinds: [PROBLEM_CLASSIFICATION, PROBLEM_CLASSIFICATION, PROBLEM_CLASSIFICATION], names: 'threw' },

  // A description the description readers do not return.
  { label: 'conflictDescriptionOf answers another description', patch: { errorClass: { conflictDescriptionOf: () => RETRY_KILL_LATER_PHRASE } }, kinds: [PROBLEM_CONFLICT_DESCRIPTION], names: 'conflictDescriptionOf' },
  { label: 'conflictDescriptionOf throws', patch: { errorClass: { conflictDescriptionOf: throwing } }, kinds: [PROBLEM_CONFLICT_DESCRIPTION], names: 'conflictDescriptionOf' },
  { label: 'killFailedDescriptionOf answers another description', patch: { errorClass: { killFailedDescriptionOf: () => CONFLICT_NOT_THIS_LAUNCH_PHRASE } }, kinds: [PROBLEM_KILL_FAILED_DESCRIPTION], names: 'killFailedDescriptionOf' },
  { label: 'killFailedDescriptionOf throws', patch: { errorClass: { killFailedDescriptionOf: throwing } }, kinds: [PROBLEM_KILL_FAILED_DESCRIPTION], names: 'killFailedDescriptionOf' },

  // The launch-timeout predicate.
  { label: 'launchTimeoutFormOf answers no form', patch: { errorClass: { launchTimeoutFormOf: () => undefined } }, kinds: [PROBLEM_LAUNCH_TIMEOUT], names: 'launchTimeoutFormOf' },
  { label: 'launchTimeoutFormOf answers the ErrCallTimeout form', patch: { errorClass: { launchTimeoutFormOf: () => LAUNCH_TIMEOUT_FORM_CALL_TIMEOUT } }, kinds: [PROBLEM_LAUNCH_TIMEOUT], names: 'launchTimeoutFormOf' },

  // The re-bound-socket predicate.
  { label: 'isDifferentTmuxServerError answers false', patch: { errorClass: { isDifferentTmuxServerError: () => false } }, kinds: [PROBLEM_DIFFERENT_TMUX_SERVER], names: 'isDifferentTmuxServerError' },
  { label: 'isDifferentTmuxServerError throws', patch: { errorClass: { isDifferentTmuxServerError: throwing } }, kinds: [PROBLEM_DIFFERENT_TMUX_SERVER], names: 'isDifferentTmuxServerError' },
]

describe('checkPhase1Client: one mismatch per rule', () => {
  test.each(MISMATCHES.map((c) => [c.label, c] as const))('%s', (_label, c) => {
    const problems = checkPhase1Client(modulesWith(c.patch))
    expect(kindsOf(problems)).toEqual([...c.kinds])
    expect(problems[0]?.detail).toContain(c.names)
    // The FAIL: lines go to the image's test log, quoting the classifier's and the readers' answers.
    assertNoLeak(problems.map(phase1ClientCheckFailLine))
  })
})

// ---------------------------------------------------------------------------
// 3. Reads that throw
// ---------------------------------------------------------------------------

describe('checkPhase1Client: a module whose every read throws', () => {
  test('answers problems and does not throw', () => {
    const refusing: ModuleNamespace = new Proxy({}, { get: throwing })
    const problems = checkPhase1Client({ ...modulesWith(), errors: refusing })
    expect(new Set(kindsOf(problems))).toEqual(new Set([PROBLEM_MISSING_EXPORT, PROBLEM_PRESENCE_FLAG, PROBLEM_IDENTITY, PROBLEM_ENVELOPE_BUILD]))
  })
})

// ---------------------------------------------------------------------------
// 4. The FAIL: line
// ---------------------------------------------------------------------------

describe('phase1ClientCheckFailLine', () => {
  test('names the test, the kind and the detail', () => {
    const [problem] = checkPhase1Client(modulesWith({ errors: { PHASE1_ERROR_CLASSES_FROM_CLIENT: false } }))
    expect(problem).toBeDefined()
    expect(phase1ClientCheckFailLine(problem!)).toBe(`FAIL: ${PHASE1_CLIENT_CHECK_TEST_NAME}: ${PROBLEM_PRESENCE_FLAG}: ${problem!.detail}`)
  })
})
