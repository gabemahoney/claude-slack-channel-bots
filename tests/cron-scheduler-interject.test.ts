/**
 * cron-scheduler-interject.test.ts — Integration-style tick-to-/interject test
 * (Epic t1.he5.eu AC; Task t2.he5.eu.4q; b.av2 SR-9.3 and AC 50). Wires the
 * REAL scheduler, dispatcher, cron-log and `/interject` handler
 * (src/interject.ts) together end to end. No mocks of the product modules; no
 * real sleeping.
 *
 * The handler is served by a port-0 `Bun.serve` bound to 127.0.0.1 in this
 * process and handed each request the way server.ts does. Its dependencies are
 * a two-persona config from `makeMultiPersonaConfig` and stub sessions keyed by
 * persona key that capture notifications. The dispatcher resolves targets over
 * the same config, as server.ts wires it (`resolvePersonaTarget(...)?.key`).
 *
 * The clock is fully injected. The scheduler arms its next pass via
 * clock.setTimeout, but this test's fake clock DISCARDS that handler and never
 * auto-fires it — every pass is driven through the direct `tick()` seam with an
 * injected now() inside a `* * * * *` minute. `* * * * *` matches every minute,
 * so the test is TZ-agnostic (no local-time coupling).
 *
 * Everything lives under mkdtemp temp dirs and this file's own port-0 server —
 * never the live server, live crontable, or any cscb_/slack_bot_ session.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PersonaConfig } from '../src/config.ts'
import { createCronLog } from '../src/cron-log.ts'
import { createCronDispatcher } from '../src/cron-dispatch.ts'
import { createCronScheduler, type SchedulerClock } from '../src/cron-scheduler.ts'
import { handleInterject, type InterjectSession } from '../src/interject.ts'
import { personaKey, resolvePersonaTarget } from '../src/persona-identity.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'

// ---------------------------------------------------------------------------
// Personas: A's name has a capital, so its key is the hashed form; B's name is
// already a key. Crontable tokens are whitespace-separated, so neither name
// has a space.
// ---------------------------------------------------------------------------

const A_NAME = 'Planner'
const A_KEY = personaKey(A_NAME)
const B_NAME = 'reviewer'
const B_KEY = personaKey(B_NAME)

interface CapturedNotification {
  method: string
  params: { content: string; meta: Record<string, string> }
}

interface StubSession {
  session: InterjectSession
  calls: CapturedNotification[]
}

function makeStubSession(): StubSession {
  const calls: CapturedNotification[] = []
  const server = {
    notification: (n: CapturedNotification) => {
      calls.push(n)
      return Promise.resolve()
    },
  }
  return { session: { connected: true, server } as unknown as InterjectSession, calls }
}

// ---------------------------------------------------------------------------
// The real /interject handler on port 0, 127.0.0.1. Every request is also
// recorded (method, path, parsed body) so the POST itself can be asserted.
// ---------------------------------------------------------------------------

interface CapturedPost {
  method: string
  path: string
  body: { persona?: unknown; message?: unknown; sender?: unknown }
}

const posts: CapturedPost[] = []
let personaConfig: PersonaConfig | null = null
const sessions = new Map<string, InterjectSession>()
let a: StubSession
let b: StubSession
/** Persona keys that are not up; every other persona is up. */
const notUp = new Set<string>()

const interjectServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req, server): Promise<Response> {
    const url = new URL(req.url)
    const raw = await req.clone().text()
    let body: CapturedPost['body'] = {}
    try {
      body = JSON.parse(raw)
    } catch {
      /* leave body empty on parse failure */
    }
    posts.push({ method: req.method, path: url.pathname, body })
    if (url.pathname !== '/interject') return new Response('Not Found', { status: 404 })
    return handleInterject(req, server.requestIP(req)?.address, {
      getPersonaConfig: () => personaConfig,
      isPersonaUp: (key) => !notUp.has(key),
      getSessionByPersona: (key) => sessions.get(key),
      log: () => {},
    })
  },
})

const PORT = interjectServer.port as number

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
  target: string
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
      const [timestamp, identity, target, outcome, ...rest] = line.split(' ')
      return {
        timestamp: timestamp ?? '',
        identity: identity ?? '',
        target: target ?? '',
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
  const dispatcher = createCronDispatcher({
    port: PORT,
    cronLog,
    cronTablePath: opts.cronTablePath,
    resolveTarget: (target) => resolvePersonaTarget(personaConfig, target)?.key,
  })
  const scheduler = createCronScheduler({
    dispatcher,
    cronLog,
    cronTablePath: opts.cronTablePath,
    clock: makeNonFiringClock(opts.now),
  })
  return { scheduler, logPath, lines: () => readLog(logPath) }
}

/** Write a prompt and a one-line crontable; return the crontable path. */
function writeTable(dir: string, promptName: string, promptBody: string, targets: string): string {
  writeFileSync(join(dir, promptName), promptBody)
  const cronTablePath = join(dir, 'crontab')
  writeFileSync(cronTablePath, `* * * * * ${join(dir, promptName)} ${targets}\n`)
  return cronTablePath
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  posts.length = 0
  tempDirs = []
  const configDir = makeTempDir('cscb-sched-config-')
  personaConfig = makeMultiPersonaConfig([{ name: A_NAME }, { name: B_NAME }], configDir)
  a = makeStubSession()
  b = makeStubSession()
  sessions.clear()
  sessions.set(A_KEY, a.session)
  sessions.set(B_KEY, b.session)
  notUp.clear()
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
  interjectServer.stop(true)
})

// ---------------------------------------------------------------------------
// Epic AC — one crontable line delivered end-to-end through the real modules.
// ---------------------------------------------------------------------------

describe('tick → /interject end-to-end (real scheduler + dispatcher + cron-log + handler)', () => {
  test('single `* * * * *` schedule fires exactly once, delivers prompt content, logs delivered + summary', async () => {
    const dir = makeTempDir('cscb-sched-e2e-')
    const promptBody = 'Grooming tick: please check the queue.'
    const cronTablePath = writeTable(dir, 'grooming-tick.md', promptBody, B_NAME)

    const { scheduler, lines } = makeWiring({ cronTablePath, now: FIXED_NOW })
    scheduler.start()
    await scheduler.tick()

    // Exactly one POST reached /interject, naming B by key.
    expect(posts).toHaveLength(1)
    expect(posts[0]!.method).toBe('POST')
    expect(posts[0]!.path).toBe('/interject')
    expect(posts[0]!.body).toEqual({ persona: B_KEY, message: promptBody, sender: 'cscb-cron:grooming-tick' })

    // B's session got the prompt content under the single-schedule sender
    // `cscb-cron:<basename-without-extension>`.
    expect(b.calls).toHaveLength(1)
    expect(b.calls[0]!.params.content).toBe(promptBody)
    expect(b.calls[0]!.params.meta.user).toBe('cscb-cron:grooming-tick')
    expect(a.calls).toHaveLength(0)

    // The cron log gains a `delivered` outcome for that (identity, target).
    const log = lines()
    const delivered = log.filter((l) => l.outcome === 'delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.identity).toBe('cscb-cron:grooming-tick')
    expect(delivered[0]!.target).toBe(B_NAME)
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
    // Relative token 6 → resolves against dirname(cronTablePath) = dir.
    writeFileSync(cronTablePath, `* * * * * rel-tick.md ${B_NAME}\n`)

    const { scheduler, lines } = makeWiring({ cronTablePath, now: FIXED_NOW })
    scheduler.start()
    await scheduler.tick()

    expect(posts).toHaveLength(1)
    expect(posts[0]!.body).toEqual({ persona: B_KEY, message: promptBody, sender: 'cscb-cron:rel-tick' })
    expect(b.calls).toHaveLength(1)
    expect(b.calls[0]!.params.content).toBe(promptBody)
    expect(b.calls[0]!.params.meta.user).toBe('cscb-cron:rel-tick')

    const delivered = lines().filter((l) => l.outcome === 'delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.target).toBe(B_NAME)
  })

  test('editing the PROMPT FILE between start() and tick() → the notification carries the EDITED content (fresh read, not pinned at load)', async () => {
    const dir = makeTempDir('cscb-sched-fresh-')
    const cronTablePath = writeTable(dir, 'live-tick.md', 'ORIGINAL content at start()', B_NAME)

    const { scheduler } = makeWiring({ cronTablePath, now: FIXED_NOW })
    scheduler.start()

    // Edit the PROMPT FILE (not the crontable — crontable hot-reload is its own
    // step at the top of the tick, covered in tests/cron-scheduler-reload.test.ts)
    // AFTER the scheduler has loaded the table. The dispatcher reads the prompt
    // fresh at fire time, so the edited content must win.
    const editedBody = 'EDITED content after start(), before tick()'
    writeFileSync(join(dir, 'live-tick.md'), editedBody)

    await scheduler.tick()

    expect(posts).toHaveLength(1)
    expect(posts[0]!.body.persona).toBe(B_KEY)
    expect(b.calls).toHaveLength(1)
    expect(b.calls[0]!.params.content).toBe(editedBody)
  })

  test('the monotonic guard: two ticks in the SAME minute deliver only once', async () => {
    const dir = makeTempDir('cscb-sched-mono-')
    const cronTablePath = writeTable(dir, 'once-tick.md', 'fire once per minute', B_NAME)

    const { scheduler } = makeWiring({ cronTablePath, now: FIXED_NOW })
    scheduler.start()
    // Two forced ticks with the SAME injected now(): the second observes a
    // minute that is not strictly after the last-ticked minute and is skipped
    // whole (no second POST, no re-fire).
    await scheduler.tick()
    await scheduler.tick()

    expect(posts).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// AC 50 — a persona-targeted scheduled prompt reaches only that persona, and a
// persona named by name and by key delivers once.
// ---------------------------------------------------------------------------

describe('AC 50: scheduled prompts reach only the targeted persona (real /interject handler)', () => {
  test.each([
    ['by name', A_NAME, A_NAME],
    ['by key', A_KEY, A_KEY],
    ['by name and by key', `${A_NAME},${A_KEY}`, A_NAME],
    ['by key, then by name twice', `${A_KEY},${A_NAME},${A_NAME}`, A_KEY],
  ])(
    'AC 50: a line naming persona A %s → exactly one notification, on A only, and one `delivered` line',
    async (_label, targets, loggedTarget) => {
      const dir = makeTempDir('cscb-sched-ac50-')
      const promptBody = 'scheduled for A'
      const cronTablePath = writeTable(dir, 'a-tick.md', promptBody, targets)

      const { scheduler, lines } = makeWiring({ cronTablePath, now: FIXED_NOW })
      scheduler.start()
      await scheduler.tick()

      expect(a.calls).toHaveLength(1)
      expect(b.calls).toHaveLength(0)
      const { method, params } = a.calls[0]!
      expect(method).toBe('notifications/claude/channel')
      expect(params.content).toBe(promptBody)
      expect(params.meta.user).toBe('cscb-cron:a-tick')
      expect(Object.keys(params.meta).sort()).toEqual(['ts', 'user'])
      expect(params.meta).not.toHaveProperty('chat_id')

      expect(posts.map((p) => p.body.persona)).toEqual([A_KEY])

      const log = lines()
      const delivered = log.filter((l) => l.outcome === 'delivered')
      expect(delivered).toHaveLength(1)
      expect(delivered[0]!.target).toBe(loggedTarget)
      const summary = log.find((l) => l.outcome === 'summary')!
      expect(token(summary.detail, 'delivered')).toBe('1')
      expect(token(summary.detail, 'failed')).toBe('0')
    },
  )

  test('AC 50: a line naming an unknown persona logs `unknown-persona` with the target as written; no session is notified', async () => {
    const dir = makeTempDir('cscb-sched-unknown-')
    const cronTablePath = writeTable(dir, 'lost-tick.md', 'nobody home', 'Nobody_Here')

    const { scheduler, lines } = makeWiring({ cronTablePath, now: FIXED_NOW })
    scheduler.start()
    await scheduler.tick()

    expect(a.calls).toHaveLength(0)
    expect(b.calls).toHaveLength(0)
    const log = lines()
    const unknown = log.filter((l) => l.outcome === 'unknown-persona')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]!.target).toBe('Nobody_Here')
    expect(token(unknown[0]!.detail, 'status')).toBe('404')
    const summary = log.find((l) => l.outcome === 'summary')!
    expect(token(summary.detail, 'delivered')).toBe('0')
    expect(token(summary.detail, 'failed')).toBe('1')
  })

  test('AC 50: a line naming a persona with no session logs `no-session`; the other persona is not notified', async () => {
    sessions.delete(A_KEY)
    const dir = makeTempDir('cscb-sched-nosession-')
    const cronTablePath = writeTable(dir, 'idle-tick.md', 'A is away', A_NAME)

    const { scheduler, lines } = makeWiring({ cronTablePath, now: FIXED_NOW })
    scheduler.start()
    await scheduler.tick()

    expect(a.calls).toHaveLength(0)
    expect(b.calls).toHaveLength(0)
    const noSession = lines().filter((l) => l.outcome === 'no-session')
    expect(noSession).toHaveLength(1)
    expect(noSession[0]!.target).toBe(A_NAME)
    expect(token(noSession[0]!.detail, 'status')).toBe('503')
  })
  test('SR-6.4: a line naming a not-up persona that still has a connected session logs `no-session` (503); no session is notified', async () => {
    notUp.add(A_KEY)
    expect(sessions.get(A_KEY)?.connected).toBe(true)
    const dir = makeTempDir('cscb-sched-notup-')
    const cronTablePath = writeTable(dir, 'broken-tick.md', 'A is not up', A_NAME)

    const { scheduler, lines } = makeWiring({ cronTablePath, now: FIXED_NOW })
    scheduler.start()
    await scheduler.tick()

    expect(posts.map((p) => p.body.persona)).toEqual([A_KEY])
    expect(a.calls).toHaveLength(0)
    expect(b.calls).toHaveLength(0)
    const log = lines()
    const noSession = log.filter((l) => l.outcome === 'no-session')
    expect(noSession).toHaveLength(1)
    expect(noSession[0]!.target).toBe(A_NAME)
    expect(token(noSession[0]!.detail, 'status')).toBe('503')
    expect(log.filter((l) => l.outcome === 'delivered')).toHaveLength(0)
    const summary = log.find((l) => l.outcome === 'summary')!
    expect(token(summary.detail, 'delivered')).toBe('0')
    expect(token(summary.detail, 'failed')).toBe('1')
  })
})
