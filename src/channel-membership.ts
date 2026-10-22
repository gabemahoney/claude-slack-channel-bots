/** Authenticated membership observations. All durable changes go through the
 * caller's shared authority. No Slack calls or awaits occur in observe(). */
import { createHash, randomUUID } from 'node:crypto'
import { CHANNEL_ID_RE, type ChannelMode } from './config.ts'
import type { PersonaEventProvenance, PersonaSocketEventPayload } from './persona-connections.ts'
import { slackInstallationIdentity, slackInstallationKey, type SlackInstallationIdentity } from './persona-slack-validation.ts'
import { applySharedMembership, type SharedChannelAuthority, type SharedMembership, type SharedMembershipAbsenceConflict, type SharedPersona, type SharedMutationResult } from './shared-channels.ts'
import { compareMembershipEventTimes, compareMembershipTimestamp, membershipPayloadIdentity, membershipTimestampUpperBound, orderMembershipRecovery, MEMBERSHIP_EVENT_ID_RE, MEMBERSHIP_TIMESTAMP_RE, type MembershipEvidence, type MembershipEventPayload } from './channel-membership-evidence.ts'

export const MEMBERSHIP_UNRESOLVED = 'channel-membership-unresolved'
export const MEMBERSHIP_STORAGE_FAILED = 'channel-membership-storage-failed'
export type MembershipFault = 'installation-unverified' | 'current-membership-missing' | 'event-order-conflict' | 'history-unresolved' | 'event-not-durable' | 'shared-state-unreadable' | 'eligibility-missing'

export function membershipDiagnostic(key: string, channel: string | undefined, fault: MembershipFault): string {
  const scope = channel && CHANNEL_ID_RE.test(channel) ? ` channel=${channel}` : ''
  const repair = fault === 'event-not-durable' || fault === 'shared-state-unreadable'
    ? 'Restore readable, writable shared state; finite Slack retries cannot guarantee recovery of unsaved events.'
    : fault === 'history-unresolved'
      ? 'Current inventory cannot establish this conflicting history; retain the hold for reviewed state recovery.'
      : 'Authenticated reconciliation is required; elapsed time is not membership evidence.'
  return `[slack] ${fault === 'event-not-durable' ? MEMBERSHIP_STORAGE_FAILED : MEMBERSHIP_UNRESOLVED} persona=${key}${scope}: ${fault}. ${repair}`
}

/** c9 binds its durable clearing/enrollment obligations to this token.
 * Superseded tokens cannot hold a new lifetime or authorize late callbacks.
 * Queued work never acquires enrollment authority merely by replaying it. */
export interface MembershipLifetime {
  incarnation: string
  boundary: number
  leaveBoundary: number
}
export type MembershipReading =
  | { kind: 'eligible'; lifetime: MembershipLifetime; identity: string; generation: string }
  | { kind: 'ineligible'; reason: 'absent' | 'external-sharing' | 'invalid-channel' }
  | { kind: 'unresolved'; reason: MembershipFault }

export interface MembershipGeneration {
  readonly key: string
  readonly incarnation: string
  readonly generation: string
  readonly identity: SlackInstallationIdentity
  readonly identityKey: string
  readonly provenance: PersonaEventProvenance
  readonly positives: Map<string, SharedMembership>
  readonly absent: Set<string>
  readonly holds: Map<string, MembershipFault>
  complete: boolean
  /** Changes whenever live evidence is observed, even if its write fails. */
  observations: number
}

export interface ChannelMembershipDeps {
  authority: SharedChannelAuthority
  dryRun: boolean
  log(line: string): void
  /** Schedules work only; it must never start a network lookup inline. */
  requestReconciliation?(key: string): void
}
export interface ChannelMembership {
  activate(key: string, provenance: PersonaEventProvenance): MembershipGeneration | undefined
  invalidate(key: string): void
  generation(key: string): MembershipGeneration | undefined
  isCurrent(generation: MembershipGeneration): boolean
  /** Authenticates and durably handles history before acknowledgement. The
   * receiving socket alone supplies neither current presence nor absence. */
  observe(key: string, payload: PersonaSocketEventPayload, provenance?: PersonaEventProvenance): boolean
  recover(key: string): boolean
  /** Only a responsive current positive or complete current absence may call
   * this, with the scan start watermark. Observed leaves precede that fact. */
  reconcileEvidence(generation: MembershipGeneration, channel: string, through: string): boolean
  /** Commit all absence effects and their historical cutoff together, after
   * the collector validates every page and its eligibility metadata. Does not
   * publish current absence; the collector rechecks its lifetime first. */
  commitInventory(generation: MembershipGeneration, inventory: MembershipInventoryCommit): SharedMutationResult
  unresolvedChannels(key: string): string[]
  read(key: string, channel: string, mode: ChannelMode): MembershipReading
  lifetime(key: string, channel: string): MembershipLifetime | undefined
  /** Durable unresolved live obligations also apply to duplicate intake. */
  hasUnresolved(key: string, channel: string): boolean
  request(key: string): void
  close(): void
}

export interface MembershipInventoryCommit {
  scanId: string
  observedThrough: string
  observedRevision: number
  /** Every unseen historical/held channel, with its scan-start boundary. */
  absent: ReadonlyMap<string, number>
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function lifeOf(authority: SharedChannelAuthority, key: string): SharedPersona | undefined {
  const personas = authority.snapshot().personas
  return Object.hasOwn(personas, key) ? personas[key] : undefined
}
function pending(life: SharedPersona | undefined, channel?: string): MembershipEvidence[] {
  return Object.values(life?.membershipEvidence ?? {}).filter(e =>
    (e.state === 'pending' || e.state === 'conflict') && (channel === undefined || e.channel === channel ||
      (e.originalEvent !== undefined && (life?.membershipEvidence?.[e.originalEvent]?.channel ?? life?.membershipEvents[e.originalEvent]?.channel) === channel)))
    .sort((a, b) => a.recordedOrder - b.recordedOrder)
}
function newerExplicitAssignment(life: SharedPersona, channel: string, observedRevision: number): boolean {
  const order = life.assignments[channel]?.order
  return order !== undefined && order > observedRevision && !Object.values(life.membershipEvents)
    .some(event => event.channel === channel && event.member && event.order === order)
}

export function createChannelMembership(deps: ChannelMembershipDeps): ChannelMembership {
  const { authority } = deps
  const generations = new Map<string, MembershipGeneration>()
  const undurable = new Map<string, Map<string, MembershipEvidence>>()
  const undurableAbsences = new Map<string, Map<string, SharedMembershipAbsenceConflict>>()
  const undurableIncarnations = new Map<string, string>()
  const episodes = new Map<string, Map<string, MembershipFault>>()
  const seenReplacements = new Set(Object.values(authority.snapshot().personas).flatMap(life => Object.keys(life.replacedAbsences ?? {})))
  let closed = false
  const unsubscribe = authority.subscribe(() => {
    for (const [key, incarnation] of undurableIncarnations) {
      if (authority.incarnation(key) !== incarnation) { undurable.delete(key); undurableAbsences.delete(key); undurableIncarnations.delete(key) }
    }
    for (const [key, generation] of generations) {
      if (authority.incarnation(key) !== generation.incarnation) {
        generations.delete(key)
        undurable.delete(key)
        undurableAbsences.delete(key)
        episodes.delete(key)
      }
    }
    for (const [key, life] of Object.entries(authority.snapshot().personas)) {
      for (const [binding, replacement] of Object.entries(life.replacedAbsences ?? {})) {
        if (seenReplacements.has(binding)) continue
        seenReplacements.add(binding)
        const generation = generations.get(key)
        if (generation?.incarnation !== life.incarnation) continue
        // Invalidate the in-flight scan before requesting a fresh observation.
        // Other channels keep their proven positives and accepted queues.
        generation.observations++
        markHeld(generation, replacement.channel, 'current-membership-missing')
      }
    }
  })
  function report(key: string, channel: string, fault: MembershipFault): void {
    const channels = episodes.get(key) ?? new Map<string, MembershipFault>()
    if (channels.get(channel) === fault) return
    channels.set(channel, fault)
    episodes.set(key, channels)
    try { deps.log(membershipDiagnostic(key, channel, fault)) } catch { /* diagnostics cannot change acknowledgement */ }
  }
  function request(key: string): void {
    if (!closed && !deps.dryRun) deps.requestReconciliation?.(key)
  }
  function isCurrent(generation: MembershipGeneration): boolean {
    return !closed && !deps.dryRun && generations.get(generation.key) === generation &&
      authority.incarnation(generation.key) === generation.incarnation && generation.provenance.isCurrent()
  }
  function markHeld(generation: MembershipGeneration, channel: string, fault: MembershipFault): void {
    generation.positives.delete(channel)
    generation.absent.delete(channel)
    generation.holds.set(channel, fault)
    generation.complete = false
    report(generation.key, channel, fault)
    request(generation.key)
  }
  function rememberUndurable(generation: MembershipGeneration, evidence: MembershipEvidence): void {
    const { key, incarnation } = generation
    const records = undurable.get(key) ?? new Map<string, MembershipEvidence>()
    records.set(evidence.event, evidence)
    undurable.set(key, records)
    undurableIncarnations.set(key, incarnation)
  }
  function recoveryLife(key: string): SharedPersona | undefined {
    const life = lifeOf(authority, key)
    if (life) {
      life.membershipEvidence = { ...life.membershipEvidence, ...Object.fromEntries(undurable.get(key) ?? []) }
      life.membershipAbsenceConflicts = { ...life.membershipAbsenceConflicts, ...Object.fromEntries(undurableAbsences.get(key) ?? []) }
    }
    return life
  }
  function retainAbsences(generation: MembershipGeneration, conflicts: Map<string, SharedMembershipAbsenceConflict>): SharedMutationResult {
    const { key, incarnation } = generation
    if (!isCurrent(generation)) return { kind: 'stale', revision: authority.revision }
    const records = undurableAbsences.get(key) ?? new Map<string, SharedMembershipAbsenceConflict>()
    const life = lifeOf(authority, key)!
    for (const [channel, conflict] of conflicts) {
      // Preserve the first observation, including across retries and newer
      // assignments. Refreshing its scan-start revision would lose the race.
      if (!life.membershipAbsenceConflicts?.[channel] && !records.has(channel)) records.set(channel, conflict)
      markHeld(generation, channel, 'history-unresolved')
    }
    if (!records.size) return { kind: 'unresolved', revision: authority.revision }
    undurableAbsences.set(key, records)
    undurableIncarnations.set(key, incarnation)
    const result = authority.transact(authority.revision, (next, order) => {
      if (!isCurrent(generation)) throw new Error('Superseded membership absence.')
      const current = next.personas[key]!
      current.membershipAbsenceConflicts ??= {}
      for (const [channel, conflict] of records) current.membershipAbsenceConflicts[channel] ??= { ...conflict, recordedOrder: order }
    })
    if (result.kind === 'applied') undurableAbsences.delete(key)
    else for (const channel of records.keys()) markHeld(generation, channel, 'event-not-durable')
    return result.kind === 'applied' ? { kind: 'unresolved', revision: result.revision } : result
  }
  function persistPending(generation: MembershipGeneration, evidence: MembershipEvidence): boolean {
    if (!isCurrent(generation) || !authority.readable) return false
    const records = new Map(undurable.get(generation.key))
    const absences = new Map(undurableAbsences.get(generation.key))
    records.set(evidence.event, evidence)
    const result = authority.transact(authority.revision, (next, order) => {
      const life = next.personas[generation.key]
      if (!life || life.incarnation !== generation.incarnation) throw new Error('Superseded membership observation.')
      // A live event held by an unsaved scan conflict must not acknowledge
      // just its own history and lose the reason it cannot apply on restart.
      if (absences.size) {
        life.membershipAbsenceConflicts ??= {}
        for (const [channel, conflict] of absences) life.membershipAbsenceConflicts[channel] ??= { ...conflict, recordedOrder: order }
      }
      life.membershipEvidence ??= {}
      for (const record of records.values()) {
        const prior = life.membershipEvidence[record.event]
        if (prior && (prior.originalEvent !== record.originalEvent || membershipPayloadIdentity(prior) !== membershipPayloadIdentity(record))) throw new Error('Contradictory membership recovery identity.')
        if (prior) continue
        Object.defineProperty(life.membershipEvidence, record.event, {
          value: { ...record, recordedOrder: order }, enumerable: true, configurable: true, writable: true,
        })
      }
    })
    if (result.kind === 'applied') {
      for (const event of records.keys()) undurable.get(generation.key)?.delete(event)
      for (const channel of absences.keys()) {
        undurableAbsences.get(generation.key)?.delete(channel)
        markHeld(generation, channel, 'history-unresolved')
      }
    }
    return result.kind === 'applied'
  }
  function effectFault(generation: MembershipGeneration, evidence: MembershipEvidence, life: SharedPersona, boundedConflict = false): MembershipFault | undefined {
    const inventory = life.membershipInventory
    if (life.incarnation !== generation.incarnation || evidence.identity !== generation.identityKey || life.membershipAbsenceConflicts?.[evidence.channel] ||
        pending(life, evidence.channel).some(e => e.conflict === 'contradictory-id' || e.conflict === 'reset-overlap') ||
        evidence.conflict === 'contradictory-id' || evidence.conflict === 'reset-overlap' ||
        (!evidence.member && (newerExplicitAssignment(life, evidence.channel, evidence.observedRevision) ||
          (inventory?.identity === evidence.identity && compareMembershipTimestamp(evidence.timestamp, inventory.observedThrough) <= 0 &&
            newerExplicitAssignment(life, evidence.channel, inventory.observedRevision)))) ||
        (!boundedConflict && (life.membership[evidence.channel]?.boundary ?? 0) !== evidence.boundary)) return 'history-unresolved'
    return undefined
  }
  function apply(generation: MembershipGeneration, evidence: MembershipEvidence, boundedConflict = false): boolean {
    if (!isCurrent(generation) || !authority.readable) return false
    const life = recoveryLife(generation.key)!
    if (effectFault(generation, evidence, life, boundedConflict)) return false
    const result = authority.observeMembership(generation.key, generation.incarnation, {
      event: evidence.event, channel: evidence.channel, member: evidence.member,
      identity: evidence.identity, boundary: boundedConflict ? life.membership[evidence.channel]?.boundary ?? 0 : evidence.boundary, channelType: evidence.channelType,
      isExtSharedChannel: evidence.isExtSharedChannel, evidence,
    }, authority.revision)
    if (result.kind !== 'applied') return false
    completeObservation(generation, evidence)
    return true
  }
  function completeObservation(generation: MembershipGeneration, evidence: MembershipEvidence): void {
    undurable.get(generation.key)?.delete(evidence.event)
    generation.holds.delete(evidence.channel)
    episodes.get(generation.key)?.delete(evidence.channel)
    // The issuing connection authenticates the installation, not freshness:
    // Slack can retry historical events on a newly opened socket, including
    // after an unobserved leave/rejoin. Preserve their durable effects, but
    // require responsive reconciliation for either current presence or absence.
    generation.positives.delete(evidence.channel)
    generation.absent.delete(evidence.channel)
    generation.complete = false
    request(generation.key)
  }
  function supersedeWithLeave(generation: MembershipGeneration, evidence: MembershipEvidence): boolean {
    // Only a distinct, strictly later leave may supersede earlier unresolved
    // live observations. An ambiguous scan/assignment race still needs review.
    if (!isCurrent(generation) || !authority.readable || evidence.member ||
        evidence.originalEvent || evidence.conflict !== 'predecessor') return false
    const saved = lifeOf(authority, generation.key)?.membershipEvidence?.[evidence.event]
    if (saved?.state === 'applied' && membershipPayloadIdentity(saved) === membershipPayloadIdentity(evidence)) {
      // A directory-sync failure may have installed this exact transaction.
      // Once the owner recovers it, retire the in-memory retry without writing
      // or treating that historical result as current membership.
      undurable.get(generation.key)?.delete(evidence.event)
      const recovered = recoveryLife(generation.key)!
      if (!pending(recovered, evidence.channel).length && !recovered.membershipAbsenceConflicts?.[evidence.channel]) completeObservation(generation, evidence)
      return true
    }
    const life = recoveryLife(generation.key)!
    const records = pending(life, evidence.channel).filter(e => e.event !== evidence.event)
    if (!records.length || records.some(record => {
      const original = record.originalEvent ? life.membershipEvidence?.[record.originalEvent] : undefined
      return record.channel !== evidence.channel || record.identity !== generation.identityKey ||
        compareMembershipEventTimes(record.timestamp, evidence.timestamp) >= 0 ||
        (record.originalEvent !== undefined && (!original || original.channel !== evidence.channel ||
          original.identity !== generation.identityKey || compareMembershipEventTimes(original.timestamp, evidence.timestamp) >= 0))
    })) return false
    const result = authority.transact(authority.revision, (next, order) => {
      if (!isCurrent(generation)) throw new Error('Superseded membership observation.')
      const current = next.personas[generation.key]!
      current.membershipEvidence ??= {}
      for (const record of records) current.membershipEvidence[record.event] = { ...record, state: 'superseded', recordedOrder: order }
      // Keep the existing incarnation, assignment, inventory and boundary
      // guards, after retiring only the proven earlier live obligations.
      if (effectFault(generation, evidence, current)) throw new Error('Unresolved membership history.')
      applySharedMembership(next, order, generation.key, generation.incarnation, {
        event: evidence.event, channel: evidence.channel, member: false,
        identity: evidence.identity, boundary: evidence.boundary, evidence,
      })
    })
    if (result.kind !== 'applied') return false
    for (const record of records) undurable.get(generation.key)?.delete(record.event)
    completeObservation(generation, evidence)
    return true
  }
  function retain(generation: MembershipGeneration, evidence: MembershipEvidence, fault: MembershipFault): boolean {
    if (!isCurrent(generation)) return false
    markHeld(generation, evidence.channel, fault)
    if (!lifeOf(authority, generation.key)?.membershipEvidence?.[evidence.event]) rememberUndurable(generation, evidence)
    if (!undurable.get(generation.key)?.size && !undurableAbsences.get(generation.key)?.size) return true
    if (persistPending(generation, evidence)) return true
    markHeld(generation, evidence.channel, 'event-not-durable')
    return false
  }
  function handlePending(generation: MembershipGeneration, evidence: MembershipEvidence): boolean {
    if (!isCurrent(generation) || !authority.readable) return false
    const fault = effectFault(generation, evidence, recoveryLife(generation.key)!)
    if (!fault && apply(generation, evidence)) return true
    // Even a blocked effect owes durable history. A newer assignment or
    // boundary prevents application, never persistence of the original fact.
    return retain(generation, evidence, fault ?? 'event-not-durable')
  }
  function retireAmbiguousJoin(generation: MembershipGeneration, evidence: MembershipEvidence): boolean {
    // The recorded leave may have happened after this join. Do not manufacture
    // another membership boundary (and then another leave) by replaying it as
    // a rejoin. Retain its identity durably; the scanner supplies current truth.
    const result = authority.transact(authority.revision, (next, order) => {
      const life = next.personas[generation.key]
      if (!life || life.incarnation !== generation.incarnation) throw new Error('Superseded membership observation.')
      life.membershipEvidence![evidence.event] = { ...evidence, state: 'superseded', recordedOrder: order }
    })
    if (result.kind !== 'applied') return false
    generation.holds.delete(evidence.channel)
    episodes.get(generation.key)?.delete(evidence.channel)
    request(generation.key)
    return true
  }
  function recover(key: string): boolean {
    const generation = generations.get(key)
    if (!generation || !isCurrent(generation) || !authority.readable) return false
    const conflicts = new Map(Object.entries(recoveryLife(key)!.membershipAbsenceConflicts ?? {}))
    if (conflicts.size) retainAbsences(generation, conflicts)
    for (const evidence of pending(recoveryLife(key))) {
      // A known applicable effect is completed before any new positive. A
      // conflict is durable protection, never converted into a guessed join.
      if (evidence.state === 'pending') {
        handlePending(generation, evidence)
      } else if (!supersedeWithLeave(generation, evidence)) {
        retain(generation, evidence, evidence.conflict === 'contradictory-id' || evidence.conflict === 'reset-overlap' ? 'history-unresolved' : 'event-order-conflict')
      }
    }
    return !conflicts.size && !pending(lifeOf(authority, key)).length && !undurable.get(key)?.size
  }
  function unresolvedChannels(key: string): string[] {
    const life = recoveryLife(key)
    return [...new Set([
      ...(generations.get(key)?.holds.keys() ?? []),
      ...Object.keys(life?.membershipAbsenceConflicts ?? {}),
      ...pending(life).flatMap(e => {
        const originalChannel = e.originalEvent ? life?.membershipEvidence?.[e.originalEvent]?.channel ?? life?.membershipEvents[e.originalEvent]?.channel : undefined
        return originalChannel ? [e.channel, originalChannel] : [e.channel]
      }),
    ])]
  }
  function recoveryPlan(generation: MembershipGeneration, channel: string, through: string, life: SharedPersona):
      { records: MembershipEvidence[] } | { fault: MembershipFault } {
    if (undurableAbsences.get(generation.key)?.has(channel)) return { fault: 'event-not-durable' }
    if (life.membershipAbsenceConflicts?.[channel]) return { fault: 'history-unresolved' }
    const records = pending(life, channel)
    // An unsaved/known-applicable effect must complete first. Current Slack
    // presence must never wash away a durably observed pre-crash leave.
    if ([...(undurable.get(generation.key)?.values() ?? [])].some(e => e.channel === channel) || records.some(e => e.state === 'pending')) return { fault: generation.holds.get(channel) ?? 'event-not-durable' }
    // Missing metadata has no historical effect to recover. A fully valid
    // absence can discharge that local hold without manufacturing a leave.
    if (!records.length && generation.holds.get(channel) === 'eligibility-missing') return { records: [] }
    const replaced = Object.values(life.replacedAbsences ?? {}).filter(r => r.channel === channel).sort((a, b) => b.removedOrder - a.removedOrder)[0]
    if (!records.length && replaced && compareMembershipTimestamp(through, (replaced.at / 1000).toFixed(3)) >= 0) return { records: [] }
    if (!records.length) return { fault: generation.holds.get(channel) ?? 'event-order-conflict' }
    if (records.some(e => !e.conflict || effectFault(generation, e, life, true))) return { fault: 'history-unresolved' }
    // An event_time integer is an interval, not an exact ordering point.
    // A later successful request can resolve overlap; time passing alone cannot.
    if (records.some(e => compareMembershipTimestamp(membershipTimestampUpperBound(e.timestamp), through) >= 0)) return { fault: 'event-order-conflict' }
    return { records: orderMembershipRecovery(records) }
  }
  function ambiguousJoin(life: SharedPersona, evidence: MembershipEvidence): boolean {
    return evidence.member && (evidence.conflict === 'scan-overlap' || evidence.conflict === 'unapplied-connection' ||
      Object.values(life.membershipEvidence ?? {}).some(prior => prior.state === 'applied' && !prior.member &&
        prior.channel === evidence.channel && prior.identity === evidence.identity && compareMembershipEventTimes(prior.timestamp, evidence.timestamp) === 0))
  }
  function reconcileEvidence(generation: MembershipGeneration, channel: string, through: string): boolean {
    if (!isCurrent(generation) || !authority.readable) return false
    recover(generation.key)
    if (!hasUnresolved(generation.key, channel)) return true
    const plan = recoveryPlan(generation, channel, through, lifeOf(authority, generation.key)!)
    if ('fault' in plan) { markHeld(generation, channel, plan.fault); return false }
    for (const evidence of plan.records) {
      if (!isCurrent(generation)) return false
      const current = lifeOf(authority, generation.key)!
      const fault = effectFault(generation, evidence, recoveryLife(generation.key)!, true)
      if (fault) { markHeld(generation, channel, fault); return false }
      if (ambiguousJoin(current, evidence)) {
        if (!retireAmbiguousJoin(generation, evidence)) { markHeld(generation, channel, 'event-not-durable'); return false }
        continue
      }
      // Rebase only this authenticated, now bounded conflict chain. The scan
      // applies its current result afterwards, so an observed leave clears
      // the old choice before any verified rejoin/default can authorize work.
      if (!apply(generation, evidence, true)) {
        markHeld(generation, channel, 'event-not-durable')
        return false
      }
    }
    generation.holds.delete(channel)
    return !hasUnresolved(generation.key, channel)
  }
  function commitInventory(generation: MembershipGeneration, inventory: MembershipInventoryCommit): SharedMutationResult {
    if (!isCurrent(generation)) return { kind: 'stale', revision: authority.revision }
    if (!authority.readable) return { kind: 'unresolved', revision: authority.revision }
    const life = lifeOf(authority, generation.key)!
    const conflicts = new Map<string, SharedMembershipAbsenceConflict>()
    for (const [channel, boundary] of inventory.absent) {
      const previous = life.membership[channel]
      if (previous?.member && previous.identity === generation.identityKey && previous.boundary === boundary &&
          newerExplicitAssignment(life, channel, inventory.observedRevision)) {
        conflicts.set(channel, { identity: generation.identityKey, boundary, observedThrough: inventory.observedThrough,
          observedRevision: inventory.observedRevision, assignmentOrder: life.assignments[channel]!.order, recordedOrder: authority.revision })
      }
    }
    // A complete negative result cannot tell whether a choice confirmed while
    // collecting belongs before or after the missed leave. Persist that
    // obligation without any absence effect/cutoff; retry/restart must not
    // silently reinterpret it using a newer scan's revision.
    if (conflicts.size) return retainAbsences(generation, conflicts)
    const plans = new Map<string, MembershipEvidence[]>()
    // Validate every obligation before staging any absence. A held positive
    // cannot be cleared by a negative result elsewhere in the inventory.
    for (const channel of unresolvedChannels(generation.key)) {
      if (!inventory.absent.has(channel)) return { kind: 'unresolved', revision: authority.revision }
      const plan = recoveryPlan(generation, channel, inventory.observedThrough, life)
      if ('fault' in plan) {
        markHeld(generation, channel, plan.fault)
        return { kind: 'unresolved', revision: authority.revision }
      }
      plans.set(channel, plan.records)
    }
    const observations = generation.observations
    const orderSpan = 1 + inventory.absent.size + [...plans.values()].reduce((count, records) => count + records.length, 0)
    const result = authority.transact(authority.revision, (next, order) => {
      if (!isCurrent(generation) || generation.observations !== observations) throw new Error('Superseded membership inventory.')
      const current = next.personas[generation.key]!
      let position = order - orderSpan
      for (const [channel, boundary] of inventory.absent) {
        const records = plans.get(channel)
        if (!records && (current.membership[channel]?.boundary ?? 0) !== boundary) throw new Error('Superseded membership boundary.')
        for (const evidence of records ?? []) {
          position++
          if (effectFault(generation, evidence, current, true)) throw new Error('Superseded membership recovery.')
          if (ambiguousJoin(current, evidence)) {
            current.membershipEvidence![evidence.event] = { ...evidence, state: 'superseded', recordedOrder: position }
          } else {
            applySharedMembership(next, position, generation.key, generation.incarnation, {
              ...evidence, boundary: current.membership[channel]?.boundary ?? 0, evidence,
            })
          }
        }
        const previous = current.membership[channel]
        // Unseen future choices have no leave. Repeated absence refreshes the
        // watermark without deleting a choice made after the earlier leave.
        if (!previous || previous.identity !== generation.identityKey) continue
        if (previous.member && newerExplicitAssignment(current, channel, inventory.observedRevision)) throw new Error('Superseded membership assignment.')
        applySharedMembership(next, ++position, generation.key, generation.incarnation, {
          event: `scan:${inventory.scanId}:absent:${channel}`, channel, member: false,
          identity: generation.identityKey, boundary: previous.boundary, observedThrough: inventory.observedThrough,
        })
      }
      const previous = current.membershipInventory
      current.membershipInventory = previous?.identity === generation.identityKey &&
          compareMembershipTimestamp(previous.observedThrough, inventory.observedThrough) >= 0
        ? { ...previous, recordedOrder: order }
        : { incarnation: generation.incarnation, identity: generation.identityKey, observedThrough: inventory.observedThrough,
          observedRevision: inventory.observedRevision, recordedOrder: order }
    }, orderSpan)
    if (result.kind === 'applied') for (const channel of plans.keys()) {
      generation.holds.delete(channel)
      episodes.get(generation.key)?.delete(channel)
    }
    return result
  }
  function activate(key: string, provenance: PersonaEventProvenance): MembershipGeneration | undefined {
    if (closed || deps.dryRun || !provenance.applied || !provenance.isCurrent()) return undefined
    const identity = slackInstallationIdentity(provenance.identity)
    const incarnation = authority.incarnation(key)
    if (!identity || !incarnation || provenance.incarnation !== incarnation) return undefined
    const previous = generations.get(key)
    if (previous?.provenance.connectionId === provenance.connectionId && previous.incarnation === incarnation) return previous
    const generation: MembershipGeneration = {
      key, incarnation, generation: randomUUID(), identity, identityKey: slackInstallationKey(identity), provenance,
      positives: new Map(), absent: new Set(), holds: new Map(), complete: false, observations: 0,
    }
    generations.set(key, generation)
    recover(key)
    request(key)
    return generation
  }

  function observe(key: string, payload: PersonaSocketEventPayload, provenance?: PersonaEventProvenance): boolean {
    if (closed || deps.dryRun) return false
    if (provenance && provenance.key !== key) return true
    if (provenance && !provenance.applied && !provenance.candidate) return false
    if (provenance && !provenance.candidate && !provenance.isCurrent()) return true
    if (provenance?.incarnation !== undefined && provenance.incarnation !== authority.incarnation(key)) return true
    const event = payload.event
    const body = payload.body
    if (!object(event) || !object(body) || typeof event['channel'] !== 'string' ||
        !CHANNEL_ID_RE.test(event['channel']) || !['member_joined_channel', 'channel_left'].includes(event['type'] as string)) return true
    const channel = event['channel']
    const identity = slackInstallationIdentity(provenance?.identity)
    if (!identity || !provenance) { report(key, channel, 'installation-unverified'); request(key); return false }
    if (body['team_id'] !== identity.teamId || body['api_app_id'] !== identity.appId) return true
    const member = event['type'] === 'member_joined_channel'
    if (member && event['user'] !== identity.botUserId) return true
    if (event['team'] !== undefined && event['team'] !== identity.teamId) return true
    const authorizations = body['authorizations']
    if (!Array.isArray(authorizations) || !authorizations.some(a => object(a) &&
        a['team_id'] === identity.teamId && a['user_id'] === identity.botUserId && a['is_bot'] === true)) return true
    const id = body['event_id']
    const timestamp = typeof event['event_ts'] === 'string' ? event['event_ts'] :
      Number.isSafeInteger(body['event_time']) && (body['event_time'] as number) >= 0 ? String(body['event_time']) : undefined
    if (typeof id !== 'string' || !MEMBERSHIP_EVENT_ID_RE.test(id) || !timestamp || !MEMBERSHIP_TIMESTAMP_RE.test(timestamp)) return true
    // An overlapping candidate cannot supply an applied observation. For the
    // same authenticated installation it can durably protect evidence until
    // a current scan resolves it; a foreign candidate cannot affect this life.
    const generation = provenance.candidate ? generations.get(key) : activate(key, provenance)
    if (generation && generation.identityKey !== slackInstallationKey(identity)) return true
    if (!generation || !isCurrent(generation)) { request(key); return false }
    const life = lifeOf(authority, key)!
    // Coarse event_time covers the whole second. Only an interval wholly
    // before the configured reset is demonstrably from the old incarnation.
    const upperTimestamp = membershipTimestampUpperBound(timestamp)
    const resets = Object.values(life.replacedAbsences ?? {}).flatMap(r => r.channel === channel ? [r.at] : [])
    const resetAt = resets.length ? Math.max(life.createdAt ?? 0, ...resets) : life.createdAt
    if (resetAt !== undefined && compareMembershipTimestamp(upperTimestamp, (resetAt / 1000).toFixed(3)) < 0) return true
    const resetOverlap = resetAt !== undefined && compareMembershipTimestamp(timestamp, (resetAt / 1000).toFixed(3)) <= 0
    const incoming: MembershipEventPayload = {
      channel, member, identity: generation.identityKey, timestamp,
      ...(member && (event['channel_type'] === 'C' || event['channel_type'] === 'G')
        ? { channelType: event['channel_type'] === 'C' ? 'channel' as const : 'group' as const } : {}),
      ...(typeof body['is_ext_shared_channel'] === 'boolean' ? { isExtSharedChannel: body['is_ext_shared_channel'] } : {}),
    }
    const old = life.membershipEvidence?.[id] ?? undurable.get(key)?.get(id)
    if (old && membershipPayloadIdentity(old) === membershipPayloadIdentity(incoming)) {
      if (old.state === 'pending') return handlePending(generation, old)
      if (old.state === 'conflict') return (!provenance.candidate && supersedeWithLeave(generation, old)) ||
        retain(generation, old, old.conflict === 'contradictory-id' ? 'history-unresolved' : 'event-order-conflict')
      // An exact original retry cannot acknowledge an unsaved contradiction.
      const contradiction = pending(recoveryLife(key), channel).find(e => undurable.get(key)?.has(e.event))
      return !contradiction || retain(generation, contradiction, 'history-unresolved')
    }
    // A foundation-era ID without the full payload cannot prove an exact
    // retry. Keep its effect, but retain any reuse as unresolved history.
    const applied = life.membershipEvents[id]
    const previous = Object.values(life.membershipEvidence ?? {}).filter(e => e.channel === channel && e.identity === generation.identityKey && e.state === 'applied')
    if (!old && !applied && previous.some(e => compareMembershipEventTimes(timestamp, e.timestamp) < 0)) return true
    let through = life.membership[channel]?.identity === generation.identityKey ? life.membership[channel]?.observedThrough : undefined
    const inventory = life.membershipInventory
    if (inventory?.identity === generation.identityKey && (!through || compareMembershipTimestamp(inventory.observedThrough, through) > 0)) {
      through = inventory.observedThrough
    }
    // Complete inventory also bounds history for previously unseen channels.
    // Reject it before a join could make a future preference removable or a
    // leave could erase it. Persisted cutoffs never populate current evidence.
    if (!old && !applied && through && compareMembershipTimestamp(upperTimestamp, through) < 0) return true
    const conflict: MembershipEvidence['conflict'] = old || applied ? 'contradictory-id' : resetOverlap ? 'reset-overlap' : provenance.candidate ? 'unapplied-connection' :
      previous.some(e => compareMembershipEventTimes(timestamp, e.timestamp) === 0 && e.member !== member) ? 'same-time' :
      through && compareMembershipTimestamp(timestamp, through) <= 0 && life.membership[channel]?.member !== member ? 'scan-overlap' :
      hasUnresolved(key, channel) ? 'predecessor' : undefined
    // Preserve the original event record on contradictory reuse of an ID.
    // This separate stable recovery key never overwrites its applied outcome.
    const evidenceId = old || applied ? `Ev${createHash('sha256').update(JSON.stringify([id, membershipPayloadIdentity(incoming)])).digest('hex')}` : id
    const recordedConflict = life.membershipEvidence?.[evidenceId] ?? undurable.get(key)?.get(evidenceId)
    if (recordedConflict) {
      if (membershipPayloadIdentity(recordedConflict) !== membershipPayloadIdentity(incoming)) return false
      if (recordedConflict.state === 'superseded') {
        const unsaved = pending(recoveryLife(key), channel).find(e => undurable.get(key)?.has(e.event))
        return !unsaved || retain(generation, unsaved, 'history-unresolved')
      }
      return retain(generation, recordedConflict, 'history-unresolved')
    }
    const evidence: MembershipEvidence = {
      ...incoming, event: evidenceId, ...(old || applied ? { originalEvent: id } : {}), connectionId: provenance.connectionId,
      boundary: life.membership[channel]?.boundary ?? 0,
      observedRevision: authority.revision, recordedOrder: authority.revision,
      state: conflict ? 'conflict' : 'pending', ...(conflict ? { conflict } : {}),
    }
    generation.observations++
    // Protection is installed before the first persistence callback.
    markHeld(generation, channel, conflict ? 'event-order-conflict' : 'current-membership-missing')
    if (old || applied) {
      const originalChannel = old?.channel ?? applied!.channel
      markHeld(generation, originalChannel, 'history-unresolved')
    }
    if (!provenance.candidate && supersedeWithLeave(generation, evidence)) return true
    return evidence.state === 'pending' ? handlePending(generation, evidence) :
      retain(generation, evidence, conflict === 'contradictory-id' ? 'history-unresolved' : 'event-order-conflict')
  }

  function lifetime(key: string, channel: string): MembershipLifetime | undefined {
    const life = authority.lifetime(key, channel)
    return life ? { incarnation: life.incarnation, boundary: life.membershipBoundary, leaveBoundary: life.leaveBoundary } : undefined
  }
  function hasUnresolved(key: string, channel: string): boolean {
    if (!CHANNEL_ID_RE.test(channel)) return false
    if (!authority.readableFor(key, channel) || generations.get(key)?.holds.has(channel)) return true
    const life = recoveryLife(key)
    return !!life?.membershipAbsenceConflicts?.[channel] || pending(life, channel).length > 0
  }
  function read(key: string, channel: string, mode: ChannelMode): MembershipReading {
    if (!CHANNEL_ID_RE.test(channel)) return { kind: 'ineligible', reason: 'invalid-channel' }
    if (!authority.readableFor(key, channel)) return { kind: 'unresolved', reason: 'shared-state-unreadable' }
    const generation = generations.get(key)
    if (!generation || !isCurrent(generation)) return { kind: 'unresolved', reason: 'current-membership-missing' }
    if (hasUnresolved(key, channel)) return { kind: 'unresolved', reason: generation.holds.get(channel) ?? 'event-order-conflict' }
    const member = generation.positives.get(channel)
    if (!member) return generation.complete || generation.absent.has(channel)
      ? { kind: 'ineligible', reason: 'absent' } : { kind: 'unresolved', reason: 'current-membership-missing' }
    if (mode === 'open') {
      if (member.isExtSharedChannel === true) return { kind: 'ineligible', reason: 'external-sharing' }
      if (!member.channelType || member.isExtSharedChannel !== false) return { kind: 'unresolved', reason: 'eligibility-missing' }
    }
    return { kind: 'eligible', lifetime: lifetime(key, channel)!, identity: generation.identityKey, generation: generation.generation }
  }
  return {
    activate, invalidate: key => { generations.delete(key) }, generation: key => generations.get(key),
    isCurrent, observe, recover, reconcileEvidence, commitInventory, unresolvedChannels, read, lifetime, hasUnresolved, request,
    close() { closed = true; unsubscribe(); generations.clear(); undurable.clear(); undurableAbsences.clear(); undurableIncarnations.clear(); episodes.clear() },
  }
}
