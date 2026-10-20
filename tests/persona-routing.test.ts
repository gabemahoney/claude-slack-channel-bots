/** Durable Slack intake: decision wiring, persona isolation, ack boundary and immutable preparation. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebClient } from '@slack/web-api'
import { createPersonaRouting } from '../src/persona-routing.ts'
import { buildTagParts, NAME_LOOKUP_TIMEOUT_MS } from '../src/tag-wrapper.ts'
import { createDeliveryPreparation } from '../src/delivery-intake.ts'
import { sanitizeFilename } from '../src/lib.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeRoutingHarness, resetRoutingState, NEVER_FIRE_RESTART_DELAY_S, type RoutingHarness } from './test-helpers/persona-routing-harness.ts'
import { makeAppMention, makeChannelMessage, makeDm, makeBotMessage, makeWebhookPost, makeStubSlack, mentionText, ENVELOPE_FLAG_FORMS, type SlackEvent } from './test-helpers/slack-stub.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { readQueue, seedQueue, slackInput } from './test-helpers/delivery-queue.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeQueue } from './test-helpers/delivery-queue.ts'
import { isRestartPendingOrActive } from '../src/restart.ts'
const CA = 'C0TEST001', CB = 'C0TEST002', CS = 'C0SHARED1', CX = 'C0OTHER01'
let dir: string; let harnesses: RoutingHarness[]
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'routing-queue-')); harnesses = []; resetRoutingState() })
afterEach(async () => { for (const h of harnesses) { h.hold.cancelAll(); h.releaseLaunches(); await h.queue.stop(); assertNoLeak(h.captured()) }; resetRoutingState(); rmSync(dir, { recursive: true, force: true }) })
function harness(opts: Parameters<typeof makeRoutingHarness>[2] = {}) {
  const h = makeRoutingHarness([{ name: 'alpha', channels: [{ id: CA, delivery: 'all' }, { id: CS, delivery: 'mentions' }], dm: { enabled: true } }, { name: 'beta', channels: [{ id: CB, delivery: 'all' }, { id: CS, delivery: 'mentions' }] }], dir, { restartDelayS: NEVER_FIRE_RESTART_DELAY_S, ...opts }); harnesses.push(h); return h
}
const facts = (h: RoutingHarness, name: string) => h.queued(name).map(i => ({ channel: i.accepted.channel, ts: i.accepted.ts, via: i.accepted.via, text: i.accepted.text }))
async function each(h: RoutingHarness, event: unknown) { await h.receive(event, ['alpha']); await h.receive(event, ['beta']) }
describe('persona routing and durable dedupe', () => {
  test('home, shared mention and DM retain exact target, source and via with empty bystander queues', async () => {
    const h = harness(); const mention = mentionText(h.p('alpha').stub.identity.botUserId)
    const home = makeChannelMessage({ channel: CA, text: 'home' }); const shared = makeChannelMessage({ channel: CS, text: `${mention} shared` }); const dm = makeDm({ text: 'direct' })
    await each(h, home); await each(h, shared); await h.receive(dm, ['alpha'])
    expect(facts(h, 'alpha')).toEqual([{ channel: CA, ts: home.ts as string, via: 'receive_all', text: 'home' }, { channel: CS, ts: shared.ts as string, via: 'mention', text: shared.text as string }, { channel: dm.channel as string, ts: dm.ts as string, via: 'dm', text: 'direct' }]); expect(facts(h, 'beta')).toEqual([])
    expect(h.all.flatMap(p => p.notifications)).toEqual([]); expect(h.allPosts()).toEqual([]); expect(h.all.flatMap(p => p.stub.calls.reactionsAdd)).toEqual([])
  })
  test.each(['mention', 'receive_all', 'dm'] as const)('%s preserves a 5000-byte body through durable acceptance and multipart preparation', async via => {
    const h = harness()
    const body = '  ' + 'River stones, quiet paths; '.repeat(200).slice(0, 4997) + ' '
    expect(Buffer.byteLength(body)).toBe(5000)
    const text = via === 'receive_all' ? body : body.slice(0, 2) + mentionText(h.p('alpha').stub.identity.botUserId) + ' \t\n' + body.slice(2)
    const event = via === 'dm' ? makeDm({ text }) : makeChannelMessage({ channel: via === 'mention' ? CS : CA, text })
    await each(h, event)
    expect(facts(h, 'alpha')).toEqual([{ channel: event.channel as string, ts: event.ts as string, via, text }])
    expect(facts(h, 'beta')).toEqual([])
    const records = readQueue(dir, h.p('alpha').persona.key)
    expect(records.filter(record => record.kind === 'accepted')).toEqual([h.queued('alpha')[0]!.accepted])
    const parts = h.queued('alpha')[0]!.fixed!.parts
    expect(parts.length).toBeGreaterThan(1)
    expect(records.filter(record => record.kind === 'fixed')).toEqual([h.queued('alpha')[0]!.fixed!])
    expect(parts.map(part => /^<channel [^>]*>([\s\S]*)<\/channel>$/.exec(part)![1]!).join('')).toBe(text.replace(/\t/g, '    '))
    expect(h.allPosts()).toEqual([])
  })
  test.each([
    ['quoted mentions', 'mention', (own: string, labelled: string) => `  > "${own}"\r\n\tand \`${labelled}\`  `],
    ['repeated mentions', 'mention', (own: string, labelled: string) => ` ${own}  first\t${labelled}\n${own} last\r\n `],
    ['mention only', 'mention', (own: string) => own],
    ['mentions surrounded by whitespace', 'dm', (own: string, labelled: string) => ` \t${own} \n${labelled}\r\n `],
    ['whitespace only', 'receive_all', () => ' \t\r\n  \n'],
    ['empty text', 'receive_all', () => ''],
  ] as const)('preserves %s verbatim in durable acceptance before documented tag escaping', async (_label, via, makeText) => {
    const h = harness()
    const ownId = h.p('alpha').stub.identity.botUserId
    const text = makeText(mentionText(ownId), mentionText(ownId, 'alpha'))
    const event = via === 'dm' ? makeDm({ text }) : makeChannelMessage({ channel: via === 'mention' ? CS : CA, text })
    await each(h, event)
    expect(facts(h, 'alpha')).toEqual([{ channel: event.channel as string, ts: event.ts as string, via, text }])
    expect(facts(h, 'beta')).toEqual([])
    const item = h.queued('alpha')[0]!
    expect(readQueue(dir, h.p('alpha').persona.key).filter(record => record.kind === 'accepted')).toEqual([item.accepted])
    const bodies = item.fixed!.parts.map(part => /^<channel [^>]*>([\s\S]*)<\/channel>$/.exec(part)![1]!).join('')
    expect(bodies).toBe(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    '))
    expect(h.allPosts()).toEqual([])
  })
  test.each([false, true])('message/app_mention pair in either order accepts once (%p)', async mentionFirst => {
    const h = harness(); const text = `${mentionText(h.p('alpha').stub.identity.botUserId)} body`; const message = makeChannelMessage({ channel: CS, text }); const app = { ...message, type: 'app_mention' }
    await h.receive(mentionFirst ? app : message, ['alpha']); await h.receive(mentionFirst ? message : app, ['alpha'])
    expect(facts(h, 'alpha')).toEqual([{ channel: CS, ts: message.ts as string, via: 'mention', text }]); expect(facts(h, 'beta')).toEqual([]); expect(h.order.filter(s => s === 'ack')).toHaveLength(2)
  })
  test('edited.ts distinguishes an edit; forget keeps durable dedupe and original via through mode/config changes', async () => {
    const h = harness(); const event = makeChannelMessage({ channel: CA }); await h.receive(event, ['alpha']); h.forget('alpha'); await h.receive(event, ['alpha'])
    await h.receive({ ...event, edited: { ts: '1700000001.000001' } }, ['alpha'])
    expect(h.queued('alpha').map(i => i.accepted.key)).toEqual([{ chat_id: CA, ts: event.ts as string }, { chat_id: CA, ts: event.ts as string, edited_ts: '1700000001.000001' }]); expect(facts(h, 'beta')).toEqual([])
    h.setMode('fungible'); await h.receive(event, ['alpha']); expect(h.queued('alpha')).toHaveLength(2); expect(h.queued('alpha').map(i => i.accepted.via)).toEqual(['receive_all', 'receive_all'])
  })
  test.each([undefined, null, {}, { type: 'reaction_added' }, { type: 'message', subtype: 'message_deleted' }])('nonmessage %p acks and stores nothing', async event => {
    const h = harness(); await h.receive(event); expect(h.order.filter(s => s === 'ack')).toEqual(['ack']); expect(facts(h, 'alpha')).toEqual([]); expect(facts(h, 'beta')).toEqual([])
  })
  test.each(['channel', 'dm', 'self', 'unmentioned'] as const)('drop %s is acked without queue/network', async kind => {
    const h = harness(); const p = h.p('beta'); const event = kind === 'dm' ? makeDm() : makeChannelMessage({ channel: kind === 'channel' ? CX : kind === 'unmentioned' ? CS : CB, ...(kind === 'self' ? { user: p.stub.identity.botUserId } : {}) })
    await h.receive(event, ['beta']); expect(facts(h, 'alpha')).toEqual([]); expect(facts(h, 'beta')).toEqual([]); expect(h.order.filter(s => s === 'ack')).toEqual(['ack']); expect(p.stub.calls.usersInfo).toEqual([])
  })
  test.each([
    { label: 'user takes precedence over bot and names', event: () => makeBotMessage({ channel: CA, user: 'U0SENDER1', username: 'webhook-name' }), sender: 'resolved-user', author: { user_id: 'U0SENDER1' } },
    { label: 'webhook username takes precedence over profile', event: () => makeWebhookPost({ channel: CA, bot_profile: { name: 'profile-name' } }), sender: 'stub-webhook', author: { bot_id: 'B0STUBHOOK' } },
    { label: 'bot profile supplies the sender', event: () => makeBotMessage({ channel: CA, user: undefined }), sender: 'stub-bot', author: { bot_id: 'B0STUBBOT2' } },
    { label: 'bot ID supplies the sender without a profile', event: () => makeBotMessage({ channel: CA, user: undefined, bot_profile: undefined }), sender: 'B0STUBBOT2', author: { bot_id: 'B0STUBBOT2' } },
  ])('$label through Slack acceptance and fixed tags', async row => {
    const lookups: Array<[string, string]> = []
    const h = harness({ resolveUserName: async (key, user) => { lookups.push([key, user]); return 'resolved-user' }, stubOptions: { alpha: { info: [{ kind: 'ok', result: { channel: { name: '#prepared-room' } } }] } } })
    const event = row.event()
    await h.receive(event, ['alpha'])
    const item = h.queued('alpha')[0]!
    expect(item.accepted).toMatchObject({ source: 'slack', channel: CA, text: event.text, user: event.user, bot_id: event.bot_id, username: event.username, bot_profile_name: (event.bot_profile as { name?: string } | undefined)?.name })
    expect(item.fixed!.parts).toEqual(buildTagParts({ chat_id: CA, channel_name: 'prepared-room', message_id: event.ts as string, user: row.sender, ...row.author, ts: event.ts as string, via: 'receive_all', text: event.text as string }))
    expect(lookups).toEqual(event.user ? [[h.p('alpha').persona.key, event.user as string]] : [])
    expect(h.p('alpha').stub.calls.usersInfo).toEqual([])
    expect(facts(h, 'beta')).toEqual([])
  })
  test('thread and attachment metadata survive Slack acceptance and filename sanitization into exact fixed tags', async () => {
    const h = harness({ resolveUserName: async () => 'resolved-user', stubOptions: { alpha: { info: [{ kind: 'ok', result: { channel: { name: '#prepared-room' } } }] } } })
    const files = [{ name: '../[report];\n.csv', mimetype: 'text/csv', size: 42 }, { id: 'F0UNKNOWN' }]
    const event = makeChannelMessage({ channel: CA, text: `${mentionText(h.p('alpha').stub.identity.botUserId)} threaded files`, thread_ts: '1700000000.000010', files: [...files, null] })
    await h.receive(event, ['alpha'])
    const item = h.queued('alpha')[0]!
    expect(item.accepted).toMatchObject({ thread_ts: event.thread_ts, text: event.text as string, files: [files[0], { name: 'unnamed' }] })
    expect(item.fixed!.parts).toEqual(buildTagParts({ chat_id: CA, channel_name: 'prepared-room', message_id: event.ts as string, user: 'resolved-user', user_id: event.user as string, ts: event.ts as string, thread_ts: event.thread_ts as string, via: 'mention', attachment_count: '2', attachments: `${sanitizeFilename(files[0]!.name!)} (text/csv, 42 bytes); unnamed (unknown, ? bytes)`, text: event.text as string }))
    expect(facts(h, 'beta')).toEqual([])
  })
})
describe('fungible mode', () => {
  test.each([false, true])('paired app mention is ignored in either order and message enters queue once (%p)', async mentionFirst => {
    const h = harness({ mode: 'fungible' }); const message = makeChannelMessage({ channel: CX, text: mentionText(h.p('alpha').stub.identity.botUserId) + ' hello' }); const app = { ...message, type: 'app_mention' }
    await h.receive(mentionFirst ? app : message, ['alpha']); await h.receive(mentionFirst ? message : app, ['alpha']); expect(facts(h, 'alpha')).toEqual([{ channel: CX, ts: message.ts as string, via: 'mention', text: message.text as string }]); expect(facts(h, 'beta')).toEqual([]); expect(h.heardChannels('alpha')).toEqual(new Set([CX])); expect(h.logs.filter(s => s.includes('persona-invited-channel'))).toHaveLength(1)
  })
  test.each(Object.entries(ENVELOPE_FLAG_FORMS))('envelope flag %s retains decision behavior', async (form, envelope) => {
    const h = harness({ mode: 'fungible' }); const event = makeChannelMessage({ channel: CX, text: mentionText(h.p('alpha').stub.identity.botUserId) + ' hello' }); await h.receive(event, ['alpha'], undefined, envelope)
    expect(h.queued('alpha')).toHaveLength(form === 'false' ? 1 : 0); expect(facts(h, 'beta')).toEqual([])
  })
})
test('partial fanout suppresses ack; retry prepares retained accepted-only A and newly stored B after aggregate ack', async () => {
  const queue = await makeQueue(dir); const config = makeMultiPersonaConfig([{ name: 'alpha', channels: [{ id: CS, delivery: 'all' }] }, { name: 'beta', channels: [{ id: CS, delivery: 'all' }] }], dir)
  let failing = true; const order: string[] = []
  const routing = createPersonaRouting({ getPersonaConfig: () => config, getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }), archive: () => {}, log: () => {}, queue: { lookupSlackKey: queue.lookupSlackKey, accept: async (key, input) => { order.push('store:' + key); return key === 'beta' && failing ? { status: 'failed', error: new Error('EIO') } : queue.accept(key, input) } }, onReceived: (key) => { order.push('received:' + key) }, prepare: async (key, item) => { order.push('prepare:' + key); await queue.append(key, { v: 1, kind: 'fixed', seq: item.accepted.seq, parts: ['fixed'] }) } })
  const event = makeChannelMessage({ channel: CS }); await routing.receive(event, () => { order.push('ack') }, ['alpha', 'beta'])
  expect(order).toEqual(['store:alpha', 'store:beta']); expect(queue.items('alpha')).toHaveLength(1); expect(queue.items('beta')).toEqual([])
  failing = false; order.length = 0; await routing.receive(event, () => { order.push('ack') }, ['alpha', 'beta'])
  expect(order).toEqual(['store:beta', 'ack', 'received:alpha', 'received:beta', 'prepare:alpha', 'prepare:beta'])
  for (const key of ['alpha', 'beta']) { expect(queue.items(key)).toHaveLength(1); expect(queue.items(key)[0]!.fixed!.parts).toEqual(['fixed']); expect(readQueue(dir, key).filter(r => r.kind === 'accepted' && !('compact' in r))).toHaveLength(1) }; await queue.stop()
})
test('a fresh routing factory acknowledges a preexisting fixed undelivered Slack item without recovery or another received report', async () => {
  const queue = await makeQueue(dir)
  const config = makeMultiPersonaConfig([{ name: 'alpha', channels: [{ id: CA, delivery: 'all' }] }], dir)
  const event = makeChannelMessage({ channel: CA })
  const stored = await queue.accept('alpha', slackInput({ channel: CA, ts: event.ts as string, key: { chat_id: CA, ts: event.ts as string } }))
  if (stored.status === 'failed') throw new Error('store failed')
  await queue.append('alpha', { v: 1, kind: 'fixed', seq: stored.seq, parts: ['preexisting fixed bytes'] })
  const before = readQueue(dir)
  const calls: string[] = []
  // No earlier call has populated this factory's in-memory dedupe map.
  const routing = createPersonaRouting({ getPersonaConfig: () => config, getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }),
    queue, archive: () => {}, log: () => {}, prepare: async () => { calls.push('prepare') }, onReceived: () => { calls.push('received') },
    isPersonaUp: () => { calls.push('recovery'); return true }, readRowLiveness: async () => { calls.push('read'); return { kind: 'dead', cause: 'ended' } },
  })
  try {
    expect(queue.items('alpha')[0]!.delivered).toBe(false)
    await routing.receive(event, () => { calls.push('ack') }, 'alpha')
    expect(calls).toEqual(['ack'])
    expect(queue.items('alpha')).toHaveLength(1)
    expect(queue.items('alpha')[0]!.fixed!.parts).toEqual(['preexisting fixed bytes'])
    expect(readQueue(dir)).toEqual(before)
  } finally { await queue.stop() }
})
test('ack precedes row read and all lookups; fixed bytes are durable before wake and survive replay/name changes', async () => {
  const queue = await makeQueue(dir); const order: string[] = []; const config = makeMultiPersonaConfig([{ name: 'alpha' }], dir)
  const preparation = createDeliveryPreparation({ queue, clientFor: () => undefined, resolveUserName: async () => { order.push('lookup'); return 'first-name' }, wake: key => { order.push('wake'); expect(readQueue(dir, key).some(r => r.kind === 'fixed')).toBe(true) } })
  const routing = createPersonaRouting({ getPersonaConfig: () => config, getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }), queue, prepare: preparation.prepare, archive: () => {}, log: () => {}, isPersonaUp: () => false, readRowLiveness: async () => { throw new Error('must be gated') } })
  await routing.receive(makeChannelMessage({ channel: config.personas[0]!.channels[0]!.id }), () => { order.push('ack') }, 'alpha')
  expect(order).toEqual(['ack', 'lookup', 'wake']); const bytes = queue.items('alpha')[0]!.fixed!.parts; expect(bytes.join('')).toContain('first-name'); await preparation.stop(); await queue.stop()
  const replay = await makeQueue(dir); const p2 = createDeliveryPreparation({ queue: replay, clientFor: () => undefined, resolveUserName: async () => { throw new Error('fixed must not look up again') } }); await p2.recover(); expect(replay.items('alpha')[0]!.fixed!.parts).toEqual(bytes); await p2.stop(); await replay.stop()
})

test.each(['accepted-only', 'damaged-fixed'] as const)('restart prepares %s work with fresh bounded lookups and exact durable fixed bytes before wake', async state => {
  const clock = createFakeClock({ start: 1700000000000 })
  const accepted = { ...slackInput({ channel: CA, user: 'U0SENDER1', text: 'recover this', via: 'receive_all' }), v: 1, kind: 'accepted', seq: 1, received_at: clock.now(), ts: '1700000000.000001' } as const
  const damaged = '{"v":1,"kind":"fixed","seq":1,"parts":"damaged"}\n'
  seedQueue(dir, state === 'damaged-fixed' ? [accepted, damaged] : [accepted])
  const queue = await makeQueue(dir, { now: clock.now })
  const slack = makeStubSlack({ info: [{ kind: 'never' }] })
  const expected = buildTagParts({ chat_id: CA, channel_name: CA, message_id: accepted.ts, user: 'U0SENDER1', user_id: 'U0SENDER1', ts: accepted.ts, via: 'receive_all', text: accepted.text })
  const lookups: Array<[string, string]> = []; const wakes: string[] = []
  const preparation = createDeliveryPreparation({ queue, clock, clientFor: () => slack.web as unknown as WebClient, resolveUserName: (key, user) => { lookups.push([key, user]); return new Promise(() => {}) }, wake: key => {
    expect(readQueue(dir, key).filter(r => r.kind === 'fixed')).toEqual([{ v: 1, kind: 'fixed', seq: 1, parts: expected }])
    wakes.push(key)
  } })
  try {
    expect(queue.items('alpha')[0]!.fixed).toBeUndefined()
    const recovery = preparation.recover()
    await clock.flush()
    expect(lookups).toEqual([['alpha', 'U0SENDER1']]); expect(wakes).toEqual([])
    expect(slack.calls.conversationsInfo).toEqual([{ channel: CA }])
    expect(clock.pending().map(timer => timer.delayMs)).toEqual([NAME_LOOKUP_TIMEOUT_MS, NAME_LOOKUP_TIMEOUT_MS])
    await clock.advance(NAME_LOOKUP_TIMEOUT_MS - 1); expect(wakes).toEqual([])
    await clock.advance(1); await recovery
    expect(wakes).toEqual(['alpha']); expect(queue.items('alpha')[0]!.fixed!.parts).toEqual(expected); expect(clock.pendingCount()).toBe(0)
    await preparation.recover()
    expect(lookups).toEqual([['alpha', 'U0SENDER1']]); expect(slack.calls.conversationsInfo).toEqual([{ channel: CA }]); expect(readQueue(dir).filter(r => r.kind === 'fixed')).toHaveLength(1)
  } finally { await clock.advance(NAME_LOOKUP_TIMEOUT_MS); await preparation.stop(); await queue.stop() }
})

test('hung independent lookups acknowledge within 3s, use bounded fallbacks and persist fixed bytes before waking', async () => {
  const clock = createFakeClock({ start: 1700000000000 })
  const queue = await makeQueue(dir, { now: clock.now })
  const config = makeMultiPersonaConfig([{ name: 'alpha' }], dir)
  let acknowledgedAt: number | undefined; const wakes: string[] = []
  const preparation = createDeliveryPreparation({ queue, clock, clientFor: () => undefined, resolveUserName: () => new Promise(() => {}), wake: key => { expect(readQueue(dir, key).some(r => r.kind === 'fixed')).toBe(true); wakes.push(key) } })
  const routing = createPersonaRouting({ getPersonaConfig: () => config, getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }), queue, prepare: preparation.prepare, archive: () => {}, log: () => {}, isPersonaUp: () => false, now: clock.now })
  try {
    const started = clock.now()
    const handling = routing.receive(makeChannelMessage({ channel: config.personas[0]!.channels[0]!.id, user: 'U0SENDER1' }), () => { acknowledgedAt = clock.now() }, 'alpha')
    await clock.flush(); expect(acknowledgedAt).toBeDefined(); expect(acknowledgedAt! - started).toBeLessThan(3000); expect(wakes).toEqual([])
    expect(clock.pending().map(t => t.delayMs)).toEqual([NAME_LOOKUP_TIMEOUT_MS])
    await clock.advance(NAME_LOOKUP_TIMEOUT_MS - 1); expect(wakes).toEqual([])
    await clock.advance(1); await handling
    expect(wakes).toEqual(['alpha']); expect(queue.items('alpha')[0]!.fixed!.parts.join('')).toContain('U0SENDER1'); expect(clock.pendingCount()).toBe(0)
  } finally { await preparation.stop(); await queue.stop() }
})

test('channel caches are persona scoped, slow preparation leaves unrelated work free and fixed parts stay immutable', async () => {
  const fake = createFakeClock({ start: 1700000000000 })
  const h = makeRoutingHarness([{ name: 'alpha', channels: [{ id: CS, delivery: 'all' }] }, { name: 'beta', channels: [{ id: CS, delivery: 'all' }] }], dir, { preparationClock: fake, stubOptions: { alpha: { info: [{ kind: 'never' }] }, beta: { info: [{ kind: 'ok', result: { channel: { name: 'beta-room' } } }] } } })
  harnesses.push(h)
  try {
    const handling = h.receive(makeChannelMessage({ channel: CS, ts: '1700000000.000001' }))
    await fake.flush()
    expect(h.order.filter(s => s === 'ack')).toEqual(['ack']); expect(h.queued('alpha')[0]!.fixed).toBeUndefined(); expect(h.queued('beta')[0]!.fixed!.parts.join('')).toContain('beta-room')
    await fake.runNext(); await handling
    const fixed = structuredClone(h.queued('alpha')[0]!.fixed)
    expect(fixed!.parts.join('')).toContain(CS)
    await h.receive(makeChannelMessage({ channel: CS, ts: '1700000000.000002' }))
    expect(h.p('alpha').stub.calls.conversationsInfo).toEqual([{ channel: CS }]); expect(h.p('beta').stub.calls.conversationsInfo).toEqual([{ channel: CS }]); expect(h.queued('alpha')[0]!.fixed).toEqual(fixed); expect(h.queued('beta')).toHaveLength(2)
    expect(fake.pendingCount()).toBe(0)
  } finally { expect(fake.pendingCount()).toBe(0) }
})

test('ordinary decision failure still acks while storing nothing for either persona', async () => {
  const queue = await makeQueue(dir)
  let acknowledgments = 0
  const routing = createPersonaRouting({ queue, prepare: async () => {}, getPersonaConfig: () => makeMultiPersonaConfig([{ name: 'alpha' }, { name: 'beta' }], dir), getBotIdentity: () => { throw new Error('identity unavailable') }, archive: () => {}, log: () => {} })
  try { await routing.receive(makeChannelMessage(), () => { acknowledgments++ }, ['alpha', 'beta']); expect(acknowledgments).toBe(1); expect(queue.items('alpha')).toEqual([]); expect(queue.items('beta')).toEqual([]) } finally { await queue.stop() }
})


test.each(['quick', 'late'] as const)('%s lookup completion clears its injected timer and cannot mutate fixed fallback bytes', async completion => {
  const clock = createFakeClock()
  const queue = await makeQueue(dir, { now: clock.now })
  let resolve!: (name: string) => void
  const lookup = new Promise<string>(done => { resolve = done })
  const wakes: string[] = []
  const preparation = createDeliveryPreparation({ queue, clock, clientFor: () => undefined, resolveUserName: () => lookup, wake(key) {
    expect(readQueue(dir, key).filter(r => r.kind === 'fixed')).toHaveLength(1)
    wakes.push(key)
  } })
  try {
    const result = await queue.accept('alpha', { source: 'slack', text: 'hello', channel: 'D0TEST001', channel_type: 'im', user: 'U0SENDER1', key: { chat_id: 'D0TEST001', ts: '1700000000.000001' }, ts: '1700000000.000001', via: 'dm' })
    if (result.status !== 'accepted') throw new Error('fixture acceptance failed')
    const work = preparation.prepare('alpha', result.item!)
    await clock.flush()
    expect(clock.pending().map(t => t.delayMs)).toEqual([NAME_LOOKUP_TIMEOUT_MS])
    if (completion === 'quick') resolve('resolved-name')
    else await clock.advance(NAME_LOOKUP_TIMEOUT_MS)
    await work
    const fixed = queue.items('alpha')[0]!.fixed!.parts
    expect(fixed.join('')).toContain(completion === 'quick' ? 'resolved-name' : 'U0SENDER1')
    expect(wakes).toEqual(['alpha']); expect(clock.pendingCount()).toBe(0)
    resolve('late-name')
    await clock.flush(); await clock.advance(NAME_LOOKUP_TIMEOUT_MS)
    expect(queue.items('alpha')[0]!.fixed!.parts).toEqual(fixed)
    expect(readQueue(dir).filter(r => r.kind === 'fixed')).toHaveLength(1)
    expect(wakes).toEqual(['alpha']); expect(clock.pendingCount()).toBe(0)
  } finally { await preparation.stop(); await queue.stop() }
})
