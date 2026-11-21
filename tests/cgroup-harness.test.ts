import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as evidence from './integration/fixtures/sr8-evidence.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { CPUS_PER_SHARD, DRIVER_CPUS, shardCpus } from '../scripts/ci-run.ts'

const repo = join(import.meta.dir, '..'), fixtures = join(import.meta.dir, 'integration/fixtures')
const scenario = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
const launcher = existsSync(join(fixtures, 'server-start.sh')) ? readFileSync(join(fixtures, 'server-start.sh'), 'utf8') : ''
let root: string
const sockets: { stop(close: boolean): void }[] = []
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'test-harness-')) })
afterEach(() => { for (const socket of sockets.splice(0)) socket.stop(true); rmSync(root, { recursive: true, force: true }) })
function declaration(text: string, name: string) {
  const match = text.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))
  if (!match) throw new Error(`missing ${name}`)
  return match[0]
}
function shell(program: string, timeout = 10000) {
  return spawnSync('bash', ['-c', `set -euo pipefail\nexport SCENARIO_ROOT="$HOME"\n${program}`], {
    env: hostSafeChildEnv(root, { tools: ['bash', 'bun', 'tmux', 'sleep', 'python3', 'find', 'realpath', 'flock', 'mkfifo', 'timeout', 'cat', 'chmod', 'id'] }),
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
test('server start launcher preserves output/status, uses a fixed command and records the real CLI PID', () => {
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
test('server launcher drops arbitrary caller loaders and environment', () => {
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
test('server launcher preserves the existing profile opt-in through its fixed trusted preload', () => {
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

test('harness tmux first launch, two personas and empty restart retain the owned scratch socket; cleanup reaps empty server', () => {
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
function placement() {
  const proc = join(root, 'proc'), state = join(root, 'state'), socket = join(root, 'tmux/default')
  mkdirSync(state); mkdirSync(join(root, 'tmux'))
  sockets.push(Bun.serve({ unix: socket, fetch: () => new Response('') }))
  const dirs = ['alpha', 'beta'].map(name => join(root, name))
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
  return { proc, state, limits, put, run: () => collect(root, state, join(root, 'record'), 2, (path: string) => limits[path], proc, 50) }
}
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
  return () => spawnSync(process.execPath, [file, 'driver-cpu', 'test-placement', 'strict', '0', '2', '50', join(root, 'record')], {
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
test('tmux, measured server and Slack stub reused identities are missing', () => {
  const p = placement()
  for (const [role, pid] of [['tmux', 20], ['server', 50], ['slack', 12]] as const) {
    const path = join(root, `harness-${role}`), saved = readFileSync(path, 'utf8')
    writeFileSync(path, saved.replace(`${pid}\t99`, `${pid}\t98`))
    expect(p.run().verdict).toBe('missing')
    writeFileSync(path, saved)
    expect(p.run().verdict).toBe('pass')
  }
})

type ScanBoundary = 'group' | 'cwd' | 'cmdline' | 'identity' | 'tmux-loop' | 'candidate-identity'
type ScanMutation = 'vanished' | 'unreadable' | 'reused' | 'zombie' | 'reused-zombie' | 'reused-exit' | 'wrong-group-exit'
// Only copied CLI file reads are instrumented. No sleeps, global fs mocks or
// collector API changes: the same read boundaries exist in the before fixture.
function scanMutation(p: ReturnType<typeof placement>, pid: number, boundary: ScanBoundary,
  mutation: ScanMutation, groupRead = 1, wrongGroup = '/shard/server') {
  const dir = join(p.proc, String(pid)), marker = join(root, 'scan-fired')
  return (source: string) => {
    const imports = 'readFileSync, readlinkSync,'
    expect(source.split(imports)).toHaveLength(2)
    return `import { rmSync as removeProcess, writeFileSync as traceProcess } from 'node:fs';
let scanGroups=0, scanCommand=false, scanFired=false, scanRemoveAfter='';
function scanRead(path, link=false) {
  path=String(path);
  const dir=${JSON.stringify(dir)}, boundary=${JSON.stringify(boundary)};
  if(path===dir+'/cgroup') scanGroups++;
  const fire=!scanFired && (
    (boundary==='group' && path===dir+'/cgroup' && scanGroups===${groupRead}) ||
    (boundary==='tmux-loop' && path===dir+'/cgroup' && scanGroups===1) ||
    (boundary==='cwd' && link && path===dir+'/cwd') ||
    (boundary==='cmdline' && path===dir+'/cmdline') ||
    (boundary==='identity' && scanCommand && path===dir+'/stat') ||
    (boundary==='candidate-identity' && scanGroups>=3 && path===dir+'/stat'));
  if(path===dir+'/cmdline') scanCommand=true;
  if(!fire) return;
  scanFired=true; traceProcess(${JSON.stringify(marker)},'yes');
  const mutation=${JSON.stringify(mutation)};
  if(mutation==='vanished') removeProcess(dir,{recursive:true});
  else if(mutation==='unreadable') removeProcess(path);
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
test.each(['TERM', 'INT', 'HUP'] as const)('round17 regression: broker relays %s before and after PID discovery, preserving output/status', signal => {
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
test('broker interruption with no remote PID or responsive CLI has bounded cleanup', () => {
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
