/**
 * agent-director-stub.test.ts — Self-tests for the typed AD-error factories
 * in agent-director-stub.ts (Subtask t3.a3g.b7.di.ar / SR-22.2).
 *
 * Verifies that each factory:
 *   - Returns the correct typed subclass (instanceof ErrTmuxSendKeys /
 *     ErrTmuxSessionCreate) AND instanceof AgentDirectorError.
 *   - Carries the expected errName / verb / errDescription fields.
 *   - NotFound vs Generic descriptions are distinct; only NotFound matches
 *     the SR-22.2 "session not found" discriminator.
 *
 * No inline `new AgentDirectorError(...)` / `new ErrTmux*(...)` in this file —
 * all instances come from the factory functions under test.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect } from 'bun:test'
import { AgentDirectorError, ErrTmuxSendKeys, ErrTmuxSessionCreate } from 'agent-director'
import {
  errTmuxSendKeysNotFound,
  errTmuxSendKeysGeneric,
  errTmuxSessionCreate,
} from './agent-director-stub.ts'

// SR-22.2 discriminator string
const SESSION_NOT_FOUND = 'session not found'

describe('errTmuxSendKeysNotFound()', () => {
  test('is instanceof ErrTmuxSendKeys', () => {
    expect(errTmuxSendKeysNotFound()).toBeInstanceOf(ErrTmuxSendKeys)
  })

  test('is instanceof AgentDirectorError', () => {
    expect(errTmuxSendKeysNotFound()).toBeInstanceOf(AgentDirectorError)
  })

  test('errName is ErrTmuxSendKeys', () => {
    expect(errTmuxSendKeysNotFound().errName).toBe('ErrTmuxSendKeys')
  })

  test('verb is send-keys', () => {
    expect(errTmuxSendKeysNotFound().verb).toBe('send-keys')
  })

  test('errDescription matches the SR-22.2 session-not-found discriminator', () => {
    expect(errTmuxSendKeysNotFound().errDescription).toBe(SESSION_NOT_FOUND)
  })
})

describe('errTmuxSendKeysGeneric()', () => {
  test('is instanceof ErrTmuxSendKeys', () => {
    expect(errTmuxSendKeysGeneric()).toBeInstanceOf(ErrTmuxSendKeys)
  })

  test('is instanceof AgentDirectorError', () => {
    expect(errTmuxSendKeysGeneric()).toBeInstanceOf(AgentDirectorError)
  })

  test('errName is ErrTmuxSendKeys', () => {
    expect(errTmuxSendKeysGeneric().errName).toBe('ErrTmuxSendKeys')
  })

  test('verb is send-keys', () => {
    expect(errTmuxSendKeysGeneric().verb).toBe('send-keys')
  })

  test('errDescription does NOT match the SR-22.2 discriminator', () => {
    expect(errTmuxSendKeysGeneric().errDescription).not.toBe(SESSION_NOT_FOUND)
  })

  test('errDescription is distinct from errTmuxSendKeysNotFound description', () => {
    expect(errTmuxSendKeysGeneric().errDescription).not.toBe(errTmuxSendKeysNotFound().errDescription)
  })

  test('accepts a custom description', () => {
    expect(errTmuxSendKeysGeneric('pane exited').errDescription).toBe('pane exited')
  })

  test('custom description does not match the SR-22.2 discriminator', () => {
    expect(errTmuxSendKeysGeneric('pane exited').errDescription).not.toBe(SESSION_NOT_FOUND)
  })
})

describe('errTmuxSessionCreate()', () => {
  test('is instanceof ErrTmuxSessionCreate', () => {
    expect(errTmuxSessionCreate()).toBeInstanceOf(ErrTmuxSessionCreate)
  })

  test('is instanceof AgentDirectorError', () => {
    expect(errTmuxSessionCreate()).toBeInstanceOf(AgentDirectorError)
  })

  test('errName is ErrTmuxSessionCreate', () => {
    expect(errTmuxSessionCreate().errName).toBe('ErrTmuxSessionCreate')
  })

  test('verb defaults to resume', () => {
    expect(errTmuxSessionCreate().verb).toBe('resume')
  })

  test('verb can be overridden to spawn', () => {
    expect(errTmuxSessionCreate('spawn').verb).toBe('spawn')
  })

  test('errDescription describes tmux session-already-exists failure', () => {
    expect(errTmuxSessionCreate().errDescription).toContain('tmux')
  })
})
