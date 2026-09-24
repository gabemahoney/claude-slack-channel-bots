/**
 * test-helpers/persona-routing-managed.ts — The real inbound routing module
 * over the real connection manager's seams, built as `src/server.ts` builds
 * it (b.av2 SR-3.1, SR-4.1, SR-4.2 step 2).
 *
 * `makeManagedRouting(h, baseDir, opts?)` takes a connection harness
 * (`makeConnectionHarness`) and builds `createPersonaRouting` with the same
 * seams the server passes: `getBotIdentity` from the harness's identity getter
 * (`createPersonaIdentityLookup`), `clientFor` from its client lookup
 * (`createPersonaClientLookup`), the user-name lookup on the receiving
 * persona's own client (`users.info`, the ID when it has no client), and the
 * archive seam the caller passes (default: none). It registers one session per
 * harness persona in the real registry (a fake transport holding
 * `_GET_stream` and a server that records `notifications/claude/channel`).
 *
 * `tests/test-helpers/persona-routing-harness.ts` is the stub-client
 * counterpart; use this one when the routing must read the connection
 * manager's per-persona identities and clients. The caller owns the restart
 * deps (`initRestart`), `resetRoutingState()` and `h.manager.stopAll()`.
 *
 * Isolation (b.av2 SR-13.2): session paths are under the caller's `baseDir`;
 * no I/O of its own, no timers, no token literal.
 *
 * SPDX-License-Identifier: MIT
 */

import { join } from 'node:path'

import { createPersonaRouting, type PersonaRouting, type PersonaRoutingDeps } from '../../src/persona-routing.ts'
import { registerSession } from '../../src/registry.ts'
import type { ConnectionHarness } from './persona-connection-harness.ts'
import { makeSessionServer, makeTransport, type ChannelNotification } from './persona-routing-harness.ts'

export interface ManagedRoutingOptions {
  /** The archive seam, as the server's `archiveWrite`; default: no archive. */
  archive?: PersonaRoutingDeps['archive']
}

export interface ManagedRouting {
  routing: PersonaRouting
  /** Lines from the module's log seam. */
  logs: string[]
  /** Notifications each persona's registered session received, by persona key. */
  notifications: Map<string, ChannelNotification[]>
}

/** Build the managed routing described in the file comment. */
export function makeManagedRouting(h: ConnectionHarness, baseDir: string, opts: ManagedRoutingOptions = {}): ManagedRouting {
  const notifications = new Map<string, ChannelNotification[]>()
  for (const p of h.personas) {
    const captured: ChannelNotification[] = []
    registerSession(join(baseDir, 'live', p.key), p.key, makeTransport(`mcp-${p.key}`), makeSessionServer(captured))
    notifications.set(p.key, captured)
  }
  const logs: string[] = []
  const routing = createPersonaRouting({
    getPersonaConfig: () => h.config,
    getBotIdentity: (key) => h.identityFor(key),
    clientFor: h.clientFor,
    resolveUserName: async (key, userId) => {
      const client = h.clientFor(key)
      if (!client) return userId
      const res = await client.users.info({ user: userId })
      return res.user?.profile?.display_name || userId
    },
    archive: opts.archive ?? (() => {}),
    getAccess: () => ({}),
    log: (line) => void logs.push(line),
  })
  return { routing, logs, notifications }
}
