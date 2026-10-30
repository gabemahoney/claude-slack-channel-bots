/** Accepted work survives a failed first fixed append without another event
 * or restart; the unfixed head still owns the FIFO. */
import { afterEach, expect, test } from 'bun:test'
import { createPersonaRouting } from '../src/persona-routing.ts'
import { RETYPE_BACKOFF_MS } from '../src/delivery-constants.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { heldSlackInput, memoryHold, injectedInput } from './test-helpers/delivery-queue.ts'
import { THREAD_ROOTS } from './test-helpers/thread-memory.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeChannelMessage } from './test-helpers/slack-stub.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makeSharedAuthority } from './test-helpers/shared-channels.ts'
import { createChannelDeliveryStore } from '../src/channel-delivery.ts'
import { observedMembership } from './test-helpers/persona-routing-harness.ts'

const harnesses: EngineHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    assertNoLeak([h.errors, h.events, h.calls, h.order, h.records()])
    await h.cleanup()
  }
})

test('Memory Hold recovery and failed fixation retries prepare only released work', async () => {
  const h = await makeEngineHarness(); harnesses.push(h)
  for (const ts of [THREAD_ROOTS.secondary, THREAD_ROOTS.third]) {
    const input = heldSlackInput(memoryHold(h.clock.now()), { ts, key: { chat_id: 'C0TEST001', ts } })
    expect((await h.queue.acceptDecided('alpha', input.key, () => ({ store: input }))).status).toBe('accepted')
  }
  await h.restartServer()
  await h.queue.resolveHolds('alpha', [{ seq: 2, outcome: 'withdrawn', at: h.clock.now() }])
  await h.preparation.recover()
  for (const item of h.queue.items('alpha')) await h.preparation.prepare('alpha', item)
  await h.advance(RETYPE_BACKOFF_MS[0])
  expect(h.order).not.toContain('lookup')
  expect(h.records().filter(r => r.kind === 'fixed')).toEqual([])
  expect(h.preparation.owns('alpha', 1)).toBe(false)
  expect(h.preparation.owns('alpha', 2)).toBe(false)
  expect(h.keyCalls()).toEqual([])

  await h.queue.resolveHolds('alpha', [{ seq: 1, outcome: 'released', at: h.clock.now() }])
  h.failAppend('fixed')
  await h.preparation.recover()
  expect(h.preparation.owns('alpha', 1)).toBe(true)
  expect(h.preparation.owns('alpha', 2)).toBe(false)
  expect(h.queue.item('alpha', 1)?.fixed).toBeUndefined()
  await h.accept('later')
  await h.tick()
  await h.advance(RETYPE_BACKOFF_MS[0] - 1)
  expect(h.keyCalls()).toEqual([])
  expect(h.queue.item('alpha', 1)?.fixed).toBeUndefined()
  await h.until(() => h.queue.openCount('alpha') === 0)
  expect(h.records().filter(r => r.kind === 'fixed').map(r => r.seq)).toEqual([3, 1])
  expect(h.events.filter(e => e.type === 'item-delivered').map(e => e.seq)).toEqual([1, 3])
  expect(h.order.filter(entry => entry === 'lookup')).toHaveLength(1)
  expect(h.queue.item('alpha', 2)?.fixed).toBeUndefined()
  expect(h.preparation.owns('alpha', 1)).toBe(false)
  expect(h.errors).toEqual([])
})

test.each(['slack-post-ack', 'injected', 'startup-accepted-only'] as const)('%s autonomously retries fixation, preserving ack and FIFO boundaries', async source => {
  const h = await makeEngineHarness(); harnesses.push(h)
  h.failAppend('fixed')
  if (source === 'slack-post-ack') {
    const config = makeMultiPersonaConfig([{ name: 'alpha', key: 'alpha' }], h.root)
    const choices = createChannelDeliveryStore(makeSharedAuthority(h.root, { ...config,
      personas: config.personas.map(({ key, index, sections, ...persona }) => persona),
    }))
    const routing = createPersonaRouting({
      getChannelDelivery: () => choices, membership: observedMembership({ alpha: ['C0TEST001'] }),
      queue: h.queue, prepare: h.preparation.prepare, getPersonaConfig: () => config,
      getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }),
      archive: () => {}, log: line => h.order.push(line), isPersonaUp: () => true,
      readRowLiveness: async () => { h.order.push('row-read'); return { kind: 'live' } }, now: h.clock.now,
    })
    await routing.receive(makeChannelMessage({ channel: config.personas[0]!.channels[0]!.id, user: 'U0SENDER1', text: 'first' }), () => {
      expect(h.records().filter(r => r.kind === 'accepted')).toHaveLength(1)
      expect(h.order).not.toContain('lookup')
      expect(h.calls).toEqual([])
      h.order.push('ack')
    }, 'alpha')
    expect(h.order.indexOf('ack')).toBeLessThan(h.order.indexOf('lookup'))
    expect(h.order.indexOf('ack')).toBeLessThan(h.order.indexOf('row-read'))
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
