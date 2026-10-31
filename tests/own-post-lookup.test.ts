/** Own-post recovery through real owners, journals, stamps and bounded Slack clients. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyOwnPostLookupFailure, createOwnPostLookups, judgeOwnPostLookup, OWN_POST_LOOKUP_PAGE_LIMIT,
  ownPostLookupRange, ownPostLookupRequest, ownUploadShare, readOwnPostLookupPage, uploadShareTs,
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
  makeOwnFileShare, makePagedThread, makeStubSlack, makeDeferredWebApiCall, slackFileId,
  type OwnFileShareOptions, type PagedMessageSpec, type PagedPageDamage, type PagedThreadOptions, type WebApiOutcome,
} from './test-helpers/slack-stub.ts'

const C = SHARED_CHANNEL_IDS.primary
const ROOT = (THREAD_TIME / 1000).toFixed(6)
const IDENTITY = { botUserId: 'U0LOOKUP', botId: 'B0LOOKUP' }
const TEXT = `content ${LEAK_SENTINEL}`
const CONTENT: OwnPostContent = { kind: 'text', text: TEXT }
const DIGEST_KEY = 'ab'.repeat(32)
const FILE = slackFileId(1), OTHER_FILE = slackFileId(2)
const FILE_CONTENT: OwnPostContent = { kind: 'file', name: `${LEAK_SENTINEL}.txt`, size: 5 }
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

async function rawPage(specs: PagedMessageSpec[], parent = false, damage?: PagedPageDamage, range = ownPostLookupRange(THREAD_TIME, THREAD_TIME)) {
  const history = makePagedThread(specs.length || 1, { rootTs: ROOT, identity: IDENTITY, message: i => specs[i] ?? { author: 'other-user' } })
  const stub = makeStubSlack({ ...IDENTITY, leakMarker: LEAK_SENTINEL,
    history: [damage ? history.malformedOutcome(damage) : history.legacyOutcome('history')] })
  const response = await stub.web.conversations.history({ channel: C })
  const result = readOwnPostLookupPage(response, { target: { channel: C, ...(parent ? { parent: ROOT } : {}) },
    range, identity: IDENTITY, digestKey: DIGEST_KEY })
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
    expect(result).toEqual({ kind: 'page', own: [{ ts: ROOT, digests: [ownPostDigest(DIGEST_KEY, { kind: 'text', text: original! })], fileIds: [] }] })
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

describe('upload pure contracts', () => {
  test.each([0, OWN_ROOT_CLOCK_SKEW_MS - 1, THREAD_TIME])('an upload range from issue time %s has no latest, and its request sends none', issue => {
    const range = ownPostLookupRange(issue), request = ownPostLookupRequest({ channel: C }, range)
    expect(range).toEqual({ oldest: seconds(Math.max(0, issue - OWN_ROOT_CLOCK_SKEW_MS)) })
    expect(request).toEqual({ method: 'conversations.history',
      args: { channel: C, oldest: range.oldest, inclusive: true, limit: OWN_POST_LOOKUP_PAGE_LIMIT } })
    expect('latest' in request.args).toBe(false)
    assertNoLeak({ range, request })
  })

  test.each([
    ['the default file', undefined, undefined, ['F0THREAD0']],
    ['valid IDs once each, in order', [FILE, 'f0-not-an-id', FILE, OTHER_FILE, 'F', ''], undefined, [FILE, OTHER_FILE]],
    ['no valid ID', ['f0-not-an-id', 'F'], undefined, []],
    ['no files', undefined, false, []],
  ] as const)('page reading keeps %s as fileIds', async (_name, fileIds, file, expected) => {
    const result = await rawPage([{ author: 'own-bot', placement: 'channel', text: TEXT, ...(fileIds ? { fileIds } : {}),
      file: file ?? { name: `${LEAK_SENTINEL}.txt`, size: 3 } }])
    expect(result).toMatchObject({ kind: 'page', own: [{ ts: ROOT, fileIds: expected }] })
  })

  test('page reading with no end reading applies no upper bound', async () => {
    const late = seconds(THREAD_TIME + OWN_ROOT_CLOCK_SKEW_MS * 1000), early = seconds(THREAD_TIME - OWN_ROOT_CLOCK_SKEW_MS - 1)
    const specs: PagedMessageSpec[] = [{ author: 'own-user', placement: 'channel', ts: late, fileIds: [FILE] },
      { author: 'own-user', placement: 'channel', ts: early, fileIds: [FILE] }]
    const open = await rawPage(specs, false, undefined, ownPostLookupRange(THREAD_TIME))
    const bounded = await rawPage(specs, false, undefined, ownPostLookupRange(THREAD_TIME, THREAD_TIME))
    expect(open).toMatchObject({ kind: 'page', own: [{ ts: late, fileIds: [FILE] }] })
    expect(open.kind === 'page' && open.own).toHaveLength(1)
    expect(bounded).toEqual({ kind: 'page', own: [] })
  })

  const identity = IDENTITY
  const share = (options: Omit<OwnFileShareOptions, 'identity'> = {}, overrides = {}) =>
    makeOwnFileShare({ identity, channel: C, ts: ROOT, name: `${LEAK_SENTINEL}.txt`, text: TEXT, ...options }, overrides)
  test.each([
    ['by bot user ID', share(), [FILE]],
    ['by bot ID alone', share({ author: 'bot' }), [FILE]],
    ['by both', share({ author: 'both' }), [FILE]],
    ['with no subtype', share({ subtype: 'absent' }), [FILE]],
    ['as a thread root', share({}, { thread_ts: ROOT }), [FILE]],
    ['with several files, once each', share({ fileIds: [FILE, 'f0-not-an-id', FILE, OTHER_FILE] }), [FILE, OTHER_FILE]],
  ] as const)('ownUploadShare accepts P\'s own share %s', (_name, event, fileIds) => {
    const result = ownUploadShare(event, identity)
    expect(result).toEqual({ channel: C, ts: ROOT, fileIds }); assertNoLeak(result)
  })

  const throwing = new Proxy({}, { get() { throw new Error(LEAK_SENTINEL) }, has() { throw new Error(LEAK_SENTINEL) } })
  test.each([
    ['a reply', share({ shape: 'reply' })], ['an edit', share({ shape: 'changed' })], ['a deletion', share({ shape: 'deleted' })],
    ['another user', share({ shape: 'other-user' })], ['another bot', share({ shape: 'other-bot' })],
    ['another persona', makeOwnFileShare({ identity: { botUserId: 'U0OTHERP', botId: 'B0OTHERP' }, channel: C, ts: ROOT })],
    ['no files', share({ shape: 'no-files' })], ['a malformed ID', share({ shape: 'malformed-id' })],
    ['a non-string ID', share({ shape: 'non-string-id' })], ['another subtype', share({}, { subtype: 'bot_message' })],
    ['an invalid channel', share({ channel: 'not-a-channel' })], ['an invalid ts', share({}, { ts: '17.1' })],
    ['a missing ts', share({}, { ts: undefined })], ['no event', null], ['an array', [share()]], ['a throwing event', throwing],
  ] as const)('ownUploadShare refuses %s without throwing', (_name, event) => {
    let result: unknown = 'unset'
    expect(() => { result = ownUploadShare(event, identity) }).not.toThrow()
    expect(result).toBeUndefined()
  })

  async function own(specs: PagedMessageSpec[]) {
    const read = await rawPage(specs, false, undefined, ownPostLookupRange(0))
    if (read.kind !== 'page') throw new Error('expected page')
    return read.own
  }
  const at = (ts: string, fileIds: string[], author: PagedMessageSpec['author'] = 'own-user'): PagedMessageSpec =>
    ({ author, placement: 'channel', ts, fileIds, file: { name: `${LEAK_SENTINEL}.txt`, size: 1 } })
  test.each([
    ['within one page', [[at(seconds(THREAD_TIME + 2), [FILE]), at(seconds(THREAD_TIME), [OTHER_FILE, FILE]), at(seconds(THREAD_TIME + 1), [FILE])]], seconds(THREAD_TIME)],
    ['across pages', [[at(seconds(THREAD_TIME + 2), [FILE])], [at(seconds(THREAD_TIME + 1), [OTHER_FILE])], [at(seconds(THREAD_TIME), [FILE])]], seconds(THREAD_TIME)],
    ['by number, not text', [[at('1000000000.000001', [FILE])], [at('999999999.000002', [FILE])]], '999999999.000002'],
    ['never another author\'s', [[at(seconds(THREAD_TIME), [FILE], 'other-bot'), at(seconds(THREAD_TIME + 1), [FILE])]], seconds(THREAD_TIME + 1)],
    ['undefined with no share of it', [[at(seconds(THREAD_TIME), [OTHER_FILE])]], undefined],
    ['undefined with no message', [], undefined],
  ] as const)('uploadShareTs takes the earliest share %s', async (_name, pages, expected) => {
    const messages = (await Promise.all(pages.map(page => own([...page])))).flat()
    const result = uploadShareTs(messages, FILE)
    expect(result).toBe(expected); assertNoLeak(result)
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
  const learnt: Parameters<typeof h.owner.learnUploadThread>[] = []
  const readings: Array<{ key: string; at: number; value: number }> = []
  const connections: OwnPostLookupsDeps['connections'] = {
    metadataCall: (...args) => manager.metadataCall(...args), identity: key => manager.identity(key),
    isUp: createPersonaUpPredicate(manager, { isUp: () => true,
      isApplied: key => h.authority.config().personas.some(persona => persona.key === key) }),
    currentConnectionId: key => manager.provenance(key)?.connectionId,
  }
  const deps: OwnPostLookupsDeps = { owner: { ...h.owner, recordLookup(...args) { recorded.push(structuredClone(args)); h.owner.recordLookup(...args) },
    learnUploadThread(...args) { learnt.push([...args]); h.owner.learnUploadThread(...args) } },
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
    try { assertNoLeak({ events, recorded, learnt, captured: h.captured(), records: h.records() }) }
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
  /** A parentless upload's completion with a file ID and no thread leaves it awaiting its share. */
  function confirm(post: Awaited<ReturnType<typeof begin>>, file = FILE) {
    h.observer.end(post.operation, { kind: 'confirmed', channel: C, file })
    expect(h.owner.operation(post.key, post.id)?.state).toBe('awaiting-thread')
  }
  /** The confirmation kicks the runner, whose microtask starts the read before this resolves. */
  async function upload(key = 'alpha', file = FILE) {
    const post = await begin(undefined, key, FILE_CONTENT)
    confirm(post, file)
    return post
  }
  /** P's own file share Event, with sentinels in its file name and text. */
  const share = (ts: string, options: Omit<OwnFileShareOptions, 'identity'> = {}, key = 'alpha', overrides = {}) => makeOwnFileShare({
    identity: stub(key).identity, channel: C, ts, fileIds: [FILE], name: `${LEAK_SENTINEL}.txt`, text: TEXT, ...options }, overrides)
  async function joinedAt(post: Awaited<ReturnType<typeof begin>>, ts: string) {
    expect(learnt.filter(call => call[1] === post.id)).toEqual([[post.key, post.id, ts]])
    expect(h.owner.operation(post.key, post.id)).toMatchObject({ state: 'decided', outcome: { kind: 'confirmed', thread: ts, joined: true } })
    expect(h.view(post.key, C, ts)).toBe('joined')
    expect(JSON.stringify([events, h.events])).not.toContain(FILE) // events carry no file ID
    await saved(post.id, 'joined', post.key)
  }
  return { ...h, dir, runner, deps, connections, recorded, learnt, lookupEvents: events, readings, pages, stub, calls, begin, unknown,
    confirm, upload, share, joinedAt, saved, undecided, decide, stale, close }
}
/** A history message description sharing `fileIds`. */
const shared = (fileIds: string[], author: PagedMessageSpec['author'] = 'own-user', extra: PagedMessageSpec = {}): PagedMessageSpec =>
  ({ author, placement: 'channel', text: TEXT, fileIds, file: { name: `${LEAK_SENTINEL}.txt`, size: 5 }, ...extra })

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

describe('upload-thread reads', () => {
  const uploadArgs = (issuedAt: number, cursor?: string) =>
    ({ channel: C, ...ownPostLookupRange(issuedAt), inclusive: true, limit: OWN_POST_LOOKUP_PAGE_LIMIT, ...(cursor ? { cursor } : {}) })

  test.each(['boundary', 'other-author', 'reply', 'broadcast'] as const)('reads all history from the issue time less the skew and learns P\'s earliest share past an earlier %s', async earlier => {
    const h = await fixture(), count = OWN_POST_LOOKUP_PAGE_LIMIT * 2 + 5, issuedAt = h.clock.now()
    const reply = { placement: earlier === 'broadcast' ? 'broadcast' : 'reply', threadTs: seconds(issuedAt + 1) } as const
    // History is newest first, so the oldest message, at exactly `oldest`, is on the last page.
    const data = h.pages(count, { rootTs: seconds(issuedAt - OWN_ROOT_CLOCK_SKEW_MS), message: i =>
      i === 0 ? (earlier === 'other-author' ? shared([FILE], 'other-bot') : shared([FILE], 'own-bot', earlier === 'boundary' ? {} : reply))
        : i === 1 || i === count - 1 ? shared([FILE], i === 1 ? 'own-user' : 'own-bot')
          : shared([OTHER_FILE], i % 2 ? 'own-user' : 'other-user') })
    const post = await h.upload(); await h.clock.flush()
    expect(post.issuedAt).toBe(issuedAt)
    const calls = h.calls()
    expect(calls).toHaveLength(3)
    for (const [i, call] of calls.entries()) {
      expect(call.method).toBe('conversations.history')
      expect(call.args).toEqual(uploadArgs(issuedAt, i ? data.responses[i - 1]!.response_metadata!.next_cursor : undefined))
    }
    await h.joinedAt(post, data.messages[earlier === 'boundary' ? 0 : 1]!.ts!)
    expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
    h.runner.kick('alpha'); await h.clock.flush(); expect(h.calls()).toHaveLength(3); expect(h.learnt).toHaveLength(1)
  })

  test('a complete read without the share reads again from the first page at the retry spacing, with no overall bound', async () => {
    const h = await fixture(), misses = 12, sizes = { pageSizes: [1, 1] }
    h.pages(3, { ...sizes, message: () => shared([OTHER_FILE]) })
    const post = await h.upload(); await h.clock.flush()
    expect(h.calls()).toHaveLength(3)
    const first = h.calls()[0]!.args, start = h.clock.now()
    for (let i = 1; i <= misses; i++) {
      for (let k = 0; k < 3; k++) h.runner.kick('alpha')
      await h.clock.flush()
      await retryAfter(h, metadataRetryDelay(i))
      expect(h.calls()).toHaveLength(3 * (i + 1)); expect(h.calls()[3 * i]!.args).toEqual(first)
      expect(h.learnt).toEqual([]); expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
      expect(h.owner.operation('alpha', post.id)?.state).toBe('awaiting-thread')
    }
    expect(h.clock.now() - start).toBeGreaterThan(THREAD_MEMORY_RETRY_MAX_MS * 5)
    const data = h.pages(3, { ...sizes, message: i => shared([i ? OTHER_FILE : FILE]) })
    await retryAfter(h, metadataRetryDelay(misses + 1))
    expect(h.calls()).toHaveLength(3 * (misses + 2)); expect(h.calls()[3 * (misses + 1)]!.args).toEqual(first)
    await h.joinedAt(post, data.messages[0]!.ts!)
    h.runner.kick('alpha'); await h.clock.flush(); expect(h.calls()).toHaveLength(3 * (misses + 2))
  })

  test.each(['network', 'dns', 'timeout', 'http', 'rate-limited'] as const)('%s retries the same page with spacing and Retry-After, keeping the cursor', async kind => {
    const h = await fixture(), large = metadataRetryDelay(3) / 1000
    const first: WebApiOutcome = kind === 'http' ? { kind, status: 503 } : kind === 'rate-limited' ? { kind, retryAfter: large } : { kind }
    const data = h.pages(2, { pageSizes: [1], message: i => shared([i ? OTHER_FILE : FILE]),
      pageOutcomes: { 0: [first], 1: [{ kind: 'network' }] } })
    const post = await h.upload(); await h.clock.flush()
    expect(h.calls()).toHaveLength(1)
    const firstArgs = h.calls()[0]!.args
    for (let i = 0; i < 3; i++) h.runner.kick('alpha')
    await h.clock.flush(); await retryAfter(h, metadataRetryDelay(1, kind === 'rate-limited' ? large : undefined))
    expect(h.calls()).toHaveLength(3); expect(h.calls()[1]!.args).toEqual(firstArgs)
    const secondArgs = h.calls()[2]!.args
    expect(secondArgs).toEqual(uploadArgs(post.issuedAt, data.responses[0]!.response_metadata!.next_cursor))
    await retryAfter(h, metadataRetryDelay(1)) // a successful page reset the series
    expect(h.calls()).toHaveLength(4); expect(h.calls()[3]!.args).toEqual(secondArgs)
    await h.joinedAt(post, data.messages[0]!.ts!)
  })

  test('Retry-After beyond the timer maximum is chained, one timer at a time, to the exact deadline', async () => {
    const h = await fixture(), delay = MAX_TIMER_DELAY_MS * 2 + metadataRetryDelay(1)
    const data = h.pages(1, { message: () => shared([FILE]), pageOutcomes: { 0: [{ kind: 'rate-limited', retryAfter: delay / 1000 }] } })
    const post = await h.upload(); await h.clock.flush()
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
    await h.joinedAt(post, data.messages[0]!.ts!)
  })

  test.each(['never', 'deferred'] as const)('a %s page ends at the attempt deadline and is retried; a late answer learns nothing', async kind => {
    const h = await fixture(), delayed = makeDeferredWebApiCall()
    const data = h.pages(1, { message: () => shared([FILE]), pageOutcomes: { 0: [kind === 'never' ? { kind } : delayed.outcome] } })
    const post = await h.upload(); await h.clock.flush()
    expect(h.clock.pending()).toMatchObject([{ delayMs: THREAD_MEMORY_LOOKUP_DEADLINE_MS }])
    await h.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS - 1)
    expect(h.learnt).toEqual([]); expect(h.calls()).toHaveLength(1)
    await h.clock.advance(1)
    expect(h.clock.pending()).toMatchObject([{ delayMs: metadataRetryDelay(1) }])
    if (kind === 'deferred') {
      delayed.settle(); await h.clock.flush()
      expect(h.learnt).toEqual([]); expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
      expect(h.owner.operation('alpha', post.id)?.state).toBe('awaiting-thread')
    }
    await retryAfter(h, metadataRetryDelay(1))
    expect(h.calls()).toHaveLength(2); expect(h.calls()[1]!.args).toEqual(h.calls()[0]!.args)
    await h.joinedAt(post, data.messages[0]!.ts!)
  })

  test.each<[string, string]>([
    ...['missing_scope', 'invalid_auth', 'not_in_channel', 'is_archived', 'channel_not_found', 'thread_not_found', 'unrecognized_failure']
      .map((error): [string, string] => [error, error]),
    ['messages-absent', 'malformed'], ['cursor-number', 'malformed'], ['reject', 'rejected'],
  ])('permanent %s closes the upload with none and reports one joins-lost with no thread', async (kind, cause) => {
    const h = await fixture(), damage = kind === 'messages-absent' || kind === 'cursor-number' ? kind : undefined
    const data = h.pages(1, { message: () => shared([FILE]),
      ...(damage || kind === 'reject' ? {} : { pageOutcomes: { 0: [{ kind: 'platform', error: kind }] } }) })
    if (damage || kind === 'reject') h.stub().script.history.push(damage ? data.malformedOutcome(damage) : { kind: 'http', status: 403 })
    const post = await h.upload(); await h.clock.flush()
    expect(h.recorded).toEqual([['alpha', post.id, { notFound: true, holds: 'none' }]])
    expect(h.lookupEvents).toEqual([{ kind: 'joins-lost', key: 'alpha', channel: C, threads: [], cause }])
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', outcome: { kind: 'not-found', joined: false }, lookup: { holds: 'none' } })
    expect(h.learnt).toEqual([]); expect(h.view('alpha', C, data.messages[0]!.ts!)).toBe('not-joined')
    await h.saved(post.id, 'none')
    h.runner.kick('alpha'); await h.clock.flush(); expect(h.lookupEvents).toHaveLength(1); expect(h.calls()).toHaveLength(1)
  })

  test.each(['before', 'in-flight', 'in-flight-without-kick', 'retry', 'permanent'] as const)('a stamp stale %s closes the upload with none, learning and reporting nothing', async when => {
    const h = await fixture(), held = makeDeferredWebApiCall()
    const data = h.pages(1, { message: () => shared([FILE]), pageOutcomes: { 0: when === 'retry' ? [{ kind: 'network' }] : [held.outcome] } })
    const post = await h.begin(undefined, 'alpha', FILE_CONTENT)
    if (when === 'before') h.stale()
    h.confirm(post); await h.clock.flush()
    if (when !== 'before') {
      expect(h.calls()).toHaveLength(1); h.stale()
      if (when === 'in-flight' || when === 'retry') h.runner.kick('alpha')
      await h.clock.flush()
      held.settle(when === 'permanent' ? { kind: 'platform', error: 'channel_not_found' } : undefined); await h.clock.flush()
    }
    expect(h.calls()).toHaveLength(when === 'before' ? 0 : 1)
    expect(h.recorded).toEqual([['alpha', post.id, { notFound: true, holds: 'none' }]])
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', lookup: { holds: 'none' } })
    expect(h.learnt).toEqual([]); expect(h.owner.resolvedThreads('alpha', C).size).toBe(0)
    expect(h.view('alpha', C, data.messages[0]!.ts!)).toBe('not-joined'); expect(h.lookupEvents).toEqual([])
    expect(h.clock.pendingCount()).toBe(0); await h.saved(post.id, 'none')
  })

  test('an undecided stamp makes no call until its kick after the decision', async () => {
    const h = await fixture(), data = h.pages(1, { message: () => shared([FILE]) })
    const post = await h.begin(undefined, 'alpha', FILE_CONTENT); h.undecided(); h.confirm(post); await h.clock.flush()
    h.runner.kick('alpha'); await h.clock.flush()
    expect(h.calls()).toEqual([]); expect(h.recorded).toEqual([]); expect(h.learnt).toEqual([]); expect(h.clock.pendingCount()).toBe(0)
    h.decide(); await h.clock.flush(); expect(h.calls()).toEqual([])
    h.runner.kick('alpha'); await h.clock.flush()
    expect(h.calls()).toHaveLength(1); await h.joinedAt(post, data.messages[0]!.ts!)
  })

  test('an unreadable journal makes no call until the kick after its first successful read', async () => {
    const first = await fixture()
    await first.close()
    const h = await fixture({ dir: first.dir, reopen: true, unreadable: true })
    expect(h.memory.store('alpha')?.readable).toBe(false)
    // An upload read needs no digest, so only the journal's readable state may hold it.
    h.deps.memory.digestKey = () => DIGEST_KEY
    const data = h.pages(1, { message: () => shared([FILE]) })
    const post = await h.upload(); h.runner.kick('alpha'); await h.clock.flush()
    expect(h.calls()).toEqual([]); expect(h.clock.pendingCount()).toBe(0)
    h.io.heal()
    expect(await h.memory.retryRead('alpha')).toBe('read')
    h.runner.journalRead('alpha'); await h.clock.flush()
    expect(h.calls()).toEqual([])
    h.runner.kick('alpha'); await h.clock.flush()
    expect(h.calls()).toHaveLength(1); expect(h.calls()[0]!.args).toEqual(uploadArgs(post.issuedAt))
    expect(h.learnt).toEqual([['alpha', post.id, data.messages[0]!.ts!]])
  })

  test.each(['stopped', 'not-up'] as const)('a %s connection makes no call until a connected kick', async down => {
    const h = await fixture(), data = h.pages(1, { message: () => shared([FILE]) })
    const post = await h.begin(undefined, 'alpha', FILE_CONTENT), isUp = h.connections.isUp
    if (down === 'stopped') await h.members.h.manager.stop('alpha')
    else h.connections.isUp = () => false // the connection ID stays; only the up predicate refuses
    h.confirm(post); await h.clock.flush()
    expect(h.calls()).toEqual([]); expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS * 2)
    if (down === 'stopped') {
      h.stub().script.inventory.push(membershipPage([C]))
      await h.members.h.bringUp(h.members.h.p('alpha')); await h.members.scan()
    } else h.connections.isUp = isUp
    expect(h.calls()).toEqual([])
    h.runner.kick('alpha'); await h.clock.flush()
    expect(h.calls()).toHaveLength(1); expect(h.calls()[0]!.args).toEqual(uploadArgs(post.issuedAt))
    await h.joinedAt(post, data.messages[0]!.ts!)
  })

  test.each(['lookup', 'upload'] as const)('one persona runs its lookup and upload one attempt at a time in issue order, %s first, while another persona reads beside it', async firstKind => {
    const h = await fixture({ names: ['alpha', 'beta'] }), held = makeDeferredWebApiCall()
    h.pages(1, { message: () => shared([FILE]), pageOutcomes: { 0: [held.outcome] } })
    const beta = h.pages(1, { message: () => shared([FILE]) }, 'beta')
    const early = firstKind === 'lookup' ? await h.begin() : undefined
    await h.clock.advance(1)
    const file = await h.begin(undefined, 'alpha', FILE_CONTENT)
    await h.clock.advance(1)
    const text = early ?? await h.begin(), other = await h.begin(undefined, 'beta', FILE_CONTENT)
    h.confirm(file); h.unknown(text); h.confirm(other)
    const lookupCall = { channel: C, oldest: ownPostLookupRange(text.issuedAt).oldest, latest: expect.any(String) }
    const order = firstKind === 'lookup' ? [lookupCall, uploadArgs(file.issuedAt)] : [uploadArgs(file.issuedAt), lookupCall]
    await h.clock.flush(); expect(h.calls()).toHaveLength(1)
    h.runner.kick('alpha'); h.runner.kick('alpha'); await h.clock.flush() // kicks during the attempt start no second one
    expect(h.calls()).toHaveLength(1); expect(h.calls()[0]!.args).toMatchObject(order[0]!)
    expect(h.calls('beta')).toHaveLength(1)
    expect(h.learnt).toEqual([['beta', other.id, beta.messages[0]!.ts!]])
    held.settle(); await h.clock.flush()
    expect(h.calls()).toHaveLength(2); expect(h.calls()[1]!.args).toMatchObject(order[1]!)
    if (firstKind === 'upload') expect(h.calls()[0]!.args).toEqual(order[0])
    expect(h.recorded.map(r => r[1])).toEqual([text.id])
    expect(h.learnt.map(l => l[1])).toEqual([other.id, file.id])
    expect(h.clock.pendingCount()).toBe(0)
  })

  test.each(['forget', 'stop'] as const)('%s cancels a read in flight; its late answer and later Events change nothing', async action => {
    const h = await fixture(), held = makeDeferredWebApiCall(), rekicked = makeDeferredWebApiCall()
    const data = h.pages(1, { message: () => shared([FILE]), pageOutcomes: { 0: [held.outcome, ...(action === 'forget' ? [rekicked.outcome] : [])] } })
    const post = await h.upload(); await h.clock.flush()
    expect(h.calls()).toHaveLength(1)
    if (action === 'forget') h.runner.forget('alpha'); else h.runner.stop()
    expect(h.clock.pendingCount()).toBe(0)
    held.settle(); await h.clock.flush()
    h.runner.ownMessage('alpha', h.share(seconds(post.issuedAt + 1)), h.stub().identity); await h.clock.flush()
    expect(h.learnt).toEqual([]); expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
    expect(h.owner.operation('alpha', post.id)?.state).toBe('awaiting-thread'); expect(h.calls()).toHaveLength(1)
    h.runner.kick('alpha'); h.runner.journalRead('alpha'); await h.clock.flush()
    if (action === 'stop') { expect(h.calls()).toHaveLength(1); expect(h.learnt).toEqual([]); return }
    // After the later kick, P's Event works again: it learns the thread while the new read is held.
    expect(h.calls()).toHaveLength(2)
    const ts = seconds(post.issuedAt + 7)
    expect(ts).not.toBe(data.messages[0]!.ts)
    h.runner.ownMessage('alpha', h.share(ts), h.stub().identity)
    expect(h.learnt).toEqual([['alpha', post.id, ts]])
    rekicked.settle(); await h.clock.flush()
    expect(h.learnt).toHaveLength(1); expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
    expect(h.calls()).toHaveLength(2); expect(h.view('alpha', C, data.messages[0]!.ts!)).toBe('not-joined')
    await h.joinedAt(post, ts)
  })

  test.each([['forget', 'failure'], ['forget', 'miss'], ['stop', 'failure'], ['stop', 'miss']] as const)('%s removes an upload\'s %s wait without a later call', async (action, wait) => {
    const h = await fixture()
    h.pages(1, { message: () => shared([wait === 'miss' ? OTHER_FILE : FILE]), ...(wait === 'failure' ? { pageOutcomes: { 0: [{ kind: 'network' }] } } : {}) })
    await h.upload(); await h.clock.flush()
    expect(h.clock.pending()).toMatchObject([{ delayMs: metadataRetryDelay(1) }])
    if (action === 'forget') h.runner.forget('alpha'); else h.runner.stop()
    expect(h.clock.pendingCount()).toBe(0)
    await h.clock.advance(metadataRetryDelay(1) * 2)
    expect(h.calls()).toHaveLength(1); expect(h.learnt).toEqual([]); expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
  })

  test('forgetting one persona leaves the other persona\'s upload read intact', async () => {
    const h = await fixture({ names: ['alpha', 'beta'] }), a = makeDeferredWebApiCall(), b = makeDeferredWebApiCall()
    h.pages(1, { message: () => shared([FILE]), pageOutcomes: { 0: [a.outcome] } })
    const beta = h.pages(1, { message: () => shared([FILE]), pageOutcomes: { 0: [b.outcome] } }, 'beta')
    const first = await h.upload(), other = await h.upload('beta'); await h.clock.flush()
    h.runner.forget('alpha'); expect(h.clock.pendingCount()).toBe(1)
    a.settle(); b.settle(); await h.clock.flush()
    expect(h.learnt).toEqual([['beta', other.id, beta.messages[0]!.ts!]])
    expect(h.owner.operation('alpha', first.id)?.state).toBe('awaiting-thread')
    h.runner.ownMessage('beta', h.share(seconds(other.issuedAt + 1), {}, 'beta'), h.stub('beta').identity)
    expect(h.learnt).toHaveLength(1)
    await h.joinedAt(other, beta.messages[0]!.ts!)
  })
})

describe('own file_share Events', () => {
  test('P\'s own share right after the completion learns the thread at once, with no Slack call', async () => {
    const h = await fixture(); h.pages(1, { message: () => shared([FILE]) })
    const post = await h.begin(undefined, 'alpha', FILE_CONTENT), ts = seconds(post.issuedAt + 1)
    h.confirm(post)
    h.runner.ownMessage('alpha', h.share(ts), h.stub().identity)
    expect(h.learnt).toEqual([['alpha', post.id, ts]])
    expect(h.owner.operation('alpha', post.id)).toMatchObject({ state: 'decided', outcome: { kind: 'confirmed', thread: ts } })
    expect(h.owner.awaitingUploads('alpha')).toEqual([])
    await h.clock.flush()
    expect(h.calls()).toEqual([]); expect(h.clock.pendingCount()).toBe(0); expect(h.recorded).toEqual([])
    await h.joinedAt(post, ts)
  })

  test('P\'s own share during a read learns the thread; the read\'s answer records nothing', async () => {
    const h = await fixture(), held = makeDeferredWebApiCall()
    const data = h.pages(1, { message: () => shared([FILE]), pageOutcomes: { 0: [held.outcome] } })
    const post = await h.upload(); await h.clock.flush()
    expect(h.calls()).toHaveLength(1)
    const ts = seconds(post.issuedAt + 7)
    expect(ts).not.toBe(data.messages[0]!.ts)
    h.runner.ownMessage('alpha', h.share(ts), h.stub().identity)
    expect(h.learnt).toEqual([['alpha', post.id, ts]])
    await h.clock.flush(); expect(h.clock.pendingCount()).toBe(0)
    held.settle(); await h.clock.flush()
    expect(h.learnt).toHaveLength(1); expect(h.recorded).toEqual([]); expect(h.lookupEvents).toEqual([])
    expect(h.calls()).toHaveLength(1); expect(h.view('alpha', C, data.messages[0]!.ts!)).toBe('not-joined')
    await h.joinedAt(post, ts)
  })

  type Fx = Awaited<ReturnType<typeof fixture>>
  // Each row gives the key ownMessage is called for and the event; the identity is alpha's.
  test.each<[string, (h: Fx, ts: string) => [string, unknown]]>([
    ['a reply', (h, ts) => ['alpha', h.share(ts, { shape: 'reply' })]],
    ['an edit', (h, ts) => ['alpha', h.share(ts, { shape: 'changed' })]],
    ['a deletion', (h, ts) => ['alpha', h.share(ts, { shape: 'deleted' })]],
    ['another user\'s share', (h, ts) => ['alpha', h.share(ts, { shape: 'other-user' })]],
    ['another bot\'s share', (h, ts) => ['alpha', h.share(ts, { shape: 'other-bot' })]],
    ['another persona\'s share', (h, ts) => ['alpha', h.share(ts, {}, 'beta')]],
    ['P\'s share on another persona\'s key', (h, ts) => ['beta', h.share(ts)]],
    ['a share without that file ID', (h, ts) => ['alpha', h.share(ts, { fileIds: [OTHER_FILE] })]],
    ['a share in another channel', (h, ts) => ['alpha', h.share(ts, { channel: SHARED_CHANNEL_IDS.secondary })]],
    ['a share with no files', (h, ts) => ['alpha', h.share(ts, { shape: 'no-files' })]],
    ['a share with a malformed ID', (h, ts) => ['alpha', h.share(ts, { shape: 'malformed-id' })]],
    ['another subtype', (h, ts) => ['alpha', h.share(ts, {}, 'alpha', { subtype: 'bot_message' })]],
  ])('%s learns nothing and starts no Slack call', async (_name, make) => {
    const h = await fixture({ names: ['alpha', 'beta'] }); h.pages(1, { message: () => shared([OTHER_FILE]) })
    const post = await h.upload(); h.runner.kick('beta'); await h.clock.flush()
    expect(h.calls()).toHaveLength(1); expect(h.clock.pending()).toMatchObject([{ delayMs: metadataRetryDelay(1) }])
    const [key, event] = make(h, seconds(post.issuedAt + 1))
    h.runner.ownMessage(key, event, h.stub().identity)
    expect(h.learnt).toEqual([]); expect(h.owner.operation('alpha', post.id)?.state).toBe('awaiting-thread')
    await h.clock.flush()
    expect(h.calls()).toHaveLength(1); expect(h.calls('beta')).toEqual([])
    expect(h.clock.pending()).toMatchObject([{ delayMs: metadataRetryDelay(1) }])
  })

  test('P\'s own share before the completion learns nothing', async () => {
    const h = await fixture(); h.pages(1, { message: () => shared([OTHER_FILE]) })
    const post = await h.begin(undefined, 'alpha', FILE_CONTENT), ts = seconds(post.issuedAt + 1)
    h.runner.kick('alpha'); await h.clock.flush()
    h.runner.ownMessage('alpha', h.share(ts), h.stub().identity)
    expect(h.learnt).toEqual([]); expect(h.owner.operation('alpha', post.id)?.state).toBe('awaiting-answer')
    h.confirm(post); await h.clock.flush()
    expect(h.learnt).toEqual([]); expect(h.calls()).toHaveLength(1)
    expect(h.owner.operation('alpha', post.id)?.state).toBe('awaiting-thread')
  })

  test('P\'s own share under a stale stamp learns nothing, and the upload closes with none', async () => {
    const h = await fixture(), data = h.pages(1, { message: () => shared([OTHER_FILE]) })
    const post = await h.upload(); await h.clock.flush()
    expect(h.calls()).toHaveLength(1)
    h.stale()
    h.runner.ownMessage('alpha', h.share(seconds(post.issuedAt + 1)), h.stub().identity)
    expect(h.learnt).toEqual([])
    h.runner.kick('alpha'); await h.clock.flush()
    expect(h.recorded).toEqual([['alpha', post.id, { notFound: true, holds: 'none' }]])
    expect(h.lookupEvents).toEqual([]); expect(h.calls()).toHaveLength(1); expect(h.clock.pendingCount()).toBe(0)
    expect(h.view('alpha', C, data.messages[0]!.ts!)).toBe('not-joined'); await h.saved(post.id, 'none')
  })

  test.each(['awaitingUploads', 'learnUploadThread', 'stamp', 'event'] as const)('ownMessage never throws when %s throws, and calls no Slack method', async fault => {
    const h = await fixture(); h.pages(1, { message: () => shared([OTHER_FILE]) })
    const post = await h.upload(); await h.clock.flush()
    const owner = { ...h.deps.owner }, stamp = h.deps.stamp
    const fail = () => { throw new Error(LEAK_SENTINEL) }
    if (fault === 'awaitingUploads') h.deps.owner.awaitingUploads = fail
    if (fault === 'learnUploadThread') h.deps.owner.learnUploadThread = fail
    if (fault === 'stamp') h.deps.stamp = fail
    const event = fault === 'event' ? new Proxy({}, { get: fail, has: fail }) : h.share(seconds(post.issuedAt + 1))
    expect(() => h.runner.ownMessage('alpha', event, h.stub().identity)).not.toThrow()
    Object.assign(h.deps.owner, owner); h.deps.stamp = stamp
    await h.clock.flush()
    expect(h.learnt).toEqual([]); expect(h.calls()).toHaveLength(1)
    expect(h.owner.operation('alpha', post.id)?.state).toBe('awaiting-thread')
  })
})
