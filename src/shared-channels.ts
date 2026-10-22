/** The single durable authority for applied configuration and channel facts.
 * Importing this module performs no I/O. All mutations are synchronous,
 * revision checked, and become visible only after the injected durable write.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  botAttemptBinding, botAttemptKey, botAttemptResult, sameBotAttempt, validChannelDeliveryAttempt, validateBotAttempts,
  type BotAttemptAuthorization, type BotAttemptBinding, type BotAttemptResult, type ChannelDeliveryAttemptRequest, type SharedBotAttempt,
} from './channel-delivery-attempt.ts'
import { emptyOperatorIntent, parseReviewRequest, validateOperatorIntent, type OperatorIntent, type ReviewRequest } from './reload-request.ts'
import { consumeReview, reviewLedger, reviewMatches, sharedReviewDependency, supersedeReview, validateReviewLedger, type DurableReview, type ReviewLedger } from './reload-review.ts'
import { reloadFingerprint } from './reload-fingerprint.ts'
import { recoveryHash, validateSharedRecovery, type SharedRecoveryRecord, type SharedRecoveryRequest } from './shared-recovery.ts'
import { expandTilde, personaKey } from './persona-identity.ts'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { durableWriteFileSync, DurableWriteUnsyncedError } from './atomic-write.ts'
import { errnoSuffix } from './persona-credentials.ts'
import { MEMBERSHIP_TIMESTAMP_RE, compareMembershipEventTimes, membershipPayloadIdentity, validateMembershipEvidence, type MembershipEvidence } from './channel-membership-evidence.ts'
import { validateMembershipSetupRecords, type MembershipSetupRecord } from './channel-membership-readiness.ts'
import { slackInstallationIdentity, slackInstallationKey } from './persona-slack-validation.ts'
import {
  CHANNEL_ID_RE, DELIVERY_MODES, parseConfigJsonBytes, parsePersonaConfigBytes, readPersonaConfigBytes, resolveRealPath,
  type DeliveryMode, type Persona, type PersonaConfig, type PersonaConfigFs,
} from './config.ts'

export const SHARED_CHANNEL_FORMAT = 'cscb-shared-channels-v1'
export type PersonaDeclaration = Pick<Persona, 'name' | 'credentials_file' | 'working_directory'>
export interface SharedAssignment { delivery: DeliveryMode; order: number }
export interface SharedMembership {
  member: boolean
  boundary: number
  /** Authenticated issuing identity; configuration listing is never evidence. */
  identity: string
  isExtSharedChannel?: boolean
  channelType?: 'channel' | 'group'
  /** Start of the complete authenticated request that established this fact. */
  observedThrough?: string
}
/** Historical cutoff from a fully collected, reconciled inventory. It covers
 * channels never recorded in membership too, without creating leave/default
 * effects. This is never current membership authority after a connection gap. */
export interface SharedMembershipInventory {
  incarnation: string
  identity: string
  observedThrough: string
  /** Shared revision captured before collection; not the later commit order. */
  observedRevision: number
  recordedOrder: number
}
/** A complete scan saw absence, but cannot order the missed leave against a
 * choice confirmed during collection. Retain the original anchors for reviewed
 * recovery; later inventory alone cannot establish that historical order. */
export interface SharedMembershipAbsenceConflict {
  identity: string
  boundary: number
  observedThrough: string
  observedRevision: number
  assignmentOrder: number
  recordedOrder: number
}
export interface ReviewedAbsenceReplacement {
  channel: string
  incarnation: string
  conflict: SharedMembershipAbsenceConflict
  removedOrder: number
  assignmentOrder: number
  at: number
}
export interface SharedLeave { event: string; boundary: number; incarnation: string }
export interface SharedMembershipEvent { channel: string; member: boolean; identity: string; order: number; boundary: number }
export interface VerifiedSharedMembership {
  event: string
  channel: string
  /** False means a verified leave (live or missed), never mere absence of a
   * never-joined preference. The authenticated collector owns that proof. */
  member: boolean
  identity: string
  /** Boundary captured by the authenticated observation before asynchronous work. */
  boundary: number
  isExtSharedChannel?: boolean
  channelType?: 'channel' | 'group'
  /** Live evidence and its effect are committed together. */
  evidence?: MembershipEvidence
  observedThrough?: string
}
export interface SharedPersona {
  incarnation: string
  /** Durable reset order. Absence identifies an unchanged foundation life. */
  resetOrder?: number
  /** Local reset boundary, used only to reject demonstrably older evidence. */
  createdAt?: number
  declaration: PersonaDeclaration
  assignments: Record<string, SharedAssignment>
  membership: Record<string, SharedMembership>
  membershipEvents: Record<string, SharedMembershipEvent>
  leaves: Record<string, SharedLeave>
  /** A validated destination removed by a verified leave in this life only. */
  removedDestinations: Record<string, SharedLeave>
  /** This life's reset cleared the source's valid destination preference.
   * Allows only the derived applied list; supplies no membership/leave proof. */
  resetDestination?: { channel: string; incarnation: string; order: number }
  /** Optional only for a foundation baseline written before live collection. */
  membershipEvidence?: Record<string, MembershipEvidence>
  membershipInventory?: SharedMembershipInventory
  membershipAbsenceConflicts?: Record<string, SharedMembershipAbsenceConflict>
  /** Retained uncertain historical order and the explicit replacing order. */
  replacedAbsences?: Record<string, ReviewedAbsenceReplacement>
  /** Manual setup evidence keyed by authenticated installation, independent
   * of current inventory and delivery choices. */
  installationReadiness?: Record<string, MembershipSetupRecord>
}
export interface RetiredSharedIdentity {
  key: string
  declaration: PersonaDeclaration
  incarnation: string
  /** Durable application order of this retirement, independent of object-key order. */
  order: number
  /** Last reviewed source choices, including fields reset in the applied state. */
  channels: { id: string; delivery: DeliveryMode }[]
}
export interface SharedChannelState {
  format: typeof SHARED_CHANNEL_FORMAT
  revision: number
  /** A reviewed repair uses this same authority; review phase is never applied. */
  recovery?: SharedRecoveryRecord
  /** Validated raw input of the last confirmed operator application. */
  source: Record<string, unknown>
  /** Exact reviewed input, encoded without normalizing whitespace or UTF-8 bytes. */
  sourceBytesBase64: string
  /** Applied configuration, including automatic channel changes. */
  applied: Record<string, unknown>
  personas: Record<string, SharedPersona>
  retiredIdentities: Record<string, RetiredSharedIdentity>
  /** Metadata is durable, but does not publish configuration activation. */
  pendingIntent: Record<string, unknown>
  outcomes: SharedChannelOutcomes
}
export interface SharedChannelOutcomes extends Record<string, unknown> {
  operatorReviews?: ReviewLedger
  botAttempts?: Record<string, SharedBotAttempt>
}
export type SharedMutationResult =
  | { kind: 'applied'; revision: number }
  | { kind: 'stale'; revision: number }
  | { kind: 'failed'; revision: number }
  | { kind: 'unresolved'; revision: number }
export interface SharedChannelDeps {
  write?: (path: string, bytes: Uint8Array) => void
  realpath?: (path: string) => string
  incarnation?: () => string
  home?: string
  readFs?: Partial<PersonaConfigFs>
  /** Submitted input label, separate from the durable authority's path. */
  sourcePath?: string
  now?: () => number
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function clone<T>(value: T): T { return structuredClone(value) }
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}
function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true })
}
function declaration(persona: PersonaDeclaration): PersonaDeclaration {
  return { name: persona.name, credentials_file: persona.credentials_file, working_directory: persona.working_directory }
}
export function sameSharedDeclaration(a: PersonaDeclaration, b: PersonaDeclaration, realpath?: (path: string) => string): boolean {
  const same = (x: string, y: string) => x === y || resolveRealPath(x, realpath) === resolveRealPath(y, realpath)
  return a.name === b.name && same(a.credentials_file, b.credentials_file) && same(a.working_directory, b.working_directory)
}
function rawBytes(raw: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(raw, null, 2) + '\n')
}
function validInventoryIdentity(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const fields: unknown = JSON.parse(value)
    if (!Array.isArray(fields) || fields.length !== 4 || !fields.every(field => typeof field === 'string')) return false
    const identity = slackInstallationIdentity({ teamId: fields[0], appId: fields[1], botUserId: fields[2], botId: fields[3] })
    return !!identity && slackInstallationKey(identity) === value
  } catch { return false }
}
/** Automatic mutations may change channels only; every other applied field
 * belongs to the exact reviewed source. Object-key order is immaterial. */
function reviewedFields(raw: Record<string, unknown>): Record<string, unknown> {
  const copy = clone(raw)
  for (const persona of copy['personas'] as Record<string, unknown>[]) delete persona['channels']
  return copy
}
/** Check relationships after all evidence shapes have been validated. A
 * historical leave survives rejoin, but never grants current membership. */
function checkMembershipHistory(life: SharedPersona): void {
  const latest = new Map<string, SharedMembershipEvent>()
  const leaves = new Map<string, { event: string; boundary: number }>()
  const events = Object.entries(life.membershipEvents).sort(([, a], [, b]) => a.order - b.order)
  for (const [id, event] of events) {
    const previous = latest.get(event.channel)
    const boundary = !previous || previous.member !== event.member || previous.identity !== event.identity
      ? event.order : previous.boundary
    if ((previous && previous.order >= event.order) || event.boundary !== boundary) {
      throw new Error('The shared channel authority has inconsistent membership order.')
    }
    if (!event.member && previous?.member !== false) leaves.set(event.channel, { event: id, boundary })
    latest.set(event.channel, event)
  }
  if (latest.size !== Object.keys(life.membership).length || leaves.size !== Object.keys(life.leaves).length) {
    throw new Error('The shared channel authority has incomplete membership evidence.')
  }
  for (const [channel, event] of latest) {
    const membership = own(life.membership, channel)
    if (!membership || membership.member !== event.member || membership.identity !== event.identity || membership.boundary !== event.boundary) {
      throw new Error('The shared channel authority has inconsistent current membership evidence.')
    }
  }
  for (const [channel, expected] of leaves) {
    const leave = own(life.leaves, channel)
    const assignment = own(life.assignments, channel)
    if (!leave || leave.event !== expected.event || leave.boundary !== expected.boundary ||
        (assignment && assignment.order <= leave.boundary)) {
      throw new Error('The shared channel authority has inconsistent leave evidence.')
    }
  }
}
function checkAbsenceConflicts(life: SharedPersona, revision: number): void {
  if (life.membershipAbsenceConflicts === undefined) return
  if (!object(life.membershipAbsenceConflicts)) throw new Error('Invalid membership absence conflicts.')
  for (const [channel, conflict] of Object.entries(life.membershipAbsenceConflicts)) {
    const membership = own(life.membership, channel)
    const assignment = own(life.assignments, channel)
    if (!CHANNEL_ID_RE.test(channel) || !object(conflict) || Object.keys(conflict).length !== 6 ||
        !validInventoryIdentity(conflict.identity) || typeof conflict.observedThrough !== 'string' ||
        !MEMBERSHIP_TIMESTAMP_RE.test(conflict.observedThrough) ||
        !Number.isSafeInteger(conflict.boundary) || conflict.boundary < 1 ||
        !Number.isSafeInteger(conflict.observedRevision) || conflict.observedRevision < conflict.boundary ||
        !Number.isSafeInteger(conflict.assignmentOrder) || conflict.assignmentOrder <= conflict.observedRevision ||
        !Number.isSafeInteger(conflict.recordedOrder) || conflict.recordedOrder <= conflict.assignmentOrder || conflict.recordedOrder > revision ||
        !membership?.member || membership.identity !== conflict.identity || membership.boundary !== conflict.boundary ||
        !assignment || assignment.order < conflict.assignmentOrder ||
        Object.values(life.membershipEvents).some(event => event.channel === channel && event.member && event.order === conflict.assignmentOrder)) {
      throw new Error('Invalid membership absence conflict evidence.')
    }
  }
}
/** Read-only operator binding; no missing facts or mutation authority inferred. */
export function absenceReplacementBinding(state: SharedChannelState, key: string, channel: string): string | undefined {
  const life = own(state.personas, key)
  const conflict = life && own(life.membershipAbsenceConflicts ?? {}, channel)
  if (!life || !conflict || Object.values(life.membershipEvidence ?? {}).some(e => e.channel === channel && (e.state === 'pending' || e.state === 'conflict'))) return undefined
  return createHash('sha256').update(JSON.stringify([life.incarnation, channel, conflict, life.membership[channel], life.leaves[channel], life.assignments[channel]])).digest('hex')
}
function checkReplacedAbsences(life: SharedPersona, revision: number): void {
  if (life.replacedAbsences === undefined) return
  if (!object(life.replacedAbsences)) throw new Error('Invalid reviewed absence history.')
  for (const [binding, replacement] of Object.entries(life.replacedAbsences)) {
    if (!object(replacement)) throw new Error('Invalid reviewed absence history.')
    const conflict = replacement.conflict
    const event = life.membershipEvents[`reviewed-absence:${binding}`]
    if (!/^[a-f0-9]{64}$/.test(binding) || !object(replacement) ||
        Object.keys(replacement).length !== 6 ||
        replacement.assignmentOrder !== replacement.removedOrder + 1 || replacement.assignmentOrder > revision ||
        !Number.isSafeInteger(replacement.at) || replacement.at < 0 ||
        !CHANNEL_ID_RE.test(replacement.channel) || replacement.incarnation !== life.incarnation ||
        !Number.isSafeInteger(replacement.removedOrder) || replacement.removedOrder < 1 || replacement.removedOrder > revision ||
        !object(conflict) || Object.keys(conflict).length !== 6 || !validInventoryIdentity(conflict.identity) ||
        !MEMBERSHIP_TIMESTAMP_RE.test(conflict.observedThrough) || !Number.isSafeInteger(conflict.boundary) || conflict.boundary < 1 ||
        !Number.isSafeInteger(conflict.observedRevision) || conflict.observedRevision < conflict.boundary ||
        !Number.isSafeInteger(conflict.assignmentOrder) || conflict.assignmentOrder <= conflict.observedRevision ||
        !Number.isSafeInteger(conflict.recordedOrder) || conflict.recordedOrder <= conflict.assignmentOrder || conflict.recordedOrder >= replacement.removedOrder ||
        !event || event.channel !== replacement.channel || event.member || event.order !== replacement.removedOrder || event.identity !== conflict.identity) {
      throw new Error('Invalid reviewed absence history.')
    }
  }
}
function removedDestination(state: SharedChannelState, persona: Pick<Persona, 'key' | 'name' | 'credentials_file' | 'working_directory' | 'permission_prompts'>, realpath?: (path: string) => string): boolean {
  const life = own(state.personas, persona.key)
  const proof = life && own(life.removedDestinations, persona.permission_prompts)
  return !!(life && proof && proof.incarnation === life.incarnation &&
    sameSharedDeclaration(life.declaration, persona, realpath) &&
    rawPersona(state, persona.key)['permission_prompts'] === persona.permission_prompts &&
    own(life.leaves, persona.permission_prompts)?.event === proof.event &&
    own(life.leaves, persona.permission_prompts)?.boundary === proof.boundary)
}
function resetDestination(state: SharedChannelState, persona: Pick<Persona, 'key' | 'name' | 'credentials_file' | 'working_directory' | 'permission_prompts'>, realpath?: (path: string) => string): boolean {
  const life = own(state.personas, persona.key)
  const proof = life?.resetDestination
  const entries = state.source['personas']
  const source = Array.isArray(entries) ? entries.find(entry => object(entry) && typeof entry['name'] === 'string' && personaKey(entry['name']) === persona.key) : undefined
  return !!(life && proof && proof.incarnation === life.incarnation && proof.order === life.resetOrder &&
    proof.channel === persona.permission_prompts && sameSharedDeclaration(life.declaration, persona, realpath) &&
    rawPersona(state, persona.key)['permission_prompts'] === proof.channel && source?.['permission_prompts'] === proof.channel &&
    Array.isArray(source['channels']) && source['channels'].some((channel: unknown) => object(channel) && channel['id'] === proof.channel))
}
export function sharedAppliedConfig(state: SharedChannelState, path: string, deps: SharedChannelDeps = {}): PersonaConfig {
  return parsePersonaConfigBytes(rawBytes(state.applied), path, dirname(path), {
    home: deps.home, record: true,
    removedDestination: persona => removedDestination(state, persona, deps.realpath),
    resetDestination: persona => resetDestination(state, persona, deps.realpath),
  })
}
/** Strict envelope reader. A raw baseline still obeys the new schema; this
 * never reads or imports the removed delivery store or old configuration. */
export function parseSharedChannelState(bytes: Uint8Array, path: string, deps: SharedChannelDeps = {}): SharedChannelState | undefined {
  const value = parseConfigJsonBytes(bytes, path)
  if (!object(value) || value['format'] !== SHARED_CHANNEL_FORMAT) return undefined
  if (!Number.isSafeInteger(value['revision']) || (value['revision'] as number) < 1 ||
      !object(value['source']) || typeof value['sourceBytesBase64'] !== 'string' || !object(value['applied']) || !object(value['personas']) ||
      !object(value['pendingIntent']) || !object(value['outcomes']) || !object(value['retiredIdentities'])) throw new Error('The shared channel authority has an invalid envelope.')
  const state = value as unknown as SharedChannelState
  if (state.recovery !== undefined) validateSharedRecovery(state.recovery)
  if (Object.hasOwn(state.pendingIntent, 'operator')) validateOperatorIntent(state.pendingIntent['operator'])
  if (Object.hasOwn(state.outcomes, 'operatorReviews')) validateReviewLedger(state.outcomes['operatorReviews'], state.revision)
  if (state.recovery?.cancelled) {
    const intent = state.pendingIntent['operator'] as OperatorIntent | undefined
    if (!intent || intent.requested || reviewLedger(state)?.active || !Object.values(intent.requests).some(record =>
      record.generation === intent.generation && record.request.action === 'cancel')) throw new Error('Unconfirmed shared recovery cancellation.')
  }
  if (state.recovery?.phase === 'active') {
    const activation = state.recovery.activation!
    const outcome = reviewLedger(state)?.outcomes[activation.fingerprint]
    if (activation.order > state.revision || outcome?.status !== 'consumed' || outcome.revision !== activation.order) throw new Error('Unconfirmed shared recovery activation.')
  }
  if (state.recovery?.phase === 'review' && state.recovery.request.action === 'replace' &&
      state.sourceBytesBase64 !== state.recovery.request.replacement_source_base64) throw new Error('Changed explicit replacement input.')
  if (state.recovery?.phase === 'review' && state.recovery.request.action === 'restore') {
    const anchorBytes = Buffer.from(state.recovery.anchorBase64!, 'base64')
    // A stage may retain an applied anchor, never another unconfirmed stage.
    const rawAnchor = parseConfigJsonBytes(anchorBytes, path)
    if (!object(rawAnchor) || (object(rawAnchor['recovery']) && rawAnchor['recovery']['phase'] === 'review')) throw new Error('Unconfirmed restoration anchor.')
    const anchor = parseSharedChannelState(anchorBytes, path, deps)
    if (!anchor || anchor.revision >= state.revision ||
        !['source', 'sourceBytesBase64', 'applied', 'personas', 'retiredIdentities', 'pendingIntent'].every(field =>
          isDeepStrictEqual(state[field as keyof SharedChannelState], anchor[field as keyof SharedChannelState])) ||
        !isDeepStrictEqual({ ...state.outcomes, operatorReviews: undefined }, { ...anchor.outcomes, operatorReviews: undefined })) {
      throw new Error('Changed trustworthy restoration facts.')
    }
  }
  const sourceBytes = Buffer.from(state.sourceBytesBase64, 'base64')
  if (sourceBytes.toString('base64') !== state.sourceBytesBase64) throw new Error('The shared channel authority has invalid reviewed input evidence.')
  const incarnations = new Set<string>()
  for (const [key, life] of Object.entries(state.personas)) {
    if (!object(life) || typeof life.incarnation !== 'string' || !life.incarnation || !object(life.declaration) ||
        !['name', 'credentials_file', 'working_directory'].every(field => typeof life.declaration[field as keyof PersonaDeclaration] === 'string') ||
        !object(life.assignments) || !object(life.membership) || !object(life.membershipEvents) || !object(life.leaves) || !object(life.removedDestinations) ||
        incarnations.has(life.incarnation) || Object.hasOwn(state.retiredIdentities, life.incarnation) ||
        personaKey(life.declaration.name) !== key) throw new Error('The shared channel authority has an invalid persona incarnation.')
    incarnations.add(life.incarnation)
    if (life.resetOrder !== undefined && (!Number.isSafeInteger(life.resetOrder) || life.resetOrder < 1 || life.resetOrder > state.revision)) throw new Error('Invalid persona reset order.')
    if (life.createdAt !== undefined && (!Number.isSafeInteger(life.createdAt) || life.createdAt < 0)) throw new Error('Invalid persona reset time evidence.')
    if (life.resetDestination !== undefined) {
      const proof = life.resetDestination
      if (!object(proof) || Object.keys(proof).length !== 3 || !CHANNEL_ID_RE.test(proof.channel) ||
          proof.incarnation !== life.incarnation || proof.order !== life.resetOrder || !Number.isSafeInteger(proof.order) || proof.order <= 1 ||
          life.createdAt === undefined) throw new Error('Invalid destination reset evidence.')
    }
    if (life.membershipInventory !== undefined) {
      const inventory = life.membershipInventory
      if (!object(inventory) || Object.keys(inventory).length !== 5 || inventory.incarnation !== life.incarnation ||
          !validInventoryIdentity(inventory.identity) ||
          typeof inventory.observedThrough !== 'string' || !MEMBERSHIP_TIMESTAMP_RE.test(inventory.observedThrough) ||
          !Number.isSafeInteger(inventory.observedRevision) || inventory.observedRevision < 1 ||
          !Number.isSafeInteger(inventory.recordedOrder) || inventory.recordedOrder <= inventory.observedRevision || inventory.recordedOrder > state.revision) {
        throw new Error('Invalid complete membership inventory evidence.')
      }
    }
    if (life.installationReadiness !== undefined) validateMembershipSetupRecords(life.installationReadiness, state.revision)
    if (life.membershipEvidence !== undefined) {
      validateMembershipEvidence(life.membershipEvidence, state.revision)
      const leaveKey = (e: MembershipEvidence) => JSON.stringify([e.recordedOrder, e.channel, e.identity])
      const appliedLeaves = new Map(Object.values(life.membershipEvidence)
        .filter(e => !e.member && e.state === 'applied').map(e => [leaveKey(e), e]))
      for (const evidence of Object.values(life.membershipEvidence)) {
        if (evidence.originalEvent !== undefined && !own(life.membershipEvidence, evidence.originalEvent) && !own(life.membershipEvents, evidence.originalEvent)) {
          throw new Error('Missing original membership recovery evidence.')
        }
        if (evidence.originalEvent !== undefined && evidence.state === 'superseded') {
          const original = own(life.membershipEvidence, evidence.originalEvent)
          const laterLeave = appliedLeaves.get(leaveKey(evidence))
          if (!original || !laterLeave || own(life.membershipEvents, laterLeave.event)?.order !== evidence.recordedOrder ||
              original.channel !== evidence.channel || original.identity !== evidence.identity ||
              compareMembershipEventTimes(original.timestamp, laterLeave.timestamp) >= 0 ||
              compareMembershipEventTimes(evidence.timestamp, laterLeave.timestamp) >= 0) {
            throw new Error('Unproven membership supersession.')
          }
        }
        const event = own(life.membershipEvents, evidence.event)
        if (evidence.state === 'applied' && (!event || event.channel !== evidence.channel ||
            event.member !== evidence.member || event.identity !== evidence.identity)) {
          throw new Error('Inconsistent applied membership recovery evidence.')
        }
      }
    }
    for (const [id, assignment] of Object.entries(life.assignments)) {
      if (!CHANNEL_ID_RE.test(id) || !object(assignment) || !DELIVERY_MODES.includes(assignment.delivery) ||
          !Number.isSafeInteger(assignment.order) || assignment.order < 1 || assignment.order > state.revision) throw new Error('The shared channel authority has an invalid ordered assignment.')
    }
    for (const [id, membership] of Object.entries(life.membership)) {
      if (!CHANNEL_ID_RE.test(id) || !object(membership) || typeof membership.member !== 'boolean' ||
          typeof membership.identity !== 'string' || !membership.identity || !Number.isSafeInteger(membership.boundary) ||
          membership.boundary < 1 || membership.boundary > state.revision ||
          (membership.isExtSharedChannel !== undefined && typeof membership.isExtSharedChannel !== 'boolean') ||
          (membership.channelType !== undefined && membership.channelType !== 'channel' && membership.channelType !== 'group')) throw new Error('The shared channel authority has invalid membership evidence.')
      if (membership.observedThrough !== undefined && !MEMBERSHIP_TIMESTAMP_RE.test(membership.observedThrough)) throw new Error('Invalid membership observation boundary.')
    }
    for (const [event, observation] of Object.entries(life.membershipEvents)) {
      if (!event || !object(observation) || !CHANNEL_ID_RE.test(observation.channel) ||
          typeof observation.member !== 'boolean' || typeof observation.identity !== 'string' || !observation.identity ||
          !Number.isSafeInteger(observation.order) || observation.order < 1 || observation.order > state.revision ||
          !Number.isSafeInteger(observation.boundary) || observation.boundary < 1 || observation.boundary > observation.order) throw new Error('The shared channel authority has invalid ordered membership evidence.')
    }
    for (const records of [life.leaves, life.removedDestinations]) {
      for (const [id, proof] of Object.entries(records)) {
        if (!CHANNEL_ID_RE.test(id) || !object(proof) || typeof proof.event !== 'string' || !proof.event ||
            proof.incarnation !== life.incarnation || !Number.isSafeInteger(proof.boundary) ||
            proof.boundary < 1 || proof.boundary > state.revision) throw new Error('The shared channel authority has invalid removal provenance.')
      }
    }
    if (!key) throw new Error('The shared channel authority has an invalid persona key.')
  }
  for (const [incarnation, retired] of Object.entries(state.retiredIdentities)) {
    if (!object(retired) || retired.incarnation !== incarnation || typeof retired.key !== 'string' || !retired.key ||
        !Number.isSafeInteger(retired.order) || retired.order < 1 || retired.order > state.revision ||
        !object(retired.declaration) || !['name', 'credentials_file', 'working_directory'].every(field => typeof retired.declaration[field as keyof PersonaDeclaration] === 'string') ||
        personaKey(retired.declaration.name) !== retired.key || !incarnation ||
        !Array.isArray(retired.channels) || retired.channels.some(channel => !object(channel) || !CHANNEL_ID_RE.test(channel.id) || !DELIVERY_MODES.includes(channel.delivery)) ||
        new Set(retired.channels.map(channel => channel.id)).size !== retired.channels.length) throw new Error('The shared channel authority has invalid retired identity evidence.')
  }
  validateBotAttempts(state)
  for (const life of Object.values(state.personas)) {
    checkMembershipHistory(life)
    checkAbsenceConflicts(life, state.revision)
    checkReplacedAbsences(life, state.revision)
    for (const [channel, proof] of Object.entries(life.leaves)) {
      const event = own(life.membershipEvents, proof.event)
      if (!event || event.member || event.channel !== channel || event.boundary !== proof.boundary) throw new Error('The shared channel authority has inconsistent leave evidence.')
    }
    for (const [channel, proof] of Object.entries(life.removedDestinations)) {
      const leave = own(life.leaves, channel)
      if (!leave || leave.event !== proof.event || leave.boundary !== proof.boundary) throw new Error('The shared channel authority has inconsistent destination-removal evidence.')
    }
  }
  // Both raw inputs obey the final schema, including removed-key rejection.
  const config = sharedAppliedConfig(state, path, deps)
  parsePersonaConfigBytes(rawBytes(state.source), path, dirname(path), {
    home: deps.home, record: true,
    removedDestination: persona => removedDestination(state, persona, deps.realpath),
  })
  // Validate both representations before comparing them, so removed settings
  // still receive the actionable schema diagnostic even in a damaged envelope.
  parsePersonaConfigBytes(sourceBytes, path, dirname(path), {
    home: deps.home, record: true,
    removedDestination: persona => removedDestination(state, persona, deps.realpath),
  })
  if (!isDeepStrictEqual(parseConfigJsonBytes(sourceBytes, path), state.source)) throw new Error('The shared channel authority has inconsistent reviewed input evidence.')
  if (!isDeepStrictEqual(reviewedFields(state.source), reviewedFields(state.applied))) throw new Error('The shared channel authority has inconsistent reviewed and applied fields.')
  if (config.personas.length !== Object.keys(state.personas).length) throw new Error('The shared channel authority has inconsistent persona identities.')
  for (const persona of config.personas) {
    const life = own(state.personas, persona.key)
    if (!life || !sameSharedDeclaration(life.declaration, persona, deps.realpath) ||
        persona.channels.length !== Object.keys(life.assignments).length ||
        persona.channels.some(channel => own(life.assignments, channel.id)?.delivery !== channel.delivery)) throw new Error('The shared channel authority has inconsistent applied choices.')
    if (Object.keys(life.removedDestinations).some(channel => channel !== persona.permission_prompts)) {
      throw new Error('The shared channel authority has inconsistent destination-removal evidence.')
    }
    if (life.resetDestination && !resetDestination(state, persona, deps.realpath)) throw new Error('The shared channel authority has inconsistent destination-reset evidence.')
  }
  return state
}
export function serializeSharedChannelState(state: SharedChannelState): Uint8Array {
  return Buffer.from(JSON.stringify(state, null, 2) + '\n')
}
export function initialSharedChannelState(bytes: Uint8Array, config: PersonaConfig, incarnation: () => string = randomUUID): SharedChannelState {
  const raw = parseConfigJsonBytes(bytes, 'prepared configuration') as Record<string, unknown>
  const personas: Record<string, SharedPersona> = {}
  for (const persona of config.personas) {
    const assignments = Object.fromEntries(persona.channels.map(channel => [channel.id, { delivery: channel.delivery, order: 1 }]))
    put(personas, persona.key, { incarnation: incarnation(), resetOrder: 1, declaration: declaration(persona), assignments, membership: {}, membershipEvents: {}, leaves: {}, removedDestinations: {} })
  }
  return { format: SHARED_CHANNEL_FORMAT, revision: 1, source: clone(raw), sourceBytesBase64: Buffer.from(bytes).toString('base64'), applied: clone(raw), personas, retiredIdentities: {}, pendingIntent: {}, outcomes: {} }
}
function rawPersona(state: SharedChannelState, key: string): Record<string, unknown> {
  const entries = state.applied['personas']
  if (!Array.isArray(entries)) throw new Error('The shared channel authority has invalid applied personas.')
  const persona = entries.find(entry => object(entry) && typeof entry['name'] === 'string' && personaKey(entry['name']) === key)
  if (!persona) throw new Error('Unknown applied persona incarnation.')
  return persona
}
/** Apply to the sole authority's transaction draft. This performs no I/O and
 * publishes nothing; live effects and complete-inventory batches share it. */
export function applySharedMembership(
  next: SharedChannelState, order: number, key: string, incarnation: string, observation: VerifiedSharedMembership,
): void {
  const life = own(next.personas, key)
  if (!life || life.incarnation !== incarnation) throw new Error('Obsolete membership incarnation.')
  if (own(life.membershipAbsenceConflicts ?? {}, observation.channel)) throw new Error('Unresolved membership absence history.')
  const previous = own(life.membership, observation.channel)
  const boundary = previous?.boundary ?? 0
  if (!observation.event || !observation.identity || !CHANNEL_ID_RE.test(observation.channel) || observation.boundary !== boundary) throw new Error('Obsolete membership evidence.')
  const nextBoundary = previous?.member === observation.member && previous.identity === observation.identity ? boundary : order
  // Live effects do not erase a successful scan's historical watermark.
  // Otherwise a delayed event could cross that already reconciled past.
  const observedThrough = observation.observedThrough ?? (previous?.identity === observation.identity ? previous.observedThrough : undefined)
  put(life.membership, observation.channel, {
    member: observation.member, boundary: nextBoundary, identity: observation.identity,
    ...(observation.isExtSharedChannel !== undefined ? { isExtSharedChannel: observation.isExtSharedChannel } : {}),
    ...(observation.channelType !== undefined ? { channelType: observation.channelType } : {}),
    ...(observedThrough !== undefined ? { observedThrough } : {}),
  })
  put(life.membershipEvents, observation.event, { channel: observation.channel, member: observation.member, identity: observation.identity, order, boundary: nextBoundary })
  if (observation.evidence) {
    const evidence = observation.evidence
    if (evidence.event !== observation.event || evidence.channel !== observation.channel ||
        evidence.member !== observation.member || evidence.identity !== observation.identity) throw new Error('Mismatched membership recovery evidence.')
    life.membershipEvidence ??= {}
    put(life.membershipEvidence, evidence.event, { ...evidence, state: 'applied', recordedOrder: order })
  }
  const raw = rawPersona(next, key)
  if (!observation.member && previous?.member !== false) {
    delete life.assignments[observation.channel]
    const leave = { event: observation.event, boundary: nextBoundary, incarnation }
    put(life.leaves, observation.channel, leave)
    if (raw['permission_prompts'] === observation.channel) put(life.removedDestinations, observation.channel, leave)
  } else if (observation.member && !own(life.assignments, observation.channel)) {
    put(life.assignments, observation.channel, { delivery: next.applied['channel_mode'] === 'open' ? 'mentions' : 'off', order })
  }
  raw['channels'] = Object.entries(life.assignments).map(([id, assignment]) => ({ id, delivery: assignment.delivery }))
}
export interface ReviewedAssignment { key: string; channel: string; delivery: DeliveryMode; incarnation?: string; absenceReplacement?: string }
export interface ReviewedChannelEffect {
  key: string
  channel: string
  kind: 'declared' | 'edited' | 'copied' | 'omitted' | 'automatic' | 'reset'
  saved?: DeliveryMode
  inherited?: DeliveryMode
  reviewed?: DeliveryMode
  previousOrder?: number
  replacement: boolean
  absenceReplacement?: string
}
export interface ReviewedChannelPlan { config: PersonaConfig; channels: ReviewedChannelEffect[] }
/** Provenance for later participation clearing. This token proves only a
 * durable lifetime, never current membership or permission to enroll. A
 * consumer holds only obligations for its current token. A durable leave or
 * reset supersedes old obligations; late completions cannot acknowledge or
 * enroll under a new token. Accepted queues do not consume this authority. */
export interface SharedChannelLifetime {
  key: string
  channel: string
  incarnation: string
  resetOrder: number
  createdAt?: number
  membershipBoundary: number
  leaveBoundary: number
}
export type SharedLifetimeStatus = 'current' | 'superseded' | 'unresolved'
export function sharedChannelLifetime(state: SharedChannelState, key: string, channel: string): SharedChannelLifetime | undefined {
  const life = own(state.personas, key)
  if (!life || !CHANNEL_ID_RE.test(channel)) return undefined
  return { key, channel, incarnation: life.incarnation, resetOrder: life.resetOrder ?? 1,
    createdAt: life.createdAt, membershipBoundary: own(life.membership, channel)?.boundary ?? 0,
    leaveBoundary: own(life.leaves, channel)?.boundary ?? 0 }
}
/** A deterministic proposed transition, not an applied life. Refreshes and
 * activation derive it from the same current/retired identity provenance;
 * assignments and metadata writes cannot mint another replacement identity. */
export function reviewedReplacementIncarnation(state: SharedChannelState, path: string, target: PersonaDeclaration, realpath?: (path: string) => string): string {
  const key = personaKey(target.name)
  const location = (value: PersonaDeclaration) => [resolveRealPath(value.credentials_file, realpath), resolveRealPath(value.working_directory, realpath)]
  const targetLocation = location(target)
  const relevant = (entry: { declaration: PersonaDeclaration }, entryKey: string) => entryKey === key || isDeepStrictEqual(location(entry.declaration), targetLocation)
  const current = Object.entries(state.personas).filter(([entryKey, life]) => relevant(life, entryKey)).map(([, life]) => life.incarnation).sort()
  const retired = Object.values(state.retiredIdentities).filter(life => relevant(life, life.key)).map(life => life.incarnation).sort()
  return createHash('sha256').update(JSON.stringify(['cscb-reviewed-persona-v1', path, key, target.name, targetLocation, current, retired, state.recovery?.boundary])).digest('hex')
}
export type OperatorRequestResult = { kind: 'recorded' | 'duplicate' | 'invalid' | 'stale' | 'failed' | 'unresolved'; generation: number }

export interface SharedChannelAuthority {
  readonly path: string
  readonly readable: boolean
  /** Unchanged projections remain usable after an ambiguous whole-file write.
   * This never grants another write against the uncertain revision. */
  readableFor(key: string, channel?: string): boolean
  readonly revision: number
  /** Echo-safe filesystem cause of the last failed mutation, when available. */
  readonly failure: string
  /** Finish the exact post-rename transaction, without another assignment
   * position or a guessed rollback. No-op when already trustworthy. */
  recoverDurability(): SharedMutationResult
  /** Preserve this owner's latest validated state for operator review after
   * restart. Never accepts an external snapshot or publishes staged choices. */
  stageRestoration(request: SharedRecoveryRequest, evidence: Uint8Array, prepared: Uint8Array): SharedMutationResult
  snapshot(): SharedChannelState
  config(): PersonaConfig
  sourceBytes(): Buffer
  incarnation(key: string): string | undefined
  reviewHeld(key: string): boolean
  lifetime(key: string, channel: string): SharedChannelLifetime | undefined
  /** Uncertainty holds the affected consumer. Supersession invalidates old
   * callbacks and releases their hold on the new lifetime; neither status
   * supplies current membership or confirms clearing of the new token. */
  lifetimeStatus(token: SharedChannelLifetime): SharedLifetimeStatus
  isCurrentLifetime(token: SharedChannelLifetime): boolean
  choice(key: string, channel: string): DeliveryMode | undefined
  channels(key: string): string[]
  validatesRemovedDestination(persona: Pick<Persona, 'key' | 'name' | 'credentials_file' | 'working_directory' | 'permission_prompts'>): boolean
  subscribe(listener: (config: PersonaConfig) => void): () => void
  operatorIntent(): OperatorIntent
  requestReview(request: ReviewRequest, bytes: Uint8Array): OperatorRequestResult
  declaredAssignments(bytes: Uint8Array): ReviewedAssignment[]
  /** The sole mutation boundary. Callback errors and stale revisions write
   * nothing. A batch may reserve multiple ordered positions in one write;
   * the callback receives the final position and publishes only that revision. */
  transact(expectedRevision: number, change: (next: SharedChannelState, order: number) => void, orderSpan?: number, publish?: (config: PersonaConfig) => void): SharedMutationResult
  previewReviewed(bytes: Uint8Array, assignments?: readonly ReviewedAssignment[]): PersonaConfig
  planReviewed(bytes: Uint8Array, assignments?: readonly ReviewedAssignment[]): ReviewedChannelPlan
  applyReviewed(bytes: Uint8Array, expectedRevision: number, assignments?: readonly ReviewedAssignment[]): SharedMutationResult
  commitReview(bytes: Uint8Array, expectedRevision: number, review: DurableReview, assignments: readonly ReviewedAssignment[], publish?: (config: PersonaConfig) => void): SharedMutationResult
  observeMembership(key: string, incarnation: string, observation: VerifiedSharedMembership, expectedRevision: number): SharedMutationResult
  assign(key: string, incarnation: string, channel: string, delivery: DeliveryMode, expectedRevision: number): SharedMutationResult
  /** undefined means no retained binding, not proof of nonapplication. */
  lookupBotAttempt(key: string, incarnation: string, request: ChannelDeliveryAttemptRequest): BotAttemptResult | undefined
  botAttempt(key: string, incarnation: string, request: ChannelDeliveryAttemptRequest,
    authorize: () => BotAttemptAuthorization, applied?: (outcome: Extract<SharedBotAttempt, { status: 'applied' }>) => void): BotAttemptResult
}
export function createSharedChannelAuthority(path: string, initial: SharedChannelState, deps: SharedChannelDeps = {}): SharedChannelAuthority {
  const validated = parseSharedChannelState(serializeSharedChannelState(initial), path, deps)
  if (!validated) throw new Error('The shared channel authority has an invalid envelope.')
  let current = validated
  let readable = true
  let uncertain: SharedChannelState | undefined
  let uncertainPublish: ((config: PersonaConfig) => void) | undefined
  let recoveryStaged = false
  let mutating = false
  let failure = ''
  const write = deps.write ?? durableWriteFileSync
  const listeners = new Set<(config: PersonaConfig) => void>()
  // Only closes synchronous reentrancy and undurable binding failures. Durable
  // evidence always wins; this map is never recovery authority after restart.
  const attemptsInFlight = new Map<string, { binding: BotAttemptBinding; kind: 'pending' | 'unresolved' }>()
  function writeBotOutcome(record: SharedBotAttempt, activate = false, publish?: (config: PersonaConfig) => void): SharedMutationResult {
    return authority.transact(authority.revision, (next, order) => {
      const life = own(next.personas, record.key)
      if (life?.incarnation !== record.incarnation || authority.reviewHeld(record.key)) throw new Error('Obsolete bot attempt life.')
      if (record.status === 'pending') record = { ...record, startedOrder: order }
      else record = { ...record, resolvedOrder: order }
      next.outcomes.botAttempts ??= {}
      put(next.outcomes.botAttempts, botAttemptKey(record), record)
      if (activate && record.status === 'applied') {
        put(life.assignments, record.channel, { delivery: record.delivery, order })
        rawPersona(next, record.key)['channels'] = Object.entries(life.assignments).map(([id, assignment]) => ({ id, delivery: assignment.delivery }))
      }
    }, 1, publish)
  }
  function performBotAttempt(key: string, incarnation: string, request: ChannelDeliveryAttemptRequest,
    authorize: () => BotAttemptAuthorization, applied?: (outcome: Extract<SharedBotAttempt, { status: 'applied' }>) => void): BotAttemptResult {
    const prior = authority.lookupBotAttempt(key, incarnation, request)
    if (prior) return prior
    if (request.intent === 'retry') return { kind: 'unresolved' }
    // Strict and dry-run callers only look up history. The MCP caller gates
    // these before entry, so neither bindings nor refusals write in those modes.
    if (current.applied['channel_mode'] !== 'open' || authority.reviewHeld(key)) return { kind: 'inactive' }
    const binding = botAttemptBinding(key, incarnation, request)
    const id = botAttemptKey(binding)
    attemptsInFlight.set(id, { binding, kind: 'pending' })
    try {
      const start = writeBotOutcome({ ...binding, startedOrder: 0, status: 'pending' })
      if (start.kind !== 'applied') return { kind: 'unresolved' }
      const pending = own(current.outcomes.botAttempts!, id)!
      let permission: BotAttemptAuthorization
      try { permission = authorize() } catch { permission = { kind: 'refused', reason: 'inactive' } }
      if (current.applied['channel_mode'] !== 'open') permission = { kind: 'refused', reason: 'strict' }
      const outcome: SharedBotAttempt = permission.kind === 'authorized'
        ? { ...pending, status: 'applied', resolvedOrder: 0, facts: permission.facts,
          ...(authority.choice(key, request.channel) === undefined ? {} : { previous: authority.choice(key, request.channel) }) }
        : { ...pending, status: 'not-applied', resolvedOrder: 0, reason: permission.reason }
      const publish = outcome.status === 'applied' ? () => {
        const committed = own(current.outcomes.botAttempts!, id)
        if (committed?.status === 'applied') applied?.(clone(committed))
      } : undefined
      const result = writeBotOutcome(outcome, outcome.status === 'applied', publish)
      if (result.kind === 'applied') {
        const recorded = botAttemptResult(own(current.outcomes.botAttempts!, id)!)
        return recorded.kind === 'applied' ? { ...recorded, historical: false } : recorded
      }
      if (result.kind === 'failed' && readable && authority.incarnation(key) === incarnation) {
        // A pre-rename failure proves this application did not happen. Retain
        // that proof before promising a restart-safe rejection.
        const rejected = writeBotOutcome({ ...pending, status: 'not-applied', resolvedOrder: 0, reason: 'write-failed' })
        if (rejected.kind === 'applied') return { kind: 'not-applied', reason: 'write-failed' }
      }
      return { kind: 'unresolved' }
    } finally {
      attemptsInFlight.set(id, { binding, kind: 'unresolved' })
      // Durable terminal outcomes need no volatile guard. Pending evidence
      // stays pending across reopen and can never be independently applied.
      if (own(current.outcomes.botAttempts ?? {}, id)) attemptsInFlight.delete(id)
    }
  }
  function publishChange(before: SharedChannelState, publish?: (config: PersonaConfig) => void): void {
    // Runtime publication precedes observers while the mutation lock is held.
    try { publish?.(authority.config()) } catch { /* durability cannot be undone by a publisher */ }
    if (!isDeepStrictEqual(before.applied, current.applied) || !isDeepStrictEqual(before.personas, current.personas) ||
        !isDeepStrictEqual(before.retiredIdentities, current.retiredIdentities)) {
      for (const listener of [...listeners]) {
        try { listener(authority.config()) } catch { /* an observer cannot undo durability */ }
      }
    }
  }
  function candidateInput(bytes: Uint8Array): PersonaConfig {
    // Exact recorded input keeps record-start collision recovery available
    // for credential-only reviews. Edited input still needs full validation.
    const recorded = Buffer.from(bytes).equals(authority.sourceBytes())
    return parsePersonaConfigBytes(bytes, deps.sourcePath ?? path, dirname(path), {
      home: deps.home, record: recorded, removedDestination: persona => authority.validatesRemovedDestination(persona),
    })
  }
  function validateDeclarations(intent: OperatorIntent, bytes: Uint8Array): ReviewedAssignment[] {
    if (intent.assignments.length === 0) return []
    const candidate = candidateInput(bytes)
    return intent.assignments.map(assignment => {
      const persona = candidate.personas.find(p => p.key === assignment.key)
      const normalized = { ...assignment.declaration,
        credentials_file: expandTilde(assignment.declaration.credentials_file, deps.home),
        working_directory: expandTilde(assignment.declaration.working_directory, deps.home) }
      if (!persona || !sameSharedDeclaration(persona, normalized, deps.realpath) ||
          (authority.incarnation(assignment.key) ?? null) !== assignment.incarnation) throw new Error('The declared assignment targets an obsolete persona life or declaration; revise the operator request.')
      // Replacement identity is bound by declaration plus the old life, not
      // an independently minted preview incarnation.
      const same = assignment.incarnation !== null && sameSharedDeclaration(current.personas[assignment.key]!.declaration, persona, deps.realpath)
      if (assignment.absence_replacement !== undefined && (!same || absenceReplacementBinding(current, assignment.key, assignment.channel) !== assignment.absence_replacement)) throw new Error('The explicit absence replacement is obsolete; review its current boundary and losses again.')
      return { key: assignment.key, channel: assignment.channel, delivery: assignment.delivery,
        ...(assignment.absence_replacement === undefined ? {} : { absenceReplacement: assignment.absence_replacement }),
        ...(same ? { incarnation: assignment.incarnation! } : {}) }
    })
  }
  function prepareReviewed(next: SharedChannelState, order: number, bytes: Uint8Array, explicit: readonly ReviewedAssignment[], effects?: ReviewedChannelEffect[]): void {
    const candidate = candidateInput(bytes)
    const source = parseConfigJsonBytes(bytes, deps.sourcePath ?? path) as Record<string, unknown>
    const oldSource = parsePersonaConfigBytes(rawBytes(current.source), path, dirname(path), {
      home: deps.home, record: true, removedDestination: persona => authority.validatesRemovedDestination(persona),
    })
    const oldConfig = authority.config()
    const assignmentKeys = new Set<string>()
    for (const assignment of explicit) {
      const key = JSON.stringify([assignment.key, assignment.channel])
      if (assignmentKeys.has(key) || !candidate.personas.some(persona => persona.key === assignment.key)) throw new Error('Invalid or obsolete reviewed assignment.')
      assignmentKeys.add(key)
    }
    const personas: Record<string, SharedPersona> = {}
    for (const old of oldConfig.personas) {
      const replacement = candidate.personas.find(persona => persona.key === old.key)
      const life = own(current.personas, old.key)!
      if (!replacement || !sameSharedDeclaration(old, replacement, deps.realpath)) {
        for (const [channel, assignment] of Object.entries(life.assignments)) effects?.push({
          key: old.key, channel, kind: 'reset', saved: assignment.delivery, previousOrder: assignment.order, replacement: true,
        })
        put(next.retiredIdentities, life.incarnation, {
          key: old.key, declaration: declaration(old), incarnation: life.incarnation, order,
          channels: oldSource.personas.find(persona => persona.key === old.key)?.channels ?? [],
        })
      }
    }
    const sameLocation = (a: PersonaDeclaration, b: PersonaDeclaration) =>
      resolveRealPath(a.credentials_file, deps.realpath) === resolveRealPath(b.credentials_file, deps.realpath) &&
      resolveRealPath(a.working_directory, deps.realpath) === resolveRealPath(b.working_directory, deps.realpath)
    for (const persona of candidate.personas) {
      const oldLife = own(current.personas, persona.key)
      const same = oldLife && sameSharedDeclaration(oldLife.declaration, persona, deps.realpath)
      const life: SharedPersona = same ? clone(oldLife) : {
        incarnation: reviewedReplacementIncarnation(current, path, persona, deps.realpath), resetOrder: order, createdAt: (deps.now ?? Date.now)(), declaration: declaration(persona), assignments: {}, membership: {}, membershipEvents: {}, leaves: {}, removedDestinations: {},
      }
      life.declaration = declaration(persona)
      const retired = Object.values(current.retiredIdentities).filter(p => p.key === persona.key || sameLocation(p.declaration, persona))
        .sort((a, b) => b.order - a.order || Number(b.key === persona.key) - Number(a.key === persona.key) || a.incarnation.localeCompare(b.incarnation))[0]
      const previous = oldSource.personas.find(p => p.key === persona.key) ??
        oldSource.personas.find(p => sameLocation(p, persona)) ??
        retired
      const previousChoices = new Map(previous?.channels.map(c => [c.id, c.delivery]) ?? [])
      const edited = new Set<string>()
      for (const channel of persona.channels) {
        // A copied field never overwrites an automatic choice, and a
        // replacement cannot inherit a preference from the old life.
        const changed = !previousChoices.has(channel.id) || previousChoices.get(channel.id) !== channel.delivery
        if (!previous || changed) {
          put(life.assignments, channel.id, { delivery: channel.delivery, order })
          edited.add(channel.id)
        }
      }
      for (const assignment of explicit.filter(a => a.key === persona.key)) {
        if (assignment.incarnation !== undefined && assignment.incarnation !== life.incarnation) throw new Error('Obsolete reviewed assignment.')
        if (!CHANNEL_ID_RE.test(assignment.channel) || !DELIVERY_MODES.includes(assignment.delivery)) throw new Error('Invalid reviewed assignment.')
        if (assignment.absenceReplacement !== undefined) {
          const binding = assignment.absenceReplacement
          if (!same || absenceReplacementBinding(current, persona.key, assignment.channel) !== binding) throw new Error('Obsolete absence replacement.')
          const conflict = life.membershipAbsenceConflicts![assignment.channel]!
          const removedOrder = order - 1
          const event = `reviewed-absence:${binding}`
          const leave = { event, boundary: removedOrder, incarnation: life.incarnation }
          life.replacedAbsences ??= {}
          put(life.replacedAbsences, binding, { channel: assignment.channel, incarnation: life.incarnation, conflict: clone(conflict), removedOrder, assignmentOrder: order, at: (deps.now ?? Date.now)() })
          delete life.membershipAbsenceConflicts![assignment.channel]
          put(life.membership, assignment.channel, { member: false, identity: conflict.identity, boundary: removedOrder, observedThrough: conflict.observedThrough })
          put(life.membershipEvents, event, { channel: assignment.channel, member: false, identity: conflict.identity, order: removedOrder, boundary: removedOrder })
          put(life.leaves, assignment.channel, leave)
          if (persona.permission_prompts === assignment.channel) put(life.removedDestinations, assignment.channel, leave)
        }
        put(life.assignments, assignment.channel, { delivery: assignment.delivery, order })
      }
      const inputChannels = new Set(persona.channels.map(c => c.id))
      if (!same && previous && inputChannels.has(persona.permission_prompts) && !own(life.assignments, persona.permission_prompts)) {
        life.resetDestination = { channel: persona.permission_prompts, incarnation: life.incarnation, order }
      }
      if (life.resetDestination && (life.resetDestination.channel !== persona.permission_prompts || !inputChannels.has(persona.permission_prompts))) delete life.resetDestination
      const declared = new Set(explicit.filter(a => a.key === persona.key).map(a => a.channel))
      for (const channel of new Set([...inputChannels, ...Object.keys(life.assignments)])) {
        const before = same ? own(oldLife.assignments, channel) : undefined
        effects?.push({ key: persona.key, channel,
          kind: declared.has(channel) ? 'declared' : edited.has(channel) ? 'edited' : inputChannels.has(channel) ? 'copied' :
            previousChoices.has(channel) ? 'omitted' : 'automatic',
          saved: before?.delivery, previousOrder: before?.order, reviewed: own(life.assignments, channel)?.delivery, replacement: !same && !!(oldLife || previous),
          inherited: !same ? previousChoices.get(channel) : undefined,
          absenceReplacement: explicit.find(a => a.key === persona.key && a.channel === channel)?.absenceReplacement,
        })
      }
      const old = oldConfig.personas.find(p => p.key === persona.key)
      if (old?.permission_prompts !== persona.permission_prompts) life.removedDestinations = {}
      put(personas, persona.key, life)
      const raw = (source['personas'] as Record<string, unknown>[])[persona.index]!
      raw['channels'] = Object.entries(life.assignments).map(([id, assignment]) => ({ id, delivery: assignment.delivery }))
    }
    next.personas = personas
    next.applied = source
    // Preserve the submitted source independently of the merged result.
    next.source = parseConfigJsonBytes(bytes, deps.sourcePath ?? path) as Record<string, unknown>
    next.sourceBytesBase64 = Buffer.from(bytes).toString('base64')
    // Intent consumption belongs to its explicit review transaction. Recording
    // these bytes alone cannot consume unrelated pending work or outcomes.
  }
  const authority: SharedChannelAuthority = {
    path,
    get readable() { return readable },
    readableFor(key, channel) {
      if (authority.reviewHeld(key)) return false
      if (readable) return true
      if (!uncertain) return false
      const before = own(current.personas, key)
      const after = own(uncertain.personas, key)
      if (!before || !after || before.incarnation !== after.incarnation) return false
      const oldRaw = rawPersona(current, key)
      const newRaw = rawPersona(uncertain, key)
      if (!channel) return isDeepStrictEqual(oldRaw, newRaw)
      if (channel.startsWith('D')) return isDeepStrictEqual(oldRaw['dm'], newRaw['dm'])
      if (current.applied['channel_mode'] !== uncertain.applied['channel_mode']) return false
      const destinations = (state: SharedChannelState) => (state.applied['personas'] as Record<string, unknown>[])
        .filter(persona => persona['permission_prompts'] === channel).map(persona => persona['name']).sort()
      return isDeepStrictEqual(destinations(current), destinations(uncertain)) &&
        isDeepStrictEqual(own(before.assignments, channel), own(after.assignments, channel)) &&
        isDeepStrictEqual(own(before.membership, channel), own(after.membership, channel)) &&
        isDeepStrictEqual(own(before.leaves, channel), own(after.leaves, channel)) &&
        isDeepStrictEqual(own(before.membershipAbsenceConflicts ?? {}, channel), own(after.membershipAbsenceConflicts ?? {}, channel))
    },
    get revision() { return current.revision },
    get failure() { return failure },
    recoverDurability() {
      if (recoveryStaged) return { kind: 'unresolved', revision: current.revision }
      if (readable) return { kind: 'applied', revision: current.revision }
      if (mutating || !uncertain) return { kind: 'unresolved', revision: current.revision }
      const before = current
      const recovered = uncertain
      const publish = uncertainPublish
      mutating = true
      try {
        // The rename already installed these exact validated bytes. Repeating
        // their durable write finishes that outcome, never invents old-state
        // rollback or assigns again at a later revision.
        const bytes = serializeSharedChannelState(recovered)
        if (!Buffer.from(readPersonaConfigBytes(path, deps.readFs)).equals(Buffer.from(bytes))) throw new Error('Uncertain authority evidence changed; preserve it for reviewed recovery.')
        write(path, bytes)
        current = recovered
        uncertain = undefined
        uncertainPublish = undefined
        readable = true
        failure = ''
      } catch (err) {
        failure = errnoSuffix(err)
        mutating = false
        return { kind: 'unresolved', revision: current.revision }
      }
      try { publishChange(before, publish) } finally { mutating = false }
      return { kind: 'applied', revision: current.revision }
    },
    stageRestoration(request, evidence, prepared) {
      if (mutating || recoveryStaged || request.action !== 'restore' || recoveryHash(evidence) !== request.evidence_sha256) return { kind: 'stale', revision: current.revision }
      const anchor = uncertain ?? current
      let staged: SharedChannelState
      try {
        if (!Buffer.from(readPersonaConfigBytes(path, deps.readFs)).equals(Buffer.from(evidence))) return { kind: 'stale', revision: current.revision }
        // An independently installed valid authority is not evidence that this
        // running owner's older memory may overwrite it.
        let installed: SharedChannelState | undefined
        try { installed = parseSharedChannelState(evidence, path, deps) } catch { /* damaged evidence is preserved below */ }
        if (installed && !isDeepStrictEqual(installed, anchor)) return { kind: 'stale', revision: current.revision }
        if (readable && installed) return { kind: 'stale', revision: current.revision }
        staged = clone(anchor)
        staged.revision++
        staged.recovery = { boundary: (deps.incarnation ?? randomUUID)(), phase: 'review', request: clone(request),
          evidenceBase64: Buffer.from(evidence).toString('base64'), preparedBase64: Buffer.from(prepared).toString('base64'),
          anchorBase64: Buffer.from(serializeSharedChannelState(anchor)).toString('base64') }
        if (!parseSharedChannelState(serializeSharedChannelState(staged), path, deps)) throw new Error('Invalid recovery stage.')
      } catch (err) { failure = errnoSuffix(err); return { kind: 'failed', revision: current.revision } }
      mutating = true
      try { write(path, serializeSharedChannelState(staged)) }
      catch (err) {
        failure = errnoSuffix(err)
        if (!(err instanceof DurableWriteUnsyncedError)) { mutating = false; return { kind: 'failed', revision: current.revision } }
      }
      // Freeze ordinary mutation in this process. Unchanged projections and
      // accepted queues can progress; activation belongs to the next start.
      recoveryStaged = true
      readable = false
      uncertain = staged
      mutating = false
      return { kind: 'unresolved', revision: current.revision }
    },
    snapshot: () => clone(current),
    config: () => sharedAppliedConfig(current, path, deps),
    choice: (key, channel) => { const life = own(current.personas, key); return life ? own(life.assignments, channel)?.delivery : undefined },
    channels: key => { const life = own(current.personas, key); return life ? Object.keys(life.assignments).sort() : [] },
    lookupBotAttempt(key, incarnation, request) {
      if (!validChannelDeliveryAttempt(request)) return { kind: 'invalid' }
      if (authority.incarnation(key) !== incarnation || authority.reviewHeld(key)) return { kind: 'inactive' }
      const binding = botAttemptBinding(key, incarnation, request)
      const id = botAttemptKey(binding)
      const record = own(current.outcomes.botAttempts ?? {}, id)
      // Uncertainty in unrelated metadata/choices cannot erase a previously
      // durable history fact. A changed outcome or incarnation stays held.
      if (!readable && (!record || !uncertain || own(uncertain.personas, key)?.incarnation !== incarnation ||
          !isDeepStrictEqual(record, own(uncertain.outcomes.botAttempts ?? {}, id)))) return { kind: 'unresolved' }
      const running = attemptsInFlight.get(id)
      if (record) return sameBotAttempt(record, binding) ? botAttemptResult(record) : { kind: 'binding-conflict' }
      if (running) return sameBotAttempt(running.binding, binding) ? { kind: running.kind } : { kind: 'binding-conflict' }
      return undefined
    },
    botAttempt: performBotAttempt,
    sourceBytes: () => Buffer.from(current.sourceBytesBase64, 'base64'),
    incarnation: key => own(current.personas, key)?.incarnation,
    reviewHeld: key => current.recovery?.phase === 'review' || reviewLedger(current)?.retirement?.recovery.keys.includes(key) === true,
    lifetime: (key, channel) => sharedChannelLifetime(current, key, channel),
    lifetimeStatus: token => !authority.readableFor(token.key, token.channel) ? 'unresolved' :
      isDeepStrictEqual(sharedChannelLifetime(current, token.key, token.channel), token) ? 'current' : 'superseded',
    isCurrentLifetime: token => authority.lifetimeStatus(token) === 'current',
    validatesRemovedDestination: persona => removedDestination(current, persona, deps.realpath),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    operatorIntent: () => clone((own(current.pendingIntent, 'operator') as OperatorIntent | undefined) ?? emptyOperatorIntent()),
    declaredAssignments: bytes => validateDeclarations(authority.operatorIntent(), bytes),
    requestReview(input, bytes) {
      const intent = authority.operatorIntent()
      const answer = (kind: OperatorRequestResult['kind']): OperatorRequestResult => ({ kind, generation: authority.operatorIntent().generation })
      const request = parseReviewRequest(input)
      if (!request) return answer('invalid')
      const prior = own(intent.requests, request.request_id)
      if (prior) return answer(isDeepStrictEqual(prior.request, request) ? 'duplicate' : 'invalid')
      if (request.intent_generation !== intent.generation || (request.action === 'request' && intent.requested)) return answer('stale')
      if (request.action === 'request' || request.action === 'revise') intent.assignments = request.assignments
      if (request.action === 'cancel') intent.assignments = []
      intent.requested = request.action !== 'cancel'
      try { if (intent.requested) validateDeclarations(intent, bytes) } catch { return answer('invalid') }
      intent.generation++
      put(intent.requests, request.request_id, { request, generation: intent.generation })
      const result = authority.transact(authority.revision, (next, order) => {
        put(next.pendingIntent, 'operator', intent)
        if (request.action === 'cancel' && next.recovery?.phase === 'review' && next.recovery.request.action === 'replace') {
          next.recovery.cancelled = true
          supersedeReview(next, order)
        }
      })
      return answer(result.kind === 'applied' ? 'recorded' : result.kind)
    },
    transact(expectedRevision, change, orderSpan = 1, publish) {
      if (!readable) return { kind: 'unresolved', revision: current.revision }
      if (mutating || expectedRevision !== current.revision) return { kind: 'stale', revision: current.revision }
      if (!Number.isSafeInteger(orderSpan) || orderSpan < 1 || !Number.isSafeInteger(current.revision + orderSpan)) return { kind: 'failed', revision: current.revision }
      const next = clone(current)
      const before = current
      next.revision += orderSpan
      const appliedRevision = next.revision
      let prepared: SharedChannelState | undefined
      mutating = true
      failure = ''
      try {
        change(next, next.revision)
        if (next.revision !== appliedRevision) throw new Error('Invalid shared application order.')
        const bytes = serializeSharedChannelState(next)
        const published = parseSharedChannelState(bytes, path, deps)
        if (!published) throw new Error('Invalid shared authority format.')
        prepared = published
        write(path, bytes)
        current = published
      } catch (err) {
        mutating = false
        failure = errnoSuffix(err)
        // Never overwrite ambiguous evidence with a rollback or allow another
        // writer to decide that the old memory won after an unsynced rename.
        if (err instanceof DurableWriteUnsyncedError) {
          readable = false
          uncertain = prepared
          uncertainPublish = publish
          return { kind: 'unresolved', revision: current.revision }
        }
        return { kind: 'failed', revision: current.revision }
      }
      try {
        // Metadata has durable order, but no applied publication or assignment.
        publishChange(before, publish)
      } finally {
        mutating = false
      }
      return { kind: 'applied', revision: appliedRevision }
    },
    observeMembership(key, incarnation, observation, expectedRevision) {
      if (!readable) return { kind: 'unresolved', revision: current.revision }
      if (mutating) return { kind: 'stale', revision: current.revision }
      const original = own(current.personas, key)
      if (!original || original.incarnation !== incarnation) return { kind: 'stale', revision: current.revision }
      const recorded = own(original.membershipEvents, observation.event)
      if (recorded) {
        const evidence = own(original.membershipEvidence ?? {}, observation.event)
        const samePayload = !observation.evidence || (evidence?.state === 'applied' &&
          evidence.event === observation.evidence.event && evidence.originalEvent === observation.evidence.originalEvent &&
          membershipPayloadIdentity(evidence) === membershipPayloadIdentity(observation.evidence))
        return { kind: samePayload && recorded.channel === observation.channel && recorded.member === observation.member && recorded.identity === observation.identity ? 'applied' : 'failed', revision: recorded.order }
      }
      return authority.transact(expectedRevision, (next, order) => {
        applySharedMembership(next, order, key, incarnation, observation)
      })
    },
    assign(key, incarnation, channel, delivery, expectedRevision) {
      if (!readable || authority.reviewHeld(key)) return { kind: 'unresolved', revision: current.revision }
      const original = own(current.personas, key)
      if (!original || original.incarnation !== incarnation) return { kind: 'stale', revision: current.revision }
      return authority.transact(expectedRevision, (next, order) => {
        const life = own(next.personas, key)
        if (!life || life.incarnation !== incarnation || !CHANNEL_ID_RE.test(channel) || !DELIVERY_MODES.includes(delivery)) throw new Error('Obsolete or invalid assignment.')
        put(life.assignments, channel, { delivery, order })
        const raw = rawPersona(next, key)
        raw['channels'] = Object.entries(life.assignments).map(([id, assignment]) => ({ id, delivery: assignment.delivery }))
      })
    },
    previewReviewed(bytes, explicit = []) {
      return authority.planReviewed(bytes, explicit).config
    },
    planReviewed(bytes, explicit = []) {
      if (!readable) throw new Error('The shared channel outcome is unresolved; preserve its evidence and restore trustworthy state before reviewing another application.')
      const next = clone(current)
      next.revision += explicit.some(a => a.absenceReplacement !== undefined) ? 2 : 1
      const channels: ReviewedChannelEffect[] = []
      prepareReviewed(next, next.revision, bytes, explicit, channels)
      return { config: sharedAppliedConfig(next, path, deps), channels }
    },
    applyReviewed(bytes, expectedRevision, explicit = []) {
      return authority.transact(expectedRevision, (next, order) => {
        prepareReviewed(next, order, bytes, explicit)
      }, explicit.some(a => a.absenceReplacement !== undefined) ? 2 : 1)
    },
    commitReview(bytes, expectedRevision, review, assignments, publish) {
      if (!reviewMatches(current, review, true) || sharedReviewDependency(current) !== review.dependency ||
          reloadFingerprint(bytes, []) !== review.sourceHash) return { kind: 'stale', revision: current.revision }
      return authority.transact(expectedRevision, (next, order) => {
        if (!isDeepStrictEqual(assignments, authority.declaredAssignments(bytes))) throw new Error('Mismatched reviewed assignments.')
        prepareReviewed(next, order, bytes, assignments)
        consumeReview(next, review, order)
      }, assignments.some(a => a.absenceReplacement !== undefined) ? 2 : 1, publish)
    },
  }
  return authority
}
