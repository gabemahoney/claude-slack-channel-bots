/**
 * ci-live-mailbox.test.ts — Tests for the /ci-live runner's test mailbox
 * (bug b.1cx): `ci-live/lib/mailbox.ts` (mailbox.json, the mail.tm client,
 * the extractors, the wait for Slack's code and the `mailbox` command's
 * report), `ci-live/lib/sign-in-code.ts` (answering Slack's emailed sign-in
 * code from the mailbox) and the dry run's stub mailbox
 * (`ci-live/dry-run/stub-state.ts`).
 *
 * The rules under test:
 * - the mailbox's password, its token and a sign-in code never appear in an
 *   error, a log line or a request URL: the token travels only in the
 *   Authorization header, the password only in `POST /token`'s body;
 * - a 401 gets one fresh token, registered with the redactor before it is
 *   saved, and mailbox.json is rewritten mode 600 (temp file, then rename);
 *   a second 401 is an auth error; a 429 backs off a bounded number of times;
 * - a call given a deadline ends by it (plus at most `DEADLINE_GRACE_MS`): no
 *   request starts after it, no back-off is waited out past it, a request's
 *   timeout is cut to what is left, and the wait for Slack's code gives every
 *   call its own deadline, so a rate-limited mailbox cannot stretch the
 *   2-minute sign-in wait;
 * - the extractors are strict: a Slack code only from Slack's own domains
 *   with a code subject, subject and body agreeing; Gmail's confirm link only
 *   from Google's forwarding confirmation, an https link on Gmail's hosts,
 *   never one marked as the cancel link, and never one of two;
 * - a Slack code counts only when the mail was sent to the test email itself
 *   (any case, never its form without the `+tag` nor another tag): among the
 *   recipients mail.tm lists, else among its source's `To`, `Cc`,
 *   `Delivered-To` and `X-Original-To` headers; no test email, no code;
 * - the sign-in waits at most 2 minutes for mail received after the attempt
 *   started, types each code once, and otherwise falls back (`needs-code`),
 *   a flow error on the code prompt included;
 * - the `mailbox` command's report names a person only as "an address at
 *   <domain>" and masks every other address, and without `--show-body` shows
 *   no Slack sign-in code.
 *
 * Time is virtual (`virtualClock`); mail.tm is a scripted `fetch` fake or an
 * in-memory `MailReader`; mailbox.json lives in `memSecureFs`. Passwords and
 * tokens are sentinel-bearing fakes and sign-in codes are built at runtime;
 * captured errors, requests and log lines are leak-checked.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, spyOn, test } from 'bun:test'

import { sameInboxOtherAddress, StubWorkspace, type StubMail } from '../ci-live/dry-run/stub-state.ts'
import { FlowError, type SignInOutcome } from '../ci-live/lib/browser-types.ts'
import {
  addressForms,
  bareCode,
  DEADLINE_GRACE_MS,
  DEFAULT_MAILBOX_API,
  DEFAULT_MAILBOX_TIMEOUT_MS,
  describeForwardingMessage,
  describeLatestMessage,
  describeSender,
  extractGmailConfirmLink,
  extractGmailForwardingCode,
  extractSlackSignInCode,
  htmlToText,
  isFatalMailboxError,
  isFromDomain,
  isGmailForwardingMail,
  isSentTo,
  isSlackCodeMail,
  mailboxApiBase,
  MailboxConfigError,
  MailboxError,
  maskEmails,
  maskSubjectCodes,
  messageText,
  MailTmClient,
  parseMailboxFile,
  parseMessage,
  parseMessageList,
  parseSummary,
  rateLimitDelayMs,
  recipientsInSource,
  requestTimeoutMs,
  selectForwardingMessage,
  serializeMailboxFile,
  SLACK_SENDER_DOMAINS,
  stripControls,
  waitForSlackSignInCode,
  type MailAddress,
  type MailboxConfig,
  type MailCallOptions,
  type MailMessage,
  type MailReader,
} from '../ci-live/lib/mailbox.ts'
import { livePathsIn } from '../ci-live/lib/paths.ts'
import { Redactor, REDACTED_SECRET } from '../ci-live/lib/redact.ts'
import { NotRunnableError, SecretStore, type SecureFs } from '../ci-live/lib/secrets.ts'
import { answerSignInCodeFromMailbox, MAIL_CLOCK_SKEW_MS } from '../ci-live/lib/sign-in-code.ts'
import type { FetchLike } from '../ci-live/lib/slack-api.ts'
import { MINUTE, SECOND, type Clock } from '../ci-live/lib/wait.ts'
import { memSecureFs, virtualClock } from './test-helpers/ci-live.ts'
import { assertNoLeak, LEAK_SENTINEL } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API = 'https://api.mail.tm'
const ADDRESS = 'cscb-test@mailbox.invalid'
const PASSWORD = `mailpw-${LEAK_SENTINEL}`
const STALE_TOKEN = `mailtoken-${LEAK_SENTINEL}-stale`
const FRESH_TOKEN = `mailtoken-${LEAK_SENTINEL}-fresh`
const HUMAN = 'test-human+cscbtest@gmail.invalid'
/** The test human's inbox without the `+tag`: another account's address there (its Slack mail is forwarded too). */
const TAGLESS = 'test-human@gmail.invalid'
/** The same inbox with another tag. */
const OTHER_TAG = 'test-human+other@gmail.invalid'
const SLACK: MailAddress = { address: 'no-reply@slack.com', name: 'Slack' }
const GOOGLE: MailAddress = { address: 'forwarding-noreply@google.com', name: 'Gmail Team' }
const PERSON: MailAddress = { address: 'bob.smith@corp.invalid', name: 'Bob Smith' }
const CONFIRM_LINK = 'https://mail-settings.google.com/mail/vf-%5BAbC123%5D-XyZ789'
const CANCEL_LINK = CONFIRM_LINK.replace('/vf-', '/uf-')
const SUPPORT_LINK = 'https://support.google.com/mail/answer/184973'
/** Gmail's real subject, with no code in it. */
const FORWARDING_SUBJECT = `Gmail Forwarding Confirmation - Receive Mail from ${HUMAN}`
const T0 = Date.parse('2026-09-26T04:00:00Z')

/** The letters and digits of a stub code (no vowels, so no code spells a word). */
const CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXZ23456789'

/**
 * A Slack-shaped sign-in code (`XXX-XXX`), built at runtime; distinct `n`
 * (below 28) give distinct codes, each ending in a digit so its bare form
 * still counts as a code.
 */
function signInCode(n: number): string {
  let s = ''
  for (let i = 0, v = n * 7919 + 104_729; i < 5; i++, v = Math.floor(v / CODE_CHARS.length)) s += CODE_CHARS[v % CODE_CHARS.length]
  s += '23456789'[n % 8]
  return `${s.slice(0, 3)}-${s.slice(3)}`
}

const CODE = signInCode(1)
const OTHER_CODE = signInCode(2)
/** A six-character code without a dash (it holds a digit, as a bare code must). */
const BARE_CODE = `${bareCode(signInCode(3)).slice(0, 5)}7`

function makeConfig(overrides: Partial<MailboxConfig> = {}): MailboxConfig {
  return { api: API, address: ADDRESS, password: PASSWORD, accountId: 'acct0001', token: STALE_TOKEN, extra: {}, ...overrides }
}

function mailboxJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ provider: 'mail.tm', api: API, address: ADDRESS, password: PASSWORD, account_id: 'acct0001', token: STALE_TOKEN, ...overrides })
}

let seq = 0

/**
 * A full message; `at` is when it was received, in ms after `T0`. Ids are
 * unique across the suite. Sent to the test human (mail.tm lists the test
 * email as its recipient) unless `recipients` says otherwise.
 */
function mail(overrides: Partial<Omit<MailMessage, 'receivedAtMs'>> & { at?: number } = {}): MailMessage {
  const { at = 0, ...rest } = overrides
  seq += 1
  return {
    id: `msg${seq}`,
    from: PERSON,
    recipients: [HUMAN],
    subject: 'Hello',
    intro: '',
    createdAt: new Date(T0 + at).toISOString(),
    receivedAtMs: T0 + at,
    seen: false,
    text: '',
    html: [],
    ...rest,
  }
}

/** A message as mail.tm's `GET /messages/<id>` gives it: its recipients as `to`'s `{address, name}` objects. */
function apiMessage(m: MailMessage): Record<string, unknown> {
  const { recipients, receivedAtMs: _r, ...rest } = m
  return { ...rest, to: recipients.map((address) => ({ address, name: '' })) }
}

/** A message as an item of mail.tm's `GET /messages` (no body). */
function apiSummary(m: MailMessage): Record<string, unknown> {
  const { text: _t, html: _h, ...rest } = apiMessage(m)
  return rest
}

/** A raw message source (`GET /sources/<id>`'s `data`): `headers`, a blank line, `body`; lines end with `eol`. */
function rawSource(headers: string[], body = 'Your confirmation code is below.\n', eol = '\r\n'): string {
  return `${headers.join(eol)}${eol}${eol}${body.replace(/\r?\n/g, eol)}`
}

/**
 * The source of Slack mail to `to` that Gmail forwarded to the mailbox:
 * mail.tm's own `Delivered-To`, Gmail's forwarding headers and its
 * `Delivered-To` for `to`, and the original `To`.
 */
function forwardedSource(to: string): string {
  return rawSource([
    `Delivered-To: ${ADDRESS}`,
    `X-Forwarded-To: ${ADDRESS}`,
    `X-Forwarded-For: ${to} ${ADDRESS}`,
    `Delivered-To: ${to}`,
    `From: Slack <${SLACK.address}>`,
    `To: ${to}`,
    'Subject: Slack confirmation code',
  ])
}

/** The source of mail sent to the mailbox itself: no other recipient anywhere. */
const MAILBOX_ONLY_SOURCE = rawSource([`Delivered-To: ${ADDRESS}`, `From: Slack <${SLACK.address}>`, `To: ${ADDRESS}`, 'Subject: Slack confirmation code'])

/** Slack's code email: the code in the subject and on a line of its own in the body. */
function slackMail(code: string, overrides: Parameters<typeof mail>[0] = {}): MailMessage {
  return mail({
    from: SLACK,
    subject: `Slack confirmation code: ${code}`,
    text: `Confirm your email address\n\nYour confirmation code is below — enter it in your open browser window.\n\n${code}\n\nIf you didn't request this email, you can safely ignore it.\n`,
    ...overrides,
  })
}

/** Gmail's forwarding confirmation in its real layout: the confirm link, a paragraph naming both, the cancel link, a support link. */
function gmailLayout(confirm = CONFIRM_LINK, cancel = CANCEL_LINK): string {
  return (
    `${HUMAN} has requested to automatically forward mail to your email address ${ADDRESS}.\n\n` +
    `To allow ${HUMAN} to automatically forward mail to your address, please click the link below to confirm the request:\n\n${confirm}\n\n` +
    `If you do not approve of this request, no further action is required. ${HUMAN} cannot automatically forward messages to your email address unless you confirm the request by clicking the link above. ` +
    `If you accidentally clicked the link, but you do not want to allow ${HUMAN} to automatically forward messages to your address, click this link to cancel this verification:\n${cancel}\n\n` +
    `To learn more about why you might have received this message, please visit: ${SUPPORT_LINK}.\n`
  )
}

function gmailMail(overrides: Parameters<typeof mail>[0] = {}): MailMessage {
  return mail({ from: GOOGLE, subject: FORWARDING_SUBJECT, text: gmailLayout(), ...overrides })
}

/** Run `fn` and return what it threw (failing when it returns). */
async function rejection(fn: () => unknown): Promise<Error> {
  try {
    await fn()
  } catch (err) {
    return err as Error
  }
  throw new Error('expected a throw')
}

// ---------------------------------------------------------------------------
// mailbox.json
// ---------------------------------------------------------------------------

describe('mailbox.json', () => {
  test('parses every key, strips the api of its trailing slash and keeps keys the runner does not use', () => {
    expect(parseMailboxFile(mailboxJson({ api: `${API}/`, created_by: 'operator' }))).toEqual(makeConfig({ extra: { created_by: 'operator' } }))
  })

  test('defaults the api to mail.tm and gives null for an absent or empty account_id and token', () => {
    const text = JSON.stringify({ address: ADDRESS, password: PASSWORD, account_id: '', token: '' })
    expect(parseMailboxFile(text)).toEqual(makeConfig({ api: DEFAULT_MAILBOX_API, accountId: null, token: null }))
  })

  test('serializes back to the same config, with the provider, an updated token and the extra keys, and no null keys', () => {
    const config = makeConfig({ token: FRESH_TOKEN, extra: { created_by: 'operator' } })
    const text = serializeMailboxFile(config)
    expect(text.endsWith('}\n')).toBe(true)
    expect(JSON.parse(text)).toEqual({ provider: 'mail.tm', api: API, address: ADDRESS, password: PASSWORD, account_id: 'acct0001', token: FRESH_TOKEN, created_by: 'operator' })
    expect(parseMailboxFile(text)).toEqual(config)
    expect(Object.keys(JSON.parse(serializeMailboxFile(makeConfig({ accountId: null, token: null }))))).toEqual(['provider', 'api', 'address', 'password'])
  })

  test.each([
    ['text that is not JSON', `{"password": "${PASSWORD}"`, 'is not valid JSON'],
    ['a JSON array', JSON.stringify([PASSWORD]), 'is not a JSON object'],
    ['another provider', mailboxJson({ provider: 'guerrilla' }), 'has an unsupported provider (only mail.tm is supported)'],
    ['an http api', mailboxJson({ api: 'http://api.mail.tm' }), 'has an api that is not an https URL'],
    ['an api holding a password', mailboxJson({ api: `https://user:${PASSWORD}@api.mail.tm` }), 'has an api that is not an https URL'],
    ['an api with a query', mailboxJson({ api: `${API}/?key=${PASSWORD}` }), 'has an api that is not an https URL'],
    ['no address', mailboxJson({ address: undefined }), 'has no address, or it is not an email address'],
    ['an address that is not one', mailboxJson({ address: PASSWORD }), 'has no address, or it is not an email address'],
    ['no password', mailboxJson({ password: undefined }), 'has no password'],
    ['an empty password', mailboxJson({ password: '' }), 'has no password'],
    ['a token that is not a string', mailboxJson({ token: { value: STALE_TOKEN } }), 'has a token that is not a string'],
  ])('refuses %s with a fixed reason that holds no value', (_what, text, reason) => {
    let err: unknown
    try {
      parseMailboxFile(text)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(MailboxConfigError)
    expect((err as Error).message).toBe(reason)
    assertNoLeak(err)
  })

  test.each([
    [`${API}/`, API],
    ['https://api.mail.tm/v1//', 'https://api.mail.tm/v1'],
    ['http://127.0.0.1:4100/mailtm', 'http://127.0.0.1:4100/mailtm'],
    ['http://localhost:4100/', 'http://localhost:4100'],
    ['http://[::1]:4100/mailtm/', 'http://[::1]:4100/mailtm'],
    ['http://api.mail.tm', null],
    ['http://127.0.0.1.evil.invalid', null],
    ['https://user@api.mail.tm', null],
    [`${API}#x`, null],
    ['ftp://api.mail.tm', null],
    ['not a url', null],
  ])('mailboxApiBase(%p) is %p (https, or http on loopback for the dry run)', (value, expected) => {
    expect(mailboxApiBase(value)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Messages from the API
// ---------------------------------------------------------------------------

describe('message parsing', () => {
  const summaryJson = (id: unknown, createdAt: unknown, extra: Record<string, unknown> = {}) => ({
    id,
    from: SLACK,
    to: [{ address: HUMAN, name: 'Test Human' }],
    subject: 's',
    intro: 'i',
    createdAt,
    seen: true,
    ...extra,
  })

  test('parseSummary reads the fields it uses and parses the time', () => {
    expect(parseSummary(summaryJson('abc_12-3', '2026-09-26T04:31:58Z'))).toEqual({
      id: 'abc_12-3',
      from: SLACK,
      recipients: [HUMAN],
      subject: 's',
      intro: 'i',
      createdAt: '2026-09-26T04:31:58Z',
      receivedAtMs: Date.parse('2026-09-26T04:31:58Z'),
      seen: true,
    })
  })

  test('parseSummary fills what is missing (no sender, no recipients, an unparseable time, seen only when true)', () => {
    const s = parseSummary({ id: 'x1', createdAt: 'yesterday', seen: 'yes' })!
    expect([s.from, s.recipients, s.subject, Number.isNaN(s.receivedAtMs), s.seen]).toEqual([{ address: '', name: '' }, [], '', true, false])
  })

  test("recipients: `to`'s {address, name} objects, then `cc`'s strings (a bare address, a display name's address), each as given", () => {
    const s = parseSummary({
      id: 'r1',
      to: [
        { address: HUMAN, name: 'Test Human' },
        { address: ADDRESS, name: '' },
      ],
      cc: ['carol@corp.invalid', 'Dave Jones <Dave.Jones@corp.invalid>'],
    })!
    expect(s.recipients).toEqual([HUMAN, ADDRESS, 'carol@corp.invalid', 'Dave.Jones@corp.invalid'])
  })

  test('recipients: a `to` string counts as a `cc` string does, `Name <a@b>` giving its address; `cc` objects count as `to` objects do', () => {
    expect(parseSummary({ id: 'r1', to: [`Test Human <${HUMAN}>`, ADDRESS], cc: [{ address: PERSON.address, name: PERSON.name }] })!.recipients).toEqual([HUMAN, ADDRESS, PERSON.address])
  })

  test.each([
    ['no to', {}],
    ['a to that is a string, not a list', { to: HUMAN }],
    ['a to that is one object, not a list', { to: { address: HUMAN, name: '' } }],
    ['a to of null', { to: null }],
    ['a to whose items hold no address', { to: [7, null, { name: 'Test Human' }, { address: 7 }, { address: '' }, 'Test Human', ''] }],
    ['a cc that is a string, not a list', { cc: HUMAN }],
  ])('recipients is [] with %s', (_what, extra) => {
    expect(parseSummary({ id: 'r1', ...extra })!.recipients).toEqual([])
  })

  test('parseMessage reads the recipients as parseSummary does', () => {
    const value = { id: 'm1', to: [{ address: HUMAN, name: '' }], cc: [`Carol <carol@corp.invalid>`], text: 't' }
    expect([parseMessage(value)!.recipients, parseMessage({ id: 'm1', to: HUMAN })!.recipients]).toEqual([[HUMAN, 'carol@corp.invalid'], []])
  })

  test.each([null, 'x1', {}, { id: 7 }, { id: '' }, { id: '../x' }, { id: 'a/b' }, { id: 'x'.repeat(65) }])('parseSummary(%p) is null (no usable id)', (value) => {
    expect(parseSummary(value)).toBeNull()
  })

  test('parseMessage keeps the text and the string HTML parts (one HTML string counts as one part)', () => {
    expect([parseMessage({ id: 'm1', text: 't', html: ['<p>a</p>', 7, '<p>b</p>'] })!.html, parseMessage({ id: 'm1', html: '<p>a</p>' })!.html, parseMessage({ id: 'm1' })!.html]).toEqual([
      ['<p>a</p>', '<p>b</p>'],
      ['<p>a</p>'],
      [],
    ])
  })

  test('parseMessageList reads a plain array or a hydra:member collection, newest first, an unparseable time last', () => {
    const items = [summaryJson('old', '2026-09-26T01:00:00Z'), summaryJson('undated', ''), summaryJson('new', '2026-09-26T03:00:00Z'), { id: '../bad' }]
    expect(parseMessageList(items)!.map((s) => s.id)).toEqual(['new', 'old', 'undated'])
    expect(parseMessageList({ 'hydra:member': items, 'hydra:totalItems': 4 })!.map((s) => s.id)).toEqual(['new', 'old', 'undated'])
  })

  test.each([null, 'x', { member: [] }, { 'hydra:member': 'x' }])('parseMessageList(%p) is null', (value) => {
    expect(parseMessageList(value)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The mail.tm client
// ---------------------------------------------------------------------------

interface MailCall {
  url: string
  method: string
  path: string
  auth: string | null
  body: string
  redirect: RequestRedirect | undefined
}

type Answer = Response | Error

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

const tooMany = (retryAfter?: string): Response => new Response(null, { status: 429, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } })
const listOf = (...messages: MailMessage[]): Response => json({ 'hydra:member': messages.map(apiSummary) })

/** Which token a value is, for readable event logs. */
function tokenLabel(value: string | null | undefined): string {
  if (value === `Bearer ${STALE_TOKEN}` || value === STALE_TOKEN) return 'stale'
  if (value === `Bearer ${FRESH_TOKEN}` || value === FRESH_TOKEN) return 'fresh'
  return value === null || value === undefined ? 'none' : 'other'
}

/**
 * mail.tm as a fake `fetch`: each route (`METHOD /path?query`) answers from
 * its own queue, the last answer repeating; every request is recorded, and
 * logged to `events` with the token it carried.
 */
function mailTmFetch(routes: Record<string, Answer[]>, events: string[] = []) {
  const calls: MailCall[] = []
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url)
    const headers = (init.headers ?? {}) as Record<string, string>
    const call: MailCall = { url, method: init.method ?? 'GET', path: `${u.pathname}${u.search}`, auth: headers.Authorization ?? null, body: String(init.body ?? ''), redirect: init.redirect }
    calls.push(call)
    events.push(`${call.method} ${call.path} ${tokenLabel(call.auth)}`)
    const queue = routes[`${call.method} ${call.path}`]
    if (!queue || queue.length === 0) return json({ message: 'no such route in the test' }, 404)
    const next = queue.length > 1 ? queue.shift()! : queue[0]!
    if (next instanceof Error) throw next
    return next.clone()
  }
  return { fetch, calls }
}

interface ClientOptions {
  maxRateLimitRetries?: number
  /** The virtual clock to run on (default: a fresh one). */
  clock?: Clock
  /** How long a request on a route (`METHOD /path?query`) takes on the clock: a slow mail.tm. */
  latencyMs?: Record<string, number>
}

/**
 * A `MailTmClient` over `mailTmFetch`. `sleeps` are the client's back-offs;
 * `requestsAt` is when each request started, in ms after the client was made
 * (`start`, on the clock).
 */
function makeClient(routes: Record<string, Answer[]>, config: Partial<MailboxConfig> = {}, o: ClientOptions = {}) {
  const events: string[] = []
  const saved: MailboxConfig[] = []
  const clock = o.clock ?? virtualClock()
  const start = clock.now()
  const sleeps: number[] = []
  const requestsAt: number[] = []
  const f = mailTmFetch(routes, events)
  const client = new MailTmClient({
    config: makeConfig(config),
    fetch: async (url, init) => {
      requestsAt.push(clock.now() - start)
      const u = new URL(url)
      await clock.sleep(o.latencyMs?.[`${init.method ?? 'GET'} ${u.pathname}${u.search}`] ?? 0)
      return f.fetch(url, init)
    },
    clock: { now: clock.now, sleep: async (ms) => (sleeps.push(ms), clock.sleep(ms)) },
    onSecret: (value) => events.push(`onSecret ${tokenLabel(value)}`),
    save: (next) => {
      events.push(`save ${tokenLabel(next.token)}`)
      saved.push(next)
    },
    ...(o.maxRateLimitRetries === undefined ? {} : { maxRateLimitRetries: o.maxRateLimitRetries }),
  })
  return { client, calls: f.calls, events, saved, sleeps, requestsAt, start, elapsed: () => clock.now() - start }
}

const LIST = 'GET /messages?page=1'
const TOKEN = 'POST /token'

describe('MailTmClient', () => {
  test('lists messages with the saved token in the Authorization header only, never in a URL, and follows no redirect', async () => {
    const m = slackMail(CODE)
    const h = makeClient({ [LIST]: [listOf(m)] })
    expect((await h.client.listMessages()).map((s) => s.id)).toEqual([m.id])
    expect(h.client.address).toBe(ADDRESS)
    expect(h.calls.map((c) => [c.url, c.method, c.auth, c.redirect])).toEqual([[`${API}/messages?page=1`, 'GET', `Bearer ${STALE_TOKEN}`, 'error']])
    expect([h.events.filter((e) => e.startsWith('onSecret') || e.startsWith('save')), h.client.tokensFetched]).toEqual([[], 0])
    assertNoLeak(h.calls.map((c) => c.url))
  })

  test('getMessage fetches /messages/<id> and parses the body; an id that is not one is refused before any request', async () => {
    const m = slackMail(CODE)
    const h = makeClient({ [`GET /messages/${m.id}`]: [json(apiMessage(m))] })
    expect(await h.client.getMessage(m.id)).toEqual(m)
    const err = await rejection(() => h.client.getMessage('../token'))
    expect([err instanceof MailboxError, err.message]).toEqual([true, 'mail.tm message: parse'])
    expect(h.calls.map((c) => c.path)).toEqual([`/messages/${m.id}`])
  })

  describe('getSource', () => {
    const SOURCE_ROUTE = 'GET /sources/abc_12-3'
    const sourceAnswer = (data: unknown): Response => json({ '@id': '/sources/abc_12-3', '@type': 'Source', id: 'abc_12-3', downloadUrl: '/sources/abc_12-3/download', data })

    test("fetches /sources/<id> with the token in the Authorization header only, follows no redirect, and gives the answer's data as it is", async () => {
      const data = forwardedSource(HUMAN)
      const h = makeClient({ [SOURCE_ROUTE]: [sourceAnswer(data)] })
      expect(await h.client.getSource('abc_12-3')).toBe(data)
      expect(h.calls.map((c) => [c.url, c.method, c.auth, c.redirect])).toEqual([[`${API}/sources/abc_12-3`, 'GET', `Bearer ${STALE_TOKEN}`, 'error']])
      assertNoLeak(h.calls.map((c) => c.url))
    })

    test('a 401 gets one fresh token, registered before it is saved, and the retry carries it', async () => {
      const data = forwardedSource(HUMAN)
      const h = makeClient({ [SOURCE_ROUTE]: [json({ code: 401 }, 401), sourceAnswer(data)], [TOKEN]: [json({ token: FRESH_TOKEN })] })
      expect(await h.client.getSource('abc_12-3')).toBe(data)
      expect(h.events).toEqual([`${SOURCE_ROUTE} stale`, `${TOKEN} none`, 'onSecret fresh', 'save fresh', `${SOURCE_ROUTE} fresh`])
      expect(h.saved).toEqual([makeConfig({ token: FRESH_TOKEN })])
    })

    test.each(['../token', 'a/b', '', 'x'.repeat(65), 'id?page=2', 'id#x'])('an id that is not one (%p) is refused before any request', async (id) => {
      const h = makeClient({ [SOURCE_ROUTE]: [sourceAnswer(forwardedSource(HUMAN))] })
      const err = await rejection(() => h.client.getSource(id))
      expect([err instanceof MailboxError, (err as MailboxError).kind, err.message]).toEqual([true, 'parse', 'mail.tm source: parse'])
      expect(h.calls).toEqual([])
    })

    test.each([
      ['no data', json({ id: 'abc_12-3' }), 'mail.tm source: parse'],
      ['data that is a number', sourceAnswer(7), 'mail.tm source: parse'],
      ['data of null', sourceAnswer(null), 'mail.tm source: parse'],
      ['data that is an object', sourceAnswer({ headers: [HUMAN] }), 'mail.tm source: parse'],
      ['a JSON array', json([forwardedSource(HUMAN)]), 'mail.tm source: parse'],
      ['a body that is not JSON', new Response(`Delivered-To: ${HUMAN}\r\n\r\n${STALE_TOKEN}`, { status: 200 }), 'mail.tm source: parse'],
      ['a 404 whose body quotes the token', json({ message: STALE_TOKEN }, 404), 'mail.tm source: http 404'],
    ])('an answer with %s is an error naming only the call and the kind (transient)', async (_what, answer, message) => {
      const h = makeClient({ [SOURCE_ROUTE]: [answer] })
      const err = await rejection(() => h.client.getSource('abc_12-3'))
      expect([err instanceof MailboxError, err.message, isFatalMailboxError(err)]).toEqual([true, message, false])
      assertNoLeak(err)
    })

    test('keeps a deadline as the other calls do: one already passed sends no request', async () => {
      const h = makeClient({ [SOURCE_ROUTE]: [sourceAnswer(forwardedSource(HUMAN))] })
      const err = await rejection(() => h.client.getSource('abc_12-3', { deadline: h.start - 1 }))
      expect([(err as MailboxError).kind, err.message, h.calls]).toEqual(['timeout', 'mail.tm source: timeout', []])
    })
  })

  test('a 401 gets one fresh token (password only in the POST body), registers it before saving it, and retries with it', async () => {
    const h = makeClient({ [LIST]: [json({ code: 401 }, 401), listOf()], [TOKEN]: [json({ id: 'acct0001', token: FRESH_TOKEN })] })
    expect(await h.client.listMessages()).toEqual([])
    expect(h.events).toEqual([`${LIST} stale`, `${TOKEN} none`, 'onSecret fresh', 'save fresh', `${LIST} fresh`])
    const tokenCall = h.calls.find((c) => c.method === 'POST')!
    expect(JSON.parse(tokenCall.body)).toEqual({ address: ADDRESS, password: PASSWORD })
    expect(h.saved).toEqual([makeConfig({ token: FRESH_TOKEN })])
    expect(h.client.tokensFetched).toBe(1)
    assertNoLeak(h.calls.map((c) => c.url))
  })

  test('with no saved token, the first call fetches one before any GET', async () => {
    const h = makeClient({ [LIST]: [listOf()], [TOKEN]: [json({ token: FRESH_TOKEN })] }, { token: null })
    await h.client.listMessages()
    expect(h.events).toEqual([`${TOKEN} none`, 'onSecret fresh', 'save fresh', `${LIST} fresh`])
  })

  test('a 401 with the fresh token too is an auth error, after exactly one refresh', async () => {
    const h = makeClient({ [LIST]: [json({ code: 401, message: PASSWORD }, 401)], [TOKEN]: [json({ token: FRESH_TOKEN })] })
    const err = await rejection(() => h.client.listMessages())
    expect([err instanceof MailboxError, (err as MailboxError).kind, (err as MailboxError).status, err.message]).toEqual([true, 'auth', 401, 'mail.tm messages: auth 401'])
    expect(h.events).toEqual([`${LIST} stale`, `${TOKEN} none`, 'onSecret fresh', 'save fresh', `${LIST} fresh`])
    expect(isFatalMailboxError(err)).toBe(true)
    assertNoLeak(err)
  })

  test.each([400, 401])('POST /token refused with %p (a wrong address or password) is an auth error, and nothing is saved', async (status) => {
    const h = makeClient({ [LIST]: [json({}, 401)], [TOKEN]: [json({ message: `Invalid credentials ${PASSWORD}` }, status)] })
    const err = await rejection(() => h.client.listMessages())
    expect([(err as MailboxError).call, (err as MailboxError).kind, err.message]).toEqual(['token', 'auth', `mail.tm token: auth ${status}`])
    expect(h.saved).toEqual([])
    assertNoLeak(err)
  })

  test.each([
    ['no token in the answer', json({ id: 'acct0001' })],
    ['an empty token', json({ token: '' })],
    ['a body that is not JSON', new Response(`not json ${PASSWORD}`, { status: 200 })],
  ])('POST /token with %s is a parse error, and nothing is saved', async (_what, answer) => {
    const h = makeClient({ [LIST]: [json({}, 401)], [TOKEN]: [answer] })
    const err = await rejection(() => h.client.listMessages())
    expect(err.message).toBe('mail.tm token: parse')
    expect([h.saved, h.events.filter((e) => e.startsWith('onSecret'))]).toEqual([[], []])
    assertNoLeak(err)
  })

  test('a 429 backs off by its Retry-After, else 1, 2, 4 … s, on the injected clock, then retries', async () => {
    const h = makeClient({ [LIST]: [tooMany('3'), tooMany(), tooMany(), listOf()] })
    expect(await h.client.listMessages()).toEqual([])
    expect([h.sleeps, h.client.rateLimitedCount, h.calls.length]).toEqual([[3000, 2000, 4000], 3, 4])
  })

  test('a 429 after 4 retries is a rate-limited error (5 requests in all, 15 s of back-off)', async () => {
    const h = makeClient({ [LIST]: [tooMany()] })
    const err = await rejection(() => h.client.listMessages())
    expect([(err as MailboxError).kind, (err as MailboxError).status, err.message]).toEqual(['rate-limited', 429, 'mail.tm messages: rate-limited 429'])
    expect([h.calls.length, h.sleeps, h.elapsed()]).toEqual([5, [1000, 2000, 4000, 8000], 15 * SECOND])
    expect(isFatalMailboxError(err)).toBe(false)
  })

  test('the retry bound is an option', async () => {
    const h = makeClient({ [LIST]: [tooMany()] }, {}, { maxRateLimitRetries: 1 })
    await rejection(() => h.client.listMessages())
    expect([h.calls.length, h.sleeps]).toEqual([2, [1000]])
  })

  describe('a call given a deadline ends by it', () => {
    test.each([
      ['no Retry-After, 5 s left: backs off 1 s and 2 s, then gives up at 3 s rather than wait 4 s more', undefined, 5 * SECOND, [1000, 2000], [0, 1000, 3000], 2, 3 * SECOND],
      ['Retry-After 30, 10 s left: gives up at once', '30', 10 * SECOND, [], [0], 0, 0],
    ] as Array<[string, string | undefined, number, number[], number[], number, number]>)('a 429 whose back-off would end past the deadline is not waited out (%s)', async (_what, retryAfter, leftMs, sleeps, requestsAt, backedOff, elapsed) => {
      const h = makeClient({ [LIST]: [tooMany(retryAfter)] })
      const err = await rejection(() => h.client.listMessages({ deadline: h.start + leftMs }))
      expect([(err as MailboxError).kind, (err as MailboxError).status, err.message]).toEqual(['rate-limited', 429, 'mail.tm messages: rate-limited 429'])
      expect([h.sleeps, h.requestsAt, h.client.rateLimitedCount, h.elapsed()]).toEqual([sleeps, requestsAt, backedOff, elapsed])
    })

    test.each([
      ['a saved token', STALE_TOKEN, 'mail.tm messages: timeout'],
      ['no saved token (the call would fetch one first)', null, 'mail.tm token: timeout'],
    ])('a deadline already passed, with %s: no request at all, and a timeout error (transient)', async (_what, token, message) => {
      const h = makeClient({ [LIST]: [listOf()], [TOKEN]: [json({ token: FRESH_TOKEN })] }, { token })
      const err = await rejection(() => h.client.listMessages({ deadline: h.start - 1 }))
      expect([err instanceof MailboxError, (err as MailboxError).kind, err.message, isFatalMailboxError(err)]).toEqual([true, 'timeout', message, false])
      expect([h.calls, h.saved]).toEqual([[], []])
    })

    test.each([
      ['a 401 that answers after the deadline: the token refresh keeps it, so no POST /token', { [LIST]: 6 * SECOND }, [`${LIST} stale`], 'mail.tm token: timeout'],
      ['a token that arrives after the deadline: saved, but the retry is not sent', { [TOKEN]: 6 * SECOND }, [`${LIST} stale`, `${TOKEN} none`, 'onSecret fresh', 'save fresh'], 'mail.tm messages: timeout'],
    ])('%s', async (_what, latencyMs, events, message) => {
      const h = makeClient({ [LIST]: [json({}, 401), listOf()], [TOKEN]: [json({ token: FRESH_TOKEN })] }, {}, { latencyMs })
      const err = await rejection(() => h.client.listMessages({ deadline: h.start + 5 * SECOND }))
      expect([(err as MailboxError).kind, err.message]).toEqual(['timeout', message])
      expect(h.events).toEqual(events)
      assertNoLeak(err)
    })

    test("a request's timeout is cut to what is left, never below DEADLINE_GRACE_MS; without a deadline it is the client's own", async () => {
      const timeout = spyOn(AbortSignal, 'timeout')
      try {
        const h = makeClient({ [LIST]: [tooMany('3'), listOf()] })
        // The first request with 3.5 s left, the retry after the 3 s back-off with 0.5 s left.
        expect(await h.client.listMessages({ deadline: h.start + 3500 })).toEqual([])
        await makeClient({ [LIST]: [listOf()] }).client.listMessages()
        expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([3500, DEADLINE_GRACE_MS, DEFAULT_MAILBOX_TIMEOUT_MS])
      } finally {
        timeout.mockRestore()
      }
    })
  })

  test.each([
    ['no deadline', 30_000, DEFAULT_MAILBOX_TIMEOUT_MS, undefined],
    ['a deadline far off', 30_000, DEFAULT_MAILBOX_TIMEOUT_MS, 10 * MINUTE],
    ['10 s left', 10_000, DEFAULT_MAILBOX_TIMEOUT_MS, 10 * SECOND],
    ['300 ms left', 1000, DEFAULT_MAILBOX_TIMEOUT_MS, 300],
    ['the deadline passed', 1000, DEFAULT_MAILBOX_TIMEOUT_MS, -5 * SECOND],
    ['a client timeout of 500 ms, no time left', 500, 500, 0],
  ])("requestTimeoutMs with %s is %p ms (the client's own, cut to what is left, never below DEADLINE_GRACE_MS nor above the client's own)", (_what, expected, timeoutMs, leftMs) => {
    expect(requestTimeoutMs(timeoutMs, T0, leftMs === undefined ? undefined : T0 + leftMs)).toBe(expected)
  })

  test.each([
    ['a network failure quoting the password', new TypeError(`fetch failed for ${PASSWORD}`), 'network', undefined],
    ['a timeout', new DOMException(`timed out ${STALE_TOKEN}`, 'TimeoutError'), 'timeout', undefined],
    ['an abort', new DOMException('aborted', 'AbortError'), 'timeout', undefined],
    ['a 500 whose body quotes the token', json({ error: STALE_TOKEN }, 500), 'http', 500],
    ['a 404', json({}, 404), 'http', 404],
    ['a 200 that is not JSON', new Response(`<html>${STALE_TOKEN}</html>`, { status: 200 }), 'parse', undefined],
    ['a 200 that is not a message list', json({ items: [] }), 'parse', undefined],
  ] as const)('%s is a %s error that names only the call, the kind and the status (transient: polling may go on)', async (_what, answer, kind, status) => {
    const h = makeClient({ [LIST]: [answer as Answer] })
    const err = await rejection(() => h.client.listMessages())
    expect(err).toBeInstanceOf(MailboxError)
    expect([(err as MailboxError).kind, (err as MailboxError).status, err.message]).toEqual([kind, status, `mail.tm messages: ${kind}${status === undefined ? '' : ` ${status}`}`])
    expect(isFatalMailboxError(err)).toBe(false)
    assertNoLeak(err)
  })

  test.each([
    [null, 0, 1000],
    [null, 1, 2000],
    [null, 2, 4000],
    [null, 5, 30_000],
    ['3', 0, 3000],
    ['1.5', 3, 1500],
    ['120', 0, 30_000],
    ['0', 2, 4000],
    ['-1', 0, 1000],
    ['Wed, 21 Oct 2026 07:28:00 GMT', 1, 2000],
  ])('rateLimitDelayMs(%p, attempt %p) is %p ms (Retry-After when positive, else doubling; at most 30 s)', (retryAfter, attempt, ms) => {
    expect(rateLimitDelayMs(retryAfter, attempt)).toBe(ms)
  })

  test.each([
    ['an auth error', new MailboxError('messages', 'auth', 401), true],
    ['a thrown value that is not a MailboxError', new Error('boom'), true],
    ['a network error', new MailboxError('messages', 'network'), false],
    ['a 503', new MailboxError('messages', 'http', 503), false],
    ['a parse error', new MailboxError('message', 'parse'), false],
  ])('isFatalMailboxError: %s → %p', (_what, err, fatal) => {
    expect(isFatalMailboxError(err)).toBe(fatal)
  })
})

describe('a token refresh through the SecretStore', () => {
  const CONFIG_DIR = '/home/tester/.config/cscb-test'

  test('rewrites mailbox.json mode 600 (temp file, then rename) with the fresh token, registered with the redactor before the write', async () => {
    const mem = memSecureFs()
    const redactor = new Redactor()
    const paths = livePathsIn(CONFIG_DIR)
    const maskedAtWrite: boolean[] = []
    const fs: SecureFs = {
      ...mem.fs,
      writeFile: (path, data, mode) => {
        maskedAtWrite.push(!redactor.redact(data).includes(FRESH_TOKEN) && !redactor.redact(data).includes(PASSWORD))
        mem.fs.writeFile(path, data, mode)
      },
    }
    const store = new SecretStore({ fs, paths, env: {}, redactor, dryRun: false, realConfigDir: CONFIG_DIR })
    mem.seed(paths.mailboxJson, mailboxJson({ created_by: 'operator' }))
    const secretsSeen: string[] = []
    const f = mailTmFetch({ [LIST]: [json({}, 401), listOf()], [TOKEN]: [json({ token: FRESH_TOKEN })] })
    const client = new MailTmClient({
      config: store.readMailbox()!,
      fetch: f.fetch,
      clock: virtualClock(),
      onSecret: (value) => {
        secretsSeen.push(tokenLabel(value))
        redactor.addSecret(value)
      },
      save: (next) => store.writeMailbox(next),
    })
    const opsBefore = mem.ops.length
    await client.listMessages()

    const writes = mem.ops.slice(opsBefore).filter((op) => !op.startsWith('stat '))
    const tmp = writes[0]!.split(' ')[1]!
    expect(tmp.startsWith(`${CONFIG_DIR}/.mailbox.json.tmp-`)).toBe(true)
    expect(writes).toEqual([`writeFile ${tmp} 600`, `chmod ${tmp} 600`, `rename ${tmp} ${paths.mailboxJson}`])
    expect([maskedAtWrite, secretsSeen]).toEqual([[true], ['fresh']])
    const file = mem.files.get(paths.mailboxJson)!
    expect(file.mode).toBe(0o600)
    expect(parseMailboxFile(file.data)).toEqual(makeConfig({ token: FRESH_TOKEN, extra: { created_by: 'operator' } }))
    expect(redactor.redact(`${PASSWORD} ${STALE_TOKEN} ${FRESH_TOKEN}`)).toBe(`${REDACTED_SECRET} ${REDACTED_SECRET} ${REDACTED_SECRET}`)
    expect(() => store.assertLayoutPrivate()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Text and senders
// ---------------------------------------------------------------------------

describe('htmlToText and messageText', () => {
  test('block ends and <br> become line breaks; style, script and head go; entities are decoded; an unknown entity stays', () => {
    const html = '<head><title>t</title></head><style>p{}</style><p>a&amp;b&#39;c&#x41;&nbsp;d&bogus;</p><div>e</div>f<br/>g<script>x()</script>'
    expect(htmlToText(html)).toBe("a&b'cA d&bogus;\ne\nf\ng")
  })

  test('messageText prefers the text part and falls back to the HTML parts when it is blank', () => {
    expect([messageText({ text: 'plain', html: ['<p>h</p>'] }), messageText({ text: ' \n', html: ['<p>a</p>', '<p>b</p>'] })]).toEqual(['plain', 'a\n\nb\n'])
  })
})

describe('isFromDomain', () => {
  test.each([
    ['no-reply@slack.com', true],
    ['feedback@email.slack.com', true],
    ['x@slack-mail.com', true],
    ['NO-REPLY@SLACK.COM', true],
    ['no-reply@slack.com ', true],
    ['no-reply@slack.com.mailbox.invalid', false],
    ['no-reply@notslack.com', false],
    ['no-reply@evil-slack.com', false],
    ['slack.com@evil.invalid', false],
    ['no-reply@slack.com.', false],
    ['@slack.com', false],
    ['slack.com', false],
    ['', false],
  ])('%p is at a Slack domain: %p', (address, expected) => {
    expect(isFromDomain(address, SLACK_SENDER_DOMAINS)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

describe('extractSlackSignInCode', () => {
  test.each([
    ["Slack's layout (the subject and the body agree)", () => slackMail(CODE), CODE],
    ['the body without the dash, the subject with it (shown as the subject has it)', () => slackMail(CODE, { text: `\n${bareCode(CODE)}\n` }), CODE],
    ['the subject only', () => slackMail(CODE, { text: 'Enter the code from the subject.' }), CODE],
    ['the body only', () => slackMail(CODE, { subject: 'Your Slack confirmation code' }), CODE],
    ['a six-character code with a digit and no dash', () => slackMail(BARE_CODE), BARE_CODE],
    ['the HTML part only', () => slackMail(CODE, { subject: 'Slack confirmation code', text: '', html: [`<html><body><h1>Confirm</h1><p>Your code:</p><div>${CODE}</div></body></html>`] }), CODE],
    ['a Slack subdomain sender', () => slackMail(CODE, { from: { address: 'feedback@email.slack.com', name: '' } }), CODE],
    ['the slack-mail.com sender', () => slackMail(CODE, { from: { address: 'no-reply@slack-mail.com', name: 'Slack' } }), CODE],
    ['a login-code subject ("is" before the code)', () => slackMail(CODE, { subject: `Your Slack login code is ${CODE}` }), CODE],
  ])('reads %s', (_what, message, expected) => {
    expect(extractSlackSignInCode(message())).toBe(expected)
  })

  test.each([
    ['a look-alike sender at slack.com.mailbox.invalid', () => slackMail(CODE, { from: { address: 'no-reply@slack.com.mailbox.invalid', name: 'Slack' } })],
    ['a sender at notslack.com', () => slackMail(CODE, { from: { address: 'no-reply@notslack.com', name: 'Slack' } })],
    ['a sender whose local part is slack.com', () => slackMail(CODE, { from: { address: 'slack.com@evil.invalid', name: 'Slack' } })],
    ['a person forwarding a code', () => slackMail(CODE, { from: PERSON })],
    ['a subject that names no code', () => slackMail(CODE, { subject: 'Welcome to Slack' })],
    ['a subject and a body that disagree', () => slackMail(CODE, { text: `\n${OTHER_CODE}\n` })],
    ['a body with two different codes', () => slackMail(CODE, { subject: 'Slack confirmation code', text: `${CODE}\n${OTHER_CODE}\n` })],
    ['a lower-case code', () => slackMail(CODE.toLowerCase(), { subject: 'Slack confirmation code', text: `\n${CODE.toLowerCase()}\n` })],
    ['an all-capitals word (no digit) on a line of its own', () => slackMail(CODE, { subject: 'Slack confirmation code', text: 'Hello\nTHANKS\n' })],
    ['a code inside a sentence, not on a line of its own', () => slackMail(CODE, { subject: 'Slack confirmation code', text: `Your code is ${CODE} today.` })],
    ['a subject code followed by more characters', () => slackMail(CODE, { subject: `Slack confirmation code: ${CODE}X`, text: '' })],
  ])('gives null for %s', (_what, message) => {
    expect(extractSlackSignInCode(message())).toBeNull()
  })

  test("isSlackCodeMail reads only the sender and the subject (the wait's filter before a message is fetched)", () => {
    expect([isSlackCodeMail(slackMail(CODE, { text: '' })), isSlackCodeMail(slackMail(CODE, { from: PERSON }))]).toEqual([true, false])
  })
})

describe('Gmail forwarding confirmation: isGmailForwardingMail and extractGmailForwardingCode', () => {
  const NUMBER = '705005922'
  const withCode = (overrides: Parameters<typeof mail>[0] = {}) =>
    gmailMail({ subject: `(#${NUMBER}) ${FORWARDING_SUBJECT}`, text: `Confirmation code: ${NUMBER}\n\n${gmailLayout()}`, ...overrides })

  test.each([
    ["Gmail's real subject (no code in it)", gmailMail(), true],
    ['a subject with the code', withCode(), true],
    ['a Google subdomain sender', gmailMail({ from: { address: 'forwarding-noreply@mail.google.com', name: '' } }), true],
    ['a look-alike Google sender', gmailMail({ from: { address: 'forwarding-noreply@google.com.mailbox.invalid', name: 'Gmail Team' } }), false],
    ['a person', gmailMail({ from: PERSON }), false],
    ['another Google subject', gmailMail({ subject: 'Security alert' }), false],
  ])('isGmailForwardingMail: %s → %p', (_what, message, expected) => {
    expect(isGmailForwardingMail(message)).toBe(expected)
  })

  test.each([
    ['the subject and the body agree', withCode(), NUMBER],
    ['the subject only', withCode({ text: gmailLayout() }), NUMBER],
    ['the body only', withCode({ subject: FORWARDING_SUBJECT }), NUMBER],
    ['the body with no colon, the number on the next line', withCode({ subject: FORWARDING_SUBJECT, text: `send the confirmation code\n${NUMBER} to ${HUMAN}` }), NUMBER],
    ["Gmail's real layout, with no code", gmailMail(), null],
    ['a subject and a body that disagree', withCode({ text: 'Confirmation code: 123456780' }), null],
    ['a number too short to be one', withCode({ subject: FORWARDING_SUBJECT, text: 'Confirmation code: 1234' }), null],
    ['a look-alike sender', withCode({ from: { address: 'forwarding-noreply@google.com.mailbox.invalid', name: 'Gmail Team' } }), null],
  ])('extractGmailForwardingCode: %s → %p', (_what, message, expected) => {
    expect(extractGmailForwardingCode(message)).toBe(expected)
  })
})

describe('extractGmailConfirmLink', () => {
  const confirmLead = 'please click the link below to confirm the request:\n\n'
  const cancelLead = 'click this link to cancel this verification:\n'

  test.each([
    ["Gmail's layout: the confirm link, not the cancel or support link", () => gmailMail(), CONFIRM_LINK],
    ['a /vf- link with no word before it', () => gmailMail({ text: `Here: ${CONFIRM_LINK}\n` }), CONFIRM_LINK],
    ['a trailing period, stripped', () => gmailMail({ text: `${confirmLead}${CONFIRM_LINK}.` }), CONFIRM_LINK],
    [
      'the HTML part only: the anchor target, &amp; decoded',
      () => gmailMail({ text: '', html: [`<p>To confirm the request, <a href="${CONFIRM_LINK}?a=1&amp;b=2">click here</a>.</p>`] }),
      `${CONFIRM_LINK}?a=1&b=2`,
    ],
    [
      'the same link in the text and the HTML part (one link, not two)',
      () => gmailMail({ html: [`<p>${confirmLead}<a href="${CONFIRM_LINK}">${CONFIRM_LINK}</a></p><p>${cancelLead}<a href="${CANCEL_LINK}">${CANCEL_LINK}</a></p>`] }),
      CONFIRM_LINK,
    ],
    ['a link on google.com', () => gmailMail({ text: `${confirmLead}https://google.com/mail/vf-x` }), 'https://google.com/mail/vf-x'],
  ])('finds %s', (_what, message, expected) => {
    expect(extractGmailConfirmLink(message())).toBe(expected)
  })

  test.each([
    ['only the cancel link', () => gmailMail({ text: `${cancelLead}${CANCEL_LINK}\n` })],
    ['a /vf- link with "cancel" before it', () => gmailMail({ text: `${cancelLead}${CONFIRM_LINK}\n` })],
    ['a /uf- link with "confirm" before it', () => gmailMail({ text: `${confirmLead}${CANCEL_LINK}\n` })],
    ['a look-alike host (mail-settings.google.com.evil.invalid)', () => gmailMail({ text: `${confirmLead}https://mail-settings.google.com.evil.invalid/mail/vf-x\n` })],
    ['a host behind userinfo (mail-settings.google.com@evil.invalid)', () => gmailMail({ text: `${confirmLead}https://mail-settings.google.com@evil.invalid/mail/vf-x\n` })],
    ["Gmail's host with userinfo (evil.invalid@mail-settings.google.com)", () => gmailMail({ text: `${confirmLead}https://evil.invalid@mail-settings.google.com/mail/vf-x\n` })],
    ['support.google.com', () => gmailMail({ text: `${confirmLead}https://support.google.com/mail/vf-x\n` })],
    ['http', () => gmailMail({ text: `${confirmLead}http://mail-settings.google.com/mail/vf-x\n` })],
    ['https with a port', () => gmailMail({ text: `${confirmLead}https://mail-settings.google.com:8443/mail/vf-x\n` })],
    ['two different confirm links', () => gmailMail({ text: `${confirmLead}${CONFIRM_LINK}\n\nor ${confirmLead}${CONFIRM_LINK}-2\n` })],
    ['the cancel marking in the HTML part, the confirm marking in the text part', () => gmailMail({ text: `${confirmLead}${CONFIRM_LINK}\n`, html: [`<p>${cancelLead}<a href="${CONFIRM_LINK}">here</a></p>`] })],
    ['a link marked neither way and not a /vf- path', () => gmailMail({ text: `Here: https://mail-settings.google.com/mail/x\n` })],
    ['a look-alike Google sender', () => gmailMail({ from: { address: 'forwarding-noreply@google.com.mailbox.invalid', name: 'Gmail Team' } })],
    ['a person', () => gmailMail({ from: PERSON })],
    ['a subject that is not a forwarding confirmation', () => gmailMail({ subject: 'Security alert' })],
  ])('gives null for %s', (_what, message) => {
    expect(extractGmailConfirmLink(message())).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Whom a message was sent to
// ---------------------------------------------------------------------------

describe('recipientsInSource', () => {
  test('reads To, Cc, every Delivered-To and X-Original-To, in order, and nothing else: not X-Forwarded-For, From, Reply-To, a subject or the body', () => {
    const source = rawSource(
      [
        `Delivered-To: ${ADDRESS}`,
        `X-Original-To: ${HUMAN}`,
        `X-Forwarded-For: ${OTHER_TAG} ${ADDRESS}`,
        `Delivered-To: ${TAGLESS}`,
        `From: Slack <${SLACK.address}>`,
        `Reply-To: ${PERSON.address}`,
        `To: "Test Human" <${HUMAN}>, bob@corp.invalid`,
        'Cc: carol@corp.invalid',
        'Subject: To: dave@corp.invalid',
      ],
      'To: erin@corp.invalid\nDelivered-To: frank@corp.invalid\nCc: grace@corp.invalid\n',
    )
    expect(recipientsInSource(source)).toEqual([ADDRESS, HUMAN, TAGLESS, HUMAN, 'bob@corp.invalid', 'carol@corp.invalid'])
  })

  test('a folded header (continued on lines that start with a space or a tab) is read whole; a folded header of another kind is not read', () => {
    const source = rawSource([`To:\r\n ${HUMAN},\r\n\t${PERSON.address}`, `Subject: sign-in\r\n To: ${OTHER_TAG}`, `X-Forwarded-For:\r\n ${TAGLESS}`])
    expect(recipientsInSource(source)).toEqual([HUMAN, PERSON.address])
  })

  test.each([
    ['CRLF', '\r\n'],
    ['LF', '\n'],
  ])('reads a source with %s line ends, folded lines included, and stops at the blank line', (_what, eol) => {
    const source = [`Delivered-To: ${HUMAN}`, `To:${eol} ${ADDRESS}`, 'Subject: s', '', `To: ${PERSON.address}`, `Delivered-To: ${TAGLESS}`].join(eol)
    expect(recipientsInSource(source)).toEqual([HUMAN, ADDRESS])
  })

  test('header names count in any case', () => {
    const source = rawSource([`TO: ${HUMAN}`, `delivered-to: ${ADDRESS}`, 'cC: carol@corp.invalid', `x-original-to: ${TAGLESS}`])
    expect(recipientsInSource(source)).toEqual([HUMAN, ADDRESS, 'carol@corp.invalid', TAGLESS])
  })

  test.each([
    ['an empty source', ''],
    ['no recipient header', rawSource([`From: Slack <${SLACK.address}>`, `X-Forwarded-For: ${HUMAN} ${ADDRESS}`, 'Subject: Slack confirmation code'])],
    ['recipient headers with no address', rawSource(['To: undisclosed-recipients:;', 'Cc:', 'Delivered-To: '])],
    ['a body alone (the source starts with the blank line)', `\r\n\r\nTo: ${HUMAN}\r\n`],
  ])('%s gives []', (_what, source) => {
    expect(recipientsInSource(source)).toEqual([])
  })
})

describe('isSentTo', () => {
  test.each([
    ['the test email as it is', [HUMAN], HUMAN, true],
    ['in another case', [HUMAN.toUpperCase()], HUMAN, true],
    ['the test email given in another case', [HUMAN], HUMAN.toUpperCase(), true],
    ['with spaces around either', [` ${HUMAN} `], `\t${HUMAN} `, true],
    ['among other recipients', [ADDRESS, PERSON.address, HUMAN], HUMAN, true],
    ['only its form without the +tag (another account of the same inbox)', [TAGLESS], HUMAN, false],
    ['only the same inbox with another tag', [OTHER_TAG], HUMAN, false],
    ['only a tagged form, the test email having no tag', [HUMAN], TAGLESS, false],
    ['only a longer address that ends with it', [`x${HUMAN}`], HUMAN, false],
    ['only the mailbox itself', [ADDRESS], HUMAN, false],
    ['no recipients', [], HUMAN, false],
    ['an empty test email (even beside an empty recipient)', ['', HUMAN], '', false],
    ['a blank test email', [' ', HUMAN], '  ', false],
  ])('%s: %p', (_what, recipients, email, expected) => {
    expect(isSentTo(recipients, email)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Waiting for Slack's code
// ---------------------------------------------------------------------------

interface ReaderScript {
  /** Thrown by the next list calls, in order. */
  listErrors?: unknown[]
  /** Thrown by the next getMessage calls, in order. */
  getErrors?: unknown[]
  /** Thrown by the next getSource calls, in order. */
  sourceErrors?: unknown[]
  /** Each message's raw source, by id (default: `MAILBOX_ONLY_SOURCE`). */
  sources?: Record<string, string>
}

/**
 * An in-memory mailbox: a message is listed once the clock reaches its receipt
 * time. `options` holds what each call (in `calls`' order) was given.
 */
function fakeReader(clock: Clock, messages: MailMessage[], script: ReaderScript = {}) {
  const calls: string[] = []
  const options: Array<MailCallOptions | undefined> = []
  const reader: MailReader = {
    address: ADDRESS,
    async listMessages(o) {
      calls.push(`list @${(clock.now() - T0) / SECOND}s`)
      options.push(o)
      const err = script.listErrors?.shift()
      if (err) throw err
      return messages.filter((m) => m.receivedAtMs <= clock.now()).sort((a, b) => b.receivedAtMs - a.receivedAtMs)
    },
    async getMessage(id, o) {
      calls.push(`get ${id}`)
      options.push(o)
      const err = script.getErrors?.shift()
      if (err) throw err
      return messages.find((m) => m.id === id)!
    },
    async getSource(id, o) {
      calls.push(`source ${id}`)
      options.push(o)
      const err = script.sourceErrors?.shift()
      if (err) throw err
      return script.sources?.[id] ?? MAILBOX_ONLY_SOURCE
    },
  }
  return { reader, calls, options }
}

describe('waitForSlackSignInCode', () => {
  const options = (clock: Clock, exclude = new Set<string>(), onTransientError?: (err: unknown) => void) => ({
    sinceMs: T0 - MAIL_CLOCK_SKEW_MS,
    testEmail: HUMAN,
    timeoutMs: 2 * MINUTE,
    pollMs: 5 * SECOND,
    clock,
    exclude,
    onTransientError,
  })

  test('takes the newest Slack code received since the start, fetching only Slack code mail it has not seen', async () => {
    const clock = virtualClock(T0)
    const old = slackMail(OTHER_CODE, { at: -10 * SECOND })
    const lookAlike = slackMail(OTHER_CODE, { at: 1 * SECOND, from: { address: 'no-reply@slack.com.mailbox.invalid', name: 'Slack' } })
    const seen = slackMail(OTHER_CODE, { at: 2 * SECOND })
    const person = mail({ at: 3 * SECOND })
    const found = slackMail(CODE, { at: -4 * SECOND })
    const r = fakeReader(clock, [old, lookAlike, seen, person, found])
    const exclude = new Set([seen.id])
    expect(await waitForSlackSignInCode(r.reader, options(clock, exclude))).toEqual({ id: found.id, code: CODE })
    expect(r.calls).toEqual(['list @0s', `get ${found.id}`])
    expect([...exclude]).toEqual([seen.id, found.id])
  })

  test('a Slack mail with no usable code is read once, skipped for an older one in the same poll, and not fetched again', async () => {
    const clock = virtualClock(T0)
    const noCode = slackMail(CODE, { at: 20 * SECOND, text: `\n${OTHER_CODE}\n` })
    const good = slackMail(CODE, { at: 10 * SECOND })
    const r = fakeReader(clock, [noCode, good])
    await clock.fake.advance(20 * SECOND)
    const exclude = new Set<string>()
    expect(await waitForSlackSignInCode(r.reader, options(clock, exclude))).toEqual({ id: good.id, code: CODE })
    expect(r.calls).toEqual(['list @20s', `get ${noCode.id}`, `get ${good.id}`])
    expect(await waitForSlackSignInCode(r.reader, { ...options(clock, exclude), timeoutMs: 0 })).toBeNull()
    expect(r.calls.filter((c) => c.startsWith('get')).length).toBe(2)
  })

  test('polls every 5 s until mail arrives, and gives null at the deadline, never sleeping past it', async () => {
    const clock = virtualClock(T0)
    const r = fakeReader(clock, [slackMail(CODE, { at: 12 * SECOND })])
    expect(await waitForSlackSignInCode(r.reader, options(clock))).toEqual({ id: expect.any(String), code: CODE })
    expect(r.calls.filter((c) => c.startsWith('list'))).toEqual(['list @0s', 'list @5s', 'list @10s', 'list @15s'])

    const quiet = virtualClock(T0)
    const q = fakeReader(quiet, [])
    expect(await waitForSlackSignInCode(q.reader, { ...options(quiet), timeoutMs: 12 * SECOND })).toBeNull()
    expect([q.calls, quiet.now() - T0]).toEqual([['list @0s', 'list @5s', 'list @10s', 'list @12s'], 12 * SECOND])
  })

  test("gives every mailbox call, on every poll, the wait's own deadline (its start + timeoutMs), a source read included", async () => {
    const clock = virtualClock(T0)
    const noCode = slackMail(CODE, { at: 3 * SECOND, text: `\n${OTHER_CODE}\n`, recipients: [ADDRESS] })
    const found = slackMail(CODE, { at: 12 * SECOND })
    const r = fakeReader(clock, [noCode, found], { sources: { [noCode.id]: forwardedSource(HUMAN) } })
    expect(await waitForSlackSignInCode(r.reader, options(clock))).toEqual({ id: found.id, code: CODE })
    expect(r.calls).toEqual(['list @0s', 'list @5s', `source ${noCode.id}`, `get ${noCode.id}`, 'list @10s', 'list @15s', `get ${found.id}`])
    expect(r.options).toEqual(r.calls.map(() => ({ deadline: T0 + 2 * MINUTE })))
  })

  test('mail whose listed recipients hold the test email (in any case) is taken without reading its source', async () => {
    const clock = virtualClock(T0)
    const m = slackMail(CODE, { at: 0, recipients: [ADDRESS, HUMAN.toUpperCase()] })
    const r = fakeReader(clock, [m], { sourceErrors: [new Error('the source must not be read')] })
    expect(await waitForSlackSignInCode(r.reader, options(clock))).toEqual({ id: m.id, code: CODE })
    expect(r.calls).toEqual(['list @0s', `get ${m.id}`])
  })

  describe('mail whose listed recipients do not hold the test email (a forward lists only the mailbox) is decided by its source', () => {
    test.each([
      ["Gmail's Delivered-To for the test email", [ADDRESS], forwardedSource(HUMAN)],
      ['the original To alone', [ADDRESS], rawSource([`Delivered-To: ${ADDRESS}`, `To: ${HUMAN}`])],
      ['a folded To naming the test email in another case', [ADDRESS], rawSource([`Delivered-To: ${ADDRESS}`, `To: Test Human\r\n <${HUMAN.toUpperCase()}>`])],
      ['a Cc', [ADDRESS], rawSource([`To: ${PERSON.address}`, `Cc: ${HUMAN}`])],
      ['X-Original-To', [ADDRESS], rawSource([`X-Original-To: ${HUMAN}`, `To: ${ADDRESS}`])],
      ['a listed recipient that is only the tag-less form, the source naming the test email', [TAGLESS], forwardedSource(HUMAN)],
    ])('taken: %s', async (_what, recipients, source) => {
      const clock = virtualClock(T0)
      const m = slackMail(CODE, { at: 0, recipients })
      const r = fakeReader(clock, [m], { sources: { [m.id]: source } })
      expect(await waitForSlackSignInCode(r.reader, options(clock))).toEqual({ id: m.id, code: CODE })
      expect(r.calls).toEqual(['list @0s', `source ${m.id}`, `get ${m.id}`])
    })

    test.each([
      ['only the mailbox anywhere', [ADDRESS], MAILBOX_ONLY_SOURCE],
      ['sent to the tag-less form (another account of the same inbox)', [ADDRESS], forwardedSource(TAGLESS)],
      ['sent to another tag of the same inbox', [OTHER_TAG], forwardedSource(OTHER_TAG)],
      ['the test email only in X-Forwarded-For (the forwarding account)', [ADDRESS], rawSource([`Delivered-To: ${ADDRESS}`, `X-Forwarded-For: ${HUMAN} ${ADDRESS}`, `To: ${TAGLESS}`])],
      ['the test email only as the sender', [ADDRESS], rawSource([`From: ${HUMAN}`, `To: ${ADDRESS}`])],
      ['the test email only in the body', [ADDRESS], rawSource([`To: ${ADDRESS}`], `To: ${HUMAN}\nDelivered-To: ${HUMAN}\n`)],
      ['no listed recipient and an empty source', [], ''],
    ])('skipped: %s (its source read once, never fetched, excluded)', async (_what, recipients, source) => {
      const clock = virtualClock(T0)
      const m = slackMail(CODE, { at: 0, recipients })
      const r = fakeReader(clock, [m], { sources: { [m.id]: source } })
      const exclude = new Set<string>()
      expect(await waitForSlackSignInCode(r.reader, { ...options(clock, exclude), timeoutMs: 10 * SECOND })).toBeNull()
      expect([r.calls, [...exclude]]).toEqual([['list @0s', `source ${m.id}`, 'list @5s', 'list @10s'], [m.id]])
    })
  })

  test("a newer decoy (Slack's code for the same inbox's tag-less address) is skipped: its source read once across polls, never fetched, while the test human's older code is taken", async () => {
    const clock = virtualClock(T0)
    const genuine = slackMail(CODE, { at: -1 * SECOND, recipients: [ADDRESS] })
    const decoy = slackMail(OTHER_CODE, { at: 0, recipients: [ADDRESS] })
    const exclude = new Set<string>()
    const transient: unknown[] = []
    // The genuine message fails to load once, so the wait polls again past the decoy.
    const r = fakeReader(clock, [genuine, decoy], {
      sources: { [genuine.id]: forwardedSource(HUMAN), [decoy.id]: forwardedSource(TAGLESS) },
      getErrors: [new MailboxError('message', 'http', 503)],
    })
    expect(await waitForSlackSignInCode(r.reader, options(clock, exclude, (err) => transient.push(err)))).toEqual({ id: genuine.id, code: CODE })
    expect(r.calls).toEqual(['list @0s', `source ${decoy.id}`, `source ${genuine.id}`, `get ${genuine.id}`, 'list @5s', `source ${genuine.id}`, `get ${genuine.id}`])
    expect([[...exclude], transient.length]).toEqual([[decoy.id, genuine.id], 1])
  })

  test.each(['', '   '])('no test email (%p): null at once, with no mailbox call and no time passed', async (testEmail) => {
    const clock = virtualClock(T0)
    const r = fakeReader(clock, [slackMail(CODE, { at: 0 })])
    const exclude = new Set<string>()
    expect(await waitForSlackSignInCode(r.reader, { ...options(clock, exclude), testEmail })).toBeNull()
    expect([r.calls, clock.now() - T0, exclude.size]).toEqual([[], 0, 0])
  })

  test('a failed source read is transient: reported, it costs a poll, and the source is read again; an auth failure there ends the wait', async () => {
    const clock = virtualClock(T0)
    const m = slackMail(CODE, { at: 0, recipients: [ADDRESS] })
    const transient: unknown[] = []
    const r = fakeReader(clock, [m], { sources: { [m.id]: forwardedSource(HUMAN) }, sourceErrors: [new MailboxError('source', 'http', 503)] })
    expect(await waitForSlackSignInCode(r.reader, options(clock, new Set(), (err) => transient.push(err)))).toEqual({ id: m.id, code: CODE })
    expect(r.calls).toEqual(['list @0s', `source ${m.id}`, 'list @5s', `source ${m.id}`, `get ${m.id}`])
    expect(transient.map((e) => (e as Error).message)).toEqual(['mail.tm source: http 503'])

    const auth = new MailboxError('token', 'auth', 401)
    const a = fakeReader(clock, [m], { sources: { [m.id]: forwardedSource(HUMAN) }, sourceErrors: [auth] })
    expect(await rejection(() => waitForSlackSignInCode(a.reader, options(clock)))).toBe(auth)
    expect(a.calls.filter((c) => c.startsWith('get'))).toEqual([])
  })

  test('a transient failure costs a poll (reported, and a message that failed to load is fetched again); an auth failure ends the wait', async () => {
    const clock = virtualClock(T0)
    const found = slackMail(CODE, { at: 0 })
    const transient: unknown[] = []
    const r = fakeReader(clock, [found], { listErrors: [new MailboxError('messages', 'network')], getErrors: [new MailboxError('message', 'http', 503)] })
    expect(await waitForSlackSignInCode(r.reader, options(clock, new Set(), (err) => transient.push(err)))).toEqual({ id: found.id, code: CODE })
    expect(r.calls).toEqual(['list @0s', 'list @5s', `get ${found.id}`, 'list @10s', `get ${found.id}`])
    expect(transient.map((e) => (e as Error).message)).toEqual(['mail.tm messages: network', 'mail.tm message: http 503'])

    const auth = new MailboxError('messages', 'auth', 401)
    const a = fakeReader(clock, [found], { listErrors: [auth] })
    expect(await rejection(() => waitForSlackSignInCode(a.reader, options(clock)))).toBe(auth)
  })
})

// ---------------------------------------------------------------------------
// Answering the sign-in code from the mailbox
// ---------------------------------------------------------------------------

interface SignInRun {
  outcome: SignInOutcome
  /** Everything that happened, in order: log lines, registered secrets (by label), codes typed (by label) with the time. */
  events: string[]
  elapsedMs: number
  redactor: Redactor
  /** The in-memory mailbox's calls (see `fakeReader`); empty when `open` gave another mailbox. */
  calls: string[]
}

const codeLabels = new Map([
  [CODE, 'CODE'],
  [bareCode(CODE), 'bare CODE'],
  [OTHER_CODE, 'OTHER'],
  [bareCode(OTHER_CODE), 'bare OTHER'],
  [signInCode(4), 'CODE4'],
  [bareCode(signInCode(4)), 'bare CODE4'],
  [signInCode(5), 'CODE5'],
  [bareCode(signInCode(5)), 'bare CODE5'],
])

async function signIn(o: {
  messages?: MailMessage[]
  script?: ReaderScript
  /** What Slack answers each code typed, in order (default: accepted); an Error is thrown by the page. */
  answers?: Array<SignInOutcome | Error>
  /** Opens the mailbox on the run's clock (default: the in-memory mailbox over `messages`). */
  open?: (clock: Clock) => MailReader | null
  timeoutMs?: number
  /** live.json's test email (default: `HUMAN`). */
  testEmail?: string
}): Promise<SignInRun> {
  const clock = virtualClock(T0)
  const events: string[] = []
  const redactor = new Redactor()
  const r = fakeReader(clock, o.messages ?? [], o.script)
  const answers = [...(o.answers ?? [])]
  const outcome = await answerSignInCodeFromMailbox({
    openMailbox: () => (o.open ? o.open(clock) : r.reader),
    submitCode: async (code) => {
      events.push(`type ${codeLabels.get(code) ?? 'unknown code'} @${(clock.now() - T0) / SECOND}s`)
      const answer = answers.shift() ?? 'signed-in'
      if (answer instanceof Error) throw answer
      return answer
    },
    testEmail: o.testEmail ?? HUMAN,
    addSecret: (value) => {
      events.push(`secret ${codeLabels.get(value) ?? 'unknown'}`)
      redactor.addSecret(value)
    },
    clock,
    log: { info: (m) => events.push(`info ${m}`), detail: (m) => events.push(`detail ${m}`) },
    attemptStartedAt: T0,
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
  })
  return { outcome, events, elapsedMs: clock.now() - T0, redactor, calls: r.calls }
}

const WAITING = 'info sign-in code: Slack emailed a code; waiting up to 2 min for it in the mailbox'
const READ = 'info sign-in code: read from the mailbox'
const REFUSED = 'info sign-in code: Slack did not accept the code from the mailbox; looking for a newer one'

/** No log line holds a code in either form, the mailbox's password or its token. */
function expectNoCodeOrSecret(run: SignInRun): void {
  const lines = run.events.filter((e) => e.startsWith('info') || e.startsWith('detail'))
  for (const code of codeLabels.keys()) expect(lines.filter((l) => l.includes(code))).toEqual([])
  assertNoLeak(lines)
}

describe('answerSignInCodeFromMailbox', () => {
  test("registers the code in both forms before the log says it was read, types it, and signs in", async () => {
    const run = await signIn({ messages: [slackMail(CODE, { at: 12 * SECOND })] })
    expect(run.outcome).toBe('signed-in')
    expect(run.events).toEqual([WAITING, 'secret CODE', 'secret bare CODE', READ, 'type CODE @15s'])
    expect(run.redactor.redact(`${CODE} ${bareCode(CODE)}`)).toBe(`${REDACTED_SECRET} ${REDACTED_SECRET}`)
    expectNoCodeOrSecret(run)
  })

  test('mail up to 5 s older than the attempt counts; older mail (an earlier sign-in) is never typed', async () => {
    const run = await signIn({ messages: [slackMail(OTHER_CODE, { at: -5 * SECOND - 1 }), slackMail(CODE, { at: -5 * SECOND })] })
    expect(run.events).toEqual([WAITING, 'secret CODE', 'secret bare CODE', READ, 'type CODE @0s'])
  })

  test('no code within 2 minutes: needs-code (the operator runs login) after exactly 2 minutes of polling, nothing typed', async () => {
    const run = await signIn({ messages: [slackMail(OTHER_CODE, { at: -MINUTE }), slackMail(CODE, { at: 2 * MINUTE + 1 })] })
    expect(run.outcome).toBe('needs-code')
    expect([run.events, run.elapsedMs]).toEqual([[WAITING, 'info sign-in code: not received within 2 min'], 2 * MINUTE])
  })

  test('the timeout wording follows a timeout that is not whole minutes', async () => {
    const run = await signIn({ timeoutMs: 90 * SECOND })
    expect([run.events, run.elapsedMs]).toEqual([
      ['info sign-in code: Slack emailed a code; waiting up to 90 s for it in the mailbox', 'info sign-in code: not received within 90 s'],
      90 * SECOND,
    ])
  })

  test('a code Slack refuses sends it back for a newer one, within the same 2-minute deadline', async () => {
    const run = await signIn({ messages: [slackMail(OTHER_CODE, { at: 0 }), slackMail(CODE, { at: 30 * SECOND })], answers: ['needs-code', 'signed-in'] })
    expect(run.outcome).toBe('signed-in')
    expect(run.events).toEqual([WAITING, 'secret OTHER', 'secret bare OTHER', READ, 'type OTHER @0s', REFUSED, 'secret CODE', 'secret bare CODE', READ, 'type CODE @30s'])
    expectNoCodeOrSecret(run)
  })

  test('a refused code with no newer one waits out only what is left of the 2 minutes', async () => {
    const run = await signIn({ messages: [slackMail(CODE, { at: 60 * SECOND })], answers: ['needs-code'] })
    expect(run.outcome).toBe('needs-code')
    expect(run.events.slice(-2)).toEqual([REFUSED, 'info sign-in code: Slack accepted no code from the mailbox within 2 min'])
    expect(run.elapsedMs).toBe(2 * MINUTE)
  })

  test('types at most 3 codes per sign-in: a fourth that arrives is never typed', async () => {
    const codes = [OTHER_CODE, signInCode(4), signInCode(5), CODE]
    const run = await signIn({ messages: codes.map((c, i) => slackMail(c, { at: i * 10 * SECOND })), answers: ['needs-code', 'needs-code', 'needs-code'] })
    expect(run.outcome).toBe('needs-code')
    expect(run.events.filter((e) => e.startsWith('type'))).toEqual(['type OTHER @0s', 'type CODE4 @10s', 'type CODE5 @20s'])
    expect([run.events.at(-1), run.elapsedMs]).toEqual(['info sign-in code: Slack accepted no code from the mailbox within 2 min', 20 * SECOND])
  })

  test('a transient mailbox failure is logged once per distinct reason and polling goes on', async () => {
    const network = () => new MailboxError('messages', 'network')
    const run = await signIn({ messages: [slackMail(CODE, { at: 0 })], script: { listErrors: [network(), network(), new MailboxError('messages', 'http', 502), network()] } })
    expect(run.outcome).toBe('signed-in')
    expect(run.events.filter((e) => e.startsWith('detail'))).toEqual([
      'detail sign-in code: a mailbox poll failed (MailboxError: mail.tm messages: network); polling on',
      'detail sign-in code: a mailbox poll failed (MailboxError: mail.tm messages: http 502); polling on',
      'detail sign-in code: a mailbox poll failed (MailboxError: mail.tm messages: network); polling on',
    ])
    expect(run.events.at(-1)).toBe('type CODE @20s')
    expectNoCodeOrSecret(run)
  })

  // The real client over a mail.tm that only rate-limits: every back-off and request keeps the wait's deadline.
  test.each([
    ['no Retry-After', undefined],
    ['Retry-After 30', '30'],
    ['Retry-After 7', '7'],
  ])('a mailbox that only answers 429 (%s) cannot stretch the wait: needs-code at exactly 2 minutes, no request after them', async (_what, retryAfter) => {
    let h: ReturnType<typeof makeClient> | undefined
    const run = await signIn({ open: (clock) => (h = makeClient({ [LIST]: [tooMany(retryAfter)] }, {}, { clock })).client })
    expect([run.outcome, run.elapsedMs]).toEqual(['needs-code', 2 * MINUTE])
    expect(run.events).toEqual([
      WAITING,
      'detail sign-in code: a mailbox poll failed (MailboxError: mail.tm messages: rate-limited 429); polling on',
      'info sign-in code: not received within 2 min',
    ])
    expect(h!.requestsAt.length).toBeGreaterThan(1)
    expect(h!.requestsAt.filter((at) => at > 2 * MINUTE)).toEqual([])
    expectNoCodeOrSecret(run)
  })

  test('mail.tm refusing the mailbox (auth) ends the wait at once: needs-code, the reason named without a secret', async () => {
    const run = await signIn({ messages: [slackMail(CODE, { at: 0 })], script: { listErrors: [new MailboxError('token', 'auth', 401)] } })
    expect([run.outcome, run.events, run.elapsedMs]).toEqual(['needs-code', [WAITING, 'info sign-in code: the mailbox is unusable (MailboxError: mail.tm token: auth 401)'], 0])
    expectNoCodeOrSecret(run)
  })

  test.each([
    ['no mailbox.json', () => null, 'info sign-in code: no mailbox configured (mailbox.json)'],
    [
      'an unusable mailbox.json',
      () => {
        throw new MailboxConfigError('has no password')
      },
      'info sign-in code: the mailbox is unusable (MailboxConfigError: has no password)',
    ],
  ])('%s: needs-code at once, the old fallback (exit 2, run login)', async (_what, open, line) => {
    const run = await signIn({ open })
    expect([run.outcome, run.events, run.elapsedMs]).toEqual(['needs-code', [line], 0])
  })

  test.each(['', '  '])('no test email (%p): needs-code at once, saying so, with no mailbox call and nothing typed', async (testEmail) => {
    const run = await signIn({ messages: [slackMail(CODE, { at: 0 })], testEmail })
    expect([run.outcome, run.events, run.elapsedMs, run.calls]).toEqual(['needs-code', ["info sign-in code: no test email to match Slack's mail against (live.json test_email)"], 0, []])
  })

  test("Slack's code for another account of the same inbox is never typed (its source read once), the test human's newer one is", async () => {
    const decoy = slackMail(OTHER_CODE, { at: 10 * SECOND, recipients: [TAGLESS] })
    const run = await signIn({ messages: [decoy, slackMail(CODE, { at: 20 * SECOND })] })
    expect(run.outcome).toBe('signed-in')
    expect(run.events).toEqual([WAITING, 'secret CODE', 'secret bare CODE', READ, 'type CODE @20s'])
    expect(run.calls.filter((c) => c.endsWith(decoy.id))).toEqual([`source ${decoy.id}`])
    expectNoCodeOrSecret(run)
  })

  test('a FlowError on the code prompt: needs-code (the operator runs login), the step named with no code, and no other code typed', async () => {
    const run = await signIn({ messages: [slackMail(CODE, { at: 0 }), slackMail(OTHER_CODE, { at: 5 * SECOND })], answers: [new FlowError('sign-in: the code prompt is gone')] })
    expect([run.outcome, run.elapsedMs]).toEqual(['needs-code', 0])
    expect(run.events).toEqual([WAITING, 'secret CODE', 'secret bare CODE', READ, 'type CODE @0s', 'info sign-in code: the code prompt failed (FlowError: sign-in: the code prompt is gone)'])
    expectNoCodeOrSecret(run)
  })

  test.each([
    ['a plain Error', () => new Error('sign-in: the page crashed')],
    ['a NotRunnableError (a signed-in page with no session)', () => new NotRunnableError('the signed-in page has no session')],
  ])('%s while typing the code is thrown to the caller, not taken for needs-code', async (_what, make) => {
    const err = make()
    expect(await rejection(() => signIn({ messages: [slackMail(CODE, { at: 0 })], answers: [err] }))).toBe(err)
  })
})

// ---------------------------------------------------------------------------
// The `mailbox --latest` and `mailbox --forwarding` reports
// ---------------------------------------------------------------------------

describe('the mailbox command: addresses and senders', () => {
  test.each([
    ['test-human+cscbtest@gmail.invalid', ['test-human+cscbtest@gmail.invalid', 'test-human@gmail.invalid']],
    ['test-human@gmail.invalid', ['test-human@gmail.invalid']],
  ])('addressForms(%p) is %p (as it is, and without its +tag)', (email, forms) => {
    expect(addressForms(email)).toEqual(forms)
  })

  test('maskEmails masks every address but the kept ones (any case)', () => {
    expect(maskEmails(`from ${PERSON.address}, to ${ADDRESS.toUpperCase()} and ${HUMAN}`, [ADDRESS])).toBe(`from <email>, to ${ADDRESS.toUpperCase()} and <email>`)
  })

  test('stripControls turns control characters into spaces; with keepLines, newlines and tabs stay', () => {
    const text = 'a\u001b[31mb\tc\nd\u0007e\u009bf'
    expect([stripControls(text), stripControls(text, true)]).toEqual(['a [31mb c d e f', 'a [31mb\tc\nd e f'])
  })

  test.each([
    ['Slack, with its name', SLACK, 'Slack <no-reply@slack.com>'],
    ['Google, with no name', { address: 'forwarding-noreply@google.com', name: '' }, 'forwarding-noreply@google.com'],
    ['a person: only the domain', PERSON, 'an address at corp.invalid'],
    ['a look-alike Slack sender: only the domain, never its name', { address: 'no-reply@slack.com.mailbox.invalid', name: 'Slack' }, 'an address at slack.com.mailbox.invalid'],
    ['no address', { address: '', name: 'Bob Smith' }, 'an unknown sender'],
  ])('describeSender: %s', (_what, from, expected) => {
    expect(describeSender(from)).toBe(expected)
  })
})

/** The lines hold `code` in no form: as shown, without its dash, in any case (compared as booleans: no code is printed). */
function expectNoCode(lines: string[], code: string): void {
  const text = lines.join('\n').toUpperCase()
  expect([text.includes(code.toUpperCase()), text.includes(bareCode(code).toUpperCase())]).toEqual([false, false])
}

describe('maskSubjectCodes', () => {
  test.each([
    ["Slack's subject", `Slack confirmation code: ${CODE}`, 'Slack confirmation code: <code>'],
    ['a code without its dash', `Slack confirmation code: ${bareCode(CODE)}`, 'Slack confirmation code: <code>'],
    ['a dashed code in lower case', `Slack confirmation code: ${CODE.toLowerCase()}`, 'Slack confirmation code: <code>'],
    ['"is" before the code', `Your Slack login code is ${CODE}`, 'Your Slack login code is <code>'],
    ['the code before the word', `${CODE} is your Slack code`, '<code> is your Slack code'],
    ['two codes', `Code ${CODE} or ${OTHER_CODE}`, 'Code <code> or <code>'],
    ['a code in brackets', `Slack confirmation code [${CODE}]`, 'Slack confirmation code [<code>]'],
  ])('masks %s', (_what, subject, expected) => {
    expect(maskSubjectCodes(subject)).toBe(expected)
  })

  test.each([
    ["Gmail's forwarding subject naming a code: its 9-digit number is no sign-in code", `(#705005922) Gmail Forwarding Confirmation code - Receive Mail from ${HUMAN}`],
    ['a subject that names no code', `Your order ${bareCode(CODE)} has shipped`],
    ['lower-case words beside the word code', 'Enter the code below within minutes'],
    ['no subject', ''],
  ])('keeps %s as it is', (_what, subject) => {
    expect(maskSubjectCodes(subject)).toBe(subject)
  })
})

describe('describeLatestMessage (mailbox --latest)', () => {
  test("Slack's code mail without --show-body: when it came, the sender, the subject with its code masked, and that a code is in it; no code anywhere", () => {
    const m = slackMail(CODE, { at: 0 })
    const lines = describeLatestMessage(m, ADDRESS, false)
    expect(lines).toEqual([
      `mailbox: ${ADDRESS}`,
      `newest message: received ${m.createdAt}`,
      'from: Slack <no-reply@slack.com>',
      'subject: Slack confirmation code: <code>',
      'a Slack sign-in code is in it (--show-body prints it)',
    ])
    expectNoCode(lines, CODE)
  })

  test("Slack's code mail with --show-body: the subject as it is, the code line, then the body", () => {
    const m = slackMail(CODE, { at: 0 })
    const lines = describeLatestMessage(m, ADDRESS, true)
    expect(lines.slice(2, 6)).toEqual(['from: Slack <no-reply@slack.com>', `subject: Slack confirmation code: ${CODE}`, `Slack sign-in code: ${CODE}`, 'body:'])
    expect(lines.slice(6)).toEqual(m.text.split('\n').map((l) => `  ${l}`))
  })

  test.each([
    ["Slack's layout", () => slackMail(CODE), CODE, 'Slack confirmation code: <code>', 'a Slack sign-in code is in it (--show-body prints it)'],
    ['a code without its dash', () => slackMail(BARE_CODE), BARE_CODE, 'Slack confirmation code: <code>', 'a Slack sign-in code is in it (--show-body prints it)'],
    ['a login-code subject', () => slackMail(CODE, { subject: `Your Slack login code is ${CODE}` }), CODE, 'Your Slack login code is <code>', 'a Slack sign-in code is in it (--show-body prints it)'],
    ['the code in the body only', () => slackMail(CODE, { subject: 'Your Slack confirmation code' }), CODE, 'Your Slack confirmation code', 'a Slack sign-in code is in it (--show-body prints it)'],
    [
      'a look-alike Slack sender',
      () => slackMail(CODE, { from: { address: 'no-reply@slack.com.mailbox.invalid', name: 'Slack' } }),
      CODE,
      'Slack confirmation code: <code>',
      'no confirmation code found in it (--show-body prints the body)',
    ],
    ['a person forwarding a code', () => slackMail(CODE, { from: PERSON }), CODE, 'Slack confirmation code: <code>', 'no confirmation code found in it (--show-body prints the body)'],
  ])('without --show-body, %s: no line holds the code, the subject shows <code>', (_what, message, code, subject, found) => {
    const lines = describeLatestMessage(message(), ADDRESS, false)
    expect(lines.slice(3)).toEqual([`subject: ${subject}`, found])
    expectNoCode(lines, code)
  })

  test("Gmail's forwarding confirmation with a code: the code, the test human's address masked", () => {
    const m = gmailMail({ subject: `(#705005922) ${FORWARDING_SUBJECT}`, text: `Confirmation code: 705005922\n${gmailLayout()}` })
    const lines = describeLatestMessage(m, ADDRESS, false)
    expect(lines.slice(2)).toEqual(['from: Gmail Team <forwarding-noreply@google.com>', 'subject: (#705005922) Gmail Forwarding Confirmation - Receive Mail from <email>', 'Gmail forwarding confirmation code: 705005922'])
  })

  test("a person's mail: named only by domain, every address masked, control characters stripped, no code, no body", () => {
    const m = mail({ from: PERSON, subject: `Hi \u001b[2Jfrom ${PERSON.address}`, text: `Bob Smith here, ${PERSON.address}` })
    const lines = describeLatestMessage(m, ADDRESS, false)
    expect(lines.slice(2)).toEqual(['from: an address at corp.invalid', 'subject: Hi  [2Jfrom <email>', 'no confirmation code found in it (--show-body prints the body)'])
    expect(lines.join('\n')).not.toContain('Bob Smith')
  })

  test("a look-alike Slack sender's code is not offered as Slack's, not even with --show-body", () => {
    const m = slackMail(CODE, { from: { address: 'no-reply@slack.com.mailbox.invalid', name: 'Slack' } })
    expect(describeLatestMessage(m, ADDRESS, false).slice(2)).toEqual([
      'from: an address at slack.com.mailbox.invalid',
      'subject: Slack confirmation code: <code>',
      'no confirmation code found in it (--show-body prints the body)',
    ])
    expect(describeLatestMessage(m, ADDRESS, true).slice(3, 6)).toEqual([`subject: Slack confirmation code: ${CODE}`, 'no confirmation code found in it', 'body:'])
  })

  test('--show-body prints the body indented, lines and tabs kept, other control characters and addresses masked, the mailbox address kept', () => {
    const m = mail({ from: PERSON, createdAt: '', text: `Hi\tthere\u0007\nwrite to ${PERSON.address} or ${ADDRESS}` })
    expect(describeLatestMessage(m, ADDRESS, true)).toEqual([
      `mailbox: ${ADDRESS}`,
      'newest message: received at an unknown time',
      'from: an address at corp.invalid',
      'subject: Hello',
      'no confirmation code found in it',
      'body:',
      '  Hi\tthere ',
      `  write to <email> or ${ADDRESS}`,
    ])
  })
})

describe('selectForwardingMessage and describeForwardingMessage (mailbox --forwarding)', () => {
  test('selects the newest Gmail forwarding confirmation, past newer mail and a look-alike', () => {
    const list = [
      mail({ at: 50 }),
      slackMail(CODE, { at: 40 }),
      gmailMail({ at: 30, from: { address: 'forwarding-noreply@google.com.mailbox.invalid', name: 'Gmail Team' } }),
      gmailMail({ at: 20 }),
      gmailMail({ at: 10 }),
    ]
    expect(selectForwardingMessage(list)).toBe(list[3])
    expect(selectForwardingMessage(list.slice(0, 3))).toBeUndefined()
  })

  test("Gmail's layout: the confirm link on a line of its own, never the cancel link, the test human's address masked", () => {
    const m = gmailMail({ at: 0 })
    const lines = describeForwardingMessage(m, ADDRESS, false)
    expect(lines).toEqual([
      `mailbox: ${ADDRESS}`,
      `Gmail forwarding confirmation: received ${m.createdAt}`,
      'from: Gmail Team <forwarding-noreply@google.com>',
      'subject: Gmail Forwarding Confirmation - Receive Mail from <email>',
      'no confirmation code found in it',
      `confirm link: ${CONFIRM_LINK}`,
    ])
    const text = lines.join('\n')
    expect([text.includes(CANCEL_LINK), text.includes(HUMAN), text.includes('/uf-')]).toEqual([false, false, false])
  })

  test('no confirm link: says so, pointing at --show-body only when the body is not shown', () => {
    const m = gmailMail({ text: `click this link to cancel this verification:\n${CANCEL_LINK}\nwritten by ${PERSON.address}` })
    expect(describeForwardingMessage(m, ADDRESS, false).slice(4)).toEqual(['no confirmation code found in it', 'no confirm link found in it (--show-body prints the body)'])
    expect(describeForwardingMessage(m, ADDRESS, true).slice(4)).toEqual([
      'no confirmation code found in it',
      'no confirm link found in it',
      'body:',
      '  click this link to cancel this verification:',
      `  ${CANCEL_LINK}`,
      '  written by <email>',
    ])
  })
})

// ---------------------------------------------------------------------------
// The dry run's stub mailbox
// ---------------------------------------------------------------------------


/**
 * The stub mailbox as the runner reads it (what the stub server's mail.tm
 * routes answer: lists, messages and sources), at the clock's time.
 */
function stubReader(ws: StubWorkspace, clock: Clock): MailReader {
  const box = ws.mailbox
  const find = (id: string): StubMail => box.visible(clock.now()).find((m) => m.id === id)!
  return {
    address: box.address,
    listMessages: async () => parseMessageList({ 'hydra:member': box.visible(clock.now()).map((m) => box.summary(m)) })!,
    getMessage: async (id) => parseMessage(box.full(find(id)))!,
    getSource: async (id) => box.source(find(id)),
  }
}

/** The code a stub Slack mail carries (its subject's). */
function stubCode(m: StubMail): string {
  return m.subject.replace('Slack confirmation code: ', '')
}

describe("the dry run's stub mailbox", () => {
  const makeWorkspace = () => new StubWorkspace('cscb-dry-run', HUMAN, `pw-${LEAK_SENTINEL}`)

  /** The runner's sign-in answered from the stub mailbox, the stub's prompt taking the codes, on `clock`. */
  async function stubSignIn(ws: StubWorkspace, clock: Clock, start: number) {
    const typed: string[] = []
    const logs: string[] = []
    const outcome = await answerSignInCodeFromMailbox({
      openMailbox: () => stubReader(ws, clock),
      submitCode: async (code) => (typed.push(code), ws.submitCode(code, clock.now()) ? 'signed-in' : 'needs-code'),
      testEmail: ws.email,
      addSecret: () => undefined,
      clock,
      log: { info: (m) => logs.push(m), detail: (m) => logs.push(m) },
      attemptStartedAt: start,
      pollMs: SECOND,
    })
    return { outcome, typed, logs }
  }

  test("issues a token only for the mailbox's address and password, and accepts only issued tokens (never the stale one)", () => {
    const box = makeWorkspace().mailbox
    expect([box.issueToken(box.address, 'wrong'), box.issueToken('x@mailbox.invalid', box.password)]).toEqual([null, null])
    const token = box.issueToken(box.address, box.password)!
    expect([box.authorized(box.staleToken), box.authorized(null), box.authorized(token)]).toEqual([false, false, true])
    expect(box.counts).toEqual({ tokensIssued: 1, unauthorized: 2, rateLimited: 0 })
    expect(box.secrets()).toEqual([box.password, box.staleToken, token])
  })

  test('answers one 429, then none', () => {
    const box = makeWorkspace().mailbox
    expect([box.takeRateLimit(), box.takeRateLimit(), box.counts.rateLimited]).toEqual([true, false, 1])
  })

  test("starts with an old Slack code and Gmail's forwarding confirmation, whose number and confirm link (not the cancel link) the extractors find", async () => {
    const ws = makeWorkspace()
    const clock = virtualClock(Date.now())
    const reader = stubReader(ws, clock)
    const list = await reader.listMessages()
    expect(list.map((s) => s.from.address)).toEqual(['forwarding-noreply@google.com', 'no-reply@slack.com'])
    expect(list.every((s) => s.receivedAtMs <= clock.now() - 58 * MINUTE)).toBe(true)
    const forwarding = await reader.getMessage(selectForwardingMessage(list)!.id)
    expect([extractGmailForwardingCode(forwarding), extractGmailConfirmLink(forwarding)]).toEqual([ws.forwardingCode, ws.forwardingConfirmLink])
    expect(describeForwardingMessage(forwarding, reader.address, false).join('\n')).not.toContain(ws.forwardingConfirmLink.replace('/vf-', '/uf-'))
  })

  test.each([
    ['an address with a +tag: the same inbox without it', 'test-human+cscbtest@example.invalid', 'test-human@example.invalid'],
    ['an address with two plus signs: without the whole tag', 'Test.Human+a+b@example.invalid', 'Test.Human@example.invalid'],
    ['an address without a tag: the same inbox with one', 'test-human@example.invalid', 'test-human+other@example.invalid'],
    ['text that is not an address: a fixed other address', 'not an address', 'another-account@example.invalid'],
  ])('sameInboxOtherAddress, %s, which isSentTo tells apart from the address', (_what, email, other) => {
    expect(sameInboxOtherAddress(email)).toBe(other)
    expect([isSentTo([other], email), isSentTo([email], other)]).toEqual([false, false])
  })

  test('a sign-in emails, 2.5 s later, the code to the test human, a decoy (Slack code to the same inbox\'s other address) and a look-alike (a non-Slack sender), newest last, three different codes', () => {
    const ws = makeWorkspace()
    const start = Date.now()
    expect([ws.startEmailCode(start), ws.hasPendingCode()]).toEqual([true, true])
    const sent = ws.mailbox.messages.slice(2)
    expect(sent.map((m) => [m.from.address, m.to, Date.parse(m.createdAt) - start, m.deliverAtMs - start])).toEqual([
      ['no-reply@slack.com', HUMAN, 2000, 2500],
      ['no-reply@slack.com', TAGLESS, 2250, 2500],
      ['no-reply@slack.com.mailbox.invalid', HUMAN, 2500, 2500],
    ])
    expect(ws.decoyMailIds).toEqual([sent[1]!.id])
    expect([ws.mailbox.visible(start + 2499).length, ws.mailbox.visible(start + 2500).length]).toEqual([2, 5])
    // Slack's two parse as Slack codes, the look-alike's does not; the prompt takes only the first (compared as booleans: no code is printed).
    const codes = sent.map(stubCode)
    expect(sent.map((m) => extractSlackSignInCode(parseMessage(ws.mailbox.full(m))!) === stubCode(m))).toEqual([true, true, false])
    expect(new Set(codes).size).toBe(3)
    expect([ws.submitCode(codes[1]!, start), ws.submitCode(codes[2]!, start), ws.submitCode(codes[0]!, start)]).toEqual([false, false, true])
    expect(ws.codeCounts).toEqual({ accepted: 1, refused: 2, superseded: 0 })
  })

  test("mail.tm (the stub) lists only the mailbox as a message's recipient; its source keeps the original To (folded) and Gmail's Delivered-To, and each read is recorded", () => {
    const ws = makeWorkspace()
    ws.startEmailCode(Date.now(), 0)
    const box = ws.mailbox
    const [forwarding, codeMail, decoy] = [box.messages[1]!, box.messages[2]!, box.messages[3]!]
    expect([parseSummary(box.summary(codeMail))!.recipients, parseMessage(box.full(decoy))!.recipients]).toEqual([[box.address], [box.address]])
    const source = box.source(codeMail)
    expect([source.includes(`\r\nDelivered-To: ${HUMAN}\r\n`), source.includes(`\r\nTo:\r\n ${HUMAN}\r\n`), source.includes(`\r\n\r\n${codeMail.text.split('\n')[0]}`)]).toEqual([true, true, true])
    expect(recipientsInSource(source)).toEqual([box.address, HUMAN, HUMAN])
    expect(recipientsInSource(box.source(decoy))).toEqual([box.address, TAGLESS, TAGLESS])
    // Mail sent to the mailbox itself (Gmail's forwarding request) names only it.
    expect(recipientsInSource(box.source(forwarding))).toEqual([box.address, box.address])
    expect(box.sourcesRead).toEqual([codeMail.id, decoy.id, forwarding.id])
  })

  test("the runner's sign-in reads the recipients from the sources, skips the decoy and the look-alike, types the right code 3 s in, and the prompt accepts it", async () => {
    const ws = makeWorkspace()
    const clock = virtualClock(Date.now())
    const start = clock.now()
    ws.startEmailCode(start)
    const { outcome, typed, logs } = await stubSignIn(ws, clock, start)
    expect([outcome, ws.codeCounts, ws.hasPendingCode(), clock.now() - start]).toEqual(['signed-in', { accepted: 1, refused: 0, superseded: 0 }, false, 3 * SECOND])
    const [codeMail, decoy] = [ws.mailbox.messages[2]!, ws.mailbox.messages[3]!]
    // Newest first: the look-alike is no Slack code mail, the decoy's source names another address, the code's names the test human.
    expect(ws.mailbox.sourcesRead).toEqual([decoy.id, codeMail.id])
    expect([typed.length, typed[0] === stubCode(codeMail)]).toEqual([1, true])
    // The dry run's known secrets hold the code in both forms and the mailbox's (compared as booleans: no value is printed).
    const known = ws.allTokens()
    expect([typed[0]!, bareCode(typed[0]!), ws.mailbox.password, ws.mailbox.staleToken].map((v) => known.includes(v))).toEqual([true, true, true, true])
    expect(logs.filter((l) => l.includes(typed[0]!) || l.includes(bareCode(typed[0]!)))).toEqual([])
  })

  test('with refuseFirstCode, the first right code is refused once (superseded) and a newer code emailed 2.5 s later, which signs in', () => {
    const ws = makeWorkspace()
    ws.refuseFirstCode = true
    const start = Date.now()
    ws.startEmailCode(start, 0)
    const first = stubCode(ws.mailbox.messages[2]!)
    expect([ws.submitCode(first, start + 1000), ws.codeCounts, ws.hasPendingCode(), ws.mailbox.messages.length]).toEqual([false, { accepted: 0, refused: 0, superseded: 1 }, true, 6])
    const newer = ws.mailbox.messages[5]!
    expect([newer.from.address, newer.to, Date.parse(newer.createdAt) - start, newer.deliverAtMs - start]).toEqual(['no-reply@slack.com', HUMAN, 3000, 3500])
    expect([ws.mailbox.visible(start + 3499).some((m) => m.id === newer.id), ws.mailbox.visible(start + 3500)[0]?.id === newer.id]).toEqual([false, true])
    // The first code is no longer the one the prompt waits for; refuseFirstCode refuses only once, so the newer one signs in.
    expect([stubCode(newer) !== first, ws.submitCode(first, start + 4000), ws.submitCode(stubCode(newer), start + 4000)]).toEqual([true, false, true])
    expect(ws.codeCounts).toEqual({ accepted: 1, refused: 1, superseded: 1 })
  })

  test("with refuseFirstCode, the runner's sign-in types the newer code 6 s in and signs in; the decoy's source is read once across both waits, and no skipped code is typed", async () => {
    const ws = makeWorkspace()
    ws.refuseFirstCode = true
    const clock = virtualClock(Date.now())
    const start = clock.now()
    ws.startEmailCode(start)
    const { outcome, typed, logs } = await stubSignIn(ws, clock, start)
    expect([outcome, ws.codeCounts, clock.now() - start]).toEqual(['signed-in', { accepted: 1, refused: 0, superseded: 1 }, 6 * SECOND])
    const [first, decoy, newer] = [ws.mailbox.messages[2]!, ws.mailbox.messages[3]!, ws.mailbox.messages[5]!]
    expect(ws.mailbox.sourcesRead).toEqual([decoy.id, first.id, newer.id])
    expect(typed.map((c) => [stubCode(first), stubCode(newer)].indexOf(c))).toEqual([0, 1])
    expect(logs).toEqual([
      'sign-in code: Slack emailed a code; waiting up to 2 min for it in the mailbox',
      'sign-in code: read from the mailbox',
      'sign-in code: Slack did not accept the code from the mailbox; looking for a newer one',
      'sign-in code: read from the mailbox',
    ])
  })

  test('the prompt takes the code with or without its dash, in any case, and refuses any other; one sign-in per code', async () => {
    const ws = makeWorkspace()
    const clock = virtualClock(Date.now())
    ws.startEmailCode(clock.now(), 0)
    const found = await waitForSlackSignInCode(stubReader(ws, clock), { sinceMs: clock.now() - MAIL_CLOCK_SKEW_MS, testEmail: ws.email, timeoutMs: 0, pollMs: SECOND, clock, exclude: new Set() })
    const code = found!.code
    expect([ws.submitCode(OTHER_CODE), ws.submitCode(` ${bareCode(code).toLowerCase()} `), ws.submitCode(code)]).toEqual([false, true, false])
    expect(ws.codeCounts).toEqual({ accepted: 1, refused: 2, superseded: 0 })
  })

  test('with requireEmailCode off, a sign-in asks for no code and sends no mail', () => {
    const ws = makeWorkspace()
    ws.requireEmailCode = false
    expect([ws.startEmailCode(Date.now()), ws.hasPendingCode(), ws.mailbox.messages.length]).toEqual([false, false, 2])
  })
})
