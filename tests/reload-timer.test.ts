/**
 * reload-timer.test.ts — Unit tests for the production reload detection timer
 * (`createReloadTickDriver`, b.av2 SR-8.2): one serialized, self-re-arming 5 s
 * setTimeout chain in the `cron-scheduler.ts` pattern.
 *
 * Driven only through the shared fake clock (`createFakeClock`): no real timer
 * is armed, no time passes and nothing sleeps. The tick is a recording stub
 * whose promise the test settles, so a slow pass is held open on purpose.
 * Every test runs `assertNoLeak` over the lines the driver logged.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from 'bun:test'
import { createReloadTickDriver, RELOAD_TICK_INTERVAL_MS } from '../src/reload-timer.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { assertNoLeak, REDACTED_SENTINEL_TAIL, sentinelInMessage } from './test-helpers/credentials.ts'

/** The prefix of both single-use log lines; the distinguishing phrase follows it. */
const SINGLE_USE_PREFIX = '[slack] reload: detection timer start()'
const SECOND_START = 'more than once'
const START_AFTER_STOP = 'after stop()'

/** `lines` is exactly one single-use line: the prefix, then `phrase`. */
function expectOneSingleUseLine(lines: string[], phrase: string): void {
  expect(lines).toHaveLength(1)
  expect(lines[0]!.startsWith(SINGLE_USE_PREFIX)).toBe(true)
  expect(lines[0]!).toContain(phrase)
}

/** A tick whose outcome each call takes from `next` (default: resolves at once). */
function makeTick(clock: { now(): number }) {
  const calls: number[] = []
  let inFlight = 0
  let maxInFlight = 0
  let next: () => Promise<void> = () => Promise.resolve()
  // Not async, so an outcome that throws synchronously reaches the driver as a synchronous throw.
  const tick = (): Promise<void> => {
    calls.push(clock.now())
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    let outcome: Promise<void>
    try {
      outcome = next()
    } catch (err) {
      inFlight--
      throw err
    }
    return outcome.finally(() => {
      inFlight--
    })
  }
  return {
    tick,
    calls,
    maxInFlight: () => maxInFlight,
    setNext(fn: () => Promise<void>) {
      next = fn
    },
  }
}

/** A promise the test settles by hand. */
function deferred() {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeDriver() {
  const clock = createFakeClock()
  const lines: string[] = []
  const driver = createReloadTickDriver({ log: (line) => lines.push(line), clock })
  const t = makeTick(clock)
  return { clock, lines, driver, ...t }
}

describe('reload-timer — arming and cadence', () => {
  test('creating the driver arms nothing; start runs nothing itself and arms exactly one 5000 ms timer', async () => {
    const h = makeDriver()
    expect(RELOAD_TICK_INTERVAL_MS).toBe(5000)
    expect(h.clock.pendingCount()).toBe(0)

    h.driver.start(h.tick)
    await h.clock.flush()
    expect(h.calls).toEqual([])
    expect(h.clock.pending().map((p) => p.delayMs)).toEqual([5000])

    await h.clock.advance(4999)
    expect(h.calls).toEqual([])
    await h.clock.advance(1)
    expect(h.calls).toEqual([5000])
    expect(h.lines).toEqual([])
    assertNoLeak({ lines: h.lines })
  })

  test('each pass re-arms one 5000 ms timer from its end, so exactly one timer is pending between passes', async () => {
    const h = makeDriver()
    h.driver.start(h.tick)
    for (let pass = 1; pass <= 4; pass++) {
      await h.clock.runNext()
      expect(h.clock.pending().map((p) => ({ delayMs: p.delayMs, scheduledAt: p.scheduledAt }))).toEqual([
        { delayMs: 5000, scheduledAt: pass * 5000 },
      ])
    }
    expect(h.calls).toEqual([5000, 10_000, 15_000, 20_000])
    expect(h.lines).toEqual([])
    assertNoLeak({ lines: h.lines })
  })
})

describe('reload-timer — serialization', () => {
  test('a slow pass is never overlapped: nothing is armed until it settles, then the next pass comes 5000 ms after its end', async () => {
    const h = makeDriver()
    const slow = deferred()
    h.setNext(() => slow.promise)
    h.driver.start(h.tick)

    await h.clock.advance(5000)
    expect(h.calls).toEqual([5000])
    expect(h.clock.pendingCount()).toBe(0)

    // Far past several intervals: a setInterval, or a re-arm before settle, would fire again here.
    await h.clock.advance(60_000)
    expect(h.calls).toEqual([5000])
    expect(h.clock.pendingCount()).toBe(0)

    h.setNext(() => Promise.resolve())
    slow.resolve()
    await h.clock.flush()
    expect(h.clock.pending().map((p) => ({ delayMs: p.delayMs, dueAt: p.dueAt }))).toEqual([
      { delayMs: 5000, dueAt: 70_000 },
    ])

    await h.clock.advance(4999)
    expect(h.calls).toEqual([5000])
    await h.clock.advance(1)
    expect(h.calls).toEqual([5000, 70_000])
    expect(h.maxInFlight()).toBe(1)
    expect(h.lines).toEqual([])
    assertNoLeak({ lines: h.lines })
  })
})

describe('reload-timer — a failing pass', () => {
  /**
   * The leak marker as a thrown message carries it (`sentinelInMessage`):
   * only inside a fake token and a Socket Mode `ticket=` URL. The line keeps
   * the message after `redactSlackLogText`, which replaces both, so the
   * marker shows only if redaction is skipped.
   */
  const secret = `(${sentinelInMessage('thrown')})`
  /** `secret` as the line shows it, escaped for a RegExp. */
  const redacted = RegExp.escape(`(${REDACTED_SENTINEL_TAIL})`)
  test.each([
    {
      name: 'rejects with an Error whose message holds a token and a URL',
      fail: () => Promise.reject(new Error(`boom ${secret}`)),
      described: new RegExp(`^Error message="boom ${redacted}"( at |;)`),
    },
    {
      name: 'rejects with a bare string holding a token and a URL',
      fail: () => Promise.reject(`down ${secret}`),
      described: new RegExp(`^string message="down ${redacted}";`),
    },
    {
      name: 'throws synchronously',
      fail: () => {
        throw new TypeError(`sync ${secret}`)
      },
      described: new RegExp(`^TypeError message="sync ${redacted}"( at |;)`),
    },
  ])('a tick that $name logs one line with the message redacted and the chain re-arms', async ({ fail, described }) => {
    const h = makeDriver()
    h.setNext(fail)
    h.driver.start(h.tick)

    await h.clock.advance(5000)
    expect(h.lines).toHaveLength(1)
    const line = h.lines[0]!
    const prefix = '[slack] reload: detection check failed: '
    expect(line.startsWith(prefix)).toBe(true)
    expect(line.endsWith('; checking again in 5 s')).toBe(true)
    expect(line.slice(prefix.length)).toMatch(described)
    expect(h.clock.pending().map((p) => ({ delayMs: p.delayMs, scheduledAt: p.scheduledAt }))).toEqual([
      { delayMs: 5000, scheduledAt: 5000 },
    ])

    // The chain carries on; a later good pass logs nothing more.
    h.setNext(() => Promise.resolve())
    await h.clock.advance(5000)
    expect(h.calls).toEqual([5000, 10_000])
    expect(h.lines).toHaveLength(1)
    expect(h.clock.pendingCount()).toBe(1)
    assertNoLeak({ lines: h.lines })
  })

  test('a log sink that throws does not break the chain', async () => {
    const clock = createFakeClock()
    const t = makeTick(clock)
    const driver = createReloadTickDriver({
      log: () => {
        throw new Error('log sink down')
      },
      clock,
    })
    t.setNext(() => Promise.reject(new Error('pass failed')))
    driver.start(t.tick)
    await clock.advance(10_000)
    expect(t.calls).toEqual([5000, 10_000])
    expect(clock.pendingCount()).toBe(1)
    assertNoLeak({ calls: t.calls })
  })
})

describe('reload-timer — stop', () => {
  test('stop cancels the pending timer, no pass ever runs, and a second stop is a silent no-op', async () => {
    const h = makeDriver()
    h.driver.start(h.tick)
    await h.clock.advance(5000)
    expect(h.clock.pendingCount()).toBe(1)

    h.driver.stop()
    expect(h.clock.pendingCount()).toBe(0)
    h.driver.stop()
    await h.clock.advance(60_000)
    expect(h.calls).toEqual([5000])
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.lines).toEqual([])
    assertNoLeak({ lines: h.lines })
  })

  test.each([
    { settle: 'resolves', end: (d: ReturnType<typeof deferred>) => d.resolve(), logged: 0 },
    { settle: 'rejects', end: (d: ReturnType<typeof deferred>) => d.reject(new Error('late')), logged: 1 },
  ])('a pass in flight at stop that then $settle is not re-armed', async ({ end, logged }) => {
    const h = makeDriver()
    const slow = deferred()
    h.setNext(() => slow.promise)
    h.driver.start(h.tick)
    await h.clock.advance(5000)
    expect(h.calls).toEqual([5000])

    h.driver.stop()
    end(slow)
    await h.clock.flush()
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(60_000)
    expect(h.calls).toEqual([5000])
    expect(h.lines).toHaveLength(logged)
    assertNoLeak({ lines: h.lines })
  })
})

describe('reload-timer — single use', () => {
  test('a second start is logged and ignored: one chain, the first tick only', async () => {
    const h = makeDriver()
    const other = makeTick(h.clock)
    h.driver.start(h.tick)
    h.driver.start(other.tick)
    expectOneSingleUseLine(h.lines, SECOND_START)
    expect(h.clock.pendingCount()).toBe(1)

    await h.clock.advance(15_000)
    expect(h.calls).toEqual([5000, 10_000, 15_000])
    expect(other.calls).toEqual([])
    expect(h.clock.pendingCount()).toBe(1)
    assertNoLeak({ lines: h.lines })
  })

  test.each([
    { name: 'stop before any start', started: false, phrase: START_AFTER_STOP },
    { name: 'start then stop', started: true, phrase: SECOND_START },
  ])('start after $name is logged and arms nothing', async ({ started, phrase }) => {
    const h = makeDriver()
    if (started) h.driver.start(h.tick)
    h.driver.stop()
    h.driver.start(h.tick)
    expectOneSingleUseLine(h.lines, phrase)
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(60_000)
    expect(h.calls).toEqual([])
    assertNoLeak({ lines: h.lines })
  })
})
