/**
 * permission-relay.test.ts — Integration tests for the /permission endpoint (SR-7.3)
 *
 * Since server.ts executes side effects at module scope (reads .env, connects Socket
 * Mode, binds HTTP), it cannot be imported in tests. Instead we replicate the
 * /permission endpoint logic in a self-contained Bun.serve() test server that uses
 * in-process stubs in place of the real Slack WebClient.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// Types (mirrored from server.ts)
// ---------------------------------------------------------------------------

interface PendingPermission {
  requestId: string
  channelId: string
  messageTs: string
  toolName: string
  resolve: (decision: 'allow' | 'deny') => void
}

// ---------------------------------------------------------------------------
// Shared mutable state — captured by closure in the test server.
// All three consumers (test server handler, handleInteractive, tests) read the
// same bindings, so reassigning or mutating them in beforeEach is visible everywhere.
// ---------------------------------------------------------------------------

const pendingPermissions = new Map<string, PendingPermission>()

let routingConfig: { routes: Record<string, { cwd: string }> } | null = null

// Call-capture arrays — reset in beforeEach via .length = 0
const postMessageCalls: any[] = []
const chatUpdateCalls: any[] = []

async function stubPostMessage(args: any): Promise<{ ts: string; ok: boolean }> {
  postMessageCalls.push(args)
  return { ts: 'msg-ts-123', ok: true }
}

async function stubChatUpdate(args: any): Promise<{ ok: boolean }> {
  chatUpdateCalls.push(args)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Block Kit builders — copied verbatim from server.ts
// ---------------------------------------------------------------------------

function buildPermissionBlocks(
  toolName: string,
  toolInput: Record<string, unknown>,
  requestId: string,
): any[] {
  let summary: string
  if (toolName === 'Bash') {
    summary = String(toolInput['command'] ?? JSON.stringify(toolInput).slice(0, 500))
  } else if (toolName === 'Edit' || toolName === 'Write') {
    summary = String(toolInput['file_path'] ?? JSON.stringify(toolInput).slice(0, 500))
  } else {
    const raw = JSON.stringify(toolInput)
    summary = raw.length > 500 ? raw.slice(0, 500) + '…' : raw
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${toolName}*\n${summary}` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Allow' },
          style: 'primary',
          action_id: `perm_allow_${requestId}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          style: 'danger',
          action_id: `perm_deny_${requestId}`,
        },
      ],
    },
  ]
}

function buildPermissionDecisionBlocks(
  toolName: string,
  decision: 'allow' | 'deny',
  userName: string,
): any[] {
  const label = decision === 'allow' ? 'Allowed' : 'Denied'
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${toolName}* — ${label} by ${userName}` },
    },
  ]
}

// ---------------------------------------------------------------------------
// Interactive event handler — mirrors socket.on('interactive') in server.ts
// ---------------------------------------------------------------------------

async function handleInteractive(payload: Record<string, unknown>): Promise<void> {
  const actions = (payload['actions'] as Array<{ action_id: string }> | undefined) ?? []
  for (const action of actions) {
    const actionId = action.action_id
    if (actionId.startsWith('perm_allow_') || actionId.startsWith('perm_deny_')) {
      const isAllow = actionId.startsWith('perm_allow_')
      const prefix = isAllow ? 'perm_allow_' : 'perm_deny_'
      const requestId = actionId.slice(prefix.length)
      const pending = pendingPermissions.get(requestId)
      if (pending) {
        const decision: 'allow' | 'deny' = isAllow ? 'allow' : 'deny'
        pending.resolve(decision)
        pendingPermissions.delete(requestId)
        await stubChatUpdate({
          channel: pending.channelId,
          ts: pending.messageTs,
          text: `${pending.toolName} — ${decision === 'allow' ? 'Allowed' : 'Denied'} by testuser`,
          blocks: buildPermissionDecisionBlocks(pending.toolName, decision, 'testuser'),
        })
        return
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Test server — binds on port 0 (OS assigns a free port)
// ---------------------------------------------------------------------------

const testServer = Bun.serve({
  port: 0,
  async fetch(req: Request, server: any): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname !== '/permission') {
      return new Response('Not Found', { status: 404 })
    }

    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const remoteAddr = server.requestIP(req)
    const remoteHost = remoteAddr?.address ?? ''
    // Accept loopback in both plain and IPv4-mapped-IPv6 forms
    const isLocalhost =
      remoteHost === '127.0.0.1' ||
      remoteHost === '::1' ||
      remoteHost.startsWith('::ffff:127.')
    if (!isLocalhost) {
      return new Response('Forbidden', { status: 403 })
    }

    let body: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown }
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const { tool_name, tool_input, cwd } = body
    if (
      typeof tool_name !== 'string' ||
      typeof tool_input !== 'object' ||
      tool_input === null ||
      typeof cwd !== 'string'
    ) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid fields: tool_name, tool_input, cwd required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const normalizedCwd = resolve(cwd)
    const matchedChannelId = routingConfig
      ? Object.entries(routingConfig.routes).find(
          ([, route]) => resolve(route.cwd) === normalizedCwd,
        )?.[0]
      : undefined

    if (!matchedChannelId) {
      return new Response(JSON.stringify({ error: 'No route found for CWD' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const requestId = crypto.randomUUID()

    let messageTs: string
    try {
      const blocks = buildPermissionBlocks(tool_name, tool_input as Record<string, unknown>, requestId)
      const postResult = await stubPostMessage({
        channel: matchedChannelId,
        text: `Permission request: ${tool_name}`,
        blocks,
      })
      messageTs = postResult.ts
    } catch {
      return new Response(JSON.stringify({ error: 'Failed to post message' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let decision: 'allow' | 'deny'
    try {
      decision = await new Promise<'allow' | 'deny'>((resolvePermission, rejectPermission) => {
        pendingPermissions.set(requestId, {
          requestId,
          channelId: matchedChannelId,
          messageTs,
          toolName: tool_name,
          resolve: resolvePermission,
        })

        req.signal.addEventListener('abort', () => {
          pendingPermissions.delete(requestId)
          rejectPermission(new DOMException('Request aborted', 'AbortError'))
        })
      })
    } catch {
      // Client disconnected — pending entry already cleaned up above
      return new Response('', { status: 499 })
    }

    return new Response(JSON.stringify({ decision }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  },
})

const BASE_URL = `http://127.0.0.1:${testServer.port}`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePendingPermission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    requestId: 'test-req-id',
    channelId: 'C_TEST',
    messageTs: 'msg-ts-123',
    toolName: 'Bash',
    resolve: () => {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  pendingPermissions.clear()
  postMessageCalls.length = 0
  chatUpdateCalls.length = 0
  routingConfig = null
})

afterAll(() => {
  testServer.stop()
})

// ---------------------------------------------------------------------------
// SR-7.3 Test Cases
// ---------------------------------------------------------------------------

describe('permission relay — /permission endpoint', () => {
  // TC-1: valid CWD → held response resolves on button click
  test('TC-1: POST with valid CWD returns held response that resolves on button click', async () => {
    routingConfig = { routes: { C_TEST: { cwd: '/tmp/test-project' } } }

    const permissionFetch = fetch(`${BASE_URL}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        cwd: '/tmp/test-project',
      }),
    })

    // Wait for the server to register the pending entry
    await Bun.sleep(50)
    expect(pendingPermissions.size).toBe(1)

    const [[requestId, pending]] = [...pendingPermissions.entries()]
    expect(pending.toolName).toBe('Bash')
    expect(pending.channelId).toBe('C_TEST')
    expect(pending.messageTs).toBe('msg-ts-123')

    // Simulate Allow button click
    pending.resolve('allow')
    pendingPermissions.delete(requestId)

    const response = await permissionFetch
    expect(response.status).toBe(200)
    const body = (await response.json()) as { decision: string }
    expect(body.decision).toBe('allow')
  })

  // TC-2: unrecognized CWD → 404
  test('TC-2: POST with unrecognized CWD returns 404', async () => {
    routingConfig = { routes: { C_TEST: { cwd: '/tmp/known-project' } } }

    const response = await fetch(`${BASE_URL}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: '/tmp/unknown-project',
      }),
    })

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('No route found')
  })

  // TC-3: missing required fields → 400
  test('TC-3: POST with missing fields returns 400', async () => {
    const response = await fetch(`${BASE_URL}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: 'Bash' }), // tool_input and cwd absent
    })

    expect(response.status).toBe(400)
  })

  // TC-4: non-POST method → 405
  test('TC-4: Non-POST to /permission returns 405', async () => {
    const response = await fetch(`${BASE_URL}/permission`, { method: 'GET' })
    expect(response.status).toBe(405)
  })

  // TC-5: interactive event with matching action ID resolves the correct entry
  test('TC-5: Interactive event with matching action ID resolves the correct pending entry', async () => {
    let resolved: 'allow' | 'deny' | null = null

    pendingPermissions.set(
      'req-tc5',
      makePendingPermission({
        requestId: 'req-tc5',
        resolve: (d) => { resolved = d },
      }),
    )

    await handleInteractive({ actions: [{ action_id: 'perm_allow_req-tc5' }] })

    expect(resolved).toBe('allow')
    expect(pendingPermissions.has('req-tc5')).toBe(false)
  })

  // TC-6: interactive event with unknown action ID is silently ignored
  test('TC-6: Interactive event with unknown action ID is silently ignored', async () => {
    // No matching entry in map
    await handleInteractive({ actions: [{ action_id: 'perm_allow_no-such-id' }] })

    expect(chatUpdateCalls).toHaveLength(0)
  })

  // TC-7: concurrent pending requests on same channel resolve independently
  test('TC-7: Concurrent pending requests on the same channel resolve independently', async () => {
    routingConfig = { routes: { C_SHARED: { cwd: '/tmp/shared-project' } } }

    const promise1 = fetch(`${BASE_URL}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'echo 1' },
        cwd: '/tmp/shared-project',
      }),
    })

    const promise2 = fetch(`${BASE_URL}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/foo.txt' },
        cwd: '/tmp/shared-project',
      }),
    })

    // Wait for both requests to register
    await Bun.sleep(50)
    expect(pendingPermissions.size).toBe(2)

    const entries = [...pendingPermissions.entries()]
    const [id1, perm1] = entries[0]
    const [id2, perm2] = entries[1]

    // Resolve in opposite order to confirm independence
    perm2.resolve('deny')
    pendingPermissions.delete(id2)

    perm1.resolve('allow')
    pendingPermissions.delete(id1)

    const [res1, res2] = await Promise.all([promise1, promise2])
    const body1 = (await res1.json()) as { decision: string }
    const body2 = (await res2.json()) as { decision: string }

    // Both decisions must be present (one allow, one deny)
    const decisions = new Set([body1.decision, body2.decision])
    expect(decisions).toEqual(new Set(['allow', 'deny']))
  })

  // TC-8: pending entry cleaned up on client disconnect
  test('TC-8: Pending entry is cleaned up on client disconnect', async () => {
    routingConfig = { routes: { C_TEST: { cwd: '/tmp/disconnect-test' } } }
    const controller = new AbortController()

    const fetchPromise = fetch(`${BASE_URL}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'sleep 100' },
        cwd: '/tmp/disconnect-test',
      }),
      signal: controller.signal,
    })
    // Attach a no-op catch immediately so Bun does not treat the eventual
    // AbortError as an unhandled rejection before we check it below.
    const settled = fetchPromise.then(() => 'resolved' as const).catch(() => 'rejected' as const)

    // Wait for the pending entry to appear
    await Bun.sleep(50)
    expect(pendingPermissions.size).toBe(1)

    // Abort the client request (simulates disconnect)
    controller.abort()

    // Wait for the server-side abort event to fire and clean up
    await Bun.sleep(50)
    expect(pendingPermissions.size).toBe(0)

    // Confirm the fetch was rejected (not resolved)
    expect(await settled).toBe('rejected')
  })

  // TC-9: pending entry survives Socket Mode disconnect; resolves when interaction
  //        arrives after reconnect
  test('TC-9: Pending entry survives Socket Mode disconnect and resolves after reconnect', async () => {
    // In the real server, pendingPermissions lives in module scope and outlives
    // Socket Mode reconnections.  We verify the same invariant: after a simulated
    // "disconnect" (the Map is untouched), the entry can still be resolved by a
    // subsequent interactive event.
    let resolved: 'allow' | 'deny' | null = null

    pendingPermissions.set(
      'req-tc9',
      makePendingPermission({
        requestId: 'req-tc9',
        toolName: 'Edit',
        resolve: (d) => { resolved = d },
      }),
    )

    // Simulate disconnect — Map is unaffected
    expect(pendingPermissions.has('req-tc9')).toBe(true)

    // Simulate reconnect — interactive event arrives
    await handleInteractive({ actions: [{ action_id: 'perm_deny_req-tc9' }] })

    expect(resolved).toBe('deny')
    expect(pendingPermissions.has('req-tc9')).toBe(false)
  })

  // TC-10: Slack message is updated after decision
  test('TC-10: Message is updated after decision', async () => {
    pendingPermissions.set(
      'req-tc10',
      makePendingPermission({
        requestId: 'req-tc10',
        channelId: 'C_DECISION',
        messageTs: 'ts-12345',
        toolName: 'Edit',
        resolve: () => {},
      }),
    )

    await handleInteractive({ actions: [{ action_id: 'perm_allow_req-tc10' }] })

    expect(chatUpdateCalls).toHaveLength(1)
    const call = chatUpdateCalls[0]
    expect(call.channel).toBe('C_DECISION')
    expect(call.ts).toBe('ts-12345')
    expect(call.text).toContain('Allowed')
  })
})
