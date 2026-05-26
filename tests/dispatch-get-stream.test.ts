/**
 * dispatch-get-stream.test.ts — Tests for the b.sjy instrumentation patch.
 *
 * Verifies the dispatch-site logic added in handleMessage (server.ts ~line 664):
 *   - When _GET_stream is absent from transport._streamMapping, scheduleRestart
 *     is called with (channelId, cwd).
 *   - When _GET_stream IS present, scheduleRestart is NOT called from this path.
 *
 * handleMessage cannot be imported directly (server.ts has module-scope side
 * effects: Slack client init, token load, etc.). We follow the same pattern as
 * dm-routing.test.ts — replicate only the relevant sub-logic in a
 * simulateDispatch helper and test it in isolation.
 *
 * scheduleRestart is observable via initRestart (injectable deps) +
 * isRestartPendingOrActive from restart.ts, which returns true when a timer is
 * pending. We use a large restart delay so the timer never fires during the
 * test, then check the pending state synchronously.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { _resetRegistry } from '../src/registry.ts'
import { hasGetStreamKey } from '../src/lib.ts'
import {
  initRestart,
  scheduleRestart,
  isRestartPendingOrActive,
  cancelAllRestartTimers,
  _resetRestartState,
  type RestartDeps,
} from '../src/restart.ts'

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
    async reconnectSession() {},
    async killSession() {},
    async launchSession() { return true },
    getRestartDelay: () => NEVER_FIRE_DELAY_S,
    isShuttingDown: () => false,
  }
}

/**
 * Simulate the dispatch-site logic added by the b.sjy patch (server.ts ~664).
 *
 * Logic mirrors exactly:
 *   const transport = targetSession.transport as any
 *   if (!hasGetStreamKey(transport)) {
 *     scheduleRestart(channelId, targetSession.cwd)
 *   }
 *   targetSession.server.notification({ method: 'notifications/claude/channel', ... })
 *
 * simulateDispatch now delegates to the real hasGetStreamKey imported from
 * lib.ts, so if the predicate's semantics change in lib.ts these tests will
 * catch it.
 *
 * RESIDUAL GAP: deleting the *call* to hasGetStreamKey from server.ts would
 * NOT be caught by these unit tests. That gap is intrinsic to the project's
 * "can't import server.ts" constraint; it belongs in Phase 1 manual
 * verification per the acceptance criteria in the b.sjy bee.
 *
 * Returns whether notification() was called (always true in the patch — the
 * .notification() call is unconditional).
 */
function simulateDispatch(
  channelId: string,
  cwd: string,
  transport: any,
  server: any,
  scheduleRestartFn: (channelId: string, cwd: string) => void,
): { notificationCalled: boolean } {
  if (!hasGetStreamKey(transport)) {
    scheduleRestartFn(channelId, cwd)
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
  initRestart(makeRestartDeps())
})

afterEach(() => {
  cancelAllRestartTimers()
  _resetRestartState()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatch-site _GET_stream check (b.sjy)', () => {
  // -------------------------------------------------------------------------
  // Test 1 — no _GET_stream → scheduleRestart IS called
  // -------------------------------------------------------------------------

  test('scheduleRestart is called when transport has no _GET_stream entry', () => {
    const channelId = 'C_DROP_TEST'
    const cwd = '/tmp/drop-session'
    const transport = makeTransport(false) // _GET_stream absent
    const { server, notifications } = makeServer()

    const { notificationCalled } = simulateDispatch(
      channelId,
      cwd,
      transport,
      server,
      scheduleRestart,
    )

    // The patch schedules a restart when _GET_stream is absent.
    // isRestartPendingOrActive returns true iff scheduleRestart placed a timer
    // (which it does when delay > 0 and failures < max).
    expect(isRestartPendingOrActive(channelId)).toBe(true)

    // .notification() is still called even on the drop path (observe + restart,
    // not a behavior change to the normal path).
    expect(notificationCalled).toBe(true)
    expect(notifications).toHaveLength(1)
    expect(notifications[0].method).toBe('notifications/claude/channel')
  })

  // -------------------------------------------------------------------------
  // Test 2 — _GET_stream present → scheduleRestart NOT called
  // -------------------------------------------------------------------------

  test('scheduleRestart is NOT called when transport has _GET_stream entry', () => {
    const channelId = 'C_OK_TEST'
    const cwd = '/tmp/ok-session'
    const transport = makeTransport(true) // _GET_stream present
    const { server, notifications } = makeServer()

    simulateDispatch(channelId, cwd, transport, server, scheduleRestart)

    // No restart should be scheduled on the healthy path.
    expect(isRestartPendingOrActive(channelId)).toBe(false)

    // Notification still fires.
    expect(notifications).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Test 3 — correct channelId and cwd are passed to scheduleRestart
  // -------------------------------------------------------------------------

  test('scheduleRestart receives the correct channelId and cwd when _GET_stream is absent', () => {
    const channelId = 'C_SPECIFIC'
    const cwd = '/tmp/specific-session'
    const transport = makeTransport(false)
    const { server } = makeServer()

    // Use a recording wrapper instead of the real scheduleRestart so we can
    // assert the exact arguments without relying on restart internals.
    const calls: Array<{ channelId: string; cwd: string }> = []
    simulateDispatch(channelId, cwd, transport, server, (ch, c) => {
      calls.push({ channelId: ch, cwd: c })
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].channelId).toBe(channelId)
    expect(calls[0].cwd).toBe(cwd)
  })

  // -------------------------------------------------------------------------
  // Test 4 — drop path does NOT skip the .notification() call
  // -------------------------------------------------------------------------

  test('notification() is still called even when _GET_stream is absent (drop + restart, not drop + skip)', () => {
    const channelId = 'C_DROP_NOTIFY'
    const cwd = '/tmp/drop-notify-session'
    const transport = makeTransport(false)
    const { server, notifications } = makeServer()
    const calls: Array<{ channelId: string; cwd: string }> = []

    simulateDispatch(channelId, cwd, transport, server, (ch, c) => {
      calls.push({ channelId: ch, cwd: c })
    })

    // scheduleRestart was triggered
    expect(calls).toHaveLength(1)
    // notification() was still called (not short-circuited)
    expect(notifications).toHaveLength(1)
    expect(notifications[0].method).toBe('notifications/claude/channel')
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
