/** Shared-authority fixtures: production schema, serializer and durable writer only. */
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { durableWriteFileSync } from '../../src/atomic-write.ts'
import { parsePersonaConfigBytes, type PersonaConfigInput } from '../../src/config.ts'
import {
  createSharedChannelAuthority, initialSharedChannelState, parseSharedChannelState,
  serializeSharedChannelState, type SharedChannelDeps, type SharedChannelState,
} from '../../src/shared-channels.ts'
import { isRealHome, isUnder, osTempDir } from './host-safe-env.ts'
import { makePersonaConfigInput } from './persona-config.ts'
import { writtenFile } from './credentials.ts'
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

export const SHARED_CHANNEL_IDS = { primary: 'C0TEST001', secondary: 'C0TEST002', private: 'G0TEST003' } as const
export function sharedChannelPath(stateDir: string): string { return join(resolve(stateDir), 'config.json.last-applied') }
export function configBytes(input: unknown): Buffer { return Buffer.from(JSON.stringify(input, null, 2) + '\n') }

import { REVIEW_REQUEST_FORMAT } from '../../src/reload-request.ts'
import { parseSharedRecoveryRequest, recoveryHash, type SharedRecoveryRequest } from '../../src/shared-recovery.ts'
/** Bound recovery input, validated by the production grammar. No snapshot
 * field is offered: restoration belongs only to the running authority. */
export function sharedRecoveryRequest(id: string, evidence: Uint8Array, replacement?: Uint8Array): SharedRecoveryRequest {
  const value = { format: REVIEW_REQUEST_FORMAT, request_id: id, evidence_sha256: recoveryHash(evidence),
    ...(replacement === undefined ? { action: 'restore' } : { action: 'replace', replacement_source_base64: Buffer.from(replacement).toString('base64') }) }
  const request = parseSharedRecoveryRequest(value)
  if (!request) throw new Error('sharedRecoveryRequest: invalid fixture input')
  return request
}
export function channelPopulation(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `C0LARGE${String(i + offset).padStart(5, '0')}`,
    delivery: (['off', 'mentions', 'all', 'thread_hybrid'] as const)[i % 4]!,
  }))
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
import { createMembershipScanner, membershipConnectionListener } from '../../src/channel-membership-scan.ts'
import { createPersonaEventRouter } from '../../src/persona-event-router.ts'
import { makeConnectionHarness } from './persona-connection-harness.ts'
import { makePersona } from './persona-config.ts'
import { createPersonaBringUpController } from '../../src/persona-bringup-controller.ts'
import { checkPersonaConfigDir } from '../../src/persona-bringup.ts'
import type { ChannelMode, DeliveryMode } from '../../src/config.ts'
import type { SettledWebApiOutcome, SlackEvent, EnvelopeOverrides } from './slack-stub.ts'

export const MEMBERSHIP_FIXTURE_TIME = 1_700_000_000_000
export function membershipPage(channels: Array<string | Record<string, unknown>>, cursor?: string | null): SettledWebApiOutcome {
  return { kind: 'ok', result: { channels: channels.map(c => typeof c === 'string' ? {
    id: c, is_channel: c.startsWith('C'), is_group: c.startsWith('G'), is_im: false, is_mpim: false, is_ext_shared: false,
  } : c), ...(cursor === undefined ? { response_metadata: undefined } : { response_metadata: { next_cursor: cursor } }) } }
}
export function makeMembershipHarness(stateDir: string, options: {
  realBringUp?: boolean; queuedAckReaction?: string; mode?: ChannelMode; dryRun?: boolean; reopen?: boolean; names?: string[];
  startTime?: number;
  channels?: Array<{ id: string; delivery: DeliveryMode }>;
  /** Defaults to the fixture counter, continuing past a reopened state's values. */
  threadHybridSince?: () => string;
} = {}) {
  const names = options.names ?? ['alpha']
  const input = makePersonaConfigInput({ ...(options.queuedAckReaction ? { queued_ack_reaction: options.queuedAckReaction } : {}), channel_mode: options.mode ?? 'open', personas: names.map(name =>
    makePersona({ name, channels: options.channels ?? [], permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' } }, stateDir)) }, stateDir)
  let refuseWrite: (state: SharedChannelState) => boolean = () => false
  const writes: SharedChannelState[] = []
  const reopened = options.reopen ? readSharedState(stateDir)! : undefined
  const deps: SharedChannelDeps = { now: () => h.clock.now(), threadHybridSince: options.threadHybridSince ?? fixtureThreadHybridSince(reopened), write(path, bytes) {
    const state = parseSharedChannelState(bytes, path)!
    writes.push(state)
    if (refuseWrite(state)) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' })
    durableWriteFileSync(path, bytes)
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
  const scanner = createMembershipScanner({ authority, membership, connections: h.manager, clock: h.clock, dryRun: options.dryRun ?? false, log })
  const membershipStatus = membershipConnectionListener(membership, scanner, h.manager, options.dryRun ?? false)
  h.onStatus = (key, status) => { membershipStatus(key, status); if (options.realBringUp) bringUps.onConnectionStatus(key, status) }
  const router = createPersonaEventRouter({ membership, routing: { receive: async () => {} }, clientFor: h.clientFor, getPersona: h.getPersona, log })
  h.onEvent = router
  let eventId = 0
  return {
    h, authority, membership, scanner, bringUps, lines, writes, stateDir,
    failWrites(predicate: typeof refuseWrite) { refuseWrite = predicate },
    allowAdmission(allowed: boolean) { admission = allowed },
    async start() { await h.clock.advanceTo(options.startTime ?? MEMBERSHIP_FIXTURE_TIME); for (const persona of h.config!.personas) { if (options.realBringUp) await bringUps.bringUp(persona, h.config!.personas); else await h.bringUp(persona) } },
    async scan() { await h.clock.runNext(); await h.clock.flush() },
    async event(member: boolean, channel: string = SHARED_CHANNEL_IDS.primary, extra: { key?: string; id?: string; timestamp?: string; event?: Partial<SlackEvent>; envelope?: EnvelopeOverrides } = {}) {
      const stub = h.stub(h.p(extra.key ?? 'alpha'))
      await stub.socket.deliver({ type: member ? 'member_joined_channel' : 'channel_left', channel, user: stub.identity.botUserId,
        channel_type: 'C', event_ts: extra.timestamp ?? ((h.clock.now() + 1) / 1000).toFixed(3), ...extra.event },
      { event_id: extra.id ?? `EvMEMBER${++eventId}`, ...extra.envelope })
    },
    assign(channel: string, delivery: DeliveryMode, key = 'alpha') { return authority.assign(key, authority.incarnation(key)!, channel, delivery, authority.revision) },
    captured() { return { lines, manager: h.lines, statuses: h.statuses, state: readSharedState(stateDir), authorityFile: writtenFile(authority.path) } },
    async close() { bringUps.cancelAll(); scanner.close(); membership.close(); unsubscribe(); await h.manager.stopAll() },
  }
}
export type MembershipHarness = ReturnType<typeof makeMembershipHarness>

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

import type { BotAttemptResult } from '../../src/channel-delivery-attempt.ts'
import { BOT_ATTEMPT_REJECTIONS } from '../../src/channel-delivery-attempt.ts'
import type { ChannelDeliveryCurrentFacts, ChannelDeliveryUnavailableReason } from '../../src/channel-delivery.ts'
/** Complete rendering fixtures, shared by offered-text and secrecy audits.
 * Binding comes from production hashing; no raw caller identifier is a result. */
export function deliveryResultSamples(): Array<{ form: string; result: BotAttemptResult; current?: ChannelDeliveryCurrentFacts }> {
  const binding = botAttemptBinding('alpha', 'text-fixture-life', deliveryAttempt('text-fixture-retained', SHARED_CHANNEL_IDS.primary, 'all'))
  const facts = { saved: 'all' as const, effective: 'mentions' as const, heldByLoopGuard: true }
  const current: ChannelDeliveryCurrentFacts = { kind: 'available', mode: 'strict', facts: { saved: 'off', effective: 'off', heldByLoopGuard: false } }
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
      form: `${mode}-${saved}`, current: { kind: 'available' as const, mode, facts: { saved, effective: saved, heldByLoopGuard: false } },
    }))),
    { form: 'current-guard', current: { kind: 'available', mode: 'open', facts: { saved: 'all', effective: 'mentions', heldByLoopGuard: true } } },
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
    ['original saved mismatch', r => { r.facts = { saved: 'off', effective: 'off', heldByLoopGuard: false } }],
    ['invented effective fallback', r => { r.facts = { saved: r.delivery, effective: 'off', heldByLoopGuard: true } }],
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
