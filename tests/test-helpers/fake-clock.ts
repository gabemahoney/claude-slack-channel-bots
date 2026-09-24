/**
 * test-helpers/fake-clock.ts — A manual clock and timer driver for code that
 * takes its clock and timers as injected dependencies (b.av2 SR-13.1).
 *
 * The connection manager takes its clock and timers by injection, so suites
 * that need virtual time (the 10 s bound on a `start()` that never settles,
 * reopen backoff, many backoff steps) pass this helper rather than using Bun's
 * global fake timers, and never sleep.
 *
 * `createFakeClock()` returns one independent clock. Its `now`, `setTimeout`
 * and `clearTimeout` satisfy `PersonaConnectionClock` from
 * `src/persona-connections.ts` structurally, so a test passes the clock as is,
 * with no cast. Virtual time moves only when the test calls `advance`,
 * `advanceTo` or `runNext`.
 *
 * Delay handling mirrors Bun and Node: a delay that is not a number from 1 to
 * 2^31 - 1 (0, negative, NaN, infinite or too large) runs after 1 ms. The
 * requested delay is still reported as `delayMs`, so a test can assert on what
 * the code asked for and still see an overflowing delay fire at once.
 *
 * Microtask guarantee: before the first firing, after every firing and after
 * the clock reaches its target, the clock yields `flushTurns` microtask turns
 * (default `DEFAULT_FLUSH_TURNS`). Every promise continuation chain that needs
 * no more than that many turns and waits on nothing outside the microtask
 * queue therefore finishes before the next timer fires and before the call
 * returns. Stub promises that are already settled count; a real timer, I/O or
 * a `never` stub outcome does not. `flush()` yields the same turns without
 * moving time.
 *
 * Isolation: no module-scope state, no real timers, no file system, network or
 * environment access, and no source import.
 *
 * SPDX-License-Identifier: MIT
 */

/** Microtask turns yielded around each firing unless the caller sets its own. */
export const DEFAULT_FLUSH_TURNS = 50

/** Largest delay a real timer honours; larger ones run after 1 ms. */
const MAX_REAL_TIMER_DELAY_MS = 2_147_483_647

/** The opaque handle `setTimeout` returns; pass it back to `clearTimeout`. */
export interface FakeTimerHandle {
  readonly id: number
}

/** A pending timer as a test sees it. */
export interface PendingFakeTimer {
  /** Scheduling order, from 1. Timers due at the same time fire in this order. */
  readonly id: number
  /** The delay the code asked for, as passed to `setTimeout`. */
  readonly delayMs: number
  /** Virtual time at which the timer fires. */
  readonly dueAt: number
  /** Virtual time at which the timer was scheduled. */
  readonly scheduledAt: number
}

export interface FakeClockOptions {
  /** Starting virtual time in ms. Default 0. */
  start?: number
  /** Microtask turns yielded around each firing. Default `DEFAULT_FLUSH_TURNS`. */
  flushTurns?: number
}

export interface FakeClock {
  /** Current virtual time in ms. */
  now(): number
  /** Schedule `callback` after `delayMs` of virtual time. */
  setTimeout(callback: () => void, delayMs: number): FakeTimerHandle
  /** Cancel a pending timer. Unknown, fired or already cleared handles are ignored. */
  clearTimeout(handle: unknown): void
  /**
   * Move virtual time forward by `ms`, firing every timer that falls due by
   * then in due-time order, including timers scheduled by callbacks during the
   * advance. Resolves with the number of timers fired. A callback that throws
   * rejects the call, with time left at that timer's due time.
   */
  advance(ms: number): Promise<number>
  /** As `advance`, to an absolute virtual time no earlier than `now()`. */
  advanceTo(time: number): Promise<number>
  /**
   * Move virtual time to the earliest pending timer and fire every timer due
   * then. Resolves with the number fired, 0 when nothing is pending.
   */
  runNext(): Promise<number>
  /** Yield the microtask turns without moving time. */
  flush(): Promise<void>
  /** Pending timers, earliest first. A snapshot: later changes do not show. */
  pending(): PendingFakeTimer[]
  /** Number of pending timers. */
  pendingCount(): number
  /** Callbacks fired so far. */
  firedCount(): number
}

interface TimerEntry extends PendingFakeTimer {
  readonly callback: () => void
}

function effectiveDelay(delayMs: number): number {
  const delay = Number(delayMs)
  return delay >= 1 && delay <= MAX_REAL_TIMER_DELAY_MS ? delay : 1
}

function byDueThenId(a: PendingFakeTimer, b: PendingFakeTimer): number {
  return a.dueAt - b.dueAt || a.id - b.id
}

/** Build one independent fake clock. */
export function createFakeClock(options: FakeClockOptions = {}): FakeClock {
  const flushTurns = options.flushTurns ?? DEFAULT_FLUSH_TURNS
  if (!Number.isInteger(flushTurns) || flushTurns < 0) {
    throw new RangeError(`fake clock: flushTurns must be a non-negative integer, got ${flushTurns}`)
  }
  let time = options.start ?? 0
  if (!Number.isFinite(time)) throw new RangeError(`fake clock: start must be finite, got ${time}`)
  let nextId = 1
  let fired = 0
  const timers = new Map<number, TimerEntry>()

  async function flush(): Promise<void> {
    for (let turn = 0; turn < flushTurns; turn++) await Promise.resolve()
  }

  function earliestDue(limit: number): TimerEntry | undefined {
    let earliest: TimerEntry | undefined
    for (const timer of timers.values()) {
      if (timer.dueAt > limit) continue
      if (earliest === undefined || byDueThenId(timer, earliest) < 0) earliest = timer
    }
    return earliest
  }

  async function advanceTo(target: number): Promise<number> {
    if (!Number.isFinite(target) || target < time) {
      throw new RangeError(`fake clock: cannot move from ${time} to ${target}`)
    }
    let count = 0
    await flush()
    for (let timer = earliestDue(target); timer !== undefined; timer = earliestDue(target)) {
      timers.delete(timer.id)
      time = timer.dueAt
      fired++
      count++
      timer.callback()
      await flush()
    }
    time = target
    await flush()
    return count
  }

  return {
    now: () => time,

    setTimeout(callback, delayMs) {
      const id = nextId++
      timers.set(id, { id, delayMs, dueAt: time + effectiveDelay(delayMs), scheduledAt: time, callback })
      return { id }
    },

    clearTimeout(handle) {
      if (typeof handle !== 'object' || handle === null || !('id' in handle)) return
      const { id } = handle
      if (typeof id === 'number') timers.delete(id)
    },

    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) {
        return Promise.reject(new RangeError(`fake clock: advance needs a finite, non-negative ms, got ${ms}`))
      }
      return advanceTo(time + ms)
    },

    advanceTo,

    async runNext() {
      await flush()
      const next = earliestDue(Infinity)
      if (next === undefined) return 0
      return advanceTo(next.dueAt)
    },

    flush,

    pending: () =>
      [...timers.values()]
        .sort(byDueThenId)
        .map(({ id, delayMs, dueAt, scheduledAt }) => ({ id, delayMs, dueAt, scheduledAt })),

    pendingCount: () => timers.size,

    firedCount: () => fired,
  }
}
