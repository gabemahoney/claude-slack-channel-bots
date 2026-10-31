/**
 * own-post-lookup.ts — Background lookups that settle the bot's own posts
 * whose outcomes are unknown. Page readers retain identifiers and digests
 * only; construction and imports perform no I/O and start no timers.
 *
 * SPDX-License-Identifier: MIT
 */
import { OWN_ROOT_CLOCK_SKEW_MS, THREAD_MEMORY_LOOKUP_DEADLINE_MS } from './delivery-constants.ts'
import { armNeverEarlyWait, type NeverEarlyWaitClock } from './ad-settings.ts'
import { isOwn, isThreadTimestamp } from './delivery-decision.ts'
import { compareTs, type OwnPostTarget, type OwnPostJoins, type PendingOwnPost } from './own-post.ts'
import type { PersonaConnectionManager } from './persona-connections.ts'
import type { ChannelStamp } from './shared-channels.ts'
import { SLACK_ERROR_CODE_RE, type SlackBotIdentity } from './persona-slack-validation.ts'
import { ownPostDigest, createMetadataAttempts, classifyMetadataFailure, metadataRetryDelay,
  type MetadataFailure, type MetadataResult, type ThreadMemory, type ThreadMemoryLookupMethod } from './thread-memory.ts'

export const OWN_POST_LOOKUP_PAGE_LIMIT = 200
export interface OwnPostLookupRange { oldest: string; latest: string }
export interface OwnPostLookupMessage { ts: string; threadTs?: string; digests: readonly string[] }
export type OwnPostLookupPage =
  | { kind: 'page'; own: OwnPostLookupMessage[]; nextCursor?: string }
  | { kind: 'malformed' }
export type OwnPostLookupFailure =
  | { kind: 'retry'; retryAfter?: number }
  | { kind: 'wait' | 'close' }
  | { kind: 'lost'; code: string }
export type OwnPostLookupJudgement =
  | { kind: 'found'; ts: string; threadTs?: string; holds: 'thread' | 'none' }
  | { kind: 'none'; holds: 'failed' | 'none' }
  | { kind: 'lost'; reason: 'several' | 'unmatched'; threads: string[]; holds: 'none' }

export function ownPostLookupRange(issueTime: number, endReading: number): OwnPostLookupRange {
  return { oldest: (Math.max(0, issueTime - OWN_ROOT_CLOCK_SKEW_MS) / 1000).toFixed(6),
    latest: ((endReading + OWN_ROOT_CLOCK_SKEW_MS) / 1000).toFixed(6) }
}
export function ownPostLookupRequest(target: OwnPostTarget, range: OwnPostLookupRange, cursor?: string):
  { method: ThreadMemoryLookupMethod; args: Record<string, unknown> } {
  return {
    method: target.parent === undefined ? 'conversations.history' : 'conversations.replies',
    args: { channel: target.channel, ...(target.parent === undefined ? {} : { ts: target.parent }),
      ...range, inclusive: true, limit: OWN_POST_LOOKUP_PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function readOwnPostLookupPage(response: unknown, inputs: {
  target: OwnPostTarget; range: OwnPostLookupRange; identity: Pick<SlackBotIdentity, 'botUserId' | 'botId'>; digestKey: string
}): OwnPostLookupPage {
  if (!object(response) || response.ok !== true || !Array.isArray(response.messages)) return { kind: 'malformed' }
  const metadata = response.response_metadata
  if (metadata !== undefined && !object(metadata)) return { kind: 'malformed' }
  const cursor = metadata?.next_cursor
  if (cursor !== undefined && typeof cursor !== 'string') return { kind: 'malformed' }
  const own: OwnPostLookupMessage[] = []
  for (const message of response.messages) {
    if (!object(message) || !isOwn(typeof message.user === 'string' ? message.user : undefined,
      typeof message.bot_id === 'string' ? message.bot_id : undefined, inputs.identity)) continue
    const ts = message.ts, threadTs = message.thread_ts
    if (!isThreadTimestamp(ts)) return { kind: 'malformed' }
    if (compareTs(ts, inputs.range.oldest) < 0 || compareTs(ts, inputs.range.latest) > 0) continue
    if (threadTs !== undefined && !isThreadTimestamp(threadTs)) return { kind: 'malformed' }
    if (inputs.target.parent !== undefined) {
      if (ts === inputs.target.parent || ts === threadTs) continue
    } else if (threadTs !== undefined && threadTs !== ts) continue
    const digests: string[] = []
    if (typeof message.text === 'string') digests.push(ownPostDigest(inputs.digestKey, { kind: 'text', text: message.text }))
    if (Array.isArray(message.files)) for (const file of message.files) {
      if (object(file) && typeof file.name === 'string' && typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0) {
        digests.push(ownPostDigest(inputs.digestKey, { kind: 'file', name: file.name, size: file.size }))
      }
    }
    own.push({ ts, ...(threadTs === undefined ? {} : { threadTs }), digests })
  }
  return { kind: 'page', own, ...(cursor ? { nextCursor: cursor } : {}) }
}

export function classifyOwnPostLookupFailure(failure: MetadataFailure, hasParent: boolean): OwnPostLookupFailure {
  switch (failure.kind) {
    case 'deadline': return { kind: 'retry' }
    case 'transient': return { kind: 'retry', ...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }) }
    case 'cancelled': return { kind: 'wait' }
    case 'not-found':
      if (hasParent && (failure.slackError === 'thread_not_found' || failure.slackError === 'message_not_found')) return { kind: 'close' }
      // Every other permanent answer loses the join.
    case 'capability': case 'credentials': case 'access-lost': case 'rejected': case 'malformed':
      return { kind: 'lost', code: 'slackError' in failure && typeof failure.slackError === 'string' && SLACK_ERROR_CODE_RE.test(failure.slackError)
        ? failure.slackError : failure.kind }
    default: return { kind: 'retry' }
  }
}

export function judgeOwnPostLookup(inputs: {
  digest: string; hasParent: boolean; own: readonly OwnPostLookupMessage[]; leftOut(ts: string): boolean
}): OwnPostLookupJudgement {
  // A cursor page can repeat a message; it is still one candidate.
  const messages = new Map<string, OwnPostLookupMessage>()
  for (const message of inputs.own) {
    const previous = messages.get(message.ts)
    messages.set(message.ts, previous ? { ...message, digests: [...new Set([...previous.digests, ...message.digests])] } : message)
  }
  let excluded = false
  const remaining = [...messages.values()].filter(message => {
    if (!inputs.hasParent && inputs.leftOut(message.ts)) { excluded = true; return false }
    return true
  })
  const candidates = remaining.filter(message => message.digests.includes(inputs.digest))
  if (candidates.length === 1) {
    const message = candidates[0]!
    return { kind: 'found', ts: message.ts, ...(message.threadTs === undefined ? {} : { threadTs: message.threadTs }), holds: excluded ? 'none' : 'thread' }
  }
  if (!remaining.length) return { kind: 'none', holds: excluded ? 'none' : 'failed' }
  return { kind: 'lost', reason: candidates.length ? 'several' : 'unmatched', holds: 'none',
    threads: [...new Set((candidates.length ? candidates : remaining).map(message => message.threadTs ?? message.ts))] }
}

export interface OwnPostLookupEvent {
  kind: 'joins-lost'; key: string; channel: string; threads: readonly string[]; cause: string
}

export interface OwnPostLookupsDeps {
  owner: Pick<OwnPostJoins, 'unknownOwnPosts' | 'recordLookup' | 'resolvedThreads' | 'subscribe'>
  memory: Pick<ThreadMemory, 'view' | 'store' | 'clock' | 'digestKey'>
  stamp(key: string, channel: string, stamp: ChannelStamp): 'current' | 'stale' | 'undecided'
  connections: Pick<PersonaConnectionManager, 'metadataCall' | 'identity'> & {
    currentConnectionId(key: string): string | undefined
    isUp(key: string): boolean
  }
  clock: NeverEarlyWaitClock
  onEvent?(event: OwnPostLookupEvent): void
}
export interface OwnPostLookups {
  /** Capture recovery ranges at read completion, before asynchronous recovery
   * or flushing. This starts no lookup and never reads back into the owner. */
  journalRead(key: string): void
  kick(key: string): void
  forget(key: string): void
  stop(): void
}
type LookupAnswer = { kind: 'pages-complete' } | { kind: 'lost'; code: string; threads: string[] } | { kind: 'none'; holds: 'none' }
interface LookupJob {
  post: PendingOwnPost
  range?: OwnPostLookupRange
  cursor?: string
  own: OwnPostLookupMessage[]
  failures: number
  retryAt?: { start: number; delay: number }
  answer?: LookupAnswer
  /** Cancellation waits for a subsequent kick, not an immediate busy loop. */
  waitingAt?: number
}
interface PersonaLookups {
  jobs: Map<string, LookupJob>
  ends: Map<string, number>
  waitingEnds: Set<string>
  readEnd?: number
  running: boolean
  scheduled: boolean
  reschedule: boolean
  kicks: number
  failures: number
  retryAt?: { start: number; delay: number }
  cancelWait?: () => void
  inFlight?: { job: LookupJob; connectionId: string }
}

/** Each persona owns its pages, retry wait and revocable attempt. A forgotten
 * state's object is its generation token: no old continuation can use a new one. */
export function createOwnPostLookups(deps: OwnPostLookupsDeps): OwnPostLookups {
  const personas = new Map<string, PersonaLookups>()
  const attempts = createMetadataAttempts(deps.clock, THREAD_MEMORY_LOOKUP_DEADLINE_MS)
  let stopped = false
  const current = (key: string, state: PersonaLookups) => !stopped && personas.get(key) === state
  const readable = (key: string) => deps.memory.store(key)?.readable === true
  const stamp = (key: string, job: LookupJob) => job.post.stamp ? deps.stamp(key, job.post.channel, job.post.stamp) : 'undecided'
  function stateFor(key: string): PersonaLookups {
    let state = personas.get(key)
    if (!state) {
      state = { jobs: new Map(), ends: new Map(), waitingEnds: new Set(), running: false, scheduled: false, reschedule: false, kicks: 0, failures: 0 }
      personas.set(key, state)
    }
    return state
  }
  function captureEnd(key: string, state: PersonaLookups, id: string, readEnd?: number): void {
    if (state.ends.has(id)) return
    if (readable(key)) { state.ends.set(id, readEnd ?? deps.memory.clock(key)); state.waitingEnds.delete(id) }
    else state.waitingEnds.add(id)
  }
  function refresh(key: string, state: PersonaLookups): void {
    // An operation started under an undecided stamp may not be in the owner's
    // unknown list yet. Its first-read end still precedes that stamp decision.
    for (const id of state.waitingEnds) captureEnd(key, state, id, state.readEnd)
    const listed = deps.owner.unknownOwnPosts(key)
    const ids = new Set(listed.map(post => post.operationId))
    for (const id of state.jobs.keys()) if (!ids.has(id)) { state.jobs.delete(id); state.ends.delete(id); state.waitingEnds.delete(id) }
    for (const post of listed) {
      let job = state.jobs.get(post.operationId)
      if (!job) { job = { post, own: [], failures: 0 }; state.jobs.set(post.operationId, job) }
      else job.post = post
      captureEnd(key, state, post.operationId, state.readEnd)
      const end = state.ends.get(post.operationId)
      if (!job.range && end !== undefined) job.range = ownPostLookupRange(post.issuedAt, end)
    }
    const flight = state.inFlight
    const connectionId = deps.connections.currentConnectionId(key)
    if (flight && (state.jobs.get(flight.job.post.operationId) !== flight.job || stamp(key, flight.job) === 'stale' ||
      (connectionId !== undefined && connectionId !== flight.connectionId))) attempts.revoke(key)
  }
  function wait(key: string, state: PersonaLookups, start: number, delay: number): void {
    state.cancelWait?.()
    state.cancelWait = armNeverEarlyWait(deps.clock, start, delay, () => {
      state.cancelWait = undefined
      schedule(key, state)
    })
  }
  function retry(key: string, state: PersonaLookups): void {
    if (!current(key, state)) return
    try {
      state.retryAt = { start: deps.clock.now(), delay: metadataRetryDelay(++state.failures) }
      wait(key, state, state.retryAt.start, state.retryAt.delay)
    } catch { /* a later kick can recover a broken clock */ }
  }
  function schedule(key: string, state: PersonaLookups): void {
    if (!current(key, state) || state.scheduled) return
    state.scheduled = true
    queueMicrotask(() => {
      state.scheduled = false
      if (!current(key, state)) return
      try {
        // Kicks do not shorten a retry after an unexpected dependency fault.
        if (state.retryAt && state.retryAt.delay > Math.max(0, deps.clock.now() - state.retryAt.start)) {
          wait(key, state, state.retryAt.start, state.retryAt.delay)
          return
        }
        state.retryAt = undefined
        refresh(key, state)
        if (state.running) { state.reschedule = true; return }
        state.cancelWait?.(); state.cancelWait = undefined
        state.running = true
        void drive(key, state).catch(() => retry(key, state)).finally(() => {
          state.running = false
          if (state.reschedule) { state.reschedule = false; schedule(key, state) }
        })
      } catch { retry(key, state) }
    })
  }
  function finish(key: string, state: PersonaLookups, job: LookupJob): boolean {
    const status = stamp(key, job)
    if (status === 'undecided') return false
    // Keep complete pages while undecided: Joined Thread and resolved-operation
    // exclusions must use the current stamp immediately before recording.
    const answer = status === 'stale' ? { kind: 'none' as const, holds: 'none' as const }
      : job.answer?.kind === 'pages-complete' ? judge(key, job) : job.answer
    if (!answer) return false
    const id = job.post.operationId
    if (answer.kind === 'found') deps.owner.recordLookup(key, id, {
      found: { ts: answer.ts, ...(answer.threadTs === undefined ? {} : { threadTs: answer.threadTs }) }, holds: answer.holds,
    })
    else deps.owner.recordLookup(key, id, { notFound: true, holds: answer.kind === 'none' ? answer.holds : 'none' })
    state.jobs.delete(id); state.ends.delete(id); state.waitingEnds.delete(id)
    if (answer.kind === 'lost' && current(key, state) && stamp(key, job) === 'current') {
      try { void Promise.resolve(deps.onEvent?.({ kind: 'joins-lost', key, channel: job.post.channel,
        threads: answer.threads, cause: 'reason' in answer ? answer.reason : answer.code })).catch(() => {}) } catch { /* isolated reporter */ }
    }
    return true
  }
  function judge(key: string, job: LookupJob): OwnPostLookupJudgement {
    const roots = deps.owner.resolvedThreads(key, job.post.channel)
    return judgeOwnPostLookup({ digest: job.post.digest!, hasParent: job.post.root !== undefined, own: job.own,
      leftOut: ts => roots.has(ts) || deps.memory.view(key, job.post.channel, ts) === 'joined' })
  }
  async function page(key: string, state: PersonaLookups, job: LookupJob, connectionId: string,
    identity: SlackBotIdentity, digestKey: string): Promise<void> {
    const target = { channel: job.post.channel, parent: job.post.root }
    const request = ownPostLookupRequest(target, job.range!, job.cursor)
    const kickNumber = state.kicks
    state.inFlight = { job, connectionId }
    // The auth watch detaches the socket before rejecting invalid_auth. Keep
    // that actual answer; absence of a socket after it is not cancellation.
    // A newer connection still revokes this attempt at its connected kick.
    const attempt = await attempts.run(key, () => current(key, state) && state.jobs.get(job.post.operationId) === job,
      async signal => {
        try { return { kind: 'ok', value: await deps.connections.metadataCall(key, connectionId, request.method, request.args, signal) } satisfies MetadataResult }
        catch (error) { return classifyMetadataFailure(error) }
      })
    state.inFlight = undefined
    if (!current(key, state) || state.jobs.get(job.post.operationId) !== job) return
    let result = attempt.kind === 'ok' ? attempt.value as MetadataResult : attempt
    const connectionNow = deps.connections.currentConnectionId(key)
    if (connectionNow !== connectionId || !deps.connections.isUp(key)) {
      if (!(result.kind === 'credentials' && connectionNow === undefined)) result = { kind: 'cancelled' }
    }
    let failure: MetadataFailure
    if (result.kind === 'ok') {
      if (object(result.value) && result.value.ok === false) failure = classifyMetadataFailure({ code: 'slack_webapi_platform_error', data: result.value })
      else {
        const read = readOwnPostLookupPage(result.value, { target, range: job.range!, identity, digestKey })
        if (read.kind === 'page') {
          job.own.push(...read.own); job.cursor = read.nextCursor; job.failures = 0; job.retryAt = undefined
          if (!read.nextCursor) job.answer = { kind: 'pages-complete' }
          return
        }
        failure = read
      }
    } else failure = result
    const outcome = classifyOwnPostLookupFailure(failure, target.parent !== undefined)
    switch (outcome.kind) {
      case 'retry': job.retryAt = { start: deps.clock.now(), delay: metadataRetryDelay(++job.failures, outcome.retryAfter) }; return
      case 'wait': job.waitingAt = kickNumber; return
      case 'close': job.answer = { kind: 'none', holds: 'none' }; return
      case 'lost': job.answer = { kind: 'lost', code: outcome.code, threads: [] }; return
    }
  }
  async function drive(key: string, state: PersonaLookups): Promise<void> {
    while (current(key, state)) {
      refresh(key, state)
      let next: LookupJob | undefined
      let earliest: { start: number; delay: number; remaining: number } | undefined
      for (const job of [...state.jobs.values()].sort((a, b) => a.post.issuedAt - b.post.issuedAt)) {
        if (!current(key, state)) return
        if (finish(key, state, job)) continue
        if (!current(key, state)) return
        if (stamp(key, job) !== 'current' || job.answer || job.waitingAt === state.kicks) continue
        if (!readable(key) || !job.range || !job.post.digest) continue
        if (job.retryAt) {
          const remaining = job.retryAt.delay - Math.max(0, deps.clock.now() - job.retryAt.start)
          if (remaining > 0) {
            if (!earliest || remaining < earliest.remaining) earliest = { ...job.retryAt, remaining }
            continue
          }
        }
        next = job; break
      }
      if (!current(key, state)) return
      if (!next) {
        if (earliest) wait(key, state, earliest.start, earliest.delay)
        return
      }
      const connectionId = deps.connections.currentConnectionId(key), identity = deps.connections.identity(key), digestKey = deps.memory.digestKey(key)
      if (!deps.connections.isUp(key) || !connectionId || !identity || !digestKey) return
      await page(key, state, next, connectionId, identity, digestKey)
      state.failures = 0
    }
  }
  function kick(key: string): void {
    if (stopped) return
    const state = stateFor(key)
    // Observe a replacement before its next microtask, even if it immediately
    // drops again. No old reply may be applied to that replacement connection.
    const connectionId = deps.connections.currentConnectionId(key)
    if (state.inFlight && connectionId !== undefined && connectionId !== state.inFlight.connectionId) attempts.revoke(key)
    state.kicks++
    schedule(key, state)
  }
  function forget(key: string): void {
    const state = personas.get(key)
    personas.delete(key)
    try { attempts.revoke(key) } catch { /* cancellation stays isolated */ }
    try { state?.cancelWait?.() } catch { /* a forgotten generation cannot act */ }
  }
  const unsubscribe = deps.owner.subscribe(event => {
    if (stopped || event.type !== 'unknown') return
    const state = stateFor(event.key)
    try { captureEnd(event.key, state, event.operationId) } catch { /* retried by the kick */ }
    kick(event.key)
  })
  return {
    journalRead(key) {
      if (stopped) return
      try {
        const state = stateFor(key)
        if (state.readEnd === undefined && readable(key)) state.readEnd = deps.memory.clock(key)
        for (const id of state.waitingEnds) captureEnd(key, state, id, state.readEnd)
      } catch { /* the later kick can recover an unavailable clock */ }
    },
    kick: key => { try { kick(key) } catch { /* no exception reaches a lifecycle caller */ } },
    forget,
    stop() {
      if (stopped) return
      stopped = true
      try { unsubscribe() } catch { /* observer cleanup cannot interrupt shutdown */ }
      for (const key of personas.keys()) forget(key)
      try { attempts.stop() } catch { /* cancellation cannot interrupt shutdown */ }
    },
  }
}
