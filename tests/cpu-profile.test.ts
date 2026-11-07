/** test-44's opt-in CPU profile (tests/integration/fixtures/cpu-profile*.ts):
 * the opt-in gate, the content-free summary over synthetic profiles, the
 * profiler's failure containment over a fake inspector, the real preload
 * sampling a scratch Bun child, and test-44's profile steps in a stub shell.
 * No scenario or server runs. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import {
  CPU_PROFILE_DIR_ENV, cpuProfileOptIn, startCpuProfile, summaryLines, summaryReport,
  type CpuProfile, type ProfilePart, type ProfilerIo,
} from './integration/fixtures/cpu-profile.ts'

const REPO = join(import.meta.dir, '..')
const FIXTURES = join(import.meta.dir, 'integration/fixtures')
const SCRIPT = readFileSync(join(import.meta.dir, 'integration/test-44-fmk-thread-burst.sh'), 'utf8')
const CONTEXT = 'scenario=test-44-fmk-thread-burst mode=strict population=0 recipients=1'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cscb-cpu-profile-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

// (root) → (module) server.ts → handleEvent socket.ts → a native clone; (module) → an anonymous native.
const PKG = 'file:///test-repo/node_modules/claude-slack-channel-bots/src'
function profile(samples: number[], timeDeltas: number[], startTime: number, endTime: number): CpuProfile {
  return { startTime, endTime, samples, timeDeltas, nodes: [
    { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2] },
    { id: 2, callFrame: { functionName: '(module)', url: `${PKG}/server.ts`, lineNumber: 0 }, children: [3, 4] },
    { id: 3, callFrame: { functionName: 'handleEvent', url: `${PKG}/socket.ts`, lineNumber: 9 }, children: [5] },
    { id: 4, callFrame: { functionName: '', url: '', lineNumber: -1 } },
    { id: 5, callFrame: { functionName: 'structured Clone', url: '', lineNumber: -1 } },
  ] }
}
// Unequal time deltas: handleEvent's one self sample outweighs the clone's three.
const roots: ProfilePart = { wave: 'roots', startLagMs: 20, stopLagMs: 30,
  profile: profile([5, 5, 5, 3, 4, 1], [1000, 1000, 1000, 4000, 500, 500], 0, 6000) }
const replies: ProfilePart = { wave: 'replies-drops', startLagMs: 10, stopLagMs: 40, profile: profile([3, 3], [1000, 1000], 10_000, 12_000) }
function writeProfile(dir: string, parts: ProfilePart[], waves: string, declared?: number) {
  mkdirSync(dir, { recursive: true })
  for (const [n, p] of parts.entries()) writeFileSync(join(dir, `part-000${n}-${p.wave}.json`), JSON.stringify(p))
  writeFileSync(join(dir, 'waves'), waves)
  if (declared !== undefined) writeFileSync(join(dir, 'complete.json'), JSON.stringify({ parts: declared }))
}

describe('cpu-profile summary (synthetic profiles)', () => {
  const server = '(module)@claude-slack-channel-bots/src/server.ts:1', handler = 'handleEvent@claude-slack-channel-bots/src/socket.ts:10'
  const clone = 'structured_Clone@(native)'
  // [self samples, self %, total samples, total %, self weight µs, self weight %, total weight µs, total weight %]
  const row = (kind: 'function' | 'file', wave: string, by: string, rank: number, n: (number | string)[], name: string) =>
    `recorded: cpu-profile-${kind} ${CONTEXT} wave=${wave} by=${by} rank=${rank} self_samples=${n[0]} self_pct=${n[1]} total_samples=${n[2]} total_pct=${n[3]}`
    + ` self_weight_us=${n[4]} self_weight_pct=${n[5]} total_weight_us=${n[6]} total_weight_pct=${n[7]} ${kind}=${name}`

  test('ranks functions and files by self and total share of samples, then of weight, per wave and for all waves', () => {
    const lines = summaryLines(CONTEXT, [roots, replies], 2)
    expect(lines.slice(0, 13)).toEqual([
      // The (root) sample counts toward the wave's samples and weight but is never ranked.
      `recorded: cpu-profile ${CONTEXT} wave=roots parts=1 samples=6 weight_ms=8 duration_ms=6 start_lag_ms=20 stop_lag_ms=30`,
      row('function', 'roots', 'self', 1, [3, 50, 3, 50, 3000, 37.5, 3000, 37.5], clone),
      row('function', 'roots', 'self', 2, [1, 16.7, 1, 16.7, 500, 6.3, 500, 6.3], '(anonymous)@(native)'),
      row('function', 'roots', 'total', 1, [0, 0, 5, 83.3, 0, 0, 7500, 93.8], server),
      row('function', 'roots', 'total', 2, [1, 16.7, 4, 66.7, 4000, 50, 7000, 87.5], handler),
      // By weight the handler's one long sample ranks above the clone's three short ones.
      row('function', 'roots', 'self_weight', 1, [1, 16.7, 4, 66.7, 4000, 50, 7000, 87.5], handler),
      row('function', 'roots', 'self_weight', 2, [3, 50, 3, 50, 3000, 37.5, 3000, 37.5], clone),
      row('function', 'roots', 'total_weight', 1, [0, 0, 5, 83.3, 0, 0, 7500, 93.8], server),
      row('function', 'roots', 'total_weight', 2, [1, 16.7, 4, 66.7, 4000, 50, 7000, 87.5], handler),
      row('file', 'roots', 'self', 1, [4, 66.7, 4, 66.7, 3500, 43.8, 3500, 43.8], '(native)'),
      row('file', 'roots', 'total', 1, [0, 0, 5, 83.3, 0, 0, 7500, 93.8], 'claude-slack-channel-bots/src/server.ts'),
      row('file', 'roots', 'self_weight', 1, [1, 16.7, 4, 66.7, 4000, 50, 7000, 87.5], 'claude-slack-channel-bots/src/socket.ts'),
      row('file', 'roots', 'total_weight', 1, [0, 0, 5, 83.3, 0, 0, 7500, 93.8], 'claude-slack-channel-bots/src/server.ts'),
    ])
    expect(lines[13]).toBe(`recorded: cpu-profile ${CONTEXT} wave=replies-drops parts=1 samples=2 weight_ms=2 duration_ms=2 start_lag_ms=10 stop_lag_ms=40`)
    // Equal total shares rank by self share.
    expect(lines.filter(l => l.startsWith('recorded: cpu-profile-function ') && l.includes(' wave=replies-drops by=total '))).toEqual([
      row('function', 'replies-drops', 'total', 1, [2, 100, 2, 100, 2000, 100, 2000, 100], handler),
      row('function', 'replies-drops', 'total', 2, [0, 0, 2, 100, 0, 0, 2000, 100], server),
    ])
    const all = lines.indexOf(`recorded: cpu-profile ${CONTEXT} wave=all parts=2 samples=8 weight_ms=10 duration_ms=8 start_lag_ms=20 stop_lag_ms=40`)
    // Across waves the handler's self samples and weights add up; an equal self share ranks by name.
    expect(lines.slice(all + 1, all + 3)).toEqual([
      row('function', 'all', 'self', 1, [3, 37.5, 6, 75, 6000, 60, 9000, 90], handler),
      row('function', 'all', 'self', 2, [3, 37.5, 3, 37.5, 3000, 30, 3000, 30], clone),
    ])
    expect(lines.every(l => /^recorded: cpu-profile(-function|-file)? ( ?[a-z_]+=\S+)+$/.test(l))).toBe(true)
    expect(summaryLines(CONTEXT, [])).toEqual([])
  })

  const done = 'roots\nreplies-drops\nend\n'
  test.each([
    ['no profile directory', (_dir: string) => [], 'unreadable', 'split=unavailable max_lag_ms=unknown'],
    ['an empty profile directory', (dir: string) => { mkdirSync(dir); return [] }, 'incomplete', 'split=unavailable max_lag_ms=unknown'],
    ['a profiler failure', (dir: string) => { writeProfile(dir, [roots], 'roots\n'); writeFileSync(join(dir, 'error.txt'), '{}'); return [roots] },
      'error', 'split=reliable max_lag_ms=30'],
    ['a malformed part', (dir: string) => { mkdirSync(dir); writeFileSync(join(dir, 'part-0000-roots.json'), '{"wave":"roots"}'); return [] },
      'unreadable', 'split=unavailable max_lag_ms=unknown'],
    ['a profile stopped before end', (dir: string) => { writeProfile(dir, [roots], 'roots\nreplies-drops\n'); return [roots] },
      'incomplete', 'split=reliable max_lag_ms=30'],
    ['a complete two-wave profile', (dir: string) => { writeProfile(dir, [roots, replies], done, 2); return [roots, replies] },
      'complete', 'split=reliable max_lag_ms=40'],
    ['complete.json declaring another part count', (dir: string) => { writeProfile(dir, [roots, replies], done, 3); return [roots, replies] },
      'inconsistent', 'split=reliable max_lag_ms=40'],
    ['a marked wave with no part', (dir: string) => { writeProfile(dir, [roots, replies], `probe\n${done}`, 2); return [roots, replies] },
      'inconsistent', 'split=reliable max_lag_ms=40'],
    ['a part with no samples', (dir: string) => {
      const empty = { ...replies, profile: { ...replies.profile, samples: [], timeDeltas: [] } }
      writeProfile(dir, [roots, empty], done, 2); return [roots, empty]
    }, 'inconsistent', 'split=reliable max_lag_ms=40'],
    ['a cut later than the split allows', (dir: string) => {
      const late = { ...roots, stopLagMs: 251 }
      writeProfile(dir, [late, replies], done, 2); return [late, replies]
    }, 'complete', 'split=unreliable max_lag_ms=251'],
    ['a part with no recorded lag', (dir: string) => {
      const { startLagMs: _s, stopLagMs: _t, ...unknown } = roots
      writeProfile(dir, [unknown, replies], done, 2); return [unknown, replies]
    }, 'complete', 'split=unreliable max_lag_ms=unknown'],
  ] as const)('summary report states the outcome and split first: %s', (_name, setup, outcome, split) => {
    const dir = join(root, 'cpu-profile')
    const parts: ProfilePart[] = setup(dir)
    const lines = summaryReport(dir, CONTEXT)
    expect(lines[0]).toBe(`recorded: cpu-profile ${CONTEXT} wave=none outcome=${outcome} parts=${parts.length} ${split}`)
    expect(lines.slice(1)).toEqual(summaryLines(CONTEXT, parts))
  })
})

describe('cpu-profile CLI (as test-44 calls it)', () => {
  const cli = (...args: string[]) => {
    const child = spawnSync(process.execPath, [join(FIXTURES, 'cpu-profile.ts'), ...args], {
      env: hostSafeChildEnv(root, { tools: [], extras: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } }), encoding: 'utf8', timeout: 5000 })
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
    return child
  }
  test('stop marks end once and reports the preload\'s outcome; summary prints the report; bad arguments exit 64', () => {
    const dir = join(root, 'cpu-profile')
    writeProfile(dir, [roots], 'probe\nroots\n', 1)
    expect(cli('stop', dir, '5').stdout).toBe('recorded: cpu-profile-stop outcome=complete parts=1\n')
    expect(cli('stop', dir, '5').stdout).toBe('recorded: cpu-profile-stop outcome=complete parts=1\n')
    expect(readFileSync(join(dir, 'waves'), 'utf8')).toBe('probe\nroots\nend\n')
    const summary = cli('summary', dir, 'test-44-fmk-thread-burst', 'strict', '0', '1')
    expect({ status: summary.status, stderr: summary.stderr }).toEqual({ status: 0, stderr: '' })
    expect(summary.stdout).toBe(summaryReport(dir, CONTEXT).join('\n') + '\n')
    for (const args of [['stop', dir], ['stop', 'cpu-profile', '5'], ['stop', join(root, 'absent'), '5'], ['summary', dir, 'test-44', 'strict', '0'],
      ['summary', dir, 'test-44', 'strict mode', '0', '1'], ['other', dir]]) {
      expect({ status: cli(...args).status, stdout: cli(...args).stdout }).toEqual({ status: 64, stdout: '' })
    }
  })

  test('stop reports a timeout when the preload never answers, after marking end', () => {
    const dir = join(root, 'cpu-profile')
    writeProfile(dir, [roots], 'roots\n')
    const stop = cli('stop', dir, '0.1')
    expect({ status: stop.status, stdout: stop.stdout, stderr: stop.stderr }).toEqual({ status: 0, stdout: 'recorded: cpu-profile-stop outcome=timeout parts=1\n', stderr: '' })
    expect(readFileSync(join(dir, 'waves'), 'utf8')).toBe('roots\nend\n')
  })
})

describe('cpu-profile profiler failures (fake inspector)', () => {
  type Fault = 'construct' | 'connect' | 'disconnect' | 'marker' | 'observer' | 'Profiler.enable' | 'Profiler.start' | 'Profiler.stop'
  function fakeIo(faults: readonly Fault[]) {
    const calls: string[] = [], timers: { tick: () => Promise<void>; cancelled: boolean }[] = []
    const fault = (f: Fault) => { if (faults.includes(f)) throw new Error(`injected ${f}`) }
    const io: ProfilerIo = {
      session: () => {
        fault('construct')
        return {
          connect: () => { calls.push('connect'); fault('connect') },
          disconnect: () => { calls.push('disconnect'); fault('disconnect') },
          post: (method, _params, callback) => {
            calls.push(method)
            if (faults.includes(method as Fault)) callback(new Error(`injected ${method}`), undefined)
            else callback(null, method === 'Profiler.stop' ? { profile: profile([3], [1000], 0, 1000) } : {})
          },
        }
      },
      every: tick => { const timer = { tick, cancelled: false }; timers.push(timer); return timer },
      cancel: timer => { (timer as { cancelled: boolean }).cancelled = true },
      write: (file, text) => { fault('marker'); writeFileSync(file, text) },
      append: (file, text) => { fault('observer'); appendFileSync(file, text) },
      now: () => 0,
    }
    return { io, calls, timers }
  }
  const init = ['connect', 'Profiler.enable', 'Profiler.setSamplingInterval']
  const initFailed = '{"error":"profiler initialization failed"}', tickFailed = '{"error":"profiler checkpoint failed"}'

  test.each([
    ['the session cannot be made', ['construct'], '', [], ['error.txt'], initFailed],
    ['connect fails', ['connect'], '', ['connect', 'disconnect'], ['error.txt'], initFailed],
    ['connect and disconnect both fail', ['connect', 'disconnect'], '', ['connect', 'disconnect'], ['error.txt'], initFailed],
    ['Profiler.enable fails', ['Profiler.enable'], '', ['connect', 'Profiler.enable', 'disconnect'], ['error.txt'], initFailed],
    ['initialization and its error marker both fail', ['Profiler.enable', 'marker'], '', ['connect', 'Profiler.enable', 'disconnect'], [], ''],
    ['Profiler.start fails at the first wave mark', ['Profiler.start'], 'roots\n', [...init, 'Profiler.start', 'disconnect'],
      ['error.txt', 'observer.jsonl', 'waves'], tickFailed],
    ['a cut, the observer and the error marker all fail', ['Profiler.stop', 'observer', 'marker'], 'roots\nreplies-drops\n',
      [...init, 'Profiler.start', 'Profiler.stop', 'disconnect'], ['waves'], ''],
  ] as const)('%s: nothing escapes, the session is closed and no timer is left', async (_name, faults, waves, calls, files, marker) => {
    const dir = join(root, 'cpu-profile')
    mkdirSync(dir)
    const fake = fakeIo(faults)
    await expect(startCpuProfile(dir, fake.io)).resolves.toBeUndefined()
    expect(fake.timers).toHaveLength(waves ? 1 : 0)
    if (waves) {
      writeFileSync(join(dir, 'waves'), waves)
      await expect(fake.timers[0]!.tick()).resolves.toBeUndefined()
      // A later tick does nothing: profiling has ended.
      await expect(fake.timers[0]!.tick()).resolves.toBeUndefined()
    }
    expect(fake.timers.every(t => t.cancelled)).toBe(true)
    expect(fake.calls).toEqual([...calls])
    expect(readdirSync(dir).sort()).toEqual([...files])
    if (marker) expect(readFileSync(join(dir, 'error.txt'), 'utf8')).toBe(marker)
  })
})

describe('cpu-profile preload (scratch Bun child, CI image marker redirected)', () => {
  // The child stands in for the daemon and marks each wave as sr8 burst does.
  // `profiled` waits for the preload's `started` before each wave's own hot
  // function; `held` runs the work at once without yielding, so the preload's
  // timer sees the marks only afterwards; `plain` only marks and exits.
  const SERVER = `import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
console.log(JSON.stringify({ BUN_OPTIONS: process.env.BUN_OPTIONS ?? null, ${CPU_PROFILE_DIR_ENV}: process.env.${CPU_PROFILE_DIR_ENV} ?? null }))
const dir = process.argv[3]!, mode = process.argv[4], yieldLoop = () => new Promise(r => setTimeout(r, 1))
const observed = () => existsSync(join(dir, 'observer.jsonl')) ? readFileSync(join(dir, 'observer.jsonl'), 'utf8').trim().split('\\n').map(l => JSON.parse(l)) : []
async function until(done: () => boolean) { const end = performance.now() + 3000; while (!done()) { if (performance.now() > end) throw new Error('preload did not answer'); await yieldLoop() } }
function rootsWork() { let x = 0; for (let i = 0; i < 300000; i++) x += Math.sqrt(x + i); return x }
function repliesWork() { let x = 0; for (let i = 0; i < 300000; i++) x += Math.sqrt(x + i); return x }
async function wave(name: string, work: () => number) {
  appendFileSync(join(dir, 'waves'), name + '\\n')
  if (mode === 'held') { const end = performance.now() + 250; while (performance.now() < end) work(); return }
  if (mode !== 'profiled') return
  await until(() => observed().some(e => e.phase === 'started' && e.wave === name))
  const end = performance.now() + 120
  while (performance.now() < end) { work(); await yieldLoop() }
}
await wave('roots', rootsWork)
await wave('replies-drops', repliesWork)
appendFileSync(join(dir, 'waves'), 'end\\n')
if (mode !== 'plain') await until(() => existsSync(join(dir, 'complete.json')) || existsSync(join(dir, 'error.txt')))
console.log('done')
`
  function run(env: Record<string, string>, mode: 'profiled' | 'held' | 'plain', subcommand = 'start', fault?: string) {
    const fixtures = join(root, 'fixtures'), dir = join(root, 'cpu-profile'), marker = join(root, 'image')
    mkdirSync(fixtures); mkdirSync(dir); writeFileSync(marker, '')
    const module = readFileSync(join(FIXTURES, 'cpu-profile.ts'), 'utf8')
    expect(module.split("'/etc/cscb-ci-image'")).toHaveLength(2)
    writeFileSync(join(fixtures, 'cpu-profile.ts'), module.replace("'/etc/cscb-ci-image'", JSON.stringify(marker)))
    writeFileSync(join(fixtures, 'cpu-profile-preload.ts'), readFileSync(join(FIXTURES, 'cpu-profile-preload.ts')))
    writeFileSync(join(root, 'server.ts'), SERVER)
    const preloads = [join(fixtures, 'cpu-profile-preload.ts')]
    if (fault) { writeFileSync(join(root, 'fault.ts'), `import { Session } from 'node:inspector'\n${fault}\n`); preloads.unshift(join(root, 'fault.ts')) }
    const child = spawnSync(process.execPath, [join(root, 'server.ts'), subcommand, dir, mode], {
      env: hostSafeChildEnv(root, { tools: [], extras: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        BUN_OPTIONS: preloads.map(p => `--preload ${p}`).join(' '), [CPU_PROFILE_DIR_ENV]: dir, ...env } }),
      encoding: 'utf8', timeout: 10_000 })
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' })
    const stdout = child.stdout.trim().split('\n')
    expect(stdout.at(-1)).toBe('done')
    return { dir, seen: JSON.parse(stdout[0]!) }
  }

  test('samples the daemon child from the first wave mark to end, one part per wave, and hides the opt-in from its children', () => {
    const { dir, seen } = run({ _CLI_DAEMON_CHILD: '1' }, 'profiled')
    expect(seen).toEqual({ BUN_OPTIONS: null, [CPU_PROFILE_DIR_ENV]: null })
    expect(readdirSync(dir).sort()).toEqual(['complete.json', 'observer.jsonl', 'part-0000-roots.json', 'part-0001-replies-drops.json', 'waves'])
    expect(JSON.parse(readFileSync(join(dir, 'complete.json'), 'utf8'))).toEqual({ parts: 2 })
    const lines = summaryReport(dir, CONTEXT)
    expect(lines[0]).toMatch(new RegExp(`^recorded: cpu-profile ${CONTEXT} wave=none outcome=complete parts=2 split=(un)?reliable max_lag_ms=\\d+$`))
    const top = (wave: string) => lines.find(l => l.startsWith(`recorded: cpu-profile-function ${CONTEXT} wave=${wave} by=self rank=1 `))
    expect(top('roots')).toMatch(/ function=rootsWork@\S+\/server\.ts:\d+$/)
    expect(top('replies-drops')).toMatch(/ function=repliesWork@\S+\/server\.ts:\d+$/)
    expect(lines.find(l => l.startsWith(`recorded: cpu-profile ${CONTEXT} wave=roots parts=1 `)))
      .toMatch(/ samples=[1-9]\d* weight_ms=\d+ duration_ms=[1-9]\d* start_lag_ms=\d+ stop_lag_ms=\d+$/)
  })

  test('reports the per-wave split unreliable when a held event loop delays every cut', () => {
    const { dir } = run({ _CLI_DAEMON_CHILD: '1' }, 'held')
    // Both waves' 250 ms of work ran before the preload's timer could see either mark.
    const lag = summaryReport(dir, CONTEXT)[0]!.match(/ parts=2 split=unreliable max_lag_ms=(\d+)$/)
    expect(Number(lag?.[1])).toBeGreaterThanOrEqual(500)
  })

  test.each([
    ['connect throws', 'Session.prototype.connect = function () { throw new Error("injected") }'],
    ['every inspector command fails', 'Session.prototype.post = function (_method: string, _params: object, callback: (e: Error) => void) { callback(new Error("injected")) }'],
  ])('a profiler that cannot start leaves its marker and the child completes as usual: %s', (_name, fault) => {
    const { dir, seen } = run({ _CLI_DAEMON_CHILD: '1' }, 'plain', 'start', fault)
    expect(seen).toEqual({ BUN_OPTIONS: null, [CPU_PROFILE_DIR_ENV]: null })
    expect(readdirSync(dir).sort()).toEqual(['error.txt', 'waves'])
    expect(readFileSync(join(dir, 'error.txt'), 'utf8')).toBe('{"error":"profiler initialization failed"}')
  })

  test.each([
    ['the CLI parent (no daemon marker)', {}, 'start'],
    ['a marked process running another subcommand', { _CLI_DAEMON_CHILD: '1' }, 'stop'],
  ] as const)('starts no profiler for %s', (_name, env, subcommand) => {
    const { dir } = run(env, 'plain', subcommand)
    expect(readdirSync(dir)).toEqual(['waves'])
  })
})

describe('test-44 profile steps (stub shell)', () => {
  // test-44's profile block under scenario.sh's before-cleanup semantics:
  // each hook runs in a subshell, its status ignored, and the exit status kept.
  const block = () => {
    const start = SCRIPT.indexOf('# Test-only CPU profile'), end = SCRIPT.indexOf('\nfi\n', start) + 4
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
    return SCRIPT.slice(start, end)
  }
  const HARNESS = `set -euo pipefail
bun() { "\${BUN}" "$@"; }
hooks=()
on_before_cleanup() { hooks+=("$1"); }
fail() { echo "FAIL: $1" >&2; exit 1; }
cleanup() { local rc=$? hook; set +e; trap - EXIT; for hook in \${hooks[@]+"\${hooks[@]}"}; do ( "\${hook}" ); done; exit "\${rc}"; }
trap cleanup EXIT
CASE=burst
EVIDENCE="$1"
SCENARIO_FIXTURES="$2"
CONTEXT=(test-44-fmk-thread-burst strict 0 1)
`
  const STOPPED = 'recorded: cpu-profile-stop outcome=complete parts=2'
  const complete = (evidence: string) => writeProfile(join(evidence, 'cpu-profile'), [roots, replies], 'roots\nreplies-drops\nend\n', 2)
  // [name, prepare the evidence directory (answers a fixtures directory), steps, status, stdout lines, stderr]
  type ShellRow = [string, (evidence: string) => string | void, string, number, (dir: string) => string[], string]

  test('scenario.sh runs before-cleanup hooks in subshells, ignoring their status, before it removes the scratch root', () => {
    const scenario = readFileSync(join(import.meta.dir, 'integration/lib/scenario.sh'), 'utf8')
    const hooks = scenario.indexOf('    for hook in ${_SCENARIO_BEFORE_CLEANUP_HOOKS[@]+"${_SCENARIO_BEFORE_CLEANUP_HOOKS[@]}"}; do\n        ( "${hook}" )\n    done\n')
    expect(hooks).toBeGreaterThan(scenario.indexOf('_scenario_cleanup() {'))
    expect(scenario.indexOf('rm -rf "${SCENARIO_ROOT}"', hooks)).toBeGreaterThan(hooks)
  })

  test('the burst case summarizes right after the profile stops, before any other post-burst step', () => {
    expect(SCRIPT).toContain('"${MEASUREMENTS}" "${measurement_mark}" || burst_status=$?\n'
      + '        # The profile ends with the waves, before the observation wait below,\n'
      + '        # and its summary prints at once, so a later failing step keeps it.\n'
      + '        profile_stop\n        profile_summary\n')
    expect(SCRIPT.match(/^\s*profile_(stop|summary)$/gm)).toHaveLength(2)
    expect(SCRIPT.match(/cpu-profile\.ts|PROFILER}/g)).toHaveLength(3)
  })

  test.each<ShellRow>([
    ['a step after the profile stops fails', complete, 'profile_stop\nprofile_summary\nfail "cannot read own-post evidence"',
      1, (dir: string) => [STOPPED, ...summaryReport(dir, CONTEXT)], 'FAIL: cannot read own-post evidence\n'],
    ['the script fails before the profile stops, with one part saved', (evidence: string) => writeProfile(join(evidence, 'cpu-profile'), [roots], 'roots\n'),
      'fail "silent persona startup incomplete"', 1, (dir: string) => summaryReport(dir, CONTEXT), 'FAIL: silent persona startup incomplete\n'],
    ['the script passes', complete, 'profile_stop\nprofile_summary', 0, (dir: string) => [STOPPED, ...summaryReport(dir, CONTEXT)], ''],
    ['the summarizer fails in the cleanup hook', (evidence: string) => {
      mkdirSync(join(evidence, 'fixtures'), { recursive: true }); writeFileSync(join(evidence, 'fixtures/cpu-profile.ts'), 'process.exit(3)\n')
      return join(evidence, 'fixtures')
    }, 'exit 4', 4, () => ['recorded: cpu-profile summary unavailable'], ''],
    ['the profile directory cannot be made', (evidence: string) => { writeFileSync(evidence, ''); return undefined },
      'profile_stop\nprofile_summary\necho continued', 0, () => ['recorded: cpu-profile unavailable reason=profile-directory', 'continued'], ''],
  ])('prints the summary once and keeps the script\'s status: %s', (_name, prepare, steps, status, stdout, stderr) => {
    const evidence = join(root, 'evidence')
    const fixtures = prepare(evidence)
    const child = spawnSync('bash', ['--noprofile', '--norc', '-c', `${HARNESS}${block()}\n${steps}\n`, 'test-44', evidence, fixtures ?? FIXTURES], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'mkdir'], extras: { BUN: process.execPath, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } }),
      encoding: 'utf8', timeout: 10_000 })
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
    expect({ status: child.status, stdout: child.stdout, stderr: child.stderr })
      .toEqual({ status, stdout: stdout(join(evidence, 'cpu-profile')).join('\n') + '\n', stderr })
  })
})

describe('cpu-profile opt-in', () => {
  const on = (dir: string) => ({ [CPU_PROFILE_DIR_ENV]: dir, _CLI_DAEMON_CHILD: '1' })
  const argv = ['bun', '/test-repo/node_modules/claude-slack-channel-bots/src/cli.ts', 'start']
  test.each([
    ['the image daemon child with the opt-in', (d: string, m: string) => cpuProfileOptIn(on(d), argv, m), true],
    ['no opt-in', (_d: string, m: string) => cpuProfileOptIn({ _CLI_DAEMON_CHILD: '1' }, argv, m), false],
    ['a relative profile directory', (_d: string, m: string) => cpuProfileOptIn(on('cpu-profile'), argv, m), false],
    ['the CLI parent (no daemon marker)', (d: string, m: string) => cpuProfileOptIn({ [CPU_PROFILE_DIR_ENV]: d }, argv, m), false],
    ['another subcommand', (d: string, m: string) => cpuProfileOptIn(on(d), [...argv.slice(0, 2), 'stop'], m), false],
    ['outside the CI image', (d: string) => cpuProfileOptIn(on(d), argv, join(root, 'absent-marker')), false],
    ['a missing profile directory', (_d: string, m: string) => cpuProfileOptIn(on(join(root, 'absent')), argv, m), false],
  ] as const)('%s', (_name, optIn, profiled) => {
    const dir = join(root, 'cpu-profile'), marker = join(root, 'image')
    mkdirSync(dir); writeFileSync(marker, '')
    expect(optIn(dir, marker)).toBe(profiled ? dir : undefined)
  })

  test('only test-44\'s burst case sets it, on its measured start, and no src module names it', () => {
    const integration = join(import.meta.dir, 'integration')
    const shells = (readdirSync(integration, { recursive: true }) as string[]).filter(f => f.endsWith('.sh'))
    const opted = /cpu-profile|CSCB_TEST_CPU_PROFILE_DIR|SR8_PROFILE_DIR|BUN_OPTIONS/
    expect(shells.filter(f => opted.test(readFileSync(join(integration, f), 'utf8')))).toEqual(['test-44-fmk-thread-burst.sh'])
    expect(SCRIPT).toContain('if [[ "${CASE}" == burst ]]; then\n    if mkdir -p "${EVIDENCE}/cpu-profile" 2> /dev/null; then\n        PROFILE_DIR="${EVIDENCE}/cpu-profile"\n')
    expect(SCRIPT.match(/PROFILE_DIR="\$\{EVIDENCE\}/g)).toHaveLength(1)
    expect(SCRIPT).toContain('    if [[ "${1:-}" == measured && -n "${PROFILE_DIR}" ]]; then\n        BUN_OPTIONS="--preload ${SCENARIO_FIXTURES}/cpu-profile-preload.ts" CSCB_TEST_CPU_PROFILE_DIR="${PROFILE_DIR}" start_server --live\n    else\n        start_server --live\n    fi\n')
    expect(SCRIPT.match(/BUN_OPTIONS=/g)).toHaveLength(1)
    const src = (readdirSync(join(REPO, 'src'), { recursive: true }) as string[]).filter(f => /\.[cm]?[jt]s$/.test(f))
    expect(src.filter(f => /cpu-profile|CSCB_TEST_CPU_PROFILE_DIR|SR8_PROFILE_DIR|Profiler\./.test(readFileSync(join(REPO, 'src', f), 'utf8')))).toEqual([])
    // The npm package ships src only, never the test fixtures.
    const files: string[] = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).files
    expect(files.filter(f => f.startsWith('tests') || f.includes(relative(REPO, FIXTURES)))).toEqual([])
  })
})
