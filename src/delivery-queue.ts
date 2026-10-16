/** Durable per-persona FIFO journals. No import-time I/O (b.omv SR-3). */
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PERSONA_KEY_RE } from './persona-identity.ts'

export const QUEUE_KEY_KEEP_MS = 24 * 60 * 60 * 1000
export const QUEUE_COMPACT_INTERVAL_MS = 60 * 60 * 1000
export const QUEUE_DIRECTORY_MODE = 0o700
export const QUEUE_FILE_MODE = 0o600
export type DeliverySource = 'slack' | 'interject' | 'cron'
export interface SlackKey { chat_id: string; ts: string; edited_ts?: string }
export interface QueueFile { name: string; mimetype?: string; size?: number }
export interface AcceptedInput {
  source: DeliverySource
  text: string
  received_at?: number
  ts?: string
  sender?: string
  key?: SlackKey
  channel?: string
  channel_type?: string
  thread_ts?: string
  edited_ts?: string
  user?: string
  bot_id?: string
  username?: string
  bot_profile_name?: string
  files?: QueueFile[]
  via?: string
}
interface BaseRecord { v: 1; seq: number }
export interface AcceptedRecord extends BaseRecord, AcceptedInput {
  kind: 'accepted'; received_at: number; ts: string; attempt_high_watermark?: number
}
/** Compaction keeps dedupe facts without message content (SR-3.4/3.5). */
export interface QueueKeyRecord extends BaseRecord {
  kind: 'accepted'; compact: 'key'; key: SlackKey; received_at: number; delivered_at: number
}
/** Non-content high water marks survive even an entirely delivered injected queue. */
export interface QueueAllocationRecord extends BaseRecord {
  kind: 'accepted'; compact: 'allocation'; injected_ts?: string
}
export interface FixedRecord extends BaseRecord { kind: 'fixed'; parts: string[] }
export interface SentRecord extends BaseRecord {
  kind: 'sent'; attempt: number; part: number; send_kind: 'text' | 'enter' | 'retype'
  at: number; launch_id: string; session_id: string; transcript_path: string; transcript_size: number
}
/** A damaged send remains evidence of an unknown outcome, across compaction/restart. */
export interface UnknownSentRecord extends BaseRecord {
  kind: 'sent'; attempt: number; unknown_outcome: true; at: number; quarantine: { path: string; line: number }
}
export interface DeliveredRecord extends BaseRecord {
  kind: 'delivered'; part: number; at: number; receipt: { path: string; uuid?: string; offset?: number }
}
export interface RefusedRecord extends BaseRecord { kind: 'refused'; attempt: number; at: number }
export interface NoticedRecord extends BaseRecord { kind: 'noticed'; at: number }
export type QueueRecord = AcceptedRecord | QueueKeyRecord | QueueAllocationRecord | FixedRecord | SentRecord | UnknownSentRecord | DeliveredRecord | RefusedRecord | NoticedRecord
export type ItemRecord = AcceptedRecord | FixedRecord | SentRecord | UnknownSentRecord | DeliveredRecord | RefusedRecord | NoticedRecord
export interface QueueItem {
  accepted: AcceptedRecord; fixed?: FixedRecord; records: ItemRecord[]; delivered: boolean
  unknownSend: boolean; retypeCount: number; nextAttempt: number
}
export type QueueEvent =
  | { type: 'store-failed'; key: string; path?: string; source?: DeliverySource; sender?: string; user?: string; bot_id?: string; channel?: string; ts?: string; error: unknown }
  | { type: 'stored' | 'writable'; key: string }
  | { type: 'append-failed' | 'recovery-failed' | 'compaction-failed'; key: string; path?: string; seq?: number; error: unknown }
  | { type: 'record-unreadable'; key: string; line: number; quarantinePath: string; alert: boolean }
  | { type: 'retained'; key: string; count: number }
export type QueueAcceptResult = { status: 'accepted' | 'duplicate'; item?: QueueItem; seq: number } | { status: 'failed'; error: unknown }
export type QueueAccept = (key: string, input: AcceptedInput) => Promise<QueueAcceptResult>
export interface DeliveryQueue {
  start(): Promise<void>
  accept: QueueAccept
  append(key: string, record: QueueRecord): Promise<void>
  lookupSlackKey(key: string, slackKey: SlackKey): QueueAcceptResult | undefined
  /** A current snapshot of one item, without cloning the rest of the queue. */
  item(key: string, seq: number): QueueItem | undefined
  items(key: string): QueueItem[]
  openCount(key: string): number
  /** A failed post-accept append suspends all keys until an append succeeds. */
  isWritable?(key: string): boolean
  keys(): string[]
  compact(key?: string): Promise<void>
  startMaintenance(): void
  stop(): Promise<void>
  retained(key: string): void
  startupFindings(): QueueEvent[]
}
export interface DeliveryQueueOptions {
  stateDir: string
  now?: () => number
  onEvent?: (event: QueueEvent) => void
  fs?: typeof nodeFs
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const integer = (v: unknown): v is number => number(v) && Number.isSafeInteger(v) && v >= 0
const positive = (v: unknown): v is number => integer(v) && v > 0
const timestamp = (v: unknown): v is string => str(v) && /^\d+\.\d{6}$/.test(v)
export function isSlackKey(v: unknown): v is SlackKey {
  return object(v) && str(v.chat_id) && v.chat_id !== '' && str(v.ts) && v.ts !== '' && (v.edited_ts === undefined || str(v.edited_ts))
}
/** Structural on-disk schema. Invalid versions/kinds and partial records are never replayed. */
export function isQueueRecord(value: unknown): value is QueueRecord {
  if (!object(value) || value.v !== 1 || !integer(value.seq)) return false
  const r = value
  switch (r.kind) {
    case 'accepted':
      if (r.compact === 'allocation') return (r.injected_ts === undefined || timestamp(r.injected_ts)) && Object.keys(r).every(k => ['v', 'kind', 'seq', 'compact', 'injected_ts'].includes(k))
      if (r.compact === 'key') return isSlackKey(r.key) && number(r.received_at) && number(r.delivered_at) && Object.keys(r).every(k => ['v', 'kind', 'seq', 'compact', 'key', 'received_at', 'delivered_at'].includes(k))
      if (r.compact !== undefined || !['slack', 'interject', 'cron'].includes(String(r.source)) || !str(r.text) || !str(r.ts) || !number(r.received_at)) return false
      if (r.attempt_high_watermark !== undefined && !integer(r.attempt_high_watermark)) return false
      for (const k of ['sender', 'channel', 'channel_type', 'thread_ts', 'edited_ts', 'user', 'bot_id', 'username', 'bot_profile_name', 'via']) if (r[k] !== undefined && !str(r[k])) return false
      if (r.files !== undefined && (!Array.isArray(r.files) || !r.files.every(f => object(f) && str(f.name) && (f.mimetype === undefined || str(f.mimetype)) && (f.size === undefined || number(f.size))))) return false
      return r.source === 'slack' ? isSlackKey(r.key) && str(r.channel) && str(r.via) : timestamp(r.ts) && str(r.sender) && r.key === undefined
    case 'fixed': return Array.isArray(r.parts) && r.parts.length > 0 && r.parts.every(p => str(p) && p !== '')
    case 'sent':
      if (!positive(r.attempt) || !number(r.at)) return false
      if (r.unknown_outcome === true) return object(r.quarantine) && str(r.quarantine.path) && positive(r.quarantine.line)
      return positive(r.part) && ['text', 'enter', 'retype'].includes(String(r.send_kind)) && str(r.launch_id) && str(r.session_id) && str(r.transcript_path) && integer(r.transcript_size)
    case 'delivered': return positive(r.part) && number(r.at) && object(r.receipt) && str(r.receipt.path) && (str(r.receipt.uuid) || integer(r.receipt.offset))
    case 'refused': return positive(r.attempt) && number(r.at)
    case 'noticed': return number(r.at)
    default: return false
  }
}
export function parseQueueRecord(line: string): QueueRecord | undefined {
  try { const value: unknown = JSON.parse(line); return isQueueRecord(value) ? value : undefined } catch { return undefined }
}
export function slackKeyString(key: SlackKey): string { return JSON.stringify([key.chat_id, key.ts, key.edited_ts ?? null]) }
function isAccepted(r: QueueRecord): r is AcceptedRecord { return r.kind === 'accepted' && !('compact' in r) }
function microseconds(ts: string): bigint { const [s, f = ''] = ts.split('.'); return BigInt(s!) * 1000000n + BigInt(f.padEnd(6, '0').slice(0, 6)) }
function formatMicros(us: bigint): string { return `${us / 1000000n}.${String(us % 1000000n).padStart(6, '0')}` }
interface AppendRollback { pendingRollback?: number }
interface Journal extends AppendRollback { records: QueueRecord[]; nextSeq: number; lastInjected?: bigint; loaded: boolean; quarantineRollback?: AppendRollback }
/** All file access is explicit; construction allocates only memory (SR-13.1). */
export function createDeliveryQueue(options: DeliveryQueueOptions): DeliveryQueue {
  const fs = options.fs ?? nodeFs
  const now = options.now ?? Date.now
  const dir = join(options.stateDir, 'queue')
  const journals = new Map<string, Journal>()
  const writers = new Map<string, Promise<unknown>>()
  const appendBlocked = new Set<string>()
  const startId = `${new Date(now()).toISOString().replace(/[:]/g, '-')}-${randomUUID()}`
  let started = false, stopped = false
  let timer: ReturnType<typeof globalThis.setInterval> | undefined
  const findings: QueueEvent[] = []
  function event(e: QueueEvent): void { if (e.type === 'record-unreadable') findings.push({ ...e }); try { void Promise.resolve(options.onEvent?.(e)).catch(() => {}) } catch { /* observers cannot change durable outcomes */ } }
  function pathFor(key: string): string {
    if (!PERSONA_KEY_RE.test(key)) throw new Error('Invalid queue persona key')
    return join(dir, `${key}.jsonl`)
  }
  function journal(key: string): Journal {
    pathFor(key)
    let j = journals.get(key)
    if (!j) { j = { records: [], nextSeq: 1, loaded: false }; journals.set(key, j) }
    return j
  }
  function serial<T>(key: string, work: () => T | Promise<T>): Promise<T> {
    const next = (writers.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    writers.set(key, next)
    return next
  }
  function syncDir(path: string): void { const fd = fs.openSync(path, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
  function ensureDir(): void {
    fs.mkdirSync(dir, { recursive: true, mode: QUEUE_DIRECTORY_MODE })
    fs.chmodSync(dir, QUEUE_DIRECTORY_MODE)
    // Persist the queue directory entry too, before any acceptance.
    syncDir(options.stateDir)
  }
  function writeAll(fd: number, bytes: Uint8Array): void {
    let offset = 0
    while (offset < bytes.length) { const n = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (n <= 0) throw new Error('Short queue write'); offset += n }
  }
  function durableAppend(path: string, bytes: Uint8Array, rollback?: AppendRollback): void {
    ensureDir()
    const fd = fs.openSync(path, 'a+', QUEUE_FILE_MODE)
    let original: number | undefined
    try {
      // A failed reconciliation still owes the original rollback, not the
      // current file length, which may contain an unaccepted append.
      original = rollback?.pendingRollback ?? fs.fstatSync(fd).size
      fs.fchmodSync(fd, QUEUE_FILE_MODE)
      if (rollback?.pendingRollback !== undefined) {
        fs.ftruncateSync(fd, rollback.pendingRollback); fs.fsyncSync(fd)
        original = rollback.pendingRollback; delete rollback.pendingRollback
      }
      if (original > 0) { const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, original - 1); if (last[0] !== 10) writeAll(fd, Buffer.from('\n')) }
      writeAll(fd, bytes)
      fs.fsyncSync(fd)
      // Always sync: a previous failed first append may have left an unsynced directory entry.
      syncDir(dir)
    } catch (error) {
      if (rollback && original !== undefined) {
        rollback.pendingRollback ??= original
        try { fs.ftruncateSync(fd, rollback.pendingRollback); fs.fsyncSync(fd); delete rollback.pendingRollback } catch { /* next append must reconcile before writing */ }
      }
      throw error
    } finally { try { fs.closeSync(fd) } catch { /* fsync is the durability boundary */ } }
  }
  function update(j: Journal, record: QueueRecord): void {
    j.records.push(record); j.nextSeq = Math.max(j.nextSeq, record.seq + 1)
    if (record.kind === 'accepted') {
      const ts = 'compact' in record ? record.compact === 'allocation' ? record.injected_ts : undefined : record.source !== 'slack' ? record.ts : undefined
      if (ts) j.lastInjected = j.lastInjected !== undefined && j.lastInjected > microseconds(ts) ? j.lastInjected : microseconds(ts)
    }
  }
  function materialize(j: Journal): QueueItem[] {
    const result = new Map<number, QueueItem>()
    for (const r of j.records) {
      if (isAccepted(r)) { if (!result.has(r.seq)) result.set(r.seq, { accepted: r, records: [r], delivered: false, unknownSend: false, retypeCount: 0, nextAttempt: (r.attempt_high_watermark ?? 0) + 1 }); continue }
      if (r.kind === 'accepted') continue
      const item = result.get(r.seq)
      if (item) { item.records.push(r); if (r.kind === 'fixed') item.fixed ??= r }
    }
    for (const item of result.values()) {
      const refused = new Set(item.records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
      for (const r of item.records) if (r.kind === 'refused') item.nextAttempt = Math.max(item.nextAttempt, r.attempt + 1)
      for (const r of item.records) if (r.kind === 'sent') {
        item.nextAttempt = Math.max(item.nextAttempt, r.attempt + 1)
        if ('unknown_outcome' in r) item.unknownSend = true
        else if (r.send_kind === 'retype' && !refused.has(r.attempt)) item.retypeCount++
      }
      if (item.fixed) item.delivered = item.fixed.parts.every((_, i) => item.records.some(r => r.kind === 'delivered' && r.part === i + 1))
    }
    return [...result.values()].sort((a, b) => a.accepted.seq - b.accepted.seq)
  }
  function load(key: string): void {
    const stored = journal(key)
    if (stored.loaded) return
    // Publish only a complete replay: a failed read or quarantine append must
    // remain retryable without exposing partial rows or dedupe facts.
    const j: Journal = { records: [], nextSeq: 1, loaded: false }
    let bytes: Buffer
    try { bytes = fs.readFileSync(pathFor(key)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { stored.loaded = true; return }
      event({ type: 'recovery-failed', key, error }); throw error
    }
    const lines: { bytes: Buffer; line: number; record?: QueueRecord; raw?: Record<string, unknown>; whole: boolean }[] = []
    let offset = 0, line = 0
    while (offset < bytes.length) {
      const nl = bytes.indexOf(10, offset), end = nl < 0 ? bytes.length : nl + 1
      const chunk = bytes.subarray(offset, end); const text = chunk.toString('utf8').replace(/\n$/, '')
      let raw: Record<string, unknown> | undefined
      try { const parsed: unknown = JSON.parse(text); if (object(parsed)) raw = parsed } catch {
        // A torn or syntactically damaged send can still identify its item. Retain
        // conservative unknown-outcome evidence, never the damaged text (SR-3.6).
        const kind = /(?:^|[,{])\s*"kind"\s*:\s*"([^"\\]+)"/.exec(text)?.[1]
        const seqText = /(?:^|[,{])\s*"seq"\s*:\s*(\d+)(?=\s*[,}])/.exec(text)?.[1]
        const attemptText = /(?:^|[,{])\s*"attempt"\s*:\s*(\d+)(?=\s*[,}])/.exec(text)?.[1]
        if (kind !== undefined || seqText !== undefined) raw = { kind, seq: seqText === undefined ? undefined : Number(seqText), attempt: attemptText === undefined ? undefined : Number(attemptText) }
      }
      // Buffer roundtrip rejects invalid UTF-8 rather than silently fixing stored text.
      const whole = nl >= 0 && Buffer.from(text).equals(chunk.subarray(0, chunk.length - 1))
      lines.push({ bytes: chunk, line: ++line, record: whole ? parseQueueRecord(text) : undefined, raw, whole })
      offset = end
    }
    const accepted = new Set(lines.flatMap(l => l.record && isAccepted(l.record) ? [l.record.seq] : []))
    const quarantinePath = join(dir, `${key}.unreadable-${startId}`)
    const damaged: typeof lines = []
    const seenAccept = new Set<number>()
    for (const l of lines) {
      const r = l.record
      const orphan = r && r.kind !== 'accepted' && !accepted.has(r.seq)
      const duplicate = r && isAccepted(r) && seenAccept.has(r.seq)
      if (!r || orphan || duplicate) { damaged.push(l); continue }
      if (isAccepted(r)) seenAccept.add(r.seq)
      update(j, r)
    }
    // Put accepted records first for recovery of valid out-of-order journal rows.
    j.records.sort((a, b) => a.seq - b.seq || (isAccepted(a) ? -1 : isAccepted(b) ? 1 : 0))
    if (damaged.length) {
      // Exact original bytes, including torn tails, preserved before rewriting the source.
      durableAppend(quarantinePath, Buffer.concat(damaged.map(l => l.bytes)), stored.quarantineRollback ??= {})
      for (const l of damaged) {
        const raw = l.raw
        const seq = raw?.seq
        if (raw?.kind === 'sent' && integer(seq) && accepted.has(seq)) {
          const item = materialize(j).find(i => i.accepted.seq === seq)!
          const attempt = positive(raw.attempt) && !item.records.some(r => r.kind === 'sent' && r.attempt === raw.attempt) ? raw.attempt : item.nextAttempt
          update(j, { v: 1, kind: 'sent', seq, attempt, unknown_outcome: true, at: item.accepted.received_at, quarantine: { path: quarantinePath, line: l.line } })
        }
        event({ type: 'record-unreadable', key, line: l.line, quarantinePath, alert: l.line !== lines.length && !(integer(seq) && accepted.has(seq)) && (raw?.kind === 'accepted' || !['fixed', 'sent', 'delivered', 'refused', 'noticed'].includes(String(raw?.kind))) })
      }
    }
    stored.records = j.records; stored.nextSeq = j.nextSeq; stored.lastInjected = j.lastInjected; stored.loaded = true
  }
  function rewrite(key: string, records: QueueRecord[]): void {
    const path = pathFor(key), temp = `${path}.${randomUUID()}.tmp`
    ensureDir()
    try {
      const fd = fs.openSync(temp, 'wx', QUEUE_FILE_MODE)
      try { writeAll(fd, Buffer.from(records.map(r => JSON.stringify(r) + '\n').join(''))); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(temp, path); syncDir(dir)
    } finally { try { fs.unlinkSync(temp) } catch { /* rename consumed temp */ } }
  }
  function compactOne(key: string): void {
    load(key)
    const j = journal(key)
    if (j.pendingRollback !== undefined) {
      const fd = fs.openSync(pathFor(key), 'r+')
      try { fs.ftruncateSync(fd, j.pendingRollback); fs.fsyncSync(fd); delete j.pendingRollback } finally { fs.closeSync(fd) }
    }
    const at = now(), retained: QueueRecord[] = []
    for (const r of j.records) if (r.kind === 'accepted' && 'compact' in r && r.compact === 'key' && at - r.received_at < QUEUE_KEY_KEEP_MS) retained.push(r)
    for (const item of materialize(j)) {
      if (item.delivered) {
        if (item.accepted.key && at - item.accepted.received_at < QUEUE_KEY_KEEP_MS) retained.push({ v: 1, kind: 'accepted', seq: item.accepted.seq, compact: 'key', key: item.accepted.key, received_at: item.accepted.received_at, delivered_at: Math.max(...item.records.flatMap(r => r.kind === 'delivered' ? [r.at] : [])) })
      } else {
        const refused = new Set(item.records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
        const removable = new Set(item.records.flatMap(r => r.kind === 'sent' && !('unknown_outcome' in r) && refused.has(r.attempt) ? [r.attempt] : []))
        retained.push({ ...item.accepted, attempt_high_watermark: item.nextAttempt - 1 })
        retained.push(...item.records.filter(r => r.kind !== 'accepted' && !((r.kind === 'sent' || r.kind === 'refused') && removable.has(r.attempt))))
      }
    }
    // Preserve both sequence allocation and the injected microsecond watermark forever.
    retained.push({ v: 1, kind: 'accepted', seq: j.nextSeq - 1, compact: 'allocation', ...(j.lastInjected === undefined ? {} : { injected_ts: formatMicros(j.lastInjected) }) })
    rewrite(key, retained)
    j.records = retained
  }
  function lookupSlackKey(key: string, slack: SlackKey): QueueAcceptResult | undefined {
    const j = journal(key)
    const encoded = slackKeyString(slack)
    const r = j.records.find(r => r.kind === 'accepted' && !('compact' in r && r.compact === 'allocation') && 'key' in r && r.key && slackKeyString(r.key) === encoded)
    return r ? structuredClone({ status: 'duplicate' as const, seq: r.seq, item: materialize(j).find(i => i.accepted.seq === r.seq) }) : undefined
  }
  async function compact(key?: string): Promise<void> {
    await Promise.all((key ? [key] : [...journals.keys()]).map(k => serial(k, () => { try { compactOne(k) } catch (error) { event({ type: 'compaction-failed', key: k, error }); throw error } })))
  }
  const api: DeliveryQueue = {
    async start() {
      if (started) return
      ensureDir()
      const keys = fs.readdirSync(dir).filter(p => p.endsWith('.jsonl')).map(p => p.slice(0, -6))
      for (const key of keys) { try { await serial(key, () => { load(key); compactOne(key) }) } catch { /* inaccessible queues refuse acceptance; other personas still recover */ } }
      started = true
    },
    async accept(key, input) {
      try {
        if (!started || stopped) throw new Error('Queue is not accepting')
        input = structuredClone(input)
        return await serial(key, () => {
          load(key); const j = journal(key)
          if (input.source === 'slack' && input.key) { const existing = lookupSlackKey(key, input.key); if (existing) return existing }
          const received_at = input.received_at ?? now()
          const candidate = BigInt(Math.trunc(received_at * 1000))
          const injected = j.lastInjected === undefined || candidate > j.lastInjected ? candidate : j.lastInjected + 1n
          const record: AcceptedRecord = { ...input, v: 1, kind: 'accepted', seq: j.nextSeq, received_at, ts: input.source === 'slack' ? input.ts ?? input.key?.ts ?? '' : formatMicros(injected) }
          if (!isQueueRecord(record)) throw new Error('Invalid accepted record')
          durableAppend(pathFor(key), Buffer.from(JSON.stringify(record) + '\n'), j)
          update(j, record)
          event({ type: 'stored', key })
          return { status: 'accepted' as const, seq: record.seq, item: structuredClone(materialize(j).find(i => i.accepted.seq === record.seq)!) }
        })
      } catch (error) { event({ type: 'store-failed', key, path: PERSONA_KEY_RE.test(key) ? pathFor(key) : undefined, source: input.source, sender: input.sender, user: input.user, bot_id: input.bot_id, channel: input.channel, ts: input.ts ?? input.key?.ts, error }); return { status: 'failed', error } }
    },
    async append(key, record) {
      try {
        if (!started || stopped) throw new Error('Queue is not writable')
        record = structuredClone(record)
        await serial(key, () => {
          load(key); const j = journal(key)
          if (!isQueueRecord(record) || record.kind === 'accepted') throw new Error('Invalid append record')
          const item = materialize(j).find(i => i.accepted.seq === record.seq)
          if (!item) throw new Error('Append has no accepted item')
          // Immutable fixation and stable attempt identifiers allow safe retry after failures.
          if (record.kind === 'fixed' && item.fixed) {
            if (JSON.stringify(item.fixed) !== JSON.stringify(record)) throw new Error('Fixed text is immutable')
            return
          }
          if (record.kind === 'sent' && record.attempt < item.nextAttempt) throw new Error('Attempt number must increase')
          if (record.kind === 'refused') {
            const attempt = record.attempt
            if (!item.records.some(r => r.kind === 'sent' && !('unknown_outcome' in r) && r.attempt === attempt)) throw new Error('Refusal has no sent attempt')
          }
          if (record.kind === 'delivered' && (!item.fixed || record.part > item.fixed.parts.length)) throw new Error('Receipt has no fixed part')
          durableAppend(pathFor(key), Buffer.from(JSON.stringify(record) + '\n'), j); update(j, record)
        })
        if (appendBlocked.delete(key)) event({ type: 'writable', key })
      } catch (error) { appendBlocked.add(key); event({ type: 'append-failed', key, path: pathFor(key), seq: record.seq, error }); throw error }
    },
    lookupSlackKey,
    item(key, seq) {
      const item = materialize(journal(key)).find(item => item.accepted.seq === seq)
      return item ? structuredClone(item) : undefined
    },
    items: key => materialize(journal(key)).map(item => structuredClone(item)),
    openCount: key => materialize(journal(key)).filter(item => !item.delivered).length,
    isWritable: key => !appendBlocked.has(key),
    keys: () => [...journals.keys()],
    compact,
    startMaintenance() {
      if (timer !== undefined || stopped) return
      timer = (options.setInterval ?? globalThis.setInterval)(() => { void compact().catch(() => {}) }, QUEUE_COMPACT_INTERVAL_MS)
      timer.unref?.()
    },
    async stop() {
      stopped = true
      if (timer !== undefined) (options.clearInterval ?? globalThis.clearInterval)(timer)
      timer = undefined
      await Promise.allSettled([...writers.values()])
    },
    startupFindings: () => findings.map(e => ({ ...e })),
    retained(key) { event({ type: 'retained', key, count: api.openCount(key) }) },
  }
  return api
}
