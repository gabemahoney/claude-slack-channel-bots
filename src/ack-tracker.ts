/**
 * ack-tracker.ts — Tracks pending acknowledgement reactions by channel+message.
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

function makeKey(channelId: string, messageTs: string): string {
  return `${channelId}:${messageTs}`
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
 * Upsert an ack entry for the given channel+message, then prune entries
 * older than 30 days.
 */
export function trackAck(channelId: string, messageTs: string): void {
  const key = makeKey(channelId, messageTs)
  ackMap.set(key, { channelId, messageTs, createdAt: Date.now() })
  pruneExpired()
}

/**
 * Consume (delete) an ack entry. Returns true if the entry existed, false otherwise.
 */
export function consumeAck(channelId: string, messageTs: string): boolean {
  const key = makeKey(channelId, messageTs)
  if (!ackMap.has(key)) return false
  ackMap.delete(key)
  return true
}

/**
 * Reset all ack state. For test isolation only.
 */
export function _resetAckTracker(): void {
  ackMap.clear()
}
