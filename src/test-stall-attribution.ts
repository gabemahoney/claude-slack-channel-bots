/** Test-only SR-8 attribution. No import-time I/O or timers. Installed only
 * with test_measurements, once at startup; independent of per-event timings. */
import { readFileSync } from 'node:fs'
import { posix, dirname } from 'node:path'

export interface CpuStat { nr_periods: number; nr_throttled: number; throttled_usec: number; usage_usec: number }
export interface HeapSample { heap_used: number; heap_total: number }
export interface SyncWorkMeasurement {
  process_id?: number
  kind: 'sync-work'; work: string; key?: string; start_mono_ms: number; end_mono_ms: number; at_mono_ms: number
}
export interface PressureTotals { some: number | null; full: number | null }
export interface Pressures { cpu: PressureTotals | null; memory: PressureTotals | null; io: PressureTotals | null }
export type MemoryCounters = Record<string, number | null>
export interface ResourceCounters {
  minorPageFault: number | null; majorPageFault: number | null; voluntaryContextSwitches: number | null
  involuntaryContextSwitches: number | null; fsRead: number | null; fsWrite: number | null
}
export interface SystemSample {
  pressure: Pressures; memory_current: number | null; memory_max: number | 'max' | null
  memory_stat: MemoryCounters | null; host_steal_ticks: number | null
}
export interface StallMeasurement {
  process_id?: number
  kind: 'event-loop-stall'; start_mono_ms: number; end_mono_ms: number; at_mono_ms: number
  expected_mono_ms: number; gap_ms: number; elapsed_ms: number; cpu_user_usec: number; cpu_system_usec: number
  cpu_stat: CpuStat | null; cpu_stat_delta: CpuStat | null; cpu_stat_before_mono_ms: number
  heap_before: HeapSample | null; heap_after: HeapSample | null
  resource_delta?: ResourceCounters | null; resource_before_mono_ms?: number
  system_sampling?: 'stall-end' | 'every-tick'; system_before_mono_ms?: number; system_after_mono_ms?: number
  pressure?: Pressures; pressure_delta?: Pressures; memory_current?: number | null; memory_max?: number | 'max' | null
  memory_stat?: MemoryCounters | null; memory_stat_delta?: MemoryCounters | null
  host_steal_ticks?: number | null; host_steal_delta_ticks?: number | null
}
export interface HoldTimingMeasurement {
  process_id?: number
  kind: 'post-hold-timing'; key: string; seq: number; phase: 'registered' | 'callback' | 'evaluate'
  received_mono_ms: number; due_mono_ms: number; at_mono_ms: number; armed_delay_ms?: number
}
export type AttributionMeasurement = SyncWorkMeasurement | StallMeasurement | HoldTimingMeasurement
type ReadText = (path: string) => string
const readText: ReadText = path => readFileSync(path, 'utf8')
const CPU_FIELDS = ['nr_periods', 'nr_throttled', 'throttled_usec', 'usage_usec'] as const

export function parseCpuStat(text: string): CpuStat | null {
  const values: Partial<CpuStat> = {}
  for (const line of text.trim().split('\n')) {
    const [key, value] = line.trim().split(/\s+/)
    if (!CPU_FIELDS.includes(key as typeof CPU_FIELDS[number])) continue
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < 0 || key in values) return null
    values[key as keyof CpuStat] = n
  }
  return CPU_FIELDS.every(key => values[key] !== undefined) ? values as CpuStat : null
}
function cpuStatPath(read: ReadText): string | undefined {
  try {
    const path = read('/proc/self/cgroup').split('\n').find(line => line.startsWith('0::'))?.slice(3)
    // cgroup v2 namespace-relative path. Do not escape its mounted root.
    if (!path?.startsWith('/') || path.split('/').includes('..')) return undefined
    return posix.join('/sys/fs/cgroup', path, 'cpu.stat')
  } catch { return undefined }
}
export function readServerCpuStat(read: ReadText = readText, path = cpuStatPath(read)): CpuStat | null {
  try { return path ? parseCpuStat(read(path)) : null } catch { return null }
}
function delta(after: CpuStat | null, before: CpuStat | null): CpuStat | null {
  if (!after || !before || CPU_FIELDS.some(key => after[key] < before[key])) return null
  return { nr_periods: after.nr_periods - before.nr_periods, nr_throttled: after.nr_throttled - before.nr_throttled,
    throttled_usec: after.throttled_usec - before.throttled_usec, usage_usec: after.usage_usec - before.usage_usec }
}
const RESOURCE_FIELDS = ['minorPageFault', 'majorPageFault', 'voluntaryContextSwitches', 'involuntaryContextSwitches', 'fsRead', 'fsWrite'] as const
const counter = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const numberText = (text: string): number | null => /^\d+$/.test(text.trim()) ? counter(Number(text.trim())) : null
const difference = (after: number | null | undefined, before: number | null | undefined, gauge = false): number | null =>
  after == null || before == null || (!gauge && after < before) ? null : after - before
export function parsePressure(text: string): PressureTotals | null {
  const result: PressureTotals = { some: null, full: null }
  for (const line of text.trim().split('\n')) {
    const [kind, ...fields] = line.trim().split(/\s+/)
    if (kind !== 'some' && kind !== 'full') continue
    const raw = fields.find(field => field.startsWith('total='))?.slice(6)
    const value = raw === undefined ? null : numberText(raw)
    if (value === null || result[kind] !== null) return null
    result[kind] = value
  }
  return result.some === null && result.full === null ? null : result
}
export function parseMemoryStat(text: string): MemoryCounters | null {
  const result: MemoryCounters = { anon: null, file: null, shmem: null, pgmajfault: null, workingset_refault_anon: null, workingset_refault_file: null }
  for (const line of text.trim().split('\n')) {
    const [name, raw] = line.trim().split(/\s+/)
    if (!['anon', 'file', 'shmem', 'pgmajfault'].includes(name) && !/^workingset_refault(?:_[a-z]+)?$/.test(name)) continue
    const value = raw === undefined ? null : numberText(raw)
    if (value === null || result[name] != null) return null
    result[name] = value
  }
  return Object.values(result).every(n => n === null) ? null : result
}
export function parseHostSteal(text: string): number | null {
  const [cpu, ...fields] = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n')).trim().split(/\s+/)
  return cpu === 'cpu' && fields.length >= 8 ? numberText(fields[7]) : null
}
function resources(read: () => Partial<NodeJS.ResourceUsage>): ResourceCounters | null {
  try {
    const result = read(), values = Object.fromEntries(RESOURCE_FIELDS.map(key => [key, counter(result[key])])) as unknown as ResourceCounters
    return RESOURCE_FIELDS.every(key => values[key] === null) ? null : values
  } catch { return null }
}
function resourceDelta(after: ResourceCounters | null, before: ResourceCounters | null): ResourceCounters | null {
  return after && before ? Object.fromEntries(RESOURCE_FIELDS.map(key => [key, difference(after[key], before[key])])) as unknown as ResourceCounters : null
}
function pressureDelta(after: Pressures, before: Pressures): Pressures {
  const delta = (a: PressureTotals | null, b: PressureTotals | null) => a && b ? { some: difference(a.some, b.some), full: difference(a.full, b.full) } : null
  return { cpu: delta(after.cpu, before.cpu), memory: delta(after.memory, before.memory), io: delta(after.io, before.io) }
}
function memoryDelta(after: MemoryCounters | null, before: MemoryCounters | null): MemoryCounters | null {
  return after && before ? Object.fromEntries(Object.keys(after).map(key => [key, difference(after[key], before[key], ['anon', 'file', 'shmem'].includes(key))])) : null
}
function systemSample(read: ReadText, dir: string | undefined): SystemSample {
  const safe = <T>(file: string | undefined, parse: (text: string) => T): T | null => { try { return file ? parse(read(file)) : null } catch { return null } }
  const group = (name: string) => dir === undefined ? undefined : posix.join(dir, name)
  return { pressure: { cpu: safe(group('cpu.pressure'), parsePressure), memory: safe(group('memory.pressure'), parsePressure), io: safe(group('io.pressure'), parsePressure) },
    memory_current: safe(group('memory.current'), numberText), memory_max: safe(group('memory.max'), text => text.trim() === 'max' ? 'max' as const : numberText(text)),
    memory_stat: safe(group('memory.stat'), parseMemoryStat), host_steal_ticks: safe('/proc/stat', parseHostSteal) }
}
let syncObserver: ((entry: SyncWorkMeasurement) => void) | undefined
let syncNow = () => performance.now()
/** Gate-off hot path: no clock read, closure, object or array allocation. */
export function testSyncWorkStart(): number | undefined { return syncObserver ? syncNow() : undefined }
export function testSyncWorkEnd(start: number | undefined, work: string, key?: string): void {
  if (start === undefined || !syncObserver) return
  const end = syncNow()
  if (end - start <= 20) return
  try { syncObserver({ kind: 'sync-work', work, ...(key === undefined ? {} : { key }), start_mono_ms: start, end_mono_ms: end, at_mono_ms: end }) } catch { /* isolated observer */ }
}
/** Observe synchronous stretches without introducing a scheduling boundary.
 * Call pause only at an existing native async-I/O or macrotask yield; an
 * already-resolved promise must leave the stretch open. */
export interface TestSyncWorkScope {
  phase(work: string): void
  pause(): void
  resume(): void
  stop(): void
}
export function createTestSyncWorkScope(work: string, key?: string): TestSyncWorkScope | undefined {
  let start = testSyncWorkStart()
  if (start === undefined) return undefined
  let phase: string | undefined, phaseStart = start, stopped = false
  const scope: TestSyncWorkScope = {
    phase(next) {
      if (start !== undefined && phase) testSyncWorkEnd(phaseStart, phase, key)
      phase = next; phaseStart = syncNow()
    },
    pause() {
      if (start === undefined) return
      if (phase) testSyncWorkEnd(phaseStart, phase, key)
      testSyncWorkEnd(start, work, key); start = undefined
    },
    resume() { if (!stopped && start === undefined) { start = testSyncWorkStart(); phaseStart = start ?? 0 } },
    stop() { scope.pause(); stopped = true },
  }
  return scope
}
export interface AttributionDeps {
  record(entry: AttributionMeasurement): void
  now?: () => number
  cpu?: () => NodeJS.CpuUsage
  resource?: () => Partial<NodeJS.ResourceUsage>
  /** Benchmark seam: production samples costly sources at startup and stall endpoints. */
  systemSampling?: 'stall-end' | 'every-tick'
  heap?: () => HeapSample
  read?: ReadText
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
}
export function startStallAttribution(enabled: boolean, deps: AttributionDeps): () => void {
  if (!enabled) return () => {}
  const now = deps.now ?? (() => performance.now()), cpu = deps.cpu ?? (() => process.cpuUsage())
  const heap = deps.heap ?? (() => { const m = process.memoryUsage(); return { heap_used: m.heapUsed, heap_total: m.heapTotal } })
  const read = deps.read ?? readText, path = cpuStatPath(read)
  const timers = deps.timers ?? {
    setTimeout(fn: () => void, ms: number) { const timer = setTimeout(fn, ms); timer.unref(); return timer },
    clearTimeout(handle: unknown) { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  }
  const sampleHeap = () => { try { return heap() } catch { return null } }
  const sampleStat = () => path ? readServerCpuStat(read, path) : null
  const resource = deps.resource ?? (() => process.resourceUsage())
  const sampleResource = () => resources(resource)
  // /proc/stat alone costs ~59 us/read locally; sample the costly bundle only
  // at startup/stall endpoints. Its explicit baseline timestamp prevents a
  // wider delta from being mistaken for a delta of just this 10 ms probe gap.
  const systemSampling = deps.systemSampling ?? 'stall-end'
  const sampleSystem = () => {
    const start = testSyncWorkStart()
    try { return systemSample(read, path === undefined ? undefined : dirname(path)) }
    finally { testSyncWorkEnd(start, 'probe-system-read') }
  }
  const emit = (entry: AttributionMeasurement) => { try { deps.record(entry) } catch { /* observation never affects server */ } }
  // Use the same injected clock for markers and probe in deterministic tests.
  const observer = (entry: SyncWorkMeasurement) => emit(entry)
  syncNow = now
  syncObserver = observer
  let last = now(), lastCpu = cpu(), lastStat = sampleStat(), lastHeap = sampleHeap(), stopped = false
  let lastResource = sampleResource(), lastSystem = sampleSystem(), lastSystemAt = now()
  let timer: unknown
  function tick(): void {
    if (stopped) return
    const end = now(), currentCpu = cpu(), currentStat = sampleStat(), currentHeap = sampleHeap()
    const currentResource = sampleResource(), gap = end - last - 10
    const currentSystem = gap > 20 || systemSampling === 'every-tick' ? sampleSystem() : undefined
    const systemAt = currentSystem ? now() : undefined
    if (gap > 20 && currentSystem) emit({ kind: 'event-loop-stall', start_mono_ms: last, end_mono_ms: end, at_mono_ms: end,
      expected_mono_ms: last + 10, gap_ms: gap, elapsed_ms: end - last,
      cpu_user_usec: currentCpu.user - lastCpu.user, cpu_system_usec: currentCpu.system - lastCpu.system,
      cpu_stat: currentStat, cpu_stat_delta: delta(currentStat, lastStat), cpu_stat_before_mono_ms: last,
      heap_before: lastHeap, heap_after: currentHeap,
      resource_delta: resourceDelta(currentResource, lastResource), resource_before_mono_ms: last,
      system_sampling: systemSampling, system_before_mono_ms: lastSystemAt, system_after_mono_ms: systemAt,
      pressure: currentSystem.pressure, pressure_delta: pressureDelta(currentSystem.pressure, lastSystem.pressure),
      memory_current: currentSystem.memory_current, memory_max: currentSystem.memory_max,
      memory_stat: currentSystem.memory_stat, memory_stat_delta: memoryDelta(currentSystem.memory_stat, lastSystem.memory_stat),
      host_steal_ticks: currentSystem.host_steal_ticks, host_steal_delta_ticks: difference(currentSystem.host_steal_ticks, lastSystem.host_steal_ticks) })
    if (currentSystem) { lastSystem = currentSystem; lastSystemAt = systemAt! }
    lastResource = currentResource
    last = end; lastCpu = currentCpu; lastStat = currentStat; lastHeap = currentHeap
    timer = timers.setTimeout(tick, 10)
  }
  timer = timers.setTimeout(tick, 10)
  return () => { stopped = true; timers.clearTimeout(timer); if (syncObserver === observer) syncObserver = undefined }
}
