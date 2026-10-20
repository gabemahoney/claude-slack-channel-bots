/** Transcript I/O and schemas are private to this adapter (b.omv SR-6). */
import * as nodeFs from 'node:fs'
import { locateTranscript } from './session-transcript.ts'
import type { QueueItem, SentRecord, DeliveredRecord } from './delivery-queue.ts'

export type DeliveryAgent = 'claude' | 'codex'

export interface DeliveryTranscriptRow {
  jsonl_path?: string; session_id?: string; cwd?: string; transcript_status?: string
  prior_sessions?: readonly { jsonl_path?: string; session_id?: string; cwd?: string }[]
}
export interface ReceiptRecord { path: string; offset: number; end: number; uuid?: string; at?: number; text: string; kind: string }
export interface ReceiptObservation {
  path: string; size: number; availability: 'readable' | 'not-yet-written' | 'unreadable'
  records: readonly ReceiptRecord[]; receipt?: ReceiptRecord
}
const TRANSCRIPT_READ_BYTES = 256 * 1024
const object = (v: unknown): Record<string, any> | undefined => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, any> : undefined
function textBlocks(value: unknown, type: string): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const blocks = value.filter(b => object(b)?.type === type && typeof b.text === 'string')
  return blocks.length ? blocks.map(b => b.text).join('') : undefined
}
/** Exact match, allowing only SR-6.2's optional LFs beside each paste block.
 * Matching against the target bounds the search; no greedy whitespace trim. */
export function receiptTextMatches(record: string, expected: string): boolean {
  if (record === expected) return true
  const re = /<pasted_content id="([^"]+)">\n([\s\S]*?)\n<\/pasted_content id="\1">/g
  const matches = [...record.matchAll(re)]
  if (!matches.length) return false
  const memo = new Map<string, boolean>()
  function match(index: number, source: number, target: number): boolean {
    const key = `${index}:${source}:${target}`
    const saved = memo.get(key); if (saved !== undefined) return saved
    if (index === matches.length) return record.slice(source) === expected.slice(target)
    const m = matches[index]!, at = m.index!, end = at + m[0].length
    for (let left = 0; left <= 2; left++) {
      if (left && record.slice(at - left, at) !== '\n'.repeat(left)) continue
      if (at - left < source) continue
      const segment = record.slice(source, at - left) + m[2]!
      if (!expected.startsWith(segment, target)) continue
      for (let right = 0; right <= 2; right++) {
        if (right && record.slice(end, end + right) !== '\n'.repeat(right)) continue
        if (match(index + 1, end + right, target + segment.length)) { memo.set(key, true); return true }
      }
    }
    memo.set(key, false); return false
  }
  return match(0, 0, 0)
}
export function parseDeliveryTranscriptRecord(agent: DeliveryAgent, value: unknown): { text?: string; kind: string; uuid?: string } {
  const e = object(value); if (!e) return { kind: 'other' }
  const uuid = typeof e.uuid === 'string' ? e.uuid : undefined
  if (agent === 'codex') {
    const p = object(e.payload)
    if (e.type === 'response_item' && p?.type === 'message' && p.role === 'user') return { kind: 'take-in', text: textBlocks(p.content, 'input_text'), uuid }
    return { kind: 'other' }
  }
  if (e.isSidechain === true || (e.origin !== undefined && e.origin?.kind !== 'human')) return { kind: 'other' }
  if (e.type === 'user' && !e.isMeta) return { kind: 'take-in', text: textBlocks(e.message?.content, 'text'), uuid }
  if (e.type === 'attachment' && e.attachment?.type === 'queued_command' && (e.attachment.origin === undefined || e.attachment.origin?.kind === 'human')) return { kind: 'take-in', text: textBlocks(e.attachment.prompt, 'text'), uuid }
  return { kind: 'other' }
}
export function effectiveSends(item: QueueItem, part: number): SentRecord[] {
  const refused = new Set(item.records.filter(r => r.kind === 'refused').map(r => r.attempt))
  return item.records.filter((r): r is SentRecord => r.kind === 'sent' && !('unknown_outcome' in r) && r.part === part && !refused.has(r.attempt))
}
export function deliveryTranscriptPath(agent: DeliveryAgent, row: DeliveryTranscriptRow, configDir?: string): string | undefined {
  return agent === 'codex' ? row.jsonl_path || undefined : locateTranscript(row, configDir)
}
interface CachedFile { dev: number; ino: number; size: number; pending: Buffer; records: ReceiptRecord[] }
export interface DeliveryReceiptReader {
  read(agent: DeliveryAgent, row: DeliveryTranscriptRow, item: QueueItem, part: number, allItems?: readonly QueueItem[], configDir?: string): ReceiptObservation
  forget(): void
}
function receiptIdentity(receipt: { path: string; uuid?: string; offset?: number }): string {
  return receipt.uuid ? `uuid:${receipt.uuid}` : `${receipt.path}:${receipt.offset}`
}
/** Open NONBLOCK, fstat before reading, and consume only appended bytes. A
 * missing new session and an existing empty file are not read failures. */
export function createDeliveryReceiptReader(options: { fs?: typeof nodeFs } = {}): DeliveryReceiptReader {
  const fs = options.fs ?? nodeFs, files = new Map<string, CachedFile>()
  // Freeze each known file's pre-send EOF when the durable attempt first
  // appears. An absent entry means the file was discovered after that send,
  // so its entire contents are eligible (SR-6.2). Keep this independently of
  // the parsed cache, including when a file cannot currently be opened.
  const observed = new Map<string, number>(), windows = new Map<string, ReadonlyMap<string, number>>()
  const sendIdentity = (seq: number, send: SentRecord): string => `${seq}:${send.part}:${send.attempt}`
  function readFile(agent: DeliveryAgent, path: string, missingAllowed: boolean): { size: number; availability: ReceiptObservation['availability']; records: readonly ReceiptRecord[] } {
    let fd: number | undefined, observedSize: number | undefined
    try {
      // EOF is still meaningful when opening a regular file is refused.
      // The post-open fstat below also closes the stat/open replacement race.
      const before = fs.statSync(path)
      observedSize = before.size
      if (!before.isFile()) throw new Error('Not a regular transcript')
      fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      const st = fs.fstatSync(fd)
      if (!st.isFile()) throw new Error('Not a regular transcript')
      let c = files.get(path)
      if (!c || c.dev !== st.dev || c.ino !== st.ino || st.size < c.size) { c = { dev: st.dev, ino: st.ino, size: 0, pending: Buffer.alloc(0), records: [] }; files.set(path, c) }
      while (c.size < st.size) {
        const buffer = Buffer.alloc(Math.min(TRANSCRIPT_READ_BYTES, st.size - c.size))
        const n = fs.readSync(fd, buffer, 0, buffer.length, c.size)
        if (n === 0) throw new Error('Short transcript read')
        const start = c.size - c.pending.length, bytes = Buffer.concat([c.pending, buffer.subarray(0, n)])
        c.size += n
        let offset = 0, newline: number
        while ((newline = bytes.indexOf(10, offset)) >= 0) {
          try {
            const value: unknown = JSON.parse(bytes.subarray(offset, newline).toString('utf8'))
            const parsed = parseDeliveryTranscriptRecord(agent, value)
            const timestamp = object(value)?.timestamp
            const at = typeof timestamp === 'string' ? Date.parse(timestamp) : typeof timestamp === 'number' ? timestamp : undefined
            if (parsed.kind !== 'other') c.records.push({ path, offset: start + offset, end: start + newline + 1, text: parsed.text ?? '', kind: parsed.kind, uuid: parsed.uuid, at: at !== undefined && Number.isFinite(at) ? at : undefined })
          } catch { /* incomplete/damaged lines cannot confirm */ }
          offset = newline + 1
        }
        c.pending = bytes.subarray(offset)
      }
      return { size: st.size, availability: st.size ? 'readable' : 'not-yet-written', records: c.records }
    } catch (err) {
      const c = files.get(path)
      return { size: observedSize ?? c?.size ?? 0, availability: missingAllowed && (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-yet-written' : 'unreadable', records: c?.records ?? [] }
    } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
  }
  return {
    forget() { files.clear(); observed.clear(); windows.clear() },
    read(agent, row, item, part, allItems = [item], configDir) {
      // Register all durable sends before discovering/reading this lap's
      // files. This also preserves the discovery order when the next FIFO
      // head is first observed after another item's receipt was read.
      for (const queued of allItems) {
        for (const record of queued.records) {
          if (record.kind !== 'sent' || 'unknown_outcome' in record) continue
          const identity = sendIdentity(queued.accepted.seq, record)
          if (!windows.has(identity)) windows.set(identity, new Map(observed))
        }
      }
      const path = deliveryTranscriptPath(agent, row, configDir) ?? ''
      const sends = effectiveSends(item, part), first = sends[0]
      const unknown = item.records.find(r => r.kind === 'sent' && 'unknown_outcome' in r)
      const paths = new Set([path, ...sends.map(s => s.transcript_path), ...(row.prior_sessions ?? []).map(r => deliveryTranscriptPath(agent, r, configDir) ?? '')].filter(Boolean))
      const records: ReceiptRecord[] = []
      const availability = new Map<string, ReceiptObservation['availability']>()
      let size = 0, unreadable = false
      const credited = new Set(allItems.flatMap(i => i.records.filter((r): r is DeliveredRecord => r.kind === 'delivered').map(r => receiptIdentity(r.receipt))))
      const inWindow = (r: ReceiptRecord, send: SentRecord | undefined): boolean => send
        ? r.offset >= (r.path === send.transcript_path ? send.transcript_size : windows.get(sendIdentity(item.accepted.seq, send))?.get(r.path) ?? 0)
        : !!unknown && r.at !== undefined && r.at >= unknown.at
      for (const p of paths) {
        const current = p === path
        const f = readFile(agent, p, current && row.transcript_status !== 'present')
        observed.set(p, f.size)
        availability.set(p, f.availability)
        if (current) size = f.size
        if (f.availability === 'unreadable') unreadable = true
        records.push(...f.records)
      }
      const text = item.fixed?.parts[part - 1] ?? ''
      const receipt = records.find(r => availability.get(r.path) === 'readable' && r.kind === 'take-in' && inWindow(r, first) && receiptTextMatches(r.text, text) && !credited.has(receiptIdentity(r)))
      return { path, size, availability: unreadable ? 'unreadable' : size ? 'readable' : 'not-yet-written', records, receipt }
    },
  }
}
