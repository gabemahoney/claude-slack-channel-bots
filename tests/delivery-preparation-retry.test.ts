/** Accepted work survives a failed first fixed append without another event
 * or restart; the unfixed head still owns the FIFO. */
import { afterEach, describe, expect, test } from 'bun:test'
import { createDeliveryPreparation, type DeliveryPreparation } from '../src/delivery-intake.ts'
import type { ReactionAcceptedInput } from '../src/delivery-queue.ts'
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

function reactionInput(overrides: Partial<ReactionAcceptedInput> = {}): ReactionAcceptedInput {
  const fields = { channel: 'C0TEST001', message_ts: '1700000000.000001', ts: '1700000000.000002', change: 'added' as const, emoji: 'thumbsup', user: 'U0REACTOR', ...overrides }
  return { source: 'reaction', text: '', origin: 'slack-event', mode: 'declarative', ...fields, reaction_key: { chat_id: fields.channel, message_ts: fields.message_ts, reactor: fields.user || fields.bot_id || '', emoji: fields.emoji, change: fields.change, event_ts: fields.ts } }
}

describe('closed and fixed reaction preparation recovery', () => {
  const preparations: DeliveryPreparation[] = []
  afterEach(async () => { for (const preparation of preparations.splice(0)) await preparation.stop() })
  /** Real preparation with spied lookups over the harness queue, clock and engine. */
  function spied(h: EngineHarness) {
    const lookups: string[] = [], wakes: string[] = []
    const preparation = createDeliveryPreparation({ queue: h.queue, clock: h.clock,
      resolveUserName: async (_key, user) => { lookups.push(`user:${user}`); return 'sender' },
      clientFor: key => { lookups.push(`client:${key}`); return undefined },
      wake: key => { wakes.push(key); h.engine.wake(key) },
    })
    preparations.push(preparation)
    return { preparation, lookups, wakes }
  }
  async function acceptReaction(h: EngineHarness, overrides: Partial<ReactionAcceptedInput> = {}) {
    const result = await h.queue.accept('alpha', reactionInput(overrides))
    if (result.status !== 'accepted') throw new Error('fixture reaction acceptance failed')
    return result.item!
  }

  test.each(['recover live', 'recover reopened', 'prepare a stale snapshot'] as const)('a durably withdrawn reaction: %s causes no lookup, fixation, retry or wake', async via => {
    const h = await makeEngineHarness(); harnesses.push(h)
    const stale = await acceptReaction(h)
    await h.queue.append('alpha', { v: 1, kind: 'withdrawn', seq: 1, reason: 'server-post', at: h.clock.now() })
    if (via === 'recover reopened') await h.restartServer()
    const s = spied(h), journal = h.records(), timers = h.clock.pendingCount()
    if (via === 'prepare a stale snapshot') await s.preparation.prepare('alpha', stale)
    else await s.preparation.recover()
    await h.clock.flush()
    expect(s.preparation.owns('alpha', 1)).toBe(false)
    expect(h.clock.pendingCount()).toBe(timers)
    await h.clock.advance(RETYPE_BACKOFF_MS.at(-1)! * 2)
    expect(s.lookups).toEqual([])
    expect(s.wakes).toEqual([])
    expect(h.records()).toEqual(journal)
    expect(h.queue.openCount('alpha')).toBe(0)
    expect(h.queue.item('alpha', 1)?.fixed).toBeUndefined()
  })

  test.each(['recover', 'prepare a stale snapshot'] as const)('a durably fixed reaction keeps its exact parts through reopen and %s, without lookups, and its wake delivers them', async via => {
    const h = await makeEngineHarness(); harnesses.push(h)
    const parts = ['reaction part one 🙂', 'reaction part two']
    const fixed = { v: 1, kind: 'fixed', seq: 1, parts } as const
    const stale = await acceptReaction(h, { origin: 'bot-tool', reactor_persona_name: 'Reactor Bot', user: undefined, bot_id: 'B0BOT001' })
    await h.queue.append('alpha', { ...fixed, parts: [...parts] })
    await h.restartServer()
    const s = spied(h)
    if (via === 'recover') await s.preparation.recover()
    else await s.preparation.prepare('alpha', stale)
    expect(s.lookups).toEqual([])
    expect(s.wakes).toEqual(['alpha'])
    expect(s.preparation.owns('alpha', 1)).toBe(false)
    expect(h.queue.item('alpha', 1)!.fixed).toEqual(fixed)
    await h.until(() => h.queue.openCount('alpha') === 0)
    expect(h.textCalls().map(c => c.params.text)).toEqual(parts)
    expect(h.records().filter(r => r.kind === 'fixed')).toEqual([fixed])
    expect(s.lookups).toEqual([])
    expect(h.errors).toEqual([])
  })
})
