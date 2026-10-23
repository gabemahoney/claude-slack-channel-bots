import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createThreadParticipation } from '../src/thread-participation.ts'
import { createDeliveryPreparation } from '../src/delivery-intake.ts'
import { createSharedChannelAuthority } from '../src/shared-channels.ts'
import { createReplyReminders, REPLY_REMINDER_TEXT, REPLY_TOOL_PREALLOWED_LABEL } from '../src/reply-reminder.ts'
import { _resetAckTracker } from '../src/ack-tracker.ts'
import { RETYPE_BACKOFF_MS, RECEIPT_WAIT_MS } from '../src/delivery-constants.ts'
import { buildMessageNotSavedNotice, MESSAGE_NOT_SAVED, QUEUE_UNWRITABLE } from '../src/delivery-notices.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { cannedGetResult } from './test-helpers/agent-director-stub.ts'
import { appendTranscript, promptEntry } from './test-helpers/working-row-panes.ts'
import { injectedInput } from './test-helpers/delivery-queue.ts'
import { QUEUE_KEY_KEEP_MS, REPLY_REMINDER_KEEP_MS, QUEUE_COMPACT_INTERVAL_MS } from '../src/delivery-queue.ts'
import { resetRoutingState, observedMembership } from './test-helpers/persona-routing-harness.ts'
import { makeQueue, readQueue, queuePath, seedQueue, slackInput, deliveredRecord, sentRecord } from './test-helpers/delivery-queue.ts'
import { readSharedState, sharedChannelPath } from './test-helpers/shared-channels.ts'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'
import { asWebClient, broadcastText, mentionText, makeDm, makeGroupDmMessage } from './test-helpers/slack-stub.ts'
import { makeThreadHarness, threadHold, threadDisk, threadReply, observeThread, acceptObservation, tearJournal,
  THREAD_CHANNEL as C, THREAD_OTHER_CHANNEL as C2, THREAD_ROOT as ROOT, THREAD_OTHER_ROOT as ROOT2,
  type ThreadHarness } from './test-helpers/thread-participation.ts'

let dir: string, harnesses: ThreadHarness[]
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'thread-participation-')); harnesses = []; resetRoutingState() })
afterEach(async () => { for (const h of harnesses) await h.close(); resetRoutingState(); fs.rmSync(dir, { recursive: true, force: true }) })
async function open(options: Parameters<typeof makeThreadHarness>[1] = {}) {
  const h = await makeThreadHarness(dir, options); harnesses.push(h); return h
}
const accepted = (h: ThreadHarness, key = 'alpha') => h.h.queue.items(key).map(i => i.accepted)
const ackCount = (h: ThreadHarness, key = 'alpha') => h.h.p(key).stub.calls.reactionsAdd.length

async function reopenAmbiguousRoutedAcceptance() {
  const first = await open()
  const event = first.mention({ thread_ts: ROOT2, text: `${first.mention().text}\r\n  original 🦀\n\n`,
    files: [{ name: 'notes.txt', mimetype: 'text/plain', size: 9 }] })
  first.disk.fail('ambiguous', 'accepted')
  expect(await first.receive(event)).toEqual({ returned: true, acknowledged: 0 })
  expect(first.disk.failures).toContain('ambiguous')
  expect(accepted(first)).toEqual([])
  expect(first.received).toEqual([])
  expect(ackCount(first)).toBe(0)
  const original = readQueue(dir).find(record => record.kind === 'accepted')!
  if (original.kind !== 'accepted' || 'compact' in original) throw new Error('missing routed acceptance bytes')
  expect(original).toMatchObject({ source: 'slack', via: 'mention', thread_ts: ROOT2,
    text: event.text, files: event.files, queued_ack_reaction: first.h.config!.queued_ack_reaction })
  expect(original.queued_ack_reaction).toBeDefined()
  await first.close()
  const disk = threadDisk()
  disk.fail('fsync', 'thread-participation')
  const h = await open({ disk, clock: first.clock })
  expect(disk.failures).toContain('fsync')
  expect(h.read(ROOT2)).toBe('unresolved')
  expect(accepted(h)).toEqual([original])
  h.h.config!.queued_ack_reaction = 'hourglass'
  expect(h.h.config!.queued_ack_reaction).not.toBe(original.queued_ack_reaction)
  return { h, event, original }
}

describe('permanent participation and joint queue recovery', () => {
  test('observation is synchronous, isolated and idempotent, but only accepted evidence follows a thread', async () => {
    const h = await open(), observation = observeThread(h)
    expect(h.read()).toBe('unresolved')
    expect(h.read(ROOT2)).toBe('unfollowed')
    expect(h.read(ROOT, 'beta')).toBe('unfollowed')
    expect(h.read(ROOT, 'alpha', C2)).toBe('unfollowed')
    expect(h.threads.pending()).toEqual([observation])
    expect(accepted(h)).toEqual([])
    expect(observeThread(h)).toEqual(observation)
    await h.threads.persist(observation)
    expect(h.threads.recover('alpha', observation.id)).toBe('unresolved')
    expect(h.read()).toBe('unresolved')
    const stored = await acceptObservation(h, observation)
    expect(stored.status).toBe('accepted')
    expect(h.threads.recover('alpha', observation.id)).toBe('current')
    expect(h.read()).toBe('followed')
    expect(h.threads.pending()).toEqual([])
    expect((await acceptObservation(h, observation)).status).toBe('duplicate')
    expect(accepted(h)).toHaveLength(1)
    observation.root = ROOT2
    expect(h.read(ROOT2)).toBe('unfollowed')
    expect(h.read()).toBe('followed')
  })

  test.each(['observed', 'accepted', 'recovered'] as const)('startup compaction before authority initialization preserves %s evidence', async boundary => {
    const h = await open(), observation = observeThread(h)
    await h.threads.persist(observation)
    if (boundary !== 'observed') await acceptObservation(h, observation)
    if (boundary === 'recovered') h.threads.recover('alpha', observation.id)
    await h.close()
    const queue = await makeQueue(dir)
    // Exactly the startup order: queue.start() has compacted before this authority exists.
    const authority = createSharedChannelAuthority(sharedChannelPath(dir), readSharedState(dir)!)
    const threads = createThreadParticipation({ queue, authority })
    expect(threads.read('alpha', C, ROOT).kind).toBe('unresolved')
    threads.start()
    expect(threads.read('alpha', C, ROOT).kind).toBe(boundary === 'observed' ? 'unresolved' : 'followed')
    expect(threads.pending()).toHaveLength(boundary === 'observed' ? 1 : 0)
    if (boundary === 'observed') {
      const stored = await queue.accept('alpha', slackInput({ key: observation.slackKey, ts: ROOT, via: 'mention', thread_enrollment: observation }))
      expect(stored.status).toBe('accepted')
    }
    expect(threads.recover('alpha', observation.id)).toBe('current')
    expect(queue.items('alpha')).toHaveLength(1)
    expect(queue.lookupSlackKey('alpha', observation.slackKey!)?.status).toBe('duplicate')
    threads.stop(); await queue.stop()
  })

  test('hourly and startup compaction retain followed and unfinished observations beyond all finite windows', async () => {
    let maintain!: () => void, interval = 0
    const h = await open({ queue: { setInterval: ((fn: () => void, ms: number) => { maintain = fn; interval = ms; return 1 }) as any, clearInterval: (() => {}) as any } })
    await h.receive(h.mention())
    const first = h.h.queued('alpha')[0]!
    await h.h.queue.append('alpha', sentRecord(first.accepted.seq))
    await h.h.queue.append('alpha', deliveredRecord(first.accepted.seq, h.clock.now()))
    const pending = observeThread(h, { root: ROOT2 }); await h.threads.persist(pending)
    await h.h.queue.compact()
    expect(h.h.queue.lookupSlackKey('alpha', first.accepted.key!)).toMatchObject({ status: 'duplicate', seq: first.accepted.seq, enrollment: first.accepted.thread_enrollment })
    expect(h.h.queue.items('alpha')).toEqual([])
    h.h.queue.startMaintenance(); expect(interval).toBe(QUEUE_COMPACT_INTERVAL_MS)
    const dedupeOnly = () => readQueue(dir).some(r => r.kind === 'accepted' && 'compact' in r && r.compact === 'key')
    const threadStates = () => h.h.queue.threadRecords('alpha').map(r => [r.observation.root, r.state])
    const retainedThreads = threadStates()
    expect(retainedThreads).toEqual([[ROOT, 'enrolled'], [ROOT2, 'observed']])
    await h.clock.advance(Math.max(QUEUE_KEY_KEEP_MS, REPLY_REMINDER_KEEP_MS, 31 * 24 * 60 * 60 * 1000) + 1)
    expect(dedupeOnly()).toBe(true)
    // The hourly callback alone, with no explicit compaction.
    maintain(); await h.clock.flush()
    expect(dedupeOnly()).toBe(false)
    expect(h.h.queue.replyReminderItems('alpha')).toEqual([])
    expect(threadStates()).toEqual(retainedThreads)
    expect(readQueue(dir).filter(r => r.kind === 'thread-participation').map(r => r.kind === 'thread-participation' && [r.observation.root, r.state]))
      .toEqual(retainedThreads)
    expect(h.read()).toBe('followed'); expect(h.read(ROOT2)).toBe('unresolved')
    await h.h.queue.compact()
    expect(threadStates()).toEqual(retainedThreads)
    await h.close()
    const reopened = await open({ clock: h.clock })
    expect(reopened.read()).toBe('followed'); expect(reopened.read(ROOT2)).toBe('unresolved')
    const duplicate = reopened.h.queue.lookupSlackKey('alpha', first.accepted.key!)
    expect(duplicate).toMatchObject({ status: 'duplicate', seq: first.accepted.seq, enrollment: first.accepted.thread_enrollment })
    expect(duplicate && duplicate.status !== 'failed' ? duplicate.item : null).toBeUndefined()
    expect((await reopened.receive(h.mention())).acknowledged).toBe(1)
    expect(accepted(reopened)).toEqual([])
    const repaired = await acceptObservation(reopened, pending)
    expect(repaired.seq).toBe(first.accepted.seq + 1)
    reopened.threads.recover('alpha', pending.id)
    expect(reopened.read(ROOT2)).toBe('followed')
  })

  test.each(['write', 'fsync', 'ambiguous'] as const)('%s at observation or acceptance never publishes an unsynced enrollment', async kind => {
    const h = await open(), observation = observeThread(h)
    h.disk.fail(kind, 'thread-participation')
    await expect(h.threads.persist(observation)).rejects.toThrow('injected participation disk failure')
    expect(h.read()).toBe('unresolved'); expect(accepted(h)).toEqual([])
    h.disk.repair(); await h.threads.persist(observation)
    h.disk.fail(kind, 'accepted')
    const failed = await h.h.queue.accept('alpha', slackInput({ ts: ROOT, key: observation.slackKey, thread_enrollment: observation }))
    expect(failed.status).toBe('failed')
    expect(h.threads.recover('alpha', observation.id)).toBe('unresolved')
    expect(h.read()).toBe('unresolved'); expect(accepted(h)).toEqual([])
    const independent = await h.h.queue.accept('beta', slackInput())
    expect(independent.status).toBe('accepted')
    h.disk.repair()
    await h.h.queue.compact('alpha') // reconciles an ambiguous append before rewriting
    await h.close()
    const reopened = await open()
    expect(reopened.read()).toBe('unresolved')
    expect((await acceptObservation(reopened, observation)).status).toBe('accepted')
    expect(reopened.threads.recover('alpha', observation.id)).toBe('current')
    expect(accepted(reopened)).toHaveLength(1); expect(accepted(reopened, 'beta')).toHaveLength(1)
  })

  test('corrupt participation preserves trustworthy roots and accepted queues while negative readings stay unresolved', async () => {
    const h = await open(); await h.receive(h.mention()); await h.receive(h.mention({}, 'beta'), ['beta'])
    const observation = observeThread(h, { root: ROOT2 }); await h.threads.persist(observation)
    await h.close()
    const records = readQueue(dir)
    const malformed = { ...records.find(r => r.kind === 'thread-participation' && r.observation.id === observation.id)! }
    if (malformed.kind !== 'thread-participation') throw new Error('missing production observation')
    malformed.observation = { ...malformed.observation, root: 'not-a-timestamp' }
    seedQueue(dir, [...records, JSON.stringify(malformed) + '\n'])
    const reopened = await open()
    expect(reopened.read()).toBe('followed')
    expect(reopened.read(ROOT2)).toBe('unresolved')
    expect(reopened.read('1700000000.000300')).toBe('unresolved')
    expect(reopened.read(ROOT, 'beta')).toBe('followed')
    expect(accepted(reopened)).toHaveLength(1)
    expect((await reopened.receive(threadReply())).acknowledged).toBe(1)
    await reopened.h.queue.compact(); reopened.restoreOwner()
    expect(reopened.read(ROOT2)).toBe('unresolved')
    assertNoLeak(writtenFile(queuePath(dir)))
  })

  test('an unreadable startup journal cannot become an empty followed set and repairs through the production reader', async () => {
    const h = await open(); await h.receive(h.mention()); await h.close()
    const disk = threadDisk(); disk.fail('read')
    const reopened = await open({ disk })
    expect(reopened.read()).toBe('unresolved')
    expect((await reopened.receive(threadReply())).acknowledged).toBe(0)
    expect(reopened.h.p('alpha').stub.calls.usersInfo).toEqual([])
    const candidates = () => reopened.h.routing.pendingCandidates().map(c => [c.key, c.channel, c.root])
    expect(candidates()).toEqual([['alpha', C, ROOT]])
    disk.repair(); disk.fail('recovery-fsync')
    expect(() => reopened.threads.recover('alpha')).toThrow('injected participation disk failure')
    expect(disk.failures).toContain('recovery-fsync')
    expect(reopened.read()).toBe('unresolved')
    let acks = 0
    await reopened.h.routing.receive(threadReply(), () => { acks++ }, 'alpha', false)
    expect(acks).toBe(0)
    expect(candidates()).toEqual([['alpha', C, ROOT]])
    disk.repair(); reopened.threads.recover('alpha')
    expect(reopened.read()).toBe('followed')
    // The retained candidate carries the latest unacknowledged delivery.
    await reopened.h.routing.reevaluate(reopened.h.routing.pendingCandidates()[0]!.id)
    expect(acks).toBe(1)
    expect(candidates()).toEqual([])
    expect(accepted(reopened).map(a => a.via)).toEqual(['mention', 'thread'])
  })

  const ROOT3 = '1700000000.000300'
  const reading = (h: ThreadHarness, root: string, kind: 'followed' | 'unfollowed' | 'unresolved', failure?: 'storage') =>
    expect(h.threads.read('alpha', C, root)).toEqual({ key: 'alpha', channel: C, root, kind, ...(failure ? { failure } : {}) })
  const identities = (h: ThreadHarness) => accepted(h).map(a => [a.seq, a.source, a.ts, a.thread_enrollment?.id])
  const quarantined = () => fs.readdirSync(join(dir, 'queue')).filter(f => f.startsWith('alpha.unreadable-')).map(f => fs.readFileSync(join(dir, 'queue', f)))
  const EMOJI = '🚀'
  /** A followed ROOT, then the production record whose final append is torn. */
  async function journalWithTail(tail: 'slack' | 'emoji' | 'interject' | 'observed' | 'cancelled' | 'enrolled') {
    const h = await open(); await h.receive(h.mention())
    const kept = identities(h), observation = ['slack', 'emoji', 'interject'].includes(tail) ? undefined : observeThread(h, { root: ROOT2 })
    if (observation) await h.threads.persist(observation)
    if (tail === 'slack' || tail === 'emoji') {
      await h.h.queue.accept('alpha', slackInput({ channel: C, key: { chat_id: C, ts: '1700000000.000400' }, ts: '1700000000.000400', text: tail === 'emoji' ? `shipped ${EMOJI} today` : 'message' }))
    }
    if (tail === 'interject') await h.h.queue.accept('alpha', injectedInput())
    if (tail === 'cancelled') { await h.choose('off'); await h.threads.discardIncoming(observation!.lifetime, observation!.slackKey!) }
    if (tail === 'enrolled') await acceptObservation(h, observation!)
    await h.close()
    return { kept, observation, clock: h.clock }
  }

  test.each(['slack', 'emoji', 'interject', 'observed', 'cancelled', 'enrolled'] as const)('a torn final %s append is an unfinished write: no gap through start, hourly compaction and reopen', async tail => {
    const { kept, observation, clock } = await journalWithTail(tail)
    const { torn } = tearJournal(dir, 'final', 'alpha', tail === 'emoji' ? EMOJI : undefined)
    // The emoji cut leaves an incomplete UTF-8 sequence, not merely shorter valid text.
    expect(Buffer.from(torn.toString()).equals(torn)).toBe(tail !== 'emoji')
    const stillPending = tail === 'cancelled' || tail === 'enrolled'
    const check = (h: ThreadHarness) => {
      expect(h.h.queue.threadReadable('alpha')).toBe(true)
      expect(readQueue(dir).some(r => r.kind === 'thread-gap')).toBe(false)
      reading(h, ROOT, 'followed'); reading(h, ROOT3, 'unfollowed')
      // The complete observation survives a torn cancellation or enrolled acceptance as pending, never as its outcome.
      reading(h, ROOT2, stillPending ? 'unresolved' : 'unfollowed')
      expect(h.threads.pending('alpha')).toEqual(stillPending ? [observation!] : [])
      if (observation) expect(h.h.queue.threadRecord('alpha', observation.id)?.state).toBe(stillPending ? 'observed' : undefined)
      expect(identities(h)).toEqual(kept)
      expect(quarantined()).toEqual([torn])
    }
    const h = await open({ clock })
    expect(h.h.queue.startupFindings()).toEqual([expect.objectContaining({ type: 'record-unreadable', key: 'alpha', alert: false })])
    check(h)
    await h.h.queue.compact(); check(h)
    await h.close()
    const reopened = await open({ clock })
    expect(reopened.h.queue.startupFindings()).toEqual([])
    check(reopened)
  })

  test.each(['terminated', 'mid'] as const)('complete damage (%s) still persists the participation gap', async at => {
    const { clock } = await journalWithTail('observed')
    tearJournal(dir, at)
    for (let life = 0; life < 2; life++) {
      const h = await open({ clock })
      expect(h.h.queue.threadReadable('alpha')).toBe(false)
      expect(readQueue(dir).filter(r => r.kind === 'thread-gap')).toHaveLength(1)
      reading(h, ROOT, 'followed'); reading(h, ROOT3, 'unresolved', 'storage')
      await h.close()
    }
  })

  test.each(['rewrite', 'truncate'] as const)('a failed startup %s leaves the torn tail repairable by the next append', async kind => {
    const { kept, clock } = await journalWithTail('slack')
    const { torn, prefix } = tearJournal(dir)
    const disk = threadDisk(); disk.fail(kind)
    const h = await open({ disk, clock })
    expect(disk.failures).toContain(kind)
    // Startup truncates before its rewrite, so only a failed truncate leaves the fragment in place.
    expect(fs.readFileSync(queuePath(dir))).toEqual(kind === 'truncate' ? Buffer.concat([prefix, torn]) : prefix)
    expect(h.h.queue.threadReadable('alpha')).toBe(false)
    reading(h, ROOT3, 'unresolved', 'storage')
    if (kind === 'truncate') {
      expect((await h.h.queue.accept('alpha', injectedInput())).status).toBe('failed')
      expect(h.h.queue.threadReadable('alpha')).toBe(false)
    }
    disk.repair()
    expect((await h.h.queue.accept('alpha', injectedInput())).status).toBe('accepted')
    expect(h.h.queue.threadReadable('alpha')).toBe(true)
    expect(fs.readFileSync(queuePath(dir)).includes(torn)).toBe(false)
    reading(h, ROOT, 'followed'); reading(h, ROOT3, 'unfollowed')
    await h.close()
    const reopened = await open({ clock })
    expect(reopened.h.queue.threadReadable('alpha')).toBe(true)
    expect(readQueue(dir).some(r => r.kind === 'thread-gap')).toBe(false)
    reading(reopened, ROOT, 'followed'); reading(reopened, ROOT3, 'unfollowed')
    expect(identities(reopened)).toEqual([...kept, [kept.length + 1, 'interject', expect.any(String), undefined]])
    expect(quarantined()).toEqual([torn])
  })

  test('a torn tail first loaded by recovery after a failed startup read is reconciled without an append', async () => {
    const { kept, clock } = await journalWithTail('slack')
    const { torn, prefix } = tearJournal(dir)
    const disk = threadDisk(); disk.fail('read')
    const h = await open({ disk, clock })
    expect(h.h.queue.threadReadable('alpha')).toBe(false)
    expect(fs.readFileSync(queuePath(dir))).toEqual(Buffer.concat([prefix, torn]))
    disk.repair(); h.threads.recover('alpha')
    expect(h.h.queue.threadReadable('alpha')).toBe(true)
    expect(fs.readFileSync(queuePath(dir))).toEqual(prefix)
    expect(readQueue(dir).some(r => r.kind === 'thread-gap')).toBe(false)
    reading(h, ROOT, 'followed'); reading(h, ROOT3, 'unfollowed')
    expect(identities(h)).toEqual(kept)
    expect(quarantined()).toEqual([torn])
    await h.close()
    const reopened = await open({ clock })
    expect(reopened.h.queue.startupFindings()).toEqual([])
    expect(reopened.h.queue.threadReadable('alpha')).toBe(true)
    expect(readQueue(dir).some(r => r.kind === 'thread-gap')).toBe(false)
    reading(reopened, ROOT, 'followed'); reading(reopened, ROOT3, 'unfollowed')
    expect(identities(reopened)).toEqual(kept)
    expect(quarantined()).toEqual([torn])
  })

  test('an ambiguous acceptance remains unresolved when restart cannot sync its recovered enrollment', async () => {
    const h = await open(), observation = observeThread(h)
    await h.threads.persist(observation)
    h.disk.fail('ambiguous', 'accepted')
    const result = await h.h.queue.accept('alpha', slackInput({ key: observation.slackKey, ts: ROOT, thread_enrollment: observation }))
    expect(result.status).toBe('failed')
    expect(h.read()).toBe('unresolved')
    // A new owner has no memory of the failed rollback. Preserve the bytes a
    // crash left; do not repair/compact with the old owner before reopening.
    await h.close()
    const disk = threadDisk(); disk.fail('fsync', 'thread-participation')
    const reopened = await open({ disk })
    expect(disk.failures).toContain('fsync')
    const reading = reopened.read()
    const duplicate = await reopened.receive(h.mention())
    expect({ reading, acknowledged: duplicate.acknowledged }).toEqual({ reading: 'unresolved', acknowledged: 0 })
    disk.repair(); await reopened.h.queue.compact(); reopened.restoreOwner()
    expect(reopened.read()).toBe('followed')
    expect((await reopened.receive(h.mention())).acknowledged).toBe(1)
    expect(accepted(reopened).filter(a => a.ts === ROOT)).toHaveLength(1)
  })

  test('ambiguous cancellation cannot authorize discard after a failed startup sync', async () => {
    const h = await open(), observation = observeThread(h)
    await h.threads.persist(observation); await h.choose('off')
    h.disk.fail('ambiguous', 'thread-participation')
    expect((await h.receive(h.mention())).acknowledged).toBe(0)
    expect(h.disk.failures).toContain('ambiguous')
    expect(h.read()).toBe('unresolved')
    await h.close() // Leave the ambiguous bytes for a genuinely new owner.
    const disk = threadDisk(); disk.fail('fsync', 'thread-participation')
    const reopened = await open({ disk })
    expect(disk.failures).toContain('fsync')
    expect(reopened.read()).toBe('unresolved')
    expect((await reopened.receive(h.mention())).acknowledged).toBe(0)
    expect(accepted(reopened)).toEqual([])
    await reopened.notices.runDeferred()
    expect(reopened.notices.h.totalPosts()).toBe(0)
    disk.repair(); await reopened.h.queue.compact(); reopened.restoreOwner()
    expect(reopened.read()).toBe('unfollowed')
    expect((await reopened.receive(h.mention())).acknowledged).toBe(1)
    expect(reopened.threads.pending()).toEqual([])
    expect(accepted(reopened)).toEqual([])
  })

  test.each(['acceptance', 'cancellation'] as const)('%s wins the serialized writer race and survives late observation, compaction and reopen', async first => {
    const events: import('../src/delivery-queue.ts').QueueEvent[] = []
    const h = await open({ queue: { onEvent: event => events.push(event) } }), observation = observeThread(h)
    await h.threads.persist(observation)
    const accept = () => h.h.queue.accept('alpha', slackInput({ channel: C, ts: ROOT, key: observation.slackKey, via: 'mention', thread_enrollment: observation }))
    const cancel = () => h.threads.discardIncoming(observation.lifetime, observation.slackKey!)
    // Both operations are queued before either writer runs.
    const [stored, discarded] = first === 'acceptance'
      ? await Promise.all([accept(), cancel()])
      : await Promise.all([cancel(), accept()]).then(([d, s]) => [s, d] as const)
    if (first === 'acceptance') {
      expect(stored.status).toBe('accepted')
      expect(discarded).toMatchObject({ status: 'duplicate', seq: 1, enrollment: observation })
      expect(h.threads.recover('alpha', observation.id)).toBe('current')
    } else {
      expect(stored).toMatchObject({ status: 'failed', reason: 'cancelled' })
      expect(discarded).toBeUndefined()
    }
    expect(events.filter(e => e.type === 'store-failed')).toEqual([])
    h.threads.observe(observation); await h.threads.persist(observation)
    expect(h.threads.pending()).toEqual([])
    expect(h.read()).toBe(first === 'acceptance' ? 'followed' : 'unfollowed')
    await h.choose('off')
    expect((await h.receive(h.mention())).acknowledged).toBe(1)
    expect(accepted(h)).toHaveLength(first === 'acceptance' ? 1 : 0)
    expect(ackCount(h)).toBe(first === 'acceptance' ? 1 : 0)
    if (first === 'acceptance') {
      const item = h.h.queued('alpha')[0]!
      await h.h.queue.append('alpha', deliveredRecord(item.accepted.seq, h.clock.now()))
    }
    await h.clock.advance(QUEUE_KEY_KEEP_MS + REPLY_REMINDER_KEEP_MS + 1)
    await h.h.queue.compact(); await h.close()
    const reopened = await open({ clock: h.clock })
    expect(accepted(reopened)).toEqual([])
    // An expired compacted acceptance still outranks a discard; cancellation
    // still fences late saves without recreating an accepted item.
    const again = await reopened.threads.discardIncoming(observation.lifetime, observation.slackKey!)
    expect(again).toEqual(first === 'acceptance' ? expect.objectContaining({ status: 'duplicate', seq: 1, enrollment: observation }) : undefined)
    reopened.threads.observe(observation); await reopened.threads.persist(observation)
    expect(reopened.threads.pending()).toEqual([])
    expect(reopened.read()).toBe(first === 'acceptance' ? 'followed' : 'unfollowed')
    expect((await reopened.receive(h.mention())).acknowledged).toBe(1)
    expect(accepted(reopened)).toEqual([])
    expect(reopened.h.queue.threadRecords('alpha')).toEqual([expect.objectContaining({ state: first === 'acceptance' ? 'enrolled' : 'cancelled', observation })])
  })

  test('discarding during intake reconciles an acceptance already queued on the writer', async () => {
    const h = await open(), observation = observeThread(h)
    await h.threads.persist(observation); await h.choose('off')
    // lookup at receive sees no item yet; cancellation joins behind this accept.
    const saving = h.h.queue.accept('alpha', slackInput({ channel: C, ts: ROOT, key: observation.slackKey, via: 'mention', thread_enrollment: observation }))
    const intake = h.receive(h.mention())
    expect((await saving).status).toBe('accepted')
    expect((await intake).acknowledged).toBe(1)
    expect(h.read()).toBe('followed')
    expect(accepted(h)).toHaveLength(1)
    expect(h.received.map(r => r.item.accepted.seq)).toEqual([1])
    expect(ackCount(h)).toBe(1)
    expect(h.h.queued('alpha')[0]!.fixed).toBeDefined()
  })

  test('old accepted text grants no participation; superseded observation/replay cannot enroll or hold a replacement lifetime', async () => {
    const h = await open()
    await h.h.queue.accept('alpha', slackInput({ text: h.mention().text as string, ts: ROOT, key: { chat_id: C, ts: ROOT }, via: 'mention' }))
    h.restoreOwner(); expect(h.read()).toBe('unfollowed')
    const observed = observeThread(h, { root: ROOT2 })
    await h.threads.persist(observed); await acceptObservation(h, observed)
    const a = h.authority
    expect(a.transact(a.revision, (next, order) => { next.personas.alpha!.resetOrder = order })).toMatchObject({ kind: 'applied' })
    expect(h.threads.lifetimeStatus(observed.lifetime)).toBe('superseded')
    expect(await h.threads.persist(observed)).toBe('superseded')
    expect(h.threads.recover('alpha', observed.id)).toBe('superseded')
    expect(h.threads.pending()).toEqual([])
    h.restoreOwner()
    expect(h.read(ROOT2)).toBe('unfollowed')
    expect(accepted(h)).toHaveLength(2)
    await h.close(); const reopened = await open()
    expect(reopened.read(ROOT2)).toBe('unfollowed')
    expect(accepted(reopened)).toHaveLength(2)
  })
})

describe('observed intake, deferred replies and retained feedback', () => {
  test.each([
    ['strict', 'observation', 'none'], ['open', 'observation', 'none'],
    ['strict', 'persistence', 'none'], ['open', 'persistence', 'none'],
    ['strict', 'persistence', 'write'], ['strict', 'persistence', 'fsync'], ['strict', 'persistence', 'ambiguous'],
  ] as const)('%s off applied during %s cancels the original intake (%s fault)', async (mode, boundary, fault) => {
    const gate = threadHold()
    const h = await open({ mode, afterObservationSave: boundary === 'persistence' ? () => gate.wait() : undefined, routing: { routingHooks: {
      _afterObservation: boundary === 'observation' ? () => gate.wait() : undefined,
    } } })
    const event = h.mention()
    let acks = 0, returned = false
    const intake = h.h.routing.receive(event, () => { acks++ }, 'alpha', false).then(() => { returned = true })
    await gate.entered
    const observation = h.threads.pending('alpha')[0]!
    try {
      expect(returned).toBe(false)
      expect(acks).toBe(0)
      expect(accepted(h)).toEqual([])
      expect(h.h.queue.threadRecord('alpha', observation.id)?.state).toBe(boundary === 'persistence' ? 'observed' : undefined)
      await h.choose('off')
      if (fault !== 'none') h.disk.fail(fault, 'thread-participation')
    } finally { gate.release(); await intake }
    await h.drainReactions()
    expect(returned).toBe(true)
    expect(acks).toBe(fault === 'none' ? 1 : 0)
    expect(accepted(h)).toEqual([])
    expect(h.received).toEqual([])
    expect(ackCount(h)).toBe(0)
    if (fault !== 'none') {
      expect(h.disk.failures).toContain(fault)
      expect(h.read()).toBe('unresolved')
      expect(h.threads.pending('alpha')).toEqual([observation])
      expect(h.failures).toMatchObject([{ key: 'alpha', unaccepted: false }])
      h.disk.repair()
      expect((await h.receive(event)).acknowledged).toBe(1)
    } else expect(h.failures).toEqual([])
    expect(h.h.queue.threadRecord('alpha', observation.id)?.state).toBe('cancelled')
    expect(h.threads.pending('alpha')).toEqual([])
    expect(h.read()).toBe('unfollowed')
    await h.notices.runDeferred()
    expect(h.notices.h.totalPosts()).toBe(0)
    await h.h.queue.compact()
    await h.close()
    const reopened = await open({ mode, clock: h.clock })
    await reopened.choose('thread_hybrid')
    expect(reopened.h.queue.threadRecord('alpha', observation.id)?.state).toBe('cancelled')
    expect(reopened.threads.pending()).toEqual([])
    expect(reopened.read()).toBe('unfollowed')
    expect((await reopened.receive(threadReply())).acknowledged).toBe(1)
    expect(accepted(reopened)).toEqual([])
    expect(reopened.received).toEqual([])
    expect(ackCount(reopened)).toBe(0)
  })

  test('off applied to a held original intake preserves an acceptance that already won', async () => {
    const gate = threadHold()
    let first = true
    const h = await open({ routing: { routingHooks: { _afterObservation: () => {
      if (first) { first = false; return gate.wait() }
      return Promise.resolve()
    } } } })
    const event = h.mention(), intake = h.receive(event)
    await gate.entered
    let original: ReturnType<typeof accepted>[number] | undefined
    try {
      expect((await h.receive(event)).acknowledged).toBe(1)
      original = accepted(h)[0]!
      expect(ackCount(h)).toBe(1)
      await h.choose('off')
    } finally { gate.release() }
    expect((await intake).acknowledged).toBe(1)
    expect(accepted(h)).toEqual([original!])
    expect(h.read()).toBe('followed')
    expect(h.threads.pending()).toEqual([])
    expect(h.h.queue.threadRecords('alpha')).toEqual([expect.objectContaining({ state: 'enrolled' })])
    expect(h.received.map(r => r.item.accepted.seq)).toEqual([original!.seq, original!.seq])
    expect(ackCount(h)).toBe(1)
    expect(h.failures).toEqual([])
  })

  test.each(['compact', 'append'] as const)('routed ambiguous replay withholds queued feedback until %s confirms durability', async repair => {
    const { h, event, original } = await reopenAmbiguousRoutedAcceptance()
    expect(await h.receive(event)).toEqual({ returned: true, acknowledged: 0 })
    expect(h.received).toEqual([])
    expect(ackCount(h)).toBe(0)
    expect(h.h.queued('alpha')[0]!.fixed).toBeUndefined()
    expect(h.h.p('alpha').stub.calls.usersInfo).toEqual([])
    expect(h.read(ROOT2)).toBe('unresolved')
    // Both duplicate entry points must carry the same unconfirmed snapshot.
    expect(await h.h.queue.accept('alpha', slackInput({ key: original.key, ts: original.ts })))
      .toMatchObject({ status: 'duplicate', seq: original.seq, durabilityPending: true })
    expect(await h.h.queue.cancelThreadObservation('alpha', original.thread_enrollment!))
      .toMatchObject({ status: 'duplicate', seq: original.seq, durabilityPending: true })
    expect((await h.receive(h.mention({}, 'beta'), ['beta'])).acknowledged).toBe(1)
    expect(ackCount(h, 'beta')).toBe(1)
    expect(h.h.queue.lookupSlackKey('alpha', original.key!)).toMatchObject({ durabilityPending: true })
    h.disk.repair()
    if (repair === 'compact') await h.h.queue.compact('alpha')
    else expect(await h.h.queue.accept('alpha', injectedInput({ text: 'later FIFO item' })))
      .toMatchObject({ status: 'accepted', seq: original.seq + 1 })
    expect(h.h.queue.lookupSlackKey('alpha', original.key!)).not.toHaveProperty('durabilityPending')
    expect((await h.receive(event)).acknowledged).toBe(1)
    expect(h.read(ROOT2)).toBe('followed')
    expect(h.received.filter(r => r.key === 'alpha').map(r => r.item.accepted.seq)).toEqual([original.seq])
    expect(h.h.p('alpha').stub.calls.reactionsAdd).toEqual([{ channel: C, timestamp: original.ts, name: original.queued_ack_reaction! }])
    expect(accepted(h)[0]).toMatchObject(original)
    expect(accepted(h).map(a => a.seq)).toEqual(repair === 'compact' ? [original.seq] : [original.seq, original.seq + 1])
    expect((await h.receive(event)).acknowledged).toBe(1)
    expect(accepted(h).filter(a => a.key?.ts === original.ts)).toEqual([expect.objectContaining(original)])
    expect(ackCount(h)).toBe(1)
  })

  test.each(['immediate', 'retry'] as const)('startup preparation reports ambiguous routed work only after %s fixation', async repair => {
    const { h, event, original } = await reopenAmbiguousRoutedAcceptance()
    const callbacks: Array<{ seq: number; durabilityPending: boolean; fixed: boolean }> = []
    const preparation = createDeliveryPreparation({ queue: h.h.queue, clock: h.clock,
      clientFor: key => asWebClient(h.h.p(key).stub.web), resolveUserName: async () => 'sender',
      onReceived(key, item) {
        const retained = h.h.queue.lookupSlackKey(key, item.accepted.key!)
        callbacks.push({ seq: item.accepted.seq, durabilityPending: retained?.status !== 'failed' && retained?.durabilityPending === true,
          fixed: h.h.queue.item(key, item.accepted.seq)?.fixed !== undefined })
        h.reporting.received(key, item)
      },
    })
    try {
      const previousFailures = h.disk.failures.length
      if (repair === 'retry') h.disk.fail('fsync', 'fixed')
      else h.disk.repair()
      await preparation.recover()
      await h.drainReactions()
      if (repair === 'retry') {
        expect(h.disk.failures.slice(previousFailures)).toContain('fsync')
        expect(callbacks).toEqual([])
        expect(ackCount(h)).toBe(0)
        expect(h.h.queue.lookupSlackKey('alpha', original.key!)).toMatchObject({ durabilityPending: true })
        expect(h.h.queued('alpha')[0]!.fixed).toBeUndefined()
        expect(preparation.owns('alpha', original.seq)).toBe(true)
        expect((await h.receive(event)).acknowledged).toBe(0)
        expect(h.received).toEqual([])
        expect(ackCount(h)).toBe(0)
        h.disk.repair()
        await h.clock.advance(RETYPE_BACKOFF_MS[0])
        await h.drainReactions()
      }
      expect(callbacks).toEqual([{ seq: original.seq, durabilityPending: false, fixed: true }])
      expect(h.h.queue.lookupSlackKey('alpha', original.key!)).not.toHaveProperty('durabilityPending')
      expect(h.h.queued('alpha')[0]!.fixed).toBeDefined()
      expect(preparation.owns('alpha', original.seq)).toBe(false)
      expect(accepted(h)).toEqual([original])
      expect(h.h.p('alpha').stub.calls.reactionsAdd).toEqual([{ channel: C, timestamp: original.ts, name: original.queued_ack_reaction! }])
      expect((await h.receive(event)).acknowledged).toBe(1)
      expect(h.read(ROOT2)).toBe('followed')
      expect(accepted(h)).toEqual([original])
      expect(ackCount(h)).toBe(1)
    } finally { await preparation.stop() }
  })

  test.each(['none', 'write', 'fsync', 'ambiguous'] as const)('off retry after up loss durably discards pending enrollment (%s cancellation fault)', async fault => {
    const h = await open({ routing: { routingHooks: { _afterObservation: async observation => {
      if (observation.lifetime.key === 'alpha') h.h.notUp.add('alpha')
    } } } })
    const mention = h.mention()
    expect((await h.receive(mention)).acknowledged).toBe(0)
    const observation = h.threads.pending('alpha')[0]!
    expect(h.h.queue.threadRecord('alpha', observation.id)?.state).toBe('observed')
    expect(accepted(h)).toEqual([])
    expect(h.failures).toEqual([])
    h.h.notUp.delete('alpha')
    let replyAcks = 0
    await h.h.routing.receive(threadReply(), () => { replyAcks++ }, 'alpha', false)
    const candidate = h.h.routing.pendingCandidates()[0]!
    expect(replyAcks).toBe(0)
    await h.choose('off')
    if (fault !== 'none') {
      h.disk.fail(fault, 'thread-participation')
      expect((await h.receive(mention)).acknowledged).toBe(0)
      expect(h.disk.failures).toContain(fault)
      expect(h.read()).toBe('unresolved')
      expect(h.threads.pending('alpha')).toEqual([observation])
      expect(h.failures).toMatchObject([{ key: 'alpha', unaccepted: false }])
      await h.notices.runDeferred()
      expect(h.notices.h.totalPosts()).toBe(0)
      expect((await h.receive(h.mention({}, 'beta'), ['beta'])).acknowledged).toBe(1)
      expect(h.read(ROOT, 'beta')).toBe('followed')
      h.disk.repair()
    }
    expect((await h.receive(mention)).acknowledged).toBe(1)
    expect(h.read()).toBe('unfollowed')
    expect(h.threads.pending('alpha')).toEqual([])
    expect(accepted(h)).toEqual([]); expect(ackCount(h)).toBe(0)
    await h.choose('thread_hybrid')
    await h.h.routing.reevaluate(candidate.id)
    expect(replyAcks).toBe(1)
    expect(h.h.routing.pendingCandidates()).toEqual([])
    h.threads.observe(observation); await h.threads.persist(observation)
    expect(h.read()).toBe('unfollowed')
    await h.h.queue.compact(); await h.close()
    const reopened = await open({ clock: h.clock })
    expect(reopened.read()).toBe('unfollowed')
    reopened.threads.observe(observation); await reopened.threads.persist(observation)
    expect(reopened.threads.pending('alpha')).toEqual([])
    expect((await reopened.receive(mention)).acknowledged).toBe(1)
    expect((await reopened.receive(threadReply())).acknowledged).toBe(1)
    expect(accepted(reopened)).toEqual([])
    expect((await reopened.receive(reopened.mention({ ts: '1700000001.000100', thread_ts: ROOT }))).acknowledged).toBe(1)
    expect(reopened.read()).toBe('followed')
    expect((await reopened.receive(threadReply())).acknowledged).toBe(1)
    expect(accepted(reopened).map(a => a.via)).toEqual(['mention', 'thread'])
  })

  test('a late observation cannot resume an intake that a concurrent off retry has discarded', async () => {
    const gate = threadHold()
    const h = await open({ routing: { routingHooks: { _afterObservation: () => gate.wait() } } })
    const mention = h.mention()
    let acks = 0
    const intake = h.h.routing.receive(mention, () => { acks++ }, 'alpha', false)
    await gate.entered
    try {
      await h.choose('off')
      expect((await h.receive(mention)).acknowledged).toBe(1)
      expect(h.read()).toBe('unfollowed')
    } finally { gate.release(); await intake }
    expect(acks).toBe(1)
    expect(accepted(h)).toEqual([])
    expect(h.threads.pending()).toEqual([])
    expect(h.failures).toEqual([])
    await h.notices.runDeferred()
    expect(h.notices.h.totalPosts()).toBe(0)
  })

  test('a real save failure posts only after the full multi-recipient intake has returned', async () => {
    const gate = threadHold()
    const h = await open({ routing: { routingHooks: { _afterAcceptance: key => key === 'alpha' ? gate.wait() : Promise.resolve() } } })
    h.disk.fail('write', 'thread-participation', 'beta')
    const event = h.mention({ text: `${mentionText(h.h.p('alpha').stub.identity.botUserId)} ${mentionText(h.h.p('beta').stub.identity.botUserId)}` })
    let returned = false, acks = 0
    const intake = h.h.routing.receive(event, () => { acks++ }, ['alpha', 'beta'], false).then(() => { returned = true })
    await gate.entered
    try {
      await h.clock.flush()
      expect(h.failures).toMatchObject([{ key: 'beta', unaccepted: true }])
      await h.notices.runDeferred()
      expect(returned).toBe(false)
      expect(h.notices.h.totalPosts()).toBe(0)
      expect(h.notices.deferredClock.pendingCount()).toBe(0)
    } finally { gate.release(); await intake }
    expect(returned).toBe(true); expect(acks).toBe(0)
    expect(h.notices.h.totalPosts()).toBe(0)
    await h.drainReactions()
    expect(ackCount(h)).toBe(1); expect(ackCount(h, 'beta')).toBe(0)
    await h.notices.runDeferred()
    expect(h.notices.h.posts('alpha')).toEqual([])
    expect(h.notices.h.posts('beta').map(p => p.text)).toEqual([
      formatPersonaNotice(h.notices.config.personas[1]!, buildMessageNotSavedNotice(h.notices.ref('beta'), event.user as string)),
    ])
  })
  test.each(['mentions', 'all', 'thread_hybrid'] as const)('%s accepts direct mentions with permanent enrollment but never enrolls independent delivery reasons', async delivery => {
    const h = await open({ delivery })
    for (const [i, text] of [broadcastText('here'), broadcastText('channel'), broadcastText('everyone'), '<!subteam^S0GROUP>'].entries()) {
      const ts = `1700000002.00000${i}`
      await h.receive(h.mention({ ts, text }))
      expect(h.read(ts)).toBe('unfollowed')
    }
    const direct = h.mention()
    await h.receive(direct)
    expect(h.read()).toBe('followed')
    expect(accepted(h).find(a => a.ts === ROOT)?.thread_enrollment?.root).toBe(ROOT)
    const id = h.h.p('alpha').stub.identity.botUserId
    const excluded = [makeDm({ text: mentionText(id), ts: ROOT2 }), makeGroupDmMessage({ text: mentionText(id), ts: ROOT2 }),
      h.mention({ ts: ROOT2, user: id }), h.mention({ ts: ROOT2, subtype: 'message_changed' })]
    for (const event of excluded) await h.receive(event)
    expect(h.read(ROOT2)).toBe('unfollowed')
    await h.choose('off'); await h.receive(h.mention({ ts: ROOT2 }))
    expect(h.read(ROOT2)).toBe('unfollowed')
    expect(h.threads.pending()).toEqual([])
  })
  test('established unfollowed replies are settled without a candidate or a network call', async () => {
    const h = await open()
    expect(await h.receive(threadReply())).toEqual({ returned: true, acknowledged: 1 })
    expect(h.h.routing.pendingCandidates()).toEqual([])
    expect(accepted(h)).toEqual([]); expect(h.h.p('alpha').stub.web.callLog).toEqual([])
  })

  test.each(['unapplied', 'stale', 'wrong-identity', 'current'] as const)('deferred candidates use %s authenticated provenance at re-evaluation', async state => {
    let current: import('../src/persona-connections.ts').PersonaEventProvenance | undefined
    const h = await open({ routing: { routingHooks: { currentProvenance: () => current } } }), observation = observeThread(h)
    let acks = 0
    await h.h.routing.receive(threadReply(), () => { acks++ }, 'alpha', false)
    const id = h.h.routing.pendingCandidates()[0]!.id
    await acceptObservation(h, observation); h.threads.recover('alpha', observation.id)
    current = { key: 'alpha', incarnation: h.authority.incarnation('alpha'), connectionId: 'verified-current', candidate: false,
      applied: state !== 'unapplied', isCurrent: () => state !== 'stale',
      identity: state === 'wrong-identity' ? { botUserId: threadReply().user as string, botId: 'B0FOREIGN' } : h.h.p('alpha').stub.identity }
    const calls = h.h.p('alpha').stub.web.callLog.length
    await h.h.routing.reevaluate(id)
    if (state === 'wrong-identity') {
      // A changed authenticated identity matching the author makes this an own message.
      expect(accepted(h)).toHaveLength(1); expect(acks).toBe(1)
      expect(h.h.routing.pendingCandidates()).toEqual([])
      return
    }
    if (state !== 'current') {
      expect(acks).toBe(0)
      expect(accepted(h).map(a => a.via)).toEqual(['mention'])
      expect(h.h.routing.pendingCandidates().map(c => c.id)).toEqual([id])
      expect(h.h.p('alpha').stub.web.callLog).toHaveLength(calls)
      current = { ...current, applied: true, isCurrent: () => true }
      await h.h.routing.reevaluate(id)
    }
    expect(acks).toBe(1)
    expect(accepted(h).map(a => a.via)).toEqual(['mention', 'thread'])
    expect(h.h.routing.pendingCandidates()).toEqual([])
    await h.h.routing.reevaluate(id)
    expect(acks).toBe(1)
    expect(accepted(h)).toHaveLength(2)
  })

  test('a compacted duplicate still withholds acknowledgement when enrollment recovery throws', async () => {
    let unavailable = false
    const h = await open({ recoverFault: () => unavailable ? new Error('recovery unavailable') : undefined })
    await h.receive(h.mention())
    const first = h.h.queued('alpha')[0]!
    await h.h.queue.append('alpha', deliveredRecord(first.accepted.seq, h.clock.now()))
    await h.h.queue.compact()
    expect(h.h.queue.items('alpha')).toEqual([])
    unavailable = true
    expect((await h.receive(h.mention())).acknowledged).toBe(0)
    expect(accepted(h)).toEqual([])
    unavailable = false
    expect((await h.receive(h.mention())).acknowledged).toBe(1)
    expect(accepted(h)).toEqual([])
  })
  test.each(['strict', 'open'] as const)('%s root/reply mentions enroll before any response and policy switches pause/resume following', async mode => {
    const h = await open({ mode })
    for (const [root, reply] of [[ROOT, false], [ROOT2, true]] as const) {
      const mention = h.mention({ ts: reply ? '1700000000.000201' : root, ...(reply ? { thread_ts: root } : {}) })
      expect((await h.receive(mention, ['alpha', 'beta'])).acknowledged).toBe(1)
      expect(h.read(root)).toBe('followed'); expect(h.read(root, 'beta')).toBe('unfollowed')
      const response = threadReply({ thread_ts: root, ts: reply ? '1700000000.000202' : '1700000000.000102' })
      await h.receive(response, ['alpha', 'beta'])
      expect(accepted(h).at(-1)).toMatchObject({ via: 'thread', thread_ts: root, text: response.text })
    }
    expect(accepted(h, 'beta')).toEqual([])
    expect(h.h.all.flatMap(p => p.notifications)).toEqual([])
    for (const value of ['mentions', 'off', 'all', 'thread_hybrid'] as const) {
      await h.choose(value)
      const before = accepted(h).length
      const ts = `1700000001.00000${before}`
      await h.receive(threadReply({ ts }))
      const via = { mentions: undefined, off: undefined, all: 'receive_all', thread_hybrid: 'thread' }[value]
      expect(accepted(h).length).toBe(before + (via ? 1 : 0))
      if (via) expect(accepted(h).at(-1)).toMatchObject({ ts, via })
      expect(h.read()).toBe('followed')
    }
    h.h.setMode(mode === 'strict' ? 'open' : 'strict'); h.h.forget('alpha'); h.restoreOwner()
    expect(h.read()).toBe('followed')
  })

  test('protection precedes the first awaited step; dependent intake returns without lookup or ack, then converges with redelivery', async () => {
    const gate = threadHold()
    const h = await open({ routing: { routingHooks: { _afterObservation: () => gate.wait() } } })
    let mentionAcks = 0, replyAcks = 0
    const mention = h.mention({ ts: '1700000009.000001', thread_ts: ROOT })
    const inFlight = h.h.routing.receive(mention, () => { mentionAcks++ }, 'alpha', false)
    // No await before this read: Slack timestamp order is deliberately reversed.
    expect(h.read()).toBe('unresolved'); expect(h.threads.pending()).toHaveLength(1)
    const reply = threadReply({ files: [{ name: 'original.txt', size: 7, mimetype: 'text/plain' }] })
    const original = structuredClone(reply)
    const intake = h.h.routing.receive(reply, () => { replyAcks++ }, 'alpha', false)
    const candidate = h.h.routing.pendingCandidates()[0]!
    expect(candidate).toMatchObject({ key: 'alpha', channel: C, root: ROOT, lifetime: h.authority.lifetime('alpha', C) })
    await intake
    expect(replyAcks).toBe(0); expect(mentionAcks).toBe(0)
    expect(accepted(h)).toEqual([]); expect(h.h.p('alpha').stub.web.callLog).toEqual([])
    await h.notices.runDeferred()
    expect(h.failures).toEqual([])
    expect(h.notices.h.totalPosts()).toBe(0)
    expect(h.notices.rig.episodes.isOpen('alpha', 'message-not-saved')).toBe(false)
    expect(h.h.logs.some(line => line.includes(MESSAGE_NOT_SAVED) || line.includes(QUEUE_UNWRITABLE))).toBe(false)
    reply.text = 'mutated caller body'
    gate.release(); await inFlight
    expect(mentionAcks).toBe(1); expect(h.read()).toBe('followed')
    await Promise.all([h.h.routing.reevaluate(candidate.id), h.h.routing.reevaluate(candidate.id), h.receive(original)])
    expect(replyAcks).toBe(1)
    expect(accepted(h).map(a => [a.ts, a.via])).toEqual([[mention.ts as string, 'mention'], [original.ts as string, 'thread']])
    expect(accepted(h)[1]).toMatchObject({ text: original.text, files: original.files, thread_ts: ROOT })
    expect(h.h.routing.pendingCandidates()).toEqual([])
    expect(h.threads.pending()).toEqual([])
  })

  test('unknown-root evidence holds only undecidable replies, never known threads, direct mentions or broadcasts', async () => {
    const h = await open(); await h.receive(h.mention())
    const unknown = { ...observeThread(h, { root: ROOT2 }), root: undefined, slackKey: undefined }
    expect(h.threads.observe(unknown)).toBe('current'); await h.threads.persist(unknown)
    expect((await h.receive(threadReply())).acknowledged).toBe(1)
    const pending = threadReply({ thread_ts: ROOT2, ts: '1700000000.000201' })
    expect((await h.receive(pending)).acknowledged).toBe(0)
    expect((await h.receive(threadReply({ thread_ts: '1700000000.000300', ts: '1700000000.000301' }))).acknowledged).toBe(0)
    await h.receive(h.mention({ ts: '1700000000.000202', thread_ts: ROOT2 }))
    await h.receive(threadReply({ ts: '1700000000.000400', text: broadcastText('here') }))
    const candidates = h.h.routing.pendingCandidates()
    expect(candidates).toHaveLength(2)
    await Promise.all(candidates.map(c => h.h.routing.reevaluate(c.id)))
    expect(accepted(h).filter(a => a.ts === pending.ts)).toHaveLength(1)
    expect(h.h.routing.pendingCandidates().map(c => c.root)).toEqual(['1700000000.000300'])
    expect(h.threads.pending()).toContainEqual(unknown)
    await h.clock.advance(QUEUE_KEY_KEEP_MS + REPLY_REMINDER_KEEP_MS + 1)
    await h.h.routing.reevaluate(h.h.routing.pendingCandidates()[0]!.id)
    expect(h.h.routing.pendingCandidates()).toHaveLength(1)
    expect(accepted(h).some(a => a.ts === '1700000000.000301')).toBe(false)
    await h.notices.runDeferred()
    expect(h.failures).toEqual([])
    expect(h.notices.h.totalPosts()).toBe(0)
  })

  test.each(['observation-write', 'accept-write', 'accept-fsync', 'after-acceptance', 'recover'] as const)('%s: mixed recipients retain one item and queued feedback while aggregate acknowledgement waits', async fault => {
    let interrupt = true
    const h = await open({
      recoverFault: key => fault === 'recover' && interrupt && key === 'beta' ? new Error('interrupted recovery') : undefined,
      routing: { routingHooks: { _afterAcceptance: async key => { if (fault === 'after-acceptance' && key === 'beta' && interrupt) throw new Error('interrupted after acceptance') } } },
    })
    if (fault === 'observation-write') h.disk.fail('write', 'thread-participation', 'beta')
    if (fault === 'accept-write' || fault === 'accept-fsync') h.disk.fail(fault === 'accept-write' ? 'write' : 'fsync', 'accepted', 'beta')
    const event = h.mention({ text: `${mentionText(h.h.p('alpha').stub.identity.botUserId)} ${mentionText(h.h.p('beta').stub.identity.botUserId)}` })
    const persistedBeta = fault === 'after-acceptance' || fault === 'recover'
    expect(await h.receive(event, ['alpha', 'beta'])).toEqual({ returned: true, acknowledged: 0 })
    expect(accepted(h)).toHaveLength(1); expect(ackCount(h)).toBe(1)
    expect(accepted(h, 'beta')).toHaveLength(persistedBeta ? 1 : 0)
    expect(ackCount(h, 'beta')).toBe(persistedBeta ? 1 : 0)
    expect(h.failures).toMatchObject([{ key: 'beta', unaccepted: !persistedBeta }])
    expect(h.notices.h.totalPosts()).toBe(0)
    await h.notices.runDeferred()
    expect(h.notices.h.posts('alpha')).toEqual([])
    expect(h.notices.h.posts('beta').map(post => post.text)).toEqual(persistedBeta ? [] : [
      formatPersonaNotice(h.notices.config.personas[1]!, buildMessageNotSavedNotice(h.notices.ref('beta'), event.user as string)),
    ])
    expect(h.read()).toBe('followed'); expect(h.read(ROOT, 'beta')).toBe(persistedBeta ? 'followed' : 'unresolved')
    expect(h.h.queued('alpha')[0]!.fixed).toBeUndefined()
    // An independent successful store cannot settle participation's episode.
    const settled = h.settled.length
    h.disk.repair()
    expect((await h.h.queue.accept('beta', slackInput({ key: { chat_id: C2, ts: ROOT }, channel: C2 }))).status).toBe('accepted')
    expect(h.settled).toHaveLength(settled)
    expect(h.notices.rig.episodes.isOpen('beta', 'message-not-saved')).toBe(true)
    h.disk.repair(); interrupt = false
    expect((await h.receive(event, ['alpha', 'beta'])).acknowledged).toBe(1)
    expect(accepted(h)).toHaveLength(1)
    expect(accepted(h, 'beta').filter(a => a.channel === C)).toHaveLength(1)
    expect(h.read(ROOT, 'beta')).toBe('followed')
    expect(h.h.queued('alpha')[0]!.fixed).toBeDefined()
    expect(ackCount(h)).toBe(1); expect(ackCount(h, 'beta')).toBe(1)
    expect(h.notices.rig.episodes.isOpen('beta', 'message-not-saved')).toBe(false)
  })

  test.each(['strict', 'open'] as const)('%s paired message/app_mention copies and edited keys enroll once per accepted identity', async mode => {
    const h = await open({ mode }), event = h.mention()
    await Promise.all([h.receive(event), h.receive({ ...event, type: 'app_mention' })])
    expect(accepted(h)).toHaveLength(1)
    await h.receive({ ...event, edited: { ts: '1700000001.000001' } })
    expect(accepted(h)).toHaveLength(2)
    expect(new Set(accepted(h).map(a => a.thread_enrollment!.id)).size).toBe(2)
    expect(h.read()).toBe('followed')
  })

  test.each(['copy-finishes-first', 'copy-before-message', 'message-first'] as const)('strict-to-open during a held app_mention copy leaves the paired message deciding (%s)', async order => {
    const copyGate = threadHold(), messageGate = threadHold()
    let observations = 0
    const h = await open({ routing: { routingHooks: {
      _afterObservation: () => ++observations === 1 ? copyGate.wait() : messageGate.wait(),
    } } })
    const event = h.mention()
    let copyAcks = 0, messageAcks = 0
    const copy = h.h.routing.receive({ ...event, type: 'app_mention' }, () => { copyAcks++ }, 'alpha', false)
    await copyGate.entered
    h.chooseMode('open')
    let message: Promise<void> | undefined
    try {
      if (order === 'copy-before-message') { copyGate.release(); await copy }
      message = h.h.routing.receive(event, () => { messageAcks++ }, 'alpha', false)
      await messageGate.entered
      if (order === 'message-first') { messageGate.release(); await message }
      else { copyGate.release(); await copy }
      expect({ copyAcks, messageAcks }).toEqual(order === 'message-first' ? { copyAcks: 0, messageAcks: 1 } : { copyAcks: 1, messageAcks: 0 })
      expect(accepted(h)).toHaveLength(order === 'message-first' ? 1 : 0)
      expect(h.h.queue.threadRecords('alpha').map(r => r.state)).not.toContain('cancelled')
    } finally { copyGate.release(); messageGate.release() }
    await Promise.all([copy, message])
    await h.drainReactions()
    expect({ copyAcks, messageAcks }).toEqual({ copyAcks: 1, messageAcks: 1 })
    expect(accepted(h)).toEqual([expect.objectContaining({ via: 'mention' })])
    expect(h.read()).toBe('followed')
    expect(h.h.queue.threadRecords('alpha').map(r => r.state)).toEqual(['enrolled'])
    expect(h.threads.pending()).toEqual([])
    expect(ackCount(h)).toBe(1)
    expect(h.failures).toEqual([])
    if (order !== 'copy-before-message') return
    const original = accepted(h)[0]!
    await h.h.queue.compact('alpha')
    await h.close()
    resetRoutingState()
    const reopened = await open({ mode: 'open', clock: h.clock })
    expect(reopened.read()).toBe('followed')
    expect((await reopened.receive(event)).acknowledged).toBe(1)
    expect(accepted(reopened)).toEqual([expect.objectContaining({ seq: original.seq, key: original.key, via: 'mention',
      text: original.text, queued_ack_reaction: original.queued_ack_reaction, thread_enrollment: original.thread_enrollment })])
    expect(reopened.read()).toBe('followed')
    expect(reopened.h.queue.threadRecords('alpha').map(r => r.state)).toEqual(['enrolled'])
    expect(reopened.h.p('alpha').stub.calls.reactionsAdd).toEqual([{ channel: C, timestamp: original.ts, name: original.queued_ack_reaction! }])
  })

  test.each(['membership', 'not-up', 'off', 'mentions', 'superseded'] as const)('deferred re-evaluation checks current %s and retains original accepted work', async guard => {
    let member = true
    const positive = observedMembership({ alpha: [C, C2], beta: [C, C2] })
    const h = await open({ routing: { membership: { ...positive, read: (...args) => member ? positive.read(...args) : { kind: 'unresolved', reason: 'current-membership-missing' } } } }), observation = observeThread(h)
    const event = threadReply(); let acks = 0
    await h.h.routing.receive(event, () => { acks++ }, 'alpha', false)
    const id = h.h.routing.pendingCandidates()[0]!.id
    await acceptObservation(h, observation); h.threads.recover('alpha', observation.id)
    const calls = h.h.p('alpha').stub.web.callLog.length
    if (guard === 'not-up') h.h.notUp.add('alpha')
    if (guard === 'off' || guard === 'mentions') await h.choose(guard)
    if (guard === 'membership') {
      // Lifetime remains valid, but the independent membership reader has no positive.
      member = false
      expect(h.threads.lifetimeStatus(observation.lifetime)).toBe('current')
    }
    if (guard === 'superseded') {
      expect(h.authority.transact(h.authority.revision, (next, order) => { next.personas.alpha!.resetOrder = order })).toMatchObject({ kind: 'applied' })
      expect(h.threads.lifetimeStatus(observation.lifetime)).toBe('superseded')
    }
    await h.h.routing.reevaluate(id)
    expect(accepted(h).map(a => a.via)).toEqual(['mention'])
    expect(h.h.p('alpha').stub.web.callLog).toHaveLength(calls)
    if (guard === 'off' || guard === 'mentions') {
      // Current policy settles the reply as unselected: acknowledged, never accepted.
      expect(acks).toBe(1)
      expect(h.h.routing.pendingCandidates()).toEqual([])
    } else if (guard === 'superseded') {
      // A superseded lifetime retires the candidate; Slack's redelivery is decided under the replacement lifetime.
      expect(acks).toBe(0)
      expect(h.h.routing.pendingCandidates()).toEqual([])
      expect(h.settled).toContain(id)
      expect((await h.receive(event)).acknowledged).toBe(1)
      expect(accepted(h).map(a => a.via)).toEqual(['mention'])
    } else {
      // Held, not dropped: unacknowledged, still pending, and accepted once the guard clears.
      expect(acks).toBe(0)
      expect(h.h.routing.pendingCandidates().map(c => c.id)).toEqual([id])
      if (guard === 'membership') member = true
      else h.h.notUp.delete('alpha')
      await h.h.routing.reevaluate(id)
      expect(acks).toBe(1)
      expect(accepted(h).map(a => a.via)).toEqual(['mention', 'thread'])
      expect(accepted(h).at(-1)).toMatchObject({ ts: event.ts, text: event.text, thread_ts: ROOT })
      expect(h.h.routing.pendingCandidates()).toEqual([])
    }
    await h.notices.runDeferred()
    expect(h.failures).toEqual([])
    expect(h.notices.h.totalPosts()).toBe(0)
  })

  test('open-mode loop guard suppresses thread following on direct intake and re-evaluation while mentions still enroll', async () => {
    const h = await open({ mode: 'open' })
    expect((await h.receive(h.mention())).acknowledged).toBe(1)
    expect(h.read()).toBe('followed')
    const pending = observeThread(h, { root: ROOT2 }); await h.threads.persist(pending)
    const held = threadReply({ thread_ts: ROOT2, ts: '1700000000.000201' })
    let heldAcks = 0
    await h.h.routing.receive(held, () => { heldAcks++ }, 'alpha', false)
    const id = h.h.routing.pendingCandidates()[0]!.id
    expect(heldAcks).toBe(0)
    // Beta's prompt destination becomes this channel; alpha's saved value stays thread_hybrid.
    h.chooseDestination('beta', C)
    expect(h.authority.choice('alpha', C)).toBe('thread_hybrid')
    const calls = h.h.p('alpha').stub.web.callLog.length
    expect((await h.receive(threadReply())).acknowledged).toBe(1)
    await acceptObservation(h, pending); h.threads.recover('alpha', pending.id)
    expect(h.read(ROOT2)).toBe('followed')
    await h.h.routing.reevaluate(id)
    expect(heldAcks).toBe(1)
    expect(h.h.routing.pendingCandidates()).toEqual([])
    expect(accepted(h).map(a => a.via)).toEqual(['mention', 'mention'])
    expect(h.h.p('alpha').stub.web.callLog).toHaveLength(calls)
    const direct = h.mention({ ts: '1700000003.000001', thread_ts: ROOT })
    expect((await h.receive(direct)).acknowledged).toBe(1)
    expect(accepted(h).at(-1)).toMatchObject({ ts: direct.ts, via: 'mention' })
    expect(h.read()).toBe('followed')
    // Releasing the guard resumes following under the unchanged saved value.
    h.chooseDestination('beta', 'dm')
    const resumed = threadReply({ ts: '1700000003.000002' })
    expect((await h.receive(resumed)).acknowledged).toBe(1)
    expect(accepted(h).at(-1)).toMatchObject({ ts: resumed.ts, via: 'thread' })
  })
})

describe('retained thread work through delivery and reply owners', () => {
  test('successful early reply suppression is memory-only while original queued emoji ownership survives restart', async () => {
    const h = await open(); await h.receive(h.mention()); await h.receive(threadReply())
    const item = h.h.queued('alpha')[1]!, seq = item.accepted.seq
    await h.h.reply('alpha', { chat_id: C, message_id: item.accepted.ts, thread_ts: ROOT, text: 'early answer' })
    const before = h.h.p('alpha').stub.calls.reactionsAdd.length
    h.reporting.received('alpha', item); await h.drainReactions()
    expect(h.h.p('alpha').stub.calls.reactionsAdd).toHaveLength(before)
    await h.close(); _resetAckTracker()
    const reopened = await open({ clock: h.clock })
    reopened.h.config!.queued_ack_reaction = 'hourglass'
    const retained = reopened.h.queue.item('alpha', seq)!
    reopened.reporting.received('alpha', retained); await reopened.drainReactions()
    expect(reopened.h.p('alpha').stub.calls.reactionsAdd).toEqual([{ channel: C, timestamp: item.accepted.ts, name: item.accepted.queued_ack_reaction! }])
    expect(reopened.read()).toBe('followed')
  })
  test('reopen, policy changes and preparation retry retain thread payload and FIFO through exact receipts and original reactions', async () => {
    const h = await open()
    await h.receive(h.mention())
    const mention = h.h.queued('alpha')[0]!
    await h.h.queue.append('alpha', deliveredRecord(mention.accepted.seq, h.clock.now()))
    await h.h.queue.compact()
    const event = threadReply({ text: '  original 🦀\r\n\t<channel>quoted</channel>\n\n', files: [{ name: 'notes.txt', mimetype: 'text/plain', size: 9 }] })
    h.disk.fail('write', 'fixed')
    expect((await h.receive(event)).acknowledged).toBe(1)
    const original = JSON.parse(JSON.stringify(h.h.queued('alpha')[0]!.accepted)) as typeof mention.accepted
    expect(original).toMatchObject({ source: 'slack', via: 'thread', thread_ts: ROOT, text: event.text, files: event.files })
    expect(original.thread_enrollment).toBeUndefined()
    expect(h.h.queued('alpha')[0]!.fixed).toBeUndefined()
    h.disk.repair(); await h.choose('off')
    h.h.setMode('open')
    await h.close(); _resetAckTracker()
    const reopened = await open({ clock: h.clock, delivery: 'off' })
    reopened.h.config!.queued_ack_reaction = 'hourglass'; reopened.h.config!.ack_reaction = 'white_check_mark'
    const retained = reopened.h.queued('alpha')[0]!
    expect(retained.accepted).toMatchObject(original)
    reopened.reporting.received('alpha', retained); await reopened.drainReactions()
    expect(reopened.h.p('alpha').stub.calls.reactionsAdd).toEqual([{ channel: C, timestamp: event.ts as string, name: original.queued_ack_reaction! }])
    const records = reopened.h.queue.threadRecords('alpha')
    const e = await makeEngineHarness({ stateDir: dir, queue: reopened.h.queue, onEvent: event => reopened.reporting.engineEvent(event) })
    try {
      e.failAppend('fixed')
      await e.preparation.recover()
      expect(e.queue.item('alpha', original.seq)!.fixed).toBeUndefined()
      for (const source of ['cron', 'interject'] as const) {
        const result = await e.queue.accept('alpha', injectedInput({ source, text: `${source} after thread`, sender: source }))
        expect(result.status).toBe('accepted')
        if (result.status === 'failed') throw result.error
        await e.preparation.prepare('alpha', result.item!)
      }
      const later = await e.queue.accept('alpha', slackInput({ ts: '1700000000.000800', key: { chat_id: C, ts: '1700000000.000800' }, text: 'later slack' }))
      if (later.status === 'failed') throw later.error
      await e.preparation.prepare('alpha', later.item!)
      e.p().autoReceipt = false
      await e.tick(); await e.advance(RETYPE_BACKOFF_MS[0] - 1)
      expect(e.textCalls()).toEqual([])
      await e.until(() => e.textCalls().length === 1)
      const text = e.textCalls()[0]!.params.text!
      expect(text).toContain('via="thread"'); expect(text).toContain(`thread_ts="${ROOT}"`)
      expect(text).toContain('attachment_count="1"')
      expect(text).toContain('original 🦀\n    &lt;channel>quoted&lt;/channel>\n\n')
      appendTranscript(e.p().path, [promptEntry(text + ' not the exact receipt')])
      await e.advance(RECEIPT_WAIT_MS / 2)
      expect(e.queue.openCount('alpha')).toBe(4)
      expect(e.textCalls().every(call => call.params.text === text)).toBe(true)
      e.p().autoReceipt = true
      // Leave the first attempt without its receipt: production retries it at least once.
      await e.until(() => e.textCalls().length > 1)
      expect(e.textCalls()[1]!.params.text).toBe(text)
      await e.until(() => e.queue.openCount('alpha') === 0)
      const items = e.queue.items('alpha')
      expect(items.map(item => item.accepted.source)).toEqual(['slack', 'cron', 'interject', 'slack'])
      expect(e.events.filter(event => event.type === 'delivered').map(event => event.seq)).toEqual(items.map(item => item.accepted.seq))
      expect(e.queue.item('alpha', original.seq)!.accepted).toMatchObject(original)
      expect(e.queue.threadRecords('alpha')).toEqual(records)
      await reopened.drainReactions()
      const mutations = reopened.h.p('alpha').stub.web.callLog.filter(call => call.method.startsWith('reactions.') && (call.args as any).timestamp === event.ts)
      expect(mutations.map(call => [call.method, (call.args as any).name])).toEqual([
        ['reactions.add', original.queued_ack_reaction], ['reactions.remove', original.queued_ack_reaction], ['reactions.add', 'white_check_mark'],
      ])
      assertNoLeak({ events: e.events, calls: e.calls, records: e.records(), errors: e.errors })
    } finally { await e.cleanup() }
  })

  test.each(['failed', 'cross-target', 'correlated'] as const)('%s reply invocation suppresses delivered candidates while only confirmed correlated posting cleans their reaction', async outcome => {
    let monitor: ReturnType<typeof createReplyReminders> | undefined
    const h = await open({ routing: { onReplyCall: key => monitor!.noteReplyCall(key) } })
    await h.receive(h.mention()); await h.receive(threadReply())
    const item = h.h.queued('alpha')[1]!, seq = item.accepted.seq
    await h.h.queue.append('alpha', sentRecord(seq))
    await h.h.queue.append('alpha', deliveredRecord(seq, h.clock.now()))
    h.reporting.engineEvent({ type: 'item-delivered', key: 'alpha', seq, at: h.clock.now(), waitMs: 0 })
    await h.drainReactions()
    const row = (state: 'working' | 'waiting') => cannedGetResult({ state, session_id: 'session', labels: Object.fromEntries([REPLY_TOOL_PREALLOWED_LABEL.split('=')]) }, h.h.p('alpha').persona, dir)
    const errors: unknown[] = []
    monitor = createReplyReminders({ queue: h.h.queue, clock: h.clock, ready: () => true, enabled: () => true,
      getRow: async () => row('waiting'), prepare: async () => {}, onError: (_key, error) => { errors.push(error) } })
    try {
      await monitor.observe('alpha', row('waiting'))
      expect(h.h.queue.items('alpha').filter(i => i.accepted.reminder_for !== undefined)).toEqual([])
      await monitor.observe('alpha', row('working'))
      const removals = h.h.p('alpha').stub.calls.reactionsRemove.length
      if (outcome === 'failed') h.h.p('alpha').stub.script.post.push({ kind: 'platform', error: 'channel_not_found' })
      const call = h.h.reply('alpha', { chat_id: outcome === 'cross-target' ? C2 : C, thread_ts: ROOT, message_id: item.accepted.ts, text: 'answer' })
      if (outcome === 'failed') await expect(call).rejects.toThrow('reported an error')
      else await call
      expect(h.h.p('alpha').stub.calls.reactionsRemove.length).toBe(removals + (outcome === 'correlated' ? 1 : 0))
      await h.h.queue.compact()
      await monitor.observe('alpha', row('waiting'))
      expect(h.h.queue.items('alpha').filter(i => i.accepted.reminder_for !== undefined)).toEqual([])
      // A later accepted/delivered reply remains eligible; the earlier call cannot cover it.
      await h.receive(threadReply({ ts: '1700000000.000102' }))
      const later = h.h.queued('alpha').at(-1)!
      await h.h.queue.append('alpha', sentRecord(later.accepted.seq))
      await h.h.queue.append('alpha', deliveredRecord(later.accepted.seq, h.clock.now()))
      await monitor.observe('alpha', row('working'))
      await Promise.all([monitor.observe('alpha', row('waiting')), monitor.observe('alpha', row('waiting'))])
      const nudges = h.h.queue.items('alpha').filter(i => i.accepted.reminder_for !== undefined)
      expect(nudges.map(i => [i.accepted.source, i.accepted.text, i.accepted.reminder_for])).toEqual([['interject', REPLY_REMINDER_TEXT, later.accepted.seq]])
      await h.h.queue.compact(); h.restoreOwner()
      expect(h.read()).toBe('followed')
      expect(h.h.queue.items('alpha').filter(i => i.accepted.reminder_for !== undefined)).toHaveLength(1)
      expect(errors).toEqual([])
    } finally { await monitor.stop() }
  })
})
