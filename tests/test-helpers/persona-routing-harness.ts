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
 *   `notifications/claude/channel` calls (or throws, with `throwOnNotify`, an
 *   error whose message carries the leak marker inside a token and a URL).
 *   An `onNotify` hook runs when `notification()` is called and is awaited
 *   before the call is recorded, so a test can put the send in an ordered log,
 *   hold it open or make it fail (a throwing hook: not recorded);
 * - the real restart and backoff state, with `initRestart` given
 *   `makeRestartDeps`: a session is never alive, launches are recorded in
 *   `h.launches`, and the restart delay is read from `h.restartDelayS` at call
 *   time. `launchSession` replaces the launch outcome (hold a launch open to
 *   keep the persona in flight);
 * - the real persona notifier as the injected `notify`, built by
 *   `makeNotifierStack` (tests/test-helpers/persona-notifier.ts) over the
 *   same `clientFor` and stubs and the applied config (`h.config`, read at
 *   call time), never in dry run, so a lost-message notice is a
 *   `chat.postMessage` on the persona's own stub at its destination (a
 *   channel, or for `permission_prompts: 'dm'` the DM `conversations.open`
 *   returns). Its destination hold (`h.hold`) runs on a fake clock
 *   (`h.holdClock`), never the real one. A persona whose client is
 *   unavailable has its notices held until `h.notifier.flush(key)`. Every
 *   notice the routing raises is also recorded, body only, in `h.notices`;
 *   the `notify` option replaces the notifier (for example with a throwing
 *   sink);
 * - the user-name lookup, as src/server.ts does it: `users.info` through the
 *   persona's client from `clientFor`, or the user ID when the persona has no
 *   client (`h.clients.setUnavailable`); the `resolveUserName` option
 *   replaces it;
 * - the up predicate (`isPersonaUp`), only when the caller passes one, so by
 *   default every persona counts as up;
 * - the server-wide reply settings source (`getReplySettings`, as src/server.ts
 *   passes its start-time settings): it returns the `ackReaction` option and
 *   the default chunking, so by default there is no ack reaction and a
 *   delivery makes no `reactions.add` call;
 * - `h.reply(name, args)`: persona `name`'s `reply` tool call through the real
 *   session server (`createSessionServer` over an in-memory MCP link) with the
 *   same `clientFor`, the real ack tracker and the same reply settings source
 *   as the routing, as src/server.ts shares one source between the inbound ack
 *   step and the `reply` tool. So an ack-tracker entry the routing recorded is
 *   observed as a `reactions.remove` on the persona's own stub;
 * - a line capture for the module's log seam, the notifier and the hold
 *   (`h.logs`), and an order capture (`h.order`) for ack, archive, config and
 *   identity reads.
 *
 * Every call builds a new routing, so every harness starts with empty
 * per-persona dedupe stores; `dedupeClock` injects their clock (default
 * `Date.now`).
 *
 * The harness calls `initRestart` and registers sessions; reset the registry,
 * restart, backoff and ack-tracker state between tests with
 * `resetRoutingState()`. A case that can hold a notice (a failing destination)
 * calls `h.hold.cancelAll()` in teardown; the hold's timers are on
 * `h.holdClock`, so nothing fires unless the test moves it.
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

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { replySettingsOf, type Persona, type PersonaConfig, type ReplySettings } from '../../src/config.ts'
import { createPersonaRouting, type PersonaRoutingDeps } from '../../src/persona-routing.ts'
import { formatPersonaNotice, type PersonaNotifier } from '../../src/persona-notifier.ts'
import type { PersonaDestinationHold } from '../../src/persona-destination-hold.ts'
import type { LostMessageState } from '../../src/lost-message.ts'
import { createSessionServer, registerSession, _resetRegistry, type SessionEntry, type SessionToolDeps } from '../../src/registry.ts'
import { initRestart, _resetRestartState, type RestartDeps } from '../../src/restart.ts'
import { _resetBackoffState } from '../../src/backoff.ts'
import { _resetAckTracker, consumeAck } from '../../src/ack-tracker.ts'
import {
  archiveSlackMessage,
  createNameResolver,
  type NameResolverWebClient,
  type SlackMessageEvent,
} from '../../src/message-archive.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './persona-config.ts'
import { makeStubSlack, type StubSlack, type StubSlackOptions } from './slack-stub.ts'
import { makePersonaClients, posts, type PersonaClients } from './permission-relay-harness.ts'
import { LEAK_SENTINEL, sentinelInMessage } from './credentials.ts'
import type { FakeClock } from './fake-clock.ts'
import { makeNotifierStack } from './persona-notifier.ts'

/** Default restart delay (seconds): the restart timer fires within a few ms. */
export const FAST_RESTART_DELAY_S = 0.005

/** A restart delay (seconds) that never fires during a test. */
export const NEVER_FIRE_RESTART_DELAY_S = 9999

// ---------------------------------------------------------------------------
// Lost-message recovery states
// ---------------------------------------------------------------------------

/**
 * The five recovery states a lost-message notice reports (b.av2 SR-7.3;
 * `not-up` from bug b.g57), in decision order.
 */
export const LOST_MESSAGE_STATES: readonly LostMessageState[] = [
  'not-up',
  'restarting',
  'starting-now',
  'auto-restart-disabled',
  'restart-limit-reached',
]

/**
 * The phrase that identifies each recovery state in a notice, so a state is
 * told apart by its text and not only by equality with the builder's output.
 */
export const LOST_STATE_PHRASES: Readonly<Record<LostMessageState, RegExp>> = {
  'not-up': /\bnot up\b/i,
  'restarting': /\brestarting\b/i,
  'starting-now': /\bstarting now\b/i,
  'auto-restart-disabled': /\bauto-restart disabled\b/i,
  'restart-limit-reached': /\brestart limit reached\b/i,
}

/** The one recovery state a notice text identifies, or `none` / `several`. */
export function stateOf(text: string | undefined): LostMessageState | 'none' | 'several' {
  const found = LOST_MESSAGE_STATES.filter((s) => LOST_STATE_PHRASES[s].test(text ?? ''))
  return found.length === 1 ? found[0]! : found.length === 0 ? 'none' : 'several'
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** One captured `notifications/claude/channel` call. */
export interface ChannelNotification {
  method: string
  params: { content: string; meta: Record<string, string> }
}

/**
 * Runs when a fake session's `notification()` is called, before the call is
 * recorded; awaited, so a pending hook holds the send open and a throwing one
 * fails it (the notification is then not recorded).
 */
export type NotifyHook = (msg: ChannelNotification) => void | Promise<void>

/**
 * A fake MCP server whose `notification()` records into `notifications`, or
 * throws when `throws`. `onNotify`, when given, runs first (see `NotifyHook`).
 * The thrown message carries `LEAK_SENTINEL` only inside a fake token and a
 * `wss://…?ticket=` URL (`sentinelInMessage`): log lines keep a message
 * after `redactSlackLogText`, which removes both shapes, so the sentinel
 * shows only if redaction is skipped.
 */
export function makeSessionServer(notifications: ChannelNotification[], throws = false, onNotify?: NotifyHook): Server {
  return {
    connect: async () => {},
    notification: async (msg: ChannelNotification) => {
      if (throws) throw new Error(`notification failed (${sentinelInMessage('notify')})`)
      if (onNotify) await onNotify(msg)
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
  /** Runs when the session's `notification()` is called, awaited before it is recorded (see `NotifyHook`). */
  onNotify?: NotifyHook
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
    canRestart: () => true,
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
  /** Per-name hook on the harness-registered session's `notification()` (see `NotifyHook`). */
  onNotify?: Readonly<Record<string, NotifyHook>>
  /** Per-name stub options, merged over the leak marker. */
  stubOptions?: Readonly<Record<string, StubSlackOptions>>
  /** The `ack_reaction` the reply settings source (`getReplySettings`) returns to the routing and `h.reply`; default none. */
  ackReaction?: string
  /** The archive DB the archive seam writes to; the seam is a no-op without one. */
  archiveDb?: Database
  /** Replaces the user-name lookup (default: `users.info` on P's client from `clientFor`, the user ID when it has none). */
  resolveUserName?: PersonaRoutingDeps['resolveUserName']
  /** Server-wide config overrides (e.g. `session_restart_delay`). */
  overrides?: Partial<Omit<PersonaConfig, 'personas'>>
  /** Initial `h.restartDelayS`. Default `FAST_RESTART_DELAY_S`. */
  restartDelayS?: number
  /** Replaces the restart deps' launch outcome, e.g. a promise held open. */
  launchSession?: RestartFakeOptions['launchSession']
  /** Clock for the per-persona dedupe stores (e.g. a fake clock's `now`); default the module's (`Date.now`). */
  dedupeClock?: PersonaRoutingDeps['dedupeClock']
  /** Replaces the routing's `notify` (default: the real notifier, `h.notifier.notify`); calls are still recorded in `h.notices`. */
  notify?: PersonaRoutingDeps['notify']
  /** The routing's up predicate (b.av2 SR-6.4, bug b.g57); absent, as by default, every persona counts as up. */
  isPersonaUp?: PersonaRoutingDeps['isPersonaUp']
}

/** One notice the routing raised: the persona key and the body, without the notifier's persona prefix. */
export interface RaisedNotice {
  key: string
  text: string
}

/** One captured `chat.postMessage`, tagged with the key of the persona whose stub made it. */
export interface HarnessPost {
  key: string
  channel: string
  text: string | undefined
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
  allPosts(): HarnessPost[]
  /** The `chat.postMessage` calls to conversation `channel` (a `C…` or `D…` ID), on any persona's stub. */
  postsTo(channel: string): HarnessPost[]
  /** The real persona notifier the routing's `notify` defaults to (`flush(key)` posts held notices). */
  notifier: PersonaNotifier
  /** The notifier's destination hold (holds and retries a notice whose destination fails), on `holdClock`. */
  hold: PersonaDestinationHold
  /** The fake clock the destination hold runs on. */
  holdClock: FakeClock
  /** Every notice the routing raised through `notify`, in order (body only). */
  notices: RaisedNotice[]
  /** The text the notifier posts for persona `name` and notice body `body` (its persona prefix, then the body). */
  noticeText(name: string, body: string): string
  /**
   * Persona `name`'s `reply` tool call with `args`, through the real session
   * server over the same clients, the real ack tracker and the same reply
   * settings as the routing (see the file comment). Resolves once the call has
   * returned; rejects when the tool reports an error.
   */
  reply(name: string, args: Record<string, unknown>): Promise<void>
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
      makeSessionServer(session.notifications, reg.throwOnNotify ?? false, reg.onNotify),
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
      onNotify: opts.onNotify?.[name],
    })
    handle.notifications = session.notifications
    handle.sessionCwd = session.cwd
  }

  const restartDeps = makeRestartDeps({ restartDelayS: () => h.restartDelayS, launchSession: opts.launchSession })

  // The notifier and its hold, as server.ts builds them: the applied persona
  // read at call time, the same client lookup as the routing, one log. (`h`
  // is read only when they are called.)
  const log = (line: string): void => { h.logs.push(line) }
  const getPersona = (key: string): Persona | undefined => h.config?.personas.find((p) => p.key === key)
  const webClientFor = (key: string) => clients.clientFor(key) as unknown as WebClient | undefined
  const { notifier, hold, clock: holdClock } = makeNotifierStack({ getPersona, clientFor: webClientFor, log })
  // The one reply settings source for the inbound ack step and `h.reply`, as server.ts.
  const getReplySettings = (): ReplySettings => ({ ...replySettingsOf(null), ack_reaction: opts.ackReaction })

  async function reply(name: string, args: Record<string, unknown>): Promise<void> {
    const { persona } = byName(name)
    const deps: SessionToolDeps = {
      assertSendable: () => {},
      getReplySettings,
      getPersona,
      clientFor: webClientFor,
      inboxDir: join(baseDir, 'inbox'),
      resolveUserName: async (_key, userId) => userId,
      consumeAck,
      serverPort: 0,
    }
    const entry: SessionEntry = {
      cwd: join(baseDir, 'reply', persona.key),
      personaKey: persona.key,
      transport: makeTransport(`mcp-reply-${persona.key}`),
      server: makeSessionServer([]),
      connected: true,
      peerPort: 0,
    }
    const server = createSessionServer(entry, deps)
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'routing-harness-reply', version: '1.0.0' }, { capabilities: {} })
    await client.connect(clientTransport)
    try {
      const result = (await client.callTool({ name: 'reply', arguments: args })) as { isError?: boolean }
      if (result.isError) throw new Error(`reply as ${name} reported an error`)
    } finally {
      await client.close()
    }
  }

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
    postsTo: (channel) => h.allPosts().filter((c) => c.channel === channel),
    notifier,
    hold,
    holdClock,
    notices: [],
    noticeText: (name, body) => formatPersonaNotice(byName(name).persona, body),
    reply,
    captured: () => ({
      logs: h.logs,
      calls: Object.fromEntries(handles.map((x) => [x.persona.name, x.stub.calls])),
      notifications: [...handles.map((x) => x.notifications), ...extraNotifications],
      posts: h.allPosts(),
      notices: h.notices,
    }),
  }

  const notify: PersonaRoutingDeps['notify'] = opts.notify ?? ((key, text, options) => notifier.notify(key, text, options))
  const resolver = (key: string) => createNameResolver(byKey(key)!.stub.web as unknown as NameResolverWebClient)
  // As server.ts: the lookup goes through the persona's client, and a persona
  // with no client (not validated yet, dry run) gets the user ID.
  const resolveUserName: PersonaRoutingDeps['resolveUserName'] = async (key, userId) => {
    const client = webClientFor(key)
    return client ? createNameResolver(client as unknown as NameResolverWebClient).resolveUserName(userId) : userId
  }
  const routing = createPersonaRouting({
    getPersonaConfig: () => {
      h.order.push('config')
      return h.config
    },
    getBotIdentity: (key) => {
      h.order.push(`identity:${key}`)
      return byKey(key)?.stub.identity
    },
    clientFor: webClientFor,
    resolveUserName: opts.resolveUserName ?? resolveUserName,
    archive: (key, event) => {
      h.order.push(`archive:${key}`)
      if (opts.archiveDb) h.archiveWrites.push(archiveSlackMessage(opts.archiveDb, event as SlackMessageEvent, resolver(key)))
    },
    getReplySettings,
    notify: (key, text, options) => {
      h.notices.push({ key, text })
      return notify(key, text, options)
    },
    log,
    dedupeClock: opts.dedupeClock,
    isPersonaUp: opts.isPersonaUp,
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
