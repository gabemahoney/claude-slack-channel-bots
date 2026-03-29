/**
 * test-helpers/sessions-stub.ts — Shared sessions stub factory for tests
 *
 * SPDX-License-Identifier: MIT
 */

import { type SessionsMap } from '../../src/sessions.ts'

export function makeSessionsStubs(initial: SessionsMap = {}) {
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
