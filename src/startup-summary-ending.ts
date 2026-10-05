/**
 * startup-summary-ending.ts — The start summary line's ending, from the failed
 * count on (b.f2b, b.jg5 SRJ-1015, SRJ-1111).
 *
 * Callers:
 * - `src/session-manager.ts` ends `startupSummaryLine` with
 *   `startupSummaryEnding` and re-exports it and its counts type, so its
 *   exports are unchanged;
 * - `ci-live/checks/helpers.ts` builds the /ci-live checks' expected clean and
 *   retried start-summary endings (`START_SUMMARY_END`, `checkStartLines`)
 *   from it.
 *
 * This module imports nothing, and must stay so: the /ci-live runner loads it
 * on the host, where importing `src/session-manager.ts` would load the
 * agent-director client and `bun:sqlite`.
 *
 * SPDX-License-Identifier: MIT
 */

/** The counts the start summary line's ending reports (`startupSummaryEnding`). */
export interface StartupSummaryEndingCounts {
  failed: number
  notBroughtUp: number
  notReconnected: number
  latched: number
  retrying: number
  sequenceWaiting: number
  held: number
  freshRetired: number
}

/**
 * The start summary line's ending, from `failed` on (b.f2b, b.jg5 SRJ-1015):
 * `<n> failed, <n> not brought up, <n> not reconnected`, then SRJ-1015's
 * five counts in its order and words: `, <n> latched, <n> retrying, <n>
 * waiting on a live-row sequence, <n> held on invalid flags, <n> fresh as
 * retired keys`.
 */
export function startupSummaryEnding(counts: StartupSummaryEndingCounts): string {
  return (
    `${counts.failed} failed, ${counts.notBroughtUp} not brought up, ${counts.notReconnected} not reconnected, ` +
    `${counts.latched} latched, ${counts.retrying} retrying, ${counts.sequenceWaiting} waiting on a live-row sequence, ` +
    `${counts.held} held on invalid flags, ${counts.freshRetired} fresh as retired keys`
  )
}
