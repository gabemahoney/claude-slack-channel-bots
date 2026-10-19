import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryQueue, isQueueRecord, parseQueueRecord, QUEUE_DIRECTORY_MODE, QUEUE_FILE_MODE, QUEUE_KEY_KEEP_MS, QUEUE_COMPACT_INTERVAL_MS, type QueueRecord, type QueueEvent, type DeliveryQueue } from '../src/delivery-queue.ts'
import { assertNoLeak } from './test-helpers/credentials.ts'
import { MAX_RELOAD_FILE_BYTES } from '../src/config.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { createDeliveryPreparation } from '../src/delivery-intake.ts'
import { deliveredRecord, injectedInput, makeQueue, queuePath, readQueue, seedQueue, sentRecord, slackInput } from './test-helpers/delivery-queue.ts'

let dir: string
let queues: DeliveryQueue[]
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'delivery-queue-')); queues = [] })
afterEach(async () => { await Promise.all(queues.map(q => q.stop())); fs.rmSync(dir, { recursive: true, force: true }) })
async function open(options: Parameters<typeof makeQueue>[1] = {}) { const q = await makeQueue(dir, options); queues.push(q); return q }
const accepted = (): QueueRecord => ({ ...slackInput(), v: 1, kind: 'accepted', seq: 1, received_at: 1000, ts: '1700000000.000001' })
const kinds: QueueRecord[] = [accepted(), { v: 1, kind: 'fixed', seq: 1, parts: ['exact bytes\n🙂'] }, sentRecord(), deliveredRecord(), { v: 1, kind: 'refused', seq: 1, attempt: 1, at: 1000 }, { v: 1, kind: 'noticed', seq: 1, at: 1000 }]
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
describe('six record schemas', () => {
  test.each(kinds.map(r => [r.kind, r] as const))('%s roundtrips and rejects invalid versions, sequence and missing payload', (_, r) => {
    expect(parseQueueRecord(JSON.stringify(r))).toEqual(r)
    expect(isQueueRecord({ ...r, v: 2 })).toBe(false)
    expect(isQueueRecord({ ...r, seq: -1 })).toBe(false)
    expect(isQueueRecord({ v: 1, kind: r.kind, seq: 1 })).toBe(false)
  })
  test.each(['{', 'null', '[]', '{"v":1,"seq":1,"kind":"future"}'])('invalid line %s is unreadable', line => expect(parseQueueRecord(line)).toBeUndefined())
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

// b.omv SR-3: acceptance failures must never turn uncertain bytes into replayed work.
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
