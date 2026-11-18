/** Test-only SR-8 attribution. No import-time I/O or timers. Installed only
 * with test_measurements, once at startup; independent of per-event timings. */
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'

export interface CpuStat { nr_periods: number; nr_throttled: number; throttled_usec: number; usage_usec: number }
export interface HeapSample { heap_used: number; heap_total: number }
export interface SyncWorkMeasurement {
  process_id?: number
  kind: 'sync-work'; work: string; key?: string; start_mono_ms: number; end_mono_ms: number; at_mono_ms: number
}
export interface StallMeasurement {
  process_id?: number
  kind: 'event-loop-stall'; start_mono_ms: number; end_mono_ms: number; at_mono_ms: number
  expected_mono_ms: number; gap_ms: number; elapsed_ms: number; cpu_user_usec: number; cpu_system_usec: number
  cpu_stat: CpuStat | null; cpu_stat_delta: CpuStat | null; cpu_stat_before_mono_ms: number
  heap_before: HeapSample | null; heap_after: HeapSample | null
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
export interface AttributionDeps {
  record(entry: AttributionMeasurement): void
  now?: () => number
  cpu?: () => NodeJS.CpuUsage
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
  const emit = (entry: AttributionMeasurement) => { try { deps.record(entry) } catch { /* observation never affects server */ } }
  // Use the same injected clock for markers and probe in deterministic tests.
  const observer = (entry: SyncWorkMeasurement) => emit(entry)
  syncNow = now
  syncObserver = observer
  let last = now(), lastCpu = cpu(), lastStat = sampleStat(), lastHeap = sampleHeap(), stopped = false
  let timer: unknown
  function tick(): void {
    if (stopped) return
    const end = now(), currentCpu = cpu(), currentStat = sampleStat(), currentHeap = sampleHeap()
    const gap = end - last - 10
    if (gap > 20) emit({ kind: 'event-loop-stall', start_mono_ms: last, end_mono_ms: end, at_mono_ms: end,
      expected_mono_ms: last + 10, gap_ms: gap, elapsed_ms: end - last,
      cpu_user_usec: currentCpu.user - lastCpu.user, cpu_system_usec: currentCpu.system - lastCpu.system,
      cpu_stat: currentStat, cpu_stat_delta: delta(currentStat, lastStat), cpu_stat_before_mono_ms: last,
      heap_before: lastHeap, heap_after: currentHeap })
    last = end; lastCpu = currentCpu; lastStat = currentStat; lastHeap = currentHeap
    timer = timers.setTimeout(tick, 10)
  }
  timer = timers.setTimeout(tick, 10)
  return () => { stopped = true; timers.clearTimeout(timer); if (syncObserver === observer) syncObserver = undefined }
}
