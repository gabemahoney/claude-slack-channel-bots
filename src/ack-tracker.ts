/**
 * ack-tracker.ts — Tracks pending acknowledgement reactions per persona.
 *
 * Each entry is keyed by (persona key, conversation ID, message ts) (b.av2
 * SR-4.5): a persona records an entry when it reacts to a message dispatched
 * to its instance, and only that persona's first reply carrying the message's
 * ts consumes it. Two personas that both reacted to one message in a shared
 * channel hold independent entries, and a persona that never reacted finds
 * nothing to consume. Entries older than 30 days are pruned on each record.
 * The persona teardown drops a removed persona's entries (`forgetPersonaAcks`),
 * so a key added again starts clean (b.av2 SR-6.5).
 *
 * Side-effect free: importing this module creates no Slack client, reads no
 * file or environment variable and logs nothing.
 *
 * Implements Task: t3.xrm.9d.ap.45
 *
 * SPDX-License-Identifier: MIT
 */

import type { QueueItem } from './delivery-queue.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EARLY_REPLY_EXPIRY_MS = 24 * 60 * 60 * 1000
const ACK_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000 // 30 days in milliseconds

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AckEntry {
  personaKey: string
  channelId: string
  messageTs: string
  createdAt: number
}

export interface DeliveryAckDeps {
  getReaction(): string | undefined
  clientFor(key: string): {
    reactions: {
      add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>
      remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>
    }
  } | undefined
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ackMap = new Map<string, AckEntry>()
const successfulReplies = new Map<string, AckEntry>()
const deliveryAdds = new Map<string, Promise<void>>()
const completedAdds = new Map<string, AckEntry>()

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * The map key for one triple: its JSON array encoding, which quotes and
 * escapes each component, so no separator character inside a persona key,
 * conversation ID or ts can make two different triples collide.
 */
function makeKey(personaKey: string, channelId: string, messageTs: string): string {
  return JSON.stringify([personaKey, channelId, messageTs])
}

function pruneExpired(): void {
  const now = Date.now()
  for (const [key, entry] of successfulReplies) if (entry.createdAt < now - EARLY_REPLY_EXPIRY_MS) successfulReplies.delete(key)
  for (const [key, entry] of completedAdds) if (entry.createdAt < now - ACK_EXPIRY_MS) completedAdds.delete(key)
  const cutoff = now - ACK_EXPIRY_MS
  for (const [key, entry] of ackMap) {
    if (entry.createdAt < cutoff) {
      ackMap.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Bind the delivery reporter to the current settings and receiving persona's client. */
export function createDeliveryAckCallback(deps: DeliveryAckDeps): (key: string, item: QueueItem) => Promise<void> {
  return async (key, item) => {
    const accepted = item.accepted, reaction = deps.getReaction()
    if (!item.delivered || accepted.source !== 'slack' || !accepted.channel || !reaction) return
    const web = deps.clientFor(key)
    if (!web) return
    const args = { channel: accepted.channel, timestamp: accepted.ts, name: reaction }
    await addDeliveryAck(key, args.channel, args.timestamp,
      () => web.reactions.add(args),
      () => web.reactions.remove(args))
  }
}

/**
 * Upsert persona `personaKey`'s ack entry for the given conversation and
 * message, then prune entries older than 30 days.
 */
export function trackAck(personaKey: string, channelId: string, messageTs: string): void {
  const key = makeKey(personaKey, channelId, messageTs)
  ackMap.set(key, { personaKey, channelId, messageTs, createdAt: Date.now() })
  pruneExpired()
}

/**
 * Consume (delete) persona `personaKey`'s ack entry for the given
 * conversation and message. Returns true if that persona's entry existed,
 * false otherwise; another persona's entry for the same message is untouched.
 */
export function consumeAck(personaKey: string, channelId: string, messageTs: string): boolean {
  pruneExpired()
  const key = makeKey(personaKey, channelId, messageTs)
  // Called only after Slack accepted a reply, including a reply preceding delivery.
  successfulReplies.set(key, { personaKey, channelId, messageTs, createdAt: Date.now() })
  if (!ackMap.has(key)) return false
  ackMap.delete(key)
  return true
}

/** Delivery-time add, with an in-flight reply removed again after the add settles.
 * Failures are deliberately non-critical to durable FIFO progress (b.omv SR-8.7). */
export function addDeliveryAck(personaKey: string, channelId: string, messageTs: string, add: () => Promise<unknown>, remove: () => Promise<unknown>): Promise<void> {
  pruneExpired()
  const key = makeKey(personaKey, channelId, messageTs)
  if (successfulReplies.has(key) || completedAdds.has(key)) return Promise.resolve()
  const pending = deliveryAdds.get(key)
  if (pending) return pending
  const entry: AckEntry = { personaKey, channelId, messageTs, createdAt: Date.now() }
  trackAck(personaKey, channelId, messageTs)
  const work = Promise.resolve().then(add).then(async () => {
    // A successful reply or teardown while add was pending must leave no reaction.
    if (successfulReplies.has(key) || ackMap.get(key) !== entry) {
      if (ackMap.get(key) === entry) ackMap.delete(key)
      try { await remove() } catch { /* non-critical */ }
    }
    if (successfulReplies.has(key) || ackMap.get(key) === entry) completedAdds.set(key, entry)
  }).catch(() => { if (ackMap.get(key) === entry) ackMap.delete(key) }).finally(() => {
    if (deliveryAdds.get(key) === work) deliveryAdds.delete(key)
  })
  // Use this exact entry as the generation token, including same-millisecond teardown.
  ackMap.set(key, entry)
  deliveryAdds.set(key, work)
  return work
}

/**
 * Drop every entry of persona `personaKey` (the persona teardown, b.av2
 * SR-6.5). Other personas' entries are untouched; a no-op for a key with no
 * entries. Logs nothing.
 */
export function forgetPersonaAcks(personaKey: string): void {
  for (const [key, entry] of successfulReplies) if (entry.personaKey === personaKey) successfulReplies.delete(key)
  for (const [key, entry] of completedAdds) if (entry.personaKey === personaKey) completedAdds.delete(key)
  for (const [key, entry] of ackMap) {
    if (entry.personaKey === personaKey) {
      ackMap.delete(key)
    }
  }
}

/**
 * Reset all ack state. For test isolation only.
 */
export function _resetAckTracker(): void {
  ackMap.clear()
  successfulReplies.clear()
  completedAdds.clear()
  deliveryAdds.clear()
}
