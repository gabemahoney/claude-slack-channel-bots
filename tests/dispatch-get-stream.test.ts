/**
 * dispatch-get-stream.test.ts — Tests for the b.sjy instrumentation patch and
 * the b.9cj streamless-deliver rewrite of handleMessage.
 *
 * Verifies the dispatch-site logic in handleMessage (server.ts:780-836):
 *   - When _GET_stream is absent from transport._streamMapping, the branch does
 *     NOT call notification() (the SDK's send() would evaporate silently).
 *     Instead it selects a three-state reply and, only in the recover case,
 *     calls scheduleRestart keyed to the session's OWNING channel with
 *     { humanTrigger: true }, then replies to the INBOUND channel and returns.
 *   - When _GET_stream IS present, notification() fires and nothing else.
 *
 * handleMessage cannot be imported directly (server.ts has module-scope side
 * effects: Slack client init, token load, etc.). We follow the same pattern as
 * dm-routing.test.ts — replicate only the relevant sub-logic in a
 * simulateDispatch helper and test it in isolation.
 *
 * REPLICATION GAP (honestly stated): simulateDispatch re-implements the
 * server.ts branch; it cannot catch the *call* to hasGetStreamKey being deleted
 * from server.ts, nor the reply strings drifting in server.ts. To narrow the
 * string gap, the reply constants below are asserted against by name; if a
 * source string changes, update the constant here in the same change. The
 * scheduleRestart / isRestartPendingOrActive / isAtCap composition is the REAL
 * restart.ts + backoff.ts machinery (not stubbed), so the three-state guard
 * (already-restarting / auto-restart-disabled / capped / recover) is genuinely
 * exercised.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { _resetRegistry, registerSession, getSessionByChannel } from '../src/registry.ts'
import { hasGetStreamKey } from '../src/lib.ts'
import {
  initRestart,
  scheduleRestart,
  isRestartPendingOrActive,
  cancelAllRestartTimers,
  _resetRestartState,
  RESTART_FAILURE_CAP,
  type RestartDeps,
} from '../src/restart.ts'
import { isAtCap, recordFailure, _resetBackoffState } from '../src/backoff.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Large enough that the timer never fires during any test. */
const NEVER_FIRE_DELAY_S = 9999

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Minimal transport stub. _streamMapping controls _GET_stream presence. */
function makeTransport(hasGetStream: boolean): any {
  const streamMapping = new Map<string, unknown>()
  if (hasGetStream) {
    streamMapping.set('_GET_stream', { controller: { enqueue: () => {} }, encoder: new TextEncoder() })
  }
  return {
    _streamMapping: streamMapping,
    sessionId: 'test-mcp-session-id',
    handleRequest: () => {},
    close: async () => {},
  }
}

/** Minimal MCP server stub. */
function makeServer(): { server: any; notifications: any[] } {
  const notifications: any[] = []
  return {
    server: {
      connect: async () => {},
      notification: (msg: any) => { notifications.push(msg) },
    },
    notifications,
  }
}

/**
 * Stub RestartDeps with a large delay (timer never fires) so we can use
 * isRestartPendingOrActive() as a synchronous proxy for "was scheduleRestart called".
 */
function makeRestartDeps(): RestartDeps {
  return {
    async isSessionAlive() { return false },
    isSessionConnected() { return false },
    hasSessionStream() { return true },
    async reconnectSession() {},
    async killSession() {},
    async launchSession() { return true },
    getRestartDelay: () => NEVER_FIRE_DELAY_S,
    isShuttingDown: () => false,
    onCapReached: (_channelId) => { /* no-op stub */ },
  }
}

// ---------------------------------------------------------------------------
// Reply-string constants — kept in lock-step with src/server.ts:807-829.
// These mirror the source three-state reply text. Asserting toBe(<CONSTANT>)
// is only as honest as this replication; if a source string changes it must be
// changed here too (see REPLICATION GAP in the file header).
// ---------------------------------------------------------------------------

/** server.ts alreadyRestarting AND recover branches share this string. */
const RESTARTING_REPLY =
  'Your message was not delivered. The session is restarting — please retry in a moment.'

/** server.ts autoRestartDisabled branch. */
const AUTO_DISABLED_REPLY =
  'Your message was not delivered and was not saved. Auto-restart is disabled for this channel, ' +
  'so it will NOT recover on its own — an operator must restart the server.'

/** server.ts capped branch. */
const CAPPED_REPLY =
  'Your message was not delivered and was not saved. This channel has hit its restart-failure limit ' +
  'and will NOT recover on its own — an operator must restart the server.'

type ReplyVariant = 'restarting' | 'auto-disabled' | 'capped'

/**
 * Simulate the streamless dispatch branch in handleMessage (server.ts:780-836).
 *
 * Mirrors the b.9cj rewrite faithfully, keeping the two channel identities the
 * source distinguishes:
 *   - ownerChannelId = targetSession.channelId — everything recovery-keyed
 *     (isRestartPendingOrActive, backoffIsAtCap, scheduleRestart) uses THIS.
 *   - inboundChannelId — the channel the message arrived on; the reply posts
 *     HERE. When a session is resolved via default_route/DM these differ, and
 *     mis-keying recovery to the inbound channel is the bug this guards.
 *
 * Three-state reply (server.ts order): alreadyRestarting → RESTARTING_REPLY (no
 * new launch); autoRestartDisabled (session_restart_delay === 0) →
 * AUTO_DISABLED_REPLY; capped → CAPPED_REPLY; else → scheduleRestart(owner, cwd,
 * undefined, { humanTrigger: true }) then RESTARTING_REPLY. scheduleRestart is
 * called ONLY in the else branch. notification() is NEVER called on this branch.
 *
 * Uses the REAL isRestartPendingOrActive / isAtCap / scheduleRestart, so the
 * guard is genuinely exercised over restart.ts + backoff.ts state.
 */
function simulateStreamlessDispatch(
  ownerChannelId: string,
  inboundChannelId: string,
  cwd: string,
  transport: any,
  server: any,
  sessionRestartDelay: number,
  postMessage: (channelId: string, text: string) => void,
): { notificationCalled: boolean; variant: ReplyVariant; scheduled: boolean } {
  // This helper only models the streamless branch; caller guarantees no stream.
  if (hasGetStreamKey(transport)) {
    throw new Error('simulateStreamlessDispatch called with a stream-present transport')
  }

  const alreadyRestarting = isRestartPendingOrActive(ownerChannelId)
  const autoRestartDisabled = (sessionRestartDelay ?? 60) === 0
  const capped = isAtCap(ownerChannelId, RESTART_FAILURE_CAP)

  let variant: ReplyVariant
  let scheduled = false
  let replyText: string
  if (alreadyRestarting) {
    variant = 'restarting'
    replyText = RESTARTING_REPLY
  } else if (autoRestartDisabled) {
    variant = 'auto-disabled'
    replyText = AUTO_DISABLED_REPLY
  } else if (capped) {
    variant = 'capped'
    replyText = CAPPED_REPLY
  } else {
    scheduleRestart(ownerChannelId, cwd, undefined, { humanTrigger: true })
    scheduled = true
    variant = 'restarting'
    replyText = RESTARTING_REPLY
  }

  // Reply posts to the INBOUND channel, not the owner.
  postMessage(inboundChannelId, replyText)
  return { notificationCalled: false, variant, scheduled }
}

/** Stream-PRESENT branch: notification() fires, nothing else. */
function simulateStreamDispatch(
  channelId: string,
  transport: any,
  server: any,
): { notificationCalled: boolean } {
  if (!hasGetStreamKey(transport)) {
    throw new Error('simulateStreamDispatch called with a streamless transport')
  }
  server.notification({
    method: 'notifications/claude/channel',
    params: { content: 'hello', meta: { chat_id: channelId } },
  })
  return { notificationCalled: true }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRegistry()
  _resetRestartState()
  _resetBackoffState()
  initRestart(makeRestartDeps())
})

afterEach(() => {
  cancelAllRestartTimers()
  _resetRestartState()
  _resetBackoffState()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatch-site _GET_stream branch (b.sjy + b.9cj)', () => {
  // Distinct owner vs inbound channels so mis-keying recovery to the inbound
  // channel (the bug the owner-keying guards) is caught: the session is owned
  // by OWNER but the message arrives on INBOUND (e.g. via default_route / DM).
  const OWNER = 'C_OWNER'
  const INBOUND = 'C_INBOUND'
  const CWD = '/tmp/streamless-session'

  // -------------------------------------------------------------------------
  // Streamless, recover case: no notification, real scheduleRestart keyed to
  // the OWNER channel (not inbound), reply RESTARTING_REPLY to the INBOUND
  // channel. Pre-fix this branch called notification() (silently dropped by the
  // SDK) and never replied to the sender.
  // -------------------------------------------------------------------------
  test('b.9cj streamless recover: no notification(); real scheduleRestart keyed to OWNER; reply to INBOUND', () => {
    const transport = makeTransport(false) // _GET_stream absent
    const { server, notifications } = makeServer()
    const replies: Array<{ channelId: string; text: string }> = []

    const result = simulateStreamlessDispatch(
      OWNER, INBOUND, CWD, transport, server, 60,
      (ch, text) => { replies.push({ channelId: ch, text }) },
    )

    // notification() is NOT called on the streamless branch.
    expect(result.notificationCalled).toBe(false)
    expect(notifications).toHaveLength(0)

    // Real scheduleRestart placed a pending timer under the OWNER channel …
    expect(result.scheduled).toBe(true)
    expect(isRestartPendingOrActive(OWNER)).toBe(true)
    // … and NOT under the inbound channel (mis-keying regression).
    expect(isRestartPendingOrActive(INBOUND)).toBe(false)

    // Reply posted to the INBOUND channel with the honest "restarting" text.
    expect(result.variant).toBe('restarting')
    expect(replies).toEqual([{ channelId: INBOUND, text: RESTARTING_REPLY }])
  })

  // -------------------------------------------------------------------------
  // Streamless, already-restarting: a restart is pending on the OWNER channel,
  // so no second launch is stacked; still replies "restarting" to INBOUND.
  // -------------------------------------------------------------------------
  test('b.9cj streamless already-restarting: no new launch, RESTARTING reply', () => {
    const transport = makeTransport(false)
    const { server } = makeServer()
    const replies: Array<{ channelId: string; text: string }> = []

    // Prime a pending restart on the OWNER channel.
    scheduleRestart(OWNER, CWD)
    expect(isRestartPendingOrActive(OWNER)).toBe(true)

    const result = simulateStreamlessDispatch(
      OWNER, INBOUND, CWD, transport, server, 60,
      (ch, text) => { replies.push({ channelId: ch, text }) },
    )

    // No second scheduleRestart fired from the branch.
    expect(result.scheduled).toBe(false)
    expect(result.variant).toBe('restarting')
    expect(replies).toEqual([{ channelId: INBOUND, text: RESTARTING_REPLY }])
  })

  // -------------------------------------------------------------------------
  // Streamless, auto-restart disabled (session_restart_delay === 0): no
  // scheduleRestart, AUTO_DISABLED reply to INBOUND.
  // -------------------------------------------------------------------------
  test('b.9cj streamless auto-restart-disabled: no scheduleRestart, AUTO_DISABLED reply', () => {
    const transport = makeTransport(false)
    const { server } = makeServer()
    const replies: Array<{ channelId: string; text: string }> = []

    const result = simulateStreamlessDispatch(
      OWNER, INBOUND, CWD, transport, server, 0, // delay 0 → disabled
      (ch, text) => { replies.push({ channelId: ch, text }) },
    )

    expect(result.scheduled).toBe(false)
    expect(isRestartPendingOrActive(OWNER)).toBe(false)
    expect(result.variant).toBe('auto-disabled')
    expect(replies).toEqual([{ channelId: INBOUND, text: AUTO_DISABLED_REPLY }])
  })

  // -------------------------------------------------------------------------
  // Streamless, at the restart-failure cap: no scheduleRestart, CAPPED reply.
  // Drives the real backoff state to the cap via recordFailure.
  // -------------------------------------------------------------------------
  test('b.9cj streamless capped: no scheduleRestart, CAPPED reply', () => {
    const transport = makeTransport(false)
    const { server } = makeServer()
    const replies: Array<{ channelId: string; text: string }> = []

    // Push the OWNER channel to the failure cap in real backoff state.
    for (let i = 0; i < RESTART_FAILURE_CAP; i++) recordFailure(OWNER)
    expect(isAtCap(OWNER, RESTART_FAILURE_CAP)).toBe(true)

    const result = simulateStreamlessDispatch(
      OWNER, INBOUND, CWD, transport, server, 60,
      (ch, text) => { replies.push({ channelId: ch, text }) },
    )

    expect(result.scheduled).toBe(false)
    expect(result.variant).toBe('capped')
    expect(replies).toEqual([{ channelId: INBOUND, text: CAPPED_REPLY }])
  })

  // -------------------------------------------------------------------------
  // Stream-PRESENT branch: notification() fires; no reply, no restart.
  // -------------------------------------------------------------------------
  test('b.9cj stream-present: notification() fires, no reply and no restart', () => {
    const transport = makeTransport(true) // _GET_stream present
    const { server, notifications } = makeServer()

    const result = simulateStreamDispatch(OWNER, transport, server)

    expect(result.notificationCalled).toBe(true)
    expect(notifications).toHaveLength(1)
    // Nothing recovery-side happened.
    expect(isRestartPendingOrActive(OWNER)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// b.9cj — the connected-but-streamless state, constructed exactly as the SDK
// produces it, driving the REAL hasSessionStreamAdapter composition.
//
// Reproduction (ticket step 1-2): register a session normally so
// connected === true, then delete the '_GET_stream' entry from the transport's
// _streamMapping WITHOUT closing the transport and WITHOUT a DELETE — connected
// stays true. hasSessionStreamAdapter (getSessionByChannel → hasGetStreamKey,
// false when no session) is the src/server.ts probe wired into both dep
// objects; this replicates its two lines over the real registry so the seam is
// exercised end-to-end, not stubbed.
// ---------------------------------------------------------------------------

describe('b.9cj hasSessionStreamAdapter over the real registry', () => {
  // The exact two-line adapter from src/server.ts main().
  const hasSessionStreamAdapter = (channelId: string): boolean => {
    const session = getSessionByChannel(channelId)
    return session ? hasGetStreamKey(session.transport) : false
  }

  test('connected stays true but the adapter reports streamless after the SDK drops _GET_stream', () => {
    const channelId = 'C_STREAMLESS'
    const transport = makeTransport(true) // registered WITH a _GET_stream entry
    const { server } = makeServer()

    const entry = registerSession('/tmp/streamless-session', channelId, transport as any, server as any)

    // Freshly registered: connected and stream present.
    expect(entry.connected).toBe(true)
    expect(hasSessionStreamAdapter(channelId)).toBe(true)

    // The SDK drops the standalone GET stream WITHOUT closing the transport and
    // WITHOUT a DELETE — connected must remain true (the steady state the bug
    // describes).
    ;(transport._streamMapping as Map<string, unknown>).delete('_GET_stream')

    expect(entry.connected).toBe(true)                 // unchanged — still "connected"
    expect(hasSessionStreamAdapter(channelId)).toBe(false)  // but no longer deliverable
  })

  test('adapter returns false when there is no session at all', () => {
    expect(hasSessionStreamAdapter('C_NO_SESSION')).toBe(false)
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
