/**
 * cron-scheduler-interject.test.ts — Integration-style tick-to-/interject test
 * (Epic t1.he5.eu AC; Task t2.he5.eu.4q). Wires the REAL scheduler, dispatcher,
 * and cron-log modules together end-to-end into a self-contained Bun.serve
 * /interject harness (the tests/interject.test.ts pattern: port 0, closure
 * state, afterAll stop). No mocks of the product modules; no real sleeping.
 *
 * The clock is fully injected. The scheduler arms its next pass via
 * clock.setTimeout, but this test's fake clock DISCARDS that handler and never
 * auto-fires it — every pass is driven through the direct `tick()` seam with an
 * injected now() inside a `* * * * *` minute. `* * * * *` matches every minute,
 * so the test is TZ-agnostic (no local-time coupling).
 *
 * Everything lives under mkdtemp temp dirs and this file's own port-0 harness —
 * never the live server, live crontable, or any cscb_/slack_bot_ session.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCronLog } from '../src/cron-log.ts'
import { createCronDispatcher } from '../src/cron-dispatch.ts'
import { createCronScheduler, type SchedulerClock } from '../src/cron-scheduler.ts'

// ---------------------------------------------------------------------------
// Self-contained /interject harness — records every POST body, returns 200.
// Binds on port 0 so the OS assigns a free port (no conflicts).
// ---------------------------------------------------------------------------

interface CapturedPost {
  method: string
  path: string
  body: { channel?: unknown; message?: unknown; sender?: unknown }
}

const posts: CapturedPost[] = []

const harness = Bun.serve({
  port: 0,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const raw = await req.text()
    let body: { channel?: unknown; message?: unknown; sender?: unknown } = {}
    try {
      body = JSON.parse(raw)
    } catch {
      /* leave body empty on parse failure */
    }
    posts.push({ method: req.method, path: url.pathname, body })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  },
})

const PORT = harness.port as number

// ---------------------------------------------------------------------------
// Temp dirs + cron-log reader
// ---------------------------------------------------------------------------

let tempDirs: string[]

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** One parsed cron-log line, split into its five contract fields. */
interface LogLine {
  timestamp: string
  identity: string
  channel: string
  outcome: string
  detail: string
}

/** Read + parse the temp cron-log file into structured five-field lines. */
function readLog(logPath: string): LogLine[] {
  let text = ''
  try {
    text = readFileSync(logPath, 'utf-8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => {
      const parts = line.split(' ')
      const [timestamp, identity, channel, outcome, ...rest] = parts
      return {
        timestamp: timestamp ?? '',
        identity: identity ?? '',
        channel: channel ?? '',
        outcome: outcome ?? '',
        detail: rest.join(' '),
      }
    })
}

/** Extract a `key=value` token's value from a detail field, or undefined. */
function token(detail: string, key: string): string | undefined {
  for (const t of detail.split(' ')) {
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Fake clock — DISCARDS the armed handler, never auto-fires it. now() is a
// controllable time inside a `* * * * *` minute so the direct tick() matches.
// ---------------------------------------------------------------------------

/** A fixed instant inside a minute — any minute matches `* * * * *`. */
const FIXED_NOW = new Date('2026-01-15T10:30:30.000Z')

function makeNonFiringClock(nowDate: Date): SchedulerClock {
  return {
    now: () => nowDate,
    // Discard the armed handler: return an opaque handle and never invoke it,
    // so the only pass that runs is the one this test drives via tick().
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  }
}

// ---------------------------------------------------------------------------
// Wiring — real scheduler + real dispatcher + real cron-log over temp files.
// ---------------------------------------------------------------------------

function makeWiring(opts: {
  cronTablePath: string
  now: Date
}): { scheduler: ReturnType<typeof createCronScheduler>; logPath: string; lines: () => LogLine[] } {
  const logDir = makeTempDir('cscb-sched-log-')
  const logPath = join(logDir, 'cron.log')
  const cronLog = createCronLog(logPath)
  const dispatcher = createCronDispatcher({ port: PORT, cronLog, cronTablePath: opts.cronTablePath })
  const scheduler = createCronScheduler({
    dispatcher,
    cronLog,
    cronTablePath: opts.cronTablePath,
    clock: makeNonFiringClock(opts.now),
  })
  return { scheduler, logPath, lines: () => readLog(logPath) }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  posts.length = 0
  tempDirs = []
})

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

afterAll(() => {
  harness.stop()
})

// ---------------------------------------------------------------------------
// Epic AC — one crontable line delivered end-to-end through the real modules.
// ---------------------------------------------------------------------------

describe('tick → /interject end-to-end (real scheduler + dispatcher + cron-log)', () => {
  test('single `* * * * *` schedule fires exactly once, delivers prompt content, logs delivered + summary', async () => {
    const dir = makeTempDir('cscb-sched-e2e-')
    const promptPath = join(dir, 'grooming-tick.md')
    const promptBody = 'Grooming tick: please check the queue.'
    writeFileSync(promptPath, promptBody)

    const cronTablePath = join(dir, 'crontab')
    const channel = 'C_TEST'
    writeFileSync(cronTablePath, `* * * * * ${promptPath} ${channel}\n`)

    const { scheduler, lines } = makeWiring({ cronTablePath, now: FIXED_NOW })
    scheduler.start()
    await scheduler.tick()

    // Exactly one POST reached the harness.
    expect(posts).toHaveLength(1)
    expect(posts[0]!.method).toBe('POST')
    expect(posts[0]!.path).toBe('/interject')

    // Body carries the test channel, the prompt file's content, and the
    // single-schedule sender `cscb-cron:<basename-without-extension>`.
    expect(posts[0]!.body.channel).toBe(channel)
    expect(posts[0]!.body.message).toBe(promptBody)
    expect(posts[0]!.body.sender).toBe('cscb-cron:grooming-tick')

    // The cron log gains a `delivered` outcome for that (identity, channel).
    const log = lines()
    const delivered = log.filter((l) => l.outcome === 'delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.identity).toBe('cscb-cron:grooming-tick')
    expect(delivered[0]!.channel).toBe(channel)
    expect(token(delivered[0]!.detail, 'status')).toBe('200')

    // ...and a per-fire summary line with delivered=1 failed=0.
    const summaries = log.filter((l) => l.outcome === 'summary')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.identity).toBe('cscb-cron:grooming-tick')
    expect(token(summaries[0]!.detail, 'delivered')).toBe('1')
    expect(token(summaries[0]!.detail, 'failed')).toBe('0')
  })

  test('a relative prompt path resolves against the crontable dir and delivers its content', async () => {
    const dir = makeTempDir('cscb-sched-rel-')
    const promptBody = 'relative prompt body'
    writeFileSync(join(dir, 'rel-tick.md'), promptBody)

    const cronTablePath = join(dir, 'crontab')
    const channel = 'C_REL'
    // Relative token 6 → resolves against dirname(cronTablePath) = dir.
    writeFileSync(cronTablePath, `* * * * * rel-tick.md ${channel}\n`)

    const { scheduler, lines } = makeWiring({ cronTablePath, now: FIXED_NOW })
    scheduler.start()
    await scheduler.tick()

    expect(posts).toHaveLength(1)
    expect(posts[0]!.body.channel).toBe(channel)
    expect(posts[0]!.body.message).toBe(promptBody)
    expect(posts[0]!.body.sender).toBe('cscb-cron:rel-tick')

    const delivered = lines().filter((l) => l.outcome === 'delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.channel).toBe(channel)
  })

  test('editing the PROMPT FILE between start() and tick() → the POST carries the EDITED content (fresh read, not pinned at load)', async () => {
    const dir = makeTempDir('cscb-sched-fresh-')
    const promptPath = join(dir, 'live-tick.md')
    writeFileSync(promptPath, 'ORIGINAL content at start()')

    const cronTablePath = join(dir, 'crontab')
    const channel = 'C_FRESH'
    writeFileSync(cronTablePath, `* * * * * ${promptPath} ${channel}\n`)

    const { scheduler } = makeWiring({ cronTablePath, now: FIXED_NOW })
    scheduler.start()

    // Edit the PROMPT FILE (not the crontable — crontable hot-reload is E3
    // scope) AFTER the scheduler has loaded the table. The dispatcher reads the
    // prompt fresh at fire time, so the edited content must win.
    const editedBody = 'EDITED content after start(), before tick()'
    writeFileSync(promptPath, editedBody)

    await scheduler.tick()

    expect(posts).toHaveLength(1)
    expect(posts[0]!.body.channel).toBe(channel)
    expect(posts[0]!.body.message).toBe(editedBody)
  })

  test('the monotonic guard: two ticks in the SAME minute POST only once', async () => {
    const dir = makeTempDir('cscb-sched-mono-')
    const promptPath = join(dir, 'once-tick.md')
    writeFileSync(promptPath, 'fire once per minute')

    const cronTablePath = join(dir, 'crontab')
    writeFileSync(cronTablePath, `* * * * * ${promptPath} C_ONCE\n`)

    const { scheduler } = makeWiring({ cronTablePath, now: FIXED_NOW })
    scheduler.start()
    // Two forced ticks with the SAME injected now(): the second observes a
    // minute that is not strictly after the last-ticked minute and is skipped
    // whole (no second POST, no re-fire).
    await scheduler.tick()
    await scheduler.tick()

    expect(posts).toHaveLength(1)
  })
})
