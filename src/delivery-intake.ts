/** Post-accept immutable fixation shared by fresh and recovered work. */
import type { WebClient } from '@slack/web-api'
import { isQueueItemClosed, QueueOutcomeFinal, type DeliveryQueue, type FixedRecord, type QueueAccept, type QueueItem, type QueueEvent, type ReactionAcceptedRecord, type WithdrawnRecord } from './delivery-queue.ts'
import { buildReactionNoticeMessage, buildTagParts, NAME_LOOKUP_TIMEOUT_MS, TAG_MAX_BYTES, type ReactionNoticeInput, type TagMessage } from './tag-wrapper.ts'
import { sanitizeFilename } from './lib.ts'
import { RETYPE_BACKOFF_MS } from './delivery-constants.ts'
import { lookupReactionPreparation } from './reaction-preparation.ts'
import { buildReactionMessageUnknownLine, buildReactionWithdrawnLine } from './reaction-preparation-diagnostics.ts'
export interface DeliveryPreparationClock {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}
export interface DeliveryPreparationDeps {
  queue: DeliveryQueue
  resolveUserName(key: string, user: string): Promise<string>
  clientFor(key: string): WebClient | undefined
  /** binds this; production binding is inert. Fixed is durable before this call. */
  wake?(key: string): void | Promise<void>
  /** Post-ack ownership starts even when fixation must retry. */
  onPending?(key: string): void
  onEvent?(event: QueueEvent): void
  /** Called only from post-ack/answer preparation or startup recovery. */
  onReceived?(key: string, item: QueueItem): void
  lookupTimeoutMs?: number
  /** Byte limit for each fixed part; production binds the host's `tagMaxBytesFor`. */
  tagMaxBytes?: number
  clock?: DeliveryPreparationClock
  retryBackoffMs?: readonly number[]
  /** Epoch ms for a withdrawn record's `at`; Date.now when absent. */
  now?(): number
  /** Receives the content-free reaction preparation lines. Best effort. */
  log?(line: string): void
  /** The receiving persona, for its configured name in those lines. */
  persona?(key: string): { name: string; key: string } | undefined
}
export interface DeliveryPreparation {
  /** True only after post-ack preparation or explicit startup recovery owns it. */
  owns(key: string, seq: number): boolean
  prepare(key: string, item: QueueItem): Promise<void>
  /** Startup recovery: prepares every open item of `keys` (default every journal's). */
  recover(keys?: readonly string[]): Promise<void>
  /**
   * Recovery while intake runs: starts each key's current life and prepares
   * under it only the open items already fixed or claimed (handed to
   * `prepare`, or an injected accept past its zero-delay boundary), so work a
   * forget cancelled is fixed again while a Slack item still awaiting its ack
   * stays with its intake.
   */
  reclaim(keys: readonly string[]): Promise<void>
  /** Injected intake only; Slack uses queue.accept then calls prepare after its ack. */
  accept: QueueAccept
  forget(key: string): void
  stop(): Promise<void>
}
interface ReactionOutcome { record: FixedRecord | WithdrawnRecord; messageUnknown: boolean }
/**
 * One persona life's preparation state. `forget(key)` ends the life: work it
 * started appends, logs, wakes and retries nothing further, and none of its
 * state reaches the key's next life. Only the key's claims outlive it, for
 * `reclaim`.
 */
interface PreparationLife {
  ended: boolean
  readonly inFlight: Map<number, Promise<void>>
  readonly retries: Map<number, { step: number; timer?: unknown }>
  readonly fixedParts: Map<number, string[]>
  // A reaction's decided outcome, kept so a failed append retries the identical record.
  readonly reactionOutcomes: Map<number, ReactionOutcome>
}
export function createDeliveryPreparation(deps: DeliveryPreparationDeps): DeliveryPreparation {
  const channels = new Map<string, Map<string, Promise<string>>>()
  const lives = new Map<string, PreparationLife>()
  // Per key, the unfixed items preparation was handed; kept across a forget
  // so the key's next life can reclaim them, dropped once fixed or closed.
  const claimed = new Map<string, Set<number>>()
  // Every life's outstanding work, an ended life's included, so stop drains writes already issued.
  const running = new Set<Promise<void>>()
  let stopped = false
  const timeout = deps.lookupTimeoutMs ?? NAME_LOOKUP_TIMEOUT_MS
  const tagMaxBytes = deps.tagMaxBytes ?? TAG_MAX_BYTES
  const clock: DeliveryPreparationClock = deps.clock ?? {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  }
  function lifeOf(key: string): PreparationLife {
    let life = lives.get(key)
    if (!life) {
      life = { ended: false, inFlight: new Map(), retries: new Map(), fixedParts: new Map(), reactionOutcomes: new Map() }
      lives.set(key, life)
    }
    return life
  }
  const current = (life: PreparationLife): boolean => !stopped && !life.ended
  function claim(key: string, seq: number): void {
    let seqs = claimed.get(key)
    if (!seqs) { seqs = new Set(); claimed.set(key, seqs) }
    seqs.add(seq)
  }
  /** Drops the claim of an item that no longer needs fixing. */
  function release(key: string, seq: number): void {
    const seqs = claimed.get(key)
    if (!seqs?.delete(seq)) return
    if (seqs.size === 0) claimed.delete(key)
  }
  async function bounded(work: () => Promise<string>, fallback: string): Promise<string> {
    let timer: unknown
    try {
      return await Promise.race([
        Promise.resolve().then(work).then(value => value || fallback).catch(() => fallback),
        new Promise<string>(resolve => { timer = clock.setTimeout(() => resolve(fallback), timeout) }),
      ])
    } finally { if (timer !== undefined) clock.clearTimeout(timer) }
  }
  function channelName(key: string, channel: string, type?: string): Promise<string> {
    if (type === 'im' || channel.startsWith('D')) return Promise.resolve('dm')
    let cache = channels.get(key)
    if (!cache) { cache = new Map(); channels.set(key, cache) }
    let result = cache.get(channel)
    if (!result) {
      result = bounded(async () => {
        const info = await deps.clientFor(key)?.conversations.info({ channel })
        return info?.channel?.name?.replace(/^#/, '') || channel
      }, channel)
      cache.set(channel, result)
    }
    return result
  }
  function reactionNotice(a: ReactionAcceptedRecord, d: { user: string; channel_name: string; thread_ts?: string }): ReactionNoticeInput {
    const fields = { chat_id: a.channel, channel_name: d.channel_name, message_id: a.message_ts, user: d.user, ts: a.ts, thread_ts: d.thread_ts, reaction: a.change, emoji: a.emoji }
    return a.user ? { ...fields, user_id: a.user } : { ...fields, bot_id: a.bot_id ?? '' }
  }
  function report(key: string, a: ReactionAcceptedRecord, outcome: ReactionOutcome): void {
    try {
      const record = outcome.record
      if (!deps.log || (record.kind === 'fixed' && !outcome.messageUnknown)) return
      const subject = { key, name: deps.persona?.(key)?.name, chat_id: a.channel, message_ts: a.message_ts }
      const line = record.kind === 'withdrawn' ? buildReactionWithdrawnLine(subject, record.reason, record.failed_condition) : buildReactionMessageUnknownLine(subject)
      void Promise.resolve(deps.log(line)).catch(() => {})
    } catch { /* a diagnostic never undoes, retries or delays a durable outcome */ }
  }
  /**
   * Decides and durably appends a reaction's outcome: true when the caller
   * should wake, false when an outcome stands without a wake, undefined when
   * the life ended with none decided.
   */
  async function fixReaction(key: string, a: ReactionAcceptedRecord, life: PreparationLife): Promise<boolean | undefined> {
    let outcome = life.reactionOutcomes.get(a.seq)
    if (!outcome) {
      // Fresh lookups for every decision; the ordinary channel-name cache is not used.
      const decision = await lookupReactionPreparation(key, a, { clientFor: deps.clientFor, resolveUserName: deps.resolveUserName, clock, lookupTimeoutMs: timeout })
      const fresh = deps.queue.item(key, a.seq)
      if (!fresh || isQueueItemClosed(fresh)) return false
      if (!current(life)) return fresh.fixed ? false : undefined
      if (fresh.fixed) return true
      if (decision.kind === 'fixed') {
        outcome = { record: { v: 1, kind: 'fixed', seq: a.seq, parts: buildTagParts(buildReactionNoticeMessage(reactionNotice(a, decision)), tagMaxBytes) }, messageUnknown: decision.messageUnknown }
      } else {
        const record: WithdrawnRecord = { v: 1, kind: 'withdrawn', seq: a.seq, reason: decision.reason, at: deps.now ? deps.now() : Date.now() }
        if (decision.failed_condition !== undefined) record.failed_condition = decision.failed_condition
        outcome = { record, messageUnknown: false }
      }
      life.reactionOutcomes.set(a.seq, outcome)
    }
    try {
      await deps.queue.append(key, outcome.record)
    } catch (error) {
      if (!(error instanceof QueueOutcomeFinal)) throw error
      // Another durable outcome stands: never replace or report it.
      life.reactionOutcomes.delete(a.seq)
      const fresh = deps.queue.item(key, a.seq)
      return fresh?.fixed !== undefined && !isQueueItemClosed(fresh)
    }
    life.reactionOutcomes.delete(a.seq)
    // The write stands, but a preparation stopped or forgotten during it logs and wakes nothing.
    if (!current(life)) return false
    report(key, a, outcome)
    return true
  }
  /** Fixes the item unless its life ends first; resolves true once it needs no fixing. */
  async function fix(key: string, item: QueueItem, life: PreparationLife): Promise<boolean> {
    // post-ack fixation must not clone every queued item
    // while a burst's remaining events still await durable acceptance.
    const fresh = deps.queue.item(key, item.accepted.seq)
    item = fresh ?? item
    const settled = !fresh || item.fixed !== undefined || isQueueItemClosed(item)
    if (item.fixed || isQueueItemClosed(item)) life.reactionOutcomes.delete(item.accepted.seq)
    // A withdrawn outcome is final: no fixation, retry or wake.
    if (!current(life) || isQueueItemClosed(item)) return settled
    if (!item.fixed && item.accepted.source === 'reaction') {
      // The queue admits a reaction record only in its validated reaction shape.
      const wake = await fixReaction(key, item.accepted as ReactionAcceptedRecord, life)
      if (wake !== true) return wake === false
    } else if (!item.fixed) {
      const a = item.accepted
      let parts = life.fixedParts.get(a.seq)
      if (!parts) {
        let message: TagMessage
        if (a.source !== 'slack') message = { user: a.sender, ts: a.ts, text: a.text }
        else {
          const [user, channel_name] = await Promise.all([
            a.user ? bounded(() => deps.resolveUserName(key, a.user!), a.user) : Promise.resolve(a.username || a.bot_profile_name || a.bot_id || 'unknown'),
            channelName(key, a.channel!, a.channel_type),
          ])
          // A forgotten persona's lookup appends nothing; a stop, unlike a forget, still lets it append.
          if (life.ended) return false
          message = { chat_id: a.channel, channel_name, message_id: a.ts, user, ts: a.ts, thread_ts: a.thread_ts, via: a.via, text: a.text }
          if (a.user) message.user_id = a.user
          else if (a.bot_id) message.bot_id = a.bot_id
          if (a.files?.length) {
            message.attachment_count = String(a.files.length)
            message.attachments = a.files.map(f => `${sanitizeFilename(f.name || 'unnamed')} (${f.mimetype || 'unknown'}, ${f.size || '?'} bytes)`).join('; ')
          }
        }
        parts = buildTagParts(message, tagMaxBytes)
        life.fixedParts.set(a.seq, parts)
      }
      await deps.queue.append(key, { v: 1, kind: 'fixed', seq: a.seq, parts })
      life.fixedParts.delete(a.seq)
    }
    if (current(life)) await deps.wake?.(key)
    return true
  }
  function prepare(key: string, item: QueueItem): Promise<void> {
    try { void Promise.resolve(deps.onReceived?.(key, item)).catch(() => {}) } catch { /* reporting never owns acceptance */ }
    const life = lifeOf(key), seq = item.accepted.seq
    claim(key, seq)
    const existing = life.inFlight.get(seq)
    if (existing) return existing
    const old = life.retries.get(seq)
    if (old?.timer !== undefined) return Promise.resolve()
    const work: Promise<void> = fix(key, item, life).then(settled => {
      life.retries.delete(seq)
      // An ended life's lookup appended nothing: the claim stays for the next life.
      if (settled) release(key, seq)
    }).catch(error => {
      // Fixation is entered only after Slack's ack. Retain ownership even
      // when startup recover uses allSettled and this was the only message
      //. No later item can pass this unfixed head.
      if (current(life)) {
        const retry = old ?? { step: 0 }
        const spacing = deps.retryBackoffMs ?? RETYPE_BACKOFF_MS
        retry.timer = clock.setTimeout(() => { retry.timer = undefined; void prepare(key, item).catch(() => {}) }, spacing[Math.min(retry.step++, spacing.length - 1)]!)
        life.retries.set(seq, retry)
      }
      throw error
    }).finally(() => { life.inFlight.delete(seq); running.delete(work) })
    life.inFlight.set(seq, work)
    running.add(work)
    try { deps.onPending?.(key) } catch { /* ownership notification cannot undo accepted work */ }
    return work
  }
  const api: DeliveryPreparation = {
    owns: (key, seq) => { const life = lives.get(key); return life !== undefined && (life.inFlight.has(seq) || life.retries.has(seq)) },
    prepare,
    async recover(keys = deps.queue.keys()) {
      await Promise.allSettled(keys.flatMap(key => deps.queue.items(key).filter(item => !isQueueItemClosed(item)).map(item => prepare(key, item))))
    },
    async reclaim(keys) {
      await Promise.allSettled(keys.flatMap(key => {
        lifeOf(key)
        const seqs = claimed.get(key)
        return deps.queue.items(key)
          .filter(item => !isQueueItemClosed(item) && (item.fixed !== undefined || seqs?.has(item.accepted.seq) === true))
          .map(item => prepare(key, item))
      }))
    },
    async accept(key, input) {
      lifeOf(key)
      const result = await deps.queue.accept(key, input)
      if (result.status !== 'failed' && result.item) {
        const item = result.item
        // Yield through the caller's HTTP answer/cron outcome before reporting
        // or preparing. Past it the item is claimed even when a forget ended
        // the accepting life; the key's current life, if any, prepares it.
        clock.setTimeout(() => {
          if (stopped) return
          claim(key, item.accepted.seq)
          const life = lives.get(key)
          if (life && current(life)) void prepare(key, item).catch(() => {})
        }, 0)
      }
      return result
    },
    forget(key) {
      channels.delete(key)
      const life = lives.get(key)
      if (!life) return
      life.ended = true
      lives.delete(key)
      for (const retry of life.retries.values()) if (retry.timer !== undefined) clock.clearTimeout(retry.timer)
    },
    async stop() {
      stopped = true
      for (const life of lives.values()) {
        for (const retry of life.retries.values()) if (retry.timer !== undefined) clock.clearTimeout(retry.timer)
        life.retries.clear()
      }
      await Promise.allSettled([...running])
      lives.clear()
      claimed.clear()
    },
  }
  return api
}
