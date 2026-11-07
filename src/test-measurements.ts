/**
 * The test-only measurement record. Undocumented for users; OFF by default.
 * It lets the SR-8 performance scenarios read timings that never leave the
 * process (durable store time, Post Hold resolution, receipt-to-ack time,
 * each journal append's fsync times and Thread Memory saves), measured
 * through the production paths. Startup load is measured outside the process.
 *
 * Only `test_measurements: true` in `config.json` (`TEST_MEASUREMENTS_KEY`,
 * validated by `src/config.ts`, read once at server start) creates a recorder,
 * which writes one JSON line per measured fact to
 * `<state dir>/test-measurements.jsonl` ({@link TEST_MEASUREMENTS_FILE_NAME}),
 * announced by one loud line at start ({@link buildTestMeasurementsStartLine}).
 * With the switch absent or `false` nothing here is created or called.
 * The `ack`, `append` and `thread-save` kinds also need
 * `test_measurement_timings: true` (`TEST_MEASUREMENT_TIMINGS_KEY`), because
 * their observers add work to every receipt, append and save.
 *
 * Each line is `{ v: 1, kind, at_mono_ms, … }` and holds numbers, persona
 * keys, sequence numbers, Slack event timestamps (`ack`'s `ts`) and fixed
 * words only: never message text, channel or user identifiers, paths or
 * credentials. `at_mono_ms` is the server's monotonic time (`performance.now`'s
 * clock, the queue's default): for the store kinds and `append`, when the
 * append became durable; for `ack`, when the ack call returned or was
 * suppressed; for the others, when the recorder was handed the fact.
 *
 * Importing this module performs no I/O and starts no timer.
 */

import * as nodeFs from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { HoldOutcome, QueueEvent, QueueStoreKind } from './delivery-queue.ts'
import type { DurableAppendTiming } from './durable-journal.ts'
import type { AckTiming } from './persona-routing.ts'
import type { PostHoldCause, PostHoldEvent } from './post-holds.ts'
import type { ThreadMemorySave } from './thread-memory.ts'
import { PERSONA_KEY_RE } from './persona-identity.ts'
import { queueErrorCode } from './persona-diagnostics.ts'
import { redactSlackLogText } from './slack-log-redaction.ts'

/** The record's file name, in the state directory. */
export const TEST_MEASUREMENTS_FILE_NAME = 'test-measurements.jsonl'
/** The delay between a buffered record and its asynchronous write, ms. */
export const TEST_MEASUREMENTS_FLUSH_MS = 250
/** Maximum shutdown wait for an active append or rollback, ms. */
export const TEST_MEASUREMENTS_STOP_WAIT_MS = 1_000

/** The one loud line written at start when the record is on. */
export function buildTestMeasurementsStartLine(path: string): string {
  return `[slack] WARNING: test-only measurement record is ON (${path}); not for production use`
}

/** The store a `store` record times: a queue store's kind, or a newly written `fixed` append. */
export type MeasuredStoreKind = QueueStoreKind | 'fixed'

/** A queue store: `store_ms` from the start of its serial turn to its durable append. */
export interface StoreMeasurement { kind: 'store'; key: string; seq: number; store: MeasuredStoreKind; store_ms: number; at_mono_ms: number }
/** A saved `resolveHolds` append and the seqs it resolved. */
export interface ResolutionStoreMeasurement { kind: 'resolution-store'; key: string; seqs: number[]; store_ms: number; at_mono_ms: number }
/** A saved Post Hold resolution; `held_ms` is absent for a restart release. */
export interface PostHoldResolvedMeasurement { kind: 'post-hold-resolved'; key: string; seq: number; outcome: HoldOutcome; cause: PostHoldCause; held_ms?: number }
/** One Slack event from receipt to its ack call (`receive_to_ack_ms`) and the call itself (`ack_call_ms`), or to the failed store that suppressed it. */
export interface AckMeasurement {
  kind: 'ack'; keys: string[]; ts?: string; targets: Array<{ key: string; seq: number }>
  outcome: AckTiming['outcome']; receive_to_ack_ms: number; ack_call_ms?: number; at_mono_ms: number
}
/** The journal an `append` wrote: the queue's or Thread Memory's. */
export type MeasuredJournal = 'queue' | 'thread-memory'
/** One durable append: its records (the group size), bytes, whole duration and the file and directory fsync time within it. */
export interface AppendMeasurement {
  kind: 'append'; journal: MeasuredJournal; key: string; records: number; bytes: number
  append_ms: number; file_fsync_ms: number; dir_fsync_ms: number; fsyncs: number; at_mono_ms: number
}
/** One Thread Memory save that appended records, counted by kind. */
export interface ThreadSaveMeasurement { kind: 'thread-save'; key: string; records: number; joins: number; intents: number; outcomes: number }
/** What `record` takes. */
export type TestMeasurement = StoreMeasurement | ResolutionStoreMeasurement | PostHoldResolvedMeasurement
  | AckMeasurement | AppendMeasurement | ThreadSaveMeasurement
/** One line of the file. */
export type TestMeasurementRecord = TestMeasurement & { v: 1; at_mono_ms: number }

/** The line for `record`, without its newline: only the kind's own fields, `v`, `kind` and `at_mono_ms` first. Pure. */
export function serializeTestMeasurement(record: TestMeasurementRecord): string {
  const head = { v: 1, kind: record.kind, at_mono_ms: record.at_mono_ms }
  switch (record.kind) {
    case 'store':
      return JSON.stringify({ ...head, key: record.key, seq: record.seq, store: record.store, store_ms: record.store_ms })
    case 'resolution-store':
      return JSON.stringify({ ...head, key: record.key, seqs: [...record.seqs], store_ms: record.store_ms })
    case 'post-hold-resolved':
      return JSON.stringify({ ...head, key: record.key, seq: record.seq, outcome: record.outcome, cause: record.cause,
        ...(record.held_ms !== undefined ? { held_ms: record.held_ms } : {}) })
    case 'ack':
      return JSON.stringify({ ...head, keys: [...record.keys], ...(record.ts !== undefined ? { ts: record.ts } : {}),
        targets: record.targets.map(t => ({ key: t.key, seq: t.seq })), outcome: record.outcome, receive_to_ack_ms: record.receive_to_ack_ms,
        ...(record.ack_call_ms !== undefined ? { ack_call_ms: record.ack_call_ms } : {}) })
    case 'append':
      return JSON.stringify({ ...head, journal: record.journal, key: record.key, records: record.records, bytes: record.bytes,
        append_ms: record.append_ms, file_fsync_ms: record.file_fsync_ms, dir_fsync_ms: record.dir_fsync_ms, fsyncs: record.fsyncs })
    case 'thread-save':
      return JSON.stringify({ ...head, key: record.key, records: record.records, joins: record.joins, intents: record.intents, outcomes: record.outcomes })
  }
}

/** A Slack `ts` as Slack writes it; any other value is left out of an `ack` line. */
const SLACK_TS_RE = /^\d{1,12}\.\d{1,6}$/

/** The measurement an ack timing carries; a `ts` not in Slack's form is left out. Pure. */
export function ackTimingMeasurement(timing: AckTiming): AckMeasurement {
  return { kind: 'ack', keys: [...timing.keys], ...(timing.ts !== undefined && SLACK_TS_RE.test(timing.ts) ? { ts: timing.ts } : {}),
    targets: timing.targets.map(t => ({ key: t.key, seq: t.seq })), outcome: timing.outcome, receive_to_ack_ms: timing.receiveToAckMs,
    ...(timing.ackCallMs !== undefined ? { ack_call_ms: timing.ackCallMs } : {}), at_mono_ms: timing.atMonoMs }
}

/** The measurement a timed append carries, only for a persona's own queue
 * (`<stateDir>/queue/<key>.jsonl`) or Thread Memory (`<stateDir>/threads/<key>.jsonl`)
 * journal; quarantine and other files give none. Pure. */
export function durableAppendMeasurement(timing: DurableAppendTiming, stateDir: string): AppendMeasurement | undefined {
  const journal: MeasuredJournal | undefined = timing.dir === join(stateDir, 'queue') ? 'queue'
    : timing.dir === join(stateDir, 'threads') ? 'thread-memory' : undefined
  if (!journal || dirname(timing.path) !== timing.dir || !timing.path.endsWith('.jsonl')) return undefined
  const key = basename(timing.path, '.jsonl')
  if (!PERSONA_KEY_RE.test(key)) return undefined
  return { kind: 'append', journal, key, records: timing.records, bytes: timing.bytes, append_ms: timing.appendMs,
    file_fsync_ms: timing.fileFsyncMs, dir_fsync_ms: timing.dirFsyncMs, fsyncs: timing.fsyncs, at_mono_ms: timing.atMonoMs }
}

/** The measurement a Thread Memory save carries. Pure. */
export function threadSaveMeasurement(save: ThreadMemorySave): ThreadSaveMeasurement {
  return { kind: 'thread-save', key: save.key, records: save.records, joins: save.joins, intents: save.intents, outcomes: save.outcomes }
}

/** The measurement a queue event carries: a timed store, a `fixed` append or a saved resolution. Pure. */
export function queueEventMeasurement(event: QueueEvent): TestMeasurement | undefined {
  switch (event.type) {
    case 'stored':
      if (event.storeMs === undefined || event.atMonoMs === undefined || event.seq === undefined || event.store === undefined) return undefined
      return { kind: 'store', key: event.key, seq: event.seq, store: event.store, store_ms: event.storeMs, at_mono_ms: event.atMonoMs }
    case 'fixed-stored':
      return { kind: 'store', key: event.key, seq: event.seq, store: 'fixed', store_ms: event.storeMs, at_mono_ms: event.atMonoMs }
    case 'holds-resolved':
      if (event.storeMs === undefined || event.atMonoMs === undefined) return undefined
      return { kind: 'resolution-store', key: event.key, seqs: event.resolutions.map(r => r.seq), store_ms: event.storeMs, at_mono_ms: event.atMonoMs }
    default:
      return undefined
  }
}

/** The measurement a Post Hold resolver event carries: a saved resolution. Pure. */
export function postHoldEventMeasurement(event: PostHoldEvent): TestMeasurement | undefined {
  if (event.kind !== 'post-hold-resolved') return undefined
  return { kind: 'post-hold-resolved', key: event.key, seq: event.seq, outcome: event.outcome, cause: event.cause,
    ...(event.heldMs !== undefined ? { held_ms: event.heldMs } : {}) }
}

export interface TestMeasurementsFs {
  /** Appends `data`, creating the file with `mode` when missing. */
  appendFile(path: string, data: string, options: { mode: number }): Promise<void>
  appendFileSync(path: string, data: string, options: { mode: number }): void
  /** Offset/rollback operations default to node:fs; fake filesystems must supply these too. */
  stat?(path: string): Promise<{ size: number }>
  truncate?(path: string, size: number): Promise<void>
  statSync?(path: string): { size: number }
  truncateSync?(path: string, size: number): void
}
export interface TestMeasurementsTimers {
  /** Arms a timer that keeps no process alive. */
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
export interface TestMeasurementsDeps {
  path: string
  fs: TestMeasurementsFs
  timers: TestMeasurementsTimers
  log(line: string): void
  monotonicNow?: () => number
}
export interface TestMeasurements {
  /** Buffers one record: synchronous, no I/O, never throws. */
  record(entry: TestMeasurement): void
  /** Writes the buffer with one append, in record order; a failed write keeps it. Never rejects. */
  flush(): Promise<void>
  /**
   * Stops admission/timers immediately. Await before exit: drains active I/O
   * for at most TEST_MEASUREMENTS_STOP_WAIT_MS, then writes the tail synchronously in order.
   * Timeout/failure logs incomplete output and retains unconfirmed records in
   * memory; another stop can retry. Unwritten records cannot survive exit.
   * Later records are dropped. Never rejects.
   */
  stop(): Promise<void>
}

/** The line written once per failure episode; `cause` is the failure's redacted error code. */
export function buildTestMeasurementsWriteFailedLine(path: string, cause: string): string {
  return `[slack] test-only measurement record: write to ${JSON.stringify(path)} failed (${cause}); records kept for the next write`
}

export function buildTestMeasurementsStopIncompleteLine(path: string, count: number, cause: string): string {
  return `[slack] test-only measurement record: shutdown incomplete for ${JSON.stringify(path)} (${cause}); ${count} records not confirmed written, kept in memory only; unwritten records will be lost on process exit`
}

export function createTestMeasurements(deps: TestMeasurementsDeps): TestMeasurements {
  const monotonicNow = deps.monotonicNow ?? (() => performance.now())
  const stat = deps.fs.stat ?? nodeFs.promises.stat
  const truncate = deps.fs.truncate ?? nodeFs.promises.truncate
  const statSync = deps.fs.statSync ?? nodeFs.statSync
  const truncateSync = deps.fs.truncateSync ?? nodeFs.truncateSync
  const buffer: TestMeasurementRecord[] = []
  let timer: unknown
  let writing: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  /** A failed append may have written bytes; reconcile before any replay. */
  let pendingRollback: number | undefined
  let failing = false
  let stopped = false

  const lines = (records: TestMeasurementRecord[]) => records.map(r => serializeTestMeasurement(r) + '\n').join('')
  function failed(error: unknown): void {
    if (failing) return
    failing = true
    try { deps.log(buildTestMeasurementsWriteFailedLine(deps.path, redactSlackLogText(queueErrorCode(error)))) } catch { /* the record never throws */ }
  }
  function arm(): void {
    if (stopped || timer !== undefined || writing !== undefined || buffer.length === 0) return
    try { timer = deps.timers.setTimeout(() => { timer = undefined; void flush() }, TEST_MEASUREMENTS_FLUSH_MS) } catch { timer = undefined }
  }
  function cancelTimer(): void {
    if (timer !== undefined) { try { deps.timers.clearTimeout(timer) } catch { /* the write still runs */ } timer = undefined }
  }
  async function rollback(): Promise<void> {
    if (pendingRollback === undefined) return
    try { await truncate(deps.path, pendingRollback) } catch (error) {
      if (queueErrorCode(error) !== 'ENOENT') throw error
    }
    pendingRollback = undefined
  }
  async function append(data: string): Promise<void> {
    await rollback()
    let offset: number
    try { offset = (await stat(deps.path)).size } catch (error) {
      if (queueErrorCode(error) !== 'ENOENT') throw error
      offset = 0
    }
    try { await deps.fs.appendFile(deps.path, data, { mode: 0o600 }) } catch (error) {
      pendingRollback = offset
      try { await rollback() } catch { /* retain the original offset for the next attempt */ }
      throw error
    }
  }
  function flush(): Promise<void> {
    if (writing !== undefined) return writing
    cancelTimer()
    if (stopped || buffer.length === 0) return Promise.resolve()
    const count = buffer.length
    let data: string
    try { data = lines(buffer.slice(0, count)) } catch (error) { failed(error); return Promise.resolve() }
    writing = Promise.resolve().then(async () => {
      try { await append(data); buffer.splice(0, count); failing = false } catch (error) { failed(error) }
    }).finally(() => { writing = undefined; arm() })
    return writing
  }
  function writeTail(): void {
    if (buffer.length === 0) return
    let offset: number | undefined
    try {
      const data = lines(buffer)
      try { offset = statSync(deps.path).size } catch (error) {
        if (queueErrorCode(error) !== 'ENOENT') throw error
        offset = 0
      }
      deps.fs.appendFileSync(deps.path, data, { mode: 0o600 })
      buffer.length = 0
      failing = false
    } catch (error) {
      if (offset !== undefined) {
        pendingRollback = offset
        try { truncateSync(deps.path, offset); pendingRollback = undefined } catch (rollbackError) {
          if (queueErrorCode(rollbackError) === 'ENOENT') pendingRollback = undefined
        }
      }
      failed(error)
    }
  }
  function incomplete(cause: string): void {
    try { deps.log(buildTestMeasurementsStopIncompleteLine(deps.path, buffer.length, cause)) } catch { /* isolated diagnostic */ }
  }
  async function finishStop(): Promise<void> {
    // A prior failed rollback must also settle before a synchronous tail write.
    if (writing === undefined && pendingRollback !== undefined) {
      writing = rollback().catch(failed).finally(() => { writing = undefined })
    }
    if (writing !== undefined) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      // Unlike the background timer, this timer keeps the process alive while
      // shutdown waits. Never replay a batch whose append/rollback may finish.
      const completed = await Promise.race([
        writing.then(() => true),
        new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), TEST_MEASUREMENTS_STOP_WAIT_MS) }),
      ])
      clearTimeout(timeout)
      if (!completed) { incomplete(`drain exceeded ${TEST_MEASUREMENTS_STOP_WAIT_MS} ms`); return }
    }
    if (pendingRollback === undefined) writeTail()
    if (buffer.length > 0) incomplete('write failed')
  }
  return {
    record(entry) {
      try {
        if (stopped) return
        const atMonoMs = entry.kind === 'store' || entry.kind === 'resolution-store' || entry.kind === 'ack' || entry.kind === 'append'
          ? entry.at_mono_ms : monotonicNow()
        buffer.push({ ...entry, v: 1, at_mono_ms: atMonoMs })
        arm()
      } catch { /* the record never throws */ }
    },
    flush,
    stop() {
      stopped = true
      cancelTimer()
      stopping ??= finishStop().finally(() => { stopping = undefined })
      return stopping
    },
  }
}
