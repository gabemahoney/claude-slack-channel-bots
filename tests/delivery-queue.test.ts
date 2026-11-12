import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryQueue, isQueueItemClosed, isQueueRecord, isReactionKey, parseQueueRecord, QueueNotWithdrawable, QueueOutcomeFinal, QUEUE_DIRECTORY_MODE, QUEUE_FILE_MODE, QUEUE_KEY_KEEP_MS, QUEUE_COMPACT_INTERVAL_MS, reactionKeyString, type AcceptedRecord, type QueueRecord, type QueueEvent, type DeliveryQueue, type ReactionAcceptedInput, type ReactionKey, type WithdrawnRecord } from '../src/delivery-queue.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { MAX_RELOAD_FILE_BYTES } from '../src/config.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { createDeliveryPreparation } from '../src/delivery-intake.ts'
import { _resetAckTracker, createQueuedAckCallback } from '../src/ack-tracker.ts'
import { deliveredRecord, injectedInput, makeQueue, queuePath, readQueue, seedQueue, sentRecord, slackInput } from './test-helpers/delivery-queue.ts'
import { makeStubSlack } from './test-helpers/slack-stub.ts'

let dir: string
let queues: DeliveryQueue[]
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'delivery-queue-')); queues = [] })
afterEach(async () => { await Promise.all(queues.map(q => q.stop())); _resetAckTracker(); fs.rmSync(dir, { recursive: true, force: true }) })
async function open(options: Parameters<typeof makeQueue>[1] = {}) { const q = await makeQueue(dir, options); queues.push(q); return q }
const accepted = (): AcceptedRecord => ({ ...slackInput(), v: 1, kind: 'accepted', seq: 1, received_at: 1000, ts: '1700000000.000001' })
const kinds: QueueRecord[] = [accepted(), { v: 1, kind: 'fixed', seq: 1, parts: ['exact bytes\n🙂'] }, sentRecord(), deliveredRecord(), { v: 1, kind: 'refused', seq: 1, attempt: 1, at: 1000 }, { v: 1, kind: 'noticed', seq: 1, at: 1000 }, { v: 1, kind: 'reply-reminder', seq: 1, at: 1000, state: 'observed', delivery_attempts: [1] }]
function recordSyncs() {
  const paths = new Map<number, string>(), synced: string[] = []
  let failingPath: string | undefined
  return {
    synced,
    fail(path?: string) { failingPath = path },
    fs: { ...fs,
      openSync(...args: Parameters<typeof fs.openSync>) { const fd = fs.openSync(...args); paths.set(fd, String(args[0])); return fd },
      fsyncSync(fd: number) {
        const path = paths.get(fd)!
        synced.push(path)
        if (path === failingPath) throw new Error('EIO injected sync')
        fs.fsyncSync(fd)
      },
    } as typeof fs,
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
    const seam = { ...fs,
      fsyncSync(fd: number) {
        if (failing && fs.fstatSync(fd).isFile()) throw new Error('EIO append sync')
        fs.fsyncSync(fd)
      },
      ftruncateSync(fd: number, length = 0) {
        if (failing) throw new Error('EIO rollback')
        truncations.push(length)
        fs.ftruncateSync(fd, length)
      },
    } as typeof fs
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
    const seam = { ...fs,
      writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) {
        if (failing && step === 'write') { failures++; throw new Error('EIO metadata write') }
        return fs.writeSync(fd, buffer, offset, length, position)
      },
      fsyncSync(fd: number) {
        const stat = fs.fstatSync(fd)
        if (failing && ((step === 'fsync' && stat.isFile()) || (step === 'directory-sync' && stat.isDirectory()))) { failures++; throw new Error('EIO metadata fsync') }
        fs.fsyncSync(fd)
      },
      renameSync(from: fs.PathLike, to: fs.PathLike) {
        if (failing && step === 'rename') { failures++; throw new Error('EIO metadata rename') }
        fs.renameSync(from, to)
      },
    } as typeof fs
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
  const synced: string[] = []; const paths = new Map<number, string>()
  const seam = { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => { const fd = fs.openSync(...args); paths.set(fd, String(args[0])); return fd }, fsyncSync: (fd: number) => { synced.push(paths.get(fd)!); fs.fsyncSync(fd) } } as typeof fs
  const q = await open({ fs: seam }); const result = await q.accept('alpha', slackInput())
  expect(result.status).toBe('accepted')
  expect(synced).toContain(queuePath(dir)); expect(synced).toContain(join(dir, 'queue')); expect(synced).toContain(dir)
  expect(fs.statSync(join(dir, 'queue')).mode & 0o777).toBe(QUEUE_DIRECTORY_MODE)
  expect(fs.statSync(queuePath(dir)).mode & 0o777).toBe(QUEUE_FILE_MODE)
  await q.stop(); const replay = await open(); expect(replay.items('alpha')[0]!.accepted.text).toBe('message')
})
test('reuses a durably synced parent while every acceptance and append still syncs its journal and queue directory', async () => {
  const sync = recordSyncs(), queueDir = join(dir, 'queue')
  const q = await open({ fs: sync.fs })
  expect(sync.synced).toEqual([dir])
  expect((await q.accept('alpha', injectedInput())).status).toBe('accepted')
  await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['fixed'] })
  expect((await q.accept('beta', injectedInput())).status).toBe('accepted')
  expect(sync.synced).toEqual([dir, queuePath(dir), queueDir, queuePath(dir), queueDir, queuePath(dir, 'beta'), queueDir])
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
test('queue-directory sync failures publish neither new Slack keys nor completed delivery summaries until retry succeeds', async () => {
  const sync = recordSyncs(), queueDir = join(dir, 'queue')
  const q = await open({ fs: sync.fs })
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
  expect(sync.synced.filter(path => path === dir)).toHaveLength(1)
  expect(sync.synced.filter(path => path === queueDir)).toHaveLength(7)
  // Four failed appends each sync their rollback as well as their candidate.
  expect(sync.synced.filter(path => path === queuePath(dir))).toHaveLength(11)
  await q.stop()
  const replay = await open()
  expect(replay.openCount('alpha')).toBe(0)
  expect(replay.lookupSlackKey('alpha', slackInput().key!)).toEqual({ status: 'duplicate', seq: 1 })
})
test('failed fsync never accepts; successful retry reconciles bytes and gets the same first sequence', async () => {
  let fail = false
  const seam = { ...fs, fsyncSync: (fd: number) => { if (fail && fs.fstatSync(fd).isFile()) throw new Error('EIO'); fs.fsyncSync(fd) } } as typeof fs
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
    const seam = {
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
      fsyncSync(fd: number) {
        // Quarantine must have synced successfully; fail only the directory
        // durability boundary after the replacement journal has been renamed.
        if (fail && failure === 'file-fsync' && rewriteTemp(fd)) fault()
        if (syncingRename && paths.get(fd) === join(dir, 'queue')) {
          syncingRename = false
          if (fail && failure === 'directory-fsync') fault()
        }
        fs.fsyncSync(fd)
      },
      renameSync(from: fs.PathLike, to: fs.PathLike) {
        if (fail && failure === 'rename' && String(to) === queuePath(dir)) fault()
        fs.renameSync(from, to)
        if (String(to) === queuePath(dir)) { renames++; syncingRename = true }
      },
    } as typeof fs
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
    const seam = {
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
      fsyncSync(fd: number) {
        if (fail && ((failure === 'file-sync' && quarantine(fd)) || (failure === 'directory-sync' && paths.get(fd) === join(dir, 'queue')))) {
          failures++
          throw new Error('EIO quarantine durability')
        }
        fs.fsyncSync(fd)
      },
    } as typeof fs
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
  const seam = { ...fs, fsyncSync: (fd: number) => { if (failed && fs.fstatSync(fd).isFile()) throw new Error('EIO'); fs.fsyncSync(fd) } } as typeof fs
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
  const clone = globalThis.structuredClone
  let snapshots = 0
  const cloning = spyOn(globalThis, 'structuredClone').mockImplementation(value => {
    if (value && typeof value === 'object' && 'accepted' in value && 'records' in value) snapshots++
    return clone(value)
  })
  try {
    await Promise.all(Array.from({ length: count }, (_, i) => {
      const ts = `1700000000.${String(i + 1).padStart(6, '0')}`
      return q.accept('alpha', slackInput({ ts, key: { chat_id: slackInput().channel!, ts } })).then(async result => {
        expect(result.status).toBe('accepted')
        if (result.status === 'failed' || !result.item) throw new Error('missing accepted item')
        await preparation.prepare('alpha', result.item)
      })
    }))
    console.info(`queue preparation accepts=${count} item_snapshots=${snapshots} expected=${2 * count}`)
    // One detached acceptance result and one fresh preparation snapshot. A
    // whole-queue refresh instead grows quadratically as this burst queues.
    expect(snapshots).toBe(2 * count)
  } finally {
    cloning.mockRestore()
    await preparation.stop()
  }
  expect(q.openCount('alpha')).toBe(count)
  expect(q.items('alpha').every(item => item.fixed !== undefined)).toBe(true)
})

test('single-item snapshots are fresh, deeply detached and absent after compaction removes their item', async () => {
  const q = await open()
  await q.accept('alpha', slackInput({ files: [{ name: 'original.txt' }] }))
  await q.accept('alpha', injectedInput())
  await q.accept('beta', injectedInput({ text: 'other persona' }))
  expect(q.item('missing', 1)).toBeUndefined()
  expect(q.item('alpha', 99)).toBeUndefined()
  const stale = q.item('alpha', 1)!
  await q.append('alpha', { v: 1, kind: 'fixed', seq: 1, parts: ['fixed bytes'] })
  await q.append('alpha', sentRecord())
  const current = q.item('alpha', 1)!
  expect(stale.fixed).toBeUndefined()
  expect(current).toEqual(q.items('alpha')[0])
  const unchanged = q.item('alpha', 1)!
  current.accepted.text = 'changed'
  current.accepted.files![0]!.name = 'changed.txt'
  current.fixed!.parts[0] = 'changed bytes'
  current.records.find(record => record.kind === 'sent')!.attempt = 99
  expect(q.item('alpha', 1)).toEqual(unchanged)
  expect(q.item('beta', 1)!.accepted.text).toBe('other persona')
  await q.append('alpha', deliveredRecord())
  expect(q.item('alpha', 1)!.delivered).toBe(true)
  expect(current.delivered).toBe(false)
  await q.compact('alpha')
  expect(q.item('alpha', 1)).toBeUndefined()
  expect(q.item('alpha', 2)).toEqual(q.items('alpha')[0])
  expect(q.item('beta', 1)!.accepted.text).toBe('other persona')
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
  const order: string[] = []; const paths = new Map<number, string>()
  const seam = { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => { const fd = fs.openSync(...args); paths.set(fd, String(args[0])); return fd }, writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number) => fs.writeSync(fd, buffer, offset, Math.min(length, 7)), fsyncSync: (fd: number) => { order.push(paths.get(fd)!); fs.fsyncSync(fd) } } as typeof fs
  const q = await open({ fs: seam }); expect((await q.accept('alpha', injectedInput({ text: '🙂'.repeat(40) }))).status).toBe('accepted'); expect(readQueue(dir)[0]).toMatchObject({ text: '🙂'.repeat(40) }); expect(order.lastIndexOf(join(dir, 'queue'))).toBeGreaterThan(order.lastIndexOf(queuePath(dir)))
})

// acceptance failures must never turn uncertain bytes into replayed work.
test.each(['truncate', 'fsync'] as const)('keeps the original rollback boundary through repeated reconciliation %s failures', async failure => {
  let phase: 'ok' | 'failed-append' | 'reconcile' = 'ok'
  const truncations: number[] = []
  const seam = {
    ...fs,
    fsyncSync(fd: number) {
      if (phase !== 'ok' && fs.fstatSync(fd).isFile()) throw new Error('EIO fsync')
      fs.fsyncSync(fd)
    },
    ftruncateSync(fd: number, length = 0) {
      truncations.push(length)
      if (phase === 'failed-append' || phase === 'reconcile' && failure === 'truncate') throw new Error('EIO truncate')
      fs.ftruncateSync(fd, length)
    },
  } as typeof fs
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
  const seam = {
    ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) { const fd = fs.openSync(...args); paths.set(fd, String(args[0])); return fd },
    writeSync(fd: number, bytes: Uint8Array, offset: number, length: number) {
      const written = fs.writeSync(fd, bytes, offset, length)
      if (fail && quarantine(fd) && failure === 'write') throw new Error('EIO full write')
      return written
    },
    fsyncSync(fd: number) {
      if (fail && quarantine(fd) && failure !== 'write') throw new Error('EIO fsync')
      fs.fsyncSync(fd)
    },
    ftruncateSync(fd: number, length = 0) {
      if (fail && quarantine(fd) && failure === 'truncate') throw new Error('EIO truncate')
      fs.ftruncateSync(fd, length)
    },
  } as typeof fs
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
  const clock = createFakeClock()
  const scheduled: number[] = []
  const q = await open({ now: clock.now,
    setInterval: ((callback: () => void, delay: number) => {
      scheduled.push(delay)
      const handle: { current?: unknown } = {}
      const fire = () => { callback(); handle.current = clock.setTimeout(fire, delay) }
      handle.current = clock.setTimeout(fire, delay)
      return handle
    }) as unknown as typeof setInterval,
    clearInterval: handle => clock.clearTimeout((handle as unknown as { current: unknown }).current),
  })
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

/** A Reaction Item input whose key agrees with its fields unless `reaction_key` is overridden. */
function reactionInput(overrides: Partial<ReactionAcceptedInput> = {}): ReactionAcceptedInput {
  const fields = { channel: 'C0TEST001', message_ts: '1700000000.000001', ts: '1700000000.000002', change: 'added' as const, emoji: 'thumbsup', user: 'U0REACTOR', ...overrides }
  const reaction_key = overrides.reaction_key ?? { chat_id: fields.channel, message_ts: fields.message_ts, reactor: fields.user || fields.bot_id || '', emoji: fields.emoji, change: fields.change, event_ts: fields.ts }
  return { source: 'reaction', text: '', origin: 'slack-event', mode: 'declarative', ...fields, reaction_key }
}
const reactionRecord = (overrides: Partial<ReactionAcceptedInput> = {}): AcceptedRecord => ({ ...reactionInput(overrides), v: 1, kind: 'accepted', seq: 1, received_at: 1000 })
const withdrawn = (overrides: Partial<WithdrawnRecord> = {}): WithdrawnRecord => ({ v: 1, kind: 'withdrawn', seq: 1, reason: 'server-post', at: 2000, ...overrides })
/** Compaction writes retained key facts before items; order by sequence instead. */
const nonAllocation = () => readQueue(dir).filter(r => !('compact' in r && r.compact === 'allocation')).sort((a, b) => a.seq - b.seq)
type StoreFailed = Extract<QueueEvent, { type: 'store-failed' }>

describe('Reaction Item journal', () => {
  const key = reactionInput().reaction_key
  test.each([
    ['a declarative slack-event from a user', {}, 'U0REACTOR'],
    ['a fungible slack-event from a bot', { mode: 'fungible', user: undefined, bot_id: 'B0BOT001' }, 'B0BOT001'],
    ['a removed reaction naming both user and bot', { change: 'removed', bot_id: 'B0BOT001' }, 'U0REACTOR'],
    ['a declarative bot-tool with an arbitrary stored persona name', { origin: 'bot-tool', reactor_persona_name: 'Persona name ✨ / #ops "quoted"', user: undefined, bot_id: 'B0BOT001' }, 'B0BOT001'],
    ['a fungible bot-tool from a user', { origin: 'bot-tool', mode: 'fungible', reactor_persona_name: 'x' }, 'U0REACTOR'],
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
    ['an array mode', { mode: ['declarative'] }, true],
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
    const input = reactionInput({ origin: 'bot-tool', mode: 'fungible', reactor_persona_name: 'Stored Persona ✨', user: undefined, bot_id: 'B0BOT001', ts: '1700000000.000100' })
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
    for (const result of results) if (result.status !== 'failed') result.item!.accepted.mode = 'fungible'
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
    ['mode only', {}, { mode: 'fungible' }, 'duplicate'],
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

  test.each(['journal file', 'queue directory'] as const)('a failed %s fsync publishes no reaction acceptance and a retry stores exactly one record', async boundary => {
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

  test.each(['journal file', 'queue directory'] as const)('a failed %s fsync leaves a withdrawal unpublished and retryable until it is durable', async boundary => {
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
    const survivor = reactionInput({ origin: 'bot-tool', mode: 'fungible', reactor_persona_name: 'Open Persona', user: undefined, bot_id: 'B0BOT001', emoji: 'eyes' })
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
