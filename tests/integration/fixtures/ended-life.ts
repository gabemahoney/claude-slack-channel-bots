/** Harness-only exit barrier. Reads tmux metadata, never an agent's screen. */
import { existsSync, readFileSync } from 'node:fs'

export interface EndedLife {
  tmux_session_name: string
  tmux_session_id: string
  tmux_socket: string | null
  pid: number
}
export interface TmuxResult { status: number; stdout: string; noServer?: boolean; diagnostic?: string }
interface Probes {
  tmux(socket: string | null, args: string[]): TmuxResult
  pidAlive(pid: number): boolean
  now(): number
  sleep(ms: number): Promise<unknown>
}
/** A barrier failure. `facts` holds fixed labels and numbers only, never tmux stderr. */
export class ExitBarrierError extends Error {
  readonly facts: Record<string, string | number>
  constructor(facts: Record<string, string | number>, message: string) {
    super(message)
    this.name = 'ExitBarrierError'
    this.facts = facts
  }
}
export const TMUX_QUERY_TIMEOUT_MS = 3000
const EXIT_DEADLINE_MS = 10000
const EXIT_POLL_MS = 100
/** One bounded tmux client query; stderr is reduced to its tmuxDiagnostic label. */
export function runTmux(socket: string | null, args: string[], env?: Record<string, string>): TmuxResult {
  const result = Bun.spawnSync(['tmux', ...(socket ? ['-S', socket] : []), ...args],
    { stdout: 'pipe', stderr: 'pipe', timeout: TMUX_QUERY_TIMEOUT_MS, ...(env ? { env } : {}) })
  if (result.exitedDueToTimeout) throw new ExitBarrierError({ barrier: 'tmux-timeout', query: args[0] },
    `old life tmux query failed: ${args[0]} timed out after ${TMUX_QUERY_TIMEOUT_MS} ms`)
  if (result.signalCode || result.exitCode === null) throw new ExitBarrierError({ barrier: 'tmux-signal', query: args[0] },
    `old life tmux query failed: ${args[0]} ended by signal ${result.signalCode ?? 'unknown'}`)
  const stderr = result.stderr.toString()
  return { status: result.exitCode, stdout: result.stdout.toString().trim(),
    noServer: result.exitCode === 1 && tmuxNoServer(stderr, socket), diagnostic: tmuxDiagnostic(stderr, socket) }
}
const nativeProbes: Probes = {
  tmux(socket, args) {
    if (!existsSync('/etc/cscb-ci-image')) throw new Error('CI image required')
    return runTmux(socket, args)
  },
  pidAlive,
  now: () => Date.now(),
  sleep: ms => Bun.sleep(ms),
}
/**
 * A fixed label for a tmux 3.2a client's stderr (client.c client_main and
 * client_exit_message), so a failure names it without printing it. The socket
 * must be the queried one; another path gets a -foreign-socket suffix.
 */
export function tmuxDiagnostic(stderr: string, socket: string | null): string {
  if (stderr === '') return 'no-stderr'
  if (Buffer.byteLength(stderr) > 4096) return 'oversized-stderr'
  const line = stderr.endsWith('\n') ? stderr.slice(0, -1) : stderr
  if (/[\r\n]/.test(line)) return 'multi-line-stderr'
  const fixed: Record<string, string> = {
    'server exited unexpectedly': 'server-exited-unexpectedly',
    'failed to send command': 'send-failed',
    'command too long': 'command-too-long',
    'server version is too old for client': 'server-too-old',
  }
  if (fixed[line]) return fixed[line]
  if (/^protocol version mismatch \(client [0-9]+, server [0-9]+\)$/.test(line)) return 'protocol-version-mismatch'
  const connect = /^(?:no server running on (.+)|error connecting to (.+) \(([^()]+)\))$/.exec(line)
  if (!connect) return 'unrecognised-stderr'
  const path = connect[1] ?? connect[2]
  const errno = connect[3]?.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const label = connect[1] !== undefined ? 'no-server'
    : errno === 'no-such-file-or-directory' ? 'missing-socket' : `connect-error:${errno?.slice(0, 24)}`
  // An empty socket runs tmux's default one, as runTmux does.
  const ours = socket ? path === socket : path.startsWith('/') && path.length > 1
  return ours ? label : `${label}-foreign-socket`
}
/**
 * Every outcome tmux 3.2a's client gives when the queried server is gone, each
 * exit 1: no socket file (connect ENOENT); a stale socket file, which the
 * server leaves when it exits (ECONNREFUSED); and a connection the server
 * closed unanswered while exiting (server.c server_accept with server_exit set,
 * or exit with the connection queued: "server exited unexpectedly"). A
 * shutdown notice instead exits 0 with no session list and no stderr. Anything
 * else is not proof of absence, including an exit 0 with stderr (3.2a's
 * "server version is too old for client" exits 0).
 */
export function tmuxNoServer(stderr: string, socket: string | null): boolean {
  return ['no-server', 'missing-socket', 'server-exited-unexpectedly'].includes(tmuxDiagnostic(stderr, socket))
}
export function pidAlive(pid: number): boolean {
  try {
    // Like scenario.sh pid_alive: kill -0 alone also sees unreaped zombies.
    process.kill(pid, 0)
    return processState(readFileSync(`/proc/${pid}/stat`, 'utf8')) !== 'Z'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (['ENOENT', 'ESRCH'].includes(code)) return false
    if (error instanceof ExitBarrierError || !/^E[A-Z0-9]{1,20}$/.test(code)) throw error
    throw new ExitBarrierError({ barrier: 'pid-probe', errno: code.toLowerCase() }, `old life process probe failed: ${code}`)
  }
}
export function processState(stat: string): string {
  // comm can contain spaces and ') '; only the LAST delimiter ends it.
  const delimiter = stat.lastIndexOf(') ')
  const state = delimiter < 0 ? undefined : /^([A-Za-z])(?:\s|$)/.exec(stat.slice(delimiter + 2))?.[1]
  if (!state) throw new ExitBarrierError({ barrier: 'process-state-unavailable' }, 'old life process state unavailable')
  return state
}
/** A status-0 answer counts only with no stderr (an injected probe may omit the label). */
function quiet(result: TmuxResult): boolean {
  return result.diagnostic === undefined || result.diagnostic === 'no-stderr'
}
export function sessionPresent(life: EndedLife, probes: Probes = nativeProbes): boolean {
  const result = probes.tmux(life.tmux_socket, ['list-sessions', '-F', '#{session_id}'])
  if (result.status === 1 && result.noServer === true) return false
  if (result.status !== 0 || !quiet(result)) {
    const diagnostic = result.diagnostic ?? 'unknown'
    throw new ExitBarrierError({ barrier: 'tmux-query', query: 'list-sessions', status: result.status, tmux: diagnostic },
      `old life tmux query failed: list-sessions exit ${result.status} (${diagnostic})`)
  }
  const ids = result.stdout.split('\n').filter(Boolean)
  if (ids.some(id => !/^\$[0-9]+$/.test(id))) throw new ExitBarrierError({ barrier: 'tmux-session-ids' },
    'old life tmux session identities unavailable')
  return ids.includes(life.tmux_session_id)
}
export function captureLiveLife(row: { tmux_session_name: string; tmux_socket?: string | null },
  probes: Probes = nativeProbes): EndedLife {
  if (!row.tmux_session_name) throw new ExitBarrierError({ barrier: 'capture-no-session' }, 'old life has no recorded tmux session')
  const pane = probes.tmux(row.tmux_socket ?? null,
    ['display-message', '-p', '-t', `=${row.tmux_session_name}:`, '#{session_id} #{pane_pid}'])
  const identity = pane.status === 0 && quiet(pane) ? /^(\$[0-9]+) ([1-9][0-9]*)$/.exec(pane.stdout) : null
  if (!identity) {
    const diagnostic = pane.diagnostic ?? 'unknown'
    throw new ExitBarrierError({ barrier: 'capture-pane', status: pane.status, tmux: diagnostic },
      `old life pane identity unavailable: display-message exit ${pane.status} (${diagnostic})`)
  }
  const life = { tmux_session_name: row.tmux_session_name, tmux_session_id: identity[1],
    tmux_socket: row.tmux_socket ?? null, pid: Number(identity[2]) }
  if (!sessionPresent(life, probes)) throw new ExitBarrierError({ barrier: 'capture-session' }, 'old life session is not live before exit')
  if (!Number.isSafeInteger(life.pid) || !probes.pidAlive(life.pid)) throw new ExitBarrierError({ barrier: 'capture-process' },
    'old life process is not live before exit')
  return life
}
export async function waitForLifeExit(life: EndedLife, probes: Probes = nativeProbes): Promise<void> {
  const deadline = probes.now() + EXIT_DEADLINE_MS
  for (;;) {
    const present = sessionPresent(life, probes)
    const alive = probes.pidAlive(life.pid)
    if (!present && !alive) return
    if (probes.now() >= deadline) throw new ExitBarrierError(
      { barrier: 'deadline', session: present ? 'present' : 'gone', process: alive ? 'alive' : 'dead' },
      `old life never exited within ${EXIT_DEADLINE_MS} ms (session ${present ? 'present' : 'gone'}, process ${alive ? 'alive' : 'dead'})`)
    await probes.sleep(EXIT_POLL_MS)
  }
}
