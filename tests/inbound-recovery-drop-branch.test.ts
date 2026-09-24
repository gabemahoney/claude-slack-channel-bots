/**
 * inbound-recovery-drop-branch.test.ts — b.kvq, per persona.
 *
 * Bug: an inbound Slack message for a persona with no live session was
 * dropped before anything called scheduleRestart, so a dead or spawn-capped
 * session never recovered from a human typing to it, and the courtesy reply
 * ("session starting up, please retry") lied for capped or dead sessions.
 *
 * The fix: when the receiving persona P qualifies for the message but has no
 * live session, the lost-message branch in src/persona-routing.ts applies the
 * restart guards for P (a restart already pending or running, auto-restart
 * disabled, P at the restart-failure cap), schedules a human-triggered
 * restart of P in its working directory when they allow it, and posts one
 * honest "not delivered" reply to the source channel through P's own client.
 * In src/restart.ts, `scheduleRestart(…, { humanTrigger: true })` clamps the
 * backoff delay DOWN to HUMAN_TRIGGER_DELAY_CEILING (never up).
 *
 * These tests drive the real module (`createPersonaRouting(deps).receive`)
 * through the shared harness (tests/test-helpers/persona-routing-harness.ts)
 * over the real registry, restart.ts and backoff.ts state, with one
 * `makeStubSlack` client per persona. The receiving persona (alpha) is the
 * SECOND persona of the config, and every lost-message case also checks that
 * the first persona (beta) got no restart and no post, so recovery or a reply
 * keyed to the wrong persona fails. The streamless branch (b.9cj) is
 * covered by tests/dispatch-get-stream.test.ts; general delivery by
 * tests/persona-routing.test.ts. src/server.ts cannot be imported in a test
 * (module-scope startup code), so describe (7) audits its source to keep one
 * tested copy of the branch: server.ts must hand inbound events to the
 * routing module and hold no copy of its own.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initRestart,
  scheduleRestart,
  isRestartPendingOrActive,
  HUMAN_TRIGGER_DELAY_CEILING,
  RESTART_FAILURE_CAP,
} from '../src/restart.ts'
import { recordFailure, isAtCap } from '../src/backoff.ts'
import type { Persona } from '../src/config.ts'
import {
  LOST_MESSAGE_AUTO_RESTART_DISABLED_REPLY,
  LOST_MESSAGE_CAPPED_REPLY,
  LOST_MESSAGE_RESTARTING_REPLY,
  LOST_MESSAGE_STARTED_REPLY,
} from '../src/persona-routing.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { makeChannelMessage, type SlackEvent, type StubSlackOptions } from './test-helpers/slack-stub.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { indicesOf, stripComments } from './test-helpers/source-audit.ts'
import {
  makeRestartDeps,
  makeRoutingHarness,
  resetRoutingState,
  NEVER_FIRE_RESTART_DELAY_S,
  type RoutingHarness,
  type RoutingHarnessOptions,
} from './test-helpers/persona-routing-harness.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_DELAY_S = 0.01 // 10 ms timer — fast enough for tests
const SLOW_DELAY_S = NEVER_FIRE_RESTART_DELAY_S // never fires during a test
const WAIT_MS = 50

/** Alpha's two channels (`all`), beta's one (`mentions`), and a channel nobody lists. */
const ALPHA_HOME = 'C0ALPHA01'
const ALPHA_SECOND = 'C0ALPHA02'
const BETA_MENTIONS = 'C0BETA001'
const UNCLAIMED = 'C0NOBODY1'

// ---------------------------------------------------------------------------
// Harness: the shared routing harness over beta (first) and alpha (second,
// the receiving persona), with no session registered unless asked
// ---------------------------------------------------------------------------

type Harness = RoutingHarness & {
  /** The receiving persona in every lost-message case: personas[1]. */
  alpha: Persona
  /** The other persona: personas[0]. */
  beta: Persona
  /** Deliver `event` to the receiving persona key(s), as the socket handler does. */
  deliver(event: unknown, keys: string | readonly string[]): Promise<void>
}

let dir: string
let harnesses: RoutingHarness[] = []

function makeHarness(opts: {
  sessionRestartDelay?: number
  restartDelayS?: number
  launchSession?: RoutingHarnessOptions['launchSession']
  sessions?: readonly string[]
  disconnected?: readonly string[]
  alphaStub?: StubSlackOptions
} = {}): Harness {
  const h = makeRoutingHarness(
    [
      { name: 'beta', channels: [{ id: BETA_MENTIONS, delivery: 'mentions' }] },
      {
        name: 'alpha',
        channels: [
          { id: ALPHA_HOME, delivery: 'all' },
          { id: ALPHA_SECOND, delivery: 'all' },
        ],
      },
    ],
    dir,
    {
      sessions: opts.sessions ?? [],
      disconnected: opts.disconnected,
      overrides: { session_restart_delay: opts.sessionRestartDelay ?? 60 },
      restartDelayS: opts.restartDelayS ?? FAST_DELAY_S,
      launchSession: opts.launchSession,
      stubOptions: opts.alphaStub ? { alpha: opts.alphaStub } : undefined,
    },
  )
  harnesses.push(h)
  const [beta, alpha] = h.config!.personas as [Persona, Persona]
  return Object.assign(h, {
    alpha,
    beta,
    deliver: (event: unknown, keys: string | readonly string[]) =>
      h.receiveKeys(event, typeof keys === 'string' ? [keys] : keys),
  })
}

/** The first persona (beta) got no restart and no post. */
function expectBetaUntouched(h: Harness): void {
  expect(isRestartPendingOrActive(h.beta.key)).toBe(false)
  expect(h.allPosts().filter((p) => p.key === h.beta.key)).toEqual([])
}

/** A human's message in `channel`. */
function messageIn(channel: string, text = 'hello, anyone there?') {
  return makeChannelMessage({ channel, text })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kvq-drop-branch-'))
  harnesses = []
  resetRoutingState()
})

afterEach(() => {
  try {
    // Every log line and post the module produced is free of token material.
    assertNoLeak(harnesses.map((h) => h.captured()))
  } finally {
    resetRoutingState()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===========================================================================
// Required behavior 1 — a qualifying message with no live session recovers P
// ===========================================================================

describe('b.kvq (1) a qualifying message for a sessionless persona triggers recovery', () => {
  // REGRESSION GUARD: before the fix, the drop branch never called
  // scheduleRestart for a sessionless recipient (the whole point of b.kvq), so
  // no launch was ever scheduled and the reply claimed "session starting up"
  // without any recovery underway.
  test('REGRESSION: a message in the persona\'s channel schedules a launch keyed to the persona, in its working directory, and it fires', async () => {
    const h = makeHarness()

    await h.deliver(messageIn(ALPHA_HOME), h.alpha.key)

    // Real side effect: a restart is now pending for the persona …
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    // … and for no other persona.
    expectBetaUntouched(h)

    // And the timer really fires and launches in the persona's working directory.
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toEqual([{ key: h.alpha.key, cwd: h.alpha.working_directory }])
  })

  test('a message in the persona\'s SECOND channel recovers under the persona key, not the source channel, and replies there', async () => {
    const h = makeHarness()

    await h.deliver(messageIn(ALPHA_SECOND), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(isRestartPendingOrActive(ALPHA_SECOND)).toBe(false)
    expectBetaUntouched(h)
    // One reply, to the source channel, on the receiving persona's client only.
    expect(h.allPosts()).toEqual([
      { key: h.alpha.key, channel: ALPHA_SECOND, text: LOST_MESSAGE_STARTED_REPLY },
    ])

    await Bun.sleep(WAIT_MS)
    expect(h.launches).toHaveLength(1)
    expect(h.launches[0]!.key).toBe(h.alpha.key)
  })

  test('a registered but disconnected session counts as no session: recovery in the persona\'s working directory', async () => {
    const h = makeHarness({ sessions: ['alpha'], disconnected: ['alpha'] })

    await h.deliver(messageIn(ALPHA_HOME), h.alpha.key)

    expect(h.allPosts()).toEqual([
      { key: h.alpha.key, channel: ALPHA_HOME, text: LOST_MESSAGE_STARTED_REPLY },
    ])
    expectBetaUntouched(h)
    await Bun.sleep(WAIT_MS)
    expect(h.launches.map((c) => c.cwd)).toEqual([h.alpha.working_directory])
  })

  test.each([ALPHA_HOME, ALPHA_SECOND])(
    'a pending restart on the persona suppresses a launch triggered from %s',
    async (channel) => {
      // SLOW delay keeps the persona's restart pending across the message.
      const h = makeHarness({ restartDelayS: SLOW_DELAY_S })
      scheduleRestart(h.alpha.key, h.alpha.working_directory, undefined, { humanTrigger: true })

      await h.deliver(messageIn(channel), h.alpha.key)

      // The guard read the persona's pending state: "restarting", not "started".
      // Keyed on the source channel, it would have found nothing pending.
      expect(h.allPosts()).toEqual([
        { key: h.alpha.key, channel, text: LOST_MESSAGE_RESTARTING_REPLY },
      ])
      expectBetaUntouched(h)
    },
  )

  test.each([ALPHA_HOME, ALPHA_SECOND])(
    'a cap on the persona suppresses recovery triggered from %s',
    async (channel) => {
      const h = makeHarness()
      for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(h.alpha.key)
      // The source channel is NOT at cap — keying on it would wrongly launch.
      expect(isAtCap(channel, RESTART_FAILURE_CAP)).toBe(false)

      await h.deliver(messageIn(channel), h.alpha.key)

      expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
      expect(isRestartPendingOrActive(channel)).toBe(false)
      expect(h.allPosts()).toEqual([
        { key: h.alpha.key, channel, text: LOST_MESSAGE_CAPPED_REPLY },
      ])
      expectBetaUntouched(h)
      await Bun.sleep(WAIT_MS)
      expect(h.launches).toHaveLength(0)
    },
  )
})

// ===========================================================================
// Required behavior 2 — a message that does not qualify for P triggers nothing
// ===========================================================================

describe('b.kvq (2) a message the persona does not get triggers nothing and posts nothing, with no session anywhere', () => {
  test.each<[string, 'two' | 'none', (h: Harness) => SlackEvent, 'alpha' | 'beta' | 'none']>([
    ['a channel no persona lists', 'two', () => messageIn(UNCLAIMED, 'hello'), 'alpha'],
    ['an unmentioned message in a `mentions` channel', 'two', () => messageIn(BETA_MENTIONS, 'hello, no mention here'), 'beta'],
    ['a channel the persona is not configured into (another persona\'s)', 'two', () => messageIn(BETA_MENTIONS, 'hello'), 'alpha'],
    ['the persona\'s own message in its `all` channel', 'two', (h) => makeChannelMessage({ channel: ALPHA_HOME, user: h.p('alpha').stub.identity.botUserId }), 'alpha'],
    ['an intake call with no applied personas (zero-persona config)', 'none', () => messageIn(ALPHA_HOME, 'hello'), 'none'],
    ['a key that is not an applied persona (zero-persona config)', 'none', () => messageIn(ALPHA_HOME, 'hello'), 'alpha'],
  ])('%s', async (_label, personas, build, receiver) => {
    const h = makeHarness()
    if (personas === 'none') h.config = { ...h.config!, personas: [] }
    const keys = receiver === 'none' ? [] : [receiver === 'alpha' ? h.alpha.key : h.beta.key]
    const event = build(h)

    await h.deliver(event, keys)

    for (const key of [h.alpha.key, h.beta.key, event.channel as string]) {
      expect(isRestartPendingOrActive(key)).toBe(false)
    }
    expect(h.allPosts()).toEqual([])
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toHaveLength(0)
  })
})

// ===========================================================================
// Required behavior 3 — a second message while restarting does not stack
// ===========================================================================

describe('b.kvq (3) second message while restart pending/active does not stack a launch', () => {
  test('two messages in quick succession: one "started" reply, then one "restarting" reply', async () => {
    // SLOW delay keeps the first restart pending across the second message.
    const h = makeHarness({ restartDelayS: SLOW_DELAY_S })

    await h.deliver(messageIn(ALPHA_HOME), h.alpha.key)
    await h.deliver(messageIn(ALPHA_SECOND), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(h.allPosts()).toEqual([
      { key: h.alpha.key, channel: ALPHA_HOME, text: LOST_MESSAGE_STARTED_REPLY },
      { key: h.alpha.key, channel: ALPHA_SECOND, text: LOST_MESSAGE_RESTARTING_REPLY },
    ])
    expectBetaUntouched(h)
  })

  test('while a launch is actively in flight, a new message does not stack another launch', async () => {
    // Hold launchSession open so the persona is in activeLaunches (not just a
    // pending timer) when the second message arrives.
    let launchResolve!: (ok: boolean) => void
    const launchPromise = new Promise<boolean>((res) => { launchResolve = res })
    const h = makeHarness({ restartDelayS: FAST_DELAY_S, launchSession: () => launchPromise })

    await h.deliver(messageIn(ALPHA_HOME), h.alpha.key)
    await Bun.sleep(WAIT_MS) // timer fired; launchSession is now awaiting
    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(h.launches).toHaveLength(1)

    await h.deliver(messageIn(ALPHA_HOME), h.alpha.key)
    await Bun.sleep(WAIT_MS) // a stacked timer would have fired by now

    // Still exactly one launch despite the second message.
    expect(h.launches).toHaveLength(1)
    expect(h.allPosts().map((p) => p.text)).toEqual([LOST_MESSAGE_STARTED_REPLY, LOST_MESSAGE_RESTARTING_REPLY])
    expectBetaUntouched(h)

    launchResolve(true)
    await Bun.sleep(1)
  })
})

// ===========================================================================
// Required behavior 4 — reply text differs per branch; none imply delivery.
// Each branch's constant, posted on the receiving persona's client, is
// asserted in (1) (started, restarting, capped) and (5) (disabled).
// ===========================================================================

describe('b.kvq (4) user-facing reply differs correctly per branch', () => {
  test('the four reply constants are distinct and honest; none imply delivery', () => {
    const texts = [
      LOST_MESSAGE_STARTED_REPLY,
      LOST_MESSAGE_RESTARTING_REPLY,
      LOST_MESSAGE_CAPPED_REPLY,
      LOST_MESSAGE_AUTO_RESTART_DISABLED_REPLY,
    ].map((t) => t.toLowerCase())
    expect(new Set(texts).size).toBe(4)
    for (const t of texts) expect(t).toContain('not delivered')

    const [started, restarting, capped, disabled] = texts as [string, string, string, string]
    // started — recovery underway, retry.
    expect(started).toContain('started the session')
    expect(started).toContain('retry in a moment')
    // restarting — retry; NOT an operator instruction.
    expect(restarting).toContain('restarting')
    expect(restarting).toContain('retry in a moment')
    expect(restarting).not.toContain('operator')
    // capped — restart-failure limit; will NOT recover; operator must restart.
    expect(capped).toContain('restart-failure limit')
    expect(capped).toContain('will not recover')
    expect(capped).toContain('operator')
    expect(capped).not.toContain('retry in a moment')
    // disabled — auto-restart disabled; will NOT recover; operator must restart.
    expect(disabled).toContain('auto-restart is disabled')
    expect(disabled).toContain('will not recover')
    expect(disabled).toContain('operator')
    expect(disabled).not.toContain('retry in a moment')
  })

  test.each([
    ['network', { kind: 'network' as const }],
    ['platform', { kind: 'platform' as const, error: 'not_in_channel' }],
  ])('a failed reply post (%s) is logged naming the persona and the channel, without leaking, never thrown, and recovery still happens', async (_label, outcome) => {
    const h = makeHarness({ restartDelayS: SLOW_DELAY_S, alphaStub: { post: [outcome] } })

    await h.deliver(messageIn(ALPHA_HOME), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(h.allPosts().map((p) => p.key)).toEqual([h.alpha.key])
    expectBetaUntouched(h)
    const ref = renderPersonaRef(h.alpha.name, h.alpha.key)
    expect(h.logs.filter((l) => l.includes(`failed to post lost-message reply for persona ${ref} to chat_id=${ALPHA_HOME}`))).toHaveLength(1)
    expect(h.logs.filter((l) => l.includes('error handling event'))).toEqual([])
    assertNoLeak({ lines: h.logs }, 'post-failure lines')
  })

  test('with no validated client for the persona, recovery still happens, nothing is posted by any client, and one line names the persona and the channel', async () => {
    const h = makeHarness({ restartDelayS: SLOW_DELAY_S })
    h.clients.setUnavailable(h.alpha.key)

    await h.deliver(messageIn(ALPHA_HOME), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(true)
    expect(isRestartPendingOrActive(h.beta.key)).toBe(false)
    expect(h.allPosts()).toEqual([])
    const ref = renderPersonaRef(h.alpha.name, h.alpha.key)
    expect(h.logs.filter((l) => l.includes(`persona ${ref} has no validated Slack client`) && l.includes(`chat_id=${ALPHA_HOME}`))).toHaveLength(1)
  })
})

// ===========================================================================
// Required behavior 5 — auto-restart disabled (session_restart_delay 0)
// ===========================================================================

describe('b.kvq (5) auto-restart disabled (delay 0) path', () => {
  test('the disabled branch schedules no launch, even with restart.ts itself able to launch', async () => {
    // The restart deps report a nonzero delay, so had the branch called
    // scheduleRestart anyway, the launch would really fire.
    const h = makeHarness({ sessionRestartDelay: 0, restartDelayS: FAST_DELAY_S })

    await h.deliver(messageIn(ALPHA_SECOND), h.alpha.key)

    expect(isRestartPendingOrActive(h.alpha.key)).toBe(false)
    expect(h.allPosts()).toEqual([
      { key: h.alpha.key, channel: ALPHA_SECOND, text: LOST_MESSAGE_AUTO_RESTART_DISABLED_REPLY },
    ])
    expectBetaUntouched(h)
    await Bun.sleep(WAIT_MS)
    expect(h.launches).toHaveLength(0)
  })

  test('scheduleRestart with humanTrigger still early-returns when base delay is 0', async () => {
    // Pin the restart.ts gate directly: humanTrigger does not bypass it.
    const deps = makeRestartDeps({ restartDelayS: 0 })
    initRestart(deps)

    scheduleRestart('kvq_disabled', join(dir, 'kvq-session'), undefined, { humanTrigger: true })
    await Bun.sleep(WAIT_MS)

    expect(isRestartPendingOrActive('kvq_disabled')).toBe(false)
    expect(deps.launches).toHaveLength(0)
  })
})

// ===========================================================================
// Required behavior 6 — humanTrigger clamps delay DOWN only
//
// These tests capture the delay argument passed to global setTimeout by
// scheduleRestart, so they read the ACTUAL scheduled delay rather than waiting
// out multi-second timers. restart.ts uses the global setTimeout, so wrapping
// it here is a legitimate observation seam.
// ===========================================================================

describe('b.kvq (6) humanTrigger delay clamp (DOWN only)', () => {
  const realSetTimeout = globalThis.setTimeout
  let capturedDelayMs: number | null = null

  beforeEach(() => {
    capturedDelayMs = null
    // Capture the delay, but do NOT actually arm a real timer (return a stub
    // handle) so the launch never fires during these timing-only tests.
    globalThis.setTimeout = ((_fn: (...a: unknown[]) => void, ms?: number) => {
      capturedDelayMs = ms ?? 0
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout
  })

  test('a 900s-cap-regime backoff is clamped down to HUMAN_TRIGGER_DELAY_CEILING', () => {
    initRestart(makeRestartDeps({ restartDelayS: 60 }))
    // Drive failure count high enough that nextBackoffDelay saturates at 900s:
    // 60 * 2^4 = 960 → clamped to 900 by backoff.ts.
    for (let i = 0; i < 4; i++) recordFailure('kvq_cap900')

    scheduleRestart('kvq_cap900', '/tmp/kvq-session', undefined, { humanTrigger: true })

    // Computed backoff was 900s; humanTrigger clamps it to the 5s ceiling.
    expect(capturedDelayMs).toBe(HUMAN_TRIGGER_DELAY_CEILING * 1000)
  })

  test('a NON-human trigger in the same 900s regime is NOT clamped', () => {
    initRestart(makeRestartDeps({ restartDelayS: 60 }))
    for (let i = 0; i < 4; i++) recordFailure('kvq_cap900')

    scheduleRestart('kvq_cap900', '/tmp/kvq-session') // no opts → not human

    expect(capturedDelayMs).toBe(900 * 1000)
  })

  test('a delay already below the ceiling is NOT raised by humanTrigger', () => {
    // base 1s, zero failures → nextBackoffDelay = 1s, which is below the 5s
    // ceiling. Math.min must leave it at 1s (clamp DOWN only).
    initRestart(makeRestartDeps({ restartDelayS: 1 }))

    scheduleRestart('kvq_small', '/tmp/kvq-session', undefined, { humanTrigger: true })

    expect(capturedDelayMs).toBe(1 * 1000)
    expect(capturedDelayMs).toBeLessThan(HUMAN_TRIGGER_DELAY_CEILING * 1000)
  })
})

// ===========================================================================
// Required behavior 7 — one tested copy: server.ts takes the branch from the
// routing module and holds no copy of its own
//
// server.ts cannot be imported in a test, so this audits its comment-stripped
// source (see tests/start-sweep-wiring.test.ts). If the drop branch were
// re-inlined in server.ts, the behavioural tests above would keep passing
// against the module while production ran an untested copy.
// ===========================================================================

describe('b.kvq (7) server.ts holds no copy of the lost-message branch', () => {
  const SERVER_SRC = readFileSync('src/server.ts', 'utf-8')
  const SERVER_CODE = stripComments(SERVER_SRC)

  test('server.ts code contains no lost-message reply and no human-triggered scheduleRestart call site', () => {
    for (const reply of [
      LOST_MESSAGE_STARTED_REPLY,
      LOST_MESSAGE_RESTARTING_REPLY,
      LOST_MESSAGE_CAPPED_REPLY,
      LOST_MESSAGE_AUTO_RESTART_DISABLED_REPLY,
    ]) {
      expect(SERVER_CODE).not.toContain(reply.slice(0, 60))
    }
    expect(indicesOf(/not delivered/gi, SERVER_CODE)).toEqual([])
    expect(indicesOf(/\bhumanTrigger\b/g, SERVER_CODE)).toEqual([])
  })

  test('server.ts builds one persona-routing instance and hands both inbound event kinds to it', () => {
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*\bcreatePersonaRouting\b[^}]*\}\s*from\s*['"]\.\/persona-routing\.ts['"]/,
    )
    expect(indicesOf(/\bcreatePersonaRouting\s*\(/g, SERVER_CODE)).toHaveLength(1)
    for (const kind of ['message', 'app_mention']) {
      const start = SERVER_CODE.search(new RegExp(`socket\\.on\\(\\s*['"]${kind}['"]`))
      expect(start).toBeGreaterThanOrEqual(0)
      const next = SERVER_CODE.indexOf('socket.on(', start + 1)
      const handler = SERVER_CODE.slice(start, next === -1 ? undefined : next)
      expect(handler).toMatch(/\bpersonaRouting\.receive\s*\(\s*event\s*,\s*ack\s*,/)
    }
  })

  test('the restart guard and the health check take the stream probe from the routing module', () => {
    expect(SERVER_SRC).toMatch(
      /import\s*\{[^}]*\bhasSessionStream\b[^}]*\}\s*from\s*['"]\.\/persona-routing\.ts['"]/,
    )
    // No local probe that could drift from the module's.
    expect(indicesOf(/(?:function|const|let)\s+hasSessionStream\w*\b/g, SERVER_CODE)).toEqual([])
    for (const init of ['initRestart', 'initHealthCheck']) {
      const block = SERVER_CODE.match(new RegExp(`\\b${init}\\(\\{[\\s\\S]*?\\n\\s*\\}\\)`))
      expect(block).not.toBeNull()
      expect(block![0]).toMatch(/\bhasSessionStream\s*(?:,|:\s*hasSessionStream\b)/)
    }
  })
})
