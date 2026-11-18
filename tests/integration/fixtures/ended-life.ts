/** Harness-only exit barrier. Reads tmux metadata, never an agent's screen. */
import { existsSync, readFileSync } from 'node:fs'

export interface EndedLife {
  tmux_session_name: string
  tmux_socket: string | null
  pid: number
}
interface Probes {
  tmux(socket: string | null, args: string[]): { status: number; stdout: string }
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
    return { status: result.exitCode, stdout: result.stdout.toString().trim() }
  },
  pidAlive(pid) {
    try {
      // Like scenario.sh pid_alive: kill -0 alone also sees unreaped zombies.
      process.kill(pid, 0)
      return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) ([A-Za-z]).*$/, '$1').trim() !== 'Z'
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
      throw error
    }
  },
  now: () => Date.now(),
  sleep: ms => Bun.sleep(ms),
}
export function sessionPresent(life: EndedLife, probes: Probes = nativeProbes): boolean {
  const result = probes.tmux(life.tmux_socket, ['has-session', '-t', `=${life.tmux_session_name}`])
  if (result.status !== 0 && result.status !== 1) throw new Error('old life tmux query failed')
  return result.status === 0
}
export function captureLiveLife(row: { tmux_session_name: string; tmux_socket?: string | null },
  probes: Probes = nativeProbes): EndedLife {
  if (!row.tmux_session_name) throw new Error('old life has no recorded tmux session')
  const life = { tmux_session_name: row.tmux_session_name, tmux_socket: row.tmux_socket ?? null, pid: 0 }
  if (!sessionPresent(life, probes)) throw new Error('old life session is not live before exit')
  const pane = probes.tmux(life.tmux_socket,
    ['display-message', '-p', '-t', `=${life.tmux_session_name}:`, '#{pane_pid}'])
  if (pane.status !== 0 || !/^[1-9][0-9]*$/.test(pane.stdout)) throw new Error('old life pane pid unavailable')
  life.pid = Number(pane.stdout)
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
