/**
 * Own-post observer, per-call intents and joins through the real shared authority,
 * Thread Memory, delivery queue and membership readers.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHANNEL_ID_RE, DELIVERY_MODES, channelModeOf, type ChannelMode } from '../src/config.ts'
import { OWN_ROOT_CLOCK_SKEW_MS } from '../src/delivery-constants.ts'
import { decideDelivery, type DeliveryDecision } from '../src/delivery-decision.ts'
import { completionFiles, createOwnPostObserver,
  ownPostAnswerOfError, ownPostAnswerOfPost, ownPostEligibility, pendingOwnPostViews,
  type OwnPostAnswer, type OwnPostContent, type OwnPostEvent, type OwnPostOperation, type OwnPostOperationView,
  type OwnPostOutcome, type OwnPostOwner,
} from '../src/own-post.ts'
import { OWN_POST_UPLOAD_REFUSED } from '../src/registry.ts'
import { SHARED_CHANNEL_IDS, membershipPage } from './test-helpers/shared-channels.ts'
import { slackTsOfMs, threadFsControls, threadPath, type ThreadHarnessOptions } from './test-helpers/thread-memory.ts'
import { slackInput } from './test-helpers/delivery-queue.ts'
import { makeOwnPostHarness } from './test-helpers/own-post.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeChannelMessage, makeStubSlack, slackPlatformError, slackRateLimited, slackHttpError, slackRequestError, slackAbortError } from './test-helpers/slack-stub.ts'
import { assertNoLeak, LEAK_SENTINEL, sentinelInMessage, writtenFile } from './test-helpers/credentials.ts'

const C = SHARED_CHANNEL_IDS.primary, C2 = SHARED_CHANNEL_IDS.secondary
const ROOT = '1700000000.000100', ROOT2 = '1700000000.000200', REPLY = '1700000000.000300'
const CONTENT = { kind: 'text', text: LEAK_SENTINEL } satisfies OwnPostContent
const NO_ANSWER: OwnPostAnswer = { kind: 'no-answer' }
const TARGET = { channel: C }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'own-post fixture cleanup failed')
})

/** Slack responses are built by the shared stub; result only overrides the tested fields. */
async function postAnswer(result: Record<string, unknown> = { ts: ROOT }, channel: string = C): Promise<OwnPostAnswer> {
  const slack = makeStubSlack({ post: [{ kind: 'ok', result }] })
  return ownPostAnswerOfPost(channel, await slack.web.chat.postMessage({ channel, text: CONTENT.text }))
}

describe('the own-post observer', () => {
  const operation = () => ({} as OwnPostOperation)
  const failures = [
    ['a synchronous throw', (error: Error) => () => { throw error }],
    ['an async rejection', (error: Error) => () => Promise.reject(error)],
  ] as const

  test('start passes exact arguments and ready; end stays with the issuing owner, runs once and never awaits it', async () => {
    const clock = createFakeClock(), calls: unknown[][] = [], handle = operation()
    let append!: () => void, ended!: () => void, endSettled = false
    const ready = new Promise<void>(resolve => { append = resolve })
    const pendingEnd = new Promise<void>(resolve => { ended = resolve }).then(() => { endSettled = true })
    const first: OwnPostOwner = {
      startOperation(...args) { calls.push(args); return { operation: handle, ready } },
      endOperation(...args) { calls.push(args); return pendingEnd },
    }
    let owner: OwnPostOwner | undefined = first
    const observer = createOwnPostObserver(() => owner)
    const started = observer.start('alpha', 'text', TARGET, CONTENT)!
    expect(started.operation).toBe(handle)
    expect(calls).toEqual([['alpha', 'text', TARGET, CONTENT]])
    let readySettled = false
    void started.ready!.then(() => { readySettled = true })
    await clock.flush(); expect(readySettled).toBe(false)
    append(); await started.ready; expect(readySettled).toBe(true)
    owner = { startOperation: () => undefined, endOperation() { throw new Error('wrong owner') } }
    expect(observer.end(handle, NO_ANSWER)).toBeUndefined()
    expect(calls).toEqual([['alpha', 'text', TARGET, CONTENT], [handle, NO_ANSWER]])
    expect(endSettled).toBe(false)
    observer.end(handle, NO_ANSWER); expect(calls).toHaveLength(2)
    ended(); await clock.flush(); expect(endSettled).toBe(true)
  })

  test('absent or throwing start returns undefined; undefined end never reads the owner', () => {
    const faults: unknown[] = [], error = new Error('injected start fault')
    expect(createOwnPostObserver(() => undefined).start('alpha', 'text', TARGET, CONTENT)).toBeUndefined()
    for (const owner of [
      () => { throw error },
      () => ({ startOperation() { throw error }, endOperation() {} }),
    ]) {
      expect(createOwnPostObserver(owner, e => { faults.push(e) }).start('alpha', 'text', TARGET, CONTENT)).toBeUndefined()
    }
    expect(faults).toEqual([error, error])
    let reads = 0
    const observer = createOwnPostObserver(() => { reads++; throw error })
    expect(observer.end(undefined, NO_ANSWER)).toBeUndefined()
    expect(reads).toBe(0)
  })

  test.each([false, true])('a rejected ready resolves and reports once even when onFault throws=%s', async throws => {
    const error = new Error('injected append fault'), faults: unknown[] = []
    const observer = createOwnPostObserver(() => ({ startOperation: () => ({ operation: operation(), ready: Promise.reject(error) }), endOperation() {} }),
      e => { faults.push(e); if (throws) throw new Error('injected reporting fault') })
    await expect(observer.start('alpha', 'text', TARGET, CONTENT)!.ready!).resolves.toBeUndefined()
    expect(faults).toEqual([error])
  })

  test.each(failures)('%s in end reports once, including when onFault throws', async (_name, fails) => {
    for (const throwingReporter of [false, true]) {
      const error = new Error('injected end fault'), faults: unknown[] = []
      const observer = createOwnPostObserver(() => ({ startOperation: () => ({ operation: operation() }), endOperation: fails(error) }),
        e => { faults.push(e); if (throwingReporter) throw new Error('injected reporting fault') })
      const start = observer.start('alpha', 'text', TARGET, CONTENT)!
      expect(start.ready).toBeUndefined()
      expect(observer.end(start.operation, NO_ANSWER)).toBeUndefined()
      await createFakeClock().flush()
      expect(faults).toEqual([error])
    }
  })
})

describe('Slack answer classifiers', () => {
  test.each([
    ['platform', (): unknown => slackPlatformError('channel_not_found', undefined, LEAK_SENTINEL), { kind: 'failed', code: 'channel_not_found' }],
    ['unsafe platform code', () => slackPlatformError(sentinelInMessage('code')), { kind: 'failed', code: 'slack_error' }],
    ['rate limited', () => slackRateLimited(2, LEAK_SENTINEL), { kind: 'failed', code: 'ratelimited' }],
    ['request', () => slackRequestError('network'), NO_ANSWER],
    ['deadline', () => slackRequestError('timeout'), NO_ANSWER],
    ['HTTP', () => slackHttpError(503), NO_ANSWER],
    ['abort', () => slackAbortError(), NO_ANSWER],
    ['unknown', () => sentinelInMessage('unknown'), NO_ANSWER],
    ['undefined', (): unknown => undefined, NO_ANSWER],
  ] as const)('%s has a safe classification', (_label, error, expected) => {
    const answer = ownPostAnswerOfError(error())
    expect(answer).toEqual(expected); assertNoLeak(answer)
  })

  test.each([
    ['root', { ts: ROOT }, { kind: 'confirmed', channel: C, ts: ROOT }],
    ['reply', { ts: REPLY, message: { thread_ts: ROOT, text: LEAK_SENTINEL } }, { kind: 'confirmed', channel: C, ts: REPLY, threadTs: ROOT }],
    ['missing timestamp', { ts: undefined }, NO_ANSWER],
    ['malformed timestamp', { ts: LEAK_SENTINEL }, NO_ANSWER],
    ['negative answer', { ok: false, error: 'not_in_channel' }, { kind: 'failed', code: 'not_in_channel' }],
  ] as const)('%s reads only confirmed timestamps and safe failure codes', async (_label, response, expected) => {
    const answer = await postAnswer({ ...response, warning: LEAK_SENTINEL })
    expect(answer).toEqual(expected); assertNoLeak(answer)
  })
})

/** Same readers as server.ts; Slack and filesystem faults are the external seams. */
async function fixture(options: { mode?: ChannelMode; names?: string[]; sharedIdentity?: boolean; reopen?: string; memory?: ThreadHarnessOptions; start?: boolean
  operationId?: () => string } = {}) {
  const dir = options.reopen ?? mkdtempSync(join(tmpdir(), 'own-post-'))
  if (!options.reopen) cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let serial = 0
  const h = await makeOwnPostHarness(dir, {
    membership: { mode: options.mode ?? 'strict', names: options.names,
      channels: [{ id: C, delivery: 'thread_hybrid' }, { id: C2, delivery: 'thread_hybrid' }], reopen: !!options.reopen },
    prepareMembership(members) {
      if (!options.sharedIdentity) return
      const alpha = members.h.stub(members.h.p('alpha')), beta = members.h.stub(members.h.p('beta'))
      Object.assign(beta.identity, alpha.identity)
      beta.script.botsInfo.push({ kind: 'ok', result: { bot: {
        id: alpha.identity.botId, user_id: alpha.identity.botUserId, app_id: alpha.identity.appId, deleted: false,
      } } })
    },
    memory: options.memory, start: options.start,
    operationId: options.operationId ?? (() => 'post-' + ++serial),
    // These cases explicitly drive publication/settlement; no subscription may pre-settle them.
    publishSharedState: false,
  })
  cleanups.push(h.close)
  const { members, owner, observer, events } = h
  const begin = (parent?: string, key = 'alpha', surface: 'text' | 'file' = 'text', channel: string = C) => {
    const started = observer.start(key, surface, { channel, ...(parent ? { parent } : {}) },
      surface === 'file' ? { kind: 'file', name: LEAK_SENTINEL, size: 12 } : CONTENT)
    expect(started).toBeDefined()
    const id = events.at(-1)!.operationId
    return { ...started!, id }
  }
  async function scan(kind: 'eligible' | 'ineligible' | 'unresolved', key = 'alpha') {
    if (kind === 'unresolved') { members.membership.invalidate(key); return }
    members.h.stub(members.h.p(key)).script.inventory.push(membershipPage(kind === 'eligible' ? [C, C2] : [C2]))
    members.scanner.connectionChanged(key)
    await h.clock.flush(); await members.scan()
    expect(members.membership.read(key, C, h.authority.config().channel_mode).kind).toBe(kind)
  }
  const pending = (key = 'alpha') => owner.pendingOwnPosts(key, C)
  const view = (root = ROOT, key = 'alpha') => h.view(key, C, root)
  return { ...h.threads, ...h, dir, begin, scan, pending, view,
    stale() { expect(h.threads.choose('off').kind).toBe('applied'); expect(h.threads.choose('thread_hybrid').kind).toBe('applied') },
    undecided() { members.unsyncWrites(() => true); expect(h.threads.mode(h.authority.config().channel_mode === 'strict' ? 'open' : 'strict').kind).toBe('unresolved') },
    decideStamp() { members.unsyncWrites(() => false); expect(h.authority.recoverDurability().kind).toBe('applied') },
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function savedOutcome(h: Fixture, id: string, expected: 'joined' | 'none', key = 'alpha') {
  await h.flush()
  expect(h.records(key).filter(r => r.kind === 'post-outcome' && r.operationId === id)).toMatchObject([{ outcome: expected }])
  expect(h.memory.unresolvedIntents(key).some(r => r.operationId === id)).toBe(false)
}

/** P's decision on a person's unmentioned reply under `root`, with every input
 * read as src/server.ts and routing supply them: the view adapter settles
 * deferred joins first, and Pending Own Posts go through `pendingOwnPostViews`.
 * It mirrors src/persona-routing.ts's `fungibleInputs` by hand, so it checks the
 * owner's listing, not routing's composition. The routing cases in
 * tests/persona-routing.test.ts "Post Hold routing through real own posts"
 * guard the real composition, and server-startup-wiring's harness mirror pins
 * the harness's binding to src/server.ts's. */
function decideReply(h: Fixture, root: string, key = 'alpha'): DeliveryDecision {
  const config = h.authority.config(), mode = channelModeOf(config), persona = config.personas.find(p => p.key === key)!
  const identity = h.members.h.stub(h.members.h.p(key)).identity
  const event = makeChannelMessage({ channel: C, ts: '1700000000.000900', thread_ts: root, text: 'an unmentioned reply' })
  return decideDelivery(event, { key, botUserId: identity.botUserId, botId: identity.botId, channels: persona.channels, dmEnabled: persona.dm.enabled },
    config.personas, {
      mode, isExtSharedChannel: false, channelIdPattern: CHANNEL_ID_RE, storedChoices: h.choices,
      memberships: new Map(config.personas.map(p => [p.key, h.members.membership.read(p.key, C, mode)])),
      threadMemory: (k, channel, thread) => { h.owner.settleDeferred(k, channel); return h.memory.view(k, channel, thread) },
      ownPosts: { pending: (k, channel) => pendingOwnPostViews(h.owner.pendingOwnPosts(k, channel)), clockSkewMs: OWN_ROOT_CLOCK_SKEW_MS },
      threadStampUndecided: (k, channel) => h.authority.channelStamp(k, channel)?.kind === 'undecided',
    })
}
/** The Post Hold outcome for a reply under `root` covered by `operations`. */
const heldFor = (root: string, operations: string[], rootUnknown = false): DeliveryDecision =>
  ({ action: 'hold', hold: 'post', via: 'thread', threadRoot: root, operations, rootUnknown })

const UPLOAD = 'F0UPLOAD1'
/** A parentless upload confirmed by file ID alone: it awaits its own share's thread. */
async function awaiting(h: Fixture, key = 'alpha', channel: string = C, file = UPLOAD) {
  const post = h.begin(undefined, key, 'file', channel)
  await post.ready
  expect(h.observer.end(post.operation, { kind: 'confirmed', channel, file })).toBeUndefined()
  return post
}

describe('own-post registration and outcomes', () => {
  test('three starts capture their clock and stamp before appending, and ready settles in start order', async () => {
    const h = await fixture(), at = h.clock.now(), stamp = h.fact().stamp, settled: string[] = []
    const started = [h.begin(), h.begin(ROOT), h.begin(ROOT2)]
    for (const post of started) {
      expect(post.ready).toBeDefined()
      void post.ready!.then(() => {
        expect(h.records().some(r => r.kind === 'post-intent' && r.operationId === post.id)).toBe(true)
        settled.push(post.id)
      })
    }
    expect(settled).toEqual([])
    expect(h.pending().map(p => [p.operationId, p.issuedAt, p.stamp])).toEqual(started.map(p => [p.id, at, stamp]))
    await h.clock.advance(100)
    await Promise.all(started.map(p => p.ready))
    expect(settled).toEqual(started.map(p => p.id))
    expect(h.records().filter(r => r.kind === 'post-intent').map(r => [r.operationId, r.at, r.stamp])).toEqual(started.map(p => [p.id, at, stamp]))
    assertNoLeak({ events: h.events, journal: writtenFile(threadPath(h.dir)) })
  })

  test.each([
    ['top-level', undefined, undefined, 'text', ROOT],
    ['mapped reply', REPLY, undefined, 'text', ROOT],
    ['unknown parent', ROOT2, undefined, 'text', ROOT2],
    ['Slack thread takes precedence', REPLY, ROOT2, 'text', ROOT2],
    ['mapped upload', REPLY, undefined, 'file', ROOT],
  ] as const)('%s joins its correct thread in memory and after reopening', async (_name, parent, thread, surface, expected) => {
    const h = await fixture()
    await h.queue.accept('alpha', slackInput({ channel: C, ts: REPLY, key: { chat_id: C, ts: REPLY }, thread_ts: ROOT }))
    const post = h.begin(parent, 'alpha', surface)
    expect(h.pending()[0]?.root).toBe(parent === REPLY ? ROOT : parent)
    await post.ready
    const answer = surface === 'file' ? { kind: 'confirmed' as const, channel: C, file: 'F0UPLOAD1' }
      : await postAnswer({ ts: ROOT, ...(thread ? { message: { thread_ts: thread } } : {}) })
    expect(h.observer.end(post.operation, answer)).toBeUndefined()
    expect(h.view(expected)).toBe('joined'); expect(h.pending()).toHaveLength(0)
    expect(h.owner.operation('alpha', post.id)).toBeUndefined()
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set([expected]))
    expect(h.events.at(-1)).not.toHaveProperty('lookup')
    await savedOutcome(h, post.id, 'joined')
    await h.close()
    const reopened = await fixture({ reopen: h.dir })
    expect(reopened.view(expected)).toBe('joined')
    expect(reopened.owner.unknownOwnPosts('alpha')).toHaveLength(0)
    expect(reopened.owner.resolvedThreads('alpha', C)).toEqual(new Set())
  })

  test('a joined root registers and writes nothing, even through a stored reply mapping', async () => {
    const h = await fixture(), first = h.begin()
    await first.ready; h.observer.end(first.operation, await postAnswer()); await h.flush()
    await h.queue.accept('alpha', slackInput({ channel: C, ts: REPLY, key: { chat_id: C, ts: REPLY }, thread_ts: ROOT }))
    const before = readFileSync(threadPath(h.dir)), registrations = h.events.length
    for (const parent of [ROOT, REPLY]) expect(h.observer.start('alpha', 'text', { channel: C, parent }, CONTENT)).toBeUndefined()
    await h.flush()
    expect(readFileSync(threadPath(h.dir))).toEqual(before); expect(h.events).toHaveLength(registrations)
  })

  test.each(['failed', 'no-answer', 'stale'] as const)('%s never joins; only an unknown answer remains unresolved', async kind => {
    const h = await fixture(), post = h.begin()
    await post.ready
    if (kind === 'stale') { h.stale(); expect(h.pending()).toHaveLength(0) }
    const answer = kind === 'failed' ? ownPostAnswerOfError(slackPlatformError('not_in_channel'))
      : kind === 'no-answer' ? ownPostAnswerOfError(slackRequestError()) : await postAnswer()
    h.observer.end(post.operation, answer)
    expect(h.view()).toBe('not-joined')
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set(kind === 'stale' ? [ROOT] : []))
    if (kind === 'no-answer') {
      expect(h.pending()).toMatchObject([{ operationId: post.id, state: 'unknown' }])
      expect(h.memory.unresolvedIntents('alpha')).toHaveLength(1)
      expect(h.records().filter(r => r.kind === 'post-outcome')).toHaveLength(0)
    } else await savedOutcome(h, post.id, 'none')
  })

  test.each(['intent', 'outcome', 'both'] as const)('failed %s append still decides and selects without starting another operation', async failure => {
    const h = await fixture()
    if (failure !== 'outcome') h.io.fail('writeSync')
    const post = h.begin()
    await expect(post.ready!).resolves.toBeUndefined()
    if (failure === 'intent') h.io.heal()
    if (failure === 'outcome') h.io.fail('writeSync')
    const release = h.owner.retainOutcomes('alpha', [post.id])
    h.observer.end(post.operation, await postAnswer()); await h.flush()
    expect(h.view()).toBe('joined')
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', outcome: { joined: true } })
    expect(h.events.filter(e => e.type === 'registered')).toHaveLength(1)
    expect(h.pending()).toHaveLength(0)
    expect(h.owner.memoryOnlyJoins('alpha')).toEqual(failure === 'outcome' ? [] : [{ channel: C, root: ROOT }])
    release()
  })

  test('an outstanding failed save gives later starts no ready', async () => {
    const h = await fixture(); h.io.fail('writeSync')
    const first = h.begin(); await first.ready
    const next = h.begin(ROOT2)
    expect(next.ready).toBeUndefined()
    expect(h.pending()).toHaveLength(2)
    h.observer.end(next.operation, await postAnswer({ ts: REPLY }))
    expect(h.view(ROOT2)).toBe('joined')
    expect(h.events.filter(e => e.type === 'registered')).toHaveLength(2)
  })

  test('an unreadable journal registers without ready and keeps confirmation for selection', async () => {
    const h = await fixture(); await h.close()
    const io = threadFsControls(h.dir); io.fail('readFileSync')
    const reopened = await fixture({ reopen: h.dir, memory: { fs: io } })
    expect(reopened.memory.store('alpha')?.readable).toBe(false)
    const post = reopened.begin(); expect(post.ready).toBeUndefined()
    reopened.observer.end(post.operation, await postAnswer())
    expect(reopened.memory.hasKeptJoin('alpha', C, ROOT)).toBe(true)
    expect(reopened.owner.memoryOnlyJoins('alpha')).toEqual([{ channel: C, root: ROOT }])
    expect(reopened.pending()).toHaveLength(0)
  })
})

describe('own-post eligibility and deferred joins', () => {
  test.each(['strict', 'open'] as const)('%s eligibility reads current membership and choices, with persona entries read only in strict mode', async mode => {
    const h = await fixture({ mode }), reads: string[] = []
    const eligibility = ownPostEligibility({ ...h.sources, persona(key) { reads.push(key); return h.sources.persona(key) } })
    expect(eligibility('alpha', C)).toEqual({ kind: 'eligible', mode, delivery: 'thread_hybrid' })
    expect(reads).toEqual(mode === 'strict' ? ['alpha'] : [])
  })

  test.each([...DELIVERY_MODES])('readable choice %s gates registration in both channel modes', async choice => {
    for (const mode of ['strict', 'open'] as const) {
      const h = await fixture({ mode }); expect(h.choose(choice).kind).toBe('applied')
      await h.flush(); const before = h.records()
      const started = h.observer.start('alpha', 'text', TARGET, CONTENT)
      expect(started !== undefined).toBe(choice === 'thread_hybrid')
      await started?.ready
      expect(h.records().filter(r => r.kind === 'post-intent')).toHaveLength(choice === 'thread_hybrid' ? 1 : 0)
      if (!started) expect(h.records()).toEqual(before)
    }
  })

  const CHOICES = [...DELIVERY_MODES, 'unset', 'unreadable'] as const
  const MATRIX = (['strict', 'open'] as const).flatMap(mode =>
    (['eligible', 'ineligible', 'unresolved'] as const).flatMap(membership =>
      (['current', 'stale', 'undecided'] as const).flatMap(stamp =>
        CHOICES.map(choice => ({ mode, membership, stamp, choice })))))
    // A positive inventory gives an unset choice its production default;
    // rotating a stamp explicitly assigns thread_hybrid. Those two products
    // cannot still have an unset choice through the real authority.
    .filter(row => row.choice !== 'unset' || (row.membership !== 'eligible' && row.stamp !== 'stale'))
  test.each(MATRIX)('$mode: $choice choice, $membership membership, $stamp transition decides through real readers', async ({ mode, membership, stamp, choice }) => {
    const h = await fixture({ mode }), post = h.begin()
    await post.ready
    await h.scan(membership)
    if (stamp === 'stale') h.stale()
    if (choice === 'unset') {
      await h.members.event(false)
      await h.scan(membership)
      expect(h.choices.storedChoice('alpha', C)).toBeUndefined()
    } else if (choice !== 'unreadable') expect(h.choose(choice).kind).toBe('applied')
    if (stamp === 'undecided' || choice === 'unreadable') h.undecided()
    // Choice changes and verified absence forget the old stamp. Undecided
    // stamps must wait even when the previous choice would exclude this post.
    const deferred = stamp === 'undecided' || choice === 'unreadable' || (stamp === 'current' && choice === 'thread_hybrid' && membership === 'unresolved')
    const joined = stamp === 'current' && choice === 'thread_hybrid' && membership === 'eligible'
    // Pin the eligibility reader independently of the owner's stamp guard, so
    // an accidental off/mentions/all eligibility cannot hide behind staleness.
    const eligibleKind = stamp === 'undecided' || choice === 'unreadable' ? 'unresolved'
      : choice !== 'thread_hybrid' ? 'ineligible' : membership
    expect(ownPostEligibility(h.sources)('alpha', C).kind).toBe(eligibleKind)
    const calls = h.members.h.stub(h.members.h.p('alpha')).web.callLog.length
    h.observer.end(post.operation, await postAnswer())
    expect(h.members.h.stub(h.members.h.p('alpha')).web.callLog).toHaveLength(calls)
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set([ROOT]))
    expect(h.events.at(-1)).not.toHaveProperty('lookup')
    expect(h.view() === 'joined').toBe(joined)
    if (deferred) {
      expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'deferred' })
      expect(h.memory.unresolvedIntents('alpha')).toHaveLength(1)
      expect(h.records().filter(r => r.kind === 'post-outcome')).toHaveLength(0)
    } else await savedOutcome(h, post.id, joined ? 'joined' : 'none')
  })

  test.each(['strict', 'open'] as const)('%s: ineligible membership with a current thread_hybrid stamp writes none', async mode => {
    const h = await fixture({ mode })
    await h.scan('ineligible'); expect(h.choose('thread_hybrid').kind).toBe('applied')
    const post = h.begin(); await post.ready
    expect(h.pending()).toHaveLength(1)
    expect(ownPostEligibility(h.sources)('alpha', C).kind).toBe('ineligible')
    h.observer.end(post.operation, await postAnswer())
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set([ROOT]))
    expect(h.view()).toBe('not-joined'); await savedOutcome(h, post.id, 'none')
  })

  test('unset and unreadable choices are read from the store: unset refuses, unreadable registers without waiting', async () => {
    const h = await fixture()
    const unlisted = SHARED_CHANNEL_IDS.private
    expect(h.choices.storedChoice('alpha', unlisted)).toBeUndefined()
    expect(h.observer.start('alpha', 'text', { channel: unlisted }, CONTENT)).toBeUndefined()
    h.undecided()
    expect(h.choices.readableFor('alpha', C)).toBe(false)
    const post = h.begin(); expect(post.ready).toBeUndefined()
    expect(h.records().filter(r => r.kind === 'post-intent')).toHaveLength(0)
  })

  test.each(['join', 'ineligible', 'stale'] as const)('membership-deferred confirmation settles as %s synchronously in the decision read', async result => {
    const h = await fixture(), post = h.begin()
    await post.ready; await h.scan('unresolved')
    expect(h.observer.end(post.operation, await postAnswer())).toBeUndefined()
    expect(h.pending()).toMatchObject([{ state: 'deferred' }])
    h.owner.settleDeferred('alpha', C); expect(h.pending()).toHaveLength(1)
    if (result === 'stale') h.stale()
    else await h.scan(result === 'join' ? 'eligible' : 'ineligible')
    const slack = h.members.h.stub(h.members.h.p('alpha')).web, calls = slack.callLog.slice()
    h.io.reset()
    const decisionRead = () => { h.owner.settleDeferred('alpha', C); return h.view() }
    expect(decisionRead()).toBe(result === 'join' ? 'joined' : 'not-joined')
    expect(h.io.calls).toHaveLength(0)
    expect(slack.callLog).toEqual(calls)
    await savedOutcome(h, post.id, result === 'join' ? 'joined' : 'none')
  })

  test('an undecided stamp after registration defers, then publication settles only on its microtask', async () => {
    const h = await fixture(), post = h.begin()
    await post.ready; h.undecided()
    h.observer.end(post.operation, await postAnswer())
    expect(h.owner.operation('alpha', post.id)?.state).toBe('deferred')
    h.owner.settleDeferred('alpha'); expect(h.records().filter(r => r.kind === 'post-outcome')).toHaveLength(0)
    h.decideStamp()
    h.io.reset()
    h.owner.onSharedStatePublished('alpha')
    expect(h.view()).toBe('not-joined')
    expect(h.io.calls).toHaveLength(0)
    await h.clock.flush()
    expect(h.view()).toBe('joined'); await savedOutcome(h, post.id, 'joined')
  })

  test.each(['join', 'ineligible', 'already-joined', 'choice-off'] as const)('a start under an undecided stamp waits in memory, then %s', async result => {
    const h = await fixture()
    h.undecided()
    const issuedAt = h.clock.now()
    const post = h.begin(ROOT)
    expect(post.ready).toBeUndefined(); expect(h.pending()).toHaveLength(0)
    expect(h.owner.operation('alpha', post.id)?.stamp).toBeUndefined()
    expect(h.records().filter(r => r.kind === 'post-intent')).toHaveLength(0)
    h.observer.end(post.operation, await postAnswer())
    expect(h.owner.memoryOnlyJoins('alpha')).toEqual([{ channel: C, root: ROOT }])
    h.owner.settleDeferred('alpha'); expect(h.records().filter(r => r.kind === 'post-intent')).toHaveLength(0)
    await h.clock.advance(50)
    h.decideStamp()
    if (result === 'ineligible') { await h.scan('ineligible'); expect(h.choose('thread_hybrid').kind).toBe('applied') }
    if (result === 'choice-off') h.choose('off')
    if (result === 'already-joined') h.memory.addJoin('alpha', h.fact({ root: ROOT }))
    const slack = h.members.h.stub(h.members.h.p('alpha')).web, calls = slack.callLog.slice()
    h.io.reset()
    h.owner.settleDeferred('alpha')
    expect(h.view()).toBe(result === 'join' || result === 'already-joined' ? 'joined' : 'not-joined')
    expect(h.io.calls).toHaveLength(0)
    expect(slack.callLog).toEqual(calls)
    await h.flush()
    if (result === 'already-joined' || result === 'choice-off') {
      expect(h.records().filter(r => r.kind === 'post-intent')).toHaveLength(0)
      expect(h.owner.operation('alpha', post.id)).toBeUndefined()
    } else {
      expect(h.records().filter(r => r.kind === 'post-intent')).toMatchObject([{ operationId: post.id, at: issuedAt, stamp: h.fact().stamp }])
      expect(h.view()).toBe(result === 'join' ? 'joined' : 'not-joined')
      await savedOutcome(h, post.id, result === 'join' ? 'joined' : 'none')
    }
  })

  test('readable choices under a staged restoration still wait for the undecided stamp', async () => {
    const h = await fixture()
    expect(h.stageRestoration().kind).toBe('unresolved')
    expect(h.choices.readableFor('alpha', C)).toBe(true)
    expect(h.choices.storedChoice('alpha', C)).toBe('thread_hybrid')
    expect(h.authority.channelStamp('alpha', C)).toEqual({ kind: 'undecided' })
    const post = h.begin()
    expect(post.ready).toBeUndefined()
    h.observer.end(post.operation, await postAnswer())
    h.owner.settleDeferred('alpha'); await h.flush()
    expect(h.pending()).toHaveLength(0)
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'deferred', outcome: { joined: false } })
    expect(h.records().filter(r => r.kind === 'post-intent' || r.kind === 'post-outcome')).toHaveLength(0)
    expect(h.owner.memoryOnlyJoins('alpha')).toEqual([{ channel: C, root: ROOT }])
  })

  test.each([
    ['unresolved membership', 'membership'],
    ['a stamp undecided after its intent was kept', 'undecided'],
    ['a stamp undecided before its intent could be kept', 'unkept'],
  ] as const)('a post deferred by %s announces deferred once, after decided, with no content', async (_label, cause) => {
    const h = await fixture(), received: OwnPostEvent[] = []
    h.owner.subscribe(() => { throw new Error('listener fault') })
    h.owner.subscribe(async () => { throw new Error('async listener fault') })
    h.owner.subscribe(event => { received.push(event) })
    if (cause === 'unkept') h.undecided()
    const post = h.begin()
    await post.ready
    if (cause === 'membership') await h.scan('unresolved')
    if (cause === 'undecided') h.undecided()
    h.observer.end(post.operation, await postAnswer())
    const outcome = { kind: 'confirmed', thread: ROOT, joined: false } as const
    const deferred: OwnPostEvent = { type: 'deferred', key: 'alpha', channel: C, operationId: post.id, outcome }
    expect(received).toEqual([{ type: 'registered', key: 'alpha', channel: C, operationId: post.id },
      { ...deferred, type: 'decided' }, deferred])
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'deferred', outcome })
    // Settling while still deferred, a publication, and the settlement that joins it announce nothing more.
    h.owner.settleDeferred('alpha'); h.owner.onSharedStatePublished('alpha'); await h.flush()
    if (cause === 'membership') await h.scan('eligible')
    else h.decideStamp()
    h.owner.settleDeferred('alpha')
    expect(h.view()).toBe('joined')
    await h.flush()
    expect(received.filter(e => e.type !== 'registered')).toEqual([{ ...deferred, type: 'decided' }, deferred])
    assertNoLeak({ received, events: h.events })
  })
})

describe('Pending Own Posts for Post Holds', () => {
  test.each([
    ['a duplicate operation ID', ['post-dup', 'post-dup']],
    ['an invalid operation ID', ['post-first', 'post.invalid']],
  ] as const)('a post whose intent keepIntent refuses for %s is never listed and covers no reply', async (_label, ids) => {
    const queue = [...ids], h = await fixture({ operationId: () => queue.shift()! })
    const first = h.begin(ROOT)
    await first.ready
    // Decided but its outcome not yet saved: its intent is still in the journal.
    h.observer.end(first.operation, await postAnswer({ ts: REPLY, message: { thread_ts: ROOT } }))
    expect(h.view(ROOT)).toBe('joined')
    const refused = h.begin(ROOT2)
    expect(refused.ready).toBeUndefined()
    expect(h.owner.operation('alpha', refused.id)).toMatchObject({ state: 'awaiting-answer', root: ROOT2, stamp: h.fact().stamp })
    expect(h.pending()).toEqual([])
    expect(decideReply(h, ROOT2)).toEqual({ action: 'drop', reason: 'not-mentioned' })
    await h.flush()
    expect(h.records().filter(r => r.kind === 'post-intent').map(r => r.operationId)).toEqual([first.id])
  })

  test.each(['Thread Memory not saved', 'unreadable journal'] as const)('%s: an intent kept only in memory is listed and covers its reply', async outage => {
    let h = await fixture(), unknownRoot = false
    if (outage === 'Thread Memory not saved') {
      h.io.fail('writeSync')
      const failed = h.begin(ROOT); await failed.ready
      expect(h.memory.saveBlocked('alpha')).toBe(true)
    } else {
      await h.close()
      const io = threadFsControls(h.dir); io.fail('readFileSync')
      h = await fixture({ reopen: h.dir, memory: { fs: io } })
      expect(h.memory.store('alpha')?.readable).toBe(false)
      unknownRoot = true
    }
    const post = h.begin(ROOT2)
    expect(post.ready).toBeUndefined()
    expect(h.pending().filter(p => p.root === ROOT2)).toMatchObject([{ operationId: post.id, state: 'awaiting-answer', stamp: h.fact().stamp }])
    expect(decideReply(h, ROOT2)).toEqual(heldFor(ROOT2, [post.id], unknownRoot))
    expect(h.records().filter(r => r.kind === 'post-intent' && r.operationId === post.id)).toEqual([])
  })

  test('a saved intent is listed and covers a reply under its root, or by issue time for a new message', async () => {
    const h = await fixture(), issuedAt = h.clock.now()
    const reply = h.begin(ROOT), message = h.begin()
    await Promise.all([reply.ready, message.ready])
    expect(h.records().filter(r => r.kind === 'post-intent').map(r => r.operationId)).toEqual([reply.id, message.id])
    expect(h.pending()).toMatchObject([{ operationId: reply.id, root: ROOT }, { operationId: message.id }])
    expect(h.pending()[1]!.root).toBeUndefined()
    expect(pendingOwnPostViews(h.pending())).toEqual([{ operation: reply.id, root: ROOT, issuedAt }, { operation: message.id, issuedAt }])
    // The new message, issued after ROOT less the skew, also covers ROOT.
    expect(decideReply(h, ROOT)).toEqual(heldFor(ROOT, [reply.id, message.id]))
    const bound = slackTsOfMs(issuedAt - OWN_ROOT_CLOCK_SKEW_MS)
    expect(decideReply(h, bound)).toEqual(heldFor(bound, [message.id]))
    expect(decideReply(h, slackTsOfMs(issuedAt - OWN_ROOT_CLOCK_SKEW_MS - 1))).toEqual({ action: 'drop', reason: 'not-mentioned' })
  })

  test('a start under an undecided stamp is listed only once the decided stamp keeps its intent', async () => {
    const h = await fixture()
    h.undecided()
    const post = h.begin(ROOT)
    expect(post.ready).toBeUndefined()
    expect(h.pending()).toEqual([])
    expect(decideReply(h, ROOT)).toMatchObject({ action: 'unresolved' })
    h.decideStamp()
    expect(h.pending()).toEqual([])
    // The decision's view lookup settles the deferred intent before the read.
    // The undecided application left the switched mode in force: open mode's path.
    expect(channelModeOf(h.authority.config())).toBe('open')
    expect(decideReply(h, ROOT)).toEqual({ action: 'hold', hold: 'post', via: 'thread', threadRoot: ROOT, operations: [post.id], rootUnknown: false,
      fungible: { channelType: 'public', channelDelivery: 'thread_hybrid' } })
    expect(h.pending()).toMatchObject([{ operationId: post.id, root: ROOT, stamp: h.fact().stamp }])
    await h.flush()
    expect(h.records().filter(r => r.kind === 'post-intent').map(r => r.operationId)).toEqual([post.id])
  })

  test('a recovered intent is listed only after the journal is read', async () => {
    const first = await fixture(), post = first.begin(ROOT)
    await post.ready
    await first.close()
    const h = await fixture({ reopen: first.dir, start: false })
    expect(h.pending()).toEqual([])
    await h.start()
    expect(h.pending()).toMatchObject([{ operationId: post.id, root: ROOT, state: 'unknown' }])
    expect(decideReply(h, ROOT)).toEqual(heldFor(ROOT, [post.id]))
  })
})

describe('lookup, upload, retention and persona scope', () => {
  test.each([
    ['top-level counts for holds', undefined, { found: { ts: REPLY }, holds: 'thread' }, 'current', REPLY],
    ['mapped reply counts for holds', REPLY, { found: { ts: REPLY }, holds: 'thread' }, 'current', ROOT],
    ['Slack thread overrides mapped parent', REPLY, { found: { ts: REPLY, threadTs: ROOT2 }, holds: 'thread' }, 'current', ROOT2],
    ['found does not count for holds', undefined, { found: { ts: REPLY, threadTs: ROOT }, holds: 'none' }, 'current', ROOT],
    ['empty range counts as failed', undefined, { notFound: true, holds: 'failed' }, 'current', undefined],
    ['not-found does not count for holds', undefined, { notFound: true, holds: 'none' }, 'current', undefined],
    ['stale found cannot count for holds', undefined, { found: { ts: REPLY, threadTs: ROOT }, holds: 'thread' }, 'stale', undefined],
    ['stale found with no hold verdict', undefined, { found: { ts: REPLY, threadTs: ROOT }, holds: 'none' }, 'stale', undefined],
    ['stale not-found is not a failure', undefined, { notFound: true, holds: 'failed' }, 'stale', undefined],
    ['membership removal invalidates the stamp', undefined, { found: { ts: REPLY, threadTs: ROOT }, holds: 'thread' }, 'ineligible', undefined],
  ] as const)('a restarted unresolved intent with a digest is resolved by lookup: %s', async (_label, parent, result, transition, root) => {
    const h = await fixture()
    if (parent === REPLY) await h.queue.accept('alpha', slackInput({ channel: C, ts: REPLY, key: { chat_id: C, ts: REPLY }, thread_ts: ROOT }))
    const post = h.begin(parent)
    await post.ready
    // No end call: replay the durable intent as after a crash before confirmation.
    const intent = h.memory.unresolvedIntents('alpha')[0]!
    expect(intent.digest).toMatch(/^[a-f0-9]{64}$/)
    await h.close()
    const next = await fixture({ reopen: h.dir })
    expect(next.owner.unknownOwnPosts('alpha')).toMatchObject([{ operationId: post.id, digest: intent.digest, issuedAt: intent.at }])
    expect(next.owner.resolvedThreads('alpha', C)).toEqual(new Set())
    if (transition === 'stale') next.stale()
    if (transition === 'ineligible') await next.scan('ineligible')
    expect(next.events).toHaveLength(0)
    const release = next.owner.retainOutcomes('alpha', [post.id])
    const lookup: OwnPostEvent['lookup'] = transition !== 'current' ? { holds: 'none' }
      : result.holds === 'thread' ? { holds: 'thread', thread: root! } : { holds: result.holds }
    const outcome: OwnPostEvent['outcome'] = root ? { kind: 'confirmed', thread: root, joined: true } : { kind: 'not-found', joined: false }
    next.io.reset()
    expect(next.owner.recordLookup('alpha', post.id, result)).toBeUndefined()
    expect(next.io.calls).toEqual([])
    expect(next.view(root ?? ROOT)).toBe(root ? 'joined' : 'not-joined')
    expect(next.pending()).toHaveLength(0)
    expect(next.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', outcome, lookup })
    expect(next.events).toEqual([{ type: 'decided', key: 'alpha', channel: C, operationId: post.id,
      outcome, lookup }])
    const resolved = new Set(root ? [root] : [])
    expect(next.owner.resolvedThreads('alpha', C)).toEqual(resolved)
    await savedOutcome(next, post.id, root ? 'joined' : 'none')
    release()
    expect(next.owner.operation('alpha', post.id)).toBeUndefined()
    expect(next.owner.resolvedThreads('alpha', C)).toEqual(resolved)
    assertNoLeak({ events: next.events, lookup, outcome, journal: writtenFile(threadPath(next.dir)) })
  })

  test('unknown lookup IDs change no operation, event, resolved thread or journal', async () => {
    const h = await fixture(), post = h.begin()
    await post.ready; h.observer.end(post.operation, NO_ANSWER); await h.flush()
    const before = { bytes: readFileSync(threadPath(h.dir)), events: h.events.slice(), unknown: h.owner.unknownOwnPosts('alpha') }
    expect(h.owner.recordLookup('alpha', 'missing', { found: { ts: ROOT }, holds: 'thread' })).toBeUndefined()
    expect(h.owner.recordLookup('alpha', 'missing', { notFound: true, holds: 'failed' })).toBeUndefined()
    await h.flush()
    expect(h.events).toEqual(before.events)
    expect(h.owner.unknownOwnPosts('alpha')).toEqual(before.unknown)
    expect(h.owner.operation('alpha', 'missing')).toBeUndefined()
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set())
    expect(readFileSync(threadPath(h.dir))).toEqual(before.bytes)
  })

  test.each([
    ['not found, holds none', { notFound: true, holds: 'none' }, 'current', 'none'],
    ['failed read, holds failed', { notFound: true, holds: 'failed' }, 'current', 'failed'],
    ['stale stamp, holds none', { notFound: true, holds: 'failed' }, 'stale', 'none'],
  ] as const)('a not-found lookup closes an awaiting upload, saving none (%s)', async (_label, result, transition, holds) => {
    const h = await fixture(), post = await awaiting(h)
    if (transition === 'stale') h.stale()
    const release = h.owner.retainOutcomes('alpha', [post.id])
    h.io.reset()
    expect(h.owner.recordLookup('alpha', post.id, result)).toBeUndefined()
    expect(h.io.calls).toEqual([])
    const outcome = { kind: 'not-found' as const, joined: false }, lookup = { holds }
    const decided: OwnPostEvent = { type: 'decided', key: 'alpha', channel: C, operationId: post.id, outcome, lookup }
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', outcome, lookup })
    expect(h.events.at(-1)).toEqual(decided)
    expect(h.pending()).toEqual([]); expect(h.owner.awaitingUploads('alpha')).toEqual([])
    // Closed: neither its share nor another lookup reopens it.
    h.owner.learnUploadThread('alpha', post.id, ROOT)
    h.owner.recordLookup('alpha', post.id, { notFound: true, holds: 'none' })
    expect(h.events.filter(e => e.type === 'decided')).toEqual([decided])
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set())
    expect(h.view()).toBe('not-joined')
    await savedOutcome(h, post.id, 'none')
    release(); expect(h.owner.operation('alpha', post.id)).toBeUndefined()
  })

  test('a found lookup leaves an awaiting upload open for its own share', async () => {
    const h = await fixture(), post = await awaiting(h)
    await h.flush()
    const bytes = readFileSync(threadPath(h.dir)), events = h.events.slice()
    for (const holds of ['thread', 'none'] as const) {
      expect(h.owner.recordLookup('alpha', post.id, { found: { ts: ROOT2, threadTs: ROOT2 }, holds })).toBeUndefined()
    }
    await h.flush()
    expect(h.events).toEqual(events)
    expect(readFileSync(threadPath(h.dir))).toEqual(bytes)
    expect(h.owner.awaitingUploads('alpha')).toMatchObject([{ operationId: post.id, state: 'awaiting-thread' }])
    expect(h.owner.operation('alpha', post.id)).not.toHaveProperty('lookup')
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set())
    expect(h.view(ROOT2)).toBe('not-joined')
    h.owner.learnUploadThread('alpha', post.id, ROOT)
    expect(h.view()).toBe('joined')
    await savedOutcome(h, post.id, 'joined')
  })

  test('an upload started under an undecided stamp closes on not-found, then saves none once its stamp is decided', async () => {
    const h = await fixture(); h.undecided()
    const post = h.begin(undefined, 'alpha', 'file'); expect(post.ready).toBeUndefined()
    h.observer.end(post.operation, { kind: 'confirmed', channel: C, file: UPLOAD })
    expect(h.owner.awaitingUploads('alpha')).toMatchObject([{ operationId: post.id, state: 'awaiting-thread' }])
    const release = h.owner.retainOutcomes('alpha', [post.id])
    h.owner.recordLookup('alpha', post.id, { notFound: true, holds: 'none' })
    expect(h.owner.awaitingUploads('alpha')).toEqual([])
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'deferred', outcome: { kind: 'not-found', joined: false }, lookup: { holds: 'none' } })
    h.decideStamp(); h.owner.settleDeferred('alpha')
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', outcome: { kind: 'not-found', joined: false } })
    await savedOutcome(h, post.id, 'none')
    release()
  })

  test.each(['thread', 'none'] as const)('a current-stamp ineligible found keeps holds=%s and learns its thread without joining', async holds => {
    const h = await fixture()
    await h.scan('ineligible'); expect(h.choose('thread_hybrid').kind).toBe('applied')
    const post = h.begin(); await post.ready
    h.observer.end(post.operation, NO_ANSWER)
    const release = h.owner.retainOutcomes('alpha', [post.id])
    const lookup = holds === 'thread' ? { holds, thread: ROOT } : { holds }
    expect(h.owner.recordLookup('alpha', post.id, { found: { ts: REPLY, threadTs: ROOT }, holds })).toBeUndefined()
    expect(h.view()).toBe('not-joined')
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', lookup,
      outcome: { kind: 'confirmed', thread: ROOT, joined: false } })
    expect(h.events.at(-1)).toMatchObject({ type: 'decided', lookup })
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set([ROOT]))
    await savedOutcome(h, post.id, 'none')
    release()
  })

  test.each(['thread', 'none'] as const)('a found recorded under an undecided stamp keeps holds=%s but learns no resolved thread', async holds => {
    const h = await fixture(), post = h.begin()
    await post.ready; h.observer.end(post.operation, NO_ANSWER); h.undecided()
    const release = h.owner.retainOutcomes('alpha', [post.id])
    const lookup = holds === 'thread' ? { holds, thread: ROOT } : { holds }
    expect(h.owner.recordLookup('alpha', post.id, { found: { ts: REPLY, threadTs: ROOT }, holds })).toBeUndefined()
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'deferred', lookup })
    expect(h.events.slice(-2)).toMatchObject([{ type: 'decided', lookup }, { type: 'deferred', lookup }])
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set())
    expect(h.records().filter(r => r.kind === 'post-outcome')).toEqual([])
    h.decideStamp(); h.owner.settleDeferred('alpha', C)
    expect(h.view()).toBe('joined')
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', lookup })
    expect(h.events.filter(e => e.type === 'deferred')).toHaveLength(1)
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set())
    await savedOutcome(h, post.id, 'joined')
    release()
  })

  test.each(['confirmed', 'failed', 'deferred'] as const)('a Slack-decided %s operation has no lookup metadata', async kind => {
    const h = await fixture(), post = h.begin()
    await post.ready
    if (kind === 'deferred') await h.scan('unresolved')
    const release = h.owner.retainOutcomes('alpha', [post.id])
    const answer = kind === 'failed' ? ownPostAnswerOfError(slackPlatformError('not_in_channel')) : await postAnswer()
    expect(h.observer.end(post.operation, answer)).toBeUndefined()
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: kind === 'deferred' ? 'deferred' : 'decided',
      outcome: { kind: kind === 'failed' ? 'failed' : 'confirmed', joined: kind === 'confirmed' } })
    expect(h.owner.operation('alpha', post.id)).not.toHaveProperty('lookup')
    const answered = h.events.slice(h.events.findIndex(e => e.type === 'decided'))
    expect(answered.map(e => e.type)).toEqual(kind === 'deferred' ? ['decided', 'deferred'] : ['decided'])
    for (const event of answered) expect(event).not.toHaveProperty('lookup')
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set(kind === 'failed' ? [] : [ROOT]))
    release()
  })

  test('resolved threads survive discarded outcomes, stay per key and channel, and forget clears only one key', async () => {
    const h = await fixture({ names: ['alpha', 'beta'] })
    const posts = [h.begin(), h.begin(), h.begin(undefined, 'alpha', 'text', C2), h.begin(undefined, 'beta')]
    await Promise.all(posts.map(post => post.ready))
    h.observer.end(posts[0]!.operation, await postAnswer())
    h.observer.end(posts[1]!.operation, await postAnswer({ ts: ROOT2 }))
    h.observer.end(posts[2]!.operation, await postAnswer({ ts: ROOT2 }, C2))
    h.observer.end(posts[3]!.operation, await postAnswer({ ts: REPLY }))
    await h.flush()
    expect(h.owner.operation('alpha', posts[0]!.id)).toBeUndefined()
    h.io.reset()
    const calls = h.members.h.stub(h.members.h.p('alpha')).web.callLog.slice()
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set([ROOT, ROOT2]))
    expect(h.owner.resolvedThreads('alpha', C2)).toEqual(new Set([ROOT2]))
    expect(h.owner.resolvedThreads('beta', C)).toEqual(new Set([REPLY]))
    expect(h.owner.resolvedThreads('beta', C2)).toEqual(new Set())
    expect(h.owner.resolvedThreads('missing', C)).toEqual(new Set())
    expect(h.io.calls).toEqual([])
    expect(h.members.h.stub(h.members.h.p('alpha')).web.callLog).toEqual(calls)
    h.owner.forget('alpha')
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set())
    expect(h.owner.resolvedThreads('alpha', C2)).toEqual(new Set())
    expect(h.owner.resolvedThreads('beta', C)).toEqual(new Set([REPLY]))
    // A retained durable join is not a thread learnt by this new owner lifetime.
    expect(h.view()).toBe('joined')
  })

  test('a parentless upload waits for its thread, then joins; only retained outcomes survive', async () => {
    const h = await fixture(), post = h.begin(undefined, 'alpha', 'file')
    await post.ready
    const releaseA = h.owner.retainOutcomes('alpha', [post.id]), releaseB = h.owner.retainOutcomes('alpha', [post.id, post.id])
    h.observer.end(post.operation, { kind: 'confirmed', channel: C, file: UPLOAD })
    const listed = { operationId: post.id, channel: C, file: UPLOAD, state: 'awaiting-thread' }
    expect(h.owner.awaitingUploads('alpha')).toMatchObject([listed])
    expect(h.owner.awaitingUploads('alpha', C)).toMatchObject([listed])
    expect(h.view()).toBe('not-joined')
    h.owner.learnUploadThread('alpha', post.id, ROOT)
    expect(h.view()).toBe('joined'); expect(h.owner.awaitingUploads('alpha', C)).toHaveLength(0)
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', outcome: { kind: 'confirmed', thread: ROOT, joined: true } })
    releaseA(); releaseA(); expect(h.owner.operation('alpha', post.id)).toBeDefined()
    releaseB(); expect(h.owner.operation('alpha', post.id)).toBeUndefined()
    await savedOutcome(h, post.id, 'joined')
  })

  test('a confirmed parentless upload is listed with what its read needs, stays pending and fires one awaiting-thread event', async () => {
    const h = await fixture(), issuedAt = h.clock.now(), stamp = h.fact().stamp
    const post = await awaiting(h)
    const expected = { operationId: post.id, key: 'alpha', channel: C, issuedAt, stamp, file: UPLOAD, state: 'awaiting-thread' }
    h.io.reset()
    expect(h.owner.awaitingUploads('alpha')).toMatchObject([expected])
    expect(h.owner.awaitingUploads('alpha', C)).toMatchObject([expected])
    expect(h.owner.awaitingUploads('alpha', C2)).toEqual([])
    expect(h.io.calls).toEqual([])
    expect(h.pending()).toMatchObject([expected])
    const events: OwnPostEvent[] = [{ type: 'registered', key: 'alpha', channel: C, operationId: post.id },
      { type: 'awaiting-thread', key: 'alpha', channel: C, operationId: post.id }]
    expect(h.events).toEqual(events)
    // Neither a repeated end nor a settlement or read announces it again.
    h.observer.end(post.operation, { kind: 'confirmed', channel: C, file: UPLOAD })
    h.owner.settleDeferred('alpha'); h.owner.onSharedStatePublished('alpha'); await h.flush()
    expect(h.events).toEqual(events)
    expect(h.owner.awaitingUploads('alpha')).toMatchObject([expected])
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set())
    expect(h.records().filter(r => r.kind === 'post-outcome')).toEqual([])
    // The upload's content name is the sentinel: no listing, event or journal carries it.
    assertNoLeak({ events: h.events, awaiting: h.owner.awaitingUploads('alpha'), journal: writtenFile(threadPath(h.dir)) })
  })

  test('without a channel every channel\'s awaiting uploads come back in issue order, and never another key\'s', async () => {
    const h = await fixture({ names: ['alpha', 'beta'] })
    const specs = [['alpha', C2], ['beta', C], ['alpha', C], ['alpha', C2]] as const, posts: ReturnType<Fixture['begin']>[] = []
    for (const [key, channel] of specs) { posts.push(h.begin(undefined, key, 'file', channel)); await h.clock.advance(10) }
    await Promise.all(posts.map(post => post.ready))
    // Completions arrive in the reverse order of issue.
    for (let i = posts.length - 1; i >= 0; i--) h.observer.end(posts[i]!.operation, { kind: 'confirmed', channel: specs[i]![1], file: `F0UPLOAD${i}` })
    const listed = (key: string, channel?: string) => h.owner.awaitingUploads(key, channel).map(p => [p.operationId, p.key, p.channel, p.file])
    const row = (i: number) => [posts[i]!.id, specs[i]![0], specs[i]![1], `F0UPLOAD${i}`]
    expect(listed('alpha')).toEqual([row(0), row(2), row(3)])
    expect(listed('alpha', C2)).toEqual([row(0), row(3)])
    expect(listed('alpha', C)).toEqual([row(2)])
    expect(listed('beta')).toEqual([row(1)])
    expect(listed('missing')).toEqual([])
    const issued = h.owner.awaitingUploads('alpha').map(p => p.issuedAt)
    expect(issued).toEqual([...issued].sort((a, b) => a - b))
    expect(h.events.filter(e => e.type === 'awaiting-thread').map(e => [e.operationId, e.key, e.channel]))
      .toEqual([3, 2, 1, 0].map(i => row(i).slice(0, 3)))
  })

  test('a parent-bound upload confirms through its parent and never awaits its thread', async () => {
    const h = await fixture()
    await h.queue.accept('alpha', slackInput({ channel: C, ts: REPLY, key: { chat_id: C, ts: REPLY }, thread_ts: ROOT }))
    for (const [parent, root] of [[ROOT2, ROOT2], [REPLY, ROOT]] as const) {
      const post = h.begin(parent, 'alpha', 'file'); await post.ready
      h.observer.end(post.operation, { kind: 'confirmed', channel: C, file: UPLOAD })
      expect(h.owner.awaitingUploads('alpha')).toEqual([])
      expect(h.view(root)).toBe('joined')
      await savedOutcome(h, post.id, 'joined')
    }
    expect(h.events.filter(e => e.type === 'awaiting-thread')).toEqual([])
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set([ROOT, ROOT2]))
  })

  test.each(['join', 'stale', 'ineligible', 'unresolved', 'undecided'] as const)('learning an awaiting upload\'s thread decides it once: %s', async kind => {
    const h = await fixture()
    if (kind === 'ineligible') { await h.scan('ineligible'); expect(h.choose('thread_hybrid').kind).toBe('applied') }
    const post = await awaiting(h)
    if (kind === 'stale') h.stale()
    if (kind === 'unresolved') await h.scan('unresolved')
    if (kind === 'undecided') h.undecided()
    const release = h.owner.retainOutcomes('alpha', [post.id])
    const slack = h.members.h.stub(h.members.h.p('alpha')).web, calls = slack.callLog.slice()
    h.io.reset()
    expect(h.owner.learnUploadThread('alpha', post.id, ROOT)).toBeUndefined()
    expect(h.io.calls).toEqual([])
    expect(slack.callLog).toEqual(calls)
    const deferred = kind === 'unresolved' || kind === 'undecided'
    const decided: OwnPostEvent = { type: 'decided', key: 'alpha', channel: C, operationId: post.id,
      outcome: { kind: 'confirmed', thread: ROOT, joined: kind === 'join' } }
    const announced = deferred ? [decided, { ...decided, type: 'deferred' as const }] : [decided]
    expect(h.events.slice(-announced.length)).toEqual(announced)
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: deferred ? 'deferred' : 'decided', outcome: decided.outcome })
    expect(h.owner.awaitingUploads('alpha')).toEqual([])
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set([ROOT]))
    expect(h.view() === 'joined').toBe(kind === 'join')
    if (deferred) {
      if (kind === 'unresolved') await h.scan('eligible')
      else h.decideStamp()
      h.owner.settleDeferred('alpha', C)
    }
    const joined = kind === 'join' || deferred
    expect(h.view()).toBe(joined ? 'joined' : 'not-joined')
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', outcome: { thread: ROOT, joined } })
    // A second learning, of the same or another thread, changes nothing.
    for (const thread of [ROOT, ROOT2]) h.owner.learnUploadThread('alpha', post.id, thread)
    expect(h.view(ROOT2)).toBe('not-joined')
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set([ROOT]))
    expect(h.events.filter(e => e.type === 'decided')).toEqual([decided])
    expect(h.events.filter(e => e.type === 'deferred')).toEqual(announced.slice(1))
    await savedOutcome(h, post.id, joined ? 'joined' : 'none')
    release()
    await h.close()
    const reopened = await fixture({ reopen: h.dir })
    expect(reopened.view()).toBe(joined ? 'joined' : 'not-joined')
    expect(reopened.owner.unknownOwnPosts('alpha')).toEqual([])
    expect(reopened.owner.awaitingUploads('alpha')).toEqual([])
  })

  test('learning a thread changes nothing for a missing, unanswered, text, forgotten or invalid target', async () => {
    const h = await fixture(), unanswered = h.begin(undefined, 'alpha', 'file'), text = h.begin()
    await Promise.all([unanswered.ready, text.ready]); h.observer.end(text.operation, NO_ANSWER)
    const open = await awaiting(h)
    await h.flush()
    const bytes = readFileSync(threadPath(h.dir)), events = h.events.slice()
    const unchanged = async () => {
      await h.flush()
      expect(h.events).toEqual(events)
      expect(readFileSync(threadPath(h.dir))).toEqual(bytes)
      expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set())
      expect(h.view()).toBe('not-joined')
    }
    for (const [key, id, thread] of [['alpha', 'missing', ROOT], ['alpha', unanswered.id, ROOT], ['alpha', text.id, ROOT],
      ['alpha', open.id, 'invalid'], ['nobody', open.id, ROOT]] as const) {
      expect(h.owner.learnUploadThread(key, id, thread)).toBeUndefined()
    }
    await unchanged()
    expect(h.owner.operation('alpha', unanswered.id)).toMatchObject({ state: 'awaiting-answer' })
    expect(h.owner.operation('alpha', text.id)).toMatchObject({ state: 'unknown' })
    expect(h.owner.awaitingUploads('alpha')).toMatchObject([{ operationId: open.id }])
    h.owner.forget('alpha')
    expect(h.owner.awaitingUploads('alpha')).toEqual([])
    h.owner.learnUploadThread('alpha', open.id, ROOT)
    await unchanged()
  })

  test('a learnt upload thread whose outcome append fails still joins in memory and decides', async () => {
    const h = await fixture(), post = await awaiting(h)
    const release = h.owner.retainOutcomes('alpha', [post.id])
    h.io.fail('writeSync')
    expect(h.owner.learnUploadThread('alpha', post.id, ROOT)).toBeUndefined()
    await h.flush()
    expect(h.view()).toBe('joined')
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', outcome: { kind: 'confirmed', thread: ROOT, joined: true } })
    expect(h.owner.awaitingUploads('alpha')).toEqual([])
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set([ROOT]))
    expect(h.records().filter(r => r.kind === 'post-outcome')).toEqual([])
    release()
  })

  test.each([true, false])('memoryOnlyJoins distinguishes deferred confirmations with saved intent=%s and excludes stale ones', async saved => {
    const h = await fixture()
    if (!saved) h.io.fail('writeSync')
    const post = h.begin(); await post.ready; await h.scan('unresolved')
    h.observer.end(post.operation, await postAnswer())
    expect(h.owner.memoryOnlyJoins('alpha')).toEqual(saved ? [] : [{ channel: C, root: ROOT }])
    h.stale(); expect(h.owner.memoryOnlyJoins('alpha')).toEqual([])
  })

  test('personas sharing one identity keep separate pending entries and joins; forget drops only its key', async () => {
    const h = await fixture({ names: ['alpha', 'beta'], sharedIdentity: true })
    expect(h.members.h.identityFor('alpha')).toEqual(h.members.h.identityFor('beta'))
    const a = h.begin(), b = h.begin(undefined, 'beta')
    await Promise.all([a.ready, b.ready])
    const release = h.owner.retainOutcomes('alpha', [a.id])
    h.observer.end(a.operation, await postAnswer())
    expect(h.view()).toBe('joined'); expect(h.view(ROOT, 'beta')).toBe('not-joined')
    expect(h.pending('beta')).toMatchObject([{ operationId: b.id }])
    h.owner.forget('beta')
    h.observer.end(b.operation, await postAnswer({ ts: ROOT2 }))
    expect(h.view(ROOT2, 'beta')).toBe('not-joined')
    expect(h.view()).toBe('joined')
    expect(h.owner.operation('alpha', a.id)).toMatchObject({ state: 'decided', outcome: { joined: true } })
    release()
    await savedOutcome(h, a.id, 'joined')
  })

  test.each(['dry-run', 'unapplied', 'stopped', 'dm', 'malformed-channel'] as const)('%s starts nothing and leaves Thread Memory unchanged', async scope => {
    const h = await fixture(), before = readFileSync(threadPath(h.dir))
    // An active store is essential: otherwise every gate would appear to work
    // merely because Thread Memory had not applied the persona yet.
    expect(h.memory.isApplied('alpha')).toBe(true)
    expect(h.choices.storedChoice('alpha', C)).toBe('thread_hybrid')
    if (scope === 'dry-run') h.dryRun(true)
    if (scope === 'stopped') h.owner.stop()
    expect(h.observer.start(scope === 'unapplied' ? 'nobody' : 'alpha', 'text',
      { channel: scope === 'dm' ? 'D0PRIVATE' : scope === 'malformed-channel' ? 'not-a-channel' : C }, CONTENT)).toBeUndefined()
    await h.clock.flush()
    expect(h.events).toHaveLength(0)
    await h.close()
    expect(readFileSync(threadPath(h.dir))).toEqual(before)
    expect(existsSync(threadPath(h.dir, 'nobody'))).toBe(false)
  })

  test('dry-run initialization and attempted posts create no Thread Memory journal', async () => {
    const h = await fixture({ start: false, memory: { dryRun: true } })
    h.dryRun(true); await h.start()
    expect(h.observer.start('alpha', 'text', TARGET, CONTENT)).toBeUndefined()
    expect(h.events).toHaveLength(0)
    await h.close()
    expect(existsSync(threadPath(h.dir))).toBe(false)
  })

  test('forget removes one persona\'s memory-only operations and leaves its neighbor pending', async () => {
    const h = await fixture({ names: ['alpha', 'beta'] }); h.undecided()
    const a = h.begin(), b = h.begin(undefined, 'beta')
    expect(a.ready).toBeUndefined(); expect(b.ready).toBeUndefined()
    h.owner.forget('alpha')
    expect(h.owner.operation('alpha', a.id)).toBeUndefined()
    expect(h.owner.operation('beta', b.id)).toMatchObject({ state: 'awaiting-answer' })
    h.observer.end(a.operation, await postAnswer())
    expect(h.owner.memoryOnlyJoins('alpha')).toHaveLength(0)
    h.observer.end(b.operation, await postAnswer())
    expect(h.owner.memoryOnlyJoins('beta')).toEqual([{ channel: C, root: ROOT }])
  })

  test('events never carry content and a throwing or rejecting subscriber cannot interrupt any outcome', async () => {
    const h = await fixture(), received: OwnPostEvent[] = []
    h.owner.subscribe(() => { throw new Error('listener fault') })
    h.owner.subscribe(async () => { throw new Error('async listener fault') })
    const unsubscribe = h.owner.subscribe(event => { received.push(event) })
    const post = h.begin(); await post.ready
    h.observer.end(post.operation, NO_ANSWER)
    expect(h.owner.recordLookup('alpha', post.id, { found: { ts: ROOT }, holds: 'thread' })).toBeUndefined()
    await h.flush()
    expect(received).toEqual([
      { type: 'registered', key: 'alpha', channel: C, operationId: post.id },
      { type: 'unknown', key: 'alpha', channel: C, operationId: post.id },
      { type: 'decided', key: 'alpha', channel: C, operationId: post.id, outcome: { kind: 'confirmed', thread: ROOT, joined: true },
        lookup: { holds: 'thread', thread: ROOT } },
    ])
    unsubscribe(); h.begin(ROOT2); expect(received).toHaveLength(3)
    assertNoLeak({ events: h.events, received, journal: writtenFile(threadPath(h.dir)), captured: h.members.captured() })
  })

  /** Each state the owner holds an operation in, reached as production reaches it, with the facts a Post
   * Hold reads: the thread Slack confirmed (a confirmed outcome's `thread`) and a failure (a failed
   * outcome). `retain` runs while the operation is pending, as a Post Hold's store retains. The
   * lookup-decided views are di's table above. */
  const HOLD_VIEWS: Array<{ label: string; state: OwnPostOperationView['state']; outcome?: OwnPostOutcome
    reach(h: Fixture, retain: (id: string) => void): Promise<string> }> = [
    { label: 'awaiting its answer', state: 'awaiting-answer', async reach(h, retain) {
      const post = h.begin(ROOT); await post.ready; retain(post.id); return post.id } },
    { label: 'left without an answer', state: 'unknown', async reach(h, retain) {
      const post = h.begin(ROOT); await post.ready; retain(post.id); h.observer.end(post.operation, NO_ANSWER); return post.id } },
    { label: 'an upload awaiting its thread', state: 'awaiting-thread', async reach(h, retain) {
      const post = await awaiting(h); retain(post.id); return post.id } },
    { label: 'deferred by unresolved membership', state: 'deferred', outcome: { kind: 'confirmed', thread: ROOT, joined: false },
      async reach(h, retain) {
        const post = h.begin(); await post.ready; retain(post.id); await h.scan('unresolved')
        h.observer.end(post.operation, await postAnswer()); return post.id } },
    { label: 'deferred by an undecided stamp', state: 'deferred', outcome: { kind: 'confirmed', thread: ROOT, joined: false },
      async reach(h, retain) {
        const post = h.begin(); await post.ready; retain(post.id); h.undecided()
        h.observer.end(post.operation, await postAnswer()); return post.id } },
    { label: 'a confirmed reply, in its Thread Root', state: 'decided', outcome: { kind: 'confirmed', thread: ROOT, joined: true },
      async reach(h, retain) {
        const post = h.begin(ROOT); await post.ready; retain(post.id)
        h.observer.end(post.operation, await postAnswer({ ts: REPLY, message: { thread_ts: ROOT } })); return post.id } },
    { label: 'a confirmed top-level post, in its own ts', state: 'decided', outcome: { kind: 'confirmed', thread: ROOT2, joined: true },
      async reach(h, retain) {
        const post = h.begin(); await post.ready; retain(post.id)
        h.observer.end(post.operation, await postAnswer({ ts: ROOT2 })); return post.id } },
    { label: 'an upload whose thread is learnt', state: 'decided', outcome: { kind: 'confirmed', thread: ROOT2, joined: true },
      async reach(h, retain) {
        const post = await awaiting(h); retain(post.id); h.owner.learnUploadThread('alpha', post.id, ROOT2); return post.id } },
    { label: 'confirmed after its stamp went stale', state: 'decided', outcome: { kind: 'confirmed', thread: ROOT, joined: false },
      async reach(h, retain) {
        const post = h.begin(); await post.ready; retain(post.id); h.stale()
        h.observer.end(post.operation, await postAnswer()); return post.id } },
    { label: 'confirmed while ineligible', state: 'decided', outcome: { kind: 'confirmed', thread: ROOT, joined: false },
      async reach(h, retain) {
        await h.scan('ineligible'); expect(h.choose('thread_hybrid').kind).toBe('applied')
        const post = h.begin(); await post.ready; retain(post.id)
        h.observer.end(post.operation, await postAnswer()); return post.id } },
    { label: 'deferred, then settled ineligible', state: 'decided', outcome: { kind: 'confirmed', thread: ROOT, joined: false },
      async reach(h, retain) {
        const post = h.begin(); await post.ready; retain(post.id); await h.scan('unresolved')
        h.observer.end(post.operation, await postAnswer()); await h.scan('ineligible'); h.owner.settleDeferred('alpha', C)
        return post.id } },
    { label: 'failed', state: 'decided', outcome: { kind: 'failed', joined: false },
      async reach(h, retain) {
        const post = h.begin(); await post.ready; retain(post.id)
        h.observer.end(post.operation, ownPostAnswerOfError(slackPlatformError('not_in_channel'))); return post.id } },
    { label: 'failed after its stamp went stale', state: 'decided', outcome: { kind: 'failed', joined: false },
      async reach(h, retain) {
        const post = h.begin(); await post.ready; retain(post.id); h.stale()
        h.observer.end(post.operation, ownPostAnswerOfError(slackPlatformError('not_in_channel'))); return post.id } },
    { label: 'an upload refused after its wait', state: 'decided', outcome: { kind: 'failed', joined: false },
      async reach(h, retain) {
        const post = h.begin(undefined, 'alpha', 'file'); await post.ready; retain(post.id)
        h.observer.end(post.operation, { kind: 'failed', code: OWN_POST_UPLOAD_REFUSED }); return post.id } },
  ]
  test.each(HOLD_VIEWS)('operation reads $label with its hold facts until both of two retentions release', async row => {
    const h = await fixture(), slack = h.members.h.stub(h.members.h.p('alpha')).web, releases: Array<() => void> = []
    const id = await row.reach(h, id => {
      const io = h.io.calls.length, calls = slack.callLog.length
      releases.push(h.owner.retainOutcomes('alpha', [id]), h.owner.retainOutcomes('alpha', [id, id]))
      expect([h.io.calls.length, slack.callLog.length]).toEqual([io, calls])
    })
    expect(releases).toHaveLength(2)
    const calls = slack.callLog.slice()
    h.io.reset()
    const view = h.owner.operation('alpha', id)
    expect(view).toMatchObject({ operationId: id, key: 'alpha', channel: C, state: row.state })
    expect(view!.outcome).toEqual(row.outcome)
    expect(view).not.toHaveProperty('lookup')
    // Hold views carry no content digest; only the lookup runner reads one, through unknownOwnPosts.
    expect(view).not.toHaveProperty('digest')
    const [first, second] = releases
    expect(first!()).toBeUndefined(); first!()
    expect(h.owner.operation('alpha', id)).toEqual(view)
    second!()
    // A pending entry is never dropped; a decided one goes with its last retention.
    expect(h.owner.operation('alpha', id)).toEqual(row.state === 'decided' ? undefined : view)
    expect(h.io.calls).toEqual([]); expect(slack.callLog).toEqual(calls)
  })

  test.each([
    ['never started', async (_h: Fixture): Promise<string> => 'post-never'],
    ['forgotten while retained', async (h: Fixture): Promise<string> => {
      const post = h.begin(); await post.ready
      h.owner.retainOutcomes('alpha', [post.id]); h.observer.end(post.operation, await postAnswer())
      h.owner.forget('alpha'); return post.id }],
    ['decided while unretained', async (h: Fixture): Promise<string> => {
      const post = h.begin(); await post.ready
      h.observer.end(post.operation, await postAnswer()); return post.id }],
  ] as const)('operation answers undefined for an operation %s', async (_label, reach) => {
    const h = await fixture(), id = await reach(h)
    h.io.reset()
    expect(h.owner.operation('alpha', id)).toBeUndefined()
    expect(h.io.calls).toEqual([])
  })

  test('an unretained outcome is readable in its decided event and dropped once the event has fired', async () => {
    const h = await fixture(), seen: unknown[] = []
    h.owner.subscribe(event => { if (event.type === 'decided') seen.push(h.owner.operation(event.key, event.operationId)) })
    const post = h.begin(); await post.ready
    h.observer.end(post.operation, await postAnswer())
    expect(seen).toMatchObject([{ operationId: post.id, state: 'decided', outcome: { kind: 'confirmed', thread: ROOT, joined: true } }])
    expect(h.owner.operation('alpha', post.id)).toBeUndefined()
  })

  test('a name the owner does not hold is not retained, even for a later operation given that name', async () => {
    const h = await fixture()
    const early = h.owner.retainOutcomes('alpha', ['post-1', 'post-missing'])
    const post = h.begin(); expect(post.id).toBe('post-1')
    await post.ready
    h.observer.end(post.operation, await postAnswer())
    expect(h.owner.operation('alpha', post.id)).toBeUndefined()
    expect(early()).toBeUndefined(); early()
  })

  test('forget drops its retentions, and a release from before it never frees one taken after it', async () => {
    const h = await fixture(), a = h.begin(ROOT), b = h.begin(ROOT2)
    await Promise.all([a.ready, b.ready])
    const before = h.owner.retainOutcomes('alpha', [a.id, b.id])
    h.owner.forget('alpha')
    // Their kept intents are read back as unknown in the key's next life, retained by nothing.
    expect([a.id, b.id].map(id => h.owner.operation('alpha', id)?.state)).toEqual(['unknown', 'unknown'])
    h.owner.recordLookup('alpha', a.id, { found: { ts: REPLY, threadTs: ROOT }, holds: 'thread' })
    expect(h.owner.operation('alpha', a.id)).toBeUndefined()
    const after = h.owner.retainOutcomes('alpha', [b.id])
    h.owner.recordLookup('alpha', b.id, { found: { ts: REPLY, threadTs: ROOT2 }, holds: 'thread' })
    expect(before()).toBeUndefined(); before()
    expect(h.owner.operation('alpha', b.id)).toMatchObject({ state: 'decided', lookup: { holds: 'thread', thread: ROOT2 } })
    after()
    expect(h.owner.operation('alpha', b.id)).toBeUndefined()
  })

  test('a release after stop changes nothing, and a retention asked for after stop is a harmless no-op', async () => {
    const h = await fixture(), post = h.begin()
    await post.ready
    const release = h.owner.retainOutcomes('alpha', [post.id])
    h.observer.end(post.operation, await postAnswer())
    const decided = h.owner.operation('alpha', post.id)
    expect(decided).toMatchObject({ state: 'decided', outcome: { kind: 'confirmed', thread: ROOT } })
    h.owner.stop()
    expect(release()).toBeUndefined(); release()
    expect(h.owner.operation('alpha', post.id)).toEqual(decided)
    const late = h.owner.retainOutcomes('alpha', [post.id])
    expect(late()).toBeUndefined()
    expect(h.owner.operation('alpha', post.id)).toEqual(decided)
  })
})

describe('upload completions', () => {
  const F = 'F0UPLOAD1', F2 = 'F0UPLOAD2'
  /** A `files.completeUploadExternal` answer from the shared stub; result overrides its fields. */
  async function completion(result: Record<string, unknown>): Promise<unknown> {
    const slack = makeStubSlack()
    slack.script.completeUpload.push({ kind: 'ok', result })
    return slack.web.files.completeUploadExternal({ files: [{ id: F }], channel_id: C })
  }
  const shares = { public: { [C]: [{ ts: ROOT }] }, private: { [C2]: [{ ts: ROOT2 }] } }

  test.each([
    ['valid IDs, in response order', { files: [{ id: F2 }, { id: F }] }, [{ id: F2 }, { id: F }]],
    ['invalid and non-string IDs dropped', { files: [{ id: 'not-a-file-id' }, { id: 42 }, null, F2, { name: F2 }, { id: F }] }, [{ id: F }]],
    ['shares naming a root ignored', { files: [{ id: F, shares }, { id: F2, shares: 'not-an-object' }] }, [{ id: F }, { id: F2 }]],
    ['ok: false', { ok: false, error: 'invalid_file' }, []],
    ['no files', { files: undefined }, []],
    ['files not a list', { files: { id: F } }, []],
  ] as const)('a completion confirms only by file ID: %s', async (_label, result, expected) => {
    expect(completionFiles(await completion(result))).toEqual([...expected])
  })

  test.each([undefined, null, 'ok', [{ id: F }]])('a non-object answer %p confirms nothing', answer => {
    expect(completionFiles(answer)).toEqual([])
  })

  test('share data is never read, so a completion with shares confirms what one without them does', async () => {
    let reads = 0
    const shared = { id: F, get shares() { reads++; return shares } }
    const withShares = completionFiles(await completion({ files: [shared] }))
    expect(withShares).toEqual(completionFiles(await completion({})))
    expect(withShares).toEqual([{ id: F }])
    expect(reads).toBe(0)
  })

  test('a completion carrying the sentinel in its other fields gives back only file IDs', async () => {
    const read = completionFiles(await completion({ warning: LEAK_SENTINEL, response_metadata: { messages: [sentinelInMessage('completion')] },
      files: [{ id: F, name: LEAK_SENTINEL, title: LEAK_SENTINEL, url_private: sentinelInMessage('file'), shares }] }))
    expect(read).toEqual([{ id: F }])
    assertNoLeak(read)
  })
})
