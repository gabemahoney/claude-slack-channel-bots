/**
 * test-helpers/slack-stub.ts — Shared Slack stub (b.av2 SR-13.4).
 *
 * `makeStubSlack(opts)` returns one independent fake Slack for one persona:
 * - Web API stubs (`web`, `createWebClient`) with capture arrays for
 *   `chat.postMessage`, `chat.update`, `reactions.add`/`remove`,
 *   `conversations.open`, `auth.test` and `users.info`;
 * - Socket Mode stubs (`createSocketClient`, `socket`, `sockets`) that register
 *   handlers, deliver events in the `{ event, body, ack }` shape `server.ts`
 *   consumes, record acks, drop on demand and can be started again;
 * - per-call scripted outcomes for `auth.test`, socket `start()` and
 *   `chat.postMessage` (`script`), falling back to success when exhausted;
 * - a record of the options every client was built with (`options`).
 *
 * `makeStubSlackFactory()` adapts per-persona stubs to the connection
 * manager's injected `PersonaSlackClientFactory`: one factory serves every
 * persona, routing each build to the persona whose token it received (the app
 * token for a socket client, the bot token for a Web API client), and records
 * every client it built with its kind, persona, options and token.
 *
 * Failure shapes follow the installed libraries, `@slack/web-api` 7.15.0 and
 * `@slack/socket-mode` 2.0.6, whose `ErrorCode` values the stub uses directly:
 * - platform error: `code` `slack_webapi_platform_error`, message
 *   `An API error occurred: <error>`, `data` = the `ok: false` body with
 *   `data.error` and `data.response_metadata` (holding `retryAfter` if given);
 * - request error (network, DNS, timeout): `code` `slack_webapi_request_error`,
 *   message `A request error occurred: <original message>`, and `original` (an
 *   axios-style error with `code`, `config.headers`) unless the client was
 *   built with `attachOriginalToWebAPIRequestError: false` (in a Web API
 *   client's options, or in a socket client's `clientOptions` for its connect
 *   leg), as `@slack/web-api` 7.15.0 does;
 * - HTTP error: `code` `slack_webapi_http_error`, `statusCode`,
 *   `statusMessage`, `headers`, `body`;
 * - rate-limited error: `code` `slack_webapi_rate_limited_error`,
 *   `retryAfter` in seconds (the SR-3.3 `rejectRateLimitedCalls: true` path);
 * - no URL: a plain `Error` from the `apps.connections.open` leg of `start()`;
 * - websocket error: an `error` event carrying `code`
 *   `slack_socket_mode_websocket_error` and `original`.
 *
 * Socket lifecycle, as `SocketModeClient` behaves with
 * `autoReconnectEnabled: false`:
 * - The connect leg (`apps.connections.open`) answers first. With
 *   `open-never-answers` it never answers: `start()` stays pending and no
 *   lifecycle event is emitted, whatever happens later. With `deferred` it
 *   answers when the test settles the outcome (`makeDeferredConnect`), and
 *   `start()` then proceeds with the outcome the test settled it with.
 * - A Web API failure on the connect leg (request, DNS, timeout, HTTP,
 *   rate-limited, platform error, no URL, `reject`) rejects `start()` with that
 *   error and emits no lifecycle event.
 * - Otherwise `authenticated` then `connecting` are emitted and the WebSocket
 *   phase settles on a later microtask: `ok` emits `connected` and `start()`
 *   resolves with `undefined` (the real client resolves with no value too);
 *   `closed-before-hello` emits `close` and `disconnected` and `start()`
 *   rejects with no value; `websocket-error` emits `error` first, then the
 *   same; `never` leaves `start()` pending until `drop()` or `disconnect()`.
 * - `drop()` is Slack closing the connection: it emits `close` and
 *   `disconnected`. `disconnect()` is the client's own close (CSCB closing the
 *   socket, never Slack): it is counted in `disconnectCalls` and emits
 *   `disconnecting`, `close` (if a WebSocket phase ever began) and
 *   `disconnected`. A `start()` still waiting on its connect leg stays
 *   pending through `disconnect()`, and a later answer (a settled `deferred`)
 *   still opens the WebSocket, as `@slack/socket-mode` 2.0.6 does.
 * - `start()` can be called again after a drop; `startCalls` counts calls.
 *
 * Leak marker: with `leakMarker` set (normally `LEAK_SENTINEL`), every
 * scripted failure carries the marker where a real error can hold secrets:
 * the message, the `original` (message and an `Authorization` header built
 * with `fakeToken`), HTTP headers and body, the `error` event's error, and
 * fields of `data` other than `data.error`, which stays exactly as scripted.
 * `closed-before-hello` rejects with no value, so it carries nothing. A
 * request error from a client built with `attachOriginalToWebAPIRequestError:
 * false` carries nothing either: without `original` the library keeps only
 * the axios message, which never holds the request's headers.
 *
 * Isolation (b.av2 SR-13.2): no module-scope state, no network, no
 * filesystem, no environment access, no timers. No token literal: tokens are
 * built at runtime with `fakeToken`.
 *
 * SPDX-License-Identifier: MIT
 */

import { STATUS_CODES } from 'node:http'
import { ErrorCode as WebApiErrorCode } from '@slack/web-api'
import type { AppsConnectionsOpenResponse, WebClient, WebClientOptions } from '@slack/web-api'
import { ErrorCode as SocketModeErrorCode } from '@slack/socket-mode'
import type { SocketModeOptions } from '@slack/socket-mode'
import type { PersonaSlackClientFactory } from '../../src/persona-slack-clients.ts'
import { APP_TOKEN_PREFIX, BOT_TOKEN_PREFIX, fakeToken } from './credentials.ts'

// ---------------------------------------------------------------------------
// Scripted outcomes
// ---------------------------------------------------------------------------

/** A Slack-unreachable failure of a Web API call (also the socket's connect leg). */
export type UnreachableOutcome =
  /** Connection refused: a request error whose `original.code` is `ECONNREFUSED`. */
  | { kind: 'network' }
  /** DNS failure: a request error whose `original.code` is `ENOTFOUND`. */
  | { kind: 'dns' }
  /**
   * Timeout: a request error whose `original.code` is `ECONNABORTED` (axios,
   * client built with a `timeout`) or `ETIMEDOUT` (no `timeout` option).
   */
  | { kind: 'timeout' }
  /** Non-200 response: an HTTP error with this `statusCode`. */
  | { kind: 'http'; status: number }
  /** HTTP 429 with `rejectRateLimitedCalls`: a rate-limited error with `retryAfter` seconds. */
  | { kind: 'rate-limited'; retryAfter: number }

/** One scripted Web API call result: `auth.test` or `chat.postMessage`. */
export type WebApiOutcome =
  /**
   * Success. `result` is merged over the default response; a key set to
   * `undefined` is removed (e.g. `{ result: { bot_id: undefined } }`).
   */
  | { kind: 'ok'; result?: Readonly<Record<string, unknown>> }
  /**
   * A `PlatformError` (`ok: false` answer) with `data.error` = `error`, and
   * `data.response_metadata.retryAfter` when `retryAfter` is given. Omitting
   * `error` leaves `data.error` out, as the library does for a 200 body
   * without `ok`.
   */
  | { kind: 'platform'; error?: string; retryAfter?: number }
  | UnreachableOutcome
  /** The call never resolves or rejects. */
  | { kind: 'never' }
  /** The call rejects with `value` exactly as given (a plain `Error`, a string, `undefined` …). */
  | { kind: 'reject'; value: unknown }

/** A socket `start()` result the test can settle a `deferred` outcome with: every kind but `deferred`. */
export type SettledConnectOutcome =
  /** `hello` arrives: `connected` is emitted and `start()` resolves. */
  | { kind: 'ok' }
  /** Web API failures of the `apps.connections.open` leg: `start()` rejects with the error. */
  | Exclude<WebApiOutcome, { kind: 'ok' } | { kind: 'never' }>
  /** `apps.connections.open` answered without a URL: `start()` rejects with a plain `Error`. */
  | { kind: 'no-url' }
  /** WebSocket error before `hello`: `error`, `close`, `disconnected`; `start()` rejects with no value. */
  | { kind: 'websocket-error' }
  /** WebSocket closed before `hello`: `close`, `disconnected`; `start()` rejects with no value. */
  | { kind: 'closed-before-hello' }
  /**
   * `apps.connections.open` answers but the WebSocket phase never reaches
   * `hello`: `authenticated` and `connecting` are emitted, then `start()` stays
   * pending until a drop or disconnect.
   */
  | { kind: 'never' }
  /**
   * `apps.connections.open` never answers: `start()` stays pending for good and
   * no lifecycle event is emitted. `disconnect()` does not end it, and
   * `drop()` throws (no WebSocket was begun).
   */
  | { kind: 'open-never-answers' }

/**
 * A `start()` whose `apps.connections.open` leg answers only when the test
 * settles it. Build with `makeDeferredConnect`; the `answer` is internal.
 */
export interface DeferredConnectOutcome {
  kind: 'deferred'
  readonly answer: Promise<SettledConnectOutcome>
}

/** One scripted socket `start()` result. */
export type ConnectOutcome = SettledConnectOutcome | DeferredConnectOutcome

/** A deferred connect outcome and its settle control. */
export interface DeferredConnect {
  /** Script this (`script.connect.push(d.outcome)`); every `start()` that takes it waits for `settle`. */
  readonly outcome: DeferredConnectOutcome
  /** Whether `settle` was called. */
  readonly settled: boolean
  /**
   * Answer the connect leg: each waiting `start()` then proceeds as if
   * `outcome` (default `ok`) had been scripted, lifecycle events included.
   * Throws if already settled.
   */
  settle(outcome?: SettledConnectOutcome): void
}

/**
 * A connect outcome that holds `start()` at its `apps.connections.open` leg,
 * with no lifecycle event, until the test calls `settle`. Settling after the
 * manager abandoned the `start()` makes it resolve or reject late.
 */
export function makeDeferredConnect(): DeferredConnect {
  let answer: (outcome: SettledConnectOutcome) => void = () => {}
  let settled = false
  const outcome: DeferredConnectOutcome = {
    kind: 'deferred',
    answer: new Promise<SettledConnectOutcome>((resolve) => {
      answer = resolve
    }),
  }
  return {
    outcome,
    get settled() {
      return settled
    },
    settle(settledWith = { kind: 'ok' }) {
      if (settled) throw new Error('slack-stub: a deferred connect outcome settles once')
      settled = true
      answer(settledWith)
    },
  }
}

/** Per-call outcome queues. Consumed front to back; an empty queue means success. */
export interface StubSlackScript {
  authTest: WebApiOutcome[]
  connect: ConnectOutcome[]
  post: WebApiOutcome[]
}

export interface StubSlackOptions {
  /** Initial `auth.test` outcomes (copied; push more onto `stub.script.authTest`). */
  authTest?: readonly WebApiOutcome[]
  /** Initial socket `start()` outcomes, shared by every socket client of this stub. */
  connect?: readonly ConnectOutcome[]
  /** Initial `chat.postMessage` outcomes. */
  post?: readonly WebApiOutcome[]
  /** Marker placed in every scripted failure where a real error can hold secrets. */
  leakMarker?: string
  /** Bot user ID `auth.test` returns. Default: a random `U…` ID, distinct per stub. */
  botUserId?: string
  /** Bot ID `auth.test` returns. Default: a random `B…` ID, distinct per stub. */
  botId?: string
  /** Team ID `auth.test` returns and event bodies carry. Default `T0STUB0001`. */
  teamId?: string
}

// ---------------------------------------------------------------------------
// Client surfaces
// ---------------------------------------------------------------------------

/** The Web API surface the stub imitates, typed as the real `WebClient` methods. */
export interface StubWebClient {
  auth: { test: WebClient['auth']['test'] }
  chat: { postMessage: WebClient['chat']['postMessage']; update: WebClient['chat']['update'] }
  reactions: { add: WebClient['reactions']['add']; remove: WebClient['reactions']['remove'] }
  conversations: { open: WebClient['conversations']['open'] }
  users: { info: WebClient['users']['info'] }
}

/** Ack function handed to socket event listeners. Records into `acks`. */
export type StubAck = (response?: Record<string, unknown>) => Promise<void>

/** Listener argument for an Events API event (`message`, `app_mention`, …), as `SocketModeClient` emits it. */
export interface StubSocketEventArgs {
  ack: StubAck
  envelope_id: string
  body: Record<string, unknown>
  event: SlackEvent
  retry_num: number | undefined
  retry_reason: string | undefined
  accepts_response_payload: boolean
}

/** Listener argument for an `interactive` payload, as `SocketModeClient` emits it. */
export interface StubSocketInteractiveArgs {
  ack: StubAck
  envelope_id: string
  body: Record<string, unknown>
  accepts_response_payload: boolean
}

/** A recorded ack. */
export interface StubAckRecord {
  envelopeId: string
  response: Record<string, unknown> | undefined
}

/** Lifecycle events the socket stub emits, in `lifecycle` order. */
export type StubSocketLifecycleEvent =
  | 'authenticated'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'close'
  | 'disconnecting'
  | 'disconnected'

// Listener arguments vary per event, as in eventemitter3's own typing.
type Listener = (...args: any[]) => unknown

/** The Socket Mode surface the stub imitates, plus test controls. */
export interface StubSocketClient {
  /** The options this client was built with. */
  readonly options: SocketModeOptions
  on(event: string, listener: Listener): this
  once(event: string, listener: Listener): this
  off(event: string, listener: Listener): this
  removeListener(event: string, listener: Listener): this
  removeAllListeners(event?: string): this
  listenerCount(event: string): number
  start(): Promise<AppsConnectionsOpenResponse>
  /**
   * The client's own close (CSCB closing the socket), never Slack's: counted
   * in `disconnectCalls`; emits `disconnecting`, `close` (if a WebSocket phase
   * ever began) and `disconnected`. Use `drop()` for Slack closing it.
   */
  disconnect(): Promise<void>

  /** True between `connected` and the next `close`. */
  readonly connected: boolean
  /** Number of `start()` calls. */
  readonly startCalls: number
  /** Number of `disconnect()` calls: the client's (CSCB's) own close, not a drop by Slack. */
  readonly disconnectCalls: number
  /** Successful acks, in order. */
  readonly acks: readonly StubAckRecord[]
  /** Every lifecycle event emitted, in order. */
  readonly lifecycle: readonly StubSocketLifecycleEvent[]
  /**
   * Close the WebSocket from Slack's side (a drop): emits `close` and
   * `disconnected`; a `start()` still waiting for `hello` rejects with no
   * value. Throws if the socket is neither connected nor connecting.
   */
  drop(): void
  /**
   * Deliver an Events API event to the listeners for `event.type` (and
   * `slack_event`). Resolves once every listener's returned promise settles;
   * rejects if one rejects, or if the socket is not connected.
   */
  deliver(event: SlackEvent): Promise<void>
  /** Deliver an `interactive` payload (e.g. a Block Kit click), as `deliver` does. */
  deliverInteractive(payload: Record<string, unknown>): Promise<void>
}

/** A recorded `createWebClient` call. */
export interface StubWebClientBuild {
  token: string
  options: WebClientOptions | undefined
}

/** Arguments of each captured Web API call. */
export interface StubSlackCalls {
  authTest: Parameters<WebClient['auth']['test']>[0][]
  postMessage: Parameters<WebClient['chat']['postMessage']>[0][]
  update: Parameters<WebClient['chat']['update']>[0][]
  reactionsAdd: Parameters<WebClient['reactions']['add']>[0][]
  reactionsRemove: Parameters<WebClient['reactions']['remove']>[0][]
  conversationsOpen: Parameters<WebClient['conversations']['open']>[0][]
  usersInfo: Parameters<WebClient['users']['info']>[0][]
}

export interface StubSlack {
  /** The identity a successful `auth.test` returns. */
  readonly identity: { botUserId: string; botId: string; teamId: string }
  /** Outcome queues; push onto them at any time. */
  readonly script: StubSlackScript
  /** Captured Web API call arguments, shared by every Web API client of this stub. */
  readonly calls: StubSlackCalls
  /** Options every client was built with, in build order. */
  readonly options: { web: StubWebClientBuild[]; socket: SocketModeOptions[] }
  /** A Web API client for direct use; not in `options.web`. Behaves as if built with default options. */
  readonly web: StubWebClient
  /** Build a Web API client, as `new WebClient(token, options)`. Recorded in `options.web`. */
  createWebClient(token?: string, options?: WebClientOptions): StubWebClient
  /**
   * Build a socket client, as `new SocketModeClient(options)`. Recorded in
   * `options.socket` and `sockets`. Throws on an empty `appToken`, as the
   * real constructor does. Default options carry a fake app token.
   */
  createSocketClient(options?: SocketModeOptions): StubSocketClient
  /** Every socket client built, in build order. */
  readonly sockets: readonly StubSocketClient[]
  /** The most recently built socket client. Throws if none was built. */
  readonly socket: StubSocketClient
}

// ---------------------------------------------------------------------------
// Error builders (library shapes)
// ---------------------------------------------------------------------------

/** Where a failing call came from, for axios-style `original` details. */
interface CallContext {
  method: string
  tokenPrefix: string
  attachOriginal: boolean
  timeoutMs: number | undefined
  marker: string | undefined
}

/** ` (<marker>)` when a marker is set, else ''. */
function markerSuffix(marker: string | undefined): string {
  return marker === undefined ? '' : ` (${marker})`
}

function codedError(message: string, code: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code }, fields)
}

function platformError(error: string | undefined, retryAfter: number | undefined, marker: string | undefined): Error {
  const responseMetadata: Record<string, unknown> = {}
  if (retryAfter !== undefined) responseMetadata.retryAfter = retryAfter
  const data: Record<string, unknown> = { ok: false, response_metadata: responseMetadata }
  if (error !== undefined) data.error = error
  if (marker !== undefined) {
    responseMetadata.messages = [`[ERROR] ${marker}`]
    data.provided = marker
  }
  return codedError(`An API error occurred: ${error}${markerSuffix(marker)}`, WebApiErrorCode.PlatformError, { data })
}

/** The axios error `@slack/web-api` wraps in a request error. */
function axiosError(message: string, code: string, ctx: CallContext): Error {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (ctx.marker !== undefined) headers.Authorization = `Bearer ${fakeToken(ctx.tokenPrefix, ctx.marker)}`
  const err = codedError(`${message}${markerSuffix(ctx.marker)}`, code, {
    isAxiosError: true,
    config: { url: `https://slack.com/api/${ctx.method}`, method: 'post', timeout: ctx.timeoutMs ?? 0, headers },
    request: { method: 'POST', path: `/api/${ctx.method}` },
  })
  err.name = 'AxiosError'
  return err
}

/** The axios error behind a request error of kind `outcome`. */
function requestFailure(outcome: 'network' | 'dns' | 'timeout', ctx: CallContext): Error {
  if (outcome === 'network') return axiosError('connect ECONNREFUSED 192.0.2.1:443', 'ECONNREFUSED', ctx)
  if (outcome === 'dns') return axiosError('getaddrinfo ENOTFOUND slack.com', 'ENOTFOUND', ctx)
  if (ctx.timeoutMs !== undefined && ctx.timeoutMs > 0) {
    return axiosError(`timeout of ${ctx.timeoutMs}ms exceeded`, 'ECONNABORTED', ctx)
  }
  return axiosError('connect ETIMEDOUT 192.0.2.1:443', 'ETIMEDOUT', ctx)
}

function requestError(outcome: 'network' | 'dns' | 'timeout', ctx: CallContext): Error {
  if (!ctx.attachOriginal) {
    // `attachOriginalToWebAPIRequestError: false`: the library keeps only the
    // axios message, which never holds the request's headers, so no marker.
    const { message } = requestFailure(outcome, { ...ctx, marker: undefined })
    return codedError(`A request error occurred: ${message}`, WebApiErrorCode.RequestError)
  }
  const original = requestFailure(outcome, ctx)
  return codedError(`A request error occurred: ${original.message}`, WebApiErrorCode.RequestError, { original })
}

function httpError(status: number, marker: string | undefined): Error {
  const headers: Record<string, string> = { 'content-type': 'text/html' }
  if (marker !== undefined) headers['x-slack-req-id'] = marker
  return codedError(`An HTTP protocol error occurred: statusCode = ${status}${markerSuffix(marker)}`, WebApiErrorCode.HTTPError, {
    statusCode: status,
    statusMessage: STATUS_CODES[status] ?? '',
    headers,
    body: marker === undefined ? '<html></html>' : `<html>${marker}</html>`,
  })
}

function rateLimitedError(retryAfter: number, marker: string | undefined): Error {
  return codedError(
    `A rate-limit has been reached, you may retry this request in ${retryAfter} seconds${markerSuffix(marker)}`,
    WebApiErrorCode.RateLimitedError,
    { retryAfter },
  )
}

/** The error a scripted Web API failure raises, or `undefined` for `ok`/`never`/`reject`. */
function webApiFailure(outcome: WebApiOutcome | ConnectOutcome, ctx: CallContext): Error | undefined {
  switch (outcome.kind) {
    case 'platform':
      return platformError(outcome.error, outcome.retryAfter, ctx.marker)
    case 'network':
    case 'dns':
    case 'timeout':
      return requestError(outcome.kind, ctx)
    case 'http':
      return httpError(outcome.status, ctx.marker)
    case 'rate-limited':
      return rateLimitedError(outcome.retryAfter, ctx.marker)
    default:
      return undefined
  }
}

/** Run one scripted Web API call: resolve `success()`, reject, or never settle. */
function runWebApiCall<T>(outcome: WebApiOutcome | undefined, ctx: CallContext, success: () => T): Promise<T> {
  if (outcome === undefined) return Promise.resolve(success())
  if (outcome.kind === 'never') return new Promise<T>(() => {})
  if (outcome.kind === 'reject') return Promise.reject(outcome.value)
  const failure = webApiFailure(outcome, ctx)
  if (failure !== undefined) return Promise.reject(failure)
  return Promise.resolve(success())
}

/** `base` with `overrides` merged over it; an override set to `undefined` removes the key. */
function mergeDroppingUndefined<T extends Record<string, unknown>>(base: T, overrides: Readonly<Record<string, unknown>>): T {
  const merged: Record<string, unknown> = { ...base, ...overrides }
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key]
  }
  return merged as T
}

/** The `text` argument of a chat call, if it is a string. */
function textOf(args: object): string | undefined {
  const text = (args as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

/** A random run of uppercase letters and digits, like the tail of a Slack ID. */
function randomIdTail(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()
}

// ---------------------------------------------------------------------------
// makeStubSlack
// ---------------------------------------------------------------------------

/** Build one independent fake Slack. See the module comment for behaviour. */
export function makeStubSlack(opts: StubSlackOptions = {}): StubSlack {
  const marker = opts.leakMarker
  const identity = {
    botUserId: opts.botUserId ?? `U${randomIdTail()}`,
    botId: opts.botId ?? `B${randomIdTail()}`,
    teamId: opts.teamId ?? 'T0STUB0001',
  }
  const script: StubSlackScript = {
    authTest: [...(opts.authTest ?? [])],
    connect: [...(opts.connect ?? [])],
    post: [...(opts.post ?? [])],
  }
  const calls: StubSlackCalls = {
    authTest: [],
    postMessage: [],
    update: [],
    reactionsAdd: [],
    reactionsRemove: [],
    conversationsOpen: [],
    usersInfo: [],
  }
  const options: StubSlack['options'] = { web: [], socket: [] }
  const sockets: StubSocketClient[] = []
  let tsSeq = 0
  let dmSeq = 0

  const nextTs = (): string => `1700000000.${String(++tsSeq).padStart(6, '0')}`

  function buildWebClient(clientOptions: WebClientOptions | undefined): StubWebClient {
    const ctx = (method: string): CallContext => ({
      method,
      tokenPrefix: BOT_TOKEN_PREFIX,
      attachOriginal: clientOptions?.attachOriginalToWebAPIRequestError !== false,
      timeoutMs: clientOptions?.timeout,
      marker,
    })
    return {
      auth: {
        test: (args) => {
          calls.authTest.push(args)
          const outcome = script.authTest.shift()
          return runWebApiCall(outcome, ctx('auth.test'), () =>
            mergeDroppingUndefined(
              {
                ok: true,
                url: 'https://stub-workspace.slack.com/',
                team: 'Stub Workspace',
                user: 'stub-bot',
                team_id: identity.teamId,
                user_id: identity.botUserId,
                bot_id: identity.botId,
                is_enterprise_install: false,
              },
              outcome?.kind === 'ok' ? (outcome.result ?? {}) : {},
            ),
          )
        },
      },
      chat: {
        postMessage: (args) => {
          calls.postMessage.push(args)
          const outcome = script.post.shift()
          return runWebApiCall(outcome, ctx('chat.postMessage'), () => {
            const ts = nextTs()
            const text = textOf(args)
            return mergeDroppingUndefined(
              {
                ok: true,
                channel: args.channel,
                ts,
                message: { type: 'message', text, user: identity.botUserId, bot_id: identity.botId, ts },
              },
              outcome?.kind === 'ok' ? (outcome.result ?? {}) : {},
            )
          })
        },
        update: (args) => {
          calls.update.push(args)
          return Promise.resolve({ ok: true, channel: args.channel, ts: args.ts, text: textOf(args) })
        },
      },
      reactions: {
        add: (args) => {
          calls.reactionsAdd.push(args)
          return Promise.resolve({ ok: true })
        },
        remove: (args) => {
          calls.reactionsRemove.push(args)
          return Promise.resolve({ ok: true })
        },
      },
      conversations: {
        open: (args) => {
          calls.conversationsOpen.push(args)
          return Promise.resolve({ ok: true, channel: { id: `D0STUB${String(++dmSeq).padStart(4, '0')}` } })
        },
      },
      users: {
        info: (args) => {
          calls.usersInfo.push(args)
          return Promise.resolve({
            ok: true,
            user: {
              id: args.user,
              team_id: identity.teamId,
              name: 'stub-user',
              real_name: 'Stub User',
              is_bot: false,
              profile: { display_name: 'stub-user', real_name: 'Stub User' },
            },
          })
        },
      },
    }
  }

  function buildSocketClient(socketOptions: SocketModeOptions): StubSocketClient {
    const listeners = new Map<string, Array<{ fn: Listener; once: boolean }>>()
    const acks: StubAckRecord[] = []
    const lifecycle: StubSocketLifecycleEvent[] = []
    let startCalls = 0
    let disconnectCalls = 0
    let wsOpen = false // a WebSocket is connecting or connected
    let wsCreated = false // a WebSocket phase was ever begun (the real client keeps its SlackWebSocket)
    let connected = false
    let pendingStart: { resolve: (v: AppsConnectionsOpenResponse) => void; reject: (e: unknown) => void } | null = null
    let envelopeSeq = 0

    /** Call every listener for `event`; return what they returned. */
    function emit(event: string, ...args: unknown[]): unknown[] {
      const entries = [...(listeners.get(event) ?? [])]
      const current = listeners.get(event)
      if (current) listeners.set(event, current.filter((entry) => !entry.once))
      return entries.map((entry) => entry.fn(...args))
    }

    function emitLifecycle(event: StubSocketLifecycleEvent, ...args: unknown[]): void {
      lifecycle.push(event)
      emit(event, ...args)
    }

    /** Close the WebSocket: `close`, `disconnected`, and reject a start waiting for `hello`. */
    function closeSocket(): void {
      wsOpen = false
      connected = false
      const pending = pendingStart
      pendingStart = null
      try {
        emitLifecycle('close')
        emitLifecycle('disconnected')
      } finally {
        pending?.reject(undefined)
      }
    }

    const connectCtx: CallContext = {
      method: 'apps.connections.open',
      tokenPrefix: APP_TOKEN_PREFIX,
      attachOriginal: socketOptions.clientOptions?.attachOriginalToWebAPIRequestError !== false,
      timeoutMs: socketOptions.clientOptions?.timeout,
      marker,
    }

    function addListener(event: string, fn: Listener, once: boolean): void {
      const list = listeners.get(event) ?? []
      list.push({ fn, once })
      listeners.set(event, list)
    }

    function makeAck(envelopeId: string): StubAck {
      return async (response) => {
        if (!connected) {
          throw codedError(
            'Failed to send a WebSocket message as the client is not ready',
            SocketModeErrorCode.NoReplyReceivedError,
          )
        }
        acks.push({ envelopeId, response })
      }
    }

    function requireConnected(what: string): void {
      if (!connected) throw new Error(`slack-stub: ${what} needs a connected socket`)
    }

    async function settle(results: unknown[]): Promise<void> {
      await Promise.all(results)
    }

    const client: StubSocketClient = {
      options: socketOptions,
      on(event, listener) {
        addListener(event, listener, false)
        return this
      },
      once(event, listener) {
        addListener(event, listener, true)
        return this
      },
      off(event, listener) {
        return this.removeListener(event, listener)
      },
      removeListener(event, listener) {
        const list = listeners.get(event) ?? []
        const i = list.findIndex((entry) => entry.fn === listener)
        if (i !== -1) list.splice(i, 1)
        return this
      },
      removeAllListeners(event) {
        if (event === undefined) listeners.clear()
        else listeners.delete(event)
        return this
      },
      listenerCount(event) {
        return listeners.get(event)?.length ?? 0
      },

      async start() {
        startCalls++
        const scripted: ConnectOutcome = script.connect.shift() ?? { kind: 'ok' }
        // The apps.connections.open leg: a failure here rejects start() with no event.
        await Promise.resolve()
        const outcome = scripted.kind === 'deferred' ? await scripted.answer : scripted
        if (outcome.kind === 'open-never-answers') return new Promise<AppsConnectionsOpenResponse>(() => {})
        if (outcome.kind === 'reject') throw outcome.value
        if (outcome.kind === 'no-url') {
          throw new Error(`apps.connections.open did not return a URL! (response: ${marker ?? '[object Object]'})`)
        }
        const failure = webApiFailure(outcome, connectCtx)
        if (failure !== undefined) throw failure

        // The WebSocket phase, up to `hello`.
        emitLifecycle('authenticated', { ok: true, url: 'wss://wss-stub.invalid/link/?ticket=stub' })
        wsOpen = true
        wsCreated = true
        return new Promise<AppsConnectionsOpenResponse>((resolve, reject) => {
          pendingStart = { resolve, reject }
          emitLifecycle('connecting')
          queueMicrotask(() => {
            if (!wsOpen || pendingStart === null) return
            if (outcome.kind === 'ok') {
              connected = true
              const pending = pendingStart
              pendingStart = null
              try {
                emitLifecycle('connected')
              } finally {
                // The real client resolves start() with no value.
                pending.resolve(undefined as unknown as AppsConnectionsOpenResponse)
              }
            } else if (outcome.kind === 'closed-before-hello') {
              closeSocket()
            } else if (outcome.kind === 'websocket-error') {
              const original = Object.assign(new Error(`read ECONNRESET${markerSuffix(marker)}`), { code: 'ECONNRESET' })
              const err = codedError(original.message, SocketModeErrorCode.WebsocketError, { original })
              try {
                emitLifecycle('error', err)
              } finally {
                closeSocket()
              }
            }
            // 'never': stays pending until drop() or disconnect().
          })
        })
      },

      async disconnect() {
        disconnectCalls++
        emitLifecycle('disconnecting')
        if (wsCreated) closeSocket()
        else emitLifecycle('disconnected')
      },

      get connected() {
        return connected
      },
      get startCalls() {
        return startCalls
      },
      get disconnectCalls() {
        return disconnectCalls
      },
      acks,
      lifecycle,

      drop() {
        if (!wsOpen) throw new Error('slack-stub: drop() needs a connected or connecting socket')
        closeSocket()
      },

      async deliver(event) {
        requireConnected('deliver()')
        const envelopeId = `stub-envelope-${++envelopeSeq}`
        const ack = makeAck(envelopeId)
        const body = {
          type: 'event_callback',
          team_id: identity.teamId,
          api_app_id: 'A0STUB0001',
          event,
          event_id: `Ev0STUB${envelopeSeq}`,
          event_time: 1700000000,
        }
        const args: StubSocketEventArgs = {
          ack,
          envelope_id: envelopeId,
          body,
          event,
          retry_num: undefined,
          retry_reason: undefined,
          accepts_response_payload: false,
        }
        const results = emit(event.type, args)
        results.push(...emit('slack_event', { ack, envelope_id: envelopeId, type: 'events_api', body, accepts_response_payload: false }))
        return settle(results)
      },

      async deliverInteractive(payload) {
        requireConnected('deliverInteractive()')
        const envelopeId = `stub-envelope-${++envelopeSeq}`
        const ack = makeAck(envelopeId)
        const args: StubSocketInteractiveArgs = { ack, envelope_id: envelopeId, body: payload, accepts_response_payload: false }
        const results = emit('interactive', args)
        results.push(...emit('slack_event', { ...args, type: 'interactive' }))
        return settle(results)
      },
    }
    return client
  }

  return {
    identity,
    script,
    calls,
    options,
    web: buildWebClient(undefined),
    createWebClient(token = fakeToken(BOT_TOKEN_PREFIX, 'stub'), clientOptions) {
      options.web.push({ token, options: clientOptions })
      return buildWebClient(clientOptions)
    },
    createSocketClient(socketOptions = { appToken: fakeToken(APP_TOKEN_PREFIX, 'stub') }) {
      if (!socketOptions.appToken) {
        throw new Error('Must provide an App-Level Token when initializing a Socket Mode Client')
      }
      options.socket.push(socketOptions)
      const socket = buildSocketClient(socketOptions)
      sockets.push(socket)
      return socket
    },
    sockets,
    get socket() {
      const latest = sockets.at(-1)
      if (latest === undefined) throw new Error('slack-stub: no socket client built yet; call createSocketClient first')
      return latest
    },
  }
}

// ---------------------------------------------------------------------------
// makeStubSlackFactory: the connection manager's client factory
// ---------------------------------------------------------------------------

/** Which client a factory call built: Socket Mode, short-lived validation Web API, or long-lived Web API. */
export type StubClientKind = 'socket' | 'validation' | 'web'

/** A persona's two tokens, as the credentials fixture holds them (`PersonaSlackTokens` fits). */
export interface StubPersonaTokens {
  readonly botToken: string
  readonly appToken: string
}

interface StubClientBuildCommon {
  /** Key of the persona that registered the token, or `undefined` if none did (the build then threw). */
  readonly persona: string | undefined
  /**
   * The token the client received (the app token for a socket client). Not
   * enumerable, so printing a record or comparing records never shows it.
   */
  readonly token: string
  /** Whether the client received exactly `expected`; assert on this so a failure prints no token. */
  hasToken(expected: string): boolean
}

/**
 * One client the factory built, in build order. `options` is the object the
 * factory received, unchanged: a socket build's options hold the app token as
 * `appToken`, so compare them without it (`const { appToken, ...rest } = …`).
 */
export type StubClientBuild =
  | (StubClientBuildCommon & { readonly kind: 'socket'; readonly options: SocketModeOptions })
  | (StubClientBuildCommon & { readonly kind: 'validation'; readonly options: WebClientOptions })
  | (StubClientBuildCommon & { readonly kind: 'web'; readonly options: WebClientOptions })

export interface StubSlackFactory {
  /** Pass to `createPersonaConnectionManager({ factory })`; no cast needed. */
  readonly factory: PersonaSlackClientFactory
  /**
   * Register persona `key` with its tokens and give it its own stub
   * (`makeStubSlack(opts)`): its own identity, script queues, captures and
   * socket clients, shared with no other persona. Throws if the key or
   * either token is already registered.
   */
  addPersona(key: string, tokens: StubPersonaTokens, opts?: StubSlackOptions): StubSlack
  /**
   * Persona `key`'s stub. `socket` is its latest (live) socket client,
   * `sockets` every one built, abandoned ones included. Throws if unknown.
   */
  persona(key: string): StubSlack
  /** Every client built, all personas, in build order. */
  readonly builds: readonly StubClientBuild[]
  /** The clients built for persona `key`, optionally of one kind, in build order. */
  buildsOf<K extends StubClientKind>(key: string, kind: K): Extract<StubClientBuild, { kind: K }>[]
  buildsOf(key: string): StubClientBuild[]
}

/**
 * A `PersonaSlackClientFactory` over per-persona stubs. Each build is routed
 * by the token it received: `createSocketClient` by `options.appToken`,
 * `createValidationClient` and `createWebClient` by the bot token (an app
 * token passed as a bot token matches no persona). The build goes to that
 * persona's stub with the options unchanged, so the stub honours them
 * (`attachOriginalToWebAPIRequestError: false` drops `original`), and is
 * recorded in `builds`. A token no persona registered is recorded with
 * `persona: undefined` and the build throws an error naming no token.
 *
 * Every socket client the manager builds for a persona comes from that
 * persona's stub, so its `script.connect` queue applies across them all.
 */
export function makeStubSlackFactory(): StubSlackFactory {
  const stubs = new Map<string, StubSlack>()
  const byBotToken = new Map<string, string>()
  const byAppToken = new Map<string, string>()
  const builds: StubClientBuild[] = []

  /**
   * Record one build and hand it to the persona the token routes to (the app
   * token for a socket client, the bot token otherwise); throw if none.
   */
  function build<T>(
    kind: StubClientKind,
    token: string,
    options: SocketModeOptions | WebClientOptions,
    make: (stub: StubSlack) => T,
  ): T {
    const persona = (kind === 'socket' ? byAppToken : byBotToken).get(token)
    const entry = { kind, persona, options, hasToken: (expected: string) => expected === token }
    Object.defineProperty(entry, 'token', { value: token, enumerable: false })
    // `kind` and `options` always arrive paired by the factory methods below.
    builds.push(entry as StubClientBuild)
    const stub = persona === undefined ? undefined : stubs.get(persona)
    if (stub === undefined) {
      throw new Error(`slack-stub factory: no persona registered this ${kind === 'socket' ? 'app' : 'bot'} token`)
    }
    return make(stub)
  }

  const factory: PersonaSlackClientFactory = {
    createSocketClient: (options) => build('socket', options.appToken, options, (stub) => stub.createSocketClient(options)),
    createValidationClient: (botToken, options) =>
      build('validation', botToken, options, (stub) => stub.createWebClient(botToken, options)),
    createWebClient: (botToken, options) =>
      // `WebClient` is a class with private members, so no plain object can
      // satisfy it structurally. The stub implements the methods persona code
      // calls; this is the one cast, so test files pass `factory` uncast.
      build('web', botToken, options, (stub) => stub.createWebClient(botToken, options) as unknown as WebClient),
  }

  function buildsOf<K extends StubClientKind>(key: string, kind: K): Extract<StubClientBuild, { kind: K }>[]
  function buildsOf(key: string): StubClientBuild[]
  function buildsOf(key: string, kind?: StubClientKind): StubClientBuild[] {
    return builds.filter((entry) => entry.persona === key && (kind === undefined || entry.kind === kind))
  }

  return {
    factory,
    addPersona(key, tokens, opts = {}) {
      if (stubs.has(key)) throw new Error(`slack-stub factory: persona ${JSON.stringify(key)} is already registered`)
      if (byBotToken.has(tokens.botToken) || byAppToken.has(tokens.appToken)) {
        throw new Error(`slack-stub factory: persona ${JSON.stringify(key)} reuses a token another persona registered`)
      }
      const stub = makeStubSlack(opts)
      stubs.set(key, stub)
      byBotToken.set(tokens.botToken, key)
      byAppToken.set(tokens.appToken, key)
      return stub
    },
    persona(key) {
      const stub = stubs.get(key)
      if (stub === undefined) throw new Error(`slack-stub factory: no persona ${JSON.stringify(key)} registered`)
      return stub
    },
    builds,
    buildsOf,
  }
}

// ---------------------------------------------------------------------------
// Event factories and text builders
// ---------------------------------------------------------------------------

/** A Slack event as delivered over Socket Mode. */
export type SlackEvent = { type: string } & Record<string, unknown>

/** Overrides for an event factory; a key set to `undefined` is removed. */
export type EventOverrides = Readonly<Record<string, unknown>>

/** Default IDs the factories use. Channel IDs start `C`, DM IDs `D`. */
const DEFAULT_CHANNEL = 'C0STUB0001'
const DEFAULT_DM = 'D0STUB0001'
const DEFAULT_USER = 'U0STUBUSR1'
const DEFAULT_TEAM = 'T0STUB0001'
const DEFAULT_BOT_USER = 'U0STUBBOT1'

/** A message `ts`: fixed seconds and a random fraction, so default events are distinct. */
function randomTs(): string {
  const fraction = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000
  return `1700000000.${String(fraction).padStart(6, '0')}`
}

function makeEvent(defaults: SlackEvent, overrides: EventOverrides): SlackEvent {
  const ts = typeof overrides.ts === 'string' ? overrides.ts : randomTs()
  return mergeDroppingUndefined({ ...defaults, ts, event_ts: ts }, overrides)
}

/** `<@U…>`: a user mention as it appears in message text. */
export function mentionText(userId: string): string {
  return `<@${userId}>`
}

/** `<!here>`, `<!channel>` or `<!everyone>`: a broadcast as it appears in message text. */
export function broadcastText(kind: 'here' | 'channel' | 'everyone' = 'here'): string {
  return `<!${kind}>`
}

/** A human's message in a channel (`channel_type` `channel`). */
export function makeChannelMessage(overrides: EventOverrides = {}): SlackEvent {
  return makeEvent(
    { type: 'message', channel: DEFAULT_CHANNEL, channel_type: 'channel', user: DEFAULT_USER, team: DEFAULT_TEAM, text: 'hello from a channel' },
    overrides,
  )
}

/** A human's direct message to the bot (`D…` channel, `channel_type` `im`). */
export function makeDm(overrides: EventOverrides = {}): SlackEvent {
  return makeEvent(
    { type: 'message', channel: DEFAULT_DM, channel_type: 'im', user: DEFAULT_USER, team: DEFAULT_TEAM, text: 'hello from a DM' },
    overrides,
  )
}

/** An app bot's post in a channel: carries `bot_id`, `app_id` and the bot's `user`, no subtype. */
export function makeBotMessage(overrides: EventOverrides = {}): SlackEvent {
  const botId = typeof overrides.bot_id === 'string' ? overrides.bot_id : 'B0STUBBOT2'
  return makeEvent(
    {
      type: 'message',
      channel: DEFAULT_CHANNEL,
      channel_type: 'channel',
      user: 'U0STUBBOT2',
      bot_id: botId,
      app_id: 'A0STUB0002',
      team: DEFAULT_TEAM,
      text: 'hello from a bot',
      bot_profile: { id: botId, app_id: 'A0STUB0002', name: 'stub-bot', team_id: DEFAULT_TEAM },
    },
    overrides,
  )
}

/** An incoming-webhook post: `subtype` `bot_message`, a `bot_id` and `username`, no `user`. */
export function makeWebhookPost(overrides: EventOverrides = {}): SlackEvent {
  return makeEvent(
    {
      type: 'message',
      subtype: 'bot_message',
      channel: DEFAULT_CHANNEL,
      channel_type: 'channel',
      bot_id: 'B0STUBHOOK',
      username: 'stub-webhook',
      text: 'hello from a webhook',
    },
    overrides,
  )
}

/**
 * An `app_mention` event in a channel. The default text mentions a fixed stub
 * bot user; pass `text: `${mentionText(stub.identity.botUserId)} …`` to
 * mention a specific stub's bot.
 */
export function makeAppMention(overrides: EventOverrides = {}): SlackEvent {
  return makeEvent(
    { type: 'app_mention', channel: DEFAULT_CHANNEL, user: DEFAULT_USER, team: DEFAULT_TEAM, text: `${mentionText(DEFAULT_BOT_USER)} hello` },
    overrides,
  )
}
