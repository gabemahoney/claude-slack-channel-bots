/** Accepted work survives a failed first fixed append without another event
 * or restart (b.omv SR-3.3/4.1/5.1); the unfixed head still owns the FIFO. */
import { afterEach, expect, test } from 'bun:test'
import { createPersonaRouting } from '../src/persona-routing.ts'
import { RETYPE_BACKOFF_MS } from '../src/delivery-constants.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { injectedInput } from './test-helpers/delivery-queue.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeChannelMessage } from './test-helpers/slack-stub.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'

const harnesses: EngineHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    assertNoLeak([h.errors, h.events, h.calls, h.order, h.records()])
    await h.cleanup()
  }
})

test.each(['slack-post-ack', 'injected', 'startup-accepted-only'] as const)('%s autonomously retries fixation, preserving ack and FIFO boundaries', async source => {
  const h = await makeEngineHarness(); harnesses.push(h)
  h.failAppend('fixed')
  if (source === 'slack-post-ack') {
    const config = makeMultiPersonaConfig([{ name: 'alpha', key: 'alpha' }], h.root)
    const routing = createPersonaRouting({
      queue: h.queue, prepare: h.preparation.prepare, getPersonaConfig: () => config,
      getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }),
      archive: () => {}, log: line => h.order.push(line), isPersonaUp: () => false, now: h.clock.now,
    })
    await routing.receive(makeChannelMessage({ channel: config.personas[0]!.channels[0]!.id, user: 'U0SENDER1', text: 'first' }), () => {
      expect(h.records().filter(r => r.kind === 'accepted')).toHaveLength(1)
      expect(h.order).not.toContain('lookup')
      expect(h.calls).toEqual([])
      h.order.push('ack')
    }, 'alpha')
    expect(h.order.indexOf('ack')).toBeLessThan(h.order.indexOf('lookup'))
  } else if (source === 'injected') {
    const accepted = await h.preparation.accept('alpha', injectedInput({ text: 'first' }))
    expect(accepted.status).toBe('accepted')
    if (accepted.status === 'failed') throw new Error('fixture acceptance failed')
    await Promise.allSettled([h.preparation.prepare('alpha', accepted.item!)])
  } else {
    // Load the durable accepted-only item through the queue's real startup path.
    await h.queue.accept('alpha', injectedInput({ text: 'first' }))
    await h.restartServer()
    await h.preparation.recover()
  }
  const first = h.queue.items('alpha')[0]!
  expect(first.fixed).toBeUndefined()
  expect(h.preparation.owns('alpha', first.accepted.seq)).toBe(true)
  await h.accept('later')
  await h.tick()
  expect(h.engine.running('alpha')).toBe(true)
  await h.advance(RETYPE_BACKOFF_MS[0] - 1)
  expect(h.keyCalls()).toEqual([])
  expect(h.queue.items('alpha')[0]!.fixed).toBeUndefined()
  expect(h.queue.openCount('alpha')).toBe(2)
  await h.until(() => h.queue.openCount('alpha') === 0)
  const parts = h.queue.items('alpha').flatMap(item => item.fixed!.parts)
  expect(h.textCalls().map(call => call.params.text)).toEqual(parts)
  expect(parts[0]).toContain('first')
  expect(parts[1]).toBe('later')
  expect(h.records().filter(r => r.kind === 'fixed').map(r => r.seq)).toEqual([2, 1])
  expect(h.events.filter(e => e.type === 'delivered').map(e => e.seq)).toEqual([1, 2])
  expect(h.preparation.owns('alpha', first.accepted.seq)).toBe(false)
})
