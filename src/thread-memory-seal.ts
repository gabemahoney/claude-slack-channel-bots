/** Thread Memory's shared durable seal. No I/O until an explicit lifecycle call. */
import { testSyncWorkStart, testSyncWorkEnd } from './test-stall-attribution.ts'
import * as nodeFs from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { durableWriteFileSync, DurableWriteUnsyncedError } from './atomic-write.ts'
import { PERSONA_KEY_RE } from './persona-identity.ts'
import { CHANNEL_ID_RE } from './config.ts'
import { isThreadTimestamp } from './delivery-decision.ts'

export const THREAD_MEMORY_SEAL_FILE = 'thread-memory-seal.json'
const QUEUE_HASH_CHUNK_BYTES = 64 * 1024
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** Decimal strings preserve bigint stat precision, including file size. */
export type ThreadMemoryQueueIdentity =
  | { size: '0'; sha256: string; inode?: never; mtimeNs?: never }
  | { size: string; sha256: string; inode: string; mtimeNs: string }
export interface ThreadMemoryStoreIdentity { storeId: string; lastRecordNumber: number }
export interface ThreadMemoryOwnPostJoin { channel: string; root: string }
type OptionalStoreIdentity = ThreadMemoryStoreIdentity | { storeId?: never; lastRecordNumber?: never }
/** Omit both identity fields unless creation completed and the journal is readable. */
export type ThreadMemoryShutdownEntry = OptionalStoreIdentity & {
  memoryOnlyJoins?: readonly ThreadMemoryOwnPostJoin[]
}
export type ThreadMemorySealEntry =
  | (OptionalStoreIdentity & { clean: false; queue?: never } & (
    | { gracefulShutdown: true; memoryOnlyJoins?: readonly ThreadMemoryOwnPostJoin[] }
    | { gracefulShutdown?: never; memoryOnlyJoins?: never }
  ))
  | (ThreadMemoryStoreIdentity & { clean: true; queue: ThreadMemoryQueueIdentity; memoryOnlyJoins?: readonly ThreadMemoryOwnPostJoin[] })
export interface ThreadMemorySealFile { v: 1; entries: Record<string, ThreadMemorySealEntry> }
export type ThreadMemoryJournalFact =
  | { kind: 'absent' | 'not-created' | 'unreadable' }
  // A damaged header can leave valid records but no store ID until repair.
  | { kind: 'read'; storeId?: string; lastRecordNumber: number }
export type ThreadMemoryJournalFacts = ReadonlyMap<string, ThreadMemoryJournalFact>
export type ThreadMemorySealCase =
  | 'unclean-stop' | 'journal-missing' | 'journal-changed' | 'entry-missing'
  | 'hybrid-without-store' | 'marker-without-store' | 'queue-changed'
export interface ThreadMemoryChangedFinding {
  key: string; case: ThreadMemorySealCase; wording: 'unclean' | 'changed'
}
export interface ThreadMemoryOwnPostLossFinding {
  key: string; case: 'own-post-joins-lost'; threads: readonly ThreadMemoryOwnPostJoin[]
}
export type ThreadMemorySealFinding = ThreadMemoryChangedFinding | ThreadMemoryOwnPostLossFinding
export type ThreadMemorySealWriteResult =
  | { kind: 'written' | 'skipped' | 'stopped' }
  | { kind: 'failed'; error: unknown; unsynced: boolean }
export type ThreadMemorySealEvent =
  | { type: 'seal-read-failed' | 'seal-invalid'; path: string; error: unknown }
  | { type: 'queue-identity-failed'; key: string; phase: 'start' | 'shutdown'; error: unknown }
  | { type: 'seal-written'; path: string }
  | { type: 'seal-write-failed'; path: string; error: unknown; unsynced: boolean }
  | ({ type: 'changed-while-stopped' } & ThreadMemoryChangedFinding)
  | ({ type: 'own-post-joins-lost' } & ThreadMemoryOwnPostLossFinding)

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k))
const decimal = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)
function validQueueIdentity(v: unknown): v is ThreadMemoryQueueIdentity {
  if (!object(v) || !only(v, ['size', 'sha256', 'inode', 'mtimeNs']) || !decimal(v.size) ||
      typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256)) return false
  if (!Object.hasOwn(v, 'inode') && !Object.hasOwn(v, 'mtimeNs')) return v.size === '0' && v.sha256 === EMPTY_SHA256
  return decimal(v.inode) && typeof v.mtimeNs === 'string' && /^(0|-?[1-9][0-9]*)$/.test(v.mtimeNs)
}
export function isThreadMemorySealEntry(v: unknown): v is ThreadMemorySealEntry {
  if (!object(v)) return false
  const hasIdentity = Object.hasOwn(v, 'storeId') || Object.hasOwn(v, 'lastRecordNumber')
  if ((hasIdentity || v.clean === true) && (typeof v.storeId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(v.storeId) ||
      typeof v.lastRecordNumber !== 'number' || !Number.isSafeInteger(v.lastRecordNumber) || v.lastRecordNumber < 0)) return false
  return v.clean === true
    ? only(v, ['storeId', 'lastRecordNumber', 'clean', 'queue', 'memoryOnlyJoins']) && validQueueIdentity(v.queue) &&
      (!Object.hasOwn(v, 'memoryOnlyJoins') || validMemoryOnlyJoins(v.memoryOnlyJoins))
    : v.clean === false && (v.gracefulShutdown === true
      ? only(v, ['storeId', 'lastRecordNumber', 'clean', 'gracefulShutdown', 'memoryOnlyJoins']) &&
        (!Object.hasOwn(v, 'memoryOnlyJoins') || validMemoryOnlyJoins(v.memoryOnlyJoins))
      : only(v, ['storeId', 'lastRecordNumber', 'clean']))
}
function validMemoryOnlyJoins(value: unknown): value is ThreadMemoryOwnPostJoin[] {
  if (!Array.isArray(value)) return false
  const pairs = new Set<string>()
  return value.every(item => {
    if (!object(item) || !only(item, ['channel', 'root']) || typeof item.channel !== 'string' ||
        !CHANNEL_ID_RE.test(item.channel) || !isThreadTimestamp(item.root)) return false
    const pair = JSON.stringify([item.channel, item.root])
    if (pairs.has(pair)) return false
    pairs.add(pair)
    return true
  })
}
/** Closed schemas keep arbitrary content out of this metadata-only file. */
export function isThreadMemorySealFile(v: unknown): v is ThreadMemorySealFile {
  return object(v) && v.v === 1 && only(v, ['v', 'entries']) && object(v.entries) &&
    Object.entries(v.entries).every(([key, entry]) => PERSONA_KEY_RE.test(key) && isThreadMemorySealEntry(entry))
}
export function serializeThreadMemorySeal(file: ThreadMemorySealFile): Buffer {
  if (!isThreadMemorySealFile(file)) throw new Error('Invalid Thread Memory seal')
  const entries = Object.fromEntries(Object.entries(file.entries).map(([key, entry]) => {
    const { memoryOnlyJoins, ...identity } = entry
    const sorted = memoryOnlyJoins?.map(({ channel, root }) => ({ channel, root }))
      .sort((a, b) => a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : a.root < b.root ? -1 : a.root > b.root ? 1 : 0)
    return [key, { ...identity, ...(sorted?.length ? { memoryOnlyJoins: sorted } : {}) }]
  }))
  return Buffer.from(JSON.stringify({ v: file.v, entries }) + '\n')
}
export function queueIdentitiesMatch(a: ThreadMemoryQueueIdentity, b: ThreadMemoryQueueIdentity): boolean {
  return a.inode === b.inode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.sha256 === b.sha256
}
function runningEntry(entry: ThreadMemorySealEntry): ThreadMemorySealEntry {
  return entry.storeId === undefined ? { clean: false }
    : { storeId: entry.storeId, lastRecordNumber: entry.lastRecordNumber, clean: false }
}
/** Graceful shutdown's running entry keeps known memory-only joins. Its marker
 * certifies only that the list came from graceful shutdown, never the store. */
function shutdownRunningEntry(identity: ThreadMemoryShutdownEntry): ThreadMemorySealEntry {
  const list = identity.memoryOnlyJoins?.length ? { gracefulShutdown: true as const, memoryOnlyJoins: identity.memoryOnlyJoins } : {}
  return identity.storeId === undefined ? { clean: false, ...list }
    : { storeId: identity.storeId, lastRecordNumber: identity.lastRecordNumber, clean: false, ...list }
}
export interface JudgeSealInput {
  key: string; previous?: ThreadMemorySealEntry; journal: ThreadMemoryJournalFact
  queue?: ThreadMemoryQueueIdentity; threadHybrid: boolean; created: boolean
  sealExisted: boolean; anyUnclean: boolean
}
/** First applicable SR-2.4.4 case wins. Unknown queue identity proves no change. */
export function judgeSeal(input: JudgeSealInput): ThreadMemoryChangedFinding | undefined {
  const { previous, journal } = input
  const finding = (reason: ThreadMemorySealCase, unclean = false): ThreadMemoryChangedFinding =>
    ({ key: input.key, case: reason, wording: unclean ? 'unclean' : 'changed' })
  if (previous && !previous.clean) return finding('unclean-stop', true)
  if (previous && (journal.kind === 'absent' || journal.kind === 'not-created')) return finding('journal-missing')
  if (previous && journal.kind === 'read' &&
      (journal.storeId !== previous.storeId || journal.lastRecordNumber < previous.lastRecordNumber)) return finding('journal-changed')
  if (!previous && journal.kind !== 'absent') return finding('entry-missing')
  if (!previous && journal.kind === 'absent') {
    if (input.sealExisted && input.threadHybrid) return finding('hybrid-without-store', input.anyUnclean)
    if (input.created) return finding('marker-without-store')
  }
  if (previous?.clean && input.queue && !queueIdentitiesMatch(previous.queue, input.queue)) return finding('queue-changed')
  return undefined
}

export interface ThreadMemorySealShared {
  appliedKeys(): readonly string[]
  threadHybrid(key: string): boolean
  created(key: string): boolean
}
export interface ThreadMemorySealOptions extends ThreadMemorySealShared {
  stateDir: string; fs?: typeof nodeFs
  queueJournalPath(key: string): string
  /** Each successful open of an existing queue journal, before it is read (SR-2.1.3). */
  onQueueJournalOpened?(key: string): void
  onEvent?(event: ThreadMemorySealEvent): void
}
/** Optional port consumed by Thread Memory; the seal owns its shared writer. */
export interface ThreadMemorySealPort {
  entryCreated(key: string, storeId: string, lastRecordNumber: number): Promise<ThreadMemorySealWriteResult>
  entryCompacted(key: string, storeId: string, lastRecordNumber: number): Promise<ThreadMemorySealWriteResult>
  removeEntry(key: string): Promise<ThreadMemorySealWriteResult>
  entryKeys(): readonly string[]
  judgeAtStart(journals?: ThreadMemoryJournalFacts): void
  judgeFirstRead(key: string, journal: ThreadMemoryJournalFact): void
  refreshAtStart(journals: ThreadMemoryJournalFacts): Promise<ThreadMemorySealWriteResult>
}
export interface ThreadMemorySeal extends ThreadMemorySealPort {
  readonly path: string
  queueIdentity(key: string): ThreadMemoryQueueIdentity
  loadAtStart(journals: ThreadMemoryJournalFacts): Promise<ThreadMemorySealWriteResult>
  loadedAtStart(): boolean
  startupFindings(): readonly ThreadMemorySealFinding[]
  writeShutdown(entries: ReadonlyMap<string, ThreadMemoryShutdownEntry>): Promise<ThreadMemorySealWriteResult>
  flush(): Promise<ThreadMemorySealWriteResult>
  stop(): Promise<void>
}

export function createThreadMemorySeal(options: ThreadMemorySealOptions): ThreadMemorySeal {
  const fs = options.fs ?? nodeFs, path = join(options.stateDir, THREAD_MEMORY_SEAL_FILE)
  const previous = new Map<string, ThreadMemorySealEntry>(), entries = new Map<string, ThreadMemorySealEntry>()
  const queues = new Map<string, ThreadMemoryQueueIdentity>(), findings = new Map<string, ThreadMemorySealFinding>()
  const unreadableAtStart = new Set<string>()
  let journals: ThreadMemoryJournalFacts = new Map()
  let loaded = false, judged = false, sealExisted = false, stopped = false, emptyWriteNeeded = false
  let chain: Promise<unknown> = Promise.resolve(), queued: Promise<ThreadMemorySealWriteResult> | undefined
  let loadResult: Promise<ThreadMemorySealWriteResult> | undefined
  function event(e: ThreadMemorySealEvent): void {
    try { void Promise.resolve(options.onEvent?.(e)).catch(() => {}) } catch { /* observers cannot change durable outcomes */ }
  }
  function checkKey(key: string): void {
    if (!PERSONA_KEY_RE.test(key)) throw new Error('Invalid Thread Memory persona key')
  }
  function failed(error: unknown): ThreadMemorySealWriteResult {
    const unsynced = error instanceof DurableWriteUnsyncedError
    event({ type: 'seal-write-failed', path, error, unsynced })
    return { kind: 'failed', error, unsynced }
  }
  function requestWrite(shutdown = false): Promise<ThreadMemorySealWriteResult> {
    if (stopped) return Promise.resolve({ kind: 'stopped' })
    if (!shutdown) for (const [key, entry] of entries) {
      if (entry.clean) {
        const { memoryOnlyJoins: _joins, ...identity } = entry
        entries.set(key, identity)
      } else entries.set(key, runningEntry(entry))
    }
    if (queued) return queued
    if (!entries.size && !emptyWriteNeeded) return Promise.resolve({ kind: 'skipped' })
    const next = chain.catch(() => {}).then((): ThreadMemorySealWriteResult => {
      queued = undefined
      const writeStart = testSyncWorkStart()
      try {
        const bytes = serializeThreadMemorySeal({ v: 1, entries: Object.fromEntries(entries) })
        durableWriteFileSync(path, bytes, fs)
        emptyWriteNeeded = false
        event({ type: 'seal-written', path })
        return { kind: 'written' }
      } catch (error) { return failed(error) }
      finally { testSyncWorkEnd(writeStart, 'thread-seal-write') }
    })
    queued = next; chain = next
    return next
  }
  function queueIdentity(key: string): ThreadMemoryQueueIdentity {
    const syncStart = testSyncWorkStart()
    try {
      checkKey(key)
      let fd: number
      try { fd = fs.openSync(options.queueJournalPath(key), 'r') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { size: '0', sha256: EMPTY_SHA256 }
        throw error
      }
      try { options.onQueueJournalOpened?.(key) } catch { /* an observer cannot change the identity */ }
      try {
        const stat = fs.fstatSync(fd, { bigint: true }), hash = createHash('sha256'), buffer = Buffer.alloc(QUEUE_HASH_CHUNK_BYTES)
        for (;;) {
          const length = fs.readSync(fd, buffer, 0, buffer.length, null)
          if (length === 0) break
          hash.update(buffer.subarray(0, length))
        }
        return { inode: stat.ino.toString(), size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(), sha256: hash.digest('hex') }
      } finally { fs.closeSync(fd) }
    } finally { testSyncWorkEnd(syncStart, 'thread-seal-queue-identity', key) }
  }
  function readPrevious(): void {
    let bytes: string
    try { bytes = fs.readFileSync(path, 'utf8'); sealExisted = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      sealExisted = true
      event({ type: 'seal-read-failed', path, error }); return
    }
    try {
      const value: unknown = JSON.parse(bytes)
      if (!isThreadMemorySealFile(value)) throw new Error('Invalid Thread Memory seal')
      for (const [key, entry] of Object.entries(value.entries)) previous.set(key, entry)
    } catch (error) { event({ type: 'seal-invalid', path, error }) }
  }
  function runningEntries(facts: ThreadMemoryJournalFacts): void {
    journals = new Map(facts)
    entries.clear()
    for (const key of new Set([...previous.keys(), ...facts.keys()])) {
      checkKey(key)
      const fact = facts.get(key), old = previous.get(key)
      if (fact?.kind === 'read' && fact.storeId !== undefined) {
        entries.set(key, { storeId: fact.storeId, lastRecordNumber: fact.lastRecordNumber, clean: false })
      } else if (fact?.kind === 'unreadable' && old) {
        entries.set(key, runningEntry(old))
      }
    }
    if (previous.size || [...facts.values()].some(fact => fact.kind !== 'absent')) emptyWriteNeeded = true
  }
  function record(finding: ThreadMemoryChangedFinding | undefined): void {
    if (!finding || findings.has(finding.key)) return
    findings.set(finding.key, finding)
    event({ type: 'changed-while-stopped', ...finding })
  }
  function updateEntry(key: string, storeId: string, lastRecordNumber: number): Promise<ThreadMemorySealWriteResult> {
    if (stopped) return Promise.resolve({ kind: 'stopped' })
    checkKey(key)
    const entry: ThreadMemorySealEntry = { storeId, lastRecordNumber, clean: false }
    if (!isThreadMemorySealEntry(entry)) return Promise.resolve(failed(new Error('Invalid Thread Memory seal entry')))
    entries.set(key, entry)
    return requestWrite()
  }
  return {
    path, queueIdentity,
    loadAtStart(facts) {
      if (loadResult) return loadResult
      if (stopped) return Promise.resolve({ kind: 'stopped' })
      readPrevious()
      for (const [key, entry] of previous) if (entry.clean) {
        try { queues.set(key, queueIdentity(key)) }
        catch (error) { event({ type: 'queue-identity-failed', key, phase: 'start', error }) }
      }
      runningEntries(facts)
      loaded = true
      loadResult = requestWrite()
      return loadResult
    },
    loadedAtStart: () => loaded,
    refreshAtStart(facts) {
      if (!loaded || stopped) return Promise.resolve({ kind: 'stopped' })
      runningEntries(facts)
      return requestWrite()
    },
    judgeAtStart(facts) {
      if (!loaded || judged) return
      judged = true
      if (facts) journals = new Map(facts)
      const anyUnclean = [...previous.values()].some(entry => !entry.clean)
      for (const key of options.appliedKeys()) {
        const old = previous.get(key)
        if (old?.memoryOnlyJoins?.length) {
          const finding: ThreadMemoryOwnPostLossFinding = { key, case: 'own-post-joins-lost', threads: structuredClone(old.memoryOnlyJoins) }
          findings.set(`own-post:${key}`, finding)
          event({ type: 'own-post-joins-lost', ...finding })
        }
        const journal = journals.get(key) ?? { kind: 'absent' }
        if (journal.kind === 'unreadable') unreadableAtStart.add(key)
        record(judgeSeal({ key, previous: previous.get(key), journal, queue: queues.get(key),
          sealExisted, anyUnclean, threadHybrid: options.threadHybrid(key), created: options.created(key) }))
      }
    },
    judgeFirstRead(key, journal) {
      if ((journal.kind !== 'read' && journal.kind !== 'not-created') ||
          !unreadableAtStart.delete(key) || !options.appliedKeys().includes(key)) return
      const old = previous.get(key)
      // Judge an empty readable journal before creation gives it a new identity.
      if (old && journal.kind === 'not-created') {
        record({ key, case: 'journal-missing', wording: 'changed' })
      } else if (old?.storeId !== undefined && journal.kind === 'read' &&
          (journal.storeId !== old.storeId || journal.lastRecordNumber < old.lastRecordNumber)) {
        record({ key, case: 'journal-changed', wording: 'changed' })
      }
    },
    startupFindings: () => structuredClone([...findings.values()]),
    entryKeys: () => [...new Set([...previous.keys(), ...entries.keys()])],
    entryCreated: updateEntry,
    entryCompacted: updateEntry,
    removeEntry(key) {
      if (stopped) return Promise.resolve({ kind: 'stopped' })
      checkKey(key)
      const existed = entries.delete(key) || previous.has(key)
      if (existed) emptyWriteNeeded = true
      return requestWrite()
    },
    async writeShutdown(snapshots) {
      if (!loaded || stopped) return { kind: 'stopped' }
      for (const [key, entry] of entries) entries.set(key, runningEntry(entry))
      let identityFailure: { error: unknown } | undefined
      for (const [key, identity] of snapshots) {
        checkKey(key)
        if (identity.storeId === undefined) {
          // An unreadable or incomplete journal supplies no certified identity.
          if (entries.has(key) || identity.memoryOnlyJoins?.length) entries.set(key, shutdownRunningEntry(identity))
          continue
        }
        try { entries.set(key, { ...identity, clean: true, queue: queueIdentity(key) }) }
        catch (error) {
          identityFailure = { error }
          // An unknown queue identity can't seal clean; the running entry still names the joins.
          entries.set(key, shutdownRunningEntry(identity))
          event({ type: 'queue-identity-failed', key, phase: 'shutdown', error })
        }
      }
      const result = await requestWrite(true)
      return result.kind !== 'failed' && identityFailure ? failed(identityFailure.error) : result
    },
    flush: requestWrite,
    async stop() { stopped = true; await chain },
  }
}
