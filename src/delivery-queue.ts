/** Durable per-persona FIFO journals. No import-time I/O (b.omv SR-3). */
import type { GetResult } from 'agent-director'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PERSONA_KEY_RE } from './persona-identity.ts'

export const QUEUE_KEY_KEEP_MS = 24 * 60 * 60 * 1000
export const REPLY_REMINDER_KEEP_MS = 24 * 60 * 60 * 1000
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
  /** Internal link for an injected reply reminder; never accepted from Slack intake. */
  reminder_for?: number
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
export interface ReplyReminderRecord extends BaseRecord {
  kind: 'reply-reminder'; at: number
  /** Fixed eligibility origin; repeated AD observations must not extend retention. */
  delivered_at?: number
  state: 'observed' | 'replied' | 'nudged' | 'cancelled'
  row_state?: string; session_id?: string; launch_started_at?: string | null
  /** A pre-receipt reply covers only these attempts, while they remain unrefused. */
  reply_attempts?: number[]
  /** Non-content send facts retained when compaction removes the delivered item. */
  delivery_attempts?: number[]
}
export interface ReplyCallTarget { seq: number; attempts?: number[] }
export interface NoticedRecord extends BaseRecord { kind: 'noticed'; at: number }
export type QueueRecord = AcceptedRecord | QueueKeyRecord | QueueAllocationRecord | FixedRecord | SentRecord | UnknownSentRecord | DeliveredRecord | RefusedRecord | NoticedRecord | ReplyReminderRecord
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
export type ReplyReminderRow = Pick<GetResult, 'state' | 'session_id' | 'launch_started_at'>
/** Server-owned journal operations; ordinary delivery adapters need only DeliveryQueue. */
export interface ReplyReminderQueue extends DeliveryQueue {
  replyReminderItems(key: string): ReplyReminderRecord[]
  replyCallTargets(key: string): ReplyCallTarget[]
  recordReplyCall(key: string, targets: readonly ReplyCallTarget[]): Promise<void>
  observeReplyReminders(key: string, row: ReplyReminderRow, text: string, enabled: boolean, current: () => boolean): Promise<QueueItem[]>
  cancelReplyReminders(key: string): Promise<void>
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
      if (r.reminder_for !== undefined && (!positive(r.reminder_for) || r.source !== 'interject')) return false
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
    case 'reply-reminder': return number(r.at) && (r.delivered_at === undefined || number(r.delivered_at)) && ['observed', 'replied', 'nudged', 'cancelled'].includes(String(r.state)) && (r.row_state === undefined || str(r.row_state)) && (r.session_id === undefined || str(r.session_id)) && (r.launch_started_at === undefined || r.launch_started_at === null || str(r.launch_started_at)) && (r.reply_attempts === undefined || (r.state === 'replied' && Array.isArray(r.reply_attempts) && r.reply_attempts.length > 0 && r.reply_attempts.every(positive))) && (r.delivery_attempts === undefined || (Array.isArray(r.delivery_attempts) && r.delivery_attempts.length > 0 && r.delivery_attempts.every(positive)))
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
interface Journal extends AppendRollback {
  records: QueueRecord[]; nextSeq: number; lastInjected?: bigint; loaded: boolean; quarantineRollback?: AppendRollback
  reminders: Map<number, ReplyReminderRecord>; items: Map<number, QueueItem>; slackKeys: Map<string, AcceptedRecord | QueueKeyRecord>; openCount: number
}
function emptyJournal(): Journal { return { records: [], nextSeq: 1, loaded: false, reminders: new Map(), items: new Map(), slackKeys: new Map(), openCount: 0 } }
/** All file access is explicit; construction allocates only memory (SR-13.1). */
export function createDeliveryQueue(options: DeliveryQueueOptions): ReplyReminderQueue {
  const fs = options.fs ?? nodeFs
  const now = options.now ?? Date.now
  const dir = join(options.stateDir, 'queue')
  const journals = new Map<string, Journal>()
  const writers = new Map<string, Promise<unknown>>()
  const appendBlocked = new Set<string>()
  const startId = `${new Date(now()).toISOString().replace(/[:]/g, '-')}-${randomUUID()}`
  let started = false, stopped = false
  let durableDirectory: { dev: number; ino: number } | undefined
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
    if (!j) { j = emptyJournal(); journals.set(key, j) }
    return j
  }
  function serial<T>(key: string, work: () => T | Promise<T>): Promise<T> {
    const next = (writers.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    writers.set(key, next)
    return next
  }
  function syncDir(path: string): void { const fd = fs.openSync(path, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
  function ensureDir(): void {
    // A recreated directory may reuse the cached device/inode identity.
    if (fs.mkdirSync(dir, { recursive: true, mode: QUEUE_DIRECTORY_MODE }) !== undefined) durableDirectory = undefined
    const stat = fs.statSync(dir)
    if (durableDirectory?.dev === stat.dev && durableDirectory.ino === stat.ino && (stat.mode & 0o7777) === QUEUE_DIRECTORY_MODE) return
    durableDirectory = undefined
    fs.chmodSync(dir, QUEUE_DIRECTORY_MODE)
    // Persist a new/replaced queue directory before any acceptance (SR-3.3).
    // Publish this identity only after success; a failed sync remains retryable.
    syncDir(options.stateDir)
    durableDirectory = { dev: stat.dev, ino: stat.ino }
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
  function update(j: Journal, record: QueueRecord, replay = false): void {
    j.records.push(record); j.nextSeq = Math.max(j.nextSeq, record.seq + 1)
    if (!replay) indexRecord(j, record)
    if (record.kind === 'accepted') {
      const ts = 'compact' in record ? record.compact === 'allocation' ? record.injected_ts : undefined : record.source !== 'slack' ? record.ts : undefined
      if (ts) j.lastInjected = j.lastInjected !== undefined && j.lastInjected > microseconds(ts) ? j.lastInjected : microseconds(ts)
    }
  }
  /** Derive only the changed item; public snapshots never expose these records. */
  function summarize(accepted: AcceptedRecord, records: ItemRecord[]): QueueItem {
    const item: QueueItem = { accepted, records, delivered: false, unknownSend: false, retypeCount: 0, nextAttempt: (accepted.attempt_high_watermark ?? 0) + 1 }
    for (const r of records) if (r.kind === 'fixed') item.fixed ??= r
    const refused = new Set(records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
    for (const r of records) if (r.kind === 'refused') item.nextAttempt = Math.max(item.nextAttempt, r.attempt + 1)
    for (const r of records) if (r.kind === 'sent') {
      item.nextAttempt = Math.max(item.nextAttempt, r.attempt + 1)
      if ('unknown_outcome' in r) item.unknownSend = true
      else if (r.send_kind === 'retype' && !refused.has(r.attempt)) item.retypeCount++
    }
    if (item.fixed) item.delivered = item.fixed.parts.every((_, i) => records.some(r => r.kind === 'delivered' && r.part === i + 1))
    return item
  }
  function indexRecord(j: Journal, record: QueueRecord): void {
    if (record.kind === 'reply-reminder') { j.reminders.set(record.seq, record); return }
    if (record.kind === 'accepted') {
      if ('key' in record && record.key) {
        const encoded = slackKeyString(record.key)
        if (!j.slackKeys.has(encoded)) j.slackKeys.set(encoded, record)
      }
      if (isAccepted(record) && !j.items.has(record.seq)) { j.items.set(record.seq, summarize(record, [record])); j.openCount++ }
      return
    }
    const previous = j.items.get(record.seq)
    if (!previous) return
    const item = summarize(previous.accepted, [...previous.records, record])
    j.items.set(record.seq, item)
    ensureReminder(j, item)
    j.openCount += Number(previous.delivered) - Number(item.delivered)
  }
  function rebuild(j: Journal): void {
    j.items = new Map(); j.slackKeys = new Map(); j.reminders = new Map(); j.openCount = 0
    // Replay groups records once, rather than repeatedly copying a long
    // history of retypes for the same item.
    for (const record of j.records) {
      if (record.kind === 'accepted' || record.kind === 'reply-reminder') indexRecord(j, record)
      else j.items.get(record.seq)?.records.push(record)
    }
    for (const [seq, previous] of j.items) {
      const item = summarize(previous.accepted, previous.records)
      j.items.set(seq, item)
      ensureReminder(j, item)
      if (item.delivered) j.openCount--
    }
  }
  function materialize(j: Journal): QueueItem[] {
    return [...j.items.values()].sort((a, b) => a.accepted.seq - b.accepted.seq)
  }
  function load(key: string): void {
    const stored = journal(key)
    if (stored.loaded) return
    // Publish only a complete replay: a failed read or quarantine append must
    // remain retryable without exposing partial rows or dedupe facts.
    const j = emptyJournal()
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
      const orphan = r && r.kind !== 'accepted' && r.kind !== 'reply-reminder' && !accepted.has(r.seq)
      const duplicate = r && isAccepted(r) && seenAccept.has(r.seq)
      if (!r || orphan || duplicate) { damaged.push(l); continue }
      if (isAccepted(r)) seenAccept.add(r.seq)
      update(j, r, true)
    }
    // Put accepted records first for recovery of valid out-of-order journal rows.
    j.records.sort((a, b) => a.seq - b.seq || (isAccepted(a) ? -1 : isAccepted(b) ? 1 : 0))
    rebuild(j)
    if (damaged.length) {
      // Exact original bytes, including torn tails, preserved before rewriting the source.
      durableAppend(quarantinePath, Buffer.concat(damaged.map(l => l.bytes)), stored.quarantineRollback ??= {})
      for (const l of damaged) {
        const raw = l.raw
        const seq = raw?.seq
        if (raw?.kind === 'sent' && integer(seq) && accepted.has(seq)) {
          const item = j.items.get(seq)!
          const attempt = positive(raw.attempt) && !item.records.some(r => r.kind === 'sent' && r.attempt === raw.attempt) ? raw.attempt : item.nextAttempt
          update(j, { v: 1, kind: 'sent', seq, attempt, unknown_outcome: true, at: item.accepted.received_at, quarantine: { path: quarantinePath, line: l.line } })
        }
        event({ type: 'record-unreadable', key, line: l.line, quarantinePath, alert: l.line !== lines.length && !(integer(seq) && accepted.has(seq)) && (raw?.kind === 'accepted' || !['fixed', 'sent', 'delivered', 'refused', 'noticed'].includes(String(raw?.kind))) })
      }
    }
    stored.records = j.records; stored.nextSeq = j.nextSeq; stored.lastInjected = j.lastInjected; stored.items = j.items; stored.reminders = j.reminders; stored.slackKeys = j.slackKeys; stored.openCount = j.openCount; stored.loaded = true
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
  function lastSend(item: QueueItem): SentRecord | undefined {
    const refused = new Set(item.records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
    for (let i = item.records.length - 1; i >= 0; i--) {
      const record = item.records[i]!
      if (record.kind === 'sent' && !('unknown_outcome' in record) && !refused.has(record.attempt)) return record
    }
    return undefined
  }
  function unrefusedAttempts(item: QueueItem): number[] {
    const refused = new Set(item.records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
    return item.records.flatMap(r => r.kind === 'sent' && !refused.has(r.attempt) ? [r.attempt] : [])
  }
  function reminderResolved(j: Journal, item: QueueItem): boolean {
    const record = j.reminders.get(item.accepted.seq)
    if (!record) return false
    if (record.state !== 'replied' || record.reply_attempts === undefined) return true
    const attempts = unrefusedAttempts(item)
    return record.reply_attempts.some(attempt => attempts.includes(attempt))
  }
  /** Derive missing initial facts from CSCB's delivery records, including a torn append. */
  function ensureReminder(j: Journal, item: QueueItem): void {
    if (!item.delivered || item.accepted.source !== 'slack' || reminderResolved(j, item)) return
    const sent = lastSend(item)
    if (!sent) return
    const delivered_at = Math.max(...item.records.flatMap(r => r.kind === 'delivered' ? [r.at] : []))
    j.reminders.set(item.accepted.seq, { v: 1, kind: 'reply-reminder', seq: item.accepted.seq, at: delivered_at, delivered_at, state: 'observed', session_id: sent.session_id, delivery_attempts: unrefusedAttempts(item) })
  }
  function reminderExpired(record: ReplyReminderRecord, at = now()): boolean {
    // Older journals have only their last observation timestamp. Freeze that
    // fallback on the next observation instead of refreshing it indefinitely.
    return at - (record.delivered_at ?? record.at) >= REPLY_REMINDER_KEEP_MS
  }
  function replyCandidates(j: Journal): ReplyReminderRecord[] {
    return [...j.reminders.values()].filter(record => record.state === 'observed' && !reminderExpired(record))
  }
  function replySequences(j: Journal): number[] {
    return replyTargets(j).map(target => target.seq)
  }
  function replyTargets(j: Journal): ReplyCallTarget[] {
    const targets = new Map(replyCandidates(j).map(record => [record.seq, { seq: record.seq } as ReplyCallTarget]))
    for (const item of materialize(j)) {
      if (item.accepted.source !== 'slack') continue
      const attempts = unrefusedAttempts(item)
      const previous = j.reminders.get(item.accepted.seq)
      if (attempts.length && (!previous || previous.state === 'replied')) {
        targets.set(item.accepted.seq, { seq: item.accepted.seq, ...(item.delivered ? {} : { attempts }) })
      }
    }
    return [...targets.values()]
  }
  function compactOne(key: string): void {
    load(key)
    const j = journal(key)
    if (j.pendingRollback !== undefined) {
      const fd = fs.openSync(pathFor(key), 'r+')
      try { fs.ftruncateSync(fd, j.pendingRollback); fs.fsyncSync(fd); delete j.pendingRollback } finally { fs.closeSync(fd) }
    }
    const at = now(), retained: QueueRecord[] = []
    const queuedReminders = new Set(materialize(j).flatMap(item => item.accepted.reminder_for === undefined ? [] : [item.accepted.reminder_for]))
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
    // Pending reminder facts contain no delivered body, fixed text, or receipt
    // path. A terminal fact for an unfinished item prevents re-arming when
    // its delivery is confirmed later. Completed and expired facts disappear;
    // expiry never discards an accepted delivery or its suppression facts.
    for (const record of j.reminders.values()) {
      if (queuedReminders.has(record.seq)) continue
      if ((record.state === 'observed' && !reminderExpired(record, at)) || (j.items.has(record.seq) && !j.items.get(record.seq)!.delivered)) retained.push(record)
    }
    // Preserve both sequence allocation and the injected microsecond watermark forever.
    retained.push({ v: 1, kind: 'accepted', seq: j.nextSeq - 1, compact: 'allocation', ...(j.lastInjected === undefined ? {} : { injected_ts: formatMicros(j.lastInjected) }) })
    rewrite(key, retained)
    j.records = retained
    rebuild(j)
  }
  function lookupSlackKey(key: string, slack: SlackKey): QueueAcceptResult | undefined {
    const j = journal(key)
    const encoded = slackKeyString(slack)
    const r = j.slackKeys.get(encoded)
    return r ? structuredClone({ status: 'duplicate' as const, seq: r.seq, item: j.items.get(r.seq) }) : undefined
  }
  async function compact(key?: string): Promise<void> {
    await Promise.all((key ? [key] : [...journals.keys()]).map(k => serial(k, () => { try { compactOne(k) } catch (error) { event({ type: 'compaction-failed', key: k, error }); throw error } })))
  }
  /** One append/fsync boundary for reminder facts and their injected delivery. */
  function appendReminderRecords(key: string, records: QueueRecord[]): void {
    if (!started || stopped) throw new Error('Queue is not writable')
    if (!records.length) return
    const j = journal(key)
    durableAppend(pathFor(key), Buffer.from(records.map(r => JSON.stringify(r) + '\n').join('')), j)
    for (const r of records) update(j, r)
  }
  const api: ReplyReminderQueue = {
    replyReminderItems: key => replyCandidates(journal(key)).map(record => structuredClone(record)),
    replyCallTargets: key => replyTargets(journal(key)),
    async recordReplyCall(key, targets) {
      targets = structuredClone(targets)
      await serial(key, () => {
        load(key)
        const j = journal(key), records: ReplyReminderRecord[] = []
        for (const target of targets) {
          const previous = j.reminders.get(target.seq)
          if (previous?.state === 'nudged' || previous?.state === 'cancelled') continue
          let attempts = target.attempts
          if (attempts !== undefined) {
            const item = j.items.get(target.seq)
            const unrefused = item ? unrefusedAttempts(item) : previous?.delivery_attempts ?? []
            attempts = attempts.filter(attempt => unrefused.includes(attempt))
            if (!attempts.length) continue
            // Concurrent replies can settle in either order; retain the union
            // of their exact attempts rather than suppressing a later retry.
            if (previous?.state === 'replied') {
              if (previous.reply_attempts === undefined) continue
              attempts = [...new Set([...previous.reply_attempts, ...attempts])]
            }
          }
          records.push({ v: 1, kind: 'reply-reminder', seq: target.seq, at: now(), state: 'replied', ...(attempts === undefined ? {} : { reply_attempts: attempts }) })
        }
        appendReminderRecords(key, records)
      })
    },
    async cancelReplyReminders(key) {
      await serial(key, () => {
        load(key)
        appendReminderRecords(key, replySequences(journal(key)).map(seq => ({ v: 1, kind: 'reply-reminder', seq, at: now(), state: 'cancelled' })))
      })
    },
    async observeReplyReminders(key, row, text, enabled, current) {
      return serial(key, () => {
        load(key)
        if (!current()) return []
        const j = journal(key), records: QueueRecord[] = [], injected: number[] = []
        let seq = j.nextSeq
        let injectedAt = j.lastInjected
        const items = materialize(j)
        for (const previous of replyCandidates(j)) {
          const originalSeq = previous.seq
          const alreadyQueued = items.some(other => other.accepted.reminder_for === originalSeq)
          const sameLife = previous.session_id === row.session_id && (previous.row_state === undefined || previous.launch_started_at === row.launch_started_at)
          const cancelled = !enabled || !sameLife || ['pending', 'ended', 'missing', 'error'].includes(row.state)
          const nudge = !cancelled && previous.row_state === 'working' && row.state === 'waiting'
          if (!alreadyQueued && !cancelled && !nudge && previous.row_state === row.state && sameLife) continue
          if (nudge && !alreadyQueued) {
            const at = now(), candidate = BigInt(Math.trunc(at * 1000))
            injectedAt = injectedAt === undefined || candidate > injectedAt ? candidate : injectedAt + 1n
            // Acceptance precedes resolution: a torn append can replay it and
            // recover the missing resolution without accepting a duplicate.
            const accepted: AcceptedRecord = { v: 1, kind: 'accepted', seq: seq++, source: 'interject', sender: 'reply-reminder', text, received_at: at, ts: formatMicros(injectedAt), reminder_for: originalSeq }
            records.push(accepted); injected.push(accepted.seq)
          }
          records.push({ v: 1, kind: 'reply-reminder', seq: originalSeq, at: now(), delivered_at: previous.delivered_at ?? previous.at, state: cancelled ? 'cancelled' : alreadyQueued || nudge ? 'nudged' : 'observed', row_state: row.state, session_id: row.session_id, launch_started_at: row.launch_started_at, ...(previous.delivery_attempts === undefined ? {} : { delivery_attempts: previous.delivery_attempts }) })
        }
        appendReminderRecords(key, records)
        return injected.map(seq => structuredClone(j.items.get(seq)!))
      })
    },
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
          return { status: 'accepted' as const, seq: record.seq, item: structuredClone(j.items.get(record.seq)!) }
        })
      } catch (error) { event({ type: 'store-failed', key, path: PERSONA_KEY_RE.test(key) ? pathFor(key) : undefined, source: input.source, sender: input.sender, user: input.user, bot_id: input.bot_id, channel: input.channel, ts: input.ts ?? input.key?.ts, error }); return { status: 'failed', error } }
    },
    async append(key, record) {
      try {
        if (!started || stopped) throw new Error('Queue is not writable')
        record = structuredClone(record)
        await serial(key, () => {
          load(key); const j = journal(key)
          if (!isQueueRecord(record) || record.kind === 'accepted' || record.kind === 'reply-reminder') throw new Error('Invalid append record')
          const item = j.items.get(record.seq)
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
          const records: QueueRecord[] = [record]
          if (record.kind === 'delivered') {
            const deliveredItem = summarize(item.accepted, [...item.records, record])
            const sent = lastSend(deliveredItem)
            if (deliveredItem.delivered && item.accepted.source === 'slack' && sent && !reminderResolved(j, deliveredItem)) records.push({ v: 1, kind: 'reply-reminder', seq: record.seq, at: record.at, state: 'observed', session_id: sent.session_id, delivery_attempts: unrefusedAttempts(deliveredItem) })
          }
          durableAppend(pathFor(key), Buffer.from(records.map(r => JSON.stringify(r) + '\n').join('')), j)
          for (const next of records) update(j, next)
        })
        if (appendBlocked.delete(key)) event({ type: 'writable', key })
      } catch (error) { appendBlocked.add(key); event({ type: 'append-failed', key, path: pathFor(key), seq: record.seq, error }); throw error }
    },
    lookupSlackKey,
    item(key, seq) {
      const item = journal(key).items.get(seq)
      return item ? structuredClone(item) : undefined
    },
    items: key => materialize(journal(key)).map(item => structuredClone(item)),
    openCount: key => journal(key).openCount,
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
