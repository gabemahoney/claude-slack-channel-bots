/**
 * slack-api.ts — a minimal Slack Web API caller for the runner's host side:
 * the manifest API (configuration token), `auth.test` / `bots.info` (bot
 * token) and `apps.connections.open` (app-level token).
 *
 * A token travels only in the `Authorization` header of a `fetch` request,
 * never in a URL, an argv or a log line. Errors name the method and a Slack
 * error code or HTTP status, never a request or a response body (a
 * `apps.manifest.create` response holds the app's client secret).
 *
 * `fetch`, the base URL and the sleep used for rate-limit back-off are
 * injected, so the dry run points it at the local stub and tests at a fake.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface SlackResponse {
  ok: boolean
  error?: string
  [key: string]: unknown
}

export type SlackParams = Record<string, string | number | boolean | undefined>

/** The call never produced a Slack JSON answer (network, HTTP status, timeout, non-JSON body). */
export class SlackTransportError extends Error {
  constructor(
    readonly method: string,
    readonly kind: 'network' | 'http' | 'timeout' | 'parse',
    readonly status?: number,
  ) {
    super(`${method}: ${kind}${status !== undefined ? ` ${status}` : ''}`)
    this.name = 'SlackTransportError'
  }
}

/** Slack method names: dotted lowercase words (`apps.manifest.create`). */
const METHOD_RE = /^[a-z]+(\.[a-zA-Z]+)+$/

/** A Slack error code is safe to print when it is a plain identifier. */
const ERROR_CODE_RE = /^[a-z_]{1,64}$/

/** The Slack error code, or `unknown_error` when the answer's code is not a plain identifier. */
export function safeErrorCode(response: SlackResponse): string {
  return typeof response.error === 'string' && ERROR_CODE_RE.test(response.error) ? response.error : 'unknown_error'
}

export const SLACK_API_BASE_URL = 'https://slack.com/api/'

export interface SlackApiOptions {
  baseUrl: string
  fetch: FetchLike
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  /** How many times a 429 is retried after its Retry-After (default 3). */
  maxRateLimitRetries?: number
}

export const DEFAULT_SLACK_TIMEOUT_MS = 30_000
const MAX_RETRY_AFTER_S = 60

/** Encode `params` as a form body, skipping undefined values. */
export function formBody(params: SlackParams): string {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) body.set(key, String(value))
  }
  return body.toString()
}

export class SlackApi {
  private readonly o: Required<SlackApiOptions>

  constructor(options: SlackApiOptions) {
    this.o = {
      timeoutMs: DEFAULT_SLACK_TIMEOUT_MS,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      maxRateLimitRetries: 3,
      ...options,
    }
  }

  get baseUrl(): string {
    return this.o.baseUrl
  }

  /**
   * POST `method` with `params` as a form body, and `token` (when given) as a
   * bearer token. Resolves to Slack's JSON answer (`ok` true or false);
   * rejects with a `SlackTransportError` when there is none.
   */
  async call(method: string, token: string | null, params: SlackParams = {}): Promise<SlackResponse> {
    if (!METHOD_RE.test(method)) throw new Error(`not a Slack method name: ${JSON.stringify(method.slice(0, 40))}`)
    const url = new URL(method, this.o.baseUrl).toString()
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }
      if (token !== null) headers.Authorization = `Bearer ${token}`
      let response: Response
      try {
        response = await this.o.fetch(url, {
          method: 'POST',
          headers,
          body: formBody(params),
          signal: AbortSignal.timeout(this.o.timeoutMs),
          redirect: 'error',
        })
      } catch (err) {
        const name = (err as { name?: string } | null)?.name
        throw new SlackTransportError(method, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network')
      }
      if (response.status === 429 && attempt < this.o.maxRateLimitRetries) {
        const retryAfter = Number(response.headers.get('retry-after') ?? '1')
        await response.body?.cancel()
        await this.o.sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1, MAX_RETRY_AFTER_S) * 1000)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new SlackTransportError(method, 'http', response.status)
      }
      let json: unknown
      try {
        json = await response.json()
      } catch {
        throw new SlackTransportError(method, 'parse')
      }
      if (!json || typeof json !== 'object' || typeof (json as SlackResponse).ok !== 'boolean') {
        throw new SlackTransportError(method, 'parse')
      }
      return json as SlackResponse
    }
  }
}

/** Error codes that mean the token itself was refused. */
export const TOKEN_REFUSED_CODES = new Set([
  'invalid_auth',
  'not_authed',
  'token_expired',
  'token_revoked',
  'account_inactive',
  'not_allowed_token_type',
])
