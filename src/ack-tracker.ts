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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ackMap = new Map<string, AckEntry>()

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
  const cutoff = Date.now() - ACK_EXPIRY_MS
  for (const [key, entry] of ackMap) {
    if (entry.createdAt < cutoff) {
      ackMap.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
  const key = makeKey(personaKey, channelId, messageTs)
  if (!ackMap.has(key)) return false
  ackMap.delete(key)
  return true
}

/**
 * Drop every entry of persona `personaKey` (the persona teardown, b.av2
 * SR-6.5). Other personas' entries are untouched; a no-op for a key with no
 * entries. Logs nothing.
 */
export function forgetPersonaAcks(personaKey: string): void {
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
}
