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
 *     "default": { "auth": "ok", "connections": "ok" },
 *     "users": { "U…": { "name": "…", "real_name": "…",
 *                         "profile": { "display_name": "…", "real_name": "…" } } },
 *     "channels": { "C…": { "name": "…", "is_member": true, "is_channel": true,
 *                            "is_private": false, "is_mpim": false, "is_im": false,
 *                            "is_ext_shared": false, "error": "<Slack code>" } },
 *     "replies": { "C…": { "<ts>": { "message": { "ts": "<ts>", "user": "U…", "bot_id": "B…",
 *                                                  "thread_ts": "<ts>",
 *                                                  "metadata": { "event_type": "…", "event_payload": {} },
 *                                                  "blocks": [ … ] } } } },
 *     "reaction_pairs": [ { "id": "pair1", "label": "bravo", "channel": "C…",
 *                           "timestamp": "<ts>", "name": "white_check_mark",
 *                           "answers": ["ok", "already_reacted"] } ]
 *   }
 *
 * Every top-level key is optional; `users`, `channels` and `replies` are
 * independent of the token sections and apply to every label;
 * `reaction_pairs` applies only to the label each entry names.
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
 * `users` (keys `U…`/`W…`) overlays `users.info`'s defaults with the given
 * `name`, `real_name` and `profile` texts.
 *
 * `channels` (keys `C…`/`D…`/`G…`) answers `conversations.info` for the
 * requested `channel`:
 * - With no entry, the answer is `{"ok":true,"channel":{"id","name":"stub-<id
 *   in lower case>","is_member":true}}`, exactly as before these fields existed;
 *   no kind or sharing flag is added.
 * - `name` (string) and the booleans `is_member`, `is_channel`, `is_private`,
 *   `is_mpim`, `is_im` and `is_ext_shared` overlay those defaults. Only the
 *   fields given appear; the stub derives no flag from another.
 * - `error` (a Slack error code: lower-case letters, digits, `_`) makes the
 *   call answer `{"ok":false,"error":"<code>"}`, HTTP 200, whatever else the
 *   entry holds. Every `conversations.info` of that channel fails, the server's
 *   channel-name reads included.
 *
 * `replies` answers `conversations.replies` by the request's `channel` and
 * its exact `ts` (`<digits>.<1-6 digits>`). Other arguments (`oldest`,
 * `latest`, `inclusive`, …) are recorded, not interpreted. Each entry is one of:
 * - `{"message": {…}}`: answers `{"ok":true,"messages":[<message>],
 *   "has_more":false,"response_metadata":{"next_cursor":""}}`, the message
 *   exactly as given. It may hold only `ts` (required, a Slack ts; the
 *   server keeps the returned message whose `ts` equals the reacted one, so a
 *   scenario normally repeats the key), `user` (`U…`/`W…`) and/or `bot_id`
 *   (`B…`), at least one of the two, `thread_ts` (a Slack ts), `metadata`
 *   (`{"event_type": <non-empty string>, "event_payload"?: <object>}`) and
 *   `blocks` (a list of at most 50 objects, sent unchanged). The stub never
 *   adds an author, a thread, a marker or a button, and does not judge whether
 *   a message is a Server Post: the scenario writes the marker metadata or the
 *   permission buttons it wants the server to see.
 * - `{"error": "<Slack code>"}` (`not_in_channel`, `channel_not_found`, …):
 *   answers `{"ok":false,"error":"<code>"}`, HTTP 200.
 * - `{}`: explicitly no message: the empty answer below.
 * `message` and `error` together are refused. A request whose channel or ts
 * has no entry, and every `conversations.history`, gets the empty answer
 * `{"ok":true,"messages":[],"has_more":false,"response_metadata":{"next_cursor":""}}`.
 *
 * A configured error is checked after the token's `auth`, so a refused token
 * still answers its `auth` code. No other method reads `channels` or
 * `replies`.
 *
 * `reaction_pairs` (opt-in; absent, every `reactions.add` answers `ok` as
 * before) scripts two overlapping `reactions.add` calls. Each entry is
 * `{id, label, channel, timestamp, name, answers}`, every field required:
 * `id` 1 to 64 letters, digits, `_` or `-`; `label` a token label (1 to
 * 100 printable characters); `channel` a channel ID; `timestamp` a Slack
 * ts; `name` an emoji name; `answers` exactly `["ok","already_reacted"]`
 * or `["already_reacted","ok"]`. At most 32 entries, ids unique, and no two
 * entries with one label/channel/timestamp/name. An entry applies only to a
 * `reactions.add` whose label, `channel`, `timestamp` and `name` all equal
 * its own; every other request and method is answered as without it.
 * - One id is ONE pair of two requests. The first matching request (slot 1)
 *   is held, unanswered, until the second (slot 2) arrives; then slot 1 gets
 *   `answers[0]` and, REACTION_PAIR_ANSWER_GAP_MS (200 ms) later, slot 2 gets
 *   `answers[1]`, so the server sees them in that order. `ok` is
 *   `{"ok":true}`; `already_reacted` is `{"ok":false,"error":"already_reacted"}`,
 *   HTTP 200, the shapes every other answer uses.
 * - Failures never give a configured answer. Each is
 *   `{"ok":false,"error":"stub_pair_<outcome>"}`, HTTP 200 (a Slack error,
 *   which the Web API client does not retry), and a `fail` record line:
 *   `timeout` (no slot 2 within REACTION_PAIR_TIMEOUT_MS, 10 s: slot 1
 *   fails; a later match is `exhausted`), `refused` (a matching request's
 *   token `auth` is not `ok`: that request answers its `auth` code, and a
 *   held slot 1 fails `refused`), `exhausted` (a match after its pair
 *   completed or failed), `reused` (a later control defines a known id with
 *   another label/channel/timestamp/name/answers: a held slot 1 of that id
 *   fails as soon as the control loads, and every later match of the new
 *   entry fails too) and `stopped` (the stub stopped while a pair request
 *   was held or waiting its gap).
 * - Pair state is kept by id for the stub's life: loading another control,
 *   by file or `POST /_control`, neither resets a spent id nor drops a held
 *   request (a held slot 1 still pairs with its tuple's slot 2 when the new
 *   control lacks its entry or repeats it unchanged; only a changed entry
 *   for its id ends it, `reused`). Use a fresh id for a fresh pair. A malformed
 *   entry refuses the whole control, as for every other field.
 * - The stub only scripts HTTP answers: it judges no claim, notice or
 *   reaction, and keeps no reaction state of its own.
 *
 * Validation: a control that breaks any rule above is refused whole (the file
 * keeps the previous control and writes a `control-error` line; `POST
 * /_control` answers 400). The reason names the field, never a supplied
 * value. As with every control field, rewriting the file or posting a new
 * control replaces `channels` and `replies` at once, so a scenario switches
 * a conversation's kind, sharing, failure or message mid-run.
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
 * For a recorded button click, replace `event`/`envelope` with:
 *   "interactive": { "type": "block_actions", "user": { "id": "U…" },
 *     "channel": { "id": "C…" }, "message": { "ts": "<response_ts>" },
 *     "actions": [{ "type": "button", "action_id": "<posted action_id>" }] }
 * Exactly one button is allowed. Copy its `value` and the enclosing block's
 * `block_id` only when present. All fields are checked; team, app and message
 * container are generated. The button must match the last successful post or
 * update in this stub instance for the same label/channel/message timestamp.
 * Invalid interactive controls answer 400 `interactive-invalid`; a context
 * or button mismatch answers 409 `interactive-context-mismatch`. A successful
 * click sends an `interactive` Socket Mode envelope and answers with its
 * `envelope_id`. Its `push` record has `event_type: "block_actions"`, the
 * message timestamp, clicking user and redacted button fields.
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
 *   {"event":"push","label","envelope_id","connection_id","sent_mono_ms","event_ts","event_type","channel","channel_type",
 *    "flag":"false"|"true"|"non-boolean"|"absent","flag_value"}
 *   {"event":"push-refused","label","reason"}
 *   {"event":"reaction-pair","pair_id","label","channel","timestamp","name","phase",
 *    "slot", …}   (below)
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
 * b.omv SR-13.6: `sent_mono_ms` is captured immediately before WebSocket send;
 * `ws-message` carries `ack_mono_ms` captured on arrival, before parsing/I/O.
 * Both use this process's monotonic clock. `connection_id` is a generated
 * UUID independent of the ticket or credentials, shared by push and ACK.
 *
 * A `reaction-pair` line is written at each step of a pair. Every one carries
 * the entry's `pair_id`, `label`, `channel`, `timestamp` and `name` (each
 * validated; token-like text replaced, cut to at most 100 characters), and:
 *   - `"phase":"arrive"`: `slot` (1 or 2, by arrival), `held` (the pair's
 *     requests then held unanswered: 0 for slot 1, 1 for slot 2) and
 *     `arrival_mono_ms`;
 *   - `"phase":"answer"`: `slot`, `answer` (`ok` or `already_reacted`) and
 *     `answer_mono_ms`, written just before that request's `api` line;
 *   - `"phase":"fail"`: `slot` (null for `exhausted`, and for `reused`
 *     except the held slot 1 a redefinition ends), `outcome` and
 *     `answer_mono_ms`.
 * Both clocks are this process's monotonic clock. Two requests entered
 * before either answered when, for one `pair_id`, the slot 2 `arrive` line
 * (`held: 1`) precedes the slot 1 `answer` line in `seq` order. The
 * request's `api` line stays the authority for what was answered (`answer`,
 * `status`); for a pair request it also carries `pair_id` and, when it
 * took a slot, `pair_slot`. No pair line carries a token, a suffix or a
 * raw request or response.
 *
 * `api` lines also carry `channel`, `user` and `text` when the request has
 * them, and `args_token_like` (whether any argument held token-like text).
 * `conversations.replies` lines also carry, each when the request sent it,
 * `request_ts` (the request's `ts`; the line's own `ts` is its write time),
 * `oldest`, `latest`, `inclusive` and `include_all_metadata`, each the
 * wire string as received (a true flag is `"true"`), with token-like text
 * replaced and cut to at most 300 characters. A configured error's line has
 * `answer` set to its code. No line carries a returned message, its metadata
 * or blocks, or a `channels` entry; each `conversations.info` call is its own
 * line, its `channel` the requested one.
 * Posts/updates with `blocks` additionally record their redacted structured
 * display/button fields (no arbitrary fields or URLs), and successful ones
 * carry `response_ts`, the returned message timestamp used for a click.
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

/** `conversations.info` facts for one conversation; `error` fails the call instead. */
export interface StubChannelEntry {
  name?: string
  is_member?: boolean
  is_channel?: boolean
  is_private?: boolean
  is_mpim?: boolean
  is_im?: boolean
  is_ext_shared?: boolean
  error?: string
}

/** A message `conversations.replies` returns, exactly as the control gives it. */
export interface StubRepliesMessage {
  ts: string
  user?: string
  bot_id?: string
  thread_ts?: string
  metadata?: { event_type: string; event_payload?: Record<string, unknown> }
  blocks?: Record<string, unknown>[]
}

/** One exact-ts `conversations.replies` answer: a message, a Slack error, or (`{}`) no message. */
export type StubRepliesEntry = { message: StubRepliesMessage } | { error: string } | Record<string, never>

/** A `reaction_pairs` answer: one of the two `reactions.add` outcomes a pair gives. */
export type StubPairAnswer = 'ok' | 'already_reacted'

/** One controlled pair of `reactions.add` answers for an exact label, channel, timestamp and emoji. */
export interface StubReactionPair {
  id: string
  label: string
  channel: string
  timestamp: string
  name: string
  /** The answer for the first arrival, then the second's: one `ok` and one `already_reacted`. */
  answers: [StubPairAnswer, StubPairAnswer]
}

/** The whole control document. */
export interface StubControl {
  tokens?: StubTokenRule[]
  default?: StubAnswers
  users?: Record<string, { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } }>
  channels?: Record<string, StubChannelEntry>
  /** Channel ID, then the requested message `ts`. */
  replies?: Record<string, Record<string, StubRepliesEntry>>
  reaction_pairs?: StubReactionPair[]
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
  connectionId: string
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

/** Keep only Block Kit display/button evidence; never copy arbitrary fields or URLs. */
function recordedBlocks(text: string): Record<string, unknown>[] | null {
  let blocks: unknown
  try { blocks = JSON.parse(text) } catch { return null }
  if (!Array.isArray(blocks)) return null
  function evidence(value: unknown, depth: number): Record<string, unknown> | null {
    if (!isObject(value)) return null
    const out: Record<string, unknown> = {}
    for (const key of ['type', 'block_id', 'action_id', 'value', 'style'] as const) {
      if (typeof value[key] === 'string') out[key] = value[key].replace(TOKEN_LIKE_ALL, '<token>')
    }
    if (typeof value.text === 'string') out.text = recordedText('blocks', value.text)
    else if (isObject(value.text)) {
      const text: Record<string, string> = {}
      if (typeof value.text.type === 'string') text.type = value.text.type.replace(TOKEN_LIKE_ALL, '<token>')
      if (typeof value.text.text === 'string') text.text = recordedText('blocks', value.text.text)
      out.text = text
    }
    if (depth > 0 && Array.isArray(value.elements)) {
      out.elements = value.elements.slice(0, 25).map(element => evidence(element, depth - 1)).filter(element => element !== null)
    }
    return out
  }
  return blocks.slice(0, 50).map(block => evidence(block, 1)).filter(block => block !== null)
}

// ---------------------------------------------------------------------------
// Control validation
// ---------------------------------------------------------------------------

const ANSWER_KEYS = ['auth', 'connections', 'ticket', 'ws_scheme', 'user_id', 'bot_id'] as const

/** The boolean `conversations.info` facts a `channels` entry may set. */
const CHANNEL_FLAGS: readonly string[] = ['is_member', 'is_channel', 'is_private', 'is_mpim', 'is_im', 'is_ext_shared']

const USER_ID_RE = /^[UW][A-Z0-9]+$/
const BOT_ID_RE = /^B[A-Z0-9]+$/
const CHANNEL_ID_RE = /^[CDG][A-Z0-9]+$/
const SLACK_TS_RE = /^\d+\.\d{1,6}$/
/** A Slack error code (`not_in_channel`, `channel_not_found`, …): answered `ok: false`. */
const SLACK_ERROR_RE = /^[a-z][a-z0-9_]*$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `map[key]` when `map` holds `key` itself, so a request argument never reaches a prototype member. */
function ownEntry<T>(map: Record<string, T> | undefined, key: string | undefined): T | undefined {
  return map !== undefined && key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined
}

/** Validate one `replies` message; it is returned as given, so nothing is inferred. */
function checkRepliesMessage(value: unknown): StubRepliesMessage {
  const where = 'control.replies message'
  if (!isObject(value)) throw new Error(`${where} must be an object`)
  for (const [field, data] of Object.entries(value)) {
    switch (field) {
      case 'ts':
      case 'thread_ts':
        if (typeof data !== 'string' || !SLACK_TS_RE.test(data)) throw new Error(`${where}.${field} must be a Slack timestamp`)
        break
      case 'user':
        if (typeof data !== 'string' || !USER_ID_RE.test(data)) throw new Error(`${where}.user must be a user ID`)
        break
      case 'bot_id':
        if (typeof data !== 'string' || !BOT_ID_RE.test(data)) throw new Error(`${where}.bot_id must be a bot ID`)
        break
      case 'metadata':
        if (!isObject(data) || typeof data.event_type !== 'string' || data.event_type === '' ||
            Object.keys(data).some(key => key !== 'event_type' && key !== 'event_payload') ||
            (data.event_payload !== undefined && !isObject(data.event_payload))) {
          throw new Error(`${where}.metadata must be {event_type, event_payload?}`)
        }
        break
      case 'blocks':
        if (!Array.isArray(data) || data.length > 50 || !data.every(isObject)) throw new Error(`${where}.blocks must be a list of at most 50 objects`)
        break
      default:
        throw new Error(`${where} has an unknown field`)
    }
  }
  if (value.ts === undefined) throw new Error(`${where}.ts is required`)
  if (value.user === undefined && value.bot_id === undefined) throw new Error(`${where} needs user or bot_id`)
  return value as unknown as StubRepliesMessage
}

/** Validate the `replies` map: channel ID, then exact message ts, then one entry. */
function checkReplies(value: unknown): NonNullable<StubControl['replies']> {
  if (!isObject(value)) throw new Error('control.replies must be an object')
  const replies: NonNullable<StubControl['replies']> = {}
  for (const [channel, byTs] of Object.entries(value)) {
    if (!CHANNEL_ID_RE.test(channel) || !isObject(byTs)) throw new Error('control.replies entry is invalid')
    const entries: Record<string, StubRepliesEntry> = {}
    for (const [ts, entry] of Object.entries(byTs)) {
      if (!SLACK_TS_RE.test(ts)) throw new Error('control.replies key must be a Slack timestamp')
      if (!isObject(entry)) throw new Error('control.replies entry must be an object')
      if (Object.keys(entry).some(key => key !== 'message' && key !== 'error')) throw new Error('control.replies entry has an unknown field')
      if (entry.message !== undefined && entry.error !== undefined) throw new Error('control.replies entry must not hold both message and error')
      if (entry.error !== undefined) {
        if (typeof entry.error !== 'string' || !SLACK_ERROR_RE.test(entry.error)) throw new Error('control.replies error must be a Slack error code')
        entries[ts] = { error: entry.error }
      } else if (entry.message !== undefined) {
        entries[ts] = { message: checkRepliesMessage(entry.message) }
      } else {
        entries[ts] = {}
      }
    }
    replies[channel] = entries
  }
  return replies
}

/** The most `reaction_pairs` entries one control may hold. */
const REACTION_PAIRS_MAX = 32
const REACTION_PAIR_KEYS: readonly string[] = ['id', 'label', 'channel', 'timestamp', 'name', 'answers']
const PAIR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** A label as a pair names it: printable, at most 100 characters (the record's cut). */
const PAIR_LABEL_RE = /^[\x21-\x7e]{1,100}$/
/** An emoji name as `reactions.add` sends it (skin tones included). */
const EMOJI_NAME_RE = /^[a-z0-9_+'-]+(?:::[a-z0-9_+'-]+)?$/

/** Validate `reaction_pairs`: unique ids and unique label/channel/timestamp/name tuples. */
function checkReactionPairs(value: unknown): StubReactionPair[] {
  if (!Array.isArray(value)) throw new Error('control.reaction_pairs must be an array')
  if (value.length > REACTION_PAIRS_MAX) throw new Error(`control.reaction_pairs must hold at most ${REACTION_PAIRS_MAX} entries`)
  const ids = new Set<string>()
  const tuples = new Set<string>()
  return value.map((entry, i) => {
    const where = `control.reaction_pairs[${i}]`
    if (!isObject(entry)) throw new Error(`${where} must be an object`)
    if (Object.keys(entry).some(key => !REACTION_PAIR_KEYS.includes(key))) throw new Error(`${where} has an unknown field`)
    const { id, label, channel, timestamp, name, answers } = entry
    if (typeof id !== 'string' || !PAIR_ID_RE.test(id)) throw new Error(`${where}.id must be 1 to 64 letters, digits, _ or -`)
    if (typeof label !== 'string' || !PAIR_LABEL_RE.test(label)) throw new Error(`${where}.label must be 1 to 100 printable characters`)
    if (typeof channel !== 'string' || !CHANNEL_ID_RE.test(channel)) throw new Error(`${where}.channel must be a channel ID`)
    if (typeof timestamp !== 'string' || !SLACK_TS_RE.test(timestamp)) throw new Error(`${where}.timestamp must be a Slack timestamp`)
    if (typeof name !== 'string' || name.length > 100 || !EMOJI_NAME_RE.test(name)) throw new Error(`${where}.name must be an emoji name`)
    if (!Array.isArray(answers) || answers.length !== 2 || !answers.includes('ok') || !answers.includes('already_reacted')) {
      throw new Error(`${where}.answers must be ["ok","already_reacted"] or ["already_reacted","ok"]`)
    }
    if (ids.has(id)) throw new Error(`${where}.id must be unique in control.reaction_pairs`)
    const tuple = JSON.stringify([label, channel, timestamp, name])
    if (tuples.has(tuple)) throw new Error(`${where} must not share label, channel, timestamp and name with another entry`)
    ids.add(id)
    tuples.add(tuple)
    return { id, label, channel, timestamp, name, answers: [answers[0], answers[1]] as [StubPairAnswer, StubPairAnswer] }
  })
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
  for (const kind of ['users', 'channels'] as const) {
    const entries = value[kind]
    if (entries === undefined) continue
    if (!isObject(entries)) throw new Error(`control.${kind} must be an object`)
    const checked: Record<string, Record<string, unknown>> = {}
    for (const [id, metadata] of Object.entries(entries)) {
      if (!(kind === 'users' ? USER_ID_RE : CHANNEL_ID_RE).test(id) || !isObject(metadata)) throw new Error(`control.${kind} entry is invalid`)
      const entry: Record<string, unknown> = {}
      for (const [field, data] of Object.entries(metadata)) {
        if (field === 'name' || (kind === 'users' && field === 'real_name')) {
          if (typeof data !== 'string') throw new Error(`control.${kind} text must be a string`)
          entry[field] = data
        } else if (kind === 'channels' && CHANNEL_FLAGS.includes(field)) {
          if (typeof data !== 'boolean') throw new Error(`control.channels.${field} must be boolean`)
          entry[field] = data
        } else if (kind === 'channels' && field === 'error') {
          if (typeof data !== 'string' || !SLACK_ERROR_RE.test(data)) throw new Error('control.channels.error must be a Slack error code')
          entry[field] = data
        } else if (kind === 'users' && field === 'profile') {
          if (!isObject(data) || Object.keys(data).some(key => !['display_name', 'real_name'].includes(key)) || Object.values(data).some(text => typeof text !== 'string')) throw new Error('control.users.profile is invalid')
          entry.profile = { ...data }
        } else throw new Error(`control.${kind} has an unknown field`)
      }
      checked[id] = entry
    }
    if (kind === 'users') control.users = checked as StubControl['users']
    else control.channels = checked as StubControl['channels']
  }
  if (value.replies !== undefined) control.replies = checkReplies(value.replies)
  if (value.reaction_pairs !== undefined) control.reaction_pairs = checkReactionPairs(value.reaction_pairs)
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
function okBody(method: string, args: Record<string, string>, seq: number, uploadBase: string, control: StubControl): Record<string, unknown> {
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
    case 'conversations.info': {
      // A configured `error` was answered before this; only the facts overlay the defaults.
      const { error: _error, ...facts } = ownEntry(control.channels, channel) ?? {}
      return { ok: true, channel: { id: channel, name: `stub-${channel.toLowerCase()}`, is_member: true, ...facts } }
    }
    case 'conversations.history':
      return { ok: true, messages: [], has_more: false, response_metadata: { next_cursor: '' } }
    case 'conversations.replies': {
      const entry = ownEntry(ownEntry(control.replies, args.channel), args.ts)
      const messages = entry !== undefined && 'message' in entry ? [entry.message] : []
      return { ok: true, messages, has_more: false, response_metadata: { next_cursor: '' } }
    }
    case 'users.info': {
      const id = args.user ?? 'U0STUBUSER'
      const user = control.users?.[id]
      return { ok: true, user: { id, name: `stub-${id.toLowerCase()}`, ...user, profile: { display_name: `stub-${id.toLowerCase()}`, real_name: 'Stub User', ...user?.profile } } }
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
// Reaction pairs (`reaction_pairs`)
// ---------------------------------------------------------------------------

/**
 * How long a pair's first `reactions.add` is held for its second, in
 * milliseconds. Shorter than the harness's stub_session_call bound
 * (SCENARIO_STUB_CALL_S, 30 s) and the server's Web API request timeout
 * (30 s), so the held call ends with this stub's failure answer, not theirs.
 */
export const REACTION_PAIR_TIMEOUT_MS = 10_000

/** The pause between a pair's first answer and its second, in milliseconds, so they arrive in the configured order. */
export const REACTION_PAIR_ANSWER_GAP_MS = 200

/**
 * Why a pair request gets no configured answer: each answered
 * `{"ok":false,"error":"stub_pair_<outcome>"}` (the refused request itself
 * answers its token's `auth` code instead).
 */
type PairFailure = 'timeout' | 'refused' | 'reused' | 'exhausted' | 'stopped'

/** One pair id's state, kept for the stub's life whatever control is loaded. */
interface PairState {
  entry: StubReactionPair
  /** The entry's definition; the same id defined otherwise later is `reused`. */
  definition: string
  phase: 'idle' | 'pending' | 'complete' | 'failed'
  arrivals: number
  /** Releases the held first request: `paired` once the second arrives. */
  release?: (outcome: 'paired' | PairFailure) => void
  timer?: ReturnType<typeof setTimeout>
}

type PairMatch = { state: PairState } | { failure: 'reused' | 'exhausted'; entry: StubReactionPair }

function pairDefinition(entry: StubReactionPair): string {
  return JSON.stringify([entry.label, entry.channel, entry.timestamp, entry.name, entry.answers])
}

// ---------------------------------------------------------------------------
// Push control (b.deo SRI-1402)
// ---------------------------------------------------------------------------

/** The one envelope field a push may set or leave out. */
const PUSH_FLAG = 'is_ext_shared_channel'

/** The keys a push request may carry, and the keys its `envelope` may carry. */
const PUSH_KEYS: readonly string[] = ['label', 'event', 'envelope', 'interactive']
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
  | 'interactive-invalid'
  | 'interactive-context-mismatch'
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
  'interactive-invalid': 400,
  'interactive-context-mismatch': 409,
  'envelope-not-object': 400,
  'envelope-field-fixed': 400,
  'omit-invalid': 400,
  'no-open-socket': 409,
  'send-failed': 503,
}

/** The flag a push asks for: a value sent as given, or left out. */
type PushFlag = { sent: true; value: unknown } | { sent: false }

interface PushAction {
  type: 'button'
  action_id: string
  block_id?: string
  value?: string
}

interface PushInteractive {
  type: 'block_actions'
  user: { id: string }
  channel: { id: string }
  message: { ts: string }
  actions: PushAction[]
}

type ParsedPush =
  | { ok: true; label: string; event: Record<string, unknown>; flag: PushFlag }
  | { ok: true; label: string; interactive: PushInteractive }
  | { ok: false; label: string | null; reason: PushRefusalReason }

/** The interactive control accepts only button clicks; team/app/container are generated. */
function parseInteractive(value: unknown): PushInteractive | undefined {
  if (!isObject(value) || Object.keys(value).some(key => !['type', 'user', 'channel', 'message', 'actions'].includes(key))) return
  if (value.type !== 'block_actions') return
  const onlyId = (item: unknown, pattern: RegExp): item is { id: string } =>
    isObject(item) && Object.keys(item).length === 1 && typeof item.id === 'string' && pattern.test(item.id)
  if (!onlyId(value.user, /^[UW][A-Z0-9]+$/) || !onlyId(value.channel, /^[CDG][A-Z0-9]+$/)) return
  if (!isObject(value.message) || Object.keys(value.message).length !== 1 || typeof value.message.ts !== 'string' || !/^\d+\.\d{1,6}$/.test(value.message.ts)) return
  if (!Array.isArray(value.actions) || value.actions.length !== 1) return
  for (const action of value.actions) {
    if (!isObject(action) || Object.keys(action).some(key => !['type', 'action_id', 'block_id', 'value'].includes(key))) return
    if (action.type !== 'button' || typeof action.action_id !== 'string' || action.action_id.length === 0 || action.action_id.length > 255 || /[\x00-\x1f\x7f]/.test(action.action_id)) return
    if (action.block_id !== undefined && (typeof action.block_id !== 'string' || action.block_id.length === 0 || action.block_id.length > 255)) return
    if (action.value !== undefined && (typeof action.value !== 'string' || action.value.length > 2000)) return
  }
  return value as unknown as PushInteractive
}

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
  if (body.interactive !== undefined) {
    const interactive = parseInteractive(body.interactive)
    if (body.event !== undefined || body.envelope !== undefined || interactive === undefined) return { ok: false, label, reason: 'interactive-invalid' }
    return { ok: true, label, interactive }
  }
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
  // Only this stub instance's successful posts/updates authorize a click.
  const messageActions = new Map<string, PushAction[]>()
  const messageKey = (label: string, channel: string, ts: string): string => JSON.stringify([label, channel, ts])
  // Pair state by id: retained across control reloads, so a spent id stays spent.
  const pairStates = new Map<string, PairState>()
  const pairWaits = new Set<() => void>()
  let pairsStopped = false
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
    // Checked here, not at slot 2: a pending pair matches by tuple before the
    // control is read, so a held slot 1 would otherwise complete with the
    // answers its id no longer has.
    for (const entry of next.reaction_pairs ?? []) {
      const known = pairStates.get(entry.id)
      if (known?.phase === 'pending' && known.definition !== pairDefinition(entry)) settlePair(known, 'reused')
    }
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

  /** A `reaction-pair` record line: the pair's bounded, validated identity and `fields`. */
  function recordPair(entry: StubReactionPair, fields: Record<string, unknown>): void {
    record('reaction-pair', {
      pair_id: pushFieldText(entry.id), label: pushFieldText(entry.label), channel: entry.channel,
      timestamp: entry.timestamp, name: pushFieldText(entry.name), ...fields,
    })
  }

  /**
   * The pair a `reactions.add` belongs to: a pending pair with its exact
   * label, channel, timestamp and emoji first, then the control's entry.
   * Undefined when none matches, so the request is answered as ever.
   */
  function matchPair(label: string, channel: string | undefined, timestamp: string | undefined, name: string | undefined): PairMatch | undefined {
    if (channel === undefined || timestamp === undefined || name === undefined) return undefined
    const same = (entry: StubReactionPair): boolean =>
      entry.label === label && entry.channel === channel && entry.timestamp === timestamp && entry.name === name
    for (const state of pairStates.values()) {
      if (state.phase === 'pending' && same(state.entry)) return { state }
    }
    const entry = (control.reaction_pairs ?? []).find(same)
    if (entry === undefined) return undefined
    const definition = pairDefinition(entry)
    const known = pairStates.get(entry.id)
    if (known === undefined) {
      const state: PairState = { entry, definition, phase: 'idle', arrivals: 0 }
      pairStates.set(entry.id, state)
      return { state }
    }
    if (known.definition !== definition) return { failure: 'reused', entry }
    return known.phase === 'idle' ? { state: known } : { failure: 'exhausted', entry }
  }

  /** End a held first request with `outcome`; nothing when none is held. */
  function settlePair(state: PairState, outcome: 'paired' | PairFailure): void {
    const release = state.release
    if (release === undefined) return
    state.release = undefined
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = undefined
    state.phase = outcome === 'paired' ? 'complete' : 'failed'
    release(outcome)
  }

  /** Wait `ms`, or less when the stub stops; true when it stopped. */
  function pairWait(ms: number): Promise<boolean> {
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        pairWaits.delete(done)
        resolve(pairsStopped)
      }
      const timer = setTimeout(done, ms)
      pairWaits.add(done)
    })
  }

  function refusePush(label: string | null, reason: PushRefusalReason): Response {
    record('push-refused', { label: pushFieldText(label), reason })
    return Response.json({ ok: false, error: reason }, { status: PUSH_REFUSAL_STATUS[reason] })
  }

  /** `POST /_push`: one event or recorded button click over the label's newest open WebSocket. */
  function push(text: string): Response {
    const parsed = parsePush(text)
    if (!parsed.ok) return refusePush(parsed.label, parsed.reason)
    const { label } = parsed
    const interactive = 'interactive' in parsed ? parsed.interactive : undefined
    if (interactive !== undefined) {
      const posted = messageActions.get(messageKey(label, interactive.channel.id, interactive.message.ts))
      if (posted === undefined || interactive.actions.some(action => !posted.some(button =>
        button.action_id === action.action_id && button.value === action.value && button.block_id === action.block_id))) {
        return refusePush(label, 'interactive-context-mismatch')
      }
    }
    let target: Bun.ServerWebSocket<ConnData> | undefined
    for (const ws of sockets) {
      if (ws.data.label === label && ws.readyState === WS_OPEN) target = ws // insertion order: the last match was opened last
    }
    if (target === undefined) return refusePush(label, 'no-open-socket')
    if (interactive !== undefined) {
      const envelopeId = randomUUID()
      const wire = JSON.stringify({
        envelope_id: envelopeId,
        type: 'interactive',
        accepts_response_payload: false,
        payload: {
          ...interactive,
          team: { id: TEAM_ID },
          api_app_id: APP_ID,
          container: { type: 'message', channel_id: interactive.channel.id, message_ts: interactive.message.ts, is_ephemeral: false },
        },
      })
      const sentMonoMs = performance.now()
      let sendStatus: number
      try { sendStatus = target.send(wire) } catch { sendStatus = 0 }
      if (sendStatus === 0) return refusePush(label, 'send-failed')
      record('push', {
        label: pushFieldText(label), envelope_id: envelopeId,
        connection_id: target.data.connectionId, sent_mono_ms: sentMonoMs,
        event_type: 'block_actions', channel: interactive.channel.id,
        message_ts: interactive.message.ts, user: interactive.user.id,
        actions: interactive.actions.map(action => ({
          type: action.type,
          action_id: action.action_id.replace(TOKEN_LIKE_ALL, '<token>'),
          ...(action.block_id === undefined ? {} : { block_id: action.block_id.replace(TOKEN_LIKE_ALL, '<token>') }),
          ...(action.value === undefined ? {} : { value: action.value.replace(TOKEN_LIKE_ALL, '<token>') }),
        })),
      })
      return Response.json({ ok: true, envelope_id: envelopeId })
    }
    // The original events_api path and its records remain unchanged.
    if (!('event' in parsed)) return refusePush(label, 'event-not-object')
    const { event, flag } = parsed
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
    const wire = JSON.stringify(envelope)
    let sendStatus: number
    // b.omv SR-13.6 / AC75: the clock starts BEFORE the actual WebSocket
    // send, including backpressure. Both clocks belong to this stub process.
    const sentMonoMs = performance.now()
    try {
      sendStatus = target.send(wire) // -1 queued under backpressure, 0 dropped, >0 bytes sent
    } catch {
      sendStatus = 0
    }
    if (sendStatus === 0) return refusePush(label, 'send-failed')
    record('push', {
      label: pushFieldText(label),
      envelope_id: envelopeId,
      connection_id: target.data.connectionId,
      sent_mono_ms: sentMonoMs,
      event_ts: pushFieldText(event.ts),
      event_type: pushFieldText(event.type),
      channel: pushFieldText(event.channel),
      channel_type: pushFieldText(event.channel_type),
      ...pushFlagFields(flag),
    })
    return Response.json({ ok: true, envelope_id: envelopeId, event_id: eventId })
  }

  /**
   * Answer one `reactions.add` of a pair: the first is held until the
   * second arrives, then both get their configured answers in arrival order,
   * REACTION_PAIR_ANSWER_GAP_MS apart. Every other outcome is a failure
   * answer and a `fail` line, never a configured answer.
   */
  async function answerPair(
    match: PairMatch,
    auth: string,
    fields: Record<string, unknown>,
    answer: (name: string, body: Record<string, unknown> | undefined, status?: number) => Response,
    failWith: (code: string) => Response,
  ): Promise<Response> {
    if ('failure' in match) {
      fields.pair_id = pushFieldText(match.entry.id)
      recordPair(match.entry, { phase: 'fail', slot: null, outcome: match.failure, answer_mono_ms: performance.now() })
      return failWith(`stub_pair_${match.failure}`)
    }
    const { state } = match
    const { entry } = state
    const arrivalMonoMs = performance.now()
    state.arrivals += 1
    const slot = state.arrivals
    fields.pair_id = pushFieldText(entry.id)
    fields.pair_slot = slot
    recordPair(entry, { phase: 'arrive', slot, held: slot - 1, arrival_mono_ms: arrivalMonoMs })
    const fail = (outcome: PairFailure, slotOf: number | null, code = `stub_pair_${outcome}`): Response => {
      recordPair(entry, { phase: 'fail', slot: slotOf, outcome, answer_mono_ms: performance.now() })
      return failWith(code)
    }
    const configured = (of: number): Response => {
      const name = entry.answers[of - 1]
      recordPair(entry, { phase: 'answer', slot: of, answer: name, answer_mono_ms: performance.now() })
      return name === 'ok' ? answer('ok', { ok: true }) : failWith(name)
    }
    if (pairsStopped) {
      state.phase = 'failed'
      settlePair(state, 'stopped')
      return fail('stopped', slot)
    }
    if (auth !== 'ok') {
      // The token's own refusal; the pair cannot complete, so a held first request fails with it.
      state.phase = 'failed'
      settlePair(state, 'refused')
      return fail('refused', slot, auth)
    }
    if (slot === 1) {
      state.phase = 'pending'
      const outcome = await new Promise<'paired' | PairFailure>(resolve => {
        state.release = resolve
        state.timer = setTimeout(() => settlePair(state, 'timeout'), REACTION_PAIR_TIMEOUT_MS)
      })
      return outcome === 'paired' ? configured(1) : fail(outcome, 1)
    }
    settlePair(state, 'paired')
    if (await pairWait(REACTION_PAIR_ANSWER_GAP_MS)) return fail('stopped', 2)
    return configured(2)
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
        if (srv.upgrade(req, { data: { label: issued.label, ticket, connectionId: randomUUID(), hello: issued.mode !== 'no-hello' } })) return undefined
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
      if (method === 'reactions.add' || method === 'reactions.remove') {
        if (args.name !== undefined) fields.name = recordedText(method, args.name)
        if (args.timestamp !== undefined) fields.timestamp = recordedText(method, args.timestamp)
      }
      if (method === 'conversations.replies') {
        // `request_ts`, because a record line's own `ts` is its write time.
        for (const [arg, field] of [['ts', 'request_ts'], ['oldest', 'oldest'], ['latest', 'latest'], ['inclusive', 'inclusive'], ['include_all_metadata', 'include_all_metadata']] as const) {
          if (args[arg] !== undefined) fields[field] = recordedText(method, args[arg])
        }
      }
      if (args.user !== undefined) fields.user = args.user
      if (args.thread_ts !== undefined) fields.thread_ts = recordedText(method, args.thread_ts)
      if (args.text !== undefined) fields.text = recordedText(method, args.text)
      if (args.blocks !== undefined && (method === 'chat.postMessage' || method === 'chat.update')) fields.blocks = recordedBlocks(args.blocks)
      fields.args_token_like = Object.entries(args).some(([k, v]) => k !== 'token' && TOKEN_LIKE.test(v))

      const answer = (name: string, body: Record<string, unknown> | undefined, status = 200): Response => {
        if (body?.ok === true && typeof body.ts === 'string' && typeof body.channel === 'string' &&
            (method === 'chat.postMessage' || method === 'chat.update') && args.blocks !== undefined) {
          fields.response_ts = body.ts.replace(TOKEN_LIKE_ALL, '<token>')
          let blocks: unknown
          try { blocks = JSON.parse(args.blocks) } catch { blocks = undefined }
          const actions: PushAction[] = []
          if (Array.isArray(blocks)) {
            for (const block of blocks.slice(0, 50)) {
              if (!isObject(block) || block.type !== 'actions' || !Array.isArray(block.elements)) continue
              for (const element of block.elements.slice(0, 25)) {
                if (!isObject(element) || element.type !== 'button' || typeof element.action_id !== 'string') continue
                actions.push({
                  type: 'button', action_id: element.action_id,
                  ...(typeof block.block_id === 'string' ? { block_id: block.block_id } : {}),
                  ...(typeof element.value === 'string' ? { value: element.value } : {}),
                })
              }
            }
          }
          messageActions.set(messageKey(label, body.channel, body.ts), actions)
        }
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
      if (method === 'reactions.add') {
        const pair = matchPair(label, args.channel, args.timestamp, args.name)
        if (pair !== undefined) return await answerPair(pair, auth, fields, answer, failWith)
      }
      if (auth !== 'ok') return failWith(auth)

      const configuredError = method === 'conversations.info' ? ownEntry(control.channels, args.channel ?? 'C0STUBCHAN')?.error
        : method === 'conversations.replies' ? (ownEntry(ownEntry(control.replies, args.channel), args.ts) as { error?: string } | undefined)?.error
          : undefined
      if (configuredError !== undefined) return failWith(configuredError)

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
      return answer('ok', okBody(method, args, n, `http://127.0.0.1:${srv.port}/upload/`, control))
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
        // Capture arrival before parsing or synchronous record-file I/O.
        const ackMonoMs = performance.now()
        let envelopeId: unknown
        try {
          const parsed: unknown = JSON.parse(typeof message === 'string' ? message : message.toString())
          envelopeId = isObject(parsed) ? parsed.envelope_id : undefined
        } catch {
          envelopeId = undefined
        }
        record('ws-message', {
          label: ws.data.label, connection_id: ws.data.connectionId,
          envelope_id: typeof envelopeId === 'string' ? envelopeId : null,
          ack_mono_ms: ackMonoMs,
        })
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
      pairsStopped = true
      for (const state of pairStates.values()) settlePair(state, 'stopped')
      for (const done of [...pairWaits]) done()
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
