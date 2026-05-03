/**
 * interject.test.ts — Integration tests for the /interject endpoint (SR-8.3, SR-8.4)
 *
 * Since server.ts executes side effects at module scope (reads .env, connects Socket
 * Mode, binds HTTP), it cannot be imported in tests. Instead we replicate the
 * /interject endpoint logic in a self-contained Bun.serve() test server that uses
 * in-process stubs in place of the real session registry and MCP server.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'

// ---------------------------------------------------------------------------
// Types (mirrored from server.ts)
// ---------------------------------------------------------------------------

interface MockMcpServer {
  notification: (n: { method: string; params: unknown }) => void
}

interface MockSession {
  channel: string
  cwd: string
  connected: boolean
  server: MockMcpServer
}

// ---------------------------------------------------------------------------
// Shared mutable state — captured by closure in the test server.
// Reassigning or mutating in beforeEach is visible to the server handler.
// ---------------------------------------------------------------------------

let routingConfig: { routes: Record<string, { cwd: string }> } | null = null

// sessions keyed by channel — mirrors getSessionByChannel lookup
const sessions = new Map<string, MockSession>()

// Capture array for notification() calls — reset in beforeEach via .length = 0
const notificationCalls: Array<{ method: string; params: unknown }> = []

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

function makeRoutingConfig(channels: string[] = ['C_TEST']): { routes: Record<string, { cwd: string }> } {
  const routes: Record<string, { cwd: string }> = {}
  for (const ch of channels) {
    routes[ch] = { cwd: '/tmp/test-project' }
  }
  return { routes }
}

function makeSession(overrides: Partial<MockSession> & { channel: string }): MockSession {
  return {
    cwd: '/tmp/test-project',
    connected: true,
    server: {
      notification: (n) => notificationCalls.push(n),
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test server — replicates /interject handler logic verbatim from server.ts
// Binds on port 0 so OS assigns a free port (no conflicts).
// ---------------------------------------------------------------------------

const testServer = Bun.serve({
  port: 0,
  async fetch(req: Request, server: any): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname !== '/interject') {
      return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 })
    }

    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const remoteAddr = server.requestIP(req)
    const remoteHost = remoteAddr?.address ?? ''
    if (remoteHost !== '127.0.0.1' && remoteHost !== '::1' && !remoteHost.startsWith('::ffff:127.')) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const bodyText = await req.text()
    if (new TextEncoder().encode(bodyText).byteLength > 32768) {
      return new Response(JSON.stringify({ error: 'Request body too large (max 32KB)' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let body: { channel?: unknown; message?: unknown; sender?: unknown }
    try {
      body = JSON.parse(bodyText)
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const { channel, message, sender } = body
    if (typeof channel !== 'string' || !channel) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid field: channel (string) required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (typeof message !== 'string' || !message) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid field: message (string) required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const route = routingConfig?.routes[channel]
    if (!route) {
      return new Response(
        JSON.stringify({ error: 'Channel not found in routing config' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const targetSession = sessions.get(channel)
    if (!targetSession || !targetSession.connected) {
      return new Response(
        JSON.stringify({ error: 'No active session for this channel' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const senderLabel = typeof sender === 'string' && sender ? sender : 'interject'
    const ts = String(Date.now() / 1000)
    const meta: Record<string, string> = {
      chat_id: channel,
      message_id: ts,
      user: senderLabel,
      ts,
    }

    targetSession.server.notification({
      method: 'notifications/claude/channel',
      params: { content: message, meta },
    })

    return new Response(JSON.stringify({ ok: true, channel, cwd: targetSession.cwd }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  },
})

const BASE_URL = `http://127.0.0.1:${testServer.port}`

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  routingConfig = null
  sessions.clear()
  notificationCalls.length = 0
})

afterAll(() => {
  testServer.stop()
})

// ---------------------------------------------------------------------------
// SR-8.3 / SR-8.4 Test Cases
// ---------------------------------------------------------------------------

describe('/interject endpoint', () => {
  // TC-1: Happy path — valid channel + message → 200, notification delivered
  test('TC-1: POST valid channel+message returns 200 and delivers notification', async () => {
    routingConfig = makeRoutingConfig(['C_TEST'])
    sessions.set('C_TEST', makeSession({ channel: 'C_TEST' }))

    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_TEST', message: 'Hello from interject' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; channel: string; cwd: string }
    expect(body.ok).toBe(true)
    expect(body.channel).toBe('C_TEST')
    expect(body.cwd).toBe('/tmp/test-project')

    // SR-8.4: verify notification shape
    expect(notificationCalls).toHaveLength(1)
    const notif = notificationCalls[0]!
    expect(notif.method).toBe('notifications/claude/channel')
    const params = notif.params as { content: string; meta: Record<string, string> }
    expect(params.content).toBe('Hello from interject')
    expect(params.meta.chat_id).toBe('C_TEST')
    expect(params.meta.user).toBe('interject')
    expect(typeof params.meta.message_id).toBe('string')
    expect(Number(params.meta.message_id)).toBeGreaterThan(1_000_000_000)
    expect(typeof params.meta.ts).toBe('string')
    expect(Number(params.meta.ts)).toBeGreaterThan(1_000_000_000)
  })

  // TC-2: Missing channel field → 400 with field-specific error
  test('TC-2: Missing channel returns 400 with field-specific error', async () => {
    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('channel')
  })

  // TC-3: Missing message field → 400 with field-specific error
  test('TC-3: Missing message returns 400 with field-specific error', async () => {
    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_TEST' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('message')
  })

  // TC-4: Empty string message → 400
  test('TC-4: Empty string message returns 400', async () => {
    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_TEST', message: '' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('message')
  })

  // TC-5: Invalid JSON → 400 with "Invalid JSON"
  test('TC-5: Invalid JSON body returns 400 with "Invalid JSON"', async () => {
    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json {{{',
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Invalid JSON')
  })

  // TC-6a: GET → 405
  test('TC-6a: GET /interject returns 405', async () => {
    const res = await fetch(`${BASE_URL}/interject`, { method: 'GET' })
    expect(res.status).toBe(405)
  })

  // TC-6b: PUT → 405
  test('TC-6b: PUT /interject returns 405', async () => {
    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'PUT',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(405)
  })

  // TC-6c: DELETE → 405
  test('TC-6c: DELETE /interject returns 405', async () => {
    const res = await fetch(`${BASE_URL}/interject`, { method: 'DELETE' })
    expect(res.status).toBe(405)
  })

  // TC-7: Channel not in routing config → 404
  test('TC-7: Channel not in routing config returns 404', async () => {
    routingConfig = makeRoutingConfig(['C_KNOWN'])

    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_UNKNOWN', message: 'Hello' }),
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('Channel not found')
  })

  // TC-8a: Channel in config but no session in registry → 503
  test('TC-8a: Channel in config with no active session returns 503', async () => {
    routingConfig = makeRoutingConfig(['C_TEST'])
    // no session registered

    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_TEST', message: 'Hello' }),
    })

    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('No active session')
  })

  // TC-8b: Channel in config, session exists but connected=false → 503
  test('TC-8b: Channel in config with disconnected session returns 503', async () => {
    routingConfig = makeRoutingConfig(['C_TEST'])
    sessions.set('C_TEST', makeSession({ channel: 'C_TEST', connected: false }))

    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_TEST', message: 'Hello' }),
    })

    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('No active session')
  })

  // TC-9: Body larger than 32KB → 413
  test('TC-9: Body larger than 32KB returns 413', async () => {
    // 32769 'x' chars → 32769 bytes (exceeds 32768 limit)
    const oversized = 'x'.repeat(32769)
    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    })

    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('too large')
  })

  // TC-10: Custom sender → meta.user uses provided value (SR-8.4)
  test('TC-10: Custom sender field is reflected in notification meta.user', async () => {
    routingConfig = makeRoutingConfig(['C_TEST'])
    sessions.set('C_TEST', makeSession({ channel: 'C_TEST' }))

    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_TEST', message: 'Test message', sender: 'alice' }),
    })

    expect(res.status).toBe(200)
    expect(notificationCalls).toHaveLength(1)
    const params = (notificationCalls[0]!.params as { content: string; meta: Record<string, string> })
    expect(params.meta.user).toBe('alice')
  })

  // TC-11: Default sender (omitted) → meta.user is "interject" (SR-8.4)
  test('TC-11: Omitted sender defaults meta.user to "interject"', async () => {
    routingConfig = makeRoutingConfig(['C_TEST'])
    sessions.set('C_TEST', makeSession({ channel: 'C_TEST' }))

    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_TEST', message: 'Test message' }),
    })

    expect(res.status).toBe(200)
    expect(notificationCalls).toHaveLength(1)
    const params = (notificationCalls[0]!.params as { content: string; meta: Record<string, string> })
    expect(params.meta.user).toBe('interject')
  })

  // Edge: empty string sender falls back to "interject"
  test('Empty string sender falls back to default "interject"', async () => {
    routingConfig = makeRoutingConfig(['C_TEST'])
    sessions.set('C_TEST', makeSession({ channel: 'C_TEST' }))

    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_TEST', message: 'Test message', sender: '' }),
    })

    expect(res.status).toBe(200)
    const params = (notificationCalls[0]!.params as { content: string; meta: Record<string, string> })
    expect(params.meta.user).toBe('interject')
  })

  // Edge: non-string channel (number) → 400
  test('Non-string channel returns 400', async () => {
    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 42, message: 'Hello' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('channel')
  })

  // Edge: notification not delivered on error paths (no side effects on 400)
  test('No notification is delivered when request is invalid', async () => {
    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_TEST' }), // missing message
    })

    expect(res.status).toBe(400)
    expect(notificationCalls).toHaveLength(0)
  })

  // Edge: routingConfig is null (not yet set) → 404
  test('Null routingConfig returns 404 for any channel', async () => {
    routingConfig = null

    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_TEST', message: 'Hello' }),
    })

    expect(res.status).toBe(404)
  })

  // SR-8.4: message_id and ts are both the same timestamp string
  test('SR-8.4: notification meta.message_id and meta.ts are equal timestamp strings', async () => {
    routingConfig = makeRoutingConfig(['C_TEST'])
    sessions.set('C_TEST', makeSession({ channel: 'C_TEST' }))

    const res = await fetch(`${BASE_URL}/interject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_TEST', message: 'Timestamp check' }),
    })

    expect(res.status).toBe(200)
    const params = (notificationCalls[0]!.params as { content: string; meta: Record<string, string> })
    expect(params.meta.message_id).toBe(params.meta.ts)
    expect(Number(params.meta.ts)).toBeGreaterThan(1_000_000_000)
  })
})
