/** Informational SR-8 evidence, separate from all verdict calculations.
 * Standalone failure command runs after server stop, before scenario cleanup. */
import { existsSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Context } from './sr8-evidence.ts'

type Row = Record<string, any>
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const word = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9_-]+$/.test(s)
const span = (r: Row) => finite(r.start_mono_ms) && finite(r.end_mono_ms) && r.end_mono_ms >= r.start_mono_ms
const sameProcess = (a: Row, b: Row) => a.process_id === b.process_id
const overlaps = (r: Row, start: number, end: number) => span(r) && r.start_mono_ms <= end && r.end_mono_ms >= start
// Only recorder-owned numeric/fixed-word fields reach the compact log. The full
// file is retained separately; no error, path, content or arbitrary string field.
const FIELDS = ['v', 'kind', 'process_id', 'key', 'seq', 'seqs', 'store', 'store_ms', 'held_ms', 'outcome', 'cause', 'phase', 'work', 'at_mono_ms',
  'received_mono_ms', 'due_mono_ms', 'armed_delay_ms', 'start_mono_ms', 'end_mono_ms', 'expected_mono_ms', 'elapsed_ms', 'gap_ms',
  'cpu_user_usec', 'cpu_system_usec', 'cpu_stat_before_mono_ms', 'cpu_stat', 'cpu_stat_delta', 'heap_before', 'heap_after',
  'keys', 'ts', 'targets', 'receive_to_ack_ms', 'ack_call_ms', 'journal', 'records', 'bytes', 'append_ms', 'file_fsync_ms', 'dir_fsync_ms', 'fsyncs', 'joins', 'intents', 'outcomes']
function safeValue(value: unknown): unknown {
  if (value === null || finite(value)) return value
  if (word(value) || (typeof value === 'string' && /^\d{1,12}\.\d{1,6}$/.test(value))) return value
  if (Array.isArray(value)) return value.slice(0, 100).map(safeValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => [...FIELDS, 'nr_periods', 'nr_throttled', 'throttled_usec', 'usage_usec', 'heap_used', 'heap_total'].includes(k)).map(([k, v]) => [k, safeValue(v)]))
  return undefined
}
const safeRow = (r: Row) => Object.fromEntries(FIELDS.filter(k => r[k] !== undefined).map(k => [k, safeValue(r[k])]))
const json = (r: Row | Row[]) => JSON.stringify(Array.isArray(r) ? r.map(safeRow) : safeRow(r))
function line(scenario: string, type: string, fields: string): string {
  if (!word(scenario)) throw new Error('invalid attribution scenario')
  return `recorded: sr8 attribution scenario=${scenario} type=${type} ${fields} verdict=info`
}
function holds(rows: Row[]) {
  const groups = new Map<string, Row[]>()
  for (const row of rows) if (row.kind === 'post-hold-timing' && word(row.key) && finite(row.seq) && finite(row.due_mono_ms)) {
    const id = `${row.process_id ?? 'unknown'}:${row.key}:${row.seq}`, group = groups.get(id) ?? []
    group.push(row); groups.set(id, group)
  }
  return [...groups.values()].map(group => ({ first: group[0]!, callbacks: group.filter(r => r.phase === 'callback'),
    evaluation: group.find(r => r.phase === 'evaluate') }))
}
export function attributionLines(c: Pick<Context, 'scenario'> & Partial<Omit<Context, 'scenario'>>, rows: Row[], cap = 200): string[] {
  const stalls = rows.filter(r => r.kind === 'event-loop-stall' && span(r) && finite(r.gap_ms) && r.gap_ms > 20)
  const markers = rows.filter(r => r.kind === 'sync-work' && span(r))
  const lines: string[] = []
  const context = c.mode === undefined ? '' : `mode=${c.mode} population=${c.population} recipients=${c.recipients} `
  const info = (type: string, fields: string) => line(c.scenario, type, context + fields)
  for (const { first: h, callbacks, evaluation: e } of holds(rows)) {
    const end = e?.at_mono_ms
    const matchingStalls = finite(end) ? stalls.filter(r => sameProcess(r, h) && overlaps(r, h.due_mono_ms, end)) : []
    const matchingMarkers = finite(end) ? markers.filter(r => sameProcess(r, h) && overlaps(r, h.due_mono_ms, end)) : []
    lines.push(info('post-hold', `process_id=${h.process_id ?? 'unavailable'} key=${h.key} seq=${h.seq} received_mono_ms=${h.received_mono_ms} due_mono_ms=${h.due_mono_ms} callbacks=${json(callbacks)} evaluate_mono_ms=${end ?? 'unavailable'} lateness_ms=${finite(end) ? end - h.due_mono_ms : 'unavailable'} stall_count=${matchingStalls.length} stalls=${json(matchingStalls.slice(0, 50))} marker_count=${matchingMarkers.length} markers=${json(matchingMarkers.slice(0, 50))}`))
  }
  // Prefer the largest gaps when the log cap applies; every hold above still
  // carries its own overlaps independently of this global printing cap.
  for (const stall of [...stalls].sort((a, b) => b.gap_ms - a.gap_ms).slice(0, cap)) {
    const matching = markers.filter(r => sameProcess(r, stall) && overlaps(r, stall.start_mono_ms, stall.end_mono_ms))
    lines.push(info('stall', `data=${json(stall)} marker_count=${matching.length} markers=${json(matching.slice(0, 50))}`))
  }
  lines.push(info('stall-summary', `count=${stalls.length} printed=${Math.min(cap, stalls.length)} max_gap_ms=${stalls.reduce((n, r) => Math.max(n, r.gap_ms), 0)} total_gap_ms=${stalls.reduce((n, r) => n + r.gap_ms, 0)} marker_count=${markers.length}`))
  return lines
}
export function readAttributionRows(path: string, offset = 0): Row[] {
  try {
    const bytes = readFileSync(path).subarray(offset).toString(), lines = bytes.split('\n')
    lines.pop() // a live or killed writer may leave an incomplete last row
    return lines.flatMap(line => { try { const r = JSON.parse(line); return r?.v === 1 && finite(r.at_mono_ms) ? [r] : [] } catch { return [] } })
  } catch { return [] }
}
/** Testable file retention: destination is the shard's existing results mount.
 * Never follow symlinks in a scenario scratch tree. A copy is byte-for-byte. */
export function retainFailureMeasurements(scenario: string, root: string, destination: string, holdMs: number, allowanceMs: number, cap = 400): string[] {
  const lines: string[] = [], files: string[] = []
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /^(test-measurements|measurements)\.jsonl$/.test(entry.name)) files.push(path)
    }
  }
  walk(root); mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const [index, file] of files.sort().slice(0, 64).entries()) {
    if (!lstatSync(file).isFile()) continue
    const kept = join(destination, `${scenario}.sh.sr8-measurements-${index + 1}.jsonl`)
    copyFileSync(file, kept)
    lines.push(line(scenario, 'kept-file', `path=${kept} source=${file}`))
    const rows = readAttributionRows(file)
    lines.push(...attributionLines({ scenario }, rows).map(l => l.replace(' verdict=info', ` file=${basename(kept)} verdict=info`)))
    const windows: Array<[number, number]> = []
    for (const { first: h, evaluation: e } of holds(rows)) {
      const resolved = rows.find(r => r.kind === 'post-hold-resolved' && r.key === h.key && r.seq === h.seq && finite(r.held_ms))
      const append = rows.filter(r => r.kind === 'resolution-store' && r.key === h.key && r.seqs?.includes(h.seq)).sort((a, b) => a.at_mono_ms - b.at_mono_ms)[0]
      if (e && resolved && append && resolved.held_ms - holdMs - append.store_ms > allowanceMs) windows.push([h.due_mono_ms - 2000, e.at_mono_ms + 2000])
    }
    const nearby = rows.filter(r => windows.some(([start, end]) => (r.at_mono_ms >= start && r.at_mono_ms <= end) || overlaps(r, start, end)))
    const important = nearby.filter(r => ['post-hold-timing', 'post-hold-resolved', 'resolution-store', 'sync-work', 'event-loop-stall'].includes(r.kind))
    const selected = new Set([...important, ...nearby].slice(0, cap))
    for (const row of nearby.filter(r => selected.has(r))) lines.push(line(scenario, 'failure-row', `file=${basename(kept)} data=${json(row)}`))
    lines.push(line(scenario, 'failure-summary', `file=${basename(kept)} windows=${windows.length} rows=${nearby.length} printed=${Math.min(cap, nearby.length)}`))
  }
  return lines
}
if (import.meta.main) {
  if (!existsSync('/etc/cscb-ci-image')) {
    console.error('sr8-attribution requires the CI image')
    process.exitCode = 2
  } else {
    const [scenario, root, destination, holdMs] = process.argv.slice(2)
    try {
      if (!word(scenario) || !root || !destination || !finite(Number(holdMs))) throw new Error('invalid retention arguments')
      const { SR8_DISPATCH_ALLOWANCE_MS } = await import('./sr8-evidence.ts')
      for (const entry of retainFailureMeasurements(scenario, root, destination, Number(holdMs), SR8_DISPATCH_ALLOWANCE_MS)) console.log(entry)
    } catch { console.log('recorded: sr8 attribution type=retention-unavailable verdict=info') }
  }
}
