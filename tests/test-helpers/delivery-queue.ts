/** Shared durable queue fixtures; all paths belong to the caller's scratch directory. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDeliveryQueue, parseQueueRecord, type AcceptedInput, type AcceptedRecord, type DeliveredRecord, type DeliveryQueueOptions, type FixedRecord, type HoldField, type HoldResolutionRecord, type NoticedRecord, type PostHoldField, type QueueRecord, type ReactionAcceptedInput, type RefusedRecord, type SentRecord, type UnknownSentRecord } from '../../src/delivery-queue.ts'
import { postIntent, threadJoin, THREAD_CHANNELS, THREAD_ROOTS, THREAD_STAMP } from './thread-memory.ts'

export const slackInput = (overrides: Partial<AcceptedInput> = {}): AcceptedInput => ({
  source: 'slack', text: 'message', channel: 'C0TEST001', channel_type: 'channel', user: 'U0TEST001',
  key: { chat_id: 'C0TEST001', ts: '1700000000.000001' }, ts: '1700000000.000001', via: 'all', ...overrides,
})
/** Supply the decision's time explicitly, usually from the caller's fake clock. */
export const memoryHold = (arrived_at: number, overrides: Partial<Omit<HoldField, 'on' | 'arrived_at'>> = {}): HoldField => ({
  on: 'memory', thread_ts: THREAD_ROOTS.primary, stamp: { ...THREAD_STAMP }, ...overrides, arrived_at,
})
/** Waits on the fixture post-intent's operation unless operations are given; store it with heldSlackInput. */
export const postHold = (arrived_at: number, overrides: Partial<Omit<PostHoldField, 'on' | 'arrived_at'>> = {}): PostHoldField => ({
  on: 'post', operations: [postIntent(threadJoin()).operationId], thread_ts: THREAD_ROOTS.primary, stamp: { ...THREAD_STAMP },
  root_unknown: false, ...overrides, arrived_at,
})
/** A Post Hold whose root P's Thread Memory view did not know: the one kind `parked` turns into a Memory Hold. */
export const unknownRootPostHold = (arrived_at: number): PostHoldField => postHold(arrived_at, { root_unknown: true })
/** Each hold kind's field builder, for tables over both kinds. */
export const HOLD_FIELDS = { memory: memoryHold, post: postHold } as const
export function heldSlackInput(hold: HoldField, overrides: Partial<Omit<AcceptedInput, 'source' | 'via' | 'hold' | 'thread_join'>> = {}): AcceptedInput {
  const input = slackInput({ ts: THREAD_ROOTS.secondary, key: { chat_id: THREAD_CHANNELS.primary, ts: THREAD_ROOTS.secondary },
    ...overrides, source: 'slack', via: 'thread', thread_ts: hold.thread_ts, hold })
  delete input.thread_join
  return input
}
export const injectedInput = (overrides: Partial<AcceptedInput> = {}): AcceptedInput => ({ source: 'interject', sender: 'interject', text: 'prompt', ...overrides })
/** A Reaction Item whose key agrees with its final fields unless explicitly overridden. */
export function reactionInput(overrides: Partial<ReactionAcceptedInput> = {}): ReactionAcceptedInput {
  const fields = { channel: 'C0TEST001', message_ts: '1700000000.000001', ts: '1700000000.000002', change: 'added' as const, emoji: 'thumbsup', user: 'U0REACTOR', ...overrides }
  const reaction_key = overrides.reaction_key ?? { chat_id: fields.channel, message_ts: fields.message_ts, reactor: fields.user || fields.bot_id || '', emoji: fields.emoji, change: fields.change, event_ts: fields.ts }
  return { source: 'reaction', text: '', origin: 'slack-event', mode: 'strict', ...fields, reaction_key }
}
export const queuePath = (stateDir: string, key = 'alpha'): string => join(stateDir, 'queue', `${key}.jsonl`)
export function seedQueue(stateDir: string, records: readonly (QueueRecord | string)[], key = 'alpha'): void {
  mkdirSync(join(stateDir, 'queue'), { recursive: true })
  writeFileSync(queuePath(stateDir, key), records.map(r => typeof r === 'string' ? r : JSON.stringify(r) + '\n').join(''))
}
export function readQueue(stateDir: string, key = 'alpha'): QueueRecord[] {
  return readFileSync(queuePath(stateDir, key), 'utf8').split('\n').filter(Boolean).map(line => {
    const r = parseQueueRecord(line)
    if (!r) throw new Error('invalid record in test queue')
    return r
  })
}
const ITEM_ID_FIELD = /"item_id":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",/g
/** `value` without b.r6d's random per-item `item_id`: journal bytes, JSON text,
 * or plain objects and arrays, so two histories or a main-format one compare. */
export function withoutItemIds<T>(value: T): T {
  if (Buffer.isBuffer(value)) return Buffer.from(value.toString('utf8').replace(ITEM_ID_FIELD, '')) as T
  if (typeof value === 'string') return value.replace(ITEM_ID_FIELD, '') as T
  if (Array.isArray(value)) return value.map(withoutItemIds) as T
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'item_id').map(([name, field]) => [name, withoutItemIds(field)])) as T
  }
  return value
}
export async function makeQueue(stateDir: string, options: Omit<DeliveryQueueOptions, 'stateDir'> = {}) {
  const queue = createDeliveryQueue({ stateDir, ...options })
  await queue.start()
  return queue
}
export const fixedRecord = (seq = 1, parts = ['message']): FixedRecord => ({ v: 1, kind: 'fixed', seq, parts })
export type SentRecordOverrides = Partial<Omit<SentRecord, 'v' | 'kind' | 'seq' | 'attempt' | 'send_kind'>>
export type UnknownSendVariant = Pick<UnknownSentRecord, 'unknown_outcome' | 'quarantine'> & Partial<Pick<UnknownSentRecord, 'at'>>
/** Known sends retain all window facts. Unknown outcomes carry only quarantine
 * evidence, never fabricated part/session/path/size facts. Old defaults stay put. */
export function sentRecord(seq?: number, attempt?: number, send_kind?: SentRecord['send_kind'], overrides?: SentRecordOverrides): SentRecord
export function sentRecord(seq: number, attempt: number, variant: UnknownSendVariant): UnknownSentRecord
export function sentRecord(seq = 1, attempt = 1, variant: SentRecord['send_kind'] | UnknownSendVariant = 'text', overrides: SentRecordOverrides = {}): SentRecord | UnknownSentRecord {
  if (typeof variant !== 'string') return { v: 1, kind: 'sent', seq, attempt, at: variant.at ?? 1000, unknown_outcome: true, quarantine: { ...variant.quarantine } }
  return { v: 1, kind: 'sent', seq, attempt, part: 1, send_kind: variant, at: 1000, session_id: 'session', transcript_path: '/scratch/transcript.jsonl', transcript_size: 0, ...overrides }
}
/** A supplied receipt replaces the default whole: UUID, offset (including 0),
 * or both, without an accidental default UUID credit on an offset-only record. */
export const deliveredRecord = (seq = 1, at = 1000, overrides: Partial<Pick<DeliveredRecord, 'part' | 'receipt'>> = {}): DeliveredRecord => ({ v: 1, kind: 'delivered', seq, part: 1, at, receipt: { path: '/scratch/transcript.jsonl', uuid: 'receipt' }, ...overrides })
/** Seed resolutions only for replay/validation; behavioral tests use queue.resolveHolds. */
export const releasedRecord = (seq = 1, at = 1000): HoldResolutionRecord => ({ v: 1, kind: 'released', seq, at })
export const withdrawnRecord = (seq = 1, at = 1000): HoldResolutionRecord => ({ v: 1, kind: 'hold-withdrawn', seq, at })
export const parkedRecord = (seq = 1, at = 1000): HoldResolutionRecord => ({ v: 1, kind: 'parked', seq, at })
export const refusedRecord = (seq = 1, attempt = 1, at = 1000): RefusedRecord => ({ v: 1, kind: 'refused', seq, attempt, at })
export const noticedRecord = (seq = 1, at = 1000): NoticedRecord => ({ v: 1, kind: 'noticed', seq, at })
/** A Slack input's accepted record as the queue writes it: the input's fields, then the record's own. */
export const acceptedRecord = (seq: number, input: AcceptedInput, received_at: number): AcceptedRecord =>
  ({ ...input, v: 1, kind: 'accepted', seq, received_at, ts: input.ts ?? input.key?.ts ?? '' })
/** A final line cut by a crash mid-append: `record`'s serialized line through its `through`
 * field and the comma after it, with no newline. Never valid JSON. */
export function tornRecord(record: QueueRecord, through: string): string {
  const fields = Object.entries(record).filter(([, value]) => value !== undefined)
  const end = fields.findIndex(([name]) => name === through) + 1
  if (end === 0 || end === fields.length) throw new Error(`tornRecord: ${through} is not a field before the record's last`)
  const torn = `{${fields.slice(0, end).map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)},`).join('')}`
  if (!JSON.stringify(record).startsWith(torn)) throw new Error('tornRecord: not a prefix of the serialized record')
  return torn
}
