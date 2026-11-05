/**
 * Post Hold resolution: the pure verdict and decision rules, the hold timer on an
 * injected monotonic clock, durable resolution saves and their retries, release
 * at start, and cancellation, over a real durable queue and the real own-post
 * owner over Thread Memory. Holds are stored through the queue's decided accept
 * and registered in its store's turn, as routing does; routing's own
 * registration and the server wiring are tested in their own suites.
 * SPDX-License-Identifier: MIT
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RETYPE_BACKOFF_MS, THREAD_REPLY_HOLD_MS } from '../src/delivery-constants.ts'
import type { HoldResolution, HoldSummary } from '../src/delivery-queue.ts'
import type { MemoryHoldMode } from '../src/memory-holds.ts'
import { ownPostAnswerOfError, ownPostAnswerOfPost, type OwnPostAnswer, type OwnPostLookupResult, type OwnPostOperation } from '../src/own-post.ts'
import { createPostHoldResolver, decidePostHold, postHoldVerdict, type PostHoldEvent, type PostHoldVerdict } from '../src/post-holds.ts'
import { OWN_POST_UPLOAD_REFUSED } from '../src/registry.ts'
import { assertNoLeak, LEAK_SENTINEL } from './test-helpers/credentials.ts'
import { heldSlackInput, makeQueue, memoryHold, postHold, queuePath } from './test-helpers/delivery-queue.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeOwnPostHarness, type OwnPostHarness } from './test-helpers/own-post.ts'
import { membershipPage, SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { makeStubSlack, slackPlatformError } from './test-helpers/slack-stub.ts'
import { THREAD_TIME, threadFsControls } from './test-helpers/thread-memory.ts'

const C = SHARED_CHANNEL_IDS.primary
const ROOT = '1700000000.000100', ROOT2 = '1700000000.000200', REPLY = '1700000000.000300'
/** A held reply's text: no resolver event, save or release may carry it. */
const MESSAGE_BODY = 'held reply body must never reach a Post Hold event'
const OPEN: PostHoldVerdict = { kind: 'open' }, FAILED: PostHoldVerdict = { kind: 'failed' }
const inRoot = (thread: string): PostHoldVerdict => ({ kind: 'thread', thread })
const NO_ANSWER: OwnPostAnswer = { kind: 'no-answer' }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'post-hold fixture cleanup failed')
})

/** Slack's answer to P's post in channel C, built by the shared stub from `result`'s fields. */
async function confirmation(result: Record<string, unknown>): Promise<OwnPostAnswer> {
  const slack = makeStubSlack({ post: [{ kind: 'ok', result }] })
  return ownPostAnswerOfPost(C, await slack.web.chat.postMessage({ channel: C, text: LEAK_SENTINEL }))
}
/** A post Slack confirms as a reply in `root`'s thread. */
const inThread = (root: string) => confirmation({ ts: REPLY, message: { thread_ts: root } })
const failure = (): OwnPostAnswer => ownPostAnswerOfError(slackPlatformError('not_in_channel'))

/** The resolver as src/server.ts builds it, on its own fake hold clock, over a real queue whose
 * writes can fail and the real owner from tests/test-helpers/own-post.ts. Wall time (the
 * resolution's `at`) is the harness clock and never moves unless a case moves it. */
async function resolverFixture(options: { names?: string[]; canRun?: (key: string) => boolean; timerEarlyMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'post-holds-')), holdClock = createFakeClock(), io = threadFsControls(dir)
  holdClock.settleOn(io.durable)
  let wall = () => THREAD_TIME
  const queue = await makeQueue(dir, { now: () => wall(), fs: io.fs })
  let harness: OwnPostHarness | undefined
  cleanups.push(async () => {
    try { await harness?.close() } finally { await queue.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
  const h = harness = await makeOwnPostHarness(dir, { queue, ...(options.names ? { membership: { names: options.names } } : {}) })
  wall = h.clock.now
  const releases: Array<{ key: string; seq: number; mode: MemoryHoldMode; hold?: HoldSummary['state'] }> = []
  const parked: string[] = [], events: PostHoldEvent[] = [], saves: Array<{ key: string; resolutions: HoldResolution[] }> = []
  let beforeSave: (key: string) => Promise<void> = async () => {}
  let feedback: (key: string, seq: number) => void | Promise<void> = () => {}
  let operationReads = 0, decisionReads = 0
  const resolver = createPostHoldResolver({
    queue: { ...queue, async resolveHolds(key, resolutions, current, onCommitted) {
      saves.push({ key, resolutions: structuredClone([...resolutions]) })
      await beforeSave(key)
      return queue.resolveHolds(key, resolutions, current, onCommitted)
    } },
    owner: {
      operation: (key, id) => { operationReads++; return h.owner.operation(key, id) },
      retainOutcomes: (key, ids) => h.owner.retainOutcomes(key, ids),
    },
    release(key, item, mode) {
      releases.push({ key, seq: item.accepted.seq, mode, hold: item.hold?.state })
      return feedback(key, item.accepted.seq)
    },
    onParked(key) { parked.push(key) },
    // A real timer may fire before the monotonic clock reaches its deadline.
    clock: options.timerEarlyMs === undefined ? holdClock : { now: holdClock.now,
      setTimeout: (callback, ms) => holdClock.setTimeout(callback, ms - options.timerEarlyMs!), clearTimeout: holdClock.clearTimeout },
    decisionNow: () => { decisionReads++; return h.clock.now() },
    onEvent: event => { events.push(event) },
    ...(options.canRun ? { canRun: options.canRun } : {}),
  })
  // As src/server.ts subscribes: every owner event checks its key, on a microtask.
  const unsubscribe = h.owner.subscribe(event => resolver.check(event.key))
  cleanups.push(() => {
    resolver.stop(); unsubscribe()
    expect(holdClock.pendingCount()).toBe(0)
    assertNoLeak({ events, releases, saves, parked })
    expect(JSON.stringify({ events, releases, saves, parked })).not.toContain(MESSAGE_BODY)
  })

  /** P's post through the production observer, its intent kept before Slack would be called. */
  async function post(parent?: string, key = 'alpha', surface: 'text' | 'file' = 'text') {
    const started = h.observer.start(key, surface, { channel: C, ...(parent ? { parent } : {}) },
      surface === 'file' ? { kind: 'file', name: LEAK_SENTINEL, size: 12 } : { kind: 'text', text: LEAK_SENTINEL })
    if (!started) throw new Error('fixture post not started')
    const id = h.events.at(-1)!.operationId
    await started.ready
    return { operation: started.operation, id, key }
  }
  const end = (sent: { operation: OwnPostOperation }, answer: OwnPostAnswer) => { h.observer.end(sent.operation, answer) }
  /** A new-message upload Slack confirmed by file ID alone: it awaits its own share's thread. */
  async function upload(key = 'alpha') {
    const sent = await post(undefined, key, 'file')
    end(sent, { kind: 'confirmed', channel: C, file: 'F0UPLOAD1' })
    return sent
  }
  let replies = 0
  /** A reply in `root` stored as a Post Hold through the queue's decided accept with 6q's builder,
   * registered through `held` in its store's turn as routing's afterStore does. `receivedAt` is the
   * hold-clock reading at receipt; `register: false` stores one an earlier life registered. */
  async function hold(operations: readonly string[], options: {
    root?: string; key?: string; rootUnknown?: boolean; receivedAt?: number; register?: false
    afterStore?: (seq: number) => void
  } = {}) {
    const key = options.key ?? 'alpha', root = options.root ?? ROOT, rootUnknown = options.rootUnknown ?? false
    const receivedAt = options.receivedAt ?? holdClock.now(), ts = `1700000500.${String(++replies).padStart(6, '0')}`
    const field = postHold(h.clock.now(), { operations: [...operations], thread_ts: root, stamp: h.threads.fact({}, key).stamp, root_unknown: rootUnknown })
    const afterStore = options.afterStore ?? (options.register === false ? undefined
      : (seq: number) => resolver.held(key, { seq, operations, threadRoot: root, rootUnknown, receivedAt }))
    const result = await queue.acceptDecided(key, { chat_id: C, ts }, () => ({
      store: heldSlackInput(field, { channel: C, ts, key: { chat_id: C, ts }, text: MESSAGE_BODY }),
      ...(afterStore ? { afterStore: ({ seq }: { seq: number }) => afterStore(seq) } : {}),
    }))
    if (result.status !== 'accepted') throw new Error('fixture hold not stored')
    return result.seq
  }
  const state = (seq: number, key = 'alpha') => queue.item(key, seq)?.hold?.state
  return {
    dir, h, io, queue, holdClock, resolver, releases, parked, events, saves, post, end, upload, hold, state,
    operationReads: () => operationReads, decisionReads: () => decisionReads,
    beforeSave(gate: typeof beforeSave) { beforeSave = gate },
    releaseFeedback(next: typeof feedback) { feedback = next },
    /** Fail this key's queue appends at the durable write, as k8's queue cases do. */
    failQueue(times = Infinity, key = 'alpha') { io.fail('writeSync', key, { times, match: path => path === queuePath(dir, key) }) },
    retain: (id: string, key = 'alpha') => h.owner.retainOutcomes(key, [id]),
    stale(key = 'alpha') { expect(h.threads.choose('off', key).kind).toBe('applied'); expect(h.threads.choose('thread_hybrid', key).kind).toBe('applied') },
    undecided() {
      h.members.unsyncWrites(() => true)
      expect(h.threads.mode(h.authority.config().channel_mode === 'strict' ? 'open' : 'strict').kind).toBe('unresolved')
    },
    unresolvedMembership(key = 'alpha') { h.members.membership.invalidate(key) },
    async ineligible(key = 'alpha') {
      h.members.h.stub(h.members.h.p(key)).script.inventory.push(membershipPage([SHARED_CHANNEL_IDS.secondary]))
      h.members.scanner.connectionChanged(key)
      await h.clock.flush(); await h.members.scan()
      expect(h.members.membership.read(key, C, h.authority.config().channel_mode).kind).toBe('ineligible')
      expect(h.threads.choose('thread_hybrid', key).kind).toBe('applied')
    },
    resolved: (seq: number, outcome: HoldResolution['outcome'], key = 'alpha') => ({ key, resolutions: [{ seq, outcome, at: h.clock.now() }] }),
  }
}
type Fixture = Awaited<ReturnType<typeof resolverFixture>>

describe('Post Hold rules', () => {
  test('THREAD_REPLY_HOLD_MS is 3 seconds', () => {
    expect(THREAD_REPLY_HOLD_MS).toBe(3_000)
  })

  /** Each owner state reached as production reaches it; decided rows are retained first, as a hold's store retains. */
  const VERDICTS: Array<{ label: string; verdict: PostHoldVerdict; reach(f: Fixture): Promise<string> }> = [
    { label: 'awaiting its answer', verdict: OPEN, reach: async f => (await f.post(ROOT)).id },
    { label: 'left without an answer', verdict: OPEN, async reach(f) { const p = await f.post(ROOT); f.end(p, NO_ANSWER); return p.id } },
    { label: 'an upload awaiting its thread', verdict: OPEN, reach: async f => (await f.upload()).id },
    { label: 'confirmed in a thread', verdict: inRoot(ROOT), async reach(f) {
      const p = await f.post(ROOT); f.retain(p.id); f.end(p, await inThread(ROOT)); return p.id } },
    { label: 'confirmed after its stamp went stale', verdict: inRoot(ROOT), async reach(f) {
      const p = await f.post(ROOT); f.retain(p.id); f.stale(); f.end(p, await inThread(ROOT)); return p.id } },
    { label: 'confirmed while ineligible', verdict: inRoot(ROOT), async reach(f) {
      await f.ineligible(); const p = await f.post(ROOT); f.retain(p.id); f.end(p, await inThread(ROOT)); return p.id } },
    { label: 'deferred by unresolved membership', verdict: inRoot(ROOT), async reach(f) {
      const p = await f.post(ROOT); f.unresolvedMembership(); f.end(p, await inThread(ROOT)); return p.id } },
    { label: 'deferred by an undecided stamp', verdict: inRoot(ROOT), async reach(f) {
      const p = await f.post(ROOT); f.undecided(); f.end(p, await inThread(ROOT)); return p.id } },
    { label: 'an upload whose thread is learnt', verdict: inRoot(ROOT2), async reach(f) {
      const p = await f.upload(); f.retain(p.id); f.h.owner.learnUploadThread('alpha', p.id, ROOT2); return p.id } },
    { label: 'failed', verdict: FAILED, async reach(f) { const p = await f.post(ROOT); f.retain(p.id); f.end(p, failure()); return p.id } },
    { label: 'failed after its stamp went stale', verdict: FAILED, async reach(f) {
      const p = await f.post(ROOT); f.retain(p.id); f.stale(); f.end(p, failure()); return p.id } },
    { label: 'an upload refused after its wait', verdict: FAILED, async reach(f) {
      const p = await f.post(undefined, 'alpha', 'file'); f.retain(p.id); f.end(p, { kind: 'failed', code: OWN_POST_UPLOAD_REFUSED }); return p.id } },
    ...([
      ['found by a lookup that counts for holds', { found: { ts: REPLY, threadTs: ROOT }, holds: 'thread' }, inRoot(ROOT)],
      ['found by a lookup that does not count for holds', { found: { ts: REPLY, threadTs: ROOT }, holds: 'none' }, OPEN],
      ['not found by a lookup that counts as a failure', { notFound: true, holds: 'failed' }, FAILED],
      ['not found by a lookup that does not count for holds', { notFound: true, holds: 'none' }, OPEN],
    ] as const).map(([label, result, verdict]) => ({ label, verdict, async reach(f: Fixture) {
      const p = await f.post(ROOT); f.end(p, NO_ANSWER); f.retain(p.id)
      f.h.owner.recordLookup('alpha', p.id, result as OwnPostLookupResult); return p.id } })),
    { label: 'never started', verdict: OPEN, reach: async () => 'post-never' },
    { label: 'forgotten', verdict: OPEN, async reach(f) { const p = await f.post(ROOT); f.h.owner.forget('alpha'); return p.id } },
  ]
  test.each(VERDICTS)('postHoldVerdict: an operation $label', async ({ reach, verdict }) => {
    const f = await resolverFixture(), id = await reach(f)
    expect(postHoldVerdict(f.h.owner.operation('alpha', id))).toEqual(verdict)
  })

  const elsewhere = inRoot(ROOT2), unrelated = inRoot('1700000000.0001')
  test.each([
    ['confirmed in the root releases even when another post failed', [FAILED, inRoot(ROOT)], false, false, 'released'],
    ['confirmed in the root releases while another is open', [inRoot(ROOT), OPEN], false, false, 'released'],
    ['confirmed in the root releases though the root was unknown and the timer expired', [elsewhere, inRoot(ROOT)], true, true, 'released'],
    ['every post failed withdraws', [FAILED, FAILED], false, false, 'withdrawn'],
    ['failed and confirmed elsewhere withdraws', [elsewhere, FAILED], false, false, 'withdrawn'],
    ['failed and confirmed elsewhere parks when the root was unknown', [elsewhere, FAILED], true, false, 'parked'],
    ['every post decided withdraws even once expired', [FAILED, elsewhere], false, true, 'withdrawn'],
    ['an open post waits', [OPEN, FAILED], false, false, undefined],
    ['an open post with a root unknown waits', [elsewhere, OPEN], true, false, undefined],
    ['expiry releases while any post is open', [OPEN, FAILED], false, true, 'released'],
    ['expiry releases an unknown root while a post is open', [OPEN], true, true, 'released'],
    ['roots compare as exact strings', [unrelated], false, false, 'withdrawn'],
  ] as const)('decidePostHold: %s', (_label, verdicts, rootUnknown, expired, outcome) => {
    expect(decidePostHold({ threadRoot: ROOT, rootUnknown, verdicts, expired })).toBe(outcome)
  })
})

describe('Post Hold resolver: the four rules', () => {
  test.each([
    ['one post', 1], ['one post confirmed in the root while another failed', 2],
  ] as const)('%s confirmed in its thread 1 s after receipt releases then, and its timer never fires', async (_label, posts) => {
    const f = await resolverFixture(), other = posts === 2 ? await f.post(ROOT2) : undefined, sent = await f.post(ROOT)
    const seq = await f.hold([...(other ? [other.id] : []), sent.id])
    await f.holdClock.flush()
    expect(f.holdClock.pending().map(t => t.delayMs)).toEqual([THREAD_REPLY_HOLD_MS])
    if (other) { f.end(other, failure()); await f.holdClock.flush() }
    expect(f.saves).toEqual([])
    await f.holdClock.advance(1000)
    f.end(sent, await inThread(ROOT)); await f.holdClock.flush()
    expect(f.saves).toEqual([f.resolved(seq, 'released')])
    expect(f.state(seq)).toBe('released')
    expect(f.releases).toEqual([{ key: 'alpha', seq, mode: 'live', hold: 'released' }])
    expect(f.events).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq, outcome: 'released', cause: 'thread', heldMs: 1000 }])
    expect(f.holdClock.pendingCount()).toBe(0)
    await f.holdClock.advance(THREAD_REPLY_HOLD_MS)
    expect(f.saves).toHaveLength(1); expect(f.releases).toHaveLength(1); expect(f.events).toHaveLength(1)
  })

  test.each([
    ['its one post fails', 1], ['one post is confirmed elsewhere and the other fails', 2],
  ] as const)('a hold whose %s is withdrawn, never released', async (_label, posts) => {
    const f = await resolverFixture(), other = posts === 2 ? await f.post(ROOT2) : undefined, sent = await f.post(ROOT)
    const seq = await f.hold([...(other ? [other.id] : []), sent.id])
    if (other) { f.end(other, await inThread(ROOT2)); await f.holdClock.flush(); expect(f.saves).toEqual([]) }
    await f.holdClock.advance(200)
    f.end(sent, failure()); await f.holdClock.flush()
    expect(f.saves).toEqual([f.resolved(seq, 'withdrawn')])
    expect(f.state(seq)).toBe('withdrawn')
    expect(f.events).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq, outcome: 'withdrawn', cause: 'outcomes', heldMs: 200 }])
    expect(f.releases).toEqual([]); expect(f.parked).toEqual([])
    expect(f.holdClock.pendingCount()).toBe(0)
  })

  test('a hold with no answer is released, joining nothing, exactly THREAD_REPLY_HOLD_MS after receipt and not 1 ms earlier', async () => {
    const f = await resolverFixture(), sent = await f.post(ROOT)
    // Receipt precedes the store by the serial intake wait; the deadline counts from receipt.
    const receivedAt = f.holdClock.now()
    await f.holdClock.advance(400)
    const seq = await f.hold([sent.id], { receivedAt })
    expect(f.holdClock.pending().map(t => t.delayMs)).toEqual([THREAD_REPLY_HOLD_MS - 400])
    await f.holdClock.advanceTo(receivedAt + THREAD_REPLY_HOLD_MS - 1)
    // An evaluation 1 ms before the deadline, as any owner event would start, decides nothing.
    f.resolver.check('alpha'); await f.holdClock.flush()
    expect(f.saves).toEqual([]); expect(f.state(seq)).toBe('unresolved')
    await f.holdClock.advance(1)
    expect(f.saves).toEqual([f.resolved(seq, 'released')])
    expect(f.events).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq, outcome: 'released', cause: 'timer', heldMs: THREAD_REPLY_HOLD_MS }])
    expect(f.releases).toEqual([{ key: 'alpha', seq, mode: 'live', hold: 'released' }])
    expect(f.h.memory.view('alpha', C, ROOT)).toBe('not-joined')
    // The post's late answer joins its own thread but never re-decides the hold.
    f.end(sent, await inThread(ROOT)); await f.holdClock.flush()
    expect(f.saves).toHaveLength(1); expect(f.events).toHaveLength(1); expect(f.releases).toHaveLength(1)
  })

  test('a hold timer that wakes early re-arms for the rest: only the monotonic deadline releases', async () => {
    const f = await resolverFixture({ timerEarlyMs: 1 }), sent = await f.post(ROOT)
    const seq = await f.hold([sent.id])
    await f.holdClock.advance(THREAD_REPLY_HOLD_MS - 1)
    expect(f.holdClock.firedCount()).toBe(1)
    expect(f.saves).toEqual([]); expect(f.holdClock.pendingCount()).toBe(1)
    await f.holdClock.advance(1)
    expect(f.saves).toEqual([f.resolved(seq, 'released')])
    expect(f.events).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq, outcome: 'released', cause: 'timer', heldMs: THREAD_REPLY_HOLD_MS }])
  })

  test.each([
    ['exactly at', THREAD_REPLY_HOLD_MS], ['500 ms past', THREAD_REPLY_HOLD_MS + 500],
  ] as const)('a hold stored %s its time is released at once, arming no timer', async (_label, late) => {
    const f = await resolverFixture(), sent = await f.post(ROOT), receivedAt = f.holdClock.now()
    await f.holdClock.advance(late)
    const seq = await f.hold([sent.id], { receivedAt })
    expect(f.holdClock.pendingCount()).toBe(0)
    await f.holdClock.flush()
    expect(f.saves).toEqual([f.resolved(seq, 'released')])
    expect(f.events).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq, outcome: 'released', cause: 'timer', heldMs: late }])
    expect(f.releases).toEqual([{ key: 'alpha', seq, mode: 'live', hold: 'released' }])
  })

  test.each([
    ['confirmed in its root, deferred by unresolved membership', 'deferred', 'released', 'thread'],
    ['confirmed in its root and kept for another intake', 'confirmed', 'released', 'thread'],
    ['failed and kept for another intake', 'failed', 'withdrawn', 'outcomes'],
  ] as const)('a hold whose post is already %s when stored resolves at once', async (_label, known, outcome, cause) => {
    const f = await resolverFixture(), sent = await f.post(ROOT)
    // A deferred post stays pending; a decided one is readable only while something retains it.
    if (known === 'deferred') f.unresolvedMembership()
    const kept = known === 'deferred' ? undefined : f.retain(sent.id)
    f.end(sent, known === 'failed' ? failure() : await inThread(ROOT))
    await f.holdClock.flush()
    const seq = await f.hold([sent.id])
    await f.holdClock.flush()
    expect(f.saves).toEqual([f.resolved(seq, outcome)])
    expect(f.events).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq, outcome, cause, heldMs: 0 }])
    expect(f.holdClock.pendingCount()).toBe(0)
    kept?.()
  })
})

describe('Post Hold resolver: kept outcomes, saves and retries', () => {
  test('an answer landing after held, before its first check, is read through the retention held took', async () => {
    const f = await resolverFixture(), sent = await f.post(ROOT), answer = await inThread(ROOT)
    let seq = 0
    await f.hold([sent.id], { afterStore: stored => {
      seq = stored
      f.resolver.held('alpha', { seq: stored, operations: [sent.id], threadRoot: ROOT, rootUnknown: false, receivedAt: f.holdClock.now() })
      // Unretained, the owner would drop the decided entry right after its decided event.
      f.end(sent, answer)
    } })
    await f.holdClock.flush()
    expect(f.saves).toEqual([f.resolved(seq, 'released')])
    expect(f.events).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq, outcome: 'released', cause: 'thread', heldMs: 0 }])
  })

  test('a decided outcome stays retained while its resolution is unsaved and is released by the save', async () => {
    const f = await resolverFixture(), sent = await f.post(ROOT)
    const gate = Promise.withResolvers<void>()
    f.beforeSave(() => gate.promise)
    const seq = await f.hold([sent.id])
    f.end(sent, await inThread(ROOT)); await f.holdClock.flush()
    expect(f.saves).toHaveLength(1); expect(f.state(seq)).toBe('unresolved')
    expect(f.h.owner.operation('alpha', sent.id)).toMatchObject({ state: 'decided', outcome: { thread: ROOT } })
    gate.resolve(); await f.holdClock.flush()
    expect(f.state(seq)).toBe('released')
    expect(f.h.owner.operation('alpha', sent.id)).toBeUndefined()
  })

  test('one evaluation saves its decisions in one resolveHolds call with one decision time, released ones fed back in seq order', async () => {
    const f = await resolverFixture()
    const [a, b, c, d] = [await f.post(ROOT), await f.post(ROOT2), await f.post(ROOT), await f.post(ROOT2)]
    const released = await f.hold([a.id]), withdrawn = await f.hold([b.id]), alsoReleased = await f.hold([c.id]), open = await f.hold([d.id], { root: ROOT2 })
    await f.holdClock.flush()
    const reads = f.decisionReads()
    await f.holdClock.advance(50)
    // All three answers land in one turn: one coalesced evaluation decides them.
    const [inA, inC] = [await inThread(ROOT), await inThread(ROOT)]
    f.end(a, inA); f.end(b, failure()); f.end(c, inC)
    await f.holdClock.flush()
    expect(f.decisionReads() - reads).toBe(1)
    const at = f.h.clock.now()
    expect(f.saves).toEqual([{ key: 'alpha', resolutions: [
      { seq: released, outcome: 'released', at }, { seq: withdrawn, outcome: 'withdrawn', at }, { seq: alsoReleased, outcome: 'released', at },
    ] }])
    expect(f.releases).toEqual([released, alsoReleased].map(seq => ({ key: 'alpha', seq, mode: 'live', hold: 'released' })))
    expect(f.events.map(e => e.kind === 'post-hold-resolved' && [e.seq, e.outcome, e.cause])).toEqual([
      [released, 'released', 'thread'], [withdrawn, 'withdrawn', 'outcomes'], [alsoReleased, 'released', 'thread'],
    ])
    expect(f.queue.unresolvedHolds('alpha').map(h => h.seq)).toEqual([open])
  })

  test('a decided hold is not re-decided by later outcomes or its timer while its save is outstanding', async () => {
    const f = await resolverFixture(), [a, b] = [await f.post(ROOT), await f.post(ROOT)]
    const gate = Promise.withResolvers<void>()
    f.beforeSave(() => gate.promise)
    const seq = await f.hold([a.id, b.id])
    await f.holdClock.advance(THREAD_REPLY_HOLD_MS)
    expect(f.saves).toEqual([f.resolved(seq, 'released')])
    expect(f.holdClock.pendingCount()).toBe(0)
    // Both failing would withdraw an undecided hold; this one stays released by its timer.
    f.end(a, failure()); f.end(b, failure())
    await f.holdClock.advance(THREAD_REPLY_HOLD_MS)
    expect(f.saves).toHaveLength(1)
    gate.resolve(); await f.holdClock.flush()
    expect(f.saves).toEqual([f.resolved(seq, 'released')])
    expect(f.events).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq, outcome: 'released', cause: 'timer', heldMs: THREAD_REPLY_HOLD_MS }])
    expect(f.releases).toEqual([{ key: 'alpha', seq, mode: 'live', hold: 'released' }])
  })

  test('a failed durable append keeps the hold unresolved and retained, and retries the same resolution at RETYPE_BACKOFF_MS until saved', async () => {
    const f = await resolverFixture(), sent = await f.post(ROOT)
    const seq = await f.hold([sent.id])
    f.failQueue(2)
    await f.holdClock.advance(1000)
    f.end(sent, await inThread(ROOT)); await f.holdClock.flush()
    const attempt = f.resolved(seq, 'released')
    expect(f.saves).toEqual([attempt])
    expect(f.events).toEqual([{ kind: 'post-hold-save-failed', key: 'alpha', seqs: [seq] }])
    expect(f.queue.unresolvedHolds('alpha').map(h => h.seq)).toEqual([seq])
    expect(f.h.owner.operation('alpha', sent.id)).toMatchObject({ state: 'decided' })
    expect(f.holdClock.pending().map(t => t.delayMs)).toEqual([RETYPE_BACKOFF_MS[0]])
    await f.holdClock.advance(RETYPE_BACKOFF_MS[0] - 1)
    expect(f.saves).toHaveLength(1)
    await f.holdClock.advance(1)
    expect(f.saves).toEqual([attempt, attempt])
    expect(f.events.map(e => e.kind)).toEqual(['post-hold-save-failed', 'post-hold-save-failed'])
    expect(f.holdClock.pending().map(t => t.delayMs)).toEqual([RETYPE_BACKOFF_MS[1]])
    expect(f.releases).toEqual([]); expect(f.state(seq)).toBe('unresolved')
    await f.holdClock.advance(RETYPE_BACKOFF_MS[1])
    expect(f.saves).toEqual([attempt, attempt, attempt])
    expect(f.state(seq)).toBe('released')
    expect(f.releases).toEqual([{ key: 'alpha', seq, mode: 'live', hold: 'released' }])
    expect(f.events.at(-1)).toEqual({ kind: 'post-hold-resolved', key: 'alpha', seq, outcome: 'released', cause: 'thread', heldMs: 1000 })
    expect(f.h.owner.operation('alpha', sent.id)).toBeUndefined()
    expect(f.holdClock.pendingCount()).toBe(0)
  })

  test('holds sharing an operation resolve together, and one stored after its outcome is known resolves at once', async () => {
    const f = await resolverFixture(), sent = await f.post(ROOT)
    const first = await f.hold([sent.id]), second = await f.hold([sent.id])
    const gate = Promise.withResolvers<void>()
    f.beforeSave(() => gate.promise)
    f.end(sent, await inThread(ROOT)); await f.holdClock.flush()
    expect(f.saves).toEqual([{ key: 'alpha', resolutions: [first, second].map(seq => ({ seq, outcome: 'released', at: f.h.clock.now() })) }])
    // Its outcome is still retained by the unsaved pair: a third hold naming it is decided at once.
    const third = await f.hold([sent.id]); await f.holdClock.flush()
    expect(f.saves).toHaveLength(1)
    gate.resolve(); await f.holdClock.flush()
    expect(f.saves.at(-1)).toEqual(f.resolved(third, 'released'))
    expect(f.releases.map(r => r.seq)).toEqual([first, second, third])
    expect(f.events.map(e => e.kind === 'post-hold-resolved' && e.cause)).toEqual(['thread', 'thread', 'thread'])
    expect(f.h.owner.operation('alpha', sent.id)).toBeUndefined()
    expect(f.holdClock.pendingCount()).toBe(0)
  })

  test('a resolution the queue drops because another owner resolved the hold first is settled with no release or event', async () => {
    const f = await resolverFixture(), sent = await f.post(ROOT)
    const gate = Promise.withResolvers<void>()
    f.beforeSave(() => gate.promise)
    const seq = await f.hold([sent.id])
    f.end(sent, await inThread(ROOT)); await f.holdClock.flush()
    expect(f.saves).toHaveLength(1)
    expect(await f.queue.resolveHolds('alpha', [{ seq, outcome: 'withdrawn', at: f.h.clock.now() }])).toHaveLength(1)
    gate.resolve(); await f.holdClock.flush()
    expect(f.state(seq)).toBe('withdrawn')
    expect(f.releases).toEqual([]); expect(f.events).toEqual([])
    expect(f.h.owner.operation('alpha', sent.id)).toBeUndefined()
    expect(f.holdClock.pendingCount()).toBe(0)
  })

  test('parked holds are saved together, call onParked once, and are listed as Memory Holds; a known root withdraws instead', async () => {
    const f = await resolverFixture(), [a, b, c] = [await f.post(ROOT2), await f.post(ROOT), await f.post(ROOT2)]
    const first = await f.hold([a.id], { rootUnknown: true }), second = await f.hold([b.id], { rootUnknown: true })
    const known = await f.hold([c.id])
    const [inA, inC] = [await inThread(ROOT2), await inThread(ROOT2)]
    f.end(a, inA); f.end(b, failure()); f.end(c, inC)
    await f.holdClock.flush()
    const at = f.h.clock.now()
    expect(f.saves).toEqual([{ key: 'alpha', resolutions: [
      { seq: first, outcome: 'parked', at }, { seq: second, outcome: 'parked', at }, { seq: known, outcome: 'withdrawn', at },
    ] }])
    expect(f.parked).toEqual(['alpha'])
    expect(f.queue.unresolvedHolds('alpha').map(h => [h.seq, h.on, h.memoryDependent])).toEqual([[first, 'memory', true], [second, 'memory', true]])
    expect(f.releases).toEqual([])
    expect(f.events.map(e => e.kind === 'post-hold-resolved' && [e.seq, e.outcome, e.cause])).toEqual([
      [first, 'parked', 'outcomes'], [second, 'parked', 'outcomes'], [known, 'withdrawn', 'outcomes'],
    ])
    expect(f.holdClock.pendingCount()).toBe(0)
  })

  test.each(['throws', 'never settles'] as const)('a release that %s delays no later release or save', async fault => {
    const f = await resolverFixture(), [a, b, c] = [await f.post(ROOT), await f.post(ROOT), await f.post(ROOT)]
    const stuck = Promise.withResolvers<void>()
    const first = await f.hold([a.id]), second = await f.hold([b.id]), third = await f.hold([c.id])
    f.releaseFeedback((_key, seq) => {
      if (seq !== first) return
      if (fault === 'throws') throw new Error('release fault')
      return stuck.promise
    })
    const [inA, inB] = [await inThread(ROOT), await inThread(ROOT)]
    f.end(a, inA); f.end(b, inB); await f.holdClock.flush()
    expect(f.releases.map(r => r.seq)).toEqual([first, second])
    f.end(c, await inThread(ROOT)); await f.holdClock.flush()
    expect(f.saves.map(s => s.resolutions.map(r => r.seq))).toEqual([[first, second], [third]])
    expect(f.releases.map(r => r.seq)).toEqual([first, second, third])
    stuck.resolve()
  })
})

describe('Post Hold resolver: arrival stamp, lookups and deferral', () => {
  const changes = [['a leave of the channel', 'leave'], ['a choice change', 'choice']] as const
  const answers = [['confirmed in the root', 'thread'], ['failed', 'failed'], ['unanswered', 'none']] as const
  test.each(changes.flatMap(([change, how]) => answers.map(([answer, kind]) => [change, answer, how, kind] as const)))(
    'after %s, a post %s resolves its hold under the stamp of its arrival, within THREAD_REPLY_HOLD_MS, joining nothing',
    async (_change, _answer, how, kind) => {
      const f = await resolverFixture(), sent = await f.post(ROOT), receivedAt = f.holdClock.now()
      const seq = await f.hold([sent.id])
      const arrival = f.h.authority.channelStamp('alpha', C)
      if (how === 'leave') { await f.h.members.event(false); await f.h.clock.flush() }
      else expect(f.h.threads.choose('mentions').kind).toBe('applied')
      expect(f.h.authority.channelStamp('alpha', C)).not.toEqual(arrival)
      await f.holdClock.advance(500)
      if (kind !== 'none') f.end(sent, kind === 'thread' ? await inThread(ROOT) : failure())
      await f.holdClock.advanceTo(receivedAt + THREAD_REPLY_HOLD_MS)
      const outcome = kind === 'failed' ? 'withdrawn' : 'released'
      expect(f.saves).toEqual([f.resolved(seq, outcome)])
      expect(f.events).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq, outcome,
        cause: kind === 'thread' ? 'thread' : kind === 'failed' ? 'outcomes' : 'timer', heldMs: kind === 'none' ? THREAD_REPLY_HOLD_MS : 500 }])
      expect(f.releases).toEqual(outcome === 'released' ? [{ key: 'alpha', seq, mode: 'live', hold: 'released' }] : [])
      expect(f.h.memory.view('alpha', C, ROOT)).toBe('not-joined')
    })

  test.each([
    ['a lookup that finds it in the root and counts for holds releases at once', { found: { ts: REPLY, threadTs: ROOT }, holds: 'thread' }, 'released', 'thread'],
    ['a lookup that finds it but does not count for holds leaves the timer to release', { found: { ts: REPLY, threadTs: ROOT }, holds: 'none' }, 'released', 'timer'],
    ['a lookup whose empty range counts as a failure withdraws', { notFound: true, holds: 'failed' }, 'withdrawn', 'outcomes'],
    ['a lookup that does not find it and does not count leaves the timer to release', { notFound: true, holds: 'none' }, 'released', 'timer'],
  ] as const)('an unknown post: %s', async (_label, result, outcome, cause) => {
    const f = await resolverFixture(), sent = await f.post(ROOT)
    f.end(sent, NO_ANSWER)
    const seq = await f.hold([sent.id])
    await f.holdClock.advance(700)
    f.h.owner.recordLookup('alpha', sent.id, result as OwnPostLookupResult)
    await f.holdClock.flush()
    if (cause === 'timer') {
      expect(f.saves).toEqual([])
      await f.holdClock.advance(THREAD_REPLY_HOLD_MS - 700)
    }
    expect(f.saves).toEqual([f.resolved(seq, outcome)])
    expect(f.events).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq, outcome, cause, heldMs: cause === 'timer' ? THREAD_REPLY_HOLD_MS : 700 }])
  })

  test.each([
    ['deferred by unresolved membership', 'membership'], ['deferred by an undecided stamp', 'undecided'], ['an upload whose thread is learnt', 'upload'],
  ] as const)('a post %s in the root releases its hold with cause thread', async (_label, how) => {
    const f = await resolverFixture(), sent = how === 'upload' ? await f.upload() : await f.post(ROOT)
    const seq = await f.hold([sent.id])
    await f.holdClock.advance(300)
    if (how === 'upload') f.h.owner.learnUploadThread('alpha', sent.id, ROOT)
    else {
      if (how === 'membership') f.unresolvedMembership(); else f.undecided()
      f.end(sent, await inThread(ROOT))
      expect(f.h.owner.operation('alpha', sent.id)).toMatchObject({ state: 'deferred' })
    }
    await f.holdClock.flush()
    expect(f.saves).toEqual([f.resolved(seq, 'released')])
    expect(f.events).toEqual([{ kind: 'post-hold-resolved', key: 'alpha', seq, outcome: 'released', cause: 'thread', heldMs: 300 }])
    expect(f.releases).toEqual([{ key: 'alpha', seq, mode: 'live', hold: 'released' }])
  })
})

describe('Post Hold resolver: release at start or bring-up', () => {
  test('releaseUntracked releases every unresolved, unparked Post Hold this life did not register, in one recovered save', async () => {
    const f = await resolverFixture(), [a, b, c, d] = [await f.post(ROOT), await f.post(ROOT2), await f.post(ROOT), await f.post(ROOT)]
    const earlier = await f.hold([a.id], { register: false }), other = await f.hold([b.id], { root: ROOT2, register: false })
    const parked = await f.hold([c.id], { rootUnknown: true, register: false })
    expect(await f.queue.resolveHolds('alpha', [{ seq: parked, outcome: 'parked', at: f.h.clock.now() }])).toHaveLength(1)
    const ts = '1700000600.000001'
    const memory = await f.queue.accept('alpha', heldSlackInput(memoryHold(f.h.clock.now(), { thread_ts: ROOT, stamp: f.h.threads.fact().stamp }),
      { channel: C, ts, key: { chat_id: C, ts }, text: MESSAGE_BODY }))
    if (memory.status !== 'accepted') throw new Error('fixture Memory Hold not stored')
    const registered = await f.hold([d.id])
    const gate = Promise.withResolvers<void>()
    f.beforeSave(() => gate.promise)
    let settled = false
    const done = f.resolver.releaseUntracked('alpha').then(() => { settled = true })
    await f.holdClock.flush()
    const at = f.h.clock.now()
    expect(f.saves).toEqual([{ key: 'alpha', resolutions: [earlier, other].map(seq => ({ seq, outcome: 'released', at })) }])
    expect(settled).toBe(false)
    gate.resolve(); await done
    expect(f.releases).toEqual([earlier, other].map(seq => ({ key: 'alpha', seq, mode: 'recovered', hold: 'released' })))
    expect(f.events).toEqual([earlier, other].map(seq => ({ kind: 'post-hold-resolved', key: 'alpha', seq, outcome: 'released', cause: 'restart' })))
    expect(f.queue.unresolvedHolds('alpha').map(h => [h.seq, h.on])).toEqual([[parked, 'memory'], [memory.seq, 'memory'], [registered, 'post']])
    // The registered hold stays this life's, released live by its own post.
    f.end(d, await inThread(ROOT)); await f.holdClock.flush()
    expect(f.releases.at(-1)).toEqual({ key: 'alpha', seq: registered, mode: 'live', hold: 'released' })
    await f.resolver.releaseUntracked('alpha')
    expect(f.saves).toHaveLength(2)
  })

  test('releaseUntracked with nothing to release settles without a save', async () => {
    const f = await resolverFixture(), sent = await f.post(ROOT)
    await f.hold([sent.id])
    await f.resolver.releaseUntracked('alpha'); await f.resolver.releaseUntracked('beta')
    expect(f.saves).toEqual([]); expect(f.releases).toEqual([])
  })

  test('releaseUntracked retries a failed save until saved, settling only then, and never rejects', async () => {
    const f = await resolverFixture(), sent = await f.post(ROOT)
    const seq = await f.hold([sent.id], { register: false })
    f.failQueue(1)
    let settled = false
    const done = f.resolver.releaseUntracked('alpha').then(() => { settled = true })
    await f.holdClock.flush()
    expect(f.events).toEqual([{ kind: 'post-hold-save-failed', key: 'alpha', seqs: [seq] }])
    expect(settled).toBe(false); expect(f.state(seq)).toBe('unresolved')
    await f.holdClock.advance(RETYPE_BACKOFF_MS[0])
    await done
    expect(f.saves).toEqual([f.resolved(seq, 'released'), f.resolved(seq, 'released')])
    expect(f.releases).toEqual([{ key: 'alpha', seq, mode: 'recovered', hold: 'released' }])
    expect(f.events.at(-1)).toEqual({ kind: 'post-hold-resolved', key: 'alpha', seq, outcome: 'released', cause: 'restart' })
  })

  test.each(['forget', 'stop'] as const)('%s settles a pending releaseUntracked whose save keeps failing, releasing nothing', async cancel => {
    const f = await resolverFixture(), sent = await f.post(ROOT)
    const seq = await f.hold([sent.id], { register: false })
    f.failQueue()
    const done = f.resolver.releaseUntracked('alpha')
    await f.holdClock.flush()
    expect(f.holdClock.pendingCount()).toBe(1)
    if (cancel === 'forget') f.resolver.forget('alpha'); else f.resolver.stop()
    await done
    expect(f.holdClock.pendingCount()).toBe(0)
    f.io.heal(); await f.holdClock.advance(RETYPE_BACKOFF_MS.at(-1)!)
    expect(f.saves).toHaveLength(1); expect(f.releases).toEqual([]); expect(f.state(seq)).toBe('unresolved')
  })
})

describe('Post Hold resolver: cancellation and isolation', () => {
  test.each(['forget', 'stop'] as const)('%s cancels hold timers and save retries, releases retentions, and ignores late outcomes', async cancel => {
    const f = await resolverFixture({ names: ['alpha', 'beta'] })
    const waiting = await f.post(ROOT), failing = await f.post(ROOT2), neighbor = await f.post(ROOT, 'beta')
    const pending = await f.hold([waiting.id]), retried = await f.hold([failing.id], { root: ROOT2 })
    const beta = await f.hold([neighbor.id], { key: 'beta' })
    f.failQueue()
    f.end(failing, await inThread(ROOT2)); await f.holdClock.flush()
    expect(f.events).toEqual([{ kind: 'post-hold-save-failed', key: 'alpha', seqs: [retried] }])
    expect(f.holdClock.pending().map(t => t.delayMs)).toEqual([THREAD_REPLY_HOLD_MS, THREAD_REPLY_HOLD_MS, RETYPE_BACKOFF_MS[0]])
    expect(f.h.owner.operation('alpha', failing.id)).toMatchObject({ state: 'decided' })
    if (cancel === 'forget') f.resolver.forget('alpha'); else f.resolver.stop()
    expect(f.holdClock.pending().map(t => t.delayMs)).toEqual(cancel === 'forget' ? [THREAD_REPLY_HOLD_MS] : [])
    // Every retention is released: decided outcomes are dropped, and a late answer is never retained.
    expect(f.h.owner.operation('alpha', failing.id)).toBeUndefined()
    f.io.heal()
    f.end(waiting, await inThread(ROOT)); await f.holdClock.flush()
    expect(f.h.owner.operation('alpha', waiting.id)).toBeUndefined()
    await f.holdClock.advance(THREAD_REPLY_HOLD_MS + RETYPE_BACKOFF_MS.at(-1)!)
    expect(f.saves.filter(s => s.key === 'alpha')).toEqual([f.resolved(retried, 'released')])
    expect(f.releases.filter(r => r.key === 'alpha')).toEqual([])
    expect(f.queue.unresolvedHolds('alpha').map(h => h.seq)).toEqual([pending, retried])
    expect(f.events.filter(e => e.key === 'alpha')).toHaveLength(1)
    // Another persona keeps its own timer after P's forget; stop ends every key.
    expect(f.releases).toEqual(cancel === 'forget' ? [{ key: 'beta', seq: beta, mode: 'live', hold: 'released' }] : [])
    if (cancel === 'stop') {
      const after = await f.post()
      await f.hold([after.id], { root: ROOT2 })
      expect(f.holdClock.pendingCount()).toBe(0)
      await f.resolver.releaseUntracked('beta')
      expect(f.saves.filter(s => s.key === 'beta')).toEqual([])
    }
  })

  test.each(['forget', 'stop'] as const)('%s while a save waits for its turn cancels it: nothing is saved or released', async cancel => {
    const f = await resolverFixture(), sent = await f.post(ROOT)
    const gate = Promise.withResolvers<void>()
    f.beforeSave(() => gate.promise)
    const seq = await f.hold([sent.id])
    f.end(sent, await inThread(ROOT)); await f.holdClock.flush()
    expect(f.saves).toHaveLength(1)
    if (cancel === 'forget') f.resolver.forget('alpha'); else f.resolver.stop()
    gate.resolve(); await f.holdClock.flush()
    expect(f.state(seq)).toBe('unresolved')
    expect(f.releases).toEqual([]); expect(f.events).toEqual([])
    expect(f.holdClock.pendingCount()).toBe(0)
  })

  test('a hold registered after forget belongs to the key\'s next life and resolves normally', async () => {
    const f = await resolverFixture(), old = await f.post(ROOT)
    await f.hold([old.id])
    f.resolver.forget('alpha')
    const sent = await f.post(ROOT2), seq = await f.hold([sent.id], { root: ROOT2 })
    await f.holdClock.advance(THREAD_REPLY_HOLD_MS)
    expect(f.saves).toEqual([f.resolved(seq, 'released')])
    expect(f.releases).toEqual([{ key: 'alpha', seq, mode: 'live', hold: 'released' }])
  })

  test('one persona\'s failing save and retry never delay another persona\'s resolution or save', async () => {
    const f = await resolverFixture({ names: ['alpha', 'beta'] })
    const mine = await f.post(ROOT), theirs = await f.post(ROOT, 'beta')
    const held = await f.hold([mine.id]), neighbor = await f.hold([theirs.id], { key: 'beta' })
    f.failQueue()
    const [inMine, inTheirs] = [await inThread(ROOT), await inThread(ROOT)]
    f.end(mine, inMine); f.end(theirs, inTheirs); await f.holdClock.flush()
    expect(f.state(held)).toBe('unresolved'); expect(f.state(neighbor, 'beta')).toBe('released')
    expect(f.releases).toEqual([{ key: 'beta', seq: neighbor, mode: 'live', hold: 'released' }])
    expect(['alpha', 'beta'].map(key => f.events.filter(e => e.key === key).map(e => e.kind)))
      .toEqual([['post-hold-save-failed'], ['post-hold-resolved']])
    f.io.heal(); await f.holdClock.advance(RETYPE_BACKOFF_MS[0])
    expect(f.state(held)).toBe('released')
  })

  test('a key that may not run, as in the teardown window, registers, evaluates and saves nothing', async () => {
    let running = true
    const f = await resolverFixture({ canRun: key => running || key !== 'alpha' })
    const sent = await f.post(ROOT), seq = await f.hold([sent.id])
    running = false
    const late = await f.post(ROOT2)
    await f.hold([late.id], { root: ROOT2 })
    f.end(sent, await inThread(ROOT)); f.end(late, await inThread(ROOT2))
    await f.holdClock.advance(THREAD_REPLY_HOLD_MS)
    await f.resolver.releaseUntracked('alpha')
    expect(f.saves).toEqual([]); expect(f.releases).toEqual([]); expect(f.events).toEqual([])
    expect(f.state(seq)).toBe('unresolved')
  })

  test('held and check do no evaluation, decision read or write in their caller\'s turn, and checks coalesce per key', async () => {
    const f = await resolverFixture(), sent = await f.post(ROOT)
    // Its outcome is already known, so only the deferral to a microtask keeps it from resolving here.
    f.unresolvedMembership(); f.end(sent, await inThread(ROOT))
    const counts = () => ({ reads: f.operationReads(), decisions: f.decisionReads(), saves: f.saves.length, io: f.io.calls.length })
    let before: ReturnType<typeof counts> | undefined, after: ReturnType<typeof counts> | undefined
    const seq = await f.hold([sent.id], { afterStore: stored => {
      before = counts()
      f.resolver.held('alpha', { seq: stored, operations: [sent.id], threadRoot: ROOT, rootUnknown: false, receivedAt: f.holdClock.now() })
      f.resolver.check('alpha'); f.resolver.check('alpha')
      after = counts()
    } })
    expect(after).toEqual(before)
    await f.holdClock.flush()
    expect(f.decisionReads() - before!.decisions).toBe(1)
    expect(f.saves).toEqual([f.resolved(seq, 'released')])
  })
})
