/**
 * slack-stub-server.ts — a loopback stand-in for Slack's Web API and Socket
 * Mode, for the docker integration scenarios that start CSCB outside dry run:
 * Test 10 (the credentials change and the decision-13 handshake-failure
 * check), Test 12, the fmk scenarios, and test-29 (the invited-channel
 * scenario, which also pushes events through it).
 *
 * Real Slack is not reachable in the `/ci` container. A non-dry-run server
 * reaches this stub through the opt-in Slack API base URL, an environment
 * variable honoured only for a loopback URL (E14 director decision 1). The
 * expected name is `CSCB_SLACK_API_URL`; point it at the stub's `api_url`:
 *
 *   CSCB_SLACK_API_URL=http://127.0.0.1:<port>/api/
 *
 * `tests/test-helpers/slack-stub.ts` is an in-process mock; this is a real
 * server a daemon can call. Self-contained on purpose: Bun and `node:`
 * built-ins only, no import from `src/` or the test helpers (the container
 * copies `tests/` without `src/`).
 *
 * START
 * -----
 *   bun tests/integration/fixtures/slack-stub-server.ts \
 *     --record <file.jsonl> [--port <n>] [--control <file.json>] [--ready-file <file.json>]
 *
 *   --record      JSONL file every request is appended to (created if absent).
 *   --port        TCP port on 127.0.0.1 (default 0: any free port).
 *   --control     JSON control file (format below). Re-read whenever its
 *                 mtime or size changes, so a scenario switches answers
 *                 mid-run by rewriting it (write a temp file, then `mv`).
 *   --ready-file  written once listening (temp file + rename):
 *                 {"pid", "port", "api_url", "closed_port"}.
 *
 * It binds 127.0.0.1 only, prints one `slack-stub: listening on <api_url>`
 * line, and on SIGTERM or SIGINT closes every socket and exits 0.
 *
 * CONTROL (file, or `POST /_control` with the same JSON; last write wins)
 * -------
 *   {
 *     "tokens": [
 *       { "suffix": "alpha1", "label": "alpha", "auth": "ok",
 *         "connections": "ok", "ticket": "MARKER",
 *         "user_id": "U…", "bot_id": "B…", "ws_scheme": "ws" }
 *     ],
 *     "default": { "auth": "ok", "connections": "ok" }
 *   }
 *
 * A request's token is its `Authorization: Bearer` value (or a `token` form
 * field). The first `tokens` entry whose `suffix` the token ends with applies;
 * scenarios build tokens at runtime and end each with a distinct suffix.
 * `label` names the persona in the record. An unmatched token gets `default`
 * and the label `unlabelled-<hash>`. Only `suffix` and `label` are required.
 *
 * - `auth` (bot-token Web API methods, `auth.test` included): `ok`, any Slack
 *   error code (`invalid_auth`, `token_revoked`, … answered `ok: false`), or
 *   `http-<status>` (that HTTP status, empty body).
 * - `connections` (`apps.connections.open`, app token): `ok` (a URL to this
 *   stub's `/link/?ticket=…`, which upgrades and sends `hello`),
 *   `closed-port` (a URL to a loopback port nothing listens on: a real
 *   handshake failure), `refuse-handshake` (a URL to this stub, which answers
 *   the upgrade with HTTP 400), `no-hello` (upgrades, never sends `hello`),
 *   `no-url` (`ok: true` without `url`), a Slack error code, or `http-<status>`.
 *   A non-app token gets `not_allowed_token_type`.
 * - `ticket`: the `ticket=` marker in the URL (letters, digits, `_` and `-`;
 *   default `stubticket`), followed by a sequence number. Put a leak marker
 *   here to check the server log never shows a connection ticket.
 * - `ws_scheme`: the URL's scheme, `ws` or `wss` (default `wss` for
 *   `closed-port`, which mirrors Slack's real URL shape; `ws` otherwise).
 * - `user_id` / `bot_id`: `auth.test`'s identity; default `U`/`B` plus the
 *   token's hash, so two tokens get two identities.
 *
 * Other endpoints: `GET /_control` (the labels in force), `GET /_health`,
 * `POST /_push` (below), and `POST /upload/<id>` (the upload URL
 * `files.getUploadURLExternal` hands out). Every other Web API method answers
 * `ok: true` with the shape CSCB reads (`chat.postMessage` a `ts`,
 * `conversations.open` a channel ID, …).
 *
 * PUSH (`POST /_push`, JSON; b.deo SRI-1402)
 * ----
 *   {
 *     "label": "alpha",
 *     "event": { "type": "message", "channel": "C…", "channel_type": "channel", … },
 *     "envelope": { "is_ext_shared_channel": true }
 *   }
 *
 * Sends one Socket Mode `events_api` envelope, shaped as Slack's, over the
 * label's open WebSocket:
 *
 *   {
 *     "envelope_id": "<uuid>", "type": "events_api",
 *     "accepts_response_payload": false, "retry_attempt": 0, "retry_reason": "",
 *     "payload": {
 *       "type": "event_callback", "team_id": "T0STUBTEAM", "api_app_id": "A0STUBAPP",
 *       "event": <the push's event, unchanged>,
 *       "event_id": "Ev…", "event_time": <the push's time, in seconds>,
 *       "is_ext_shared_channel": false
 *     }
 *   }
 *
 * - `label` (required, a non-empty string): a label of the control in force,
 *   matched against the label each WebSocket opened under.
 * - `event` (required, a JSON object): the inner event as the scenario writes
 *   it, sent unchanged.
 * - `envelope` (optional, an object): `is_ext_shared_channel` is the one
 *   envelope field a push may set. Not given, it is `false`. Given, it is sent
 *   as given: `true`, `false` or any non-boolean (`null`, a string, a number,
 *   an object). `"omit": ["is_ext_shared_channel"]` in place of it leaves the
 *   flag out of the payload. Every other envelope field is fixed or generated
 *   by the stub: `envelope_id` and `event_id` are unique per push, and
 *   `team_id` and `api_app_id` are the stub's team and app.
 * - The push goes to the label's newest open WebSocket: the one opened last
 *   among its sockets that are open now. A closed or closing socket is never
 *   chosen.
 * - A push carries no token, and `/_push` reads none.
 *
 * Answers (a refused push sends nothing):
 *   200 {"ok":true,"envelope_id":"<uuid>","event_id":"Ev…"}   sent
 *   400 {"ok":false,"error":"<reason>"}   malformed, the reason one of:
 *       `not-json`; `not-an-object`; `unknown-field` (a top-level key other
 *       than `label`, `event` and `envelope`); `no-label`; `event-not-object`;
 *       `envelope-not-object`; `envelope-field-fixed` (an envelope key other
 *       than `is_ext_shared_channel` and `omit`); `omit-invalid` (`omit` not a
 *       non-empty list naming only `is_ext_shared_channel`, or given beside it)
 *   409 {"ok":false,"error":"no-open-socket"}   the label has no open WebSocket
 *   503 {"ok":false,"error":"send-failed"}      the socket did not accept the send
 *
 * Any other method on `/_push` is not found (404), as for any unknown path.
 *
 * RECORD (one JSON object per line, appended synchronously)
 * ------
 *   {"seq":1,"ts":"<ISO>","event":"start","port":…,"api_url":…,"closed_port":…}
 *   {"seq":…,"event":"api","method":"auth.test","label":"alpha","token_kind":"bot",
 *    "token_hash":"<12 hex>","answer":"ok","status":200, …}
 *   {"event":"ws-open"|"ws-close"|"ws-refused"|"ws-message", "label", "ticket", …}
 *   {"event":"control","source":"file"|"http","labels":[…]}  /  "control-error"
 *   {"event":"upload"} / {"event":"stop"}
 *   {"event":"push","label","envelope_id","event_type","channel","channel_type",
 *    "flag":"false"|"true"|"non-boolean"|"absent","flag_value"}
 *   {"event":"push-refused","label","reason"}
 *
 * A `push` line is written once per sent push, right after the send and so
 * before the client's ack, which is the `ws-message` line carrying the
 * push's `envelope_id`. `event_type`, `channel` and `channel_type` are the
 * event's `type`, `channel` and `channel_type` (null when not a string).
 * `flag` tells the four flag cases apart, and `flag_value` is the JSON text
 * of the flag as sent (`"false"`, `"true"`, `"\"yes\""`, `"null"`, …), null
 * when the flag is left out. A `push-refused` line is written once per
 * refused push, its `reason` the answer's `error`, its `label` null when the
 * push named none. Neither line carries the event's text: every value they
 * copy from a push has token-like text replaced by `<token>` and is cut to at
 * most 100 characters.
 *
 * `api` lines also carry `channel`, `user` and `text` when the request has
 * them, and `args_token_like` (whether any argument held token-like text).
 * `text` always has token-like text replaced by `<token>`, before it is
 * written. A `chat.postMessage` text is then recorded whole, so a scenario
 * can compare a posted notice in full; every other method's `text` is cut to
 * at most 300 characters. No token value is ever written or printed: only its kind (`bot`,
 * `app`, `user`, `other`, `none`) and the first 12 hex digits of its SHA-256.
 * The control's `suffix` values are not written either.
 *
 * SPDX-License-Identifier: MIT
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How `apps.connections.open` and the WebSocket behave for a token. */
export type StubConnectionsMode = 'ok' | 'closed-port' | 'refuse-handshake' | 'no-hello' | 'no-url' | string

/** Answers for tokens: every field optional. */
export interface StubAnswers {
  auth?: string
  connections?: StubConnectionsMode
  ticket?: string
  ws_scheme?: 'ws' | 'wss'
  user_id?: string
  bot_id?: string
}

/** One control entry: the tokens ending in `suffix` are `label`'s. */
export interface StubTokenRule extends StubAnswers {
  suffix: string
  label: string
}

/** The whole control document. */
export interface StubControl {
  tokens?: StubTokenRule[]
  default?: StubAnswers
}

export interface SlackStubOptions {
  /** JSONL record file. */
  recordPath: string
  /** TCP port on 127.0.0.1; 0 (default) for any free port. */
  port?: number
  /** Control file, re-read when it changes. */
  controlPath?: string
  /** Initial control when there is no control file. */
  control?: StubControl
}

export interface SlackStub {
  readonly port: number
  /** `http://127.0.0.1:<port>/api/`: the value for the base-URL variable. */
  readonly apiUrl: string
  /** A loopback port nothing listens on (the `closed-port` mode's target). */
  readonly closedPort: number
  /** Replace the control in force (as `POST /_control` does). */
  setControl(control: StubControl): void
  /**
   * Resolves with the first record line (since start) whose fields include
   * every field of `match`, as soon as it is written: for in-process tests
   * that must wait for, say, the server side of a WebSocket close.
   */
  waitFor(match: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Close every socket and stop listening. */
  stop(): Promise<void>
}

/** Per-WebSocket data: whose connection and which ticket. */
interface ConnData {
  label: string
  ticket: string
  hello: boolean
}

// ---------------------------------------------------------------------------
// Token handling (never writes a token)
// ---------------------------------------------------------------------------

/**
 * Token-like text, as the tests' `TOKEN_LIKE` defines it: a Slack token
 * prefix at a word start followed by a letter or digit. Built from pieces so
 * this file holds no token-like literal.
 */
const TOKEN_LIKE_SOURCE = '(?<![A-Za-z0-9])(?:xox[a-z]|xapp)' + '-[A-Za-z0-9]'
const TOKEN_LIKE = new RegExp(TOKEN_LIKE_SOURCE)
const TOKEN_LIKE_ALL = new RegExp(`${TOKEN_LIKE_SOURCE}[A-Za-z0-9-]*`, 'g')

type TokenKind = 'bot' | 'app' | 'user' | 'other' | 'none'

function tokenKind(token: string | undefined): TokenKind {
  if (token === undefined || token === '') return 'none'
  if (token.startsWith('xoxb-')) return 'bot'
  if (token.startsWith('xapp-')) return 'app'
  if (token.startsWith('xoxp-')) return 'user'
  return 'other'
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}

/** The Web API method whose `text` is recorded whole: the posts scenarios compare in full. */
const WHOLE_TEXT_METHOD = 'chat.postMessage'

/** The most characters of `text` recorded for any other method. */
const RECORDED_TEXT_MAX = 300

/** `text` as `method`'s record line carries it: token-like text replaced, then cut unless the method's text is kept whole. */
function recordedText(method: string, text: string): string {
  const redacted = text.replace(TOKEN_LIKE_ALL, '<token>')
  return method === WHOLE_TEXT_METHOD ? redacted : redacted.slice(0, RECORDED_TEXT_MAX)
}

// ---------------------------------------------------------------------------
// Control validation
// ---------------------------------------------------------------------------

const ANSWER_KEYS = ['auth', 'connections', 'ticket', 'ws_scheme', 'user_id', 'bot_id'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkAnswers(value: unknown, where: string): StubAnswers {
  if (!isObject(value)) throw new Error(`${where} must be an object`)
  const answers: StubAnswers = {}
  for (const key of ANSWER_KEYS) {
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== 'string' || field === '') throw new Error(`${where}.${key} must be a non-empty string`)
    if (key === 'ws_scheme' && field !== 'ws' && field !== 'wss') throw new Error(`${where}.ws_scheme must be ws or wss`)
    if (key === 'ticket' && !/^[A-Za-z0-9_-]+$/.test(field)) throw new Error(`${where}.ticket must be letters, digits, _ or -`)
    ;(answers as Record<string, string>)[key] = field
  }
  return answers
}

/** Validate a parsed control document; throws a message naming no value. */
export function parseControl(value: unknown): StubControl {
  if (!isObject(value)) throw new Error('control must be a JSON object')
  const control: StubControl = {}
  if (value.tokens !== undefined) {
    if (!Array.isArray(value.tokens)) throw new Error('control.tokens must be an array')
    control.tokens = value.tokens.map((entry, i) => {
      const answers = checkAnswers(entry, `tokens[${i}]`)
      const { suffix, label } = entry as Record<string, unknown>
      if (typeof suffix !== 'string' || suffix === '') throw new Error(`tokens[${i}].suffix must be a non-empty string`)
      if (typeof label !== 'string' || label === '') throw new Error(`tokens[${i}].label must be a non-empty string`)
      return { ...answers, suffix, label }
    })
  }
  if (value.default !== undefined) control.default = checkAnswers(value.default, 'default')
  return control
}

// ---------------------------------------------------------------------------
// Web API answers
// ---------------------------------------------------------------------------

const TEAM_ID = 'T0STUBTEAM'
const APP_ID = 'A0STUBAPP'
const METHOD_RE = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/

/** A fake Slack timestamp, unique per call. */
function slackTs(seq: number): string {
  return `${Math.floor(Date.now() / 1000)}.${String(seq).padStart(6, '0')}`
}

/** The `ok: true` body for a method other than `auth.test` / `apps.connections.open`. */
function okBody(method: string, args: Record<string, string>, seq: number, uploadBase: string): Record<string, unknown> {
  const channel = args.channel ?? 'C0STUBCHAN'
  switch (method) {
    case 'chat.postMessage':
    case 'chat.postEphemeral':
    case 'chat.update': {
      const ts = method === 'chat.update' ? (args.ts ?? slackTs(seq)) : slackTs(seq)
      return { ok: true, channel, ts, message: { type: 'message', text: args.text ?? '', ts } }
    }
    case 'conversations.open':
      return { ok: true, channel: { id: `D0STUB${String(seq).padStart(4, '0')}` } }
    case 'conversations.info':
      return { ok: true, channel: { id: channel, name: `stub-${channel.toLowerCase()}`, is_member: true } }
    case 'conversations.history':
    case 'conversations.replies':
      return { ok: true, messages: [], has_more: false, response_metadata: { next_cursor: '' } }
    case 'users.info': {
      const id = args.user ?? 'U0STUBUSER'
      return { ok: true, user: { id, name: `stub-${id.toLowerCase()}`, profile: { display_name: `stub-${id.toLowerCase()}`, real_name: 'Stub User' } } }
    }
    case 'bots.info':
      return { ok: true, bot: { id: args.bot ?? 'B0STUBBOT', app_id: APP_ID, name: 'stub-bot' } }
    case 'files.getUploadURLExternal': {
      const fileId = `F0STUB${String(seq).padStart(4, '0')}`
      return { ok: true, file_id: fileId, upload_url: `${uploadBase}${fileId}` }
    }
    case 'files.completeUploadExternal':
      return { ok: true, files: [{ id: 'F0STUBFILE', title: 'stub' }] }
    default:
      return { ok: true }
  }
}

/** `http-<status>` → the status; otherwise undefined. */
function httpStatusOf(answer: string): number | undefined {
  const match = /^http-(\d{3})$/.exec(answer)
  return match === null ? undefined : Number(match[1])
}

// ---------------------------------------------------------------------------
// Push control (b.deo SRI-1402)
// ---------------------------------------------------------------------------

/** The one envelope field a push may set or leave out. */
const PUSH_FLAG = 'is_ext_shared_channel'

/** The keys a push request may carry, and the keys its `envelope` may carry. */
const PUSH_KEYS: readonly string[] = ['label', 'event', 'envelope']
const PUSH_ENVELOPE_KEYS: readonly string[] = [PUSH_FLAG, 'omit']

/** The most characters of a push-supplied value a `push` or `push-refused` line carries. */
const PUSH_FIELD_MAX = 100

/** `WebSocket.OPEN`: the only ready state a push is sent on. */
const WS_OPEN = 1

/** Why a push is refused: the answer's `error` and the record line's `reason`. */
type PushRefusalReason =
  | 'not-json'
  | 'not-an-object'
  | 'unknown-field'
  | 'no-label'
  | 'event-not-object'
  | 'envelope-not-object'
  | 'envelope-field-fixed'
  | 'omit-invalid'
  | 'no-open-socket'
  | 'send-failed'

/** The HTTP status of each refusal: 400 for a malformed push. */
const PUSH_REFUSAL_STATUS: Readonly<Record<PushRefusalReason, number>> = {
  'not-json': 400,
  'not-an-object': 400,
  'unknown-field': 400,
  'no-label': 400,
  'event-not-object': 400,
  'envelope-not-object': 400,
  'envelope-field-fixed': 400,
  'omit-invalid': 400,
  'no-open-socket': 409,
  'send-failed': 503,
}

/** The flag a push asks for: a value sent as given, or left out. */
type PushFlag = { sent: true; value: unknown } | { sent: false }

type ParsedPush =
  | { ok: true; label: string; event: Record<string, unknown>; flag: PushFlag }
  | { ok: false; label: string | null; reason: PushRefusalReason }

/** Read a `POST /_push` body; a malformed one names its reason and, when it has one, its label. */
function parsePush(text: string): ParsedPush {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, label: null, reason: 'not-json' }
  }
  if (!isObject(body)) return { ok: false, label: null, reason: 'not-an-object' }
  const label = typeof body.label === 'string' && body.label !== '' ? body.label : null
  if (Object.keys(body).some(key => !PUSH_KEYS.includes(key))) return { ok: false, label, reason: 'unknown-field' }
  if (label === null) return { ok: false, label, reason: 'no-label' }
  const event = body.event
  if (!isObject(event)) return { ok: false, label, reason: 'event-not-object' }
  if (body.envelope === undefined) return { ok: true, label, event, flag: { sent: true, value: false } }
  const envelope = body.envelope
  if (!isObject(envelope)) return { ok: false, label, reason: 'envelope-not-object' }
  if (Object.keys(envelope).some(key => !PUSH_ENVELOPE_KEYS.includes(key))) return { ok: false, label, reason: 'envelope-field-fixed' }
  if (envelope.omit !== undefined) {
    const omit = envelope.omit
    const valid = envelope[PUSH_FLAG] === undefined && Array.isArray(omit) && omit.length > 0 && omit.every(name => name === PUSH_FLAG)
    return valid ? { ok: true, label, event, flag: { sent: false } } : { ok: false, label, reason: 'omit-invalid' }
  }
  return { ok: true, label, event, flag: { sent: true, value: envelope[PUSH_FLAG] === undefined ? false : envelope[PUSH_FLAG] } }
}

/** A push-supplied string as a record line carries it: token-like text replaced, then cut; null when not a string. */
function pushFieldText(value: unknown): string | null {
  return typeof value === 'string' ? value.replace(TOKEN_LIKE_ALL, '<token>').slice(0, PUSH_FIELD_MAX) : null
}

/** The `push` line's `flag` and `flag_value`: which of the four cases, and the value's JSON text. */
function pushFlagFields(flag: PushFlag): { flag: 'false' | 'true' | 'non-boolean' | 'absent'; flag_value: string | null } {
  if (!flag.sent) return { flag: 'absent', flag_value: null }
  const kind = flag.value === false ? 'false' : flag.value === true ? 'true' : 'non-boolean'
  return { flag: kind, flag_value: pushFieldText(JSON.stringify(flag.value)) }
}

/** Read a request's arguments: a form or JSON body, as the Web API client sends them. */
async function readArgs(req: Request): Promise<Record<string, string>> {
  const text = await req.text()
  if (text === '') return {}
  const type = req.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isObject(parsed)) return {}
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) out[k] = typeof v === 'string' ? v : JSON.stringify(v)
      return out
    } catch {
      return {}
    }
  }
  return Object.fromEntries(new URLSearchParams(text))
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** A loopback port nothing listens on: bind port 0, note it, close it. */
function reserveClosedPort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  return port
}

export function startSlackStub(options: SlackStubOptions): SlackStub {
  const { recordPath, controlPath } = options
  let seq = 0
  let ticketSeq = 0
  let pushSeq = 0
  let control: StubControl = options.control ?? {}
  let controlStamp = ''
  const tickets = new Map<string, { label: string; mode: string }>()
  const sockets = new Set<Bun.ServerWebSocket<ConnData>>()
  const closedPort = reserveClosedPort()

  appendFileSync(recordPath, '')

  const written: Record<string, unknown>[] = []
  const waiters: { match: Record<string, unknown>; resolve: (line: Record<string, unknown>) => void }[] = []
  const matches = (line: Record<string, unknown>, match: Record<string, unknown>): boolean =>
    Object.entries(match).every(([key, value]) => line[key] === value)

  function record(event: string, fields: Record<string, unknown> = {}): void {
    seq += 1
    const line = { seq, ts: new Date().toISOString(), event, ...fields }
    appendFileSync(recordPath, `${JSON.stringify(line)}\n`)
    written.push(line)
    for (const waiter of waiters.filter(w => matches(line, w.match))) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(line)
    }
  }

  function labelsOf(c: StubControl): string[] {
    return (c.tokens ?? []).map(rule => rule.label)
  }

  function applyControl(next: StubControl, source: 'file' | 'http'): void {
    control = next
    record('control', { source, labels: labelsOf(next) })
  }

  /** Re-read the control file when its mtime or size changed; keep the old control on a bad file. */
  function refreshControl(): void {
    if (controlPath === undefined) return
    let stamp: string
    try {
      const st = statSync(controlPath)
      stamp = `${st.mtimeMs}:${st.size}`
    } catch {
      return
    }
    if (stamp === controlStamp) return
    controlStamp = stamp
    try {
      applyControl(parseControl(JSON.parse(readFileSync(controlPath, 'utf8'))), 'file')
    } catch (err) {
      record('control-error', { source: 'file', reason: err instanceof SyntaxError ? 'not JSON' : (err as Error).message })
    }
  }

  function answersFor(token: string | undefined): { label: string; answers: StubAnswers } {
    if (token !== undefined && token !== '') {
      const rule = (control.tokens ?? []).find(candidate => token.endsWith(candidate.suffix))
      if (rule !== undefined) return { label: rule.label, answers: rule }
      return { label: `unlabelled-${tokenHash(token)}`, answers: control.default ?? {} }
    }
    return { label: 'no-token', answers: control.default ?? {} }
  }

  function refusePush(label: string | null, reason: PushRefusalReason): Response {
    record('push-refused', { label: pushFieldText(label), reason })
    return Response.json({ ok: false, error: reason }, { status: PUSH_REFUSAL_STATUS[reason] })
  }

  /** `POST /_push`: one `events_api` envelope over the label's newest open WebSocket (b.deo SRI-1402). */
  function push(text: string): Response {
    const parsed = parsePush(text)
    if (!parsed.ok) return refusePush(parsed.label, parsed.reason)
    const { label, event, flag } = parsed
    let target: Bun.ServerWebSocket<ConnData> | undefined
    for (const ws of sockets) {
      if (ws.data.label === label && ws.readyState === WS_OPEN) target = ws // insertion order: the last match was opened last
    }
    if (target === undefined) return refusePush(label, 'no-open-socket')
    pushSeq += 1
    const envelopeId = randomUUID()
    const eventId = `Ev0STUB${String(pushSeq).padStart(4, '0')}${randomUUID().slice(0, 8).toUpperCase()}`
    const payload: Record<string, unknown> = {
      type: 'event_callback',
      team_id: TEAM_ID,
      api_app_id: APP_ID,
      event,
      event_id: eventId,
      event_time: Math.floor(Date.now() / 1000),
    }
    if (flag.sent) payload[PUSH_FLAG] = flag.value
    const envelope = {
      envelope_id: envelopeId,
      type: 'events_api',
      accepts_response_payload: false,
      retry_attempt: 0,
      retry_reason: '',
      payload,
    }
    let sendStatus: number
    try {
      sendStatus = target.send(JSON.stringify(envelope)) // -1 queued under backpressure, 0 dropped, >0 bytes sent
    } catch {
      sendStatus = 0
    }
    if (sendStatus === 0) return refusePush(label, 'send-failed')
    record('push', {
      label: pushFieldText(label),
      envelope_id: envelopeId,
      event_type: pushFieldText(event.type),
      channel: pushFieldText(event.channel),
      channel_type: pushFieldText(event.channel_type),
      ...pushFlagFields(flag),
    })
    return Response.json({ ok: true, envelope_id: envelopeId, event_id: eventId })
  }

  refreshControl()

  const server = Bun.serve<ConnData>({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    async fetch(req, srv) {
      refreshControl()
      const url = new URL(req.url)
      const path = url.pathname

      if (path === '/_health') return Response.json({ ok: true })
      if (path === '/_control') {
        if (req.method === 'GET') return Response.json({ ok: true, labels: labelsOf(control) })
        try {
          applyControl(parseControl(JSON.parse(await req.text())), 'http')
          return Response.json({ ok: true, labels: labelsOf(control) })
        } catch (err) {
          const reason = err instanceof SyntaxError ? 'not JSON' : (err as Error).message
          record('control-error', { source: 'http', reason })
          return Response.json({ ok: false, error: reason }, { status: 400 })
        }
      }
      if (path === '/_push' && req.method === 'POST') return push(await req.text())

      if (path.startsWith('/link')) {
        const ticket = url.searchParams.get('ticket') ?? ''
        const issued = tickets.get(ticket)
        if (issued === undefined || issued.mode === 'refuse-handshake') {
          record('ws-refused', { label: issued?.label ?? 'unknown', ticket, reason: issued === undefined ? 'unknown-ticket' : 'refuse-handshake' })
          return new Response('handshake refused', { status: 400 })
        }
        tickets.delete(ticket) // single use, like Slack's
        if (srv.upgrade(req, { data: { label: issued.label, ticket, hello: issued.mode !== 'no-hello' } })) return undefined
        record('ws-refused', { label: issued.label, ticket, reason: 'not-an-upgrade' })
        return new Response('expected a WebSocket upgrade', { status: 400 })
      }

      if (path.startsWith('/upload/')) {
        await req.arrayBuffer()
        record('upload', { file_id: path.slice('/upload/'.length) })
        return new Response('OK')
      }

      const method = path.startsWith('/api/') ? path.slice('/api/'.length) : path.slice(1)
      if (!METHOD_RE.test(method)) return new Response('not found', { status: 404 })

      const args = await readArgs(req)
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
      const token = bearer ?? args.token
      const kind = tokenKind(token)
      const { label, answers } = answersFor(token)
      const n = seq + 1

      const fields: Record<string, unknown> = {
        method,
        label,
        token_kind: kind,
        token_hash: token === undefined || token === '' ? null : tokenHash(token),
      }
      if (args.channel !== undefined) fields.channel = args.channel
      if (args.user !== undefined) fields.user = args.user
      if (args.text !== undefined) fields.text = recordedText(method, args.text)
      fields.args_token_like = Object.entries(args).some(([k, v]) => k !== 'token' && TOKEN_LIKE.test(v))

      const answer = (name: string, body: Record<string, unknown> | undefined, status = 200): Response => {
        record('api', { ...fields, answer: name, status })
        return body === undefined ? new Response(null, { status }) : Response.json(body, { status })
      }
      const failWith = (code: string): Response => {
        const status = httpStatusOf(code)
        return status === undefined ? answer(code, { ok: false, error: code }) : answer(code, undefined, status)
      }

      if (kind === 'none') return answer('not_authed', { ok: false, error: 'not_authed' })

      if (method === 'apps.connections.open') {
        if (kind !== 'app') return answer('not_allowed_token_type', { ok: false, error: 'not_allowed_token_type' })
        const mode = answers.connections ?? 'ok'
        if (mode === 'no-url') return answer(mode, { ok: true })
        if (!['ok', 'closed-port', 'refuse-handshake', 'no-hello'].includes(mode)) return failWith(mode)
        ticketSeq += 1
        const ticket = `${answers.ticket ?? 'stubticket'}${ticketSeq}`
        const scheme = answers.ws_scheme ?? (mode === 'closed-port' ? 'wss' : 'ws')
        const port = mode === 'closed-port' ? closedPort : srv.port
        if (mode !== 'closed-port') tickets.set(ticket, { label, mode })
        fields.ticket = ticket
        return answer(mode, { ok: true, url: `${scheme}://127.0.0.1:${port}/link/?ticket=${ticket}&app_id=${APP_ID}` })
      }

      const auth = answers.auth ?? 'ok'
      if (auth !== 'ok') return failWith(auth)

      if (method === 'auth.test') {
        const hash = tokenHash(token!).toUpperCase().slice(0, 10)
        return answer('ok', {
          ok: true,
          url: `http://127.0.0.1:${srv.port}/`,
          team: 'stub-team',
          team_id: TEAM_ID,
          user: label,
          user_id: answers.user_id ?? `U${hash}`,
          bot_id: answers.bot_id ?? `B${hash}`,
          is_enterprise_install: false,
        })
      }
      return answer('ok', okBody(method, args, n, `http://127.0.0.1:${srv.port}/upload/`))
    },
    websocket: {
      // Slack's pings would start the client's 30 s server-ping watch; the
      // client's own pings (answered by Bun) keep the connection busy.
      sendPings: false,
      idleTimeout: 960,
      open(ws) {
        sockets.add(ws)
        record('ws-open', { label: ws.data.label, ticket: ws.data.ticket, hello: ws.data.hello })
        if (ws.data.hello) {
          ws.send(JSON.stringify({
            type: 'hello',
            num_connections: 1,
            debug_info: { host: 'slack-stub', approximate_connection_time: 18060 },
            connection_info: { app_id: APP_ID },
          }))
        }
      },
      message(ws, message) {
        let envelopeId: unknown
        try {
          const parsed: unknown = JSON.parse(typeof message === 'string' ? message : message.toString())
          envelopeId = isObject(parsed) ? parsed.envelope_id : undefined
        } catch {
          envelopeId = undefined
        }
        record('ws-message', { label: ws.data.label, envelope_id: typeof envelopeId === 'string' ? envelopeId : null })
      },
      close(ws, code) {
        sockets.delete(ws)
        record('ws-close', { label: ws.data.label, ticket: ws.data.ticket, code })
      },
    },
  })

  const port = server.port as number
  const apiUrl = `http://127.0.0.1:${port}/api/`
  record('start', { port, api_url: apiUrl, closed_port: closedPort })

  let stopped = false
  return {
    port,
    apiUrl,
    closedPort,
    setControl: next => applyControl(parseControl(next), 'http'),
    waitFor: match => {
      const found = written.find(line => matches(line, match))
      return found !== undefined ? Promise.resolve(found) : new Promise(resolve => waiters.push({ match, resolve }))
    },
    async stop() {
      if (stopped) return
      stopped = true
      for (const ws of sockets) ws.close(1001, 'stub stopping')
      await server.stop(true)
      record('stop')
    },
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { port: number; record: string; control?: string; ready?: string } {
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!['--port', '--record', '--control', '--ready-file'].includes(flag) || value === undefined) {
      throw new Error(`unknown or incomplete argument: ${flag}`)
    }
    values[flag] = value
  }
  if (values['--record'] === undefined) throw new Error('--record <file> is required')
  const port = Number(values['--port'] ?? '0')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535')
  return { port, record: values['--record'], control: values['--control'], ready: values['--ready-file'] }
}

if (import.meta.main) {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`slack-stub: ${(err as Error).message}`)
    process.exit(2)
  }
  const stub = startSlackStub({ recordPath: args.record, port: args.port, controlPath: args.control })
  if (args.ready !== undefined) {
    const tmp = `${args.ready}.tmp`
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, port: stub.port, api_url: stub.apiUrl, closed_port: stub.closedPort }))
    renameSync(tmp, args.ready)
  }
  console.log(`slack-stub: listening on ${stub.apiUrl}`)
  const shutdown = (): void => {
    void stub.stop().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
