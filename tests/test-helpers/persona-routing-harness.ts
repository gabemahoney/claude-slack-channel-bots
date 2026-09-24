/**
 * test-helpers/persona-routing-harness.ts — The real inbound routing module
 * over stub Slack clients, the real registry and the real restart state
 * (b.av2 SR-4.1, SR-4.2 as decided by src/delivery-decision.ts, SR-13.4).
 *
 * `makeRoutingHarness(specs, baseDir, opts?)` builds the real
 * `createPersonaRouting` from src/persona-routing.ts over:
 * - one `makeStubSlack` stub per persona (leak marker on), handed out through
 *   `makePersonaClients` as the injected `clientFor` (`h.clients.setUnavailable`
 *   takes a persona's client away, as before validation or in dry run);
 * - the real persona-keyed registry: each persona named in `sessions` (default
 *   all) gets a registered session with a fake transport (holding `_GET_stream`
 *   unless `streamless`) and a fake MCP server that records
 *   `notifications/claude/channel` calls (or throws, with `throwOnNotify`);
 * - the real restart and backoff state, with `initRestart` given
 *   `makeRestartDeps`: a session is never alive, launches are recorded in
 *   `h.launches`, and the restart delay is read from `h.restartDelayS` at call
 *   time. `launchSession` replaces the launch outcome (hold a launch open to
 *   keep the persona in flight);
 * - a line capture for the module's log seam (`h.logs`) and an order capture
 *   (`h.order`) for ack, archive, config and identity reads.
 *
 * The harness calls `initRestart` and registers sessions; reset the registry,
 * restart, backoff and ack-tracker state between tests with
 * `resetRoutingState()`.
 *
 * Isolation (b.av2 SR-13.2): every path is under the caller's `baseDir`; no
 * I/O of its own, no timers, no token literal.
 *
 * SPDX-License-Identifier: MIT
 */

import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import type { WebClient } from '@slack/web-api'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import type { Persona, PersonaConfig } from '../../src/config.ts'
import { createPersonaRouting, type PersonaRoutingDeps } from '../../src/persona-routing.ts'
import { registerSession, _resetRegistry } from '../../src/registry.ts'
import { initRestart, _resetRestartState, type RestartDeps } from '../../src/restart.ts'
import { _resetBackoffState } from '../../src/backoff.ts'
import { _resetAckTracker } from '../../src/ack-tracker.ts'
import {
  archiveSlackMessage,
  createNameResolver,
  type NameResolverWebClient,
  type SlackMessageEvent,
} from '../../src/message-archive.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './persona-config.ts'
import { makeStubSlack, type StubSlack, type StubSlackOptions } from './slack-stub.ts'
import { makePersonaClients, posts, type PersonaClients } from './permission-relay-harness.ts'
import { LEAK_SENTINEL } from './credentials.ts'

/** Default restart delay (seconds): the restart timer fires within a few ms. */
export const FAST_RESTART_DELAY_S = 0.005

/** A restart delay (seconds) that never fires during a test. */
export const NEVER_FIRE_RESTART_DELAY_S = 9999

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** One captured `notifications/claude/channel` call. */
export interface ChannelNotification {
  method: string
  params: { content: string; meta: Record<string, string> }
}

/** A fake MCP server whose `notification()` records into `notifications`, or throws when `throws`. */
export function makeSessionServer(notifications: ChannelNotification[], throws = false): Server {
  return {
    connect: async () => {},
    notification: async (msg: ChannelNotification) => {
      if (throws) throw new Error(`notification failed ${LEAK_SENTINEL}`)
      notifications.push(msg)
    },
  } as unknown as Server
}

/** A fake transport with MCP session ID `sessionId`; `_streamMapping` holds `_GET_stream` unless `streamless`. */
export function makeTransport(sessionId: string, streamless = false): WebStandardStreamableHTTPServerTransport {
  return {
    sessionId,
    _streamMapping: new Map<string, unknown>(streamless ? [] : [['_GET_stream', {}]]),
    handleRequest: async () => new Response(),
    close: async () => {},
  } as unknown as WebStandardStreamableHTTPServerTransport
}

/** One session the harness registered. */
export interface SessionHandle {
  /** Working directory the session reports. */
  cwd: string
  /** Its transport's MCP session ID. */
  mcpSessionId: string
  /** Notifications its server received. */
  notifications: ChannelNotification[]
}

export interface RegisterSessionOptions {
  /** Distinguishes this session's cwd and MCP session ID from the persona's first one. */
  tag?: string
  /** The session has lost its `_GET_stream` (b.9cj). */
  streamless?: boolean
  /** The session reads `connected: false`. */
  disconnected?: boolean
  /** The session's `notification()` throws. */
  throwOnNotify?: boolean
}

// ---------------------------------------------------------------------------
// Restart deps
// ---------------------------------------------------------------------------

/** One launch the restart module issued. `sessionId` is present only when it passed one. */
export interface LaunchCall {
  key: string
  cwd: string
  sessionId?: string
}

export interface RestartFakeOptions {
  /** Restart delay (seconds), or a getter read at call time. Default `FAST_RESTART_DELAY_S`. */
  restartDelayS?: number | (() => number)
  /** Replaces the launch outcome (default: resolves true). Called after the launch is recorded. */
  launchSession?: (key: string, cwd: string, sessionId?: string) => Promise<boolean>
}

/** Restart deps whose session is never alive and whose launches are recorded in `launches`. */
export function makeRestartDeps(opts: RestartFakeOptions = {}): RestartDeps & { launches: LaunchCall[] } {
  const launches: LaunchCall[] = []
  const delay = opts.restartDelayS ?? FAST_RESTART_DELAY_S
  return {
    launches,
    isSessionAlive: async () => false,
    isSessionConnected: () => false,
    hasSessionStream: () => false,
    reconnectSession: async () => 'success',
    killSession: async () => {},
    launchSession: async (key, cwd, sessionId) => {
      launches.push(sessionId === undefined ? { key, cwd } : { key, cwd, sessionId })
      return opts.launchSession ? opts.launchSession(key, cwd, sessionId) : true
    },
    getRestartDelay: () => (typeof delay === 'function' ? delay() : delay),
    isShuttingDown: () => false,
    onCapReached: () => {},
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** One persona as the harness built it. */
export interface PersonaHandle {
  persona: Persona
  stub: StubSlack
  /** Notifications its first registered session received (empty when it has none). */
  notifications: ChannelNotification[]
  /** Working directory its first registered session reports, when it has one. */
  sessionCwd?: string
}

export interface RoutingHarnessOptions {
  /** Names with a registered session; default every persona. */
  sessions?: readonly string[]
  /** Names whose registered session has lost its `_GET_stream` (b.9cj). */
  streamless?: readonly string[]
  /** Names whose registered session reads `connected: false`. */
  disconnected?: readonly string[]
  /** Names whose session's `notification()` throws. */
  throwOnNotify?: readonly string[]
  /** Per-name stub options, merged over the leak marker. */
  stubOptions?: Readonly<Record<string, StubSlackOptions>>
  /** The ack reaction the injected ack-reaction source returns. */
  ackReaction?: string
  /** The archive DB the archive seam writes to; the seam is a no-op without one. */
  archiveDb?: Database
  /** Replaces the user-name lookup (default: `users.info` on P's stub). */
  resolveUserName?: PersonaRoutingDeps['resolveUserName']
  /** Server-wide config overrides (e.g. `session_restart_delay`). */
  overrides?: Partial<Omit<PersonaConfig, 'personas'>>
  /** Initial `h.restartDelayS`. Default `FAST_RESTART_DELAY_S`. */
  restartDelayS?: number
  /** Replaces the restart deps' launch outcome, e.g. a promise held open. */
  launchSession?: RestartFakeOptions['launchSession']
}

export interface RoutingHarness {
  /** The applied config the routing reads at call time; set to null for none, or edit it. */
  config: PersonaConfig | null
  /** The persona handle by name. */
  p(name: string): PersonaHandle
  all: PersonaHandle[]
  clients: PersonaClients
  /** Lines from the module's log seam. */
  logs: string[]
  /** Ordered markers: `ack`, `archive:<key>`, `config`, `identity:<key>`. */
  order: string[]
  /** Launches the restart module issued. */
  launches: LaunchCall[]
  /** Restart delay (seconds) the restart deps report, read at call time. */
  restartDelayS: number
  /** Archive writes started through the seam. */
  archiveWrites: Promise<boolean>[]
  /** Feed one event to the named personas (default: all), with a recording ack unless `ack` is given. */
  receive(event: unknown, names?: readonly string[], ack?: () => Promise<void> | void): Promise<void>
  /** Feed one event to raw persona keys, with a recording ack. */
  receiveKeys(event: unknown, keys: readonly string[]): Promise<void>
  /** Keys of the named personas. */
  keys(names: readonly string[]): string[]
  /** Register a (further) session for the named persona in the real registry; a live one is replaced. */
  registerFor(name: string, opts?: RegisterSessionOptions): SessionHandle
  /** Every `chat.postMessage` on every stub, tagged with the stub's persona key, in persona order. */
  allPosts(): Array<{ key: string; channel: string; text: string | undefined }>
  /** Everything the harness captured, for `assertNoLeak`. */
  captured(): Record<string, unknown>
}

/**
 * Build the real routing module over `specs` (see the file comment). Every
 * persona path is under `baseDir`, the test's own temp directory.
 */
export function makeRoutingHarness(
  specs: PersonaSpec[],
  baseDir: string,
  opts: RoutingHarnessOptions = {},
): RoutingHarness {
  const config = makeMultiPersonaConfig(specs, baseDir, opts.overrides)
  const handles = config.personas.map((persona): PersonaHandle => ({
    persona,
    stub: makeStubSlack({ leakMarker: LEAK_SENTINEL, ...opts.stubOptions?.[persona.name] }),
    notifications: [],
  }))
  const byKey = (key: string) => handles.find((x) => x.persona.key === key)
  const byName = (name: string) => {
    const found = handles.find((x) => x.persona.name === name)
    if (!found) throw new Error(`no persona ${name}`)
    return found
  }
  const clients = makePersonaClients((key) => byKey(key)?.stub)
  const extraNotifications: ChannelNotification[][] = []

  function registerFor(name: string, reg: RegisterSessionOptions = {}): SessionHandle {
    const { persona } = byName(name)
    const suffix = reg.tag ? `-${reg.tag}` : ''
    const session: SessionHandle = {
      cwd: join(baseDir, 'live', `${persona.key}${suffix}`),
      mcpSessionId: `mcp-${persona.key}${suffix}`,
      notifications: [],
    }
    const entry = registerSession(
      session.cwd,
      persona.key,
      makeTransport(session.mcpSessionId, reg.streamless ?? false),
      makeSessionServer(session.notifications, reg.throwOnNotify ?? false),
    )
    if (reg.disconnected) entry.connected = false
    return session
  }

  const withSession = new Set(opts.sessions ?? config.personas.map((p) => p.name))
  for (const handle of handles) {
    const { name } = handle.persona
    if (!withSession.has(name)) continue
    const session = registerFor(name, {
      streamless: opts.streamless?.includes(name),
      disconnected: opts.disconnected?.includes(name),
      throwOnNotify: opts.throwOnNotify?.includes(name),
    })
    handle.notifications = session.notifications
    handle.sessionCwd = session.cwd
  }

  const restartDeps = makeRestartDeps({ restartDelayS: () => h.restartDelayS, launchSession: opts.launchSession })

  const h: RoutingHarness = {
    config,
    p: byName,
    all: handles,
    clients,
    logs: [],
    order: [],
    launches: restartDeps.launches,
    restartDelayS: opts.restartDelayS ?? FAST_RESTART_DELAY_S,
    archiveWrites: [],
    receive: (event, names, ack) => routing.receive(
      event,
      ack ?? (() => { h.order.push('ack') }),
      h.keys(names ?? handles.map((x) => x.persona.name)),
    ),
    receiveKeys: (event, keys) => routing.receive(event, () => { h.order.push('ack') }, keys),
    keys: (names) => names.map((n) => byName(n).persona.key),
    registerFor: (name, reg) => {
      const session = registerFor(name, reg)
      extraNotifications.push(session.notifications)
      return session
    },
    allPosts: () => handles.flatMap((x) =>
      posts(x.stub).map((c) => ({ key: x.persona.key, channel: c.channel, text: c.text })),
    ),
    captured: () => ({
      logs: h.logs,
      calls: Object.fromEntries(handles.map((x) => [x.persona.name, x.stub.calls])),
      notifications: [...handles.map((x) => x.notifications), ...extraNotifications],
      posts: h.allPosts(),
    }),
  }

  const resolver = (key: string) => createNameResolver(byKey(key)!.stub.web as unknown as NameResolverWebClient)
  const routing = createPersonaRouting({
    getPersonaConfig: () => {
      h.order.push('config')
      return h.config
    },
    getBotIdentity: (key) => {
      h.order.push(`identity:${key}`)
      return byKey(key)?.stub.identity
    },
    clientFor: (key) => clients.clientFor(key) as unknown as WebClient | undefined,
    resolveUserName: opts.resolveUserName ?? ((key, userId) => resolver(key).resolveUserName(userId)),
    archive: (key, event) => {
      h.order.push(`archive:${key}`)
      if (opts.archiveDb) h.archiveWrites.push(archiveSlackMessage(opts.archiveDb, event as SlackMessageEvent, resolver(key)))
    },
    getAccess: () => ({ ackReaction: opts.ackReaction }),
    log: (line) => { h.logs.push(line) },
  })

  initRestart(restartDeps)
  return h
}

/** Reset the registry, restart (timers cancelled), backoff and ack-tracker state the harness drives. */
export function resetRoutingState(): void {
  _resetRestartState()
  _resetRegistry()
  _resetBackoffState()
  _resetAckTracker()
}

/** Poll `cond` every 5 ms for at most `ms` (the fast restart timer fires within this). */
export async function waitFor(cond: () => boolean, ms = 100): Promise<void> {
  for (let waited = 0; !cond() && waited < ms; waited += 5) await new Promise((r) => setTimeout(r, 5))
}
