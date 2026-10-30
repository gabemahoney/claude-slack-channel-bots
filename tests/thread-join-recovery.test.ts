import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import type { ChannelMode, DeliveryMode, PersonaInput } from '../src/config.ts'
import { QUEUE_COMPACT_INTERVAL_MS } from '../src/delivery-queue.ts'
import { personaInstanceId, renderPersonaRef } from '../src/persona-identity.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { buildThreadMemoryChangedWhileStoppedNotice, buildThreadMemoryNotSavedNotice, buildThreadMemoryRecoveredNotice } from '../src/thread-memory-reports.ts'
import { buildOperatorAssignment } from '../src/reload-request.ts'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'
import { makeEngineHarness, type EngineHarness } from './test-helpers/delivery-engine.ts'
import { queuePath, readQueue } from './test-helpers/delivery-queue.ts'
import { makeReloadHarness, type ReloadHarness, type ReloadRun, type ReloadRunOptions } from './test-helpers/reload-harness.ts'
import { SHARED_CHANNEL_IDS, membershipPage } from './test-helpers/shared-channels.ts'
import { makeChannelMessage, makeMembershipEvent, mentionText, broadcastText, stubOpenedDmId } from './test-helpers/slack-stub.ts'
import { THREAD_ROOTS, readThreads, threadFsControls, threadPath } from './test-helpers/thread-memory.ts'

const channel = SHARED_CHANNEL_IDS.primary
const neighbor = SHARED_CHANNEL_IDS.secondary
const root = THREAD_ROOTS.primary
let h: ReloadHarness
let runs: ReloadRun[]
let engines: EngineHarness[]
let sequence: number
let personas: PersonaInput[]
type ReportKind = 'not-saved' | 'recovered' | 'unclean'
type ExpectedReport = ReportKind | { kind: ReportKind; channels: string[] }
let expectedReports: Map<ReloadRun, Record<string, ExpectedReport[]>>
const afterCrash: Record<string, ExpectedReport[]> = { alpha: ['unclean'], bravo: ['unclean'] }

beforeEach(() => {
  h = makeReloadHarness({ personaConfigDirs: true }); runs = []; engines = []; sequence = 0
  expectedReports = new Map()
  personas = ['alpha', 'bravo'].map(name => h.persona(name, {
    channels: [{ id: channel, delivery: 'thread_hybrid' }, { id: neighbor, delivery: 'thread_hybrid' }],
    permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' },
  }))
  h.materialize(...personas)
})

afterEach(async () => {
  try {
    for (const engine of engines) assertNoLeak({ calls: engine.calls, events: engine.events, errors: engine.errors })
    for (const run of runs) {
      assertNoLeak(run.captured())
      expectReports(run, expectedReports.get(run) ?? {})
    }
  } finally {
    // An unexpected report must not strand a run or its timers.
    try { for (const engine of engines) await engine.cleanup() }
    finally { await h.cleanup() }
  }
})

function expectReports(run: ReloadRun, expected: Record<string, ExpectedReport[]>) {
  expectedReports.set(run, expected)
  let total = 0
  for (const persona of run.serverConfig()!.personas) {
    const ref = renderPersonaRef(persona.name, persona.key)
    const texts = (expected[persona.key] ?? []).map(report => {
      const kind = typeof report === 'string' ? report : report.kind
      const channels = typeof report === 'string' ? [channel, neighbor] : report.channels
      if (kind === 'unclean') return buildThreadMemoryChangedWhileStoppedNotice(ref, channels, 'unclean')
      if (kind === 'recovered') return buildThreadMemoryRecoveredNotice(ref, channels)
      const failure = run.threadMemoryEvents.find(e => e.type === 'append-failed' && e.key === persona.key)
      if (failure?.type !== 'append-failed') throw new Error('expected injected join append failure')
      expect(failure.step).toBe('journal-append')
      return buildThreadMemoryNotSavedNotice(ref, channels, threadPath(h.stateDir, persona.key), failure.step, failure.error)
    })
    const posts = texts.map(text => ({ channel: stubOpenedDmId('U0OPERATOR'), text: formatPersonaNotice(persona, text) }))
    expect(run.stub(persona.name).calls.postMessage).toEqual(posts)
    total += posts.length
  }
  expect(run.slackPosts()).toHaveLength(total)
}

function options(extra: ReloadRunOptions = {}): ReloadRunOptions {
  return {
    threadMemory: {},
    slack: Object.fromEntries(personas.map(p => [p.name, {
      inventory: [membershipPage([channel, neighbor])],
    }])),
    ...extra,
  }
}
async function start(extra: ReloadRunOptions = {}) {
  const run = await h.startDetecting(options(extra)); runs.push(run)
  expect(run.outcome.kind).toBe('applied')
  await run.membershipClock.runNext()
  for (const persona of personas) run.registerSession(persona.name)
  return run
}
function setup(mode: ChannelMode) { h.writeConfig({ channel_mode: mode, personas }) }
function joins(key = 'alpha') { return readThreads(h.stateDir, key).filter(r => r.kind === 'join') }
function view(run: ReloadRun, key = 'alpha', thread: string = root, target: string = channel) {
  return run.threadMemory!.view(key, target, thread)
}
async function intake(run: ReloadRun, source: 'mention' | 'broadcast' | 'reply', {
  key = 'alpha', thread = root, target = channel, rootPost = false,
}: { key?: string; thread?: string; target?: string; rootPost?: boolean } = {}) {
  const ts = rootPost ? (sequence++, thread) : `1700000100.${String(++sequence).padStart(6, '0')}`
  const text = source === 'mention' ? `${mentionText(run.stub(key).identity.botUserId)} join ${sequence}`
    : source === 'broadcast' ? `${broadcastText()} join ${sequence}` : `reply ${sequence}`
  const event = makeChannelMessage({ channel: target, text, ts, thread_ts: rootPost ? undefined : thread })
  await run.deliver(key, event)
  await run.clock.flush()
  return event
}
async function deliverQueued(run: ReloadRun, key = 'alpha') {
  await run.prepareQueued()
  const pending = run.queued(key).filter(i => !i.delivered)
  const expected = pending.flatMap(item => item.fixed!.parts)
  const engine = await makeEngineHarness({ queue: run.queue, stateDir: h.stateDir, keys: [key] })
  engines.push(engine)
  await engine.tick(key)
  await engine.until(() => run.queue.openCount(key) === 0)
  expect(engine.textCalls(key).map(call => call.params.text)).toEqual(expected)
  expect(engine.errors).toEqual([])
  expect(engine.restarts).toEqual([])
  expect(run.queued(key).every(item => item.delivered)).toBe(true)
  await engine.cleanup()
  return engine
}
async function crash(run: ReloadRun) {
  const bytes = ['alpha', 'bravo'].flatMap(key => [queuePath(h.stateDir, key), threadPath(h.stateDir, key)])
    .filter(existsSync).map(path => ({ path, bytes: readFileSync(path) }))
  assertNoLeak(run.captured())
  await run.crash()
  for (const entry of bytes) expect(readFileSync(entry.path)).toEqual(entry.bytes)
}
function assign(run: ReloadRun, delivery: DeliveryMode, target = channel, key = 'alpha') {
  const authority = run.controller.sharedChannels()!
  expect(authority.assign(key, authority.incarnation(key)!, target, delivery, authority.revision).kind).toBe('applied')
}

describe.each(['strict', 'open'] as const)('%s join recovery', mode => {
  test.each(['mention', 'broadcast', 'two mentions'] as const)('crash before append: %s recovers before admission and preserves FIFO', async source => {
    setup(mode)
    const io = threadFsControls(h.stateDir)
    const first = await start({ threadMemory: { fs: io.fs } })
    // A future decision time makes a reset-to-wall-clock implementation fail.
    await first.clock.advance(42_000)
    io.fail('writeSync', 'alpha')
    const original = await intake(first, source === 'broadcast' ? 'broadcast' : 'mention', { rootPost: true })
    if (source === 'two mentions') await intake(first, 'mention')
    const accepted = JSON.parse(JSON.stringify(first.queued('alpha').map(item => item.accepted))) as ReturnType<ReloadRun['queued']>[number]['accepted'][]
    const fact = accepted[0]!.thread_join!
    expect(fact.at).toBeGreaterThan(0)
    expect(first.stub('alpha').socket.acks).toHaveLength(accepted.length)
    expect(joins()).toEqual([])
    expect(view(first)).toBe('joined')
    expect(first.threadMemoryEvents.filter(e => e.type === 'append-failed' && e.key === 'alpha').length).toBeGreaterThan(0)
    // A sibling succeeds independently while alpha's append is refused.
    await intake(first, 'mention', { key: 'bravo', thread: THREAD_ROOTS.secondary })
    expect(joins('bravo')).toHaveLength(1)
    const sibling = JSON.parse(JSON.stringify(first.queued('bravo').map(item => item.accepted))) as typeof accepted
    await crash(first)
    io.heal()
    let admissionChecks = 0
    const reopened = await start({ beforeStartBringUp(run) {
      admissionChecks++
      expect(view(run)).toBe('joined')
      expect(view(run, 'bravo', THREAD_ROOTS.secondary)).toBe('joined')
      expect(run.lifecycle.records).toEqual([])
    } })
    expect(admissionChecks).toBe(1)
    expect(joins()).toMatchObject([{ root, source: source === 'broadcast' ? 'broadcast' : 'mention', at: fact.at, stamp: fact.stamp }])
    expect(joins()).toHaveLength(1)
    expect(reopened.queued('alpha').map(i => i.accepted)).toEqual(accepted.map(a => expect.objectContaining(a)))
    expect(reopened.queued('bravo').map(i => i.accepted)).toEqual(sibling.map(a => expect.objectContaining(a)))
    await intake(reopened, 'reply')
    expect(reopened.queued('alpha').at(-1)!.accepted.via).toBe('thread')
    await intake(reopened, 'mention', { thread: THREAD_ROOTS.third })
    expect(reopened.queued('alpha').at(-1)!.accepted.thread_join!.at).toBeGreaterThan(fact.at)
    // Slack redelivery after restart cannot create another item or join.
    await reopened.deliver('alpha', original)
    expect(reopened.queued('alpha')).toHaveLength(accepted.length + 2)
    const engine = await deliverQueued(reopened)
    expect(engine.textCalls().length).toBe(accepted.length + 2)
    expect(reopened.queue.openCount('bravo')).toBe(1)
    expect(joins('bravo')).toHaveLength(1)
    expectReports(first, { alpha: ['not-saved'] })
    expectReports(reopened, afterCrash)
  })

  test('delivered unsaved join survives startup and hourly compaction, then becomes a key', async () => {
    setup(mode)
    const io = threadFsControls(h.stateDir)
    const first = await start({ threadMemory: { fs: io.fs } })
    io.fail('writeSync', 'alpha')
    await intake(first, 'mention')
    await deliverQueued(first)
    const records = readQueue(h.stateDir)
    const fact = first.queued('alpha')[0]!.accepted.thread_join!
    await first.clock.advance(QUEUE_COMPACT_INTERVAL_MS)
    expect(readQueue(h.stateDir).filter(r => r.seq === 1 && !('compact' in r))).toEqual(records)
    await crash(first)
    const reopened = await start({ threadMemory: { fs: io.fs } })
    expect(reopened.queued('alpha')).toHaveLength(1)
    expect(reopened.queued('alpha')[0]!.delivered).toBe(true)
    expect(readQueue(h.stateDir).filter(r => r.seq === 1 && !('compact' in r))).toEqual(records)
    expect(reopened.queue.openCount('alpha')).toBe(0)
    const noReplay = await deliverQueued(reopened)
    expect(noReplay.textCalls()).toEqual([])
    await reopened.clock.advance(QUEUE_COMPACT_INTERVAL_MS)
    expect(reopened.queued('alpha')[0]!.accepted.thread_join).toEqual(fact)
    io.heal()
    expect(await reopened.threadMemory!.flush('alpha')).toEqual({ kind: 'saved' })
    await reopened.clock.advance(QUEUE_COMPACT_INTERVAL_MS)
    expect(reopened.queued('alpha')).toEqual([])
    expect(readQueue(h.stateDir).filter(r => r.kind === 'accepted' && 'compact' in r && r.compact === 'key'))
      .toMatchObject([{ seq: 1, key: { chat_id: channel } }])
    expect(joins()).toMatchObject([{ root, at: fact.at }])
    expectReports(first, { alpha: ['not-saved'] })
    expectReports(reopened, { alpha: ['unclean', 'not-saved', 'recovered'], bravo: ['unclean'] })
    assertNoLeak({ queue: writtenFile(queuePath(h.stateDir)), memory: writtenFile(threadPath(h.stateDir)) })
  })

  test.each(['off', 'mentions', 'all'] as const)('stale %s→hybrid stamp never rejoins and later compacts', async choice => {
    setup(mode)
    const io = threadFsControls(h.stateDir)
    const first = await start({ threadMemory: { fs: io.fs } })
    await first.clock.advance(80_000)
    io.fail('writeSync', 'alpha')
    await intake(first, 'mention')
    const fact = first.queued('alpha')[0]!.accepted.thread_join!
    await intake(first, 'mention', { key: 'bravo' })
    const siblingStamp = first.controller.sharedChannels()!.channelStamp('bravo', channel)
    await crash(first)
    // Change the durable authority before the recovered run's first admission.
    const reopened = h.build(options()); runs.push(reopened)
    expect(reopened.resolveStart().kind).toBe('applied')
    assign(reopened, choice); assign(reopened, 'thread_hybrid')
    await reopened.controller.runStartBringUp()
    await reopened.membershipClock.runNext()
    expect(view(reopened)).toBe('not-joined')
    expect(joins()).toEqual([])
    expect(view(reopened, 'bravo')).toBe('joined')
    expect(reopened.controller.sharedChannels()!.channelStamp('bravo', channel)).toEqual(siblingStamp)
    expect(reopened.queued('bravo')).toHaveLength(1)
    const count = reopened.queued('alpha').length
    await intake(reopened, 'reply')
    expect(reopened.queued('alpha')).toHaveLength(count)
    // Even rejected stale candidates must advance the decision clock.
    await intake(reopened, 'mention', { thread: THREAD_ROOTS.third })
    expect(reopened.queued('alpha').at(-1)!.accepted.thread_join!.at).toBeGreaterThan(fact.at)
    await deliverQueued(reopened)
    await reopened.queue.compact('alpha')
    expect(readQueue(h.stateDir).some(r => r.kind === 'accepted' && 'compact' in r && r.compact === 'key' && r.seq === 1)).toBe(true)
    expect(view(reopened)).toBe('not-joined')
    await intake(reopened, 'mention')
    await intake(reopened, 'reply')
    expect(reopened.queued('alpha').at(-1)!.accepted.via).toBe('thread')
    expectReports(first, { alpha: ['not-saved'] })
    expectReports(reopened, afterCrash)
  })

  test('undecided start candidate waits for current shared-state publication', async () => {
    setup(mode)
    const io = threadFsControls(h.stateDir)
    const first = await start({ threadMemory: { fs: io.fs } })
    io.fail('writeSync', 'alpha')
    await intake(first, 'mention')
    const fact = first.queued('alpha')[0]!.accepted.thread_join!
    await crash(first)
    const reopened = h.build(options()); runs.push(reopened)
    expect(reopened.resolveStart().kind).toBe('applied')
    const authority = reopened.controller.sharedChannels()!
    h.failChannelDeliveryWrites({ step: 'fsyncSync', call: 2 })
    expect(authority.assign('alpha', authority.incarnation('alpha')!, channel, 'thread_hybrid', authority.revision).kind).toBe('unresolved')
    expect(authority.channelStamp('alpha', channel)).toEqual({ kind: 'undecided' })
    await reopened.controller.runStartBringUp()
    await reopened.membershipClock.runNext()
    expect(view(reopened)).toBe('not-joined')
    expect(joins()).toEqual([])
    const acks = reopened.stub('alpha').socket.acks.length
    await intake(reopened, 'reply')
    expect(reopened.stub('alpha').socket.acks).toHaveLength(acks)
    expect(reopened.queued('alpha')).toHaveLength(1)
    h.clearChannelDeliveryWriteFailure()
    expect(authority.recoverDurability().kind).toBe('applied')
    await reopened.clock.flush()
    expect(view(reopened)).toBe('joined')
    expect(joins()).toMatchObject([{ root, stamp: fact.stamp, at: fact.at }])
    reopened.stub('alpha').script.inventory.push(membershipPage([channel, neighbor]))
    reopened.membershipScanner.request('alpha')
    await reopened.membershipClock.runNext()
    expect(reopened.membership.read('alpha', channel, mode).kind).toBe('eligible')
    await intake(reopened, 'reply')
    expect(reopened.queued('alpha').at(-1)!.accepted.via).toBe('thread')
    expectReports(first, { alpha: ['not-saved'] })
    // The primary stamp was undecided when the startup report was observed.
    expectReports(reopened, { alpha: [{ kind: 'unclean', channels: [neighbor] }], bravo: ['unclean'] })
  })

  test('same-incarnation teardown and bring-up recover a forgotten unsaved join', async () => {
    setup(mode)
    const io = threadFsControls(h.stateDir)
    const run = await start({ threadMemory: { fs: io.fs } })
    io.fail('writeSync', 'alpha')
    await intake(run, 'mention')
    await intake(run, 'mention', { key: 'bravo' })
    const authority = run.controller.sharedChannels()!, stamp = authority.channelStamp('alpha', channel)
    const otherQueue = readFileSync(queuePath(h.stateDir, 'bravo')), otherThreads = readFileSync(threadPath(h.stateDir, 'bravo'))
    const config = run.serverConfig()!, persona = config.personas.find(p => p.key === 'alpha')!
    const callStart = run.composition!.calls.length
    await run.composition!.lifecycle.teardown(persona)
    expect(view(run)).toBe('not-joined')
    expect(run.isUp('alpha')).toBe(false)
    run.stub('alpha').script.inventory.push(membershipPage([channel, neighbor]))
    await run.composition!.lifecycle.bringUp(persona, config)
    await run.membershipClock.runNext()
    expect(run.isUp('alpha')).toBe(true)
    expect(authority.channelStamp('alpha', channel)).toEqual(stamp)
    expect(view(run)).toBe('joined')
    await intake(run, 'reply')
    expect(run.queued('alpha').at(-1)!.accepted.via).toBe('thread')
    expect(joins()).toEqual([])
    expect(run.composition!.calls.slice(callStart).every(([, key]) => key === 'alpha')).toBe(true)
    expect(readFileSync(queuePath(h.stateDir, 'bravo'))).toEqual(otherQueue)
    expect(readFileSync(threadPath(h.stateDir, 'bravo'))).toEqual(otherThreads)
    expect(view(run, 'bravo')).toBe('joined')
    expectReports(run, { alpha: ['not-saved', 'not-saved'] })
  })

  test('covered delivered records still advance the clock before startup compaction removes them', async () => {
    setup(mode)
    const io = threadFsControls(h.stateDir)
    const first = await start({ threadMemory: { fs: io.fs } })
    io.fail('writeSync', 'alpha')
    await first.clock.advance(10_000)
    await intake(first, 'mention')
    await first.clock.advance(10_000)
    await intake(first, 'mention')
    const times = first.queued('alpha').map(i => i.accepted.thread_join!.at)
    io.heal()
    expect(await first.threadMemory!.flush('alpha')).toEqual({ kind: 'saved' })
    expect(joins()).toHaveLength(1)
    expect(joins()[0]!.at).toBe(times[0]!)
    await deliverQueued(first)
    await crash(first)
    const reopened = await start()
    expect(reopened.queued('alpha')).toEqual([])
    expect(view(reopened)).toBe('joined')
    await intake(reopened, 'mention', { thread: THREAD_ROOTS.third })
    expect(reopened.queued('alpha')[0]!.accepted.thread_join!.at).toBeGreaterThan(times[1]!)
    expectReports(first, { alpha: ['not-saved', 'recovered'] })
    expectReports(reopened, afterCrash)
  })

  test('identity reset leaves old accepted work deliverable without restoring its join', async () => {
    setup(mode)
    const io = threadFsControls(h.stateDir)
    const first = await start({ realLaunch: true, threadMemory: { fs: io.fs } })
    io.fail('writeSync', 'alpha')
    await intake(first, 'mention')
    await intake(first, 'mention', { key: 'bravo' })
    const fact = first.queued('alpha')[0]!.accepted.thread_join!
    const otherStamp = first.controller.sharedChannels()!.channelStamp('bravo', channel)
    const composition = first.composition!
    const instanceFrom = composition.instanceCallsOf('alpha').length
    const adFrom = composition.agentDirectorCalls.length
    const callsFrom = composition.calls.length
    const activityFrom = first.socketActivity('alpha').length
    const label = h.credentialsLabel('alpha')
    const oldRow = h.rowOf('alpha')!
    expect(oldRow).toMatchObject({ state: 'waiting' })
    const sibling = {
      row: h.rowOf('bravo'),
      instanceCalls: composition.instanceCallsOf('bravo').length,
      socketActivity: first.socketActivity('bravo'),
      builds: first.slack.buildsOf('bravo').length,
      slackCalls: first.slackCalls()['bravo']!.length,
      queue: readFileSync(queuePath(h.stateDir, 'bravo')),
      threads: readFileSync(threadPath(h.stateDir, 'bravo')),
    }
    const instanceCalls = () => composition.instanceCallsOf('alpha').slice(instanceFrom)
    const replacement = { ...personas[0]!, working_directory: h.persona('replacement').working_directory }
    h.makeWorkingDirectory(replacement)
    personas = [replacement, personas[1]!]
    h.writeConfig({ channel_mode: mode, personas })
    const cp = first.checkpoint()
    await first.ticks.tick()
    expect(first.since(cp).lifecycle).toEqual([])
    assertNoLeak(first.captured())
    const gate = first.lifecycle.hold('bring-up', 'alpha')
    h.confirm()
    const applying = first.ticks.tick()
    try {
      await gate.entered
      expect(h.rowOf('alpha')).toEqual({ ...oldRow, state: 'ended' })
      expect(instanceCalls()).toEqual([{ verb: 'kill', id: personaInstanceId('alpha'), result: 'ok' }])
      expect(first.socketActivity('alpha').slice(activityFrom)).toEqual([`discarded ${label}`, `disconnected ${label}`])
      expect(await first.relaunch('alpha')).toBe('skipped')
      expect(instanceCalls()).toEqual([{ verb: 'kill', id: personaInstanceId('alpha'), result: 'ok' }])
    } finally { gate.release(); await applying }
    expect(first.since(cp).lifecycle.map(({ op, key, via }) => ({ op, key, via }))).toEqual([
      { op: 'teardown', key: 'alpha', via: 'apply' },
      { op: 'bring-up', key: 'alpha', via: 'apply' },
      { op: 'launch', key: 'alpha', via: 'restart' },
      { op: 'launch', key: 'alpha', via: 'apply' },
    ])
    expect(instanceCalls()).toEqual([
      { verb: 'kill', id: personaInstanceId('alpha'), result: 'ok' },
      expect.objectContaining({ verb: 'spawn', id: personaInstanceId('alpha'), reuse: true, result: 'ok',
        cwd: replacement.working_directory, claudeConfigDir: replacement.claude_config_dir }),
    ])
    expect(h.rowOf('alpha')).toEqual({ ...oldRow, cwd: replacement.working_directory })
    expect(first.socketActivity('alpha').slice(activityFrom)).toEqual([
      `discarded ${label}`, `disconnected ${label}`, `built ${label}`, `started ${label}`, `connected ${label}`,
    ])
    expect(composition.calls.slice(callsFrom).filter(([, key]) => key === 'bravo')).toEqual([])
    expect(composition.agentDirectorCalls.slice(adFrom).filter(call => call.id === personaInstanceId('bravo'))).toEqual([])
    expect(composition.instanceCallsOf('bravo').slice(sibling.instanceCalls)).toEqual([])
    expect(first.socketActivity('bravo')).toEqual(sibling.socketActivity)
    expect(first.slack.buildsOf('bravo').slice(sibling.builds)).toEqual([])
    expect(first.slackCalls()['bravo']!.slice(sibling.slackCalls)).toEqual([])
    expect(h.rowOf('bravo')).toEqual(sibling.row)
    expect(readFileSync(queuePath(h.stateDir, 'bravo'))).toEqual(sibling.queue)
    expect(readFileSync(threadPath(h.stateDir, 'bravo'))).toEqual(sibling.threads)
    expect(first.controller.sharedChannels()!.incarnation('alpha')).not.toBe(fact.stamp.incarnation)
    await crash(first)
    const reopened = await start({ beforeStartBringUp(run) { expect(view(run)).toBe('not-joined') } })
    expect(joins()).toEqual([])
    expect(reopened.controller.sharedChannels()!.channelStamp('bravo', channel)).toEqual(otherStamp)
    expect(view(reopened, 'bravo')).toBe('joined')
    await intake(reopened, 'reply')
    expect(reopened.queued('alpha')).toHaveLength(1)
    expect(reopened.queued('alpha')[0]!.accepted.thread_join).toEqual(fact)
    await deliverQueued(reopened)
    expect(view(reopened)).toBe('not-joined')
    expect(reopened.queue.openCount('bravo')).toBe(1)
    // Publishing the replacement declaration prunes the stale join before
    // teardown; that observation has no current hybrid channels yet.
    expectReports(first, { alpha: ['not-saved', { kind: 'recovered', channels: [] }] })
    expectReports(reopened, { alpha: [{ kind: 'unclean', channels: [] }], bravo: ['unclean'] })
  })

  test('AC-V02/AC-C01: intake joins survive modes, same-value writes, relaunch, restarts and time; leave forgets only one channel', async () => {
    for (const delivery of ['off', 'mentions', 'all'] as const) {
      const persona = h.persona(delivery, { channels: [{ id: channel, delivery }],
        permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' } })
      h.materialize(persona); personas.push(persona)
    }
    setup(mode)
    let run = await start({ realLaunch: true })
    await intake(run, 'mention')
    await intake(run, 'broadcast', { thread: THREAD_ROOTS.secondary })
    await intake(run, 'mention', { target: neighbor, thread: THREAD_ROOTS.third })
    await intake(run, 'mention', { key: 'bravo' })
    const stamps = [channel, neighbor].map(c => run.controller.sharedChannels()!.channelStamp('alpha', c))
    const check = async () => {
      const authority = run.controller.sharedChannels()!
      expect([channel, neighbor].map(c => authority.channelStamp('alpha', c))).toEqual(stamps)
      for (const thread of [root, THREAD_ROOTS.secondary]) {
        expect(view(run, 'alpha', thread)).toBe('joined')
        await intake(run, 'reply', { thread })
        expect(run.queued('alpha').at(-1)!.accepted.via).toBe('thread')
      }
      expect(view(run, 'alpha', THREAD_ROOTS.third, neighbor)).toBe('joined')
      expect(view(run, 'bravo')).toBe('joined')
      for (const delivery of ['off', 'mentions', 'all'] as const) {
        expect(authority.choice(delivery, channel)).toBe(delivery)
        const from = run.queued(delivery).length
        await intake(run, 'mention', { key: delivery })
        await intake(run, 'broadcast', { key: delivery })
        expect(run.queued(delivery).slice(from).map(i => i.accepted.via)).toEqual(delivery === 'off' ? [] : ['mention', 'broadcast'])
        expect(existsSync(threadPath(h.stateDir, delivery))).toBe(false)
        expect(run.threadMemoryEvents.filter(e => e.key === delivery)).toEqual([])
      }
    }
    await check()
    const authority = run.controller.sharedChannels()!
    run.request('request', [buildOperatorAssignment(run.serverConfig()!.personas.find(p => p.key === 'alpha')!, authority.incarnation('alpha')!, channel, 'thread_hybrid')])
    await run.ticks.tick(); assertNoLeak(run.captured()); h.confirm(); await run.ticks.tick()
    await check()
    // Both directions; each switch is a real confirmation with zero lifecycle work.
    for (const nextMode of [mode === 'strict' ? 'open' : 'strict', mode] as const) {
      h.writeConfig({ channel_mode: nextMode, personas })
      const cp = run.checkpoint()
      await run.ticks.tick(); assertNoLeak(run.captured()); h.confirm(); await run.ticks.tick()
      expect(run.since(cp).lifecycle).toEqual([])
      expect(run.since(cp).slackBuilds).toBe(0)
      expect(run.since(cp).slackCalls).toEqual([])
      await check()
      const before = run.composition!.instanceCallsOf('bravo').length
      expect(await run.relaunch('alpha')).toBe(true)
      expect(run.composition!.instanceCallsOf('bravo')).toHaveLength(before)
      await check()
      await crash(run)
      run = await start({ realLaunch: true })
      await check()
    }
    await run.clock.advance(QUEUE_COMPACT_INTERVAL_MS * 24 * 31)
    await check()
    const other = readFileSync(threadPath(h.stateDir, 'bravo'))
    const at = run.membershipClock.now() + 100
    await run.deliver('alpha', ...makeMembershipEvent(run.stub('alpha').identity, 'leave', channel, at))
    expect(view(run)).toBe('not-joined')
    expect(view(run, 'alpha', THREAD_ROOTS.secondary)).toBe('not-joined')
    expect(view(run, 'alpha', THREAD_ROOTS.third, neighbor)).toBe('joined')
    expect(view(run, 'bravo')).toBe('joined')
    expect(readFileSync(threadPath(h.stateDir, 'bravo'))).toEqual(other)
    await run.deliver('alpha', ...makeMembershipEvent(run.stub('alpha').identity, 'join', channel, at + 100))
    expect(run.controller.sharedChannels()!.choice('alpha', channel)).toBe(mode === 'strict' ? 'off' : 'mentions')
    run.stub('alpha').script.inventory.push(membershipPage([channel, neighbor]))
    run.membershipScanner.request('alpha'); await run.membershipClock.runNext()
    assign(run, 'thread_hybrid')
    const count = run.queued('alpha').length
    await intake(run, 'reply')
    expect(run.queued('alpha')).toHaveLength(count)
    await intake(run, 'mention')
    await intake(run, 'reply')
    expect(run.queued('alpha').at(-1)!.accepted.via).toBe('thread')
    expect(view(run, 'alpha', THREAD_ROOTS.secondary)).toBe('not-joined')
    expectReports(runs[0]!, {})
    for (const restarted of runs.slice(1)) expectReports(restarted, afterCrash)
  })
})
