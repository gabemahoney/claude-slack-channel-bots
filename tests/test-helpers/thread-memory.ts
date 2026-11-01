/** Thread Memory fixtures over production records, real files and the shared authority. */
import * as fs from 'node:fs'
import { join } from 'node:path'
import { durableWriteFileSync, DurableWriteUnsyncedError } from '../../src/atomic-write.ts'
import { createDeliveryQueue, type DeliveryQueueOptions } from '../../src/delivery-queue.ts'
import {
  createThreadMemorySeal, isThreadMemorySealFile, serializeThreadMemorySeal, THREAD_MEMORY_SEAL_FILE,
  type ThreadMemorySealEntry, type ThreadMemorySealFile, type ThreadMemorySealEvent, type ThreadMemoryOwnPostJoin,
} from '../../src/thread-memory-seal.ts'
import { queuePath } from './delivery-queue.ts'
import type { OwnPostJoins } from '../../src/own-post.ts'
import type { DeliveryMode, PersonaConfigInput } from '../../src/config.ts'
import { createSharedChannelAuthority, type SharedChannelAuthority, type SharedChannelDeps } from '../../src/shared-channels.ts'
import {
  createThreadMemory, isThreadMemoryRecord, parseThreadMemoryRecord, serializeThreadMemoryRecords,
  THREAD_MEMORY_DIRECTORY_MODE, THREAD_MEMORY_FILE_MODE,
  type ThreadJoin, type ThreadJoinRecord, type ThreadMemoryHeader, type ThreadMemoryRecord,
  type ThreadPostIntent, type ThreadPostOutcome, type ThreadMemoryOptions, type ThreadMemoryEvent,
} from '../../src/thread-memory.ts'
import { createFakeClock, type FakeClock } from './fake-clock.ts'
import { makePersona, makePersonaConfigInput } from './persona-config.ts'
import { createThreadMemoryRetries, type ThreadMemoryRetries, type ThreadMemoryRetryEvent } from '../../src/thread-memory-retry.ts'
import { createThreadMemoryReporting } from '../../src/thread-memory-reports.ts'
import { createPersonaEpisodes } from '../../src/persona-episodes.ts'
import { formatPersonaNotice } from '../../src/persona-notifier.ts'
import {
  SHARED_CHANNEL_IDS, configBytes, makeSharedAuthority, readSharedState,
  sharedChannelPath, sharedRecoveryRequest, makeMembershipHarness, membershipPage,
} from './shared-channels.ts'

export const THREAD_PERSONAS = { primary: 'alpha', secondary: 'beta' } as const
export const THREAD_CHANNELS = SHARED_CHANNEL_IDS
export const THREAD_ROOTS = { primary: '1700000000.000001', secondary: '1700000000.000002', third: '1700000000.000003' } as const
export const THREAD_TIME = 1_700_000_000_000
export const THREAD_STAMP = { incarnation: 'fixture-life', threadHybridSince: 'fixture-since' }
/** The Slack timestamp `ms` milliseconds after the epoch; own-post issue times are wall-clock milliseconds. */
export const slackTsOfMs = (ms: number): string => (ms / 1000).toFixed(6)
export const threadPath = (dir: string, key: string = THREAD_PERSONAS.primary): string => join(dir, 'threads', `${key}.jsonl`)
/** A removed assignment no longer carries the old fixture counter. Include the
 * durable revision on restart so it cannot mint that forgotten stamp again. */
function restartMint(revision: number) {
  let n = 0
  return () => `thread-memory-restart-${revision}-${++n}`
}
export const threadHeader = (overrides: Partial<ThreadMemoryHeader> = {}): ThreadMemoryHeader =>
  ({ v: 1, kind: 'header', seq: 1, storeId: 'fixture-store', digestKey: 'ab'.repeat(32), highWater: 1, ...overrides })
export const threadJoin = (overrides: Partial<ThreadJoin> = {}): ThreadJoin =>
  ({ channel: THREAD_CHANNELS.primary, root: THREAD_ROOTS.primary, stamp: { ...THREAD_STAMP }, source: 'mention', at: THREAD_TIME, ...overrides })
export const joinRecord = (fact: ThreadJoin, seq = 2): ThreadJoinRecord => ({ ...fact, v: 1, kind: 'join', seq })
export const postIntent = (fact: ThreadJoin, overrides: Partial<ThreadPostIntent> = {}): ThreadPostIntent =>
  ({ v: 1, kind: 'post-intent', seq: 3, operationId: 'fixture-post', channel: fact.channel, root: fact.root, stamp: fact.stamp, at: fact.at, digest: 'cd'.repeat(32), ...overrides })
export const postOutcome = (intent: ThreadPostIntent, outcome: ThreadPostOutcome['outcome'] = 'joined', seq = intent.seq + 1): ThreadPostOutcome =>
  ({ v: 1, kind: 'post-outcome', operationId: intent.operationId, seq, outcome })

/** All damage starts with a production-serialized record. UTF-8 damage is exact bytes. */
export function damagedThreadLine(record: ThreadMemoryRecord, kind: 'json' | 'utf8' | 'torn' | 'torn-utf8' | 'invalid-header'): Buffer {
  if (kind === 'invalid-header') return serializeThreadMemoryRecords([{ ...record, digestKey: 'invalid' } as ThreadMemoryRecord])
  const bytes = serializeThreadMemoryRecords([record])
  if (kind === 'json') return Buffer.concat([bytes.subarray(0, -2), Buffer.from(',\n')])
  if (kind === 'utf8') return Buffer.concat([bytes.subarray(0, -2), Buffer.from([0xff, 0x7d, 0x0a])])
  if (kind === 'torn-utf8') return Buffer.concat([bytes.subarray(0, -2), Buffer.from([0xf0, 0x9f])])
  return bytes.subarray(0, -2)
}
export function seedThreads(dir: string, records: readonly (ThreadMemoryRecord | Buffer)[], key: string = THREAD_PERSONAS.primary): Buffer {
  const bytes = Buffer.concat(records.map(record => {
    if (Buffer.isBuffer(record)) return record
    if (!isThreadMemoryRecord(record)) throw new Error('seedThreads: invalid production record')
    return serializeThreadMemoryRecords([record])
  }))
  fs.mkdirSync(join(dir, 'threads'), { recursive: true, mode: THREAD_MEMORY_DIRECTORY_MODE })
  fs.writeFileSync(threadPath(dir, key), bytes, { mode: THREAD_MEMORY_FILE_MODE })
  return bytes
}
export function readThreads(dir: string, key: string = THREAD_PERSONAS.primary): ThreadMemoryRecord[] {
  return fs.readFileSync(threadPath(dir, key), 'utf8').split('\n').filter(Boolean).map(line => {
    const record = parseThreadMemoryRecord(line)
    if (!record) throw new Error('readThreads: invalid production record')
    return record
  })
}

export type ThreadFsOperation = 'openSync' | 'readFileSync' | 'readdirSync' | 'writeSync' | 'fsyncSync' | 'renameSync' | 'unlinkSync' | 'ftruncateSync' | 'readSync' | 'fstatSync' | 'closeSync'
export interface ThreadFsCall { op: string; path: string; flags?: string | number; length?: number }
export function threadFsControls(dir: string) {
  const calls: ThreadFsCall[] = [], descriptors = new Map<number, string>()
  const faults: Array<{ op: ThreadFsOperation; path: (path: string) => boolean; error: Error; left: number }> = []
  const invoke = (op: string, args: unknown[]) => {
    const path = typeof args[0] === 'number' ? descriptors.get(args[0]) ?? '<unknown-fd>' : String(args[0])
    calls.push({ op, path, ...(op === 'openSync' ? { flags: args[1] as string | number } : {}),
      ...(op === 'readSync' ? { length: args[3] as number } : {}) })
    const fault = faults.find(f => f.op === op && f.left > 0 && f.path(path))
    if (fault) { fault.left--; throw fault.error }
    const value = Reflect.apply(Reflect.get(fs, op), fs, args)
    if (op === 'openSync') descriptors.set(value as number, path)
    if (op === 'closeSync') descriptors.delete(args[0] as number)
    return value
  }
  const seam = new Proxy({ ...fs }, { get(target, property) {
    const value = Reflect.get(target, property)
    return typeof property === 'string' && property.endsWith('Sync') && typeof value === 'function'
      ? (...args: unknown[]) => invoke(property, args) : value
  } }) as typeof fs
  return {
    fs: seam, calls,
    fail(op: ThreadFsOperation, key: string = THREAD_PERSONAS.primary, options: { times?: number; code?: string; match?: (path: string) => boolean } = {}) {
      const path = threadPath(dir, key)
      const error = Object.assign(new Error(`fixture ${op} refused`), { code: options.code ?? 'EIO' })
      faults.push({ op, path: options.match ?? (p => p === path || p.startsWith(`${path}.`) || p.startsWith(join(dir, 'threads', `${key}.unreadable-`))), error, left: options.times ?? Infinity })
      return error
    },
    heal() { faults.length = 0 },
    removeJournal(key: string = THREAD_PERSONAS.primary) { fs.unlinkSync(threadPath(dir, key)) },
    reset() { calls.length = 0 },
    writes() { return calls.filter(c => ['writeSync', 'ftruncateSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'chmodSync', 'fchmodSync'].includes(c.op) || (c.op === 'openSync' && c.flags !== 'r')) },
  }
}

export const threadSealPath = (dir: string) => join(dir, THREAD_MEMORY_SEAL_FILE)
export const runningSealEntry = (overrides: Partial<Pick<ThreadMemorySealEntry, 'storeId' | 'lastRecordNumber'>> = {}) =>
  ({ storeId: overrides.storeId ?? threadHeader().storeId, lastRecordNumber: overrides.lastRecordNumber ?? threadHeader().highWater, clean: false as const })
export function cleanSealEntry(dir: string, key = THREAD_PERSONAS.primary as string, overrides: Parameters<typeof runningSealEntry>[0] = {}): Extract<ThreadMemorySealEntry, { clean: true }> {
  const seal = createThreadMemorySeal({ stateDir: dir, queueJournalPath: k => queuePath(dir, k),
    appliedKeys: () => [], threadHybrid: () => false, created: () => false })
  return { ...runningSealEntry(overrides), clean: true, queue: seal.queueIdentity(key) }
}
export function seedThreadSeal(dir: string, entries: ThreadMemorySealFile['entries'] = {}): Buffer {
  const bytes = serializeThreadMemorySeal({ v: 1, entries })
  fs.writeFileSync(threadSealPath(dir), bytes)
  return bytes
}
export function readThreadSeal(dir: string): ThreadMemorySealFile {
  const value: unknown = JSON.parse(fs.readFileSync(threadSealPath(dir), 'utf8'))
  if (!isThreadMemorySealFile(value)) throw new Error('readThreadSeal: invalid production seal')
  return value
}
export function cleanOwnPostSealEntry(dir: string, threads: readonly ThreadMemoryOwnPostJoin[], key = THREAD_PERSONAS.primary as string, overrides: Parameters<typeof runningSealEntry>[0] = {}): ThreadMemorySealEntry {
  const clean = cleanSealEntry(dir, key, overrides)
  if (!clean.clean) throw new Error('fixture needs a clean seal entry')
  return { ...clean, memoryOnlyJoins: threads }
}
export type ThreadSealDamage = 'json' | 'version' | 'persona-key' | 'missing-queue'
  | 'running-own-posts' | 'own-post-channel' | 'own-post-root' | 'duplicate-own-post' | 'own-post-extra-key'
/** Corrupt exactly one property of a valid production-serialized seed. */
export function damagedThreadSeal(dir: string, kind: ThreadSealDamage): Buffer {
  const bytes = serializeThreadMemorySeal({ v: 1, entries: { alpha: cleanOwnPostSealEntry(dir, [{ channel: THREAD_CHANNELS.primary, root: THREAD_ROOTS.primary }]) } })
  if (kind === 'json') return bytes.subarray(0, -2)
  const value = JSON.parse(bytes.toString())
  if (kind === 'version') value.v++
  if (kind === 'persona-key') { value.entries['../invalid'] = value.entries.alpha; delete value.entries.alpha }
  if (kind === 'missing-queue') delete value.entries.alpha.queue
  if (kind === 'running-own-posts') { value.entries.alpha.clean = false; delete value.entries.alpha.queue }
  if (kind === 'own-post-channel') value.entries.alpha.memoryOnlyJoins[0].channel = 'invalid'
  if (kind === 'own-post-root') value.entries.alpha.memoryOnlyJoins[0].root = 'invalid'
  if (kind === 'duplicate-own-post') value.entries.alpha.memoryOnlyJoins.push({ ...value.entries.alpha.memoryOnlyJoins[0] })
  if (kind === 'own-post-extra-key') value.entries.alpha.memoryOnlyJoins[0].text = 'unexpected-content'
  return Buffer.from(JSON.stringify(value) + '\n')
}
export function threadSealFsControls(dir: string) {
  const io = threadFsControls(dir), path = threadSealPath(dir)
  return {
    ...io,
    failWrite(unsynced = false, times = Infinity) {
      return io.fail(unsynced ? 'fsyncSync' : 'writeSync', 'alpha', {
        times, match: p => unsynced ? p === dir : p.startsWith(`${path}.`),
      })
    },
    failRead() { return io.fail('readFileSync', 'alpha', { match: p => p === path }) },
    queueReads() { return io.calls.filter(c => c.path.startsWith(join(dir, 'queue') + '/') && ['openSync', 'fstatSync', 'readSync'].includes(c.op)) },
  }
}

function intervalTimers(clock: FakeClock) {
  type Handle = { timer: unknown; stopped: boolean; unref(): void }
  return {
    setInterval: ((callback: () => void, ms: number) => {
      const handle: Handle = { timer: undefined, stopped: false, unref() {} }
      const tick = () => { if (handle.stopped) return; callback(); handle.timer = clock.setTimeout(tick, ms) }
      handle.timer = clock.setTimeout(tick, ms)
      return handle
    }) as unknown as typeof globalThis.setInterval,
    clearInterval: ((handle: Handle) => { handle.stopped = true; clock.clearTimeout(handle.timer) }) as unknown as typeof globalThis.clearInterval,
  }
}
export function threadConfig(dir: string, delivery: DeliveryMode = 'thread_hybrid', names: readonly string[] = [THREAD_PERSONAS.primary], channels: readonly string[] = [THREAD_CHANNELS.primary]): PersonaConfigInput {
  return makePersonaConfigInput({ channel_mode: 'strict', personas: names.map(name => makePersona({ name,
    channels: channels.map(id => ({ id, delivery })), permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' },
  }, dir)) }, dir)
}
export interface ThreadHarnessOptions {
  authority?: SharedChannelAuthority; input?: PersonaConfigInput; reopen?: boolean; dryRun?: boolean; clock?: FakeClock
  now?: () => number; appliedKeys?: () => readonly string[]; canRemove?: (key: string) => boolean
  fs?: ReturnType<typeof threadFsControls>
  seal?: boolean | { fs?: ReturnType<typeof threadSealFsControls>; onEvent?: (event: ThreadMemorySealEvent) => void }
  queueOptions?: Omit<DeliveryQueueOptions, 'stateDir'>
  setCreated?: ThreadMemoryOptions['setCreated']; clearCreated?: ThreadMemoryOptions['clearCreated']
  heldStamps?: ThreadMemoryOptions['heldStamps']
  /** The same live work gate is shared by the store and its retry owner. */
  canRun?: ThreadMemoryOptions['canRun']
  /** Opt in to production retries/reporting; old store-only callers stay unchanged. */
  failureHandling?: boolean
}
export function makeThreadMemoryHarness(stateDir: string, options: ThreadHarnessOptions = {}) {
  const clock = options.clock ?? createFakeClock({ start: THREAD_TIME }), io = options.fs ?? threadFsControls(stateDir)
  let sharedFault: ((bytes: Uint8Array) => 'before' | 'unsynced' | undefined) | undefined
  const deps: SharedChannelDeps = { now: clock.now, write(path, bytes) {
    const failure = sharedFault?.(bytes)
    if (failure === 'before') throw Object.assign(new Error('fixture shared write refused'), { code: 'EIO' })
    durableWriteFileSync(path, bytes)
    if (failure === 'unsynced') throw new DurableWriteUnsyncedError(path, Object.assign(new Error('fixture directory sync refused'), { code: 'EIO' }))
  } }
  const saved = options.reopen ? readSharedState(stateDir)! : undefined
  const authority = options.authority ?? (saved
    ? createSharedChannelAuthority(sharedChannelPath(stateDir), saved, { ...deps, threadHybridSince: restartMint(saved.revision) })
    : makeSharedAuthority(stateDir, options.input ?? threadConfig(stateDir), deps))
  const events: ThreadMemoryEvent[] = [], markerCalls: Array<{ action: 'set' | 'clear'; key: string; fileExists: boolean; synced: boolean }> = []
  const posts: Array<{ key: string; text: string }> = [], logs: string[] = [], retryEvents: ThreadMemoryRetryEvent[] = []
  let ownPosts: Pick<OwnPostJoins, 'stop' | 'memoryOnlyJoins' | 'unsavedDeferredPosts'> | undefined
  let startup = false
  const bufferedSealEvents: ThreadMemorySealEvent[] = []
  let retries: ThreadMemoryRetries | undefined, reporting: ReturnType<typeof createThreadMemoryReporting> | undefined
  const episodes = options.failureHandling ? createPersonaEpisodes({ clock, log: line => logs.push(line),
    sink(key, text, noticeOptions) {
      const persona = authority.config().personas.find(p => p.key === key)
      if (!persona) throw new Error('fixture notice needs an applied persona')
      posts.push({ key, text: formatPersonaNotice(persona, text, noticeOptions) })
    },
  }) : undefined
  const sealOptions = typeof options.seal === 'object' ? options.seal : {}
  const sealIo = sealOptions.fs ?? threadSealFsControls(stateDir), sealEvents: ThreadMemorySealEvent[] = []
  const seal = options.seal ? createThreadMemorySeal({ stateDir, fs: sealIo.fs,
    queueJournalPath: key => queuePath(stateDir, key),
    appliedKeys: options.appliedKeys ?? (() => authority.config().personas.map(p => p.key)),
    threadHybrid: key => authority.threadView().threadHybridChannels(key).length > 0,
    created: key => authority.threadMemoryCreated(key),
    onEvent(event) {
      sealEvents.push(event)
      if (event.type === 'seal-write-failed') retries?.sealWriteFailed()
      if (startup) {
        if (event.type !== 'changed-while-stopped' && event.type !== 'own-post-joins-lost') bufferedSealEvents.push(event)
      } else reporting?.sealEvent(event)
      sealOptions.onEvent?.(event)
    },
  }) : undefined
  const queue = seal ? createDeliveryQueue({ stateDir, now: clock.now, ...intervalTimers(clock), ...options.queueOptions }) : undefined
  const memory = createThreadMemory({
    stateDir, fs: io.fs, now: options.now ?? clock.now, ...intervalTimers(clock), dryRun: options.dryRun, seal,
    appliedKeys: options.appliedKeys ?? (() => authority.config().personas.map(p => p.key)),
    stamp: (key, channel) => authority.channelStamp(key, channel),
    heldStamps: options.heldStamps,
    unsavedOwnPosts: key => ownPosts?.unsavedDeferredPosts(key) ?? 0,
    canRun: options.canRun,
    threadHybridChannels: key => authority.threadView().threadHybridChannels(key),
    markerKeys: () => authority.threadMemoryCreatedKeys(), canRemove: options.canRemove ?? (key => !authority.reviewHeld(key)),
    setCreated: key => {
      const syncs = io.calls.filter(c => c.op === 'fsyncSync').map(c => c.path), journalSync = syncs.lastIndexOf(threadPath(stateDir, key))
      const synced = journalSync >= 0 && syncs.slice(journalSync + 1).includes(join(stateDir, 'threads'))
      markerCalls.push({ action: 'set', key, fileExists: fs.existsSync(threadPath(stateDir, key)), synced })
      return options.setCreated?.(key) ?? authority.setThreadMemoryCreated(key)
    },
    clearCreated: key => {
      markerCalls.push({ action: 'clear', key, fileExists: fs.existsSync(threadPath(stateDir, key)), synced: false })
      return options.clearCreated?.(key) ?? authority.clearThreadMemoryCreated(key)
    },
    onEvent(event) {
      events.push(event)
      if (event.type === 'append-failed' || event.type === 'creation-failed') retries?.appendFailed(event.key)
      else if (event.type === 'read-failed') retries?.readFailed(event.key)
      reporting?.threadMemoryEvent(event)
    },
  })
  if (episodes) {
    reporting = createThreadMemoryReporting({ episodes, log: line => logs.push(line),
      persona: key => authority.config().personas.find(p => p.key === key),
      threadHybridChannels: key => authority.threadView().threadHybridChannels(key), outage: key => memory.outage(key),
    })
    retries = createThreadMemoryRetries({ clock, canRun: options.canRun, flush: key => memory.flush(key), retryRead: key => memory.retryRead(key),
      sealFlush: () => seal?.flush() ?? Promise.resolve({ kind: 'skipped' }),
      async firstRead(key, current) {
        if (!current()) return
        memory.retryPendingJoins(key)
        if (!current()) return
        const result = await memory.flush(key)
        if (current() && (result.kind === 'failed' || (result.kind === 'kept' && memory.outage(key).unsaved > 0))) retries?.appendFailed(key)
      },
      onEvent(event) { retryEvents.push(event); reporting?.retryEvent(event) },
    })
  }
  const unsubscribe = authority.subscribeThreadView(() => memory.published())
  const apply = (input: PersonaConfigInput) => authority.applyReviewed(configBytes(input), authority.revision)
  let closing: Promise<void> | undefined
  function close(clean: boolean) {
    return closing ??= (async () => {
      if (!seal) {
        retries?.stopKeys(); unsubscribe(); await memory.stop(); retries?.stopSeal(); episodes?.close(); return
      }
      ownPosts?.stop()
      await queue?.stop()
      retries?.stopKeys()
      await memory.quiesce()
      if (clean && seal?.loadedAtStart()) {
        const completed = memory.completedStores()
        await seal.writeShutdown(new Map([...memory.journalFacts().keys()].map(key => {
          const identity = completed.get(key) ?? {}
          let memoryOnlyJoins: { channel: string; root: string }[] = []
          try { memoryOnlyJoins = ownPosts?.memoryOnlyJoins(key) ?? [] } catch { /* isolate each key's snapshot */ }
          return [key, { ...identity, ...(memoryOnlyJoins.length ? { memoryOnlyJoins } : {}) }] as const
        })))
      }
      unsubscribe(); await memory.stop(); await seal?.stop()
      retries?.stopSeal(); episodes?.close()
    })()
  }
  return {
    stateDir, clock, io, authority, memory, events, markerCalls, unsubscribe, seal, sealIo, sealEvents, queue,
    retries, reporting, episodes, posts, logs, retryEvents,
    attachOwnPosts(owner: Pick<OwnPostJoins, 'stop' | 'memoryOnlyJoins' | 'unsavedDeferredPosts'>) { ownPosts = owner },
    async start() {
      startup = true
      memory.readAtStart()
      if (seal) {
        await seal.loadAtStart(memory.journalFacts())
        await queue?.start()
      }
      await memory.activate()
      startup = false
      for (const event of bufferedSealEvents.splice(0)) reporting?.sealEvent(event)
      if (seal) reporting?.startupFindings(seal.startupFindings())
      if (seal) memory.startMaintenance()
    },
    close: () => close(true),
    // Retire in-process timers/writers without the graceful shutdown seal.
    crash: () => close(false),
    fact(overrides: Partial<ThreadJoin> = {}, key: string = THREAD_PERSONAS.primary): ThreadJoin {
      const channel = overrides.channel ?? THREAD_CHANNELS.primary, stamp = authority.channelStamp(key, channel)
      if (stamp?.kind !== 'decided' || !stamp.threadHybridSince) throw new Error('fixture needs a decided thread_hybrid stamp')
      return threadJoin({ at: memory.clock(key), channel, stamp: { incarnation: stamp.incarnation, threadHybridSince: stamp.threadHybridSince }, ...overrides })
    },
    apply,
    choose(delivery: DeliveryMode, key: string = THREAD_PERSONAS.primary, channel: string = THREAD_CHANNELS.primary) {
      return authority.applyReviewed(authority.sourceBytes(), authority.revision, [{ key, channel, delivery }])
    },
    mode(channel_mode: 'open' | 'strict') { return apply({ ...authority.snapshot().source, channel_mode } as unknown as PersonaConfigInput) },
    failShared(write?: typeof sharedFault) { sharedFault = write },
    stageRestoration() {
      fs.writeFileSync(authority.path, Buffer.from('fixture unreadable shared evidence'))
      const bytes = fs.readFileSync(authority.path)
      return authority.stageRestoration(sharedRecoveryRequest('thread-memory-restore', bytes), bytes, authority.sourceBytes())
    },
    reopen(overrides: ThreadHarnessOptions = {}) { return makeThreadMemoryHarness(stateDir, { reopen: true, seal: !!seal, ...overrides }) },
  }
}
export type ThreadMemoryHarness = ReturnType<typeof makeThreadMemoryHarness>

/** Real event router and inventory scanner; every positive/absence is scripted explicitly. */
export function makeThreadMembershipHarness(stateDir: string, options: Parameters<typeof makeMembershipHarness>[1] = {}) {
  const membership = makeMembershipHarness(stateDir, { channels: [{ id: THREAD_CHANNELS.primary, delivery: 'thread_hybrid' }],
    ...(options.reopen ? { threadHybridSince: restartMint(readSharedState(stateDir)!.revision) } : {}), ...options })
  const threads = makeThreadMemoryHarness(stateDir, { authority: membership.authority, clock: membership.h.clock })
  const stub = (key: string = THREAD_PERSONAS.primary) => membership.h.stub(membership.h.p(key))
  return {
    ...threads, membership, stub,
    async start(channels: string[] = options.channels?.map(c => c.id) ?? [THREAD_CHANNELS.primary]) {
      await threads.start()
      for (const persona of membership.h.config!.personas) stub(persona.key).script.inventory.push(membershipPage(channels))
      await membership.start(); await membership.scan()
    },
    async close() { await threads.close(); await membership.close() },
  }
}
