import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { GetResult } from 'agent-director'
import { createDeliveryQueue, QUEUE_KEY_KEEP_MS, type AcceptedInput, type ReplyReminderQueue, type QueueItem } from '../src/delivery-queue.ts'
import { createReplyReminders, REPLY_REMINDER_TEXT, REPLY_REMINDER_POLL_MS, type ReplyReminders } from '../src/reply-reminder.ts'
import { cannedGetResult } from './test-helpers/agent-director-stub.ts'
import { makeMultiPersonaConfig } from './test-helpers/persona-config.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { createDeliveryPreparation } from '../src/delivery-intake.ts'
import { deliveredRecord, injectedInput, readQueue, seedQueue, sentRecord, slackInput } from './test-helpers/delivery-queue.ts'

let dir: string
let queues: ReplyReminderQueue[]
let monitors: ReplyReminders[]
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'reply-reminder-')); queues = []; monitors = [] })
afterEach(async () => {
  await Promise.all(monitors.map(m => m.stop()))
  await Promise.all(queues.map(q => q.stop()))
  fs.rmSync(dir, { recursive: true, force: true })
})
async function open(options: Omit<Parameters<typeof createDeliveryQueue>[0], 'stateDir'> = {}) {
  const q = createDeliveryQueue({ stateDir: dir, ...options }); queues.push(q); await q.start(); return q
}
function harness(queue: ReplyReminderQueue, options: { prepare?: (key: string, item: QueueItem) => Promise<void> } = {}) {
  const clock = createFakeClock()
  const persona = makeMultiPersonaConfig([{ name: 'alpha' }, { name: 'beta' }], dir).personas[0]!
  const row = (state: GetResult['state'], overrides: Partial<GetResult> = {}) => cannedGetResult({ state, session_id: 'session', ...overrides }, persona, dir)
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
async function send(queue: ReplyReminderQueue, key = 'alpha', input: AcceptedInput = slackInput(), complete = true) {
  const accepted = await queue.accept(key, input)
  if (accepted.status !== 'accepted') throw new Error('fixture acceptance failed')
  const seq = accepted.seq
  await queue.append(key, { v: 1, kind: 'fixed', seq, parts: ['delivered body'] })
  await queue.append(key, sentRecord(seq))
  if (complete) await queue.append(key, deliveredRecord(seq))
  return seq
}
const nudges = (q: ReplyReminderQueue, key = 'alpha') => q.items(key).filter(item => item.accepted.reminder_for !== undefined)

describe('AD row reply reminders (b.js7)', () => {
  test.each(['claude', 'codex'] as const)('%s: working → waiting queues exactly one normal injected reminder for each delivered Slack message', async agent => {
    const q = await open(), h = harness(q)
    const first = await send(q)
    await h.monitor.observe('alpha', h.row('waiting', { agent }))
    expect(nudges(q)).toEqual([])
    await h.monitor.observe('alpha', h.row('working', { agent }))
    await Promise.all([h.monitor.observe('alpha', h.row('waiting', { agent })), h.monitor.observe('alpha', h.row('waiting', { agent }))])
    expect(h.errors).toEqual([])
    expect(nudges(q).map(item => item.accepted)).toEqual([expect.objectContaining({ source: 'interject', sender: 'reply-reminder', text: REPLY_REMINDER_TEXT, reminder_for: first })])
    expect(h.prepared.map(p => [p.key, p.item.accepted.seq])).toEqual([['alpha', nudges(q)[0]!.accepted.seq]])
    await h.monitor.observe('alpha', h.row('working', { agent }))
    await h.monitor.observe('alpha', h.row('waiting', { agent }))
    expect(nudges(q)).toHaveLength(1)
    const second = await send(q, 'alpha', slackInput({ key: { chat_id: 'C0TEST001', ts: '1700000000.000002' } }))
    await h.monitor.observe('alpha', h.row('working', { agent }))
    await h.monitor.observe('alpha', h.row('waiting', { agent }))
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
    const q = await open(), clock = createFakeClock(), errors: unknown[] = [], fixed: number[] = []
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
    await h.monitor.stop(); now += QUEUE_KEY_KEEP_MS + 1; await q.compact(); await q.stop()
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
    const q = await open(), h = harness(q)
    const seq = await send(q, 'alpha', slackInput(), false)
    if (action === 'reply') await h.monitor.noteReplyCall('alpha')
    else await h.monitor.forget('alpha')
    await h.monitor.stop(); await q.compact(); await q.stop()
    if (action === 'reply') expect(readQueue(dir).filter(record => record.kind === 'reply-reminder')).toEqual([
      expect.objectContaining({ seq, state: 'replied', reply_attempts: [1] }),
    ])
    const replay = await open(), resumed = harness(replay)
    await replay.append('alpha', deliveredRecord(seq))
    await resumed.monitor.observe('alpha', resumed.row('working'))
    await resumed.monitor.observe('alpha', resumed.row('waiting'))
    expect(nudges(replay)).toEqual([])
    expect(replay.replyReminderItems('alpha')).toEqual([])
    expect(resumed.prepared).toEqual([])
  })

  test.each(['nudge', 'reply'] as const)('failed %s journal fsync publishes no reminder and retries safely', async action => {
    let fail = false
    const seam = { ...fs, fsyncSync(fd: number) { if (fail && fs.fstatSync(fd).isFile()) throw new Error('EIO'); fs.fsyncSync(fd) } } as typeof fs
    const q = await open({ fs: seam }), h = harness(q)
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
