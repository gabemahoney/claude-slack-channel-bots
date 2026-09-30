/**
 * dispatch-get-stream.test.ts — the b.sjy instrumentation and the b.9cj
 * streamless-dispatch branch, per persona.
 *
 * When the receiving persona P has a connected session whose transport has
 * lost its standalone GET stream (`_GET_stream`), the MCP SDK's send() would
 * evaporate silently. The dispatch path in src/persona-routing.ts therefore
 * does NOT call notification() and adds no ack reaction. It decides the
 * recovery state from whether P is up (not up, bug b.g57) and P's restart
 * guards (restarting, starting now, auto-restart disabled, restart limit
 * reached), schedules a human-triggered
 * restart of P in the session's cwd only when starting now, and raises one
 * lost-message notice naming the sender and the state at P's
 * permission-prompt destination, through P's own client (b.av2 SR-4.6,
 * SR-7.3). Nothing is posted in the conversation the message came from, and
 * the notice carries no message text. When the stream is present,
 * notification() fires with `chat_id` = the source channel and nothing else
 * happens.
 *
 * These tests drive the real module (`createPersonaRouting(deps).receive`)
 * through the shared harness (tests/test-helpers/persona-routing-harness.ts)
 * with a persona registered in the real registry, the real restart.ts and
 * backoff.ts state, the real persona notifier and destination hold (on the
 * harness's fake clock), and one `makeStubSlack` client per persona. The
 * receiving persona (alpha) is the SECOND persona of the config, and each
 * case also checks that the first persona (beta) got no restart and no post.
 * Alpha's destination is either its first channel (the message arrives in its
 * second) or a DM with its contact. The notice is compared with the real
 * builder's output for the expected state, never with a copied string. The
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
import { LIVENESS_READING_LIVE } from '../src/liveness-reading.ts'
import { recordFailure } from '../src/backoff.ts'
import { consumeAck } from '../src/ack-tracker.ts'
import type { Persona } from '../src/config.ts'
import { hasSessionStream } from '../src/persona-routing.ts'
import { buildLostMessageNotice, type LostMessageState } from '../src/lost-message.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { createPersonaUpPredicate } from '../src/persona-start.ts'
import type { PersonaConnectionStatus } from '../src/persona-connections.ts'
import {
  makeAppMention,
  makeChannelMessage,
  makeDeferredWebApiCall,
  mentionText,
  stubOpenedDmId,
} from './test-helpers/slack-stub.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import type { PersonaSpec } from './test-helpers/persona-config.ts'
import {
  makeRestartDeps,
  makeRoutingHarness,
  makeSessionServer,
  makeTransport,
  resetRoutingState,
  stateOf,
  waitFor,
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

/** Alpha's DM contact, for the `dm` destination rows. */
const ALPHA_CONTACT = 'U0ALPHACN1'

/** The message's author, and the name the stub's `users.info` gives every user. */
const SENDER_ID = 'U0SENDER01'
const SENDER_NAME = 'stub-user'

/** The dispatched message's text: it must never reach a notice. */
const MESSAGE_TEXT = 'lost-body-marker-9cj'

/**
 * Ack reaction configured for every case, so a reaction on a lost message, or
 * its ack-tracker entry, would show.
 */
const ACK_REACTION = 'eyes'

// ---------------------------------------------------------------------------
// Harness: beta (first, no session) and alpha (second, the receiving persona,
// with one registered session whose stream is present or not)
// ---------------------------------------------------------------------------

let dir: string
let harnesses: RoutingHarness[] = []

/** Where alpha's permission prompts (and lost-message notices) go. */
type Destination = 'channel' | 'dm'

type Alpha = { h: RoutingHarness; alpha: Persona; beta: Persona; sessionCwd: string; destination: string }

function makeAlpha(opts: {
  hasGetStream: boolean
  destination?: Destination
  sessionRestartDelay?: number
  restartDelayS?: number
  launchSession?: RoutingHarnessOptions['launchSession']
  isPersonaUp?: RoutingHarnessOptions['isPersonaUp']
}): Alpha {
  const alphaSpec: PersonaSpec = {
    name: 'alpha',
    channels: [{ id: ALPHA_FIRST, delivery: 'all' }, { id: ALPHA_SECOND, delivery: 'all' }],
    ...(opts.destination === 'dm' ? { dm: { enabled: true, contact: ALPHA_CONTACT }, permission_prompts: 'dm' } : {}),
  }
  const h = makeRoutingHarness(
    [{ name: 'beta' }, alphaSpec],
    dir,
    {
      sessions: ['alpha'],
      streamless: opts.hasGetStream ? [] : ['alpha'],
      overrides: { session_restart_delay: opts.sessionRestartDelay ?? 60 },
      restartDelayS: opts.restartDelayS ?? NEVER_FIRE_RESTART_DELAY_S,
      launchSession: opts.launchSession,
      ackReaction: ACK_REACTION,
      isPersonaUp: opts.isPersonaUp,
    },
  )
  harnesses.push(h)
  const [beta, alpha] = h.config!.personas as [Persona, Persona]
  // Alpha's default destination is its first channel, not the source channel.
  const destination = opts.destination === 'dm' ? stubOpenedDmId(ALPHA_CONTACT) : ALPHA_FIRST
  return { h, alpha, beta, sessionCwd: h.p('alpha').sessionCwd!, destination }
}

/** A human's message to alpha in its second channel. */
function alphaMessage(): ReturnType<typeof makeChannelMessage> {
  return makeChannelMessage({ channel: ALPHA_SECOND, user: SENDER_ID, text: MESSAGE_TEXT })
}

/** Deliver `event` (default: a new `alphaMessage()`) to alpha; returns alpha's session's notifications. */
async function dispatchToAlpha(a: Alpha, event = alphaMessage()): Promise<RoutingHarness['all'][number]['notifications']> {
  await a.h.receive(event, ['alpha'])
  return a.h.p('alpha').notifications
}

/** The first persona (beta) got no restart and no post. */
function expectBetaUntouched(a: Alpha): void {
  expect(isRestartPendingOrActive(a.beta.key)).toBe(false)
  expect(a.h.allPosts().filter((p) => p.key === a.beta.key)).toEqual([])
}

/**
 * Exactly one Slack post happened: alpha's lost-message notice for `state`,
 * naming the sender, through alpha's client at its destination, with no
 * message text, nothing in the source channel and no ack reaction anywhere.
 */
function expectOneLostNotice(a: Alpha, state: LostMessageState): void {
  const body = buildLostMessageNotice(SENDER_NAME, state)
  expect(a.h.notices).toEqual([{ key: a.alpha.key, text: body }])
  expect(a.h.allPosts()).toEqual([{ key: a.alpha.key, channel: a.destination, text: a.h.noticeText('alpha', body) }])
  expect(a.h.postsTo(ALPHA_SECOND)).toEqual([])

  const posted = a.h.allPosts()[0]!.text!
  expect(posted).toContain(SENDER_NAME)
  expect(stateOf(posted)).toBe(state)
  expect(posted).not.toContain(MESSAGE_TEXT)
  // The sender's name was looked up through alpha's own client.
  expect(a.h.p('alpha').stub.calls.usersInfo.map((c) => c?.user)).toEqual([SENDER_ID])
  for (const x of a.h.all) expect(x.stub.calls.reactionsAdd).toEqual([])
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatch-get-stream-'))
  harnesses = []
  resetRoutingState()
})

afterEach(() => {
  try {
    assertNoLeak(harnesses.map((h) => h.captured()))
    // Every notice here reaches its destination, so the hold keeps no timer.
    for (const h of harnesses) expect(h.holdClock.pendingCount()).toBe(0)
  } finally {
    for (const h of harnesses) h.hold.cancelAll()
    resetRoutingState()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Streamless-state arrangement
// ---------------------------------------------------------------------------

/** Alpha set up so the next streamless message finds P's restart guards in `state`. */
interface Arranged {
  a: Alpha
  /** Lets a held launch finish. */
  release(): void
}

async function arrangeState(state: LostMessageState, destination: Destination): Promise<Arranged> {
  // restart.ts itself could launch (fast delay), so a wrongly scheduled
  // restart would show up as a launch.
  const base = { hasGetStream: false, destination, restartDelayS: FAST_DELAY_S }
  switch (state) {
    case 'restarting': {
      // A launch for alpha is in flight and held open.
      let launchResolve!: (ok: boolean) => void
      const held = new Promise<boolean>((res) => { launchResolve = res })
      const a = makeAlpha({ ...base, launchSession: () => held })
      scheduleRestart(a.alpha.key, a.sessionCwd)
      await waitFor(() => a.h.launches.length === 1)
      expect(a.h.launches).toHaveLength(1)
      expect(isRestartPendingOrActive(a.alpha.key)).toBe(true)
      return { a, release: () => launchResolve(true) }
    }
    case 'not-up': {
      // Bug b.g57: alpha held (its bring-up retrying, as for an unresolvable
      // claude_config_dir) while its Slack connection still serves, through
      // the real up predicate.
      const notUp = new Set<string>()
      const serving: PersonaConnectionStatus = { state: 'up', identity: { botUserId: 'U0SERVING', botId: 'B0SERVING' } }
      const isPersonaUp = createPersonaUpPredicate({ status: () => serving }, { isUp: (key) => !notUp.has(key) })
      const a = makeAlpha({ ...base, isPersonaUp })
      notUp.add(a.alpha.key)
      return { a, release: () => {} }
    }
    case 'starting-now':
      return { a: makeAlpha(base), release: () => {} }
    case 'auto-restart-disabled':
      return { a: makeAlpha({ ...base, sessionRestartDelay: 0 }), release: () => {} }
    case 'restart-limit-reached': {
      const a = makeAlpha(base)
      for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(a.alpha.key)
      return { a, release: () => {} }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatch-site _GET_stream branch (b.sjy + b.9cj)', () => {
  // -------------------------------------------------------------------------
  // Streamless, each recovery state × each destination kind: no
  // notification(), no ack reaction, a launch only when starting now (keyed to
  // the persona, not the source channel, in the session's cwd), and one
  // lost-message notice at alpha's destination through alpha's client, with
  // nothing in the source channel. The b.sjy instrumentation logs the
  // dispatch line and the DROP line naming the session.
  // -------------------------------------------------------------------------
  const STATES: readonly [LostMessageState, boolean, number][] = [
    // state, restart pending or active after the message, launches after it
    ['not-up', false, 0], // b.g57: nothing scheduled for a persona that is not up
    ['restarting', true, 1], // the in-flight launch only; none stacked
    ['starting-now', true, 1],
    ['auto-restart-disabled', false, 0],
    ['restart-limit-reached', false, 0],
  ]
  const DESTINATIONS: readonly Destination[] = ['channel', 'dm']
  const ROWS = DESTINATIONS.flatMap((d) => STATES.map(([s, pending, launches]) => [s, d, pending, launches] as const))

  test.each(ROWS)('b.9cj streamless %s, %s destination: no notification(), its recovery, one destination notice, nothing in the source channel', async (state, destination, pending, launches) => {
    const { a, release } = await arrangeState(state, destination)
    const event = alphaMessage()

    const notifications = await dispatchToAlpha(a, event)

    expect(notifications).toHaveLength(0)
    // No ack reaction and no ack-tracker entry for a lost message, under
    // alpha's key (the reaction itself is checked in expectOneLostNotice).
    expect(consumeAck(a.alpha.key, ALPHA_SECOND, event.ts as string)).toBe(false)
    expect(isRestartPendingOrActive(a.alpha.key)).toBe(pending)
    // Never keyed by the source channel (mis-keying regression).
    expect(isRestartPendingOrActive(ALPHA_SECOND)).toBe(false)
    expectOneLostNotice(a, state)
    expectBetaUntouched(a)
    const ref = renderPersonaRef(a.alpha.name, a.alpha.key)
    const mcpSessionId = `mcp-${a.alpha.key}`
    expect(a.h.logs.filter((l) => l.startsWith(`[slack] Dispatching to persona ${ref} chat_id=${ALPHA_SECOND} cwd="${a.sessionCwd}" mcpSessionId=${mcpSessionId} hasGetStream=false connected=true`))).toHaveLength(1)
    expect(a.h.logs.filter((l) => l.startsWith(`[slack] DROP: no _GET_stream for persona ${ref} chat_id=${ALPHA_SECOND} cwd="${a.sessionCwd}" mcpSessionId=${mcpSessionId}`))).toHaveLength(1)

    // A stacked or wrongly scheduled timer would have fired by now. A launch
    // relaunches the session where it ran, not the configured default.
    await Bun.sleep(WAIT_MS)
    expect(a.h.launches).toHaveLength(launches)
    if (launches > 0) expect(a.h.launches).toEqual([{ key: a.alpha.key, cwd: a.sessionCwd }])

    release()
    await Bun.sleep(1)
  })

  // -------------------------------------------------------------------------
  // Restarting and starting now are reported differently. The first message
  // starts a restart (starting now) whose launch is held open; the second
  // finds it under way (restarting). Two notices, same sender, different text.
  // -------------------------------------------------------------------------
  test('b.9cj streamless: "starting now" and "restarting" give different notices', async () => {
    let launchResolve!: (ok: boolean) => void
    const held = new Promise<boolean>((res) => { launchResolve = res })
    const a = makeAlpha({ hasGetStream: false, restartDelayS: FAST_DELAY_S, launchSession: () => held })

    await dispatchToAlpha(a)
    await a.h.receive(makeChannelMessage({ channel: ALPHA_SECOND, user: SENDER_ID, text: MESSAGE_TEXT }), ['alpha'])

    const posts = a.h.allPosts()
    expect(posts.map((p) => p.channel)).toEqual([ALPHA_FIRST, ALPHA_FIRST])
    const [first, second] = posts.map((p) => p.text!) as [string, string]
    expect(stateOf(first)).toBe('starting-now')
    expect(stateOf(second)).toBe('restarting')
    expect(first).not.toBe(second)
    for (const text of [first, second]) expect(text).toContain(SENDER_NAME)
    await waitFor(() => a.h.launches.length > 0)
    expect(a.h.launches).toHaveLength(1)

    launchResolve(true)
    await Bun.sleep(1)
  })

  // -------------------------------------------------------------------------
  // The notice is awaited: dispatch returns only once the destination post
  // has been answered, so a caller (and every case above) can assert on the
  // notice right after the receive.
  // -------------------------------------------------------------------------
  test('b.9cj streamless: the receive settles only after the notice post is answered', async () => {
    const a = makeAlpha({ hasGetStream: false })
    const post = makeDeferredWebApiCall()
    a.h.p('alpha').stub.script.post.push(post.outcome)

    let returned = false
    const receiving = dispatchToAlpha(a).then(() => { returned = true })
    await waitFor(() => a.h.allPosts().length === 1)
    await Bun.sleep(5)

    expect(a.h.allPosts().map((p) => p.channel)).toEqual([ALPHA_FIRST])
    expect(returned).toBe(false)

    post.settle()
    await receiving
    expect(returned).toBe(true)
    expectOneLostNotice(a, 'starting-now')
  })

  // -------------------------------------------------------------------------
  // Streamless, duplicated mention (b.av2 SR-4.1): a mention reaches the
  // persona as a `message` and an `app_mention` with the same (channel, ts),
  // and Slack may redeliver either. The persona's dedupe store sits before
  // dispatch, so the pair gives one notice, one recovery and no notification,
  // and a redelivery after the launch adds nothing.
  // -------------------------------------------------------------------------
  test('b.9cj streamless duplicated mention: a `message` / `app_mention` pair gives one notice, one recovery, no notification', async () => {
    const a = makeAlpha({ hasGetStream: false, restartDelayS: FAST_DELAY_S })
    const text = `${mentionText(a.h.p('alpha').stub.identity.botUserId)} ${MESSAGE_TEXT}`
    const message = makeChannelMessage({ channel: ALPHA_SECOND, user: SENDER_ID, text })
    const mention = makeAppMention({ channel: ALPHA_SECOND, user: SENDER_ID, text, ts: message.ts })
    expect(mention.ts).toBe(message.ts)

    await a.h.receive(message, ['alpha'])
    await a.h.receive(mention, ['alpha'])

    expect(a.h.p('alpha').notifications).toHaveLength(0)
    // Without dedupe the app_mention would reach the branch again and raise a
    // second notice.
    expectOneLostNotice(a, 'starting-now')
    expect(consumeAck(a.alpha.key, ALPHA_SECOND, message.ts as string)).toBe(false)
    expect(isRestartPendingOrActive(a.alpha.key)).toBe(true)
    expectBetaUntouched(a)
    const ref = renderPersonaRef(a.alpha.name, a.alpha.key)
    expect(a.h.logs.filter((l) => l.startsWith(`[slack] DROP: no _GET_stream for persona ${ref} chat_id=${ALPHA_SECOND}`))).toHaveLength(1)
    await Bun.sleep(WAIT_MS)
    expect(a.h.launches).toEqual([{ key: a.alpha.key, cwd: a.sessionCwd }])
    // The launch has finished, so no restart guard would stop a second recovery.
    expect(isRestartPendingOrActive(a.alpha.key)).toBe(false)

    // Slack redelivers both events: a duplicate does nothing and logs nothing.
    const logsBefore = [...a.h.logs]
    await a.h.receive(message, ['alpha'])
    await a.h.receive(mention, ['alpha'])

    expect(isRestartPendingOrActive(a.alpha.key)).toBe(false)
    expect(a.h.allPosts()).toHaveLength(1)
    expect(a.h.notices).toHaveLength(1)
    expect(a.h.p('alpha').notifications).toHaveLength(0)
    expect(a.h.logs).toEqual(logsBefore)
  })

  // -------------------------------------------------------------------------
  // Stream-PRESENT branch: notification() fires once to the source channel
  // with the ack reaction on the message; no notice, no post and no restart.
  // -------------------------------------------------------------------------
  test('b.9cj stream-present: one notification() with chat_id = source channel, no notice, no post and no restart', async () => {
    const a = makeAlpha({ hasGetStream: true })
    const event = alphaMessage()

    const notifications = await dispatchToAlpha(a, event)

    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.method).toBe('notifications/claude/channel')
    expect(notifications[0]!.params.meta.chat_id).toBe(ALPHA_SECOND)
    expect(a.h.notices).toEqual([])
    expect(a.h.allPosts()).toEqual([])
    expect(isRestartPendingOrActive(a.alpha.key)).toBe(false)
    expectBetaUntouched(a)
    // Only a dispatched message gets the ack reaction.
    expect(a.h.p('alpha').stub.calls.reactionsAdd.map((c) => [c?.channel, c?.name])).toEqual([[ALPHA_SECOND, ACK_REACTION]])
    // … and is tracked under alpha's own key, so alpha's reply can remove it:
    // beta, which never reacted, finds no entry, and alpha's consumes once.
    expect(consumeAck(a.beta.key, ALPHA_SECOND, event.ts as string)).toBe(false)
    expect(consumeAck(a.alpha.key, ALPHA_SECOND, event.ts as string)).toBe(true)
    expect(consumeAck(a.alpha.key, ALPHA_SECOND, event.ts as string)).toBe(false)
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
      async isSessionAlive() { return LIVENESS_READING_LIVE },
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
