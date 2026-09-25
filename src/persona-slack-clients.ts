/**
 * persona-slack-clients.ts — The Slack client factory and the exact client
 * options for persona connections (b.av2 SR-3.3, SR-13.1).
 *
 * Each persona gets three kinds of Slack client, all built through a
 * `PersonaSlackClientFactory` that the connection manager
 * (`persona-connections.ts`) takes as an injected dependency:
 *
 * - its long-lived Socket Mode client, built from the app token;
 * - a short-lived validation Web API client, built from the bot token and
 *   used only for `auth.test`;
 * - its long-lived Web API client, built from the bot token, which every
 *   posting path uses.
 *
 * The library defaults defeat the design: `@slack/socket-mode` 2.0.6
 * reconnects on its own and retries `apps.connections.open` up to 100 times,
 * and `@slack/web-api` 7.15.0 has no timeout, waits out rate limits and
 * attaches the raw request error (Authorization header included) to its
 * errors as `original`. The option builders below fix every one of those, and
 * the manager passes their result to the factory unchanged:
 *
 * - Socket Mode: `autoReconnectEnabled: false`, `clientOptions` of
 *   `retryConfig {retries: 0}`, `timeout: 10000`, `rejectRateLimitedCalls:
 *   true`, `attachOriginalToWebAPIRequestError: false`, and a `logger` of its
 *   own (`socketModeSlackLogger`) that drops every library line except a
 *   fixed allowlist of connection-health lines, which it writes to the server
 *   log with the persona reference. The library's console logger would print
 *   error text holding the WebSocket URL and its connection ticket.
 * - Validation: the same four Web API options, and a redacting `logger`
 *   (`redactingSlackLogger`).
 * - Long-lived Web API: `timeout: 30000`,
 *   `attachOriginalToWebAPIRequestError: false` and a redacting `logger`.
 *   `retryConfig` and `rejectRateLimitedCalls` stay unset, so the library's
 *   default retry policy (about ten retries over about 30 minutes) and its
 *   rate-limit handling stay as the server has them today.
 *
 * The Web API clients' lines still reach the console as the library's own
 * logger writes them, but URL-like and token-like text is replaced first. At
 * its default level the library prints Slack's response warnings, the
 * rate-limit wait and a failed request's error message ("http request
 * failed <message>"). That message is not safe as it stands: on a 429 it
 * holds the request URL, which for `filesUploadV2` is Slack's short-lived
 * upload URL, a bearer like the Socket Mode ticket. The token itself travels
 * only in the Authorization header, and today axios runs its `http` adapter
 * under Bun, whose header check names the header, not its value; Bun's
 * `fetch` `Headers` check does echo the value, so the redaction does not rely
 * on which adapter runs or how its errors are worded.

 * Each builder returns a fresh object, so no option object is shared between
 * clients or personas (the libraries keep a reference to what they are
 * given).
 *
 * The production factory (`PRODUCTION_SLACK_CLIENT_FACTORY`) is the only place
 * a token is handed to a Slack library. It forwards the token and options it
 * receives to `SocketModeClient` / `WebClient` exactly as given: no option is
 * added, dropped or changed.
 *
 * Slack API base URL override (integration suite only): when
 * `CSCB_SLACK_API_URL` holds an `http:` URL on the literal loopback address
 * `127.0.0.1` or `[::1]` (`loopbackSlackApiUrl`), the server passes it to the
 * connection manager, and every builder above adds it as `slackApiUrl`: the
 * validation client, the long-lived Web API client and the Socket Mode
 * client's own `clientOptions` (so `apps.connections.open` goes there, and
 * the WebSocket URL it returns is used as given). It exists so the docker
 * suite can point the server at its Slack stub. It must never be set on an
 * operator's host, and shipped docs do not describe it. The persona tokens
 * go only to whatever listens on that loopback port, which is trusted with
 * them. Any other value is ignored with one warning. The start line names
 * only the URL's origin. Unset (the builders get no URL), every option set
 * is exactly as above.
 *
 * Pure module (b.av2 SR-13.1): nothing is constructed, read or scheduled at
 * import; no file access, and the environment is read only through the `env`
 * passed to `resolveSlackApiUrlOverride` when it is called. Nothing logs at
 * import: the library loggers built here write only when a client calls them.
 *
 * SPDX-License-Identifier: MIT
 */

import { inspect } from 'node:util'

import { LogLevel, SocketModeClient, type Logger, type SocketModeOptions } from '@slack/socket-mode'
import { WebClient, type WebClientOptions } from '@slack/web-api'

import type { Persona } from './config.ts'
import { renderPersonaRef } from './persona-identity.ts'
import { SLACK_START_TIMEOUT_MS } from './persona-slack-validation.ts'
import { REDACTED_TOKEN_PLACEHOLDER, REDACTED_URL_PLACEHOLDER, redactSlackLogText } from './slack-log-redaction.ts'

// ---------------------------------------------------------------------------
// Timing constants (b.av2 SR-3.3)
// ---------------------------------------------------------------------------

/** Bound on the WebSocket phase of every Socket Mode `start()`, in milliseconds (10 s). */
export const PERSONA_START_TIMEOUT_MS = SLACK_START_TIMEOUT_MS

/**
 * Per-request timeout of the Socket Mode client's `apps.connections.open`
 * call and of the validation client's `auth.test`, in milliseconds (10 s).
 */
export const PERSONA_VALIDATION_REQUEST_TIMEOUT_MS = 10_000

/** Per-attempt request timeout of a long-lived persona Web API client, in milliseconds (30 s). */
export const PERSONA_WEB_API_REQUEST_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Slack API base URL override (integration suite only)
// ---------------------------------------------------------------------------

/** The environment variable holding the integration suite's Slack API base URL. */
export const SLACK_API_URL_OVERRIDE_ENV = 'CSCB_SLACK_API_URL'

/**
 * The hostnames (as `URL.hostname` renders them) an override may name: the
 * literal loopback addresses only. No name (`localhost` included) is accepted,
 * so nothing is resolved by name.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]'])

/**
 * `value` as a Slack API base URL override, or `undefined` when it is not
 * one. Accepted: an `http:` URL whose host is `127.0.0.1` or `[::1]` (or a
 * form the URL parser normalises to one of them), any port, any path, with no
 * user info, query or fragment. `localhost` is not accepted. The result is
 * the parsed URL's `href`.
 */
export function loopbackSlackApiUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(url.hostname)) return undefined
  if (url.username !== '' || url.password !== '') return undefined
  if (url.href.includes('?') || url.href.includes('#')) return undefined
  return url.href
}

/**
 * Read `CSCB_SLACK_API_URL` from `env` and return the base URL every
 * persona's Slack clients use, or `undefined` for the library default. Unset
 * or empty: `undefined`, nothing logged. A loopback URL
 * (`loopbackSlackApiUrl`): that URL, with only its origin logged once
 * through `log`. Any other value: `undefined`, with one warning through `log`
 * that never echoes the value. Call it once per server start.
 */
export function resolveSlackApiUrlOverride(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): string | undefined {
  const value = env[SLACK_API_URL_OVERRIDE_ENV]
  if (value === undefined || value === '') return undefined
  const url = loopbackSlackApiUrl(value)
  if (url === undefined) {
    log(
      `[slack] Warning: ${SLACK_API_URL_OVERRIDE_ENV} ignored: not a loopback http URL ` +
        `(http://127.0.0.1 or http://[::1]); Slack calls use the default Slack API`,
    )
    return undefined
  }
  log(`[slack] Slack API base URL override in use: ${new URL(url).origin} (${SLACK_API_URL_OVERRIDE_ENV})`)
  return url
}

/** `{ slackApiUrl }` when an override is given, else an empty object (no key). */
function slackApiUrlOption(slackApiUrl: string | undefined): WebClientOptions {
  return slackApiUrl === undefined ? {} : { slackApiUrl }
}

// ---------------------------------------------------------------------------
// Option sets (b.av2 SR-3.3)
// ---------------------------------------------------------------------------

/**
 * The request limits of the Socket Mode client's own HTTP client and of the
 * validation client: no retries, a 10 s timeout, rate limits rejected, no
 * `original` on errors, and `slackApiUrl` only when an override is given. A
 * fresh object per call.
 */
function validationRequestLimits(slackApiUrl?: string): WebClientOptions {
  return {
    retryConfig: { retries: 0 },
    timeout: PERSONA_VALIDATION_REQUEST_TIMEOUT_MS,
    rejectRateLimitedCalls: true,
    attachOriginalToWebAPIRequestError: false,
    ...slackApiUrlOption(slackApiUrl),
  }
}

/**
 * The options of the validation client: the validation request limits and a
 * redacting logger (`redactingSlackLogger`), plus `slackApiUrl` only when an
 * override is given. The Socket Mode client's own HTTP client takes the
 * limits without this logger: it gets the socket's logger from the library.
 * A fresh object per call.
 */
export function validationWebClientOptions(slackApiUrl?: string): WebClientOptions {
  return { ...validationRequestLimits(slackApiUrl), logger: redactingSlackLogger() }
}

// ---------------------------------------------------------------------------
// Library loggers
// ---------------------------------------------------------------------------

/** The persona a Socket Mode client's forwarded lines name. */
export type SlackLogPersona = Pick<Persona, 'index' | 'name' | 'key'>

/** Receives each forwarded library line, as one server-log line. */
export type SlackLibraryLineSink = (line: string) => void

/** Severity of each level, as the library's console logger ranks them. */
const LOG_SEVERITY: Record<LogLevel, number> = {
  [LogLevel.ERROR]: 400,
  [LogLevel.WARN]: 300,
  [LogLevel.INFO]: 200,
  [LogLevel.DEBUG]: 100,
}

/** Whether a line at `line` is written by a logger set to `threshold`. */
function isWritten(line: LogLevel, threshold: LogLevel): boolean {
  return LOG_SEVERITY[line] >= LOG_SEVERITY[threshold]
}

/** One allowlisted Socket Mode library line: its level, its exact text and what is forwarded. */
interface SocketHealthLine {
  readonly level: LogLevel
  /** Anchored: the whole line must match. */
  readonly pattern: RegExp
  /** The text forwarded for a matching line. */
  readonly forward: (line: string) => string
}

/**
 * The Socket Mode library lines forwarded to the server log
 * (`@slack/socket-mode` 2.0.6, `SlackWebSocket.js`), each passed by the
 * library as its only argument:
 * - warn `A ping wasn't received from the server before the timeout of <n>ms!`
 *   (no ping from Slack in time; the library then disconnects);
 * - warn `A pong wasn't received from the server before the timeout of <n>ms!`
 *   (Slack did not answer the client's pings; the library then disconnects);
 * - error `Failed to send ping to Slack (error: <error>)`: forwarded as
 *   `Failed to send ping to Slack` only, since the error text is the
 *   runtime's and is not checked.
 * The two timeout lines are fixed text but for the number, so they are
 * forwarded as they are.
 */
const SOCKET_HEALTH_LINES: readonly SocketHealthLine[] = [
  {
    level: LogLevel.WARN,
    pattern: /^A (?:ping|pong) wasn't received from the server before the timeout of \d+ms!$/,
    forward: line => line,
  },
  {
    level: LogLevel.ERROR,
    pattern: /^Failed to send ping to Slack \(error: [\s\S]*\)$/,
    forward: () => 'Failed to send ping to Slack',
  },
]

/** The text to forward for a library line at `level`, or `undefined` when it is not allowlisted. */
function socketHealthText(level: LogLevel, msg: readonly unknown[]): string | undefined {
  const [line] = msg
  if (msg.length !== 1 || typeof line !== 'string') return undefined
  const entry = SOCKET_HEALTH_LINES.find(candidate => candidate.level === level && candidate.pattern.test(line))
  return entry?.forward(line)
}

/**
 * The library logger of one persona's Socket Mode client. It drops every
 * line except the connection-health lines of `SOCKET_HEALTH_LINES`, which it
 * hands to `log` as
 * `[slack] persona Socket Mode: personas[<i>] "<name>" (key=<key>): <text>`,
 * so a connection that was up and then dropped keeps the library's reason
 * beside CSCB's own `persona-connection-lost` line.
 *
 * Everything else is dropped because the library's error text is not safe to
 * log: under Bun, a failed WebSocket handshake's error text holds the
 * WebSocket URL `apps.connections.open` returned, connection ticket included
 * (`SlackWebSocket.js` "WebSocket error occurred", `SocketModeClient.js`
 * "WebSocket error!"), and "Failed to retrieve a new WSS URL" prints
 * whatever message the Web API error carries. The server logs connection
 * failures itself, token-safely (`describeThrownValue`). The socket client
 * hands this logger to its own `apps.connections.open` client and its
 * WebSocket too, so their lines are dropped as well.
 *
 * `setLevel` and `getLevel` keep the level the library reads (default INFO),
 * and a forwarded line is written only at or above it. A throwing `log` is
 * caught: the library calls the logger from its own timers. A fresh object
 * per call.
 */
export function socketModeSlackLogger(persona: SlackLogPersona, log: SlackLibraryLineSink): Logger {
  let level: LogLevel = LogLevel.INFO
  const prefix = `[slack] persona Socket Mode: personas[${persona.index}] ${renderPersonaRef(persona.name, persona.key)}: `
  const at = (lineLevel: LogLevel) => (...msg: unknown[]): void => {
    if (!isWritten(lineLevel, level)) return
    const text = socketHealthText(lineLevel, msg)
    if (text === undefined) return
    try {
      log(`${prefix}${text}`)
    } catch {
      /* a failing sink must not throw into the library */
    }
  }
  return {
    debug: at(LogLevel.DEBUG),
    info: at(LogLevel.INFO),
    warn: at(LogLevel.WARN),
    error: at(LogLevel.ERROR),
    setLevel: (next: LogLevel): void => {
      level = next
    },
    getLevel: (): LogLevel => level,
    setName: (): void => {},
  }
}

// The redactor and its placeholders live in the import-free
// `slack-log-redaction.ts` (the permission trail uses them too) and are
// re-exported here.
export { REDACTED_TOKEN_PLACEHOLDER, REDACTED_URL_PLACEHOLDER, redactSlackLogText }

/** The console label the library's console logger writes before each line, per level. */
const CONSOLE_LABELS: Record<LogLevel, string> = {
  [LogLevel.ERROR]: '[ERROR] ',
  [LogLevel.WARN]: '[WARN] ',
  [LogLevel.INFO]: '[INFO] ',
  [LogLevel.DEBUG]: '[DEBUG] ',
}

/** The name a redacting logger writes on each line until the library sets one. */
const REDACTING_LOGGER_DEFAULT_NAME = 'web-api:WebClient'

/**
 * The library logger of a persona's Web API client (validation and
 * long-lived). It writes to the console as the library's own console logger
 * does (`console.<level>(label, name, ...args)`, same labels, same level
 * rule, default INFO) but redacts every argument first: a string through
 * `redactSlackLogText`, any other value through the same after
 * `util.inspect` (so no object reaches the console unredacted). A fresh
 * object per call.
 */
export function redactingSlackLogger(): Logger {
  let level: LogLevel = LogLevel.INFO
  let name = REDACTING_LOGGER_DEFAULT_NAME
  const at = (lineLevel: LogLevel) => (...msg: unknown[]): void => {
    if (!isWritten(lineLevel, level)) return
    const redacted = msg.map(arg => redactSlackLogText(typeof arg === 'string' ? arg : inspect(arg)))
    console[lineLevel](CONSOLE_LABELS[lineLevel], name, ...redacted)
  }
  return {
    debug: at(LogLevel.DEBUG),
    info: at(LogLevel.INFO),
    warn: at(LogLevel.WARN),
    error: at(LogLevel.ERROR),
    setLevel: (next: LogLevel): void => {
      level = next
    },
    getLevel: (): LogLevel => level,
    setName: (next: string): void => {
      name = next
    },
  }
}

/**
 * The options of a persona's Socket Mode client: library auto-reconnect off,
 * the validation request limits for its `apps.connections.open` calls, and a
 * logger of its own, `socketModeSlackLogger(persona, log)`, in place of the
 * library's console logger. With an override given, `clientOptions` also
 * carries `slackApiUrl`, so `apps.connections.open` goes there. A fresh
 * object per call.
 */
export function socketModeClientOptions(
  appToken: string,
  persona: SlackLogPersona,
  log: SlackLibraryLineSink,
  slackApiUrl?: string,
): SocketModeOptions {
  return {
    appToken,
    autoReconnectEnabled: false,
    clientOptions: validationRequestLimits(slackApiUrl),
    logger: socketModeSlackLogger(persona, log),
  }
}

/**
 * The options of a persona's long-lived Web API client: a 30 s per-attempt
 * timeout, no `original` on errors and a redacting logger
 * (`redactingSlackLogger`), plus `slackApiUrl` only when an override is
 * given. `retryConfig` and `rejectRateLimitedCalls` are deliberately unset
 * (the library's default retry policy and rate-limit handling apply). A fresh
 * object per call.
 */
export function longLivedWebClientOptions(slackApiUrl?: string): WebClientOptions {
  return {
    timeout: PERSONA_WEB_API_REQUEST_TIMEOUT_MS,
    attachOriginalToWebAPIRequestError: false,
    logger: redactingSlackLogger(),
    ...slackApiUrlOption(slackApiUrl),
  }
}

// ---------------------------------------------------------------------------
// Client surfaces
// ---------------------------------------------------------------------------

/** A Socket Mode event listener. Arguments vary per event, as in the library's own typing. */
export type PersonaSocketListener = (...args: any[]) => unknown

/**
 * The part of a Socket Mode client the connection manager uses: event
 * subscription and removal, `start()` and `disconnect()`. `SocketModeClient`
 * satisfies it, and so does the test stub's socket client.
 */
export interface PersonaSocketClient {
  on(event: string, listener: PersonaSocketListener): unknown
  removeListener(event: string, listener: PersonaSocketListener): unknown
  start(): Promise<unknown>
  disconnect(): Promise<void>
}

/**
 * The part of a Web API client the validation step uses: `auth.test` only.
 * `WebClient` satisfies it, and so does the test stub's Web API client.
 */
export interface PersonaValidationClient {
  auth: { test(): Promise<unknown> }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds a persona's Slack clients. Each constructor receives the token and
 * the complete option set for its client kind (the builders above) and must
 * pass them to the client unchanged.
 */
export interface PersonaSlackClientFactory {
  /** The long-lived Socket Mode client; the app token is `options.appToken`. */
  createSocketClient(options: SocketModeOptions): PersonaSocketClient
  /** The short-lived validation client, used only for `auth.test`. */
  createValidationClient(botToken: string, options: WebClientOptions): PersonaValidationClient
  /** The long-lived Web API client every posting path uses. */
  createWebClient(botToken: string, options: WebClientOptions): WebClient
}

/**
 * The real factory: `new SocketModeClient(options)` and
 * `new WebClient(token, options)`, with exactly the token and options given.
 * A plain value; nothing is constructed until a method is called.
 */
export const PRODUCTION_SLACK_CLIENT_FACTORY: PersonaSlackClientFactory = {
  createSocketClient: options => new SocketModeClient(options),
  createValidationClient: (botToken, options) => new WebClient(botToken, options),
  createWebClient: (botToken, options) => new WebClient(botToken, options),
}
