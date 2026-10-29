/** Durable Slack intake: decision wiring, persona isolation, ack boundary and immutable preparation. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebClient } from '@slack/web-api'
import { createPersonaRouting } from '../src/persona-routing.ts'
import { buildTagParts, NAME_LOOKUP_TIMEOUT_MS } from '../src/tag-wrapper.ts'
import { createDeliveryPreparation } from '../src/delivery-intake.ts'
import type { AcceptedRecord } from '../src/delivery-queue.ts'
import { sanitizeFilename } from '../src/lib.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeRestartDeps, makeRoutingHarness, observedMembership, resetRoutingState, NEVER_FIRE_RESTART_DELAY_S, type RoutingHarness } from './test-helpers/persona-routing-harness.ts'
import { broadcastText, makeAppMention, makeChannelMessage, makeDm, makeBotMessage, makeWebhookPost, makeStubSlack, mentionText, ENVELOPE_FLAG_FORMS, type SlackEvent } from './test-helpers/slack-stub.ts'
import type { ChannelMode } from '../src/config.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { readQueue, seedQueue, slackInput, queuePath } from './test-helpers/delivery-queue.ts'
import { createChannelDeliveryStore } from '../src/channel-delivery.ts'
import { configBytes, makeSharedAuthority, membershipPage, sharedRecoveryRequest } from './test-helpers/shared-channels.ts'
import { makeReloadHarness } from './test-helpers/reload-harness.ts'
import { PERSONA_THREAD_STAMP_UNDECIDED, threadStampUndecidedCause } from '../src/persona-diagnostics.ts'
import { createPersonaEpisodes } from '../src/persona-episodes.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { makeQueue } from './test-helpers/delivery-queue.ts'
import { initRestart, isRestartPendingOrActive } from '../src/restart.ts'
const CA = 'C0TEST001', CB = 'C0TEST002', CS = 'C0SHARED1', CX = 'C0OTHER01'
let dir: string; let harnesses: RoutingHarness[]
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'routing-queue-')); harnesses = []; resetRoutingState() })
afterEach(async () => { for (const h of harnesses) { h.hold.cancelAll(); h.releaseLaunches(); await h.queue.stop(); assertNoLeak(h.captured()) }; resetRoutingState(); rmSync(dir, { recursive: true, force: true }) })
function harness(opts: Parameters<typeof makeRoutingHarness>[2] = {}) {
  const h = makeRoutingHarness([{ name: 'alpha', channels: [{ id: CA, delivery: 'all' }, { id: CS, delivery: 'mentions' }], dm: { enabled: true } }, { name: 'beta', channels: [{ id: CB, delivery: 'all' }, { id: CS, delivery: 'mentions' }] }], dir, { membership: observedMembership({ alpha: [CA, CS, ...(opts.mode === 'open' ? [CX] : [])], beta: [CB, CS] }), restartDelayS: NEVER_FIRE_RESTART_DELAY_S, ...opts }); harnesses.push(h); return h
}
// Actual shared projection plus explicit current positives for the low-level
// queue tests. Neither the selector nor the intake algorithm is replaced.
function selectionInputs(config: ReturnType<typeof makeMultiPersonaConfig>, channels: string[]) {
  const input = { ...config, personas: config.personas.map(({ key, index, sections, ...p }) => p) }
  const store = createChannelDeliveryStore(makeSharedAuthority(dir, input))
  return { getChannelDelivery: () => store, membership: observedMembership(Object.fromEntries(config.personas.map(p => [p.key, channels]))) }
}
const facts = (h: RoutingHarness, name: string) => h.queued(name).map(i => ({ channel: i.accepted.channel, ts: i.accepted.ts, via: i.accepted.via, text: i.accepted.text }))

test.each(['strict', 'open'] as const)('%s staged restoration holds thread-dependent replies despite readableFor=true while independent and accepted work continues, even when not-up', async channel_mode => {
  const h = makeReloadHarness()
  let preparation: ReturnType<typeof createDeliveryPreparation> | undefined
  try {
    const alpha = h.persona('alpha', { channels: [{ id: CA, delivery: 'thread_hybrid' }, { id: CB, delivery: 'mentions' }, { id: CX, delivery: 'all' }], permission_prompts: CB, dm: { enabled: true } })
    const beta = h.persona('beta', { channels: [{ id: CA, delivery: 'all' }, { id: CB, delivery: 'mentions' }], permission_prompts: CB })
    h.materialize(alpha, beta)
    h.writeRecord({ channel_mode, personas: [alpha, beta] })
    h.writeConfig({ channel_mode, personas: [alpha, beta] })
    const slack = {
      alpha: { inventory: [membershipPage([CA, CB, CX])] }, beta: { inventory: [membershipPage([CA, CB])] },
    }
    let run = await h.startDetecting({ threadMemory: {}, slack })
    const restart = makeRestartDeps({ restartDelayS: NEVER_FIRE_RESTART_DELAY_S })
    initRestart(restart)
    await run.membershipClock.runNext()
    // A failed local bring-up beside a still-serving connection must remain
    // not-up. Use the real controller's directory failure and the harness's
    // production predicate, retaining current membership for intake.
    const establishNotUp = async () => {
      h.deleteWorkingDirectory(alpha)
      run.bringUps.cancel('alpha')
      const applied = run.controller.applied()!.config.personas
      await run.bringUps.bringUp(applied.find(p => p.key === 'alpha')!, applied)
      h.makeWorkingDirectory(alpha)
      expect(run.connections.manager.status('alpha')?.state).toBe('up')
      expect(run.bringUps.state('alpha')?.outcome).toBe('retrying')
      expect(run.isUp('alpha')).toBe(false)
      expect(run.isUp('beta')).toBe(true)
      run.registerSession('beta')
    }
    await establishNotUp()
    const lifecycleBefore = run.checkpoint()
    let authority = run.controller.sharedChannels()!
    expect(run.membership.read('alpha', CA, channel_mode).kind).toBe('eligible')
    const stamp = authority.channelStamp('alpha', CA)!
    if (stamp.kind !== 'decided' || !stamp.threadHybridSince) throw new Error('expected a thread stamp')
    const root = '1700000000.000001'
    expect(await run.threadMemory!.saveJoins('alpha', [{ channel: CA, root, source: 'mention', at: run.threadMemory!.clock('alpha'),
      stamp: { incarnation: stamp.incarnation, threadHybridSince: stamp.threadHybridSince } }])).toEqual({ kind: 'saved' })
    expect(run.threadMemory!.view('alpha', CA, root)).toBe('joined')
    const prepare = () => createDeliveryPreparation({ queue: run.queue, clientFor: () => undefined, resolveUserName: async (_key, user) => user })
    preparation = prepare()
    const logs: string[] = []
    const notices: string[] = []
    const episodes = createPersonaEpisodes({ sink: (_key, text) => { notices.push(text) }, log: line => logs.push(line), clock: run.clock })
    const rowReads: string[] = []
    const makeRouter = () => createPersonaRouting({
      getPersonaConfig: () => run.controller.applied()?.config,
      getChannelDelivery: () => run.channelDelivery,
      threadStampUndecided: (key, channel) => authority.channelStamp(key, channel)?.kind === 'undecided',
      threadStampEpisodes: episodes.threadStampUndecided,
      membership: run.membership,
      getBotIdentity: key => run.stub(key).identity,
      queue: run.queue, prepare: preparation!.prepare, archive: () => {}, log: line => logs.push(line),
      isPersonaUp: key => run.isUp(key),
      readRowLiveness: async key => { rowReads.push(key); return { kind: 'dead', cause: 'ended' } },
    })
    let routing = makeRouter()
    const mention = makeChannelMessage({ channel: CA, ts: '1700000000.000002', thread_ts: root, text: mentionText(run.stub('alpha').identity.botUserId) })
    const project = (event: SlackEvent, via: string) => ({ channel: event.channel as string, ts: event.ts as string, via, text: event.text as string })
    const queued = () => Object.fromEntries(['alpha', 'beta'].map(key => [key, run.queue.items(key).map(({ accepted }) => ({
      channel: accepted.channel, ts: accepted.ts, via: accepted.via, text: accepted.text,
    }))]))
    const durableQueues = () => Object.fromEntries(['alpha', 'beta'].map(key => [key,
      (existsSync(queuePath(h.stateDir, key)) ? readQueue(h.stateDir, key) : []).filter((record): record is AcceptedRecord => record.kind === 'accepted')
        .map(record => ({ channel: record.channel, ts: record.ts, via: record.via, text: record.text })),
    ]))
    const expected = { alpha: [project(mention, 'mention')], beta: [] as ReturnType<typeof project>[] }
    let acks = 0
    const acceptedAtAck: ReturnType<typeof durableQueues>[] = []
    const ack = () => { acks++ }
    await routing.receive(mention, () => {
      ack()
      acceptedAtAck.push(durableQueues())
    }, 'alpha', false)
    expect(acks).toBe(1)
    expect(acceptedAtAck).toEqual([expected])
    expect(queued()).toEqual(expected)
    const acceptedBefore = readFileSync(queuePath(h.stateDir, 'alpha'))
    const joins = run.threadMemory!.joins('alpha')
    const damage = h.writeRecordBytes('damaged authority with a retained owner snapshot')
    h.writeRequestBytes(configBytes(sharedRecoveryRequest('routing-restoration', damage)))
    await run.ticks.tick()
    expect(authority.readable).toBe(false)
    expect(authority.readableFor('alpha', CA)).toBe(true)
    expect(authority.channelStamp('alpha', CA)).toEqual({ kind: 'undecided' })
    expect(run.threadMemory!.joins('alpha')).toEqual(joins)
    expect(run.threadMemory!.view('alpha', CA, root)).toBe('not-joined')
    const dependent = makeChannelMessage({ channel: CA, ts: '1700000000.000003', thread_ts: root, text: 'dependent reply' })
    acks = 0
    await routing.receive(dependent, ack, 'alpha', false)
    await routing.receive(dependent, ack, 'alpha', false)
    expect(acks).toBe(0)
    expect(run.queue.items('alpha').map(i => i.accepted.ts)).toEqual([mention.ts as string])
    expect(readFileSync(queuePath(h.stateDir, 'alpha'))).toEqual(acceptedBefore)
    const warnings = () => logs.filter(line => line.includes(PERSONA_THREAD_STAMP_UNDECIDED))
    expect(warnings()).toHaveLength(1)
    // The diagnostic module pins this exported cause's finite-retry warning.
    expect(warnings()[0]).toContain(threadStampUndecidedCause(CA))
    await routing.receive(mention, ack, 'alpha', false)
    expect(acks).toBe(1)
    expect(readFileSync(queuePath(h.stateDir, 'alpha'))).toEqual(acceptedBefore)

    const independent = [
      { key: 'alpha', via: 'mention', event: makeChannelMessage({ channel: CA, thread_ts: root, ts: '1700000000.000004', text: mentionText(run.stub('alpha').identity.botUserId) }) },
      { key: 'alpha', via: 'broadcast', event: makeChannelMessage({ channel: CA, thread_ts: root, ts: '1700000000.000005', text: broadcastText('channel') }) },
      { key: 'alpha', via: 'dm', event: makeDm({ ts: '1700000000.000006', text: 'direct' }) },
      { key: 'alpha', via: 'receive_all', event: makeChannelMessage({ channel: CX, ts: '1700000000.000007', text: 'another channel' }) },
      { key: 'beta', via: 'receive_all', event: makeChannelMessage({ channel: CA, thread_ts: root, ts: '1700000000.000008', text: 'another persona' }) },
    ]
    for (const { key, via, event } of independent) {
      let ackCount = 0
      acceptedAtAck.length = 0
      await routing.receive(event, () => {
        ackCount++
        acceptedAtAck.push(durableQueues())
      }, key, false)
      expect(ackCount).toBe(1)
      expected[key as keyof typeof expected].push(project(event, via))
      expect(acceptedAtAck).toEqual([expected])
      expect(queued()).toEqual(expected)
    }
    // A held recipient cannot make the aggregate ack lie about partial fanout.
    acks = 0
    await routing.receive(dependent, ack, ['alpha', 'beta'], false)
    await routing.receive(dependent, ack, ['alpha', 'beta'], false)
    expect(acks).toBe(0)
    expect(run.queue.items('alpha').some(i => i.accepted.ts === dependent.ts)).toBe(false)
    expect(run.queue.items('beta').filter(i => i.accepted.ts === dependent.ts)).toHaveLength(1)
    expected.beta.push(project(dependent, 'receive_all'))
    expect(queued()).toEqual(expected)
    expect(warnings()).toHaveLength(1)
    expect(rowReads).toEqual([])
    expect(restart.restartAsks).toEqual([])
    expect(restart.launches).toEqual([])
    expect(['alpha', 'beta'].map(isRestartPendingOrActive)).toEqual([false, false])
    expect(run.since(lifecycleBefore).lifecycle).toEqual([])
    expect(run.isUp('alpha')).toBe(false)
    expect(run.isUp('beta')).toBe(true)
    expect(notices).toEqual([])
    expect(run.slackPosts()).toEqual([])

    assertNoLeak({ logs, captured: run.captured() })
    // Owned restoration is reviewed on the next start; it is never activated
    // by the running owner's ordinary detection tick.
    await preparation.stop(); await run.stop()
    const review = await h.start({ threadMemory: {} })
    expect(review.outcome.kind).toBe('refused')
    expect(h.pendingExists()).toBe(true)
    expect(review.slackPosts()).toEqual([])
    assertNoLeak(review.captured())
    await review.stop(); h.confirm()
    run = await h.start({ threadMemory: {}, slack })
    initRestart(restart)
    expect(run.outcome.kind).toBe('applied')
    await run.membershipClock.runNext()
    await establishNotUp()
    authority = run.controller.sharedChannels()!
    preparation = prepare(); routing = makeRouter()
    expect(authority.channelStamp('alpha', CA)?.kind).toBe('decided')
    expect(authority.channelStamp('alpha', CA)).not.toEqual(stamp)
    expect(run.threadMemory!.view('alpha', CA, root)).toBe('not-joined')
    await routing.receive(dependent, ack, ['alpha', 'beta'], false)
    expect(acks).toBe(1)
    expect(run.queue.items('alpha').some(i => i.accepted.ts === dependent.ts)).toBe(false)
    expect(run.queue.items('beta').filter(i => i.accepted.ts === dependent.ts)).toHaveLength(1)
    expect(queued()).toEqual(expected)
    expect(rowReads).toEqual([])
    expect(restart.restartAsks).toEqual([])
    expect(restart.launches).toEqual([])
    expect(['alpha', 'beta'].map(isRestartPendingOrActive)).toEqual([false, false])
    expect(notices).toEqual([])
    expect(run.slackPosts()).toEqual([])
    assertNoLeak({ logs, captured: run.captured() })
  } finally { await preparation?.stop(); await h.cleanup() }
})

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
    h.setMode('open'); await h.receive(event, ['alpha']); expect(h.queued('alpha')).toHaveLength(2); expect(h.queued('alpha').map(i => i.accepted.via)).toEqual(['receive_all', 'receive_all'])
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
    const h = harness({ mode: 'open', channelDelivery: undefined });
    const alpha = h.p('alpha').persona; h.channelDelivery!.set(alpha.key, CX, 'mentions', alpha); const message = makeChannelMessage({ channel: CX, text: mentionText(h.p('alpha').stub.identity.botUserId) + ' hello' }); const app = { ...message, type: 'app_mention' }
    await h.receive(mentionFirst ? app : message, ['alpha']); await h.receive(mentionFirst ? message : app, ['alpha']); expect(facts(h, 'alpha')).toEqual([{ channel: CX, ts: message.ts as string, via: 'mention', text: message.text as string }]); expect(facts(h, 'beta')).toEqual([]); expect(h.heardChannels('alpha')).toEqual(new Set([CX])); expect(h.logs.filter(s => s.includes('persona-invited-channel'))).toHaveLength(1)
  })
  test.each(Object.entries(ENVELOPE_FLAG_FORMS))('envelope flag %s retains decision behavior', async (form, envelope) => {
    const h = harness({ mode: 'open', channelDelivery: undefined });
    const alpha = h.p('alpha').persona; h.channelDelivery!.set(alpha.key, CX, 'mentions', alpha); const event = makeChannelMessage({ channel: CX, text: mentionText(h.p('alpha').stub.identity.botUserId) + ' hello' }); await h.receive(event, ['alpha'], undefined, envelope)
    expect(h.queued('alpha')).toHaveLength(form === 'false' ? 1 : 0); expect(facts(h, 'beta')).toEqual([])
  })
})
describe('thread_hybrid selects only @mentions and Broadcasts', () => {
  const CT = 'C0THREAD1', ROOT = '1700000000.000100'
  function threadHarness(mode: ChannelMode) {
    const h = makeRoutingHarness([{ name: 'alpha', channels: [{ id: CT, delivery: 'thread_hybrid' }] }], dir, { mode, membership: observedMembership({ alpha: [CT] }), restartDelayS: NEVER_FIRE_RESTART_DELAY_S })
    harnesses.push(h)
    const alpha = h.p('alpha').persona
    if (mode === 'open') h.channelDelivery!.set(alpha.key, CT, 'thread_hybrid', alpha)
    return h
  }
  /** The persona's root @mention is delivered; returns the stub's Web API call count once its preparation settled. */
  async function mentionedRoot(h: RoutingHarness): Promise<number> {
    await h.receive(makeChannelMessage({ channel: CT, ts: ROOT, text: `${mentionText(h.p('alpha').stub.identity.botUserId)} root` }))
    expect(facts(h, 'alpha')).toEqual([{ channel: CT, ts: ROOT, via: 'mention', text: expect.stringContaining('root') }])
    return h.p('alpha').stub.callLog.length
  }
  test.each(['strict', 'open'] as const)('%s: an unmentioned reply under a mentioning root is dropped as not-mentioned, acknowledged once, with no store or Slack call', async mode => {
    const h = threadHarness(mode)
    const calls = await mentionedRoot(h)
    await h.receive(makeChannelMessage({ channel: CT, ts: '1700000000.000101', thread_ts: ROOT, text: 'unmentioned reply' }))
    expect(h.order.filter(s => s === 'ack')).toEqual(['ack', 'ack'])
    expect(facts(h, 'alpha').map(f => f.ts)).toEqual([ROOT])
    expect(readQueue(dir, h.p('alpha').persona.key).flatMap(r => r.kind === 'accepted' && 'ts' in r ? [r.ts] : [])).toEqual([ROOT])
    expect(h.p('alpha').stub.callLog.slice(calls)).toEqual([])
    expect(h.p('alpha').stub.calls.conversationsReplies).toEqual([])
    expect(h.p('alpha').stub.calls.conversationsHistory).toEqual([])
    expect(h.logs.filter(l => l.includes('not-mentioned'))).toHaveLength(1)
  })
  test.each([
    ['strict', 'mention'], ['strict', 'broadcast'], ['open', 'mention'], ['open', 'broadcast'],
  ] as const)('%s: a %s reply there is delivered with its via and acknowledged once', async (mode, via) => {
    const h = threadHarness(mode)
    await mentionedRoot(h)
    const text = via === 'mention' ? `${mentionText(h.p('alpha').stub.identity.botUserId)} reply` : `${broadcastText('here')} reply`
    await h.receive(makeChannelMessage({ channel: CT, ts: '1700000000.000102', thread_ts: ROOT, text }))
    expect(h.order.filter(s => s === 'ack')).toEqual(['ack', 'ack'])
    expect(h.queued('alpha').map(i => ({ ts: i.accepted.ts, thread_ts: i.accepted.thread_ts, via: i.accepted.via }))).toEqual([
      { ts: ROOT, thread_ts: undefined, via: 'mention' }, { ts: '1700000000.000102', thread_ts: ROOT, via },
    ])
  })
})
test('partial fanout suppresses ack; retry prepares retained accepted-only A and newly stored B after aggregate ack', async () => {
  const queue = await makeQueue(dir); const config = makeMultiPersonaConfig([{ name: 'alpha', channels: [{ id: CS, delivery: 'all' }] }, { name: 'beta', channels: [{ id: CS, delivery: 'all' }] }], dir)
  let failing = true; const order: string[] = []
  const routing = createPersonaRouting({ ...selectionInputs(config, [CA, CB, CS]), getPersonaConfig: () => config, getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }), archive: () => {}, log: () => {}, queue: { lookupSlackKey: queue.lookupSlackKey, accept: async (key, input) => { order.push('store:' + key); return key === 'beta' && failing ? { status: 'failed', error: new Error('EIO') } : queue.accept(key, input) } }, onReceived: (key) => { order.push('received:' + key) }, prepare: async (key, item) => { order.push('prepare:' + key); await queue.append(key, { v: 1, kind: 'fixed', seq: item.accepted.seq, parts: ['fixed'] }) } })
  const event = makeChannelMessage({ channel: CS }); await routing.receive(event, () => { order.push('ack') }, ['alpha', 'beta'])
  expect(order).toEqual(['store:alpha', 'store:beta', 'received:alpha']); expect(queue.items('alpha')).toHaveLength(1); expect(queue.items('beta')).toEqual([])
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
  const routing = createPersonaRouting({ ...selectionInputs(config, [CA, CB, CS]), getPersonaConfig: () => config, getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }),
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
  const routing = createPersonaRouting({ ...selectionInputs(config, [CA, CB, CS]), getPersonaConfig: () => config, getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }), queue, prepare: preparation.prepare, archive: () => {}, log: () => {}, isPersonaUp: () => true, readRowLiveness: async () => { order.push('row-read'); return { kind: 'dead', cause: 'ended' } } })
  await routing.receive(makeChannelMessage({ channel: config.personas[0]!.channels[0]!.id }), () => { order.push('ack') }, 'alpha')
  expect(order).toEqual(['ack', 'row-read', 'lookup', 'wake']); const bytes = queue.items('alpha')[0]!.fixed!.parts; expect(bytes.join('')).toContain('first-name'); await preparation.stop(); await queue.stop()
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
  const routing = createPersonaRouting({ ...selectionInputs(config, [CA, CB, CS]), getPersonaConfig: () => config, getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }), queue, prepare: preparation.prepare, archive: () => {}, log: () => {}, isPersonaUp: () => true, now: clock.now })
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
  const h = makeRoutingHarness([{ name: 'alpha', channels: [{ id: CS, delivery: 'all' }] }, { name: 'beta', channels: [{ id: CS, delivery: 'all' }] }], dir, { membership: observedMembership({ alpha: [CS], beta: [CS] }), preparationClock: fake, stubOptions: { alpha: { info: [{ kind: 'never' }] }, beta: { info: [{ kind: 'ok', result: { channel: { name: 'beta-room' } } }] } } })
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

test('decision failure withholds ack until replay can durably retain both recipients', async () => {
  const clock = createFakeClock({ start: 1700000000000 })
  const queue = await makeQueue(dir, { now: clock.now })
  const config = makeMultiPersonaConfig([{ name: 'alpha', channels: [{ id: CA, delivery: 'all' }] }, { name: 'beta', channels: [{ id: CA, delivery: 'all' }] }], dir)
  let acknowledgments = 0
  let identityAvailable = false
  const routing = createPersonaRouting({ ...selectionInputs(config, [CA]), queue, now: clock.now, prepare: async () => {}, getPersonaConfig: () => config, getBotIdentity: () => { if (!identityAvailable) throw new Error('identity unavailable'); return { botUserId: 'U0BOT001', botId: 'B0BOT001' } }, archive: () => {}, log: () => {} })
  try {
    const keys = ['alpha', 'beta'], text = '  > "quoted"\r\n\t repeated  repeated\n\n  ', ts = '1700000000.000001'
    const event = makeChannelMessage({ channel: CA, user: 'U0SENDER1', ts, text })
    const expected: AcceptedRecord = { v: 1, kind: 'accepted', seq: 1, source: 'slack', channel: CA, channel_type: 'channel',
      key: { chat_id: CA, ts }, ts, user: 'U0SENDER1', text, via: 'receive_all_shared',
      received_at: clock.now(), queued_ack_reaction: config.queued_ack_reaction }
    const atAck: Array<Array<{ persona: string; records: ReturnType<typeof readQueue> }>> = []
    const ack = () => { atAck.push(keys.map(persona => ({ persona, records: readQueue(dir, persona) }))); acknowledgments++ }
    await routing.receive(event, ack, keys)
    expect(acknowledgments).toBe(0); expect(queue.items('alpha')).toEqual([]); expect(queue.items('beta')).toEqual([])
    expect(atAck).toEqual([])
    identityAvailable = true
    await routing.receive(event, ack, keys)
    expect(acknowledgments).toBe(1)
    const durable = keys.map(persona => ({ persona, records: [expected] }))
    expect(atAck).toEqual([durable])
    for (const key of keys) expect(queue.items(key).map(item => item.accepted)).toEqual([expected])
    const retained = keys.map(key => ({ items: structuredClone(queue.items(key)), bytes: readFileSync(queuePath(dir, key), 'utf8') }))
    await clock.advance(1)
    await routing.receive(event, ack, keys)
    expect(acknowledgments).toBe(2)
    expect(atAck).toEqual([durable, durable])
    expect(keys.map(key => ({ items: queue.items(key), bytes: readFileSync(queuePath(dir, key), 'utf8') }))).toEqual(retained)
  } finally { await queue.stop() }
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
