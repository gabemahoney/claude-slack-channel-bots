/**
 * cron-scheduler.test.ts — Unit tests for the once-per-minute dispatch tick
 * (Task 3 on b.he5; decision 8, D-Q3, PD-4 on b.grx / t2.he5.eu.4q).
 *
 * Drives `createCronScheduler` with an injected clock and a recording
 * dispatcher stub — NO real time passes, NO real timers fire, NO HTTP, and
 * NEVER any sleep. The `tick()` seam is called directly to exercise the pure
 * scheduling semantics; the fake `setTimeout`/`clearTimeout` are used only to
 * assert single minute-aligned arming and stop() cancellation.
 *
 * TZ hazard (docs/testing-guide.md, ticket Context): matching is server-local
 * time. Every cron expression here is built from the injected Date's OWN local
 * fields (minute/hour/day/month) or is `* * * * *`; no wall-clock minute is ever
 * hardcoded against a fixed epoch and process.env.TZ is never touched.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createCronScheduler, type SchedulerClock } from '../src/cron-scheduler.ts'
import { CRONTABLE_TEMPLATE_HEADER } from '../src/cron-bootstrap.ts'
import { createCronLog, type CronLog, type CronLogRecord } from '../src/cron-log.ts'
import type { CronSchedule } from '../src/crontable.ts'
import type { CronDispatcher } from '../src/cron-dispatch.ts'

// ---------------------------------------------------------------------------
// Manual clock — controllable now() + a single-slot fake timer
// ---------------------------------------------------------------------------

/**
 * A fully manual clock. `now()` returns whatever `t` we set; the scheduler's
 * self-re-arming setTimeout chain records its pending callback+delay so a test
 * can assert exactly one timer is armed and that stop() clears it. We never
 * actually fire the timer to dispatch — the direct `tick()` seam is the
 * dispatch path under test — so the fake timer never advances wall-clock time.
 */
interface FakeTimer {
  cb: () => void
  ms: number
  cleared: boolean
}

interface ManualClock extends SchedulerClock {
  set(date: Date): void
  advanceMinutes(n: number): void
  pending(): FakeTimer[]
  /** Timers still live (armed and not cleared). */
  live(): FakeTimer[]
}

function makeClock(start: Date): ManualClock {
  let t = start.getTime()
  const timers: FakeTimer[] = []
  return {
    now: () => new Date(t),
    setTimeout: ((cb: () => void, ms: number) => {
      const entry: FakeTimer = { cb, ms, cleared: false }
      timers.push(entry)
      return entry as unknown as ReturnType<typeof setTimeout>
    }) as unknown as SchedulerClock['setTimeout'],
    clearTimeout: ((handle: unknown) => {
      ;(handle as FakeTimer).cleared = true
    }) as unknown as SchedulerClock['clearTimeout'],
    set(date: Date) {
      t = date.getTime()
    },
    advanceMinutes(n: number) {
      t += n * 60_000
    },
    pending: () => timers,
    live: () => timers.filter((x) => !x.cleared),
  }
}

// ---------------------------------------------------------------------------
// Recording dispatcher stub — captures fireGroup / fire calls; no HTTP
// ---------------------------------------------------------------------------

interface RecordingDispatcher extends CronDispatcher {
  groupCalls: CronSchedule[][]
  fireCalls: CronSchedule[]
}

function makeDispatcher(): RecordingDispatcher {
  const groupCalls: CronSchedule[][] = []
  const fireCalls: CronSchedule[] = []
  return {
    groupCalls,
    fireCalls,
    async fireGroup(schedules: CronSchedule[]): Promise<void> {
      // Snapshot the array — the scheduler builds a fresh one each pass, but
      // copy defensively so later mutation can never rewrite history.
      groupCalls.push([...schedules])
    },
    async fire(schedule: CronSchedule): Promise<void> {
      fireCalls.push(schedule)
    },
  }
}

// ---------------------------------------------------------------------------
// Cron-expression fixtures — always derived from the injected Date's own local
// fields (TZ-safe). `matchAt(d)` matches exactly the minute of `d`; `everyMinute`
// matches every minute.
// ---------------------------------------------------------------------------

const everyMinute = '* * * * *'

/** A 5-field expression that fires only during the local minute of `d`. */
function matchAt(d: Date): string {
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`
}

/** One crontable data line: expr + prompt path (+ optional channel list). */
function line(expr: string, promptPath: string, channels?: string): string {
  return channels === undefined ? `${expr} ${promptPath}` : `${expr} ${promptPath} ${channels}`
}

// ---------------------------------------------------------------------------
// Per-test temp state
// ---------------------------------------------------------------------------

let tempDir: string
let cronTablePath: string
let cronLogPath: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cron-scheduler-test-'))
  cronTablePath = join(tempDir, 'crontable')
  cronLogPath = join(tempDir, 'cron.log')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

/** Write a crontable file: template header + the given data lines. */
function writeCrontable(...dataLines: string[]): void {
  writeFileSync(cronTablePath, CRONTABLE_TEMPLATE_HEADER + dataLines.join('\n') + '\n')
}

/** Read the cron log as an array of physical lines (empty if absent). */
function readLog(): string[] {
  try {
    return readFileSync(cronLogPath, 'utf-8').split('\n').filter((l) => l.length > 0)
  } catch {
    return []
  }
}

/** Build a scheduler wired to a real cron-log against the temp file. */
function build(clock: ManualClock, dispatcher: CronDispatcher, cronLog?: CronLog) {
  return createCronScheduler({
    dispatcher,
    cronLog: cronLog ?? createCronLog(cronLogPath),
    cronTablePath,
    clock,
  })
}

// ===========================================================================
// Start behavior
// ===========================================================================

describe('cron-scheduler — start()', () => {
  test('missing crontable → bootstrap creates it, INFO observed, zero schedules', () => {
    // No writeCrontable() — the file is absent, start() must create it.
    const clock = makeClock(new Date('2026-06-15T10:30:00'))
    const dispatcher = makeDispatcher()
    build(clock, dispatcher).start()

    // File now exists with the template header (bootstrap created it).
    expect(readFileSync(cronTablePath, 'utf-8')).toBe(CRONTABLE_TEMPLATE_HEADER)

    const log = readLog()
    // A "created" INFO line naming the path, then exactly one started marker.
    const created = log.filter((l) => l.includes('crontable created at'))
    expect(created).toHaveLength(1)
    expect(created[0]).toContain(cronTablePath)

    const started = log.filter((l) => l.includes('scheduler started,'))
    expect(started).toHaveLength(1)
    expect(started[0]).toContain('scheduler started, 0 schedules loaded')
  })

  test('exactly one "scheduler started, N schedules loaded" marker with N = loaded count', () => {
    const start = new Date('2026-06-15T10:30:00')
    writeCrontable(
      line(matchAt(start), '/p/a.md', 'C1'),
      line(everyMinute, '/p/b.md', 'C2'),
    )
    const clock = makeClock(start)
    build(clock, makeDispatcher()).start()

    const started = readLog().filter((l) => l.includes('scheduler started,'))
    expect(started).toHaveLength(1)
    expect(started[0]).toContain('scheduler started, 2 schedules loaded')
  })

  test('parse errors → parse-error outcome lines with identity/channel "-"', () => {
    const start = new Date('2026-06-15T10:30:00')
    // Line 1 (after header) is a valid schedule; line 2 has an invalid cron
    // expression (bad minute field) → one parse-error record.
    writeCrontable(line(everyMinute, '/p/a.md', 'C1'), 'not-a-cron /p/b.md C2')
    const clock = makeClock(start)
    build(clock, makeDispatcher()).start()

    const parseErrors = readLog().filter((l) => l.includes(' parse-error '))
    expect(parseErrors).toHaveLength(1)
    // Field layout: <ts> <identity> <channel> <outcome> <detail...>. identity
    // and channel are both the '-' sentinel for parse errors.
    const fields = parseErrors[0]!.split(' ')
    expect(fields[1]).toBe('-') // identity
    expect(fields[2]).toBe('-') // channel
    expect(fields[3]).toBe('parse-error')
    // Only the one good schedule loaded.
    expect(readLog().some((l) => l.includes('scheduler started, 1 schedules loaded'))).toBe(true)
  })

  test('nothing dispatches before start()', async () => {
    const start = new Date('2026-06-15T10:30:00')
    writeCrontable(line(everyMinute, '/p/a.md', 'C1'))
    const clock = makeClock(start)
    const dispatcher = makeDispatcher()
    const scheduler = build(clock, dispatcher)

    // Calling tick() before start() → no compiled schedules → nothing fires.
    await scheduler.tick()
    expect(dispatcher.groupCalls).toHaveLength(0)
    // And no timer was armed (arm() only runs inside start()).
    expect(clock.pending()).toHaveLength(0)
  })

  test('start() arms exactly one minute-aligned timer (no per-job timers)', () => {
    const start = new Date('2026-06-15T10:30:15.250') // 15.25s into the minute
    writeCrontable(
      line(everyMinute, '/p/a.md', 'C1'),
      line(everyMinute, '/p/b.md', 'C2'),
      line(everyMinute, '/p/c.md', 'C3'),
    )
    const clock = makeClock(start)
    build(clock, makeDispatcher()).start()

    // Exactly ONE timer despite three schedules — the tick is the only path.
    const live = clock.live()
    expect(live).toHaveLength(1)
    // Aligned to the top of the NEXT minute: 60s - 15.25s = 44.75s remaining.
    expect(live[0]!.ms).toBe(60_000 - 15_250)
  })

  test('start() never throws even when the crontable read yields an unreadable path', () => {
    // Point the crontable at a directory path — bootstrap create fails, read
    // fails; start() must swallow both and still emit the started marker.
    const dirAsTable = tempDir // a directory, not a file
    const clock = makeClock(new Date('2026-06-15T10:30:00'))
    const scheduler = createCronScheduler({
      dispatcher: makeDispatcher(),
      cronLog: createCronLog(cronLogPath),
      cronTablePath: dirAsTable,
      clock,
    })
    expect(() => scheduler.start()).not.toThrow()
    expect(readLog().some((l) => l.includes('scheduler started, 0 schedules loaded'))).toBe(true)
  })
})

// ===========================================================================
// Tick matching semantics
// ===========================================================================

describe('cron-scheduler — tick() matching', () => {
  test('fires exactly the schedules matching the current wall-clock minute', async () => {
    const start = new Date('2026-06-15T10:30:00')
    // a matches this minute; b matches a DIFFERENT minute (10:31); c is every
    // minute. Only a and c should fire this minute.
    const otherMinute = new Date(start.getTime() + 60_000)
    writeCrontable(
      line(matchAt(start), '/p/a.md', 'C1'),
      line(matchAt(otherMinute), '/p/b.md', 'C2'),
      line(everyMinute, '/p/c.md', 'C3'),
    )
    const clock = makeClock(start)
    const dispatcher = makeDispatcher()
    const scheduler = build(clock, dispatcher)
    scheduler.start()

    await scheduler.tick()

    expect(dispatcher.groupCalls).toHaveLength(1)
    const fired = dispatcher.groupCalls[0]!.map((s) => s.promptPath)
    expect(fired).toEqual(['/p/a.md', '/p/c.md'])
  })

  test('empty minute → no dispatch and NOTHING appended to the cron log', async () => {
    const start = new Date('2026-06-15T10:30:00')
    // A schedule that matches a different minute only → this minute is empty.
    const otherMinute = new Date(start.getTime() + 5 * 60_000)
    writeCrontable(line(matchAt(otherMinute), '/p/a.md', 'C1'))
    const clock = makeClock(start)
    const dispatcher = makeDispatcher()
    const scheduler = build(clock, dispatcher)
    scheduler.start()

    const logAfterStart = readLog().length
    await scheduler.tick()

    expect(dispatcher.groupCalls).toHaveLength(0)
    // A no-match minute logs NOTHING (the log is unchanged since start()).
    expect(readLog().length).toBe(logAfterStart)
  })

  test('ORDERING: 3+ same-minute matches reach fireGroup in crontable line order', async () => {
    const start = new Date('2026-06-15T10:30:00')
    // Four schedules ALL matching this minute, deliberately NOT in path-alpha
    // order, so an accidental sort would reorder and fail this assertion loudly.
    writeCrontable(
      line(everyMinute, '/p/zeta.md', 'C1'),
      line(matchAt(start), '/p/alpha.md', 'C2'),
      line(everyMinute, '/p/mike.md', 'C3'),
      line(matchAt(start), '/p/bravo.md', 'C4'),
    )
    const clock = makeClock(start)
    const dispatcher = makeDispatcher()
    const scheduler = build(clock, dispatcher)
    scheduler.start()

    await scheduler.tick()

    expect(dispatcher.groupCalls).toHaveLength(1)
    // EXACT crontable line order — not sorted, not reversed.
    expect(dispatcher.groupCalls[0]!.map((s) => s.promptPath)).toEqual([
      '/p/zeta.md',
      '/p/alpha.md',
      '/p/mike.md',
      '/p/bravo.md',
    ])
  })
})

// ===========================================================================
// At-most-once assertion
// ===========================================================================

describe('cron-scheduler — at-most-once', () => {
  test('two ticks in the same minute fire each line once; duplicate logs a SCHEDULER BUG info line', async () => {
    const start = new Date('2026-06-15T10:30:00')
    writeCrontable(line(everyMinute, '/p/a.md', 'C1'))
    const clock = makeClock(start)
    const dispatcher = makeDispatcher()
    const scheduler = build(clock, dispatcher)
    scheduler.start()

    // A second tick at the SAME minute is stopped by the monotonic guard before
    // it can even reach the at-most-once map, so a plain re-tick fires nothing
    // more. That is the observable at-most-once property from the tick seam; the
    // map itself is exercised directly by the duplicate-line test below.
    await scheduler.tick()
    await scheduler.tick()

    // Line fired exactly once across the two same-minute ticks.
    expect(dispatcher.groupCalls).toHaveLength(1)
    expect(dispatcher.groupCalls[0]!.map((s) => s.promptPath)).toEqual(['/p/a.md'])
  })

  test('at-most-once map suppresses a duplicate raw line within one minute and logs the SCHEDULER BUG signal', async () => {
    // Two IDENTICAL crontable lines both match this minute. They parse into two
    // schedules sharing ONE rawLine key, so within a single pass the second is
    // the duplicate the at-most-once map is built to catch — reaching the bug
    // branch that the monotonic guard alone cannot exercise.
    const start = new Date('2026-06-15T10:30:00')
    const dupLine = line(everyMinute, '/p/a.md', 'C1')
    writeCrontable(dupLine, dupLine)

    const records: Array<{ kind: string; record?: CronLogRecord; text?: string; identity?: string; channel?: string }> = []
    const recordingLog: CronLog = {
      outcome: (record) => records.push({ kind: 'outcome', record }),
      summary: () => records.push({ kind: 'summary' }),
      info: (_ts, text, identity, channel) => records.push({ kind: 'info', text, identity, channel }),
    }
    const clock = makeClock(start)
    const dispatcher = makeDispatcher()
    const scheduler = build(clock, dispatcher, recordingLog)
    scheduler.start()

    await scheduler.tick()

    // The duplicate raw line was skipped: exactly ONE copy reached fireGroup.
    expect(dispatcher.groupCalls).toHaveLength(1)
    expect(dispatcher.groupCalls[0]!.map((s) => s.promptPath)).toEqual(['/p/a.md'])

    // The suppressed duplicate produced the loud bug-signal INFO line. Assert on
    // fields/prefix, not prose: it is an info LINE KIND (not an outcome class),
    // carries the schedule identity, and channel '-'.
    const bug = records.find((r) => r.kind === 'info' && r.text?.startsWith('SCHEDULER BUG: at-most-once violation'))
    expect(bug).toBeDefined()
    expect(bug!.identity).toBe('cscb-cron:a')
    expect(bug!.channel).toBe('-')
  })
})

// ===========================================================================
// Monotonic guard + no catch-up
// ===========================================================================

describe('cron-scheduler — monotonic guard and no catch-up', () => {
  test('after ticking minute M, a tick at M-1 (backwards clock) fires nothing', async () => {
    const m = new Date('2026-06-15T10:30:00')
    const mMinusOne = new Date(m.getTime() - 60_000)
    // everyMinute matches both minutes; only the forward tick should fire.
    writeCrontable(line(everyMinute, '/p/a.md', 'C1'))
    const clock = makeClock(m)
    const dispatcher = makeDispatcher()
    const scheduler = build(clock, dispatcher)
    scheduler.start()

    await scheduler.tick() // minute M fires
    expect(dispatcher.groupCalls).toHaveLength(1)

    clock.set(mMinusOne) // backwards clock jump
    await scheduler.tick() // whole pass skipped by the monotonic guard
    expect(dispatcher.groupCalls).toHaveLength(1) // still just the one
  })

  test('fires again once the clock passes M', async () => {
    const m = new Date('2026-06-15T10:30:00')
    writeCrontable(line(everyMinute, '/p/a.md', 'C1'))
    const clock = makeClock(m)
    const dispatcher = makeDispatcher()
    const scheduler = build(clock, dispatcher)
    scheduler.start()

    await scheduler.tick() // M
    clock.set(new Date(m.getTime() - 60_000))
    await scheduler.tick() // M-1: guarded, no fire
    clock.set(new Date(m.getTime() + 60_000))
    await scheduler.tick() // M+1: passes the guard, fires again

    expect(dispatcher.groupCalls).toHaveLength(2)
  })

  test('NO catch-up: advancing several minutes between ticks fires nothing for skipped minutes and logs nothing about them', async () => {
    const start = new Date('2026-06-15T10:30:00')
    writeCrontable(line(everyMinute, '/p/a.md', 'C1'))
    const clock = makeClock(start)
    const dispatcher = makeDispatcher()
    const scheduler = build(clock, dispatcher)
    scheduler.start()

    await scheduler.tick() // minute 30 fires once
    expect(dispatcher.groupCalls).toHaveLength(1)

    const logBefore = readLog().length
    // Jump forward FIVE minutes without ticking the intervening ones.
    clock.advanceMinutes(5)
    await scheduler.tick() // minute 35 fires ONCE — no catch-up for 31..34

    // Exactly one more dispatch (for minute 35), not five.
    expect(dispatcher.groupCalls).toHaveLength(2)
    // Each dispatch carried exactly the one matching schedule (single fire, not
    // a batched catch-up of skipped minutes).
    expect(dispatcher.groupCalls[1]!.map((s) => s.promptPath)).toEqual(['/p/a.md'])
    // The skipped minutes 31..34 logged nothing about themselves: the log grew
    // only by nothing here (no-match logs nothing, and a match's dispatch is
    // logged by the dispatcher, which is stubbed → scheduler itself appends no
    // per-minute lines for the empty skipped minutes).
    const logAfter = readLog().length
    expect(logAfter).toBe(logBefore)
  })
})

// ===========================================================================
// Delayed-tick rule (pinned) — fires only the observed-at-start minute
// ===========================================================================

describe('cron-scheduler — delayed tick past a minute boundary', () => {
  test('a tick fires only the minute observed at tick start (no re-alignment fire)', async () => {
    // The scheduler stamps the minute from a single now() at the top of the
    // pass. A schedule matching ONLY the observed minute fires; a schedule
    // matching only the NEXT minute does not — the pass never re-samples the
    // clock to fire a later minute.
    const observed = new Date('2026-06-15T10:30:00')
    const nextMinute = new Date(observed.getTime() + 60_000)
    writeCrontable(
      line(matchAt(observed), '/p/now.md', 'C1'),
      line(matchAt(nextMinute), '/p/next.md', 'C2'),
    )
    const clock = makeClock(observed)
    const dispatcher = makeDispatcher()
    const scheduler = build(clock, dispatcher)
    scheduler.start()

    await scheduler.tick()

    expect(dispatcher.groupCalls).toHaveLength(1)
    // Only the observed-minute schedule; the next-minute one is not swept in.
    expect(dispatcher.groupCalls[0]!.map((s) => s.promptPath)).toEqual(['/p/now.md'])
  })
})

// ===========================================================================
// stop()
// ===========================================================================

describe('cron-scheduler — stop()', () => {
  test('stop() cancels the pending timer and is idempotent', () => {
    writeCrontable(line(everyMinute, '/p/a.md', 'C1'))
    const clock = makeClock(new Date('2026-06-15T10:30:00'))
    const scheduler = build(clock, makeDispatcher())
    scheduler.start()

    // One live timer armed at start.
    expect(clock.live()).toHaveLength(1)

    scheduler.stop()
    // The armed timer is now cleared.
    expect(clock.live()).toHaveLength(0)

    // Idempotent: a second stop() does not throw and clears nothing new.
    expect(() => scheduler.stop()).not.toThrow()
    expect(clock.live()).toHaveLength(0)
  })
})
