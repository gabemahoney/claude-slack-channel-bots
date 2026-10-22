import { createDeliveryQueue } from '../../src/delivery-queue.ts'
import { createDeliveryPreparation } from '../../src/delivery-intake.ts'
/**
 * test-helpers/persona-routing-managed.ts — The real inbound routing module
 * over the real connection manager's seams, built as `src/server.ts` builds
 * it (with and step 2
 * with to).
 *
 * `makeManagedRouting(h, baseDir, opts?)` takes a connection harness
 * (`makeConnectionHarness`) and builds `createPersonaRouting` with the same
 * seams the server passes: `getBotIdentity` from the harness's identity getter
 * (`createPersonaIdentityLookup`), `clientFor` from its client lookup
 * (`createPersonaClientLookup`), the user-name lookup on the receiving
 * persona's own client (`users.info`, the ID when it has no client), the
 * archive seam the caller passes (default: none), the server-wide
 * `ack_reaction` from the harness's applied config (`h.config`, read at call
 * time; none unless the harness's `overrides` set one), and as `notify` the real
 * persona notifier, built by `makeNotifierStack`
 * (tests/test-helpers/persona-notifier.ts) over the harness's
 * applied-persona and client lookups, never in dry run, whose destination
 * hold runs on its own fake clock, never the real one or the connection
 * manager's. It registers one session per harness persona in the real
 * registry (a fake transport holding `_GET_stream` and a server that records
 * `notifications/claude/channel`).
 *
 * `tests/test-helpers/persona-routing-harness.ts` is the stub-client
 * counterpart; use this one when the routing must read the connection
 * manager's per-persona identities and clients. The caller owns the restart
 * deps (`initRestart`), `resetRoutingState()` and `h.manager.stopAll()`.
 *
 * Isolation: session paths are under the caller's `baseDir`;
 * no I/O of its own, no timers, no token literal.
 *
 * SPDX-License-Identifier: MIT
 */

import { join } from 'node:path'

import { createPersonaRouting, type PersonaRouting, type PersonaRoutingDeps } from '../../src/persona-routing.ts'
import { registerSession } from '../../src/registry.ts'
import type { ConnectionHarness } from './persona-connection-harness.ts'
import { makeNotifierStack } from './persona-notifier.ts'
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
  queue: ReturnType<typeof createDeliveryQueue>
  ready: Promise<void>
  queued(key: string): ReturnType<ReturnType<typeof createDeliveryQueue>['items']>
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
  const log = (line: string): void => void logs.push(line)
  // The notifier reads the same configuration as the routing, so a notice
  // goes to the destination of the channel mode in force.
  const { notifier } = makeNotifierStack({ getPersona: h.getPersona, clientFor: h.clientFor, getPersonaConfig: () => h.config, log })
  const queue = createDeliveryQueue({ stateDir: baseDir })
  const ready = queue.start()
  const preparation = createDeliveryPreparation({ queue, clientFor: h.clientFor, resolveUserName: async (key, userId) => {
    const client = h.clientFor(key)
    const result = await client?.users.info({ user: userId })
    return result?.user?.profile?.display_name || userId
  } })
  const core = createPersonaRouting({
    getPersonaConfig: () => h.config,
    getBotIdentity: key => h.identityFor(key),
    queue,
    prepare: preparation.prepare,
    archive: opts.archive ?? (() => {}),
    log,
  })
  const routing = { ...core, receive: async (...args: Parameters<typeof core.receive>) => { await ready; return core.receive(...args) } }
  return { routing, logs, queue, ready, queued: key => queue.items(key), notifications }
}
