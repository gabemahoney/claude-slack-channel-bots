/**
 * default-route-fallback.test.ts — Regression tests for bug b.7a4
 *
 * Bug: In server.ts handleMessage, the default_route fallback was applying to
 * ALL channels with no active session, including channels that ARE configured
 * in routingConfig.routes but whose MCP session hadn't registered yet. This
 * caused messages meant for a specific (but unready) session to be silently
 * rerouted to the default_route session.
 *
 * Fix: Added `!routingConfig.routes[channelId]` guard so default_route only
 * applies to channels that have NO route entry at all.
 *
 * Fixed condition (server.ts ~line 560):
 *   if (!targetSession && routingConfig?.default_route && !routingConfig.routes[channelId])
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

/** Minimal MCP server stub that records notification calls. */
function makeServer(): { server: any; notifications: any[] } {
  const notifications: any[] = []
  const server = {
    connect: async () => {},
    notification: (msg: any) => { notifications.push(msg) },
  }
  return { server, notifications }
}

/**
 * Build a RoutingConfig with:
 *   - one explicitly configured channel (`configuredChannelId` → `configuredCwd`)
 *   - optional `default_route` pointing at `defaultRouteCwd`
 */
function makeRoutingConfig(opts: {
  configuredChannelId?: string
  configuredCwd?: string
  defaultRouteCwd?: string
} = {}): RoutingConfig {
  const configuredChannelId = opts.configuredChannelId ?? 'C_CONFIGURED'
  const configuredCwd = opts.configuredCwd ?? '/tmp/configured-session'

  const config: RoutingConfig = {
    routes: {
      [configuredChannelId]: { cwd: configuredCwd },
    },
    bind: '127.0.0.1',
    port: 3100,
    session_restart_delay: 60,
    health_check_interval: 120,
    mcp_config_path: `${homedir()}/.claude/slack-mcp.json`,
  }

  if (opts.defaultRouteCwd !== undefined) {
    config.default_route = opts.defaultRouteCwd
  }

  return config
}

/**
 * Simulate the channel routing decision from server.ts handleMessage
 * (non-DM branch, lines ~550–563).
 *
 * Mirrors the fixed logic exactly:
 *   1. getSessionByChannel → targetSession
 *   2. if (!targetSession && default_route && !routes[channelId]) → fall through
 *
 * Returns { targetSession, usedDefaultRoute } so tests can inspect the result.
 */
function simulateChannelRoute(
  channelId: string,
  routingConfig: RoutingConfig | null,
): { targetSession: ReturnType<typeof getSessionByCwd>; usedDefaultRoute: boolean } {
  const targetByChannel = routingConfig
    ? getSessionByChannel(channelId, routingConfig)
    : undefined

  let targetSession = targetByChannel
  let usedDefaultRoute = false

  // Fixed guard: only fall through to default_route for channels NOT in routes
  if (!targetSession && routingConfig?.default_route && !routingConfig.routes[channelId]) {
    targetSession = getSessionByCwd(routingConfig.default_route)
    usedDefaultRoute = !!targetSession
  }

  return { targetSession, usedDefaultRoute }
}

// ---------------------------------------------------------------------------
// Reset registry state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRegistry()
})

// ---------------------------------------------------------------------------
// Regression: b.7a4 — configured channel must NOT fall through to default_route
// ---------------------------------------------------------------------------

describe('default_route fallback — configured channel is dropped when session not ready', () => {
  test('configured channel with no registered session is dropped (not sent to default_route)', () => {
    // default_route session IS registered and connected
    const { server: defaultServer } = makeServer()
    registerSession('/tmp/default-session', 'C_DEFAULT', makeTransport(), defaultServer)

    // Routing config has C_CONFIGURED in routes, plus a default_route
    const routingConfig = makeRoutingConfig({
      configuredChannelId: 'C_CONFIGURED',
      configuredCwd: '/tmp/configured-session',
      defaultRouteCwd: '/tmp/default-session',
    })

    // No session registered for /tmp/configured-session yet (still pending/unready)
    const { targetSession, usedDefaultRoute } = simulateChannelRoute('C_CONFIGURED', routingConfig)

    expect(targetSession).toBeUndefined()
    expect(usedDefaultRoute).toBe(false)
  })

  test('configured channel does not reach default_route even when default_route session is live', () => {
    // Register only the default_route session
    const { server } = makeServer()
    const defaultEntry = registerSession('/tmp/default-session', 'C_DEFAULT', makeTransport(), server)

    const routingConfig = makeRoutingConfig({
      configuredChannelId: 'C_CONFIGURED',
      configuredCwd: '/tmp/configured-session',
      defaultRouteCwd: '/tmp/default-session',
    })

    const { targetSession } = simulateChannelRoute('C_CONFIGURED', routingConfig)

    // Must NOT return the default_route session
    expect(targetSession).toBeUndefined()
    // Sanity: the default_route session itself is live in the registry
    expect(defaultEntry.connected).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Preserved behaviour: unconfigured channel DOES fall through to default_route
// ---------------------------------------------------------------------------

describe('default_route fallback — unconfigured channel routes to default_route', () => {
  test('unconfigured channel is forwarded to default_route when session is live', () => {
    const { server } = makeServer()
    registerSession('/tmp/default-session', 'C_DEFAULT', makeTransport(), server)

    const routingConfig = makeRoutingConfig({
      configuredChannelId: 'C_CONFIGURED',
      configuredCwd: '/tmp/configured-session',
      defaultRouteCwd: '/tmp/default-session',
    })

    // C_UNCONFIGURED is NOT in routingConfig.routes
    const { targetSession, usedDefaultRoute } = simulateChannelRoute('C_UNCONFIGURED', routingConfig)

    expect(targetSession).toBeDefined()
    expect(targetSession!.cwd).toBe('/tmp/default-session')
    expect(usedDefaultRoute).toBe(true)
  })

  test('unconfigured channel is dropped when default_route session is not connected', () => {
    const { server } = makeServer()
    const entry = registerSession('/tmp/default-session', 'C_DEFAULT', makeTransport(), server)
    entry.connected = false

    const routingConfig = makeRoutingConfig({
      configuredChannelId: 'C_CONFIGURED',
      configuredCwd: '/tmp/configured-session',
      defaultRouteCwd: '/tmp/default-session',
    })

    const { targetSession } = simulateChannelRoute('C_UNCONFIGURED', routingConfig)

    // Session exists but is not connected — caller must check connected
    // (server.ts checks `!targetSession || !targetSession.connected`)
    expect(targetSession?.connected).toBe(false)
  })

  test('unconfigured channel is dropped when no default_route is configured', () => {
    const routingConfig = makeRoutingConfig({
      configuredChannelId: 'C_CONFIGURED',
      configuredCwd: '/tmp/configured-session',
      // no defaultRouteCwd
    })

    const { targetSession, usedDefaultRoute } = simulateChannelRoute('C_UNCONFIGURED', routingConfig)

    expect(targetSession).toBeUndefined()
    expect(usedDefaultRoute).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Combined: configured channel is dropped while unconfigured channel is routed
// ---------------------------------------------------------------------------

describe('default_route fallback — configured and unconfigured channels in same config', () => {
  test('configured-but-unready channel is dropped while unconfigured channel reaches default_route', () => {
    const { server } = makeServer()
    registerSession('/tmp/default-session', 'C_DEFAULT', makeTransport(), server)

    const routingConfig = makeRoutingConfig({
      configuredChannelId: 'C_CONFIGURED',
      configuredCwd: '/tmp/configured-session',
      defaultRouteCwd: '/tmp/default-session',
    })

    // Configured channel (session not registered) → dropped
    const { targetSession: configured } = simulateChannelRoute('C_CONFIGURED', routingConfig)
    expect(configured).toBeUndefined()

    // Unconfigured channel → falls through to default_route
    const { targetSession: unconfigured, usedDefaultRoute } = simulateChannelRoute('C_UNCONFIGURED', routingConfig)
    expect(unconfigured).toBeDefined()
    expect(unconfigured!.cwd).toBe('/tmp/default-session')
    expect(usedDefaultRoute).toBe(true)
  })

  test('once configured channel session registers, it is served directly without using default_route', () => {
    const { server: defaultServer } = makeServer()
    registerSession('/tmp/default-session', 'C_DEFAULT', makeTransport(), defaultServer)

    const { server: configuredServer } = makeServer()
    registerSession('/tmp/configured-session', 'C_CONFIGURED', makeTransport(), configuredServer)

    const routingConfig = makeRoutingConfig({
      configuredChannelId: 'C_CONFIGURED',
      configuredCwd: '/tmp/configured-session',
      defaultRouteCwd: '/tmp/default-session',
    })

    const { targetSession, usedDefaultRoute } = simulateChannelRoute('C_CONFIGURED', routingConfig)

    expect(targetSession).toBeDefined()
    expect(targetSession!.cwd).toBe('/tmp/configured-session')
    expect(usedDefaultRoute).toBe(false)
  })
})
