/** Durable Memory Hold resolution after join recovery. The first-successful-
 * read owner calls resolve after recovering queue joins; this module retries
 * resolution appends, never journal reads. No import-time effects or logging. */
import { isOpenItem, QUEUE_COMPACT_INTERVAL_MS, type DeliveryQueue, type HoldResolution, type QueueItem, type UnresolvedHold } from './delivery-queue.ts'
import { RETYPE_BACKOFF_MS } from './delivery-constants.ts'
import type { ThreadMemory } from './thread-memory.ts'
import type { DeliveryPreparationClock } from './delivery-intake.ts'

export type MemoryHoldMode = 'live' | 'recovered'
export type MemoryHoldResult = 'resolved' | 'unknown' | 'retrying' | 'cancelled'
export interface WithdrawnMemoryHold { seq: number; channel: string; thread_ts: string; ts: string }
export type MemoryHoldEvent =
  | { type: 'resolution-failed'; key: string; error: unknown }
  | { type: 'withdrawn'; key: string; holds: WithdrawnMemoryHold[] }
  | { type: 'release-failed'; key: string; seq: number; error: unknown }

/** One decision time for the batch; any unknown answer leaves it unresolved. */
export function judgeMemoryHolds(
  holds: readonly UnresolvedHold[], joinedBy: (hold: UnresolvedHold) => boolean | 'unknown', at: number,
): HoldResolution[] | undefined {
  const decisions: HoldResolution[] = []
  for (const hold of holds) {
    if (hold.on !== 'memory') continue
    const joined = joinedBy(hold)
    if (joined === 'unknown') return undefined
    decisions.push({ seq: hold.seq, outcome: joined ? 'released' : 'withdrawn', at })
  }
  return decisions
}
export interface MemoryHoldResolverDeps {
  /** Refuse work throughout teardown, including new requests from old events. */
  canRun?(key: string): boolean
  queue: Pick<DeliveryQueue, 'unresolvedHolds' | 'resolveHolds' | 'item'> & Partial<Pick<DeliveryQueue, 'compact'>>
  memory: Pick<ThreadMemory, 'joinedBy' | 'pruneHeldJoins'>
  release(key: string, item: QueueItem, mode: MemoryHoldMode): void | Promise<void>
  now(): number
  clock: DeliveryPreparationClock
  onEvent?(event: MemoryHoldEvent): void
}
export interface MemoryHoldResolver {
  /** compactAfter is used only for the second startup compaction. Its failed
   * rewrite retries hourly and does not hold intake or resolution open. */
  resolve(key: string, mode: MemoryHoldMode, compactAfter?: boolean): Promise<MemoryHoldResult>
  /** After publication has recovered deferred joins, retry only work already
   * requested in this life, preserving each hold's live/recovered feedback. */
  retryPending(key: string): Promise<MemoryHoldResult>
  forget(key: string): void
  stop(): void
}
export function createMemoryHoldResolver(deps: MemoryHoldResolverDeps): MemoryHoldResolver {
  interface Life {
    writer: Promise<unknown>; retry?: unknown; compactRetry?: unknown; step: number; compact: boolean
    modes: Map<number, MemoryHoldMode>
  }
  const lives = new Map<string, Life>()
  let stopped = false
  const active = (key: string) => !stopped && (deps.canRun?.(key) ?? true)
  const current = (key: string, life: Life) => active(key) && lives.get(key) === life
  function event(value: MemoryHoldEvent): void {
    try { void Promise.resolve(deps.onEvent?.(value)).catch(() => {}) } catch { /* observers cannot undo saved facts */ }
  }
  function cancel(life: Life): void {
    if (life.retry !== undefined) deps.clock.clearTimeout(life.retry)
    if (life.compactRetry !== undefined) deps.clock.clearTimeout(life.compactRetry)
  }
  async function compact(key: string, life: Life): Promise<void> {
    if (!current(key, life) || !life.compact || !deps.queue.compact) return
    life.compact = false
    try { await deps.queue.compact(key, () => current(key, life)) } catch {
      if (!current(key, life)) return
      life.compact = true
      life.compactRetry = deps.clock.setTimeout(() => { life.compactRetry = undefined; void compact(key, life) }, QUEUE_COMPACT_INTERVAL_MS)
    }
  }
  function schedule(key: string, life: Life): Promise<MemoryHoldResult> {
    const next = life.writer.catch(() => {}).then(() => run(key, life))
    life.writer = next
    return next
  }
  async function run(key: string, life: Life): Promise<MemoryHoldResult> {
    if (!current(key, life)) return 'cancelled'
    if (life.retry !== undefined) { deps.clock.clearTimeout(life.retry); life.retry = undefined }
    const holds = deps.queue.unresolvedHolds(key).filter(hold => hold.on === 'memory' && life.modes.has(hold.seq))
    const unresolved = new Set(holds.map(hold => hold.seq))
    for (const seq of life.modes.keys()) if (!unresolved.has(seq)) life.modes.delete(seq)
    const decisions = judgeMemoryHolds(holds, hold => deps.memory.joinedBy(key, hold.channel, hold.thread_ts, hold.stamp, hold.arrived_at), deps.now())
    if (!decisions) return 'unknown'
    // Capture names before an unrelated queue compaction can remove a saved
    // withdrawal. Release feedback may await preparation for another item.
    const withdrawn = decisions.flatMap(decision => {
      if (decision.outcome !== 'withdrawn') return []
      const hold = holds.find(h => h.seq === decision.seq)!, item = deps.queue.item(key, decision.seq)
      return item ? [{ seq: decision.seq, channel: hold.channel, thread_ts: hold.thread_ts, ts: item.accepted.ts }] : []
    })
    let saved: HoldResolution[] = []
    try {
      if (decisions.length) saved = await deps.queue.resolveHolds(key, decisions, () => current(key, life), committed => {
        // This handoff belongs to the durable commit, not this resolver life.
        // It must precede both cancellation at the async return boundary and
        // any released item's awaited feedback. Only newly saved holds count.
        const savedSeqs = new Set(committed.map(decision => decision.seq))
        const savedWithdrawn = withdrawn.filter(hold => savedSeqs.has(hold.seq))
        if (savedWithdrawn.length) event({ type: 'withdrawn', key, holds: savedWithdrawn })
      })
    } catch (error) {
      if (!current(key, life)) return 'cancelled'
      event({ type: 'resolution-failed', key, error })
      life.retry = deps.clock.setTimeout(() => {
        life.retry = undefined
        if (current(key, life)) void schedule(key, life).catch(() => {})
      }, RETYPE_BACKOFF_MS[Math.min(life.step++, RETYPE_BACKOFF_MS.length - 1)]!)
      return 'retrying'
    }
    if (!current(key, life)) return 'cancelled'
    life.step = 0
    for (const decision of saved) {
      if (!current(key, life)) return 'cancelled'
      const item = deps.queue.item(key, decision.seq)
      if (!item) continue
      if (decision.outcome === 'released' && isOpenItem(item)) {
        try { await deps.release(key, item, life.modes.get(decision.seq)!) }
        catch (error) { if (current(key, life)) event({ type: 'release-failed', key, seq: decision.seq, error }) }
      }
    }
    if (!current(key, life)) return 'cancelled'
    for (const decision of decisions) life.modes.delete(decision.seq)
    deps.memory.pruneHeldJoins(key)
    void compact(key, life)
    return 'resolved'
  }
  const api: MemoryHoldResolver = {
    resolve(key, mode, compactAfter = false) {
      if (!active(key)) return Promise.resolve('cancelled')
      let life = lives.get(key)
      if (!life) { life = { writer: Promise.resolve(), step: 0, compact: false, modes: new Map() }; lives.set(key, life) }
      life.compact ||= compactAfter
      // Capture at the request, before another intake adds a live hold or a
      // publication queues a retry of recovered work. Retries keep its mode.
      for (const hold of deps.queue.unresolvedHolds(key)) {
        if (hold.on === 'memory' && !life.modes.has(hold.seq)) life.modes.set(hold.seq, mode)
      }
      return schedule(key, life)
    },
    retryPending(key) {
      const life = lives.get(key)
      if (!life || !current(key, life)) return Promise.resolve('cancelled')
      return life.modes.size ? schedule(key, life) : Promise.resolve('resolved')
    },
    forget(key) { const life = lives.get(key); if (life) cancel(life); lives.delete(key) },
    stop() { stopped = true; for (const life of lives.values()) cancel(life); lives.clear() },
  }
  return api
}
