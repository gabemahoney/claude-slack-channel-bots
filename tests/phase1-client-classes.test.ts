/**
 * phase1-client-classes.test.ts — the agent-director error classes
 * `src/agent-director-errors.ts` exports for the classifier are the pinned
 * client's own (b.jg5 SRJ-101, SRJ-103; PRD AC 14).
 *
 * One identity check per class: SRJ-103's seven re-exports
 * (`ErrTmuxKillFailed`, `ErrTmuxUnresponsive`, `ErrTmuxSessionConflict`,
 * `ErrTmuxSendKeys`, `ErrTmuxCaptureFailed`, `ErrTmuxSessionCreate`,
 * `ErrUnknownErrorName`) and `ErrSendKeysWhileRelayed` are each the class
 * `agent-director` exports by that name, and the client declares it (a
 * subclass of its `AgentDirectorError`). A copy, a subclass or any other
 * class in its place fails its row.
 *
 * The same identities, and the client-built errors' classification, are
 * checked on the installed package in the cscb-ci image
 * (`tests/integration/fixtures/phase1-client-check.ts`; its pure checker is
 * tested in `tests/phase1-client-check.test.ts`). That the three
 * Phase-1-only classes are plain named re-exports, read no other way and
 * never replaced by a CSCB class is pinned by `tests/fmk-source-audit.test.ts`.
 *
 * Never reads `Client` or `resolveSystemBinary`.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'

import * as agentDirector from 'agent-director'

import {
  ErrSendKeysWhileRelayed,
  ErrTmuxCaptureFailed,
  ErrTmuxKillFailed,
  ErrTmuxSendKeys,
  ErrTmuxSessionConflict,
  ErrTmuxSessionCreate,
  ErrTmuxUnresponsive,
  ErrUnknownErrorName,
} from '../src/agent-director-errors.ts'

describe('b.jg5 SRJ-103: each class src/agent-director-errors.ts re-exports is the pinned client\'s own', () => {
  test.each([
    ['ErrTmuxKillFailed', ErrTmuxKillFailed, agentDirector.ErrTmuxKillFailed],
    ['ErrTmuxUnresponsive', ErrTmuxUnresponsive, agentDirector.ErrTmuxUnresponsive],
    ['ErrTmuxSessionConflict', ErrTmuxSessionConflict, agentDirector.ErrTmuxSessionConflict],
    ['ErrTmuxSendKeys', ErrTmuxSendKeys, agentDirector.ErrTmuxSendKeys],
    ['ErrTmuxCaptureFailed', ErrTmuxCaptureFailed, agentDirector.ErrTmuxCaptureFailed],
    ['ErrTmuxSessionCreate', ErrTmuxSessionCreate, agentDirector.ErrTmuxSessionCreate],
    ['ErrUnknownErrorName', ErrUnknownErrorName, agentDirector.ErrUnknownErrorName],
    ['ErrSendKeysWhileRelayed', ErrSendKeysWhileRelayed, agentDirector.ErrSendKeysWhileRelayed],
  ])('%s is the client\'s own class', (_name, exported, own) => {
    // The client declares the class, so a row cannot pass on two absent values.
    expect(typeof own === 'function' && own.prototype instanceof agentDirector.AgentDirectorError).toBe(true)
    expect(exported).toBe(own)
  })
})
