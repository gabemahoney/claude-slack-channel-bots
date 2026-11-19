import { expect, test } from 'bun:test'
import { captureLiveLife, waitForLifeExit, pidAlive, processState, sessionPresent, tmuxNoServer, tmuxDiagnostic, runTmux,
  ExitBarrierError, TMUX_QUERY_TIMEOUT_MS } from './integration/fixtures/ended-life.ts'
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

const procMatchesPid = readlinkSync('/proc/self') === String(process.pid)
const nativeSkipReason = procMatchesPid ? '' : ' [skip: /proc/self does not match process.pid]'
// 3 s zombie observation bound plus 5 s for process startup and cleanup.
const NATIVE_ZOMBIE_TEST_TIMEOUT_MS = 8000
// The query control measured about 3 s; allow 5 s for startup/cleanup and load.
const SHELL_HANG_TEST_TIMEOUT_MS = 8000
test.skipIf(!procMatchesPid)('native pidAlive distinguishes a real unreaped zombie from its live parent' + nativeSkipReason, async () => {
  const root = mkdtempSync('/tmp/ended-life-zombie-')
  // This parent never waits for its forked child, so scheduling cannot let a
  // shell reap the child before exec. No tmux, AD or CI image is needed.
  const parent = spawn('python3', ['-I', '-c', 'import os, time\nif os.fork() == 0: os._exit(0)\ntime.sleep(30)'], {
    env: hostSafeChildEnv(root, { tools: ['python3'] }), stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  parent.stderr.on('data', bytes => { stderr += bytes.toString() })
  const exited = once(parent, 'exit')
  try {
    await once(parent, 'spawn')
    expect(pidAlive(parent.pid!), `native parent failed: ${stderr}`).toBe(true)
    const deadline = Date.now() + 3000
    let zombie: number | undefined
    do {
      const children = readFileSync(`/proc/${parent.pid}/task/${parent.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)
      for (const child of children) {
        const stat = readFileSync(`/proc/${child}/stat`, 'utf8')
        // Independent literal observation, not the parser under test.
        if (stat.slice(stat.lastIndexOf(') ') + 2).startsWith('Z ')) zombie = Number(child)
      }
      if (zombie) break
      await Bun.sleep(20)
    } while (Date.now() < deadline)
    expect(zombie).toBeDefined()
    expect(pidAlive(zombie!)).toBe(false)
    expect(pidAlive(parent.pid!)).toBe(true)
  } finally {
    parent.kill('SIGKILL')
    try { await exited }
    finally { rmSync(root, { recursive: true, force: true }) }
  }
}, NATIVE_ZOMBIE_TEST_TIMEOUT_MS)

test.each(['Z', 'S', 'R'])('stat parser reads %s with trailing newline and embedded comm delimiters', state => {
  for (const comm of ['bash', 'name with spaces', 'name ) with ) embedded spaces']) {
    expect(processState(`12771 (${comm}) ${state} 2 3 4\n`)).toBe(state)
  }
})
test.each(['', 'not stat data', '1 (bash) ', '1 (bash) ZZ 2', '1 (bash) 3 2'])('stat parser rejects an unreadable state in %j', stat => {
  expect(() => processState(stat)).toThrow('process state unavailable')
})

function fixture() {
  let now = 0
  const calls: { socket: string | null; args: string[] }[] = []
  const state = { sessionGoneAt: 300, processGoneAt: 500, status: undefined as number | undefined, pid: '123',
    sessionId: '$7', replacementId: '', stderr: '' }
  const probes = {
    now: () => now,
    sleep: async (ms: number) => { now += ms },
    pidAlive: (pid: number) => { expect(pid).toBe(123); return now < state.processGoneAt },
    tmux: (socket: string | null, args: string[]) => {
      calls.push({ socket, args })
      return args[0] === 'display-message' ? { status: 0, stdout: `${state.sessionId} ${state.pid}` }
        : { status: state.status ?? 0, stdout: now < state.sessionGoneAt ? '$7\n$70' : state.replacementId || '$70',
          noServer: state.status === 1 && tmuxNoServer(state.stderr, socket), diagnostic: tmuxDiagnostic(state.stderr, socket) }
    },
  }
  const row = { tmux_session_name: 'exact-session', tmux_socket: '/scratch/recorded-socket' }
  return { state, probes, calls, row }
}

test('exit barrier binds the live session and pane to the recorded socket, then waits for both to exit', async () => {
  const f = fixture()
  const life = captureLiveLife(f.row, f.probes)
  expect(f.calls).toEqual([
    { socket: f.row.tmux_socket, args: ['display-message', '-p', '-t', '=exact-session:', '#{session_id} #{pane_pid}'] },
    { socket: f.row.tmux_socket, args: ['list-sessions', '-F', '#{session_id}'] },
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
  expect(() => captureLiveLife(f.row, f.probes)).toThrow('pane identity unavailable')
  f.state.pid = '123'; f.state.processGoneAt = 0
  expect(() => captureLiveLife(f.row, f.probes)).toThrow('process is not live')
})

test('replacement with the same name and another id is gone; the old id still present is live', () => {
  const f = fixture(), life = captureLiveLife(f.row, f.probes)
  expect(life.tmux_session_id).toBe('$7')
  expect(sessionPresent(life, f.probes)).toBe(true)
  f.state.sessionGoneAt = 0; f.state.replacementId = '$8\n$70'
  expect(sessionPresent(life, f.probes)).toBe(false)
  f.state.replacementId = '$8\n$7'
  expect(sessionPresent(life, f.probes)).toBe(true)
})
test('invalid captured session ids and malformed session lists fail closed', () => {
  const f = fixture()
  f.state.sessionId = 'not-an-id'
  expect(() => captureLiveLife(f.row, f.probes)).toThrow('pane identity unavailable')
  f.state.sessionId = '$7'
  const life = captureLiveLife(f.row, f.probes)
  f.state.sessionGoneAt = 0; f.state.replacementId = 'not-an-id'
  expect(() => sessionPresent(life, f.probes)).toThrow('session identities unavailable')
  f.state.status = 1
  f.state.stderr = `no server running on ${f.row.tmux_socket}\n`
  expect(sessionPresent(life, f.probes)).toBe(false)
})

// [mode, stderr, absent, label]. The three absent outcomes are every way tmux
// 3.2a's client reports a gone server; every other outcome fails closed with its label.
const EXIT_ONE_DIAGNOSTICS = [
  ['no-server', 'no server running on /scratch/recorded-socket\n', true, 'no-server'],
  ['missing-socket', 'error connecting to /scratch/recorded-socket (No such file or directory)\n', true, 'missing-socket'],
  ['server-exited', 'server exited unexpectedly\n', true, 'server-exited-unexpectedly'],
  ['permission', 'error connecting to /scratch/recorded-socket (Permission denied)\n', false, 'connect-error:permission-denied'],
  // tmux 3.2a prints ECONNREFUSED as "no server running", never this text.
  ['refused-text', 'error connecting to /scratch/recorded-socket (Connection refused)\n', false, 'connect-error:connection-refused'],
  ['long-errno', 'error connecting to /scratch/recorded-socket (Resource temporarily unavailable)\n', false, 'connect-error:resource-temporarily-una'],
  ['protocol', 'protocol version mismatch (client 8, server 7)\n', false, 'protocol-version-mismatch'],
  ['server-too-old', 'server version is too old for client\n', false, 'server-too-old'],
  ['send-failure', 'failed to send command\n', false, 'send-failed'],
  ['command-too-long', 'command too long\n', false, 'command-too-long'],
  ['unrecognised', 'lost server\n', false, 'unrecognised-stderr'],
  ['bare-status', '', false, 'no-stderr'],
  ['foreign-socket', 'no server running on /scratch/foreign-socket\n', false, 'no-server-foreign-socket'],
  ['foreign-missing', 'error connecting to /scratch/foreign-socket (No such file or directory)\n', false, 'missing-socket-foreign-socket'],
  ['extra-diagnostic', 'no server running on /scratch/recorded-socket\nPermission denied\n', false, 'multi-line-stderr'],
  ['extra-blank-line', 'no server running on /scratch/recorded-socket\n\n', false, 'multi-line-stderr'],
] as const
test.each(EXIT_ONE_DIAGNOSTICS)('exit-one %s is absence only with a gone-server diagnostic, else fails with its label',
  (_name, stderr, absent, label) => {
    const f = fixture(), life = captureLiveLife(f.row, f.probes)
    f.state.status = 1; f.state.stderr = stderr
    expect(tmuxDiagnostic(stderr, f.row.tmux_socket)).toBe(label)
    expect(tmuxNoServer(stderr, f.row.tmux_socket)).toBe(absent)
    if (absent) { expect(sessionPresent(life, f.probes)).toBe(false); return }
    let error: unknown
    try { sessionPresent(life, f.probes) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(ExitBarrierError)
    expect((error as Error).message).toBe(`old life tmux query failed: list-sessions exit 1 (${label})`)
    expect((error as ExitBarrierError).facts).toEqual({ barrier: 'tmux-query', query: 'list-sessions', status: 1, tmux: label })
    expect((error as Error).message).not.toContain('Permission denied')
  })
test('default-socket no-server classification is bounded and accepts only the supported single-line diagnostics', () => {
  expect(tmuxNoServer('no server running on /tmp/tmux-1000/default\n', null)).toBe(true)
  expect(tmuxNoServer('error connecting to /tmp/tmux-1000/default (No such file or directory)\n', null)).toBe(true)
  expect(tmuxNoServer('server exited unexpectedly\n', null)).toBe(true)
  expect(tmuxNoServer('error connecting to /tmp/tmux-1000/default (Permission denied)\n', null)).toBe(false)
  expect(tmuxNoServer('no server running on /\n', null)).toBe(false)
  expect(tmuxNoServer('no server running on /' + 'x'.repeat(4096), null)).toBe(false)
  expect(tmuxDiagnostic('no server running on /' + 'x'.repeat(4096), null)).toBe('oversized-stderr')
})
test('a status-0 empty session list reads as absent', () => {
  const f = fixture(), life = captureLiveLife(f.row, f.probes)
  expect(sessionPresent(life, { ...f.probes, tmux: () => ({ status: 0, stdout: '' }) })).toBe(false)
})
test('the deadline failure names what still held', async () => {
  const f = fixture(), life = captureLiveLife(f.row, f.probes)
  f.state.sessionGoneAt = Infinity
  await expect(waitForLifeExit(life, f.probes)).rejects.toThrow('old life never exited within 10000 ms (session present, process dead)')
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
  const declarations = ['worker_tmux_diagnostic', 'worker_tmux_no_server', 'worker_tmux_query', 'end_worker', 'ended_worker_gone'].map(name =>
    shellSource.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? '').join('\n')
  try {
    writeFileSync(join(root, 'fake-tmux'), `#!/bin/bash
root="\${0%/*}"
printf '<%s>' "$@" >> "$root/args"
printf '\\n' >> "$root/args"
socket=/tmp/test-tmux/default
if [[ "$1" == -S ]]; then socket="$2"; shift 2; fi
query="$1"
exit_one() {
    case "$1" in
        no-server) printf 'no server running on %s\\n' "$socket" >&2 ;;
        missing-socket) printf 'error connecting to %s (No such file or directory)\\n' "$socket" >&2 ;;
        server-exited) printf 'server exited unexpectedly\\n' >&2 ;;
        permission) printf 'error connecting to %s (Permission denied)\\n' "$socket" >&2 ;;
        refused-text) printf 'error connecting to %s (Connection refused)\\n' "$socket" >&2 ;;
        long-errno) printf 'error connecting to %s (Resource temporarily unavailable)\\n' "$socket" >&2 ;;
        protocol) printf 'protocol version mismatch (client 8, server 7)\\n' >&2 ;;
        server-too-old) printf 'server version is too old for client\\n' >&2 ;;
        send-failure) printf 'failed to send command\\n' >&2 ;;
        command-too-long) printf 'command too long\\n' >&2 ;;
        unrecognised) printf 'lost server\\n' >&2 ;;
        foreign-socket) printf 'no server running on /scratch/foreign-socket\\n' >&2 ;;
        foreign-missing) printf 'error connecting to /scratch/foreign-socket (No such file or directory)\\n' >&2 ;;
        extra-diagnostic) printf 'no server running on %s\\nPermission denied\\n' "$socket" >&2 ;;
        extra-blank-line) printf 'no server running on %s\\n\\n' "$socket" >&2 ;;
        bare-status) : ;;
    esac
    exit 1
}
if [[ "$query" == has-session && "$MODE" == before-exit-one-* ]]; then exit_one "\${MODE#before-exit-one-}"; fi
if [[ "$MODE" == before-timeout && ! -e "$root/poll" && "$query" == has-session ]]; then exit 124; fi
if [[ "$MODE" == pane-timeout && "$query" == display-message ]]; then exit 124; fi
if [[ -e "$root/poll" && "$query" == list-sessions ]]; then
    case "$MODE" in
        unexpected-*) exit "\${MODE#unexpected-}" ;;
        exit-one-*) exit_one "\${MODE#exit-one-}" ;;
        hang) while (( SECONDS < 5 )); do :; done ;;
        present) printf '$7\\n$8\\n'; exit 0 ;;
        replacement) printf '$8\\n$70\\n'; exit 0 ;;
        *) exit_one no-server ;;
    esac
fi
[[ "$query" != display-message ]] || printf '$7 123\\n'
`, { mode: 0o755 })
    const script = `set -euo pipefail
root="$1"
SCENARIO_ROOT="$root"
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
    ended_worker_gone '$7' 123 ${recordedSocket ? "-S '/scratch/recorded socket'" : ''}
fi
`
    const result = spawnSync('bash', ['-c', script, 'ended-life-control', root, action], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'timeout', 'mktemp', 'head', 'rm'], extras: { MODE: mode } }),
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

test.each(EXIT_ONE_DIAGNOSTICS)('shell exit-one %s is absence only with a gone-server diagnostic, else fails with its label',
  (name, _stderr, absent, label) => {
    const result = shellControl(`exit-one-${name}`)
    expect(result.status).toBe(absent ? 0 : 70)
    expect(result.stderr).toBe(absent ? '' : `FAIL: old life tmux query failed (status 1, ${label})\n`)
  })
test.each(['no-server', 'missing-socket', 'server-exited', 'permission', 'protocol'])('shell has-session exit-one %s keeps the positive control fail-closed', name => {
  const result = shellControl(`before-exit-one-${name}`, 'end')
  expect(result.status).toBe(70)
  expect(result.stderr).toContain(['no-server', 'missing-socket', 'server-exited'].includes(name)
    ? 'old life session is not live before exit' : 'old life tmux query failed (status 1, ')
  expect(result.args).not.toContain('<send-keys>')
  expect(result.stderr).not.toContain('Permission denied')
})

test('shell barrier bounds a hanging query with the actual three-second subprocess timeout', () => {
  const started = Date.now(), result = shellControl('hang')
  expect(result.status).toBe(70)
  expect(result.stderr).toContain('tmux query timed out')
  expect(Date.now() - started).toBeGreaterThanOrEqual(2800)
}, SHELL_HANG_TEST_TIMEOUT_MS)

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
    prefix + '<display-message><-p><-t><=exact-session:><#{session_id} #{pane_pid}>',
    prefix + '<send-keys><-t><=exact-session:><fixture-exit><Enter>',
    prefix + '<list-sessions><-F><#{session_id}>',
  ])
})

test('shell barrier ignores a same-name replacement with another session id', () => {
  expect(shellControl('replacement').status).toBe(0)
})

test.each(['present', 'process-live'])('shell barrier keeps waiting while %s', mode => {
  const result = shellControl(mode)
  expect(result.status).toBe(1)
  expect(result.stderr).toBe('')
})

// Native controls: the real tmux 3.2a client against a private -S socket under
// a scratch HOME, never the caller's tmux server or default socket.
function localTmuxVersion(): string {
  if (!Bun.which('tmux')) return ''
  const root = mkdtempSync('/tmp/ended-life-tmux-version-')
  try { return spawnSync('tmux', ['-V'], { env: hostSafeChildEnv(root, { tools: ['tmux'] }), encoding: 'utf8', timeout: 3000 }).stdout?.trim() ?? '' }
  finally { rmSync(root, { recursive: true, force: true }) }
}
const tmux32a = localTmuxVersion() === 'tmux 3.2a'
const tmuxSkipReason = tmux32a ? '' : ' [skip: tmux 3.2a is not on PATH]'
// Up to 3 s for the server to exit on its own, 10 s barrier bound, 5 s for startup and cleanup.
const NATIVE_TMUX_EXIT_TEST_TIMEOUT_MS = 18000
// One bounded query plus 5 s for listener startup and cleanup.
const NATIVE_LISTENER_TEST_TIMEOUT_MS = TMUX_QUERY_TIMEOUT_MS + 5000
// Where /proc is another pid namespace's (a sandboxed run), pidAlive cannot
// read the state; kill -0 alone still sees the process, and only errs toward
// alive (an unreaped zombie), which keeps the barrier waiting, never releases it.
function killZeroAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}
const nativeAlive = procMatchesPid ? pidAlive : killZeroAlive

test.skipIf(!tmux32a)('native tmux 3.2a: the exited server leaves a stale socket, read as gone, and a removed socket too' + tmuxSkipReason, async () => {
  const root = mkdtempSync('/tmp/ended-life-tmux-')
  const socket = join(root, 'server.sock')
  const env = hostSafeChildEnv(root, { tools: ['tmux', 'sleep'] })
  const probes = { tmux: (s: string | null, args: string[]) => runTmux(s, args, env), pidAlive: nativeAlive,
    now: () => Date.now(), sleep: (ms: number) => Bun.sleep(ms) }
  let serverPid = 0, panePid = 0
  try {
    expect(runTmux(socket, ['new-session', '-d', '-s', 'old-life', 'sleep 60'], env).status).toBe(0)
    serverPid = Number(runTmux(socket, ['display-message', '-p', '-t', '=old-life:', '#{pid}'], env).stdout)
    const life = captureLiveLife({ tmux_session_name: 'old-life', tmux_socket: socket }, probes)
    panePid = life.pid
    expect(serverPid).toBeGreaterThan(0)
    // The old life ends as test-4's does: its process exits, its session
    // closes and the server, left with no sessions, exits on its own.
    process.kill(panePid, 'SIGTERM')
    await waitForLifeExit(life, probes)
    const deadline = Date.now() + 3000
    while (nativeAlive(serverPid) && Date.now() < deadline) await Bun.sleep(20)
    expect(nativeAlive(serverPid)).toBe(false)
    expect(existsSync(socket)).toBe(true) // tmux 3.2a leaves its socket file: stale.
    const stale = runTmux(socket, ['list-sessions', '-F', '#{session_id}'], env)
    expect([stale.status, stale.diagnostic, stale.noServer]).toEqual([1, 'no-server', true])
    expect(sessionPresent(life, probes)).toBe(false)
    rmSync(socket)
    const missing = runTmux(socket, ['list-sessions', '-F', '#{session_id}'], env)
    expect([missing.status, missing.diagnostic, missing.noServer]).toEqual([1, 'missing-socket', true])
    expect(sessionPresent(life, probes)).toBe(false)
  } finally {
    for (const pid of [panePid, serverPid]) if (pid > 0 && nativeAlive(pid)) process.kill(pid, 'SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
}, NATIVE_TMUX_EXIT_TEST_TIMEOUT_MS)

// A Unix listener that accepts each connection and closes it unanswered (as an
// exiting tmux server does) or holds it open and never answers.
const LISTENER = `import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
s.listen(8)
print('ready', flush=True)
held = []
while True:
    c, _ = s.accept()
    if sys.argv[2] == 'hold': held.append(c)
    else: c.close()
`
test.skipIf(!tmux32a).each(['close', 'hold'])('native tmux 3.2a against a listener that will %s each connection' + tmuxSkipReason, async mode => {
  const root = mkdtempSync('/tmp/ended-life-listener-')
  const socket = join(root, 'server.sock')
  const life = { tmux_session_name: 'old-life', tmux_session_id: '$0', tmux_socket: socket, pid: 1 }
  const env = hostSafeChildEnv(root, { tools: ['tmux'] })
  const probes = { tmux: (s: string | null, args: string[]) => runTmux(s, args, env), pidAlive,
    now: () => Date.now(), sleep: (ms: number) => Bun.sleep(ms) }
  const listener = spawn('python3', ['-I', '-c', LISTENER, socket, mode], {
    env: hostSafeChildEnv(root, { tools: ['python3'] }), stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  listener.stderr.on('data', bytes => { stderr += bytes.toString() })
  const exited = once(listener, 'exit')
  try {
    const [ready] = await Promise.race([once(listener.stdout, 'data'), exited])
    expect(String(ready), `listener failed: ${stderr}`).toBe('ready\n')
    if (mode === 'close') {
      const closed = runTmux(socket, ['list-sessions', '-F', '#{session_id}'], env)
      expect([closed.status, closed.diagnostic, closed.noServer]).toEqual([1, 'server-exited-unexpectedly', true])
      expect(sessionPresent(life, probes)).toBe(false)
    } else {
      // An unanswered connection is not proof of absence: the bounded query fails closed.
      expect(() => sessionPresent(life, probes)).toThrow(`old life tmux query failed: list-sessions timed out after ${TMUX_QUERY_TIMEOUT_MS} ms`)
    }
  } finally {
    listener.kill('SIGKILL')
    try { await exited }
    finally { rmSync(root, { recursive: true, force: true }) }
  }
}, NATIVE_LISTENER_TEST_TIMEOUT_MS)
