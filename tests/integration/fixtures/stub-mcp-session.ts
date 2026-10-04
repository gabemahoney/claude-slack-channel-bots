/**
 * stub-mcp-session.ts — the MCP session `stub-claude.sh` holds to the bot
 * server once it has reported in (b.jg5 SRJ-1306), so the server registers
 * the persona's session as it does for the real `claude`, and a health tick
 * reads the persona connected.
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
 * Each exit is one line on stderr, prefixed `stub-mcp-session[<pid>]:`.
 */
import { existsSync, readFileSync } from 'node:fs'
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

/** The installed package under test. */
const PKG_DIR = process.env['CSCB_PKG_DIR'] ?? '/test-repo/node_modules/claude-slack-channel-bots'

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

  const { Client } = await importSdk('client/index.js')
  const { StreamableHTTPClientTransport } = await importSdk('client/streamableHttp.js')
  const { ListRootsRequestSchema } = await importSdk('types.js')

  const parent = parentPid()
  const client = new Client({ ...CLIENT_INFO },{ capabilities: { roots: { listChanged: false } } })
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(cwd).href, name: cwd }],
  }))
  const transport = new StreamableHTTPClientTransport(new URL(url))

  let settle: (code: number) => void = () => {}
  const ended = new Promise<number>((resolve) => { settle = resolve })
  const end = (code: number, why: string): void => {
    say(why)
    settle(code)
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

  const code = await ended
  clearInterval(pinger)
  clearInterval(parentCheck)
  return code
}

// Exit at once: the process's end closes every connection it holds.
process.exit(await main(process.argv.slice(2)))
