/** Per-persona own-post operations. Construction and reads perform no I/O.
 * SPDX-License-Identifier: MIT */
import { CHANNEL_ID_RE } from './config.ts'
import { isThreadTimestamp } from './delivery-decision.ts'
import type { DeliveryQueue } from './delivery-queue.ts'
import { sameChannelStamp, type ChannelStamp } from './shared-channels.ts'
import { ownPostDigest, type OwnPostContent, type ThreadMemory } from './thread-memory.ts'
import type { OwnPostAnswer, OwnPostChoice, OwnPostEligibility, OwnPostOperation, OwnPostOwner, OwnPostStart, OwnPostSurface, OwnPostTarget } from './own-post.ts'

export type OwnPostLookupHolds = 'thread' | 'failed' | 'none'
export type OwnPostLookupOutcome = { holds: 'thread'; thread: string } | { holds: 'failed' | 'none' }
export type OwnPostLookupResult =
  | { found: { ts: string; threadTs?: string }; holds: 'thread' | 'none' }
  | { notFound: true; holds: 'failed' | 'none' }
export interface OwnPostOutcome {
  kind: 'confirmed' | 'failed' | 'not-found'
  thread?: string
  joined: boolean
}
export interface PendingOwnPost {
  operationId: string; key: string; surface?: OwnPostSurface
  channel: string; parent?: string; root?: string; issuedAt: number
  stamp?: ChannelStamp; digest?: string; file?: string
  state: 'awaiting-answer' | 'unknown' | 'awaiting-thread' | 'deferred' | 'decided'
  outcome?: OwnPostOutcome
  lookup?: OwnPostLookupOutcome
}
/** `awaiting-thread`: a confirmed new-message upload waits for its own share's `ts`. */
export type OwnPostEvent = {
  type: 'registered' | 'decided' | 'unknown' | 'awaiting-thread'; key: string; channel: string; operationId: string
  outcome?: OwnPostOutcome
  lookup?: OwnPostLookupOutcome
}
export interface OwnPostJoinsDeps {
  memory: ThreadMemory
  lookupSlackKey: DeliveryQueue['lookupSlackKey']
  eligibility(key: string, channel: string): OwnPostEligibility
  choice(key: string, channel: string): OwnPostChoice
  now(): number
  operationId(): string
  isDryRun(): boolean
}
export interface OwnPostJoins extends OwnPostOwner {
  pendingOwnPosts(key: string, channel: string): readonly PendingOwnPost[]
  unknownOwnPosts(key: string): readonly PendingOwnPost[]
  operation(key: string, operationId: string): PendingOwnPost | undefined
  /** Confirmed uploads still awaiting their thread, in issue order; every channel's without `channel`. */
  awaitingUploads(key: string, channel?: string): readonly PendingOwnPost[]
  recordLookup(key: string, operationId: string, result: OwnPostLookupResult): void
  resolvedThreads(key: string, channel: string): ReadonlySet<string>
  learnUploadThread(key: string, operationId: string, threadTs: string): void
  retainOutcomes(key: string, operationIds: readonly string[]): () => void
  memoryOnlyJoins(key: string): { channel: string; root: string }[]
  settleDeferred(key: string, channel?: string): void
  onSharedStatePublished(key: string): void
  subscribe(listener: (event: OwnPostEvent) => void): () => void
  forget(key: string): void
  stop(): void
}
/** The owner and its background lookups judge the same current publication. */
export function ownPostStampState(memory: Pick<ThreadMemory, 'channelStamp'>, key: string, channel: string,
  recorded: ChannelStamp | undefined): 'current' | 'stale' | 'undecided' {
  const stamp = memory.channelStamp(key, channel)
  if (stamp?.kind === 'undecided') return 'undecided'
  return recorded && sameChannelStamp(recorded, stamp) ? 'current' : 'stale'
}
interface Entry {
  post: PendingOwnPost
  /** Only an undecided stamp keeps content here. The store owns it thereafter. */
  content?: OwnPostContent
  intentKept: boolean
  ended: boolean
  reported: boolean
}

export function createOwnPostJoins(deps: OwnPostJoinsDeps): OwnPostJoins {
  const { memory } = deps
  const entries = new Map<string, Map<string, Entry>>()
  const handles = new WeakMap<OwnPostOperation, Entry>()
  const retained = new Map<string, Map<string, number>>()
  const listeners = new Set<(event: OwnPostEvent) => void>()
  const publications = new Map<string, object>()
  const resolved = new Map<string, Map<string, Set<string>>>()
  let stopped = false

  function safely<T>(fallback: T, work: () => T): T { try { return work() } catch { return fallback } }
  function allowed(key: string): boolean { return !stopped && !deps.isDryRun() && memory.isApplied(key) }
  function keyEntries(key: string): Map<string, Entry> {
    let found = entries.get(key)
    if (!found) { found = new Map(); entries.set(key, found) }
    return found
  }
  function snapshot(entry: Entry): PendingOwnPost { return structuredClone(entry.post) }
  function emit(type: OwnPostEvent['type'], entry: Entry): void {
    const { key, channel, operationId, outcome, lookup } = entry.post
    for (const listener of listeners) {
      try { void Promise.resolve(listener({ type, key, channel, operationId, ...(outcome ? { outcome: { ...outcome } } : {}),
        ...(lookup ? { lookup: { ...lookup } } : {}) })).catch(() => {}) } catch { /* isolated consumer */ }
    }
  }
  function importIntents(key: string): Map<string, Entry> {
    const found = keyEntries(key)
    if (!allowed(key)) return found
    for (const intent of memory.unresolvedIntents(key)) {
      const old = found.get(intent.operationId)
      if (old) { old.post.digest = intent.digest; continue }
      found.set(intent.operationId, {
        post: { operationId: intent.operationId, key, channel: intent.channel, root: intent.root,
          issuedAt: intent.at, stamp: { ...intent.stamp }, digest: intent.digest, state: 'unknown' },
        intentKept: true, ended: true, reported: false,
      })
    }
    return found
  }
  function stampState(post: PendingOwnPost): 'current' | 'stale' | 'undecided' {
    return ownPostStampState(memory, post.key, post.channel, post.stamp)
  }
  function alreadyJoined(post: PendingOwnPost): boolean {
    return post.root !== undefined && (memory.view(post.key, post.channel, post.root) === 'joined' || memory.hasKeptJoin(post.key, post.channel, post.root))
  }
  function keep(entry: Entry): OwnPostStart['ready'] {
    const post = entry.post
    if (!post.stamp || !entry.content) return undefined
    const digestKey = memory.digestKey(post.key)
    if (digestKey) post.digest = ownPostDigest(digestKey, entry.content)
    const kept = memory.keepIntent(post.key, {
      operationId: post.operationId, channel: post.channel, root: post.root, at: post.issuedAt, stamp: post.stamp,
      ...(post.digest ? { digest: post.digest } : { content: entry.content }),
    })
    if (!kept.kept) return undefined
    entry.intentKept = true
    delete entry.content
    return kept.ready?.then(() => {}, () => {})
  }
  function discardDecided(entry: Entry): void {
    const post = entry.post
    if (post.state === 'decided' && !retained.get(post.key)?.get(post.operationId)) entries.get(post.key)?.delete(post.operationId)
  }
  function reportOutcome(entry: Entry): void {
    if (!entry.reported) { entry.reported = true; emit('decided', entry) }
    discardDecided(entry)
  }
  function finish(entry: Entry, joined: boolean): void {
    entry.post.state = 'decided'
    entry.post.outcome!.joined = joined
    reportOutcome(entry)
  }
  function decide(entry: Entry): void {
    const post = entry.post, outcome = post.outcome
    if (!outcome || !entry.intentKept) return
    if (outcome.kind !== 'confirmed') {
      if (memory.resolveIntent(post.key, post.operationId, { none: true }) !== undefined) finish(entry, false)
      return
    }
    const stamp = stampState(post)
    if (stamp === 'undecided') { post.state = 'deferred'; reportOutcome(entry); return }
    const eligibility = stamp === 'stale' ? undefined : deps.eligibility(post.key, post.channel)
    if (stamp === 'stale' || eligibility?.kind === 'ineligible') {
      if (memory.resolveIntent(post.key, post.operationId, { none: true }) !== undefined) finish(entry, false)
    } else if (eligibility?.kind === 'unresolved') {
      post.state = 'deferred'
      // Slack has confirmed this thread even though its join still waits.
      // Post Holds can consume that fact without treating it as a saved join.
      reportOutcome(entry)
    } else if (outcome.thread && post.stamp) {
      const result = memory.resolveIntent(post.key, post.operationId, { joined: { channel: post.channel, root: outcome.thread, stamp: post.stamp } })
      if (result !== undefined) finish(entry, result === 'joined')
    }
  }
  function confirm(entry: Entry, thread: string, learn = true): void {
    if (learn) {
      const { key, channel } = entry.post
      let channels = resolved.get(key)
      if (!channels) { channels = new Map(); resolved.set(key, channels) }
      let roots = channels.get(channel)
      if (!roots) { roots = new Set(); channels.set(channel, roots) }
      roots.add(thread)
    }
    entry.post.outcome = { kind: 'confirmed', thread, joined: false }
    entry.post.state = 'deferred'
    if (entry.intentKept) decide(entry)
    else reportOutcome(entry)
  }
  function startOperation(key: string, surface: OwnPostSurface, target: OwnPostTarget, content: OwnPostContent): OwnPostStart | undefined {
    if (!allowed(key) || !CHANNEL_ID_RE.test(target.channel)) return undefined
    const choice = deps.choice(key, target.channel)
    if (choice.readable && choice.choice !== 'thread_hybrid') return undefined
    const stamp = memory.channelStamp(key, target.channel)
    if (!stamp || (stamp.kind === 'decided' && !stamp.threadHybridSince)) return undefined
    if (target.parent !== undefined && !isThreadTimestamp(target.parent)) return undefined
    const stored = target.parent ? deps.lookupSlackKey(key, { chat_id: target.channel, ts: target.parent }) : undefined
    const root = stored?.status === 'duplicate' ? stored.item?.accepted.thread_ts ?? target.parent : target.parent
    const post: PendingOwnPost = { key, channel: target.channel, parent: target.parent, root, surface,
      operationId: deps.operationId(), issuedAt: deps.now(), state: 'awaiting-answer',
      ...(stamp.kind === 'decided' ? { stamp: { incarnation: stamp.incarnation, threadHybridSince: stamp.threadHybridSince! } } : {}),
    }
    if (post.stamp && alreadyJoined(post)) return undefined
    const found = importIntents(key)
    if (found.has(post.operationId)) return undefined
    const entry: Entry = { post, content: content.kind === 'text' ? { kind: 'text', text: content.text }
      : { kind: 'file', name: content.name, size: content.size }, intentKept: false, ended: false, reported: false }
    found.set(post.operationId, entry)
    const operation = {} as OwnPostOperation
    handles.set(operation, entry)
    const ready = post.stamp ? keep(entry) : undefined
    emit('registered', entry)
    return { operation, ...(ready ? { ready } : {}) }
  }
  function endOperation(operation: OwnPostOperation, answer: OwnPostAnswer): void {
    const entry = handles.get(operation)
    if (!entry || entry.ended || !allowed(entry.post.key) || entries.get(entry.post.key)?.get(entry.post.operationId) !== entry) return
    entry.ended = true
    const post = entry.post
    if (answer.kind === 'no-answer') { post.state = 'unknown'; emit('unknown', entry); return }
    if (answer.kind === 'failed') {
      post.outcome = { kind: 'failed', joined: false }
      post.state = 'deferred'
      if (entry.intentKept) decide(entry)
      else reportOutcome(entry)
      return
    }
    // The operation's channel is captured before Slack; no answer can move
    // its intent into another persona/channel's lifetime.
    if (answer.channel !== post.channel) { post.state = 'unknown'; emit('unknown', entry); return }
    const thread = isThreadTimestamp(answer.threadTs) ? answer.threadTs : post.root ?? (isThreadTimestamp(answer.ts) ? answer.ts : undefined)
    if (answer.file) post.file = answer.file
    if (thread) confirm(entry, thread)
    else if (answer.file) { post.state = 'awaiting-thread'; emit('awaiting-thread', entry) }
    else { post.state = 'unknown'; emit('unknown', entry) }
  }
  function settleDeferred(key: string, channel?: string): void {
    if (!allowed(key)) return
    for (const entry of importIntents(key).values()) {
      const post = entry.post
      if (channel !== undefined && post.channel !== channel) continue
      if (!post.stamp) {
        const stamp = memory.channelStamp(key, post.channel)
        if (stamp?.kind === 'undecided') continue
        const choice = deps.choice(key, post.channel)
        if ((choice.readable && choice.choice !== 'thread_hybrid') || alreadyJoined(post)) {
          entries.get(key)?.delete(post.operationId)
          continue
        }
        if (!stamp || !stamp.threadHybridSince) continue
        post.stamp = { incarnation: stamp.incarnation, threadHybridSince: stamp.threadHybridSince }
        keep(entry)
      }
      if (post.state === 'deferred') decide(entry)
    }
  }
  const api: OwnPostJoins = {
    startOperation: (key, surface, target, content) => safely(undefined, () => startOperation(key, surface, target, content)),
    endOperation: (operation, answer) => safely(undefined, () => endOperation(operation, answer)),
    pendingOwnPosts: (key, channel) => safely([], () => [...importIntents(key).values()].filter(entry =>
      entry.post.channel === channel && entry.post.state !== 'decided' && stampState(entry.post) === 'current').map(snapshot)),
    unknownOwnPosts: key => safely([], () => [...importIntents(key).values()].filter(entry => entry.post.state === 'unknown' && entry.post.stamp !== undefined).map(snapshot)),
    operation: (key, operationId) => safely(undefined, () => { const entry = importIntents(key).get(operationId); return entry ? snapshot(entry) : undefined }),
    awaitingUploads: (key, channel) => safely([], () => [...importIntents(key).values()].filter(entry =>
      (channel === undefined || entry.post.channel === channel) && entry.post.state === 'awaiting-thread')
      .sort((a, b) => a.post.issuedAt - b.post.issuedAt).map(snapshot)),
    recordLookup: (key, operationId, result) => safely(undefined, () => {
      if (!allowed(key)) return
      const entry = importIntents(key).get(operationId)
      if (!entry) return
      const stamp = stampState(entry.post)
      // An upload awaiting its thread learns it only through learnUploadThread;
      // a lookup can only close it.
      if (entry.post.state === 'awaiting-thread' && 'notFound' in result) {
        entry.post.lookup = { holds: stamp === 'stale' ? 'none' : result.holds === 'failed' ? 'failed' : 'none' }
        entry.post.outcome = { kind: 'not-found', joined: false }
        entry.post.state = 'deferred'
        if (entry.intentKept) decide(entry)
        else reportOutcome(entry)
        return
      }
      if (entry.post.state !== 'unknown') return
      if ('found' in result && stamp !== 'stale') {
        const thread = isThreadTimestamp(result.found.threadTs) ? result.found.threadTs : entry.post.root ?? result.found.ts
        if (isThreadTimestamp(thread)) {
          entry.post.lookup = result.holds === 'thread' ? { holds: 'thread', thread } : { holds: 'none' }
          confirm(entry, thread, stamp === 'current')
        }
      } else {
        entry.post.lookup = { holds: stamp === 'stale' ? 'none' : result.holds === 'failed' ? 'failed' : 'none' }
        entry.post.outcome = { kind: 'not-found', joined: false }; decide(entry)
      }
    }),
    resolvedThreads: (key, channel) => safely(new Set<string>(), () => new Set(resolved.get(key)?.get(channel))),
    learnUploadThread: (key, operationId, threadTs) => safely(undefined, () => {
      if (!allowed(key) || !isThreadTimestamp(threadTs)) return
      const entry = importIntents(key).get(operationId)
      if (entry?.post.state === 'awaiting-thread') confirm(entry, threadTs)
    }),
    retainOutcomes: (key, operationIds) => safely(() => {}, () => {
      let counts = retained.get(key)
      if (!counts) { counts = new Map(); retained.set(key, counts) }
      const owned = counts, ids = [...new Set(operationIds)]
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
      let released = false
      return () => safely(undefined, () => {
        if (released || retained.get(key) !== owned) return
        released = true
        for (const id of ids) {
          const count = owned.get(id) ?? 0
          if (count > 1) owned.set(id, count - 1)
          else { owned.delete(id); const entry = entries.get(key)?.get(id); if (entry) discardDecided(entry) }
        }
        if (!owned.size) retained.delete(key)
      })
    }),
    memoryOnlyJoins: key => safely([], () => {
      const pairs = new Map(memory.memoryOnlyOwnPostJoins(key).map(pair => [JSON.stringify([pair.channel, pair.root]), pair]))
      for (const entry of entries.get(key)?.values() ?? []) {
        const post = entry.post
        if (post.state !== 'deferred' || post.outcome?.kind !== 'confirmed' || !post.outcome.thread ||
          (post.stamp && stampState(post) === 'stale') || memory.intentSaved(key, post.operationId)) continue
        const pair = { channel: post.channel, root: post.outcome.thread }
        pairs.set(JSON.stringify([pair.channel, pair.root]), pair)
      }
      return [...pairs.values()]
    }),
    settleDeferred: (key, channel) => safely(undefined, () => settleDeferred(key, channel)),
    onSharedStatePublished(key) {
      if (stopped || publications.has(key)) return
      const token = {}; publications.set(key, token)
      queueMicrotask(() => {
        if (publications.get(key) !== token) return
        publications.delete(key)
        api.settleDeferred(key)
      })
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    forget(key) { entries.delete(key); retained.delete(key); publications.delete(key); resolved.delete(key) },
    stop() { stopped = true; publications.clear() },
  }
  return api
}
