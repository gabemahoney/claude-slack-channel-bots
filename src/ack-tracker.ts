/**
 * Per-persona Slack acknowledgement lifecycle (b.p3h).
 * Durable acceptance requests queued; durable final receipts request delivered.
 * Each message serializes only its own Slack mutations, independently of delivery.
 * Replies and teardown cancel pending stages synchronously and clean up the
 * captured reaction/client after outstanding mutations settle.
 *
 * SPDX-License-Identifier: MIT
 */
import type { DeliveryQueue, QueueItem } from './delivery-queue.ts'

export const EARLY_REPLY_EXPIRY_MS = 24 * 60 * 60 * 1000
const ACK_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000

type Stage = 'queued' | 'delivered'
interface Identity { personaKey: string; createdAt: number }
interface AckEntry extends Identity {
  answered: boolean
  legacy: boolean
  pending: number
  delivered?: boolean
  stages: Partial<Record<Stage, Promise<void>>>
}
interface Reaction {
  name?: string
  prepare?(): Promise<boolean>
  add(): Promise<unknown>
  remove(): Promise<unknown>
  mayHaveApplied?(error: unknown): boolean
}
interface AckSlot {
  entry?: AckEntry
  visible?: Reaction & { owner: AckEntry; unconfirmed?: boolean }
  tail?: Promise<void>
}
export interface DeliveryAckDeps {
  getReaction(): string | undefined
  /** Production supplies the queue for adopting older accepted records. */
  queue?: Pick<DeliveryQueue, 'rememberQueuedReaction'>
  clientFor(key: string): {
    reactions: {
      add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>
      remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>
    }
  } | undefined
}

const slots = new Map<string, AckSlot>()
const successfulReplies = new Map<string, Identity>()
const makeKey = (personaKey: string, channelId: string, messageTs: string) => JSON.stringify([personaKey, channelId, messageTs])
const newEntry = (personaKey: string, legacy = false): AckEntry => ({ personaKey, createdAt: Date.now(), answered: false, legacy, pending: 0, stages: {} })
function slotFor(key: string): AckSlot {
  let slot = slots.get(key)
  if (!slot) { slot = {}; slots.set(key, slot) }
  return slot
}

/** Keep the mutation chain across teardown/re-add so old cleanup cannot remove
 * a new life's reaction. Failed removal stays visible and blocks replacement. */
function serialize(key: string, slot: AckSlot, run: () => Promise<void>): Promise<void> {
  const work = (slot.tail ?? Promise.resolve()).then(run).catch(() => {}).finally(() => {
    if (slot.tail === work) slot.tail = undefined
    if (!slot.tail && !slot.entry && !slot.visible && slots.get(key) === slot) slots.delete(key)
  })
  slot.tail = work
  return work
}
async function removeVisible(slot: AckSlot): Promise<boolean> {
  const reaction = slot.visible
  if (!reaction) return true
  try { await reaction.remove() } catch { return false }
  slot.visible = undefined
  return true
}
function cleanup(key: string, slot: AckSlot, entry: AckEntry): Promise<void> {
  return serialize(key, slot, async () => {
    if (slot.visible?.owner === entry) await removeVisible(slot)
  })
}
function pruneExpired(): void {
  const now = Date.now()
  for (const [key, reply] of successfulReplies) if (reply.createdAt < now - EARLY_REPLY_EXPIRY_MS) successfulReplies.delete(key)
  for (const [key, slot] of slots) {
    const entry = slot.entry
    if (entry && !slot.tail && entry.createdAt < now - ACK_EXPIRY_MS) {
      slot.entry = undefined
      void cleanup(key, slot, entry)
    }
  }
}

function restoreQueued(key: string, personaKey: string, priorQueued?: Reaction): AckSlot {
  const slot = slotFor(key)
  if (!slot.entry) {
    slot.entry = newEntry(personaKey)
    // Intent is durable; Slack success is not. Retain possible ownership even
    // before a usable client exists, so a correlated reply can clean it up.
    if (!slot.visible && priorQueued) slot.visible = { ...priorQueued, owner: slot.entry, unconfirmed: true }
    if (successfulReplies.has(key)) slot.entry.answered = true
  }
  return slot
}

function addStage(personaKey: string, channelId: string, messageTs: string, stage: Stage, reaction: Reaction, priorQueued?: Reaction): Promise<void> {
  pruneExpired()
  const key = makeKey(personaKey, channelId, messageTs)
  if (successfulReplies.has(key) && !priorQueued) return Promise.resolve()
  const slot = restoreQueued(key, personaKey, priorQueued), entry = slot.entry!
  if (stage === 'delivered') entry.delivered = true
  if (entry.answered) return cleanup(key, slot, entry)
  if (entry.stages[stage]) return entry.stages[stage]!
  // A delayed acceptance notification must never downgrade delivery.
  if (stage === 'queued' && entry.delivered) return entry.stages.delivered ?? Promise.resolve()
  entry.pending++
  const live = () => slot.entry === entry && !entry.answered
  const work = serialize(key, slot, async () => {
    let established = false
    try {
      if (!live()) return
      if (reaction.prepare && !await reaction.prepare()) return
      if (!live()) return
      const sameReaction = slot.visible?.owner === entry && reaction.name !== undefined && slot.visible.name === reaction.name
      if (sameReaction && !slot.visible!.unconfirmed) { established = true; return }
      if (!sameReaction && slot.visible && !await removeVisible(slot)) return
      if (!live()) return
      try {
        await reaction.add()
        slot.visible = { ...reaction, owner: entry }
        established = true
      } catch (error) {
        // A lost HTTP response is not proof the add failed. Require removal
        // before another stage, even when Slack may not have applied this one.
        if (reaction.mayHaveApplied?.(error)) slot.visible = { ...reaction, owner: entry, unconfirmed: true }
      }
      // A reply/teardown can arrive during add, including in the same millisecond.
      if (!live()) await removeVisible(slot)
    } finally {
      entry.pending--
      // A rejected queued add (or legacy metadata write) must remain retryable.
      // Keep delivered intent even on failure, so queued cannot downgrade it.
      if (stage === 'queued' && !established && entry.stages.queued === work) delete entry.stages.queued
    }
  })
  entry.stages[stage] = work
  return work
}

function platformError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined
  const data = error.data
  return typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string' ? data.error : undefined
}
function slackReaction(web: NonNullable<ReturnType<DeliveryAckDeps['clientFor']>>, channel: string, timestamp: string, name: string): Reaction {
  const args = { channel, timestamp, name }
  return {
    name,
    add: async () => {
      try { await web.reactions.add(args) } catch (error) { if (platformError(error) !== 'already_reacted') throw error }
    },
    remove: async () => {
      try { await web.reactions.remove(args) } catch (error) { if (platformError(error) !== 'no_reaction') throw error }
    },
    mayHaveApplied: error => typeof error === 'object' && error !== null && 'code' in error &&
      (error.code === 'slack_webapi_request_error' || error.code === 'slack_webapi_http_error'),
  }
}
function createAckCallback(deps: DeliveryAckDeps, stage: Stage): (key: string, item: QueueItem) => Promise<void> {
  return async (key, item) => {
    const accepted = item.accepted
    const queuedName = accepted.queued_ack_reaction
    const name = stage === 'queued' ? queuedName ?? deps.getReaction() : deps.getReaction()
    if (accepted.source !== 'slack' || !accepted.channel || !name || (stage === 'delivered' ? !item.delivered : item.delivered)) return
    const web = deps.clientFor(key)
    const prior: Reaction | undefined = queuedName ? {
      name: queuedName,
      add: async () => {},
      remove: async () => {
        const owner = web ?? deps.clientFor(key)
        if (!owner) throw new Error('Reaction client unavailable')
        await slackReaction(owner, accepted.channel!, accepted.ts, queuedName).remove()
      },
    } : undefined
    if (!web) {
      if (prior) {
        pruneExpired()
        const slot = restoreQueued(makeKey(key, accepted.channel, accepted.ts), key, prior)
        if (stage === 'delivered') slot.entry!.delivered = true
      }
      return
    }
    const reaction = slackReaction(web, accepted.channel, accepted.ts, name)
    if (stage === 'queued' && !queuedName && deps.queue) {
      // Only older journals need a rewrite. New intake persists this name in
      // its existing acceptance write, before reporting can call Slack.
      reaction.prepare = async () => {
        const stored = await deps.queue!.rememberQueuedReaction(key, accepted.seq, name)
        if (!stored) return false
        Object.assign(reaction, slackReaction(web, accepted.channel!, accepted.ts, stored))
        return true
      }
    }
    await addStage(key, accepted.channel, accepted.ts, stage, reaction, prior)
  }
}

export const createQueuedAckCallback = (deps: DeliveryAckDeps) => createAckCallback(deps, 'queued')
export const createDeliveryAckCallback = (deps: DeliveryAckDeps) => createAckCallback(deps, 'delivered')

/** Compatibility for callers that supply their own Slack mutation closures. */
export function addDeliveryAck(personaKey: string, channelId: string, messageTs: string, add: () => Promise<unknown>, remove: () => Promise<unknown>): Promise<void> {
  return addStage(personaKey, channelId, messageTs, 'delivered', { add, remove })
}

/** Legacy manually tracked entries have no captured reaction. Production uses
 * the stage callbacks, which always retain the actual emoji and owning client. */
export function trackAck(personaKey: string, channelId: string, messageTs: string): void {
  pruneExpired()
  slotFor(makeKey(personaKey, channelId, messageTs)).entry = newEntry(personaKey, true)
}

export function consumeAck(personaKey: string, channelId: string, messageTs: string): boolean
export function consumeAck(personaKey: string, channelId: string, messageTs: string, removeLegacy: () => Promise<unknown>): Promise<void>
/** Called only after a successful reply post/upload. Cancel future stages now;
 * cleanup stays serialized but the reply tool must not wait for Slack reactions.
 * The fallback closure is used exclusively for legacy trackAck entries. */
export function consumeAck(personaKey: string, channelId: string, messageTs: string, removeLegacy?: () => Promise<unknown>): boolean | Promise<void> {
  pruneExpired()
  const key = makeKey(personaKey, channelId, messageTs), slot = slots.get(key), entry = slot?.entry
  successfulReplies.set(key, { personaKey, createdAt: Date.now() })
  let consumed = false, work = Promise.resolve()
  if (slot && entry && !entry.answered) {
    consumed = entry.legacy || entry.pending > 0 || slot.visible?.owner === entry
    entry.answered = true
    work = entry.legacy && removeLegacy
      ? serialize(key, slot, async () => { await removeLegacy() })
      : cleanup(key, slot, entry)
  }
  return removeLegacy ? work : consumed
}

export function forgetPersonaAcks(personaKey: string): void {
  for (const [key, reply] of successfulReplies) if (reply.personaKey === personaKey) successfulReplies.delete(key)
  for (const [key, slot] of slots) {
    const entry = slot.entry
    if (entry?.personaKey === personaKey) {
      slot.entry = undefined
      void cleanup(key, slot, entry)
    }
  }
}

/** Test isolation; cancel in-flight work before dropping its slots. */
export function _resetAckTracker(): void {
  for (const slot of slots.values()) slot.entry = undefined
  slots.clear()
  successfulReplies.clear()
}
