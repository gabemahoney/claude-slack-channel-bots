/** Legacy input custody over the existing append-only queue API. */
import type { GetResult } from 'agent-director'
import type { DeliveryQueue, ReplyReminderQueue, QueueItem, SubmissionBlockedRecord, SentRecord, UnknownSentRecord } from './delivery-queue.ts'
import { parseLaunchStart } from './pending-row.ts'
import type { AdInputBinding, AdInputHoldRecord, AdInputHoldStore } from './ad-input-holds.ts'

export const AD_INPUT_UNCONFIRMED = 'ad-input-unconfirmed'
export const AD_INPUT_LAUNCH_FINISHED = 'ad-input-launch-finished'
export const AD_INPUT_NEW_LAUNCH = 'ad-input-new-launch'
export function isLegacyInputCustodyReason(reason: string): boolean {
  return [AD_INPUT_UNCONFIRMED, AD_INPUT_LAUNCH_FINISHED, AD_INPUT_NEW_LAUNCH].includes(reason)
}
/** A crash after the delivered append must not leave its already confirmed
 * part holding a later part (or reconnect) on the next CSCB start. */
export function clearDeliveredInputHold(queue: DeliveryQueue & Partial<Pick<ReplyReminderQueue, 'replyReminderItems'>>, holds: AdInputHoldStore, key: string): boolean {
  const held = holds.get(key)
  if (held.kind !== 'record' || !held.record.delivery) return false
  if (queue.isWritable?.(key) === false || queue.durabilityPending?.(key) === true) return false
  const { seq, part, attempt } = held.record.delivery
  const item = queue.item(key, seq)
  // The queue writes its initial reminder with the final delivered append,
  // only after every fixed part is delivered. Compaction retains that proof's
  // unrefused attempts. Matching the held attempt therefore covers its bound
  // part too. A recent key or mere absence/closure of the item proves nothing.
  const delivered = item
    ? item.records.some(r => r.kind === 'delivered' && r.part === part)
    : queue.replyReminderItems?.(key).some(r => r.seq === seq && r.delivery_attempts?.includes(attempt)) === true
  if (!delivered) return false
  return holds.clear(key, held.record.revision).ok
}
export function unresolvedInputBlocks(item: QueueItem, part?: number): { block: SubmissionBlockedRecord; sent: SentRecord | UnknownSentRecord; finished: boolean }[] {
  const attempts = new Map<number, { block: SubmissionBlockedRecord; sent: SentRecord | UnknownSentRecord; finished: boolean }>()
  const sends = new Map(item.records.flatMap(r => r.kind === 'sent' ? [[r.attempt, r] as const] : []))
  const refused = new Set(item.records.flatMap(r => r.kind === 'refused' ? [r.attempt] : []))
  const delivered = new Set(item.records.flatMap(r => r.kind === 'delivered' ? [r.part] : []))
  for (const record of item.records) {
    if (record.kind !== 'submission-blocked') continue
    if (record.reason === AD_INPUT_NEW_LAUNCH) { attempts.delete(record.attempt); continue }
    if (record.reason === AD_INPUT_LAUNCH_FINISHED) { const prior = attempts.get(record.attempt); if (prior) prior.finished = true; continue }
    if (record.reason !== AD_INPUT_UNCONFIRMED) continue
    const sent = sends.get(record.attempt)
    if (sent && !refused.has(sent.attempt) && (!('part' in sent) || ((part === undefined || sent.part === part) && !delivered.has(sent.part)))) {
      attempts.set(record.attempt, { block: record, sent, finished: false })
    }
  }
  return [...attempts.values()]
}
export function captureQueuedInputLaunch(items: Iterable<QueueItem>) {
  return [...items].flatMap(item => unresolvedInputBlocks(item).map(block => ({ seq: item.accepted.seq, ...block })))
}
/** Save AD's finished observation and release each exact attempt only after
 * a new launch is observed. These markers survive missing pending intervals,
 * queue compaction and CSCB restarts; neither marker confirms delivery. */
export async function observeQueuedInputLaunch(queue: DeliveryQueue, key: string, row: GetResult, beforeRead: ReturnType<typeof captureQueuedInputLaunch>, evidence: {
  binding?: AdInputBinding; releasedDelivery?: AdInputHoldRecord['delivery']
} = {}, keepGoing: () => boolean = () => true): Promise<boolean> {
  let released = false
  const dead = row.state === 'ended' || row.state === 'missing'
  const launch = parseLaunchStart(row.launch_started_at), started = parseLaunchStart(row.started_at)
  if (started === undefined || (row.launch_started_at != null && launch === undefined)) return false
  for (const { seq, block, sent, finished } of beforeRead) {
    if (!keepGoing()) return released
    const item = queue.item(key, seq)
    const current = item && unresolvedInputBlocks(item).find(r => r.block === block && r.sent === sent)
    // A read begun before this uncertainty (or its finished observation)
    // cannot supply evidence for it, even if the AD answer arrives later.
    if (!current || current.finished !== finished) continue
    const prior = 'session_id' in sent && evidence.binding?.sessionId === sent.session_id ? evidence.binding : undefined
    const priorLaunch = parseLaunchStart(prior?.launchStartedAt)
    const proof = evidence.releasedDelivery
    const releasedBefore = proof?.seq === block.seq && proof.attempt === block.attempt && 'part' in sent && proof.part === sent.part
    const newLaunch = releasedBefore || (!dead && (finished || ('session_id' in sent && row.session_id !== '' && row.session_id !== sent.session_id) ||
      (prior !== undefined && started !== parseLaunchStart(prior.rowStartedAt)) ||
      (launch !== undefined && (priorLaunch !== undefined ? launch !== priorLaunch : launch > block.at))))
    if (!newLaunch && (!dead || finished)) continue
    await queue.append(key, { v: 1, kind: 'submission-blocked', seq: block.seq, attempt: block.attempt,
      at: newLaunch ? launch ?? started : block.at, reason: newLaunch ? AD_INPUT_NEW_LAUNCH : AD_INPUT_LAUNCH_FINISHED })
    if (!keepGoing()) return released
    if (newLaunch) released = true
  }
  return released
}
