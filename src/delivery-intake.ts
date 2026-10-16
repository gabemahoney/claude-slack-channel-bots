/** Post-accept immutable fixation shared by fresh and recovered work (b.omv SR-2.5/4). */
import type { WebClient } from '@slack/web-api'
import type { DeliveryQueue, QueueAccept, QueueItem, QueueEvent } from './delivery-queue.ts'
import { buildTagParts, NAME_LOOKUP_TIMEOUT_MS, type TagMessage } from './tag-wrapper.ts'
import { sanitizeFilename } from './lib.ts'
import { RETYPE_BACKOFF_MS } from './delivery-constants.ts'
export interface DeliveryPreparationClock {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}
export interface DeliveryPreparationDeps {
  queue: DeliveryQueue
  resolveUserName(key: string, user: string): Promise<string>
  clientFor(key: string): WebClient | undefined
  /** E3 binds this; E2's production binding is inert. Fixed is durable before this call. */
  wake?(key: string): void | Promise<void>
  /** Post-ack ownership starts E3 even when fixation must retry. */
  onPending?(key: string): void
  onEvent?(event: QueueEvent): void
  lookupTimeoutMs?: number
  clock?: DeliveryPreparationClock
  retryBackoffMs?: readonly number[]
}
export interface DeliveryPreparation {
  /** True only after post-ack preparation or explicit startup recovery owns it. */
  owns(key: string, seq: number): boolean
  prepare(key: string, item: QueueItem): Promise<void>
  recover(keys?: readonly string[]): Promise<void>
  /** Injected intake only; Slack uses queue.accept then calls prepare after its ack. */
  accept: QueueAccept
  forget(key: string): void
  stop(): Promise<void>
}
export function createDeliveryPreparation(deps: DeliveryPreparationDeps): DeliveryPreparation {
  const channels = new Map<string, Map<string, Promise<string>>>()
  const inFlight = new Map<string, Promise<void>>()
  const retries = new Map<string, { key: string; item: QueueItem; step: number; timer?: unknown }>()
  const fixedParts = new Map<string, string[]>()
  let stopped = false
  const timeout = deps.lookupTimeoutMs ?? NAME_LOOKUP_TIMEOUT_MS
  const clock: DeliveryPreparationClock = deps.clock ?? {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
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
  async function fix(key: string, item: QueueItem): Promise<void> {
    item = deps.queue.items(key).find(i => i.accepted.seq === item.accepted.seq) ?? item
    if (stopped || item.delivered) return
    if (!item.fixed) {
      const a = item.accepted, id = `${key}:${a.seq}`
      let parts = fixedParts.get(id)
      if (!parts) {
        let message: TagMessage
        if (a.source !== 'slack') message = { user: a.sender, ts: a.ts, text: a.text }
        else {
          const [user, channel_name] = await Promise.all([
            a.user ? bounded(() => deps.resolveUserName(key, a.user!), a.user) : Promise.resolve(a.username || a.bot_profile_name || a.bot_id || 'unknown'),
            channelName(key, a.channel!, a.channel_type),
          ])
          message = { chat_id: a.channel, channel_name, message_id: a.ts, user, ts: a.ts, thread_ts: a.thread_ts, via: a.via, text: a.text }
          if (a.user) message.user_id = a.user
          else if (a.bot_id) message.bot_id = a.bot_id
          if (a.files?.length) {
            message.attachment_count = String(a.files.length)
            message.attachments = a.files.map(f => `${sanitizeFilename(f.name || 'unnamed')} (${f.mimetype || 'unknown'}, ${f.size || '?'} bytes)`).join('; ')
          }
        }
        parts = buildTagParts(message)
        fixedParts.set(id, parts)
      }
      await deps.queue.append(key, { v: 1, kind: 'fixed', seq: a.seq, parts })
      fixedParts.delete(id)
    }
    if (!stopped) await deps.wake?.(key)
  }
  function prepare(key: string, item: QueueItem): Promise<void> {
    const id = `${key}:${item.accepted.seq}`
    const existing = inFlight.get(id)
    if (existing) return existing
    const old = retries.get(id)
    if (old?.timer !== undefined) return Promise.resolve()
    const work = fix(key, item).then(() => {
      retries.delete(id)
    }).catch(error => {
      // Fixation is entered only after Slack's ack. Retain ownership even
      // when startup recover uses allSettled and this was the only message
      // (b.omv SR-3.3/4.1/5.1). No later item can pass this unfixed head.
      if (!stopped) {
        const retry = old ?? { key, item, step: 0 }
        const spacing = deps.retryBackoffMs ?? RETYPE_BACKOFF_MS
        retry.timer = clock.setTimeout(() => { retry.timer = undefined; void prepare(key, item).catch(() => {}) }, spacing[Math.min(retry.step++, spacing.length - 1)]!)
        retries.set(id, retry)
      }
      throw error
    }).finally(() => { inFlight.delete(id) })
    inFlight.set(id, work)
    try { deps.onPending?.(key) } catch { /* ownership notification cannot undo accepted work */ }
    return work
  }
  const api: DeliveryPreparation = {
    owns: (key, seq) => inFlight.has(`${key}:${seq}`) || retries.has(`${key}:${seq}`),
    prepare,
    async recover(keys = deps.queue.keys()) {
      await Promise.allSettled(keys.flatMap(key => deps.queue.items(key).filter(item => !item.delivered).map(item => prepare(key, item))))
    },
    async accept(key, input) {
      const result = await deps.queue.accept(key, input)
      if (result.status !== 'failed' && result.item) void prepare(key, result.item).catch(() => { /* queue emits append-failed; acceptance remains durable */ })
      return result
    },
    forget(key) { channels.delete(key); for (const [id, retry] of retries) if (retry.key === key) { if (retry.timer !== undefined) clock.clearTimeout(retry.timer); retries.delete(id) } },
    async stop() { stopped = true; for (const retry of retries.values()) if (retry.timer !== undefined) clock.clearTimeout(retry.timer); retries.clear(); await Promise.allSettled([...inFlight.values()]); fixedParts.clear() },
  }
  return api
}
