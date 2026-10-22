/** Durable review generations and one-time confirmation outcomes. This is
 * metadata in the existing shared authority, never a second store. */
import { createHash } from 'node:crypto'
import type { SharedChannelAuthority, SharedChannelState, SharedMutationResult } from './shared-channels.ts'
import { emptyOperatorIntent, type OperatorIntent } from './reload-request.ts'
import { type RetiredReviewRecovery, validateRetiredReviewRecovery } from './retired-keys.ts'
import { describeThrownValue } from './persona-connection-errors.ts'

export const RELOAD_REVIEW_RECOVERY = 'reload-review-recovery'
export const RELOAD_REVIEW_OUTCOME = 'reload-review-outcome'

export interface DurableReview {
  generation: number
  fingerprint: string
  binding: string
  sourceHash: string
  dependency: string
  intentGeneration: number
}
export interface ReviewOutcome {
  generation: number
  revision: number
  status: 'superseded' | 'attempted' | 'rejected' | 'consumed'
}
export interface ReviewLedger {
  generation: number
  /** Composite config/credentials/dependency hash only. Never a credential
   * digest, credential bytes, or message content. */
  observed: string
  active?: DurableReview
  outcomes: Record<string, ReviewOutcome>
  retirement?: { fingerprint: string; recovery: RetiredReviewRecovery }
}
const HASH = /^[a-f0-9]{64}$/
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function only(value: object, fields: readonly string[]): boolean {
  return Object.keys(value).every(field => fields.includes(field))
}
function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true })
}
export function reviewLedger(state: SharedChannelState): ReviewLedger | undefined {
  return Object.hasOwn(state.outcomes, 'operatorReviews') ? state.outcomes['operatorReviews'] as ReviewLedger : undefined
}
export function validateReviewLedger(value: unknown, revision: number): asserts value is ReviewLedger {
  if (!object(value) || !only(value, ['generation', 'observed', 'active', 'outcomes', 'retirement']) ||
      !Number.isSafeInteger(value['generation']) || (value['generation'] as number) < 1 || (value['generation'] as number) > revision ||
      typeof value['observed'] !== 'string' || !HASH.test(value['observed']) || !object(value['outcomes'])) throw new Error('Invalid durable review history.')
  const ledger = value as unknown as ReviewLedger
  for (const [fingerprint, result] of Object.entries(ledger.outcomes)) {
    if (!HASH.test(fingerprint) || !object(result) || Object.keys(result).length !== 3 || !['superseded', 'attempted', 'rejected', 'consumed'].includes(result.status) ||
        !Number.isSafeInteger(result.generation) || result.generation < 1 || result.generation > ledger.generation ||
        !Number.isSafeInteger(result.revision) || result.revision < 1 || result.revision > revision) throw new Error('Invalid durable review outcome.')
  }
  const active = ledger.active
  if (active && (!object(active) || Object.keys(active).length !== 6 || active.generation !== ledger.generation || !HASH.test(active.fingerprint) ||
      !HASH.test(active.sourceHash) || !HASH.test(active.dependency) ||
      !HASH.test(active.binding) || active.binding !== ledger.observed || !Number.isSafeInteger(active.intentGeneration) || active.intentGeneration < 0 ||
      reviewFingerprint(active.binding, active.generation) !== active.fingerprint)) throw new Error('Invalid active review identity.')
  if (ledger.retirement) {
    if (!object(ledger.retirement) || Object.keys(ledger.retirement).length !== 2 || ledger.outcomes[ledger.retirement.fingerprint]?.status !== 'attempted') throw new Error('Invalid review retirement recovery.')
    validateRetiredReviewRecovery(ledger.retirement.recovery)
  }
}
export function reviewFingerprint(binding: string, generation: number): string {
  return createHash('sha256').update(JSON.stringify(['cscb-review-v1', binding, generation])).digest('hex')
}
/** Metadata cannot invalidate itself. Assignment orders, membership histories,
 * readiness, declarations, destinations and applied mode remain dependencies. */
export function sharedReviewDependency(state: SharedChannelState): string {
  return createHash('sha256').update(JSON.stringify([
    state.sourceBytesBase64, state.applied, state.personas, state.retiredIdentities, state.recovery?.boundary,
  ])).digest('hex')
}
/** Each detection controller retains observed revocations until a new durable
 * generation supersedes them. Revalidation observes without writing metadata
 * inside an activation attempt. Restart uses a fresh review epoch. */
export function createReviewObserver() {
  let revocationDue = false
  return (authority: SharedChannelAuthority, binding: string, pending: boolean, intentGeneration: number, sourceHash: string, persist = true) => {
    const before = reviewLedger(authority.snapshot())
    if (before?.observed !== binding) revocationDue = true
    if (!persist) return { review: revocationDue ? undefined : before?.active }
    const observation = observeReview(authority, binding, pending, intentGeneration, sourceHash, revocationDue)
    if (observation.result?.kind === 'applied') revocationDue = false
    return observation
  }
}
/** Revoke a gesture in the same transaction that cancels or revises intent. */
export function supersedeReview(state: SharedChannelState, order: number): void {
  const ledger = reviewLedger(state)
  if (!ledger?.active) return
  if (!ledger.outcomes[ledger.active.fingerprint]) put(ledger.outcomes, ledger.active.fingerprint, {
    generation: ledger.active.generation, status: 'superseded', revision: order,
  })
  delete ledger.active
}
function observeReview(
  authority: SharedChannelAuthority, binding: string, pending: boolean, intentGeneration: number, sourceHash: string,
  revocationDue = false,
): { result?: SharedMutationResult; review?: DurableReview } {
  const before = reviewLedger(authority.snapshot())
  if (before?.retirement) return {}
  if (!revocationDue && before?.observed === binding && (!pending || (before.active && !before.outcomes[before.active.fingerprint]))) return { review: before.active }
  const generation = (before?.generation ?? 0) + 1
  const review: DurableReview | undefined = pending ? { generation, binding, sourceHash, dependency: sharedReviewDependency(authority.snapshot()), intentGeneration, fingerprint: reviewFingerprint(binding, generation) } : undefined
  const result = authority.transact(authority.revision, (next, order) => {
    const ledger: ReviewLedger = structuredClone(before ?? { generation: 0, observed: binding, outcomes: {} })
    if (ledger.active && !ledger.outcomes[ledger.active.fingerprint]) put(ledger.outcomes, ledger.active.fingerprint, {
      generation: ledger.active.generation, status: 'superseded', revision: order,
    })
    ledger.generation = generation
    ledger.observed = binding
    if (review) ledger.active = review
    else delete ledger.active
    put(next.outcomes, 'operatorReviews', ledger)
  })
  return { result, review: result.kind === 'applied' ? review : undefined }
}
export function reviewMatches(state: SharedChannelState, review: DurableReview, attempted = false): boolean {
  const ledger = reviewLedger(state)
  const outcome = ledger?.outcomes[review.fingerprint]
  const intent = (state.pendingIntent['operator'] as OperatorIntent | undefined) ?? emptyOperatorIntent()
  return ledger?.active?.fingerprint === review.fingerprint && ledger.active.binding === review.binding &&
    ledger.active.sourceHash === review.sourceHash && ledger.active.dependency === review.dependency &&
    ledger.active.intentGeneration === intent.generation && (attempted ? outcome?.status === 'attempted' : outcome === undefined)
}
/** Persist the spent gesture before retirement or activation. A crash or a
 * known failure cannot turn this same file into new authorization. */
export function beginReviewAttempt(authority: SharedChannelAuthority, review: DurableReview, recovery?: RetiredReviewRecovery): SharedMutationResult {
  if (!reviewMatches(authority.snapshot(), review) || sharedReviewDependency(authority.snapshot()) !== review.dependency) return { kind: 'stale', revision: authority.revision }
  return authority.transact(authority.revision, (next, order) => {
    const ledger = reviewLedger(next)!
    put(ledger.outcomes, review.fingerprint, { generation: review.generation, status: 'attempted', revision: order })
    if (recovery) ledger.retirement = { fingerprint: review.fingerprint, recovery }
  })
}
/** Called only inside the authority's reviewed application transaction. */
export function consumeReview(next: SharedChannelState, review: DurableReview, order: number): void {
  if (!reviewMatches(next, review, true)) throw new Error('Obsolete or consumed review.')
  const ledger = reviewLedger(next)!
  put(ledger.outcomes, review.fingerprint, { generation: review.generation, status: 'consumed', revision: order })
  delete ledger.active
  delete ledger.retirement
  const intent = next.pendingIntent['operator'] as OperatorIntent | undefined
  if (intent?.generation === review.intentGeneration && intent.requested) {
    intent.assignments = []
    intent.requested = false
    intent.generation++
  }
}
export function rejectReviewAttempt(authority: SharedChannelAuthority, fingerprint: string): SharedMutationResult {
  return authority.transact(authority.revision, (next, order) => {
    const ledger = reviewLedger(next)
    const outcome = ledger?.outcomes[fingerprint]
    if (!ledger || outcome?.status !== 'attempted') throw new Error('No recoverable review attempt.')
    outcome.status = 'rejected'
    outcome.revision = order
    if (ledger.retirement?.fingerprint === fingerprint) delete ledger.retirement
  })
}
export function reviewRecoveryLine(result: 'recovered' | 'unresolved'): string {
  return `[slack] ${RELOAD_REVIEW_RECOVERY}: ${result}; the interrupted confirmation did not activate. ` +
    (result === 'recovered' ? 'Pending intent remains; a fresh review and confirmation are required.' : 'Preserve authority and retirement evidence; affected new work remains held until retirement recovery succeeds.')
}
export function reviewOutcomeLine(status: ReviewOutcome['status']): string {
  return `[slack] ${RELOAD_REVIEW_OUTCOME}: ${status}; this confirmation cannot assign again. Review the current pending file for a new confirmation.`
}
export function reviewRecoveredBringUpFailedLine(err: unknown): string {
  return `[slack] reload: recovered persona bring-up failed: ${describeThrownValue(err)}`
}
export function reviewRecoveredLifecycleFailedLine(err: unknown): string {
  return `[slack] reload: recovered activation lifecycle failed: ${describeThrownValue(err)}`
}
