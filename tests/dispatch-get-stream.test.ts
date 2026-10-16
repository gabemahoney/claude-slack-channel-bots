import { makeChannelMessage } from './test-helpers/slack-stub.ts'
/** The stream probe remains for health/restart callers; intake never probes it. */
import { beforeEach, afterEach, describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasSessionStream } from '../src/persona-routing.ts'
import { hasGetStreamKey } from '../src/lib.ts'
import { registerSession } from '../src/registry.ts'
import { initRestart, runRestartRetry } from '../src/restart.ts'
import { LIVENESS_READING_LIVE } from '../src/liveness-reading.ts'
import { makeRoutingHarness, makeTransport, makeSessionServer, makeRestartDeps, resetRoutingState, NEVER_FIRE_RESTART_DELAY_S } from './test-helpers/persona-routing-harness.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stream-probe-')); resetRoutingState() })
afterEach(() => { assertNoLeak({}); resetRoutingState(); rmSync(dir, { recursive: true, force: true }) })
describe('b.9cj hasSessionStream over the real registry', () => {
  test('a freshly registered session with its GET stream reports true', () => {
    registerSession(join(dir, 'stream-session'), 'p_stream', makeTransport('mcp-p_stream'), makeSessionServer([]))
    expect(hasSessionStream('p_stream')).toBe(true)
  })

  test('connected stays true but the probe reports streamless after the SDK drops _GET_stream', () => {
    const transport = makeTransport('mcp-p_streamless')
    const entry = registerSession(join(dir, 'streamless-session'), 'p_streamless', transport, makeSessionServer([]))
    expect(hasSessionStream('p_streamless')).toBe(true)

    ;(transport as unknown as { _streamMapping: Map<string, unknown> })._streamMapping.delete('_GET_stream')

    expect(entry.connected).toBe(true)                  // unchanged — still "connected"
    expect(hasSessionStream('p_streamless')).toBe(false) // but no longer deliverable
  })

  test('returns false when there is no session at all', () => {
    expect(hasSessionStream('p_no_session')).toBe(false)
  })

  // The restart guard is wired with this probe (src/server.ts): a session that
  // is alive and connected but streamless is not "already reconnected".
  test.each([
    [true, 0],
    [false, 1],
  ])('restart.ts with the real probe: stream present=%p → reconnectSession called %p time(s)', async (stream, reconnects) => {
    registerSession(join(dir, 'restart-probe'), 'p_restart', makeTransport('mcp-p_restart', !stream), makeSessionServer([]))
    let reconnectCalls = 0
    initRestart({
      ...makeRestartDeps({ restartDelayS: NEVER_FIRE_RESTART_DELAY_S }),
      async isSessionAlive() { return LIVENESS_READING_LIVE },
      isSessionConnected() { return true },
      hasSessionStream,
      async reconnectSession() { reconnectCalls++; return 'success' },
    })

    await runRestartRetry('p_restart', join(dir, 'restart-probe'), () => false)

    expect(reconnectCalls).toBe(reconnects)
  })
})

// ---------------------------------------------------------------------------
// Direct unit tests for hasGetStreamKey (lib.ts)
// ---------------------------------------------------------------------------

describe('hasGetStreamKey', () => {
  // Case 1 — _streamMapping contains '_GET_stream' → true
  test('returns true when transport._streamMapping has _GET_stream key', () => {
    const mapping = new Map<string, unknown>()
    mapping.set('_GET_stream', { controller: {}, encoder: new TextEncoder() })
    const transport = { _streamMapping: mapping }
    expect(hasGetStreamKey(transport)).toBe(true)
  })

  // Case 2 — _streamMapping exists but '_GET_stream' is absent → false
  test('returns false when transport._streamMapping exists but lacks _GET_stream key', () => {
    const mapping = new Map<string, unknown>()
    mapping.set('_other_stream', {})
    const transport = { _streamMapping: mapping }
    expect(hasGetStreamKey(transport)).toBe(false)
  })

  // Case 3 — transport has no _streamMapping property → false
  test('returns false when transport has no _streamMapping', () => {
    const transport = { sessionId: 'abc', handleRequest: () => {} }
    expect(hasGetStreamKey(transport)).toBe(false)
  })

  // Case 4 — transport is null / undefined → false
  test('returns false when transport is null', () => {
    expect(hasGetStreamKey(null)).toBe(false)
  })

  test('returns false when transport is undefined', () => {
    expect(hasGetStreamKey(undefined)).toBe(false)
  })

  // Case 5 — _streamMapping is present but .has is not callable (defensive) → false
  test('returns false when _streamMapping.has is not a function', () => {
    const transport = { _streamMapping: { has: 'not-a-function' } }
    expect(hasGetStreamKey(transport)).toBe(false)
  })
})


test('connected streamless intake stores and acknowledges without probing the stream or requesting recovery', async () => {
  const h = makeRoutingHarness([{ name: 'alpha' }, { name: 'beta' }], dir, { streamless: ['alpha'] })
  const notifications: Parameters<typeof makeSessionServer>[0] = []
  const p = h.p('alpha').persona
  // A dispatch-time probe would throw here; health/restart helpers above retain their own probe.
  const registered = registerSession(join(dir, 'no-intake-probe'), p.key, makeTransport('no-probe', true), makeSessionServer(notifications))
  Object.defineProperty(registered.transport, '_streamMapping', { get: () => { throw new Error('intake must not probe the MCP stream') } })
  try {
    await h.receive(makeChannelMessage({ channel: p.channels[0]!.id }), ['alpha'])
    expect(h.queued('alpha')).toHaveLength(1); expect(h.queued('beta')).toEqual([]); expect(h.order.filter(s => s === 'ack')).toEqual(['ack']); expect(h.restartAsks).toEqual([]); expect(notifications).toEqual([]); expect(h.notices).toEqual([])
    assertNoLeak(h.captured())
  } finally { await h.queue.stop(); h.hold.cancelAll() }
})
