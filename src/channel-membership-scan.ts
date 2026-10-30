/** Background inventory collection. Cursor pagination and application are
 * separate from message acknowledgement and from installation readiness. */
import { randomUUID } from 'node:crypto'
import { CHANNEL_ID_RE } from './config.ts'
import type { ChannelMembership, MembershipGeneration } from './channel-membership.ts'
import type { SharedChannelAuthority } from './shared-channels.ts'
import { SYSTEM_PERSONA_CONNECTION_CLOCK, type PersonaConnectionClock, type PersonaConnectionManager, type PersonaStatusListener } from './persona-connections.ts'
import { classifySlackValidationError, slackRetryAfterSeconds, type SlackValidationFailure } from './persona-slack-validation.ts'
import {
  boundedMembershipCall, MembershipCancelledError, MembershipDeadlineError, membershipRetryDelay,
  MEMBERSHIP_ATTEMPT_TIMEOUT_MS, MEMBERSHIP_RETRY_MIN_MS, MEMBERSHIP_TIMER_MAX_MS, MEMBERSHIP_VALIDATION_TIMEOUT_MS,
} from './channel-membership-retry.ts'

export const MEMBERSHIP_INVENTORY_INCOMPLETE = 'channel-membership-inventory-incomplete'
export const MEMBERSHIP_INVENTORY_COMPLETE = 'channel-membership-inventory-complete'
export type MembershipScanProblem = 'deadline' | 'access' | 'authentication' | 'transport' | 'malformed-page' | 'superseded' | 'storage' | 'installation-unverified' | 'current-membership-missing' | 'eligibility-missing' | 'event-order-conflict' | 'history-unresolved'
export interface MembershipScanStatus {
  state: 'unverified' | 'scanning' | 'incomplete' | 'complete'
  pages: number
  positives: number
  deadline?: number
  nextAttemptAt?: number
  retryAfterSeconds?: number
  problem?: MembershipScanProblem
  slackError?: string
}
export function membershipScanDiagnostic(key: string, status: MembershipScanStatus): string {
  const timing = status.nextAttemptAt === undefined ? '' : ` next_attempt_at=${status.nextAttemptAt}`
  const retry = status.retryAfterSeconds === undefined ? '' : ` retry_after_seconds=${status.retryAfterSeconds}`
  const deadline = status.deadline === undefined ? '' : ` deadline_at=${status.deadline}`
  const code = status.state === 'complete' ? MEMBERSHIP_INVENTORY_COMPLETE : MEMBERSHIP_INVENTORY_INCOMPLETE
  const repair = status.state === 'complete' ? 'Inventory evidence is current; subscription/reinstall verification is separate.' :
    'Restore the named access or storage evidence; background retries continue. Accepted work remains queued.'
  return `[slack] ${code} persona=${key}: pages=${status.pages} positives=${status.positives} reason=${status.problem ?? 'none'}${status.slackError ? ` slack_error=${status.slackError}` : ''}${deadline}${timing}${retry}. ${repair}`
}
export interface MembershipScanDeps {
  authority: SharedChannelAuthority
  membership: ChannelMembership
  connections: Pick<PersonaConnectionManager, 'revalidateMembership' | 'membershipPage'>
  dryRun: boolean
  clock?: PersonaConnectionClock
  log(line: string): void
  onStatus?(key: string, status: MembershipScanStatus, ended: boolean): void
}
export interface MembershipScanner {
  /** Scheduling only. Never starts a network operation in the calling stack. */
  request(key: string): void
  /** A gap revokes evidence synchronously, and retries without new traffic. */
  connectionChanged(key: string, schedule?: boolean, outcome?: SlackValidationFailure): void
  stop(key: string): void
  close(): void
  status(key: string): MembershipScanStatus
  ended(key: string): boolean
}

/** Called before other up-status consumers. A gap revokes old evidence
 * synchronously; all discovery/revalidation remains scheduled background work. */
export function membershipConnectionListener(
  membership: ChannelMembership, scanner: MembershipScanner,
  connections: Pick<PersonaConnectionManager, 'provenance'>, dryRun: boolean,
): PersonaStatusListener {
  return (key, status) => {
    if (dryRun) return
    if (status.state === 'stopped') { scanner.stop(key); return }
    if (status.state === 'connecting') { scanner.connectionChanged(key, false); return }
    scanner.connectionChanged(key, true, 'outcome' in status ? status.outcome : undefined)
    if (status.state === 'up') {
      const provenance = connections.provenance(key)
      if (provenance) membership.activate(key, provenance)
    }
  }
}
interface ScanEntry {
  key: string
  incarnation: string | undefined
  timer?: { handle: unknown }
  active?: AbortController
  phase?: 'validation' | 'inventory'
  observations?: number
  failures: number
  notBefore: number
  status: MembershipScanStatus
  lastDiagnostic?: string
  ended?: boolean
}
class ScanFailure extends Error {
  constructor(readonly problem: MembershipScanProblem, readonly outcome?: SlackValidationFailure) { super('Membership inventory remains incomplete.') }
}
interface InventoryPage {
  channels: Array<{ id: string; channelType?: 'channel' | 'group'; isExtSharedChannel?: boolean }>
  cursor: string
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function parsePage(value: unknown): InventoryPage {
  if (!object(value) || value['ok'] !== true || !Array.isArray(value['channels'])) throw new ScanFailure('malformed-page')
  const metadata = value['response_metadata']
  if (metadata !== undefined && !object(metadata)) throw new ScanFailure('malformed-page')
  const cursor = metadata?.['next_cursor']
  // Slack's pagination contract terminates on an empty, null or absent
  // cursor, including an absent metadata object. Page length is irrelevant.
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') throw new ScanFailure('malformed-page')
  const channels: InventoryPage['channels'] = []
  for (const raw of value['channels']) {
    if (!object(raw) || typeof raw['id'] !== 'string' || !CHANNEL_ID_RE.test(raw['id'])) throw new ScanFailure('malformed-page')
    if (raw['is_im'] === true || raw['is_mpim'] === true) throw new ScanFailure('malformed-page')
    const type = raw['is_im'] === false && raw['is_mpim'] === false
      ? raw['is_channel'] === true ? 'channel' : raw['is_group'] === true ? 'group' : undefined : undefined
    channels.push({ id: raw['id'], channelType: type, ...(typeof raw['is_ext_shared'] === 'boolean' ? { isExtSharedChannel: raw['is_ext_shared'] } : {}) })
  }
  return { channels, cursor: typeof cursor === 'string' ? cursor : '' }
}
function errorProblem(outcome: SlackValidationFailure): MembershipScanProblem {
  if (outcome.kind === 'slack-unreachable') return 'transport'
  return ['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed'].includes(outcome.slackError) ? 'authentication' : 'access'
}

export function createMembershipScanner(deps: MembershipScanDeps): MembershipScanner {
  const clock = deps.clock ?? SYSTEM_PERSONA_CONNECTION_CLOCK
  const entries = new Map<string, ScanEntry>()
  let closed = false
  const unsubscribe = deps.authority.subscribe(() => {
    for (const [key, entry] of entries) {
      if (entry.incarnation !== deps.authority.incarnation(key)) stop(key)
    }
  })
  const blank = (): MembershipScanStatus => ({ state: 'unverified', pages: 0, positives: 0 })
  const valid = (entry: ScanEntry, controller: AbortController) => !closed && entries.get(entry.key) === entry && entry.active === controller && !controller.signal.aborted
  function publish(entry: ScanEntry, ended = false): void {
    const signature = JSON.stringify([entry.status.state, entry.status.problem, entry.status.slackError,
      entry.status.deadline, entry.status.nextAttemptAt, entry.status.retryAfterSeconds])
    if (signature === entry.lastDiagnostic) return
    entry.lastDiagnostic = signature
    entry.ended = ended
    try { deps.log(membershipScanDiagnostic(entry.key, entry.status)) } catch { /* diagnostics do not change evidence */ }
    try { deps.onStatus?.(entry.key, { ...entry.status }, ended) } catch { /* reporting does not change evidence */ }
  }
  function arm(entry: ScanEntry): void {
    if (closed || deps.dryRun || entry.timer || entry.active) return
    const timer = { handle: undefined as unknown }
    entry.timer = timer
    timer.handle = clock.setTimeout(() => {
      if (closed || entries.get(entry.key) !== entry || entry.timer !== timer) return
      entry.timer = undefined
      // Very long Retry-After values are rearmed in bounded timer chunks,
      // never clamped to an earlier request or wrapped into a tight loop.
      if (clock.now() < entry.notBefore) { arm(entry); return }
      void run(entry).catch(() => {
        if (!closed && entries.get(entry.key) === entry) failed(entry, 'storage')
      })
    }, Math.min(MEMBERSHIP_TIMER_MAX_MS, Math.max(0, entry.notBefore - clock.now())))
  }
  function entryFor(key: string): ScanEntry {
    let entry = entries.get(key)
    if (!entry) {
      entry = { key, incarnation: deps.authority.incarnation(key), failures: 0, notBefore: clock.now(), status: blank() }
      entries.set(key, entry)
    }
    return entry
  }
  function evidenceProblem(key: string): MembershipScanProblem | undefined {
    const faults = new Set(deps.membership.generation(key)?.holds.values())
    if (!deps.authority.readable || faults.has('event-not-durable') || faults.has('shared-state-unreadable')) return 'storage'
    if (faults.has('history-unresolved')) return 'history-unresolved'
    if (faults.has('event-order-conflict')) return 'event-order-conflict'
    if (faults.has('eligibility-missing')) return 'eligibility-missing'
    if (faults.has('current-membership-missing')) return 'current-membership-missing'
    return deps.membership.unresolvedChannels(key).length ? 'event-order-conflict' : undefined
  }
  function request(key: string): void {
    if (closed || deps.dryRun) return
    const entry = entryFor(key)
    const generation = deps.membership.generation(key)
    // An observation invalidates an in-flight inventory before its callback
    // can publish anything. Do not wait for that request to return or expire.
    if (entry.active && entry.phase === 'inventory' && entry.observations !== undefined &&
        generation?.observations !== entry.observations) {
      entry.active.abort()
      entry.active = undefined
      entry.phase = undefined
      entry.observations = undefined
      entry.notBefore = Math.max(entry.notBefore, clock.now() + MEMBERSHIP_RETRY_MIN_MS)
    }
    const problem = evidenceProblem(key)
    if (problem || (generation && !generation.complete && (entry.status.state === 'complete' ||
        ['storage', 'history-unresolved', 'event-order-conflict', 'current-membership-missing'].includes(entry.status.problem ?? '')))) {
      entry.status = { ...entry.status, state: entry.active ? 'scanning' : 'incomplete',
        positives: generation?.positives.size ?? 0, problem: problem ?? 'current-membership-missing', slackError: undefined }
    }
    if (!entry.active) {
      entry.status.deadline = undefined
      entry.status.nextAttemptAt = Math.max(clock.now(), entry.notBefore)
    }
    arm(entry)
    publish(entry)
  }
  function failed(entry: ScanEntry, problem: MembershipScanProblem, retryAfterSeconds?: number, slackError?: string): void {
    entry.status = { ...entry.status, state: 'incomplete', problem, retryAfterSeconds, slackError }
    entry.notBefore = Math.max(entry.notBefore, clock.now() + membershipRetryDelay(entry.failures++, retryAfterSeconds))
    entry.status.nextAttemptAt = entry.notBefore
    publish(entry, true)
    arm(entry)
  }
  function assertCurrent(entry: ScanEntry, controller: AbortController, generation: MembershipGeneration, observations: number, deadline: number): void {
    if (!valid(entry, controller) || !deps.membership.isCurrent(generation) || generation.observations !== observations) throw new ScanFailure('superseded')
    if (clock.now() >= deadline) throw new MembershipDeadlineError()
    if (!deps.authority.readable) throw new ScanFailure('storage')
  }
  async function collect(entry: ScanEntry, controller: AbortController, generation: MembershipGeneration, deadline: number): Promise<void> {
    const { authority, membership } = deps
    membership.recover(entry.key)
    const observations = generation.observations
    entry.observations = observations
    const scanId = randomUUID()
    const through = (clock.now() / 1000).toFixed(3)
    const start = authority.snapshot()
    const observedRevision = start.revision
    const baseline = start.personas[entry.key]!
    const boundaries = new Map(Object.entries(baseline.membership).map(([channel, record]) => [channel, record.boundary]))
    const seen = new Set<string>()
    const seenMetadata = new Map<string, string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    let missingEligibility = false
    do {
      assertCurrent(entry, controller, generation, observations, deadline)
      const page = parsePage(await boundedMembershipCall(clock, controller.signal, deadline,
        signal => deps.connections.membershipPage(entry.key, generation.provenance.connectionId, cursor, signal)))
      assertCurrent(entry, controller, generation, observations, deadline)
      for (const channel of page.channels) {
        assertCurrent(entry, controller, generation, observations, deadline)
        const metadata = JSON.stringify([channel.channelType, channel.isExtSharedChannel])
        if (seen.has(channel.id)) {
          if (seenMetadata.get(channel.id) !== metadata) {
            generation.positives.delete(channel.id)
            generation.complete = false
            throw new ScanFailure('malformed-page')
          }
          continue
        }
        seen.add(channel.id)
        seenMetadata.set(channel.id, metadata)
        if (!channel.channelType || channel.isExtSharedChannel === undefined) {
          missingEligibility = true
          generation.positives.delete(channel.id)
          generation.absent.delete(channel.id)
          if (!generation.holds.has(channel.id)) generation.holds.set(channel.id, 'eligibility-missing')
          generation.complete = false
          continue
        }
        if (generation.holds.get(channel.id) === 'eligibility-missing') generation.holds.delete(channel.id)
        const recovering = membership.hasUnresolved(entry.key, channel.id)
        if (recovering && !membership.reconcileEvidence(generation, channel.id, through)) continue
        const current = authority.snapshot().personas[entry.key]!.membership[channel.id]
        if (recovering) boundaries.set(channel.id, current?.boundary ?? 0)
        if ((current?.boundary ?? 0) !== (boundaries.get(channel.id) ?? 0)) throw new ScanFailure('superseded')
        const result = authority.observeMembership(entry.key, generation.incarnation, {
          event: `scan:${scanId}:${channel.id}`, channel: channel.id, member: true, identity: generation.identityKey,
          boundary: current?.boundary ?? 0, observedThrough: through,
          channelType: channel.channelType, isExtSharedChannel: channel.isExtSharedChannel,
        }, authority.revision)
        if (result.kind !== 'applied') throw new ScanFailure('storage')
        const applied = authority.snapshot().personas[entry.key]!.membership[channel.id]!
        boundaries.set(channel.id, applied.boundary)
        generation.positives.set(channel.id, applied)
        generation.absent.delete(channel.id)
      }
      entry.status.pages++
      entry.status.positives = generation.positives.size
      cursor = page.cursor
      if (cursor && cursors.has(cursor)) throw new ScanFailure('malformed-page')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    assertCurrent(entry, controller, generation, observations, deadline)
    if (missingEligibility) throw new ScanFailure('eligibility-missing')
    // Stage negatives only after every page and eligibility field is valid.
    // History recovery, all absence effects and the complete cutoff share one
    // durable transaction; a late write failure cannot publish a partial leave.
    const absent = new Map<string, number>()
    for (const channel of new Set([...Object.keys(baseline.membership), ...membership.unresolvedChannels(entry.key)])) {
      if (!seen.has(channel)) absent.set(channel, boundaries.get(channel) ?? 0)
    }
    const result = membership.commitInventory(generation, { scanId, observedThrough: through, observedRevision, absent })
    if (result.kind !== 'applied') throw new ScanFailure(result.kind === 'failed' || !authority.readable ? 'storage' :
      result.kind === 'stale' ? 'superseded' : evidenceProblem(entry.key) ?? 'storage')
    assertCurrent(entry, controller, generation, observations, deadline)
    for (const channel of absent.keys()) {
      generation.positives.delete(channel)
      generation.absent.add(channel)
    }
    generation.complete = true
  }
  async function run(entry: ScanEntry): Promise<void> {
    const controller = new AbortController()
    entry.active = controller
    entry.phase = 'validation'
    const deadline = clock.now() + MEMBERSHIP_ATTEMPT_TIMEOUT_MS
    entry.status = { state: 'scanning', pages: 0, positives: 0, deadline }
    let problem: MembershipScanProblem | undefined
    let retryAfter: number | undefined
    let slackError: string | undefined
    try {
      const validated = await boundedMembershipCall(clock, controller.signal, deadline, signal => deps.connections.revalidateMembership(entry.key, signal), MEMBERSHIP_VALIDATION_TIMEOUT_MS)
      if (!valid(entry, controller)) return
      if (validated.kind !== 'ready') throw new ScanFailure('installation-unverified', validated.kind === 'failed' ? validated.outcome : undefined)
      const generation = deps.membership.activate(entry.key, validated.provenance)
      if (!generation) throw new ScanFailure('installation-unverified')
      entry.phase = 'inventory'
      await collect(entry, controller, generation, deadline)
      if (!valid(entry, controller)) return
      if (!deps.membership.isCurrent(generation) || !generation.complete) throw new ScanFailure('superseded')
      entry.status = { ...entry.status, state: 'complete', nextAttemptAt: undefined, problem: undefined }
      entry.failures = 0
      entry.notBefore = clock.now() + MEMBERSHIP_RETRY_MIN_MS
      publish(entry, true)
    } catch (error) {
      if (!valid(entry, controller)) return
      if (error instanceof MembershipDeadlineError) problem = 'deadline'
      else if (error instanceof MembershipCancelledError) problem = 'superseded'
      else if (error instanceof ScanFailure && !error.outcome) problem = error.problem
      else {
        const outcome = error instanceof ScanFailure ? error.outcome! : classifySlackValidationError(error, 'web-api')
        problem = errorProblem(outcome)
        retryAfter = outcome.kind === 'slack-unreachable' ? outcome.retryAfter ?? slackRetryAfterSeconds(error) : undefined
        slackError = outcome.slackError
      }
    } finally {
      if (entry.active === controller) { entry.active = undefined; entry.phase = undefined; entry.observations = undefined }
      controller.abort()
      if (!closed && entries.get(entry.key) === entry && problem) failed(entry, problem, retryAfter, slackError)
    }
  }
  function stop(key: string): void {
    const entry = entries.get(key)
    entries.delete(key)
    if (entry?.timer) clock.clearTimeout(entry.timer.handle)
    entry?.active?.abort()
    deps.membership.invalidate(key)
  }
  return {
    request, stop,
    connectionChanged(key, schedule = true, outcome) {
      if (closed || deps.dryRun) return
      deps.membership.invalidate(key)
      const entry = schedule ? entryFor(key) : entries.get(key)
      // A manager-owned validation publishes its successful socket swap
      // before returning it. Do not cancel that same validation from its hook.
      if (entry?.active && entry.phase !== 'validation') {
        entry.active.abort(); entry.active = undefined
        entry.notBefore = Math.max(entry.notBefore, clock.now() + MEMBERSHIP_RETRY_MIN_MS)
      }
      if (entry) {
        if (!schedule && entry.timer) { clock.clearTimeout(entry.timer.handle); entry.timer = undefined }
        entry.status = { ...blank(), nextAttemptAt: schedule ? Math.max(clock.now(), entry.notBefore) : undefined }
        if (outcome) {
          failed(entry, errorProblem(outcome), outcome.kind === 'slack-unreachable' ? outcome.retryAfter : undefined, outcome.slackError)
          return
        }
        publish(entry)
      }
      if (schedule) request(key)
    },
    close() { closed = true; unsubscribe(); for (const key of [...entries.keys()]) stop(key) },
    status: key => ({ ...(entries.get(key)?.status ?? blank()) }),
    ended: key => entries.get(key)?.ended ?? false,
  }
}
