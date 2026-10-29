/**
 * thread-memory.ts — Thread Memory's home. For now it holds the bounded,
 * revocable metadata call its lookups use, and their retry spacing.
 *
 * Every lookup attempt (`conversations.replies`, `conversations.history`)
 * runs under one end-to-end deadline (`THREAD_MEMORY_LOOKUP_DEADLINE_MS`). Its
 * abort signal reaches the queued and in-flight HTTP work through the
 * connection manager's metadata client (`metadataWebClientOptions`: no SDK
 * retries, rate limits rejected, request interceptor bound to the signal, and
 * no SDK HTTP timeout), so the deadline is the only clock: a hung request
 * fails as `deadline` at the deadline, and an expired attempt leaves no SDK
 * request behind while a fresh one starts. A late fulfillment or rejection is
 * consumed without effect.
 *
 * An attempt belongs to its persona, its authenticated connection and the
 * evidence it serves: `MetadataAttempts.run` re-checks the caller's `current`
 * guard after the await, and `revoke`/`stop` abort every attempt of a persona
 * (or all). A revoked, superseded or post-shutdown result is `cancelled` and
 * can change nothing.
 *
 * Failures are classified apart: an expired deadline, a transient failure
 * of the dependency (with any Retry-After), a request Slack rejected for a
 * reason specific to it, a missing capability, refused credentials, lost
 * access, a not-found answer, malformed data and cancellation. None of them
 * is a deleted root, a negative authorship or a recovery; deciding that is the
 * callers' job, from a successful response only.
 *
 * SPDX-License-Identifier: MIT
 */

import { THREAD_MEMORY_LOOKUP_DEADLINE_MS, THREAD_MEMORY_RETRY_MAX_MS, THREAD_MEMORY_RETRY_MIN_MS } from './delivery-constants.ts'
import type { PersonaConnectionClock } from './persona-connections.ts'
import { SLACK_ERROR_CODE_RE, WEB_API_AUTH_FAILURE_ERRORS, slackRetryAfterSeconds } from './persona-slack-validation.ts'

/** The metadata methods Thread Memory's lookups may call; nothing else. */
export const THREAD_MEMORY_LOOKUP_METHODS = ['conversations.replies', 'conversations.history'] as const
export type ThreadMemoryLookupMethod = typeof THREAD_MEMORY_LOOKUP_METHODS[number]

export const METADATA_DEADLINE_CODE = 'thread-memory-lookup-deadline'

export class MetadataDeadlineError extends Error {
  readonly code = METADATA_DEADLINE_CODE
  constructor() { super('Thread Memory lookup request deadline expired.') }
}
export class MetadataCancelledError extends Error {
  constructor() { super('Thread Memory lookup request was superseded or cancelled.') }
}

/** Slack errors that mean the token lacks the method, scope or permission. */
export const METADATA_CAPABILITY_ERRORS: ReadonlySet<string> = new Set([
  'missing_scope', 'not_allowed_token_type', 'no_permission', 'access_denied', 'method_deprecated',
  'ekm_access_denied', 'team_access_not_granted', 'not_authorized', 'restricted_action',
])
/** Slack errors that mean the persona cannot see the conversation any more. */
export const METADATA_ACCESS_ERRORS: ReadonlySet<string> = new Set(['channel_not_found', 'not_in_channel', 'is_archived'])
/** Slack errors that mean the named message or thread does not exist (or no longer does). */
export const METADATA_NOT_FOUND_ERRORS: ReadonlySet<string> = new Set(['thread_not_found', 'message_not_found'])
/** Slack errors that mean Slack itself is failing or limiting: the dependency is down, not this item. */
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout', 'ratelimited'])

/** Why one attempt produced no usable response. */
export type MetadataFailure =
  | { kind: 'deadline' }
  | { kind: 'cancelled' }
  /** The dependency looks down: a server or rate-limit error, or a transport failure. */
  | { kind: 'transient'; retryAfter?: number }
  /** Slack refused this one request for a reason not known to mean it is down (an unrecognised error, an HTTP 4xx). */
  | { kind: 'rejected'; slackError?: string }
  | { kind: 'capability'; slackError: string }
  | { kind: 'credentials'; slackError: string }
  | { kind: 'access-lost'; slackError: string }
  | { kind: 'not-found'; slackError: string }
  | { kind: 'malformed' }
export type MetadataResult = { kind: 'ok'; value: unknown } | MetadataFailure

const read = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined

/**
 * Classify a value a metadata attempt rejected with. Copies only a safe
 * Slack error code and Retry-After. Only a server, rate-limit or transport
 * failure is `transient`; an unrecognised Slack error or an HTTP 4xx is
 * `rejected`, specific to that request. Either leaves the evidence
 * unresolved and retried. Never throws.
 */
export function classifyMetadataFailure(error: unknown): MetadataFailure {
  if (error instanceof MetadataCancelledError) return { kind: 'cancelled' }
  const code = read(error, 'code')
  if (code === METADATA_DEADLINE_CODE) return { kind: 'deadline' }
  if (code === 'slack_webapi_platform_error') {
    const slackError = read(read(error, 'data'), 'error')
    if (typeof slackError !== 'string' || !SLACK_ERROR_CODE_RE.test(slackError)) return { kind: 'malformed' }
    if (WEB_API_AUTH_FAILURE_ERRORS.has(slackError)) return { kind: 'credentials', slackError }
    if (METADATA_CAPABILITY_ERRORS.has(slackError)) return { kind: 'capability', slackError }
    if (METADATA_ACCESS_ERRORS.has(slackError)) return { kind: 'access-lost', slackError }
    if (METADATA_NOT_FOUND_ERRORS.has(slackError)) return { kind: 'not-found', slackError }
    if (!TRANSIENT_ERRORS.has(slackError)) return { kind: 'rejected', slackError }
    const retryAfter = slackRetryAfterSeconds(error)
    return { kind: 'transient', ...(retryAfter !== undefined ? { retryAfter } : {}) }
  }
  if (code === 'slack_webapi_http_error') {
    const status = read(error, 'statusCode')
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) return { kind: 'rejected' }
  }
  const retryAfter = slackRetryAfterSeconds(error)
  return { kind: 'transient', ...(retryAfter !== undefined ? { retryAfter } : {}) }
}

/**
 * Run one metadata request under the end-to-end deadline. Aborting `parent`
 * or reaching the deadline aborts the request's own signal and rejects with
 * `MetadataCancelledError` / `MetadataDeadlineError`; a late settlement of
 * the request is consumed.
 */
export function boundedMetadataCall<T>(
  clock: PersonaConnectionClock, parent: AbortSignal, operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = THREAD_MEMORY_LOOKUP_DEADLINE_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    let timer: unknown
    const finish = (success: boolean, value: unknown) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clock.clearTimeout(timer)
      parent.removeEventListener('abort', cancel)
      controller.abort()
      if (success) resolve(value as T)
      else reject(value)
    }
    const cancel = () => finish(false, new MetadataCancelledError())
    parent.addEventListener('abort', cancel, { once: true })
    if (parent.aborted) { cancel(); return }
    timer = clock.setTimeout(() => finish(false, new MetadataDeadlineError()), Math.max(0, timeoutMs))
    try { Promise.resolve(operation(controller.signal)).then(value => finish(true, value), error => finish(false, error)) }
    catch (error) { finish(false, error) }
  })
}

/**
 * The wait before the next attempt after `failures` consecutive failures
 * (1 for the first): bounded exponential from the positive minimum to the
 * local maximum, or a greater Retry-After, which is always honored.
 */
export function metadataRetryDelay(failures: number, retryAfterSeconds?: number): number {
  const exponent = Math.max(0, Math.min(Math.floor(failures) - 1, 20))
  const local = Math.min(THREAD_MEMORY_RETRY_MAX_MS, THREAD_MEMORY_RETRY_MIN_MS * 2 ** exponent)
  const asked = typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, retryAfterSeconds * 1000) : 0
  return Math.max(local, asked)
}

/** Revocable ownership of each persona's in-flight metadata attempts. */
export interface MetadataAttempts {
  /**
   * Run one bounded attempt owned by persona `key`. `current` is the
   * caller's guard (connection, lifetime, observation still the same); a
   * result after it turns false, after `revoke(key)` or after `stop()` is
   * `cancelled`. Never rejects.
   */
  run(key: string, current: () => boolean, operation: (signal: AbortSignal) => Promise<unknown>): Promise<MetadataResult>
  /** Abort and invalidate every attempt of `key` (its connection, identity or lifetime changed). */
  revoke(key: string): void
  /** Number of attempts in flight for `key`, for tests and bounded scheduling. */
  inFlight(key: string): number
  /** Abort everything; later `run` calls are cancelled at once. */
  stop(): void
}

export function createMetadataAttempts(clock: PersonaConnectionClock, timeoutMs = THREAD_MEMORY_LOOKUP_DEADLINE_MS): MetadataAttempts {
  const owned = new Map<string, Set<AbortController>>()
  let stopped = false
  return {
    async run(key, current, operation) {
      if (stopped || !current()) return { kind: 'cancelled' }
      const controller = new AbortController()
      let mine = owned.get(key)
      if (!mine) { mine = new Set(); owned.set(key, mine) }
      mine.add(controller)
      try {
        const value = await boundedMetadataCall(clock, controller.signal, operation, timeoutMs)
        return stopped || controller.signal.aborted || !current() ? { kind: 'cancelled' } : { kind: 'ok', value }
      } catch (error) {
        return stopped || controller.signal.aborted || !current() ? { kind: 'cancelled' } : classifyMetadataFailure(error)
      } finally {
        mine.delete(controller)
        if (!mine.size && owned.get(key) === mine) owned.delete(key)
      }
    },
    revoke(key) {
      for (const controller of owned.get(key) ?? []) controller.abort()
    },
    inFlight: key => owned.get(key)?.size ?? 0,
    stop() {
      stopped = true
      for (const mine of owned.values()) for (const controller of mine) controller.abort()
    },
  }
}
