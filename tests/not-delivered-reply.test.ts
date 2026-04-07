/**
 * not-delivered-reply.test.ts — Tests for the "not delivered" Slack reply
 *
 * When handleMessage in server.ts finds no live session for a channel but the
 * channel IS configured in routingConfig.routes, it posts:
 *   "Message not delivered — session starting up, please retry in a moment."
 *
 * Because server.ts cannot be imported in tests (module-scope side effects),
 * we isolate the routing decision by simulating the relevant logic directly
 * using the session registry. The postMessage behaviour is verified via a
 * stub that records calls.
 *
 * The logic under test (server.ts ~lines 554–568):
 *
 *   if (!targetSession || !targetSession.connected) {
 *     if (routingConfig?.routes[channelId]) {
 *       await web.chat.postMessage({
 *         channel: channelId,
 *         text: 'Message not delivered — session starting up, please retry in a moment.',
 *       })
 *     }
 *     return
 *   }
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { homedir } from 'os'
import {
  registerSession,
  getSessionByChannel,
  getSessionByCwd,
  _resetRegistry,
} from '../src/registry.ts'
import type { RoutingConfig } from '../src/config.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal transport stub. */
function makeTransport(): any {
  return { handleRequest: () => {}, close: async () => {} }
}

/** Minimal MCP server stub. */
function makeServer(): any {
  return { connect: async () => {}, notification: () => {} }
}

/** Build a RoutingConfig with one configured channel. */
function makeRoutingConfig(opts: {
  channelId?: string
  cwd?: string
  default_route?: string
} = {}): RoutingConfig {
  const channelId = opts.channelId ?? 'C_CONFIGURED'
  const cwd = opts.cwd ?? '/tmp/not-delivered-session'

  const config: RoutingConfig = {
    routes: {
      [channelId]: { cwd },
    },
    bind: '127.0.0.1',
    port: 3100,
    session_restart_delay: 60,
    health_check_interval: 120,
    exit_timeout: 120,
    stop_timeout: 30,
    mcp_config_path: `${homedir()}/.claude/slack-mcp.json`,
    cozempic_prescription: 'standard',
    system_prompt_mode: 'append',
    channelsEnabled: true,
  }

  if (opts.default_route !== undefined) {
    config.default_route = opts.default_route
  }

  return config
}

/**
 * Simulate the "not delivered" decision from server.ts handleMessage.
 *
 * Mirrors the channel routing + not-delivered guard (lines ~543–568):
 *   1. getSessionByChannel → targetSession
 *   2. default_route fallback (only for unconfigured channels)
 *   3. if no live session && channel is in routes → call postMessage
 *
 * Returns { dropped, notifiedSender } for test assertions.
 */
async function simulateChannelMessage(
  channelId: string,
  routingConfig: RoutingConfig | null,
  postMessageCalls: any[],
): Promise<{ dropped: boolean; notifiedSender: boolean }> {
  let targetSession = routingConfig
    ? getSessionByChannel(channelId, routingConfig)
    : undefined

  // default_route fallback — only for channels NOT in routes
  if (!targetSession && routingConfig?.default_route && !routingConfig.routes[channelId]) {
    targetSession = getSessionByCwd(routingConfig.default_route)
  }

  if (!targetSession || !targetSession.connected) {
    let notifiedSender = false
    if (routingConfig?.routes[channelId]) {
      postMessageCalls.push({
        channel: channelId,
        text: 'Message not delivered — session starting up, please retry in a moment.',
      })
      notifiedSender = true
    }
    return { dropped: true, notifiedSender }
  }

  return { dropped: false, notifiedSender: false }
}

// ---------------------------------------------------------------------------
// Reset registry before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRegistry()
})

// ---------------------------------------------------------------------------
// Core behaviour: "not delivered" reply is sent
// ---------------------------------------------------------------------------

describe('"not delivered" reply — channel configured but session not registered', () => {
  test('postMessage is called with the not-delivered text when channel is in routes but no session exists', async () => {
    const postMessageCalls: any[] = []
    const routingConfig = makeRoutingConfig({ channelId: 'C_CONFIGURED' })

    // No session registered for the route

    const { dropped, notifiedSender } = await simulateChannelMessage(
      'C_CONFIGURED', routingConfig, postMessageCalls,
    )

    expect(dropped).toBe(true)
    expect(notifiedSender).toBe(true)
    expect(postMessageCalls).toHaveLength(1)
    expect(postMessageCalls[0].channel).toBe('C_CONFIGURED')
    expect(postMessageCalls[0].text).toBe(
      'Message not delivered — session starting up, please retry in a moment.',
    )
  })

  test('postMessage is called when session is registered but disconnected', async () => {
    const postMessageCalls: any[] = []
    const entry = registerSession(
      '/tmp/not-delivered-session', 'C_CONFIGURED', makeTransport(), makeServer(),
    )
    entry.connected = false

    const routingConfig = makeRoutingConfig({ channelId: 'C_CONFIGURED' })

    const { dropped, notifiedSender } = await simulateChannelMessage(
      'C_CONFIGURED', routingConfig, postMessageCalls,
    )

    expect(dropped).toBe(true)
    expect(notifiedSender).toBe(true)
    expect(postMessageCalls).toHaveLength(1)
    expect(postMessageCalls[0].channel).toBe('C_CONFIGURED')
  })
})

// ---------------------------------------------------------------------------
// No notification for channels NOT in routes
// ---------------------------------------------------------------------------

describe('"not delivered" reply — not sent for channels absent from routes', () => {
  test('postMessage is NOT called when the channel has no route entry', async () => {
    const postMessageCalls: any[] = []
    // C_CONFIGURED is in routes, but we send from C_UNKNOWN
    const routingConfig = makeRoutingConfig({ channelId: 'C_CONFIGURED' })

    const { dropped, notifiedSender } = await simulateChannelMessage(
      'C_UNKNOWN', routingConfig, postMessageCalls,
    )

    expect(dropped).toBe(true)
    expect(notifiedSender).toBe(false)
    expect(postMessageCalls).toHaveLength(0)
  })

  test('postMessage is NOT called when routingConfig is null', async () => {
    const postMessageCalls: any[] = []

    const { dropped, notifiedSender } = await simulateChannelMessage(
      'C_CONFIGURED', null, postMessageCalls,
    )

    expect(dropped).toBe(true)
    expect(notifiedSender).toBe(false)
    expect(postMessageCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// No notification when session IS live
// ---------------------------------------------------------------------------

describe('"not delivered" reply — not sent when session is live', () => {
  test('postMessage is NOT called when the session is registered and connected', async () => {
    const postMessageCalls: any[] = []
    registerSession(
      '/tmp/not-delivered-session', 'C_CONFIGURED', makeTransport(), makeServer(),
    )

    const routingConfig = makeRoutingConfig({ cwd: '/tmp/not-delivered-session' })

    const { dropped, notifiedSender } = await simulateChannelMessage(
      'C_CONFIGURED', routingConfig, postMessageCalls,
    )

    expect(dropped).toBe(false)
    expect(notifiedSender).toBe(false)
    expect(postMessageCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Interaction with default_route: configured channel with unready session
// is dropped (and notified) — NOT silently rerouted to default_route
// ---------------------------------------------------------------------------

describe('"not delivered" reply — configured channel is not rerouted to default_route', () => {
  test('configured channel with no session posts not-delivered and is NOT routed to default_route', async () => {
    const postMessageCalls: any[] = []

    // Register a live default_route session
    registerSession('/tmp/default-session', 'C_DEFAULT', makeTransport(), makeServer())

    const routingConfig = makeRoutingConfig({
      channelId: 'C_CONFIGURED',
      cwd: '/tmp/not-delivered-session',
      default_route: '/tmp/default-session',
    })

    // C_CONFIGURED is in routes but has no registered session
    const { dropped, notifiedSender } = await simulateChannelMessage(
      'C_CONFIGURED', routingConfig, postMessageCalls,
    )

    expect(dropped).toBe(true)
    // Sender is notified because the channel IS in routes
    expect(notifiedSender).toBe(true)
    expect(postMessageCalls).toHaveLength(1)
    expect(postMessageCalls[0].channel).toBe('C_CONFIGURED')
  })

  test('unconfigured channel is dropped silently without not-delivered notification', async () => {
    const postMessageCalls: any[] = []

    // No default_route configured and C_UNKNOWN is not in routes
    const routingConfig = makeRoutingConfig({ channelId: 'C_CONFIGURED' })

    const { dropped, notifiedSender } = await simulateChannelMessage(
      'C_UNKNOWN', routingConfig, postMessageCalls,
    )

    expect(dropped).toBe(true)
    expect(notifiedSender).toBe(false)
    expect(postMessageCalls).toHaveLength(0)
  })
})
