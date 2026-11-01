/** Durable Slack intake: decision wiring, persona isolation, ack boundary and immutable preparation. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebClient } from '@slack/web-api'
import { createPersonaRouting } from '../src/persona-routing.ts'
import { durableWriteFileSync, DurableWriteUnsyncedError } from '../src/atomic-write.ts'
import { buildTagParts, NAME_LOOKUP_TIMEOUT_MS } from '../src/tag-wrapper.ts'
import { createDeliveryPreparation } from '../src/delivery-intake.ts'
import type { AcceptedRecord, QueueEvent } from '../src/delivery-queue.ts'
import { createDeliveryReporting, MESSAGE_NOT_SAVED, buildMessageNotSavedNotice } from '../src/delivery-notices.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { buildThreadMemoryChangedWhileStoppedNotice } from '../src/thread-memory-reports.ts'
import { LIVENESS_READING_DEAD_ENDED } from '../src/liveness-reading.ts'
import { sanitizeFilename } from '../src/lib.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { makeRestartDeps, makeRoutingHarness, observedMembership, resetRoutingState, NEVER_FIRE_RESTART_DELAY_S, type RoutingHarness } from './test-helpers/persona-routing-harness.ts'
import { broadcastText, makeAppMention, makeChannelMessage, makeDm, makeGroupDmMessage, makeBotMessage, makeOwnFileShare, makeWebhookPost, makeStubSlack, makeDeferredWebApiCall, mentionText, ENVELOPE_FLAG_FORMS, type OwnFileShareOptions, type SlackEvent } from './test-helpers/slack-stub.ts'
import type { ChannelMode } from '../src/config.ts'
import type { PersonaEventProvenance } from '../src/persona-connections.ts'
import { assertNoLeak, sentinelInMessage } from './test-helpers/credentials.ts'
import { readQueue, seedQueue, slackInput, queuePath, memoryHold, postHold } from './test-helpers/delivery-queue.ts'
import { OWN_ROOT_CLOCK_SKEW_MS } from '../src/delivery-constants.ts'
import { createChannelDeliveryStore } from '../src/channel-delivery.ts'
import { configBytes, makeSharedAuthority, makeMembershipHarness, membershipPage, sharedRecoveryRequest } from './test-helpers/shared-channels.ts'
import { makeReloadHarness } from './test-helpers/reload-harness.ts'
import { PERSONA_THREAD_STAMP_UNDECIDED, threadStampUndecidedCause } from '../src/persona-diagnostics.ts'
import { createPersonaEpisodes } from '../src/persona-episodes.ts'
import { makeMultiPersonaConfig, type PersonaSpec } from './test-helpers/persona-config.ts'
import { makeQueue } from './test-helpers/delivery-queue.ts'
import { initRestart, isRestartPendingOrActive } from '../src/restart.ts'
import { createQueuedAckCallback } from '../src/ack-tracker.ts'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { THREAD_CHANNELS, THREAD_ROOTS, THREAD_TIME, readThreads, slackTsOfMs, threadPath, threadFsControls, seedThreads, threadHeader, threadConfig } from './test-helpers/thread-memory.ts'
const CA = 'C0TEST001', CB = 'C0TEST002', CS = 'C0SHARED1', CX = 'C0OTHER01'
let dir: string; let harnesses: RoutingHarness[]
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'routing-queue-')); harnesses = []; resetRoutingState() })
afterEach(async () => { for (const h of harnesses) { h.hold.cancelAll(); h.releaseLaunches(); await h.threads?.close(); await h.queue.stop(); assertNoLeak(h.captured()) }; resetRoutingState(); rmSync(dir, { recursive: true, force: true }) })
function harness(opts: Parameters<typeof makeRoutingHarness>[2] = {}) {
  const h = makeRoutingHarness([{ name: 'alpha', channels: [{ id: CA, delivery: 'all' }, { id: CS, delivery: 'mentions' }], dm: { enabled: true } }, { name: 'beta', channels: [{ id: CB, delivery: 'all' }, { id: CS, delivery: 'mentions' }] }], dir, { membership: observedMembership({ alpha: [CA, CS, ...(opts.mode === 'open' ? [CX] : [])], beta: [CB, CS] }), restartDelayS: NEVER_FIRE_RESTART_DELAY_S, ...opts }); harnesses.push(h); return h
}
// Actual shared projection plus explicit current positives for the low-level
// queue tests. Neither the selector nor the intake algorithm is replaced.
function selectionInputs(config: ReturnType<typeof makeMultiPersonaConfig>, channels: string[]) {
  const input = { ...config, personas: config.personas.map(({ key, index, sections, ...p }) => p) }
  const store = createChannelDeliveryStore(makeSharedAuthority(dir, input))
  return { getChannelDelivery: () => store, membership: observedMembership(Object.fromEntries(config.personas.map(p => [p.key, channels]))) }
}
const facts = (h: RoutingHarness, name: string) => h.queued(name).map(i => ({ channel: i.accepted.channel, ts: i.accepted.ts, via: i.accepted.via, text: i.accepted.text }))

/**
 * Hold routing for the Memory Hold and Post Hold cases: alpha and beta in the
 * Thread Memory helper's `thread_hybrid` and `all` channels, plus `channels`,
 * with real queued feedback and reporting. `unreadable` fails alpha's journal
 * read, seeding only an empty header unless a reopened journal is already there,
 * so every join comes through intake.
 */
async function holdRoutingHarness(mode: ChannelMode, options: Parameters<typeof makeRoutingHarness>[2] & { unreadable?: boolean; channels?: NonNullable<PersonaSpec['channels']> } = {}) {
  const { unreadable, channels = [], ...rest } = options
  const A = THREAD_CHANNELS.primary, B = THREAD_CHANNELS.secondary
  if (unreadable && !existsSync(threadPath(dir))) seedThreads(dir, [threadHeader()])
  const io = threadFsControls(dir), queueIo = threadFsControls(dir)
  if (unreadable) io.fail('readFileSync', 'alpha')
  const events: QueueEvent[] = [], received: Array<{ key: string; seq: number; mode: 'live' | 'recovered' | undefined }> = []
  const feedback: Promise<void>[] = []
  let reporting: ReturnType<typeof createDeliveryReporting> | undefined
  const h = makeRoutingHarness(['alpha', 'beta'].map(name => ({ name, channels: [
    { id: A, delivery: 'thread_hybrid' as const }, { id: B, delivery: 'all' as const }, ...channels,
  ], dm: { enabled: true } })), dir, {
    mode, dedupeClock: () => THREAD_TIME, restartDelayS: NEVER_FIRE_RESTART_DELAY_S,
    membership: observedMembership({ alpha: [A, B], beta: [A, B] }),
    rowRead: { alpha: LIVENESS_READING_DEAD_ENDED, beta: LIVENESS_READING_DEAD_ENDED },
    ...rest,
    threadMemory: { fs: io, ...rest.threadMemory },
    queueOptions: { fs: queueIo.fs, onEvent: event => { events.push(event); reporting?.queueEvent(event) } },
    onReceived: (key, item, releaseMode) => {
      received.push({ key, seq: item.accepted.seq, mode: releaseMode })
      reporting!.received(key, item, releaseMode)
    },
  })
  harnesses.push(h)
  const queued = createQueuedAckCallback({ queue: h.queue, getReaction: () => h.config!.queued_ack_reaction, clientFor: key => h.p(key).stub.web })
  reporting = createDeliveryReporting({ queue: h.queue, episodes: h.episodes, persona: key => h.p(key).persona,
    state: key => ({ up: h.upOutcomes.isUp(key) }), now: () => THREAD_TIME,
    log: line => h.logs.push(line), notify: () => {}, queued: (key, item) => { feedback.push(queued(key, item)) },
  })
  await h.ready()
  return { h, t: h.threads!, io, queueIo, events, received, reporting, settleFeedback: () => Promise.all(feedback) }
}
/**
 * alpha's held replies get no report, queued reaction, preparation or lost-message handling, and no
 * persona gets a row read or restart ask; `calls` skips alpha's earlier Slack calls, and `prepared`
 * is the only preparation another persona may get.
 */
function quiet(h: RoutingHarness, received: unknown[], calls = 0, prepared: RoutingHarness['preparationCalls'] = []) {
  expect(received).toEqual([])
  expect(h.p('alpha').stub.callLog.slice(calls)).toEqual([])
  expect(h.preparationCalls).toEqual(prepared)
  expect(h.queued('alpha').map(item => item.fixed)).toEqual(h.queued('alpha').map(() => undefined))
  expect(h.rowReads).toEqual([])
  expect(h.restartAsks).toEqual([])
  expect(h.launches).toEqual([])
  expect(isRestartPendingOrActive('alpha')).toBe(false)
}

describe.each(['strict', 'open'] as const)('%s Memory Hold routing', mode => {
  const A = THREAD_CHANNELS.primary, B = THREAD_CHANNELS.secondary
  const reply = (overrides: Partial<SlackEvent> = {}) => makeChannelMessage({ channel: A, thread_ts: THREAD_ROOTS.primary, text: 'waiting for Thread Memory', ...overrides })

  async function unreadable(options: Parameters<typeof makeRoutingHarness>[2] = {}) {
    const run = await holdRoutingHarness(mode, { ...options, unreadable: true })
    expect(run.t.memory.view('alpha', A, THREAD_ROOTS.primary)).toBe('unknown')
    expect(run.t.events.filter(e => e.type === 'read-failed').map(e => e.key)).toEqual(['alpha'])
    return run
  }
  async function resolve(h: RoutingHarness, outcome: 'released' | 'withdrawn', seq = h.queued('alpha')[0]!.accepted.seq) {
    await h.queue.resolveHolds('alpha', [{ seq, outcome, at: h.threads!.memory.clock('alpha') }])
    return h.queue.item('alpha', seq)!
  }

  test('stores the exact hold before ack and notifies its resolver only after ack, without post-ack work', async () => {
    const { h, received, events } = await unreadable({ sessions: [] }), t = h.threads!
    const stamp = t.fact({ channel: A }).stamp, before = t.memory.clock('alpha'), event = reply()
    let releaseAck!: () => void
    const ack = new Promise<void>(done => { releaseAck = done }), atAck: unknown[] = []
    const work = h.receive(event, ['alpha'], async () => {
      atAck.push(readQueue(dir))
      h.order.push('ack-start')
      await ack
      h.order.push('ack-end')
    })
    try {
      await t.clock.flush()
      const hold = memoryHold(before + 1, { thread_ts: THREAD_ROOTS.primary, stamp })
      expect(atAck).toEqual([[expect.objectContaining({ kind: 'accepted', via: 'thread', hold,
        key: { chat_id: A, ts: event.ts }, text: event.text, thread_ts: THREAD_ROOTS.primary,
        queued_ack_reaction: h.config!.queued_ack_reaction })]])
      expect(h.queued('alpha')[0]!.accepted.hold).toEqual(hold)
      expect(h.queued('alpha')[0]!.accepted.thread_join).toBeUndefined()
      expect(h.queued('alpha')[0]!.hold).toEqual({ field: hold, kind: 'memory', state: 'unresolved' })
      expect(h.queued('beta')).toEqual([])
      expect(h.holdStored).toEqual([])
      expect(h.queue.openCount('alpha')).toBe(0)
      quiet(h, received)
      releaseAck(); await work
      expect(h.holdStored).toEqual(['alpha'])
      expect(h.order.indexOf('hold-stored:alpha')).toBeGreaterThan(h.order.indexOf('ack-end'))
      quiet(h, received)
      await h.receive(reply({ thread_ts: THREAD_ROOTS.secondary }), ['alpha'])
      expect(h.queued('alpha')[1]!.accepted.hold).toEqual(memoryHold(before + 2, { stamp, thread_ts: THREAD_ROOTS.secondary }))
      expect(events.filter(e => e.type === 'stored').map(e => e.key)).toEqual(['alpha', 'alpha'])
      quiet(h, received)
    } finally { releaseAck(); await work }
  })

  test('unknown memory keeps DMs, mentions, Broadcasts, known joins, other channels and personas flowing', async () => {
    const { h, received, settleFeedback } = await unreadable(), held = reply()
    await h.receive(held, ['alpha'])
    const events = [
      { key: 'alpha', via: 'dm', event: makeDm() },
      { key: 'alpha', via: 'mention', event: reply({ thread_ts: THREAD_ROOTS.secondary, text: mentionText(h.p('alpha').stub.identity.botUserId) }) },
      { key: 'alpha', via: 'broadcast', event: reply({ thread_ts: THREAD_ROOTS.third, text: broadcastText() }) },
      { key: 'alpha', via: 'thread', event: reply({ thread_ts: THREAD_ROOTS.secondary }) },
      { key: 'alpha', via: 'receive_all_shared', event: makeChannelMessage({ channel: B }) },
      { key: 'beta', via: 'mention', event: reply({ text: mentionText(h.p('beta').stub.identity.botUserId) }) },
      { key: 'beta', via: 'thread', event: reply() },
    ]
    for (const { key, event } of events) await h.receive(event, [key])
    await h.settleJoinSaves(); await settleFeedback()
    expect(h.order.filter(x => x === 'ack')).toHaveLength(events.length + 1)
    for (const key of ['alpha', 'beta']) {
      const flowing = h.queued(key).filter(item => !item.hold)
      expect(flowing.map(item => [item.accepted.ts, item.accepted.via])).toEqual(events.filter(e => e.key === key).map(e => [e.event.ts as string, e.via]))
      expect(flowing.every(item => item.fixed !== undefined)).toBe(true)
      expect(h.p(key).stub.calls.reactionsAdd.map(call => call.timestamp)).toEqual(flowing.map(item => item.accepted.ts))
      expect(received.filter(r => r.key === key).map(r => r.seq)).toEqual(flowing.map(item => item.accepted.seq))
    }
    expect(h.threads!.memory.view('alpha', A, THREAD_ROOTS.primary)).toBe('unknown')
    expect(h.threads!.memory.view('alpha', A, THREAD_ROOTS.secondary)).toBe('joined')
    expect(h.threads!.memory.view('alpha', A, THREAD_ROOTS.third)).toBe('joined')
    expect(h.threads!.memory.joins('alpha').map(({ join }) => [join.root, join.source])).toEqual([
      [THREAD_ROOTS.secondary, 'mention'], [THREAD_ROOTS.third, 'broadcast'],
    ])
    expect(h.queued('alpha')[0]!.hold?.state).toBe('unresolved')
    expect(h.queued('alpha')[0]!.fixed).toBeUndefined()
    const engine = await makeEngineHarness({ queue: h.queue, stateDir: dir, keys: ['alpha', 'beta'] })
    try {
      await engine.tick('alpha'); await engine.tick('beta')
      await engine.until(() => h.queue.openCount('alpha') + h.queue.openCount('beta') === 0)
      for (const key of ['alpha', 'beta']) expect(h.queued(key).filter(item => !item.hold).every(item => item.delivered)).toBe(true)
      expect(h.queued('alpha')[0]!.delivered).toBe(false)
    } finally { await engine.cleanup() }
  })

  test('an undecided Channel Stamp withholds the ack; the decided retry stores one hold', async () => {
    let unsynced = false
    const authority = makeSharedAuthority(dir, { ...threadConfig(dir, 'thread_hybrid', ['alpha', 'beta'], [A, B]), channel_mode: mode }, {
      write(path, bytes) {
        durableWriteFileSync(path, bytes)
        if (unsynced) throw new DurableWriteUnsyncedError(path, new Error('fixture directory sync refused'))
      },
    })
    const { h, received } = await unreadable({ channelDelivery: { stateDir: dir, authority } }), event = reply()
    unsynced = true
    expect(h.threads!.choose('thread_hybrid', 'alpha', A).kind).toBe('unresolved')
    expect(authority.channelStamp('alpha', A)).toEqual({ kind: 'undecided' })
    await h.receive(event, ['alpha']); await h.receive(event, ['alpha'])
    expect(h.order.filter(x => x === 'ack')).toEqual([])
    expect(h.queued('alpha')).toEqual([])
    expect(h.holdStored).toEqual([])
    quiet(h, received)
    unsynced = false
    expect(authority.recoverDurability().kind).toBe('applied')
    expect(authority.channelStamp('alpha', A)?.kind).toBe('decided')
    await h.receive(event, ['alpha']); await h.receive(event, ['alpha'])
    expect(h.order.filter(x => x === 'ack')).toHaveLength(2)
    expect(h.queued('alpha')).toHaveLength(1)
    expect(h.queued('alpha')[0]!.hold?.state).toBe('unresolved')
    expect(h.queued('alpha')[0]!.accepted.hold?.stamp).toEqual(h.threads!.fact({ channel: A }).stamp)
    quiet(h, received)
  })

  test('unknown memory with no joins dependency never stores or acknowledges a guessed hold', async () => {
    const { h, received, events } = await unreadable({ threadMemory: { joins: false } })
    await h.receive(reply(), ['alpha'])
    expect(h.order.filter(x => x === 'ack')).toEqual([])
    expect(h.queued('alpha')).toEqual([])
    expect(events.filter(e => e.type === 'stored')).toEqual([])
    expect(h.holdStored).toEqual([])
    quiet(h, received)
  })

  test('a failed hold store withholds ack and reports Message not saved; retry stores exactly once', async () => {
    const { h, received, queueIo, events } = await unreadable({ sessions: [] }), event = reply()
    queueIo.fail('writeSync', 'alpha', { match: path => path === queuePath(dir) })
    await h.receive(event, ['alpha'])
    expect(h.order.filter(x => x === 'ack')).toEqual([])
    expect(h.queued('alpha')).toEqual([])
    expect(h.queue.unresolvedHolds('alpha')).toEqual([])
    expect(h.holdStored).toEqual([])
    expect(events.filter(e => e.type === 'store-failed').map(e => e.key)).toEqual(['alpha'])
    expect(h.episodeNotices).toEqual([{ key: 'alpha', text: buildMessageNotSavedNotice(renderPersonaRef(h.p('alpha').persona.name, 'alpha'), event.user as string) }])
    quiet(h, received)
    queueIo.heal()
    await h.receive(event, ['alpha']); await h.receive(event, ['alpha'])
    expect(h.order.filter(x => x === 'ack')).toHaveLength(2)
    expect(h.queued('alpha')).toHaveLength(1)
    expect(events.filter(e => e.type === 'stored').map(e => e.key)).toEqual(['alpha'])
    expect(readQueue(dir).filter(record => record.kind === 'accepted')).toHaveLength(1)
    quiet(h, received)
  })

  test.each(['unresolved', 'released', 'withdrawn'] as const)('%s duplicates retain one record and preserve their reporting stage', async state => {
    const { h, received, settleFeedback } = await unreadable(), event = reply()
    await h.receive(event, ['alpha'])
    if (state !== 'unresolved') await resolve(h, state)
    const before = readQueue(dir), item = h.queued('alpha')[0]!
    await h.receive(event, ['alpha']); await settleFeedback()
    expect(h.order.filter(x => x === 'ack')).toHaveLength(2)
    expect(h.queued('alpha')).toHaveLength(1)
    expect(readQueue(dir).filter(record => record.kind === 'accepted')).toHaveLength(1)
    if (state === 'released') {
      expect(received).toEqual([{ key: 'alpha', seq: item.accepted.seq, mode: 'live' }])
      expect(h.queued('alpha')[0]!.fixed).toBeDefined()
      expect(h.p('alpha').stub.calls.reactionsAdd).toEqual([{ channel: A, timestamp: event.ts as string, name: item.accepted.queued_ack_reaction! }])
      const fixed = readQueue(dir)
      await h.receive(event, ['alpha']); await settleFeedback()
      expect(readQueue(dir)).toEqual(fixed)
      expect(received).toHaveLength(1)
      expect(h.p('alpha').stub.calls.reactionsAdd).toHaveLength(1)
    } else {
      expect(readQueue(dir)).toEqual(before)
      quiet(h, received)
    }
  })

  test.each([['healthy', false], ['initially failing', true]] as const)('P held and Q delivered share one aggregate ack with a %s Q store', async (_label, failQ) => {
    const { h, received, queueIo, events, settleFeedback } = await unreadable()
    expect(h.threads!.choose('all', 'beta', A).kind).toBe('applied')
    const event = reply(), atAck: unknown[] = []
    if (failQ) queueIo.fail('writeSync', 'beta', { match: path => path === queuePath(dir, 'beta') })
    const ack = () => {
      atAck.push(['alpha', 'beta'].map(key => readQueue(dir, key).filter(record => record.kind === 'accepted')))
      h.order.push('ack')
    }
    await h.receive(event, ['alpha', 'beta'], ack)
    if (failQ) {
      expect(atAck).toEqual([])
      expect(h.queued('alpha')).toHaveLength(1); expect(h.queued('beta')).toEqual([])
      expect(h.holdStored).toEqual([])
      expect(received).toEqual([])
      expect(h.p('alpha').stub.callLog).toEqual([])
      queueIo.heal(); await h.receive(event, ['alpha', 'beta'], ack)
    }
    await settleFeedback()
    expect(atAck).toEqual([[
      [expect.objectContaining({ via: 'thread', hold: h.queued('alpha')[0]!.accepted.hold })],
      [expect.objectContaining({ via: 'receive_all', ts: event.ts })],
    ]])
    expect(events.filter(e => e.type === 'stored').map(e => e.key)).toEqual(['alpha', 'beta'])
    expect(h.holdStored).toEqual(['alpha'])
    expect(h.order.indexOf('hold-stored:alpha')).toBeGreaterThan(h.order.indexOf('ack'))
    expect(received).toEqual([{ key: 'beta', seq: h.queued('beta')[0]!.accepted.seq, mode: 'live' }])
    expect(h.queued('alpha')[0]!.fixed).toBeUndefined()
    expect(h.p('alpha').stub.callLog).toEqual([])
    expect(h.queued('beta')[0]!.fixed).toBeDefined()
    expect(h.p('beta').stub.calls.reactionsAdd).toHaveLength(1)
  })

  test.each([['live', 'uncompacted'], ['recovered', 'uncompacted'], ['live', 'compacted'], ['recovered', 'compacted']] as const)('%s release at time zero (%s) reports, uses the stored reaction and prepares; only live recovers a disconnected session', async (releaseMode, representation) => {
    const { h, received, reporting, settleFeedback } = await unreadable({ sessions: [], ...(releaseMode === 'recovered' ? { notUp: ['alpha'] } : {}) })
    const event = reply()
    await h.receive(event, ['alpha'])
    const originalReaction = h.queued('alpha')[0]!.accepted.queued_ack_reaction!
    h.config!.queued_ack_reaction = 'changed_after_hold'
    const seq = h.queued('alpha')[0]!.accepted.seq
    // Zero is a valid release time, including when compaction removes the hold summary.
    await h.queue.resolveHolds('alpha', [{ seq, outcome: 'released', at: 0 }])
    if (representation === 'compacted') await h.queue.compact('alpha')
    const item = h.queue.item('alpha', seq)!
    if (representation === 'compacted') {
      expect(item.hold).toBeUndefined()
      expect(item.accepted.hold).toBeUndefined()
      expect(item.accepted.released_at).toBe(0)
    } else {
      expect(item.hold).toMatchObject({ state: 'released', at: 0 })
    }
    await h.releaseHeld('alpha', item, releaseMode); await settleFeedback()
    expect(received).toEqual([{ key: 'alpha', seq: item.accepted.seq, mode: releaseMode }])
    expect(h.queued('alpha')[0]!.fixed?.parts.join('')).toContain('via="thread"')
    expect(h.queued('alpha')[0]!.fixed?.parts.join('')).toContain(event.text as string)
    expect(h.rowReads).toEqual(releaseMode === 'live' ? ['alpha'] : [])
    expect(h.restartAsks).toEqual(releaseMode === 'live' ? ['alpha'] : [])
    expect(isRestartPendingOrActive('alpha')).toBe(releaseMode === 'live')
    if (releaseMode === 'recovered') {
      expect(h.upAsks).toEqual([])
      expect(h.p('alpha').stub.calls.reactionsAdd).toEqual([])
      h.notUp.delete('alpha'); h.registerFor('alpha')
      reporting.reconcileQueued('alpha'); await settleFeedback()
    }
    expect(h.p('alpha').stub.calls.reactionsAdd).toEqual([{ channel: A, timestamp: event.ts as string, name: originalReaction }])
    const fixed = readQueue(dir)
    reporting.reconcileQueued('alpha'); await settleFeedback()
    await h.receive(event, ['alpha'])
    expect(h.p('alpha').stub.calls.reactionsAdd).toHaveLength(1)
    expect(received).toHaveLength(1)
    expect(readQueue(dir)).toEqual(fixed)
  })

  test.each(['live', 'recovered'] as const)('%s release ignores unresolved, withdrawn and ordinary items', async releaseMode => {
    const { h, received } = await unreadable({ sessions: [] })
    await h.receive(reply(), ['alpha'])
    await h.releaseHeld('alpha', h.queued('alpha')[0]!, releaseMode)
    quiet(h, received)
    await h.releaseHeld('alpha', await resolve(h, 'withdrawn'), releaseMode)
    quiet(h, received)
    const ordinary = await h.queue.accept('alpha', slackInput({ channel: B }))
    if (ordinary.status !== 'accepted' || !ordinary.item) throw new Error('ordinary item was not stored')
    await h.releaseHeld('alpha', ordinary.item, releaseMode)
    quiet(h, received)
  })

  test('P’s unreadable memory and pending resolver never delay Q’s intake', async () => {
    let release!: () => void
    const pending = new Promise<void>(done => { release = done })
    const { h, received } = await unreadable({ threadMemory: { onHoldStored: () => pending } })
    let pFinished = false, qFinished = false
    const p = h.receive(reply(), ['alpha']).then(() => { pFinished = true })
    const q = h.receive(makeChannelMessage({ channel: B }), ['beta']).then(() => { qFinished = true })
    try {
      await h.threads!.clock.flush()
      expect(qFinished).toBe(true)
      expect(pFinished).toBe(true)
      expect(h.queued('beta')[0]!.fixed).toBeDefined()
      expect(h.order.filter(x => x === 'ack')).toHaveLength(2)
      expect(received.map(r => r.key)).toEqual(['beta'])
      expect(h.queued('alpha')[0]!.hold?.state).toBe('unresolved')
      expect(h.p('alpha').stub.callLog).toEqual([])
    } finally { release(); await Promise.all([p, q]) }
  })
})

describe.each(['strict', 'open'] as const)('%s serial hybrid joins', mode => {
  async function joined(options: Parameters<typeof makeRoutingHarness>[2] = {}, choice: 'off' | 'mentions' | 'all' | 'thread_hybrid' = 'thread_hybrid', baseDir = dir) {
    const h = makeRoutingHarness(['alpha', 'beta'].map(name => ({ name, channels: [{ id: CA, delivery: choice }], dm: { enabled: true } })), baseDir,
      { mode, threadMemory: {}, membership: observedMembership({ alpha: [CA], beta: [CA] }), restartDelayS: NEVER_FIRE_RESTART_DELAY_S, ...options })
    harnesses.push(h)
    await h.ready()
    return h
  }
  const reply = (root: string = THREAD_ROOTS.primary) => makeChannelMessage({ channel: CA, thread_ts: root, text: 'the next reply' })
  const mention = (h: RoutingHarness, root: string = THREAD_ROOTS.primary) => makeChannelMessage({ channel: CA, ts: root, text: mentionText(h.p('alpha').stub.identity.botUserId) })
  const expected = (event: SlackEvent, via: string) => ({ channel: event.channel as string, ts: event.ts as string, text: event.text as string, via })
  const savedJoins = (key = 'alpha') => readThreads(dir, key).filter(r => r.kind === 'join')
  function observeIntake(h: RoutingHarness) {
    const calls: string[] = []
    const decided = h.queue.acceptDecided, plain = h.queue.accept, lookup = h.queue.lookupSlackKey
    h.queue.acceptDecided = (key, slackKey, decide) => {
      calls.push(`serial:${key}`)
      return decided(key, slackKey, facts => { calls.push(`decide:${key}`); return decide(facts) })
    }
    h.queue.accept = (key, input) => { calls.push(`plain:${key}`); return plain(key, input) }
    h.queue.lookupSlackKey = (key, slackKey) => { calls.push(`lookup:${key}`); return lookup(key, slackKey) }
    return calls
  }

  test.each(['mention', 'broadcast'] as const)('%s joins before the next concurrent decision and ack while its save is held', async source => {
    const h = await joined(), t = h.threads!, paths = observeIntake(h)
    const event = source === 'mention' ? mention(h) : makeChannelMessage({ channel: CA, ts: THREAD_ROOTS.primary, text: broadcastText() })
    const next = reply(), priorTime = t.memory.clock('alpha'), stamp = t.fact({ channel: CA }).stamp
    // fact() takes a clock reading too. The decision must take the next one.
    const beforeDecision = t.memory.clock('alpha')
    expect(beforeDecision).toBeGreaterThan(priorTime)
    const release = h.holdJoinSaves('alpha'), atAck: unknown[] = []
    let finished = false
    const work = Promise.all([h.receive(event, ['alpha'], () => {
      atAck.push({ joined: t.memory.view('alpha', CA, THREAD_ROOTS.primary), accepted: readQueue(dir).filter(r => r.kind === 'accepted'), saved: savedJoins(), calls: [...h.p('alpha').stub.callLog] })
      h.order.push('ack:join')
    }), h.receive(next, ['alpha'])]).then(() => { finished = true })
    try {
      await t.clock.flush()
      expect(finished).toBe(true)
      expect(facts(h, 'alpha')).toEqual([expected(event, source), expected(next, 'thread')])
      expect(facts(h, 'beta')).toEqual([])
      const fact = { channel: CA, root: THREAD_ROOTS.primary, stamp, at: beforeDecision + 1, source }
      expect(h.queued('alpha').map(i => i.accepted.thread_join)).toEqual([{ thread_ts: fact.root, stamp, at: fact.at }, undefined])
      expect(t.memory.joins('alpha')).toEqual([{ join: fact }])
      expect(savedJoins()).toEqual([])
      expect(atAck).toHaveLength(1)
      // The first ack needs its own durable store and join; the reply may store later.
      expect(atAck[0]).toMatchObject({ joined: 'joined', saved: [], calls: [], accepted: expect.arrayContaining([
        expect.objectContaining({ ...expected(event, source), thread_join: { thread_ts: fact.root, stamp, at: fact.at } }),
      ]) })
      expect(paths).toEqual(['serial:alpha', 'serial:alpha', 'decide:alpha', 'decide:alpha'])
      expect(h.order.indexOf('save-join:alpha')).toBeGreaterThan(h.order.indexOf('ack:join'))
      release(); await h.settleJoinSaves()
      expect(savedJoins()).toEqual([expect.objectContaining(fact)])
    } finally { release(); await work; await h.settleJoinSaves() }
  })

  test('two recipients join independently with one ack after both durable stores', async () => {
    const stores: string[] = [], h = await joined({ queueOptions: { onEvent: e => { if (e.type === 'stored') stores.push(e.key) } } })
    const event = makeChannelMessage({ channel: CA, ts: THREAD_ROOTS.primary, text: ['alpha', 'beta'].map(k => mentionText(h.p(k).stub.identity.botUserId)).join(' ') })
    const atAck: unknown[] = []
    await h.receive(event, ['alpha', 'beta'], () => {
      atAck.push({ stores: [...stores], joins: ['alpha', 'beta'].map(k => h.threads!.memory.view(k, CA, THREAD_ROOTS.primary)), saved: ['alpha', 'beta'].map(savedJoins) })
    })
    expect(atAck).toEqual([{ stores: ['alpha', 'beta'], joins: ['joined', 'joined'], saved: [[], []] }])
    await h.settleJoinSaves()
    const next = reply(); await h.receive(next)
    for (const key of ['alpha', 'beta']) {
      expect(facts(h, key)).toEqual([expected(event, 'mention'), expected(next, 'thread')])
      expect(savedJoins(key)).toHaveLength(1)
      expect(h.queued(key)[0]!.accepted.thread_join?.stamp).toEqual(h.threads!.fact({ channel: CA }, key).stamp)
    }
  })

  test('a pending ack defers saves and Slack work; later hung queued feedback cannot delay acceptance', async () => {
    let releaseAck!: () => void
    const ack = new Promise<void>(resolve => { releaseAck = resolve }), reaction = makeDeferredWebApiCall(), feedback: Promise<void>[] = []
    let queued: ReturnType<typeof createQueuedAckCallback> | undefined
    const h = await joined({ stubOptions: { alpha: { reactionsAdd: [reaction.outcome] } }, onReceived: (key, item) => {
      const work = queued!(key, item); feedback.push(work); return work
    } })
    queued = createQueuedAckCallback({ queue: h.queue, getReaction: () => h.config!.queued_ack_reaction, clientFor: key => h.p(key).stub.web })
    let acked = false, finished = false
    const work = h.receive(mention(h), ['alpha'], async () => { await ack; acked = true }).then(() => { finished = true })
    try {
      await h.threads!.clock.flush()
      expect(h.queued('alpha')).toHaveLength(1)
      expect(h.threads!.memory.view('alpha', CA, THREAD_ROOTS.primary)).toBe('joined')
      expect(h.order.filter(x => x === 'save-join:alpha')).toEqual([])
      expect(h.p('alpha').stub.callLog).toEqual([])
      expect(acked).toBe(false)
      releaseAck(); await h.threads!.clock.flush()
      expect(acked).toBe(true); expect(finished).toBe(true)
      expect(reaction.settled).toBe(false)
      expect(h.p('alpha').stub.calls.reactionsAdd).toHaveLength(1)
      expect(h.queued('alpha')[0]!.fixed).toBeDefined()
      expect(h.order.filter(x => x === 'save-join:alpha')).toHaveLength(1)
    } finally { releaseAck(); if (!reaction.settled) reaction.settle(); await work; await Promise.all(feedback); await h.settleJoinSaves() }
  })

  test('a reply before the mention stays dropped; edits, deletions and reactions neither join nor remove joins', async () => {
    const h = await joined(), t = h.threads!, early = reply()
    await h.receive(early, ['alpha'])
    expect(h.queued('alpha')).toEqual([])
    expect(h.logs.some(line => line.includes('not-mentioned'))).toBe(true)
    const edits = [
      makeChannelMessage({ ...mention(h, THREAD_ROOTS.secondary), edited: { ts: THREAD_ROOTS.third } }),
      makeChannelMessage({ ...mention(h, THREAD_ROOTS.third), subtype: 'message_changed' }),
    ]
    for (const event of edits) await h.receive(event, ['alpha'])
    expect(h.queued('alpha').map(i => i.accepted.thread_join)).toEqual([undefined])
    expect(t.memory.joins('alpha')).toEqual([])
    const joinedEvent = mention(h); await h.receive(joinedEvent, ['alpha']); await h.settleJoinSaves()
    const joins = t.memory.joins('alpha'), before = readFileSync(threadPath(dir))
    for (const root of [THREAD_ROOTS.primary, THREAD_ROOTS.secondary]) {
      await h.receive(makeChannelMessage({ channel: CA, ts: root, subtype: 'message_deleted', deleted_ts: root, text: undefined }), ['alpha'])
      await h.receive(makeChannelMessage({ type: 'reaction_added', channel: undefined, ts: undefined, text: undefined, item: { type: 'message', channel: CA, ts: root }, reaction: 'eyes' }), ['alpha'])
    }
    expect(t.memory.joins('alpha')).toEqual(joins)
    expect(readFileSync(threadPath(dir))).toEqual(before)
    const next = reply(); await h.receive(next, ['alpha'])
    expect(facts(h, 'alpha')).toEqual([expected(edits[0]!, 'mention'), expected(joinedEvent, 'mention'), expected(next, 'thread')])
    expect(h.queued('alpha').some(i => i.accepted.ts === early.ts)).toBe(false)
    expect(h.order.filter(x => x === 'ack')).toHaveLength(9)
  })

  test('kept joins carry another queue copy; saved joins and paired Slack events add none', async () => {
    const h = await joined(), t = h.threads!, release = h.holdJoinSaves('alpha'), paths = observeIntake(h)
    try {
      const message = mention(h), app = makeAppMention({ ...message, type: 'app_mention' })
      await h.receive(app, ['alpha']); await h.receive(message, ['alpha']); await h.receive(message, ['alpha'])
      expect(h.queued('alpha')).toHaveLength(1)
      expect(h.queued('alpha')[0]!.accepted.thread_join).toBeDefined()
      expect(paths.filter(x => x === 'decide:alpha')).toHaveLength(1)
      expect(paths.filter(x => x === 'serial:alpha')).toHaveLength(mode === 'open' ? 2 : 3)
      const kept = makeChannelMessage({ channel: CA, thread_ts: message.ts, text: broadcastText() })
      await h.receive(kept, ['alpha'])
      expect(h.queued('alpha')[1]!.accepted.thread_join).toBeDefined()
      expect(t.memory.joins('alpha')).toHaveLength(1)
      expect(savedJoins()).toEqual([])
      release(); await h.settleJoinSaves()
      const saved = makeChannelMessage({ channel: CA, thread_ts: message.ts, text: mentionText(h.p('alpha').stub.identity.botUserId) })
      await h.receive(saved, ['alpha']); await h.settleJoinSaves()
      expect(facts(h, 'alpha')).toEqual([expected(message, 'mention'), expected(kept, 'broadcast'), expected(saved, 'mention')])
      expect(h.queued('alpha')[2]!.accepted.thread_join).toBeUndefined()
      expect(savedJoins()).toHaveLength(1)
      expect(h.order.filter(x => x === 'ack')).toHaveLength(5)
    } finally { release(); await h.settleJoinSaves() }
  })

  test.each(['off', 'mentions', 'all'] as const)('%s preserves plain intake, exact records and ack observations with or without joins', async choice => {
    const without = await joined({ threadMemory: undefined, dedupeClock: () => 0 }, choice, mkdtempSync(join(dir, 'without-')))
    const h = await joined({ dedupeClock: () => 0, stubOptions: Object.fromEntries(without.all.map(p => [p.persona.key, p.stub.identity])) }, choice), paths = observeIntake(h)
    const events = [mention(h), makeChannelMessage({ channel: CA, ts: THREAD_ROOTS.secondary, text: broadcastText() })]
    const snapshots: unknown[][] = [[], []]
    for (const [index, run] of [without, h].entries()) for (const event of events) await run.receive(event, ['alpha'], () => {
      snapshots[index]!.push({ items: run.queued('alpha'), calls: [...run.p('alpha').stub.callLog] })
    })
    expect(snapshots[1]).toEqual(snapshots[0])
    expect(h.queued('alpha')).toEqual(without.queued('alpha'))
    expect(h.queued('alpha').map(i => i.accepted.thread_join)).toEqual(choice === 'off' ? [] : [undefined, undefined])
    expect(paths.some(x => x.startsWith('serial:'))).toBe(false)
    expect(h.threadMemoryReads).toEqual([])
    expect(h.threads!.memory.joins('alpha')).toEqual([])
    expect(existsSync(threadPath(dir))).toBe(false)
    expect(h.threads!.choose('thread_hybrid', 'alpha', CA).kind).toBe('applied')
    await h.threads!.memory.activate()
    const count = h.queued('alpha').length
    for (const event of events) await h.receive(reply(event.ts as string), ['alpha'])
    expect(h.queued('alpha')).toHaveLength(count)
    const fresh = makeChannelMessage({ channel: CA, thread_ts: THREAD_ROOTS.primary, text: mentionText(h.p('alpha').stub.identity.botUserId) })
    await h.receive(fresh, ['alpha']); const next = reply(); await h.receive(next, ['alpha'])
    expect(facts(h, 'alpha').slice(count)).toEqual([expected(fresh, 'mention'), expected(next, 'thread')])
  })

  test('DMs and group DMs never enter serial intake or create Thread Memory', async () => {
    const h = await joined({}, 'mentions'), paths = observeIntake(h)
    for (const factory of [makeDm, makeGroupDmMessage]) for (const text of [mentionText(h.p('alpha').stub.identity.botUserId), broadcastText()]) {
      await h.receive(factory({ text }), ['alpha'])
    }
    expect(h.queued('alpha').map(i => [i.accepted.via, i.accepted.thread_join])).toEqual([['dm', undefined], ['dm', undefined]])
    expect(paths.some(x => x.startsWith('serial:'))).toBe(false)
    expect(h.threadMemoryReads).toEqual([])
    expect(h.threads!.memory.joins('alpha')).toEqual([])
    expect(existsSync(threadPath(dir))).toBe(false)
    expect(h.order.filter(x => x === 'ack')).toHaveLength(4)
  })

  test('temporary ineligibility preserves the stamp and join, selects nothing, then selects without another mention', async () => {
    const channels = { alpha: [CA], beta: [CA] }, h = await joined({ membership: observedMembership(channels) }), t = h.threads!
    await h.receive(mention(h), ['alpha']); await h.settleJoinSaves()
    const stamp = t.authority.channelStamp('alpha', CA), joins = t.memory.joins('alpha'), bytes = readFileSync(threadPath(dir)), count = h.queued('alpha').length
    const paths = observeIntake(h)
    // A transient membership projection can refuse intake without publishing a
    // verified leave. Only the latter removes the shared entry and stamp.
    channels.alpha = []
    for (const event of [reply(), makeChannelMessage({ ...mention(h, THREAD_ROOTS.secondary) }), makeChannelMessage({ channel: CA, text: broadcastText() })]) await h.receive(event, ['alpha'])
    expect(h.queued('alpha')).toHaveLength(count)
    expect(paths.some(x => x.startsWith('serial:'))).toBe(false)
    expect(t.authority.channelStamp('alpha', CA)).toEqual(stamp)
    expect(t.memory.joins('alpha')).toEqual(joins)
    expect(readFileSync(threadPath(dir))).toEqual(bytes)
    channels.alpha = [CA]
    const next = reply(); await h.receive(next, ['alpha'])
    expect(facts(h, 'alpha').slice(count)).toEqual([expected(next, 'thread')])
    expect(h.order.filter(x => x === 'ack')).toHaveLength(5)
  })

  test('unresolved membership withholds ack and requests verification even for a retained duplicate', async () => {
    let unresolved = false
    const requests: string[] = [], observed = observedMembership({ alpha: [CA], beta: [CA] })
    const h = await joined({ membership: {
      read: (key, channel, mode) => unresolved ? { kind: 'unresolved', reason: 'current-membership-missing' } : observed.read(key, channel, mode),
      hasUnresolved: () => unresolved, request: key => { requests.push(key) },
    } })
    const paths = observeIntake(h), event = mention(h)
    unresolved = true
    await h.receive(event, ['alpha'])
    expect(h.order.filter(x => x === 'ack')).toEqual([])
    expect(h.queued('alpha')).toEqual([])
    expect(h.threads!.memory.joins('alpha')).toEqual([])
    expect(requests).toEqual(['alpha'])
    unresolved = false; await h.receive(event, ['alpha']); await h.settleJoinSaves()
    const before = readFileSync(queuePath(dir))
    unresolved = true; await h.receive(event, ['alpha'])
    expect(h.order.filter(x => x === 'ack')).toHaveLength(1)
    expect(requests).toEqual(['alpha', 'alpha'])
    expect(readFileSync(queuePath(dir))).toEqual(before)
    expect(paths.filter(x => x === 'decide:alpha')).toHaveLength(2)
    expect(paths.filter(x => x === 'serial:alpha')).toHaveLength(3)
  })

  test('partial fanout saves the retained join, reports store failure and retries only the failed recipient', async () => {
    const io = threadFsControls(dir), events: QueueEvent[] = [], reports: string[] = []
    let reporting: ReturnType<typeof createDeliveryReporting> | undefined
    const h = await joined({ queueOptions: { fs: io.fs, onEvent: event => { events.push(event); reporting?.queueEvent(event) } }, onReceived: key => { reports.push(key) } })
    reporting = createDeliveryReporting({ queue: h.queue, episodes: h.episodes, persona: key => h.p(key).persona,
      state: () => ({ up: true }), log: line => h.logs.push(line), notify: () => {} })
    io.fail('writeSync', 'beta', { match: path => path === queuePath(dir, 'beta') })
    const event = makeChannelMessage({ channel: CA, ts: THREAD_ROOTS.primary, text: ['alpha', 'beta'].map(k => mentionText(h.p(k).stub.identity.botUserId)).join(' ') })
    await h.receive(event); await h.settleJoinSaves()
    expect(h.order.filter(x => x === 'ack')).toEqual([])
    expect(facts(h, 'alpha')).toEqual([expected(event, 'mention')]); expect(facts(h, 'beta')).toEqual([])
    expect(h.queued('alpha')[0]!.fixed).toBeUndefined()
    expect(savedJoins('alpha')).toHaveLength(1)
    expect(h.threads!.memory.joins('beta')).toEqual([])
    expect(reports).toEqual(['alpha'])
    expect(h.logs.filter(line => line.includes(MESSAGE_NOT_SAVED))).toHaveLength(1)
    expect(h.episodeNotices).toEqual([{ key: 'beta', text: buildMessageNotSavedNotice(renderPersonaRef(h.p('beta').persona.name, 'beta'), event.user as string) }])
    io.heal(); await h.receive(event); await h.settleJoinSaves(); await h.receive(event)
    expect(h.order.filter(x => x === 'ack')).toHaveLength(2)
    expect(events.filter(e => e.type === 'stored').map(e => e.key)).toEqual(['alpha', 'beta'])
    expect(events.filter(e => e.type === 'store-failed').map(e => e.key)).toEqual(['beta'])
    for (const key of ['alpha', 'beta']) {
      expect(facts(h, key)).toEqual([expected(event, 'mention')])
      expect(h.queued(key)[0]!.fixed).toBeDefined()
      expect(savedJoins(key)).toHaveLength(1)
    }
  })

  test('an unloadable queue acknowledges drops but withholds deliveries until the same event can store', async () => {
    const io = threadFsControls(dir), events: QueueEvent[] = []
    const h = await joined({ queueOptions: { fs: io.fs, onEvent: e => events.push(e) } })
    io.fail('readFileSync', 'alpha', { match: path => path === queuePath(dir) })
    const paths = observeIntake(h), event = mention(h)
    await h.receive(reply(), ['alpha']); await h.receive(event, ['alpha'])
    expect(h.order.filter(x => x === 'ack')).toHaveLength(1)
    expect(h.queued('alpha')).toEqual([])
    expect(events.filter(e => e.type === 'store-failed')).toHaveLength(1)
    expect(h.threads!.memory.joins('alpha')).toEqual([])
    expect(paths).toEqual(['serial:alpha', 'decide:alpha', 'serial:alpha', 'decide:alpha'])
    io.heal(); await h.receive(event, ['alpha']); await h.settleJoinSaves()
    expect(facts(h, 'alpha')).toEqual([expected(event, 'mention')])
    expect(h.order.filter(x => x === 'ack')).toHaveLength(2)
    expect(savedJoins()).toHaveLength(1)
  })

  test('failed join saves keep selection, queued feedback, preparation and reminder eligibility, including not-up intake', async () => {
    const feedback: Promise<void>[] = []
    let queued: ReturnType<typeof createQueuedAckCallback> | undefined
    const h = await joined({ notUp: ['alpha'], rowRead: { alpha: LIVENESS_READING_DEAD_ENDED }, dedupeClock: () => 0,
      onReceived: (key, item) => { feedback.push(queued!(key, item)) } })
    queued = createQueuedAckCallback({ queue: h.queue, getReaction: () => h.config!.queued_ack_reaction, clientFor: key => h.p(key).stub.web })
    const t = h.threads!, original = mention(h)
    t.io.fail('writeSync')
    await h.receive(original, ['alpha']); await h.settleJoinSaves()
    const next = reply(); await h.receive(next, ['alpha']); await Promise.all(feedback)
    expect(facts(h, 'alpha')).toEqual([expected(original, 'mention'), expected(next, 'thread')])
    expect(h.queued('beta')).toEqual([])
    expect(h.order.filter(x => x === 'ack')).toHaveLength(2)
    expect(t.events.filter(e => e.type === 'append-failed')).toHaveLength(1)
    expect(savedJoins()).toEqual([])
    expect(t.memory.joins('alpha')).toHaveLength(1)
    expect(h.rowReads).toEqual([]); expect(h.restartAsks).toEqual([]); expect(h.launches).toEqual([])
    const reaction = h.config!.queued_ack_reaction!
    expect(h.p('alpha').stub.calls.reactionsAdd).toEqual([original, next].map(e => ({ channel: CA, timestamp: e.ts as string, name: reaction })))
    expect(h.queued('alpha').map(i => i.accepted.queued_ack_reaction)).toEqual([reaction, reaction])
    expect(h.queued('alpha').every(i => i.fixed?.parts.every(part => part.includes(`via="${i.accepted.via}"`)))).toBe(true)
    const engine = await makeEngineHarness({ queue: h.queue, stateDir: dir })
    try {
      await engine.tick(); await engine.until(() => h.queue.openCount('alpha') === 0)
      expect(engine.textCalls().map(call => call.params.text)).toEqual(h.queued('alpha').flatMap(i => i.fixed!.parts))
      expect(h.queue.replyReminderItems('alpha').map(i => i.seq)).toEqual(h.queued('alpha').map(i => i.accepted.seq))
      expect(engine.errors).toEqual([])
      expect(t.events.filter(e => e.type === 'append-failed')).toHaveLength(1)
    } finally { await engine.cleanup() }
  })

  test('a blocked persona admission or save never blocks another persona, and ack precedes all network preparation', async () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const h = await joined(), real = h.queue.acceptDecided, releaseSave = h.holdJoinSaves('beta')
    h.queue.acceptDecided = async (key, slackKey, decide) => { if (key === 'alpha') { enter(); await gate }; return real(key, slackKey, decide) }
    const pending = h.receive(mention(h), ['alpha'])
    await entered
    let finished = false
    const beforeAck: unknown[] = []
    const other = makeChannelMessage({ channel: CA, text: mentionText(h.p('beta').stub.identity.botUserId) })
    const work = h.receive(other, ['beta'], () => { beforeAck.push([...h.p('beta').stub.callLog]) }).then(() => { finished = true })
    try {
      await h.threads!.clock.flush()
      expect(finished).toBe(true)
      expect(beforeAck).toEqual([[]])
      expect(facts(h, 'alpha')).toEqual([])
      expect(facts(h, 'beta')).toEqual([expected(other, 'mention')])
      expect(savedJoins('beta')).toEqual([])
    } finally { release(); releaseSave(); await Promise.all([pending, work]); await h.settleJoinSaves() }
  })
})

test('open hybrid join survives a real inventory becoming external and eligible again under the same stamp', async () => {
  const membership = makeMembershipHarness(dir, { mode: 'open', names: ['alpha', 'beta'], channels: [{ id: CA, delivery: 'thread_hybrid' }] })
  const stub = (key: string) => membership.h.stub(membership.h.p(key))
  let h: RoutingHarness | undefined
  try {
    for (const key of ['alpha', 'beta']) stub(key).script.inventory.push(membershipPage([CA]))
    await membership.start(); await membership.scan()
    h = makeRoutingHarness(['alpha', 'beta'].map(name => ({ name, channels: [{ id: CA, delivery: 'thread_hybrid' }] })), dir, {
      mode: 'open', threadMemory: {}, membership: membership.membership,
      channelDelivery: { stateDir: dir, authority: membership.authority },
      stubOptions: Object.fromEntries(['alpha', 'beta'].map(key => [key, stub(key).identity])), restartDelayS: NEVER_FIRE_RESTART_DELAY_S,
    })
    harnesses.push(h); await h.ready()
    const event = makeChannelMessage({ channel: CA, ts: THREAD_ROOTS.primary, text: mentionText(stub('alpha').identity.botUserId) })
    await h.receive(event, ['alpha']); await h.settleJoinSaves()
    const stamp = membership.authority.channelStamp('alpha', CA), joins = h.threads!.memory.joins('alpha')
    stub('alpha').script.inventory.push(membershipPage([{ id: CA, is_channel: true, is_im: false, is_mpim: false, is_ext_shared: true }]))
    membership.scanner.request('alpha'); await membership.scan()
    expect(membership.membership.read('alpha', CA, 'open')).toEqual({ kind: 'ineligible', reason: 'external-sharing' })
    expect(membership.authority.channelStamp('alpha', CA)).toEqual(stamp)
    await h.receive(makeChannelMessage({ channel: CA, thread_ts: event.ts }), ['alpha'])
    expect(h.queued('alpha').map(i => i.accepted.ts)).toEqual([event.ts as string])
    expect(h.threads!.memory.joins('alpha')).toEqual(joins)
    stub('alpha').script.inventory.push(membershipPage([CA]))
    membership.scanner.request('alpha'); await membership.scan()
    expect(membership.membership.read('alpha', CA, 'open').kind).toBe('eligible')
    const next = makeChannelMessage({ channel: CA, thread_ts: event.ts })
    await h.receive(next, ['alpha'])
    expect(facts(h, 'alpha')).toEqual([event, next].map((e, i) => ({ channel: CA, ts: e.ts as string, text: e.text as string, via: i ? 'thread' : 'mention' })))
    expect(h.order.filter(x => x === 'ack')).toHaveLength(3)
    expect(membership.authority.channelStamp('alpha', CA)).toEqual(stamp)
  } finally { await h?.settleJoinSaves(); await h?.threads?.close(); assertNoLeak(membership.captured()); await membership.close() }
})

test.each(['strict', 'open'] as const)('%s staged restoration holds thread-dependent replies despite readableFor=true while independent and accepted work continues, even when not-up', async channel_mode => {
  const h = makeReloadHarness()
  let preparation: ReturnType<typeof createDeliveryPreparation> | undefined
  try {
    const alpha = h.persona('alpha', { channels: [{ id: CA, delivery: 'thread_hybrid' }, { id: CB, delivery: 'mentions' }, { id: CX, delivery: 'all' }], permission_prompts: CB, dm: { enabled: true } })
    const beta = h.persona('beta', { channels: [{ id: CA, delivery: 'all' }, { id: CB, delivery: 'mentions' }], permission_prompts: CB })
    h.materialize(alpha, beta)
    h.writeRecord({ channel_mode, personas: [alpha, beta] })
    h.writeConfig({ channel_mode, personas: [alpha, beta] })
    const slack = {
      alpha: { inventory: [membershipPage([CA, CB, CX])] }, beta: { inventory: [membershipPage([CA, CB])] },
    }
    let run = await h.startDetecting({ threadMemory: {}, slack })
    const restart = makeRestartDeps({ restartDelayS: NEVER_FIRE_RESTART_DELAY_S })
    initRestart(restart)
    await run.membershipClock.runNext()
    // A failed local bring-up beside a still-serving connection must remain
    // not-up. Use the real controller's directory failure and the harness's
    // production predicate, retaining current membership for intake.
    const establishNotUp = async () => {
      h.deleteWorkingDirectory(alpha)
      run.bringUps.cancel('alpha')
      const applied = run.controller.applied()!.config.personas
      await run.bringUps.bringUp(applied.find(p => p.key === 'alpha')!, applied)
      h.makeWorkingDirectory(alpha)
      expect(run.connections.manager.status('alpha')?.state).toBe('up')
      expect(run.bringUps.state('alpha')?.outcome).toBe('retrying')
      expect(run.isUp('alpha')).toBe(false)
      expect(run.isUp('beta')).toBe(true)
      run.registerSession('beta')
    }
    await establishNotUp()
    const lifecycleBefore = run.checkpoint()
    let authority = run.controller.sharedChannels()!
    expect(run.membership.read('alpha', CA, channel_mode).kind).toBe('eligible')
    const stamp = authority.channelStamp('alpha', CA)!
    if (stamp.kind !== 'decided' || !stamp.threadHybridSince) throw new Error('expected a thread stamp')
    const root = '1700000000.000001'
    expect(await run.threadMemory!.saveJoins('alpha', [{ channel: CA, root, source: 'mention', at: run.threadMemory!.clock('alpha'),
      stamp: { incarnation: stamp.incarnation, threadHybridSince: stamp.threadHybridSince } }])).toEqual({ kind: 'saved' })
    expect(run.threadMemory!.view('alpha', CA, root)).toBe('joined')
    const prepare = () => createDeliveryPreparation({ queue: run.queue, clientFor: () => undefined, resolveUserName: async (_key, user) => user })
    preparation = prepare()
    const logs: string[] = []
    const notices: string[] = []
    const episodes = createPersonaEpisodes({ sink: (_key, text) => { notices.push(text) }, log: line => logs.push(line), clock: run.clock })
    const rowReads: string[] = []
    const makeRouter = () => createPersonaRouting({
      getPersonaConfig: () => run.controller.applied()?.config,
      getChannelDelivery: () => run.channelDelivery,
      threadStampUndecided: (key, channel) => authority.channelStamp(key, channel)?.kind === 'undecided',
      threadStampEpisodes: episodes.threadStampUndecided,
      membership: run.membership,
      getBotIdentity: key => run.stub(key).identity,
      queue: run.queue, prepare: preparation!.prepare, archive: () => {}, log: line => logs.push(line),
      isPersonaUp: key => run.isUp(key),
      readRowLiveness: async key => { rowReads.push(key); return { kind: 'dead', cause: 'ended' } },
    })
    let routing = makeRouter()
    const mention = makeChannelMessage({ channel: CA, ts: '1700000000.000002', thread_ts: root, text: mentionText(run.stub('alpha').identity.botUserId) })
    const project = (event: SlackEvent, via: string) => ({ channel: event.channel as string, ts: event.ts as string, via, text: event.text as string })
    const queued = () => Object.fromEntries(['alpha', 'beta'].map(key => [key, run.queue.items(key).map(({ accepted }) => ({
      channel: accepted.channel, ts: accepted.ts, via: accepted.via, text: accepted.text,
    }))]))
    const durableQueues = () => Object.fromEntries(['alpha', 'beta'].map(key => [key,
      (existsSync(queuePath(h.stateDir, key)) ? readQueue(h.stateDir, key) : []).filter((record): record is AcceptedRecord => record.kind === 'accepted')
        .map(record => ({ channel: record.channel, ts: record.ts, via: record.via, text: record.text })),
    ]))
    const expected = { alpha: [project(mention, 'mention')], beta: [] as ReturnType<typeof project>[] }
    let acks = 0
    const acceptedAtAck: ReturnType<typeof durableQueues>[] = []
    const ack = () => { acks++ }
    await routing.receive(mention, () => {
      ack()
      acceptedAtAck.push(durableQueues())
    }, 'alpha', false)
    expect(acks).toBe(1)
    expect(acceptedAtAck).toEqual([expected])
    expect(queued()).toEqual(expected)
    const acceptedBefore = readFileSync(queuePath(h.stateDir, 'alpha'))
    const joins = run.threadMemory!.joins('alpha')
    const damage = h.writeRecordBytes('damaged authority with a retained owner snapshot')
    h.writeRequestBytes(configBytes(sharedRecoveryRequest('routing-restoration', damage)))
    await run.ticks.tick()
    expect(authority.readable).toBe(false)
    expect(authority.readableFor('alpha', CA)).toBe(true)
    expect(authority.channelStamp('alpha', CA)).toEqual({ kind: 'undecided' })
    expect(run.threadMemory!.joins('alpha')).toEqual(joins)
    expect(run.threadMemory!.view('alpha', CA, root)).toBe('not-joined')
    const dependent = makeChannelMessage({ channel: CA, ts: '1700000000.000003', thread_ts: root, text: 'dependent reply' })
    acks = 0
    await routing.receive(dependent, ack, 'alpha', false)
    await routing.receive(dependent, ack, 'alpha', false)
    expect(acks).toBe(0)
    expect(run.queue.items('alpha').map(i => i.accepted.ts)).toEqual([mention.ts as string])
    expect(readFileSync(queuePath(h.stateDir, 'alpha'))).toEqual(acceptedBefore)
    const warnings = () => logs.filter(line => line.includes(PERSONA_THREAD_STAMP_UNDECIDED))
    expect(warnings()).toHaveLength(1)
    // The diagnostic module pins this exported cause's finite-retry warning.
    expect(warnings()[0]).toContain(threadStampUndecidedCause(CA))
    await routing.receive(mention, ack, 'alpha', false)
    expect(acks).toBe(1)
    expect(readFileSync(queuePath(h.stateDir, 'alpha'))).toEqual(acceptedBefore)

    const independent = [
      { key: 'alpha', via: 'mention', event: makeChannelMessage({ channel: CA, thread_ts: root, ts: '1700000000.000004', text: mentionText(run.stub('alpha').identity.botUserId) }) },
      { key: 'alpha', via: 'broadcast', event: makeChannelMessage({ channel: CA, thread_ts: root, ts: '1700000000.000005', text: broadcastText('channel') }) },
      { key: 'alpha', via: 'dm', event: makeDm({ ts: '1700000000.000006', text: 'direct' }) },
      { key: 'alpha', via: 'receive_all', event: makeChannelMessage({ channel: CX, ts: '1700000000.000007', text: 'another channel' }) },
      { key: 'beta', via: 'receive_all', event: makeChannelMessage({ channel: CA, thread_ts: root, ts: '1700000000.000008', text: 'another persona' }) },
    ]
    for (const { key, via, event } of independent) {
      let ackCount = 0
      acceptedAtAck.length = 0
      await routing.receive(event, () => {
        ackCount++
        acceptedAtAck.push(durableQueues())
      }, key, false)
      expect(ackCount).toBe(1)
      expected[key as keyof typeof expected].push(project(event, via))
      expect(acceptedAtAck).toEqual([expected])
      expect(queued()).toEqual(expected)
    }
    // A held recipient cannot make the aggregate ack lie about partial fanout.
    acks = 0
    await routing.receive(dependent, ack, ['alpha', 'beta'], false)
    await routing.receive(dependent, ack, ['alpha', 'beta'], false)
    expect(acks).toBe(0)
    expect(run.queue.items('alpha').some(i => i.accepted.ts === dependent.ts)).toBe(false)
    expect(run.queue.items('beta').filter(i => i.accepted.ts === dependent.ts)).toHaveLength(1)
    expected.beta.push(project(dependent, 'receive_all'))
    expect(queued()).toEqual(expected)
    expect(warnings()).toHaveLength(1)
    expect(rowReads).toEqual([])
    expect(restart.restartAsks).toEqual([])
    expect(restart.launches).toEqual([])
    expect(['alpha', 'beta'].map(isRestartPendingOrActive)).toEqual([false, false])
    expect(run.since(lifecycleBefore).lifecycle).toEqual([])
    expect(run.isUp('alpha')).toBe(false)
    expect(run.isUp('beta')).toBe(true)
    expect(notices).toEqual([])
    expect(run.slackPosts()).toEqual([])

    assertNoLeak({ logs, captured: run.captured() })
    // Owned restoration is reviewed on the next start; it is never activated
    // by the running owner's ordinary detection tick.
    await preparation.stop(); await run.stop()
    const review = await h.start({ threadMemory: {} })
    expect(review.outcome.kind).toBe('refused')
    expect(h.pendingExists()).toBe(true)
    expect(review.slackPosts()).toEqual([])
    assertNoLeak(review.captured())
    await review.stop(); h.confirm()
    run = await h.start({ threadMemory: {}, slack })
    initRestart(restart)
    expect(run.outcome.kind).toBe('applied')
    await run.membershipClock.runNext()
    await establishNotUp()
    authority = run.controller.sharedChannels()!
    preparation = prepare(); routing = makeRouter()
    expect(authority.channelStamp('alpha', CA)?.kind).toBe('decided')
    expect(authority.channelStamp('alpha', CA)).not.toEqual(stamp)
    expect(run.threadMemory!.view('alpha', CA, root)).toBe('not-joined')
    await routing.receive(dependent, ack, ['alpha', 'beta'], false)
    expect(acks).toBe(1)
    expect(run.queue.items('alpha').some(i => i.accepted.ts === dependent.ts)).toBe(false)
    expect(run.queue.items('beta').filter(i => i.accepted.ts === dependent.ts)).toHaveLength(1)
    expect(queued()).toEqual(expected)
    expect(rowReads).toEqual([])
    expect(restart.restartAsks).toEqual([])
    expect(restart.launches).toEqual([])
    expect(['alpha', 'beta'].map(isRestartPendingOrActive)).toEqual([false, false])
    expect(notices).toEqual([])
    expect(run.slackPosts()).toEqual([{ method: 'chat.postMessage', args: {
      channel: CB,
      text: formatPersonaNotice({ name: 'alpha', key: 'alpha' },
        buildThreadMemoryChangedWhileStoppedNotice(renderPersonaRef('alpha', 'alpha'), [CA], 'unclean')),
    } }])
    assertNoLeak({ logs, captured: run.captured() })
  } finally { await preparation?.stop(); await h.cleanup() }
})

async function each(h: RoutingHarness, event: unknown) { await h.receive(event, ['alpha']); await h.receive(event, ['beta']) }
describe('persona routing and durable dedupe', () => {
  test('home, shared mention and DM retain exact target, source and via with empty bystander queues', async () => {
    const h = harness(); const mention = mentionText(h.p('alpha').stub.identity.botUserId)
    const home = makeChannelMessage({ channel: CA, text: 'home' }); const shared = makeChannelMessage({ channel: CS, text: `${mention} shared` }); const dm = makeDm({ text: 'direct' })
    await each(h, home); await each(h, shared); await h.receive(dm, ['alpha'])
    expect(facts(h, 'alpha')).toEqual([{ channel: CA, ts: home.ts as string, via: 'receive_all', text: 'home' }, { channel: CS, ts: shared.ts as string, via: 'mention', text: shared.text as string }, { channel: dm.channel as string, ts: dm.ts as string, via: 'dm', text: 'direct' }]); expect(facts(h, 'beta')).toEqual([])
    expect(h.all.flatMap(p => p.notifications)).toEqual([]); expect(h.allPosts()).toEqual([]); expect(h.all.flatMap(p => p.stub.calls.reactionsAdd)).toEqual([])
  })
  test.each(['mention', 'receive_all', 'dm'] as const)('%s preserves a 5000-byte body through durable acceptance and multipart preparation', async via => {
    const h = harness()
    const body = '  ' + 'River stones, quiet paths; '.repeat(200).slice(0, 4997) + ' '
    expect(Buffer.byteLength(body)).toBe(5000)
    const text = via === 'receive_all' ? body : body.slice(0, 2) + mentionText(h.p('alpha').stub.identity.botUserId) + ' \t\n' + body.slice(2)
    const event = via === 'dm' ? makeDm({ text }) : makeChannelMessage({ channel: via === 'mention' ? CS : CA, text })
    await each(h, event)
    expect(facts(h, 'alpha')).toEqual([{ channel: event.channel as string, ts: event.ts as string, via, text }])
    expect(facts(h, 'beta')).toEqual([])
    const records = readQueue(dir, h.p('alpha').persona.key)
    expect(records.filter(record => record.kind === 'accepted')).toEqual([h.queued('alpha')[0]!.accepted])
    const parts = h.queued('alpha')[0]!.fixed!.parts
    expect(parts.length).toBeGreaterThan(1)
    expect(records.filter(record => record.kind === 'fixed')).toEqual([h.queued('alpha')[0]!.fixed!])
    expect(parts.map(part => /^<channel [^>]*>([\s\S]*)<\/channel>$/.exec(part)![1]!).join('')).toBe(text.replace(/\t/g, '    '))
    expect(h.allPosts()).toEqual([])
  })
  test.each([
    ['quoted mentions', 'mention', (own: string, labelled: string) => `  > "${own}"\r\n\tand \`${labelled}\`  `],
    ['repeated mentions', 'mention', (own: string, labelled: string) => ` ${own}  first\t${labelled}\n${own} last\r\n `],
    ['mention only', 'mention', (own: string) => own],
    ['mentions surrounded by whitespace', 'dm', (own: string, labelled: string) => ` \t${own} \n${labelled}\r\n `],
    ['whitespace only', 'receive_all', () => ' \t\r\n  \n'],
    ['empty text', 'receive_all', () => ''],
  ] as const)('preserves %s verbatim in durable acceptance before documented tag escaping', async (_label, via, makeText) => {
    const h = harness()
    const ownId = h.p('alpha').stub.identity.botUserId
    const text = makeText(mentionText(ownId), mentionText(ownId, 'alpha'))
    const event = via === 'dm' ? makeDm({ text }) : makeChannelMessage({ channel: via === 'mention' ? CS : CA, text })
    await each(h, event)
    expect(facts(h, 'alpha')).toEqual([{ channel: event.channel as string, ts: event.ts as string, via, text }])
    expect(facts(h, 'beta')).toEqual([])
    const item = h.queued('alpha')[0]!
    expect(readQueue(dir, h.p('alpha').persona.key).filter(record => record.kind === 'accepted')).toEqual([item.accepted])
    const bodies = item.fixed!.parts.map(part => /^<channel [^>]*>([\s\S]*)<\/channel>$/.exec(part)![1]!).join('')
    expect(bodies).toBe(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    '))
    expect(h.allPosts()).toEqual([])
  })
  test.each([false, true])('message/app_mention pair in either order accepts once (%p)', async mentionFirst => {
    const h = harness(); const text = `${mentionText(h.p('alpha').stub.identity.botUserId)} body`; const message = makeChannelMessage({ channel: CS, text }); const app = { ...message, type: 'app_mention' }
    await h.receive(mentionFirst ? app : message, ['alpha']); await h.receive(mentionFirst ? message : app, ['alpha'])
    expect(facts(h, 'alpha')).toEqual([{ channel: CS, ts: message.ts as string, via: 'mention', text }]); expect(facts(h, 'beta')).toEqual([]); expect(h.order.filter(s => s === 'ack')).toHaveLength(2)
  })
  test('edited.ts distinguishes an edit; forget keeps durable dedupe and original via through mode/config changes', async () => {
    const h = harness(); const event = makeChannelMessage({ channel: CA }); await h.receive(event, ['alpha']); h.forget('alpha'); await h.receive(event, ['alpha'])
    await h.receive({ ...event, edited: { ts: '1700000001.000001' } }, ['alpha'])
    expect(h.queued('alpha').map(i => i.accepted.key)).toEqual([{ chat_id: CA, ts: event.ts as string }, { chat_id: CA, ts: event.ts as string, edited_ts: '1700000001.000001' }]); expect(facts(h, 'beta')).toEqual([])
    h.setMode('open'); await h.receive(event, ['alpha']); expect(h.queued('alpha')).toHaveLength(2); expect(h.queued('alpha').map(i => i.accepted.via)).toEqual(['receive_all', 'receive_all'])
  })
  test.each([undefined, null, {}, { type: 'reaction_added' }, { type: 'message', subtype: 'message_deleted' }])('nonmessage %p acks and stores nothing', async event => {
    const h = harness(); await h.receive(event); expect(h.order.filter(s => s === 'ack')).toEqual(['ack']); expect(facts(h, 'alpha')).toEqual([]); expect(facts(h, 'beta')).toEqual([])
  })
  test.each(['channel', 'dm', 'self', 'unmentioned'] as const)('drop %s is acked without queue/network', async kind => {
    const h = harness(); const p = h.p('beta'); const event = kind === 'dm' ? makeDm() : makeChannelMessage({ channel: kind === 'channel' ? CX : kind === 'unmentioned' ? CS : CB, ...(kind === 'self' ? { user: p.stub.identity.botUserId } : {}) })
    await h.receive(event, ['beta']); expect(facts(h, 'alpha')).toEqual([]); expect(facts(h, 'beta')).toEqual([]); expect(h.order.filter(s => s === 'ack')).toEqual(['ack']); expect(p.stub.calls.usersInfo).toEqual([])
  })
  test.each([
    { label: 'user takes precedence over bot and names', event: () => makeBotMessage({ channel: CA, user: 'U0SENDER1', username: 'webhook-name' }), sender: 'resolved-user', author: { user_id: 'U0SENDER1' } },
    { label: 'webhook username takes precedence over profile', event: () => makeWebhookPost({ channel: CA, bot_profile: { name: 'profile-name' } }), sender: 'stub-webhook', author: { bot_id: 'B0STUBHOOK' } },
    { label: 'bot profile supplies the sender', event: () => makeBotMessage({ channel: CA, user: undefined }), sender: 'stub-bot', author: { bot_id: 'B0STUBBOT2' } },
    { label: 'bot ID supplies the sender without a profile', event: () => makeBotMessage({ channel: CA, user: undefined, bot_profile: undefined }), sender: 'B0STUBBOT2', author: { bot_id: 'B0STUBBOT2' } },
  ])('$label through Slack acceptance and fixed tags', async row => {
    const lookups: Array<[string, string]> = []
    const h = harness({ resolveUserName: async (key, user) => { lookups.push([key, user]); return 'resolved-user' }, stubOptions: { alpha: { info: [{ kind: 'ok', result: { channel: { name: '#prepared-room' } } }] } } })
    const event = row.event()
    await h.receive(event, ['alpha'])
    const item = h.queued('alpha')[0]!
    expect(item.accepted).toMatchObject({ source: 'slack', channel: CA, text: event.text, user: event.user, bot_id: event.bot_id, username: event.username, bot_profile_name: (event.bot_profile as { name?: string } | undefined)?.name })
    expect(item.fixed!.parts).toEqual(buildTagParts({ chat_id: CA, channel_name: 'prepared-room', message_id: event.ts as string, user: row.sender, ...row.author, ts: event.ts as string, via: 'receive_all', text: event.text as string }))
    expect(lookups).toEqual(event.user ? [[h.p('alpha').persona.key, event.user as string]] : [])
    expect(h.p('alpha').stub.calls.usersInfo).toEqual([])
    expect(facts(h, 'beta')).toEqual([])
  })
  test('thread and attachment metadata survive Slack acceptance and filename sanitization into exact fixed tags', async () => {
    const h = harness({ resolveUserName: async () => 'resolved-user', stubOptions: { alpha: { info: [{ kind: 'ok', result: { channel: { name: '#prepared-room' } } }] } } })
    const files = [{ name: '../[report];\n.csv', mimetype: 'text/csv', size: 42 }, { id: 'F0UNKNOWN' }]
    const event = makeChannelMessage({ channel: CA, text: `${mentionText(h.p('alpha').stub.identity.botUserId)} threaded files`, thread_ts: '1700000000.000010', files: [...files, null] })
    await h.receive(event, ['alpha'])
    const item = h.queued('alpha')[0]!
    expect(item.accepted).toMatchObject({ thread_ts: event.thread_ts, text: event.text as string, files: [files[0], { name: 'unnamed' }] })
    expect(item.fixed!.parts).toEqual(buildTagParts({ chat_id: CA, channel_name: 'prepared-room', message_id: event.ts as string, user: 'resolved-user', user_id: event.user as string, ts: event.ts as string, thread_ts: event.thread_ts as string, via: 'mention', attachment_count: '2', attachments: `${sanitizeFilename(files[0]!.name!)} (text/csv, 42 bytes); unnamed (unknown, ? bytes)`, text: event.text as string }))
    expect(facts(h, 'beta')).toEqual([])
  })
})
describe('fungible mode', () => {
  test.each([false, true])('paired app mention is ignored in either order and message enters queue once (%p)', async mentionFirst => {
    const h = harness({ mode: 'open', channelDelivery: undefined });
    const alpha = h.p('alpha').persona; h.channelDelivery!.set(alpha.key, CX, 'mentions', alpha); const message = makeChannelMessage({ channel: CX, text: mentionText(h.p('alpha').stub.identity.botUserId) + ' hello' }); const app = { ...message, type: 'app_mention' }
    await h.receive(mentionFirst ? app : message, ['alpha']); await h.receive(mentionFirst ? message : app, ['alpha']); expect(facts(h, 'alpha')).toEqual([{ channel: CX, ts: message.ts as string, via: 'mention', text: message.text as string }]); expect(facts(h, 'beta')).toEqual([]); expect(h.heardChannels('alpha')).toEqual(new Set([CX])); expect(h.logs.filter(s => s.includes('persona-invited-channel'))).toHaveLength(1)
  })
  test.each(Object.entries(ENVELOPE_FLAG_FORMS))('envelope flag %s retains decision behavior', async (form, envelope) => {
    const h = harness({ mode: 'open', channelDelivery: undefined });
    const alpha = h.p('alpha').persona; h.channelDelivery!.set(alpha.key, CX, 'mentions', alpha); const event = makeChannelMessage({ channel: CX, text: mentionText(h.p('alpha').stub.identity.botUserId) + ' hello' }); await h.receive(event, ['alpha'], undefined, envelope)
    expect(h.queued('alpha')).toHaveLength(form === 'false' ? 1 : 0); expect(facts(h, 'beta')).toEqual([])
  })
})
describe('thread_hybrid without Thread Memory still selects @mentions and Broadcasts', () => {
  const CT = 'C0THREAD1', ROOT = '1700000000.000100'
  function threadHarness(mode: ChannelMode) {
    const h = makeRoutingHarness([{ name: 'alpha', channels: [{ id: CT, delivery: 'thread_hybrid' }] }], dir, { mode, membership: observedMembership({ alpha: [CT] }), restartDelayS: NEVER_FIRE_RESTART_DELAY_S })
    harnesses.push(h)
    const alpha = h.p('alpha').persona
    if (mode === 'open') h.channelDelivery!.set(alpha.key, CT, 'thread_hybrid', alpha)
    return h
  }
  /** The persona's root @mention is delivered; returns the stub's Web API call count once its preparation settled. */
  async function mentionedRoot(h: RoutingHarness): Promise<number> {
    await h.receive(makeChannelMessage({ channel: CT, ts: ROOT, text: `${mentionText(h.p('alpha').stub.identity.botUserId)} root` }))
    expect(facts(h, 'alpha')).toEqual([{ channel: CT, ts: ROOT, via: 'mention', text: expect.stringContaining('root') }])
    return h.p('alpha').stub.callLog.length
  }
  test.each(['strict', 'open'] as const)('%s: an unmentioned reply under a mentioning root is dropped as not-mentioned, acknowledged once, with no store or Slack call', async mode => {
    const h = threadHarness(mode)
    const calls = await mentionedRoot(h)
    await h.receive(makeChannelMessage({ channel: CT, ts: '1700000000.000101', thread_ts: ROOT, text: 'unmentioned reply' }))
    expect(h.order.filter(s => s === 'ack')).toEqual(['ack', 'ack'])
    expect(facts(h, 'alpha').map(f => f.ts)).toEqual([ROOT])
    expect(readQueue(dir, h.p('alpha').persona.key).flatMap(r => r.kind === 'accepted' && 'ts' in r ? [r.ts] : [])).toEqual([ROOT])
    expect(h.p('alpha').stub.callLog.slice(calls)).toEqual([])
    expect(h.p('alpha').stub.calls.conversationsReplies).toEqual([])
    expect(h.p('alpha').stub.calls.conversationsHistory).toEqual([])
    expect(h.logs.filter(l => l.includes('not-mentioned'))).toHaveLength(1)
  })
  test.each([
    ['strict', 'mention'], ['strict', 'broadcast'], ['open', 'mention'], ['open', 'broadcast'],
  ] as const)('%s: a %s reply there is delivered with its via and acknowledged once', async (mode, via) => {
    const h = threadHarness(mode)
    await mentionedRoot(h)
    const text = via === 'mention' ? `${mentionText(h.p('alpha').stub.identity.botUserId)} reply` : `${broadcastText('here')} reply`
    await h.receive(makeChannelMessage({ channel: CT, ts: '1700000000.000102', thread_ts: ROOT, text }))
    expect(h.order.filter(s => s === 'ack')).toEqual(['ack', 'ack'])
    expect(h.queued('alpha').map(i => ({ ts: i.accepted.ts, thread_ts: i.accepted.thread_ts, via: i.accepted.via }))).toEqual([
      { ts: ROOT, thread_ts: undefined, via: 'mention' }, { ts: '1700000000.000102', thread_ts: ROOT, via },
    ])
  })
})
describe.each(['strict', 'open'] as const)('%s own-post joins through intake and delivery', mode => {
  async function ownPostHarness() {
    const h = makeRoutingHarness(['alpha', 'beta'].map(name => ({
      name, channels: [{ id: CA, delivery: 'thread_hybrid' }], permission_prompts: CA,
      dm: { enabled: true },
    })), dir, { mode, threadMemory: {}, membership: observedMembership({ alpha: [CA], beta: [CA] }),
      restartDelayS: NEVER_FIRE_RESTART_DELAY_S })
    harnesses.push(h)
    await h.ready()
    return h
  }
  const humanReply = (root: string = THREAD_ROOTS.primary) =>
    makeChannelMessage({ channel: CA, thread_ts: root, text: 'unmentioned human reply' })

  test.each(['reply', 'notice', 'reply with failed appends'] as const)(
    '%s joins its confirmed root; the human reply is acknowledged once and delivered as thread, but siblings drop', async surface => {
      const h = await ownPostHarness(), t = h.threads!, stub = h.p('alpha').stub
      if (surface === 'reply with failed appends') t.io.fail('writeSync', 'alpha')
      stub.script.post.push({ kind: 'ok', result: { ts: THREAD_ROOTS.primary } })
      const text = 'a new thread from CSCB'
      if (surface === 'notice') await h.notifier.notify('alpha', text)
      else {
        await h.reply('alpha', { chat_id: CA, text })
        expect(h.replyResults).toEqual([{ content: [{ type: 'text', text: `Sent 1 message(s) to ${CA} [ts: ${THREAD_ROOTS.primary}]` }] }])
      }
      expect(stub.calls.postMessage).toHaveLength(1)
      expect(stub.calls.postMessage[0]).toMatchObject({ channel: CA, text: surface === 'notice' ? h.noticeText('alpha', text) : text })
      expect(stub.calls.postMessage[0]!.thread_ts).toBeUndefined()
      expect(t.memory.view('alpha', CA, THREAD_ROOTS.primary)).toBe('joined')
      expect(t.memory.view('beta', CA, THREAD_ROOTS.primary)).toBe('not-joined')
      if (surface === 'reply with failed appends') {
        await t.clock.flush()
        expect(t.events.filter(e => e.type === 'append-failed' && e.key === 'alpha')).toHaveLength(1)
        expect(t.memory.outage('alpha').unsaved).toBeGreaterThan(0)
        expect(readThreads(dir).filter(r => r.kind === 'join')).toEqual([])
      }

      const event = humanReply(), atAck: AcceptedRecord[][] = []
      await h.receive(event, ['alpha', 'beta'], () => {
        atAck.push(readQueue(dir).filter((r): r is AcceptedRecord => r.kind === 'accepted' && !('compact' in r)))
      })
      expect(atAck).toEqual([[expect.objectContaining({ channel: CA, ts: event.ts, via: 'thread', thread_ts: THREAD_ROOTS.primary })]])
      expect(facts(h, 'alpha')).toEqual([{ channel: CA, ts: event.ts as string, text: event.text as string, via: 'thread' }])
      expect(h.queued('beta')).toEqual([])
      const beforeSibling = h.logs.length
      await h.receive(humanReply(THREAD_ROOTS.secondary), ['alpha'])
      expect(h.order.filter(x => x === 'ack')).toHaveLength(1)
      expect(h.logs.slice(beforeSibling).filter(line => line.includes('not-mentioned'))).toHaveLength(1)
      expect(h.queued('alpha')).toHaveLength(1)
      expect(h.queued('beta')).toEqual([])

      const engine = await makeEngineHarness({ queue: h.queue, stateDir: dir })
      try {
        await engine.tick()
        await engine.until(() => h.queue.openCount('alpha') === 0)
        expect(engine.textCalls().map(call => call.params.text)).toEqual(h.queued('alpha').flatMap(item => item.fixed!.parts))
        expect(engine.textCalls()).toHaveLength(1)
        expect(engine.textCalls()[0]!.params.text).toContain('via="thread"')
        expect(engine.textCalls()[0]!.params.text).toContain(event.text as string)
        expect(engine.errors).toEqual([])
      } finally { await engine.cleanup() }
      expect(stub.calls.postMessage).toHaveLength(1)
      expect(h.p('beta').stub.calls.postMessage).toHaveLength(0)
    },
  )

  test.each(['off', 'DM'] as const)('a post in %s joins nothing and the later channel reply is dropped', async target => {
    const h = await ownPostHarness(), t = h.threads!, stub = h.p('alpha').stub
    if (target === 'off') expect(t.choose('off', 'alpha', CA).kind).toBe('applied')
    const channel = target === 'DM' ? makeDm().channel as string : CA
    stub.script.post.push({ kind: 'ok', result: { ts: THREAD_ROOTS.primary } })
    // Strict mode refuses reply tools in off channels; server notices still
    // post to their configured destination and must never establish a join.
    if (target === 'off') await h.notifier.notify('alpha', 'posted outside thread following')
    else await h.reply('alpha', { chat_id: channel, text: 'posted outside thread following' })
    expect(stub.calls.postMessage).toHaveLength(1)
    expect(stub.calls.postMessage[0]!.channel).toBe(channel)
    expect(t.memory.joins('alpha')).toEqual([])
    expect(t.memory.joins('beta')).toEqual([])
    expect(readThreads(dir).filter(r => r.kind === 'post-intent')).toEqual([])
    await h.receive(humanReply(), ['alpha'])
    expect(h.order.filter(x => x === 'ack')).toHaveLength(1)
    expect(h.queued('alpha')).toEqual([])
    expect(h.queued('beta')).toEqual([])
    expect(existsSync(queuePath(dir))).toBe(false)
    if (target === 'DM') expect(h.logs.filter(line => line.includes('not-mentioned'))).toHaveLength(1)
  })

  test('an own bot event made outside CSCB joins nothing; its later human reply drops as not-mentioned', async () => {
    const h = await ownPostHarness(), { botUserId, botId } = h.p('alpha').stub.identity
    await h.receive(makeBotMessage({ channel: CA, ts: THREAD_ROOTS.primary, user: botUserId, bot_id: botId }), ['alpha'])
    expect(h.queued('alpha')).toEqual([])
    expect(h.threads!.memory.joins('alpha')).toEqual([])
    const beforeReply = h.logs.length
    await h.receive(humanReply(), ['alpha'])
    expect(h.logs.slice(beforeReply).filter(line => line.includes('not-mentioned'))).toHaveLength(1)
    expect(h.order.filter(x => x === 'ack')).toHaveLength(2)
    expect(h.queued('alpha')).toEqual([])
    expect(h.queued('beta')).toEqual([])
    expect(existsSync(queuePath(dir))).toBe(false)
    expect(h.allPosts()).toEqual([])
  })
})

describe.each(['strict', 'open'] as const)('%s routing through Thread Memory', mode => {
  async function joinedHarness(options: Parameters<typeof makeRoutingHarness>[2] = {}) {
    const h = makeRoutingHarness([
      { name: 'alpha', channels: [{ id: CA, delivery: 'thread_hybrid' }, { id: CB, delivery: 'thread_hybrid' }] },
      { name: 'beta', channels: [{ id: CA, delivery: 'thread_hybrid' }, { id: CB, delivery: 'thread_hybrid' }], permission_prompts: CA },
    ], dir, { mode, threadMemory: {}, membership: observedMembership({ alpha: [CA, CB], beta: [CA, CB] }), restartDelayS: NEVER_FIRE_RESTART_DELAY_S, ...options })
    harnesses.push(h)
    await h.ready()
    return h
  }
  async function seedJoin(h: RoutingHarness, key = 'alpha', channel = CA) {
    const threads = h.threads!
    expect(await threads.memory.saveJoins(key, [threads.fact({ channel, root: THREAD_ROOTS.primary }, key)])).toEqual({ kind: 'saved' })
    expect(threads.memory.view(key, channel, THREAD_ROOTS.primary)).toBe('joined')
  }
  const reply = (overrides: Parameters<typeof makeChannelMessage>[0] = {}) =>
    makeChannelMessage({ channel: CA, thread_ts: THREAD_ROOTS.primary, ...overrides })

  test('reads a join made after routing construction; thread and mention items keep acceptance, queued feedback, delivered tags and reminder eligibility', async () => {
    const feedback: Promise<void>[] = []
    let queued: ReturnType<typeof createQueuedAckCallback> | undefined
    const h = await joinedHarness({ dedupeClock: () => 0, onReceived: (key, item) => { feedback.push(queued!(key, item)) } })
    queued = createQueuedAckCallback({ queue: h.queue, getReaction: () => h.config!.queued_ack_reaction, clientFor: key => h.p(key).stub.web })
    await seedJoin(h)
    const events = [reply({ text: 'unmentioned joined reply' }), reply({ text: mentionText(h.p('alpha').stub.identity.botUserId) })]
    const atAck: AcceptedRecord[][] = []
    for (const event of events) {
      await h.receive(event, ['alpha'], () => { atAck.push(readQueue(dir).filter((r): r is AcceptedRecord => r.kind === 'accepted' && !('compact' in r))) })
    }
    await Promise.all(feedback)
    expect(atAck.map(records => records.map(r => r.via))).toEqual([['thread'], ['thread', 'mention']])
    expect(facts(h, 'alpha')).toEqual(events.map((event, i) => ({ channel: CA, ts: event.ts as string, text: event.text as string, via: i === 0 ? 'thread' : 'mention' })))
    expect(h.threadMemoryReads).toEqual([['alpha', CA, THREAD_ROOTS.primary]])
    const reaction = h.config!.queued_ack_reaction!
    expect(h.p('alpha').stub.calls.reactionsAdd).toEqual(events.map(event => ({ channel: CA, timestamp: event.ts as string, name: reaction })))
    expect(h.p('beta').stub.calls.reactionsAdd).toEqual([])
    expect(h.p('beta').stub.calls.reactionsRemove).toEqual([])
    expect(h.queued('alpha').map(i => i.accepted.queued_ack_reaction)).toEqual([reaction, reaction])
    expect(h.queued('alpha').every(i => i.fixed!.parts.every(part => part.includes(`via="${i.accepted.via}"`)))).toBe(true)
    expect(h.queued('beta')).toEqual([])
    const engine = await makeEngineHarness({ queue: h.queue, stateDir: dir })
    try {
      await engine.tick()
      await engine.until(() => h.queue.openCount('alpha') === 0)
      expect(engine.textCalls().map(call => call.params.text)).toEqual(h.queued('alpha').flatMap(i => i.fixed!.parts))
      expect(engine.textCalls()[0]!.params.text).toContain('via="thread"')
      expect(h.queue.replyReminderItems('alpha').map(i => i.seq)).toEqual(h.queued('alpha').map(i => i.accepted.seq))
      expect(engine.errors).toEqual([])
    } finally { await engine.cleanup() }
  })

  test('sibling-thread and plain messages drop; joined mentions and Broadcasts keep precedence', async () => {
    const h = await joinedHarness()
    await seedJoin(h)
    const dropped = [reply({ thread_ts: THREAD_ROOTS.secondary }), makeChannelMessage({ channel: CA })]
    for (const event of dropped) await h.receive(event, ['alpha'])
    expect(h.queued('alpha')).toEqual([])
    expect(existsSync(queuePath(dir))).toBe(false)
    expect(h.logs.filter(line => line.includes('not-mentioned'))).toHaveLength(dropped.length)
    expect(h.p('alpha').stub.callLog).toEqual([])
    const events = [reply({ text: mentionText(h.p('alpha').stub.identity.botUserId) }), reply({ text: broadcastText('here') })]
    for (const event of events) await h.receive(event, ['alpha'])
    expect(facts(h, 'alpha')).toEqual(events.map((event, i) => ({ channel: CA, ts: event.ts as string, text: event.text as string, via: i === 0 ? 'mention' : 'broadcast' })))
    expect(facts(h, 'beta')).toEqual([])
    expect(h.threadMemoryReads).toEqual([['alpha', CA, THREAD_ROOTS.secondary]])
    expect(h.order.filter(x => x === 'ack')).toHaveLength(4)
  })

  test.each([false, true])('paired app_mention/message retains the mode rule and one accepted item (mention first=%p)', async mentionFirst => {
    const h = await joinedHarness()
    await seedJoin(h)
    const message = reply({ text: mentionText(h.p('alpha').stub.identity.botUserId) })
    const app = makeAppMention({ ...message, type: 'app_mention' })
    await h.receive(mentionFirst ? app : message, ['alpha'])
    const accepted = { channel: CA, ts: message.ts as string, text: message.text as string, via: 'mention' }
    expect(facts(h, 'alpha')).toEqual(mode === 'open' && mentionFirst ? [] : [accepted])
    expect(facts(h, 'beta')).toEqual([])
    await h.receive(mentionFirst ? message : app, ['alpha'])
    expect(facts(h, 'alpha')).toEqual([accepted])
    expect(facts(h, 'beta')).toEqual([])
    expect(readQueue(dir).filter(r => r.kind === 'accepted')).toHaveLength(1)
    expect(h.order.filter(x => x === 'ack')).toHaveLength(2)
    expect(h.threadMemoryReads).toEqual([])
  })

  test('changing away and back invalidates the old join and routing reads the new stamp', async () => {
    const h = await joinedHarness()
    await seedJoin(h)
    const beforeChange = reply(), afterChange = reply()
    const accepted = { channel: CA, ts: beforeChange.ts as string, text: beforeChange.text as string, via: 'thread' }
    await h.receive(beforeChange, ['alpha'])
    expect(facts(h, 'alpha')).toEqual([accepted])
    expect(facts(h, 'beta')).toEqual([])
    const oldStamp = h.threads!.authority.channelStamp('alpha', CA)
    expect(h.threads!.choose('mentions', 'alpha', CA).kind).toBe('applied')
    expect(h.threads!.choose('thread_hybrid', 'alpha', CA).kind).toBe('applied')
    expect(h.threads!.authority.channelStamp('alpha', CA)).not.toEqual(oldStamp)
    await h.receive(afterChange, ['alpha'])
    expect(facts(h, 'alpha')).toEqual([accepted])
    expect(facts(h, 'beta')).toEqual([])
    expect(h.logs.filter(line => line.includes('not-mentioned'))).toHaveLength(1)
    expect(h.threadMemoryReads).toHaveLength(2)
  })

  test.each(['off', 'mentions', 'all'] as const)('%s keeps selection and acknowledgement without consulting Thread Memory', async choice => {
    const h = await joinedHarness()
    await seedJoin(h)
    expect(h.threads!.choose(choice, 'alpha', CA).kind).toBe('applied')
    const events = [reply(), reply({ text: mentionText(h.p('alpha').stub.identity.botUserId) }), reply({ text: broadcastText('channel') })]
    for (const event of events) await h.receive(event, ['alpha'])
    const accepted = events.map((event, i) => ({ channel: CA, ts: event.ts as string, text: event.text as string, via: ['receive_all', 'mention', 'broadcast'][i] }))
    expect(facts(h, 'alpha')).toEqual(choice === 'off' ? [] : choice === 'mentions' ? accepted.slice(1) : accepted)
    expect(facts(h, 'beta')).toEqual([])
    expect(h.order.filter(x => x === 'ack')).toHaveLength(events.length)
    expect(h.threadMemoryReads).toEqual([])
  })

  test('AC-V03: changing P on A and B preserves Q choices and joins; shared-all reasons count only all personas', async () => {
    const h = await joinedHarness()
    for (const key of ['alpha', 'beta']) for (const channel of [CA, CB]) await seedJoin(h, key, channel)
    // Different choices on A while each persona still has Joined Threads on B.
    expect(h.threads!.choose('all', 'alpha', CA).kind).toBe('applied')
    const betaJoins = h.threads!.memory.joins('beta')
    const betaChoices = [CA, CB].map(channel => h.channelDelivery!.storedChoice('beta', channel))
    for (const channel of [CA, CB]) {
      expect(h.threads!.choose('off', 'alpha', channel).kind).toBe('applied')
      expect([CA, CB].map(c => h.channelDelivery!.storedChoice('beta', c))).toEqual(betaChoices)
      expect(h.threads!.memory.joins('beta')).toEqual(betaJoins)
      await h.receive(reply({ channel }), ['alpha', 'beta'])
    }
    expect(h.queued('alpha')).toEqual([])
    expect(h.queued('beta').map(i => [i.accepted.channel, i.accepted.via])).toEqual([[CA, 'thread'], [CB, 'thread']])
    for (const key of ['alpha', 'beta']) expect(h.threads!.choose('all', key, CA).kind).toBe('applied')
    await h.receive(makeChannelMessage({ channel: CA }))
    expect(h.queued('alpha').at(-1)!.accepted.via).toBe('receive_all_shared')
    expect(h.queued('beta').at(-1)!.accepted.via).toBe('receive_all_shared')
    expect(h.threads!.choose('thread_hybrid', 'beta', CA).kind).toBe('applied')
    for (const text of ['plain', mentionText(h.p('alpha').stub.identity.botUserId), broadcastText('here')]) await h.receive(makeChannelMessage({ channel: CA, text }), ['alpha'])
    expect(h.queued('alpha').map(i => [i.accepted.channel, i.accepted.via])).toEqual([[CA, 'receive_all_shared'], [CA, 'receive_all'], [CA, 'mention'], [CA, 'broadcast']])
    expect(h.queued('beta').map(i => [i.accepted.channel, i.accepted.via])).toEqual([[CA, 'thread'], [CB, 'thread'], [CA, 'receive_all_shared']])
  })

  test('AC-V07: another persona’s Notice Destination never reduces all or joined-thread delivery', async () => {
    const h = await joinedHarness()
    expect(h.p('beta').persona.permission_prompts).toBe(CA)
    expect(h.threads!.choose('all', 'alpha', CA).kind).toBe('applied')
    const beta = h.p('beta').stub.identity
    for (const text of ['Permission requested', 'Server notice']) {
      await h.receive(makeBotMessage({ channel: CA, user: beta.botUserId, bot_id: beta.botId, text }), ['alpha'])
    }
    await h.receive(makeChannelMessage({ channel: CA }), ['alpha'])
    expect(h.queued('alpha').map(i => i.accepted.via)).toEqual(['receive_all', 'receive_all', 'receive_all'])
    expect(h.threads!.choose('thread_hybrid', 'alpha', CA).kind).toBe('applied')
    await seedJoin(h)
    await h.receive(makeBotMessage({ channel: CA, user: beta.botUserId, bot_id: beta.botId, thread_ts: THREAD_ROOTS.primary }), ['alpha'])
    expect(h.queued('alpha').map(i => [i.accepted.channel, i.accepted.via])).toEqual([[CA, 'receive_all'], [CA, 'receive_all'], [CA, 'receive_all'], [CA, 'thread']])
    expect(h.queued('beta')).toEqual([])
    expect(h.order.filter(x => x === 'ack')).toHaveLength(4)
  })
})
test('partial fanout suppresses ack; retry prepares retained accepted-only A and newly stored B after aggregate ack', async () => {
  const queue = await makeQueue(dir); const config = makeMultiPersonaConfig([{ name: 'alpha', channels: [{ id: CS, delivery: 'all' }] }, { name: 'beta', channels: [{ id: CS, delivery: 'all' }] }], dir)
  let failing = true; const order: string[] = []
  const routing = createPersonaRouting({ ...selectionInputs(config, [CA, CB, CS]), getPersonaConfig: () => config, getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }), archive: () => {}, log: () => {}, queue: { lookupSlackKey: queue.lookupSlackKey, acceptDecided: queue.acceptDecided, accept: async (key, input) => { order.push('store:' + key); return key === 'beta' && failing ? { status: 'failed', error: new Error('EIO') } : queue.accept(key, input) } }, onReceived: (key) => { order.push('received:' + key) }, prepare: async (key, item) => { order.push('prepare:' + key); await queue.append(key, { v: 1, kind: 'fixed', seq: item.accepted.seq, parts: ['fixed'] }) } })
  const event = makeChannelMessage({ channel: CS }); await routing.receive(event, () => { order.push('ack') }, ['alpha', 'beta'])
  expect(order).toEqual(['store:alpha', 'store:beta', 'received:alpha']); expect(queue.items('alpha')).toHaveLength(1); expect(queue.items('beta')).toEqual([])
  failing = false; order.length = 0; await routing.receive(event, () => { order.push('ack') }, ['alpha', 'beta'])
  expect(order).toEqual(['store:beta', 'ack', 'received:alpha', 'received:beta', 'prepare:alpha', 'prepare:beta'])
  for (const key of ['alpha', 'beta']) { expect(queue.items(key)).toHaveLength(1); expect(queue.items(key)[0]!.fixed!.parts).toEqual(['fixed']); expect(readQueue(dir, key).filter(r => r.kind === 'accepted' && !('compact' in r))).toHaveLength(1) }; await queue.stop()
})
test('a fresh routing factory acknowledges a preexisting fixed undelivered Slack item without recovery or another received report', async () => {
  const queue = await makeQueue(dir)
  const config = makeMultiPersonaConfig([{ name: 'alpha', channels: [{ id: CA, delivery: 'all' }] }], dir)
  const event = makeChannelMessage({ channel: CA })
  const stored = await queue.accept('alpha', slackInput({ channel: CA, ts: event.ts as string, key: { chat_id: CA, ts: event.ts as string } }))
  if (stored.status === 'failed') throw new Error('store failed')
  await queue.append('alpha', { v: 1, kind: 'fixed', seq: stored.seq, parts: ['preexisting fixed bytes'] })
  const before = readQueue(dir)
  const calls: string[] = []
  // No earlier call has populated this factory's in-memory dedupe map.
  const routing = createPersonaRouting({ ...selectionInputs(config, [CA, CB, CS]), getPersonaConfig: () => config, getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }),
    queue, archive: () => {}, log: () => {}, prepare: async () => { calls.push('prepare') }, onReceived: () => { calls.push('received') },
    isPersonaUp: () => { calls.push('recovery'); return true }, readRowLiveness: async () => { calls.push('read'); return { kind: 'dead', cause: 'ended' } },
  })
  try {
    expect(queue.items('alpha')[0]!.delivered).toBe(false)
    await routing.receive(event, () => { calls.push('ack') }, 'alpha')
    expect(calls).toEqual(['ack'])
    expect(queue.items('alpha')).toHaveLength(1)
    expect(queue.items('alpha')[0]!.fixed!.parts).toEqual(['preexisting fixed bytes'])
    expect(readQueue(dir)).toEqual(before)
  } finally { await queue.stop() }
})
test('ack precedes row read and all lookups; fixed bytes are durable before wake and survive replay/name changes', async () => {
  const queue = await makeQueue(dir); const order: string[] = []; const config = makeMultiPersonaConfig([{ name: 'alpha' }], dir)
  const preparation = createDeliveryPreparation({ queue, clientFor: () => undefined, resolveUserName: async () => { order.push('lookup'); return 'first-name' }, wake: key => { order.push('wake'); expect(readQueue(dir, key).some(r => r.kind === 'fixed')).toBe(true) } })
  const routing = createPersonaRouting({ ...selectionInputs(config, [CA, CB, CS]), getPersonaConfig: () => config, getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }), queue, prepare: preparation.prepare, archive: () => {}, log: () => {}, isPersonaUp: () => true, readRowLiveness: async () => { order.push('row-read'); return { kind: 'dead', cause: 'ended' } } })
  await routing.receive(makeChannelMessage({ channel: config.personas[0]!.channels[0]!.id }), () => { order.push('ack') }, 'alpha')
  expect(order).toEqual(['ack', 'row-read', 'lookup', 'wake']); const bytes = queue.items('alpha')[0]!.fixed!.parts; expect(bytes.join('')).toContain('first-name'); await preparation.stop(); await queue.stop()
  const replay = await makeQueue(dir); const p2 = createDeliveryPreparation({ queue: replay, clientFor: () => undefined, resolveUserName: async () => { throw new Error('fixed must not look up again') } }); await p2.recover(); expect(replay.items('alpha')[0]!.fixed!.parts).toEqual(bytes); await p2.stop(); await replay.stop()
})

test.each(['accepted-only', 'damaged-fixed'] as const)('restart prepares %s work with fresh bounded lookups and exact durable fixed bytes before wake', async state => {
  const clock = createFakeClock({ start: 1700000000000 })
  const accepted = { ...slackInput({ channel: CA, user: 'U0SENDER1', text: 'recover this', via: 'receive_all' }), v: 1, kind: 'accepted', seq: 1, received_at: clock.now(), ts: '1700000000.000001' } as const
  const damaged = '{"v":1,"kind":"fixed","seq":1,"parts":"damaged"}\n'
  seedQueue(dir, state === 'damaged-fixed' ? [accepted, damaged] : [accepted])
  const queue = await makeQueue(dir, { now: clock.now })
  const slack = makeStubSlack({ info: [{ kind: 'never' }] })
  const expected = buildTagParts({ chat_id: CA, channel_name: CA, message_id: accepted.ts, user: 'U0SENDER1', user_id: 'U0SENDER1', ts: accepted.ts, via: 'receive_all', text: accepted.text })
  const lookups: Array<[string, string]> = []; const wakes: string[] = []
  const preparation = createDeliveryPreparation({ queue, clock, clientFor: () => slack.web as unknown as WebClient, resolveUserName: (key, user) => { lookups.push([key, user]); return new Promise(() => {}) }, wake: key => {
    expect(readQueue(dir, key).filter(r => r.kind === 'fixed')).toEqual([{ v: 1, kind: 'fixed', seq: 1, parts: expected }])
    wakes.push(key)
  } })
  try {
    expect(queue.items('alpha')[0]!.fixed).toBeUndefined()
    const recovery = preparation.recover()
    await clock.flush()
    expect(lookups).toEqual([['alpha', 'U0SENDER1']]); expect(wakes).toEqual([])
    expect(slack.calls.conversationsInfo).toEqual([{ channel: CA }])
    expect(clock.pending().map(timer => timer.delayMs)).toEqual([NAME_LOOKUP_TIMEOUT_MS, NAME_LOOKUP_TIMEOUT_MS])
    await clock.advance(NAME_LOOKUP_TIMEOUT_MS - 1); expect(wakes).toEqual([])
    await clock.advance(1); await recovery
    expect(wakes).toEqual(['alpha']); expect(queue.items('alpha')[0]!.fixed!.parts).toEqual(expected); expect(clock.pendingCount()).toBe(0)
    await preparation.recover()
    expect(lookups).toEqual([['alpha', 'U0SENDER1']]); expect(slack.calls.conversationsInfo).toEqual([{ channel: CA }]); expect(readQueue(dir).filter(r => r.kind === 'fixed')).toHaveLength(1)
  } finally { await clock.advance(NAME_LOOKUP_TIMEOUT_MS); await preparation.stop(); await queue.stop() }
})

test('hung independent lookups acknowledge within 3s, use bounded fallbacks and persist fixed bytes before waking', async () => {
  const clock = createFakeClock({ start: 1700000000000 })
  const queue = await makeQueue(dir, { now: clock.now })
  const config = makeMultiPersonaConfig([{ name: 'alpha' }], dir)
  let acknowledgedAt: number | undefined; const wakes: string[] = []
  const preparation = createDeliveryPreparation({ queue, clock, clientFor: () => undefined, resolveUserName: () => new Promise(() => {}), wake: key => { expect(readQueue(dir, key).some(r => r.kind === 'fixed')).toBe(true); wakes.push(key) } })
  const routing = createPersonaRouting({ ...selectionInputs(config, [CA, CB, CS]), getPersonaConfig: () => config, getBotIdentity: () => ({ botUserId: 'U0BOT001', botId: 'B0BOT001' }), queue, prepare: preparation.prepare, archive: () => {}, log: () => {}, isPersonaUp: () => true, now: clock.now })
  try {
    const started = clock.now()
    const handling = routing.receive(makeChannelMessage({ channel: config.personas[0]!.channels[0]!.id, user: 'U0SENDER1' }), () => { acknowledgedAt = clock.now() }, 'alpha')
    await clock.flush(); expect(acknowledgedAt).toBeDefined(); expect(acknowledgedAt! - started).toBeLessThan(3000); expect(wakes).toEqual([])
    expect(clock.pending().map(t => t.delayMs)).toEqual([NAME_LOOKUP_TIMEOUT_MS])
    await clock.advance(NAME_LOOKUP_TIMEOUT_MS - 1); expect(wakes).toEqual([])
    await clock.advance(1); await handling
    expect(wakes).toEqual(['alpha']); expect(queue.items('alpha')[0]!.fixed!.parts.join('')).toContain('U0SENDER1'); expect(clock.pendingCount()).toBe(0)
  } finally { await preparation.stop(); await queue.stop() }
})

test('channel caches are persona scoped, slow preparation leaves unrelated work free and fixed parts stay immutable', async () => {
  const fake = createFakeClock({ start: 1700000000000 })
  const h = makeRoutingHarness([{ name: 'alpha', channels: [{ id: CS, delivery: 'all' }] }, { name: 'beta', channels: [{ id: CS, delivery: 'all' }] }], dir, { membership: observedMembership({ alpha: [CS], beta: [CS] }), preparationClock: fake, stubOptions: { alpha: { info: [{ kind: 'never' }] }, beta: { info: [{ kind: 'ok', result: { channel: { name: 'beta-room' } } }] } } })
  harnesses.push(h)
  try {
    const handling = h.receive(makeChannelMessage({ channel: CS, ts: '1700000000.000001' }))
    await fake.flush()
    expect(h.order.filter(s => s === 'ack')).toEqual(['ack']); expect(h.queued('alpha')[0]!.fixed).toBeUndefined(); expect(h.queued('beta')[0]!.fixed!.parts.join('')).toContain('beta-room')
    await fake.runNext(); await handling
    const fixed = structuredClone(h.queued('alpha')[0]!.fixed)
    expect(fixed!.parts.join('')).toContain(CS)
    await h.receive(makeChannelMessage({ channel: CS, ts: '1700000000.000002' }))
    expect(h.p('alpha').stub.calls.conversationsInfo).toEqual([{ channel: CS }]); expect(h.p('beta').stub.calls.conversationsInfo).toEqual([{ channel: CS }]); expect(h.queued('alpha')[0]!.fixed).toEqual(fixed); expect(h.queued('beta')).toHaveLength(2)
    expect(fake.pendingCount()).toBe(0)
  } finally { expect(fake.pendingCount()).toBe(0) }
})

test('decision failure withholds ack until replay can durably retain both recipients', async () => {
  const clock = createFakeClock({ start: 1700000000000 })
  const queue = await makeQueue(dir, { now: clock.now })
  const config = makeMultiPersonaConfig([{ name: 'alpha', channels: [{ id: CA, delivery: 'all' }] }, { name: 'beta', channels: [{ id: CA, delivery: 'all' }] }], dir)
  let acknowledgments = 0
  let identityAvailable = false
  const routing = createPersonaRouting({ ...selectionInputs(config, [CA]), queue, now: clock.now, prepare: async () => {}, getPersonaConfig: () => config, getBotIdentity: () => { if (!identityAvailable) throw new Error('identity unavailable'); return { botUserId: 'U0BOT001', botId: 'B0BOT001' } }, archive: () => {}, log: () => {} })
  try {
    const keys = ['alpha', 'beta'], text = '  > "quoted"\r\n\t repeated  repeated\n\n  ', ts = '1700000000.000001'
    const event = makeChannelMessage({ channel: CA, user: 'U0SENDER1', ts, text })
    const expected: AcceptedRecord = { v: 1, kind: 'accepted', seq: 1, source: 'slack', channel: CA, channel_type: 'channel',
      key: { chat_id: CA, ts }, ts, user: 'U0SENDER1', text, via: 'receive_all_shared',
      received_at: clock.now(), queued_ack_reaction: config.queued_ack_reaction }
    const atAck: Array<Array<{ persona: string; records: ReturnType<typeof readQueue> }>> = []
    const ack = () => { atAck.push(keys.map(persona => ({ persona, records: readQueue(dir, persona) }))); acknowledgments++ }
    await routing.receive(event, ack, keys)
    expect(acknowledgments).toBe(0); expect(queue.items('alpha')).toEqual([]); expect(queue.items('beta')).toEqual([])
    expect(atAck).toEqual([])
    identityAvailable = true
    await routing.receive(event, ack, keys)
    expect(acknowledgments).toBe(1)
    const durable = keys.map(persona => ({ persona, records: [expected] }))
    expect(atAck).toEqual([durable])
    for (const key of keys) expect(queue.items(key).map(item => item.accepted)).toEqual([expected])
    const retained = keys.map(key => ({ items: structuredClone(queue.items(key)), bytes: readFileSync(queuePath(dir, key), 'utf8') }))
    await clock.advance(1)
    await routing.receive(event, ack, keys)
    expect(acknowledgments).toBe(2)
    expect(atAck).toEqual([durable, durable])
    expect(keys.map(key => ({ items: queue.items(key), bytes: readFileSync(queuePath(dir, key), 'utf8') }))).toEqual(retained)
  } finally { await queue.stop() }
})


test.each(['quick', 'late'] as const)('%s lookup completion clears its injected timer and cannot mutate fixed fallback bytes', async completion => {
  const clock = createFakeClock()
  const queue = await makeQueue(dir, { now: clock.now })
  let resolve!: (name: string) => void
  const lookup = new Promise<string>(done => { resolve = done })
  const wakes: string[] = []
  const preparation = createDeliveryPreparation({ queue, clock, clientFor: () => undefined, resolveUserName: () => lookup, wake(key) {
    expect(readQueue(dir, key).filter(r => r.kind === 'fixed')).toHaveLength(1)
    wakes.push(key)
  } })
  try {
    const result = await queue.accept('alpha', { source: 'slack', text: 'hello', channel: 'D0TEST001', channel_type: 'im', user: 'U0SENDER1', key: { chat_id: 'D0TEST001', ts: '1700000000.000001' }, ts: '1700000000.000001', via: 'dm' })
    if (result.status !== 'accepted') throw new Error('fixture acceptance failed')
    const work = preparation.prepare('alpha', result.item!)
    await clock.flush()
    expect(clock.pending().map(t => t.delayMs)).toEqual([NAME_LOOKUP_TIMEOUT_MS])
    if (completion === 'quick') resolve('resolved-name')
    else await clock.advance(NAME_LOOKUP_TIMEOUT_MS)
    await work
    const fixed = queue.items('alpha')[0]!.fixed!.parts
    expect(fixed.join('')).toContain(completion === 'quick' ? 'resolved-name' : 'U0SENDER1')
    expect(wakes).toEqual(['alpha']); expect(clock.pendingCount()).toBe(0)
    resolve('late-name')
    await clock.flush(); await clock.advance(NAME_LOOKUP_TIMEOUT_MS)
    expect(queue.items('alpha')[0]!.fixed!.parts).toEqual(fixed)
    expect(readQueue(dir).filter(r => r.kind === 'fixed')).toHaveLength(1)
    expect(wakes).toEqual(['alpha']); expect(clock.pendingCount()).toBe(0)
  } finally { await preparation.stop(); await queue.stop() }
})

describe.each(['strict', 'open'] as const)('%s own-message hook', mode => {
  const OWN_TS = '1700000100.000100', NEXT_TS = '1700000101.000100', DM = makeDm().channel as string
  // Fixed identities, so runs in separate harnesses log and store the same bytes.
  const IDS = { alpha: { botUserId: 'U0ALPHAOWN', botId: 'B0ALPHAOWN' }, beta: { botUserId: 'U0BETAOWN1', botId: 'B0BETAOWN1' } }
  // Far more turns than intake takes to its ack; a wait that never ends stays under it.
  const ACK_TURN_LIMIT = 200
  const TARGETS = ['thread_hybrid', 'off', 'mentions', 'all', 'DM'] as const
  type Target = typeof TARGETS[number]
  type Hook = NonNullable<Parameters<typeof makeRoutingHarness>[2]>['onOwnMessage']
  /** `recording` records only; the others record, then throw, return a pending promise or schedule a microtask. `absent` passes no hook. */
  type Variant = 'recording' | 'absent' | 'throwing' | 'pending' | 'scheduling'
  interface HookCall { key: string; event: Record<string, unknown>; identity: unknown }

  async function hooked(variant: Variant, target: Target, options: { rerun?: boolean } = {}) {
    const calls: HookCall[] = [], paths: string[] = []
    let h!: RoutingHarness
    const record: NonNullable<Hook> = (key, event, identity) => { calls.push({ key, event, identity }); h.order.push(`hook:${key}`) }
    const hook: Hook = variant === 'absent' ? undefined
      : variant === 'throwing' ? (key, event, identity) => { record(key, event, identity); throw new Error(sentinelInMessage('own-hook')) }
      : variant === 'pending' ? (key, event, identity) => { record(key, event, identity); return new Promise<void>(() => {}) }
      : variant === 'scheduling' ? (key, event, identity) => { record(key, event, identity); queueMicrotask(() => { h.order.push(`scheduled:${key}`) }) }
      : record
    const channels = [{ id: CA, delivery: target === 'DM' ? 'all' as const : target }]
    h = makeRoutingHarness(['alpha', 'beta'].map(name => ({ name, channels, dm: { enabled: true } })), mkdtempSync(join(dir, 'own-')), {
      mode, threadMemory: {}, membership: observedMembership({ alpha: [CA], beta: [CA] }), restartDelayS: NEVER_FIRE_RESTART_DELAY_S,
      stubOptions: IDS, onOwnMessage: hook,
    })
    harnesses.push(h)
    await h.ready()
    const decided = h.queue.acceptDecided, plain = h.queue.accept, lookup = h.queue.lookupSlackKey
    h.queue.acceptDecided = (key, slackKey, decide) => {
      paths.push(`serial:${key}`)
      return decided(key, slackKey, facts => {
        paths.push(`decide:${key}`)
        // Re-select in the same turn, as a re-run of the callback would.
        if (options.rerun) { decide(facts); paths.push(`decide:${key}`) }
        return decide(facts)
      })
    }
    h.queue.accept = (key, input) => { paths.push(`plain:${key}`); return plain(key, input) }
    h.queue.lookupSlackKey = (key, slackKey) => { paths.push(`lookup:${key}`); return lookup(key, slackKey) }
    h.order.length = 0
    return { h, calls, paths }
  }
  const at = (target: Target) => target === 'DM' ? { channel: DM, channel_type: 'im' } : { channel: CA }
  const share = (h: RoutingHarness, target: Target, name = 'alpha', options: Partial<OwnFileShareOptions> = {}) =>
    makeOwnFileShare({ identity: h.p(name).stub.identity, ts: OWN_TS, ...options }, at(target))
  const next = (h: RoutingHarness, target: Target) => target === 'DM' ? makeDm({ ts: NEXT_TS })
    : makeChannelMessage({ channel: CA, ts: NEXT_TS, text: `${mentionText(h.p('alpha').stub.identity.botUserId)} after the share` })
  /** Receive `event`, counting microtask turns from the call to its ack, and the Slack calls made by then. */
  async function counted(h: RoutingHarness, event: unknown, names: readonly string[] = ['alpha']) {
    let turns = 0, ackTurn: number | undefined, slackCallsAtAck: number | undefined
    const work = h.receive(event, names, () => {
      ackTurn = turns
      slackCallsAtAck = h.all.reduce((n, x) => n + x.stub.callLog.length, 0)
      h.order.push('ack')
    })
    while (ackTurn === undefined && turns < ACK_TURN_LIMIT) { await Promise.resolve(); turns++ }
    expect(ackTurn).toBeDefined()
    await work
    return { ackTurn, slackCallsAtAck }
  }
  const ownLines = (h: RoutingHarness) => h.logs.filter(line => line.endsWith(': own'))
  const pathOf = (target: Target, key = 'alpha') => target === 'thread_hybrid' ? [`serial:${key}`, `decide:${key}`] : [`lookup:${key}`]

  describe.each([...TARGETS])('%s', target => {
    test.each(['user', 'bot', 'both'] as const)("P's own share by %s ID calls the hook once with P's key, the event and P's identity, before the decision", async author => {
      const { h, calls, paths } = await hooked('recording', target), event = share(h, target, 'alpha', { author })
      await h.receive(event, ['alpha'])
      expect(calls).toEqual([{ key: 'alpha', event, identity: h.p('alpha').stub.identity }])
      // After the archive and the identity read; before the decision reads the config.
      expect(h.order.slice(0, 4)).toEqual(['archive:alpha', 'identity:alpha', 'hook:alpha', 'config'])
      expect(h.order.filter(x => x === 'hook:alpha' || x === 'ack')).toEqual(['hook:alpha', 'ack'])
      expect(paths).toEqual(pathOf(target))
      expect(ownLines(h)).toHaveLength(1)
      expect(h.queued('alpha')).toEqual([]); expect(h.queued('beta')).toEqual([])
    })

    test("another persona's share, a human's message and other authors' shares call no hook for P", async () => {
      const { h, calls } = await hooked('recording', target)
      const human = target === 'DM' ? makeDm({ ts: NEXT_TS }) : makeChannelMessage({ channel: CA, ts: NEXT_TS })
      const others = [share(h, target, 'beta'), human, share(h, target, 'alpha', { shape: 'other-bot' }), share(h, target, 'alpha', { shape: 'other-user' }),
        makeBotMessage({ ...at(target), ts: OWN_TS })]
      for (const event of others) await h.receive(event, ['alpha'])
      expect(calls).toEqual([])
      expect(ownLines(h)).toEqual([])
    })

    test("with a connection's provenance, the hook matches the decision's identity, not getBotIdentity's", async () => {
      const { h, calls } = await hooked('recording', target), key = h.keys(['alpha'])[0]!
      const connected = { botUserId: 'U0ALPHACONN', botId: 'B0ALPHACONN' }
      expect(connected).not.toEqual(h.p('alpha').stub.identity)
      const provenance: PersonaEventProvenance = { key, connectionId: 'alpha-connection', incarnation: undefined, identity: connected,
        applied: true, candidate: false, isCurrent: () => true }
      const byConnection = makeOwnFileShare({ identity: connected, ts: OWN_TS }, at(target))
      await h.receive(byConnection, ['alpha'], undefined, undefined, provenance)
      expect(calls).toEqual([{ key: 'alpha', event: byConnection, identity: connected }])
      expect(ownLines(h)).toHaveLength(1)
      await h.receive(share(h, target, 'alpha', { ts: NEXT_TS }), ['alpha'], undefined, undefined, provenance)
      expect(calls).toHaveLength(1)
      expect(ownLines(h)).toHaveLength(1)
    })

    test.each(['absent', 'throwing', 'pending', 'scheduling'] as const)('with the hook %s, the own drop, ack, archive, lines and the next event are as with a recording hook, with no wait or Slack call before the ack', async variant => {
      async function run(v: Variant) {
        // Each run registers its own sessions; the earlier run's are done with.
        resetRoutingState()
        const { h, calls, paths } = await hooked(v, target)
        const own = await counted(h, share(h, target))
        const after = await counted(h, next(h, target))
        await h.settleJoinSaves()
        return {
          calls: calls.map(c => c.key), own, after, paths,
          order: h.order.filter(x => !x.startsWith('hook:') && !x.startsWith('scheduled:')),
          logs: h.logs, alpha: facts(h, 'alpha'), beta: facts(h, 'beta'),
        }
      }
      const recording = await run('recording'), other = await run(variant)
      expect(other).toEqual({ ...recording, calls: variant === 'absent' ? [] : ['alpha'] })
      expect(recording.calls).toEqual(['alpha'])
      expect(recording.own.slackCallsAtAck).toBe(0)
      expect(recording.order.filter(x => x === 'ack')).toEqual(['ack', 'ack'])
      expect(recording.order.filter(x => x.startsWith('archive:'))).toEqual(['archive:alpha', 'archive:alpha'])
      expect(recording.logs.filter(line => line.endsWith(': own'))).toEqual([expect.stringContaining(`channel=${at(target).channel} `)])
      expect(recording.paths).toEqual([...pathOf(target), ...pathOf(target), ...(target === 'thread_hybrid' || target === 'off' ? [] : ['plain:alpha'])])
      // The own share queues nothing; the next event is handled as its target handles it.
      expect(recording.alpha.map(f => f.ts)).toEqual(target === 'off' ? [] : [NEXT_TS])
      expect(recording.beta).toEqual([])
    })
  })

  test('re-running the serial decision callback calls the hook no more', async () => {
    const { h, calls, paths } = await hooked('recording', 'thread_hybrid', { rerun: true }), event = share(h, 'thread_hybrid')
    await h.receive(event, ['alpha'])
    expect(paths).toEqual(['serial:alpha', 'decide:alpha', 'decide:alpha'])
    expect(calls).toEqual([{ key: 'alpha', event, identity: h.p('alpha').stub.identity }])
    expect(ownLines(h)).toHaveLength(1)
    expect(h.order.filter(x => x === 'ack')).toEqual(['ack'])
  })

  test.each(['thread_hybrid', 'off', 'mentions', 'all'] as const)('%s: with two recipients, each own share reaches only its author, with its own identity', async target => {
    const { h, calls } = await hooked('recording', target)
    const alphaShare = share(h, target, 'alpha'), betaShare = share(h, target, 'beta', { ts: NEXT_TS })
    await h.receive(alphaShare, ['alpha', 'beta'])
    expect(calls).toEqual([{ key: 'alpha', event: alphaShare, identity: h.p('alpha').stub.identity }])
    await h.receive(betaShare, ['alpha', 'beta'])
    expect(calls.slice(1)).toEqual([{ key: 'beta', event: betaShare, identity: h.p('beta').stub.identity }])
    expect(h.order.filter(x => x === 'ack')).toEqual(['ack', 'ack'])
  })
})

describe.each(['strict', 'open'] as const)('%s Post Hold routing through real own posts', mode => {
  const A = THREAD_CHANNELS.primary, B = THREAD_CHANNELS.secondary, R = THREAD_ROOTS.primary
  const humanReply = (overrides: Partial<SlackEvent> = {}) => makeChannelMessage({ channel: A, thread_ts: R, text: 'a reply before Slack answers', ...overrides })
  const acks = (h: RoutingHarness) => h.order.filter(x => x === 'ack')
  /** CS is listed `thread_hybrid` but neither persona is a member there: an ineligible channel. */
  const postHarness = (options: Parameters<typeof holdRoutingHarness>[1] = {}) =>
    holdRoutingHarness(mode, { channels: [{ id: CS, delivery: 'thread_hybrid' }], ...options })

  /** `name`'s real reply tool call whose `chat.postMessage` Slack holds unanswered. Settle it before the case ends. */
  async function heldPost(h: RoutingHarness, args: Record<string, unknown> = {}, name = 'alpha') {
    const stub = h.p(name).stub, answer = makeDeferredWebApiCall(), posted = stub.calls.postMessage.length
    stub.script.post.push(answer.outcome)
    const from = Date.now()
    const call = h.reply(name, { chat_id: A, text: 'posted before Slack answers', ...args })
    for (let turn = 0; turn < 100 && stub.calls.postMessage.length === posted; turn++) await h.threads!.clock.flush()
    expect(stub.calls.postMessage).toHaveLength(posted + 1)
    const to = Date.now()
    const operations = existsSync(threadPath(dir, name)) ? readThreads(dir, name).flatMap(r => r.kind === 'post-intent' ? [r.operationId] : []) : []
    const thread = typeof args['thread_ts'] === 'string' ? args['thread_ts'] : undefined
    return { answer, from, to, operation: operations.at(-1),
      async settle() {
        if (!answer.settled) answer.settle({ kind: 'ok', result: { ts: slackTsOfMs(to), ...(thread ? { message: { thread_ts: thread } } : {}) } })
        await call
      } }
  }

  test("a reply in P's thread before Slack answers P's post there is held for that post and acknowledged while the answer waits", async () => {
    const { h, t, received, settleFeedback } = await postHarness({ sessions: [] })
    const post = await heldPost(h, { thread_ts: R })
    try {
      expect(post.operation).toBeDefined()
      const stamp = t.fact({ channel: A }).stamp, before = t.memory.clock('alpha'), calls = h.p('alpha').stub.callLog.length
      const event = humanReply(), atAck: unknown[] = []
      await h.receive(event, ['alpha'], () => {
        atAck.push({ answered: post.answer.settled, records: readQueue(dir).filter(r => r.kind === 'accepted') })
        h.order.push('ack')
      })
      await settleFeedback()
      // The arrival is P's next per-persona clock reading after `before` (SR-2.1.6).
      const item = h.queued('alpha')[0]!, hold = postHold(before + 1, { operations: [post.operation!], thread_ts: R, stamp, root_unknown: false })
      expect(atAck).toEqual([{ answered: false, records: [expect.objectContaining({ kind: 'accepted', via: 'thread', hold,
        key: { chat_id: A, ts: event.ts }, text: event.text, thread_ts: R, queued_ack_reaction: h.config!.queued_ack_reaction })] }])
      expect(item.accepted.thread_join).toBeUndefined()
      expect(item.hold).toEqual({ field: hold, kind: 'post', state: 'unresolved' })
      expect(h.queue.openCount('alpha')).toBe(0)
      expect(h.queued('beta')).toEqual([])
      // GE-1: the reply's one intake read of P's in-memory posts follows the view lookup.
      expect(h.threadMemoryReads).toEqual([['alpha', A, R]])
      expect(h.pendingOwnPostReads).toEqual([['alpha', A]])
      expect(h.holdStored).toEqual(['alpha'])
      expect(h.order.indexOf('hold-stored:alpha')).toBeGreaterThan(h.order.indexOf('ack'))
      quiet(h, received, calls)
      const next = humanReply({ text: 'a second reply before Slack answers' })
      await h.receive(next, ['alpha']); await settleFeedback()
      const second = postHold(before + 2, { operations: [post.operation!], thread_ts: R, stamp })
      expect(h.queued('alpha')[1]!.accepted.hold).toEqual(second)
      expect(acks(h)).toHaveLength(2)
      quiet(h, received, calls)

      // SR-4.2.2, t1.tad.5i SR-6.2: P's later DM and other-channel message are accepted,
      // acknowledged, received, given queued feedback and prepared behind the unresolved hold.
      const later = [{ via: 'dm', event: makeDm() }, { via: 'receive_all_shared', event: makeChannelMessage({ channel: B }) }]
      for (const { event } of later) await h.receive(event, ['alpha'])
      await settleFeedback()
      expect(acks(h)).toHaveLength(2 + later.length)
      const behind = h.queued('alpha').slice(2)
      expect(behind.map(i => ({ ts: i.accepted.ts, via: i.accepted.via, hold: i.accepted.hold }))).toEqual(later.map(({ via, event }) => ({ ts: event.ts as string, via, hold: undefined })))
      expect(received).toEqual(behind.map(i => ({ key: 'alpha', seq: i.accepted.seq, mode: 'live' })))
      expect(h.p('alpha').stub.calls.reactionsAdd).toEqual(behind.map(i => ({ channel: i.accepted.channel!, timestamp: i.accepted.ts!, name: i.accepted.queued_ack_reaction! })))
      expect(h.preparationCalls.filter(call => call.key === 'alpha')).toEqual(behind.map(i => ({ key: 'alpha', seq: i.accepted.seq })))
      for (const i of behind) expect(i.fixed).toBeDefined()
      expect(h.queued('alpha').slice(0, 2).map(i => i.hold)).toEqual([hold, second].map(field => ({ field, kind: 'post', state: 'unresolved' })))
      expect(h.queue.unresolvedHolds('alpha').map(entry => entry.seq)).toEqual([item.accepted.seq, h.queued('alpha')[1]!.accepted.seq])
      // Neither later item reads P's Pending Own Posts, and the sibling's stub gets no call.
      expect(h.pendingOwnPostReads).toEqual([['alpha', A], ['alpha', A]])
      expect(h.p('beta').stub.callLog).toEqual([])
    } finally { await post.settle() }
    expect(t.memory.view('alpha', A, R)).toBe('joined')
  })

  test.each([
    ["P's bot user", 'own', true], ['absent', undefined, true], ['empty', '', true], ['another user', 'U0SOMEONE', false],
  ] as const)("P's pending top-level post holds a reply in a thread newer than its issue time less the skew, parent_user_id %s (%p): held=%p", async (_label, parent, held) => {
    const { h, t } = await postHarness()
    const post = await heldPost(h)
    try {
      const parent_user_id = parent === 'own' ? h.p('alpha').stub.identity.botUserId : parent
      const newer = slackTsOfMs(post.to - OWN_ROOT_CLOCK_SKEW_MS), older = slackTsOfMs(post.from - OWN_ROOT_CLOCK_SKEW_MS - 1)
      const stamp = t.fact({ channel: A }).stamp
      for (const [root, offset] of [[newer, 1], [older, 2]] as const) {
        await h.receive(humanReply({ thread_ts: root, ts: slackTsOfMs(post.to + offset), parent_user_id }), ['alpha'])
      }
      expect(acks(h)).toHaveLength(2)
      const holds = h.queued('alpha').map(item => item.accepted.hold)
      expect(holds).toEqual(held ? [postHold(holds[0]?.arrived_at ?? 0, { operations: [post.operation!], thread_ts: newer, stamp })] : [])
      expect(h.pendingOwnPostReads).toEqual([['alpha', A], ['alpha', A]])
    } finally { await post.settle() }
  })

  test('with P\'s view unknown, a covering post stores a Post Hold with root_unknown', async () => {
    const { h, t, received } = await postHarness({ unreadable: true })
    expect(t.memory.view('alpha', A, R)).toBe('unknown')
    const post = await heldPost(h, { thread_ts: R })
    try {
      const stamp = t.fact({ channel: A }).stamp, calls = h.p('alpha').stub.callLog.length
      await h.receive(humanReply(), ['alpha'])
      const hold = h.queued('alpha')[0]!.accepted.hold!
      // Kept in memory only: the unreadable journal holds no post-intent to name it by.
      expect(hold).toEqual(postHold(hold.arrived_at, { operations: [expect.any(String)], thread_ts: R, stamp, root_unknown: true }))
      expect(h.queued('alpha')[0]!.hold).toMatchObject({ kind: 'post', state: 'unresolved' })
      expect(acks(h)).toHaveLength(1)
      quiet(h, received, calls)
    } finally { await post.settle() }
  })

  test("a post-intent read back from the journal covers nothing while P's journal is unread, then covers once it is read", async () => {
    const shared = mkdtempSync(join(dir, 'authority-'))
    const first = await postHarness({ channelDelivery: { stateDir: shared } })
    const post = await heldPost(first.h, { thread_ts: R })
    // Stopped before Slack answers, as at a crash: the intent stays unresolved on disk.
    await first.t.crash(); await post.settle(); await first.h.queue.stop()
    expect(readThreads(dir).flatMap(r => r.kind === 'post-intent' ? [r.operationId] : [])).toEqual([post.operation!])
    const { h, t, io } = await postHarness({ unreadable: true, channelDelivery: { stateDir: shared } })
    const stamp = t.fact({ channel: A }).stamp
    await h.receive(humanReply({ ts: '1700000000.000101' }), ['alpha'])
    expect(h.queued('alpha').map(item => item.accepted.hold?.on)).toEqual(['memory'])
    io.heal()
    await t.memory.retryRead('alpha')
    expect(t.memory.view('alpha', A, R)).toBe('not-joined')
    await h.receive(humanReply({ ts: '1700000000.000102' }), ['alpha'])
    const hold = h.queued('alpha')[1]!.accepted.hold!
    expect(hold).toEqual(postHold(hold.arrived_at, { operations: [post.operation!], thread_ts: R, stamp, root_unknown: false }))
    expect(h.pendingOwnPostReads).toEqual([['alpha', A], ['alpha', A]])
    expect(acks(h)).toHaveLength(2)
  })

  test('a post whose stamp went stale through the authority\'s publication covers nothing', async () => {
    const { h, t } = await postHarness()
    const post = await heldPost(h, { thread_ts: R })
    try {
      expect(t.choose('mentions', 'alpha', A).kind).toBe('applied')
      expect(t.choose('thread_hybrid', 'alpha', A).kind).toBe('applied')
      await h.receive(humanReply(), ['alpha'])
      expect(acks(h)).toHaveLength(1)
      expect(h.queued('alpha')).toEqual([])
      expect(h.pendingOwnPostReads).toEqual([['alpha', A]])
    } finally { await post.settle() }
  })

  test('mentions, Broadcasts, joined replies, DMs and other channels and choices are never held and never read Pending Own Posts', async () => {
    const { h, t } = await postHarness()
    const botUserId = h.p('alpha').stub.identity.botUserId, joinedRoot = slackTsOfMs(Date.now())
    await h.receive(makeChannelMessage({ channel: A, ts: joinedRoot, text: mentionText(botUserId) }), ['alpha'])
    expect(t.memory.view('alpha', A, joinedRoot)).toBe('joined')
    // One post covers R by root; a top-level one covers joinedRoot by issue time.
    const inThread = await heldPost(h, { thread_ts: R }), topLevel = await heldPost(h)
    try {
      const events = [
        { via: 'mention', event: humanReply({ text: mentionText(botUserId) }) },
        { via: 'broadcast', event: humanReply({ text: broadcastText('here') }) },
        { via: 'thread', event: humanReply({ thread_ts: joinedRoot, ts: slackTsOfMs(topLevel.to + 1) }) },
        { via: 'dm', event: makeDm({ thread_ts: R }) },
        { via: 'receive_all_shared', event: makeChannelMessage({ channel: B, thread_ts: R }) },
      ]
      for (const { event } of events) await h.receive(event, ['alpha'])
      // Ineligible: P lists CS as thread_hybrid but is not a member there.
      await h.receive(humanReply({ channel: CS }), ['alpha'])
      for (const choice of ['off', 'mentions', 'all'] as const) {
        expect(t.choose(choice, 'alpha', A).kind).toBe('applied')
        await h.receive(humanReply({ text: `under ${choice}` }), ['alpha'])
      }
      expect(h.queued('alpha').map(item => [item.accepted.ts, item.accepted.via, item.accepted.hold])).toEqual([
        [joinedRoot, 'mention', undefined], ...events.map(({ via, event }) => [event.ts, via, undefined]),
        [expect.any(String), 'receive_all', undefined],
      ])
      // The join, the events, the ineligible reply and one reply per choice.
      expect(acks(h)).toHaveLength(1 + events.length + 1 + 3)
      expect(h.pendingOwnPostReads).toEqual([])
    } finally { await inThread.settle(); await topLevel.settle() }
  })

  test('an undecided stamp withholds the ack and stores nothing; the decided retry stores one hold', async () => {
    let unsynced = false
    const authority = makeSharedAuthority(dir, { ...threadConfig(dir, 'thread_hybrid', ['alpha', 'beta'], [A, B]), channel_mode: mode }, {
      write(path, bytes) {
        durableWriteFileSync(path, bytes)
        if (unsynced) throw new DurableWriteUnsyncedError(path, new Error('fixture directory sync refused'))
      },
    })
    const { h, t, received } = await postHarness({ channelDelivery: { stateDir: dir, authority } })
    const post = await heldPost(h, { thread_ts: R })
    try {
      const stamp = t.fact({ channel: A }).stamp, calls = h.p('alpha').stub.callLog.length, event = humanReply()
      unsynced = true
      expect(t.choose('thread_hybrid', 'alpha', A).kind).toBe('unresolved')
      expect(authority.channelStamp('alpha', A)).toEqual({ kind: 'undecided' })
      await h.receive(event, ['alpha']); await h.receive(event, ['alpha'])
      expect(acks(h)).toEqual([])
      expect(h.queued('alpha')).toEqual([])
      expect(h.holdStored).toEqual([])
      unsynced = false
      expect(authority.recoverDurability().kind).toBe('applied')
      await h.receive(event, ['alpha']); await h.receive(event, ['alpha'])
      expect(acks(h)).toHaveLength(2)
      expect(h.queued('alpha')).toHaveLength(1)
      const hold = h.queued('alpha')[0]!.accepted.hold!
      expect(hold).toEqual(postHold(hold.arrived_at, { operations: [post.operation!], thread_ts: R, stamp }))
      // The retried duplicate may wake the resolver again; it stores nothing.
      expect(new Set(h.holdStored)).toEqual(new Set(['alpha']))
      quiet(h, received, calls)
    } finally { await post.settle() }
  })

  test('with no joins dependency a covered reply is never stored or acknowledged', async () => {
    const { h, received } = await postHarness({ threadMemory: { joins: false } })
    const post = await heldPost(h, { thread_ts: R })
    try {
      const calls = h.p('alpha').stub.callLog.length
      await h.receive(humanReply(), ['alpha'])
      expect(h.pendingOwnPostReads).toEqual([['alpha', A]])
      expect(acks(h)).toEqual([])
      expect(h.queued('alpha')).toEqual([])
      expect(h.holdStored).toEqual([])
      quiet(h, received, calls)
    } finally { await post.settle() }
  })

  test('a repeated Event for a Post Hold stores nothing more and gets no queued feedback or preparation', async () => {
    const { h, received, settleFeedback } = await postHarness()
    const post = await heldPost(h, { thread_ts: R })
    try {
      const calls = h.p('alpha').stub.callLog.length, event = humanReply()
      await h.receive(event, ['alpha'])
      const before = readQueue(dir)
      await h.receive(event, ['alpha']); await settleFeedback()
      expect(acks(h)).toHaveLength(2)
      expect(readQueue(dir)).toEqual(before)
      expect(h.queued('alpha')).toHaveLength(1)
      quiet(h, received, calls)
    } finally { await post.settle() }
  })

  test.each([['healthy', false], ['initially failing', true]] as const)('P held and Q accepted share one aggregate ack with a %s Q store', async (_label, failQ) => {
    const { h, t, received, queueIo, settleFeedback } = await postHarness()
    expect(t.choose('all', 'beta', A).kind).toBe('applied')
    const post = await heldPost(h, { thread_ts: R })
    try {
      const calls = h.p('alpha').stub.callLog.length, event = humanReply(), atAck: unknown[] = []
      if (failQ) queueIo.fail('writeSync', 'beta', { match: path => path === queuePath(dir, 'beta') })
      const ack = () => {
        atAck.push(['alpha', 'beta'].map(key => readQueue(dir, key).filter((r): r is AcceptedRecord => r.kind === 'accepted' && !('compact' in r)).map(record => [record.via, record.hold?.on])))
        h.order.push('ack')
      }
      await h.receive(event, ['alpha', 'beta'], ack)
      if (failQ) {
        expect(atAck).toEqual([])
        expect(h.queued('alpha')).toHaveLength(1); expect(h.queued('beta')).toEqual([])
        expect(h.holdStored).toEqual([])
        queueIo.heal(); await h.receive(event, ['alpha', 'beta'], ack)
      }
      await settleFeedback()
      expect(atAck).toEqual([[[['thread', 'post']], [['receive_all', undefined]]]])
      expect(h.queued('alpha')).toHaveLength(1)
      expect(h.holdStored).toEqual(['alpha'])
      expect(h.order.indexOf('hold-stored:alpha')).toBeGreaterThan(h.order.indexOf('ack'))
      expect(received).toEqual([{ key: 'beta', seq: h.queued('beta')[0]!.accepted.seq, mode: 'live' }])
      expect(h.p('beta').stub.calls.reactionsAdd).toHaveLength(1)
      quiet(h, [], calls, [{ key: 'beta', seq: h.queued('beta')[0]!.accepted.seq }])
    } finally { await post.settle() }
  })

  test("P's held reply and pending resolver never delay Q's intake", async () => {
    let release!: () => void
    const pending = new Promise<void>(done => { release = done })
    const { h, t, received } = await postHarness({ threadMemory: { onHoldStored: () => pending } })
    const post = await heldPost(h, { thread_ts: R })
    let pFinished = false, qFinished = false
    const p = h.receive(humanReply(), ['alpha']).then(() => { pFinished = true })
    const q = h.receive(makeChannelMessage({ channel: B }), ['beta']).then(() => { qFinished = true })
    try {
      await t.clock.flush()
      expect(qFinished).toBe(true)
      expect(pFinished).toBe(true)
      expect(h.queued('beta')[0]!.fixed).toBeDefined()
      expect(acks(h)).toHaveLength(2)
      expect(received.map(r => r.key)).toEqual(['beta'])
      expect(h.queued('alpha')[0]!.hold).toMatchObject({ kind: 'post', state: 'unresolved' })
    } finally { release(); await Promise.all([p, q]); await post.settle() }
  })

  test("another persona's pending post never covers P's reply", async () => {
    const { h, t } = await postHarness()
    const post = await heldPost(h, { thread_ts: R }, 'beta')
    try {
      await h.receive(humanReply(), ['alpha', 'beta'])
      expect(acks(h)).toHaveLength(1)
      expect(h.queued('alpha')).toEqual([])
      const hold = h.queued('beta')[0]!.accepted.hold!
      expect(hold).toEqual(postHold(hold.arrived_at, { operations: [post.operation!], thread_ts: R, stamp: t.fact({ channel: A }, 'beta').stamp }))
      expect([...h.pendingOwnPostReads].sort()).toEqual([['alpha', A], ['beta', A]])
    } finally { await post.settle() }
  })
})
