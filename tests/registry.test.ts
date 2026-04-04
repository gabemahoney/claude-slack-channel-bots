/**
 * registry.test.ts — Tests for session registry and routing (Tasks t2.c1r.zk.6r, t2.c1r.zk.qm, t2.c1r.zk.3d)
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { homedir } from 'os'
import type { RouteEntry, RoutingConfig } from '../src/config.ts'
import {
  registerSession,
  unregisterSession,
  getSessionByCwd,
  getSessionByChannel,
  registerMcpSessionId,
  resolveTransportForRequest,
  createPendingSession,
  getPendingSession,
  removePendingSession,
  getAllPendingSessions,
  createSessionServer,
  _resetRegistry,
  type SessionEntry,
  type PendingSessionEntry,
  type SessionToolDeps,
} from '../src/registry.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { trackAck, consumeAck, _resetAckTracker } from '../src/ack-tracker.ts'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a minimal RouteEntry fixture. */
function makeRoute(cwd = '/tmp'): RouteEntry {
  return { cwd }
}

/** Creates a RoutingConfig with two test routes. */
function makeRoutingConfig(opts: {
  channelA?: string
  cwdA?: string
  channelB?: string
  cwdB?: string
  default_route?: string
} = {}): RoutingConfig {
  const channelA = opts.channelA ?? 'C_ALPHA'
  const cwdA     = opts.cwdA     ?? '/tmp/alpha'
  const channelB = opts.channelB ?? 'C_BETA'
  const cwdB     = opts.cwdB     ?? '/tmp/beta'

  const config: RoutingConfig = {
    routes: {
      [channelA]: makeRoute(cwdA),
      [channelB]: makeRoute(cwdB),
    },
    bind: '127.0.0.1',
    port: 3100,
    session_restart_delay: 60,
    health_check_interval: 120,
    mcp_config_path: `${homedir()}/.claude/slack-mcp.json`,
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

/**
 * WebClient stub that captures reactions.remove and chat.postMessage calls.
 * Returns capture arrays alongside the stub so tests can assert on them.
 */
function makeWebClient() {
  const postMessageCalls: any[] = []
  const reactionsRemoveCalls: any[] = []

  const web: any = {
    chat: {
      postMessage: async (args: any) => {
        postMessageCalls.push(args)
        return { ok: true, ts: '111.222' }
      },
      update: async () => ({ ok: true }),
    },
    reactions: {
      remove: async (args: any) => {
        reactionsRemoveCalls.push(args)
        return { ok: true }
      },
      add: async () => ({ ok: true }),
    },
    conversations: {
      replies: async () => ({ messages: [] }),
      history: async () => ({ messages: [] }),
    },
    filesUploadV2: async () => ({ ok: true }),
  }

  return { web, postMessageCalls, reactionsRemoveCalls }
}

/** Build a SessionToolDeps fixture with sensible test defaults. */
function makeDeps(web: any, overrides: Partial<SessionToolDeps> = {}): SessionToolDeps {
  return {
    assertOutboundAllowed: () => {},
    assertSendable: () => {},
    getAccess: () => ({
      dmPolicy: 'pairing' as const,
      allowFrom: [],
      channels: {},
      pending: {},
      ackReaction: 'eyes',
    }),
    web,
    botToken: 'xoxb-test',
    inboxDir: '/tmp',
    resolveUserName: async (userId: string) => userId,
    consumeAck,
    serverPort: 0,
    ...overrides,
  }
}

/** Connect a server to an in-memory client, run fn, then close the client. */
async function withClient(server: any, fn: (client: Client) => Promise<void>): Promise<void> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })
  await client.connect(clientTransport)
  try {
    await fn(client)
  } finally {
    await client.close()
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
    const entry = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())

    expect(entry.cwd).toBe('/tmp/a')
    expect(entry.channelId).toBe('C_A')
    expect(entry.connected).toBe(true)
  })

  test('seeds deliveredChannels with the assigned channelId', () => {
    const entry = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())

    expect(entry.deliveredChannels.has('C_A')).toBe(true)
    expect(entry.deliveredChannels.size).toBe(1)
  })

  test('replaces an existing session when re-registering for the same route', () => {
    const first = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    const second = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())

    expect(second).not.toBe(first)
    expect(getSessionByCwd('/tmp/a')).toBe(second)
  })

  test('allows re-registration after the previous session was unregistered', () => {
    registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    unregisterSession('/tmp/a')

    // Should not throw
    const entry2 = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    expect(entry2.connected).toBe(true)
  })
})

describe('unregisterSession', () => {
  test('removes a registered session', () => {
    registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    unregisterSession('/tmp/a')

    expect(getSessionByCwd('/tmp/a')).toBeUndefined()
  })

  test('is a no-op for unknown route names', () => {
    // Should not throw
    expect(() => unregisterSession('nonexistent')).not.toThrow()
  })
})

describe('getSessionByCwd', () => {
  test('returns the registered entry for a known route', () => {
    registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())

    const found = getSessionByCwd('/tmp/a')
    expect(found).toBeDefined()
    expect(found!.cwd).toBe('/tmp/a')
  })

  test('returns undefined for a nonexistent route', () => {
    expect(getSessionByCwd('no-such-route')).toBeUndefined()
  })
})

describe('getSessionByChannel', () => {
  test('returns entry for a channel that has a configured route', () => {
    const config = makeRoutingConfig({ channelA: 'C_ALPHA', cwdA: '/tmp/alpha' })
    registerSession('/tmp/alpha', 'C_ALPHA', makeTransport(), makeServer())

    const found = getSessionByChannel('C_ALPHA', config)
    expect(found).toBeDefined()
    expect(found!.channelId).toBe('C_ALPHA')
    expect(found!.cwd).toBe('/tmp/alpha')
  })

  test('returns undefined for a channel not in the routing config', () => {
    const config = makeRoutingConfig()

    const found = getSessionByChannel('C_UNKNOWN', config)
    expect(found).toBeUndefined()
  })

  test('returns undefined when route is configured but session is not registered', () => {
    const config = makeRoutingConfig({ channelA: 'C_ALPHA', cwdA: '/tmp/alpha' })
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
    const entry = registerSession('/tmp/a', 'C_A', transport, makeServer())
    registerMcpSessionId('test-uuid-123', '/tmp/a')

    const result = resolveTransportForRequest(
      makeRequest({ 'mcp-session-id': 'test-uuid-123' }),
    )
    expect(result).toBe(entry)
  })

  test('returns undefined when session is registered but not connected', () => {
    registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    registerMcpSessionId('test-uuid-123', '/tmp/a')

    // Mark the session as disconnected
    const entry = getSessionByCwd('/tmp/a')!
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
      channelA: 'C_ALPHA', cwdA: '/tmp/alpha',
      channelB: 'C_BETA',  cwdB: '/tmp/beta',
    })
    const entryA = registerSession('/tmp/alpha', 'C_ALPHA', makeTransport(), makeServer())
    registerSession('/tmp/beta', 'C_BETA', makeTransport(), makeServer())

    const found = getSessionByChannel('C_ALPHA', config)
    expect(found).toBe(entryA)
  })

  test('message to channel B routes to session B', () => {
    const config = makeRoutingConfig({
      channelA: 'C_ALPHA', cwdA: '/tmp/alpha',
      channelB: 'C_BETA',  cwdB: '/tmp/beta',
    })
    registerSession('/tmp/alpha', 'C_ALPHA', makeTransport(), makeServer())
    const entryB = registerSession('/tmp/beta', 'C_BETA', makeTransport(), makeServer())

    const found = getSessionByChannel('C_BETA', config)
    expect(found).toBe(entryB)
  })

  test('unrouted channel returns undefined (no default_route configured)', () => {
    const config = makeRoutingConfig() // no default_route

    const found = getSessionByChannel('C_UNROUTED', config)
    expect(found).toBeUndefined()
  })

  test('channel with no connected session returns undefined', () => {
    const config = makeRoutingConfig({ channelA: 'C_ALPHA', cwdA: '/tmp/alpha' })
    // Session registered but disconnected
    const entry = registerSession('/tmp/alpha', 'C_ALPHA', makeTransport(), makeServer())
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
    // if getSessionByChannel returns undefined, try getSessionByCwd(config.default_route)
    const config = makeRoutingConfig({
      channelA: 'C_DEFAULT', cwdA: '/tmp/default',
      channelB: 'C_OTHER',   cwdB: '/tmp/other',
      default_route: '/tmp/default',
    })
    const defaultEntry = registerSession('/tmp/default', 'C_DEFAULT', makeTransport(), makeServer())

    // C_UNROUTED is not in routes, so getSessionByChannel returns undefined
    const direct = getSessionByChannel('C_UNROUTED', config)
    expect(direct).toBeUndefined()

    // Fallback: look up via default_route
    const fallback = getSessionByCwd(config.default_route!)
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
    const entry = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())

    expect(entry.deliveredChannels.has('C_A')).toBe(true)
  })

  test('session can reply to its assigned channel (in deliveredChannels)', () => {
    const entry = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())

    // C_A was seeded into deliveredChannels on registration
    expect(entry.deliveredChannels.has('C_A')).toBe(true)
  })

  test("session cannot reply to another session's channel (not in deliveredChannels)", () => {
    const entryA = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())

    // C_B belongs to another session; it should not be in entryA's deliveredChannels
    expect(entryA.deliveredChannels.has('C_B')).toBe(false)
  })

  test('deliveredChannels grows as new messages arrive from additional channels', () => {
    const entry = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    expect(entry.deliveredChannels.size).toBe(1)

    // Simulate inbound message dispatch adding a new channel (as server.ts does)
    entry.deliveredChannels.add('C_NEW')

    expect(entry.deliveredChannels.has('C_NEW')).toBe(true)
    expect(entry.deliveredChannels.size).toBe(2)
  })

  test('two sessions have independent deliveredChannels sets', () => {
    const entryA = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    const entryB = registerSession('/tmp/b', 'C_B', makeTransport(), makeServer())

    entryA.deliveredChannels.add('C_EXTRA')

    expect(entryA.deliveredChannels.has('C_EXTRA')).toBe(true)
    expect(entryB.deliveredChannels.has('C_EXTRA')).toBe(false)
  })
})

describe('assertOutboundAllowed — per-session state', () => {
  // Test the function from lib.ts using per-session deliveredChannels,
  // mirroring how server.ts wires it up.
  test('allows reply to channel in deliveredChannels', async () => {
    const { assertOutboundAllowed } = await import('../src/lib.ts')
    const { defaultAccess } = await import('../src/lib.ts')

    const entry = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    const access = defaultAccess()

    // C_A is in deliveredChannels (seeded at registration)
    expect(() => assertOutboundAllowed('C_A', access, entry.deliveredChannels)).not.toThrow()
  })

  test('blocks reply to channel not in deliveredChannels or access channels', async () => {
    const { assertOutboundAllowed } = await import('../src/lib.ts')
    const { defaultAccess } = await import('../src/lib.ts')

    const entry = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    const access = defaultAccess()

    expect(() =>
      assertOutboundAllowed('C_FOREIGN', access, entry.deliveredChannels),
    ).toThrow('Outbound gate')
  })

  test('session A cannot reply to session B channel via per-session deliveredChannels', async () => {
    const { assertOutboundAllowed } = await import('../src/lib.ts')
    const { defaultAccess } = await import('../src/lib.ts')

    const entryA = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    registerSession('/tmp/b', 'C_B', makeTransport(), makeServer())
    const access = defaultAccess()

    // entryA's deliveredChannels only contains C_A, not C_B
    expect(() =>
      assertOutboundAllowed('C_B', access, entryA.deliveredChannels),
    ).toThrow('Outbound gate')
  })

  test('after delivering a message, session can reply to the new channel', async () => {
    const { assertOutboundAllowed } = await import('../src/lib.ts')
    const { defaultAccess } = await import('../src/lib.ts')

    const entry = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    const access = defaultAccess()

    // Simulate inbound message delivery adding C_NEW to this session's set
    entry.deliveredChannels.add('C_NEW')

    expect(() =>
      assertOutboundAllowed('C_NEW', access, entry.deliveredChannels),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Pending Session Tests (Task t3.256.pw.ro.uw)
// ---------------------------------------------------------------------------

describe('createPendingSession / getPendingSession / removePendingSession / getAllPendingSessions', () => {
  test('createPendingSession stores and returns a PendingSessionEntry', () => {
    const transport = makeTransport()
    const server = makeServer()
    const delivered = new Set<string>()

    const entry = createPendingSession('pending-id-1', transport, server, delivered)

    expect(entry.pendingId).toBe('pending-id-1')
    expect(entry.transport).toBe(transport)
    expect(entry.server).toBe(server)
    expect(entry.deliveredChannels).toBe(delivered)
    expect(typeof entry.createdAt).toBe('number')
  })

  test('getPendingSession returns the stored entry by ID', () => {
    const entry = createPendingSession('pid-2', makeTransport(), makeServer(), new Set())

    const found = getPendingSession('pid-2')
    expect(found).toBe(entry)
  })

  test('getPendingSession returns undefined for unknown ID', () => {
    expect(getPendingSession('no-such-id')).toBeUndefined()
  })

  test('removePendingSession removes the entry', () => {
    createPendingSession('pid-3', makeTransport(), makeServer(), new Set())
    removePendingSession('pid-3')

    expect(getPendingSession('pid-3')).toBeUndefined()
  })

  test('removePendingSession is a no-op for unknown IDs', () => {
    expect(() => removePendingSession('nonexistent')).not.toThrow()
  })

  test('getAllPendingSessions returns all pending entries', () => {
    createPendingSession('pid-a', makeTransport(), makeServer(), new Set())
    createPendingSession('pid-b', makeTransport(), makeServer(), new Set())

    const all = getAllPendingSessions()
    const ids = all.map((e) => e.pendingId).sort()
    expect(ids).toEqual(['pid-a', 'pid-b'])
  })

  test('getAllPendingSessions returns empty array when no pending sessions', () => {
    expect(getAllPendingSessions()).toEqual([])
  })

  test('_resetRegistry clears pending sessions', () => {
    createPendingSession('pid-reset', makeTransport(), makeServer(), new Set())
    expect(getAllPendingSessions()).toHaveLength(1)

    _resetRegistry()

    expect(getAllPendingSessions()).toHaveLength(0)
  })
})

describe('registerSession — promotion path (pending → registered)', () => {
  test('promotes a pending session to registered using pendingId', () => {
    const transport = makeTransport()
    const server = makeServer()
    const delivered = new Set<string>()

    createPendingSession('prom-id-1', transport, server, delivered)

    const entry = registerSession('/tmp/x', 'C_X', 'prom-id-1')

    expect(entry.cwd).toBe('/tmp/x')
    expect(entry.channelId).toBe('C_X')
    expect(entry.transport).toBe(transport)
    expect(entry.connected).toBe(true)
  })

  test('promotion seeds deliveredChannels with the channelId', () => {
    const delivered = new Set<string>()
    createPendingSession('prom-id-2', makeTransport(), makeServer(), delivered)

    const entry = registerSession('/tmp/y', 'C_Y', 'prom-id-2')

    expect(entry.deliveredChannels.has('C_Y')).toBe(true)
  })

  test('promotion shares the deliveredChannels set by reference', () => {
    const delivered = new Set<string>()
    createPendingSession('prom-id-3', makeTransport(), makeServer(), delivered)

    const entry = registerSession('/tmp/z', 'C_Z', 'prom-id-3')

    // Both references should be the same Set object
    expect(entry.deliveredChannels).toBe(delivered)
  })

  test('promotion removes the pending entry', () => {
    createPendingSession('prom-id-4', makeTransport(), makeServer(), new Set())
    registerSession('/tmp/w', 'C_W', 'prom-id-4')

    expect(getPendingSession('prom-id-4')).toBeUndefined()
  })

  test('promotion throws if pendingId not found', () => {
    expect(() => registerSession('/tmp/bad', 'C_BAD', 'nonexistent-pending-id')).toThrow()
  })
})

describe('resolveTransportForRequest — pending session path', () => {
  function makeRequest(headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/mcp', { headers })
  }

  test('returns PendingSessionEntry for a pending Mcp-Session-Id', () => {
    const transport = makeTransport()
    const pending = createPendingSession('pend-uuid-1', transport, makeServer(), new Set())

    const result = resolveTransportForRequest(makeRequest({ 'mcp-session-id': 'pend-uuid-1' }))
    expect(result).toBe(pending)
  })

  test('returns undefined for a Mcp-Session-Id that is neither registered nor pending', () => {
    const result = resolveTransportForRequest(makeRequest({ 'mcp-session-id': 'totally-unknown' }))
    expect(result).toBeUndefined()
  })

  test('returns registered SessionEntry (not pending) after promotion', () => {
    const transport = makeTransport()
    createPendingSession('pend-uuid-2', transport, makeServer(), new Set())

    // Promote to registered and map the MCP session ID
    const entry = registerSession('/tmp/promoted', 'C_P', 'pend-uuid-2')
    registerMcpSessionId('pend-uuid-2', '/tmp/promoted')

    // Should now resolve to the SessionEntry, not the PendingSessionEntry
    const result = resolveTransportForRequest(makeRequest({ 'mcp-session-id': 'pend-uuid-2' }))
    expect(result).toBe(entry)
  })
})

// ---------------------------------------------------------------------------
// Ack Reaction Removal Tests (Task t3.xrm.9d.n1.3c)
// ---------------------------------------------------------------------------

describe('reply tool — ack reaction removal', () => {
  const TEST_CHANNEL = 'C_TEST'
  const TEST_CWD = '/tmp/test-ack'
  const TEST_MSG_TS = '1000000.111111'

  beforeEach(() => {
    _resetAckTracker()
  })

  test('ackReaction configured + reply with message_id → reactions.remove called with correct params', async () => {
    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    const { web, reactionsRemoveCalls } = makeWebClient()
    const server = createSessionServer(entry, makeDeps(web))

    trackAck(TEST_CHANNEL, TEST_MSG_TS)

    await withClient(server, async (client) => {
      await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'hi', message_id: TEST_MSG_TS } })
    })

    expect(reactionsRemoveCalls).toHaveLength(1)
    expect(reactionsRemoveCalls[0]).toEqual({
      channel: TEST_CHANNEL,
      timestamp: TEST_MSG_TS,
      name: 'eyes',
    })
  })

  test('second reply with same message_id → no second reactions.remove call', async () => {
    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    const { web, reactionsRemoveCalls } = makeWebClient()
    const server = createSessionServer(entry, makeDeps(web))

    trackAck(TEST_CHANNEL, TEST_MSG_TS)

    await withClient(server, async (client) => {
      await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'first', message_id: TEST_MSG_TS } })
      await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'second', message_id: TEST_MSG_TS } })
    })

    expect(reactionsRemoveCalls).toHaveLength(1)
  })

  test('reactions.remove throws → reply still succeeds', async () => {
    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    const { web } = makeWebClient()
    web.reactions.remove = async () => { throw new Error('reaction_not_found') }
    const server = createSessionServer(entry, makeDeps(web))

    trackAck(TEST_CHANNEL, TEST_MSG_TS)

    let result: any
    await withClient(server, async (client) => {
      result = await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'hi', message_id: TEST_MSG_TS } })
    })

    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('Sent')
  })

  test('ackReaction not configured → no reactions.remove call', async () => {
    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    const { web, reactionsRemoveCalls } = makeWebClient()
    // Access without ackReaction — server.ts only calls trackAck when ackReaction is set,
    // so consumeAck will return false and reactions.remove will never be called.
    const server = createSessionServer(entry, makeDeps(web, {
      getAccess: () => ({ dmPolicy: 'pairing' as const, allowFrom: [], channels: {}, pending: {} }),
    }))

    // No trackAck call — simulates server.ts skipping ack tracking when no ackReaction

    await withClient(server, async (client) => {
      await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'hi', message_id: TEST_MSG_TS } })
    })

    expect(reactionsRemoveCalls).toHaveLength(0)
  })

  test('reply without message_id → no reactions.remove call', async () => {
    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    const { web, reactionsRemoveCalls } = makeWebClient()
    const server = createSessionServer(entry, makeDeps(web))

    trackAck(TEST_CHANNEL, TEST_MSG_TS)

    await withClient(server, async (client) => {
      await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'hi' } })
    })

    expect(reactionsRemoveCalls).toHaveLength(0)
  })
})
