import { describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttributionMeasurement } from '../src/test-stall-attribution.ts'
import type { QueueEvent } from '../src/delivery-queue.ts'
import type { DurableAppendTiming } from '../src/durable-journal.ts'
import type { AckTiming } from '../src/persona-routing.ts'
import type { PostHoldEvent } from '../src/post-holds.ts'
import {
  TEST_MEASUREMENTS_FILE_NAME, TEST_MEASUREMENTS_FLUSH_MS, TEST_MEASUREMENTS_STOP_WAIT_MS,
  buildTestMeasurementsStartLine, buildTestMeasurementsWriteFailedLine, buildTestMeasurementsStopIncompleteLine,
  createTestMeasurements, postHoldEventMeasurement, queueEventMeasurement, serializeTestMeasurement,
  ackTimingMeasurement, durableAppendMeasurement, threadSaveMeasurement, threadCompactionMeasurement,
  type StoreMeasurement, type TestMeasurement, type TestMeasurementRecord, type TestMeasurementsDeps,
} from '../src/test-measurements.ts'
import { assertNoLeak, BOT_TOKEN_PREFIX, fakeToken, LEAK_SENTINEL, sentinelInMessage, writtenFile } from './test-helpers/credentials.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { hostSafeChildEnv } from './test-helpers/host-safe-env.ts'

function store(seq = 1): StoreMeasurement {
  return { kind: 'store', key: 'reader', seq, store: 'accepted', store_ms: 2.5, at_mono_ms: 123.75 }
}

function harness(overrides: Partial<TestMeasurementsDeps> = {}) {
  const clock = createFakeClock({ start: 900.5 })
  const calls: Array<{ sync: boolean; path: string; data: string; mode: number }> = []
  const written: string[] = [], logs: string[] = []
  const metadata: Array<{ op: string; size?: number }> = []
  const entered = Promise.withResolvers<void>()
  let bytes = Buffer.alloc(0)
  let failure: unknown, rollbackFailure: unknown, partial: 'prefix' | 'line' | undefined
  let pending: Promise<void> | undefined, rollbackPending: Promise<void> | undefined
  function write(data: string) {
    if (failure) {
      if (partial) bytes = Buffer.concat([bytes, Buffer.from(data.slice(0, partial === 'prefix' ? 20 : data.indexOf('\n') + 1))])
      throw failure
    }
    bytes = Buffer.concat([bytes, Buffer.from(data)])
    written.push(data)
  }
  const recorder = createTestMeasurements({
    path: join(tmpdir(), TEST_MEASUREMENTS_FILE_NAME), timers: clock, monotonicNow: clock.now,
    log: line => { logs.push(line) },
    fs: {
      async appendFile(path, data, options) {
        calls.push({ sync: false, path, data, ...options })
        entered.resolve()
        if (pending) await pending
        write(data)
      },
      appendFileSync(path, data, options) {
        calls.push({ sync: true, path, data, ...options })
        write(data)
      },
      async stat() { metadata.push({ op: 'stat' }); return { size: bytes.length } },
      statSync() { metadata.push({ op: 'statSync' }); return { size: bytes.length } },
      async truncate(_path, size) {
        metadata.push({ op: 'truncate', size })
        if (rollbackPending) await rollbackPending
        if (rollbackFailure) throw rollbackFailure
        bytes = bytes.subarray(0, size)
      },
      truncateSync(_path, size) {
        metadata.push({ op: 'truncateSync', size })
        if (rollbackFailure) throw rollbackFailure
        bytes = bytes.subarray(0, size)
      },
    },
    ...overrides,
  })
  return { recorder, clock, calls, written, logs, metadata, entered: entered.promise,
    fail(error?: unknown, prefix?: 'prefix' | 'line') { failure = error; partial = prefix },
    failRollback(error?: unknown) { rollbackFailure = error },
    hold(write?: Promise<void>) { pending = write },
    holdRollback(rollback?: Promise<void>) { rollbackPending = rollback },
    bytes: () => Buffer.from(bytes),
    records: (): TestMeasurementRecord[] => bytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  }
}

describe('test-only measurement records (Decision 25)', () => {
  test('the schema has exactly ten kinds; the filename, flush delay and loud line are exported', () => {
    const kinds: Record<TestMeasurement['kind'], true> = { store: true, 'resolution-store': true, 'post-hold-resolved': true, ack: true, append: true, 'thread-save': true, 'thread-compaction': true, 'post-hold-timing': true, 'event-loop-stall': true, 'sync-work': true }
    expect(Object.keys(kinds)).toEqual(['store', 'resolution-store', 'post-hold-resolved', 'ack', 'append', 'thread-save', 'thread-compaction', 'post-hold-timing', 'event-loop-stall', 'sync-work'])
    expect(TEST_MEASUREMENTS_FILE_NAME).toBe('test-measurements.jsonl')
    expect(TEST_MEASUREMENTS_FLUSH_MS).toBe(250)
    expect(TEST_MEASUREMENTS_STOP_WAIT_MS).toBe(1_000)
    const path = join(tmpdir(), 'configured path', TEST_MEASUREMENTS_FILE_NAME)
    const line = buildTestMeasurementsStartLine(path)
    expect(line).toBe(`[slack] WARNING: test-only measurement record is ON (${path}); not for production use`)
    expect(buildTestMeasurementsStopIncompleteLine(path, 2, 'write failed')).toBe(
      `[slack] test-only measurement record: shutdown incomplete for ${JSON.stringify(path)} (write failed); 2 records not confirmed written, kept in memory only; unwritten records will be lost on process exit`,
    )
    assertNoLeak(line)
  })

  test('attribution rows preserve their observed monotonic times and omit unrelated fields', async () => {
    const h = harness()
    const entries: AttributionMeasurement[] = [
      { kind: 'post-hold-timing', key: 'reader', seq: 7, phase: 'callback', received_mono_ms: 1, due_mono_ms: 3001, armed_delay_ms: 3000, at_mono_ms: 3010 },
      { kind: 'sync-work', key: 'reader', work: 'thread-judge', start_mono_ms: 2990, end_mono_ms: 3010, at_mono_ms: 3010 },
      { kind: 'event-loop-stall', start_mono_ms: 2990, end_mono_ms: 3010, at_mono_ms: 3010, expected_mono_ms: 3000,
        gap_ms: 10, elapsed_ms: 20, cpu_user_usec: 1, cpu_system_usec: 2, cpu_stat: null, cpu_stat_delta: null,
        cpu_stat_before_mono_ms: 2990, heap_before: null, heap_after: null,
        resource_delta: { minorPageFault: 1, majorPageFault: 0, voluntaryContextSwitches: 2, involuntaryContextSwitches: 3, fsRead: 4, fsWrite: 5 },
        resource_before_mono_ms: 2990, system_sampling: 'stall-end', system_before_mono_ms: 2500, system_after_mono_ms: 3010,
        pressure: { cpu: { some: 100, full: 0 }, memory: null, io: null }, pressure_delta: { cpu: { some: 10, full: 0 }, memory: null, io: null },
        memory_current: 100, memory_max: 'max', memory_stat: { anon: 70, workingset_refault_file: 4 }, memory_stat_delta: { anon: -2, workingset_refault_file: 1 },
        host_steal_ticks: 90, host_steal_delta_ticks: 1 },
    ]
    for (const entry of entries) { const contaminated = { ...entry, body: LEAK_SENTINEL }; h.recorder.record(contaminated) }
    await h.recorder.stop()
    expect(h.records()).toEqual(entries.map(entry => ({ v: 1, ...entry, process_id: process.pid })))
    assertNoLeak(h.bytes().toString())
    expect(h.bytes().toString()).not.toContain(LEAK_SENTINEL)
  })

  const rows: Array<{ name: string; event: QueueEvent | PostHoldEvent; entry: TestMeasurement }> = [
    ...(['accepted', 'post-hold', 'memory-hold'] as const).map(kind => ({
      name: kind,
      event: { type: 'stored' as const, key: 'reader', seq: 7, store: kind, storeMs: 2.5, atMonoMs: 123.75 },
      entry: { kind: 'store' as const, key: 'reader', seq: 7, store: kind, store_ms: 2.5, at_mono_ms: 123.75 },
    })),
    { name: 'fixed', event: { type: 'fixed-stored', key: 'reader', seq: 7, storeMs: 4.5, atMonoMs: 150.25 },
      entry: { kind: 'store', key: 'reader', seq: 7, store: 'fixed', store_ms: 4.5, at_mono_ms: 150.25 } },
    { name: 'resolution-store', event: { type: 'holds-resolved', key: 'reader', resolutions: [{ seq: 7, outcome: 'released', at: 999 }, { seq: 8, outcome: 'withdrawn', at: 999 }], storeMs: 1.25, atMonoMs: 170.5 },
      entry: { kind: 'resolution-store', key: 'reader', seqs: [7, 8], store_ms: 1.25, at_mono_ms: 170.5 } },
    { name: 'post-hold timer', event: { kind: 'post-hold-resolved', key: 'reader', seq: 7, outcome: 'parked', cause: 'timer', heldMs: 2000.5 },
      entry: { kind: 'post-hold-resolved', key: 'reader', seq: 7, outcome: 'parked', cause: 'timer', held_ms: 2000.5 } },
    { name: 'post-hold restart', event: { kind: 'post-hold-resolved', key: 'reader', seq: 8, outcome: 'released', cause: 'restart' },
      entry: { kind: 'post-hold-resolved', key: 'reader', seq: 8, outcome: 'released', cause: 'restart' } },
  ]

  test.each(rows)('$name: one exact allowlisted line, event completion time or record-time clock, without content', async ({ event, entry }) => {
    const h = harness()
    const extra = { text: `message-${LEAK_SENTINEL}`, channel: `C${LEAK_SENTINEL}`, user: `U${LEAK_SENTINEL}`,
      token: fakeToken(BOT_TOKEN_PREFIX, 'measurement'), path: `path-${LEAK_SENTINEL}` }
    const input = { ...event, ...extra }
    const mapped = 'type' in input ? queueEventMeasurement(input) : postHoldEventMeasurement(input)
    expect(mapped).toEqual(entry)
    assertNoLeak(mapped)
    // Also poison the serializer input, independently of the mapper's allowlist.
    expect(h.recorder.record({ ...mapped!, ...extra })).toBeUndefined()
    await h.clock.advance(17)
    await h.recorder.flush()
    const expected: TestMeasurementRecord = { v: 1, ...entry, at_mono_ms: 'at_mono_ms' in entry ? entry.at_mono_ms : 900.5 }
    expect(h.records()).toEqual([expected])
    const line = h.written[0]!
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n')).toHaveLength(2)
    expect(Object.keys(JSON.parse(line)).slice(0, 3)).toEqual(['v', 'kind', 'at_mono_ms'])
    expect(serializeTestMeasurement({ ...expected, ...extra })).toBe(line.trimEnd())
    if (entry.kind === 'post-hold-resolved' && entry.cause === 'restart') expect(line).not.toContain('held_ms')
    assertNoLeak({ calls: h.calls, logs: h.logs, written: h.written })
    await h.recorder.stop()
  })

  const stateDir = join(tmpdir(), 'cscb state')
  const appendTiming = (journalDir: string, file: string): DurableAppendTiming => ({
    dir: join(stateDir, journalDir), path: join(stateDir, journalDir, file), records: 3, bytes: 412,
    appendMs: 9.5, fileFsyncMs: 6.25, dirFsyncMs: 2.5, fsyncs: 2, atMonoMs: 140.5,
  })
  const ackTiming: AckTiming = { keys: ['reader', 'writer'], ts: '1730000000.000100', targets: [{ key: 'reader', seq: 7 }, { key: 'writer', seq: 2 }],
    outcome: 'acked', receiveToAckMs: 812.5, ackCallMs: 0.75, atMonoMs: 130.25 }
  const sourceRows: Array<{ name: string; entry: TestMeasurement; mapped: (extra: Record<string, unknown>) => TestMeasurement | undefined }> = [
    { name: 'ack', mapped: () => ackTimingMeasurement(ackTiming),
      entry: { kind: 'ack', keys: ['reader', 'writer'], ts: '1730000000.000100', targets: [{ key: 'reader', seq: 7 }, { key: 'writer', seq: 2 }],
        outcome: 'acked', receive_to_ack_ms: 812.5, ack_call_ms: 0.75, at_mono_ms: 130.25 } },
    { name: 'suppressed ack', mapped: () => ackTimingMeasurement({ keys: ['reader'], targets: [], outcome: 'suppressed', receiveToAckMs: 4, atMonoMs: 131 }),
      entry: { kind: 'ack', keys: ['reader'], targets: [], outcome: 'suppressed', receive_to_ack_ms: 4, at_mono_ms: 131 } },
    { name: 'queue append', mapped: () => durableAppendMeasurement(appendTiming('queue', 'reader.jsonl'), stateDir),
      entry: { kind: 'append', journal: 'queue', key: 'reader', records: 3, bytes: 412, append_ms: 9.5, file_fsync_ms: 6.25, dir_fsync_ms: 2.5, fsyncs: 2, at_mono_ms: 140.5 } },
    { name: 'Thread Memory append', mapped: () => durableAppendMeasurement(appendTiming('threads', 'reader.jsonl'), stateDir),
      entry: { kind: 'append', journal: 'thread-memory', key: 'reader', records: 3, bytes: 412, append_ms: 9.5, file_fsync_ms: 6.25, dir_fsync_ms: 2.5, fsyncs: 2, at_mono_ms: 140.5 } },
    { name: 'thread-save', mapped: () => threadSaveMeasurement({ key: 'reader', records: 3, joins: 1, intents: 1, outcomes: 1 }),
      entry: { kind: 'thread-save', key: 'reader', records: 3, joins: 1, intents: 1, outcomes: 1 } },
    ...(['rewritten', 'skipped'] as const).map(outcome => ({
      name: `thread-compaction ${outcome}`,
      mapped: (extra: Record<string, unknown>) => threadCompactionMeasurement({ ...extra, key: 'reader', startMonoMs: 120.25,
        writeStartMonoMs: 125, endMonoMs: 140.5, outcome }),
      entry: { kind: 'thread-compaction' as const, key: 'reader', start_mono_ms: 120.25, end_mono_ms: 140.5, outcome, at_mono_ms: 140.5,
        ...(outcome === 'rewritten' ? { write_start_mono_ms: 125 } : {}) },
    })),
  ]

  test.each(sourceRows)('$name: one exact allowlisted line from its source fact, without content', async ({ entry, mapped }) => {
    let clockReads = 0
    const h = harness({ monotonicNow: () => { clockReads++; return 900.5 } })
    const extra = { text: `message-${LEAK_SENTINEL}`, channel: `C${LEAK_SENTINEL}`, user: `U${LEAK_SENTINEL}`,
      token: fakeToken(BOT_TOKEN_PREFIX, 'measurement'), path: `path-${LEAK_SENTINEL}`, dir: `dir-${LEAK_SENTINEL}`, write_start_mono_ms: 125 }
    const entryOf = mapped(extra)
    expect(entryOf).toEqual(entry)
    h.recorder.record({ ...entryOf!, ...extra })
    await h.recorder.flush()
    // ack, append and compaction carry their own completion time; thread-save takes the record-time clock.
    const expected: TestMeasurementRecord = { v: 1, ...entry, at_mono_ms: 'at_mono_ms' in entry ? entry.at_mono_ms : 900.5 }
    expect(h.records()).toEqual([expected])
    const line = h.written[0]!
    expect(Object.keys(JSON.parse(line)).slice(0, 3)).toEqual(['v', 'kind', 'at_mono_ms'])
    expect(serializeTestMeasurement({ ...expected, ...extra })).toBe(line.trimEnd())
    if (entry.kind === 'thread-compaction') {
      expect(Object.keys(JSON.parse(line))).toEqual(['v', 'kind', 'at_mono_ms', 'key', 'start_mono_ms', 'end_mono_ms', 'outcome',
        ...(entry.outcome === 'rewritten' ? ['write_start_mono_ms'] : [])])
      expect(line.endsWith('\n')).toBe(true)
      expect(line.split('\n')).toHaveLength(2)
      expect(clockReads).toBe(0)
    }
    if (entry.kind === 'ack' && entry.outcome === 'suppressed') { expect(line).not.toContain('ack_call_ms'); expect(line).not.toContain('"ts"') }
    assertNoLeak({ calls: h.calls, logs: h.logs, written: h.written })
    await h.recorder.stop()
  })

  test('an ack ts not in Slack form, and ack target extras, are left out; the observer input is copied', () => {
    for (const ts of ['', 'abc', `1.${LEAK_SENTINEL}`, '1730000000', '1730000000.0001000', ` 1730000000.000100`]) {
      expect(ackTimingMeasurement({ ...ackTiming, ts })).not.toHaveProperty('ts')
    }
    const keys = ['reader'], targets = [{ key: 'reader', seq: 1, text: LEAK_SENTINEL }]
    const entry = ackTimingMeasurement({ keys, targets, outcome: 'ack-failed', receiveToAckMs: 1, ackCallMs: 2, atMonoMs: 3 })
    expect(entry).toEqual({ kind: 'ack', keys: ['reader'], targets: [{ key: 'reader', seq: 1 }], outcome: 'ack-failed', receive_to_ack_ms: 1, ack_call_ms: 2, at_mono_ms: 3 })
    keys.push('other'); targets.push({ key: 'other', seq: 2, text: '' })
    expect(entry.keys).toEqual(['reader'])
    expect(entry.targets).toEqual([{ key: 'reader', seq: 1 }])
    assertNoLeak(entry)
  })

  test.each([
    ['a queue quarantine file', appendTiming('queue', 'reader.unreadable')],
    ['a Thread Memory quarantine file', appendTiming('threads', 'reader.jsonl.unreadable')],
    ['another journal directory', appendTiming('other', 'reader.jsonl')],
    ['a nested path', { ...appendTiming('queue', 'reader.jsonl'), path: join(stateDir, 'queue', 'nested', 'reader.jsonl') }],
    ['an invalid persona key', appendTiming('queue', 'Reader-1.jsonl')],
    ['another state directory', { ...appendTiming('queue', 'reader.jsonl'), dir: join(tmpdir(), 'other', 'queue'), path: join(tmpdir(), 'other', 'queue', 'reader.jsonl') }],
  ] as const)('%s gives no append measurement', (_, timing) => {
    expect(durableAppendMeasurement(timing, stateDir)).toBeUndefined()
  })

  test.each(['storeMs', 'atMonoMs', 'seq', 'store'] as const)('an untimed/incomplete stored event lacking %s is ignored', missing => {
    const event: QueueEvent = { type: 'stored', key: 'reader', seq: 1, store: 'accepted', storeMs: 0, atMonoMs: 0 }
    delete event[missing]
    expect(queueEventMeasurement(event)).toBeUndefined()
  })

  test('only saved, timed queue facts and saved Post Hold resolutions map; zero timings remain valid', () => {
    expect(queueEventMeasurement({ type: 'stored', key: 'reader', seq: 0, store: 'accepted', storeMs: 0, atMonoMs: 0 }))
      .toEqual({ kind: 'store', key: 'reader', seq: 0, store: 'accepted', store_ms: 0, at_mono_ms: 0 })
    for (const fields of [{}, { storeMs: 0 }, { atMonoMs: 0 }]) {
      expect(queueEventMeasurement({ type: 'holds-resolved', key: 'reader', resolutions: [], ...fields })).toBeUndefined()
    }
    expect(queueEventMeasurement({ type: 'writable', key: 'reader' })).toBeUndefined()
    expect(postHoldEventMeasurement({ kind: 'post-hold-save-failed', key: 'reader', seqs: [1] })).toBeUndefined()
    expect(postHoldEventMeasurement({ kind: 'post-hold-resolved', key: 'reader', seq: 1, outcome: 'released', cause: 'thread', heldMs: 0 }))
      .toEqual({ kind: 'post-hold-resolved', key: 'reader', seq: 1, outcome: 'released', cause: 'thread', held_ms: 0 })
  })

  test('record is synchronous and does no I/O, even after yielding; one timer flush appends every record in order', async () => {
    const h = harness()
    expect(h.calls).toEqual([])
    expect(h.metadata).toEqual([])
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.recorder.record(store(1))).toBeUndefined()
    expect(h.recorder.record(store(2))).toBeUndefined()
    await h.clock.flush()
    expect(h.calls).toEqual([])
    expect(h.metadata).toEqual([])
    expect(h.clock.pending().map(timer => timer.delayMs)).toEqual([TEST_MEASUREMENTS_FLUSH_MS])
    await h.clock.advance(TEST_MEASUREMENTS_FLUSH_MS - 1)
    expect(h.calls).toEqual([])
    expect(h.metadata).toEqual([])
    await h.clock.advance(1)
    expect(h.calls).toEqual([{ sync: false, path: join(tmpdir(), TEST_MEASUREMENTS_FILE_NAME), data: h.written[0]!, mode: 0o600 }])
    expect(h.records()).toEqual([1, 2].map(seq => ({ v: 1, ...store(seq) })))
    expect(h.clock.pendingCount()).toBe(0)
    await h.recorder.flush()
    expect(h.calls).toHaveLength(1)
    await h.recorder.stop()
  })

  test('append failures keep all records, warn once per episode with the configured path and safe cause, then retry without duplicates', async () => {
    const h = harness()
    const error = Object.assign(new Error(sentinelInMessage('disk-full')), { code: 'ENOSPC', data: LEAK_SENTINEL })
    h.fail(error)
    h.recorder.record(store(1))
    await h.clock.runNext()
    expect(() => h.recorder.record(store(2))).not.toThrow()
    await h.clock.runNext()
    expect(h.written).toEqual([])
    expect(h.logs).toEqual([buildTestMeasurementsWriteFailedLine(join(tmpdir(), TEST_MEASUREMENTS_FILE_NAME), 'ENOSPC')])
    expect(h.logs[0]).toContain(join(tmpdir(), TEST_MEASUREMENTS_FILE_NAME))
    expect(h.logs[0]).toContain('ENOSPC')
    assertNoLeak({ logs: h.logs, calls: h.calls })
    h.fail()
    await h.clock.runNext()
    expect(h.records()).toEqual([1, 2].map(seq => ({ v: 1, ...store(seq) })))
    expect(h.written).toHaveLength(1)
    h.fail(error)
    h.recorder.record(store(3))
    await h.clock.runNext()
    expect(h.logs).toHaveLength(2)
    h.fail()
    await h.clock.runNext()
    expect(h.records()).toEqual([1, 2, 3].map(seq => ({ v: 1, ...store(seq) })))
    assertNoLeak({ logs: h.logs, calls: h.calls, written: h.written })
    await h.recorder.stop()
  })

  test('a pending append never blocks record, overlaps no second append, and retains its later tail', async () => {
    const h = harness()
    const gate = Promise.withResolvers<void>()
    h.hold(gate.promise)
    h.recorder.record(store(1))
    const first = h.recorder.flush()
    await h.clock.flush()
    expect(h.calls).toHaveLength(1)
    expect(h.recorder.record(store(2))).toBeUndefined()
    expect(h.recorder.flush()).toBe(first)
    expect(h.calls).toHaveLength(1)
    gate.resolve()
    await first
    h.hold()
    await h.clock.runNext()
    expect(h.records()).toEqual([1, 2].map(seq => ({ v: 1, ...store(seq) })))
    expect(h.calls).toHaveLength(2)
    await h.recorder.stop()
  })

  test('stop writes the buffered tail synchronously, cancels the timer and is idempotent; records after stop are inert', async () => {
    const h = harness()
    h.recorder.record(store())
    const stopping = h.recorder.stop()
    expect(h.calls).toEqual([{ sync: true, path: join(tmpdir(), TEST_MEASUREMENTS_FILE_NAME), data: h.written[0]!, mode: 0o600 }])
    expect(h.records()).toEqual([{ v: 1, ...store() }])
    expect(h.clock.pendingCount()).toBe(0)
    await stopping
    expect(() => h.recorder.record(store(2))).not.toThrow()
    await h.recorder.stop()
    await h.recorder.flush()
    await h.clock.advance(TEST_MEASUREMENTS_FLUSH_MS)
    expect(h.calls).toHaveLength(1)
  })

  test.each(['scheduled', 'pending-success', 'pending-failure'] as const)('shutdown drains %s before the tail, exactly once in original order', async phase => {
    const h = harness(), gate = Promise.withResolvers<void>()
    if (phase !== 'scheduled') h.hold(gate.promise)
    h.recorder.record(store(1))
    const flushing = h.recorder.flush()
    if (phase !== 'scheduled') await h.entered
    h.recorder.record(store(2))
    const stopping = h.recorder.stop()
    expect(h.recorder.stop()).toBe(stopping)
    let stopped = false
    void stopping.then(() => { stopped = true })
    expect(h.records()).toEqual([])
    expect(h.calls.filter(call => call.sync)).toEqual([])
    try {
      if (phase !== 'scheduled') {
        await h.clock.advance(TEST_MEASUREMENTS_FLUSH_MS)
        expect(stopped).toBe(false)
        expect(h.calls).toHaveLength(1)
        expect(h.calls.filter(call => call.sync)).toEqual([])
      }
    } finally {
      if (phase === 'pending-failure') gate.reject(Object.assign(new Error('write failed'), { code: 'EIO' }))
      else gate.resolve()
    }
    await stopping
    await flushing
    expect(h.records()).toEqual([1, 2].map(seq => ({ v: 1, ...store(seq) })))
    expect(h.calls.filter(call => call.sync)).toHaveLength(1)
    expect(h.clock.pendingCount()).toBe(0)
    h.recorder.record(store(3))
    await h.recorder.stop()
    expect(h.records()).toHaveLength(2)
  })

  test.each(['prefix', 'line'] as const)('a failed append after a %s rolls back to the original byte offset before recovery', async partial => {
    const h = harness()
    const previous = { ...store(0), key: 'mémoires' }
    h.recorder.record(previous)
    await h.recorder.flush()
    const before = h.bytes()
    expect(before.length).toBeGreaterThan(before.toString().length)
    h.fail(Object.assign(new Error(sentinelInMessage('partial-write')), { code: 'ENOSPC' }), partial)
    h.recorder.record(store(1))
    h.recorder.record(store(2))
    await h.recorder.flush()
    expect(h.metadata.filter(call => call.op === 'truncate')).toEqual([{ op: 'truncate', size: before.length }])
    expect(h.bytes()).toEqual(before)
    h.fail()
    h.recorder.record(store(3))
    await h.recorder.flush()
    expect(h.records()).toEqual([previous, store(1), store(2), store(3)].map(entry => ({ v: 1, ...entry })))
    expect(h.bytes().toString().endsWith('\n')).toBe(true)
    expect(h.calls).toHaveLength(3)
    assertNoLeak({ logs: h.logs, file: h.bytes().toString() })
    await h.recorder.stop()
  })

  test('failed rollback blocks replay and retains the original offset across repeated failures', async () => {
    const h = harness()
    h.recorder.record(store(0))
    await h.recorder.flush()
    const before = h.bytes()
    const error = Object.assign(new Error('injected I/O failure'), { code: 'EIO' })
    h.fail(error, 'line')
    h.failRollback(error)
    h.recorder.record(store(1))
    h.recorder.record(store(2))
    await h.recorder.flush()
    expect(h.bytes().length).toBeGreaterThan(before.length)
    h.fail()
    h.recorder.record(store(3))
    await h.recorder.flush()
    await h.recorder.flush()
    expect(h.calls).toHaveLength(2)
    expect(h.logs).toEqual([buildTestMeasurementsWriteFailedLine(join(tmpdir(), TEST_MEASUREMENTS_FILE_NAME), 'EIO')])
    h.failRollback()
    await h.recorder.flush()
    expect(h.metadata.filter(call => call.op === 'truncate')).toEqual(
      Array.from({ length: 4 }, () => ({ op: 'truncate', size: before.length })),
    )
    expect(h.records()).toEqual([0, 1, 2, 3].map(seq => ({ v: 1, ...store(seq) })))
    await h.recorder.stop()
  })

  test.each([false, true])('failed synchronous tail retains records and logs incomplete output (rollback fails=%s)', async rollbackFails => {
    const h = harness()
    h.recorder.record(store(0))
    await h.recorder.flush()
    const before = h.bytes()
    const error = Object.assign(new Error(sentinelInMessage('tail-failed')), { code: 'EIO' })
    h.fail(error, 'line')
    if (rollbackFails) h.failRollback(error)
    h.recorder.record(store(1))
    h.recorder.record(store(2))
    await h.recorder.stop()
    const path = join(tmpdir(), TEST_MEASUREMENTS_FILE_NAME)
    expect(h.logs).toEqual([
      buildTestMeasurementsWriteFailedLine(path, 'EIO'),
      buildTestMeasurementsStopIncompleteLine(path, 2, 'write failed'),
    ])
    if (!rollbackFails) expect(h.bytes()).toEqual(before)
    h.recorder.record(store(3))
    await h.recorder.stop()
    expect(h.logs.filter(line => line === buildTestMeasurementsWriteFailedLine(path, 'EIO'))).toHaveLength(1)
    expect(h.logs.at(-1)).toBe(buildTestMeasurementsStopIncompleteLine(path, 2, 'write failed'))
    h.fail()
    h.failRollback()
    await h.recorder.stop()
    expect(h.records()).toEqual([0, 1, 2].map(seq => ({ v: 1, ...store(seq) })))
    expect(h.clock.pendingCount()).toBe(0)
    const writes = h.calls.length
    await h.recorder.stop()
    expect(h.calls).toHaveLength(writes)
    assertNoLeak({ logs: h.logs, file: h.bytes().toString() })
  })

  test.each(['append', 'rollback'] as const)('hung %s reaches the shutdown bound, logs unconfirmed records and never replays active I/O', async operation => {
    const h = harness(), gate = Promise.withResolvers<void>()
    // The drain uses a referenced process timer, separate from the injected
    // unref'd background timer. Intercept only for this deterministic deadline test.
    const deadline = createFakeClock()
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((cb: () => void, ms: number) => deadline.setTimeout(cb, ms)) as unknown as typeof setTimeout,
    )
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(
      ((handle: unknown) => deadline.clearTimeout(handle)) as typeof clearTimeout,
    )
    if (operation === 'append') h.hold(gate.promise)
    else {
      h.fail(Object.assign(new Error('partial write'), { code: 'EIO' }), 'prefix')
      h.holdRollback(gate.promise)
    }
    h.recorder.record(store(1))
    h.recorder.record(store(2))
    const flushing = h.recorder.flush()
    try {
      await h.clock.flush()
      expect(h.calls).toHaveLength(1)
      if (operation === 'rollback') expect(h.metadata.some(call => call.op === 'truncate')).toBe(true)
      h.recorder.record(store(3))
      let finished = false
      const stopping = h.recorder.stop()
      void stopping.then(() => { finished = true })
      expect(h.recorder.stop()).toBe(stopping)
      expect(deadline.pending().map(t => t.delayMs)).toEqual([TEST_MEASUREMENTS_STOP_WAIT_MS])
      await deadline.advance(TEST_MEASUREMENTS_STOP_WAIT_MS - 1)
      expect(finished).toBe(false)
      expect(h.logs).toEqual([])
      await deadline.advance(1)
      await stopping
      expect(finished).toBe(true)
      expect(h.logs).toEqual([buildTestMeasurementsStopIncompleteLine(
        join(tmpdir(), TEST_MEASUREMENTS_FILE_NAME), 3, `drain exceeded ${TEST_MEASUREMENTS_STOP_WAIT_MS} ms`,
      )])
      expect(h.calls).toHaveLength(1)
      expect(h.calls.filter(call => call.sync)).toEqual([])
      expect(h.clock.pendingCount()).toBe(0)
      expect(deadline.pendingCount()).toBe(0)
    } finally {
      h.fail()
      gate.resolve()
      await flushing
      await h.recorder.stop()
      timer.mockRestore()
      clear.mockRestore()
    }
    expect(h.records()).toEqual([1, 2, 3].map(seq => ({ v: 1, ...store(seq) })))
    expect(h.calls.filter(call => call.sync)).toHaveLength(1)
    assertNoLeak(h.logs)
  })

  test.each(['scheduled', 'delayed', 'failed'] as const)('awaited stop persists %s active I/O in a real file before process exit', phase => {
    const root = mkdtempSync(join(tmpdir(), 'cscb-measurement-exit-'))
    const path = join(root, TEST_MEASUREMENTS_FILE_NAME)
    const script = `
      import * as fs from 'node:fs';
      import { createTestMeasurements } from ${JSON.stringify(new URL('../src/test-measurements.ts', import.meta.url).pathname)};
      const phase = ${JSON.stringify(phase)}, entered = Promise.withResolvers(), gate = Promise.withResolvers();
      const recorder = createTestMeasurements({
        path: ${JSON.stringify(path)}, log: line => console.error(line),
        timers: { setTimeout: (cb, ms) => setTimeout(cb, ms).unref(), clearTimeout },
        fs: { appendFileSync: fs.appendFileSync, async appendFile(path, data, options) {
          entered.resolve();
          if (phase !== 'scheduled') await gate.promise;
          if (phase === 'failed') {
            await fs.promises.appendFile(path, data.slice(0, 20), options);
            throw Object.assign(new Error('partial write'), { code: 'EIO' });
          }
          await fs.promises.appendFile(path, data, options);
        } },
      });
      recorder.record(${JSON.stringify(store(1))});
      void recorder.flush();
      if (phase !== 'scheduled') await entered.promise;
      recorder.record(${JSON.stringify(store(2))});
      const stopping = recorder.stop();
      setImmediate(() => gate.resolve());
      await stopping;
      process.exit(0);
    `
    try {
      const child = spawnSync(process.execPath, ['--eval', script], {
        env: hostSafeChildEnv(root, { tools: [], extras: { SLACK_STATE_DIR: root } }), encoding: 'utf8',
        // Backstop for a broken drain, above its production bound and below Bun's test timeout.
        timeout: TEST_MEASUREMENTS_STOP_WAIT_MS * 3,
      })
      expect(child.error).toBeUndefined()
      expect(child.signal).toBeNull()
      expect(child.status).toBe(0)
      const contents = readFileSync(path, 'utf8')
      expect(contents.endsWith('\n')).toBe(true)
      expect(contents.trim().split('\n').map(line => JSON.parse(line)))
        .toEqual([1, 2].map(seq => ({ v: 1, ...store(seq) })))
      assertNoLeak({ stdout: child.stdout, stderr: child.stderr, file: contents })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('throwing clock, timer, write and log dependencies never throw into the caller', async () => {
    const fail = () => { throw new Error('injected') }
    const h = harness({ timers: { setTimeout: fail, clearTimeout: fail }, log: fail, monotonicNow: fail,
      fs: { appendFile: async () => fail(), appendFileSync: fail,
        stat: async () => ({ size: 0 }), statSync: () => ({ size: 0 }), truncate: async () => {}, truncateSync: () => {} } })
    expect(() => h.recorder.record({ kind: 'post-hold-resolved', key: 'reader', seq: 1, outcome: 'released', cause: 'restart' })).not.toThrow()
    expect(() => h.recorder.record(store())).not.toThrow()
    await expect(h.recorder.flush()).resolves.toBeUndefined()
    expect(() => h.recorder.record(store(2))).not.toThrow()
    await expect(h.recorder.stop()).resolves.toBeUndefined()
    expect(() => h.recorder.record(store(3))).not.toThrow()
  })

  test.each(['flush', 'stop'] as const)('%s creates a missing file with mode 0600', async operation => {
    const root = mkdtempSync(join(tmpdir(), 'cscb-measurement-mode-'))
    const path = join(root, TEST_MEASUREMENTS_FILE_NAME)
    const h = harness({ path, fs: { appendFile, appendFileSync } })
    try {
      h.recorder.record(store())
      await h.recorder[operation]()
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 1, ...store() })
      assertNoLeak(writtenFile(path))
    } finally { await h.recorder.stop(); rmSync(root, { recursive: true, force: true }) }
  })
})
