import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { SERVER_POST_METADATA } from './test-helpers/server-post.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelMode, DeliveryMode, PersonaInput } from '../src/config.ts'
import { OWN_ROOT_CLOCK_SKEW_MS, THREAD_MEMORY_LOOKUP_DEADLINE_MS, THREAD_MEMORY_RETRY_MAX_MS, THREAD_MEMORY_RETRY_MIN_MS, THREAD_REPLY_HOLD_MS } from '../src/delivery-constants.ts'
import { DELIVERY_ROW_POLL_MS } from '../src/delivery-engine.ts'
import { THREAD_MEMORY_JOINS_LOST } from '../src/persona-diagnostics.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { dropPersonaSession } from '../src/registry.ts'
import { buildThreadMemoryJoinsLostLine, buildThreadMemoryJoinsLostNotice } from '../src/thread-memory-reports.ts'
import { assertNoLeak, LEAK_SENTINEL, writtenFile } from './test-helpers/credentials.ts'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { queuePath, readQueue } from './test-helpers/delivery-queue.ts'
import { makeReloadHarness, TEMPLATE_REFRESH_KEY, type ReloadHarness, type ReloadRun, type ReloadRunOptions } from './test-helpers/reload-harness.ts'
import { membershipPage, SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { makeChannelMessage, makeDeferredWebApiCall, makeDm, makeMembershipEvent, makeOwnFileShare, makePagedThread, mentionText, slackFileId, stubOpenedDmId, type PagedMessageSpec, type SlackEvent, type WebApiOutcome } from './test-helpers/slack-stub.ts'
import { readThreads, threadFsControls, threadPath, THREAD_ROOTS } from './test-helpers/thread-memory.ts'

const channel = SHARED_CHANNEL_IDS.primary
// Slack timestamps in the fake clock's first minute, including after restart.
const root = '10.000001', otherRoot = '10.000002'
const body = `own post body ${LEAK_SENTINEL}`
const identity = { botUserId: 'U0LOOKUPALPHA', botId: 'B0LOOKUPALPHA' }
const siblingIdentity = { botUserId: 'U0LOOKUPBRAVO', botId: 'B0LOOKUPBRAVO' }
let h: ReloadHarness, personas: PersonaInput[], sequence: number
let runs: ReloadRun[]
let releases: Array<() => void>
let errors: unknown[][], errorSpy: ReturnType<typeof spyOn<typeof console, 'error'>>

beforeEach(() => {
  h = makeReloadHarness({ personaConfigDirs: true }); runs = []; releases = []; sequence = 0
  errors = []; errorSpy = spyOn(console, 'error').mockImplementation((...args) => { errors.push(args) })
  personas = ['alpha', 'bravo'].map(name => h.persona(name, {
    channels: [{ id: channel, delivery: 'thread_hybrid' }],
    permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' },
  }))
  h.materialize(...personas)
})

// The Slack request deliberately contains the caller's body. Only that input
// field is masked; logs, replies, notices, records and all other fields are not.
function leakCheck(run: ReloadRun) {
  assertNoLeak(run.captured({ slack: Object.fromEntries(Object.entries(run.slackCalls()).map(([key, calls]) => [key,
    calls.map(call => call.method === 'chat.postMessage' && typeof call.args === 'object' && call.args !== null && 'text' in call.args && call.args.text === body
      ? { ...call, args: { ...call.args, text: '<caller body>' } } : call),
  ])), server: h.serverSideFiles(h.paths.config, ...personas.map(p => p.credentials_file!)) }))
  for (const key of ['alpha', 'bravo']) if (existsSync(threadPath(h.stateDir, key))) {
    assertNoLeak(writtenFile(threadPath(h.stateDir, key)))
  }
}
afterEach(async () => {
  try {
    for (const release of releases) release()
    for (const run of runs) { await run.clock.flush(); await run.stop(); leakCheck(run); expect(run.clock.pendingCount()).toBe(0) }
    assertNoLeak(errors)
  } finally { try { await h.cleanup() } finally { errorSpy.mockRestore() } }
})

function setup(mode: ChannelMode) { h.writeConfig({ channel_mode: mode, personas }) }
function pages(count = 1, parent?: string, extra: { outcomes?: Record<number, WebApiOutcome[]>; key?: string } = {}) {
  return makePagedThread(Math.max(1, count), {
    rootTs: parent ?? root, channel, identity: extra.key === 'bravo' ? siblingIdentity : identity,
    pageOutcomes: extra.outcomes,
    message: (i): PagedMessageSpec => ({ author: count ? 'own-user' : 'other-user', placement: parent ? 'reply' : 'channel',
      ts: parent ? (Number(parent) + (i + 1) / 1000).toFixed(6) : i === 0 ? root : otherRoot,
      threadTs: parent, text: body, file: false }),
  })
}
function withPages(run: ReloadRun, history: ReturnType<typeof pages>, key = 'alpha') {
  run.stub(key).responders.history = history.respondHistory
  run.stub(key).responders.replies = history.respondReplies
}
async function start(extra: ReloadRunOptions = {}, offset = 0, beforeStart?: (run: ReloadRun) => void) {
  const run = h.build({ ...extra, threadMemory: extra.threadMemory ?? {},
    slack: Object.fromEntries(personas.map(p => [p.name, {
      ...(p.name === 'alpha' ? identity : siblingIdentity), inventory: [membershipPage([channel])], ...extra.slack?.[p.name],
    }])),
  }); runs.push(run)
  beforeStart?.(run)
  await run.clock.advance(offset)
  expect(run.resolveStart().kind).toBe('applied')
  await run.controller.runStartBringUp()
  expect(run.startDetection()).toBe(true)
  if (!extra.dryRun) {
    await run.membershipClock.runNext()
    for (const p of personas) run.registerSession(p.name)
  }
  await run.clock.flush()
  return run
}
function records(key = 'alpha') { return readThreads(h.stateDir, key) }
function intents(key = 'alpha') { return records(key).filter(r => r.kind === 'post-intent') }
function outcomes(key = 'alpha') { return records(key).filter(r => r.kind === 'post-outcome') }
function joins(key = 'alpha') { return records(key).filter(r => r.kind === 'join') }
function view(run: ReloadRun, thread: string = root, key = 'alpha') { return run.threadMemory!.view(key, channel, thread) }
function lookups(run: ReloadRun, key = 'alpha') {
  return run.stub(key).callLog.filter(c => c.method === 'conversations.history' || c.method === 'conversations.replies')
}
function posted(run: ReloadRun, key = 'alpha') { return run.stub(key).calls.postMessage.filter(p => 'text' in p && p.text === body) }
function reply(run: ReloadRun, parent?: string, key = 'alpha') {
  return run.callTool(key, 'reply', { chat_id: channel, text: body, ...(parent ? { thread_ts: parent } : {}) })
}
async function unknown(run: ReloadRun, parent?: string, key = 'alpha') {
  run.stub(key).script.post.push({ kind: 'network' })
  const result = await reply(run, parent, key)
  expect(result.isError).toBe(true)
  assertNoLeak(result)
  await run.clock.flush()
  return result
}
async function hungPost(run: ReloadRun, parent?: string) {
  run.stub('alpha').script.post.push({ kind: 'never' })
  // A simulated process exit closes the SDK client; consume its rejection.
  void reply(run, parent).catch(() => {})
  await run.clock.flush()
  expect(posted(run)).toHaveLength(1)
  expect(intents()).toHaveLength(1)
  expect(outcomes()).toHaveLength(0)
}
async function intake(run: ReloadRun, thread: string, mention = false, key = 'alpha', extra: { parentUser?: string; text?: string } = {}) {
  const text = `${extra.text ?? 'incoming'} ${++sequence}`
  const event = makeChannelMessage({ channel, thread_ts: thread, ts: `1700000100.${String(sequence).padStart(6, '0')}`,
    text: mention ? `${mentionText(run.stub(key).identity.botUserId)} ${text}` : text,
    ...(extra.parentUser ? { parent_user_id: extra.parentUser } : {}) })
  await run.deliver(key, event); await run.clock.flush()
  return event
}
type ExpectedDelivery = readonly [Awaited<ReturnType<typeof intake>>, 'mention' | 'thread']
function expectDeliveries(run: ReloadRun, alpha: ExpectedDelivery[] = [], bravo: ExpectedDelivery[] = []) {
  for (const [key, expected] of [['alpha', alpha], ['bravo', bravo]] as const) {
    expect(run.deliveries(key)).toEqual(expected.map(([event, via]) => ({
      chat_id: String(event.channel), via, content: String(event.text),
    })))
    // Check the original Slack identity as well as content: a replacement
    // with the same text must not hide a lost or duplicated accepted event.
    expect(run.queued(key).map(({ accepted: a }) => ({
      key: a.key, ts: a.ts, thread_ts: a.thread_ts, user: a.user,
    }))).toEqual(expected.map(([event]) => ({
      key: { chat_id: String(event.channel), ts: String(event.ts) },
      ts: String(event.ts), thread_ts: String(event.thread_ts), user: String(event.user),
    })))
  }
}
async function crash(run: ReloadRun) {
  const files = ['alpha', 'bravo'].flatMap(key => [queuePath(h.stateDir, key), threadPath(h.stateDir, key)])
    .filter(existsSync).map(path => ({ path, bytes: readFileSync(path) }))
  await run.crash()
  for (const file of files) expect(readFileSync(file.path)).toEqual(file.bytes)
  expect(run.clock.pendingCount()).toBe(0)
}
async function flush(run: ReloadRun) { await run.clock.flush(); await run.threadMemory!.flush('alpha'); await run.clock.flush() }
function assign(run: ReloadRun, delivery: DeliveryMode, key = 'alpha') {
  const authority = run.controller.sharedChannels()!
  expect(authority.assign(key, authority.incarnation(key)!, channel, delivery, authority.revision).kind).toBe('applied')
}
function expectLoss(run: ReloadRun, cause?: string, threads: string[] = [], key = 'alpha') {
  const events = run.ownPostLookupEvents.filter(e => e.key === key)
  const lines = run.logsOf(THREAD_MEMORY_JOINS_LOST).filter(l => l.includes(`persona=${key}`))
  if (!cause) { expect(events).toHaveLength(0); expect(lines).toHaveLength(0); return }
  expect(events).toEqual([{ kind: 'joins-lost', key, channel, threads, cause }])
  const persona = run.serverConfig()!.personas.find(p => p.key === key)!
  const loss = { threads: [], messages: [], ownPosts: [{ channel, threads, cause }] }
  const notice = buildThreadMemoryJoinsLostNotice(persona, loss)
  expect(run.stub(key).calls.postMessage.filter(p => 'text' in p && p.text === formatPersonaNotice(persona, notice.text, notice.options)))
    .toEqual([{ channel: stubOpenedDmId('U0OPERATOR'), text: formatPersonaNotice(persona, notice.text, notice.options), metadata: SERVER_POST_METADATA }])
  expect(lines).toEqual([buildThreadMemoryJoinsLostLine(persona, loss)])
}

describe.each(['strict', 'open'] as const)('%s own-post crash recovery', mode => {
  test.each([undefined, root])('intent before confirmation, parent %s: found, one post and one thread delivery', async parent => {
    setup(mode)
    const first = await start()
    const original = await intake(first, THREAD_ROOTS.third, true)
    expectDeliveries(first, [[original, 'mention']])
    const accepted = JSON.parse(JSON.stringify(first.queued('alpha').map(i => i.accepted))) as ReturnType<ReloadRun['queued']>[number]['accepted'][]
    await hungPost(first, parent)
    await crash(first)
    const history = pages(1, parent)
    const recovered = await start({ slack: { alpha: { historyResponder: history.respondHistory, repliesResponder: history.respondReplies } } })
    await flush(recovered)
    expect(view(recovered, parent ?? root)).toBe('joined')
    expect(outcomes()).toMatchObject([{ outcome: 'joined' }])
    expect(outcomes()).toHaveLength(1)
    expect(joins().filter(j => j.source === 'own-post')).toHaveLength(1)
    expect(lookups(recovered)).toHaveLength(1)
    expect(lookups(recovered)[0]!.method).toBe(parent ? 'conversations.replies' : 'conversations.history')
    expect(posted(first)).toHaveLength(1); expect(posted(recovered)).toHaveLength(0)
    expect(recovered.queued('alpha').map(i => i.accepted)).toEqual(accepted.map(a => expect.objectContaining(a)))
    expectDeliveries(recovered, [[original, 'mention']])
    await recovered.deliver('alpha', original)
    expectDeliveries(recovered, [[original, 'mention']])
    const next = await intake(recovered, parent ?? root)
    expectDeliveries(recovered, [[original, 'mention'], [next, 'thread']])
    expectLoss(recovered)
    await recovered.stop()
    const again = await start()
    expect(view(again, parent ?? root)).toBe('joined')
    expect(lookups(again)).toHaveLength(0)
    expectDeliveries(again, [[original, 'mention'], [next, 'thread']])
    expectLoss(again)
  })

  test.each([0, 2])('crash before confirmation: %i matches close once without selecting a reply', async count => {
    setup(mode)
    const first = await start()
    await hungPost(first)
    await crash(first)
    const history = pages(count)
    const recovered = await start({ slack: { alpha: { historyResponder: history.respondHistory } } })
    await flush(recovered)
    expect(outcomes()).toMatchObject([{ outcome: 'none' }]); expect(outcomes()).toHaveLength(1)
    expect(view(recovered)).toBe('not-joined')
    expectDeliveries(recovered)
    await intake(recovered, root)
    expectDeliveries(recovered)
    expect(posted(first)).toHaveLength(1); expect(posted(recovered)).toHaveLength(0)
    expectLoss(recovered, count ? 'several' : undefined, count ? [otherRoot, root] : [])
    // A further restart reads the saved outcome and never looks up or reports it twice.
    await recovered.stop()
    const again = await start()
    expect(view(again)).toBe('not-joined'); expect(lookups(again)).toHaveLength(0); expectLoss(again)
    expectDeliveries(again)
  })

  test.each([false, true])('confirmed post with refused append; already joined by mention = %s', async mentioned => {
    setup(mode)
    const io = threadFsControls(h.stateDir), answer = makeDeferredWebApiCall()
    releases.push(() => { if (!answer.settled) answer.settle() })
    const first = await start({ threadMemory: { fs: io.fs } })
    first.stub('alpha').script.post.push(answer.outcome)
    const result = reply(first)
    await first.clock.flush()
    expect(intents()).toHaveLength(1); expect(posted(first)).toHaveLength(1)
    const accepted: ExpectedDelivery[] = mentioned ? [[await intake(first, root, true), 'mention']] : []
    expectDeliveries(first, accepted)
    io.fail('writeSync', 'alpha')
    answer.settle({ kind: 'ok', result: { ts: root } })
    expect((await result).isError).toBe(false)
    await first.clock.flush()
    expect(view(first)).toBe('joined'); expect(outcomes()).toHaveLength(0)
    expect(first.threadMemoryEvents.some(e => e.type === 'append-failed' && e.key === 'alpha')).toBe(true)
    await crash(first)
    io.heal()
    const history = pages()
    const recovered = await start({ slack: { alpha: { historyResponder: history.respondHistory } } })
    await flush(recovered)
    expect(view(recovered)).toBe('joined')
    expect(joins()).toHaveLength(1)
    expect(joins()[0]!.source).toBe(mentioned ? 'mention' : 'own-post')
    expect(outcomes().map(o => o.outcome)).toEqual([mentioned ? 'none' : 'joined'])
    expect(posted(recovered)).toHaveLength(0)
    expectDeliveries(recovered, accepted)
    const next = await intake(recovered, root)
    expectDeliveries(recovered, [...accepted, [next, 'thread']])
    expectLoss(recovered)
  })

  test('hung live lookup times out while intake, replies and the other persona continue', async () => {
    setup(mode)
    const run = await start(), late = makeDeferredWebApiCall()
    releases.push(() => { if (!late.settled) late.settle() })
    withPages(run, pages(1, undefined, { outcomes: { 0: [late.outcome] } }))
    await unknown(run)
    expect(lookups(run)).toHaveLength(1); expect(outcomes()).toHaveLength(0)
    const began = run.clock.now()
    const mention = await intake(run, THREAD_ROOTS.third, true)
    const next = await intake(run, THREAD_ROOTS.third)
    run.stub('alpha').script.post.push({ kind: 'ok', result: { ts: '1700000000.002000' } })
    expect((await reply(run, THREAD_ROOTS.third)).isError).toBe(false)
    withPages(run, pages(1, undefined, { key: 'bravo' }), 'bravo')
    await unknown(run, undefined, 'bravo')
    const sibling = await intake(run, root, false, 'bravo')
    expectDeliveries(run, [[mention, 'mention'], [next, 'thread']], [[sibling, 'thread']])
    expect(view(run, root, 'bravo')).toBe('joined')
    expect(run.clock.now()).toBe(began)
    await run.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS - 1)
    expect(lookups(run)).toHaveLength(1); expect(view(run)).toBe('not-joined')
    await run.clock.advance(1 + THREAD_MEMORY_RETRY_MIN_MS)
    await flush(run)
    expect(lookups(run)).toHaveLength(2); expect(view(run)).toBe('joined')
    const before = readFileSync(threadPath(h.stateDir))
    late.settle(); await run.clock.flush()
    expect(readFileSync(threadPath(h.stateDir))).toEqual(before)
    expect(outcomes()).toHaveLength(1); expectLoss(run)
    expectDeliveries(run, [[mention, 'mention'], [next, 'thread']], [[sibling, 'thread']])
  })

  test.each(['recovered', 'live'] as const)('unreadable journal: %s intent waits; read-time end precedes a delayed resolution save', async origin => {
    setup(mode)
    const first = await start()
    // A persisted joined thread supplies a releasable Memory Hold after read.
    const mention = await intake(first, THREAD_ROOTS.third, true)
    expectDeliveries(first, [[mention, 'mention']])
    if (origin === 'recovered') await hungPost(first)
    await crash(first)
    const io = threadFsControls(h.stateDir), queueIo = threadFsControls(h.stateDir)
    io.fail('readFileSync', 'alpha')
    const history = pages()
    const run = await start({
      threadMemory: { fs: io.fs, queueFs: queueIo.fs },
      slack: { alpha: { historyResponder: history.respondHistory } },
    })
    expect(run.threadMemory!.store('alpha')!.readable).toBe(false)
    if (origin === 'live') await unknown(run)
    // Another user's thread: P's unanswered new message cannot be its root, so
    // no Post Hold covers this reply and it stays k8's Memory Hold.
    const held = await intake(run, THREAD_ROOTS.third, false, 'alpha', { parentUser: 'U0THREADOWNER' })
    expect(run.queue.unresolvedHolds('alpha')).toHaveLength(1)
    expect(lookups(run)).toHaveLength(0)
    // Let unreadable retries run well past the skew; none can call Slack.
    await run.clock.advance(OWN_ROOT_CLOCK_SKEW_MS + THREAD_MEMORY_RETRY_MIN_MS)
    expect(lookups(run)).toHaveLength(0)
    // The first read's lookup kick waits for k8's durable resolution, so the
    // queue's next sync (that resolution's append) holds the kick back.
    const save = queueIo.hold('fsync', 'alpha', { match: path => path === queuePath(h.stateDir, 'alpha') })
    releases.push(save.release)
    let saveReached = false
    void save.reached.then(() => { saveReached = true })
    io.heal()
    // Read retry is the next memory retry, potentially after its backoff grew.
    for (let i = 0; i < 8 && !saveReached; i++) await run.clock.runNext()
    expect(saveReached).toBe(true)
    expect(run.threadMemory!.store('alpha')!.readable).toBe(true)
    const readTime = run.clock.now()
    expect(lookups(run)).toHaveLength(0)
    await run.clock.advance(OWN_ROOT_CLOCK_SKEW_MS + THREAD_MEMORY_RETRY_MIN_MS)
    expect(lookups(run)).toHaveLength(0)
    expect(run.queue.unresolvedHolds('alpha')).toHaveLength(1)
    save.release(); await flush(run)
    expect(lookups(run)).toHaveLength(1)
    // The persona clock can be 1 ms ahead of wall time. Both bounds are still
    // at the read event, far before the delayed resolution saved above.
    const end = Number(run.stub('alpha').calls.conversationsHistory[0]!.latest) * 1000 - OWN_ROOT_CLOCK_SKEW_MS
    expect(end).toBeGreaterThanOrEqual(readTime)
    expect(end).toBeLessThanOrEqual(readTime + 1)
    expect(view(run)).toBe('joined')
    expect(run.queue.unresolvedHolds('alpha')).toHaveLength(0)
    expectDeliveries(run, [[mention, 'mention'], [held, 'thread']])
    const next = await intake(run, root)
    expectDeliveries(run, [[mention, 'mention'], [held, 'thread'], [next, 'thread']])
    expect(outcomes()).toHaveLength(1); expectLoss(run)
  })

  test('stamp changed away and back before restart closes the intent without a lookup', async () => {
    setup(mode)
    const first = await start()
    await hungPost(first)
    assign(first, 'mentions'); assign(first, 'thread_hybrid')
    await crash(first)
    const run = await start()
    await flush(run)
    expect(lookups(run)).toHaveLength(0); expect(view(run)).toBe('not-joined')
    expect(outcomes().map(o => o.outcome)).toEqual(['none']); expectLoss(run)
    await intake(run, root)
    expectDeliveries(run)
  })

  test('a stale in-flight answer cannot restore the forgotten thread', async () => {
    setup(mode)
    const run = await start(), late = makeDeferredWebApiCall()
    releases.push(() => { if (!late.settled) late.settle() })
    withPages(run, pages(1, undefined, { outcomes: { 0: [late.outcome] } }))
    await unknown(run)
    expect(lookups(run)).toHaveLength(1)
    assign(run, 'mentions'); assign(run, 'thread_hybrid')
    await flush(run)
    expect(outcomes().map(o => o.outcome)).toEqual(['none'])
    late.settle(); await flush(run)
    expect(view(run)).toBe('not-joined'); expect(lookups(run)).toHaveLength(1); expectLoss(run)
    await intake(run, root); expectDeliveries(run)
  })

  test.each(['not_in_channel', 'thread_not_found'] as const)('permanent %s answer closes the post once', async error => {
    setup(mode)
    const run = await start(), parent = error === 'thread_not_found' ? root : undefined
    withPages(run, pages(1, parent, { outcomes: { 0: [{ kind: 'platform', error }] } }))
    await unknown(run, parent); await flush(run)
    expect(outcomes().map(o => o.outcome)).toEqual(['none'])
    expect(view(run)).toBe('not-joined'); expect(lookups(run)).toHaveLength(1)
    expectLoss(run, parent ? undefined : error)
    expectDeliveries(run)
  })

  test('teardown and bring-up cancel an old attempt and recover once from disk', async () => {
    setup(mode)
    const run = await start(), late = makeDeferredWebApiCall()
    releases.push(() => { if (!late.settled) late.settle() })
    withPages(run, pages(1, undefined, { outcomes: { 0: [late.outcome] } }))
    await unknown(run)
    const persona = run.serverConfig()!.personas[0]!
    await run.composition!.lifecycle.teardown(persona)
    expect(lookups(run)).toHaveLength(1); expect(outcomes()).toHaveLength(0)
    run.stub('alpha').script.inventory.push(membershipPage([channel]))
    await run.composition!.lifecycle.bringUp(persona, run.serverConfig()!)
    await run.membershipClock.runNext(); await flush(run)
    expect(view(run)).toBe('joined'); expect(lookups(run)).toHaveLength(2)
    expect(outcomes().map(o => o.outcome)).toEqual(['joined'])
    late.settle(); await flush(run)
    expect(outcomes()).toHaveLength(1); expectLoss(run)
    run.registerSession('alpha')
    expectDeliveries(run)
    const next = await intake(run, root)
    expectDeliveries(run, [[next, 'thread']])
  })

  test('removal cancels one hung lookup without delaying the other persona', async () => {
    setup(mode)
    const run = await start(), a = makeDeferredWebApiCall(), b = makeDeferredWebApiCall()
    releases.push(() => { if (!a.settled) a.settle() }, () => { if (!b.settled) b.settle() })
    withPages(run, pages(1, undefined, { outcomes: { 0: [a.outcome] } }))
    withPages(run, pages(1, undefined, { key: 'bravo', outcomes: { 0: [b.outcome] } }), 'bravo')
    await unknown(run); await unknown(run, undefined, 'bravo')
    expect(lookups(run)).toHaveLength(1); expect(lookups(run, 'bravo')).toHaveLength(1)
    const began = run.clock.now()
    h.writeConfig({ channel_mode: mode, personas: [personas[1]!] })
    const preview = run.checkpoint()
    await run.ticks.tick()
    expect(run.since(preview).lifecycle).toEqual([])
    // Both original page responses stay held across the confirmed removal.
    const cp = run.checkpoint(), timeline = run.lifecycle.applyTimeline.length
    const sibling = {
      session: run.session('bravo'), socket: run.stub('bravo').socket,
      client: run.connections.clientFor('bravo'),
      activity: run.socketActivity('bravo'), builds: run.slack.buildsOf('bravo').length,
      calls: structuredClone(run.slackCalls().bravo),
      socketCalls: [run.stub('bravo').socket.startCalls, run.stub('bravo').socket.disconnectCalls],
      compositionCalls: run.composition!.calls.length,
    }
    expect(sibling.session).toBeDefined(); expect(sibling.client).toBeDefined()
    const originalAttempt = lookups(run, 'bravo')[0]!
    const operation = intents('bravo')[0]!.operationId
    expect(a.settled).toBe(false); expect(b.settled).toBe(false)
    expect(outcomes('bravo')).toEqual([])
    h.confirm(); await run.ticks.tick(); await run.clock.flush()
    expect(run.clock.now()).toBe(began)
    expect(run.appliedKeys()).toEqual(['bravo'])
    expect(run.since(cp).lifecycle).toEqual([
      { op: 'teardown', key: 'alpha', via: 'apply' },
      { op: 'template-refresh', key: TEMPLATE_REFRESH_KEY, via: 'apply', refresh: { kind: 'refreshed', path: expect.any(String) } },
    ])
    expect(run.lifecycle.applyTimeline.slice(timeline)).toEqual([
      { op: 'teardown', key: 'alpha', phase: 'start' }, { op: 'teardown', key: 'alpha', phase: 'settled' },
      { op: 'template-refresh', key: TEMPLATE_REFRESH_KEY, phase: 'start' }, { op: 'template-refresh', key: TEMPLATE_REFRESH_KEY, phase: 'settled' },
    ])
    expect(run.composition!.calls.slice(sibling.compositionCalls).filter(([, key]) => key === 'bravo')).toEqual([])
    expect(run.session('bravo')).toBe(sibling.session)
    expect(run.stub('bravo').socket).toBe(sibling.socket)
    expect(run.connections.clientFor('bravo')).toBe(sibling.client)
    expect(run.socketActivity('bravo')).toEqual(sibling.activity)
    expect([sibling.socket.startCalls, sibling.socket.disconnectCalls]).toEqual(sibling.socketCalls)
    expect(run.slack.buildsOf('bravo')).toHaveLength(sibling.builds)
    expect(run.slackCalls().bravo).toEqual(sibling.calls)
    expect(a.settled).toBe(false); expect(b.settled).toBe(false)
    expect(lookups(run, 'bravo')).toEqual([originalAttempt])
    expect(outcomes('bravo')).toEqual([]); expect(view(run, root, 'bravo')).toBe('not-joined')
    expect(run.ownPostJoins!.unknownOwnPosts('bravo').map(p => p.operationId)).toEqual([operation])
    expectDeliveries(run)
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    const removals = run.removes.length
    const posts = run.stub('alpha').calls.postMessage.length
    a.settle(); await run.clock.flush()
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    expect(run.stub('alpha').calls.postMessage).toHaveLength(posts)
    expect(lookups(run, 'bravo')).toEqual([originalAttempt]); expect(outcomes('bravo')).toEqual([])
    expect(b.settled).toBe(false)
    b.settle(); await run.clock.flush()
    expect(view(run, root, 'bravo')).toBe('joined')
    expect(outcomes('bravo').map(o => o.outcome)).toEqual(['joined'])
    expect(outcomes('bravo')[0]!.operationId).toBe(operation)
    expect(joins('bravo').filter(j => j.source === 'own-post')).toHaveLength(1)
    expect(run.ownPostJoins!.unknownOwnPosts('bravo')).toEqual([])
    await run.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS + THREAD_MEMORY_RETRY_MIN_MS)
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    expect(lookups(run)).toHaveLength(1); expect(run.removes).toHaveLength(removals)
    expect(run.stub('alpha').calls.postMessage).toHaveLength(posts)
    expect(lookups(run, 'bravo')).toEqual([originalAttempt]); expect(outcomes('bravo')).toHaveLength(1)
    expectLoss(run); expectLoss(run, undefined, [], 'bravo')
    const next = await intake(run, root, false, 'bravo')
    expectDeliveries(run, [], [[next, 'thread']])
  })

  test('shutdown completes with a hung lookup and leaves no timer or late append', async () => {
    setup(mode)
    const run = await start(), late = makeDeferredWebApiCall()
    releases.push(() => { if (!late.settled) late.settle() })
    withPages(run, pages(1, undefined, { outcomes: { 0: [late.outcome] } }))
    await unknown(run)
    const began = run.clock.now()
    await run.stop()
    expect(run.clock.now()).toBe(began); expect(run.clock.pendingCount()).toBe(0)
    const bytes = readFileSync(threadPath(h.stateDir)), posts = run.slackPosts().length
    late.settle(); await run.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS + THREAD_MEMORY_RETRY_MIN_MS)
    expect(readFileSync(threadPath(h.stateDir))).toEqual(bytes)
    expect(lookups(run)).toHaveLength(1); expect(run.slackPosts()).toHaveLength(posts); expectLoss(run)
  })

  test('dry run writes no Thread Memory journal and performs no lookup, even for a file reply', async () => {
    setup(mode)
    const run = await start({ dryRun: true, uploads: true })
    run.registerSession('alpha')
    const result = await run.callTool('alpha', 'reply', { chat_id: channel, text: body, files: [uploadFile()] })
    await flush(run)
    expect(result).toEqual({ isError: false, text: `[dry-run] Would send message to ${channel}` })
    expect(errors.map(args => args.join(' '))).toContain(`[slack] dry-run: reply to ${channel} (${body.length} chars)`)
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    expect(existsSync(threadPath(h.stateDir, 'bravo'))).toBe(false)
    expect(Object.values(run.slackCalls()).flat()).toHaveLength(0)
    expect(run.ownPostLookupEvents).toHaveLength(0)
    await run.stop()
    expect(existsSync(threadPath(h.stateDir))).toBe(false); expectLoss(run)
  })

  test('dry run reads a surviving unknown intent without looking it up or changing its journal', async () => {
    setup(mode)
    const first = await start()
    await hungPost(first); await crash(first)
    const bytes = readFileSync(threadPath(h.stateDir))
    const dry = await start({ dryRun: true })
    expect(dry.threadMemory!.store('alpha')!.readable).toBe(true)
    expect(intents()).toHaveLength(1); expect(outcomes()).toHaveLength(0)
    expect(Object.values(dry.slackCalls()).flat()).toHaveLength(0)
    await dry.stop()
    expect(readFileSync(threadPath(h.stateDir))).toEqual(bytes)
    expectLoss(dry)
  })
})

// A file uploaded as a new channel message starts its own thread at P's own
// share message, learnt from P's Event or a history read (SR-3.2.3).
const share = '20.000001'
const fileId = slackFileId(1)
// The caller's file sits under the harness root the leak check scans, so it carries no sentinel.
const uploadBody = 'upload body'
function uploadFile() {
  const dir = join(h.root, 'inbox')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'upload.txt')
  writeFileSync(path, uploadBody)
  return path
}
/** A files-only reply, whose one file is uploaded as a new channel message; Slack's completion names `fileId`, or `completion` answers instead. */
function upload(run: ReloadRun, completion?: WebApiOutcome, key = 'alpha') {
  run.stub(key).script.completeUpload.push(completion ?? { kind: 'ok', result: { files: [{ id: fileId }] } })
  return run.callTool(key, 'reply', { chat_id: channel, text: '', files: [uploadFile()] })
}
function uploads(run: ReloadRun, key = 'alpha') { return run.stub(key).calls.filesUploadV2 }
function histories(run: ReloadRun, key = 'alpha') { return run.stub(key).calls.conversationsHistory }
/** P's share in the history, or only another user's message when `found` is false. */
function sharePages(found: boolean, extra: { outcomes?: Record<number, WebApiOutcome[]>; key?: string } = {}) {
  return makePagedThread(1, { channel, identity: extra.key === 'bravo' ? siblingIdentity : identity, pageOutcomes: extra.outcomes,
    message: (): PagedMessageSpec => found
      ? { author: 'own-user', placement: 'channel', ts: share, text: '', file: { name: 'upload.txt', size: Buffer.byteLength(uploadBody) }, fileIds: [fileId] }
      : { author: 'other-user', placement: 'channel', ts: share, text: 'unrelated', file: false } })
}
function shareEvent(run: ReloadRun, key = 'alpha') {
  return makeOwnFileShare({ identity: run.stub(key).identity, channel, ts: share, fileIds: [fileId] })
}
/** Today's handling of P's own message: one ack, the `own` drop line and nothing queued. */
async function deliverOwnShare(run: ReloadRun, key = 'alpha') {
  const event = shareEvent(run, key), acks = run.stub(key).socket.acks.length, cp = run.checkpoint(), queued = run.queued(key).length
  await run.deliver(key, event); await run.clock.flush()
  const persona = run.serverConfig()!.personas.find(p => p.key === key)!
  expect(run.stub(key).socket.acks).toHaveLength(acks + 1)
  expect(run.since(cp).logs).toEqual([`[slack] RAW message event persona=${key}: ${JSON.stringify(event)}`,
    `[slack] persona ${renderPersonaRef(persona.name, persona.key)} dropped message from channel=${channel} user=${run.stub(key).identity.botUserId}: own`])
  expect(run.queued(key)).toHaveLength(queued)
}
function uploadJoins(key = 'alpha') { return joins(key).filter(j => j.source === 'own-post' && j.root === share) }
/** The upload's outcomes: its intent is the latest, which a restart may compact away. */
function uploadOutcomes(key = 'alpha') {
  const intent = intents(key).at(-1)
  return intent ? outcomes(key).filter(o => o.operationId === intent.operationId) : []
}
async function uploadStart(extra: ReloadRunOptions = {}) { return start({ ...extra, uploads: true }) }

describe.each(['strict', 'open'] as const)('%s upload threads', mode => {
  test('an Event after the completion joins the share without a further read', async () => {
    setup(mode)
    const run = await uploadStart(), late = makeDeferredWebApiCall()
    releases.push(() => { if (!late.settled) late.settle() })
    withPages(run, sharePages(true, { outcomes: { 0: [late.outcome] } }))
    expect((await upload(run)).isError).toBe(false)
    await run.clock.flush()
    expect(uploads(run)).toHaveLength(1); expect(run.stub('alpha').calls.postMessage).toHaveLength(0)
    // The completion's own kick has started a read, which is still unanswered.
    expect(histories(run)).toHaveLength(1)
    expect(view(run, share)).toBe('not-joined')
    expect(run.ownPostJoins!.awaitingUploads('alpha').map(p => p.file)).toEqual([fileId])
    await deliverOwnShare(run)
    expect(view(run, share)).toBe('joined')
    expect(run.ownPostJoins!.awaitingUploads('alpha')).toEqual([])
    const next = await intake(run, share)
    const cp = run.checkpoint(), elsewhere = await intake(run, THREAD_ROOTS.third)
    expectDeliveries(run, [[next, 'thread']])
    expect(run.since(cp).logs).toEqual([`[slack] RAW message event persona=alpha: ${JSON.stringify(elsewhere)}`,
      `[slack] persona "alpha" (key=alpha) dropped message from channel=${channel} user=${elsewhere.user}: not-mentioned`])
    await flush(run)
    expect(uploadJoins()).toHaveLength(1); expect(uploadOutcomes().map(o => o.outcome)).toEqual(['joined'])
    // Neither the Event nor the abandoned attempt reads again, and its late answer records nothing.
    await run.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS + THREAD_MEMORY_RETRY_MAX_MS)
    const bytes = readFileSync(threadPath(h.stateDir))
    late.settle(); await flush(run)
    expect(readFileSync(threadPath(h.stateDir))).toEqual(bytes)
    expect(histories(run)).toHaveLength(1); expect(lookups(run)).toHaveLength(1)
    expectLoss(run)
  })

  test.each(['first', 'never'] as const)('an Event that comes %s leaves the share to one history read', async event => {
    setup(mode)
    const run = await uploadStart(), completion = makeDeferredWebApiCall()
    releases.push(() => { if (!completion.settled) completion.settle() })
    withPages(run, sharePages(true))
    const result = upload(run, completion.outcome)
    await run.clock.flush()
    expect(run.stub('alpha').calls.completeUploadExternal).toHaveLength(1)
    if (event === 'first') await deliverOwnShare(run)
    expect(histories(run)).toHaveLength(0); expect(view(run, share)).toBe('not-joined')
    completion.settle({ kind: 'ok', result: { files: [{ id: fileId }] } })
    expect((await result).isError).toBe(false)
    await flush(run)
    expect(histories(run)).toHaveLength(1)
    expect(histories(run)[0]).not.toHaveProperty('latest')
    expect(view(run, share)).toBe('joined')
    expect(uploadJoins()).toHaveLength(1); expect(uploadOutcomes().map(o => o.outcome)).toEqual(['joined'])
    const next = await intake(run, share)
    expectDeliveries(run, [[next, 'thread']])
    await run.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS + THREAD_MEMORY_RETRY_MAX_MS)
    expect(histories(run)).toHaveLength(1); expect(uploads(run)).toHaveLength(1)
    expectLoss(run)
  })

  test('crash while the upload awaits its thread: the restart lookup joins the share once', async () => {
    setup(mode)
    const first = await uploadStart()
    withPages(first, sharePages(false))
    expect((await upload(first)).isError).toBe(false)
    await flush(first)
    // Read once without the share; the next read waits for its spacing.
    expect(histories(first)).toHaveLength(1)
    expect(first.ownPostJoins!.awaitingUploads('alpha').map(p => p.file)).toEqual([fileId])
    expect(uploadOutcomes()).toEqual([]); expect(view(first, share)).toBe('not-joined')
    await crash(first)
    const history = sharePages(true)
    const recovered = await uploadStart({ slack: { alpha: { historyResponder: history.respondHistory } } })
    await flush(recovered)
    expect(view(recovered, share)).toBe('joined')
    expect(uploadOutcomes().map(o => o.outcome)).toEqual(['joined']); expect(uploadJoins()).toHaveLength(1)
    // di's digest lookup, bounded above by the read end.
    expect(histories(recovered)).toHaveLength(1); expect(histories(recovered)[0]).toHaveProperty('latest')
    expect(uploads(first)).toHaveLength(1); expect(uploads(recovered)).toHaveLength(0)
    expect(first.stub('alpha').calls.postMessage).toHaveLength(0); expect(posted(recovered)).toHaveLength(0)
    const next = await intake(recovered, share)
    expectDeliveries(recovered, [[next, 'thread']])
    expectLoss(recovered)
    await recovered.stop()
    const again = await uploadStart()
    expect(view(again, share)).toBe('joined'); expect(histories(again)).toHaveLength(0)
    // The settled intent may be compacted; nothing is left to look up again.
    expect(again.ownPostJoins!.unknownOwnPosts('alpha')).toEqual([]); expect(uploadJoins()).toHaveLength(1)
    expectLoss(again)
  })

  test('a hung upload read holds up no delivery, reply or other persona', async () => {
    setup(mode)
    const run = await uploadStart(), late = makeDeferredWebApiCall()
    releases.push(() => { if (!late.settled) late.settle() })
    withPages(run, sharePages(true, { outcomes: { 0: [late.outcome] } }))
    expect((await upload(run)).isError).toBe(false)
    await run.clock.flush()
    expect(histories(run)).toHaveLength(1)
    const began = run.clock.now()
    const mention = await intake(run, THREAD_ROOTS.third, true)
    const next = await intake(run, THREAD_ROOTS.third)
    run.stub('alpha').script.post.push({ kind: 'ok', result: { ts: '1700000000.002000' } })
    expect((await reply(run, THREAD_ROOTS.third)).isError).toBe(false)
    const siblingMention = await intake(run, THREAD_ROOTS.third, true, 'bravo')
    const sibling = await intake(run, THREAD_ROOTS.third, false, 'bravo')
    expectDeliveries(run, [[mention, 'mention'], [next, 'thread']], [[siblingMention, 'mention'], [sibling, 'thread']])
    expect(run.clock.now()).toBe(began)
    expect(histories(run)).toHaveLength(1); expect(view(run, share)).toBe('not-joined')
    // The attempt's deadline ends it; the next read finds the share.
    await run.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS + THREAD_MEMORY_RETRY_MIN_MS)
    await flush(run)
    expect(histories(run)).toHaveLength(2); expect(view(run, share)).toBe('joined')
    const bytes = readFileSync(threadPath(h.stateDir))
    late.settle(); await flush(run)
    expect(readFileSync(threadPath(h.stateDir))).toEqual(bytes)
    const reply2 = await intake(run, share)
    expectDeliveries(run, [[mention, 'mention'], [next, 'thread'], [reply2, 'thread']], [[siblingMention, 'mention'], [sibling, 'thread']])
    expect(uploadJoins()).toHaveLength(1); expectLoss(run)
  })

  test('teardown and bring-up cancel a hung upload read and settle it once from the journal', async () => {
    setup(mode)
    const run = await uploadStart(), late = makeDeferredWebApiCall()
    releases.push(() => { if (!late.settled) late.settle() })
    withPages(run, sharePages(true, { outcomes: { 0: [late.outcome] } }))
    expect((await upload(run)).isError).toBe(false)
    await run.clock.flush()
    const persona = run.serverConfig()!.personas[0]!
    await run.composition!.lifecycle.teardown(persona)
    expect(histories(run)).toHaveLength(1); expect(uploadOutcomes()).toEqual([])
    run.stub('alpha').script.inventory.push(membershipPage([channel]))
    await run.composition!.lifecycle.bringUp(persona, run.serverConfig()!)
    await run.membershipClock.runNext(); await flush(run)
    expect(view(run, share)).toBe('joined')
    expect(histories(run)).toHaveLength(2); expect(histories(run)[1]).toHaveProperty('latest')
    expect(uploadOutcomes().map(o => o.outcome)).toEqual(['joined'])
    late.settle(); await flush(run)
    await run.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS + THREAD_MEMORY_RETRY_MAX_MS)
    expect(histories(run)).toHaveLength(2); expect(uploadOutcomes()).toHaveLength(1); expect(uploadJoins()).toHaveLength(1)
    expect(uploads(run)).toHaveLength(1); expectLoss(run)
    run.registerSession('alpha')
    const next = await intake(run, share)
    expectDeliveries(run, [[next, 'thread']])
  })

  test('removal cancels a hung upload read: nothing is read, recorded or recreated for the removed persona', async () => {
    setup(mode)
    const run = await uploadStart(), late = makeDeferredWebApiCall()
    releases.push(() => { if (!late.settled) late.settle() })
    withPages(run, sharePages(true, { outcomes: { 0: [late.outcome] } }))
    expect((await upload(run)).isError).toBe(false)
    await run.clock.flush()
    expect(histories(run)).toHaveLength(1)
    const began = run.clock.now()
    h.writeConfig({ channel_mode: mode, personas: [personas[1]!] })
    await run.ticks.tick()
    h.confirm(); await run.ticks.tick(); await run.clock.flush()
    expect(run.appliedKeys()).toEqual(['bravo'])
    expect(run.clock.now()).toBe(began)
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    expect(run.ownPostJoins!.awaitingUploads('alpha')).toEqual([])
    const calls = run.stub('alpha').callLog.length
    late.settle(); await run.clock.flush()
    await run.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS + THREAD_MEMORY_RETRY_MAX_MS)
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    expect(run.stub('alpha').callLog).toHaveLength(calls); expect(histories(run)).toHaveLength(1)
    expect(run.ownPostLookupEvents).toEqual([]); expect(run.ownPostJoins!.awaitingUploads('alpha')).toEqual([])
    const sibling = await intake(run, THREAD_ROOTS.third, true, 'bravo')
    expectDeliveries(run, [], [[sibling, 'mention']])
    expectLoss(run)
  })

  test.each(['hung', 'spaced after a miss'] as const)('shutdown completes with an upload read %s and leaves no timer or late append', async read => {
    setup(mode)
    const run = await uploadStart(), late = makeDeferredWebApiCall()
    releases.push(() => { if (!late.settled) late.settle() })
    withPages(run, read === 'hung' ? sharePages(true, { outcomes: { 0: [late.outcome] } }) : sharePages(false))
    if (read !== 'hung') late.settle()
    expect((await upload(run)).isError).toBe(false)
    await flush(run)
    expect(histories(run)).toHaveLength(1)
    // A miss leaves the next read's spacing timer pending.
    if (read !== 'hung') expect(run.clock.pendingCount()).toBeGreaterThan(0)
    const began = run.clock.now()
    await run.stop()
    expect(run.clock.now()).toBe(began); expect(run.clock.pendingCount()).toBe(0)
    const bytes = readFileSync(threadPath(h.stateDir)), posts = run.slackPosts().length
    if (!late.settled) late.settle()
    await run.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS + THREAD_MEMORY_RETRY_MAX_MS)
    expect(readFileSync(threadPath(h.stateDir))).toEqual(bytes)
    expect(histories(run)).toHaveLength(1); expect(run.slackPosts()).toHaveLength(posts)
    expect(uploadOutcomes()).toEqual([]); expectLoss(run)
  })
})

// Post Holds (SR-4.2): a reply in a thread P's own unanswered post could put P in
// is stored before the ack and heads P's FIFO until the post lands, fails or
// THREAD_REPLY_HOLD_MS passes; a start or a same-run bring-up releases it.
const neighbor = SHARED_CHANNEL_IDS.secondary
/** The held reply's words: no hold event, release or resolution record carries them. */
const heldBody = 'held reply body'
/** The `ts` Slack gives P's post, when it answers. */
const postTs = '1700000000.000900'
function holdSetup(mode: ChannelMode) {
  personas = ['alpha', 'bravo'].map(name => h.persona(name, {
    channels: [{ id: channel, delivery: 'thread_hybrid' }, { id: neighbor, delivery: 'all' }],
    permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' },
  }))
  h.writeConfig({ channel_mode: mode, personas, queued_ack_reaction: 'hourglass' })
}
function holdStart(extra: ReloadRunOptions = {}, beforeStart?: (run: ReloadRun) => void) {
  return start({ ...extra, slack: Object.fromEntries(personas.map(p => [p.name,
    { inventory: [membershipPage([channel, neighbor])], ...extra.slack?.[p.name] }])) }, 0, beforeStart)
}
/** P's `reply` into `parent`'s thread, or as a new channel message, with Slack's answer held open. */
async function heldPost(run: ReloadRun, parent?: string, key = 'alpha') {
  const answer = makeDeferredWebApiCall()
  releases.push(() => { if (!answer.settled) answer.settle() })
  run.stub(key).script.post.push(answer.outcome)
  const posts = posted(run, key).length
  const result = reply(run, parent, key)
  // A stop closes the SDK client; a case reads the result only once it has answered.
  void result.catch(() => {})
  await run.clock.flush()
  expect(posted(run, key)).toHaveLength(posts + 1)
  return { answer, result }
}
/** The queued feedback a reply has had: its received log lines and its queued reactions. */
function feedback(run: ReloadRun, event: SlackEvent, key = 'alpha') {
  return { received: run.logs.filter(l => l.includes('received') && l.includes(String(event.ts))).length,
    reactions: run.stub(key).calls.reactionsAdd.filter(a => a.timestamp === event.ts).length }
}
/** A person's reply in `thread`, received now on the run's clock: stored as a Post Hold and acknowledged, with no feedback. */
async function heldReply(run: ReloadRun, thread: string, key = 'alpha', parentUser?: string) {
  const receivedAt = run.clock.now(), acks = run.stub(key).socket.acks.length
  const event = await intake(run, thread, false, key, { text: heldBody, ...(parentUser ? { parentUser } : {}) })
  expect(run.stub(key).socket.acks).toHaveLength(acks + 1)
  const item = run.queued(key).find(i => i.accepted.ts === event.ts)!
  expect(item.hold).toMatchObject({ kind: 'post', state: 'unresolved' })
  expect(feedback(run, event, key)).toEqual({ received: 0, reactions: 0 })
  return { event, receivedAt, seq: item.accepted.seq }
}
function resolutions(key = 'alpha') {
  return readQueue(h.stateDir, key).filter(r => r.kind === 'released' || r.kind === 'hold-withdrawn' || r.kind === 'parked')
}
function expectHoldOutputsQuiet(run: ReloadRun) {
  expect(JSON.stringify({ events: run.postHoldEvents, releases: run.postHoldReleases, saved: resolutions() })).not.toContain(heldBody)
}
async function dm(run: ReloadRun, key = 'alpha') {
  const event = makeDm({ ts: `1700000100.${String(++sequence).padStart(6, '0')}`, text: `dm ${sequence}` })
  await run.deliver(key, event); await run.clock.flush()
  return event
}
async function elsewhere(run: ReloadRun, key = 'alpha') {
  const event = makeChannelMessage({ channel: neighbor, ts: `1700000100.${String(++sequence).padStart(6, '0')}`, text: `other ${sequence}` })
  await run.deliver(key, event); await run.clock.flush()
  return event
}
/** The real engine over P's queue: it types exactly `expected`'s prepared parts, in this order, and nothing else. */
async function drain(run: ReloadRun, expected: readonly SlackEvent[], key = 'alpha') {
  await run.prepareQueued()
  const items = run.queued(key), parts = expected.flatMap(event => items.find(i => i.accepted.ts === event.ts)!.fixed!.parts)
  const engine = await makeEngineHarness({ queue: run.queue, stateDir: h.stateDir, keys: [key] })
  try {
    await engine.tick(key)
    if (expected.length) await engine.until(() => expected.every(event => run.queued(key).find(i => i.accepted.ts === event.ts)!.delivered))
    await engine.advance(4 * DELIVERY_ROW_POLL_MS)
    expect(engine.textCalls(key).map(c => c.params.text)).toEqual(parts)
    expect(engine.errors).toEqual([])
    assertNoLeak({ calls: engine.calls, events: engine.events })
  } finally { await engine.cleanup() }
}
const restartLines = (from: number) => errors.slice(from).map(args => args.join(' ')).filter(line => /scheduleRestart|Scheduling restart/.test(line))

describe.each(['strict', 'open'] as const)('%s Post Holds end to end', mode => {
  test.each(['confirmed', 'failed', 'unanswered'] as const)('a reply held on P\'s post into its thread, %s: it heads P\'s FIFO with no feedback until released or withdrawn', async outcome => {
    holdSetup(mode)
    const run = await holdStart()
    const post = await heldPost(run, root)
    const held = await heldReply(run, root)
    const direct = await dm(run), other = await elsewhere(run)
    const theirs = await intake(run, otherRoot, true, 'bravo'), theirReply = await intake(run, otherRoot, false, 'bravo')
    // Nothing of P's passes its unresolved hold; another persona's traffic flows.
    await drain(run, [])
    await drain(run, [theirs, theirReply], 'bravo')
    if (outcome === 'confirmed') {
      await run.clock.advance(1000)
      post.answer.settle({ kind: 'ok', result: { ts: postTs, message: { thread_ts: root } } })
      expect((await post.result).isError).toBe(false)
    } else if (outcome === 'failed') {
      post.answer.settle({ kind: 'platform', error: 'not_in_channel' })
      expect((await post.result).isError).toBe(true)
    } else {
      await run.clock.advanceTo(held.receivedAt + THREAD_REPLY_HOLD_MS - 1)
      expect(run.queue.item('alpha', held.seq)!.hold!.state).toBe('unresolved')
      expect(run.postHoldEvents).toEqual([])
      await run.clock.advance(1)
    }
    await run.clock.flush()
    const resolved = outcome === 'failed' ? 'withdrawn' : 'released'
    expect(resolutions()).toEqual([{ v: 1, kind: resolved === 'withdrawn' ? 'hold-withdrawn' : resolved, seq: held.seq, at: expect.any(Number) }])
    expect(run.postHoldEvents).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq: held.seq, outcome: resolved,
      cause: outcome === 'confirmed' ? 'thread' : outcome === 'failed' ? 'outcomes' : 'timer',
      heldMs: outcome === 'confirmed' ? 1000 : outcome === 'failed' ? 0 : THREAD_REPLY_HOLD_MS }])
    expect(run.postHoldReleases).toEqual(resolved === 'released' ? [{ key: 'alpha', seq: held.seq, mode: 'live' }] : [])
    expect(run.queue.item('alpha', held.seq)!.accepted.via).toBe('thread')
    // Queued feedback only on release (t1.tad.5i SR-6.2), once; none for a withdrawn reply.
    expect(feedback(run, held.event)).toEqual(resolved === 'released' ? { received: 1, reactions: 1 } : { received: 0, reactions: 0 })
    // Released without a join on timeout; a confirmed post joins its own thread.
    expect(view(run, root)).toBe(outcome === 'confirmed' ? 'joined' : 'not-joined')
    await drain(run, [...(resolved === 'released' ? [held.event] : []), direct, other])
    if (resolved === 'withdrawn') {
      // It keeps its durable key: Slack's redelivery adds nothing and gets no feedback.
      const items = run.queued('alpha').length
      await run.deliver('alpha', held.event); await run.clock.flush()
      expect(run.queued('alpha')).toHaveLength(items)
      expect(feedback(run, held.event)).toEqual({ received: 0, reactions: 0 })
    }
    expectHoldOutputsQuiet(run); expectLoss(run)
  })

  test('a reply in the new thread of P\'s held channel message is released when Slack names that thread; later replies there are delivered', async () => {
    holdSetup(mode)
    const run = await holdStart()
    const post = await heldPost(run)
    const held = await heldReply(run, postTs, 'alpha', run.stub('alpha').identity.botUserId)
    await run.clock.advance(500)
    post.answer.settle({ kind: 'ok', result: { ts: postTs } })
    expect((await post.result).isError).toBe(false)
    await run.clock.flush()
    expect(run.postHoldEvents).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq: held.seq, outcome: 'released', cause: 'thread', heldMs: 500 }])
    expect(run.postHoldReleases).toEqual([{ key: 'alpha', seq: held.seq, mode: 'live' }])
    expect(feedback(run, held.event)).toEqual({ received: 1, reactions: 1 })
    expect(view(run, postTs)).toBe('joined')
    const next = await intake(run, postTs)
    const item = run.queued('alpha').find(i => i.accepted.ts === next.ts)!
    expect(item.accepted.via).toBe('thread'); expect(item.hold).toBeUndefined()
    await drain(run, [held.event, next])
    expectHoldOutputsQuiet(run); expectLoss(run)
  })

  test.each(['after', 'before'] as const)('a hold whose root P\'s unreadable journal could not show parks when its post lands elsewhere; k8 releases it once the journal is read (read %s the post lands)', async read => {
    holdSetup(mode)
    const first = await holdStart()
    const mention = await intake(first, root, true)
    await flush(first); await first.stop()
    const io = threadFsControls(h.stateDir); io.fail('readFileSync', 'alpha')
    const run = await holdStart({ threadMemory: { fs: io.fs } })
    expect(run.threadMemory!.store('alpha')!.readable).toBe(false)
    // The first read retry falls due THREAD_MEMORY_RETRY_MIN_MS after the start's failed read.
    if (read === 'before') await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS - 1000)
    const post = await heldPost(run)
    const held = await heldReply(run, root)
    expect(run.queue.unresolvedHolds('alpha')).toMatchObject([{ seq: held.seq, on: 'post', root_unknown: true }])
    if (read === 'before') {
      // Read while the hold still waits on its post: k8 has no Memory Hold to resolve yet.
      io.heal(); await run.clock.advance(1000); await flush(run)
      expect(run.threadMemory!.store('alpha')!.readable).toBe(true)
      expect(run.queue.unresolvedHolds('alpha')).toMatchObject([{ seq: held.seq, on: 'post' }])
    }
    post.answer.settle({ kind: 'ok', result: { ts: postTs } })
    expect((await post.result).isError).toBe(false)
    await run.clock.flush()
    expect(run.postHoldEvents).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq: held.seq, outcome: 'parked', cause: 'outcomes',
      heldMs: read === 'before' ? 1000 : 0 }])
    expect(run.postHoldReleases).toEqual([])
    if (read === 'after') {
      expect(resolutions()).toEqual([{ v: 1, kind: 'parked', seq: held.seq, at: expect.any(Number) }])
      expect(run.queue.unresolvedHolds('alpha')).toMatchObject([{ seq: held.seq, on: 'memory', memoryDependent: true }])
      expect(run.heldReleases).toEqual([])
      expect(feedback(run, held.event)).toEqual({ received: 0, reactions: 0 })
      io.heal(); await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    }
    // A readable journal: the parked hold is handed to k8 at once.
    await flush(run)
    expect(resolutions()).toMatchObject([{ kind: 'parked', seq: held.seq }, { kind: 'released', seq: held.seq }])
    expect(run.heldReleases).toEqual([{ key: 'alpha', seq: held.seq, mode: 'live' }])
    expect(run.queue.unresolvedHolds('alpha')).toEqual([])
    expect(feedback(run, held.event)).toEqual({ received: 1, reactions: 1 })
    await drain(run, [mention, held.event])
    expectHoldOutputsQuiet(run)
  })

  test.each(['unanswered', 'decided with its save refused', 'saved'] as const)('a crash during a Post Hold whose post is %s: the next start releases it at most once, as recovered work, before k8\'s start resolution and compaction', async state => {
    holdSetup(mode)
    const queueIo = threadFsControls(h.stateDir)
    const first = await holdStart({ threadMemory: { queueFs: queueIo.fs } })
    const post = await heldPost(first, root)
    const held = await heldReply(first, root)
    if (state !== 'unanswered') {
      if (state !== 'saved') queueIo.fail('writeSync', 'alpha', { match: path => path === queuePath(h.stateDir) })
      post.answer.settle({ kind: 'ok', result: { ts: postTs, message: { thread_ts: root } } })
      expect((await post.result).isError).toBe(false)
      await first.clock.flush()
      expect(first.postHoldEvents).toEqual(state === 'saved'
        ? [expect.objectContaining({ kind: 'post-hold-resolved', seq: held.seq, outcome: 'released', cause: 'thread' })]
        : [{ kind: 'post-hold-save-failed', key: 'alpha', seqs: [held.seq] }])
    }
    expect(resolutions()).toEqual(state === 'saved' ? [expect.objectContaining({ kind: 'released', seq: held.seq })] : [])
    await crash(first); queueIo.heal()
    const order: string[] = [], logged = errors.length, history = pages(1, root), saving = Promise.withResolvers<void>()
    const run = await holdStart({ slack: { alpha: { repliesResponder: history.respondReplies } } }, next => {
      const memory = next.memoryHolds!, resolve = memory.resolve
      memory.resolve = (key, holdMode, compactAfter) => {
        if (key === 'alpha') order.push(`k8 ${holdMode}: ${next.queue.unresolvedHolds(key).length} unresolved, ${next.postHoldReleases.length} released`)
        return resolve(key, holdMode, compactAfter)
      }
      const compact = next.queue.compact
      next.queue.compact = (key, current) => { if (key === 'alpha') order.push('compact'); return compact(key, current) }
      // The start's saves wait until alpha's session is gone, so its release runs with alpha up and sessionless.
      const resolveHolds = next.queue.resolveHolds
      next.queue.resolveHolds = async (...args) => { await saving.promise; return resolveHolds(...args) }
    })
    // A live release would now go down the lost-message path (handleLostMessage) and schedule a restart.
    await dropPersonaSession('alpha')
    expect(run.session('alpha')).toBeUndefined()
    saving.resolve(); await flush(run)
    const recovered = state !== 'saved'
    expect(order).toEqual([`k8 recovered: 0 unresolved, ${recovered ? 1 : 0} released`, 'compact'])
    expect(run.postHoldReleases).toEqual(recovered ? [{ key: 'alpha', seq: held.seq, mode: 'recovered' }] : [])
    expect(run.postHoldEvents).toEqual(recovered ? [{ kind: 'post-hold-resolved', key: 'alpha', seq: held.seq, outcome: 'released', cause: 'restart' }] : [])
    // The second compaction rewrites the release as an ordinary accepted record.
    expect(resolutions()).toEqual([])
    const record = readQueue(h.stateDir).find(r => r.kind === 'accepted' && r.seq === held.seq)!
    expect(record).toMatchObject({ via: 'thread', released_at: expect.any(Number) }); expect(record).not.toHaveProperty('hold')
    // Recovered work: no lost-message restart though alpha had no session, and no Joins lost.
    expect(restartLines(logged)).toEqual([])
    expectLoss(run)
    // Back in session: its queued feedback once.
    run.registerSession('alpha'); await run.clock.flush()
    expect(feedback(run, held.event)).toEqual(recovered ? { received: 1, reactions: 1 } : { received: 0, reactions: 0 })
    expect(view(run, root)).toBe('joined')
    // A repeated Event adds no item, before or after delivery.
    const items = run.queued('alpha').length
    await run.deliver('alpha', held.event); await run.clock.flush()
    expect(run.queued('alpha')).toHaveLength(items)
    await drain(run, [held.event])
    expectHoldOutputsQuiet(run)
  })

  test('a start whose Thread Memory is unreadable releases a crashed Post Hold and compacts it on its own; k8 resolves the Memory Hold once the journal reads', async () => {
    holdSetup(mode)
    const first = await holdStart()
    const mention = await intake(first, root, true)
    await flush(first); await first.stop()
    const io = threadFsControls(h.stateDir); io.fail('readFileSync', 'alpha')
    const second = await holdStart({ threadMemory: { fs: io.fs } })
    await heldPost(second, otherRoot)
    const postHeld = await heldReply(second, otherRoot)
    // No post of P's covers root, so its reply waits on the unreadable journal.
    const memoryHeld = await intake(second, root)
    const memorySeq = second.queued('alpha').find(i => i.accepted.ts === memoryHeld.ts)!.accepted.seq
    expect(second.queue.unresolvedHolds('alpha').map(hold => [hold.seq, hold.on])).toEqual([[postHeld.seq, 'post'], [memorySeq, 'memory']])
    await crash(second)
    const order: string[] = []
    const run = await holdStart({ threadMemory: { fs: io.fs } }, next => {
      const memory = next.memoryHolds!, resolve = memory.resolve
      memory.resolve = async (key, holdMode, compactAfter) => {
        const answer = await resolve(key, holdMode, compactAfter)
        if (key === 'alpha') order.push(`k8 ${holdMode}: ${answer}`)
        return answer
      }
      const compact = next.queue.compact
      next.queue.compact = (key, current) => { if (key === 'alpha') order.push('compact'); return compact(key, current) }
    })
    await flush(run)
    expect(run.threadMemory!.store('alpha')!.readable).toBe(false)
    // k8 can't judge yet, so the start's release is compacted on its own: released form, Memory Hold kept.
    expect(order).toEqual(['k8 recovered: unknown', 'compact'])
    expect(run.postHoldReleases).toEqual([{ key: 'alpha', seq: postHeld.seq, mode: 'recovered' }])
    expect(resolutions()).toEqual([])
    const accepted = readQueue(h.stateDir).filter(r => r.kind === 'accepted' && !('compact' in r) && (r.seq === postHeld.seq || r.seq === memorySeq))
    expect(accepted).toMatchObject([{ seq: postHeld.seq, via: 'thread', released_at: expect.any(Number) }, { seq: memorySeq, hold: { on: 'memory' } }])
    expect(accepted[0]).not.toHaveProperty('hold')
    expect(run.heldReleases).toEqual([])
    io.heal(); await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS); await flush(run)
    // The read lets k8 judge its start request: released as recovered work, then compacted again.
    expect(run.heldReleases).toEqual([{ key: 'alpha', seq: memorySeq, mode: 'recovered' }])
    expect(order.filter(step => step === 'compact')).toHaveLength(2)
    expect(resolutions()).toEqual([])
    expect(feedback(run, postHeld.event)).toEqual({ received: 1, reactions: 1 })
    await drain(run, [mention, postHeld.event, memoryHeld])
    expectHoldOutputsQuiet(run); expectLoss(run)
  })

  test.each(['a DM', 'a reply Thread Memory cannot judge yet'] as const)('a queue journal unreadable at start: %s that first loads it releases its crashed Post Hold as recovered work, and P\'s FIFO moves', async loading => {
    holdSetup(mode)
    const first = await holdStart()
    const mention = await intake(first, THREAD_ROOTS.third, true)
    await heldPost(first, root)
    const held = await heldReply(first, root)
    await flush(first); await crash(first)
    const queueIo = threadFsControls(h.stateDir), memoryIo = threadFsControls(h.stateDir)
    queueIo.fail('readFileSync', 'alpha', { match: path => path === queuePath(h.stateDir) })
    if (loading !== 'a DM') memoryIo.fail('readFileSync', 'alpha')
    let compactions = 0
    const run = await holdStart({ threadMemory: { queueFs: queueIo.fs, fs: memoryIo.fs },
      slack: { alpha: { repliesResponder: pages(1, root).respondReplies } } }, next => {
      const compact = next.queue.compact
      next.queue.compact = (key, current) => { if (key === 'alpha') compactions++; return compact(key, current) }
    })
    await flush(run)
    // Start couldn't read the journal, so it couldn't release the hold in it.
    expect(run.queue.unresolvedHolds('alpha')).toEqual([])
    expect(run.postHoldReleases).toEqual([])
    queueIo.heal()
    const compacted = compactions
    const loader = loading === 'a DM' ? await dm(run) : await intake(run, THREAD_ROOTS.third)
    await flush(run)
    expect(run.postHoldReleases).toEqual([{ key: 'alpha', seq: held.seq, mode: 'recovered' }])
    expect(run.postHoldEvents).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq: held.seq, outcome: 'released', cause: 'restart' }])
    expect(feedback(run, held.event)).toEqual({ received: 1, reactions: 1 })
    const loaderSeq = run.queued('alpha').find(i => i.accepted.ts === loader.ts)!.accepted.seq
    if (loading !== 'a DM') {
      expect(run.queue.unresolvedHolds('alpha')).toMatchObject([{ seq: loaderSeq, on: 'memory' }])
      memoryIo.heal(); await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS); await flush(run)
      // k8 took the loaded journal's holds before this turn stored its own, so that one stays live work.
      expect(run.heldReleases).toEqual([{ key: 'alpha', seq: loaderSeq, mode: 'live' }])
    }
    // The loaded journal's start resolution compacts once, after the release's save; a live
    // release of the loading turn's own hold is left to the hourly compaction.
    expect(compactions - compacted).toBe(1)
    expect(resolutions()).toEqual(loading === 'a DM' ? [] : [{ v: 1, kind: 'released', seq: loaderSeq, at: expect.any(Number) }])
    expect(readQueue(h.stateDir).find(r => r.kind === 'accepted' && r.seq === held.seq)).toMatchObject({ via: 'thread', released_at: expect.any(Number) })
    await drain(run, [mention, held.event, loader])
    expectHoldOutputsQuiet(run); expectLoss(run)
  })

  test('a queue journal unreadable at start: in its loading turn k8 takes its crashed Memory Hold as recovered work, and the loading reply\'s own Memory Hold stays live', async () => {
    holdSetup(mode)
    const first = await holdStart()
    const mention = await intake(first, root, true)
    await flush(first); await first.stop()
    const memoryIo = threadFsControls(h.stateDir); memoryIo.fail('readFileSync', 'alpha')
    const second = await holdStart({ threadMemory: { fs: memoryIo.fs } })
    const old = await intake(second, root)
    const oldSeq = second.queued('alpha').find(i => i.accepted.ts === old.ts)!.accepted.seq
    expect(second.queue.unresolvedHolds('alpha')).toMatchObject([{ seq: oldSeq, on: 'memory' }])
    await crash(second)
    const queueIo = threadFsControls(h.stateDir)
    queueIo.fail('readFileSync', 'alpha', { match: path => path === queuePath(h.stateDir) })
    const run = await holdStart({ threadMemory: { fs: memoryIo.fs, queueFs: queueIo.fs } })
    queueIo.heal()
    const loader = await intake(run, root)
    const loaderSeq = run.queued('alpha').find(i => i.accepted.ts === loader.ts)!.accepted.seq
    expect(run.queue.unresolvedHolds('alpha').map(hold => [hold.seq, hold.on])).toEqual([[oldSeq, 'memory'], [loaderSeq, 'memory']])
    memoryIo.heal(); await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS); await flush(run)
    // Recovered work for the hold the journal held, live work (with its post-ack path) for the new one.
    expect(run.heldReleases).toEqual([{ key: 'alpha', seq: oldSeq, mode: 'recovered' }, { key: 'alpha', seq: loaderSeq, mode: 'live' }])
    expect([feedback(run, old), feedback(run, loader)]).toEqual([{ received: 1, reactions: 1 }, { received: 1, reactions: 1 }])
    await drain(run, [mention, old, loader])
    expectLoss(run)
  })

  test('a same-run bring-up releases an unresolved Post Hold as recovered work after its recovery; the old post\'s late answer does nothing', async () => {
    holdSetup(mode)
    const run = await holdStart()
    withPages(run, pages(1, root))
    const post = await heldPost(run, root)
    const held = await heldReply(run, root)
    const persona = run.serverConfig()!.personas.find(p => p.key === 'alpha')!
    await run.composition!.lifecycle.teardown(persona)
    await run.clock.advance(THREAD_REPLY_HOLD_MS)
    expect(run.postHoldEvents).toEqual([]); expect(run.queue.item('alpha', held.seq)!.hold!.state).toBe('unresolved')
    run.stub('alpha').script.inventory.push(membershipPage([channel, neighbor]))
    await run.composition!.lifecycle.bringUp(persona, run.serverConfig()!)
    await run.membershipClock.runNext(); await flush(run)
    expect(run.postHoldReleases).toEqual([{ key: 'alpha', seq: held.seq, mode: 'recovered' }])
    expect(run.postHoldEvents).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq: held.seq, outcome: 'released', cause: 'restart' }])
    expect(resolutions()).toEqual([{ v: 1, kind: 'released', seq: held.seq, at: expect.any(Number) }])
    run.registerSession('alpha'); await run.clock.flush()
    expect(feedback(run, held.event)).toEqual({ received: 1, reactions: 1 })
    post.answer.settle({ kind: 'ok', result: { ts: postTs, message: { thread_ts: root } } })
    await flush(run)
    expect(run.postHoldEvents).toHaveLength(1); expect(run.postHoldReleases).toHaveLength(1)
    await drain(run, [held.event])
    expectHoldOutputsQuiet(run); expectLoss(run)
  })

  test.each(['teardown', 'removal', 'shutdown'] as const)('%s cancels P\'s pending hold timer and drops its post\'s answer; another persona\'s hold still resolves', async how => {
    holdSetup(mode)
    const run = await holdStart()
    const mine = await heldPost(run, root)
    await heldPost(run, otherRoot, 'bravo')
    const held = await heldReply(run, root)
    await run.clock.advance(7)
    const theirs = await heldReply(run, otherRoot, 'bravo')
    const deadline = held.receivedAt + THREAD_REPLY_HOLD_MS
    expect(run.clock.pending().filter(t => t.dueAt === deadline)).toHaveLength(1)
    const persona = run.serverConfig()!.personas.find(p => p.key === 'alpha')!
    if (how === 'teardown') await run.composition!.lifecycle.teardown(persona)
    else if (how === 'removal') {
      h.writeConfig({ channel_mode: mode, personas: [personas[1]!], queued_ack_reaction: 'hourglass' })
      await run.ticks.tick(); h.confirm(); await run.ticks.tick(); await run.clock.flush()
      expect(run.appliedKeys()).toEqual(['bravo'])
    } else await run.stop()
    expect(run.clock.pending().filter(t => t.dueAt === deadline)).toEqual([])
    if (how === 'shutdown') expect(run.clock.pendingCount()).toBe(0)
    const queued = readQueue(h.stateDir), posts = run.stub('alpha').calls.postMessage.length
    mine.answer.settle({ kind: 'ok', result: { ts: postTs, message: { thread_ts: root } } })
    await run.clock.advance(THREAD_REPLY_HOLD_MS); await run.clock.flush()
    expect(readQueue(h.stateDir)).toEqual(queued)
    expect(run.postHoldEvents.filter(e => e.key === 'alpha')).toEqual([])
    expect(run.postHoldReleases.filter(r => r.key === 'alpha')).toEqual([])
    expect(run.stub('alpha').calls.postMessage).toHaveLength(posts)
    expect(feedback(run, held.event)).toEqual({ received: 0, reactions: 0 })
    expect(run.postHoldReleases.filter(r => r.key === 'bravo')).toEqual(how === 'shutdown' ? [] : [{ key: 'bravo', seq: theirs.seq, mode: 'live' }])
    expectHoldOutputsQuiet(run)
  })

  test.each(['confirmed in the reply\'s thread', 'unanswered'] as const)('after a routed leave of P\'s channel during a hold (t1.tad.5i AC-C08), its post %s resolves it within THREAD_REPLY_HOLD_MS of receipt, joining nothing', async answer => {
    holdSetup(mode)
    const run = await holdStart()
    const post = await heldPost(run, root)
    const held = await heldReply(run, root)
    const authority = run.controller.sharedChannels()!, arrival = authority.channelStamp('alpha', channel)
    const [leave, envelope] = makeMembershipEvent(run.stub('alpha').identity, 'leave', channel, run.membershipClock.now() + 1)
    await run.deliver('alpha', leave, envelope); await run.clock.flush()
    expect(authority.channelStamp('alpha', channel)).not.toEqual(arrival)
    await run.clock.advance(500)
    if (answer !== 'unanswered') {
      post.answer.settle({ kind: 'ok', result: { ts: postTs, message: { thread_ts: root } } })
      await post.result
    }
    await run.clock.advanceTo(held.receivedAt + THREAD_REPLY_HOLD_MS); await flush(run)
    expect(run.postHoldEvents).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq: held.seq, outcome: 'released',
      cause: answer === 'unanswered' ? 'timer' : 'thread', heldMs: answer === 'unanswered' ? THREAD_REPLY_HOLD_MS : 500 }])
    expect(view(run, root)).toBe('not-joined')
    expect(joins().filter(j => j.root === root)).toEqual([])
    expectHoldOutputsQuiet(run)
  })
})
