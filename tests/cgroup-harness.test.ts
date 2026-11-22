import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import * as evidence from './integration/fixtures/sr8-evidence.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { CPUS_PER_SHARD, DRIVER_CPUS, shardCpus } from '../scripts/ci-run.ts'

const repo = join(import.meta.dir, '..'), fixtures = join(import.meta.dir, 'integration/fixtures')
const scenario = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
const launcher = existsSync(join(fixtures, 'server-start.sh')) ? readFileSync(join(fixtures, 'server-start.sh'), 'utf8') : ''
const procMatchesPid = readlinkSync('/proc/self') === String(process.pid)
const nativeSkipReason = procMatchesPid ? '' : ' [skip: /proc/self does not match process.pid]'
let root: string
const sockets: { stop(close: boolean): void }[] = []
beforeEach(() => { root = mkdtempSync('/tmp/test-harness-') })
afterEach(() => { for (const socket of sockets.splice(0)) socket.stop(true); rmSync(root, { recursive: true, force: true }) })
function declaration(text: string, name: string) {
  const match = text.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))
  if (!match) throw new Error(`missing ${name}`)
  return match[0]
}
function shell(program: string, timeout = 10000) {
  return spawnSync('bash', ['-c', `set -euo pipefail\nexport SCENARIO_ROOT="$HOME"\n${program}`], {
    env: hostSafeChildEnv(root, { tools: ['bash', 'bun', 'tmux', 'sleep', 'python3', 'find', 'realpath', 'flock', 'mkfifo', 'timeout', 'cat', 'chmod', 'id', 'jq'] }),
    encoding: 'utf8', timeout,
  })
}
test('harness placement: burst shards reserve five CPUs and ordinary shards keep two', () => {
  expect(CPUS_PER_SHARD + DRIVER_CPUS).toBe(5)
  expect(shardCpus(['test-52-fmk-membership-load-rate.sh'])).toBe(5)
  expect(shardCpus(['test-1-install-startup.sh'])).toBe(2)
})
test.each(['400000', '489999'])('harness placement: the former container quota %s is refused', quota => {
  const entry = readFileSync(join(repo, 'docker/entrypoint.sh'), 'utf8')
  const child = shell([
    'chown() { :; }; gosu() { :; }', 'mkdir "$HOME/cg"', `printf '${quota} 100000\\n' > "$HOME/cg/cpu.max"`,
    'printf "0::/\\n" > "$HOME/member"; echo "$$" > "$HOME/cg/cgroup.procs"',
    declaration(entry, 'split_driver_cpu'), 'split_driver_cpu "$HOME/cg" "$HOME/member" "$HOME/spool"',
  ].join('\n'))
  expect(child.status).toBe(1)
  expect(child.stderr).toContain('less than 1 CPU of headroom')
})

function plantedLauncher() {
  return launcher.replace("[[ -f /etc/cscb-ci-image ]] || { echo 'server-start requires the CI image' >&2; exit 70; }", '')
    .replace('SPOOL=/run/cscb-burst-driver-server', 'SPOOL="$HOME/spool"')
    .replace('BUN=/usr/local/bin/bun', 'BUN="$HOME/bun"')
    .replace('CLI=/test-repo/node_modules/claude-slack-channel-bots/src/cli.ts', 'CLI="$HOME/cli.ts"')
    .replace('REPO=/test-repo', 'REPO="$HOME"')
    .replace('TRUSTED_UID=0', 'TRUSTED_UID="$(id -u)"').replace('TRUSTED_GID=0', 'TRUSTED_GID="$(id -g)"')
}
function brokerSetup() {
  const quotedBun = "'" + process.execPath.replaceAll("'", "'\\''") + "'"
  writeFileSync(join(root, 'bun'), `#!/bin/bash\nexec ${quotedBun} "$@"\n`, { mode: 0o755 })
  writeFileSync(join(root, 'server-start.sh'), plantedLauncher(), { mode: 0o644 })
  writeFileSync(join(root, 'cli.ts'), `console.log('start=' + process.argv.slice(2).join(',') + ' cwd=' + process.cwd()); console.log('cli-pid=' + process.pid); console.error('start stderr'); process.exitCode=7\n`, { mode: 0o644 })
  return [
    'chmod 0755 "$HOME"', 'mkdir -m 0755 "$HOME/spool"; mkdir -m 0700 "$HOME/spool/jobs"',
    'mkfifo -m 0660 "$HOME/spool/requests"', 'mkdir "$HOME/state" "$HOME/home" "$HOME/tmux"',
    'export SLACK_STATE_DIR="$HOME/state" CSCB_SLACK_API_URL=http://127.0.0.1:1234/api/ CSCB_TEST_DIAGNOSTICS=1',
    'bash "$HOME/server-start.sh" --serve "$HOME/spool" & broker=$!', 'trap \'kill "$broker" 2>/dev/null || :\' EXIT',
  ]
}
test.skipIf(!procMatchesPid)('server start launcher preserves output/status, uses a fixed command and records the real CLI PID' + nativeSkipReason, () => {
  const child = shell([...brokerSetup(), 'rc=0; bash "$HOME/server-start.sh" start || rc=$?', 'echo "rc=$rc"', 'cat "$HOME/cscb-processes"'].join('\n'))
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  const pid = child.stdout.match(/^cli-pid=(\d+)$/m)?.[1]
  expect(pid).toBeDefined()
  expect(child.stdout).toContain(`start=start cwd=${root}\ncli-pid=${pid}\nrc=7\nproc\tstart\t${pid}\t`)
  expect(child.stdout).toMatch(/proc\tstart\t\d+\t\d+\t\d+\.\d{6}\t/)
  expect(child.stderr).toBe('start stderr\n')
})
test('server start in-place fallback keeps caller environment, cwd and status', () => {
  writeFileSync(join(root, 'server-start.sh'), plantedLauncher())
  writeFileSync(join(root, 'cli'), '#!/bin/bash\necho "fallback $* $EXTRA"; exit 9\n', { mode: 0o755 })
  const child = shell('export SCENARIO_CLI="$HOME/cli" EXTRA=kept; bash "$HOME/server-start.sh" start')
  expect({ status: child.status, stdout: child.stdout, stderr: child.stderr }).toEqual({ status: 9, stdout: 'fallback start kept\n', stderr: '' })
})
test.each(['restart', 'start extra'])('server launcher refuses command %s before execution', command => {
  writeFileSync(join(root, 'server-start.sh'), plantedLauncher())
  const child = shell(`bash "$HOME/server-start.sh" ${command}`)
  expect(child.status).toBe(64)
  expect(child.stdout).toBe('')
})
test.each(['BUN_OPTIONS=--preload=bad', 'SLACK_STATE_DIR=/tmp/elsewhere', 'CSCB_SLACK_API_URL=https://example.invalid/api/'])
('server launcher refuses unsupported input %s', input => {
  const child = shell([...brokerSetup(), `export ${input}`, 'rc=0; bash "$HOME/server-start.sh" start || rc=$?; echo "rc=$rc"'].join('\n'))
  expect(child.error).toBeUndefined(); expect(child.stdout).toBe('rc=64\n')
})
test.skipIf(!procMatchesPid)('server launcher drops arbitrary caller loaders and environment' + nativeSkipReason, () => {
  const setup = brokerSetup()
  writeFileSync(join(root, 'cli.ts'), `console.log(JSON.stringify({node:process.env.NODE_OPTIONS,extra:process.env.EXTRA,home:process.env.HOME,path:process.env.PATH,dry:process.env.SLACK_DRY_RUN}));\n`)
  const child = shell([...setup, 'export EXTRA=forbidden NODE_OPTIONS=--trace-warnings SLACK_DRY_RUN=1', 'bash "$HOME/server-start.sh" start'].join('\n'))
  expect(child.status).toBe(0)
  expect(JSON.parse(child.stdout)).toEqual({ home: `${root}/home`, path: `${root}/tmux-shim/bin:${root}/bin:/usr/local/bin:/usr/bin:/bin`, dry: '1' })
})
test('server launcher refuses crafted requests that bypass the caller allowlist', () => {
  const child = shell([...brokerSetup(),
    'craft() { local request; request="$(mktemp -d "$HOME/spool/jobs/request.XXXXXX")"; mkfifo "$request/spec" "$request/out" "$request/err" "$request/status" "$request/signals"; echo "${request##*/}" > "$HOME/spool/requests"; printf "%s\\0" "$@" > "$request/spec"; cat "$request/status"; rm -rf "$request"; }',
    'craft restart "$HOME" "$HOME/state" 0 http://127.0.0.1:1234/api/ 1 ""',
    'craft start "$HOME" "$HOME/state" 0 http://127.0.0.1:1234/api/ 1 "" PATH=/tmp',
    'craft start "$HOME" "$HOME/state/../state" 0 http://127.0.0.1:1234/api/ 1 ""',
    '[[ ! -e "$HOME/cscb-processes" ]] && echo refused',
  ].join('\n'))
  expect({ status: child.status, stdout: child.stdout, stderr: child.stderr }).toEqual({ status: 0, stdout: 'exit 64\nexit 64\nexit 64\nrefused\n', stderr: '' })
})
test.skipIf(!procMatchesPid)('server launcher preserves the existing profile opt-in through its fixed trusted preload' + nativeSkipReason, () => {
  const setup = brokerSetup(), preload = join(root, 'preload.ts')
  writeFileSync(preload, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CSCB_TEST_CPU_PROFILE_DIR + '/loaded', 'yes')\n", { mode: 0o644 })
  writeFileSync(join(root, 'server-start.sh'), plantedLauncher().replaceAll('/tests/integration/fixtures/cpu-profile-preload.ts', preload))
  writeFileSync(join(root, 'cli.ts'), "console.log('profile preserved')\n")
  const child = shell([...setup, 'mkdir "$HOME/profile"', 'export BUN_OPTIONS="--preload $HOME/preload.ts" CSCB_TEST_CPU_PROFILE_DIR="$HOME/profile"',
    'bash "$HOME/server-start.sh" start',
  ].join('\n'))
  expect({ status: child.status, stdout: child.stdout, stderr: child.stderr }).toEqual({ status: 0, stdout: 'profile preserved\n', stderr: '' })
  expect(readFileSync(join(root, 'profile/loaded'), 'utf8')).toBe('yes')
})
test('server launcher refuses an other-writable entry file', () => {
  const setup = brokerSetup().slice(0, 5)
  const child = shell([...setup, 'chmod 0666 "$HOME/server-start.sh"; bash "$HOME/server-start.sh" --serve "$HOME/spool"'].join('\n'))
  expect(child.status).toBe(70); expect(child.stderr).toContain('untrusted launcher path')
})

test.skipIf(!procMatchesPid)('harness tmux first launch, two personas and empty restart retain the owned scratch socket; cleanup reaps empty server' + nativeSkipReason, () => {
  const prestart = declaration(scenario, '_scenario_harness_tmux').replace('"/proc/${pid}/cgroup"', '"${SCENARIO_ROOT}/group"')
  const child = shell([
    'mkdir "$HOME/tmux"; export TMUX_TMPDIR="$HOME/tmux"; SCENARIO_REAL_TMUX="$(command -v tmux)"; SCENARIO_TMUX_STOP_S=2',
    'trap \'"$SCENARIO_REAL_TMUX" kill-server 2>/dev/null || :\' EXIT',
    'require_ci_image() { :; }; require_scenario_home() { :; }; _scenario_tmux_check() { :; }; fail() { echo "$*" >&2; exit 1; }',
    'printf "0::/shard/harness\\n" > "$HOME/group"', declaration(scenario, '_scenario_proc_starttime'), prestart,
    '_scenario_harness_tmux; IFS=$\'\\t\' read -r first st socket < "$HOME/harness-tmux"; echo "first $first"',
    '"$SCENARIO_REAL_TMUX" new-session -d -s alpha "sleep 60"; "$SCENARIO_REAL_TMUX" new-session -d -s beta "sleep 60"',
    '"$SCENARIO_REAL_TMUX" list-sessions -F "#{session_name}"',
    '"$SCENARIO_REAL_TMUX" kill-session -t =alpha; "$SCENARIO_REAL_TMUX" kill-session -t =beta',
    '_scenario_harness_tmux; IFS=$\'\\t\' read -r second st socket < "$HOME/harness-tmux"; [[ "$first" == "$second" ]] && echo retained',
    declaration(scenario, '_scenario_stop_tmux'),
    declaration(scenario, '_scenario_tmux_pids'), declaration(scenario, '_scenario_tmux_gone'),
    '_scenario_pid_ours() { return 1; }',
    '_scenario_poll_until() { local budget=$1 n; shift; for n in {1..100}; do "$@" && return 0; sleep .01; done; return 1; }',
    '_scenario_stop_tmux; echo reaped',
  ].join('\n'))
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(child.stderr).toBe('')
  expect(child.stdout).toMatch(/^first \d+\nalpha\nbeta\nretained\nreaped\n$/)
})
test('ordinary run_start keeps the original start path and never bootstraps tmux', () => {
  const body = declaration(scenario, 'run_start')
  expect(body).toContain('if [[ -p /run/cscb-burst-driver-server/requests ]]; then\n        _scenario_harness_tmux')
  expect(body).toContain('(cd "${SCENARIO_REPO}" && _scenario_cscb_exec start env "${env_args[@]}" "${SCENARIO_CLI}" start)')
  writeFileSync(join(root, 'cli'), '#!/bin/bash\necho "ordinary dry=$SLACK_DRY_RUN"; exit 13\n', { mode: 0o755 })
  const child = shell([
    'SLACK_STATE_DIR="$HOME/state"; SCENARIO_REPO="$HOME"; SCENARIO_CLI="$HOME/cli"; _SCENARIO_START_COUNT=0; _SCENARIO_BEFORE_START_HOOKS=()',
    '_scenario_register_state_dir() { :; }; _scenario_cscb_after() { :; }; server_pid() { :; }',
    '_scenario_cscb_exec() { shift; exec "$@"; }; _scenario_harness_tmux() { echo unexpected; exit 42; }',
    body.replaceAll('/run/cscb-burst-driver-server', `${root}/absent`),
    'run_start; echo "rc=$START_RC"; cat "$START_OUT"',
  ].join('\n'))
  expect({ status: child.status, stdout: child.stdout, stderr: child.stderr }).toEqual({ status: 0, stdout: 'rc=13\nordinary dry=1\n', stderr: '' })
})

// Access through the namespace so the before context still typechecks when
// it restores HEAD's fixture, which predates this exported evidence collector.
const collect = (...args: unknown[]): evidence.Result => (evidence as unknown as Record<string, (...args: unknown[]) => evidence.Result>).harnessCpuEvidence(...args)
function placement(personas = 2) {
  const proc = join(root, 'proc'), state = join(root, 'state'), socket = join(root, 'tmux/default')
  mkdirSync(state); mkdirSync(join(root, 'tmux'))
  sockets.push(Bun.serve({ unix: socket, fetch: () => new Response('') }))
  const dirs = ['alpha', 'beta'].slice(0, personas).map(name => join(root, name))
  writeFileSync(join(state, 'config.json'), JSON.stringify({ personas: dirs.map(working_directory => ({ working_directory })) }))
  writeFileSync(join(root, 'record.harness'), '10 11\n')
  writeFileSync(join(root, 'harness-tmux'), `20\t99\t${socket}\n`)
  writeFileSync(join(root, 'harness-server'), '50\t99\n')
  writeFileSync(join(root, 'harness-slack'), '12\t99\n')
  const put = (pid: number, parent: number, group: string, entry = 'worker', cwd = root) => {
    const dir = join(proc, String(pid)); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'stat'), `${pid} (fixture) S ${parent} ${Array(17).fill('0').join(' ')} 99\n`)
    writeFileSync(join(dir, 'cgroup'), `0::${group}\n`)
    if (entry) writeFileSync(join(dir, 'cmdline'), `/bin/tool\0/${entry}\0`)
    if (cwd) symlinkSync(cwd, join(dir, 'cwd'))
  }
  for (const pid of [10, 11, 20]) put(pid, 1, '/shard/harness')
  put(12, 11, '/shard/harness', 'slack-stub-server.ts')
  put(50, 1, '/shard/server', 'cli.ts'); put(51, 50, '/shard/server', 'helper')
  dirs.forEach((cwd, i) => { put(30 + i, 20, '/shard/harness', 'claude', cwd); put(40 + i, 30 + i, '/shard/harness', 'stub-mcp-session.ts', cwd) })
  const limits: Record<string, string> = { '/': '500000 100000', '/shard': 'max 100000', '/shard/harness': '100000 100000' }
  return { proc, state, limits, put, personas, run: () => collect(root, state, join(root, 'record'), personas, (path: string) => limits[path], proc, 50) }
}
function fixtureClient(p: ReturnType<typeof placement>, parent = 11, cwd = root) {
  p.put(70, parent, '/shard/harness', 'stub-mcp-session.ts', cwd)
  writeFileSync(join(root, 'harness-clients'), '70\t99\n')
}
function personaFixtureClient(p: ReturnType<typeof placement>, directory = join(root, 'alpha'), pid = 70, record = true) {
  p.put(pid, 11, '/shard/harness', 'stub-mcp-session.ts')
  writeFileSync(join(p.proc, String(pid), 'cmdline'), ['/bin/tool', join(root, 'bin/stub-mcp-session.ts'),
    join(root, 'home/.claude/slack-mcp.json'), directory, ''].join('\0'))
  const file = join(root, 'harness-clients')
  if (record) writeFileSync(file, (existsSync(file) ? readFileSync(file, 'utf8') : '') + `${pid}\t99\n`)
}
test('round24 fixture MCP: one silent persona reproduces the test-44 placement and passes', () => {
  const p = placement(1)
  rmSync(join(p.proc, '40'), { recursive: true }); rmSync(join(p.proc, '51'), { recursive: true })
  p.put(60, 20, '/shard/harness', 'helper'); personaFixtureClient(p)
  expect(p.run()).toMatchObject({ verdict: 'pass', stats: { persona_stubs: 1, persona_mcps: 0, persona_fixture_mcps: 1,
    harness_members: 4, server_members: 1, runner_cgroup: '/shard/harness', script_cgroup: '/shard/harness',
    tmux_cgroup: '/shard/harness', slack_cgroup: '/shard/harness' } })
  const child = placementCLI(p)()
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(child.stdout).toContain('persona_stubs=1 persona_mcps=0 harness_members=4')
  expect(child.stdout).toContain('persona_fixture_mcps=1')
})
test('round24 fixture MCP: mixed tree and fixture MCPs each cover their own persona', () => {
  const p = placement(); rmSync(join(p.proc, '40'), { recursive: true }); personaFixtureClient(p)
  expect(p.run()).toMatchObject({ verdict: 'pass', stats: { persona_stubs: 2, persona_mcps: 1, persona_fixture_mcps: 1 } })
})
test('round24 fixture MCP: two silent personas each have one distinct listed client', () => {
  const p = placement(); for (const pid of [40, 41]) rmSync(join(p.proc, String(pid)), { recursive: true })
  personaFixtureClient(p); personaFixtureClient(p, join(root, 'beta'), 71)
  expect(p.run()).toMatchObject({ verdict: 'pass', stats: { persona_stubs: 2, persona_mcps: 0, persona_fixture_mcps: 2 } })
})
test('round24 fixture MCP: a listed client already inside tmux is not fixture evidence', () => {
  const p = placement(1); rmSync(join(p.proc, '40'), { recursive: true }); personaFixtureClient(p)
  writeFileSync(join(p.proc, '20/stat'), readFileSync(join(p.proc, '20/stat'), 'utf8').replace(') S 1 ', ') S 11 '))
  writeFileSync(join(p.proc, '70/stat'), readFileSync(join(p.proc, '70/stat'), 'utf8').replace(') S 11 ', ') S 30 '))
  expect(p.run().verdict).toBe('missing')
})
test('round24 fixture MCP: pending branch starts one client per silent persona and posts only on the first', () => {
  const script = readFileSync(join(import.meta.dir, 'integration/test-44-fmk-thread-burst.sh'), 'utf8')
  const pending = script.match(/^    pending\)[\s\S]*?(?=        # Keep the long-window probes)/m)?.[0]
  expect(pending).toBeDefined()
  const child = shell([
    'EVIDENCE="$HOME"; SCENARIO_BIN="$HOME/bin"; KEYS=(alpha beta); declare -A CLIENT WORK=([alpha]="$HOME/alpha" [beta]="$HOME/beta")',
    'bun() { printf "%s\\n" "$@" > "$3.argv"; }',
    'track_pid() { echo track >> "$HOME/calls"; }',
    '_scenario_placement_identity() { [[ "$1" == clients ]]; echo identity >> "$HOME/calls"; }',
    declaration(script, 'start_fixture_client'),
    'wait_fixture_client() { :; }',
    'start_pending_post() { start_fixture_client "$1"; echo "post=$1" >> "$HOME/calls"; }',
    `case pending in\n${pending}\n;; esac`,
    '[[ ${#CLIENT[@]} == 2 ]]; for client in "${CLIENT[@]}"; do wait "$client"; done',
    'cat "$HOME/calls"',
  ].join('\n'))
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(child.stdout).toBe('track\nidentity\npost=alpha\ntrack\nidentity\n')
  for (const key of ['alpha', 'beta']) expect(readFileSync(join(root, `${key}.argv`), 'utf8')).toBe(
    `${join(root, 'bin/stub-mcp-session.ts')}\n${join(root, '.claude/slack-mcp.json')}\n${join(root, key)}\n`)
})

function fixtureReadinessSetup(script: string, expire = false) {
  return [
    'EVIDENCE="$HOME"; SCENARIO_BIN="$HOME/bin"; KEYS=(alpha beta); declare -A CLIENT WORK=([alpha]="$HOME/alpha" [beta]="$HOME/beta")',
    'mkfifo "$HOME/observed" "$HOME/client-gate"; exec 9<> "$HOME/observed"; exec 8<> "$HOME/client-gate"',
    'mkdir "$HOME/sessions"; : > "$HOME/sessions/beta.jsonl"',
    'trap \'for key in alpha beta; do if [[ -f "$HOME/$key.pid" ]]; then kill "$(cat "$HOME/$key.pid")" 2>/dev/null || :; fi; done\' EXIT',
    'bun() { read -r unused <&8; }',
    'track_pid() { :; }',
    '_scenario_placement_identity() { echo "$2" > "$HOME/${key}.pid"; }',
    '_scenario_session_file() { echo "$HOME/sessions/${1##*/}.jsonl"; }',
    'fail() { echo "$*" >&2; exit 1; }',
    // Observe the real blocking select, with no delay or production test hook.
    `python3() { command python3 -c '
import os, select, sys, time
${expire ? 'time.monotonic = iter([0, 0, 31]).__next__' : ''}
original_select = select.select
def observed(*args):
    if len(args) == 4 and args[3] != 0:
        os.write(9, b"waiting\\n")
${expire ? '        return ([], [], [])' : ''}
    return original_select(*args)
select.select = observed
sys.argv = sys.argv[1:]
exec(compile(sys.stdin.read(), "fixture readiness", "exec"))
' "$@"; }`,
    declaration(script, 'start_fixture_client'),
    script.match(/^wait_fixture_client\(\) \{[\s\S]*?^\}/m)?.[0] ?? '',
  ]
}
test('round25 readiness: held beta cannot reach measurement until its own connected record', () => {
  const script = readFileSync(join(import.meta.dir, 'integration/test-44-fmk-thread-burst.sh'), 'utf8')
  const pending = script.match(/^    pending\)[\s\S]*?(?=        # Keep the long-window probes)/m)?.[0]
  expect(pending).toBeDefined()
  const child = shell([...fixtureReadinessSetup(script),
    'start_pending_post() { start_fixture_client "$1"; printf \'{"event":"connected","pid":%s,"session_id":"alpha-session","reason":"start"}\\n\' "${CLIENT[$1]}" > "$HOME/sessions/$1.jsonl"; echo "post=$1"; }',
    `( case pending in\n${pending}\n;; esac; echo measured > "$HOME/measured"; echo measurement >&9 ) & setup=$!`,
    'read -r -t 5 event <&9; if [[ "$event" != waiting ]]; then echo advanced-before-ready; wait "$setup"; exit 0; fi',
    '[[ ! -e "$HOME/measured" ]]; echo held',
    'pid="$(cat "$HOME/beta.pid")"; printf \'{"event":"connected","pid":%s,"session_id":"wrong-client","reason":"start"}\\n\' "$((pid + 1))" >> "$HOME/sessions/beta.jsonl"',
    'read -r -t 5 event <&9; [[ "$event" == waiting && ! -e "$HOME/measured" ]]; echo wrong-pid-held',
    'printf \'{"event":"connected","pid":%s,"session_id":"beta-session","reason":"start"}\\n\' "$pid" >> "$HOME/sessions/beta.jsonl"',
    'while read -r -t 5 event <&9; do [[ "$event" != measurement ]] || break; done; [[ "$event" == measurement ]]; wait "$setup"; cat "$HOME/measured"',
  ].join('\n'))
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(child.stderr).toBe('')
  expect(child.stdout).toBe('post=alpha\nheld\nwrong-pid-held\nmeasured\n')
})
test.each(['before wait', 'during wait'] as const)('round25 readiness: client exit %s fails before measurement', when => {
  const script = readFileSync(join(import.meta.dir, 'integration/test-44-fmk-thread-burst.sh'), 'utf8')
  const child = shell([...fixtureReadinessSetup(script),
    'start_fixture_client beta; pid="${CLIENT[beta]}"',
    ...(when === 'before wait' ? ['kill "$pid"; wait "$pid" 2>/dev/null || :'] : []),
    '( wait_fixture_client beta; echo measured > "$HOME/measured" ) & setup=$!',
    ...(when === 'during wait' ? ['read -r -t 5 event <&9; [[ "$event" == waiting ]]; kill "$pid"; wait "$pid" 2>/dev/null || :'] : []),
    'rc=0; wait "$setup" || rc=$?; echo "exit=$rc"; [[ ! -e "$HOME/measured" ]]',
  ].join('\n'))
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(child.stdout).toBe('exit=1\n')
  expect(child.stderr).toContain('fixture MCP beta')
  expect(child.stderr).toContain('exited before readiness')
})
test('round25 readiness: a live client without connection evidence fails at the deadline', () => {
  const script = readFileSync(join(import.meta.dir, 'integration/test-44-fmk-thread-burst.sh'), 'utf8')
  const child = shell([...fixtureReadinessSetup(script, true),
    'start_fixture_client beta; wait_fixture_client beta; echo measured',
  ].join('\n'))
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toBe('')
  expect(child.stderr).toContain('no connected/roots observation within 30s')
  expect(child.stderr).toContain('fixture MCP beta: readiness barrier failed')
})
// The native R26 probe found an empty, correctly recorded tmux tree and a
// retained AD pending row after --stop-bots; the measured start deferred it.
// Drive the script's real seal/stop/restart sequence and identity writer.
function sealRestart(mode: 'valid' | 'no-worker' | 'pending' | 'query-error' | 'bad-rows' = 'valid', terminal = 'missing') {
  const p = placement(1), script = readFileSync(join(import.meta.dir, 'integration/test-44-fmk-thread-burst.sh'), 'utf8')
  rmSync(join(p.proc, '40'), { recursive: true }); rmSync(join(p.proc, '51'), { recursive: true })
  p.put(60, 20, '/shard/harness', 'sleep')
  const setup = script.match(/^# Decision 24:[\s\S]*?(?=\nstart_fixture_client\(\))/m)?.[0]
  if (!setup) throw new Error('missing seal/restart sequence')
  const child = shell([
    `mode='${mode}'; terminal='${terminal}'; generation=98`,
    'population=10000; KEYS=(alpha); declare -A CLIENT; CONTEXT=(); SCENARIO_PORT=1234',
    'SLACK_STATE_DIR="$HOME/state"; SR8="$HOME/sr8.ts"; CONFIG="$HOME/state/config.json"; LOG="$HOME/server.log"; MEASUREMENTS="$HOME/measurements.jsonl"',
    'mkdir "$HOME/broker"; mkfifo "$HOME/broker/requests"',
    'fail() { echo "$*" >&2; exit 1; }',
    'bun() { [[ "$2" == seed ]]; echo seed >> "$HOME/trace"; }',
    'byte_mark() { echo "mark:${1##*/}" >> "$HOME/trace"; echo 0; }',
    '_scenario_proc_starttime() { if [[ "$1" == 70 ]]; then echo 101; else echo "$generation"; fi; }',
    declaration(scenario, '_scenario_placement_identity').replaceAll('/run/cscb-burst-driver-server', `${root}/broker`),
    'start_ready() { generation=$((generation + 1)); local up=0 state; if [[ "$generation" == 99 ]]; then up=1; echo pending > "$HOME/row-state"; else state="$(<"$HOME/row-state")"; if [[ "$state" == ended || "$state" == missing ]] && [[ "$mode" != no-worker ]]; then up=1; fi; echo "$up" > "$HOME/measured-worker"; fi; _scenario_placement_identity server 50; printf "20\\t99\\t%s/tmux/default\\n" "$HOME" > "$HOME/harness-tmux"; echo "start:${1:-seal}:$up" >> "$HOME/trace"; }',
    'stop_tracked_pid() { fail "seal start unexpectedly had a fixture client"; }',
    declaration(script, 'stop_clients'), declaration(script, 'clean_stop'),
    script.match(/^seal_rows_finished\(\) \{[\s\S]*?^\}/m)?.[0] ?? '',
    'stop_server() { [[ "$1" == --stop-bots && -f "$HOME/harness-clients" && ! -s "$HOME/harness-clients" ]]; echo pending > "$HOME/row-state"; echo "stop:$1" >> "$HOME/trace"; }',
    'port_closed() { echo port-closed >> "$HOME/trace"; }',
    'sr8_verdicts() { echo "verdict:$1:$2" >> "$HOME/trace"; }',
    'ad_capture() { [[ "$*" == "list --label service=cscb" ]]; AD_OUT="$HOME/ad-rows.json"; AD_RC=0; local state="$(<"$HOME/row-state")"; if [[ "$mode" == query-error ]]; then AD_RC=1; state=missing; fi; if [[ "$mode" == bad-rows ]]; then echo \'{"spawns":{}}\' > "$AD_OUT"; else printf \'{"spawns":[{"state":"%s"}]}\\n\' "$state" > "$AD_OUT"; fi; echo "ad:$state" >> "$HOME/trace"; }',
    // Virtual liveness expiry after the first read: no real delay or AD binary.
    'wait_until() { local bound="$1" step="$2" tick; shift 2; echo "barrier:$bound" >> "$HOME/trace"; for tick in 1 2 3; do if "$@"; then return 0; fi; if [[ "$mode" != pending ]]; then echo "$terminal" > "$HOME/row-state"; fi; done; fail "$step (not within ${bound}s)"; }',
    setup, '_scenario_placement_identity clients 70', 'cat "$HOME/trace"',
  ].join('\n'))
  // Fold the observed restart into fake /proc. The seal worker is gone;
  // only a successful measured launch can supply the new worker generation.
  for (const pid of [30, 60]) rmSync(join(p.proc, String(pid)), { recursive: true })
  const measured = join(root, 'measured-worker')
  if (existsSync(measured) && readFileSync(measured, 'utf8').trim() === '1') {
    p.put(30, 20, '/shard/harness', 'claude', join(root, 'alpha')); p.put(60, 20, '/shard/harness', 'sleep')
    for (const pid of [30, 60]) {
      const file = join(p.proc, String(pid), 'stat'); writeFileSync(file, readFileSync(file, 'utf8').replace(/ 99\n$/, ' 100\n'))
    }
  }
  if (child.status === 0) {
    const server = join(p.proc, '50/stat'); writeFileSync(server, readFileSync(server, 'utf8').replace(/ 99\n$/, ' 100\n'))
    personaFixtureClient(p, join(root, 'alpha'), 70, false)
    const client = join(p.proc, '70/stat'); writeFileSync(client, readFileSync(client, 'utf8').replace(/ 99\n$/, ' 101\n'))
  }
  return { p, child, measured }
}
test.each(['ended', 'missing'])('round26 restart: %s seal row finishes before the measured worker launches', terminal => {
  const { p, child } = sealRestart('valid', terminal)
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(p.run()).toMatchObject({ verdict: 'pass', stats: { persona_stubs: 1, persona_mcps: 0, persona_fixture_mcps: 1,
    harness_members: 4, server_members: 1, tmux_cgroup: '/shard/harness' } })
  expect(child.stdout.trim().split('\n')).toEqual(['seed', 'mark:server.log', 'start:seal:1', 'verdict:seal:first',
    'stop:--stop-bots', 'port-closed', 'barrier:150', 'ad:pending', `ad:${terminal}`,
    'mark:server.log', 'mark:measurements.jsonl', 'start:measured:1', 'verdict:seal:measured'])
  expect(child.stderr).toBe('')
  expect(readFileSync(join(root, 'harness-server'), 'utf8')).toBe('50\t100\n')
  expect(readFileSync(join(root, 'harness-clients'), 'utf8')).toBe('70\t101\n')
})
test('round26 restart: a genuinely absent measured worker remains missing with a finished AD row', () => {
  const { p, child } = sealRestart('no-worker')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(child.stdout).toContain('ad:missing\nmark:server.log\nmark:measurements.jsonl\nstart:measured:0')
  expect(p.run()).toMatchObject({ verdict: 'missing', stats: { persona_stubs: 0, persona_mcps: 0,
    persona_fixture_mcps: 0, harness_members: 2, server_members: 1 } })
})
test.each(['pending', 'query-error', 'bad-rows'] as const)('round26 restart: %s cannot cross the setup barrier', mode => {
  const { child, measured } = sealRestart(mode)
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(existsSync(measured)).toBe(false)
  expect(child.stderr).toContain('seal-start rows did not finish in agent-director (not within 150s)')
})

test.each(['another persona', 'unconfigured directory', 'duplicate', 'missing stub', 'unlisted', 'tree MCP', 'wrong config', 'extra argument', 'wrong script', 'missing argv terminator'] as const)
('round24 fixture MCP: %s cannot supply a silent persona MCP', fault => {
  const p = placement(); rmSync(join(p.proc, '40'), { recursive: true })
  const directory = fault === 'another persona' ? join(root, 'beta') : fault === 'unconfigured directory' ? join(root, 'elsewhere') : join(root, 'alpha')
  if (fault === 'another persona') rmSync(join(p.proc, '41'), { recursive: true })
  personaFixtureClient(p, directory)
  if (fault === 'duplicate') personaFixtureClient(p, directory, 71)
  if (fault === 'missing stub') rmSync(join(p.proc, '30'), { recursive: true })
  if (fault === 'unlisted') rmSync(join(root, 'harness-clients'))
  if (fault === 'tree MCP') p.put(40, 30, '/shard/harness', 'stub-mcp-session.ts', directory)
  const file = join(p.proc, '70/cmdline'), argv = readFileSync(file, 'utf8')
  if (fault === 'wrong config') writeFileSync(file, argv.replace('/home/.claude/slack-mcp.json', '/home/wrong.json'))
  if (fault === 'extra argument') writeFileSync(file, argv + 'extra\0')
  if (fault === 'wrong script') writeFileSync(file, argv.replace('/bin/stub-mcp-session.ts', '/elsewhere/stub-mcp-session.ts'))
  if (fault === 'missing argv terminator') writeFileSync(file, argv.slice(0, -1))
  expect(p.run().verdict).toBe('missing')
})
test.each([1, 2])('round21 client: listed script client passes beside %s persona pairs without counting as a persona', personas => {
  const p = placement(personas); fixtureClient(p)
  expect(p.run()).toMatchObject({ verdict: 'pass', stats: { persona_stubs: personas, persona_mcps: personas, harness_members: personas * 2 + 2 } })
})
test('round21 client: a listed indirect runner descendant in a persona cwd passes', () => {
  const p = placement(); p.put(69, 10, '/shard/harness', 'helper'); fixtureClient(p, 69, join(root, 'alpha'))
  expect(p.run()).toMatchObject({ verdict: 'pass', stats: { persona_stubs: 2, persona_mcps: 2, harness_members: 6 } })
})
test('round21 client: multiple recorded clients count only as harness members', () => {
  const p = placement(); fixtureClient(p); p.put(71, 11, '/shard/harness', 'stub-mcp-session.ts', join(root, 'beta'))
  writeFileSync(join(root, 'harness-clients'), '70\t99\n71\t99\n')
  expect(p.run()).toMatchObject({ verdict: 'pass', stats: { persona_stubs: 2, persona_mcps: 2, harness_members: 7 } })
})
test('round21 client: shared identity writer appends clients and stop_clients clears them before restart', () => {
  const script = readFileSync(join(import.meta.dir, 'integration/test-44-fmk-thread-burst.sh'), 'utf8')
  const writer = declaration(scenario, '_scenario_placement_identity').replace('/run/cscb-burst-driver-server/requests', '"$HOME/requests"')
  const child = shell([
    'mkfifo "$HOME/requests"', 'fail() { echo "$*" >&2; exit 1; }',
    '_scenario_proc_starttime() { printf "%s\\n" "$((100 + $1))"; }', writer,
    '_scenario_placement_identity server 50; _scenario_placement_identity slack 12',
    '_scenario_placement_identity clients 70; _scenario_placement_identity clients 71',
    'cat "$HOME/harness-server" "$HOME/harness-slack" "$HOME/harness-clients"',
    'declare -A CLIENT=([alpha]=70 [beta]=71); KEYS=(alpha beta)',
    'stop_tracked_pid() { printf "stopped=%s\\n" "$1"; }', declaration(script, 'stop_clients'),
    'stop_clients; [[ ! -s "$HOME/harness-clients" && ${#CLIENT[@]} == 0 ]]',
    '_scenario_placement_identity clients 72; cat "$HOME/harness-clients"',
  ].join('\n'))
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(child.stdout).toBe('50\t150\n12\t112\n70\t170\n71\t171\nstopped=70\nstopped=71\n72\t172\n')
})
test.each(['unlisted', 'server group', 'server tree', 'unrelated parent', 'unreadable stat', 'exited', 'reused', 'zombie', 'wrong entry'] as const)
('round21 client: %s fixture client is missing', fault => {
  const p = placement(); fixtureClient(p)
  if (fault === 'unlisted') rmSync(join(root, 'harness-clients'))
  if (fault === 'server group') writeFileSync(join(p.proc, '70/cgroup'), '0::/shard/server\n')
  if (fault === 'server tree') { rmSync(join(p.proc, '70'), { recursive: true }); fixtureClient(p, 50) }
  if (fault === 'unrelated parent') { rmSync(join(p.proc, '70'), { recursive: true }); fixtureClient(p, 1) }
  if (fault === 'unreadable stat') rmSync(join(p.proc, '70/stat'))
  if (fault === 'exited') rmSync(join(p.proc, '70'), { recursive: true })
  if (fault === 'reused') writeFileSync(join(root, 'harness-clients'), '70\t98\n')
  if (fault === 'zombie') writeFileSync(join(p.proc, '70/stat'), readFileSync(join(p.proc, '70/stat'), 'utf8').replace(') S ', ') Z '))
  if (fault === 'wrong entry') writeFileSync(join(p.proc, '70/cmdline'), '/bin/tool\0/helper\0')
  expect(p.run().verdict).toBe('missing')
})
test.each(['70 99\n', '70\t99', '70\t99\textra\n', '0\t99\n', '70\tx\n', '70\t99\n\n', '70\t99\n70\t99\n'])
('round21 client: malformed identity list %j is missing', rows => {
  const p = placement(); fixtureClient(p); writeFileSync(join(root, 'harness-clients'), rows)
  expect(p.run().verdict).toBe('missing')
})
test('round21 client: an empty list after stop preserves the original placement verdict', () => {
  const p = placement(); writeFileSync(join(root, 'harness-clients'), '')
  expect(p.run()).toMatchObject({ verdict: 'pass', stats: { persona_stubs: 2, persona_mcps: 2, harness_members: 5 } })
})
// This client's argv lacks the config/directory pair required by decision 14.
test('round21 client: a non-qualifying listed client in the persona cwd cannot replace its missing tmux MCP', () => {
  const p = placement(); fixtureClient(p, 11, join(root, 'alpha')); rmSync(join(p.proc, '40'), { recursive: true })
  expect(p.run()).toMatchObject({ verdict: 'missing', stats: { persona_stubs: 2, persona_mcps: 1 } })
})
test('harness placement: two personas and MCP clients pass with the runner, script and recorded tmux', () => {
  const p = placement(), row = p.run()
  expect(row.verdict).toBe('pass')
  expect(row.stats).toMatchObject({ runner_cgroup: '/shard/harness', script_cgroup: '/shard/harness', tmux_cgroup: '/shard/harness', persona_stubs: 2, persona_mcps: 2 })
})
test.each([10, 11, 20, 30, 31, 40, 41])('harness placement: member %s in the server group is missing', pid => {
  const p = placement(); writeFileSync(join(p.proc, String(pid), 'cgroup'), '0::/shard/server\n')
  expect(p.run().verdict).toBe('missing')
})
test('harness placement: a lost tmux server during the measured run is missing', () => {
  const p = placement(); rmSync(join(p.proc, '20'), { recursive: true })
  expect(p.run().verdict).toBe('missing')
})
test.each(['claude', 'stub-mcp-session.ts'])('harness placement: a misplaced duplicate %s is not hidden by the valid pair', entry => {
  const p = placement(); p.put(60, 50, '/shard/server', entry, join(root, 'alpha'))
  expect(p.run().verdict).toBe('missing')
})
function placementCLI(p: ReturnType<typeof placement>, instrument?: (source: string) => string) {
  const cg = join(root, 'cgroup'), file = join(root, 'evidence.ts')
  const put = (path: string, text: string) => { const target = join(cg, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, text, { mode: 0o444 }) }
  for (const [path, max] of Object.entries(p.limits)) put(`${path}/cpu.max`, max + '\n')
  put('shard/server/cpu.max', '200000 100000\n'); put('shard/driver/cpu.max', '90000 100000\n')
  for (const path of ['', 'shard', 'shard/server', 'shard/driver', 'shard/harness']) {
    put(`${path}/cgroup.procs`, ''); put(`${path}/cpu.stat`, 'usage_usec 0\nnr_periods 0\nnr_throttled 0\nthrottled_usec 0\n')
  }
  writeFileSync(join(root, 'record'), '/shard/driver\n')
  const original = readFileSync(join(fixtures, 'sr8-evidence.ts'), 'utf8')
  const source = original.replace("existsSync('/etc/cscb-ci-image')", 'true')
    .replace("const CGROUP_ROOT = '/sys/fs/cgroup'", `const CGROUP_ROOT = ${JSON.stringify(cg)}`)
    .replace("const HARNESS_PROC_ROOT = '/proc'", `const HARNESS_PROC_ROOT = ${JSON.stringify(p.proc)}`)
    .replace('textFile(`/proc/${pid}/cgroup`)', `textFile(join(${JSON.stringify(p.proc)}, String(pid), 'cgroup'))`)
  writeFileSync(file, instrument ? instrument(source) : source)
  return () => spawnSync(process.execPath, [file, 'driver-cpu', 'test-placement', 'strict', '0', String(p.personas), '50', join(root, 'record')], {
    env: hostSafeChildEnv(root, { tools: [], extras: { SCENARIO_ROOT: root, SLACK_STATE_DIR: p.state } }), encoding: 'utf8', timeout: 5000,
  })
}
test.skipIf(process.getuid?.() === 0)('real driver-cpu CLI requires the new placement evidence as well as quota and permissions', () => {
  const p = placement(), run = placementCLI(p)
  const good = run()
  expect(good.error).toBeUndefined(); expect(good.status).toBe(0)
  expect(good.stdout).toContain('limit=2 verdict=pass harness_cgroup=/shard/harness')
  expect(good.stdout).toContain('persona_stubs=2 persona_mcps=2 harness_members=5')
  rmSync(join(p.proc, '20'), { recursive: true })
  const lost = run()
  expect(lost.status).toBe(1); expect(lost.stdout).toContain('limit=2 verdict=missing')
})
test.each(['max 100000', '200000 100000'])('harness placement: harness quota %s is missing', quota => {
  const p = placement(); p.limits['/shard/harness'] = quota
  expect(p.run().verdict).toBe('missing')
})
test.each([['Slack stub', 12, '/shard/server'], ['server child', 51, '/shard/harness']] as const)
('round17 regression: combined CLI rejects misplaced %s', (_name, pid, group) => {
  const p = placement(), run = placementCLI(p)
  expect(run().status).toBe(0)
  writeFileSync(join(p.proc, String(pid), 'cgroup'), `0::${group}\n`)
  const bad = run(); expect(bad.status).toBe(1); expect(bad.stdout).toContain('limit=2 verdict=missing')
})
test.each(['stat', 'cwd', 'cmdline', 'all'])('round17 regression: unreadable relevant %s cannot hide a duplicate beside valid pairs', field => {
  const p = placement(), run = placementCLI(p)
  expect(run().status).toBe(0)
  p.put(60, 50, '/shard/server', 'claude', join(root, 'alpha'))
  for (const name of field === 'all' ? ['stat', 'cwd', 'cmdline', 'cgroup'] : [field]) rmSync(join(p.proc, '60', name))
  const bad = run(); expect(bad.status).toBe(1); expect(bad.stdout).toContain('limit=2 verdict=missing')
})
test('unrelated inaccessible or vanished proc metadata does not fail the placement control', () => {
  const p = placement()
  p.put(70, 1, '/', 'unrelated', '/elsewhere')
  rmSync(join(p.proc, '70/cwd')); rmSync(join(p.proc, '70/cmdline'))
  symlinkSync(join(root, 'vanished-process'), join(p.proc, '71')) // stale entry, metadata already gone
  expect(p.run().verdict).toBe('pass')
})
test.each([['tmux', 20], ['server', 50], ['slack', 12]] as const)('harness reasons: reused %s identity stays missing', (role, pid) => {
  const p = placement()
  const path = join(root, `harness-${role}`), saved = readFileSync(path, 'utf8')
  writeFileSync(path, saved.replace(`${pid}\t99`, `${pid}\t98`))
  const bad = p.run()
  expect(bad.verdict).toBe('missing')
  expect(bad.stats.placement_reason).toBe(`invalid-identity:${role}`)
  writeFileSync(path, saved)
  const good = p.run()
  expect(good.verdict).toBe('pass')
  expect(good.stats.placement_reason).toBe('none')
})
test.each((['server', 'slack'] as const).flatMap(role =>
  (['absent', 'unreadable', 'malformed', 'zombie'] as const).map(fault => [role, fault] as const)))
('harness reasons: %s record with %s stays missing', (role, fault) => {
  const p = placement(), path = join(root, `harness-${role}`)
  if (fault === 'absent' || fault === 'unreadable') rmSync(path)
  if (fault === 'unreadable') mkdirSync(path)
  if (fault === 'malformed') writeFileSync(path, 'not-an-identity\n')
  if (fault === 'zombie') {
    const stat = join(p.proc, role === 'server' ? '50/stat' : '12/stat')
    writeFileSync(stat, readFileSync(stat, 'utf8').replace(') S ', ') Z '))
  }
  const row = p.run()
  expect(row.verdict).toBe('missing')
  expect(row.stats.placement_reason).toBe(`${fault === 'malformed' ? 'malformed-record'
    : fault === 'zombie' ? 'invalid-identity' : 'unreadable-record'}:${role}`)
})
test('harness reasons: an unreadable tmux socket stays missing', () => {
  const p = placement()
  writeFileSync(join(root, 'harness-tmux'), `20\t99\t${join(root, 'tmux/absent')}\n`)
  const row = p.run()
  expect(row.verdict).toBe('missing')
  expect(row.stats.placement_reason).toBe('invalid-record:tmux')
})
test('harness reasons: unexpected scan exceptions use a neutral reason', () => {
  const p = placement()
  writeFileSync(join(p.state, 'config.json'), '{invalid-json')
  const row = p.run()
  expect(row.verdict).toBe('missing')
  expect(row.stats.placement_reason).toBe('exception:scan')
})

type ScanBoundary = 'group' | 'cwd' | 'cmdline' | 'stat' | 'identity' | 'tmux-loop' | 'candidate-identity' | 'required-identity' | 'final-identity'
type ScanMutation = 'vanished' | 'unreadable' | 'reused' | 'zombie' | 'reused-zombie' | 'reused-exit' | 'wrong-group-exit'
  | 'group-move' | 'reparented' | 'exec-changed' | 'server-parent' | 'caller-move'
  | 'fixture-config-change' | 'fixture-dir-change' | 'fixture-extra-arg'
  | 'tmux-parent'
  | 'exiting' | 'exiting-vanished' | 'exiting-reused' | 'exiting-reused-zombie' | 'exiting-reused-exit' | 'exiting-live'
  | 'exiting-late-reuse-exit' | 'exiting-late-reuse-zombie'
  | 'exiting-budget-repeat'
// Only copied CLI file reads are instrumented. No global fs mocks or collector
// API changes: the same read boundaries exist in the before fixture.
function scanMutation(p: ReturnType<typeof placement>, pid: number, boundary: ScanBoundary,
  mutation: ScanMutation, groupRead = 1, wrongGroup = '/shard/server') {
  const dir = join(p.proc, String(pid)), marker = join(root, 'scan-fired')
  return (source: string) => {
    const imports = 'readFileSync, readlinkSync,'
    expect(source.split(imports)).toHaveLength(2)
    if (boundary === 'final-identity') {
      const anchor = '    const fixtureMcps = new Set<string>()'
      expect(source.split(anchor)).toHaveLength(2)
      source = source.replace(anchor, `    scanFinal=true;\n${anchor}`)
    }
    return `import { rmSync as removeProcess, writeFileSync as traceProcess } from 'node:fs';
let scanGroups=0, scanIdentities=0, scanCommand=false, scanFired=false, scanFinal=false, scanRemoveAfter='', scanExitStat='', scanExitReads=0;
function scanRead(path, link=false) {
  path=String(path);
  const dir=${JSON.stringify(dir)}, boundary=${JSON.stringify(boundary)}, mutation=${JSON.stringify(mutation)};
  if(scanExitStat && mutation==='exiting-budget-repeat') {
    if(path===dir+'/stat' && ++scanExitReads===11) traceProcess(dir+'/stat',scanExitStat.replace(') S ',') Z '));
    if(path===dir+'/cgroup' && scanGroups===1) {
      traceProcess(dir+'/stat',scanExitStat); scanExitStat='';
    }
  }
  if(scanExitStat && path===dir+'/stat' && mutation.startsWith('exiting-late-reuse')) {
    const read=++scanExitReads;
    traceProcess(${JSON.stringify(join(root, 'scan-polled'))},String(read));
    if(read===1) traceProcess(dir+'/stat',scanExitStat);
    if(read===2) {
      let next=scanExitStat.replace(/99\\n$/,'100\\n');
      if(mutation==='exiting-late-reuse-zombie') next=next.replace(') S ',') Z ');
      traceProcess(dir+'/stat',next);
    }
    if(read===3) { removeProcess(dir,{recursive:true}); scanExitStat=''; }
  }
  if(scanExitStat && path===dir+'/stat' && !mutation.startsWith('exiting-late-reuse') && mutation!=='exiting-budget-repeat' && ++scanExitReads===2 && mutation!=='exiting-live') {
    traceProcess(${JSON.stringify(join(root, 'scan-polled'))},'yes');
    let next=mutation.includes('reused') ? scanExitStat.replace(/99\\n$/,'100\\n') : scanExitStat;
    if(mutation==='exiting' || mutation==='exiting-reused-zombie') next=next.replace(') S ',') Z ');
    traceProcess(dir+'/stat',next); scanExitStat='';
    if(mutation==='exiting-vanished') removeProcess(dir,{recursive:true});
    if(mutation==='exiting-reused-exit') scanRemoveAfter=path;
  }
  if(path===dir+'/cgroup') scanGroups++;
  const fire=!scanFired && (
    (boundary==='group' && path===dir+'/cgroup' && scanGroups===${groupRead}) ||
    (boundary==='tmux-loop' && path===dir+'/cgroup' && scanGroups===1) ||
    (boundary==='cwd' && link && path===dir+'/cwd') ||
    (boundary==='cmdline' && path===dir+'/cmdline') ||
    (boundary==='stat' && path===dir+'/stat') ||
    (boundary==='identity' && scanCommand && path===dir+'/stat') ||
    (boundary==='candidate-identity' && scanGroups>=3 && path===dir+'/stat') ||
    (boundary==='required-identity' && scanCommand && path===dir+'/stat' && ++scanIdentities===2) ||
    (boundary==='final-identity' && scanFinal && path===dir+'/stat'));
  if(path===dir+'/cmdline') scanCommand=true;
  if(!fire) return;
  scanFired=true; traceProcess(${JSON.stringify(marker)},'yes');
  if(mutation==='vanished') removeProcess(dir,{recursive:true});
  else if(mutation.startsWith('exiting')) {
    scanExitStat=originalReadFileSync(dir+'/stat','utf8');
    removeProcess(dir+'/cwd'); traceProcess(dir+'/cmdline',''); removeProcess(dir+'/cgroup');
    if(['stat','identity','candidate-identity'].includes(boundary)) removeProcess(dir+'/stat');
  }
  else if(mutation==='unreadable') removeProcess(path);
  else if(mutation==='group-move') traceProcess(dir+'/cgroup','0::/shard/server\\n');
  else if(mutation==='exec-changed') traceProcess(dir+'/cmdline','/bin/tool\\0/helper\\0');
  else if(mutation==='tmux-parent') traceProcess(dir+'/stat',originalReadFileSync(dir+'/stat','utf8').replace(/\\) S \\d+ /,') S 30 '));
  else if(mutation.startsWith('fixture-')) {
    const old=originalReadFileSync(dir+'/cmdline','utf8');
    const next=mutation==='fixture-config-change' ? old.replace('/home/.claude/slack-mcp.json','/home/wrong.json')
      : mutation==='fixture-dir-change' ? old.replace(${JSON.stringify(join(root, 'alpha'))},${JSON.stringify(join(root, 'beta'))}) : old+'extra\\0';
    traceProcess(dir+'/cmdline',next);
  }
  else if(mutation==='caller-move') traceProcess(${JSON.stringify(join(p.proc, '11/cgroup'))},'0::/shard/server\\n');
  else if(mutation==='reparented' || mutation==='server-parent') {
    const old=originalReadFileSync(dir+'/stat','utf8');
    traceProcess(dir+'/stat',old.replace(/\\) S \\d+ /,') S '+(mutation==='server-parent' ? '50' : '1')+' '));
  }
  else if(mutation==='wrong-group-exit') {
    traceProcess(dir+'/cgroup',${JSON.stringify(`0::${wrongGroup}\n`)}); scanRemoveAfter=path;
  }
  else {
    const old=originalReadFileSync(dir+'/stat','utf8');
    let next=mutation==='zombie' ? old : old.replace(/99\\n$/,'100\\n');
    if(mutation==='zombie' || mutation==='reused-zombie') next=next.replace(') S ',') Z ');
    traceProcess(dir+'/stat',next);
    if(mutation==='reused-exit') scanRemoveAfter=path;
  }
}
function scanAfter(path,value) {
  if(scanRemoveAfter && scanRemoveAfter===String(path)) {
    scanRemoveAfter=''; removeProcess(${JSON.stringify(dir)},{recursive:true});
  }
  return value;
}
const readFileSync=(...args)=>{scanRead(args[0]); return scanAfter(args[0],originalReadFileSync(...args))};
const readlinkSync=(...args)=>{scanRead(args[0],true); return scanAfter(args[0],originalReadlinkSync(...args))};
` + source.replace(imports, 'readFileSync as originalReadFileSync, readlinkSync as originalReadlinkSync,')
  }
}
test.each(([['server', 50], ['slack', 12], ['runner', 10], ['script', 11], ['tmux', 20], ['fixture-client', 70]] as const)
  .flatMap(([role, pid]) => (['reused', 'zombie'] as const).map(mutation => [role, pid, mutation] as const)))
('harness reasons: final %s PID %d identity with %s stays missing', (role, pid, mutation) => {
  const p = placement(); if (pid === 70) fixtureClient(p)
  expect(p.run().verdict).toBe('pass')
  const child = placementCLI(p, scanMutation(p, pid, 'final-identity', mutation))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
  expect(child.stdout).toContain(`placement_reason=${mutation === 'reused' ? 'changed-start' : 'zombie'}:${role}\n`)
})
test.each([['unreadable', 'unreadable-stat'], ['fixture-config-change', 'fixture-argv'],
  ['fixture-dir-change', 'fixture-directory'], ['group-move', 'invalid-placement']] as const)
('harness reasons: final fixture %s stays missing', (mutation, reason) => {
  const p = placement(); rmSync(join(p.proc, '40'), { recursive: true }); personaFixtureClient(p)
  expect(p.run().verdict).toBe('pass')
  const child = placementCLI(p, scanMutation(p, 70, 'final-identity', mutation))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
  expect(child.stdout).toContain(`placement_reason=${reason}:fixture-client\n`)
})
test('harness reasons: final fixture with an existing tree MCP stays missing', () => {
  const p = placement(); personaFixtureClient(p)
  const row = p.run()
  expect(row.verdict).toBe('missing')
  expect(row.stats.placement_reason).toBe('incomplete-pair:fixture-client')
})
test('harness reasons: final ordinary fixture argv failure stays missing', () => {
  const p = placement(); fixtureClient(p)
  expect(p.run().verdict).toBe('pass')
  const child = placementCLI(p, scanMutation(p, 70, 'final-identity', 'exec-changed'))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
  expect(child.stdout).toContain('placement_reason=fixture-argv:fixture-client\n')
})
// Replace only the copied collector's clock and sleep. Trace calls as well as
// sleeps so a second validation boundary must share the first PID's deadline.
function pollClock(source: string) {
  const start = source.indexOf('export function harnessCpuEvidence('), end = source.indexOf('\nexport ', start + 1)
  expect(start).toBeGreaterThanOrEqual(0)
  const collector = source.slice(start, end < 0 ? undefined : end)
  expect(collector.split('performance.now()')).toHaveLength(4)
  expect(collector.split('Bun.sleepSync(')).toHaveLength(2)
  const anchor = '    stats.slack_cgroup = group(slack.pid)'
  expect(collector.split(anchor)).toHaveLength(2)
  const instrumented = collector.replaceAll('performance.now()', 'pollNow')
    .replace('Bun.sleepSync(', 'pollSleep(member, ')
    .replace('const waitForExit = (', 'const pollForExit = (')
    .replace(anchor, `    const waitForExit = (...args) => {
      const started = pollNow, exited = pollForExit(...args);
      pollCalls.push({ pid: args[0], started, ended: pollNow, exited }); savePollClock();
      return exited;
    };
${anchor}`)
  return `import { writeFileSync as writePollClock } from 'node:fs';
let pollNow=0;
const pollSleeps=[], pollCalls=[];
function savePollClock() { writePollClock(${JSON.stringify(join(root, 'poll-clock.json'))},JSON.stringify({now:pollNow,sleeps:pollSleeps,calls:pollCalls})); }
function pollSleep(pid,ms) { pollSleeps.push({pid,ms}); pollNow+=ms; savePollClock(); }
savePollClock();
` + source.slice(0, start) + instrumented + (end < 0 ? '' : source.slice(end))
}
function readPollClock() {
  return JSON.parse(readFileSync(join(root, 'poll-clock.json'), 'utf8')) as {
    now: number; sleeps: { pid: number; ms: number }[]; calls: { pid: number; started: number; ended: number; exited: boolean }[]
  }
}
test.each((['identity', 'required-identity'] as const).flatMap(boundary =>
  (['vanished', 'unreadable', 'reused', 'zombie', 'reused-zombie'] as const).map(mutation => [boundary, mutation] as const)))
('round21 client: required fixture at %s with %s stays missing', (boundary, mutation) => {
  const p = placement(); fixtureClient(p)
  const child = placementCLI(p, scanMutation(p, 70, boundary, mutation))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
})
test.each((['identity', 'required-identity'] as const).flatMap(boundary =>
  (['group-move', 'reparented', 'exec-changed', 'server-parent', 'caller-move'] as const).map(mutation => [mutation, boundary] as const)))
('round22 client freshness: %s at %s stays missing', (mutation, boundary) => {
  const p = placement(); p.put(69, 11, '/shard/harness', 'helper'); fixtureClient(p, 69)
  expect(p.run().verdict).toBe('pass')
  const child = placementCLI(p, scanMutation(p, 70, boundary, mutation))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(readFileSync(join(p.proc, '70/stat'), 'utf8')).toEndWith(' 99\n')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
})
test.each((['identity', 'required-identity'] as const).flatMap(boundary =>
  (['fixture-config-change', 'fixture-dir-change', 'fixture-extra-arg'] as const).map(mutation => [mutation, boundary] as const)))
('round24 fixture MCP: %s at %s stays missing', (mutation, boundary) => {
  const p = placement(); rmSync(join(p.proc, '40'), { recursive: true }); personaFixtureClient(p)
  expect(p.run().verdict).toBe('pass')
  const child = placementCLI(p, scanMutation(p, 70, boundary, mutation))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
})
test.each(['identity', 'required-identity'] as const)('round24 fixture MCP: reparent into tmux at %s stays missing', boundary => {
  const p = placement(); rmSync(join(p.proc, '40'), { recursive: true }); personaFixtureClient(p)
  writeFileSync(join(p.proc, '20/stat'), readFileSync(join(p.proc, '20/stat'), 'utf8').replace(') S 1 ', ') S 11 '))
  expect(p.run().verdict).toBe('pass')
  const child = placementCLI(p, scanMutation(p, 70, boundary, 'tmux-parent'))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(readFileSync(join(p.proc, '70/stat'), 'utf8')).toEndWith(' 99\n')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
})
const scanCases = (['server child', 'harness helper'] as const).flatMap(role =>
  (['group', 'cwd', 'cmdline', 'identity', 'tmux-loop'] as const).map(boundary => [role, boundary] as const))
function scanPlacement(role: 'server child' | 'harness helper', boundary: ScanBoundary) {
  const p = placement(), inTmux = role === 'harness helper' || boundary === 'tmux-loop'
  if (role === 'server child' && boundary === 'tmux-loop') {
    // Exercise the allowed server -> owned tmux -> harness subtree exception.
    writeFileSync(join(p.proc, '20/stat'), `20 (tmux) S 50 ${Array(17).fill('0').join(' ')} 99\n`)
  }
  p.put(60, inTmux ? 20 : 50, inTmux ? '/shard/harness' : '/shard/server', 'helper')
  expect(p.run().verdict).toBe('pass')
  return { p, groupRead: inTmux ? 2 : 1 }
}
const exitingCases = (['server child', 'harness helper'] as const).flatMap(role =>
  (['cwd', 'cmdline', 'group', 'identity', 'tmux-loop'] as const).flatMap(boundary =>
    (['exiting', 'exiting-vanished'] as const).map(mutation => [role, boundary, mutation] as const)))
test.each(exitingCases)('exit race: %s at %s waits for %s', (role, boundary, mutation) => {
  const { p, groupRead } = scanPlacement(role, boundary)
  const child = placementCLI(p, scanMutation(p, 60, boundary, mutation, groupRead))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined()
  expect({ status: child.status, stdout: child.stdout, stderr: child.stderr }).toMatchObject({ status: 0, stderr: '' })
  expect(readFileSync(join(root, 'scan-polled'), 'utf8')).toBe('yes')
  expect(child.stdout).toContain('recorded: sr8 driver-cpu ')
  expect(child.stdout).toContain('limit=2 verdict=pass')
  expect(child.stdout).toContain('persona_stubs=2 persona_mcps=2')
  expect(child.stdout).toContain('placement_reason=none')
})
test('exit race: initially unreadable stat waits for the process directory to disappear', () => {
  const { p } = scanPlacement('harness helper', 'stat')
  const child = placementCLI(p, scanMutation(p, 60, 'stat', 'exiting-vanished'))()
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(readFileSync(join(root, 'scan-polled'), 'utf8')).toBe('yes')
  expect(child.stdout).toContain('persona_stubs=2 persona_mcps=2')
  expect(child.stdout).toContain('placement_reason=none')
})
test.each(['exiting-late-reuse-exit', 'exiting-late-reuse-zombie'] as const)
('exit race: initially unreadable stat with %s stays missing beside complete pairs', mutation => {
  const { p } = scanPlacement('harness helper', 'stat')
  const child = placementCLI(p, scanMutation(p, 60, 'stat', mutation))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined()
  expect({ status: child.status, stdout: child.stdout, stderr: child.stderr }).toMatchObject({ status: 1, stderr: '' })
  expect(readFileSync(join(root, 'scan-polled'), 'utf8')).toBe('2')
  expect(child.stdout).toContain('limit=2 verdict=missing')
  expect(child.stdout).toContain('placement_reason=unreadable-stat:process-candidate')
})
test.each((['server child', 'harness helper'] as const).flatMap(role =>
  (['exiting-reused', 'exiting-reused-zombie', 'exiting-reused-exit'] as const).map(mutation => [role, mutation] as const)))
('exit race: %s with %s during polling stays missing', (role, mutation) => {
  const { p, groupRead } = scanPlacement(role, 'cwd')
  const child = placementCLI(p, scanMutation(p, 60, 'cwd', mutation, groupRead))()
  expect(readFileSync(join(root, 'scan-polled'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
  expect(child.stdout).toMatch(/placement_reason=(?!none\b)\S+/)
})
test.each([['persona stub', 30], ['persona MCP', 40]] as const)
('exit race: the only %s exiting during collection stays missing', (_role, pid) => {
  const p = placement(), child = placementCLI(p, scanMutation(p, pid, 'cwd', 'exiting'))()
  expect(readFileSync(join(root, 'scan-polled'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
  expect(child.stdout).toContain('placement_reason=incomplete-pair:persona')
})
test.each(['claude', 'stub-mcp-session.ts'] as const)
('exit race: final %s candidate can exit when another complete pair remains', entry => {
  const p = duplicatePlacement(entry)
  const child = placementCLI(p, scanMutation(p, 60, 'group', 'exiting', 3))()
  expect(readFileSync(join(root, 'scan-polled'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(child.stdout).toContain('persona_stubs=2 persona_mcps=2')
  expect(child.stdout).toContain('placement_reason=none')
})
test.each([['server', 50, 'unreadable-fields:server'], ['Slack', 12, 'unreadable-fields:slack'],
  ['tmux', 20, 'unreadable-fields:tmux'], ['runner', 10, 'unreadable-fields:runner'],
  ['script', 11, 'unreadable-fields:script'], ['fixture client', 70, 'invalid-placement:fixture-client']] as const)
('exit race: required %s keeps its immediate unreadability failure', (_role, pid, reason) => {
  const p = placement(); if (pid === 70) fixtureClient(p)
  const mutate = scanMutation(p, pid, 'cwd', 'exiting')
  const child = placementCLI(p, source => pollClock(mutate(source)))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(existsSync(join(root, 'scan-polled'))).toBe(false)
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
  expect(child.stdout).toContain(`placement_reason=${reason}\n`)
  expect(readPollClock()).toMatchObject({ now: 0, sleeps: [] })
})
test('exit race: a live unreadable helper polls once within the time bound and stays missing', () => {
  const { p } = scanPlacement('harness helper', 'cwd')
  const mutate = scanMutation(p, 60, 'cwd', 'exiting-live')
  const child = placementCLI(p, source => pollClock(mutate(source)))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('placement_reason=unreadable-fields:tmux-tree')
  expect(child.stdout).toContain('limit=2 verdict=missing')
  expect(readPollClock()).toEqual({ now: 200, sleeps: Array.from({ length: 20 }, () => ({ pid: 60, ms: 10 })),
    calls: [{ pid: 60, started: 0, ended: 200, exited: false }] })
})
test('exit race: healthy members take zero poll sleeps', () => {
  const p = placement(); fixtureClient(p)
  const child = placementCLI(p, pollClock)()
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(child.stdout).toContain('limit=2 verdict=pass')
  expect(child.stdout).toContain('persona_stubs=2 persona_mcps=2')
  expect(child.stdout).toContain('placement_reason=none')
  expect(readPollClock()).toEqual({ now: 0, sleeps: [], calls: [] })
})
test.each([['helper', 'unreadable-fields:process-candidate'], ['claude', 'invalid-placement:persona-candidate'],
  ['stub-mcp-session.ts', 'invalid-placement:persona-candidate']] as const)
('exit race: an unclassified %s has an accurate fallback role', (entry, reason) => {
  const p = placement(); p.put(60, 1, '/shard/harness', entry)
  rmSync(join(p.proc, '60/cwd'))
  const child = placementCLI(p, pollClock)()
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
  expect(child.stdout).toContain(`placement_reason=${reason}\n`)
})
test('exit race: distinct PIDs each receive their own 200 ms budget', () => {
  const p = placement()
  for (const pid of [60, 61]) p.put(pid, 50, '/shard/server', 'helper')
  expect(p.run().verdict).toBe('pass')
  // Both entries become unreadable on their own cwd read. At the last poll
  // stat read, each exits; the second must get a fresh full budget.
  const mutate = (source: string) => {
    for (const pid of [60, 61]) {
      const dir = join(p.proc, String(pid))
      source = source.replace('  path=String(path);', `  path=String(path);
  if(path===${JSON.stringify(dir + '/cwd')}) removeProcess(path,{force:true});
  if(path===${JSON.stringify(dir + '/stat')} && pollSleeps.filter(s=>s.pid===${pid}).length===20) removeProcess(${JSON.stringify(dir)},{recursive:true,force:true});`)
    }
    return source
  }
  const reads = scanMutation(p, 999, 'cwd', 'exiting-live')
  const child = placementCLI(p, source => pollClock(mutate(reads(source))))()
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(child.stdout).toContain('limit=2 verdict=pass')
  expect(child.stdout).toContain('persona_stubs=2 persona_mcps=2')
  expect(child.stdout).toContain('placement_reason=none')
  const clock = readPollClock(), order = clock.calls.map(call => call.pid)
  expect([...order].sort((a, b) => a - b)).toEqual([60, 61])
  expect(clock).toEqual({ now: 400,
    sleeps: order.flatMap(pid => Array.from({ length: 20 }, () => ({ pid, ms: 10 }))),
    calls: order.map((pid, index) => ({ pid, started: index * 200, ended: (index + 1) * 200, exited: true })) })
})
test('exit race: repeated boundaries reuse the same PID budget', () => {
  const { p } = scanPlacement('harness helper', 'tmux-loop')
  const mutate = scanMutation(p, 60, 'tmux-loop', 'exiting-budget-repeat')
  const child = placementCLI(p, source => pollClock(mutate(source)))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
  expect(child.stdout).toContain('placement_reason=unreadable-fields:tmux-tree')
  expect(readPollClock()).toEqual({ now: 200, sleeps: Array.from({ length: 20 }, () => ({ pid: 60, ms: 10 })),
    calls: [{ pid: 60, started: 0, ended: 100, exited: true }, { pid: 60, started: 100, ended: 200, exited: false }] })
})
test.each(scanCases)('round18 disappearance: %s exits at %s read', (role, boundary) => {
  const { p, groupRead } = scanPlacement(role, boundary)
  const child = placementCLI(p, scanMutation(p, 60, boundary, 'vanished', groupRead))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  expect(child.stdout).toContain('limit=2 verdict=pass')
  expect(child.stdout).toContain('persona_stubs=2 persona_mcps=2 harness_members=5')
})
test.each(scanCases)('persistent unreadable %s at %s stays missing', (role, boundary) => {
  const { p, groupRead } = scanPlacement(role, boundary)
  const child = placementCLI(p, scanMutation(p, 60, boundary, 'unreadable', groupRead))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.status).toBe(1); expect(child.stdout).toContain('limit=2 verdict=missing')
})
test.each(scanCases)('persistent reused %s at %s stays missing', (role, boundary) => {
  const { p, groupRead } = scanPlacement(role, boundary)
  const child = placementCLI(p, scanMutation(p, 60, boundary, 'reused', groupRead))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.status).toBe(1); expect(child.stdout).toContain('limit=2 verdict=missing')
})
test.each(['server child', 'harness helper'] as const)('round18 disappearance: exited zombie %s at identity recheck is skipped', role => {
  const { p } = scanPlacement(role, 'identity')
  const child = placementCLI(p, scanMutation(p, 60, 'identity', 'zombie'))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.status).toBe(0); expect(child.stdout).toContain('limit=2 verdict=pass')
})
test.each([['server', 50], ['Slack stub', 12], ['tmux', 20], ['persona stub', 30], ['persona MCP', 40]] as const)
('required %s lost during metadata collection is still missing', (_name, pid) => {
  const p = placement(), child = placementCLI(p, scanMutation(p, pid, 'cwd', 'vanished'))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.status).toBe(1); expect(child.stdout).toContain('limit=2 verdict=missing')
})
test.each([30, 40])('required persona member %s lost at final pair validation is missing', pid => {
  const p = placement(), child = placementCLI(p, scanMutation(p, pid, 'group', 'vanished', 3))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.status).toBe(1); expect(child.stdout).toContain('limit=2 verdict=missing')
})
test.each([
  ['server-tree main loop', 'server child', 'group', '/shard/harness'],
  ['tmux-descendant main loop', 'harness helper', 'group', '/shard/server'],
  ['tmux-descendant group loop', 'harness helper', 'tmux-loop', '/shard/server'],
] as const)('round19 contradiction: wrong group then exit in %s stays missing', (_where, role, boundary, wrongGroup) => {
  const { p, groupRead } = scanPlacement(role, boundary)
  const child = placementCLI(p, scanMutation(p, 60, boundary, 'wrong-group-exit', groupRead, wrongGroup))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
})
const reuseExitCases = (['server child', 'harness helper'] as const).flatMap(role =>
  (['reused-zombie', 'reused-exit'] as const).map(mutation => [role, mutation] as const))
test.each(reuseExitCases)('round19 contradiction: %s with %s in main loop stays missing', (role, mutation) => {
  const { p } = scanPlacement(role, 'identity')
  const child = placementCLI(p, scanMutation(p, 60, 'identity', mutation))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
})
test('round19 contradiction: changed-start zombie in tmux group loop stays missing', () => {
  const { p } = scanPlacement('harness helper', 'tmux-loop')
  const child = placementCLI(p, scanMutation(p, 60, 'tmux-loop', 'reused-zombie'))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.status).toBe(1); expect(child.stdout).toContain('limit=2 verdict=missing')
})
function duplicatePlacement(entry: 'claude' | 'stub-mcp-session.ts') {
  const p = placement()
  p.put(60, 20, '/shard/harness', entry, join(root, 'alpha'))
  expect(p.run().verdict).toBe('pass')
  return p
}
test.each(['claude', 'stub-mcp-session.ts'] as const)
('round19 contradiction: final %s wrong group then exit is not hidden by a valid pair', entry => {
  const p = duplicatePlacement(entry)
  const child = placementCLI(p, scanMutation(p, 60, 'group', 'wrong-group-exit', 3))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.status).toBe(1); expect(child.stdout).toContain('limit=2 verdict=missing')
})
const finalReuseCases = (['claude', 'stub-mcp-session.ts'] as const).flatMap(entry =>
  (['reused-zombie', 'reused-exit'] as const).map(mutation => [entry, mutation] as const))
test.each(finalReuseCases)('round19 contradiction: final %s with %s is not hidden by a valid pair', (entry, mutation) => {
  const p = duplicatePlacement(entry)
  const child = placementCLI(p, scanMutation(p, 60, 'candidate-identity', mutation))()
  expect(readFileSync(join(root, 'scan-fired'), 'utf8')).toBe('yes')
  expect(child.error).toBeUndefined(); expect(child.status).toBe(1)
  expect(child.stdout).toContain('limit=2 verdict=missing')
})
function cpuCLI() {
  const proc = join(root, 'proc'), cg = join(root, 'cg'), file = join(root, 'cpu-evidence.ts')
  mkdirSync(join(proc, 'self'), { recursive: true }); mkdirSync(join(proc, '50'))
  writeFileSync(join(proc, 'self/cgroup'), '0::/shard/harness\n')
  writeFileSync(join(proc, '50/cgroup'), '0::/shard/server\n')
  writeFileSync(join(proc, '50/stat'), `50 (server) S 1 ${Array(17).fill('0').join(' ')} 99\n`)
  const counters = (path: string, n: number) => {
    mkdirSync(join(cg, path), { recursive: true })
    writeFileSync(join(cg, path, 'cpu.max'), '200000 100000\n')
    writeFileSync(join(cg, path, 'cpu.stat'), `nr_periods ${n}\nnr_throttled ${n}\nthrottled_usec ${n * 100}\n`)
  }
  counters('/shard/harness', 1); counters('/shard/server', 10)
  writeFileSync(file, readFileSync(join(fixtures, 'sr8-evidence.ts'), 'utf8')
    .replace("existsSync('/etc/cscb-ci-image')", 'true')
    .replace("const CGROUP_ROOT = '/sys/fs/cgroup'", `const CGROUP_ROOT = ${JSON.stringify(cg)}`)
    .replace("const HARNESS_PROC_ROOT = '/proc'", `const HARNESS_PROC_ROOT = ${JSON.stringify(proc)}`)
    .replace('textFile(`/proc/${pid}/cgroup`)', `textFile(join(${JSON.stringify(proc)}, String(pid), 'cgroup'))`))
  const run = (...args: string[]) => spawnSync(process.execPath, [file, ...args], {
    env: hostSafeChildEnv(root, { tools: [] }), encoding: 'utf8', timeout: 5000,
  })
  return { proc, cg, file, counters, run, mark: join(root, 'cpu.before') }
}
test('round17 regression: real CLI CPU baseline uses the measured group, not different harness counters', () => {
  const p = cpuCLI(), load = readFileSync(join(import.meta.dir, 'integration/lib/membership-load.sh'), 'utf8')
  const command = load.match(/^\s*bun "\$\{E\}" cpu-mark .*$/m)?.[0]
  expect(command).toBeDefined()
  expect(load.indexOf(command!)).toBeLessThan(load.indexOf('        new_state_dir "${MODE}-${CASE_KIND}"'))
  const child = shell(`E=${JSON.stringify(p.file)}; ROOT="$HOME"\n${command}`)
  expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' })
  p.counters('/shard/server', 25); p.counters('/shard/harness', 1000)
  const row = p.run('conditions', root, '50', p.mark)
  expect(row.status).toBe(0)
  expect(row.stdout).toContain('cpu_max=200000/100000 nr_periods_delta=15 nr_throttled_delta=15 throttled_usec_delta=1500\n')
})
test('ordinary shared group counters, unavailable counters and changed group identity stay safe through the real CLI', () => {
  const p = cpuCLI()
  writeFileSync(join(p.proc, 'self/cgroup'), '0::/\n'); writeFileSync(join(p.proc, '50/cgroup'), '0::/\n')
  p.counters('/', 10)
  expect(p.run('cpu-mark', p.mark).status).toBe(0)
  p.counters('/', 12)
  expect(p.run('conditions', root, '50', p.mark).stdout).toContain('nr_periods_delta=2 nr_throttled_delta=2 throttled_usec_delta=200')
  rmSync(join(p.cg, 'cpu.stat'))
  expect(p.run('conditions', root, '50', p.mark).stdout).toContain('nr_periods_delta=unknown nr_throttled_delta=unknown throttled_usec_delta=unknown')
  // Same pathname, different cgroup object: no cross-lifetime subtraction.
  const baseline = JSON.parse(readFileSync(p.mark, 'utf8')); baseline.identity = 'different:inode'
  writeFileSync(p.mark, JSON.stringify(baseline)); p.counters('/', 30)
  expect(p.run('conditions', root, '50', p.mark).stdout).toContain('nr_periods_delta=unknown')
  rmSync(p.mark); rmSync(join(p.cg, 'cpu.stat'))
  expect(p.run('cpu-mark', p.mark).status).toBe(0)
  p.counters('/', 40)
  expect(p.run('conditions', root, '50', p.mark).stdout).toContain('nr_periods_delta=unknown')
})
test.skipIf(!procMatchesPid).each(['TERM', 'INT', 'HUP'] as const)('round17 regression: broker relays %s before and after PID discovery, preserving output/status' + nativeSkipReason, signal => {
  const setup = brokerSetup()
  const consumed = 'pid) remote="${value}" ;;'
  expect(plantedLauncher()).toContain(consumed)
  writeFileSync(join(root, 'server-start.sh'), plantedLauncher().replace('echo "pid ${pid}" >&5',
    'if [[ -f "${root}/delay-pid" ]]; then while [[ ! -f "${root}/ack" ]]; do sleep 0.01; done; fi; echo "pid ${pid}" >&5')
    .replace(consumed, 'pid) remote="${value}"; : > "${SCENARIO_ROOT}/client-consumed-pid" ;;'))
  writeFileSync(join(root, 'cli.ts'), `import { writeFileSync } from 'node:fs';\nconst root=${JSON.stringify(root)};\nfor (const [sig,code] of [['SIGTERM',143],['SIGINT',130],['SIGHUP',129]] as const) process.on(sig,()=>{writeFileSync(root+'/received',sig); console.log('signal='+sig); console.error('signal stderr='+sig); process.exit(code)});\nconsole.log('long lived'); writeFileSync(root+'/ready',String(process.pid)); setInterval(()=>{},1000);\n`)
  const child = shell([...setup, `python3 - "$HOME" ${signal} <<'PY'
import json, os, signal, subprocess, sys, time
from pathlib import Path
root=Path(sys.argv[1]); name=sys.argv[2]; signum=getattr(signal,'SIG'+name)
for stage in ['before','after']:
    for leaf in ['ready','received','ack','delay-pid','client-consumed-pid']:
        (root/leaf).unlink(missing_ok=True)
    if stage=='before': (root/'delay-pid').touch()
    client=subprocess.Popen(['bash',str(root/'server-start.sh'),'start'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    remote=None
    try:
        end=time.monotonic()+3
        while not (root/'ready').exists() and time.monotonic()<end: time.sleep(.01)
        remote=int((root/'ready').read_text())
        if stage=='after':
            end=time.monotonic()+3
            while not (root/'client-consumed-pid').exists() and time.monotonic()<end: time.sleep(.01)
        consumed=(root/'client-consumed-pid').exists()
        assert consumed == (stage=='after'), 'client PID-consumption stage was not established'
        began=time.monotonic(); os.kill(client.pid,signum)
        end=time.monotonic()+1
        while not (root/'received').exists() and time.monotonic()<end: time.sleep(.01)
        (root/'ack').touch()
        out,err=client.communicate(timeout=8)
        print(json.dumps(dict(stage=stage,consumed=consumed,code=client.returncode,out=out,err=err,received=(root/'received').read_text() if (root/'received').exists() else None,bounded=time.monotonic()-began<8)))
    finally:
        (root/'ack').touch()
        if client.poll() is None: client.kill(); client.communicate()
        if remote:
            try: os.kill(remote,signal.SIGKILL)
            except ProcessLookupError: pass
PY`].join('\n'), 25000)
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('')
  const code = { TERM: 143, INT: 130, HUP: 129 }[signal]!
  expect(child.stdout.trim().split('\n').map(line => JSON.parse(line))).toEqual(['before', 'after'].map(stage => ({
    stage, consumed: stage === 'after', code, out: `long lived\nsignal=SIG${signal}\n`, err: `signal stderr=SIG${signal}\n`, received: `SIG${signal}`, bounded: true,
  })))
}, 30000)
test.skipIf(!procMatchesPid)('broker interruption with no remote PID or responsive CLI has bounded cleanup' + nativeSkipReason, () => {
  const setup = brokerSetup()
  writeFileSync(join(root, 'cli.ts'), `import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(join(root, 'ready'))},String(process.pid)); setInterval(()=>{},1000)\n`)
  const child = shell([...setup, `python3 - "$HOME" <<'PY'
import json, os, signal, subprocess, sys, time
from pathlib import Path
root=Path(sys.argv[1])
for kind in ['unresponsive','unsubmitted']:
    (root/'ready').unlink(missing_ok=True)
    if kind=='unsubmitted':
        os.kill(int((root/'broker.pid').read_text()),signal.SIGTERM)
        time.sleep(.1)
    client=subprocess.Popen(['bash',str(root/'server-start.sh'),'start'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    remote=None
    try:
        if kind=='unresponsive':
            end=time.monotonic()+3
            while not (root/'ready').exists() and time.monotonic()<end: time.sleep(.01)
            remote=int((root/'ready').read_text())
        else: time.sleep(.1)
        began=time.monotonic(); client.send_signal(signal.SIGTERM); out,err=client.communicate(timeout=9)
        print(json.dumps(dict(kind=kind,code=client.returncode,bounded=time.monotonic()-began<9,out=out)))
    finally:
        if client.poll() is None: client.kill(); client.communicate()
        if remote:
            try: os.kill(remote,signal.SIGKILL)
            except ProcessLookupError: pass
PY`].map(line => line).join('\n').replace('python3 - "$HOME"', 'echo "$broker" > "$HOME/broker.pid"\npython3 - "$HOME"'), 25000)
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0)
  const rows = child.stdout.trim().split('\n').map(line => JSON.parse(line))
  expect(rows).toEqual([{ kind: 'unresponsive', code: 137, bounded: true, out: '' }, { kind: 'unsubmitted', code: 143, bounded: true, out: '' }])
}, 30000)
test('tmux PID classifier uses recorded start/executable even with a missing or moved socket, leaving unrelated tmux alive', () => {
  const child = shell([
    'mkdir "$HOME/tmux" "$HOME/proc"; export TMUX_TMPDIR="$HOME/tmux"; SCENARIO_REAL_TMUX="$(command -v tmux)"',
    'trap \'"$SCENARIO_REAL_TMUX" -L unrelated kill-server 2>/dev/null || :\' EXIT',
    '"$SCENARIO_REAL_TMUX" -L unrelated new-session -d -s unrelated "sleep 60"',
    'unrelated="$("$SCENARIO_REAL_TMUX" -L unrelated display-message -p "#{pid}")"',
    'mkdir "$HOME/proc/500" "$HOME/proc/$unrelated"',
    'ln -s "$SCENARIO_REAL_TMUX" "$HOME/proc/500/exe"; ln -s "$SCENARIO_REAL_TMUX" "$HOME/proc/$unrelated/exe"',
    'printf "500 (tmux) S 1 %s 99\\n" "$(printf \'0 %.0s\' {1..17})" > "$HOME/proc/500/stat"',
    'printf "500\\t99\\t%s/tmux/missing\\n" "$HOME" > "$HOME/harness-tmux"',
    declaration(scenario, '_scenario_proc_starttime'), declaration(scenario, '_scenario_tmux_pids'),
    '_scenario_pid_ours() { return 1; }',
    '_scenario_tmux_pids "$HOME/proc"',
    'printf "500\\t99\\t%s/tmux/moved\\n" "$HOME" > "$HOME/harness-tmux"; _scenario_tmux_pids "$HOME/proc"',
    'printf "500\\t98\\t%s/tmux/missing\\n" "$HOME" > "$HOME/harness-tmux"; [[ -z "$(_scenario_tmux_pids "$HOME/proc")" ]] && echo reused-kept',
    'printf "500\\t99\\t%s/tmux/missing\\n" "$HOME" > "$HOME/harness-tmux"; rm "$HOME/proc/500/exe"; ln -s "$(command -v bash)" "$HOME/proc/500/exe"',
    '[[ -z "$(_scenario_tmux_pids "$HOME/proc")" ]] && echo wrong-exe-kept',
    'kill -0 "$unrelated"; "$SCENARIO_REAL_TMUX" -L unrelated has-session -t =unrelated; echo unrelated-alive',
  ].join('\n'))
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('')
  expect(child.stdout).toBe('500\n500\nreused-kept\nwrong-exe-kept\nunrelated-alive\n')
})
test('changed shell files parse', () => {
  for (const file of [join(fixtures, 'server-start.sh'), join(fixtures, 'burst-driver.sh'), join(repo, 'docker/entrypoint.sh'), join(import.meta.dir, 'integration/lib/scenario.sh'), join(import.meta.dir, 'integration/lib/membership-load.sh'), join(import.meta.dir, 'integration/test-44-fmk-thread-burst.sh')]) {
    const child = spawnSync('bash', ['-n', file], {
      env: hostSafeChildEnv(root, { tools: ['bash'] }), encoding: 'utf8', timeout: 5000,
    })
    expect({ file, status: child.status, stderr: child.stderr }).toEqual({ file, status: 0, stderr: '' })
  }
})
