/** Operator-owned setup evidence. Import-safe, no network or credentials, and
 * never a delivery gate. The shared authority owns its durable record. */
import type { SharedChannelAuthority } from './shared-channels.ts'
import type { PersonaEventProvenance } from './persona-connections.ts'
import type { MembershipScanStatus } from './channel-membership-scan.ts'
import { slackInstallationIdentity, slackInstallationKey, type SlackInstallationIdentity } from './persona-slack-validation.ts'
import { INTERJECT_BODY_CAP_BYTES, isLocalAddress } from './interject.ts'
import { resolvePersonaTarget } from './persona-identity.ts'

export const MEMBERSHIP_READINESS_ROUTE = '/membership-readiness'
export const MEMBERSHIP_REQUIRED_SUBSCRIPTIONS = ['member_joined_channel', 'channel_left'] as const
export const MEMBERSHIP_SETUP_UNKNOWN = 'channel-membership-setup-unknown'
export const MEMBERSHIP_SUBSCRIPTIONS_MISSING = 'channel-membership-subscriptions-missing'
export const MEMBERSHIP_REINSTALL_INCOMPLETE = 'channel-membership-reinstall-incomplete'
export const MEMBERSHIP_SETUP_VERIFIED = 'channel-membership-setup-verified'
export const MEMBERSHIP_SETUP_RECORDED = 'channel-membership-setup-recorded'

export type MembershipSubscriptionEvidence = 'verified' | 'missing' | 'unknown'
export interface MembershipSetupInput {
  installation: SlackInstallationIdentity
  subscriptions: Record<typeof MEMBERSHIP_REQUIRED_SUBSCRIPTIONS[number], MembershipSubscriptionEvidence>
  reinstall: 'complete' | 'incomplete' | 'unknown'
}
export interface MembershipSetupRecord extends MembershipSetupInput {
  recordedAt: number
  order: number
}
export interface MembershipSetupReading {
  state: 'verified' | 'missing-subscriptions' | 'incomplete-reinstall' | 'unknown'
  reason?: 'installation-unverified' | 'shared-state-unreadable' | 'manual-evidence-missing' | 'manual-evidence-incomplete'
  installation?: SlackInstallationIdentity
  record?: MembershipSetupRecord
  missingSubscriptions: string[]
  unknownSubscriptions: string[]
  reinstall: MembershipSetupInput['reinstall']
}
export interface MembershipReadinessView {
  inventory: MembershipScanStatus
  setup: MembershipSetupReading
}
export type MembershipSetupResult =
  | { kind: 'recorded'; revision: number; view: MembershipReadinessView }
  | { kind: 'invalid' | 'unknown-persona' | 'installation-unverified' | 'installation-mismatch' | 'storage' | 'superseded' }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
/** Project only validated IDs and fixed evidence values; never retain request
 * extras, free text or raw Slack responses in the durable state/readback. */
export function parseMembershipSetupInput(value: unknown): MembershipSetupInput | undefined {
  if (!object(value) || !object(value['installation']) || !object(value['subscriptions'])) return undefined
  const raw = value['installation']
  if (typeof raw['botUserId'] !== 'string' || typeof raw['botId'] !== 'string') return undefined
  const identity = slackInstallationIdentity({ botUserId: raw['botUserId'], botId: raw['botId'],
    teamId: typeof raw['teamId'] === 'string' ? raw['teamId'] : undefined,
    appId: typeof raw['appId'] === 'string' ? raw['appId'] : undefined })
  if (!identity || !['complete', 'incomplete', 'unknown'].includes(value['reinstall'] as string)) return undefined
  const subscriptions = value['subscriptions']
  if (!MEMBERSHIP_REQUIRED_SUBSCRIPTIONS.every(event => ['verified', 'missing', 'unknown'].includes(subscriptions[event] as string))) return undefined
  return { installation: identity, subscriptions: {
    member_joined_channel: subscriptions['member_joined_channel'] as MembershipSubscriptionEvidence,
    channel_left: subscriptions['channel_left'] as MembershipSubscriptionEvidence,
  }, reinstall: value['reinstall'] as MembershipSetupInput['reinstall'] }
}

export function validateMembershipSetupRecords(value: unknown, revision: number): asserts value is Record<string, MembershipSetupRecord> {
  if (!object(value)) throw new Error('Invalid installation readiness evidence.')
  for (const [key, record] of Object.entries(value)) {
    const input = parseMembershipSetupInput(record)
    if (!input || !object(record) || key !== slackInstallationKey(input.installation) ||
        !Number.isSafeInteger(record['recordedAt']) || (record['recordedAt'] as number) < 0 ||
        !Number.isSafeInteger(record['order']) || (record['order'] as number) < 1 || (record['order'] as number) > revision ||
        JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(['installation', 'order', 'recordedAt', 'reinstall', 'subscriptions']) ||
        Object.keys(record['installation'] as object).length !== 4 || Object.keys(record['subscriptions'] as object).length !== 2) {
      throw new Error('Invalid installation readiness evidence.')
    }
  }
}

function unknownSetup(reason: MembershipSetupReading['reason'], installation?: SlackInstallationIdentity): MembershipSetupReading {
  return { state: 'unknown', reason, installation, missingSubscriptions: [], unknownSubscriptions: [...MEMBERSHIP_REQUIRED_SUBSCRIPTIONS], reinstall: 'unknown' }
}
export function membershipReadinessDiagnostic(key: string, reading: MembershipSetupReading): string {
  const code = reading.state === 'verified' ? MEMBERSHIP_SETUP_VERIFIED :
    reading.state === 'missing-subscriptions' ? MEMBERSHIP_SUBSCRIPTIONS_MISSING :
    reading.state === 'incomplete-reinstall' ? MEMBERSHIP_REINSTALL_INCOMPLETE : MEMBERSHIP_SETUP_UNKNOWN
  const details = `missing=${reading.missingSubscriptions.join(',') || 'none'} unknown=${reading.unknownSubscriptions.join(',') || 'none'} reinstall=${reading.reinstall}`
  const action = reading.state === 'verified' ? 'Manual evidence covers this installation; current inventory is reported separately.' :
    `Check both required subscriptions and reinstall completion for the authenticated app; record the result through the local ${MEMBERSHIP_READINESS_ROUTE} operator interface.`
  return `[slack] ${code} persona=${key}: ${details}${reading.reason ? ` reason=${reading.reason}` : ''}. ${action}`
}
export function membershipSetupRecordedDiagnostic(key: string): string {
  return `[slack] ${MEMBERSHIP_SETUP_RECORDED} persona=${key}: saved manual evidence for the authenticated current installation; inventory and saved choices are unchanged.`
}

export interface MembershipReadinessDeps {
  authority: SharedChannelAuthority
  provenance(key: string): PersonaEventProvenance | undefined
  inventory(key: string): MembershipScanStatus
  dryRun: boolean
  isRetiring?(key: string): boolean
  now?: () => number
  log(line: string): void
}
export interface MembershipReadiness {
  read(key: string): MembershipReadinessView
  record(key: string, input: unknown): MembershipSetupResult
  report(key: string): void
  forget(key: string): void
  close(): void
}
export function createMembershipReadiness(deps: MembershipReadinessDeps): MembershipReadiness {
  const episodes = new Map<string, string>()
  let closed = false
  function current(key: string): SlackInstallationIdentity | undefined {
    const provenance = deps.provenance(key)
    if (closed || deps.dryRun || deps.isRetiring?.(key) || !provenance?.applied || provenance.key !== key ||
        !provenance.isCurrent() || provenance.incarnation !== deps.authority.incarnation(key)) return undefined
    return slackInstallationIdentity(provenance.identity)
  }
  function read(key: string): MembershipReadinessView {
    const identity = current(key)
    let setup = unknownSetup(identity ? 'manual-evidence-missing' : 'installation-unverified', identity)
    if (!deps.authority.readable) setup = unknownSetup('shared-state-unreadable', identity)
    else if (identity) {
      const life = deps.authority.snapshot().personas[key]
      const record = life?.installationReadiness?.[slackInstallationKey(identity)]
      if (record) {
        const missingSubscriptions = MEMBERSHIP_REQUIRED_SUBSCRIPTIONS.filter(event => record.subscriptions[event] === 'missing')
        const unknownSubscriptions = MEMBERSHIP_REQUIRED_SUBSCRIPTIONS.filter(event => record.subscriptions[event] === 'unknown')
        const state = missingSubscriptions.length ? 'missing-subscriptions' : record.reinstall === 'incomplete' ? 'incomplete-reinstall' :
          unknownSubscriptions.length || record.reinstall === 'unknown' ? 'unknown' : 'verified'
        setup = { state, installation: identity, record, missingSubscriptions, unknownSubscriptions, reinstall: record.reinstall,
          ...(state === 'unknown' ? { reason: 'manual-evidence-incomplete' as const } : {}) }
      }
    }
    return { inventory: deps.inventory(key), setup }
  }
  function log(line: string): void { try { deps.log(line) } catch { /* diagnostics never undo durable evidence */ } }
  function report(key: string): void {
    if (closed) return
    const setup = read(key).setup
    const signature = JSON.stringify([setup.installation, setup.state, setup.reason, setup.record?.subscriptions, setup.reinstall])
    if (episodes.get(key) === signature) return
    episodes.set(key, signature)
    log(membershipReadinessDiagnostic(key, setup))
  }
  return {
    read, report,
    record(key, value) {
      const input = parseMembershipSetupInput(value)
      if (!input) return { kind: 'invalid' }
      const incarnation = deps.authority.incarnation(key)
      if (!incarnation) return { kind: 'unknown-persona' }
      const identity = current(key)
      if (!identity) return { kind: 'installation-unverified' }
      const identityKey = slackInstallationKey(identity)
      if (identityKey !== slackInstallationKey(input.installation)) return { kind: 'installation-mismatch' }
      const recordedAt = (deps.now ?? Date.now)()
      const result = deps.authority.transact(deps.authority.revision, (next, order) => {
        const life = next.personas[key]
        if (!life || life.incarnation !== incarnation) throw new Error('Superseded installation readiness.')
        life.installationReadiness ??= {}
        Object.defineProperty(life.installationReadiness, identityKey, {
          value: { ...input, recordedAt, order }, enumerable: true, configurable: true, writable: true,
        })
      })
      if (result.kind !== 'applied') return { kind: result.kind === 'stale' ? 'superseded' : 'storage' }
      log(membershipSetupRecordedDiagnostic(key))
      report(key)
      return { kind: 'recorded', revision: result.revision, view: read(key) }
    },
    forget: key => { episodes.delete(key) },
    close() { closed = true; episodes.clear() },
  }
}

export interface MembershipReadinessHandlerDeps {
  getPersonaConfig(): { personas: readonly { key: string; name: string }[] } | null
  readiness: Pick<MembershipReadiness, 'read' | 'record'>
}
/** POST {action:"read",persona:key-or-name}, or
 * POST {action:"record",persona:key-or-name,installation:{teamId,appId,botUserId,botId},
 *       subscriptions:{member_joined_channel,channel_left},reinstall}.
 * Read first for the authenticated IDs; record explicit manual evidence only.
 * This local operator route is intentionally absent from MCP/agent tools. */
export async function handleMembershipReadiness(
  req: Request, remoteAddress: string | null | undefined, deps: MembershipReadinessHandlerDeps,
): Promise<Response> {
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  if (req.method !== 'POST') return answer(405, { error: 'Method Not Allowed' })
  if (!isLocalAddress(remoteAddress ?? '')) return answer(403, { error: 'Forbidden' })
  let body: unknown
  try {
    const text = await req.text()
    if (new TextEncoder().encode(text).byteLength > INTERJECT_BODY_CAP_BYTES) return answer(413, { error: 'Request body too large' })
    body = JSON.parse(text)
  } catch { return answer(400, { error: 'Invalid request body' }) }
  if (!object(body) || typeof body['persona'] !== 'string' || !body['persona'] || !['read', 'record'].includes(body['action'] as string)) return answer(400, { error: 'Invalid action or persona' })
  try {
    const persona = resolvePersonaTarget(deps.getPersonaConfig(), body['persona'])
    if (!persona) return answer(404, { error: 'Persona not found in the applied config' })
    if (body['action'] === 'read') return answer(200, { ok: true, persona: persona.key, view: deps.readiness.read(persona.key) })
    const result = deps.readiness.record(persona.key, body)
    const status = result.kind === 'recorded' ? 200 : result.kind === 'invalid' ? 400 : result.kind === 'unknown-persona' ? 404 : result.kind === 'storage' ? 503 : 409
    return answer(status, result)
  } catch { return answer(500, { error: 'Internal Server Error' }) }
}
