import { spawnSync } from 'node:child_process'
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCpuStat, parsePressure, parseMemoryStat, parseHostSteal, readServerCpuStat, startStallAttribution, createTestSyncWorkScope, testSyncWorkStart, testSyncWorkEnd } from '../src/test-stall-attribution.ts'
import { createPostHoldResolver } from '../src/post-holds.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'
import { SR8_DISPATCH_ALLOWANCE_MS } from './integration/fixtures/sr8-evidence.ts'
import { attributionLines, retainFailureMeasurements } from './integration/fixtures/sr8-attribution.ts'

const roots: string[] = []
let stop: (() => void) | undefined
afterEach(() => { stop?.(); stop = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const stat = (n: number) => `usage_usec ${n * 1000}\nnr_periods ${n}\nnr_throttled ${n}\nthrottled_usec ${n * 100}\n`

test('disabled attribution creates no probe, reads, clocks or rows', () => {
  const forbidden = () => { throw new Error('disabled path called dependency') }
  stop = startStallAttribution(false, { record: forbidden, now: forbidden, cpu: forbidden, resource: forbidden, heap: forbidden, read: forbidden, timers: { setTimeout: forbidden, clearTimeout: forbidden } })
  expect(testSyncWorkStart()).toBeUndefined()
  expect(createTestSyncWorkScope('disabled')).toBeUndefined()
  testSyncWorkEnd(undefined, 'thread-judge', 'alpha')
})

test('cpu.stat requires every counter; unavailable and malformed files never throw', () => {
  expect(parseCpuStat(stat(2))).toEqual({ usage_usec: 2000, nr_periods: 2, nr_throttled: 2, throttled_usec: 200 })
  expect(parseCpuStat('nr_periods nope')).toBeNull()
  expect(readServerCpuStat(() => { throw new Error('ENOENT') })).toBeNull()
  const paths: string[] = []
  expect(readServerCpuStat(path => { paths.push(path); return path === '/proc/self/cgroup' ? '0::/server\n' : stat(2) })).not.toBeNull()
  expect(paths).toEqual(['/proc/self/cgroup', '/sys/fs/cgroup/server/cpu.stat'])
})

test('probe records delayed dispatch with pre-gap CPU, quota and heap; sync markers are thresholded and stop cancels', () => {
  let now = 0, counter = 1, tick: (() => void) | undefined, clears = 0
  const rows: any[] = []
  stop = startStallAttribution(true, {
    record: r => rows.push(r), now: () => now, cpu: () => ({ user: now * 500, system: now * 10 }), heap: () => ({ heap_used: 100 - now, heap_total: 200 }),
    read: path => path === '/proc/self/cgroup' ? '0::/server\n' : stat(counter),
    timers: { setTimeout: (fn, ms) => { expect(ms).toBe(10); tick = fn; return 1 }, clearTimeout: () => { clears++ } },
  })
  now = 10; tick!(); expect(rows).toHaveLength(0)
  const start = testSyncWorkStart()
  now = 35; testSyncWorkEnd(start, 'thread-judge', 'alpha')
  counter = 4; now = 60; tick!()
  expect(rows[0]).toMatchObject({ kind: 'sync-work', work: 'thread-judge', key: 'alpha', start_mono_ms: 10, end_mono_ms: 35 })
  expect(rows[1]).toMatchObject({ kind: 'event-loop-stall', start_mono_ms: 10, end_mono_ms: 60, gap_ms: 40, elapsed_ms: 50,
    cpu_user_usec: 25000, cpu_system_usec: 500, cpu_stat_before_mono_ms: 10,
    cpu_stat_delta: { nr_throttled: 3, throttled_usec: 300 }, heap_before: { heap_used: 90 }, heap_after: { heap_used: 40 } })
  stop(); expect(clears).toBe(1); expect(testSyncWorkStart()).toBeUndefined()
})

test('an unavailable cgroup/heap remains explicit in a stalled probe and does not throw', () => {
  let now = 0, tick = () => {}
  const recorded: any[] = []
  stop = startStallAttribution(true, { record: r => recorded.push(r), now: () => now,
    cpu: () => ({ user: 0, system: 0 }), resource: () => { throw new Error('unavailable') }, heap: () => { throw new Error('unavailable') }, read: () => { throw new Error('ENOENT') },
    timers: { setTimeout: fn => { tick = fn; return 1 }, clearTimeout: () => {} } })
  now = 50; tick()
  expect(recorded[0]).toMatchObject({ gap_ms: 40, cpu_user_usec: 0, cpu_system_usec: 0, cpu_stat: null, cpu_stat_delta: null, heap_before: null, heap_after: null, resource_delta: null,
    pressure: { cpu: null, memory: null, io: null }, memory_current: null, memory_max: null, memory_stat: null, host_steal_ticks: null, host_steal_delta_ticks: null })
})

test('pressure, selected memory and host steal parsers reject malformed counters without inventing zero', () => {
  expect(parsePressure('some avg10=1.0 avg60=0.0 avg300=0.0 total=123\nfull avg10=0.0 avg60=0.0 avg300=0.0 total=4\n')).toEqual({ some: 123, full: 4 })
  expect(parsePressure('some total=bad')).toBeNull()
  expect(parsePressure('some total=10')).toEqual({ some: 10, full: null })
  expect(parseMemoryStat('anon 100\nfile 20\nshmem 3\npgmajfault 4\nworkingset_refault_anon 5\nworkingset_refault_file 6\nother 100\n')).toEqual({ anon: 100, file: 20, shmem: 3, pgmajfault: 4, workingset_refault_anon: 5, workingset_refault_file: 6 })
  expect(parseMemoryStat('anon nope')).toBeNull()
  expect(parseHostSteal('cpu 1 2 3 4 5 6 7 88 9 10\ncpu0 1 2 3 4 5 6 7 999\n')).toBe(88)
  expect(parseHostSteal('cpu 1 2')).toBeNull()
})

test('resource deltas cover the probe gap; costly pressure/memory/steal readings expose their wider stall-end baseline', () => {
  let now = 0, n = 1, tick = () => {}
  const reads: string[] = [], recorded: any[] = []
  const counters = () => ({ minorPageFault: n * 10, majorPageFault: n, voluntaryContextSwitches: n * 2,
    involuntaryContextSwitches: n * 3, fsRead: n * 4, fsWrite: n * 5 })
  stop = startStallAttribution(true, { record: r => recorded.push(r), now: () => now, resource: counters,
    cpu: () => ({ user: 0, system: 0 }), heap: () => ({ heap_used: 1, heap_total: 2 }),
    read: path => {
      reads.push(path)
      if (path === '/proc/self/cgroup') return '0::/server\n'
      if (path.endsWith('/cpu.stat')) return stat(n)
      if (path.endsWith('.pressure')) return `some total=${n * 100}\nfull total=${n * 20}\n`
      if (path.endsWith('/memory.current')) return String(1000 - n)
      if (path.endsWith('/memory.max')) return 'max'
      if (path.endsWith('/memory.stat')) return `anon ${100 - n}\nfile 20\nshmem 3\npgmajfault ${n}\nworkingset_refault_file ${n * 4}\n`
      if (path === '/proc/stat') return `cpu 1 2 3 4 5 6 7 ${n * 8} 9 10\n`
      throw new Error('unexpected path')
    }, timers: { setTimeout: fn => { tick = fn; return 1 }, clearTimeout: () => {} } })
  const baselineReads = reads.length
  now = 10; n = 2; tick()
  expect(reads.length - baselineReads).toBe(1) // cpu.stat only on a normal tick
  now = 60; n = 4; tick()
  expect(recorded[0]).toMatchObject({ resource_before_mono_ms: 10,
    resource_delta: { minorPageFault: 20, majorPageFault: 2, voluntaryContextSwitches: 4, involuntaryContextSwitches: 6, fsRead: 8, fsWrite: 10 },
    system_sampling: 'stall-end', system_before_mono_ms: 0, system_after_mono_ms: 60,
    pressure_delta: { cpu: { some: 300, full: 60 }, memory: { some: 300, full: 60 }, io: { some: 300, full: 60 } },
    memory_current: 996, memory_max: 'max', memory_stat_delta: { anon: -3, pgmajfault: 3, workingset_refault_file: 12 },
    host_steal_delta_ticks: 24 })
  now = 110; n = 1; tick()
  expect(recorded[1]).toMatchObject({ resource_delta: { minorPageFault: null, majorPageFault: null },
    pressure_delta: { cpu: { some: null, full: null } }, memory_stat_delta: { anon: 3, pgmajfault: null }, host_steal_delta_ticks: null })
})

test('sync scopes span microtasks but exclude real I/O/yield waits, with phases inside each stretch', async () => {
  let now = 0
  const rows: any[] = []
  stop = startStallAttribution(true, { record: r => rows.push(r), now: () => now, cpu: () => ({ user: 0, system: 0 }),
    resource: () => ({}), heap: () => ({ heap_used: 1, heap_total: 2 }), read: () => { throw new Error('unavailable') },
    timers: { setTimeout: () => 1, clearTimeout: () => {} } })
  const scope = createTestSyncWorkScope('whole-compaction', 'alpha')!
  scope.phase('first-phase'); now = 15; await Promise.resolve(); now = 25
  scope.phase('second-phase'); now = 40; scope.pause()
  now = 100; scope.resume(); now = 125; scope.stop()
  expect(rows.filter(r => r.work === 'whole-compaction').map(r => [r.start_mono_ms, r.end_mono_ms])).toEqual([[0, 40], [100, 125]])
  expect(rows.filter(r => r.work === 'first-phase').map(r => [r.start_mono_ms, r.end_mono_ms])).toEqual([[0, 25]])
  expect(rows.filter(r => r.work === 'second-phase').map(r => [r.start_mono_ms, r.end_mono_ms])).toEqual([[100, 125]])
})

test('Post Hold records receipt, early re-arm callbacks and the held_ms decision without changing timer/microtask scheduling', async () => {
  let now = 0
  const timers: Array<{ fn: () => void; ms: number }> = [], timings: any[] = [], events: any[] = [], saves: any[] = []
  const resolver = createPostHoldResolver({
    clock: { now: () => now, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimeout: () => {} },
    decisionNow: () => 10, owner: { operation: () => undefined },
    queue: { unresolvedHolds: () => [], item: () => undefined, resolveHolds: async (_key, resolutions) => { saves.push(resolutions); return [...resolutions] } },
    release: () => {}, onParked: () => {}, onTiming: r => timings.push(r), onEvent: e => events.push(e),
  })
  resolver.held('alpha', { seq: 7, operations: ['pending'], threadRoot: 'root', rootUnknown: false, receivedAt: 0 }, () => {})
  await Promise.resolve()
  now = 1000; timers[0]!.fn(); await Promise.resolve()
  expect(timers.map(t => t.ms)).toEqual([3000, 2000]); expect(saves).toHaveLength(0)
  now = 3011; timers[1]!.fn()
  expect(saves).toHaveLength(0) // timer still only queues evaluation
  await Promise.resolve(); await Promise.resolve()
  expect(timings.map(r => [r.phase, r.at_mono_ms, r.armed_delay_ms])).toEqual([
    ['registered', 0, undefined], ['callback', 1000, 3000], ['callback', 3011, 2000], ['evaluate', 3011, undefined],
  ])
  expect(timings.every(r => r.received_mono_ms === 0 && r.due_mono_ms === 3000 && r.key === 'alpha' && r.seq === 7)).toBe(true)
  expect(events[0]).toMatchObject({ heldMs: 3011, cause: 'timer' })
  resolver.stop()
})

const context = { scenario: 'test-52-strict-first-rate', mode: 'strict' as const, population: 100000, recipients: 2 }
const rows = [
  { v: 1, kind: 'post-hold-timing', key: 'alpha', seq: 7, phase: 'registered', received_mono_ms: 100, due_mono_ms: 3100, at_mono_ms: 101 },
  { v: 1, kind: 'post-hold-timing', key: 'alpha', seq: 7, phase: 'callback', received_mono_ms: 100, due_mono_ms: 3100, at_mono_ms: 3210, armed_delay_ms: 2999 },
  { v: 1, kind: 'post-hold-timing', key: 'alpha', seq: 7, phase: 'evaluate', received_mono_ms: 100, due_mono_ms: 3100, at_mono_ms: 3211 },
  { v: 1, kind: 'post-hold-resolved', key: 'alpha', seq: 7, held_ms: 3111, at_mono_ms: 3213 },
  { v: 1, kind: 'resolution-store', key: 'alpha', seqs: [7], store_ms: 1, at_mono_ms: 3212 },
  { v: 1, kind: 'event-loop-stall', start_mono_ms: 3095, end_mono_ms: 3210, gap_ms: 105, at_mono_ms: 3210, cpu_stat_delta: { nr_throttled: 1 } },
  { v: 1, kind: 'sync-work', key: 'bravo', work: 'thread-judge', start_mono_ms: 3090, end_mono_ms: 3190, at_mono_ms: 3190 },
  { v: 1, kind: 'sync-work', key: 'alpha', work: 'thread-judge', start_mono_ms: 1, end_mono_ms: 30, at_mono_ms: 30 },
]
test('informational lines correlate callback, deadline windows, cross-persona markers, and capped stalls', () => {
  const lines = attributionLines(context, rows, 1)
  expect(lines.every(l => l.startsWith('recorded: sr8 attribution ') && l.endsWith('verdict=info'))).toBe(true)
  const hold = lines.find(l => l.includes('type=post-hold '))!
  expect(hold).toContain('due_mono_ms=3100'); expect(hold).toContain('evaluate_mono_ms=3211'); expect(hold).toContain('lateness_ms=111')
  expect(hold).toContain('armed_delay_ms'); expect(hold).toContain('"key":"bravo"'); expect(hold).not.toContain('"start_mono_ms":1,')
  const foreign = { v: 1, kind: 'sync-work', process_id: 999, work: 'foreign-process', start_mono_ms: 3090, end_mono_ms: 3210, at_mono_ms: 3210 }
  const separated = attributionLines(context, [...rows, foreign]).find(l => l.includes('type=post-hold '))!
  expect(separated).not.toContain('foreign-process')
  expect(lines.find(l => l.includes('type=stall-summary '))).toContain('count=1 printed=1 max_gap_ms=105 total_gap_ms=105')
  expect(attributionLines(context, [...rows, ...rows.filter(r => r.kind === 'event-loop-stall')], 1).filter(l => l.includes('type=stall '))).toHaveLength(1)
})

test('informational JSON adds resource, pressure, memory and steal fields without changing legacy fields', () => {
  const data = { ...rows.find(r => r.kind === 'event-loop-stall')!,
    resource_delta: { majorPageFault: 1, minorPageFault: 2, voluntaryContextSwitches: 3, involuntaryContextSwitches: 4, fsRead: 5, fsWrite: 6 },
    resource_before_mono_ms: 3095, system_sampling: 'stall-end', system_before_mono_ms: 1000, system_after_mono_ms: 3210,
    pressure: { cpu: { some: 100, full: 1 }, memory: null, io: null }, pressure_delta: { cpu: { some: 10, full: 0 }, memory: null, io: null },
    memory_current: 500, memory_max: 'max', memory_stat: { anon: 100, workingset_refault_file: 20 }, memory_stat_delta: { anon: -1, workingset_refault_file: 2 },
    host_steal_ticks: 100, host_steal_delta_ticks: 4 }
  const line = attributionLines(context, [data]).find(l => l.includes('type=stall '))!
  const json = JSON.parse(line.split(' data=')[1]!.split(' marker_count=')[0]!)
  expect(json).toEqual(data)
  expect(line).toContain('verdict=info')
})

test('failure retention copies regular measurement files and prints bounded rows around failing hold windows', () => {
  const root = mkdtempSync(join(tmpdir(), 'sr8-attribution-')), out = join(root, 'kept'), state = join(root, 'state')
  roots.push(root)
  mkdirSync(state)
  const source = join(state, 'test-measurements.jsonl'), bytes = rows.map(r => JSON.stringify(r) + '\n').join('')
  writeFileSync(source, bytes)
  const lines = retainFailureMeasurements('test-52', state, out, 3000, SR8_DISPATCH_ALLOWANCE_MS, 3)
  expect(readFileSync(join(out, 'test-52.sh.sr8-measurements-1.jsonl'), 'utf8')).toBe(bytes)
  expect(lines.some(l => l.includes('type=kept-file ') && l.includes('path='))).toBe(true)
  expect(lines.filter(l => l.includes('type=failure-row '))).toHaveLength(3)
  expect(lines.some(l => l.includes('type=failure-summary ') && l.includes('printed=3'))).toBe(true)
})

test('failure-retention CLI is image-guarded and keeps the actual file with informational output', () => {
  const root = mkdtempSync(join(tmpdir(), 'sr8-retention-cli-')); roots.push(root)
  const source = join(root, 'state'), out = join(root, 'results'), marker = join(root, 'image'), command = join(root, 'sr8-attribution.ts')
  mkdirSync(source)
  const bytes = rows.map(r => JSON.stringify(r) + '\n').join('')
  writeFileSync(join(source, 'test-measurements.jsonl'), bytes)
  writeFileSync(command, readFileSync(join(import.meta.dir, 'integration/fixtures/sr8-attribution.ts'), 'utf8')
    .replace("existsSync('/etc/cscb-ci-image')", `existsSync(${JSON.stringify(marker)})`))
  writeFileSync(join(root, 'sr8-evidence.ts'), readFileSync(join(import.meta.dir, 'integration/fixtures/sr8-evidence.ts')))
  const run = () => spawnSync(process.execPath, [command, 'test-52', source, out, '3000'], {
    env: hostSafeChildEnv(root), encoding: 'utf8', timeout: 3000,
  })
  expect(run().status).toBe(2); expect(existsSync(out)).toBe(false)
  writeFileSync(marker, '')
  const child = run()
  expect(child.status).toBe(0); expect(child.stderr).toBe('')
  expect(child.stdout).toContain('type=kept-file path=')
  expect(child.stdout).toContain('type=failure-row ')
  expect(readFileSync(join(out, 'test-52.sh.sr8-measurements-1.jsonl'), 'utf8')).toBe(bytes)
})
