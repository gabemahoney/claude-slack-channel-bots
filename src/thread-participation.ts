/** Permanent thread facts and observation protection. Persistence uses the
 * queue's injected, serialized fsync writer; construction performs no I/O. */
import { createHash } from 'node:crypto'
import { CHANNEL_ID_RE, type ChannelMode, type DeliveryMode } from './config.ts'
import { PERSONA_KEY_RE } from './persona-identity.ts'
import { isThreadTimestamp } from './delivery-decision.ts'
import type { DeliveryQueue, QueueStoredResult, SlackKey } from './delivery-queue.ts'
import type { SharedChannelAuthority, SharedChannelLifetime, SharedLifetimeStatus } from './shared-channels.ts'

export interface ThreadObservation {
  id: string
  lifetime: SharedChannelLifetime
  /** Absent only for evidence whose posted root is not yet known. */
  root?: string
  slackKey?: SlackKey
  observedAt: number
  policy: { mode: ChannelMode; delivery: DeliveryMode }
}
export interface ThreadParticipationRecord {
  v: 1
  kind: 'thread-participation'
  seq: 0
  observation: ThreadObservation
  state: 'observed' | 'enrolled' | 'cancelled'
  /** The acceptance that established incoming participation, never a new item. */
  acceptedSeq?: number
}
export interface ThreadParticipationGap { v: 1; kind: 'thread-gap'; seq: 0 }
export type ThreadParticipationReading = {
  key: string; channel: string; root: string
  kind: 'followed' | 'unfollowed' | 'unresolved'
  /** A storage gap is distinct from an ordinary in-flight observation. */
  failure?: 'storage'
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
export function isThreadObservation(value: unknown): value is ThreadObservation {
  if (!object(value) || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id) ||
      !object(value.lifetime) || !object(value.policy) || !integer(value.observedAt)) return false
  const l = value.lifetime, p = value.policy, key = value.slackKey
  return typeof l.key === 'string' && PERSONA_KEY_RE.test(l.key) && typeof l.channel === 'string' && CHANNEL_ID_RE.test(l.channel) &&
    typeof l.incarnation === 'string' && l.incarnation.length > 0 && integer(l.resetOrder) && integer(l.membershipBoundary) && integer(l.leaveBoundary) &&
    (l.createdAt === undefined || integer(l.createdAt)) && ['strict', 'open'].includes(String(p.mode)) &&
    ['off', 'mentions', 'all', 'thread_hybrid'].includes(String(p.delivery)) &&
    (value.root === undefined || isThreadTimestamp(value.root)) &&
    (key === undefined || (p.delivery !== 'off' && object(key) && key.chat_id === l.channel && isThreadTimestamp(key.ts) &&
      (key.edited_ts === undefined || typeof key.edited_ts === 'string') && value.root !== undefined))
}
export function isThreadParticipationRecord(value: unknown): value is ThreadParticipationRecord {
  return object(value) && value.v === 1 && value.kind === 'thread-participation' && value.seq === 0 &&
    isThreadObservation(value.observation) && ['observed', 'enrolled', 'cancelled'].includes(String(value.state)) &&
    (value.acceptedSeq === undefined || (integer(value.acceptedSeq) && value.acceptedSeq > 0)) &&
    (value.state !== 'enrolled' || (value.observation.root !== undefined &&
      (value.observation.slackKey === undefined || value.acceptedSeq !== undefined)))
}
export function parseThreadParticipationRecord(line: string): ThreadParticipationRecord | undefined {
  try { const value: unknown = JSON.parse(line); return isThreadParticipationRecord(value) ? value : undefined } catch { return undefined }
}
export function threadObservationId(lifetime: SharedChannelLifetime, key: SlackKey): string {
  return createHash('sha256').update(JSON.stringify([lifetime.key, lifetime.channel, lifetime.incarnation,
    lifetime.resetOrder, lifetime.createdAt ?? null, lifetime.membershipBoundary, lifetime.leaveBoundary, key.ts, key.edited_ts ?? null])).digest('hex')
}
export type ThreadParticipationQueue = Pick<DeliveryQueue,
  'keys' | 'threadRecords' | 'threadRecord' | 'threadReadable' | 'recordThreadObservation' | 'cancelThreadObservation'>
export interface ThreadParticipationOptions {
  queue: ThreadParticipationQueue
  authority: Pick<SharedChannelAuthority, 'lifetime' | 'lifetimeStatus'>
  now?: () => number
}
export interface ThreadParticipation {
  /** Called after queue replay and authority initialization, before admission. */
  start(): void
  lifetime(key: string, channel: string): SharedChannelLifetime | undefined
  lifetimeStatus(lifetime: SharedChannelLifetime): SharedLifetimeStatus
  /** Shared observation publication for later confirmed-post evidence. */
  observe(observation: ThreadObservation): SharedLifetimeStatus
  observeIncoming(key: string, slackKey: SlackKey, root: string, policy: ThreadObservation['policy']): ThreadObservation | undefined
  persist(observation: ThreadObservation): Promise<SharedLifetimeStatus>
  /** Authoritative discard only; never removes a concurrent durable acceptance. */
  discardIncoming(lifetime: SharedChannelLifetime, slackKey: SlackKey): Promise<QueueStoredResult | undefined>
  /** Reconcile the queue's atomic acceptance/enrollment fact. No text replay. */
  recover(key: string, id?: string): SharedLifetimeStatus
  read(key: string, channel: string, root: string): ThreadParticipationReading
  pending(key?: string): ThreadObservation[]
  stop(): void
}
export function createThreadParticipation(options: ThreadParticipationOptions): ThreadParticipation {
  const records = new Map<string, Map<string, ThreadParticipationRecord>>()
  // Reads and individual enrollments do not scan or rewrite the followed
  // population. Full enumeration is reserved for startup/recovery/compaction.
  const roots = new Map<string, Map<string, { followed: Set<string>; pending: Set<string> }>>()
  const unknown = new Map<string, Set<string>>()
  const initialized = new Set<string>()
  let started = false, stopped = false
  const scope = (l: SharedChannelLifetime) => JSON.stringify([l.key, l.channel, l.incarnation, l.resetOrder, l.createdAt ?? null, l.membershipBoundary, l.leaveBoundary])
  function install(key: string, record: ThreadParticipationRecord): void {
    let own = records.get(key)
    if (!own) { own = new Map(); records.set(key, own) }
    const previous = own.get(record.observation.id)
    if (previous?.state === 'enrolled' || previous?.state === 'cancelled' && record.state === 'observed') return
    if (previous) {
      const old = previous.observation, token = scope(old.lifetime)
      if (old.root) {
        const index = roots.get(token)?.get(old.root)
        index?.followed.delete(old.id); index?.pending.delete(old.id)
      } else unknown.get(token)?.delete(old.id)
    }
    own.set(record.observation.id, structuredClone(record))
    const observation = record.observation, channel = scope(observation.lifetime)
    if (observation.root) {
      let byRoot = roots.get(channel)
      if (!byRoot) { byRoot = new Map(); roots.set(channel, byRoot) }
      let index = byRoot.get(observation.root)
      if (!index) { index = { followed: new Set(), pending: new Set() }; byRoot.set(observation.root, index) }
      if (record.state === 'enrolled') index.followed.add(observation.id)
      if (record.state === 'observed') index.pending.add(observation.id)
    } else if (record.state === 'observed') {
      let ids = unknown.get(channel)
      if (!ids) { ids = new Set(); unknown.set(channel, ids) }
      ids.add(observation.id)
    }
  }
  function status(lifetime: SharedChannelLifetime): SharedLifetimeStatus {
    if (!started || stopped) return 'unresolved'
    return options.authority.lifetimeStatus(lifetime)
  }
  function restore(key: string): void {
    for (const record of options.queue.threadRecords(key)) install(key, record)
    initialized.add(key)
  }
  const api: ThreadParticipation = {
    start() {
      for (const key of options.queue.keys()) {
        try { restore(key) } catch { /* this persona stays unresolved; other journals remain usable */ }
      }
      started = true
    },
    lifetime: (key, channel) => options.authority.lifetime(key, channel),
    lifetimeStatus: status,
    observe(observation) {
      if (!isThreadObservation(observation)) return 'unresolved'
      const current = status(observation.lifetime)
      if (current === 'current') install(observation.lifetime.key, { v: 1, kind: 'thread-participation', seq: 0, state: 'observed', observation })
      return current
    },
    observeIncoming(key, slackKey, root, policy) {
      const lifetime = options.authority.lifetime(key, slackKey.chat_id)
      if (!lifetime || status(lifetime) !== 'current') return undefined
      const id = threadObservationId(lifetime, slackKey)
      const existing = records.get(key)?.get(id)
      if (existing) return structuredClone(existing.observation)
      const observation: ThreadObservation = { id, lifetime: structuredClone(lifetime), slackKey: structuredClone(slackKey), root,
        observedAt: (options.now ?? Date.now)(), policy: { ...policy } }
      if (!isThreadObservation(observation)) return undefined
      // This publication is synchronous, before either persistence or callers' awaits.
      api.observe(observation)
      return structuredClone(observation)
    },
    async persist(observation) {
      const before = status(observation.lifetime)
      if (before !== 'current') return before
      await options.queue.recordThreadObservation(observation.lifetime.key, observation)
      return status(observation.lifetime)
    },
    async discardIncoming(lifetime, slackKey) {
      const current = status(lifetime)
      if (current === 'superseded') return
      if (current !== 'current') throw new Error('Thread lifetime is unresolved')
      const key = lifetime.key, id = threadObservationId(lifetime, slackKey)
      const record = options.queue.threadRecord(key, id) ?? records.get(key)?.get(id)
      if (!record) return
      const accepted = await options.queue.cancelThreadObservation(key, record.observation)
      const saved = options.queue.threadRecord(key, id)
      if (saved) install(key, saved)
      return accepted
    },
    recover(key, id) {
      if (!initialized.has(key)) restore(key)
      const saved = id ? [options.queue.threadRecord(key, id)].filter((r): r is ThreadParticipationRecord => r !== undefined) : options.queue.threadRecords(key)
      for (const record of saved) install(key, record)
      if (id) {
        const record = records.get(key)?.get(id)
        if (!record) return 'unresolved'
        const current = status(record.observation.lifetime)
        return current !== 'current' ? current : record.state === 'enrolled' ? 'current' : 'unresolved'
      }
      return options.queue.threadReadable(key) ? 'current' : 'unresolved'
    },
    read(key, channel, root) {
      const answer = (kind: ThreadParticipationReading['kind'], failure?: 'storage'): ThreadParticipationReading => ({ key, channel, root, kind, ...(failure ? { failure } : {}) })
      const lifetime = options.authority.lifetime(key, channel)
      if (!lifetime || status(lifetime) !== 'current' || !isThreadTimestamp(root)) return answer('unresolved')
      if (!initialized.has(key)) {
        try { restore(key) } catch { return answer('unresolved', 'storage') }
      }
      const token = scope(lifetime), matching = roots.get(token)?.get(root)
      if (matching?.followed.size) return answer('followed')
      if (!options.queue.threadReadable(key)) return answer('unresolved', 'storage')
      if (matching?.pending.size || unknown.get(token)?.size) return answer('unresolved')
      return answer('unfollowed')
    },
    pending(key) {
      return [...records].filter(([k]) => key === undefined || key === k).flatMap(([, own]) => [...own.values()])
        .filter(r => r.state === 'observed' && status(r.observation.lifetime) !== 'superseded').map(r => structuredClone(r.observation))
    },
    stop() { stopped = true },
  }
  return api
}
