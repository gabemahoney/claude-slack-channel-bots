/** Shared durable queue fixtures; all paths belong to the caller's scratch directory. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDeliveryQueue, parseQueueRecord, type AcceptedInput, type DeliveredRecord, type DeliveryQueueOptions, type QueueRecord } from '../../src/delivery-queue.ts'

export const slackInput = (overrides: Partial<AcceptedInput> = {}): AcceptedInput => ({
  source: 'slack', text: 'message', channel: 'C0TEST001', channel_type: 'channel', user: 'U0TEST001',
  key: { chat_id: 'C0TEST001', ts: '1700000000.000001' }, ts: '1700000000.000001', via: 'all', ...overrides,
})
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
export const sentRecord = (seq = 1, attempt = 1, send_kind: 'text' | 'enter' | 'retype' = 'text'): Extract<QueueRecord, { kind: 'sent' }> => ({ v: 1, kind: 'sent', seq, attempt, part: 1, send_kind, at: 1000, session_id: 'session', transcript_path: '/scratch/transcript.jsonl', transcript_size: 0 })
export const deliveredRecord = (seq = 1, at = 1000): DeliveredRecord => ({ v: 1, kind: 'delivered', seq, part: 1, at, receipt: { path: '/scratch/transcript.jsonl', uuid: 'receipt' } })
