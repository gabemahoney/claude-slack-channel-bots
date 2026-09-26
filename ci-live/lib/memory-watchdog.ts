/**
 * memory-watchdog.ts — the run's memory watchdog.
 *
 * A live run once froze the whole VM (a pod capped at 64 GiB): its server log
 * stopped mid-check while the container still showed "running". The cause is
 * unknown, so the runner watches memory itself. Every WATCHDOG_INTERVAL_MS it
 * samples:
 * - the host (pod) cgroup: `memory.current`, `memory.max`, and `inactive_file`
 *   from `memory.stat`; the working set is `memory.current - inactive_file`
 *   (as the kubelet counts it: page cache the kernel can drop is not use);
 * - the test container: `docker stats` (memory use / limit and PIDs);
 * - Chrome: its process tree's summed PSS (lib/proc-tree.ts; a process
 *   whose PSS can't be read counts its RSS, and the line says how many did)
 *   and the browser's open contexts and pages;
 * - the runner's own RSS.
 * Each sample is one `watchdog:` line in run.log. The peaks are kept and
 * reported at the end (run.log, results.json and results.md).
 *
 * It aborts the run (through `onAbort`, which the runner routes to the same
 * stop path as a signal) when the host working set crosses
 * HOST_WORKING_SET_LIMIT_BYTES or Chrome's tree PSS crosses
 * CHROME_PSS_LIMIT_BYTES. The two readings with a limit come first (the host,
 * then Chrome) and each is checked as soon as it arrives, before the slow
 * `docker stats` (skipped once the watchdog has stopped) and before the
 * sample's line is written, so neither a slow reading nor a line that can't
 * be written delays or prevents an abort. A reading that fails (docker stats
 * erroring, no cgroup v2 files) is logged in its sample's line and never
 * aborts.
 *
 * One sample at a time: a timer tick while one is in flight is skipped; an
 * explicit `sample()` waits for it and then takes fresh readings. `stop()`
 * settles once a sample in flight has written its line, and no line comes
 * after it.
 *
 * The clock, the sources and the thresholds are injected, so tests drive
 * every branch without timers, /sys or docker.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { BrowserStats } from './browser-types.ts'
import type { ContainerStats } from './docker.ts'
import { describeError } from './errors.ts'

export const GIB = 1024 ** 3

export const WATCHDOG_INTERVAL_MS = 30_000

/**
 * Abort when the host cgroup's working set crosses this: well below the
 * 64 GiB pod limit, leaving room for the production bots and the other
 * sessions on the host, so the run stops itself long before the pod thrashes.
 */
export const HOST_WORKING_SET_LIMIT_BYTES = 40 * GIB

/**
 * Abort when Chrome's process tree PSS crosses this. The runner keeps one
 * page per signed-in account, idle on about:blank between flows, with a
 * 1 GiB V8 heap cap and at most two renderers (browser/driver.ts), so a
 * healthy run stays well under it; 4 GiB means something is running away.
 */
export const CHROME_PSS_LIMIT_BYTES = 4 * GIB

export interface WatchdogThresholds {
  hostWorkingSetBytes: number
  chromePssBytes: number
}

export const DEFAULT_WATCHDOG_THRESHOLDS: WatchdogThresholds = {
  hostWorkingSetBytes: HOST_WORKING_SET_LIMIT_BYTES,
  chromePssBytes: CHROME_PSS_LIMIT_BYTES,
}

/** A size for a log line: `812.4 MiB`, `41.2 GiB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

// ---------------------------------------------------------------------------
// The host cgroup
// ---------------------------------------------------------------------------

export interface HostMemory {
  currentBytes: number
  /** `memory.max`, or `null` for `max` (no limit). */
  maxBytes: number | null
  inactiveFileBytes: number
  /** `currentBytes - inactiveFileBytes`, never below 0. */
  workingSetBytes: number
}

function cgroupNumber(text: string, what: string): number {
  const t = text.trim()
  if (!/^[0-9]{1,20}$/.test(t)) throw new Error(`${what} is not a number`)
  return Number(t)
}

/** The host's memory from the cgroup v2 files' text. Throws when one does not parse. */
export function parseHostCgroup(current: string, max: string, stat: string): HostMemory {
  const currentBytes = cgroupNumber(current, 'memory.current')
  const maxBytes = max.trim() === 'max' ? null : cgroupNumber(max, 'memory.max')
  const m = /^inactive_file ([0-9]{1,20})$/m.exec(stat)
  if (!m) throw new Error('memory.stat has no inactive_file')
  const inactiveFileBytes = Number(m[1])
  return { currentBytes, maxBytes, inactiveFileBytes, workingSetBytes: Math.max(0, currentBytes - inactiveFileBytes) }
}

/** The cgroup v2 root this process sees (the pod's). */
export const CGROUP_DIR = '/sys/fs/cgroup'

export function readHostCgroup(dir: string = CGROUP_DIR, read: (path: string) => string = (p) => readFileSync(p, 'utf-8')): HostMemory {
  return parseHostCgroup(read(join(dir, 'memory.current')), read(join(dir, 'memory.max')), read(join(dir, 'memory.stat')))
}

// ---------------------------------------------------------------------------
// The watchdog
// ---------------------------------------------------------------------------

export interface ChromeMemory {
  /** The tree's summed PSS, with each of the `rssFallbacks` processes counted by its RSS. */
  pssBytes: number
  /** How many processes' PSS could not be read, so counted by RSS. */
  rssFallbacks: number
  processes: number
  /** The browser's contexts and pages, or `null` when no browser is open. */
  browser: BrowserStats | null
}

export interface WatchdogSources {
  host(): HostMemory | Promise<HostMemory>
  /** The test container's reading, or `null` when it is not running. */
  container(): Promise<ContainerStats | null>
  chrome(): ChromeMemory | Promise<ChromeMemory>
  runnerRssBytes(): number
}

export interface WatchdogClock {
  now(): number
  /** Call `tick` every `ms` until the returned function is called. */
  every(ms: number, tick: () => void): () => void
}

export const realWatchdogClock: WatchdogClock = {
  now: () => Date.now(),
  every(ms, tick) {
    const timer = setInterval(tick, ms)
    // The watchdog never keeps the process alive on its own.
    ;(timer as { unref?: () => void }).unref?.()
    return () => clearInterval(timer)
  },
}

export interface WatchdogOptions {
  sources: WatchdogSources
  log: { info(message: string): void; detail(message: string): void; error(message: string): void }
  /** Stop the run: called once, with what crossed its threshold, the value and the threshold. */
  onAbort(reason: string): void
  clock?: WatchdogClock
  thresholds?: WatchdogThresholds
  intervalMs?: number
}

export interface WatchdogPeak {
  value: number
  /** ISO time of the sample. */
  at: string
}

export type PeakName =
  | 'hostWorkingSet'
  | 'hostCurrent'
  | 'containerMem'
  | 'containerPids'
  | 'chromePss'
  | 'chromeRssFallbacks'
  | 'chromeProcesses'
  | 'browserContexts'
  | 'browserPages'
  | 'runnerRss'

export interface WatchdogReport {
  intervalMs: number
  samples: number
  /** Samples in which at least one reading failed. */
  failedSamples: number
  thresholds: WatchdogThresholds
  /** The host cgroup's `memory.max` at the last good reading (`null`: no limit, or never read). */
  hostMaxBytes: number | null
  peaks: Partial<Record<PeakName, WatchdogPeak>>
  /** Why the watchdog stopped the run, or `null`. */
  abort: string | null
  /** The peaks as lines (run.log and results.md). */
  lines: string[]
}

type Reading<T> = { ok: true; value: T } | { ok: false; error: string }

async function read<T>(source: () => T | Promise<T>): Promise<Reading<T>> {
  try {
    return { ok: true, value: await source() }
  } catch (err) {
    return { ok: false, error: describeError(err) }
  }
}

export class MemoryWatchdog {
  private readonly clock: WatchdogClock
  private readonly thresholds: WatchdogThresholds
  private readonly intervalMs: number
  private cancel: (() => void) | null = null
  /** The sample in flight (it never rejects), or `null`. */
  private inFlight: Promise<void> | null = null
  private stopped = false
  private samples = 0
  private failedSamples = 0
  private hostMaxBytes: number | null = null
  private readonly peaks: Partial<Record<PeakName, WatchdogPeak>> = {}
  private abortReason: string | null = null

  constructor(private readonly o: WatchdogOptions) {
    this.clock = o.clock ?? realWatchdogClock
    this.thresholds = o.thresholds ?? DEFAULT_WATCHDOG_THRESHOLDS
    this.intervalMs = o.intervalMs ?? WATCHDOG_INTERVAL_MS
  }

  /** Sample now, then every interval, until `stop` (or an abort). */
  start(): void {
    if (this.cancel || this.stopped) return
    const t = this.thresholds
    this.o.log.info(
      `watchdog: sampling memory every ${Math.round(this.intervalMs / 1000)} s into run.log; the run stops when the host working set passes ${formatBytes(t.hostWorkingSetBytes)} or Chrome's PSS passes ${formatBytes(t.chromePssBytes)}`,
    )
    this.cancel = this.clock.every(this.intervalMs, () => void this.tick())
    void this.tick()
  }

  /**
   * Stop sampling. Settles once a sample in flight has written its line (it
   * no longer aborts, and skips `docker stats` if it has not read it yet): no
   * watchdog line is written after that. Idempotent.
   */
  stop(): Promise<void> {
    this.stopped = true
    this.cancel?.()
    this.cancel = null
    return this.inFlight ?? Promise.resolve()
  }

  /**
   * Take one sample now, with fresh readings: when one is in flight (a
   * timer's), after it has finished. Nothing after `stop` or an abort.
   */
  async sample(): Promise<void> {
    while (this.inFlight) await this.inFlight
    if (this.stopped) return
    await this.begin()
  }

  /** A timer's sample: skipped while one is in flight, and after `stop` or an abort. */
  private tick(): Promise<void> {
    if (this.inFlight || this.stopped) return Promise.resolve()
    return this.begin()
  }

  private begin(): Promise<void> {
    const sample = this.guardedSample().finally(() => {
      this.inFlight = null
    })
    this.inFlight = sample
    return sample
  }

  private async guardedSample(): Promise<void> {
    try {
      await this.takeSample()
    } catch (err) {
      // A sample that fails as a whole (its line could not be written) is reported; an abort it made stands.
      try {
        this.o.log.error(`watchdog: a sample failed: ${describeError(err)}`)
      } catch {
        /* ignore: the log is what failed */
      }
    }
  }

  private peak(name: PeakName, value: number, at: string): void {
    const current = this.peaks[name]
    if (!current || value > current.value) this.peaks[name] = { value, at }
  }

  /** Abort on what crossed its limit, unless the watchdog has stopped (or already aborted). */
  private check(crossed: string | null): void {
    if (crossed && !this.stopped) this.abort(crossed)
  }

  private async takeSample(): Promise<void> {
    const at = new Date(this.clock.now()).toISOString()
    const sources = this.o.sources
    // The readings with a limit first, each checked as soon as it arrives: an abort never waits on docker stats.
    const host = await read(() => sources.host())
    if (host.ok) this.check(this.hostCrossed(host.value))
    const chrome = await read(() => sources.chrome())
    if (chrome.ok) this.check(this.chromeCrossed(chrome.value))
    // Once stopped (an abort included), the sample ends without waiting on docker stats.
    const container = this.stopped ? null : await read(() => sources.container())
    const runner = await read(() => sources.runnerRssBytes())
    const parts: string[] = []

    if (host.ok) {
      const h = host.value
      this.hostMaxBytes = h.maxBytes
      this.peak('hostWorkingSet', h.workingSetBytes, at)
      this.peak('hostCurrent', h.currentBytes, at)
      parts.push(`host ws=${formatBytes(h.workingSetBytes)} cur=${formatBytes(h.currentBytes)} max=${h.maxBytes === null ? 'max' : formatBytes(h.maxBytes)}`)
    } else parts.push(`host error: ${host.error}`)

    if (container === null) parts.push('container not read (the watchdog stopped)')
    else if (container.ok && container.value) {
      const c = container.value
      this.peak('containerMem', c.memBytes, at)
      this.peak('containerPids', c.pids, at)
      parts.push(`container mem=${c.memUsage} pids=${c.pids}`)
    } else parts.push(container.ok ? 'container not running' : `container error: ${container.error}`)

    if (chrome.ok) {
      const c = chrome.value
      const pages = c.browser?.pages ?? 0
      const idle = c.browser?.idlePages ?? 0
      const contexts = c.browser?.contexts ?? 0
      this.peak('chromePss', c.pssBytes, at)
      this.peak('chromeRssFallbacks', c.rssFallbacks, at)
      this.peak('chromeProcesses', c.processes, at)
      this.peak('browserPages', pages, at)
      this.peak('browserContexts', contexts, at)
      const fallback = c.rssFallbacks > 0 ? ` (rss fallback for ${c.rssFallbacks})` : ''
      parts.push(`chrome pss=${formatBytes(c.pssBytes)}${fallback} procs=${c.processes} pages=${pages} idle=${idle} contexts=${contexts}`)
    } else parts.push(`chrome error: ${chrome.error}`)

    if (runner.ok) {
      this.peak('runnerRss', runner.value, at)
      parts.push(`runner rss=${formatBytes(runner.value)}`)
    } else parts.push(`runner error: ${runner.error}`)

    this.samples += 1
    if (!host.ok || (container !== null && !container.ok) || !chrome.ok || !runner.ok) this.failedSamples += 1
    // Written after the limits were checked: a line that can't be written never holds back an abort.
    this.o.log.detail(`watchdog: ${parts.join(' | ')}`)
  }

  /** Why the host's working set is over its limit, or `null`. */
  private hostCrossed(host: HostMemory): string | null {
    const t = this.thresholds
    if (host.workingSetBytes <= t.hostWorkingSetBytes) return null
    const max = host.maxBytes === null ? 'no memory.max' : `memory.max ${formatBytes(host.maxBytes)}`
    return (
      `host working set ${formatBytes(host.workingSetBytes)} is over the ${formatBytes(t.hostWorkingSetBytes)} limit ` +
      `(memory.current ${formatBytes(host.currentBytes)} minus inactive_file ${formatBytes(host.inactiveFileBytes)}; ${max})`
    )
  }

  /** Why Chrome's PSS is over its limit, or `null`. */
  private chromeCrossed(chrome: ChromeMemory): string | null {
    const t = this.thresholds
    if (chrome.pssBytes <= t.chromePssBytes) return null
    const fallback = chrome.rssFallbacks > 0 ? `, rss fallback for ${chrome.rssFallbacks}` : ''
    return `Chrome's process tree PSS ${formatBytes(chrome.pssBytes)} (${chrome.processes} processes${fallback}) is over the ${formatBytes(t.chromePssBytes)} limit`
  }

  /** Stop sampling and stop the run, once. A log line that can't be written never prevents the `onAbort` call. */
  private abort(reason: string): void {
    this.abortReason = reason
    void this.stop()
    try {
      this.o.log.error(`watchdog: ${reason}; stopping the run`)
    } catch {
      /* ignore: the run is stopped all the same */
    }
    try {
      this.o.onAbort(reason)
    } catch (err) {
      try {
        this.o.log.error(`watchdog: stopping the run failed: ${describeError(err)}`)
      } catch {
        /* ignore: the log is what failed */
      }
    }
  }

  report(): WatchdogReport {
    const p = this.peaks
    const size = (name: PeakName): string => {
      const v = p[name]
      return v ? `${formatBytes(v.value)} at ${v.at}` : 'not read'
    }
    const count = (name: PeakName): string => {
      const v = p[name]
      return v ? `${v.value} at ${v.at}` : 'not read'
    }
    const t = this.thresholds
    const lines = [
      `${this.samples} samples every ${Math.round(this.intervalMs / 1000)} s, ${this.failedSamples} with a failed reading`,
      `host working set peak ${size('hostWorkingSet')} (limit ${formatBytes(t.hostWorkingSetBytes)}; memory.max ${this.hostMaxBytes === null ? 'max or not read' : formatBytes(this.hostMaxBytes)})`,
      `host memory.current peak ${size('hostCurrent')}`,
      `container memory peak ${size('containerMem')}, PIDs peak ${count('containerPids')}`,
      `Chrome tree PSS peak ${size('chromePss')} (limit ${formatBytes(t.chromePssBytes)}), processes peak ${count('chromeProcesses')}, rss fallback peak ${count('chromeRssFallbacks')}`,
      `browser pages peak ${count('browserPages')}, contexts peak ${count('browserContexts')}`,
      `runner RSS peak ${size('runnerRss')}`,
    ]
    if (this.abortReason) lines.push(`stopped the run: ${this.abortReason}`)
    return {
      intervalMs: this.intervalMs,
      samples: this.samples,
      failedSamples: this.failedSamples,
      thresholds: { ...t },
      hostMaxBytes: this.hostMaxBytes,
      peaks: { ...p },
      abort: this.abortReason,
      lines,
    }
  }
}
