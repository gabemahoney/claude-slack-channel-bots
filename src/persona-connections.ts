/**
 * persona-connections.ts — The supervised per-persona Slack connection
 * manager (b.av2 SR-3.1 module part, SR-3.2, SR-3.3, SR-3.4, SR-10.3,
 * SR-13.1).
 *
 * `createPersonaConnectionManager(deps)` returns a handle that brings each
 * persona up, keeps its connection open and answers queries about it. Per
 * persona that is up it holds exactly one long-lived Socket Mode client and
 * one long-lived Web API client; a short-lived validation client exists only
 * during `auth.test`. All clients are built through the injected
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
 * Events: `message`, `app_mention` and `interactive` from a persona's socket
 * reach `onEvent(key, eventName, payload)` with the library's listener
 * argument unchanged (`{ event, body, ack, … }`). The handler is awaited in
 * try/catch; a throw is logged with `describeThrownValue` and affects no other
 * event or persona. The manager never acks.
 *
 * Isolation: every piece of state lives in one entry per persona. No lock,
 * queue, promise chain or timer is shared between personas; at most one
 * attempt per persona is in flight and at most one live Socket Mode client
 * exists per persona.
 *
 * Dry run (SR-3.4): bring-up calls no factory method, needs no credentials
 * value and reports up at once with a placeholder identity derived from the
 * key (`dryRunPersonaIdentity`); there is no Web API client.
 *
 * Secrets: the persona's `PersonaSlackTokens` is held in memory for later
 * attempts and read only to hand a token to the factory; it is never logged,
 * serialised or re-read. Log lines carry only sanitized outcome fields or
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
  | { state: 'broken'; phase: PersonaAttemptPhase; outcome: SlackCredentialsRefusedOutcome }
  /** Stopped by the caller; the persona's clients were dropped. */
  | { state: 'stopped' }

/** Receives every status change, with the persona's key. */
export type PersonaStatusListener = (key: string, status: PersonaConnectionStatus) => void

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/** What the manager needs to know about a persona: its key, and its name, index and credentials path for log lines. */
export type ConnectionPersona = Pick<Persona, 'index' | 'name' | 'key' | 'credentials_file'>

/** Constructor dependencies. */
export interface PersonaConnectionManagerDeps {
  /** Receives every forwarded event, tagged with its persona's key. */
  onEvent: PersonaEventHandler
  /** Receives every log line (diagnostic lines and handler failures). */
  log: PersonaDiagnosticLogger
  /** Dry run (SR-3.4): no credentials, no Slack call, every persona up with a placeholder identity. */
  dryRun: boolean
  /** Receives every status change. */
  onStatus?: PersonaStatusListener
  /** Slack client factory; defaults to `PRODUCTION_SLACK_CLIENT_FACTORY`. */
  factory?: PersonaSlackClientFactory
  /** Clock and timers; default `SYSTEM_PERSONA_CONNECTION_CLOCK`. */
  clock?: PersonaConnectionClock
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
   * Stop a persona: cancel its timers and any attempt in flight (its result
   * is discarded), disconnect its socket as the manager's own close, drop its
   * clients and forget it. Idempotent. Resolves once the disconnects settle.
   */
  stop(key: string): Promise<void>
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

/** One Socket Mode client and the listeners the manager subscribed on it. */
interface SocketBinding {
  readonly client: PersonaSocketClient
  /** Set when the manager abandons, closes or detaches the client; it then forwards nothing. */
  retired: boolean
  /** Set by any `disconnected` the client emits, so a `start()` resolving after one never counts as up. */
  disconnected: boolean
  readonly listeners: Array<[string, PersonaSocketListener]>
}

/** How an attempt ended. */
type AttemptResult =
  | { kind: 'up'; identity: SlackBotIdentity }
  | { kind: 'failed'; outcome: SlackValidationFailure }
  | { kind: 'cancelled' }

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

/** Everything the manager holds for one persona. Nothing here is shared with another persona. */
interface PersonaEntry {
  readonly persona: ConnectionPersona
  /** Held for later attempts; `undefined` in dry run. */
  readonly tokens: PersonaSlackTokens | undefined
  readonly schedule: PersonaRetrySchedule
  readonly tracker: SlackEpisodeTracker
  status: PersonaConnectionStatus
  identity: SlackBotIdentity | undefined
  web: WebClient | undefined
  /** The live Socket Mode connection, while up. */
  socket: SocketBinding | undefined
  attempt: Attempt | undefined
  retryTimer: TimerBox | undefined
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
    if (binding.retired || entry.stopped) return
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

  /** Run one attempt for a persona; resolves exactly once with its result. */
  function runAttempt(entry: PersonaEntry, phase: PersonaAttemptPhase): Promise<AttemptResult> {
    return new Promise<AttemptResult>(resolve => {
      const attempt: Attempt = {
        settled: false,
        startTimer: undefined,
        binding: undefined,
        finish(result) {
          if (attempt.settled) return
          attempt.settled = true
          clearStartTimer(attempt)
          if (entry.attempt === attempt) entry.attempt = undefined
          resolve(result)
        },
      }
      entry.attempt = attempt
      performAttempt(entry, attempt, phase).catch(err => {
        // performAttempt catches every Slack failure itself; this is a backstop.
        attempt.finish({ kind: 'failed', outcome: classifySlackValidationError(err, 'socket-mode') })
      })
    })
  }

  async function performAttempt(entry: PersonaEntry, attempt: Attempt, phase: PersonaAttemptPhase): Promise<void> {
    const tokens = entry.tokens
    if (tokens === undefined || entry.stopped) {
      attempt.finish({ kind: 'cancelled' })
      return
    }
    let identity = entry.identity
    if (phase === 'bring-up') {
      const validated = await validate(attempt, tokens)
      if (attempt.settled) return // abandoned at the 10 s bound, or cancelled
      clearStartTimer(attempt)
      if (validated.kind !== 'up') {
        attempt.finish({ kind: 'failed', outcome: validated })
        return
      }
      identity = validated.identity
      if (entry.web === undefined) {
        try {
          entry.web = factory.createWebClient(tokens.botToken, longLivedWebClientOptions())
        } catch (err) {
          attempt.finish({ kind: 'failed', outcome: classifySlackValidationError(err, 'auth.test') })
          return
        }
      }
    }
    if (identity === undefined) {
      // Unreachable: a reopen always follows an up, which set the identity.
      attempt.finish({ kind: 'failed', outcome: classifySlackValidationError(undefined, 'auth.test') })
      return
    }
    await openSocket(entry, attempt, tokens, identity)
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

  /** Build a fresh Socket Mode client and `start()` it under the 10 s bound (app token). */
  async function openSocket(
    entry: PersonaEntry,
    attempt: Attempt,
    tokens: PersonaSlackTokens,
    identity: SlackBotIdentity,
  ): Promise<void> {
    let binding: SocketBinding
    try {
      binding = bindSocket(entry, factory.createSocketClient(socketModeClientOptions(tokens.appToken)))
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
    entry.socket = binding
    attempt.finish({ kind: 'up', identity })
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
    runAttempt(entry, phase)
      .then(result => handleResult(entry, phase, result))
      .catch(err => logFailure('connection supervision', entry, err))
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
      tracker: createSlackEpisodeTracker({
        name: persona.name,
        key: persona.key,
        index: persona.index,
        path: persona.credentials_file,
        log,
      }),
      status: { state: 'connecting' },
      identity: undefined,
      web: undefined,
      socket: undefined,
      attempt: undefined,
      retryTimer: undefined,
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
    const result = await runAttempt(entry, 'bring-up')
    handleResult(entry, 'bring-up', result)
    return entry.status
  }

  async function stop(key: string): Promise<void> {
    const entry = entries.get(key)
    if (entry === undefined) return
    entries.delete(key)
    entry.stopped = true
    clearRetryTimer(entry)
    const closing: Promise<void>[] = []
    const attempt = entry.attempt
    if (attempt !== undefined) {
      attempt.finish({ kind: 'cancelled' })
      if (attempt.binding !== undefined) closing.push(retire(attempt.binding, true))
    }
    if (entry.socket !== undefined) {
      closing.push(retire(entry.socket, true))
      entry.socket = undefined
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
