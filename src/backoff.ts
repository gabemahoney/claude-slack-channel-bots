/**
 * backoff.ts — Per-channel consecutive-failure counter with exponential backoff.
 *
 * Pure module: no imports from server, session-manager, or restart.
 * No timers, no I/O, no import-time side effects.
 * State is in-process only — lost on server restart by design (restart
 * re-runs startup reconcile, which gives each channel a fresh attempt).
 *
 * The delay arithmetic itself is exported statelessly as
 * `doublingBackoffDelay`, for callers that hold their own attempt count.
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
  return doublingBackoffDelay(baseDelaySeconds, getFailureCount(channelId), RESTART_BACKOFF_CEILING_S)
}

/** Ceiling of the restart backoff ladder (`nextBackoffDelay`), in seconds. */
const RESTART_BACKOFF_CEILING_S = 900

// ---------------------------------------------------------------------------
// doublingBackoffDelay — pure delay arithmetic
// ---------------------------------------------------------------------------

/**
 * Pure delay arithmetic: `base` doubled once per prior attempt, clamped to
 * `ceiling`, i.e. `min(base * 2^priorAttempts, ceiling)`. Unit-agnostic: the
 * result is in whatever unit `base` and `ceiling` are given in.
 *
 * Holds no state, so a caller that keeps its own attempt count (for example
 * a per-persona retry schedule, b.av2 SR-3.2) can reuse it without touching
 * this module's per-channel counters.
 *
 * Overflow-safe for a positive `base` and a finite `ceiling`: once
 * `2^priorAttempts` overflows to `Infinity` the product is `Infinity` and
 * the clamp returns `ceiling`, so any non-negative count (10 000 included)
 * yields a finite value.
 *
 * Ladder for base=5, ceiling=300, priorAttempts 0..7:
 *   5, 10, 20, 40, 80, 160, 300, 300
 */
export function doublingBackoffDelay(base: number, priorAttempts: number, ceiling: number): number {
  const raw = base * Math.pow(2, priorAttempts)
  return Math.min(raw, ceiling)
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
