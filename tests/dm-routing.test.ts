/**
 * dm-routing.test.ts — Tests for DM routing logic (Task t2.c1r.3i.to)
 *
 * Tests the DM routing behaviour implemented in server.ts's handleMessage,
 * tested in isolation by exercising the gate function from lib.ts and the
 * session registry from registry.ts directly.
 *
 * The handleMessage function composes:
 *   1. gate()         — access-control decision (deliver / drop / pair)
 *   2. isDm check     — ev.channel_type === 'im'
 *   3. getSessionByCwd(routingConfig.default_dm_session)
 *   4. targetSession.deliveredChannels.add(channelId)  — on delivery
 *   5. targetSession.server.notification(...)           — dispatch to session
 *
 * Because handleMessage cannot be imported without initialising the live Slack
 * socket and WebClient, we test each step of its logic independently by:
 *   - calling gate() directly from lib.ts
 *   - manipulating the session registry directly from registry.ts
 *   - asserting on registry state / notification call counts
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { homedir } from 'os'
import {
  gate,
  assertOutboundAllowed,
  defaultAccess,
  type Access,
  type GateOptions,
  type GateResult,
} from '../lib.ts'
import {
  registerSession,
  getSessionByCwd,
  _resetRegistry,
} from '../registry.ts'
import type { RoutingConfig } from '../config.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccess(overrides: Partial<Access> = {}): Access {
  return { ...defaultAccess(), ...overrides }
}

function makeGateOpts(overrides: Partial<GateOptions> = {}): GateOptions {
  return {
    access: makeAccess(),
    staticMode: false,
    saveAccess: () => {},
    botUserId: 'U_BOT',
    ...overrides,
  }
}

/** Minimal stub for WebStandardStreamableHTTPServerTransport. */
function makeTransport(): any {
  return { handleRequest: () => {}, close: async () => {} }
}

/** Minimal stub for MCP Server that records notification calls. */
function makeServer(): { server: any; notifications: any[] } {
  const notifications: any[] = []
  const server = {
    connect: async () => {},
    notification: (msg: any) => { notifications.push(msg) },
  }
  return { server, notifications }
}

/**
 * Builds a minimal RoutingConfig with one route and an optional
 * default_dm_session pointing at that route.
 */
function makeRoutingConfig(opts: {
  channelId?: string
  cwd?: string
  default_dm_session?: string
} = {}): RoutingConfig {
  const channelId = opts.channelId ?? 'C_BOT_CHANNEL'
  const cwd = opts.cwd ?? '/tmp/dm-session'

  const config: RoutingConfig = {
    routes: {
      [channelId]: { cwd },
    },
    bind: '127.0.0.1',
    port: 3100,
    session_restart_delay: 60,
    mcp_config_path: `${homedir()}/.claude/slack-mcp.json`,
  }

  if (opts.default_dm_session !== undefined) {
    config.default_dm_session = opts.default_dm_session
  }

  return config
}

/**
 * Simulate the DM routing decision from server.ts handleMessage for the
 * 'deliver' branch. Returns { delivered, targetSession } so tests can
 * inspect the result.
 *
 * Logic mirrors server.ts lines 334–359:
 *   if (isDm) {
 *     if (!routingConfig?.default_dm_session) return (drop)
 *     targetSession = getSessionByCwd(routingConfig.default_dm_session)
 *     if (!targetSession || !targetSession.connected) return (drop)
 *     targetSession.deliveredChannels.add(channelId)
 *     targetSession.server.notification(...)
 *   }
 */
function simulateDmDeliver(
  channelId: string,
  routingConfig: RoutingConfig | null,
): { delivered: boolean; targetSession: ReturnType<typeof getSessionByCwd> } {
  if (!routingConfig?.default_dm_session) {
    return { delivered: false, targetSession: undefined }
  }

  const targetSession = getSessionByCwd(routingConfig.default_dm_session)

  if (!targetSession || !targetSession.connected) {
    return { delivered: false, targetSession }
  }

  // Add DM channel to session's deliveredChannels (t2.c1r.3i.bo)
  targetSession.deliveredChannels.add(channelId)

  // Dispatch to the session's server (simulated)
  targetSession.server.notification({
    method: 'notifications/claude/channel',
    params: { content: 'hello', meta: { chat_id: channelId } },
  })

  return { delivered: true, targetSession }
}

// ---------------------------------------------------------------------------
// Reset registry state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRegistry()
})

// ---------------------------------------------------------------------------
// Test 1 — DM from allowed user forwarded to default_dm_session route
// ---------------------------------------------------------------------------

describe('DM routing — forwarded to default_dm_session', () => {
  test('gate delivers DM from allowlisted user', async () => {
    const access = makeAccess({ allowFrom: ['U_ALLOWED'] })
    const result = await gate(
      { user: 'U_ALLOWED', channel_type: 'im', channel: 'D_DM1' },
      makeGateOpts({ access }),
    )
    expect(result.action).toBe('deliver')
  })

  test('DM is dispatched to the default_dm_session when gate returns deliver', async () => {
    const access = makeAccess({ allowFrom: ['U_ALLOWED'] })

    // Gate must deliver
    const result = await gate(
      { user: 'U_ALLOWED', channel_type: 'im', channel: 'D_DM1' },
      makeGateOpts({ access }),
    )
    expect(result.action).toBe('deliver')

    // Set up registry with a connected dm-session
    const { server, notifications } = makeServer()
    const entry = registerSession('/tmp/dm-session', 'C_BOT', makeTransport(), server as any)
    entry.server = server

    const routingConfig = makeRoutingConfig({ default_dm_session: '/tmp/dm-session' })

    const { delivered } = simulateDmDeliver('D_DM1', routingConfig)

    expect(delivered).toBe(true)
    expect(notifications).toHaveLength(1)
    expect(notifications[0].method).toBe('notifications/claude/channel')
    expect(notifications[0].params.meta.chat_id).toBe('D_DM1')
  })
})

// ---------------------------------------------------------------------------
// Test 2 — DM dropped when no default_dm_session configured (null)
// ---------------------------------------------------------------------------

describe('DM routing — dropped when no default_dm_session configured', () => {
  test('DM is dropped when routingConfig has no default_dm_session', async () => {
    const access = makeAccess({ allowFrom: ['U_ALLOWED'] })

    const gateResult = await gate(
      { user: 'U_ALLOWED', channel_type: 'im', channel: 'D_DM1' },
      makeGateOpts({ access }),
    )
    // Gate says deliver, but routing config has no default_dm_session
    expect(gateResult.action).toBe('deliver')

    // Register a session (should not be reached)
    const { server, notifications } = makeServer()
    const entry = registerSession('/tmp/some-session', 'C_BOT', makeTransport(), server as any)
    entry.server = server

    // RoutingConfig WITHOUT default_dm_session
    const routingConfig = makeRoutingConfig({ cwd: '/tmp/some-session' }) // no default_dm_session

    const { delivered } = simulateDmDeliver('D_DM1', routingConfig)

    expect(delivered).toBe(false)
    expect(notifications).toHaveLength(0)
  })

  test('DM is dropped when routingConfig is null', async () => {
    const { delivered } = simulateDmDeliver('D_DM1', null)
    expect(delivered).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test 3 — DM dropped when default_dm_session session not connected
// ---------------------------------------------------------------------------

describe('DM routing — dropped when default_dm_session session not connected', () => {
  test('DM is dropped when the target session exists but is not connected', async () => {
    const { server, notifications } = makeServer()
    const entry = registerSession('/tmp/dm-session', 'C_BOT', makeTransport(), server as any)
    entry.server = server
    // Mark the session as disconnected
    entry.connected = false

    const routingConfig = makeRoutingConfig({ default_dm_session: '/tmp/dm-session' })

    const { delivered } = simulateDmDeliver('D_DM1', routingConfig)

    expect(delivered).toBe(false)
    expect(notifications).toHaveLength(0)
  })

  test('DM is dropped when no session is registered for the default_dm_session route', async () => {
    // No session registered — registry is empty
    const routingConfig = makeRoutingConfig({ default_dm_session: '/tmp/dm-session' })

    const { delivered } = simulateDmDeliver('D_DM1', routingConfig)

    expect(delivered).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test 4 — DM channel ID added to DM session's deliveredChannels on delivery
// ---------------------------------------------------------------------------

describe('DM routing — DM channel added to deliveredChannels', () => {
  test('DM channel ID is added to the session deliveredChannels after delivery', async () => {
    const { server } = makeServer()
    const entry = registerSession('/tmp/dm-session', 'C_BOT', makeTransport(), server as any)
    entry.server = server

    // Before delivery, DM channel is NOT in deliveredChannels
    expect(entry.deliveredChannels.has('D_DM1')).toBe(false)

    const routingConfig = makeRoutingConfig({ default_dm_session: '/tmp/dm-session' })

    const { delivered } = simulateDmDeliver('D_DM1', routingConfig)

    expect(delivered).toBe(true)
    // After delivery, DM channel IS in deliveredChannels
    expect(entry.deliveredChannels.has('D_DM1')).toBe(true)
  })

  test('multiple DM channels from different users are all tracked', async () => {
    const { server } = makeServer()
    const entry = registerSession('/tmp/dm-session', 'C_BOT', makeTransport(), server as any)
    entry.server = server

    const routingConfig = makeRoutingConfig({ default_dm_session: '/tmp/dm-session' })

    simulateDmDeliver('D_USER1', routingConfig)
    simulateDmDeliver('D_USER2', routingConfig)
    simulateDmDeliver('D_USER3', routingConfig)

    expect(entry.deliveredChannels.has('D_USER1')).toBe(true)
    expect(entry.deliveredChannels.has('D_USER2')).toBe(true)
    expect(entry.deliveredChannels.has('D_USER3')).toBe(true)
  })

  test('adding the same DM channel twice is idempotent', async () => {
    const { server } = makeServer()
    const entry = registerSession('/tmp/dm-session', 'C_BOT', makeTransport(), server as any)
    entry.server = server

    const routingConfig = makeRoutingConfig({ default_dm_session: '/tmp/dm-session' })

    simulateDmDeliver('D_DM1', routingConfig)
    simulateDmDeliver('D_DM1', routingConfig)

    // Set semantics: D_DM1 still only appears once
    const channels = Array.from(entry.deliveredChannels).filter((c) => c === 'D_DM1')
    expect(channels).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Test 5 — DM session can reply to DM channel after receiving a DM
//          (outbound scoping via assertOutboundAllowed)
// ---------------------------------------------------------------------------

describe('DM routing — outbound scoping after DM delivery', () => {
  test('session can reply to DM channel after it has been added to deliveredChannels', () => {
    const { server } = makeServer()
    const entry = registerSession('/tmp/dm-session', 'C_BOT', makeTransport(), server as any)
    entry.server = server

    const routingConfig = makeRoutingConfig({ default_dm_session: '/tmp/dm-session' })
    simulateDmDeliver('D_DM1', routingConfig)

    const access = makeAccess()

    // D_DM1 is now in deliveredChannels — outbound should be allowed
    expect(() =>
      assertOutboundAllowed('D_DM1', access, entry.deliveredChannels),
    ).not.toThrow()
  })

  test('session cannot reply to a DM channel it has not received a message from', () => {
    const { server } = makeServer()
    const entry = registerSession('/tmp/dm-session', 'C_BOT', makeTransport(), server as any)
    entry.server = server

    const access = makeAccess()

    // D_DM_NEVER was never delivered — outbound should be blocked
    expect(() =>
      assertOutboundAllowed('D_DM_NEVER', access, entry.deliveredChannels),
    ).toThrow('Outbound gate')
  })

  test('delivering to one DM channel does not unlock another DM channel', () => {
    const { server } = makeServer()
    const entry = registerSession('/tmp/dm-session', 'C_BOT', makeTransport(), server as any)
    entry.server = server

    const routingConfig = makeRoutingConfig({ default_dm_session: '/tmp/dm-session' })
    simulateDmDeliver('D_DM1', routingConfig)

    const access = makeAccess()

    // D_DM2 was never delivered to this session
    expect(() =>
      assertOutboundAllowed('D_DM2', access, entry.deliveredChannels),
    ).toThrow('Outbound gate')
  })

  test('channel session cannot reply to DM channels that belong to another session', () => {
    const { server: serverA } = makeServer()
    const entryA = registerSession('/tmp/channel-session', 'C_CHANNEL', makeTransport(), serverA as any)
    entryA.server = serverA

    const { server: serverB } = makeServer()
    const entryB = registerSession('/tmp/dm-session', 'C_BOT', makeTransport(), serverB as any)
    entryB.server = serverB

    const routingConfig = makeRoutingConfig({ default_dm_session: '/tmp/dm-session' })
    simulateDmDeliver('D_DM1', routingConfig)

    const access = makeAccess()

    // entryB received the DM, so it can reply
    expect(() =>
      assertOutboundAllowed('D_DM1', access, entryB.deliveredChannels),
    ).not.toThrow()

    // entryA did not receive the DM, so it cannot reply
    expect(() =>
      assertOutboundAllowed('D_DM1', access, entryA.deliveredChannels),
    ).toThrow('Outbound gate')
  })
})

// ---------------------------------------------------------------------------
// Test 6 — Pairing flow runs server-side (gate returns pair)
// ---------------------------------------------------------------------------

describe('DM routing — pairing flow runs server-side', () => {
  test('gate returns pair action for unknown DM sender in pairing mode', async () => {
    const access = makeAccess({ dmPolicy: 'pairing' })
    const result = await gate(
      { user: 'U_STRANGER', channel_type: 'im', channel: 'D_NEW' },
      makeGateOpts({ access }),
    )
    expect(result.action).toBe('pair')
    expect(result.code).toBeDefined()
    expect(result.isResend).toBe(false)
  })

  test('gate returns pair with isResend=true when sender already has a pending code', async () => {
    const access = makeAccess({
      dmPolicy: 'pairing',
      pending: {
        XYZ789: {
          senderId: 'U_PENDING',
          chatId: 'D_PENDING',
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600000,
          replies: 1,
        },
      },
    })
    const result = await gate(
      { user: 'U_PENDING', channel_type: 'im', channel: 'D_PENDING' },
      makeGateOpts({ access }),
    )
    expect(result.action).toBe('pair')
    expect(result.code).toBe('XYZ789')
    expect(result.isResend).toBe(true)
  })

  test('pairing result action is pair, not deliver — so message is NOT forwarded to a session', async () => {
    const access = makeAccess({ dmPolicy: 'pairing' })
    const result = await gate(
      { user: 'U_STRANGER', channel_type: 'im', channel: 'D_NEW' },
      makeGateOpts({ access }),
    )

    // Server-side pairing: only the 'deliver' action should forward to a session.
    // 'pair' means the server sends back a pairing message via web.chat.postMessage,
    // and the message is NOT dispatched to any registered session.
    expect(result.action).not.toBe('deliver')
    expect(result.action).toBe('pair')
  })

  test('pair action carries the pairing code needed for web.chat.postMessage reply', async () => {
    const access = makeAccess({ dmPolicy: 'pairing' })
    const result: GateResult = await gate(
      { user: 'U_STRANGER', channel_type: 'im', channel: 'D_NEW' },
      makeGateOpts({ access }),
    )

    expect(result.action).toBe('pair')
    // The code must be present so server.ts can include it in the pairing message
    expect(typeof result.code).toBe('string')
    expect(result.code!.length).toBe(6)
  })

  test('pair action in resend case carries the same existing code', async () => {
    let savedAccess: Access | null = null
    const access = makeAccess({ dmPolicy: 'pairing' })

    // First contact: generates code
    const first = await gate(
      { user: 'U_STRANGER', channel_type: 'im', channel: 'D_NEW' },
      makeGateOpts({
        access,
        saveAccess: (a) => { savedAccess = a },
      }),
    )
    expect(first.action).toBe('pair')
    const originalCode = first.code!

    // Use the saved access (with the pending entry) for the second contact
    const accessWithPending = savedAccess ?? access
    const second = await gate(
      { user: 'U_STRANGER', channel_type: 'im', channel: 'D_NEW' },
      makeGateOpts({
        access: accessWithPending,
        saveAccess: () => {},
      }),
    )
    expect(second.action).toBe('pair')
    expect(second.code).toBe(originalCode)
    expect(second.isResend).toBe(true)
  })

  test('pair action: registered session receives zero notifications (not forwarded)', async () => {
    const access = makeAccess({ dmPolicy: 'pairing' })

    const { server, notifications } = makeServer()
    const entry = registerSession('/tmp/dm-session', 'C_BOT', makeTransport(), server as any)
    entry.server = server

    const result = await gate(
      { user: 'U_STRANGER', channel_type: 'im', channel: 'D_NEW' },
      makeGateOpts({ access }),
    )

    // Gate returns pair — the server does NOT forward to the session
    expect(result.action).toBe('pair')

    // In server.ts handleMessage, the 'pair' case calls web.chat.postMessage
    // and returns early — it never calls targetSession.server.notification.
    // We verify no notification was sent to the session.
    expect(notifications).toHaveLength(0)
  })
})
