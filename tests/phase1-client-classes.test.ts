/**
 * phase1-client-classes.test.ts — the agent-director error classes
 * `src/agent-director-errors.ts` exports for the classifier (b.jg5 SRJ-101,
 * SRJ-103), on the host's 0.10.0 client. Covers:
 *
 *   1. The 0.10.0 classes: `ErrTmuxSendKeys`, `ErrTmuxCaptureFailed`,
 *      `ErrTmuxSessionCreate`, `ErrUnknownErrorName` and
 *      `ErrSendKeysWhileRelayed` are the client's own classes, by identity.
 *   2. The three Phase-1-only bindings through the resolver's fallback
 *      branch: the host's client declares none of them (read through the
 *      namespace import and a typed optional cast), each binding is a CSCB
 *      stand-in (a subclass of the client's `AgentDirectorError`, named for
 *      its error, distinct from the other two, whose instances carry verb,
 *      `errName`, description and message as a client class's do), the
 *      resolver over the host's namespace answers those bindings, and
 *      `PHASE1_ERROR_CLASSES_FROM_CLIENT` is false.
 *   3. `resolvePhase1ErrorClasses` over file-local fake namespaces: one that
 *      declares all three answers its own classes with `fromClient` true; one
 *      that lacks any one, or declares something other than a subclass of
 *      `AgentDirectorError` for it, or whose read throws, answers the
 *      stand-in for that name, its own classes for the others, and
 *      `fromClient` false.
 *
 * The same identities and the client-built-error checks on the real Phase 1
 * client run in the cscb-ci image (`tests/integration/fixtures/phase1-client-check.ts`;
 * its pure checker is tested in `tests/phase1-client-check.test.ts`).
 *
 * This file reads the three Phase-1-only names from agent-director only
 * through the namespace import, never in a named import, a re-export or a
 * destructuring, and never reads `Client` or `resolveSystemBinary`. Names,
 * verbs and descriptions come from `src/`.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'

import * as agentDirector from 'agent-director'

import { RETRY_KILL_LATER_PHRASE } from '../src/ad-description-phrases.ts'
import { AD_VERB_KILL } from '../src/ad-error-class.ts'
import {
  AgentDirectorError,
  ERR_TMUX_KILL_FAILED_NAME,
  ERR_TMUX_SESSION_CONFLICT_NAME,
  ERR_TMUX_UNRESPONSIVE_NAME,
  ErrSendKeysWhileRelayed,
  ErrTmuxCaptureFailed,
  ErrTmuxKillFailed,
  ErrTmuxSendKeys,
  ErrTmuxSessionConflict,
  ErrTmuxSessionCreate,
  ErrTmuxUnresponsive,
  ErrUnknownErrorName,
  PHASE1_ERROR_CLASSES_FROM_CLIENT,
  PHASE1_ONLY_ERR_NAMES,
  resolvePhase1ErrorClasses,
} from '../src/agent-director-errors.ts'
import type { AdErrorClassConstructor, Phase1ErrorClasses, Phase1ErrorNamespace, Phase1OnlyErrName } from '../src/agent-director-errors.ts'

/** The host's client, read as `src/agent-director-errors.ts` reads it: the namespace through a typed optional cast. */
const HOST_CLIENT: Phase1ErrorNamespace = agentDirector as unknown as Phase1ErrorNamespace

/** Each Phase-1-only binding of `src/agent-director-errors.ts`, by name. */
const BINDINGS: Readonly<Record<Phase1OnlyErrName, AdErrorClassConstructor>> = {
  [ERR_TMUX_KILL_FAILED_NAME]: ErrTmuxKillFailed,
  [ERR_TMUX_UNRESPONSIVE_NAME]: ErrTmuxUnresponsive,
  [ERR_TMUX_SESSION_CONFLICT_NAME]: ErrTmuxSessionConflict,
}

/** One class from a `resolvePhase1ErrorClasses` answer, by name. */
function classOf(answer: Phase1ErrorClasses, name: Phase1OnlyErrName): AdErrorClassConstructor {
  return { [ERR_TMUX_KILL_FAILED_NAME]: answer.ErrTmuxKillFailed, [ERR_TMUX_UNRESPONSIVE_NAME]: answer.ErrTmuxUnresponsive, [ERR_TMUX_SESSION_CONFLICT_NAME]: answer.ErrTmuxSessionConflict }[name]
}

/** The fields an agent-director error carries from (verb, errName, description). */
function carried(err: AgentDirectorError): { verb: string; errName: string; errDescription: string; message: string } {
  return { verb: err.verb, errName: err.errName, errDescription: err.errDescription, message: err.message }
}

// ---------------------------------------------------------------------------
// 1. The 0.10.0 classes are the client's own
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-103: the 0.10.0 classes src/agent-director-errors.ts exports', () => {
  test.each([
    [agentDirector.ErrTmuxSendKeys.name, ErrTmuxSendKeys, agentDirector.ErrTmuxSendKeys],
    [agentDirector.ErrTmuxCaptureFailed.name, ErrTmuxCaptureFailed, agentDirector.ErrTmuxCaptureFailed],
    [agentDirector.ErrTmuxSessionCreate.name, ErrTmuxSessionCreate, agentDirector.ErrTmuxSessionCreate],
    [agentDirector.ErrUnknownErrorName.name, ErrUnknownErrorName, agentDirector.ErrUnknownErrorName],
    [agentDirector.ErrSendKeysWhileRelayed.name, ErrSendKeysWhileRelayed, agentDirector.ErrSendKeysWhileRelayed],
  ])('%s is the client\'s own class', (_name, exported, own) => {
    expect(exported).toBe(own)
  })
})

// ---------------------------------------------------------------------------
// 2. The Phase-1-only bindings on the host's client: the fallback branch
// ---------------------------------------------------------------------------

describe('b.jg5 SRJ-101 / SRJ-103: the Phase-1-only bindings on the host\'s 0.10.0 client', () => {
  const rows: ReadonlyArray<readonly [Phase1OnlyErrName, unknown]> = [
    [ERR_TMUX_KILL_FAILED_NAME, HOST_CLIENT.ErrTmuxKillFailed],
    [ERR_TMUX_UNRESPONSIVE_NAME, HOST_CLIENT.ErrTmuxUnresponsive],
    [ERR_TMUX_SESSION_CONFLICT_NAME, HOST_CLIENT.ErrTmuxSessionConflict],
  ]

  test.each(rows)('%s: the host\'s client does not export it', (_name, declared) => {
    expect(declared).toBeUndefined()
  })

  test.each(rows)('%s: the binding is a stand-in subclass of the client\'s AgentDirectorError named for it', (name) => {
    const binding = BINDINGS[name]
    expect(binding.prototype instanceof agentDirector.AgentDirectorError).toBe(true)
    expect(binding.name).toBe(name)
  })

  test.each(rows)('%s: a stand-in instance is named for its error and carries verb, errName, description and message as a client class\'s does', (name) => {
    const standIn = new BINDINGS[name](AD_VERB_KILL, name, RETRY_KILL_LATER_PHRASE)
    const own = new agentDirector.ErrTmuxSendKeys(AD_VERB_KILL, name, RETRY_KILL_LATER_PHRASE)
    expect(standIn.name).toBe(name)
    expect(carried(standIn)).toEqual(carried(own))
  })

  test.each(rows)('%s: a stand-in instance is no instance of the other two stand-ins', (name) => {
    const standIn = new BINDINGS[name](AD_VERB_KILL, name, RETRY_KILL_LATER_PHRASE)
    const others = PHASE1_ONLY_ERR_NAMES.filter((other) => other !== name)
    expect(others.map((other) => standIn instanceof BINDINGS[other])).toEqual([false, false])
  })

  test('the resolver over the host\'s namespace answers these bindings, not from the client', () => {
    const answer = resolvePhase1ErrorClasses(HOST_CLIENT)
    expect(PHASE1_ONLY_ERR_NAMES.map((name) => classOf(answer, name) === BINDINGS[name])).toEqual([true, true, true])
    expect(answer.fromClient).toBe(false)
  })

  test('PHASE1_ERROR_CLASSES_FROM_CLIENT is false', () => {
    expect(PHASE1_ERROR_CLASSES_FROM_CLIENT).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. The resolver over fake namespaces
// ---------------------------------------------------------------------------

class FakeKillFailed extends AgentDirectorError {}
class FakeUnresponsive extends AgentDirectorError {}
class FakeSessionConflict extends AgentDirectorError {}

/** A fake client's own class for each Phase-1-only name. */
const FAKE_CLASSES: Readonly<Record<Phase1OnlyErrName, AdErrorClassConstructor>> = {
  [ERR_TMUX_KILL_FAILED_NAME]: FakeKillFailed,
  [ERR_TMUX_UNRESPONSIVE_NAME]: FakeUnresponsive,
  [ERR_TMUX_SESSION_CONFLICT_NAME]: FakeSessionConflict,
}

/** A fake namespace declaring every Phase-1-only class except `without`. */
function fakeNamespaceWithout(without?: Phase1OnlyErrName): Phase1ErrorNamespace {
  const namespace: Record<string, unknown> = {}
  for (const name of PHASE1_ONLY_ERR_NAMES) if (name !== without) namespace[name] = FAKE_CLASSES[name]
  return namespace
}

/** Where a resolved class came from: the fake's own class, the host's stand-in binding, or neither. */
type Source = 'own' | 'stand-in' | 'other'

/** The source of each class `answer` holds, by name. */
function sourcesOf(answer: Phase1ErrorClasses): Record<Phase1OnlyErrName, Source> {
  const sourceOf = (name: Phase1OnlyErrName): Source => {
    const cls = classOf(answer, name)
    if (cls === FAKE_CLASSES[name]) return 'own'
    return cls === BINDINGS[name] ? 'stand-in' : 'other'
  }
  return {
    [ERR_TMUX_KILL_FAILED_NAME]: sourceOf(ERR_TMUX_KILL_FAILED_NAME),
    [ERR_TMUX_UNRESPONSIVE_NAME]: sourceOf(ERR_TMUX_UNRESPONSIVE_NAME),
    [ERR_TMUX_SESSION_CONFLICT_NAME]: sourceOf(ERR_TMUX_SESSION_CONFLICT_NAME),
  }
}

/** The sources expected: the stand-in for `standIn`, the fake's own class for every other name. */
function expectedSources(standIn?: Phase1OnlyErrName): Record<Phase1OnlyErrName, Source> {
  const sourceOf = (name: Phase1OnlyErrName): Source => (name === standIn ? 'stand-in' : 'own')
  return {
    [ERR_TMUX_KILL_FAILED_NAME]: sourceOf(ERR_TMUX_KILL_FAILED_NAME),
    [ERR_TMUX_UNRESPONSIVE_NAME]: sourceOf(ERR_TMUX_UNRESPONSIVE_NAME),
    [ERR_TMUX_SESSION_CONFLICT_NAME]: sourceOf(ERR_TMUX_SESSION_CONFLICT_NAME),
  }
}

describe('b.jg5 SRJ-101: resolvePhase1ErrorClasses over a fake namespace', () => {
  test('a namespace declaring all three answers its own classes, from the client', () => {
    const answer = resolvePhase1ErrorClasses(fakeNamespaceWithout())
    expect(sourcesOf(answer)).toEqual(expectedSources())
    expect(answer.fromClient).toBe(true)
  })

  test.each(PHASE1_ONLY_ERR_NAMES.map((name) => [name]))('a namespace lacking %s answers its stand-in and the namespace\'s other two classes, not from the client', (missing) => {
    const answer = resolvePhase1ErrorClasses(fakeNamespaceWithout(missing))
    expect(sourcesOf(answer)).toEqual(expectedSources(missing))
    expect(answer.fromClient).toBe(false)
  })

  class NotAnAgentDirectorError extends Error {}

  test.each([
    ['a class that does not extend AgentDirectorError', NotAnAgentDirectorError],
    ['the base AgentDirectorError itself', AgentDirectorError],
    ['a string naming the class', ERR_TMUX_SESSION_CONFLICT_NAME],
  ])('%s declared for one name answers the stand-in for it, not from the client', (_label, declared) => {
    const namespace = { ...fakeNamespaceWithout(), [ERR_TMUX_SESSION_CONFLICT_NAME]: declared }
    const answer = resolvePhase1ErrorClasses(namespace)
    expect(sourcesOf(answer)).toEqual(expectedSources(ERR_TMUX_SESSION_CONFLICT_NAME))
    expect(answer.fromClient).toBe(false)
  })

  test('a read that throws answers the stand-in for that name and does not throw', () => {
    const namespace = Object.defineProperty({ ...fakeNamespaceWithout(ERR_TMUX_KILL_FAILED_NAME) }, ERR_TMUX_KILL_FAILED_NAME, {
      get(): never {
        throw new Error('namespace read refused')
      },
    })
    const answer = resolvePhase1ErrorClasses(namespace)
    expect(sourcesOf(answer)).toEqual(expectedSources(ERR_TMUX_KILL_FAILED_NAME))
    expect(answer.fromClient).toBe(false)
  })
})
