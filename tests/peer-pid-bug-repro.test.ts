/**
 * Reproduction test for peer-pid discovery bug.
 *
 * The existing session-discovery.test.ts passes because it uses a simplified
 * initialization order: it calls registerSession() FIRST to create the registry
 * entry, sets peerPort on it, then passes that same entry to createSessionServer.
 * That means the closure and the registry point at the same object.
 *
 * Production code in server.ts uses the OPPOSITE order:
 *   1. Create a stub SessionEntry
 *   2. Call createSessionServer(stub, deps) — tool handlers close over stub
 *   3. Later, registerSession() creates a NEW SessionEntry in the registry
 *   4. HTTP fetch handler mutates the registry entry's peerPort
 *   5. Tool handler reads entry.peerPort from its closure — that's STUB.peerPort,
 *      which is still 0 because the HTTP handler mutated the OTHER entry
 *
 * This test reproduces that production flow. It should FAIL on current code
 * and PASS after the fix.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  registerSession,
  createSessionServer,
  createPendingSession,
  getPendingSession,
  _resetRegistry,
  type SessionEntry,
  type SessionToolDeps,
} from '../src/registry.ts'
import { _resetAckTracker } from '../src/ack-tracker.ts'
import { makeSessionsStubs } from './test-helpers/sessions-stub.ts'
import { makePeerPidStub } from './test-helpers/peer-pid-stub.ts'

const TEST_CHANNEL = 'C_REPRO'
const TEST_CWD = '/tmp/repro-test'
const TEST_PEER_PORT = 54321
const TEST_SERVER_PORT = 8080
const TEST_PID = 99999
const TEST_SESSION_ID = 'discovered-session-id-repro'

function makeTransport(): any {
  return { handleRequest: () => {}, close: async () => {} }
}

function makeDeps(overrides: Partial<SessionToolDeps> = {}): SessionToolDeps {
  return {
    assertOutboundAllowed: () => {},
    assertSendable: () => {},
    getAccess: () => ({
      dmPolicy: 'pairing',
      allowFrom: [],
      channels: {},
      pending: {},
      ackReaction: 'eyes',
    }),
    web: {
      chat: {
        postMessage: async () => ({ ok: true, ts: '1.1' }),
        update: async () => ({ ok: true }),
      },
      reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
      conversations: { replies: async () => ({ messages: [] }), history: async () => ({ messages: [] }) },
    } as any,
    botToken: 'xoxb-test',
    inboxDir: '/tmp',
    resolveUserName: async (id: string) => id,
    consumeAck: () => false,
    serverPort: TEST_SERVER_PORT,
    ...overrides,
  }
}

async function withClient(server: any, fn: (client: Client) => Promise<void>): Promise<void> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} })
  await client.connect(clientTransport)
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

async function drainDiscovery(): Promise<void> {
  await Bun.sleep(20)
}

beforeEach(() => {
  _resetRegistry()
  _resetAckTracker()
})

describe('peer-pid bug reproduction', () => {
  test('entry identity: promotion path mutates the stub, not creates a new object', () => {
    const PENDING_ID = 'test-pending-id-identity'
    const transport = makeTransport()
    const deliveredChannels = new Set<string>()

    // Production flow step 1: create stub (simulating initPendingSession)
    const stub: SessionEntry = {
      cwd: '',
      channelId: '',
      transport,
      server: null as any,
      deliveredChannels,
      connected: true,
      peerPort: 0,
    }

    // Production flow step 2: store as pending with stub (simulating createPendingSession call)
    createPendingSession(PENDING_ID, transport, null as any, deliveredChannels, stub)

    // Production flow step 3: promotion — registerSession via 3-arg form
    const registered = registerSession(TEST_CWD, TEST_CHANNEL, PENDING_ID)

    // After the fix: the registered entry IS the stub (same object reference)
    expect(registered).toBe(stub)

    // Mutating the registered entry's peerPort also affects stub (same object)
    registered.peerPort = TEST_PEER_PORT
    expect(stub.peerPort).toBe(TEST_PEER_PORT)

    // Pending entry must be cleaned up after promotion
    expect(getPendingSession(PENDING_ID)).toBeUndefined()

    // deliveredChannels is seeded with the channelId on promotion
    expect(registered.deliveredChannels.has(TEST_CHANNEL)).toBe(true)
  })

  test('discovery hook fires when peerPort is set on registry entry via promotion path', async () => {
    const PENDING_ID = 'test-pending-id-discovery'
    const sessions = makeSessionsStubs({
      [TEST_CHANNEL]: { tmuxSession: 'slack_bot_test', lastLaunch: '2024-01-01T00:00:00.000Z', sessionId: 'pending' },
    })
    const peerPid = makePeerPidStub({ peerPidResult: TEST_PID, sessionIdResult: TEST_SESSION_ID })

    const transport = makeTransport()
    const deliveredChannels = new Set<string>()

    // Step 1: Create the stub (simulating initPendingSession in server.ts)
    const stub: SessionEntry = {
      cwd: '',
      channelId: '',
      transport,
      server: null as any,
      deliveredChannels,
      connected: true,
      peerPort: 0,
    }

    // Step 2: Create the server with the STUB closure (simulating server.ts:378)
    const server = createSessionServer(stub, makeDeps({
      getPeerPidByPort: peerPid.getPeerPidByPort,
      getSessionIdForPid: peerPid.getSessionIdForPid,
      readSessions: sessions.read,
      writeSessions: sessions.write,
    }))
    stub.server = server

    // Step 3: Store as pending WITH the stub (simulating initPendingSession's
    // createPendingSession call after the fix)
    createPendingSession(PENDING_ID, transport, server, deliveredChannels, stub)

    // Step 4: Promote via 3-arg registerSession (production path in handleInitialized)
    const registered = registerSession(TEST_CWD, TEST_CHANNEL, PENDING_ID)

    // Verify unification: the registered entry is the same object as the stub
    expect(registered).toBe(stub)

    // Step 5: HTTP fetch handler sets peerPort on the registry entry —
    // which is now the same object the closure captured
    registered.peerPort = TEST_PEER_PORT

    // Step 6: Trigger a tool call — the tool handler reads entry.peerPort (now TEST_PEER_PORT)
    // so the discovery hook's `if (entry.peerPort > 0)` guard is TRUE and the hook fires.
    await withClient(server, async (client) => {
      await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'hi' } })
    })
    await drainDiscovery()

    // After the fix: writtenSessions has the discovered sessionId
    expect(sessions.writtenSessions).toHaveLength(1)
    expect(sessions.writtenSessions[0][TEST_CHANNEL].sessionId).toBe(TEST_SESSION_ID)
  })
})
