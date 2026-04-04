/**
 * session-discovery.test.ts — Tests for the post-tool-call session ID discovery hook
 * in createSessionServer (registry.ts, task t2.nrd.so.a7).
 *
 * The hook fires after every tool call when entry.peerPort > 0. It:
 *   1. Calls getPeerPidByPort to find the PID of the connecting Claude process
 *   2. Calls getSessionIdForPid to read the session UUID from the PID file
 *   3. Writes the discovered session ID to sessions.json (if changed)
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  registerSession,
  createSessionServer,
  _resetRegistry,
  type SessionToolDeps,
} from '../src/registry.ts'
import { _resetAckTracker } from '../src/ack-tracker.ts'
import { makeSessionsStubs } from './test-helpers/sessions-stub.ts'
import { makePeerPidStub } from './test-helpers/peer-pid-stub.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_CHANNEL  = 'C_DISC_TEST'
const TEST_CWD      = '/tmp/disc-test'
const TEST_PEER_PORT   = 54321
const TEST_SERVER_PORT = 8080
const TEST_PID         = 12345
const TEST_SESSION_ID  = 'session-uuid-abc-123'

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeTransport(): any {
  return { handleRequest: () => {}, close: async () => {} }
}

function makeServer(): any {
  return { connect: async () => {}, notification: () => {} }
}

function makeWebClient(): any {
  return {
    chat: {
      postMessage: async () => ({ ok: true, ts: '111.222' }),
      update: async () => ({ ok: true }),
    },
    reactions: {
      add: async () => ({ ok: true }),
      remove: async () => ({ ok: true }),
    },
    conversations: {
      replies: async () => ({ messages: [] }),
      history: async () => ({ messages: [] }),
    },
    filesUploadV2: async () => ({ ok: true }),
  }
}

/** Build a SessionToolDeps fixture; discovery deps must be supplied by the test. */
function makeDeps(overrides: Partial<SessionToolDeps> = {}): SessionToolDeps {
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
    web: makeWebClient(),
    botToken: 'xoxb-test',
    inboxDir: '/tmp',
    resolveUserName: async (id: string) => id,
    consumeAck: () => false,
    serverPort: TEST_SERVER_PORT,
    ...overrides,
  }
}

/** Connect a server to an in-memory client, run fn(), then close. */
async function withClient(
  server: any,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
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

/**
 * Yield to the event loop long enough for the fire-and-forget discovery IIFE
 * (which awaits getPeerPidByPort then getSessionIdForPid) to complete.
 */
async function drainDiscovery(): Promise<void> {
  await Bun.sleep(20)
}

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRegistry()
  _resetAckTracker()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session discovery hook — getPeerPidByPort / getSessionIdForPid', () => {
  test('successful discovery writes new sessionId when stored value differs', async () => {
    const sessions = makeSessionsStubs({
      [TEST_CHANNEL]: { tmuxSession: 'slack_bot_test', lastLaunch: '2024-01-01T00:00:00.000Z', sessionId: 'old-session-id' },
    })
    const peerPid = makePeerPidStub({ peerPidResult: TEST_PID, sessionIdResult: TEST_SESSION_ID })

    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    entry.peerPort = TEST_PEER_PORT

    const server = createSessionServer(entry, makeDeps({
      getPeerPidByPort: peerPid.getPeerPidByPort,
      getSessionIdForPid: peerPid.getSessionIdForPid,
      readSessions: sessions.read,
      writeSessions: sessions.write,
    }))

    await withClient(server, async (client) => {
      await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'hello' } })
    })
    await drainDiscovery()

    expect(sessions.writtenSessions).toHaveLength(1)
    expect(sessions.writtenSessions[0][TEST_CHANNEL].sessionId).toBe(TEST_SESSION_ID)
  })

  test('no write when getPeerPidByPort returns null (no matching connection)', async () => {
    const sessions = makeSessionsStubs({
      [TEST_CHANNEL]: { tmuxSession: 'slack_bot_test', lastLaunch: '2024-01-01T00:00:00.000Z', sessionId: 'old-id' },
    })
    const peerPid = makePeerPidStub({ peerPidResult: null })

    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    entry.peerPort = TEST_PEER_PORT

    const server = createSessionServer(entry, makeDeps({
      getPeerPidByPort: peerPid.getPeerPidByPort,
      getSessionIdForPid: peerPid.getSessionIdForPid,
      readSessions: sessions.read,
      writeSessions: sessions.write,
    }))

    await withClient(server, async (client) => {
      await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'hello' } })
    })
    await drainDiscovery()

    expect(sessions.writtenSessions).toHaveLength(0)
  })

  test('no write when getPeerPidByPort returns a PID but getSessionIdForPid returns null', async () => {
    const sessions = makeSessionsStubs({
      [TEST_CHANNEL]: { tmuxSession: 'slack_bot_test', lastLaunch: '2024-01-01T00:00:00.000Z', sessionId: 'old-id' },
    })
    const peerPid = makePeerPidStub({ peerPidResult: TEST_PID, sessionIdResult: null })

    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    entry.peerPort = TEST_PEER_PORT

    const server = createSessionServer(entry, makeDeps({
      getPeerPidByPort: peerPid.getPeerPidByPort,
      getSessionIdForPid: peerPid.getSessionIdForPid,
      readSessions: sessions.read,
      writeSessions: sessions.write,
    }))

    await withClient(server, async (client) => {
      await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'hello' } })
    })
    await drainDiscovery()

    expect(peerPid.peerPidCalls).toHaveLength(1)
    expect(peerPid.sessionIdCalls).toHaveLength(1)
    expect(sessions.writtenSessions).toHaveLength(0)
  })

  test('"pending" sessionId is replaced with the discovered real session ID', async () => {
    const sessions = makeSessionsStubs({
      [TEST_CHANNEL]: { tmuxSession: 'slack_bot_test', lastLaunch: '2024-01-01T00:00:00.000Z', sessionId: 'pending' },
    })
    const peerPid = makePeerPidStub({ peerPidResult: TEST_PID, sessionIdResult: TEST_SESSION_ID })

    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    entry.peerPort = TEST_PEER_PORT

    const server = createSessionServer(entry, makeDeps({
      getPeerPidByPort: peerPid.getPeerPidByPort,
      getSessionIdForPid: peerPid.getSessionIdForPid,
      readSessions: sessions.read,
      writeSessions: sessions.write,
    }))

    await withClient(server, async (client) => {
      await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'hello' } })
    })
    await drainDiscovery()

    expect(sessions.writtenSessions).toHaveLength(1)
    expect(sessions.writtenSessions[0][TEST_CHANNEL].sessionId).toBe(TEST_SESSION_ID)
  })

  test('no write when stored sessionId already matches discovered value', async () => {
    const sessions = makeSessionsStubs({
      [TEST_CHANNEL]: { tmuxSession: 'slack_bot_test', lastLaunch: '2024-01-01T00:00:00.000Z', sessionId: TEST_SESSION_ID },
    })
    const peerPid = makePeerPidStub({ peerPidResult: TEST_PID, sessionIdResult: TEST_SESSION_ID })

    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    entry.peerPort = TEST_PEER_PORT

    const server = createSessionServer(entry, makeDeps({
      getPeerPidByPort: peerPid.getPeerPidByPort,
      getSessionIdForPid: peerPid.getSessionIdForPid,
      readSessions: sessions.read,
      writeSessions: sessions.write,
    }))

    await withClient(server, async (client) => {
      await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'hello' } })
    })
    await drainDiscovery()

    expect(sessions.writtenSessions).toHaveLength(0)
  })

  test('writeSessions failure is caught and does not affect the tool call result', async () => {
    const sessions = makeSessionsStubs({
      [TEST_CHANNEL]: { tmuxSession: 'slack_bot_test', lastLaunch: '2024-01-01T00:00:00.000Z', sessionId: 'old-id' },
    })
    const peerPid = makePeerPidStub({ peerPidResult: TEST_PID, sessionIdResult: TEST_SESSION_ID })

    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    entry.peerPort = TEST_PEER_PORT

    const server = createSessionServer(entry, makeDeps({
      getPeerPidByPort: peerPid.getPeerPidByPort,
      getSessionIdForPid: peerPid.getSessionIdForPid,
      readSessions: sessions.read,
      writeSessions: () => { throw new Error('disk full') },
    }))

    let result: any
    await withClient(server, async (client) => {
      result = await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'hello' } })
    })
    await drainDiscovery()

    // Tool call still succeeds despite writeSessions throwing
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('Sent')
  })

  test('discovery hook fires on react tool calls', async () => {
    const sessions = makeSessionsStubs({
      [TEST_CHANNEL]: { tmuxSession: 'slack_bot_test', lastLaunch: '2024-01-01T00:00:00.000Z', sessionId: 'pending' },
    })
    const peerPid = makePeerPidStub({ peerPidResult: TEST_PID, sessionIdResult: TEST_SESSION_ID })

    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    entry.peerPort = TEST_PEER_PORT

    const server = createSessionServer(entry, makeDeps({
      getPeerPidByPort: peerPid.getPeerPidByPort,
      getSessionIdForPid: peerPid.getSessionIdForPid,
      readSessions: sessions.read,
      writeSessions: sessions.write,
    }))

    await withClient(server, async (client) => {
      await client.callTool({ name: 'react', arguments: { chat_id: TEST_CHANNEL, message_id: '111.222', emoji: 'thumbsup' } })
    })
    await drainDiscovery()

    expect(sessions.writtenSessions).toHaveLength(1)
    expect(sessions.writtenSessions[0][TEST_CHANNEL].sessionId).toBe(TEST_SESSION_ID)
  })

  test('discovery hook fires on fetch_messages tool calls', async () => {
    const sessions = makeSessionsStubs({
      [TEST_CHANNEL]: { tmuxSession: 'slack_bot_test', lastLaunch: '2024-01-01T00:00:00.000Z', sessionId: 'pending' },
    })
    const peerPid = makePeerPidStub({ peerPidResult: TEST_PID, sessionIdResult: TEST_SESSION_ID })

    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    entry.peerPort = TEST_PEER_PORT

    const server = createSessionServer(entry, makeDeps({
      getPeerPidByPort: peerPid.getPeerPidByPort,
      getSessionIdForPid: peerPid.getSessionIdForPid,
      readSessions: sessions.read,
      writeSessions: sessions.write,
    }))

    await withClient(server, async (client) => {
      await client.callTool({ name: 'fetch_messages', arguments: { channel: TEST_CHANNEL } })
    })
    await drainDiscovery()

    expect(sessions.writtenSessions).toHaveLength(1)
    expect(sessions.writtenSessions[0][TEST_CHANNEL].sessionId).toBe(TEST_SESSION_ID)
  })

  test('discovery hook does not fire when entry.peerPort is 0', async () => {
    const sessions = makeSessionsStubs({
      [TEST_CHANNEL]: { tmuxSession: 'slack_bot_test', lastLaunch: '2024-01-01T00:00:00.000Z', sessionId: 'pending' },
    })
    const peerPid = makePeerPidStub({ peerPidResult: TEST_PID, sessionIdResult: TEST_SESSION_ID })

    const entry = registerSession(TEST_CWD, TEST_CHANNEL, makeTransport(), makeServer())
    // entry.peerPort defaults to 0 → discovery does not fire

    const server = createSessionServer(entry, makeDeps({
      getPeerPidByPort: peerPid.getPeerPidByPort,
      getSessionIdForPid: peerPid.getSessionIdForPid,
      readSessions: sessions.read,
      writeSessions: sessions.write,
    }))

    await withClient(server, async (client) => {
      await client.callTool({ name: 'reply', arguments: { chat_id: TEST_CHANNEL, text: 'hello' } })
    })
    await drainDiscovery()

    expect(peerPid.peerPidCalls).toHaveLength(0)
    expect(sessions.writtenSessions).toHaveLength(0)
  })
})
