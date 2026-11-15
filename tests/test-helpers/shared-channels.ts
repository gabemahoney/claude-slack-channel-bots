/** Shared-authority fixtures: production schema, serializer and durable writer only. */
import { expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { durableWriteFileSync, DurableWriteUnsyncedError } from '../../src/atomic-write.ts'
import { CHANNEL_ID_RE, DELIVERY_MODES, parsePersonaConfigBytes, type PersonaConfigInput, type PersonaInput } from '../../src/config.ts'
import { personaKey } from '../../src/persona-identity.ts'
import {
  createSharedChannelAuthority, initialSharedChannelState, parseSharedChannelState,
  serializeSharedChannelState, type SharedChannelAuthority, type SharedChannelDeps, type SharedChannelLifetime, type SharedChannelState, type SharedMutationResult,
} from '../../src/shared-channels.ts'
import { isRealHome, isUnder, osTempDir } from './host-safe-env.ts'
import { makePersonaConfigInput } from './persona-config.ts'
import { writtenFile } from './credentials.ts'
import { populationChannels } from './thread-populations.ts'
import type { JSONRPCResponse, JSONRPCError } from '@modelcontextprotocol/sdk/types.js'

/** Compare whole protocol payloads; only the request correlation ID differs. */
export function responseWithoutId({ id, ...payload }: JSONRPCResponse | JSONRPCError) { return payload }

export const RAW_RESPONSE_SURFACES = ['structuredContent', 'metadata', 'annotations', 'non-text'] as const
/** Raw-only mutation of a real handler/SDK response, never a replacement handler.
 * Protocol failures retain their code/message and put the fixture in error.data. */
export function addRawResponseEvidence(message: JSONRPCResponse | JSONRPCError, surface: typeof RAW_RESPONSE_SURFACES[number], marker: string) {
  const fields: Record<string, unknown> = {
    structuredContent: { structuredContent: { retained: marker } },
    metadata: { _meta: { retained: marker } },
    // The SDK strips unknown annotation fields. The attempted protocol payload
    // must still retain them, so a wire-only disclosure cannot escape the audit.
    annotations: { annotations: { audience: ['assistant'], retained: marker } },
    'non-text': { content: [{ type: 'resource_link', uri: 'test://response', name: marker }] },
  }[surface]
  if ('error' in message) {
    message.error.data = { original: message.error.data, ...fields }
  } else if (surface === 'annotations' || surface === 'non-text') {
    const content = message.result.content as Array<Record<string, unknown>>
    // Annotate an existing text item without changing its text projection.
    if (surface === 'annotations') content[0]!.annotations = fields.annotations
    else content.push(...fields.content as Array<Record<string, unknown>>)
  } else Object.assign(message.result, fields)
}

export const SHARED_CHANNEL_IDS = {
  primary: 'C0TEST001', secondary: 'C0TEST002', private: 'G0TEST003',
  third: 'C0TEST003', fourth: 'C0TEST004', fifth: 'C0TEST005', sixth: 'C0TEST006', seventh: 'C0TEST007',
  additional: 'C0TEST009', future: 'C0FUTURE1', foreign: 'C0OTHER01', forged: 'C0FORGED',
} as const
/** Identity replacements declare a repeatable, distinct destination from the
 * same three identity inputs as reload's original fixture. */
export function withIndependentDestination(persona: PersonaInput): PersonaInput {
  const id = 'C0REVIEW' + createHash('sha256').update(JSON.stringify([persona.name, persona.credentials_file, persona.working_directory])).digest('hex').slice(0, 8).toUpperCase()
  return { ...persona, channels: [{ id, delivery: 'all' }], permission_prompts: id }
}
export function sharedChannelPath(stateDir: string): string { return join(resolve(stateDir), 'config.json.last-applied') }
export function configBytes(input: unknown): Buffer { return Buffer.from(JSON.stringify(input, null, 2) + '\n') }

import { REVIEW_REQUEST_FORMAT } from '../../src/reload-request.ts'
import { parseSharedRecoveryRequest, recoveryHash, type SharedRecoveryRecord, type SharedRecoveryRequest } from '../../src/shared-recovery.ts'
/** Bound recovery input, validated by the production grammar. No snapshot
 * field is offered: restoration belongs only to the running authority. */
export function sharedRecoveryRequest(id: string, evidence: Uint8Array, replacement?: Uint8Array): SharedRecoveryRequest {
  const value = { format: REVIEW_REQUEST_FORMAT, request_id: id, evidence_sha256: recoveryHash(evidence),
    ...(replacement === undefined ? { action: 'restore' } : { action: 'replace', replacement_source_base64: Buffer.from(replacement).toString('base64') }) }
  const request = parseSharedRecoveryRequest(value)
  if (!request) throw new Error('sharedRecoveryRequest: invalid fixture input')
  return request
}
/** `request` with only its request ID, its action or its evidence hash
 * changed, each still valid in the production grammar. A restoration turned
 * replacement chooses `input`; a changed hash binds `evidence` plus a newline. */
export function foreignRecoveryRequests(request: SharedRecoveryRequest, evidence: Uint8Array, input: Uint8Array): SharedRecoveryRequest[] {
  const replacement = request.action === 'replace' ? Buffer.from(request.replacement_source_base64, 'base64') : undefined
  return [
    sharedRecoveryRequest('foreign-repair', evidence, replacement),
    sharedRecoveryRequest(request.request_id, evidence, replacement ? undefined : input),
    sharedRecoveryRequest(request.request_id, Buffer.concat([evidence, Buffer.from('\n')]), replacement),
  ]
}
import type { AcceptedInput } from '../../src/delivery-queue.ts'
/** Two distinct originals a repair's queue keeps, in FIFO order, as overrides
 * of delivery-queue.ts's `slackInput` (which imports this module through
 * thread-memory.ts): different keys, text, channels and thread context. */
export function repairOriginals(): Array<Partial<AcceptedInput>> {
  return [
    { text: '  original <@U0SENDER>\r\n😀  ', queued_ack_reaction: 'hourglass' },
    { text: 'second original, in a thread', channel: SHARED_CHANNEL_IDS.secondary, key: { chat_id: SHARED_CHANNEL_IDS.secondary, ts: '1700000000.000002' },
      ts: '1700000000.000002', thread_ts: '1700000000.000001' },
  ]
}
/** A replacement `request` whose chosen input gains a final newline: the same
 * identity, so only whole-request equality tells the two apart. */
export function changedReplacementRequest(request: SharedRecoveryRequest): SharedRecoveryRequest {
  if (request.action !== 'replace') throw new Error('changedReplacementRequest needs a replacement request')
  const input = Buffer.concat([Buffer.from(request.replacement_source_base64, 'base64'), Buffer.from('\n')])
  const changed = parseSharedRecoveryRequest({ ...request, replacement_source_base64: input.toString('base64') })
  if (!changed) throw new Error('changedReplacementRequest: invalid fixture input')
  return changed
}
/** A staged recovery record; throws for an activated record or none, so each
 * read of the bytes only a stage keeps names its phase. */
export function stagedRecoveryOf(state: SharedChannelState): Extract<SharedRecoveryRecord, { phase: 'review' }> {
  const recovery = state.recovery
  if (recovery?.phase !== 'review') throw new Error(`stagedRecoveryOf: expected a staged recovery, found ${recovery?.phase ?? 'none'}`)
  return recovery
}
/** An activated recovery's activation; throws for a staged record or none. */
export function activationOf(state: SharedChannelState) {
  const recovery = state.recovery
  if (recovery?.phase !== 'active') throw new Error(`activationOf: expected an activated recovery, found ${recovery?.phase ?? 'none'}`)
  return recovery.activation
}
/** The whole record activation leaves of `stage` (SR-5.2): its boundary, the
 * request's four identity fields, named one by one, and the activation. */
export function activatedIdentity(stage: SharedRecoveryRecord, activation: { fingerprint: string; order: number }) {
  const { format, action, request_id, evidence_sha256 } = stage.request
  return { boundary: stage.boundary, phase: 'active' as const, request: { format, action, request_id, evidence_sha256 }, activation }
}
/** The `n`th review ID and damaged authority of a repair series, each one
 * width for n < 10000, so a series saves equal-width identities and evidence. */
export function seriesRecoveryId(n: number): string { return `series-repair-${String(n).padStart(4, '0')}` }
export function seriesDamage(n: number): Buffer { return Buffer.from(`damaged authority, series repair ${String(n).padStart(4, '0')}`) }
/** The decimal width of every number in saved JSON: all an equal-shape state
 * may add to its size as its orders and revision gain digits. */
export function numericWidth(bytes: Uint8Array): number {
  let width = 0
  const visit = (value: unknown): void => {
    if (typeof value === 'number') width += String(value).length
    else if (Array.isArray(value)) value.forEach(visit)
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(visit)
  }
  visit(JSON.parse(Buffer.from(bytes).toString('utf8')))
  return width
}
/** Readability cases from a valid production stage (SR-8.10): each removes
 * one byte field its review, revision or activation reads; a restoration's
 * anchor too. Deliberately bypasses the validating seed writer. */
export function stagedRecoveryMissingBytes(stage: SharedChannelState): Array<{ label: string; state: SharedChannelState }> {
  const fields = ['evidenceBase64', 'preparedBase64', ...(stagedRecoveryOf(stage).request.action === 'restore' ? ['anchorBase64'] : [])]
  return fields.map(field => {
    const copy = structuredClone(stage)
    delete (copy.recovery as unknown as Record<string, unknown>)[field]
    return { label: `stage without ${field}`, state: copy }
  })
}
/** Readability cases from a valid production activation and the stage it
 * activated (SR-8.10): each puts back a field activation drops, with the
 * stage's value and empty, adds a surplus field, breaks the identity grammar,
 * or breaks the activation's link to the consumed outcome SR-3.5 keeps.
 * Deliberately bypasses the validating seed writer. */
export function malformedActiveRecoveries(active: SharedChannelState, stage: SharedChannelState): Array<{ label: string; state: SharedChannelState }> {
  const staged = stagedRecoveryOf(stage), { fingerprint, order } = activationOf(active)
  const source = staged.request.action === 'replace' ? staged.request.replacement_source_base64 : staged.preparedBase64
  type Change = [string, (recovery: Record<string, any>, state: SharedChannelState) => void]
  const changes: Change[] = [
    ...(['evidenceBase64', 'preparedBase64', 'anchorBase64'] as const).flatMap((field): Change[] => [
      [`${field} kept`, r => { r[field] = staged[field] ?? staged.evidenceBase64 }],
      [`${field} empty`, r => { r[field] = '' }],
    ]),
    ['replacement source kept', r => { r.request.replacement_source_base64 = source }],
    ['replacement source empty', r => { r.request.replacement_source_base64 = '' }],
    ['superseded IDs kept', r => { r.supersededRequestIds = staged.supersededRequestIds ?? [staged.request.request_id] }],
    ['superseded IDs empty', r => { r.supersededRequestIds = [] }],
    ['cancelled', r => { r.cancelled = true }],
    ['cancellation false', r => { r.cancelled = false }],
    ['surplus record field', r => { r.snapshot = {} }],
    ['surplus request field', r => { r.request.intent_generation = 0 }],
    ['surplus activation field', r => { r.activation.generation = 0 }],
    ['missing activation', r => { delete r.activation }],
    ['missing identity field', r => { delete r.request.evidence_sha256 }],
    ['operator action', r => { r.request.action = 'cancel' }],
    ['invalid request ID', r => { r.request.request_id = 'not a review id' }],
    ['invalid evidence hash', r => { r.request.evidence_sha256 = 'evidence' }],
    ['relabelled review', r => { r.phase = 'review' }],
    ['foreign activation', r => { r.activation.fingerprint = 'f'.repeat(64) }],
    ['activation before its outcome', r => { r.activation.order = order - 1 }],
    ['activation after the revision', (r, s) => { r.activation.order = s.revision + 1 }],
    ['consumed outcome pruned', (_r, s) => { delete reviewLedger(s)!.outcomes[fingerprint] }],
    ['outcome not consumed', (_r, s) => { reviewLedger(s)!.outcomes[fingerprint]!.status = 'superseded' }],
  ]
  return changes.map(([label, mutate]) => {
    const copy = structuredClone(active)
    mutate(copy.recovery as unknown as Record<string, any>, copy)
    return { label, state: copy }
  })
}
export function channelPopulation(count: number, offset = 0) {
  return populationChannels(count, offset)
}
export const FIXTURE_THREAD_HYBRID_SINCE_PREFIX = 'fixture-thread-hybrid-since-'
/** A deterministic Thread Hybrid Since mint: `fixture-thread-hybrid-since-N`,
 * continuing after the highest fixture value already in `after`, so a mint
 * over a reopened state never repeats one of its values. */
export function fixtureThreadHybridSince(after?: SharedChannelState): () => string {
  let n = 0
  for (const life of Object.values(after?.personas ?? {})) {
    for (const { threadHybridSince } of Object.values(life.assignments)) {
      if (threadHybridSince?.startsWith(FIXTURE_THREAD_HYBRID_SINCE_PREFIX)) n = Math.max(n, Number(threadHybridSince.slice(FIXTURE_THREAD_HYBRID_SINCE_PREFIX.length)) || 0)
    }
  }
  return () => `${FIXTURE_THREAD_HYBRID_SINCE_PREFIX}${++n}`
}
export function initialSharedState(stateDir: string, input: PersonaConfigInput = makePersonaConfigInput({}, stateDir),
  threadHybridSince: () => string = fixtureThreadHybridSince()): SharedChannelState {
  const bytes = configBytes(input)
  const config = parsePersonaConfigBytes(bytes, join(stateDir, 'config.json'), stateDir)
  let life = 0
  return initialSharedChannelState(bytes, config, () => `fixture-incarnation-${++life}`, threadHybridSince)
}
export function writeSharedState(stateDir: string, state: SharedChannelState): string {
  const dir = resolve(stateDir)
  if (isRealHome(dir) || dir === osTempDir() || !isUnder(dir, osTempDir())) {
    throw new Error('writeSharedState: pass an owned directory under the OS temp directory')
  }
  const path = sharedChannelPath(dir)
  const bytes = serializeSharedChannelState(state)
  if (!parseSharedChannelState(bytes, path)) throw new Error('writeSharedState: expected a shared authority')
  durableWriteFileSync(path, bytes)
  return path
}
export function readSharedState(stateDir: string): SharedChannelState | null {
  const path = sharedChannelPath(stateDir)
  if (!existsSync(path)) return null
  const state = parseSharedChannelState(readFileSync(path), path)
  if (!state) throw new Error('readSharedState: expected a shared authority envelope')
  return state
}
/** The initial state and later writes share one mint: `deps.threadHybridSince`,
 * else the fixture counter, so the first build's values come first. */
export function makeSharedAuthority(stateDir: string, input = makePersonaConfigInput({}, stateDir), deps: SharedChannelDeps = {}) {
  const threadHybridSince = deps.threadHybridSince ?? fixtureThreadHybridSince()
  const state = initialSharedState(stateDir, input, threadHybridSince)
  writeSharedState(stateDir, state)
  return createSharedChannelAuthority(sharedChannelPath(stateDir), state, { ...deps, threadHybridSince })
}

/** Fixture construction only: one ordered assignment through the live durable
 * transaction and publication path. Real bot/operator behavior must use
 * attempt/botAttempt or reviewed apply instead. Pass the fixture's shared mint
 * (fixtureThreadHybridSince(reopenedState) on reopen); retain it across writes.
 * Same-value writes still take one position and preserve a hybrid marker. */
export function _assignFixture(
  authority: SharedChannelAuthority, key: string, incarnation: string, channel: string,
  delivery: DeliveryMode, expectedRevision: number, threadHybridSince: () => string,
): SharedMutationResult {
  if (!authority.readable || authority.reviewHeld(key)) return { kind: 'unresolved', revision: authority.revision }
  if (authority.incarnation(key) !== incarnation) return { kind: 'stale', revision: authority.revision }
  return authority.transact(expectedRevision, (next, order) => {
    const life = next.personas[key]
    if (!life || life.incarnation !== incarnation || !CHANNEL_ID_RE.test(channel) || !DELIVERY_MODES.includes(delivery)) {
      throw new Error('Obsolete or invalid fixture assignment.')
    }
    const previous = life.assignments[channel]
    const since = delivery !== 'thread_hybrid' ? undefined
      : previous?.delivery === 'thread_hybrid' && previous.threadHybridSince ? previous.threadHybridSince : threadHybridSince()
    life.assignments[channel] = { delivery, order, ...(since === undefined ? {} : { threadHybridSince: since }) }
    const entries = next.applied['personas'] as Array<Record<string, unknown>>
    const raw = entries.find(entry => typeof entry['name'] === 'string' && personaKey(entry['name']) === key)
    if (!raw) throw new Error('Unknown applied fixture persona.')
    raw['channels'] = Object.entries(life.assignments).map(([id, choice]) => ({ id, delivery: choice.delivery }))
  })
}

/** What the lifetime checks read of an authority. */
type LifetimeReader = Pick<SharedChannelAuthority, 'readableFor' | 'lifetime'>
/** `token` is still its channel's lifetime on a readable authority. */
export function holdsLifetime(authority: LifetimeReader, token: SharedChannelLifetime): boolean {
  return authority.readableFor(token.key, token.channel) && isDeepStrictEqual(authority.lifetime(token.key, token.channel), token)
}
/** The authority is readable for `token`'s channel and `token` is its current lifetime. */
export function expectCurrent(authority: LifetimeReader, token: SharedChannelLifetime): void {
  expect([authority.readableFor(token.key, token.channel), authority.lifetime(token.key, token.channel)]).toEqual([true, token])
}
/** The authority is readable for `token`'s channel and a durable change has replaced its lifetime. */
export function expectSuperseded(authority: LifetimeReader, token: SharedChannelLifetime): void {
  expect(authority.readableFor(token.key, token.channel)).toBe(true)
  expect(authority.lifetime(token.key, token.channel)).not.toEqual(token)
}

/** A production-format state with a Thread Memory created marker for each of
 * `keys` (current or removed), validated by the production parser. */
export function withThreadMemoryCreated(state: SharedChannelState, keys: string[], path = 'fixture-authority'): SharedChannelState {
  const next = structuredClone(state)
  if (keys.length) next.threadMemoryCreated = Object.fromEntries(keys.map(key => [key, true as const]))
  else delete next.threadMemoryCreated
  const parsed = parseSharedChannelState(serializeSharedChannelState(next), path)
  if (!parsed) throw new Error('withThreadMemoryCreated: expected a shared authority')
  return parsed
}
/** Invalid marker shapes, each a change to a valid marked production state. */
export function malformedThreadMemoryMarkers(state: SharedChannelState): Array<{ label: string; state: SharedChannelState }> {
  const marked = state.threadMemoryCreated && Object.keys(state.threadMemoryCreated).length
  if (!marked) throw new Error('malformedThreadMemoryMarkers needs a marked production state')
  const changes: Array<[string, (markers: Record<string, unknown>, copy: Record<string, unknown>) => void]> = [
    ['key not a persona key', markers => { markers['Not-A-Key'] = true }],
    ['empty key', markers => { markers[''] = true }],
    ['false value', (markers, copy) => { markers[Object.keys(copy['threadMemoryCreated'] as object)[0]!] = false }],
    ['string value', (markers, copy) => { markers[Object.keys(copy['threadMemoryCreated'] as object)[0]!] = 'true' }],
    ['array', (_markers, copy) => { copy['threadMemoryCreated'] = Object.keys(state.threadMemoryCreated!) }],
    ['null', (_markers, copy) => { copy['threadMemoryCreated'] = null }],
    ['boolean', (_markers, copy) => { copy['threadMemoryCreated'] = true }],
  ]
  return changes.map(([label, mutate]) => {
    const copy = structuredClone(state) as unknown as Record<string, unknown>
    mutate(copy['threadMemoryCreated'] as Record<string, unknown>, copy)
    return { label, state: copy as unknown as SharedChannelState }
  })
}

// Production membership composition over the shared connection/Slack fixtures.
// No discovery result is inferred from config; callers script every positive.
import { createChannelMembership } from '../../src/channel-membership.ts'
import { createMembershipScanner, membershipConnectionListener, type MembershipScanDeps } from '../../src/channel-membership-scan.ts'
import { createPersonaEventRouter } from '../../src/persona-event-router.ts'
import { makeConnectionHarness } from './persona-connection-harness.ts'
import { makePersona } from './persona-config.ts'
import { createPersonaBringUpController } from '../../src/persona-bringup-controller.ts'
import { checkPersonaConfigDir } from '../../src/persona-bringup.ts'
import type { ChannelMode, DeliveryMode } from '../../src/config.ts'
import type { SettledWebApiOutcome, SlackEvent, EnvelopeOverrides } from './slack-stub.ts'

export const MEMBERSHIP_FIXTURE_TIME = 1_700_000_000_000
/** Slack observation time relative to the shared fake-clock origin. */
export function membershipTimestamp(offsetMs = 0): string { return ((MEMBERSHIP_FIXTURE_TIME + offsetMs) / 1000).toFixed(3) }
/** Distinct roots and events for delivery-choice/FIFO/leave histories. */
export const CHANNEL_DELIVERY_TIMES = {
  root: `${MEMBERSHIP_FIXTURE_TIME / 1000}.000001`, otherRoot: `${MEMBERSHIP_FIXTURE_TIME / 1000}.000002`,
  ordinary: `${(MEMBERSHIP_FIXTURE_TIME + 1000) / 1000}.000001`,
  mention: `${(MEMBERSHIP_FIXTURE_TIME + 1000) / 1000}.000002`,
} as const
export function channelDeliveryEventTimestamp(sequence: number): string {
  return `${(MEMBERSHIP_FIXTURE_TIME + 1000) / 1000}.${String(sequence).padStart(6, '0')}`
}
/** A verified event just after the current fake-clock observation. */
export function membershipEventTimestamp(now = MEMBERSHIP_FIXTURE_TIME, offsetMs = 1): string {
  return ((now + offsetMs) / 1000).toFixed(3)
}
export const CHANNEL_DELIVERY_EVENT_IDS = {
  heldLeave: 'EvHELDATTEMPTLEAVE', botLeave: 'EvBOTLEAVE', failedLeave: 'EvFAILEDATTEMPTLEAVE',
} as const
/** Byte-distinct FIFO originals, independently keyed before a leave. Pass each
 * override to slackInput so the accepted envelope remains production-shaped. */
export function channelDeliveryOriginals(channel: string = SHARED_CHANNEL_IDS.primary): Array<Partial<AcceptedInput>> {
  return ['  first\r\n\r\n😀  ', 'second'].map((text, index) => {
    const ts = `${MEMBERSHIP_FIXTURE_TIME / 1000 + index}.000001`
    return { channel, text, queued_ack_reaction: 'hourglass', ts, key: { chat_id: channel, ts } }
  })
}
/** Foundation observations only; live evidence uses the router/scanner harness. */
export function membershipJoin(channel: string, event = `Ev${channel}`, overrides: Partial<VerifiedSharedMembership> = {}): VerifiedSharedMembership {
  return { event, identity: 'app', channel, member: true, boundary: 0, ...overrides }
}
export function membershipObservation(authority: SharedChannelAuthority, key: string, channel: string, member: boolean, event: string, observedThrough?: string): VerifiedSharedMembership {
  return membershipJoin(channel, event, { member, boundary: authority.lifetime(key, channel)?.membershipBoundary ?? 0,
    ...(observedThrough === undefined ? {} : { observedThrough, channelType: 'channel', isExtSharedChannel: false }) })
}
export function scanMembershipEventId(scan: string, channel: string, member = true): string {
  return `scan:${scan}:${member ? '' : 'absent:'}${channel}`
}
/** One page through the production transaction/application and durable writer. */
export function applyMembershipPage(authority: SharedChannelAuthority, key: string, channels: string[], scan: string, identity = 'app') {
  return authority.transactMembership(key, authority.revision, (next, order) => {
    let position = order - channels.length
    for (const channel of channels) applySharedMemberships(next, ++position, key, authority.incarnation(key)!, [
      { ...membershipObservation(authority, key, channel, true, scanMembershipEventId(scan, channel), membershipTimestamp()), identity },
    ])
  }, channels.length)
}
/** Independently named expectations: beginning positives, first leave and last
 * repeats survive; intermediate scan repeats must be pruned by production. */
export const RETAINED_SCAN_EVENTS = {
  beginning: scanMembershipEventId('round-1', SHARED_CHANNEL_IDS.primary),
  secondaryBeginning: scanMembershipEventId('round-1', SHARED_CHANNEL_IDS.secondary),
  leave: scanMembershipEventId('round-4', SHARED_CHANNEL_IDS.secondary, false),
  latest: scanMembershipEventId('round-5', SHARED_CHANNEL_IDS.primary),
  latestAbsence: scanMembershipEventId('round-5', SHARED_CHANNEL_IDS.secondary, false),
} as const
/** Five two-channel reconciliations, the second channel absent in the last two.
 * Read back through the production parser before consumers deliberately damage it. */
export function retainedScanHistory(authority: SharedChannelAuthority, key = 'alpha'): SharedChannelState {
  for (let round = 1; round <= 5; round++) {
    const channels = [SHARED_CHANNEL_IDS.primary, SHARED_CHANNEL_IDS.secondary]
    const result = authority.transactMembership(key, authority.revision, (next, order) => {
      let position = order - channels.length
      for (const channel of channels) {
        const member = round < 4 || channel === SHARED_CHANNEL_IDS.primary
        applySharedMemberships(next, ++position, key, authority.incarnation(key)!, [membershipJoin(channel,
          scanMembershipEventId(`round-${round}`, channel, member), { member,
            boundary: next.personas[key]!.membership[channel]?.boundary ?? 0, observedThrough: membershipTimestamp() })])
      }
    }, channels.length)
    if (result.kind !== 'applied') throw new Error(`retainedScanHistory: round ${round} was ${result.kind}`)
  }
  const parsed = parseSharedChannelState(readFileSync(authority.path), authority.path)
  if (!parsed) throw new Error('retainedScanHistory: expected a shared authority')
  return parsed
}
export function membershipPage(channels: Array<string | Record<string, unknown>>, cursor?: string | null): SettledWebApiOutcome {
  return { kind: 'ok', result: { channels: channels.map(c => typeof c === 'string' ? {
    id: c, is_channel: c.startsWith('C'), is_group: c.startsWith('G'), is_im: false, is_mpim: false, is_ext_shared: false,
  } : c), ...(cursor === undefined ? { response_metadata: undefined } : { response_metadata: { next_cursor: cursor } }) } }
}
export function makeMembershipHarness(stateDir: string, options: {
  realBringUp?: boolean; queuedAckReaction?: string; mode?: ChannelMode; dryRun?: boolean; reopen?: boolean; names?: string[];
  startTime?: number;
  channels?: Array<{ id: string; delivery: DeliveryMode }>;
  /** Every persona's Notice Destination; defaults to its DM. */
  permissionPrompts?: string;
  /** Defaults to the fixture counter, continuing past a reopened state's values. */
  threadHybridSince?: () => string;
  /** Observe the production scanner, separately from connection status. */
  onScanStatus?: MembershipScanDeps['onStatus'];
} = {}) {
  const names = options.names ?? ['alpha']
  const input = makePersonaConfigInput({ ...(options.queuedAckReaction ? { queued_ack_reaction: options.queuedAckReaction } : {}), channel_mode: options.mode ?? 'open', personas: names.map(name =>
    makePersona({ name, channels: options.channels ?? [], permission_prompts: options.permissionPrompts ?? 'dm', dm: { enabled: true, contact: 'U0OPERATOR' } }, stateDir)) }, stateDir)
  let refuseWrite: (state: SharedChannelState) => boolean = () => false
  let unsyncedWrite: (state: SharedChannelState) => boolean = () => false
  const writes: SharedChannelState[] = []
  const reopened = options.reopen ? readSharedState(stateDir)! : undefined
  const deps: SharedChannelDeps = { now: () => h.clock.now(), threadHybridSince: options.threadHybridSince ?? fixtureThreadHybridSince(reopened), write(path, bytes) {
    const state = parseSharedChannelState(bytes, path)!
    writes.push(state)
    if (refuseWrite(state)) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' })
    durableWriteFileSync(path, bytes)
    if (unsyncedWrite(state)) throw new DurableWriteUnsyncedError(path, { code: 'EIO' })
  } }
  const authority = options.reopen
    ? createSharedChannelAuthority(sharedChannelPath(stateDir), reopened!, deps)
    : makeSharedAuthority(stateDir, input, deps)
  let admission = true
  const h = makeConnectionHarness(names.map(name => ({ name })), stateDir, {
    dryRun: options.dryRun, files: options.realBringUp, incarnationFor: key => authority.incarnation(key),
    canRevalidateMembership: key => admission && (!options.realBringUp || bringUps.canRevalidateMembership(key)),
    stubOptions: Object.fromEntries(names.map((name, i) => [name, {
      appId: `A0MEMBER${i}`, botUserId: `U0MEMBER${i}`, botId: `B0MEMBER${i}`, teamId: 'T0MEMBER',
    }])),
  })
  h.config = authority.config()
  mkdirSync(join(stateDir, '.claude'), { recursive: true })
  const bringUps = createPersonaBringUpController({ connections: h.manager, clock: h.clock, dryRun: options.dryRun ?? false,
    log: line => h.lines.push(line), appliedPersonas: () => h.config?.personas ?? [],
    checkConfigDir: persona => checkPersonaConfigDir(persona, { home: stateDir }), launch: async () => {},
  })
  const unsubscribe = authority.subscribe(config => { h.config = config })
  const lines: string[] = []
  const log = (line: string) => { lines.push(line) }
  const membership = createChannelMembership({ authority, dryRun: options.dryRun ?? false, log, requestReconciliation: key => scanner.request(key) })
  const scanner = createMembershipScanner({ authority, membership, connections: h.manager, clock: h.clock, dryRun: options.dryRun ?? false, log, onStatus: options.onScanStatus })
  const membershipStatus = membershipConnectionListener(membership, scanner, h.manager, options.dryRun ?? false)
  h.onStatus = (key, status) => { membershipStatus(key, status); if (options.realBringUp) bringUps.onConnectionStatus(key, status) }
  const router = createPersonaEventRouter({ membership, routing: { receive: async () => {}, receiveReaction: async () => {} }, clientFor: h.clientFor, getPersona: h.getPersona, log })
  h.onEvent = router
  let eventId = 0
  return {
    h, authority, membership, scanner, bringUps, lines, writes, stateDir, threadHybridSince: deps.threadHybridSince!,
    failWrites(predicate: typeof refuseWrite) { refuseWrite = predicate },
    /** Install the exact production bytes, then report an uncertain directory sync. */
    unsyncWrites(predicate: typeof unsyncedWrite) { unsyncedWrite = predicate },
    allowAdmission(allowed: boolean) { admission = allowed },
    async start() { await h.clock.advanceTo(options.startTime ?? MEMBERSHIP_FIXTURE_TIME); for (const persona of h.config!.personas) { if (options.realBringUp) await bringUps.bringUp(persona, h.config!.personas); else await h.bringUp(persona) } },
    async scan() { await h.clock.runNext(); await h.clock.flush() },
    async event(member: boolean, channel: string = SHARED_CHANNEL_IDS.primary, extra: { key?: string; id?: string; timestamp?: string; event?: Partial<SlackEvent>; envelope?: EnvelopeOverrides } = {}) {
      const stub = h.stub(h.p(extra.key ?? 'alpha'))
      await stub.socket.deliver({ type: member ? 'member_joined_channel' : 'channel_left', channel, user: stub.identity.botUserId,
        channel_type: 'C', event_ts: extra.timestamp ?? ((h.clock.now() + 1) / 1000).toFixed(3), ...extra.event },
      { event_id: extra.id ?? `EvMEMBER${++eventId}`, ...extra.envelope })
    },
    captured() { return { lines, manager: h.lines, statuses: h.statuses, state: readSharedState(stateDir), authorityFile: writtenFile(authority.path) } },
    async close() { bringUps.cancelAll(); scanner.close(); membership.close(); unsubscribe(); await h.manager.stopAll() },
  }
}
export type MembershipHarness = ReturnType<typeof makeMembershipHarness>

import { applySharedMemberships, type SharedMembership, type VerifiedSharedMembership } from '../../src/shared-channels.ts'
/** `key`'s history as reconciliations saved it before SR-3.5 dropped
 * superseded repeats: `rounds` more complete reconciliations of an unchanged
 * inventory, applied by the production membership application, which keeps
 * every record. Each lists the persona's current members again and finds its
 * left channels absent again, one repeat apiece in the scanner's order, then
 * commits its inventory. Validated by the production parser. */
export function withPreRuleScanRepeats(state: SharedChannelState, key: string, rounds: number, path = 'fixture-authority'): SharedChannelState {
  const next = structuredClone(state)
  const life = next.personas[key]
  const inventory = life?.membershipInventory
  if (!life || !inventory) throw new Error('withPreRuleScanRepeats needs a reconciled persona')
  for (let round = 1; round <= rounds; round++) {
    const scanId = `00000000-0000-4000-8000-${String(round).padStart(12, '0')}`
    const facts = Object.entries(life.membership).filter(([, fact]) => fact.identity === inventory.identity)
    const observation = ([channel, fact]: [string, SharedMembership]): VerifiedSharedMembership => fact.member
      ? { event: `scan:${scanId}:${channel}`, channel, member: true, identity: fact.identity, boundary: fact.boundary,
        observedThrough: fact.observedThrough, channelType: fact.channelType, isExtSharedChannel: fact.isExtSharedChannel }
      : { event: `scan:${scanId}:absent:${channel}`, channel, member: false, identity: fact.identity, boundary: fact.boundary, observedThrough: fact.observedThrough }
    const observations = [...facts.filter(([, fact]) => fact.member), ...facts.filter(([, fact]) => !fact.member)].map(observation)
    const first = next.revision + 1
    next.revision += observations.length + 1
    applySharedMemberships(next, first, key, life.incarnation, observations)
    life.membershipInventory = { ...life.membershipInventory!, recordedOrder: next.revision }
  }
  const parsed = parseSharedChannelState(serializeSharedChannelState(next), path)
  if (!parsed) throw new Error('withPreRuleScanRepeats: expected a shared authority')
  return parsed
}

/** Applied facts and exact input, excluding only the review ledger/revision.
 * A review metadata write is not an activation. Operator tests assert those
 * ledger transitions separately; ordinary consumers compare every other fact. */
export function applicationState(input: SharedChannelState | Uint8Array | undefined) {
  let state: SharedChannelState | undefined
  try { state = input instanceof Uint8Array ? parseSharedChannelState(input, 'fixture-authority') : input } catch { return input }
  if (!state) return input
  const { revision, outcomes, ...rest } = state
  const { operatorReviews, ...otherOutcomes } = outcomes
  return { ...rest, outcomes: otherOutcomes }
}

/** Target the actual activation boundary after the durable attempt. Used by
 * crash/failure fixtures so added metadata writes cannot move the fault. */
export function activationRecord(bytes: Uint8Array, path: string): boolean {
  const state = parseSharedChannelState(bytes, path)
  const ledger = state?.outcomes.operatorReviews as { outcomes?: Record<string, { status: string; revision: number }> } | undefined
  return Object.values(ledger?.outcomes ?? {}).some(outcome => outcome.status === 'consumed' && outcome.revision === state!.revision)
}

/** A caller creates and retains this value BEFORE submission. There is no
 * default/random identifier: a fresh deliberate assignment needs an explicit
 * new ID, even when channel/value are unchanged. Retry preserves the binding. */
import type { ChannelDeliveryAttemptRequest, SharedBotAttempt } from '../../src/channel-delivery-attempt.ts'
export function deliveryAttempt(attempt_id: string, channel: string, delivery: DeliveryMode): ChannelDeliveryAttemptRequest & Record<string, unknown> {
  return { attempt_id, intent: 'assignment', channel, delivery }
}
export function retryAttempt(request: ChannelDeliveryAttemptRequest): ChannelDeliveryAttemptRequest & Record<string, unknown> {
  return { ...request, intent: 'retry' }
}
/** Recognize the production boundary, independent of metadata write counts. */
export function botAttemptRecord(bytes: Uint8Array, path: string, status: SharedBotAttempt['status']): SharedBotAttempt | undefined {
  const state = parseSharedChannelState(bytes, path)
  return Object.values(state?.outcomes.botAttempts ?? {}).find(record => record.status === status &&
    (record.status === 'pending' ? record.startedOrder : record.resolvedOrder) === state!.revision)
}
export function botApplications(state: SharedChannelState): Extract<SharedBotAttempt, { status: 'applied' }>[] {
  return Object.values(state.outcomes.botAttempts ?? {}).filter((r): r is Extract<SharedBotAttempt, { status: 'applied' }> => r.status === 'applied')
    .sort((a, b) => a.resolvedOrder - b.resolvedOrder)
}

import { botAttemptBinding, botAttemptKey } from '../../src/channel-delivery-attempt.ts'
/** F1 corruption fixtures derive only from real successfully applied records.
 * They deliberately bypass the validating seed writer; never normalize them. */
export function contradictoryBotHistory(state: SharedChannelState, shape: 'rejection-at-assignment' | 'colliding-attempts' | 'pending-at-terminal' | 'pending-at-inventory'): SharedChannelState {
  const next = structuredClone(state)
  const original = botApplications(next)[0]!
  if (!original) throw new Error('contradictoryBotHistory needs a production application')
  const { facts, previous, ...base } = original
  const rejection = { ...base, status: 'not-applied' as const, reason: 'write-failed' as const }
  if (shape === 'rejection-at-assignment') next.outcomes.botAttempts![botAttemptKey(original)] = rejection
  else {
    const binding = botAttemptBinding(original.key, original.incarnation, deliveryAttempt('colliding-retained-id', original.channel, original.delivery))
    if (shape === 'colliding-attempts') next.outcomes.botAttempts![botAttemptKey(binding)] = { ...rejection, ...binding }
    else {
      const startedOrder = shape === 'pending-at-terminal' ? original.resolvedOrder : next.personas[original.key]?.membershipInventory?.recordedOrder
      if (!startedOrder) throw new Error('contradictoryBotHistory needs a production inventory')
      next.outcomes.botAttempts![botAttemptKey(binding)] = { ...binding, status: 'pending', startedOrder }
    }
  }
  return next
}

import { reviewLedger } from '../../src/reload-review.ts'
/** `state`'s review history as a CSCB before SR-3.5 saved it, which dropped no
 * outcome: after `state`'s own outcomes, every other outcome the `earlier`
 * production states recorded, each at its last saved status. Validated by the
 * production parser. */
export function withPreRuleReviewOutcomes(state: SharedChannelState, earlier: readonly SharedChannelState[], path = 'fixture-authority'): SharedChannelState {
  const next = structuredClone(state)
  const ledger = reviewLedger(next)
  if (!ledger) throw new Error('withPreRuleReviewOutcomes needs a review history')
  const own = new Set(Object.keys(ledger.outcomes))
  for (const old of earlier) {
    for (const [fingerprint, outcome] of Object.entries(reviewLedger(old)?.outcomes ?? {})) {
      if (!own.has(fingerprint)) ledger.outcomes[fingerprint] = structuredClone(outcome)
    }
  }
  const parsed = parseSharedChannelState(serializeSharedChannelState(next), path)
  if (!parsed) throw new Error('withPreRuleReviewOutcomes: expected a shared authority')
  return parsed
}
/** A readability fixture derived from a real bot application in a valid
 * production state: only the attempt's start moves, onto the saved revision of
 * the review outcome `fingerprint`, so the one broken relation is that shared
 * position. Deliberately bypasses the validating seed writer. */
export function botAttemptAtReviewOutcome(state: SharedChannelState, fingerprint: string): SharedChannelState {
  const next = structuredClone(state)
  const application = botApplications(next)[0], outcome = reviewLedger(next)?.outcomes[fingerprint]
  if (!application || !outcome) throw new Error('botAttemptAtReviewOutcome needs a production application and a saved outcome')
  application.startedOrder = outcome.revision
  return next
}

import type { BotAttemptResult } from '../../src/channel-delivery-attempt.ts'
import { BOT_ATTEMPT_REJECTIONS } from '../../src/channel-delivery-attempt.ts'
import type { ChannelDeliveryCurrentFacts, ChannelDeliveryUnavailableReason } from '../../src/channel-delivery.ts'
/** Complete rendering fixtures, shared by offered-text and secrecy audits.
 * Binding comes from production hashing; no raw caller identifier is a result. */
export function deliveryResultSamples(): Array<{ form: string; result: BotAttemptResult; current?: ChannelDeliveryCurrentFacts }> {
  const binding = botAttemptBinding('alpha', 'text-fixture-life', deliveryAttempt('text-fixture-retained', SHARED_CHANNEL_IDS.primary, 'all'))
  const facts = { saved: 'all' as const, effective: 'all' as const }
  const current: ChannelDeliveryCurrentFacts = { kind: 'available', mode: 'strict', facts: { saved: 'off', effective: 'off' } }
  const outcome = { ...binding, startedOrder: 2, resolvedOrder: 3, status: 'applied' as const, facts }
  return [
    ...[false, true].map(historical => ({ form: historical ? 'historical' : 'new', result: { kind: 'applied' as const, historical, outcome }, current })),
    ...BOT_ATTEMPT_REJECTIONS.map(reason => ({ form: `not-applied-${reason}`, result: { kind: 'not-applied' as const, reason }, current })),
    ...(['pending', 'unresolved', 'binding-conflict', 'invalid', 'inactive'] as const).map(kind => ({ form: kind, result: { kind }, ...(kind === 'pending' || kind === 'unresolved' ? { current } : {}) })),
  ]
}
export function deliveryCurrentSamples(): Array<{ form: string; current: ChannelDeliveryCurrentFacts }> {
  const reasons: ChannelDeliveryUnavailableReason[] = ['shared-state-unreadable', 'channel-removed', 'absent', 'external-sharing', 'invalid-channel', 'installation-unverified', 'current-membership-missing', 'event-order-conflict', 'history-unresolved', 'event-not-durable', 'eligibility-missing']
  return [
    ...(['strict', 'open'] as const).flatMap(mode => (['off', 'mentions', 'all', 'thread_hybrid'] as const).map(saved => ({
      form: `${mode}-${saved}`, current: { kind: 'available' as const, mode, facts: { saved, effective: saved } },
    }))),
    ...reasons.flatMap(reason => [undefined, 'all' as const].map(saved => ({ form: `${reason}-${saved ?? 'unknown'}`, current: { kind: 'unavailable' as const, reason, ...(saved ? { saved } : {}) } }))),
  ]
}

/** A single serialized tools/call gate; tests retain/release each admitted turn. */
export function makeToolCallGate() {
  let arrive!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { arrive = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  return { entered, release, async wait() { arrive(); await pending } }
}
/** A message-body marker independent of credential/token redaction. */
export const ATTEMPT_BODY_SENTINEL = 'PRIVATE_BODY_ATTEMPT_8b6f'

/** Invalid variants start with a genuine application, never an opaque outcome. */
export function malformedBotHistories(state: SharedChannelState): Array<{ label: string; state: SharedChannelState }> {
  const changes: Array<[string, (record: Record<string, unknown>, copy: SharedChannelState) => void]> = [
    ['extra raw identifier', r => { r.attempt_id = 'must-not-be-persisted' }],
    ['wrong digest', r => { r.identifierHash = 'bad' }],
    ['foreign incarnation', r => { r.incarnation = 'missing-life' }],
    ['unknown status', r => { r.status = 'success' }],
    ['future start', (r, s) => { r.startedOrder = s.revision + 1 }],
    ['noninteger start', r => { r.startedOrder = 1.5 }],
    ['terminal before start', r => { r.resolvedOrder = Number(r.startedOrder) - 1 }],
    ['future terminal', (r, s) => { r.resolvedOrder = s.revision + 1 }],
    ['original saved mismatch', r => { r.facts = { saved: 'off', effective: 'off' } }],
    ['invented effective fallback', r => { r.facts = { saved: r.delivery, effective: 'off' } }],
    ['obsolete third fact key', r => { r.facts = { saved: r.delivery, effective: r.delivery, heldByLoopGuard: false } }],
    ['unknown rejection reason', r => { r.status = 'not-applied'; r.reason = 'timeout'; delete r.facts; delete r.previous }],
    ['pending with terminal fields', r => { r.status = 'pending' }],
    ['assignment precedes application', (r, s) => { s.personas[String(r.key)]!.assignments[String(r.channel)]!.order = Number(r.startedOrder) }],
  ]
  return changes.map(([label, mutate]) => {
    const copy = structuredClone(state), record = Object.values(copy.outcomes.botAttempts!)[0]!
    mutate(record as unknown as Record<string, unknown>, copy)
    return { label, state: copy }
  })
}
