/**
 * thread-memory.ts — Per-persona Thread Memory journals and the bounded,
 * revocable metadata calls their lookups use.
 *
 * Every lookup attempt (`conversations.replies`, `conversations.history`)
 * runs under one end-to-end deadline (`THREAD_MEMORY_LOOKUP_DEADLINE_MS`). Its
 * abort signal reaches the queued and in-flight HTTP work through the
 * connection manager's metadata client (`metadataWebClientOptions`: no SDK
 * retries, rate limits rejected, request interceptor bound to the signal, and
 * no SDK HTTP timeout), so the deadline is the only clock: a hung request
 * fails as `deadline` at the deadline, and an expired attempt leaves no SDK
 * request behind while a fresh one starts. A late fulfillment or rejection is
 * consumed without effect.
 *
 * An attempt belongs to its persona, its authenticated connection and the
 * evidence it serves: `MetadataAttempts.run` re-checks the caller's `current`
 * guard after the await, and `revoke`/`stop` abort every attempt of a persona
 * (or all). A revoked, superseded or post-shutdown result is `cancelled` and
 * can change nothing.
 *
 * Failures are classified apart: an expired deadline, a transient failure
 * of the dependency (with any Retry-After), a request Slack rejected for a
 * reason specific to it, a missing capability, refused credentials, lost
 * access, a not-found answer, malformed data and cancellation. None of them
 * is a deleted root, a negative authorship or a recovery; deciding that is the
 * callers' job, from a successful response only.
 *
 * SPDX-License-Identifier: MIT
 */

import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { PERSONA_KEY_RE } from './persona-identity.ts'
import { QUEUE_COMPACT_INTERVAL_MS } from './delivery-queue.ts'
import { durableUnlinkSync, DurableUnlinkUnsyncedError } from './atomic-write.ts'
import type { ThreadMemoryJournalFact, ThreadMemoryJournalFacts, ThreadMemorySealPort, ThreadMemoryStoreIdentity } from './thread-memory-seal.ts'
import { createDurableJournal, splitJournalLines, removeTornTail, type AppendRollback } from './durable-journal.ts'
import { THREAD_MEMORY_LOOKUP_DEADLINE_MS, THREAD_MEMORY_RETRY_MAX_MS, THREAD_MEMORY_RETRY_MIN_MS } from './delivery-constants.ts'
import type { PersonaConnectionClock } from './persona-connections.ts'
import { SLACK_ERROR_CODE_RE, WEB_API_AUTH_FAILURE_ERRORS, slackRetryAfterSeconds } from './persona-slack-validation.ts'
import { sameChannelStamp, type ChannelStamp } from './shared-channels.ts'

/** The metadata methods Thread Memory's lookups may call; nothing else. */
export const THREAD_MEMORY_LOOKUP_METHODS = ['conversations.replies', 'conversations.history'] as const
export type ThreadMemoryLookupMethod = typeof THREAD_MEMORY_LOOKUP_METHODS[number]

export const METADATA_DEADLINE_CODE = 'thread-memory-lookup-deadline'

export class MetadataDeadlineError extends Error {
  readonly code = METADATA_DEADLINE_CODE
  constructor() { super('Thread Memory lookup request deadline expired.') }
}
export class MetadataCancelledError extends Error {
  constructor() { super('Thread Memory lookup request was superseded or cancelled.') }
}

/** Slack errors that mean the token lacks the method, scope or permission. */
export const METADATA_CAPABILITY_ERRORS: ReadonlySet<string> = new Set([
  'missing_scope', 'not_allowed_token_type', 'no_permission', 'access_denied', 'method_deprecated',
  'ekm_access_denied', 'team_access_not_granted', 'not_authorized', 'restricted_action',
])
/** Slack errors that mean the persona cannot see the conversation any more. */
export const METADATA_ACCESS_ERRORS: ReadonlySet<string> = new Set(['channel_not_found', 'not_in_channel', 'is_archived'])
/** Slack errors that mean the named message or thread does not exist (or no longer does). */
export const METADATA_NOT_FOUND_ERRORS: ReadonlySet<string> = new Set(['thread_not_found', 'message_not_found'])
/** Slack errors that mean Slack itself is failing or limiting: the dependency is down, not this item. */
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout', 'ratelimited'])

/** Why one attempt produced no usable response. */
export type MetadataFailure =
  | { kind: 'deadline' }
  | { kind: 'cancelled' }
  /** The dependency looks down: a server or rate-limit error, or a transport failure. */
  | { kind: 'transient'; retryAfter?: number }
  /** Slack refused this one request for a reason not known to mean it is down (an unrecognised error, an HTTP 4xx). */
  | { kind: 'rejected'; slackError?: string }
  | { kind: 'capability'; slackError: string }
  | { kind: 'credentials'; slackError: string }
  | { kind: 'access-lost'; slackError: string }
  | { kind: 'not-found'; slackError: string }
  | { kind: 'malformed' }
export type MetadataResult = { kind: 'ok'; value: unknown } | MetadataFailure

const read = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined

/**
 * Classify a value a metadata attempt rejected with. Copies only a safe
 * Slack error code and Retry-After. Only a server, rate-limit or transport
 * failure is `transient`; an unrecognised Slack error or an HTTP 4xx is
 * `rejected`, specific to that request. Either leaves the evidence
 * unresolved and retried. Never throws.
 */
export function classifyMetadataFailure(error: unknown): MetadataFailure {
  if (error instanceof MetadataCancelledError) return { kind: 'cancelled' }
  const code = read(error, 'code')
  if (code === METADATA_DEADLINE_CODE) return { kind: 'deadline' }
  if (code === 'slack_webapi_platform_error') {
    const slackError = read(read(error, 'data'), 'error')
    if (typeof slackError !== 'string' || !SLACK_ERROR_CODE_RE.test(slackError)) return { kind: 'malformed' }
    if (WEB_API_AUTH_FAILURE_ERRORS.has(slackError)) return { kind: 'credentials', slackError }
    if (METADATA_CAPABILITY_ERRORS.has(slackError)) return { kind: 'capability', slackError }
    if (METADATA_ACCESS_ERRORS.has(slackError)) return { kind: 'access-lost', slackError }
    if (METADATA_NOT_FOUND_ERRORS.has(slackError)) return { kind: 'not-found', slackError }
    if (!TRANSIENT_ERRORS.has(slackError)) return { kind: 'rejected', slackError }
    const retryAfter = slackRetryAfterSeconds(error)
    return { kind: 'transient', ...(retryAfter !== undefined ? { retryAfter } : {}) }
  }
  if (code === 'slack_webapi_http_error') {
    const status = read(error, 'statusCode')
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) return { kind: 'rejected' }
  }
  const retryAfter = slackRetryAfterSeconds(error)
  return { kind: 'transient', ...(retryAfter !== undefined ? { retryAfter } : {}) }
}

/**
 * Run one metadata request under the end-to-end deadline. Aborting `parent`
 * or reaching the deadline aborts the request's own signal and rejects with
 * `MetadataCancelledError` / `MetadataDeadlineError`; a late settlement of
 * the request is consumed.
 */
export function boundedMetadataCall<T>(
  clock: PersonaConnectionClock, parent: AbortSignal, operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = THREAD_MEMORY_LOOKUP_DEADLINE_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    let timer: unknown
    const finish = (success: boolean, value: unknown) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clock.clearTimeout(timer)
      parent.removeEventListener('abort', cancel)
      controller.abort()
      if (success) resolve(value as T)
      else reject(value)
    }
    const cancel = () => finish(false, new MetadataCancelledError())
    parent.addEventListener('abort', cancel, { once: true })
    if (parent.aborted) { cancel(); return }
    timer = clock.setTimeout(() => finish(false, new MetadataDeadlineError()), Math.max(0, timeoutMs))
    try { Promise.resolve(operation(controller.signal)).then(value => finish(true, value), error => finish(false, error)) }
    catch (error) { finish(false, error) }
  })
}

/**
 * The wait before the next attempt after `failures` consecutive failures
 * (1 for the first): bounded exponential from the positive minimum to the
 * local maximum, or a greater Retry-After, which is always honored.
 */
export function metadataRetryDelay(failures: number, retryAfterSeconds?: number): number {
  const exponent = Math.max(0, Math.min(Math.floor(failures) - 1, 20))
  const local = Math.min(THREAD_MEMORY_RETRY_MAX_MS, THREAD_MEMORY_RETRY_MIN_MS * 2 ** exponent)
  const asked = typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, retryAfterSeconds * 1000) : 0
  return Math.max(local, asked)
}

/** Revocable ownership of each persona's in-flight metadata attempts. */
export interface MetadataAttempts {
  /**
   * Run one bounded attempt owned by persona `key`. `current` is the
   * caller's guard (connection, lifetime, observation still the same); a
   * result after it turns false, after `revoke(key)` or after `stop()` is
   * `cancelled`. Never rejects.
   */
  run(key: string, current: () => boolean, operation: (signal: AbortSignal) => Promise<unknown>): Promise<MetadataResult>
  /** Abort and invalidate every attempt of `key` (its connection, identity or lifetime changed). */
  revoke(key: string): void
  /** Number of attempts in flight for `key`, for tests and bounded scheduling. */
  inFlight(key: string): number
  /** Abort everything; later `run` calls are cancelled at once. */
  stop(): void
}

export function createMetadataAttempts(clock: PersonaConnectionClock, timeoutMs = THREAD_MEMORY_LOOKUP_DEADLINE_MS): MetadataAttempts {
  const owned = new Map<string, Set<AbortController>>()
  let stopped = false
  return {
    async run(key, current, operation) {
      if (stopped || !current()) return { kind: 'cancelled' }
      const controller = new AbortController()
      let mine = owned.get(key)
      if (!mine) { mine = new Set(); owned.set(key, mine) }
      mine.add(controller)
      try {
        const value = await boundedMetadataCall(clock, controller.signal, operation, timeoutMs)
        return stopped || controller.signal.aborted || !current() ? { kind: 'cancelled' } : { kind: 'ok', value }
      } catch (error) {
        return stopped || controller.signal.aborted || !current() ? { kind: 'cancelled' } : classifyMetadataFailure(error)
      } finally {
        mine.delete(controller)
        if (!mine.size && owned.get(key) === mine) owned.delete(key)
      }
    },
    revoke(key) {
      for (const controller of owned.get(key) ?? []) controller.abort()
    },
    inFlight: key => owned.get(key)?.size ?? 0,
    stop() {
      stopped = true
      for (const mine of owned.values()) for (const controller of mine) controller.abort()
    },
  }
}

// --- Journal format and in-memory views ---
export const THREAD_MEMORY_DIRECTORY_MODE = 0o700
export const THREAD_MEMORY_FILE_MODE = 0o600
export type ThreadMemoryStamp = ChannelStamp
export type ThreadMemoryStampState =
  | { kind: 'decided'; incarnation: string; threadHybridSince?: string }
  | { kind: 'undecided' }
export interface ThreadJoin {
  channel: string; root: string; stamp: ThreadMemoryStamp
  source: 'mention' | 'broadcast' | 'own-post'; at: number
}
interface ThreadRecordBase { v: 1; seq: number }
export interface ThreadMemoryHeader extends ThreadRecordBase {
  kind: 'header'; storeId: string; digestKey: string; highWater: number
}
export interface ThreadJoinRecord extends ThreadRecordBase, ThreadJoin { kind: 'join' }
export interface ThreadPostIntent extends ThreadRecordBase {
  kind: 'post-intent'; operationId: string; channel: string; root?: string
  at: number; stamp: ThreadMemoryStamp; digest: string
}
export interface ThreadPostOutcome extends ThreadRecordBase {
  kind: 'post-outcome'; operationId: string; outcome: 'joined' | 'none'
}
export type OwnPostContent = { kind: 'text'; text: string } | { kind: 'file'; name: string; size: number }
export type OwnPostIntent = Pick<ThreadPostIntent, 'operationId' | 'channel' | 'root' | 'at' | 'stamp'> &
  { noticeOnly?: boolean } &
  ({ digest: string } | { content: OwnPostContent })
export type UnresolvedOwnPostIntent = Pick<ThreadPostIntent, 'operationId' | 'channel' | 'root' | 'at' | 'stamp'> & { digest?: string }
export type KeepIntentResult = { kept: false } | { kept: true; ready?: Promise<'saved' | 'failed'> }
export type ResolveIntentResult = { joined: { channel: string; root: string; stamp: ChannelStamp } } | { none: true }

/** The same normalisation is used for outgoing text and lookup candidates. */
export function normaliseOwnPostText(text: string): string {
  return text.replace(/&amp;|&lt;|&gt;/g, escape => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>' })[escape]!)
    .replace(/<([^<>|]+)(?:\|[^<>]*)?>/g, '$1').trim()
}
/** Versioned, disjoint encodings keep file metadata separate from text. */
export function ownPostDigest(digestKey: string, content: OwnPostContent): string {
  const encoded = content.kind === 'text' ? ['own-post-v1', 'text', normaliseOwnPostText(content.text)]
    : ['own-post-v1', 'file', content.name, content.size]
  return createHmac('sha256', Buffer.from(digestKey, 'hex')).update(JSON.stringify(encoded)).digest('hex')
}
export type ThreadMemoryRecord = ThreadMemoryHeader | ThreadJoinRecord | ThreadPostIntent | ThreadPostOutcome
export type ThreadMemoryView = 'joined' | 'not-joined' | 'unknown'
export interface ThreadMemoryQuarantineFact {
  line: number; invalidFinalLine: boolean; channel?: string; root?: string
}
export type ThreadMemoryEvent =
  | { type: 'append-failed'; key: string; path: string; step: 'journal-append'; error: unknown; noticeOnly: boolean }
  | { type: 'creation-failed'; key: string; path: string; step: 'seal-entry' | 'journal-header' | 'marker'; error: unknown }
  | { type: 'compaction-failed'; key: string; path: string; step: 'journal-rewrite'; error: unknown }
  | { type: 'removal-failed'; key: string; path: string; step: 'journal-unlink' | 'seal-entry' | 'marker'; error: unknown }
  | { type: 'read-failed'; key: string; path: string; error: unknown }
  | { type: 'read'; key: string; path: string; firstSuccessfulRead: boolean }
  | { type: 'saved-after-failure' | 'outage-settled' | 'created' | 'removed'; key: string; path: string }
  | { type: 'lines-quarantined'; key: string; path: string; quarantinePath: string; facts: ThreadMemoryQuarantineFact[] }
export type ThreadMemoryWriteResult = { kind: 'saved' | 'kept' | 'cancelled' } | { kind: 'failed'; error?: unknown }
export type ThreadMemoryReadResult = 'read' | 'unreadable' | 'missing'
export interface ThreadMemoryOutage { unknown: boolean; unsaved: number; missing: boolean }
export interface ThreadMemoryOptions {
  stateDir: string; fs?: typeof nodeFs; now?: () => number; dryRun?: boolean
  seal?: ThreadMemorySealPort
  setInterval?: typeof globalThis.setInterval; clearInterval?: typeof globalThis.clearInterval
  appliedKeys(): readonly string[]
  /** Lifecycle admission, rechecked by queued work and after awaits. The
   * teardown window closes it before the later forget invalidates the journal. */
  canRun?(key: string): boolean
  stamp(key: string, channel: string): ThreadMemoryStampState | undefined
  /** Distinguish pre-authority startup from an authority reporting no persona.
   * Without this adapter, activation or loadKey establishes the authority. */
  authorityReady?(): boolean
  /** Read at use time, including Memory-Dependent decisions still being stored. */
  heldStamps?(key: string): readonly { channel: string; stamp: ChannelStamp }[]
  /** Confirmed own-post facts still owned outside this journal's writer. */
  unsavedOwnPosts?(key: string): number
  threadHybridChannels(key: string): readonly string[]
  markerKeys(): readonly string[]
  /** Staged replacement is not an applied removal; preserve its old evidence. */
  canRemove?(key: string): boolean
  setCreated(key: string): { kind: 'saved' | 'failed' } | Promise<{ kind: 'saved' | 'failed' }>
  clearCreated(key: string): { kind: 'saved' | 'failed' } | Promise<{ kind: 'saved' | 'failed' }>
  onEvent?(event: ThreadMemoryEvent): void
  /** The maintenance compaction interval; `QUEUE_COMPACT_INTERVAL_MS` unless given. */
  compactIntervalMs?: number
}
export interface ThreadMemory {
  readAtStart(): void
  journalFacts(): ThreadMemoryJournalFacts
  completedStores(): ReadonlyMap<string, ThreadMemoryStoreIdentity>
  activate(): Promise<void>
  loadKey(key: string): Promise<void>
  /** Retry only an unknown, current journal. A missing retry stays unknown
   * until a later lifecycle load; it must never create an empty replacement. */
  retryRead(key: string): Promise<ThreadMemoryReadResult>
  outage(key: string): ThreadMemoryOutage
  published(): void
  view(key: string, channel: string, root: string): ThreadMemoryView
  addJoin(key: string, fact: ThreadJoin): boolean
  saveJoins(key: string, facts: readonly ThreadJoin[]): Promise<ThreadMemoryWriteResult>
  isJoinSaved(key: string, fact: ThreadJoin): boolean
  hasSavedJoin(key: string, channel: string, root: string, stamp: ChannelStamp): boolean
  threadJoinSaved(key: string, channel: string, root: string, stamp: ChannelStamp, at: number): boolean
  joinedBy(key: string, channel: string, root: string, stamp: ChannelStamp, at: number): boolean | 'unknown'
  pruneHeldJoins(key: string): void
  /** Judge queue joins in order, add them synchronously, then schedule one save. */
  recoverJoins(key: string, candidates: readonly ThreadJoin[]): void
  /** Rejudge after the first successful read of an unknown journal, before
   * Memory Hold resolution. The read-retry owner also calls this entry. */
  retryPendingJoins(key: string): void
  keptFacts(key: string): ThreadJoin[]
  joins(key: string): { join: ThreadJoin; savedAt?: number }[]
  isApplied(key: string): boolean
  channelStamp(key: string, channel: string): ThreadMemoryStampState | undefined
  digestKey(key: string): string | undefined
  saveBlocked(key: string): boolean
  keepIntent(key: string, intent: OwnPostIntent): KeepIntentResult
  resolveIntent(key: string, operationId: string, result: ResolveIntentResult): 'joined' | 'none' | undefined
  unresolvedIntents(key: string, channel?: string): UnresolvedOwnPostIntent[]
  hasKeptJoin(key: string, channel: string, root: string): boolean
  intentSaved(key: string, operationId: string): boolean
  memoryOnlyOwnPostJoins(key: string): { channel: string; root: string }[]
  store(key: string): { storeId?: string; digestKey?: string; lastRecordNumber: number; readable: boolean; created: boolean } | undefined
  readFacts(key: string): { error?: unknown; quarantined: ThreadMemoryQuarantineFact[] }
  clock(key: string): number
  advancePast(key: string, at: number): void
  flush(key: string): Promise<ThreadMemoryWriteResult>
  compact(key?: string): Promise<void>
  forget(key: string): void
  remove(key: string): Promise<ThreadMemoryWriteResult>
  removeUnappliedAtStart(): Promise<void>
  startMaintenance(intervalMs?: number): void
  quiesce(): Promise<void>
  stop(): Promise<void>
}
const memoryObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const memoryInteger = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const memoryTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const memoryId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v)
const memoryChannel = (v: unknown): v is string => typeof v === 'string' && /^[CG][A-Z0-9]+$/.test(v)
const memoryRoot = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d{6}$/.test(v)
function validMemoryStamp(v: unknown): v is ThreadMemoryStamp {
  return memoryObject(v) && memoryId(v.incarnation) && memoryId(v.threadHybridSince) &&
    Object.keys(v).every(k => k === 'incarnation' || k === 'threadHybridSince')
}
function validThreadJoin(v: ThreadJoin): boolean {
  return memoryChannel(v.channel) && memoryRoot(v.root) && validMemoryStamp(v.stamp) &&
    ['mention', 'broadcast', 'own-post'].includes(v.source) && memoryTime(v.at)
}
function copyThreadJoin(input: ThreadJoin): ThreadJoin {
  if (!validThreadJoin(input)) throw new Error('Invalid Thread Memory join')
  // Structural subtypes can carry content; copy only the journal's metadata.
  return {
    channel: input.channel, root: input.root,
    stamp: { incarnation: input.stamp.incarnation, threadHybridSince: input.stamp.threadHybridSince },
    source: input.source, at: input.at,
  }
}
/** Closed schemas prevent accidentally retaining content in a metadata journal. */
export function isThreadMemoryRecord(v: unknown): v is ThreadMemoryRecord {
  if (!memoryObject(v) || v.v !== 1 || !memoryInteger(v.seq)) return false
  const only = (fields: string[]) => Object.keys(v).every(k => ['v', 'seq', 'kind', ...fields].includes(k))
  switch (v.kind) {
    case 'header': return memoryId(v.storeId) && typeof v.digestKey === 'string' && /^[a-f0-9]{64}$/.test(v.digestKey) &&
      memoryInteger(v.highWater) && v.highWater >= v.seq && only(['storeId', 'digestKey', 'highWater'])
    case 'join': return validThreadJoin(v as unknown as ThreadJoin) && only(['channel', 'root', 'stamp', 'source', 'at'])
    case 'post-intent': return memoryId(v.operationId) && memoryChannel(v.channel) && (v.root === undefined || memoryRoot(v.root)) &&
      memoryTime(v.at) && validMemoryStamp(v.stamp) && typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest) &&
      only(['operationId', 'channel', 'root', 'at', 'stamp', 'digest'])
    case 'post-outcome': return memoryId(v.operationId) && (v.outcome === 'joined' || v.outcome === 'none') && only(['operationId', 'outcome'])
    default: return false
  }
}
export function parseThreadMemoryRecord(line: string): ThreadMemoryRecord | undefined {
  try { const value: unknown = JSON.parse(line); return isThreadMemoryRecord(value) ? value : undefined } catch { return undefined }
}
export function serializeThreadMemoryRecords(records: readonly ThreadMemoryRecord[]): Buffer {
  return Buffer.from(records.map(r => JSON.stringify(r) + '\n').join(''))
}
function memoryStampMatches(a: ThreadMemoryStamp, b: ThreadMemoryStampState | undefined): boolean {
  return sameChannelStamp(a, b)
}
function stampKey(stamp: ThreadMemoryStamp): string { return JSON.stringify([stamp.incarnation, stamp.threadHybridSince]) }
interface JoinedThread { join: ThreadJoin; saved?: ThreadJoinRecord }
type JoinIndex = Map<string, Map<string, Map<string, JoinedThread>>>
type KeptIntent = Omit<ThreadPostIntent, 'v' | 'seq' | 'digest'> & { digest?: string; content?: OwnPostContent; noticeOnly?: boolean }
/** Reporting provenance stays in memory; journal records never carry it. */
type KeptRecord = (({ kind: 'join' } & ThreadJoin) | KeptIntent | Omit<ThreadPostOutcome, 'v' | 'seq'>) & { noticeOnly?: boolean }
interface KeptWrite { records: KeptRecord[] }
interface MemoryJournal extends AppendRollback {
  readable: boolean; exists: boolean; hasRecords: boolean; live: boolean; created: boolean; failed: boolean
  header?: ThreadMemoryHeader; highWater: number; records?: ThreadMemoryRecord[]
  creationHeader?: ThreadMemoryHeader; sealSaved?: boolean
  missing?: boolean
  joinedByChannel: JoinIndex
  /** Per channel, the stamp key every `joinedByChannel` entry matched at its
   * last judgement. Absent until judged, and dropped when a join under
   * another stamp is retained, so an unchanged stamp needs no rejudgement. */
  judged: Map<string, string>
  heldJoins: JoinIndex
  kept: ThreadJoin[]; intents: Map<string, KeptIntent>; savedIntents: Map<string, ThreadPostIntent>
  intentsByChannel: Map<string, Map<string, KeptIntent>>
  writes: KeptWrite[]
  ownJoins: Map<string, ThreadJoin>
  error?: unknown; quarantined: ThreadMemoryQuarantineFact[]; quarantineRollback: AppendRollback
}
function emptyMemoryJournal(): MemoryJournal {
  return { readable: true, exists: false, hasRecords: false, live: false, created: false, failed: false, highWater: 0,
    joinedByChannel: new Map(), judged: new Map(), heldJoins: new Map(), kept: [], intents: new Map(), savedIntents: new Map(),
    intentsByChannel: new Map(), writes: [], ownJoins: new Map(), quarantined: [], quarantineRollback: {} }
}

/** All state belongs to this instance; reading, activation and timers are explicit. */
export function createThreadMemory(options: ThreadMemoryOptions): ThreadMemory {
  const fs = options.fs ?? nodeFs, now = options.now ?? Date.now, dir = join(options.stateDir, 'threads')
  const io = createDurableJournal({ dir, parentDir: options.stateDir, directoryMode: THREAD_MEMORY_DIRECTORY_MODE, fileMode: THREAD_MEMORY_FILE_MODE, fs })
  const journals = new Map<string, MemoryJournal>(), writers = new Map<string, Promise<unknown>>()
  const forgotten = new Set<string>(), clocks = new Map<string, number>()
  const pendingJoins = new Map<string, ThreadJoin[]>()
  let activationStarted = false
  let startId: string | undefined, readStarted = false, listingFailed = false, stopped = false, quiesced = false
  let timer: ReturnType<typeof globalThis.setInterval> | undefined
  function pathFor(key: string): string {
    if (!PERSONA_KEY_RE.test(key)) throw new Error('Invalid Thread Memory persona key')
    return join(dir, `${key}.jsonl`)
  }
  function journal(key: string): MemoryJournal {
    pathFor(key)
    let j = journals.get(key)
    if (!j) { j = emptyMemoryJournal(); journals.set(key, j) }
    return j
  }
  function event(e: ThreadMemoryEvent): void {
    try { void Promise.resolve(options.onEvent?.(e)).catch(() => {}) } catch { /* observers cannot change durable outcomes */ }
  }
  function serial<T>(key: string, work: () => T | Promise<T>): Promise<T> {
    const next = (writers.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    writers.set(key, next)
    return next
  }
  function workAllowed(key: string): boolean {
    return !stopped && !quiesced && (options.canRun?.(key) ?? true)
  }
  function current(key: string, j: MemoryJournal): boolean {
    return workAllowed(key) && !forgotten.has(key) && journals.get(key) === j && j.live && options.appliedKeys().includes(key)
  }
  /** A readiness observation, not an episode: the reporter owns recovery.
   * Read outages need this even when no append ever failed, or publication
   * discards the last stale candidate without needing a write. */
  function observeSettled(key: string, j: MemoryJournal): void {
    if (!current(key, j)) return
    const outage = api.outage(key)
    if (!outage.unknown && !outage.unsaved && !outage.missing) event({ type: 'outage-settled', key, path: pathFor(key) })
  }
  function journalFact(j: MemoryJournal): ThreadMemoryJournalFact {
    if (!j.readable) return { kind: 'unreadable' }
    if (!j.exists) return { kind: 'absent' }
    if (!j.header && !j.hasRecords) return { kind: 'not-created' }
    return { kind: 'read', storeId: j.header?.storeId, lastRecordNumber: j.highWater }
  }
  function journalFacts(): ThreadMemoryJournalFacts {
    return new Map([...journals].map(([key, j]) => [key, journalFact(j)]))
  }
  function entry(j: MemoryJournal, fact: ThreadJoin): JoinedThread | undefined {
    return j.joinedByChannel.get(fact.channel)?.get(fact.root)?.get(stampKey(fact.stamp)) ?? j.heldJoins.get(fact.channel)?.get(fact.root)?.get(stampKey(fact.stamp))
  }
  function retain(j: MemoryJournal, fact: ThreadJoin, saved?: ThreadJoinRecord, index = j.joinedByChannel): void {
    if (index === j.joinedByChannel && j.judged.get(fact.channel) !== stampKey(fact.stamp)) j.judged.delete(fact.channel)
    let roots = index.get(fact.channel)
    if (!roots) { roots = new Map(); index.set(fact.channel, roots) }
    let stamps = roots.get(fact.root)
    if (!stamps) { stamps = new Map(); roots.set(fact.root, stamps) }
    const id = stampKey(fact.stamp), old = stamps.get(id)
    if (!old) stamps.set(id, { join: structuredClone(fact), ...(saved ? { saved: structuredClone(saved) } : {}) })
    else {
      if (fact.at < old.join.at) old.join = structuredClone(fact)
      if (saved && (!old.saved || saved.at < old.saved.at)) old.saved = structuredClone(saved)
    }
  }
  function advancePast(key: string, at: number): void {
    if (!memoryTime(at)) throw new Error('Invalid Thread Memory clock time')
    clocks.set(key, Math.max(clocks.get(key) ?? -Infinity, at))
  }
  function named(key: string, channel: string, stamp: ChannelStamp): boolean {
    return options.heldStamps?.(key).some(hold => hold.channel === channel && sameChannelStamp(stamp, { kind: 'decided', ...hold.stamp })) ?? false
  }
  function pruneHeldJoins(key: string): void {
    const j = journals.get(key)
    if (!j) return
    for (const [channel, roots] of j.heldJoins) {
      for (const [root, entries] of roots) {
        for (const [id, value] of entries) if (!named(key, channel, value.join.stamp)) entries.delete(id)
        if (!entries.size) roots.delete(root)
      }
      if (!roots.size) j.heldJoins.delete(channel)
    }
  }
  function judge(key: string, j: MemoryJournal): void {
    pruneHeldJoins(key)
    const stamps = new Map<string, ThreadMemoryStampState | undefined>()
    const readStamp = (channel: string) => {
      if (!stamps.has(channel)) stamps.set(channel, options.stamp(key, channel))
      return stamps.get(channel)
    }
    for (const [channel, roots] of j.joinedByChannel) {
      const stamp = readStamp(channel)
      if (stamp?.kind === 'undecided') continue
      // Every remaining join already matched this stamp: nothing to forget.
      const current = stamp?.kind === 'decided' && stamp.threadHybridSince !== undefined
        ? stampKey({ incarnation: stamp.incarnation, threadHybridSince: stamp.threadHybridSince }) : undefined
      if (current !== undefined && j.judged.get(channel) === current) continue
      for (const [root, entries] of roots) {
        for (const [id, value] of entries) if (!memoryStampMatches(value.join.stamp, stamp)) {
          if (named(key, channel, value.join.stamp)) retain(j, value.join, value.saved, j.heldJoins)
          entries.delete(id)
        }
        if (!entries.size) roots.delete(root)
      }
      if (!roots.size) j.joinedByChannel.delete(channel)
      if (roots.size && current !== undefined) j.judged.set(channel, current)
      else j.judged.delete(channel)
    }
    j.kept = j.kept.filter(fact => readStamp(fact.channel)?.kind === 'undecided' || memoryStampMatches(fact.stamp, readStamp(fact.channel)) || named(key, fact.channel, fact.stamp))
  }
  function replay(key: string, j: MemoryJournal): void {
    replayIntents(j)
    for (const record of j.records ?? []) {
      if (record.kind === 'join') {
        const stamp = options.stamp(key, record.channel)
        if (stamp?.kind === 'undecided' || memoryStampMatches(record.stamp, stamp)) retain(j, record, record)
        else if (named(key, record.channel, record.stamp)) retain(j, record, record, j.heldJoins)
      }
    }
    delete j.records
    judge(key, j)
    j.kept = j.kept.filter(fact => !savedJoin(j, fact))
  }
  function digestKept(j: MemoryJournal): void {
    const digestKey = (j.header ?? j.creationHeader)?.digestKey
    if (!digestKey) return
    for (const write of j.writes) for (const record of write.records) {
      if (record.kind !== 'post-intent' || !record.content) continue
      record.digest = ownPostDigest(digestKey, record.content)
      delete record.content
    }
  }
  function replayIntents(j: MemoryJournal): void {
    if (j.records) {
      j.savedIntents.clear()
      for (const record of j.records) {
        if (record.kind === 'post-intent') j.savedIntents.set(record.operationId, record)
        else if (record.kind === 'post-outcome') j.savedIntents.delete(record.operationId)
      }
    }
    j.intents.clear(); j.intentsByChannel.clear()
    for (const intent of j.savedIntents.values()) indexIntent(j, intent)
    digestKept(j)
    for (const write of j.writes) for (const record of write.records) {
      if (record.kind === 'post-intent') indexIntent(j, record)
      else if (record.kind === 'post-outcome') unindexIntent(j, record.operationId)
    }
  }
  function indexIntent(j: MemoryJournal, intent: KeptIntent): void {
    unindexIntent(j, intent.operationId)
    j.intents.set(intent.operationId, intent)
    let channel = j.intentsByChannel.get(intent.channel)
    if (!channel) { channel = new Map(); j.intentsByChannel.set(intent.channel, channel) }
    channel.set(intent.operationId, intent)
  }
  function unindexIntent(j: MemoryJournal, operationId: string): void {
    const intent = j.intents.get(operationId)
    if (!intent) return
    j.intents.delete(operationId)
    const channel = j.intentsByChannel.get(intent.channel)!
    channel.delete(operationId)
    if (!channel.size) j.intentsByChannel.delete(intent.channel)
  }
  function quarantineFact(text: string, line: number, final: boolean): ThreadMemoryQuarantineFact {
    let raw: Record<string, unknown> = {}
    try { const parsed: unknown = JSON.parse(text); if (memoryObject(parsed)) raw = parsed } catch {
      for (const name of ['channel', 'root']) raw[name] = new RegExp('(?:^|[,{])\\s*"' + name + '"\\s*:\\s*"([^"\\\\]+)"').exec(text)?.[1]
    }
    return { line, invalidFinalLine: final, ...(memoryChannel(raw.channel) ? { channel: raw.channel } : {}), ...(memoryRoot(raw.root) ? { root: raw.root } : {}) }
  }
  function readKey(key: string, retry = false, emitRead = true): ThreadMemoryReadResult {
    const j = journal(key), wasUnknown = !j.readable
    let bytes: Buffer
    try { bytes = fs.readFileSync(pathFor(key)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (retry) { j.missing = true; j.readable = false; return 'missing' }
        if (!wasUnknown) { j.exists = false; j.readable = true; return 'read' }
      }
      j.readable = false; j.error = error
      event({ type: 'read-failed', key, path: pathFor(key), error }); return 'unreadable'
    }
    j.exists = true
    const records: ThreadMemoryRecord[] = [], damaged: ReturnType<typeof splitJournalLines> = []
    let header: ThreadMemoryHeader | undefined, highWater = j.highWater
    const lines = splitJournalLines(bytes)
    for (const line of lines) {
      const record = line.whole ? parseThreadMemoryRecord(line.text) : undefined
      // Even a damaged header must not make subsequent record numbers go backwards.
      try { const raw = JSON.parse(line.text); if (memoryObject(raw) && memoryInteger(raw.seq)) highWater = Math.max(highWater, raw.seq) } catch { /* no readable number */ }
      if (!record || (record.kind === 'header' && header)) { damaged.push(line); continue }
      if (record.kind === 'header') { header = record; highWater = Math.max(highWater, record.highWater) }
      if (record.kind === 'join') advancePast(key, record.at)
      records.push(record)
    }
    try {
      if (damaged.length) {
        startId ??= new Date(now()).toISOString().replace(/:/g, '-')
        const quarantinePath = join(dir, `${key}.unreadable-${startId}`)
        if (!options.dryRun) {
          io.durableAppend(quarantinePath, Buffer.concat(damaged.map(line => line.bytes)), j.quarantineRollback)
          const tail = damaged.at(-1)
          if (tail?.torn) removeTornTail(j, tail)
        }
        const facts = damaged.map(line => quarantineFact(line.text, line.line, line.line === lines.length))
        j.quarantined.push(...facts)
        event({ type: 'lines-quarantined', key, path: pathFor(key), quarantinePath, facts })
      }
      j.records = records; j.hasRecords = records.length > 0; j.header = header; j.highWater = highWater; j.readable = true; delete j.error
      // Expose saved times before activation: the queue compacts after this
      // read and before a shared authority is available. Replay later judges
      // these stamps; no pre-activation join can select intake.
      j.joinedByChannel.clear()
      j.judged.clear()
      j.heldJoins.clear()
      for (const fact of j.kept) retain(j, fact)
      for (const record of records) if (record.kind === 'join') retain(j, record, record)
      j.created = header !== undefined && options.markerKeys().includes(key)
      j.missing = false
      replayIntents(j)
      if (emitRead) event({ type: 'read', key, path: pathFor(key), firstSuccessfulRead: wasUnknown })
      return 'read'
    } catch (error) {
      j.readable = false; j.error = error
      event({ type: 'read-failed', key, path: pathFor(key), error })
      return 'unreadable'
    }
  }
  function newHeader(j: MemoryJournal): ThreadMemoryHeader {
    return { v: 1, kind: 'header', seq: 0, storeId: randomUUID(), digestKey: randomBytes(32).toString('hex'), highWater: j.highWater }
  }
  function compactOne(key: string, j: MemoryJournal, creationHeader?: ThreadMemoryHeader): void {
    if (!current(key, j) || !j.readable || !j.exists || options.dryRun || (!j.hasRecords && !options.threadHybridChannels(key).length)) return
    // Creating a missing header creates a store, so its seal step must run
    // first. Without a seal, retain the original standalone store behavior.
    if (options.seal && !j.header && !creationHeader) return
    try {
      judge(key, j)
      io.reconcileRollback(pathFor(key), j)
      const header = { ...(j.header ?? creationHeader ?? newHeader(j)), highWater: j.highWater }
      const records: ThreadMemoryRecord[] = []
      for (const roots of j.joinedByChannel.values()) for (const entries of roots.values()) for (const value of entries.values()) if (value.saved) records.push(value.saved)
      for (const roots of j.heldJoins.values()) for (const entries of roots.values()) for (const value of entries.values()) if (value.saved) records.push(value.saved)
      // A kept outcome must not erase the saved intent from the disk image.
      records.push(...j.savedIntents.values())
      records.sort((a, b) => a.seq - b.seq)
      io.rewrite(pathFor(key), serializeThreadMemoryRecords([header, ...records]))
      j.header = header; j.hasRecords = true
      digestKept(j)
      // The shared seal writer must never hold a persona's compaction turn.
      void options.seal?.entryCompacted(key, header.storeId, j.highWater)
    } catch (error) { event({ type: 'compaction-failed', key, path: pathFor(key), step: 'journal-rewrite', error }); throw error }
  }
  async function createStore(key: string, j: MemoryJournal): Promise<ThreadMemoryWriteResult> {
    if (!current(key, j)) return { kind: 'cancelled' }
    if (options.dryRun || !j.readable) return { kind: 'kept' }
    if (j.created) return { kind: 'saved' }
    if (!j.hasRecords && !options.threadHybridChannels(key).length) return { kind: 'kept' }
    let step: 'seal-entry' | 'journal-header' | 'marker' = 'seal-entry'
    try {
      // Keep the identity across failures at any creation step. An existing
      // header is already saved; an unsaved header is private to creation.
      const header = j.header ?? (j.creationHeader ??= j.exists
        ? newHeader(j) : { ...newHeader(j), seq: j.highWater + 1, highWater: j.highWater + 1 })
      digestKept(j)
      if (options.seal && !j.sealSaved) {
        const result = await options.seal.entryCreated(key, header.storeId, j.header ? j.highWater : header.highWater)
        if (!current(key, j)) return { kind: 'cancelled' }
        if (result.kind !== 'written') throw result.kind === 'failed' ? result.error : new Error('Thread Memory seal entry was not saved')
        j.sealSaved = true
      }
      if (!j.header) {
        step = 'journal-header'
        if (j.exists) compactOne(key, j, header)
        else {
          io.durableAppend(pathFor(key), serializeThreadMemoryRecords([header]), j)
          j.header = header; j.highWater = header.highWater; j.exists = true; j.hasRecords = true
        }
      }
      if (!current(key, j)) return { kind: 'cancelled' }
      // Repair can skip an empty journal if the last hybrid entry vanished
      // during the seal await. Keep creation pending until its header is saved.
      if (!j.header) return { kind: 'kept' }
      step = 'marker'
      const result = await options.setCreated(key)
      if (!current(key, j)) return { kind: 'cancelled' }
      if (result.kind !== 'saved') throw new Error('Thread Memory created marker was not saved')
      j.created = true
      event({ type: 'created', key, path: pathFor(key) })
      return { kind: 'saved' }
    } catch (error) {
      if (!current(key, j)) return { kind: 'cancelled' }
      j.failed = true; event({ type: 'creation-failed', key, path: pathFor(key), step, error })
      return { kind: 'failed', error }
    }
  }
  function savedJoin(j: MemoryJournal, fact: ThreadJoin): boolean {
    const saved = entry(j, fact)?.saved
    return j.readable && saved !== undefined && saved.at <= fact.at
  }
  function savedAt(key: string, channel: string, root: string, stamp: ChannelStamp): number | undefined {
    const j = journals.get(key)
    if (!j?.readable) return undefined
    const saved = j.joinedByChannel.get(channel)?.get(root)?.get(stampKey(stamp))?.saved
    return saved && sameChannelStamp(saved.stamp, { kind: 'decided', ...stamp }) ? saved.at : undefined
  }
  function recoveryStamp(key: string, fact: ThreadJoin): 'current' | 'stale' | 'undecided' {
    if (!(options.authorityReady?.() ?? activationStarted)) return 'undecided'
    const stamp = options.stamp(key, fact.channel)
    if (stamp?.kind === 'undecided') return 'undecided'
    return sameChannelStamp(fact.stamp, stamp) ? 'current' : 'stale'
  }
  function recoverJoins(key: string, candidates: readonly ThreadJoin[]): void {
    if (!workAllowed(key) || forgotten.has(key)) return
    const all = [...pendingJoins.get(key) ?? [], ...candidates.map(copyThreadJoin)]
    for (const fact of all) advancePast(key, fact.at)
    pendingJoins.delete(key)
    const j = journals.get(key), pending = new Map<string, ThreadJoin>(), added: ThreadJoin[] = []
    for (const fact of all) {
      const state = recoveryStamp(key, fact)
      if (state === 'stale' && !named(key, fact.channel, fact.stamp)) continue
      if (state === 'undecided' || !j?.readable || !current(key, j)) {
        const id = JSON.stringify([fact.channel, fact.root, stampKey(fact.stamp)])
        const old = pending.get(id)
        if (!old || old.at > fact.at) pending.set(id, fact)
        continue
      }
      const known = entry(j, fact)
      if (known && known.join.at <= fact.at) continue
      if (state === 'stale') {
        retain(j, fact, undefined, j.heldJoins)
        keepJoin(j, fact); added.push(fact)
      } else if (addJoin(key, fact)) added.push(fact)
    }
    if (pending.size) pendingJoins.set(key, [...pending.values()])
    // saveJoins only schedules this key's writer: publication and intake
    // never await its append or run a shared-state write synchronously.
    if (added.length) void api.saveJoins(key, added).catch(() => {})
  }
  function keepJoin(j: MemoryJournal, fact: ThreadJoin, write?: KeptWrite): void {
    if (!savedJoin(j, fact) && !j.kept.some(old => old.channel === fact.channel && old.root === fact.root && sameChannelStamp(old.stamp, { kind: 'decided', ...fact.stamp }) && old.at <= fact.at)) {
      j.kept.push(fact)
      const record = { ...fact, kind: 'join' as const }
      if (write) write.records.push(record)
      else j.writes.push({ records: [record] })
    }
  }
  function keepCurrentJoin(key: string, input: ThreadJoin, write?: KeptWrite): boolean {
    const fact = copyThreadJoin(input)
    const j = journals.get(key)
    if (!j || !current(key, j) || !memoryStampMatches(fact.stamp, options.stamp(key, fact.channel))) return false
    retain(j, fact); advancePast(key, fact.at)
    keepJoin(j, fact, write)
    return true
  }
  function addJoin(key: string, input: ThreadJoin): boolean { return keepCurrentJoin(key, input) }
  function keepIntent(key: string, input: OwnPostIntent): KeepIntentResult {
    const j = journals.get(key)
    if (options.dryRun || !j || !current(key, j) || j.intents.has(input.operationId) || j.savedIntents.has(input.operationId)) return { kept: false }
    if (!memoryId(input.operationId) || !memoryChannel(input.channel) || (input.root !== undefined && !memoryRoot(input.root)) ||
      !memoryTime(input.at) || !validMemoryStamp(input.stamp)) return { kept: false }
    const intent: KeptIntent = {
      kind: 'post-intent', operationId: input.operationId, channel: input.channel,
      ...(input.root === undefined ? {} : { root: input.root }), at: input.at,
      stamp: { incarnation: input.stamp.incarnation, threadHybridSince: input.stamp.threadHybridSince },
      noticeOnly: input.noticeOnly === true,
    }
    if ('digest' in input) {
      if (!/^[a-f0-9]{64}$/.test(input.digest)) return { kept: false }
      intent.digest = input.digest
    } else {
      const content = input.content
      intent.content = content.kind === 'text' ? { kind: 'text', text: content.text } : { kind: 'file', name: content.name, size: content.size }
    }
    const blocked = api.saveBlocked(key)
    // A publication can discard the last unsaved stale join without a write.
    if (j.failed && !blocked) j.failed = false
    const write: KeptWrite = { records: [intent] }
    indexIntent(j, intent); j.writes.push(write)
    digestKept(j)
    if (!j.readable || blocked) return { kept: true }
    const ready = serial(key, async () => {
      if (j.failed || !current(key, j)) return 'failed' as const
      await saveKept(key, j, undefined, write)
      return j.savedIntents.has(intent.operationId) || !j.writes.includes(write) ? 'saved' as const : 'failed' as const
    }).catch(() => 'failed' as const)
    return { kept: true, ready }
  }
  function resolveIntent(key: string, operationId: string, result: ResolveIntentResult): 'joined' | 'none' | undefined {
    const j = journals.get(key)
    if (options.dryRun || !j || !current(key, j) || !j.intents.has(operationId)) return undefined
    if (j.failed && !api.saveBlocked(key)) j.failed = false
    const intent = j.intents.get(operationId)!
    const write: KeptWrite = { records: [] }
    let outcome: 'joined' | 'none' = 'none'
    if ('joined' in result && result.joined.channel === intent.channel &&
      sameChannelStamp(intent.stamp, { kind: 'decided', ...result.joined.stamp }) &&
      memoryStampMatches(intent.stamp, options.stamp(key, intent.channel))) {
      const fact = copyThreadJoin({ ...result.joined, source: 'own-post', at: api.clock(key) })
      if (keepCurrentJoin(key, fact, write)) {
        // Even when another operation already joined this root, this outcome
        // and its own join are saved atomically, preserving the earliest time.
        if (!write.records.length) write.records.push({ ...fact, kind: 'join' })
        j.ownJoins.set(operationId, fact)
        outcome = 'joined'
      }
    }
    write.records.push({ kind: 'post-outcome', operationId, outcome })
    for (const record of write.records) record.noticeOnly = intent.noticeOnly === true
    j.writes.push(write); unindexIntent(j, operationId)
    if (j.readable && !j.failed) void serial(key, () => j.failed ? { kind: 'kept' } : saveKept(key, j, undefined, write)).catch(() => {})
    return outcome
  }
  function recordsForWrite(key: string, write: KeptWrite): KeptRecord[] | undefined {
    const joins = write.records.filter((record): record is KeptRecord & ThreadJoin => record.kind === 'join')
    if (joins.some(fact => recoveryStamp(key, fact) === 'undecided')) return undefined
    const stale = joins.some(fact => !memoryStampMatches(fact.stamp, options.stamp(key, fact.channel)))
    return write.records.flatMap(record => {
      if (record.kind === 'join' && recoveryStamp(key, record) === 'stale' && !named(key, record.channel, record.stamp)) return []
      if (record.kind === 'post-outcome' && stale) return [{ ...record, outcome: 'none' as const }]
      return [record]
    })
  }
  async function saveKept(key: string, j: MemoryJournal, requested?: readonly ThreadJoin[], through?: KeptWrite): Promise<ThreadMemoryWriteResult> {
    if (!current(key, j)) return { kind: 'cancelled' }
    if (options.dryRun || !j.readable || (requested !== undefined && !j.created)) return { kind: 'kept' }
    const creation = await createStore(key, j)
    if (creation.kind !== 'saved') return creation
    if (!current(key, j)) return { kind: 'cancelled' }
    const hadKept = j.writes.length > 0
    judge(key, j)
    const last = through ? j.writes.indexOf(through) : j.writes.length - 1
    const candidates = requested ? j.writes.filter(write => write.records.every(fact => fact.kind === 'join' && requested.some(r =>
      r.channel === fact.channel && r.root === fact.root && sameChannelStamp(r.stamp, { kind: 'decided', ...fact.stamp }) && fact.at <= r.at))) : j.writes.slice(0, last + 1)
    const writes: KeptWrite[] = [], records: ThreadMemoryRecord[] = []
    let noticeOnly = true
    digestKept(j)
    for (const write of candidates) {
      const facts = recordsForWrite(key, write)
      // Defer only this join/outcome batch while its stamp is undecided;
      // independent intents must still be appended before their ready settles.
      // Intents contain no join and precede their own outcome in candidates.
      if (!facts) continue
      if (facts.some(fact => fact.kind === 'post-intent' && !fact.digest)) break
      for (const fact of facts) {
        noticeOnly = noticeOnly && fact.noticeOnly === true
        // Content stays private even if a structural caller supplied extra fields.
        if (fact.kind === 'post-intent') {
          const { content: _content, noticeOnly: _noticeOnly, ...intent } = fact
          records.push({ ...intent, digest: fact.digest!, v: 1, seq: j.highWater + records.length + 1 })
        } else if (fact.kind === 'join') records.push({ ...copyThreadJoin(fact), v: 1, kind: 'join', seq: j.highWater + records.length + 1 })
        else records.push({ kind: 'post-outcome', operationId: fact.operationId, outcome: fact.outcome, v: 1, seq: j.highWater + records.length + 1 })
      }
      writes.push(write)
    }
    try {
      if (records.length) {
        io.durableAppend(pathFor(key), serializeThreadMemoryRecords(records), j)
        for (const record of records) {
          if (record.kind === 'join') retain(j, record, record, recoveryStamp(key, record) === 'stale' ? j.heldJoins : j.joinedByChannel)
          else if (record.kind === 'post-intent') j.savedIntents.set(record.operationId, record)
          else if (record.kind === 'post-outcome') { j.savedIntents.delete(record.operationId); j.ownJoins.delete(record.operationId) }
        }
        j.highWater = records.at(-1)!.seq
      }
      const savedWrites = new Set(writes)
      j.writes = j.writes.filter(write => !savedWrites.has(write))
      j.kept = j.kept.filter(fact => !savedJoin(j, fact))
      if (j.failed && !j.writes.length) { j.failed = false; event({ type: 'saved-after-failure', key, path: pathFor(key) }) }
      else if (hadKept) observeSettled(key, j)
      return { kind: j.writes.length ? 'kept' : 'saved' }
    } catch (error) {
      j.failed = true; event({ type: 'append-failed', key, path: pathFor(key), step: 'journal-append', error, noticeOnly: records.length > 0 && noticeOnly })
      return { kind: 'failed', error }
    }
  }
  async function activateKey(key: string): Promise<void> {
    if (!workAllowed(key) || forgotten.has(key)) return
    const j = journal(key)
    j.live = true
    j.created = j.header !== undefined && options.markerKeys().includes(key)
    replay(key, j)
    await serial(key, async () => {
      if (!current(key, j)) return
      try { compactOne(key, j) } catch { /* retry on maintenance; kept facts remain separate */ }
      await createStore(key, j)
    })
  }
  async function remove(key: string): Promise<ThreadMemoryWriteResult> {
    pathFor(key)
    if (options.canRemove?.(key) === false) return { kind: 'kept' }
    forgotten.add(key); journals.delete(key); pendingJoins.delete(key)
    return serial(key, async () => {
      if (options.dryRun || stopped || quiesced) return { kind: 'cancelled' }
      if (options.canRemove?.(key) === false) return { kind: 'kept' }
      let step: 'journal-unlink' | 'seal-entry' | 'marker' = 'journal-unlink'
      try {
        try { durableUnlinkSync(pathFor(key), fs) } catch (error) { if (!(error instanceof DurableUnlinkUnsyncedError)) throw error }
        if (options.seal) {
          step = 'seal-entry'
          const sealed = await options.seal.removeEntry(key)
          if (sealed.kind !== 'written' && sealed.kind !== 'skipped') {
            throw sealed.kind === 'failed' ? sealed.error : new Error('Thread Memory seal entry was not removed')
          }
          if (stopped || quiesced) return { kind: 'cancelled' }
        }
        step = 'marker'
        const result = await options.clearCreated(key)
        if (result.kind !== 'saved') throw new Error('Thread Memory created marker was not cleared')
        event({ type: 'removed', key, path: pathFor(key) })
        return { kind: 'saved' }
      } catch (error) { event({ type: 'removal-failed', key, path: pathFor(key), step, error }); return { kind: 'failed', error } }
    })
  }
  async function removeUnappliedAtStart(): Promise<void> {
    const applied = new Set(options.appliedKeys())
    const keys = new Set([...journals.keys(), ...options.markerKeys(), ...options.seal?.entryKeys() ?? []])
    await Promise.all([...keys].filter(key => !applied.has(key)).map(remove))
  }
  async function compact(key?: string): Promise<void> {
    await Promise.allSettled((key ? [key] : [...journals.keys()]).map(k => {
      const j = journals.get(k)
      return j ? serial(k, () => compactOne(k, j)) : Promise.resolve()
    }))
  }
  const api: ThreadMemory = {
    readAtStart() {
      if (readStarted || stopped || quiesced) return
      readStarted = true
      let names: string[]
      try { names = fs.readdirSync(dir) } catch (error) { listingFailed = (error as NodeJS.ErrnoException).code !== 'ENOENT'; return }
      for (const name of names) if (name.endsWith('.jsonl') && PERSONA_KEY_RE.test(name.slice(0, -6))) readKey(name.slice(0, -6))
    },
    journalFacts,
    completedStores() {
      return new Map([...journals].filter(([, j]) => j.created && j.readable && j.header !== undefined).map(([key, j]) =>
        [key, { storeId: j.header!.storeId, lastRecordNumber: j.highWater }]))
    },
    async activate() {
      if (stopped || quiesced) return
      activationStarted = true
      api.readAtStart()
      if (listingFailed) for (const key of options.appliedKeys()) if (!journals.has(key)) readKey(key)
      // Keep startup evidence ahead of stamp filtering, repair and removal.
      options.seal?.judgeAtStart(journalFacts())
      if (listingFailed) await options.seal?.refreshAtStart(journalFacts())
      if (stopped || quiesced) return
      await Promise.all([removeUnappliedAtStart(), ...options.appliedKeys().map(key => activateKey(key))])
    },
    async loadKey(key) {
      pathFor(key)
      if (!workAllowed(key)) return
      activationStarted = true
      const previous = journals.get(key)
      if (previous?.live && (previous.readable || previous.missing)) return
      forgotten.delete(key)
      // A never-created, non-hybrid store needs no journal read. Only a
      // confirmed absence can skip it; existing/unknown stores still retry.
      let absent = false
      if (!previous?.exists && previous?.readable !== false && !options.markerKeys().includes(key) && !options.threadHybridChannels(key).length && !options.seal?.entryKeys().includes(key)) {
        try { fs.lstatSync(pathFor(key)) } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ENOENT' }
      }
      if (!absent) readKey(key)
      const loaded = journals.get(key)
      if (loaded) options.seal?.judgeFirstRead(key, journalFact(loaded))
      await activateKey(key)
      api.retryPendingJoins(key)
    },
    retryRead(key) {
      const j = journals.get(key)
      // Startup loads precede the shared authority and activation. Keep the
      // retry alive without I/O until activation can judge the loaded facts.
      if (j && !j.readable && !activationStarted && workAllowed(key) && !forgotten.has(key)) return Promise.resolve('unreadable')
      if (!j || !current(key, j) || j.readable) return Promise.resolve('read')
      return serial(key, () => {
        if (!current(key, j) || j.readable) return 'read'
        if (j.missing) return 'missing'
        const result = readKey(key, true, false)
        if (result !== 'read') return result
        options.seal?.judgeFirstRead(key, journalFact(j))
        replay(key, j)
        event({ type: 'read', key, path: pathFor(key), firstSuccessfulRead: true })
        return 'read'
      })
    },
    outage(key) {
      const j = journals.get(key)
      if (!j) return { unknown: false, unsaved: 0, missing: false }
      const kept = j.kept.filter(fact => recoveryStamp(key, fact) !== 'stale' || named(key, fact.channel, fact.stamp))
      const pending = (pendingJoins.get(key) ?? []).filter(fact => !savedJoin(j, fact) &&
        (recoveryStamp(key, fact) !== 'stale' || named(key, fact.channel, fact.stamp)))
      const creation = !j.created && (j.creationHeader !== undefined || (j.readable && (j.hasRecords || options.threadHybridChannels(key).length > 0)))
      const posts = j.writes.reduce((count, write) => count + write.records.filter(record => record.kind !== 'join').length, 0)
      return { unknown: !j.readable, unsaved: kept.length + posts + pending.length + Number(creation) + (options.unsavedOwnPosts?.(key) ?? 0), missing: j.missing === true }
    },
    published() {
      if (stopped || quiesced) return
      const settling = [...journals].filter(([key, j]) => j.kept.length > 0 || pendingJoins.has(key))
      const deferredPosts = [...journals].filter(([key]) => (options.unsavedOwnPosts?.(key) ?? 0) > 0)
      for (const [key, j] of journals) if (workAllowed(key) && j.live) judge(key, j)
      for (const key of [...pendingJoins.keys()]) api.retryPendingJoins(key)
      // Recovery has added any needed joins before observing stale removals.
      // A queued append stays unsaved until saveKept observes its durable end.
      for (const [key, j] of settling) observeSettled(key, j)
      // The owner settles unstamped posts on its publication microtask. Check
      // after that turn: a discarded post needs no append to signal recovery,
      // while a handed-off intent remains counted by this journal's writer.
      for (const [key, j] of deferredPosts) {
        void Promise.resolve().then(() => serial(key, () => observeSettled(key, j))).catch(() => {})
      }
      // Promise-chain turns run after the synchronous publisher releases its
      // mutation lock; a marker setter must never run inside that publisher.
      for (const key of options.appliedKeys()) {
        if (!workAllowed(key) || forgotten.has(key)) continue
        const j = journal(key)
        if (!j.live) {
          if (options.threadHybridChannels(key).length) void Promise.resolve().then(() => {
            if (workAllowed(key) && !forgotten.has(key) && journals.get(key) === j) return api.loadKey(key)
          }).catch(() => {})
          continue
        }
        if (!j.created && options.threadHybridChannels(key).length) void serial(key, () => createStore(key, j)).catch(() => {})
        // An own-post join/outcome batch can have waited for a decided stamp.
        // Publication resumes it off the publisher's stack; failed saves
        // retain their existing background retry owner and spacing.
        if (j.readable && !j.failed && j.writes.some(write => write.records.some(record => record.kind !== 'join'))) {
          void serial(key, async () => {
            // An earlier writer can fail after this publication queued us.
            if (!j.failed) await saveKept(key, j)
          }).catch(() => {})
        }
      }
    },
    view(key, channel, root) {
      const stamp = options.stamp(key, channel), j = journals.get(key)
      if (stamp?.kind === 'undecided') return 'not-joined'
      if (stamp?.kind !== 'decided' || !stamp.threadHybridSince || !j?.live) return 'not-joined'
      if (j.joinedByChannel.get(channel)?.get(root)?.has(stampKey({ incarnation: stamp.incarnation, threadHybridSince: stamp.threadHybridSince }))) return 'joined'
      return j.readable ? 'not-joined' : 'unknown'
    },
    addJoin,
    saveJoins(key, facts) {
      const copy = facts.map(copyThreadJoin)
      for (const fact of copy) addJoin(key, fact)
      const j = journals.get(key)
      return j ? serial(key, () => saveKept(key, j, copy)) : Promise.resolve({ kind: 'cancelled' })
    },
    isJoinSaved(key, fact) { const j = journals.get(key); return !!j?.live && memoryStampMatches(fact.stamp, options.stamp(key, fact.channel)) && savedJoin(j, fact) },
    // Intake requires a current stamp; retention below can use saved evidence
    // before the shared authority exists.
    hasSavedJoin: (key, channel, root, stamp) => sameChannelStamp(stamp, options.stamp(key, channel)) && savedAt(key, channel, root, stamp) !== undefined,
    threadJoinSaved(key, channel, root, stamp, at) {
      if (journals.get(key)?.readable === false) return false
      const saved = savedAt(key, channel, root, stamp)
      if (saved !== undefined && saved <= at) return true
      const held = journals.get(key)?.heldJoins.get(channel)?.get(root)?.get(stampKey(stamp))?.saved
      if (held && sameChannelStamp(held.stamp, { kind: 'decided', ...stamp }) && held.at <= at) return true
      return recoveryStamp(key, { channel, root, stamp, at, source: 'mention' }) === 'stale' && !named(key, channel, stamp)
    },
    joinedBy(key, channel, root, stamp, at) {
      const j = journals.get(key)
      if (!j?.live || !j.readable) return 'unknown'
      if (!stamp || !stamp.incarnation || !stamp.threadHybridSince) return false
      // A readable journal is not a complete answer while a qualifying queue
      // join still awaits a decided stamp. Publication recovers it before
      // the hold resolver retries, including when its stamp has become stale.
      if (pendingJoins.get(key)?.some(fact => fact.channel === channel && fact.root === root &&
        sameChannelStamp(fact.stamp, { kind: 'decided', ...stamp }) && fact.at <= at)) return 'unknown'
      const known = entry(j, { channel, root, stamp, at, source: 'mention' })
      return !!known && sameChannelStamp(known.join.stamp, { kind: 'decided', ...stamp }) && known.join.at <= at
    },
    pruneHeldJoins,
    recoverJoins,
    retryPendingJoins: key => recoverJoins(key, []),
    keptFacts: key => structuredClone(journals.get(key)?.kept ?? []),
    joins(key) {
      const j = journals.get(key)
      if (!j) return []
      return structuredClone([...j.joinedByChannel.values()].flatMap(roots => [...roots.values()].flatMap(entries => [...entries.values()].map(value =>
        ({ join: value.join, ...(value.saved ? { savedAt: value.saved.at } : {}) })))))
    },
    isApplied: key => { const j = journals.get(key); return !options.dryRun && !!j && current(key, j) },
    channelStamp: (key, channel) => options.stamp(key, channel),
    digestKey: key => { const j = journals.get(key); return j?.readable ? (j.header ?? j.creationHeader)?.digestKey : undefined },
    saveBlocked: key => journals.get(key)?.failed === true && api.outage(key).unsaved > 0,
    keepIntent,
    resolveIntent,
    unresolvedIntents(key, channel) {
      const j = journals.get(key)
      const intents = channel === undefined ? j?.intents : j?.intentsByChannel.get(channel)
      return [...intents?.values() ?? []].map(intent => j?.savedIntents.has(intent.operationId)
        ? structuredClone(j.savedIntents.get(intent.operationId)!) : ({
        operationId: intent.operationId, channel: intent.channel, ...(intent.root === undefined ? {} : { root: intent.root }),
        at: intent.at, stamp: { ...intent.stamp }, ...(intent.digest === undefined ? {} : { digest: intent.digest }),
      }))
    },
    hasKeptJoin: (key, channel, root) => journals.get(key)?.kept.some(fact => fact.channel === channel && fact.root === root && memoryStampMatches(fact.stamp, options.stamp(key, channel))) ?? false,
    intentSaved: (key, operationId) => journals.get(key)?.savedIntents.has(operationId) ?? false,
    memoryOnlyOwnPostJoins(key) {
      const j = journals.get(key), pairs = new Map<string, { channel: string; root: string }>()
      if (j) for (const [operationId, fact] of j.ownJoins) {
        if (j.savedIntents.has(operationId) || savedJoin(j, fact) || recoveryStamp(key, fact) === 'stale') continue
        pairs.set(JSON.stringify([fact.channel, fact.root]), { channel: fact.channel, root: fact.root })
      }
      return [...pairs.values()]
    },
    store(key) {
      const j = journals.get(key)
      return j ? { storeId: j.header?.storeId, digestKey: j.header?.digestKey, lastRecordNumber: j.highWater, readable: j.readable, created: j.created } : undefined
    },
    readFacts: key => ({ error: journals.get(key)?.error, quarantined: structuredClone(journals.get(key)?.quarantined ?? []) }),
    clock(key) { pathFor(key); const at = Math.max(now(), (clocks.get(key) ?? -Infinity) + 1); clocks.set(key, at); return at },
    advancePast,
    flush(key) { const j = journals.get(key); return j ? serial(key, () => saveKept(key, j)) : Promise.resolve({ kind: 'cancelled' }) },
    compact,
    forget(key) { forgotten.add(key); journals.delete(key); pendingJoins.delete(key) },
    remove, removeUnappliedAtStart,
    startMaintenance(intervalMs) {
      if (stopped || quiesced || timer !== undefined) return
      timer = (options.setInterval ?? globalThis.setInterval)(() => { void compact().catch(() => {}) }, intervalMs ?? options.compactIntervalMs ?? QUEUE_COMPACT_INTERVAL_MS)
      timer.unref?.()
    },
    async quiesce() {
      quiesced = true
      await Promise.allSettled([...writers.values()])
    },
    async stop() {
      await api.quiesce()
      stopped = true
      if (timer !== undefined) (options.clearInterval ?? globalThis.clearInterval)(timer)
      timer = undefined
    },
  }
  return api
}
