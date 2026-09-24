/**
 * persona-retry-schedule.ts — The per-persona retry backoff schedule
 * (b.av2 SR-3.2).
 *
 * A Slack-unreachable persona is retried with backoff starting at 5 s and
 * doubling to a 300 s ceiling, with no cap, until Slack answers. A wait after
 * rate limiting is never shorter than the error's `retryAfter`. The same
 * policy is reused for Socket Mode reopen attempts after the first immediate
 * one (SR-3.3), directory-broken re-checks (SR-6.4) and destination-failure
 * retries (SR-7.1).
 *
 * Each caller creates its own schedule (one per persona and retry purpose)
 * with `createPersonaRetrySchedule`; a schedule holds only its own failure
 * count. There is no module-scope state, so nothing spans two personas
 * (SR-3.3), and `backoff.ts`'s per-channel counters and cap are not used —
 * only its stateless `doublingBackoffDelay` arithmetic.
 *
 * The schedule returns waits; it creates no timers and reads no clock.
 * Scheduling the wait is the caller's job, through its injected timers
 * (b.av2 SR-13.1).
 *
 * SPDX-License-Identifier: MIT
 */

import { doublingBackoffDelay } from './backoff.ts'

// ---------------------------------------------------------------------------
// SR-3.2 constants
// ---------------------------------------------------------------------------

/** First retry wait, in seconds (b.av2 SR-3.2). */
export const PERSONA_RETRY_BASE_S = 5

/** Retry wait ceiling, in seconds (b.av2 SR-3.2). There is no attempt cap. */
export const PERSONA_RETRY_CEILING_S = 300

/**
 * Largest delay a JavaScript timer honours, in milliseconds (2^31 − 1, about
 * 24.8 days); a longer `setTimeout` fires immediately. A `retryAfter` beyond
 * it is clamped here so an absurd value cannot become a tight retry loop.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** One caller's retry schedule. Independent of every other schedule. */
export interface PersonaRetrySchedule {
  /**
   * Record one failure and return the wait before the next attempt, in
   * milliseconds: 5, 10, 20, 40, 80, 160, 300, 300 … s for consecutive
   * failures, never "give up". When `retryAfterSeconds` (as carried by a
   * Slack-unreachable outcome) is a finite non-negative number, the wait is
   * the larger of the backoff delay and it, clamped to `MAX_TIMER_DELAY_MS`;
   * any other value is ignored. Rate limiting advances the count like any
   * other failure.
   */
  nextDelayMs(retryAfterSeconds?: number): number
  /** Return to the first delay (5 s). Call when the cause clears (Slack answered). */
  reset(): void
  /** Consecutive failures recorded since creation or the last reset. */
  readonly failures: number
}

/** Create an independent retry schedule following the b.av2 SR-3.2 policy. */
export function createPersonaRetrySchedule(): PersonaRetrySchedule {
  let failures = 0
  return {
    nextDelayMs(retryAfterSeconds?: number): number {
      const backoffMs = doublingBackoffDelay(PERSONA_RETRY_BASE_S, failures, PERSONA_RETRY_CEILING_S) * 1000
      failures += 1
      if (
        typeof retryAfterSeconds !== 'number' ||
        !Number.isFinite(retryAfterSeconds) ||
        retryAfterSeconds < 0
      ) {
        return backoffMs
      }
      return Math.min(Math.max(backoffMs, retryAfterSeconds * 1000), MAX_TIMER_DELAY_MS)
    },
    reset(): void {
      failures = 0
    },
    get failures(): number {
      return failures
    },
  }
}
