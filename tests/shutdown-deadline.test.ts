/**
 * shutdown-deadline.test.ts — The bounded fallback exit for a shutdown that
 * nothing else ends (b.jg5 SRJ-205, AC 21: a stop by the runtime version
 * re-check exits non-zero even when `shutdown()` hangs).
 *
 * `armShutdownDeadline` is driven on `createFakeClock()` with a recording
 * `exit` and `log`, so no process ends and no real timer is armed. Where
 * `main()` arms it (the re-check's stop, with `process.exit` and no clock or
 * deadline override) is pinned by the source audit in
 * tests/server-startup-wiring.test.ts.
 *
 * Every exit code, deadline and line is imported from `src/` or built from
 * those values; one case pins the deadline to 30 s.
 *
 * No process, no real HOME, no real timer, no top-level mock.module().
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'

import {
  SHUTDOWN_DEADLINE_MS,
  armShutdownDeadline,
  buildShutdownDeadlineLine,
  type ShutdownDeadlineClock,
} from '../src/shutdown-deadline.ts'
import { AD_VERSION_RECHECK_STOP_EXIT_CODE } from '../src/ad-version-gate.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'

/** What the deadline did, in order: each line logged and each exit asked for. */
type DeadlineEvent = readonly ['log', string] | readonly ['exit', number]

interface DeadlineRigOptions {
  exitCode?: number
  /** Omitted: the module's default deadline applies. */
  deadlineMs?: number
  /** The log sink; by default it records the line. */
  log?: (line: string, events: DeadlineEvent[]) => void
  /** The timers the deadline gets, built over the rig's fake clock; the fake clock itself by default. */
  wrapClock?: (clock: FakeClock) => ShutdownDeadlineClock
}

/**
 * One armed deadline on its own fake clock, with an `exit` and a `log` that
 * record into one ordered event list. The fake clock's `clearTimeout` calls
 * are counted through the timers handed to the deadline.
 */
function makeDeadlineRig(opts: DeadlineRigOptions = {}) {
  const clock = createFakeClock()
  const events: DeadlineEvent[] = []
  const exitCode = opts.exitCode ?? AD_VERSION_RECHECK_STOP_EXIT_CODE
  const timers = opts.wrapClock?.(clock) ?? clock
  let clears = 0
  const log = opts.log ?? ((line: string) => { events.push(['log', line]) })
  const cancel = armShutdownDeadline({
    exitCode,
    exit: (code) => { events.push(['exit', code]) },
    log: (line) => log(line, events),
    clock: {
      setTimeout: (callback, delayMs) => timers.setTimeout(callback, delayMs),
      clearTimeout: (handle) => {
        clears++
        timers.clearTimeout(handle)
      },
    },
    ...(opts.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs }),
  })
  return { clock, events, exitCode, cancel, clearCount: () => clears }
}

/** The events of a deadline that ran out: its one line, then its one exit. */
function expiredEvents(deadlineMs: number, exitCode: number): DeadlineEvent[] {
  return [['log', buildShutdownDeadlineLine(deadlineMs, exitCode)], ['exit', exitCode]]
}

describe('SHUTDOWN_DEADLINE_MS', () => {
  // The CLI stop's default stop_timeout (the grace a signal-driven shutdown
  // gets before SIGKILL) is 30 s, but src/ exports no constant for it (the
  // loader's default and the CLI's fallback are inline literals), so the
  // deadline is pinned to 30 s here.
  test('is positive and pinned to 30 s, the CLI stop\'s default stop_timeout', () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThan(0)
    expect(SHUTDOWN_DEADLINE_MS).toBe(30_000)
  })
})

describe('buildShutdownDeadlineLine', () => {
  test('is one [slack] line naming the deadline in seconds and the exit code, and carries no token', () => {
    const line = buildShutdownDeadlineLine(SHUTDOWN_DEADLINE_MS, AD_VERSION_RECHECK_STOP_EXIT_CODE)
    expect(line.startsWith('[slack] ')).toBe(true)
    expect(line).not.toMatch(/[\r\n\u2028\u2029]/)
    expect(line).toContain(`${SHUTDOWN_DEADLINE_MS / 1000} s`)
    expect(line).toContain(`code ${AD_VERSION_RECHECK_STOP_EXIT_CODE}`)
    assertNoLeak(line)
  })
})

describe('armShutdownDeadline (b.jg5 SRJ-205, AC 21)', () => {
  test('arming arms one timer at the default deadline and neither logs nor exits, even after pending microtasks run', async () => {
    const rig = makeDeadlineRig()
    expect(rig.events).toEqual([])
    await rig.clock.flush()
    expect(rig.events).toEqual([])
    expect(rig.clock.pending().map((t) => t.delayMs)).toEqual([SHUTDOWN_DEADLINE_MS])
  })

  // The second row's exit code differs from the re-check's, so a deadline
  // that exits with a fixed code instead of the one it was given fails.
  test.each([
    { label: 'the default deadline and the re-check\'s stop code', deadlineMs: undefined, exitCode: AD_VERSION_RECHECK_STOP_EXIT_CODE },
    { label: 'a custom deadline and another non-zero code', deadlineMs: SHUTDOWN_DEADLINE_MS / 4, exitCode: AD_VERSION_RECHECK_STOP_EXIT_CODE + 1 },
  ])('with $label: nothing just under the deadline; at it, one line then one exit with that code; nothing after', async ({ deadlineMs, exitCode }) => {
    const rig = makeDeadlineRig({ deadlineMs, exitCode })
    const due = deadlineMs ?? SHUTDOWN_DEADLINE_MS
    await rig.clock.advance(due - 1)
    expect(rig.events).toEqual([])
    await rig.clock.advance(1)
    expect(rig.events).toEqual(expiredEvents(due, exitCode))
    expect(rig.clock.pendingCount()).toBe(0)
    await rig.clock.advance(due * 10)
    expect(rig.events).toEqual(expiredEvents(due, exitCode))
    assertNoLeak(rig.events)
  })

  test('cancel before expiry clears the timer: nothing fires, however far the clock moves, and a second cancel does nothing', async () => {
    const rig = makeDeadlineRig()
    await rig.clock.advance(SHUTDOWN_DEADLINE_MS - 1)
    rig.cancel()
    expect(rig.clock.pendingCount()).toBe(0)
    expect(rig.clearCount()).toBe(1)
    rig.cancel()
    expect(rig.clearCount()).toBe(1)
    await rig.clock.advance(SHUTDOWN_DEADLINE_MS * 10)
    expect(rig.events).toEqual([])
    expect(rig.clock.firedCount()).toBe(0)
  })

  test('cancel after the deadline ran out is a no-op: no clear, no second line or exit', async () => {
    const rig = makeDeadlineRig()
    await rig.clock.advance(SHUTDOWN_DEADLINE_MS)
    rig.cancel()
    rig.cancel()
    expect(rig.clearCount()).toBe(0)
    await rig.clock.advance(SHUTDOWN_DEADLINE_MS * 10)
    expect(rig.events).toEqual(expiredEvents(SHUTDOWN_DEADLINE_MS, rig.exitCode))
  })

  test('a log sink that throws cannot stop the exit: the line is offered once and the exit still runs once, with the code', async () => {
    const rig = makeDeadlineRig({
      log: (line, events) => {
        events.push(['log', line])
        throw new Error('log sink failed')
      },
    })
    await rig.clock.advance(SHUTDOWN_DEADLINE_MS)
    expect(rig.events).toEqual(expiredEvents(SHUTDOWN_DEADLINE_MS, rig.exitCode))
  })

  // A real timer handle has `unref`; the fake clock's `{ id }` has none. Each
  // row hands the deadline a handle of one shape over the rig's fake clock
  // (the fake `clearTimeout` reads only `id`), and the deadline must still
  // fire at its time and cancel cleanly.
  test.each([
    { shape: 'no unref (the fake clock\'s own handle)', unref: undefined },
    { shape: 'an unref function', unref: () => {} },
    { shape: 'an unref that throws', unref: () => { throw new Error('unref failed') } },
  ])('a timer handle with $shape: unref is called once when present, and the deadline still fires and cancels', async ({ unref }) => {
    const unrefCalls: unknown[] = []
    const wrapClock = (clock: FakeClock): ShutdownDeadlineClock => ({
      setTimeout: (callback, delayMs) => {
        const handle = clock.setTimeout(callback, delayMs)
        if (unref === undefined) return handle
        return {
          ...handle,
          unref(this: unknown) {
            unrefCalls.push(this)
            unref()
          },
        }
      },
      clearTimeout: (handle) => clock.clearTimeout(handle),
    })

    const fires = makeDeadlineRig({ wrapClock })
    expect(unrefCalls).toHaveLength(unref === undefined ? 0 : 1)
    // Called as the handle's own method, not detached.
    for (const self of unrefCalls) expect(self).toHaveProperty('id')
    expect(fires.events).toEqual([])
    await fires.clock.advance(SHUTDOWN_DEADLINE_MS)
    expect(fires.events).toEqual(expiredEvents(SHUTDOWN_DEADLINE_MS, fires.exitCode))

    const cancelled = makeDeadlineRig({ wrapClock })
    cancelled.cancel()
    expect(cancelled.clock.pendingCount()).toBe(0)
    await cancelled.clock.advance(SHUTDOWN_DEADLINE_MS * 10)
    expect(cancelled.events).toEqual([])
  })
})
