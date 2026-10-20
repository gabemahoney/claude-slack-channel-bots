/** b.omv SR-8.7: durable final receipts trigger reactions through the owning app. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { _resetAckTracker, addDeliveryAck, consumeAck, createDeliveryAckCallback, forgetPersonaAcks } from '../src/ack-tracker.ts'
import { buildDeliveryDiagnostic, buildDeliveryDispatchLine, createDeliveryReporting, deliveryIdentity, MESSAGE_DELIVERED } from '../src/delivery-notices.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { makeDeliveryNoticeHarness, type DeliveryNoticeHarness } from './test-helpers/delivery-notices.ts'
import { slackInput } from './test-helpers/delivery-queue.ts'
const engines: EngineHarness[] = [], notices: DeliveryNoticeHarness[] = []
beforeEach(_resetAckTracker)
afterEach(async () => { for (const n of notices.splice(0)) { assertNoLeak({ logs: n.logs, posts: n.h.allPosts() }); await n.cleanup() }; for (const e of engines.splice(0)) await e.cleanup(); _resetAckTracker() })

async function setup() {
  let reporting: ReturnType<typeof createDeliveryReporting> | undefined
  const e = await makeEngineHarness({ onEvent: event => reporting?.engineEvent(event) }); engines.push(e)
  const n = await makeDeliveryNoticeHarness({ queue: e.queue }); notices.push(n)
  reporting = createDeliveryReporting({ queue: e.queue, episodes: n.rig.episodes, persona: key => n.config.personas.find(p => p.key === key), state: () => ({ up: true }),
    log: line => n.logs.push(line), notify: (key, text) => n.h.notifier.notify(key, text),
    delivered: createDeliveryAckCallback({ getReaction: () => 'white_check_mark', clientFor: key => n.h.stub(key).web }),
  })
  return { e, n, reporting }
}
test.each([false, true])('multipart receipt adds only after the final durable part; early successful reply=%p', async early => {
  const { e, n, reporting } = await setup()
  const result = await e.queue.accept('alpha', slackInput({ text: 'ordinary private body' }))
  if (result.status === 'failed') throw new Error('store failed')
  await e.queue.append('alpha', { v: 1, kind: 'fixed', seq: result.seq, parts: ['one', 'two'] })
  if (early) expect(consumeAck('alpha', 'C0TEST001', result.item!.accepted.ts)).toBe(false)
  expect(n.h.stub('alpha').calls.reactionsAdd).toEqual([])
  await e.tick(); await e.until(() => e.events.some(event => event.type === 'delivered'))
  expect(n.h.stub('alpha').calls.reactionsAdd).toEqual([])
  expect(n.logs.filter(line => line.includes(MESSAGE_DELIVERED))).toEqual([])
  await e.until(() => e.queue.openCount('alpha') === 0); await n.flush()
  reporting.engineEvent(e.events.find(event => event.type === 'item-delivered')!)
  await n.flush()
  expect(n.logs.filter(line => line.includes(MESSAGE_DELIVERED))).toEqual([buildDeliveryDiagnostic(MESSAGE_DELIVERED, n.ref(), deliveryIdentity(result.item!.accepted), `at=${e.events.find(event => event.type === 'item-delivered')!.at} wait_ms=${e.events.find(event => event.type === 'item-delivered')!.waitMs}`)])
  expect(n.h.stub('alpha').calls.reactionsAdd).toEqual(early ? [] : [{ channel: 'C0TEST001', timestamp: result.item!.accepted.ts, name: 'white_check_mark' }])
  expect(n.h.stub('beta').calls.reactionsAdd).toEqual([])
  expect(n.h.stub('beta').calls.reactionsRemove).toEqual([])
  expect(n.logs.filter(line => line.startsWith('[slack] dispatch:'))).toEqual([buildDeliveryDispatchLine(n.ref(), result.item!.accepted)])
  expect(n.logs.join('')).not.toContain('hasGetStream')
  expect(JSON.stringify(n.logs.filter(line => !line.startsWith('[slack] dispatch:')))).not.toContain('ordinary private body')
})

test.each(['configured', 'disabled', 'no-client', 'injected', 'incomplete'] as const)('production delivery callback: %s', async kind => {
  const { e, n } = await setup()
  const result = await e.queue.accept('beta', slackInput({ channel: 'C0OTHER01', ts: '1700000099.000003', key: { chat_id: 'C0OTHER01', ts: '1700000099.000003' } }))
  if (result.status === 'failed' || !result.item) throw new Error('store failed')
  const item = { ...result.item, delivered: kind !== 'incomplete', accepted: { ...result.item.accepted, ...(kind === 'injected' ? { source: 'cron' as const, channel: undefined, sender: 'scheduled' } : {}) } }
  let reaction: string | undefined = 'hourglass'
  const clientKeys: string[] = []
  const delivered = createDeliveryAckCallback({ getReaction: () => reaction, clientFor: key => { clientKeys.push(key); return kind === 'no-client' ? undefined : n.h.stub(key).web } })
  // Settings are consulted on delivery, including a change after construction.
  reaction = kind === 'disabled' ? undefined : 'white_check_mark'
  await delivered('beta', item)
  const args = { channel: 'C0OTHER01', timestamp: '1700000099.000003', name: 'white_check_mark' }
  expect(n.h.stub('beta').calls.reactionsAdd).toEqual(kind === 'configured' ? [args] : [])
  expect(n.h.stub('alpha').calls.reactionsAdd).toEqual([])
  expect(n.h.stub('alpha').calls.reactionsRemove).toEqual([])
  expect(n.h.stub('beta').calls.reactionsRemove).toEqual([])
  expect(clientKeys).toEqual(kind === 'configured' || kind === 'no-client' ? ['beta'] : [])
  expect(consumeAck('beta', args.channel, args.timestamp)).toBe(kind === 'configured')
})

test('injected prompts complete without a Slack reaction', async () => {
  const { e, n } = await setup()
  await e.accept('injected')
  await e.tick(); await e.until(() => e.queue.openCount('alpha') === 0); await n.flush()
  expect(n.h.stub('alpha').calls.reactionsAdd).toEqual([])
  expect(n.h.stub('beta').calls.reactionsAdd).toEqual([])
})

test.each(['reply', 'teardown'] as const)('%s racing an add removes it after Slack settles, and duplicate adds share one call', async race => {
  let resolve!: () => void
  const hold = new Promise<void>(done => { resolve = done })
  const calls: string[] = []
  const args = { channel: 'C0TEST001', timestamp: '1', name: 'white_check_mark' }
  const item = { accepted: { ...slackInput({ ts: '1' }), v: 1 as const, kind: 'accepted' as const, seq: 1, received_at: 0, ts: '1' }, records: [], delivered: true, unknownSend: false, retypeCount: 0, nextAttempt: 1 }
  const delivered = createDeliveryAckCallback({ getReaction: () => args.name, clientFor: key => {
    expect(key).toBe('alpha')
    return { reactions: {
      add: async got => { expect(got).toEqual(args); calls.push('add'); await hold },
      remove: async got => { expect(got).toEqual(args); calls.push('remove') },
    } }
  } })
  const add = () => delivered('alpha', item)
  const first = add(), second = add()
  await Promise.resolve()
  expect(calls).toEqual(['add'])
  if (race === 'reply') expect(consumeAck('alpha', 'C0TEST001', '1')).toBe(true)
  else forgetPersonaAcks('alpha')
  resolve(); await Promise.all([first, second])
  expect(calls).toEqual(['add', 'remove'])
  if (race === 'reply') { await add(); expect(calls).toEqual(['add', 'remove']) }
})
test('reaction rejection is non-critical and does not retain a phantom ack', async () => {
  await addDeliveryAck('alpha', 'C0TEST001', '1', async () => { throw new Error('Slack refused') }, async () => {})
  expect(consumeAck('alpha', 'C0TEST001', '1')).toBe(false)
})

test('Slack reaction failure cannot block the delivered item or its FIFO successor', async () => {
  const { e, n } = await setup()
  n.h.stub('alpha').web.reactions.add = async () => { throw new Error('Slack refused') }
  const accepted = await e.queue.accept('alpha', slackInput())
  if (accepted.status === 'failed') throw new Error('store failed')
  await e.queue.append('alpha', { v: 1, kind: 'fixed', seq: accepted.seq, parts: ['first'] })
  await e.accept('successor')
  await e.tick(); await e.until(() => e.queue.openCount('alpha') === 0); await n.flush()
  expect(e.events.filter(event => event.type === 'item-delivered').map(event => event.seq)).toEqual([1, 2])
  expect(e.textCalls().map(call => call.params.text)).toEqual(['first', 'successor'])
  expect(consumeAck('alpha', 'C0TEST001', accepted.item!.accepted.ts)).toBe(false)
  expect(n.h.stub('beta').calls.reactionsAdd).toEqual([])
})
