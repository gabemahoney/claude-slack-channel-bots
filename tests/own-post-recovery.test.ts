import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelMode, DeliveryMode, PersonaInput } from '../src/config.ts'
import { OWN_ROOT_CLOCK_SKEW_MS, THREAD_MEMORY_LOOKUP_DEADLINE_MS, THREAD_MEMORY_RETRY_MAX_MS, THREAD_MEMORY_RETRY_MIN_MS } from '../src/delivery-constants.ts'
import { THREAD_MEMORY_JOINS_LOST } from '../src/persona-diagnostics.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { OWN_POST_UPLOAD_FILENAME } from '../src/registry.ts'
import { buildThreadMemoryJoinsLostLine, buildThreadMemoryJoinsLostNotice } from '../src/thread-memory-reports.ts'
import { assertNoLeak, LEAK_SENTINEL, writtenFile } from './test-helpers/credentials.ts'
import { queuePath } from './test-helpers/delivery-queue.ts'
import { holdOwnPostReady } from './test-helpers/own-post.ts'
import { makeReloadHarness, TEMPLATE_REFRESH_KEY, type ReloadHarness, type ReloadRun, type ReloadRunOptions } from './test-helpers/reload-harness.ts'
import { membershipPage, SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { makeChannelMessage, makeDeferredWebApiCall, makeOwnFileShare, makePagedThread, mentionText, slackFileId, stubOpenedDmId, type PagedMessageSpec, type WebApiOutcome } from './test-helpers/slack-stub.ts'
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
async function start(extra: ReloadRunOptions = {}, offset = 0) {
  const run = h.build({ ...extra, threadMemory: extra.threadMemory ?? {},
    slack: Object.fromEntries(personas.map(p => [p.name, {
      ...(p.name === 'alpha' ? identity : siblingIdentity), inventory: [membershipPage([channel])], ...extra.slack?.[p.name],
    }])),
  }); runs.push(run)
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
async function intake(run: ReloadRun, thread: string, mention = false, key = 'alpha') {
  const event = makeChannelMessage({ channel, thread_ts: thread, ts: `1700000100.${String(++sequence).padStart(6, '0')}`,
    text: mention ? `${mentionText(run.stub(key).identity.botUserId)} incoming ${sequence}` : `incoming ${sequence}` })
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
    .toEqual([{ channel: stubOpenedDmId('U0OPERATOR'), text: formatPersonaNotice(persona, notice.text, notice.options) }])
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

  test.each(['recovered', 'live'] as const)('unreadable journal: %s intent waits; read-time end precedes delayed release', async origin => {
    setup(mode)
    const first = await start()
    // A persisted joined thread supplies a releasable Memory Hold after read.
    const mention = await intake(first, THREAD_ROOTS.third, true)
    expectDeliveries(first, [[mention, 'mention']])
    if (origin === 'recovered') await hungPost(first)
    await crash(first)
    const io = threadFsControls(h.stateDir), release = holdOwnPostReady()
    releases.push(release.resolve)
    io.fail('readFileSync', 'alpha')
    let releaseEntered = false
    const history = pages()
    const run = await start({
      threadMemory: { fs: io.fs, beforeRelease: async key => {
        if (key === 'alpha') { releaseEntered = true; await release.ready }
      } },
      slack: { alpha: { historyResponder: history.respondHistory } },
    })
    expect(run.threadMemory!.store('alpha')!.readable).toBe(false)
    if (origin === 'live') await unknown(run)
    const held = await intake(run, THREAD_ROOTS.third)
    expect(run.queue.unresolvedHolds('alpha')).toHaveLength(1)
    expect(lookups(run)).toHaveLength(0)
    // Let unreadable retries run well past the skew; none can call Slack.
    await run.clock.advance(OWN_ROOT_CLOCK_SKEW_MS + THREAD_MEMORY_RETRY_MIN_MS)
    expect(lookups(run)).toHaveLength(0)
    io.heal()
    // Read retry is the next memory retry, potentially after its backoff grew.
    for (let i = 0; i < 8 && !releaseEntered; i++) await run.clock.runNext()
    expect(releaseEntered).toBe(true)
    expect(run.threadMemory!.store('alpha')!.readable).toBe(true)
    const readTime = run.clock.now()
    expect(lookups(run)).toHaveLength(0)
    await run.clock.advance(OWN_ROOT_CLOCK_SKEW_MS + THREAD_MEMORY_RETRY_MIN_MS)
    expect(lookups(run)).toHaveLength(0)
    release.resolve(); await flush(run)
    expect(lookups(run)).toHaveLength(1)
    // The persona clock can be 1 ms ahead of wall time. Both bounds are still
    // at the read event, far before the asynchronous recovery released above.
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
// The caller's file sits under the harness root the leak check scans, so only the reply text carries the sentinel.
const uploadBody = 'upload body'
function uploadFile() {
  const dir = join(h.root, 'inbox')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'upload.txt')
  writeFileSync(path, uploadBody)
  return path
}
/** A reply with one file; Slack's completion names `fileId`, or `completion` answers instead. */
function upload(run: ReloadRun, completion?: WebApiOutcome, key = 'alpha') {
  run.stub(key).script.completeUpload.push(completion ?? { kind: 'ok', result: { files: [{ id: fileId }] } })
  return run.callTool(key, 'reply', { chat_id: channel, text: body, files: [uploadFile()] })
}
function uploads(run: ReloadRun, key = 'alpha') { return run.stub(key).calls.filesUploadV2 }
function histories(run: ReloadRun, key = 'alpha') { return run.stub(key).calls.conversationsHistory }
/** P's share in the history, or only another user's message when `found` is false. */
function sharePages(found: boolean, extra: { outcomes?: Record<number, WebApiOutcome[]>; key?: string } = {}) {
  return makePagedThread(1, { channel, identity: extra.key === 'bravo' ? siblingIdentity : identity, pageOutcomes: extra.outcomes,
    message: (): PagedMessageSpec => found
      ? { author: 'own-user', placement: 'channel', ts: share, text: '', file: { name: OWN_POST_UPLOAD_FILENAME, size: Buffer.byteLength(uploadBody) }, fileIds: [fileId] }
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
/** The upload's outcomes: its intent follows the reply text's, which a restart may compact away. */
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
    expect(uploads(run)).toHaveLength(1); expect(posted(run)).toHaveLength(1)
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
    expect(posted(first)).toHaveLength(1); expect(posted(recovered)).toHaveLength(0)
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
