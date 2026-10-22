/**
 * reload-preview-clauses.ts — The fixed clauses of the reload preview's
 * retiring lines.
 *
 * Every preview line that retires a persona (a removal or a destructive
 * modify) starts with `DESTRUCTIVE_PREFIX` and says what the confirmation
 * does to the persona in one of the two retired clauses below.
 *
 * Callers:
 * - `src/reload-plan.ts` builds `removedLine` and `destructiveLine` from these
 *   and re-exports them, so its exports are unchanged;
 * - `ci-live/checks/helpers.ts` builds the /ci-live checks' expected removal
 *   lines (Checks 27 and 28) from them.
 *
 * This module imports nothing, and must stay so: the /ci-live runner loads it
 * on the host, where importing `src/reload-plan.ts` would load the Slack SDKs.
 *
 * SPDX-License-Identifier: MIT
 */

/** Start of every line that retires a persona: a removal or a destructive modify. */
export const DESTRUCTIVE_PREFIX = 'DESTRUCTIVE:'

/** What a removal's line says the confirmation does to the persona. */
export const REMOVED_RETIRED_CLAUSE = 'the persona will be retired: its session stopped and never resumed'

/** What a destructive modify's line says the confirmation does to the persona. */
export const DESTRUCTIVE_RETIRED_CLAUSE =
  'the persona will be retired and brought up fresh: its session stopped and never resumed'

/** retained work remains bound to its original key. */
export function queueRetentionClause(count: number): string {
  return `${count} open queued item${count === 1 ? '' : 's'} kept, delivered only if a persona with the same key is added again`
}

export const REVIEW_OMISSION_CLAUSE = 'Retained current choice; use an explicit off assignment to stop intake.'
export const REVIEW_FUTURE_CLAUSE = 'A new future preference grants neither membership nor participation.'
export const REVIEW_RESET_CLAUSE = 'Inherited preference resets with the old identity; old participation and membership are not retained.'
export const REVIEW_RETENTION_CLAUSE = 'Deliberate assignment to the replacement; no old participation or membership is retained.'
