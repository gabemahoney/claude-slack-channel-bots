/** The opt-in CPU profile of tests 44, 45 and 32 (tests/integration/fixtures/cpu-profile*.ts):
 * the opt-in gate, the content-free summary over synthetic profiles, the
 * profiler's failure containment over a fake inspector, the real preload
 * sampling a scratch Bun child, and each script's profile steps and opt-in
 * wiring in a stub shell. No scenario or server runs. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import {
  CPU_PROFILE_DIR_ENV, CPU_PROFILE_INTERVAL_US, CPU_PROFILE_LONGEST_CAP_S, CPU_PROFILE_MAX_INTERVAL_US, cpuProfileOptIn, profileCapS, samplingIntervalUs,
  startCpuProfile, summaryLines, summaryReport, type CpuProfile, type ProfilePart, type ProfilerIo,
} from './integration/fixtures/cpu-profile.ts'
import { windowsVerdict } from './integration/fixtures/sr8-evidence.ts'
import { DELIVERY_MAX_AD_CALLS_PER_S } from '../src/delivery-constants.ts'
import { DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS } from '../src/config.ts'

const REPO = join(import.meta.dir, '..')
const FIXTURES = join(import.meta.dir, 'integration/fixtures')
const integrationFile = (file: string) => readFileSync(join(import.meta.dir, 'integration', file), 'utf8')
const SCRIPT = integrationFile('test-44-fmk-thread-burst.sh')
const LOAD = integrationFile('lib/membership-load.sh'), T45 = integrationFile('test-45-fmk-membership-load.sh')
const T48 = integrationFile('test-48-fmk-membership-load-open.sh'), T32 = integrationFile('test-32-fmk-real-order.sh')
function shellFunction(text: string, name: string): string {
  const match = text.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))
  if (!match) throw new Error(`Missing shell function ${name}`)
  return match[0]
}
const CONTEXT = 'scenario=test-44-fmk-thread-burst mode=strict population=0 recipients=1'
const T32_INTERVAL_US = Number(T32.match(/^PROFILE_INTERVAL_US=(\d+)$/m)?.[1])
const T32_CAP_S = Number(T32.match(/^PROFILE_MAX_S=(\d+)$/m)?.[1])
// JSC's sampler sleeps its interval ±20% between samples (its cycle,
// processing included, is at least 80% of the interval), so a profile
// `seconds` long holds at most this many samples.
const retainedSamples = (seconds: number, intervalUs: number) => Math.floor(1.25 * seconds * 1e6 / intervalUs) + 1
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
// The fixtures with the CI image marker redirected to <root>/image, so a
// scratch Bun child under the preload counts as the image's daemon child.
function imageFixtures(): string {
  const fixtures = join(root, 'fixtures'), marker = join(root, 'image')
  mkdirSync(fixtures, { recursive: true }); writeFileSync(marker, '')
  const module = readFileSync(join(FIXTURES, 'cpu-profile.ts'), 'utf8')
  expect(module.split("'/etc/cscb-ci-image'")).toHaveLength(2)
  writeFileSync(join(fixtures, 'cpu-profile.ts'), module.replace("'/etc/cscb-ci-image'", JSON.stringify(marker)))
  writeFileSync(join(fixtures, 'cpu-profile-preload.ts'), readFileSync(join(FIXTURES, 'cpu-profile-preload.ts')))
  return fixtures
}
const iso = (ms: number) => new Date(ms).toISOString()

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

describe('cpu-profile sample slices (synthetic profile, samples.tsv)', () => {
  // One continuous part from T to T+700 ms; its six samples fall at T+100 …
  // T+600 ms. Two intervals: `sample` [T+50, T+250) holds the two clone
  // samples, `hung-lookup` [T+250, T+450) the two handler samples, and the
  // last two are `between`.
  const T = Date.parse('2026-11-08T00:00:00.000Z')
  const part = (startTime: number, checkpoints: Partial<ProfilePart> = {}): ProfilePart => ({ wave: 'thread-samples', startLagMs: 10, stopLagMs: 10,
    startRequestedAt: iso(T - 2), startedAt: iso(T), stopRequestedAt: iso(T + 700), ...checkpoints,
    profile: profile([5, 5, 3, 3, 4, 1], [100_000, 100_000, 100_000, 100_000, 100_000, 100_000], startTime, startTime + 700_000) })
  const write = (p: ProfilePart, intervals = `sample\t${T + 50}\t${T + 250}\nhung-lookup\t${T + 250}\t${T + 450}\n`, savedAt: number | null = T + 705) => {
    const dir = join(root, 'cpu-profile')
    writeProfile(dir, [p], 'thread-samples\nend\n', 1)
    writeFileSync(join(dir, 'samples.tsv'), intervals)
    if (savedAt !== null) writeFileSync(join(dir, 'observer.jsonl'), JSON.stringify({ phase: 'saved', name: 'part-0000-thread-samples.json', ts: iso(savedAt) }) + '\n')
    return summaryReport(dir, CONTEXT)
  }
  const head = (slice: string, samples: number, durationMs: number) =>
    `recorded: cpu-profile ${CONTEXT} wave=${slice} parts=1 samples=${samples} weight_ms=${samples * 100} duration_ms=${durationMs} start_lag_ms=unknown stop_lag_ms=unknown`
  const whole = (p: ProfilePart) => [`recorded: cpu-profile ${CONTEXT} wave=none outcome=complete parts=1 split=reliable max_lag_ms=10`, ...summaryLines(CONTEXT, [p])]

  test.each([
    ['on the epoch clock (as Bun records it)', T * 1000, 'epoch'],
    ['on another clock, anchored at the part\'s start', 5_000_000, 'anchored'],
  ])('delimits the samples by their intervals after the whole-profile summary: %s', (_name, startTime, clock) => {
    const lines = write(part(startTime))
    const slices = lines.indexOf(`recorded: cpu-profile ${CONTEXT} wave=none slices=2 clock=${clock} checkpoint_overlap=0`)
    expect(lines.slice(0, slices)).toEqual(whole(part(startTime)))
    const heads = lines.slice(slices + 1).filter(l => l.startsWith(`recorded: cpu-profile ${CONTEXT} `))
    expect(heads).toEqual([head('sample', 2, 200), head('hung-lookup', 2, 200), head('between', 2, 300)])
    const top = (slice: string) => lines.slice(slices).find(l => l.startsWith(`recorded: cpu-profile-function ${CONTEXT} wave=${slice} by=self rank=1 `))
    expect(top('sample')).toEndWith(' function=structured_Clone@(native)')
    expect(top('hung-lookup')).toEndWith(' function=handleEvent@claude-slack-channel-bots/src/socket.ts:10')
  })

  test.each([
    ['no checkpoint inside an interval', {}, T + 705, '0'],
    ['the start answered inside the first interval', { startRequestedAt: iso(T + 40), startedAt: iso(T + 60) }, T + 705, '1'],
    ['the stop saved inside the second interval', { stopRequestedAt: iso(T + 440) }, T + 460, '1'],
    ['both', { startRequestedAt: iso(T + 40), startedAt: iso(T + 60), stopRequestedAt: iso(T + 440) }, T + 460, '2'],
    ['a part without its start request time', { startRequestedAt: undefined }, T + 705, 'unknown'],
    ['no saved time from the observer', {}, null, 'unknown'],
  ] as const)('counts the intervals a checkpoint overlaps: %s', (_name, checkpoints, savedAt, overlap) => {
    expect(write(part(T * 1000, checkpoints), undefined, savedAt)).toContain(`recorded: cpu-profile ${CONTEXT} wave=none slices=2 clock=epoch checkpoint_overlap=${overlap}`)
  })

  test.each([
    ['a missing end', `sample\t${T}\n`], ['an end before its start', `sample\t${T + 2}\t${T + 1}\n`],
    ['a malformed wave', `Sample\t${T}\t${T + 1}\n`], ['an extra field', `sample\t${T}\t${T + 1}\tx\n`], ['no interval', ''],
  ])('an unreadable samples.tsv (%s) adds one line and no slice', (_name, intervals) => {
    const lines = write(part(T * 1000), intervals)
    expect(lines).toEqual([...whole(part(T * 1000)), `recorded: cpu-profile ${CONTEXT} wave=none slices=unreadable clock=unavailable checkpoint_overlap=unknown`])
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
    const calls: string[] = [], params: Record<string, object> = {}, timers: { tick: () => Promise<void>; cancelled: boolean }[] = []
    const fault = (f: Fault) => { if (faults.includes(f)) throw new Error(`injected ${f}`) }
    const io: ProfilerIo = {
      session: () => {
        fault('construct')
        return {
          connect: () => { calls.push('connect'); fault('connect') },
          disconnect: () => { calls.push('disconnect'); fault('disconnect') },
          post: (method, sent, callback) => {
            calls.push(method); params[method] = sent
            if (faults.includes(method as Fault)) callback(new Error(`injected ${method}`), undefined)
            else callback(null, method === 'Profiler.stop' ? { profile: profile([3], [1000], 0, 1000) } : {})
          },
        }
      },
      every: tick => { const timer = { tick, cancelled: false }; timers.push(timer); return timer },
      cancel: timer => { (timer as { cancelled: boolean }).cancelled = true },
      write: (file, text) => { fault('marker'); writeFileSync(file, text) },
      append: (file, text) => { fault('observer'); appendFileSync(file, text) },
      now: () => clock.ms,
    }
    const clock = { ms: 0 }
    return { io, calls, params, timers, clock }
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

  test.each([
    ['no interval file: the default', undefined, CPU_PROFILE_INTERVAL_US],
    ['test-32\'s 100 ms, the largest allowed', `${T32_INTERVAL_US}\n`, CPU_PROFILE_MAX_INTERVAL_US],
    ['10 ms', '10000\n', 10_000],
    ...['999', `${CPU_PROFILE_MAX_INTERVAL_US + 1}`, '10 ms', '1e4', '-10000', ''].map(text => [`unusable ${JSON.stringify(text)}: the default`, text, CPU_PROFILE_INTERVAL_US] as const),
  ])('samples at the directory\'s interval and records it: %s', async (_name, file, us) => {
    const dir = join(root, 'cpu-profile')
    mkdirSync(dir)
    if (file !== undefined) writeFileSync(join(dir, 'interval-us'), file)
    const fake = fakeIo([])
    await startCpuProfile(dir, fake.io)
    expect(fake.params['Profiler.setSamplingInterval']).toEqual({ interval: us })
    writeFileSync(join(dir, 'waves'), 'thread-samples\nend\n')
    await fake.timers[0]!.tick()
    expect(fake.calls.slice(init.length)).toEqual(['Profiler.start', 'Profiler.stop', 'disconnect'])
    expect(JSON.parse(readFileSync(join(dir, 'part-0000-thread-samples.json'), 'utf8')).intervalUs).toBe(us)
    expect(JSON.parse(readFileSync(join(dir, 'observer.jsonl'), 'utf8').split('\n')[0]!)).toMatchObject({ phase: 'ready', intervalUs: us })
  })

  test('test-32\'s cap stops sampling at its first poll that long after the start, once, saving the wave; later polls do nothing, and end completes it as capped', async () => {
    const scratch = join(root, 'evidence'), dir = join(scratch, 'cpu-profile'), capMs = T32_CAP_S * 1000
    // The script's own profile_open writes the interval and the cap.
    expect(stubShell(t32Program(OPEN_ONLY), scratch)).toEqual({ status: 0, stdout: '', stderr: '' })
    const fake = fakeIo([]), tick = () => fake.timers[0]!.tick(), after = () => fake.calls.slice(init.length)
    await startCpuProfile(dir, fake.io)
    // The cap counts from the start's request, not from the profiler's ready.
    fake.clock.ms = 1000
    await tick()
    writeFileSync(join(dir, 'waves'), 'thread-samples\n')
    await tick()
    fake.clock.ms = 1000 + capMs - 1
    await tick()
    expect(after()).toEqual(['Profiler.start'])
    fake.clock.ms = 1000 + capMs
    await tick()
    expect(after()).toEqual(['Profiler.start', 'Profiler.stop'])
    expect(JSON.parse(readFileSync(join(dir, 'part-0000-thread-samples.json'), 'utf8')))
      .toMatchObject({ wave: 'thread-samples', intervalUs: T32_INTERVAL_US, cappedAfterMs: capMs, stopLagMs: 0 })
    expect(JSON.parse(readFileSync(join(dir, 'observer.jsonl'), 'utf8').trim().split('\n').at(-1)!))
      .toMatchObject({ phase: 'capped', wave: 'thread-samples', name: 'part-0000-thread-samples.json', afterMs: capMs })
    fake.clock.ms += 10 * capMs
    await tick()
    appendFileSync(join(dir, 'waves'), 'end\n')
    await tick()
    expect(after()).toEqual(['Profiler.start', 'Profiler.stop', 'disconnect'])
    expect(JSON.parse(readFileSync(join(dir, 'complete.json'), 'utf8'))).toEqual({ parts: 1, capped: true })
    expect(summaryReport(dir, CONTEXT32)[0]).toBe(`recorded: cpu-profile ${CONTEXT32} wave=none outcome=capped parts=1 split=reliable max_lag_ms=0`)
  })

  test('without a cap, or with an unusable one, a long wave is sampled until end', async () => {
    for (const file of [undefined, '0', `${CPU_PROFILE_LONGEST_CAP_S + 1}`, '1e2', '-5', '300 s', '']) {
      rmSync(join(root, 'cpu-profile'), { recursive: true, force: true })
      const dir = join(root, 'cpu-profile')
      mkdirSync(dir)
      if (file !== undefined) writeFileSync(join(dir, 'max-seconds'), file)
      expect(profileCapS(dir)).toBeUndefined()
      const fake = fakeIo([])
      await startCpuProfile(dir, fake.io)
      writeFileSync(join(dir, 'waves'), 'thread-samples\n')
      await fake.timers[0]!.tick()
      fake.clock.ms = (CPU_PROFILE_LONGEST_CAP_S + 1) * 1000
      await fake.timers[0]!.tick()
      expect(fake.calls.slice(init.length)).toEqual(['Profiler.start'])
      appendFileSync(join(dir, 'waves'), 'end\n')
      await fake.timers[0]!.tick()
      expect(JSON.parse(readFileSync(join(dir, 'complete.json'), 'utf8'))).toEqual({ parts: 1 })
    }
  })
})

describe('cpu-profile preload (scratch Bun child, CI image marker redirected)', () => {
  // The child stands in for the daemon and marks each wave as sr8 burst does.
  // `profiled` waits for the preload's `started` before each wave's own hot
  // function; `one-wave` does the same for test-32's one wave;
  // `held` runs the work at once without yielding, so the preload's
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
  if (mode !== 'profiled' && mode !== 'one-wave') return
  await until(() => observed().some(e => e.phase === 'started' && e.wave === name))
  const end = performance.now() + 120
  while (performance.now() < end) { work(); await yieldLoop() }
}
if (mode === 'one-wave') await wave('thread-samples', rootsWork)
else { await wave('roots', rootsWork); await wave('replies-drops', repliesWork) }
appendFileSync(join(dir, 'waves'), 'end\\n')
if (mode !== 'plain') await until(() => existsSync(join(dir, 'complete.json')) || existsSync(join(dir, 'error.txt')))
console.log('done')
`
  function run(env: Record<string, string>, mode: 'profiled' | 'one-wave' | 'held' | 'plain', subcommand = 'start', fault?: string, files: Record<string, string> = {}) {
    const fixtures = imageFixtures(), dir = join(root, 'cpu-profile')
    mkdirSync(dir)
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
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
    // Each part records its checkpoints in order, and Bun's profile clock is
    // the epoch clock, so an interval over the roots part slices out its work.
    const part = JSON.parse(readFileSync(join(dir, 'part-0000-roots.json'), 'utf8'))
    const times = [part.startRequestedAt, part.startedAt, part.stopRequestedAt, part.stoppedAt].map(t => Date.parse(t))
    expect(times.every(Number.isFinite)).toBe(true)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    writeFileSync(join(dir, 'samples.tsv'), `sample\t${times[1]}\t${times[2]}\n`)
    const sliced = summaryReport(dir, CONTEXT)
    expect(sliced).toContain(`recorded: cpu-profile ${CONTEXT} wave=none slices=1 clock=epoch checkpoint_overlap=1`)
    expect(sliced.find(l => l.startsWith(`recorded: cpu-profile-function ${CONTEXT} wave=sample by=self rank=1 `))).toMatch(/ function=rootsWork@\S+\/server\.ts:\d+$/)
  })

  test('test-32\'s interval and cap: the real inspector accepts the interval, and a wave that ends first is saved whole, not capped', () => {
    const { dir } = run({ _CLI_DAEMON_CHILD: '1' }, 'one-wave', 'start', undefined, { 'interval-us': `${T32_INTERVAL_US}\n`, 'max-seconds': `${T32_CAP_S}\n` })
    expect(readdirSync(dir).sort()).toEqual(['complete.json', 'interval-us', 'max-seconds', 'observer.jsonl', 'part-0000-thread-samples.json', 'waves'])
    expect(JSON.parse(readFileSync(join(dir, 'complete.json'), 'utf8'))).toEqual({ parts: 1 })
    const part = JSON.parse(readFileSync(join(dir, 'part-0000-thread-samples.json'), 'utf8'))
    expect(part).toMatchObject({ wave: 'thread-samples', intervalUs: T32_INTERVAL_US })
    expect(part).not.toHaveProperty('cappedAfterMs')
    expect(Array.isArray(part.profile.nodes) && Array.isArray(part.profile.samples)).toBe(true)
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

  test.each([null, '', '0', 'true', '01', '1'])('diagnostics=%j controls timings, measured preload, wave observers and cleanup without changing the burst verdict', diagnostics => {
    const on = diagnostics === '1', evidence = join(root, 'evidence')
    mkdirSync(evidence)
    // Execute the real config/profile block, measured and unmeasured starts,
    // burst submission and final observe/check boundary with inert dependencies.
    const config = SCRIPT.slice(SCRIPT.indexOf('config_args=('), SCRIPT.indexOf('# Test-only CPU profile'))
    const burst = SCRIPT.slice(SCRIPT.indexOf('        burst_status=0'), SCRIPT.indexOf('        # Observe zero'))
    const verdict = SCRIPT.slice(SCRIPT.indexOf('        # Latency decomposition only:'), SCRIPT.indexOf('        ;;\n    pending)'))
    const program = `${HARNESS}
mode=strict population=0 recipients=1 CASE_ROOT="$1/people" SCENARIO_PORT=0 compact_ms=250 SR8=/sr8
RESULTS="$1/burst" BATCH=/batch SCENARIO_SLACK_STUB_URL=/stub SCENARIO_SLACK_RECORD=/record SLACK_STATE_DIR="$1/state"
MEASUREMENTS=/measurements measurement_mark=0 SERVER_PID=11 SLACK_PID=22 BURST_DRIVER=/driver
OVERRIDES_STEM=o KEYS=(alpha)
bun() { printf 'bun %s\\n' "$*"; return 0; }
write_config() { cat; }
printed() { printf 'recorder\\n'; }
matcher() { printf '%s\\n' "$*"; }
completion_match() { printf 'complete\\n'; }
count_log() { printf '0\\n'; }
mono_ms() { printf '7\\n'; }
wait_for_count() { printf 'wait %s\\n' "$1"; }
expect_one_overrides_line() { :; }
wait_membership_complete() { :; }
start_server() { printf 'start %s profile=%s\\n' "$*" "\${CSCB_TEST_CPU_PROFILE_DIR:-off}"; }
bash() { printf 'driver cpu=%s pids=%s profile=%s\\n' "\${SR8_PHASE_CPU_FILE:-off}" "\${SR8_PHASE_CPU_PIDS:-off}" "\${SR8_PROFILE_DIR:-off}"; return 7; }
sr8_verdicts() { printf 'verdict %s\\n' "$1"; }
${config}${block()}
${shellFunction(SCRIPT, 'start_ready')}
printf 'hooks=%s\\n' "\${hooks[*]}"
start_ready
sr8_verdicts seal first
start_ready measured
sr8_verdicts seal measured
${burst}
start_ready
sr8_verdicts seal measured
${verdict}
`
    const child = spawnSync('bash', ['--noprofile', '--norc', '-c', program, 'test-44', evidence, FIXTURES], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'mkdir', 'cat'], extras: diagnostics === null ? {} : { CSCB_TEST_DIAGNOSTICS: diagnostics } }),
      encoding: 'utf8', timeout: 10_000 })
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
    expect(child.status).toBe(1)
    expect(child.stderr).toBe('FAIL: burst submission or ACK observation failed\n')
    const lines = child.stdout.trim().split('\n')
    expect(lines[0]).toBe(`bun /sr8 config strict 0 1 ${evidence}/people 0 250${on ? ' timings' : ''}`)
    expect(lines.filter(l => l.startsWith('hooks='))).toEqual([`hooks=${on ? 'profile_summary' : ''}`])
    expect(lines.filter(l => l.startsWith('start '))).toEqual([
      'start --live profile=off', `start --live profile=${on ? `${evidence}/cpu-profile` : 'off'}`, 'start --live profile=off',
    ])
    expect(lines.filter(l => l.startsWith('wait recorder'))).toHaveLength(3)
    expect(lines.filter(l => l.startsWith('verdict '))).toEqual(['verdict seal', 'verdict seal', 'verdict seal', 'verdict check'])
    expect(lines.find(l => l.startsWith('driver '))).toBe(on
      ? `driver cpu=${evidence}/burst/phase-cpu.jsonl pids=server=11,stub=22 profile=${evidence}/cpu-profile`
      : 'driver cpu=off pids=off profile=off')
    expect(lines.filter(l => l.startsWith('bun /sr8 observe'))).toHaveLength(on ? 1 : 0)
    expect(lines.filter(l => l.includes('/cpu-profile.ts stop '))).toHaveLength(on ? 1 : 0)
    expect(lines.filter(l => l.includes('/cpu-profile.ts summary '))).toHaveLength(on ? 1 : 0)
    expect(readdirSync(evidence)).toEqual(on ? ['cpu-profile'] : [])
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
      env: hostSafeChildEnv(root, { tools: ['bash', 'mkdir'], extras: { BUN: process.execPath, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', CSCB_TEST_DIAGNOSTICS: '1' } }),
      encoding: 'utf8', timeout: 10_000 })
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
    expect({ status: child.status, stdout: child.stdout, stderr: child.stderr })
      .toEqual({ status, stdout: stdout(join(evidence, 'cpu-profile')).join('\n') + '\n', stderr })
  })
})

// scenario.sh's before-cleanup semantics, as in test-44's rows: each hook runs
// in a subshell, its status ignored, and the exit status kept. $1 is the
// scratch directory, $2 the fixtures directory.
const CLEANUP_HARNESS = `set -euo pipefail
bun() { "\${BUN}" "$@"; }
hooks=()
on_before_cleanup() { hooks+=("$1"); }
fail() { echo "FAIL: $1" >&2; exit 1; }
cleanup() { local rc=$? hook; set +e; trap - EXIT; for hook in \${hooks[@]+"\${hooks[@]}"}; do ( "\${hook}" ); done; exit "\${rc}"; }
trap cleanup EXIT
SCENARIO_FIXTURES="$2"
`
function stubShell(program: string, scratch: string, fixtures = FIXTURES) {
  const child = spawnSync('bash', ['--noprofile', '--norc', '-c', program, 'stub', scratch, fixtures], {
    env: hostSafeChildEnv(root, { tools: ['bash', 'mkdir', 'cat', 'sleep'], extras: { BUN: process.execPath, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } }),
    encoding: 'utf8', timeout: 10_000 })
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
  return { status: child.status, stdout: child.stdout, stderr: child.stderr }
}
// A profiler CLI whose stop and summary both exit 3, over a profile with a marked wave.
const failingProfiler = (scratch: string) => {
  mkdirSync(join(scratch, 'fixtures'), { recursive: true }); writeFileSync(join(scratch, 'fixtures/cpu-profile.ts'), 'process.exit(3)\n')
  mkdirSync(join(scratch, 'cpu-profile')); writeFileSync(join(scratch, 'cpu-profile/waves'), 'roots\n')
  return join(scratch, 'fixtures')
}
// A script's profile block, from its header comment through the line holding `last`.
function scriptBlock(text: string, last: string): string {
  const start = text.indexOf('# Test-only CPU profile'), end = text.indexOf('\n', text.indexOf(last, start)) + 1
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  return text.slice(start, end)
}
const loadBlock = () => scriptBlock(LOAD, 'membership_profile_cleanup() {')
const t32Block = () => scriptBlock(T32, 'on_before_cleanup profile_cleanup')
// [name, prepare the scratch directory (answers a fixtures directory), steps, status, stdout lines given the profile dir, stderr]
type StepRow = [string, (scratch: string) => string | void, string, number, (dir: string) => string[], string]
const STOPPED_TWO = 'recorded: cpu-profile-stop outcome=complete parts=2'
const FAILED_PROFILER = ['recorded: cpu-profile stop unavailable', 'recorded: cpu-profile summary unavailable']
const unmakeable = (scratch: string) => { writeFileSync(scratch, ''); return undefined }
// The cleanup hook's stop bound in these rows, where no profiler ever answers.
const CLEANUP_STOP_S = '0.2'
const TIMED_OUT_ONE = 'recorded: cpu-profile-stop outcome=timeout parts=1'

const C45 = ['test-45-fmk-membership-load-strict-first-hang', 'strict', '100000', '2']
const CONTEXT45 = `scenario=${C45[0]} mode=strict population=100000 recipients=2`
// As run_membership_load registers the hook and each case opens its profile.
const t45Program = (kind: string, steps: string) => `${CLEANUP_HARNESS}ROOT="$1"\nCASE_KIND=${kind}\nC=(${C45.join(' ')})\n${loadBlock()}
MEMBERSHIP_PROFILE_CLEANUP_STOP_S=${CLEANUP_STOP_S}\nMEMBERSHIP_PROFILE_CASE=first-hang\non_before_cleanup membership_profile_cleanup\nmembership_profile_open\n${steps}\n`
const CONTEXT32 = 'scenario=test-32-fmk-real-order mode=strict population=100000 recipients=2'
const t32Program = (steps: string, diagnostics: string | null = '1') => `${CLEANUP_HARNESS}${diagnostics === null ? '' : `CSCB_TEST_DIAGNOSTICS=${JSON.stringify(diagnostics)}\n`}REAL_THREAD_EVIDENCE="$1"\nREAL_THREAD_CONTEXT=(test-32-fmk-real-order strict 100000 2)
${t32Block()}PROFILE_CLEANUP_STOP_S=${CLEANUP_STOP_S}\n${steps}\n`
// Only test-32's profile_open, which writes the profile directory; the hook then collects nothing.
const OPEN_ONLY = 'profile_open\nPROFILE_DIR=""'

describe('test-45 profile steps (stub shell)', () => {
  const program = t45Program
  const complete = (scratch: string) => writeProfile(join(scratch, 'cpu-profile'), [roots, replies], 'roots\nreplies-drops\nend\n', 2)

  test('the profile is collected right after the burst and ordered writes, before any verdict', () => {
    const body = shellFunction(LOAD, 'run_membership_load')
    const collect = body.indexOf('        membership_profile_collect 30\n')
    expect(collect).toBeGreaterThan(body.indexOf('wait "${BURST_PID}" || fail'))
    expect(collect).toBeLessThan(body.indexOf('two membership failures did not settle'))
    expect(LOAD.match(/^\s*membership_profile_(open|collect)\b(?!\(\)).*$/gm)?.map(l => l.trim())).toEqual(['membership_profile_open', 'membership_profile_collect 30'])
    // Each case opens (or clears) its profile before its first server start.
    expect(body.indexOf('        membership_profile_open\n')).toBeGreaterThan(body.indexOf('mkdir -p "${BATCH}" "${WRITES}"'))
    expect(body.indexOf('        membership_profile_open\n')).toBeLessThan(body.indexOf('start_ready'))
  })

  test.each<StepRow>([
    ['a verdict after the profile is collected fails', complete, 'membership_profile_collect 30\nfail "sr8 membership-writes verdict did not pass"',
      1, dir => [STOPPED_TWO, ...summaryReport(dir, CONTEXT45)], 'FAIL: sr8 membership-writes verdict did not pass\n'],
    ['the burst fails with one part saved and no profiler answering the hook\'s stop', scratch => writeProfile(join(scratch, 'cpu-profile'), [roots], 'roots\n'),
      'fail "full original burst did not complete"', 1, dir => [TIMED_OUT_ONE, ...summaryReport(dir, CONTEXT45)], 'FAIL: full original burst did not complete\n'],
    ['the case fails before any wave is marked, so the hook only summarizes', () => undefined, 'fail "two-persona startup incomplete"',
      1, dir => summaryReport(dir, CONTEXT45), 'FAIL: two-persona startup incomplete\n'],
    ['the case passes', complete, 'membership_profile_collect 30', 0, dir => [STOPPED_TWO, ...summaryReport(dir, CONTEXT45)], ''],
    ['the stop and the summarizer fail in the cleanup hook', failingProfiler, 'exit 4', 4, () => FAILED_PROFILER, ''],
    ['the profile directory cannot be made', unmakeable,
      'membership_profile_collect 30\necho continued', 0, () => ['recorded: cpu-profile unavailable reason=profile-directory', 'continued'], ''],
  ])('prints the summary once and keeps the script\'s status: %s', (_name, prepare, steps, status, stdout, stderr) => {
    const scratch = join(root, 'case')
    const fixtures = prepare(scratch)
    expect(stubShell(program('first-hang', steps), scratch, fixtures ?? FIXTURES))
      .toEqual({ status, stdout: stdout(join(scratch, 'cpu-profile')).join('\n') + '\n', stderr })
  })

  test.each(['later-hang', 'first-transient', 'undurable'])('another case (%s) opens no profile, so its steps and hook do nothing', kind => {
    const scratch = join(root, 'case')
    mkdirSync(scratch)
    expect(stubShell(program(kind, 'membership_profile_collect 30\nfail "later verdict"'), scratch))
      .toEqual({ status: 1, stdout: '', stderr: 'FAIL: later verdict\n' })
    expect(readdirSync(scratch)).toEqual([])
  })

  test('a profiled case after the first leaves no profile for the next case or its hook', () => {
    const scratch = join(root, 'case')
    complete(scratch)
    const run = stubShell(program('first-hang', 'membership_profile_collect 30\nCASE_KIND=later-hang\nmembership_profile_open\nfail "later verdict"'), scratch)
    expect(run).toEqual({ status: 1, stdout: [STOPPED_TWO, ...summaryReport(join(scratch, 'cpu-profile'), CONTEXT45)].join('\n') + '\n', stderr: 'FAIL: later verdict\n' })
  })
})

describe('test-45/48 profile opt-in (run_membership_load in a stub shell)', () => {
  // The real library sourced; run_membership_load runs until its first case's
  // state directory, where the stub reports the case's profile and stops.
  const run = (diagnostics: string | null, ...args: string[]) => {
    writeFileSync(join(root, 'membership-load.sh'), LOAD)
    const program = `set -euo pipefail
log() { printf '%s\\n' "$*" >> "$HOME/calls"; }
require_ci_image() { :; }
require_scenario_home() { :; }
on_exit() { :; }
on_before_cleanup() { log "hook $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }
overrides_stem() { printf 'stem\\n'; }
new_state_dir() { log "case=\${CASE_KIND} profile=\${MEMBERSHIP_PROFILE_DIR#"$HOME/"}"; cat "$HOME/calls"; exit 0; }
SCENARIO_ROOT="$HOME" SCENARIO_FIXTURES="$HOME/fixtures" TEST_NAME=test-45-fmk-membership-load
source "$HOME/membership-load.sh"
bun() { :; }
printed() { printf '1\\n'; }
run_membership_load "$@"
`
    const child = spawnSync('bash', ['--noprofile', '--norc', '-c', program, 'stub', ...args], {
      env: hostSafeChildEnv(root, { tools: ['bash', 'mkdir', 'cat'], extras: diagnostics === null ? {} : { CSCB_TEST_DIAGNOSTICS: diagnostics } }), encoding: 'utf8', timeout: 10_000 })
    expect(child.error).toBeUndefined(); expect(child.signal).toBeNull()
    return { status: child.status, stdout: child.stdout, stderr: child.stderr }
  }

  test('test-45\'s option registers the profile\'s cleanup hook and profiles its first-hang case', () => {
    expect(run('1', 'strict', 'hang', '--cpu-profile', 'first-hang')).toEqual({ status: 0, stderr: '',
      stdout: 'hook reopen_observe\nhook membership_profile_cleanup\ncase=first-hang profile=strict-first-hang/cpu-profile\n' })
    expect(readdirSync(join(root, 'strict-first-hang')).sort()).toEqual(['batch', 'cpu-profile', 'writes'])
  })

  test('test-48\'s plain call registers no profile hook and profiles nothing', () => {
    expect(run('1', 'open', 'hang')).toEqual({ status: 0, stderr: '', stdout: 'hook reopen_observe\ncase=first-hang profile=\n' })
    expect(readdirSync(join(root, 'open-first-hang')).sort()).toEqual(['batch', 'writes'])
  })

  test.each([null, '', '0', 'true', '01'])('diagnostics=%j leaves test-45 unprofiled despite its first-hang option', diagnostics => {
    expect(run(diagnostics, 'strict', 'hang', '--cpu-profile', 'first-hang'))
      .toEqual({ status: 0, stderr: '', stdout: 'hook reopen_observe\ncase=first-hang profile=\n' })
    expect(readdirSync(join(root, 'strict-first-hang')).sort()).toEqual(['batch', 'writes'])
  })

  test.each(['strict', 'open'])('diagnostics on does not add profiling to a plain %s group', mode => {
    expect(run('1', mode, 'transient')).toEqual({ status: 0, stderr: '', stdout: 'hook reopen_observe\ncase=first-transient profile=\n' })
    expect(readdirSync(join(root, `${mode}-first-transient`)).sort()).toEqual(['batch', 'writes'])
  })

  test.each([
    [['strict']], [['strict', 'hang', '--cpu-profile']], [['strict', 'hang', '--cpu-profile', '']], [['strict', 'hang', '--profile', 'first-hang']],
    [['strict', 'hang', '--cpu-profile', 'first-hang', 'extra']], [['both', 'hang', '--cpu-profile', 'first-hang']],
    [['open', 'hang', '--cpu-profile', 'first-hang']], [['strict', 'transient', '--cpu-profile', 'first-hang']],
    [['strict', 'hang', '--cpu-profile', 'later-hang']],
  ])('refuses %j before any hook or case', args => {
    expect(run('1', ...args)).toEqual({ status: 1, stdout: '', stderr: 'FAIL: membership load requires a channel mode and fault group, optionally --cpu-profile first-hang for strict hang\n' })
  })

  test('start_ready runs only the profiled case\'s measured start with the preload', () => {
    const program = (dir: string, mode: string) => [
      'set -euo pipefail', 'log() { printf \'%s\\n\' "$*"; }', 'count_log() { printf "0\\n"; }', 'completion_match() { printf "complete\\n"; }',
      'matcher() { printf "%s\\n" "$*"; }', 'printed() { printf "recorder\\n"; }', 'mono_ms() { printf "7\\n"; }',
      'start_server() { log "start $* BUN_OPTIONS=${BUN_OPTIONS:-none} dir=${CSCB_TEST_CPU_PROFILE_DIR:-none}"; }',
      'wait_for_count() { :; }', 'expect_one_overrides_line() { :; }', 'session_barrier_mark() { :; }', 'session_barrier_wait() { :; }',
      'wait_membership_complete() { :; }', 'stub_session_list_tools() { :; }',
      shellFunction(LOAD, 'start_ready'), `KEYS=(alpha) ROOT="$HOME" OVERRIDES_STEM=o MEASUREMENTS=m SCENARIO_FIXTURES=/fx MEMBERSHIP_PROFILE_DIR=${dir}`,
      `start_ready ${mode}`, 'printf "%s\\n" "${BUN_OPTIONS:-unset} ${CSCB_TEST_CPU_PROFILE_DIR:-unset}"',
    ].join('\n')
    const start = (dir: string, mode: string) => {
      const child = spawnSync('bash', ['--noprofile', '--norc', '-c', program(dir, mode)], { env: hostSafeChildEnv(root, { tools: ['bash'] }), encoding: 'utf8', timeout: 10_000 })
      expect(child.stderr).toBe('')
      return child.stdout
    }
    expect(start('/scratch/cpu-profile', 'measured')).toBe('start --live BUN_OPTIONS=--preload /fx/cpu-profile-preload.ts dir=/scratch/cpu-profile\nunset unset\n')
    expect(start('/scratch/cpu-profile', '')).toBe('start --live BUN_OPTIONS=none dir=none\nunset unset\n')
    expect(start("''", 'measured')).toBe('start --live BUN_OPTIONS=none dir=none\nunset unset\n')
  })
})

describe('test-32 profile steps (stub shell)', () => {
  const program = t32Program
  const complete = (scratch: string) => writeProfile(join(scratch, 'cpu-profile'), [roots, replies], 'roots\nreplies-drops\nend\n', 2)

  test.each([null, '', '0', 'true', '01', '1'])('diagnostics=%j controls profile creation, hook, measured preload, sample metadata and waits', diagnostics => {
    const on = diagnostics === '1', scratch = join(root, 'evidence')
    mkdirSync(scratch)
    const start = T32.indexOf('    profile_open\n'), end = T32.indexOf('\n', T32.indexOf('    THREAD_READY_MS=', start))
    const steps = `
real_thread_now_ms() { printf '7\\n'; }
start_server() {
    printf 'start %s profile=%s\\n' "$*" "\${CSCB_TEST_CPU_PROFILE_DIR:-off}"
    if [[ -n "\${CSCB_TEST_CPU_PROFILE_DIR:-}" ]]; then printf '{"phase":"started"}\\n' > "\${CSCB_TEST_CPU_PROFILE_DIR}/observer.jsonl"; fi
}
bun() { printf 'profiler %s\\n' "$2"; }
sleep() { echo 'unexpected profile wait' >&2; exit 9; }
start_server --live
${T32.slice(start, end)}
REAL_THREAD_DELAYED_TS=7 REAL_THREAD_HUNG_TS=14
profile_begin
profile_sample_begin
profile_sample_end 7
profile_end
profile_collect 30
printf 'hooks=%s\\n' "\${hooks[*]}"
fail 'workload failed'
`
    expect(stubShell(program(steps, diagnostics), scratch)).toEqual({ status: 1, stderr: 'FAIL: workload failed\n',
      stdout: ['start --live profile=off', `start --live profile=${on ? `${scratch}/cpu-profile` : 'off'}`,
        ...(on ? ['profiler stop', 'profiler summary'] : []), `hooks=${on ? 'profile_cleanup' : ''}`].join('\n') + '\n' })
    expect(readdirSync(scratch)).toEqual(on ? ['cpu-profile'] : [])
    if (on) {
      const dir = join(scratch, 'cpu-profile')
      expect(readdirSync(dir).sort()).toEqual(['interval-us', 'max-seconds', 'observer.jsonl', 'samples.tsv', 'waves'])
      expect(readFileSync(join(dir, 'waves'), 'utf8')).toBe('thread-samples\nend\n')
      expect(readFileSync(join(dir, 'samples.tsv'), 'utf8')).toMatch(/^delayed-lookup\t\d+\t\d+\n$/)
      expect([samplingIntervalUs(dir), profileCapS(dir)]).toEqual([100_000, 300])
    }
  })

  test('one wave spans the samples: begun before the active window, ended after the last sample, collected after the empty window and before any verdict; no profile step inside the loop waits', () => {
    const phase = T32.slice(T32.indexOf('for thread_mode in strict open; do'))
    const at = (text: string) => { const i = phase.indexOf(text); expect(i).toBeGreaterThan(0); return i }
    expect(at('    profile_begin\n')).toBeLessThan(at('    THREAD_ACTIVE_START='))
    // Each sample's interval runs from just before its push to its delivery.
    expect(phase).toContain('    for ((sample=1; sample<=20; sample++)); do\n'
      + '        real_wait_latency_admission "${REAL_KEY}" "${sample}"\n        profile_sample_begin\n        THREAD_ENVELOPE="$(real_thread_reply "${sample}")"\n')
    expect(phase).toContain('        real_wait_delivery "${REAL_KEY}" "$((sample+1))"\n        profile_sample_end "${REAL_THREAD_SAMPLES[sample-1]}"\n')
    const loop = phase.slice(at('    for ((sample=1;'), at('\n    done\n'))
    expect(loop.match(/\bprofile_\w+/g)).toEqual(['profile_sample_begin', 'profile_sample_end'])
    for (const step of ['profile_epoch_ms', 'profile_sample_begin', 'profile_sample_end']) expect(shellFunction(T32, step)).not.toMatch(/\b(sleep|wait|bun|for|while)\b/)
    expect(at('    profile_end\n')).toBeGreaterThan(at('\n    done\n'))
    expect(at('    profile_end\n')).toBeLessThan(at('    real_wait_latency_admission "${REAL_KEY}" 21\n'))
    expect(at('    profile_collect 30\n')).toBeGreaterThan(at('> "${REAL_THREAD_EVIDENCE}/active.tsv"'))
    expect(at('    profile_collect 30\n')).toBeLessThan(at('    stop_server --stop-bots\n    THREAD_N2_STATUS=0'))
    expect(T32.match(/^\s*profile_(open|begin|sample_begin|sample_end|end|collect)\b(?! ?\()/gm)?.map(l => l.trim()))
      .toEqual(['profile_open', 'profile_begin', 'profile_sample_begin', 'profile_sample_end', 'profile_end', 'profile_collect'])
    expect(T32.match(/^profile_\w+(?=\(\))/gm)).toEqual(['profile_open', 'profile_started', 'profile_begin', 'profile_epoch_ms',
      'profile_sample_begin', 'profile_sample_end', 'profile_end', 'profile_collect', 'profile_cleanup'])
    expect(T32.indexOf('on_before_cleanup profile_cleanup; fi\n')).toBeLessThan(T32.indexOf('real_prepare'))
  })

  test('the profile\'s memory budget: test-32\'s cap at its interval keeps a profile of deep stacks far under the shard cap beside the server', () => {
    // An empirical budget, not a proved worst case. The cap's enforcement is
    // the capped-profile row above; what it bounds rests on these estimates:
    // - samples: at most retainedSamples(cap), from the sampler's ±20% jitter
    //   (the cap fires at the first 50 ms poll after it, so a server event
    //   loop blocked past the cap keeps sampling until it frees);
    // - per sample: 256 frames (the sampler's initial stack capacity; deeper
    //   stacks grow it) at twice the largest per-frame cost measured, 140 B
    //   (Bun 1.4.3, scratch /tmp/nu-neg/prof-mem.ts);
    // - the server: answers20's peak RSS without the profiler.
    // The rest of the 2 GiB shard cap must hold the shard's other processes
    // and the transient stop/save peak, neither measured here.
    const sampleBytes = 256 * 2 * 140, serverBytes = 1_133_964 * 1024, shardBytes = 2 * 2 ** 30
    const profileBytes = (intervalUs: number) => retainedSamples(T32_CAP_S, intervalUs) * sampleBytes
    expect([T32_INTERVAL_US, T32_CAP_S]).toEqual([100_000, 300])
    expect(retainedSamples(T32_CAP_S, T32_INTERVAL_US)).toBe(3751)
    expect(profileBytes(T32_INTERVAL_US)).toBeLessThan(257 * 2 ** 20)
    // That leaves more than 680 MiB, over 2.5 times the profile itself.
    expect(shardBytes - serverBytes - profileBytes(T32_INTERVAL_US)).toBeGreaterThan(680 * 2 ** 20)
    expect(shardBytes - serverBytes - profileBytes(T32_INTERVAL_US)).toBeGreaterThan(2.5 * profileBytes(T32_INTERVAL_US))
    // The same cap at the 1 ms default would not fit beside the server.
    expect(serverBytes + profileBytes(CPU_PROFILE_INTERVAL_US)).toBeGreaterThan(shardBytes)
  })

  test('without a profile every step does nothing, and with an unwritable one nothing waits, fails or prints', () => {
    const scratch = join(root, 'evidence')
    mkdirSync(scratch)
    const steps = 'REAL_THREAD_DELAYED_TS=7 REAL_THREAD_HUNG_TS=14\nprofile_begin\nprofile_sample_begin\nprofile_sample_end 7\nprofile_end\n'
    expect(stubShell(program(`${steps}profile_collect 30\necho continued`), scratch)).toEqual({ status: 0, stdout: 'continued\n', stderr: '' })
    expect(readdirSync(scratch)).toEqual([])
    expect(stubShell(program(`PROFILE_DIR="$1/absent"\n${steps}PROFILE_DIR=""\necho continued`), scratch)).toEqual({ status: 0, stdout: 'continued\n', stderr: '' })
    expect(readdirSync(scratch)).toEqual([])
  })

  test.each<StepRow>([
    ['a gate after the profile is collected fails', complete, 'profile_open\nprofile_collect 30\nfail "SR-8 real-thread evidence failed"',
      1, dir => [STOPPED_TWO, ...summaryReport(dir, CONTEXT32)], 'FAIL: SR-8 real-thread evidence failed\n'],
    ['a sample fails with one part saved and no profiler answering the hook\'s stop', scratch => writeProfile(join(scratch, 'cpu-profile'), [roots], 'roots\n'),
      'profile_open\nfail "concurrent membership/write work failed"', 1, dir => [TIMED_OUT_ONE, ...summaryReport(dir, CONTEXT32)], 'FAIL: concurrent membership/write work failed\n'],
    ['the script fails before any thread phase opens a profile', () => undefined, 'fail "real launch failed"', 1, () => [], 'FAIL: real launch failed\n'],
    ['the phase passes', complete, 'profile_open\nprofile_collect 30', 0, dir => [STOPPED_TWO, ...summaryReport(dir, CONTEXT32)], ''],
    ['the stop and the summarizer fail in the cleanup hook', failingProfiler, 'profile_open\nexit 4', 4, () => FAILED_PROFILER, ''],
    ['the profile directory cannot be made', unmakeable,
      'profile_open\nprofile_collect 30\necho continued', 0, () => ['recorded: cpu-profile unavailable reason=profile-directory', 'continued'], ''],
  ])('prints the summary once and keeps the script\'s status: %s', (_name, prepare, steps, status, stdout, stderr) => {
    const scratch = join(root, 'evidence')
    const fixtures = prepare(scratch)
    const run = stubShell(program(steps), scratch, fixtures ?? FIXTURES)
    const lines = stdout(join(scratch, 'cpu-profile'))
    expect(run).toEqual({ status, stdout: lines.length ? lines.join('\n') + '\n' : '', stderr })
  })

  test('the second thread phase opens its own profile, and the hook collects only that one', () => {
    const strict = join(root, 'strict'), open = join(root, 'open')
    complete(strict); writeProfile(join(open, 'cpu-profile'), [roots], 'roots\n')
    const steps = `profile_open\nprofile_collect 30\nREAL_THREAD_EVIDENCE="${open}"\nREAL_THREAD_CONTEXT=(test-32-fmk-real-order open 100000 2)\nprofile_open\nfail "open phase failed"`
    expect(stubShell(program(steps), strict)).toEqual({ status: 1, stderr: 'FAIL: open phase failed\n',
      stdout: [STOPPED_TWO, ...summaryReport(join(strict, 'cpu-profile'), CONTEXT32),
        TIMED_OUT_ONE, ...summaryReport(join(open, 'cpu-profile'), CONTEXT32.replace('mode=strict', 'mode=open'))].join('\n') + '\n' })
  })
})

describe('test-32 sample phase on an injected clock (stub shell)', () => {
  // test-32 from the profile's begin through the clean shutdown before its
  // verdicts, on a fake epoch clock: EPOCHREALTIME unset and kept as a plain
  // variable, which `date` reads and `sleep` moves. Every admission takes
  // ADMISSION_MS, each delivery 200 ms (3 s for the hung lookup's), and each
  // profiler command 2 s. The fake server sees the wave mark at the script's
  // next poll or sample admission and answers its start START_DELAY_MS
  // later, unless the profiler failed. CSCB makes CALLS_PER_SAMPLE calls at each sample's push;
  // with none, it makes one call in the active window and a stray one 1 s
  // inside the empty window, after the poll interval + 1000 ms margin.
  const phase = () => {
    const start = T32.indexOf('    profile_begin\n'), stop = '    stop_server --stop-bots\n', end = T32.indexOf(stop, start) + stop.length
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start + stop.length)
    return T32.slice(start, end)
  }
  const samples = Array.from({ length: 20 }, (_, n) => `1700000000.0000${String(n + 1).padStart(2, '0')}`)
  interface Options { startDelayMs?: number; failed?: boolean; admissionMs?: number; callsPerSample?: number }
  const program = (profiled: boolean, { startDelayMs = 0, failed = false, admissionMs = 0, callsPerSample = 0 }: Options) => `${t32Program('', profiled ? '1' : null)}CLOCK_LOG="$1/clock.log" CALLS="$1/calls"
CLOCK_US=1700000100000000
unset EPOCHREALTIME
START_DELAY_MS=${startDelayMs} ADMISSION_MS=${admissionMs} CALLS_PER_SAMPLE=${callsPerSample} ANSWERED=0
START_AT_US=''
log() { printf '%s %d\\n' "$1" $(( CLOCK_US / 1000 )) >> "\${CLOCK_LOG}"; }
server_tick() {
    [[ -n "\${PROFILE_DIR}" && -s "\${PROFILE_DIR}/waves" && "\${ANSWERED}" == 0 && ! -e "\${PROFILE_DIR}/error.txt" ]] || return 0
    if [[ -z "\${START_AT_US}" ]]; then START_AT_US=$(( CLOCK_US + START_DELAY_MS * 1000 )); log start-requested; fi
    if (( CLOCK_US >= START_AT_US )); then printf '{"phase":"started"}\\n' >> "\${PROFILE_DIR}/observer.jsonl"; ANSWERED=1; log started; fi
}
tick() { CLOCK_US=$(( CLOCK_US + $1 )); printf -v EPOCHREALTIME '%d.%06d' $(( CLOCK_US / 1000000 )) $(( CLOCK_US % 1000000 )); }
tick 0
date() { if [[ "$1" == -d ]]; then printf '%s\\n' "$2"; else printf '%s\\n' "\${EPOCHREALTIME}"; fi; }
sleep() { server_tick; if [[ "$1" == 0.1 ]]; then tick 100000; elif [[ "$1" == *.* ]]; then tick $(( \${1%.*} * 1000000 + 10#\${1#*.} )); else tick $(( $1 * 1000000 )); fi; }
${shellFunction(integrationFile('lib/scenario.sh'), '_scenario_us_text')}
real_ad() { printf '{"state":"waiting","state_changed_at":"%s"}\\n' "$(_scenario_us_text "\${LAST_DELIVERY_US}")"; }
real_wait_latency_admission() {
    local waves=''
    if [[ "$2" != 21 ]]; then server_tick; tick $(( ADMISSION_MS * 1000 )); return 0; fi
    if [[ -n "\${PROFILE_DIR}" ]]; then waves="$(< "\${PROFILE_DIR}/waves")"; fi
    log "admission-21:\${waves//$'\\n'/,}"
}
real_thread_reply() {
    local n
    for ((n = 0; n < CALLS_PER_SAMPLE; n++)); do printf '%d\\n' "\${CLOCK_US}" >> "\${CALLS}"; done
    printf 'envelope-%s\\n' "$1"
}
slack_wait_one_ack() { tick 5000; }
real_thread_concurrent_work() { :; }
track_pid() { :; }
slack_envelope_times() { printf '{}\\n'; }
real_wait_delivery() {
    if [[ "$2" == 15 ]]; then tick 3000000; else tick 200000; fi
    LAST_DELIVERY_US=\${CLOCK_US}
    if [[ "$2" == 21 ]]; then log delivered; fi
}
shared_queue_snapshot() { :; }
ad_shim_mark() { printf '0\\n'; }
ad_cscb_calls() {
    local active=$(( 10#\${THREAD_ACTIVE_START//[!0-9]/} + 500000 )) stray=$(( LAST_DELIVERY_US + (${DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS} + 1000 + 1000) * 1000 )) at
    if (( CALLS_PER_SAMPLE )); then
        while IFS= read -r at; do printf '%s\\t%d.%06d\\n' "$1" $(( at / 1000000 )) $(( at % 1000000 )); done < "\${CALLS}"
        return 0
    fi
    printf '%s\\t%d.%06d\\n' "$1" $(( active / 1000000 )) $(( active % 1000000 )) "$1" $(( stray / 1000000 )) $(( stray % 1000000 ))
}
bun() { if [[ "$1" == "\${PROFILER}" ]]; then tick 2000000; log "profiler-$2"; elif [[ "\${2:-}" == DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS ]]; then printf '%s' '${DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS}'; fi; }
stop_server() { :; }
REAL_KEY=alpha THREAD_INSTANCE=i-1 REAL_SR8=/sr8 SLACK_STATE_DIR="$1/state" SERVER_PID=1
mkdir -p "\${SLACK_STATE_DIR}"
printf '{}' > "\${SLACK_STATE_DIR}/config.json"
REAL_THREAD_SAMPLES=(${samples.join(' ')})
REAL_THREAD_DELAYED_TS=${samples[6]} REAL_THREAD_HUNG_TS=${samples[13]}
profile_open
${failed ? `printf '{}' > "\${PROFILE_DIR}/error.txt"` : ''}
${phase()}`
  const run = (profiled: boolean, options: Options = {}) => {
    const scratch = join(root, profiled ? 'on' : 'off')
    mkdirSync(scratch)
    const shell = stubShell(program(profiled, options), scratch)
    const log = readFileSync(join(scratch, 'clock.log'), 'utf8').trim().split('\n').map(l => ({ label: l.split(' ')[0]!, ms: Number(l.split(' ')[1]) }))
    const tsv = (file: string) => readFileSync(join(scratch, file), 'utf8').trim().split('\n').map(l => l.split('\t'))
    const activeUs = () => Number(tsv('active.tsv')[0]![1]!.replace('.', ''))
    return { shell, log, tsv, dir: join(scratch, 'cpu-profile'), at: (label: string) => log.find(l => l.label === label)!.ms,
      intervals: () => tsv('cpu-profile/samples.tsv').map(([wave, start, end]) => ({ wave: wave!, start: Number(start), end: Number(end) })),
      collected: () => log.find(l => l.label.startsWith('admission-21'))!,
      // Each call's time from the active window's start, µs.
      callOffsets: () => readFileSync(join(scratch, 'calls'), 'utf8').trim().split('\n').map(at => Number(at) - activeUs()) }
  }
  const n3 = (r: ReturnType<typeof run>) => {
    const windows = (file: string) => r.tsv(file).map(([instance, start, end]) => ({ instance: instance!, start: Number(start) * 1000, end: Number(end) * 1000 }))
    return windowsVerdict(r.tsv('ad.tsv').map(([instance, s]) => ({ instance: instance!, ms: Number(s) * 1000 })), windows('empty.tsv'),
      DELIVERY_MAX_AD_CALLS_PER_S, windows('active.tsv'))
  }
  // The summary over the one part the server would save with these checkpoint times.
  const serverSummary = (r: ReturnType<typeof run>, requestedMs: number, startedMs: number, stopRequestedMs: number) => {
    writeFileSync(join(r.dir, 'part-0000-thread-samples.json'), JSON.stringify({ wave: 'thread-samples', startLagMs: 10, stopLagMs: 10,
      startRequestedAt: iso(requestedMs), startedAt: iso(startedMs), stopRequestedAt: iso(stopRequestedMs),
      profile: profile([3], [1000], startedMs * 1000, stopRequestedMs * 1000) }))
    appendFileSync(join(r.dir, 'observer.jsonl'), JSON.stringify({ phase: 'saved', name: 'part-0000-thread-samples.json', ts: iso(stopRequestedMs + 5) }) + '\n')
    return summaryReport(r.dir, CONTEXT32)
  }
  const slicesLine = (overlap: string) => `recorded: cpu-profile ${CONTEXT32} wave=none slices=20 clock=epoch checkpoint_overlap=${overlap}`
  const unanswered = 'recorded: cpu-profile start unacknowledged wait_s=5\n'

  test('profiling moves no observation boundary: a stray CSCB call 1 s into the settled idle window fails N3 alike with profiling on and off', () => {
    const off = run(false), on = run(true)
    for (const r of [off, on]) {
      expect(r.shell).toEqual({ status: 0, stdout: '', stderr: '' })
      expect(Math.round(Number(r.tsv('empty.tsv')[0]![1]) * 1000)).toBe(r.at('delivered') + DEFAULT_AGENT_DIRECTOR_POLL_INTERVAL_MS + 1000)
    }
    expect(n3(off)).toMatchObject({ measure: 'n3', verdict: 'fail', limit: 40, stats: { empty_calls: 1, covered_instances: 1 } })
    expect(n3(on)).toEqual(n3(off))
    // The profile is collected only after both admissions bound the empty window.
    expect(on.log.map(l => l.label)).toEqual(['start-requested', 'started', 'delivered', 'admission-21:thread-samples,end', 'admission-21:thread-samples,end', 'profiler-stop', 'profiler-summary'])
    expect(off.log.map(l => l.label)).toEqual(['delivered', 'admission-21:', 'admission-21:'])
  })

  // 4 calls at each push, 955 ms apart: 11 pushes, 44 calls, in the first 10 s
  // against the production limit of 40. A 500 ms wait between samples
  // spreads them to 7 pushes, 28 calls, which pass (the next row).
  const rate = { admissionMs: 750, callsPerSample: 4 }
  test('the control can tell a wait between samples from none: 500 ms more per sample brings the same calls under the N3 limit', () => {
    expect(n3(run(false, rate))).toMatchObject({ verdict: 'fail', limit: DELIVERY_MAX_AD_CALLS_PER_S * 10, stats: { max_10s: 44, empty_calls: 0 } })
    rmSync(join(root, 'off'), { recursive: true })
    expect(n3(run(false, { ...rate, admissionMs: rate.admissionMs + 500 }))).toMatchObject({ verdict: 'pass', limit: 40, stats: { max_10s: 28, empty_calls: 0 } })
  })

  test.each([
    ['its start answered at once', { startDelayMs: 0 }, ''],
    ['its start answered 300 ms late', { startDelayMs: 300 }, ''],
    ['its start answered after the wait, during the samples', { startDelayMs: 6000 }, unanswered],
    ['a failed profiler', { failed: true }, unanswered],
  ] as const)('profiling keeps an excessive active-window call rate failing N3 across the samples, and every call where it is without profiling: %s', (_name, options, stdout) => {
    const off = run(false, rate), on = run(true, { ...rate, ...options })
    expect(off.shell).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(on.shell).toEqual({ status: 0, stdout, stderr: '' })
    expect(n3(off)).toMatchObject({ measure: 'n3', samples: 80, verdict: 'fail', limit: 40, stats: { max_10s: 44, empty_calls: 0, covered_instances: 1 } })
    expect(n3(on)).toEqual(n3(off))
    expect(on.callOffsets()).toEqual(off.callOffsets())
    if ('startDelayMs' in options && options.startDelayMs === 6000) expect(on.at('started')).toBeGreaterThan(on.intervals()[0]!.start)
  })

  test.each([
    ['answered at once', 0],
    ['answered 300 ms after its mark', 300],
  ])('the profile samples every 100 ms, starts before the active window and every sample and ends after the last, so no checkpoint overlaps one: %s', (_name, delay) => {
    const r = run(true, { startDelayMs: delay }), intervals = r.intervals(), started = r.at('started'), ended = r.collected()
    expect(r.shell).toEqual({ status: 0, stdout: '', stderr: '' })
    expect([samplingIntervalUs(r.dir), profileCapS(r.dir)]).toEqual([100_000, 300])
    expect(intervals.map(v => v.wave)).toEqual(samples.map((_, n) => n === 6 ? 'delayed-lookup' : n === 13 ? 'hung-lookup' : 'sample'))
    expect(readFileSync(join(r.dir, 'waves'), 'utf8')).toBe('thread-samples\nend\n')
    expect(Number(r.tsv('active.tsv')[0]![1]) * 1000).toBeGreaterThan(started)
    expect(intervals[0]!.start).toBeGreaterThan(started)
    expect(ended).toEqual({ label: 'admission-21:thread-samples,end', ms: intervals.at(-1)!.end })
    expect(serverSummary(r, r.at('start-requested'), started, ended.ms)).toContain(slicesLine('0'))
  })

  test('a start not answered within the wait is reported and the phase goes on; the summary counts a start answered inside the first sample', () => {
    const r = run(true, { startDelayMs: 60_000 }), intervals = r.intervals()
    expect(r.shell).toEqual({ status: 0, stdout: unanswered, stderr: '' })
    expect(intervals).toHaveLength(20)
    expect(readFileSync(join(r.dir, 'waves'), 'utf8')).toBe('thread-samples\nend\n')
    expect(serverSummary(r, intervals[0]!.start - 5000, intervals[0]!.start + 100, r.collected().ms)).toContain(slicesLine('1'))
  })

  test('a profiler that already failed is not waited for: the start is reported unacknowledged at once', () => {
    const r = run(true, { failed: true })
    expect(r.shell).toEqual({ status: 0, stdout: unanswered, stderr: '' })
    // Nothing moved the clock between the profile's begin and the active window.
    expect(r.tsv('active.tsv')[0]![1]).toBe('1700000100.000000')
    expect(readFileSync(join(r.dir, 'waves'), 'utf8')).toBe('thread-samples\nend\n')
  })
})

describe('cleanup hooks stop the profile first, saving the wave in progress (real preload, injected inspector, scratch Bun child)', () => {
  // A daemon stand-in under the real preload, idle until the profile
  // completes or fails (8 s at most). An earlier preload replaces the
  // inspector session: it logs every command and answers Profiler.stop with
  // a known profile, so the summary's frames do not depend on scheduling.
  const SERVER = `import { existsSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[3]!
const end = performance.now() + 8000
while (!existsSync(join(dir, 'complete.json')) && !existsSync(join(dir, 'error.txt')) && performance.now() < end) await new Promise(r => setTimeout(r, 10))
`
  const known: CpuProfile = { startTime: 0, endTime: 3000, samples: [2, 2, 1], timeDeltas: [1000, 1000, 1000], nodes: [
    { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2] },
    { id: 2, callFrame: { functionName: 'hotLookup', url: 'file:///scratch/active-server.ts', lineNumber: 2 } },
  ] }
  const inspector = (log: string) => `import { appendFileSync } from 'node:fs'
import { Session } from 'node:inspector'
Session.prototype.connect = function () {}
Session.prototype.disconnect = function () {}
Session.prototype.post = function (method: string, params: object, callback: (e: Error | null, answer: object) => void) {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, params }) + '\\n')
  callback(null, method === 'Profiler.stop' ? { profile: ${JSON.stringify(known)} } : {})
}
`
  const awaitStarted = (dir: string) => `for ((n = 0; n < 50; n++)); do
    [[ -f "\${${dir}}/observer.jsonl" && "$(< "\${${dir}}/observer.jsonl")" == *'"phase":"started"'* ]] && break
    sleep 0.1
done`
  test.each([
    // profile_open runs before the server starts, as in the script, so the
    // server reads test-32's interval at its start.
    ['test-32: a sample fails after the profile began', 'evidence', t32Program(OPEN_ONLY),
      t32Program('PROFILE_CLEANUP_STOP_S=5\nPROFILE_DIR="$1/cpu-profile"\nprofile_begin\nfail "concurrent membership/write work failed"'),
      CONTEXT32, 'thread-samples', T32_INTERVAL_US, 'FAIL: concurrent membership/write work failed\n'],
    ['test-45: the burst fails during its roots wave', 'case', undefined, t45Program('first-hang',
      `MEMBERSHIP_PROFILE_CLEANUP_STOP_S=5\nprintf 'roots\\n' >> "\${MEMBERSHIP_PROFILE_DIR}/waves"\n${awaitStarted('MEMBERSHIP_PROFILE_DIR')}\nfail "full original burst did not complete"`),
      CONTEXT45, 'roots', CPU_PROFILE_INTERVAL_US, 'FAIL: full original burst did not complete\n'],
  ])('%s', async (_name, sub, open, program, context, wave, intervalUs, stderr) => {
    const scratch = join(root, sub), dir = join(scratch, 'cpu-profile'), fixtures = imageFixtures(), log = join(root, 'inspector.jsonl')
    if (open) expect(stubShell(open, scratch, fixtures)).toEqual({ status: 0, stdout: '', stderr: '' })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(root, 'active-server.ts'), SERVER); writeFileSync(join(root, 'inspector.ts'), inspector(log))
    const server = spawn(process.execPath, [join(root, 'active-server.ts'), 'start', dir], { stdio: 'ignore',
      env: hostSafeChildEnv(root, { tools: [], extras: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        BUN_OPTIONS: `--preload ${join(root, 'inspector.ts')} --preload ${join(fixtures, 'cpu-profile-preload.ts')}`, [CPU_PROFILE_DIR_ENV]: dir, _CLI_DAEMON_CHILD: '1' } }) })
    const exited = new Promise<number | null>(resolve => server.once('exit', resolve))
    const shell = stubShell(program, scratch, fixtures)
    expect(await exited).toBe(0)
    // The hook's stop answered before its summary, which reads the one saved part.
    const report = summaryReport(dir, context)
    expect(shell).toEqual({ status: 1, stderr, stdout: ['recorded: cpu-profile-stop outcome=complete parts=1', ...report].join('\n') + '\n' })
    expect(readdirSync(dir).filter(f => f.startsWith('part-'))).toEqual([`part-0000-${wave}.json`])
    expect(report[0]).toStartWith(`recorded: cpu-profile ${context} wave=none outcome=complete parts=1 `)
    expect(report).toContain(`recorded: cpu-profile-function ${context} wave=${wave} by=self rank=1 self_samples=2 self_pct=66.7 total_samples=2 total_pct=66.7`
      + ' self_weight_us=2000 self_weight_pct=66.7 total_weight_us=2000 total_weight_pct=66.7 function=hotLookup@/scratch/active-server.ts:3')
    expect(readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))).toEqual([
      { method: 'Profiler.enable', params: {} }, { method: 'Profiler.setSamplingInterval', params: { interval: intervalUs } },
      { method: 'Profiler.start', params: {} }, { method: 'Profiler.stop', params: {} }])
  }, 20_000)
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

  test('only tests 44, 45 and 32 set it, each on one measured start, and no src module names it', () => {
    const integration = join(import.meta.dir, 'integration')
    const shells = (readdirSync(integration, { recursive: true }) as string[]).filter(f => f.endsWith('.sh'))
    const opted = /cpu-profile|CSCB_TEST_CPU_PROFILE_DIR|SR8_PROFILE_DIR|BUN_OPTIONS/
    // test-48 shares membership-load.sh but never passes its --cpu-profile option.
    // burst-driver.sh only forwards the caller's SR8_PROFILE_DIR to the driver it launches; it sets none.
    expect(shells.filter(f => opted.test(readFileSync(join(integration, f), 'utf8'))).sort())
      .toEqual(['fixtures/burst-driver.sh', 'lib/membership-load.sh', 'test-32-fmk-real-order.sh', 'test-44-fmk-thread-burst.sh', 'test-45-fmk-membership-load.sh'])
    const forwarder = readFileSync(join(integration, 'fixtures/burst-driver.sh'), 'utf8')
    expect(forwarder.split('\n').filter(line => opted.test(line))).toEqual(['DRIVER_ENV=(SCENARIO_ROOT SR8_PHASE_CPU_FILE SR8_PHASE_CPU_PIDS SR8_PROFILE_DIR)'])
    expect(shells.filter(f => readFileSync(join(integration, f), 'utf8').includes('--cpu-profile')).sort())
      .toEqual(['lib/membership-load.sh', 'test-45-fmk-membership-load.sh'])
    expect(T45.match(/^run_membership_load .*$/gm)).toEqual(['run_membership_load strict hang --cpu-profile first-hang'])
    expect(T48.match(/^run_membership_load .*$/gm)).toEqual(['run_membership_load open hang'])
    const preload = (dir: string) => `BUN_OPTIONS="--preload \${SCENARIO_FIXTURES}/cpu-profile-preload.ts" CSCB_TEST_CPU_PROFILE_DIR="\${${dir}}" start_server --live\n`
    expect(SCRIPT).toContain('if [[ "${CSCB_TEST_DIAGNOSTICS:-}" == 1 && "${CASE}" == burst ]]; then\n    if mkdir -p "${EVIDENCE}/cpu-profile" 2> /dev/null; then\n        PROFILE_DIR="${EVIDENCE}/cpu-profile"\n')
    expect(SCRIPT.match(/PROFILE_DIR="\$\{EVIDENCE\}/g)).toHaveLength(1)
    expect(SCRIPT).toContain(`    if [[ "\${1:-}" == measured && -n "\${PROFILE_DIR}" ]]; then\n        ${preload('PROFILE_DIR')}    else\n        start_server --live\n    fi\n`)
    expect(LOAD).toContain(`    if [[ "\${1:-}" == measured && -n "\${MEMBERSHIP_PROFILE_DIR:-}" ]]; then\n        ${preload('MEMBERSHIP_PROFILE_DIR')}    else\n        start_server --live\n    fi\n`)
    // test-32: the thread phase's measured start, the second start of each mode.
    expect(T32).toContain(`    profile_open\n    THREAD_START_MS="$(real_thread_now_ms)"\n    if [[ -n "\${PROFILE_DIR}" ]]; then\n        ${preload('PROFILE_DIR')}    else\n        start_server --live\n    fi\n    THREAD_READY_MS=`)
    for (const text of [SCRIPT, LOAD, T32]) expect(text.match(/BUN_OPTIONS=/g)).toHaveLength(1)
    expect(T45).not.toMatch(/BUN_OPTIONS|SR8_PROFILE_DIR/)
    // Each profile directory is set in one place; test-45's only for the named case.
    expect(LOAD.match(/MEMBERSHIP_PROFILE_DIR="\$\{ROOT\}/g)).toHaveLength(1)
    expect(shellFunction(LOAD, 'membership_profile_open')).toContain('[[ -n "${MEMBERSHIP_PROFILE_CASE}" && "${CASE_KIND}" == "${MEMBERSHIP_PROFILE_CASE}" ]] || return 0\n')
    expect(T32.match(/PROFILE_DIR="\$\{REAL_THREAD_EVIDENCE\}/g)).toHaveLength(1)
    // The burst's wave marks reach only test-45's fault burst.
    expect(LOAD.match(/SR8_PROFILE_DIR=.*$/gm)).toEqual(['SR8_PROFILE_DIR="${MEMBERSHIP_PROFILE_DIR}" bash "${BURST_DRIVER}" "${OUT}/driver-cgroup" \\'])
    expect(LOAD).toContain('"${OUT}/driver-cgroup" \\\n                bun "${E}" fault-burst "${C[@]}" "${OUT}" ')
    expect(T32).not.toContain('SR8_PROFILE_DIR')
    const src = (readdirSync(join(REPO, 'src'), { recursive: true }) as string[]).filter(f => /\.[cm]?[jt]s$/.test(f))
    expect(src.filter(f => /cpu-profile|CSCB_TEST_CPU_PROFILE_DIR|SR8_PROFILE_DIR|Profiler\./.test(readFileSync(join(REPO, 'src', f), 'utf8')))).toEqual([])
    // The npm package ships src only, never the test fixtures.
    const files: string[] = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).files
    expect(files.filter(f => f.startsWith('tests') || f.includes(relative(REPO, FIXTURES)))).toEqual([])
  })
})
