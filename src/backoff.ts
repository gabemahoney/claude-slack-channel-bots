/**
 * backoff.ts — Per-channel consecutive-failure counter with exponential backoff.
 *
 * Pure module: no imports from server, session-manager, or restart.
 * No timers, no I/O, no import-time side effects.
 * State is in-process only — lost on server restart by design (restart
 * re-runs startup reconcile, which gives each channel a fresh attempt).
 *
 * SPDX-License-Identifier: MIT
 */

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

/** Consecutive failure count per channelId. */
const failureCounts = new Map<string, number>()

/**
 * Cap-notified latch per channelId.
 * true once the cap-transition message has been sent for the current episode;
 * cleared by recordSuccess() or _resetBackoffState().
 */
const capNotified = new Map<string, boolean>()

// ---------------------------------------------------------------------------
// recordFailure
// ---------------------------------------------------------------------------

/**
 * Increment the consecutive-failure counter for channelId.
 * Returns the new count (post-increment).
 */
export function recordFailure(channelId: string): number {
  const prev = failureCounts.get(channelId) ?? 0
  const next = prev + 1
  failureCounts.set(channelId, next)
  return next
}

// ---------------------------------------------------------------------------
// recordSuccess
// ---------------------------------------------------------------------------

/**
 * Reset the consecutive-failure counter and the cap-notified latch for
 * channelId. Called on any successful spawn/resume/launch or successful
 * send-keys reconnect.
 */
export function recordSuccess(channelId: string): void {
  failureCounts.delete(channelId)
  capNotified.delete(channelId)
}

// ---------------------------------------------------------------------------
// getFailureCount
// ---------------------------------------------------------------------------

/**
 * Return the current consecutive-failure count for channelId (0 if none).
 */
export function getFailureCount(channelId: string): number {
  return failureCounts.get(channelId) ?? 0
}

// ---------------------------------------------------------------------------
// nextBackoffDelay
// ---------------------------------------------------------------------------

/**
 * Compute the next backoff delay using the PRE-failure count (i.e., the count
 * before the most recent recordFailure call).
 *
 * Formula: min(baseDelaySeconds * 2^preFailureCount, 900)
 *
 * Delay ladder for base=60, preFailureCounts 0..5:
 *   0 → 60s
 *   1 → 120s
 *   2 → 240s
 *   3 → 480s
 *   4 → 900s  (960 clamped)
 *   5 → 900s  (1920 clamped)
 */
export function nextBackoffDelay(channelId: string, baseDelaySeconds: number): number {
  const preCount = getFailureCount(channelId)
  const raw = baseDelaySeconds * Math.pow(2, preCount)
  return Math.min(raw, 900)
}

// ---------------------------------------------------------------------------
// isAtCap
// ---------------------------------------------------------------------------

/**
 * Returns true when channelId has reached or exceeded cap consecutive failures.
 */
export function isAtCap(channelId: string, cap: number): boolean {
  return getFailureCount(channelId) >= cap
}

// ---------------------------------------------------------------------------
// shouldNotifyCap
// ---------------------------------------------------------------------------

/**
 * Returns true exactly once per episode when the cap is reached — on the
 * transition to cap failures. Subsequent calls for the same episode return
 * false (latched). The latch is cleared by recordSuccess() or
 * _resetBackoffState().
 *
 * Callers should check isAtCap first; this function latches only at/above cap
 * — below cap it returns false early without setting the latch. In normal usage
 * it is called only when isAtCap returns true.
 */
export function shouldNotifyCap(channelId: string, cap: number): boolean {
  if (getFailureCount(channelId) < cap) return false
  if (capNotified.get(channelId)) return false
  capNotified.set(channelId, true)
  return true
}

// ---------------------------------------------------------------------------
// _resetBackoffState — test hook
// ---------------------------------------------------------------------------

/**
 * Clear all per-channel state. Mirrors _resetRestartState() in restart.ts.
 * Use only in tests (beforeEach cleanup).
 */
export function _resetBackoffState(): void {
  failureCounts.clear()
  capNotified.clear()
}
