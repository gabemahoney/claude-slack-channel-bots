/** Durable per-persona FIFO journals. No import-time I/O. */
import type { GetResult } from 'agent-director'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PERSONA_KEY_RE } from './persona-identity.ts'
import { createDurableJournal, splitJournalLines, type AppendRollback } from './durable-journal.ts'
import type { ChannelStamp } from './shared-channels.ts'

export const QUEUE_KEY_KEEP_MS = 24 * 60 * 60 * 1000
export const REPLY_REMINDER_KEEP_MS = 24 * 60 * 60 * 1000
export const QUEUE_COMPACT_INTERVAL_MS = 60 * 60 * 1000
export const QUEUE_DIRECTORY_MODE = 0o700
export const QUEUE_FILE_MODE = 0o600
export type DeliverySource = 'slack' | 'interject' | 'cron'
export interface SlackKey { chat_id: string; ts: string; edited_ts?: string }
export interface QueueFile { name: string; mimetype?: string; size?: number }
export interface QueueThreadJoin { thread_ts: string; stamp: ChannelStamp; at: number }
export interface MemoryHoldField { on: 'memory'; thread_ts: string; stamp: ChannelStamp; arrived_at: number }
/** Waits on the named Pending Own Posts; root_unknown records the view at arrival. */
export interface PostHoldField {
  on: 'post'; operations: readonly string[]; thread_ts: string; stamp: ChannelStamp; root_unknown: boolean; arrived_at: number
}
export type HoldField = MemoryHoldField | PostHoldField
export type HoldKind = HoldField['on']
export type HoldOutcome = 'released' | 'withdrawn' | 'parked'
export interface HoldResolution { seq: number; outcome: HoldOutcome; at: number }
/** A parked Post Hold is listed in the Memory Hold form. */
export type UnresolvedHold = HoldField & { seq: number; channel: string; memoryDependent: boolean }
/** kind is the effective kind: a parked Post Hold is a Memory Hold. */
export interface HoldSummary { field: HoldField; kind: HoldKind; state: 'unresolved' | 'released' | 'withdrawn'; at?: number }
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
  /** Original queued emoji, retained with open work across configuration changes. */
  queued_ack_reaction?: string
  /** Join saved by this acceptance until Thread Memory saves its own copy. */
  thread_join?: QueueThreadJoin
  hold?: HoldField
  /** Opening time retained when compaction removes a released hold's field. */
  released_at?: number
}
interface BaseRecord { v: 1; seq: number }
export interface AcceptedRecord extends BaseRecord, AcceptedInput {
  kind: 'accepted'; received_at: number; ts: string; attempt_high_watermark?: number
}
/** Compaction keeps dedupe facts without message content. */
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
  at: number; session_id: string; transcript_path: string; transcript_size: number
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
export interface HoldResolutionRecord extends BaseRecord { kind: HoldOutcome; at: number }
export type QueueRecord = AcceptedRecord | QueueKeyRecord | QueueAllocationRecord | FixedRecord | SentRecord | UnknownSentRecord | DeliveredRecord | RefusedRecord | NoticedRecord | ReplyReminderRecord | HoldResolutionRecord
export type ItemRecord = AcceptedRecord | FixedRecord | SentRecord | UnknownSentRecord | DeliveredRecord | RefusedRecord | NoticedRecord | HoldResolutionRecord
export interface QueueItem {
  accepted: AcceptedRecord; fixed?: FixedRecord; records: ItemRecord[]; delivered: boolean
  unknownSend: boolean; retypeCount: number; nextAttempt: number
  hold?: HoldSummary
}
export function isOpenItem(item: QueueItem): boolean { return !item.delivered && (!item.hold || item.hold.state === 'released') }
export function itemOpenedAt(item: QueueItem): number { return (item.hold?.state === 'released' ? item.hold.at : undefined) ?? item.accepted.released_at ?? item.accepted.received_at }
export type QueueEvent =
  | { type: 'holds-resolved'; key: string; resolutions: HoldResolution[] }
  | { type: 'store-failed'; key: string; path?: string; source?: DeliverySource; sender?: string; user?: string; bot_id?: string; channel?: string; ts?: string; error: unknown }
  | { type: 'stored' | 'writable'; key: string }
  | { type: 'append-failed' | 'recovery-failed' | 'compaction-failed'; key: string; path?: string; seq?: number; error: unknown }
  | { type: 'record-unreadable'; key: string; line: number; quarantinePath: string; alert: boolean }
  | { type: 'retained'; key: string; count: number }
export type QueueAcceptResult = { status: 'accepted' | 'duplicate'; item?: QueueItem; seq: number } | { status: 'failed'; error: unknown }
export type QueueAccept = (key: string, input: AcceptedInput) => Promise<QueueAcceptResult>
export type QueueAcceptDecision<T> = { store: AcceptedInput; afterStore?: () => void } | { skip: T }
export type QueueDecidedResult<T> = QueueAcceptResult | { status: 'skipped'; outcome: T }
export interface DeliveryQueue {
  start(): Promise<void>
  accept: QueueAccept
  /** Decide after the durable key check in the persona's writer turn. Both
   * callbacks must be synchronous: no I/O, network, log or shared-state write. */
  acceptDecided<T>(key: string, slackKey: SlackKey | undefined, decide: (facts: { keyChecked: boolean }) => QueueAcceptDecision<T>): Promise<QueueDecidedResult<T>>
  append(key: string, record: QueueRecord): Promise<void>
  /** Adopt pre-two-stage accepted work before its first queued Slack mutation. */
  rememberQueuedReaction(key: string, seq: number, name: string): Promise<string | undefined>
  lookupSlackKey(key: string, slackKey: SlackKey): QueueAcceptResult | undefined
  /** A current snapshot of one item, without cloning the rest of the queue. */
  item(key: string, seq: number): QueueItem | undefined
  items(key: string): QueueItem[]
  openCount(key: string): number
  /** Includes decisions whose store is in progress, for stale-join retention. */
  unresolvedHolds(key: string): UnresolvedHold[]
  /** Returns only resolutions newly saved by this call, in input order.
   * onCommitted observes that batch synchronously after publication, before
   * other observers or the caller's continuation can cancel its reporting.
   * It is not awaited, and its errors cannot change the durable result. */
  resolveHolds(key: string, resolutions: readonly HoldResolution[], current?: () => boolean,
    onCommitted?: (saved: readonly HoldResolution[]) => void): Promise<HoldResolution[]>
  /** A failed post-accept append suspends all keys until an append succeeds. */
  isWritable?(key: string): boolean
  keys(): string[]
  compact(key?: string, current?: () => boolean): Promise<void>
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
  /** Synchronous confirmation that compaction may discard the queue's join copy. */
  threadJoinSaved?(key: string, channel: string, threadJoin: QueueThreadJoin): boolean
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
function isQueueThreadJoin(v: unknown): v is QueueThreadJoin {
  return object(v) && timestamp(v.thread_ts) && number(v.at) &&
    Object.keys(v).every(k => ['thread_ts', 'stamp', 'at'].includes(k)) &&
    object(v.stamp) && str(v.stamp.incarnation) && v.stamp.incarnation !== '' &&
    str(v.stamp.threadHybridSince) && v.stamp.threadHybridSince !== '' &&
    Object.keys(v.stamp).every(k => ['incarnation', 'threadHybridSince'].includes(k))
}
function isHoldField(v: unknown): v is HoldField {
  if (!object(v) || !number(v.arrived_at) || !isQueueThreadJoin({ thread_ts: v.thread_ts, stamp: v.stamp, at: v.arrived_at })) return false
  if (v.on === 'memory') return Object.keys(v).every(k => ['on', 'thread_ts', 'stamp', 'arrived_at'].includes(k))
  return v.on === 'post' && typeof v.root_unknown === 'boolean' && Array.isArray(v.operations) && v.operations.length > 0 &&
    v.operations.every(o => str(o) && o !== '') && new Set(v.operations).size === v.operations.length &&
    Object.keys(v).every(k => ['on', 'operations', 'thread_ts', 'stamp', 'root_unknown', 'arrived_at'].includes(k))
}
function memoryForm(field: HoldField): MemoryHoldField {
  return { on: 'memory', thread_ts: field.thread_ts, stamp: field.stamp, arrived_at: field.arrived_at }
}
function unresolvedEntry(field: HoldField, kind: HoldKind, seq: number, channel: string): UnresolvedHold {
  if (field.on === 'post' && kind === 'post') return { ...field, seq, channel, memoryDependent: field.root_unknown }
  return { ...memoryForm(field), seq, channel, memoryDependent: true }
}
function isHoldResolution(r: QueueRecord): r is HoldResolutionRecord { return r.kind === 'released' || r.kind === 'withdrawn' || r.kind === 'parked' }
/** Structural on-disk schema. Invalid versions/kinds and partial records are never replayed. */
export function isQueueRecord(value: unknown): value is QueueRecord {
  if (!object(value) || value.v !== 1 || !integer(value.seq)) return false
  const r = value
  // Hold metadata belongs only to full accepted records; compact forms reject it below.
  if (r.kind !== 'accepted' && ('hold' in r || 'released_at' in r)) return false
  switch (r.kind) {
    case 'accepted':
      if (r.compact === 'allocation') return (r.injected_ts === undefined || timestamp(r.injected_ts)) && Object.keys(r).every(k => ['v', 'kind', 'seq', 'compact', 'injected_ts'].includes(k))
      if (r.compact === 'key') return isSlackKey(r.key) && number(r.received_at) && number(r.delivered_at) && Object.keys(r).every(k => ['v', 'kind', 'seq', 'compact', 'key', 'received_at', 'delivered_at'].includes(k))
      if (r.compact !== undefined || !['slack', 'interject', 'cron'].includes(String(r.source)) || !str(r.text) || !str(r.ts) || !number(r.received_at)) return false
      if (r.reminder_for !== undefined && (!positive(r.reminder_for) || r.source !== 'interject')) return false
      if (r.attempt_high_watermark !== undefined && !integer(r.attempt_high_watermark)) return false
      if (r.queued_ack_reaction !== undefined && (!str(r.queued_ack_reaction) || !r.queued_ack_reaction.trim())) return false
      if (r.thread_join !== undefined && (r.source !== 'slack' || !['mention', 'broadcast'].includes(String(r.via)) || !isQueueThreadJoin(r.thread_join))) return false
      if (r.hold !== undefined && (r.source !== 'slack' || r.via !== 'thread' || r.thread_join !== undefined || !isHoldField(r.hold))) return false
      if (r.released_at !== undefined && !number(r.released_at)) return false
      for (const k of ['sender', 'channel', 'channel_type', 'thread_ts', 'edited_ts', 'user', 'bot_id', 'username', 'bot_profile_name', 'via']) if (r[k] !== undefined && !str(r[k])) return false
      if (r.files !== undefined && (!Array.isArray(r.files) || !r.files.every(f => object(f) && str(f.name) && (f.mimetype === undefined || str(f.mimetype)) && (f.size === undefined || number(f.size))))) return false
      return r.source === 'slack' ? isSlackKey(r.key) && str(r.channel) && str(r.via) : timestamp(r.ts) && str(r.sender) && r.key === undefined
    case 'fixed': return Array.isArray(r.parts) && r.parts.length > 0 && r.parts.every(p => str(p) && p !== '')
    case 'sent':
      if (!positive(r.attempt) || !number(r.at)) return false
      if (r.unknown_outcome === true) return object(r.quarantine) && str(r.quarantine.path) && positive(r.quarantine.line)
      return positive(r.part) && ['text', 'enter', 'retype'].includes(String(r.send_kind)) && str(r.session_id) && str(r.transcript_path) && integer(r.transcript_size)
    case 'delivered': return positive(r.part) && number(r.at) && object(r.receipt) && str(r.receipt.path) && (str(r.receipt.uuid) || integer(r.receipt.offset))
    case 'refused': return positive(r.attempt) && number(r.at)
    case 'reply-reminder': return number(r.at) && (r.delivered_at === undefined || number(r.delivered_at)) && ['observed', 'replied', 'nudged', 'cancelled'].includes(String(r.state)) && (r.row_state === undefined || str(r.row_state)) && (r.session_id === undefined || str(r.session_id)) && (r.launch_started_at === undefined || r.launch_started_at === null || str(r.launch_started_at)) && (r.reply_attempts === undefined || (r.state === 'replied' && Array.isArray(r.reply_attempts) && r.reply_attempts.length > 0 && r.reply_attempts.every(positive))) && (r.delivery_attempts === undefined || (Array.isArray(r.delivery_attempts) && r.delivery_attempts.length > 0 && r.delivery_attempts.every(positive)))
    case 'noticed': return number(r.at)
    case 'released': case 'withdrawn': case 'parked':
      return number(r.at) && Object.keys(r).every(k => ['v', 'kind', 'seq', 'at'].includes(k))
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
interface Journal extends AppendRollback {
  records: QueueRecord[]; nextSeq: number; lastInjected?: bigint; loaded: boolean; quarantineRollback?: AppendRollback
  reminders: Map<number, ReplyReminderRecord>; items: Map<number, QueueItem>; slackKeys: Map<string, AcceptedRecord | QueueKeyRecord>; openCount: number
  holds: Map<number, UnresolvedHold>
}
function emptyJournal(): Journal { return { records: [], nextSeq: 1, loaded: false, reminders: new Map(), items: new Map(), slackKeys: new Map(), holds: new Map(), openCount: 0 } }
/** All file access is explicit; construction allocates only memory. */
export function createDeliveryQueue(options: DeliveryQueueOptions): ReplyReminderQueue {
  const fs = options.fs ?? nodeFs
  const now = options.now ?? Date.now
  const dir = join(options.stateDir, 'queue')
  const { ensureDir, durableAppend, reconcileRollback, rewrite } = createDurableJournal({ dir, parentDir: options.stateDir, directoryMode: QUEUE_DIRECTORY_MODE, fileMode: QUEUE_FILE_MODE, fs })
  const journals = new Map<string, Journal>()
  const writers = new Map<string, Promise<unknown>>()
  const appendBlocked = new Set<string>()
  const storingHolds = new Map<string, UnresolvedHold>()
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
    if (!j) { j = emptyJournal(); journals.set(key, j) }
    return j
  }
  function serial<T>(key: string, work: () => T | Promise<T>): Promise<T> {
    const next = (writers.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    writers.set(key, next)
    return next
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
    if (accepted.hold) {
      const field = accepted.hold
      const first = records.findIndex(r => r.kind === 'released' || r.kind === 'withdrawn')
      const resolution = first < 0 ? undefined : records[first] as HoldResolutionRecord
      // Only parking before the first saved resolution, of a Post Hold whose
      // root was unknown at arrival, turns it into a Memory Hold.
      const parked = field.on === 'post' && field.root_unknown && (first < 0 ? records : records.slice(0, first)).some(r => r.kind === 'parked')
      const kind: HoldKind = parked ? 'memory' : field.on
      item.hold = { field, kind, state: 'unresolved' }
      if (resolution) item.hold = { field, kind, state: resolution.kind as 'released' | 'withdrawn', at: resolution.at }
      else if (records.some(r => r.kind === 'fixed' || r.kind === 'sent' || r.kind === 'delivered')) {
        const times = records.flatMap(r => r.kind === 'sent' || r.kind === 'delivered' ? [r.at] : [])
        item.hold = { field, kind, state: 'released', at: times.length ? Math.min(...times) : accepted.received_at }
      }
    }
    return item
  }
  function indexHold(j: Journal, item: QueueItem): void {
    if (item.hold?.state === 'unresolved') j.holds.set(item.accepted.seq, unresolvedEntry(item.hold.field, item.hold.kind, item.accepted.seq, item.accepted.channel!))
    else j.holds.delete(item.accepted.seq)
  }
  function indexRecord(j: Journal, record: QueueRecord): void {
    if (record.kind === 'reply-reminder') { j.reminders.set(record.seq, record); return }
    if (record.kind === 'accepted') {
      if ('key' in record && record.key) {
        const encoded = slackKeyString(record.key)
        if (!j.slackKeys.has(encoded)) j.slackKeys.set(encoded, record)
      }
      if (isAccepted(record) && !j.items.has(record.seq)) {
        const item = summarize(record, [record])
        j.items.set(record.seq, item); indexHold(j, item); j.openCount += Number(isOpenItem(item))
      }
      return
    }
    const previous = j.items.get(record.seq)
    if (!previous) return
    const item = summarize(previous.accepted, [...previous.records, record])
    j.items.set(record.seq, item)
    indexHold(j, item)
    ensureReminder(j, item)
    j.openCount += Number(isOpenItem(item)) - Number(isOpenItem(previous))
  }
  function rebuild(j: Journal): void {
    j.items = new Map(); j.slackKeys = new Map(); j.reminders = new Map(); j.holds = new Map(); j.openCount = 0
    // Replay groups records once, rather than repeatedly copying a long
    // history of retypes for the same item.
    for (const record of j.records) {
      if (record.kind === 'accepted' || record.kind === 'reply-reminder') indexRecord(j, record)
      else j.items.get(record.seq)?.records.push(record)
    }
    for (const [seq, previous] of j.items) {
      const item = summarize(previous.accepted, previous.records)
      j.items.set(seq, item)
      indexHold(j, item)
      ensureReminder(j, item)
      j.openCount += Number(isOpenItem(item)) - Number(isOpenItem(previous))
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
    for (const split of splitJournalLines(bytes)) {
      const { text, whole } = split
      let raw: Record<string, unknown> | undefined
      try { const parsed: unknown = JSON.parse(text); if (object(parsed)) raw = parsed } catch {
        // A torn or syntactically damaged send can still identify its item. Retain
        // conservative unknown-outcome evidence, never the damaged text.
        const kind = /(?:^|[,{])\s*"kind"\s*:\s*"([^"\\]+)"/.exec(text)?.[1]
        const seqText = /(?:^|[,{])\s*"seq"\s*:\s*(\d+)(?=\s*[,}])/.exec(text)?.[1]
        const attemptText = /(?:^|[,{])\s*"attempt"\s*:\s*(\d+)(?=\s*[,}])/.exec(text)?.[1]
        if (kind !== undefined || seqText !== undefined) raw = { kind, seq: seqText === undefined ? undefined : Number(seqText), attempt: attemptText === undefined ? undefined : Number(attemptText) }
      }
      lines.push({ bytes: split.bytes, line: split.line, record: whole ? parseQueueRecord(text) : undefined, raw, whole })
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
        event({ type: 'record-unreadable', key, line: l.line, quarantinePath, alert: l.line !== lines.length && !(integer(seq) && accepted.has(seq)) && (raw?.kind === 'accepted' || !['fixed', 'sent', 'delivered', 'refused', 'noticed', 'released', 'withdrawn', 'parked'].includes(String(raw?.kind))) })
      }
    }
    stored.records = j.records; stored.nextSeq = j.nextSeq; stored.lastInjected = j.lastInjected; stored.items = j.items; stored.reminders = j.reminders; stored.slackKeys = j.slackKeys; stored.openCount = j.openCount; stored.loaded = true
    stored.holds = j.holds
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
    reconcileRollback(pathFor(key), j)
    const at = now(), retained: QueueRecord[] = []
    const retainedJoinItems = new Set<number>()
    const queuedReminders = new Set(materialize(j).flatMap(item => item.accepted.reminder_for === undefined ? [] : [item.accepted.reminder_for]))
    for (const r of j.records) if (r.kind === 'accepted' && 'compact' in r && r.compact === 'key' && at - r.received_at < QUEUE_KEY_KEEP_MS) retained.push(r)
    for (const item of materialize(j)) {
      if (item.hold?.state === 'withdrawn') {
        if (item.accepted.key && at - item.accepted.received_at < QUEUE_KEY_KEEP_MS) retained.push({ v: 1, kind: 'accepted', seq: item.accepted.seq, compact: 'key', key: item.accepted.key, received_at: item.accepted.received_at, delivered_at: item.hold.at! })
      } else if (item.delivered) {
        if (needsThreadJoinCopy(key, item.accepted)) {
          retained.push(...item.records)
          retainedJoinItems.add(item.accepted.seq)
        }
        else if (item.accepted.key && at - item.accepted.received_at < QUEUE_KEY_KEEP_MS) retained.push({ v: 1, kind: 'accepted', seq: item.accepted.seq, compact: 'key', key: item.accepted.key, received_at: item.accepted.received_at, delivered_at: Math.max(...item.records.flatMap(r => r.kind === 'delivered' ? [r.at] : [])) })
      } else {
        const refused = new Set(item.records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
        const removable = new Set(item.records.flatMap(r => r.kind === 'sent' && !('unknown_outcome' in r) && refused.has(r.attempt) ? [r.attempt] : []))
        const accepted = { ...item.accepted, attempt_high_watermark: item.nextAttempt - 1 }
        if (item.hold?.state === 'released') { delete accepted.hold; accepted.via = 'thread'; accepted.released_at = item.hold.at }
        // A parked Post Hold keeps only the Memory Hold form; its parked record goes below.
        else if (item.hold?.kind === 'memory' && item.hold.field.on === 'post') accepted.hold = memoryForm(item.hold.field)
        retained.push(accepted)
        retained.push(...item.records.filter(r => r.kind !== 'accepted' && !isHoldResolution(r) && !((r.kind === 'sent' || r.kind === 'refused') && removable.has(r.attempt))))
      }
    }
    // Pending reminder facts contain no delivered body, fixed text, or receipt
    // path. Suppression must outlive every full item retained for its join:
    // replay could otherwise derive a new candidate from its delivery facts.
    // Unfinished items keep suppression until delivery; other completed and
    // expired facts disappear without discarding accepted delivery work.
    for (const record of j.reminders.values()) {
      if (retainedJoinItems.has(record.seq)) {
        // A torn append can keep the reminder's acceptance but lose its
        // terminal fact. Preserve that evidence even if this compaction
        // removes the delivered reminder itself.
        retained.push(queuedReminders.has(record.seq) && record.state === 'observed' ? { ...record, state: 'nudged' } : record)
        continue
      }
      if (queuedReminders.has(record.seq)) continue
      if ((record.state === 'observed' && !reminderExpired(record, at)) || (j.items.has(record.seq) && isOpenItem(j.items.get(record.seq)!))) retained.push(record)
    }
    // Preserve both sequence allocation and the injected microsecond watermark forever.
    retained.push({ v: 1, kind: 'accepted', seq: j.nextSeq - 1, compact: 'allocation', ...(j.lastInjected === undefined ? {} : { injected_ts: formatMicros(j.lastInjected) }) })
    rewrite(pathFor(key), Buffer.from(retained.map(r => JSON.stringify(r) + '\n').join('')))
    j.records = retained
    rebuild(j)
  }
  function lookupSlackKey(key: string, slack: SlackKey): QueueAcceptResult | undefined {
    const j = journal(key)
    const encoded = slackKeyString(slack)
    const r = j.slackKeys.get(encoded)
    return r ? structuredClone({ status: 'duplicate' as const, seq: r.seq, item: j.items.get(r.seq) }) : undefined
  }
  function needsThreadJoinCopy(key: string, record: AcceptedRecord): boolean {
    return record.thread_join !== undefined && options.threadJoinSaved?.(key, record.channel!, record.thread_join) !== true
  }
  /** Caller owns the loaded journal's serial turn and has checked duplicates. */
  function storeAccepted(key: string, input: AcceptedInput): QueueAcceptResult {
    const j = journal(key), received_at = input.received_at ?? now()
    const candidate = BigInt(Math.trunc(received_at * 1000))
    const injected = j.lastInjected === undefined || candidate > j.lastInjected ? candidate : j.lastInjected + 1n
    const record: AcceptedRecord = { ...input, v: 1, kind: 'accepted', seq: j.nextSeq, received_at, ts: input.source === 'slack' ? input.ts ?? input.key?.ts ?? '' : formatMicros(injected) }
    if (!isQueueRecord(record)) throw new Error('Invalid accepted record')
    if (record.hold) storingHolds.set(key, unresolvedEntry(record.hold, record.hold.on, record.seq, record.channel!))
    try {
      durableAppend(pathFor(key), Buffer.from(JSON.stringify(record) + '\n'), j)
      update(j, record)
    } finally { storingHolds.delete(key) }
    event({ type: 'stored', key })
    return { status: 'accepted', seq: record.seq, item: structuredClone(j.items.get(record.seq)!) }
  }
  function storeFailed(key: string, input: AcceptedInput | undefined, error: unknown): QueueAcceptResult {
    event({ type: 'store-failed', key, path: PERSONA_KEY_RE.test(key) ? pathFor(key) : undefined, source: input?.source, sender: input?.sender, user: input?.user, bot_id: input?.bot_id, channel: input?.channel, ts: input?.ts ?? input?.key?.ts, error })
    return { status: 'failed', error }
  }
  async function compact(key?: string, current = () => true): Promise<void> {
    await Promise.all((key ? [key] : [...journals.keys()]).map(k => serial(k, () => { if (!current()) return; try { compactOne(k) } catch (error) { event({ type: 'compaction-failed', key: k, error }); throw error } })))
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
          load(key)
          if (input.source === 'slack' && input.key) { const existing = lookupSlackKey(key, input.key); if (existing) return existing }
          return storeAccepted(key, input)
        })
      } catch (error) { return storeFailed(key, input, error) }
    },
    async acceptDecided(key, slackKey, decide) {
      let input: AcceptedInput | undefined
      try {
        slackKey = structuredClone(slackKey)
        return await serial(key, () => {
          let keyChecked = false, unavailable: unknown
          try {
            if (!started || stopped) throw new Error('Queue is not accepting')
            load(key)
            const duplicate = slackKey ? lookupSlackKey(key, slackKey) : undefined
            if (duplicate) return duplicate
            keyChecked = true
          } catch (error) { unavailable = error }
          const decision = decide({ keyChecked })
          if ('skip' in decision) return { status: 'skipped' as const, outcome: decision.skip }
          input = structuredClone(decision.store)
          if (!keyChecked) throw unavailable
          const result = storeAccepted(key, input)
          try { decision.afterStore?.() } catch { /* a saved acceptance cannot be undone by its observer */ }
          return result
        })
      } catch (error) { return storeFailed(key, input, error) }
    },
    async append(key, record) {
      try {
        if (!started || stopped) throw new Error('Queue is not writable')
        record = structuredClone(record)
        await serial(key, () => {
          load(key); const j = journal(key)
          if (!isQueueRecord(record) || record.kind === 'accepted' || record.kind === 'reply-reminder' || isHoldResolution(record)) throw new Error('Invalid append record')
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
    async rememberQueuedReaction(key, seq, name) {
      return serial(key, () => {
        if (!started || stopped) throw new Error('Queue is not writable')
        load(key)
        const j = journal(key), item = j.items.get(seq)
        if (!item || item.accepted.source !== 'slack') return undefined
        if (item.accepted.queued_ack_reaction) return item.accepted.queued_ack_reaction
        // Delivery may have completed while reporting waited for its turn.
        if (!isOpenItem(item)) return undefined
        const accepted = { ...item.accepted, queued_ack_reaction: name }
        if (!isQueueRecord(accepted)) throw new Error('Invalid queued reaction')
        reconcileRollback(pathFor(key), j)
        const records = j.records.map(r => isAccepted(r) && r.seq === seq ? accepted : r)
        rewrite(pathFor(key), Buffer.from(records.map(r => JSON.stringify(r) + '\n').join('')))
        j.records = records
        rebuild(j)
        return name
      })
    },
    lookupSlackKey,
    item(key, seq) {
      const item = journal(key).items.get(seq)
      return item ? structuredClone(item) : undefined
    },
    items: key => materialize(journal(key)).map(item => structuredClone(item)),
    openCount: key => journal(key).openCount,
    unresolvedHolds(key) {
      const holds = new Map(journal(key).holds), storing = storingHolds.get(key)
      if (storing) holds.set(storing.seq, storing)
      return structuredClone([...holds.values()].sort((a, b) => a.seq - b.seq))
    },
    async resolveHolds(key, resolutions, current = () => true, onCommitted) {
      try {
        const copy = structuredClone(resolutions)
        return await serial(key, () => {
          if (!current()) return []
          if (!started || stopped) throw new Error('Queue is not writable')
          load(key)
          const j = journal(key), seen = new Set<number>(), saved: HoldResolution[] = []
          for (const resolution of copy) {
            const hold = j.holds.get(resolution.seq)
            if (!hold || seen.has(resolution.seq)) continue
            // Only an unparked Post Hold whose root was unknown at arrival parks.
            if (resolution.outcome === 'parked' && !(hold.on === 'post' && hold.root_unknown)) continue
            const record = { v: 1 as const, kind: resolution.outcome, seq: resolution.seq, at: resolution.at }
            if (!isQueueRecord(record) || !isHoldResolution(record)) throw new Error('Invalid hold resolution')
            saved.push(resolution); seen.add(resolution.seq)
          }
          if (!saved.length) return []
          const records: HoldResolutionRecord[] = saved.map(r => ({ v: 1, kind: r.outcome, seq: r.seq, at: r.at }))
          durableAppend(pathFor(key), Buffer.from(records.map(r => JSON.stringify(r) + '\n').join('')), j)
          for (const record of records) update(j, record)
          const wasBlocked = appendBlocked.delete(key)
          // Transfer committed evidence before a queue observer can submit
          // teardown. Never turn an observer failure into an append failure.
          try { void Promise.resolve(onCommitted?.(structuredClone(saved))).catch(() => {}) } catch { /* saved facts remain saved */ }
          if (wasBlocked) event({ type: 'writable', key })
          event({ type: 'holds-resolved', key, resolutions: structuredClone(saved) })
          return saved
        })
      } catch (error) { appendBlocked.add(key); event({ type: 'append-failed', key, path: pathFor(key), error }); throw error }
    },
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
