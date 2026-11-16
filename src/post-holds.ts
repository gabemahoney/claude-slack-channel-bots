/** Durable Post Hold resolution from own-post answers or the receipt deadline.
 * Decisions survive append retries in this life; restart releases unresolved
 * holds. No import-time effects, I/O or logging. */
import { isOpenItem, type DeliveryQueue, type HoldOutcome, type HoldResolution, type QueueItem } from './delivery-queue.ts'
import { RETYPE_BACKOFF_MS, THREAD_REPLY_HOLD_MS } from './delivery-constants.ts'
import type { OwnPostJoins, OwnPostOperationView } from './own-post.ts'
import type { DeliveryPreparationClock } from './delivery-intake.ts'
import type { MemoryHoldMode } from './memory-holds.ts'

export type PostHoldVerdict = { kind: 'thread'; thread: string } | { kind: 'failed' } | { kind: 'open' }
/** Direct answers count even after a stamp change; ambiguous lookups do not. */
export function postHoldVerdict(entry: OwnPostOperationView | undefined): PostHoldVerdict {
  if (entry?.lookup?.holds === 'none') return { kind: 'open' }
  if (entry?.outcome?.kind === 'confirmed' && entry.outcome.thread !== undefined) return { kind: 'thread', thread: entry.outcome.thread }
  if (entry?.outcome?.kind === 'failed' || entry?.lookup?.holds === 'failed') return { kind: 'failed' }
  return { kind: 'open' }
}
export function decidePostHold(inputs: {
  threadRoot: string; rootUnknown: boolean; verdicts: readonly PostHoldVerdict[]; expired: boolean
}): HoldOutcome | undefined {
  if (inputs.verdicts.some(verdict => verdict.kind === 'thread' && verdict.thread === inputs.threadRoot)) return 'released'
  if (inputs.verdicts.every(verdict => verdict.kind !== 'open')) return inputs.rootUnknown ? 'parked' : 'withdrawn'
  return inputs.expired ? 'released' : undefined
}

export interface StoredPostHold {
  seq: number; operations: readonly string[]; threadRoot: string; rootUnknown: boolean; receivedAt: number
}
export type PostHoldCause = 'thread' | 'outcomes' | 'timer' | 'restart'
export type PostHoldEvent =
  | { kind: 'post-hold-resolved'; key: string; seq: number; outcome: HoldOutcome; cause: PostHoldCause; heldMs?: number }
  | { kind: 'post-hold-save-failed'; key: string; seqs: number[] }
export interface PostHoldClock extends DeliveryPreparationClock { now(): number }
export interface PostHoldResolverDeps {
  queue: Pick<DeliveryQueue, 'unresolvedHolds' | 'resolveHolds' | 'item'>
  owner: Pick<OwnPostJoins, 'operation'>
  release(key: string, item: QueueItem, mode: MemoryHoldMode): void | Promise<void>
  onParked(key: string): void | Promise<unknown>
  clock: PostHoldClock
  decisionNow(): number
  retryDelaysMs?: readonly number[]
  holdMs?: number
  onEvent?(event: PostHoldEvent): void
  /** Reject old-life events throughout the lifecycle's teardown window. */
  canRun?(key: string): boolean
}
export interface PostHoldResolver {
  /**
   * Track a stored hold, taking over `retention`: the owner's outcome
   * retention its decision took before the store (`OwnPostJoins.retainOutcomes`).
   * A tracked hold keeps it through failed saves until its durable resolution,
   * forget or stop; an inactive, already tracked or failed registration
   * releases it at once, and a failed one leaves no tracked entry, so the
   * saved hold stays for `releaseUntracked`. Never throws.
   */
  held(key: string, hold: StoredPostHold, retention: () => void): void
  check(key: string): void
  releaseUntracked(key: string): Promise<void>
  forget(key: string): void
  stop(): void
}

export function createPostHoldResolver(deps: PostHoldResolverDeps): PostHoldResolver {
  interface Tracked {
    seq: number; input?: StoredPostHold; retention?: () => void; timer?: unknown; expired: boolean
    decision?: HoldResolution; cause?: PostHoldCause; heldMs?: number; mode: MemoryHoldMode
  }
  interface Waiter { seqs: Set<number>; settle(): void }
  interface Life {
    holds: Map<number, Tracked>; queued: boolean; writing: boolean; retry?: unknown; step: number; waiters: Set<Waiter>
  }
  const lives = new Map<string, Life>()
  const holdMs = deps.holdMs ?? THREAD_REPLY_HOLD_MS
  const delays = deps.retryDelaysMs?.length ? deps.retryDelaysMs : RETYPE_BACKOFF_MS
  let stopped = false
  function active(key: string): boolean {
    try { return !stopped && (deps.canRun?.(key) ?? true) } catch { return false }
  }
  const current = (key: string, life: Life) => active(key) && lives.get(key) === life
  function lifeFor(key: string): Life {
    let life = lives.get(key)
    if (!life) { life = { holds: new Map(), queued: false, writing: false, step: 0, waiters: new Set() }; lives.set(key, life) }
    return life
  }
  function event(value: PostHoldEvent): void {
    try { void Promise.resolve(deps.onEvent?.(value)).catch(() => {}) } catch { /* isolated observer */ }
  }
  function clearTimer(hold: Tracked): void {
    if (hold.timer !== undefined) {
      try { deps.clock.clearTimeout(hold.timer) } catch { /* generation guards late callbacks */ }
      hold.timer = undefined
    }
  }
  function releaseRetention(hold: Tracked): void {
    try { hold.retention?.() } catch { /* isolated owner */ }
    hold.retention = undefined
  }
  function settleWaiters(life: Life): void {
    for (const waiter of life.waiters) {
      if ([...waiter.seqs].some(seq => life.holds.has(seq))) continue
      life.waiters.delete(waiter); waiter.settle()
    }
  }
  function arm(key: string, life: Life, hold: Tracked): void {
    const remaining = holdMs - (deps.clock.now() - hold.input!.receivedAt)
    if (remaining <= 0) { hold.expired = true; return }
    hold.timer = deps.clock.setTimeout(() => {
      hold.timer = undefined
      if (!current(key, life) || hold.decision || life.holds.get(hold.seq) !== hold) return
      // A timer may wake early; only its monotonic deadline expires the hold.
      arm(key, life, hold)
      api.check(key)
    }, remaining)
  }
  function evaluate(key: string, life: Life): void {
    if (!current(key, life)) return
    const at = deps.decisionNow(), now = deps.clock.now()
    for (const hold of life.holds.values()) {
      if (hold.decision || !hold.input) continue
      const input = hold.input
      const verdicts = input.operations.map(id => postHoldVerdict(deps.owner.operation(key, id)))
      const outcome = decidePostHold({ ...input, verdicts, expired: hold.expired || now - input.receivedAt >= holdMs })
      if (!outcome) continue
      hold.decision = { seq: hold.seq, outcome, at }
      hold.cause = outcome !== 'released' ? 'outcomes'
        : verdicts.some(verdict => verdict.kind === 'thread' && verdict.thread === input.threadRoot) ? 'thread' : 'timer'
      hold.heldMs = Math.max(0, now - input.receivedAt)
      clearTimer(hold)
    }
    void save(key, life)
  }
  function retry(key: string, life: Life): void {
    if (!current(key, life) || life.retry !== undefined) return
    life.retry = deps.clock.setTimeout(() => {
      life.retry = undefined
      if (current(key, life)) void save(key, life)
    }, delays[Math.min(life.step++, delays.length - 1)]!)
  }
  function savedEffects(key: string, life: Life, batch: Tracked[], saved: HoldResolution[]): void {
    const savedSeqs = new Set(saved.map(decision => decision.seq))
    // Transfer all outcome ownership at the save, before starting feedback.
    for (const hold of batch) { releaseRetention(hold); life.holds.delete(hold.seq) }
    let parked = false
    for (const hold of batch) {
      if (!current(key, life)) return
      if (!savedSeqs.has(hold.seq)) continue
      event({ kind: 'post-hold-resolved', key, seq: hold.seq, outcome: hold.decision!.outcome, cause: hold.cause!,
        ...(hold.heldMs !== undefined ? { heldMs: hold.heldMs } : {}) })
      if (!current(key, life)) return
      parked ||= hold.decision!.outcome === 'parked'
      if (hold.decision!.outcome === 'released') {
        try {
          const item = deps.queue.item(key, hold.seq)
          // Invoke in sequence order, but do not make another hold's save or
          // startup compaction wait on network recovery or preparation.
          if (item && isOpenItem(item)) void Promise.resolve(deps.release(key, item, hold.mode)).catch(() => {})
        } catch { /* routing owns feedback/preparation retries */ }
      }
    }
    if (!current(key, life)) return
    if (parked) {
      try { void Promise.resolve(deps.onParked(key)).catch(() => {}) } catch { /* the Memory Hold remains durable */ }
    }
    settleWaiters(life)
  }
  async function save(key: string, life: Life): Promise<void> {
    if (!current(key, life) || life.writing || life.retry !== undefined) return
    const batch = [...life.holds.values()].filter(hold => hold.decision).sort((a, b) => a.seq - b.seq)
    if (!batch.length) return
    life.writing = true
    try {
      let saved: HoldResolution[]
      try { saved = await deps.queue.resolveHolds(key, batch.map(hold => hold.decision!), () => current(key, life)) }
      catch {
        if (current(key, life)) {
          event({ kind: 'post-hold-save-failed', key, seqs: batch.map(hold => hold.seq) })
          retry(key, life)
        }
        return
      }
      if (!current(key, life)) return
      life.step = 0
      savedEffects(key, life, batch, saved)
    } finally {
      life.writing = false
      if (current(key, life) && life.retry === undefined && [...life.holds.values()].some(hold => hold.decision)) {
        queueMicrotask(() => { void save(key, life) })
      }
    }
  }
  const api: PostHoldResolver = {
    held(key, input, retention) {
      // All or nothing: the decision's retention passes, with no gap, only to a
      // hold whose deadline is armed and first check queued.
      let life: Life | undefined, hold: Tracked | undefined
      try {
        life = active(key) ? lifeFor(key) : undefined
        if (life && !life.holds.has(input.seq)) {
          hold = { seq: input.seq, input: { ...input, operations: [...input.operations] }, retention, expired: false, mode: 'live' }
          life.holds.set(input.seq, hold)
          arm(key, life, hold)
          api.check(key)
          return
        }
      } catch {
        // Undo the partial entry; the saved hold stays for untracked recovery.
        if (life && hold && life.holds.get(hold.seq) === hold) { clearTimer(hold); life.holds.delete(hold.seq) }
      }
      try { retention() } catch { /* cannot fail acceptance */ }
    },
    check(key) {
      if (!active(key)) return
      const life = lives.get(key)
      if (!life || life.queued) return
      life.queued = true
      try {
        queueMicrotask(() => {
          life.queued = false
          if (!current(key, life)) return
          try { evaluate(key, life) } catch { /* no exception reaches intake or an owner event */ }
        })
      } catch (error) {
        // A check that was never queued must not suppress the next one.
        life.queued = false
        throw error
      }
    },
    releaseUntracked(key) {
      if (!active(key)) return Promise.resolve()
      try {
        const life = lifeFor(key), at = deps.decisionNow(), seqs = new Set<number>()
        for (const hold of deps.queue.unresolvedHolds(key)) {
          if (hold.on !== 'post' || life.holds.get(hold.seq)?.mode === 'live') continue
          seqs.add(hold.seq)
          if (!life.holds.has(hold.seq)) life.holds.set(hold.seq, {
            seq: hold.seq, expired: false, mode: 'recovered', cause: 'restart', decision: { seq: hold.seq, outcome: 'released', at },
          })
        }
        if (!seqs.size) return Promise.resolve()
        const done = new Promise<void>(settle => { life.waiters.add({ seqs, settle }) })
        api.check(key)
        return done
      } catch { return Promise.resolve() }
    },
    forget(key) {
      const life = lives.get(key)
      if (!life) return
      lives.delete(key)
      if (life.retry !== undefined) { try { deps.clock.clearTimeout(life.retry) } catch { /* life is invalid */ } }
      for (const hold of life.holds.values()) { clearTimer(hold); releaseRetention(hold) }
      for (const waiter of life.waiters) waiter.settle()
      life.waiters.clear(); life.holds.clear()
    },
    stop() { stopped = true; for (const key of lives.keys()) api.forget(key) },
  }
  return api
}
