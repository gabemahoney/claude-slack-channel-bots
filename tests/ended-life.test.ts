import { expect, test } from 'bun:test'
import { captureLiveLife, waitForLifeExit } from './integration/fixtures/ended-life.ts'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

function fixture() {
  let now = 0
  const calls: { socket: string | null; args: string[] }[] = []
  const state = { sessionGoneAt: 300, processGoneAt: 500, status: undefined as number | undefined, pid: '123' }
  const probes = {
    now: () => now,
    sleep: async (ms: number) => { now += ms },
    pidAlive: (pid: number) => { expect(pid).toBe(123); return now < state.processGoneAt },
    tmux: (socket: string | null, args: string[]) => {
      calls.push({ socket, args })
      return args[0] === 'display-message' ? { status: 0, stdout: state.pid }
        : { status: state.status ?? (now < state.sessionGoneAt ? 0 : 1), stdout: '' }
    },
  }
  const row = { tmux_session_name: 'exact-session', tmux_socket: '/scratch/recorded-socket' }
  return { state, probes, calls, row }
}

test('exit barrier binds the live session and pane to the recorded socket, then waits for both to exit', async () => {
  const f = fixture()
  const life = captureLiveLife(f.row, f.probes)
  expect(f.calls).toEqual([
    { socket: f.row.tmux_socket, args: ['has-session', '-t', '=exact-session'] },
    { socket: f.row.tmux_socket, args: ['display-message', '-p', '-t', '=exact-session:', '#{pane_pid}'] },
  ])
  await waitForLifeExit(life, f.probes)
  expect(f.probes.now()).toBe(500) // Session gone alone at 300 is insufficient.
  expect(f.calls.every(call => call.socket === f.row.tmux_socket)).toBe(true)
})

test('a dead process alone cannot pass the barrier; the final deadline observation can', async () => {
  const f = fixture(), life = captureLiveLife(f.row, f.probes)
  f.state.processGoneAt = 100
  f.state.sessionGoneAt = 10000
  await waitForLifeExit(life, f.probes)
  expect(f.probes.now()).toBe(10000)
})

test.each(['session', 'process'])('a held %s fails explicitly without a resume attempt', async held => {
  const f = fixture(), life = captureLiveLife(f.row, f.probes)
  if (held === 'session') f.state.sessionGoneAt = Infinity
  else f.state.processGoneAt = Infinity
  await expect(waitForLifeExit(life, f.probes)).rejects.toThrow('old life never exited')
  expect(f.probes.now()).toBe(10000)
})

test('positive controls reject an absent session, malformed pid or dead pane before the sentinel', () => {
  const f = fixture()
  f.state.sessionGoneAt = 0
  expect(() => captureLiveLife(f.row, f.probes)).toThrow('session is not live')
  f.state.sessionGoneAt = 300
  f.state.pid = '0'
  expect(() => captureLiveLife(f.row, f.probes)).toThrow('pane pid unavailable')
  f.state.pid = '123'; f.state.processGoneAt = 0
  expect(() => captureLiveLife(f.row, f.probes)).toThrow('process is not live')
})

test('no recorded socket uses the caller socket, and unexpected tmux errors fail closed', async () => {
  const f = fixture(), life = captureLiveLife({ tmux_session_name: 'exact-session' }, f.probes)
  expect(f.calls.every(call => call.socket === null)).toBe(true)
  f.state.status = 70
  await expect(waitForLifeExit(life, f.probes)).rejects.toThrow('tmux query failed')
  expect(f.probes.now()).toBe(0)
})

// Only these declarations run: no integration entry, AD, native tmux or pid probe.
const shellSource = readFileSync(join(import.meta.dir, 'integration/test-24-fmk-stuck-launch.sh'), 'utf8')
function shellControl(mode: string, action = 'poll', recordedSocket = true) {
  const root = mkdtempSync('/tmp/ended-life-shell-')
  const declarations = ['worker_tmux_query', 'end_worker', 'ended_worker_gone'].map(name =>
    shellSource.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? '').join('\n')
  try {
    writeFileSync(join(root, 'fake-tmux'), `#!/bin/bash
root="\${0%/*}"
printf '<%s>' "$@" >> "$root/args"
printf '\\n' >> "$root/args"
if [[ "$1" == -S ]]; then shift 2; fi
query="$1"
if [[ "$MODE" == before-timeout && ! -e "$root/poll" && "$query" == has-session ]]; then exit 124; fi
if [[ "$MODE" == pane-timeout && "$query" == display-message ]]; then exit 124; fi
if [[ -e "$root/poll" && "$query" == has-session ]]; then
    case "$MODE" in
        unexpected-*) exit "\${MODE#unexpected-}" ;;
        hang) while (( SECONDS < 5 )); do :; done ;;
        present) exit 0 ;;
        *) exit 1 ;;
    esac
fi
[[ "$query" != display-message ]] || printf '123\\n'
`, { mode: 0o755 })
    const script = `set -euo pipefail
root="$1"
SCENARIO_REAL_TMUX="$root/fake-tmux"
SENTINEL=fixture-exit ENDED_WAIT_S=20 GONE_WAIT_S=10
${declarations}
fail() { printf 'FAIL: %s\\n' "$1" >&2; exit 70; }
poll_row_of() { ROW_SESSION=exact-session; ROW_SOCKET=${recordedSocket ? "'/scratch/recorded socket'" : "''"}; }
pid_alive() { [[ "$1" == 123 && ! -e "$root/dead" ]]; }
row_of_reads() { : > "$root/poll"; [[ "$MODE" == process-live ]] || : > "$root/dead"; }
wait_until() { shift 2; "$@"; }
if [[ "$2" == end ]]; then end_worker fixture-id fixture-step
else
    : > "$root/poll"
    [[ "$MODE" == process-live ]] || : > "$root/dead"
    ended_worker_gone exact-session 123 ${recordedSocket ? "-S '/scratch/recorded socket'" : ''}
fi
`
    const result = spawnSync('bash', ['-c', script, 'ended-life-control', root, action], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'timeout'], extras: { MODE: mode } }),
      encoding: 'utf8', timeout: 6000,
    })
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull()
    return { status: result.status, stderr: result.stderr, args: readFileSync(join(root, 'args'), 'utf8') }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test.each([70, 124, 127, 137])('shell barrier rejects unexpected query status %s instead of declaring gone', status => {
  const result = shellControl(`unexpected-${status}`)
  expect(result.status).toBe(70)
  expect(result.stderr).toContain(status === 124 || status === 137 ? 'tmux query timed out' : 'tmux query failed')
})

test('shell barrier bounds a hanging query with the actual three-second subprocess timeout', () => {
  const started = Date.now(), result = shellControl('hang')
  expect(result.status).toBe(70)
  expect(result.stderr).toContain('tmux query timed out')
  expect(Date.now() - started).toBeGreaterThanOrEqual(2800)
}, 8000)

test.each(['before-timeout', 'pane-timeout'])('shell positive control fails explicitly on %s before sentinel', mode => {
  const result = shellControl(mode, 'end')
  expect(result.status).toBe(70)
  expect(result.stderr).toContain('tmux query timed out')
  expect(result.args).not.toContain('<send-keys>')
})

test.each([true, false])('shell end waits for session and process exit with recorded socket=%s', socket => {
  const result = shellControl('gone', 'end', socket)
  expect(result.status).toBe(0)
  const prefix = socket ? '<-S></scratch/recorded socket>' : ''
  expect(result.args.trim().split('\n')).toEqual([
    prefix + '<has-session><-t><=exact-session>',
    prefix + '<display-message><-p><-t><=exact-session:><#{pane_pid}>',
    prefix + '<send-keys><-t><=exact-session:><fixture-exit><Enter>',
    prefix + '<has-session><-t><=exact-session>',
  ])
})

test.each(['present', 'process-live'])('shell barrier keeps waiting while %s', mode => {
  const result = shellControl(mode)
  expect(result.status).toBe(1)
  expect(result.stderr).toBe('')
})
