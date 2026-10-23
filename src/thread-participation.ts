/** Permanent thread facts and observation protection. Persistence uses the
 * queue's injected, serialized fsync writer; construction performs no I/O. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { CHANNEL_ID_RE, DELIVERY_MODES, channelModeOf, type ChannelMode, type DeliveryMode, type Persona, type ServerSettings } from './config.ts'
import { PERSONA_KEY_RE } from './persona-identity.ts'
import { isThreadTimestamp, personaListsChannel, type StoredChoices } from './delivery-decision.ts'
import type { MembershipReading } from './channel-membership.ts'
import type { DeliveryQueue, QueueStoredResult, SlackKey } from './delivery-queue.ts'
import type { SharedChannelAuthority, SharedChannelLifetime, SharedLifetimeStatus } from './shared-channels.ts'

/** Surfaces that confirm an own post. `file` is reserved for upload completions. */
export const OWN_POST_SURFACES = ['text', 'prompt', 'warning', 'notice', 'file'] as const
export type OwnPostSurface = typeof OWN_POST_SURFACES[number]
/** Evidence a confirmed own post still needs before it can enroll. */
export const OWN_POST_MISSING = ['root', 'channel-eligibility'] as const
export type OwnPostMissing = typeof OWN_POST_MISSING[number]
/** Why no durable own-post evidence exists: no write could keep a copy. */
export const OWN_POST_GAP_CAUSES = ['storage', 'lifetime-unresolved', 'identity-unresolved', 'eligibility-unavailable', 'operation'] as const
export type OwnPostGapCause = typeof OWN_POST_GAP_CAUSES[number]
const OWN_POST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
/** The authenticated identity that issued a post, captured before its await. */
export interface OwnPostIssuer { botUserId?: string; botId?: string }
/** A confirmed own post's facts, bound when its success is first observed. */
export interface OwnPostEvidence {
  surface: OwnPostSurface
  operation: string
  part: number
  /** The returned message timestamp; absent when Slack returned none. */
  ts?: string
  /** The requested reply parent. */
  parent?: string
  /** A reply was requested under a parent that is not a valid root; never with `parent`. */
  parentUnresolved?: true
  /** A completed file's ID, without inventing its message root. */
  file?: string
  issuer: OwnPostIssuer
  missing: OwnPostMissing[]
  /** The eligibility fault that left this evidence pending. */
  reason?: string
}

export interface ThreadObservation {
  id: string
  lifetime: SharedChannelLifetime
  /** Absent only for evidence whose posted root is not yet known. */
  root?: string
  slackKey?: SlackKey
  observedAt: number
  /** `delivery` is absent only for own-post evidence whose choice is unresolved. */
  policy: { mode: ChannelMode; delivery?: DeliveryMode }
  /** Present only for a confirmed own post; never with `slackKey`. */
  post?: OwnPostEvidence
}
export interface ThreadParticipationRecord {
  v: 1
  kind: 'thread-participation'
  seq: 0
  observation: ThreadObservation
  state: 'observed' | 'enrolled' | 'cancelled'
  /** The acceptance that established incoming participation, never a new item. */
  acceptedSeq?: number
}
export interface ThreadParticipationGap { v: 1; kind: 'thread-gap'; seq: 0 }
export type ThreadParticipationReading = {
  key: string; channel: string; root: string
  kind: 'followed' | 'unfollowed' | 'unresolved'
  /** A storage gap is distinct from an ordinary in-flight observation. */
  failure?: 'storage'
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const optionalId = (v: unknown): boolean => v === undefined || (typeof v === 'string' && OWN_POST_ID_RE.test(v))
function isOwnPostEvidence(value: unknown, root: unknown): value is OwnPostEvidence {
  if (!object(value) || !OWN_POST_SURFACES.includes(value.surface as OwnPostSurface) || typeof value.operation !== 'string' ||
      !OWN_POST_ID_RE.test(value.operation) || !integer(value.part) || value.part < 1 || !object(value.issuer) ||
      !optionalId(value.issuer.botUserId) || !optionalId(value.issuer.botId) || !optionalId(value.file) || !optionalId(value.reason) ||
      !Array.isArray(value.missing) || !value.missing.every(m => OWN_POST_MISSING.includes(m as OwnPostMissing)) ||
      new Set(value.missing).size !== value.missing.length) return false
  if ((value.ts !== undefined && !isThreadTimestamp(value.ts)) || (value.parent !== undefined && !isThreadTimestamp(value.parent))) return false
  if (value.parentUnresolved !== undefined && (value.parentUnresolved !== true || value.parent !== undefined)) return false
  // A reply enrolls its requested parent and a root its own timestamp; later
  // root evidence may settle a post that returned neither, or a reply whose
  // requested parent was not a valid root.
  if (value.parent !== undefined ? root !== value.parent : !value.parentUnresolved && value.ts !== undefined && root !== value.ts) return false
  return (root === undefined) === value.missing.includes('root')
}
export function isThreadObservation(value: unknown): value is ThreadObservation {
  if (!object(value) || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id) ||
      !object(value.lifetime) || !object(value.policy) || !integer(value.observedAt)) return false
  const l = value.lifetime, p = value.policy, key = value.slackKey, post = value.post
  if (post !== undefined && (key !== undefined || !isOwnPostEvidence(post, value.root))) return false
  const delivery = p.delivery === undefined
    ? post !== undefined && (post as OwnPostEvidence).missing.includes('channel-eligibility')
    : DELIVERY_MODES.includes(p.delivery as DeliveryMode)
  return typeof l.key === 'string' && PERSONA_KEY_RE.test(l.key) && typeof l.channel === 'string' && CHANNEL_ID_RE.test(l.channel) &&
    typeof l.incarnation === 'string' && l.incarnation.length > 0 && integer(l.resetOrder) && integer(l.membershipBoundary) && integer(l.leaveBoundary) &&
    (l.createdAt === undefined || integer(l.createdAt)) && ['strict', 'open'].includes(String(p.mode)) && delivery &&
    (value.root === undefined || isThreadTimestamp(value.root)) &&
    (key === undefined || (p.delivery !== 'off' && object(key) && key.chat_id === l.channel && isThreadTimestamp(key.ts) &&
      (key.edited_ts === undefined || typeof key.edited_ts === 'string') && value.root !== undefined))
}
export function isThreadParticipationRecord(value: unknown): value is ThreadParticipationRecord {
  return object(value) && value.v === 1 && value.kind === 'thread-participation' && value.seq === 0 &&
    isThreadObservation(value.observation) && ['observed', 'enrolled', 'cancelled'].includes(String(value.state)) &&
    (value.acceptedSeq === undefined || (integer(value.acceptedSeq) && value.acceptedSeq > 0)) &&
    (value.state !== 'enrolled' || (value.observation.root !== undefined &&
      (value.observation.slackKey === undefined || value.acceptedSeq !== undefined) &&
      (value.observation.post === undefined || value.observation.post.missing.length === 0)))
}
export function parseThreadParticipationRecord(line: string): ThreadParticipationRecord | undefined {
  try { const value: unknown = JSON.parse(line); return isThreadParticipationRecord(value) ? value : undefined } catch { return undefined }
}
export function threadObservationId(lifetime: SharedChannelLifetime, key: SlackKey): string {
  return createHash('sha256').update(JSON.stringify([lifetime.key, lifetime.channel, lifetime.incarnation,
    lifetime.resetOrder, lifetime.createdAt ?? null, lifetime.membershipBoundary, lifetime.leaveBoundary, key.ts, key.edited_ts ?? null])).digest('hex')
}
/** One own post's identity within its lifetime: no Slack timestamp is needed. */
export function ownPostObservationId(lifetime: SharedChannelLifetime, operation: string, part: number): string {
  return createHash('sha256').update(JSON.stringify(['own-post', lifetime.key, lifetime.channel, lifetime.incarnation,
    lifetime.resetOrder, lifetime.createdAt ?? null, lifetime.membershipBoundary, lifetime.leaveBoundary, operation, part])).digest('hex')
}

// ---------------------------------------------------------------------------
// Confirmed own posts
// ---------------------------------------------------------------------------

/** Whether a confirmed own post may enroll, from current applied evidence. */
export type OwnPostEligibility =
  | { kind: 'eligible'; mode: ChannelMode; delivery: DeliveryMode }
  | { kind: 'ineligible'; mode: ChannelMode; reason: 'dm' | 'unlisted' | 'absent' | 'external-sharing' | 'invalid-channel' }
  | { kind: 'unresolved'; mode: ChannelMode; delivery?: DeliveryMode; reason: string }
export interface OwnPostEligibilityInputs {
  channel: string
  mode: ChannelMode
  /** The persona's configured channel entries name this channel; read in strict mode only. */
  listed: boolean
  /** The shared choice projection is trustworthy for this persona/channel. */
  choiceReadable: boolean
  choice: DeliveryMode | undefined
  membership: MembershipReading | undefined
}
/**
 * SR-1.4 for an own post. Strict inclusion is the applied shared choice;
 * open mode relies on membership's public/private and non-external evidence.
 * Posting success, a destination, a listed entry or an ID prefix alone proves
 * neither membership nor sharing. An off choice may enroll without intake.
 * Pure.
 */
export function decideOwnPostEligibility(inputs: OwnPostEligibilityInputs): OwnPostEligibility {
  const { channel, mode, choice, membership } = inputs
  if (!CHANNEL_ID_RE.test(channel)) return { kind: 'ineligible', mode, reason: channel.startsWith('D') ? 'dm' : 'invalid-channel' }
  if (!inputs.choiceReadable) return { kind: 'unresolved', mode, reason: 'state-unavailable' }
  if (choice === undefined) {
    return mode === 'strict' && !inputs.listed ? { kind: 'ineligible', mode, reason: 'unlisted' } : { kind: 'unresolved', mode, reason: 'choice-missing' }
  }
  if (!membership) return { kind: 'unresolved', mode, delivery: choice, reason: 'current-membership-missing' }
  if (membership.kind === 'ineligible') return { kind: 'ineligible', mode, reason: membership.reason }
  if (membership.kind === 'unresolved') return { kind: 'unresolved', mode, delivery: choice, reason: membership.reason }
  return { kind: 'eligible', mode, delivery: choice }
}

/** The current facts `ownPostEligibility` reads at each confirmation. */
export interface OwnPostEligibilitySources {
  config(): Pick<ServerSettings, 'channel_mode'> | null | undefined
  persona(key: string): Pick<Persona, 'channels'> | undefined
  choices(): Pick<StoredChoices, 'storedChoice'> & { readableFor(key: string, channel?: string): boolean } | undefined
  membership(key: string, channel: string, mode: ChannelMode): MembershipReading | undefined
}
/** The owner's `eligibility` over the applied config, stored choices and current membership. */
export function ownPostEligibility(sources: OwnPostEligibilitySources): (key: string, channel: string) => OwnPostEligibility {
  return (key, channel) => {
    const mode = channelModeOf(sources.config()), store = sources.choices()
    const readable = store !== undefined && store.readableFor(key, channel)
    return decideOwnPostEligibility({
      // Open mode reads no persona's channel entries.
      channel, mode, listed: mode === 'strict' && personaListsChannel(sources.persona(key), channel),
      choiceReadable: readable, choice: readable ? store.storedChoice(key, channel) : undefined,
      membership: sources.membership(key, channel, mode),
    })
  }
}

/** Captured before the post's await, so a replacement identity or lifetime is never rebound. */
export interface OwnPostIssue {
  key: string
  surface: OwnPostSurface
  operation: string
  incarnation?: string
  /** The persona's reset order, when the channel was known at issue. */
  resetOrder?: number
  /** The channel the post was issued for, when known before the post. */
  channel?: string
  /** That channel's whole lifetime at issue: a leave, rejoin or reset since supersedes the post. */
  lifetime?: SharedChannelLifetime
  issuer: OwnPostIssuer
}
/** What Slack's success response showed: the actual channel and returned timestamp. */
export interface OwnPostPosted {
  channel: string
  ts?: string
  parent?: string
  /** 1-based part within the operation; one when absent. */
  part?: number
}
/**
 * `enrolled`: durable participation. `pending`: durable evidence awaiting
 * root/eligibility. `gap`: no durable copy could be written. `ineligible`
 * and `superseded` enroll nothing and need nothing more.
 */
export type OwnPostOutcomeKind = 'enrolled' | 'pending' | 'gap' | 'ineligible' | 'superseded'
export interface OwnPostOutcome {
  kind: OwnPostOutcomeKind
  key: string
  surface: OwnPostSurface
  operation: string
  part: number
  channel: string
  ts?: string
  parent?: string
  root?: string
  /** A completed file's ID, when the post was a file completion. */
  file?: string
  /** The observation, when one was bound to a lifetime. */
  id?: string
  /** The channel's applied delivery choice, when the evidence recorded one. */
  delivery?: DeliveryMode
  missing: OwnPostMissing[]
  /** Eligibility fault (pending, ineligible) or gap cause. */
  reason?: string
  /** For a safe code only; never logged raw. */
  error?: unknown
  /** A settled duplicate (already enrolled or decided): it changes nothing, but lets reporting see the persona settle. */
  duplicate?: true
}
/** The posting adapters' view: never throws, never delays or fails the post. */
export interface OwnPostObserver {
  /** `channel` is the post's channel when known before the post, so a lifetime change during it is seen. */
  issue(key: string, surface: OwnPostSurface, channel?: string): OwnPostIssue | undefined
  /** Call synchronously at the success response, before any awaited bookkeeping. */
  confirm(issue: OwnPostIssue | undefined, posted: OwnPostPosted): void
}
/** The shared adapter over the current owner; a fault, sync or async, becomes an operation gap. */
export function createOwnPostObserver(owner: () => ThreadParticipation | undefined, report?: (outcome: OwnPostOutcome) => void): OwnPostObserver {
  return {
    issue(key, surface, channel) {
      try { return owner()?.issueOwnPost(key, surface, channel) } catch { return undefined }
    },
    confirm(issue, posted) {
      if (!issue) return
      const fault = (error: unknown) => {
        try {
          report?.({ kind: 'gap', key: issue.key, surface: issue.surface, operation: issue.operation, part: posted.part ?? 1,
            channel: posted.channel, ...(isThreadTimestamp(posted.ts) ? { ts: posted.ts } : {}),
            ...(isThreadTimestamp(posted.parent) ? { parent: posted.parent } : {}), missing: [], reason: 'operation', error })
        } catch { /* reporting cannot fail a successful post */ }
      }
      try { void Promise.resolve(owner()?.confirmOwnPost(issue, posted)).catch(fault) } catch (error) { fault(error) }
    },
  }
}

export type ThreadParticipationQueue = Pick<DeliveryQueue,
  'keys' | 'threadRecords' | 'threadRecord' | 'threadReadable' | 'recordThreadObservation' | 'cancelThreadObservation'>
export interface ThreadParticipationOptions {
  queue: ThreadParticipationQueue
  authority: Pick<SharedChannelAuthority, 'lifetime' | 'lifetimeStatus'> & Partial<Pick<SharedChannelAuthority, 'incarnation'>>
  now?: () => number
  /** Current synchronous own-post eligibility; absent leaves every own post a gap. */
  eligibility?(key: string, channel: string): OwnPostEligibility
  /** The persona's current authenticated identity. */
  identity?(key: string): OwnPostIssuer | undefined
  /** Each own-post outcome, for bounded reporting. Its throw is ignored. */
  onOwnPost?(outcome: OwnPostOutcome): void
  /** An own post settled a thread (or, rootless, its channel); re-evaluate held replies. */
  onSettled?(key: string, channel: string, root?: string): void
}
export interface ThreadParticipation {
  /** Called after queue replay and authority initialization, before admission. */
  start(): void
  lifetime(key: string, channel: string): SharedChannelLifetime | undefined
  lifetimeStatus(lifetime: SharedChannelLifetime): SharedLifetimeStatus
  /** Shared observation publication for later confirmed-post evidence. */
  observe(observation: ThreadObservation): SharedLifetimeStatus
  observeIncoming(key: string, slackKey: SlackKey, root: string, policy: ThreadObservation['policy']): ThreadObservation | undefined
  persist(observation: ThreadObservation): Promise<SharedLifetimeStatus>
  /** Authoritative discard only; never removes a concurrent durable acceptance. */
  discardIncoming(lifetime: SharedChannelLifetime, slackKey: SlackKey): Promise<QueueStoredResult | undefined>
  /** Reconcile the queue's atomic acceptance/enrollment fact. No text replay. */
  recover(key: string, id?: string): SharedLifetimeStatus
  read(key: string, channel: string, root: string): ThreadParticipationReading
  pending(key?: string): ThreadObservation[]
  /** Capture the issuing identity and lifetime (the channel's, when known) before the post's await. */
  issueOwnPost(key: string, surface: OwnPostSurface, channel?: string): OwnPostIssue
  /**
   * Bind a confirmed post. Dependent protection is published synchronously,
   * before the first await; the promise settles durable evidence and never
   * rejects. Callers never await it before registering their own success.
   */
  confirmOwnPost(issue: OwnPostIssue, posted: OwnPostPosted): Promise<OwnPostOutcome>
  /** Recovery: retry eligibility/enrollment of one pending own post. Never posts. */
  retryOwnPost(key: string, id: string): Promise<OwnPostOutcome | undefined>
  /** Unresolved own-post obligations, for startup reporting and recovery. */
  ownPostFindings(key?: string): OwnPostOutcome[]
  stop(): void
}
export function createThreadParticipation(options: ThreadParticipationOptions): ThreadParticipation {
  const records = new Map<string, Map<string, ThreadParticipationRecord>>()
  // Reads and individual enrollments do not scan or rewrite the followed
  // population. Full enumeration is reserved for startup/recovery/compaction.
  const roots = new Map<string, Map<string, { followed: Set<string>; pending: Set<string> }>>()
  const unknown = new Map<string, Set<string>>()
  const initialized = new Set<string>()
  let started = false, stopped = false
  const scope = (l: SharedChannelLifetime) => JSON.stringify([l.key, l.channel, l.incarnation, l.resetOrder, l.createdAt ?? null, l.membershipBoundary, l.leaveBoundary])
  function install(key: string, record: ThreadParticipationRecord): void {
    let own = records.get(key)
    if (!own) { own = new Map(); records.set(key, own) }
    const previous = own.get(record.observation.id)
    if (previous?.state === 'enrolled' || previous?.state === 'cancelled' && record.state === 'observed') return
    if (previous) {
      const old = previous.observation, token = scope(old.lifetime)
      if (old.root) {
        const index = roots.get(token)?.get(old.root)
        index?.followed.delete(old.id); index?.pending.delete(old.id)
      } else unknown.get(token)?.delete(old.id)
    }
    own.set(record.observation.id, structuredClone(record))
    const observation = record.observation, channel = scope(observation.lifetime)
    if (observation.root) {
      let byRoot = roots.get(channel)
      if (!byRoot) { byRoot = new Map(); roots.set(channel, byRoot) }
      let index = byRoot.get(observation.root)
      if (!index) { index = { followed: new Set(), pending: new Set() }; byRoot.set(observation.root, index) }
      if (record.state === 'enrolled') index.followed.add(observation.id)
      if (record.state === 'observed') index.pending.add(observation.id)
    } else if (record.state === 'observed') {
      let ids = unknown.get(channel)
      if (!ids) { ids = new Set(); unknown.set(channel, ids) }
      ids.add(observation.id)
    }
  }
  function status(lifetime: SharedChannelLifetime): SharedLifetimeStatus {
    if (!started || stopped) return 'unresolved'
    return options.authority.lifetimeStatus(lifetime)
  }
  /** For failure paths, which must not throw: an unreadable status is not superseded. */
  function supersededNow(lifetime: SharedChannelLifetime): boolean {
    try { return status(lifetime) === 'superseded' } catch { return false }
  }
  function restore(key: string): void {
    for (const record of options.queue.threadRecords(key)) install(key, record)
    initialized.add(key)
  }
  const now = () => (options.now ?? Date.now)()
  function report(outcome: OwnPostOutcome): OwnPostOutcome {
    try { options.onOwnPost?.(outcome) } catch { /* reporting cannot change participation */ }
    return outcome
  }
  function settled(key: string, channel: string, root?: string): void {
    try { options.onSettled?.(key, channel, root) } catch { /* Slack redelivery still re-evaluates */ }
  }
  /** Durably followed only: an in-flight enrollment write may still fail. */
  function followed(lifetime: SharedChannelLifetime, root: string): boolean {
    return (roots.get(scope(lifetime))?.get(root)?.followed.size ?? 0) > 0
  }
  /** In-flight own-post enrollment writes by lifetime scope and root; later posts there wait on them. */
  const enrolling = new Map<string, Promise<OwnPostOutcome>>()
  const enrollingKey = (lifetime: SharedChannelLifetime, root: string) => JSON.stringify([scope(lifetime), root])
  function durableCopy(key: string, id: string): boolean {
    try { return options.queue.threadRecord(key, id) !== undefined } catch { return false }
  }
  function outcomeOf(kind: OwnPostOutcomeKind, observation: ThreadObservation, extra: Partial<OwnPostOutcome> = {}): OwnPostOutcome {
    const post = observation.post!
    return {
      kind, key: observation.lifetime.key, surface: post.surface, operation: post.operation, part: post.part,
      channel: observation.lifetime.channel, ...(post.ts ? { ts: post.ts } : {}), ...(post.parent ? { parent: post.parent } : {}),
      ...(observation.root ? { root: observation.root } : {}), ...(post.file ? { file: post.file } : {}), id: observation.id,
      ...(observation.policy.delivery ? { delivery: observation.policy.delivery } : {}), missing: [...post.missing],
      ...(post.reason ? { reason: post.reason } : {}), ...extra,
    }
  }
  /** Own-post writes use the queue's serialized fsync writer, like incoming observations. */
  async function saveOwnPost(observation: ThreadObservation, state: 'observed' | 'enrolled'): Promise<OwnPostOutcome> {
    const key = observation.lifetime.key
    try { await options.queue.recordThreadObservation(key, observation, state) } catch (error) {
      // A lifetime superseded during the write owes nothing, whether or not it saved.
      if (supersededNow(observation.lifetime)) return report(outcomeOf('superseded', observation))
      // The in-memory observation keeps protecting dependents for recovery. A
      // failed enrollment of already durable evidence leaves that evidence pending.
      const kept = durableCopy(key, observation.id) ? records.get(key)?.get(observation.id)?.observation : undefined
      return report(kept?.post ? outcomeOf('pending', kept, { error }) : outcomeOf('gap', observation, { reason: 'storage', error }))
    }
    try {
      if (status(observation.lifetime) === 'superseded') return report(outcomeOf('superseded', observation))
      if (state === 'observed') return report(outcomeOf('pending', observation))
      install(key, { v: 1, kind: 'thread-participation', seq: 0, state: 'enrolled', observation })
      settled(key, observation.lifetime.channel, observation.root)
      return report(outcomeOf('enrolled', observation))
    } catch (error) {
      return report(outcomeOf(durableCopy(key, observation.id) ? 'pending' : 'gap', observation, { reason: 'operation', error }))
    }
  }
  const api: ThreadParticipation = {
    start() {
      for (const key of options.queue.keys()) {
        try { restore(key) } catch { /* this persona stays unresolved; other journals remain usable */ }
      }
      started = true
    },
    lifetime: (key, channel) => options.authority.lifetime(key, channel),
    lifetimeStatus: status,
    observe(observation) {
      if (!isThreadObservation(observation)) return 'unresolved'
      const current = status(observation.lifetime)
      if (current === 'current') install(observation.lifetime.key, { v: 1, kind: 'thread-participation', seq: 0, state: 'observed', observation })
      return current
    },
    observeIncoming(key, slackKey, root, policy) {
      const lifetime = options.authority.lifetime(key, slackKey.chat_id)
      if (!lifetime || status(lifetime) !== 'current') return undefined
      const id = threadObservationId(lifetime, slackKey)
      const existing = records.get(key)?.get(id)
      if (existing) return structuredClone(existing.observation)
      const observation: ThreadObservation = { id, lifetime: structuredClone(lifetime), slackKey: structuredClone(slackKey), root,
        observedAt: (options.now ?? Date.now)(), policy: { ...policy } }
      if (!isThreadObservation(observation)) return undefined
      // This publication is synchronous, before either persistence or callers' awaits.
      api.observe(observation)
      return structuredClone(observation)
    },
    async persist(observation) {
      const before = status(observation.lifetime)
      if (before !== 'current') return before
      await options.queue.recordThreadObservation(observation.lifetime.key, observation)
      return status(observation.lifetime)
    },
    async discardIncoming(lifetime, slackKey) {
      const current = status(lifetime)
      if (current === 'superseded') return
      if (current !== 'current') throw new Error('Thread lifetime is unresolved')
      const key = lifetime.key, id = threadObservationId(lifetime, slackKey)
      const record = options.queue.threadRecord(key, id) ?? records.get(key)?.get(id)
      if (!record) return
      const accepted = await options.queue.cancelThreadObservation(key, record.observation)
      const saved = options.queue.threadRecord(key, id)
      if (saved) install(key, saved)
      return accepted
    },
    recover(key, id) {
      if (!initialized.has(key)) restore(key)
      const saved = id ? [options.queue.threadRecord(key, id)].filter((r): r is ThreadParticipationRecord => r !== undefined) : options.queue.threadRecords(key)
      for (const record of saved) install(key, record)
      if (id) {
        const record = records.get(key)?.get(id)
        if (!record) return 'unresolved'
        const current = status(record.observation.lifetime)
        return current !== 'current' ? current : record.state === 'enrolled' ? 'current' : 'unresolved'
      }
      return options.queue.threadReadable(key) ? 'current' : 'unresolved'
    },
    read(key, channel, root) {
      const answer = (kind: ThreadParticipationReading['kind'], failure?: 'storage'): ThreadParticipationReading => ({ key, channel, root, kind, ...(failure ? { failure } : {}) })
      const lifetime = options.authority.lifetime(key, channel)
      if (!lifetime || status(lifetime) !== 'current' || !isThreadTimestamp(root)) return answer('unresolved')
      if (!initialized.has(key)) {
        try { restore(key) } catch { return answer('unresolved', 'storage') }
      }
      const token = scope(lifetime), matching = roots.get(token)?.get(root)
      if (matching?.followed.size) return answer('followed')
      if (!options.queue.threadReadable(key)) return answer('unresolved', 'storage')
      if (matching?.pending.size || unknown.get(token)?.size) return answer('unresolved')
      return answer('unfollowed')
    },
    pending(key) {
      return [...records].filter(([k]) => key === undefined || key === k).flatMap(([, own]) => [...own.values()])
        .filter(r => r.state === 'observed' && status(r.observation.lifetime) !== 'superseded').map(r => structuredClone(r.observation))
    },
    issueOwnPost(key, surface, channel) {
      const identity = options.identity?.(key)
      const lifetime = channel !== undefined ? options.authority.lifetime(key, channel) : undefined
      return { key, surface, operation: randomUUID(), incarnation: lifetime?.incarnation ?? options.authority.incarnation?.(key),
        ...(lifetime ? { resetOrder: lifetime.resetOrder, channel, lifetime: structuredClone(lifetime) } : {}),
        issuer: identity ? { botUserId: identity.botUserId, botId: identity.botId } : {} }
    },
    confirmOwnPost(issue, posted) {
      const part = posted.part ?? 1
      const ts = isThreadTimestamp(posted.ts) ? posted.ts : undefined
      const parent = isThreadTimestamp(posted.parent) ? posted.parent : undefined
      // A malformed requested parent names no root, and the reply's own ts is not one.
      const parentUnresolved = posted.parent !== undefined && parent === undefined
      const root = posted.parent !== undefined ? parent : ts
      const base = { key: issue.key, surface: issue.surface, operation: issue.operation, part, channel: posted.channel,
        ...(ts ? { ts } : {}), ...(parent ? { parent } : {}), ...(root ? { root } : {}) }
      const done = (outcome: OwnPostOutcome, reported = true) => Promise.resolve(reported ? report(outcome) : outcome)
      try {
        if (!CHANNEL_ID_RE.test(posted.channel)) {
          return done({ ...base, kind: 'ineligible', missing: [], reason: posted.channel.startsWith('D') ? 'dm' : 'invalid-channel' })
        }
        // The issuer's persona life ended during the post (removed or replaced): nothing is owed to it.
        if (issue.incarnation !== undefined && options.authority.incarnation && options.authority.incarnation(issue.key) !== issue.incarnation) {
          return done({ ...base, kind: 'superseded', missing: [] })
        }
        const lifetime = options.authority.lifetime(issue.key, posted.channel)
        if (!lifetime || !started || stopped) return done({ ...base, kind: 'gap', missing: [], reason: 'lifetime-unresolved' })
        // An issuer captured before the identity was known proves no persona; never bind a later one.
        if (options.identity && !issue.issuer.botUserId && !issue.issuer.botId) {
          return done({ ...base, kind: 'gap', missing: [], reason: 'identity-unresolved' })
        }
        const identity = options.identity?.(issue.key)
        if ((issue.incarnation !== undefined && lifetime.incarnation !== issue.incarnation) ||
            (issue.resetOrder !== undefined && lifetime.resetOrder !== issue.resetOrder) ||
            (issue.lifetime && issue.channel === posted.channel && !isDeepStrictEqual(issue.lifetime, lifetime)) ||
            (identity && (identity.botUserId !== issue.issuer.botUserId || identity.botId !== issue.issuer.botId))) {
          return done({ ...base, kind: 'superseded', missing: [] })
        }
        const current = status(lifetime)
        if (current === 'superseded') return done({ ...base, kind: 'superseded', missing: [] })
        if (current === 'unresolved') return done({ ...base, kind: 'gap', missing: [], reason: 'lifetime-unresolved' })
        const id = ownPostObservationId(lifetime, issue.operation, part)
        const existing = records.get(issue.key)?.get(id)
        // Settled duplicates are reported marked, so reporting can end an
        // episode an id-less gap left open; a pending one is already reported.
        if (existing?.observation.post) {
          if (existing.state === 'observed') return done(outcomeOf('pending', existing.observation), false)
          return done(outcomeOf(existing.state === 'enrolled' ? 'enrolled' : 'ineligible', existing.observation, { duplicate: true }))
        }
        // A durably followed thread stays followed: duplicate confirmations and
        // later chunks of a reply add nothing, whatever eligibility reads now.
        if (root !== undefined && followed(lifetime, root)) return done({ ...base, kind: 'enrolled', missing: [], duplicate: true })
        // The thread stays protected by the in-flight evidence meanwhile; only
        // its durable enrollment makes this post a duplicate.
        const inFlight = root !== undefined ? enrolling.get(enrollingKey(lifetime, root)) : undefined
        if (inFlight) {
          const again = () => api.confirmOwnPost(issue, posted)
          return inFlight.then(first => first.kind === 'enrolled' ? done({ ...base, kind: 'enrolled', missing: [], duplicate: true }) : again(), again)
        }
        const eligibility = options.eligibility?.(issue.key, posted.channel)
        if (!eligibility) return done({ ...base, kind: 'gap', missing: [], reason: 'eligibility-unavailable' })
        if (eligibility.kind === 'ineligible') return done({ ...base, kind: 'ineligible', missing: [], reason: eligibility.reason })
        const missing: OwnPostMissing[] = [...(root === undefined ? ['root' as const] : []),
          ...(eligibility.kind === 'unresolved' ? ['channel-eligibility' as const] : [])]
        const reason = eligibility.kind === 'unresolved' && OWN_POST_ID_RE.test(eligibility.reason) ? eligibility.reason : undefined
        const observation: ThreadObservation = {
          id, lifetime: structuredClone(lifetime), ...(root ? { root } : {}), observedAt: now(),
          policy: { mode: eligibility.mode, ...(eligibility.delivery ? { delivery: eligibility.delivery } : {}) },
          post: { surface: issue.surface, operation: issue.operation, part, ...(ts ? { ts } : {}), ...(parent ? { parent } : {}),
            ...(parentUnresolved ? { parentUnresolved: true as const } : {}), issuer: { ...issue.issuer }, missing, ...(reason ? { reason } : {}) },
        }
        if (!isThreadObservation(observation)) return done({ ...base, kind: 'gap', missing, reason: 'operation' })
        // Dependent selection sees this evidence before the first await.
        api.observe(observation)
        if (missing.length) return saveOwnPost(observation, 'observed')
        const saving = saveOwnPost(observation, 'enrolled'), at = enrollingKey(lifetime, root!)
        enrolling.set(at, saving)
        const clear = () => { if (enrolling.get(at) === saving) enrolling.delete(at) }
        void saving.then(clear, clear)
        return saving
      } catch (error) {
        return done({ ...base, kind: 'gap', missing: [], reason: 'operation', error })
      }
    },
    async retryOwnPost(key, id) {
      const record = records.get(key)?.get(id), observation = record?.observation
      if (!record || record.state !== 'observed' || !observation?.post) return undefined
      const current = status(observation.lifetime), durable = durableCopy(key, id)
      if (current === 'superseded') return report(outcomeOf('superseded', observation))
      if (current !== 'current') return outcomeOf(durable ? 'pending' : 'gap', observation, durable ? {} : { reason: 'lifetime-unresolved' })
      let eligibility: OwnPostEligibility | undefined
      try { eligibility = observation.root ? options.eligibility?.(key, observation.lifetime.channel) : undefined } catch { /* stays unresolved */ }
      if (!eligibility || eligibility.kind === 'unresolved') return durable ? outcomeOf('pending', observation) : saveOwnPost(observation, 'observed')
      if (eligibility.kind === 'ineligible') {
        try { await options.queue.cancelThreadObservation(key, observation) } catch (error) {
          if (supersededNow(observation.lifetime)) return report(outcomeOf('superseded', observation))
          return report(outcomeOf(durable ? 'pending' : 'gap', observation, { reason: 'storage', error }))
        }
        install(key, { v: 1, kind: 'thread-participation', seq: 0, state: 'cancelled', observation })
        settled(key, observation.lifetime.channel, observation.root)
        return report(outcomeOf('ineligible', observation, { missing: [], reason: eligibility.reason }))
      }
      const { reason: _reason, ...post } = observation.post
      return saveOwnPost({ ...observation, policy: { mode: eligibility.mode, delivery: eligibility.delivery }, post: { ...post, missing: [] } }, 'enrolled')
    },
    ownPostFindings(key) {
      return [...records].filter(([k]) => key === undefined || key === k).flatMap(([k, own]) => [...own.values()]
        .filter(r => r.state === 'observed' && r.observation.post && status(r.observation.lifetime) !== 'superseded')
        .map(r => durableCopy(k, r.observation.id) ? outcomeOf('pending', r.observation) : outcomeOf('gap', r.observation, { reason: 'storage' })))
    },
    stop() { stopped = true },
  }
  return api
}
