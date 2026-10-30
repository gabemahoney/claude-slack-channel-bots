import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelMode, PersonaInput } from '../src/config.ts'
import type { Via } from '../src/delivery-decision.ts'
import { buildTagParts } from '../src/tag-wrapper.ts'
import { RETYPE_BACKOFF_MS, THREAD_MEMORY_RETRY_MIN_MS } from '../src/delivery-constants.ts'
import { isOpenItem, itemOpenedAt, QUEUE_COMPACT_INTERVAL_MS, type HoldResolution } from '../src/delivery-queue.ts'
import { createMemoryHoldResolver, judgeMemoryHolds, type MemoryHoldEvent, type MemoryHoldMode } from '../src/memory-holds.ts'
import { recoverQueuedJoins } from '../src/thread-join-recovery.ts'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { heldSlackInput, makeQueue, memoryHold, queuePath, readQueue, slackInput } from './test-helpers/delivery-queue.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeReloadHarness, type ReloadRun, type ReloadRunOptions } from './test-helpers/reload-harness.ts'
import { membershipPage, SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { broadcastText, makeChannelMessage, makeDm, mentionText, stubOpenedDmId, type SlackEvent } from './test-helpers/slack-stub.ts'
import { damagedThreadLine, makeThreadMemoryHarness, readThreads, seedThreads, THREAD_ROOTS, THREAD_TIME, threadFsControls, threadPath, threadSealFsControls, readThreadSeal } from './test-helpers/thread-memory.ts'

const channel = SHARED_CHANNEL_IDS.primary, neighbor = SHARED_CHANNEL_IDS.secondary
const root = THREAD_ROOTS.primary
const MESSAGE_BODY = 'private reply body must never enter memory diagnostics'
const notices = (run: ReloadRun, title: string, key = 'alpha') => run.stub(key).calls.postMessage.map(p => ({ channel: p.channel, text: 'text' in p ? String(p.text) : '' })).filter(p => p.text.includes(`*${title}*`))
const memoryLines = (run: ReloadRun, kind: string, key = 'alpha') => run.logs.filter(l => l.includes(`thread-memory-${kind}`) && l.includes(`persona=${key}`))
function expectMemoryReportsSafe(run: ReloadRun) {
  const reports = { logs: run.logs.filter(l => l.includes('thread-memory-')), posts: run.stub('alpha').calls.postMessage,
    memory: run.threadMemoryEvents, holds: run.memoryHoldEvents, retries: run.threadMemoryRetryEvents, seal: run.threadMemorySealEvents }
  assertNoLeak(reports)
  expect(JSON.stringify(reports)).not.toContain(MESSAGE_BODY)
  for (const post of run.stub('alpha').calls.postMessage.filter(p => ('text' in p && (String(p.text).includes('Thread Memory') || String(p.text).includes('*Joins lost*'))))) {
    expect(post.channel).toBe(stubOpenedDmId('U0OPERATOR'))
  }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function resolverFixture(releaseFeedback?: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-resolver-')), clock = createFakeClock({ start: THREAD_TIME })
  const io = threadFsControls(dir), queue = await makeQueue(dir, { now: clock.now, fs: io.fs })
  const answers = new Map<string, boolean | 'unknown'>(), events: MemoryHoldEvent[] = []
  const releases: Array<{ key: string; seq: number; mode: MemoryHoldMode }> = [], order: string[] = []
  const saves: Array<{ key: string; decisions: readonly HoldResolution[] }> = []
  let beforeSave: (key: string) => Promise<void> = async () => {}, nowReads = 0
  const resolver = createMemoryHoldResolver({
    queue: { ...queue, async resolveHolds(key, decisions, current, onCommitted) {
      saves.push({ key, decisions }); await beforeSave(key)
      const saved = await queue.resolveHolds(key, decisions, current, onCommitted)
      order.push(`saved:${key}`)
      return saved
    } },
    memory: { joinedBy: (_key, _channel, thread) => answers.get(thread) ?? false,
      pruneHeldJoins: key => { order.push(`pruned:${key}`) } },
    clock, now: () => { nowReads++; return clock.now() },
    release(key, item, mode) {
      releases.push({ key, seq: item.accepted.seq, mode }); order.push(`released:${key}:${item.accepted.seq}`)
      return releaseFeedback?.()
    },
    onEvent(event) { events.push(event); order.push(event.type) },
  })
  let sequence = 0
  async function hold(thread: string = root, key = 'alpha') {
    const ts = `1700000100.${String(++sequence).padStart(6, '0')}`
    const accepted = await queue.accept(key, heldSlackInput(memoryHold(clock.now(), { thread_ts: thread }), {
      channel, key: { chat_id: channel, ts }, ts,
    }))
    expect(accepted.status).toBe('accepted')
    if (accepted.status !== 'accepted') throw new Error('fixture hold not stored')
    return accepted.seq!
  }
  cleanups.push(async () => {
    resolver.stop(); await queue.stop(); expect(clock.pendingCount()).toBe(0)
    assertNoLeak({ events, releases, saves }); rmSync(dir, { recursive: true, force: true })
  })
  return { dir, clock, io, queue, resolver, answers, releases, events, saves, order, hold,
    beforeSave: (fn: typeof beforeSave) => { beforeSave = fn }, nowReads: () => nowReads }
}

describe('Memory Hold resolver', () => {
  test('pure judgment releases, withdraws, or defers the whole batch without mutating holds', async () => {
    const f = await resolverFixture()
    await f.hold(); await f.hold(THREAD_ROOTS.secondary)
    const holds = f.queue.unresolvedHolds('alpha'), before = structuredClone(holds)
    expect(judgeMemoryHolds(holds, h => h.seq === 1, f.clock.now())).toEqual([
      { seq: 1, outcome: 'released', at: f.clock.now() }, { seq: 2, outcome: 'withdrawn', at: f.clock.now() },
    ])
    expect(judgeMemoryHolds(holds, h => h.seq === 2 ? 'unknown' : true, f.clock.now())).toBeUndefined()
    expect(holds).toEqual(before)
  })

  test.each(['live', 'recovered'] as const)('%s: unknown is quiet; one saved batch precedes ordered releases, one withdrawal event and pruning', async mode => {
    const f = await resolverFixture()
    await f.hold(); await f.hold(THREAD_ROOTS.secondary); await f.hold()
    f.answers.set(root, true); f.answers.set(THREAD_ROOTS.secondary, 'unknown')
    expect(await f.resolver.resolve('alpha', mode)).toBe('unknown')
    expect(f.saves).toHaveLength(0); expect(f.order).toHaveLength(0)
    expect(f.queue.unresolvedHolds('alpha')).toHaveLength(3)
    f.answers.set(THREAD_ROOTS.secondary, false)
    const gate = Promise.withResolvers<void>()
    f.beforeSave(() => gate.promise)
    const reads = f.nowReads(), pending = f.resolver.resolve('alpha', mode)
    await f.clock.flush()
    expect(f.nowReads() - reads).toBe(1)
    expect(f.saves).toEqual([{ key: 'alpha', decisions: [
      { seq: 1, outcome: 'released', at: f.clock.now() },
      { seq: 2, outcome: 'withdrawn', at: f.clock.now() },
      { seq: 3, outcome: 'released', at: f.clock.now() },
    ] }])
    expect(f.queue.unresolvedHolds('alpha')).toHaveLength(3)
    expect(f.order).toHaveLength(0)
    gate.resolve(); expect(await pending).toBe('resolved')
    expect(f.releases).toEqual([1, 3].map(seq => ({ key: 'alpha', seq, mode })))
    expect(f.events).toEqual([{ type: 'withdrawn', key: 'alpha', holds: [{ seq: 2, channel,
      thread_ts: THREAD_ROOTS.secondary, ts: f.queue.item('alpha', 2)!.accepted.ts }] }])
    expect(f.order).toEqual(['withdrawn', 'saved:alpha', 'released:alpha:1', 'released:alpha:3', 'pruned:alpha'])
    await f.resolver.resolve('alpha', mode); await f.resolver.retryPending('alpha')
    expect(f.releases).toHaveLength(2); expect(f.events).toHaveLength(1); expect(f.saves).toHaveLength(1)
  })

  test('failed durable append keeps holds unresolved, retries at backoff, and re-reads remaining work', async () => {
    const f = await resolverFixture(); f.answers.set(root, true)
    await f.hold(); await f.hold()
    f.io.fail('writeSync', 'alpha', { times: 1, match: path => path === queuePath(f.dir) })
    expect(await f.resolver.resolve('alpha', 'live')).toBe('retrying')
    expect(f.queue.unresolvedHolds('alpha')).toHaveLength(2)
    expect(f.releases).toHaveLength(0); expect(f.events.map(e => e.type)).toEqual(['resolution-failed'])
    expect(f.clock.pending().map(t => t.delayMs)).toEqual([RETYPE_BACKOFF_MS[0]!])
    // An independent owner resolves one sequence before this retry.
    await f.queue.resolveHolds('alpha', [{ seq: 1, outcome: 'withdrawn', at: f.clock.now() }])
    await f.clock.advance(RETYPE_BACKOFF_MS[0]! - 1)
    expect(f.releases).toHaveLength(0)
    await f.clock.advance(1)
    expect(f.saves[1]!.decisions.map(d => d.seq)).toEqual([2])
    expect(f.releases).toEqual([{ key: 'alpha', seq: 2, mode: 'live' }])
    expect(f.queue.unresolvedHolds('alpha')).toHaveLength(0)
    expect(f.clock.pendingCount()).toBe(0)
  })

  test('one key serializes pending saves while another key resolves independently', async () => {
    const f = await resolverFixture(); f.answers.set(root, true)
    await f.hold(); await f.hold(root, 'beta')
    const gate = Promise.withResolvers<void>()
    f.beforeSave(key => key === 'alpha' ? gate.promise : Promise.resolve())
    const first = f.resolver.resolve('alpha', 'recovered'), second = f.resolver.resolve('alpha', 'live')
    await f.clock.flush()
    expect(f.saves.map(s => s.key)).toEqual(['alpha'])
    expect(await f.resolver.resolve('beta', 'live')).toBe('resolved')
    expect(f.releases).toEqual([{ key: 'beta', seq: 1, mode: 'live' }])
    gate.resolve(); await Promise.all([first, second])
    expect(f.releases).toEqual([{ key: 'beta', seq: 1, mode: 'live' }, { key: 'alpha', seq: 1, mode: 'recovered' }])
    expect(f.saves.filter(s => s.key === 'alpha')).toHaveLength(1)
  })

  test.each([
    ['released', 'live', 'uncompacted'], ['withdrawn', 'live', 'uncompacted'],
    ['mixed', 'live', 'uncompacted'], ['mixed', 'recovered', 'uncompacted'],
    ['mixed', 'live', 'compacted'], ['mixed', 'recovered', 'compacted'],
  ] as const)('already-resolved overlap: %s, %s, %s reports only this save', async (outcome, mode, compaction) => {
    const compacted = compaction === 'compacted'
    const gate = Promise.withResolvers<void>(), feedback = Promise.withResolvers<void>()
    const f = await resolverFixture(compacted ? () => feedback.promise : undefined)
    f.answers.set(root, outcome !== 'withdrawn'); f.answers.set(THREAD_ROOTS.secondary, false)
    await f.hold()
    const competing: HoldResolution[] = [{ seq: 1, outcome: outcome === 'mixed' ? 'withdrawn' : outcome, at: f.clock.now() }]
    if (outcome === 'mixed') {
      await f.hold(THREAD_ROOTS.secondary); await f.hold(); await f.hold(THREAD_ROOTS.secondary); await f.hold()
      competing.push({ seq: 2, outcome: 'released', at: f.clock.now() })
    }
    const expectedReleases = outcome === 'mixed' ? [3, 5].map(seq => ({ key: 'alpha', seq, mode })) : []
    const expectedEvents: MemoryHoldEvent[] = outcome === 'mixed' ? [{ type: 'withdrawn', key: 'alpha', holds: [{
      seq: 4, channel, thread_ts: THREAD_ROOTS.secondary, ts: f.queue.item('alpha', 4)!.accepted.ts,
    }] }] : []
    await f.clock.advance(1)
    const at = f.clock.now()
    f.beforeSave(() => gate.promise)
    const pending = f.resolver.resolve('alpha', mode)
    try {
      await f.clock.flush()
      expect(f.saves).toEqual([{ key: 'alpha', decisions: outcome === 'mixed' ? [
        { seq: 1, outcome: 'released', at }, { seq: 2, outcome: 'withdrawn', at },
        { seq: 3, outcome: 'released', at }, { seq: 4, outcome: 'withdrawn', at }, { seq: 5, outcome: 'released', at },
      ] : [{ seq: 1, outcome, at }] }])
      // Opposite competing outcomes exercise the public saved-subset contract:
      // final item state cannot identify which invocation owns the feedback.
      await f.queue.resolveHolds('alpha', competing)
      expect(f.releases).toEqual([]); expect(f.events).toEqual([])
      gate.resolve(); await f.clock.flush()
      expect(readQueue(f.dir).filter(r => r.kind === 'released' || r.kind === 'withdrawn')).toEqual([
        ...competing.map(({ outcome, ...resolution }) => ({ v: 1 as const, kind: outcome, ...resolution })),
        ...(outcome === 'mixed' ? [
          { v: 1, kind: 'released', seq: 3, at }, { v: 1, kind: 'withdrawn', seq: 4, at },
          { v: 1, kind: 'released', seq: 5, at },
        ] as const : []),
      ])
      if (compacted) {
        expect(f.releases).toEqual(expectedReleases.slice(0, 1)); expect(f.events).toEqual(expectedEvents)
        expect(f.queue.item('alpha', 4)!.hold!.state).toBe('withdrawn')
        // Remove the full withdrawal while the first release's feedback waits.
        await f.queue.compact('alpha')
        expect(f.queue.item('alpha', 4)).toBeUndefined()
        expect(f.queue.item('alpha', 5)!.accepted.released_at).toBe(at)
        feedback.resolve()
      }
      expect(await pending).toBe('resolved')
      expect(f.releases).toEqual(expectedReleases); expect(f.events).toEqual(expectedEvents)
      expect(f.order).toEqual([...(outcome === 'mixed' ? ['withdrawn'] : []), 'saved:alpha',
        ...(outcome === 'mixed' ? ['released:alpha:3', 'released:alpha:5'] : []), 'pruned:alpha'])
      expect(f.queue.unresolvedHolds('alpha')).toEqual([])
      const records = readQueue(f.dir)
      expect(await f.resolver.resolve('alpha', mode === 'live' ? 'recovered' : 'live')).toBe('resolved')
      expect(await f.resolver.retryPending('alpha')).toBe('resolved')
      expect(f.releases).toEqual(expectedReleases); expect(f.events).toEqual(expectedEvents)
      expect(f.saves).toHaveLength(1); expect(readQueue(f.dir)).toEqual(records)
    } finally { gate.resolve(); feedback.resolve(); await pending }
  })

  test.each(['forget', 'stop'] as const)('%s cancels a failed append retry', async cancel => {
    const f = await resolverFixture(); f.answers.set(root, true); await f.hold()
    f.io.fail('writeSync', 'alpha', { match: path => path === queuePath(f.dir) })
    expect(await f.resolver.resolve('alpha', 'live', true)).toBe('retrying')
    if (cancel === 'forget') f.resolver.forget('alpha'); else f.resolver.stop()
    expect(f.clock.pendingCount()).toBe(0)
    expect(await f.resolver.retryPending('alpha')).toBe('cancelled')
    if (cancel === 'stop') expect(await f.resolver.resolve('alpha', 'live')).toBe('cancelled')
    f.io.heal(); await f.clock.advance(RETYPE_BACKOFF_MS.at(-1)!)
    expect(f.releases).toHaveLength(0); expect(f.queue.unresolvedHolds('alpha')).toHaveLength(1)
  })

  test.each(['forget', 'stop'] as const)('%s cancels a pending save and a second-compaction retry', async cancel => {
    const f = await resolverFixture(); f.answers.set(root, true); await f.hold()
    const gate = Promise.withResolvers<void>()
    f.beforeSave(() => gate.promise)
    const pending = f.resolver.resolve('alpha', 'recovered', true)
    await f.clock.flush()
    if (cancel === 'forget') f.resolver.forget('alpha'); else f.resolver.stop()
    gate.resolve(); expect(await pending).toBe('cancelled')
    expect(f.queue.unresolvedHolds('alpha')).toHaveLength(1)
    expect(f.releases).toHaveLength(0); expect(f.events).toHaveLength(0)
    const other = await resolverFixture(); other.answers.set(root, true); await other.hold()
    other.io.fail('renameSync', 'alpha', { match: path => path.startsWith(queuePath(other.dir) + '.') })
    expect(await other.resolver.resolve('alpha', 'recovered', true)).toBe('resolved')
    await other.clock.flush()
    expect(other.clock.pending().map(t => t.delayMs)).toEqual([QUEUE_COMPACT_INTERVAL_MS])
    if (cancel === 'forget') other.resolver.forget('alpha'); else other.resolver.stop()
    expect(other.clock.pendingCount()).toBe(0)
  })
})

async function publicationFixture(stale: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-publication-')), clock = createFakeClock({ start: THREAD_TIME })
  const io = threadFsControls(dir), queue = await makeQueue(dir, { now: clock.now, fs: io.fs })
  const h = makeThreadMemoryHarness(dir, { clock, heldStamps: key => queue.unresolvedHolds(key).filter(hold => hold.memoryDependent) })
  await h.start()
  const fact = h.fact()
  await queue.accept('alpha', slackInput({ channel, via: 'mention', ts: fact.root, key: { chat_id: channel, ts: fact.root },
    thread_join: { thread_ts: fact.root, stamp: fact.stamp, at: fact.at } }))
  let sequence = 0
  async function hold() {
    const ts = `1700000200.${String(++sequence).padStart(6, '0')}`
    const result = await queue.accept('alpha', heldSlackInput(memoryHold(fact.at + 1, { stamp: fact.stamp }), { channel, ts, key: { chat_id: channel, ts } }))
    expect(result.status).toBe('accepted')
    if (result.status !== 'accepted') throw new Error('fixture hold not stored')
    return result.seq
  }
  const first = await hold()
  h.failShared(() => 'unsynced')
  expect((stale ? h.choose('mentions') : h.mode('open')).kind).toBe('unresolved')
  recoverQueuedJoins('alpha', queue, h.memory)
  const releases: Array<{ seq: number; mode: MemoryHoldMode; joined: boolean | 'unknown' }> = []
  const events: MemoryHoldEvent[] = [], wakes: Promise<unknown>[] = []
  const resolver = createMemoryHoldResolver({ queue, memory: h.memory, clock, now: clock.now,
    release(key, item, mode) { releases.push({ seq: item.accepted.seq, mode,
      joined: h.memory.joinedBy(key, channel, root, fact.stamp, fact.at + 1) }) }, onEvent: e => events.push(e) })
  h.unsubscribe()
  const unsubscribe = h.authority.subscribeThreadView(() => {
    h.memory.published()
    for (const key of queue.keys()) wakes.push(resolver.retryPending(key))
  })
  cleanups.push(async () => {
    unsubscribe(); resolver.stop(); await h.close(); await queue.stop()
    expect(clock.pendingCount()).toBe(0); assertNoLeak({ events, releases, memory: h.events })
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, h, clock, io, queue, first, hold, resolver, releases, events, wakes,
    publish() { h.failShared(); expect(h.authority.recoverDurability().kind).toBe('applied') } }
}

describe('B1 shared publication', () => {
  for (const stale of [false, true]) test.each(['live', 'recovered'] as const)(`${stale ? 'stale held' : 'same'} stamp preserves %s through unknown and repeated requests`, async mode => {
    const f = await publicationFixture(stale)
    expect(await f.resolver.resolve('alpha', mode)).toBe('unknown')
    expect(await f.resolver.resolve('alpha', mode === 'live' ? 'recovered' : 'live')).toBe('unknown')
    expect(f.queue.item('alpha', f.first)!.hold!.state).toBe('unresolved')
    expect(f.releases).toHaveLength(0); expect(f.events).toHaveLength(0)
    f.publish(); await Promise.all(f.wakes)
    expect(f.releases).toEqual([{ seq: f.first, mode, joined: true }])
    expect(f.queue.item('alpha', f.first)!.hold!.state).toBe('released')
    expect(f.h.memory.view('alpha', channel, root)).toBe(stale ? 'not-joined' : 'joined')
    expect(f.events).toHaveLength(0)
    await f.resolver.retryPending('alpha'); expect(f.releases).toHaveLength(1)
  })

  test('mixed modes survive a publication append failure; a wake never claims an unrequested hold', async () => {
    const f = await publicationFixture(true)
    expect(await f.resolver.resolve('alpha', 'recovered')).toBe('unknown')
    const second = await f.hold()
    expect(await f.resolver.resolve('alpha', 'live')).toBe('unknown')
    const third = await f.hold()
    f.io.fail('fsyncSync', 'alpha', { times: 1, match: path => path === queuePath(f.dir) })
    f.publish(); await Promise.all(f.wakes)
    expect(f.releases).toHaveLength(0)
    expect(f.events.map(e => e.type)).toEqual(['resolution-failed'])
    expect(f.queue.unresolvedHolds('alpha')).toHaveLength(3)
    await f.clock.advance(RETYPE_BACKOFF_MS[0]!)
    expect(f.releases).toEqual([{ seq: f.first, mode: 'recovered', joined: true }, { seq: second, mode: 'live', joined: true }])
    expect(f.queue.unresolvedHolds('alpha').map(h => h.seq)).toEqual([third])
    await f.resolver.retryPending('alpha'); expect(f.releases).toHaveLength(2)
    await f.resolver.resolve('alpha', 'live')
    expect(f.releases.at(-1)).toEqual({ seq: third, mode: 'live', joined: true })
    await f.resolver.retryPending('alpha'); expect(f.releases).toHaveLength(3)
  })

  test.each(['forget', 'stop'] as const)('%s cancels a publication already queued and future wakes', async cancel => {
    const f = await publicationFixture(false)
    expect(await f.resolver.resolve('alpha', 'recovered', true)).toBe('unknown')
    f.publish()
    if (cancel === 'forget') f.resolver.forget('alpha'); else f.resolver.stop()
    expect(await Promise.all(f.wakes)).toEqual(['cancelled'])
    expect(await f.resolver.retryPending('alpha')).toBe('cancelled')
    expect(f.queue.unresolvedHolds('alpha').map(h => h.seq)).toEqual([f.first])
    expect(f.releases).toHaveLength(0); expect(f.events).toHaveLength(0)
  })
})

function outageFixture(mode: ChannelMode) {
  const h = makeReloadHarness({ personaConfigDirs: true }), runs: ReloadRun[] = []
  const personas: PersonaInput[] = ['alpha', 'bravo'].map(name => h.persona(name, {
    channels: [{ id: channel, delivery: 'thread_hybrid' }, { id: neighbor, delivery: 'all' }],
    permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' },
  }))
  h.materialize(...personas)
  h.writeConfig({ channel_mode: mode, personas, queued_ack_reaction: 'hourglass' })
  let sequence = 0
  async function start(options: ReloadRunOptions = {}, beforeStart?: (run: ReloadRun) => void, afterResolve?: (run: ReloadRun) => void) {
    const run = h.build({ threadMemory: {},
      slack: Object.fromEntries(personas.map(p => [p.name, { inventory: [membershipPage([channel, neighbor])] }])), ...options })
    runs.push(run); beforeStart?.(run)
    expect(run.resolveStart().kind).toBe('applied')
    afterResolve?.(run)
    await run.controller.runStartBringUp(); await run.membershipClock.runNext()
    for (const p of personas) run.registerSession(p.name)
    await run.clock.flush()
    return run
  }
  async function intake(run: ReloadRun, kind: 'mention' | 'reply' | 'dm' | 'other' = 'reply', thread: string = root, key = 'alpha'): Promise<SlackEvent & { ts: string }> {
    const ts = `1700000300.${String(++sequence).padStart(6, '0')}`
    const event = kind === 'dm' ? makeDm({ ts, text: `dm ${sequence}` }) : makeChannelMessage({ ts,
      channel: kind === 'other' ? neighbor : channel, thread_ts: thread,
      text: kind === 'mention' ? `${mentionText(run.stub(key).identity.botUserId)} ${MESSAGE_BODY} join ${sequence}` : `${MESSAGE_BODY} ${sequence}` })
    await run.deliver(key, event); await run.clock.flush(); return { ...event, ts }
  }
  async function drain(run: ReloadRun, key = 'alpha', expectedParts?: readonly string[]) {
    await run.prepareQueued()
    const expected = expectedParts ?? run.queued(key).filter(isOpenItem).flatMap(i => i.fixed!.parts)
    const engine = await makeEngineHarness({ queue: run.queue, stateDir: h.stateDir, keys: [key] })
    try {
      await engine.tick(key); await engine.until(() => run.queue.openCount(key) === 0)
      expect(engine.textCalls(key).map(c => c.params.text)).toEqual([...expected])
      expect(engine.errors).toHaveLength(0); assertNoLeak({ calls: engine.calls, events: engine.events, errors: engine.errors })
    } finally { await engine.cleanup() }
  }
  function reactions(run: ReloadRun, key = 'alpha') {
    return run.stub(key).calls.reactionsAdd
  }
  cleanups.push(async () => {
    try {
      for (const run of runs) { assertNoLeak(run.captured()); await run.stop() }
      const directory = join(h.stateDir, 'threads')
      if (existsSync(directory)) {
        assertNoLeak(writtenFile(directory))
        for (const name of readdirSync(directory)) expect(readFileSync(join(directory, name), 'utf8')).not.toContain(MESSAGE_BODY)
      }
    } finally { await h.cleanup() }
  })
  return { h, personas, start, intake, drain, reactions }
}

describe.each(['strict', 'open'] as const)('%s Memory Hold outage', mode => {
  test('append retry saves kept joins without new traffic and reports one recovery', async () => {
    const f = outageFixture(mode), io = threadFsControls(f.h.stateDir)
    const run = await f.start({ threadMemory: { fs: io.fs } })
    io.fail('writeSync', 'alpha')
    await f.intake(run, 'mention')
    const reply = await f.intake(run)
    expect(run.queued('alpha').find(i => i.accepted.ts === reply.ts)!.accepted.via).toBe('thread')
    expect(run.threadMemory!.view('alpha', channel, root)).toBe('joined')
    expect(readThreads(f.h.stateDir).filter(r => r.kind === 'join')).toEqual([])
    await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(notices(run, 'Thread Memory not saved')).toHaveLength(1)
    expect(memoryLines(run, 'not-saved')).toHaveLength(1)
    await f.drain(run)
    io.heal(); await run.clock.advance(2 * THREAD_MEMORY_RETRY_MIN_MS)
    expect(readThreads(f.h.stateDir).filter(r => r.kind === 'join')).toHaveLength(1)
    expect(notices(run, 'Thread Memory recovered')).toHaveLength(1)
    expect(memoryLines(run, 'recovered')).toHaveLength(1)
    await run.clock.advance(4 * THREAD_MEMORY_RETRY_MIN_MS)
    expect(notices(run, 'Thread Memory recovered')).toHaveLength(1)
    expect(notices(run, 'Thread Memory not saved', 'bravo')).toEqual([])
    expectMemoryReportsSafe(run)
  })

  test('first successful retry releases live at its queue position and recovers only after kept joins save', async () => {
    const f = outageFixture(mode), first = await f.start()
    await f.intake(first, 'mention'); await f.drain(first); await first.stop()
    const io = threadFsControls(f.h.stateDir); io.fail('readFileSync', 'alpha')
    const run = await f.start({ threadMemory: { fs: io.fs } })
    const reply = await f.intake(run), held = run.queue.unresolvedHolds('alpha')[0]!
    await f.intake(run, 'mention', THREAD_ROOTS.third)
    expect(run.stub('alpha').socket.acks).toHaveLength(2)
    expect(f.reactions(run).some(a => a.timestamp === reply.ts)).toBe(false)
    expect(notices(run, 'Thread Memory unreadable')).toHaveLength(1)
    io.heal(); io.fail('writeSync', 'alpha')
    await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(run.heldReleases).toEqual([{ key: 'alpha', seq: held.seq, mode: 'live' }])
    expect(run.queue.unresolvedHolds('alpha')).toEqual([])
    expect(run.queued('alpha').filter(isOpenItem).map(i => i.accepted.ts)[0]).toBe(reply.ts)
    expect(f.reactions(run).filter(a => a.timestamp === reply.ts)).toHaveLength(1)
    expect(run.logs.filter(l => l.includes('received') && l.includes(reply.ts))).toHaveLength(1)
    expect(notices(run, 'Thread Memory recovered')).toEqual([])
    expect(notices(run, 'Thread Memory not saved')).toHaveLength(1)
    io.heal(); await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(notices(run, 'Thread Memory recovered')).toHaveLength(1)
    expect(memoryLines(run, 'recovered')).toHaveLength(1)
    await f.drain(run)
    expectMemoryReportsSafe(run)
  })

  test('quarantine and the hold it withdraws are each named once after a successful read retry', async () => {
    const f = outageFixture(mode), first = await f.start()
    await f.intake(first, 'mention'); await f.intake(first, 'mention', THREAD_ROOTS.third)
    await f.drain(first); await first.queue.compact('alpha'); await first.stop()
    const records = readThreads(f.h.stateDir)
    const damaged = records.find(r => r.kind === 'join' && r.root === root)!
    seedThreads(f.h.stateDir, records.map(r => r === damaged ? damagedThreadLine(r, 'json') : r))
    const io = threadFsControls(f.h.stateDir); io.fail('readFileSync', 'alpha')
    const run = await f.start({ threadMemory: { fs: io.fs } }), reply = await f.intake(run)
    expect(run.queue.unresolvedHolds('alpha')).toHaveLength(1)
    io.heal(); await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(run.memoryHoldEvents).toEqual([expect.objectContaining({ type: 'withdrawn', holds: [expect.objectContaining({ thread_ts: root, ts: reply.ts })] })])
    const losses = notices(run, 'Joins lost')
    expect(losses).toHaveLength(2)
    expect(losses.every(p => String(p.text).includes(root))).toBe(true)
    expect(losses.filter(p => String(p.text).includes(reply.ts))).toHaveLength(1)
    expect(memoryLines(run, 'joins-lost')).toHaveLength(2)
    expect(run.threadMemory!.view('alpha', channel, root)).toBe('not-joined')
    expect(f.reactions(run).some(a => a.timestamp === reply.ts)).toBe(false)
    await run.memoryHolds!.resolve('alpha', 'live'); await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(notices(run, 'Joins lost')).toHaveLength(2)
    expectMemoryReportsSafe(run)
  })

  test('changed-while-stopped startup finding waits for notifier wiring and posts once', async () => {
    const f = outageFixture(mode), first = await f.start()
    await f.intake(first, 'mention'); await f.drain(first); await first.stop()
    const io = threadFsControls(f.h.stateDir); io.removeJournal()
    const run = await f.start({}, pending => {
      expect(pending.threadMemoryReporting).toBeUndefined()
      expect(pending.episodeNotices).toEqual([])
    })
    expect(notices(run, 'Thread Memory changed while stopped')).toHaveLength(1)
    expect(memoryLines(run, 'changed-while-stopped')).toHaveLength(1)
    run.threadMemoryReporting!.startupFindings(run.threadMemorySeal!.startupFindings())
    await run.clock.flush()
    expect(notices(run, 'Thread Memory changed while stopped')).toHaveLength(1)
    expectMemoryReportsSafe(run)
  })

  test.each(['append', 'read'] as const)('%s outage does not block unrelated traffic or its own explicit mentions and broadcasts', async failure => {
    type ExpectedDelivery = { event: SlackEvent; chat_id: string; via: Via }
    const partsFor = ({ event, chat_id, via }: ExpectedDelivery) => buildTagParts({
      chat_id, channel_name: via === 'dm' ? 'dm' : `stub-${chat_id.toLowerCase()}`,
      message_id: String(event.ts), ts: String(event.ts), thread_ts: event.thread_ts as string | undefined,
      user: 'stub-user', user_id: String(event.user), via, text: String(event.text),
    })
    const f = outageFixture(mode), io = threadFsControls(f.h.stateDir), first = await f.start()
    const seedAlpha = await f.intake(first, 'mention'), seedBravo = await f.intake(first, 'mention', root, 'bravo')
    await f.drain(first, 'alpha', partsFor({ event: seedAlpha, chat_id: channel, via: 'mention' }))
    await f.drain(first, 'bravo', partsFor({ event: seedBravo, chat_id: channel, via: 'mention' }))
    await first.stop()
    if (failure === 'read') io.fail('readFileSync', 'alpha')
    const run = await f.start({ threadMemory: { fs: io.fs } })
    const keys = ['alpha', 'bravo'] as const
    const previous = Object.fromEntries(keys.map(key => [key, Math.max(0, ...run.queue.items(key).map(i => i.accepted.seq))]))
    const newItems = (key: string) => run.queue.items(key).filter(i => i.accepted.seq > previous[key]!)
    const population = (items: ReturnType<typeof newItems>) => items.map(i => ({ ts: i.accepted.ts, chat_id: i.accepted.channel, via: i.accepted.via }))
    if (failure === 'append') io.fail('writeSync', 'alpha')
    const hybridMention = await f.intake(run, 'mention', THREAD_ROOTS.third)
    const reply = await f.intake(run), other = await f.intake(run, 'other'), dm = await f.intake(run, 'dm')
    const sibling = await f.intake(run, 'reply', root, 'bravo')
    const broadcast = makeChannelMessage({ channel, ts: '1700000400.000001', thread_ts: THREAD_ROOTS.secondary, text: broadcastText() })
    await run.deliver('alpha', broadcast)
    const before = run.queue.items('alpha').length
    const authority = run.controller.sharedChannels()!
    const suppressed: SlackEvent[] = []
    for (const delivery of ['off', 'mentions'] as const) {
      expect(authority.assign('alpha', authority.incarnation('alpha')!, neighbor, delivery, authority.revision).kind).toBe('applied')
      const plain = makeChannelMessage({ channel: neighbor, ts: delivery === 'off' ? '1700000400.000002' : '1700000400.000003' })
      suppressed.push(plain)
      await run.deliver('alpha', plain)
      expect(run.queue.items('alpha')).toHaveLength(before)
    }
    const mentioned = makeChannelMessage({ channel: neighbor, ts: '1700000400.000004', text: mentionText(run.stub('alpha').identity.botUserId) })
    await run.deliver('alpha', mentioned); await run.clock.flush()
    // The scenario, never the queue's contents, defines both admission and
    // the exact messages the real engine must deliver during the outage.
    const expected: Record<typeof keys[number], ExpectedDelivery[]> = {
      alpha: [
        { event: hybridMention, chat_id: channel, via: 'mention' },
        ...(failure === 'append' ? [{ event: reply, chat_id: channel, via: 'thread' as const }] : []),
        { event: other, chat_id: neighbor, via: 'receive_all_shared' },
        { event: dm, chat_id: String(dm.channel), via: 'dm' },
        { event: broadcast, chat_id: channel, via: 'broadcast' },
        { event: mentioned, chat_id: neighbor, via: 'mention' },
      ],
      bravo: [{ event: sibling, chat_id: channel, via: 'thread' }],
    }
    for (const key of keys) {
      const wanted = expected[key].map(({ event, chat_id, via }) => ({ ts: String(event.ts), chat_id, via }))
      expect(population(newItems(key).filter(isOpenItem))).toEqual(wanted)
      const held = key === 'alpha' && failure === 'read'
        ? [{ ts: reply.ts, channel, thread_ts: root }] : []
      expect(population(newItems(key))).toEqual(held.length
        ? [wanted[0]!, { ts: reply.ts, chat_id: channel, via: 'thread' }, ...wanted.slice(1)] : wanted)
      const heldPopulation = () => run.queue.unresolvedHolds(key).map(h => ({
        ts: run.queue.item(key, h.seq)!.accepted.ts, channel: h.channel, thread_ts: h.thread_ts,
      }))
      expect(heldPopulation()).toEqual(held)
      expect(newItems(key).filter(i => suppressed.some(event => event.ts === i.accepted.ts))).toEqual([])
      expect(f.reactions(run, key).filter(a => suppressed.some(event => event.ts === a.timestamp))).toEqual([])
      await f.drain(run, key, expected[key].flatMap(partsFor))
      expect(population(newItems(key).filter(i => i.delivered))).toEqual(wanted)
      expect(heldPopulation()).toEqual(held)
    }
    if (failure === 'read') expect(f.reactions(run).filter(a => a.timestamp === reply.ts)).toEqual([])
    expectMemoryReportsSafe(run)
  })

  test.each(['append', 'read'] as const)('teardown cancels %s retries and bring-up starts a fresh episode', async failure => {
    const f = outageFixture(mode), io = threadFsControls(f.h.stateDir), first = await f.start()
    await f.intake(first, 'mention'); await first.stop()
    if (failure === 'read') io.fail('readFileSync', 'alpha')
    const run = await f.start({ threadMemory: { fs: io.fs } })
    if (failure === 'append') { io.fail('writeSync', 'alpha'); await f.intake(run, 'mention', THREAD_ROOTS.third) }
    const title = failure === 'append' ? 'Thread Memory not saved' : 'Thread Memory unreadable'
    expect(notices(run, title)).toHaveLength(1)
    const persona = run.serverConfig()!.personas.find(p => p.key === 'alpha')!
    await run.composition!.lifecycle.teardown(persona)
    const attempts = io.calls.length
    await run.clock.advance(4 * THREAD_MEMORY_RETRY_MIN_MS)
    expect(io.calls).toHaveLength(attempts)
    expect(run.threadMemoryRetryEvents).toContainEqual({ type: 'retry-cancelled', series: failure, key: 'alpha', why: 'teardown' })
    await run.composition!.lifecycle.bringUp(persona, run.serverConfig()!)
    run.registerSession('alpha'); await run.clock.flush()
    if (failure === 'append') await f.intake(run, 'mention', THREAD_ROOTS.third)
    expect(notices(run, title)).toHaveLength(2)
    expectMemoryReportsSafe(run)
  })

  test.each(['append', 'read'] as const)('shutdown cancels %s retries and stops seal retry only after the final write', async failure => {
    const f = outageFixture(mode), first = await f.start()
    await f.intake(first, 'mention'); await first.stop()
    const io = threadFsControls(f.h.stateDir), sealIo = threadSealFsControls(f.h.stateDir)
    if (failure === 'read') io.fail('readFileSync', 'alpha')
    const run = await f.start({ threadMemory: { fs: io.fs, sealFs: sealIo.fs } })
    if (failure === 'append') { io.fail('writeSync', 'alpha'); await f.intake(run, 'mention', THREAD_ROOTS.third) }
    sealIo.failWrite()
    expect((await run.threadMemorySeal!.writeShutdown(run.threadMemory!.completedStores())).kind).toBe('failed')
    const order: string[] = []
    const stopKeys = run.threadMemoryRetries!.stopKeys, stopSeal = run.threadMemoryRetries!.stopSeal, write = run.threadMemorySeal!.writeShutdown
    run.threadMemoryRetries!.stopKeys = () => { order.push('keys'); stopKeys() }
    run.threadMemorySeal!.writeShutdown = async stores => { order.push('shutdown'); return write(stores) }
    run.threadMemoryRetries!.stopSeal = () => { order.push('seal'); stopSeal() }
    sealIo.heal(); await run.stop()
    expect(order).toEqual(['keys', 'shutdown', 'seal'])
    expect(run.clock.pendingCount()).toBe(0)
    const calls = [io.calls.length, sealIo.calls.length], posts = notices(run, 'Thread Memory recovered').length
    await run.clock.advance(8 * THREAD_MEMORY_RETRY_MIN_MS)
    expect([io.calls.length, sealIo.calls.length]).toEqual(calls)
    expect(notices(run, 'Thread Memory recovered')).toHaveLength(posts)
    if (failure === 'append') expect(readThreadSeal(f.h.stateDir).entries.alpha!.clean).toBe(true)
    expectMemoryReportsSafe(run)
  })

  test.each(['submitted', 'open'] as const)('an admitted store flush is cancelled in the %s teardown window and its kept join recovers in the next life', async window => {
    const f = outageFixture(mode), io = threadFsControls(f.h.stateDir)
    const stop = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let sequenceStops = 0
    const run = await f.start({ threadMemory: { fs: io.fs, stopSequence: key => {
      if (key === 'alpha' && window === 'open' && ++sequenceStops === 2) return stop.promise
      return Promise.resolve()
    } } })
    io.fail('writeSync', 'alpha')
    await f.intake(run, 'mention')
    const fact = run.queued('alpha')[0]!.accepted.thread_join!
    const before = readFileSync(threadPath(f.h.stateDir)), authority = run.controller.sharedChannels()!
    const stamp = authority.channelStamp('alpha', channel)
    const persona = run.serverConfig()!.personas.find(p => p.key === 'alpha')!
    const priorTurn = window === 'submitted' ? run.inPersonaTurn('alpha', () => stop.promise) : Promise.resolve()
    const flush = run.threadMemory!.flush
    let pending: ReturnType<typeof flush> | undefined
    run.threadMemory!.flush = key => {
      const result = flush(key) // The real store writer is already queued before cancellation.
      if (key === 'alpha') { pending = result; entered.resolve() }
      return result
    }
    io.heal()
    const timer = run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    await entered.promise
    const teardown = run.composition!.lifecycle.teardown(persona)
    try {
      expect(run.threadMemoryWindow('alpha')).toBe('submitted')
      await timer
      expect(run.threadMemoryWindow('alpha')).toBe(window)
      expect(run.appliedKeys()).toContain('alpha')
      expect(await pending).toEqual({ kind: 'cancelled' })
      expect(readFileSync(threadPath(f.h.stateDir))).toEqual(before)
      expect(run.threadMemory!.keptFacts('alpha')).toEqual([expect.objectContaining({ at: fact.at, stamp: fact.stamp })])
      expect(run.threadMemoryEvents.filter(e => e.key === 'alpha' && (e.type === 'saved-after-failure' || e.type === 'outage-settled'))).toEqual([])
      expect(notices(run, 'Thread Memory recovered')).toEqual([])
      // A late old-life failure cannot acquire another owner; a sibling still saves.
      const attempts = io.calls.filter(c => c.path === threadPath(f.h.stateDir)).length
      run.observeThreadMemoryEvent(run.threadMemoryEvents.find(e => e.type === 'append-failed' && e.key === 'alpha')!)
      await f.intake(run, 'mention', THREAD_ROOTS.third, 'bravo')
      await run.clock.advance(4 * THREAD_MEMORY_RETRY_MIN_MS)
      expect(io.calls.filter(c => c.path === threadPath(f.h.stateDir))).toHaveLength(attempts)
      expect(readThreads(f.h.stateDir, 'bravo').filter(r => r.kind === 'join')).toHaveLength(1)
      expect(notices(run, 'Thread Memory not saved')).toHaveLength(1)
    } finally {
      run.threadMemory!.flush = flush
      stop.resolve(); await priorTurn; await teardown; await timer
    }
    // Keep the channel incarnation: real queue recovery, not a test-injected join,
    // must save the retained fact after the old journal owner was forgotten.
    run.stub('alpha').script.inventory.push(membershipPage([channel, neighbor]))
    await run.composition!.lifecycle.bringUp(persona, run.serverConfig()!)
    run.registerSession('alpha'); await run.membershipClock.runNext(); await run.clock.flush()
    expect(authority.channelStamp('alpha', channel)).toEqual(stamp)
    expect(readThreads(f.h.stateDir).filter(r => r.kind === 'join')).toEqual([
      expect.objectContaining({ root, at: fact.at, stamp: fact.stamp }),
    ])
    expect(run.threadMemory!.outage('alpha')).toEqual({ unknown: false, missing: false, unsaved: 0 })
    const reply = await f.intake(run)
    expect(run.queued('alpha').find(i => i.accepted.ts === reply.ts)!.accepted.via).toBe('thread')
    await run.clock.advance(8 * THREAD_MEMORY_RETRY_MIN_MS)
    expect(readThreads(f.h.stateDir).filter(r => r.kind === 'join')).toHaveLength(1)
    // Teardown ended the old episode: saving the next life's recovered fact is quiet.
    expect(notices(run, 'Thread Memory recovered')).toEqual([])
    expect(memoryLines(run, 'recovered')).toEqual([])
    expectMemoryReportsSafe(run)
  })

  test('a kept incoming join survives an undecided first read and recovers once after real publication without traffic', async () => {
    const f = outageFixture(mode), first = await f.start()
    await first.stop()
    const io = threadFsControls(f.h.stateDir); io.fail('readFileSync', 'alpha')
    const run = await f.start({ threadMemory: { fs: io.fs } })
    await f.intake(run, 'mention')
    const fact = run.queued('alpha')[0]!.accepted.thread_join!, authority = run.controller.sharedChannels()!
    const before = readFileSync(threadPath(f.h.stateDir))
    f.h.failChannelDeliveryWrites({ step: 'fsyncSync', call: 2 })
    expect(authority.assign('alpha', authority.incarnation('alpha')!, channel, 'thread_hybrid', authority.revision).kind).toBe('unresolved')
    expect(authority.channelStamp('alpha', channel)).toEqual({ kind: 'undecided' })
    io.heal(); await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(run.threadMemory!.outage('alpha')).toEqual({ unknown: false, missing: false, unsaved: 1 })
    expect(run.threadMemoryRetryEvents.filter(e => e.type === 'append-retry-started')).toEqual([{ type: 'append-retry-started', key: 'alpha' }])
    expect(notices(run, 'Thread Memory recovered')).toEqual([])
    f.h.clearChannelDeliveryWriteFailure()
    expect(authority.recoverDurability().kind).toBe('applied')
    await run.clock.flush()
    expect(readFileSync(threadPath(f.h.stateDir))).toEqual(before)
    expect(notices(run, 'Thread Memory recovered')).toEqual([])
    await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(readThreads(f.h.stateDir).filter(r => r.kind === 'join')).toEqual([expect.objectContaining({ at: fact.at, stamp: fact.stamp, root })])
    expect(notices(run, 'Thread Memory unreadable')).toHaveLength(1)
    expect(notices(run, 'Thread Memory recovered')).toHaveLength(1)
    expect(memoryLines(run, 'recovered')).toHaveLength(1)
    expect(notices(run, 'Thread Memory not saved')).toEqual([])
    run.threadMemory!.published(); await run.clock.advance(4 * THREAD_MEMORY_RETRY_MIN_MS)
    expect(notices(run, 'Thread Memory recovered')).toHaveLength(1)
    expect(memoryLines(run, 'recovered')).toHaveLength(1)
    expect(readThreads(f.h.stateDir).filter(r => r.kind === 'join')).toHaveLength(1)
    expectMemoryReportsSafe(run)
  })

  test.each(['saved', 'failed'] as const)('real publication recovers a queued join and releases its live hold; recovery waits for a %s append', async outcome => {
    const appendFails = outcome === 'failed'
    const f = outageFixture(mode), io = threadFsControls(f.h.stateDir)
    const first = await f.start({ threadMemory: { fs: io.fs } })
    io.fail('writeSync', 'alpha'); await f.intake(first, 'mention'); await first.crash()
    io.heal(); io.fail('readFileSync', 'alpha')
    const run = await f.start({ threadMemory: { fs: io.fs } })
    const reply = await f.intake(run), held = run.queue.unresolvedHolds('alpha')[0]!
    const authority = run.controller.sharedChannels()!
    f.h.failChannelDeliveryWrites({ step: 'fsyncSync', call: 2 })
    expect(authority.assign('alpha', authority.incarnation('alpha')!, channel, 'thread_hybrid', authority.revision).kind).toBe('unresolved')
    io.heal(); await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(run.threadMemory!.outage('alpha')).toEqual({ unknown: false, missing: false, unsaved: 1 })
    expect(run.queue.unresolvedHolds('alpha')).toHaveLength(1)
    expect(notices(run, 'Thread Memory recovered')).toEqual([])
    const before = readFileSync(threadPath(f.h.stateDir))
    if (appendFails) io.fail('fsyncSync', 'alpha')
    f.h.clearChannelDeliveryWriteFailure()
    expect(authority.recoverDurability().kind).toBe('applied')
    await run.clock.flush()
    expect(run.heldReleases).toEqual([{ key: 'alpha', seq: held.seq, mode: 'live' }])
    expect(run.queue.unresolvedHolds('alpha')).toEqual([])
    expect(f.reactions(run).filter(a => a.timestamp === reply.ts)).toHaveLength(1)
    expect(run.logs.filter(l => l.includes('received') && l.includes(reply.ts))).toHaveLength(1)
    expect(run.threadMemory!.outage('alpha').unsaved).toBe(appendFails ? 1 : 0)
    if (appendFails) expect(readFileSync(threadPath(f.h.stateDir))).toEqual(before)
    expect(notices(run, 'Thread Memory not saved')).toHaveLength(appendFails ? 1 : 0)
    expect(notices(run, 'Thread Memory recovered')).toHaveLength(appendFails ? 0 : 1)
    expect(memoryLines(run, 'recovered')).toHaveLength(appendFails ? 0 : 1)
    io.heal(); await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(readThreads(f.h.stateDir).filter(r => r.kind === 'join')).toHaveLength(1)
    expect(notices(run, 'Thread Memory recovered')).toHaveLength(1)
    expect(memoryLines(run, 'recovered')).toHaveLength(1)
    run.threadMemory!.published(); await run.memoryHolds!.retryPending('alpha')
    await run.clock.advance(4 * THREAD_MEMORY_RETRY_MIN_MS)
    expect(run.heldReleases).toHaveLength(1)
    expect(notices(run, 'Thread Memory recovered')).toHaveLength(1)
    expect(memoryLines(run, 'recovered')).toHaveLength(1)
    await f.drain(run)
    expectMemoryReportsSafe(run)
  })

  test.each(['before-append', 'durable-completion', 'synchronous-queue-observer', 'release-feedback'] as const)(
    'firstRead cancellation at %s preserves exactly one committed loss across same-key bring-up', async boundary => {
      const f = outageFixture(mode), first = await f.start()
      await f.intake(first, 'mention'); await f.drain(first); await first.stop()
      const io = threadFsControls(f.h.stateDir); io.fail('readFileSync', 'alpha')
      const stop = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>(), feedback = Promise.withResolvers<void>()
      const beforeAppend = Promise.withResolvers<void>()
      let atCommit = () => {}, teardown: Promise<void> | undefined, pending: Promise<unknown> | undefined
      const run = await f.start({ threadMemory: { fs: io.fs,
        onQueueEvent: e => { if (e.type === 'holds-resolved' && e.key === 'alpha') atCommit() },
        stopSequence: key => key === 'alpha' ? stop.promise : Promise.resolve(),
        beforeRelease: key => {
          if (key !== 'alpha') return Promise.resolve()
          reached.resolve(); return feedback.promise
        },
      } })
      const released = await f.intake(run), withdrawn = await f.intake(run, 'reply', THREAD_ROOTS.secondary)
      const holds = run.queue.unresolvedHolds('alpha')
      expect(holds).toHaveLength(2)
      const persona = run.serverConfig()!.personas.find(p => p.key === 'alpha')!
      const submit = () => { teardown = run.composition!.lifecycle.teardown(persona); reached.resolve() }
      if (boundary === 'durable-completion') atCommit = () => queueMicrotask(submit)
      if (boundary === 'synchronous-queue-observer') atCommit = submit
      const resolve = run.memoryHolds!.resolve
      run.memoryHolds!.resolve = (...args) => { const result = resolve(...args); if (args[0] === 'alpha') pending = result; return result }
      const save = run.queue.resolveHolds
      if (boundary === 'before-append') run.queue.resolveHolds = async (key, decisions, current, committed) => {
        if (key === 'alpha') { reached.resolve(); await beforeAppend.promise }
        return save(key, decisions, current, committed)
      }
      try {
        io.heal(); await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS); await reached.promise
        if (boundary === 'release-feedback' || boundary === 'before-append') submit()
        expect(run.threadMemoryWindow('alpha')).not.toBe('none')
        expect(run.appliedKeys()).toContain('alpha')
        beforeAppend.resolve(); feedback.resolve(); await run.clock.flush()
        expect(await pending).toBe('cancelled')
        const committed = boundary !== 'before-append'
        expect(run.queue.unresolvedHolds('alpha')).toHaveLength(committed ? 0 : 2)
        expect(readQueue(f.h.stateDir).filter(r => r.kind === 'withdrawn')).toHaveLength(committed ? 1 : 0)
        expect(run.memoryHoldEvents.filter(e => e.type === 'withdrawn')).toHaveLength(committed ? 1 : 0)
        expect(run.heldReleases).toHaveLength(boundary === 'release-feedback' ? 1 : 0)
        expect(run.threadMemoryRetryEvents.filter(e => e.type === 'read-after-retries')).toEqual([])
        const writes = io.writes().length
        run.threadMemoryRetries!.appendFailed('alpha')
        run.observeThreadMemoryEvent(run.threadMemoryEvents.find(e => e.type === 'read-failed' && e.key === 'alpha')!)
        expect(await run.memoryHolds!.resolve('alpha', 'live')).toBe('cancelled')
        await run.clock.advance(4 * THREAD_MEMORY_RETRY_MIN_MS)
        expect(io.writes()).toHaveLength(writes)
        stop.resolve(); await teardown
        atCommit = () => {}; run.queue.resolveHolds = save
        await run.composition!.lifecycle.bringUp(persona, run.serverConfig()!)
        run.registerSession('alpha'); await run.clock.flush()
        expect(run.queue.unresolvedHolds('alpha')).toEqual([])
        expect(run.memoryHoldEvents.filter(e => e.type === 'withdrawn')).toEqual([{
          type: 'withdrawn', key: 'alpha', holds: [{ seq: holds[1]!.seq, channel, thread_ts: THREAD_ROOTS.secondary, ts: withdrawn.ts }],
        }])
        expect(notices(run, 'Joins lost')).toHaveLength(1)
        expect(String(notices(run, 'Joins lost')[0]!.text)).toContain(withdrawn.ts)
        expect(memoryLines(run, 'joins-lost')).toHaveLength(1)
        expect(run.heldReleases).toHaveLength(boundary === 'before-append' || boundary === 'release-feedback' ? 1 : 0)
        await run.memoryHolds!.resolve('alpha', 'live'); await run.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
        expect(notices(run, 'Joins lost')).toHaveLength(1)
        expect(memoryLines(run, 'joins-lost')).toHaveLength(1)
        expect(run.queue.items('alpha').filter(isOpenItem).map(i => i.accepted.ts)).toEqual([released.ts])
        await f.drain(run); expectMemoryReportsSafe(run)
      } finally { beforeAppend.resolve(); feedback.resolve(); stop.resolve(); await pending; await teardown }
    },
  )

  test.each([false, true])('startup defers eligible holds until shared publication recovers their joins (stale=%s)', async stale => {
    const f = outageFixture(mode), io = threadFsControls(f.h.stateDir)
    const first = await f.start({ threadMemory: { fs: io.fs } })
    io.fail('writeSync', 'alpha')
    await f.intake(first, 'mention')
    expect(readThreads(f.h.stateDir).filter(r => r.kind === 'join')).toHaveLength(0)
    await first.crash(); io.heal(); io.fail('readFileSync', 'alpha')
    const second = await f.start({ threadMemory: { fs: io.fs } })
    const event = await f.intake(second), held = second.queue.unresolvedHolds('alpha')[0]!
    expect(held).toBeDefined()
    await second.crash(); io.heal()
    const third = await f.start({}, undefined, run => {
      const authority = run.controller.sharedChannels()!
      f.h.failChannelDeliveryWrites({ step: 'fsyncSync', call: 2 })
      expect(authority.assign('alpha', authority.incarnation('alpha')!, channel,
        stale ? 'mentions' : 'thread_hybrid', authority.revision).kind).toBe('unresolved')
    })
    expect(third.queue.unresolvedHolds('alpha').map(h => h.seq)).toEqual([held.seq])
    expect(third.heldReleases).toHaveLength(0); expect(third.memoryHoldEvents).toHaveLength(0)
    f.h.clearChannelDeliveryWriteFailure()
    expect(third.controller.sharedChannels()!.recoverDurability().kind).toBe('applied')
    await third.clock.flush()
    expect(third.heldReleases).toEqual([{ key: 'alpha', seq: held.seq, mode: 'recovered' }])
    expect(third.queue.unresolvedHolds('alpha')).toHaveLength(0)
    expect(third.threadMemory!.view('alpha', channel, root)).toBe(stale ? 'not-joined' : 'joined')
    expect(f.reactions(third).filter(a => a.timestamp === event.ts)).toHaveLength(1)
    expect(third.memoryHoldEvents).toHaveLength(0)
    await third.memoryHolds!.retryPending('alpha'); expect(third.heldReleases).toHaveLength(1)
    await f.drain(third)
  })

  test('restarts retain holds, let unrelated work pass, then release/withdraw once with recovered feedback and durable dedupe', async () => {
    const f = outageFixture(mode), first = await f.start()
    await f.intake(first, 'mention'); await f.intake(first, 'mention', root, 'bravo')
    await f.drain(first); await f.drain(first, 'bravo'); await first.stop()
    const io = threadFsControls(f.h.stateDir); io.fail('readFileSync', 'alpha')
    const second = await f.start({ threadMemory: { fs: io.fs } })
    await second.clock.advance(42_000)
    const held = await f.intake(second), absent = await f.intake(second, 'reply', THREAD_ROOTS.secondary)
    const holds = second.queue.unresolvedHolds('alpha'), seq = holds[0]!.seq
    expect(holds).toHaveLength(2); expect(second.queue.openCount('alpha')).toBe(0)
    expect(second.stub('alpha').socket.acks).toHaveLength(2)
    expect(f.reactions(second)).toHaveLength(0); expect(second.heldReleases).toHaveLength(0)
    expect(second.queued('alpha').filter(i => i.hold).every(i => i.fixed === undefined)).toBe(true)
    await second.deliver('alpha', held); expect(second.queue.unresolvedHolds('alpha')).toHaveLength(2)
    await f.intake(second, 'other'); await f.intake(second, 'dm'); await f.intake(second, 'mention', THREAD_ROOTS.third)
    await f.intake(second, 'reply', root, 'bravo')
    await f.drain(second); await f.drain(second, 'bravo')
    expect(second.queue.unresolvedHolds('alpha')).toHaveLength(2)
    expect(f.reactions(second).some(a => a.timestamp === held.ts || a.timestamp === absent.ts)).toBe(false)
    await second.crash()
    const stillUnknown = await f.start({ threadMemory: { fs: io.fs } })
    expect(stillUnknown.queue.unresolvedHolds('alpha')).toEqual(holds)
    expect(stillUnknown.heldReleases).toHaveLength(0)
    await f.intake(stillUnknown, 'reply', THREAD_ROOTS.third)
    const latestArrival = Math.max(...stillUnknown.queue.unresolvedHolds('alpha').map(h => h.arrived_at))
    expect(latestArrival).toBeGreaterThan(Math.max(...holds.map(h => h.arrived_at)))
    await stillUnknown.stop(); io.heal()
    const third = await f.start()
    expect(third.heldReleases).toContainEqual({ key: 'alpha', seq, mode: 'recovered' })
    expect(third.queue.unresolvedHolds('alpha')).toHaveLength(0)
    const released = third.queue.item('alpha', seq)!
    expect(released.accepted.released_at).toBe(third.clock.now())
    expect(itemOpenedAt(released)).toBe(released.accepted.released_at!)
    expect(itemOpenedAt(released)).not.toBe(released.accepted.received_at)
    expect(released.hold).toBeUndefined(); expect(third.queue.openCount('alpha')).toBe(2)
    expect(third.memoryHoldEvents).toEqual([{ type: 'withdrawn', key: 'alpha', holds: [{ seq: holds[1]!.seq, channel,
      thread_ts: THREAD_ROOTS.secondary, ts: absent.ts }] }])
    expect(notices(third, 'Joins lost')).toHaveLength(1)
    expect(String(notices(third, 'Joins lost')[0]!.text)).toContain(absent.ts)
    expect(memoryLines(third, 'joins-lost')).toHaveLength(1)
    expect(memoryLines(third, 'joins-lost')[0]).toContain(absent.ts)
    expectMemoryReportsSafe(third)
    expect(f.reactions(third).filter(a => a.timestamp === held.ts)).toEqual([expect.objectContaining({ name: 'hourglass', channel, timestamp: held.ts })])
    expect(f.reactions(third).some(a => a.timestamp === absent.ts)).toBe(false)
    expect(readQueue(f.h.stateDir).filter(r => r.kind === 'released' || r.kind === 'withdrawn')).toHaveLength(0)
    const count = third.queued('alpha').length
    await third.deliver('alpha', held); await third.deliver('alpha', absent)
    expect(third.queued('alpha')).toHaveLength(count)
    await f.intake(third, 'mention', THREAD_ROOTS.secondary)
    expect(third.queued('alpha').at(-1)!.accepted.thread_join!.at).toBeGreaterThan(latestArrival)
    expect(third.queue.items('bravo')).toHaveLength(0); expect(third.heldReleases.filter(r => r.key === 'bravo')).toHaveLength(0)
    await f.drain(third); await third.crash()
    const fourth = await f.start()
    expect(fourth.heldReleases).toHaveLength(0); expect(f.reactions(fourth)).toHaveLength(0)
    await fourth.deliver('alpha', held); await fourth.deliver('alpha', absent)
    expect(fourth.queue.openCount('alpha')).toBe(0)
  })

  test.each(['later join', 'other stamp', 'stale named'] as const)('%s is judged against the original arrival and stamp', async scenario => {
    const f = outageFixture(mode), first = await f.start()
    if (scenario !== 'later join') await f.intake(first, 'mention')
    // Ensure a readable empty journal exists without seeding a join.
    if (scenario === 'later join') await f.intake(first, 'mention', THREAD_ROOTS.third)
    await f.drain(first); await first.stop()
    const io = threadFsControls(f.h.stateDir); io.fail('readFileSync', 'alpha')
    const second = await f.start({ threadMemory: { fs: io.fs } }), authority = second.controller.sharedChannels()!
    const choose = (delivery: 'mentions' | 'thread_hybrid') => expect(authority.assign('alpha', authority.incarnation('alpha')!, channel, delivery, authority.revision).kind).toBe('applied')
    if (scenario === 'other stamp') { choose('mentions'); choose('thread_hybrid') }
    const event = await f.intake(second), hold = second.queue.unresolvedHolds('alpha')[0]!
    if (scenario === 'later join') await f.intake(second, 'mention')
    if (scenario === 'stale named') { choose('mentions'); choose('thread_hybrid') }
    await second.crash(); io.heal()
    const third = await f.start()
    if (scenario === 'stale named') {
      expect(third.heldReleases).toEqual([{ key: 'alpha', seq: hold.seq, mode: 'recovered' }])
      expect(third.threadMemory!.view('alpha', channel, root)).toBe('not-joined')
      await f.drain(third); await third.threadMemory!.compact('alpha'); await third.queue.compact('alpha')
      expect(readThreads(f.h.stateDir).filter(r => r.kind === 'join' && r.root === root)).toHaveLength(0)
      expect(readQueue(f.h.stateDir).filter(r => r.kind === 'accepted' && 'thread_join' in r)).toHaveLength(0)
    } else {
      expect(third.heldReleases).toHaveLength(0)
      expect(third.memoryHoldEvents).toEqual([{ type: 'withdrawn', key: 'alpha', holds: [{ seq: hold.seq, channel, thread_ts: root, ts: event.ts }] }])
      expect(f.reactions(third).some(a => a.timestamp === event.ts)).toBe(false)
    }
  })

  async function heldRun() {
    const f = outageFixture(mode), first = await f.start()
    await f.intake(first, 'mention'); await f.drain(first); await first.stop()
    const io = threadFsControls(f.h.stateDir); io.fail('readFileSync', 'alpha')
    const run = await f.start({ threadMemory: { fs: io.fs } })
    const event = await f.intake(run), hold = run.queue.unresolvedHolds('alpha')[0]!
    expect(run.queue.openCount('alpha')).toBe(0)
    return { ...f, io, run, event, hold }
  }

  test('bring-up recovers joins before resolving retained work as recovered', async () => {
    const f = await heldRun(), p = f.run.serverConfig()!.personas.find(p => p.key === 'alpha')!
    await f.run.composition!.lifecycle.teardown(p)
    f.io.heal()
    await f.run.composition!.lifecycle.bringUp(p, f.run.serverConfig()!)
    f.run.registerSession('alpha'); await f.run.clock.flush()
    expect(f.run.heldReleases).toEqual([{ key: 'alpha', seq: f.hold.seq, mode: 'recovered' }])
    expect(f.run.threadMemory!.view('alpha', channel, root)).toBe('joined')
    expect(f.run.queue.openCount('alpha')).toBe(1)
    expect(f.reactions(f.run).filter(a => a.timestamp === f.event.ts)).toHaveLength(1)
    await f.drain(f.run)
  })

  test.each(['saved', 'failed append'] as const)('crash after %s before second compaction never repeats a saved release', async boundary => {
    const f = await heldRun(); await f.run.crash(); f.io.heal()
    const queueIo = threadFsControls(f.h.stateDir), gate = Promise.withResolvers<void>()
    if (boundary === 'failed append') queueIo.fail('writeSync', 'alpha', { match: path => path === queuePath(f.h.stateDir) })
    let compactCalls = 0
    const second = await f.start({ threadMemory: { queueFs: queueIo.fs } }, run => {
      const compact = run.queue.compact
      run.queue.compact = async (key, current) => { compactCalls++; await gate.promise; await compact(key, current) }
    })
    expect(second.heldReleases).toHaveLength(boundary === 'saved' ? 1 : 0)
    expect(compactCalls).toBe(boundary === 'saved' ? 1 : 0)
    expect(readQueue(f.h.stateDir).filter(r => r.kind === 'released')).toHaveLength(boundary === 'saved' ? 1 : 0)
    expect(second.queue.unresolvedHolds('alpha')).toHaveLength(boundary === 'saved' ? 0 : 1)
    const bytes = readFileSync(queuePath(f.h.stateDir))
    await second.crash(); gate.resolve(); await second.clock.flush()
    expect(readFileSync(queuePath(f.h.stateDir))).toEqual(bytes)
    const third = await f.start()
    expect(third.heldReleases).toEqual(boundary === 'saved' ? [] : [{ key: 'alpha', seq: f.hold.seq, mode: 'recovered' }])
    expect(third.queue.openCount('alpha')).toBe(1)
    await f.drain(third)
  })

  test('a held second compaction never gates intake; failed compaction retries hourly', async () => {
    const f = await heldRun(); await f.run.stop(); f.io.heal()
    const io = threadFsControls(f.h.stateDir), gate = Promise.withResolvers<void>()
    let attempts = 0
    const run = await f.start({ threadMemory: { queueFs: io.fs } }, run => {
      const compact = run.queue.compact
      run.queue.compact = async (key, current) => {
        attempts++
        if (attempts === 1) {
          await gate.promise
          io.fail('renameSync', 'alpha', { times: 1, match: path => path.startsWith(queuePath(f.h.stateDir) + '.') })
        }
        return compact(key, current)
      }
    })
    expect(attempts).toBe(1)
    expect(run.queue.openCount('alpha')).toBe(1)
    expect(readQueue(f.h.stateDir).some(r => r.kind === 'released')).toBe(true)
    const next = await f.intake(run, 'other')
    expect(run.stub('alpha').socket.acks).toHaveLength(1)
    expect(run.queued('alpha').at(-1)!.accepted.ts).toBe(next.ts)
    gate.resolve(); await run.clock.flush()
    expect(run.queueEvents.some(e => e.type === 'compaction-failed' && e.key === 'alpha')).toBe(true)
    expect(run.clock.pending().some(t => t.delayMs === QUEUE_COMPACT_INTERVAL_MS)).toBe(true)
    await run.clock.advance(QUEUE_COMPACT_INTERVAL_MS - 1); expect(attempts).toBe(1)
    await run.clock.advance(1); expect(attempts).toBe(2)
    expect(run.queue.item('alpha', f.hold.seq)!.accepted.released_at).toBeDefined()
    expect(readQueue(f.h.stateDir).some(r => r.kind === 'released')).toBe(false)
    expect(run.heldReleases).toHaveLength(1)
    await f.drain(run)
  })
})
