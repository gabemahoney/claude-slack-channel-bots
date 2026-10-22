/** Durable live observations stored inside the shared authority, never a
 * second membership store. Timestamps reject stale evidence; local durable
 * order alone orders applications. Import-safe and free of I/O. */
import { CHANNEL_ID_RE } from './config.ts'

export const MEMBERSHIP_EVENT_ID_RE = /^Ev[A-Za-z0-9]+$/
export const MEMBERSHIP_TIMESTAMP_RE = /^\d{1,16}(?:\.\d{1,9})?$/
export interface MembershipEvidence {
  event: string
  /** Original Slack ID when event is a separate contradictory-payload key. */
  originalEvent?: string
  channel: string
  member: boolean
  identity: string
  connectionId: string
  timestamp: string
  boundary: number
  observedRevision: number
  recordedOrder: number
  state: 'pending' | 'conflict' | 'applied' | 'superseded'
  conflict?: 'predecessor' | 'scan-overlap' | 'same-time' | 'contradictory-id' | 'unapplied-connection' | 'reset-overlap'
  channelType?: 'channel' | 'group'
  isExtSharedChannel?: boolean
}

export type MembershipEventPayload = Pick<MembershipEvidence, 'channel' | 'member' | 'identity' | 'timestamp' | 'channelType' | 'isExtSharedChannel'>
export function membershipPayloadIdentity(evidence: MembershipEventPayload): string {
  // Connection IDs and local order belong to reception, not Slack's event:
  // a retry on a replacement socket must still match the complete payload.
  return JSON.stringify([evidence.channel, evidence.member, evidence.identity, evidence.timestamp,
    evidence.channelType, evidence.isExtSharedChannel])
}

export function compareMembershipTimestamp(a: string, b: string): number {
  const value = (text: string) => {
    const [seconds, fraction = ''] = text.split('.')
    return BigInt(seconds!) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'))
  }
  return value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0
}

/** event_time names a whole second; event_ts names a point. Never order
 * overlapping observations by comparing only their lower bounds. */
export function membershipTimestampUpperBound(timestamp: string): string {
  return timestamp.includes('.') ? timestamp : `${timestamp}.999999999`
}
export function compareMembershipEventTimes(a: string, b: string): number {
  if (compareMembershipTimestamp(membershipTimestampUpperBound(a), b) < 0) return -1
  if (compareMembershipTimestamp(a, membershipTimestampUpperBound(b)) > 0) return 1
  return 0
}

/** Preserve every provable predecessor. For incomparable events, process
 * joins before leaves where possible so an ambiguous join never supplies the
 * final state. The caller still needs current inventory after this recovery;
 * this is an application order, not a claim to reconstruct Slack history. */
export function orderMembershipRecovery(records: MembershipEvidence[]): MembershipEvidence[] {
  const remaining = new Set(records)
  const predecessors = new Map(records.map(record => [record, records.filter(other =>
    compareMembershipEventTimes(other.timestamp, record.timestamp) < 0).length]))
  const result: MembershipEvidence[] = []
  while (remaining.size) {
    const next = [...remaining].filter(record => predecessors.get(record) === 0)
      .sort((a, b) => Number(b.member) - Number(a.member) || a.recordedOrder - b.recordedOrder || a.event.localeCompare(b.event))[0]!
    remaining.delete(next)
    result.push(next)
    for (const record of remaining) {
      if (compareMembershipEventTimes(next.timestamp, record.timestamp) < 0) predecessors.set(record, predecessors.get(record)! - 1)
    }
  }
  return result
}

export function validateMembershipEvidence(value: unknown, revision: number): asserts value is Record<string, MembershipEvidence> {
  const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!object(value)) throw new Error('Invalid membership recovery evidence.')
  for (const [id, v] of Object.entries(value)) {
    if (!object(v) || !MEMBERSHIP_EVENT_ID_RE.test(id) || v['event'] !== id ||
        (v['originalEvent'] !== undefined && (typeof v['originalEvent'] !== 'string' ||
          !MEMBERSHIP_EVENT_ID_RE.test(v['originalEvent']) || v['originalEvent'] === id ||
          v['state'] !== 'conflict' || v['conflict'] !== 'contradictory-id')) ||
        typeof v['channel'] !== 'string' || !CHANNEL_ID_RE.test(v['channel']) ||
        typeof v['member'] !== 'boolean' || typeof v['identity'] !== 'string' || !v['identity'] ||
        typeof v['connectionId'] !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(v['connectionId']) ||
        typeof v['timestamp'] !== 'string' || !MEMBERSHIP_TIMESTAMP_RE.test(v['timestamp']) ||
        !['pending', 'conflict', 'applied', 'superseded'].includes(v['state'] as string) ||
        (v['conflict'] !== undefined && !['predecessor', 'scan-overlap', 'same-time', 'contradictory-id', 'unapplied-connection', 'reset-overlap'].includes(v['conflict'] as string)) ||
        !Number.isSafeInteger(v['boundary']) || (v['boundary'] as number) < 0 ||
        !Number.isSafeInteger(v['observedRevision']) || (v['observedRevision'] as number) < 1 ||
        (v['observedRevision'] as number) > revision || (v['boundary'] as number) > (v['observedRevision'] as number) ||
        !Number.isSafeInteger(v['recordedOrder']) || (v['recordedOrder'] as number) < (v['observedRevision'] as number) ||
        (v['recordedOrder'] as number) > revision ||
        (v['channelType'] !== undefined && v['channelType'] !== 'channel' && v['channelType'] !== 'group') ||
        (v['isExtSharedChannel'] !== undefined && typeof v['isExtSharedChannel'] !== 'boolean')) {
      throw new Error('Invalid membership recovery evidence.')
    }
  }
}
