import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createDeliveryQueue, isOpenItem, isQueueItemClosed, itemOpenedAt, isQueueRecord, isReactionKey, parseQueueRecord, QueueNotWithdrawable, QueueOutcomeFinal, QUEUE_DIRECTORY_MODE, QUEUE_FILE_MODE, QUEUE_KEY_KEEP_MS, QUEUE_COMPACT_INTERVAL_MS, QUEUE_GROUP_COMMIT_MAX, reactionKeyString, type AcceptedRecord, type AcceptedInput, type HoldField, type HoldOutcome, type HoldResolution, type QueueRecord, type QueueEvent, type QueueStoreKind, type DeliveryQueue, type ReactionAcceptedInput, type ReactionKey, type WithdrawnRecord } from '../src/delivery-queue.ts'
import { assertNoLeak, LEAK_SENTINEL } from './test-helpers/credentials.ts'
import { makeDeliveryNoticeHarness, type DeliveryNoticeHarness } from './test-helpers/delivery-notices.ts'
import { MAX_RELOAD_FILE_BYTES } from '../src/config.ts'
import { createFakeClock, type FakeClock } from './test-helpers/fake-clock.ts'
import { durableIo, failFileSyncs, holdFirstSync, type DurableStep } from './test-helpers/durable-io.ts'
import { yieldToEventLoop } from '../src/durable-journal.ts'
import * as journal from '../src/durable-journal.ts'
import { createDeliveryPreparation } from '../src/delivery-intake.ts'
import { _resetAckTracker, createQueuedAckCallback } from '../src/ack-tracker.ts'
import { acceptedRecord, deliveredRecord, fixedRecord, heldSlackInput, HOLD_FIELDS, injectedInput, makeQueue, memoryHold, noticedRecord, parkedRecord, postHold, queuePath, reactionInput, readQueue, refusedRecord, releasedRecord, seedQueue, sentRecord, slackInput, tornRecord, unknownRootPostHold, withdrawnRecord } from './test-helpers/delivery-queue.ts'
import { makeStubSlack } from './test-helpers/slack-stub.ts'
import { makeThreadMemoryHarness, THREAD_CHANNELS, THREAD_ROOTS, THREAD_STAMP, THREAD_TIME, threadFsControls } from './test-helpers/thread-memory.ts'
import { recoverQueuedJoins } from '../src/thread-join-recovery.ts'
import { createMemoryHoldResolver } from '../src/memory-holds.ts'
import { createDeliveryQueue as createMainDeliveryQueue, isQueueRecord as isMainQueueRecord } from './fixtures/main-delivery-queue/delivery-queue.ts'
import { spyOnCopies } from './test-helpers/copies.ts'

let dir: string
let queues: DeliveryQueue[]
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'delivery-queue-')); queues = [] })
afterEach(async () => { await Promise.all(queues.map(q => q.stop())); _resetAckTracker(); fs.rmSync(dir, { recursive: true, force: true }) })
async function open(options: Parameters<typeof makeQueue>[1] = {}) { const q = await makeQueue(dir, options); queues.push(q); return q }
const accepted = (): AcceptedRecord => ({ ...slackInput(), v: 1, kind: 'accepted', seq: 1, received_at: 1000, ts: '1700000000.000001' })
const kinds: QueueRecord[] = [accepted(), { v: 1, kind: 'fixed', seq: 1, parts: ['exact bytes\n🙂'] }, sentRecord(), deliveredRecord(), { v: 1, kind: 'refused', seq: 1, attempt: 1, at: 1000 }, { v: 1, kind: 'noticed', seq: 1, at: 1000 }, { v: 1, kind: 'reply-reminder', seq: 1, at: 1000, state: 'observed', delivery_attempts: [1] }]
function recordSyncs() {
  const synced: string[] = []
  let failing: ((path: string) => boolean) | undefined
  const io = durableIo({ before(step) {
    if (step.op !== 'fsync') return
    synced.push(step.path)
    if (failing?.(step.path)) throw new Error('EIO injected sync')
  } })
  return { synced, io, fail(path?: string | ((path: string) => boolean)) { failing = typeof path === 'string' ? p => p === path : path }, fs: io.fs }
}
/** Each fsync's target in `steps`: the queue or parent directory, `key`'s journal, another journal, a rewrite's temp or a quarantine file. */
function fsyncTargets(steps: readonly DurableStep[], key = 'alpha'): string[] {
  return steps.filter(step => step.op === 'fsync').map(({ path }) => path === join(dir, 'queue') ? 'queue' : path === dir ? 'parent'
    : path === queuePath(dir, key) ? 'journal' : path.endsWith('.tmp') ? 'temp' : path.includes('.unreadable-') ? 'quarantine' : 'other journal')
}
/** Interval timers on `clock`; each requested delay is pushed to `scheduled`. */
function fakeIntervals(clock: FakeClock, scheduled: number[] = []) {
  return {
    setInterval: ((callback: () => void, delay: number) => {
      scheduled.push(delay)
      const handle: { current?: unknown } = {}
      const fire = () => { callback(); handle.current = clock.setTimeout(fire, delay) }
      handle.current = clock.setTimeout(fire, delay)
      return handle
    }) as unknown as typeof setInterval,
    clearInterval: ((handle: { current: unknown }) => clock.clearTimeout(handle.current)) as unknown as typeof clearInterval,
  }
}
describe('durable record schemas', () => {
  test.each(kinds.map(r => [r.kind, r] as const))('%s roundtrips and rejects invalid versions, sequence and missing payload', (_, r) => {
    expect(parseQueueRecord(JSON.stringify(r))).toEqual(r)
    expect(isQueueRecord({ ...r, v: 2 })).toBe(false)
    expect(isQueueRecord({ ...r, seq: -1 })).toBe(false)
    expect(isQueueRecord({ v: 1, kind: r.kind, seq: 1 })).toBe(false)
  })
  test.each(['{', 'null', '[]', '{"v":1,"seq":1,"kind":"future"}'])('invalid line %s is unreadable', line => expect(parseQueueRecord(line)).toBeUndefined())

  test.each([
    ['source', 'interject', { ...accepted(), ...injectedInput(), key: undefined }],
    ['send_kind', 'text', sentRecord()],
    ['state', 'observed', { v: 1, kind: 'reply-reminder', seq: 1, at: 1000, state: 'observed' }],
  ] as const)('rejects array-valued enum %s without string coercion', (field, value, record) => {
    expect(isQueueRecord(record)).toBe(true)
    const malformed = { ...record, [field]: [value] }
    expect(isQueueRecord(malformed)).toBe(false)
    expect(parseQueueRecord(JSON.stringify(malformed))).toBeUndefined()
  })

  test.each(['observed', 'replied', 'nudged', 'cancelled'] as const)('reply reminder state %s roundtrips with its row facts', state => {
    const record: QueueRecord = { v: 1, kind: 'reply-reminder', seq: 1, at: 1000, delivered_at: 900, state, row_state: 'working', session_id: 'session', launch_started_at: null, delivery_attempts: [1, 3], ...(state === 'replied' ? { reply_attempts: [3] } : {}) }
    expect(parseQueueRecord(JSON.stringify(record))).toEqual(record)
  })

  test.each([
    { state: 'future' }, { at: null }, { row_state: 4 }, { session_id: false }, { launch_started_at: 5 },
    // A malformed retention origin must not keep a candidate eligible forever.
    { delivered_at: null }, { delivered_at: '1000' },
    { reply_attempts: [1] }, { state: 'replied', reply_attempts: [] }, { state: 'replied', reply_attempts: [0] },
    { state: 'replied', reply_attempts: ['1'] }, { state: 'replied', reply_attempts: [1.5] },
    { delivery_attempts: [] }, { delivery_attempts: [0] }, { delivery_attempts: ['1'] }, { delivery_attempts: [1.5] },
  ])('rejects malformed reminder fields %j rather than replaying them', fields => {
    expect(parseQueueRecord(JSON.stringify({ v: 1, kind: 'reply-reminder', seq: 1, at: 1000, state: 'observed', ...fields }))).toBeUndefined()
  })

  test.each([
    { source: 'slack', reminder_for: 1 }, { source: 'cron', reminder_for: 1 },
    { source: 'interject', reminder_for: 0 }, { source: 'interject', reminder_for: -1 },
    { source: 'interject', reminder_for: 1.5 }, { source: 'interject', reminder_for: '1' },
  ])('rejects invalid reminder acceptance %j', fields => {
    const record = { ...accepted(), sender: 'reply-reminder', ...(fields.source === 'slack' ? {} : { key: undefined }), ...fields }
    expect(parseQueueRecord(JSON.stringify({ ...record, reminder_for: undefined }))).toBeDefined()
    expect(parseQueueRecord(JSON.stringify(record))).toBeUndefined()
  })

  test('normal reminder acceptance retains its source sequence on disk', () => {
    const record = { ...accepted(), source: 'interject' as const, sender: 'reply-reminder', key: undefined, reminder_for: 7 }
    expect(parseQueueRecord(JSON.stringify(record))).toEqual(record)
  })
})
test.each([false, true])('sent journal with legacy launch_id=%s replays as an unconfirmed send and survives compaction', async legacy => {
  const sent = legacy ? { ...sentRecord(), launch_id: 'old-server:42' } : sentRecord()
  expect(parseQueueRecord(JSON.stringify(sent))).toEqual(sent)
  seedQueue(dir, [accepted(), { v: 1, kind: 'fixed', seq: 1, parts: ['message'] }, sent])
  const q = await open()
  expect(q.openCount('alpha')).toBe(1)
  expect(q.item('alpha', 1)!.records.filter(r => r.kind === 'sent')).toEqual([sent])
  await q.compact('alpha')
  await q.stop()
  const replay = await open()
  expect(replay.openCount('alpha')).toBe(1)
  expect(replay.item('alpha', 1)!.records.filter(r => r.kind === 'sent')).toEqual([sent])
})
describe('durable queued reaction metadata', () => {
  test('legacy adoption keeps the first name and open delivery facts through replay and compaction', async () => {
    seedQueue(dir, [accepted(), { v: 1, kind: 'fixed', seq: 1, parts: ['first', 'second'] }, sentRecord(), deliveredRecord()])
    let q = await open({ now: createFakeClock({ start: 1000 }).now })
    const before = q.item('alpha', 1)!
    expect(before.accepted.queued_ack_reaction).toBeUndefined()
    expect(await Promise.all([
      q.rememberQueuedReaction('alpha', 1, 'original_queue'),
      q.rememberQueuedReaction('alpha', 1, 'changed_queue'),
    ])).toEqual(['original_queue', 'original_queue'])
    const adopted = { ...before.accepted, queued_ack_reaction: 'original_queue' }
    expect(q.item('alpha', 1)!.accepted).toEqual(adopted)
    expect(readQueue(dir).filter(r => r.kind === 'accepted' && !('compact' in r))).toEqual([adopted])
    for (const compact of [false, true]) {
      if (compact) await q.compact('alpha')
      await q.stop()
      q = await open()
      const item = q.item('alpha', 1)!
      expect(item.accepted).toMatchObject(adopted)
      expect(item.records.filter(r => r.kind !== 'accepted')).toEqual(before.records.filter(r => r.kind !== 'accepted'))
      expect({ delivered: item.delivered, nextAttempt: item.nextAttempt, open: q.openCount('alpha') }).toEqual({ delivered: false, nextAttempt: before.nextAttempt, open: 1 })
      const bytes = fs.readFileSync(queuePath(dir))
      expect(await q.rememberQueuedReaction('alpha', 1, 'later_config')).toBe('original_queue')
      expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
      expect(q.lookupSlackKey('alpha', slackInput().key!)).toMatchObject({ status: 'duplicate', seq: 1 })
    }
  })

  test.each(['', ' \t\n', null, 17])('rejects invalid metadata %p in both replay schema and adoption without altering the legacy item', async name => {
    expect(parseQueueRecord(JSON.stringify({ ...accepted(), queued_ack_reaction: name }))).toBeUndefined()
    seedQueue(dir, [accepted()])
    const q = await open(), before = q.item('alpha', 1), bytes = fs.readFileSync(queuePath(dir))
    // Exercise persisted/untyped input validation at the public boundary.
    await expect(q.rememberQueuedReaction('alpha', 1, name as string)).rejects.toThrow('Invalid queued reaction')
    expect(q.item('alpha', 1)).toEqual(before)
    expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
    expect(await q.rememberQueuedReaction('alpha', 1, 'custom_queue')).toBe('custom_queue')
    expect(parseQueueRecord(JSON.stringify(q.item('alpha', 1)!.accepted))).toEqual(q.item('alpha', 1)!.accepted)
  })

  test('missing, injected and already delivered legacy work cannot acquire queued metadata', async () => {
    seedQueue(dir, [accepted(), { v: 1, kind: 'fixed', seq: 1, parts: ['complete'] }, deliveredRecord()])
    const q = await open()
    expect((await q.accept('alpha', injectedInput())).status).toBe('accepted')
    const bytes = fs.readFileSync(queuePath(dir))
    for (const seq of [1, 2, 999]) expect(await q.rememberQueuedReaction('alpha', seq, 'custom_queue')).toBeUndefined()
    expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
  })

  test('adoption reconciles a failed append rollback without reviving its bytes or changing FIFO identity', async () => {
    const clock = createFakeClock({ start: 1000 })
    let failing = false
    const truncations: number[] = []
    const seam = durableIo({ base: { ...fs,
      ftruncateSync(fd: number, length = 0) {
        if (failing) throw new Error('EIO rollback')
        truncations.push(length)
        fs.ftruncateSync(fd, length)
      },
    } as typeof fs, before(step) {
      if (failing && step.op === 'fsync' && fs.fstatSync(step.fd!).isFile()) throw new Error('EIO append sync')
    } }).fs
    seedQueue(dir, [accepted(), { v: 1, kind: 'fixed', seq: 1, parts: ['first', 'second'] }, sentRecord(), deliveredRecord()])
    const q = await open({ fs: seam, now: clock.now }), before = q.item('alpha', 1)!
    const boundary = fs.statSync(queuePath(dir)).size
    failing = true
    await expect(q.append('alpha', { v: 1, kind: 'noticed', seq: 1, at: 1000 })).rejects.toThrow('EIO append sync')
    expect(fs.statSync(queuePath(dir)).size).toBeGreaterThan(boundary)
    failing = false
    expect(await q.rememberQueuedReaction('alpha', 1, 'original_queue')).toBe('original_queue')
    expect(truncations).toEqual([boundary])
    expect(readQueue(dir).some(r => r.kind === 'noticed')).toBe(false)
    expect(q.item('alpha', 1)!.records.filter(r => r.kind !== 'accepted')).toEqual(before.records.filter(r => r.kind !== 'accepted'))
    await q.append('alpha', { ...deliveredRecord(), part: 2 })
    expect(q.isWritable!('alpha')).toBe(true)
    expect(q.openCount('alpha')).toBe(0)
    expect(await q.accept('alpha', injectedInput())).toMatchObject({ status: 'accepted', seq: 2 })
    await q.stop()
    const replay = await open({ now: clock.now })
    expect(replay.items('alpha').map(item => item.accepted.seq)).toEqual([2])
    expect(replay.lookupSlackKey('alpha', slackInput().key!)).toEqual({ status: 'duplicate', seq: 1 })
  })

  test.each(['write', 'fsync', 'rename', 'directory-sync'] as const)('failed %s while adopting legacy work permits no queued Slack mutation; recovery retries durably', async step => {
    let failing = false, failures = 0
    const seam = durableIo({ base: { ...fs,
      writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) {
        if (failing && step === 'write') { failures++; throw new Error('EIO metadata write') }
        return fs.writeSync(fd, buffer, offset, length, position)
      },
    } as typeof fs, before(durable) {
      if (!failing) return
      if (durable.op === 'rename') {
        if (step === 'rename') { failures++; throw new Error('EIO metadata rename') }
        return
      }
      const stat = fs.fstatSync(durable.fd!)
      if ((step === 'fsync' && stat.isFile()) || (step === 'directory-sync' && stat.isDirectory())) { failures++; throw new Error('EIO metadata fsync') }
    } }).fs
    seedQueue(dir, [accepted()])
    const q = await open({ fs: seam }), slack = makeStubSlack()
    const item = q.item('alpha', 1)!, bytes = fs.readFileSync(queuePath(dir))
    const queued = createQueuedAckCallback({ queue: q, getReaction: () => 'custom_queue', clientFor: () => slack.web })
    failing = true
    await queued('alpha', item)
    expect(failures).toBe(1)
    expect(slack.callLog).toEqual([])
    expect(q.item('alpha', 1)).toEqual(item)
    expect(q.isWritable!('alpha')).toBe(true)
    // Directory sync can fail after rename; the candidate bytes are not proof
    // of durable adoption and still must not permit a Slack mutation.
    if (step !== 'directory-sync') expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
    failing = false
    await queued('alpha', item)
    expect(slack.calls.reactionsAdd).toEqual([{ channel: item.accepted.channel!, timestamp: item.accepted.ts, name: 'custom_queue' }])
    expect(slack.calls.reactionsRemove).toEqual([])
    await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['still deliverable'] })
    await q.stop()
    expect((await open()).item('alpha', 1)!.accepted.queued_ack_reaction).toBe('custom_queue')
    assertNoLeak(slack.callLog)
  })
})
test('real file acceptance fsyncs file and new directory, enforces permissions and survives restart', async () => {
  const { fs: seam, synced } = recordSyncs()
  const q = await open({ fs: seam }); const result = await q.accept('alpha', slackInput())
  expect(result.status).toBe('accepted')
  expect(synced).toContain(queuePath(dir)); expect(synced).toContain(join(dir, 'queue')); expect(synced).toContain(dir)
  expect(fs.statSync(join(dir, 'queue')).mode & 0o777).toBe(QUEUE_DIRECTORY_MODE)
  expect(fs.statSync(queuePath(dir)).mode & 0o777).toBe(QUEUE_FILE_MODE)
  await q.stop(); const replay = await open(); expect(replay.items('alpha')[0]!.accepted.text).toBe('message')
})
test("reuses a durably synced parent; a journal's creating acceptance syncs it and the queue directory, its later appends only the journal", async () => {
  const sync = recordSyncs(), queueDir = join(dir, 'queue')
  const q = await open({ fs: sync.fs })
  expect(sync.synced).toEqual([dir])
  expect((await q.accept('alpha', injectedInput())).status).toBe('accepted')
  await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['fixed'] })
  expect((await q.accept('beta', injectedInput())).status).toBe('accepted')
  expect(sync.synced).toEqual([dir, queuePath(dir), queueDir, queuePath(dir), queuePath(dir, 'beta'), queueDir])
  await q.stop()
  const replay = await open({ fs: sync.fs })
  expect(sync.synced.filter(path => path === dir)).toHaveLength(2)
  expect(replay.item('alpha', 1)!.fixed!.parts).toEqual(['fixed'])
  expect(replay.openCount('alpha')).toBe(1)
  expect(replay.openCount('beta')).toBe(1)
})
test.each(['mode correction', 'directory replacement', 'same-inode directory recreation'] as const)('%s retries two failed parent syncs before publishing acceptance or reusing directory identity', async change => {
  const sync = recordSyncs(), queueDir = join(dir, 'queue')
  // A setgid scratch parent would make recreation exercise mode correction instead.
  if (change === 'same-inode directory recreation') fs.chmodSync(dir, QUEUE_DIRECTORY_MODE)
  let originalIdentity: { dev: number; ino: number } | undefined
  const seam = { ...sync.fs,
    statSync(path: fs.PathLike) {
      const stat = fs.statSync(path)
      if (change === 'same-inode directory recreation' && String(path) === queueDir) {
        originalIdentity ??= { dev: stat.dev, ino: stat.ino }
        // Deterministically model the filesystem reusing the removed directory's inode.
        Object.assign(stat, originalIdentity)
      }
      return stat
    },
  } as typeof fs
  const q = await open({ fs: seam })
  if (change === 'mode correction') fs.chmodSync(queueDir, 0o755)
  else if (change === 'same-inode directory recreation') fs.rmdirSync(queueDir)
  else {
    fs.renameSync(queueDir, join(dir, 'old-queue'))
    fs.mkdirSync(queueDir, { mode: QUEUE_DIRECTORY_MODE })
  }
  sync.fail(dir)
  for (let retry = 0; retry < 2; retry++) {
    expect((await q.accept('alpha', slackInput())).status).toBe('failed')
    expect(q.items('alpha')).toEqual([])
    expect(q.item('alpha', 1)).toBeUndefined()
    expect(q.openCount('alpha')).toBe(0)
    expect(q.lookupSlackKey('alpha', slackInput().key!)).toBeUndefined()
    expect(fs.existsSync(queuePath(dir))).toBe(false)
  }
  expect(sync.synced).toEqual([dir, dir, dir])
  sync.fail()
  expect(await q.accept('alpha', slackInput())).toMatchObject({ status: 'accepted', seq: 1 })
  expect(sync.synced).toEqual([dir, dir, dir, dir, queuePath(dir), queueDir])
  expect(fs.statSync(queueDir).mode & 0o7777).toBe(QUEUE_DIRECTORY_MODE)
  expect((await q.accept('beta', injectedInput())).status).toBe('accepted')
  expect(sync.synced.filter(path => path === dir)).toHaveLength(4)
  await q.stop()
  const replay = await open()
  expect(replay.openCount('alpha')).toBe(1)
  expect(replay.lookupSlackKey('alpha', slackInput().key!)).toMatchObject({ status: 'duplicate', seq: 1 })
})
test("queue-directory sync failures publish neither new Slack keys nor completed delivery summaries until retry succeeds, at a journal's creation and at its first opening after a failed start rewrite", async () => {
  const sync = recordSyncs(), queueDir = join(dir, 'queue')
  let q = await open({ fs: sync.fs })
  sync.fail(queueDir)
  for (let retry = 0; retry < 2; retry++) {
    expect((await q.accept('alpha', slackInput())).status).toBe('failed')
    expect(q.items('alpha')).toEqual([])
    expect(q.openCount('alpha')).toBe(0)
    expect(q.lookupSlackKey('alpha', slackInput().key!)).toBeUndefined()
    expect(readQueue(dir)).toEqual([])
  }
  sync.fail()
  expect(await q.accept('alpha', slackInput())).toMatchObject({ status: 'accepted', seq: 1 })
  await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['fixed'] })
  // The restart's load is the journal's first opening; its rewrite then fails
  // before the rename, so no directory sync has followed that opening.
  await q.stop()
  sync.fail(path => path.endsWith('.tmp'))
  q = await open({ fs: sync.fs })
  const before = q.item('alpha', 1)!
  sync.fail(queueDir)
  for (let retry = 0; retry < 2; retry++) {
    await expect(q.append('alpha', deliveredRecord())).rejects.toThrow('EIO injected sync')
    expect(q.item('alpha', 1)).toEqual(before)
    expect(q.lookupSlackKey('alpha', slackInput().key!)).toEqual({ status: 'duplicate', seq: 1, item: before })
    expect(q.openCount('alpha')).toBe(1)
    expect(readQueue(dir).map(record => record.kind)).toEqual(['accepted', 'fixed'])
  }
  sync.fail()
  await q.append('alpha', deliveredRecord())
  expect(q.item('alpha', 1)!.delivered).toBe(true)
  expect(q.openCount('alpha')).toBe(0)
  expect(sync.synced.filter(path => path === dir)).toHaveLength(2)
  expect(sync.synced.filter(path => path.endsWith('.tmp'))).toHaveLength(1)
  // Three creating acceptances and three appends after the restart; the fixed append syncs only its journal.
  expect(sync.synced.filter(path => path === queueDir)).toHaveLength(6)
  // Four failed appends each sync their rollback as well as their candidate.
  expect(sync.synced.filter(path => path === queuePath(dir))).toHaveLength(11)
  await q.stop()
  const replay = await open()
  expect(replay.openCount('alpha')).toBe(0)
  expect(replay.lookupSlackKey('alpha', slackInput().key!)).toEqual({ status: 'duplicate', seq: 1 })
})
test('failed fsync never accepts; successful retry reconciles bytes and gets the same first sequence', async () => {
  let fail = false
  const seam = failFileSyncs(() => fail, 'EIO')
  const q = await open({ fs: seam }); fail = true
  expect((await q.accept('alpha', slackInput())).status).toBe('failed'); expect(q.items('alpha')).toEqual([])
  fail = false
  expect(await q.accept('alpha', slackInput())).toMatchObject({ status: 'accepted', seq: 1 })
  expect(readQueue(dir).filter(r => r.kind === 'accepted' && !('compact' in r))).toHaveLength(1)
  await q.stop(); expect((await open()).items('alpha')).toHaveLength(1)
})
test('one writer serializes mixed sources and concurrent compaction without losing accepts', async () => {
  const q = await open(); await Promise.all(Array.from({ length: 60 }, (_, i) => i % 3 === 0 ? q.compact('alpha') : q.accept('alpha', injectedInput({ source: i % 2 ? 'cron' : 'interject', text: String(i) }))))
  const before = q.items('alpha'); expect(before).toHaveLength(40)
  expect(before.map(i => i.accepted.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
  await q.stop(); expect((await open()).items('alpha').map(i => [i.accepted.seq, i.accepted.text, i.accepted.source, i.accepted.ts])).toEqual(before.map(i => [i.accepted.seq, i.accepted.text, i.accepted.source, i.accepted.ts]))
})
test('Slack key includes edits and survives compaction/restart; injected repeats never coalesce', async () => {
  const clock = createFakeClock({ start: 1000 }); const q = await open({ now: clock.now })
  expect((await q.accept('alpha', slackInput())).status).toBe('accepted')
  expect((await q.accept('alpha', slackInput())).status).toBe('duplicate')
  expect((await q.accept('alpha', slackInput({ key: { chat_id: 'C0TEST001', ts: '1700000000.000001', edited_ts: 'edit' } }))).status).toBe('accepted')
  await q.accept('alpha', injectedInput()); await q.accept('alpha', injectedInput({ source: 'cron' }))
  const timestamps = q.items('alpha').slice(2).map(i => i.accepted.ts); expect(timestamps[1]! > timestamps[0]!).toBe(true)
  await q.stop(); const replay = await open({ now: clock.now }); expect((await replay.accept('alpha', slackInput())).status).toBe('duplicate'); expect(replay.openCount('alpha')).toBe(4)
})
test.each([999, 1000])('injected timestamp and sequence allocation survive delivered-text removal and restart clock %i', async restartAt => {
  const q = await open({ now: () => 1000 }); await q.accept('alpha', injectedInput())
  const ts = q.items('alpha')[0]!.accepted.ts
  await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['secret-delivered'] }); await q.append('alpha', deliveredRecord()); await q.compact(); await q.stop()
  expect(fs.readFileSync(queuePath(dir), 'utf8')).not.toContain('secret-delivered')
  const replay = await open({ now: () => restartAt }); expect(await replay.accept('alpha', injectedInput())).toMatchObject({ status: 'accepted', seq: 2 })
  expect(replay.items('alpha')[0]!.accepted.ts > ts).toBe(true)
  expect(new Set(readQueue(dir).map(r => r.kind))).toEqual(new Set(['accepted']))
})
test('open fixed bytes never expire; sent is not delivered; only refused send pairs compact and attempts remain stable', async () => {
  const clock = createFakeClock({ start: 1000 }); const q = await open({ now: clock.now }); await q.accept('alpha', injectedInput())
  await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['exact\nbytes🙂'] })
  await q.append('alpha', sentRecord(1, 1, 'retype')); await q.append('alpha', { v: 1, kind: 'refused', seq: 1, attempt: 1, at: 1000 })
  await q.append('alpha', sentRecord(1, 2, 'retype')); await clock.advance(3 * QUEUE_KEY_KEEP_MS); await q.compact(); await q.stop()
  const replay = await open({ now: clock.now }); const item = replay.items('alpha')[0]!
  expect(item.fixed!.parts).toEqual(['exact\nbytes🙂']); expect(item.delivered).toBe(false); expect(item.retypeCount).toBe(1); expect(item.nextAttempt).toBe(3)
  expect(item.records.filter(r => r.kind === 'sent')).toHaveLength(1)
  await expect(replay.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['changed'] })).rejects.toThrow('immutable')
})
test('live summaries preserve multipart delivery counts, refused retypes and unknown attempts through repeated compaction and reload', async () => {
  const edited = slackInput({ key: { ...slackInput().key!, edited_ts: 'edit' } })
  let q = await open({ now: () => 1000 })
  await q.accept('alpha', slackInput())
  await q.accept('alpha', injectedInput())
  await q.accept('alpha', edited)
  await q.accept('beta', injectedInput())
  await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['one', 'two'] })
  await q.append('alpha', sentRecord(1, 1, 'retype'))
  expect(q.item('alpha', 1)!.retypeCount).toBe(1)
  await q.append('alpha', { v: 1, kind: 'refused', seq: 1, attempt: 1, at: 1000 })
  expect(q.item('alpha', 1)).toMatchObject({ retypeCount: 0, nextAttempt: 2 })
  await q.append('alpha', sentRecord(1, 2, 'retype'))
  await q.append('alpha', deliveredRecord())
  expect(q.item('alpha', 1)).toMatchObject({ delivered: false, retypeCount: 1, nextAttempt: 3 })
  expect(q.openCount('alpha')).toBe(3)
  await q.append('alpha', { ...deliveredRecord(), part: 2 })
  expect(q.openCount('alpha')).toBe(2)
  await q.append('alpha', { ...deliveredRecord(), part: 2 })
  await q.append('alpha', { v: 1, kind: 'noticed', seq: 1, at: 1000 })
  expect(q.openCount('alpha')).toBe(2)
  expect(q.item('alpha', 1)).toMatchObject({ delivered: true, retypeCount: 1, nextAttempt: 3 })
  await q.append('alpha', sentRecord(2, 7, 'retype'))
  await q.append('alpha', { v: 1, kind: 'refused', seq: 2, attempt: 7, at: 1000 })
  await q.append('alpha', { v: 1, kind: 'sent', seq: 3, attempt: 3, unknown_outcome: true, at: 1000, quarantine: { path: join(dir, 'unknown'), line: 1 } })
  expect(q.items('alpha').map(item => [item.accepted.seq, item.delivered, item.unknownSend, item.retypeCount, item.nextAttempt])).toEqual([
    [1, true, false, 1, 3], [2, false, false, 0, 8], [3, false, true, 0, 4],
  ])
  expect(q.lookupSlackKey('alpha', edited.key!)).toEqual({ status: 'duplicate', seq: 3, item: q.item('alpha', 3) })
  for (let cycle = 0; cycle < 3; cycle++) {
    await q.compact('alpha')
    await q.stop()
    q = await open({ now: () => 1000 })
    const items = q.items('alpha')
    expect(items.map(item => [item.accepted.seq, item.delivered, item.unknownSend, item.retypeCount, item.nextAttempt])).toEqual([
      [2, false, false, 0, 8], [3, false, true, 0, 4],
    ])
    expect(q.openCount('alpha')).toBe(2)
    expect(q.openCount('beta')).toBe(1)
    for (const item of items) expect(q.item('alpha', item.accepted.seq)).toEqual(item)
    expect(q.item('alpha', 1)).toBeUndefined()
    expect(q.lookupSlackKey('alpha', slackInput().key!)).toEqual({ status: 'duplicate', seq: 1 })
    expect(q.lookupSlackKey('alpha', edited.key!)).toEqual({ status: 'duplicate', seq: 3, item: items[1] })
    expect(await q.accept('alpha', edited)).toEqual({ status: 'duplicate', seq: 3, item: items[1] })
    await expect(q.append('alpha', sentRecord(2, 7, 'retype'))).rejects.toThrow('Attempt number must increase')
  }
  expect(await q.accept('alpha', injectedInput())).toMatchObject({ status: 'accepted', seq: 4 })
  expect(q.items('alpha').map(item => item.accepted.seq)).toEqual([2, 3, 4])
  expect(q.openCount('alpha')).toBe(3)
  expect(q.openCount('beta')).toBe(1)
})
test('delivered Slack tombstone survives compaction and restart until received_at retention expires without restoring content', async () => {
  const clock = createFakeClock({ start: 1000 }); const q = await open({ now: clock.now }); await q.accept('alpha', slackInput({ text: 'private delivered content' }))
  await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['private fixed content'] }); await q.append('alpha', deliveredRecord()); await q.compact()
  expect(fs.readFileSync(queuePath(dir), 'utf8')).not.toContain('private'); await q.stop()
  const replay = await open({ now: clock.now })
  expect(replay.items('alpha')).toEqual([]); expect(replay.lookupSlackKey('alpha', slackInput().key!)).toMatchObject({ status: 'duplicate', seq: 1 })
  await clock.advance(QUEUE_KEY_KEEP_MS - 1)
  expect(await replay.accept('alpha', slackInput({ text: 'private retry content' }))).toEqual({ status: 'duplicate', seq: 1 })
  expect(replay.items('alpha')).toEqual([]); expect(fs.readFileSync(queuePath(dir), 'utf8')).not.toContain('private')
  await clock.advance(1); await replay.compact(); expect(replay.lookupSlackKey('alpha', slackInput().key!)).toBeUndefined(); await replay.stop()
  const expired = await open({ now: clock.now })
  expect(expired.items('alpha')).toEqual([]); expect(expired.lookupSlackKey('alpha', slackInput().key!)).toBeUndefined()
  expect(fs.readFileSync(queuePath(dir), 'utf8')).not.toContain('private')
  expect(await expired.accept('alpha', slackInput({ text: 'fresh after expiry' }))).toMatchObject({ status: 'accepted', seq: 2 })
  expect(expired.items('alpha').map(item => item.accepted.text)).toEqual(['fresh after expiry'])
  expect(fs.readFileSync(queuePath(dir), 'utf8')).not.toContain('private')
})
test('startup reads beyond reload size cap and retains every complete accepted record', async () => {
  const records = Array.from({ length: 90 }, (_, i) => ({ ...accepted(), seq: i + 1, text: 'x'.repeat(MAX_RELOAD_FILE_BYTES / 40) } as QueueRecord)); seedQueue(dir, records)
  expect(fs.statSync(queuePath(dir)).size).toBeGreaterThan(MAX_RELOAD_FILE_BYTES)
  const q = await open(); expect(q.items('alpha')).toHaveLength(records.length); expect(q.items('alpha').at(-1)!.accepted.seq).toBe(90)
})
test('quarantines exact torn/middle/orphan bytes; damaged sent is unknown and survives another restart', async () => {
  const events: QueueEvent[] = []; const bad = '{"kind":"sent","seq":1,"attempt":1,"broken":true}\n'; const torn = '{"kind":"accepted","seq":3'
  const orphan = JSON.stringify({ v: 1, kind: 'fixed', seq: 99, parts: ['orphan'] }) + '\n'
  seedQueue(dir, [accepted(), bad, orphan, torn]); const q = await open({ onEvent: e => events.push(e) })
  expect(q.items('alpha')).toHaveLength(1); expect(q.items('alpha')[0]!.unknownSend).toBe(true)
  const unreadable = events.filter((e): e is Extract<QueueEvent, { type: 'record-unreadable' }> => e.type === 'record-unreadable')
  expect(unreadable.map(e => [e.line, e.alert])).toEqual([[2, false], [3, false], [4, false]])
  expect(fs.readFileSync(unreadable[0]!.quarantinePath, 'utf8')).toBe(bad + orphan + torn)
  await q.stop(); const replay = await open(); expect(replay.items('alpha')[0]!.unknownSend).toBe(true); expect(replay.items('alpha')[0]!.nextAttempt).toBe(2); expect(replay.items('alpha')[0]!.records.filter(r => r.kind === 'sent')).toMatchObject([{ attempt: 1, unknown_outcome: true }])
})

test('quarantines an array-valued source as record-unreadable instead of replaying live work', async () => {
  const events: QueueEvent[] = []
  const malformed = JSON.stringify({ ...accepted(), ...injectedInput(), source: ['interject'], key: undefined }) + '\n'
  seedQueue(dir, [malformed])
  const q = await open({ onEvent: event => events.push(event) })
  expect(q.items('alpha')).toEqual([])
  expect(q.openCount('alpha')).toBe(0)
  const unreadable = events.filter((event): event is Extract<QueueEvent, { type: 'record-unreadable' }> => event.type === 'record-unreadable')
  expect(unreadable).toMatchObject([{ key: 'alpha', line: 1 }])
  expect(fs.readFileSync(unreadable[0]!.quarantinePath, 'utf8')).toBe(malformed)
  expect(readQueue(dir).some(record => record.kind === 'accepted' && !('compact' in record))).toBe(false)
  await q.stop()
  expect((await open()).items('alpha')).toEqual([])
})

describe('append validation refusals', () => {
  test.each(['not started', 'stopped'] as const)('%s queue rejects append without reporting a storage failure', async state => {
    const events: QueueEvent[] = []
    const q = createDeliveryQueue({ stateDir: dir, onEvent: event => events.push(event) })
    queues.push(q)
    if (state === 'stopped') { await q.start(); await q.stop() }
    await expect(q.append('alpha', sentRecord())).rejects.toThrow('Queue is not writable')
    expect(q.isWritable!('alpha')).toBe(true)
    expect(events.filter(event => event.type === 'append-failed')).toEqual([])
    expect(fs.existsSync(queuePath(dir))).toBe(false)
  })

  test.each([
    ['unknown sequence', sentRecord(99), 'Append has no accepted item'],
    ['refusal without a send', { v: 1, kind: 'refused', seq: 1, attempt: 1, at: 1000 }, 'Refusal has no sent attempt'],
    ['invalid send kind', { ...sentRecord(), send_kind: 'bogus' }, 'Invalid append record'],
  ] as const)('%s leaves the queue writable without append-failed', async (_, record, message) => {
    const events: QueueEvent[] = []
    const q = await open({ onEvent: event => events.push(event) })
    expect(await q.accept('alpha', injectedInput())).toMatchObject({ status: 'accepted', seq: 1 })
    const bytes = fs.readFileSync(queuePath(dir)), item = q.item('alpha', 1)
    // Exercise validation at the untyped public boundary, as with journal input.
    await expect(q.append('alpha', record as QueueRecord)).rejects.toThrow(message)
    expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
    expect(q.item('alpha', 1)).toEqual(item)
    expect(q.isWritable!('alpha')).toBe(true)
    expect(events.filter(event => event.type === 'append-failed')).toEqual([])
    await q.compact('alpha')
    expect(q.isWritable!('alpha')).toBe(true)
    await q.append('alpha', sentRecord())
    expect(q.isWritable!('alpha')).toBe(true)
    expect(events.map(event => event.type)).toEqual(['stored'])
    await q.stop()
    expect((await open()).item('alpha', 1)!.records.filter(record => record.kind === 'sent')).toEqual([sentRecord()])
  })

  test('validation refusal preserves an existing storage failure until a valid append succeeds', async () => {
    let fail = false
    const events: QueueEvent[] = []
    // The journal waits for fsync on the I/O pool; the seam fails a queue file's fsync in either form.
    const seam = durableIo({ before(step) { if (step.op === 'fsync' && fail && fs.fstatSync(step.fd!).isFile()) throw new Error('EIO append sync') } }).fs
    const q = await open({ fs: seam, onEvent: event => events.push(event) })
    await q.accept('alpha', injectedInput())
    fail = true
    await expect(q.append('alpha', sentRecord())).rejects.toThrow('EIO append sync')
    expect(q.isWritable!('alpha')).toBe(false)
    fail = false
    await expect(q.append('alpha', sentRecord(99))).rejects.toThrow('Append has no accepted item')
    expect(q.isWritable!('alpha')).toBe(false)
    expect(events.filter(event => event.type === 'append-failed')).toHaveLength(1)
    expect(events.filter(event => event.type === 'writable')).toEqual([])
    await q.append('alpha', sentRecord())
    expect(q.isWritable!('alpha')).toBe(true)
    expect(events.filter(event => event.type === 'writable')).toEqual([{ type: 'writable', key: 'alpha' }])
    expect(q.item('alpha', 1)!.records.filter(record => record.kind === 'sent')).toEqual([sentRecord()])
  })

  test('identical fixed retry writes nothing and preserves an existing storage failure', async () => {
    let fail = false
    const events: QueueEvent[] = []
    // The journal waits for fsync on the I/O pool; the seam fails a queue file's fsync in either form.
    const seam = durableIo({ before(step) { if (step.op === 'fsync' && fail && fs.fstatSync(step.fd!).isFile()) throw new Error('EIO append sync') } }).fs
    const q = await open({ fs: seam, onEvent: event => events.push(event) })
    await q.accept('alpha', injectedInput())
    const fixed: QueueRecord = { v: 1, kind: 'fixed', seq: 1, parts: ['fixed bytes'] }
    await q.append('alpha', fixed)
    fail = true
    await expect(q.append('alpha', sentRecord())).rejects.toThrow('EIO append sync')
    fail = false
    const bytes = fs.readFileSync(queuePath(dir))
    await q.append('alpha', fixed)
    expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
    expect(q.isWritable!('alpha')).toBe(false)
    expect(events.filter(event => event.type === 'writable')).toEqual([])
    await q.append('alpha', sentRecord())
    expect(q.isWritable!('alpha')).toBe(true)
    expect(events.filter(event => event.type === 'writable')).toEqual([{ type: 'writable', key: 'alpha' }])
  })

  test('journal load failure still blocks append until storage recovers', async () => {
    seedQueue(dir, [accepted()])
    let fail = true
    const events: QueueEvent[] = []
    const seam = { ...fs, readFileSync(path: fs.PathOrFileDescriptor, ...args: unknown[]) {
      if (fail && String(path) === queuePath(dir)) throw new Error('EIO journal read')
      return (fs.readFileSync as Function)(path, ...args)
    } } as typeof fs
    const q = await open({ fs: seam, onEvent: event => events.push(event) })
    await expect(q.append('alpha', sentRecord())).rejects.toThrow('EIO journal read')
    expect(q.isWritable!('alpha')).toBe(false)
    expect(events.filter(event => event.type === 'append-failed')).toMatchObject([{ key: 'alpha', seq: 1, path: queuePath(dir) }])
    fail = false
    await q.append('alpha', sentRecord())
    expect(q.isWritable!('alpha')).toBe(true)
    expect(events.filter(event => event.type === 'writable')).toEqual([{ type: 'writable', key: 'alpha' }])
  })
})

describe('b.2is torn-tail recovery', () => {
  const first: AcceptedRecord = { ...injectedInput({ text: 'first 🙂' }), v: 1, kind: 'accepted', seq: 1, received_at: 1000, ts: '1.000000' }
  const tail = '{"v":1,"kind":"accepted","seq":3,"text":"torn 🙂'
  const copies = () => fs.readdirSync(join(dir, 'queue')).filter(name => name.startsWith('alpha.unreadable-')).sort()
  const findings = (q: DeliveryQueue) => q.startupFindings().filter((e): e is Extract<QueueEvent, { type: 'record-unreadable' }> => e.type === 'record-unreadable')
  const recover = (options: Parameters<typeof open>[0] = {}) => open({ now: createFakeClock({ start: 1000 }).now, ...options })

  test.each([
    ['temp-open', 'accept'], ['temp-write', 'accept'], ['file-fsync', 'accept'], ['rename', 'accept'],
    ['directory-fsync', 'accept'], ['directory-fsync', 'reopen'],
  ] as const)('failed recovery rewrite %s preserves send evidence until durable recovery by %s', async (failure, retryBy) => {
    const originalAccepted = { ...accepted(), text: first.text }
    const fixed: QueueRecord = { v: 1, kind: 'fixed', seq: 1, parts: ['fixed 🙂'] }
    const torn = '{"v":1,"kind":"sent","seq":1,"attempt":7,"text":"torn 🙂'
    seedQueue(dir, [originalAccepted, fixed, torn])
    seedQueue(dir, [first], 'beta')
    const original = fs.readFileSync(queuePath(dir))
    const paths = new Map<number, string>()
    let fail = true, failures = 0, renames = 0, syncingRename = false
    const rewriteTemp = (fd: number) => paths.get(fd)?.startsWith(queuePath(dir) + '.') === true && paths.get(fd)!.endsWith('.tmp')
    const fault = () => { failures++; throw new Error('EIO recovery rewrite ' + failure) }
    const seam = durableIo({ base: {
      ...fs,
      openSync(...args: Parameters<typeof fs.openSync>) {
        if (fail && failure === 'temp-open' && String(args[0]).startsWith(queuePath(dir) + '.') && String(args[0]).endsWith('.tmp')) fault()
        const fd = fs.openSync(...args); paths.set(fd, String(args[0])); return fd
      },
      writeSync(fd: number, bytes: Uint8Array, offset: number, length: number) {
        if (fail && failure === 'temp-write' && rewriteTemp(fd)) {
          fs.writeSync(fd, bytes, offset, Math.min(7, length))
          fault()
        }
        return fs.writeSync(fd, bytes, offset, length)
      },
    } as typeof fs, before(step) {
      if (step.op === 'rename') {
        if (fail && failure === 'rename' && step.to === queuePath(dir)) fault()
        // The rename's callback follows this hook; it has happened before the next sync.
        if (step.to === queuePath(dir)) { renames++; syncingRename = true }
        return
      }
      // Quarantine must have synced successfully; fail only the directory
      // durability boundary after the replacement journal has been renamed.
      if (fail && failure === 'file-fsync' && rewriteTemp(step.fd!)) fault()
      if (syncingRename && step.path === join(dir, 'queue')) {
        syncingRename = false
        if (fail && failure === 'directory-fsync') fault()
      }
    } }).fs
    const events: QueueEvent[] = []
    let q = await recover({ fs: seam, onEvent: event => { events.push(event) } })
    expect(failures).toBe(1)
    const initial = findings(q)
    expect(initial).toMatchObject([{ key: 'alpha', line: 3, alert: false }])
    const quarantinePath = initial[0]!.quarantinePath
    const quarantines = copies()
    expect(quarantines).toHaveLength(1)
    const unknown: Extract<QueueRecord, { kind: 'sent' }> = { v: 1, kind: 'sent', seq: 1, attempt: 7, unknown_outcome: true, at: originalAccepted.received_at, quarantine: { path: quarantinePath, line: 3 } }
    // Pending repair of alpha must not block a healthy persona's writes.
    expect(await q.accept('beta', injectedInput({ text: 'healthy' }))).toMatchObject({ status: 'accepted', seq: 2 })
    for (let retry = 0; retry < 2; retry++) {
      expect(await q.accept('alpha', injectedInput({ text: 'must not be accepted' }))).toMatchObject({ status: 'failed' })
      expect(failures).toBe(retry + 2)
      expect(q.isWritable!('alpha')).toBe(false)
      // Durable quarantine exposes the complete replay for recovery consumers,
      // including dedupe and unknown-send facts, but authorizes no mutation.
      expect(q.items('alpha')).toMatchObject([{ accepted: originalAccepted, fixed, unknownSend: true, nextAttempt: 8, delivered: false }])
      expect(q.item('alpha', 1)!.records).toEqual([originalAccepted, fixed, unknown])
      expect(q.lookupSlackKey('alpha', originalAccepted.key!)).toMatchObject({ status: 'duplicate', seq: 1 })
      expect(findings(q)).toEqual(initial)
      expect(copies()).toEqual(quarantines)
      expect(fs.readFileSync(quarantinePath)).toEqual(Buffer.from(torn))
      expect(fs.readdirSync(join(dir, 'queue')).filter(name => name.endsWith('.tmp'))).toEqual([])
      if (failure === 'directory-fsync') {
        expect(renames).toBeGreaterThan(0)
        // Visible replacement bytes do not authorize writes before dir fsync.
        expect(readQueue(dir).filter(r => r.kind === 'sent')).toEqual([unknown])
        expect(readQueue(dir).filter(r => r.kind === 'accepted')).toEqual([originalAccepted])
      } else {
        expect(renames).toBe(0)
        expect(fs.readFileSync(queuePath(dir))).toEqual(original)
      }
    }
    expect(events.filter(e => e.type === 'recovery-failed')).toHaveLength(3)
    fail = false
    if (retryBy === 'reopen') {
      // A new process has no pending in-memory replay: the renamed journal
      // itself must retain uncertainty and its original quarantine reference.
      await q.stop()
      q = await recover()
      expect(findings(q)).toEqual([])
    }
    expect(await q.accept('alpha', injectedInput({ text: 'second' }))).toMatchObject({ status: 'accepted', seq: 2 })
    expect(q.isWritable!('alpha')).toBe(true)
    expect(q.lookupSlackKey('alpha', originalAccepted.key!)).toMatchObject({ status: 'duplicate', seq: 1 })
    expect(q.item('alpha', 1)).toMatchObject({ accepted: originalAccepted, fixed, unknownSend: true, nextAttempt: 8, delivered: false })
    expect(q.item('alpha', 1)!.records.filter(r => r.kind === 'sent')).toEqual([unknown])
    expect(readQueue(dir).filter(r => r.kind === 'sent')).toEqual([unknown])
    await q.stop()
    const replay = await recover()
    expect(replay.items('alpha').map(i => [i.accepted.seq, i.accepted.text])).toEqual([[1, originalAccepted.text], [2, 'second']])
    expect(replay.item('alpha', 1)).toMatchObject({ accepted: originalAccepted, fixed, unknownSend: true, nextAttempt: 8, delivered: false })
    expect(replay.item('alpha', 1)!.records.filter(r => r.kind === 'sent')).toEqual([unknown])
    expect(findings(replay)).toEqual([])
    expect(copies()).toEqual(quarantines)
    expect(fs.readFileSync(quarantinePath)).toEqual(Buffer.from(torn))
  })

  test.each([['successful', false], ['failed', true]] as const)('quarantines once across append/restart after a %s startup rewrite', async (_, failRewrite) => {
    // The ticket's exact fragment; the valid prefix also checks byte offsets after UTF-8.
    const torn = '{"v":1,"kind":"accepted","seq":3,'
    seedQueue(dir, [first, torn])
    let fail = failRewrite, rewriteFailures = 0
    const seam = { ...fs, openSync(...args: Parameters<typeof fs.openSync>) {
      if (fail && String(args[0]).endsWith('.tmp') && args[1] === 'wx') {
        rewriteFailures++
        throw Object.assign(new Error('injected ENOSPC opening rewrite temp'), { code: 'ENOSPC' })
      }
      return fs.openSync(...args)
    } } as typeof fs
    const q = await recover({ fs: seam })
    expect(rewriteFailures).toBe(failRewrite ? 1 : 0)
    const initial = findings(q)
    expect(initial).toMatchObject([{ key: 'alpha', line: 2, alert: false }])
    expect(fs.readFileSync(initial[0]!.quarantinePath)).toEqual(Buffer.from(torn))
    fail = false
    expect(await q.accept('alpha', injectedInput({ text: 'second' }))).toMatchObject({ status: 'accepted', seq: 2 })
    await q.stop()
    const replay = await recover()
    expect(replay.items('alpha').map(i => [i.accepted.seq, i.accepted.text])).toEqual([[1, first.text], [2, 'second']])
    expect(findings(replay)).toEqual([])
    expect(copies()).toEqual([initial[0]!.quarantinePath.split('/').at(-1)!])
    expect(fs.readFileSync(initial[0]!.quarantinePath)).toEqual(Buffer.from(torn))
  })

  test.each(['write', 'file-sync', 'directory-sync'] as const)('failed quarantine %s leaves the source intact and retries without copying the tail twice', async failure => {
    seedQueue(dir, [first, tail])
    const original = fs.readFileSync(queuePath(dir))
    let fail = true, failures = 0
    const paths = new Map<number, string>()
    const quarantine = (fd: number) => paths.get(fd)?.includes('.unreadable-') === true
    const seam = durableIo({ base: {
      ...fs,
      openSync(...args: Parameters<typeof fs.openSync>) { const fd = fs.openSync(...args); paths.set(fd, String(args[0])); return fd },
      writeSync(fd: number, bytes: Uint8Array, offset: number, length: number) {
        if (fail && quarantine(fd) && failure === 'write') {
          fs.writeSync(fd, bytes, offset, Math.min(7, length))
          failures++
          throw new Error('EIO partial quarantine write')
        }
        return fs.writeSync(fd, bytes, offset, length)
      },
    } as typeof fs, before(step) {
      if (step.op === 'fsync' && fail && ((failure === 'file-sync' && quarantine(step.fd!)) || (failure === 'directory-sync' && step.path === join(dir, 'queue')))) {
        failures++
        throw new Error('EIO quarantine durability')
      }
    } }).fs
    const q = await recover({ fs: seam })
    for (let retry = 0; retry < 2; retry++) {
      expect(q.items('alpha')).toEqual([])
      expect(await q.accept('alpha', injectedInput({ text: 'must not be accepted' }))).toMatchObject({ status: 'failed' })
      expect(fs.readFileSync(queuePath(dir))).toEqual(original)
    }
    expect(failures).toBeGreaterThan(0)
    fail = false
    expect(await q.accept('alpha', injectedInput({ text: 'second' }))).toMatchObject({ status: 'accepted', seq: 2 })
    const quarantines = copies()
    expect(quarantines).toHaveLength(1)
    expect(fs.readFileSync(join(dir, 'queue', quarantines[0]!))).toEqual(Buffer.from(tail))
    // No explicit compaction: recovery itself must make the next append safe.
    await q.stop()
    const replay = await recover()
    expect(replay.items('alpha').map(i => [i.accepted.seq, i.accepted.text])).toEqual([[1, first.text], [2, 'second']])
    expect(findings(replay)).toEqual([])
    expect(copies()).toEqual(quarantines)
    expect(fs.readFileSync(join(dir, 'queue', quarantines[0]!))).toEqual(Buffer.from(tail))
  })

  test('a torn sent tail keeps its unknown-outcome evidence when the startup rewrite fails', async () => {
    const torn = '{"v":1,"kind":"sent","seq":1,"attempt":7,'
    seedQueue(dir, [first, { v: 1, kind: 'fixed', seq: 1, parts: ['fixed 🙂'] }, torn])
    let fail = true, rewriteFailures = 0
    const seam = { ...fs, openSync(...args: Parameters<typeof fs.openSync>) {
      if (fail && String(args[0]).endsWith('.tmp') && args[1] === 'wx') { rewriteFailures++; throw new Error('ENOSPC rewrite unavailable') }
      return fs.openSync(...args)
    } } as typeof fs
    const q = await recover({ fs: seam })
    expect(rewriteFailures).toBe(1)
    const quarantines = copies()
    expect(quarantines).toHaveLength(1)
    const quarantinePath = join(dir, 'queue', quarantines[0]!)
    expect(fs.readFileSync(quarantinePath)).toEqual(Buffer.from(torn))
    fail = false
    expect(await q.accept('alpha', injectedInput({ text: 'second' }))).toMatchObject({ status: 'accepted', seq: 2 })
    const recovered = q.item('alpha', 1)!
    expect(recovered).toMatchObject({ accepted: first, unknownSend: true, nextAttempt: 8, delivered: false, fixed: { parts: ['fixed 🙂'] } })
    await q.stop()
    const replay = await recover()
    expect(replay.items('alpha').map(i => [i.accepted.seq, i.accepted.text])).toEqual([[1, first.text], [2, 'second']])
    expect(replay.item('alpha', 1)).toMatchObject({ accepted: first, unknownSend: true, nextAttempt: 8, delivered: false, fixed: recovered.fixed })
    expect(replay.item('alpha', 1)!.records.filter(r => r.kind === 'sent')).toEqual(recovered.records.filter(r => r.kind === 'sent'))
    expect(findings(replay)).toEqual([])
    expect(copies()).toEqual(quarantines)
    expect(fs.readFileSync(quarantinePath)).toEqual(Buffer.from(torn))
  })
})

// Fix Task t2.yiv.5c.zc Ruling 2: b.2is repairs through durable-journal's rewrite,
// and a replay awaiting that rewrite supplies no trusted thread fact.
describe('b.2is repair composed with the durable journal and thread facts', () => {
  /** The real fs, recording truncations by path and rename targets; `failRewrite` refuses the repair's temporary file. */
  function recordingFs(failRewrite: () => boolean = () => false) {
    const paths = new Map<number, string>(), truncations: string[] = [], renames: string[] = []
    const seam = durableIo({ base: { ...fs,
      openSync(...args: Parameters<typeof fs.openSync>) {
        if (failRewrite() && String(args[0]).endsWith('.tmp') && args[1] === 'wx') throw Object.assign(new Error('injected ENOSPC opening the repair rewrite'), { code: 'ENOSPC' })
        const fd = fs.openSync(...args); paths.set(fd, String(args[0])); return fd
      },
      ftruncateSync(fd: number, length?: number) { truncations.push(paths.get(fd) ?? `fd:${fd}`); return fs.ftruncateSync(fd, length) },
    } as typeof fs, before(step) { if (step.op === 'rename') renames.push(step.to!) } }).fs
    return { fs: seam, truncations, renames }
  }
  const quarantined = (key = 'alpha') => fs.readdirSync(join(dir, 'queue')).filter(name => name.startsWith(`${key}.unreadable-`))
    .map(name => fs.readFileSync(join(dir, 'queue', name), 'utf8'))
  /** The journal holds whole production records only, and no line is the fragment. */
  function wholeRecords(fragment: string, key = 'alpha'): boolean {
    const text = fs.readFileSync(queuePath(dir, key), 'utf8')
    readQueue(dir, key)
    return text.endsWith('\n') && !text.split('\n').includes(fragment)
  }

  test('a torn sent tail is quarantined byte for byte and replaced by an atomic rewrite, never by truncating the journal, so its unknown-send evidence survives restart', async () => {
    // Attempt 2's send record, cut after its attempt number.
    const torn = tornRecord(sentRecord(1, 2), 'attempt')
    seedQueue(dir, [accepted(), fixedRecord(1), sentRecord(1, 1), torn])
    const io = recordingFs()
    const q = await open({ fs: io.fs })
    const findings = q.startupFindings().filter((e): e is Extract<QueueEvent, { type: 'record-unreadable' }> => e.type === 'record-unreadable')
    expect(findings).toMatchObject([{ key: 'alpha', line: 4, alert: false }])
    expect(quarantined()).toEqual([torn])
    expect(wholeRecords(torn)).toBe(true)
    expect(readQueue(dir).filter(r => r.kind === 'sent')).toEqual([sentRecord(1, 1),
      { v: 1, kind: 'sent', seq: 1, attempt: 2, unknown_outcome: true, at: accepted().received_at, quarantine: { path: findings[0]!.quarantinePath, line: 4 } }])
    expect(io.truncations).toEqual([])
    expect(io.renames).toContain(queuePath(dir))
    expect([q.isWritable!('alpha'), q.durabilityPending!('alpha')]).toEqual([true, false])
    await q.stop()
    const replay = await open()
    expect(replay.item('alpha', 1)).toMatchObject({ unknownSend: true, nextAttempt: 3 })
    expect(replay.startupFindings()).toEqual([])
    expect(quarantined()).toEqual([torn])
  })

  test('while its repair rewrite fails the key is unwritable and its thread facts wait; the repair turn runs the start\'s thread step, which recovers the join and releases the hold', async () => {
    const clock = createFakeClock({ start: THREAD_TIME })
    let q: DeliveryQueue | undefined
    const threads = makeThreadMemoryHarness(dir, { clock, heldStamps: key => q?.unresolvedHolds(key).filter(hold => hold.memoryDependent) ?? [] })
    await threads.start()
    const fact = threads.fact(), channel = fact.channel
    const mention = acceptedRecord(1, slackInput({ channel, via: 'mention', ts: fact.root, key: { chat_id: channel, ts: fact.root },
      thread_join: { thread_ts: fact.root, stamp: fact.stamp, at: fact.at } }), THREAD_TIME + 1)
    // A reply in the mention's thread whose Thread Memory view was unknown, held after the join.
    const reply = acceptedRecord(2, heldSlackInput(memoryHold(fact.at + 1, { stamp: fact.stamp }), { channel }), THREAD_TIME + 2)
    // A later message whose first append was cut by a crash after its sequence number.
    const late = slackInput({ channel, key: { chat_id: channel, ts: THREAD_ROOTS.third }, ts: THREAD_ROOTS.third })
    const torn = tornRecord(acceptedRecord(3, late, THREAD_TIME + 3), 'seq')
    seedQueue(dir, [mention, reply, torn])
    const original = fs.readFileSync(queuePath(dir))
    let failing = true
    const io = recordingFs(() => failing)
    const events: QueueEvent[] = [], loaded: unknown[] = [], released: number[] = [], resolutions: Promise<unknown>[] = []
    const resolver = createMemoryHoldResolver({ queue: { unresolvedHolds: key => q!.unresolvedHolds(key), resolveHolds: (...args) => q!.resolveHolds(...args),
      item: (key, seq) => q!.item(key, seq), durabilityPending: key => q!.durabilityPending!(key) },
    memory: threads.memory, clock, now: clock.now, release: (_key, item) => { released.push(item.accepted.seq) } })
    /** The start's thread step for a key, as src/server.ts runs it: the clock passes its holds' arrivals,
     * its queued joins recover, then its Memory Holds resolve as recovered work. */
    function threadStep(key: string) {
      for (const hold of q!.unresolvedHolds(key)) threads.memory.advancePast(key, hold.arrived_at)
      recoverQueuedJoins(key, q!, threads.memory)
      resolutions.push(resolver.resolve(key, 'recovered'))
    }
    q = createDeliveryQueue({ stateDir: dir, now: clock.now, fs: io.fs, onEvent: event => { events.push(event) },
      onLoadedAfterStart: key => { loaded.push([key, q!.durabilityPending!(key), q!.items(key).map(item => item.accepted.seq)]); threadStep(key) } })
    queues.push(q)
    try {
      await q.start()
      // The replay is visible for delivery and retention but not yet durable: no write, no trusted thread fact.
      expect(q.items('alpha').map(item => item.accepted.seq)).toEqual([1, 2])
      expect(q.unresolvedHolds('alpha').map(hold => hold.seq)).toEqual([2])
      expect([q.isWritable!('alpha'), q.durabilityPending!('alpha')]).toEqual([false, true])
      expect(fs.readFileSync(queuePath(dir))).toEqual(original)
      threadStep('alpha')
      expect(await Promise.all(resolutions)).toEqual(['unknown'])
      expect(threads.memory.view('alpha', channel, fact.root)).toBe('not-joined')
      expect(q.unresolvedHolds('alpha').map(hold => hold.seq)).toEqual([2])
      expect(released).toEqual([])
      // A store while the rewrite still fails is refused, appends nothing and quarantines nothing again.
      expect((await q.accept('alpha', late)).status).toBe('failed')
      expect(fs.readFileSync(queuePath(dir))).toEqual(original)
      expect(quarantined()).toEqual([torn])
      expect(events.filter(e => e.type === 'record-unreadable')).toHaveLength(1)
      expect(loaded).toEqual([])
      // Storage recovers: the store's turn repairs first, then runs the thread step on trusted facts before its own store.
      failing = false
      expect(await q.accept('alpha', late)).toMatchObject({ status: 'accepted', seq: 3 })
      expect(loaded).toEqual([['alpha', false, [1, 2]]])
      expect([q.isWritable!('alpha'), q.durabilityPending!('alpha')]).toEqual([true, false])
      expect(await Promise.all(resolutions)).toEqual(['unknown', 'resolved'])
      // The recovered join precedes the reply's arrival, so the hold is released, never withdrawn.
      expect(threads.memory.view('alpha', channel, fact.root)).toBe('joined')
      expect(released).toEqual([2])
      expect(readQueue(dir).filter(r => r.kind === 'released' || r.kind === 'hold-withdrawn')).toMatchObject([{ kind: 'released', seq: 2 }])
      expect(wholeRecords(torn)).toBe(true)
      expect(io.truncations.filter(path => path === queuePath(dir))).toEqual([])
      expect(clock.pendingCount()).toBe(0)
    } finally { resolver.stop(); await threads.close() }
  })

  test('a repair completed during start needs no late step; a damaged journal first read after start repairs and runs it in that turn', async () => {
    // The next message's first append, cut by a crash after its sequence number.
    const next = slackInput({ key: { chat_id: THREAD_CHANNELS.primary, ts: THREAD_ROOTS.secondary }, ts: THREAD_ROOTS.secondary })
    const torn = tornRecord(acceptedRecord(2, next, 1002), 'seq')
    seedQueue(dir, [accepted(), torn])
    const loaded: unknown[] = []
    const q: DeliveryQueue = createDeliveryQueue({ stateDir: dir,
      onLoadedAfterStart: key => { loaded.push([key, q.durabilityPending!(key), q.items(key).length]) } })
    queues.push(q)
    await q.start()
    expect(loaded).toEqual([])
    expect([q.isWritable!('alpha'), q.durabilityPending!('alpha')]).toEqual([true, false])
    seedQueue(dir, [accepted(), torn], 'beta')
    expect(await q.accept('beta', next)).toMatchObject({ status: 'accepted', seq: 2 })
    expect(loaded).toEqual([['beta', false, 1]])
    expect(quarantined('beta')).toEqual([torn])
    expect(wholeRecords(torn, 'beta')).toBe(true)
  })

  test('a failed store reports the exact Slack identity: slackKey with its edit, and edited_ts', async () => {
    let failing = true
    const events: QueueEvent[] = []
    const q = await open({ onEvent: event => { events.push(event) }, fs: durableIo({ before(step) {
      if (failing && step.op === 'fsync' && fs.fstatSync(step.fd!).isFile()) throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' })
    } }).fs })
    // The fixture message, edited.
    const key = { ...slackInput().key!, edited_ts: THREAD_ROOTS.secondary }
    expect((await q.acceptDecided('alpha', key, () => ({ store: slackInput({ key, ts: key.ts, edited_ts: key.edited_ts }) }))).status).toBe('failed')
    failing = false
    expect(events.filter(e => e.type === 'store-failed')).toEqual([expect.objectContaining({ key: 'alpha', ts: key.ts, slackKey: key, edited_ts: key.edited_ts })])
  })
})

test('1000 real-file accepts satisfy p99 <50ms without network', async () => {
  const q = await open(); const timings: number[] = []
  for (let i = 0; i < 1000; i++) { const at = performance.now(); expect((await q.accept('alpha', injectedInput())).status).toBe('accepted'); timings.push(performance.now() - at) }
  timings.sort((a, b) => a - b); const p99 = timings[Math.ceil(timings.length * .99) - 1]!
  console.info(`queue accepts=1000 p99_ms=${p99.toFixed(3)}`); expect(p99).toBeLessThan(50); expect(q.openCount('alpha')).toBe(1000)
})

test.each(['fixed', 'delivered'] as const)('damaged %s is quarantined and cannot falsely fix or deliver the accepted item', async kind => {
  const damaged = JSON.stringify({ v: 1, kind, seq: 1, ...(kind === 'fixed' ? { parts: [] } : { part: 1, at: 1000 }) }) + '\n'
  seedQueue(dir, [accepted(), damaged]); const q = await open(); expect(q.openCount('alpha')).toBe(1); expect(q.items('alpha')[0]!.fixed).toBeUndefined(); expect(q.items('alpha')[0]!.delivered).toBe(false)
})
test('a middle unreadable accepted record alerts, while later complete accepted work replays in order and bytes survive', async () => {
  const events: QueueEvent[] = []; const damaged = '{"v":99,"kind":"accepted","seq":2,"text":"unreadable text"}\n'
  seedQueue(dir, [accepted(), damaged, { ...accepted(), seq: 3 }]); const q = await open({ onEvent: e => events.push(e) })
  expect(q.items('alpha').map(i => i.accepted.seq)).toEqual([1, 3]); const unreadable = events.find((e): e is Extract<QueueEvent, { type: 'record-unreadable' }> => e.type === 'record-unreadable')!
  expect(unreadable).toMatchObject({ key: 'alpha', line: 2, alert: true }); expect(fs.readFileSync(unreadable.quarantinePath, 'utf8')).toBe(damaged)
  const bytes = fs.readFileSync(unreadable.quarantinePath); await q.stop(); await open(); expect(fs.readFileSync(unreadable.quarantinePath)).toEqual(bytes)
})
test('one unreadable queue refuses acceptance and exposes its recovery failure without blocking another persona', async () => {
  seedQueue(dir, [accepted()]); seedQueue(dir, [accepted()], 'beta'); const events: QueueEvent[] = []
  const seam = { ...fs, readFileSync: (path: fs.PathOrFileDescriptor, ...rest: unknown[]) => { if (String(path) === queuePath(dir)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return (fs.readFileSync as Function)(path, ...rest) } } as typeof fs
  const q = await open({ fs: seam, onEvent: e => events.push(e) }); expect((await q.accept('alpha', injectedInput())).status).toBe('failed'); expect(q.openCount('beta')).toBe(1); expect((await q.accept('beta', injectedInput())).status).toBe('accepted'); expect(events.some(e => e.type === 'recovery-failed' && e.key === 'alpha')).toBe(true)
})
test('fixed append fsync failure leaves accepted-only work retryable and no fixed bytes falsely visible', async () => {
  let failed = false
  const seam = failFileSyncs(() => failed, 'EIO')
  const q = await open({ fs: seam }); await q.accept('alpha', injectedInput()); failed = true
  const fixed = { v: 1, kind: 'fixed', seq: 1, parts: ['exact fixed bytes'] } as const
  await expect(q.append('alpha', { ...fixed, parts: [...fixed.parts] })).rejects.toThrow('EIO'); expect(q.items('alpha')[0]!.fixed).toBeUndefined()
  failed = false; await q.append('alpha', { ...fixed, parts: [...fixed.parts] }); await q.stop(); expect((await open()).items('alpha')[0]!.fixed!.parts).toEqual([...fixed.parts])
})
test('simultaneous redeliveries share one durable Slack acceptance; per-persona queues remain independent', async () => {
  const q = await open(); const results = await Promise.all(Array.from({ length: 20 }, () => q.accept('alpha', slackInput())))
  expect(results.filter(r => r.status === 'accepted')).toHaveLength(1); expect(results.filter(r => r.status === 'duplicate')).toHaveLength(19); expect(q.items('alpha')).toHaveLength(1); expect(q.items('beta')).toEqual([])
  expect((await q.accept('beta', slackInput())).status).toBe('accepted'); expect(q.items('beta')).toHaveLength(1)
})

test.each([16, 64])('%i concurrent accepts and preparations clone only two item snapshots per acceptance', async count => {
  const q = await open()
  const preparation = createDeliveryPreparation({ queue: q, resolveUserName: async () => 'human', clientFor: () => undefined, clock: createFakeClock() })
  const copies = spyOnCopies()
  try {
    await Promise.all(Array.from({ length: count }, (_, i) => {
      const ts = `1700000000.${String(i + 1).padStart(6, '0')}`
      return q.accept('alpha', slackInput({ ts, key: { chat_id: slackInput().channel!, ts } })).then(async result => {
        expect(result.status).toBe('accepted')
        if (result.status === 'failed' || !result.item) throw new Error('missing accepted item')
        await preparation.prepare('alpha', result.item)
      })
    }))
    const snapshots = copies.values.filter(value => value && typeof value === 'object' && 'accepted' in value && 'records' in value).length
    console.info(`queue preparation accepts=${count} item_snapshots=${snapshots} expected=${2 * count}`)
    // One detached acceptance result and one fresh preparation snapshot. A
    // whole-queue refresh instead grows quadratically as this burst queues.
    expect(snapshots).toBe(2 * count)
    // Item snapshots are copied field by field, not through a structured
    // clone's serialisation of every string (t3.yiv.sf.ws.ih). Only what
    // callers hand in takes structuredClone: each accepted input and each
    // fixation record the preparation appends (review-r2 R1).
    expect(copies.serialised).toBe(2 * count)
  } finally {
    copies.restore()
    await preparation.stop()
  }
  expect(q.openCount('alpha')).toBe(count)
  expect(q.items('alpha').every(item => item.fixed !== undefined)).toBe(true)
})

test.each(['item', 'items'] as const)('%s snapshots are fresh, deeply frozen and absent after compaction removes their item', async reader => {
  const q = await open()
  const read = (seq: number) => reader === 'item' ? q.item('alpha', seq) : q.items('alpha').find(item => item.accepted.seq === seq)
  await q.accept('alpha', slackInput({ files: [{ name: 'original.txt' }] }))
  await q.accept('alpha', injectedInput())
  await q.accept('beta', injectedInput({ text: 'other persona' }))
  expect(q.item('missing', 1)).toBeUndefined()
  expect(q.item('alpha', 99)).toBeUndefined()
  const stale = read(1)!
  await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['fixed bytes'] })
  await q.append('alpha', sentRecord())
  const current = read(1)!
  expect(stale.fixed).toBeUndefined()
  expect(current).toEqual(q.items('alpha')[0])
  const unchanged = structuredClone(current)
  expect(() => { current.accepted.text = 'changed' }).toThrow()
  expect(() => { current.accepted.key!.ts = 'changed' }).toThrow()
  expect(() => { current.accepted.files![0]!.name = 'changed.txt' }).toThrow()
  expect(() => { current.fixed!.parts[0] = 'changed bytes' }).toThrow()
  expect(() => { current.records.find(record => record.kind === 'sent')!.attempt = 99 }).toThrow()
  expect(() => { current.records.pop() }).toThrow()
  expect(() => { current.delivered = true }).toThrow()
  const list = q.items('alpha')
  list.reverse(); list.pop()
  expect(q.items('alpha').map(item => item.accepted.seq)).toEqual([1, 2])
  expect(read(1)).toEqual(unchanged)
  expect(q.item('beta', 1)!.accepted.text).toBe('other persona')
  await q.append('alpha', deliveredRecord())
  const delivered = read(1)!
  expect(delivered.delivered).toBe(true)
  expect(() => { delivered.records.find(record => record.kind === 'delivered')!.receipt.path = 'changed' }).toThrow()
  expect(current.delivered).toBe(false)
  await q.compact('alpha')
  expect(read(1)).toBeUndefined()
  expect(q.item('alpha', 2)).toEqual(q.items('alpha')[0])
  expect(q.item('beta', 1)!.accepted.text).toBe('other persona')
})

test.each([16, 64])('%i queued items and holds reuse snapshots between changes', async count => {
  const inputs = Array.from({ length: count }, (_, i) => {
    const ts = `1700000000.${String(i + 1).padStart(6, '0')}`
    return heldSlackInput(unknownRootPostHold(1000), { ts, key: { chat_id: THREAD_CHANNELS.primary, ts } })
  })
  seedQueue(dir, inputs.map((input, i) => acceptedRecord(i + 1, input, 1000)))
  const q = await open()
  const initial = q.items('alpha'), holds = q.unresolvedHolds('alpha')
  const copies = spyOnCopies()
  try {
    for (let i = 0; i < 4; i++) {
      expect(q.items('alpha')).toEqual(initial)
      expect(q.unresolvedHolds('alpha')).toEqual(holds)
      expect(q.item('alpha', count)).toEqual(initial.at(-1))
    }
    expect(copies.values).toHaveLength(0)
    // An append and a resolution invalidate only their item/hold versions.
    await q.append('alpha', noticedRecord(count))
    await q.resolveHolds('alpha', [{ seq: 1, outcome: 'parked', at: 1100 }])
    copies.clear()
    const changed = q.items('alpha'), changedHolds = q.unresolvedHolds('alpha')
    expect(changed[0]!.hold).toMatchObject({ kind: 'memory', state: 'unresolved' })
    expect(changed.at(-1)!.records.at(-1)).toEqual(noticedRecord(count))
    expect(changedHolds[0]).toMatchObject({ on: 'memory', seq: 1 })
    expect(changed.slice(1, -1)).toEqual(initial.slice(1, -1))
    // Two changed items and their two replaced hold entries, independent of count.
    expect(copies.values).toHaveLength(4)
    copies.clear()
    expect(q.item('alpha', 1)).toEqual(changed[0])
    expect(q.items('alpha')).toEqual(changed)
    expect(q.unresolvedHolds('alpha')).toEqual(changedHolds)
    expect(copies.values).toHaveLength(0)
  } finally { copies.restore() }
})

// t3.yiv.sf.ws.ih: the queue copied its inputs, results, snapshots and
// reports through structuredClone, which serialises every string.
test('a queue history returns, stores, reports and replays what structuredClone copies gave', async () => {
  async function history(label: string, structured: boolean) {
    const stateDir = join(dir, label), clock = createFakeClock({ start: THREAD_TIME }), events: unknown[] = []
    fs.mkdirSync(stateDir)
    const copier = structured ? spyOn(journal, 'cloneJournalData').mockImplementation(value => structuredClone(value)) : undefined
    const results: unknown[] = []
    const record = async (step: () => unknown) => { try { results.push(await step()) } catch (error) { results.push(`threw ${(error as Error).message}`) } }
    try {
      const q = createDeliveryQueue({ stateDir, now: clock.now, onEvent: event => { events.push(event) } }); queues.push(q)
      await q.start()
      const input = slackInput({ files: [{ name: 'original 🙂.txt' }] }), heldTs = THREAD_ROOTS.secondary
      const held = heldSlackInput(memoryHold(clock.now()), { ts: heldTs, key: { chat_id: THREAD_CHANNELS.primary, ts: heldTs } })
      await record(() => q.accept('alpha', input))
      await record(() => q.accept('alpha', input))
      await record(() => q.accept('alpha', injectedInput({ text: 'second 🙂\nline' })))
      await record(() => q.acceptDecided('alpha', held.key, () => ({ store: held })))
      await record(() => q.acceptDecided('alpha', { chat_id: THREAD_CHANNELS.primary, ts: THREAD_ROOTS.third }, () => ({ skip: 'not stored' })))
      await record(() => q.append('alpha', fixedRecord(1, ['fixed 🙂', 'bytes'])))
      await record(() => q.append('alpha', sentRecord()))
      await record(() => q.append('alpha', deliveredRecord()))
      await record(() => q.resolveHolds('alpha', [{ seq: 3, outcome: 'parked', at: clock.now() }], () => true, saved => { results.push(['committed', saved]) }))
      await record(() => q.recordReplyCall('alpha', q.replyCallTargets('alpha')))
      results.push(q.items('alpha'), q.item('alpha', 2), q.unresolvedHolds('alpha'), q.lookupSlackKey('alpha', input.key!), q.replyReminderItems('alpha'), q.replyCallTargets('alpha'))
      await q.stop()
      const replay = createDeliveryQueue({ stateDir, now: clock.now }); queues.push(replay)
      await replay.start()
      results.push(replay.items('alpha'), replay.unresolvedHolds('alpha'))
    } finally { copier?.mockRestore() }
    return { text: JSON.stringify({ results, events }).replaceAll(stateDir, '<dir>'), bytes: fs.readFileSync(queuePath(stateDir)) }
  }
  const before = await history('structured', true), now = await history('journal', false)
  expect(JSON.parse(now.text)).toEqual(JSON.parse(before.text))
  expect(now.bytes).toEqual(before.bytes)
})

// review-r1 R1: the copier read an input's getter, then sent the whole input to
// structuredClone for its class-instance key, which read the getter again and
// stored its second answer.
test('accept and acceptDecided store and return what one structuredClone of an input with a getter gave', async () => {
  class SlackKey { chat_id = 'C0TEST001'; ts: string; constructor(ts: string) { this.ts = ts } }
  async function accepted(label: string, structured: boolean) {
    const stateDir = join(dir, label)
    fs.mkdirSync(stateDir)
    const copier = structured ? spyOn(journal, 'cloneJournalData').mockImplementation(value => structuredClone(value)) : undefined
    const reads: string[] = []
    const input = (ts: string): AcceptedInput => {
      let n = 0
      return { ...slackInput({ ts }), get text() { reads.push(ts); return `message-${++n}` }, key: new SlackKey(ts) }
    }
    try {
      const q = createDeliveryQueue({ stateDir, now: () => THREAD_TIME }); queues.push(q)
      await q.start()
      const results = [await q.accept('alpha', input('1700000000.000001')),
        await q.acceptDecided('alpha', new SlackKey('1700000000.000002'), () => ({ store: input('1700000000.000002') }))]
      return { results: JSON.stringify(results), items: JSON.stringify(q.items('alpha')), reads, bytes: fs.readFileSync(queuePath(stateDir)) }
    } finally { copier?.mockRestore() }
  }
  const before = await accepted('structured', true), now = await accepted('journal', false)
  expect(now.results).toContain('"text":"message-1"')
  expect(now).toEqual(before)
})

// review-r2 R1: cloneJournalData copies only records the queue built or
// already copied; every value a caller hands in keeps structuredClone.
test('every queue entry point copies what its caller hands in with structuredClone itself', async () => {
  const q = await open()
  const serialising = spyOn(globalThis, 'structuredClone'), copying = spyOn(journal, 'cloneJournalData')
  const handed: Array<[string, unknown]> = []
  const hand = <T>(name: string, value: T): T => { handed.push([name, value]); return value }
  try {
    await q.accept('alpha', hand('accept input', slackInput()))
    const ts = '1700000000.000002'
    await q.acceptDecided('alpha', hand('acceptDecided key', { chat_id: 'C0TEST001', ts }), () => ({ store: hand('acceptDecided store', slackInput({ ts, key: { chat_id: 'C0TEST001', ts } })) }))
    await q.append('alpha', hand('append record', fixedRecord(1, ['fixed'])))
    await q.recordReplyCall('alpha', hand('recordReplyCall targets', q.replyCallTargets('alpha')))
    await q.resolveHolds('alpha', hand('resolveHolds resolutions', [{ seq: 1, outcome: 'parked' as const, at: 1000 }]))
    for (const [name, value] of handed) {
      expect([name, serialising.mock.calls.filter(([arg]) => arg === value).length, copying.mock.calls.filter(([arg]) => arg === value).length]).toEqual([name, 1, 0])
    }
  } finally { serialising.mockRestore(); copying.mockRestore() }
})

// review-r2 R1: an object with internal slots behind a plain object's
// prototype looked like plain data to the copier, which then copied a
// WeakRef structuredClone refuses and emptied a Blob it copies whole.
test('accept and acceptDecided give a disguised WeakRef or Blob, nested or frozen, what structuredClone gave it', async () => {
  const disguised = <T extends object>(value: T, fields: Record<string, unknown> = {}): T => Object.assign(Object.setPrototypeOf(value, Object.prototype), fields)
  const weakKey = (ts: string) => disguised(new WeakRef({}), { chat_id: 'C0TEST001', ts })
  const blob = () => disguised(new Blob(['payload'], { type: 'text/plain' }))
  const message = (ts: string) => slackInput({ ts, key: { chat_id: 'C0TEST001', ts } })
  const inputs: Array<[string, (ts: string) => AcceptedInput]> = [
    ['WeakRef key', ts => ({ ...message(ts), key: weakKey(ts) as unknown as AcceptedInput['key'] })],
    ['nested WeakRef', ts => ({ ...message(ts), files: [{ name: 'a.txt', ref: disguised(new WeakRef({}), { id: 'F0TEST001' }) }] } as unknown as AcceptedInput)],
    ['frozen WeakRef key', ts => Object.freeze({ ...message(ts), key: Object.freeze(weakKey(ts)) as unknown as AcceptedInput['key'] })],
    ['Blob', ts => ({ ...message(ts), files: [{ name: 'a.txt', body: blob() }] } as unknown as AcceptedInput)],
    ['frozen Blob', ts => Object.freeze({ ...message(ts), files: Object.freeze([Object.freeze({ name: 'a.txt', body: Object.freeze(blob()) })]) } as unknown as AcceptedInput)],
  ]
  /** A result as comparable data: an error by its name, a Blob by its type and payload. */
  async function described(value: unknown): Promise<unknown> {
    if (value instanceof Error) return { error: value.name }
    if (value instanceof Blob) return { blob: [Object.getPrototypeOf(value) === Blob.prototype, value.type, await value.text()] }
    if (Array.isArray(value)) return Promise.all(value.map(described))
    if (typeof value !== 'object' || value === null) return value
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, member]) => [key, await described(member)])))
  }
  async function run(label: string, structured: boolean) {
    const stateDir = join(dir, label)
    fs.mkdirSync(stateDir)
    const copier = structured ? spyOn(journal, 'cloneJournalData').mockImplementation(value => structuredClone(value)) : undefined
    try {
      const q = createDeliveryQueue({ stateDir, now: () => THREAD_TIME }); queues.push(q)
      await q.start()
      const results: unknown[] = []
      for (const [i, [name, input]] of inputs.entries()) {
        const ts = (n: number) => `1700000000.${String(10 * i + n).padStart(6, '0')}`
        results.push([name, 'accept', await q.accept('alpha', input(ts(1)))])
        results.push([name, 'acceptDecided', await q.acceptDecided('alpha', { chat_id: 'C0TEST001', ts: ts(2) }, () => ({ store: input(ts(2)) }))])
      }
      // A disguised WeakRef as the decided Slack key itself.
      results.push(['WeakRef key', 'acceptDecided key', await q.acceptDecided('alpha', weakKey('1700000000.000099') as never, () => ({ store: slackInput() }))])
      results.push(['items', q.items('alpha')])
      return { results: await described(results), bytes: fs.readFileSync(queuePath(stateDir)) }
    } finally { copier?.mockRestore() }
  }
  const before = await run('structured', true), now = await run('journal', false)
  expect(JSON.stringify(now.results)).toContain('"error":"DataCloneError"')
  expect(JSON.stringify(now.results)).toContain(`"blob":[true,${JSON.stringify(new Blob([], { type: 'text/plain' }).type)},"payload"]`)
  expect(now.results).toEqual(before.results)
  expect(now.bytes).toEqual(before.bytes)
})

test('frozen hold snapshots keep old versions through parking, release, compaction and replay', async () => {
  const field = unknownRootPostHold(1000), input = heldSlackInput(field)
  const q = await open()
  expect((await q.accept('alpha', input)).status).toBe('accepted')
  const initial = q.items('alpha')[0]!, holds = q.unresolvedHolds('alpha'), hold = holds[0]!
  if (hold.on !== 'post') throw new Error('expected Post Hold')
  const original = structuredClone(initial), originalHold = structuredClone(hold)
  expect(() => { initial.hold!.field.stamp.incarnation = 'changed' }).toThrow()
  expect(() => { initial.hold!.state = 'released' }).toThrow()
  expect(() => { hold.stamp.threadHybridSince = 'changed' }).toThrow()
  expect(() => { (hold.operations as string[]).push('changed') }).toThrow()
  holds.pop()
  expect(q.unresolvedHolds('alpha')).toEqual([originalHold])
  await q.resolveHolds('alpha', [{ seq: 1, outcome: 'parked', at: 1100 }])
  expect(q.item('alpha', 1)!.hold).toMatchObject({ kind: 'memory', state: 'unresolved' })
  expect(q.unresolvedHolds('alpha')).toEqual([{ ...memoryHold(1000), seq: 1, channel: input.channel!, memoryDependent: true }])
  await q.resolveHolds('alpha', [{ seq: 1, outcome: 'released', at: 1200 }])
  expect(q.item('alpha', 1)!.hold).toMatchObject({ kind: 'memory', state: 'released', at: 1200 })
  expect(q.unresolvedHolds('alpha')).toEqual([])
  expect(initial).toEqual(original)
  expect(hold).toEqual(originalHold)
  await q.compact('alpha')
  const compacted = q.item('alpha', 1)!
  expect(compacted.hold).toBeUndefined()
  expect(compacted.accepted.released_at).toBe(1200)
  await q.stop()
  const replay = await open()
  expect(replay.items('alpha')).toEqual([compacted])
  expect(replay.unresolvedHolds('alpha')).toEqual([])
})
test('closing drains accepted writes and rejects new intake without leaving an open descriptor', async () => {
  let opens = 0; const seam = { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => { const fd = fs.openSync(...args); opens++; return fd }, closeSync: (fd: number) => { fs.closeSync(fd); opens-- } } as typeof fs
  const q = await open({ fs: seam }); const accepting = q.accept('alpha', injectedInput()); await q.stop(); expect((await accepting).status).toBe('accepted'); expect(opens).toBe(0); expect((await q.accept('alpha', injectedInput())).status).toBe('failed'); expect(q.items('alpha')).toHaveLength(1)
})

test('construction performs no filesystem access and starts no maintenance timer', async () => {
  const calls: string[] = []
  const seam = new Proxy(fs, { get(target, name) { const value = Reflect.get(target, name); return typeof value === 'function' ? () => { calls.push(String(name)); throw new Error('construction must not access filesystem') } : value } }) as typeof fs
  const q = createDeliveryQueue({ stateDir: dir, fs: seam, setInterval: (() => { calls.push('timer'); throw new Error('construction must not start timer') }) as typeof setInterval })
  queues.push(q); expect(calls).toEqual([])
})
test('short filesystem writes are completed before acceptance, and file fsync precedes new-file directory fsync', async () => {
  const order: string[] = []
  const seam = durableIo({ base: { ...fs, writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number) => fs.writeSync(fd, buffer, offset, Math.min(length, 7)) } as typeof fs,
    before(step) { if (step.op === 'fsync') order.push(step.path) } }).fs
  const q = await open({ fs: seam }); expect((await q.accept('alpha', injectedInput({ text: '🙂'.repeat(40) }))).status).toBe('accepted'); expect(readQueue(dir)[0]).toMatchObject({ text: '🙂'.repeat(40) }); expect(order.lastIndexOf(join(dir, 'queue'))).toBeGreaterThan(order.lastIndexOf(queuePath(dir)))
})

// acceptance failures must never turn uncertain bytes into replayed work.
test.each(['truncate', 'fsync'] as const)('keeps the original rollback boundary through repeated reconciliation %s failures', async failure => {
  let phase: 'ok' | 'failed-append' | 'reconcile' = 'ok'
  const truncations: number[] = []
  const seam = failFileSyncs(() => phase !== 'ok', 'EIO fsync', {
    ...fs,
    ftruncateSync(fd: number, length = 0) {
      truncations.push(length)
      if (phase === 'failed-append' || phase === 'reconcile' && failure === 'truncate') throw new Error('EIO truncate')
      fs.ftruncateSync(fd, length)
    },
  } as typeof fs)
  const q = await open({ fs: seam })
  expect(await q.accept('alpha', injectedInput({ text: 'A' }))).toMatchObject({ status: 'accepted', seq: 1 })
  const boundary = fs.statSync(queuePath(dir)).size
  phase = 'failed-append'
  expect((await q.accept('alpha', injectedInput({ text: 'B' }))).status).toBe('failed')
  expect(fs.statSync(queuePath(dir)).size).toBeGreaterThan(boundary)
  phase = 'reconcile'
  for (let retry = 0; retry < 2; retry++) {
    expect((await q.accept('alpha', injectedInput({ text: 'C' }))).status).toBe('failed')
    expect(q.items('alpha').map(i => i.accepted.text)).toEqual(['A'])
  }
  expect(truncations.length).toBeGreaterThanOrEqual(3)
  expect(new Set(truncations)).toEqual(new Set([boundary]))
  phase = 'ok'
  expect(await q.accept('alpha', injectedInput({ text: 'C' }))).toMatchObject({ status: 'accepted', seq: 2 })
  await q.stop()
  const replay = await open()
  expect(replay.items('alpha').map(i => [i.accepted.seq, i.accepted.text])).toEqual([[1, 'A'], [2, 'C']])
  expect(fs.readdirSync(join(dir, 'queue')).filter(name => name.includes('.unreadable-'))).toEqual([])
})

test.each(['EIO', 'EACCES'].flatMap(code => ['accept', 'compact'].map(operation => [code, operation] as const)))('startup read %s recovers on a later %s without publishing partial replay', async (code, operation) => {
  seedQueue(dir, [accepted()])
  let fail = true
  const seam = { ...fs, readFileSync(path: fs.PathOrFileDescriptor, ...args: unknown[]) {
    if (fail && String(path) === queuePath(dir)) throw Object.assign(new Error(code), { code })
    return (fs.readFileSync as Function)(path, ...args)
  } } as typeof fs
  const q = await open({ fs: seam })
  expect(q.items('alpha')).toEqual([])
  expect(q.lookupSlackKey('alpha', slackInput().key!)).toBeUndefined()
  if (operation === 'accept') expect((await q.accept('alpha', injectedInput())).status).toBe('failed')
  else await expect(q.compact('alpha')).rejects.toThrow(code)
  expect(q.items('alpha')).toEqual([])
  fail = false
  if (operation === 'accept') expect(await q.accept('alpha', injectedInput())).toMatchObject({ status: 'accepted', seq: 2 })
  else await q.compact('alpha')
  expect(q.items('alpha').map(i => i.accepted.seq)).toEqual(operation === 'accept' ? [1, 2] : [1])
  expect(q.lookupSlackKey('alpha', slackInput().key!)).toMatchObject({ status: 'duplicate', seq: 1 })
})

test.each(['write', 'fsync', 'truncate'] as const)('failed quarantine %s retries preserve one exact damaged-byte copy and publish no partial replay', async failure => {
  const damaged = '{"v":99,"kind":"accepted","seq":2,"text":"damaged"}\n'
  seedQueue(dir, [accepted(), damaged])
  let fail = true
  const paths = new Map<number, string>()
  const quarantine = (fd: number) => paths.get(fd)?.includes('.unreadable-') === true
  const seam = durableIo({ base: {
    ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) { const fd = fs.openSync(...args); paths.set(fd, String(args[0])); return fd },
    writeSync(fd: number, bytes: Uint8Array, offset: number, length: number) {
      const written = fs.writeSync(fd, bytes, offset, length)
      if (fail && quarantine(fd) && failure === 'write') throw new Error('EIO full write')
      return written
    },
    ftruncateSync(fd: number, length = 0) {
      if (fail && quarantine(fd) && failure === 'truncate') throw new Error('EIO truncate')
      fs.ftruncateSync(fd, length)
    },
  } as typeof fs, before(step) {
    if (step.op === 'fsync' && fail && quarantine(step.fd!) && failure !== 'write') throw new Error('EIO fsync')
  } }).fs
  const q = await open({ fs: seam })
  for (let retry = 0; retry < 2; retry++) {
    expect(q.items('alpha')).toEqual([])
    expect(q.lookupSlackKey('alpha', slackInput().key!)).toBeUndefined()
    expect((await q.accept('alpha', injectedInput())).status).toBe('failed')
  }
  fail = false
  await q.compact('alpha')
  expect(q.items('alpha').map(i => [i.accepted.seq, i.accepted.text])).toEqual([[1, 'message']])
  const quarantines = fs.readdirSync(join(dir, 'queue')).filter(name => name.includes('.unreadable-'))
  expect(quarantines).toHaveLength(1)
  expect(fs.readFileSync(join(dir, 'queue', quarantines[0]!), 'utf8')).toBe(damaged)
  await q.stop()
  expect((await open()).items('alpha').map(i => i.accepted.seq)).toEqual([1])
  expect(fs.readFileSync(join(dir, 'queue', quarantines[0]!), 'utf8')).toBe(damaged)
})


test('maintenance compacts at the exported interval once and stop cancels its timer', async () => {
  const clock = createFakeClock(), io = durableIo()
  clock.settleOn(io)
  const scheduled: number[] = []
  const q = await open({ now: clock.now, fs: io.fs, ...fakeIntervals(clock, scheduled) })
  await q.accept('alpha', injectedInput({ text: 'delivered content' }))
  await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['delivered bytes'] })
  await q.append('alpha', deliveredRecord())
  q.startMaintenance(); q.startMaintenance()
  expect(scheduled).toEqual([QUEUE_COMPACT_INTERVAL_MS])
  await clock.advance(QUEUE_COMPACT_INTERVAL_MS - 1)
  expect(fs.readFileSync(queuePath(dir), 'utf8')).toContain('delivered content')
  await clock.advance(1)
  expect(fs.readFileSync(queuePath(dir), 'utf8')).not.toContain('delivered content')
  expect(q.items('alpha')).toEqual([])
  expect(clock.pendingCount()).toBe(1)
  await q.stop(); expect(clock.pendingCount()).toBe(0)
})

test('maintenance triggers behind a queued, unstarted maintenance compaction add none; it compacts state as of the last trigger, and a trigger once it starts queues one more', async () => {
  const isTemp = (path: string) => path.startsWith(`${queuePath(dir)}.`) && path.endsWith('.tmp')
  // One hold per compaction; the queue writes through the outermost seam, `third`.
  const first = holdFirstSync(isTemp, { armed: false }), second = holdFirstSync(isTemp, { armed: false, base: first.io.fs })
  const third = holdFirstSync(isTemp, { armed: false, base: second.io.fs })
  const clock = createFakeClock({ start: THREAD_TIME }), events: QueueEvent[] = []
  clock.settleOn(third.io)
  const q = await open({ now: clock.now, fs: third.io.fs, onEvent: e => { events.push(e) }, ...fakeIntervals(clock) })
  const rewrites = () => third.io.steps.filter(step => step.op === 'rename' && isTemp(step.path)).length
  const compacted = () => readQueue(dir).map(r => 'compact' in r ? r.compact : r.kind)
  await q.accept('alpha', slackInput())
  for (const record of [fixedRecord(), sentRecord(), deliveredRecord()]) await q.append('alpha', record)
  first.state.armed = true
  q.startMaintenance()
  await clock.advance(QUEUE_COMPACT_INTERVAL_MS)
  await first.reached()
  // The first trigger's compaction is running; the next trigger queues one behind it and the rest add none.
  // The delivered key leaves its keep window only at the last trigger, so only a compaction from then on drops it.
  await clock.advance(QUEUE_KEY_KEEP_MS - QUEUE_COMPACT_INTERVAL_MS)
  second.state.armed = true
  first.gate.release(); await second.reached()
  expect(rewrites()).toBe(1)
  expect(compacted()).toEqual(['key', 'allocation'])
  third.state.armed = true
  await clock.advance(QUEUE_COMPACT_INTERVAL_MS)
  // The third compaction waits on its own sync, so the journal holds the queued second compaction's image.
  second.gate.release(); await third.reached()
  expect(rewrites()).toBe(2)
  expect(compacted()).toEqual(['allocation'])
  third.gate.release()
  await clock.flush()
  expect(rewrites()).toBe(3)
  expect(events.filter(e => e.type === 'compaction-failed')).toEqual([])
})

describe('the journal holds only the record kinds and fields main reads', () => {
  const KINDS = ['accepted', 'fixed', 'sent', 'delivered', 'refused', 'noticed', 'reply-reminder']
  const rawLines = () => fs.readFileSync(queuePath(dir), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)

  test('compaction writes a delivered key record with exactly v, kind, seq, compact, key, received_at and delivered_at, an allocation record with exactly v, kind, seq, compact and injected_ts, and only records isQueueRecord accepts; an open via thread item replays whole', async () => {
    const clock = createFakeClock({ start: 1000 })
    const q = await open({ now: clock.now })
    const threaded = slackInput({ via: 'thread', thread_ts: '1700000000.000000' })
    await q.accept('alpha', threaded)
    await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['delivered'] })
    await q.append('alpha', sentRecord())
    await q.append('alpha', deliveredRecord())
    const openThreaded = slackInput({ ts: '1700000000.000002', key: { chat_id: 'C0TEST001', ts: '1700000000.000002' }, via: 'thread', thread_ts: '1700000000.000000' })
    await q.accept('alpha', openThreaded)
    await q.accept('alpha', injectedInput())
    await q.compact('alpha')
    const lines = rawLines()
    const keys = lines.filter(r => r.compact === 'key')
    expect(keys.map(r => Object.keys(r).sort())).toEqual([['compact', 'delivered_at', 'key', 'kind', 'received_at', 'seq', 'v']])
    expect(keys[0]).toEqual({ v: 1, kind: 'accepted', seq: 1, compact: 'key', key: threaded.key, received_at: 1000, delivered_at: 1000 })
    expect(lines.filter(r => r.compact === 'allocation').map(r => Object.keys(r).sort())).toEqual([['compact', 'injected_ts', 'kind', 'seq', 'v']])
    expect(lines.map(r => r.kind)).toEqual(['accepted', 'accepted', 'accepted', 'reply-reminder', 'accepted'])
    for (const r of lines) {
      expect(KINDS).toContain(String(r.kind))
      expect(isQueueRecord(r)).toBe(true)
    }
    await q.stop()
    const replay = await open({ now: clock.now })
    expect(replay.lookupSlackKey('alpha', threaded.key!)).toEqual({ status: 'duplicate', seq: 1 })
    expect(replay.items('alpha').map(i => i.accepted.seq)).toEqual([2, 3])
    expect(replay.items('alpha')[0]!.accepted).toMatchObject({ via: 'thread', thread_ts: '1700000000.000000', key: openThreaded.key })
  })

  test('participation lines from an unreleased build are quarantined as unknown records and never replayed', async () => {
    // The shapes an unreleased build wrote; this build has no reader for them.
    const participation = JSON.stringify({ v: 1, kind: 'thread-participation', seq: 0, state: 'enrolled', observation: { id: 'obs-1', root: '1700000000.000100' } }) + '\n'
    const gap = JSON.stringify({ v: 1, kind: 'thread-gap', seq: 0 }) + '\n'
    const enrolledKey = { chat_id: 'C0TEST001', ts: '1700000000.000002' }
    const keyWithEnrollment = JSON.stringify({ v: 1, kind: 'accepted', seq: 2, compact: 'key', key: enrolledKey, received_at: 1000, delivered_at: 1000, thread_enrollment: { id: 'obs-2', slackKey: enrolledKey } }) + '\n'
    for (const line of [participation, gap, keyWithEnrollment]) expect(parseQueueRecord(line.trimEnd())).toBeUndefined()
    seedQueue(dir, [accepted(), participation, gap, keyWithEnrollment, { ...accepted(), seq: 3, source: 'interject', sender: 'interject', key: undefined, channel: undefined, via: undefined }])
    const events: QueueEvent[] = []
    const q = await open({ onEvent: e => events.push(e) })
    const unreadable = events.filter((e): e is Extract<QueueEvent, { type: 'record-unreadable' }> => e.type === 'record-unreadable')
    expect(unreadable.map(e => [e.line, e.alert])).toEqual([[2, true], [3, true], [4, true]])
    expect(fs.readFileSync(unreadable[0]!.quarantinePath, 'utf8')).toBe(participation + gap + keyWithEnrollment)
    expect(q.items('alpha').map(i => i.accepted.seq)).toEqual([1, 3])
    expect(q.lookupSlackKey('alpha', enrolledKey)).toBeUndefined()
    expect(rawLines().every(r => KINDS.includes(String(r.kind)) && !('thread_enrollment' in r))).toBe(true)
    await q.stop()
    const replayEvents: QueueEvent[] = []
    const replay = await open({ onEvent: e => replayEvents.push(e) })
    expect(replayEvents.filter(e => e.type === 'record-unreadable')).toEqual([])
    expect(replay.items('alpha').map(i => i.accepted.seq)).toEqual([1, 3])
    expect(replay.lookupSlackKey('alpha', enrolledKey)).toBeUndefined()
    expect(await replay.accept('alpha', slackInput({ ts: enrolledKey.ts, key: enrolledKey }))).toMatchObject({ status: 'accepted', seq: 4 })
  })
})

test('startup findings remain available to a notifier installed after queue start and are safe copies', async () => {
  const damaged = '{"v":99,"kind":"accepted","seq":2,"text":"private queued body"}\n'
  seedQueue(dir, [accepted(), damaged, { ...accepted(), seq: 3 }])
  const q = await open()
  const findings = q.startupFindings()
  expect(findings).toMatchObject([{ type: 'record-unreadable', key: 'alpha', line: 2, alert: true }])
  expect(JSON.stringify(findings)).not.toContain('private queued body')
  assertNoLeak(findings)
  const finding = findings[0]!
  if (finding.type !== 'record-unreadable') throw new Error('expected corruption finding')
  const path = finding.quarantinePath
  finding.alert = false
  expect(q.startupFindings()).toMatchObject([{ alert: true }])
  expect(fs.readFileSync(path, 'utf8')).toBe(damaged)
  expect(q.items('alpha').map(item => item.accepted.seq)).toEqual([1, 3])
})

describe('thread_join acceptance and main-reader compatibility', () => {
  const joinFact = () => ({ thread_ts: THREAD_ROOTS.primary, stamp: { ...THREAD_STAMP }, at: THREAD_TIME })
  const joiningInput = (via = 'mention') => slackInput({ via, thread_join: joinFact() })
  const joinedRecord = (): AcceptedRecord => ({ ...accepted(), ...joiningInput() })

  test.each(['mention', 'broadcast'])('%s joins share the accepting append/fsync and survive reaction adoption and replay', async via => {
    const writes: Buffer[] = [], syncs: string[] = []
    const io = durableIo({ base: { ...fs,
      writeSync(fd: number, bytes: Uint8Array, offset: number, length: number, position: number | null) {
        if (io.paths.get(fd) === queuePath(dir)) writes.push(Buffer.from(bytes.subarray(offset, offset + length)))
        return fs.writeSync(fd, bytes, offset, length, position)
      },
    } as typeof fs, before(step) { if (step.op === 'fsync' && fs.fstatSync(step.fd!).isFile()) syncs.push(step.path) } })
    const seam = io.fs
    const clock = createFakeClock({ start: THREAD_TIME })
    const q = await open({ fs: seam, now: clock.now }), input = joiningInput(via)
    const result = await q.acceptDecided('alpha', input.key, () => ({ store: input }))
    expect(result).toMatchObject({ status: 'accepted', seq: 1 })
    expect(readQueue(dir)).toEqual([{ ...input, v: 1, kind: 'accepted', seq: 1, received_at: THREAD_TIME, ts: input.ts! }])
    expect(writes).toEqual([fs.readFileSync(queuePath(dir))])
    expect(syncs).toEqual([queuePath(dir)])
    expect(await q.rememberQueuedReaction('alpha', 1, 'original_queue')).toBe('original_queue')
    await q.compact('alpha')
    await q.stop()
    const replay = await open({ now: clock.now })
    expect(replay.item('alpha', 1)!.accepted).toMatchObject({ ...input, queued_ack_reaction: 'original_queue' })
    expect(replay.openCount('alpha')).toBe(1)
    expect(readQueue(dir).filter(r => r.kind === 'accepted' && !('compact' in r))).toMatchObject([{ thread_join: joinFact() }])
    for (const record of readQueue(dir).filter(r => 'compact' in r)) expect(record).not.toHaveProperty('thread_join')
  })

  const badJoins: [string, unknown][] = [
    ['null', null], ['array', []],
    ['missing root', { stamp: THREAD_STAMP, at: THREAD_TIME }],
    ['missing stamp', { thread_ts: THREAD_ROOTS.primary, at: THREAD_TIME }],
    ['missing at', { thread_ts: THREAD_ROOTS.primary, stamp: THREAD_STAMP }],
    ['extra join key', { ...joinFact(), source: 'mention' }],
    ['invalid timestamp', { ...joinFact(), thread_ts: 'not-a-timestamp' }],
    ['short timestamp', { ...joinFact(), thread_ts: '1.1' }],
    ['numeric timestamp', { ...joinFact(), thread_ts: 1 }],
    ['empty incarnation', { ...joinFact(), stamp: { ...THREAD_STAMP, incarnation: '' } }],
    ['empty since', { ...joinFact(), stamp: { ...THREAD_STAMP, threadHybridSince: '' } }],
    ['missing incarnation', { ...joinFact(), stamp: { threadHybridSince: THREAD_STAMP.threadHybridSince } }],
    ['missing since', { ...joinFact(), stamp: { incarnation: THREAD_STAMP.incarnation } }],
    ['extra stamp key', { ...joinFact(), stamp: { ...THREAD_STAMP, extra: true } }],
    ['string at', { ...joinFact(), at: String(THREAD_TIME) }],
    ['NaN', { ...joinFact(), at: NaN }], ['infinite at', { ...joinFact(), at: Infinity }],
  ]
  const badRecords: [string, unknown][] = [
    ...badJoins.map(([name, thread_join]): [string, unknown] => [name, { ...joinedRecord(), thread_join }]),
    ...['interject', 'cron'].map(source => [source, { ...joinedRecord(), source, sender: source, key: undefined }] as [string, unknown]),
    ...['thread', 'receive_all', 'all', 'dm', ''].map(via => [`via ${via}`, { ...joinedRecord(), via }] as [string, unknown]),
    ['compacted key', { v: 1, kind: 'accepted', seq: 1, compact: 'key', key: slackInput().key, received_at: 1000, delivered_at: 1000, thread_join: joinFact() }],
    ['allocation', { v: 1, kind: 'accepted', seq: 1, compact: 'allocation', thread_join: joinFact() }],
  ]
  test.each(badRecords)('quarantines %s instead of replaying a bad join', async (_, record) => {
    expect(isQueueRecord(record)).toBe(false)
    const line = JSON.stringify(record) + '\n'
    expect(parseQueueRecord(line)).toBeUndefined()
    seedQueue(dir, [line, { ...accepted(), seq: 2 }])
    const q = await open(), findings = q.startupFindings()
    expect(findings).toMatchObject([{ type: 'record-unreadable', key: 'alpha', line: 1, alert: true }])
    const finding = findings[0]!
    if (finding.type !== 'record-unreadable') throw new Error('expected invalid-join quarantine')
    expect(fs.readFileSync(finding.quarantinePath, 'utf8')).toBe(line)
    expect(q.items('alpha').map(item => item.accepted.seq)).toEqual([2])
    expect(q.openCount('alpha')).toBe(1)
  })

  test.each(['mention', 'broadcast', 'thread', 'receive_all', 'all', 'interject', 'cron'])('plain accept %s writes main-identical bytes and duplicate keys write nothing', async kind => {
    const clock = createFakeClock({ start: THREAD_TIME }), q = await open({ now: clock.now })
    const oldDir = join(dir, 'main'), old = createMainDeliveryQueue({ stateDir: oldDir, now: clock.now })
    fs.mkdirSync(oldDir)
    await old.start()
    try {
      const input = kind === 'interject' || kind === 'cron' ? injectedInput({ source: kind }) : slackInput({ via: kind })
      for (let i = 0; i < 2; i++) {
        // The old reader's input type predates the reaction source; these inputs are Slack or injected.
        expect(await q.accept('alpha', input)).toEqual(await old.accept('alpha', input as Parameters<typeof old.accept>[1]))
        expect(fs.readFileSync(queuePath(dir))).toEqual(fs.readFileSync(queuePath(oldDir)))
      }
      expect(q.items('alpha')).toHaveLength(input.source === 'slack' ? 1 : 2)
    } finally { await old.stop() }
  })

  // main.start() compacts after loading. Refusing its writes keeps the loaded
  // snapshot available, so we check delivered status before old compaction
  // intentionally discards delivered content. Its reader code is unmodified.
  async function readWithMain(label: string) {
    const copy = join(dir, label)
    seedQueue(copy, [])
    fs.copyFileSync(queuePath(dir), queuePath(copy))
    const before = fs.readFileSync(queuePath(copy))
    const old = createMainDeliveryQueue({ stateDir: copy, now: () => 1000, fs: { ...fs,
      openSync(path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
        if (typeof flags !== 'string' || /[wa+]/.test(flags)) throw new Error('read-only compatibility reader')
        return fs.openSync(path, flags, mode)
      },
    } as typeof fs })
    await old.start()
    try {
      expect(old.startupFindings()).toEqual([])
      expect(fs.readFileSync(queuePath(copy))).toEqual(before)
      return { items: old.items('alpha'), open: old.openCount('alpha'), keys: [THREAD_ROOTS.primary, THREAD_ROOTS.secondary, THREAD_ROOTS.third].map(ts => old.lookupSlackKey('alpha', { chat_id: slackInput().channel!, ts })) }
    } finally { await old.stop() }
  }

  test.each(['absent', 'false'] as const)('delivered unsaved joins retain every item byte with predicate %s, then main reads delivered', async option => {
    let saved = false
    const calls: unknown[] = [], clock = createFakeClock({ start: 1000 })
    const predicate = (key: string, channel: string, fact: ReturnType<typeof joinFact>) => { calls.push({ key, channel, fact }); return saved }
    const q = await open({ now: clock.now, ...(option === 'false' ? { threadJoinSaved: predicate } : {}) })
    await q.accept('alpha', joiningInput())
    const itemRecords: QueueRecord[] = [
      fixedRecord(1, ['exact\nbytes🙂']), sentRecord(),
      refusedRecord(), sentRecord(1, 2), deliveredRecord(),
      noticedRecord(),
    ]
    for (const record of itemRecords) await q.append('alpha', record)
    // The unjoined delivered sibling still compacts; the open joined sibling
    // still delivers in FIFO order. Pending reply reminders keep their facts.
    for (const [seq, ts] of [[2, THREAD_ROOTS.secondary], [3, THREAD_ROOTS.third]] as const) {
      await q.accept('alpha', slackInput({ via: 'mention', ts, key: { ...slackInput().key!, ts }, ...(seq === 3 ? { thread_join: joinFact() } : {}) }))
      if (seq === 2) { await q.append('alpha', fixedRecord(seq, ['plain delivered'])); await q.append('alpha', deliveredRecord(seq)) }
    }
    const before = q.item('alpha', 1)!, reminders = q.replyReminderItems('alpha')
    const itemBytes = fs.readFileSync(queuePath(dir), 'utf8').split('\n').filter(line => line && JSON.parse(line).seq === 1 && JSON.parse(line).kind !== 'reply-reminder')
    await q.compact('alpha')
    expect(fs.readFileSync(queuePath(dir), 'utf8').split('\n').filter(line => line && JSON.parse(line).seq === 1 && JSON.parse(line).kind !== 'reply-reminder')).toEqual(itemBytes)
    expect(q.item('alpha', 1)).toEqual(before)
    expect(q.item('alpha', 1)!.delivered).toBe(true)
    expect(q.items('alpha').map(i => [i.accepted.seq, i.delivered])).toEqual([[1, true], [3, false]])
    expect(q.openCount('alpha')).toBe(1)
    expect(q.replyReminderItems('alpha')).toEqual(reminders)
    expect(q.item('alpha', 3)!.accepted.thread_join).toEqual(joinFact())
    const old = await readWithMain('main-retained')
    // The current record union includes hold resolutions; main's is a subset.
    // Compare the complete values without narrowing either snapshot or reader.
    expect(q.items('alpha')).toEqual(old.items)
    expect(old.open).toBe(1)
    expect(old.keys.map(k => k?.status)).toEqual(['duplicate', 'duplicate', 'duplicate'])
    await q.stop()
    const replay = await open({ now: clock.now, threadJoinSaved: predicate })
    expect(replay.item('alpha', 1)).toEqual(before)
    saved = true
    await replay.compact('alpha')
    expect(calls).toContainEqual({ key: 'alpha', channel: slackInput().channel, fact: joinFact() })
    expect(replay.item('alpha', 1)).toBeUndefined()
    expect(replay.lookupSlackKey('alpha', slackInput().key!)).toEqual({ status: 'duplicate', seq: 1 })
    expect(readQueue(dir)).toContainEqual({ v: 1, kind: 'accepted', seq: 1, compact: 'key', key: slackInput().key!, received_at: 1000, delivered_at: 1000 })
    for (const record of readQueue(dir).filter(r => 'compact' in r)) expect(record).not.toHaveProperty('thread_join')
    expect(replay.replyReminderItems('alpha')).toEqual(reminders)
    const confirmed = await readWithMain('main-confirmed')
    expect(replay.items('alpha')).toEqual(confirmed.items)
    expect(confirmed.open).toBe(1)
    expect(confirmed.keys[0]).toEqual({ status: 'duplicate', seq: 1 })
  })
})

describe('decided acceptance owns the persona writer turn', () => {
  test('afterStore runs after durability in the step that publishes the store; the next decision waits for it and sees it, and a concurrent duplicate never decides', async () => {
    const { io, gate, reached } = holdFirstSync(path => path === queuePath(dir))
    const order: string[] = []
    let joined = false, joinedWhenPublicationYields: boolean | undefined
    const q = await open({ fs: io.fs, onEvent: e => {
      if (e.type !== 'stored' || e.key !== 'alpha' || joinedWhenPublicationYields !== undefined) return
      order.push('stored')
      // Runs once the publishing step returns control: no other turn can see the store unjoined.
      queueMicrotask(() => { joinedWhenPublicationYields = joined })
    } })
    const first = slackInput({ via: 'mention' }), second = slackInput({ ts: THREAD_ROOTS.secondary, key: { ...first.key!, ts: THREAD_ROOTS.secondary } })
    const a = q.acceptDecided('alpha', first.key, ({ keyChecked }) => {
      expect(keyChecked).toBe(true); order.push('mention')
      return { store: first, afterStore: stored => {
        // Published and durable: readable, its bytes written and both syncs complete.
        expect(stored.seq).toBe(1)
        expect(q.item('alpha', 1)?.accepted.key).toEqual(first.key)
        expect(readQueue(dir)).toHaveLength(1)
        expect(io.busy()).toBe(false); expect(io.held()).toBe(0)
        joined = true; order.push('join')
      } }
    })
    const b = q.acceptDecided('alpha', second.key, ({ keyChecked }) => {
      expect(keyChecked).toBe(true); expect(joined).toBe(true); order.push('reply')
      return { store: { ...second, via: joined ? 'thread' : 'mention' } }
    })
    const duplicate = q.acceptDecided('alpha', first.key, () => { throw new Error('duplicate must not decide') })
    await reached()
    // The first store waits on its file sync: nothing published or joined, the next decision
    // waits, while timers and another persona's store run.
    expect(await new Promise<boolean>(resolve => setTimeout(() => resolve(true), 0))).toBe(true)
    expect((await q.accept('beta', injectedInput())).status).toBe('accepted')
    expect(order).toEqual(['mention']); expect(joined).toBe(false)
    expect(q.item('alpha', 1)).toBeUndefined(); expect(q.lookupSlackKey('alpha', first.key!)).toBeUndefined()
    gate.release()
    expect((await Promise.all([a, b, duplicate])).map(r => r.status)).toEqual(['accepted', 'accepted', 'duplicate'])
    expect(order).toEqual(['mention', 'stored', 'join', 'reply'])
    expect(joinedWhenPublicationYields).toBe(true)
    expect(q.items('alpha').map(i => [i.accepted.seq, i.accepted.via])).toEqual([[1, 'mention'], [2, 'thread']])
    expect(readQueue(dir)).toHaveLength(2)
  })

  test.each(['skip', 'store', 'afterStore throws', 'decide throws', 'append fails'] as const)('%s preserves durable outcomes and callback order', async outcome => {
    let fail = outcome === 'append fails'
    const order: string[] = [], skipped = { reason: 'drop', detail: { identity: true } }, error = new Error('decision failed')
    const q = await open({ onEvent: e => order.push(e.type), fs: failFileSyncs(() => fail, 'EIO acceptance') })
    const result = await q.acceptDecided('alpha', slackInput().key, ({ keyChecked }) => {
      expect(keyChecked).toBe(true); order.push('decide')
      if (outcome === 'skip') return { skip: skipped }
      if (outcome === 'decide throws') throw error
      return { store: slackInput(), afterStore: () => { order.push('afterStore'); if (outcome === 'afterStore throws') throw new Error('observer failed') } }
    })
    if (outcome === 'skip') {
      expect(result).toEqual({ status: 'skipped', outcome: skipped })
      if (result.status === 'skipped') expect(result.outcome).toBe(skipped)
      expect(order).toEqual(['decide']); expect(fs.existsSync(queuePath(dir))).toBe(false)
      expect(await q.accept('alpha', slackInput())).toMatchObject({ status: 'accepted', seq: 1 })
      expect(readQueue(dir)).toHaveLength(1)
    } else if (outcome === 'decide throws' || outcome === 'append fails') {
      expect(result.status).toBe('failed'); expect(order).toEqual(['decide', 'store-failed'])
      expect(q.items('alpha')).toEqual([]); expect(q.lookupSlackKey('alpha', slackInput().key!)).toBeUndefined()
      if (outcome === 'decide throws') expect(result).toEqual({ status: 'failed', error })
      fail = false
      expect(await q.acceptDecided('alpha', slackInput().key, () => ({ store: slackInput() }))).toMatchObject({ status: 'accepted', seq: 1 })
      expect(readQueue(dir)).toHaveLength(1)
    } else {
      expect(result).toMatchObject({ status: 'accepted', seq: 1 })
      expect(order).toEqual(['decide', 'stored', 'afterStore'])
      expect(readQueue(dir)).toHaveLength(1)
      await q.stop()
      expect((await open()).items('alpha')).toHaveLength(1)
    }
  })

  // The rows above keep an afterStore that ignores its argument.
  test("afterStore receives the stored record's seq, naming the item read back after reopen", async () => {
    const q = await open(), seen: Array<{ seq: number; key?: unknown }> = []
    // An earlier record keeps each stored seq away from 1 and from the journal's next seq.
    expect(await q.accept('alpha', injectedInput())).toMatchObject({ status: 'accepted', seq: 1 })
    const inputs = [THREAD_ROOTS.secondary, THREAD_ROOTS.third].map(ts => slackInput({ ts, key: { chat_id: 'C0TEST001', ts } }))
    for (const input of inputs) {
      const result = await q.acceptDecided('alpha', input.key, () => ({ store: input, afterStore: stored => {
        seen.push({ ...stored, key: q.item('alpha', stored.seq)?.accepted.key })
      } }))
      expect(result).toMatchObject({ status: 'accepted', seq: seen.at(-1)!.seq })
    }
    expect(seen).toEqual(inputs.map((input, i) => ({ seq: i + 2, key: input.key })))
    await q.stop()
    const reopened = await open()
    expect(seen.map(({ seq }) => reopened.item('alpha', seq)?.accepted.key)).toEqual(inputs.map(input => input.key))
  })

  test.each(['not started', 'stopped', 'unloadable'] as const)('%s still decides skips but refuses stores without a key check', async state => {
    const events: QueueEvent[] = [], q = createDeliveryQueue({ stateDir: dir, onEvent: e => events.push(e), fs: { ...fs,
      readFileSync(path: fs.PathOrFileDescriptor, ...args: unknown[]) {
        if (state === 'unloadable' && String(path) === queuePath(dir)) throw new Error('EIO journal read')
        return (fs.readFileSync as Function)(path, ...args)
      },
    } as typeof fs })
    queues.push(q)
    if (state === 'unloadable') seedQueue(dir, [accepted()])
    const bytes = fs.existsSync(queuePath(dir)) ? fs.readFileSync(queuePath(dir)) : undefined
    if (state !== 'not started') await q.start()
    if (state === 'stopped') await q.stop()
    const skipped = { reason: 'drop' }
    expect(await q.acceptDecided('alpha', slackInput().key, facts => { expect(facts).toEqual({ keyChecked: false }); return { skip: skipped } })).toEqual({ status: 'skipped', outcome: skipped })
    expect(events.filter(e => e.type === 'store-failed' || e.type === 'stored')).toEqual([])
    let after = false
    expect((await q.acceptDecided('alpha', slackInput().key, facts => {
      expect(facts).toEqual({ keyChecked: false }); return { store: slackInput(), afterStore: () => { after = true } }
    })).status).toBe('failed')
    expect(after).toBe(false)
    expect(events.filter(e => e.type === 'store-failed' || e.type === 'stored').map(e => e.type)).toEqual(['store-failed'])
    expect(fs.existsSync(queuePath(dir)) ? fs.readFileSync(queuePath(dir)) : undefined).toEqual(bytes)
  })

  test("other personas accept while one persona's earlier turn waits on a held sync; its queued turns then run in order", async () => {
    const { io, gate, reached } = holdFirstSync(path => path === queuePath(dir))
    const q = await open({ fs: io.fs }), order: string[] = []
    const head = q.accept('alpha', injectedInput())
    await reached()
    // Queued while the head's append holds the writer, so none joins the head's batch.
    const backlog = Array.from({ length: 20 }, (_, i) => q.acceptDecided('alpha', undefined, () => { order.push(`alpha:${i}`); return { skip: i } }))
    const decided = q.acceptDecided('beta', slackInput().key, () => { order.push('beta'); return { store: slackInput() } })
    const plain = q.accept('gamma', injectedInput()).then(r => { order.push('gamma'); return r })
    expect((await Promise.all([decided, plain])).map(r => r.status)).toEqual(['accepted', 'accepted'])
    expect([...order].sort()).toEqual(['beta', 'gamma'])
    expect(q.openCount('alpha')).toBe(0)
    gate.release()
    expect(await head).toMatchObject({ status: 'accepted', seq: 1 })
    await Promise.all(backlog)
    expect(order.filter(entry => entry.startsWith('alpha:'))).toEqual(Array.from({ length: 20 }, (_, i) => `alpha:${i}`))
    expect(q.openCount('alpha')).toBe(1)
    expect(q.openCount('beta')).toBe(1); expect(q.openCount('gamma')).toBe(1)
  })
})

describe('writer turns that wait on the disk', () => {
  test('an accept stays unpublished and unanswered until its directory sync completes', async () => {
    const h = holdFirstSync(path => path === join(dir, 'queue'))
    const q = await open({ fs: h.io.fs })
    h.state.armed = true
    let settled = false
    const pending = q.accept('alpha', slackInput()).then(result => { settled = true; return result })
    await h.reached()
    expect(fs.readFileSync(queuePath(dir), 'utf8')).toContain(slackInput().text!)
    expect(settled).toBe(false)
    expect(q.items('alpha')).toEqual([]); expect(q.lookupSlackKey('alpha', slackInput().key!)).toBeUndefined()
    h.gate.release()
    expect(await pending).toMatchObject({ status: 'accepted', seq: 1 })
    expect(q.lookupSlackKey('alpha', slackInput().key!)).toMatchObject({ status: 'duplicate', seq: 1 })
  })

  test("stop() during start()'s compaction waits for that journal's rewrite, then no further journal is compacted", async () => {
    const delivered = [accepted(), fixedRecord(), sentRecord(), deliveredRecord()]
    seedQueue(dir, delivered); seedQueue(dir, delivered, 'beta')
    const before = { alpha: fs.readFileSync(queuePath(dir)), beta: fs.readFileSync(queuePath(dir, 'beta')) }
    const h = holdFirstSync(path => path.endsWith('.tmp'))
    const q = createDeliveryQueue({ stateDir: dir, fs: h.io.fs }); queues.push(q)
    const starting = q.start()
    await h.reached()
    const first = h.state.path.startsWith(`${queuePath(dir)}.`) ? 'alpha' : 'beta', second = first === 'alpha' ? 'beta' : 'alpha'
    let stopped = false
    const stopping = q.stop().then(() => { stopped = true })
    await yieldToEventLoop()
    expect(stopped).toBe(false)
    h.gate.release()
    await Promise.all([starting, stopping])
    expect(fs.readFileSync(queuePath(dir, first))).not.toEqual(before[first])
    // Its delivered key is long past the keep window under the real clock.
    expect(readQueue(dir, first).map(r => 'compact' in r ? r.compact : r.kind)).toEqual(['allocation'])
    expect(fs.readFileSync(queuePath(dir, second))).toEqual(before[second])
    expect(fs.readdirSync(join(dir, 'queue')).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect((await q.accept('alpha', injectedInput())).status).toBe('failed')
  })

  test("stop() during start()'s first journal leaves a later damaged journal unloaded: no quarantine, its bytes unchanged", async () => {
    const damaged = '{"v":99,"kind":"accepted","seq":9,"text":"private queued body"}\n'
    for (const key of ['alpha', 'beta']) seedQueue(dir, [accepted(), damaged], key)
    const before = { alpha: fs.readFileSync(queuePath(dir)), beta: fs.readFileSync(queuePath(dir, 'beta')) }
    const h = holdFirstSync(path => path.startsWith(join(dir, 'queue') + '/'))
    const q = createDeliveryQueue({ stateDir: dir, fs: h.io.fs }); queues.push(q)
    const starting = q.start()
    await h.reached()
    const first = h.state.path.startsWith(join(dir, 'queue', 'alpha.')) ? 'alpha' : 'beta', second = first === 'alpha' ? 'beta' : 'alpha'
    const stopping = q.stop()
    h.gate.release()
    await Promise.all([starting, stopping])
    const names = fs.readdirSync(join(dir, 'queue'))
    expect(names.filter(name => name.startsWith(`${first}.unreadable-`))).toHaveLength(1)
    expect(names.filter(name => name.startsWith(`${second}.unreadable-`))).toEqual([])
    expect(fs.readFileSync(queuePath(dir, second))).toEqual(before[second])
    expect(h.io.steps.filter(step => step.path.startsWith(join(dir, 'queue', `${second}.`)))).toEqual([])
  })

  test('a compaction whose owner ends while its rollback repair waits on the disk repairs but does not rewrite', async () => {
    let failing = false
    const h = holdFirstSync(path => path === queuePath(dir))
    const seam = durableIo({ base: { ...h.io.fs,
      ftruncateSync(fd: number, length = 0) { if (failing) throw new Error('EIO rollback'); fs.ftruncateSync(fd, length) },
    } as typeof fs, before(step) { if (failing && step.op === 'fsync' && fs.fstatSync(step.fd!).isFile()) throw new Error('EIO append sync') } }).fs
    h.state.armed = false
    const q = await open({ fs: seam })
    await q.accept('alpha', injectedInput()); await q.append('alpha', fixedRecord()); await q.append('alpha', deliveredRecord())
    const boundary = fs.readFileSync(queuePath(dir))
    failing = true
    expect((await q.accept('alpha', injectedInput({ text: 'unaccepted' }))).status).toBe('failed')
    failing = false
    expect(fs.readFileSync(queuePath(dir)).length).toBeGreaterThan(boundary.length)
    let alive = true
    h.state.armed = true
    const compaction = q.compact('alpha', () => alive)
    await h.reached()
    alive = false
    h.gate.release()
    await compaction
    // Repaired to the accepted bytes exactly, and never rewritten.
    expect(fs.readFileSync(queuePath(dir))).toEqual(boundary)
    expect(h.io.steps.some(step => step.op === 'rename')).toBe(false)
    expect(fs.readdirSync(join(dir, 'queue')).filter(name => name.endsWith('.tmp'))).toEqual([])
    await q.compact('alpha')
    expect(h.io.steps.some(step => step.op === 'rename')).toBe(true)
    expect(q.items('alpha')).toEqual([])
  })

  test('a hold resolution whose owner ends while its first load awaits quarantine durability saves nothing', async () => {
    let unreadable = true
    const damaged = '{"v":99,"kind":"accepted","seq":9,"text":"private queued body"}\n'
    const held = { ...accepted(), ...heldSlackInput(memoryHold(THREAD_TIME)), received_at: THREAD_TIME }
    seedQueue(dir, [held, damaged])
    const h = holdFirstSync(path => path.includes('.unreadable-'))
    const q = createDeliveryQueue({ stateDir: dir, fs: { ...h.io.fs,
      readFileSync(path: fs.PathOrFileDescriptor, ...args: unknown[]) {
        if (unreadable && String(path) === queuePath(dir)) throw new Error('EIO journal read')
        return (fs.readFileSync as Function)(path, ...args)
      },
    } as typeof fs }); queues.push(q)
    await q.start()
    unreadable = false
    let alive = true
    const resolving = q.resolveHolds('alpha', [{ seq: 1, outcome: 'released', at: THREAD_TIME + 1 }], () => alive)
    await h.reached()
    alive = false
    h.gate.release()
    expect(await resolving).toEqual([])
    expect(readQueue(dir).map(r => r.kind)).toEqual(['accepted'])
    expect(q.unresolvedHolds('alpha').map(hold => hold.seq)).toEqual([1])
    expect(await q.resolveHolds('alpha', [{ seq: 1, outcome: 'released', at: THREAD_TIME + 1 }])).toHaveLength(1)
  })
})

describe('acceptances queued together share one durable append per batch', () => {
  test('QUEUE_GROUP_COMMIT_MAX is 8 (SR-4.1.1)', () => {
    expect(QUEUE_GROUP_COMMIT_MAX).toBe(8)
  })

  /** The persona journal's line count at each of its file fsyncs (appends and rollbacks); the next `fail` of them throw.
   * `dirs` holds, for each queue-directory fsync, how many of those file fsyncs preceded it. */
  function journalSyncs(key = 'alpha') {
    const rig = { lines: [] as number[], dirs: [] as number[], fail: 0 }
    return Object.assign(rig, { fs: durableIo({ before(step) {
      if (step.op === 'fsync' && step.path === join(dir, 'queue')) rig.dirs.push(rig.lines.length)
      if (step.op !== 'fsync' || step.path !== queuePath(dir, key)) return
      rig.lines.push(fs.readFileSync(queuePath(dir, key), 'utf8').split('\n').filter(Boolean).length)
      if (rig.fail > 0) { rig.fail--; throw new Error('EIO batch sync') }
    } }).fs })
  }
  /** A distinct Slack message per `i`. */
  const slackAt = (i: number) => { const ts = `1700000001.${String(i).padStart(6, '0')}`; return slackInput({ text: `m${i}`, ts, key: { chat_id: 'C0TEST001', ts } }) }
  const seqs = (results: ReadonlyArray<{ status: string; seq?: number }>) => results.map(r => r.status === 'accepted' ? r.seq : r.status)

  test('per-persona order holds across batches of at most QUEUE_GROUP_COMMIT_MAX, one append each, while another persona interleaves', async () => {
    const syncs = journalSyncs(), q = await open({ fs: syncs.fs, now: () => THREAD_TIME })
    const n = 2 * QUEUE_GROUP_COMMIT_MAX + 3
    const call = (key: string, i: number) => i % 3 === 0 ? q.accept(key, injectedInput({ text: `m${i}` }))
      : i % 3 === 1 ? q.accept(key, slackAt(i)) : q.acceptDecided(key, slackAt(i).key, () => ({ store: slackAt(i) }))
    const results = await Promise.all(Array.from({ length: n }, (_, i) => [call('alpha', i), call('beta', i)]).flat())
    expect(seqs(results)).toEqual(Array.from({ length: n }, (_, i) => [i + 1, i + 1]).flat())
    expect(syncs.lines).toEqual([QUEUE_GROUP_COMMIT_MAX, 2 * QUEUE_GROUP_COMMIT_MAX, n])
    for (const key of ['alpha', 'beta']) {
      const records = readQueue(dir, key) as AcceptedRecord[]
      expect(records.map(r => [r.seq, r.text])).toEqual(Array.from({ length: n }, (_, i) => [i + 1, `m${i}`]))
      // Injected timestamps share one received_at, so only the watermark carried across batches keeps them increasing.
      const injected = records.filter(r => r.source !== 'slack').map(r => BigInt(r.ts.replace('.', '')))
      expect(injected.every((ts, i) => i === 0 || ts > injected[i - 1]!)).toBe(true)
    }
    await q.stop()
    expect((await open()).items('alpha').map(i => i.accepted.text)).toEqual(Array.from({ length: n }, (_, i) => `m${i}`))
  })

  test.each([['file', () => queuePath(dir)], ['directory', () => join(dir, 'queue')]] as const)("no member is published or answered before the shared append's %s sync completes; its staged holds read as unresolved meanwhile", async (_, path) => {
    const h = holdFirstSync(p => p === path(), { armed: false })
    const q = await open({ fs: h.io.fs })
    h.state.armed = true
    const hold = heldSlackInput(memoryHold(THREAD_TIME)), settled: number[] = []
    const calls = [q.accept('alpha', slackInput()), q.acceptDecided('alpha', hold.key, () => ({ store: hold })), q.accept('alpha', injectedInput())]
      .map((pending, i) => pending.then(result => { settled.push(i); return result }))
    await h.reached()
    expect(readQueue(dir).map(r => r.seq)).toEqual([1, 2, 3])
    await yieldToEventLoop()
    expect(settled).toEqual([])
    expect(q.items('alpha')).toEqual([])
    expect(q.lookupSlackKey('alpha', slackInput().key!)).toBeUndefined(); expect(q.lookupSlackKey('alpha', hold.key!)).toBeUndefined()
    expect(q.unresolvedHolds('alpha').map(entry => entry.seq)).toEqual([2])
    h.gate.release()
    expect(seqs(await Promise.all(calls))).toEqual([1, 2, 3])
    expect(settled).toEqual([0, 1, 2])
    expect(q.unresolvedHolds('alpha').map(entry => entry.seq)).toEqual([2])
    expect(h.io.steps.filter(step => step.op === 'fsync' && step.path === queuePath(dir))).toHaveLength(1)
  })

  test('a failed append fails its whole batch once, with no retry and its bytes rolled back; the next batch reuses the unpublished seqs', async () => {
    const syncs = journalSyncs(), events: QueueEvent[] = []
    const q = await open({ fs: syncs.fs, onEvent: e => events.push(e) })
    expect(await q.accept('alpha', slackAt(0))).toMatchObject({ status: 'accepted', seq: 1 })
    const boundary = fs.readFileSync(queuePath(dir))
    events.length = 0; syncs.lines.length = 0; syncs.fail = 1
    const hold = heldSlackInput(memoryHold(THREAD_TIME)), n = QUEUE_GROUP_COMMIT_MAX + 2
    const results = await Promise.all(Array.from({ length: n }, (_, i) => i === 1 ? q.acceptDecided('alpha', hold.key, () => ({ store: hold })) : q.accept('alpha', slackAt(i + 1))))
    expect(seqs(results)).toEqual([...Array<string>(QUEUE_GROUP_COMMIT_MAX).fill('failed'), 2, 3])
    // The failed append holds the whole batch; its rollback; then only the next batch: no member is written twice.
    expect(syncs.lines).toEqual([1 + QUEUE_GROUP_COMMIT_MAX, 1, 3])
    expect(events.map(e => e.type)).toEqual([...Array<QueueEvent['type']>(QUEUE_GROUP_COMMIT_MAX).fill('store-failed'), 'stored', 'stored'])
    expect(fs.readFileSync(queuePath(dir)).subarray(0, boundary.length)).toEqual(boundary)
    expect(readQueue(dir).map(r => [r.seq, (r as AcceptedRecord).text])).toEqual([[1, 'm0'], [2, `m${n - 1}`], [3, `m${n}`]])
    expect(q.unresolvedHolds('alpha')).toEqual([])
    expect(q.lookupSlackKey('alpha', hold.key!)).toBeUndefined(); expect(q.lookupSlackKey('alpha', slackAt(1).key!)).toBeUndefined()
  })

  test('stop() during a multi-batch group waits for every member: a later plain accept still stores, a later acceptDecided is refused, and nothing syncs after stop resolves', async () => {
    const h = holdFirstSync(p => p === queuePath(dir), { armed: false }), events: QueueEvent[] = []
    const q = await open({ fs: h.io.fs, onEvent: e => events.push(e) })
    h.state.armed = true
    const settled: number[] = []
    const decided = slackAt(QUEUE_GROUP_COMMIT_MAX)
    const calls = [
      ...Array.from({ length: QUEUE_GROUP_COMMIT_MAX }, (_, i) => q.accept('alpha', slackAt(i))),
      q.acceptDecided('alpha', decided.key, () => ({ store: decided })),
      q.accept('alpha', slackAt(QUEUE_GROUP_COMMIT_MAX + 1)),
    ].map((pending, i) => pending.then(result => { settled.push(i); return result }))
    await h.reached()
    let stopped = false
    const stopping = q.stop().then(() => { stopped = true })
    await yieldToEventLoop()
    expect(stopped).toBe(false); expect(settled).toEqual([])
    h.gate.release()
    await stopping
    expect(settled.sort((a, b) => a - b)).toEqual(Array.from({ length: calls.length }, (_, i) => i))
    const syncs = h.io.steps.filter(step => step.op === 'fsync').length
    const results = await Promise.all(calls)
    expect(seqs(results)).toEqual([...Array.from({ length: QUEUE_GROUP_COMMIT_MAX }, (_, i) => i + 1), 'failed', QUEUE_GROUP_COMMIT_MAX + 1])
    expect(events.filter(e => e.type === 'store-failed')).toEqual([expect.objectContaining({ type: 'store-failed', key: 'alpha', ts: decided.ts })])
    expect(readQueue(dir).map(r => [r.seq, (r as AcceptedRecord).text])).toEqual(
      [...Array.from({ length: QUEUE_GROUP_COMMIT_MAX }, (_, i) => [i + 1, `m${i}`]), [QUEUE_GROUP_COMMIT_MAX + 1, `m${QUEUE_GROUP_COMMIT_MAX + 1}`]])
    await yieldToEventLoop()
    expect(h.io.steps.filter(step => step.op === 'fsync')).toHaveLength(syncs)
  })

  test('a decision with afterStore closes its batch, so the next decision runs after that store is durable and sees its effect', async () => {
    const syncs = journalSyncs(), q = await open({ fs: syncs.fs })
    let joined = false
    const seen: Array<[boolean, number]> = []
    const results = await Promise.all([
      q.accept('alpha', slackAt(0)),
      q.acceptDecided('alpha', slackAt(1).key, () => ({ store: slackAt(1), afterStore: () => { joined = true } })),
      q.acceptDecided('alpha', slackAt(2).key, () => { seen.push([joined, readQueue(dir).length]); return { store: slackAt(2) } }),
      q.accept('alpha', slackAt(3)),
    ])
    expect(seqs(results)).toEqual([1, 2, 3, 4])
    expect(seen).toEqual([[true, 2]])
    expect(syncs.lines).toEqual([2, 4])
  })

  test("a member whose Slack key a staged record holds commits the batch first, so it is answered as that record's duplicate without deciding", async () => {
    const syncs = journalSyncs(), q = await open({ fs: syncs.fs })
    const results = await Promise.all([
      q.accept('alpha', slackAt(0)), q.accept('alpha', injectedInput()),
      q.acceptDecided('alpha', slackAt(0).key, () => { throw new Error('duplicate must not decide') }),
      q.accept('alpha', slackAt(0)), q.accept('alpha', slackAt(1)),
    ])
    expect(results.map(r => [r.status, 'seq' in r ? r.seq : undefined])).toEqual([['accepted', 1], ['accepted', 2], ['duplicate', 1], ['duplicate', 1], ['accepted', 3]])
    expect(syncs.lines).toEqual([2, 3])
    expect(readQueue(dir).map(r => (r as AcceptedRecord).text)).toEqual(['m0', 'prompt', 'm1'])
  })

  test('other work queued for the persona closes the forming group, so later acceptances never pass it; only the creating group syncs the queue directory', async () => {
    const syncs = journalSyncs(), q = await open({ fs: syncs.fs })
    await Promise.all([q.accept('alpha', slackAt(0)), q.accept('alpha', slackAt(1)), q.append('alpha', fixedRecord(1)), q.accept('alpha', slackAt(2)), q.accept('alpha', slackAt(3))])
    expect(readQueue(dir).map(r => [r.kind, r.seq])).toEqual([['accepted', 1], ['accepted', 2], ['fixed', 1], ['accepted', 3], ['accepted', 4]])
    expect(syncs.lines).toEqual([2, 3, 5])
    expect(syncs.dirs).toEqual([1])
  })

  test("a burst of one persona's acceptances takes one durable append per QUEUE_GROUP_COMMIT_MAX members, not one per member, and syncs the queue directory once, at creation", async () => {
    // The size of the integration suite's thread burst.
    const burst = 2001, writes: string[] = []
    const io = durableIo({ base: { ...fs, writeSync(fd: number, ...rest: unknown[]) {
      writes.push(io.paths.get(fd) ?? '<unknown-fd>')
      return (fs.writeSync as Function)(fd, ...rest)
    } } as typeof fs })
    const q = await open({ fs: io.fs })
    const results = await Promise.all(Array.from({ length: burst }, (_, i) => q.accept('alpha', slackAt(i))))
    expect(seqs(results)).toEqual(Array.from({ length: burst }, (_, i) => i + 1))
    const groups = Math.ceil(burst / QUEUE_GROUP_COMMIT_MAX)
    expect(writes.filter(path => path === queuePath(dir))).toHaveLength(groups)
    expect(io.steps.filter(step => step.op === 'fsync' && step.path === queuePath(dir))).toHaveLength(groups)
    expect(io.steps.filter(step => step.op === 'fsync' && step.path === join(dir, 'queue'))).toHaveLength(1)
    expect(readQueue(dir)).toHaveLength(burst)
  })
})

describe('a journal loaded after start', () => {
  /** alpha's journal is unreadable at start() until `heal`, beta's is read by start(); each hook call records the load it sees.
   * The refused read fails before opening the file, so alpha's first load after `heal` is its first opening. */
  async function lateLoad(throws = false, base: typeof fs = fs) {
    let unreadable = true
    const calls: Array<[string, number]> = []
    seedQueue(dir, [accepted()]); seedQueue(dir, [accepted()], 'beta')
    const q: DeliveryQueue = createDeliveryQueue({ stateDir: dir, fs: { ...base,
      readFileSync(path: fs.PathOrFileDescriptor, ...args: unknown[]) {
        if (unreadable && String(path) === queuePath(dir)) throw new Error('EIO journal read')
        return (base.readFileSync as Function)(path, ...args)
      },
    } as typeof fs, onLoadedAfterStart: key => {
      calls.push([key, q.items(key).length])
      if (throws) throw new Error('fixture hook failed')
    } })
    queues.push(q)
    await q.start()
    return { q, calls, heal: () => { unreadable = false } }
  }
  const later = (ts: string) => slackInput({ ts, key: { chat_id: 'C0TEST001', ts } })

  test.each([false, true])('calls the hook once, in the loading turn before its own work, with the load published; throws=%p', async throws => {
    const { q, calls, heal } = await lateLoad(throws)
    // Neither start()'s load nor a failed one calls it.
    expect(q.items('beta')).toHaveLength(1)
    expect(calls).toEqual([])
    heal()
    const order: string[] = []
    const result = await q.acceptDecided('alpha', later(THREAD_ROOTS.secondary).key, () => { order.push(`decide after ${calls.length}`); return { store: later(THREAD_ROOTS.secondary) } })
    expect(calls).toEqual([['alpha', 1]])
    expect(order).toEqual(['decide after 1'])
    // A thrown hook leaves the load and the turn's own store in place.
    expect(result).toMatchObject({ status: 'accepted', seq: 2 })
    // No second load, no missing journal and no other key's start() load calls it again.
    await q.accept('alpha', later(THREAD_ROOTS.third)); await q.compact('alpha')
    await q.accept('gamma', injectedInput()); await q.accept('beta', later(THREAD_ROOTS.third))
    expect(calls).toEqual([['alpha', 1]])
    // A journal that appears after start() calls it at its first load.
    seedQueue(dir, [accepted()], 'delta')
    expect(await q.accept('delta', later(THREAD_ROOTS.secondary))).toMatchObject({ status: 'accepted', seq: 2 })
    expect(calls).toEqual([['alpha', 1], ['delta', 1]])
  })

  test('a load after stop() does not call the hook', async () => {
    const { q, calls, heal } = await lateLoad()
    heal(); await q.stop()
    await q.compact('alpha')
    expect(q.items('alpha')).toHaveLength(1)
    expect(calls).toEqual([])
  })

  test("its first load opens it: the turn's acceptance is answered, published and observed only after a queue-directory sync, and later acceptances sync only the journal", async () => {
    const h = holdFirstSync(path => path === join(dir, 'queue'), { armed: false })
    const { q, heal } = await lateLoad(false, h.io.fs)
    heal(); h.state.armed = true
    const from = h.io.steps.length, input = later(THREAD_ROOTS.secondary)
    let observed = false, settled = false
    const pending = q.acceptDecided('alpha', input.key, () => ({ store: input, afterStore: () => { observed = true } })).then(result => { settled = true; return result })
    await Promise.race([h.reached(), pending])
    expect(h.state.armed).toBe(false)
    expect(fs.readFileSync(queuePath(dir), 'utf8')).toContain(input.ts!)
    await yieldToEventLoop()
    expect({ settled, observed }).toEqual({ settled: false, observed: false })
    expect(q.items('alpha').map(item => item.accepted.seq)).toEqual([1])
    expect(q.lookupSlackKey('alpha', input.key!)).toBeUndefined()
    h.gate.release()
    expect(await pending).toMatchObject({ status: 'accepted', seq: 2 })
    expect(observed).toBe(true)
    expect(await q.accept('alpha', later(THREAD_ROOTS.third))).toMatchObject({ status: 'accepted', seq: 3 })
    expect(fsyncTargets(h.io.steps.slice(from))).toEqual(['journal', 'queue', 'journal'])
  })
})

describe('the queue directory is synced only while a journal entry may not be durable', () => {
  const damaged = '{"v":99,"kind":"accepted","seq":9,"text":"private queued body"}\n'
  test.each([
    { compaction: 'its own start compaction succeeds', keys: ['alpha'], failTemps: 0, start: ['temp', 'queue'], first: ['journal'] },
    { compaction: 'its start rewrite fails before the rename', keys: ['alpha'], failTemps: 1, start: ['temp'], first: ['journal', 'queue'] },
    { compaction: "its start rewrite fails before the rename and another journal's start compaction succeeds after its read", keys: ['alpha', 'beta'], failTemps: 1,
      start: ['temp', 'temp', 'queue'], first: ['journal'] },
    { compaction: 'start quarantines its damaged line into a new file, then repairs and compacts it', keys: ['alpha'], failTemps: 0, damaged: true,
      start: ['quarantine', 'queue', 'temp', 'queue', 'temp', 'queue'], first: ['journal'] },
  ])('a journal that existed before start, where $compaction: start syncs $start, then its first acceptance $first', async ({ keys, failTemps, damaged: damage, start, first }) => {
    for (const key of keys) seedQueue(dir, [accepted(), ...(damage ? [damaged] : [])], key)
    // The measured journal is the one whose rewrite failed, whichever start compacts first.
    let left = failTemps, key = 'alpha'
    const io = durableIo({ before(step) {
      if (step.op !== 'fsync' || !step.path.endsWith('.tmp') || left === 0) return
      left--; key = basename(step.path).split('.')[0]!
      throw new Error('EIO temp sync')
    } })
    const q = await open({ fs: io.fs })
    expect(fsyncTargets(io.steps, key)).toEqual(['parent', ...start])
    const from = io.steps.length
    expect((await q.accept(key, injectedInput())).status).toBe('accepted')
    expect(fsyncTargets(io.steps.slice(from), key)).toEqual([...first])
  })
})

describe('Memory Hold queue records', () => {
  const heldRecord = (hold: HoldField = memoryHold(THREAD_TIME)): AcceptedRecord => ({ ...accepted(), ...heldSlackInput(hold), received_at: THREAD_TIME })
  async function storeHold(q: DeliveryQueue, at: number, overrides: Partial<AcceptedInput> = {}, key = 'alpha', hold: (at: number) => HoldField = memoryHold) {
    const input = heldSlackInput(hold(at), overrides)
    const result = await q.acceptDecided(key, input.key, () => ({ store: input }))
    expect(result.status).toBe('accepted')
    if (result.status !== 'accepted' || !result.item) throw new Error('hold was not stored')
    return result.item
  }
  // Both readers compact at start. Reject only writes to inspect their loaded
  // state before compaction removes delivered items or rewrites released holds.
  const readOnlyFs = { ...fs,
    openSync(path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
      if (typeof flags !== 'string' || /[wa+]/.test(flags)) throw new Error('read-only replay')
      return fs.openSync(path, flags, mode)
    },
  } as typeof fs

  test.each([['memory', false], ['memory', true], ['post', false], ['post', true]] as const)('one accepting append protects an in-flight %s hold; store failure=%p', async (kind, fail) => {
    const clock = createFakeClock({ start: THREAD_TIME }), writes: Buffer[] = [], events: QueueEvent[] = []
    const observations: ReturnType<DeliveryQueue['unresolvedHolds']>[] = []
    const io = durableIo({ base: { ...fs,
      writeSync(fd: number, bytes: Uint8Array, offset: number, length: number, position: number | null) {
        if (io.paths.get(fd) === queuePath(dir)) {
          observations.push(q.unresolvedHolds('alpha'))
          writes.push(Buffer.from(bytes.subarray(offset, offset + length)))
        }
        return fs.writeSync(fd, bytes, offset, length, position)
      },
    } as typeof fs, before(step) {
      if (step.op !== 'fsync' || step.path !== queuePath(dir)) return
      observations.push(q.unresolvedHolds('alpha'))
      if (fail) throw new Error('EIO hold store')
    } })
    const seam = io.fs
    const q = await open({ now: clock.now, fs: seam, onEvent: e => events.push(e) })
    const hold = kind === 'post' ? postHold(clock.now(), { operations: ['post-one', 'post-two'] }) : memoryHold(clock.now())
    const input = heldSlackInput(hold, { text: 'held exact\nbytes🙂', queued_ack_reaction: 'original_queue' })
    const result = await q.acceptDecided('alpha', input.key, () => ({ store: input }))
    const record: AcceptedRecord = { ...input, v: 1, kind: 'accepted', seq: 1, received_at: clock.now(), ts: input.ts! }
    // A Post Hold's root was known here, so it does not depend on Thread Memory.
    const expected = [{ ...input.hold!, seq: 1, channel: input.channel!, memoryDependent: kind === 'memory' }]
    expect(writes).toEqual([Buffer.from(JSON.stringify(record) + '\n')])
    expect(observations.length).toBeGreaterThanOrEqual(2)
    for (const observed of observations) expect(observed).toEqual(expected)
    expect(result.status).toBe(fail ? 'failed' : 'accepted')
    expect(q.unresolvedHolds('alpha')).toEqual(fail ? [] : expected)
    expect(q.openCount('alpha')).toBe(0)
    expect(readQueue(dir)).toEqual(fail ? [] : [record])
    if (!fail) {
      await q.stop()
      const replay = await open({ now: clock.now })
      expect(replay.item('alpha', 1)!.accepted).toMatchObject(record)
      expect(replay.item('alpha', 1)!.hold).toEqual({ field: input.hold!, kind, state: 'unresolved' })
      expect(replay.unresolvedHolds('alpha')).toEqual(expected)
      expect(replay.openCount('alpha')).toBe(0)
      expect(isOpenItem(replay.item('alpha', 1)!)).toBe(false)
    }
    assertNoLeak(events)
    expect(JSON.stringify(events)).not.toContain(input.text)
  })

  const badHolds: [string, unknown][] = [
    ['missing on', { ...memoryHold(THREAD_TIME), on: undefined }],
    ['missing root', { ...memoryHold(THREAD_TIME), thread_ts: undefined }],
    ['missing stamp', { ...memoryHold(THREAD_TIME), stamp: undefined }],
    ['missing arrival', { ...memoryHold(THREAD_TIME), arrived_at: undefined }],
    ['extra hold key', { ...memoryHold(THREAD_TIME), extra: true }],
    ['unknown on', { ...memoryHold(THREAD_TIME), on: 'future' }],
    ['bad root', { ...memoryHold(THREAD_TIME), thread_ts: '1.1' }],
    ['empty incarnation', memoryHold(THREAD_TIME, { stamp: { ...THREAD_STAMP, incarnation: '' } })],
    ['empty since', memoryHold(THREAD_TIME, { stamp: { ...THREAD_STAMP, threadHybridSince: '' } })],
    ['extra stamp key', { ...memoryHold(THREAD_TIME), stamp: { ...THREAD_STAMP, extra: true } }],
    ['non-finite arrival', memoryHold(Infinity)],
    ['null hold', null],
    ['memory hold with operations', { ...memoryHold(THREAD_TIME), operations: ['post-one'] }],
    ['memory hold with root_unknown', { ...memoryHold(THREAD_TIME), root_unknown: true }],
    ['post empty operations', postHold(THREAD_TIME, { operations: [] })],
    ['post repeated operation', postHold(THREAD_TIME, { operations: ['post-one', 'post-one'] })],
    ['post empty operation ID', postHold(THREAD_TIME, { operations: ['post-one', ''] })],
    ['post non-string operation ID', { ...postHold(THREAD_TIME), operations: [7] }],
    ['post operations not a list', { ...postHold(THREAD_TIME), operations: 'post-one' }],
    ...(['operations', 'thread_ts', 'stamp', 'root_unknown', 'arrived_at'] as const).map((key): [string, unknown] => [`post missing ${key}`, { ...postHold(THREAD_TIME), [key]: undefined }]),
    ['post extra key', { ...postHold(THREAD_TIME), extra: true }],
    ['post bad root', postHold(THREAD_TIME, { thread_ts: '1.1' })],
    ['post empty incarnation', postHold(THREAD_TIME, { stamp: { ...THREAD_STAMP, incarnation: '' } })],
    ['post empty since', postHold(THREAD_TIME, { stamp: { ...THREAD_STAMP, threadHybridSince: '' } })],
    ['post non-boolean root_unknown', { ...postHold(THREAD_TIME), root_unknown: 'false' }],
    ['post non-finite arrival', postHold(NaN)],
  ]
  // Each kind's form is rejected on records that may not carry a hold.
  const misplaced = (label: string, hold: HoldField): [string, () => unknown][] => [
    ...['interject', 'cron'].map(source => [`${label} on ${source}`, () => ({ ...heldRecord(hold), source, sender: source, key: undefined })] as [string, () => unknown]),
    ...['mention', 'broadcast', 'all', 'dm', ''].map(via => [`${label} via ${via}`, () => ({ ...heldRecord(hold), via })] as [string, () => unknown]),
    [`${label} beside thread_join`, () => ({ ...heldRecord(hold), thread_join: { thread_ts: THREAD_ROOTS.primary, stamp: THREAD_STAMP, at: THREAD_TIME } })],
    ...[fixedRecord, sentRecord, deliveredRecord, refusedRecord, noticedRecord].map(build => [`${label} on ${build().kind}`, () => ({ ...build(), hold })] as [string, () => unknown]),
  ]
  const invalid: [string, () => unknown][] = [
    ...badHolds.map(([label, hold]): [string, () => unknown] => [label, () => ({ ...heldRecord(), hold })]),
    ...misplaced('hold', memoryHold(THREAD_TIME)),
    ...misplaced('post hold', postHold(THREAD_TIME)),
    ['non-finite released_at', () => ({ ...accepted(), released_at: Infinity })],
    ...[fixedRecord, sentRecord, deliveredRecord, refusedRecord, noticedRecord].map(build =>
      [`released_at on ${build().kind}`, () => ({ ...build(), released_at: THREAD_TIME })] as [string, () => unknown]),
    ...[releasedRecord, withdrawnRecord, parkedRecord].flatMap(build => [
      [`${build().kind} missing at`, () => ({ ...build(), at: undefined })],
      [`${build().kind} non-finite at`, () => ({ ...build(), at: NaN })],
      [`${build().kind} extra field`, () => ({ ...build(), extra: true })],
      [`${build().kind} invalid sequence`, () => ({ ...build(), seq: -1 })],
      [`${build().kind} invalid version`, () => ({ ...build(), v: 2 })],
    ] as [string, () => unknown][]),
  ]
  test.each(invalid)('rejects %s', (_, build) => {
    const record = build()
    expect(isQueueRecord(record)).toBe(false)
    expect(parseQueueRecord(JSON.stringify(record))).toBeUndefined()
  })

  test('compacted key and allocation records reject hold, join and release fields', async () => {
    const clock = createFakeClock({ start: THREAD_TIME }), q = await open({ now: clock.now })
    await storeHold(q, clock.now())
    await q.resolveHolds('alpha', [{ seq: 1, outcome: 'withdrawn', at: clock.now() }])
    await q.compact('alpha')
    const records = readQueue(dir)
    expect(records).toHaveLength(2)
    for (const record of records) {
      expect(isMainQueueRecord(record)).toBe(true)
      for (const field of [{ hold: memoryHold(clock.now()) }, { hold: postHold(clock.now()) }, { released_at: clock.now() }, { thread_join: { thread_ts: THREAD_ROOTS.primary, stamp: THREAD_STAMP, at: clock.now() } }]) {
        expect(isQueueRecord({ ...record, ...field })).toBe(false)
      }
    }
  })

  test.each([releasedRecord, withdrawnRecord, parkedRecord])('%p roundtrips; damaged resolution is quarantined without alerting for a loaded sequence', async build => {
    const record = build(1, THREAD_TIME)
    expect(parseQueueRecord(JSON.stringify(record))).toEqual(record)
    const damaged = JSON.stringify({ ...record, at: null }) + '\n'
    // Not the final line: the loaded-sequence rule, not torn-tail suppression.
    seedQueue(dir, [heldRecord(), damaged, { ...accepted(), seq: 2 }])
    const q = await open({ now: createFakeClock({ start: THREAD_TIME }).now })
    expect(q.startupFindings()).toMatchObject([{ type: 'record-unreadable', line: 2, alert: false }])
    const finding = q.startupFindings()[0]!
    if (finding.type !== 'record-unreadable') throw new Error('expected damaged resolution')
    expect(fs.readFileSync(finding.quarantinePath, 'utf8')).toBe(damaged)
    expect(q.item('alpha', 1)!.hold?.state).toBe('unresolved')
    expect(q.openCount('alpha')).toBe(1)
    assertNoLeak(q.startupFindings())
  })

  test.each([
    ['plain', undefined, true, THREAD_TIME],
    ['unresolved', undefined, false, THREAD_TIME],
    ['released', 'released', true, THREAD_TIME + 50],
    ['withdrawn', 'withdrawn', false, THREAD_TIME],
    ['parked', 'parked', false, THREAD_TIME],
    ['compacted released', 'released', true, THREAD_TIME + 50],
  ] as const)('%s has the correct open-work count and age', async (state, outcome, isOpen, openedAt) => {
    const clock = createFakeClock({ start: THREAD_TIME }), q = await open({ now: clock.now })
    if (state === 'plain') await q.accept('alpha', slackInput())
    else await storeHold(q, clock.now())
    await clock.advance(50)
    if (outcome) await q.resolveHolds('alpha', [{ seq: 1, outcome, at: clock.now() }])
    if (state === 'compacted released') await q.compact('alpha')
    const item = q.item('alpha', 1)!
    expect(isOpenItem(item)).toBe(isOpen)
    expect(itemOpenedAt(item)).toBe(openedAt)
    expect(q.openCount('alpha')).toBe(Number(isOpen))
    expect(q.unresolvedHolds('alpha').map(h => h.seq)).toEqual(state === 'unresolved' || state === 'parked' ? [1] : [])
    if (state === 'plain' || state === 'compacted released') expect(item.hold).toBeUndefined()
    if (state === 'compacted released') expect(item.accepted.released_at).toBe(openedAt)
    if (isOpen) {
      await q.append('alpha', fixedRecord())
      await q.append('alpha', deliveredRecord(1, clock.now()))
      expect(isOpenItem(q.item('alpha', 1)!)).toBe(false)
      expect(q.openCount('alpha')).toBe(0)
    }
  })

  // The last column is the effective kind of a Post Hold whose root was unknown:
  // only a parked record before the first released/withdrawn makes it a Memory Hold.
  const loadRules = [
    ['release first', [parkedRecord(1, THREAD_TIME), releasedRecord(1, THREAD_TIME + 50), withdrawnRecord(1, THREAD_TIME + 10)], 'released', THREAD_TIME + 50, 'memory'],
    ['withdraw first', [withdrawnRecord(1, THREAD_TIME + 50), releasedRecord(1, THREAD_TIME + 10), parkedRecord(1, THREAD_TIME + 60)], 'withdrawn', THREAD_TIME + 50, 'post'],
    ['park after release', [releasedRecord(1, THREAD_TIME + 50), parkedRecord(1, THREAD_TIME + 60)], 'released', THREAD_TIME + 50, 'post'],
    ['fixed only', [fixedRecord()], 'released', THREAD_TIME, 'post'],
    ['sent only', [{ ...sentRecord(), at: THREAD_TIME + 40 }], 'released', THREAD_TIME + 40, 'post'],
    ['delivered only', [deliveredRecord(1, THREAD_TIME + 30)], 'released', THREAD_TIME + 30, 'post'],
    ['earliest send or receipt', [fixedRecord(1, ['one', 'two']), { ...sentRecord(), at: THREAD_TIME + 40 }, deliveredRecord(1, THREAD_TIME + 30), { ...sentRecord(1, 2), at: THREAD_TIME + 20 }], 'released', THREAD_TIME + 20, 'post'],
  ] as const
  test.each(loadRules.flatMap(([label, records, state, at, unknownRootKind]) => [
    [label, 'Memory Hold', memoryHold(THREAD_TIME), records, state, at, 'memory'],
    [label, 'known-root Post Hold', postHold(THREAD_TIME), records, state, at, 'post'],
    [label, 'unknown-root Post Hold', unknownRootPostHold(THREAD_TIME), records, state, at, unknownRootKind],
  ] as const))('replay uses %s and preserves its decision time (%s)', async (_, _hold, field, records, state, at, kind) => {
    seedQueue(dir, [heldRecord(field), ...records])
    const q = await open({ fs: readOnlyFs, now: createFakeClock({ start: THREAD_TIME }).now })
    expect(q.item('alpha', 1)!.hold).toEqual({ field, kind, state, at })
    expect(q.unresolvedHolds('alpha')).toEqual([])
    expect(q.openCount('alpha')).toBe(Number(state === 'released'))
    expect(itemOpenedAt(q.item('alpha', 1)!)).toBe(state === 'released' ? at : THREAD_TIME)
  })

  test('a resolution on a hold-less item has no effect during replay', async () => {
    seedQueue(dir, [accepted(), withdrawnRecord()])
    const q = await open({ fs: readOnlyFs })
    expect(q.item('alpha', 1)!.hold).toBeUndefined()
    expect(q.openCount('alpha')).toBe(1)
    expect(itemOpenedAt(q.item('alpha', 1)!)).toBe(accepted().received_at)
  })

  // Each step is one resolveHolds call; saved says whether it appends.
  test.each([
    ['an unknown-root Post Hold parks', unknownRootPostHold, ['parked'], [true], 'memory', 'unresolved'],
    ['a known-root Post Hold does not park', postHold, ['parked'], [false], 'post', 'unresolved'],
    ['a Memory Hold does not park', memoryHold, ['parked'], [false], 'memory', 'unresolved'],
    ['a parked hold does not park again', unknownRootPostHold, ['parked', 'parked'], [true, false], 'memory', 'unresolved'],
    ['a released hold does not park', unknownRootPostHold, ['released', 'parked'], [true, false], 'post', 'released'],
    ['a withdrawn hold does not park', unknownRootPostHold, ['withdrawn', 'parked'], [true, false], 'post', 'withdrawn'],
    ['a parked hold is released', unknownRootPostHold, ['parked', 'released'], [true, true], 'memory', 'released'],
    ['a parked hold is withdrawn', unknownRootPostHold, ['parked', 'withdrawn'], [true, true], 'memory', 'withdrawn'],
    ['a known-root Post Hold is released', postHold, ['released'], [true], 'post', 'released'],
    ['a known-root Post Hold is withdrawn', postHold, ['withdrawn'], [true], 'post', 'withdrawn'],
  ] as const)('%s', async (_, build, outcomes: readonly HoldOutcome[], saved: readonly boolean[], kind, state) => {
    const clock = createFakeClock({ start: THREAD_TIME }), events: QueueEvent[] = []
    let q = await open({ now: clock.now, onEvent: e => events.push(e) })
    const item = await storeHold(q, clock.now(), {}, 'alpha', build), field = item.accepted.hold!
    let decidedAt: number | undefined
    for (const [i, outcome] of outcomes.entries()) {
      await clock.advance(10)
      const resolution: HoldResolution = { seq: 1, outcome, at: clock.now() }, before = fs.readFileSync(queuePath(dir))
      events.length = 0
      expect(await q.resolveHolds('alpha', [resolution])).toEqual(saved[i] ? [resolution] : [])
      // A withdrawn hold's record kind is `hold-withdrawn`, apart from a Reaction Item's `withdrawn`.
      const record = { v: 1, kind: outcome === 'withdrawn' ? 'hold-withdrawn' : outcome, seq: 1, at: resolution.at } as const
      expect(fs.readFileSync(queuePath(dir))).toEqual(saved[i] ? Buffer.concat([before, Buffer.from(JSON.stringify(record) + '\n')]) : before)
      expect(events).toEqual(saved[i] ? [{ type: 'holds-resolved', key: 'alpha', resolutions: [resolution] }] : [])
      if (saved[i] && outcome !== 'parked') decidedAt = resolution.at
    }
    // A parked Post Hold is listed in the Memory Hold form, for k8's resolver and heldStamps.
    const entry = kind === 'memory' ? { ...memoryHold(THREAD_TIME), seq: 1, channel: item.accepted.channel!, memoryDependent: true }
      : { ...field, seq: 1, channel: item.accepted.channel!, memoryDependent: false }
    const check = (queue: DeliveryQueue) => {
      const summary = queue.item('alpha', 1)!
      expect(summary.hold).toEqual(decidedAt === undefined ? { field, kind, state } : { field, kind, state, at: decidedAt })
      expect(queue.unresolvedHolds('alpha')).toEqual(state === 'unresolved' ? [entry] : [])
      expect(queue.openCount('alpha')).toBe(Number(state === 'released'))
      expect(itemOpenedAt(summary)).toBe(decidedAt !== undefined && state === 'released' ? decidedAt : THREAD_TIME)
    }
    check(q)
    await q.stop()
    q = await open({ fs: readOnlyFs, now: clock.now })
    check(q)
    assertNoLeak(events)
  })

  test('resolution batches save once, filter resolved/absent holds and publish only after durable sync', async () => {
    const clock = createFakeClock({ start: THREAD_TIME }), events: QueueEvent[] = [], writes: Buffer[] = []
    let resolving = false, checkedSyncs = 0
    const seam = durableIo({ base: { ...fs,
      writeSync(fd: number, bytes: Uint8Array, offset: number, length: number, position: number | null) {
        if (resolving) writes.push(Buffer.from(bytes.subarray(offset, offset + length)))
        return fs.writeSync(fd, bytes, offset, length, position)
      },
    } as typeof fs, before(step) {
      if (!resolving || step.op !== 'fsync') return
      checkedSyncs++
      expect(q.unresolvedHolds('alpha').map(h => h.seq)).toEqual([1, 2])
      expect(q.openCount('alpha')).toBe(2)
      expect(events).toEqual([])
    } }).fs
    const q = await open({ now: clock.now, fs: seam, onEvent: e => events.push(e) })
    await storeHold(q, clock.now())
    await storeHold(q, clock.now(), { ts: THREAD_ROOTS.third, key: { ...slackInput().key!, ts: THREAD_ROOTS.third } })
    await q.accept('alpha', injectedInput())
    await storeHold(q, clock.now(), { ts: THREAD_ROOTS.primary, key: { ...slackInput().key!, ts: THREAD_ROOTS.primary } })
    await storeHold(q, clock.now(), { channel: THREAD_CHANNELS.secondary, key: { chat_id: THREAD_CHANNELS.secondary, ts: THREAD_ROOTS.secondary } })
    const earlier = [{ seq: 4, outcome: 'withdrawn', at: clock.now() }, { seq: 5, outcome: 'released', at: clock.now() }] satisfies HoldResolution[]
    await q.resolveHolds('alpha', earlier)
    await clock.advance(50)
    const saved: HoldResolution[] = [{ seq: 2, outcome: 'withdrawn', at: clock.now() }, { seq: 1, outcome: 'released', at: clock.now() }]
    const candidates: HoldResolution[] = [
      { seq: 4, outcome: 'released', at: clock.now() }, saved[0]!,
      { seq: 5, outcome: 'withdrawn', at: clock.now() }, saved[1]!,
      { seq: 1, outcome: 'withdrawn', at: clock.now() + 1 }, { seq: 2, outcome: 'released', at: clock.now() + 1 },
      { seq: 3, outcome: 'withdrawn', at: clock.now() }, { seq: 99, outcome: 'released', at: clock.now() },
    ]
    events.length = 0; resolving = true
    expect(await q.resolveHolds('alpha', candidates)).toEqual(saved)
    resolving = false
    // The file sync ran before publication; the journal's entry was already durable, so no directory sync.
    expect(checkedSyncs).toBe(1)
    expect(writes).toEqual([Buffer.from([withdrawnRecord(2, clock.now()), releasedRecord(1, clock.now())].map(r => JSON.stringify(r) + '\n').join(''))])
    expect(events).toEqual([{ type: 'holds-resolved', key: 'alpha', resolutions: saved }])
    expect(q.unresolvedHolds('alpha')).toEqual([])
    expect(q.openCount('alpha')).toBe(3)
    expect(earlier.map(r => q.item('alpha', r.seq)!.hold)).toEqual(earlier.map(r => ({ field: memoryHold(THREAD_TIME), kind: 'memory', state: r.outcome, at: r.at })))
    const before = fs.readFileSync(queuePath(dir))
    expect(await q.resolveHolds('alpha', candidates)).toHaveLength(0)
    expect(await q.resolveHolds('alpha', [])).toHaveLength(0)
    expect(fs.readFileSync(queuePath(dir))).toEqual(before)
    expect(events).toHaveLength(1)
    for (const build of [releasedRecord, withdrawnRecord, parkedRecord]) await expect(q.append('alpha', build())).rejects.toThrow('Invalid append record')
    assertNoLeak(events)
  })

  test('failed resolution sync saves none; an append restores writability and one retry resolves the batch', async () => {
    const clock = createFakeClock({ start: THREAD_TIME }), events: QueueEvent[] = []
    let fail = false
    const q = await open({ now: clock.now, fs: failFileSyncs(() => fail, 'EIO hold resolution'), onEvent: e => events.push(e) })
    await storeHold(q, clock.now())
    await storeHold(q, clock.now(), { ts: THREAD_ROOTS.third, key: { ...slackInput().key!, ts: THREAD_ROOTS.third } })
    const bytes = fs.readFileSync(queuePath(dir)), holds = q.unresolvedHolds('alpha')
    const resolutions: HoldResolution[] = [{ seq: 1, outcome: 'released', at: clock.now() + 50 }, { seq: 2, outcome: 'withdrawn', at: clock.now() + 60 }]
    events.length = 0; fail = true
    await expect(q.resolveHolds('alpha', resolutions)).rejects.toThrow('EIO hold resolution')
    expect(q.isWritable!('alpha')).toBe(false)
    expect(q.unresolvedHolds('alpha')).toEqual(holds)
    expect(q.openCount('alpha')).toBe(0)
    expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
    expect(events).toMatchObject([{ type: 'append-failed', key: 'alpha' }])
    fail = false
    await q.append('alpha', noticedRecord())
    expect(q.isWritable!('alpha')).toBe(true)
    expect(q.unresolvedHolds('alpha')).toEqual(holds)
    await q.resolveHolds('alpha', resolutions)
    await q.resolveHolds('alpha', resolutions)
    expect(events.map(e => e.type)).toEqual(['append-failed', 'writable', 'holds-resolved'])
    expect(readQueue(dir).filter(r => r.kind === 'released' || r.kind === 'hold-withdrawn')).toEqual([releasedRecord(1, resolutions[0]!.at), withdrawnRecord(2, resolutions[1]!.at)])
    expect(q.openCount('alpha')).toBe(1)
    await q.stop()
    const replay = await open({ now: clock.now })
    expect(replay.unresolvedHolds('alpha')).toEqual([])
    expect(replay.openCount('alpha')).toBe(1)
    expect(itemOpenedAt(replay.item('alpha', 1)!)).toBe(resolutions[0]!.at)
    assertNoLeak(events)
  })

  // An outcome must be an exact string before the parking guard and the kind mapping: a property lookup
  // would coerce ['withdrawn'] to `hold-withdrawn`. A validation refusal never blocks the journal (b.crw).
  test.each(['released', 'withdrawn', 'parked'] as const)("an array outcome ['%s'] is refused: nothing saved, no append-failed, an existing storage block kept; the string outcome is the control", async outcome => {
    const clock = createFakeClock({ start: THREAD_TIME }), events: QueueEvent[] = []
    let fail = false
    const q = await open({ now: clock.now, fs: failFileSyncs(() => fail, 'EIO hold resolution'), onEvent: e => events.push(e) })
    await storeHold(q, clock.now(), {}, 'alpha', unknownRootPostHold)
    await storeHold(q, clock.now(), { ts: THREAD_ROOTS.third, key: { ...slackInput().key!, ts: THREAD_ROOTS.third } })
    const holds = q.unresolvedHolds('alpha'), bytes = fs.readFileSync(queuePath(dir))
    const arrayOutcome = { seq: 1, outcome: [outcome], at: clock.now() + 10 } as unknown as HoldResolution
    const refused = async () => {
      events.length = 0
      await expect(q.resolveHolds('alpha', [arrayOutcome])).rejects.toThrow('Invalid hold resolution')
      expect({ holds: q.unresolvedHolds('alpha'), bytes: fs.readFileSync(queuePath(dir)), events, state: q.item('alpha', 1)!.hold!.state })
        .toEqual({ holds, bytes, events: [], state: 'unresolved' })
    }
    // Writable: refused, and still writable.
    await refused()
    expect(q.isWritable!('alpha')).toBe(true)
    // Blocked by a storage failure: refused, and the block is kept (only a durable append clears it).
    fail = true
    await expect(q.resolveHolds('alpha', [{ seq: 2, outcome: 'released', at: clock.now() + 20 }])).rejects.toThrow('EIO hold resolution')
    expect(q.isWritable!('alpha')).toBe(false)
    fail = false
    await refused()
    expect(q.isWritable!('alpha')).toBe(false)
    // The string outcome resolves the same hold, under its record kind.
    const control: HoldResolution = { seq: 1, outcome, at: clock.now() + 30 }
    expect(await q.resolveHolds('alpha', [control])).toEqual([control])
    expect(q.isWritable!('alpha')).toBe(true)
    const kind = outcome === 'withdrawn' ? 'hold-withdrawn' : outcome
    expect(readQueue(dir).filter(r => r.seq === 1 && r.kind !== 'accepted')).toEqual([{ v: 1, kind, seq: 1, at: control.at }])
    assertNoLeak(events)
  })

  test('commit observer sees only the saved subset after publication, before writable and general observers', async () => {
    const io = threadFsControls(dir), order: string[] = [], commits: HoldResolution[][] = [], events: QueueEvent[] = []
    const q = await open({ fs: io.fs, onEvent: event => { events.push(event); order.push(event.type) } })
    await storeHold(q, THREAD_TIME)
    await storeHold(q, THREAD_TIME, { ts: THREAD_ROOTS.third, key: { ...slackInput().key!, ts: THREAD_ROOTS.third } })
    await storeHold(q, THREAD_TIME, { ts: THREAD_ROOTS.primary, key: { ...slackInput().key!, ts: THREAD_ROOTS.primary } })
    await q.accept('alpha', injectedInput())
    await q.resolveHolds('alpha', [{ seq: 1, outcome: 'released', at: THREAD_TIME }])
    const saved: HoldResolution[] = [{ seq: 3, outcome: 'withdrawn', at: THREAD_TIME + 1 }, { seq: 2, outcome: 'released', at: THREAD_TIME + 1 }]
    const candidates: HoldResolution[] = [{ seq: 1, outcome: 'withdrawn', at: THREAD_TIME }, ...saved,
      { ...saved[0]!, outcome: 'released' }, { seq: 4, outcome: 'withdrawn', at: THREAD_TIME }, { seq: 99, outcome: 'released', at: THREAD_TIME }]
    const observations: unknown[] = []
    const observer = (batch: readonly HoldResolution[]) => {
      order.push('committed'); commits.push(structuredClone([...batch]))
      observations.push({ writable: q.isWritable!('alpha'), unresolved: q.unresolvedHolds('alpha'),
        state: q.item('alpha', 3)!.hold!.state, open: q.openCount('alpha'),
        journal: readQueue(dir).filter(r => r.kind === 'hold-withdrawn') })
      // Callback data cannot corrupt the returned batch or general event.
      batch[0]!.outcome = 'released'
    }
    io.fail('writeSync', 'alpha', { match: path => path === queuePath(dir) })
    await expect(q.resolveHolds('alpha', candidates, undefined, observer)).rejects.toThrow()
    expect(commits).toEqual([]); expect(q.isWritable!('alpha')).toBe(false)
    io.heal(); order.length = 0; events.length = 0
    expect(await q.resolveHolds('alpha', candidates, () => false, observer)).toEqual([])
    expect(commits).toEqual([]); expect(order).toEqual([])
    expect(await q.resolveHolds('alpha', candidates, undefined, observer)).toEqual(saved)
    expect(commits).toEqual([saved])
    expect(observations).toEqual([{ writable: true, unresolved: [], state: 'withdrawn', open: 3,
      journal: [withdrawnRecord(3, THREAD_TIME + 1)] }])
    expect(order).toEqual(['committed', 'writable', 'holds-resolved'])
    expect(events.at(-1)).toEqual({ type: 'holds-resolved', key: 'alpha', resolutions: saved })
    const bytes = fs.readFileSync(queuePath(dir))
    expect(await q.resolveHolds('alpha', candidates, undefined, observer)).toEqual([])
    expect(await q.resolveHolds('alpha', [], undefined, observer)).toEqual([])
    expect(commits).toEqual([saved]); expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
    assertNoLeak({ commits, events, order })
  })

  test.each(['throw', 'reject', 'pending'] as const)('a %s commit observer cannot undo durability or block either writer', async outcome => {
    const events: QueueEvent[] = [], q = await open({ onEvent: e => events.push(e) })
    await storeHold(q, THREAD_TIME); await storeHold(q, THREAD_TIME, {}, 'beta')
    const saved: HoldResolution[] = [{ seq: 1, outcome: 'withdrawn', at: THREAD_TIME }]
    let calls = 0
    const pending = q.resolveHolds('alpha', saved, undefined, () => {
      calls++
      if (outcome === 'throw') throw new Error('observer failed')
      if (outcome === 'reject') return Promise.reject(new Error('observer failed'))
      return new Promise<void>(() => {})
    })
    expect(await q.resolveHolds('beta', saved)).toEqual(saved)
    await expect(pending).resolves.toEqual(saved)
    expect((await q.accept('alpha', injectedInput())).status).toBe('accepted')
    expect(calls).toBe(1); expect(q.isWritable!('alpha')).toBe(true)
    expect(q.item('alpha', 1)!.hold!.state).toBe('withdrawn')
    expect(readQueue(dir).filter(r => r.kind === 'hold-withdrawn')).toEqual([withdrawnRecord(1, THREAD_TIME)])
    expect(events.filter(e => e.type === 'append-failed')).toEqual([])
    expect(events.filter(e => e.type === 'holds-resolved')).toHaveLength(2)
    assertNoLeak(events)
  })

  test("one persona resolves while another's earlier turn waits on a held sync and more turns queue behind it", async () => {
    const { io, gate, state, reached } = holdFirstSync(path => path === queuePath(dir), { armed: false })
    const clock = createFakeClock({ start: THREAD_TIME }), q = await open({ now: clock.now, fs: io.fs }), order: string[] = []
    await storeHold(q, clock.now())
    await storeHold(q, clock.now(), {}, 'beta')
    state.armed = true
    const head = q.accept('alpha', injectedInput({ text: 'earlier turn' }))
    await reached()
    // Queued while the head's append holds the writer, so none joins the head's batch.
    const backlog = Array.from({ length: 20 }, (_, i) => q.acceptDecided('alpha', undefined, () => { order.push(`alpha:${i}`); return { skip: i } }))
    const alpha = q.resolveHolds('alpha', [{ seq: 1, outcome: 'released', at: clock.now() }]).then(saved => { order.push('alpha:resolved'); return saved })
    expect(await q.resolveHolds('beta', [{ seq: 1, outcome: 'withdrawn', at: clock.now() }])).toHaveLength(1)
    expect(order).toEqual([])
    expect(q.unresolvedHolds('alpha')).toHaveLength(1)
    expect(q.unresolvedHolds('beta')).toEqual([])
    gate.release()
    await Promise.all([head, ...backlog])
    expect(await alpha).toHaveLength(1)
    expect(order).toEqual([...Array.from({ length: 20 }, (_, i) => `alpha:${i}`), 'alpha:resolved'])
    expect(q.unresolvedHolds('alpha')).toEqual([])
    expect(q.openCount('alpha')).toBe(2)
  })

  test.each((['unresolved', 'released', 'withdrawn'] as const).flatMap(state => (['memory', 'post'] as const).map(kind => [state, kind] as const)))('%s %s hold keeps its Slack key across reopen, compaction and the retention boundary', async (state, kind) => {
    const clock = createFakeClock({ start: THREAD_TIME })
    let q = await open({ now: clock.now })
    const item = await storeHold(q, clock.now(), {}, 'alpha', HOLD_FIELDS[kind]), input = heldSlackInput(item.accepted.hold!)
    await clock.advance(100)
    if (state !== 'unresolved') await q.resolveHolds('alpha', [{ seq: 1, outcome: state, at: clock.now() }])
    const duplicate = async () => {
      const bytes = fs.readFileSync(queuePath(dir))
      expect(await q.acceptDecided('alpha', input.key, () => { throw new Error('duplicate must not decide') })).toMatchObject({ status: 'duplicate', seq: 1 })
      expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
    }
    await duplicate()
    await q.stop(); q = await open({ now: clock.now })
    await duplicate()
    await clock.advanceTo(THREAD_TIME + QUEUE_KEY_KEEP_MS - 1)
    await q.compact('alpha'); await duplicate()
    await clock.advance(1); await q.compact('alpha')
    if (state === 'withdrawn') {
      expect(q.lookupSlackKey('alpha', input.key!)).toBeUndefined()
      expect(await q.acceptDecided('alpha', input.key, () => ({ store: input }))).toMatchObject({ status: 'accepted', seq: 2 })
    } else await duplicate() // Open accepted work and unresolved holds never expire.
  })

  test('late withdrawal expires from receipt on its first compaction', async () => {
    const clock = createFakeClock({ start: THREAD_TIME }), q = await open({ now: clock.now })
    const item = await storeHold(q, clock.now())
    await clock.advance(QUEUE_KEY_KEEP_MS)
    await q.resolveHolds('alpha', [{ seq: 1, outcome: 'withdrawn', at: clock.now() }])
    await q.compact('alpha')
    expect(q.lookupSlackKey('alpha', item.accepted.key!)).toBeUndefined()
    expect(q.items('alpha')).toEqual([])
    expect(readQueue(dir).map(r => 'compact' in r ? r.compact : r.kind)).toEqual(['allocation'])
  })

  // Post Holds' roots were unknown, so seq 5's parking makes it a Memory Hold.
  test.each(['memory', 'post'] as const)('compaction preserves unresolved/parked %s holds and rewrites resolved work for the frozen main reader', async kind => {
    const clock = createFakeClock({ start: THREAD_TIME }), q = await open({ now: clock.now })
    const hold = () => kind === 'post' ? postHold(clock.now(), { operations: ['post-one', 'post-two'], root_unknown: true }) : memoryHold(clock.now())
    const inputs = [
      heldSlackInput(hold()),
      heldSlackInput(hold(), { ts: THREAD_ROOTS.third, key: { ...slackInput().key!, ts: THREAD_ROOTS.third } }),
      heldSlackInput(hold(), { ts: THREAD_ROOTS.primary, key: { ...slackInput().key!, ts: THREAD_ROOTS.primary } }),
      heldSlackInput(hold(), { channel: THREAD_CHANNELS.secondary, key: { chat_id: THREAD_CHANNELS.secondary, ts: THREAD_ROOTS.secondary } }),
      heldSlackInput(hold(), { channel: THREAD_CHANNELS.private, key: { chat_id: THREAD_CHANNELS.private, ts: THREAD_ROOTS.secondary } }),
    ]
    for (const input of inputs) expect((await q.acceptDecided('alpha', input.key, () => ({ store: input }))).status).toBe('accepted')
    await clock.advance(50)
    await q.resolveHolds('alpha', [
      { seq: 1, outcome: 'released', at: clock.now() }, { seq: 2, outcome: 'withdrawn', at: clock.now() },
      { seq: 3, outcome: 'released', at: clock.now() }, { seq: 5, outcome: 'parked', at: clock.now() },
    ])
    const otherRecords = [fixedRecord(1, ['one', 'two']), { ...sentRecord(), at: clock.now() }, deliveredRecord(1, clock.now()), noticedRecord(1, clock.now())]
    for (const record of [...otherRecords, fixedRecord(3), deliveredRecord(3, clock.now() + 10)]) await q.append('alpha', record)
    const before = q.items('alpha')
    await q.compact('alpha')
    const records = readQueue(dir)
    for (const record of records) {
      expect(isMainQueueRecord(record)).toBe(true)
      expect(['released', 'withdrawn', 'parked']).not.toContain(record.kind)
      if ('compact' in record) { expect(record).not.toHaveProperty('hold'); expect(record).not.toHaveProperty('thread_join') }
    }
    const released = q.item('alpha', 1)!
    expect(released.accepted).toEqual({ ...inputs[0]!, hold: undefined, v: 1, kind: 'accepted', seq: 1, received_at: THREAD_TIME, ts: inputs[0]!.ts!, attempt_high_watermark: 1, released_at: clock.now() })
    expect(released.accepted).not.toHaveProperty('hold')
    expect(released.records.filter(r => r.kind !== 'accepted')).toEqual(otherRecords)
    expect(q.openCount('alpha')).toBe(1)
    // The unparked hold is kept whole; the parked one keeps only the Memory Hold form.
    const kept = [[4, inputs[3]!.hold!, kind], [5, memoryHold(THREAD_TIME), 'memory']] as const
    for (const [seq, field, effective] of kept) {
      expect(q.item('alpha', seq)!.accepted).toEqual({ ...before[seq - 1]!.accepted, hold: field, attempt_high_watermark: 0 })
      expect(q.item('alpha', seq)!.hold).toEqual({ field, kind: effective, state: 'unresolved' })
    }
    expect(records.filter(r => 'compact' in r && r.compact === 'key').map(r => 'delivered_at' in r ? [r.seq, r.delivered_at] : [])).toEqual([[2, clock.now()], [3, clock.now() + 10]])
    const copy = join(dir, 'main-holds')
    seedQueue(copy, records)
    const old = createMainDeliveryQueue({ stateDir: copy, now: clock.now })
    await old.start()
    try {
      expect(old.startupFindings()).toEqual([])
      expect(old.items('alpha').map(i => [i.accepted.seq, i.delivered])).toEqual([[1, false], [4, false], [5, false]])
      expect(released.records).toEqual(old.item('alpha', 1)!.records)
      for (let i = 0; i < inputs.length; i++) expect(old.lookupSlackKey('alpha', inputs[i]!.key!)).toMatchObject({ status: 'duplicate', seq: i + 1 })
      expect(old.item('alpha', 2)).toBeUndefined() // Withdrawn is a delivered key, never open work.
    } finally { await old.stop() }
    await q.stop()
    const replay = await open({ now: clock.now })
    expect(replay.openCount('alpha')).toBe(1)
    expect(itemOpenedAt(replay.item('alpha', 1)!)).toBe(clock.now())
    expect(replay.unresolvedHolds('alpha')).toEqual(kept.map(([seq, field]) => ({ ...field, seq, channel: inputs[seq - 1]!.channel!, memoryDependent: true })))
  })

  test.each(['memory', 'post'] as const)('main can deliver an unresolved %s hold and current replay recognizes its release at delivery time', async kind => {
    const clock = createFakeClock({ start: THREAD_TIME }), q = await open({ now: clock.now })
    await storeHold(q, clock.now(), {}, 'alpha', HOLD_FIELDS[kind]); await q.stop()
    const old = createMainDeliveryQueue({ stateDir: dir, now: clock.now })
    await old.start()
    try {
      expect(old.startupFindings()).toEqual([])
      expect(old.openCount('alpha')).toBe(1)
      await clock.advance(50)
      await old.append('alpha', fixedRecord())
      await old.append('alpha', deliveredRecord(1, clock.now()))
      expect(old.item('alpha', 1)!.delivered).toBe(true)
    } finally { await old.stop() }
    const replay = await open({ fs: readOnlyFs, now: clock.now }), item = replay.item('alpha', 1)!
    expect(item.hold).toEqual({ field: HOLD_FIELDS[kind](THREAD_TIME), kind, state: 'released', at: clock.now() })
    expect(item.delivered).toBe(true)
    expect(itemOpenedAt(item)).toBe(clock.now())
    expect(replay.openCount('alpha')).toBe(0)
    expect(replay.unresolvedHolds('alpha')).toEqual([])
  })
})

describe('test-only store timings', () => {
  // On only with measureTimings (Task t2.yiv.sf.tu Decision 23). The packed-server scenarios judge
  // SR-8.2's store p99, SR-8.4's held reply and N4's fallback (Decision 18) from these numbers.
  const TIMING_FIELDS: readonly string[] = ['storeMs', 'atMonoMs', 'store']
  const SECRET = `${LEAK_SENTINEL} private timed body`
  /** An earlier turn's append time, which a later turn waits behind, and a measured turn's own append time. */
  const WAIT = 1_000, APPEND = 30
  /** An earlier batch member's own staging time, before a later member's staging starts. */
  const STAGE = 7
  /** After every THREAD_ROOTS timestamp, so never a duplicate of their stores. */
  const LATER_TS = '1700000000.000009'
  const later = (text = 'message') => slackInput({ text, ts: LATER_TS, key: { ...slackInput().key!, ts: LATER_TS } })
  const heldAt = (hold: HoldField, ts: string, text = 'message') => heldSlackInput(hold, { text, ts, key: { ...slackInput().key!, ts } })
  const timingFields = (events: readonly QueueEvent[]) => events.flatMap(e => Object.keys(e)).filter(name => TIMING_FIELDS.includes(name))
  /** A monotonic clock that counts its reads, over a queue fs whose journal fsyncs (inside the append,
   * after its bytes are written) run `during` and then fail while `fail` is set. */
  function timedRig() {
    const rig = { mono: 50_000, reads: 0, fail: false, during: undefined as (() => void) | undefined }
    return Object.assign(rig, {
      monotonicNow: () => { rig.reads++; return rig.mono },
      /** Each journal fsync advances the clock by the next of `ms`, then by nothing. */
      costs: (...ms: number[]) => { rig.during = () => { rig.mono += ms.shift() ?? 0 } },
      fs: durableIo({ before(step) {
        if (step.op === 'fsync' && /\/queue\/[^/]+\.jsonl$/.test(step.path)) { rig.during?.(); if (rig.fail) throw new Error('EIO timed store') }
      } }).fs,
    })
  }
  type TimedRig = ReturnType<typeof timedRig>
  const timedQueue = (rig: TimedRig, events: QueueEvent[]) => open({ fs: rig.fs, monotonicNow: rig.monotonicNow, measureTimings: true, onEvent: e => events.push(e) })

  const RESOLUTIONS: HoldResolution[] = [{ seq: 2, outcome: 'released', at: THREAD_TIME + 1 }, { seq: 3, outcome: 'withdrawn', at: THREAD_TIME + 1 }]
  /** In order: accepted (1), Memory Hold (2) and Post Hold (3) stores, a duplicate, a drop, a failed store,
   * a failed then a written `fixed` append, its identical repeat, two other append kinds and one resolution
   * append for both holds, all with SECRET as the message text. Returns each call's outcome. */
  async function drive(q: DeliveryQueue, rig: TimedRig): Promise<unknown[]> {
    const outcomes: unknown[] = [await q.accept('alpha', slackInput({ text: SECRET }))]
    for (const input of [heldAt(memoryHold(THREAD_TIME), THREAD_ROOTS.secondary, SECRET), heldAt(postHold(THREAD_TIME), THREAD_ROOTS.third, SECRET)]) {
      outcomes.push(await q.acceptDecided('alpha', input.key, () => ({ store: input })))
    }
    outcomes.push(await q.accept('alpha', slackInput({ text: SECRET })), await q.acceptDecided('alpha', undefined, () => ({ skip: 'drop' })))
    rig.fail = true
    const failed = await q.accept('alpha', later(SECRET))
    outcomes.push(failed.status === 'failed' ? { status: failed.status, error: (failed.error as Error).message } : failed)
    outcomes.push(await q.append('alpha', fixedRecord(1, [SECRET])).then(() => 'appended', (error: Error) => error.message))
    rig.fail = false
    for (const record of [fixedRecord(1, [SECRET]), fixedRecord(1, [SECRET]), sentRecord(), deliveredRecord()]) { await q.append('alpha', record); outcomes.push('appended') }
    outcomes.push(await q.resolveHolds('alpha', RESOLUTIONS))
    return outcomes
  }

  test.each([['absent', {}], ['false', { measureTimings: false }]] as const)('with measureTimings %s: no timing field or fixed-stored event, no clock read, the same writes and the hourly interval', async (_, gate) => {
    const rig = timedRig(), events: QueueEvent[] = [], scheduled: number[] = []
    rig.costs(...Array<number>(20).fill(7))
    const q = await open({ ...gate, fs: rig.fs, now: () => THREAD_TIME, monotonicNow: rig.monotonicNow, onEvent: e => events.push(e),
      setInterval: ((_: () => void, delay: number) => { scheduled.push(delay); return {} }) as unknown as typeof setInterval, clearInterval: () => {} })
    expect(await drive(q, rig)).toMatchObject([{ status: 'accepted', seq: 1 }, { status: 'accepted', seq: 2 }, { status: 'accepted', seq: 3 }, { status: 'duplicate', seq: 1 },
      { status: 'skipped', outcome: 'drop' }, { status: 'failed', error: 'EIO timed store' }, 'EIO timed store', 'appended', 'appended', 'appended', 'appended', RESOLUTIONS])
    expect(events.map(e => e.type)).toEqual(['stored', 'stored', 'stored', 'store-failed', 'append-failed', 'writable', 'holds-resolved'])
    const stored = { type: 'stored', key: 'alpha' } as const
    expect(events.filter(e => e.type !== 'store-failed' && e.type !== 'append-failed')).toStrictEqual([stored, stored, stored, { type: 'writable', key: 'alpha' }, { type: 'holds-resolved', key: 'alpha', resolutions: RESOLUTIONS }])
    expect(timingFields(events)).toEqual([])
    expect(events.find(e => e.type === 'store-failed')).toMatchObject({ key: 'alpha', path: queuePath(dir), source: 'slack', ts: LATER_TS })
    expect(events.find(e => e.type === 'append-failed')).toMatchObject({ key: 'alpha', path: queuePath(dir), seq: 1 })
    expect(readQueue(dir).map(r => [r.kind, r.seq])).toEqual([['accepted', 1], ['accepted', 2], ['accepted', 3], ['fixed', 1], ['sent', 1], ['delivered', 1], ['reply-reminder', 1], ['released', 2], ['hold-withdrawn', 3]])
    q.startMaintenance()
    expect(scheduled).toEqual([QUEUE_COMPACT_INTERVAL_MS])
    expect(rig.reads).toBe(0)
  })

  test('measuring changes no record, result or existing event field; it adds timings to stored and holds-resolved and one fixed-stored, none carrying message text', async () => {
    async function run(name: string, measureTimings: boolean) {
      const stateDir = join(dir, name), rig = timedRig(), events: QueueEvent[] = []
      rig.during = () => { rig.mono += 7 }
      const q = await makeQueue(stateDir, { fs: rig.fs, now: () => THREAD_TIME, monotonicNow: rig.monotonicNow, measureTimings, onEvent: e => events.push(e) })
      queues.push(q)
      const outcomes = await drive(q, rig)
      // Every field but the timings, with each run's own state directory masked.
      const untimed = events.filter(e => e.type !== 'fixed-stored').map(e => e.type === 'stored' ? { type: e.type, key: e.key } : Object.fromEntries(Object.entries(e).filter(([name]) => !TIMING_FIELDS.includes(name))))
      return { outcomes, events, bytes: fs.readFileSync(queuePath(stateDir)), untimed: JSON.parse(JSON.stringify(untimed).replaceAll(stateDir, '<state>')) }
    }
    const plain = await run('plain', false), measured = await run('measured', true)
    expect(measured.bytes).toEqual(plain.bytes)
    expect(measured.outcomes).toEqual(plain.outcomes)
    expect(measured.untimed).toEqual(plain.untimed)
    const timed = (seq: number, store: QueueStoreKind) => ({ type: 'stored' as const, key: 'alpha', seq, store, storeMs: 7, atMonoMs: expect.any(Number) })
    expect(measured.events.filter(e => e.type === 'stored')).toEqual([timed(1, 'accepted'), timed(2, 'memory-hold'), timed(3, 'post-hold')])
    expect(measured.events.filter(e => e.type === 'fixed-stored')).toEqual([{ type: 'fixed-stored', key: 'alpha', seq: 1, storeMs: expect.any(Number), atMonoMs: expect.any(Number) }])
    expect(measured.events.filter(e => e.type === 'holds-resolved')).toEqual([{ type: 'holds-resolved', key: 'alpha', resolutions: RESOLUTIONS, storeMs: 7, atMonoMs: expect.any(Number) }])
    assertNoLeak(measured.events)
    expect(JSON.stringify(measured.events)).not.toContain(SECRET)
  })

  const MEASURED_ACCEPTS = [
    ['accept', 'accepted', (q: DeliveryQueue) => q.accept('alpha', slackInput())],
    ['acceptDecided', 'accepted', (q: DeliveryQueue) => q.acceptDecided('alpha', slackInput().key, () => ({ store: slackInput() }))],
    ['a Post Hold', 'post-hold', (q: DeliveryQueue) => { const input = heldAt(postHold(THREAD_TIME), THREAD_ROOTS.secondary); return q.acceptDecided('alpha', input.key, () => ({ store: input })) }],
    ['a Memory Hold', 'memory-hold', (q: DeliveryQueue) => { const input = heldAt(memoryHold(THREAD_TIME), THREAD_ROOTS.secondary); return q.acceptDecided('alpha', input.key, () => ({ store: input })) }],
  ] as const
  test.each(MEASURED_ACCEPTS)('%s: storeMs runs from its turn start, after the wait behind an earlier turn, through its append; atMonoMs is that append return', async (_, store, accept) => {
    const rig = timedRig(), events: QueueEvent[] = [], q = await timedQueue(rig, events), start = rig.mono
    // The earlier turn holds the writer for WAIT inside its append; the measured turn's own append takes APPEND.
    rig.costs(WAIT, APPEND)
    // Arriving while the earlier append is in flight, the measured acceptance cannot join it and waits behind it.
    let measured: ReturnType<typeof accept> | undefined
    const cost = rig.during!
    rig.during = () => { measured ??= accept(q); cost() }
    const earlier = await q.accept('alpha', injectedInput())
    expect([earlier, await measured]).toMatchObject([{ status: 'accepted', seq: 1 }, { status: 'accepted', seq: 2 }])
    // So atMonoMs − storeMs, the measured turn's first reading, is when the earlier append returned.
    expect(events).toEqual([
      { type: 'stored', key: 'alpha', seq: 1, store: 'accepted', storeMs: WAIT, atMonoMs: start + WAIT },
      { type: 'stored', key: 'alpha', seq: 2, store, storeMs: APPEND, atMonoMs: start + WAIT + APPEND },
    ])
  })

  test.each(MEASURED_ACCEPTS)("%s queued with an earlier acceptance shares its one append: each storeMs runs from its own staging through that append; atMonoMs is that append's return", async (_, store, accept) => {
    const rig = timedRig(), events: QueueEvent[] = [], q = await timedQueue(rig, events), start = rig.mono
    let appends = 0
    rig.during = () => { appends++; rig.mono += APPEND }
    // The earlier member's decision takes STAGE, so a batch-wide start would give the measured member STAGE+APPEND too.
    const earlier = q.acceptDecided('alpha', later().key, () => { rig.mono += STAGE; return { store: later() } })
    const [first, measured] = await Promise.all([earlier, accept(q)])
    expect([first, measured]).toMatchObject([{ status: 'accepted', seq: 1 }, { status: 'accepted', seq: 2 }])
    expect(appends).toBe(1)
    expect(events).toEqual([
      { type: 'stored', key: 'alpha', seq: 1, store: 'accepted', storeMs: STAGE + APPEND, atMonoMs: start + STAGE + APPEND },
      { type: 'stored', key: 'alpha', seq: 2, store, storeMs: APPEND, atMonoMs: start + STAGE + APPEND },
    ])
  })

  test('a duplicate, a drop and a failed store emit no stored event; the failure keeps its store-failed event', async () => {
    const rig = timedRig(), events: QueueEvent[] = [], q = await timedQueue(rig, events)
    // A store emits its timed event, so the absences below are not for want of measuring.
    await q.accept('alpha', slackInput())
    expect(events).toEqual([{ type: 'stored', key: 'alpha', seq: 1, store: 'accepted', storeMs: 0, atMonoMs: rig.mono }])
    events.length = 0
    expect((await q.accept('alpha', slackInput())).status).toBe('duplicate')
    expect((await q.acceptDecided('alpha', slackInput().key, () => { throw new Error('duplicate must not decide') })).status).toBe('duplicate')
    expect((await q.acceptDecided('alpha', later().key, () => ({ skip: 'drop' }))).status).toBe('skipped')
    rig.fail = true
    expect((await q.accept('alpha', later())).status).toBe('failed')
    expect((await q.acceptDecided('alpha', later().key, () => ({ store: later() }))).status).toBe('failed')
    expect(events.map(e => e.type)).toEqual(['store-failed', 'store-failed'])
    expect(timingFields(events)).toEqual([])
  })

  test('one resolveHolds call emits one saved-resolutions event timed over its one append, after its wait, with the saved seqs; a failed one carries no timing', async () => {
    const rig = timedRig(), events: QueueEvent[] = [], q = await timedQueue(rig, events)
    for (const input of [heldAt(memoryHold(THREAD_TIME), THREAD_ROOTS.secondary), heldAt(postHold(THREAD_TIME), THREAD_ROOTS.third), heldAt(memoryHold(THREAD_TIME), THREAD_ROOTS.primary)]) {
      expect((await q.acceptDecided('alpha', input.key, () => ({ store: input }))).status).toBe('accepted')
    }
    const resolutions: HoldResolution[] = [{ seq: 1, outcome: 'released', at: THREAD_TIME }, { seq: 2, outcome: 'withdrawn', at: THREAD_TIME }]
    let appends = 0
    rig.costs(WAIT, APPEND)
    const cost = rig.during!
    rig.during = () => { appends++; cost() }
    events.length = 0
    const start = rig.mono
    const [, saved] = await Promise.all([q.accept('alpha', injectedInput()), q.resolveHolds('alpha', resolutions)])
    expect(saved).toEqual(resolutions)
    expect(appends).toBe(2)
    expect(events.filter(e => e.type === 'holds-resolved')).toEqual([{ type: 'holds-resolved', key: 'alpha', resolutions, storeMs: APPEND, atMonoMs: start + WAIT + APPEND }])
    events.length = 0; rig.during = undefined; rig.fail = true
    await expect(q.resolveHolds('alpha', [{ seq: 3, outcome: 'released', at: THREAD_TIME }])).rejects.toThrow('EIO timed store')
    expect(events.map(e => e.type)).toEqual(['append-failed'])
    expect(timingFields(events)).toEqual([])
  })

  test('a newly written fixed append emits one fixed-stored timed over its own append and never stored; a repeat, a conflict, a failure and other kinds emit none', async () => {
    const rig = timedRig(), events: QueueEvent[] = [], q = await timedQueue(rig, events)
    await q.accept('alpha', slackInput())
    events.length = 0
    const start = rig.mono
    rig.costs(WAIT, APPEND)
    await Promise.all([q.accept('alpha', later()), q.append('alpha', fixedRecord(1))])
    // atMonoMs − storeMs is the fixation turn's start after its wait: N4's fallback start.
    expect(events).toEqual([
      { type: 'stored', key: 'alpha', seq: 2, store: 'accepted', storeMs: WAIT, atMonoMs: start + WAIT },
      { type: 'fixed-stored', key: 'alpha', seq: 1, storeMs: APPEND, atMonoMs: start + WAIT + APPEND },
    ])
    rig.during = undefined; events.length = 0
    const bytes = fs.readFileSync(queuePath(dir))
    await q.append('alpha', fixedRecord(1))
    expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
    await expect(q.append('alpha', fixedRecord(1, ['other']))).rejects.toThrow('Fixed text is immutable')
    rig.fail = true
    await expect(q.append('alpha', fixedRecord(2))).rejects.toThrow('EIO timed store')
    rig.fail = false
    for (const record of [sentRecord(), deliveredRecord()]) await q.append('alpha', record)
    // b.crw: the immutable-fixed refusal is a validation refusal, so only the storage failure emits append-failed.
    expect(events.map(e => e.type)).toEqual(['append-failed', 'writable'])
    expect(timingFields(events)).toEqual([])
  })

  test("a fixed append's fixed-stored leaves the message-not-saved episode open; the next stored ends it", async () => {
    const rig = timedRig(), events: QueueEvent[] = []
    let reporting: DeliveryNoticeHarness['reporting'] | undefined
    const q = await makeQueue(dir, { fs: rig.fs, monotonicNow: rig.monotonicNow, measureTimings: true, onEvent: e => { events.push(e); reporting?.queueEvent(e) } })
    const n = await makeDeliveryNoticeHarness({ queue: q })
    reporting = n.reporting
    const notSaved = () => n.rig.episodes.isOpen(n.alpha, 'message-not-saved')
    try {
      expect(await q.accept(n.alpha, slackInput())).toMatchObject({ status: 'accepted', seq: 1 })
      rig.fail = true
      expect((await q.accept(n.alpha, later())).status).toBe('failed')
      rig.fail = false
      await n.flush()
      expect(notSaved()).toBe(true)
      await q.append(n.alpha, fixedRecord()); await n.flush()
      expect(notSaved()).toBe(true)
      expect(events.map(e => e.type)).toEqual(['stored', 'store-failed', 'fixed-stored'])
      expect((await q.accept(n.alpha, later())).status).toBe('accepted'); await n.flush()
      expect(notSaved()).toBe(false)
    } finally { await n.cleanup() }
  })

  test('maintenance compacts at compactIntervalMs when given', async () => {
    const clock = createFakeClock(), scheduled: number[] = [], io = durableIo()
    clock.settleOn(io)
    const q = await open({ now: clock.now, fs: io.fs, compactIntervalMs: 250, ...fakeIntervals(clock, scheduled) })
    await q.accept('alpha', injectedInput({ text: 'delivered content' }))
    await q.append('alpha', fixedRecord(1, ['delivered bytes']))
    await q.append('alpha', deliveredRecord())
    q.startMaintenance()
    expect(scheduled).toEqual([250])
    await clock.advance(249)
    expect(fs.readFileSync(queuePath(dir), 'utf8')).toContain('delivered content')
    await clock.advance(1)
    expect(fs.readFileSync(queuePath(dir), 'utf8')).not.toContain('delivered content')
  })
})

const reactionRecord = (overrides: Partial<ReactionAcceptedInput> = {}): AcceptedRecord => ({ ...reactionInput(overrides), v: 1, kind: 'accepted', seq: 1, received_at: 1000 })
const withdrawn = (overrides: Partial<WithdrawnRecord> = {}): WithdrawnRecord => ({ v: 1, kind: 'withdrawn', seq: 1, reason: 'server-post', at: 2000, ...overrides })
/** Compaction writes retained key facts before items; order by sequence instead. */
const nonAllocation = () => readQueue(dir).filter(r => !('compact' in r && r.compact === 'allocation')).sort((a, b) => a.seq - b.seq)
type StoreFailed = Extract<QueueEvent, { type: 'store-failed' }>

describe('Reaction Item journal', () => {
  const key = reactionInput().reaction_key
  test.each([
    ['a declarative slack-event from a user', {}, 'U0REACTOR'],
    ['a fungible slack-event from a bot', { mode: 'open', user: undefined, bot_id: 'B0BOT001' }, 'B0BOT001'],
    ['a removed reaction naming both user and bot', { change: 'removed', bot_id: 'B0BOT001' }, 'U0REACTOR'],
    ['a declarative bot-tool with an arbitrary stored persona name', { origin: 'bot-tool', reactor_persona_name: 'Persona name ✨ / #ops "quoted"', user: undefined, bot_id: 'B0BOT001' }, 'B0BOT001'],
    ['a fungible bot-tool from a user', { origin: 'bot-tool', mode: 'open', reactor_persona_name: 'x' }, 'U0REACTOR'],
  ] as [string, Partial<ReactionAcceptedInput>, string][])('%s roundtrips with its ordered six-part key', (_, overrides, reactor) => {
    const record = reactionRecord(overrides), k = record.reaction_key!
    expect(isQueueRecord(record)).toBe(true)
    expect(parseQueueRecord(JSON.stringify(record))).toEqual(record)
    expect(isReactionKey(k)).toBe(true)
    expect(k.reactor).toBe(reactor)
    expect(reactionKeyString(k)).toBe(JSON.stringify([record.channel, record.message_ts, reactor, record.emoji, record.change, record.ts]))
    expect(reactionKeyString(Object.fromEntries(Object.entries(k).reverse()) as unknown as ReactionKey)).toBe(reactionKeyString(k))
  })

  test.each([
    ['absent mode', { mode: undefined }, true],
    ['an unknown mode', { mode: 'loud' }, true],
    ['a bot-tool origin without its persona name', { origin: 'bot-tool' }, true],
    ['a bot-tool origin with an empty persona name', { origin: 'bot-tool', reactor_persona_name: '' }, true],
    ['a slack-event origin with a persona name', { reactor_persona_name: 'alpha' }, true],
    ['absent origin', { origin: undefined }, true],
    ['an unknown origin', { origin: 'webhook' }, true],
    ['an unknown change', { change: 'changed', reaction_key: { ...key, change: 'changed' } }, false],
    ['message text', { text: 'reaction body' }, true],
    ['no reactor', { user: undefined }, true],
    ['a non-string reactor', { user: 7, reaction_key: { ...key, reactor: 7 } }, false],
    ['an empty event ts', { ts: '', reaction_key: { ...key, event_ts: '' } }, false],
    ['an empty emoji', { emoji: '', reaction_key: { ...key, emoji: '' } }, false],
    ['absent intake time', { received_at: undefined }, true],
    ['absent reaction key', { reaction_key: undefined }, false],
    ['a key with an extra field', { reaction_key: { ...key, thread_ts: '1700000000.000003' } }, false],
    ...(['chat_id', 'message_ts', 'reactor', 'emoji', 'event_ts'] as const).map(field => [`a key ${field} that disagrees with its field`, { reaction_key: { ...key, [field]: 'other' } }, true] as const),
    ['a key change that disagrees with its field', { reaction_key: { ...key, change: 'removed' } }, true],
    ['a file payload', { files: [{ name: 'a.txt' }] }, true],
    ['a Slack key', { key: { chat_id: 'C0TEST001', ts: '1700000000.000001' } }, true],
    ['queued ack metadata', { queued_ack_reaction: 'eyes' }, true],
    ['a reminder link', { reminder_for: 1 }, true],
    // A permitted value inside an array, which a String() membership test would admit.
    ['an array mode', { mode: ['strict'] }, true],
    ['an array origin', { origin: ['slack-event'] }, true],
    ['an array bot-tool origin without its persona name', { origin: ['bot-tool'] }, true],
    ['an array change in the record and its key', { change: ['added'], reaction_key: { ...key, change: ['added'] } }, false],
  ] as [string, Record<string, unknown>, boolean][])('rejects a reaction with %s (key valid: %p)', (_, fields, keyValid) => {
    const record = { ...reactionRecord(), ...fields }
    expect(isReactionKey(record.reaction_key)).toBe(keyValid)
    expect(isQueueRecord(record)).toBe(false)
    expect(parseQueueRecord(JSON.stringify(record))).toBeUndefined()
  })

  test.each(['message_ts', 'change', 'emoji', 'origin', 'mode', 'reaction_key', 'reactor_persona_name'] as const)('a Slack record carrying reaction field %s is rejected', field => {
    const record = { ...accepted(), [field]: reactionRecord({ origin: 'bot-tool', reactor_persona_name: 'x' })[field] }
    expect(isQueueRecord(record)).toBe(false)
    expect(parseQueueRecord(JSON.stringify(record))).toBeUndefined()
  })

  test.each([
    ...(['server-post', 'conversation-unknown', 'group-dm'] as const).map(reason => [`withdrawn ${reason}`, withdrawn({ reason }), true] as const),
    ...(['not-a-channel', 'externally-shared', 'not_in_channel', 'channel_not_found'] as const).map(failed_condition => [`withdrawn fungible-refused ${failed_condition}`, withdrawn({ reason: 'fungible-refused', failed_condition }), true] as const),
    ['withdrawn fungible-refused without its condition', withdrawn({ reason: 'fungible-refused' }), false],
    ['withdrawn fungible-refused with an unknown condition', { ...withdrawn({ reason: 'fungible-refused' }), failed_condition: 'archived' }, false],
    ['withdrawn group-dm with a condition', withdrawn({ reason: 'group-dm', failed_condition: 'not-a-channel' }), false],
    ['withdrawn with an unknown reason', { ...withdrawn(), reason: 'spam' }, false],
    ['withdrawn without a reason', { ...withdrawn(), reason: undefined }, false],
    // A withdrawn hold has its own kind: the reason-less form above is no hold record either.
    ['hold-withdrawn, a hold resolution', { v: 1, kind: 'hold-withdrawn', seq: 1, at: 2000 }, true],
    ['hold-withdrawn with a reason', { v: 1, kind: 'hold-withdrawn', seq: 1, at: 2000, reason: 'server-post' }, false],
    ['hold-withdrawn without a time', { v: 1, kind: 'hold-withdrawn', seq: 1 }, false],
    ['an array hold-withdrawn kind', { v: 1, kind: ['hold-withdrawn'], seq: 1, at: 2000 }, false],
    ['withdrawn seq 0', withdrawn({ seq: 0 }), false],
    ['withdrawn fractional seq', withdrawn({ seq: 1.5 }), false],
    ['withdrawn without a time', { ...withdrawn(), at: undefined }, false],
    ['withdrawn string time', { ...withdrawn(), at: '2000' }, false],
    ['withdrawn with an extra field', { ...withdrawn(), detail: 'reaction body' }, false],
    ['withdrawn version 2', { ...withdrawn(), v: 2 }, false],
    // Permitted values inside arrays, which a String() membership test would admit.
    ['withdrawn with an array reason', { ...withdrawn(), reason: ['server-post'] }, false],
    ['withdrawn with an array fungible-refused reason and no condition', { ...withdrawn(), reason: ['fungible-refused'] }, false],
    ['withdrawn fungible-refused with an array condition', { ...withdrawn({ reason: 'fungible-refused' }), failed_condition: ['not-a-channel'] }, false],
    ['reaction-key compact', { v: 1, kind: 'accepted', seq: 1, compact: 'reaction-key', reaction_key: key, received_at: 1000, closed_at: 2000 }, true],
    ['reaction-key compact without closed_at', { v: 1, kind: 'accepted', seq: 1, compact: 'reaction-key', reaction_key: key, received_at: 1000 }, false],
    ['reaction-key compact with string closed_at', { v: 1, kind: 'accepted', seq: 1, compact: 'reaction-key', reaction_key: key, received_at: 1000, closed_at: '2000' }, false],
    ['reaction-key compact without received_at', { v: 1, kind: 'accepted', seq: 1, compact: 'reaction-key', reaction_key: key, closed_at: 2000 }, false],
    ['reaction-key compact with an invalid key', { v: 1, kind: 'accepted', seq: 1, compact: 'reaction-key', reaction_key: { ...key, change: 'changed' }, received_at: 1000, closed_at: 2000 }, false],
    ['reaction-key compact with an array key change', { v: 1, kind: 'accepted', seq: 1, compact: 'reaction-key', reaction_key: { ...key, change: ['added'] }, received_at: 1000, closed_at: 2000 }, false],
    ['reaction-key compact with content', { v: 1, kind: 'accepted', seq: 1, compact: 'reaction-key', reaction_key: key, received_at: 1000, closed_at: 2000, text: 'reaction body' }, false],
    ['reaction-key compact with a Slack key', { v: 1, kind: 'accepted', seq: 1, compact: 'reaction-key', reaction_key: key, received_at: 1000, closed_at: 2000, key: { chat_id: 'C0TEST001', ts: '1700000000.000001' } }, false],
  ] as [string, Record<string, unknown>, boolean][])('%s is valid: %p', (_, record, valid) => {
    expect(isQueueRecord(record)).toBe(valid)
    expect(parseQueueRecord(JSON.stringify(record)) as unknown).toEqual(valid ? record : undefined)
  })

  test('accepted bytes stay content-free and keep the exact event ts, stored mode and persona name through compaction and reopen', async () => {
    const input = reactionInput({ origin: 'bot-tool', mode: 'open', reactor_persona_name: 'Stored Persona ✨', user: undefined, bot_id: 'B0BOT001', ts: '1700000000.000100' })
    let q = await open({ now: () => 1000 })
    const stored: AcceptedRecord = { ...input, v: 1, kind: 'accepted', seq: 1, received_at: 1000 }
    expect(await q.accept('alpha', input)).toEqual({ status: 'accepted', seq: 1, item: { accepted: stored, records: [stored], delivered: false, unknownSend: false, retypeCount: 0, nextAttempt: 1 } })
    expect(readQueue(dir)).toEqual([stored])
    expect(Object.keys(JSON.parse(fs.readFileSync(queuePath(dir), 'utf8'))).sort()).toEqual(['bot_id', 'change', 'channel', 'emoji', 'kind', 'message_ts', 'mode', 'origin', 'reaction_key', 'reactor_persona_name', 'received_at', 'seq', 'source', 'text', 'ts', 'v'])
    for (let cycle = 0; cycle < 2; cycle++) {
      await q.compact('alpha')
      await q.stop()
      q = await open({ now: () => 1000 })
      expect(q.item('alpha', 1)!.accepted).toEqual({ ...stored, attempt_high_watermark: 0 })
      expect(nonAllocation()).toEqual([{ ...stored, attempt_high_watermark: 0 }])
    }
  })

  test('simultaneous same-key accepts store one item; reopen and key-only compaction keep it a duplicate without using a sequence', async () => {
    let q = await open({ now: () => 1000 })
    const results = await Promise.all(Array.from({ length: 12 }, () => q.accept('alpha', reactionInput())))
    const item = q.item('alpha', 1)!
    expect(results.filter(r => r.status === 'accepted')).toEqual([{ status: 'accepted', seq: 1, item }])
    expect(results.filter(r => r.status === 'duplicate')).toEqual(Array.from({ length: 11 }, () => ({ status: 'duplicate', seq: 1, item })))
    expect(readQueue(dir)).toHaveLength(1)
    const lookup = q.lookupReactionKey('alpha', key)
    expect(lookup).toEqual({ status: 'duplicate', seq: 1, item })
    if (lookup?.status !== 'duplicate') throw new Error('expected a duplicate lookup')
    lookup.item!.accepted.emoji = 'changed'
    lookup.item!.accepted.reaction_key!.emoji = 'changed'
    for (const result of results) if (result.status !== 'failed') result.item!.accepted.mode = 'open'
    expect(q.lookupReactionKey('alpha', key)).toEqual({ status: 'duplicate', seq: 1, item })
    expect(q.item('alpha', 1)).toEqual(item)
    await q.stop()
    q = await open({ now: () => 1000 })
    expect(await q.accept('alpha', reactionInput())).toEqual({ status: 'duplicate', seq: 1, item: q.item('alpha', 1) })
    await q.append('alpha', withdrawn())
    await q.compact('alpha')
    for (let reopen = 0; reopen < 2; reopen++) {
      expect(q.lookupReactionKey('alpha', key)).toEqual({ status: 'duplicate', seq: 1 })
      expect(await q.accept('alpha', reactionInput())).toEqual({ status: 'duplicate', seq: 1 })
      expect(q.items('alpha')).toEqual([])
      await q.stop()
      q = await open({ now: () => 1000 })
    }
    expect(await q.accept('alpha', injectedInput())).toMatchObject({ status: 'accepted', seq: 2 })
  })

  test.each([
    ['conversation', {}, { channel: 'C0OTHER01' }, 'accepted'],
    ['reacted message ts', {}, { message_ts: '1700000000.000009' }, 'accepted'],
    ['reactor', {}, { user: 'U0OTHER01' }, 'accepted'],
    ['emoji', {}, { emoji: 'eyes' }, 'accepted'],
    ['change', {}, { change: 'removed' }, 'accepted'],
    ['event ts', {}, { ts: '1700000000.000009' }, 'accepted'],
    // Joined with a separator, both keys read "…:U0A:x:y:…".
    ['component boundary', { user: 'U0A:x', emoji: 'y' }, { user: 'U0A', emoji: 'x:y' }, 'accepted'],
    ['mode only', {}, { mode: 'open' }, 'duplicate'],
    ['origin and persona name only', {}, { origin: 'bot-tool', reactor_persona_name: 'beta' }, 'duplicate'],
    ['persona name only', { origin: 'bot-tool', reactor_persona_name: 'first' }, { origin: 'bot-tool', reactor_persona_name: 'second' }, 'duplicate'],
  ] as [string, Partial<ReactionAcceptedInput>, Partial<ReactionAcceptedInput>, 'accepted' | 'duplicate'][])('a later reaction differing in %s is %s', async (_, base, variant, expected) => {
    const q = await open()
    const first = reactionInput(base), later = reactionInput(variant)
    expect(reactionKeyString(first.reaction_key) === reactionKeyString(later.reaction_key)).toBe(expected === 'duplicate')
    expect(await q.accept('alpha', first)).toMatchObject({ status: 'accepted', seq: 1 })
    expect(await q.accept('alpha', later)).toMatchObject(expected === 'accepted' ? { status: 'accepted', seq: 2 } : { status: 'duplicate', seq: 1 })
    // A duplicate keeps the first acceptance's stored routing facts.
    expect(q.items('alpha').map(i => i.accepted)).toMatchObject(expected === 'accepted' ? [first, later] : [first])
    expect(q.lookupReactionKey('alpha', later.reaction_key)).toMatchObject({ status: 'duplicate', seq: expected === 'accepted' ? 2 : 1 })
    expect(readQueue(dir)).toHaveLength(expected === 'accepted' ? 2 : 1)
  })

  test('reaction, Slack and injected acceptance share one sequence order per persona while Slack and reaction keys stay separate', async () => {
    // A reaction to the very Slack message that the Slack key names.
    const on = { message_ts: slackInput().ts! }, reaction = reactionInput(on)
    let q = await open()
    expect(await q.accept('alpha', reaction)).toMatchObject({ status: 'accepted', seq: 1 })
    expect(q.lookupSlackKey('alpha', slackInput().key!)).toBeUndefined()
    expect(await q.accept('alpha', slackInput())).toMatchObject({ status: 'accepted', seq: 2 })
    expect(await q.accept('alpha', injectedInput())).toMatchObject({ status: 'accepted', seq: 3 })
    expect(await q.accept('alpha', reactionInput({ ...on, emoji: 'eyes' }))).toMatchObject({ status: 'accepted', seq: 4 })
    expect(await q.accept('alpha', injectedInput({ source: 'cron' }))).toMatchObject({ status: 'accepted', seq: 5 })
    expect(await q.accept('alpha', slackInput())).toMatchObject({ status: 'duplicate', seq: 2 })
    expect(await q.accept('alpha', reaction)).toMatchObject({ status: 'duplicate', seq: 1 })
    expect(await q.accept('beta', injectedInput())).toMatchObject({ status: 'accepted', seq: 1 })
    expect(await q.accept('beta', reaction)).toMatchObject({ status: 'accepted', seq: 2 })
    expect(q.lookupReactionKey('gamma', reaction.reaction_key)).toBeUndefined()
    for (let reopen = 0; reopen < 2; reopen++) {
      expect(q.items('alpha').map(i => [i.accepted.seq, i.accepted.source])).toEqual([[1, 'reaction'], [2, 'slack'], [3, 'interject'], [4, 'reaction'], [5, 'cron']])
      expect(q.lookupReactionKey('alpha', reaction.reaction_key)).toMatchObject({ status: 'duplicate', seq: 1 })
      expect(q.lookupReactionKey('beta', reaction.reaction_key)).toMatchObject({ status: 'duplicate', seq: 2 })
      expect(q.lookupSlackKey('alpha', slackInput().key!)).toMatchObject({ status: 'duplicate', seq: 2 })
      expect(q.lookupSlackKey('beta', slackInput().key!)).toBeUndefined()
      await q.stop()
      q = await open()
    }
    expect(await q.accept('alpha', reactionInput({ ...on, change: 'removed' }))).toMatchObject({ status: 'accepted', seq: 6 })
  })

  test('an extreme reaction event ts is stored exactly and never moves the injected timestamp watermark, also after replay', async () => {
    const extreme = '9999999999.999999'
    let q = await open({ now: () => 1000 })
    await q.accept('alpha', injectedInput())
    await q.accept('alpha', reactionInput({ ts: extreme }))
    await q.accept('alpha', injectedInput({ source: 'cron' }))
    expect(q.items('alpha').map(i => [i.accepted.source, i.accepted.ts])).toEqual([['interject', '1.000000'], ['reaction', extreme], ['cron', '1.000001']])
    await q.stop()
    q = await open({ now: () => 1000 })
    expect(await q.accept('alpha', injectedInput())).toMatchObject({ status: 'accepted', seq: 4, item: { accepted: { ts: '1.000002' } } })
    for (const seq of [1, 3, 4]) {
      await q.append('alpha', { v: 1, kind: 'fixed', seq, parts: ['delivered'] })
      await q.append('alpha', deliveredRecord(seq))
    }
    await q.append('alpha', withdrawn({ seq: 2 }))
    await q.compact('alpha')
    expect(readQueue(dir)).toEqual([
      { v: 1, kind: 'accepted', seq: 2, compact: 'reaction-key', reaction_key: reactionInput({ ts: extreme }).reaction_key, received_at: 1000, closed_at: 2000 },
      { v: 1, kind: 'accepted', seq: 4, compact: 'allocation', injected_ts: '1.000002' },
    ])
    await q.stop()
    q = await open({ now: () => 1000 })
    expect(await q.accept('alpha', injectedInput({ source: 'cron' }))).toMatchObject({ status: 'accepted', seq: 5, item: { accepted: { ts: '1.000003' } } })
    expect(await q.accept('alpha', reactionInput({ ts: '0.000001' }))).toMatchObject({ status: 'accepted', seq: 6, item: { accepted: { ts: '0.000001' } } })
    expect(await q.accept('alpha', injectedInput())).toMatchObject({ status: 'accepted', seq: 7, item: { accepted: { ts: '1.000004' } } })
  })

  // After a journal's first durable append its directory entry is known durable,
  // so later appends fsync the file only (SR-2.1.3): a directory fsync failure is
  // reachable only at an entry's creation, which the durable-journal tests cover.
  test.each(['journal file'] as const)('a failed %s fsync publishes no reaction acceptance and a retry stores exactly one record', async boundary => {
    const sync = recordSyncs(), events: QueueEvent[] = []
    let q = await open({ fs: sync.fs, onEvent: e => { events.push(e) } })
    expect(await q.accept('alpha', injectedInput())).toMatchObject({ status: 'accepted', seq: 1 })
    const input = reactionInput()
    sync.fail(boundary === 'journal file' ? queuePath(dir) : join(dir, 'queue'))
    for (let retry = 0; retry < 2; retry++) {
      expect((await q.accept('alpha', input)).status).toBe('failed')
      expect(q.items('alpha').map(i => i.accepted.seq)).toEqual([1])
      expect(q.item('alpha', 2)).toBeUndefined()
      expect(q.openCount('alpha')).toBe(1)
      expect(q.lookupReactionKey('alpha', input.reaction_key)).toBeUndefined()
      expect(readQueue(dir).map(r => r.seq)).toEqual([1])
    }
    const failures = events.filter((e): e is StoreFailed => e.type === 'store-failed')
    expect(failures).toMatchObject(Array.from({ length: 2 }, () => ({ key: 'alpha', path: queuePath(dir), source: 'reaction', user: input.user, channel: input.channel, ts: input.ts, reactionKey: input.reaction_key })))
    expect(failures.map(e => e.slackKey)).toEqual([undefined, undefined])
    assertNoLeak(events)
    sync.fail()
    expect(await q.accept('alpha', input)).toMatchObject({ status: 'accepted', seq: 2 })
    expect(readQueue(dir).map(r => [r.seq, r.kind, 'source' in r ? r.source : undefined])).toEqual([[1, 'accepted', 'interject'], [2, 'accepted', 'reaction']])
    await q.stop()
    q = await open()
    expect(q.items('alpha').map(i => i.accepted.seq)).toEqual([1, 2])
    expect(await q.accept('alpha', input)).toMatchObject({ status: 'duplicate', seq: 2 })
  })

  test.each(['journal file'] as const)('a failed %s fsync leaves a withdrawal unpublished and retryable until it is durable', async boundary => {
    const sync = recordSyncs(), events: QueueEvent[] = []
    let q = await open({ fs: sync.fs, now: () => 1000, onEvent: e => { events.push(e) } })
    await q.accept('alpha', reactionInput())
    const before = q.item('alpha', 1)!
    sync.fail(boundary === 'journal file' ? queuePath(dir) : join(dir, 'queue'))
    for (let retry = 0; retry < 2; retry++) {
      await expect(q.append('alpha', withdrawn())).rejects.toThrow('EIO injected sync')
      expect(q.item('alpha', 1)).toEqual(before)
      expect(isQueueItemClosed(q.item('alpha', 1)!)).toBe(false)
      expect(q.openCount('alpha')).toBe(1)
      expect(q.isWritable!('alpha')).toBe(false)
      expect(readQueue(dir).map(r => r.kind)).toEqual(['accepted'])
    }
    expect(events.filter(e => e.type === 'append-failed')).toMatchObject([{ key: 'alpha', seq: 1 }, { key: 'alpha', seq: 1 }])
    assertNoLeak(events)
    sync.fail()
    await q.append('alpha', withdrawn())
    expect(q.item('alpha', 1)).toMatchObject({ withdrawn: withdrawn(), delivered: false })
    expect(q.openCount('alpha')).toBe(0)
    expect(q.isWritable!('alpha')).toBe(true)
    expect(readQueue(dir)).toEqual([before.accepted, withdrawn()])
    await q.stop()
    q = await open({ now: () => 1000 })
    expect(q.openCount('alpha')).toBe(0)
    expect(q.lookupReactionKey('alpha', key)).toEqual({ status: 'duplicate', seq: 1 })
  })

  test.each([
    ['open', { delivered: false }, false],
    ['delivered', { delivered: true }, true],
    ['withdrawn', { delivered: false, withdrawn: withdrawn() }, true],
  ] as const)('isQueueItemClosed: %s is %p', (_, item, closed) => expect(isQueueItemClosed(item)).toBe(closed))

  test('withdrawal closes a reaction once without delivery fiction; an identical retry is a no-op and no later outcome or attempt replaces it', async () => {
    const events: QueueEvent[] = []
    const q = await open({ onEvent: e => { events.push(e) } })
    await q.accept('alpha', reactionInput())
    await q.accept('alpha', injectedInput())
    expect(q.openCount('alpha')).toBe(2)
    const record = withdrawn({ reason: 'fungible-refused', failed_condition: 'externally-shared' })
    await q.append('alpha', record)
    const closed = q.item('alpha', 1)!
    expect(closed).toMatchObject({ withdrawn: record, delivered: false, unknownSend: false, retypeCount: 0, nextAttempt: 1 })
    expect(closed.fixed).toBeUndefined()
    expect(closed.records.map(r => r.kind)).toEqual(['accepted', 'withdrawn'])
    expect(isQueueItemClosed(closed)).toBe(true)
    expect(q.openCount('alpha')).toBe(1)
    const bytes = fs.readFileSync(queuePath(dir))
    await q.append('alpha', { ...record })
    const later: QueueRecord[] = [
      { ...record, reason: 'server-post', failed_condition: undefined }, { ...record, failed_condition: 'not_in_channel' }, { ...record, at: record.at + 1 },
      { v: 1, kind: 'fixed', seq: 1, parts: ['late text'] }, sentRecord(), deliveredRecord(), { v: 1, kind: 'refused', seq: 1, attempt: 1, at: 3000 }, { v: 1, kind: 'noticed', seq: 1, at: 3000 },
    ]
    for (const r of later) await expect(q.append('alpha', r)).rejects.toBeInstanceOf(QueueOutcomeFinal)
    expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
    expect(q.item('alpha', 1)).toEqual(closed)
    expect(q.openCount('alpha')).toBe(1)
    expect(q.isWritable!('alpha')).toBe(true)
    expect(events.filter(e => e.type === 'append-failed')).toEqual([])
    await q.append('alpha', { v: 1, kind: 'fixed', seq: 2, parts: ['next item'] })
    expect(q.item('alpha', 2)!.fixed!.parts).toEqual(['next item'])
  })

  test.each([['slack', slackInput()], ['interject', injectedInput()], ['cron', injectedInput({ source: 'cron' })]] as const)('a %s item cannot be withdrawn, and the refusal leaves the journal as writable as it was', async (_, input) => {
    const sync = recordSyncs(), events: QueueEvent[] = []
    const q = await open({ fs: sync.fs, onEvent: e => { events.push(e) } })
    await q.accept('alpha', input)
    const refuse = async (writable: boolean) => {
      const before = q.item('alpha', 1)!, bytes = fs.readFileSync(queuePath(dir))
      await expect(q.append('alpha', withdrawn())).rejects.toBeInstanceOf(QueueNotWithdrawable)
      expect(q.item('alpha', 1)).toEqual(before)
      expect(q.openCount('alpha')).toBe(1)
      expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
      expect(q.isWritable!('alpha')).toBe(writable)
    }
    await refuse(true)
    await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['next'] })
    expect(q.item('alpha', 1)!.fixed!.parts).toEqual(['next'])
    // After a genuine storage failure, the refusal neither clears nor repeats its block.
    sync.fail(queuePath(dir))
    await expect(q.append('alpha', sentRecord())).rejects.toThrow('EIO injected sync')
    await refuse(false)
    sync.fail()
    await q.append('alpha', sentRecord())
    expect(q.isWritable!('alpha')).toBe(true)
    expect(q.item('alpha', 1)!.records.map(r => r.kind)).toEqual(['accepted', 'fixed', 'sent'])
    expect(events.map(e => e.type)).toEqual(['stored', 'append-failed', 'writable'])
    assertNoLeak(events)
  })

  const outcome = (append: Promise<void>) => append.then(() => 'stored', (error: unknown) => error instanceof QueueOutcomeFinal ? 'final' : 'refused')
  test.each([['fixed', 1], ['withdrawn', 0]] as const)('concurrent fixed and withdrawn appends durably keep only the first, %s, through reopen', async (first, open1) => {
    const events: QueueEvent[] = [], onEvent = (e: QueueEvent) => { events.push(e) }
    let q = await open({ now: () => 1000, onEvent })
    await q.accept('alpha', reactionInput())
    const fixed: QueueRecord = { v: 1, kind: 'fixed', seq: 1, parts: ['reaction text'] }
    const [winner, loser] = first === 'fixed' ? [fixed, withdrawn()] : [withdrawn(), fixed]
    expect(await Promise.all([outcome(q.append('alpha', winner)), outcome(q.append('alpha', loser))])).toEqual(['stored', 'final'])
    expect(readQueue(dir).map(r => r.kind)).toEqual(['accepted', first])
    const item = q.item('alpha', 1)!
    expect([item.fixed, item.withdrawn]).toEqual(first === 'fixed' ? [fixed, undefined] : [undefined, withdrawn()])
    expect(item.delivered).toBe(false)
    expect(q.openCount('alpha')).toBe(open1)
    await q.stop()
    q = await open({ now: () => 1000, onEvent })
    expect(q.openCount('alpha')).toBe(open1)
    // Startup compaction removes a withdrawn item; either way the late loser is final.
    expect(await outcome(q.append('alpha', loser))).toBe('final')
    expect(q.isWritable!('alpha')).toBe(true)
    expect(events.filter(e => e.type === 'append-failed')).toEqual([])
    expect(readQueue(dir).some(r => r.kind === loser.kind)).toBe(false)
    expect(q.lookupReactionKey('alpha', key)).toMatchObject({ status: 'duplicate', seq: 1 })
    // A sequence never allocated is not closed work.
    expect(await outcome(q.append('alpha', { ...loser, seq: 2 }))).toBe('refused')
    assertNoLeak(events)
  })

  test.each([
    ['a Slack item ignores a withdrawn record', [accepted(), withdrawn()], 1, undefined],
    ['fixed before withdrawn stays fixed', [reactionRecord(), { v: 1, kind: 'fixed', seq: 1, parts: ['text'] }, withdrawn()], 1, undefined],
    ['withdrawn before fixed stays withdrawn and undelivered', [reactionRecord(), withdrawn(), { v: 1, kind: 'fixed', seq: 1, parts: ['text'] }, deliveredRecord()], 0, 2000],
  ] as [string, QueueRecord[], number, number | undefined][])('replay: %s', async (_, records, openCount, closedAt) => {
    seedQueue(dir, records)
    const q = await open({ now: () => 5000 })
    expect(q.openCount('alpha')).toBe(openCount)
    expect(q.item('alpha', 1)?.withdrawn).toBeUndefined()
    expect(readQueue(dir).filter(r => 'compact' in r && r.compact === 'reaction-key').map(r => 'closed_at' in r ? r.closed_at : undefined)).toEqual(closedAt === undefined ? [] : [closedAt])
  })

  test.each([
    ['delivered', [{ v: 1, kind: 'fixed', seq: 2, parts: ['CLOSED-PART-MARKER'] }, deliveredRecord(2, 1000 + QUEUE_KEY_KEEP_MS - 10)]],
    ['withdrawn', [withdrawn({ seq: 2, at: 1000 + QUEUE_KEY_KEEP_MS - 10 })]],
  ] as [string, QueueRecord[]][])('a %s reaction compacts to its content-free key until QUEUE_KEY_KEEP_MS after intake while open reaction facts survive', async (_, closing) => {
    const clock = createFakeClock({ start: 1000 })
    let q = await open({ now: clock.now })
    const survivor = reactionInput({ origin: 'bot-tool', mode: 'open', reactor_persona_name: 'Open Persona', user: undefined, bot_id: 'B0BOT001', emoji: 'eyes' })
    const closed = reactionInput({ origin: 'bot-tool', reactor_persona_name: 'CLOSED-NAME-MARKER' })
    expect(await q.accept('alpha', survivor)).toMatchObject({ status: 'accepted', seq: 1 })
    expect(await q.accept('alpha', closed)).toMatchObject({ status: 'accepted', seq: 2 })
    await clock.advance(QUEUE_KEY_KEEP_MS - 10)
    for (const record of closing) await q.append('alpha', record)
    const openRecord = { ...survivor, v: 1, kind: 'accepted', seq: 1, received_at: 1000, attempt_high_watermark: 0 } as AcceptedRecord
    const keyRecord: QueueRecord = { v: 1, kind: 'accepted', seq: 2, compact: 'reaction-key', reaction_key: closed.reaction_key, received_at: 1000, closed_at: 1000 + QUEUE_KEY_KEEP_MS - 10 }
    await q.compact('alpha')
    expect(nonAllocation()).toEqual([openRecord, keyRecord])
    for (const marker of ['CLOSED-NAME-MARKER', 'CLOSED-PART-MARKER']) expect(fs.readFileSync(queuePath(dir), 'utf8')).not.toContain(marker)
    await clock.advance(9)
    await q.compact('alpha')
    await q.stop()
    q = await open({ now: clock.now })
    expect(nonAllocation()).toEqual([openRecord, keyRecord])
    expect(q.lookupReactionKey('alpha', closed.reaction_key)).toEqual({ status: 'duplicate', seq: 2 })
    expect(await q.accept('alpha', closed)).toEqual({ status: 'duplicate', seq: 2 })
    expect(q.items('alpha').map(i => i.accepted)).toEqual([openRecord])
    await clock.advance(1)
    await q.compact('alpha')
    expect(nonAllocation()).toEqual([openRecord])
    expect(q.lookupReactionKey('alpha', closed.reaction_key)).toBeUndefined()
    await clock.advance(3 * QUEUE_KEY_KEEP_MS)
    await q.compact('alpha')
    await q.stop()
    q = await open({ now: clock.now })
    expect(nonAllocation()).toEqual([openRecord])
    expect(q.item('alpha', 1)!.accepted).toEqual(openRecord)
    expect(q.lookupReactionKey('alpha', survivor.reaction_key)).toEqual({ status: 'duplicate', seq: 1, item: q.item('alpha', 1) })
    expect(q.lookupReactionKey('alpha', closed.reaction_key)).toBeUndefined()
    // No record names seq 2 now, yet a late outcome for it is still final and blocks nothing.
    for (const late of [{ v: 1, kind: 'fixed', seq: 2, parts: ['late'] }, withdrawn({ seq: 2 })] as QueueRecord[]) await expect(q.append('alpha', late)).rejects.toBeInstanceOf(QueueOutcomeFinal)
    expect(q.isWritable!('alpha')).toBe(true)
    expect(nonAllocation()).toEqual([openRecord])
    expect(await q.accept('alpha', closed)).toMatchObject({ status: 'accepted', seq: 3 })
  })

  test.each([
    ['accepted reaction without its mode', { ...reactionRecord({ emoji: 'eyes' }), seq: 2, mode: undefined }, true],
    // Read as a durable outcome, it would close seq 1 on replay.
    ['withdrawal of seq 1 with an array fungible-refused reason', { ...withdrawn(), reason: ['fungible-refused'] }, false],
    // A known kind inside an array is still an unknown kind, so it alerts.
    ['record whose kind is an array', { v: 1, kind: ['withdrawn'], seq: 9 }, true],
  ] as [string, Record<string, unknown>, boolean][])('a malformed %s in the middle of a journal is quarantined while valid work replays in order and stays open', async (_, record, alert) => {
    const events: QueueEvent[] = []
    const damaged = JSON.stringify(record) + '\n'
    seedQueue(dir, [reactionRecord(), damaged, { ...accepted(), seq: 3 }])
    const q = await open({ now: () => 5000, onEvent: e => { events.push(e) } })
    expect(q.items('alpha').map(i => [i.accepted.seq, i.accepted.source])).toEqual([[1, 'reaction'], [3, 'slack']])
    expect(q.item('alpha', 1)!.withdrawn).toBeUndefined()
    expect(q.openCount('alpha')).toBe(2)
    const unreadable = events.filter((e): e is Extract<QueueEvent, { type: 'record-unreadable' }> => e.type === 'record-unreadable')
    expect(unreadable).toMatchObject([{ key: 'alpha', line: 2, alert }])
    expect(fs.readFileSync(unreadable[0]!.quarantinePath, 'utf8')).toBe(damaged)
    expect(q.lookupReactionKey('alpha', reactionInput({ emoji: 'eyes' }).reaction_key)).toBeUndefined()
    await q.append('alpha', withdrawn())
    expect(q.item('alpha', 1)!.withdrawn).toEqual(withdrawn())
    expect(q.openCount('alpha')).toBe(1)
    assertNoLeak(events)
  })
})
