/**
 * persona-slack-validation.ts — Classify the outcome of validating a
 * persona's Slack tokens (b.av2 SR-3.2).
 *
 * Bring-up validates the bot token with `auth.test` and the app token by
 * opening Socket Mode (`apps.connections.open`, then the WebSocket up to
 * `hello`). Every failure is one of two outcomes:
 *
 * - Slack-unreachable (`persona-slack-unreachable`): anything that is not a
 *   Web API platform error (`ok: false`) — network or request error, HTTP
 *   error (any non-200 status, 429 included), rate-limited error, timeout, no
 *   WebSocket URL, socket closed before `hello`, a socket-mode error, and any
 *   unrecognised value (`undefined`, `null`, strings, plain objects) — plus a
 *   platform error whose Slack error is `internal_error`, `fatal_error`,
 *   `service_unavailable`, `request_timeout` or `ratelimited`, and a platform
 *   error whose `data.error` is missing, not a string, empty or not a short
 *   lower-case identifier (the library builds these itself from a 200 body
 *   that is not JSON: an HTML page, an empty or cut-off body). Retried with
 *   backoff (`persona-retry-schedule.ts`).
 * - Credentials refused (`persona-credentials-refused`): a platform error
 *   carrying any other well-formed Slack error code (`not_authed`,
 *   `invalid_auth`, `token_revoked`, `missing_scope`, …). The persona is
 *   credentials-broken.
 *
 * A running persona's Web API calls are classified too, but only for a
 * revoked bot token (bug b.ujn): `classifyWebApiAuthFailure` maps a platform
 * error whose Slack error is `invalid_auth`, `token_revoked`,
 * `account_inactive` or `not_authed` to credentials refused (the `web-api`
 * check, `bot_token`, naming the method), and everything else to nothing.
 *
 * A connection counts as up only once `auth.test` has returned both the bot
 * user ID and the bot ID (b.av2 SR-3.1); `botIdentityFromAuthTest` maps a
 * result lacking either to Slack-unreachable, never up.
 *
 * Library errors (`@slack/web-api`, `@slack/socket-mode`) are recognised
 * structurally by their `code` string and fields, never by `instanceof`, so an
 * error built by a test stub or by another copy of the library classifies the
 * same way.
 *
 * Secrecy (b.av2 SR-10.3): an outcome never holds the thrown value, its
 * message, stack, body, headers, request config or `original`. The only values
 * copied from an error are the Slack error code (and only when it matches
 * `SLACK_ERROR_CODE_RE`; otherwise nothing is copied and the outcome is
 * Slack-unreachable `unknown`), an HTTP status number and `retryAfter`. Everything else on an outcome — the reason
 * kind, the token key, the check, the class label and the cause text — is
 * built by this module.
 *
 * Pure module (b.av2 SR-13.1): no module-scope state, timers, I/O, logging,
 * network or environment access. The classifier never throws. The connection
 * manager (`persona-connections.ts`) calls it for every attempt.
 *
 * SPDX-License-Identifier: MIT
 */

import { PERSONA_CREDENTIALS_REFUSED, PERSONA_SLACK_UNREACHABLE } from './persona-diagnostics.ts'

// ---------------------------------------------------------------------------
// Checks and token keys
// ---------------------------------------------------------------------------

/**
 * Which validation a failure came from: `auth.test` checks the bot token,
 * `socket-mode` (opening Socket Mode: `apps.connections.open`, then the
 * WebSocket up to `hello`) checks the app token. `web-api` is a Web API call
 * a running persona's long-lived client made (bug b.ujn): it checks the bot
 * token too, and only its auth errors are classified
 * (`classifyWebApiAuthFailure`).
 */
export type SlackValidationCheck = 'auth.test' | 'socket-mode' | 'web-api'

/** A credentials-file key naming one of the persona's two tokens. */
export type PersonaTokenKey = 'bot_token' | 'app_token'

/** The token each check validates. */
export const SLACK_CHECK_TOKEN_KEY: Readonly<Record<SlackValidationCheck, PersonaTokenKey>> = {
  'auth.test': 'bot_token',
  'socket-mode': 'app_token',
  'web-api': 'bot_token',
}

/** How each check is named in a cause (e.g. `the Socket Mode open`). */
export const SLACK_CHECK_DESCRIPTION: Readonly<Record<SlackValidationCheck, string>> = {
  'auth.test': 'auth.test',
  'socket-mode': 'the Socket Mode open',
  'web-api': 'a Web API call',
}

// ---------------------------------------------------------------------------
// Library error codes (matched structurally)
// ---------------------------------------------------------------------------

/** `@slack/web-api` `ErrorCode.RequestError`: network, DNS, request timeout. */
const WEB_API_REQUEST_ERROR = 'slack_webapi_request_error'

/** `@slack/web-api` `ErrorCode.HTTPError`: a non-200 HTTP response; carries `statusCode`. */
const WEB_API_HTTP_ERROR = 'slack_webapi_http_error'

/** `@slack/web-api` `ErrorCode.PlatformError`: an `ok: false` answer; carries `data.error`. */
const WEB_API_PLATFORM_ERROR = 'slack_webapi_platform_error'

/** `@slack/web-api` `ErrorCode.RateLimitedError` (`rejectRateLimitedCalls`); carries `retryAfter` (s). */
const WEB_API_RATE_LIMITED_ERROR = 'slack_webapi_rate_limited_error'

/** Prefix of every `@slack/socket-mode` error code. */
const SOCKET_MODE_CODE_PREFIX = 'slack_socket_mode_'

/**
 * Platform errors that mean Slack is having trouble, not that the token is
 * bad: Slack-unreachable, retried (b.av2 SR-3.2).
 */
export const TRANSIENT_SLACK_PLATFORM_ERRORS: ReadonlySet<string> = new Set([
  'internal_error',
  'fatal_error',
  'service_unavailable',
  'request_timeout',
  'ratelimited',
])

/** A Slack error code that is safe to copy: a short lower-case identifier. */
export const SLACK_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/

/** Placeholder for an absent Slack error code in a cause text. */
export const UNKNOWN_SLACK_ERROR = 'unknown'

/**
 * The Slack errors of a Web API call that mean the bot token no longer works
 * (bug b.ujn): the persona is marked credentials-broken at the first one. Any
 * other Slack error (`missing_scope`, `channel_not_found`, `ratelimited`, …)
 * is the call's own failure and changes nothing.
 */
export const WEB_API_AUTH_FAILURE_ERRORS: ReadonlySet<string> = new Set([
  'invalid_auth',
  'token_revoked',
  'account_inactive',
  'not_authed',
])

/**
 * A Web API method name safe to copy into a cause: a letter, then letters,
 * digits, `_` and `.` (`chat.postMessage`, `filesUploadV2`), up to 64
 * characters.
 */
export const SLACK_METHOD_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/

// ---------------------------------------------------------------------------
// Start timeout marker (b.av2 SR-3.3)
// ---------------------------------------------------------------------------

/** Bound on the WebSocket phase of every Socket Mode `start()`, in milliseconds (b.av2 SR-3.3). */
export const SLACK_START_TIMEOUT_MS = 10_000

/**
 * Bound on a bring-up's `auth.test`, in milliseconds (10 s). The connection
 * manager applies it on its own injected clock, because the validation
 * client's request timeout is a socket idle timer that starts only after the
 * connection is made: a DNS or TCP-connect stall would otherwise hold a
 * bring-up for minutes.
 */
export const SLACK_AUTH_TEST_TIMEOUT_MS = 10_000

/**
 * `code` of the timeout markers (`SlackStartTimeoutError`,
 * `SlackAuthTestTimeoutError`); the classifier maps it to Slack-unreachable
 * (`timeout`) for whichever check it came from. Its value predates the
 * `auth.test` marker and keeps its historical `start` wording.
 */
export const SLACK_TIMEOUT_CODE = 'cscb_slack_start_timeout'

/**
 * Marker for "the WebSocket phase of `start()` was abandoned after
 * `SLACK_START_TIMEOUT_MS`" (b.av2 SR-3.3). The connection manager rejects
 * with it (or any value whose `code` is `SLACK_TIMEOUT_CODE`); the
 * classifier recognises it by that code, not by `instanceof`.
 */
export class SlackStartTimeoutError extends Error {
  readonly code = SLACK_TIMEOUT_CODE

  constructor() {
    super(`Socket Mode start() abandoned after ${SLACK_START_TIMEOUT_MS} ms`)
    this.name = 'SlackStartTimeoutError'
  }
}

/**
 * Marker for "`auth.test` got no answer within `SLACK_AUTH_TEST_TIMEOUT_MS`":
 * the connection manager abandons the call and classifies this marker with
 * the `auth.test` check, which makes the attempt Slack-unreachable
 * (`timeout`), never refused.
 */
export class SlackAuthTestTimeoutError extends Error {
  readonly code = SLACK_TIMEOUT_CODE

  constructor() {
    super(`auth.test abandoned after ${SLACK_AUTH_TEST_TIMEOUT_MS} ms`)
    this.name = 'SlackAuthTestTimeoutError'
  }
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** Why a validation counted as Slack-unreachable. */
export type SlackUnreachableReason =
  /** Web API request error (network, DNS, request timeout) or a socket-mode (WebSocket) error. */
  | 'network'
  /** Web API HTTP error: a non-200 response (429 included); `status` holds the number when valid. */
  | 'http-status'
  /** Web API rate-limited error; `retryAfter` holds its delay when valid. */
  | 'rate-limited'
  /**
   * The call was abandoned at its 10 s bound: the WebSocket phase of `start()`
   * (`SlackStartTimeoutError`) or `auth.test` (`SlackAuthTestTimeoutError`).
   */
  | 'timeout'
  /** A transient platform error (`TRANSIENT_SLACK_PLATFORM_ERRORS`); `slackError` holds it. */
  | 'platform-transient'
  /**
   * An uncoded value whose `name` is exactly `Error`, from the Socket Mode
   * open: `apps.connections.open` returned no URL.
   */
  | 'no-url'
  /** The Socket Mode open rejected with `undefined`: the socket closed before `hello`. */
  | 'socket-closed'
  /** `auth.test` succeeded without both the bot user ID and the bot ID. */
  | 'no-identity'
  /** Anything else, including a platform error without a well-formed Slack error code. */
  | 'unknown'

/** Slack could not be reached; retry with backoff (b.av2 SR-3.2). */
export interface SlackUnreachableOutcome {
  kind: 'slack-unreachable'
  class: typeof PERSONA_SLACK_UNREACHABLE
  check: SlackValidationCheck
  key: PersonaTokenKey
  reason: SlackUnreachableReason
  /** Slack error code, for `platform-transient` only. */
  slackError?: string
  /** HTTP status, for `http-status` only, when the error carried a valid one. */
  status?: number
  /** Seconds Slack asked to wait, when given as a finite non-negative number. */
  retryAfter?: number
  /** Single-line cause for the diagnostic line: key, check and reason; no error text. */
  cause: string
}

/** Slack refused the token: the persona is credentials-broken (b.av2 SR-3.2, SR-6.4). */
export interface SlackCredentialsRefusedOutcome {
  kind: 'credentials-refused'
  class: typeof PERSONA_CREDENTIALS_REFUSED
  check: SlackValidationCheck
  key: PersonaTokenKey
  /** Slack error code (`invalid_auth`, …); always matches `SLACK_ERROR_CODE_RE`. */
  slackError: string
  /**
   * The Web API method whose call was refused, for the `web-api` check only
   * when it matches `SLACK_METHOD_NAME_RE` (e.g. `chat.postMessage`).
   */
  method?: string
  /** Single-line cause for the diagnostic line: key, check (and method) and Slack error code. */
  cause: string
}

/** A failed validation. */
export type SlackValidationFailure = SlackUnreachableOutcome | SlackCredentialsRefusedOutcome

/** The persona's bot identity from `auth.test` (b.av2 SR-3.1). */
export interface SlackBotIdentity {
  /** `auth.test` `user_id`: the bot user's ID. */
  botUserId: string
  /** `auth.test` `bot_id`. */
  botId: string
}

/** `auth.test` returned the bot identity. */
export interface SlackUpOutcome {
  kind: 'up'
  identity: SlackBotIdentity
}

/** Any validation outcome. */
export type SlackValidationOutcome = SlackUpOutcome | SlackValidationFailure

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a value thrown (or rejected) by `check` as Slack-unreachable or
 * credentials refused (b.av2 SR-3.2). Accepts any value, never throws, and
 * copies nothing from it but the Slack error code, the HTTP status and
 * `retryAfter` (see the module comment).
 */
export function classifySlackValidationError(error: unknown, check: SlackValidationCheck): SlackValidationFailure {
  const code = readProp(error, 'code')

  if (code === WEB_API_PLATFORM_ERROR) {
    const data = readProp(error, 'data')
    const rawSlackError = readProp(data, 'error')
    // `@slack/web-api` itself throws a platform error carrying the raw body as
    // `data.error` when a 200 response is not JSON (HTML page, empty or cut-off
    // body), and one with no `data.error` when the body lacks `ok`. Neither is
    // Slack refusing the token: only a well-formed Slack error code can be.
    if (!isSlackErrorCode(rawSlackError)) return unreachable(check, 'unknown')
    if (TRANSIENT_SLACK_PLATFORM_ERRORS.has(rawSlackError)) {
      return unreachable(check, 'platform-transient', { slackError: rawSlackError, retryAfter: slackRetryAfterSeconds(error) })
    }
    return refused(check, rawSlackError)
  }

  if (code === WEB_API_REQUEST_ERROR) return unreachable(check, 'network')
  if (code === WEB_API_HTTP_ERROR) return unreachable(check, 'http-status', { status: validStatus(readProp(error, 'statusCode')) })
  if (code === WEB_API_RATE_LIMITED_ERROR) {
    return unreachable(check, 'rate-limited', { retryAfter: slackRetryAfterSeconds(error) })
  }
  if (code === SLACK_TIMEOUT_CODE) return unreachable(check, 'timeout')
  if (typeof code === 'string' && code.startsWith(SOCKET_MODE_CODE_PREFIX)) return unreachable(check, 'network')

  if (check === 'socket-mode') {
    // socket-mode's start() rejects with the argument of its `disconnected`
    // event, which is emitted with none when the socket closes before `hello`.
    if (error === undefined) return unreachable(check, 'socket-closed')
    // retrieveWSSURL() throws a plain, uncoded Error when the response has no
    // URL. Matched on `name` exactly (never message text), so a `TypeError` or
    // other code-less value falls through to `unknown`.
    if (code === undefined && readProp(error, 'name') === 'Error') return unreachable(check, 'no-url')
  }

  return unreachable(check, 'unknown')
}

/**
 * Classify a value a running persona's Web API call rejected with (bug
 * b.ujn): a refused outcome of the `web-api` check (`bot_token`) when it is a
 * Web API platform error whose Slack error is exactly one of
 * `WEB_API_AUTH_FAILURE_ERRORS`; undefined for anything else (another Slack
 * error, a network, HTTP or rate-limited error, any other value). Recognised
 * structurally, like `classifySlackValidationError`. `method` names the call
 * in the cause when it matches `SLACK_METHOD_NAME_RE`, e.g.
 * `bot_token refused by a Web API call (chat.postMessage): Slack error token_revoked`.
 * Copies nothing from the error but the Slack error code. Never throws.
 */
export function classifyWebApiAuthFailure(error: unknown, method: string | undefined): SlackCredentialsRefusedOutcome | undefined {
  if (readProp(error, 'code') !== WEB_API_PLATFORM_ERROR) return undefined
  const slackError = readProp(readProp(error, 'data'), 'error')
  if (typeof slackError !== 'string' || !WEB_API_AUTH_FAILURE_ERRORS.has(slackError)) return undefined
  return refused('web-api', slackError, method !== undefined && SLACK_METHOD_NAME_RE.test(method) ? method : undefined)
}

/**
 * Turn a successful `auth.test` result into the persona's bot identity
 * (b.av2 SR-3.1): `user_id` and `bot_id`, each a non-empty string. A result
 * lacking either is a failed check; not being a platform error, it is
 * Slack-unreachable (`no-identity`), never up. The IDs are copied only on
 * success.
 */
export function botIdentityFromAuthTest(result: unknown): SlackUpOutcome | SlackUnreachableOutcome {
  const botUserId = readProp(result, 'user_id')
  const botId = readProp(result, 'bot_id')
  if (typeof botUserId === 'string' && botUserId !== '' && typeof botId === 'string' && botId !== '') {
    return { kind: 'up', identity: { botUserId, botId } }
  }
  return unreachable('auth.test', 'no-identity')
}

// ---------------------------------------------------------------------------
// Outcome builders
// ---------------------------------------------------------------------------

/** Describe an unreachable reason for a cause, from the outcome's own fields only. */
function describeReason(
  check: SlackValidationCheck,
  reason: SlackUnreachableReason,
  fields: { slackError?: string; status?: number },
): string {
  switch (reason) {
    case 'network': return 'network or request error'
    case 'http-status': return fields.status === undefined ? 'HTTP error' : `HTTP status ${fields.status}`
    case 'rate-limited': return 'rate limited'
    case 'timeout':
      return check === 'auth.test'
        ? `no answer within ${SLACK_AUTH_TEST_TIMEOUT_MS / 1000} s`
        : `WebSocket phase timed out after ${SLACK_START_TIMEOUT_MS / 1000} s`
    case 'platform-transient': return `Slack error ${fields.slackError ?? UNKNOWN_SLACK_ERROR}`
    case 'no-url': return 'no WebSocket URL returned'
    case 'socket-closed': return 'socket closed before hello'
    case 'no-identity': return 'no bot user ID or bot ID returned'
    case 'unknown': return 'unrecognised failure'
  }
}

function unreachable(
  check: SlackValidationCheck,
  reason: SlackUnreachableReason,
  fields: { slackError?: string; status?: number; retryAfter?: number } = {},
): SlackUnreachableOutcome {
  const key = SLACK_CHECK_TOKEN_KEY[check]
  const wait = fields.retryAfter === undefined ? '' : `, retry after ${fields.retryAfter} s`
  const outcome: SlackUnreachableOutcome = {
    kind: 'slack-unreachable',
    class: PERSONA_SLACK_UNREACHABLE,
    check,
    key,
    reason,
    cause: `Slack unreachable checking ${key} via ${SLACK_CHECK_DESCRIPTION[check]}: ${describeReason(check, reason, fields)}${wait}`,
  }
  if (fields.slackError !== undefined) outcome.slackError = fields.slackError
  if (fields.status !== undefined) outcome.status = fields.status
  if (fields.retryAfter !== undefined) outcome.retryAfter = fields.retryAfter
  return outcome
}

function refused(check: SlackValidationCheck, slackError: string, method?: string): SlackCredentialsRefusedOutcome {
  const key = SLACK_CHECK_TOKEN_KEY[check]
  const via = method === undefined ? '' : ` (${method})`
  const outcome: SlackCredentialsRefusedOutcome = {
    kind: 'credentials-refused',
    class: PERSONA_CREDENTIALS_REFUSED,
    check,
    key,
    slackError,
    cause: `${key} refused by ${SLACK_CHECK_DESCRIPTION[check]}${via}: Slack error ${slackError}`,
  }
  if (method !== undefined) outcome.method = method
  return outcome
}

// ---------------------------------------------------------------------------
// Field readers (copy nothing unvalidated)
// ---------------------------------------------------------------------------

/**
 * Read `obj[prop]` when `obj` is an object or function, else `undefined`.
 * A throwing getter or proxy trap reads as `undefined`, so classification
 * never throws.
 */
function readProp(obj: unknown, prop: string): unknown {
  if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null) return undefined
  try {
    return (obj as Record<string, unknown>)[prop]
  } catch {
    return undefined
  }
}

/** Whether a value is a Slack error code safe to copy: a short lower-case identifier. */
function isSlackErrorCode(value: unknown): value is string {
  return typeof value === 'string' && SLACK_ERROR_CODE_RE.test(value)
}

/**
 * The `retryAfter` (seconds) a rejected Slack Web API call carries: the
 * library's rate-limited error, or a platform error whose Slack error is
 * `ratelimited`; `undefined` for any other value or when it is not a finite
 * non-negative number. Copies nothing else. Never throws.
 */
export function slackRetryAfterSeconds(error: unknown): number | undefined {
  const code = readProp(error, 'code')
  if (code === WEB_API_RATE_LIMITED_ERROR) return validRetryAfter(readProp(error, 'retryAfter'))
  if (code !== WEB_API_PLATFORM_ERROR) return undefined
  const data = readProp(error, 'data')
  if (readProp(data, 'error') !== 'ratelimited') return undefined
  return validRetryAfter(readProp(readProp(data, 'response_metadata'), 'retryAfter'))
}

/** `retryAfter` (seconds) when it is a finite non-negative number, else `undefined`. */
function validRetryAfter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** An HTTP status when it is an integer in 100–599, else `undefined`. */
function validStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}
