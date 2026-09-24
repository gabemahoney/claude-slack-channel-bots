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
 * - Socket Mode: `autoReconnectEnabled: false`, and `clientOptions` of
 *   `retryConfig {retries: 0}`, `timeout: 10000`, `rejectRateLimitedCalls:
 *   true`, `attachOriginalToWebAPIRequestError: false`.
 * - Validation: the same four Web API options.
 * - Long-lived Web API: `timeout: 30000` and
 *   `attachOriginalToWebAPIRequestError: false` only. `retryConfig` and
 *   `rejectRateLimitedCalls` stay unset, so the library's default retry
 *   policy (about ten retries over about 30 minutes) and its rate-limit
 *   handling stay as the server has them today.
 *
 * Each builder returns a fresh object, so no option object is shared between
 * clients or personas (the libraries keep a reference to what they are
 * given).
 *
 * The production factory (`PRODUCTION_SLACK_CLIENT_FACTORY`) is the only place
 * a token is handed to a Slack library. It forwards the token and options it
 * receives to `SocketModeClient` / `WebClient` exactly as given: no option is
 * added, dropped or changed.
 *
 * Pure module (b.av2 SR-13.1): nothing is constructed, read or scheduled at
 * import; no environment access, no file access, no logging.
 *
 * SPDX-License-Identifier: MIT
 */

import { SocketModeClient, type SocketModeOptions } from '@slack/socket-mode'
import { WebClient, type WebClientOptions } from '@slack/web-api'

import { SLACK_START_TIMEOUT_MS } from './persona-slack-validation.ts'

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
// Option sets (b.av2 SR-3.3)
// ---------------------------------------------------------------------------

/**
 * The Web API options of the Socket Mode client's own HTTP client and of the
 * validation client: no retries, a 10 s timeout, rate limits rejected, no
 * `original` on errors. A fresh object per call.
 */
export function validationWebClientOptions(): WebClientOptions {
  return {
    retryConfig: { retries: 0 },
    timeout: PERSONA_VALIDATION_REQUEST_TIMEOUT_MS,
    rejectRateLimitedCalls: true,
    attachOriginalToWebAPIRequestError: false,
  }
}

/**
 * The options of a persona's Socket Mode client: library auto-reconnect off,
 * and `validationWebClientOptions()` for its `apps.connections.open` calls.
 * A fresh object per call.
 */
export function socketModeClientOptions(appToken: string): SocketModeOptions {
  return {
    appToken,
    autoReconnectEnabled: false,
    clientOptions: validationWebClientOptions(),
  }
}

/**
 * The options of a persona's long-lived Web API client: a 30 s per-attempt
 * timeout and no `original` on errors. `retryConfig` and
 * `rejectRateLimitedCalls` are deliberately unset (the library's default
 * retry policy and rate-limit handling apply). A fresh object per call.
 */
export function longLivedWebClientOptions(): WebClientOptions {
  return {
    timeout: PERSONA_WEB_API_REQUEST_TIMEOUT_MS,
    attachOriginalToWebAPIRequestError: false,
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
