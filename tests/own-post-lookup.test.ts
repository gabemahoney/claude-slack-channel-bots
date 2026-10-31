/** Own-post recovery through real owners, journals, stamps and bounded Slack clients. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyOwnPostLookupFailure, createOwnPostLookups, judgeOwnPostLookup, OWN_POST_LOOKUP_PAGE_LIMIT,
  ownPostLookupRange, ownPostLookupRequest, readOwnPostLookupPage,
  type OwnPostLookupEvent, type OwnPostLookupsDeps,
} from '../src/own-post-lookup.ts'
import { ownPostStampState, type OwnPostContent } from '../src/own-post.ts'
import { ownPostDigest, metadataRetryDelay, MetadataCancelledError, type MetadataFailure } from '../src/thread-memory.ts'
import { OWN_ROOT_CLOCK_SKEW_MS, THREAD_MEMORY_LOOKUP_DEADLINE_MS, THREAD_MEMORY_RETRY_MAX_MS } from '../src/delivery-constants.ts'
import { MAX_TIMER_DELAY_MS } from '../src/persona-retry-schedule.ts'
import { createPersonaUpPredicate } from '../src/persona-start.ts'
import { OWN_POST_UPLOAD_FILENAME } from '../src/registry.ts'
import { makeOwnPostHarness } from './test-helpers/own-post.ts'
import { THREAD_TIME, threadFsControls } from './test-helpers/thread-memory.ts'
import { SHARED_CHANNEL_IDS, membershipPage } from './test-helpers/shared-channels.ts'
import { assertNoLeak, LEAK_SENTINEL } from './test-helpers/credentials.ts'
import {
  makePagedThread, makeStubSlack, makeDeferredWebApiCall,
  type PagedMessageSpec, type PagedPageDamage, type PagedThreadOptions, type WebApiOutcome,
} from './test-helpers/slack-stub.ts'

const C = SHARED_CHANNEL_IDS.primary
const ROOT = (THREAD_TIME / 1000).toFixed(6)
const IDENTITY = { botUserId: 'U0LOOKUP', botId: 'B0LOOKUP' }
const TEXT = `content ${LEAK_SENTINEL}`
const CONTENT: OwnPostContent = { kind: 'text', text: TEXT }
const DIGEST_KEY = 'ab'.repeat(32)
const seconds = (ms: number) => (ms / 1000).toFixed(6)
const cleanups: Array<() => Promise<void>> = [], directories: string[] = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (errors.length) throw new AggregateError(errors, 'lookup cleanup failed')
})

async function rawPage(specs: PagedMessageSpec[], parent = false, damage?: PagedPageDamage) {
  const history = makePagedThread(specs.length || 1, { rootTs: ROOT, identity: IDENTITY, message: i => specs[i] ?? { author: 'other-user' } })
  const stub = makeStubSlack({ ...IDENTITY, leakMarker: LEAK_SENTINEL,
    history: [damage ? history.malformedOutcome(damage) : history.legacyOutcome('history')] })
  const response = await stub.web.conversations.history({ channel: C })
  const result = readOwnPostLookupPage(response, { target: { channel: C, ...(parent ? { parent: ROOT } : {}) },
    range: ownPostLookupRange(THREAD_TIME, THREAD_TIME), identity: IDENTITY, digestKey: DIGEST_KEY })
  assertNoLeak(result)
  return result
}

describe('lookup pure contracts', () => {
  test.each([0, OWN_ROOT_CLOCK_SKEW_MS - 1, THREAD_TIME])('range clamps issue time %s and uses the supplied end', issue => {
    const end = issue + THREAD_MEMORY_LOOKUP_DEADLINE_MS, result = ownPostLookupRange(issue, end)
    expect(result).toEqual({ oldest: seconds(Math.max(0, issue - OWN_ROOT_CLOCK_SKEW_MS)), latest: seconds(end + OWN_ROOT_CLOCK_SKEW_MS) })
    assertNoLeak(result)
  })

  test.each([false, true])('request uses parent=%s and passes an opaque cursor unchanged', parent => {
    const range = ownPostLookupRange(THREAD_TIME, THREAD_TIME), cursor = 'page/+opaque= value'
    const target = { channel: C, ...(parent ? { parent: ROOT } : {}) }
    for (const token of [undefined, cursor]) {
      const request = ownPostLookupRequest(target, range, token)
      expect(request).toEqual({ method: parent ? 'conversations.replies' : 'conversations.history', args: {
        channel: C, ...(parent ? { ts: ROOT } : {}), ...range, inclusive: true, limit: OWN_POST_LOOKUP_PAGE_LIMIT,
        ...(token === undefined ? {} : { cursor: token }),
      } })
      assertNoLeak(request)
    }
  })

  test.each([false, true])('page reading independently filters ownership, timestamps and parent=%s', async parent => {
    const low = THREAD_TIME - OWN_ROOT_CLOCK_SKEW_MS, high = THREAD_TIME + OWN_ROOT_CLOCK_SKEW_MS
    const placement = parent ? 'reply' : 'channel'
    const specs: PagedMessageSpec[] = [
      { author: 'own-user', placement, ts: seconds(low), text: TEXT },
      { author: 'own-bot', placement, ts: seconds(high), text: TEXT },
      { author: 'other-user', placement, text: TEXT }, { author: 'other-bot', placement, text: TEXT },
      { author: 'own-user', placement, ts: seconds(low - 1), text: TEXT },
      { author: 'own-bot', placement, ts: seconds(high + 1), text: TEXT },
      { author: 'own-user', placement: parent ? 'root' : 'reply', text: TEXT },
      { author: 'own-bot', placement: parent ? 'root' : 'broadcast', text: TEXT },
    ]
    if (parent) specs.push({ author: 'own-user', placement: 'reply', ts: ROOT, text: TEXT })
    const result = await rawPage(specs, parent)
    expect(result.kind).toBe('page')
    if (result.kind !== 'page') throw new Error('expected page')
    expect(result.own.map(m => m.ts)).toEqual([seconds(high), seconds(low)])
    expect(result.nextCursor).toBeUndefined()
  })

  test.each([
    ['escapes', `  ${LEAK_SENTINEL} &amp; a &lt; b &gt; c  `, `${LEAK_SENTINEL} & a < b > c`],
    ['target', `${LEAK_SENTINEL} <https://example.invalid/path>`, `${LEAK_SENTINEL} https://example.invalid/path`],
    ['label', `\n${LEAK_SENTINEL} <https://example.invalid/path|label>\t`, `${LEAK_SENTINEL} https://example.invalid/path`],
  ])('%s normalizes identically to the stored intent without keeping content', async (_name, posted, original) => {
    const result = await rawPage([{ author: 'own-user', placement: 'channel', text: posted, file: false }])
    expect(result).toEqual({ kind: 'page', own: [{ ts: ROOT, digests: [ownPostDigest(DIGEST_KEY, { kind: 'text', text: original! })] }] })
  })

  test.each([OWN_POST_UPLOAD_FILENAME, `${LEAK_SENTINEL}.txt`])('file digest uses exact name and bytes: %s', async name => {
    const size = 123, result = await rawPage([{ author: 'own-bot', placement: 'root', text: TEXT, file: { name, size } }])
    expect(result.kind).toBe('page')
    if (result.kind !== 'page') throw new Error('expected page')
    const digests = result.own[0]!.digests
    expect(digests).toEqual([ownPostDigest(DIGEST_KEY, CONTENT), ownPostDigest(DIGEST_KEY, { kind: 'file', name, size })])
    expect(digests[0]).not.toBe(digests[1])
    expect(digests).not.toContain(ownPostDigest(DIGEST_KEY, { kind: 'file', name, size: size + 1 }))
    expect(digests).not.toContain(ownPostDigest(DIGEST_KEY, { kind: 'file', name: `${name}.other`, size }))
    expect(digests).not.toContain(ownPostDigest(DIGEST_KEY, { kind: 'text', text: `${TEXT} other` }))
  })

  test.each(['absent', 'invalid'] as const)('a counted message with %s timestamp is malformed', async invalidTimestamp => {
    expect(await rawPage([{ author: 'own-user', placement: 'channel', invalidTimestamp, text: TEXT }])).toEqual({ kind: 'malformed' })
  })

  test.each(['messages-absent', 'messages-object', 'cursor-number', 'metadata-array', 'not-ok'] as const)('%s page is malformed', async damage => {
    expect(await rawPage([{ author: 'own-user', text: TEXT }], false, damage)).toEqual({ kind: 'malformed' })
  })

  test.each([null, undefined, [], 'not an object'].map(value => ({ value })))('non-response %j is malformed', ({ value: response }) => {
    const result = readOwnPostLookupPage(response, { target: { channel: C }, range: ownPostLookupRange(THREAD_TIME, THREAD_TIME), identity: IDENTITY, digestKey: DIGEST_KEY })
    expect(result).toEqual({ kind: 'malformed' }); assertNoLeak(result)
  })

  const failureRows: Array<[MetadataFailure, ReturnType<typeof classifyOwnPostLookupFailure>]> = [
    [{ kind: 'deadline' }, { kind: 'retry' }], [{ kind: 'transient' }, { kind: 'retry' }],
    [{ kind: 'transient', retryAfter: 23 }, { kind: 'retry', retryAfter: 23 }], [{ kind: 'cancelled' }, { kind: 'wait' }],
    [{ kind: 'capability', slackError: 'missing_scope' }, { kind: 'lost', code: 'missing_scope' }],
    [{ kind: 'credentials', slackError: 'invalid_auth' }, { kind: 'lost', code: 'invalid_auth' }],
    [{ kind: 'access-lost', slackError: 'not_in_channel' }, { kind: 'lost', code: 'not_in_channel' }],
    [{ kind: 'not-found', slackError: 'channel_not_found' }, { kind: 'lost', code: 'channel_not_found' }],
    [{ kind: 'rejected' }, { kind: 'lost', code: 'rejected' }], [{ kind: 'malformed' }, { kind: 'lost', code: 'malformed' }],
    [{ kind: 'rejected', slackError: `unsafe ${LEAK_SENTINEL}` }, { kind: 'lost', code: 'rejected' }],
  ]
  test.each(failureRows)('classifies %j without leaking its input', (failure, expected) => {
    for (const parent of [false, true]) {
      const result = classifyOwnPostLookupFailure(failure, parent)
      expect(result).toEqual(expected); assertNoLeak(result)
    }
  })
  test.each(['thread_not_found', 'message_not_found'])('%s closes only a parent lookup', slackError => {
    for (const parent of [false, true]) {
      const result = classifyOwnPostLookupFailure({ kind: 'not-found', slackError }, parent)
      expect(result).toEqual(parent ? { kind: 'close' } : { kind: 'lost', code: slackError }); assertNoLeak(result)
    }
  })

  test.each([
    ['empty', false, [], [], { kind: 'none', holds: 'failed' }],
    ['one', false, ['match'], [], { kind: 'found', holds: 'thread' }],
    ['joined root only', false, ['match'], [0], { kind: 'none', holds: 'none' }],
    ['resolved root only', false, ['other'], [0], { kind: 'none', holds: 'none' }],
    ['one beside excluded', false, ['match', 'match'], [0], { kind: 'found', holds: 'none' }],
    ['several', false, ['match', 'match'], [], { kind: 'lost', reason: 'several', holds: 'none' }],
    ['unmatched', false, ['other', 'other'], [], { kind: 'lost', reason: 'unmatched', holds: 'none' }],
    ['parent ignores exclusion', true, ['match'], [0], { kind: 'found', holds: 'thread' }],
    ['several replies one thread', true, ['match', 'match'], [], { kind: 'lost', reason: 'several', holds: 'none' }],
    ['unmatched replies one thread', true, ['other', 'other'], [], { kind: 'lost', reason: 'unmatched', holds: 'none' }],
  ] as const)('judges %s with the holds verdict and unique thread names', async (_name, parent, texts, excluded, expected) => {
    const read = await rawPage(texts.map((text, i) => ({ author: 'own-user', placement: parent ? 'reply' : 'channel',
      ts: seconds(THREAD_TIME + i + 1), text: text === 'match' ? TEXT : `${TEXT} other` })), parent)
    if (read.kind !== 'page') throw new Error('expected page')
    const own = texts.length ? read.own : []
    const excludedTs = excluded.map(i => seconds(THREAD_TIME + i + 1))
    const result = judgeOwnPostLookup({ digest: ownPostDigest(DIGEST_KEY, CONTENT), hasParent: parent, own,
      leftOut: ts => excludedTs.includes(ts) })
    expect(result).toMatchObject(expected)
    if (result.kind === 'found') expect(result.ts).toBe(own.find(m => parent || !excludedTs.includes(m.ts))!.ts)
    if (result.kind === 'lost') expect(result.threads).toEqual(parent ? [ROOT] : own.map(m => m.ts))
    assertNoLeak(result)
  })

  test('a message repeated on cursor pages is one candidate', async () => {
    const read = await rawPage([{ author: 'own-user', placement: 'channel', text: TEXT }])
    if (read.kind !== 'page') throw new Error('expected page')
    const result = judgeOwnPostLookup({ digest: ownPostDigest(DIGEST_KEY, CONTENT), hasParent: false,
      own: [...read.own, ...read.own], leftOut: () => false })
    expect(result).toEqual({ kind: 'found', ts: ROOT, holds: 'thread' }); assertNoLeak(result)
  })
})

async function fixture(options: { dir?: string; unreadable?: boolean; names?: string[]; reopen?: boolean } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'own-post-lookup-'))
  if (!options.dir) directories.push(dir)
  const io = threadFsControls(dir)
  if (options.unreadable) io.fail('readFileSync')
  const h = await makeOwnPostHarness(dir, { membership: { names: options.names, reopen: options.reopen }, memory: { fs: io, reopen: options.reopen } })
  const manager = h.members.h.manager
  const events: OwnPostLookupEvent[] = [], recorded: Parameters<typeof h.owner.recordLookup>[] = []
  const readings: Array<{ key: string; at: number; value: number }> = []
  const connections: OwnPostLookupsDeps['connections'] = {
    metadataCall: (...args) => manager.metadataCall(...args), identity: key => manager.identity(key),
    isUp: createPersonaUpPredicate(manager, { isUp: () => true,
      isApplied: key => h.authority.config().personas.some(persona => persona.key === key) }),
    currentConnectionId: key => manager.provenance(key)?.connectionId,
  }
  const deps: OwnPostLookupsDeps = { owner: { ...h.owner, recordLookup(...args) { recorded.push(structuredClone(args)); h.owner.recordLookup(...args) } },
    memory: { ...h.memory, clock(key) { const value = h.memory.clock(key); readings.push({ key, at: h.clock.now(), value }); return value } },
    stamp: (key, channel, stamp) => ownPostStampState(h.memory, key, channel, stamp), connections, clock: h.clock,
    onEvent: event => { events.push(event) },
  }
  const runner = createOwnPostLookups(deps)
  let closed = false
  async function close() {
    if (closed) return
    closed = true
    runner.stop()
    try { assertNoLeak({ events, recorded, captured: h.captured(), records: h.records() }) }
    finally { await h.close(); expect(h.clock.pendingCount()).toBe(0) }
  }
  cleanups.push(close)
  const stub = (key = 'alpha') => h.members.h.stub(h.members.h.p(key))
  function pages(count = 1, opts: PagedThreadOptions = {}, key = 'alpha') {
    const data = makePagedThread(count, { rootTs: ROOT, channel: C, identity: stub(key).identity,
      message: (): PagedMessageSpec => ({ author: 'own-user', placement: 'channel', text: TEXT }), ...opts })
    stub(key).responders.history = data.respondHistory
    stub(key).responders.replies = data.respondReplies
    return data
  }
  async function begin(parent?: string, key = 'alpha', content = CONTENT) {
    const started = h.observer.start(key, content.kind === 'file' ? 'file' : 'text', { channel: C, ...(parent ? { parent } : {}) }, content)
    expect(started).toBeDefined()
    const event = h.events.at(-1)!
    expect(event.type).toBe('registered')
    const id = event.operationId
    h.owner.retainOutcomes(key, [id])
    await started!.ready
    return { ...started!, id, key, issuedAt: h.owner.operation(key, id)!.issuedAt }
  }
  const unknown = (post: Awaited<ReturnType<typeof begin>>) => h.observer.end(post.operation, { kind: 'no-answer' })
  const calls = (key = 'alpha') => stub(key).callLog.filter(call => call.method === 'conversations.history' || call.method === 'conversations.replies')
  async function saved(id: string, outcome: 'joined' | 'none', key = 'alpha') {
    await h.memory.flush(key)
    expect(h.records(key).filter(r => r.kind === 'post-outcome' && r.operationId === id)).toMatchObject([{ outcome }])
    expect(h.records(key).filter(r => r.kind === 'post-outcome' && r.operationId === id)).toHaveLength(1)
  }
  function undecided() {
    h.members.unsyncWrites(() => true)
    expect(h.threads.mode(h.authority.config().channel_mode === 'strict' ? 'open' : 'strict').kind).toBe('unresolved')
    expect(h.authority.channelStamp('alpha', C)).toEqual({ kind: 'undecided' })
  }
  function decide() {
    h.members.unsyncWrites(() => false)
    expect(h.authority.recoverDurability().kind).toBe('applied')
  }
  function stale() {
    expect(h.threads.choose('off').kind).toBe('applied')
    expect(h.threads.choose('thread_hybrid').kind).toBe('applied')
  }
  return { ...h, dir, runner, deps, connections, recorded, lookupEvents: events, readings, pages, stub, calls, begin, unknown, saved, undecided, decide, stale, close }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
async function retryAfter(h: Fixture, delay: number, before = h.calls().length) {
  expect(h.clock.pending()).toMatchObject([{ delayMs: Math.min(delay, MAX_TIMER_DELAY_MS) }])
  expect(h.clock.pendingCount()).toBe(1)
  await h.clock.advance(delay - 1)
  expect(h.calls()).toHaveLength(before)
  await h.clock.advance(1)
}

describe('lookup runner', () => {
  test.each([false, true])('reads every page with a fixed settlement range, parent=%s', async parent => {
    const h = await fixture(), count = OWN_POST_LOOKUP_PAGE_LIMIT * 2 + 5
    const data = h.pages(count, { repeatRoot: true, pageSizes: [OWN_POST_LOOKUP_PAGE_LIMIT, 1], message: i => ({
      author: i === (parent ? count - 1 : 0) ? 'own-user' : 'other-user', placement: parent ? 'reply' : 'channel', text: TEXT,
    }) })
    const post = await h.begin(parent ? data.rootTs : undefined)
    await h.clock.advance(37)
    const settledAt = h.clock.now(); h.unknown(post)
    expect(h.readings).toHaveLength(1); expect(h.readings[0]!.at).toBe(settledAt)
    await h.clock.flush()
    const range = ownPostLookupRange(post.issuedAt, h.readings[0]!.value), calls = h.calls()
    expect(calls.length).toBeGreaterThan(2)
    expect(calls.map(c => c.method)).toEqual(calls.map(() => parent ? 'conversations.replies' : 'conversations.history'))
    for (const [i, call] of calls.entries()) {
      expect(call.args).toEqual({ channel: C, ...(parent ? { ts: data.rootTs } : {}), ...range,
        inclusive: true, limit: OWN_POST_LOOKUP_PAGE_LIMIT,
        ...(i ? { cursor: data.responses[i - 1]!.response_metadata!.next_cursor } : {}),
      })
    }
    expect(h.readings).toHaveLength(1)
    const root = parent ? data.rootTs : data.messages[0]!.ts!
    expect(h.view('alpha', C, root)).toBe('joined')
    expect(h.owner.operation('alpha', post.id)?.lookup).toEqual({ holds: 'thread', thread: root })
    expect(h.lookupEvents).toEqual([]); await h.saved(post.id, 'joined')
  })

  test.each(['none', 'one', 'several', 'unmatched', 'joined-only', 'resolved-only', 'one-excluded'] as const)('records the %s outcome and holds', async kind => {
    const h = await fixture(), count = kind === 'several' || kind === 'one-excluded' ? 2 : 1
    const data = h.pages(count, { message: () => ({ author: kind === 'none' ? 'other-user' : 'own-user', placement: 'channel',
      text: kind === 'unmatched' ? `${TEXT} different` : TEXT }) })
    if (kind === 'joined-only' || kind === 'one-excluded') h.memory.addJoin('alpha', h.threads.fact({ root: data.messages[0]!.ts! }))
    if (kind === 'resolved-only') {
      const earlier = await h.begin()
      // A confirmation of a stale stamp learns its thread without making a current join.
      h.stale()
      h.observer.end(earlier.operation, { kind: 'confirmed', channel: C, ts: data.messages[0]!.ts! })
      expect(h.view('alpha', C, data.messages[0]!.ts!)).toBe('not-joined')
    }
    const post = await h.begin(); h.unknown(post); await h.clock.flush()
    const found = kind === 'one' || kind === 'one-excluded'
    const root = data.messages[kind === 'one-excluded' ? 1 : 0]!.ts!
    const holds = kind === 'none' ? 'failed' : kind === 'one' ? 'thread' : 'none'
    expect(h.owner.operation('alpha', post.id)?.lookup).toEqual(holds === 'thread' ? { holds, thread: root } : { holds })
    expect(h.recorded.at(-1)).toEqual(['alpha', post.id, found
      ? { found: { ts: root }, holds: kind === 'one' ? 'thread' : 'none' }
      : { notFound: true, holds: kind === 'none' ? 'failed' : 'none' }])
    expect(h.lookupEvents).toEqual(kind === 'several' || kind === 'unmatched'
      ? [{ kind: 'joins-lost', key: 'alpha', channel: C, cause: kind, threads: [...data.messages].reverse().map(m => m.ts!) }] : [])
    if (found) expect(h.view('alpha', C, root)).toBe('joined')
    await h.saved(post.id, found ? 'joined' : 'none')
    h.runner.kick('alpha'); await h.clock.flush(); expect(h.recorded.filter(r => r[1] === post.id)).toHaveLength(1)
  })

  test.each([
    ['missing_scope', 'missing_scope'], ['invalid_auth', 'invalid_auth'], ['not_in_channel', 'not_in_channel'],
    ['is_archived', 'is_archived'], ['channel_not_found', 'channel_not_found'], ['thread_not_found', 'thread_not_found'],
    ['message_not_found', 'message_not_found'], ['unrecognized_failure', 'unrecognized_failure'],
  ])('permanent %s closes and reports once on the real manager', async (error, cause) => {
    const h = await fixture(); h.pages(1, { pageOutcomes: { 0: [{ kind: 'platform', error }] } })
    const post = await h.begin(); h.unknown(post); await h.clock.flush()
    expect(h.recorded).toEqual([['alpha', post.id, { notFound: true, holds: 'none' }]])
    expect(h.lookupEvents).toEqual([{ kind: 'joins-lost', key: 'alpha', channel: C, threads: [], cause }])
    if (error === 'invalid_auth') {
      expect(h.members.h.manager.provenance('alpha')).toBeUndefined()
      expect(h.stub().socket.disconnectCalls).toBeGreaterThan(0)
    }
    await h.saved(post.id, 'none')
    h.runner.kick('alpha'); await h.clock.flush(); expect(h.lookupEvents).toHaveLength(1)
  })

  test.each(['thread_not_found', 'message_not_found'])('%s with parent closes silently and never fails holds', async error => {
    const h = await fixture(); h.pages(1, { pageOutcomes: { 0: [{ kind: 'platform', error }] } })
    const post = await h.begin(ROOT); h.unknown(post); await h.clock.flush()
    expect(h.recorded).toEqual([['alpha', post.id, { notFound: true, holds: 'none' }]])
    expect(h.lookupEvents).toEqual([]); await h.saved(post.id, 'none')
  })

  test.each(['messages-absent', 'cursor-number', 'reject'] as const)('%s closes with a safe loss cause', async kind => {
    const h = await fixture(), data = h.pages()
    h.stub().script.history.push(kind === 'reject' ? { kind: 'http', status: 403 } : data.malformedOutcome(kind))
    const post = await h.begin(); h.unknown(post); await h.clock.flush()
    expect(h.recorded).toEqual([['alpha', post.id, { notFound: true, holds: 'none' }]])
    expect(h.lookupEvents).toEqual([{ kind: 'joins-lost', key: 'alpha', channel: C, threads: [], cause: kind === 'reject' ? 'rejected' : 'malformed' }])
    await h.saved(post.id, 'none')
  })

  test.each(['network', 'dns', 'timeout', 'http', 'rate-limited'] as const)('%s retries the same page, never early or after a shorter repeated kick', async kind => {
    const h = await fixture()
    const large = metadataRetryDelay(3) / 1000, small = metadataRetryDelay(1) / 2000
    const first: WebApiOutcome = kind === 'http' ? { kind, status: 503 } : kind === 'rate-limited' ? { kind, retryAfter: large } : { kind }
    h.pages(2, { pageSizes: [1], message: i => ({ author: i ? 'other-user' : 'own-user', placement: 'channel', text: TEXT }),
      pageOutcomes: { 0: [first, { kind: 'rate-limited', retryAfter: small }], 1: [{ kind: 'network' }] } })
    const post = await h.begin(); h.unknown(post); await h.clock.flush()
    expect(h.calls()).toHaveLength(1)
    const firstArgs = h.calls()[0]!.args
    const delay = metadataRetryDelay(1, kind === 'rate-limited' ? large : undefined)
    for (let i = 0; i < 3; i++) h.runner.kick('alpha')
    await h.clock.flush(); await retryAfter(h, delay)
    expect(h.calls()).toHaveLength(2); expect(h.calls()[1]!.args).toEqual(firstArgs)
    await retryAfter(h, metadataRetryDelay(2, small))
    expect(h.calls()).toHaveLength(4) // first page succeeded, second page failed
    expect(h.calls()[2]!.args).toEqual(firstArgs)
    const secondArgs = h.calls()[3]!.args
    expect(secondArgs).toMatchObject({ cursor: expect.any(String) })
    expect(secondArgs).not.toEqual(firstArgs)
    await retryAfter(h, metadataRetryDelay(1)) // a successful page reset the series
    expect(h.calls()).toHaveLength(5); expect(h.calls()[4]!.args).toEqual(secondArgs)
    expect(h.readings).toHaveLength(1)
    expect(h.view('alpha', C, ROOT)).toBe('joined'); await h.saved(post.id, 'joined')
  })

  test('keeps retrying after spacing reaches its cap, with no overall deadline', async () => {
    const h = await fixture(), failures = 12
    h.pages(1, { pageOutcomes: { 0: Array.from({ length: failures }, () => ({ kind: 'network' })) } })
    const post = await h.begin(); h.unknown(post); await h.clock.flush()
    const start = h.clock.now()
    for (let i = 1; i <= failures; i++) {
      expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
      await retryAfter(h, metadataRetryDelay(i))
      expect(h.calls()).toHaveLength(i + 1)
    }
    expect(h.clock.now() - start).toBeGreaterThan(THREAD_MEMORY_RETRY_MAX_MS * 5)
    expect(h.readings).toHaveLength(1); await h.saved(post.id, 'joined')
  })

  test('Retry-After beyond the timer maximum is chained to the exact deadline', async () => {
    const h = await fixture(), delay = MAX_TIMER_DELAY_MS * 2 + metadataRetryDelay(1)
    h.pages(1, { pageOutcomes: { 0: [{ kind: 'rate-limited', retryAfter: delay / 1000 }] } })
    const post = await h.begin(); h.unknown(post); await h.clock.flush()
    const deadline = h.clock.now() + delay
    while (h.clock.now() + MAX_TIMER_DELAY_MS < deadline) {
      expect(h.clock.pendingCount()).toBe(1)
      expect(h.clock.pending()[0]!.delayMs).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
      expect(h.calls()).toHaveLength(1)
      await h.clock.runNext()
    }
    await retryAfter(h, deadline - h.clock.now())
    expect(h.clock.now()).toBe(deadline); expect(h.calls()).toHaveLength(2)
    expect(h.calls()[1]!.args).toEqual(h.calls()[0]!.args)
    await h.saved(post.id, 'joined')
  })

  test.each(['never', 'deferred'] as const)('a %s page ends at the attempt deadline; any late answer changes nothing', async kind => {
    const h = await fixture(), delayed = makeDeferredWebApiCall()
    h.pages(1, { pageOutcomes: { 0: [kind === 'never' ? { kind } : delayed.outcome] } })
    const post = await h.begin(); h.unknown(post); await h.clock.flush()
    expect(h.clock.pending()).toMatchObject([{ delayMs: THREAD_MEMORY_LOOKUP_DEADLINE_MS }])
    await h.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS - 1)
    expect(h.recorded).toEqual([]); expect(h.calls()).toHaveLength(1)
    await h.clock.advance(1)
    expect(h.clock.pending()).toMatchObject([{ delayMs: metadataRetryDelay(1) }])
    if (kind === 'deferred') {
      delayed.settle(); await h.clock.flush()
      expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
      expect(h.owner.resolvedThreads('alpha', C).size).toBe(0)
    }
    await retryAfter(h, metadataRetryDelay(1))
    expect(h.calls()).toHaveLength(2); expect(h.calls()[1]!.args).toEqual(h.calls()[0]!.args)
    await h.saved(post.id, 'joined')
  })

  test.each(['live', 'recovered'] as const)('%s unreadable intent captures at the successful read before delayed recovery, fixed across pages and retries', async origin => {
    const first = await fixture()
    const old = origin === 'recovered' ? await first.begin() : undefined
    await first.close() // persisted intent, with no completion for the recovered case
    const h = await fixture({ dir: first.dir, reopen: true, unreadable: true })
    expect(h.memory.store('alpha')?.readable).toBe(false)
    let post = old
    if (!post) { post = await h.begin(); h.unknown(post) }
    h.runner.kick('alpha'); h.runner.journalRead('alpha'); await h.clock.flush()
    expect(h.readings).toEqual([]); expect(h.calls()).toEqual([])
    await h.clock.advance(OWN_ROOT_CLOCK_SKEW_MS * 2)
    const readAt = h.clock.now(), candidateTs = seconds(readAt - 1)
    const data = h.pages(3, { rootTs: candidateTs, pageSizes: [1, 1, 1], message: i => ({
      author: i === 0 ? 'own-user' : 'other-user', placement: 'channel', text: TEXT,
    }), pageOutcomes: { 1: [{ kind: 'network' }] } })
    h.io.heal()
    expect(await h.memory.retryRead('alpha')).toBe('read')
    h.runner.journalRead('alpha') // exact production completion boundary, before other awaits
    expect(h.readings).toHaveLength(1); expect(h.readings[0]!.at).toBe(readAt)
    expect(h.calls()).toEqual([])
    await h.clock.advance(OWN_ROOT_CLOCK_SKEW_MS * 3) // hold resolution/flush can take time
    h.runner.journalRead('alpha') // later notifications cannot move the captured end
    h.memory.retryPendingJoins('alpha'); await h.memory.flush('alpha')
    h.runner.kick('alpha'); await h.clock.flush()
    expect(h.calls()).toHaveLength(2)
    const range = ownPostLookupRange(post.issuedAt, h.readings[0]!.value)
    for (const call of h.calls()) expect(call.args).toMatchObject(range)
    expect(Number(range.latest)).toBeLessThan(h.clock.now() / 1000)
    await retryAfter(h, metadataRetryDelay(1))
    expect(h.calls()).toHaveLength(4)
    for (const call of h.calls()) expect(call.args).toMatchObject(range)
    expect(h.readings).toHaveLength(1); expect(h.view('alpha', C, data.messages[0]!.ts!)).toBe('joined')
    expect(h.recorded).toHaveLength(1); await h.saved(post.id, 'joined')
    h.runner.kick('alpha'); await h.clock.flush(); expect(h.recorded).toHaveLength(1)
  })

  test('a readable recovered intent captures the first read and survives a delayed first kick', async () => {
    const first = await fixture(), post = await first.begin()
    await first.close()
    const h = await fixture({ dir: first.dir, reopen: true }); h.pages()
    h.runner.journalRead('alpha')
    const end = h.readings[0]!.value
    expect(h.calls()).toEqual([])
    await h.clock.advance(OWN_ROOT_CLOCK_SKEW_MS * 2)
    h.runner.kick('alpha'); await h.clock.flush()
    expect(h.calls()).toHaveLength(1)
    expect(h.calls()[0]!.args).toMatchObject(ownPostLookupRange(post.issuedAt, end))
    expect(h.view('alpha', C, ROOT)).toBe('joined'); await h.saved(post.id, 'joined')
  })

  test('a disconnected persona waits for a connected kick without counting a failure', async () => {
    const h = await fixture(); h.pages(1, { pageOutcomes: { 0: [{ kind: 'network' }] } })
    const post = await h.begin()
    await h.members.h.manager.stop('alpha')
    const settledAt = h.clock.now(); h.unknown(post); await h.clock.flush()
    expect(h.readings).toHaveLength(1); expect(h.readings[0]!.at).toBe(settledAt)
    expect(h.calls()).toEqual([]); expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS * 2)
    h.stub().script.inventory.push(membershipPage([C]))
    await h.members.h.bringUp(h.members.h.p('alpha')); await h.members.scan()
    expect(h.calls()).toEqual([])
    h.runner.kick('alpha'); await h.clock.flush()
    expect(h.calls()).toHaveLength(1)
    expect(h.calls()[0]!.args).toMatchObject(ownPostLookupRange(post.issuedAt, h.readings[0]!.value))
    expect(h.readings).toHaveLength(1)
    await retryAfter(h, metadataRetryDelay(1))
    await h.saved(post.id, 'joined')
  })

  test('a cancelled no-connection attempt waits for a kick and counts no failure', async () => {
    const h = await fixture(); h.pages(1, { pageOutcomes: { 0: [{ kind: 'network' }] } })
    const call = h.connections.metadataCall
    let cancellations = 0
    h.connections.metadataCall = async (...args) => { if (cancellations++ === 0) throw new MetadataCancelledError(); return call(...args) }
    const post = await h.begin(); h.unknown(post); await h.clock.flush()
    expect(cancellations).toBe(1); expect(h.calls()).toEqual([])
    expect(h.clock.pendingCount()).toBe(0); expect(h.recorded).toEqual([])
    await h.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS * 2)
    expect(cancellations).toBe(1)
    h.runner.kick('alpha'); await h.clock.flush()
    expect(h.calls()).toHaveLength(1); await retryAfter(h, metadataRetryDelay(1)); await h.saved(post.id, 'joined')
  })

  test('an undecided stamp before the first attempt waits, then runs at its kick', async () => {
    const h = await fixture(); h.pages()
    const post = await h.begin(); h.undecided(); h.unknown(post); await h.clock.flush()
    expect(h.calls()).toEqual([]); expect(h.recorded).toEqual([]); expect(h.clock.pendingCount()).toBe(0)
    h.decide(); h.runner.kick('alpha'); await h.clock.flush()
    expect(h.calls()).toHaveLength(1); await h.saved(post.id, 'joined')
  })

  test.each(['before', 'in-flight', 'in-flight-without-kick', 'retry'] as const)('a stamp stale %s closes with none and never learns or reports a thread', async when => {
    const h = await fixture(), held = makeDeferredWebApiCall()
    h.pages(1, { pageOutcomes: { 0: when === 'retry' ? [{ kind: 'network' }] : [held.outcome] } })
    const post = await h.begin()
    if (when === 'before') h.stale()
    h.unknown(post); await h.clock.flush()
    if (when !== 'before') {
      expect(h.calls()).toHaveLength(1); h.stale()
      if (when !== 'in-flight-without-kick') h.runner.kick('alpha')
      await h.clock.flush()
      held.settle(); await h.clock.flush()
    }
    expect(h.calls()).toHaveLength(when === 'before' ? 0 : 1)
    expect(h.recorded).toEqual([['alpha', post.id, { notFound: true, holds: 'none' }]])
    expect(h.owner.resolvedThreads('alpha', C).size).toBe(0)
    expect(h.view('alpha', C, ROOT)).toBe('not-joined'); expect(h.lookupEvents).toEqual([])
    expect(h.clock.pendingCount()).toBe(0); await h.saved(post.id, 'none')
  })

  test.each([1, 2])('completed history with %s own roots waits for a decided stamp before excluding recovered joins', async count => {
    const first = await fixture()
    first.memory.addJoin('alpha', first.threads.fact({ root: ROOT, source: 'own-post' }))
    await first.memory.flush('alpha')
    const post = await first.begin()
    await first.close()
    const h = await fixture({ dir: first.dir, reopen: true }), held = makeDeferredWebApiCall()
    const data = h.pages(count, { pageOutcomes: { 0: [held.outcome] } })
    expect(h.owner.resolvedThreads('alpha', C).size).toBe(0)
    expect(h.view('alpha', C, ROOT)).toBe('joined')
    const stamp = h.authority.channelStamp('alpha', C)
    h.runner.journalRead('alpha'); h.runner.kick('alpha'); await h.clock.flush()
    expect(h.calls()).toHaveLength(1)
    h.undecided(); expect(h.view('alpha', C, ROOT)).toBe('not-joined')
    held.settle(); await h.clock.flush()
    expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
    h.runner.kick('alpha'); await h.clock.flush(); expect(h.calls()).toHaveLength(1)
    h.decide(); expect(h.authority.channelStamp('alpha', C)).toEqual(stamp)
    h.runner.kick('alpha'); await h.clock.flush()
    const candidate = data.messages[1]?.ts
    expect(h.recorded).toEqual([['alpha', post.id, count === 1
      ? { notFound: true, holds: 'none' } : { found: { ts: candidate! }, holds: 'none' }]])
    expect(h.calls()).toHaveLength(1); expect(h.lookupEvents).toEqual([])
    if (candidate) expect(h.view('alpha', C, candidate)).toBe('joined')
    await h.saved(post.id, count === 1 ? 'none' : 'joined')
  })

  test('one persona is serial in issue order while another resolves beside a hung attempt', async () => {
    const h = await fixture({ names: ['alpha', 'beta'] }), held = makeDeferredWebApiCall()
    h.pages(1, { pageOutcomes: { 0: [held.outcome] } })
    h.pages(1, {}, 'beta')
    const first = await h.begin(); await h.clock.advance(1)
    const second = await h.begin(), other = await h.begin(undefined, 'beta')
    h.unknown(second); h.unknown(first); h.unknown(other)
    h.runner.kick('alpha'); h.runner.kick('alpha'); await h.clock.flush()
    expect(h.calls()).toHaveLength(1); expect(h.calls('beta')).toHaveLength(1)
    expect(h.recorded.map(r => r[1])).toEqual([other.id])
    expect(h.owner.operation('alpha', first.id)?.state).toBe('unknown')
    held.settle(); await h.clock.flush()
    expect(h.calls()).toHaveLength(2)
    expect(h.recorded.map(r => r[1])).toEqual([other.id, first.id, second.id])
    expect(h.owner.operation('alpha', second.id)?.lookup).toEqual({ holds: 'none' }) // first joined the only root
    await h.saved(first.id, 'joined'); await h.saved(second.id, 'none'); await h.saved(other.id, 'joined', 'beta')
  })

  test.each(['forget', 'stop'] as const)('%s cancels an in-flight answer and pending jobs; a late page has no effects', async action => {
    const h = await fixture(), held = makeDeferredWebApiCall()
    h.pages(1, { pageOutcomes: { 0: [held.outcome] } })
    const first = await h.begin(), second = await h.begin()
    h.unknown(first); h.unknown(second); await h.clock.flush()
    expect(h.calls()).toHaveLength(1)
    if (action === 'forget') h.runner.forget('alpha'); else h.runner.stop()
    expect(h.clock.pendingCount()).toBe(0)
    held.settle(); await h.clock.flush()
    expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
    expect(h.calls()).toHaveLength(1); expect(h.owner.resolvedThreads('alpha', C).size).toBe(0)
    if (action === 'stop') {
      h.runner.kick('alpha'); h.runner.journalRead('alpha'); await h.clock.flush(); expect(h.calls()).toHaveLength(1)
    } else {
      h.runner.kick('alpha'); await h.clock.flush()
      expect(h.calls()).toHaveLength(3); expect(h.recorded).toHaveLength(2)
    }
  })

  test.each(['forget', 'stop'] as const)('%s removes a retry wait without leaking a later call', async action => {
    const h = await fixture(); h.pages(1, { pageOutcomes: { 0: [{ kind: 'network' }] } })
    const post = await h.begin(); h.unknown(post); await h.clock.flush()
    expect(h.clock.pendingCount()).toBe(1)
    if (action === 'forget') h.runner.forget('alpha'); else h.runner.stop()
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(metadataRetryDelay(1) * 2)
    expect(h.calls()).toHaveLength(1); expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
  })

  test.each(['forget', 'stop'] as const)('%s drops completed evidence waiting on an undecided stamp', async action => {
    const h = await fixture(), held = makeDeferredWebApiCall()
    h.pages(1, { pageOutcomes: { 0: [held.outcome] } })
    const post = await h.begin(); h.unknown(post); await h.clock.flush()
    h.undecided(); held.settle(); await h.clock.flush()
    expect(h.recorded).toEqual([]); expect(h.clock.pendingCount()).toBe(0)
    if (action === 'forget') h.runner.forget('alpha'); else h.runner.stop()
    h.decide(); await h.clock.flush()
    expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
    expect(h.calls()).toHaveLength(1); expect(h.owner.resolvedThreads('alpha', C).size).toBe(0)
  })

  test.each([false, true])('a replacement connection revokes old evidence, even if the replacement immediately stops=%s', async stopReplacement => {
    const h = await fixture(), held = makeDeferredWebApiCall()
    h.pages(1, { pageOutcomes: { 0: [held.outcome, { kind: 'never' }] } })
    const post = await h.begin(); h.unknown(post); await h.clock.flush()
    const manager = h.members.h.manager, previous = manager.provenance('alpha')!.connectionId
    h.stub().script.inventory.push(membershipPage([C]))
    await manager.reconnectCredentials('alpha', h.members.h.tokens(h.members.h.p('alpha')))
    expect(manager.provenance('alpha')!.connectionId).not.toBe(previous)
    h.runner.kick('alpha')
    if (stopReplacement) await manager.stop('alpha')
    await h.clock.flush()
    held.settle({ kind: 'platform', error: 'invalid_auth' }); await h.clock.flush()
    expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
    expect(h.owner.resolvedThreads('alpha', C).size).toBe(0)
    expect(h.owner.operation('alpha', post.id)?.state).toBe('unknown')
    expect(h.calls().length).toBeLessThanOrEqual(2)
  })

  test('forgetting one persona leaves the other persona attempt intact', async () => {
    const h = await fixture({ names: ['alpha', 'beta'] }), a = makeDeferredWebApiCall(), b = makeDeferredWebApiCall()
    h.pages(1, { pageOutcomes: { 0: [a.outcome] } }); h.pages(1, { pageOutcomes: { 0: [b.outcome] } }, 'beta')
    const first = await h.begin(), other = await h.begin(undefined, 'beta')
    h.unknown(first); h.unknown(other); await h.clock.flush()
    h.runner.forget('alpha'); expect(h.clock.pendingCount()).toBe(1)
    a.settle(); b.settle(); await h.clock.flush()
    expect(h.recorded.map(r => r[1])).toEqual([other.id]); expect(h.lookupEvents).toEqual([])
    expect(h.view('alpha', C, ROOT)).toBe('not-joined'); expect(h.view('beta', C, ROOT)).toBe('joined')
    await h.saved(other.id, 'joined', 'beta')
  })

  test('a dependency fault retries from a microtask and timer without escaping or shortening its wait', async () => {
    const h = await fixture(); h.pages()
    const stamp = h.deps.stamp
    let broken = true
    h.deps.stamp = (...args) => { if (broken) throw new Error(LEAK_SENTINEL); return stamp(...args) }
    const post = await h.begin(); h.unknown(post); await h.clock.flush()
    expect(h.calls()).toEqual([]); expect(h.recorded).toEqual([])
    h.runner.kick('alpha'); await h.clock.flush()
    await retryAfter(h, metadataRetryDelay(1), 0)
    expect(h.calls()).toEqual([])
    broken = false
    await retryAfter(h, metadataRetryDelay(2), 0)
    expect(h.calls()).toHaveLength(1); await h.saved(post.id, 'joined')
  })
})
