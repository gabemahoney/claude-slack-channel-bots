/** Shared durable queue fixtures; all paths belong to the caller's scratch directory. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDeliveryQueue, parseQueueRecord, type AcceptedInput, type AcceptedRecord, type DeliveredRecord, type DeliveryQueueOptions, type FixedRecord, type HoldField, type HoldResolutionRecord, type NoticedRecord, type PostHoldField, type QueueRecord, type RefusedRecord } from '../../src/delivery-queue.ts'
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
export async function makeQueue(stateDir: string, options: Omit<DeliveryQueueOptions, 'stateDir'> = {}) {
  const queue = createDeliveryQueue({ stateDir, ...options })
  await queue.start()
  return queue
}
export const fixedRecord = (seq = 1, parts = ['message']): FixedRecord => ({ v: 1, kind: 'fixed', seq, parts })
export const sentRecord = (seq = 1, attempt = 1, send_kind: 'text' | 'enter' | 'retype' = 'text'): Extract<QueueRecord, { kind: 'sent' }> => ({ v: 1, kind: 'sent', seq, attempt, part: 1, send_kind, at: 1000, session_id: 'session', transcript_path: '/scratch/transcript.jsonl', transcript_size: 0 })
export const deliveredRecord = (seq = 1, at = 1000): DeliveredRecord => ({ v: 1, kind: 'delivered', seq, part: 1, at, receipt: { path: '/scratch/transcript.jsonl', uuid: 'receipt' } })
/** Seed resolutions only for replay/validation; behavioral tests use queue.resolveHolds. */
export const releasedRecord = (seq = 1, at = 1000): HoldResolutionRecord => ({ v: 1, kind: 'released', seq, at })
export const withdrawnRecord = (seq = 1, at = 1000): HoldResolutionRecord => ({ v: 1, kind: 'withdrawn', seq, at })
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
