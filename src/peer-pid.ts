import { homedir } from 'os'
import { join } from 'path'
import { readFile } from 'fs/promises'

// ---------------------------------------------------------------------------
// getPeerPidByPort
// ---------------------------------------------------------------------------

/**
 * Discover the PID of a process that has an established TCP connection
 * from serverPort to peerPort on the loopback interface (IPv4 or IPv6).
 *
 * Runs: ss -tnp
 * Filters for lines where local addr is 127.0.0.1:<serverPort> or ::1:<serverPort>
 * and peer addr is 127.0.0.1:<peerPort> or ::1:<peerPort>.
 *
 * Returns the PID as a number, or null if not found or on any error.
 */
export async function getPeerPidByPort(
  peerPort: number,
  serverPort: number,
): Promise<number | null> {
  try {
    const proc = Bun.spawn(['ss', '-tnp'], { stdout: 'pipe', stderr: 'pipe' })
    const text = await new Response(proc.stdout).text()

    for (const line of text.split('\n')) {
      if (!matchesPorts(line, peerPort, serverPort)) continue
      const pid = parsePid(line)
      if (pid !== null) return pid
    }
    return null
  } catch (err) {
    console.error('[slack] peer-pid: getPeerPidByPort failed', err)
    return null
  }
}

/** Returns true if the ss output line is the peer (client) side of the loopback pair.
 *
 * Each loopback connection appears twice in `ss -tnp` — once owned by the
 * server (local=serverPort, peer=peerPort) and once by the client process
 * (local=peerPort, peer=serverPort). We want the client side so the PID is
 * the connecting process, not our own server. Match positionally on the
 * Local-Address and Peer-Address columns.
 */
function matchesPorts(line: string, peerPort: number, serverPort: number): boolean {
  // ss -tnp columns: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port [users:(...)]
  const tokens = line.trim().split(/\s+/)
  if (tokens.length < 5) return false
  const localAddr = tokens[3]
  const peerAddr = tokens[4]
  if (localAddr === undefined || peerAddr === undefined) return false
  const loopback = '(?:127\\.0\\.0\\.1|\\[?::1\\]?)'
  const localRe = new RegExp(`^${loopback}:${peerPort}$`)
  const peerRe = new RegExp(`^${loopback}:${serverPort}$`)
  return localRe.test(localAddr) && peerRe.test(peerAddr)
}

/**
 * Parse PID from ss users field, e.g.:
 *   users:(("bun",pid=12345,fd=7))
 * Returns the PID as a number, or null if unparseable.
 */
function parsePid(line: string): number | null {
  const m = line.match(/pid=(\d+)/)
  if (!m) return null
  const pid = parseInt(m[1], 10)
  return isNaN(pid) ? null : pid
}

// ---------------------------------------------------------------------------
// getSessionIdForPid
// ---------------------------------------------------------------------------

/**
 * Read the Claude Code session ID stored at <claudeConfigDir>/sessions/<pid>.json.
 * Returns the sessionId string, or null if the file is missing, unreadable,
 * or does not contain a valid sessionId string field.
 *
 * `claudeConfigDir` defaults to `~/.claude` (Claude Code's default). When the
 * managed session was launched with `CLAUDE_CONFIG_DIR=/some/path`, callers
 * must pass that path so the lookup hits the right directory.
 *
 * Never throws.
 */
export async function getSessionIdForPid(
  pid: number,
  claudeConfigDir?: string,
): Promise<string | null> {
  try {
    const baseDir = claudeConfigDir ?? join(homedir(), '.claude')
    const filePath = join(baseDir, 'sessions', `${pid}.json`)
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.sessionId === 'string') return parsed.sessionId
    return null
  } catch (err) {
    console.error('[slack] peer-pid: getSessionIdForPid failed', err)
    return null
  }
}
