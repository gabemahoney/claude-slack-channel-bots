import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { GetResult } from 'agent-director'
import { createDeliveryQueue, REPLY_REMINDER_KEEP_MS, type AcceptedInput, type ReplyReminderQueue, type QueueItem } from '../src/delivery-queue.ts'
import { createReplyReminders, REPLY_REMINDER_TEXT, REPLY_REMINDER_POLL_MS, REPLY_TOOL_PREALLOWED_LABEL, type ReplyReminders } from '../src/reply-reminder.ts'
import { cannedGetResult } from './test-helpers/agent-director-stub.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { durableIo, failFileSyncs, type DurableIo } from './test-helpers/durable-io.ts'
import { createDeliveryPreparation } from '../src/delivery-intake.ts'
import { reactionInput, deliveredRecord, fixedRecord, heldSlackInput, memoryHold, postHold, injectedInput, readQueue, seedQueue, sentRecord, slackInput } from './test-helpers/delivery-queue.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { THREAD_ROOTS, THREAD_STAMP } from './test-helpers/thread-memory.ts'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { appendTranscript, promptEntry } from './test-helpers/working-row-panes.ts'

const THREAD_ROOT = THREAD_ROOTS.primary
let dir: string
let queues: ReplyReminderQueue[]
let monitors: ReplyReminders[]
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'reply-reminder-')); queues = []; monitors = [] })
afterEach(async () => {
  await Promise.all(monitors.map(m => m.stop()))
  await Promise.all(queues.map(q => q.stop()))
  fs.rmSync(dir, { recursive: true, force: true })
})
/** Each opened queue's disk steps, so a fake clock driving it can wait for them. */
const queueIo = new WeakMap<ReplyReminderQueue, DurableIo>()
async function open(options: Omit<Parameters<typeof createDeliveryQueue>[0], 'stateDir'> = {}) {
  const io = durableIo({ base: options.fs })
  const q = createDeliveryQueue({ stateDir: dir, now: () => 1000, ...options, fs: io.fs }); queueIo.set(q, io); queues.push(q); await q.start(); return q
}
function settledClock(queue: ReplyReminderQueue) {
  const clock = createFakeClock()
  clock.settleOn(queueIo.get(queue)!)
  return clock
}
function harness(queue: ReplyReminderQueue, options: { prepare?: (key: string, item: QueueItem) => Promise<void> } = {}) {
  const clock = settledClock(queue)
  const persona = makeMultiPersonaConfig([{ name: 'alpha' }, { name: 'beta' }], dir).personas[0]!
  const row = (state: GetResult['state'], overrides: Partial<GetResult> = {}) => {
    const result = cannedGetResult({ state, session_id: 'session' }, persona, dir)
    return { ...result, labels: { ...result.labels, ...Object.fromEntries([REPLY_TOOL_PREALLOWED_LABEL.split('=')]) }, ...overrides }
  }
  let next: (current: () => boolean) => Promise<GetResult | undefined> = async () => row('working')
  let ready = true, enabled = true, reads = 0
  const readyFor = new Map<string, boolean>(), readKeys: string[] = []
  const prepared: { key: string; item: QueueItem }[] = [], errors: unknown[] = []
  const monitor = createReplyReminders({ queue, clock, getRow: (key, current) => { reads++; readKeys.push(key); return next(current) }, ready: key => readyFor.get(key) ?? ready, enabled: () => enabled,
    prepare: async (key, item) => { prepared.push({ key, item }); await options.prepare?.(key, item) }, onError: (_key, error) => { errors.push(error) } })
  monitors.push(monitor)
  return { clock, row, monitor, prepared, errors, readKeys, reads: () => reads,
    next(fn: (current: () => boolean) => Promise<GetResult | undefined>) { next = fn }, ready(value: boolean, key?: string) { if (key) readyFor.set(key, value); else ready = value }, enabled(value: boolean) { enabled = value } }
}
async function send(queue: ReplyReminderQueue, key = 'alpha', input: AcceptedInput = slackInput({ via: 'thread', thread_ts: THREAD_ROOT }), complete = true) {
  const accepted = await queue.accept(key, input)
  if (accepted.status !== 'accepted') throw new Error('fixture acceptance failed')
  const seq = accepted.seq
  await queue.append(key, fixedRecord(seq, ['delivered body']))
  await queue.append(key, sentRecord(seq))
  if (complete) await queue.append(key, deliveredRecord(seq))
  return seq
}
const nudges = (q: ReplyReminderQueue, key = 'alpha') => q.items(key).filter(item => item.accepted.reminder_for !== undefined)
const joinedMention = (overrides: Partial<AcceptedInput> = {}) => slackInput({
  via: 'mention', ts: THREAD_ROOT, thread_ts: THREAD_ROOT,
  key: { chat_id: slackInput().channel!, ts: THREAD_ROOT },
  thread_join: { thread_ts: THREAD_ROOT, stamp: { ...THREAD_STAMP }, at: 1000 }, ...overrides,
})

test.each([['Memory', memoryHold], ['Post', postHold]] as const)('%s Holds never get reminders until release and durable delivery; withdrawal stays ineligible', async (_, field) => {
  const clock = createFakeClock(), q = await open({ now: clock.now }), h = harness(q)
  for (const ts of [THREAD_ROOTS.secondary, THREAD_ROOTS.third]) {
    const input = heldSlackInput(field(clock.now()), { ts, key: { chat_id: 'C0TEST001', ts } })
    expect((await q.acceptDecided('alpha', input.key, () => ({ store: input }), { channel: input.channel!, root: input.hold!.thread_ts })).status).toBe('accepted')
  }
  await q.resolveHolds('alpha', [{ seq: 2, outcome: 'withdrawn', at: clock.now() }])
  await clock.advance(REPLY_REMINDER_KEEP_MS)
  await h.monitor.observe('alpha', h.row('working'))
  await h.monitor.observe('alpha', h.row('waiting'))
  expect(q.replyReminderItems('alpha')).toEqual([])
  expect(nudges(q)).toEqual([])
  expect(h.prepared).toEqual([])

  await q.resolveHolds('alpha', [{ seq: 1, outcome: 'released', at: clock.now() }])
  await h.monitor.observe('alpha', h.row('working'))
  await h.monitor.observe('alpha', h.row('waiting'))
  expect(q.replyReminderItems('alpha')).toEqual([])
  expect(nudges(q)).toEqual([])
  const engine = await makeEngineHarness({ queue: q, stateDir: dir })
  try {
    await engine.clock.advanceTo(clock.now())
    await engine.preparation.recover()
    engine.p().autoReceipt = false
    await engine.tick()
    await engine.until(() => engine.keyCalls().some(c => c.params.key === 'Enter'))
    expect(q.replyReminderItems('alpha')).toEqual([])
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(nudges(q)).toEqual([])
    // Take in the real engine's exact fixed text; no test-authored delivery record.
    appendTranscript(engine.p().path, [promptEntry(q.item('alpha', 1)!.fixed!.parts[0]!)])
    await engine.until(() => q.item('alpha', 1)?.delivered === true)
    expect(q.replyReminderItems('alpha').map(r => r.seq)).toEqual([1])
    await h.monitor.observe('alpha', h.row('working', { session_id: engine.p().row.session_id }))
    await h.monitor.observe('alpha', h.row('waiting', { session_id: engine.p().row.session_id }))
    expect(nudges(q).map(i => [i.accepted.reminder_for, i.accepted.text])).toEqual([[1, REPLY_REMINDER_TEXT]])
    expect(h.prepared.map(p => p.item.accepted.reminder_for)).toEqual([1])
    expect(q.item('alpha', 2)?.hold?.state).toBe('withdrawn')
    expect(q.item('alpha', 2)?.fixed).toBeUndefined()
    expect(h.errors).toEqual([])
    expect(engine.errors).toEqual([])
    assertNoLeak([h.prepared, h.errors, engine.events, engine.calls, engine.errors, readQueue(dir)])
  } finally { await engine.cleanup() }
})

describe('join retention preserves reply reminders', () => {
  test('a joined mention, its thread reply and a plain mention each retain one eligible reminder when the join becomes saved', async () => {
    let saved = false
    const options = { threadJoinSaved: () => () => saved }
    const q = await open(options)
    const joined = await send(q, 'alpha', joinedMention())
    const reply = await send(q, 'alpha', slackInput({ via: 'thread', thread_ts: THREAD_ROOT,
      ts: THREAD_ROOTS.secondary, key: { chat_id: slackInput().channel!, ts: THREAD_ROOTS.secondary } }))
    const plain = await send(q, 'alpha', slackInput({ via: 'mention',
      ts: THREAD_ROOTS.third, key: { chat_id: slackInput().channel!, ts: THREAD_ROOTS.third } }))
    await q.compact(); await q.stop()
    const replay = await open(options), h = harness(replay)
    expect(replay.items('alpha').map(item => [item.accepted.seq, item.delivered])).toEqual([[joined, true]])
    expect(replay.openCount('alpha')).toBe(0)
    expect(replay.replyReminderItems('alpha').map(record => record.seq).sort((a, b) => a - b)).toEqual([joined, reply, plain])
    await h.monitor.observe('alpha', h.row('working'))
    saved = true
    await replay.compact()
    expect(replay.items('alpha')).toEqual([])
    await h.monitor.observe('alpha', h.row('waiting'))
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(nudges(replay).map(item => [item.accepted.reminder_for, item.accepted.text])).toEqual(
      [joined, reply, plain].map(seq => [seq, REPLY_REMINDER_TEXT]))
    expect(h.prepared.map(p => p.item.accepted.reminder_for)).toEqual([joined, reply, plain])
    expect(replay.openCount('alpha')).toBe(3)
    expect(h.errors).toEqual([])
  })

  test.each(['replied', 'cancelled', 'nudged'] as const)('an unsaved join cannot re-arm a %s reminder after compaction and reopen', async state => {
    let saved = false
    const options = { threadJoinSaved: () => () => saved }
    const q = await open(options), h = harness(q)
    const seq = await send(q, 'alpha', joinedMention())
    if (state === 'replied') await h.monitor.noteReplyCall('alpha')
    else if (state === 'cancelled') await h.monitor.forget('alpha')
    else {
      await h.monitor.observe('alpha', h.row('working'))
      await h.monitor.observe('alpha', h.row('waiting'))
      const reminder = nudges(q)[0]!
      await q.append('alpha', fixedRecord(reminder.accepted.seq, [REPLY_REMINDER_TEXT]))
      await q.append('alpha', sentRecord(reminder.accepted.seq))
      await q.append('alpha', deliveredRecord(reminder.accepted.seq))
    }
    expect(q.replyReminderItems('alpha')).toEqual([])
    expect(readQueue(dir).filter(record => record.kind === 'reply-reminder').at(-1)).toEqual(expect.objectContaining({ seq, state }))
    await h.monitor.stop(); await q.compact(); await q.stop()
    const replay = await open(options), resumed = harness(replay)
    expect(replay.item('alpha', seq)?.delivered).toBe(true)
    expect(replay.openCount('alpha')).toBe(0)
    expect(replay.replyReminderItems('alpha')).toEqual([])
    expect(readQueue(dir).filter(record => record.kind === 'reply-reminder')).toEqual([expect.objectContaining({ seq, state })])
    await resumed.monitor.observe('alpha', resumed.row('working'))
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect(nudges(replay)).toEqual([])
    expect(resumed.prepared).toEqual([])
    saved = true
    await resumed.monitor.stop(); await replay.compact(); await replay.stop()
    const final = await open(options), last = harness(final)
    await last.monitor.observe('alpha', last.row('working'))
    await last.monitor.observe('alpha', last.row('waiting'))
    expect(final.items('alpha')).toEqual([])
    expect(final.replyReminderItems('alpha')).toEqual([])
    expect(last.prepared).toEqual([])
  })

  test.each([false, true])('a torn terminal append stays suppressed after the reminder compacts away (delivered before reopen: %s)', async deliveredBeforeReopen => {
    let saved = false
    const options = { threadJoinSaved: () => () => saved }
    const q = await open(options), h = harness(q)
    const seq = await send(q, 'alpha', joinedMention())
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(h.prepared.map(p => p.item.accepted.reminder_for)).toEqual([seq])
    const reminderSeq = nudges(q)[0]!.accepted.seq
    const deliverReminder = async (queue: ReplyReminderQueue) => {
      await queue.append('alpha', fixedRecord(reminderSeq, [REPLY_REMINDER_TEXT]))
      await queue.append('alpha', sentRecord(reminderSeq))
      await queue.append('alpha', deliveredRecord(reminderSeq))
    }
    if (deliveredBeforeReopen) await deliverReminder(q)
    await h.monitor.stop(); await q.stop()
    // Keep the accepted reminder, but simulate losing its terminal append.
    seedQueue(dir, readQueue(dir).filter(r => !(r.kind === 'reply-reminder' && r.seq === seq && r.state === 'nudged')))
    let replay = await open(options)
    if (!deliveredBeforeReopen) await deliverReminder(replay)
    // No AD observation repairs suppression before the reminder disappears.
    for (let cycle = 0; cycle < 2; cycle++) {
      await replay.compact(); await replay.stop()
      replay = await open(options)
      expect(replay.items('alpha').map(item => [item.accepted.seq, item.delivered])).toEqual([[seq, true]])
      expect(replay.openCount('alpha')).toBe(0)
      expect(replay.replyReminderItems('alpha')).toEqual([])
    }
    const resumed = harness(replay)
    await resumed.monitor.observe('alpha', resumed.row('working'))
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect(nudges(replay)).toEqual([])
    expect(resumed.prepared).toEqual([])
    saved = true
    await resumed.monitor.stop(); await replay.compact(); await replay.stop()
    const released = await open(options), last = harness(released)
    await last.monitor.observe('alpha', last.row('working'))
    await last.monitor.observe('alpha', last.row('waiting'))
    expect(released.items('alpha')).toEqual([])
    expect(released.replyReminderItems('alpha')).toEqual([])
    expect(readQueue(dir).filter(r => r.kind === 'reply-reminder')).toEqual([])
    expect(last.prepared).toEqual([])
    expect([...h.errors, ...resumed.errors, ...last.errors]).toEqual([])
  })

  test('retaining a delivered join neither extends reminder eligibility nor offers the item for delivery again', async () => {
    const clock = createFakeClock({ start: 1000 })
    let saved = false
    const options = { now: clock.now, threadJoinSaved: () => () => saved }
    const q = await open(options)
    // A different join time proves that eligibility is measured from delivery.
    const seq = await send(q, 'alpha', joinedMention({ thread_join: { thread_ts: THREAD_ROOT, stamp: { ...THREAD_STAMP }, at: 0 } }))
    await clock.advance(REPLY_REMINDER_KEEP_MS - 1)
    await q.compact(); await q.stop()
    const replay = await open(options), h = harness(replay)
    expect(replay.replyReminderItems('alpha').map(record => [record.seq, record.delivered_at ?? record.at])).toEqual([[seq, 1000]])
    await clock.advance(1)
    await replay.compact()
    expect(replay.item('alpha', seq)?.delivered).toBe(true)
    expect(replay.openCount('alpha')).toBe(0)
    expect(replay.replyReminderItems('alpha')).toEqual([])
    h.monitor.start(); await h.clock.flush()
    expect(h.reads()).toBe(0)
    expect(h.clock.pendingCount()).toBe(0)
    const engine = await makeEngineHarness({ queue: replay, stateDir: dir })
    try {
      await engine.tick()
      expect(engine.keyCalls()).toEqual([])
      expect(engine.errors).toEqual([])
    } finally { await engine.cleanup() }
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(h.prepared).toEqual([])
    saved = true
    await h.monitor.stop(); await replay.compact(); await replay.stop()
    const final = await open(options)
    expect(final.items('alpha')).toEqual([])
    expect(final.replyReminderItems('alpha')).toEqual([])
    expect(final.openCount('alpha')).toBe(0)
  })
})

describe('AD row reply reminders', () => {
  test.each([undefined, '0'])('a legacy Claude row with reply preallow marker %s gets no reminder, including after resume', async marker => {
    const q = await open(), h = harness(q)
    const labels = { ...h.row('working').labels }
    delete labels.reply_tool_preallowed
    if (marker !== undefined) labels.reply_tool_preallowed = marker
    await send(q)
    await h.monitor.observe('alpha', h.row('working', { labels }))
    await h.monitor.observe('alpha', h.row('waiting', { labels }))
    expect(nudges(q)).toEqual([])
    expect(q.replyReminderItems('alpha')).toEqual([])
    await h.monitor.observe('alpha', h.row('pending', { labels }))
    await send(q, 'alpha', slackInput({ key: { chat_id: 'C0TEST001', ts: '1700000000.000002' } }))
    await h.monitor.observe('alpha', h.row('working', { labels }))
    await h.monitor.observe('alpha', h.row('waiting', { labels }))
    expect(nudges(q)).toEqual([])
    expect(h.prepared).toEqual([])
    expect(h.errors).toEqual([])
  })

  test.each(['claude', 'codex'] as const)('%s: working → waiting queues exactly one normal injected reminder for each delivered Slack message', async agent => {
    const q = await open(), h = harness(q)
    // The Claude launch permission marker has no role in Codex's own policy.
    const agentRow = { agent, ...(agent === 'codex' ? { labels: {} } : {}) }
    const first = await send(q)
    await h.monitor.observe('alpha', h.row('waiting', agentRow))
    expect(nudges(q)).toEqual([])
    await h.monitor.observe('alpha', h.row('working', agentRow))
    await Promise.all([h.monitor.observe('alpha', h.row('waiting', agentRow)), h.monitor.observe('alpha', h.row('waiting', agentRow))])
    expect(h.errors).toEqual([])
    expect(nudges(q).map(item => item.accepted)).toEqual([expect.objectContaining({ source: 'interject', sender: 'reply-reminder', text: REPLY_REMINDER_TEXT, reminder_for: first })])
    expect(h.prepared.map(p => [p.key, p.item.accepted.seq])).toEqual([['alpha', nudges(q)[0]!.accepted.seq]])
    await h.monitor.observe('alpha', h.row('working', agentRow))
    await h.monitor.observe('alpha', h.row('waiting', agentRow))
    expect(nudges(q)).toHaveLength(1)
    const second = await send(q, 'alpha', slackInput({ key: { chat_id: 'C0TEST001', ts: '1700000000.000002' } }))
    await h.monitor.observe('alpha', h.row('working', agentRow))
    await h.monitor.observe('alpha', h.row('waiting', agentRow))
    expect(nudges(q).map(item => item.accepted.reminder_for)).toEqual([first, second])
    expect(nudges(q, 'beta')).toEqual([])
  })

  test.each(['interject', 'cron'] as const)('%s and a delivered reminder do not create recursive candidates', async source => {
    const q = await open(), h = harness(q)
    await send(q, 'alpha', injectedInput({ source }))
    await send(q, 'alpha', injectedInput({ sender: 'reply-reminder', reminder_for: 99 }))
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(q.replyReminderItems('alpha')).toEqual([])
    expect(h.prepared).toEqual([])
  })

  test('an accepted or sent Slack item waits for confirmed delivery', async () => {
    const q = await open(), h = harness(q), seq = await send(q, 'alpha', slackInput(), false)
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(nudges(q)).toEqual([])
    await q.append('alpha', deliveredRecord(seq))
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(nudges(q)).toHaveLength(1)
  })

  test('a reply call suppresses only sent deliveries at its synchronous cutoff, even before receipt', async () => {
    const q = await open(), h = harness(q), first = await send(q, 'alpha', slackInput(), false)
    const reply = h.monitor.noteReplyCall('alpha')
    const second = await send(q, 'alpha', slackInput({ key: { chat_id: 'C0TEST001', ts: '1700000000.000002' } }))
    await reply
    await q.append('alpha', deliveredRecord(first))
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(nudges(q).map(item => item.accepted.reminder_for)).toEqual([second])
  })

  test.each(['pending', 'ended', 'missing', 'error'] as GetResult['state'][])('%s retires the old candidate without nudging a later life', async state => {
    const q = await open(), h = harness(q)
    await send(q)
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row(state))
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(q.replyReminderItems('alpha')).toEqual([])
    expect(nudges(q)).toEqual([])
  })

  test.each([{ session_id: 'replacement' }, { launch_started_at: '2026-10-19T00:00:01Z' }])('a changed running life %j cannot inherit an earlier delivery', async changed => {
    const q = await open(), h = harness(q)
    await send(q)
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting', changed))
    expect(nudges(q)).toEqual([])
    expect(q.replyReminderItems('alpha')).toEqual([])
  })

  test('an unknown row breaks the working → waiting transition until working is observed again', async () => {
    const q = await open(), h = harness(q)
    await send(q)
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('future-state' as GetResult['state']))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(nudges(q)).toEqual([])
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(nudges(q)).toHaveLength(1)
  })

  test('polling retries an AD read failure; a not-ready persona gets no read or preparation', async () => {
    const q = await open(), h = harness(q)
    await send(q)
    h.ready(false); h.monitor.start(); await h.clock.runNext()
    expect(h.reads()).toBe(0)
    h.ready(true); h.next(async () => { throw new Error('AD unavailable') }); await h.clock.advance(REPLY_REMINDER_POLL_MS)
    expect(h.errors).toHaveLength(1)
    expect(nudges(q)).toEqual([])
    h.next(async () => h.row('working')); await h.clock.advance(REPLY_REMINDER_POLL_MS)
    h.next(async () => h.row('waiting')); await h.clock.advance(REPLY_REMINDER_POLL_MS)
    expect(nudges(q)).toHaveLength(1)
    await h.monitor.stop(); expect(h.clock.pendingCount()).toBe(0)
  })

  test('the compatibility switch is read immediately and cancels an outstanding candidate', async () => {
    const q = await open(), h = harness(q)
    await send(q)
    await h.monitor.observe('alpha', h.row('working'))
    h.enabled(false)
    await h.monitor.observe('alpha', h.row('waiting'))
    h.enabled(true)
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(nudges(q)).toEqual([])
    expect(q.replyReminderItems('alpha')).toEqual([])
  })

  test('a not-up persona waits while its up sibling is polled and prepared normally', async () => {
    const q = await open(), h = harness(q)
    await send(q); await send(q, 'beta')
    h.ready(false, 'alpha'); h.monitor.start(); await h.clock.runNext()
    h.next(async () => h.row('waiting')); await h.clock.advance(REPLY_REMINDER_POLL_MS)
    expect(h.readKeys).toEqual(['beta', 'beta'])
    expect(nudges(q, 'alpha')).toEqual([])
    expect(nudges(q, 'beta')).toHaveLength(1)
    expect(h.prepared.map(p => p.key)).toEqual(['beta'])
  })

  test('several Slack deliveries completing one turn each receive one reminder through normal preparation', async () => {
    const q = await open(), h = harness(q)
    const first = await send(q)
    const second = await send(q, 'alpha', slackInput({ key: { chat_id: 'C0TEST001', ts: '1700000000.000002' } }))
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(nudges(q).map(item => item.accepted.reminder_for)).toEqual([first, second])
    expect(h.prepared.map(p => p.item.accepted.seq)).toEqual(nudges(q).map(item => item.accepted.seq))
    expect(nudges(q, 'beta')).toEqual([])
  })

  test('a failed first reminder fixation cannot strand the later accepted reminder behind the FIFO head', async () => {
    const q = await open(), clock = settledClock(q), errors: unknown[] = [], fixed: number[] = []
    const first = await send(q)
    const second = await send(q, 'alpha', slackInput({ key: { chat_id: 'C0TEST001', ts: '1700000000.000002' } }))
    let fail = true
    const preparation = createDeliveryPreparation({
      queue: { ...q, append: async (key, record) => {
        if (record.kind === 'fixed' && fail) { fail = false; throw new Error('first reminder fixation failed') }
        await q.append(key, record)
      } },
      clock, retryBackoffMs: [10], resolveUserName: async () => 'unused', clientFor: () => undefined,
      wake: key => { for (const item of q.items(key)) if (item.fixed && !item.delivered && !fixed.includes(item.accepted.seq)) fixed.push(item.accepted.seq) },
    })
    const h = harness(q, { prepare: (key, item) => preparation.prepare(key, item) })
    try {
      await h.monitor.observe('alpha', h.row('working'))
      await h.monitor.observe('alpha', h.row('waiting'))
      const items = nudges(q)
      expect(items.map(item => item.accepted.reminder_for)).toEqual([first, second])
      expect(h.prepared.map(p => p.item.accepted.seq)).toEqual(items.map(item => item.accepted.seq))
      errors.push(...h.errors)
      expect(errors).toHaveLength(1)
      expect(q.item('alpha', items[0]!.accepted.seq)!.fixed).toBeUndefined()
      expect(q.item('alpha', items[1]!.accepted.seq)!.fixed).toBeDefined()
      expect(preparation.owns('alpha', items[0]!.accepted.seq)).toBe(true)
      await clock.advance(10)
      expect(q.items('alpha').filter(item => item.accepted.reminder_for !== undefined).every(item => !!item.fixed)).toBe(true)
      expect(fixed.sort((a, b) => a - b)).toEqual(items.map(item => item.accepted.seq))
      expect(clock.pendingCount()).toBe(0)
    } finally { await preparation.stop() }
  })

  test.each(['forget', 'stop', 'not-ready'] as const)('%s invalidates the guard supplied to an in-flight independent read before it returns', async action => {
    const q = await open(), h = harness(q)
    await send(q)
    await h.monitor.observe('alpha', h.row('working'))
    let release!: () => void, readCurrent!: () => boolean
    h.next(async current => {
      readCurrent = current
      await new Promise<void>(resolve => { release = resolve })
      expect(current()).toBe(false)
      return undefined
    })
    h.monitor.wake('alpha'); await h.clock.runNext()
    expect(readCurrent()).toBe(true)
    const cancelling = action === 'forget' ? h.monitor.forget('alpha') : action === 'stop' ? h.monitor.stop() : Promise.resolve(h.ready(false))
    expect(readCurrent()).toBe(false)
    release(); await cancelling; await h.clock.flush()
    expect(q.replyReminderItems('alpha')).toHaveLength(action === 'forget' ? 0 : 1)
    expect(nudges(q)).toEqual([])
    expect(h.prepared).toEqual([])
  })

  test('an own-row handler that consumes a classified read may return no row while its healthy sibling still nudges', async () => {
    const q = await open(), h = harness(q)
    await send(q); await send(q, 'beta')
    await h.monitor.observe('beta', h.row('working'))
    let calls = 0
    h.next(async () => ++calls === 1 ? undefined : h.row('waiting'))
    h.monitor.start(); await h.clock.runNext()
    expect(h.readKeys).toEqual(['alpha', 'beta'])
    expect(nudges(q, 'alpha')).toEqual([])
    expect(nudges(q, 'beta')).toHaveLength(1)
    expect(h.errors).toEqual([])
  })

  test.each(['before-reply', 'after-reply', 'queued-before-reply-persistence'] as const)('a definite refusal %s excludes the attempt and a later successful send rearms after restart', async order => {
    const q = await open(), h = harness(q), seq = await send(q, 'alpha', slackInput(), false)
    const refuse = () => q.append('alpha', { v: 1, kind: 'refused', seq, attempt: 1, at: 1001 })
    if (order === 'before-reply') await refuse()
    let reply: Promise<void> | undefined
    if (order === 'queued-before-reply-persistence') {
      const refusal = refuse()
      const retry = q.append('alpha', sentRecord(seq, 2))
      reply = h.monitor.noteReplyCall('alpha')
      await Promise.all([refusal, retry, reply])
    } else {
      await h.monitor.noteReplyCall('alpha')
      if (order === 'after-reply') await refuse()
      await q.append('alpha', sentRecord(seq, 2))
    }
    await q.append('alpha', deliveredRecord(seq, 1002))
    await h.monitor.stop(); await q.compact(); await q.stop()
    const replay = await open(), resumed = harness(replay)
    await resumed.monitor.observe('alpha', resumed.row('working'))
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect(nudges(replay).map(item => item.accepted.reminder_for)).toEqual([seq])
    expect(resumed.prepared).toHaveLength(1)
    expect(nudges(replay, 'beta')).toEqual([])
  })

  test.each([false, true])('captured attempt survives receipt and compaction before reply persistence (replace with later attempt: %s)', async differentAttempt => {
    const q = await open(), h = harness(q), seq = await send(q, 'alpha', slackInput(), false)
    const targets = q.replyCallTargets('alpha')
    expect(targets).toEqual([{ seq, attempts: [1] }])
    if (differentAttempt) {
      await q.append('alpha', { v: 1, kind: 'refused', seq, attempt: 1, at: 1001 })
      await q.append('alpha', sentRecord(seq, 2))
    }
    await q.append('alpha', deliveredRecord(seq, 1002))
    await q.compact()
    expect(readQueue(dir).filter(r => r.kind === 'reply-reminder')).toEqual([
      expect.objectContaining({ seq, state: 'observed', delivery_attempts: [differentAttempt ? 2 : 1] }),
    ])
    await q.recordReplyCall('alpha', targets)
    await h.monitor.stop(); await q.stop()
    const replay = await open(), resumed = harness(replay)
    await resumed.monitor.observe('alpha', resumed.row('working'))
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect(nudges(replay).map(item => item.accepted.reminder_for)).toEqual(differentAttempt ? [seq] : [])
    expect(resumed.prepared).toHaveLength(differentAttempt ? 1 : 0)
  })

  test('a reply snapshot leaves a later multipart send eligible and does not suppress another persona', async () => {
    const q = await open(), h = harness(q)
    const accepted = await q.accept('alpha', slackInput())
    if (accepted.status !== 'accepted') throw new Error('fixture acceptance failed')
    const seq = accepted.seq
    await q.append('alpha', { v: 1, kind: 'fixed', seq, parts: ['part one', 'part two'] })
    await q.append('alpha', sentRecord(seq))
    await q.append('alpha', { v: 1, kind: 'refused', seq, attempt: 1, at: 1001 })
    expect(q.replyCallTargets('alpha')).toEqual([])
    await h.monitor.noteReplyCall('alpha')
    await q.append('alpha', sentRecord(seq, 2))
    await q.append('alpha', deliveredRecord(seq))
    const secondPart = sentRecord(seq, 3)
    if (secondPart.kind !== 'sent' || 'unknown_outcome' in secondPart) throw new Error('expected full sent fixture')
    await q.append('alpha', { ...secondPart, part: 2 })
    await q.append('alpha', { ...deliveredRecord(seq), part: 2 })
    await send(q, 'beta')
    for (const key of ['alpha', 'beta']) {
      await h.monitor.observe(key, h.row('working'))
      await h.monitor.observe(key, h.row('waiting'))
    }
    expect(nudges(q, 'alpha').map(item => item.accepted.reminder_for)).toEqual([seq])
    expect(nudges(q, 'beta')).toHaveLength(1)
    expect(h.prepared.map(p => p.key)).toEqual(['alpha', 'beta'])
  })

  test.each(['reply', 'forget', 'stop'] as const)('%s during an AD read prevents the stale read from queuing a reminder', async action => {
    const q = await open(), h = harness(q)
    await send(q)
    await h.monitor.observe('alpha', h.row('working'))
    let resolve!: (row: GetResult) => void
    h.next(() => new Promise(done => { resolve = done }))
    h.monitor.wake('alpha'); await h.clock.runNext()
    expect(h.reads()).toBe(1)
    const stopping = action === 'reply' ? h.monitor.noteReplyCall('alpha') : action === 'forget' ? h.monitor.forget('alpha') : h.monitor.stop()
    resolve(h.row('waiting')); await stopping; await h.clock.flush()
    expect(nudges(q)).toEqual([])
    expect(h.prepared).toEqual([])
  })

  test('an engine row observation is preserved behind a slow poll and concurrent observations still nudge once', async () => {
    const q = await open(), h = harness(q)
    await send(q)
    let resolve!: (row: GetResult) => void
    h.next(() => new Promise(done => { resolve = done }))
    h.monitor.start(); await h.clock.runNext()
    const observed = h.monitor.observe('alpha', h.row('waiting'))
    resolve(h.row('working')); await observed
    expect(nudges(q)).toHaveLength(1)
    expect(h.prepared).toHaveLength(1)
  })

  test('forget cancels only the removed persona and wake admits its later deliveries', async () => {
    const q = await open(), h = harness(q)
    await send(q); await send(q, 'beta')
    await h.monitor.forget('alpha')
    await h.monitor.observe('beta', h.row('working'))
    await h.monitor.observe('beta', h.row('waiting'))
    expect(nudges(q, 'alpha')).toEqual([])
    expect(nudges(q, 'beta')).toHaveLength(1)
    const seq = await send(q, 'alpha', slackInput({ key: { chat_id: 'C0TEST001', ts: '1700000000.000002' } }))
    h.monitor.wake('alpha')
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(nudges(q, 'alpha').map(item => item.accepted.reminder_for)).toEqual([seq])
  })

  test('compaction drops delivered content while preserving pending row facts across restart', async () => {
    let now = 1000
    const q = await open({ now: () => now }), h = harness(q)
    const seq = await send(q)
    await h.monitor.observe('alpha', h.row('working'))
    // Unresolved facts survive restart only within their bounded eligibility window.
    await h.monitor.stop(); now += REPLY_REMINDER_KEEP_MS - 1; await q.compact(); await q.stop()
    const records = readQueue(dir)
    expect(JSON.stringify(records)).not.toContain('delivered body')
    expect(records.filter(r => r.kind === 'reply-reminder')).toEqual([expect.objectContaining({ seq, state: 'observed', row_state: 'working' })])
    const replay = await open({ now: () => now }), resumed = harness(replay)
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect(nudges(replay)).toHaveLength(1)
    await resumed.monitor.stop(); await replay.compact(); await replay.stop()
    const again = await open({ now: () => now }), final = harness(again)
    await final.monitor.observe('alpha', final.row('working'))
    await final.monitor.observe('alpha', final.row('waiting'))
    expect(nudges(again)).toHaveLength(1)
    expect(final.prepared).toEqual([])
  })

  test.each([false, true])('pending facts expire without rearming after observations, compaction and restart (legacy: %s)', async legacy => {
    let now = 1000
    const q = await open({ now: () => now })
    const seq = await send(q)
    await q.compact(); await q.stop()
    if (legacy) seedQueue(dir, readQueue(dir).map(r => r.kind === 'reply-reminder' ? { ...r, delivered_at: undefined } : r))
    const replay = await open({ now: () => now }), h = harness(replay)
    now += REPLY_REMINDER_KEEP_MS - 1
    await h.monitor.observe('alpha', h.row('working'))
    await replay.compact()
    const facts = readQueue(dir).filter(r => r.kind === 'reply-reminder')
    expect(facts).toEqual([expect.objectContaining({ seq, state: 'observed', delivered_at: 1000 })])
    expect(Object.keys(facts[0]!).sort()).toEqual(['at', 'delivered_at', 'delivery_attempts', 'kind', 'row_state', 'seq', 'session_id', 'state', 'v'])
    now++
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(replay.replyReminderItems('alpha')).toEqual([])
    expect(nudges(replay)).toEqual([])
    await h.monitor.stop(); await replay.compact(); await replay.stop()
    expect(readQueue(dir).filter(r => r.kind === 'reply-reminder')).toEqual([])
    const final = await open({ now: () => now }), resumed = harness(final)
    await resumed.monitor.observe('alpha', resumed.row('working'))
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect(nudges(final)).toEqual([])
    expect(resumed.prepared).toEqual([])
  })

  test.each(['reply', 'forget', 'nudge'] as const)('compaction drops resolved %s facts and all delivered bodies', async action => {
    const q = await open(), h = harness(q)
    await send(q)
    if (action === 'reply') await h.monitor.noteReplyCall('alpha')
    else if (action === 'forget') await h.monitor.forget('alpha')
    else {
      await h.monitor.observe('alpha', h.row('working'))
      await h.monitor.observe('alpha', h.row('waiting'))
      const seq = nudges(q)[0]!.accepted.seq
      await q.append('alpha', { v: 1, kind: 'fixed', seq, parts: [REPLY_REMINDER_TEXT] })
      await q.append('alpha', sentRecord(seq))
      await q.append('alpha', deliveredRecord(seq))
    }
    await h.monitor.stop(); await q.compact(); await q.stop()
    expect(readQueue(dir).every(r => r.kind === 'accepted' && 'compact' in r)).toBe(true)
    const replay = await open(), resumed = harness(replay)
    await resumed.monitor.observe('alpha', resumed.row('working'))
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect(replay.replyReminderItems('alpha')).toEqual([])
    expect(resumed.prepared).toEqual([])
  })

  test('a torn append retaining reminder acceptance but losing its terminal fact replays without a duplicate', async () => {
    const q = await open(), h = harness(q)
    await send(q)
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    await h.monitor.stop(); await q.stop()
    const records = readQueue(dir)
    seedQueue(dir, records.filter(r => !(r.kind === 'reply-reminder' && r.state === 'nudged')))
    const replay = await open(), resumed = harness(replay)
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect(nudges(replay)).toHaveLength(1)
    expect(resumed.prepared).toEqual([])
    expect(replay.replyReminderItems('alpha')).toEqual([])
  })

  test('replay derives a candidate from an older delivered journal without reminder facts', async () => {
    const q = await open()
    const seq = await send(q)
    await q.stop()
    seedQueue(dir, readQueue(dir).filter(r => r.kind !== 'reply-reminder'))
    const replay = await open(), h = harness(replay)
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(nudges(replay).map(item => item.accepted.reminder_for)).toEqual([seq])
    expect(h.prepared).toHaveLength(1)
  })

  test.each(['reply', 'forget'] as const)('%s before a final delivery receipt survives compaction and restart', async action => {
    let now = 1000
    const q = await open({ now: () => now }), h = harness(q)
    const seq = await send(q, 'alpha', slackInput(), false)
    if (action === 'reply') await h.monitor.noteReplyCall('alpha')
    else await h.monitor.forget('alpha')
    now += REPLY_REMINDER_KEEP_MS + 1
    await h.monitor.stop(); await q.compact(); await q.stop()
    expect(readQueue(dir).filter(record => record.kind === 'reply-reminder')).toEqual([
      expect.objectContaining({ seq, ...(action === 'reply' ? { state: 'replied', reply_attempts: [1] } : { state: 'cancelled' }) }),
    ])
    const replay = await open({ now: () => now }), resumed = harness(replay)
    await replay.append('alpha', deliveredRecord(seq, now))
    await resumed.monitor.observe('alpha', resumed.row('working'))
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect(nudges(replay)).toEqual([])
    expect(replay.replyReminderItems('alpha')).toEqual([])
    expect(resumed.prepared).toEqual([])
  })

  test.each(['nudge', 'reply'] as const)('failed %s journal fsync publishes no reminder and retries safely', async action => {
    let fail = false
    const q = await open({ fs: failFileSyncs(() => fail, 'EIO') }), h = harness(q)
    await send(q); await h.monitor.observe('alpha', h.row('working'))
    fail = true
    if (action === 'reply') await h.monitor.noteReplyCall('alpha')
    else await h.monitor.observe('alpha', h.row('waiting'))
    expect(h.errors).toHaveLength(1)
    expect(nudges(q)).toEqual([])
    expect(h.prepared).toEqual([])
    fail = false
    await h.monitor.observe('alpha', h.row('waiting'))
    expect(nudges(q)).toHaveLength(action === 'reply' ? 0 : 1)
    expect(q.replyReminderItems('alpha')).toEqual([])
    await h.monitor.stop(); await q.stop()
    const replay = await open(), resumed = harness(replay)
    await resumed.monitor.observe('alpha', resumed.row('working')); await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect(nudges(replay)).toHaveLength(action === 'reply' ? 0 : 1)
    expect(resumed.prepared).toEqual([])
  })
})

describe('b.r6d regression: covered turn-start reminders', () => {
  test.each([undefined, 1, 2])('awaiting_turn_start=%s never treats waiting as a completed turn', async pending => {
    const q = await open(), h = harness(q)
    await send(q)
    await h.monitor.observe('alpha', h.row('working', { busy_send: 'covered', delivery: { awaiting_turn_start: 0 } }))
    await h.monitor.observe('alpha', h.row('waiting', { busy_send: 'covered', delivery: pending === undefined ? undefined : { awaiting_turn_start: pending } }))
    expect(nudges(q)).toEqual([])
    expect(h.prepared).toEqual([])
    // Consuming the pending input exposes the retained working → waiting edge.
    await h.monitor.observe('alpha', h.row('waiting', { busy_send: 'covered', delivery: { awaiting_turn_start: 0 } }))
    expect(nudges(q)).toHaveLength(1)
    expect(h.prepared).toHaveLength(1)
    expect(nudges(q)[0]!.accepted.item_id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
  })

  test('unknown turn-start facts do not invent a working observation', async () => {
    const q = await open(), h = harness(q)
    await send(q)
    await h.monitor.observe('alpha', h.row('working', { busy_send: 'covered' }))
    await h.monitor.observe('alpha', h.row('waiting', { busy_send: 'covered', delivery: { awaiting_turn_start: 0 } }))
    expect(nudges(q)).toEqual([])
    await h.monitor.observe('alpha', h.row('working', { busy_send: 'covered', delivery: { awaiting_turn_start: 0 } }))
    await h.monitor.observe('alpha', h.row('waiting', { busy_send: 'covered', delivery: { awaiting_turn_start: 0 } }))
    expect(nudges(q)).toHaveLength(1)
  })

  test.each([undefined, 'not_covered'] as const)('legacy coverage=%s still needs no turn-start field', async busy_send => {
    const q = await open(), h = harness(q)
    await send(q)
    await h.monitor.observe('alpha', h.row('working', { busy_send }))
    await h.monitor.observe('alpha', h.row('waiting', { busy_send }))
    expect(nudges(q)).toHaveLength(1)
  })
})

describe('b.r6d regression: covered handover reminder candidates', () => {
  async function submit(q: ReplyReminderQueue) {
    const accepted = await q.accept('alpha', slackInput())
    if (accepted.status !== 'accepted') throw new Error('fixture acceptance failed')
    const seq = accepted.seq
    await q.append('alpha', { v: 1, kind: 'fixed', seq, parts: ['original'] })
    await q.append('alpha', { v: 1, kind: 'submitted', seq, part: 1, attempt: 1, at: 1000,
      caller_uuid: q.callerUuid!(), delivery_request_id: 'cscb/alpha/reminder/1', instance_id: 'cscb_alpha', launch_token: 'launch-a', session_id: 'session-before-resume' })
    return seq
  }
  test('Final handover uses AD session binding and wakes one reminder after Turn Start consumption', async () => {
    const q = await open(), h = harness(q), seq = await submit(q)
    await q.append('alpha', { ...deliveredRecord(seq), ad: { launch_token: 'launch-b', session_id: 'session', evidence_kind: null } })
    expect(q.replyReminderItems('alpha')).toContainEqual(expect.objectContaining({ seq, session_id: 'session', delivery_attempts: [1] }))
    await q.compact('alpha')
    await h.monitor.observe('alpha', h.row('working', { busy_send: 'covered', delivery: { awaiting_turn_start: 0 } }))
    await h.monitor.observe('alpha', h.row('waiting', { busy_send: 'covered', delivery: { awaiting_turn_start: 1 } }))
    expect(nudges(q)).toEqual([])
    await h.monitor.observe('alpha', h.row('waiting', { busy_send: 'covered', delivery: { awaiting_turn_start: 0 } }))
    expect(nudges(q)).toHaveLength(1); expect(h.prepared).toHaveLength(1)
  })
  test('a reply before covered Final settles only its submitted attempt', async () => {
    const q = await open(), h = harness(q), seq = await submit(q)
    expect(q.replyCallTargets('alpha')).toEqual([{ seq, attempts: [1] }])
    await h.monitor.noteReplyCall('alpha')
    await q.append('alpha', { ...deliveredRecord(seq), ad: { launch_token: 'launch-a', session_id: 'session', evidence_kind: null } })
    await h.monitor.observe('alpha', h.row('working', { busy_send: 'covered', delivery: { awaiting_turn_start: 0 } }))
    await h.monitor.observe('alpha', h.row('waiting', { busy_send: 'covered', delivery: { awaiting_turn_start: 0 } }))
    expect(nudges(q)).toEqual([])
    expect(q.replyReminderItems('alpha')).toEqual([])
  })
})

const reminderFacts = () => readQueue(dir).filter(record => record.kind === 'reply-reminder')
const reminderView = (q: ReplyReminderQueue) => ({ candidates: q.replyReminderItems('alpha'), targets: q.replyCallTargets('alpha'), facts: reminderFacts() })

describe('Reaction Items and reply reminders', () => {
  // The file-level hook still owns cleanup; these captures are in memory.
  const checked: ReturnType<typeof harness>[] = []
  afterEach(() => { for (const h of checked.splice(0)) assertNoLeak([h.errors, h.prepared], 'reaction reminder captures') })
  const reminderHarness = (queue: ReplyReminderQueue) => { const h = harness(queue); checked.push(h); return h }
  test('accepted, withdrawn, sent and delivered reactions add no candidate, target or reminder, live or replayed', async () => {
    const q = await open(), h = reminderHarness(q)
    const accepted = await q.accept('alpha', reactionInput({ ts: '1700000000.000003', emoji: 'eyes' }))
    const withdrawn = await q.accept('alpha', reactionInput({ ts: '1700000000.000004', emoji: 'tada' }))
    if (accepted.status !== 'accepted' || withdrawn.status !== 'accepted') throw new Error('fixture acceptance failed')
    await q.append('alpha', { v: 1, kind: 'withdrawn', seq: withdrawn.seq, reason: 'server-post', at: 1001 })
    const seq = await send(q, 'alpha', reactionInput(), false)
    expect(reminderView(q)).toEqual({ candidates: [], targets: [], facts: [] })
    await q.append('alpha', deliveredRecord(seq))
    expect(q.item('alpha', seq)!.delivered).toBe(true)
    expect(reminderView(q)).toEqual({ candidates: [], targets: [], facts: [] })
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect({ nudges: nudges(q), prepared: h.prepared, errors: h.errors }).toEqual({ nudges: [], prepared: [], errors: [] })
    await h.monitor.stop(); await q.stop()
    // Startup replay derives reminder facts for every delivered item before its
    // compaction drops the closed reactions and keeps any observed candidate.
    const replay = await open(), resumed = reminderHarness(replay)
    expect(replay.items('alpha').map(item => item.accepted.seq)).toEqual([accepted.seq])
    expect(reminderView(replay)).toEqual({ candidates: [], targets: [], facts: [] })
    await resumed.monitor.observe('alpha', resumed.row('working'))
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect({ nudges: nudges(replay), prepared: resumed.prepared, errors: resumed.errors }).toEqual({ nudges: [], prepared: [], errors: [] })
    expect(reminderFacts()).toEqual([])
  })

  test("delivering a reaction on a Slack candidate's message leaves its facts unchanged, live and replayed, and it still nudges once", async () => {
    const q = await open(), h = reminderHarness(q)
    const slack = await send(q)
    await h.monitor.observe('alpha', h.row('working'))
    const before = reminderView(q)
    expect(before.candidates).toEqual([expect.objectContaining({ seq: slack, state: 'observed', delivered_at: 1000, row_state: 'working', session_id: 'session' })])
    expect(before.targets).toEqual([{ seq: slack }])
    const reaction = await send(q, 'alpha', reactionInput(), false)
    expect(reminderView(q)).toEqual(before)
    await q.append('alpha', deliveredRecord(reaction, 2000))
    expect(q.item('alpha', reaction)!.delivered).toBe(true)
    expect(reminderView(q)).toEqual(before)
    await h.monitor.stop(); await q.stop()
    const replay = await open(), resumed = reminderHarness(replay)
    expect({ candidates: replay.replyReminderItems('alpha'), targets: replay.replyCallTargets('alpha') }).toEqual({ candidates: before.candidates, targets: before.targets })
    expect(reminderFacts()).toEqual(before.candidates)
    await resumed.monitor.observe('alpha', resumed.row('working'))
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect(nudges(replay).map(item => item.accepted.reminder_for)).toEqual([slack])
    expect(resumed.prepared.map(p => p.item.accepted.seq)).toEqual(nudges(replay).map(item => item.accepted.seq))
    expect(resumed.errors).toEqual([])
  })

  test('a reply-call cutoff while a reaction is sent targets only the Slack delivery, before and after receipts and replay', async () => {
    const q = await open(), h = reminderHarness(q)
    const slack = await send(q, 'alpha', slackInput(), false)
    const reaction = await send(q, 'alpha', reactionInput(), false)
    expect(q.replyCallTargets('alpha')).toEqual([{ seq: slack, attempts: [1] }])
    await h.monitor.noteReplyCall('alpha')
    const replied = reminderFacts()
    expect(replied).toEqual([expect.objectContaining({ seq: slack, state: 'replied', reply_attempts: [1] })])
    await q.append('alpha', deliveredRecord(reaction))
    await q.append('alpha', deliveredRecord(slack))
    expect(reminderFacts()).toEqual(replied)
    expect(q.replyCallTargets('alpha').map(target => target.seq)).toEqual([slack])
    await h.monitor.observe('alpha', h.row('working'))
    await h.monitor.observe('alpha', h.row('waiting'))
    expect({ nudges: nudges(q), prepared: h.prepared, errors: h.errors }).toEqual({ nudges: [], prepared: [], errors: [] })
    await h.monitor.stop(); await q.stop()
    // Both delivered items compact away on startup; only a wrongly derived reaction candidate would remain.
    const replay = await open(), resumed = reminderHarness(replay)
    expect(reminderView(replay)).toEqual({ candidates: [], targets: [], facts: [] })
    await resumed.monitor.observe('alpha', resumed.row('working'))
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect({ nudges: nudges(replay), prepared: resumed.prepared, errors: resumed.errors }).toEqual({ nudges: [], prepared: [], errors: [] })
  })
})
