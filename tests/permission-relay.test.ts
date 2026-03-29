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
  waiters: Array<(decision: 'allow' | 'deny') => void>
}

// ---------------------------------------------------------------------------
// Shared mutable state — captured by closure in the test server.
// All three consumers (test server handler, handleInteractive, tests) read the
// same bindings, so reassigning or mutating them in beforeEach is visible everywhere.
// ---------------------------------------------------------------------------

const pendingPermissions = new Map<string, PendingPermission>()
const completedDecisions = new Map<string, 'allow' | 'deny'>()

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
// Uses waiters array + completedDecisions map (new two-phase model)
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
        completedDecisions.set(requestId, decision)
        for (const waiter of pending.waiters) waiter(decision)
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
// Uses a short poll timeout so the "returns pending" test completes quickly.
// ---------------------------------------------------------------------------

const POLL_TIMEOUT_MS = 200

const testServer = Bun.serve({
  port: 0,
  async fetch(req: Request, server: any): Promise<Response> {
    const url = new URL(req.url)

    if (!url.pathname.startsWith('/permission')) {
      return new Response('Not Found', { status: 404 })
    }

    // Reject methods other than GET and POST
    if (req.method !== 'POST' && req.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const remoteAddr = server.requestIP(req)
    const remoteHost = remoteAddr?.address ?? ''
    const isLocalhost =
      remoteHost === '127.0.0.1' ||
      remoteHost === '::1' ||
      remoteHost.startsWith('::ffff:127.')
    if (!isLocalhost) {
      return new Response('Forbidden', { status: 403 })
    }

    // GET /permission/<requestId> — long-poll for decision
    if (req.method === 'GET' && url.pathname.startsWith('/permission/')) {
      const pollRequestId = url.pathname.slice('/permission/'.length)

      // Already decided — return immediately
      const existingDecision = completedDecisions.get(pollRequestId)
      if (existingDecision !== undefined) {
        return new Response(JSON.stringify({ status: 'decided', decision: existingDecision }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const pendingEntry = pendingPermissions.get(pollRequestId)

      // Unknown requestId — deny immediately
      if (!pendingEntry) {
        return new Response(JSON.stringify({ status: 'decided', decision: 'deny' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // Race POLL_TIMEOUT_MS vs waiter resolving vs client abort
      const decision = await new Promise<'allow' | 'deny' | null>((promiseResolve) => {
        let settled = false
        let timerId: ReturnType<typeof setTimeout>

        const waiter = (d: 'allow' | 'deny') => {
          if (settled) return
          settled = true
          clearTimeout(timerId)
          promiseResolve(d)
        }

        pendingEntry.waiters.push(waiter)

        timerId = setTimeout(() => {
          if (settled) return
          settled = true
          const idx = pendingEntry.waiters.indexOf(waiter)
          if (idx !== -1) pendingEntry.waiters.splice(idx, 1)
          promiseResolve(null)
        }, POLL_TIMEOUT_MS)

        req.signal.addEventListener('abort', () => {
          if (settled) return
          settled = true
          clearTimeout(timerId)
          const idx = pendingEntry.waiters.indexOf(waiter)
          if (idx !== -1) pendingEntry.waiters.splice(idx, 1)
          promiseResolve(null)
        })
      })

      if (decision === null) {
        return new Response(JSON.stringify({ status: 'pending' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ status: 'decided', decision }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // GET /permission (no requestId suffix) falls through to the POST-only guard below
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    // POST /permission — validate, post stub message, register pending, return requestId

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

    // Register pending entry with empty waiters array; return requestId immediately
    pendingPermissions.set(requestId, {
      requestId,
      channelId: matchedChannelId,
      messageTs,
      toolName: tool_name,
      waiters: [],
    })

    return new Response(JSON.stringify({ requestId }), {
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
    waiters: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  pendingPermissions.clear()
  completedDecisions.clear()
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
  // TC-1: POST returns requestId immediately; GET long-poll resolves after handleInteractive
  test('TC-1: POST returns requestId immediately; GET long-poll resolves after handleInteractive', async () => {
    routingConfig = { routes: { C_TEST: { cwd: '/tmp/test-project' } } }

    // Step 1: POST — must return requestId without blocking
    const postRes = await fetch(`${BASE_URL}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        cwd: '/tmp/test-project',
      }),
    })
    expect(postRes.status).toBe(200)
    const { requestId } = (await postRes.json()) as { requestId: string }
    expect(typeof requestId).toBe('string')
    expect(pendingPermissions.size).toBe(1)

    const pending = pendingPermissions.get(requestId)!
    expect(pending.toolName).toBe('Bash')
    expect(pending.channelId).toBe('C_TEST')
    expect(pending.messageTs).toBe('msg-ts-123')

    // Step 2: Start GET long-poll concurrently
    const pollPromise = fetch(`${BASE_URL}/permission/${requestId}`)

    // Step 3: Wait briefly for poll to register its waiter
    await Bun.sleep(50)

    // Step 4: Simulate Allow button click
    await handleInteractive({ actions: [{ action_id: `perm_allow_${requestId}` }] })

    // Step 5: Poll resolves with the decision
    const pollRes = await pollPromise
    expect(pollRes.status).toBe(200)
    const body = (await pollRes.json()) as { status: string; decision: string }
    expect(body.status).toBe('decided')
    expect(body.decision).toBe('allow')
  })

  // TC-2: unrecognized CWD → 404 (unchanged)
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

  // TC-3: missing required fields → 400 (unchanged)
  test('TC-3: POST with missing fields returns 400', async () => {
    const response = await fetch(`${BASE_URL}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: 'Bash' }), // tool_input and cwd absent
    })

    expect(response.status).toBe(400)
  })

  // TC-4: unsupported method → 405 (now tests DELETE instead of GET)
  test('TC-4: DELETE to /permission returns 405', async () => {
    const response = await fetch(`${BASE_URL}/permission`, { method: 'DELETE' })
    expect(response.status).toBe(405)
  })

  // TC-5: interactive event with matching action ID resolves the correct entry
  test('TC-5: Interactive event with matching action ID resolves the correct pending entry', async () => {
    let resolved: 'allow' | 'deny' | null = null

    pendingPermissions.set(
      'req-tc5',
      makePendingPermission({
        requestId: 'req-tc5',
        waiters: [(d) => { resolved = d }],
      }),
    )

    await handleInteractive({ actions: [{ action_id: 'perm_allow_req-tc5' }] })

    expect(resolved!).toBe('allow')
    expect(pendingPermissions.has('req-tc5')).toBe(false)
    expect(completedDecisions.get('req-tc5')).toBe('allow')
  })

  // TC-6: interactive event with unknown action ID is silently ignored (unchanged)
  test('TC-6: Interactive event with unknown action ID is silently ignored', async () => {
    await handleInteractive({ actions: [{ action_id: 'perm_allow_no-such-id' }] })

    expect(chatUpdateCalls).toHaveLength(0)
  })

  // TC-7: concurrent pending requests on same channel resolve independently via GET long-poll
  test('TC-7: Concurrent pending requests on the same channel resolve independently', async () => {
    routingConfig = { routes: { C_SHARED: { cwd: '/tmp/shared-project' } } }

    // Create two permission requests via POST
    const post1 = await fetch(`${BASE_URL}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'echo 1' },
        cwd: '/tmp/shared-project',
      }),
    })
    const post2 = await fetch(`${BASE_URL}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/foo.txt' },
        cwd: '/tmp/shared-project',
      }),
    })
    const { requestId: id1 } = (await post1.json()) as { requestId: string }
    const { requestId: id2 } = (await post2.json()) as { requestId: string }
    expect(pendingPermissions.size).toBe(2)

    // Start GET long-polls for both
    const poll1 = fetch(`${BASE_URL}/permission/${id1}`)
    const poll2 = fetch(`${BASE_URL}/permission/${id2}`)

    // Wait for waiters to register
    await Bun.sleep(50)

    // Resolve in opposite order to confirm independence
    await handleInteractive({ actions: [{ action_id: `perm_deny_${id2}` }] })
    await handleInteractive({ actions: [{ action_id: `perm_allow_${id1}` }] })

    const [res1, res2] = await Promise.all([poll1, poll2])
    const body1 = (await res1.json()) as { status: string; decision: string }
    const body2 = (await res2.json()) as { status: string; decision: string }

    expect(body1.status).toBe('decided')
    expect(body2.status).toBe('decided')
    const decisions = new Set([body1.decision, body2.decision])
    expect(decisions).toEqual(new Set(['allow', 'deny']))
  })

  // TC-8: aborting GET long-poll removes waiter from pending entry
  test('TC-8: Aborting GET long-poll removes the waiter from the pending entry', async () => {
    pendingPermissions.set('req-tc8', makePendingPermission({ requestId: 'req-tc8' }))

    const controller = new AbortController()
    const pollPromise = fetch(`${BASE_URL}/permission/req-tc8`, {
      signal: controller.signal,
    })
    const settled = pollPromise.then(() => 'resolved' as const).catch(() => 'rejected' as const)

    // Wait for the waiter to be registered
    await Bun.sleep(50)
    expect(pendingPermissions.get('req-tc8')!.waiters.length).toBe(1)

    // Abort the client request (simulates disconnect)
    controller.abort()

    // Wait for the server-side abort handler to fire
    await Bun.sleep(50)
    expect(pendingPermissions.get('req-tc8')!.waiters.length).toBe(0)
    expect(await settled).toBe('rejected')
  })

  // TC-9: pending entry survives Socket Mode disconnect; resolves when interaction arrives
  test('TC-9: Pending entry survives Socket Mode disconnect and resolves after reconnect', async () => {
    let resolved: 'allow' | 'deny' | null = null

    pendingPermissions.set(
      'req-tc9',
      makePendingPermission({
        requestId: 'req-tc9',
        toolName: 'Edit',
        waiters: [(d) => { resolved = d }],
      }),
    )

    // Simulate disconnect — Map is unaffected
    expect(pendingPermissions.has('req-tc9')).toBe(true)

    // Simulate reconnect — interactive event arrives
    await handleInteractive({ actions: [{ action_id: 'perm_deny_req-tc9' }] })

    expect(resolved!).toBe('deny')
    expect(pendingPermissions.has('req-tc9')).toBe(false)
  })

  // TC-10: Slack message is updated after decision; completedDecisions is populated
  test('TC-10: Message is updated after decision', async () => {
    pendingPermissions.set(
      'req-tc10',
      makePendingPermission({
        requestId: 'req-tc10',
        channelId: 'C_DECISION',
        messageTs: 'ts-12345',
        toolName: 'Edit',
      }),
    )

    await handleInteractive({ actions: [{ action_id: 'perm_allow_req-tc10' }] })

    expect(chatUpdateCalls).toHaveLength(1)
    const call = chatUpdateCalls[0]
    expect(call.channel).toBe('C_DECISION')
    expect(call.ts).toBe('ts-12345')
    expect(call.text).toContain('Allowed')
    expect(completedDecisions.get('req-tc10')).toBe('allow')
  })

  // New: GET returns decision immediately when already in completedDecisions
  test('GET long-poll returns immediately when decision already in completedDecisions', async () => {
    completedDecisions.set('req-already', 'allow')

    const res = await fetch(`${BASE_URL}/permission/req-already`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; decision: string }
    expect(body.status).toBe('decided')
    expect(body.decision).toBe('allow')
  })

  // New: GET returns pending after poll timeout with no decision
  test('GET long-poll returns pending after poll timeout with no decision', async () => {
    pendingPermissions.set('req-timeout', makePendingPermission({ requestId: 'req-timeout' }))

    const res = await fetch(`${BASE_URL}/permission/req-timeout`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('pending')
  })

  // New: GET /permission/<unknownId> returns decided deny
  test('GET /permission/<unknownId> returns decided deny', async () => {
    const res = await fetch(`${BASE_URL}/permission/no-such-request`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; decision: string }
    expect(body.status).toBe('decided')
    expect(body.decision).toBe('deny')
  })
})
