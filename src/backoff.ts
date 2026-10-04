/**
 * backoff.ts — Per-persona session-restart failure counter with exponential backoff.
 *
 * The session-restart counters (900 s ceiling, 5-failure cap) are keyed by
 * persona key (b.av2 SR-6.3). They are separate from the persona Slack-retry
 * schedule in `src/persona-retry-schedule.ts`: both are per persona, but they
 * count different things and share no state.
 *
 * Pure module: no imports from server, session-manager, or restart.
 * No timers, no I/O, no import-time side effects.
 * State is in-process only — lost on server restart by design (restart
 * re-runs startup reconcile, which gives each persona a fresh attempt).
 *
 * The delay arithmetic itself is exported statelessly as
 * `doublingBackoffDelay`, for callers that hold their own attempt count.
 *
 * SPDX-License-Identifier: MIT
 */

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

/** Consecutive session-restart failure count per persona key. */
const failureCounts = new Map<string, number>()

/**
 * Cap-notified latch per persona key.
 * true once the cap-transition message has been sent for the current episode;
 * cleared by recordSuccess() or _resetBackoffState().
 */
const capNotified = new Map<string, boolean>()

// ---------------------------------------------------------------------------
// recordFailure
// ---------------------------------------------------------------------------

/**
 * Increment the consecutive-failure counter for persona `key`.
 * Returns the new count (post-increment).
 */
export function recordFailure(key: string): number {
  const prev = failureCounts.get(key) ?? 0
  const next = prev + 1
  failureCounts.set(key, next)
  return next
}

// ---------------------------------------------------------------------------
// recordSuccess
// ---------------------------------------------------------------------------

/**
 * Reset the consecutive-failure counter and the cap-notified latch for
 * persona `key`. Called on any successful spawn/resume/launch or successful
 * send-keys reconnect.
 */
export function recordSuccess(key: string): void {
  forgetFailures(key)
}

// ---------------------------------------------------------------------------
// forgetFailures
// ---------------------------------------------------------------------------

/**
 * Forget persona `key`'s consecutive-failure count and cap-notified latch
 * (b.av2 SR-6.5, a teardown; b.jg5 SRJ-509, a clear by hand that clears the
 * persona's latch): the same reset as `recordSuccess`, but not a success. No
 * other persona's state changes; logs and posts nothing.
 */
export function forgetFailures(key: string): void {
  failureCounts.delete(key)
  capNotified.delete(key)
}

// ---------------------------------------------------------------------------
// getFailureCount
// ---------------------------------------------------------------------------

/**
 * Return the current consecutive-failure count for persona `key` (0 if none).
 */
export function getFailureCount(key: string): number {
  return failureCounts.get(key) ?? 0
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
export function nextBackoffDelay(key: string, baseDelaySeconds: number): number {
  return doublingBackoffDelay(baseDelaySeconds, getFailureCount(key), RESTART_BACKOFF_CEILING_S)
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
 * this module's session-restart counters.
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
 * Returns true when persona `key` has reached or exceeded cap consecutive failures.
 */
export function isAtCap(key: string, cap: number): boolean {
  return getFailureCount(key) >= cap
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
export function shouldNotifyCap(key: string, cap: number): boolean {
  if (getFailureCount(key) < cap) return false
  if (capNotified.get(key)) return false
  capNotified.set(key, true)
  return true
}

// ---------------------------------------------------------------------------
// _resetBackoffState — test hook
// ---------------------------------------------------------------------------

/**
 * Clear all per-persona state. Mirrors _resetRestartState() in restart.ts.
 * Use only in tests (beforeEach cleanup).
 */
export function _resetBackoffState(): void {
  failureCounts.clear()
  capNotified.clear()
}
