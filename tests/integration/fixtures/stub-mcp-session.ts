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
 * Three files per working directory, all in the directory holding the client
 * file (Bun's `import.meta.dir`, which Bun resolves through a symlink to its
 * target's directory). The stub runs the client beside itself, so for a copy
 * of the client this is the stub's directory: SCENARIO_STUB_DIR in a scenario
 * (SCENARIO_BIN in fmk mode):
 *
 *   stub-mcp-deliveries.<key>.jsonl   the delivery record (the client writes)
 *   stub-mcp-requests.<key>.jsonl     the request file (the harness writes)
 *   stub-mcp-results.<key>.jsonl      the results record (the client writes)
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
 *   - Request: `{"id":"<id>","tool":"<tool name>","arguments":{…}}`. `id` and
 *     `tool` are non-empty strings and `arguments` is a JSON object (not an
 *     array, not null); other keys are ignored. Request IDs are unique in a
 *     scenario: keeping them so is the harness's duty. The harness only ever
 *     appends to the request file, each line in one write.
 *   - Result: `{"id":"<id>","isError":<true|false>,"text":"<text>"}` for a
 *     call that returned a tool result: `isError` is the result's `isError`
 *     (`false` when absent) and `text` is the `text` of each of its `text`
 *     content items, joined with `\n` (empty when it has none). For a call
 *     that ended without a tool result, see NO TOOL RESULT.
 *
 * Polling. Once connected, the client reads the request file every
 * REQUEST_POLL_MS (250 ms); a missing file is no requests yet. Only complete
 * lines (ending in `\n`) are read: an incomplete last line is never run, and
 * is read again, whole, at a later poll. A complete line that is not a valid
 * request is reported once on stderr (its line number, never its text) and
 * skipped. Should the file become shorter than the part already read, it is
 * read again from its start.
 *
 * In order, one at a time. The client calls each request over its session,
 * whatever tool it names, in file order, one at a time: the next call starts
 * only once the result line of the one before is written, and the next poll
 * starts only once every request read in this poll is done.
 *
 * The skip rule. On start, before it runs any request, the client reads the
 * results record and takes every ID with a result line there as answered. A
 * request whose ID is answered (there, or by a result line this client wrote)
 * is not run: one stderr line, and it is skipped. So a client never runs one
 * ID twice in its life, and a client started by `/mcp reconnect` never
 * repeats a call an earlier client made. A missing results record answers
 * nothing; any other failure to read it is reported once on stderr, and no
 * request runs until a later poll reads it.
 *
 * NO TOOL RESULT. A call that ends without a tool result (the request fails:
 * an error answer, the SDK's request timeout, a transport failure; or the
 * session ends while the call is in flight) gets one result line all the
 * same, so its ID is answered and no client runs it again:
 * `{"id":"<id>","isError":true,"text":"","error":"<why>"}`. It adds no exit
 * code, and the client never retries a request.
 *
 * Writing. The delivery and results records are only ever appended to, by
 * every client of the working directory, never truncated or rewritten. Each
 * line is written in one write to a file opened for appending, so lines from
 * two writers never interleave. A failed write is one stderr line, and the
 * session keeps running. No record exists for a working directory whose
 * client never opened a session: the client writes nothing before it
 * connects. Polling ends with the session.
 */
import { closeSync, existsSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

/** The installed package under test. */
const PKG_DIR = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'

/** The directory the three record files live in: the one holding this file (the stub's). */
const CLIENT_DIR = import.meta.dir

/** The record file names: `<prefix><key>.jsonl` (see the header). */
const DELIVERIES_PREFIX = 'stub-mcp-deliveries.'
const REQUESTS_PREFIX = 'stub-mcp-requests.'
const RESULTS_PREFIX = 'stub-mcp-results.'
const RECORD_SUFFIX = '.jsonl'

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

/** One request from the request file (see the header). */
interface StubRequest {
  id: string
  tool: string
  arguments: Record<string, unknown>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The request a complete line holds, or why it holds none. */
function parseRequest(line: string): StubRequest | { invalid: string } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { invalid: 'not JSON' }
  }
  if (!isPlainObject(value)) return { invalid: 'not a JSON object' }
  const { id, tool, arguments: args } = value
  if (typeof id !== 'string' || id === '') return { invalid: '"id" is not a non-empty string' }
  if (typeof tool !== 'string' || tool === '') return { invalid: '"tool" is not a non-empty string' }
  if (!isPlainObject(args)) return { invalid: '"arguments" is not a JSON object' }
  return { id, tool, arguments: args }
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

  const { Client } = await importSdk('client/index.js')
  const { StreamableHTTPClientTransport } = await importSdk('client/streamableHttp.js')
  const { ListRootsRequestSchema } = await importSdk('types.js')

  const parent = parentPid()
  const client = new Client({ ...CLIENT_INFO },{ capabilities: { roots: { listChanged: false } } })
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(cwd).href, name: cwd }],
  }))
  // The delivery record: every channel notification, as received.
  client.fallbackNotificationHandler = async (notification: { method: string; params?: Record<string, unknown> }) => {
    if (notification.method !== CHANNEL_NOTIFICATION_METHOD) return
    const params = notification.params ?? {}
    appendLine(deliveriesPath, { content: params['content'], meta: params['meta'] })
  }
  const transport = new StreamableHTTPClientTransport(new URL(url))

  // The tool calls' state: the answered IDs (undefined until the results
  // record is read), the request in flight, and the request file's read part.
  let answered: Set<string> | undefined
  let resultsReadReported = false
  let inFlight: string | undefined
  let polling = true
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let readOffset = 0
  let lineNumber = 0
  let requestsReadReported = false

  /** Append the result line for `id`, unless `id` is already answered. */
  const answer = (id: string, line: Record<string, unknown>): void => {
    if (answered === undefined || answered.has(id)) return
    answered.add(id)
    appendLine(resultsPath, { id, ...line })
  }

  let settle: (code: number) => void = () => {}
  const ended = new Promise<number>((resolve) => { settle = resolve })
  const end = (code: number, why: string): void => {
    say(why)
    polling = false
    if (pollTimer !== undefined) clearTimeout(pollTimer)
    if (inFlight !== undefined) answer(inFlight, { isError: true, text: '', error: `the session ended during the call: ${why}` })
    settle(code)
  }

  /** Call one request over the session and append its result line. */
  const call = async (request: StubRequest): Promise<void> => {
    inFlight = request.id
    let line: Record<string, unknown>
    try {
      const result: unknown = await client.callTool({ name: request.tool, arguments: request.arguments })
      line = { isError: isPlainObject(result) && result['isError'] === true, text: resultText(result) }
    } catch (err) {
      line = { isError: true, text: '', error: describe(err) }
    }
    inFlight = undefined
    answer(request.id, line)
  }

  /** One poll: the results record until read, then every complete request line not yet read. */
  const poll = async (): Promise<void> => {
    if (answered === undefined) {
      answered = readAnsweredIds(resultsPath)
      if (answered === undefined) {
        if (!resultsReadReported) say(`could not read the results record ${resultsPath}; no request runs until it is read`)
        resultsReadReported = true
        return
      }
    }
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
    while (polling) {
      const lineEnd = bytes.indexOf(NEWLINE, readOffset)
      if (lineEnd === -1) return
      const text = bytes.subarray(readOffset, lineEnd).toString('utf8')
      readOffset = lineEnd + 1
      lineNumber += 1
      const request = parseRequest(text)
      if ('invalid' in request) {
        say(`line ${lineNumber} of the request file ${requestsPath} is not a valid request (${request.invalid}); skipped`)
        continue
      }
      if (answered.has(request.id)) {
        say(`request ${request.id} has a result line; not run`)
        continue
      }
      await call(request)
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

  client.onclose = () => end(1, 'the session closed')

  try {
    await client.connect(transport)
  } catch (err) {
    clearInterval(parentCheck)
    say(`could not connect to ${url}: ${describe(err)}`)
    return 1
  }
  say(`connected to ${url} as ${cwd} (session ${String(transport.sessionId)}, parent ${parent})`)

  const pinger = setInterval(() => {
    client.ping().catch((err: unknown) => end(1, `ping failed: ${describe(err)}`))
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
