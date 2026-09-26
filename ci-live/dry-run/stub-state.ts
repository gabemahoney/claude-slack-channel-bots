/**
 * stub-state.ts — the dry run's stand-in for the test workspace: apps and
 * their manifests, installs, bot and app-level tokens, the test human's
 * session (a password sign-in that asks for an emailed code), channels and
 * DMs, and the test mailbox (mail.tm) the code is emailed to. Pure state plus
 * one handler per Slack method the runner calls; `stub-server.ts` puts it
 * behind HTTP.
 *
 * The mailbox models the stricter mail.tm: its lists and messages name only
 * the mailbox itself as `to`, and a forwarded message's original recipient
 * shows only in its source's headers (`/sources/<id>`), so the dry run
 * proves the runner reads it there. Beside Slack's code for the test human
 * it holds a decoy (a Slack code sent to another account of the same inbox)
 * and a look-alike (a code from a non-Slack domain); neither may be typed.
 *
 * Every token it issues is built at runtime in the real token shapes (so the
 * runner's flows, readers and redaction treat them as real) and never
 * printed: the dry run's closing secrecy scan must find none of them in any
 * output, which proves the hygiene works.
 */

import { randomBytes, randomUUID } from 'node:crypto'

import type { SlackResponse } from '../lib/slack-api.ts'

// Token prefixes, assembled at runtime so no token-shaped literal sits in the source.
const P = {
  bot: ['xox', 'b-'].join(''),
  app: ['xa', 'pp-'].join(''),
  session: ['xox', 'c-'].join(''),
  cookie: ['xox', 'd-'].join(''),
  config: ['xoxe', '.xoxp-'].join(''),
  refresh: ['xox', 'e-'].join(''),
}

function digits(n: number): string {
  let s = ''
  for (const b of randomBytes(n)) s += String(b % 10)
  return s.replace(/^0/, '1')
}

function alnum(n: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (const b of randomBytes(n)) s += chars[b % chars.length]
  return s
}

export const STUB_TEAM_ID = 'T0DRYSTUB0'
export const STUB_HUMAN_ID = 'U0DRYHUMAN'
/** The stub workspace's name (`auth.test`'s `team`, and the apps list's workspace column). */
export const STUB_TEAM_NAME = 'CSCB CI Test (stub)'
/** The workspace a foreign app belongs to on the fixture apps list. */
export const STUB_OTHER_TEAM_NAME = 'Another Workspace (stub)'

/** Letters and digits of a stub sign-in code: no vowels, so no code spells a word an output could hold. */
const CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXZ23456789'

/** A sign-in code as Slack's email shows it: `XXX-XXX`. */
export function stubSignInCode(): string {
  let s = ''
  for (const b of randomBytes(6)) s += CODE_CHARS[b % CODE_CHARS.length]
  return `${s.slice(0, 3)}-${s.slice(3)}`
}

/** How long after a sign-in (or a refused code) the stub's code email arrives. */
const CODE_MAIL_DELAY_MS = 2_500

/**
 * Another account's address in the same inbox as `email`: `email` without
 * its `+tag`, or with one when it has none (the dry run's decoy recipient).
 */
export function sameInboxOtherAddress(email: string): string {
  const m = /^([^+@]+)(\+[^@]*)?(@.+)$/.exec(email)
  if (!m) return 'another-account@example.invalid'
  return m[2] ? `${m[1]}${m[3]}` : `${m[1]}+other${m[3]}`
}

/** A JWT-shaped bearer token, as mail.tm issues. */
function mailToken(): string {
  return `eyJ${alnum(24)}.eyJ${alnum(60)}.${alnum(43)}`
}

export interface StubMail {
  id: string
  from: { address: string; name: string }
  /** The original recipient (the `To:` header); the mailbox's own address for mail sent to it directly. */
  to: string
  subject: string
  text: string
  html: string[]
  createdAt: string
  /** Hidden from the mailbox until then (the email is on its way). */
  deliverAtMs: number
}

/**
 * The test mailbox's stand-in (mail.tm's `/token`, `/messages` and
 * `/sources`). The dry run seeds mailbox.json with a stale token (the first
 * call gets a 401, so the runner fetches a fresh one and rewrites the file)
 * and the first list answers 429 (the runner backs off).
 */
export class StubMailbox {
  readonly address = 'cscb-dry-run@mailbox.invalid'
  readonly accountId = 'stubaccount0000000000000'
  readonly password = alnum(32)
  /** The token the dry run's mailbox.json starts with: never valid. */
  readonly staleToken = mailToken()
  readonly messages: StubMail[] = []
  /** How many of the next `GET /messages` calls answer 429. */
  rateLimitNext = 1
  readonly counts = { tokensIssued: 0, unauthorized: 0, rateLimited: 0 }
  /** The ids of the messages whose source was read, in order. */
  readonly sourcesRead: string[] = []
  private readonly tokens: string[] = []
  private seq = 0

  /** `POST /token`: a fresh token for the right address and password, else null (401). */
  issueToken(address: unknown, password: unknown): string | null {
    if (address !== this.address || password !== this.password) return null
    const token = mailToken()
    this.tokens.push(token)
    this.counts.tokensIssued += 1
    return token
  }

  authorized(bearer: string | null): boolean {
    const ok = bearer !== null && this.tokens.includes(bearer)
    if (!ok) this.counts.unauthorized += 1
    return ok
  }

  /** A 429 for this list call? */
  takeRateLimit(): boolean {
    if (this.rateLimitNext <= 0) return false
    this.rateLimitNext -= 1
    this.counts.rateLimited += 1
    return true
  }

  deliver(mail: Omit<StubMail, 'id' | 'createdAt'> & { createdAtMs: number }): StubMail {
    this.seq += 1
    const { createdAtMs, ...rest } = mail
    const stored: StubMail = { id: `stubmsg${String(this.seq).padStart(17, '0')}`, createdAt: new Date(createdAtMs).toISOString(), ...rest }
    this.messages.push(stored)
    return stored
  }

  /** The delivered messages at `nowMs`, newest first. */
  visible(nowMs: number): StubMail[] {
    return this.messages.filter((m) => m.deliverAtMs <= nowMs).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  }

  /** A `GET /messages` item: `to` names the mailbox only (see the module comment). */
  summary(m: StubMail): Record<string, unknown> {
    return { id: m.id, accountId: this.accountId, from: m.from, to: [{ address: this.address, name: '' }], subject: m.subject, intro: m.text.slice(0, 60), seen: false, createdAt: m.createdAt }
  }

  full(m: StubMail): Record<string, unknown> {
    return { ...this.summary(m), cc: [], bcc: [], text: m.text, html: m.html }
  }

  /**
   * `GET /sources/<id>`'s `data`: the raw message (CRLF lines). Its headers
   * keep the original recipient: `To:`, and for forwarded mail the
   * `Delivered-To:` Gmail stamps before forwarding, after mail.tm's own.
   */
  source(m: StubMail): string {
    this.sourcesRead.push(m.id)
    const forwarded = m.to !== this.address
    const headers = [
      `Delivered-To: ${this.address}`,
      ...(forwarded ? [`X-Forwarded-To: ${this.address}`, `X-Forwarded-For: ${m.to} ${this.address}`, `Delivered-To: ${m.to}`] : []),
      `Date: ${new Date(m.createdAt).toUTCString()}`,
      `From: ${m.from.name} <${m.from.address}>`,
      // Folded, as a long header may be: the reader joins it.
      `To:\r\n ${m.to}`,
      `Subject: ${m.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
    ]
    return `${headers.join('\r\n')}\r\n\r\n${m.text.replace(/\r?\n/g, '\r\n')}`
  }

  /** Every secret the mailbox holds (the dry run registers them as known secrets). */
  secrets(): string[] {
    return [this.password, this.staleToken, ...this.tokens]
  }
}

/** Slack's code email to `to`, as the stub sends it. */
function slackCodeMail(code: string, fromAddress: string, to: string): Pick<StubMail, 'from' | 'to' | 'subject' | 'text' | 'html'> {
  const lead = "Your confirmation code is below — enter it in your open browser window and we'll help you get signed in."
  return {
    from: { address: fromAddress, name: 'Slack' },
    to,
    subject: `Slack confirmation code: ${code}`,
    text: `Confirm your email address\n\n${lead}\n\n${code}\n\nIf you didn't request this email, there's nothing to worry about — you can safely ignore it.\n`,
    html: [`<html><body><h1>Confirm your email address</h1><p>${lead}</p><div>${code}</div><p>If you didn&#39;t request this email, there&#39;s nothing to worry about.</p></body></html>`],
  }
}

export interface StubApp {
  id: string
  manifest: Record<string, unknown>
  installed: boolean
  botToken: string | null
  botUserId: string
  botId: string
  appTokens: { name: string; token: string }[]
  /**
   * An app of another workspace the test human also sees on the apps list:
   * the stub's manifest API (the test workspace's configuration token)
   * answers `invalid_app_id` for it.
   */
  foreign?: boolean
}

export interface StubChannel {
  id: string
  name: string
  archived: boolean
  members: Set<string>
  messages: { ts: string; user: string; text: string; blocks?: unknown[] }[]
}

/** The buttons of a message's Block Kit `actions` blocks: their text and action id. */
export function blockButtons(blocks: unknown[] | undefined): { text: string; actionId: string }[] {
  const out: { text: string; actionId: string }[] = []
  for (const block of blocks ?? []) {
    const elements = (block as { elements?: unknown }).elements
    if (!Array.isArray(elements)) continue
    for (const e of elements as { text?: { text?: unknown }; action_id?: unknown }[]) {
      if (typeof e.text?.text === 'string' && typeof e.action_id === 'string') out.push({ text: e.text.text, actionId: e.action_id })
    }
  }
  return out
}

export class StubWorkspace {
  /** The app configuration token the manifest API takes now (`tooling.tokens.rotate` replaces it). */
  configToken = `${P.config}1-${alnum(40)}`
  /** The refresh token `tooling.tokens.rotate` takes now (spent by a rotation). */
  refreshToken = `${P.refresh}1-${alnum(40)}`
  /** Every configuration and refresh token issued (the dry run registers them as known secrets). */
  private readonly configTokens: string[] = [this.configToken, this.refreshToken]
  /** The manifest API refuses this token as `token_expired` (`expireConfigToken`). */
  private expiredToken: string | null = null
  readonly sessionToken = `${P.session}${digits(12)}-${digits(12)}-${alnum(32)}`
  readonly cookie = `${P.cookie}${alnum(48)}`
  readonly apps = new Map<string, StubApp>()
  readonly channels = new Map<string, StubChannel>()
  readonly dms = new Map<string, string>()
  /** Calls per method (for the dry run's self-checks). */
  readonly calls = new Map<string, number>()
  /** The test mailbox the sign-in code is emailed to. */
  readonly mailbox = new StubMailbox()
  /**
   * A password sign-in asks for an emailed code (a new device), as a real
   * first sign-in on a VM does. Off: the password alone signs in.
   */
  requireEmailCode = true
  /**
   * The first right code typed is refused ("That code didn't work") and a
   * newer one emailed, as when Slack has sent a code since. The dry run turns
   * it on to prove a refused-then-accepted sign-in.
   */
  refuseFirstCode = false
  /**
   * Sign-ins completed with the emailed code; wrong codes the prompt refused;
   * right codes refused on purpose (`refuseFirstCode`).
   */
  readonly codeCounts = { accepted: 0, refused: 0, superseded: 0 }
  /** The decoy code emails' ids (a Slack code sent to another account of the test human's inbox). */
  readonly decoyMailIds: string[] = []
  /** The code the open prompt waits for. */
  private pendingCode: string | null = null
  /** Every code the stub emailed (the dry run registers them as known secrets). */
  private readonly codes: string[] = []
  /** The number in the stub's Gmail forwarding confirmation. */
  readonly forwardingCode = digits(9)
  /** The confirm link in the stub's Gmail forwarding confirmation (its cancel link is the same with `uf-`). */
  readonly forwardingConfirmLink = `https://mail-settings.google.com/mail/vf-%5B${alnum(24)}%5D-${alnum(27)}`
  private seq = 0
  private tsSeq = 0

  constructor(
    readonly domain: string,
    readonly email: string,
    readonly password: string,
  ) {
    // Mail that must not be taken for the code: an old Slack code (before any sign-in attempt) and Gmail's forwarding request.
    const hourAgo = Date.now() - 3_600_000
    const old = this.newCode()
    this.mailbox.deliver({ ...slackCodeMail(old, 'no-reply@slack.com', email), createdAtMs: hourAgo, deliverAtMs: 0 })
    // Gmail's shape: the confirm link, then the cancel link (`uf-`) after a paragraph that names both.
    const cancelLink = this.forwardingConfirmLink.replace('/mail/vf-', '/mail/uf-')
    this.mailbox.deliver({
      from: { address: 'forwarding-noreply@google.com', name: 'Gmail Team' },
      to: this.mailbox.address,
      subject: `(#${this.forwardingCode}) Gmail Forwarding Confirmation - Receive Mail from ${email}`,
      text:
        `${email} has requested to automatically forward mail to your email address ${this.mailbox.address}.\nConfirmation code: ${this.forwardingCode}\n\n` +
        `To allow ${email} to automatically forward mail to your address, please click the link below to confirm the request:\n\n${this.forwardingConfirmLink}\n\n` +
        `If you do not approve of this request, no further action is required. ${email} cannot automatically forward messages to your email address unless you confirm the request by clicking the link above. ` +
        `If you accidentally clicked the link, but you do not want to allow ${email} to automatically forward messages to your address, click this link to cancel this verification:\n${cancelLink}\n\n` +
        'To learn more about why you might have received this message, please visit: https://support.google.com/mail/answer/184973.\n',
      html: [],
      createdAtMs: hourAgo + 60_000,
      deliverAtMs: 0,
    })
  }

  private newCode(): string {
    const code = stubSignInCode()
    this.codes.push(code)
    return code
  }

  /**
   * A password sign-in succeeded. With `requireEmailCode`, a code is emailed
   * to the test human (visible in the mailbox `delayMs` later) and `true` is
   * returned: the page asks for it. Beside it, newer, come a decoy (Slack's
   * code for another account of the same inbox, `sameInboxOtherAddress`) and
   * a look-alike from a non-Slack domain: a wait that skipped the recipient
   * or the sender check would take one of them first.
   */
  startEmailCode(nowMs: number, delayMs = CODE_MAIL_DELAY_MS): boolean {
    if (!this.requireEmailCode) return false
    const deliverAtMs = nowMs + delayMs
    this.emailCode(deliverAtMs)
    const decoy = slackCodeMail(this.newCode(), 'no-reply@slack.com', sameInboxOtherAddress(this.email))
    this.decoyMailIds.push(this.mailbox.deliver({ ...decoy, createdAtMs: deliverAtMs - 250, deliverAtMs }).id)
    this.mailbox.deliver({ ...slackCodeMail(this.newCode(), 'no-reply@slack.com.mailbox.invalid', this.email), createdAtMs: deliverAtMs, deliverAtMs })
    return true
  }

  /** A new code is the one the prompt waits for, emailed to the test human (visible at `deliverAtMs`). */
  private emailCode(deliverAtMs: number): void {
    const code = this.newCode()
    this.pendingCode = code
    this.mailbox.deliver({ ...slackCodeMail(code, 'no-reply@slack.com', this.email), createdAtMs: deliverAtMs - 500, deliverAtMs })
  }

  hasPendingCode(): boolean {
    return this.pendingCode !== null
  }

  /**
   * The code typed into the prompt (dashes, spaces and case ignored): `true`
   * signs in. With `refuseFirstCode`, the first right one is refused and a
   * newer code emailed (at `nowMs`, arriving as a sign-in's does).
   */
  submitCode(typed: string, nowMs = Date.now()): boolean {
    const want = this.pendingCode?.replace(/-/g, '')
    if (want !== undefined && typed.replace(/[\s-]/g, '').toUpperCase() === want) {
      if (this.refuseFirstCode && this.codeCounts.superseded === 0) {
        this.codeCounts.superseded += 1
        this.emailCode(nowMs + CODE_MAIL_DELAY_MS)
        return false
      }
      this.pendingCode = null
      this.codeCounts.accepted += 1
      return true
    }
    this.codeCounts.refused += 1
    return false
  }

  /** The current configuration token expires: the manifest API answers `token_expired` for it. */
  expireConfigToken(): void {
    this.expiredToken = this.configToken
  }

  /** `tooling.tokens.rotate`: the refresh token for a new pair; the old pair is spent. */
  private rotateConfigTokens(refreshToken: string | undefined): SlackResponse {
    if (refreshToken !== this.refreshToken) return { ok: false, error: 'invalid_refresh_token' }
    this.configToken = `${P.config}1-${alnum(40)}`
    this.refreshToken = `${P.refresh}1-${alnum(40)}`
    this.configTokens.push(this.configToken, this.refreshToken)
    const iat = Math.floor(Date.now() / 1000)
    return { ok: true, token: this.configToken, refresh_token: this.refreshToken, team_id: STUB_TEAM_ID, user_id: STUB_HUMAN_ID, iat, exp: iat + 43_200 }
  }

  /** Every token the stub issued (the dry run registers them as known secrets). */
  allTokens(): string[] {
    const out = [...this.configTokens, this.sessionToken, this.cookie]
    for (const app of this.apps.values()) {
      if (app.botToken) out.push(app.botToken)
      for (const t of app.appTokens) out.push(t.token)
    }
    out.push(...this.mailbox.secrets())
    for (const code of this.codes) out.push(code, code.replace(/-/g, ''))
    return out
  }

  private count(method: string): void {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1)
  }

  private nextTs(): string {
    this.tsSeq += 1
    return `${Math.floor(Date.now() / 1000)}.${String(this.tsSeq).padStart(6, '0')}`
  }

  private appByBotToken(token: string): StubApp | undefined {
    return [...this.apps.values()].find((a) => a.botToken === token)
  }

  private appByAppToken(token: string): StubApp | undefined {
    return [...this.apps.values()].find((a) => a.appTokens.some((t) => t.token === token))
  }

  // --- manifest API (configuration token) ---------------------------------

  createApp(manifest: Record<string, unknown>, options: { foreign?: boolean } = {}): StubApp {
    this.seq += 1
    const n = String(this.seq).padStart(4, '0')
    const app: StubApp = {
      id: `A0DRY${n}ST`,
      manifest,
      installed: false,
      botToken: null,
      botUserId: `U0DRYB${n}T`,
      botId: `B0DRYB${n}T`,
      appTokens: [],
      ...(options.foreign ? { foreign: true } : {}),
    }
    this.apps.set(app.id, app)
    return app
  }

  install(appId: string): StubApp | null {
    const app = this.apps.get(appId)
    if (!app) return null
    app.installed = true
    app.botToken = `${P.bot}${digits(12)}-${digits(13)}-${alnum(24)}`
    return app
  }

  generateAppToken(appId: string, name: string): string | null {
    const app = this.apps.get(appId)
    if (!app) return null
    const token = `${P.app}1-${app.id}-${digits(13)}-${randomBytes(32).toString('hex')}`
    app.appTokens.push({ name, token })
    return token
  }

  revokeAppToken(appId: string, name: string): boolean {
    const app = this.apps.get(appId)
    if (!app) return false
    const before = app.appTokens.length
    app.appTokens = app.appTokens.filter((t) => t.name !== name)
    return app.appTokens.length < before
  }

  /** A Slack Web API call with a bearer token (bot, app-level or configuration token). */
  api(method: string, bearer: string | null, params: Record<string, string>): SlackResponse {
    this.count(method)
    const err = (error: string): SlackResponse => ({ ok: false, error })
    if (method === 'tooling.tokens.rotate') return this.rotateConfigTokens(params.refresh_token)
    if (method.startsWith('apps.manifest.')) {
      if (bearer !== null && bearer === this.expiredToken) return err('token_expired')
      if (bearer !== this.configToken) return err('invalid_auth')
      if (method === 'apps.manifest.validate') return { ok: true }
      let manifest: Record<string, unknown> | null = null
      if (params.manifest !== undefined) {
        try {
          manifest = JSON.parse(params.manifest) as Record<string, unknown>
        } catch {
          return err('invalid_manifest')
        }
      }
      if (method === 'apps.manifest.create') {
        if (!manifest) return err('invalid_arguments')
        const app = this.createApp(manifest)
        // As Slack: the answer carries the app's credentials, which the runner must discard.
        return { ok: true, app_id: app.id, credentials: { client_id: `${digits(10)}.${digits(10)}`, client_secret: alnum(32), signing_secret: alnum(32) } }
      }
      const app = this.apps.get(params.app_id ?? '')
      if (!app || app.foreign) return err('invalid_app_id')
      if (method === 'apps.manifest.export') return { ok: true, manifest: app.manifest }
      if (method === 'apps.manifest.delete') {
        this.apps.delete(app.id)
        return { ok: true }
      }
      if (method === 'apps.manifest.update') {
        if (!manifest) return err('invalid_arguments')
        app.manifest = manifest
        return { ok: true, app_id: app.id, permissions_updated: false }
      }
      return err('unknown_method')
    }
    if (method === 'apps.connections.open') {
      if (!bearer) return err('not_authed')
      if (!this.appByAppToken(bearer)) return err(this.appByBotToken(bearer) ? 'not_allowed_token_type' : 'invalid_auth')
      return { ok: true, url: 'wss://stub.invalid/link/' }
    }
    const app = bearer ? this.appByBotToken(bearer) : undefined
    if (!app) return err(bearer ? 'invalid_auth' : 'not_authed')
    if (method === 'auth.test') {
      return { ok: true, user_id: app.botUserId, bot_id: app.botId, team_id: STUB_TEAM_ID, team: STUB_TEAM_NAME, user: 'bot' }
    }
    if (method === 'bots.info') {
      if (params.bot !== app.botId) return err('bot_not_found')
      return { ok: true, bot: { id: app.botId, app_id: app.id, user_id: app.botUserId } }
    }
    return err('unknown_method')
  }

  // --- the human session API ----------------------------------------------

  human(method: string, params: Record<string, string>, cookie: string | null): SlackResponse {
    this.count(`human:${method}`)
    const err = (error: string): SlackResponse => ({ ok: false, error })
    if (params.token !== this.sessionToken || cookie !== this.cookie) return err('invalid_auth')
    const channel = this.channels.get(params.channel ?? '')
    switch (method) {
      case 'auth.test':
        return { ok: true, user_id: STUB_HUMAN_ID, team_id: STUB_TEAM_ID, team: STUB_TEAM_NAME }
      case 'conversations.list':
        return {
          ok: true,
          channels: [...this.channels.values()].map((c) => ({ id: c.id, name: c.name, is_archived: c.archived, is_member: c.members.has(STUB_HUMAN_ID) })),
          response_metadata: { next_cursor: '' },
        }
      case 'conversations.create': {
        const name = params.name ?? ''
        if ([...this.channels.values()].some((c) => c.name === name)) return err('name_taken')
        const id = `C0DRY${String(this.channels.size + 1).padStart(4, '0')}C`
        this.channels.set(id, { id, name, archived: false, members: new Set([STUB_HUMAN_ID]), messages: [] })
        return { ok: true, channel: { id, name, is_archived: false, is_member: true } }
      }
      case 'conversations.join':
      case 'conversations.unarchive':
        if (!channel) return err('channel_not_found')
        channel.members.add(STUB_HUMAN_ID)
        channel.archived = false
        return { ok: true }
      case 'conversations.invite':
        if (!channel) return err('channel_not_found')
        if (channel.members.has(params.users ?? '')) return err('already_in_channel')
        channel.members.add(params.users ?? '')
        return { ok: true }
      case 'conversations.kick':
        if (!channel) return err('channel_not_found')
        return channel.members.delete(params.user ?? '') ? { ok: true } : err('not_in_channel')
      case 'conversations.members':
        if (!channel) return err('channel_not_found')
        return { ok: true, members: [...channel.members], response_metadata: { next_cursor: '' } }
      case 'users.conversations':
        return {
          ok: true,
          channels: [...this.channels.values()].filter((c) => c.members.has(params.user ?? '')).map((c) => ({ id: c.id, name: c.name })),
        }
      case 'conversations.open': {
        const user = params.users ?? ''
        const id = this.dms.get(user) ?? `D0DRY${String(this.dms.size + 1).padStart(4, '0')}D`
        this.dms.set(user, id)
        return { ok: true, channel: { id } }
      }
      case 'chat.postMessage': {
        if (!channel) return err('channel_not_found')
        const ts = this.nextTs()
        channel.messages.push({ ts, user: STUB_HUMAN_ID, text: params.text ?? '' })
        return { ok: true, ts, channel: channel.id }
      }
      case 'conversations.history':
        if (!channel) return err('channel_not_found')
        return { ok: true, messages: [...channel.messages].reverse() }
      default:
        return err('unknown_method')
    }
  }

  /**
   * A fixture prompt message with Allow/Deny buttons, their action ids in
   * CSCB's shape (`perm_<decision>_<instance>_<uuid>`), for the dry run's
   * click self-test.
   */
  addPrompt(channelId: string, fromUser: string, instanceId = 'cscb_persona_a'): string {
    const channel = this.channels.get(channelId)
    if (!channel) throw new Error('no such stub channel')
    const ts = this.nextTs()
    const token = randomUUID()
    const button = (text: string, decision: string) => ({ type: 'button', text: { type: 'plain_text', text }, action_id: `perm_${decision}_${instanceId}_${token}` })
    channel.messages.push({
      ts,
      user: fromUser,
      text: 'permission request: Bash',
      blocks: [{ type: 'actions', elements: [button('Allow', 'allow'), button('Deny', 'deny')] }],
    })
    return ts
  }

  /** `count` plain messages from `fromUser` (so an earlier message scrolls out of the client's rendered window). */
  addChatter(channelId: string, fromUser: string, count: number): void {
    const channel = this.channels.get(channelId)
    if (!channel) throw new Error('no such stub channel')
    for (let i = 1; i <= count; i++) channel.messages.push({ ts: this.nextTs(), user: fromUser, text: `chatter ${i} of ${count}` })
  }

  /** A click on a fixture prompt: the message updates as CSCB's click handler would update it. */
  click(channelId: string, ts: string, button: string): boolean {
    const message = this.channels.get(channelId)?.messages.find((m) => m.ts === ts)
    if (!message || !message.blocks) return false
    message.text = button === 'Allow' ? '*Permission* — Allowed' : '*Permission* — Denied by operator'
    delete message.blocks
    return true
  }
}
