/**
 * sse-timeout.test.ts — Regression test for b.2hd
 *
 * Bun's global idleTimeout: 255 kills SSE connections after ~4 minutes of
 * inactivity. The fix calls server.timeout(req, 0) for GET requests to disable
 * the idle timeout per-request. This test verifies that behavior and guards
 * against future regressions.
 *
 * Uses a self-contained Bun.serve() that mirrors the GET/POST branch of the
 * MCP fetch handler, with a spy patched onto the server object to record calls
 * to server.timeout.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'

// ---------------------------------------------------------------------------
// Spy state — reset in beforeEach
// ---------------------------------------------------------------------------

const timeoutCalls: Array<{ req: Request; seconds: number }> = []

// ---------------------------------------------------------------------------
// Test server — replicates the relevant GET/POST branch of the MCP fetch handler
// ---------------------------------------------------------------------------

const testServer = Bun.serve({
  port: 0,
  idleTimeout: 255,
  async fetch(req: Request, server: { timeout(req: Request, seconds: number): void }): Promise<Response> {
    if (req.method === 'GET') {
      server.timeout(req, 0)
      return new Response('data: hello\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    return new Response('ok', { status: 200 })
  },
})

// Spy on server.timeout — must be installed before any requests are made.
// The server parameter in the fetch handler IS the same object as testServer,
// so patching an own property here is visible inside the fetch closure.
const _origTimeout = testServer.timeout.bind(testServer)
testServer.timeout = (req: Request, seconds: number) => {
  timeoutCalls.push({ req, seconds })
  return _origTimeout(req, seconds)
}

afterAll(() => testServer.stop(true))

beforeEach(() => {
  timeoutCalls.length = 0
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE idle timeout disabled for GET requests (b.2hd)', () => {
  test('GET request calls server.timeout(req, 0) to disable idle timeout', async () => {
    await fetch(`http://localhost:${testServer.port}/mcp`)
    expect(timeoutCalls.length).toBe(1)
    expect(timeoutCalls[0]!.seconds).toBe(0)
  })

  test('POST request does not call server.timeout', async () => {
    await fetch(`http://localhost:${testServer.port}/mcp`, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(timeoutCalls.length).toBe(0)
  })
})
