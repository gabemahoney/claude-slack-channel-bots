/** durable final receipts trigger reactions through the owning app. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { _resetAckTracker, addDeliveryAck, consumeAck, createQueuedAckCallback, createDeliveryAckCallback, forgetPersonaAcks } from '../src/ack-tracker.ts'
import { buildDeliveryDiagnostic, buildDeliveryDispatchLine, createDeliveryReporting, deliveryIdentity, MESSAGE_DELIVERED, MESSAGE_RECEIVED } from '../src/delivery-notices.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { makeDeliveryNoticeHarness, type DeliveryNoticeHarness } from './test-helpers/delivery-notices.ts'
import { slackInput } from './test-helpers/delivery-queue.ts'
import { makeQueuedAckHarness, type QueuedAckHarness } from './test-helpers/queued-ack.ts'
import { makeStubSlack } from './test-helpers/slack-stub.ts'
const engines: EngineHarness[] = [], notices: DeliveryNoticeHarness[] = []
const queuedHarnesses: QueuedAckHarness[] = []
beforeEach(_resetAckTracker)
afterEach(async () => { for (const h of queuedHarnesses.splice(0)) await h.cleanup(); for (const n of notices.splice(0)) { assertNoLeak({ logs: n.logs, posts: n.h.allPosts() }); await n.cleanup() }; for (const e of engines.splice(0)) await e.cleanup(); _resetAckTracker() })

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

async function queuedSetup() {
  const h = await makeQueuedAckHarness(); queuedHarnesses.push(h)
  return h
}
function expectOnlyOneStage(h: QueuedAckHarness) {
  expect(h.snapshots.filter(snapshot => snapshot.names.length > 1)).toEqual([])
}
async function flushUntil(h: QueuedAckHarness, condition: () => boolean) {
  // Bound the fixture's promise turns, without advancing time or releasing held work.
  for (let turn = 0; turn < 20 && !condition(); turn++) await h.e.clock.flush()
  expect(condition()).toBe(true)
}

test('durable acceptance adds queued while AD working, after envelope ack and before any keys', async () => {
  const h = await queuedSetup()
  let adoptions = 0
  const remember = h.e.queue.rememberQueuedReaction
  h.e.queue.rememberQueuedReaction = (...args) => { adoptions++; return remember(...args) }
  await h.receive()
  expect(h.item().accepted.queued_ack_reaction).toBe(h.settings.queued_ack_reaction)
  expect(adoptions).toBe(0)
  expect(h.e.records().filter(record => record.kind === 'accepted')).toHaveLength(1)
  expect(h.envelopeAcks).toBe(1)
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  expect(h.stub().calls.reactionsAdd).toEqual([{ channel: h.event.channel, timestamp: h.event.ts, name: h.settings.queued_ack_reaction }])
  expect(h.order.indexOf('store:alpha:accepted')).toBeLessThan(h.order.indexOf('envelope-ack'))
  expect(h.order.indexOf('envelope-ack')).toBeLessThan(h.order.indexOf(`add:alpha:${h.settings.queued_ack_reaction}`))
  await h.e.advance(60_000)
  expect(h.e.queue.openCount('alpha')).toBe(1)
  expect(h.e.keyCalls()).toEqual([])
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  expect(h.stub('beta').calls.reactionsAdd).toEqual([])
})

test('successful send/receipt without durable delivered append keeps queued; final durable receipt replaces it', async () => {
  const h = await queuedSetup()
  await h.receive()
  h.e.failAppend('delivered')
  h.e.p().row.state = 'waiting'
  await h.e.tick()
  await h.e.until(() => h.e.errors.length > 0)
  expect(h.e.keyCalls().length).toBeGreaterThanOrEqual(2)
  expect(h.e.records().filter(record => record.kind === 'delivered')).toEqual([])
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual([h.settings.queued_ack_reaction])
  await h.deliver()
  expect(h.e.records().filter(record => record.kind === 'delivered')).toHaveLength(1)
  expect(h.visible()).toEqual([h.settings.ack_reaction])
  expect(h.order.filter(step => /^(add|remove):/.test(step))).toEqual([
    `add:alpha:${h.settings.queued_ack_reaction}`, `remove:alpha:${h.settings.queued_ack_reaction}`, `add:alpha:${h.settings.ack_reaction}`,
  ])
  expectOnlyOneStage(h)
})

test('failed acceptance has no visible or envelope acknowledgement; the successful retry does', async () => {
  const h = await queuedSetup()
  h.failures.add('alpha')
  await h.receive()
  expect(h.envelopeAcks).toBe(0)
  expect(h.e.queue.openCount('alpha')).toBe(0)
  expect(h.stub().calls.reactionsAdd).toEqual([])
  h.failures.delete('alpha')
  await h.receive()
  expect(h.envelopeAcks).toBe(1)
  expect(h.e.records().filter(record => record.kind === 'accepted')).toHaveLength(1)
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
})

test('partial fanout acknowledges the retained target even while a sibling store suppresses aggregate ack', async () => {
  const h = await queuedSetup()
  h.failures.add('beta')
  let aggregateAcks = 0
  await h.routing.receive(h.event, async () => { aggregateAcks++ }, ['alpha', 'beta'])
  await h.e.clock.flush()
  expect(aggregateAcks).toBe(0)
  expect(h.e.queue.openCount('alpha')).toBe(1)
  expect(h.e.queue.openCount('beta')).toBe(0)
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  expect(h.stub('beta').calls.reactionsAdd).toEqual([])
  h.failures.delete('beta')
  await h.routing.receive(h.event, async () => { aggregateAcks++ }, ['alpha', 'beta'])
  await h.e.clock.flush()
  expect(aggregateAcks).toBe(1)
  for (const key of ['alpha', 'beta']) {
    expect(h.e.records(key).filter(record => record.kind === 'accepted')).toHaveLength(1)
    expect(h.stub(key).calls.reactionsAdd.map(call => call.name)).toEqual([h.settings.queued_ack_reaction])
    expect(h.item(key).fixed).toBeDefined()
  }
})

test('concurrent duplicate envelopes and received/delivered notifications never repeat a stage', async () => {
  const h = await queuedSetup()
  await Promise.all([h.receive(), h.receive(), h.receive()])
  h.reporting.received('alpha', h.item()); h.reporting.received('alpha', h.item())
  await h.e.clock.flush()
  expect(h.e.records().filter(record => record.kind === 'accepted')).toHaveLength(1)
  expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual([h.settings.queued_ack_reaction])
  const staleAccepted = { ...h.item() }
  await h.deliver()
  const delivered = h.e.events.find(event => event.type === 'item-delivered')!
  h.reporting.engineEvent(delivered); h.reporting.engineEvent(delivered)
  await h.receive()
  await createQueuedAckCallback({ getReaction: () => h.settings.queued_ack_reaction, clientFor: key => h.stub(key).web })('alpha', staleAccepted)
  expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual([h.settings.queued_ack_reaction, h.settings.ack_reaction])
  expectOnlyOneStage(h)
})

test.each(['queued', 'delivered'] as const)('first successful correlated reply clears %s and later delivery/redelivery cannot resurrect it', async stage => {
  const h = await queuedSetup()
  await h.receive()
  if (stage === 'delivered') await h.deliver()
  const name = stage === 'queued' ? h.settings.queued_ack_reaction : h.settings.ack_reaction
  expect(h.visible()).toEqual([name])
  expect((await h.reply()).isError).toBeUndefined()
  expect(h.visible()).toEqual([])
  expect(h.stub().calls.reactionsRemove.at(-1)).toEqual({ channel: h.event.channel, timestamp: h.event.ts, name })
  const count = h.stub().calls.reactionsRemove.length
  expect((await h.reply()).isError).toBeUndefined()
  expect(h.stub().calls.reactionsRemove).toHaveLength(count)
  await h.deliver(); await h.receive()
  h.reporting.received('alpha', h.item())
  h.reporting.engineEvent(h.e.events.find(event => event.type === 'item-delivered')!)
  await h.e.clock.flush()
  expect(h.visible()).toEqual([])
  expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual(stage === 'queued'
    ? [h.settings.queued_ack_reaction] : [h.settings.queued_ack_reaction, h.settings.ack_reaction])
  expectOnlyOneStage(h)
})

test('a failed reply preserves queued, and wrong message/persona correlation cannot clear another acknowledgement', async () => {
  const h = await queuedSetup()
  await h.receive(); await h.receive('beta')
  h.stub().script.post.push({ kind: 'platform', error: 'not_in_channel' })
  expect((await h.reply()).isError).toBe(true)
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  await h.reply({ message_id: '1700000000.999999' })
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  await h.reply({}, 'beta')
  expect(h.visible('beta')).toEqual([])
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  await h.reply()
  expect(h.visible()).toEqual([])
})

test.each(['queued-add', 'queued-remove', 'delivered-add'].flatMap(point => ['reply', 'teardown'].map(race => ({ point, race }))))(
  '$race during $point leaves no reaction when held Slack work settles', async ({ point, race }) => {
    const h = await queuedSetup()
    const held = point === 'queued-add' ? h.hold('reactionsAdd') : undefined
    await h.receive()
    expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual([h.settings.queued_ack_reaction])
    const transition = held ?? h.hold(point === 'queued-remove' ? 'reactionsRemove' : 'reactionsAdd')
    await h.deliver()
    if (point !== 'delivered-add') expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual([h.settings.queued_ack_reaction])
    else expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual([h.settings.queued_ack_reaction, h.settings.ack_reaction])
    // A reply may await serialized cleanup. Start it, let the successful post
    // run, then release the held reaction; do not force reply completion early.
    const reply = race === 'reply' ? h.reply() : undefined
    if (race === 'teardown') forgetPersonaAcks('alpha')
    await h.e.clock.flush()
    if (race === 'reply') expect(h.stub().calls.postMessage).toHaveLength(1)
    transition.settle()
    await reply
    await h.e.clock.flush()
    expect(h.visible()).toEqual([])
    expectOnlyOneStage(h)
  },
)

test('failed queued removal never adds a second visible stage, blocks no delivery, and reply can still clear queued', async () => {
  const h = await queuedSetup()
  await h.receive()
  h.stub().script.reactionsRemove.push({ kind: 'platform', error: 'not_in_channel' })
  await h.deliver()
  expect(h.e.queue.openCount('alpha')).toBe(0)
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual([h.settings.queued_ack_reaction])
  expect((await h.reply()).isError).toBeUndefined()
  expect(h.visible()).toEqual([])
  expectOnlyOneStage(h)
})

test.each(['queued', 'delivered'] as const)('Slack %s add rejection cannot block the FIFO or another persona', async stage => {
  const h = await queuedSetup()
  if (stage === 'queued') h.stub().script.reactionsAdd.push({ kind: 'platform', error: 'invalid_name' })
  await h.receive()
  await h.receive('alpha', { ts: '1700000000.000002', text: 'successor' })
  await h.receive('beta')
  if (stage === 'delivered') h.stub().script.reactionsAdd.push({ kind: 'platform', error: 'invalid_name' })
  await h.deliver(); await h.deliver('beta')
  expect(h.e.events.flatMap(event => event.type === 'item-delivered' && event.key === 'alpha' ? [event.seq] : [])).toEqual([1, 2])
  expect(h.e.queue.openCount('beta')).toBe(0)
  expect(h.visible('beta')).toEqual([h.settings.ack_reaction])
  expect(h.stub().calls.reactionsAdd.some(call => call.name === h.settings.queued_ack_reaction)).toBe(true)
  expectOnlyOneStage(h)
})

test('stalled queued Slack add does not block envelope ack, FIFO delivery or a sibling persona', async () => {
  const h = await queuedSetup(), held = h.hold('reactionsAdd')
  await h.receive()
  expect(h.envelopeAcks).toBe(1)
  expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual([h.settings.queued_ack_reaction])
  await h.receive('alpha', { ts: '1700000000.000002', text: 'successor' })
  await h.receive('beta')
  await h.deliver(); await h.deliver('beta')
  expect(h.e.queue.openCount('alpha')).toBe(0)
  expect(h.e.queue.openCount('beta')).toBe(0)
  expect(h.visible('beta')).toEqual([h.settings.ack_reaction])
  held.settle(); await h.e.clock.flush()
  expect(h.visible()).toEqual([h.settings.ack_reaction])
  expectOnlyOneStage(h)
})

test('identical stage emojis keep one reaction through delivery and remove it on reply', async () => {
  const h = await queuedSetup()
  h.settings.queued_ack_reaction = h.settings.ack_reaction = 'same_stage'
  await h.receive(); await h.deliver()
  expect(h.item().accepted.queued_ack_reaction).toBe('same_stage')
  expect(h.visible()).toEqual(['same_stage'])
  expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual(['same_stage'])
  expect(h.stub().calls.reactionsRemove).toEqual([])
  await h.reply()
  expect(h.visible()).toEqual([])
  expect(h.stub().calls.reactionsRemove.map(call => call.name)).toEqual(['same_stage'])
  expectOnlyOneStage(h)
})

test.each(['queued', 'delivered'] as const)('reply removes captured %s emoji on its original client after settings/client change', async stage => {
  const h = await queuedSetup()
  await h.receive()
  if (stage === 'delivered') await h.deliver()
  const name = stage === 'queued' ? h.settings.queued_ack_reaction : h.settings.ack_reaction
  const removedBefore = h.stub().calls.reactionsRemove.length
  h.settings.queued_ack_reaction = 'next_queue'
  h.settings.ack_reaction = 'next_delivery'
  const replacement = makeStubSlack()
  h.clientOverrides.set('alpha', replacement.web)
  expect((await h.reply()).isError).toBeUndefined()
  expect(replacement.calls.postMessage).toHaveLength(1)
  expect(replacement.calls.reactionsRemove).toEqual([])
  expect(h.stub().calls.reactionsRemove.slice(removedBefore)).toEqual([{ channel: h.event.channel, timestamp: h.event.ts, name }])
  expect(h.visible()).toEqual([])
  if (stage === 'queued') await h.deliver()
  expect(replacement.calls.reactionsAdd).toEqual([])
  expect(h.stub('beta').calls.reactionsRemove).toEqual([])
})

test('delivery removes the captured queued emoji before adding the currently configured delivered emoji', async () => {
  const h = await queuedSetup()
  await h.receive()
  const queuedName = h.settings.queued_ack_reaction
  h.settings.queued_ack_reaction = 'next_queue'
  h.settings.ack_reaction = 'next_delivery'
  await h.deliver()
  expect(h.order.filter(step => /^(add|remove):/.test(step))).toEqual([
    `add:alpha:${queuedName}`, `remove:alpha:${queuedName}`, 'add:alpha:next_delivery',
  ])
  expect(h.visible()).toEqual(['next_delivery'])
  expectOnlyOneStage(h)
})

test('teardown and reacceptance serialize old cleanup before the new life reaction', async () => {
  const h = await queuedSetup(), held = h.hold('reactionsAdd')
  await h.receive()
  forgetPersonaAcks('alpha')
  const newLife = createQueuedAckCallback({ getReaction: () => h.settings.queued_ack_reaction, clientFor: key => h.stub(key).web })('alpha', h.item())
  await h.e.clock.flush()
  expect(h.stub().calls.reactionsAdd).toHaveLength(1)
  held.settle(); await newLife
  expect(h.order.filter(step => /^(add|remove):/.test(step))).toEqual([
    `add:alpha:${h.settings.queued_ack_reaction}`, `remove:alpha:${h.settings.queued_ack_reaction}`, `add:alpha:${h.settings.queued_ack_reaction}`,
  ])
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  await h.reply()
  expect(h.visible()).toEqual([])
  expectOnlyOneStage(h)
})

test.each([
  { outcome: { kind: 'network' as const }, applied: true },
  { outcome: { kind: 'http' as const, status: 503 }, applied: false },
])('ambiguous add $outcome.kind (applied=$applied) requires removal before replacement, even after removal failure', async ({ outcome, applied }) => {
  const h = await queuedSetup(), held = h.hold('reactionsAdd')
  await h.receive()
  const args = { channel: h.event.channel, timestamp: h.event.ts, name: h.settings.queued_ack_reaction }
  // The same lost response can mean Slack changed state or did nothing.
  if (applied) h.applyReaction('alpha', 'add', args)
  held.settle(outcome); await h.e.clock.flush()
  h.stub().script.reactionsRemove.push({ kind: 'platform', error: 'not_in_channel' })
  await h.deliver()
  expect(h.stub().calls.reactionsRemove).toEqual([args])
  expect(h.stub().calls.reactionsAdd).toEqual([args])
  expect(h.visible()).toEqual(applied ? [args.name] : [])
  expect(h.e.queue.openCount('alpha')).toBe(0)
  expect((await h.reply()).isError).toBeUndefined()
  expect(h.stub().calls.reactionsRemove).toEqual([args, args])
  expect(h.visible()).toEqual([])
  expectOnlyOneStage(h)
})

test('already_reacted retains cleanup ownership; no_reaction allows the next stage', async () => {
  const h = await queuedSetup()
  const args = { channel: h.event.channel, timestamp: h.event.ts, name: h.settings.queued_ack_reaction }
  h.applyReaction('alpha', 'add', args)
  h.stub().script.reactionsAdd.push({ kind: 'platform', error: 'already_reacted' })
  await h.receive()
  expect(h.visible()).toEqual([args.name])
  // Slack lost the reaction externally before CSCB attempted replacement.
  h.applyReaction('alpha', 'remove', args)
  h.stub().script.reactionsRemove.push({ kind: 'platform', error: 'no_reaction' })
  await h.deliver()
  expect(h.stub().calls.reactionsRemove).toEqual([args])
  expect(h.visible()).toEqual([h.settings.ack_reaction])
  await h.reply()
  expect(h.visible()).toEqual([])
  expectOnlyOneStage(h)
})

test('multipart work stays queued until the last durable receipt', async () => {
  const h = await queuedSetup()
  const result = await h.e.queue.accept('alpha', slackInput({ channel: h.event.channel, ts: h.event.ts, key: { chat_id: h.event.channel, ts: h.event.ts } }))
  if (result.status === 'failed' || !result.item) throw new Error('store failed')
  await h.e.queue.append('alpha', { v: 1, kind: 'fixed', seq: result.seq, parts: ['first part', 'second part'] })
  h.reporting.received('alpha', result.item)
  await h.e.clock.flush()
  h.e.p().row.state = 'waiting'
  await h.e.tick(); await h.e.until(() => h.e.events.some(event => event.type === 'delivered'))
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  expect(h.stub().calls.reactionsRemove).toEqual([])
  await h.e.until(() => h.e.queue.openCount('alpha') === 0); await h.e.clock.flush()
  expect(h.visible()).toEqual([h.settings.ack_reaction])
  expect(h.e.records().filter(record => record.kind === 'delivered')).toHaveLength(2)
  expectOnlyOneStage(h)
})

test.each([false, true])('restart: retained sent work removes its actual queued emoji before recovered delivery (changed setting=%p)', async changed => {
  const h = await queuedSetup()
  await h.receive()
  h.e.failAppend('delivered')
  h.e.p().row.state = 'waiting'
  await h.e.tick(); await h.e.until(() => h.e.errors.length > 0)
  expect(h.e.records().some(record => record.kind === 'sent')).toBe(true)
  expect(h.e.records().some(record => record.kind === 'delivered')).toBe(false)
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  const accepted = structuredClone(h.item().accepted)
  const queuedName = h.settings.queued_ack_reaction
  if (changed) h.settings.queued_ack_reaction = 'next_queue'
  // Production wakes retained sent items before its final preparation.recover().
  await h.restartServer(false)
  expect(h.item().accepted).toMatchObject(JSON.parse(JSON.stringify(accepted)))
  await h.deliver()
  expect(h.e.queue.openCount('alpha')).toBe(0)
  const afterDelivery = h.visible()
  await h.reply()
  expect({ afterDelivery, afterReply: h.visible() }).toEqual({ afterDelivery: [h.settings.ack_reaction], afterReply: [] })
  expect(h.stub().calls.reactionsRemove).toContainEqual({ channel: h.event.channel, timestamp: h.event.ts, name: queuedName })
  expectOnlyOneStage(h)
})

test.each([false, true])('restart: startup recovery preserves one stage with a changed queued setting=%p', async changed => {
  const h = await queuedSetup()
  await h.receive()
  const accepted = structuredClone(h.item().accepted)
  if (changed) h.settings.queued_ack_reaction = 'next_queue'
  await h.restartServer()
  expect(h.item().accepted).toMatchObject(JSON.parse(JSON.stringify(accepted)))
  expect(h.e.keyCalls()).toEqual([])
  expectOnlyOneStage(h)
  await h.deliver()
  expect(h.visible()).toEqual([h.settings.ack_reaction])
  expectOnlyOneStage(h)
})

// The inherited early-reply marker is memory-only across server restarts.
// The restart cases above enforce the new one-stage contract without assuming
// durable reply-history storage (Main accepted that exception explicitly).

test('blocker: stalled queued add cannot hold remaining reply chunks, uploads or the tool result', async () => {
  const h = await queuedSetup(), held = h.hold('reactionsAdd')
  await h.receive()
  h.settings.reply_chunk_limit = 6
  h.settings.reply_chunk_mode = 'length'
  const file = join(h.e.root, 'reply.txt'); writeFileSync(file, 'attachment')
  let settled = false
  const reply = h.reply({ text: 'abcdefghijkl', files: [file] }).then(result => { settled = true; return result })
  try {
    await flushUntil(h, () => settled)
    expect(held.settled).toBe(false)
    expect(h.stub().calls.postMessage.map(call => 'text' in call ? call.text : undefined)).toEqual(['abcdef', 'ghijkl'])
    expect(h.stub().calls.filesUploadV2).toHaveLength(1)
    expect((await reply).isError).toBeUndefined()
  } finally {
    // Release even on failure, but only after checking completion while held.
    held.settle()
    await reply
  }
  await h.e.clock.flush()
  expect(h.visible()).toEqual([])
  expectOnlyOneStage(h)
})

test('blocker: reporting forget plus tracker forget restores queued feedback on same-key recovery', async () => {
  const h = await queuedSetup()
  await h.receive()
  const accepted = structuredClone(h.item().accepted)
  const receivedLogs = h.n.logs.filter(line => line.includes(MESSAGE_RECEIVED)).length
  h.reporting.forget('alpha'); forgetPersonaAcks('alpha')
  await h.e.clock.flush()
  expect(h.visible()).toEqual([])
  await h.recover()
  expect(h.item().accepted).toEqual(accepted)
  expect(h.e.keyCalls()).toEqual([])
  expect(h.n.logs.filter(line => line.includes(MESSAGE_RECEIVED))).toHaveLength(receivedLogs)
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  await h.recover()
  expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual([h.settings.queued_ack_reaction, h.settings.queued_ack_reaction])
  expectOnlyOneStage(h)
})

test('blocker: unavailable queued client is retried by recovery without duplicate received logs', async () => {
  const h = await queuedSetup()
  h.unavailableClients.add('alpha')
  await h.receive()
  expect(h.e.queue.openCount('alpha')).toBe(1)
  expect(h.stub().calls.reactionsAdd).toEqual([])
  const receivedLogs = h.n.logs.filter(line => line.includes(MESSAGE_RECEIVED)).length
  expect(receivedLogs).toBe(1)
  h.unavailableClients.delete('alpha')
  await h.recover()
  expect(h.n.logs.filter(line => line.includes(MESSAGE_RECEIVED))).toHaveLength(receivedLogs)
  expect(h.visible()).toEqual([h.settings.queued_ack_reaction])
  await h.recover()
  expect(h.stub().calls.reactionsAdd).toHaveLength(1)
  expect(h.e.keyCalls()).toEqual([])
})

test.each(['reply', 'teardown'] as const)('metadata: %s during legacy adoption cancels the old owner before any Slack add', async race => {
  const h = await queuedSetup(), gate = Promise.withResolvers<void>()
  const remember = h.e.queue.rememberQueuedReaction
  let entered = false
  h.e.queue.rememberQueuedReaction = async (...args) => {
    entered = true
    await gate.promise
    return remember(...args)
  }
  const accepted = await h.e.queue.accept('alpha', slackInput({ channel: h.event.channel, ts: h.event.ts, key: { chat_id: h.event.channel, ts: h.event.ts } }))
  if (accepted.status === 'failed' || !accepted.item) throw new Error('legacy store failed')
  const queued = createQueuedAckCallback({ queue: h.e.queue, getReaction: () => h.settings.queued_ack_reaction, clientFor: key => h.stub(key).web })
  const originalName = h.settings.queued_ack_reaction
  const oldLife = queued('alpha', accepted.item)
  let newLife: Promise<void> | undefined
  try {
    await flushUntil(h, () => entered)
    expect(h.item().accepted.queued_ack_reaction).toBeUndefined()
    expect(h.stub().calls.reactionsAdd).toEqual([])
    if (race === 'reply') {
      let settled = false
      const reply = h.reply().then(result => { settled = true; return result })
      await flushUntil(h, () => settled)
      expect((await reply).isError).toBeUndefined()
      expect(h.stub().calls.postMessage).toHaveLength(1)
    } else {
      forgetPersonaAcks('alpha')
      h.settings.queued_ack_reaction = 'next_life_queue'
      newLife = queued('alpha', h.item())
      await h.e.clock.flush()
    }
    expect(h.item().accepted.queued_ack_reaction).toBeUndefined()
    expect(h.stub().calls.reactionsAdd).toEqual([])
    expect(h.stub().calls.reactionsRemove).toEqual([])
  } finally {
    gate.resolve()
    await Promise.all([oldLife, newLife])
  }
  expect(h.item().accepted.queued_ack_reaction).toBe(originalName)
  expect(h.visible()).toEqual(race === 'reply' ? [] : [originalName])
  expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual(race === 'reply' ? [] : [originalName])
  // Old-life cleanup cannot remove the replacement owner's stage.
  expect(h.stub().calls.reactionsRemove).toEqual([])
  if (race === 'teardown') expect((await h.reply()).isError).toBeUndefined()
  await h.recover(); await h.deliver()
  expect(h.visible()).toEqual([])
  expect(h.stub().calls.reactionsAdd.map(call => call.name)).toEqual(race === 'reply' ? [] : [originalName])
  expectOnlyOneStage(h)
})
