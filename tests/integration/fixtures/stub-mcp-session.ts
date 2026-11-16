/**
 * stub-mcp-session.ts — the MCP session `stub-claude.sh` holds to the bot
 * server once it has reported in (b.jg5 SRJ-1306, b.deo SRI-1403), so the
 * server registers the persona's session as it does for the real `claude`,
 * and a health tick reads the persona connected. The session records every
 * channel notification it receives and calls the tools a scenario asks for
 * (see RECORDS AND TOOL CALLS).
 *
 * REFUSAL
 * -------
 * Runs only in a cscb-ci image. Its first statement checks for the image
 * marker `/etc/cscb-ci-image`; without it, the client prints
 * `FAIL: stub-mcp-session: refused: /etc/cscb-ci-image is absent …` on
 * stderr and exits 2, before it reads an argument or loads a module. Only
 * `node:` built-ins are imported statically: the MCP SDK is imported
 * dynamically, after the check, from the installed package under test, so the
 * client speaks the package's own SDK.
 *
 * USAGE
 * -----
 *   bun stub-mcp-session.ts <mcp-config> <working-directory>
 *
 *   <mcp-config>         what `claude --mcp-config` was given: a file path
 *                        (a leading `~/` is the home directory) or inline
 *                        JSON, `{"mcpServers": {<name>: {"type": "http",
 *                        "url": …}}}`. The server named
 *                        `slack-channel-router` is used, else the first one
 *                        with a `url`.
 *   <working-directory>  the stub's working directory: the one root the
 *                        client answers the server's `roots/list` with, by
 *                        which the server matches the persona.
 *   CSCB_PKG_DIR         the installed package (default
 *                        /test-repo/node_modules/claude-slack-channel-bots)
 *
 * It connects over Streamable HTTP, as the real `claude` does for an `http`
 * server: the initialize exchange, then the standalone GET stream the server
 * waits for before it asks for the roots. It then holds the session, sending
 * a `ping` every PING_INTERVAL_MS.
 *
 * It exits, closing its connections (which ends the session on the server):
 *   - 0 on SIGTERM, SIGINT or SIGHUP (the stub's exit, or the pane's hang-up);
 *   - 0 once its parent process changes (the stub ended without signalling
 *     it, a SIGKILL for example), checked every PARENT_CHECK_MS;
 *   - 1 when the session closes or a ping fails (the server refused or ended
 *     the session), or when connecting fails;
 *   - 64 on a usage error (a missing argument, or a config naming no server
 *     URL).
 * Each exit is one line on stderr, prefixed `stub-mcp-session[<pid>]:`, as is
 * every other line the client prints.
 *
 * RECORDS AND TOOL CALLS
 * ----------------------
 * Four record files per working directory (and one optional control, see
 * CONCURRENCY), all in the directory holding the client
 * file (Bun's `import.meta.dir`, which Bun resolves through a symlink to its
 * target's directory). The stub runs the client beside itself, so for a copy
 * of the client this is the stub's directory: SCENARIO_STUB_DIR in a scenario
 * (SCENARIO_BIN in fmk mode):
 *
 *   stub-mcp-deliveries.<key>.jsonl   the delivery record (the client writes)
 *   stub-mcp-requests.<key>.jsonl     the request file (the harness writes)
 *   stub-mcp-results.<key>.jsonl      the results record (the client writes)
 *   stub-mcp-sessions.<key>.jsonl     session observations (the client writes)
 *   stub-mcp-concurrency.<key>.json   the concurrency control (optional; the
 *                                     harness writes, the client only reads)
 *
 * The key. <key> is the lowercase hexadecimal SHA-256 digest, all 64
 * characters (no truncation), of the working directory's real path: the
 * second argument resolved by realpath (the stub passes `pwd -P`, already a
 * real path; when the resolution fails, the argument as given), hashed as its
 * UTF-8 bytes with no trailing newline. In the image's shell:
 *
 *   key="$(printf '%s' "$(realpath -e -- "${dir}")" | sha256sum | cut -d ' ' -f 1)"
 *
 * Distinct directories have distinct real paths, and so distinct keys.
 *
 * Line formats. Every line is one JSON object followed by `\n`.
 *   - Delivery: `{"content":…,"meta":{…}}`, one line for every
 *     `notifications/claude/channel` notification the session receives, in
 *     the order received. `content` and `meta` are the notification's params
 *     as received: `meta` holds every attribute the server sent (`chat_id`,
 *     `message_id`, `user`, `user_id` or `bot_id`, `ts`, `via`, `thread_ts`,
 *     whichever are present). A key absent from the params is absent from the
 *     line. Other notifications are not recorded.
 *   - Tool request: `{"id":"<id>","method":"tools/call","tool":"<tool name>","arguments":{…}}`.
 *     `id` is non-empty; `tool` is 1–128 letters, digits, `_`, `-` or `.`;
 *     `arguments` is a JSON object (not an array or null).
 *   - A tool request too long for one write names its arguments instead:
 *     `"arguments_file":"stub-mcp-arguments.<key>.<id>.json"`, never with
 *     `arguments`. Only that exact name in this client's directory is read: a
 *     regular file (not a symlink) of at most ARGUMENTS_FILE_MAX_BYTES holding
 *     one JSON object, which the harness writes whole before it appends the
 *     line. Anything else makes the line invalid; no reason quotes the file.
 *   - Listing request: `{"id":"<id>","method":"tools/list"}`. No tool or
 *     arguments are accepted. Calls the negotiated client's listTools and
 *     returns its tools array as JSON in the result's text field.
 *     Other methods are refused. Request IDs are unique in a
 *     scenario: keeping them so is the harness's duty. The harness only ever
 *     appends to the request file, each line in one write.
 *   - Either request may also have `"group":"<non-empty string>"`. All
 *     requests with that group read in one poll start together, at the first
 *     member's position in file order, and are awaited together. Members
 *     later in the file move ahead of intervening requests. Groups do not
 *     span polls; append the whole group in one write to keep it together.
 *   - A two-call group may opt into session replacement by putting
 *     `"_stub_session":"stale"` in one call's arguments and
 *     `"_stub_session":"replacement"` in the other's. The fixture removes
 *     this reserved argument before callTool; all other arguments (including
 *     the caller-retained attempt_id, channel, delivery and intent) pass
 *     unchanged. Existing stub_session_group/scenario_attempt_group wrappers
 *     can carry this control without another command or helper. Exactly one
 *     of each role is required, with no other group member or lose_response.
 *     Invalid pair composition answers each member with NO TOOL RESULT and
 *     opens no session. Invalid control values are invalid request lines.
 *     Before either call, a fresh SDK client connects and answers roots/list
 *     for the same directory, retaining the original client and transport.
 *     The server decides registration/access normally; this creates no
 *     second authorized registry entry. Both calls wait at the fetch edge
 *     until both SDK submissions arrive. A missing participant aborts the
 *     barrier after SUBMISSION_BARRIER_TIMEOUT_MS, without sending either.
 *     The retained client closes after both results; later calls and pings
 *     use the replacement. Replacement connection failure exits 1.
 *   - A tool request may also have `"lose_response":true` (false or absent
 *     keeps the ordinary behaviour). Once the HTTP response headers arrive,
 *     the client cancels the unread response body and closes the transport,
 *     without handing the response to the SDK. Headers establish that the
 *     server received the call, not whether it applied it. The scenario must
 *     inspect durable state and later retry results to determine that.
 *     A transport failure before headers is an ordinary NO TOOL RESULT error,
 *     never a claimed loss. Closing also interrupts any unfinished calls in
 *     the same group; those get their own NO TOOL RESULT lines. After the
 *     group settles, a fresh client connects with the same working directory
 *     and waits for the server to accept its roots reply before any later
 *     request runs. Failure to reconnect exits 1.
 *   - Result: `{"id":"<id>","isError":<true|false>,"text":"<text>"}` for a
 *     call that returned a tool result: `isError` is the result's `isError`
 *     (`false` when absent) and `text` is the `text` of each of its `text`
 *     content items, joined with `\n` (empty when it has none). For a call
 *     that ended without a tool result, see NO TOOL RESULT.
 *   - Lost response: `{"id":"<id>","isError":true,"text":"","status":"lost","session_id":"<session>"}`.
 *     This is an answered request for the skip rule, with no tool result.
 *     It asserts no durable outcome, even when the server applied the call.
 *   - Session connected: `{"event":"connected","session_id":"<session>","reason":"start"|"lost_response"|"replacement","pid":<pid>}`,
 *     in the sessions record after each successful connection. A new client
 *     process (including after a server restart) records `start`; an in-process
 *     reconnect after a deliberately lost response records `lost_response`.
 *   - Request session: `{"event":"request","id":"<id>","session_id":"<session>","pid":<pid>}`,
 *     in the sessions record immediately before each call starts. This binds
 *     every result, including an unchanged ordinary result, to its session.
 *     These observations contain no arguments or tool results.
 *   - Replacement-pair results and request observations also carry
 *     `group`, `session_role` (`stale` or `replacement`) and `session_id`.
 *     The sessions record adds `submission_ready` for each SDK arrival;
 *     `submission_barrier` with `group` and `requests` (each id/session_id/
 *     session_role) when both are ready; and `http_start`, `http_headers`
 *     or `http_error` per request, with those same identifying fields.
 *     `http_start.in_flight` lists IDs whose fetch is awaiting headers;
 *     `http_headers.http_status` is the actual HTTP status. Every observation
 *     carries pid. `submission_aborted` carries group and an error if either
 *     SDK call fails before the barrier or the barrier times out.
 *     Barrier release proves only two pending SDK calls at one client-side
 *     boundary. Two IDs in http_start.in_flight prove overlapping client
 *     fetches, never interleaving inside the synchronous application handler.
 *     Old-session HTTP refusal is a valid observation, not a tool result or
 *     a historical-outcome disclosure. Scenarios must independently assert
 *     the actual refusal and current-session durable application/history.
 *
 * Polling. Once connected, the client reads the request file every
 * REQUEST_POLL_MS (250 ms); a missing file is no requests yet. Only complete
 * lines (ending in `\n`) are read: an incomplete last line is never run, and
 * is read again, whole, at a later poll. A complete line that is not a valid
 * request is reported once on stderr (its line number, never its text) and
 * skipped. Should the file become shorter than the part already read, it is
 * read again from its start.
 *
 * Without a group, calls run in file order, one at a time: the next starts
 * only once the previous result is written. A group starts all its calls
 * before awaiting any result, then waits for all of them before proceeding.
 * The next poll starts only once every request read in this poll is done.
 * Simultaneous callers in different personas use those personas' own files.
 * A retry is an ordinary new request ID with its original `attempt_id` and
 * `intent: "retry"` in `arguments`, passed unchanged to callTool on the current
 * session. Request IDs and logical attempt identifiers are independent.
 *
 * CONCURRENCY. A scenario may let two calls run at once for one working
 * directory by placing `{"max_in_flight":2}` in stub-mcp-concurrency.<key>.json
 * beside the client (same <key>; write a temp file, then `mv`). The client
 * reads that control at the start of every poll, so a scenario turns it on
 * or off between settled legs; no argument, environment variable or harness
 * helper changes. The control:
 *   - missing: as above (without a group, in order, one at a time);
 *   - `{"max_in_flight":1}`: the same;
 *   - `{"max_in_flight":2}`: up to two calls in flight. A poll admits, in
 *     file order, each request line while fewer than two calls are in
 *     flight, starting each call without waiting for it, and leaves the first
 *     line beyond the cap unread for a later poll. So a second request is
 *     admitted, at the same or the next poll, while the first still waits for
 *     its tool result. A request with a `group` or `lose_response` is not
 *     run in this mode: it gets a NO TOOL RESULT line at once. Each call's ID
 *     is reserved before the call starts; an
 *     ID already answered or in flight is never started again (one stderr
 *     line, and the line is skipped). Result lines are written as calls end,
 *     so they may be out of file order;
 *   - anything else (not a regular file, over 256 bytes, unreadable, not
 *     JSON, not an object, a key other than `max_in_flight`, a value other
 *     than the integer 1 or 2): no new request is admitted until the control
 *     is valid or removed; calls already in flight go on. One stderr line
 *     names the fault (never the file's text), once per fault, and one more
 *     when the control is valid again.
 * Going back to one at a time (the file removed, or 1), the client admits
 * nothing until every call in flight has its result line. Every other rule
 * here (complete lines, offsets, the skip rule, result formats, appends)
 * holds in both modes.
 *
 * The skip rule. On start, before it runs any request, the client reads the
 * results record and takes every ID with a result line there as answered. A
 * request whose ID is answered (there, or by a result line this client wrote)
 * is skipped with `request <id> has a result line; not run` on stderr.
 * A duplicate ID already scheduled in the same poll is skipped with
 * `request <id> is already scheduled; not run`, before either call starts.
 * So a client never runs one ID twice in its life, and a client started by
 * `/mcp reconnect` never repeats a call an earlier client made. A missing
 * results record answers nothing; any other failure to read it is reported
 * once on stderr, and no request runs until a later poll reads it.
 *
 * NO TOOL RESULT. A call that ends without a tool result (the request fails:
 * an error answer, the SDK's request timeout, a transport failure; or the
 * session ends while the call is in flight) gets one result line all the
 * same, so its ID is answered and no client runs it again:
 * `{"id":"<id>","isError":true,"text":"","error":"<why>"}`. When the session
 * ends, every call then in flight gets that line, once each; a call that
 * completes later writes nothing. It adds no exit code, and the client never
 * retries a request.
 *
 * Writing. The delivery, results and session records are only appended to, by
 * every client of the working directory, never truncated or rewritten. Each
 * line is written in one write to a file opened for appending, so lines from
 * two writers never interleave. A failed write is one stderr line, and the
 * session keeps running. No record exists for a working directory whose
 * client never opened a session: the client writes nothing before it
 * connects. Polling ends with the session.
 */
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'

if (!existsSync('/etc/cscb-ci-image')) {
  console.error('FAIL: stub-mcp-session: refused: /etc/cscb-ci-image is absent; this client runs only in a cscb-ci image (/ci)')
  process.exit(2)
}

/** The prefix of every line the client prints. */
const TAG = `stub-mcp-session[${process.pid}]:`

/** Exit status for a usage error (EX_USAGE). */
const USAGE_EXIT = 64

/** The MCP server name CSCB's install writes into slack-mcp.json (src/config.ts MCP_SERVER_NAME). */
const SERVER_NAME = 'slack-channel-router'

/**
 * The client name and version the initialize exchange reports. The server
 * only logs them; the version is the stub's own, never a Claude Code version
 * (the Claude Code minimum is written only in tests/test-helpers).
 */
const CLIENT_INFO = { name: 'stub-claude', version: '0.0.0-stub' } as const

/** How often the session is pinged, in milliseconds. */
const PING_INTERVAL_MS = 5_000

/** How often the parent process is checked, in milliseconds. */
const PARENT_CHECK_MS = 250

/** How often the request file is read, in milliseconds. */
const REQUEST_POLL_MS = 250

/** Bound for the server to accept the roots reply that identifies this session. */
const ROOTS_READY_TIMEOUT_MS = 10_000

/** Bound for both real SDK calls to reach a replacement pair's fetch edge. */
const SUBMISSION_BARRIER_TIMEOUT_MS = 10_000

/** The installed package under test. */
const PKG_DIR = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'

/** The directory the record files live in: the one holding this file (the stub's). */
const CLIENT_DIR = import.meta.dir

/** The record file names: `<prefix><key>.jsonl` (see the header). */
const DELIVERIES_PREFIX = 'stub-mcp-deliveries.'
const REQUESTS_PREFIX = 'stub-mcp-requests.'
const RESULTS_PREFIX = 'stub-mcp-results.'
const SESSIONS_PREFIX = 'stub-mcp-sessions.'
const RECORD_SUFFIX = '.jsonl'

/** The concurrency control: `stub-mcp-concurrency.<key>.json` (see CONCURRENCY in the header). */
const CONCURRENCY_PREFIX = 'stub-mcp-concurrency.'
const CONCURRENCY_SUFFIX = '.json'

/** The most calls the concurrency control may let run at once. */
const MAX_IN_FLIGHT_LIMIT = 2

/** The largest concurrency control read, in bytes. */
const CONCURRENCY_CONTROL_MAX_BYTES = 256

/** A request's arguments file: `<prefix><key>.<id><suffix>` (see the header). */
const ARGUMENTS_PREFIX = 'stub-mcp-arguments.'
const ARGUMENTS_SUFFIX = '.json'

/** The largest arguments file read, in bytes (scenario.sh SCENARIO_STUB_ARGUMENTS_MAX_BYTES). */
const ARGUMENTS_FILE_MAX_BYTES = 65_536

/** The notification the server delivers a channel message by (src/persona-routing.ts). */
const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel'

/** The byte that ends a line. */
const NEWLINE = 0x0a

function say(line: string): void {
  console.error(`${TAG} ${line}`)
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/** The parent PID from /proc (field 4 of /proc/self/stat), read afresh each time. */
function parentPid(): number {
  const stat = readFileSync('/proc/self/stat', 'utf-8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return Number(fields[1])
}

/** The URL of the bot server the MCP config names; undefined when it names none. */
function serverUrl(configArg: string): string | undefined {
  const text = configArg.trimStart().startsWith('{')
    ? configArg
    : readFileSync(configArg.startsWith('~/') ? join(homedir(), configArg.slice(2)) : configArg, 'utf-8')
  const servers = (JSON.parse(text) as { mcpServers?: Record<string, { url?: unknown }> }).mcpServers ?? {}
  const named = servers[SERVER_NAME]
  if (named !== undefined && typeof named.url === 'string') return named.url
  for (const entry of Object.values(servers)) {
    if (typeof entry?.url === 'string') return entry.url
  }
  return undefined
}

async function importSdk(subpath: string): Promise<Record<string, any>> {
  return await import(Bun.resolveSync(`@modelcontextprotocol/sdk/${subpath}`, join(PKG_DIR, 'src')))
}

/**
 * The file key of a working directory (see the header): the lowercase hex
 * SHA-256 of its real path's UTF-8 bytes, no trailing newline; the path as
 * given when it does not resolve.
 */
function fileKey(cwd: string): string {
  let real: string
  try {
    real = realpathSync(cwd)
  } catch {
    real = cwd
  }
  return createHash('sha256').update(real, 'utf8').digest('hex')
}

function recordPath(prefix: string, key: string): string {
  return join(CLIENT_DIR, `${prefix}${key}${RECORD_SUFFIX}`)
}

/**
 * Append `record` to `path` as one JSON line, in one write to the file
 * opened for appending. A failure is one stderr line; the session keeps
 * running.
 */
function appendLine(path: string, record: unknown): void {
  let fd: number | undefined
  try {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
    fd = openSync(path, 'a')
    const written = writeSync(fd, bytes)
    if (written !== bytes.length) throw new Error(`wrote ${written} of ${bytes.length} bytes`)
  } catch (err) {
    say(`could not append a line to ${path}: ${describe(err)}`)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The line is written or reported; a failed close changes neither.
      }
    }
  }
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
}

/**
 * The IDs with a result line in the results record at `path`: an empty set
 * when the file is missing; undefined when it could not be read. Every line
 * holding a JSON object with a string `id` counts, an unterminated last line
 * included, so a result is never missed.
 */
function readAnsweredIds(path: string): Set<string> | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return new Set()
    return undefined
  }
  const ids = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string') {
        ids.add((value as { id: string }).id)
      }
    } catch {
      // A line that is not JSON names no ID.
    }
  }
  return ids
}

/**
 * How many calls the concurrency control at `path` lets run at once: 1 (in
 * order, one at a time) when the file is missing; otherwise its
 * `max_in_flight`, or why the control is not valid. A reason names a field
 * or a fault, never the file's text.
 */
function readConcurrency(path: string): { max: number } | { invalid: string } {
  let text: string
  try {
    const st = lstatSync(path)
    if (!st.isFile()) return { invalid: 'not a regular file' }
    if (st.size > CONCURRENCY_CONTROL_MAX_BYTES) return { invalid: `larger than ${CONCURRENCY_CONTROL_MAX_BYTES} bytes` }
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { max: 1 }
    return { invalid: 'unreadable' }
  }
  if (Buffer.byteLength(text, 'utf8') > CONCURRENCY_CONTROL_MAX_BYTES) return { invalid: `larger than ${CONCURRENCY_CONTROL_MAX_BYTES} bytes` }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { invalid: 'not JSON' }
  }
  if (!isPlainObject(value)) return { invalid: 'not a JSON object' }
  if (Object.keys(value).some((field) => field !== 'max_in_flight')) return { invalid: 'a key other than "max_in_flight"' }
  const max = value['max_in_flight']
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAX_IN_FLIGHT_LIMIT) {
    return { invalid: `"max_in_flight" is not an integer from 1 to ${MAX_IN_FLIGHT_LIMIT}` }
  }
  return { max }
}

/** One request from the request file (see the header). */
type StubRequest =
  | { id: string; method: 'tools/list'; group?: string }
  | { id: string; method: 'tools/call'; tool: string; arguments: Record<string, unknown>; group?: string; lose_response?: boolean; session_role?: 'stale' | 'replacement' }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The arguments a request's `arguments_file` names, or why it names none. */
type ArgumentsFileReader = (id: string, name: string) => { arguments: unknown } | { invalid: string }

/**
 * Read only `<ARGUMENTS_PREFIX><key>.<id><ARGUMENTS_SUFFIX>` in `dir`: a
 * regular file, never followed through a symlink, of at most
 * ARGUMENTS_FILE_MAX_BYTES, parsed as JSON. Reasons never quote the file.
 */
function argumentsFileReader(dir: string, key: string): ArgumentsFileReader {
  return (id, name) => {
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(id) || name !== `${ARGUMENTS_PREFIX}${key}.${id}${ARGUMENTS_SUFFIX}`) {
      return { invalid: '"arguments_file" is not this request\'s arguments file' }
    }
    const path = join(dir, name)
    let bytes: Buffer
    try {
      const stat = lstatSync(path)
      if (!stat.isFile()) return { invalid: 'the arguments file is not a regular file' }
      if (stat.size > ARGUMENTS_FILE_MAX_BYTES) return { invalid: 'the arguments file is too large' }
      bytes = readFileSync(path)
    } catch {
      return { invalid: 'the arguments file could not be read' }
    }
    if (bytes.length > ARGUMENTS_FILE_MAX_BYTES) return { invalid: 'the arguments file is too large' }
    try {
      return { arguments: JSON.parse(bytes.toString('utf8')) }
    } catch {
      return { invalid: 'the arguments file is not JSON' }
    }
  }
}

/** The request a complete line holds, or why it holds none. */
function parseRequest(line: string, readArguments?: ArgumentsFileReader): StubRequest | { invalid: string } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { invalid: 'not JSON' }
  }
  if (!isPlainObject(value)) return { invalid: 'not a JSON object' }
  const { id, method, tool, group, lose_response } = value
  let args = value['arguments']
  if (typeof id !== 'string' || id === '') return { invalid: '"id" is not a non-empty string' }
  if ('group' in value && (typeof group !== 'string' || group === '')) return { invalid: '"group" is not a non-empty string' }
  if ('lose_response' in value && typeof lose_response !== 'boolean') return { invalid: '"lose_response" is not a boolean' }
  const grouping = typeof group === 'string' ? { group } : {}
  if (method === 'tools/list') {
    if ('tool' in value || 'arguments' in value || 'arguments_file' in value) return { invalid: 'tools/list takes no tool or arguments' }
    if ('lose_response' in value) return { invalid: 'tools/list takes no lose_response' }
    return { id, method, ...grouping }
  }
  if (method !== 'tools/call') return { invalid: 'unsupported method' }
  if (typeof tool !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool)) return { invalid: '"tool" is not a tool name' }
  if ('arguments_file' in value) {
    if ('arguments' in value) return { invalid: 'a request takes "arguments" or "arguments_file", not both' }
    const file = value['arguments_file']
    if (typeof file !== 'string' || readArguments === undefined) return { invalid: '"arguments_file" is not an arguments file' }
    const read = readArguments(id, file)
    if ('invalid' in read) return read
    args = read.arguments
  }
  if (!isPlainObject(args)) return { invalid: '"arguments" is not a JSON object' }
  const { _stub_session: sessionRole, ...toolArgs } = args
  if ('_stub_session' in args && sessionRole !== 'stale' && sessionRole !== 'replacement') {
    return { invalid: '"_stub_session" is not stale or replacement' }
  }
  return { id, method, tool, arguments: toolArgs, ...grouping,
    ...(sessionRole === 'stale' || sessionRole === 'replacement' ? { session_role: sessionRole } : {}),
    ...(typeof lose_response === 'boolean' ? { lose_response } : {}) }
}

/** The text of a tool result: its `text` content items' texts, joined with `\n`. */
function resultText(result: unknown): string {
  const content = isPlainObject(result) ? result['content'] : undefined
  if (!Array.isArray(content)) return ''
  return content
    .filter((item): item is { type: 'text'; text: string } => isPlainObject(item) && item['type'] === 'text' && typeof item['text'] === 'string')
    .map((item) => item.text)
    .join('\n')
}

async function main(argv: readonly string[]): Promise<number> {
  const [configArg, cwd] = argv
  if (configArg === undefined || configArg === '' || cwd === undefined || cwd === '') {
    say('usage: bun stub-mcp-session.ts <mcp-config> <working-directory>')
    return USAGE_EXIT
  }
  let url: string | undefined
  try {
    url = serverUrl(configArg)
  } catch (err) {
    say(`could not read the MCP config ${configArg}: ${describe(err)}`)
    return USAGE_EXIT
  }
  if (url === undefined) {
    say(`the MCP config ${configArg} names no server URL`)
    return USAGE_EXIT
  }

  const key = fileKey(cwd)
  const deliveriesPath = recordPath(DELIVERIES_PREFIX, key)
  const requestsPath = recordPath(REQUESTS_PREFIX, key)
  const resultsPath = recordPath(RESULTS_PREFIX, key)
  const sessionsPath = recordPath(SESSIONS_PREFIX, key)
  const concurrencyPath = join(CLIENT_DIR, `${CONCURRENCY_PREFIX}${key}${CONCURRENCY_SUFFIX}`)
  const readArguments = argumentsFileReader(CLIENT_DIR, key)

  const { Client } = await importSdk('client/index.js')
  const { StreamableHTTPClientTransport } = await importSdk('client/streamableHttp.js')
  const { ListRootsRequestSchema } = await importSdk('types.js')

  const parent = parentPid()
  let client: InstanceType<typeof Client>
  let transport: InstanceType<typeof StreamableHTTPClientTransport>
  // The SDK may await before sending. Keep each call's loss control bound to
  // that call, even when other calls start before its fetch does.
  type PairBinding = { group: string; session_id: string; session_role: 'stale' | 'replacement' }
  type SubmissionBarrier = { arrive: (id: string) => Promise<void>; abort: (why: string) => void; dispose: () => void }
  const requestContext = new AsyncLocalStorage<{ request: StubRequest; barrier?: SubmissionBarrier }>()
  const pairBindings = new Map<string, PairBinding>()
  const httpInFlight = new Set<string>()
  let reconnecting = false
  let closingForLoss: InstanceType<typeof Client> | undefined

  // The tool calls' state: the answered IDs (undefined until the results
  // record is read), the requests in flight, and the request file's read part.
  let answered: Set<string> | undefined
  let resultsReadReported = false
  const inFlight = new Set<string>()
  let concurrencyReported: string | undefined
  let polling = true
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let readOffset = 0
  let lineNumber = 0
  let requestsReadReported = false

  /** Append the result line for `id`, unless `id` is already answered. */
  const answer = (id: string, line: Record<string, unknown>): void => {
    if (answered === undefined || answered.has(id)) return
    answered.add(id)
    appendLine(resultsPath, { id, ...line, ...pairBindings.get(id) })
  }

  let settle: (code: number) => void = () => {}
  const ended = new Promise<number>((resolve) => { settle = resolve })
  const end = (code: number, why: string): void => {
    if (!polling) return
    say(why)
    polling = false
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    for (const id of inFlight) answer(id, { isError: true, text: '', error: `the session ended during the call: ${why}` })
    settle(code)
  }

  /** A fresh negotiated session, used initially and after a lost response. */
  const connect = async (reason: 'start' | 'lost_response' | 'replacement'): Promise<void> => {
    let rootsRequestId: string | number | undefined
    let finishRoots: (error?: Error) => void = () => {}
    const rootsReady = new Promise<Error | undefined>((resolve) => { finishRoots = resolve })
    const sessionClient = new Client({ ...CLIENT_INFO }, { capabilities: { roots: { listChanged: false } } })
    const sessionTransport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const context = requestContext.getStore()
        const request = context?.request
        const message = init?.method === 'POST' && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
        const binding = request && message?.method === 'tools/call' ? pairBindings.get(request.id) : undefined
        const observe = (event: string, fields: Record<string, unknown> = {}): void => {
          if (binding) appendLine(sessionsPath, { event, id: request!.id, ...binding, ...fields, pid: process.pid })
        }
        if (binding) {
          await context!.barrier!.arrive(request!.id)
          if (!polling) throw new Error('client ended before paired submission')
          httpInFlight.add(request!.id)
          observe('http_start', { in_flight: [...httpInFlight] })
        }
        let response: Response
        try {
          response = await fetch(input, init)
          observe('http_headers', { http_status: response.status })
        } catch (err) {
          observe('http_error')
          throw err
        } finally {
          if (binding) httpInFlight.delete(request!.id)
        }
        if (rootsRequestId !== undefined && message?.id === rootsRequestId && 'result' in message) {
          finishRoots(response.ok ? undefined : new Error('server refused the roots reply'))
        }
        if (request?.method !== 'tools/call' || !request.lose_response ||
            message?.method !== 'tools/call' ||
            !polling || !inFlight.has(request.id) || client !== sessionClient) return response

        // Never give these bytes to the SDK. In particular, do not read a
        // result and subsequently label it lost: the server's durable outcome
        // remains unknown to this caller. Other in-flight calls may fail too.
        reconnecting = true
        closingForLoss = sessionClient
        try {
          await response.body?.cancel()
        } finally {
          const closing = sessionClient.close()
          answer(request.id, { isError: true, text: '', status: 'lost', session_id: sessionTransport.sessionId })
          await closing
        }
        throw new Error('response deliberately lost')
      },
    })
    sessionClient.setRequestHandler(ListRootsRequestSchema, async (_request: unknown, extra: { requestId: string | number }) => {
      rootsRequestId = extra.requestId
      return { roots: [{ uri: pathToFileURL(cwd).href, name: cwd }] }
    })
    sessionClient.fallbackNotificationHandler = async (notification: { method: string; params?: Record<string, unknown> }) => {
      if (notification.method !== CHANNEL_NOTIFICATION_METHOD) return
      const params = notification.params ?? {}
      appendLine(deliveriesPath, { content: params['content'], meta: params['meta'] })
    }
    sessionClient.onclose = () => {
      finishRoots(new Error('session closed before its roots reply was accepted'))
      if (client === sessionClient && closingForLoss !== sessionClient) end(1, 'the session closed')
    }
    client = sessionClient
    transport = sessionTransport
    await client.connect(transport)
    // initialize alone does not register the persona. The next request may
    // already be in this poll, so wait for the actual roots exchange, not a
    // guessed delay or a retry of a tool that could have side effects.
    const rootsTimer = setTimeout(() => finishRoots(new Error('timed out waiting for the roots reply')), ROOTS_READY_TIMEOUT_MS)
    try {
      const failure = await Promise.race([rootsReady, ended.then(() => new Error('client ended during connection'))])
      if (failure) throw failure
    } finally {
      clearTimeout(rootsTimer)
    }
    if (!polling) return
    if (typeof transport.sessionId !== 'string' || transport.sessionId === '') throw new Error('connected without a session ID')
    appendLine(sessionsPath, { event: 'connected', session_id: transport.sessionId, reason, pid: process.pid })
    say(`connected to ${url} as ${cwd} (session ${transport.sessionId}, parent ${parent})`)
  }

  /** Call one request over the session and append its result line. */
  const call = async (request: StubRequest, sessionClient = client): Promise<void> => {
    let line: Record<string, unknown>
    try {
      if (request.method === 'tools/list') {
        const listing = await sessionClient.listTools()
        answer(request.id, { isError: false, text: JSON.stringify(listing.tools) })
        return
      }
      // Arguments, including retained attempt_id and intent, pass through
      // unchanged. The durable request file is the caller's pre-submit copy.
      const result: unknown = await sessionClient.callTool({ name: request.tool, arguments: request.arguments })
      line = { isError: isPlainObject(result) && result['isError'] === true, text: resultText(result) }
    } catch (err) {
      line = { isError: true, text: '', error: describe(err) }
    }
    answer(request.id, line)
  }

  /** Hold real SDK POSTs before fetch, without reading or changing server state. */
  const submissionBarrier = (batch: StubRequest[]): SubmissionBarrier => {
    const group = batch[0]!.group!
    const ready = new Set<string>()
    let released = false
    let finish: (error?: Error) => void = () => {}
    const gate = new Promise<Error | undefined>((resolve) => { finish = resolve })
    const abort = (why: string): void => {
      if (released) return
      released = true
      clearTimeout(timer)
      appendLine(sessionsPath, { event: 'submission_aborted', group, error: why, pid: process.pid })
      finish(new Error(why))
    }
    const timer = setTimeout(() => abort('paired SDK submission timed out'), SUBMISSION_BARRIER_TIMEOUT_MS)
    return {
      arrive: async (id) => {
        if (!released) {
          ready.add(id)
          appendLine(sessionsPath, { event: 'submission_ready', id, ...pairBindings.get(id), pid: process.pid })
          if (ready.size === batch.length) {
            released = true
            clearTimeout(timer)
            appendLine(sessionsPath, { event: 'submission_barrier', group,
              requests: batch.map(({ id }) => ({ id, ...pairBindings.get(id) })), pid: process.pid })
            finish()
          }
        }
        const failure = await gate
        if (failure) throw failure
      },
      abort,
      dispose: () => clearTimeout(timer),
    }
  }

  const runRequest = async (request: StubRequest, sessionClient = client, sessionTransport = transport,
    barrier?: SubmissionBarrier): Promise<void> => {
    inFlight.add(request.id)
    appendLine(sessionsPath, { event: 'request', id: request.id, session_id: sessionTransport.sessionId,
      ...pairBindings.get(request.id), pid: process.pid })
    try {
      await requestContext.run({ request, barrier }, () => call(request, sessionClient))
    } finally {
      barrier?.abort('a paired SDK call ended before both submissions were ready')
      inFlight.delete(request.id)
    }
  }

  /** Retain the real old client while its replacement registers the same roots. */
  const runReplacementPair = async (batch: StubRequest[]): Promise<void> => {
    if (batch.length !== 2 || batch.some(r => r.method !== 'tools/call' || r.lose_response || r.group === undefined) ||
        batch.filter(r => r.method === 'tools/call' && r.session_role === 'stale').length !== 1 ||
        batch.filter(r => r.method === 'tools/call' && r.session_role === 'replacement').length !== 1) {
      for (const request of batch) answer(request.id, { isError: true, text: '', error: 'session replacement needs one stale and one replacement call in the same group, without response loss' })
      return
    }
    const staleClient = client, staleTransport = transport
    let barrier: SubmissionBarrier | undefined
    try {
      reconnecting = true
      await connect('replacement')
      reconnecting = false
      if (!polling) return
      for (const request of batch) {
        const role = (request as Extract<StubRequest, { method: 'tools/call' }>).session_role!
        pairBindings.set(request.id, { group: request.group!, session_role: role,
          session_id: role === 'stale' ? staleTransport.sessionId : transport.sessionId })
      }
      barrier = submissionBarrier(batch)
      await Promise.all(batch.map(request => pairBindings.get(request.id)!.session_role === 'stale'
        ? runRequest(request, staleClient, staleTransport, barrier)
        : runRequest(request, client, transport, barrier)))
    } catch (err) {
      for (const request of batch) answer(request.id, { isError: true, text: '', error: describe(err) })
      end(1, `could not replace the session at ${url}: ${describe(err)}`)
    } finally {
      barrier?.dispose()
      for (const request of batch) pairBindings.delete(request.id)
      await staleClient.close()
    }
  }

  /** One poll: the results record until read, then the concurrency control, then every complete request line not yet read that it admits. */
  const poll = async (): Promise<void> => {
    if (answered === undefined) {
      answered = readAnsweredIds(resultsPath)
      if (answered === undefined) {
        if (!resultsReadReported) say(`could not read the results record ${resultsPath}; no request runs until it is read`)
        resultsReadReported = true
        return
      }
    }
    const admission = readConcurrency(concurrencyPath)
    if ('invalid' in admission) {
      if (concurrencyReported !== admission.invalid) {
        say(`the concurrency control ${concurrencyPath} is not valid (${admission.invalid}); no new request runs until it is valid or removed`)
      }
      concurrencyReported = admission.invalid
      return
    }
    if (concurrencyReported !== undefined) say(`the concurrency control ${concurrencyPath} is valid again`)
    concurrencyReported = undefined
    const max = admission.max
    // In order, one at a time, starts only once every call an earlier poll left in flight is done.
    if (max === 1 && inFlight.size > 0) return
    let bytes: Buffer
    try {
      bytes = readFileSync(requestsPath)
      requestsReadReported = false
    } catch (err) {
      if (errorCode(err) !== 'ENOENT' && !requestsReadReported) {
        say(`could not read the request file ${requestsPath}: ${describe(err)}`)
        requestsReadReported = true
      }
      return
    }
    if (bytes.length < readOffset) {
      say(`the request file ${requestsPath} is shorter than the part already read; reading it from its start`)
      readOffset = 0
      lineNumber = 0
    }
    if (max > 1) { admitConcurrently(bytes, max, answered); return }
    const batches: StubRequest[][] = []
    const groups = new Map<string, StubRequest[]>()
    const scheduled = new Set<string>()
    while (polling) {
      const lineEnd = bytes.indexOf(NEWLINE, readOffset)
      if (lineEnd === -1) break
      const text = bytes.subarray(readOffset, lineEnd).toString('utf8')
      readOffset = lineEnd + 1
      lineNumber += 1
      const request = parseRequest(text, readArguments)
      if ('invalid' in request) {
        say(`line ${lineNumber} of the request file ${requestsPath} is not a valid request (${request.invalid}); skipped`)
        continue
      }
      if (answered.has(request.id)) {
        say(`request ${request.id} has a result line; not run`)
        continue
      }
      if (scheduled.has(request.id)) {
        say(`request ${request.id} is already scheduled; not run`)
        continue
      }
      scheduled.add(request.id)
      let batch = request.group === undefined ? undefined : groups.get(request.group)
      if (batch === undefined) {
        batch = []
        batches.push(batch)
        if (request.group !== undefined) groups.set(request.group, batch)
      }
      batch.push(request)
    }
    for (const batch of batches) {
      if (!polling) break
      if (batch.some(request => request.method === 'tools/call' && request.session_role !== undefined)) {
        await runReplacementPair(batch)
      } else {
        await Promise.all(batch.map(request => runRequest(request)))
      }
      if (reconnecting && polling) {
        try {
          await connect('lost_response')
          reconnecting = false
        } catch (err) {
          end(1, `could not reconnect to ${url}: ${describe(err)}`)
        }
      }
    }
  }

  /**
   * The concurrency control's mode (`max_in_flight` above 1): admit, in file
   * order, each request line while fewer than `max` calls are in flight,
   * starting each without waiting for it; the first line beyond the cap
   * stays unread for a later poll.
   */
  const admitConcurrently = (bytes: Buffer, max: number, done: Set<string>): void => {
    while (polling) {
      const lineEnd = bytes.indexOf(NEWLINE, readOffset)
      if (lineEnd === -1) return
      const text = bytes.subarray(readOffset, lineEnd).toString('utf8')
      const request = parseRequest(text, readArguments)
      // A request that would run beyond the cap stays unread, for a later poll.
      if (!('invalid' in request) && !done.has(request.id) && !inFlight.has(request.id) && inFlight.size >= max) return
      readOffset = lineEnd + 1
      lineNumber += 1
      if ('invalid' in request) {
        say(`line ${lineNumber} of the request file ${requestsPath} is not a valid request (${request.invalid}); skipped`)
        continue
      }
      if (done.has(request.id)) {
        say(`request ${request.id} has a result line; not run`)
        continue
      }
      if (inFlight.has(request.id)) {
        say(`request ${request.id} is in flight; not run again`)
        continue
      }
      if (request.group !== undefined || (request.method === 'tools/call' && request.lose_response === true)) {
        answer(request.id, { isError: true, text: '', error: 'a group or lose_response request runs only one at a time (concurrency control missing or 1)' })
        continue
      }
      void runRequest(request).catch((err: unknown) => say(`request ${request.id} failed: ${describe(err)}`))
    }
  }

  const schedulePoll = (): void => {
    if (!polling) return
    pollTimer = setTimeout(() => {
      poll()
        .catch((err: unknown) => say(`request poll failed: ${describe(err)}`))
        .finally(schedulePoll)
    }, REQUEST_POLL_MS)
  }

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => end(0, `${signal}: ending the session`))
  }
  const parentCheck = setInterval(() => {
    let now: number
    try {
      now = parentPid()
    } catch {
      now = -1
    }
    if (now !== parent) end(0, `parent ${parent} is gone (parent now ${now}): ending the session`)
  }, PARENT_CHECK_MS)

  try {
    await connect('start')
  } catch (err) {
    clearInterval(parentCheck)
    say(`could not connect to ${url}: ${describe(err)}`)
    return 1
  }
  const pinger = setInterval(() => {
    if (!polling || reconnecting) return
    const pingClient = client
    pingClient.ping().catch((err: unknown) => {
      if (client === pingClient && !reconnecting) end(1, `ping failed: ${describe(err)}`)
    })
  }, PING_INTERVAL_MS)

  // The first poll reads the results record before it runs any request.
  schedulePoll()

  const code = await ended
  clearInterval(pinger)
  clearInterval(parentCheck)
  polling = false
  if (pollTimer !== undefined) clearTimeout(pollTimer)
  return code
}

// Exit at once: the process's end closes every connection it holds.
process.exit(await main(process.argv.slice(2)))
