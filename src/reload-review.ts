/** Durable review generations and one-time confirmation outcomes. This is
 * metadata in the existing shared authority, never a second store. */
import { createHash } from 'node:crypto'
import type { SharedChannelAuthority, SharedChannelState, SharedMembership, SharedMutationResult, SharedPersona } from './shared-channels.ts'
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

// --- Review dependency: the current facts a reviewed result reads ---

/** A record's keys in code-unit order, so enumeration order never matters. */
function keysInOrder(record: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(record).sort()
}
/** One channel's current membership fact: member, issuing identity, boundary
 * and eligibility metadata, where missing metadata stays distinct from false.
 * The scan watermark that last refreshed it is bookkeeping, not a fact. */
export function reviewedMembershipFact(membership: SharedMembership): unknown[] {
  return [membership.member, membership.identity, membership.boundary, membership.isExtSharedChannel ?? null, membership.channelType ?? null]
}
/** One life's current facts: incarnation and reset provenance, declaration,
 * ordered choices (a same-value write still moves its order), each channel's
 * membership fact, leave and destination proofs (a leave's boundary names its
 * event), absence conflicts and unresolved live evidence, which hold reviewed
 * absence replacement and membership reads. The histories that established
 * these (membership events, applied evidence, inventory and setup records)
 * and their scan IDs, watermarks and recorded positions stay out, so a rescan,
 * repeat retention or reconnect that finds the same facts keeps them. */
function reviewedLifeFacts(life: SharedPersona): unknown[] {
  const { assignments, membership, leaves, removedDestinations, resetDestination } = life
  const conflicts = life.membershipAbsenceConflicts ?? {}, evidence = life.membershipEvidence ?? {}
  return [
    life.incarnation, life.resetOrder ?? null, life.createdAt ?? null,
    [life.declaration.name, life.declaration.credentials_file, life.declaration.working_directory],
    keysInOrder(assignments).map(channel => {
      const choice = assignments[channel]!
      return [channel, choice.delivery, choice.order, choice.threadHybridSince ?? null]
    }),
    keysInOrder(membership).map(channel => [channel, ...reviewedMembershipFact(membership[channel]!)]),
    keysInOrder(leaves).map(channel => [channel, leaves[channel]!.boundary, leaves[channel]!.incarnation]),
    keysInOrder(removedDestinations).map(channel => [channel, removedDestinations[channel]!.boundary, removedDestinations[channel]!.incarnation]),
    resetDestination ? [resetDestination.channel, resetDestination.incarnation, resetDestination.order] : null,
    keysInOrder(conflicts).map(channel => [channel, conflicts[channel]!.identity, conflicts[channel]!.boundary, conflicts[channel]!.assignmentOrder]),
    keysInOrder(evidence).filter(event => evidence[event]!.state === 'pending' || evidence[event]!.state === 'conflict')
      .map(event => [event, evidence[event]!.channel, evidence[event]!.originalEvent ?? null, evidence[event]!.state]),
  ]
}
/** Metadata cannot invalidate itself. The applied source and configuration,
 * each life's current facts, retired identity provenance and the recovery
 * boundary remain dependencies; every review after a repair binds its
 * boundary, so a later history's restarted generations never reuse a
 * fingerprint. Every review, attempt, application and recovery caller reads
 * this one projection. */
export function sharedReviewDependency(state: SharedChannelState): string {
  const { personas, retiredIdentities } = state
  return createHash('sha256').update(JSON.stringify([
    state.sourceBytesBase64, state.applied,
    keysInOrder(personas).map(key => [key, reviewedLifeFacts(personas[key]!)]),
    // Retirement writes each record once; no scan or metadata write touches it.
    keysInOrder(retiredIdentities).map(id => [id, retiredIdentities[id]]),
    state.recovery?.boundary ?? null,
  ])).digest('hex')
}

// --- Review outcome retention ---

/** Keeps the review history's outcomes a reader still needs and drops the
 * rest: the outcome recorded last (greatest durable revision), whose
 * confirmation gets the outcome line; the attempted outcome the interrupted
 * retirement names, which its recovery reads; and the consumed outcome an
 * active recovery's activation names, which readability requires. A dropped
 * fingerprint never recurs, because later reviews bind a greater generation
 * and the current recovery boundary, so its confirmation is refused as stale.
 * Every history writer calls this on its transaction draft once its outcome
 * and references are final, so dropping shares the one durable application
 * that records the outcome: an interruption leaves the earlier or the later
 * ledger, never a partly pruned one. Creates nothing and checks nothing;
 * validation still reads every reference. */
export function retainReviewOutcomes(next: SharedChannelState): void {
  const ledger = reviewLedger(next)
  if (!ledger) return
  const outcomes = Object.entries(ledger.outcomes)
  const last = Math.max(...outcomes.map(([, outcome]) => outcome.revision))
  const kept = new Set(outcomes.filter(([, outcome]) => outcome.revision === last).map(([fingerprint]) => fingerprint))
  if (ledger.retirement) kept.add(ledger.retirement.fingerprint)
  if (next.recovery?.phase === 'active' && next.recovery.activation) kept.add(next.recovery.activation.fingerprint)
  for (const [fingerprint] of outcomes) if (!kept.has(fingerprint)) delete ledger.outcomes[fingerprint]
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
  retainReviewOutcomes(state)
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
    // A new generation without a new outcome still bounds an older ledger.
    retainReviewOutcomes(next)
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
    retainReviewOutcomes(next)
  })
}
/** Called only inside the authority's reviewed application transaction. */
export function consumeReview(next: SharedChannelState, review: DurableReview, order: number): void {
  if (!reviewMatches(next, review, true)) throw new Error('Obsolete or consumed review.')
  const ledger = reviewLedger(next)!
  put(ledger.outcomes, review.fingerprint, { generation: review.generation, status: 'consumed', revision: order })
  delete ledger.active
  delete ledger.retirement
  retainReviewOutcomes(next)
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
    retainReviewOutcomes(next)
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
