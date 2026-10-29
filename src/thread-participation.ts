/** Permanent thread facts and observation protection. Persistence uses the
 * queue's injected, serialized fsync writer; construction performs no I/O. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { CHANNEL_ID_RE, DELIVERY_MODES, channelModeOf, type ChannelMode, type DeliveryMode } from './config.ts'
import { PERSONA_KEY_RE } from './persona-identity.ts'
import { isThreadTimestamp } from './delivery-decision.ts'
import type { DeliveryQueue, QueueStoredResult, SlackKey } from './delivery-queue.ts'
import type { SharedChannelAuthority, SharedChannelLifetime, SharedLifetimeStatus } from './shared-channels.ts'
import { OWN_ROOT_CLOCK_SKEW_MS } from './delivery-constants.ts'
import {
  OWN_POST_SURFACES,
  type OwnPostEligibility, type OwnPostEligibilitySources, type OwnPostIssue, type OwnPostIssuer, type OwnPostPosted, type OwnPostSurface,
} from './own-post.ts'

/** Evidence a confirmed own post still needs before it can enroll. */
export const OWN_POST_MISSING = ['root', 'channel-eligibility'] as const
export type OwnPostMissing = typeof OWN_POST_MISSING[number]
/** Why no durable own-post evidence exists: no write could keep a copy. */
export const OWN_POST_GAP_CAUSES = ['storage', 'lifetime-unresolved', 'identity-unresolved', 'eligibility-unavailable', 'operation'] as const
export type OwnPostGapCause = typeof OWN_POST_GAP_CAUSES[number]
const OWN_POST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
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
  /** Epoch milliseconds when the post was issued, before its await; bounds which root it can have created. */
  issuedAt?: number
  issuer: OwnPostIssuer
  missing: OwnPostMissing[]
  /** The eligibility fault that left this evidence pending. */
  reason?: string
}
/**
 * One thread's root-author lookup (`participation-root-evidence.ts`):
 * `observed` while it is requested, `enrolled` once the root is an own root
 * a confirmed post of this lifetime created, `cancelled` once the lookup
 * settled the thread as not followed here: another author, or
 * (`reason: 'outside-lifetime'`) an own root no confirmed post of this
 * lifetime created.
 */
export interface RootLookupEvidence {
  /** The receiving identity the root's author must match, captured at request. */
  issuer: OwnPostIssuer
  requestedAt: number
  /** Only on a cancelled lookup of an own root from outside this lifetime; never a not-own fact. */
  reason?: 'outside-lifetime'
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
  /** Present only for a root-author lookup; never with `slackKey` or `post`. */
  lookup?: RootLookupEvidence
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
      (value.issuedAt !== undefined && !integer(value.issuedAt)) ||
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
  const l = value.lifetime, p = value.policy, key = value.slackKey, post = value.post, lookup = value.lookup
  if (post !== undefined && (key !== undefined || !isOwnPostEvidence(post, value.root))) return false
  if (lookup !== undefined && (key !== undefined || post !== undefined || value.root === undefined || !object(lookup) ||
      !object(lookup.issuer) || !optionalId(lookup.issuer.botUserId) || !optionalId(lookup.issuer.botId) ||
      (!lookup.issuer.botUserId && !lookup.issuer.botId) || !integer(lookup.requestedAt) || p.delivery === undefined ||
      (lookup.reason !== undefined && lookup.reason !== 'outside-lifetime'))) return false
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
/** One thread's root-author lookup within its lifetime; repeated requests share it. */
export function rootLookupObservationId(lifetime: SharedChannelLifetime, root: string): string {
  return createHash('sha256').update(JSON.stringify(['root-lookup', lifetime.key, lifetime.channel, lifetime.incarnation,
    lifetime.resetOrder, lifetime.createdAt ?? null, lifetime.membershipBoundary, lifetime.leaveBoundary, root])).digest('hex')
}
/** The observation a cancellation settles: a cancelled lookup's decided reason is not part of what was observed. Pure. */
export function cancelledObservationBase(observation: ThreadObservation): ThreadObservation {
  if (observation.lookup?.reason === undefined) return observation
  const { reason: _reason, ...lookup } = observation.lookup
  return { ...observation, lookup }
}
/** An identity a root lookup can be requested for: a valid bot user ID or bot ID. Pure. */
export function isRootLookupIssuer(issuer: OwnPostIssuer): boolean {
  return optionalId(issuer.botUserId) && optionalId(issuer.botId) && !!(issuer.botUserId || issuer.botId)
}
/** A root-level own post whose root is still unknown: only such a post can have created a looked-up root. */
function rootless(post: OwnPostEvidence): boolean {
  return post.parent === undefined && !post.parentUnresolved && post.ts === undefined
}
/** A valid Slack timestamp in epoch milliseconds. */
function tsMillis(ts: string): number {
  const [seconds, micros] = ts.split('.') as [string, string]
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000)
}

// ---------------------------------------------------------------------------
// Confirmed own posts
// ---------------------------------------------------------------------------

/** The applied mode and readable stored choice a root lookup is requested under, read at each call. */
export function ownPostLookupPolicy(sources: Pick<OwnPostEligibilitySources, 'config' | 'choices'>): (key: string, channel: string) => { mode: ChannelMode; delivery: DeliveryMode } | undefined {
  return (key, channel) => {
    const store = sources.choices()
    if (store === undefined || !store.readableFor(key, channel)) return undefined
    const delivery = store.storedChoice(key, channel)
    return delivery === undefined ? undefined : { mode: channelModeOf(sources.config()), delivery }
  }
}

/** A channel's authenticated type and external sharing (`participation-channel-evidence.ts`). */
export interface OwnPostChannelEvidence { channel: string; channelType: 'public' | 'private'; externallyShared: boolean }
/** Open mode's membership reason when only the channel's type or sharing is unknown. */
export const ELIGIBILITY_MISSING = 'eligibility-missing'
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
/** The operation gap an own-post observer fault (`createOwnPostObserver`'s `onFault`) reports. Pure. */
export function ownPostFaultOutcome(issue: OwnPostIssue, posted: OwnPostPosted, error: unknown): OwnPostOutcome {
  return { kind: 'gap', key: issue.key, surface: issue.surface, operation: issue.operation, part: posted.part ?? 1,
    channel: posted.channel, ...(isThreadTimestamp(posted.ts) ? { ts: posted.ts } : {}),
    ...(isThreadTimestamp(posted.parent) ? { parent: posted.parent } : {}), missing: [], reason: 'operation', error }
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
  /**
   * Recovery: retry eligibility/enrollment of one pending own post. Never
   * posts. `evidence` is authenticated `conversations.info` evidence for the
   * post's channel, revalidated by the caller after its await; it settles only
   * open mode's missing channel type and sharing (`eligibility-missing`).
   */
  retryOwnPost(key: string, id: string, evidence?: OwnPostChannelEvidence): Promise<OwnPostOutcome | undefined>
  /**
   * Recovery: settle a pending own post's missing root from correlated share
   * metadata (`participation-file-evidence.ts`), then retry its enrollment.
   * Never posts.
   */
  resolveOwnPostRoot(key: string, id: string, root: string): Promise<OwnPostOutcome | undefined>
  /**
   * Unresolved own-post obligations, for startup reporting and recovery. A
   * post whose write is still in flight is not listed: its write settles it.
   */
  ownPostFindings(key?: string): OwnPostOutcome[]
  /** Whether own post `id` is still an obligation `ownPostFindings` lists; reads that one record. */
  ownPostOpen(key: string, id: string): boolean
  /**
   * Whether an undecidable reply in `root` needs its root author looked up:
   * only root-level own posts of the current lifetime whose roots are still
   * unknown can have created that root, so with none (a reply post under an
   * unresolved parent is not one), or once a lookup settled the root, no
   * lookup is needed.
   */
  rootLookupNeeded(key: string, channel: string, root: string): boolean
  /**
   * Durably record a thread's lookup obligation, so a restart continues it.
   * An open lookup requested for another identity of the same lifetime is
   * recorded again for `issuer`, keeping its policy. Undefined when the
   * lifetime is not current, the lookup was already settled, the request is
   * invalid (an issuer `isRootLookupIssuer` rejects; callers check it first)
   * or the write failed.
   */
  requestRootLookup(key: string, channel: string, root: string, issuer: OwnPostIssuer, policy: { mode: ChannelMode; delivery: DeliveryMode }): Promise<ThreadObservation | undefined>
  /**
   * Recorded lookup obligations still open, for recovery; not those an
   * ineligible channel set aside until a new request, nor those whose thread
   * is already durably followed (they need no request).
   */
  rootLookups(key: string): ThreadObservation[]
  /** Whether lookup `id` is still open in a current lifetime; reads that one record. */
  rootLookupOpen(key: string, id: string): boolean
  /** Apply a lookup's verdict (`participation-root-evidence.ts`) after the caller revalidated its binding. */
  resolveRootLookup(key: string, id: string, verdict: RootLookupVerdict, evidence?: OwnPostChannelEvidence): Promise<RootLookupOutcome>
  stop(): void
}
/**
 * What one root lookup showed: the root's own author matched the request's
 * identity (with the file IDs that root message itself shares), or it did not.
 */
export type RootLookupVerdict = { kind: 'own'; root: string; files?: string[] } | { kind: 'not-own' }
/**
 * `enrolled`: the thread is followed. `not-own`: another author started it.
 * `outside-lifetime`: an own root no confirmed post of this lifetime created
 * (from before an upgrade, a reset or a verified leave); the thread is not
 * followed from it. `followed`: the thread was already durably followed, so
 * the lookup is dropped unchanged. `ineligible`: a root of this lifetime
 * whose channel cannot enroll now; nothing is written and the lookup stays
 * observed, but until the channel is eligible the thread reads unfollowed,
 * the lookup is not listed for recovery, and a reply once it is eligible
 * requests it again (a restart looks it up again). Nothing is decided or
 * written for: `deferred` (pending own-post evidence for that root settles
 * it), `unmatched` (only a root-level text post Slack returned no timestamp
 * for could have created it, and the root is outside that post's window)
 * and `pending` (channel eligibility is unresolved, for `reason` in `mode`).
 * `storage`: the write failed. `superseded` and `unresolved`: the lifetime is
 * no longer, or not yet, current. `absent`: no open lookup has that id.
 */
export type RootLookupOutcome = {
  kind: 'enrolled' | 'not-own' | 'outside-lifetime' | 'followed' | 'deferred' | 'unmatched' | 'ineligible' | 'pending' | 'storage' | 'superseded' | 'unresolved' | 'absent'
  error?: unknown
  /** `pending` only: the unresolved eligibility reason; open mode's `ELIGIBILITY_MISSING` alone can be settled by channel evidence. */
  reason?: string
  mode?: ChannelMode
}
export function createThreadParticipation(options: ThreadParticipationOptions): ThreadParticipation {
  const records = new Map<string, Map<string, ThreadParticipationRecord>>()
  // Reads and individual enrollments do not scan or rewrite the followed
  // population. Full enumeration is reserved for startup/recovery/compaction.
  const roots = new Map<string, Map<string, { followed: Set<string>; pending: Set<string> }>>()
  const unknown = new Map<string, Set<string>>()
  /** Roots a lookup settled as not followed in that lifetime: another author's, or an own root from outside it. */
  const decided = new Map<string, Set<string>>()
  /**
   * Own roots of a lifetime whose lookup met a channel that could not enroll.
   * In memory only: the lookup stays observed, so a restart looks it up again.
   */
  const ineligibleRoots = new Map<string, Set<string>>()
  /** Own posts whose save is in flight; their write, not recovery, settles them. */
  const saving = new Set<string>()
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
    if (record.state === 'cancelled' && observation.lookup && observation.root) {
      let known = decided.get(channel)
      if (!known) { known = new Set(); decided.set(channel, known) }
      known.add(observation.root)
    }
  }
  /** Forget an in-memory record that a durable fact made redundant. */
  function drop(key: string, id: string): void {
    const record = records.get(key)?.get(id)
    if (!record) return
    const old = record.observation, token = scope(old.lifetime)
    if (old.root) {
      const index = roots.get(token)?.get(old.root)
      index?.followed.delete(id); index?.pending.delete(id)
    } else unknown.get(token)?.delete(id)
    records.get(key)!.delete(id)
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
    const key = observation.lifetime.key, id = observation.id
    saving.add(id)
    try { await options.queue.recordThreadObservation(key, observation, state) } catch (error) {
      saving.delete(id)
      // A lifetime superseded during the write owes nothing, whether or not it saved.
      if (supersededNow(observation.lifetime)) return report(outcomeOf('superseded', observation))
      // The in-memory observation keeps protecting dependents for recovery. A
      // failed write over already durable evidence leaves that evidence
      // pending, and the failure is a storage fault, whatever it still lacks.
      const kept = durableCopy(key, id) ? records.get(key)?.get(id)?.observation : undefined
      return report(kept?.post ? outcomeOf('pending', kept, { reason: 'storage', error }) : outcomeOf('gap', observation, { reason: 'storage', error }))
    }
    saving.delete(id)
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
  /**
   * Current own-post eligibility. Open mode's missing channel type and
   * sharing alone may be settled by authenticated `conversations.info`
   * evidence for exactly this channel, revalidated by the caller.
   */
  function currentEligibility(key: string, channel: string, evidence?: OwnPostChannelEvidence): OwnPostEligibility | undefined {
    let eligibility: OwnPostEligibility | undefined
    try { eligibility = options.eligibility?.(key, channel) } catch { return undefined }
    if (eligibility?.kind === 'unresolved' && eligibility.mode === 'open' && eligibility.reason === ELIGIBILITY_MISSING &&
        eligibility.delivery !== undefined && evidence?.channel === channel) {
      return evidence.externallyShared
        ? { kind: 'ineligible', mode: 'open', reason: 'external-sharing' }
        : { kind: 'eligible', mode: 'open', delivery: eligibility.delivery }
    }
    return eligibility
  }
  /**
   * Whether `root`'s lookup met an ineligible channel that still reads
   * ineligible: the thread is not followed now. An unresolved reading
   * decides nothing either way.
   */
  function heldIneligible(key: string, lifetime: SharedChannelLifetime, root: string): boolean {
    if (!ineligibleRoots.get(scope(lifetime))?.has(root)) return false
    return currentEligibility(key, lifetime.channel)?.kind === 'ineligible'
  }
  /**
   * Which confirmed own post of this lifetime created the own root `root`,
   * among root-level own posts by the same identity whose roots are still
   * unknown. A parentless upload matches exactly when the root message
   * shares its file (`file`, naming the post); no clock is read. Only a
   * root-level text post Slack returned no timestamp for falls back to its
   * issue-to-confirmation window, within the clock-skew allowance and never
   * before the lifetime's start (`window`, or `window-missed` outside it).
   * `none`: no post of this lifetime can have created it, so the root is
   * from before an upgrade, a reset or a verified leave.
   */
  function matchOwnRoot(lifetime: SharedChannelLifetime, root: string, issuer: OwnPostIssuer, files: readonly string[]):
    { kind: 'file'; id: string } | { kind: 'window' | 'window-missed' | 'none' } {
    const at = tsMillis(root), token = scope(lifetime)
    let fallback: 'window' | 'window-missed' | 'none' = 'none'
    for (const id of unknown.get(token) ?? []) {
      const observation = records.get(lifetime.key)?.get(id)?.observation, post = observation?.post
      if (!observation || !post || !rootless(post)) continue
      if (post.issuer.botUserId !== issuer.botUserId || post.issuer.botId !== issuer.botId) continue
      if (post.file !== undefined) {
        if (files.includes(post.file)) return { kind: 'file', id }
        continue
      }
      if (fallback === 'window') continue
      const from = Math.max((post.issuedAt ?? observation.observedAt) - OWN_ROOT_CLOCK_SKEW_MS, lifetime.createdAt ?? 0)
      fallback = at >= from && at <= observation.observedAt + OWN_ROOT_CLOCK_SKEW_MS ? 'window' : 'window-missed'
    }
    return { kind: fallback }
  }
  /**
   * Whether the lifetime holds evidence whose unknown root could be any
   * thread: a root-level own post with an unknown root (only such a post
   * makes a root lookup decide anything), or other evidence published
   * without a root. A reply post under an unresolved parent is neither: it
   * holds no thread, and only its own finding reports it.
   */
  function rootlessPosts(lifetime: SharedChannelLifetime): boolean {
    for (const id of unknown.get(scope(lifetime)) ?? []) {
      const observation = records.get(lifetime.key)?.get(id)?.observation
      if (observation && (!observation.post || rootless(observation.post))) return true
    }
    return false
  }
  /**
   * The parentless upload a looked-up own root matched by file now has that
   * root: save it enrolled with the thread, as eligible as the thread just
   * was. Never posts. True when that write enrolled it (and settled the
   * thread); otherwise its evidence stays pending for recovery.
   */
  async function settleMatchedUpload(key: string, id: string, root: string, eligibility: { mode: ChannelMode; delivery: DeliveryMode }): Promise<boolean> {
    const record = records.get(key)?.get(id), observation = record?.observation, post = observation?.post
    if (!record || record.state !== 'observed' || !observation || !post || observation.root !== undefined || saving.has(id) || !rootless(post)) return false
    const { reason: _reason, ...rest } = post
    const policy = observation.policy.delivery !== undefined ? observation.policy : { mode: eligibility.mode, delivery: eligibility.delivery }
    const resolved: ThreadObservation = { ...observation, root, policy, post: { ...rest, missing: [] } }
    if (!isThreadObservation(resolved)) return false
    return (await saveOwnPost(resolved, 'enrolled')).kind === 'enrolled'
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
      // An own root on a channel that cannot enroll now is not followed; only other pending evidence there still decides.
      if (heldIneligible(key, lifetime, root) && ![...matching?.pending ?? []].some(id => !records.get(key)?.get(id)?.observation.lookup)) return answer('unfollowed')
      // Root-level own posts with unknown roots could be this root, unless a lookup settled it; the same test as `rootLookupNeeded`.
      if (matching?.pending.size || (rootlessPosts(lifetime) && !decided.get(token)?.has(root))) return answer('unresolved')
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
        issuer: identity ? { botUserId: identity.botUserId, botId: identity.botId } : {}, issuedAt: now() }
    },
    confirmOwnPost(issue, posted) {
      const part = posted.part ?? 1
      const ts = isThreadTimestamp(posted.ts) ? posted.ts : undefined
      const parent = isThreadTimestamp(posted.parent) ? posted.parent : undefined
      // A malformed requested parent names no root, and the reply's own ts is not one.
      const parentUnresolved = posted.parent !== undefined && parent === undefined
      const root = posted.parent !== undefined ? parent : ts
      const file = typeof posted.file === 'string' && OWN_POST_ID_RE.test(posted.file) ? posted.file : undefined
      const base = { key: issue.key, surface: issue.surface, operation: issue.operation, part, channel: posted.channel,
        ...(ts ? { ts } : {}), ...(parent ? { parent } : {}), ...(root ? { root } : {}), ...(file ? { file } : {}) }
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
          if (existing.state === 'enrolled') return done(outcomeOf('enrolled', existing.observation, { duplicate: true }))
          // A decided ineligible post lacks nothing more; the reason it was pending no longer applies.
          const { reason: _stale, ...decided } = outcomeOf('ineligible', existing.observation, { missing: [], duplicate: true })
          return done(decided)
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
            ...(parentUnresolved ? { parentUnresolved: true as const } : {}), ...(file ? { file } : {}),
            ...(Number.isSafeInteger(issue.issuedAt) && issue.issuedAt! >= 0 ? { issuedAt: issue.issuedAt } : {}), issuer: { ...issue.issuer }, missing,
            ...(reason ? { reason } : {}) },
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
    async retryOwnPost(key, id, evidence) {
      const record = records.get(key)?.get(id), observation = record?.observation
      if (!record || record.state !== 'observed' || !observation?.post) return undefined
      if (saving.has(id)) return outcomeOf('pending', observation)
      const current = status(observation.lifetime), durable = durableCopy(key, id)
      if (current === 'superseded') return report(outcomeOf('superseded', observation))
      if (current !== 'current') return outcomeOf(durable ? 'pending' : 'gap', observation, durable ? {} : { reason: 'lifetime-unresolved' })
      // Another post already enrolled this thread durably: writing this one too would add nothing.
      if (observation.root && followed(observation.lifetime, observation.root)) {
        drop(key, id)
        return report(outcomeOf('enrolled', observation, { missing: [], duplicate: true }))
      }
      const eligibility = observation.root ? currentEligibility(key, observation.lifetime.channel, evidence) : undefined
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
      // The policy applied at the post's first success stays its policy; a later change applies to arriving replies only.
      const policy = observation.policy.delivery !== undefined ? observation.policy : { mode: eligibility.mode, delivery: eligibility.delivery }
      return saveOwnPost({ ...observation, policy, post: { ...post, missing: [] } }, 'enrolled')
    },
    async resolveOwnPostRoot(key, id, root) {
      const record = records.get(key)?.get(id), observation = record?.observation, post = observation?.post
      if (!record || record.state !== 'observed' || !post || observation!.root !== undefined || saving.has(id) || !isThreadTimestamp(root)) return undefined
      if (!rootless(post)) return undefined
      const current = status(observation!.lifetime)
      if (current === 'superseded') return report(outcomeOf('superseded', observation!))
      if (current !== 'current') return undefined
      const missing = post.missing.filter(m => m !== 'root')
      const resolved: ThreadObservation = { ...observation!, root, post: { ...post, missing } }
      if (!isThreadObservation(resolved)) return undefined
      // The resolved root protects its thread at once; the write makes it durable.
      install(key, { v: 1, kind: 'thread-participation', seq: 0, state: 'observed', observation: resolved })
      const saved = await saveOwnPost(resolved, 'observed')
      if (saved.kind !== 'pending') return saved
      return await api.retryOwnPost(key, id) ?? saved
    },
    ownPostFindings(key) {
      return [...records].filter(([k]) => key === undefined || key === k).flatMap(([k, own]) => [...own.values()]
        .filter(r => r.state === 'observed' && r.observation.post && !saving.has(r.observation.id) && status(r.observation.lifetime) !== 'superseded')
        .map(r => durableCopy(k, r.observation.id) ? outcomeOf('pending', r.observation) : outcomeOf('gap', r.observation, { reason: 'storage' })))
    },
    ownPostOpen(key, id) {
      const record = records.get(key)?.get(id)
      return record?.state === 'observed' && record.observation.post !== undefined && !saving.has(id) && status(record.observation.lifetime) !== 'superseded'
    },
    rootLookupNeeded(key, channel, root) {
      const lifetime = options.authority.lifetime(key, channel)
      if (!lifetime || status(lifetime) !== 'current' || !isThreadTimestamp(root) || !initialized.has(key)) return false
      return !followed(lifetime, root) && !decided.get(scope(lifetime))?.has(root) && !heldIneligible(key, lifetime, root) && rootlessPosts(lifetime)
    },
    async requestRootLookup(key, channel, root, issuer, policy) {
      const lifetime = options.authority.lifetime(key, channel)
      if (!lifetime || status(lifetime) !== 'current' || !isThreadTimestamp(root) || !isRootLookupIssuer(issuer)) return undefined
      const id = rootLookupObservationId(lifetime, root)
      // A new request (the channel can enroll again) reopens a lookup an ineligible channel set aside.
      ineligibleRoots.get(scope(lifetime))?.delete(root)
      const existing = records.get(key)?.get(id)
      if (existing && existing.state !== 'observed') return undefined
      const previous = existing?.observation.lookup?.issuer
      if (existing && previous?.botUserId === issuer.botUserId && previous?.botId === issuer.botId) return structuredClone(existing.observation)
      // A lookup requested for an earlier identity of this lifetime is issued again for the current one: only its answer decides.
      const observation: ThreadObservation = existing
        ? { ...structuredClone(existing.observation), lookup: { issuer: { ...issuer }, requestedAt: now() } }
        : { id, lifetime: structuredClone(lifetime), root, observedAt: now(),
          policy: { mode: policy.mode, delivery: policy.delivery }, lookup: { issuer: { ...issuer }, requestedAt: now() } }
      if (!isThreadObservation(observation)) return undefined
      try { await options.queue.recordThreadObservation(key, observation) } catch { return undefined }
      if (status(lifetime) !== 'current') return undefined
      install(key, { v: 1, kind: 'thread-participation', seq: 0, state: 'observed', observation })
      return structuredClone(observation)
    },
    rootLookups(key) {
      return [...(records.get(key)?.values() ?? [])]
        .filter(r => r.state === 'observed' && r.observation.lookup && status(r.observation.lifetime) === 'current' &&
          !ineligibleRoots.get(scope(r.observation.lifetime))?.has(r.observation.root!) && !followed(r.observation.lifetime, r.observation.root!))
        .map(r => structuredClone(r.observation))
    },
    rootLookupOpen(key, id) {
      const record = records.get(key)?.get(id)
      return record?.state === 'observed' && record.observation.lookup !== undefined && status(record.observation.lifetime) === 'current'
    },
    async resolveRootLookup(key, id, verdict, evidence) {
      const record = records.get(key)?.get(id), observation = record?.observation
      if (!record || record.state !== 'observed' || !observation?.lookup || !observation.root) return { kind: 'absent' }
      const lifetime = observation.lifetime, root = observation.root, channel = lifetime.channel
      const notCurrent = (): RootLookupOutcome | undefined => { const now = status(lifetime); return now === 'current' ? undefined : { kind: now } }
      const before = notCurrent()
      if (before) return before
      // Another post or reply made the thread durably followed meanwhile: the lookup decides nothing more.
      if (followed(lifetime, root)) { drop(key, id); return { kind: 'followed' } }
      const ownRoot = verdict.kind === 'own' && verdict.root === root
      let match: ReturnType<typeof matchOwnRoot> = { kind: 'none' }
      if (ownRoot) {
        // A pending own post of this lifetime in that very thread settles it by its own enrollment.
        for (const other of roots.get(scope(lifetime))?.get(root)?.pending ?? []) {
          if (other !== id && records.get(key)?.get(other)?.observation.post) return { kind: 'deferred' }
        }
        match = matchOwnRoot(lifetime, root, observation.lookup.issuer, verdict.files ?? [])
        // A clock window is no authorship fact: an own root outside it stays undecided.
        if (match.kind === 'window-missed') return { kind: 'unmatched' }
      }
      try {
        if (match.kind === 'file' || match.kind === 'window') {
          const eligibility = currentEligibility(key, channel, evidence)
          if (!eligibility) return { kind: 'pending', reason: 'eligibility-unavailable' }
          if (eligibility.kind === 'unresolved') return { kind: 'pending', reason: eligibility.reason, mode: eligibility.mode }
          // The root is the persona's; only the channel cannot enroll now. Nothing is written: replies there are
          // re-evaluated under current eligibility, and a reply once the channel can enroll asks again.
          if (eligibility.kind === 'ineligible') {
            let marked = ineligibleRoots.get(scope(lifetime))
            if (!marked) { marked = new Set(); ineligibleRoots.set(scope(lifetime), marked) }
            marked.add(root)
            settled(key, channel, root)
            return { kind: 'ineligible' }
          }
          const enrolled: ThreadObservation = { ...observation, policy: { mode: eligibility.mode, delivery: eligibility.delivery } }
          await options.queue.recordThreadObservation(key, enrolled, 'enrolled')
          const after = notCurrent()
          if (after) return after
          install(key, { v: 1, kind: 'thread-participation', seq: 0, state: 'enrolled', observation: enrolled })
          if (!(match.kind === 'file' && await settleMatchedUpload(key, match.id, root, eligibility))) settled(key, channel, root)
          return { kind: 'enrolled' }
        }
      } catch (error) {
        return supersededNow(lifetime) ? { kind: 'superseded' } : { kind: 'storage', error }
      }
      // Another author's root, or an own root no post of this lifetime created: the thread is not followed from it.
      const cancelled: ThreadObservation = ownRoot ? { ...observation, lookup: { ...observation.lookup, reason: 'outside-lifetime' } } : observation
      try { await options.queue.cancelThreadObservation(key, cancelled) } catch (error) {
        return supersededNow(lifetime) ? { kind: 'superseded' } : { kind: 'storage', error }
      }
      const after = notCurrent()
      if (after) return after
      install(key, { v: 1, kind: 'thread-participation', seq: 0, state: 'cancelled', observation: cancelled })
      settled(key, channel, root)
      return { kind: ownRoot ? 'outside-lifetime' : 'not-own' }
    },
    stop() { stopped = true },
  }
  return api
}
