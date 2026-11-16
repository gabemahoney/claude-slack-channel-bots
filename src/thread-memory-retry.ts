/** Independent background retries. Construction owns no timers or I/O. */
import { armNeverEarlyWait, type NeverEarlyWaitClock } from './ad-settings.ts'
import { metadataRetryDelay, type ThreadMemoryReadResult, type ThreadMemoryWriteResult } from './thread-memory.ts'
import type { ThreadMemorySealWriteResult } from './thread-memory-seal.ts'

export type ThreadMemoryRetryCancellation = 'teardown' | 'removal' | 'shutdown'
export type ThreadMemoryRetryEvent =
  | { type: 'append-retry-started' | 'read-retry-started' | 'journal-missing-on-retry'; key: string }
  | { type: 'saved-after-retries' | 'read-after-retries'; key: string; attempts: number }
  | { type: 'seal-retry-started' }
  | { type: 'seal-written-after-retries'; attempts: number }
  | { type: 'retry-cancelled'; series: 'append' | 'read'; key: string; why: ThreadMemoryRetryCancellation }
  | { type: 'retry-cancelled'; series: 'seal'; why: ThreadMemoryRetryCancellation }
export interface ThreadMemoryRetriesDeps {
  /** The lifecycle's live gate; teardown must also forget existing ownership. */
  canRun?(key: string): boolean
  flush(key: string): Promise<ThreadMemoryWriteResult>
  retryRead(key: string): Promise<ThreadMemoryReadResult>
  sealFlush(): Promise<ThreadMemorySealWriteResult>
  /** Recover pending candidates, resolve holds, then flush; isolate each step.
   * Recheck current after every await so an old read never enters a new life. */
  firstRead(key: string, current: () => boolean): void | Promise<void>
  clock: NeverEarlyWaitClock
  onEvent?(event: ThreadMemoryRetryEvent): void
}
export interface ThreadMemoryRetries {
  appendFailed(key: string): void
  readFailed(key: string): void
  sealWriteFailed(): void
  forget(key: string, why?: 'teardown' | 'removal'): void
  stopKeys(): void
  stopSeal(): void
}
interface Series { failures: number; attempts: number; cancel?: () => void }
export function createThreadMemoryRetries(deps: ThreadMemoryRetriesDeps): ThreadMemoryRetries {
  const appends = new Map<string, Series>(), reads = new Map<string, Series>()
  // Retain a read's ownership through firstRead, including its asynchronous steps.
  const firstReads = new Map<string, Series>()
  let seal: Series | undefined, keysStopped = false, sealStopped = false
  const active = (key: string) => !keysStopped && (deps.canRun?.(key) ?? true)
  function event(value: ThreadMemoryRetryEvent): void {
    try { void Promise.resolve(deps.onEvent?.(value)).catch(() => {}) } catch { /* observers cannot affect retries */ }
  }
  function arm(series: Series, current: () => boolean, attempt: () => Promise<void>): void {
    if (!current()) return
    series.cancel = armNeverEarlyWait(deps.clock, deps.clock.now(), metadataRetryDelay(series.failures), () => {
      series.cancel = undefined
      if (current()) void attempt().catch(() => { if (current()) { series.failures++; arm(series, current, attempt) } })
    })
  }
  function appendFailed(key: string): void {
    if (!active(key) || appends.has(key)) return
    const series: Series = { failures: 1, attempts: 0 }
    appends.set(key, series)
    const current = () => active(key) && appends.get(key) === series
    const attempt = async () => {
      series.attempts++
      let result: ThreadMemoryWriteResult
      try { result = await deps.flush(key) } catch { result = { kind: 'failed' } }
      if (!current()) return
      if (result.kind === 'saved' || result.kind === 'cancelled') {
        appends.delete(key)
        if (result.kind === 'saved') event({ type: 'saved-after-retries', key, attempts: series.attempts })
      } else { series.failures++; arm(series, current, attempt) }
    }
    event({ type: 'append-retry-started', key })
    arm(series, current, attempt)
  }
  function readFailed(key: string): void {
    if (!active(key) || reads.has(key)) return
    const series: Series = { failures: 1, attempts: 0 }
    reads.set(key, series)
    const current = () => active(key) && reads.get(key) === series
    const attempt = async () => {
      series.attempts++
      let result: ThreadMemoryReadResult
      try { result = await deps.retryRead(key) } catch { result = 'unreadable' }
      if (!current()) return
      if (result === 'unreadable') { series.failures++; arm(series, current, attempt); return }
      reads.delete(key)
      if (result === 'missing') { event({ type: 'journal-missing-on-retry', key }); return }
      firstReads.set(key, series)
      const stillCurrent = () => active(key) && firstReads.get(key) === series
      try { await deps.firstRead(key, stillCurrent) } catch { /* adapter owns each step's failure */ }
      if (!stillCurrent()) return
      firstReads.delete(key)
      event({ type: 'read-after-retries', key, attempts: series.attempts })
    }
    event({ type: 'read-retry-started', key })
    arm(series, current, attempt)
  }
  function sealWriteFailed(): void {
    if (sealStopped || seal) return
    const series: Series = { failures: 1, attempts: 0 }
    seal = series
    const current = () => !sealStopped && seal === series
    const attempt = async () => {
      series.attempts++
      let result: ThreadMemorySealWriteResult
      try { result = await deps.sealFlush() } catch { result = { kind: 'failed', error: undefined, unsynced: false } }
      if (!current()) return
      if (result.kind === 'failed') { series.failures++; arm(series, current, attempt); return }
      seal = undefined
      if (result.kind === 'written') event({ type: 'seal-written-after-retries', attempts: series.attempts })
    }
    event({ type: 'seal-retry-started' })
    arm(series, current, attempt)
  }
  function forget(key: string, why: ThreadMemoryRetryCancellation = 'teardown'): void {
    for (const [kind, map] of [['append', appends], ['read', reads], ['read', firstReads]] as const) {
      const series = map.get(key)
      if (!series) continue
      map.delete(key); series.cancel?.()
      event({ type: 'retry-cancelled', series: kind, key, why })
    }
  }
  return {
    appendFailed, readFailed, sealWriteFailed, forget,
    stopKeys() {
      keysStopped = true
      for (const key of new Set([...appends.keys(), ...reads.keys(), ...firstReads.keys()])) forget(key, 'shutdown')
    },
    stopSeal() {
      sealStopped = true
      const series = seal
      seal = undefined; series?.cancel?.()
      if (series) event({ type: 'retry-cancelled', series: 'seal', why: 'shutdown' })
    },
  }
}
