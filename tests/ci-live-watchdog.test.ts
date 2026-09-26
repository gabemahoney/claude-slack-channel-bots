/**
 * ci-live-watchdog.test.ts — Tests for the /ci-live runner's memory watchdog
 * (bug b.1cx): `ci-live/lib/memory-watchdog.ts` and the reading of Chrome's
 * process tree it takes from `ci-live/lib/proc-tree.ts`.
 *
 * The rules under test:
 * - every sample is one `watchdog:` line: the host cgroup's working set
 *   (`memory.current` minus `inactive_file`), the test container's docker
 *   stats, Chrome's tree PSS with the browser's contexts and pages, and the
 *   runner's RSS;
 * - the run is stopped once, through `onAbort` (main.ts turns it into the
 *   verdict `FAIL: memory watchdog: <reason>`, pinned by the source audit in
 *   tests/ci-live-docker.test.ts), when the host working set or Chrome's PSS
 *   passes its limit, the reason naming the value and the limit; a reading
 *   that fails is logged in its sample's line and never stops the run;
 * - the limits are checked as their readings arrive (the host, then Chrome),
 *   before docker stats (not read once stopped) and before the line is
 *   written, so neither a hung docker stats nor a line that can't be written
 *   holds back or prevents the abort;
 * - one sample at a time: a tick while one is in flight is skipped, an
 *   explicit `sample()` waits for it and then reads afresh, and `stop()`
 *   settles only after the line of the sample in flight, which no longer
 *   aborts; no line comes after it;
 * - the peaks, each with its sample's time, are kept for the results;
 * - Chrome's PSS is the summed Pss of the runner's Chrome descendants, a
 *   process whose smaps_rollup can't be read counted by its RSS.
 *
 * No real timer, /sys, /proc or docker: the clock (over the shared fake
 * clock), the sources and the /proc reader are injected.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import {
  formatBytes,
  GIB,
  MemoryWatchdog,
  parseHostCgroup,
  readHostCgroup,
  type ChromeMemory,
  type HostMemory,
  type WatchdogClock,
  type WatchdogSources,
} from '../ci-live/lib/memory-watchdog.ts'
import { chromeTreePss, parseProcStat, parsePssBytes, parseVmRssBytes, type ProcReader } from '../ci-live/lib/proc-tree.ts'
import { createFakeClock, type FakeTimerHandle } from './test-helpers/fake-clock.ts'
import { assertNoLeak, LEAK_SENTINEL } from './test-helpers/credentials.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MIB = 1024 ** 2
const T0 = Date.parse('2026-09-26T12:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

/** The host at `wsGiB` of working set: 2 GiB of inactive file cache on top, under a 64 GiB memory.max. */
function host(wsGiB: number, max: string = String(64 * GIB)): HostMemory {
  return parseHostCgroup(String((wsGiB + 2) * GIB), max, `anon 1\ninactive_file ${2 * GIB}\n`)
}

function chrome(pssGiB: number, overrides: Partial<ChromeMemory> = {}): ChromeMemory {
  return { pssBytes: pssGiB * GIB, rssFallbacks: 0, processes: 6, browser: { contexts: 1, pages: 1, idlePages: 1 }, ...overrides }
}

/** Healthy readings: 10 GiB host working set, a 1.5 GiB container, 1 GiB of Chrome, a 200 MiB runner. */
function sources(overrides: Partial<WatchdogSources> = {}): WatchdogSources {
  return {
    host: () => host(10),
    container: async () => ({ memUsage: '1.5GiB / 8GiB', memBytes: 1.5 * GIB, limitBytes: 8 * GIB, pids: 120 }),
    chrome: () => chrome(1),
    runnerRssBytes: () => 200 * MIB,
    ...overrides,
  }
}

/** A watchdog on a fake clock starting at T0, logging into arrays, its aborts recorded. */
function watchdogHarness(src: WatchdogSources) {
  const fake = createFakeClock({ start: T0 })
  const clock: WatchdogClock = {
    now: () => fake.now(),
    every(ms, tick) {
      let handle: FakeTimerHandle
      const arm = () => {
        handle = fake.setTimeout(() => {
          arm()
          tick()
        }, ms)
      }
      arm()
      return () => fake.clearTimeout(handle)
    },
  }
  const log = { info: [] as string[], detail: [] as string[], error: [] as string[] }
  const aborts: string[] = []
  const watchdog = new MemoryWatchdog({
    sources: src,
    log: { info: (m) => log.info.push(m), detail: (m) => log.detail.push(m), error: (m) => log.error.push(m) },
    onAbort: (reason) => aborts.push(reason),
    clock,
  })
  return { watchdog, fake, log, aborts }
}

/** A promise the test settles: a reading still in flight until `resolve` is called. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve: (value: T) => resolve(value) }
}

/** Each call gives the next value (the last one repeats). */
function sequence<T>(...values: T[]): () => T {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] as T
}

// ---------------------------------------------------------------------------
// The host cgroup
// ---------------------------------------------------------------------------

describe('the host cgroup', () => {
  test.each([
    ['a limit', '4294967296\n', '68719476736\n', { currentBytes: 4 * GIB, maxBytes: 64 * GIB, inactiveFileBytes: GIB, workingSetBytes: 3 * GIB }],
    ['no limit (max)', '4294967296\n', 'max\n', { currentBytes: 4 * GIB, maxBytes: null, inactiveFileBytes: GIB, workingSetBytes: 3 * GIB }],
    ['more inactive file cache than use (never below 0)', '536870912\n', 'max\n', { currentBytes: GIB / 2, maxBytes: null, inactiveFileBytes: GIB, workingSetBytes: 0 }],
  ])('parseHostCgroup: the working set is memory.current minus inactive_file, with %s', (_what, current, max, expected) => {
    expect(parseHostCgroup(current, max, `anon 7\nfile 9\ninactive_file ${GIB}\nactive_file 3\n`)).toEqual(expected)
  })

  test.each([
    ['memory.current that is no number', 'abc', 'max', `inactive_file 1\n`, 'memory.current is not a number'],
    ['a negative memory.max', '1', '-1', `inactive_file 1\n`, 'memory.max is not a number'],
    ['memory.stat with no inactive_file', '1', 'max', 'anon 1\nfile 2\n', 'memory.stat has no inactive_file'],
    ["cgroup v1's total_inactive_file only", '1', 'max', 'total_inactive_file 1\n', 'memory.stat has no inactive_file'],
  ])('parseHostCgroup throws on %s', (_what, current, max, stat, message) => {
    expect(() => parseHostCgroup(current, max, stat)).toThrow(message)
  })

  test('readHostCgroup reads memory.current, memory.max and memory.stat under the given cgroup dir', () => {
    const files: Record<string, string> = { '/cg/memory.current': '3221225472\n', '/cg/memory.max': 'max\n', '/cg/memory.stat': `inactive_file ${GIB}\n` }
    const reads: string[] = []
    expect(readHostCgroup('/cg', (p) => (reads.push(p), files[p]!)).workingSetBytes).toBe(2 * GIB)
    expect(reads).toEqual(['/cg/memory.current', '/cg/memory.max', '/cg/memory.stat'])
  })

  test.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [812.4 * MIB, '812.4 MiB'],
    [41 * GIB, '41.0 GiB'],
    [2048 * GIB, '2.0 TiB'],
  ])('formatBytes(%p) is %p', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// The watchdog
// ---------------------------------------------------------------------------

describe('MemoryWatchdog', () => {
  test('start says what it watches and its limits, samples at once and then every 30 s, one watchdog: line each; stop ends the sampling', async () => {
    const h = watchdogHarness(sources())
    h.watchdog.start()
    await h.fake.flush()
    expect(h.log.info).toEqual([
      "watchdog: sampling memory every 30 s into run.log; the run stops when the host working set passes 40.0 GiB or Chrome's PSS passes 4.0 GiB",
    ])
    expect(h.log.detail).toEqual([
      'watchdog: host ws=10.0 GiB cur=12.0 GiB max=64.0 GiB | container mem=1.5GiB / 8GiB pids=120 | chrome pss=1.0 GiB procs=6 pages=1 idle=1 contexts=1 | runner rss=200.0 MiB',
    ])
    await h.fake.advance(90_000)
    expect(h.log.detail.length).toBe(4)
    h.watchdog.stop()
    h.watchdog.stop()
    await h.fake.advance(90_000)
    await h.watchdog.sample()
    expect([h.log.detail.length, h.fake.pendingCount(), h.aborts, h.log.error]).toEqual([4, 0, [], []])
  })

  const HOST_OVER =
    'host working set 41.0 GiB is over the 40.0 GiB limit (memory.current 43.0 GiB minus inactive_file 2.0 GiB; memory.max 64.0 GiB)'
  test.each([
    ['the host working set passes 40 GiB', { host: () => host(41) }, HOST_OVER],
    [
      'the host working set passes 40 GiB, with no memory.max',
      { host: () => host(41, 'max') },
      'host working set 41.0 GiB is over the 40.0 GiB limit (memory.current 43.0 GiB minus inactive_file 2.0 GiB; no memory.max)',
    ],
    [
      "Chrome's PSS passes 4 GiB (two processes counted by RSS)",
      { chrome: () => chrome(4.5, { processes: 12, rssFallbacks: 2 }) },
      "Chrome's process tree PSS 4.5 GiB (12 processes, rss fallback for 2) is over the 4.0 GiB limit",
    ],
    ['the host passes its limit while every other reading fails', { host: () => host(41), container: () => Promise.reject(new Error('docker down')), chrome: () => { throw new Error('no /proc') } }, HOST_OVER],
  ] as Array<[string, Partial<WatchdogSources>, string]>)('when %s, the run is stopped once, with a reason naming the value and the limit, and sampling ends', async (_what, overrides, reason) => {
    const h = watchdogHarness(sources(overrides))
    h.watchdog.start()
    await h.fake.advance(120_000)
    expect(h.aborts).toEqual([reason])
    expect([h.log.detail.length, h.fake.pendingCount()]).toEqual([1, 0])
    expect(h.log.error).toEqual([`watchdog: ${reason}; stopping the run`])
    const report = h.watchdog.report()
    expect([report.abort, report.lines.at(-1)]).toEqual([reason, `stopped the run: ${reason}`])
  })

  test('at exactly its limits nothing is stopped', async () => {
    const h = watchdogHarness(sources({ host: () => host(40), chrome: () => chrome(4) }))
    h.watchdog.start()
    await h.fake.advance(60_000)
    expect([h.aborts, h.log.detail.length]).toEqual([[], 3])
  })

  test('a reading that fails is logged in its line (a URL query dropped) and counted, never stops the run, and sampling goes on; a stopped container is no failure', async () => {
    const failing = sources({
      host: () => {
        throw new Error(`open https://cg.invalid/memory.current?ticket=${LEAK_SENTINEL} failed`)
      },
      container: () => Promise.reject(new Error('docker stats failed (exit 1)')),
      chrome: () => {
        throw new TypeError('no /proc')
      },
      runnerRssBytes: () => {
        throw new Error('no rss')
      },
    })
    const h = watchdogHarness(failing)
    h.watchdog.start()
    await h.fake.advance(30_000)
    expect(h.log.detail).toEqual(
      Array(2).fill(
        'watchdog: host error: Error: open https://cg.invalid/memory.current?<query> failed | container error: Error: docker stats failed (exit 1) | chrome error: TypeError: no /proc | runner error: Error: no rss',
      ),
    )
    expect([h.aborts, h.log.error, h.watchdog.report().failedSamples]).toEqual([[], [], 2])
    const stopped = watchdogHarness(sources({ container: async () => null }))
    await stopped.watchdog.sample()
    expect([stopped.log.detail[0]!.includes('| container not running |'), stopped.watchdog.report().failedSamples]).toEqual([true, 0])
    assertNoLeak(h.log)
  })

  test.each([
    ['line cannot be written', { detail: 'disk full' }, [`watchdog: ${HOST_OVER}; stopping the run`, 'watchdog: a sample failed: Error: disk full'], 0],
    ['onAbort throws', { onAbort: 'exit failed' }, [`watchdog: ${HOST_OVER}; stopping the run`, 'watchdog: stopping the run failed: Error: exit failed'], 1],
    ['line and error lines cannot be written', { detail: 'disk full', error: 'disk full' }, [], 0],
  ] as Array<[string, { detail?: string; error?: string; onAbort?: string }, string[], number]>)(
    'a sample over a limit whose %s still stops the run (the limits are checked before the line), reports what failed where it can, and never throws',
    async (_what, failing, errors, lines) => {
      const fail = (message: string | undefined): void => {
        if (message !== undefined) throw new Error(message)
      }
      const logged = { detail: [] as string[], error: [] as string[] }
      const aborts: string[] = []
      const watchdog = new MemoryWatchdog({
        sources: sources({ host: () => host(41) }),
        log: {
          info: () => undefined,
          detail: (m) => (fail(failing.detail), logged.detail.push(m)),
          error: (m) => (fail(failing.error), logged.error.push(m)),
        },
        onAbort: (reason) => (aborts.push(reason), fail(failing.onAbort)),
      })
      await watchdog.sample()
      expect([aborts, logged.error, logged.detail.length, watchdog.report().abort]).toEqual([[HOST_OVER], errors, lines, HOST_OVER])
    },
  )

  test('a limit crossed by the sample in flight when stop() is called stops nothing: its line is still written (docker stats not read), and stop() settles only after it', async () => {
    const reading = deferred<HostMemory>()
    let containerReads = 0
    const h = watchdogHarness(sources({ host: () => reading.promise, container: async () => (containerReads++, null) }))
    h.watchdog.start()
    // Settles with the number of lines written by then.
    const stopped = h.watchdog.stop().then(() => h.log.detail.length)
    expect([await Promise.race([stopped, h.fake.flush().then(() => 'still stopping')]), h.log.detail]).toEqual(['still stopping', []])
    reading.resolve(host(41))
    expect(await stopped).toBe(1)
    expect(h.log.detail).toEqual([
      'watchdog: host ws=41.0 GiB cur=43.0 GiB max=64.0 GiB | container not read (the watchdog stopped) | chrome pss=1.0 GiB procs=6 pages=1 idle=1 contexts=1 | runner rss=200.0 MiB',
    ])
    const report = h.watchdog.report()
    expect([h.aborts, h.log.error, report.abort, report.failedSamples, containerReads]).toEqual([[], [], null, 0, 0])
    await h.fake.advance(90_000)
    expect([h.log.detail.length, h.fake.pendingCount()]).toEqual([1, 0])
  })

  test('an explicit sample() while a timer sample is in flight waits for it, then takes fresh readings of its own', async () => {
    const first = deferred<HostMemory>()
    let hostReads = 0
    const h = watchdogHarness(sources({ host: () => (++hostReads === 1 ? first.promise : host(12)) }))
    h.watchdog.start()
    const explicit = h.watchdog.sample()
    await h.fake.flush()
    expect([hostReads, h.log.detail]).toEqual([1, []])
    first.resolve(host(10))
    await explicit
    expect(hostReads).toBe(2)
    expect(h.log.detail.map((line) => line.split(' | ')[0])).toEqual(['watchdog: host ws=10.0 GiB cur=12.0 GiB max=64.0 GiB', 'watchdog: host ws=12.0 GiB cur=14.0 GiB max=64.0 GiB'])
    await h.watchdog.stop()
  })

  test.each([
    ['the host working set', { host: () => host(41) }, HOST_OVER],
    ["Chrome's PSS", { chrome: () => chrome(4.5) }, "Chrome's process tree PSS 4.5 GiB (6 processes) is over the 4.0 GiB limit"],
  ] as Array<[string, Partial<WatchdogSources>, string]>)('%s over its limit stops the run at once, never waiting on a docker stats that hangs (not read once stopped)', async (_what, overrides, reason) => {
    let containerReads = 0
    const h = watchdogHarness(sources({ ...overrides, container: () => (containerReads++, new Promise<never>(() => undefined)) }))
    h.watchdog.start()
    await h.fake.flush()
    expect([h.aborts, containerReads]).toEqual([[reason], 0])
    await h.watchdog.stop()
    expect(h.log.detail.map((line) => line.split(' | ')[1])).toEqual(['container not read (the watchdog stopped)'])
  })

  test('a tick while a sample is still reading is skipped, so samples never pile up', async () => {
    let release: () => void = () => undefined
    const slow = sources({ container: () => new Promise((resolve) => (release = () => resolve(null))) })
    const h = watchdogHarness(slow)
    h.watchdog.start()
    await h.fake.advance(90_000)
    expect(h.log.detail).toEqual([])
    release()
    await h.fake.flush()
    expect(h.log.detail.length).toBe(1)
    h.watchdog.stop()
  })

  test('the report keeps each peak with the time of its sample, and how many samples had a failed reading', async () => {
    let containerReads = 0
    const h = watchdogHarness(
      sources({
        host: sequence(host(10), host(20), host(15)),
        chrome: sequence(chrome(1), chrome(0.5, { browser: { contexts: 2, pages: 2, idlePages: 1 } }), chrome(2, { processes: 9 })),
        runnerRssBytes: sequence(100 * MIB, 300 * MIB, 200 * MIB),
        // Not running, then docker failing, then not running again.
        container: async () => {
          if (++containerReads === 2) throw new Error('docker down')
          return null
        },
      }),
    )
    h.watchdog.start()
    await h.fake.advance(60_000)
    h.watchdog.stop()
    const report = h.watchdog.report()
    expect([report.samples, report.failedSamples, report.abort, report.hostMaxBytes]).toEqual([3, 1, null, 64 * GIB])
    expect([report.peaks.hostWorkingSet, report.peaks.chromePss, report.peaks.browserPages, report.peaks.browserContexts, report.peaks.chromeProcesses, report.peaks.runnerRss]).toEqual([
      { value: 20 * GIB, at: at(30) },
      { value: 2 * GIB, at: at(60) },
      { value: 2, at: at(30) },
      { value: 2, at: at(30) },
      { value: 9, at: at(60) },
      { value: 300 * MIB, at: at(30) },
    ])
    expect(report.peaks.containerMem).toBeUndefined()
    expect(report.lines).toEqual([
      '3 samples every 30 s, 1 with a failed reading',
      `host working set peak 20.0 GiB at ${at(30)} (limit 40.0 GiB; memory.max 64.0 GiB)`,
      `host memory.current peak 22.0 GiB at ${at(30)}`,
      'container memory peak not read, PIDs peak not read',
      `Chrome tree PSS peak 2.0 GiB at ${at(60)} (limit 4.0 GiB), processes peak 9 at ${at(60)}, rss fallback peak 0 at ${at(0)}`,
      `browser pages peak 2 at ${at(30)}, contexts peak 2 at ${at(30)}`,
      `runner RSS peak 300.0 MiB at ${at(30)}`,
    ])
  })
})

// ---------------------------------------------------------------------------
// Chrome's process tree (/proc)
// ---------------------------------------------------------------------------

describe("Chrome's process tree", () => {
  test.each([
    ['a plain name', '1234 (chrome) S 1000 1234 1234 0 -1', { comm: 'chrome', ppid: 1000 }],
    ['a name holding spaces and parentheses (it ends at the last one)', '5 (Web (Content) x) S 4 5 5', { comm: 'Web (Content) x', ppid: 4 }],
    ['no parent field', '1 (x)', null],
    ['no name', 'garbage', null],
  ])('parseProcStat: %s', (_what, text, expected) => {
    expect(parseProcStat(text)).toEqual(expected)
  })

  test('parseVmRssBytes and parsePssBytes read kB lines into bytes (Pss, never Pss_Anon); a zombie has no VmRSS (0), a rollup with no Pss is null', () => {
    expect([parseVmRssBytes('Name:\tchrome\nVmRSS:\t    2048 kB\n'), parseVmRssBytes('Name:\tchrome\nState:\tZ (zombie)\n')]).toEqual([2 * MIB, 0])
    expect([parsePssBytes('Rss:  4096 kB\nPss_Anon:  9 kB\nPss:  1024 kB\n'), parsePssBytes('Rss:  4096 kB\n')]).toEqual([MIB, null])
  })

  test("chromeTreePss sums the PSS of the runner's Chrome descendants only (through any parent), an unreadable rollup counted by its RSS, a process gone mid-scan skipped", () => {
    // pid: [comm, ppid, Pss MiB or null (unreadable rollup), VmRSS MiB or null (gone), program]
    const table: Record<number, [string, number, number | null, number | null, string]> = {
      100: ['bun', 1, 50, 50, '/usr/bin/bun'],
      200: ['chrome', 100, 300, 500, '/opt/google/chrome/chrome'],
      201: ['chrome', 200, 50, 80, '/opt/google/chrome/chrome'],
      202: ['chrome', 201, null, 400, '/opt/google/chrome/chrome'],
      203: ['ThreadPoolForeg', 200, 20, 30, '/opt/google/chrome/chrome --type=utility'],
      204: ['chrome', 200, null, null, '/opt/google/chrome/chrome'],
      205: ['chrome_crashpad', 200, 5, 8, '/opt/google/chrome/chrome_crashpad_handler'],
      206: ['node', 200, 70, 90, '/usr/bin/node'],
      300: ['bash', 100, 3, 4, '/bin/bash'],
      301: ['chrome', 300, 10, 12, '/opt/google/chrome/chrome'],
      400: ['chrome', 1, 900, 1000, '/opt/google/chrome/chrome'],
    }
    const row = (pid: number) => table[pid]
    const reader: ProcReader = {
      pids: () => Object.keys(table).map(Number),
      stat: (pid) => (row(pid) ? `${pid} (${row(pid)![0]}) S ${row(pid)![1]} 0 0` : null),
      smapsRollup: (pid) => (row(pid)?.[2] == null ? null : `Rss: 1 kB\nPss: ${row(pid)![2]! * 1024} kB\n`),
      status: (pid) => (row(pid)?.[3] == null ? null : `VmRSS:\t${row(pid)![3]! * 1024} kB\n`),
      cmdline: (pid) => row(pid)?.[4] ?? null,
    }
    // 200, 201, 202 (by RSS), 203 (by its program), 205 and 301 (under bash); never 100, 204 (gone), 206, 300 or 400 (not the runner's).
    expect(chromeTreePss(100, reader)).toEqual({ pssBytes: (300 + 50 + 400 + 20 + 5 + 10) * MIB, rssFallbacks: 1, processes: 6 })
    expect(chromeTreePss(999, reader)).toEqual({ pssBytes: 0, rssFallbacks: 0, processes: 0 })
  })
})
