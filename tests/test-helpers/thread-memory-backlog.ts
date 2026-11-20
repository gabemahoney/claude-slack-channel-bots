import { appendFile } from 'node:fs/promises'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createThreadMemory, serializeThreadMemoryRecords, type ThreadMemoryCompaction } from '../../src/thread-memory.ts'
import { createThreadMemorySeal } from '../../src/thread-memory-seal.ts'
import { createTestMeasurements, threadCompactionMeasurement, TEST_MEASUREMENTS_FILE_NAME } from '../../src/test-measurements.ts'
import { createFakeClock } from './fake-clock.ts'
import { makeQueue, queuePath, slackInput } from './delivery-queue.ts'
import { makeSharedAuthority } from './shared-channels.ts'
import { joinRecord, readThreads, seedThreads, threadConfig, threadFsControls, threadHeader, threadJoin, threadPath, threadSealFsControls, THREAD_CHANNELS, THREAD_ROOTS } from './thread-memory.ts'

/** Production memory, seal and queue, with independent writers and one injected clock.
 * This fixture belongs only to the SR-9.11 Thread Memory regression cases. */
export async function makeBacklogMemory(keys: string[] = ['alpha']) {
  const stateDir = mkdtempSync(join(tmpdir(), 'thread-memory-backlog-'))
  const clock = createFakeClock(), io = threadFsControls(stateDir), sealIo = threadSealFsControls(stateDir)
  const queueIo = threadFsControls(stateDir), queue = await makeQueue(stateDir, { fs: queueIo.fs, now: clock.now })
  const memoryHolds: Array<{ release(): void }> = [], holdMemory = io.hold
  io.hold = (...args) => { const gate = holdMemory(...args); memoryHolds.push(gate); return gate }
  clock.settleOn(io.durable); clock.settleOn(sealIo.durable); clock.settleOn(queueIo.durable)
  const authority = makeSharedAuthority(stateDir, threadConfig(stateDir, 'thread_hybrid', keys), { now: clock.now })
  let rootNumber = 0
  const fact = (key = 'alpha') => {
    const stamp = authority.channelStamp(key, THREAD_CHANNELS.primary)
    if (stamp?.kind !== 'decided' || !stamp.threadHybridSince) throw new Error('fixture needs a decided stamp')
    return threadJoin({ stamp: { incarnation: stamp.incarnation, threadHybridSince: stamp.threadHybridSince },
      root: rootNumber++ === 0 ? THREAD_ROOTS.primary : `1700000000.${String(200000 + rootNumber).padStart(6, '0')}` })
  }
  for (const key of keys) seedThreads(stateDir, [threadHeader(), joinRecord(fact(key))], key)
  const seal = createThreadMemorySeal({ stateDir, fs: sealIo.fs, queueJournalPath: key => queuePath(stateDir, key),
    appliedKeys: () => keys, threadHybrid: () => true, created: key => authority.threadMemoryCreated(key) })
  const sealCalls: Array<{ key: string; steps: string[] }> = []
  const entryCompacted = seal.entryCompacted.bind(seal)
  seal.entryCompacted = (...args) => {
    sealCalls.push({ key: args[0], steps: io.calls.filter(c => ['writeSync', 'fsync', 'rename'].includes(c.op)).map(c => `${c.op}:${c.path}`) })
    return entryCompacted(...args)
  }
  const measurementsPath = join(stateDir, TEST_MEASUREMENTS_FILE_NAME)
  const measurements = createTestMeasurements({ path: measurementsPath, timers: clock, monotonicNow: clock.now, log() {}, fs: {
    appendFile, appendFileSync,
  } })
  type Interval = { timer: unknown; stopped: boolean; unref(): void }
  const memory = createThreadMemory({ stateDir, fs: io.fs, seal, now: clock.now, monotonicNow: clock.now,
    maintenanceClock: clock, joinSaveClock: clock,
    acceptanceBacklog: { has: key => queue.hasAcceptanceBacklog!(key), onCleared: (key, callback) => queue.onAcceptanceBacklogCleared!(key, callback) },
    setInterval: ((callback: () => void, ms: number) => {
      const handle: Interval = { timer: undefined, stopped: false, unref() {} }
      const tick = () => { if (!handle.stopped) { callback(); handle.timer = clock.setTimeout(tick, ms) } }
      handle.timer = clock.setTimeout(tick, ms)
      return handle
    }) as unknown as typeof setInterval,
    clearInterval: ((handle: Interval) => { handle.stopped = true; clock.clearTimeout(handle.timer) }) as unknown as typeof clearInterval,
    appliedKeys: () => keys, stamp: (key, channel) => authority.channelStamp(key, channel), stampFacts: () => authority.stampFacts(),
    authorityReady: () => true, heldStamps: key => queue.memoryHoldStamps!(key),
    threadHybridChannels: key => authority.threadView().threadHybridChannels(key), markerKeys: () => authority.threadMemoryCreatedKeys(),
    setCreated: key => authority.setThreadMemoryCreated(key), clearCreated: key => authority.clearThreadMemoryCreated(key),
  })
  const completed: ThreadMemoryCompaction[] = [], waiters: Array<{ key: string; count: number; resolve(): void }> = []
  memory.setCompactionObserver(c => {
    completed.push(c); measurements.record(threadCompactionMeasurement(c))
    for (const w of [...waiters]) if (completed.filter(c => c.key === w.key).length >= w.count) { waiters.splice(waiters.indexOf(w), 1); w.resolve() }
  })
  const holds: Array<{ release(): void; pending: Promise<unknown> }> = []
  return { stateDir, clock, io, queueIo, queue, authority, memory, seal, sealIo, sealCalls, completed, measurements, measurementsPath, fact,
    async start() { memory.readAtStart(); await seal.loadAtStart(memory.journalFacts()); await memory.activate() },
    async dirty(key = 'alpha') { return memory.saveJoins(key, [fact(key)]) },
    reset() { io.reset(); sealIo.reset(); sealCalls.length = 0; completed.length = 0 },
    completion(key = 'alpha', count = completed.filter(c => c.key === key).length + 1) {
      if (completed.filter(c => c.key === key).length >= count) return Promise.resolve()
      return new Promise<void>(resolve => { waiters.push({ key, count, resolve }) })
    },
    async backlog(key = 'alpha') {
      const gate = queueIo.hold('fsync', key, { match: path => path === queuePath(stateDir, key) })
      const pending = queue.accept(key, slackInput())
      holds.push({ release: gate.release, pending }); await gate.reached
      return { ...gate, pending }
    },
    image(key = 'alpha') {
      const [header, ...records] = readThreads(stateDir, key)
      if (header?.kind !== 'header') throw new Error('fixture needs a header')
      return serializeThreadMemoryRecords([{ ...header, highWater: Math.max(header.highWater, memory.store(key)?.lastRecordNumber ?? 0, ...records.map(r => r.seq)) }, ...records])
    },
    bytes: (key = 'alpha') => readFileSync(threadPath(stateDir, key)),
    async close() {
      for (const hold of memoryHolds) hold.release()
      for (const hold of holds) hold.release()
      await Promise.all(holds.map(h => h.pending)); await memory.stop(); await queue.stop(); await seal.stop(); await measurements.stop()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}
