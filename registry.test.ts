/**
 * registry.test.ts — Tests for session registry and routing (Tasks t2.c1r.zk.6r, t2.c1r.zk.qm, t2.c1r.zk.3d)
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import type { RouteEntry, RoutingConfig } from './config.ts'
import {
  registerSession,
  unregisterSession,
  getSessionByRoute,
  getSessionByChannel,
  registerMcpSessionId,
  resolveTransportForRequest,
  _resetRegistry,
  type SessionEntry,
} from './registry.ts'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a minimal RouteEntry fixture. */
function makeRoute(name: string, cwd = '/tmp'): RouteEntry {
  return { name, cwd }
}

/** Creates a RoutingConfig with two test routes. */
function makeRoutingConfig(opts: {
  channelA?: string
  routeA?: string
  channelB?: string
  routeB?: string
  default_route?: string
} = {}): RoutingConfig {
  const channelA = opts.channelA ?? 'C_ALPHA'
  const routeA   = opts.routeA   ?? 'route-alpha'
  const channelB = opts.channelB ?? 'C_BETA'
  const routeB   = opts.routeB   ?? 'route-beta'

  const config: RoutingConfig = {
    routes: {
      [channelA]: makeRoute(routeA),
      [channelB]: makeRoute(routeB),
    },
    bind: '127.0.0.1',
    port: 3100,
  }

  if (opts.default_route !== undefined) {
    config.default_route = opts.default_route
  }

  return config
}

/** Minimal stub for WebStandardStreamableHTTPServerTransport. */
function makeTransport(): any {
  return { handleRequest: () => {}, close: async () => {} }
}

/** Minimal stub for MCP Server. */
function makeServer(): any {
  return {
    connect: async () => {},
    notification: () => {},
  }
}

// ---------------------------------------------------------------------------
// Reset registry state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRegistry()
})

// ---------------------------------------------------------------------------
// Session Registry Tests
// ---------------------------------------------------------------------------

describe('registerSession', () => {
  test('registers a session successfully', () => {
    const entry = registerSession('route-a', 'C_A', makeTransport(), makeServer())

    expect(entry.routeName).toBe('route-a')
    expect(entry.channelId).toBe('C_A')
    expect(entry.connected).toBe(true)
  })

  test('seeds deliveredChannels with the assigned channelId', () => {
    const entry = registerSession('route-a', 'C_A', makeTransport(), makeServer())

    expect(entry.deliveredChannels.has('C_A')).toBe(true)
    expect(entry.deliveredChannels.size).toBe(1)
  })

  test('replaces an existing session when re-registering for the same route', () => {
    const first = registerSession('route-a', 'C_A', makeTransport(), makeServer())
    const second = registerSession('route-a', 'C_A', makeTransport(), makeServer())

    expect(second).not.toBe(first)
    expect(getSessionByRoute('route-a')).toBe(second)
  })

  test('allows re-registration after the previous session was unregistered', () => {
    registerSession('route-a', 'C_A', makeTransport(), makeServer())
    unregisterSession('route-a')

    // Should not throw
    const entry2 = registerSession('route-a', 'C_A', makeTransport(), makeServer())
    expect(entry2.connected).toBe(true)
  })
})

describe('unregisterSession', () => {
  test('removes a registered session', () => {
    registerSession('route-a', 'C_A', makeTransport(), makeServer())
    unregisterSession('route-a')

    expect(getSessionByRoute('route-a')).toBeUndefined()
  })

  test('is a no-op for unknown route names', () => {
    // Should not throw
    expect(() => unregisterSession('nonexistent')).not.toThrow()
  })
})

describe('getSessionByRoute', () => {
  test('returns the registered entry for a known route', () => {
    registerSession('route-a', 'C_A', makeTransport(), makeServer())

    const found = getSessionByRoute('route-a')
    expect(found).toBeDefined()
    expect(found!.routeName).toBe('route-a')
  })

  test('returns undefined for a nonexistent route', () => {
    expect(getSessionByRoute('no-such-route')).toBeUndefined()
  })
})

describe('getSessionByChannel', () => {
  test('returns entry for a channel that has a configured route', () => {
    const config = makeRoutingConfig({ channelA: 'C_ALPHA', routeA: 'route-alpha' })
    registerSession('route-alpha', 'C_ALPHA', makeTransport(), makeServer())

    const found = getSessionByChannel('C_ALPHA', config)
    expect(found).toBeDefined()
    expect(found!.channelId).toBe('C_ALPHA')
    expect(found!.routeName).toBe('route-alpha')
  })

  test('returns undefined for a channel not in the routing config', () => {
    const config = makeRoutingConfig()

    const found = getSessionByChannel('C_UNKNOWN', config)
    expect(found).toBeUndefined()
  })

  test('returns undefined when route is configured but session is not registered', () => {
    const config = makeRoutingConfig({ channelA: 'C_ALPHA', routeA: 'route-alpha' })
    // Do NOT register a session for route-alpha

    const found = getSessionByChannel('C_ALPHA', config)
    expect(found).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveTransportForRequest Tests
// ---------------------------------------------------------------------------

describe('resolveTransportForRequest', () => {
  function makeRequest(headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/mcp/route-a', { headers })
  }

  test('returns null for init request (no Mcp-Session-Id header)', () => {
    const result = resolveTransportForRequest(makeRequest())
    expect(result).toBeNull()
  })

  test('returns undefined for unknown Mcp-Session-Id', () => {
    const result = resolveTransportForRequest(
      makeRequest({ 'mcp-session-id': 'unknown-uuid' }),
    )
    expect(result).toBeUndefined()
  })

  test('returns SessionEntry for a known Mcp-Session-Id', () => {
    const transport = makeTransport()
    const entry = registerSession('route-a', 'C_A', transport, makeServer())
    registerMcpSessionId('test-uuid-123', 'route-a')

    const result = resolveTransportForRequest(
      makeRequest({ 'mcp-session-id': 'test-uuid-123' }),
    )
    expect(result).toBe(entry)
  })

  test('returns undefined when session is registered but not connected', () => {
    registerSession('route-a', 'C_A', makeTransport(), makeServer())
    registerMcpSessionId('test-uuid-123', 'route-a')

    // Mark the session as disconnected
    const entry = getSessionByRoute('route-a')!
    entry.connected = false

    const result = resolveTransportForRequest(
      makeRequest({ 'mcp-session-id': 'test-uuid-123' }),
    )
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Inbound Routing Tests
// ---------------------------------------------------------------------------

describe('inbound routing — getSessionByChannel', () => {
  test('message to channel A routes to session A', () => {
    const config = makeRoutingConfig({
      channelA: 'C_ALPHA', routeA: 'route-alpha',
      channelB: 'C_BETA',  routeB: 'route-beta',
    })
    const entryA = registerSession('route-alpha', 'C_ALPHA', makeTransport(), makeServer())
    registerSession('route-beta', 'C_BETA', makeTransport(), makeServer())

    const found = getSessionByChannel('C_ALPHA', config)
    expect(found).toBe(entryA)
  })

  test('message to channel B routes to session B', () => {
    const config = makeRoutingConfig({
      channelA: 'C_ALPHA', routeA: 'route-alpha',
      channelB: 'C_BETA',  routeB: 'route-beta',
    })
    registerSession('route-alpha', 'C_ALPHA', makeTransport(), makeServer())
    const entryB = registerSession('route-beta', 'C_BETA', makeTransport(), makeServer())

    const found = getSessionByChannel('C_BETA', config)
    expect(found).toBe(entryB)
  })

  test('unrouted channel returns undefined (no default_route configured)', () => {
    const config = makeRoutingConfig() // no default_route

    const found = getSessionByChannel('C_UNROUTED', config)
    expect(found).toBeUndefined()
  })

  test('channel with no connected session returns undefined', () => {
    const config = makeRoutingConfig({ channelA: 'C_ALPHA', routeA: 'route-alpha' })
    // Session registered but disconnected
    const entry = registerSession('route-alpha', 'C_ALPHA', makeTransport(), makeServer())
    entry.connected = false

    // getSessionByChannel returns the entry regardless of connected state;
    // the caller (handleMessage in server.ts) checks .connected.
    // Test the combined check, mirroring how server.ts uses it:
    const found = getSessionByChannel('C_ALPHA', config)
    const liveSession = found && found.connected ? found : undefined

    expect(liveSession).toBeUndefined()
  })

  test('unrouted channel can fall back to default_route session when looked up by route name', () => {
    // Simulate the default_route fallback pattern used in server.ts handleMessage:
    // if getSessionByChannel returns undefined, try getSessionByRoute(config.default_route)
    const config = makeRoutingConfig({
      channelA: 'C_DEFAULT', routeA: 'default-session',
      channelB: 'C_OTHER',   routeB: 'other-session',
      default_route: 'default-session',
    })
    const defaultEntry = registerSession('default-session', 'C_DEFAULT', makeTransport(), makeServer())

    // C_UNROUTED is not in routes, so getSessionByChannel returns undefined
    const direct = getSessionByChannel('C_UNROUTED', config)
    expect(direct).toBeUndefined()

    // Fallback: look up via default_route
    const fallback = getSessionByRoute(config.default_route!)
    expect(fallback).toBe(defaultEntry)
  })

  test('unrouted channel is dropped when no default_route (fallback lookup returns undefined)', () => {
    const config = makeRoutingConfig() // no default_route

    const direct = getSessionByChannel('C_UNROUTED', config)
    expect(direct).toBeUndefined()

    // No default_route to fall back to
    expect(config.default_route).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Outbound Scoping Tests
// ---------------------------------------------------------------------------

describe('outbound scoping — deliveredChannels', () => {
  test('deliveredChannels is seeded with the session channelId at registration', () => {
    const entry = registerSession('route-a', 'C_A', makeTransport(), makeServer())

    expect(entry.deliveredChannels.has('C_A')).toBe(true)
  })

  test('session can reply to its assigned channel (in deliveredChannels)', () => {
    const entry = registerSession('route-a', 'C_A', makeTransport(), makeServer())

    // C_A was seeded into deliveredChannels on registration
    expect(entry.deliveredChannels.has('C_A')).toBe(true)
  })

  test("session cannot reply to another session's channel (not in deliveredChannels)", () => {
    const entryA = registerSession('route-a', 'C_A', makeTransport(), makeServer())

    // C_B belongs to another session; it should not be in entryA's deliveredChannels
    expect(entryA.deliveredChannels.has('C_B')).toBe(false)
  })

  test('deliveredChannels grows as new messages arrive from additional channels', () => {
    const entry = registerSession('route-a', 'C_A', makeTransport(), makeServer())
    expect(entry.deliveredChannels.size).toBe(1)

    // Simulate inbound message dispatch adding a new channel (as server.ts does)
    entry.deliveredChannels.add('C_NEW')

    expect(entry.deliveredChannels.has('C_NEW')).toBe(true)
    expect(entry.deliveredChannels.size).toBe(2)
  })

  test('two sessions have independent deliveredChannels sets', () => {
    const entryA = registerSession('route-a', 'C_A', makeTransport(), makeServer())
    const entryB = registerSession('route-b', 'C_B', makeTransport(), makeServer())

    entryA.deliveredChannels.add('C_EXTRA')

    expect(entryA.deliveredChannels.has('C_EXTRA')).toBe(true)
    expect(entryB.deliveredChannels.has('C_EXTRA')).toBe(false)
  })
})

describe('assertOutboundAllowed — per-session state', () => {
  // Test the function from lib.ts using per-session deliveredChannels,
  // mirroring how server.ts wires it up.
  test('allows reply to channel in deliveredChannels', async () => {
    const { assertOutboundAllowed } = await import('./lib.ts')
    const { defaultAccess } = await import('./lib.ts')

    const entry = registerSession('route-a', 'C_A', makeTransport(), makeServer())
    const access = defaultAccess()

    // C_A is in deliveredChannels (seeded at registration)
    expect(() => assertOutboundAllowed('C_A', access, entry.deliveredChannels)).not.toThrow()
  })

  test('blocks reply to channel not in deliveredChannels or access channels', async () => {
    const { assertOutboundAllowed } = await import('./lib.ts')
    const { defaultAccess } = await import('./lib.ts')

    const entry = registerSession('route-a', 'C_A', makeTransport(), makeServer())
    const access = defaultAccess()

    expect(() =>
      assertOutboundAllowed('C_FOREIGN', access, entry.deliveredChannels),
    ).toThrow('Outbound gate')
  })

  test('session A cannot reply to session B channel via per-session deliveredChannels', async () => {
    const { assertOutboundAllowed } = await import('./lib.ts')
    const { defaultAccess } = await import('./lib.ts')

    const entryA = registerSession('route-a', 'C_A', makeTransport(), makeServer())
    registerSession('route-b', 'C_B', makeTransport(), makeServer())
    const access = defaultAccess()

    // entryA's deliveredChannels only contains C_A, not C_B
    expect(() =>
      assertOutboundAllowed('C_B', access, entryA.deliveredChannels),
    ).toThrow('Outbound gate')
  })

  test('after delivering a message, session can reply to the new channel', async () => {
    const { assertOutboundAllowed } = await import('./lib.ts')
    const { defaultAccess } = await import('./lib.ts')

    const entry = registerSession('route-a', 'C_A', makeTransport(), makeServer())
    const access = defaultAccess()

    // Simulate inbound message delivery adding C_NEW to this session's set
    entry.deliveredChannels.add('C_NEW')

    expect(() =>
      assertOutboundAllowed('C_NEW', access, entry.deliveredChannels),
    ).not.toThrow()
  })
})
