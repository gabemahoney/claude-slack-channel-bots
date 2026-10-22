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

export const SHARED_CHANNEL_IDS = { primary: 'C0TEST001', secondary: 'C0TEST002', private: 'G0TEST003' } as const
export function sharedChannelPath(stateDir: string): string { return join(resolve(stateDir), 'config.json.last-applied') }
export function configBytes(input: unknown): Buffer { return Buffer.from(JSON.stringify(input, null, 2) + '\n') }
export function channelPopulation(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `C0LARGE${String(i + offset).padStart(5, '0')}`,
    delivery: (['off', 'mentions', 'all', 'thread_hybrid'] as const)[i % 4]!,
  }))
}
export function initialSharedState(stateDir: string, input: PersonaConfigInput = makePersonaConfigInput({}, stateDir)): SharedChannelState {
  const bytes = configBytes(input)
  const config = parsePersonaConfigBytes(bytes, join(stateDir, 'config.json'), stateDir)
  let life = 0
  return initialSharedChannelState(bytes, config, () => `fixture-incarnation-${++life}`)
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
export function makeSharedAuthority(stateDir: string, input = makePersonaConfigInput({}, stateDir), deps: SharedChannelDeps = {}) {
  const state = initialSharedState(stateDir, input)
  writeSharedState(stateDir, state)
  return createSharedChannelAuthority(sharedChannelPath(stateDir), state, deps)
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
} = {}) {
  const names = options.names ?? ['alpha']
  const input = makePersonaConfigInput({ ...(options.queuedAckReaction ? { queued_ack_reaction: options.queuedAckReaction } : {}), channel_mode: options.mode ?? 'open', personas: names.map(name =>
    makePersona({ name, channels: options.channels ?? [], permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' } }, stateDir)) }, stateDir)
  let refuseWrite: (state: SharedChannelState) => boolean = () => false
  const writes: SharedChannelState[] = []
  const deps: SharedChannelDeps = { now: () => h.clock.now(), write(path, bytes) {
    const state = parseSharedChannelState(bytes, path)!
    writes.push(state)
    if (refuseWrite(state)) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' })
    durableWriteFileSync(path, bytes)
  } }
  const authority = options.reopen
    ? createSharedChannelAuthority(sharedChannelPath(stateDir), readSharedState(stateDir)!, deps)
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
