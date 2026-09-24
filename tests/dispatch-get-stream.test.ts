/**
 * dispatch-get-stream.test.ts — the b.sjy instrumentation and the b.9cj
 * streamless-dispatch branch, per persona.
 *
 * When the receiving persona P has a connected session whose transport has
 * lost its standalone GET stream (`_GET_stream`), the MCP SDK's send() would
 * evaporate silently. The dispatch path in src/persona-routing.ts therefore
 * does NOT call notification(): it applies the restart guards for P, schedules
 * a human-triggered restart of P in the session's cwd (recover case only) and
 * replies in the source channel through P's own client. When the stream is
 * present, notification() fires with `chat_id` = the source channel and
 * nothing else happens.
 *
 * These tests drive the real module (`createPersonaRouting(deps).receive`)
 * through the shared harness (tests/test-helpers/persona-routing-harness.ts)
 * with a persona registered in the real registry, the real restart.ts and
 * backoff.ts state, and one `makeStubSlack` client per persona. The receiving
 * persona (alpha) is the SECOND persona of the config, and each case also
 * checks that the first persona (beta) got no restart and no post. The
 * stream-presence probe is the module's exported `hasSessionStream`, the one
 * the restart guard and the health check also use. The no-session branch
 * (b.kvq) is covered by tests/inbound-recovery-drop-branch.test.ts.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSession } from '../src/registry.ts'
import { hasGetStreamKey } from '../src/lib.ts'
import {
  initRestart,
  scheduleRestart,
  isRestartPendingOrActive,
  RESTART_FAILURE_CAP,
} from '../src/restart.ts'
import { recordFailure } from '../src/backoff.ts'
import type { Persona } from '../src/config.ts'
import {
  hasSessionStream,
  LOST_MESSAGE_AUTO_RESTART_DISABLED_REPLY,
  LOST_MESSAGE_CAPPED_REPLY,
  LOST_MESSAGE_RESTARTING_REPLY,
} from '../src/persona-routing.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { makeChannelMessage } from './test-helpers/slack-stub.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import {
  makeRestartDeps,
  makeRoutingHarness,
  makeSessionServer,
  makeTransport,
  resetRoutingState,
  NEVER_FIRE_RESTART_DELAY_S,
  type RoutingHarness,
  type RoutingHarnessOptions,
} from './test-helpers/persona-routing-harness.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAST_DELAY_S = 0.01
const WAIT_MS = 50

/** Alpha's two channels; the message arrives in the second (non-first) one. */
const ALPHA_FIRST = 'C0ALPHA01'
const ALPHA_SECOND = 'C0ALPHA02'

// ---------------------------------------------------------------------------
// Harness: beta (first, no session) and alpha (second, the receiving persona,
// with one registered session whose stream is present or not)
// ---------------------------------------------------------------------------

let dir: string
let harnesses: RoutingHarness[] = []

type Alpha = { h: RoutingHarness; alpha: Persona; beta: Persona; sessionCwd: string }

function makeAlpha(opts: {
  hasGetStream: boolean
  sessionRestartDelay?: number
  restartDelayS?: number
  launchSession?: RoutingHarnessOptions['launchSession']
}): Alpha {
  const h = makeRoutingHarness(
    [
      { name: 'beta' },
      { name: 'alpha', channels: [{ id: ALPHA_FIRST, delivery: 'all' }, { id: ALPHA_SECOND, delivery: 'all' }] },
    ],
    dir,
    {
      sessions: ['alpha'],
      streamless: opts.hasGetStream ? [] : ['alpha'],
      overrides: { session_restart_delay: opts.sessionRestartDelay ?? 60 },
      restartDelayS: opts.restartDelayS ?? NEVER_FIRE_RESTART_DELAY_S,
      launchSession: opts.launchSession,
    },
  )
  harnesses.push(h)
  const [beta, alpha] = h.config!.personas as [Persona, Persona]
  return { h, alpha, beta, sessionCwd: h.p('alpha').sessionCwd! }
}

/** Deliver one message to alpha in its second channel; returns alpha's session's notifications. */
async function dispatchToAlpha(a: Alpha): Promise<RoutingHarness['all'][number]['notifications']> {
  await a.h.receive(makeChannelMessage({ channel: ALPHA_SECOND, text: 'hello' }), ['alpha'])
  return a.h.p('alpha').notifications
}

/** The first persona (beta) got no restart and no post. */
function expectBetaUntouched(a: Alpha): void {
  expect(isRestartPendingOrActive(a.beta.key)).toBe(false)
  expect(a.h.allPosts().filter((p) => p.key === a.beta.key)).toEqual([])
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-get-stream-'))
  harnesses = []
  resetRoutingState()
})

afterEach(() => {
  try {
    assertNoLeak(harnesses.map((h) => h.captured()))
  } finally {
    resetRoutingState()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatch-site _GET_stream branch (b.sjy + b.9cj)', () => {
  // -------------------------------------------------------------------------
  // Streamless, recover case: no notification, real scheduleRestart keyed to
  // the persona (not the source channel), launched in the session's cwd, and
  // RESTARTING reply to the source channel on the persona's client. Pre-fix
  // this branch called notification() (silently dropped by the SDK) and never
  // replied to the sender. The b.sjy instrumentation logs the dispatch line
  // and the DROP line naming the session.
  // -------------------------------------------------------------------------
  test('b.9cj streamless recover: no notification(); restart keyed to the persona in the session cwd; reply to the source channel', async () => {
    const a = makeAlpha({ hasGetStream: false, restartDelayS: FAST_DELAY_S })

    const notifications = await dispatchToAlpha(a)

    expect(notifications).toHaveLength(0)
    // Real scheduleRestart placed a pending timer under the persona key …
    expect(isRestartPendingOrActive(a.alpha.key)).toBe(true)
    // … and NOT under the source channel (mis-keying regression).
    expect(isRestartPendingOrActive(ALPHA_SECOND)).toBe(false)
    expect(a.h.allPosts()).toEqual([{ key: a.alpha.key, channel: ALPHA_SECOND, text: LOST_MESSAGE_RESTARTING_REPLY }])
    expectBetaUntouched(a)
    const ref = renderPersonaRef(a.alpha.name, a.alpha.key)
    const mcpSessionId = `mcp-${a.alpha.key}`
    expect(a.h.logs.filter((l) => l.startsWith(`[slack] Dispatching to persona ${ref} chat_id=${ALPHA_SECOND} cwd="${a.sessionCwd}" mcpSessionId=${mcpSessionId} hasGetStream=false connected=true`))).toHaveLength(1)
    expect(a.h.logs.filter((l) => l.startsWith(`[slack] DROP: no _GET_stream for persona ${ref} chat_id=${ALPHA_SECOND} cwd="${a.sessionCwd}" mcpSessionId=${mcpSessionId}`))).toHaveLength(1)

    // The launch relaunches the session where it ran, not the configured default.
    await Bun.sleep(WAIT_MS)
    expect(a.h.launches).toEqual([{ key: a.alpha.key, cwd: a.sessionCwd }])
  })

  // -------------------------------------------------------------------------
  // Streamless, already-restarting: a launch for the persona is in flight, so
  // no second launch is stacked; still replies "restarting". (The recover case
  // replies the same text, so the launch count is what tells them apart.)
  // -------------------------------------------------------------------------
  test('b.9cj streamless already-restarting: no new launch, RESTARTING reply', async () => {
    let launchResolve!: (ok: boolean) => void
    const held = new Promise<boolean>((res) => { launchResolve = res })
    const a = makeAlpha({ hasGetStream: false, restartDelayS: FAST_DELAY_S, launchSession: () => held })
    scheduleRestart(a.alpha.key, a.sessionCwd)
    await Bun.sleep(WAIT_MS) // timer fired; the launch is in flight
    expect(isRestartPendingOrActive(a.alpha.key)).toBe(true)

    const notifications = await dispatchToAlpha(a)
    await Bun.sleep(WAIT_MS) // a stacked timer would have fired by now

    expect(notifications).toHaveLength(0)
    expect(a.h.launches).toHaveLength(1)
    expect(a.h.allPosts()).toEqual([{ key: a.alpha.key, channel: ALPHA_SECOND, text: LOST_MESSAGE_RESTARTING_REPLY }])
    expectBetaUntouched(a)

    launchResolve(true)
    await Bun.sleep(1)
  })

  // -------------------------------------------------------------------------
  // Streamless, auto-restart disabled / capped: no scheduleRestart, the
  // branch's reply to the source channel on the persona's client.
  // -------------------------------------------------------------------------
  test.each([
    ['auto-restart-disabled (session_restart_delay 0)', 0, false, LOST_MESSAGE_AUTO_RESTART_DISABLED_REPLY],
    ['capped (persona at the restart-failure cap)', 60, true, LOST_MESSAGE_CAPPED_REPLY],
  ] as const)('b.9cj streamless %s: no notification(), no scheduleRestart, its reply', async (_label, delay, capped, expected) => {
    // restart.ts itself could launch (fast delay), so a wrongly scheduled
    // restart would show up as a launch.
    const a = makeAlpha({ hasGetStream: false, sessionRestartDelay: delay, restartDelayS: FAST_DELAY_S })
    if (capped) for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(a.alpha.key)

    const notifications = await dispatchToAlpha(a)

    expect(notifications).toHaveLength(0)
    expect(isRestartPendingOrActive(a.alpha.key)).toBe(false)
    expect(a.h.allPosts()).toEqual([{ key: a.alpha.key, channel: ALPHA_SECOND, text: expected }])
    expectBetaUntouched(a)
    await Bun.sleep(WAIT_MS)
    expect(a.h.launches).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Stream-PRESENT branch: notification() fires once to the source channel;
  // no reply and no restart.
  // -------------------------------------------------------------------------
  test('b.9cj stream-present: one notification() with chat_id = source channel, no reply and no restart', async () => {
    const a = makeAlpha({ hasGetStream: true })

    const notifications = await dispatchToAlpha(a)

    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.method).toBe('notifications/claude/channel')
    expect(notifications[0]!.params.meta.chat_id).toBe(ALPHA_SECOND)
    expect(a.h.allPosts()).toEqual([])
    expect(isRestartPendingOrActive(a.alpha.key)).toBe(false)
    expectBetaUntouched(a)
    const ref = renderPersonaRef(a.alpha.name, a.alpha.key)
    expect(a.h.logs.filter((l) => l.includes(`Dispatching to persona ${ref} chat_id=${ALPHA_SECOND}`) && l.includes('hasGetStream=true connected=true'))).toHaveLength(1)
    expect(a.h.logs.filter((l) => l.includes('DROP:'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// b.9cj — the connected-but-streamless state, constructed exactly as the SDK
// produces it, driving the routing module's real stream-presence probe over
// the real registry.
//
// Reproduction: register a session normally so connected === true, then
// delete the '_GET_stream' entry from the transport's _streamMapping WITHOUT
// closing the transport and WITHOUT a DELETE — connected stays true.
// ---------------------------------------------------------------------------

describe('b.9cj hasSessionStream over the real registry', () => {
  test('a freshly registered session with its GET stream reports true', () => {
    registerSession(join(dir, 'stream-session'), 'p_stream', makeTransport('mcp-p_stream'), makeSessionServer([]))
    expect(hasSessionStream('p_stream')).toBe(true)
  })

  test('connected stays true but the probe reports streamless after the SDK drops _GET_stream', () => {
    const transport = makeTransport('mcp-p_streamless')
    const entry = registerSession(join(dir, 'streamless-session'), 'p_streamless', transport, makeSessionServer([]))
    expect(hasSessionStream('p_streamless')).toBe(true)

    ;(transport as unknown as { _streamMapping: Map<string, unknown> })._streamMapping.delete('_GET_stream')

    expect(entry.connected).toBe(true)                  // unchanged — still "connected"
    expect(hasSessionStream('p_streamless')).toBe(false) // but no longer deliverable
  })

  test('returns false when there is no session at all', () => {
    expect(hasSessionStream('p_no_session')).toBe(false)
  })

  // The restart guard is wired with this probe (src/server.ts): a session that
  // is alive and connected but streamless is not "already reconnected".
  test.each([
    [true, 0],
    [false, 1],
  ])('restart.ts with the real probe: stream present=%p → reconnectSession called %p time(s)', async (stream, reconnects) => {
    registerSession(join(dir, 'restart-probe'), 'p_restart', makeTransport('mcp-p_restart', !stream), makeSessionServer([]))
    let reconnectCalls = 0
    initRestart({
      ...makeRestartDeps({ restartDelayS: FAST_DELAY_S }),
      async isSessionAlive() { return true },
      isSessionConnected() { return true },
      hasSessionStream,
      async reconnectSession() { reconnectCalls++; return 'success' },
    })

    scheduleRestart('p_restart', join(dir, 'restart-probe'))
    await Bun.sleep(WAIT_MS)

    expect(reconnectCalls).toBe(reconnects)
  })
})

// ---------------------------------------------------------------------------
// Direct unit tests for hasGetStreamKey (lib.ts)
// ---------------------------------------------------------------------------

describe('hasGetStreamKey', () => {
  // Case 1 — _streamMapping contains '_GET_stream' → true
  test('returns true when transport._streamMapping has _GET_stream key', () => {
    const mapping = new Map<string, unknown>()
    mapping.set('_GET_stream', { controller: {}, encoder: new TextEncoder() })
    const transport = { _streamMapping: mapping }
    expect(hasGetStreamKey(transport)).toBe(true)
  })

  // Case 2 — _streamMapping exists but '_GET_stream' is absent → false
  test('returns false when transport._streamMapping exists but lacks _GET_stream key', () => {
    const mapping = new Map<string, unknown>()
    mapping.set('_other_stream', {})
    const transport = { _streamMapping: mapping }
    expect(hasGetStreamKey(transport)).toBe(false)
  })

  // Case 3 — transport has no _streamMapping property → false
  test('returns false when transport has no _streamMapping', () => {
    const transport = { sessionId: 'abc', handleRequest: () => {} }
    expect(hasGetStreamKey(transport)).toBe(false)
  })

  // Case 4 — transport is null / undefined → false
  test('returns false when transport is null', () => {
    expect(hasGetStreamKey(null)).toBe(false)
  })

  test('returns false when transport is undefined', () => {
    expect(hasGetStreamKey(undefined)).toBe(false)
  })

  // Case 5 — _streamMapping is present but .has is not callable (defensive) → false
  test('returns false when _streamMapping.has is not a function', () => {
    const transport = { _streamMapping: { has: 'not-a-function' } }
    expect(hasGetStreamKey(transport)).toBe(false)
  })
})
