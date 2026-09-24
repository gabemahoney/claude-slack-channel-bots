/**
 * registry.test.ts — Tests for session registry and routing (Tasks t2.c1r.zk.6r, t2.c1r.zk.qm, t2.c1r.zk.3d)
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { homedir, tmpdir } from 'os'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
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
  isSlackHostedFileUrl,
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
    exit_timeout: 120,
    stop_timeout: 30,
    mcp_config_path: `${homedir()}/.claude/slack-mcp.json`,
    cron_table_path: `${homedir()}/.claude/channels/slack/crontab`,
    cron_log_path: `${homedir()}/.claude/channels/slack/cron.log`,
    cozempic_prescription: 'standard',
    system_prompt_mode: 'append',
    resume_enabled: true,
    stop_hook_bootstrap: true,
    agent_director_poll_interval_ms: 1000,
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

/** One stubbed `fetch` call: its URL, `Authorization` header and `redirect` mode. */
interface FetchCall {
  url: string
  auth: string | null
  redirect: RequestRedirect | undefined
}

const realFetch = globalThis.fetch

/** Every `fetch` call made during the test (the global `fetch` is stubbed for every test). */
let fetches: FetchCall[] = []
/** Answers each stubbed `fetch`; throws by default, so no test can reach the network. */
let fetchHandler: (url: string) => Response | Promise<Response>

// ---------------------------------------------------------------------------
// Reset registry state and stub the global fetch before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRegistry()
  fetches = []
  fetchHandler = () => {
    throw new Error('unexpected fetch in registry.test.ts')
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    fetches.push({ url, auth: new Headers(init?.headers).get('Authorization'), redirect: init?.redirect })
    return fetchHandler(url)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
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
    unregisterSession('C_A')

    // Should not throw
    const entry2 = registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    expect(entry2.connected).toBe(true)
  })
})

describe('unregisterSession', () => {
  test('removes a registered session', () => {
    registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    unregisterSession('C_A')

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
    registerSession('/tmp/alpha', 'C_ALPHA', makeTransport(), makeServer())

    const found = getSessionByChannel('C_ALPHA')
    expect(found).toBeDefined()
    expect(found!.channelId).toBe('C_ALPHA')
    expect(found!.cwd).toBe('/tmp/alpha')
  })

  test('returns undefined for a channel not in the routing config', () => {
    const found = getSessionByChannel('C_UNKNOWN')
    expect(found).toBeUndefined()
  })

  test('returns undefined when route is configured but session is not registered', () => {
    // Do NOT register a session for C_ALPHA
    const found = getSessionByChannel('C_ALPHA')
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
    registerMcpSessionId('test-uuid-123', 'C_A')

    const result = resolveTransportForRequest(
      makeRequest({ 'mcp-session-id': 'test-uuid-123' }),
    )
    expect(result).toBe(entry)
  })

  test('returns undefined when session is registered but not connected', () => {
    registerSession('/tmp/a', 'C_A', makeTransport(), makeServer())
    registerMcpSessionId('test-uuid-123', 'C_A')

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
    const entryA = registerSession('/tmp/alpha', 'C_ALPHA', makeTransport(), makeServer())
    registerSession('/tmp/beta', 'C_BETA', makeTransport(), makeServer())

    const found = getSessionByChannel('C_ALPHA')
    expect(found).toBe(entryA)
  })

  test('message to channel B routes to session B', () => {
    registerSession('/tmp/alpha', 'C_ALPHA', makeTransport(), makeServer())
    const entryB = registerSession('/tmp/beta', 'C_BETA', makeTransport(), makeServer())

    const found = getSessionByChannel('C_BETA')
    expect(found).toBe(entryB)
  })

  test('unrouted channel returns undefined (no default_route configured)', () => {
    const found = getSessionByChannel('C_UNROUTED')
    expect(found).toBeUndefined()
  })

  test('channel with no connected session returns undefined', () => {
    // Session registered but disconnected
    const entry = registerSession('/tmp/alpha', 'C_ALPHA', makeTransport(), makeServer())
    entry.connected = false

    // getSessionByChannel returns the entry regardless of connected state;
    // the caller (handleMessage in server.ts) checks .connected.
    // Test the combined check, mirroring how server.ts uses it:
    const found = getSessionByChannel('C_ALPHA')
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
    const direct = getSessionByChannel('C_UNROUTED')
    expect(direct).toBeUndefined()

    // Fallback: look up via default_route
    const fallback = getSessionByCwd(config.default_route!)
    expect(fallback).toBe(defaultEntry)
  })

  test('unrouted channel is dropped when no default_route (fallback lookup returns undefined)', () => {
    const config = makeRoutingConfig() // no default_route

    const direct = getSessionByChannel('C_UNROUTED')
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

  test('stub-less promotion: creates a fresh SessionEntry when no stub was provided', () => {
    const transport = makeTransport()
    const server = makeServer()
    const delivered = new Set<string>()

    // createPendingSession called WITHOUT a stub — exercises the else branch in registerSession
    createPendingSession('stubless-id', transport, server, delivered)

    const entry = registerSession('/tmp/stubless', 'C_SL', 'stubless-id')

    // A new object must be returned (not undefined)
    expect(entry).toBeDefined()
    expect(entry.cwd).toBe('/tmp/stubless')
    expect(entry.channelId).toBe('C_SL')
    expect(entry.transport).toBe(transport)
    expect(entry.server).toBe(server)
    expect(entry.connected).toBe(true)
    expect(entry.peerPort).toBe(0)

    // deliveredChannels seeded with channelId on promotion
    expect(entry.deliveredChannels.has('C_SL')).toBe(true)

    // Pending entry must be cleaned up after promotion
    expect(getPendingSession('stubless-id')).toBeUndefined()
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
    registerMcpSessionId('pend-uuid-2', 'C_P')

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

// ---------------------------------------------------------------------------
// Dry-Run Mode Tests
// ---------------------------------------------------------------------------

describe('dry-run mode', () => {
  const DRY_CWD = '/tmp/dry-run-test'
  const DRY_CHANNEL = 'C_DRY'
  const DRY_MSG_TS = '9999999.000001'

  let savedDryRunEnv: string | undefined

  beforeEach(() => {
    savedDryRunEnv = process.env['SLACK_DRY_RUN']
    process.env['SLACK_DRY_RUN'] = '1'
  })

  afterEach(() => {
    if (savedDryRunEnv === undefined) {
      delete process.env['SLACK_DRY_RUN']
    } else {
      process.env['SLACK_DRY_RUN'] = savedDryRunEnv
    }
  })

  /**
   * WebClient spy that tracks ALL method calls across every sub-namespace.
   * If any Slack API method is called, apiCalls will be non-empty.
   */
  function makeSpyWebClient() {
    const apiCalls: { method: string; args: any }[] = []

    const spy = (method: string) => async (args: any) => {
      apiCalls.push({ method, args })
      return { ok: true, ts: '111.222', messages: [] }
    }

    const web: any = {
      chat: {
        postMessage: spy('chat.postMessage'),
        update: spy('chat.update'),
      },
      reactions: {
        add: spy('reactions.add'),
        remove: spy('reactions.remove'),
      },
      conversations: {
        replies: spy('conversations.replies'),
        history: spy('conversations.history'),
      },
      filesUploadV2: spy('files.uploadV2'),
    }

    return { web, apiCalls }
  }

  test('reply — skips Slack API and returns dry-run response', async () => {
    const entry = registerSession(DRY_CWD, DRY_CHANNEL, makeTransport(), makeServer())
    const { web, apiCalls } = makeSpyWebClient()
    const server = createSessionServer(entry, makeDeps(web))

    let result: any
    await withClient(server, async (client) => {
      result = await client.callTool({ name: 'reply', arguments: { chat_id: DRY_CHANNEL, text: 'hello' } })
    })

    expect(apiCalls).toHaveLength(0)
    expect(result.content[0].text).toContain('[dry-run]')
    expect(result.isError).toBeFalsy()
  })

  test('react — skips Slack API and returns dry-run response', async () => {
    const entry = registerSession(DRY_CWD, DRY_CHANNEL, makeTransport(), makeServer())
    const { web, apiCalls } = makeSpyWebClient()
    const server = createSessionServer(entry, makeDeps(web))

    let result: any
    await withClient(server, async (client) => {
      result = await client.callTool({ name: 'react', arguments: { chat_id: DRY_CHANNEL, message_id: DRY_MSG_TS, emoji: 'thumbsup' } })
    })

    expect(apiCalls).toHaveLength(0)
    expect(result.content[0].text).toContain('[dry-run]')
    expect(result.isError).toBeFalsy()
  })

  test('edit_message — skips Slack API and returns dry-run response', async () => {
    const entry = registerSession(DRY_CWD, DRY_CHANNEL, makeTransport(), makeServer())
    const { web, apiCalls } = makeSpyWebClient()
    const server = createSessionServer(entry, makeDeps(web))

    let result: any
    await withClient(server, async (client) => {
      result = await client.callTool({ name: 'edit_message', arguments: { chat_id: DRY_CHANNEL, message_id: DRY_MSG_TS, text: 'edited' } })
    })

    expect(apiCalls).toHaveLength(0)
    expect(result.content[0].text).toContain('[dry-run]')
    expect(result.isError).toBeFalsy()
  })

  test('fetch_messages — skips Slack API and returns dry-run response', async () => {
    const entry = registerSession(DRY_CWD, DRY_CHANNEL, makeTransport(), makeServer())
    const { web, apiCalls } = makeSpyWebClient()
    const server = createSessionServer(entry, makeDeps(web))

    let result: any
    await withClient(server, async (client) => {
      result = await client.callTool({ name: 'fetch_messages', arguments: { channel: DRY_CHANNEL } })
    })

    expect(apiCalls).toHaveLength(0)
    expect(result.content[0].text).toContain('[dry-run]')
    expect(result.isError).toBeFalsy()
  })

  test('download_attachment — skips Slack API and returns dry-run response', async () => {
    const entry = registerSession(DRY_CWD, DRY_CHANNEL, makeTransport(), makeServer())
    const { web, apiCalls } = makeSpyWebClient()
    const server = createSessionServer(entry, makeDeps(web))

    let result: any
    await withClient(server, async (client) => {
      result = await client.callTool({ name: 'download_attachment', arguments: { chat_id: DRY_CHANNEL, message_id: DRY_MSG_TS } })
    })

    expect(apiCalls).toHaveLength(0)
    expect(result.content[0].text).toContain('[dry-run]')
    expect(result.isError).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// download_attachment: the bearer token goes only to https://files.slack.com (b.2u6)
// ---------------------------------------------------------------------------

describe('isSlackHostedFileUrl', () => {
  test.each<[string, unknown, boolean]>([
    ['an https files.slack.com URL', 'https://files.slack.com/files-pri/T0-F0/a.txt', true],
    ['one with a query string', 'https://files.slack.com/files-pri/T0-F0/a.txt?pub_secret=x', true],
    ['an upper-case host', 'https://FILES.SLACK.COM/a.txt', true],
    ['the explicit default port', 'https://files.slack.com:443/a.txt', true],
    ['http:', 'http://files.slack.com/a.txt', false],
    ['a lookalike host (suffix)', 'https://files.slack.com.evil.example/a.txt', false],
    ['a lookalike host (prefix)', 'https://evilfiles.slack.com/a.txt', false],
    ['another Slack host', 'https://slack.com/a.txt', false],
    ['a third-party host naming files.slack.com in its path', 'https://evil.example/files.slack.com/a.txt', false],
    ['a non-default port', 'https://files.slack.com:8443/a.txt', false],
    ['userinfo (user and password)', 'https://u:p@files.slack.com/a.txt', false],
    ['userinfo (user only)', 'https://u@files.slack.com/a.txt', false],
    ['no scheme (unparseable)', 'files.slack.com/a.txt', false],
    ['free text (unparseable)', 'not a url', false],
    ['an empty string', '', false],
    ['undefined', undefined, false],
    ['null', null, false],
    ['a number', 42, false],
    ['a URL object', new URL('https://files.slack.com/a.txt'), false],
  ])('%s → %p', (_label, url, expected) => {
    expect(isSlackHostedFileUrl(url)).toBe(expected)
  })
})

describe('download_attachment', () => {
  const FILES = 'https://files.slack.com'
  const BOT_TOKEN = 'xoxb-test-token'
  const DL_CHANNEL = 'C_DL'
  const MSG_TS = '1700000000.000100'
  /** A query string on every fixture URL; a refusal must never echo it. */
  const QUERY = '?pub_secret=fake-secret'
  const OFFSITE = 'redirected away from https://files.slack.com, so it is not hosted by Slack'

  let inboxDir: string

  beforeEach(() => {
    inboxDir = mkdtempSync(join(tmpdir(), 'registry-download-'))
  })

  afterEach(() => {
    rmSync(inboxDir, { recursive: true, force: true })
  })

  const outPath = (name: string) => join(inboxDir, `1700000000_000100_${name}`)
  const slackFile = (id: string, name: string) => ({ id, name, url_private_download: `${FILES}/files-pri/T0-${id}/${name}${QUERY}` })
  const redirect = (location?: string) => new Response(null, { status: 302, headers: location ? { Location: location } : {} })
  const notHosted = (label: string) =>
    `Tool "download_attachment" refused: file ${label} is not hosted by Slack, so the bot token is not sent for it (only https://files.slack.com is trusted).`
  const redirectRefusal = (label: string, why: string) =>
    `Tool "download_attachment" refused: file ${label} ${why}; the bot token is only sent to https://files.slack.com.`

  /** Serve `files` on the message and call download_attachment on a fresh session. */
  async function download(files: Array<Record<string, unknown>>): Promise<any> {
    const entry = registerSession('/tmp/download-test', DL_CHANNEL, makeTransport(), makeServer())
    const { web } = makeWebClient()
    web.conversations.replies = async () => ({ messages: [{ ts: MSG_TS, files }] })
    const server = createSessionServer(entry, makeDeps(web, { botToken: BOT_TOKEN, inboxDir }))
    let result: any
    await withClient(server, async (client) => {
      result = await client.callTool({ name: 'download_attachment', arguments: { chat_id: DL_CHANNEL, message_id: MSG_TS } })
    })
    return result
  }

  /** Every fetch went to https://files.slack.com with the bearer token and manual redirects. */
  function expectTokenOnlySentToSlackFiles() {
    for (const f of fetches) {
      expect(new URL(f.url).origin).toBe(FILES)
      expect(f.auth).toBe(`Bearer ${BOT_TOKEN}`)
      expect(f.redirect).toBe('manual')
    }
  }

  test('sends the bot token as the bearer to files.slack.com with manual redirects and writes into the inbox', async () => {
    fetchHandler = () => new Response('file-body')

    const result = await download([slackFile('F0FILE001', 'report.txt')])

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe(`Downloaded 1 file(s):\n${outPath('report.txt')}`)
    expect(fetches.map((f) => f.url)).toEqual([`${FILES}/files-pri/T0-F0FILE001/report.txt${QUERY}`])
    expectTokenOnlySentToSlackFiles()
    expect(readFileSync(outPath('report.txt'), 'utf-8')).toBe('file-body')
    expect(readdirSync(inboxDir)).toEqual(['1700000000_000100_report.txt'])
  })

  test.each<[string, Array<Record<string, unknown>>, string]>([
    ['an is_external file on a files.slack.com URL', [{ ...slackFile('F0EXT0001', 'e.txt'), is_external: true }], 'F0EXT0001'],
    ["a mode: 'external' file on a files.slack.com URL", [{ ...slackFile('F0EXT0002', 'e.txt'), mode: 'external' }], 'F0EXT0002'],
    ['an external file with no URL', [{ id: 'F0EXT0003', name: 'e.txt', is_external: true }], 'F0EXT0003'],
    ['a third-party url_private', [{ id: 'F0EXT0004', name: 'x.txt', url_private: `https://example.com/x.txt${QUERY}` }], 'F0EXT0004'],
    [
      'a third-party URL (malformed file ID → labelled by position)',
      [{ id: 'not/an id', name: 'x.txt', url_private_download: `https://example.com/x.txt${QUERY}` }],
      '#1',
    ],
    [
      'a Slack-hosted file followed by a lookalike-host url_private',
      [slackFile('F0FILE001', 'a.txt'), { name: 'b.txt', url_private: `https://files.slack.com.evil.example/b.txt${QUERY}` }],
      '#2',
    ],
  ])('%s → the whole call is refused before any fetch', async (_label, files, label) => {
    fetchHandler = () => new Response('file-body')

    const result = await download(files)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(notHosted(label))
    expect(fetches).toEqual([])
    expect(readdirSync(inboxDir)).toEqual([])
  })

  test('a same-origin redirect is followed with the token and the file is downloaded', async () => {
    fetchHandler = (url) =>
      url.includes('/download/') ? new Response('file-body') : redirect('/files-pri/T0-F0FILE001/download/report.txt')

    const result = await download([slackFile('F0FILE001', 'report.txt')])

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe(`Downloaded 1 file(s):\n${outPath('report.txt')}`)
    expect(fetches.map((f) => f.url)).toEqual([
      `${FILES}/files-pri/T0-F0FILE001/report.txt${QUERY}`,
      `${FILES}/files-pri/T0-F0FILE001/download/report.txt`,
    ])
    expectTokenOnlySentToSlackFiles()
    expect(readFileSync(outPath('report.txt'), 'utf-8')).toBe('file-body')
  })

  test.each([
    ['another host', 'https://evil.example/report.txt'],
    ['a lookalike host', 'https://files.slack.com.evil.example/report.txt'],
    ['http: on the Slack host', 'http://files.slack.com/report.txt'],
    ['a non-default port on the Slack host', 'https://files.slack.com:8443/report.txt'],
    ['a protocol-relative URL on another host', '//evil.example/x'],
  ])('a redirect to %s is refused and never fetched', async (_label, location) => {
    fetchHandler = () => redirect(location)

    const result = await download([slackFile('F0FILE001', 'report.txt')])

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(redirectRefusal('F0FILE001', OFFSITE))
    expect(fetches.map((f) => f.url)).toEqual([`${FILES}/files-pri/T0-F0FILE001/report.txt${QUERY}`])
    expectTokenOnlySentToSlackFiles()
    expect(readdirSync(inboxDir)).toEqual([])
  })

  test.each([
    [3, true],
    [4, false],
  ])('%p same-origin redirects → downloaded=%p, after exactly 4 fetches', async (hops, downloaded) => {
    fetchHandler = (url) => {
      const n = Number(new URL(url).pathname.split('/').pop())
      return n < hops ? redirect(`/hop/${n + 1}`) : new Response('file-body')
    }

    const result = await download([{ id: 'F0FILE001', name: 'report.txt', url_private_download: `${FILES}/hop/0${QUERY}` }])

    expect(fetches).toHaveLength(4)
    expectTokenOnlySentToSlackFiles()
    if (downloaded) {
      expect(result.isError).toBeUndefined()
      expect(result.content[0].text).toBe(`Downloaded 1 file(s):\n${outPath('report.txt')}`)
    } else {
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe(redirectRefusal('F0FILE001', 'redirected more than 3 times'))
      expect(readdirSync(inboxDir)).toEqual([])
    }
  })

  test.each<[string, (url: string) => Response, string[]]>([
    ['a 302 with no Location', () => redirect(), [`${FILES}/files-pri/T0-F0FILE001/report.txt${QUERY}`]],
    [
      'a 404 on the first request',
      () => new Response('not found', { status: 404 }),
      [`${FILES}/files-pri/T0-F0FILE001/report.txt${QUERY}`],
    ],
    [
      'a same-origin 302 that then returns 404',
      (url) =>
        url.includes('/download/')
          ? new Response('not found', { status: 404 })
          : redirect('/files-pri/T0-F0FILE001/download/report.txt'),
      [`${FILES}/files-pri/T0-F0FILE001/report.txt${QUERY}`, `${FILES}/files-pri/T0-F0FILE001/download/report.txt`],
    ],
  ])('%s skips the file → "Failed to download any files."', async (_label, handler, fetched) => {
    fetchHandler = handler

    const result = await download([slackFile('F0FILE001', 'report.txt')])

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe('Failed to download any files.')
    expect(fetches.map((f) => f.url)).toEqual(fetched)
    expectTokenOnlySentToSlackFiles()
    expect(readdirSync(inboxDir)).toEqual([])
  })

  test('a redirect refusal after an earlier file was written lists the already-downloaded path', async () => {
    fetchHandler = (url) => (url.includes('/b.txt') ? redirect('https://evil.example/b.txt') : new Response('a-body'))

    const result = await download([slackFile('F0FILE001', 'a.txt'), slackFile('F0FILE002', 'b.txt')])

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(
      `${redirectRefusal('F0FILE002', OFFSITE)} Already downloaded before this refusal:\n${outPath('a.txt')}`,
    )
    expect(fetches.map((f) => f.url)).toEqual([
      `${FILES}/files-pri/T0-F0FILE001/a.txt${QUERY}`,
      `${FILES}/files-pri/T0-F0FILE002/b.txt${QUERY}`,
    ])
    expectTokenOnlySentToSlackFiles()
    expect(readFileSync(outPath('a.txt'), 'utf-8')).toBe('a-body')
    expect(readdirSync(inboxDir)).toEqual(['1700000000_000100_a.txt'])
  })
})

// ---------------------------------------------------------------------------
// Regression tests: b.xnf — channelId-keyed registry prevents CWD-collision hijack
// ---------------------------------------------------------------------------

describe('b.xnf regression — channelId routing isolation', () => {
  test('two sessions with the same cwd but different channelIds do not collide', () => {
    const SHARED_CWD = '/tmp/shared-project'
    const entryA = registerSession(SHARED_CWD, 'C_FIRST', makeTransport(), makeServer())
    const entryB = registerSession(SHARED_CWD, 'C_SECOND', makeTransport(), makeServer())

    // Both should be retrievable by their channelId
    expect(getSessionByChannel('C_FIRST')).toBe(entryA)
    expect(getSessionByChannel('C_SECOND')).toBe(entryB)

    // Verify both are live and distinct
    expect(entryA).not.toBe(entryB)
    expect(entryA.connected).toBe(true)
    expect(entryB.connected).toBe(true)
  })

  test('getSessionByChannel returns undefined for an unregistered channelId even if another session shares the cwd', () => {
    const SHARED_CWD = '/tmp/shared-project'
    // Register a real session for C_REAL
    registerSession(SHARED_CWD, 'C_REAL', makeTransport(), makeServer())

    // C_HIJACKER has no registered session — should not find C_REAL's session
    const found = getSessionByChannel('C_HIJACKER')
    expect(found).toBeUndefined()
  })

  test('registering a second session for the same channelId replaces the first (last-writer-wins)', () => {
    const first = registerSession('/tmp/a', 'C_X', makeTransport(), makeServer())
    expect(first.connected).toBe(true)

    const second = registerSession('/tmp/b', 'C_X', makeTransport(), makeServer())

    // Second registration wins
    expect(getSessionByChannel('C_X')).toBe(second)
    // First was marked disconnected
    expect(first.connected).toBe(false)
  })
})
