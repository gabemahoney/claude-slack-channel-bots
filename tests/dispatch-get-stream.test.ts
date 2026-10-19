/** b.omv SR-9: intake accepts a connected session without a GET stream. */
import { beforeEach, afterEach, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeChannelMessage } from './test-helpers/slack-stub.ts'
import { registerSession } from '../src/registry.ts'
import { makeRoutingHarness, makeTransport, makeSessionServer, resetRoutingState } from './test-helpers/persona-routing-harness.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'connected-delivery-')); resetRoutingState() })
afterEach(() => { resetRoutingState(); rmSync(dir, { recursive: true, force: true }) })
test('connected streamless intake stores and acknowledges without probing the stream or requesting recovery', async () => {
  const h = makeRoutingHarness([{ name: 'alpha' }, { name: 'beta' }], dir, { streamless: ['alpha'] })
  const notifications: Parameters<typeof makeSessionServer>[0] = []
  const p = h.p('alpha').persona
  // No delivery consumer may inspect the SDK stream mapping.
  const registered = registerSession(join(dir, 'no-intake-probe'), p.key, makeTransport('no-probe', true), makeSessionServer(notifications))
  Object.defineProperty(registered.transport, '_streamMapping', { get: () => { throw new Error('intake must not probe the MCP stream') } })
  try {
    await h.receive(makeChannelMessage({ channel: p.channels[0]!.id }), ['alpha'])
    expect(h.queued('alpha')).toHaveLength(1); expect(h.queued('beta')).toEqual([]); expect(h.order.filter(s => s === 'ack')).toEqual(['ack']); expect(h.restartAsks).toEqual([]); expect(notifications).toEqual([]); expect(h.notices).toEqual([])
    assertNoLeak(h.captured())
  } finally { await h.queue.stop(); h.hold.cancelAll() }
})
