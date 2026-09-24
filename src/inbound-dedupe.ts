/**
 * inbound-dedupe.ts — One persona's inbound dedupe store (b.av2 SR-4.1).
 *
 * A channel mention reaches a persona twice, as a `message` event and as an
 * `app_mention` event with the same ts, and Slack may redeliver an event (for
 * example after a Socket Mode reconnect). The store remembers each key for
 * `INBOUND_DEDUPE_RETENTION_MS` after its first sighting, so the persona's
 * pipeline handles each message once. The key is (conversation, ts), or
 * (conversation, ts, edit ts) for an event that carries an edit ts: an edit
 * keeps the message's ts, so the edit ts is what tells it apart from the
 * original and from other edits, and each distinct edit gets its own window.
 *
 * One store holds one persona's keys; it knows nothing about personas, Slack
 * or config, and the caller keeps one store per persona. It counts, limits and
 * throttles nothing: distinct keys are always new, however many arrive and
 * however fast (b.av2 SR-4.2).
 *
 * Memory stays bounded by lazy pruning: every `record` call first drops the
 * keys whose window has passed. The store starts no timer or interval.
 *
 * Side-effect free (b.av2 SR-13.1): importing this module creates no timer,
 * reads no file or environment variable and logs nothing. The clock is
 * injected, with `Date.now` as the default.
 *
 * SPDX-License-Identifier: MIT
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a key is remembered after its first sighting, in milliseconds (b.av2 SR-4.1: at least 10 minutes). */
export const INBOUND_DEDUPE_RETENTION_MS = 10 * 60 * 1000

/**
 * Separator between the parts of a stored key (conversation ID, ts, and the
 * edit ts when there is one); no Slack ID or ts contains it, so a two-part key
 * and a three-part key never collide.
 */
const KEY_SEPARATOR = '\u0000'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Outcome of recording one sighting:
 * - `new`: first sighting within the window; the key is now recorded.
 * - `duplicate`: the key was first seen less than the retention window ago.
 * - `unkeyable`: the conversation ID or the ts is missing, empty or not a
 *   string. Nothing is recorded; the caller handles the event as new.
 */
export type DedupeOutcome = 'new' | 'duplicate' | 'unkeyable'

/** One persona's dedupe store. Independent of every other store. */
export interface InboundDedupeStore {
  /**
   * Prune expired keys, then report whether the key is new, recording it when
   * it is. The key is (`conversationId`, `ts`, `editedTs`) when `editedTs` is a
   * non-empty string, and (`conversationId`, `ts`) otherwise. A duplicate does
   * not extend the key's window.
   */
  record(conversationId: unknown, ts: unknown, editedTs?: unknown): DedupeOutcome
  /** Number of keys currently retained (expired keys leave on the next `record`). */
  readonly size: number
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an empty dedupe store reading time from `now` (milliseconds; default `Date.now`). */
export function createInboundDedupeStore(now: () => number = Date.now): InboundDedupeStore {
  // Key → first-sighting time. Insertion order is first-sighting order, so the
  // expired keys are always at the front.
  const firstSeen = new Map<string, number>()

  function prune(at: number): void {
    for (const [key, seenAt] of firstSeen) {
      if (at - seenAt < INBOUND_DEDUPE_RETENTION_MS) return
      firstSeen.delete(key)
    }
  }

  return {
    record(conversationId: unknown, ts: unknown, editedTs?: unknown): DedupeOutcome {
      if (!isNonEmptyString(conversationId) || !isNonEmptyString(ts)) return 'unkeyable'
      const at = now()
      prune(at)
      const baseKey = conversationId + KEY_SEPARATOR + ts
      const key = isNonEmptyString(editedTs) ? baseKey + KEY_SEPARATOR + editedTs : baseKey
      if (firstSeen.has(key)) return 'duplicate'
      firstSeen.set(key, at)
      return 'new'
    },
    get size(): number {
      return firstSeen.size
    },
  }
}

/** True for a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}
