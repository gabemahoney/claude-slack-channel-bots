/**
 * test-helpers/sessions-stub.ts — Shared sessions stub factory for tests
 *
 * SPDX-License-Identifier: MIT
 */

import { type SessionRecord, type SessionsMap } from '../../src/sessions.ts'

/**
 * Build a minimal SessionRecord for tests.
 * Supply `claude_instance_id` when tests need to assert against the E2 poller field.
 * Default behavior unchanged when not supplied.
 */
export function makeSessionRecord(overrides: Partial<SessionRecord> & { tmuxSession?: string } = {}): SessionRecord {
  return {
    tmuxSession: 'test-tmux-session',
    lastLaunch: new Date().toISOString(),
    sessionId: 'pending',
    ...overrides,
  }
}

export function makeSessionsStubs(initial: Record<string, SessionRecord> = {}) {
  let sessions: SessionsMap = { ...initial }
  const writtenSessions: SessionsMap[] = []

  return {
    get current() { return sessions },
    writtenSessions,
    read: (_path?: string): SessionsMap => ({ ...sessions }),
    write: (s: SessionsMap, _path?: string): void => {
      writtenSessions.push({ ...s })
      sessions = { ...s }
    },
  }
}
