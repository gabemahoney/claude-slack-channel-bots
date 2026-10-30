import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelMode, PersonaInput } from '../src/config.ts'
import { RETYPE_BACKOFF_MS } from '../src/delivery-constants.ts'
import { isOpenItem, itemOpenedAt, QUEUE_COMPACT_INTERVAL_MS, type HoldResolution } from '../src/delivery-queue.ts'
import { createMemoryHoldResolver, judgeMemoryHolds, type MemoryHoldEvent, type MemoryHoldMode } from '../src/memory-holds.ts'
import { recoverQueuedJoins } from '../src/thread-join-recovery.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { heldSlackInput, makeQueue, memoryHold, queuePath, readQueue, slackInput } from './test-helpers/delivery-queue.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeReloadHarness, type ReloadRun, type ReloadRunOptions } from './test-helpers/reload-harness.ts'
import { membershipPage, SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { makeChannelMessage, makeDm, mentionText } from './test-helpers/slack-stub.ts'
import { makeThreadMemoryHarness, readThreads, THREAD_ROOTS, THREAD_TIME, threadFsControls } from './test-helpers/thread-memory.ts'

const channel = SHARED_CHANNEL_IDS.primary, neighbor = SHARED_CHANNEL_IDS.secondary
const root = THREAD_ROOTS.primary
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
    queue: { ...queue, async resolveHolds(key, decisions, current) {
      saves.push({ key, decisions }); await beforeSave(key)
      const saved = await queue.resolveHolds(key, decisions, current)
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
    expect(f.order).toEqual(['saved:alpha', 'released:alpha:1', 'released:alpha:3', 'withdrawn', 'pruned:alpha'])
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
        expect(f.releases).toEqual(expectedReleases.slice(0, 1)); expect(f.events).toEqual([])
        expect(f.queue.item('alpha', 4)!.hold!.state).toBe('withdrawn')
        // Remove the full withdrawal while the first release's feedback waits.
        await f.queue.compact('alpha')
        expect(f.queue.item('alpha', 4)).toBeUndefined()
        expect(f.queue.item('alpha', 5)!.accepted.released_at).toBe(at)
        feedback.resolve()
      }
      expect(await pending).toBe('resolved')
      expect(f.releases).toEqual(expectedReleases); expect(f.events).toEqual(expectedEvents)
      expect(f.order).toEqual(['saved:alpha',
        ...(outcome === 'mixed' ? ['released:alpha:3', 'released:alpha:5', 'withdrawn'] : []), 'pruned:alpha'])
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
  async function intake(run: ReloadRun, kind: 'mention' | 'reply' | 'dm' | 'other' = 'reply', thread: string = root, key = 'alpha') {
    const ts = `1700000300.${String(++sequence).padStart(6, '0')}`
    const event = kind === 'dm' ? makeDm({ ts, text: `dm ${sequence}` }) : makeChannelMessage({ ts,
      channel: kind === 'other' ? neighbor : channel, thread_ts: thread,
      text: kind === 'mention' ? `${mentionText(run.stub(key).identity.botUserId)} join ${sequence}` : `reply ${sequence}` })
    await run.deliver(key, event); await run.clock.flush(); return { ...event, ts }
  }
  async function drain(run: ReloadRun, key = 'alpha') {
    await run.prepareQueued()
    const expected = run.queued(key).filter(isOpenItem).flatMap(i => i.fixed!.parts)
    const engine = await makeEngineHarness({ queue: run.queue, stateDir: h.stateDir, keys: [key] })
    try {
      await engine.tick(key); await engine.until(() => run.queue.openCount(key) === 0)
      expect(engine.textCalls(key).map(c => c.params.text)).toEqual(expected)
      expect(engine.errors).toHaveLength(0); assertNoLeak({ calls: engine.calls, events: engine.events, errors: engine.errors })
    } finally { await engine.cleanup() }
  }
  function reactions(run: ReloadRun, key = 'alpha') {
    return run.stub(key).calls.reactionsAdd
  }
  cleanups.push(async () => {
    for (const run of runs) { assertNoLeak(run.captured()); await run.stop() }
    await h.cleanup()
  })
  return { h, start, intake, drain, reactions }
}

describe.each(['strict', 'open'] as const)('%s Memory Hold outage', mode => {
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
