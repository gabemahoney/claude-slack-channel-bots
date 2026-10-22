/** The single durable authority for applied configuration and channel facts.
 * Importing this module performs no I/O. All mutations are synchronous,
 * revision checked, and become visible only after the injected durable write.
 */
import { randomUUID } from 'node:crypto'
import { personaKey } from './persona-identity.ts'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { durableWriteFileSync, DurableWriteUnsyncedError } from './atomic-write.ts'
import { errnoSuffix } from './persona-credentials.ts'
import { MEMBERSHIP_TIMESTAMP_RE, membershipPayloadIdentity, validateMembershipEvidence, type MembershipEvidence } from './channel-membership-evidence.ts'
import { validateMembershipSetupRecords, type MembershipSetupRecord } from './channel-membership-readiness.ts'
import { slackInstallationIdentity, slackInstallationKey } from './persona-slack-validation.ts'
import {
  CHANNEL_ID_RE, DELIVERY_MODES, parseConfigJsonBytes, parsePersonaConfigBytes, resolveRealPath,
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
  /** Local reset boundary, used only to reject demonstrably older evidence. */
  createdAt?: number
  declaration: PersonaDeclaration
  assignments: Record<string, SharedAssignment>
  membership: Record<string, SharedMembership>
  membershipEvents: Record<string, SharedMembershipEvent>
  leaves: Record<string, SharedLeave>
  /** A validated destination removed by a verified leave in this life only. */
  removedDestinations: Record<string, SharedLeave>
  /** Optional only for a foundation baseline written before live collection. */
  membershipEvidence?: Record<string, MembershipEvidence>
  membershipInventory?: SharedMembershipInventory
  membershipAbsenceConflicts?: Record<string, SharedMembershipAbsenceConflict>
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
  /** Validated raw input of the last confirmed operator application. */
  source: Record<string, unknown>
  /** Exact reviewed input, encoded without normalizing whitespace or UTF-8 bytes. */
  sourceBytesBase64: string
  /** Applied configuration, including automatic channel changes. */
  applied: Record<string, unknown>
  personas: Record<string, SharedPersona>
  retiredIdentities: Record<string, RetiredSharedIdentity>
  /** Durable intent and outcome slots for later review/attempt consumers. */
  pendingIntent: Record<string, unknown>
  outcomes: Record<string, unknown>
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
function removedDestination(state: SharedChannelState, persona: Pick<Persona, 'key' | 'name' | 'credentials_file' | 'working_directory' | 'permission_prompts'>, realpath?: (path: string) => string): boolean {
  const life = own(state.personas, persona.key)
  const proof = life && own(life.removedDestinations, persona.permission_prompts)
  return !!(life && proof && proof.incarnation === life.incarnation &&
    sameSharedDeclaration(life.declaration, persona, realpath) &&
    rawPersona(state, persona.key)['permission_prompts'] === persona.permission_prompts &&
    own(life.leaves, persona.permission_prompts)?.event === proof.event &&
    own(life.leaves, persona.permission_prompts)?.boundary === proof.boundary)
}
export function sharedAppliedConfig(state: SharedChannelState, path: string, deps: SharedChannelDeps = {}): PersonaConfig {
  return parsePersonaConfigBytes(rawBytes(state.applied), path, dirname(path), {
    home: deps.home, record: true,
    removedDestination: persona => removedDestination(state, persona, deps.realpath),
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
    if (life.createdAt !== undefined && (!Number.isSafeInteger(life.createdAt) || life.createdAt < 0)) throw new Error('Invalid persona reset time evidence.')
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
      for (const evidence of Object.values(life.membershipEvidence)) {
        if (evidence.originalEvent !== undefined && !own(life.membershipEvidence, evidence.originalEvent) && !own(life.membershipEvents, evidence.originalEvent)) {
          throw new Error('Missing original membership recovery evidence.')
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
  for (const life of Object.values(state.personas)) {
    checkMembershipHistory(life)
    checkAbsenceConflicts(life, state.revision)
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
    put(personas, persona.key, { incarnation: incarnation(), declaration: declaration(persona), assignments, membership: {}, membershipEvents: {}, leaves: {}, removedDestinations: {} })
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
export interface ReviewedAssignment { key: string; channel: string; delivery: DeliveryMode; incarnation?: string }

export interface SharedChannelAuthority {
  readonly path: string
  readonly readable: boolean
  readonly revision: number
  /** Echo-safe filesystem cause of the last failed mutation, when available. */
  readonly failure: string
  snapshot(): SharedChannelState
  config(): PersonaConfig
  sourceBytes(): Buffer
  incarnation(key: string): string | undefined
  choice(key: string, channel: string): DeliveryMode | undefined
  channels(key: string): string[]
  validatesRemovedDestination(persona: Pick<Persona, 'key' | 'name' | 'credentials_file' | 'working_directory' | 'permission_prompts'>): boolean
  subscribe(listener: (config: PersonaConfig) => void): () => void
  /** The sole mutation boundary. Callback errors and stale revisions write
   * nothing. A batch may reserve multiple ordered positions in one write;
   * the callback receives the final position and publishes only that revision. */
  transact(expectedRevision: number, change: (next: SharedChannelState, order: number) => void, orderSpan?: number): SharedMutationResult
  previewReviewed(bytes: Uint8Array, assignments?: readonly ReviewedAssignment[]): PersonaConfig
  applyReviewed(bytes: Uint8Array, expectedRevision: number, assignments?: readonly ReviewedAssignment[]): SharedMutationResult
  observeMembership(key: string, incarnation: string, observation: VerifiedSharedMembership, expectedRevision: number): SharedMutationResult
  assign(key: string, incarnation: string, channel: string, delivery: DeliveryMode, expectedRevision: number): SharedMutationResult
}
export function createSharedChannelAuthority(path: string, initial: SharedChannelState, deps: SharedChannelDeps = {}): SharedChannelAuthority {
  const validated = parseSharedChannelState(serializeSharedChannelState(initial), path, deps)
  if (!validated) throw new Error('The shared channel authority has an invalid envelope.')
  let current = validated
  let readable = true
  let mutating = false
  let failure = ''
  const write = deps.write ?? durableWriteFileSync
  const listeners = new Set<(config: PersonaConfig) => void>()
  const nextIncarnation = deps.incarnation ?? randomUUID
  function prepareReviewed(next: SharedChannelState, order: number, bytes: Uint8Array, explicit: readonly ReviewedAssignment[]): void {
    const candidate = parsePersonaConfigBytes(bytes, deps.sourcePath ?? path, dirname(path), {
      home: deps.home, record: false, removedDestination: persona => authority.validatesRemovedDestination(persona),
    })
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
        incarnation: nextIncarnation(), createdAt: (deps.now ?? Date.now)(), declaration: declaration(persona), assignments: {}, membership: {}, membershipEvents: {}, leaves: {}, removedDestinations: {},
      }
      life.declaration = declaration(persona)
      const retired = Object.values(current.retiredIdentities).filter(p => p.key === persona.key || sameLocation(p.declaration, persona))
        .sort((a, b) => b.order - a.order || Number(b.key === persona.key) - Number(a.key === persona.key) || a.incarnation.localeCompare(b.incarnation))[0]
      const previous = oldSource.personas.find(p => p.key === persona.key) ??
        oldSource.personas.find(p => sameLocation(p, persona)) ??
        retired
      const previousChoices = new Map(previous?.channels.map(c => [c.id, c.delivery]) ?? [])
      for (const channel of persona.channels) {
        // A copied field never overwrites an automatic choice, and a
        // replacement cannot inherit a preference from the old life.
        const changed = !previousChoices.has(channel.id) || previousChoices.get(channel.id) !== channel.delivery
        if (!previous || changed) put(life.assignments, channel.id, { delivery: channel.delivery, order })
      }
      for (const assignment of explicit.filter(a => a.key === persona.key)) {
        if (assignment.incarnation !== undefined && assignment.incarnation !== life.incarnation) throw new Error('Obsolete reviewed assignment.')
        if (!CHANNEL_ID_RE.test(assignment.channel) || !DELIVERY_MODES.includes(assignment.delivery)) throw new Error('Invalid reviewed assignment.')
        put(life.assignments, assignment.channel, { delivery: assignment.delivery, order })
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
    get revision() { return current.revision },
    get failure() { return failure },
    snapshot: () => clone(current),
    config: () => sharedAppliedConfig(current, path, deps),
    choice: (key, channel) => { const life = own(current.personas, key); return life ? own(life.assignments, channel)?.delivery : undefined },
    channels: key => { const life = own(current.personas, key); return life ? Object.keys(life.assignments).sort() : [] },
    sourceBytes: () => Buffer.from(current.sourceBytesBase64, 'base64'),
    incarnation: key => own(current.personas, key)?.incarnation,
    validatesRemovedDestination: persona => removedDestination(current, persona, deps.realpath),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    transact(expectedRevision, change, orderSpan = 1) {
      if (!readable) return { kind: 'unresolved', revision: current.revision }
      if (mutating || expectedRevision !== current.revision) return { kind: 'stale', revision: current.revision }
      if (!Number.isSafeInteger(orderSpan) || orderSpan < 1 || !Number.isSafeInteger(current.revision + orderSpan)) return { kind: 'failed', revision: current.revision }
      const next = clone(current)
      next.revision += orderSpan
      const appliedRevision = next.revision
      mutating = true
      failure = ''
      try {
        change(next, next.revision)
        if (next.revision !== appliedRevision) throw new Error('Invalid shared application order.')
        const bytes = serializeSharedChannelState(next)
        const published = parseSharedChannelState(bytes, path, deps)
        if (!published) throw new Error('Invalid shared authority format.')
        write(path, bytes)
        current = published
      } catch (err) {
        mutating = false
        failure = errnoSuffix(err)
        // Never overwrite ambiguous evidence with a rollback or allow another
        // writer to decide that the old memory won after an unsynced rename.
        if (err instanceof DurableWriteUnsyncedError) {
          readable = false
          return { kind: 'unresolved', revision: current.revision }
        }
        return { kind: 'failed', revision: current.revision }
      }
      try {
        for (const listener of [...listeners]) {
          try { listener(authority.config()) } catch { /* an observer cannot undo durability */ }
        }
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
      if (!readable) return { kind: 'unresolved', revision: current.revision }
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
      if (!readable) throw new Error('The shared channel outcome is unresolved; preserve its evidence and restore trustworthy state before reviewing another application.')
      const next = clone(current)
      next.revision++
      prepareReviewed(next, next.revision, bytes, explicit)
      return sharedAppliedConfig(next, path, deps)
    },
    applyReviewed(bytes, expectedRevision, explicit = []) {
      return authority.transact(expectedRevision, (next, order) => {
        prepareReviewed(next, order, bytes, explicit)
      })
    },
  }
  return authority
}
