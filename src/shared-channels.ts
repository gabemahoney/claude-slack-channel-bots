/** The single durable authority for applied configuration and channel facts.
 * Importing this module performs no I/O. All mutations are synchronous,
 * revision checked, and become visible only after the injected durable write.
 */
import { testSyncWorkStart, testSyncWorkEnd } from './test-stall-attribution.ts'
import { createHash, randomUUID } from 'node:crypto'
import {
  BotAttemptIndex, botAttemptBinding, botAttemptKey, botAttemptResult, sameBotAttempt, validChannelDeliveryAttempt, validateBotAttempts, validateBotAttemptRecord,
  type BotAttemptAuthorization, type BotAttemptBinding, type BotAttemptResult, type ChannelDeliveryAttemptRequest, type SharedBotAttempt,
} from './channel-delivery-attempt.ts'
import { emptyOperatorIntent, parseReviewRequest, validateOperatorIntent, type OperatorIntent, type ReviewRequest } from './reload-request.ts'
import { consumeReview, reviewLedger, reviewMatches, sharedReviewDependency, supersedeReview, validateReviewLedger, type DurableReview, type ReviewLedger } from './reload-review.ts'
import { reloadFingerprint } from './reload-fingerprint.ts'
import { recoveryHash, validateSharedRecovery, type SharedRecoveryRecord, type SharedRecoveryRequest } from './shared-recovery.ts'
import { expandTilde, PERSONA_KEY_RE, personaKey } from './persona-identity.ts'
import { dirname } from 'node:path'
import { isDeepStrictEqual, types } from 'node:util'
import { durableWriteFileSync, DurableWriteUnsyncedError } from './atomic-write.ts'
import { cloneJournalData } from './durable-journal.ts'
import { isSharedAttemptMap, sharedAttemptMap, withSharedAttempt, sharedAttemptEncoding, sharedAttemptBytes } from './shared-attempt-map.ts'
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
export interface SharedAssignment {
  delivery: DeliveryMode
  order: number
  /** Present exactly on a `thread_hybrid` entry. A random ID compared only
   * for equality; never a delivery value, membership evidence or authorization. */
  threadHybridSince?: string
}
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
export interface SharedMembershipHistory {
  readonly membershipEvents: Readonly<Record<string, Readonly<SharedMembershipEvent>>>
  readonly membershipEvidence?: Readonly<Record<string, Readonly<MembershipEvidence>>>
  readonly membershipAbsenceConflicts?: Readonly<Record<string, Readonly<SharedMembershipAbsenceConflict>>>
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
  /** Thread Memory created marker per persona key, current or not. Outside
   * `revision`, the review dependency and every delivery assignment. */
  threadMemoryCreated?: Record<string, true>
}
export interface SharedChannelOutcomes extends Record<string, unknown> {
  operatorReviews?: ReviewLedger
  botAttempts?: Record<string, SharedBotAttempt>
}
export type ThreadMemoryMarkerResult = { kind: 'saved' } | { kind: 'failed' }
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
  threadHybridSince?: () => string
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
/** A copy of committed or parsed state; a caller's value takes `structuredClone`. */
function clone<T>(value: T): T {
  // Explicit exports/full fallback materialize the immutable dictionary. The
  // normal narrow paths never call this with a whole authority.
  if (object(value) && object(value['outcomes']) && object(value['outcomes']['botAttempts']) && isSharedAttemptMap(value['outcomes']['botAttempts'])) {
    const outcomes = value['outcomes'], records: Record<string, SharedBotAttempt> = {}
    for (const [id, record] of Object.entries(outcomes['botAttempts'] as Record<string, SharedBotAttempt>)) put(records, id, cloneJournalData(record))
    return cloneJournalData({ ...value, outcomes: { ...outcomes, botAttempts: records } }) as T
  }
  return cloneJournalData(value)
}
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}
function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true })
}
/** The objects this module froze: parsed or reparsed JSON data, which
 * committed states never write in place, and the containers a membership
 * transaction copied, the only objects it writes. So each one's pretty
 * encoding at a given depth never changes. */
const sealed = new WeakSet<object>()
/** The sealed containers a membership transaction copied. Most of their
 * members are the previous revision's objects, so they are encoded by member. */
const copied = new WeakSet<object>()
/** Encodings of immutable canonical branches. Copied life/map containers may
 * share text too; root/outcomes never cache a second copy around history. */
const encodings = new WeakMap<object, { depth: number; text: string }>()
const nativeEncoded = new WeakSet<object>()
const byteEncodings = new WeakMap<object, { depth: number; bytes: Buffer }>()
const sourceEncodings = new WeakMap<object, { value: string; bytes: Buffer }>()
/** Committed states share their objects across revisions, so they are frozen
 * whole: an in-place write throws instead of reaching another revision. A
 * frozen object's descendants are already frozen. */
function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || isSharedAttemptMap(value) || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freeze(child)
  sealed.add(value)
  return Object.freeze(value)
}
const INDENTS: string[] = ['']
function indent(depth: number): string { return INDENTS[depth] ??= '  '.repeat(depth) }
const NOT_SEALED_DATA = 'Not sealed JSON data.'
/** Appends to `out` the parts of `JSON.stringify(value, null, 2)` of a sealed
 * object nested `depth` levels deep, as its parent's encoding holds it: a
 * copied container's member by member, any other's kept from an earlier
 * revision or the native encoder's re-indented. Throws, having run no code of
 * the state's, on an object this module did not seal, and on what a
 * transaction wrote that is not JSON data. */
function encodeSealed(value: object, depth: number, out: string[]): void {
  const attempts = sharedAttemptEncoding(value, depth)
  if (attempts !== undefined) { out.push(attempts); return }
  if (!sealed.has(value)) throw new Error(NOT_SEALED_DATA)
  const kept = encodings.get(value)
  if (kept?.depth === depth) { out.push(kept.text); return }
  if (!copied.has(value)) {
    let cached = encodings.get(value)
    if (cached === undefined || cached.depth !== depth) {
      // JSON text has newlines only between tokens, each followed by the indent.
      let text = JSON.stringify(value, null, 2)
      if (depth) text = text.replaceAll('\n', '\n' + indent(depth))
      encodings.set(value, cached = { depth, text })
    }
    out.push(cached.text)
    return
  }
  const list = Array.isArray(value)
  const start = out.length
  // A transaction may have left what the native encoder treats otherwise:
  // a proxy's traps, an own `toJSON` of any kind (it is read whether
  // enumerable or not), one inherited from another prototype, a member's
  // accessor, or a boxed primitive's value (a raw JSON object's prototype is null).
  if (types.isProxy(value) || Object.getPrototypeOf(value) !== (list ? Array.prototype : Object.prototype) || Object.hasOwn(value, 'toJSON') ||
      types.isBoxedPrimitive(value)) throw new Error(NOT_SEALED_DATA)
  const member = (key: string | number): unknown => {
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (!property || !('value' in property)) throw new Error(NOT_SEALED_DATA)
    return property.value
  }
  // Each member's parts follow its opening bracket or the separator.
  const open = (list ? '[\n' : '{\n') + indent(depth + 1), separator = ',\n' + indent(depth + 1)
  let members = 0
  if (list) {
    for (let i = 0; i < value.length; i++) {
      const item = member(i)
      out.push(members++ ? separator : open)
      if (typeof item === 'object' && item !== null) encodeSealed(item, depth + 1, out)
      else out.push(JSON.stringify(item) ?? 'null')
    }
  } else {
    for (const key of Object.keys(value)) {
      const item = member(key)
      if (typeof item === 'object' && item !== null) {
        out.push(members++ ? separator : open, JSON.stringify(key), ': ')
        encodeSealed(item, depth + 1, out)
      } else {
        const encoded = JSON.stringify(item)
        if (encoded !== undefined) out.push(members++ ? separator : open, JSON.stringify(key), ': ', encoded)
      }
    }
  }
  out.push(!members ? (list ? '[]' : '{}') : '\n' + indent(depth) + (list ? ']' : '}'))
  // A later sibling's assignment copies its ancestors, not these containers.
  // Cache canonical life/map fragments too; never cache the root/outcomes
  // around attempt history, and never reach this point for native hooks.
  if (depth >= 2) {
    const text = out.slice(start).join('')
    encodings.set(value, { depth, text })
    out.length = start
    out.push(text)
  }
}
/** The value as reading its serialized form back gives it. */
function reparse(value: unknown): unknown {
  const text = JSON.stringify(value)
  return text === undefined ? undefined : JSON.parse(text)
}
/** Every value write: a `thread_hybrid` entry keeps its Thread Hybrid Since
 * only over a previous `thread_hybrid` entry of the same life, else mints. */
function putAssignment(assignments: Record<string, SharedAssignment>, channel: string, delivery: DeliveryMode, order: number, mint: () => string = randomUUID): void {
  const previous = own(assignments, channel)
  const since = delivery !== 'thread_hybrid' ? undefined
    : previous?.delivery === 'thread_hybrid' && previous.threadHybridSince ? previous.threadHybridSince : mint()
  put(assignments, channel, { delivery, order, ...(since === undefined ? {} : { threadHybridSince: since }) })
}
/** Reviewed restoration and replacement: every `thread_hybrid` entry starts a
 * new Thread Hybrid Since. Changes nothing else and performs no I/O. */
export function restartThreadHybridSince(state: SharedChannelState, mint: () => string = randomUUID): void {
  for (const life of Object.values(state.personas)) {
    for (const assignment of Object.values(life.assignments)) {
      if (assignment.delivery === 'thread_hybrid') assignment.threadHybridSince = mint()
    }
  }
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
  // Thread Hybrid Since authorizes nothing, so it never enters this binding.
  const assignment = own(life.assignments, channel)
  const choice = assignment && { delivery: assignment.delivery, order: assignment.order }
  return createHash('sha256').update(JSON.stringify([life.incarnation, channel, conflict, life.membership[channel], life.leaves[channel], choice])).digest('hex')
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
/** Saved input is immutable, but its destination exception depends on the
 * current persona's removal and leave proofs. Validate both representations. */
function checkSourceConfigs(state: SharedChannelState, sourceBytes: Uint8Array, path: string, deps: SharedChannelDeps): PersonaConfig {
  parsePersonaConfigBytes(rawBytes(state.source), path, dirname(path), {
    home: deps.home, record: true,
    removedDestination: persona => removedDestination(state, persona, deps.realpath),
  })
  // Validate both representations before comparing them, so removed settings
  // still receive the actionable schema diagnostic even in a damaged envelope.
  return parsePersonaConfigBytes(sourceBytes, path, dirname(path), {
    home: deps.home, record: true,
    removedDestination: persona => removedDestination(state, persona, deps.realpath),
  })
}
/** The marker field's only valid shape; absence is checked by the caller. */
export function validThreadMemoryMarker(value: unknown): value is Record<string, true> {
  return object(value) && Object.entries(value).every(([key, created]) => PERSONA_KEY_RE.test(key) && created === true)
}
/** Strict envelope reader. A raw baseline still obeys the new schema; this
 * never reads or imports the removed delivery store or old configuration. */
export function parseSharedChannelState(bytes: Uint8Array, path: string, deps: SharedChannelDeps = {}): SharedChannelState | undefined {
  return readSharedChannelState(bytes, path, deps)?.state
}
/** `parseSharedChannelState` with the applied configuration it validated. */
function readSharedChannelState(bytes: Uint8Array, path: string, deps: SharedChannelDeps): ValidatedSharedState | undefined {
  const value = parseConfigJsonBytes(bytes, path)
  return validateSharedChannelValue(value, path, deps)
}
/** The reader's predicates, also used on normalized scoped configuration
 * drafts. Only immutable attempt history can substitute its validated index. */
interface ValidatedSharedState { state: SharedChannelState; config: PersonaConfig; sourceConfig: PersonaConfig }
function validateSharedChannelValue(value: unknown, path: string, deps: SharedChannelDeps,
  attempts: (state: SharedChannelState) => void = validateBotAttempts): ValidatedSharedState | undefined {
  if (!object(value) || value['format'] !== SHARED_CHANNEL_FORMAT) return undefined
  if (!Number.isSafeInteger(value['revision']) || (value['revision'] as number) < 1 ||
      !object(value['source']) || typeof value['sourceBytesBase64'] !== 'string' || !object(value['applied']) || !object(value['personas']) ||
      !object(value['pendingIntent']) || !object(value['outcomes']) || !object(value['retiredIdentities'])) throw new Error('The shared channel authority has an invalid envelope.')
  if (Object.hasOwn(value, 'threadMemoryCreated') && !validThreadMemoryMarker(value['threadMemoryCreated'])) throw new Error('The shared channel authority has an invalid Thread Memory marker.')
  const state = value as unknown as SharedChannelState
  checkReviewMetadata(state)
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
  for (const [key, life] of Object.entries(state.personas)) checkPersonaRecords(state, key, life, incarnations)
  for (const [incarnation, retired] of Object.entries(state.retiredIdentities)) {
    if (!object(retired) || retired.incarnation !== incarnation || typeof retired.key !== 'string' || !retired.key ||
        !Number.isSafeInteger(retired.order) || retired.order < 1 || retired.order > state.revision ||
        !object(retired.declaration) || !['name', 'credentials_file', 'working_directory'].every(field => typeof retired.declaration[field as keyof PersonaDeclaration] === 'string') ||
        personaKey(retired.declaration.name) !== retired.key || !incarnation ||
        !Array.isArray(retired.channels) || retired.channels.some(channel => !object(channel) || !CHANNEL_ID_RE.test(channel.id) || !DELIVERY_MODES.includes(channel.delivery)) ||
        new Set(retired.channels.map(channel => channel.id)).size !== retired.channels.length) throw new Error('The shared channel authority has invalid retired identity evidence.')
  }
  attempts(state)
  for (const life of Object.values(state.personas)) checkPersonaHistory(life, state.revision)
  // Both raw inputs obey the final schema, including removed-key rejection.
  const config = sharedAppliedConfig(state, path, deps)
  const sourceConfig = checkSourceConfigs(state, sourceBytes, path, deps)
  if (!isDeepStrictEqual(parseConfigJsonBytes(sourceBytes, path), state.source)) throw new Error('The shared channel authority has inconsistent reviewed input evidence.')
  if (!isDeepStrictEqual(reviewedFields(state.source), reviewedFields(state.applied))) throw new Error('The shared channel authority has inconsistent reviewed and applied fields.')
  checkAppliedChoices(state, config, deps)
  return { state, config, sourceConfig }
}
/** Same review/intent/recovery predicates for full and metadata-only stages. */
function checkReviewMetadata(state: SharedChannelState): void {
  if (state.recovery !== undefined) validateSharedRecovery(state.recovery)
  if (Object.hasOwn(state.pendingIntent, 'operator')) validateOperatorIntent(state.pendingIntent['operator'])
  if (Object.hasOwn(state.outcomes, 'operatorReviews')) validateReviewLedger(state.outcomes['operatorReviews'], state.revision)
  if (state.recovery?.phase === 'review' && state.recovery.cancelled) {
    const intent = state.pendingIntent['operator'] as OperatorIntent | undefined
    if (!intent || intent.requested || reviewLedger(state)?.active || !Object.values(intent.requests).some(record =>
      record.generation === intent.generation && record.request.action === 'cancel')) throw new Error('Unconfirmed shared recovery cancellation.')
  }
  if (state.recovery?.phase === 'active') {
    const activation = state.recovery.activation
    const outcome = reviewLedger(state)?.outcomes[activation.fingerprint]
    if (activation.order > state.revision || outcome?.status !== 'consumed' || outcome.revision !== activation.order) throw new Error('Unconfirmed shared recovery activation.')
  }
  if (state.recovery?.phase === 'review' && state.recovery.request.action === 'replace' &&
      state.sourceBytesBase64 !== state.recovery.request.replacement_source_base64) throw new Error('Changed explicit replacement input.')
}
/** One persona's own records, its incarnation unique among `incarnations`. */
function checkPersonaRecords(state: SharedChannelState, key: string, life: SharedPersona, incarnations: Set<string>): void {
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
    checkAssignment(id, assignment, state.revision)
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
function checkAssignment(id: string, assignment: SharedAssignment, revision: number): void {
  if (!CHANNEL_ID_RE.test(id) || !object(assignment) || !DELIVERY_MODES.includes(assignment.delivery) ||
      !Number.isSafeInteger(assignment.order) || assignment.order < 1 || assignment.order > revision ||
      (assignment.delivery === 'thread_hybrid'
        ? typeof assignment.threadHybridSince !== 'string' || !assignment.threadHybridSince
        : Object.hasOwn(assignment, 'threadHybridSince'))) throw new Error('The shared channel authority has an invalid ordered assignment.')
}
/** One persona's membership history, absence evidence and removal provenance. */
function checkPersonaHistory(life: SharedPersona, revision: number): void {
  checkMembershipHistory(life)
  checkAbsenceConflicts(life, revision)
  checkReplacedAbsences(life, revision)
  for (const [channel, proof] of Object.entries(life.leaves)) {
    const event = own(life.membershipEvents, proof.event)
    if (!event || event.member || event.channel !== channel || event.boundary !== proof.boundary) throw new Error('The shared channel authority has inconsistent leave evidence.')
  }
  for (const [channel, proof] of Object.entries(life.removedDestinations)) {
    const leave = own(life.leaves, channel)
    if (!leave || leave.event !== proof.event || leave.boundary !== proof.boundary) throw new Error('The shared channel authority has inconsistent destination-removal evidence.')
  }
}
/** Each applied persona's declaration, list and destination proofs against its life. */
function checkAppliedChoices(state: SharedChannelState, config: PersonaConfig, deps: SharedChannelDeps): void {
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
}
export function serializeSharedChannelState(state: SharedChannelState): Uint8Array {
  if (sealed.has(state) && !('toJSON' in Object.prototype) && !('toJSON' in Array.prototype)) {
    try {
      const out: Uint8Array[] = []
      encodeEnvelopeBytes(state, 0, out)
      out.push(Buffer.from('\n'))
      return Buffer.concat(out)
    } catch { /* unsupported hooks keep native encoding and full validation */ }
  }
  nativeEncoded.add(state)
  return Buffer.from(JSON.stringify(state, null, 2) + '\n')
}
/** Root and outcomes are emitted by field so history is never duplicated in
 * parent caches. Other immutable branches keep their exact UTF-8 bytes. */
function encodeEnvelopeBytes(value: object, depth: number, out: Uint8Array[]): void {
  if (!sealed.has(value)) throw new Error(NOT_SEALED_DATA)
  checkDataContainer(value)
  if (Object.hasOwn(value, 'toJSON')) throw new Error(NOT_SEALED_DATA)
  const fields = Object.keys(value), data = value as Record<string, unknown>
  out.push(Buffer.from('{'))
  let members = 0
  for (const key of fields) {
    const item = data[key]
    if (item === undefined) continue
    out.push(Buffer.from((members++ ? ',\n' : '\n') + indent(depth + 1) + JSON.stringify(key) + ': '))
    if (typeof item !== 'object' || item === null) {
      let bytes: Buffer
      if (depth === 0 && key === 'sourceBytesBase64' && typeof item === 'string' && object(data['source'])) {
        let cached = sourceEncodings.get(data['source'])
        if (!cached || cached.value !== item) sourceEncodings.set(data['source'], cached = { value: item, bytes: Buffer.from(JSON.stringify(item)) })
        bytes = cached.bytes
      } else bytes = Buffer.from(JSON.stringify(item))
      out.push(bytes)
    } else if (depth === 0 && key === 'outcomes') encodeEnvelopeBytes(item, depth + 1, out)
    else {
      const attempts = sharedAttemptBytes(item, depth + 1)
      if (attempts) { out.push(attempts); continue }
      let cached = byteEncodings.get(item)
      if (!cached || cached.depth !== depth + 1) {
        const parts: string[] = []
        encodeSealed(item, depth + 1, parts)
        byteEncodings.set(item, cached = { depth: depth + 1, bytes: Buffer.from(parts.join('')) })
      }
      out.push(cached.bytes)
    }
  }
  out.push(Buffer.from(members ? '\n' + indent(depth) + '}' : '}'))
}
/** Full-reader results become immutable once. Narrow drafts mark only their
 * copied containers; shared branches keep their cached encoding. */
function prepareCommitted(state: SharedChannelState): SharedChannelState {
  if (state.outcomes.botAttempts && !isSharedAttemptMap(state.outcomes.botAttempts)) {
    state = { ...state, outcomes: { ...state.outcomes, botAttempts: sharedAttemptMap(freeze(state.outcomes.botAttempts)) } }
  }
  copied.add(state)
  copied.add(state.outcomes)
  return freeze(state)
}
function sealContainers<T>(value: T, containers: object[]): T {
  for (const container of containers) copied.add(container)
  return freeze(value)
}
export function initialSharedChannelState(bytes: Uint8Array, config: PersonaConfig, incarnation: () => string = randomUUID, threadHybridSince: () => string = randomUUID): SharedChannelState {
  const raw = parseConfigJsonBytes(bytes, 'prepared configuration') as Record<string, unknown>
  const personas: Record<string, SharedPersona> = {}
  for (const persona of config.personas) {
    const assignments: Record<string, SharedAssignment> = {}
    for (const channel of persona.channels) putAssignment(assignments, channel.id, channel.delivery, 1, threadHybridSince)
    put(personas, persona.key, { incarnation: incarnation(), resetOrder: 1, declaration: declaration(persona), assignments, membership: {}, membershipEvents: {}, leaves: {}, removedDestinations: {} })
  }
  return { format: SHARED_CHANNEL_FORMAT, revision: 1, source: clone(raw), sourceBytesBase64: Buffer.from(bytes).toString('base64'), applied: clone(raw), personas, retiredIdentities: {}, pendingIntent: {}, outcomes: {} }
}
/** The persona's position in the applied list, -1 when absent. */
function rawPersonaIndex(entries: unknown[], key: string): number {
  return entries.findIndex(entry => object(entry) && typeof entry['name'] === 'string' && personaKey(entry['name']) === key)
}
function rawPersona(state: SharedChannelState, key: string): Record<string, unknown> {
  const entries = state.applied['personas']
  if (!Array.isArray(entries)) throw new Error('The shared channel authority has invalid applied personas.')
  const persona = entries[rawPersonaIndex(entries, key)]
  if (!persona) throw new Error('Unknown applied persona incarnation.')
  return persona
}
/** Apply to the sole authority's transaction draft. This performs no I/O and
 * publishes nothing; live effects and complete-inventory batches share it. */
export function applySharedMembership(
  next: SharedChannelState, order: number, key: string, incarnation: string, observation: VerifiedSharedMembership,
  mint: () => string = randomUUID,
): void {
  applyMembershipRecords(next, order, key, incarnation, observation, mint)
  deriveRawChannels(next, key)
}
/** Consecutive `applySharedMembership` calls at positions `first`,
 * `first + 1`, ...: each later call rebuilds the raw channel list from the
 * same assignments, so only the last list survives and is derived once. */
export function applySharedMemberships(
  next: SharedChannelState, first: number, key: string, incarnation: string, observations: readonly VerifiedSharedMembership[],
  mint: () => string = randomUUID,
): void {
  if (!observations.length) return
  observations.forEach((observation, index) => applyMembershipRecords(next, first + index, key, incarnation, observation, mint))
  deriveRawChannels(next, key)
}
function deriveRawChannels(next: SharedChannelState, key: string): void {
  const life = own(next.personas, key)!
  rawPersona(next, key)['channels'] = Object.entries(life.assignments).map(([id, assignment]) => ({ id, delivery: assignment.delivery }))
}
/** Every effect of one observation except the raw channel list it implies. */
function applyMembershipRecords(
  next: SharedChannelState, order: number, key: string, incarnation: string, observation: VerifiedSharedMembership, mint: () => string,
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
    putAssignment(life.assignments, observation.channel, next.applied['channel_mode'] === 'open' ? 'mentions' : 'off', order, mint)
  }
}

// --- Scan record retention (SR-3.5) ---

/** Reconciliations name their records `scan:<scan>:<channel>` and
 * `scan:<scan>:absent:<channel>`; live events and reviewed absences never do. */
const SCAN_RECORD_PREFIX = 'scan:'
/** The membership-history records another record names by identifier. */
function namedMembershipEvents(life: SharedPersona): Set<string> {
  const named = new Set<string>()
  for (const proof of Object.values(life.leaves)) named.add(proof.event)
  for (const proof of Object.values(life.removedDestinations)) named.add(proof.event)
  for (const [event, evidence] of Object.entries(life.membershipEvidence ?? {})) {
    named.add(event)
    if (evidence.originalEvent !== undefined) named.add(evidence.originalEvent)
  }
  for (const binding of Object.keys(life.replacedAbsences ?? {})) named.add(`reviewed-absence:${binding}`)
  return named
}
/** Once an application has written `life`'s membership history, drops every
 * superseded scan repeat of that history in place, in one pass. A repeat left
 * its channel's member value, identity and boundary unchanged, so in a
 * consistent history its boundary precedes its own position; any newer record
 * of its channel supersedes it. A named repeat stays, and so does one whose
 * position a newly verified member's default assignment still holds, which
 * tells that default from an explicit assignment. Boundaries name the records
 * that began membership states, never repeats. `saved` is the committed life;
 * an application that wrote this life no record drops nothing, so a metadata
 * write never changes a review dependency through retention alone. */
function dropSupersededScanRepeats(life: SharedPersona, saved: SharedPersona | undefined): void {
  const events = life.membershipEvents
  const kept = saved?.incarnation === life.incarnation ? saved.membershipEvents : undefined
  const newest = new Map<string, number>()
  const repeats: string[] = []
  let wrote = false
  for (const id in events) {
    const event = events[id]
    // Validation rejects a malformed record; this drops nothing beside it.
    if (typeof event !== 'object' || event === null) return
    if (!wrote && (!kept || !Object.hasOwn(kept, id) || kept[id]!.order !== event.order)) wrote = true
    if ((newest.get(event.channel) ?? 0) < event.order) newest.set(event.channel, event.order)
    if (id.startsWith(SCAN_RECORD_PREFIX) && event.boundary < event.order) repeats.push(id)
  }
  if (!wrote) return
  let named: Set<string> | undefined
  for (const id of repeats) {
    const event = events[id]!
    if (event.order >= newest.get(event.channel)! ||
        (event.member && own(life.assignments, event.channel)?.order === event.order)) continue
    named ??= namedMembershipEvents(life)
    if (!named.has(id)) delete events[id]
  }
}
/** `dropSupersededScanRepeats` for each life of a whole-state draft. */
function dropAllSupersededScanRepeats(next: SharedChannelState, before: SharedChannelState): void {
  for (const key in next.personas) dropSupersededScanRepeats(next.personas[key]!, own(before.personas, key))
}

// --- Membership transactions: one persona's records, copied on write ---

/** The record maps a membership transaction may change in its persona. */
const MEMBERSHIP_RECORDS = ['assignments', 'membership', 'membershipEvents', 'leaves', 'removedDestinations', 'membershipEvidence', 'membershipAbsenceConflicts', 'installationReadiness'] as const
const MEMBERSHIP_FIELDS: ReadonlySet<string> = new Set<string>([...MEMBERSHIP_RECORDS, 'membershipInventory'])
/** The field holding the application position of a record in each map. */
const RECORD_POSITIONS: Readonly<Record<string, string>> = {
  assignments: 'order', membershipEvents: 'order', membershipEvidence: 'recordedOrder', membershipAbsenceConflicts: 'recordedOrder',
  installationReadiness: 'order',
}
const DRAFT_FIELDS: ReadonlySet<string> = new Set(['revision', 'personas', 'applied'])
const APPLIED_LIST: ReadonlySet<string> = new Set(['personas'])
const RAW_CHANNELS: ReadonlySet<string> = new Set(['channels'])
interface MembershipDraft {
  next: SharedChannelState
  life: SharedPersona
  raw: Record<string, unknown>
  index: number
  /** The persona's copied record maps, by field. */
  records: Map<string, Record<string, unknown>>
}
/** `state` at `revision` with fresh copies of the persona, its record maps,
 * the applied list and its raw entry; every other object is shared. */
function membershipDraft(state: SharedChannelState, key: string, revision: number): MembershipDraft {
  const list = (state.applied['personas'] as Record<string, unknown>[]).slice()
  const index = rawPersonaIndex(list, key)
  const raw = { ...list[index]! }
  list[index] = raw
  const life: SharedPersona = { ...state.personas[key]! }
  const fields = life as unknown as Record<string, unknown>
  const records = new Map<string, Record<string, unknown>>()
  for (const field of MEMBERSHIP_RECORDS) {
    if (fields[field] === undefined) continue
    const copy = { ...fields[field] as Record<string, unknown> }
    records.set(field, copy)
    fields[field] = copy
  }
  const personas = { ...state.personas }
  put(personas, key, life)
  return { next: { ...state, revision, personas, applied: { ...state.applied, personas: list } }, life, raw, index, records }
}
/** Same keys in the same order, with identical values, outside `except`. */
function sameExcept(after: object, before: object, except: ReadonlySet<string>): boolean {
  const a = after as Record<string, unknown>, b = before as Record<string, unknown>
  const keys = Object.keys(a).filter(key => !except.has(key)), kept = Object.keys(b).filter(key => !except.has(key))
  return keys.length === kept.length && keys.every((key, i) => key === kept[i] && a[key] === b[key])
}
/** Scope checks compare data, never user accessors or proxy traps that could
 * produce different bytes after validation. New leaf values are normalized. */
function checkDataContainer(value: object): void {
  if (types.isProxy(value) || Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !('value' in descriptor))) throw new Error('Invalid scoped data container.')
}
/** Spreading these containers would discard native hooks/descriptors, including
 * non-enumerable toJSON methods/getters. Detection never invokes a getter. */
function needsNativeNormalization(value: object): boolean {
  try { checkDataContainer(value) } catch { return true }
  return 'toJSON' in value
}
/** A membership transaction changes its persona's membership fields and its
 * raw entry's `channels` only; everything else stays the committed objects. */
function checkMembershipScope(before: SharedChannelState, key: string, draft: MembershipDraft): void {
  const { next, life, raw, index } = draft
  checkDataContainer(next)
  checkDataContainer(next.outcomes)
  const list = next.applied['personas'], kept = before.applied['personas'] as unknown[]
  if (!sameExcept(next, before, DRAFT_FIELDS) || !sameExcept(next.personas, before.personas, new Set([key])) || own(next.personas, key) !== life ||
      !sameExcept(next.applied, before.applied, APPLIED_LIST) || !Array.isArray(list) || list.length !== kept.length ||
      list.some((entry, i) => entry !== (i === index ? raw : kept[i])) || !sameExcept(raw, kept[index] as object, RAW_CHANNELS) ||
      !sameExcept(life, before.personas[key]!, MEMBERSHIP_FIELDS)) throw new Error('A membership transaction changed state outside its persona.')
}
/** Gives each value the transaction wrote the form reading the file back would
 * give it, frozen, and answers whether every position written follows `revision`. */
function settleMembershipDraft(saved: SharedPersona, savedRaw: Record<string, unknown>, draft: MembershipDraft, revision: number): boolean {
  const fields = draft.life as unknown as Record<string, unknown>, kept = saved as unknown as Record<string, unknown>
  let fresh = true
  const written = (field: string, record: unknown) => {
    const position = field === 'membershipInventory' ? 'recordedOrder' : RECORD_POSITIONS[field]
    if (position !== undefined && object(record) && !((record[position] as number) > revision)) fresh = false
  }
  const settle = (value: unknown) => freeze(reparse(value))
  for (const field of MEMBERSHIP_FIELDS) {
    const value = fields[field]
    if (value === undefined) { delete fields[field]; continue }
    const copy = draft.records.get(field)
    if (value === copy) {
      const records = kept[field] as Record<string, unknown>
      // Visits each entry once without building entry arrays; only the
      // current entry is replaced or deleted.
      for (const id in copy) {
        if (Object.hasOwn(records, id) && records[id] === copy[id]) continue
        const settled = settle(copy[id])
        if (settled === undefined) delete copy[id]
        else put(copy, id, settled)
        written(field, settled)
      }
    } else if (value !== kept[field]) {
      const settled = settle(value)
      if (settled === undefined) delete fields[field]
      else fields[field] = settled
      if (field === 'membershipInventory') written(field, settled)
      else if (object(settled)) for (const record of Object.values(settled)) written(field, record)
    }
  }
  if (draft.raw['channels'] !== savedRaw['channels']) {
    const settled = settle(draft.raw['channels'])
    if (settled === undefined) delete draft.raw['channels']
    else draft.raw['channels'] = settled
  }
  return fresh
}
/** Freezes the draft's fresh containers, whose other contents are already
 * frozen: shared committed objects, or values settled above. */
function sealMembershipDraft(draft: MembershipDraft): SharedChannelState {
  for (const value of [...draft.records.values(), draft.life, draft.raw, draft.next.applied['personas'] as object, draft.next.applied, draft.next.personas, draft.next]) {
    sealed.add(value)
    copied.add(value)
    Object.freeze(value)
  }
  return draft.next
}
/** The checks of `parseSharedChannelState` a membership transaction can
 * change. Every other check reads objects it shares unchanged, bounded only
 * from above by the revision, which grew. The incarnation stays unique
 * because it is unchanged. */
function checkMembershipDraft(before: SharedChannelState, state: SharedChannelState, key: string, fresh: boolean, path: string, deps: SharedChannelDeps, index: BotAttemptIndex): PersonaConfig {
  const life = state.personas[key]!
  checkPersonaRecords(state, key, life, new Set())
  if (!fresh) validateBotAttempts(state)
  else index.check(state, key)
  checkPersonaHistory(life, state.revision)
  const config = sharedAppliedConfig(state, path, deps)
  const saved = before.personas[key]!, destination = rawPersona(state, key)['permission_prompts'] as string
  // Scope keeps both sources, declarations and destinations unchanged. Only
  // these two records can change the saved source's removedDestination answer,
  // even when a rejoin has made the applied list valid without that proof.
  if (own(life.removedDestinations, destination) !== own(saved.removedDestinations, destination) ||
      own(life.leaves, destination) !== own(saved.leaves, destination)) {
    checkSourceConfigs(state, Buffer.from(state.sourceBytesBase64, 'base64'), path, deps)
  }
  checkAppliedChoices(state, config, deps)
  return config
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
/** A persona's durable lifetime in one channel. This token proves only a
 * durable lifetime, never current membership or eligibility. A durable leave
 * or reset supersedes it. Accepted queues do not consume this authority. */
export interface SharedChannelLifetime {
  key: string
  channel: string
  incarnation: string
  resetOrder: number
  createdAt?: number
  membershipBoundary: number
  leaveBoundary: number
}
export function sharedChannelLifetime(state: SharedChannelState, key: string, channel: string): SharedChannelLifetime | undefined {
  const life = own(state.personas, key)
  if (!life || !CHANNEL_ID_RE.test(channel)) return undefined
  return { key, channel, incarnation: life.incarnation, resetOrder: life.resetOrder ?? 1,
    ...(life.createdAt === undefined ? {} : { createdAt: life.createdAt }), membershipBoundary: own(life.membership, channel)?.boundary ?? 0,
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

// --- Channel Stamps: thread facts only, never selection or authorization ---

/** The stamp a join records; only a `thread_hybrid` entry has one. */
export interface ChannelStamp { incarnation: string; threadHybridSince: string }
export type SharedChannelStampState =
  | { kind: 'decided'; incarnation: string; threadHybridSince?: string }
  | { kind: 'undecided' }
/** Thread facts captured at one moment; a later application never changes it.
 * An `undecided` stamp may coexist with readable intake for that channel;
 * consumers hold its joins rather than forget or drop them. */
export interface SharedThreadView {
  readonly revision: number
  /** `undefined` for a key with no current persona. */
  stamp(key: string, channel: string): SharedChannelStampState | undefined
  /** Sorted decided channels whose entry is `thread_hybrid`. */
  threadHybridChannels(key: string): string[]
  personaKeys(): string[]
}
export function sameChannelStamp(a: ChannelStamp, b: SharedChannelStampState | undefined): boolean {
  return b?.kind === 'decided' && b.incarnation === a.incarnation && b.threadHybridSince === a.threadHybridSince
}
/** The authority's readability facts; committed states are never mutated in place. */
interface SharedReadability {
  current: SharedChannelState
  uncertain: SharedChannelState | undefined
  readable: boolean
  recoveryStaged: boolean
}
function heldByReview(state: SharedChannelState, key: string): boolean {
  return state.recovery?.phase === 'review' || reviewLedger(state)?.retirement?.recovery.keys.includes(key) === true
}
function readableIn(facts: SharedReadability, key: string, channel?: string): boolean {
  const { current, uncertain } = facts
  if (heldByReview(current, key)) return false
  if (facts.readable) return true
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
}
export interface SharedUnresolvedScope { channels: string[]; dm: boolean; all: boolean }
export type SharedUnreadableCause = 'unsynced' | 'evidence-changed' | 'restoration-staged'
/** Reporting inventory only; the projection reader remains the authority. */
export function sharedPersonaChannels(state: SharedChannelState, key: string): string[] {
  const life = own(state.personas, key)
  const channels = new Set([...Object.keys(life?.assignments ?? {}), ...Object.keys(life?.membership ?? {}),
    ...Object.keys(life?.leaves ?? {}), ...Object.keys(life?.membershipAbsenceConflicts ?? {})])
  const destination = life ? rawPersona(state, key)['permission_prompts'] : undefined
  if (typeof destination === 'string' && CHANNEL_ID_RE.test(destination)) channels.add(destination)
  return [...channels].sort()
}
function unresolvedScopeIn(facts: SharedReadability, key: string): SharedUnresolvedScope | undefined {
  if (facts.readable && !heldByReview(facts.current, key)) return undefined
  const channels = new Set(sharedPersonaChannels(facts.current, key))
  if (facts.uncertain) for (const channel of sharedPersonaChannels(facts.uncertain, key)) channels.add(channel)
  const before = own(facts.current.personas, key)
  const after = own(facts.uncertain?.personas ?? {}, key)
  const all = heldByReview(facts.current, key) || !facts.uncertain || !before || !after ||
    before.incarnation !== after.incarnation || facts.current.applied['channel_mode'] !== facts.uncertain.applied['channel_mode']
  const scope = { channels: [...channels].filter(channel => !readableIn(facts, key, channel)).sort(),
    dm: !readableIn(facts, key, 'D'), all }
  return scope.all || scope.dm || scope.channels.length ? scope : undefined
}
/** A staged recovery leaves unchanged projections readable, yet no stamp under
 * it can be decided: the restart reviews the stage before any join counts. */
function stampIn(facts: SharedReadability, key: string, channel: string): SharedChannelStampState | undefined {
  const life = own(facts.current.personas, key)
  if (!life) return undefined
  if (facts.recoveryStaged || !readableIn(facts, key, channel)) return { kind: 'undecided' }
  const since = own(life.assignments, channel)?.threadHybridSince
  return { kind: 'decided', incarnation: life.incarnation, ...(since === undefined ? {} : { threadHybridSince: since }) }
}
function captureThreadView(facts: SharedReadability): SharedThreadView {
  return {
    revision: facts.current.revision,
    stamp: (key, channel) => stampIn(facts, key, channel),
    threadHybridChannels: key => Object.entries(own(facts.current.personas, key)?.assignments ?? {})
      .filter(([channel, assignment]) => assignment.delivery === 'thread_hybrid' && stampIn(facts, key, channel)?.kind === 'decided')
      .map(([channel]) => channel).sort(),
    personaKeys: () => Object.keys(facts.current.personas).sort(),
  }
}
/** Compares views by derived stamps only, so marker writes and unrelated
 * metadata never count as a change. */
function threadViewSignature(facts: SharedReadability): string {
  return JSON.stringify(Object.keys(facts.current.personas).sort().map(key => {
    const channels = new Set([...Object.keys(facts.current.personas[key]!.assignments),
      ...Object.keys(own(facts.uncertain?.personas ?? {}, key)?.assignments ?? {})])
    return [key, [...channels].sort().map(channel => [channel, stampIn(facts, key, channel)])]
  }))
}

export interface SharedChannelAuthority {
  readonly path: string
  readonly readable: boolean
  readonly unreadableCause: SharedUnreadableCause | undefined
  unresolvedScope(key: string): SharedUnresolvedScope | undefined
  /** Outcome observers run after publication and outside the mutation lock. */
  watch(listener: () => void): () => void
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
  /** Detached metadata only; never exports or clones attempt history. */
  reviewState(): Pick<SharedChannelState, 'outcomes' | 'pendingIntent' | 'recovery'>
  reviewDependency(): string
  recoverySnapshot(): SharedRecoveryRecord | undefined
  personaKeys(): string[]
  membershipSetup(key: string, installation: string): MembershipSetupRecord | undefined
  /** One persona's published state, cloned without the rest of the authority. */
  personaSnapshot(key: string): SharedPersona | undefined
  /** Detached membership records only; an omitted channel list selects all.
   * Scan bookkeeping never needs assignments, event history or other personas. */
  membershipSnapshot(key: string, channels?: readonly string[]): Record<string, SharedMembership> | undefined
  /** Reporting inventory only, with the same sorted IDs as sharedPersonaChannels. */
  reportingChannels(key: string): string[]
  /** Detached replacement identities in publication order. No conflict payload
   * or other persona state is needed to revoke an obsolete scan. */
  absenceReplacements(): { key: string; incarnation: string; binding: string; channel: string }[]
  /** One persona's published membership history, uncloned. `read` must not
   * mutate or retain the view, and returns only a primitive answer or a
   * freshly built list of channel IDs. */
  inspectMembershipHistory<T extends boolean | string[]>(key: string, read: (history: SharedMembershipHistory | undefined) => T): T
  config(): PersonaConfig
  sourceBytes(): Buffer
  incarnation(key: string): string | undefined
  reviewHeld(key: string): boolean
  lifetime(key: string, channel: string): SharedChannelLifetime | undefined
  choice(key: string, channel: string): DeliveryMode | undefined
  channels(key: string): string[]
  validatesRemovedDestination(persona: Pick<Persona, 'key' | 'name' | 'credentials_file' | 'working_directory' | 'permission_prompts'>): boolean
  subscribe(listener: (config: PersonaConfig) => void): () => void
  /** `subscribe` for a listener that reads no configuration: called at the
   * same moments, in the same subscription order, with no argument. */
  subscribeChange(listener: () => void): () => void
  /** A stamp can read `undecided` while `readableFor` is true (a staged
   * recovery), so intake may continue. Undecided means hold: a consumer never
   * forgets under it, never treats it as selecting nothing, and never
   * acknowledges then drops a reply that depends on a join. */
  channelStamp(key: string, channel: string): SharedChannelStampState | undefined
  /** The facts every `channelStamp` answer derives from, as one token: while
   * the same token is returned, every key and channel reads the same stamp. */
  stampFacts(): object
  threadView(): SharedThreadView
  /** Delivered at every config publication, before `subscribe` listeners, and
   * after any other durable or readability change to the derived stamps. A
   * listener may run under the mutation lock and must not mutate synchronously. */
  subscribeThreadView(listener: (view: SharedThreadView) => void): () => void
  operatorIntent(): OperatorIntent
  requestReview(request: ReviewRequest, bytes: Uint8Array): OperatorRequestResult
  declaredAssignments(bytes: Uint8Array): ReviewedAssignment[]
  /** The mutation boundary, with `transactMembership` sharing its commit order.
   * Callback errors and stale revisions write nothing. A batch may reserve
   * multiple ordered positions in one write; the callback receives the final
   * position and publishes only that revision. */
  transact(expectedRevision: number, change: (next: SharedChannelState, order: number) => void, orderSpan?: number, publish?: (config: PersonaConfig) => void, scope?: 'review'): SharedMutationResult
  /** Metadata-only scope: intent, review ledger and recovery cancellation. */
  transactReview(expectedRevision: number, change: (next: SharedChannelState, order: number) => void): SharedMutationResult
  /** Reviewed configuration/recovery scope keeps all attempt records unchanged. */
  transactConfiguration(expectedRevision: number, change: (next: SharedChannelState, order: number) => void, orderSpan?: number, publish?: (config: PersonaConfig) => void): SharedMutationResult
  /** `transact` for one persona's membership, copying only what it changes.
   * `change` may add, replace or delete entries of that persona's record maps
   * (assignments, membership, events, leaves, removed destinations, evidence,
   * absence conflicts), set its inventory and its applied `channels`, never
   * mutating a shared record in place; anything else fails and writes nothing.
   * Committed state is shared between revisions and frozen. */
  transactMembership(key: string, expectedRevision: number, change: (next: SharedChannelState, order: number) => void, orderSpan?: number): SharedMutationResult
  previewReviewed(bytes: Uint8Array, assignments?: readonly ReviewedAssignment[]): PersonaConfig
  planReviewed(bytes: Uint8Array, assignments?: readonly ReviewedAssignment[]): ReviewedChannelPlan
  /** Frozen preview for the reload owner; the ordinary API returns a copy. */
  readReviewedPlan(bytes: Uint8Array, assignments?: readonly ReviewedAssignment[]): Readonly<ReviewedChannelPlan>
  applyReviewed(bytes: Uint8Array, expectedRevision: number, assignments?: readonly ReviewedAssignment[]): SharedMutationResult
  commitReview(bytes: Uint8Array, expectedRevision: number, review: DurableReview, assignments: readonly ReviewedAssignment[], publish?: (config: PersonaConfig) => void): SharedMutationResult
  observeMembership(key: string, incarnation: string, observation: VerifiedSharedMembership, expectedRevision: number): SharedMutationResult
  /** undefined means no retained binding, not proof of nonapplication. */
  lookupBotAttempt(key: string, incarnation: string, request: ChannelDeliveryAttemptRequest): BotAttemptResult | undefined
  botAttempt(key: string, incarnation: string, request: ChannelDeliveryAttemptRequest,
    authorize: () => BotAttemptAuthorization, applied?: (outcome: Extract<SharedBotAttempt, { status: 'applied' }>) => void): BotAttemptResult
  /** The last durably committed marker; readable at start and while unreadable. */
  threadMemoryCreated(key: string): boolean
  threadMemoryCreatedKeys(): string[]
  /** One whole-file write with `revision` unchanged: no application order, no
   * stale confirmation and no publication. `saved` only after the write returns.
   * `failed` after an unsynced write means the new marker may be on disk while
   * memory keeps the old one, and a later whole-file write may undo it: retry
   * until `saved`. A success leaves `failure` describing the last failed write. */
  setThreadMemoryCreated(key: string): ThreadMemoryMarkerResult
  clearThreadMemoryCreated(key: string): ThreadMemoryMarkerResult
}
export function createSharedChannelAuthority(path: string, initial: SharedChannelState, deps: SharedChannelDeps = {}): SharedChannelAuthority {
  const validated = readSharedChannelState(serializeSharedChannelState(initial), path, deps)
  if (!validated) throw new Error('The shared channel authority has an invalid envelope.')
  let current = prepareCommitted(validated.state)
  let currentConfig = freeze(validated.config)
  let currentSourceConfig = freeze(validated.sourceConfig)
  let currentSourceBase64 = current.sourceBytesBase64
  let currentSourceBytes = Buffer.from(currentSourceBase64, 'base64')
  let attemptIndex = new BotAttemptIndex(current)
  let uncertainInstall: (() => void) | undefined
  let dependency: { source: string; applied: object; personas: object; retired: object; boundary: string | undefined; value: string } | undefined
  let reviewedPlan: { bytes: Buffer; assignments: string; source: object; personas: object; retired: object;
    recovery: SharedRecoveryRecord | undefined; locations: string; plan: ReviewedChannelPlan } | undefined
  function reviewedLocations(config: PersonaConfig): string {
    const declarations = [...currentConfig.personas, ...config.personas, ...Object.values(current.retiredIdentities).map(record => record.declaration)]
    return JSON.stringify(declarations.map(value => [value.credentials_file, value.working_directory].map(path =>
      [resolveRealPath(path), resolveRealPath(path, deps.realpath)])))
  }
  function reviewedDraft(revision: number): SharedChannelState {
    return { ...current, revision, retiredIdentities: { ...current.retiredIdentities }, pendingIntent: clone(current.pendingIntent),
      outcomes: { ...current.outcomes, ...(reviewLedger(current) ? { operatorReviews: clone(reviewLedger(current)!) } : {}) },
      ...(current.recovery ? { recovery: clone(current.recovery) } : {}) }
  }
  function checkCurrentDeclarations(state: SharedChannelState): void {
    for (const persona of currentConfig.personas) {
      const life = own(state.personas, persona.key)
      if (!life || !sameSharedDeclaration(life.declaration, persona, deps.realpath)) throw new Error('The shared channel authority has inconsistent persona identities.')
    }
  }
  /** Native normalization may invoke hooks on the root/outcomes. The index
   * belongs to this exact dictionary (including absence), never its replacement. */
  function restoreAttemptHistory(state: SharedChannelState, kept: SharedChannelOutcomes['botAttempts']): void {
    if (!object(state) || !object(state.outcomes)) throw new Error('Invalid normalized shared authority outcomes.')
    if (kept === undefined) delete state.outcomes.botAttempts
    else if (state.outcomes.botAttempts !== kept) put(state.outcomes, 'botAttempts', kept)
  }
  /** Unusual callback-installed accessors/toJSON keep native encoding behavior.
   * Validate those exact bytes with the full reader before any durable write;
   * ordinary normalized scopes use the indexed proof and cached fragments. */
  function stageBytes(state: SharedChannelState, config: PersonaConfig, sourceConfig?: PersonaConfig): { bytes: Uint8Array; state: SharedChannelState; config: PersonaConfig; sourceConfig?: PersonaConfig } {
    const bytes = serializeSharedChannelState(state)
    if (nativeEncoded.has(state)) {
      const checked = readSharedChannelState(bytes, path, deps)
      if (!checked) throw new Error('Invalid shared authority format.')
      if (Object.hasOwn(checked.state.outcomes, 'botAttempts') !== Object.hasOwn(state.outcomes, 'botAttempts') ||
          !isDeepStrictEqual(checked.state.outcomes.botAttempts, state.outcomes.botAttempts)) {
        throw new Error('Native encoding changed protected bot attempt history.')
      }
      config = checked.config
      sourceConfig = checked.sourceConfig
    }
    return { bytes, state, config, sourceConfig }
  }
  function reviewDependency(): string {
    if (nativeEncoded.has(current) || !dependency || dependency.source !== current.sourceBytesBase64 || dependency.applied !== current.applied ||
        dependency.personas !== current.personas || dependency.retired !== current.retiredIdentities || dependency.boundary !== current.recovery?.boundary) {
      dependency = { source: current.sourceBytesBase64, applied: current.applied, personas: current.personas,
        retired: current.retiredIdentities, boundary: current.recovery?.boundary, value: sharedReviewDependency(current) }
    }
    return dependency.value
  }
  let readable = true
  let uncertain: SharedChannelState | undefined
  let uncertainPublish: ((config: PersonaConfig) => void) | undefined
  let recoveryStaged = false
  let unreadableCause: SharedUnreadableCause | undefined
  let mutating = false
  let failure = ''
  const write = deps.write ?? durableWriteFileSync
  const mint = deps.threadHybridSince ?? randomUUID
  const listeners = new Set<(config: PersonaConfig) => void>()
  /** Listeners in `listeners` that read no configuration. */
  const configless = new Set<(config: PersonaConfig) => void>()
  const configlessPublishers = new WeakSet<(config: PersonaConfig) => void>()
  const watchers = new Set<() => void>()
  let pendingWatchOutcomes = 0
  let watching = false
  function reportOutcome<T>(run: () => T): T {
    try { return run() } finally {
      pendingWatchOutcomes++
      if (!mutating && !watching) {
        watching = true
        try {
          while (pendingWatchOutcomes > 0) {
            pendingWatchOutcomes--
            for (const listener of [...watchers]) {
              try { listener() } catch { /* reporting cannot change an outcome */ }
            }
          }
        } finally { watching = false }
      }
    }
  }
  const threadViewListeners = new Set<(view: SharedThreadView) => void>()
  const readability = (): SharedReadability => ({ current, uncertain, readable, recoveryStaged })
  let stampFacts = readability()
  let deliveredThreadView = threadViewSignature(readability())
  let signatureFacts = readability()
  let signatureHolds = JSON.stringify([current.recovery?.phase, reviewLedger(current)?.retirement?.recovery.keys])
  function deliverThreadView(always: boolean): void {
    const facts = readability()
    const holds = JSON.stringify([current.recovery?.phase, reviewLedger(current)?.retirement?.recovery.keys])
    const same = !nativeEncoded.has(current) && !nativeEncoded.has(signatureFacts.current) &&
      signatureFacts.current.personas === current.personas && signatureFacts.current.applied === current.applied &&
      signatureFacts.uncertain === facts.uncertain && signatureFacts.readable === facts.readable &&
      signatureFacts.recoveryStaged === facts.recoveryStaged && holds === signatureHolds
    const signature = same ? deliveredThreadView : threadViewSignature(facts)
    signatureFacts = facts
    signatureHolds = holds
    if (!always && signature === deliveredThreadView) return
    deliveredThreadView = signature
    const view = captureThreadView(facts)
    for (const listener of [...threadViewListeners]) {
      try { listener(view) } catch { /* an observer cannot undo durability */ }
    }
  }
  // Only closes synchronous reentrancy and undurable binding failures. Durable
  // evidence always wins; this map is never recovery authority after restart.
  const attemptsInFlight = new Map<string, { binding: BotAttemptBinding; kind: 'pending' | 'unresolved' }>()
  function writeBotOutcome(record: SharedBotAttempt, activate = false, publish?: (config: PersonaConfig) => void): SharedMutationResult {
    return reportOutcome(() => commit(authority.revision, 1, publish, order => {
      checkCurrentDeclarations(current)
      const original = own(current.personas, record.key)
      if (original?.incarnation !== record.incarnation || authority.reviewHeld(record.key)) throw new Error('Obsolete bot attempt life.')
      record = freeze(reparse(record.status === 'pending' ? { ...record, startedOrder: order } : { ...record, resolvedOrder: order }) as SharedBotAttempt)
      const id = botAttemptKey(record), previous = own(current.outcomes.botAttempts ?? {}, id)
      if (record.status === 'pending' ? previous !== undefined : !previous || previous.status !== 'pending' ||
          !sameBotAttempt(previous, record) || previous.startedOrder !== record.startedOrder) throw new Error('Obsolete bot attempt binding.')
      const outcomes = { ...current.outcomes, botAttempts: withSharedAttempt(current.outcomes.botAttempts ?? sharedAttemptMap({}), id, record) }
      let next: SharedChannelState = { ...current, revision: order, outcomes }
      let config = currentConfig
      const containers: object[] = [next, outcomes]
      if (activate && record.status === 'applied') {
        const assignments = { ...original.assignments }
        putAssignment(assignments, record.channel, record.delivery, order, mint)
        const choice = reparse(assignments[record.channel]) as SharedAssignment
        checkAssignment(record.channel, choice, order)
        put(assignments, record.channel, choice)
        const life = { ...original, assignments }, personas = { ...current.personas }
        put(personas, record.key, life)
        const list = (current.applied['personas'] as Record<string, unknown>[]).slice(), index = rawPersonaIndex(list, record.key)
        const channels = Object.entries(assignments).map(([id, assignment]) => ({ id, delivery: assignment.delivery }))
        list[index] = { ...list[index]!, channels }
        const applied = { ...current.applied, personas: list }
        next = { ...next, personas, applied }
        config = { ...currentConfig, personas: currentConfig.personas.map(persona => persona.key === record.key ? { ...persona, channels } : persona) }
        containers.push(next, personas, life, assignments, applied, list, list[index]!)
      }
      validateBotAttemptRecord(next, id, record)
      const state = sealContainers(next, containers)
      return { ...stageBytes(state, config), install: () => attemptIndex.add(record) }
    }))
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
      if (publish) configlessPublishers.add(publish)
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
  function writeThreadMemoryMarker(key: string, created: boolean): ThreadMemoryMarkerResult {
    if (!readable || recoveryStaged || heldByReview(current, key) || mutating || (created && !own(current.personas, key))) return { kind: 'failed' }
    if ((own(current.threadMemoryCreated ?? {}, key) === true) === created) return { kind: 'saved' }
    const next = { ...current }
    const markers = { ...current.threadMemoryCreated }
    if (created) put(markers, key, true)
    else delete markers[key]
    if (Object.keys(markers).length) next.threadMemoryCreated = markers
    else delete next.threadMemoryCreated
    mutating = true
    try {
      checkCurrentDeclarations(current)
      if (next.threadMemoryCreated !== undefined && !validThreadMemoryMarker(next.threadMemoryCreated)) throw new Error('Invalid Thread Memory marker.')
      const saved = sealContainers(next, [next, markers])
      const { bytes } = stageBytes(saved, currentConfig)
      write(path, bytes)
      current = saved
      return { kind: 'saved' }
    } catch (err) {
      // Only the marker can differ from memory, so even an unsynced write
      // leaves the authority readable; the next whole-file write agrees.
      failure = errnoSuffix(err)
      return { kind: 'failed' }
    } finally { mutating = false }
  }
  /** `installed` is the configuration the commit validated for `current`, if any. */
  function publishChange(before: SharedChannelState, publish?: (config: PersonaConfig) => void, key?: string, installed?: PersonaConfig): void {
    // The mutation lock keeps `current` installed while recipients run. Every
    // recipient that reads configuration owns it: one parse of `current`, or
    // the configuration the commit validated, copied for the publisher and
    // for each listener but the last that reads it. A configuration-free
    // listener still runs only once `current` parses.
    let config: PersonaConfig | undefined
    const parsed = (): PersonaConfig => config ??= installed ? clone(installed) : authority.config()
    // Runtime publication precedes observers while the mutation lock is held.
    try {
      if (publish && configlessPublishers.has(publish)) (publish as () => void)()
      else publish?.(clone(parsed()))
    } catch { /* durability cannot be undone by a publisher */ }
    // A membership commit shares every other persona, raw entry and field.
    const changed = key === undefined
      ? !isDeepStrictEqual(before.applied, current.applied) || !isDeepStrictEqual(before.personas, current.personas) ||
        !isDeepStrictEqual(before.retiredIdentities, current.retiredIdentities)
      : !isDeepStrictEqual(own(before.personas, key), own(current.personas, key)) || !isDeepStrictEqual(rawPersona(before, key), rawPersona(current, key))
    // Thread Memory forgets before `subscribe` listeners; the runtime publisher ran above.
    deliverThreadView(publish !== undefined || changed)
    if (changed) {
      // The listeners subscribed once the callbacks above have run.
      const recipients = [...listeners].map(listener => ({ listener, reads: !configless.has(listener) }))
      let last = -1
      recipients.forEach((recipient, i) => { if (recipient.reads) last = i })
      recipients.forEach(({ listener, reads }, i) => {
        try {
          const shared = parsed()
          if (!reads) (listener as () => void)()
          else listener(i < last ? clone(shared) : shared)
        } catch { /* an observer cannot undo durability */ }
      })
    }
  }
  /** Every transaction's one order: reserve its positions, stage the next
   * state and its bytes, write them durably, install, then publish. */
  function commit(expectedRevision: number, orderSpan: number, publish: ((config: PersonaConfig) => void) | undefined,
    stage: (revision: number) => { bytes: Uint8Array; state: SharedChannelState; config: PersonaConfig; sourceConfig?: PersonaConfig; install?: () => void }, key?: string): SharedMutationResult {
    const syncStart = testSyncWorkStart()
    try {
      if (!readable) return { kind: 'unresolved', revision: current.revision }
      if (mutating || expectedRevision !== current.revision) return { kind: 'stale', revision: current.revision }
      if (!Number.isSafeInteger(orderSpan) || orderSpan < 1 || !Number.isSafeInteger(current.revision + orderSpan)) return { kind: 'failed', revision: current.revision }
      const before = current
      const appliedRevision = current.revision + orderSpan
      let prepared: SharedChannelState | undefined, installed: PersonaConfig | undefined
      let install: (() => void) | undefined
      mutating = true
      failure = ''
      try {
        const staged = stage(appliedRevision)
        prepared = staged.state
        installed = freeze(staged.config)
        install = () => {
          currentConfig = installed!
          if (staged.sourceConfig) currentSourceConfig = freeze(staged.sourceConfig)
          if (currentSourceBase64 !== staged.state.sourceBytesBase64) {
            currentSourceBase64 = staged.state.sourceBytesBase64
            currentSourceBytes = Buffer.from(currentSourceBase64, 'base64')
          }
          staged.install?.()
        }
        write(path, staged.bytes)
        current = staged.state
        install()
      } catch (err) {
        mutating = false
        failure = errnoSuffix(err)
        // Never overwrite ambiguous evidence with a rollback or allow another
        // writer to decide that the old memory won after an unsynced rename.
        if (err instanceof DurableWriteUnsyncedError) {
          readable = false
          unreadableCause = 'unsynced'
          uncertain = prepared
          uncertainPublish = publish
          uncertainInstall = install
          deliverThreadView(false)
          return { kind: 'unresolved', revision: current.revision }
        }
        return { kind: 'failed', revision: current.revision }
      }
      try {
        // Metadata has durable order, but no applied publication or assignment.
        publishChange(before, publish, key, installed)
      } finally {
        mutating = false
      }
      return { kind: 'applied', revision: appliedRevision }
    } finally { testSyncWorkEnd(syncStart, 'shared-authority-commit', key) }
  }
  function candidateInput(bytes: Uint8Array): PersonaConfig {
    // Exact recorded input keeps record-start collision recovery available
    // for credential-only reviews. Edited input still needs full validation.
    const recorded = Buffer.from(bytes).equals(currentSourceBytes)
    if (recorded && !nativeEncoded.has(current)) {
      checkCurrentDeclarations(current)
      return currentSourceConfig
    }
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
    const recorded = Buffer.from(bytes).equals(currentSourceBytes) && !nativeEncoded.has(current)
    const candidate = candidateInput(bytes)
    const source = recorded ? { ...current.source, personas: (current.source['personas'] as Record<string, unknown>[]).map(persona => ({ ...persona })) }
      : parseConfigJsonBytes(bytes, deps.sourcePath ?? path) as Record<string, unknown>
    const oldSource = !nativeEncoded.has(current) ? currentSourceConfig : parsePersonaConfigBytes(rawBytes(current.source), path, dirname(path), {
      home: deps.home, record: true, removedDestination: persona => authority.validatesRemovedDestination(persona),
    })
    const oldConfig = currentConfig
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
      const life: SharedPersona = same ? { ...oldLife, assignments: { ...oldLife.assignments }, removedDestinations: { ...oldLife.removedDestinations } } : {
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
          putAssignment(life.assignments, channel.id, channel.delivery, order, mint)
          edited.add(channel.id)
        }
      }
      for (const assignment of explicit.filter(a => a.key === persona.key)) {
        if (assignment.incarnation !== undefined && assignment.incarnation !== life.incarnation) throw new Error('Obsolete reviewed assignment.')
        if (!CHANNEL_ID_RE.test(assignment.channel) || !DELIVERY_MODES.includes(assignment.delivery)) throw new Error('Invalid reviewed assignment.')
        if (assignment.absenceReplacement !== undefined) {
          life.membership = { ...life.membership }
          life.membershipEvents = { ...life.membershipEvents }
          life.leaves = { ...life.leaves }
          life.membershipAbsenceConflicts = { ...life.membershipAbsenceConflicts }
          life.replacedAbsences = { ...life.replacedAbsences }
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
          // The removal ends the old entry, so the new choice cannot keep its Thread Hybrid Since.
          delete life.assignments[assignment.channel]
        }
        putAssignment(life.assignments, assignment.channel, assignment.delivery, order, mint)
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
    next.source = recorded ? current.source : parseConfigJsonBytes(bytes, deps.sourcePath ?? path) as Record<string, unknown>
    next.sourceBytesBase64 = recorded ? currentSourceBase64 : Buffer.from(bytes).toString('base64')
    // Intent consumption belongs to its explicit review transaction. Recording
    // these bytes alone cannot consume unrelated pending work or outcomes.
  }
  function transactReviewScoped(expectedRevision: number, change: (next: SharedChannelState, order: number) => void): SharedMutationResult {
    if (current.recovery?.phase === 'review') return authority.transact(expectedRevision, change)
    return reportOutcome(() => commit(expectedRevision, 1, undefined, revision => {
      const kept = current.outcomes.botAttempts
      const next = { ...current, revision, pendingIntent: clone(current.pendingIntent),
        outcomes: { ...current.outcomes, ...(reviewLedger(current) ? { operatorReviews: clone(reviewLedger(current)!) } : {}) },
        ...(current.recovery ? { recovery: clone(current.recovery) } : {}) }
      change(next, revision)
      checkDataContainer(next)
      checkDataContainer(next.outcomes)
      if (next.revision !== revision || !object(next.outcomes) || !object(next.pendingIntent) ||
          !sameExcept(next, current, new Set(['revision', 'outcomes', 'pendingIntent', 'recovery'])) ||
          !sameExcept(next.outcomes, current.outcomes, new Set(['operatorReviews']))) throw new Error('Invalid review transaction scope.')
      next.pendingIntent = reparse(next.pendingIntent) as Record<string, unknown>
      if (!object(next.pendingIntent)) throw new Error('Invalid review transaction intent.')
      if (Object.hasOwn(next.outcomes, 'operatorReviews')) {
        const ledger = reparse(next.outcomes.operatorReviews)
        if (ledger === undefined) delete next.outcomes.operatorReviews
        else next.outcomes.operatorReviews = ledger as ReviewLedger
      }
      if (next.recovery !== undefined) next.recovery = reparse(next.recovery) as SharedRecoveryRecord
      else delete next.recovery
      restoreAttemptHistory(next, kept)
      // Hooks above may also mutate the draft while returning metadata. Recheck
      // the scope after their last execution, before borrowing any old proof.
      checkDataContainer(next)
      checkDataContainer(next.outcomes)
      if (next.revision !== revision || !object(next.pendingIntent) ||
          !sameExcept(next, current, new Set(['revision', 'outcomes', 'pendingIntent', 'recovery'])) ||
          !sameExcept(next.outcomes, current.outcomes, new Set(['operatorReviews']))) throw new Error('Invalid normalized review transaction scope.')
      checkCurrentDeclarations(next)
      checkReviewMetadata(next)
      for (const outcome of Object.values(reviewLedger(next)?.outcomes ?? {})) attemptIndex.checkPosition(outcome.revision)
      // The callback can introduce a stage from an ordinary/active state. Its
      // anchor and restoration facts need the same predicates as a full read.
      const checked = next.recovery?.phase === 'review'
        ? validateSharedChannelValue(next, path, deps, state => attemptIndex.check(state)) : undefined
      if (next.recovery?.phase === 'review' && !checked) throw new Error('Invalid staged review transaction.')
      const state = sealContainers(next, [next, next.outcomes, next.pendingIntent])
      return stageBytes(state, checked?.config ?? currentConfig, checked?.sourceConfig)
    }))
  }
  function readReviewedPlan(bytes: Uint8Array, explicit: readonly ReviewedAssignment[] = []): Readonly<ReviewedChannelPlan> {
    if (!readable) throw new Error('The shared channel outcome is unresolved; preserve its evidence and restore trustworthy state before reviewing another application.')
    const assignments = JSON.stringify(explicit)
    if (!nativeEncoded.has(current) && reviewedPlan && reviewedPlan.source === current.source && reviewedPlan.personas === current.personas &&
        reviewedPlan.retired === current.retiredIdentities && reviewedPlan.recovery === current.recovery && reviewedPlan.assignments === assignments &&
        reviewedPlan.bytes.equals(Buffer.from(bytes)) && reviewedPlan.locations === reviewedLocations(reviewedPlan.plan.config)) return reviewedPlan.plan
    const next = reviewedDraft(current.revision + (explicit.some(a => a.absenceReplacement !== undefined) ? 2 : 1))
    const channels: ReviewedChannelEffect[] = []
    prepareReviewed(next, next.revision, bytes, explicit, channels)
    // Exact recorded input with no declaration and the same lives preserves
    // every applied field/choice. The source and applied predicates established
    // that equality on read; preview merging above only copied these choices.
    const sameApplied = explicit.length === 0 && !nativeEncoded.has(current) && Buffer.from(bytes).equals(currentSourceBytes) &&
      Object.keys(next.personas).length === Object.keys(current.personas).length &&
      Object.entries(next.personas).every(([key, life]) => life.incarnation === current.personas[key]?.incarnation)
    const plan = { config: sameApplied ? currentConfig : sharedAppliedConfig(next, path, deps), channels }
    reviewedPlan = { bytes: Buffer.from(bytes), assignments, source: current.source, personas: current.personas,
      retired: current.retiredIdentities, recovery: current.recovery, locations: reviewedLocations(plan.config), plan: freeze(plan) }
    return reviewedPlan.plan
  }
  const authority: SharedChannelAuthority = {
    path,
    get readable() { return readable },
    get unreadableCause() { return readable ? undefined : unreadableCause },
    unresolvedScope: key => unresolvedScopeIn(readability(), key),
    watch(listener) { watchers.add(listener); return () => watchers.delete(listener) },
    readableFor: (key, channel) => readableIn(readability(), key, channel),
    get revision() { return current.revision },
    get failure() { return failure },
    recoverDurability() {
      return reportOutcome(() => {
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
          if (!Buffer.from(readPersonaConfigBytes(path, deps.readFs)).equals(Buffer.from(bytes))) {
            unreadableCause = 'evidence-changed'
            throw new Error('Uncertain authority evidence changed; preserve it for reviewed recovery.')
          }
          write(path, bytes)
          current = recovered
          uncertainInstall?.()
          uncertainInstall = undefined
          uncertain = undefined
          uncertainPublish = undefined
          readable = true
          unreadableCause = undefined
          failure = ''
        } catch (err) {
          failure = errnoSuffix(err)
          mutating = false
          return { kind: 'unresolved', revision: current.revision }
        }
        try { publishChange(before, publish) } finally { mutating = false }
        return { kind: 'applied', revision: current.revision }
      })
    },
    stageRestoration(request, evidence, prepared) {
      return reportOutcome(() => {
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
          staged.recovery = { boundary: (deps.incarnation ?? randomUUID)(), phase: 'review', request: structuredClone(request),
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
        unreadableCause = 'restoration-staged'
        readable = false
        uncertain = staged
        mutating = false
        deliverThreadView(false)
        return { kind: 'unresolved', revision: current.revision }
      })
    },
    snapshot: () => clone(current),
    reviewState: () => ({ outcomes: { ...(reviewLedger(current) ? { operatorReviews: clone(reviewLedger(current)!) } : {}) },
      pendingIntent: clone(current.pendingIntent), ...(current.recovery ? { recovery: clone(current.recovery) } : {}) }),
    reviewDependency,
    recoverySnapshot: () => current.recovery && clone(current.recovery),
    personaKeys: () => Object.keys(current.personas),
    membershipSetup: (key, installation) => {
      const record = own(own(current.personas, key)?.installationReadiness ?? {}, installation)
      return record && clone(record)
    },
    personaSnapshot: key => { const life = own(current.personas, key); return life && clone(life) },
    membershipSnapshot(key, channels) {
      const life = own(current.personas, key)
      if (!life) return undefined
      const records: Record<string, SharedMembership> = {}
      for (const channel of channels ?? Object.keys(life.membership)) {
        const record = own(life.membership, channel)
        if (record) put(records, channel, { ...record })
      }
      return records
    },
    reportingChannels: key => sharedPersonaChannels(current, key),
    absenceReplacements: () => Object.entries(current.personas).flatMap(([key, life]) =>
      Object.entries(life.replacedAbsences ?? {}).map(([binding, replacement]) =>
        ({ key, incarnation: life.incarnation, binding, channel: replacement.channel }))),
    inspectMembershipHistory: (key, read) => read(own(current.personas, key)),
    config: () => nativeEncoded.has(current) ? sharedAppliedConfig(current, path, deps) : clone(currentConfig),
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
    threadMemoryCreated: key => own(current.threadMemoryCreated ?? {}, key) === true,
    threadMemoryCreatedKeys: () => Object.keys(current.threadMemoryCreated ?? {}).sort(),
    setThreadMemoryCreated: key => writeThreadMemoryMarker(key, true),
    clearThreadMemoryCreated: key => writeThreadMemoryMarker(key, false),
    sourceBytes: () => Buffer.from(currentSourceBytes),
    incarnation: key => own(current.personas, key)?.incarnation,
    reviewHeld: key => heldByReview(current, key),
    lifetime: (key, channel) => sharedChannelLifetime(current, key, channel),
    validatesRemovedDestination: persona => removedDestination(current, persona, deps.realpath),
    subscribe(listener) { configless.delete(listener); listeners.add(listener); return () => { configless.delete(listener); return listeners.delete(listener) } },
    subscribeChange(listener) { configless.add(listener); listeners.add(listener); return () => { configless.delete(listener); return listeners.delete(listener) } },
    channelStamp: (key, channel) => stampIn(readability(), key, channel),
    stampFacts() {
      // `stampIn` reads only these facts, and committed states are never mutated in place.
      if (stampFacts.current !== current || stampFacts.uncertain !== uncertain || stampFacts.readable !== readable ||
          stampFacts.recoveryStaged !== recoveryStaged) stampFacts = readability()
      return stampFacts
    },
    threadView: () => captureThreadView(readability()),
    subscribeThreadView(listener) { threadViewListeners.add(listener); return () => threadViewListeners.delete(listener) },
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
      const result = authority.transactReview(authority.revision, (next, order) => {
        put(next.pendingIntent, 'operator', intent)
        if (request.action === 'cancel' && next.recovery?.phase === 'review' && next.recovery.request.action === 'replace') {
          next.recovery.cancelled = true
          supersedeReview(next, order)
        }
      })
      return answer(result.kind === 'applied' ? 'recorded' : result.kind)
    },
    transact(expectedRevision, change, orderSpan = 1, publish, scope) {
      if (scope === 'review') return orderSpan === 1 ? transactReviewScoped(expectedRevision, change) : { kind: 'failed', revision: current.revision }
      return reportOutcome(() => commit(expectedRevision, orderSpan, publish, revision => {
        const next = clone(current)
        next.revision = revision
        change(next, revision)
        if (next.revision !== revision) throw new Error('Invalid shared application order.')
        dropAllSupersededScanRepeats(next, current)
        const bytes = serializeSharedChannelState(next)
        const published = readSharedChannelState(bytes, path, deps)
        if (!published) throw new Error('Invalid shared authority format.')
        const state = prepareCommitted(published.state), index = new BotAttemptIndex(state)
        return { ...stageBytes(state, published.config, published.sourceConfig), install: () => { attemptIndex = index } }
      }))
    },
    transactReview(expectedRevision, change) {
      return authority.transact(expectedRevision, change, 1, undefined, 'review')
    },
    transactConfiguration(expectedRevision, change, orderSpan = 1, publish) {
      if (current.recovery?.phase === 'review') return authority.transact(expectedRevision, change, orderSpan, publish)
      return reportOutcome(() => commit(expectedRevision, orderSpan, publish, revision => {
        const kept = current.outcomes.botAttempts
        const next = reviewedDraft(revision)
        change(next, revision)
        if (next.revision !== revision || next.outcomes.botAttempts !== kept) throw new Error('Invalid configuration transaction scope.')
        dropAllSupersededScanRepeats(next, current)
        const native = needsNativeNormalization(next) || needsNativeNormalization(next.outcomes)
        const normalized = reparse(native ? next : { ...next, outcomes: { ...next.outcomes, botAttempts: undefined } }) as SharedChannelState
        // Ordinary normalization omits the protected dictionary. If a native
        // hook ran or supplied another dictionary, fully validate its result
        // before restoring our history; the current index cannot prove it.
        if ((native || (object(normalized) && object(normalized.outcomes) && Object.hasOwn(normalized.outcomes, 'botAttempts'))) &&
            !validateSharedChannelValue(normalized, path, deps)) throw new Error('Invalid normalized shared authority format.')
        restoreAttemptHistory(normalized, kept)
        const checked = validateSharedChannelValue(normalized, path, deps, state => attemptIndex.check(state))
        if (!checked) throw new Error('Invalid shared authority format.')
        const state = prepareCommitted(checked.state)
        return stageBytes(state, checked.config, checked.sourceConfig)
      }))
    },
    transactMembership(key, expectedRevision, change, orderSpan = 1) {
      // A staged recovery is checked against its anchor's whole state, which a
      // membership write changes, so it takes the whole-state path; so does a
      // staged replacement. An activated record's checks read only its own
      // object, the outcomes and a revision bound: scope keeps both objects and
      // the revision only grows, so its identity needs no whole-state parse.
      const list = current.applied['personas']
      if (current.recovery?.phase === 'review' || !own(current.personas, key) || !Array.isArray(list) || rawPersonaIndex(list, key) < 0) {
        return authority.transact(expectedRevision, change, orderSpan)
      }
      return reportOutcome(() => commit(expectedRevision, orderSpan, undefined, revision => {
        const before = freeze(current)
        const draft = membershipDraft(before, key, revision)
        change(draft.next, revision)
        if (draft.next.revision !== revision) throw new Error('Invalid shared application order.')
        checkMembershipScope(before, key, draft)
        dropSupersededScanRepeats(draft.life, before.personas[key])
        const fresh = settleMembershipDraft(before.personas[key]!, rawPersona(before, key), draft, before.revision)
        const config = checkMembershipDraft(before, draft.next, key, fresh, path, deps, attemptIndex)
        // Normalization/validation may execute a callback-installed hook. It
        // cannot turn a membership write into a different protected scope.
        if (draft.next.revision !== revision) throw new Error('Invalid normalized shared application order.')
        checkMembershipScope(before, key, draft)
        const state = sealMembershipDraft(draft)
        // The same encoding of the same keys and values as a whole copy.
        return stageBytes(state, config)
      }, key))
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
      return authority.transactMembership(key, expectedRevision, (next, order) => {
        applySharedMembership(next, order, key, incarnation, observation, mint)
      })
    },
    previewReviewed(bytes, explicit = []) {
      return authority.planReviewed(bytes, explicit).config
    },
    readReviewedPlan,
    planReviewed: (bytes, explicit = []) => clone(readReviewedPlan(bytes, explicit)),
    applyReviewed(bytes, expectedRevision, explicit = []) {
      return authority.transactConfiguration(expectedRevision, (next, order) => {
        prepareReviewed(next, order, bytes, explicit)
      }, explicit.some(a => a.absenceReplacement !== undefined) ? 2 : 1)
    },
    commitReview(bytes, expectedRevision, review, assignments, publish) {
      if (!reviewMatches(current, review, true) || reviewDependency() !== review.dependency ||
          reloadFingerprint(bytes, []) !== review.sourceHash) return { kind: 'stale', revision: current.revision }
      return authority.transactConfiguration(expectedRevision, (next, order) => {
        if (!isDeepStrictEqual(assignments, authority.declaredAssignments(bytes))) throw new Error('Mismatched reviewed assignments.')
        prepareReviewed(next, order, bytes, assignments)
        consumeReview(next, review, order)
      }, assignments.some(a => a.absenceReplacement !== undefined) ? 2 : 1, publish)
    },
  }
  return authority
}
