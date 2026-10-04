/**
 * mailbox.ts — the test mailbox: a mail.tm account the test human's mail is
 * forwarded to, so the runner can read the sign-in code Slack emails when it
 * sees a new device, and the operator can read Gmail's forwarding
 * confirmation.
 *
 * - `parseMailboxFile` / `serializeMailboxFile`: `mailbox.json`
 *   (`{provider, api, address, password, account_id, token}`). The file is
 *   read and written only through the SecretStore (mode check, mode 600,
 *   temp + rename), which registers the password and token with the redactor.
 * - `MailTmClient`: list the messages (newest first), fetch one, and fetch
 *   one's raw source (`GET /sources/<id>`, for its headers), with the
 *   saved bearer token. A 401 gets a fresh token from `POST /token` (once per
 *   call), which is registered with the redactor and saved (the file
 *   rewritten); a 429 backs off (Retry-After, else 1, 2, 4 … s) a bounded
 *   number of times. A call given a deadline ends by it (plus at most
 *   `DEADLINE_GRACE_MS`): no back-off is waited out past it, no request
 *   starts after it, and a request's timeout is cut to what is left.
 * - Extractors, pure and strict (an ambiguous message gives no code):
 *   `extractSlackSignInCode` only from Slack's sender domains with a code
 *   subject; `extractGmailForwardingCode` and `extractGmailConfirmLink`
 *   (the https mail-settings.google.com link marked as the confirm link,
 *   never the cancel link) only from Google with a forwarding confirmation
 *   subject.
 * - `waitForSlackSignInCode`: poll, on the injected clock and with a
 *   deadline its mailbox calls keep too, for a Slack code email received at or
 *   after a given time and sent to the test human: the test email (compared
 *   case-insensitively, exactly: not its form without a `+tag`, which other
 *   mail of the same inbox shares) is among the recipients mail.tm lists
 *   (`to`, `cc`), or else among the recipient headers of the message's
 *   source (`To`, `Cc`, `Delivered-To`, `X-Original-To`), which a forward
 *   keeps when mail.tm lists only the mailbox itself. No test email, no
 *   code.
 * - `describeLatestMessage` / `describeForwardingMessage`: the `mailbox`
 *   command's report. Without `--show-body` it never shows a Slack sign-in
 *   code: code-shaped text in a subject that names a code is `<code>`.
 *
 * Nothing here logs. An error names the call, an HTTP status or a fixed
 * reason, never the token, the password, a request or a response body. The
 * mailbox's own address is not a secret.
 */

import type { FetchLike } from './slack-api.ts'
import { waitFor, type Clock } from './wait.ts'

export const MAILBOX_PROVIDER = 'mail.tm'
export const DEFAULT_MAILBOX_API = 'https://api.mail.tm'

// ---------------------------------------------------------------------------
// mailbox.json
// ---------------------------------------------------------------------------

export interface MailboxConfig {
  /** The API base URL, without a trailing slash. */
  api: string
  /** The mailbox's address (not a secret). */
  address: string
  /** The mailbox's password (secret). */
  password: string
  accountId: string | null
  /** The saved bearer token (secret); `null` when none is saved. */
  token: string | null
  /** Keys of the file this runner does not use, kept as they are on a rewrite. */
  extra: Record<string, unknown>
}

/** mailbox.json is not usable. The message names the key and the rule, never a value. */
export class MailboxConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailboxConfigError'
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const KNOWN_KEYS = new Set(['provider', 'api', 'address', 'password', 'account_id', 'token'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * The API base URL, checked: https, or http on a loopback address (the dry
 * run's stub); no credentials, query or fragment. `null` when it is not one.
 */
export function mailboxApiBase(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  if (!secure || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/** Parse mailbox.json's text. Throws `MailboxConfigError` (a fixed reason) when it is not usable. */
export function parseMailboxFile(text: string): MailboxConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // The parser's own message can quote the file: never pass it on.
    throw new MailboxConfigError('is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MailboxConfigError('is not a JSON object')
  const raw = parsed as Record<string, unknown>
  if (raw.provider !== undefined && raw.provider !== MAILBOX_PROVIDER) {
    throw new MailboxConfigError(`has an unsupported provider (only ${MAILBOX_PROVIDER} is supported)`)
  }
  const api = mailboxApiBase(typeof raw.api === 'string' ? raw.api : DEFAULT_MAILBOX_API)
  if (api === null) throw new MailboxConfigError('has an api that is not an https URL')
  if (typeof raw.address !== 'string' || !EMAIL_RE.test(raw.address)) throw new MailboxConfigError('has no address, or it is not an email address')
  if (typeof raw.password !== 'string' || raw.password === '') throw new MailboxConfigError('has no password')
  if (raw.token !== undefined && raw.token !== null && typeof raw.token !== 'string') throw new MailboxConfigError('has a token that is not a string')
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) if (!KNOWN_KEYS.has(key)) extra[key] = value
  return {
    api,
    address: raw.address,
    password: raw.password,
    accountId: typeof raw.account_id === 'string' && raw.account_id !== '' ? raw.account_id : null,
    token: typeof raw.token === 'string' && raw.token !== '' ? raw.token : null,
    extra,
  }
}

/** mailbox.json's text for `config` (the keys it was read with, the token updated). */
export function serializeMailboxFile(config: MailboxConfig): string {
  const out: Record<string, unknown> = {
    provider: MAILBOX_PROVIDER,
    api: config.api,
    address: config.address,
    password: config.password,
    ...(config.accountId !== null ? { account_id: config.accountId } : {}),
    ...(config.token !== null ? { token: config.token } : {}),
  }
  for (const [key, value] of Object.entries(config.extra)) if (!KNOWN_KEYS.has(key)) out[key] = value
  return `${JSON.stringify(out, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MailAddress {
  address: string
  name: string
}

export interface MailSummary {
  id: string
  from: MailAddress
  /** The addresses the API names as the recipients (`to`, and `cc` when it gives one), as given. */
  recipients: string[]
  subject: string
  intro: string
  /** As the API gives it (ISO 8601). */
  createdAt: string
  /** `createdAt` in ms since the epoch; NaN when it does not parse. */
  receivedAtMs: number
  seen: boolean
}

export interface MailMessage extends MailSummary {
  text: string
  html: string[]
}

const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const EMAIL_IN_TEXT_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The addresses in an API recipient list: each item an `{address, name}`
 * object or a string (`a@b` or `Name <a@b>`); anything else is skipped.
 */
function addressesIn(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const text = typeof item === 'string' ? item : item && typeof item === 'object' ? str((item as Record<string, unknown>).address) : ''
    return text.match(EMAIL_IN_TEXT_RE) ?? []
  })
}

/** A message summary from the API's JSON, or `null` when it has no usable id. */
export function parseSummary(value: unknown): MailSummary | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const id = str(v.id)
  if (!MESSAGE_ID_RE.test(id)) return null
  const from = v.from && typeof v.from === 'object' ? (v.from as Record<string, unknown>) : {}
  const createdAt = str(v.createdAt)
  return {
    id,
    from: { address: str(from.address), name: str(from.name) },
    recipients: [...addressesIn(v.to), ...addressesIn(v.cc)],
    subject: str(v.subject),
    intro: str(v.intro),
    createdAt,
    receivedAtMs: Date.parse(createdAt),
    seen: v.seen === true,
  }
}

/** A full message from the API's JSON, or `null` when it has no usable id. */
export function parseMessage(value: unknown): MailMessage | null {
  const summary = parseSummary(value)
  if (!summary) return null
  const v = value as Record<string, unknown>
  const html = Array.isArray(v.html) ? v.html.filter((h): h is string => typeof h === 'string') : typeof v.html === 'string' ? [v.html] : []
  return { ...summary, text: str(v.text), html }
}

/**
 * The summaries in a `GET /messages` answer, newest first: a plain JSON
 * array, or a JSON-LD collection (`hydra:member`). `null` when it is neither.
 */
export function parseMessageList(value: unknown): MailSummary[] | null {
  let items: unknown
  if (Array.isArray(value)) items = value
  else if (value && typeof value === 'object') items = (value as Record<string, unknown>)['hydra:member']
  if (!Array.isArray(items)) return null
  const out = items.map(parseSummary).filter((s): s is MailSummary => s !== null)
  const time = (s: MailSummary): number => (Number.isFinite(s.receivedAtMs) ? s.receivedAtMs : -Infinity)
  return out.sort((a, b) => time(b) - time(a))
}

// ---------------------------------------------------------------------------
// The mail.tm client
// ---------------------------------------------------------------------------

/**
 * A mailbox call failed. `auth`: mail.tm refused the address and password (or
 * a fresh token); `rate-limited`: still 429 after the back-offs. The message
 * names the call and the kind, never a token or a body.
 */
export class MailboxError extends Error {
  constructor(
    readonly call: string,
    readonly kind: 'network' | 'timeout' | 'http' | 'parse' | 'auth' | 'rate-limited',
    readonly status?: number,
  ) {
    super(`mail.tm ${call}: ${kind}${status !== undefined ? ` ${status}` : ''}`)
    this.name = 'MailboxError'
  }
}

/** A mailbox call's time limit. Without one, a call takes as long as its requests and back-offs do. */
export interface MailCallOptions {
  /**
   * When the call must be over, in ms on the reader's clock. No request
   * starts after it (the call fails as a timeout); a 429's back-off that
   * would end after it is not waited out (the call fails as rate-limited at
   * once); a request's timeout is cut to what is left, but never below
   * `DEADLINE_GRACE_MS`, so a last look at the deadline can still be
   * answered. The call ends at most `DEADLINE_GRACE_MS` after it.
   */
  deadline?: number
}

/** Reading the mailbox, as the sign-in and the `mailbox` command use it. */
export interface MailReader {
  /** The mailbox's address (not a secret). */
  readonly address: string
  /** The newest messages (the first page), newest first. */
  listMessages(options?: MailCallOptions): Promise<MailSummary[]>
  getMessage(id: string, options?: MailCallOptions): Promise<MailMessage>
  /** The message's raw source (RFC 5322: headers, a blank line, the body), read for its headers. */
  getSource(id: string, options?: MailCallOptions): Promise<string>
}

export interface MailTmClientOptions {
  config: MailboxConfig
  fetch: FetchLike
  clock: Clock
  /** Called with a fresh token before it is used or saved: register it with the redactor. */
  onSecret: (value: string) => void
  /** Save the config with a fresh token (mailbox.json, mode 600, temp + rename). */
  save: (config: MailboxConfig) => void
  timeoutMs?: number
  /** How many times a 429 is retried (default 4). */
  maxRateLimitRetries?: number
}

export const DEFAULT_MAILBOX_TIMEOUT_MS = 30_000
const MAX_BACKOFF_S = 30
/** How long past its deadline a call may end: a request started at the deadline gets this long. */
export const DEADLINE_GRACE_MS = 1000

/** How long to wait before retrying a 429: its Retry-After (seconds), else 1, 2, 4 … s; capped. */
export function rateLimitDelayMs(retryAfter: string | null, attempt: number): number {
  const header = retryAfter === null ? NaN : Number(retryAfter)
  const seconds = Number.isFinite(header) && header > 0 ? header : 2 ** attempt
  return Math.min(seconds, MAX_BACKOFF_S) * 1000
}

/**
 * A request's timeout: the client's own (`timeoutMs`), cut to what is left
 * before `deadline` (at `now`) but never below `DEADLINE_GRACE_MS` (nor above
 * the client's own). Without a deadline, the client's own.
 */
export function requestTimeoutMs(timeoutMs: number, now: number, deadline?: number): number {
  if (deadline === undefined) return timeoutMs
  return Math.min(timeoutMs, Math.max(deadline - now, DEADLINE_GRACE_MS))
}

export class MailTmClient implements MailReader {
  private config: MailboxConfig
  private readonly o: Required<Omit<MailTmClientOptions, 'config'>>
  /** Tokens fetched with `POST /token` by this client (the dry run's evidence). */
  tokensFetched = 0
  /** 429 answers backed off from (the dry run's evidence). */
  rateLimitedCount = 0

  constructor(options: MailTmClientOptions) {
    this.config = options.config
    this.o = { timeoutMs: DEFAULT_MAILBOX_TIMEOUT_MS, maxRateLimitRetries: 4, ...options }
  }

  get address(): string {
    return this.config.address
  }

  private async send(call: string, method: 'GET' | 'POST', path: string, body: unknown, auth: boolean, deadline?: number): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      if (deadline !== undefined && this.o.clock.now() > deadline) throw new MailboxError(call, 'timeout')
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      if (auth && this.config.token !== null) headers.Authorization = `Bearer ${this.config.token}`
      let response: Response
      try {
        response = await this.o.fetch(`${this.config.api}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(requestTimeoutMs(this.o.timeoutMs, this.o.clock.now(), deadline)),
          redirect: 'error',
        })
      } catch (err) {
        const name = (err as { name?: string } | null)?.name
        throw new MailboxError(call, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network')
      }
      if (response.status !== 429) return response
      await response.body?.cancel()
      if (attempt >= this.o.maxRateLimitRetries) throw new MailboxError(call, 'rate-limited', 429)
      const delayMs = rateLimitDelayMs(response.headers.get('retry-after'), attempt)
      // A retry after the deadline is no use to the caller: give up now rather than overrun it.
      if (deadline !== undefined && this.o.clock.now() + delayMs > deadline) throw new MailboxError(call, 'rate-limited', 429)
      this.rateLimitedCount += 1
      await this.o.clock.sleep(delayMs)
    }
  }

  private async json(call: string, response: Response): Promise<unknown> {
    if (!response.ok) {
      await response.body?.cancel()
      throw new MailboxError(call, response.status === 401 ? 'auth' : 'http', response.status)
    }
    try {
      return await response.json()
    } catch {
      throw new MailboxError(call, 'parse')
    }
  }

  /** A fresh token from `POST /token` (address + password): registered, then saved. */
  private async refreshToken(deadline?: number): Promise<void> {
    const response = await this.send('token', 'POST', '/token', { address: this.config.address, password: this.config.password }, false, deadline)
    if (response.status === 400 || response.status === 401) {
      await response.body?.cancel()
      throw new MailboxError('token', 'auth', response.status)
    }
    const answer = await this.json('token', response)
    const token = answer && typeof answer === 'object' ? (answer as Record<string, unknown>).token : undefined
    if (typeof token !== 'string' || token === '') throw new MailboxError('token', 'parse')
    this.o.onSecret(token)
    this.tokensFetched += 1
    this.config = { ...this.config, token }
    this.o.save(this.config)
  }

  /** GET `path` with the bearer token; a 401 gets a fresh token once. */
  private async authedGet(call: string, path: string, deadline?: number): Promise<unknown> {
    if (this.config.token === null) await this.refreshToken(deadline)
    let response = await this.send(call, 'GET', path, undefined, true, deadline)
    if (response.status === 401) {
      await response.body?.cancel()
      await this.refreshToken(deadline)
      response = await this.send(call, 'GET', path, undefined, true, deadline)
    }
    return this.json(call, response)
  }

  async listMessages(options: MailCallOptions = {}): Promise<MailSummary[]> {
    const list = parseMessageList(await this.authedGet('messages', '/messages?page=1', options.deadline))
    if (list === null) throw new MailboxError('messages', 'parse')
    return list
  }

  async getMessage(id: string, options: MailCallOptions = {}): Promise<MailMessage> {
    if (!MESSAGE_ID_RE.test(id)) throw new MailboxError('message', 'parse')
    const message = parseMessage(await this.authedGet('message', `/messages/${id}`, options.deadline))
    if (message === null) throw new MailboxError('message', 'parse')
    return message
  }

  /** `GET /sources/<id>` (the message's id): its `data`, the raw source. */
  async getSource(id: string, options: MailCallOptions = {}): Promise<string> {
    if (!MESSAGE_ID_RE.test(id)) throw new MailboxError('source', 'parse')
    const answer = await this.authedGet('source', `/sources/${id}`, options.deadline)
    const data = answer && typeof answer === 'object' ? (answer as Record<string, unknown>).data : undefined
    if (typeof data !== 'string') throw new MailboxError('source', 'parse')
    return data
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–' }

/** An HTML body as plain text: block ends become line breaks, tags go, entities are decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|th|li|h[1-6]|table|tbody|thead|blockquote|center)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const n = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''
      }
      return ENTITIES[name.toLowerCase()] ?? whole
    })
}

/** The message's text: its text part, else its HTML as text. */
export function messageText(message: Pick<MailMessage, 'text' | 'html'>): string {
  return message.text.trim() !== '' ? message.text : htmlToText(message.html.join('\n'))
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/** Slack's sender domains (its help center names these two), and their subdomains. */
export const SLACK_SENDER_DOMAINS = ['slack.com', 'slack-mail.com'] as const
/** Google's sender domain for Gmail's forwarding confirmation (`forwarding-noreply@google.com`). */
export const GOOGLE_SENDER_DOMAINS = ['google.com'] as const

/** A subject that names a code: "Slack confirmation code: ABC-DEF", "Your Slack security code is 123456". */
const SLACK_CODE_SUBJECT_RE = /\b(?:confirmation|sign[- ]?in|verification|login|security) code\b/i
/** A subject that names Gmail's forwarding confirmation. */
const GMAIL_FORWARDING_SUBJECT_RE = /\bforwarding confirmation\b/i

/** True when `address` is at one of `domains` or a subdomain of one. */
export function isFromDomain(address: string, domains: readonly string[]): boolean {
  const at = address.lastIndexOf('@')
  if (at < 1) return false
  const domain = address.slice(at + 1).trim().toLowerCase()
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`))
}

/** A message Slack sent with a code in it (sender and subject; the body is not read). */
export function isSlackCodeMail(message: Pick<MailSummary, 'from' | 'subject'>): boolean {
  return isFromDomain(message.from.address, SLACK_SENDER_DOMAINS) && SLACK_CODE_SUBJECT_RE.test(message.subject)
}

/** Gmail's forwarding confirmation (sender and subject; the body is not read). */
export function isGmailForwardingMail(message: Pick<MailSummary, 'from' | 'subject'>): boolean {
  return isFromDomain(message.from.address, GOOGLE_SENDER_DOMAINS) && GMAIL_FORWARDING_SUBJECT_RE.test(message.subject)
}

/** A Slack code: three upper-case letters or digits, a dash, three more; or six without the dash. */
const SLACK_CODE_AFTER_WORD_RE = /^\s*(?:is\s+)?[:\-–—]?\s*([A-Z0-9]{3}-[A-Z0-9]{3}|[A-Z0-9]{6})(?![A-Za-z0-9-])/
const SLACK_CODE_LINE_RE = /^(?:[A-Z0-9]{3}-[A-Z0-9]{3}|[A-Z0-9]{6})$/

/** The code a Slack subject names right after the word "code", or null. */
function slackCodeInSubject(subject: string): string | null {
  const m = /\bcode\b/i.exec(subject)
  if (!m) return null
  return SLACK_CODE_AFTER_WORD_RE.exec(subject.slice(m.index + m[0].length))?.[1] ?? null
}

/**
 * The codes a Slack body shows on a line of their own. A six-character code
 * without a dash counts only when it has a digit (an all-capitals word is not
 * a code).
 */
function slackCodesInBody(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!SLACK_CODE_LINE_RE.test(line)) continue
    if (!line.includes('-') && !/\d/.test(line)) continue
    out.push(line)
  }
  return out
}

/** A code without its dash, for comparing the two forms. */
export function bareCode(code: string): string {
  return code.replace(/-/g, '')
}

/**
 * The sign-in code in a Slack code email, or `null`. Strict: the sender is at
 * a Slack domain, the subject names a code, and the subject and the body name
 * one code between them (a body with two different codes, or one that
 * disagrees with the subject, gives none). Returns the code as shown.
 */
export function extractSlackSignInCode(message: Pick<MailMessage, 'from' | 'subject' | 'text' | 'html'>): string | null {
  if (!isSlackCodeMail(message)) return null
  const fromSubject = slackCodeInSubject(message.subject)
  const fromBody = slackCodesInBody(messageText(message))
  const distinct = new Set([...(fromSubject ? [fromSubject] : []), ...fromBody].map(bareCode))
  if (distinct.size !== 1) return null
  return fromSubject ?? (fromBody[0] as string)
}

/**
 * The confirmation code (a number) in Gmail's forwarding confirmation, or
 * `null`. Strict: the sender is at Google, the subject names a forwarding
 * confirmation, and the subject's `(#…)` and the body's "Confirmation code:"
 * name one number between them.
 */
export function extractGmailForwardingCode(message: Pick<MailMessage, 'from' | 'subject' | 'text' | 'html'>): string | null {
  if (!isGmailForwardingMail(message)) return null
  const found: string[] = []
  const subject = /\(#(\d{5,12})\)/.exec(message.subject)?.[1]
  if (subject) found.push(subject)
  for (const m of messageText(message).matchAll(/confirmation code:?\s*(\d{5,12})(?!\d)/gi)) found.push(m[1] as string)
  const distinct = new Set(found)
  return distinct.size === 1 ? (found[0] as string) : null
}

/** The hosts Gmail's forwarding confirmation links point at. */
export const GMAIL_CONFIRM_LINK_HOSTS = ['mail-settings.google.com', 'google.com'] as const

/** A URL in text: the scheme, then URL characters (no space, quote, angle bracket or parenthesis). */
const URL_IN_TEXT_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&*+,;=%]+/gi
/** Sentence punctuation right after a URL is not part of it. */
const URL_TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/
/** Text before a link that asks to confirm ("click the link below to confirm the request:"). */
const CONFIRM_WORD_RE = /\bconfirm\b/i
/** Text before a link that offers to cancel ("click this link to cancel this verification:"). */
const CANCEL_WORD_RE = /\bcancel/i
/** Gmail's link paths: `/mail/vf-…` confirms (verifies) the forwarding, `/mail/uf-…` cancels it. */
const CONFIRM_PATH_RE = /\/vf-/i
const CANCEL_PATH_RE = /\/uf-/i

/** A URL a text shows, and the text that leads to it (from the end of the URL before it). */
interface LinkMention {
  url: string
  lead: string
}

function linkMentions(text: string): LinkMention[] {
  const out: LinkMention[] = []
  let last = 0
  for (const m of text.matchAll(URL_IN_TEXT_RE)) {
    const at = m.index ?? 0
    out.push({ url: m[0].replace(URL_TRAILING_PUNCTUATION_RE, ''), lead: text.slice(last, at) })
    last = at + m[0].length
  }
  return out
}

/** An HTML body as text with each link's target shown right after its text (`<a href="U">T</a>` → `T U`). */
function htmlWithLinkTargets(html: string): string {
  return htmlToText(html.replace(/<a\b[^>]*?\bhref\s*=\s*(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_whole, _quote, href: string, inner: string) => `${inner} ${href} `))
}

/** Whether a link mention is marked as the confirm link, the cancel link, or neither. Cancel wins. */
function gmailLinkRole(mention: LinkMention): 'confirm' | 'cancel' | null {
  let path = ''
  try {
    path = new URL(mention.url).pathname
  } catch {
    /* not a URL: only its lead can mark it */
  }
  if (CANCEL_WORD_RE.test(mention.lead) || CANCEL_PATH_RE.test(path)) return 'cancel'
  if (CONFIRM_WORD_RE.test(mention.lead) || CONFIRM_PATH_RE.test(path)) return 'confirm'
  return null
}

/** An https URL on one of Gmail's confirm-link hosts, with no credentials and no port. */
function isGmailLinkUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    (GMAIL_CONFIRM_LINK_HOSTS as readonly string[]).includes(url.hostname)
  )
}

/**
 * The confirm link in Gmail's forwarding confirmation, or `null`. Strict: the
 * sender is at Google and the subject names a forwarding confirmation (as
 * `extractGmailForwardingCode`); the link is an https URL on
 * mail-settings.google.com (or google.com), in the text part or the HTML
 * part; it is marked as the confirm link, by the text leading to it ("to
 * confirm the request") or by its path (`/mail/vf-…`); and it is never
 * marked as the cancel link anywhere (the word "cancel" before it, or a
 * `/mail/uf-…` path). More than one such link gives none. Returns the link as
 * the message shows it.
 */
export function extractGmailConfirmLink(message: Pick<MailMessage, 'from' | 'subject' | 'text' | 'html'>): string | null {
  if (!isGmailForwardingMail(message)) return null
  const mentions = [...linkMentions(message.text), ...message.html.flatMap((h) => linkMentions(htmlWithLinkTargets(h)))]
  const key = (value: string): string => {
    try {
      return new URL(value).href
    } catch {
      return value
    }
  }
  const cancelled = new Set<string>()
  const confirm = new Map<string, string>()
  for (const mention of mentions) {
    const role = gmailLinkRole(mention)
    if (role === 'cancel') cancelled.add(key(mention.url))
    else if (role === 'confirm' && isGmailLinkUrl(mention.url) && !confirm.has(key(mention.url))) confirm.set(key(mention.url), mention.url)
  }
  for (const k of cancelled) confirm.delete(k)
  return confirm.size === 1 ? ([...confirm.values()][0] as string) : null
}

// ---------------------------------------------------------------------------
// Waiting for Slack's code
// ---------------------------------------------------------------------------

export interface SlackCodeFound {
  /** The message it came from. */
  id: string
  /** The code as shown (a secret: register it with the redactor before anything logs). */
  code: string
}

export interface WaitForCodeOptions {
  /** Only mail received at or after this time (ms since the epoch) counts. */
  sinceMs: number
  /** Only mail sent to this address counts (see `isSentTo`); empty: none does. */
  testEmail: string
  timeoutMs: number
  pollMs: number
  clock: Clock
  /**
   * Messages already looked at (a code Slack refused, mail with no code, mail
   * sent to someone else). Each one looked at is added.
   */
  exclude: Set<string>
  /** A poll failed for a reason that may pass (network, timeout, 5xx, 429 after back-off); the wait goes on. */
  onTransientError?: (err: unknown) => void
}

/** A mailbox failure that polling again won't fix (mail.tm refused the address and password). */
export function isFatalMailboxError(err: unknown): boolean {
  return !(err instanceof MailboxError) || err.kind === 'auth'
}

/**
 * The source headers that name whom a message was sent to: its own
 * addressing (`To`, `Cc`, which a forward keeps as they were), and the
 * address it was delivered to before a forward (`Delivered-To`, which Gmail
 * stamps with the full address, `+tag` included; `X-Original-To`). Not
 * `X-Forwarded-For`: it names the forwarding account, whose other mail
 * (another account's Slack codes) is forwarded as well.
 */
const RECIPIENT_HEADERS = new Set(['to', 'cc', 'delivered-to', 'x-original-to'])

/** The addresses a raw message's recipient headers (`RECIPIENT_HEADERS`) name; the header block only, folded lines joined. */
export function recipientsInSource(source: string): string[] {
  const end = source.search(/\r?\n\r?\n/)
  const head = (end === -1 ? source : source.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ')
  return head.split(/\r?\n/).flatMap((line) => {
    const colon = line.indexOf(':')
    if (colon < 1 || !RECIPIENT_HEADERS.has(line.slice(0, colon).trim().toLowerCase())) return []
    return line.slice(colon + 1).match(EMAIL_IN_TEXT_RE) ?? []
  })
}

/**
 * True when `recipients` holds `email`, compared case-insensitively and
 * exactly: never its form without a `+tag`, which other mail of the same
 * inbox shares (a Slack code for another account of that address). An empty
 * `email` matches nothing.
 */
export function isSentTo(recipients: readonly string[], email: string): boolean {
  const want = email.trim().toLowerCase()
  return want !== '' && recipients.some((r) => r.trim().toLowerCase() === want)
}

/** Whether a message was sent to `email`: by the recipients mail.tm lists, else by its source's recipient headers. */
async function mailSentTo(reader: MailReader, summary: MailSummary, email: string, call: MailCallOptions): Promise<boolean> {
  if (isSentTo(summary.recipients, email)) return true
  return isSentTo(recipientsInSource(await reader.getSource(summary.id, call)), email)
}

/**
 * Poll the mailbox until a Slack code email received at or after `sinceMs`
 * and sent to `testEmail` (`mailSentTo`) gives a code, or the deadline
 * passes (`null`; at once without a test email). Newest first; each message
 * is read once (it joins `exclude`). A transient failure only costs a poll;
 * a fatal one (see `isFatalMailboxError`) is thrown. Every mailbox call gets
 * the wait's deadline (`MailCallOptions`), so a 429's back-off or a slow
 * request cannot carry the wait past it by more than `DEADLINE_GRACE_MS`.
 */
export async function waitForSlackSignInCode(reader: MailReader, o: WaitForCodeOptions): Promise<SlackCodeFound | null> {
  // No mail can be shown to be the test human's: there is nothing to wait for.
  if (o.testEmail.trim() === '') return null
  const transient = (err: unknown): null => {
    if (isFatalMailboxError(err)) throw err
    o.onTransientError?.(err)
    return null
  }
  return waitFor<SlackCodeFound>(
    async (deadline) => {
      const call: MailCallOptions = { deadline }
      let list: MailSummary[]
      try {
        list = await reader.listMessages(call)
      } catch (err) {
        return transient(err)
      }
      const candidates = list.filter((m) => !o.exclude.has(m.id) && m.receivedAtMs >= o.sinceMs && isSlackCodeMail(m))
      for (const summary of candidates) {
        let message: MailMessage
        try {
          if (!(await mailSentTo(reader, summary, o.testEmail, call))) {
            o.exclude.add(summary.id)
            continue
          }
          message = await reader.getMessage(summary.id, call)
        } catch (err) {
          return transient(err)
        }
        o.exclude.add(summary.id)
        const code = extractSlackSignInCode(message)
        if (code) return { id: summary.id, code }
      }
      return null
    },
    { timeoutMs: o.timeoutMs, intervalMs: o.pollMs, clock: o.clock },
  )
}

// ---------------------------------------------------------------------------
// The `mailbox --latest` and `mailbox --forwarding` reports
// ---------------------------------------------------------------------------

/** The forms an email address takes in mail about it: as it is, and without a `+tag` (`a+x@b` → `a@b`). */
export function addressForms(email: string): string[] {
  const m = /^([^+@]+)\+[^@]*(@.+)$/.exec(email)
  return m ? [email, `${m[1]}${m[2]}`] : [email]
}

/** `text` with every email address but `keep` (compared case-insensitively) shown as `<email>`. */
export function maskEmails(text: string, keep: readonly string[]): string {
  const kept = new Set(keep.map((k) => k.toLowerCase()))
  return text.replace(EMAIL_IN_TEXT_RE, (address) => (kept.has(address.toLowerCase()) ? address : '<email>'))
}

/** Code-shaped text: Slack's `XXX-XXX` (in any case), or six upper-case letters or digits, standing alone. */
const CODE_SHAPED_RE = /(?<![A-Za-z0-9-])(?:[A-Za-z0-9]{3}-[A-Za-z0-9]{3}|[A-Z0-9]{6})(?![A-Za-z0-9-])/g

/**
 * A subject as the `mailbox` command shows it without `--show-body`: when it
 * names a code (the word "code", whoever sent it), its code-shaped text is
 * `<code>`; otherwise it is as it is.
 */
export function maskSubjectCodes(subject: string): string {
  return /\bcode\b/i.test(subject) ? subject.replace(CODE_SHAPED_RE, '<code>') : subject
}

/** Control characters (a terminal escape in a subject) as spaces; with `keepLines`, newlines and tabs stay. */
export function stripControls(text: string, keepLines = false): string {
  return keepLines ? text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ') : text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
}

/** A sender the runner reads mail from: Slack (sign-in codes) or Google (Gmail's forwarding confirmation). */
export function isServiceSender(address: string): boolean {
  return isFromDomain(address, SLACK_SENDER_DOMAINS) || isFromDomain(address, GOOGLE_SENDER_DOMAINS)
}

/**
 * How `mailbox --latest` names a sender: Slack's and Google's as they are;
 * anyone else (a person) only by the domain of the address, so no person's
 * name or address reaches an output that may be pasted on.
 */
export function describeSender(from: MailAddress): string {
  if (isServiceSender(from.address)) return from.name ? `${from.name} <${from.address}>` : from.address
  const at = from.address.lastIndexOf('@')
  return at > 0 ? `an address at ${from.address.slice(at + 1)}` : 'an unknown sender'
}

/**
 * The lines `mailbox --latest` prints for the newest message: when it came,
 * its sender (see `describeSender`) and subject, and what confirmation code
 * is found in it. Gmail's forwarding code is printed. Slack's sign-in code is
 * printed only with `showBody` (with the body, which holds it anyway);
 * without it, a line says one is there, and the subject's code-shaped text is
 * masked (`maskSubjectCodes`). The body only with `showBody`. Every email
 * address but the mailbox's own and a service sender's is masked; the
 * caller's redactor masks the known secrets on output.
 */
export function describeLatestMessage(message: MailMessage, mailboxAddress: string, showBody: boolean): string[] {
  const shown = messageShown(message, mailboxAddress, showBody)
  const lines = shown.head('newest message')
  const gmail = extractGmailForwardingCode(message)
  const slack = gmail === null ? extractSlackSignInCode(message) : null
  if (gmail !== null) lines.push(`Gmail forwarding confirmation code: ${gmail}`)
  else if (slack !== null) lines.push(showBody ? `Slack sign-in code: ${slack}` : 'a Slack sign-in code is in it (--show-body prints it)')
  else lines.push(`no confirmation code found in it${showBody ? '' : ' (--show-body prints the body)'}`)
  if (showBody) lines.push(...shown.body())
  return lines
}

/** The newest message (of a list, newest first) that is Gmail's forwarding confirmation (sender and subject), or `undefined`. */
export function selectForwardingMessage<T extends Pick<MailSummary, 'from' | 'subject'>>(list: readonly T[]): T | undefined {
  return list.find(isGmailForwardingMail)
}

/**
 * The lines `mailbox --forwarding` prints for Gmail's forwarding
 * confirmation: when it came, its sender and subject, its confirmation code
 * when one is found, and its confirm link (`extractGmailConfirmLink`) on a
 * line of its own, the one value printed on purpose (the operator opens it to
 * approve the forwarding). The body only with `showBody`. Addresses, and
 * without `showBody` the subject's code-shaped text, are masked as in
 * `describeLatestMessage`.
 */
export function describeForwardingMessage(message: MailMessage, mailboxAddress: string, showBody: boolean): string[] {
  const shown = messageShown(message, mailboxAddress, showBody)
  const lines = shown.head('Gmail forwarding confirmation')
  const code = extractGmailForwardingCode(message)
  lines.push(code !== null ? `Gmail forwarding confirmation code: ${code}` : 'no confirmation code found in it')
  const link = extractGmailConfirmLink(message)
  lines.push(link !== null ? `confirm link: ${shown.line(link)}` : `no confirm link found in it${showBody ? '' : ' (--show-body prints the body)'}`)
  if (showBody) lines.push(...shown.body())
  return lines
}

/**
 * How the `mailbox` command shows a message: a line with its control
 * characters as spaces and every address masked but the mailbox's own and a
 * service sender's; the head (mailbox, received time, sender, subject: its
 * code-shaped text masked unless `showBody`); the body.
 */
function messageShown(message: MailMessage, mailboxAddress: string, showBody: boolean) {
  const keep = isServiceSender(message.from.address) ? [mailboxAddress, message.from.address] : [mailboxAddress]
  const line = (s: string): string => maskEmails(stripControls(s), keep)
  const subject = line(message.subject)
  return {
    line,
    head: (what: string): string[] => [
      `mailbox: ${mailboxAddress}`,
      `${what}: received ${line(message.createdAt || 'at an unknown time')}`,
      `from: ${line(describeSender(message.from))}`,
      `subject: ${showBody ? subject : maskSubjectCodes(subject)}`,
    ],
    body: (): string[] => ['body:', ...maskEmails(stripControls(messageText(message), true), keep).split(/\r?\n/).map((l) => `  ${l}`)],
  }
}
