/**
 * tests/ci-run-memory.test.ts — The sharded `/ci` runner's memory guard
 * (`scripts/ci-run.ts` section 11; b.uqm SR-21.6's memory file, E7).
 *
 * One describe block per behaviour group:
 * - samples (b.uqm SR-7.3): timing on the fake clock, what a sample reads,
 *   the failed-reading counts, W before, at its peak and after cleanup, and
 *   each shard's result-file state;
 * - the stop line (b.uqm SR-7.4): its exact line with both ceiling sources and
 *   the three per-shard detail forms, the byte boundary, `/ci-live` appearing
 *   mid-run, the PID named, rounding, and the stop decided once;
 * - anon peaks and peak PIDs (b.uqm SR-8.2);
 * - the cap rule (b.uqm SR-8.1, SR-8.3);
 * - the cap line and its `results.json` record (b.uqm SR-8.4, SR-16.1);
 * - out-of-memory detection and lines (b.uqm SR-12.2).
 *
 * The watchdog runs in process through its injected dependencies, over a
 * sample sequence (`buildSampleSequence`, E7's part of the readings builder)
 * on E6's cgroup tree and `/ci-live` builder and E1's fake container interface
 * and run-directory builder, all under a `mkdtempSync` root removed in
 * `afterEach`. Every wait is on `createFakeClock`; no case reads the host's
 * cgroups, another process's `/proc`, a real `/ci-live` lock or a real home,
 * or runs docker. The one child process is `mkfifo`, through
 * `tests/test-helpers/fifo.ts`. The runner's environment holds a credential
 * built with `fakeToken`, and everything a case produces passes `assertNoLeak`.
 * Runner constants are imported, never typed. The PRD's example figures and
 * lines are typed only in the cases that pin them; no case assumes the cap's
 * current value. Real script names are looked up by number in the
 * repository's listing.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CAP_LINE_KILL_TEXT,
  CAP_LINE_PAGE_CACHE_UNREAD_TEXT,
  CAP_LINE_PREFIX,
  CAP_LINE_UNKNOWN_TEXT,
  CAP_LIST_SEPARATOR,
  CAP_MARGIN_BYTES,
  CAP_REASON_NOT_DEFAULT,
  CAP_REASON_NOT_PASSED,
  CAP_REASON_PARTIAL,
  CAP_REASON_UNKNOWN,
  CAP_SUFFIX_INVALID_PREFIX,
  CAP_SUFFIX_KILL_PREFIX,
  CI_LIVE_LOCK_READ_MAX_BYTES,
  CI_LIVE_WORKING_SET_LIMIT_BYTES,
  FAIL_PREFIX,
  GIB_BYTES,
  MEMORY_CEILING_PERCENT,
  NO_SHARDS_RUNNING_TEXT,
  OOM_KILLED_TEXT,
  OOM_UNREADABLE_TEXT,
  SAMPLE_INTERVAL_MS,
  SAMPLE_READING_NAMES,
  SHARD_DIR_PREFIX,
  SHARD_MEMORY_CAP_BYTES,
  STOP_LINE_OFFSET_BYTES,
  UNREADABLE_READING,
  buildCapReport,
  capRule,
  classifyOom,
  containerListArgs,
  createMemoryWatchdog,
  formatGib,
  memoryCeiling,
  memoryStopLineBytes,
  memoryWatchdogLine,
  oomFailureOf,
  oomLineOf,
  parseCiArguments,
  parseResults,
  runKindOf,
  serializeResults,
  shardPeaks,
  shardResultFileState,
  watchdogCeilingSourceText,
  watchdogCiLiveRun,
  type CapShard,
  type CiLiveRunSeen,
  type Invocation,
  type MemoryCeiling,
  type MemoryWatchdogReport,
  type MemoryWatchdogStop,
  type OomStatus,
  type ResultEvent,
  type ResultFileRead,
  type ResultsAnonPeak,
  type ResultsCap,
  type RunningShardsProvider,
  type Sample,
  type ShardResultFileState,
  type ShardSample,
  type WorkingSetReading,
} from '../scripts/ci-run.ts'
import {
  buildSampleSequence,
  CGROUP_FILE,
  createFakeDocker,
  createSpawnRecorder,
  gibToBytes,
  makeResults,
  realScriptFileName,
  type FakeDocker,
  type SampleFinal,
  type SampleSequence,
  type SampleSequenceSpec,
  type SampleShard,
  type SampleStep,
  type SpawnRecorder,
} from './test-helpers/ci-run.ts'
import { assertNoLeak, fakeToken } from './test-helpers/credentials.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { makeFifo, mkfifoAvailable } from './test-helpers/fifo.ts'

// ---------------------------------------------------------------------------
// Test data and shared setup
// ---------------------------------------------------------------------------

/** Test data: every clock's start. */
const START_MS = Date.UTC(2026, 9, 8, 12, 0, 0)
/** Test data: L for every case that does not pin the PRD's 64 GiB, in GiB. */
const LIMIT_GIB = 48
/** Test data: a W well below any stop line here, in GiB. */
const QUIET_W_GIB = 10
/** Test data: the RUN_ID and runner PID of `results.json` round trips. */
const RESULTS_RUN_ID = '20261008t120000z-e7memory'
const RESULTS_PID = 4242

let root: string
let clock: FakeClock
let recorder: SpawnRecorder
let docker: FakeDocker
/** Everything a case produced, leak-checked in `afterEach`. */
let produced: unknown[]
/** Write ends this file holds on constructed FIFOs, closed in `afterEach`. */
let fifoWriters: number[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ci-run-memory-'))
  clock = createFakeClock({ start: START_MS })
  recorder = createSpawnRecorder({ clock, root })
  docker = createFakeDocker(recorder)
  produced = []
  fifoWriters = []
})

afterEach(() => {
  try {
    for (const fd of fifoWriters) closeSync(fd)
    recorder.assertNoFailures()
    assertNoLeak(produced, 'produced')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Whole bytes of a GiB figure, by the readings builder's one rule. */
function gib(figure: number): number {
  return gibToBytes(figure)
}

/** The repository's real file name for script number `n`, looked up in its `tests/integration` listing (b.uqm SR-21.2). */
function scriptFile(n: number): string {
  return realScriptFileName(n)
}

/** A parsed `/ci` invocation. */
function invocationOf(args: readonly string[]): Invocation {
  const parsed = parseCiArguments(args)
  if (!parsed.ok) throw new Error(`invocationOf: ${JSON.stringify(args)} does not parse`)
  return parsed.invocation
}

/** One shard's entries from a run's samples, in order. */
function shardSamplesOf(samples: readonly Sample[], shard: number): ShardSample[] {
  return samples.flatMap((sample) => sample.shards.filter((entry) => entry.shard === shard))
}

/** W with its parts, in whole bytes from GiB figures. */
function workingSetOf(workingSetGib: number, anonGib: number, activeFileGib: number): WorkingSetReading {
  return { bytes: gib(workingSetGib), anonBytes: gib(anonGib), activeFileBytes: gib(activeFileGib) }
}

/** Test data: admission's "before" W, unlike any sample's. */
const BEFORE = workingSetOf(19, 7, 3)

/** What the memory-run factory takes beside the sequence. */
interface MemoryRunOptions {
  readonly before?: WorkingSetReading
  /** Admission's ceiling (default: from L with no `/ci-live` run). */
  readonly ceiling?: MemoryCeiling
  readonly onSample?: (sample: Sample) => void
  /** Called after the factory records the stop. */
  readonly onStop?: (stop: MemoryWatchdogStop, sample: Sample) => void
  readonly runningShards?: RunningShardsProvider
}

/** One watchdog over a sample sequence, with what it handed on. */
interface MemoryRun {
  readonly seq: SampleSequence
  readonly watchdog: ReturnType<typeof createMemoryWatchdog>
  /** Every sample handed to `onSample`, in order. */
  readonly handed: Sample[]
  /** Every stop handed to `onStop`, with its sample. */
  readonly stops: { readonly stop: MemoryWatchdogStop; readonly sample: Sample }[]
  /** `onSample` and `onStop` calls in order, as `sample@<atMs>` and `stop@<atMs>`. */
  readonly calls: string[]
  readonly logLines: string[]
  /** Stops the watchdog and answers its report. */
  finish(): Promise<MemoryWatchdogReport>
  /** Starts the watchdog, takes every step, then stops it. */
  runAll(): Promise<MemoryWatchdogReport>
}

/**
 * The file's memory-run factory: a sample sequence under the case's root
 * (L defaulting to `LIMIT_GIB`) and a watchdog over it, with the fake clock,
 * the cgroup tree's reads, the process table's `/proc` reads, the fake
 * container interface and a credential built with `fakeToken` in its
 * environment.
 */
function memoryRun(spec: Omit<SampleSequenceSpec, 'limit'> & { readonly limit?: SampleSequenceSpec['limit'] }, options: MemoryRunOptions = {}): MemoryRun {
  const seq = buildSampleSequence(root, { clock, recorder, docker }, { limit: LIMIT_GIB, ...spec }, { env: { GH_TOKEN: fakeToken('', 'gh') } })
  const handed: Sample[] = []
  const stops: { stop: MemoryWatchdogStop; sample: Sample }[] = []
  const calls: string[] = []
  const logLines: string[] = []
  const proc = recorder.processes.deps()
  const watchdog = createMemoryWatchdog({
    deps: {
      clock,
      readCgroupFile: seq.cgroups.readCgroupFile,
      readProcCgroup: proc.readProcCgroup,
      readProcCmdline: proc.readProcCmdline,
      readProcCwd: proc.readProcCwd,
      env: seq.env,
      uid: seq.uid,
    },
    docker: { spawn: recorder.spawn, env: seq.env, cwd: root },
    home: seq.home,
    runDir: seq.runDir,
    before: options.before ?? BEFORE,
    limitBytes: seq.limitBytes,
    ceiling: options.ceiling ?? memoryCeiling(seq.limitBytes, []),
    runningShards: options.runningShards ?? seq.runningShards,
    onSample: (sample) => {
      handed.push(sample)
      calls.push(`sample@${sample.atMs}`)
      return options.onSample?.(sample)
    },
    onStop: (stop, sample) => {
      stops.push({ stop, sample })
      calls.push(`stop@${sample.atMs}`)
      options.onStop?.(stop, sample)
    },
    log: (line) => logLines.push(line),
  })
  produced.push({ handed, stops, logLines })
  const finish = async (): Promise<MemoryWatchdogReport> => {
    const report = await watchdog.stop()
    produced.push(report)
    return report
  }
  return {
    seq,
    watchdog,
    handed,
    stops,
    calls,
    logLines,
    finish,
    async runAll() {
      watchdog.start()
      await seq.run()
      return finish()
    },
  }
}

/** A quiet sample: W well below the line, with the given running shards. */
function quiet(shards: readonly SampleShard[] = [], extra: Partial<SampleStep> = {}): SampleStep {
  return { pod: { workingSet: QUIET_W_GIB }, shards, ...extra }
}

// Result-file events (b.uqm SR-11.3), built as data and written by the run-directory builder.
const started = (fileName: string): ResultEvent => ({ kind: 'start', fileName })
const passed = (fileName: string): ResultEvent => ({ kind: 'end', fileName, result: 'pass', seconds: 12.5 })
const notRun = (fileName: string): ResultEvent => ({ kind: 'notrun', fileName })
const DONE: ResultEvent = { kind: 'done' }
/** Every script started and passed, then the end marker. */
function allPassed(files: readonly string[]): ResultEvent[] {
  return [...files.flatMap((file) => [started(file), passed(file)]), DONE]
}

// ---------------------------------------------------------------------------
// Samples (b.uqm SR-7.3)
// ---------------------------------------------------------------------------

describe('samples (b.uqm SR-7.3)', () => {
  test('nothing is read before start; then one sample every SAMPLE_INTERVAL_MS, each taken at its interval', async () => {
    const run = memoryRun({ shards: [1], steps: [quiet([{ shard: 1 }]), quiet([{ shard: 1 }]), quiet([{ shard: 1 }])] })
    await clock.advance(SAMPLE_INTERVAL_MS * 2)
    expect(run.watchdog.samples()).toEqual([])
    expect(run.seq.cgroups.reads()).toEqual([])
    expect(docker.operations()).toEqual([])

    const startedAt = clock.now()
    run.watchdog.start()
    expect(clock.pending().map((timer) => timer.delayMs)).toEqual([SAMPLE_INTERVAL_MS])
    const counts: number[] = []
    for (let i = 0; i < 3; i++) {
      await run.seq.step()
      counts.push(run.watchdog.samples().length)
    }
    expect(counts).toEqual([1, 2, 3])
    const report = await run.finish()
    expect(report.samples.map((sample) => sample.atMs)).toEqual([1, 2, 3].map((n) => startedAt + n * SAMPLE_INTERVAL_MS))
  })

  test('samples go on during the build: before any shard starts they read W and /ci-live, and no shard', async () => {
    const run = memoryRun({ shards: [1], steps: [quiet(), quiet(), quiet([{ shard: 1, memory: 0.4 }])] })
    const startedAt = clock.now()
    const report = await run.runAll()
    const container = run.seq.container(1)
    const firstShardSampleAt = report.samples[2]!.atMs

    expect(report.samples.map((sample) => sample.atMs)).toEqual([1, 2, 3].map((n) => startedAt + n * SAMPLE_INTERVAL_MS))
    expect(report.samples.map((sample) => sample.shards.map((entry) => entry.shard))).toEqual([[], [], [1]])
    expect(report.samples.every((sample) => sample.workingSet !== UNREADABLE_READING)).toBe(true)
    expect(docker.operations('container-list').length).toBe(3)
    const ownInspects = docker.operations('container-state').filter((op) => op.refs.includes(container.name))
    expect(ownInspects.map((op) => op.atMs)).toEqual([firstShardSampleAt])
    expect(run.seq.cgroups.reads().filter((read) => read.cgroupPath === container.cgroupPath).length).toBeGreaterThan(0)
  })

  test('after stop no timer is pending and nothing more is read', async () => {
    const run = memoryRun({ shards: [1], steps: [quiet([{ shard: 1 }]), quiet([{ shard: 1 }])] })
    await run.runAll()
    expect(clock.pendingCount()).toBe(0)
    const reads = run.seq.cgroups.reads().length
    const operations = docker.operations().length
    const spawns = recorder.spawns().length

    await clock.advance(SAMPLE_INTERVAL_MS * 3)
    expect(run.watchdog.samples().length).toBe(2)
    expect(run.seq.cgroups.reads().length).toBe(reads)
    expect(docker.operations().length).toBe(operations)
    expect(recorder.spawns().length).toBe(spawns)
  })

  test('stop before start takes only the after-cleanup W; every stop answers the same report, and start after stop does nothing', async () => {
    const run = memoryRun({ steps: [] })
    run.seq.afterCleanup({ workingSet: 12, anon: 4, activeFile: 2 })
    const report = await run.finish()

    expect(report).toEqual({
      workingSet: { before: BEFORE, peak: null, after: workingSetOf(12, 4, 2) },
      failedReadings: 0,
      shardFailedReadings: new Map(),
      failures: [],
      samples: [],
      stop: null,
    })
    expect(run.seq.cgroups.reads().map((read) => [read.cgroupPath, read.fileName])).toEqual([
      ['/', CGROUP_FILE.current],
      ['/', CGROUP_FILE.stat],
    ])
    expect(await run.watchdog.stop()).toBe(report)
    run.watchdog.start()
    await clock.advance(SAMPLE_INTERVAL_MS * 2)
    expect(run.watchdog.samples()).toEqual([])
    expect(clock.pendingCount()).toBe(0)
  })

  test('a sample still being taken at stop is handed on; one waiting behind it is dropped', async () => {
    const run = memoryRun({ steps: [quiet(), quiet()] })
    // The first sample's container list answers (no containers) only one and a half intervals later.
    recorder.answer(containerListArgs(), { delayMs: SAMPLE_INTERVAL_MS + SAMPLE_INTERVAL_MS / 2 }, { times: 1 })
    const startedAt = clock.now()
    run.watchdog.start()
    await run.seq.step()
    await run.seq.step()
    expect(run.watchdog.samples()).toEqual([])

    const stopping = run.watchdog.stop()
    await clock.advance(SAMPLE_INTERVAL_MS)
    const report = await stopping
    expect(report.samples.map((sample) => sample.atMs)).toEqual([startedAt + SAMPLE_INTERVAL_MS])
    expect(run.handed).toEqual([...report.samples])
    expect(clock.pendingCount()).toBe(0)
  })

  test.each([
    {
      name: 'a sample hook that throws',
      options: (): MemoryRunOptions => ({
        onSample: () => {
          throw new Error('sample hook broke')
        },
      }),
      samples: 3,
      failedReadings: 0,
      logLines: 3,
    },
    {
      name: 'a sample hook whose promise rejects',
      options: (): MemoryRunOptions => ({ onSample: async () => Promise.reject(new Error('sample hook rejected')) }),
      samples: 3,
      failedReadings: 0,
      logLines: 3,
    },
    {
      // The first sample's re-check fails, so it keeps admission's ceiling, whose malformed L the stop line cannot print.
      name: 'a stop decision that throws',
      options: (): MemoryRunOptions => ({ ceiling: { bytes: 0, source: { kind: 'pod-limit', limitBytes: 0.5 } } }),
      firstStep: { containerList: 'fails' } as Partial<SampleStep>,
      samples: 3,
      failedReadings: 1,
      logLines: 1,
    },
    {
      name: 'a stop callback that throws (the stop is still decided)',
      options: (): MemoryRunOptions => ({
        onStop: () => {
          throw new Error('stop callback broke')
        },
      }),
      firstStep: { pod: { workingSet: LIMIT_GIB - 1 } } as Partial<SampleStep>,
      stopped: true,
      samples: 3,
      failedReadings: 0,
      logLines: 1,
    },
    {
      name: 'a sample that cannot be taken (the running-shards answer throws at the second)',
      options: (): MemoryRunOptions => {
        let calls = 0
        return {
          runningShards: () => {
            calls += 1
            if (calls === 2) throw new Error('running shards unknown')
            return []
          },
        }
      },
      samples: 2,
      failedReadings: 0,
      logLines: 1,
    },
  ])('$name is only logged: later samples go on and stop still answers the counts', async (row) => {
    const run = memoryRun({ steps: [quiet([], row.firstStep ?? {}), quiet(), quiet()] }, row.options())
    const report = await run.runAll()
    expect(report.samples.length).toBe(row.samples)
    expect(report.failedReadings).toBe(row.failedReadings)
    expect(report.stop !== null).toBe(row.stopped ?? false)
    expect(run.logLines.length).toBe(row.logLines)
  })

  test('a sample reads W with its parts and, for each running shard in shard order, its seven values; a shard not running is not read', async () => {
    const run = memoryRun({
      shards: [1, 2, 3],
      steps: [
        {
          pod: { workingSet: 20, anon: 8, activeFile: 3, inactiveFile: 2 },
          shards: [
            { shard: 2, memory: 1.5, anon: 1.1, file: 0.6, inactiveFile: 0.2, pidCount: 12, oomKillCount: 1, oomKilled: true, resultFile: [started(scriptFile(1)), passed(scriptFile(1)), started(scriptFile(5))] },
            { shard: 1, memory: 0.7, anon: 0.5, file: 0.3, pidCount: 4, resultFile: allPassed([scriptFile(1)]) },
          ],
        },
      ],
    })
    const report = await run.runAll()
    const sample = report.samples[0]!

    expect(sample.workingSet).toEqual(workingSetOf(20, 8, 3))
    expect(sample.shards).toEqual([
      {
        shard: 1,
        memoryBytes: gib(0.7),
        anonBytes: gib(0.5),
        pageCacheBytes: gib(0.3),
        pidCount: 4,
        oomKilled: false,
        oomKillCount: 0,
        resultFile: { kind: 'events', events: allPassed([scriptFile(1)]) },
      },
      {
        shard: 2,
        memoryBytes: gib(1.5),
        anonBytes: gib(1.1),
        pageCacheBytes: gib(0.6),
        pidCount: 12,
        oomKilled: true,
        oomKillCount: 1,
        resultFile: { kind: 'events', events: [started(scriptFile(1)), passed(scriptFile(1)), started(scriptFile(5))] },
      },
    ])
    const idle = run.seq.container(3)
    expect(run.seq.cgroups.reads().filter((read) => read.cgroupPath === idle.cgroupPath)).toEqual([])
    expect(docker.operations('container-state').filter((op) => op.refs.includes(idle.name))).toEqual([])
    expect(report.failedReadings).toBe(0)
  })

  test('a W read that fails mid-run is skipped and counted once for the run: no peak comes from it and later samples go on', async () => {
    const run = memoryRun({
      steps: [
        { pod: { workingSet: 10, anon: 3, activeFile: 1 } },
        // W's files hold 40 GiB, but its memory.stat is gone: unreadable, never a peak.
        { pod: { workingSet: 40, unreadable: { file: CGROUP_FILE.stat } } },
        { pod: { workingSet: 8, anon: 2, activeFile: 1 } },
      ],
    })
    const report = await run.runAll()

    expect(report.samples.map((sample) => sample.workingSet)).toEqual([workingSetOf(10, 3, 1), UNREADABLE_READING, workingSetOf(8, 2, 1)])
    expect(report.workingSet.peak).toEqual(workingSetOf(10, 3, 1))
    expect(report.failures.map((failure) => [failure.shard, failure.what])).toEqual([[null, SAMPLE_READING_NAMES.workingSet]])
    expect(report.failedReadings).toBe(1)
  })

  /** Asserts the second sample counted one failed `/ci-live` re-check and kept the first sample's `/ci-live` runs and ceiling. */
  function expectCarriedOver(report: MemoryWatchdogReport, seq: SampleSequence): void {
    const [first, second] = report.samples
    expect(first!.ciLive).toEqual([{ via: 'real-run-lock', what: seq.realRunLockPath, pid: seq.realRunPid }])
    expect(second!.ciLive).toEqual(first!.ciLive)
    expect(second!.ceiling).toEqual(first!.ceiling)
    expect(report.failures.map((failure) => [failure.shard, failure.what])).toEqual([[null, SAMPLE_READING_NAMES.ciLive]])
    expect(report.failedReadings).toBe(1)
  }

  test("a failed container listing is one failed /ci-live re-check, and the sample keeps the previous sample's C and source", async () => {
    const run = memoryRun({ steps: [quiet([], { locks: { realRun: 'held' } }), quiet([], { locks: { realRun: 'held' }, containerList: 'fails' })] })
    expectCarriedOver(await run.runAll(), run.seq)
  })

  test.skipIf(!mkfifoAvailable())(
    "a FIFO at the real-run lock is one failed /ci-live re-check, and the sample keeps the previous sample's C and source (skipped without mkfifo)",
    async () => {
      const run = memoryRun({ steps: [quiet([], { locks: { realRun: 'held' } }), quiet([], { locks: { realRun: 'untouched' } })] })
      run.watchdog.start()
      await run.seq.step()
      rmSync(run.seq.realRunLockPath)
      makeFifo(run.seq.realRunLockPath)
      // A write end held open, with more than a lock read takes waiting in it, so no read of the FIFO could block.
      const writer = openSync(run.seq.realRunLockPath, 'r+')
      fifoWriters.push(writer)
      writeSync(writer, Buffer.alloc(CI_LIVE_LOCK_READ_MAX_BYTES + 1, '1'))
      await run.seq.step()
      expectCarriedOver(await run.finish(), run.seq)
    },
  )

  test("a failed /ci-live re-check at the first sample keeps admission's C and source", async () => {
    const admissionRun: CiLiveRunSeen = { via: 'dry-run-lock', what: 'admission-dry-run.lock', pid: 31337 }
    const ceiling = memoryCeiling(gib(LIMIT_GIB), [admissionRun])
    const run = memoryRun({ steps: [quiet([], { containerList: 'fails' })] }, { ceiling })
    const report = await run.runAll()
    expect(report.samples[0]!.ciLive).toEqual([admissionRun])
    expect(report.samples[0]!.ceiling).toEqual(ceiling)
    expect(report.failedReadings).toBe(1)
  })

  test("an unreadable container memory.stat is three failed readings, for that shard and for the run", async () => {
    const run = memoryRun({ steps: [quiet([{ shard: 1, memory: 0.6, pidCount: 3, unreadable: [{ file: CGROUP_FILE.stat }] }])] })
    const report = await run.runAll()

    expect(report.samples[0]!.shards[0]).toMatchObject({ memoryBytes: UNREADABLE_READING, anonBytes: UNREADABLE_READING, pageCacheBytes: UNREADABLE_READING, pidCount: 3 })
    expect(report.failures.map((failure) => [failure.shard, failure.what])).toEqual([
      [1, SAMPLE_READING_NAMES.memory],
      [1, SAMPLE_READING_NAMES.anon],
      [1, SAMPLE_READING_NAMES.pageCache],
    ])
    expect([...report.shardFailedReadings]).toEqual([[1, 3]])
    expect(report.failedReadings).toBe(3)
  })

  const ALL_SIX = [
    SAMPLE_READING_NAMES.memory,
    SAMPLE_READING_NAMES.anon,
    SAMPLE_READING_NAMES.pageCache,
    SAMPLE_READING_NAMES.pidCount,
    SAMPLE_READING_NAMES.oomKilled,
    SAMPLE_READING_NAMES.oomKillCount,
  ]

  test.each([
    { name: 'an unreadable State.OOMKilled after a sample read the PID', steps: [{ shard: 1 }, { shard: 1, memory: 0.9, oomKilled: UNREADABLE_READING }], whats: [SAMPLE_READING_NAMES.oomKilled], memory: gib(0.9) },
    { name: 'a failed state inspect after a sample read the PID', steps: [{ shard: 1 }, { shard: 1, memory: 0.9, inspect: 'fails' }], whats: [SAMPLE_READING_NAMES.oomKilled], memory: gib(0.9) },
    { name: 'a failed state inspect with no PID read before', steps: [{ shard: 1, memory: 0.9, inspect: 'fails' }], whats: ALL_SIX, memory: UNREADABLE_READING },
  ] as const)('$name: the cgroup is read through the last PID, or every value fails with none', async (row) => {
    const run = memoryRun({ steps: row.steps.map((entry) => quiet([entry as SampleShard])) })
    const report = await run.runAll()
    const last = report.samples.at(-1)!.shards[0]!

    expect(last.oomKilled).toBe(UNREADABLE_READING)
    expect(last.memoryBytes).toBe(row.memory)
    expect(report.failures.map((failure) => [failure.shard, failure.what])).toEqual(row.whats.map((what) => [1, what]))
    expect([...report.shardFailedReadings]).toEqual([[1, row.whats.length]])
    expect(report.failedReadings).toBe(row.whats.length)
  })

  test.each([
    { name: 'a result file not yet created counts nothing', resultFile: 'absent' as const, kind: 'missing', failed: 0 },
    { name: 'a result file that cannot be read counts one', resultFile: 'unreadable' as const, kind: 'unreadable', failed: 1 },
    { name: 'a result file with a malformed line counts one', resultFile: { events: [started(scriptFile(1))], malformed: { at: 0, change: 'carriage-return' as const } }, kind: 'unreadable', failed: 1 },
  ])('$name', async (row) => {
    const run = memoryRun({ steps: [quiet([{ shard: 1, resultFile: row.resultFile }])] })
    const report = await run.runAll()
    expect(report.samples[0]!.shards[0]!.resultFile.kind).toBe(row.kind)
    expect(report.failures.map((failure) => [failure.shard, failure.what])).toEqual(row.failed === 0 ? [] : [[1, SAMPLE_READING_NAMES.resultFile]])
    expect([...report.shardFailedReadings]).toEqual([[1, row.failed]])
  })

  test('a failed after-cleanup W read gives after null and counts one for the run', async () => {
    const run = memoryRun({ steps: [quiet()] })
    run.watchdog.start()
    await run.seq.run()
    run.seq.afterCleanup({ workingSet: 5, unreadable: { file: CGROUP_FILE.current } })
    const report = await run.finish()
    expect(report.workingSet.after).toBeNull()
    expect(report.failures.map((failure) => [failure.shard, failure.what])).toEqual([[null, SAMPLE_READING_NAMES.workingSetAfterCleanup]])
    expect(report.failedReadings).toBe(1)
  })

  test('unreadable final-reading parts add nothing to any count', async () => {
    const run = memoryRun({
      steps: [quiet([{ shard: 1, anon: 0.3 }]), quiet([{ shard: 1, anon: 0.4 }])],
      finals: { 1: { memoryStat: 'unreadable', memoryEvents: 'unreadable', oomKilled: UNREADABLE_READING, resultFile: 'unreadable' } },
    })
    run.watchdog.start()
    await run.seq.run()
    const final = run.seq.final(1)
    const report = await run.finish()

    expect(final?.reading).toEqual({ oomKilled: UNREADABLE_READING, oomKillCount: UNREADABLE_READING, anonBytes: UNREADABLE_READING, fileBytes: UNREADABLE_READING })
    expect(report.failedReadings).toBe(0)
    expect([...report.shardFailedReadings]).toEqual([[1, 0]])
  })

  test("W before is admission's reading as given, its peak the highest-W sample with that sample's own parts, and after the after-cleanup reading", async () => {
    const run = memoryRun({
      steps: [
        { pod: { workingSet: 10, anon: 4, activeFile: 2 } },
        { pod: { workingSet: 30, anon: 12, activeFile: 7 } },
        { pod: { workingSet: 20, anon: 15, activeFile: 3 } },
      ],
    })
    run.watchdog.start()
    expect(run.seq.cgroups.reads()).toEqual([])
    await run.seq.run()
    run.seq.afterCleanup({ workingSet: 5, anon: 1, activeFile: 1 })
    const report = await run.finish()
    expect(report.workingSet).toEqual({ before: BEFORE, peak: workingSetOf(30, 12, 7), after: workingSetOf(5, 1, 1) })
  })

  const A = scriptFile(1)
  const B = scriptFile(5)
  test.each<{ name: string; read: ResultFileRead; state: ShardResultFileState }>([
    { name: 'no file yet', read: { kind: 'missing' }, state: { kind: 'no-file' } },
    { name: 'unreadable', read: { kind: 'unreadable', error: 'constructed' }, state: { kind: 'unreadable' } },
    { name: 'empty: idle', read: { kind: 'events', events: [] }, state: { kind: 'idle' } },
    { name: 'a start with no end: in progress', read: { kind: 'events', events: [started(A)] }, state: { kind: 'in-progress', fileName: A } },
    { name: 'a start then its end: idle', read: { kind: 'events', events: [started(A), passed(A)] }, state: { kind: 'idle' } },
    { name: 'a start then a notrun line: idle', read: { kind: 'events', events: [started(A), notRun(A)] }, state: { kind: 'idle' } },
    { name: 'two starts with no end: the last one started', read: { kind: 'events', events: [started(A), started(B)] }, state: { kind: 'in-progress', fileName: B } },
    { name: 'the end marker over an unfinished start: ended', read: { kind: 'events', events: [started(A), DONE] }, state: { kind: 'ended' } },
  ])("a result file's state: $name", ({ read, state }) => {
    expect(shardResultFileState(read)).toEqual(state)
  })
})

// ---------------------------------------------------------------------------
// The stop line (b.uqm SR-7.4)
// ---------------------------------------------------------------------------

/** The stop line's expected text from constructed values. */
function expectedStopLine(workingSetBytes: number, ceilingBytes: number, source: string, detail: string): string {
  return `${FAIL_PREFIX}memory watchdog: pod working set ${formatGib(workingSetBytes)} GiB reached the ${formatGib(ceilingBytes - STOP_LINE_OFFSET_BYTES)} GiB stop line (${source}; ${detail})`
}

/** The pod-limit ceiling source for L. */
function podLimitSource(limitBytes: number): string {
  return `${MEMORY_CEILING_PERCENT}% of the ${formatGib(limitBytes)} GiB pod limit`
}

/** The `/ci-live` ceiling source naming `named`. */
function ciLiveSource(named: number | string): string {
  return `/ci-live's ${CI_LIVE_WORKING_SET_LIMIT_BYTES / GIB_BYTES} GiB line, /ci-live run ${named} active`
}

/** The stop line in bytes for L with no `/ci-live` run. */
function podStopLineBytes(limitBytes: number): number {
  return memoryCeiling(limitBytes, []).bytes - STOP_LINE_OFFSET_BYTES
}

describe('the stop line (b.uqm SR-7.4)', () => {
  test('PRD line: W at the stop line of a 64 GiB pod limit stops the run with its exact line, the shards in shard order', async () => {
    const limit = gib(64)
    const run = memoryRun({
      limit: { bytes: limit },
      steps: [{ pod: { workingSet: { bytes: podStopLineBytes(limit) } }, shards: [{ shard: 2, memory: 0.8 }, { shard: 1, memory: 1.1 }] }],
    })
    const report = await run.runAll()
    const line = 'FAIL: memory watchdog: pod working set 53.9 GiB reached the 53.9 GiB stop line (85% of the 64.0 GiB pod limit; shard-1 1.1 GiB, shard-2 0.8 GiB)'
    expect(run.stops.map(({ stop }) => stop)).toEqual([{ kind: 'memory-watchdog', line }])
    expect(report.stop).toEqual({ kind: 'memory-watchdog', line })
  })

  test('demo: a /ci-live lock appearing mid-run moves the stop line from 53.9 to 39.5 GiB at the next sample, and the line names the run', async () => {
    const run = memoryRun({
      limit: 64,
      steps: [quiet([{ shard: 1, memory: 1 }], { pod: { workingSet: 45 } }), quiet([{ shard: 1, memory: 1 }], { pod: { workingSet: 45 }, locks: { realRun: 'held' } })],
    })
    const report = await run.runAll()
    const [before, after] = report.samples

    expect(report.samples.map((sample) => formatGib(memoryStopLineBytes(sample.ceiling)))).toEqual(['53.9', '39.5'])
    expect(run.stops.map(({ sample }) => sample.atMs)).toEqual([after!.atMs])
    expect(before!.ceiling.source.kind).toBe('pod-limit')
    expect(report.stop?.line).toBe(expectedStopLine(gib(45), CI_LIVE_WORKING_SET_LIMIT_BYTES, ciLiveSource(run.seq.realRunPid), `${SHARD_DIR_PREFIX}1 ${formatGib(gib(1))} GiB`))
  })

  test('one byte below the stop line does not stop; exactly on it stops', async () => {
    const limit = gib(LIMIT_GIB)
    const stopLine = podStopLineBytes(limit)
    const run = memoryRun({ steps: [{ pod: { workingSet: { bytes: stopLine - 1 } } }, { pod: { workingSet: { bytes: stopLine } } }] })
    const report = await run.runAll()
    expect(run.stops.map(({ sample }) => sample.atMs)).toEqual([report.samples[1]!.atMs])
    expect(report.stop?.line).toBe(expectedStopLine(stopLine, memoryCeiling(limit, []).bytes, podLimitSource(limit), NO_SHARDS_RUNNING_TEXT))
  })

  test('during the build, with no shard started, the stop reads no shards running', async () => {
    const limit = gib(LIMIT_GIB)
    const run = memoryRun({ steps: [{ pod: { workingSet: LIMIT_GIB - 1 } }] })
    const report = await run.runAll()
    expect(report.stop?.line).toBe(expectedStopLine(gib(LIMIT_GIB - 1), memoryCeiling(limit, []).bytes, podLimitSource(limit), NO_SHARDS_RUNNING_TEXT))
  })

  test("with the real-run and dry-run locks both held, the line names the real-run lock's PID", async () => {
    const run = memoryRun({ steps: [{ pod: { workingSet: 41 }, locks: { dryRun: 'held', realRun: 'held' } }] })
    const report = await run.runAll()
    expect(report.samples[0]!.ciLive.map((seen) => seen.pid)).toEqual([run.seq.realRunPid, run.seq.dryRunPid])
    expect(report.stop?.line).toBe(expectedStopLine(gib(41), CI_LIVE_WORKING_SET_LIMIT_BYTES, ciLiveSource(run.seq.realRunPid), NO_SHARDS_RUNNING_TEXT))
  })

  test('a failed /ci-live re-check after a /ci-live run was seen keeps its line and source at that sample', async () => {
    const run = memoryRun({
      steps: [
        { pod: { workingSet: 38 }, locks: { realRun: 'held' } },
        { pod: { workingSet: 41 }, locks: { realRun: 'held' }, containerList: 'fails' },
      ],
    })
    const report = await run.runAll()
    expect(run.stops.map(({ sample }) => sample.atMs)).toEqual([report.samples[1]!.atMs])
    expect(report.stop?.line).toBe(expectedStopLine(gib(41), CI_LIVE_WORKING_SET_LIMIT_BYTES, ciLiveSource(run.seq.realRunPid), NO_SHARDS_RUNNING_TEXT))
  })

  test('a shard whose memory is unreadable at the stop sample shows as shard-<k> unreadable, in shard order among the others', async () => {
    const limit = gib(LIMIT_GIB)
    const run = memoryRun({
      steps: [
        {
          pod: { workingSet: LIMIT_GIB - 1 },
          shards: [{ shard: 3, memory: 1.4 }, { shard: 2, memory: 0.9, unreadable: [{ file: CGROUP_FILE.current }] }, { shard: 1, memory: 0.6 }],
        },
      ],
    })
    const report = await run.runAll()
    const detail = `${SHARD_DIR_PREFIX}1 0.6 GiB, ${SHARD_DIR_PREFIX}2 ${UNREADABLE_READING}, ${SHARD_DIR_PREFIX}3 1.4 GiB`
    expect(report.stop?.line).toBe(expectedStopLine(gib(LIMIT_GIB - 1), memoryCeiling(limit, []).bytes, podLimitSource(limit), detail))
  })

  test('an unreadable W decides nothing, even right after a W one byte below the line', async () => {
    const stopLine = podStopLineBytes(gib(LIMIT_GIB))
    const run = memoryRun({
      steps: [
        { pod: { workingSet: { bytes: stopLine - 1 } } },
        { pod: { workingSet: LIMIT_GIB, unreadable: { file: CGROUP_FILE.current } } },
        { pod: { workingSet: { bytes: stopLine - 1 } } },
      ],
    })
    const report = await run.runAll()
    expect(report.samples[1]!.workingSet).toBe(UNREADABLE_READING)
    expect(run.stops).toEqual([])
    expect(run.watchdog.stopDecision()).toBeNull()
    expect(report.stop).toBeNull()
  })

  test.each([
    { name: 'W rounds up, a shard rounds down', workingSetGib: 41.26, shardGib: 1.04, texts: ['41.3', '1.0'] },
    { name: 'W rounds down, a shard rounds up', workingSetGib: 41.24, shardGib: 1.06, texts: ['41.2', '1.1'] },
  ])('figures are given to one decimal place, rounded to the nearest tenth: $name', ({ workingSetGib, shardGib, texts }) => {
    const ceiling = memoryCeiling(gib(LIMIT_GIB), [{ via: 'real-run-lock', what: 'run.lock', pid: 777 }])
    const line = memoryWatchdogLine(gib(workingSetGib), ceiling, [{ shard: 1, memoryBytes: gib(shardGib) }])
    expect(line).toBe(`${FAIL_PREFIX}memory watchdog: pod working set ${texts[0]} GiB reached the ${formatGib(CI_LIVE_WORKING_SET_LIMIT_BYTES - STOP_LINE_OFFSET_BYTES)} GiB stop line (${ciLiveSource(777)}; ${SHARD_DIR_PREFIX}1 ${texts[1]} GiB)`)
    produced.push(line)
  })

  test("the stop is decided once, handed to onStop before that sample's onSample, and the watchdog stops, kills and removes nothing", async () => {
    const over = (): SampleStep => ({ pod: { workingSet: LIMIT_GIB - 1 }, shards: [{ shard: 1, memory: 1 }] })
    const run = memoryRun({ steps: [quiet([{ shard: 1, memory: 1 }]), over(), over(), over()] })
    const report = await run.runAll()
    const at = report.samples.map((sample) => sample.atMs)

    expect(run.calls).toEqual([`sample@${at[0]}`, `stop@${at[1]}`, `sample@${at[1]}`, `sample@${at[2]}`, `sample@${at[3]}`])
    expect(run.stops.length).toBe(1)
    expect(report.stop).toEqual(run.stops[0]!.stop)
    expect([...new Set(docker.operations().map((op) => op.kind))].sort()).toEqual(['container-list', 'container-state'])
    expect(docker.removals()).toEqual([])
  })

  test.each<{ name: string; runs: CiLiveRunSeen[]; chosen: number }>([
    {
      name: 'the real-run lock over the dry-run lock and containers listed before it',
      runs: [
        { via: 'container', what: 'cscb-live-a-11', pid: 11 },
        { via: 'dry-run-lock', what: 'dry.lock', pid: 22 },
        { via: 'real-run-lock', what: 'run.lock', pid: 33 },
      ],
      chosen: 2,
    },
    {
      name: 'the dry-run lock over a container listed before it',
      runs: [
        { via: 'container', what: 'cscb-live-a-11', pid: 11 },
        { via: 'dry-run-lock', what: 'dry.lock', pid: 22 },
      ],
      chosen: 1,
    },
    {
      name: 'the first container with a PID over a no-PID container listed before it',
      runs: [
        { via: 'container', what: 'cscb-live-old', pid: null },
        { via: 'container', what: 'cscb-live-b-44', pid: 44 },
      ],
      chosen: 1,
    },
    {
      name: 'the first container when none has a PID',
      runs: [
        { via: 'container', what: 'cscb-live-old', pid: null },
        { via: 'container', what: 'cscb-live-older', pid: null },
      ],
      chosen: 0,
    },
  ])('the /ci-live run a line names, chosen by how it was seen: $name', ({ runs, chosen }) => {
    expect(watchdogCiLiveRun(runs)).toBe(runs[chosen]!)
    const run = runs[chosen]!
    expect(watchdogCeilingSourceText({ bytes: CI_LIVE_WORKING_SET_LIMIT_BYTES, source: { kind: 'ci-live', runs } })).toBe(ciLiveSource(run.pid ?? run.what))
  })
})

// ---------------------------------------------------------------------------
// Anon peaks and peak PIDs (b.uqm SR-8.2)
// ---------------------------------------------------------------------------

describe('anon peaks and peak PIDs (b.uqm SR-8.2)', () => {
  /** Shard 1's samples, one per anon figure (`unreadable`: its `memory.stat` is gone), each with its page cache. */
  function anonSteps(anons: readonly (number | 'unreadable')[], files: readonly number[]): SampleStep[] {
    if (anons.length === 0) return [quiet(), quiet()]
    return anons.map((anon, i) =>
      quiet([{ shard: 1, anon: anon === UNREADABLE_READING ? 0 : anon, file: files[i] ?? 0, unreadable: anon === UNREADABLE_READING ? [{ file: CGROUP_FILE.stat }] : [] }]),
    )
  }

  test.each<{ name: string; anons: (number | 'unreadable')[]; files: number[]; final: SampleFinal | null; peak: ResultsAnonPeak }>([
    {
      name: "at a sample, with that sample's page cache",
      anons: [0.5, 1.2, 0.8],
      files: [0.1, 0.4, 0.9],
      final: { anon: 0.6, file: 1.5 },
      peak: { bytes: gib(1.2), pageCacheBytes: gib(0.4), mark: null },
    },
    {
      name: 'at the final reading, with its page cache',
      anons: [0.5, 0.7],
      files: [0.1, 0.2],
      final: { anon: 0.9, file: 0.3 },
      peak: { bytes: gib(0.9), pageCacheBytes: gib(0.3), mark: null },
    },
    {
      name: "on equal anon values, the earliest reading's page cache",
      anons: [1, 1],
      files: [0.2, 0.6],
      final: { anon: 1, file: 0.9 },
      peak: { bytes: gib(1), pageCacheBytes: gib(0.2), mark: null },
    },
    {
      name: 'the highest sample, partial, when the final reading cannot read memory.stat',
      anons: [0.4, 0.9],
      files: [0.1, 0.5],
      final: { memoryStat: 'unreadable', anon: 1.8 },
      peak: { bytes: gib(0.9), pageCacheBytes: gib(0.5), mark: 'partial' },
    },
    {
      name: 'unknown when no reading read anon',
      anons: [UNREADABLE_READING, UNREADABLE_READING],
      files: [],
      final: { memoryStat: 'unreadable' },
      peak: { bytes: null, pageCacheBytes: null, mark: 'unknown' },
    },
    {
      name: 'partial with no final reading when samples read anon',
      anons: [0.3, 0.6],
      files: [0.2, 0.1],
      final: null,
      peak: { bytes: gib(0.6), pageCacheBytes: gib(0.1), mark: 'partial' },
    },
    {
      name: 'unknown for a shard that never started',
      anons: [],
      files: [],
      final: null,
      peak: { bytes: null, pageCacheBytes: null, mark: 'unknown' },
    },
  ])('the anon peak: $name', async ({ anons, files, final, peak }) => {
    const run = memoryRun({ shards: [1], steps: anonSteps(anons, files), finals: { 1: final } })
    const report = await run.runAll()
    const peaks = shardPeaks(shardSamplesOf(report.samples, 1), run.seq.final(1)?.reading ?? null)
    produced.push(peaks)
    expect(peaks.anonPeak).toEqual(peak)
  })

  // E1's FinalReading has no PID field, so peak PIDs come from samples only.
  test.each<{ name: string; pids: (number | 'unreadable')[]; peakPids: number | null }>([
    { name: 'the highest sample', pids: [3, 9, 5], peakPids: 9 },
    { name: 'the highest readable sample', pids: [4, UNREADABLE_READING, 2], peakPids: 4 },
    { name: 'null when no sample read it', pids: [UNREADABLE_READING, UNREADABLE_READING], peakPids: null },
  ])('peak PIDs: $name', async ({ pids, peakPids }) => {
    const run = memoryRun({
      steps: pids.map((count) => quiet([{ shard: 1, pidCount: count === UNREADABLE_READING ? 0 : count, unreadable: count === UNREADABLE_READING ? [{ file: CGROUP_FILE.pids }] : [] }])),
      finals: { 1: { anon: 0.2 } },
    })
    const report = await run.runAll()
    const peaks = shardPeaks(shardSamplesOf(report.samples, 1), run.seq.final(1)!.reading)
    produced.push(peaks)
    expect(peaks.peakPids).toBe(peakPids)
  })

  test('a shard whose page cache reaches its cap with no out-of-memory kill gets no failure, and keeps that page cache beside its peak', async () => {
    const atCap = { bytes: SHARD_MEMORY_CAP_BYTES }
    const run = memoryRun({
      steps: [quiet([{ shard: 1, memory: atCap, anon: 0.3, file: atCap, inactiveFile: 0.5 }]), quiet([{ shard: 1, memory: atCap, anon: 0.2, file: atCap, inactiveFile: 0.5 }])],
      finals: { 1: { anon: 0.1, file: atCap } },
    })
    const report = await run.runAll()
    const final = run.seq.final(1)
    const status = classifyOom({ shard: 1, assigned: [scriptFile(1)] }, report.samples, final)

    expect(status).toEqual({ kind: 'no-kill' })
    expect(oomFailureOf(1, status)).toBeNull()
    expect(report.stop).toBeNull()
    expect(shardPeaks(shardSamplesOf(report.samples, 1), final!.reading).anonPeak).toEqual({ bytes: gib(0.3), pageCacheBytes: SHARD_MEMORY_CAP_BYTES, mark: null })
  })
})

// ---------------------------------------------------------------------------
// The cap rule (b.uqm SR-8.1, SR-8.3)
// ---------------------------------------------------------------------------

/** A shard as the cap rule takes it. */
function capShard(shard: number, peak: ResultsAnonPeak, killed = false): CapShard {
  return { shard, anonPeak: peak, killed }
}

/** A complete anon peak of `bytes`, with its page cache. */
function complete(bytes: number, pageCacheBytes: number | null = 0): ResultsAnonPeak {
  return { bytes, pageCacheBytes, mark: null }
}

/** A partial anon peak. */
function partial(bytes: number, pageCacheBytes: number | null = 0): ResultsAnonPeak {
  return { bytes, pageCacheBytes, mark: 'partial' }
}

const UNKNOWN: ResultsAnonPeak = { bytes: null, pageCacheBytes: null, mark: 'unknown' }

describe('the cap rule (b.uqm SR-8.1, SR-8.3)', () => {
  test.each([
    [0.4, 2.0],
    [0.83, 2.0],
    [1.5, 2.5],
    [1.51, 3.0],
  ])('PRD: a highest anon peak of %p GiB gives %p GiB', (peakGib, capGib) => {
    const result = capRule(SHARD_MEMORY_CAP_BYTES, [capShard(1, complete(gib(peakGib)))])
    expect(result.derivedBytes).toBe(gib(capGib))
    expect(result.source).toMatchObject({ shard: 1, peakBytes: gib(peakGib), fromKill: false })
  })

  test.each([
    { name: 'exactly 1.5 GiB stays on its multiple', peakBytes: gib(1.5), capGib: 2.5 },
    { name: '1.5 GiB and one byte rounds up', peakBytes: gib(1.5) + 1, capGib: 3.0 },
    { name: 'exactly 1 GiB gives the minimum', peakBytes: gib(1), capGib: 2.0 },
    { name: '1 GiB and one byte rounds up past the minimum', peakBytes: gib(1) + 1, capGib: 2.5 },
  ])('whole bytes: $name', ({ peakBytes, capGib }) => {
    expect(capRule(SHARD_MEMORY_CAP_BYTES, [capShard(1, complete(peakBytes))]).derivedBytes).toBe(gib(capGib))
  })

  test.each([
    { name: 'PRD: a kill at a 2.0 GiB cap with a 1.2 GiB recorded peak', capUsedGib: 2.0, peak: complete(gib(1.2)), countedGib: 2.0, capGib: 3.0 },
    { name: 'a kill whose recorded peak is above the cap used counts at that peak', capUsedGib: 2.5, peak: complete(gib(2.7)), countedGib: 2.7, capGib: 4.0 },
    { name: 'a kill with an unknown peak counts at the cap used', capUsedGib: 2.5, peak: UNKNOWN, countedGib: 2.5, capGib: 3.5 },
  ])('$name', ({ capUsedGib, peak, countedGib, capGib }) => {
    const result = capRule(gib(capUsedGib), [capShard(1, peak, true)])
    expect(result).toEqual({ derivedBytes: gib(capGib), source: { peakBytes: gib(countedGib), shard: 1, pageCacheBytes: null, fromKill: true } })
  })

  test.each([
    { name: 'an unknown peak is not counted', shards: [capShard(1, UNKNOWN), capShard(2, complete(gib(0.6)))], shard: 2, capGib: 2.0 },
    { name: 'a partial peak is counted', shards: [capShard(1, partial(gib(1.7))), capShard(2, complete(gib(0.9)))], shard: 1, capGib: 3.0 },
  ])('counting: $name', ({ shards, shard, capGib }) => {
    const result = capRule(SHARD_MEMORY_CAP_BYTES, shards)
    expect(result.derivedBytes).toBe(gib(capGib))
    expect(result.source?.shard).toBe(shard)
  })

  test('with no counted peak and no kill there is no derived cap', () => {
    expect(capRule(SHARD_MEMORY_CAP_BYTES, [capShard(1, UNKNOWN), capShard(2, UNKNOWN)])).toEqual({ derivedBytes: null, source: null })
  })

  test('on equal counted values the lowest shard number is the source', () => {
    const result = capRule(SHARD_MEMORY_CAP_BYTES, [capShard(3, complete(gib(1.3), gib(0.5))), capShard(4, complete(gib(0.3))), capShard(2, complete(gib(1.3), gib(0.1)))])
    expect(result.source).toEqual({ peakBytes: gib(1.3), shard: 2, pageCacheBytes: gib(0.1), fromKill: false })
  })

  test.each([
    { name: 'none read', pageCacheBytes: null },
    { name: 'none', pageCacheBytes: 0 },
    { name: 'up to the cap', pageCacheBytes: SHARD_MEMORY_CAP_BYTES },
    { name: 'far past the cap', pageCacheBytes: 10 * SHARD_MEMORY_CAP_BYTES },
  ])('page cache never changes the result: $name', ({ pageCacheBytes }) => {
    const result = capRule(SHARD_MEMORY_CAP_BYTES, [capShard(1, complete(gib(0.9), 0)), capShard(2, complete(gib(0.4), pageCacheBytes))])
    expect(result.derivedBytes).toBe(capRule(SHARD_MEMORY_CAP_BYTES, [capShard(1, complete(gib(0.9), 0)), capShard(2, complete(gib(0.4), 0))]).derivedBytes)
    expect(result.source).toMatchObject({ shard: 1, peakBytes: gib(0.9) })
  })

  test.each([
    { name: 'a selective run', args: () => [scriptFile(23)] },
    { name: 'a --shards 1 run', args: () => ['--shards', '1'] },
    { name: 'an --inject full run', args: () => ['--inject', `fail:${scriptFile(5)}`] },
  ])('the runner never changes the cap: $name with a kill leaves the cap constant as it was, the derived cap only reported', ({ args }) => {
    const capBefore = SHARD_MEMORY_CAP_BYTES
    const shards = [capShard(1, complete(gib(1.3)), true)]
    const invocation = invocationOf(args())
    const rule = capRule(capBefore, shards)
    const report = buildCapReport({ invocation, passed: false, capUsedBytes: capBefore, rule, shards })
    produced.push(report)

    expect(SHARD_MEMORY_CAP_BYTES).toBe(capBefore)
    expect(report.record.usedBytes).toBe(capBefore)
    expect(report.record.derivedBytes).toBe(runKindOf(invocation) === 'selective' ? null : rule.derivedBytes)
  })

  test('an unreadable out-of-memory status is no kill for the rule: the cap line takes no kill form or kill suffix from it', () => {
    const final = { reading: { oomKilled: UNREADABLE_READING, oomKillCount: UNREADABLE_READING, anonBytes: UNREADABLE_READING, fileBytes: UNREADABLE_READING }, resultFile: { kind: 'missing' } } as const
    const status: OomStatus = classifyOom({ shard: 1, assigned: [scriptFile(1)] }, [], final)
    expect(status).toEqual({ kind: 'unreadable' })
    const shards = [capShard(1, UNKNOWN, status.kind === 'killed')]
    const rule = capRule(SHARD_MEMORY_CAP_BYTES, shards)
    const report = buildCapReport({ invocation: invocationOf([]), passed: false, capUsedBytes: SHARD_MEMORY_CAP_BYTES, rule, shards })
    produced.push(report)

    expect(rule).toEqual({ derivedBytes: null, source: null })
    expect(report.record.peakFromKill).toBe(false)
    expect(report.suffix).toBe(`${CAP_SUFFIX_INVALID_PREFIX}${CAP_REASON_NOT_PASSED}${CAP_LIST_SEPARATOR}${CAP_REASON_UNKNOWN} (${SHARD_DIR_PREFIX}1)`)
  })
})

// ---------------------------------------------------------------------------
// The cap line and its record (b.uqm SR-8.4, SR-16.1)
// ---------------------------------------------------------------------------

/** The cap report of a run, with the rule applied to its shards. */
function capReportOf(args: readonly string[], passed: boolean, capUsedBytes: number, shards: readonly CapShard[]): ReturnType<typeof buildCapReport> {
  const report = buildCapReport({ invocation: invocationOf(args), passed, capUsedBytes, rule: capRule(capUsedBytes, shards), shards })
  produced.push(report)
  return report
}

/** The full or kill form's expected text from its parts; `middle` is the page-cache parenthesis or the kill text. */
function expectedCapLine(peak: string, shard: number, middle: string, cap: string, current: string, suffix: string): string {
  return `${CAP_LINE_PREFIX}${peak} GiB in ${SHARD_DIR_PREFIX}${shard} ${middle} + ${CAP_MARGIN_BYTES / GIB_BYTES} GiB margin → ${cap} GiB; current cap ${current} GiB${suffix}`
}

/** Asserts a record survives `results.json`'s strict shape: written and read back unchanged (b.uqm SR-16.1). */
function expectRecordRoundTrips(record: ResultsCap): void {
  const parsed = parseResults(serializeResults(makeResults({ runId: RESULTS_RUN_ID, pid: RESULTS_PID, cap: record })))
  expect(parsed.ok).toBe(true)
  if (parsed.ok) expect(parsed.value.cap).toEqual(record)
}

/** `<reason> (<shards>)`. */
function withShards(reason: string, shards: readonly number[]): string {
  return `${reason} (${shards.map((shard) => `${SHARD_DIR_PREFIX}${shard}`).join(CAP_LIST_SEPARATOR)})`
}

describe('the cap line and its record (b.uqm SR-8.4, SR-16.1)', () => {
  test('full form: peak and page cache rounded up to two decimals, both caps to one, the current cap the cap used', () => {
    const capUsed = gib(3)
    const peakBytes = gib(1.25) + 3
    const report = capReportOf([], true, capUsed, [capShard(1, complete(gib(0.5))), capShard(2, complete(peakBytes, gib(0.75)))])

    expect(report.line).toBe(expectedCapLine('1.26', 2, '(page cache 0.75 GiB)', '2.5', '3.0', ''))
    expect(report.suffix).toBe('')
    expect(report.record).toEqual({ usedBytes: capUsed, peakBytes, peakShard: 2, peakPageCacheBytes: gib(0.75), peakFromKill: false, derivedBytes: gib(2.5), suffix: '' })
    expectRecordRoundTrips(report.record)
  })

  test.each([
    { name: 'an exact hundredth stays', pageCacheBytes: gib(0.75), text: '0.75' },
    { name: 'a few bytes over a hundredth rounds up', pageCacheBytes: gib(0.75) + 5, text: '0.76' },
    { name: 'a byte under a hundredth rounds up to it', pageCacheBytes: gib(0.5) - 1, text: '0.50' },
  ])('the page cache is rounded up to two decimals: $name', ({ pageCacheBytes, text }) => {
    const report = capReportOf([], true, gib(2.5), [capShard(1, complete(gib(1.25), pageCacheBytes))])
    expect(report.line).toBe(expectedCapLine('1.25', 1, `(page cache ${text} GiB)`, '2.5', '2.5', ''))
  })

  test('PRD kill form: a kill at a 2.0 GiB cap with a 1.2 GiB recorded peak prints the counted value and 3.0 GiB', () => {
    const report = capReportOf([], false, gib(2), [capShard(1, complete(gib(1.2), gib(0.4)), true)])
    expect(report.line).toBe(
      'cap from measured anon peak: 2.00 GiB in shard-1 (killed for out of memory at the cap) + 1 GiB margin → 3.0 GiB; current cap 2.0 GiB; source after out-of-memory kill in shard-1',
    )
    expect(report.record).toEqual({
      usedBytes: gib(2),
      peakBytes: gib(2),
      peakShard: 1,
      peakPageCacheBytes: null,
      peakFromKill: true,
      derivedBytes: gib(3),
      suffix: `${CAP_SUFFIX_KILL_PREFIX}${SHARD_DIR_PREFIX}1`,
    })
    expectRecordRoundTrips(report.record)
  })

  test("the full form reads (page cache unknown) when the peak reading's page cache was not read", () => {
    const report = capReportOf([], true, gib(2.5), [capShard(1, complete(gib(0.75), null))])
    expect(report.line).toBe(expectedCapLine('0.75', 1, CAP_LINE_PAGE_CACHE_UNREAD_TEXT, '2.0', '2.5', ''))
    expect(report.record).toMatchObject({ peakPageCacheBytes: null, peakFromKill: false })
    expectRecordRoundTrips(report.record)
  })

  test('unknown form: no anon read and no kill', () => {
    const report = capReportOf([], true, gib(2.5), [capShard(2, UNKNOWN), capShard(1, UNKNOWN)])
    const suffix = `${CAP_SUFFIX_INVALID_PREFIX}${withShards(CAP_REASON_UNKNOWN, [1, 2])}`
    expect(report.line).toBe(`${CAP_LINE_PREFIX}${CAP_LINE_UNKNOWN_TEXT}; current cap 2.5 GiB${suffix}`)
    expect(report.record).toEqual({ usedBytes: gib(2.5), peakBytes: null, peakShard: null, peakPageCacheBytes: null, peakFromKill: false, derivedBytes: null, suffix })
    expectRecordRoundTrips(report.record)
  })

  test('every peak unknown with a shard killed takes the kill form', () => {
    const report = capReportOf([], false, gib(2.5), [capShard(1, UNKNOWN), capShard(2, UNKNOWN, true)])
    expect(report.line).toBe(expectedCapLine('2.50', 2, CAP_LINE_KILL_TEXT, '3.5', '2.5', `${CAP_SUFFIX_KILL_PREFIX}${SHARD_DIR_PREFIX}2`))
  })

  const invalid = (...reasons: string[]): string => `${CAP_SUFFIX_INVALID_PREFIX}${reasons.join(CAP_LIST_SEPARATOR)}`
  test.each<{ name: string; args: () => string[]; passed: boolean; shards: CapShard[]; suffix: () => string }>([
    { name: 'none: a passing default full run, every peak complete', args: () => [], passed: true, shards: [capShard(1, complete(gib(0.5))), capShard(2, complete(gib(0.6)))], suffix: () => '' },
    {
      name: 'a default full run with kills in two shards, listed in shard order',
      args: () => [],
      passed: false,
      shards: [capShard(3, complete(gib(0.5)), true), capShard(2, complete(gib(0.4))), capShard(1, complete(gib(0.3)), true)],
      suffix: () => `${CAP_SUFFIX_KILL_PREFIX}${SHARD_DIR_PREFIX}1${CAP_LIST_SEPARATOR}${SHARD_DIR_PREFIX}3`,
    },
    {
      name: 'a default full run with a kill and a partial peak: the kill suffix only',
      args: () => [],
      passed: false,
      shards: [capShard(1, complete(gib(0.5)), true), capShard(2, partial(gib(0.4)))],
      suffix: () => `${CAP_SUFFIX_KILL_PREFIX}${SHARD_DIR_PREFIX}1`,
    },
    { name: '--shards', args: () => ['--shards', '3'], passed: true, shards: [capShard(1, complete(gib(0.5)))], suffix: () => invalid(CAP_REASON_NOT_DEFAULT) },
    { name: '--shard-timeout', args: () => ['--shard-timeout', '90'], passed: true, shards: [capShard(1, complete(gib(0.5)))], suffix: () => invalid(CAP_REASON_NOT_DEFAULT) },
    { name: '--inject', args: () => ['--inject', `fail:${scriptFile(5)}`], passed: true, shards: [capShard(1, complete(gib(0.5)))], suffix: () => invalid(CAP_REASON_NOT_DEFAULT) },
    { name: 'a failing default run without a kill', args: () => [], passed: false, shards: [capShard(1, complete(gib(0.5)))], suffix: () => invalid(CAP_REASON_NOT_PASSED) },
    {
      name: 'partial peaks, in shard order',
      args: () => [],
      passed: true,
      shards: [capShard(5, partial(gib(0.5))), capShard(2, partial(gib(0.4))), capShard(1, complete(gib(0.3)))],
      suffix: () => invalid(withShards(CAP_REASON_PARTIAL, [2, 5])),
    },
    { name: 'an unknown peak', args: () => [], passed: true, shards: [capShard(1, complete(gib(0.5))), capShard(4, UNKNOWN)], suffix: () => invalid(withShards(CAP_REASON_UNKNOWN, [4])) },
    {
      name: "the PRD's example",
      args: () => ['--shards', '6'],
      passed: true,
      shards: [capShard(5, partial(gib(0.5))), capShard(2, partial(gib(0.4))), capShard(1, complete(gib(0.3)))],
      suffix: () => '; not a valid cap source: not a default run, partial anon peak (shard-2, shard-5)',
    },
    {
      name: 'all four reasons, in their fixed order',
      args: () => ['--inject', `fail:${scriptFile(5)}`],
      passed: false,
      shards: [capShard(4, UNKNOWN), capShard(2, partial(gib(0.4))), capShard(1, complete(gib(0.3)))],
      suffix: () => invalid(CAP_REASON_NOT_DEFAULT, CAP_REASON_NOT_PASSED, withShards(CAP_REASON_PARTIAL, [2]), withShards(CAP_REASON_UNKNOWN, [4])),
    },
    { name: 'AC 52: a --shards 1 run with a kill', args: () => ['--shards', '1'], passed: false, shards: [capShard(1, complete(gib(0.5)), true)], suffix: () => '; not a valid cap source: not a default run, run did not pass' },
    {
      name: 'AC 52: an --inject full run with a kill',
      args: () => ['--inject', `fail:${scriptFile(5)}`],
      passed: false,
      shards: [capShard(1, complete(gib(0.5))), capShard(2, complete(gib(0.6)), true)],
      suffix: () => '; not a valid cap source: not a default run, run did not pass',
    },
  ])('suffix: $name', ({ args, passed, shards, suffix }) => {
    const report = capReportOf(args(), passed, gib(2.5), shards)
    expect(report.suffix).toBe(suffix())
    expect(report.record.suffix).toBe(suffix())
    expect(report.line?.endsWith(`GiB${suffix()}`)).toBe(true)
  })

  test('a selective run has no cap line, and a record null in every key but usedBytes', () => {
    const report = capReportOf([scriptFile(23)], false, gib(2.5), [capShard(1, complete(gib(0.5))), capShard(2, complete(gib(1.3)), true)])
    expect(report.line).toBeNull()
    expect(report.suffix).toBeNull()
    expect(report.record).toEqual({ usedBytes: gib(2.5), peakBytes: null, peakShard: null, peakPageCacheBytes: null, peakFromKill: null, derivedBytes: null, suffix: null })
    expectRecordRoundTrips(report.record)
  })
})

// ---------------------------------------------------------------------------
// Out-of-memory detection and lines (b.uqm SR-12.2)
// ---------------------------------------------------------------------------

describe('out-of-memory detection and lines (b.uqm SR-12.2)', () => {
  const T1 = scriptFile(1)
  const T23 = scriptFile(23)
  const T7 = scriptFile(7)
  /** Shard 2 runs test-1 then test-23; shard 3 test-1 then test-7. */
  const ASSIGNED: Readonly<Record<number, readonly string[]>> = { 1: [T1], 2: [T1, T23], 3: [T1, T7], 4: [T1] }

  /** Runs the sequence and answers each shard's status, line and failure. */
  async function oomOf(spec: Omit<SampleSequenceSpec, 'limit'>, shard: number, options: MemoryRunOptions = {}): Promise<{ status: OomStatus; line: string | null }> {
    const run = memoryRun(spec, options)
    const report = await run.runAll()
    const status = classifyOom({ shard, assigned: ASSIGNED[shard] ?? [] }, report.samples, run.seq.final(shard))
    const line = oomLineOf(shard, status)
    produced.push({ status, line })
    return { status, line }
  }

  const killedShardLine = (shard: number): string => `${FAIL_PREFIX}${SHARD_DIR_PREFIX}${shard}: ${OOM_KILLED_TEXT}`
  const killedScriptLine = (fileName: string, shard: number): string => `${FAIL_PREFIX}${fileName}: ${OOM_KILLED_TEXT} in ${SHARD_DIR_PREFIX}${shard}`

  test.each<{ name: string; sample: Partial<SampleShard>; final: SampleFinal }>([
    { name: 'State.OOMKilled true at a sample', sample: { oomKilled: true }, final: {} },
    { name: 'an oom_kill count above 0 at a sample', sample: { oomKillCount: 1 }, final: {} },
    { name: 'State.OOMKilled true at the final reading', sample: {}, final: { oomKilled: true } },
    { name: 'an oom_kill count above 0 at the final reading', sample: {}, final: { oomKillCount: 2 } },
  ])('a kill is shown by $name', async ({ sample, final }) => {
    const ended = allPassed(ASSIGNED[2]!)
    const { status, line } = await oomOf({ steps: [quiet([{ shard: 2, resultFile: ended, ...sample }])], finals: { 2: final } }, 2)
    expect(status).toEqual({ kind: 'killed', inProgress: null })
    expect(line).toBe(killedShardLine(2))
  })

  test('PRD line: a kill in a shard whose scripts all passed and that ended normally fails the shard', async () => {
    const ended = allPassed(ASSIGNED[3]!)
    const { line } = await oomOf({ steps: [quiet([{ shard: 3, resultFile: [started(T1)] }]), quiet([{ shard: 3, oomKilled: true, resultFile: ended }])], finals: { 3: {} } }, 3)
    expect(line).toBe('FAIL: shard-3: killed for out of memory')
  })

  test('PRD line: a kill with test-23 in progress names the script and its shard', async () => {
    const { line } = await oomOf({ steps: [quiet([{ shard: 2, oomKillCount: 1, resultFile: [started(T1), passed(T1), started(T23)] }])], finals: { 2: {} } }, 2)
    expect(line).toBe(`FAIL: ${T23}: killed for out of memory in shard-2`)
  })

  test.each<{ name: string; first: SampleShard['resultFile']; later: SampleShard['resultFile']; line: () => string }>([
    { name: 'a script in progress then, none later', first: [started(T1), passed(T1), started(T23)], later: allPassed([T1, T23]), line: () => killedScriptLine(T23, 2) },
    { name: 'none in progress then, a script later', first: [started(T1), passed(T1)], later: [started(T1), passed(T1), started(T23)], line: () => killedShardLine(2) },
    { name: 'an unreadable result file then, a script later', first: 'unreadable', later: [started(T1), passed(T1), started(T23)], line: () => killedShardLine(2) },
  ])('the first reading that showed the kill decides the line: $name', async ({ first, later, line }) => {
    const result = await oomOf(
      { steps: [quiet([{ shard: 2, oomKilled: true, resultFile: first }]), quiet([{ shard: 2, oomKilled: true, resultFile: later }])], finals: { 2: { oomKilled: true } } },
      2,
    )
    expect(result.line).toBe(line())
  })

  test('a kill first seen at the final reading uses the result file supplied with it', async () => {
    const { line } = await oomOf(
      { steps: [quiet([{ shard: 2, resultFile: [started(T1)] }])], finals: { 2: { oomKilled: true, resultFile: [started(T1), passed(T1), started(T23)] } } },
      2,
    )
    expect(line).toBe(killedScriptLine(T23, 2))
  })

  test.each<{ name: string; sample: Partial<SampleShard>; final: SampleFinal }>([
    { name: 'only State.OOMKilled readable, and false', sample: {}, final: { oomKilled: false, memoryEvents: 'unreadable' } },
    { name: 'only memory.events readable, with no kill', sample: {}, final: { oomKilled: UNREADABLE_READING, oomKillCount: 0 } },
    {
      name: 'a failed 30 s out-of-memory reading, then a readable final reading with no kill',
      sample: { inspect: 'fails', unreadable: [{ file: CGROUP_FILE.events }] },
      final: { oomKilled: false, oomKillCount: 0 },
    },
  ])('a final reading clears the shard: $name', async ({ sample, final }) => {
    const { status, line } = await oomOf({ steps: [quiet([{ shard: 2 }]), quiet([{ shard: 2, ...sample }])], finals: { 2: final } }, 2)
    expect(status).toEqual({ kind: 'no-kill' })
    expect(line).toBeNull()
  })

  test('PRD line: neither final source readable and no earlier kill fails the shard as unreadable, even with every script passed', async () => {
    const { status, line } = await oomOf(
      { steps: [quiet([{ shard: 3, resultFile: allPassed(ASSIGNED[3]!) }])], finals: { 3: { oomKilled: UNREADABLE_READING, memoryEvents: 'unreadable' } } },
      3,
    )
    expect(status).toEqual({ kind: 'unreadable' })
    expect(line).toBe('FAIL: shard-3: out-of-memory status unreadable')
  })

  test('an earlier kill keeps its kill line over an unreadable final reading, with no unreadable line', async () => {
    const { status, line } = await oomOf(
      { steps: [quiet([{ shard: 2, oomKillCount: 1, resultFile: [started(T1), passed(T1)] }])], finals: { 2: { oomKilled: UNREADABLE_READING, memoryEvents: 'unreadable' } } },
      2,
    )
    expect(status).toEqual({ kind: 'killed', inProgress: null })
    expect(line).toBe(killedShardLine(2))
  })

  test.each([
    { name: 'its container was never created', steps: [quiet([{ shard: 1 }]), quiet([{ shard: 1 }])], stopped: false },
    { name: 'its container was not yet created at a run-level stop', steps: [quiet([{ shard: 1 }]), { pod: { workingSet: LIMIT_GIB - 1 }, shards: [{ shard: 1 }] }], stopped: true },
  ])('a shard with no final reading gets no out-of-memory failure, never the unreadable line: $name', async ({ steps, stopped }) => {
    const run = memoryRun({ steps })
    const report = await run.runAll()
    const status = classifyOom({ shard: 2, assigned: ASSIGNED[2]! }, report.samples, null)
    expect(report.stop !== null).toBe(stopped)
    expect(status).toEqual({ kind: 'no-kill' })
    expect(oomFailureOf(2, status)).toBeNull()
  })

  test('one failure per shard, classed out-of-memory with its shard number, in all three forms; a shard with no kill gets none', async () => {
    const killedTwice = { oomKilled: true, oomKillCount: 1 } as const
    const run = memoryRun({
      steps: [
        quiet([{ shard: 1 }, { shard: 2, ...killedTwice, resultFile: [started(T1), passed(T1), started(T23)] }, { shard: 3 }, { shard: 4 }]),
        quiet([{ shard: 1 }, { shard: 2, ...killedTwice, resultFile: allPassed(ASSIGNED[2]!) }, { shard: 3, oomKilled: true, resultFile: allPassed(ASSIGNED[3]!) }, { shard: 4 }]),
        quiet([{ shard: 1 }, { shard: 2, ...killedTwice }, { shard: 3, oomKillCount: 3 }, { shard: 4 }]),
      ],
      finals: { 1: {}, 2: { oomKilled: true, oomKillCount: 4 }, 3: { oomKilled: true }, 4: { oomKilled: UNREADABLE_READING, memoryEvents: 'unreadable' } },
    })
    const report = await run.runAll()
    const failures = [1, 2, 3, 4].flatMap((shard) => {
      const failure = oomFailureOf(shard, classifyOom({ shard, assigned: ASSIGNED[shard]! }, report.samples, run.seq.final(shard)))
      return failure === null ? [] : [failure]
    })
    produced.push(failures)

    expect(failures).toEqual([
      { line: killedScriptLine(T23, 2), shard: 2, failureClass: { kind: 'out-of-memory' } },
      { line: killedShardLine(3), shard: 3, failureClass: { kind: 'out-of-memory' } },
      { line: `${FAIL_PREFIX}${SHARD_DIR_PREFIX}4: ${OOM_UNREADABLE_TEXT}`, shard: 4, failureClass: { kind: 'out-of-memory' } },
    ])
  })

  test.each([
    { name: 'a default full run', args: () => [], kind: 'full', shard: 2, assigned: () => [T1, T7, T23] },
    { name: 'a selective /ci test-23 run', args: () => [T23], kind: 'selective', shard: 1, assigned: () => [T1, T23] },
    { name: 'a --shards 1 run', args: () => ['--shards', '1'], kind: 'full', shard: 1, assigned: () => [T1, T7, T23] },
    { name: 'an --inject full run', args: () => ['--inject', `fail:${T7}`], kind: 'full', shard: 2, assigned: () => [T1, T7, T23] },
  ])('every kind of run gives the same failure naming the shard: $name', async ({ args, kind, shard, assigned }) => {
    expect(runKindOf(invocationOf(args()))).toBe(kind)
    const inProgress = [...assigned().slice(0, -1).flatMap((file) => [started(file), passed(file)]), started(T23)]
    const run = memoryRun({ steps: [quiet([{ shard, oomKilled: true, resultFile: inProgress }])], finals: { [shard]: { oomKilled: true } } })
    const report = await run.runAll()
    const failure = oomFailureOf(shard, classifyOom({ shard, assigned: assigned() }, report.samples, run.seq.final(shard)))
    produced.push(failure)
    expect(failure).toEqual({ line: killedScriptLine(T23, shard), shard, failureClass: { kind: 'out-of-memory' } })
  })
})
