/**
 * Own-post observer, per-call intents and joins through the real shared authority,
 * Thread Memory, delivery queue and membership readers.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DELIVERY_MODES, type ChannelMode } from '../src/config.ts'
import { createChannelDeliveryStore } from '../src/channel-delivery.ts'
import { completionFiles, createOwnPostJoins, createOwnPostObserver, fileShareRoot,
  ownPostAnswerOfError, ownPostAnswerOfPost, ownPostChoice, ownPostEligibility,
  type OwnPostAnswer, type OwnPostContent, type OwnPostEvent, type OwnPostOperation, type OwnPostOwner,
} from '../src/own-post.ts'
import { SHARED_CHANNEL_IDS, makeMembershipHarness, membershipPage } from './test-helpers/shared-channels.ts'
import { makeThreadMemoryHarness, readThreads, threadFsControls, threadPath, type ThreadHarnessOptions } from './test-helpers/thread-memory.ts'
import { makeQueue, slackInput } from './test-helpers/delivery-queue.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeStubSlack, slackPlatformError, slackRateLimited, slackHttpError, slackRequestError, slackAbortError } from './test-helpers/slack-stub.ts'
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
async function fixture(options: { mode?: ChannelMode; names?: string[]; sharedIdentity?: boolean; reopen?: string; memory?: ThreadHarnessOptions; start?: boolean } = {}) {
  const dir = options.reopen ?? mkdtempSync(join(tmpdir(), 'own-post-'))
  if (!options.reopen) cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const members = makeMembershipHarness(dir, { mode: options.mode ?? 'strict', names: options.names,
    channels: [{ id: C, delivery: 'thread_hybrid' }, { id: C2, delivery: 'thread_hybrid' }], reopen: !!options.reopen })
  if (options.sharedIdentity) {
    const alpha = members.h.stub(members.h.p('alpha')), beta = members.h.stub(members.h.p('beta'))
    Object.assign(beta.identity, alpha.identity)
    beta.script.botsInfo.push({ kind: 'ok', result: { bot: {
      id: alpha.identity.botId, user_id: alpha.identity.botUserId, app_id: alpha.identity.appId, deleted: false,
    } } })
  }
  const h = makeThreadMemoryHarness(dir, { ...options.memory, authority: members.authority, clock: members.h.clock })
  const queue = await makeQueue(dir, { now: h.clock.now, setInterval: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval })
  const choices = createChannelDeliveryStore(h.authority)
  const sources = { config: () => h.authority.config(), persona: (key: string) => h.authority.config().personas.find(p => p.key === key),
    choices: () => choices, membership: members.membership.read }
  // Snapshot reads when used: releasing an outcome, forgetting a persona or
  // settling a pending operation must not erase its earlier output from checks.
  const returned: unknown[] = []
  const capture = <T>(value: T): T => { returned.push(structuredClone(value)); return value }
  let dryRun = false, serial = 0
  const rawOwner = createOwnPostJoins({ memory: h.memory, lookupSlackKey: queue.lookupSlackKey,
    choice: ownPostChoice(sources), eligibility: ownPostEligibility(sources), now: h.clock.now,
    operationId: () => 'post-' + ++serial, isDryRun: () => dryRun })
  const owner = { ...rawOwner,
    pendingOwnPosts: (...args: Parameters<typeof rawOwner.pendingOwnPosts>) => capture(rawOwner.pendingOwnPosts(...args)),
    unknownOwnPosts: (...args: Parameters<typeof rawOwner.unknownOwnPosts>) => capture(rawOwner.unknownOwnPosts(...args)),
    operation: (...args: Parameters<typeof rawOwner.operation>) => capture(rawOwner.operation(...args)),
    awaitingUploads: (...args: Parameters<typeof rawOwner.awaitingUploads>) => capture(rawOwner.awaitingUploads(...args)),
    memoryOnlyJoins: (...args: Parameters<typeof rawOwner.memoryOnlyJoins>) => capture(rawOwner.memoryOnlyJoins(...args)),
    resolvedThreads: (...args: Parameters<typeof rawOwner.resolvedThreads>) => capture(rawOwner.resolvedThreads(...args)),
  }
  const memory = { ...h.memory,
    unresolvedIntents: (key: string) => capture(h.memory.unresolvedIntents(key)),
  }
  const observer = createOwnPostObserver(() => owner), events: OwnPostEvent[] = []
  owner.subscribe(event => { events.push(event) })
  const checkOutputs = () => assertNoLeak({
    membership: members.captured(), sharedWrites: members.writes, events, returned,
    threadMemory: { events: h.events, logs: h.logs, posts: h.posts, retryEvents: h.retryEvents, sealEvents: h.sealEvents },
    // These are output directories, across all personas, including quarantines.
    // The fixture root also holds credential inputs, which are not outputs.
    files: ['threads', 'queue'].map(name => join(dir, name)).filter(existsSync).map(writtenFile),
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { checkOutputs() } finally {
      try { owner.stop(); await queue.stop() } finally {
        try { await h.close() } finally {
          try { await members.close() } finally { checkOutputs() }
        }
      }
    }
  }
  cleanups.push(close)
  if (options.start !== false) {
    await h.start()
    for (const persona of h.authority.config().personas) members.h.stub(members.h.p(persona.key)).script.inventory.push(membershipPage([C, C2]))
    await members.start(); await members.scan()
  }
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
  const records = (key = 'alpha') => capture(existsSync(threadPath(dir, key)) ? readThreads(dir, key) : [])
  const pending = (key = 'alpha') => owner.pendingOwnPosts(key, C)
  const view = (root = ROOT, key = 'alpha') => capture(h.memory.view(key, C, root))
  const flush = () => h.clock.flush()
  return { ...h, memory, dir, members, choices, sources, queue, owner, observer, events, begin, scan, records, pending, view, flush, close,
    dryRun(value: boolean) { dryRun = value },
    stale() { expect(h.choose('off').kind).toBe('applied'); expect(h.choose('thread_hybrid').kind).toBe('applied') },
    undecided() { members.unsyncWrites(() => true); expect(h.mode(h.authority.config().channel_mode === 'strict' ? 'open' : 'strict').kind).toBe('unresolved') },
    decideStamp() { members.unsyncWrites(() => false); expect(h.authority.recoverDurability().kind).toBe('applied') },
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function savedOutcome(h: Fixture, id: string, expected: 'joined' | 'none', key = 'alpha') {
  await h.flush()
  expect(h.records(key).filter(r => r.kind === 'post-outcome' && r.operationId === id)).toMatchObject([{ outcome: expected }])
  expect(h.memory.unresolvedIntents(key).some(r => r.operationId === id)).toBe(false)
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
    expect(h.events.at(-1)).toMatchObject({ type: 'decided', lookup })
    expect(h.owner.resolvedThreads('alpha', C)).toEqual(new Set())
    expect(h.records().filter(r => r.kind === 'post-outcome')).toEqual([])
    h.decideStamp(); h.owner.settleDeferred('alpha', C)
    expect(h.view()).toBe('joined')
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', lookup })
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
    expect(h.events.at(-1)).toMatchObject({ type: 'decided' })
    expect(h.events.at(-1)).not.toHaveProperty('lookup')
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
    h.observer.end(post.operation, { kind: 'confirmed', channel: C, file: 'F0UPLOAD1' })
    expect(h.owner.awaitingUploads('alpha', C)).toMatchObject([{ operationId: post.id, file: 'F0UPLOAD1', state: 'awaiting-thread' }])
    h.owner.learnUploadThread('alpha', 'missing', ROOT)
    h.owner.learnUploadThread('alpha', post.id, 'invalid')
    expect(h.view()).toBe('not-joined')
    h.owner.learnUploadThread('alpha', post.id, ROOT)
    expect(h.view()).toBe('joined'); expect(h.owner.awaitingUploads('alpha', C)).toHaveLength(0)
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', outcome: { kind: 'confirmed', thread: ROOT, joined: true } })
    releaseA(); releaseA(); expect(h.owner.operation('alpha', post.id)).toBeDefined()
    releaseB(); expect(h.owner.operation('alpha', post.id)).toBeUndefined()
    await savedOutcome(h, post.id, 'joined')
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
})

describe('upload completions', () => {
  const F = 'F0UPLOAD1'
  const file = (shares: Array<{ ts: string; thread_ts?: string }>, channel: string = C, visibility: 'public' | 'private' = 'public') =>
    ({ id: F, created: 1_700_000_000, shares: { [visibility]: { [channel]: shares } } })

  test('a new upload root is its file\'s earliest share in the exact channel; IDs, creation times, other channels and re-shares name nothing', () => {
    expect(fileShareRoot(file([{ ts: ROOT2 }, { ts: ROOT }]), C)).toEqual({ kind: 'root', root: ROOT })
    expect(fileShareRoot(file([{ ts: ROOT }], C, 'private'), C)).toEqual({ kind: 'root', root: ROOT })
    expect(fileShareRoot(file([{ ts: ROOT }], C2), C)).toEqual({ kind: 'unresolved', reason: 'no-share' })
    expect(fileShareRoot(file([{ ts: ROOT2, thread_ts: ROOT }]), C)).toEqual({ kind: 'unresolved', reason: 'ambiguous' })
    expect(fileShareRoot({ id: F, created: 1_700_000_000, timestamp: 1_700_000_000 }, C)).toEqual({ kind: 'unresolved', reason: 'no-share' })
    expect(fileShareRoot({ id: F, shares: { public: { [C]: 'not-a-list' } } }, C)).toEqual({ kind: 'unresolved', reason: 'malformed' })
    expect(completionFiles({ ok: true, files: [file([{ ts: ROOT }]), { id: 'not-a-file-id' }] }, C)).toEqual([{ id: F, root: ROOT }])
    // A parent upload needs no share; an aggregate that is not ok confirms nothing.
    expect(completionFiles({ ok: true, files: [file([{ ts: ROOT }])] }, C, ROOT2)).toEqual([{ id: F }])
    expect(completionFiles({ ok: false, files: [file([{ ts: ROOT }])] }, C)).toEqual([])
    expect(completionFiles({ ok: true, files: [{ id: F, created: 1_700_000_000 }] }, C)).toEqual([{ id: F }])
  })

  test('a completion carrying the sentinel in its other fields gives back only file IDs and roots', () => {
    const response = { ok: true, warning: LEAK_SENTINEL, response_metadata: { messages: [sentinelInMessage('completion')] },
      files: [{ ...file([{ ts: ROOT, text: LEAK_SENTINEL } as { ts: string }]), name: LEAK_SENTINEL, url_private: sentinelInMessage('file') }] }
    const read = { files: completionFiles(response, C), root: fileShareRoot(response.files[0], C) }
    expect(read).toEqual({ files: [{ id: F, root: ROOT }], root: { kind: 'root', root: ROOT } })
    assertNoLeak(read)
  })
})
