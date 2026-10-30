import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { THREAD_MEMORY_RETRY_MIN_MS, THREAD_MEMORY_RETRY_MAX_MS } from '../src/delivery-constants.ts'
import { metadataRetryDelay } from '../src/thread-memory.ts'
import {
  createThreadMemoryRetries,
  type ThreadMemoryRetries,
  type ThreadMemoryRetriesDeps,
  type ThreadMemoryRetryEvent,
} from '../src/thread-memory-retry.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { THREAD_PERSONAS } from './test-helpers/thread-memory.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { objectProperties, onlyCallArguments, runtimeSpecifiers, stripComments } from './test-helpers/source-audit.ts'

const P = THREAD_PERSONAS.primary, Q = THREAD_PERSONAS.secondary
type Series = 'append' | 'read' | 'seal'
type Call = { operation: 'flush' | 'retryRead' | 'sealFlush' | 'firstRead'; key?: string; at: number }
const fixtures: { clock: FakeClock; retries: ThreadMemoryRetries; calls: Call[]; events: ThreadMemoryRetryEvent[]; steps: string[] }[] = []
const consoleOutput: unknown[][] = [], restoreConsole: (() => void)[] = []

beforeEach(() => {
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    const spy = spyOn(console, method).mockImplementation((...args: unknown[]) => { consoleOutput.push(args) })
    restoreConsole.push(() => spy.mockRestore())
  }
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

function fixture(overrides: Partial<ThreadMemoryRetriesDeps> = {}, clock = createFakeClock()) {
  const calls: Call[] = [], events: ThreadMemoryRetryEvent[] = [], steps: string[] = []
  const retries = createThreadMemoryRetries({
    canRun: overrides.canRun,
    clock: overrides.clock ?? clock,
    flush: async key => {
      calls.push({ operation: 'flush', key, at: clock.now() })
      return overrides.flush ? overrides.flush(key) : { kind: 'saved' }
    },
    retryRead: async key => {
      calls.push({ operation: 'retryRead', key, at: clock.now() })
      return overrides.retryRead ? overrides.retryRead(key) : 'read'
    },
    sealFlush: async () => {
      calls.push({ operation: 'sealFlush', at: clock.now() })
      return overrides.sealFlush ? overrides.sealFlush() : { kind: 'written' }
    },
    firstRead: async (key, current) => {
      calls.push({ operation: 'firstRead', key, at: clock.now() })
      await overrides.firstRead?.(key, current)
    },
    onEvent(event) {
      events.push(event)
      return overrides.onEvent?.(event)
    },
  })
  const h = { clock, retries, calls, events, steps }
  fixtures.push(h)
  return h
}

afterEach(() => {
  try {
    // Every case must finish or explicitly cancel its work, before cleanup.
    for (const { clock } of fixtures) expect(clock.pendingCount()).toBe(0)
  } finally {
    try {
      for (const { retries } of fixtures) { retries.stopKeys(); retries.stopSeal() }
      assertNoLeak({ consoleOutput, fixtures: fixtures.map(({ calls, events, steps }) => ({ calls, events, steps })) })
      // This scheduler emits typed events; even safe console output is unexpected.
      expect(consoleOutput).toEqual([])
    } finally {
      for (const restore of restoreConsole) restore()
      restoreConsole.length = 0
      consoleOutput.length = 0
      fixtures.length = 0
    }
  }
})

function start(retries: ThreadMemoryRetries, series: Series, key = P as string) {
  if (series === 'append') retries.appendFailed(key)
  else if (series === 'read') retries.readFailed(key)
  else retries.sealWriteFailed()
}
function started(series: Series): ThreadMemoryRetryEvent {
  return series === 'seal' ? { type: 'seal-retry-started' } : { type: `${series}-retry-started`, key: P }
}
function recovered(series: Series, attempts: number): Extract<ThreadMemoryRetryEvent, { attempts: number }> {
  return series === 'seal' ? { type: 'seal-written-after-retries', attempts }
    : { type: series === 'append' ? 'saved-after-retries' : 'read-after-retries', key: P, attempts }
}
function stop(retries: ThreadMemoryRetries) { retries.stopKeys(); retries.stopSeal() }

describe('Thread Memory background retries', () => {
  test('pins the specified minimum, doubling and cap once', () => {
    expect(THREAD_MEMORY_RETRY_MIN_MS).toBe(5_000)
    expect(THREAD_MEMORY_RETRY_MAX_MS).toBe(60_000)
    expect([1, 2, 3, 4, 5, 6, 7].map(n => metadataRetryDelay(n))).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
    ])
  })

  test('construction is inert and its only runtime imports are the wait and spacing dependencies', async () => {
    const h = fixture()
    await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    expect(h.calls).toEqual([])
    expect(h.events).toEqual([])
    const code = stripComments(readFileSync(new URL('../src/thread-memory-retry.ts', import.meta.url), 'utf8'))
    expect(runtimeSpecifiers(code)).toEqual(['./ad-settings.ts', './thread-memory.ts'])
  })

  test.each(['append', 'read', 'seal'] as const)('%s waits never end early, double to the cap, stay capped, and reset on success', async series => {
    let succeeds = false
    const h = fixture({
      flush: async () => ({ kind: succeeds ? 'saved' : 'failed' }),
      retryRead: async () => succeeds ? 'read' : 'unreadable',
      sealFlush: async () => succeeds ? { kind: 'written' } : { kind: 'failed', error: undefined, unsynced: true },
    })
    start(h.retries, series)
    const attempts = 7
    for (let n = 1; n <= attempts; n++) {
      const delay = metadataRetryDelay(n)
      expect(h.clock.pending()).toEqual([{ id: n, delayMs: delay, dueAt: h.clock.now() + delay, scheduledAt: h.clock.now() }])
      await h.clock.advance(delay - 1)
      expect(h.calls).toHaveLength(n - 1)
      expect(h.events).toEqual([started(series)])
      succeeds = n === attempts
      await h.clock.advance(1)
      expect(h.calls.filter(call => call.operation !== 'firstRead')).toHaveLength(n)
    }
    expect(h.events).toEqual([started(series), recovered(series, attempts)])
    expect(h.calls.filter(call => call.operation === 'firstRead')).toHaveLength(series === 'read' ? 1 : 0)
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    expect(h.events).toHaveLength(2)
    start(h.retries, series)
    expect(h.clock.pending().map(timer => timer.delayMs)).toEqual([THREAD_MEMORY_RETRY_MIN_MS])
    await h.clock.runNext()
    expect(h.events).toEqual([started(series), recovered(series, attempts), started(series), recovered(series, 1)])
  })

  test.each(['append', 'read', 'seal'] as const)('%s repeated failure notifications do not move a timer or overlap an attempt', async series => {
    const gate = deferred()
    const h = fixture({
      flush: async () => { await gate.promise; return { kind: 'failed' } },
      retryRead: async () => { await gate.promise; return 'unreadable' },
      sealFlush: async () => { await gate.promise; return { kind: 'failed', error: undefined, unsynced: false } },
    })
    start(h.retries, series)
    const original = h.clock.pending()
    await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS / 2)
    for (let n = 0; n < 4; n++) start(h.retries, series)
    expect(h.clock.pending()).toEqual(original)
    await h.clock.runNext()
    expect(h.calls).toHaveLength(1)
    for (let n = 0; n < 4; n++) start(h.retries, series)
    await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.calls).toHaveLength(1)
    gate.resolve()
    await h.clock.flush()
    const next = h.clock.pending()
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ delayMs: metadataRetryDelay(2), scheduledAt: h.clock.now() })
    start(h.retries, series)
    expect(h.clock.pending()).toEqual(next)
    expect(h.events).toEqual([started(series)])
    stop(h.retries)
  })

  test.each(['append', 'read', 'seal'] as const)('%s synchronous throws and rejected promises count as failed attempts', async series => {
    let attempts = 0
    const failTwice = () => {
      attempts++
      if (attempts === 1) throw new Error(sentinelInMessage('synchronous-failure'))
      if (attempts === 2) return Promise.reject(new Error(sentinelInMessage('rejection')))
      return Promise.resolve()
    }
    const h = fixture({
      flush: () => failTwice().then(() => ({ kind: 'saved' })),
      retryRead: () => failTwice().then(() => 'read'),
      sealFlush: () => failTwice().then(() => ({ kind: 'written' })),
    })
    start(h.retries, series)
    for (let n = 1; n <= 3; n++) {
      expect(h.clock.pending().map(timer => timer.delayMs)).toEqual([metadataRetryDelay(n)])
      await h.clock.runNext()
    }
    expect(h.events).toEqual([started(series), recovered(series, 3)])
  })

  test('a missing read ends once, never runs firstRead, and leaves another key and the append series independent', async () => {
    const h = fixture({ retryRead: async key => key === P ? 'missing' : 'read' })
    h.retries.readFailed(P)
    h.retries.readFailed(Q)
    h.retries.appendFailed(P)
    await h.clock.runNext()
    expect(h.calls).toEqual([
      { operation: 'retryRead', key: P, at: THREAD_MEMORY_RETRY_MIN_MS },
      { operation: 'retryRead', key: Q, at: THREAD_MEMORY_RETRY_MIN_MS },
      { operation: 'firstRead', key: Q, at: THREAD_MEMORY_RETRY_MIN_MS },
      { operation: 'flush', key: P, at: THREAD_MEMORY_RETRY_MIN_MS },
    ])
    expect(h.events).toEqual([
      { type: 'read-retry-started', key: P }, { type: 'read-retry-started', key: Q },
      { type: 'append-retry-started', key: P }, { type: 'journal-missing-on-retry', key: P },
      { type: 'read-after-retries', key: Q, attempts: 1 }, { type: 'saved-after-retries', key: P, attempts: 1 },
    ])
    await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS * 3)
    expect(h.calls).toHaveLength(4)
  })

  test('a kept append retries, while cancelled append and skipped/stopped seal outcomes end silently', async () => {
    let result: 'kept' | 'cancelled' = 'kept'
    const h = fixture({ flush: async () => ({ kind: result }), sealFlush: async () => ({ kind: 'skipped' }) })
    h.retries.appendFailed(P)
    await h.clock.runNext()
    expect(h.clock.pending().map(timer => timer.delayMs)).toEqual([metadataRetryDelay(2)])
    result = 'cancelled'
    await h.clock.runNext()
    h.retries.sealWriteFailed()
    await h.clock.runNext()
    expect(h.events).toEqual([{ type: 'append-retry-started', key: P }, { type: 'seal-retry-started' }])
    const stopped = fixture({ sealFlush: async () => ({ kind: 'stopped' }) })
    stopped.retries.sealWriteFailed()
    await stopped.clock.runNext()
    expect(stopped.events).toEqual([{ type: 'seal-retry-started' }])
  })

  test.each(['append', 'read', 'seal'] as const)('a stuck %s never blocks another key or another series on the same key', async stuck => {
    const gate = deferred()
    const h = fixture({
      flush: async key => { if (stuck === 'append' && key === P) await gate.promise; return { kind: 'saved' } },
      retryRead: async key => { if (stuck === 'read' && key === P) await gate.promise; return 'read' },
      sealFlush: async () => { if (stuck === 'seal') await gate.promise; return { kind: 'written' } },
    })
    // Start the stuck operation first to catch serialization behind it.
    start(h.retries, stuck)
    for (const key of [P, Q]) { h.retries.appendFailed(key); h.retries.readFailed(key) }
    h.retries.sealWriteFailed()
    expect(h.clock.pendingCount()).toBe(5)
    await h.clock.runNext()
    expect(h.calls.filter(call => call.operation !== 'firstRead')).toHaveLength(5)
    expect(h.events.filter(event => 'attempts' in event)).toHaveLength(4)
    expect(h.events).toContainEqual({ type: 'saved-after-retries', key: Q, attempts: 1 })
    expect(h.events).toContainEqual({ type: 'read-after-retries', key: Q, attempts: 1 })
    expect(h.events).not.toContainEqual(recovered(stuck, 1))
    gate.resolve()
    await h.clock.flush()
    expect(h.events.filter(event => 'attempts' in event)).toHaveLength(5)
    expect(h.events).toContainEqual(recovered(stuck, 1))
  })

  test('different failure counts remain independent across keys, append/read, and the shared seal', async () => {
    const h = fixture({
      flush: async () => ({ kind: 'failed' }), retryRead: async () => 'unreadable',
      sealFlush: async () => ({ kind: 'failed', error: undefined, unsynced: false }),
    })
    h.retries.appendFailed(P)
    await h.clock.runNext()
    h.retries.readFailed(P)
    h.retries.appendFailed(Q)
    h.retries.sealWriteFailed()
    expect(h.clock.pending().map(timer => timer.delayMs)).toEqual([
      metadataRetryDelay(1), metadataRetryDelay(1), metadataRetryDelay(1), metadataRetryDelay(2),
    ])
    await h.clock.runNext()
    expect(h.calls.map(call => call.operation)).toEqual(['flush', 'retryRead', 'flush', 'sealFlush'])
    await h.clock.runNext()
    expect(h.calls.at(-1)).toEqual({ operation: 'flush', key: P, at: metadataRetryDelay(1) + metadataRetryDelay(2) })
    expect(h.events).toEqual([
      { type: 'append-retry-started', key: P }, { type: 'read-retry-started', key: P },
      { type: 'append-retry-started', key: Q }, { type: 'seal-retry-started' },
    ])
    stop(h.retries)
  })

  test('a closed live gate refuses new key ownership, leaving siblings and the shared seal independent', async () => {
    const blocked = new Set<string>([P])
    const h = fixture({ canRun: key => !blocked.has(key) })
    for (let n = 0; n < 3; n++) { h.retries.appendFailed(P); h.retries.readFailed(P) }
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.events).toEqual([])
    h.retries.appendFailed(Q)
    h.retries.readFailed(Q)
    h.retries.sealWriteFailed()
    await h.clock.runNext()
    expect(h.calls.map(call => [call.operation, call.key])).toEqual([
      ['flush', Q], ['retryRead', Q], ['firstRead', Q], ['sealFlush', undefined],
    ])
    blocked.delete(P)
    h.retries.appendFailed(P)
    h.retries.readFailed(P)
    expect(h.clock.pending().map(timer => timer.delayMs)).toEqual([
      THREAD_MEMORY_RETRY_MIN_MS, THREAD_MEMORY_RETRY_MIN_MS,
    ])
    await h.clock.runNext()
    expect(h.events.filter(event => 'key' in event && event.key === P)).toEqual([
      started('append'), started('read'), recovered('append', 1), recovered('read', 1),
    ])
  })

  test('the live gate is rechecked at a pending deadline and forget releases the blocked ownership', async () => {
    let allowed = true
    const h = fixture({ canRun: key => key !== P || allowed })
    h.retries.appendFailed(P)
    h.retries.readFailed(P)
    const before = [...h.events]
    allowed = false
    await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    expect(h.calls).toEqual([])
    expect(h.events).toEqual(before)
    expect(h.clock.pendingCount()).toBe(0)
    h.retries.forget(P)
    const cancelled = [...h.events]
    expect(cancelled.slice(before.length)).toEqual([
      { type: 'retry-cancelled', series: 'append', key: P, why: 'teardown' },
      { type: 'retry-cancelled', series: 'read', key: P, why: 'teardown' },
    ])
    h.retries.appendFailed(P)
    h.retries.readFailed(P)
    h.retries.forget(P)
    expect(h.events).toEqual(cancelled)
    expect(h.clock.pendingCount()).toBe(0)
    allowed = true
    h.retries.appendFailed(P)
    h.retries.readFailed(P)
    await h.clock.runNext()
    expect(h.events.filter(event => 'attempts' in event)).toEqual([recovered('append', 1), recovered('read', 1)])
  })

  for (const series of ['append', 'read'] as const) {
    test.each(['failed', 'saved', 'thrown'] as const)(`${series} ignores an in-flight %s outcome once the live gate closes`, async outcome => {
      const gate = deferred()
      let allowed = true, oldLife = true
      const wait = async () => {
        if (!oldLife) return false
        await gate.promise
        if (outcome === 'thrown') throw new Error(sentinelInMessage('blocked-outcome'))
        return outcome === 'failed'
      }
      const h = fixture({
        canRun: key => key !== P || allowed,
        flush: async () => ({ kind: await wait() ? 'failed' : 'saved' }),
        retryRead: async () => await wait() ? 'unreadable' : 'read',
      })
      start(h.retries, series)
      await h.clock.runNext()
      allowed = false
      gate.resolve()
      await h.clock.flush()
      expect(h.calls).toHaveLength(1)
      expect(h.events).toEqual([started(series)])
      expect(h.clock.pendingCount()).toBe(0)
      h.retries.forget(P)
      start(h.retries, series)
      h.retries.forget(P)
      expect(h.events).toEqual([
        started(series), { type: 'retry-cancelled', series, key: P, why: 'teardown' },
      ])
      expect(h.clock.pendingCount()).toBe(0)
      allowed = true
      oldLife = false
      start(h.retries, series)
      expect(h.clock.pending().map(timer => timer.delayMs)).toEqual([THREAD_MEMORY_RETRY_MIN_MS])
      await h.clock.runNext()
      expect(h.events.filter(event => 'attempts' in event)).toEqual([recovered(series, 1)])
      expect(h.calls.filter(call => call.operation === 'firstRead')).toHaveLength(series === 'read' ? 1 : 0)
    })
  }

  test.each(['teardown', 'removal'] as const)('forget(%s) cancels only that key; callbacks delivered after cancellation cannot flush it', async why => {
    const clock = createFakeClock(), callbacks: (() => void)[] = []
    const h = fixture({ clock: {
      now: clock.now, clearTimeout: clock.clearTimeout,
      setTimeout(callback, delay) { callbacks.push(callback); return clock.setTimeout(callback, delay) },
    } }, clock)
    h.retries.appendFailed(P)
    h.retries.readFailed(P)
    const cancelledCallbacks = [...callbacks]
    h.retries.appendFailed(Q)
    h.retries.readFailed(Q)
    h.retries.sealWriteFailed()
    if (why === 'teardown') h.retries.forget(P)
    else h.retries.forget(P, why)
    h.retries.forget(P, why)
    expect(h.clock.pendingCount()).toBe(3)
    await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    for (const callback of cancelledCallbacks) callback()
    await h.clock.flush()
    expect(h.calls.filter(call => call.key === P)).toEqual([])
    expect(h.calls.map(call => call.operation)).toEqual(['flush', 'retryRead', 'firstRead', 'sealFlush'])
    expect(h.events.filter(event => event.type === 'retry-cancelled')).toEqual([
      { type: 'retry-cancelled', series: 'append', key: P, why },
      { type: 'retry-cancelled', series: 'read', key: P, why },
    ])
  })

  test('stopKeys cancels all keys and refuses new work while the seal keeps retrying', async () => {
    let written = false
    const h = fixture({ sealFlush: async () => written ? { kind: 'written' } : { kind: 'failed', error: undefined, unsynced: false } })
    for (const key of [P, Q]) { h.retries.appendFailed(key); h.retries.readFailed(key) }
    h.retries.sealWriteFailed()
    h.retries.stopKeys()
    h.retries.stopKeys()
    h.retries.appendFailed(P)
    h.retries.readFailed(Q)
    expect(h.clock.pendingCount()).toBe(1)
    await h.clock.runNext()
    expect(h.calls).toEqual([{ operation: 'sealFlush', at: metadataRetryDelay(1) }])
    expect(h.clock.pending().map(timer => timer.delayMs)).toEqual([metadataRetryDelay(2)])
    written = true
    await h.clock.runNext()
    expect(h.events.filter(event => event.type === 'retry-cancelled')).toEqual([P, Q].flatMap(key => [
      { type: 'retry-cancelled', series: 'append', key, why: 'shutdown' },
      { type: 'retry-cancelled', series: 'read', key, why: 'shutdown' },
    ]))
    expect(h.events.at(-1)).toEqual({ type: 'seal-written-after-retries', attempts: 2 })
  })

  test('stopSeal refuses new seal work and stale callbacks, while keys finish normally', async () => {
    const clock = createFakeClock(), callbacks: (() => void)[] = []
    const h = fixture({ clock: {
      now: clock.now, clearTimeout: clock.clearTimeout,
      setTimeout(callback, delay) { callbacks.push(callback); return clock.setTimeout(callback, delay) },
    } }, clock)
    h.retries.sealWriteFailed()
    const cancelled = callbacks[0]!
    h.retries.appendFailed(P)
    h.retries.readFailed(P)
    h.retries.stopSeal()
    h.retries.stopSeal()
    h.retries.sealWriteFailed()
    await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    cancelled()
    await h.clock.flush()
    expect(h.calls.map(call => call.operation)).toEqual(['flush', 'retryRead', 'firstRead'])
    expect(h.events.filter(event => event.type === 'retry-cancelled')).toEqual([
      { type: 'retry-cancelled', series: 'seal', why: 'shutdown' },
    ])
  })

  test('shutdown does not await in-flight attempts and their later failures cannot restart any series', async () => {
    const gate = deferred()
    const h = fixture({
      flush: async () => { await gate.promise; return { kind: 'failed' } },
      retryRead: async () => { await gate.promise; return 'unreadable' },
      sealFlush: async () => { await gate.promise; return { kind: 'failed', error: undefined, unsynced: false } },
    })
    for (const series of ['append', 'read', 'seal'] as const) start(h.retries, series)
    await h.clock.runNext()
    expect(h.calls).toHaveLength(3)
    stop(h.retries)
    expect(h.events.filter(event => event.type === 'retry-cancelled')).toEqual([
      { type: 'retry-cancelled', series: 'append', key: P, why: 'shutdown' },
      { type: 'retry-cancelled', series: 'read', key: P, why: 'shutdown' },
      { type: 'retry-cancelled', series: 'seal', why: 'shutdown' },
    ])
    const stoppedEvents = [...h.events]
    gate.resolve()
    await h.clock.flush()
    for (const series of ['append', 'read', 'seal'] as const) start(h.retries, series)
    await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    expect(h.calls).toHaveLength(3)
    expect(h.events).toEqual(stoppedEvents)
  })

  for (const series of ['append', 'read', 'seal'] as const) {
    test.each(['failed', 'saved', 'thrown'] as const)(`${series} ignores a late %s outcome after cancellation, including replacement-life ownership`, async outcome => {
      const gate = deferred()
      let attempts = 0
      const waitOld = async () => {
        if (++attempts !== 1) return false
        await gate.promise
        if (outcome === 'thrown') throw new Error('late failure')
        return outcome === 'failed'
      }
      const h = fixture({
        flush: async () => ({ kind: await waitOld() ? 'failed' : 'saved' }),
        retryRead: async () => await waitOld() ? 'unreadable' : 'read',
        sealFlush: async () => await waitOld() ? { kind: 'failed', error: undefined, unsynced: false } : { kind: 'written' },
      })
      start(h.retries, series)
      await h.clock.runNext()
      expect(h.calls).toHaveLength(1)
      if (series === 'seal') h.retries.stopSeal()
      else h.retries.forget(P, 'removal')
      const cancelledEvents = [...h.events]
      // A new lifecycle for the same key must not be altered by the old result.
      start(h.retries, series)
      const replacementTimers = h.clock.pending()
      expect(replacementTimers).toHaveLength(series === 'seal' ? 0 : 1)
      gate.resolve()
      await h.clock.flush()
      expect(h.clock.pending()).toEqual(replacementTimers)
      expect(h.events).toEqual(series === 'seal' ? cancelledEvents : [...cancelledEvents, started(series)])
      await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
      expect(h.calls.filter(call => call.operation !== 'firstRead')).toHaveLength(series === 'seal' ? 1 : 2)
      expect(h.events.filter(event => 'attempts' in event)).toEqual(series === 'seal' ? [] : [recovered(series, 1)])
    })
  }

  test.each(['throw', 'reject'] as const)('a reporter that %s cannot interrupt starts, recovery, or cancellation', async behavior => {
    const h = fixture({ onEvent() {
      if (behavior === 'throw') throw new Error(sentinelInMessage('observer-failed'))
      return Promise.reject(new Error(sentinelInMessage('observer-rejected')))
    } })
    for (const series of ['append', 'read', 'seal'] as const) start(h.retries, series)
    await h.clock.runNext()
    expect(h.events.filter(event => 'attempts' in event)).toHaveLength(3)
    for (const series of ['append', 'read', 'seal'] as const) start(h.retries, series)
    stop(h.retries)
    await h.clock.flush()
    expect(h.events.filter(event => event.type === 'retry-cancelled')).toHaveLength(3)
  })
})

// Execute the actual inline firstRead adapter, never server main or a copied
// implementation of its ordering/error isolation. The source audit helpers
// fail closed if the call or property is missing/ambiguous.
const serverCode = stripComments(readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'))
const firstReadCode = objectProperties(onlyCallArguments(serverCode, 'createThreadMemoryRetries')).get('firstRead')!
function productionFirstRead(bindings: Record<string, unknown>): ThreadMemoryRetriesDeps['firstRead'] {
  const js = ts.transpileModule(`const callback = (${firstReadCode});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(bindings), `${js}\nreturn callback;`)(...Object.values(bindings))
}

describe('successful read through the production firstRead adapter', () => {
  test.each(['none', 'recovery', 'resolve', 'both', 'flush-failed', 'flush-throws'] as const)('ordered recovery, live holds and saving, with %s failure', async failure => {
    const holds = deferred()
    const h = fixture({ firstRead: (key, current) => adapter(key, current) })
    const { steps } = h
    const adapter = productionFirstRead({
      shuttingDown: false, getAppliedPersona: () => ({ key: P }), threadMemoryRetries: h.retries,
      threadMemory: {
        retryPendingJoins(key: string) {
          steps.push(`recover:${key}`)
          if (failure === 'recovery' || failure === 'both') throw new Error(sentinelInMessage('recovery-failed'))
        },
        async flush(key: string) {
          steps.push(`flush:${key}`)
          if (failure === 'flush-throws') throw new Error(sentinelInMessage('flush-failed'))
          return { kind: failure === 'flush-failed' ? 'failed' : 'saved' }
        },
      },
      memoryHolds: { async resolve(key: string, phase: string) {
        steps.push(`resolve:${key}:${phase}`)
        await holds.promise
        if (failure === 'resolve' || failure === 'both') throw new Error(sentinelInMessage('resolution-failed'))
      } },
    })
    h.retries.readFailed(P)
    await h.clock.runNext()
    expect(steps).toEqual([`recover:${P}`, `resolve:${P}:live`])
    expect(h.events).toEqual([{ type: 'read-retry-started', key: P }])
    expect(h.clock.pendingCount()).toBe(0)
    holds.resolve()
    await h.clock.flush()
    expect(steps).toEqual([`recover:${P}`, `resolve:${P}:live`, `flush:${P}`])
    const flushFailed = failure === 'flush-failed' || failure === 'flush-throws'
    expect(h.events).toEqual([
      { type: 'read-retry-started', key: P },
      ...(flushFailed ? [{ type: 'append-retry-started' as const, key: P }] : []),
      { type: 'read-after-retries', key: P, attempts: 1 },
    ])
    if (flushFailed) {
      expect(h.clock.pending().map(timer => timer.delayMs)).toEqual([THREAD_MEMORY_RETRY_MIN_MS])
      await h.clock.runNext()
      expect(h.events.at(-1)).toEqual({ type: 'saved-after-retries', key: P, attempts: 1 })
    }
    await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    expect(h.calls.filter(call => call.operation === 'firstRead')).toHaveLength(1)
    expect(steps).toHaveLength(3)
  })

  for (const stage of ['resolve', 'flush-fails', 'flush-throws'] as const) {
    test.each(['teardown', 'removal', 'shutdown', 'live-gate'] as const)(`cancellation during ${stage} prevents the old adapter continuing or reporting after %s`, async why => {
      const gate = deferred()
      let oldCurrent!: () => boolean, firstLife = true, allowed = true
      const h = fixture({ canRun: () => allowed, firstRead: async (key, current) => {
        if (firstLife) { oldCurrent = current; await adapter(key, current) }
      } })
      const { steps } = h
      const adapter = productionFirstRead({
        shuttingDown: false, getAppliedPersona: () => ({ key: P }), threadMemoryRetries: h.retries,
        threadMemory: {
          retryPendingJoins(key: string) { steps.push(`recover:${key}`) },
          async flush(key: string) {
            steps.push(`flush:${key}`)
            await gate.promise
            if (stage === 'flush-throws') throw new Error(sentinelInMessage('late-flush-failure'))
            return { kind: 'failed' }
          },
        },
        memoryHolds: { async resolve(key: string, phase: string) {
          steps.push(`resolve:${key}:${phase}`)
          if (stage === 'resolve') await gate.promise
        } },
      })
      h.retries.readFailed(P)
      await h.clock.runNext()
      expect(oldCurrent()).toBe(true)
      expect(steps).toHaveLength(stage === 'resolve' ? 2 : 3)
      if (why === 'shutdown') h.retries.stopKeys()
      else if (why === 'live-gate') allowed = false
      else h.retries.forget(P, why)
      expect(oldCurrent()).toBe(false)
      if (why === 'live-gate') expect(h.events).toEqual([started('read')])
      else expect(h.events.at(-1)).toEqual({ type: 'retry-cancelled', series: 'read', key: P, why })
      firstLife = false
      h.retries.readFailed(P)
      const replacement = h.clock.pending()
      expect(replacement).toHaveLength(why === 'shutdown' || why === 'live-gate' ? 0 : 1)
      const beforeCompletion = [...h.events]
      gate.resolve()
      await h.clock.flush()
      expect(h.events).toEqual(beforeCompletion)
      expect(h.clock.pending()).toEqual(replacement)
      expect(steps).toHaveLength(stage === 'resolve' ? 2 : 3)
      if (why === 'live-gate') {
        // The predicate fences work, while teardown still owns forgetting it.
        h.retries.forget(P)
        h.retries.forget(P)
        expect(h.events.filter(event => event.type === 'retry-cancelled')).toEqual([
          { type: 'retry-cancelled', series: 'read', key: P, why: 'teardown' },
        ])
        allowed = true
        expect(oldCurrent()).toBe(false)
        h.retries.readFailed(P)
        expect(h.clock.pending().map(timer => timer.delayMs)).toEqual([THREAD_MEMORY_RETRY_MIN_MS])
      }
      await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
      expect(h.events.filter(event => event.type === 'read-after-retries')).toEqual(
        why === 'shutdown' ? [] : [{ type: 'read-after-retries', key: P, attempts: 1 }],
      )
      expect(h.calls.filter(call => call.operation === 'flush')).toEqual([])
      expect(oldCurrent()).toBe(false)
    })
  }

  test('a throwing firstRead is not retried and cannot block another successful read', async () => {
    const h = fixture({ firstRead(key) { if (key === P) throw new Error('adapter failed') } })
    h.retries.readFailed(P)
    h.retries.readFailed(Q)
    await h.clock.runNext()
    expect(h.events.filter(event => event.type === 'read-after-retries')).toEqual([
      { type: 'read-after-retries', key: P, attempts: 1 }, { type: 'read-after-retries', key: Q, attempts: 1 },
    ])
    await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    expect(h.calls.filter(call => call.operation === 'firstRead').map(call => call.key)).toEqual([P, Q])
  })
})
