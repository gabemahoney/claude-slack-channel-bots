/**
 * persona-connections.ts — The supervised per-persona Slack connection
 * manager (b.av2 SR-3.1 module part, SR-3.2, SR-3.3, SR-3.4, SR-10.3,
 * SR-13.1).
 *
 * `createPersonaConnectionManager(deps)` returns a handle that brings each
 * persona up, keeps its connection open and answers queries about it. Per
 * persona that is up it holds exactly one long-lived Socket Mode client and
 * one long-lived Web API client (two of each only while a credentials
 * reconnect overlaps); a short-lived validation client exists only during
 * `auth.test`. All clients are built through the injected
 * `PersonaSlackClientFactory` with the SR-3.3 option sets
 * (`persona-slack-clients.ts`).
 *
 * One attempt:
 *   1. bring-up only: build a validation client, `auth.test` (bot token),
 *      take the bot user ID and bot ID from the result, drop the client;
 *   2. bring-up only: build the long-lived Web API client (once per persona);
 *   3. build a fresh Socket Mode client, subscribe its handlers once, and
 *      `start()` it (app token).
 * Any failure is classified by `classifySlackValidationError` with the check
 * that failed. The persona is up only once `auth.test` returned both IDs and
 * `start()` resolved.
 *
 * The 10 s bound on `auth.test`: a timer on the injected clock starts with
 * the call; on expiry the call is abandoned and the attempt is
 * Slack-unreachable (`SlackAuthTestTimeoutError`, reason `timeout`), never
 * refused. The validation client's own request timeout starts only once the
 * connection is made, so it does not bound a DNS or TCP-connect stall.
 *
 * The 10 s bound (SR-3.3): a timer on the injected clock starts when `start()`
 * is called and restarts when the library signals the WebSocket phase has
 * begun (`authenticated`, `connecting`), so a slow `apps.connections.open`
 * does not eat into the WebSocket phase's 10 s. On expiry the client is
 * disconnected as the manager's own close and the attempt is Slack-unreachable
 * (`SlackStartTimeoutError`), never refused. Every attempt settles exactly
 * once (`settled` flag). A `start()` that resolves after its attempt was
 * abandoned or cancelled is disconnected again and never counts as the
 * persona's connection (`@slack/socket-mode` still opens the WebSocket when
 * `apps.connections.open` answers after `disconnect()`); a late rejection is
 * caught.
 *
 * Supervision (SR-3.2, SR-3.3):
 * - Bring-up runs the first attempt at once and resolves with its outcome
 *   (up, retrying or broken) without waiting for retries.
 * - Slack-unreachable: retried on the persona's own timer with its own
 *   `createPersonaRetrySchedule` (5 s doubling to 300 s, no cap, `retryAfter`
 *   honoured) until up or refused.
 * - A `disconnected` event on the live socket of a persona that is up, not
 *   closed by the manager and with no attempt in flight: the persona is lost
 *   and a reopen attempt starts at once; later ones back off. A reopen opens
 *   the Socket Mode connection only: no `auth.test`, same long-lived Web API
 *   client, same identity. `disconnected` from a failed `start()`, from the
 *   manager's own disconnect or before the persona was ever up never
 *   schedules anything; the failed attempt's own outcome drives the one next
 *   retry.
 * - Refused (bring-up or reopen): no more attempts, no timer; the persona
 *   stays disconnected and is reported broken.
 * - Log lines go through each persona's `createSlackEpisodeTracker`, so they
 *   are written when a cause starts and when it clears, never per attempt.
 *
 * Credentials reconnect (b.av2 SR-8.6 credentials row; `reconnectCredentials`):
 * a confirmed change of an up persona's credentials content opens a second
 * connection with the new tokens through the same attempt code (validation
 * client and `auth.test`, a new long-lived Web API client, a new socket under
 * the 10 s bound). Only once it reached `hello` does the persona switch to
 * the new tokens, identity, client and socket together; the old socket is
 * then closed as the manager's own close and any reopen of it cancelled.
 * SR-3.1 allows the two sockets and two Web API clients only during this
 * overlap. A refusal discards the new clients and leaves the old connection
 * untouched; Slack-unreachable keeps the old connection while the new one
 * retries on its own SR-3.2 schedule and its own episode latch, and a later
 * swap or refusal is reported to the reconnect's listener. The reconnect's
 * `beforeSwap` hook runs right before every swap (first attempt or later),
 * before any status listener sees the persona up on the new connection. A
 * new reconnect, `stop` and `stopAll` cancel a pending one; the reconnect's
 * Slack-unreachable episode then ends with a cleared line saying so (and
 * with the usual cleared line when Slack answers, by a swap or a refusal),
 * so its start line always gets an end. A persona whose bring-up is
 * Slack-unreachable and retrying takes a new token pair instead
 * (`replaceRetryTokens`): every later attempt uses it.
 *
 * Revoked bot token while running (bug b.ujn): every long-lived Web API
 * client the manager hands out is wrapped by `watchWebClientAuth`
 * (`persona-web-api-watch.ts`). The first call refused with `invalid_auth`,
 * `token_revoked`, `account_inactive` or `not_authed` on a client latches
 * that client (every later Web API call through it is refused locally, never
 * sent) and, when it is still the persona's current client (`entry.web`, the
 * client's identity is its generation) of a persona neither stopped nor
 * already broken, marks the persona at once, in the rejection's handler:
 * its attempt in flight and retry timer are cancelled, its live socket is
 * detached (it forwards nothing more and its `disconnected` is not seen), one
 * `persona-credentials-refused` line is logged (`bot_token refused by a Web
 * API call (<method>): Slack error <code>`) and it is reported `broken`
 * (phase `running`), which the status listeners (the bring-up controller's
 * outcome, `onLeftUp`) see before the next event or call. Nothing of that
 * waits for the per-persona serializer, so a lifecycle operation holding the
 * persona's turn (a launch) cannot delay it. Only the detached socket's
 * network close, the manager's own close (no reopen, no lost line), is
 * submitted through the injected serializer, never awaited (the refusal may
 * come from inside an operation holding the persona's turn); `stop` closes it
 * at once if its turn has not come. A refusal from a replaced client (after a
 * credentials reconnect's swap, a `replaceRetryTokens` or a fresh bring-up),
 * from a stopped persona or from one already broken marks nothing. A
 * persona's events are forwarded only while it is not `broken`, so a pending
 * reconnect's socket forwards nothing for a persona marked meanwhile until
 * its swap.
 *
 * Events: `message`, `app_mention` and `interactive` from a persona's socket
 * reach `onEvent(key, eventName, payload)` with the library's listener
 * argument unchanged (`{ event, body, ack, … }`). The handler is awaited in
 * try/catch; a throw is logged with `describeThrownValue` and affects no other
 * event or persona. The manager never acks.
 *
 * Isolation: every piece of state lives in one entry per persona. No lock,
 * queue, promise chain or timer is shared between personas; at most one
 * attempt of the persona's own connection is in flight and at most one live
 * Socket Mode client exists per persona, plus, during a credentials
 * reconnect, the reconnect's one attempt and socket.
 *
 * Dry run (SR-3.4): bring-up calls no factory method, needs no credentials
 * value and reports up at once with a placeholder identity derived from the
 * key (`dryRunPersonaIdentity`); there is no Web API client.
 *
 * Secrets: the persona's `PersonaSlackTokens` is held in memory for later
 * attempts (replaced only by a reconnect's swap or `replaceRetryTokens`) and
 * read only to hand a token to the factory; it is never logged, serialised
 * or re-read. Log lines carry only sanitized outcome fields or
 * `describeThrownValue` output.
 *
 * Pure module (b.av2 SR-13.1): nothing is created, read or scheduled at
 * import or at `createPersonaConnectionManager`; no environment access
 * (dry run is passed in). It imports nothing from the agent-director modules.
 * `server.ts` constructs one manager in `main()` and brings each persona up
 * through the bring-up controller (`persona-bringup-controller.ts`).
 *
 * SPDX-License-Identifier: MIT
 */

import type { WebClient } from '@slack/web-api'

import type { Persona } from './config.ts'
import { describeThrownValue } from './persona-connection-errors.ts'
import type { PersonaSlackTokens } from './persona-credentials.ts'
import type { PersonaDiagnosticLogger } from './persona-diagnostics.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { createPersonaRetrySchedule, type PersonaRetrySchedule } from './persona-retry-schedule.ts'
import type { PersonaSerialize } from './persona-serializer.ts'
import {
  PERSONA_START_TIMEOUT_MS,
  PRODUCTION_SLACK_CLIENT_FACTORY,
  longLivedWebClientOptions,
  socketModeClientOptions,
  validationWebClientOptions,
  type PersonaSlackClientFactory,
  type PersonaSocketClient,
  type PersonaSocketListener,
} from './persona-slack-clients.ts'
import { createSlackEpisodeTracker, type SlackEpisodeTracker } from './persona-slack-episodes.ts'
import {
  SLACK_AUTH_TEST_TIMEOUT_MS,
  SlackAuthTestTimeoutError,
  SlackStartTimeoutError,
  botIdentityFromAuthTest,
  classifySlackValidationError,
  type SlackBotIdentity,
  type SlackCredentialsRefusedOutcome,
  type SlackUnreachableOutcome,
  type SlackUpOutcome,
  type SlackValidationFailure,
} from './persona-slack-validation.ts'
import { watchWebClientAuth } from './persona-web-api-watch.ts'

// ---------------------------------------------------------------------------
// Clock seam
// ---------------------------------------------------------------------------

/**
 * The injectable clock and timers. `setTimeout` returns an opaque handle that
 * is only ever passed back to `clearTimeout`. Tests supply a fake one.
 */
export interface PersonaConnectionClock {
  /** Current time in epoch milliseconds. */
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

/** The real clock. */
export const SYSTEM_PERSONA_CONNECTION_CLOCK: PersonaConnectionClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The Socket Mode events forwarded to the handler, tagged with the persona. */
export const PERSONA_FORWARDED_SOCKET_EVENTS = ['message', 'app_mention', 'interactive'] as const

/** A forwarded Socket Mode event name. */
export type PersonaSocketEventName = (typeof PERSONA_FORWARDED_SOCKET_EVENTS)[number]

/**
 * A Socket Mode listener argument, forwarded unchanged: `event` (Events API
 * events only), `body`, `ack` and the library's other envelope fields.
 */
export interface PersonaSocketEventPayload {
  event?: Record<string, unknown>
  body?: Record<string, unknown>
  ack: (response?: Record<string, unknown>) => Promise<void>
  [field: string]: unknown
}

/** Receives every forwarded event with the key of the persona whose socket received it. */
export type PersonaEventHandler = (
  key: string,
  eventName: PersonaSocketEventName,
  payload: PersonaSocketEventPayload,
) => void | Promise<void>

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Which kind of attempt produced a status: first bring-up (with `auth.test`) or a Socket Mode reopen. */
export type PersonaAttemptPhase = 'bring-up' | 'reopen'

/**
 * Where a refusal that made a persona broken was found: an attempt
 * (`PersonaAttemptPhase`), or `running`: a Web API call of the running
 * persona was refused for its bot token (bug b.ujn), with no attempt.
 */
export type PersonaBrokenPhase = PersonaAttemptPhase | 'running'

/** A persona's connection status. */
export type PersonaConnectionStatus =
  /** The first bring-up attempt is in flight. */
  | { state: 'connecting' }
  /** `auth.test` returned both IDs and the Socket Mode connection is open. */
  | { state: 'up'; identity: SlackBotIdentity }
  /** A connection that was up dropped; the immediate reopen attempt is in flight. */
  | { state: 'lost' }
  /** Slack was unreachable; the next attempt runs after `retryInMs` (at `nextAttemptAt`, epoch ms). */
  | {
    state: 'retrying'
    phase: PersonaAttemptPhase
    outcome: SlackUnreachableOutcome
    retryInMs: number
    nextAttemptAt: number
  }
  /** Slack refused a token: credentials-broken, disconnected, not retried. */
  | { state: 'broken'; phase: PersonaBrokenPhase; outcome: SlackCredentialsRefusedOutcome }
  /** Stopped by the caller; the persona's clients were dropped. */
  | { state: 'stopped' }

/** Receives every status change, with the persona's key. */
export type PersonaStatusListener = (key: string, status: PersonaConnectionStatus) => void

/** How the first attempt of a credentials reconnect ended (b.av2 SR-8.6 credentials row). */
export type PersonaReconnectOutcome =
  /**
   * The new connection reached `hello`: the persona now uses the new tokens,
   * Web API client, identity (from the new `auth.test`) and socket, and its
   * old socket was closed as the manager's own close.
   */
  | { kind: 'swapped'; identity: SlackBotIdentity }
  /** Slack refused a new token: the new clients were discarded and the old connection is untouched. */
  | { kind: 'refused'; outcome: SlackCredentialsRefusedOutcome }
  /**
   * Slack could not be reached with the new tokens (a `start()` abandoned at
   * its 10 s bound included): the old connection stays, and the new one is
   * retried after `retryInMs` on its own SR-3.2 schedule.
   */
  | { kind: 'retrying'; outcome: SlackUnreachableOutcome; retryInMs: number }
  /**
   * Nothing was attempted, or the attempt was cancelled: dry run, an unknown
   * or stopped persona, or a later reconnect, a stop or shutdown superseded it.
   */
  | { kind: 'cancelled' }

/** How a reconnect left retrying ended later: swapped, or refused (its retries then end). */
export type PersonaReconnectLaterOutcome = Extract<PersonaReconnectOutcome, { kind: 'swapped' | 'refused' }>

/** Told how a reconnect left retrying ended; the per-persona outcome listener of one reconnect. */
export type PersonaReconnectListener = (outcome: PersonaReconnectLaterOutcome) => unknown

/**
 * Told, synchronously, right before one reconnect's swap: the persona still
 * reports its old status, identity and Web API client, and nothing has been
 * switched yet. It runs before the status listeners see the persona `up` on
 * the new connection (for example the notifier's up-flush), so whatever
 * depends on the old app (the cached DM conversation) can be forgotten
 * first. At the first attempt's swap and at a later one alike. A throw is
 * logged and the swap still happens.
 */
export type PersonaReconnectBeforeSwap = () => unknown

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/** What the manager needs to know about a persona: its key, and its name, index and credentials path for log lines. */
export type ConnectionPersona = Pick<Persona, 'index' | 'name' | 'key' | 'credentials_file'>

/** Constructor dependencies. */
export interface PersonaConnectionManagerDeps {
  /** Receives every forwarded event, tagged with its persona's key. */
  onEvent: PersonaEventHandler
  /**
   * Receives every log line: diagnostic lines, handler failures, and the
   * connection-health lines each persona's Socket Mode library logger
   * forwards (`socketModeSlackLogger`).
   */
  log: PersonaDiagnosticLogger
  /** Dry run (SR-3.4): no credentials, no Slack call, every persona up with a placeholder identity. */
  dryRun: boolean
  /** Receives every status change. */
  onStatus?: PersonaStatusListener
  /** Slack client factory; defaults to `PRODUCTION_SLACK_CLIENT_FACTORY`. */
  factory?: PersonaSlackClientFactory
  /** Clock and timers; default `SYSTEM_PERSONA_CONNECTION_CLOCK`. */
  clock?: PersonaConnectionClock
  /**
   * The per-persona lifecycle serializer's `run` (b.av2 SR-6.6,
   * `persona-serializer.ts`): after a running persona is marked
   * credentials-broken by a refused Web API call (bug b.ujn), the network
   * close of its detached socket is submitted through it, never awaited (the
   * call may come from inside an operation already holding the persona's
   * turn). The mark itself never waits for it. Without it the close runs at
   * once. Production passes the server's one shared serializer.
   */
  serialize?: PersonaSerialize
}

/** The connection manager handle. */
export interface PersonaConnectionManager {
  /**
   * Bring a persona up: run its first attempt at once and resolve with that
   * attempt's status (`up`, `retrying` or `broken`; `stopped` if stopped
   * meanwhile). Retries continue in the background. `tokens` is required
   * outside dry run and ignored in it. A persona already managed is left as
   * it is and its current status returned.
   */
  bringUp(persona: ConnectionPersona, tokens?: PersonaSlackTokens): Promise<PersonaConnectionStatus>
  /** The persona's current status, or `undefined` if it is not managed. */
  status(key: string): PersonaConnectionStatus | undefined
  /** The persona's bot identity once it has been up (kept while it reopens or after a refused reopen). */
  identity(key: string): SlackBotIdentity | undefined
  /** The persona's long-lived Web API client once it has been up; always `undefined` in dry run. */
  webClient(key: string): WebClient | undefined
  /**
   * Reconnect a managed persona with a new, locally valid token pair (b.av2
   * SR-8.6 credentials row, SR-3.1, SR-3.3): a new validation client
   * (`auth.test`), a new long-lived Web API client and a new Socket Mode
   * client, through the factory with the SR-3.3 option sets, the socket
   * `start()` under the 10 s bound. Only once the new socket reached `hello`
   * are the persona's tokens, identity, Web API client and socket switched to
   * the new ones together, any reopen of the old connection cancelled and the
   * old socket closed as the manager's own close (no reopen, no lost line).
   * There is no same-app check. Until then the old connection keeps its
   * normal supervision and both sockets forward events (the routing's dedupe
   * delivers a message once).
   *
   * Resolves with the first attempt's outcome. `refused` discards the new
   * clients. `retrying` keeps retrying the new tokens on their own SR-3.2
   * schedule (its Slack-unreachable episode logged through its own tracker);
   * a later swap or refusal is reported to `onLaterOutcome`, and a refusal
   * ends the retries. A new reconnect, `stop` and `stopAll` cancel a pending
   * one (timer and attempt; its clients discarded), and end its
   * Slack-unreachable episode with a cleared line. `beforeSwap` is called
   * right before the swap, whether at the first attempt or later, before any
   * status listener sees the persona up on the new connection. Dry run, or an
   * unknown or stopped persona: `cancelled`, with no Slack call. No
   * agent-director call, no instance action. Never rejects.
   */
  reconnectCredentials(
    key: string,
    tokens: PersonaSlackTokens,
    onLaterOutcome?: PersonaReconnectListener,
    beforeSwap?: PersonaReconnectBeforeSwap,
  ): Promise<PersonaReconnectOutcome>
  /**
   * Hand a persona whose bring-up is Slack-unreachable and retrying (or whose
   * first attempt is in flight) a new, locally valid token pair (b.av2
   * SR-8.6: a retrying persona retries with the new content). Every later
   * attempt uses only the new pair: an attempt in flight with the old one is
   * cancelled and a new one starts at once; a pending retry timer is kept.
   * Two attempts never run at once, and the SR-3.2 schedule and episode
   * logging carry on. Returns whether the pair was taken: false in dry run,
   * for an unknown or stopped persona, and for a persona in any other state
   * (one that has been up is reconnected instead).
   */
  replaceRetryTokens(key: string, tokens: PersonaSlackTokens): boolean
  /**
   * Stop a persona: cancel its timers and any attempt in flight (its result
   * is discarded), disconnect its socket as the manager's own close, drop its
   * clients and forget it. Idempotent. Resolves once the disconnects settle.
   * With `endReason`, the persona's own open episode (Slack-unreachable,
   * credentials refused or a lost connection) first ends with one line
   * carrying its class label and the cause `cleared: <endReason>`, for a
   * caller that brings the persona up again later on a fresh connection, so
   * its start line gets an end. Without it (a teardown, shutdown) nothing is
   * logged for that episode.
   */
  stop(key: string, endReason?: string): Promise<void>
  /** Stop every persona. */
  stopAll(): Promise<void>
}

/**
 * The dry-run placeholder identity (SR-3.4): derived from the key alone, and
 * distinct for distinct keys (the key is embedded verbatim).
 */
export function dryRunPersonaIdentity(key: string): SlackBotIdentity {
  return { botUserId: `U000DRY_${key}`, botId: `B000DRY_${key}` }
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** A timer handle, boxed so any value the clock returns (even `undefined`) is a handle. */
interface TimerBox {
  handle: unknown
}

/** Why a pending reconnect's Slack-unreachable episode ended: a later reconnect replaced it. */
const RECONNECT_SUPERSEDED =
  'the new connection of its confirmed credentials change is no longer retried: a later confirmed credentials change replaced it'

/** Why a pending reconnect's Slack-unreachable episode ended: the persona's connection was stopped. */
const RECONNECT_STOPPED =
  'the new connection of its confirmed credentials change is no longer retried: the persona\'s connection was stopped'

/** One Socket Mode client and the listeners the manager subscribed on it. */
interface SocketBinding {
  readonly client: PersonaSocketClient
  /** Set when the manager abandons, closes or detaches the client; it then forwards nothing. */
  retired: boolean
  /** Set by any `disconnected` the client emits, so a `start()` resolving after one never counts as up. */
  disconnected: boolean
  readonly listeners: Array<[string, PersonaSocketListener]>
}

/** An attempt's kind: a bring-up or reopen of the persona's own connection, or a credentials reconnect's new one. */
type AttemptPhase = PersonaAttemptPhase | 'reconnect'

/**
 * How an attempt ended. `up` carries the socket it opened and, for a
 * reconnect, the new long-lived Web API client (a bring-up keeps its client
 * on the entry).
 */
type AttemptResult =
  | { kind: 'up'; identity: SlackBotIdentity; binding: SocketBinding; web: WebClient | undefined }
  | { kind: 'failed'; outcome: SlackValidationFailure }
  | { kind: 'cancelled' }

/** Where an in-flight attempt is kept: the persona's entry, or its pending reconnect. */
interface AttemptSlot {
  attempt: Attempt | undefined
}

/** One in-flight attempt. */
interface Attempt {
  settled: boolean
  /** The attempt's 10 s bound while armed: on `auth.test`, then on `start()`. */
  startTimer: TimerBox | undefined
  /** The socket client this attempt is opening, once built. */
  binding: SocketBinding | undefined
  /** Settle the attempt; every call after the first is ignored. */
  finish(result: AttemptResult): void
}

/** A credentials reconnect whose new connection is not in use yet. Nothing here is shared with another persona. */
interface PendingReconnect extends AttemptSlot {
  /** The new token pair. Never logged. */
  readonly tokens: PersonaSlackTokens
  /** Its own SR-3.2 schedule. */
  readonly schedule: PersonaRetrySchedule
  /** Its own episode latch, for its Slack-unreachable start and cleared lines. */
  readonly tracker: SlackEpisodeTracker
  readonly onLater: PersonaReconnectListener | undefined
  readonly beforeSwap: PersonaReconnectBeforeSwap | undefined
  timer: TimerBox | undefined
  cancelled: boolean
}

/** Everything the manager holds for one persona. Nothing here is shared with another persona. */
interface PersonaEntry extends AttemptSlot {
  readonly persona: ConnectionPersona
  /**
   * Held for later attempts; `undefined` in dry run. Replaced only by a
   * credentials reconnect's swap or `replaceRetryTokens`.
   */
  tokens: PersonaSlackTokens | undefined
  readonly schedule: PersonaRetrySchedule
  readonly tracker: SlackEpisodeTracker
  status: PersonaConnectionStatus
  identity: SlackBotIdentity | undefined
  /** The long-lived Web API client, wrapped by the auth-failure watch (`watchWebClientAuth`). */
  web: WebClient | undefined
  /** The live Socket Mode connection, while up. */
  socket: SocketBinding | undefined
  retryTimer: TimerBox | undefined
  /** A credentials reconnect whose new connection is not in use yet. */
  reconnect: PendingReconnect | undefined
  /**
   * The socket detached when a refused Web API call marked the persona
   * broken (bug b.ujn), until its network close, submitted through the
   * serializer, runs; `stop` closes it at once.
   */
  refusedSocket: SocketBinding | undefined
  stopped: boolean
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create the connection manager. Creates, reads and schedules nothing until `bringUp`. */
export function createPersonaConnectionManager(deps: PersonaConnectionManagerDeps): PersonaConnectionManager {
  const { onEvent, dryRun } = deps
  const factory = deps.factory ?? PRODUCTION_SLACK_CLIENT_FACTORY
  const clock = deps.clock ?? SYSTEM_PERSONA_CONNECTION_CLOCK
  const serialize: PersonaSerialize = deps.serialize ?? (async (_key, operation) => operation())
  const entries = new Map<string, PersonaEntry>()

  // -------------------------------------------------------------------------
  // Logging and callbacks (a throwing logger or listener never breaks supervision)
  // -------------------------------------------------------------------------

  function log(line: string): void {
    try {
      deps.log(line)
    } catch {
      /* a failing logger must not stop a persona's supervision */
    }
  }

  function logFailure(what: string, entry: PersonaEntry, err: unknown): void {
    const { index, name, key } = entry.persona
    log(`[slack] persona ${what} failed: personas[${index}] ${renderPersonaRef(name, key)}: ${describeThrownValue(err)}`)
  }

  function setStatus(entry: PersonaEntry, status: PersonaConnectionStatus): void {
    entry.status = status
    const listener = deps.onStatus
    if (listener === undefined) return
    try {
      const result: unknown = listener(entry.persona.key, status)
      if (isThenable(result)) result.then(undefined, err => logFailure('status listener', entry, err))
    } catch (err) {
      logFailure('status listener', entry, err)
    }
  }

  // -------------------------------------------------------------------------
  // Socket bindings
  // -------------------------------------------------------------------------

  function listen(binding: SocketBinding, event: string, listener: PersonaSocketListener): void {
    binding.client.on(event, listener)
    binding.listeners.push([event, listener])
  }

  /** Subscribe the forwarding and `disconnected` handlers on a new client, once. */
  function bindSocket(entry: PersonaEntry, client: PersonaSocketClient): SocketBinding {
    const binding: SocketBinding = { client, retired: false, disconnected: false, listeners: [] }
    for (const eventName of PERSONA_FORWARDED_SOCKET_EVENTS) {
      listen(binding, eventName, (payload: PersonaSocketEventPayload) => forward(entry, binding, eventName, payload))
    }
    listen(binding, 'disconnected', () => onDisconnected(entry, binding))
    return binding
  }

  /**
   * Detach a client: it forwards nothing more and its `disconnected` is no
   * longer seen. With `disconnect`, also close it as the manager's own close.
   * Resolves once the disconnect settles; never rejects.
   */
  function retire(binding: SocketBinding, disconnect: boolean): Promise<void> {
    if (!binding.retired) {
      binding.retired = true
      for (const [event, listener] of binding.listeners) {
        try {
          binding.client.removeListener(event, listener)
        } catch {
          /* removal of our own listener; nothing to recover */
        }
      }
      binding.listeners.length = 0
    }
    return disconnect ? disconnectQuietly(binding.client) : Promise.resolve()
  }

  async function disconnectQuietly(client: PersonaSocketClient): Promise<void> {
    try {
      await client.disconnect()
    } catch {
      /* already closed or closing: nothing to do */
    }
  }

  async function forward(
    entry: PersonaEntry,
    binding: SocketBinding,
    eventName: PersonaSocketEventName,
    payload: PersonaSocketEventPayload,
  ): Promise<void> {
    // A persona marked broken (a refused Web API call, bug b.ujn) gets no
    // delivery, even from a pending reconnect's socket, until a swap.
    if (binding.retired || entry.stopped || entry.status.state === 'broken') return
    try {
      await onEvent(entry.persona.key, eventName, payload)
    } catch (err) {
      logFailure(`${eventName} event handler`, entry, err)
    }
  }

  /** A `disconnected` on one of the persona's clients. Only a drop of the live, up connection reopens. */
  function onDisconnected(entry: PersonaEntry, binding: SocketBinding): void {
    binding.disconnected = true
    if (binding.retired || entry.stopped || entry.socket !== binding || entry.attempt !== undefined) return
    void retire(binding, false)
    entry.socket = undefined
    entry.tracker.record({ kind: 'connection-lost' })
    setStatus(entry, { state: 'lost' })
    startAttempt(entry, 'reopen')
  }

  // -------------------------------------------------------------------------
  // One attempt
  // -------------------------------------------------------------------------

  /**
   * Run one attempt for a persona with `tokens`, kept in `slot` while in
   * flight (the entry's own, or a pending reconnect's); resolves exactly once
   * with its result.
   */
  function runAttempt(
    entry: PersonaEntry,
    phase: AttemptPhase,
    slot: AttemptSlot,
    tokens: PersonaSlackTokens | undefined,
  ): Promise<AttemptResult> {
    return new Promise<AttemptResult>(resolve => {
      const attempt: Attempt = {
        settled: false,
        startTimer: undefined,
        binding: undefined,
        finish(result) {
          if (attempt.settled) return
          attempt.settled = true
          clearStartTimer(attempt)
          if (slot.attempt === attempt) slot.attempt = undefined
          resolve(result)
        },
      }
      slot.attempt = attempt
      performAttempt(entry, attempt, phase, tokens).catch(err => {
        // performAttempt catches every Slack failure itself; this is a backstop.
        attempt.finish({ kind: 'failed', outcome: classifySlackValidationError(err, 'socket-mode') })
      })
    })
  }

  async function performAttempt(
    entry: PersonaEntry,
    attempt: Attempt,
    phase: AttemptPhase,
    tokens: PersonaSlackTokens | undefined,
  ): Promise<void> {
    if (tokens === undefined || entry.stopped) {
      attempt.finish({ kind: 'cancelled' })
      return
    }
    let identity = entry.identity
    let web: WebClient | undefined
    if (phase !== 'reopen') {
      const validated = await validate(attempt, tokens)
      if (attempt.settled) return // abandoned at the 10 s bound, or cancelled
      clearStartTimer(attempt)
      if (validated.kind !== 'up') {
        attempt.finish({ kind: 'failed', outcome: validated })
        return
      }
      identity = validated.identity
      try {
        // A reconnect's client is the persona's only from the swap on; a
        // bring-up builds the persona's once.
        if (phase === 'reconnect') web = createWatchedWebClient(entry, tokens)
        else if (entry.web === undefined) entry.web = createWatchedWebClient(entry, tokens)
      } catch (err) {
        attempt.finish({ kind: 'failed', outcome: classifySlackValidationError(err, 'auth.test') })
        return
      }
    }
    if (identity === undefined) {
      // Unreachable: a reopen always follows an up, which set the identity.
      attempt.finish({ kind: 'failed', outcome: classifySlackValidationError(undefined, 'auth.test') })
      return
    }
    await openSocket(entry, attempt, phase, tokens, identity, web)
  }

  /**
   * `auth.test` on a short-lived validation client (bot token), under the
   * manager's own 10 s bound on the injected clock (`SLACK_AUTH_TEST_TIMEOUT_MS`).
   * On expiry the attempt is settled Slack-unreachable (`timeout`) and the
   * call is abandoned: whatever it settles to later is caught and ignored.
   * Never throws.
   */
  async function validate(attempt: Attempt, tokens: PersonaSlackTokens): Promise<SlackUpOutcome | SlackValidationFailure> {
    armAttemptBound(attempt, SLACK_AUTH_TEST_TIMEOUT_MS, () => {
      attempt.finish({ kind: 'failed', outcome: classifySlackValidationError(new SlackAuthTestTimeoutError(), 'auth.test') })
    })
    try {
      const client = factory.createValidationClient(tokens.botToken, validationWebClientOptions())
      return botIdentityFromAuthTest(await client.auth.test())
    } catch (err) {
      return classifySlackValidationError(err, 'auth.test')
    }
  }

  /**
   * Build a fresh Socket Mode client and `start()` it under the 10 s bound
   * (app token). A bring-up or reopen makes it the persona's live socket at
   * once; a reconnect's becomes it only at the swap.
   */
  async function openSocket(
    entry: PersonaEntry,
    attempt: Attempt,
    phase: AttemptPhase,
    tokens: PersonaSlackTokens,
    identity: SlackBotIdentity,
    web: WebClient | undefined,
  ): Promise<void> {
    let binding: SocketBinding
    try {
      binding = bindSocket(entry, factory.createSocketClient(socketModeClientOptions(tokens.appToken, entry.persona, log)))
    } catch (err) {
      attempt.finish({ kind: 'failed', outcome: classifySlackValidationError(err, 'socket-mode') })
      return
    }
    attempt.binding = binding
    // The WebSocket phase began: its 10 s start now.
    const restartBound = (): void => {
      if (!attempt.settled && !binding.retired) armStartTimer(attempt, binding)
    }
    listen(binding, 'authenticated', restartBound)
    listen(binding, 'connecting', restartBound)
    armStartTimer(attempt, binding)

    try {
      await binding.client.start()
    } catch (err) {
      if (attempt.settled) return // abandoned or cancelled: the late rejection is caught and ignored
      void retire(binding, false)
      attempt.finish({ kind: 'failed', outcome: classifySlackValidationError(err, 'socket-mode') })
      return
    }
    if (attempt.settled) {
      // Opened after being abandoned or cancelled: never this persona's connection.
      void retire(binding, true)
      return
    }
    if (binding.disconnected) {
      // Closed between `hello` and here: as a socket closed before `hello`.
      void retire(binding, false)
      attempt.finish({ kind: 'failed', outcome: classifySlackValidationError(undefined, 'socket-mode') })
      return
    }
    if (phase !== 'reconnect') entry.socket = binding
    attempt.finish({ kind: 'up', identity, binding, web })
  }

  function armStartTimer(attempt: Attempt, binding: SocketBinding): void {
    armAttemptBound(attempt, PERSONA_START_TIMEOUT_MS, () => {
      attempt.finish({ kind: 'failed', outcome: classifySlackValidationError(new SlackStartTimeoutError(), 'socket-mode') })
      void retire(binding, true)
    })
  }

  /**
   * (Re)arm the attempt's one bound: after `delayMs` on the injected clock,
   * `onExpiry` runs unless the attempt has settled or the bound was cleared
   * or re-armed meanwhile. Settling the attempt clears it.
   */
  function armAttemptBound(attempt: Attempt, delayMs: number, onExpiry: () => void): void {
    clearStartTimer(attempt)
    const timer: TimerBox = { handle: undefined }
    attempt.startTimer = timer
    timer.handle = clock.setTimeout(() => {
      if (attempt.startTimer !== timer) return
      attempt.startTimer = undefined
      if (attempt.settled) return
      onExpiry()
    }, delayMs)
  }

  function clearStartTimer(attempt: Attempt): void {
    const timer = attempt.startTimer
    if (timer === undefined) return
    attempt.startTimer = undefined
    clock.clearTimeout(timer.handle)
  }

  // -------------------------------------------------------------------------
  // Supervision
  // -------------------------------------------------------------------------

  /** Start an attempt in the background and act on its result. */
  function startAttempt(entry: PersonaEntry, phase: PersonaAttemptPhase): void {
    runAttempt(entry, phase, entry, entry.tokens)
      .then(result => handleResult(entry, phase, result))
      .catch(err => logFailure('connection supervision', entry, err))
  }

  /** Settle the entry's own attempt in flight as cancelled and close the socket it was opening. */
  function cancelOwnAttempt(entry: PersonaEntry): Promise<void> {
    const attempt = entry.attempt
    if (attempt === undefined) return Promise.resolve()
    attempt.finish({ kind: 'cancelled' })
    return attempt.binding === undefined ? Promise.resolve() : retire(attempt.binding, true)
  }

  function handleResult(entry: PersonaEntry, phase: PersonaAttemptPhase, result: AttemptResult): void {
    if (result.kind === 'cancelled' || entry.stopped) return
    if (result.kind === 'up') {
      entry.identity = result.identity
      entry.schedule.reset()
      entry.tracker.record({ kind: 'up' })
      setStatus(entry, { state: 'up', identity: result.identity })
      return
    }
    const { outcome } = result
    entry.tracker.record(outcome)
    if (outcome.kind === 'credentials-refused') {
      setStatus(entry, { state: 'broken', phase, outcome })
      return
    }
    const retryInMs = entry.schedule.nextDelayMs(outcome.retryAfter)
    scheduleRetry(entry, phase, retryInMs)
    setStatus(entry, { state: 'retrying', phase, outcome, retryInMs, nextAttemptAt: clock.now() + retryInMs })
  }

  function scheduleRetry(entry: PersonaEntry, phase: PersonaAttemptPhase, delayMs: number): void {
    if (entry.stopped) return
    clearRetryTimer(entry)
    const timer: TimerBox = { handle: undefined }
    entry.retryTimer = timer
    timer.handle = clock.setTimeout(() => {
      if (entry.retryTimer !== timer) return
      entry.retryTimer = undefined
      if (entry.stopped || entry.attempt !== undefined) return
      startAttempt(entry, phase)
    }, delayMs)
  }

  function clearRetryTimer(entry: PersonaEntry): void {
    const timer = entry.retryTimer
    if (timer === undefined) return
    entry.retryTimer = undefined
    clock.clearTimeout(timer.handle)
  }

  function trackerFor(persona: ConnectionPersona): SlackEpisodeTracker {
    return createSlackEpisodeTracker({
      name: persona.name,
      key: persona.key,
      index: persona.index,
      path: persona.credentials_file,
      log,
    })
  }

  // -------------------------------------------------------------------------
  // Credentials reconnect (b.av2 SR-8.6 credentials row, SR-3.1, SR-3.3)
  // -------------------------------------------------------------------------

  async function reconnectCredentials(
    key: string,
    tokens: PersonaSlackTokens,
    onLaterOutcome?: PersonaReconnectListener,
    beforeSwap?: PersonaReconnectBeforeSwap,
  ): Promise<PersonaReconnectOutcome> {
    const entry = entries.get(key)
    if (dryRun || entry === undefined || entry.stopped) return { kind: 'cancelled' }
    // A new reconnect supersedes a pending one: its timer, attempt and clients go.
    void cancelReconnect(entry, RECONNECT_SUPERSEDED)
    const reconnect: PendingReconnect = {
      tokens,
      schedule: createPersonaRetrySchedule(),
      tracker: trackerFor(entry.persona),
      onLater: onLaterOutcome,
      beforeSwap,
      attempt: undefined,
      timer: undefined,
      cancelled: false,
    }
    entry.reconnect = reconnect
    const result = await runAttempt(entry, 'reconnect', reconnect, tokens)
    return settleReconnectAttempt(entry, reconnect, result)
  }

  /** A later attempt of a reconnect left retrying; its swap or refusal goes to the reconnect's listener. */
  function startReconnectAttempt(entry: PersonaEntry, reconnect: PendingReconnect): void {
    runAttempt(entry, 'reconnect', reconnect, reconnect.tokens)
      .then(result => {
        const outcome = settleReconnectAttempt(entry, reconnect, result)
        if (outcome.kind === 'swapped' || outcome.kind === 'refused') notifyReconnectLater(entry, reconnect, outcome)
      })
      .catch(err => logFailure('credentials reconnect', entry, err))
  }

  /**
   * Act on one reconnect attempt's result: swap on `up`, end the reconnect on
   * a refusal (nothing logged here: the caller reports it), schedule the
   * next attempt when Slack was unreachable. A result for a reconnect that
   * was cancelled meanwhile is discarded with its socket.
   */
  function settleReconnectAttempt(
    entry: PersonaEntry,
    reconnect: PendingReconnect,
    result: AttemptResult,
  ): PersonaReconnectOutcome {
    if (reconnect.cancelled || entry.stopped || entry.reconnect !== reconnect || result.kind === 'cancelled') {
      if (result.kind === 'up') void retire(result.binding, true)
      return { kind: 'cancelled' }
    }
    let outcome: SlackValidationFailure
    if (result.kind === 'up') {
      if (!result.binding.disconnected) {
        swapToReconnect(entry, reconnect, result)
        return { kind: 'swapped', identity: result.identity }
      }
      // Closed between `hello` and here: as a socket closed before `hello`.
      void retire(result.binding, false)
      outcome = classifySlackValidationError(undefined, 'socket-mode')
    } else {
      outcome = result.outcome
    }
    if (outcome.kind === 'credentials-refused') {
      entry.reconnect = undefined
      reconnect.cancelled = true
      // Slack answered: an unreachable episode of this reconnect gets its
      // cleared line. The refusal itself is the caller's to log.
      reconnect.tracker.record({ kind: 'up' })
      return { kind: 'refused', outcome }
    }
    reconnect.tracker.record(outcome)
    const retryInMs = reconnect.schedule.nextDelayMs(outcome.retryAfter)
    scheduleReconnectRetry(entry, reconnect, retryInMs)
    return { kind: 'retrying', outcome, retryInMs }
  }

  /**
   * The swap: the persona now uses the reconnect's tokens, identity, Web API
   * client and socket; any reopen of the old connection is cancelled and the
   * old socket closed as the manager's own close (no reopen, no lost line).
   * Any episode open on the old connection (lost, refused) and on the
   * reconnect (unreachable) closes, so a later refusal of the new tokens is
   * logged afresh. The reconnect's `beforeSwap` runs first, while the
   * persona still reports its old status, so nothing a status listener does
   * at `up` (the notifier's flush) uses state tied to the old app.
   */
  function swapToReconnect(
    entry: PersonaEntry,
    reconnect: PendingReconnect,
    result: Extract<AttemptResult, { kind: 'up' }>,
  ): void {
    if (reconnect.beforeSwap !== undefined) {
      try {
        const hook: unknown = reconnect.beforeSwap()
        if (isThenable(hook)) hook.then(undefined, err => logFailure('credentials reconnect before-swap hook', entry, err))
      } catch (err) {
        logFailure('credentials reconnect before-swap hook', entry, err)
      }
    }
    entry.reconnect = undefined
    clearRetryTimer(entry)
    void cancelOwnAttempt(entry)
    const previous = entry.socket
    entry.tokens = reconnect.tokens
    entry.identity = result.identity
    if (result.web !== undefined) entry.web = result.web
    entry.socket = result.binding
    entry.schedule.reset()
    if (previous !== undefined && previous !== result.binding) void retire(previous, true)
    reconnect.tracker.record({ kind: 'up' })
    entry.tracker.record({ kind: 'up' })
    setStatus(entry, { state: 'up', identity: result.identity })
  }

  function scheduleReconnectRetry(entry: PersonaEntry, reconnect: PendingReconnect, delayMs: number): void {
    clearReconnectTimer(reconnect)
    const timer: TimerBox = { handle: undefined }
    reconnect.timer = timer
    timer.handle = clock.setTimeout(() => {
      if (reconnect.timer !== timer) return
      reconnect.timer = undefined
      if (reconnect.cancelled || entry.stopped || entry.reconnect !== reconnect || reconnect.attempt !== undefined) return
      startReconnectAttempt(entry, reconnect)
    }, delayMs)
  }

  function clearReconnectTimer(reconnect: PendingReconnect): void {
    const timer = reconnect.timer
    if (timer === undefined) return
    reconnect.timer = undefined
    clock.clearTimeout(timer.handle)
  }

  /**
   * Cancel the persona's pending reconnect, if any: its timer, its attempt
   * and the socket that attempt was opening. Its open Slack-unreachable
   * episode ends with one cleared line giving `reason`, so its start line
   * always gets an end.
   */
  function cancelReconnect(entry: PersonaEntry, reason: string): Promise<void> {
    const reconnect = entry.reconnect
    if (reconnect === undefined) return Promise.resolve()
    entry.reconnect = undefined
    reconnect.cancelled = true
    reconnect.tracker.end(reason)
    clearReconnectTimer(reconnect)
    const attempt = reconnect.attempt
    if (attempt === undefined) return Promise.resolve()
    attempt.finish({ kind: 'cancelled' })
    return attempt.binding === undefined ? Promise.resolve() : retire(attempt.binding, true)
  }

  function notifyReconnectLater(entry: PersonaEntry, reconnect: PendingReconnect, outcome: PersonaReconnectLaterOutcome): void {
    const listener = reconnect.onLater
    if (listener === undefined) return
    try {
      const result: unknown = listener(outcome)
      if (isThenable(result)) result.then(undefined, err => logFailure('credentials reconnect listener', entry, err))
    } catch (err) {
      logFailure('credentials reconnect listener', entry, err)
    }
  }

  function replaceRetryTokens(key: string, tokens: PersonaSlackTokens): boolean {
    const entry = entries.get(key)
    if (dryRun || entry === undefined || entry.stopped) return false
    const { status } = entry
    if (!(status.state === 'connecting' || (status.state === 'retrying' && status.phase === 'bring-up'))) return false
    entry.tokens = tokens
    // A client an earlier attempt built from the old bot token (its socket
    // then failed) was never handed out; the next attempt builds one anew.
    entry.web = undefined
    if (entry.attempt !== undefined) {
      // Superseded: the old pair's attempt is cancelled, the new pair's starts.
      void cancelOwnAttempt(entry)
      startAttempt(entry, 'bring-up')
    }
    return true
  }

  // -------------------------------------------------------------------------
  // Revoked bot token while running (bug b.ujn)
  // -------------------------------------------------------------------------

  /** The persona's long-lived Web API client for `tokens`, wrapped by the auth-failure watch. */
  function createWatchedWebClient(entry: PersonaEntry, tokens: PersonaSlackTokens): WebClient {
    const raw = factory.createWebClient(tokens.botToken, longLivedWebClientOptions())
    const watched: WebClient = watchWebClientAuth(raw, outcome => onWebApiRefused(entry, watched, outcome))
    return watched
  }

  /**
   * Whether a refusal of `client`'s call still concerns the persona: its
   * current client (a replaced one is another object), not stopped and not
   * already broken.
   */
  function webApiRefusalApplies(entry: PersonaEntry, client: WebClient): boolean {
    return (
      !entry.stopped &&
      entries.get(entry.persona.key) === entry &&
      entry.web === client &&
      entry.status.state !== 'broken'
    )
  }

  /**
   * A Web API call on `client` was refused for its bot token (the watch tells
   * this once per client). When `client` is still the persona's current
   * client, mark the persona at once; see `markRefusedWhileRunning`.
   */
  function onWebApiRefused(entry: PersonaEntry, client: WebClient, outcome: SlackCredentialsRefusedOutcome): void {
    if (!webApiRefusalApplies(entry, client)) return
    markRefusedWhileRunning(entry, outcome)
  }

  /**
   * Mark a running persona credentials-broken (bug b.ujn), synchronously:
   * cancel its attempt in flight and retry timer (a reopen cannot bring it
   * back up), detach its live socket (it forwards nothing more), log one
   * `persona-credentials-refused` line and report `broken`, so every gate
   * that reads the status (the client lookup, the up predicate, the relaunch
   * gate, the bring-up controller) refuses from now on. Only the detached
   * socket's network close is submitted through the serializer, never
   * awaited. A pending credentials reconnect is left to finish: its swap
   * brings the persona back up.
   */
  function markRefusedWhileRunning(entry: PersonaEntry, outcome: SlackCredentialsRefusedOutcome): void {
    clearRetryTimer(entry)
    void cancelOwnAttempt(entry)
    const socket = entry.socket
    if (socket !== undefined) {
      entry.socket = undefined
      void retire(socket, false)
      entry.refusedSocket = socket
      serialize(entry.persona.key, () => closeRefusedSocket(entry, socket)).catch(err =>
        logFailure('closing the connection of a persona whose bot token was refused', entry, err),
      )
    }
    entry.tracker.record(outcome)
    setStatus(entry, { state: 'broken', phase: 'running', outcome })
  }

  /**
   * Close a socket detached by `markRefusedWhileRunning` as the manager's own
   * close. Not awaited: its turn never holds the persona's serializer slot
   * for the close itself. Idempotent.
   */
  function closeRefusedSocket(entry: PersonaEntry, socket: SocketBinding): void {
    if (entry.refusedSocket === socket) entry.refusedSocket = undefined
    void disconnectQuietly(socket.client)
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  async function bringUp(persona: ConnectionPersona, tokens?: PersonaSlackTokens): Promise<PersonaConnectionStatus> {
    const existing = entries.get(persona.key)
    if (existing !== undefined) return existing.status
    if (!dryRun && tokens === undefined) {
      throw new TypeError(`persona ${renderPersonaRef(persona.name, persona.key)}: bring-up needs its credentials outside dry run`)
    }
    const entry: PersonaEntry = {
      persona,
      tokens: dryRun ? undefined : tokens,
      schedule: createPersonaRetrySchedule(),
      tracker: trackerFor(persona),
      status: { state: 'connecting' },
      identity: undefined,
      web: undefined,
      socket: undefined,
      attempt: undefined,
      retryTimer: undefined,
      reconnect: undefined,
      refusedSocket: undefined,
      stopped: false,
    }
    entries.set(persona.key, entry)

    if (dryRun) {
      const identity = dryRunPersonaIdentity(persona.key)
      entry.identity = identity
      setStatus(entry, { state: 'up', identity })
      return entry.status
    }

    setStatus(entry, { state: 'connecting' })
    if (entry.stopped) return entry.status
    const result = await runAttempt(entry, 'bring-up', entry, entry.tokens)
    handleResult(entry, 'bring-up', result)
    return entry.status
  }

  async function stop(key: string, endReason?: string): Promise<void> {
    const entry = entries.get(key)
    if (entry === undefined) return
    if (endReason !== undefined) entry.tracker.end(endReason)
    entries.delete(key)
    entry.stopped = true
    clearRetryTimer(entry)
    const closing: Promise<void>[] = [cancelOwnAttempt(entry), cancelReconnect(entry, RECONNECT_STOPPED)]
    if (entry.socket !== undefined) {
      closing.push(retire(entry.socket, true))
      entry.socket = undefined
    }
    if (entry.refusedSocket !== undefined) {
      // Its serialized close has not run yet: close it now.
      closing.push(disconnectQuietly(entry.refusedSocket.client))
      entry.refusedSocket = undefined
    }
    entry.web = undefined
    entry.identity = undefined
    setStatus(entry, { state: 'stopped' })
    await Promise.all(closing)
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...entries.keys()].map(key => stop(key)))
  }

  return {
    bringUp,
    status: key => entries.get(key)?.status,
    identity: key => entries.get(key)?.identity,
    webClient: key => {
      const entry = entries.get(key)
      return entry?.identity === undefined ? undefined : entry.web
    },
    reconnectCredentials,
    replaceRetryTokens,
    stop,
    stopAll,
  }
}

/** Whether a value is a promise-like whose rejection must be handled. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
