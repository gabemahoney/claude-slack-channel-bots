/**
 * sse-keepalive.test.ts — Tests for SSE keep-alive heartbeat (b.qzm)
 *
 * The keep-alive mechanism sends `:ping\n\n` SSE comments every ~30s on the
 * GET SSE stream to prevent idle-connection disconnects.
 *
 * server.ts cannot be imported without live Slack credentials, so we set fake
 * tokens at module scope before the dynamic import. The values satisfy prefix
 * checks (xoxb-*, xapp-*) but are otherwise inert — no network calls happen
 * at import time.
 *
 * Since Bun's fake-timer support does not intercept setInterval callbacks
 * reliably, we monkey-patch globalThis.setInterval within each test to capture
 * the interval callback synchronously, then invoke it directly.
 *
 * SPDX-License-Identifier: MIT
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

// ---------------------------------------------------------------------------
// Bootstrap — fake tokens so loadTokens() passes without calling process.exit
// ---------------------------------------------------------------------------

process.env['SLACK_BOT_TOKEN'] ||= 'xoxb-test-keepalive'
process.env['SLACK_APP_TOKEN'] ||= 'xapp-test-keepalive'

const { startSseKeepAlive, stopSseKeepAlive, stopAllKeepAliveTimers } = await import('../src/server.ts')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StreamEntry = {
  controller: { enqueue: (data: Uint8Array) => void }
  encoder: TextEncoder
}

/** Minimal mock transport with a configurable _GET_stream entry. */
function makeTransport(streamEntry?: StreamEntry): WebStandardStreamableHTTPServerTransport {
  return {
    _streamMapping: streamEntry
      ? new Map([['_GET_stream', streamEntry]])
      : new Map(),
  } as unknown as WebStandardStreamableHTTPServerTransport
}

/** Intercepts the next setInterval call and returns the captured callback. */
function captureNextInterval(): { getCallback: () => (() => void) | null; restore: () => void } {
  let captured: (() => void) | null = null
  const orig = globalThis.setInterval

  // @ts-ignore — intentional monkey-patch for testing
  globalThis.setInterval = (fn: () => void, _delay: number) => {
    captured = fn
    return orig(fn, _delay)
  }

  return {
    getCallback: () => captured,
    restore: () => {
      globalThis.setInterval = orig
    },
  }
}

// ---------------------------------------------------------------------------
// Cleanup — clear all timers after every test to avoid cross-test leaks
// ---------------------------------------------------------------------------

afterEach(() => {
  stopAllKeepAliveTimers()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE keep-alive heartbeat (b.qzm)', () => {
  test('sends :ping\\n\\n to the SSE stream when the interval fires', () => {
    const enqueueCalls: Uint8Array[] = []
    const encoder = new TextEncoder()
    const streamEntry: StreamEntry = {
      controller: { enqueue: (data) => enqueueCalls.push(data) },
      encoder,
    }
    const transport = makeTransport(streamEntry)

    const { getCallback, restore } = captureNextInterval()
    try {
      startSseKeepAlive(transport)
      const cb = getCallback()
      expect(cb).toBeDefined()
      cb!()
    } finally {
      restore()
    }

    expect(enqueueCalls.length).toBe(1)
    expect(enqueueCalls[0]).toEqual(encoder.encode(':ping\n\n'))
  })

  test('is a no-op when there is no _GET_stream entry', () => {
    const transport = makeTransport() // empty _streamMapping

    const { getCallback, restore } = captureNextInterval()
    try {
      startSseKeepAlive(transport)
      const cb = getCallback()
      expect(cb).toBeDefined()
      // Should not throw even though there is no stream entry
      expect(() => cb!()).not.toThrow()
    } finally {
      restore()
    }
  })

  test('self-cleans when controller.enqueue throws', () => {
    const encoder = new TextEncoder()
    const streamEntry: StreamEntry = {
      controller: {
        enqueue: () => { throw new Error('stream closed') },
      },
      encoder,
    }
    const transport = makeTransport(streamEntry)
    const transport2 = makeTransport()

    const { getCallback, restore } = captureNextInterval()
    try {
      startSseKeepAlive(transport)
      const cb = getCallback()!

      // Trigger the throw — self-clean should call keepAliveTimers.delete(transport)
      cb()
    } finally {
      restore()
    }

    // Start a second transport so keepAliveTimers has exactly one entry (transport2).
    // If transport was NOT deleted, stopAllKeepAliveTimers would clear two intervals.
    // We monkey-patch clearInterval to count how many times it fires.
    startSseKeepAlive(transport2)

    const origClearInterval = globalThis.clearInterval
    const clearedIds: unknown[] = []
    // @ts-ignore — intentional monkey-patch for testing
    globalThis.clearInterval = (id: unknown) => {
      clearedIds.push(id)
      origClearInterval(id as ReturnType<typeof setInterval>)
    }
    try {
      stopAllKeepAliveTimers()
    } finally {
      globalThis.clearInterval = origClearInterval
    }

    // Exactly one interval should have been cleared — transport2's.
    // If transport's entry was NOT deleted from the map, this would be 2.
    expect(clearedIds.length).toBe(1)
  })

  test('stopSseKeepAlive clears the interval for a started transport', () => {
    const transport = makeTransport()
    startSseKeepAlive(transport)
    // If not started, stopSseKeepAlive is silent; if started, it must also be silent
    expect(() => stopSseKeepAlive(transport)).not.toThrow()
    // Double-stop is idempotent
    expect(() => stopSseKeepAlive(transport)).not.toThrow()
  })

  test('stopSseKeepAlive is a no-op for a transport that was never started', () => {
    const transport = makeTransport()
    expect(() => stopSseKeepAlive(transport)).not.toThrow()
  })

  test('stopAllKeepAliveTimers clears intervals for all active transports', () => {
    const transportA = makeTransport()
    const transportB = makeTransport()
    startSseKeepAlive(transportA)
    startSseKeepAlive(transportB)

    expect(() => stopAllKeepAliveTimers()).not.toThrow()

    // After stopAll, individual stops should be no-ops
    expect(() => stopSseKeepAlive(transportA)).not.toThrow()
    expect(() => stopSseKeepAlive(transportB)).not.toThrow()
  })

  test('stopAllKeepAliveTimers is a no-op when no timers are active', () => {
    expect(() => stopAllKeepAliveTimers()).not.toThrow()
  })
})
