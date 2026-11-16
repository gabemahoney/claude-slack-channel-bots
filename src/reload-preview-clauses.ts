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

export const RECOVERY_LOSS = 'Explicit replacement: prior authority history is unprovable. Numeric continuity is not claimed; every listed choice and persona lifetime is new. Lost preference, participation, leave and attempt history has unknown scope; lost attempt outcomes remain unresolved.'
export const RECOVERY_RESTORE = 'Restore the owning process\'s latest validated state and retained order, identities, leave boundaries and attempt history. No external or older snapshot supplies restoration authority.'
/** Ends a restored or new `thread_hybrid` choice line: recovery starts a new Thread Hybrid Since. */
export const RECOVERY_THREADS_FORGOTTEN = 'Joined Threads forgotten, not restored.'
export const RECOVERY_CURRENT_MEMBERSHIP = 'Historical membership is unverified. Current authenticated membership is required before dependent intake or any recovery-complete claim; missing root/share/eligibility facts remain unresolved.'
export const RECOVERY_PRESERVATION = 'Damaged evidence and prepared input are preserved; accepted queues stay under their original keys. Repair never retries an unknown or proven-not-applied assignment. Finite Slack retries cannot guarantee recovery of never-accepted events.'
export const REVIEW_ABSENCE_REPLACEMENT = 'Explicit replacement of unresolved absence order: retain the historical conflict, apply its removal boundary, then this new preference. Old participation is lost with unknown scope; current membership must be reverified. Accepted queues and historical attempt outcomes are retained.'
