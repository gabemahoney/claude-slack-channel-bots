/** Queue-to-Thread-Memory recovery at start and before a persona's bring-up.
 * No import-time effects, queue writes, selection or delivery work. */
import type { DeliveryQueue } from './delivery-queue.ts'
import type { ThreadMemory, ThreadJoin } from './thread-memory.ts'

/** Delivered items retained for their unsaved join participate too. The queue
 * supplies sequence order; recovery advances the clock and adds joins before
 * returning, scheduling their append without waiting on another persona. A
 * replay awaiting its repair rewrite supplies none: the turn that completes
 * the repair runs this recovery again. */
export function recoverQueuedJoins(
  key: string, queue: Pick<DeliveryQueue, 'items' | 'durabilityPending'>, memory: Pick<ThreadMemory, 'recoverJoins'>,
): void {
  if (queue.durabilityPending?.(key)) return
  const candidates: ThreadJoin[] = []
  for (const { accepted } of queue.items(key)) {
    const fact = accepted.thread_join
    if (!fact || !accepted.channel || (accepted.via !== 'mention' && accepted.via !== 'broadcast')) continue
    candidates.push({ channel: accepted.channel, root: fact.thread_ts, stamp: fact.stamp, at: fact.at, source: accepted.via })
  }
  memory.recoverJoins(key, candidates)
  // Memory Hold resolution belongs after this same recovery step.
}
