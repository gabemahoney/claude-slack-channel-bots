/** Harness-only exit barrier. Reads tmux metadata, never an agent's screen. */
import { existsSync, readFileSync } from 'node:fs'

export interface EndedLife {
  tmux_session_name: string
  tmux_session_id: string
  tmux_socket: string | null
  pid: number
}
interface Probes {
  tmux(socket: string | null, args: string[]): { status: number; stdout: string; noServer?: boolean }
  pidAlive(pid: number): boolean
  now(): number
  sleep(ms: number): Promise<unknown>
}
const nativeProbes: Probes = {
  tmux(socket, args) {
    if (!existsSync('/etc/cscb-ci-image')) throw new Error('CI image required')
    const result = Bun.spawnSync(['tmux', ...(socket ? ['-S', socket] : []), ...args],
      { stdout: 'pipe', stderr: 'pipe', timeout: 3000 })
    if (result.exitedDueToTimeout || result.signalCode) throw new Error('old life tmux query failed')
    return { status: result.exitCode, stdout: result.stdout.toString().trim(),
      noServer: result.exitCode === 1 && result.stderr.byteLength <= 4096 && tmuxNoServer(result.stderr.toString(), socket) }
  },
  pidAlive,
  now: () => Date.now(),
  sleep: ms => Bun.sleep(ms),
}
/** tmux 3.2a client.c connection diagnostics; return only bounded facts, never stderr. */
export function tmuxNoServer(stderr: string, socket: string | null): boolean {
  if (Buffer.byteLength(stderr) > 4096) return false
  const line = stderr.endsWith('\n') ? stderr.slice(0, -1) : stderr
  if (/[\r\n]/.test(line)) return false
  if (socket !== null) return line === `no server running on ${socket}` ||
    line === `error connecting to ${socket} (No such file or directory)`
  return /^no server running on \/[^\r\n]+$/.test(line) ||
    /^error connecting to \/[^\r\n]+ \(No such file or directory\)$/.test(line)
}
export function pidAlive(pid: number): boolean {
  try {
    // Like scenario.sh pid_alive: kill -0 alone also sees unreaped zombies.
    process.kill(pid, 0)
    return processState(readFileSync(`/proc/${pid}/stat`, 'utf8')) !== 'Z'
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}
export function processState(stat: string): string {
  // comm can contain spaces and ') '; only the LAST delimiter ends it.
  const delimiter = stat.lastIndexOf(') ')
  const state = delimiter < 0 ? undefined : /^([A-Za-z])(?:\s|$)/.exec(stat.slice(delimiter + 2))?.[1]
  if (!state) throw new Error('old life process state unavailable')
  return state
}
export function sessionPresent(life: EndedLife, probes: Probes = nativeProbes): boolean {
  const result = probes.tmux(life.tmux_socket, ['list-sessions', '-F', '#{session_id}'])
  if (result.status !== 0 && result.status !== 1) throw new Error('old life tmux query failed')
  if (result.status === 1) {
    if (result.noServer === true) return false
    throw new Error('old life tmux query failed')
  }
  const ids = result.stdout.split('\n').filter(Boolean)
  if (ids.some(id => !/^\$[0-9]+$/.test(id))) throw new Error('old life tmux session identities unavailable')
  return ids.includes(life.tmux_session_id)
}
export function captureLiveLife(row: { tmux_session_name: string; tmux_socket?: string | null },
  probes: Probes = nativeProbes): EndedLife {
  if (!row.tmux_session_name) throw new Error('old life has no recorded tmux session')
  const pane = probes.tmux(row.tmux_socket ?? null,
    ['display-message', '-p', '-t', `=${row.tmux_session_name}:`, '#{session_id} #{pane_pid}'])
  const identity = pane.status === 0 ? /^(\$[0-9]+) ([1-9][0-9]*)$/.exec(pane.stdout) : null
  if (!identity) throw new Error('old life pane identity unavailable')
  const life = { tmux_session_name: row.tmux_session_name, tmux_session_id: identity[1],
    tmux_socket: row.tmux_socket ?? null, pid: Number(identity[2]) }
  if (!sessionPresent(life, probes)) throw new Error('old life session is not live before exit')
  if (!Number.isSafeInteger(life.pid) || !probes.pidAlive(life.pid)) throw new Error('old life process is not live before exit')
  return life
}
export async function waitForLifeExit(life: EndedLife, probes: Probes = nativeProbes): Promise<void> {
  const deadline = probes.now() + 10000
  for (;;) {
    if (!sessionPresent(life, probes) && !probes.pidAlive(life.pid)) return
    if (probes.now() >= deadline) throw new Error('old life never exited')
    await probes.sleep(100)
  }
}
