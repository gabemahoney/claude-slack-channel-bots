/**
 * cron-scheduler-reload.test.ts — Unit tests for the crontable HOT-RELOAD step
 * at the top of the scheduler tick (E3 on b.he5; D-Q1 deleted-file semantics,
 * decision 8 double-fire protection).
 *
 * These live apart from tests/cron-scheduler.test.ts because they are
 * file-mutation heavy: every case rewrites, chmods or deletes the crontable
 * between ticks. The harness is the E2 precedent — factory-built scheduler,
 * injected clock, recording dispatcher stub, direct `tick()` seam, real
 * cron-log writing into a per-test tmp dir. NO real time passes, NO sleeps, NO
 * HTTP, NO host-timezone dependence (every expression is `* * * * *` or is
 * derived from the injected Date's own local fields).
 *
 * ANTI-FLAKE RULE (ticket): a same-second rewrite may leave mtime unchanged, so
 * the (mtimeMs,size) freshness gate could legitimately not fire. After EVERY
 * fixture mutation that the next tick must observe we explicitly bump mtime via
 * utimes to a strictly-increasing timestamp derived from the injected clock
 * (`touch()`), and we assert the reload happened by BEHAVIOR (what fires, what
 * is logged) — never by inspecting the freshness mechanism itself.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createCronScheduler, type SchedulerClock } from '../src/cron-scheduler.ts'
import { CRONTABLE_TEMPLATE_HEADER } from '../src/cron-bootstrap.ts'
import { createCronLog } from '../src/cron-log.ts'
import type { CronSchedule } from '../src/crontable.ts'
import type { CronDispatcher } from '../src/cron-dispatch.ts'

// ---------------------------------------------------------------------------
// Manual clock — controllable now(); timers are captured and never fired (the
// direct tick() seam is the path under test here).
// ---------------------------------------------------------------------------

interface ManualClock extends SchedulerClock {
  advanceMinutes(n: number): void
}

function makeClock(start: Date): ManualClock {
  let t = start.getTime()
  return {
    now: () => new Date(t),
    setTimeout: ((cb: () => void, ms: number) => ({ cb, ms })) as unknown as SchedulerClock['setTimeout'],
    clearTimeout: (() => {}) as unknown as SchedulerClock['clearTimeout'],
    advanceMinutes(n: number) {
      t += n * 60_000
    },
  }
}

// ---------------------------------------------------------------------------
// Recording dispatcher stub — captures per-schedule fire() calls; no HTTP.
// ---------------------------------------------------------------------------

interface RecordingDispatcher extends CronDispatcher {
  fireCalls: CronSchedule[]
  /** Prompt paths fired so far, in dispatch order. */
  paths(): string[]
}

function makeDispatcher(): RecordingDispatcher {
  const fireCalls: CronSchedule[] = []
  return {
    fireCalls,
    paths: () => fireCalls.map((s) => s.promptPath),
    async fire(schedule: CronSchedule): Promise<void> {
      fireCalls.push(schedule)
    },
  }
}

// ---------------------------------------------------------------------------
// Crontable line fixtures — TZ-safe (see file header).
// ---------------------------------------------------------------------------

const everyMinute = '* * * * *'

/** A 5-field expression that fires only during the local minute of `d`. */
function matchAt(d: Date): string {
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`
}

/** One crontable data line: expr + prompt path + channel list. */
function line(expr: string, promptPath: string, channel = 'C1'): string {
  return `${expr} ${promptPath} ${channel}`
}

// ---------------------------------------------------------------------------
// Per-test temp state
// ---------------------------------------------------------------------------

let tempDir: string
let cronTablePath: string
let cronLogPath: string
/** Monotonic mtime nudge so successive writes always look different (anti-flake). */
let mtimeSeq: number

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cron-reload-test-'))
  cronTablePath = join(tempDir, 'crontable')
  cronLogPath = join(tempDir, 'cron.log')
  mtimeSeq = 0
})

afterEach(() => {
  // A permissions test may leave the file unreadable; restore before cleanup.
  try {
    chmodSync(cronTablePath, 0o644)
  } catch {
    /* file may not exist — fine */
  }
  rmSync(tempDir, { recursive: true, force: true })
})

/**
 * Force the crontable's mtime to a strictly-increasing timestamp derived from
 * the injected clock, so the next tick's freshness stat cannot coincide with
 * the previous load's even for two writes inside one wall-clock second.
 * Returns the whole-second value used, so a test can restore it exactly.
 */
function touch(clock: ManualClock): number {
  const seconds = Math.floor(clock.now().getTime() / 1000) + ++mtimeSeq
  utimesSync(cronTablePath, seconds, seconds)
  return seconds
}

/** Write a crontable (template header + data lines) and bump its mtime. */
function writeTable(clock: ManualClock, ...dataLines: string[]): void {
  writeFileSync(cronTablePath, CRONTABLE_TEMPLATE_HEADER + dataLines.join('\n') + '\n')
  touch(clock)
}

/** One parsed cron-log line: the five-field layout of cron-log.ts. */
interface LogLine {
  identity: string
  channel: string
  /** Field 4 — the LINE KIND / outcome class token (`info`, `warn`, `parse-error`, …). */
  kind: string
  detail: string
}

function readLog(): LogLine[] {
  let text: string
  try {
    text = readFileSync(cronLogPath, 'utf-8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const f = l.split(' ')
      return { identity: f[1]!, channel: f[2]!, kind: f[3]!, detail: f.slice(4).join(' ') }
    })
}

const kindOf = (kind: string): LogLine[] => readLog().filter((l) => l.kind === kind)
const reloadLines = (): LogLine[] =>
  kindOf('info').filter((l) => l.detail.startsWith('crontable reloaded,'))

/** Build a scheduler wired to a real cron-log against the temp files. */
function build(clock: ManualClock, dispatcher: CronDispatcher) {
  return createCronScheduler({
    dispatcher,
    cronLog: createCronLog(cronLogPath),
    cronTablePath,
    clock,
  })
}

/** The common opening move: a started scheduler over the given data lines. */
function startWith(clock: ManualClock, ...dataLines: string[]) {
  const dispatcher = makeDispatcher()
  writeTable(clock, ...dataLines)
  const scheduler = build(clock, dispatcher)
  scheduler.start()
  return { dispatcher, scheduler }
}

const START = new Date('2026-06-15T10:30:00')

// ===========================================================================
// Edits picked up between ticks
// ===========================================================================

describe('cron-scheduler reload — crontable edits between ticks', () => {
  test('a line ADDED between ticks fires on the next matching minute (and not before the reload tick)', async () => {
    const clock = makeClock(START)
    const { dispatcher, scheduler } = startWith(clock, line(everyMinute, '/p/a.md'))

    await scheduler.tick()
    expect(dispatcher.paths()).toEqual(['/p/a.md'])

    // Add a second line; it cannot have fired during the minute above because
    // it did not exist then.
    writeTable(clock, line(everyMinute, '/p/a.md'), line(everyMinute, '/p/b.md'))
    clock.advanceMinutes(1)
    await scheduler.tick()

    expect(dispatcher.paths()).toEqual(['/p/a.md', '/p/a.md', '/p/b.md'])
    expect(reloadLines()).toHaveLength(1)
    expect(reloadLines()[0]!.detail).toBe('crontable reloaded, 2 schedules')
  })

  test('a line REMOVED between ticks never fires again', async () => {
    const clock = makeClock(START)
    const { dispatcher, scheduler } = startWith(
      clock,
      line(everyMinute, '/p/a.md'),
      line(everyMinute, '/p/gone.md'),
    )

    await scheduler.tick()
    expect(dispatcher.paths()).toEqual(['/p/a.md', '/p/gone.md'])

    writeTable(clock, line(everyMinute, '/p/a.md'))
    // Two further minutes: /p/gone.md must not appear in either.
    for (const _ of [1, 2]) {
      clock.advanceMinutes(1)
      await scheduler.tick()
    }

    expect(dispatcher.paths()).toEqual(['/p/a.md', '/p/gone.md', '/p/a.md', '/p/a.md'])
  })

  test('an EDITED expression stops matching the old minute and starts matching the new one', async () => {
    const clock = makeClock(START)
    const minuteOne = START
    const minuteTwo = new Date(START.getTime() + 60_000)
    // Initially the line matches ONLY minute one.
    const { dispatcher, scheduler } = startWith(clock, line(matchAt(minuteOne), '/p/a.md'))

    await scheduler.tick() // minute one — matches
    expect(dispatcher.paths()).toEqual(['/p/a.md'])

    // Edit the expression to match ONLY minute two.
    writeTable(clock, line(matchAt(minuteTwo), '/p/a.md'))
    clock.advanceMinutes(1)
    await scheduler.tick() // minute two — the EDITED expression matches
    expect(dispatcher.paths()).toEqual(['/p/a.md', '/p/a.md'])

    // Edit back to minute one only; minute three must fire nothing (proving the
    // swap really replaced the compiled matcher rather than accumulating them).
    writeTable(clock, line(matchAt(minuteOne), '/p/a.md'))
    clock.advanceMinutes(1)
    await scheduler.tick()
    expect(dispatcher.paths()).toEqual(['/p/a.md', '/p/a.md'])
  })
})

// ===========================================================================
// Decision 8 — a reload inside a minute that already fired must not re-fire it
// ===========================================================================

describe('cron-scheduler reload — decision 8 same-minute reload', () => {
  test('rewriting the crontable and forcing another pass inside the SAME minute fires nothing a second time', async () => {
    const clock = makeClock(START)
    const { dispatcher, scheduler } = startWith(clock, line(everyMinute, '/p/a.md'))

    await scheduler.tick()
    expect(dispatcher.paths()).toEqual(['/p/a.md'])

    // Rewrite (mtime bumped) and tick AGAIN without advancing the clock: the
    // reload swaps in fresh schedules, but the monotonic minute guard — not the
    // at-most-once map — must stop the pass before any dispatch.
    writeTable(clock, line(everyMinute, '/p/a.md'), line(everyMinute, '/p/b.md'))
    await scheduler.tick()

    // THE assertion: no second fire in minute M, for either line.
    expect(dispatcher.paths()).toEqual(['/p/a.md'])

    // The next minute both lines fire, so the guard suppressed the pass rather
    // than the reload having failed or the schedules having been lost.
    clock.advanceMinutes(1)
    await scheduler.tick()
    expect(dispatcher.paths()).toEqual(['/p/a.md', '/p/a.md', '/p/b.md'])
  })
})

// ===========================================================================
// Garbage content
// ===========================================================================

describe('cron-scheduler reload — unparseable content', () => {
  test('garbage table → parse-error once per reload (not per unchanged tick), zero fires, healthy lines resume', async () => {
    const clock = makeClock(START)
    const { dispatcher, scheduler } = startWith(clock, line(everyMinute, '/p/a.md'))

    await scheduler.tick()
    expect(dispatcher.paths()).toEqual(['/p/a.md'])
    expect(kindOf('parse-error')).toHaveLength(0)

    // Replace the whole table with an unparseable line.
    writeTable(clock, 'not-a-cron /p/b.md C2')
    clock.advanceMinutes(1)
    await scheduler.tick()

    const parseErrors = kindOf('parse-error')
    expect(parseErrors).toHaveLength(1)
    expect(parseErrors[0]!.identity).toBe('-')
    expect(parseErrors[0]!.channel).toBe('-')
    // Nothing fired this minute: the bad line yielded zero schedules.
    expect(dispatcher.paths()).toEqual(['/p/a.md'])

    // Two more ticks with the file UNCHANGED: no re-parse, so no further
    // parse-error records and still nothing to fire.
    for (const _ of [1, 2]) {
      clock.advanceMinutes(1)
      await scheduler.tick()
    }
    expect(kindOf('parse-error')).toHaveLength(1)
    expect(dispatcher.paths()).toEqual(['/p/a.md'])

    // A valid write resumes healthy firing.
    writeTable(clock, line(everyMinute, '/p/healthy.md'))
    clock.advanceMinutes(1)
    await scheduler.tick()
    expect(dispatcher.paths()).toEqual(['/p/a.md', '/p/healthy.md'])
    expect(kindOf('parse-error')).toHaveLength(1)
  })
})

// ===========================================================================
// Non-ENOENT read failure — keep the current schedules (PM-required case)
// ===========================================================================

describe('cron-scheduler reload — non-ENOENT read failure', () => {
  // chmod is meaningless for root: a root process reads a 0o000 file happily,
  // so the EACCES this case needs cannot be produced. Skip rather than pretend.
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

  test.skipIf(asRoot)(
    'unreadable crontable (EACCES) → schedules KEEP firing, ONE warn, latch clears on recovery',
    async () => {
      const clock = makeClock(START)
      const { dispatcher, scheduler } = startWith(clock, line(everyMinute, '/p/a.md'))

      await scheduler.tick()
      expect(dispatcher.paths()).toEqual(['/p/a.md'])

      // Make the read fail while the stat still succeeds and reports a change,
      // so the reload is attempted and the READ is what fails.
      chmodSync(cronTablePath, 0o000)
      touch(clock)
      clock.advanceMinutes(1)
      await scheduler.tick()

      // The pinned decision: a transient read error keeps the current table.
      expect(dispatcher.paths()).toEqual(['/p/a.md', '/p/a.md'])

      const warns = kindOf('warn')
      expect(warns).toHaveLength(1)
      expect(warns[0]!.identity).toBe('-')
      expect(warns[0]!.channel).toBe('-')
      expect(warns[0]!.detail).toContain(`crontable unreadable at ${cronTablePath}`)
      expect(warns[0]!.detail).toContain('keeping 1 loaded schedules')
      expect(warns[0]!.detail).toContain('EACCES')

      // Still unreadable, still changing: the latch keeps it to ONE warn while
      // the schedules keep firing every minute.
      for (const _ of [1, 2]) {
        touch(clock)
        clock.advanceMinutes(1)
        await scheduler.tick()
      }
      expect(kindOf('warn')).toHaveLength(1)
      expect(dispatcher.paths()).toHaveLength(4)

      // Recovery: permissions restored and the content edited. The stale
      // recorded stat makes the next tick reload, and the latch clears.
      chmodSync(cronTablePath, 0o644)
      writeTable(clock, line(everyMinute, '/p/a.md'), line(everyMinute, '/p/new.md'))
      clock.advanceMinutes(1)
      await scheduler.tick()
      expect(dispatcher.paths().slice(-2)).toEqual(['/p/a.md', '/p/new.md'])

      // Latch cleared: a SECOND unreadable episode warns again.
      chmodSync(cronTablePath, 0o000)
      touch(clock)
      clock.advanceMinutes(1)
      await scheduler.tick()
      expect(kindOf('warn')).toHaveLength(2)
      expect(kindOf('warn')[1]!.detail).toContain('keeping 2 loaded schedules')
    },
  )
})

// ===========================================================================
// Deletion (D-Q1) and the re-create pass
// ===========================================================================

describe('cron-scheduler reload — crontable deleted mid-run', () => {
  test('deletion → warn-kind vanish line, zero fires, empty template re-created on the NEXT pass', async () => {
    const clock = makeClock(START)
    const { dispatcher, scheduler } = startWith(clock, line(everyMinute, '/p/a.md'))

    await scheduler.tick()
    expect(dispatcher.paths()).toEqual(['/p/a.md'])

    // Delete the file. The detecting pass drops to zero schedules immediately —
    // nothing stale may fire behind a deleted crontable.
    rmSync(cronTablePath)
    clock.advanceMinutes(1)
    await scheduler.tick()
    expect(dispatcher.paths()).toEqual(['/p/a.md'])

    const warns = kindOf('warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.identity).toBe('-')
    expect(warns[0]!.channel).toBe('-')
    expect(warns[0]!.detail).toBe(
      `crontable vanished at ${cronTablePath} — 0 schedules until it is restored`,
    )

    // The NEXT pass re-creates the file — exactly the template header, zero
    // schedules — and says so on an INFO line. The vanish record is
    // distinguished from this create record by LINE KIND (warn vs info), not by
    // its prose.
    clock.advanceMinutes(1)
    await scheduler.tick()

    expect(readFileSync(cronTablePath, 'utf-8')).toBe(CRONTABLE_TEMPLATE_HEADER)
    const created = kindOf('info').filter((l) => l.detail.includes('re-created'))
    expect(created).toHaveLength(1)
    expect(created[0]!.detail).toBe(`crontable re-created at ${cronTablePath} after deletion`)
    expect(reloadLines().map((l) => l.detail)).toEqual(['crontable reloaded, 0 schedules'])
    // Still zero fires, and the vanish warn did not repeat across the passes.
    expect(dispatcher.paths()).toEqual(['/p/a.md'])
    expect(kindOf('warn')).toHaveLength(1)
  })

  test('EEXIST race: a file restored before the re-create pass is left byte-intact and its schedules fire', async () => {
    const clock = makeClock(START)
    const { dispatcher, scheduler } = startWith(clock, line(everyMinute, '/p/a.md'))

    await scheduler.tick()
    rmSync(cronTablePath)
    clock.advanceMinutes(1)
    await scheduler.tick() // detects the vanish
    expect(kindOf('warn')).toHaveLength(1)

    // Someone else restores the file BEFORE the scheduler's re-create pass — the
    // bootstrap's exclusive create loses the race with EEXIST.
    const restored = CRONTABLE_TEMPLATE_HEADER + line(everyMinute, '/p/restored.md') + '\n'
    writeFileSync(cronTablePath, restored)
    touch(clock)

    clock.advanceMinutes(1)
    await scheduler.tick()

    // Content untouched byte-for-byte (NOT overwritten with the bare template).
    expect(readFileSync(cronTablePath, 'utf-8')).toBe(restored)
    // No re-create INFO — nothing was created.
    expect(kindOf('info').filter((l) => l.detail.includes('re-created'))).toHaveLength(0)
    // The restored content loaded and fired.
    expect(dispatcher.paths()).toEqual(['/p/a.md', '/p/restored.md'])
    expect(reloadLines().map((l) => l.detail)).toEqual(['crontable reloaded, 1 schedules'])
  })

  test('a PERSISTENT re-create failure (parent directory gone) stays silent: still ONE warn, no re-create, nothing fires', async () => {
    const clock = makeClock(START)
    // Keep the crontable in its own subdirectory so that directory can be
    // removed without taking the cron log down with it.
    const tableDir = join(tempDir, 'cfg')
    mkdirSync(tableDir)
    cronTablePath = join(tableDir, 'crontable')
    const { dispatcher, scheduler } = startWith(clock, line(everyMinute, '/p/a.md'))

    await scheduler.tick()
    expect(dispatcher.paths()).toEqual(['/p/a.md'])

    rmSync(cronTablePath)
    clock.advanceMinutes(1)
    await scheduler.tick() // detects the vanish
    expect(kindOf('warn')).toHaveLength(1)

    // Now remove the directory as well: the bootstrap never mkdir's a missing
    // parent, so every later re-create attempt fails with ENOENT and the file
    // can never come back on its own.
    rmSync(tableDir, { recursive: true, force: true })

    for (const _ of [1, 2, 3]) {
      clock.advanceMinutes(1)
      await scheduler.tick()
    }

    // The vanish latch holds across a failure that repeats every minute: no
    // second warn, no re-created INFO, no reload line, and zero fires behind a
    // crontable that is still missing.
    expect(kindOf('warn')).toHaveLength(1)
    expect(kindOf('info').filter((l) => l.detail.includes('re-created'))).toHaveLength(0)
    expect(reloadLines()).toHaveLength(0)
    expect(dispatcher.paths()).toEqual(['/p/a.md'])
  })
})

// ===========================================================================
// Unchanged file — the freshness gate must suppress re-parsing entirely
// ===========================================================================

describe('cron-scheduler reload — unchanged file', () => {
  test('untouched file across several ticks → no reload line, no re-parse, identical fire behavior', async () => {
    const clock = makeClock(START)
    const { dispatcher, scheduler } = startWith(clock, line(everyMinute, '/p/a.md'))

    for (const _ of [1, 2, 3]) {
      await scheduler.tick()
      clock.advanceMinutes(1)
    }

    expect(dispatcher.paths()).toEqual(['/p/a.md', '/p/a.md', '/p/a.md'])
    expect(reloadLines()).toHaveLength(0)
    expect(kindOf('parse-error')).toHaveLength(0)
  })

  test('content swapped for equal-length garbage with the mtime RESTORED → no re-parse side effects', async () => {
    const clock = makeClock(START)
    const dispatcher = makeDispatcher()
    const body = line(everyMinute, '/p/a.md')
    writeFileSync(cronTablePath, CRONTABLE_TEMPLATE_HEADER + body + '\n')
    const stamp = touch(clock)
    const scheduler = build(clock, dispatcher)
    scheduler.start()

    await scheduler.tick()
    expect(dispatcher.paths()).toEqual(['/p/a.md'])

    // Same byte length, same mtime — an invisible change as far as the
    // freshness gate is concerned. If it were re-parsed, this content would
    // produce a parse-error and zero schedules.
    const garbage = 'bogus'.padEnd(body.length, 'x')
    expect(garbage).toHaveLength(body.length)
    writeFileSync(cronTablePath, CRONTABLE_TEMPLATE_HEADER + garbage + '\n')
    utimesSync(cronTablePath, stamp, stamp)
    expect(statSync(cronTablePath).mtimeMs).toBe(stamp * 1000)

    clock.advanceMinutes(1)
    await scheduler.tick()

    // The previously-loaded schedule still fires and nothing was re-parsed.
    expect(dispatcher.paths()).toEqual(['/p/a.md', '/p/a.md'])
    expect(kindOf('parse-error')).toHaveLength(0)
    expect(reloadLines()).toHaveLength(0)
  })
})
