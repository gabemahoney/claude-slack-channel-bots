import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createThreadParticipation, decideOwnPostEligibility, ownPostEligibility, ELIGIBILITY_MISSING } from '../src/thread-participation.ts'
import { createDeliveryPreparation } from '../src/delivery-intake.ts'
import { createSharedChannelAuthority } from '../src/shared-channels.ts'
import { createReplyReminders, REPLY_REMINDER_TEXT, REPLY_TOOL_PREALLOWED_LABEL } from '../src/reply-reminder.ts'
import { _resetAckTracker } from '../src/ack-tracker.ts'
import { RETYPE_BACKOFF_MS, RECEIPT_WAIT_MS, ENROLLMENT_METADATA_DEADLINE_MS, ENROLLMENT_RETRY_MIN_MS, ENROLLMENT_RETRY_MAX_MS, ENROLLMENT_TIMER_MAX_MS,
  OWN_ROOT_CLOCK_SKEW_MS, enrollmentRepairBoundMs } from '../src/delivery-constants.ts'
import { buildMessageNotSavedNotice, MESSAGE_NOT_SAVED, QUEUE_UNWRITABLE, OWN_POST_NOT_ENROLLED, OWN_POST_FINDINGS_LOGGED_PER_PERSONA,
  buildOwnPostNotEnrolledLine, buildOwnPostNotEnrolledNotice, buildOwnPostFindingsCappedLine, buildOwnPostOutcomesDroppedLine } from '../src/delivery-notices.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED, PERSONA_EPISODE_KIND_ROOT_LOOKUP_CAPABILITY } from '../src/persona-episodes.ts'
import { replyPartialFailureText } from '../src/registry.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { makeEngineHarness } from './test-helpers/delivery-engine.ts'
import { cannedGetResult } from './test-helpers/agent-director-stub.ts'
import { appendTranscript, promptEntry } from './test-helpers/working-row-panes.ts'
import { injectedInput } from './test-helpers/delivery-queue.ts'
import { QUEUE_KEY_KEEP_MS, REPLY_REMINDER_KEEP_MS, QUEUE_COMPACT_INTERVAL_MS } from '../src/delivery-queue.ts'
import { resetRoutingState, observedMembership } from './test-helpers/persona-routing-harness.ts'
import { makeQueue, readQueue, queuePath, seedQueue, slackInput, deliveredRecord, sentRecord } from './test-helpers/delivery-queue.ts'
import { readSharedState, sharedChannelPath } from './test-helpers/shared-channels.ts'
import { assertNoLeak, writtenFile, LEAK_SENTINEL } from './test-helpers/credentials.ts'
import { asWebClient, broadcastText, mentionText, makeDm, makeGroupDmMessage, makeDeferredWebApiCall } from './test-helpers/slack-stub.ts'
import { SHARED_CHANNEL_IDS } from './test-helpers/shared-channels.ts'
import { makeThreadHarness, threadHold, threadDisk, threadReply, observeThread, acceptObservation, tearJournal,
  THREAD_CHANNEL as C, THREAD_OTHER_CHANNEL as C2, THREAD_ROOT as ROOT, THREAD_OTHER_ROOT as ROOT2,
  attachRecovery, hungMetadata, slackPlatformError, slackRateLimited, slackHttpError, rootReplies, fileInfo, channelInfo,
  type ThreadHarness, type MetadataResponder, type AttachedRecovery } from './test-helpers/thread-participation.ts'
import { parseRootReplies, resolveRootAuthor, rootLookupVerdict } from '../src/participation-root-evidence.ts'
import { completionFiles, fileShareRoot, resolveFileRoot } from '../src/participation-file-evidence.ts'
import { parseConversationInfo, resolveChannelEvidence, requiredHistoryScopes, missingHistoryScopes, capabilityGapHoldsLookups, PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE, DM_HISTORY_SCOPE,
  type RootLookupCapabilityGap } from '../src/participation-channel-evidence.ts'
import { createMetadataAttempts, classifyMetadataFailure, metadataRetryDelay, waitFor, MetadataCancelledError, type MetadataAttempts, type EnrollmentMetadataMethod } from '../src/participation-metadata.ts'
import { createRootLookupCapability } from '../src/participation-capability.ts'
import { buildParticipationRecoveryLine, buildParticipationRecoveredLine, buildParticipationRecoveryCappedLine, PARTICIPATION_RECOVERY_LOGGED_PER_PERSONA,
  buildRootLookupCapabilityLine, buildRootLookupCapabilityNotice, ownPostFindingCause } from '../src/delivery-notices.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import type { MembershipFault } from '../src/channel-membership.ts'
import type { ParticipationRecoveryFinding } from '../src/participation-recovery.ts'

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

  test.each(['rewrite', 'read'] as const)('a torn journal whose startup %s failed is retried by idle recovery, which reports recovery only once thread state is readable', async fault => {
    const { clock } = await journalWithTail('slack')
    tearJournal(dir)
    const disk = threadDisk(); disk.fail(fault)
    const h = await open({ disk, clock }), r = attachRecovery(h)
    expect([h.h.queue.threadReadable('alpha'), h.h.queue.threadRepairable!('alpha')]).toEqual([false, true])
    r.recovery.kick('alpha'); await r.settle()
    expect(r.findings).toEqual([{ key: 'alpha', finding: { cause: 'storage' } }])
    expect(h.h.logs.filter(l => l.startsWith('[slack] participation-recovery: '))).toEqual([buildParticipationRecoveryLine(renderPersonaRef('alpha', 'alpha'), { cause: 'storage' })])
    expect(r.recovered).toEqual([])
    reading(h, ROOT3, 'unresolved', 'storage')
    disk.repair()
    await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle()
    expect([h.h.queue.threadReadable('alpha'), h.h.queue.threadRepairable!('alpha'), r.recovered]).toEqual([true, false, ['alpha']])
    expect(h.h.logs.filter(l => l === buildParticipationRecoveredLine(renderPersonaRef('alpha', 'alpha')))).toHaveLength(1)
    reading(h, ROOT, 'followed'); reading(h, ROOT3, 'unfollowed')
  })

  const rawRows = () => fs.readFileSync(queuePath(dir), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)

  test('a journal with no file, read but never loaded, is healthy: idle recovery writes nothing, and later acceptances hold exactly their rows', async () => {
    const h = await open(), r = attachRecovery(h)
    expect(fs.existsSync(queuePath(dir))).toBe(false)
    expect([h.h.queue.items('alpha'), h.h.queue.openCount('alpha'), h.h.queue.threadRepairable!('alpha')]).toEqual([[], 0, false])
    r.recovery.kick('alpha'); await r.settle()
    expect([fs.existsSync(queuePath(dir)), r.findings]).toEqual([false, []])
    for (let i = 0; i < 3; i++) expect((await h.h.queue.accept('alpha', injectedInput())).status).toBe('accepted')
    const bytes = fs.readFileSync(queuePath(dir))
    r.recovery.kick('alpha'); await r.settle()
    expect(fs.readFileSync(queuePath(dir))).toEqual(bytes)
    expect([rawRows().filter(row => row.kind === 'accepted').length, rawRows().filter(row => 'compact' in row), r.findings]).toEqual([3, [], []])
  })

  test('an id-less own-post gap on a persona with no journal file is recovered by one idle pass, which reads the journal without writing it', async () => {
    const h = await open(), r = attachRecovery(h)
    expect(fs.existsSync(queuePath(dir))).toBe(false)
    h.h.ownPostIdentity.set('alpha', undefined)
    const idless = await h.confirmPost({ channel: C, ts: '1700000000.000500' }).outcome
    h.h.ownPostIdentity.delete('alpha')
    expect(idless).toMatchObject({ kind: 'gap', reason: 'identity-unresolved' })
    expect((idless as { id?: unknown }).id).toBeUndefined()
    await h.notices.flush()
    expect([h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED), h.h.queue.threadReadable('alpha')]).toEqual([true, false])
    const line = buildParticipationRecoveredLine(renderPersonaRef('alpha', 'alpha'))
    r.recovery.kick('alpha'); await r.settle()
    expect(h.h.logs.filter(l => l === line)).toHaveLength(1)
    expect([fs.existsSync(queuePath(dir)), r.findings, h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)]).toEqual([false, [], false])
    r.recovery.kick('alpha'); await r.settle()
    expect(h.h.logs.filter(l => l === line)).toHaveLength(1)
  })

  test('a healthy journal loaded at startup is left byte for byte by idle recovery', async () => {
    const { clock } = await journalWithTail('interject')
    const h = await open({ clock }), r = attachRecovery(h)
    const bytes = fs.readFileSync(queuePath(dir))
    expect([h.h.queue.threadReadable('alpha'), h.h.queue.threadRepairable!('alpha')]).toEqual([true, false])
    r.recovery.kick('alpha'); await r.settle()
    expect([fs.readFileSync(queuePath(dir)).equals(bytes), r.findings]).toEqual([true, []])
    reading(h, ROOT, 'followed')
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

  test('up lost during the observation holds nothing: the mention is accepted, acknowledged and enrolled', async () => {
    const h = await open({ routing: { routingHooks: { _afterObservation: async observation => {
      if (observation.lifetime.key === 'alpha') h.h.notUp.add('alpha')
    } } } })
    expect((await h.receive(h.mention())).acknowledged).toBe(1)
    expect(h.h.notUp.has('alpha')).toBe(true)
    expect(h.read()).toBe('followed')
    expect(h.threads.pending('alpha')).toEqual([])
    expect(h.h.queue.threadRecords('alpha').map(r => r.state)).toEqual(['enrolled'])
    expect(accepted(h).map(a => a.via)).toEqual(['mention'])
    expect(h.failures).toEqual([])
  })

  test.each(['none', 'write', 'fsync', 'ambiguous'] as const)('off retry after membership loss durably discards pending enrollment (%s cancellation fault)', async fault => {
    const h = await open({ routing: { routingHooks: { _afterObservation: async observation => {
      if (observation.lifetime.key === 'alpha') h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: 'history-unresolved' })
    } } } })
    const mention = h.mention()
    expect((await h.receive(mention)).acknowledged).toBe(0)
    const observation = h.threads.pending('alpha')[0]!
    expect(h.h.queue.threadRecord('alpha', observation.id)?.state).toBe('observed')
    expect(accepted(h)).toEqual([])
    expect(h.failures).toEqual([])
    h.membership.delete(`alpha:${C}`)
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
    expect(accepted(h).map(a => a.via)).toEqual(guard === 'not-up' ? ['mention', 'thread'] : ['mention'])
    if (guard === 'not-up') {
      // The positive control: not up is no guard, so the reply is accepted, acknowledged and given its queued reaction at once.
      expect(acks).toBe(1)
      expect(h.h.p('alpha').stub.calls.reactionsAdd.at(-1)).toMatchObject({ channel: C, timestamp: event.ts, name: accepted(h).at(-1)!.queued_ack_reaction })
      expect(accepted(h).at(-1)).toMatchObject({ ts: event.ts, text: event.text, thread_ts: ROOT })
      expect(h.h.routing.pendingCandidates()).toEqual([])
    } else {
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
        member = true
        await h.h.routing.reevaluate(id)
        expect(acks).toBe(1)
        expect(accepted(h).map(a => a.via)).toEqual(['mention', 'thread'])
        expect(accepted(h).at(-1)).toMatchObject({ ts: event.ts, text: event.text, thread_ts: ROOT })
        expect(h.h.routing.pendingCandidates()).toEqual([])
      }
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

const ownRecords = (h: ThreadHarness, key = 'alpha') => h.h.queue.threadRecords(key).filter(r => r.observation.post)
/** Fresh outcomes only: a settled duplicate changes nothing and is never a second enrollment or finding. */
const outcomes = (h: ThreadHarness, kind?: string) => h.h.ownPostOutcomes.filter(o => !o.duplicate && (kind === undefined || o.kind === kind))
/** The settled duplicates the owner reported, so reporting can end an episode on them. */
const duplicates = (h: ThreadHarness) => h.h.ownPostOutcomes.filter(o => o.duplicate)
const postCount = (h: ThreadHarness, key = 'alpha') => h.h.p(key).stub.calls.postMessage.length
const textOf = (post: unknown) => (post as { text?: string }).text
/** Lets detached re-evaluation (the owner's onSettled) run; no wall-clock wait. */
async function settleUntil(h: ThreadHarness, done: () => boolean) {
  for (let i = 0; i < 50 && !done(); i++) { await h.clock.flush(); await new Promise(resolve => setImmediate(resolve)) }
  expect(done()).toBe(true)
}

describe('confirmed own posts through the participation owner', () => {
  test('a text root enrolls its returned timestamp and reply parts their requested parent once, with no echo, durably', async () => {
    const h = await open()
    const root = h.confirmPost({ channel: C, ts: ROOT })
    // Published before the first await: a dependent reply cannot read the thread as unfollowed.
    expect(h.read()).toBe('unresolved')
    expect(await root.outcome).toMatchObject({ kind: 'enrolled', key: 'alpha', surface: 'text', channel: C, ts: ROOT, root: ROOT, missing: [] })
    expect(h.read()).toBe('followed')
    const issue = h.threads.issueOwnPost('alpha', 'text')
    const parts = await Promise.all([1, 2, 3].map(part =>
      h.threads.confirmOwnPost(issue, { channel: C2, ts: `1700000000.00030${part}`, parent: ROOT2, part })))
    expect(parts.map(p => [p.kind, p.root, p.part])).toEqual([['enrolled', ROOT2, 1], ['enrolled', ROOT2, 2], ['enrolled', ROOT2, 3]])
    // One durable enrollment per thread; later parts and duplicate confirmations confer nothing twice and are not reported again.
    expect(ownRecords(h).map(r => [r.observation.lifetime.channel, r.observation.root, r.state])).toEqual([[C, ROOT, 'enrolled'], [C2, ROOT2, 'enrolled']])
    expect(await h.threads.confirmOwnPost(issue, { channel: C2, ts: '1700000000.000301', parent: ROOT2, part: 1 })).toMatchObject({ kind: 'enrolled' })
    expect(ownRecords(h)).toHaveLength(2)
    expect(outcomes(h, 'enrolled').map(o => [o.channel, o.root])).toEqual([[C, ROOT], [C2, ROOT2]])
    expect(duplicates(h).map(o => [o.kind, o.root, o.part])).toEqual([['enrolled', ROOT2, 2], ['enrolled', ROOT2, 3], ['enrolled', ROOT2, 1]])
    expect(h.read(ROOT2, 'alpha', C2)).toBe('followed')
    expect([h.read(ROOT2), h.read(ROOT, 'beta'), h.read(ROOT2, 'beta', C2)]).toEqual(['unfollowed', 'unfollowed', 'unfollowed'])
    // Own echoes neither deliver to the posting persona nor add participation; a human reply follows the enrolled thread.
    const identity = h.h.p('alpha').stub.identity
    await h.receive(threadReply({ channel: C2, thread_ts: ROOT2, ts: '1700000000.000301', user: identity.botUserId, bot_id: identity.botId, text: 'own echo' }))
    expect(accepted(h)).toEqual([])
    expect(ownRecords(h)).toHaveLength(2)
    expect((await h.receive(threadReply({ channel: C2, thread_ts: ROOT2, ts: '1700000000.000310' }))).acknowledged).toBe(1)
    expect(accepted(h).map(a => [a.ts, a.via])).toEqual([['1700000000.000310', 'thread']])
    await h.close()
    const reopened = await open({ clock: h.clock })
    expect([reopened.read(), reopened.read(ROOT2, 'alpha', C2)]).toEqual(['followed', 'followed'])
    expect(reopened.threads.ownPostFindings()).toEqual([])
  })

  test('a dependent reply arriving before the first awaited save stays held and unacknowledged, then is accepted once; independent work continues', async () => {
    const gate = threadHold()
    const h = await open({ beforeObservationSave: async (_key, observation) => { if (observation.post) await gate.wait() } })
    await h.receive(h.mention({ ts: ROOT2, thread_ts: undefined }), ['alpha', 'beta'])
    const { outcome } = h.confirmPost({ channel: C, ts: ROOT })
    await gate.entered
    let acks = 0
    const reply = threadReply()
    await h.h.routing.receive(reply, () => { acks++ }, ['alpha'], false)
    expect(acks).toBe(0)
    expect(accepted(h).map(a => a.ts)).toEqual([ROOT2])
    expect(h.h.routing.pendingCandidates().map(c => [c.key, c.channel, c.root])).toEqual([['alpha', C, ROOT]])
    // A known followed thread, another persona and an independent mention all progress during the hold.
    expect((await h.receive(threadReply({ thread_ts: ROOT2, ts: '1700000000.000201' }))).acknowledged).toBe(1)
    expect((await h.receive(threadReply(), ['beta'])).acknowledged).toBe(1)
    expect((await h.receive(h.mention({ ts: '1700000000.000400' }))).acknowledged).toBe(1)
    expect(acks).toBe(0)
    gate.release()
    expect((await outcome).kind).toBe('enrolled')
    await settleUntil(h, () => acks === 1)
    expect(accepted(h).filter(a => a.ts === reply.ts).map(a => a.via)).toEqual(['thread'])
    expect(h.h.routing.pendingCandidates()).toEqual([])
    // Socket redelivery of the same event is a duplicate, not a second item.
    expect((await h.receive(reply)).acknowledged).toBe(1)
    expect(accepted(h).filter(a => a.ts === reply.ts)).toHaveLength(1)
  })

  test('unresolved eligibility keeps durable pending evidence that protects only its thread, restores before intake and enrolls on retry without posting', async () => {
    const h = await open()
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: 'history-unresolved' })
    const pending = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    expect(pending).toMatchObject({ kind: 'pending', missing: ['channel-eligibility'], reason: 'history-unresolved', root: ROOT })
    expect(ownRecords(h).map(r => r.state)).toEqual(['observed'])
    expect([h.read(), h.read(ROOT2), h.read(ROOT, 'beta'), h.read(ROOT, 'alpha', C2)]).toEqual(['unresolved', 'unfollowed', 'unfollowed', 'unfollowed'])
    expect(h.threads.ownPostFindings('alpha')).toEqual([expect.objectContaining({ kind: 'pending', id: pending.id })])
    expect(h.threads.ownPostFindings('beta')).toEqual([])
    // Retrying while membership is still unresolved changes nothing and writes nothing.
    expect(await h.threads.retryOwnPost('alpha', pending.id!)).toMatchObject({ kind: 'pending' })
    expect(ownRecords(h)).toHaveLength(1)
    await h.close()
    const reopened = await open({ clock: h.clock })
    // Restored before any intake: the dependent reply is held, not discarded or acknowledged.
    expect(reopened.read()).toBe('unresolved')
    expect(reopened.threads.ownPostFindings()).toEqual([expect.objectContaining({ kind: 'pending', id: pending.id, missing: ['channel-eligibility'] })])
    let acks = 0
    await reopened.h.routing.receive(threadReply(), () => { acks++ }, ['alpha'], false)
    expect([acks, accepted(reopened)]).toEqual([0, []])
    expect(await reopened.threads.retryOwnPost('alpha', pending.id!)).toMatchObject({ kind: 'enrolled', root: ROOT, missing: [] })
    await settleUntil(reopened, () => acks === 1)
    expect(accepted(reopened).map(a => a.via)).toEqual(['thread'])
    expect(reopened.threads.ownPostFindings()).toEqual([])
    expect(postCount(reopened)).toBe(0)
    expect(await reopened.threads.retryOwnPost('alpha', pending.id!)).toBeUndefined()
    // The observed record's upgrade to enrolled is what replays.
    await reopened.close()
    const replayed = await open({ clock: h.clock })
    expect(replayed.h.queue.threadRecord('alpha', pending.id!)?.state).toBe('enrolled')
    expect([replayed.read(), replayed.threads.ownPostFindings()]).toEqual(['followed', []])
  })

  test.each([
    ['dm', 'D0ALPHADM1', { kind: 'ineligible', reason: 'dm' }, undefined],
    ['malformed', 'not-a-channel', { kind: 'ineligible', reason: 'invalid-channel' }, undefined],
    ['open absent', C, { kind: 'ineligible', reason: 'absent' }, 'unfollowed'],
    ['open external', C, { kind: 'ineligible', reason: 'external-sharing' }, 'unfollowed'],
    ['open unresolved', C, { kind: 'pending', reason: 'event-order-conflict', missing: ['channel-eligibility'] }, 'unresolved'],
    ['strict unlisted', SHARED_CHANNEL_IDS.private, { kind: 'ineligible', reason: 'unlisted' }, 'unfollowed'],
  ] as const)('%s destination: own post neither invents eligibility nor enrolls', async (name, channel, expected, reading) => {
    const h = await open({ mode: name.startsWith('open') ? 'open' : 'strict' })
    const membership = name === 'open absent' ? { kind: 'ineligible', reason: 'absent' } as const
      : name === 'open external' ? { kind: 'ineligible', reason: 'external-sharing' } as const
        : name === 'open unresolved' ? { kind: 'unresolved', reason: 'event-order-conflict' } as const : undefined
    if (membership) h.membership.set(`alpha:${C}`, membership)
    const outcome = await h.confirmPost({ channel, ts: ROOT }).outcome
    expect(outcome).toMatchObject({ ...expected, channel })
    expect(outcomes(h)).toEqual([outcome])
    // Only unresolved eligibility keeps durable evidence, and never as an enrollment.
    expect(ownRecords(h).map(r => [r.observation.lifetime.channel, r.observation.root, r.state])).toEqual(expected.kind === 'pending' ? [[C, ROOT, 'observed']] : [])
    if (reading) expect(h.read(ROOT, 'alpha', channel)).toBe(reading)
  })

  test.each([
    ['unreadable choices, even over a negative membership reading', { listed: true, choiceReadable: false, choice: undefined, membership: { kind: 'ineligible', reason: 'absent' } },
      { kind: 'unresolved', mode: 'strict', reason: 'state-unavailable' }],
    ['a listed strict channel with a stored choice but no membership reading', { listed: true, choiceReadable: true, choice: 'thread_hybrid', membership: undefined },
      { kind: 'unresolved', mode: 'strict', delivery: 'thread_hybrid', reason: 'current-membership-missing' }],
  ] as const)('%s leaves own-post eligibility unresolved, never eligible or ineligible', (_name, inputs, expected) => {
    expect(decideOwnPostEligibility({ channel: C, mode: 'strict', ...inputs })).toEqual(expected)
  })

  test('open mode reads no persona channel entries for own-post eligibility; strict mode reads the posting persona\'s', () => {
    const personaReads: string[] = [], membershipModes: string[] = []
    const eligibility = (mode: 'strict' | 'open', stored?: 'mentions') => ownPostEligibility({
      config: () => ({ channel_mode: mode }),
      persona: key => { personaReads.push(key); return { channels: [] } },
      choices: () => ({ readableFor: () => true, storedChoice: () => stored }),
      membership: (_key, _channel, m) => { membershipModes.push(m); return { kind: 'ineligible', reason: 'external-sharing' } },
    })
    expect(eligibility('open')('alpha', C)).toMatchObject({ kind: 'unresolved', mode: 'open', reason: 'choice-missing' })
    expect(eligibility('open', 'mentions')('alpha', C)).toMatchObject({ kind: 'ineligible', mode: 'open', reason: 'external-sharing' })
    expect(personaReads).toEqual([])
    expect(eligibility('strict')('alpha', C)).toMatchObject({ kind: 'ineligible', mode: 'strict', reason: 'unlisted' })
    expect(personaReads).toEqual(['alpha'])
    expect(membershipModes).toEqual(['open', 'open', 'strict'])
  })

  test('an eligible listed off channel enrolls without changing intake; the post alone selects nothing', async () => {
    const h = await open()
    await h.choose('off')
    expect(await h.confirmPost({ channel: C, ts: ROOT }).outcome).toMatchObject({ kind: 'enrolled', root: ROOT })
    expect(h.read()).toBe('followed')
    await h.receive(threadReply())
    expect(accepted(h)).toEqual([])
    await h.choose('thread_hybrid')
    expect((await h.receive(threadReply({ ts: '1700000000.000102' }))).acknowledged).toBe(1)
    expect(accepted(h).map(a => a.via)).toEqual(['thread'])
  })

  test('identity captured before the post binds it: an unknown or replaced issuer never enrolls a replacement', async () => {
    const h = await open()
    h.h.ownPostIdentity.set('alpha', undefined)
    const unknown = h.confirmPost({ channel: C, ts: ROOT })
    h.h.ownPostIdentity.delete('alpha')
    expect(await unknown.outcome).toMatchObject({ kind: 'gap', reason: 'identity-unresolved', missing: [] })
    const issue = h.threads.issueOwnPost('alpha', 'text')
    h.h.ownPostIdentity.set('alpha', { botUserId: 'U0REPLACED', botId: 'B0REPLACED' })
    expect(await h.threads.confirmOwnPost(issue, { channel: C, ts: ROOT })).toMatchObject({ kind: 'superseded' })
    expect(ownRecords(h)).toEqual([])
    expect(h.read()).toBe('unfollowed')
    // The current identity still enrolls its own later post.
    expect(await h.confirmPost({ channel: C, ts: ROOT }).outcome).toMatchObject({ kind: 'enrolled' })
    expect(h.threads.ownPostFindings()).toEqual([])
  })

  test('a storage gap keeps in-memory protection for its thread only and is distinguishable from durable pending evidence', async () => {
    const h = await open()
    h.disk.fail('write', 'thread-participation')
    const gap = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    expect(gap).toMatchObject({ kind: 'gap', reason: 'storage', root: ROOT })
    expect(h.h.queue.threadRecord('alpha', gap.id!)).toBeUndefined()
    expect(h.threads.ownPostFindings('alpha')).toEqual([expect.objectContaining({ kind: 'gap', reason: 'storage', id: gap.id })])
    expect([h.read(), h.read(ROOT2), h.read(ROOT, 'beta')]).toEqual(['unresolved', 'unfollowed', 'unfollowed'])
    // Elapsed time is no evidence.
    await h.clock.advance(24 * 60 * 60 * 1000)
    expect(h.read()).toBe('unresolved')
    h.disk.repair()
    expect(await h.threads.retryOwnPost('alpha', gap.id!)).toMatchObject({ kind: 'enrolled' })
    expect(h.read()).toBe('followed')
    expect(postCount(h)).toBe(0)
  })

  test('rootless evidence protects only unfollowed threads of its channel; a new mention settles exactly its own thread', async () => {
    const h = await open()
    await h.receive(h.mention({ ts: ROOT2, thread_ts: undefined }))
    const rootless = await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome
    expect(rootless).toMatchObject({ kind: 'pending', surface: 'prompt', missing: ['root'] })
    expect(rootless.ts).toBeUndefined()
    const other = '1700000000.000500'
    expect([h.read(ROOT2), h.read(ROOT), h.read(other), h.read(ROOT, 'alpha', C2), h.read(ROOT, 'beta')])
      .toEqual(['followed', 'unresolved', 'unresolved', 'unfollowed', 'unfollowed'])
    expect((await h.receive(threadReply({ thread_ts: ROOT2, ts: '1700000000.000201' }))).acknowledged).toBe(1)
    expect((await h.receive(h.mention({ ts: ROOT, thread_ts: undefined }))).acknowledged).toBe(1)
    expect([h.read(ROOT), h.read(other)]).toEqual(['followed', 'unresolved'])
    // Partial resolution claims no recovery: the rootless obligation stays pending.
    expect(h.threads.ownPostFindings('alpha')).toEqual([expect.objectContaining({ kind: 'pending', missing: ['root'], id: rootless.id })])
    expect(await h.threads.retryOwnPost('alpha', rootless.id!)).toMatchObject({ kind: 'pending' })
  })

  test('a failed enrollment write over durable pending evidence stays pending with its original missing evidence, then enrolls on repair', async () => {
    const h = await open()
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: 'history-unresolved' })
    const pending = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    expect(pending).toMatchObject({ kind: 'pending', missing: ['channel-eligibility'] })
    h.membership.delete(`alpha:${C}`)
    h.disk.fail('write', 'thread-participation')
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await h.threads.retryOwnPost('alpha', pending.id!)
      expect(failed).toMatchObject({ kind: 'pending', id: pending.id, root: ROOT, missing: ['channel-eligibility'], reason: 'storage' })
      expect(failed!.error).toBeDefined()
      // Never flipped to a gap: the durable copy still exists.
      expect(h.threads.ownPostFindings('alpha')).toEqual([expect.objectContaining({ kind: 'pending', id: pending.id, missing: ['channel-eligibility'] })])
    }
    expect(h.disk.failures).toContain('write')
    expect(ownRecords(h).map(r => r.state)).toEqual(['observed'])
    expect(h.read()).toBe('unresolved')
    h.disk.repair()
    expect(await h.threads.retryOwnPost('alpha', pending.id!)).toMatchObject({ kind: 'enrolled', missing: [] })
    expect(h.read()).toBe('followed')
    expect(postCount(h)).toBe(0)
  })

  test('a post into a durably followed thread is a duplicate whatever eligibility reads: no record, no fresh outcome, no notice', async () => {
    const h = await open()
    await h.receive(h.mention({ thread_ts: undefined }))
    expect(h.read()).toBe('followed')
    for (const [i, reading] of ([{ kind: 'unresolved', reason: 'history-unresolved' }, { kind: 'ineligible', reason: 'absent' }] as const).entries()) {
      h.membership.set(`alpha:${C}`, reading)
      const reply = await h.confirmPost({ channel: C, ts: `1700000000.00015${i}`, parent: ROOT }).outcome
      expect(reply).toMatchObject({ kind: 'enrolled', root: ROOT, missing: [] })
      expect(reply.id).toBeUndefined()
    }
    await h.notices.flush()
    expect([ownRecords(h), outcomes(h), h.threads.ownPostFindings()]).toEqual([[], [], []])
    expect(duplicates(h).map(o => [o.kind, o.root, o.id])).toEqual([['enrolled', ROOT, undefined], ['enrolled', ROOT, undefined]])
    expect(h.h.logs.filter(l => l.includes(OWN_POST_NOT_ENROLLED))).toEqual([])
    expect(h.notices.h.totalPosts()).toBe(0)
    expect(h.read()).toBe('followed')
  })

  test('a later part waits on the first part\'s in-flight enrollment: a silent duplicate once it lands, its own durable record when it fails', async () => {
    const gates = [threadHold(), threadHold()]
    let round = 0, failFirst = false
    const h: ThreadHarness = await open({ beforeObservationSave: async (_key, observation) => {
      if (observation.post?.part === 1) {
        await gates[round++]!.wait()
        if (failFirst) h.disk.fail('write', 'thread-participation')
      } else if (observation.post) h.disk.repair()
    } })
    const parts = async (parent: string, gate: ReturnType<typeof threadHold>) => {
      const issue = h.threads.issueOwnPost('alpha', 'text', C)
      const first = h.threads.confirmOwnPost(issue, { channel: C, ts: `${parent.slice(0, -1)}1`, parent, part: 1 })
      await gate.entered
      let later = false
      const second = h.threads.confirmOwnPost(issue, { channel: C, ts: `${parent.slice(0, -1)}2`, parent, part: 2 })
      void second.then(() => { later = true })
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
      // Held behind the first write; the thread stays protected meanwhile.
      expect(later).toBe(false)
      expect(h.read(parent)).toBe('unresolved')
      return { first, second }
    }
    const landed = await parts(ROOT, gates[0]!)
    gates[0]!.release()
    expect(await landed.first).toMatchObject({ kind: 'enrolled', part: 1, root: ROOT })
    const duplicate = await landed.second
    expect(duplicate).toMatchObject({ kind: 'enrolled', part: 2, root: ROOT, duplicate: true })
    expect(duplicate.id).toBeUndefined()
    expect(ownRecords(h).map(r => [r.observation.root, r.observation.post!.part, r.state])).toEqual([[ROOT, 1, 'enrolled']])
    expect(outcomes(h).map(o => [o.kind, o.part])).toEqual([['enrolled', 1]])
    failFirst = true
    const failing = await parts(ROOT2, gates[1]!)
    gates[1]!.release()
    expect(await failing.first).toMatchObject({ kind: 'gap', reason: 'storage', part: 1, root: ROOT2 })
    const own = await failing.second
    expect(own).toMatchObject({ kind: 'enrolled', part: 2, root: ROOT2 })
    expect(own.duplicate).toBeUndefined()
    expect(ownRecords(h).filter(r => r.observation.root === ROOT2).map(r => [r.observation.post!.part, r.state])).toEqual([[2, 'enrolled']])
    expect(outcomes(h).slice(1).map(o => [o.kind, o.part, o.reason])).toEqual([['gap', 1, 'storage'], ['enrolled', 2, undefined]])
    expect(h.read(ROOT2)).toBe('followed')
    expect(postCount(h)).toBe(0)
  })

  test('a fault after the enrollment write lands is an operation finding over the durable copy, never a gap or a repost', async () => {
    let fault = false
    const h = await open({ afterObservationSave: async (_key, observation) => { if (observation.post) fault = true } })
    const status = h.authority.lifetimeStatus.bind(h.authority)
    h.authority.lifetimeStatus = token => { if (fault) { fault = false; throw new Error('injected post-write fault') } return status(token) }
    const outcome = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    expect(outcome).toMatchObject({ kind: 'pending', reason: 'operation', root: ROOT })
    expect(h.h.queue.threadRecord('alpha', outcome.id!)?.state).toBe('enrolled')
    await h.notices.flush()
    expect(h.h.logs.filter(l => l.includes(OWN_POST_NOT_ENROLLED))).toEqual([buildOwnPostNotEnrolledLine(renderPersonaRef('alpha', 'alpha'), outcome)])
    await h.close()
    const reopened = await open({ clock: h.clock })
    expect(reopened.read()).toBe('followed')
    expect(reopened.threads.ownPostFindings()).toEqual([])
    expect(postCount(h) + postCount(reopened)).toBe(0)
  })

  test('a malformed requested parent is pending with its root missing, persisted as a finding, never enrolled under the reply\'s own ts, and holds no thread', async () => {
    const h = await open()
    const outcome = await h.confirmPost({ channel: C, ts: ROOT, parent: 'not-a-thread' }).outcome
    expect(outcome).toMatchObject({ kind: 'pending', ts: ROOT, missing: ['root'] })
    expect([outcome.parent, outcome.root]).toEqual([undefined, undefined])
    const [record] = ownRecords(h)
    expect(record!.state).toBe('observed')
    expect(record!.observation.root).toBeUndefined()
    expect(record!.observation.post).toMatchObject({ ts: ROOT, parentUnresolved: true, missing: ['root'] })
    expect(record!.observation.post!.parent).toBeUndefined()
    // A reply post with an unresolved parent holds no thread of its channel: only its own-post finding reports it.
    expect([h.read(), h.read(ROOT, 'alpha', C2), h.threads.rootLookupNeeded('alpha', C, ROOT)]).toEqual(['unfollowed', 'unfollowed', false])
    await h.close()
    const reopened = await open({ clock: h.clock })
    expect(reopened.threads.ownPostFindings()).toEqual([expect.objectContaining({ kind: 'pending', id: outcome.id, missing: ['root'] })])
    expect([reopened.read(), reopened.threads.rootLookupNeeded('alpha', C, ROOT)]).toEqual(['unfollowed', false])
  })

  type Damage = { observation: Record<string, any>; acceptedSeq?: number }
  test.each<[string, string, (record: Damage) => void, 'followed' | 'unresolved']>([
    ['an intact enrolled reply', ROOT, () => {}, 'followed'],
    ['an enrolled post still missing eligibility', ROOT, r => { r.observation.post.missing = ['channel-eligibility'] }, 'unresolved'],
    ['a reply whose root is not its parent', ROOT2, r => { r.observation.root = ROOT2 }, 'unresolved'],
    ['an enrolled post with no delivery choice', ROOT, r => { delete r.observation.policy.delivery }, 'unresolved'],
    ['an own post carrying an incoming Slack key', ROOT, r => { r.observation.slackKey = { chat_id: C, ts: '1700000000.000101' }; r.acceptedSeq = 1 }, 'unresolved'],
  ])('a restored own-post record: %s', async (_name, claimed, damage, expected) => {
    const h = await open()
    const enrolled = await h.confirmPost({ channel: C, ts: '1700000000.000101', parent: ROOT }).outcome
    expect(enrolled).toMatchObject({ kind: 'enrolled', root: ROOT })
    await h.close()
    seedQueue(dir, readQueue(dir).map(record => {
      if (record.kind !== 'thread-participation' || record.observation.id !== enrolled.id) return record
      const copy = structuredClone(record) as unknown as Damage
      damage(copy)
      return JSON.stringify(copy) + '\n'
    }))
    // A refused record enrolls nothing and leaves the persona's unknown threads unresolved, never unfollowed.
    const reopened = await open({ clock: h.clock })
    expect(reopened.h.queue.threadRecord('alpha', enrolled.id!)?.state).toBe(expected === 'followed' ? 'enrolled' : undefined)
    expect(reopened.read(claimed)).toBe(expected)
    expect(reopened.read(ROOT, 'beta')).toBe('unfollowed')
  })
})

describe('reply parts through the MCP reply tool', () => {
  const TEXT = 'abcdefghij' + 'klmnopqrst' + 'uvw'
  const openReply = (options: Parameters<typeof open>[0] = {}) => open({ ...options, routing: { replyChunkLimit: 10, ...options.routing } })
  const resultText = (result: { content: Array<{ text?: string }> }) => result.content.map(c => c.text).join('')
  /** A delivered thread reply whose ack reaction a correlated successful post removes. */
  async function deliveredReply(h: ThreadHarness) {
    await h.receive(h.mention()); await h.receive(threadReply())
    const item = h.h.queued('alpha')[1]!
    await h.h.queue.append('alpha', sentRecord(item.accepted.seq))
    await h.h.queue.append('alpha', deliveredRecord(item.accepted.seq, h.clock.now()))
    h.reporting.engineEvent({ type: 'item-delivered', key: 'alpha', seq: item.accepted.seq, at: h.clock.now(), waitMs: 0 })
    await h.drainReactions()
    return item
  }

  test('independent root chunks each enroll their own returned root and shared-parent chunks their parent once, reconstructing the exact text', async () => {
    const h = await openReply()
    const result = await h.h.replyResult('alpha', { chat_id: C, text: TEXT })
    expect(result.isError).toBeFalsy()
    const roots = h.h.p('alpha').stub.calls.postMessage
    expect(roots.map(p => textOf(p)).join('')).toBe(TEXT)
    expect(roots).toHaveLength(3)
    const returned = h.h.p('alpha').stub.web.callLog.filter(c => c.method === 'chat.postMessage').map((_, i) => `1700000000.${String(i + 1).padStart(6, '0')}`)
    expect(returned.map(ts => h.read(ts))).toEqual(['followed', 'followed', 'followed'])
    expect(resultText(result)).toContain(`[ts: ${returned[2]}]`)
    expect(await h.h.replyResult('alpha', { chat_id: C2, thread_ts: ROOT2, text: TEXT })).not.toMatchObject({ isError: true })
    expect(h.h.p('alpha').stub.calls.postMessage.slice(3).map(p => [p.thread_ts, textOf(p)])).toEqual([[ROOT2, 'abcdefghij'], [ROOT2, 'klmnopqrst'], [ROOT2, 'uvw']])
    expect(ownRecords(h).map(r => [r.observation.lifetime.channel, r.observation.root, r.observation.post!.part]))
      .toEqual([...returned.map((ts, i) => [C, ts, i + 1]), [C2, ROOT2, 1]])
    expect(h.read(ROOT2, 'alpha', C2)).toBe('followed')
    expect(outcomes(h).map(o => o.kind)).toEqual(['enrolled', 'enrolled', 'enrolled', 'enrolled'])
    // Independent roots are never duplicates; only the later shared-parent parts are.
    expect(duplicates(h).map(o => [o.kind, o.channel, o.root, o.part])).toEqual([['enrolled', C2, ROOT2, 2], ['enrolled', C2, ROOT2, 3]])
  })

  test.each(['throwing owner', 'rejecting owner', 'storage fault'] as const)('a %s after each success still posts every authorized part exactly once and cleans the correlated ack', async fault => {
    const h = await openReply()
    const item = await deliveredReply(h)
    const removals = h.h.p('alpha').stub.calls.reactionsRemove.length, before = postCount(h)
    if (fault === 'throwing owner') h.threads.confirmOwnPost = () => { throw new Error('injected confirmation failure') }
    else if (fault === 'rejecting owner') h.threads.confirmOwnPost = () => Promise.reject(new Error('injected async confirmation failure'))
    else h.disk.fail('write', 'thread-participation')
    const result = await h.h.replyResult('alpha', { chat_id: C, thread_ts: ROOT2, message_id: item.accepted.ts, text: TEXT })
    expect(result.isError).toBeFalsy()
    expect(resultText(result)).toContain('Sent 3 message(s) to')
    expect(h.h.p('alpha').stub.calls.postMessage.slice(before).map(p => textOf(p))).toEqual(['abcdefghij', 'klmnopqrst', 'uvw'])
    await h.drainReactions()
    expect(h.h.p('alpha').stub.calls.reactionsRemove.length).toBe(removals + 1)
    // A failed first write makes no later part a duplicate: each part attempts its own write and reports its own gap.
    expect(outcomes(h, 'gap').map(o => [o.reason, o.part])).toEqual([1, 2, 3].map(part => [fault === 'storage fault' ? 'storage' : 'operation', part]))
    expect(h.h.ownPostOutcomes.filter(o => o.kind !== 'gap')).toEqual([])
    expect(h.read(ROOT2)).toBe(fault === 'storage fault' ? 'unresolved' : 'unfollowed')
    // Repair never posts again.
    h.disk.repair()
    for (const finding of h.threads.ownPostFindings('alpha')) await h.threads.retryOwnPost('alpha', finding.id!)
    expect(postCount(h)).toBe(before + 3)
  })

  test('a later chunk failure reports the confirmed prefix truthfully, keeps its participation and never reposts it', async () => {
    const h = await openReply()
    h.h.p('alpha').stub.script.post.push({ kind: 'ok' }, { kind: 'platform', error: 'channel_not_found' })
    const result = await h.h.replyResult('alpha', { chat_id: C, text: TEXT })
    const first = '1700000000.000001'
    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe(replyPartialFailureText({ where: C, sent: 1, total: 3, lastTs: first, uploaded: 0, files: 0 }, 'channel_not_found'))
    expect(h.h.p('alpha').stub.calls.postMessage.map(p => textOf(p))).toEqual(['abcdefghij', 'klmnopqrst'])
    expect(h.read(first)).toBe('followed')
    expect(h.h.ownPostOutcomes.map(o => [o.kind, o.part])).toEqual([['enrolled', 1]])
    // The operator line goes through the server's injected log, with the counts and never the reply's text.
    const lines = h.h.logs.filter(l => l.startsWith('[slack] Tool "reply" stopped after a partial post'))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.startsWith(`[slack] Tool "reply" stopped after a partial post for persona ${renderPersonaRef('alpha', 'alpha')}: sent=1/3 uploaded=0/0: `)).toBe(true)
    expect(lines[0]).toContain('channel_not_found')
    for (const part of ['abcdefghij', 'klmnopqrst', 'uvw']) expect(lines[0]).not.toContain(part)
  })

  test.each(['reset', 'leave', 'rejoin'] as const)('a %s while a reply part is in flight supersedes that part and the rest; every part still posts once', async change => {
    const h = await openReply()
    const held = makeDeferredWebApiCall()
    h.h.p('alpha').stub.script.post.push({ kind: 'ok' }, held.outcome)
    const reply = h.h.replyResult('alpha', { chat_id: C, text: TEXT })
    await settleUntil(h, () => postCount(h) === 2)
    const a = h.authority, life = a.incarnation('alpha')!, before = structuredClone(a.lifetime('alpha', C))
    const member = (event: string, joined: boolean, boundary: number) =>
      expect(a.observeMembership('alpha', life, { event, identity: 'app', channel: C, member: joined, boundary }, a.revision).kind).toBe('applied')
    if (change === 'reset') expect(a.transact(a.revision, (next, order) => { next.personas.alpha!.resetOrder = order })).toMatchObject({ kind: 'applied' })
    else member('left', false, 0)
    if (change === 'rejoin') member('joined', true, a.revision)
    expect(a.lifetime('alpha', C)).not.toEqual(before)
    held.settle()
    const result = await reply
    expect(result.isError).toBeFalsy()
    expect(resultText(result)).toContain('Sent 3 message(s) to')
    expect(h.h.p('alpha').stub.calls.postMessage.map(p => textOf(p))).toEqual(['abcdefghij', 'klmnopqrst', 'uvw'])
    await h.drainReactions()
    expect(h.h.ownPostOutcomes.map(o => [o.kind, o.part])).toEqual([['enrolled', 1], ['superseded', 2], ['superseded', 3]])
    expect(ownRecords(h).map(r => r.observation.post!.part)).toEqual([1])
    expect(h.threads.ownPostFindings()).toEqual([])
  })

  test.each([
    ['the choice set to off', { mode: 'strict', delivery: 'off' }],
    ['the strict channel entry omitted from the reviewed config', { mode: 'strict', delivery: 'thread_hybrid' }],
    ['a strict-to-open switch', { mode: 'open', delivery: 'thread_hybrid' }],
  ] as const)('%s while a reply part is in flight: later parts enroll under the current facts and every part posts once', async (change, policy) => {
    const h = await openReply()
    const held = makeDeferredWebApiCall()
    h.h.p('alpha').stub.script.post.push({ kind: 'ok' }, held.outcome)
    const reply = h.h.replyResult('alpha', { chat_id: C, text: TEXT })
    await settleUntil(h, () => postCount(h) === 2)
    if (policy.delivery === 'off') await h.choose('off')
    else if (policy.mode === 'open') h.chooseMode('open')
    else {
      h.reviewConfig(applied => { const p = h.personaEntry(applied, 'alpha'); p.channels = p.channels.filter((c: { id: string }) => c.id !== C) })
      // An omitted entry keeps its saved assignment: the applied entry and stored choice, which intake reads too, remain.
      expect(h.h.config!.personas.find(p => p.key === 'alpha')!.channels.map(c => c.id)).toEqual([C, C2])
      expect(h.authority.choice('alpha', C)).toBe('thread_hybrid')
    }
    held.settle()
    const result = await reply
    expect(result.isError).toBeFalsy()
    expect(resultText(result)).toContain('Sent 3 message(s) to')
    expect(h.h.p('alpha').stub.calls.postMessage.map(p => textOf(p))).toEqual(['abcdefghij', 'klmnopqrst', 'uvw'])
    await h.drainReactions(); await h.notices.flush()
    const roots = [1, 2, 3].map(i => `1700000000.${String(i).padStart(6, '0')}`)
    expect(h.h.ownPostOutcomes.map(o => [o.kind, o.part, o.root, o.delivery])).toEqual(roots.map((root, i) => ['enrolled', i + 1, root, i ? policy.delivery : 'thread_hybrid']))
    expect(ownRecords(h).map(r => [r.observation.post!.part, r.state, r.observation.policy]))
      .toEqual([[1, 'enrolled', { mode: 'strict', delivery: 'thread_hybrid' }], [2, 'enrolled', policy], [3, 'enrolled', policy]])
    expect([h.threads.ownPostFindings(), h.h.logs.filter(l => l.includes(OWN_POST_NOT_ENROLLED)), h.notices.h.totalPosts()]).toEqual([[], [], 0])
    // Enrollment never changes intake: an off channel still takes in nothing from the followed thread.
    expect(h.read(roots[1])).toBe('followed')
    expect((await h.receive(threadReply({ thread_ts: roots[1], ts: '1700000000.000901' }))).acknowledged).toBe(1)
    expect(accepted(h).map(a => a.via)).toEqual(policy.delivery === 'off' ? [] : ['thread'])
  })

  test('the persona removed while a reply part is in flight: later parts are superseded, with no record, line or notice; every part posts once', async () => {
    const h = await openReply()
    const held = makeDeferredWebApiCall()
    h.h.p('alpha').stub.script.post.push({ kind: 'ok' }, held.outcome)
    const reply = h.h.replyResult('alpha', { chat_id: C, text: TEXT })
    await settleUntil(h, () => postCount(h) === 2)
    h.reviewConfig(applied => { applied.personas = applied.personas.filter(p => (p.key ?? p.name) !== 'alpha') })
    expect(h.h.config!.personas.map(p => p.key)).not.toContain('alpha')
    h.reporting.forget('alpha')
    held.settle()
    const result = await reply
    expect(result.isError).toBeFalsy()
    expect(resultText(result)).toContain('Sent 3 message(s) to')
    expect(h.h.p('alpha').stub.calls.postMessage.map(p => textOf(p))).toEqual(['abcdefghij', 'klmnopqrst', 'uvw'])
    await h.drainReactions(); await h.notices.flush()
    expect(h.h.ownPostOutcomes.map(o => [o.kind, o.part])).toEqual([['enrolled', 1], ['superseded', 2], ['superseded', 3]])
    expect(ownRecords(h).map(r => r.observation.post!.part)).toEqual([1])
    expect([h.threads.ownPostFindings(), h.h.logs.filter(l => l.includes(OWN_POST_NOT_ENROLLED)), h.notices.h.totalPosts()]).toEqual([[], [], 0])
  })

  test('a failed upload after posted text reports both counts; a first-call failure keeps the plain tool error and enrolls nothing', async () => {
    const h = await openReply()
    const file = join(dir, 'notes.txt'); fs.writeFileSync(file, 'notes')
    h.h.p('alpha').stub.script.upload.push({ kind: 'platform', error: 'file_upload_failed' })
    const result = await h.h.replyResult('alpha', { chat_id: C, thread_ts: ROOT, text: 'short', files: [file] })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe(replyPartialFailureText({ where: C, sent: 1, total: 1, lastTs: '1700000000.000001', uploaded: 0, files: 1 }, 'file_upload_failed'))
    expect(h.read()).toBe('followed')
    h.h.p('beta').stub.script.post.push({ kind: 'platform', error: 'not_in_channel' })
    const refused = await h.h.replyResult('beta', { chat_id: C2, text: TEXT })
    expect(refused.isError).toBe(true)
    expect(resultText(refused)).not.toContain('partial post')
    expect(h.h.p('beta').stub.calls.postMessage).toHaveLength(1)
    expect(ownRecords(h, 'beta')).toEqual([])
    expect(h.h.ownPostOutcomes.filter(o => o.key === 'beta')).toEqual([])
  })
})

describe('own-post findings through delivery reporting, episodes and the notifier', () => {
  const ref = (key = 'alpha') => renderPersonaRef(key, key)
  const findingLines = (h: ThreadHarness, key = 'alpha') => h.h.logs.filter(l => l.startsWith(`[slack] ${OWN_POST_NOT_ENROLLED}: persona=${ref(key)} `))
  const findingNotices = (h: ThreadHarness, key = 'alpha') =>
    (h.notices.h.allPosts()[key] ?? []).filter(p => p.text.includes('*Thread not followed yet*') || p.text.includes('*Thread participation not saved*'))
  const unresolve = (h: ThreadHarness, key = 'alpha', channel: string = C) => h.membership.set(`${key}:${channel}`, { kind: 'unresolved', reason: 'history-unresolved' })
  const resolve = (h: ThreadHarness, key = 'alpha', channel: string = C) => h.membership.delete(`${key}:${channel}`)

  test('pending findings log once each and notify once per episode per persona; the episode ends silently only when the owner has none left', async () => {
    const h = await open()
    unresolve(h); unresolve(h, 'beta')
    const first = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    const second = await h.confirmPost({ channel: C, ts: ROOT2 }).outcome
    const beta = await h.confirmPost({ channel: C, ts: ROOT }, 'beta').outcome
    await h.notices.flush()
    expect(findingLines(h)).toEqual([buildOwnPostNotEnrolledLine(ref(), first), buildOwnPostNotEnrolledLine(ref(), second)])
    expect(findingNotices(h).map(p => p.text)).toEqual([formatPersonaNotice(h.notices.config.personas[0]!, buildOwnPostNotEnrolledNotice(ref(), first))])
    expect(findingNotices(h, 'beta')).toHaveLength(1)
    expect(findingLines(h, 'beta')).toEqual([buildOwnPostNotEnrolledLine(ref('beta'), beta)])
    // A failing enrollment write re-reports the same pending id; its open finding logs and notifies nothing new.
    resolve(h)
    h.disk.fail('write', 'thread-participation')
    const again = await h.threads.retryOwnPost('alpha', first.id!)
    expect(again).toMatchObject({ kind: 'pending', id: first.id })
    expect(again!.error).toBeDefined()
    expect(h.h.ownPostOutcomes.filter(o => o.id === first.id).map(o => o.kind)).toEqual(['pending', 'pending'])
    await h.notices.flush()
    expect(findingLines(h)).toHaveLength(2)
    expect(findingNotices(h)).toHaveLength(1)
    h.disk.repair()
    expect(await h.threads.retryOwnPost('alpha', first.id!)).toMatchObject({ kind: 'enrolled' })
    // One thread resolved: the other obligation still holds the episode open, so a new finding stays quiet.
    unresolve(h)
    const third = await h.confirmPost({ channel: C, ts: '1700000000.000600' }).outcome
    await h.notices.flush()
    expect(findingNotices(h)).toHaveLength(1)
    expect(findingLines(h)).toHaveLength(3)
    resolve(h)
    for (const o of [second, third]) expect(await h.threads.retryOwnPost('alpha', o.id!)).toMatchObject({ kind: 'enrolled' })
    expect(h.threads.ownPostFindings('alpha')).toEqual([])
    await h.notices.flush()
    // Ended silently: no recovery notice and no recovered line, which only idle recovery reports; beta's episode is untouched. A later finding opens a new episode.
    expect(h.notices.h.allPosts().alpha).toHaveLength(1)
    expect(h.h.logs.filter(l => l === buildParticipationRecoveredLine(ref()) || l === buildParticipationRecoveredLine(ref('beta')))).toEqual([])
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(false)
    expect(h.notices.rig.episodes.isOpen('beta', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(true)
    expect(h.threads.ownPostFindings('beta')).toHaveLength(1)
    unresolve(h)
    await h.confirmPost({ channel: C, ts: '1700000000.000700' }).outcome
    await h.notices.flush()
    expect(findingNotices(h)).toHaveLength(2)
    expect(findingNotices(h, 'beta')).toHaveLength(1)
  })

  test(`finding lines stop at ${OWN_POST_FINDINGS_LOGGED_PER_PERSONA} per persona with one capped line, and one notice`, async () => {
    const h = await open()
    unresolve(h)
    for (let i = 1; i <= OWN_POST_FINDINGS_LOGGED_PER_PERSONA + 3; i++) {
      expect(await h.confirmPost({ channel: C, ts: `1700000001.${String(i).padStart(6, '0')}` }).outcome).toMatchObject({ kind: 'pending' })
    }
    await h.notices.flush()
    const lines = findingLines(h)
    expect(lines).toHaveLength(OWN_POST_FINDINGS_LOGGED_PER_PERSONA + 1)
    expect(lines.at(-1)).toBe(buildOwnPostFindingsCappedLine(ref()))
    expect(lines.filter(l => l.includes('state=pending'))).toHaveLength(OWN_POST_FINDINGS_LOGGED_PER_PERSONA)
    expect(findingNotices(h)).toHaveLength(1)
    expect(h.threads.ownPostFindings('alpha')).toHaveLength(OWN_POST_FINDINGS_LOGGED_PER_PERSONA + 3)
    // Once no obligation remains the cap resets with the episode: the next finding is logged again.
    resolve(h)
    for (const finding of h.threads.ownPostFindings('alpha')) expect(await h.threads.retryOwnPost('alpha', finding.id!)).toMatchObject({ kind: 'enrolled' })
    unresolve(h)
    const next = await h.confirmPost({ channel: C, ts: '1700000002.000001' }).outcome
    await h.notices.flush()
    expect(findingLines(h).slice(lines.length)).toEqual([buildOwnPostNotEnrolledLine(ref(), next)])
    expect(findingNotices(h)).toHaveLength(2)
  })

  test('forgetting a persona drops only its open own-post findings: its re-reported finding logs again, another persona\'s stays deduplicated', async () => {
    const h = await open()
    unresolve(h); unresolve(h, 'beta')
    const alpha = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    const beta = await h.confirmPost({ channel: C, ts: ROOT }, 'beta').outcome
    await h.notices.flush()
    expect([findingLines(h).length, findingLines(h, 'beta').length]).toEqual([1, 1])
    h.reporting.forget('alpha')
    const retryFailing = async (key: string, id: string) => {
      resolve(h, key); h.disk.fail('write', 'thread-participation', key)
      const outcome = await h.threads.retryOwnPost(key, id)
      h.disk.repair()
      expect(outcome).toMatchObject({ kind: 'pending', id })
      return outcome!
    }
    const alphaAgain = await retryFailing('alpha', alpha.id!)
    await retryFailing('beta', beta.id!)
    await h.notices.flush()
    expect(findingLines(h)).toEqual([buildOwnPostNotEnrolledLine(ref(), alpha), buildOwnPostNotEnrolledLine(ref(), alphaAgain)])
    expect(findingLines(h, 'beta')).toEqual([buildOwnPostNotEnrolledLine(ref('beta'), beta)])
    expect(findingNotices(h, 'beta')).toHaveLength(1)
  })

  test('a write failing after its persona is removed is superseded, and a gap still arriving for the removed key is not reported; once the persona is applied again a finding reports normally', async () => {
    const gate = threadHold()
    let held = true
    const h = await open({ beforeObservationSave: async (_key, observation) => { if (observation.post && held) { held = false; await gate.wait() } } })
    h.disk.fail('write', 'thread-participation', 'alpha')
    const adapterIssue = h.h.ownPosts.issue('alpha', 'text', C)
    const { outcome } = h.confirmPost({ channel: C, ts: ROOT })
    await gate.entered
    let entry: Record<string, any> | undefined
    h.reviewConfig(applied => { entry = h.personaEntry(applied, 'alpha'); applied.personas = applied.personas.filter(p => p !== entry) })
    h.reporting.forget('alpha')
    gate.release()
    // The write was already under way at removal and fails after it: the removed life is owed nothing.
    const late = await outcome
    expect(late).toMatchObject({ kind: 'superseded', key: 'alpha', channel: C, ts: ROOT })
    expect(h.disk.failures).toEqual(['write'])
    expect(h.h.ownPostOutcomes).toEqual([late])
    expect(ownRecords(h)).toEqual([])
    // The adapter's operation fallback still reports a gap for the removed key; the reporter drops it.
    const confirm = h.threads.confirmOwnPost
    h.threads.confirmOwnPost = () => Promise.reject(new Error('injected owner fault'))
    h.h.ownPosts.confirm(adapterIssue, { channel: C, ts: ROOT2 })
    await settleUntil(h, () => h.h.ownPostOutcomes.length === 2)
    h.threads.confirmOwnPost = confirm
    expect(h.h.ownPostOutcomes[1]).toMatchObject({ kind: 'gap', reason: 'operation', key: 'alpha', channel: C, ts: ROOT2 })
    await h.notices.flush()
    expect([findingLines(h), h.h.logs.filter(l => l.includes(OWN_POST_NOT_ENROLLED)), h.notices.h.totalPosts()]).toEqual([[], [], 0])
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(false)
    h.disk.repair()
    h.reviewConfig(applied => { applied.personas.push(entry!) })
    expect(h.h.config!.personas.map(p => p.key)).toContain('alpha')
    // Removal ended the old assignment; the applied-again persona is assigned its channel afresh.
    await h.choose('thread_hybrid')
    unresolve(h)
    const finding = await h.confirmPost({ channel: C, ts: ROOT2 }).outcome
    expect(finding).toMatchObject({ kind: 'pending', key: 'alpha' })
    await h.notices.flush()
    expect(findingLines(h)).toEqual([buildOwnPostNotEnrolledLine(ref(), finding)])
    expect(findingNotices(h).map(p => p.text)).toEqual([formatPersonaNotice(h.notices.config.personas.find(p => p.key === 'alpha')!, buildOwnPostNotEnrolledNotice(ref(), finding))])
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(true)
  })

  test('an enrollment write failing after a destructive modify of its persona is superseded: the new life gets no line or notice, and the reply keeps its result', async () => {
    const gate = threadHold()
    let held = true
    const h = await open({ beforeObservationSave: async (_key, observation) => { if (observation.post && held) { held = false; await gate.wait() } } })
    h.disk.fail('write', 'thread-participation', 'alpha')
    const life = h.authority.incarnation('alpha')
    const result = await h.h.replyResult('alpha', { chat_id: C, text: 'short' })
    await gate.entered
    // The tool result never waits on the held participation write.
    expect(result.isError).toBeFalsy()
    expect(result.content.map(c => c.text).join('')).toContain('Sent 1 message(s) to')
    const ts = '1700000000.000001'
    h.reviewConfig(applied => { const p = h.personaEntry(applied, 'alpha'); p.working_directory = `${p.working_directory}-moved` })
    expect(h.h.config!.personas.map(p => p.key)).toContain('alpha')
    expect(h.authority.incarnation('alpha')).toBeDefined()
    expect(h.authority.incarnation('alpha')).not.toBe(life)
    h.reporting.forget('alpha')
    gate.release()
    await settleUntil(h, () => h.h.ownPostOutcomes.length === 1)
    expect(h.disk.failures).toEqual(['write'])
    expect(h.h.ownPostOutcomes).toEqual([expect.objectContaining({ kind: 'superseded', key: 'alpha', surface: 'text', channel: C, ts, root: ts })])
    expect(ownRecords(h)).toEqual([])
    await h.drainReactions(); await h.notices.flush()
    expect([findingLines(h), h.h.logs.filter(l => l.includes(OWN_POST_NOT_ENROLLED)), h.notices.h.totalPosts(), h.threads.ownPostFindings()]).toEqual([[], [], 0, []])
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(false)
    expect(h.h.p('alpha').stub.calls.postMessage.map(p => textOf(p))).toEqual(['short'])
  })

  test.each(['a fresh enrollment', 'replies only into already followed threads'] as const)('an id-less gap cannot hold the episode open: it ends at %s, and a later storage gap logs and notifies again', async settling => {
    const h = await open()
    const intoFollowed = settling !== 'a fresh enrollment'
    if (intoFollowed) {
      await h.receive(h.mention({ thread_ts: undefined }))
      await h.receive(h.mention({ ts: ROOT2, thread_ts: undefined }))
      expect([h.read(), h.read(ROOT2)]).toEqual(['followed', 'followed'])
    }
    h.h.ownPostIdentity.set('alpha', undefined)
    const idless = await h.confirmPost({ channel: C, ts: '1700000000.000500' }).outcome
    h.h.ownPostIdentity.delete('alpha')
    expect(idless).toMatchObject({ kind: 'gap', reason: 'identity-unresolved' })
    expect(idless.id).toBeUndefined()
    await h.notices.flush()
    expect(findingLines(h)).toEqual([buildOwnPostNotEnrolledLine(ref(), idless)])
    expect(findingNotices(h)).toHaveLength(1)
    expect(h.threads.ownPostFindings('alpha')).toEqual([])
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(true)
    if (intoFollowed) {
      for (const [parent, ts] of [[ROOT, '1700000000.000501'], [ROOT2, '1700000000.000502']] as const) {
        expect(await h.confirmPost({ channel: C, ts, parent }).outcome).toMatchObject({ kind: 'enrolled', root: parent, duplicate: true })
      }
      // Nothing but duplicates settled: no record, no fresh outcome, yet the episode ends.
      expect([ownRecords(h), outcomes(h), duplicates(h).length]).toEqual([[], [idless], 2])
    } else expect(await h.confirmPost({ channel: C, ts: ROOT2 }).outcome).toMatchObject({ kind: 'enrolled' })
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(false)
    h.disk.fail('write', 'thread-participation')
    const gap = await h.confirmPost({ channel: C, ts: '1700000000.000600' }).outcome
    expect(gap).toMatchObject({ kind: 'gap', reason: 'storage' })
    await h.notices.flush()
    expect(findingLines(h)).toEqual([buildOwnPostNotEnrolledLine(ref(), idless), buildOwnPostNotEnrolledLine(ref(), gap)])
    expect(findingNotices(h).map(p => p.text)).toEqual([idless, gap].map(o => formatPersonaNotice(h.notices.config.personas[0]!, buildOwnPostNotEnrolledNotice(ref(), o))))
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(true)
  })

  test('a pending post whose lifetime a reset supersedes no longer holds the episode open; nothing announces recovery', async () => {
    const h = await open()
    unresolve(h)
    const stale = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    expect(stale).toMatchObject({ kind: 'pending' })
    await h.notices.flush()
    expect(findingNotices(h)).toHaveLength(1)
    const a = h.authority
    expect(a.transact(a.revision, (next, order) => { next.personas.alpha!.resetOrder = order })).toMatchObject({ kind: 'applied' })
    expect(h.threads.ownPostFindings('alpha')).toEqual([])
    // Any later settling outcome prunes it; the episode ends silently.
    expect(await h.confirmPost({ channel: C2, ts: ROOT2 }).outcome).toMatchObject({ kind: 'enrolled' })
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(false)
    await h.notices.flush()
    expect(findingNotices(h)).toHaveLength(1)
    expect(h.notices.h.allPosts().alpha).toHaveLength(1)
    expect(findingLines(h)).toEqual([buildOwnPostNotEnrolledLine(ref(), stale)])
  })

  test.each(['immediate', 'held'] as const)('a notice (%s post) enrolls its returned root through the real resolver and owner; own echoes and a repeated confirmation add nothing', async drain => {
    const h = await open()
    h.chooseDestination('alpha', C)
    const stub = h.h.p('alpha').stub
    if (drain === 'held') stub.script.post.push({ kind: 'rate-limited', retryAfter: 1 })
    await h.h.notifier.notify('alpha', 'a persona notice')
    await h.h.holdClock.flush()
    if (drain === 'held') {
      expect(h.h.hold.view('alpha').held).toBe(true)
      expect(h.h.ownPostOutcomes).toEqual([])
      // The drain posts to the destination current at its attempt.
      h.chooseDestination('alpha', C2)
      await h.h.holdClock.runNext()
      expect(h.h.hold.view('alpha').held).toBe(false)
    }
    const channel = drain === 'held' ? C2 : C, ts = '1700000000.000001'
    expect(stub.calls.postMessage.map(p => p.channel)).toEqual(drain === 'held' ? [C, C2] : [C])
    expect(h.h.ownPostOutcomes).toEqual([expect.objectContaining({ kind: 'enrolled', surface: 'notice', channel, ts, root: ts, missing: [] })])
    expect(h.read(ts, 'alpha', channel)).toBe('followed')
    const echo = threadReply({ channel, thread_ts: undefined, ts, user: stub.identity.botUserId, bot_id: stub.identity.botId, text: 'a persona notice' })
    for (let i = 0; i < 2; i++) await h.receive(echo)
    expect(await h.confirmPost({ channel, ts }, 'alpha', 'notice').outcome).toMatchObject({ kind: 'enrolled', root: ts, duplicate: true })
    expect(ownRecords(h).map(r => [r.observation.lifetime.channel, r.observation.root, r.state])).toEqual([[channel, ts, 'enrolled']])
    expect([outcomes(h).length, duplicates(h).length, accepted(h)]).toEqual([1, 1, []])
    await h.notices.flush()
    expect([findingLines(h), h.notices.h.totalPosts()]).toEqual([[], 0])
    expect((await h.receive(threadReply({ channel, thread_ts: ts, ts: '1700000000.000901' }))).acknowledged).toBe(1)
    expect(accepted(h).map(a => [a.channel, a.thread_ts, a.via])).toEqual([[channel, ts, 'thread']])
    expect(stub.calls.postMessage).toHaveLength(drain === 'held' ? 2 : 1)
  })

  test('a notice whose own enrollment fails is logged as a gap only: no further notice, no repost', async () => {
    const h = await open()
    h.chooseDestination('alpha', C)
    h.disk.fail('write', 'thread-participation')
    await h.h.notifier.notify('alpha', 'a persona notice')
    await h.h.holdClock.flush()
    await h.notices.flush()
    const stub = h.h.p('alpha').stub
    expect(stub.calls.postMessage.map(p => p.channel)).toEqual([C])
    const gap = outcomes(h, 'gap')
    expect(gap.map(o => [o.surface, o.reason, o.channel])).toEqual([['notice', 'storage', C]])
    expect(findingLines(h)).toEqual([buildOwnPostNotEnrolledLine(ref(), gap[0]!)])
    expect(findingNotices(h)).toEqual([])
    expect(h.notices.h.totalPosts()).toBe(0)
    expect(stub.calls.postMessage).toHaveLength(1)
  })

  test('a DM destination notice is ineligible and reports nothing; a gap names its cause and repair limits without the post\'s body', async () => {
    const h = await open()
    await h.h.notifier.notify('alpha', 'a dm notice')
    await h.h.holdClock.flush()
    expect(h.h.ownPostOutcomes.map(o => [o.kind, o.reason])).toEqual([['ineligible', 'dm']])
    expect(findingLines(h)).toEqual([])
    h.disk.fail('write', 'thread-participation')
    const body = 'private reply body 7f3a'
    await h.h.reply('alpha', { chat_id: C, text: body })
    await h.notices.flush()
    const gap = outcomes(h, 'gap')
    expect(gap.map(o => [o.surface, o.reason])).toEqual([['text', 'storage']])
    const [line] = findingLines(h), [notice] = findingNotices(h)
    expect(line).toBe(buildOwnPostNotEnrolledLine(ref(), gap[0]!))
    expect(notice!.text).toBe(formatPersonaNotice(h.notices.config.personas[0]!, buildOwnPostNotEnrolledNotice(ref(), gap[0]!)))
    for (const text of [line!, notice!.text]) expect(text).not.toContain(body)
    expect(h.h.p('alpha').stub.calls.postMessage.filter(p => textOf(p) === body)).toHaveLength(1)
  })

  test('restored pending evidence at startup is logged, never announced; later outcomes still settle it silently', async () => {
    const first = await open()
    unresolve(first)
    const pending = await first.confirmPost({ channel: C, ts: ROOT }).outcome
    await first.close()
    const h = await open({ clock: first.clock })
    const restored = h.threads.ownPostFindings()
    expect(restored.map(o => [o.kind, o.id, o.root])).toEqual([['pending', pending.id, ROOT]])
    h.reporting.ownPostStartup(restored)
    await h.notices.flush()
    expect(findingLines(h)).toEqual([buildOwnPostNotEnrolledLine(ref(), restored[0]!)])
    expect(findingNotices(h)).toEqual([])
    // Outcomes the pre-reporting buffer could not keep: one line per persona with any, never a notice.
    h.reporting.ownPostDropped(new Map([['alpha', 3], ['beta', 0]]))
    expect(findingLines(h).slice(1)).toEqual([buildOwnPostOutcomesDroppedLine(ref(), 3)])
    expect(findingLines(h, 'beta')).toEqual([])
    await h.notices.flush()
    expect(h.notices.h.totalPosts()).toBe(0)
    expect(await h.threads.retryOwnPost('alpha', pending.id!)).toMatchObject({ kind: 'enrolled' })
    await h.notices.flush()
    expect(findingNotices(h)).toEqual([])
    expect(h.threads.ownPostFindings()).toEqual([])
  })
})

const T0 = 1_700_000_000_000
const HOUR_MS = 60 * 60 * 1000
/** A Slack timestamp at epoch milliseconds `ms`. */
const tsAt = (ms: number) => `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, '0')}`
const STRICT_POLICY = { mode: 'strict', delivery: 'thread_hybrid' } as const
const issuerOf = (h: ThreadHarness, key = 'alpha') => { const s = h.h.p(key).stub.identity; return { botUserId: s.botUserId, botId: s.botId } }
const personaRef = (key = 'alpha') => renderPersonaRef(key, key)
const recoveryLines = (h: ThreadHarness, key = 'alpha') => h.h.logs.filter(l => l.startsWith(`[slack] participation-recovery: persona=${personaRef(key)} `))
const recoveredLines = (h: ThreadHarness, key = 'alpha') => h.h.logs.filter(l => l === buildParticipationRecoveredLine(personaRef(key)))
const capabilityLines = (h: ThreadHarness) => h.h.logs.filter(l => l.startsWith('[slack] root-lookup-capability-missing: '))
const capabilityNotices = (h: ThreadHarness, key = 'alpha') => (h.notices.h.allPosts()[key] ?? []).filter(p => /\*(Thread lookups unavailable|DM history scope missing)\*/.test(p.text))
const ownAnswer = (h: ThreadHarness, root: string = ROOT, key = 'alpha') => () => rootReplies(root, { user: h.h.p(key).stub.identity.botUserId })
const fails = (error: unknown) => () => { throw error }
/** Receives one dependent reply as Socket Mode does and counts its acknowledgements. */
async function holdReply(h: ThreadHarness, overrides: Parameters<typeof threadReply>[0] = {}, key = 'alpha') {
  const reply = threadReply(overrides) as ReturnType<typeof threadReply> & { ts: string; text: string }, acks = { count: 0 }
  await h.h.routing.receive(reply, () => { acks.count++ }, [key], false)
  return { reply, acks }
}

describe('root, file and channel evidence read from one exact authenticated answer', () => {
  const me = { botUserId: 'U0ALPHABOT', botId: 'B0ALPHABOT' }
  test.each<[string, unknown, ReturnType<typeof parseRootReplies>]>([
    ['the bot user as author', rootReplies(ROOT, { user: me.botUserId }), { kind: 'own', root: ROOT, files: [] }],
    ['the bot ID as author', rootReplies(ROOT, { bot_id: me.botId }), { kind: 'own', root: ROOT, files: [] }],
    ['an own root sharing files; malformed and repeated IDs are dropped',
      rootReplies(ROOT, { user: me.botUserId }, { files: [{ id: 'F0ROOT01' }, { id: 'F0ROOT01' }, { id: 'not a file id' }, 'F0BARE01', { id: 'F0ROOT02' }] }),
      { kind: 'own', root: ROOT, files: ['F0ROOT01', 'F0ROOT02'] }],
    ['the root\'s files under another author', rootReplies(ROOT, { user: 'U0HUMAN' }, { files: [{ id: 'F0ROOT01', user: me.botUserId }] }), { kind: 'foreign', root: ROOT }],
    ['another author', rootReplies(ROOT, { user: 'U0HUMAN' }), { kind: 'foreign', root: ROOT }],
    ['another author whose display name, file owner and reply_users name the persona',
      rootReplies(ROOT, { user: 'U0HUMAN' }, { username: 'alpha', user_profile: { display_name: 'alpha' }, files: [{ id: 'F0ALPHA1', user: me.botUserId }], reply_users: [me.botUserId] }),
      { kind: 'foreign', root: ROOT }],
    ['no author, only reply_users and a file owner naming the persona',
      { ok: true, messages: [{ ts: ROOT, reply_users: [me.botUserId], files: [{ id: 'F0ALPHA1', user: me.botUserId }] }] }, { kind: 'unresolved', reason: 'malformed' }],
    ['a foreign root followed by own replies', rootReplies(ROOT, { user: 'U0HUMAN' }, {}, [{ ts: '1700000000.000101', thread_ts: ROOT, user: me.botUserId }]), { kind: 'foreign', root: ROOT }],
    ['another timestamp first', rootReplies(ROOT2, { user: me.botUserId }), { kind: 'unresolved', reason: 'mismatch' }],
    ['another channel', rootReplies(ROOT, { user: me.botUserId }, { channel: C2 }), { kind: 'unresolved', reason: 'mismatch' }],
    ['a reply of another thread (a reply-only result)', rootReplies(ROOT, { user: me.botUserId }, { thread_ts: ROOT2 }), { kind: 'unresolved', reason: 'not-root' }],
    ['a deleted root', rootReplies(ROOT, { user: me.botUserId }, { subtype: 'tombstone' }), { kind: 'gap', reason: 'deleted' }],
    ['no messages', { ok: true, messages: [] }, { kind: 'unresolved', reason: 'malformed' }],
    ['ok false', { ok: false, error: 'internal_error' }, { kind: 'unresolved', reason: 'malformed' }],
  ])('a conversations.replies answer with %s', (_name, result, expected) => {
    expect(parseRootReplies(result, C, ROOT, me)).toEqual(expected)
  })

  test('only own and foreign authorship are verdicts; gaps, unresolved answers and failures decide nothing', () => {
    expect(rootLookupVerdict({ kind: 'own', root: ROOT, files: ['F0ROOT01'] }) as unknown).toEqual({ kind: 'own', root: ROOT, files: ['F0ROOT01'] })
    expect(rootLookupVerdict({ kind: 'foreign', root: ROOT })).toEqual({ kind: 'not-own' })
    for (const evidence of [{ kind: 'gap', reason: 'deleted' }, { kind: 'gap', reason: 'access-lost' }, { kind: 'unresolved', reason: 'mismatch' },
      { kind: 'deadline' }, { kind: 'capability', slackError: 'missing_scope' }, { kind: 'transient' }] as const) expect(rootLookupVerdict(evidence)).toBeUndefined()
  })

  test('a new upload root is its file\'s earliest share in the exact channel; IDs, creation times, other channels and re-shares name nothing', () => {
    const F = 'F0UPLOAD1', file = (shares: Array<{ ts: string; thread_ts?: string }>, channel: string = C, visibility: 'public' | 'private' = 'public') =>
      fileInfo(F, channel, shares, visibility).file
    expect(fileShareRoot(file([{ ts: ROOT2 }, { ts: ROOT }]), C)).toEqual({ kind: 'root', root: ROOT })
    expect(fileShareRoot(file([{ ts: ROOT }], C, 'private'), C)).toEqual({ kind: 'root', root: ROOT })
    expect(fileShareRoot(file([{ ts: ROOT }], C2), C)).toEqual({ kind: 'unresolved', reason: 'no-share' })
    expect(fileShareRoot(file([{ ts: ROOT2, thread_ts: ROOT }]), C)).toEqual({ kind: 'unresolved', reason: 'ambiguous' })
    expect(fileShareRoot({ id: F, created: 1_700_000_000, timestamp: 1_700_000_000 }, C)).toEqual({ kind: 'unresolved', reason: 'no-share' })
    expect(fileShareRoot({ id: F, shares: { public: { [C]: 'not-a-list' } } }, C)).toEqual({ kind: 'unresolved', reason: 'malformed' })
    expect(completionFiles({ ok: true, files: [file([{ ts: ROOT }]), { id: 'not-a-file-id' }] }, C)).toEqual([{ id: F, root: ROOT }])
    // A parent upload needs no share; an aggregate that is not ok confirms nothing.
    expect(completionFiles({ ok: true, files: [file([{ ts: ROOT }])] }, C, ROOT2)).toEqual([{ id: F }])
    expect(completionFiles({ ok: false, files: [file([{ ts: ROOT }])] }, C)).toEqual([])
    expect(completionFiles({ ok: true, files: [{ id: F, created: 1_700_000_000 }] }, C)).toEqual([{ id: F }])
  })

  const sharing = (externallyShared: boolean, channelType: 'public' | 'private' = 'public') => ({ kind: 'evidence', channel: C, channelType, externallyShared }) as const
  test.each<[string, Record<string, unknown>, ReturnType<typeof parseConversationInfo>]>([
    ['explicit is_ext_shared false', {}, sharing(false)],
    ['explicit is_ext_shared true', { is_ext_shared: true }, sharing(true)],
    ['a private channel', { is_private: true, is_group: true, is_channel: false }, sharing(false, 'private')],
    ['no is_ext_shared', { is_ext_shared: undefined }, { kind: 'unresolved', reason: 'malformed' }],
    ['a non-boolean is_ext_shared', { is_ext_shared: 'false' }, { kind: 'unresolved', reason: 'malformed' }],
    ['a pending external share', { is_pending_ext_shared: true }, { kind: 'unresolved', reason: 'conflicting' }],
    ['another channel ID', { id: C2 }, { kind: 'unresolved', reason: 'mismatch' }],
    ['a DM', { is_im: true }, { kind: 'unresolved', reason: 'unsupported-type' }],
    ['a group DM', { is_mpim: true }, { kind: 'unresolved', reason: 'unsupported-type' }],
    ['no is_private', { is_private: undefined }, { kind: 'unresolved', reason: 'malformed' }],
  ])('a conversations.info answer with %s', (_name, fields, expected) => {
    expect(parseConversationInfo(channelInfo(C, fields), C)).toEqual(expected)
  })

  test('configured surfaces decide the history scopes: public and private always, im only with DMs enabled, never mpim', () => {
    type Surface = Parameters<typeof requiredHistoryScopes>[0]
    const dmOff = { dm: { enabled: false } } as Surface, dmOn = { dm: { enabled: true, contact: 'U0OPERATOR' } } as Surface
    expect(requiredHistoryScopes(dmOff)).toEqual([PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE])
    expect(requiredHistoryScopes(dmOn)).toEqual([PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE, DM_HISTORY_SCOPE])
    expect(missingHistoryScopes(undefined, dmOn)).toBeUndefined()
    expect(missingHistoryScopes([PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE], dmOff)).toEqual([])
    expect(missingHistoryScopes([PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE, 'mpim:history'], dmOn)).toEqual([DM_HISTORY_SCOPE])
  })

  test('capability: unknown scopes are no gap; a refused method reports once and a later success clears it; a missing scope alone makes lookups unusable', () => {
    const reports: unknown[] = []
    let granted: readonly string[] | undefined
    const cap = createRootLookupCapability({ grantedScopes: () => granted, persona: () => ({ dm: { enabled: false } } as Parameters<typeof requiredHistoryScopes>[0]),
      report: { gap: (key, gap) => reports.push(['gap', key, gap]), cleared: key => reports.push(['cleared', key]) } })
    cap.connected('alpha')
    expect([cap.state('alpha'), cap.usable('alpha'), reports]).toEqual(['unknown', true, []])
    granted = [PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE]; cap.connected('alpha')
    expect(cap.state('alpha')).toBe('scopes-present')
    cap.lookupRefused('alpha', 'not_allowed_token_type'); cap.lookupRefused('alpha', 'not_allowed_token_type')
    const refused = { kind: 'method-refused', method: 'conversations.replies', slackError: 'not_allowed_token_type' }
    expect([reports, cap.usable('alpha')]).toEqual([[['gap', 'alpha', refused]], true])
    cap.lookupSucceeded('alpha')
    expect([cap.state('alpha'), reports.at(-1)]).toEqual(['verified', ['cleared', 'alpha']])
    granted = [PUBLIC_HISTORY_SCOPE]; cap.connected('alpha'); cap.connected('alpha'); cap.lookupRefused('alpha', 'missing_scope')
    expect(reports.slice(2)).toEqual([['gap', 'alpha', { kind: 'missing-scope', scopes: [PRIVATE_HISTORY_SCOPE] }]])
    expect([cap.usable('alpha'), cap.usable('beta')]).toEqual([false, true])
    granted = [PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE]; cap.connected('alpha')
    expect([cap.usable('alpha'), reports.at(-1)]).toEqual([true, ['cleared', 'alpha']])
    cap.forget('alpha')
    expect([cap.state('alpha'), cap.gap('alpha')]).toEqual(['unknown', undefined])
  })

  /** A capability owner for a DM-enabled persona whose granted scopes are `granted` (changed by `grant`), recording its reports. */
  function dmCapability(granted: readonly string[]) {
    const reports: unknown[] = []
    let current = granted
    const cap = createRootLookupCapability({ grantedScopes: () => current, persona: () => ({ dm: { enabled: true, contact: 'U0OPERATOR' } } as Parameters<typeof requiredHistoryScopes>[0]),
      report: { gap: (key, gap) => reports.push(['gap', key, gap]), cleared: key => reports.push(['cleared', key]) } })
    cap.connected('alpha')
    return { cap, reports, grant: (scopes: readonly string[]) => { current = scopes } }
  }
  const IM_ONLY: RootLookupCapabilityGap = { kind: 'missing-scope', scopes: [DM_HISTORY_SCOPE] }
  const CHANNEL_GAP: RootLookupCapabilityGap = { kind: 'missing-scope', scopes: [PRIVATE_HISTORY_SCOPE] }

  test.each<[string, readonly string[], RootLookupCapabilityGap]>([
    ['only im:history', [PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE], IM_ONLY],
    ['a channel history scope', [PUBLIC_HISTORY_SCOPE, DM_HISTORY_SCOPE], CHANNEL_GAP],
  ])('capability: a successful lookup leaves a gap of %s open and reports no clearing', (_name, granted, gap) => {
    const { cap, reports } = dmCapability(granted)
    cap.lookupSucceeded('alpha')
    expect([cap.gap('alpha'), cap.state('alpha'), reports]).toEqual([gap, 'missing', [['gap', 'alpha', gap]]])
  })

  test('capability: under a gap of only im:history lookups are usable and a refused lookup reports a method-refused gap; under a channel scope gap lookups are unusable and a refusal reports nothing', () => {
    const im = dmCapability([PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE])
    expect([im.cap.gap('alpha'), im.cap.usable('alpha')]).toEqual([IM_ONLY, true])
    im.cap.lookupRefused('alpha', 'not_allowed_token_type')
    const refused: RootLookupCapabilityGap = { kind: 'method-refused', method: 'conversations.replies', slackError: 'not_allowed_token_type' }
    expect([im.cap.gap('alpha'), im.cap.usable('alpha'), im.reports]).toEqual([refused, true, [['gap', 'alpha', IM_ONLY], ['gap', 'alpha', refused]]])
    const channel = dmCapability([PUBLIC_HISTORY_SCOPE, DM_HISTORY_SCOPE])
    expect([channel.cap.gap('alpha'), channel.cap.usable('alpha')]).toEqual([CHANNEL_GAP, false])
    channel.cap.lookupRefused('alpha', 'missing_scope')
    expect([channel.cap.gap('alpha'), channel.reports]).toEqual([CHANNEL_GAP, [['gap', 'alpha', CHANNEL_GAP]]])
  })

  const REFUSED: RootLookupCapabilityGap = { kind: 'method-refused', method: 'conversations.replies', slackError: 'not_allowed_token_type' }

  test('capability: a success under a refusal while only im:history is missing returns to the im:history gap and never clears; a later connection or success reports nothing more', () => {
    const { cap, reports } = dmCapability([PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE])
    cap.lookupRefused('alpha', 'not_allowed_token_type')
    cap.lookupSucceeded('alpha')
    expect([cap.gap('alpha'), cap.state('alpha'), cap.usable('alpha')]).toEqual([IM_ONLY, 'missing', true])
    expect(reports).toEqual([['gap', 'alpha', IM_ONLY], ['gap', 'alpha', REFUSED], ['gap', 'alpha', IM_ONLY]])
    cap.connected('alpha'); cap.lookupSucceeded('alpha')
    expect([cap.gap('alpha'), reports.length]).toEqual([IM_ONLY, 3])
  })

  test('capability: with every history scope granted, a success clears a refusal', () => {
    const { cap, reports } = dmCapability([PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE, DM_HISTORY_SCOPE])
    cap.lookupRefused('alpha', 'not_allowed_token_type')
    cap.lookupSucceeded('alpha')
    expect([cap.gap('alpha'), cap.state('alpha'), reports]).toEqual([undefined, 'verified', [['gap', 'alpha', REFUSED], ['cleared', 'alpha']]])
  })

  test('capability: a connection still missing only im:history keeps an open refusal and reports nothing', () => {
    const { cap, reports } = dmCapability([PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE])
    cap.lookupRefused('alpha', 'not_allowed_token_type')
    cap.connected('alpha'); cap.connected('alpha')
    expect([cap.gap('alpha'), cap.usable('alpha'), reports]).toEqual([REFUSED, true, [['gap', 'alpha', IM_ONLY], ['gap', 'alpha', REFUSED]]])
  })

  test('capability: a connection missing a channel history scope replaces an open refusal with that scope gap', () => {
    const { cap, reports, grant } = dmCapability([PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE, DM_HISTORY_SCOPE])
    cap.lookupRefused('alpha', 'not_allowed_token_type')
    grant([PUBLIC_HISTORY_SCOPE, DM_HISTORY_SCOPE])
    cap.connected('alpha')
    expect([cap.gap('alpha'), cap.usable('alpha'), reports]).toEqual([CHANNEL_GAP, false, [['gap', 'alpha', REFUSED], ['gap', 'alpha', CHANNEL_GAP]]])
  })

  test.each<[string, RootLookupCapabilityGap | undefined, boolean]>([
    ['no gap', undefined, false],
    ['only im:history', IM_ONLY, false],
    ['only groups:history', CHANNEL_GAP, true],
    ['only channels:history', { kind: 'missing-scope', scopes: [PUBLIC_HISTORY_SCOPE] }, true],
    ['groups:history and im:history', { kind: 'missing-scope', scopes: [PRIVATE_HISTORY_SCOPE, DM_HISTORY_SCOPE] }, true],
    ['every history scope', { kind: 'missing-scope', scopes: [PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE, DM_HISTORY_SCOPE] }, true],
    ['a refused method', { kind: 'method-refused', method: 'conversations.replies', slackError: 'not_allowed_token_type' }, true],
  ])('capabilityGapHoldsLookups: %s', (_name, gap, holds) => {
    expect(capabilityGapHoldsLookups(gap)).toBe(holds)
  })
})

describe('bounded, revocable enrollment metadata attempts', () => {
  const me = { botUserId: 'U0ALPHABOT', botId: 'B0ALPHABOT' }, F = 'F0UPLOAD1'
  type Call = (method: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  const sources: Array<[string, (a: MetadataAttempts, key: string, current: () => boolean, call: Call) => Promise<unknown>, Record<string, unknown>, unknown, unknown]> = [
    ['conversations.replies', (a, key, current, call) => resolveRootAuthor(a, key, C, ROOT, me, current, call), { channel: C, ts: ROOT, limit: 1, inclusive: true },
      rootReplies(ROOT, { user: me.botUserId }), { kind: 'own', root: ROOT, files: [] }],
    ['files.info', (a, key, current, call) => resolveFileRoot(a, key, F, C, current, call), { file: F }, fileInfo(F, C, [{ ts: ROOT }]), { kind: 'root', root: ROOT }],
    ['conversations.info', (a, key, current, call) => resolveChannelEvidence(a, key, C, current, call), { channel: C }, channelInfo(C),
      { kind: 'evidence', channel: C, channelType: 'public', externallyShared: false }],
  ]
  function scripted() {
    const calls: Array<{ method: string; args: Record<string, unknown>; signal: AbortSignal }> = [], answers: Array<() => Promise<unknown>> = []
    const call: Call = (method, args, signal) => { calls.push({ method, args, signal }); return answers.shift()!() }
    const hang = () => { let settle!: (v: unknown) => void, fail!: (e: unknown) => void; const p = new Promise((a, b) => { settle = a; fail = b }); answers.push(() => p); return { settle, fail } }
    return { calls, answers, call, hang }
  }

  test.each(sources)('%s: a hung first and a hung later attempt each end at the same end-to-end deadline, abort their request and leave nothing in flight', async (method, resolve, args, answer, decided) => {
    const clock = createFakeClock({ start: T0 }), attempts = createMetadataAttempts(clock), s = scripted()
    const first = s.hang()
    const one = resolve(attempts, 'alpha', () => true, s.call)
    await clock.advance(ENROLLMENT_METADATA_DEADLINE_MS - 1)
    expect([attempts.inFlight('alpha'), s.calls[0]!.signal.aborted]).toEqual([1, false])
    await clock.advance(1)
    expect(await one).toEqual({ kind: 'deadline' })
    expect([attempts.inFlight('alpha'), s.calls[0]!.signal.aborted]).toEqual([0, true])
    // The abandoned attempt's late answer is consumed; a fresh attempt starts at once and decides.
    first.settle(answer)
    s.answers.push(async () => answer)
    expect(await resolve(attempts, 'alpha', () => true, s.call)).toEqual(decided)
    const later = s.hang()
    const three = resolve(attempts, 'alpha', () => true, s.call)
    await clock.advance(ENROLLMENT_METADATA_DEADLINE_MS)
    expect(await three).toEqual({ kind: 'deadline' })
    later.fail(slackPlatformError('internal_error'))
    await clock.flush()
    expect(s.calls.map(c => [c.method, c.args])).toEqual([[method, args], [method, args], [method, args]])
    expect([s.calls[2]!.signal.aborted, attempts.inFlight('alpha'), clock.pendingCount()]).toEqual([true, 0, 0])
  })

  test.each(sources)('%s: a guard turning false, revocation or shutdown cancels the attempt; another persona\'s attempt is untouched', async (_method, resolve, _args, answer, decided) => {
    const clock = createFakeClock({ start: T0 }), attempts = createMetadataAttempts(clock), s = scripted()
    let current = true
    const guarded = s.hang(), revoked = s.hang(), other = s.hang()
    const a = resolve(attempts, 'alpha', () => current, s.call)
    const b = resolve(attempts, 'alpha', () => true, s.call)
    const c = resolve(attempts, 'beta', () => true, s.call)
    current = false; guarded.settle(answer)
    expect(await a).toEqual({ kind: 'cancelled' })
    attempts.revoke('alpha')
    expect(await b).toEqual({ kind: 'cancelled' })
    expect([s.calls[1]!.signal.aborted, s.calls[2]!.signal.aborted, attempts.inFlight('beta')]).toEqual([true, false, 1])
    revoked.settle(answer); other.settle(answer)
    expect(await c).toEqual(decided)
    attempts.stop()
    expect(await resolve(attempts, 'beta', () => true, s.call)).toEqual({ kind: 'cancelled' })
    expect(s.calls).toHaveLength(3)
  })

  test.each<[string, unknown, unknown]>([
    ['a missing scope', slackPlatformError('missing_scope'), { kind: 'capability', slackError: 'missing_scope' }],
    ['a refused token type', slackPlatformError('not_allowed_token_type'), { kind: 'capability', slackError: 'not_allowed_token_type' }],
    ['a revoked token', slackPlatformError('token_revoked'), { kind: 'credentials', slackError: 'token_revoked' }],
    ['lost access', slackPlatformError('channel_not_found'), { kind: 'access-lost', slackError: 'channel_not_found' }],
    ['a deleted message', slackPlatformError('thread_not_found'), { kind: 'not-found', slackError: 'thread_not_found' }],
    ['ratelimited with Retry-After', slackPlatformError('ratelimited', 30), { kind: 'transient', retryAfter: 30 }],
    ['a rate-limited rejection', slackRateLimited(120), { kind: 'transient', retryAfter: 120 }],
    ['a server error', slackPlatformError('internal_error'), { kind: 'transient' }],
    ['an unknown Slack error', slackPlatformError('something_new'), { kind: 'rejected', slackError: 'something_new' }],
    ['a service outage', slackPlatformError('service_unavailable'), { kind: 'transient' }],
    ['an HTTP 400', slackHttpError(400), { kind: 'rejected' }],
    ['an HTTP 404', slackHttpError(404), { kind: 'rejected' }],
    ['an HTTP 408', slackHttpError(408), { kind: 'transient' }],
    ['an HTTP 429', slackHttpError(429), { kind: 'transient' }],
    ['an HTTP 503', slackHttpError(503), { kind: 'transient' }],
    ['a malformed Slack error code', slackPlatformError('Not A Code!'), { kind: 'malformed' }],
    ['a transport error', Object.assign(new Error('socket hang up'), { code: 'slack_webapi_request_error' }), { kind: 'transient' }],
    ['a cancellation', new MetadataCancelledError(), { kind: 'cancelled' }],
  ])('%s is classified apart, never as authorship, deletion or recovery', (_name, error, expected) => {
    expect(classifyMetadataFailure(error) as unknown).toEqual(expected)
  })

  test.each(['access_denied', 'no_permission', 'not_authorized'].flatMap(code => [
    ['files.info', code, { kind: 'file-unavailable', slackError: code }],
    ['conversations.replies', code, { kind: 'capability', slackError: code }],
    ['conversations.info', code, { kind: 'capability', slackError: code }],
  ] as Array<[EnrollmentMetadataMethod, string, unknown]>))('%s answering %s: only a file lookup reads it as that file being unavailable', (method, code, expected) => {
    expect(classifyMetadataFailure(slackPlatformError(code), method) as unknown).toEqual(expected)
  })

  test('only Slack\'s not-found and lost-access answers become root and file gaps', async () => {
    const clock = createFakeClock({ start: T0 }), attempts = createMetadataAttempts(clock), s = scripted()
    const reject = (error: unknown) => s.answers.push(() => Promise.reject(error))
    reject(slackPlatformError('message_not_found')); reject(slackPlatformError('not_in_channel'))
    reject(slackPlatformError('file_deleted')); reject(slackPlatformError('is_archived')); reject(slackPlatformError('internal_error'))
    const root = () => resolveRootAuthor(attempts, 'alpha', C, ROOT, me, () => true, s.call)
    expect([await root(), await root()]).toEqual([{ kind: 'gap', reason: 'deleted' }, { kind: 'gap', reason: 'access-lost' }])
    const file = () => resolveFileRoot(attempts, 'alpha', F, C, () => true, s.call)
    expect([await file(), await file(), await file()]).toEqual([{ kind: 'gap', reason: 'deleted' }, { kind: 'gap', reason: 'access-lost' }, { kind: 'transient' }])
    // Another file's answer is no evidence for this one.
    s.answers.push(async () => fileInfo('F0OTHER01', C, [{ ts: ROOT }]))
    expect(await file()).toEqual({ kind: 'unresolved', reason: 'malformed' })
  })

  test('retry spacing: a positive minimum doubling to the local maximum; Retry-After below the cap changes nothing, above it is honored, and huge waits stay safe', () => {
    expect(ENROLLMENT_RETRY_MIN_MS).toBeGreaterThan(0)
    expect([1, 2, 3, 4, 5, 6, 50].map(n => metadataRetryDelay(n))).toEqual([1, 2, 4, 8, 16, 32, 32].map(m => Math.min(ENROLLMENT_RETRY_MAX_MS, ENROLLMENT_RETRY_MIN_MS * m)))
    expect(metadataRetryDelay(50)).toBe(ENROLLMENT_RETRY_MAX_MS)
    expect(metadataRetryDelay(1, 1)).toBe(ENROLLMENT_RETRY_MIN_MS)
    expect(metadataRetryDelay(50, ENROLLMENT_RETRY_MAX_MS / 1000 - 1)).toBe(ENROLLMENT_RETRY_MAX_MS)
    expect(metadataRetryDelay(1, ENROLLMENT_RETRY_MAX_MS / 1000 * 3)).toBe(ENROLLMENT_RETRY_MAX_MS * 3)
    expect(metadataRetryDelay(1, 1e300)).toBe(Number.MAX_SAFE_INTEGER)
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(metadataRetryDelay(1, bad)).toBe(ENROLLMENT_RETRY_MIN_MS)
    // The repair bound: remaining deadline + the next permitted wait (the local maximum or a greater Retry-After) + one attempt.
    expect(enrollmentRepairBoundMs()).toBe(ENROLLMENT_METADATA_DEADLINE_MS + ENROLLMENT_RETRY_MAX_MS + ENROLLMENT_METADATA_DEADLINE_MS)
    expect(enrollmentRepairBoundMs(1000, ENROLLMENT_RETRY_MAX_MS / 1000 * 2)).toBe(1000 + ENROLLMENT_RETRY_MAX_MS * 2 + ENROLLMENT_METADATA_DEADLINE_MS)
  })

  test('a wait longer than one timer re-arms in chunks and never fires early; aborting it resolves false', async () => {
    const clock = createFakeClock({ start: T0 }), controller = new AbortController()
    let done: boolean | undefined
    void waitFor(clock, ENROLLMENT_TIMER_MAX_MS * 2 + 5, controller.signal).then(v => { done = v })
    expect(clock.pending().map(t => t.delayMs)).toEqual([ENROLLMENT_TIMER_MAX_MS])
    await clock.advance(ENROLLMENT_TIMER_MAX_MS * 2 + 4)
    expect(done).toBeUndefined()
    expect(clock.pending().every(t => t.delayMs <= ENROLLMENT_TIMER_MAX_MS)).toBe(true)
    await clock.advance(1)
    expect(done).toBe(true)
    let aborted: boolean | undefined
    void waitFor(clock, ENROLLMENT_TIMER_MAX_MS, controller.signal).then(v => { aborted = v })
    controller.abort(); await clock.flush()
    expect([aborted, clock.pendingCount()]).toEqual([false, 0])
  })
})

describe('own-root applicability: a text post Slack returned no ts falls back to OWN_ROOT_CLOCK_SKEW_MS around its issue, never before its lifetime', () => {
  // Parentless uploads match by file (the recovery cases below). Each row is one looked-up root's offset from a
  // rootless text post's issue, which is confirmed CONFIRMED_MS later.
  const CONFIRMED_MS = 1000
  // Outside the window an own root is `unmatched`: a clock window is no authorship fact, so nothing is decided or written.
  test.each<[string, number, 'enrolled' | 'unmatched']>([
    ['the skew before issue', -OWN_ROOT_CLOCK_SKEW_MS, 'enrolled'],
    ['just past the skew before issue', -OWN_ROOT_CLOCK_SKEW_MS - 1, 'unmatched'],
    ['between issue and confirmation', CONFIRMED_MS / 2, 'enrolled'],
    ['the skew after confirmation', CONFIRMED_MS + OWN_ROOT_CLOCK_SKEW_MS, 'enrolled'],
    ['just past the skew after confirmation', CONFIRMED_MS + OWN_ROOT_CLOCK_SKEW_MS + 1, 'unmatched'],
  ])('an own root at %s', async (_name, offset, expected) => {
    const h = await open()
    const issuedAt = h.clock.now(), issue = h.threads.issueOwnPost('alpha', 'prompt')
    await h.clock.advance(CONFIRMED_MS)
    expect(await h.threads.confirmOwnPost(issue, { channel: C })).toMatchObject({ kind: 'pending', missing: ['root'] })
    const root = tsAt(issuedAt + offset)
    // As routing does: the reply's reading comes first, then whether a lookup can decide it.
    expect(h.read(root)).toBe('unresolved')
    expect(h.threads.rootLookupNeeded('alpha', C, root)).toBe(true)
    const lookup = await h.threads.requestRootLookup('alpha', C, root, issuerOf(h), STRICT_POLICY)
    expect(await h.threads.resolveRootLookup('alpha', lookup!.id, { kind: 'own', root })).toEqual({ kind: expected })
    expect([h.read(root), h.threads.rootLookupOpen('alpha', lookup!.id)]).toEqual(expected === 'enrolled' ? ['followed', false] : ['unresolved', true])
    // Either way the post's own root stays unknown: positive evidence is never assigned to it.
    expect(h.threads.ownPostFindings('alpha')).toEqual([expect.objectContaining({ kind: 'pending', missing: ['root'] })])
  })

  test('the window\'s lower edge is the lifetime\'s start: after a reset, an own root inside the skew but before the reset is unmatched, one after it enrolls', async () => {
    const h = await open()
    await h.clock.advance(HOUR_MS)
    const a = h.authority, resetAt = h.clock.now()
    // A reset's durable evidence: a new reset order and the lifetime's start.
    expect(a.transact(a.revision, (next, order) => { next.personas.alpha!.resetOrder = order; next.personas.alpha!.createdAt = resetAt })).toMatchObject({ kind: 'applied' })
    expect(h.threads.lifetime('alpha', C)?.createdAt).toBe(resetAt)
    await h.clock.advance(CONFIRMED_MS)
    const issuedAt = h.clock.now()
    expect(await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome).toMatchObject({ kind: 'pending', missing: ['root'] })
    const before = tsAt(issuedAt - OWN_ROOT_CLOCK_SKEW_MS + 1), after = tsAt(resetAt + 1)
    expect(issuedAt - OWN_ROOT_CLOCK_SKEW_MS + 1).toBeLessThan(resetAt)
    expect([h.read(before), h.threads.rootLookupNeeded('alpha', C, before)]).toEqual(['unresolved', true])
    const early = await h.threads.requestRootLookup('alpha', C, before, issuerOf(h), STRICT_POLICY)
    expect(await h.threads.resolveRootLookup('alpha', early!.id, { kind: 'own', root: before })).toEqual({ kind: 'unmatched' })
    expect([h.read(before), h.threads.rootLookupOpen('alpha', early!.id)]).toEqual(['unresolved', true])
    const late = await h.threads.requestRootLookup('alpha', C, after, issuerOf(h), STRICT_POLICY)
    expect(await h.threads.resolveRootLookup('alpha', late!.id, { kind: 'own', root: after })).toEqual({ kind: 'enrolled' })
    expect(h.read(after)).toBe('followed')
  })

  test('no unknown-root own post means no lookup; another identity or a verdict for another root enrolls nothing', async () => {
    const h = await open(), r = attachRecovery(h)
    expect([h.threads.rootLookupNeeded('alpha', C, ROOT), h.read()]).toEqual([false, 'unfollowed'])
    const plain = await holdReply(h)
    await r.settle()
    expect([plain.acks.count, r.requests, accepted(h)]).toEqual([1, [], []])
    // A post with a returned root leaves no root unknown.
    await h.confirmPost({ channel: C, ts: ROOT2 }).outcome
    expect(h.threads.rootLookupNeeded('alpha', C, ROOT)).toBe(false)
    await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome
    expect([h.threads.rootLookupNeeded('alpha', C, ROOT), h.threads.rootLookupNeeded('beta', C, ROOT), h.threads.rootLookupNeeded('alpha', C2, ROOT)]).toEqual([true, false, false])
    const stranger = await h.threads.requestRootLookup('alpha', C, ROOT, { botUserId: 'U0OTHERBOT', botId: 'B0OTHERBOT' }, STRICT_POLICY)
    // No post of the lifetime by that identity can have created it.
    expect(await h.threads.resolveRootLookup('alpha', stranger!.id, { kind: 'own', root: ROOT })).toEqual({ kind: 'outside-lifetime' })
    const ROOT3 = '1700000000.000300'
    const mismatched = await h.threads.requestRootLookup('alpha', C, ROOT3, issuerOf(h), STRICT_POLICY)
    expect(await h.threads.resolveRootLookup('alpha', mismatched!.id, { kind: 'own', root: ROOT2 })).toEqual({ kind: 'not-own' })
    expect([h.read(), h.read(ROOT3)]).toEqual(['unfollowed', 'unfollowed'])
    expect(await h.threads.resolveRootLookup('alpha', mismatched!.id, { kind: 'own', root: ROOT3 })).toEqual({ kind: 'absent' })
  })

  test.each(['reset', 'rejoin'] as const)('after a %s an old root never enrolls, even on a fresh lookup; the old lookup is superseded; a fresh mention still enrolls the thread', async change => {
    const h = await open()
    await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome
    const old = await h.threads.requestRootLookup('alpha', C, ROOT, issuerOf(h), STRICT_POLICY)
    const a = h.authority, life = a.incarnation('alpha')!
    const member = (event: string, joined: boolean, boundary: number) =>
      expect(a.observeMembership('alpha', life, { event, identity: 'app', channel: C, member: joined, boundary }, a.revision).kind).toBe('applied')
    if (change === 'reset') expect(a.transact(a.revision, (next, order) => { next.personas.alpha!.resetOrder = order })).toMatchObject({ kind: 'applied' })
    else { member('left', false, 0); member('joined', true, a.revision) }
    expect([h.threads.rootLookups('alpha'), h.threads.ownPostFindings('alpha'), h.threads.rootLookupNeeded('alpha', C, ROOT)]).toEqual([[], [], false])
    expect(await h.threads.resolveRootLookup('alpha', old!.id, { kind: 'own', root: ROOT })).toEqual({ kind: 'superseded' })
    const fresh = await h.threads.requestRootLookup('alpha', C, ROOT, issuerOf(h), STRICT_POLICY)
    expect(fresh!.id).not.toBe(old!.id)
    expect(await h.threads.resolveRootLookup('alpha', fresh!.id, { kind: 'own', root: ROOT })).toEqual({ kind: 'outside-lifetime' })
    // Durably cancelled with its reason, so a reopen does not ask again.
    expect(h.h.queue.threadRecords('alpha').filter(x => x.observation.id === fresh!.id).map(x => [x.state, x.observation.lookup?.reason])).toEqual([['cancelled', 'outside-lifetime']])
    expect(h.read()).toBe('unfollowed')
    if (change === 'rejoin') await h.choose('thread_hybrid')
    expect((await h.receive(h.mention({ ts: '1700000000.000900', thread_ts: ROOT }))).acknowledged).toBe(1)
    expect(h.read()).toBe('followed')
  })

  test('an ordinary restart keeps the window: the restored lookup holds its reply before intake and enrolls; an older root still does not', async () => {
    const first = await open()
    await first.confirmPost({ channel: C }, 'alpha', 'prompt').outcome
    const lookup = await first.threads.requestRootLookup('alpha', C, ROOT, issuerOf(first), STRICT_POLICY)
    await first.close()
    const h = await open({ clock: first.clock })
    expect(h.threads.rootLookups('alpha').map(o => [o.id, o.root])).toEqual([[lookup!.id, ROOT]])
    const held = await holdReply(h)
    expect(held.acks.count).toBe(0)
    expect(await h.threads.resolveRootLookup('alpha', lookup!.id, { kind: 'own', root: ROOT })).toEqual({ kind: 'enrolled' })
    await settleUntil(h, () => held.acks.count === 1)
    expect(accepted(h).map(a => [a.ts, a.via])).toEqual([[held.reply.ts, 'thread']])
    const older = tsAt(h.clock.now() - OWN_ROOT_CLOCK_SKEW_MS - HOUR_MS)
    // Requested for the bot that issued the post (a reopened harness's stub has a new identity).
    const stale = await h.threads.requestRootLookup('alpha', C, older, issuerOf(first), STRICT_POLICY)
    expect(await h.threads.resolveRootLookup('alpha', stale!.id, { kind: 'own', root: older })).toEqual({ kind: 'unmatched' })
    expect(h.read(older)).toBe('unresolved')
  })
})

describe('startup and idle recovery through the production owner, routing and reporting', () => {
  /** A rootless own post makes replies of unknown threads undecidable until a root lookup. */
  async function rootless(options: Parameters<typeof open>[0] = {}, recovery: Parameters<typeof attachRecovery>[1] = {}) {
    const h = await open(options), r = attachRecovery(h, recovery)
    const post = await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome
    expect(post).toMatchObject({ kind: 'pending', missing: ['root'] })
    return { h, r, post }
  }
  /** Counts recovery passes over a usable connection with no capability gap: each lists the persona's root lookups once. */
  function countPasses(h: ThreadHarness, key = 'alpha') {
    const passes = { count: 0 }, threads = h.threads, list = threads.rootLookups.bind(threads)
    threads.rootLookups = (k: string) => { if (k === key) passes.count++; return list(k) }
    return passes
  }

  test('an own root found by one exact lookup follows the thread and accepts the held reply once, payload intact; nothing runs before the handler returns', async () => {
    const { h, r } = await rootless()
    const files = [{ name: 'notes.txt', mimetype: 'text/plain', size: 9 }]
    const { reply, acks } = await holdReply(h, { files })
    expect([acks.count, r.requests, accepted(h)]).toEqual([0, [], []])
    expect(h.h.routing.pendingCandidates().map(c => [c.key, c.channel, c.root])).toEqual([['alpha', C, ROOT]])
    // A duplicate delivery of the held reply adds no second candidate or lookup.
    await h.h.routing.receive(reply, () => { acks.count++ }, ['alpha'], false)
    const identity = h.h.p('alpha').stub.identity
    r.respond(() => rootReplies(ROOT, { user: identity.botUserId }, {}, [{ ts: '1700000000.000150', thread_ts: ROOT, user: 'U0HUMAN', text: 'history 9d2b' }]))
    await r.settle()
    expect(r.requests.map(q => [q.key, q.connectionId, q.method, q.args])).toEqual([['alpha', 'conn-alpha', 'conversations.replies', { channel: C, ts: ROOT, limit: 1, inclusive: true }]])
    expect([h.read(), acks.count, h.h.routing.pendingCandidates(), h.threads.rootLookups('alpha')]).toEqual(['followed', 1, [], []])
    expect(accepted(h).map(a => [a.ts, a.via, a.text, a.files])).toEqual([[reply.ts, 'thread', reply.text, files]])
    // Returned history is never queued or delivered, and recovery posts nothing.
    expect(JSON.stringify(readQueue(dir))).not.toContain('history 9d2b')
    expect([postCount(h), r.findings, r.recovered]).toEqual([0, [], []])
    expect(h.threads.ownPostFindings('alpha')).toEqual([expect.objectContaining({ kind: 'pending', missing: ['root'] })])
    expect((await h.receive(reply)).acknowledged).toBe(1)
    expect([accepted(h).length, h.read(ROOT, 'beta'), r.requests.length]).toEqual([1, 'unfollowed', 1])
    await h.close()
    const reopened = await open({ clock: h.clock })
    expect([reopened.read(), reopened.threads.rootLookups('alpha')]).toEqual(['followed', []])
  })

  test('a foreign root, even one naming the persona outside authorship, is remembered as not its own; known participation and the own post\'s evidence stay', async () => {
    const { h, r } = await rootless()
    await h.receive(h.mention({ ts: ROOT2, thread_ts: undefined }))
    const { acks } = await holdReply(h)
    const identity = h.h.p('alpha').stub.identity
    r.respond(() => rootReplies(ROOT, { user: 'U0HUMAN' }, { username: 'alpha', files: [{ id: 'F0ALPHA1', user: identity.botUserId }], reply_users: [identity.botUserId] }))
    await r.settle()
    expect([h.read(), h.read(ROOT2), acks.count]).toEqual(['unfollowed', 'followed', 1])
    expect(accepted(h).map(a => a.via)).toEqual(['mention'])
    expect([h.h.routing.pendingCandidates(), h.threads.rootLookupNeeded('alpha', C, ROOT)]).toEqual([[], false])
    expect(h.threads.ownPostFindings('alpha')).toEqual([expect.objectContaining({ kind: 'pending', missing: ['root'] })])
    // Later replies there are settled without another lookup; a direct mention still enrolls the thread.
    expect((await h.receive(threadReply({ ts: '1700000000.000102' }))).acknowledged).toBe(1)
    await r.settle()
    expect(r.requests).toHaveLength(1)
    expect((await h.receive(h.mention({ ts: '1700000000.000103', thread_ts: ROOT }))).acknowledged).toBe(1)
    expect(h.read()).toBe('followed')
    await h.close()
    const reopened = await open({ clock: h.clock })
    expect(reopened.read('1700000000.000300')).toBe('unresolved')
  })

  test('a positive root releases only its own thread; a hung lookup for another persona or thread delays no handler, ack or other recipient', async () => {
    const { h, r } = await rootless()
    await h.confirmPost({ channel: C }, 'beta', 'prompt').outcome
    const alphaHung = hungMetadata()
    const answer: MetadataResponder = q => q.key === 'alpha' && q.args.ts === ROOT2 ? alphaHung.respond(q) : rootReplies(String(q.args.ts), { user: h.h.p(q.key).stub.identity.botUserId })
    r.respond(answer, answer, answer)
    // One persona's lookups run one at a time, each bounded by the deadline; the hung one is alpha's last.
    const mine = await holdReply(h)
    const other = await holdReply(h, { thread_ts: ROOT2, ts: '1700000000.000201' })
    const betas = await holdReply(h, {}, 'beta')
    await r.settle('alpha'); await r.settle('beta')
    expect([mine.acks.count, betas.acks.count, other.acks.count]).toEqual([1, 1, 0])
    expect([h.read(), h.read(ROOT2), h.read(ROOT, 'beta')]).toEqual(['followed', 'unresolved', 'followed'])
    expect([r.attempts.inFlight('alpha'), r.attempts.inFlight('beta')]).toEqual([1, 0])
    // Independent work keeps flowing while the lookup hangs.
    expect((await h.receive(h.mention({ ts: '1700000000.000900', thread_ts: undefined }))).acknowledged).toBe(1)
    expect(accepted(h).map(a => [a.ts, a.via])).toEqual([[mine.reply.ts, 'thread'], ['1700000000.000900', 'mention']])
    expect(accepted(h, 'beta').map(a => [a.ts, a.via])).toEqual([[betas.reply.ts, 'thread']])
    expect([r.recovered, h.threads.ownPostFindings().length]).toEqual([[], 2])
  })

  test('a hung lookup ends at the deadline, its late answer changes nothing, retries keep the bounded spacing, and repair lands within the published bound with no new event', async () => {
    const { h, r } = await rootless()
    const reply = threadReply() as ReturnType<typeof threadReply> & { ts: string }, acks = { count: 0 }, ackedAt: number[] = []
    await h.h.routing.receive(reply, () => { acks.count++; ackedAt.push(h.clock.now()) }, ['alpha'], false)
    const first = hungMetadata(), second = hungMetadata()
    r.respond(first.respond, second.respond)
    await r.settle()
    const started = r.requests[0]!.at
    await h.clock.advanceTo(started + ENROLLMENT_METADATA_DEADLINE_MS - 1)
    expect([first.aborted, r.attempts.inFlight('alpha'), r.findings]).toEqual([[false], 1, []])
    await h.clock.advanceTo(started + ENROLLMENT_METADATA_DEADLINE_MS); await r.recovery.idle('alpha')
    const deadline = { cause: 'metadata', channel: C, root: ROOT, code: 'deadline' } as const
    expect([first.aborted, r.attempts.inFlight('alpha'), r.findings.map(f => f.finding)]).toEqual([[true], 0, [deadline]])
    first.settle(rootReplies(ROOT, { user: h.h.p('alpha').stub.identity.botUserId }))
    await h.clock.flush()
    expect([h.read(), acks.count, r.requests.length]).toEqual(['unresolved', 0, 1])
    const expired = h.clock.now()
    await h.clock.advanceTo(expired + ENROLLMENT_RETRY_MIN_MS - 1)
    expect(r.requests).toHaveLength(1)
    // The retry hangs too, so its pass is not awaited here.
    await h.clock.advanceTo(expired + metadataRetryDelay(1)); await new Promise(resolve => setImmediate(resolve))
    expect(r.requests.map(q => q.at - expired)).toEqual([started - expired, metadataRetryDelay(1)])
    // Slack is healthy from this attempt on; the hung attempt expires, and the next permitted one repairs.
    const healthy = r.requests[1]!.at
    r.respond(ownAnswer(h))
    await h.clock.advanceTo(healthy + ENROLLMENT_METADATA_DEADLINE_MS); await r.recovery.idle('alpha')
    second.fail(slackPlatformError('internal_error'))
    const again = h.clock.now()
    await h.clock.advanceTo(again + metadataRetryDelay(2) - 1)
    expect(r.requests).toHaveLength(2)
    await h.clock.advanceTo(again + metadataRetryDelay(2)); await r.settle()
    expect([h.read(), acks.count, r.requests.length]).toEqual(['followed', 1, 3])
    // The bound covers resolution and durability: the acknowledgement follows durable acceptance.
    expect(accepted(h).map(a => [a.ts, a.via])).toEqual([[reply.ts, 'thread']])
    expect(ackedAt[0]! - healthy).toBeLessThanOrEqual(enrollmentRepairBoundMs(ENROLLMENT_METADATA_DEADLINE_MS))
    // One deadline finding line however often it recurs; no recovery while the rootless post still waits.
    expect(recoveryLines(h)).toEqual([buildParticipationRecoveryLine(personaRef(), deadline)])
    expect([r.recovered, postCount(h)]).toEqual([[], 0])
  })

  test.each([['below', 1], ['above', ENROLLMENT_RETRY_MAX_MS / 1000 * 2]] as const)('Retry-After %s the local maximum: the next lookup waits the greater of it and the local spacing, whatever new evidence kicks recovery meanwhile', async (_where, retryAfter) => {
    const { h, r } = await rootless()
    const { acks } = await holdReply(h)
    r.respond(fails(slackRateLimited(retryAfter, LEAK_SENTINEL)))
    await r.settle()
    const failed = r.requests[0]!.at, wait = metadataRetryDelay(1, retryAfter)
    expect(wait).toBe(Math.max(ENROLLMENT_RETRY_MIN_MS, retryAfter * 1000))
    expect(r.findings.map(f => f.finding)).toEqual([{ cause: 'metadata', channel: C, root: ROOT, code: 'transient' }])
    assertNoLeak(r.findings)
    // A second held reply and a new pending own post each kick recovery inside the wait; neither cuts it short.
    await h.clock.advanceTo(failed + 1000)
    const other = await holdReply(h, { thread_ts: ROOT2, ts: '1700000000.000201' })
    expect(await h.confirmPost({ channel: C }).outcome).toMatchObject({ kind: 'pending', missing: ['root'] })
    r.recovery.kick('alpha')
    await h.clock.advanceTo(failed + wait - 1)
    expect(r.requests).toHaveLength(1)
    r.respond(ownAnswer(h), ownAnswer(h, ROOT2))
    await h.clock.advanceTo(failed + wait); await r.settle()
    expect(r.requests.map(q => [q.args.ts, q.at - failed])).toEqual([[ROOT, 0], [ROOT, wait], [ROOT2, wait]])
    expect([h.read(), acks.count, h.read(ROOT2), other.acks.count]).toEqual(['followed', 1, 'followed', 1])
  })

  test('a Retry-After longer than one timer holds the next lookup without firing early', async () => {
    const { h, r } = await rootless()
    await holdReply(h)
    const retryAfter = Math.ceil(ENROLLMENT_TIMER_MAX_MS / 1000) * 2
    r.respond(fails(slackRateLimited(retryAfter)))
    await r.settle()
    const failed = r.requests[0]!.at
    await h.clock.advanceTo(failed + retryAfter * 1000 - 1)
    expect(r.requests).toHaveLength(1)
    r.respond(ownAnswer(h))
    await h.clock.advanceTo(failed + retryAfter * 1000); await r.settle()
    expect([r.requests.length, h.read()]).toEqual([2, 'followed'])
  })

  test.each<[string, (root: string) => unknown, 'root-deleted' | 'access-lost']>([
    ['thread_not_found', () => { throw slackPlatformError('thread_not_found') }, 'root-deleted'],
    ['a tombstone root', root => rootReplies(root, { user: 'U0HUMAN' }, { subtype: 'tombstone' }), 'root-deleted'],
    ['channel_not_found', () => { throw slackPlatformError('channel_not_found') }, 'access-lost'],
  ])('%s is a reported gap: retried only after the next connection (lost access also after a new event of its channel), never discarded or recovered across deadlines and retention windows', async (_name, answer, cause) => {
    const { h, r } = await rootless()
    const held = await holdReply(h), other = await holdReply(h, { thread_ts: ROOT2, ts: '1700000000.000201' })
    const answers = (q: { args: Record<string, unknown> }) => answer(String(q.args.ts))
    r.respond(answers, answers)
    await r.settle()
    const gaps = [ROOT, ROOT2].map(root => ({ cause, channel: C, root }))
    expect(r.findings.map(f => f.finding)).toEqual(gaps)
    expect(recoveryLines(h)).toEqual(gaps.map(gap => buildParticipationRecoveryLine(personaRef(), gap)))
    expect(buildParticipationRecoveryLine(personaRef(), gaps[0]!)).toContain('state=gap')
    const asked = r.requests.length
    await h.clock.advance(Math.max(QUEUE_KEY_KEEP_MS, REPLY_REMINDER_KEEP_MS, 25 * HOUR_MS) + 1)
    await h.h.queue.compact()
    expect(r.requests).toHaveLength(asked)
    expect(h.threads.rootLookups('alpha').map(o => o.root).sort()).toEqual([ROOT, ROOT2])
    expect([h.read(), h.read(ROOT2), held.acks.count, other.acks.count, r.recovered]).toEqual(['unresolved', 'unresolved', 0, 0, []])
    // A fresh mention resolves only its own thread. As a new event of C it forgets C's lost-access gaps, so
    // ROOT2 is looked up once more (and answers the same gap); a deleted root is never looked up again.
    if (cause === 'access-lost') r.respond(answers)
    expect((await h.receive(h.mention({ ts: '1700000000.000900', thread_ts: ROOT }))).acknowledged).toBe(1)
    r.recovery.kick('alpha'); await r.settle()
    const again = cause === 'access-lost' ? [ROOT2] : []
    expect([r.requests.slice(asked).map(q => q.args.ts), h.read(), h.read(ROOT2), held.acks.count, other.acks.count]).toEqual([again, 'followed', 'unresolved', 1, 0])
    // A later kick asks nothing more.
    r.recovery.kick('alpha'); await r.settle()
    expect(r.requests.slice(asked).map(q => q.args.ts)).toEqual(again)
    const kicked = r.requests.length
    // A new connection forgets every gap: the lookups run again, and a gap answered again stays a gap.
    r.respond(answers, answers)
    r.recovery.connected('alpha'); await r.settle()
    // Exactly one new request per open gap; the root the mention resolved is not asked again.
    expect(r.requests.slice(kicked).map(q => q.args.ts)).toEqual([ROOT2])
    expect([held.acks.count, other.acks.count, h.read(ROOT2), r.recovered]).toEqual([1, 0, 'unresolved', []])
    expect(accepted(h).map(a => [a.ts, a.via])).toEqual([['1700000000.000900', 'mention'], [held.reply.ts, 'thread']])
    expect(accepted(h, 'beta')).toEqual([])
  })

  test('a parentless upload whose file is gone is a file gap until the next connection; its later share enrolls the root and recovery is reported once', async () => {
    const h = await open(), r = attachRecovery(h), F = 'F0UPLOAD1'
    const upload = await h.confirmPost({ channel: C, file: F }, 'alpha', 'file').outcome
    expect(upload).toMatchObject({ kind: 'pending', missing: ['root'], file: F })
    r.respond(fails(slackPlatformError('file_not_found')))
    await r.settle()
    const gap = { cause: 'file-unavailable', channel: C, file: F } as const
    expect(r.requests.map(q => [q.method, q.args])).toEqual([['files.info', { file: F }]])
    expect(r.findings.map(f => f.finding)).toEqual([gap])
    expect(recoveryLines(h)).toEqual([buildParticipationRecoveryLine(personaRef(), gap)])
    await h.clock.advance(25 * HOUR_MS)
    expect([r.requests.length, r.recovered]).toEqual([1, []])
    expect(h.threads.ownPostFindings('alpha')).toEqual([expect.objectContaining({ kind: 'pending', id: upload.id, file: F })])
    r.recovery.kick('alpha'); await r.settle()
    expect([r.requests.length, r.recovered]).toEqual([1, []])
    r.respond(() => fileInfo(F, C, [{ ts: ROOT }]))
    r.recovery.connected('alpha'); await r.settle()
    expect([h.read(), h.threads.ownPostFindings('alpha'), r.recovered]).toEqual(['followed', [], ['alpha']])
    expect(recoveredLines(h)).toHaveLength(1)
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(false)
    expect(postCount(h)).toBe(0)
  })

  test('an own root on a channel that became ineligible writes no decision: the held reply is discarded as routing does, the pass resolves and recovery is reported', async () => {
    const h = await open(), r = attachRecovery(h), F = 'F0UPLOAD2'
    const upload = await h.confirmPost({ channel: C, file: F }, 'alpha', 'file').outcome
    expect(upload).toMatchObject({ kind: 'pending', missing: ['root'], file: F })
    const held = await holdReply(h)
    expect(held.acks.count).toBe(0)
    h.membership.set(`alpha:${C}`, { kind: 'ineligible', reason: 'absent' })
    const identity = h.h.p('alpha').stub.identity
    const answer = (q: { method: string }) => q.method === 'conversations.replies'
      ? rootReplies(ROOT, { user: identity.botUserId }, { files: [{ id: F }] }) : fileInfo(F, C, [{ ts: ROOT }])
    r.respond(answer, answer)
    await r.settle()
    expect(r.requests.map(q => q.method)).toEqual(['conversations.replies', 'files.info'])
    // The lookup stays observed on disk: no not-own or cancelled record decides the thread.
    expect(h.h.queue.threadRecords('alpha').filter(x => x.observation.lookup).map(x => x.state)).toEqual(['observed'])
    expect([h.read(), held.acks.count, accepted(h), h.h.routing.pendingCandidates(), h.threads.rootLookups('alpha')]).toEqual(['unfollowed', 1, [], [], []])
    expect([h.threads.rootLookupNeeded('alpha', C, ROOT), h.threads.ownPostFindings('alpha'), r.findings]).toEqual([false, [], []])
    expect(r.recovered).toEqual(['alpha'])
    expect(postCount(h)).toBe(0)
  })

  /** A parentless upload of `file` waiting for its root, and one reply held for ROOT. */
  async function upload(file = 'F0UPLOAD3') {
    const h = await open(), r = attachRecovery(h)
    expect(await h.confirmPost({ channel: C, file }, 'alpha', 'file').outcome).toMatchObject({ kind: 'pending', missing: ['root'], file })
    return { h, r, file, held: await holdReply(h) }
  }

  test('an own root whose answer lists the parentless upload\'s file enrolls with that one request: the upload settles and recovery is reported once', async () => {
    const { h, r, held, file } = await upload()
    r.respond(() => rootReplies(ROOT, { user: h.h.p('alpha').stub.identity.botUserId }, { files: [{ id: file }] }))
    await r.settle()
    expect(r.requests.map(q => [q.method, q.args.ts])).toEqual([['conversations.replies', ROOT]])
    expect([h.read(), held.acks.count, h.threads.ownPostFindings('alpha'), r.findings, r.recovered]).toEqual(['followed', 1, [], [], ['alpha']])
    expect(accepted(h).map(a => [a.ts, a.via])).toEqual([[held.reply.ts, 'thread']])
    expect(recoveredLines(h)).toHaveLength(1)
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(false)
  })

  test('an own root sharing only another file matches no post of the lifetime: cancelled durably as outside it, one unfollowed line, the reply settled unfollowed', async () => {
    const { h, r, held, file } = await upload()
    const identity = h.h.p('alpha').stub.identity
    const answer: MetadataResponder = q => q.method === 'conversations.replies'
      ? rootReplies(ROOT, { user: identity.botUserId }, { files: [{ id: 'F0OTHER01' }] }) : fileInfo(file, C, [{ ts: ROOT2 }])
    r.respond(answer, answer)
    await r.settle()
    expect(r.requests.map(q => q.method)).toEqual(['conversations.replies', 'files.info'])
    const finding = { cause: 'root-outside-lifetime', channel: C, root: ROOT } as const
    expect(r.findings.map(f => f.finding)).toEqual([finding])
    // The decision is progress: with the upload enrolled, nothing is left and recovery is reported.
    const line = buildParticipationRecoveryLine(personaRef(), finding), lines = [line, buildParticipationRecoveredLine(personaRef())]
    expect([recoveryLines(h), r.recovered]).toEqual([lines, ['alpha']])
    expect(line).toContain(`state=unfollowed cause=root-outside-lifetime chat_id=${JSON.stringify(C)} root=${JSON.stringify(ROOT)}`)
    expect(h.h.queue.threadRecords('alpha').filter(x => x.observation.lookup).map(x => [x.state, x.observation.lookup?.reason])).toEqual([['cancelled', 'outside-lifetime']])
    // The upload's own share named another root, which it enrolled.
    expect([h.read(), held.acks.count, accepted(h), h.threads.rootLookups('alpha'), h.read(ROOT2)]).toEqual(['unfollowed', 1, [], [], 'followed'])
    r.recovery.kick('alpha'); await r.settle()
    expect([r.requests.length, recoveryLines(h)]).toEqual([2, lines])
  })

  test('an own root of the lifetime that no recorded post matches is unmatched: nothing is written, one line however often kicked, no second request, the reply held', async () => {
    const h = await open(), r = attachRecovery(h)
    const far = tsAt(T0 + 10 * 60_000)
    await h.clock.advance(HOUR_MS)
    expect(await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome).toMatchObject({ kind: 'pending', missing: ['root'] })
    const held = await holdReply(h, { thread_ts: far, ts: tsAt(h.clock.now()) })
    r.respond(ownAnswer(h, far))
    await r.settle()
    expect(r.requests.map(q => q.args.ts)).toEqual([far])
    const records = () => h.h.queue.threadRecords('alpha').map(x => [x.observation.id, x.state, x.observation.lookup?.reason])
    const written = records()
    expect(h.h.queue.threadRecords('alpha').filter(x => x.observation.lookup).map(x => x.state)).toEqual(['observed'])
    r.recovery.kick('alpha'); await r.settle()
    await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); r.recovery.kick('alpha'); await r.settle()
    const finding = { cause: 'root-unmatched', channel: C, root: far } as const
    expect([r.requests.length, records()]).toEqual([1, written])
    expect(r.findings.map(f => f.finding)).toEqual(r.findings.map(() => finding))
    expect(recoveryLines(h)).toEqual([buildParticipationRecoveryLine(personaRef(), finding)])
    expect([h.read(far), held.acks.count, accepted(h), r.recovered]).toEqual(['unresolved', 0, [], []])
  })

  test.each<[string, unknown, number | undefined]>([
    ['a server error', slackPlatformError('internal_error'), undefined],
    ['ratelimited', slackPlatformError('ratelimited'), undefined],
    ['a rate-limited rejection', slackRateLimited(1), 1],
    ['a transport error', Object.assign(new Error('socket hang up'), { code: 'slack_webapi_request_error' }), undefined],
  ])('%s halts the pass: one request, and a second held reply\'s root is asked only at the next permitted pass', async (_name, error, retryAfter) => {
    const { h, r } = await rootless()
    const mine = await holdReply(h), other = await holdReply(h, { thread_ts: ROOT2, ts: '1700000000.000201' })
    r.respond(fails(error))
    await r.settle()
    expect(r.requests.map(q => q.args.ts)).toEqual([ROOT])
    expect(r.findings.map(f => f.finding)).toEqual([{ cause: 'metadata', channel: C, root: ROOT, code: 'transient' }])
    const failed = r.requests[0]!.at, wait = metadataRetryDelay(1, retryAfter)
    await h.clock.advanceTo(failed + wait - 1)
    expect(r.requests).toHaveLength(1)
    r.respond(ownAnswer(h), ownAnswer(h, ROOT2))
    await h.clock.advanceTo(failed + wait); await r.settle()
    expect(r.requests.map(q => [q.args.ts, q.at - failed])).toEqual([[ROOT, 0], [ROOT, wait], [ROOT2, wait]])
    expect([mine.acks.count, other.acks.count]).toEqual([1, 1])
  })

  test('an expired deadline halts the pass too: the second held reply\'s root waits for the next permitted pass', async () => {
    const { h, r } = await rootless()
    const mine = await holdReply(h), other = await holdReply(h, { thread_ts: ROOT2, ts: '1700000000.000201' })
    const hung = hungMetadata()
    r.respond(hung.respond)
    await r.settle()
    const started = r.requests[0]!.at
    await h.clock.advanceTo(started + ENROLLMENT_METADATA_DEADLINE_MS); await r.recovery.idle('alpha')
    expect([r.requests.map(q => q.args.ts), r.findings.map(f => f.finding.code)]).toEqual([[ROOT], ['deadline']])
    const expired = h.clock.now()
    r.respond(ownAnswer(h), ownAnswer(h, ROOT2))
    await h.clock.advanceTo(expired + metadataRetryDelay(1) - 1)
    expect(r.requests).toHaveLength(1)
    await h.clock.advanceTo(expired + metadataRetryDelay(1)); await r.settle()
    expect(r.requests.map(q => [q.args.ts, q.at - expired])).toEqual([[ROOT, started - expired], [ROOT, metadataRetryDelay(1)], [ROOT2, metadataRetryDelay(1)]])
    expect([mine.acks.count, other.acks.count]).toEqual([1, 1])
  })

  test('a request Slack rejects for its own reason ends only that item: every root is asked in the same pass, each finding names its code, and each is retried at the spacing', async () => {
    const { h, r } = await rootless()
    const mine = await holdReply(h), other = await holdReply(h, { thread_ts: ROOT2, ts: '1700000000.000201' })
    r.respond(fails(slackPlatformError('something_new', undefined, LEAK_SENTINEL)), fails(slackHttpError(400)))
    await r.settle()
    const failed = r.requests[0]!.at
    expect(r.requests.map(q => [q.args.ts, q.at - failed])).toEqual([[ROOT, 0], [ROOT2, 0]])
    expect(r.findings.map(f => f.finding)).toEqual([
      { cause: 'metadata', channel: C, root: ROOT, code: 'something_new' }, { cause: 'metadata', channel: C, root: ROOT2, code: 'rejected' }])
    assertNoLeak([r.findings, h.h.logs])
    expect([h.read(), h.read(ROOT2), mine.acks.count, other.acks.count]).toEqual(['unresolved', 'unresolved', 0, 0])
    await h.clock.advanceTo(failed + metadataRetryDelay(1) - 1)
    expect(r.requests).toHaveLength(2)
    r.respond(ownAnswer(h), ownAnswer(h, ROOT2))
    await h.clock.advanceTo(failed + metadataRetryDelay(1)); await r.settle()
    expect(r.requests.slice(2).map(q => [q.args.ts, q.at - failed])).toEqual([[ROOT, metadataRetryDelay(1)], [ROOT2, metadataRetryDelay(1)]])
    expect([h.read(), h.read(ROOT2), mine.acks.count, other.acks.count]).toEqual(['followed', 'followed', 1, 1])
  })

  test('files.info refusing the upload\'s file is that file\'s gap with its code, not a capability outcome: no capability line or notice, the upload still pending', async () => {
    const h = await open(), r = attachRecovery(h), F = 'F0UPLOAD5'
    const post = await h.confirmPost({ channel: C, file: F }, 'alpha', 'file').outcome
    r.respond(fails(slackPlatformError('access_denied', undefined, LEAK_SENTINEL)))
    await r.settle()
    expect(r.requests.map(q => q.method)).toEqual(['files.info'])
    expect(r.findings.map(f => f.finding)).toEqual([{ cause: 'file-unavailable', channel: C, file: F, code: 'access_denied' }])
    await h.notices.flush()
    expect([capabilityLines(h), capabilityNotices(h), r.capability.gap('alpha')]).toEqual([[], [], undefined])
    expect(h.threads.ownPostFindings('alpha')).toEqual([expect.objectContaining({ kind: 'pending', id: post.id, file: F })])
    assertNoLeak([r.findings, h.h.logs])
  })

  test('an enrolled root\'s held reply is acknowledged only after durable acceptance: a failed accept leaves it unacknowledged and unrecovered until the spacing retries it', async () => {
    const h = await open(), r = attachRecovery(h), F = 'F0UPLOAD4'
    expect(await h.confirmPost({ channel: C, file: F }, 'alpha', 'file').outcome).toMatchObject({ kind: 'pending', missing: ['root'] })
    const reply = threadReply() as ReturnType<typeof threadReply> & { ts: string }, acceptedAtAck: number[] = []
    await h.h.routing.receive(reply, () => { acceptedAtAck.push(accepted(h).length) }, ['alpha'], false)
    h.disk.fail('write', 'accepted')
    r.respond(() => rootReplies(ROOT, { user: h.h.p('alpha').stub.identity.botUserId }, { files: [{ id: F }] }))
    await r.settle()
    expect(h.disk.failures).toContain('write')
    expect([h.read(), acceptedAtAck, accepted(h), r.recovered]).toEqual(['followed', [], [], []])
    h.disk.repair()
    await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle()
    expect(accepted(h).map(a => [a.ts, a.via])).toEqual([[reply.ts, 'thread']])
    expect([acceptedAtAck, r.recovered, recoveredLines(h).length, r.requests.length]).toEqual([[1], ['alpha'], 1, 1])
  })

  test('an issuer recovery cannot name is a reported metadata finding; Slack is asked nothing', async () => {
    const h = await open()
    const r = attachRecovery(h, { identities: { alpha: { ...h.h.p('alpha').stub.identity, botUserId: 'not a bot user' } } })
    expect(await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome).toMatchObject({ kind: 'pending', missing: ['root'] })
    const { acks } = await holdReply(h)
    await r.settle()
    expect(r.requests).toEqual([])
    expect(r.findings.map(f => f.finding)).toContainEqual({ cause: 'metadata', channel: C, root: ROOT, code: 'identity-unresolved' })
    expect([h.read(), acks.count, r.recovered]).toEqual(['unresolved', 0, []])
  })

  test('a lookup for a thread a mention followed first resolves as followed and writes no cancelled record', async () => {
    const h = await open()
    await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome
    const lookup = await h.threads.requestRootLookup('alpha', C, ROOT, issuerOf(h), STRICT_POLICY)
    expect((await h.receive(h.mention({ ts: '1700000000.000900', thread_ts: ROOT }))).acknowledged).toBe(1)
    expect(await h.threads.resolveRootLookup('alpha', lookup!.id, { kind: 'own', root: ROOT })).toEqual({ kind: 'followed' })
    expect(h.h.queue.threadRecords('alpha').filter(x => x.state === 'cancelled')).toEqual([])
    expect(h.read()).toBe('followed')
  })

  test.each<[string, 'strict' | 'open', 'off' | 'mentions']>([
    ['strict, delivery off', 'strict', 'off'], ['strict, mentions only', 'strict', 'mentions'], ['open, delivery off', 'open', 'off'],
  ])('%s chosen while the reply was held: the own root is still followed, and the reply is settled under the current choice, never delivered', async (_name, mode, delivery) => {
    const { h, r } = await rootless({ mode })
    const { acks } = await holdReply(h)
    await h.choose(delivery)
    r.respond(ownAnswer(h))
    await r.settle()
    expect([h.read(), acks.count, accepted(h), h.h.routing.pendingCandidates(), h.received]).toEqual(['followed', 1, [], [], []])
    expect(h.h.queue.threadRecords('alpha').filter(x => x.state === 'enrolled').map(x => x.observation.policy)).toContainEqual(expect.objectContaining({ mode, delivery }))
  })

  test('a persona down when kicked asks nothing; its next connection asks once, and a transient failure there is retried at the spacing and enrolls', async () => {
    const { h, r } = await rootless()
    r.down.add('alpha')
    const { acks } = await holdReply(h)
    r.recovery.kick('alpha'); await r.settle()
    expect(r.requests).toEqual([])
    r.down.clear()
    r.respond(fails(slackPlatformError('internal_error')))
    r.recovery.connected('alpha'); await r.settle()
    expect(r.requests).toHaveLength(1)
    const failed = r.requests[0]!.at
    r.respond(ownAnswer(h))
    await h.clock.advanceTo(failed + metadataRetryDelay(1)); await r.settle()
    expect([r.requests.map(q => q.at - failed), h.read(), acks.count]).toEqual([[0, metadataRetryDelay(1)], 'followed', 1])
  })

  test('known m4 limit (per-type gating deferred): a missing channel history scope (here groups:history) holds every channel reply that needs a lookup, even in a public channel; the persona stays up with one line and one notice, and the next connection with the scope resumes lookups', async () => {
    const scopes: Record<string, readonly string[] | undefined> = { alpha: [PUBLIC_HISTORY_SCOPE, DM_HISTORY_SCOPE] }
    const { h, r } = await rootless({}, { scopes })
    await h.confirmPost({ channel: C }, 'beta', 'prompt').outcome
    r.capability.connected('alpha'); r.capability.connected('alpha'); r.capability.connected('beta')
    const gap = { kind: 'missing-scope' as const, scopes: [PRIVATE_HISTORY_SCOPE] }
    await h.notices.flush()
    expect(capabilityLines(h)).toEqual([buildRootLookupCapabilityLine(personaRef(), gap)])
    expect(capabilityNotices(h).map(p => p.text)).toEqual([formatPersonaNotice(h.notices.config.personas[0]!, buildRootLookupCapabilityNotice(personaRef(), gap))])
    expect([h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_ROOT_LOOKUP_CAPABILITY), capabilityNotices(h, 'beta')]).toEqual([true, []])
    r.respond(q => rootReplies(ROOT, { user: h.h.p(q.key).stub.identity.botUserId }))
    const alpha = await holdReply(h), beta = await holdReply(h, {}, 'beta')
    await r.settle('alpha'); await r.settle('beta')
    expect(r.requests.map(q => q.key)).toEqual(['beta'])
    expect([alpha.acks.count, beta.acks.count, h.read(), h.read(ROOT, 'beta')]).toEqual([0, 1, 'unresolved', 'followed'])
    expect(h.h.p('alpha').stub.calls.postMessage).toEqual([])
    expect((await h.receive(h.mention({ ts: '1700000000.000900', thread_ts: undefined }))).acknowledged).toBe(1)
    scopes.alpha = requiredHistoryScopes(h.h.config!.personas.find(p => p.key === 'alpha'))
    r.capability.connected('alpha')
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_ROOT_LOOKUP_CAPABILITY)).toBe(false)
    r.respond(ownAnswer(h))
    // As server.ts does when the persona's connection comes up.
    r.recovery.connected('alpha'); await r.settle()
    expect([h.read(), alpha.acks.count, r.capability.state('alpha')]).toEqual(['followed', 1, 'verified'])
    await h.notices.flush()
    expect([capabilityLines(h).length, capabilityNotices(h).length]).toEqual([1, 1])
    expect(accepted(h).map(a => [a.ts, a.via])).toEqual([['1700000000.000900', 'mention'], [alpha.reply.ts, 'thread']])
    expect(accepted(h, 'beta').map(a => [a.ts, a.via])).toEqual([[beta.reply.ts, 'thread']])
  })

  test('a missing im:history alone holds no channel reply: the lookups run and the own root enrolls, while the gap and its episode stay open with one line and one notice and no scope is re-read', async () => {
    const { h, r } = await rootless({}, { scopes: { alpha: [PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE] }, refreshScopes: () => undefined })
    expect(h.h.config!.personas.find(p => p.key === 'alpha')!.dm.enabled).toBe(true)
    r.capability.connected('alpha'); r.capability.connected('alpha')
    const gap = { kind: 'missing-scope' as const, scopes: [DM_HISTORY_SCOPE] }
    await h.notices.flush()
    expect([r.capability.gap('alpha'), r.capability.usable('alpha')]).toEqual([gap, true])
    expect(capabilityLines(h)).toEqual([buildRootLookupCapabilityLine(personaRef(), gap)])
    expect(capabilityNotices(h).map(p => p.text)).toEqual([formatPersonaNotice(h.notices.config.personas[0]!, buildRootLookupCapabilityNotice(personaRef(), gap))])
    r.respond(ownAnswer(h))
    const mine = await holdReply(h)
    await r.settle()
    expect([r.requests.length, h.read(), mine.acks.count]).toEqual([1, 'followed', 1])
    expect(accepted(h).map(a => [a.ts, a.via])).toEqual([[mine.reply.ts, 'thread']])
    // A successful channel lookup proves nothing about the still-missing im:history.
    expect([r.capability.gap('alpha'), h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_ROOT_LOOKUP_CAPABILITY)]).toEqual([gap, true])
    r.respond(() => rootReplies(ROOT2, { user: 'U0HUMAN' }))
    const other = await holdReply(h, { thread_ts: ROOT2, ts: '1700000000.000201' })
    await r.settle()
    for (let i = 0; i < 3; i++) { await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle() }
    expect([r.requests.map(q => q.args.ts), r.refreshes, other.acks.count, h.read(ROOT2), r.capability.gap('alpha')]).toEqual([[ROOT, ROOT2], [], 1, 'unfollowed', gap])
    await h.notices.flush()
    expect([capabilityLines(h).length, capabilityNotices(h).length]).toEqual([1, 1])
  })

  describe('a channel refusal while only im:history is missing', () => {
    const IM_GAP: RootLookupCapabilityGap = { kind: 'missing-scope', scopes: [DM_HISTORY_SCOPE] }
    const REFUSED_GAP: RootLookupCapabilityGap = { kind: 'method-refused', method: 'conversations.replies', slackError: 'not_allowed_token_type' }
    /** alpha (DMs enabled) lacks only im:history, and its held reply's first lookup is refused; returns the refusal's time. */
    async function refusedUnderImGap(scopes: Record<string, readonly string[] | undefined>) {
      const { h, r } = await rootless({}, { scopes, refreshScopes: () => undefined })
      expect(h.h.config!.personas.find(p => p.key === 'alpha')!.dm.enabled).toBe(true)
      r.capability.connected('alpha')
      expect(r.capability.gap('alpha')).toEqual(IM_GAP)
      const held = await holdReply(h)
      r.respond(fails(slackPlatformError('not_allowed_token_type')))
      await r.settle()
      expect([r.requests.map(q => q.args.ts), r.capability.gap('alpha'), held.acks.count, h.read()]).toEqual([[ROOT], REFUSED_GAP, 0, 'unresolved'])
      return { h, r, held, refusedAt: r.requests[0]!.at }
    }

    test('the re-check lookup succeeding returns to the im:history gap in the same episode: one notice, a third line, no clearing; the held reply resolves and a later connection adds no notice', async () => {
      const { h, r, held, refusedAt } = await refusedUnderImGap({ alpha: [PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE] })
      r.respond(ownAnswer(h))
      await h.clock.advanceTo(refusedAt + ENROLLMENT_RETRY_MAX_MS); await r.settle()
      expect(r.requests.map(q => q.at - refusedAt)).toEqual([0, ENROLLMENT_RETRY_MAX_MS])
      expect([r.capability.gap('alpha'), r.capability.state('alpha'), h.read(), held.acks.count, r.refreshes]).toEqual([IM_GAP, 'missing', 'followed', 1, []])
      expect(accepted(h).map(a => [a.ts, a.via])).toEqual([[held.reply.ts, 'thread']])
      await h.notices.flush()
      const lines = [IM_GAP, REFUSED_GAP, IM_GAP].map(gap => buildRootLookupCapabilityLine(personaRef(), gap))
      const notice = formatPersonaNotice(h.notices.config.personas[0]!, buildRootLookupCapabilityNotice(personaRef(), IM_GAP))
      expect([capabilityLines(h), capabilityNotices(h).map(p => p.text)]).toEqual([lines, [notice]])
      expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_ROOT_LOOKUP_CAPABILITY)).toBe(true)
      // As server.ts does when the persona's connection comes up again.
      r.capability.connected('alpha'); r.recovery.connected('alpha'); await r.settle()
      await h.notices.flush()
      expect([capabilityLines(h), capabilityNotices(h).length, r.capability.gap('alpha'), r.requests.length]).toEqual([lines, 1, IM_GAP, 2])
      expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_ROOT_LOOKUP_CAPABILITY)).toBe(true)
    })

    test('a reconnect still lacking only im:history keeps the refusal: no line, the lookup stays held, and no request before the re-check spacing', async () => {
      const { h, r, held, refusedAt } = await refusedUnderImGap({ alpha: [PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE] })
      await h.notices.flush()
      const lines = [IM_GAP, REFUSED_GAP].map(gap => buildRootLookupCapabilityLine(personaRef(), gap))
      expect(capabilityLines(h)).toEqual(lines)
      // As server.ts does when the persona's connection comes up again.
      r.capability.connected('alpha'); r.recovery.connected('alpha'); await r.settle()
      await h.clock.advanceTo(refusedAt + ENROLLMENT_RETRY_MAX_MS - 1); await r.recovery.idle('alpha')
      await h.notices.flush()
      expect([r.capability.gap('alpha'), r.requests.length, held.acks.count, h.read(), h.threads.rootLookupNeeded('alpha', C, ROOT)]).toEqual([REFUSED_GAP, 1, 0, 'unresolved', true])
      expect([capabilityLines(h), capabilityNotices(h).length, r.refreshes]).toEqual([lines, 1, []])
    })
  })

  test.each<[string, string, 'capability' | 'credentials']>([
    ['a scope refusal', 'missing_scope', 'capability'],
    ['a token-type refusal', 'not_allowed_token_type', 'capability'],
    ['refused credentials', 'token_revoked', 'credentials'],
  ])('%s of the first real lookup is a capability outcome: the reply waits, never as a deleted root, foreign author or recovery', async (_name, code, kind) => {
    const { h, r } = await rootless()
    const { acks } = await holdReply(h)
    r.respond(fails(slackPlatformError(code, undefined, LEAK_SENTINEL)))
    await r.settle()
    expect([h.read(), acks.count, h.threads.rootLookups('alpha').length, r.recovered, h.threads.rootLookupNeeded('alpha', C, ROOT)]).toEqual(['unresolved', 0, 1, [], true])
    expect([accepted(h), accepted(h, 'beta')]).toEqual([[], []])
    assertNoLeak([r.findings, r.capability.gap('alpha'), h.h.logs])
    expect(r.findings.map(f => f.finding.cause)).not.toContain('root-deleted')
    if (kind === 'capability') {
      const gap = { kind: 'method-refused', method: 'conversations.replies', slackError: code } as const
      expect([r.capability.gap('alpha'), r.findings]).toEqual([gap, []])
      await h.notices.flush()
      expect(capabilityLines(h)).toEqual([buildRootLookupCapabilityLine(personaRef(), gap)])
      expect(capabilityNotices(h)).toHaveLength(1)
    } else expect(r.findings.map(f => f.finding)).toEqual([{ cause: 'capability', channel: C, root: ROOT, code }])
    // A later successful lookup settles it (refused credentials at the backoff; a refused method at its re-check, a full spacing later) and clears a method refusal.
    r.respond(ownAnswer(h))
    await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle()
    expect([h.read(), acks.count, r.capability.gap('alpha')]).toEqual(['followed', 1, undefined])
    await h.notices.flush()
    assertNoLeak([h.h.logs, h.notices.h.allPosts()])
  })

  test('revocation aborts the persona\'s in-flight lookup and drops its late answer; the durable obligation stays and the next kick resolves it', async () => {
    const { h, r } = await rootless()
    const { acks } = await holdReply(h)
    const hung = hungMetadata()
    r.respond(hung.respond)
    await r.settle()
    expect(r.attempts.inFlight('alpha')).toBe(1)
    r.recovery.revoke('alpha'); await h.clock.flush()
    expect([hung.aborted, r.attempts.inFlight('alpha')]).toEqual([[true], 0])
    hung.settle(rootReplies(ROOT, { user: h.h.p('alpha').stub.identity.botUserId }))
    await h.clock.advance(ENROLLMENT_RETRY_MAX_MS * 2); await r.settle()
    expect([h.read(), acks.count, r.requests.length, r.findings]).toEqual(['unresolved', 0, 1, []])
    expect(h.threads.rootLookups('alpha')).toHaveLength(1)
    r.respond(ownAnswer(h))
    r.recovery.kick('alpha'); await r.settle()
    expect([h.read(), acks.count, r.requests.length]).toEqual(['followed', 1, 2])
  })

  test.each(['not current', 'not up'] as const)('a connection %s during the lookup cancels it with no effect; the next connection resumes', async state => {
    const { h, r } = await rootless()
    const { acks } = await holdReply(h)
    const hung = hungMetadata()
    r.respond(hung.respond)
    await r.settle()
    ;(state === 'not current' ? r.stale : r.down).add('alpha')
    hung.settle(rootReplies(ROOT, { user: h.h.p('alpha').stub.identity.botUserId }))
    await r.settle()
    expect([h.read(), acks.count, r.findings]).toEqual(['unresolved', 0, []])
    r.stale.clear(); r.down.clear()
    r.respond(ownAnswer(h))
    // As server.ts does when the persona's connection comes up.
    r.recovery.connected('alpha'); await r.settle()
    expect([h.read(), acks.count]).toEqual(['followed', 1])
  })

  test('shutdown stops recovery and keeps the durable obligation; after reopen the redelivered reply is held again before intake and recovers', async () => {
    const { h, r } = await rootless()
    const { reply } = await holdReply(h)
    const hung = hungMetadata()
    r.respond(hung.respond)
    await r.settle()
    await h.close()
    expect(hung.aborted).toEqual([true])
    r.recovery.kick('alpha')
    await h.clock.advance(ENROLLMENT_RETRY_MAX_MS)
    expect(r.requests).toHaveLength(1)
    const reopened = await open({ clock: h.clock })
    expect(reopened.threads.rootLookups('alpha').map(o => o.root)).toEqual([ROOT])
    // The restarted process authenticates as the same bot.
    const identity = h.h.p('alpha').stub.identity
    const again = attachRecovery(reopened, { identities: { alpha: identity } })
    let acks = 0
    await reopened.h.routing.receive(reply, () => { acks++ }, ['alpha'], false)
    expect([acks, accepted(reopened)]).toEqual([0, []])
    again.respond(() => rootReplies(ROOT, { user: identity.botUserId }))
    // As server.ts does at startup: one kick per queue key.
    for (const key of reopened.h.queue.keys()) again.recovery.kick(key)
    await again.settle()
    expect(again.requests.map(q => [q.connectionId, q.args.ts])).toEqual([['conn-alpha', ROOT]])
    expect([reopened.read(), acks, accepted(reopened).map(a => a.via), postCount(reopened)]).toEqual(['followed', 1, ['thread'], 0])
  })

  test('in open mode an own root lacking only channel sharing is settled by one authenticated conversations.info', async () => {
    const { h, r } = await rootless({ mode: 'open' })
    const { acks } = await holdReply(h)
    // Sharing becomes unknown after the reply was held for its root lookup.
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: ELIGIBILITY_MISSING })
    r.respond(ownAnswer(h), () => channelInfo(C))
    await r.settle()
    expect(r.requests.map(q => [q.method, q.args])).toEqual([['conversations.replies', { channel: C, ts: ROOT, limit: 1, inclusive: true }], ['conversations.info', { channel: C }]])
    // The thread is followed; delivering the reply still waits for membership, which stays its own authority.
    expect([h.read(), acks.count, accepted(h)]).toEqual(['followed', 0, []])
    expect(h.membership.get(`alpha:${C}`)).toEqual({ kind: 'unresolved', reason: ELIGIBILITY_MISSING })
  })

  test.each<[string, Record<string, unknown>, 'followed' | 'unfollowed' | 'unresolved', string | undefined]>([
    ['explicit is_ext_shared false', {}, 'followed', undefined],
    ['explicit is_ext_shared true', { is_ext_shared: true }, 'unfollowed', undefined],
    ['no is_ext_shared', { is_ext_shared: undefined }, 'unresolved', 'malformed'],
    ['another channel\'s answer', { id: C2 }, 'unresolved', 'mismatch'],
  ])('open mode: an own post lacking only channel sharing, with %s from conversations.info', async (_name, fields, reading, code) => {
    const h = await open({ mode: 'open' }), r = attachRecovery(h)
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: ELIGIBILITY_MISSING })
    const post = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    expect(post).toMatchObject({ kind: 'pending', reason: ELIGIBILITY_MISSING, missing: ['channel-eligibility'] })
    r.respond(() => channelInfo(C, fields))
    await r.settle()
    expect(r.requests.map(q => [q.method, q.args])).toEqual([['conversations.info', { channel: C }]])
    expect(h.read()).toBe(reading)
    expect(r.findings.map(f => f.finding)).toEqual(code ? [{ cause: 'metadata', channel: C, code }] : [])
    expect(h.threads.ownPostFindings('alpha')).toHaveLength(reading === 'unresolved' ? 1 : 0)
  })

  test('channel evidence answered after a reset superseded the post authorizes nothing in the new lifetime', async () => {
    const h = await open({ mode: 'open' }), r = attachRecovery(h)
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: ELIGIBILITY_MISSING })
    const post = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    const hung = hungMetadata()
    r.respond(hung.respond)
    await r.settle()
    const a = h.authority
    expect(a.transact(a.revision, (next, order) => { next.personas.alpha!.resetOrder = order })).toMatchObject({ kind: 'applied' })
    hung.settle(channelInfo(C))
    await r.settle()
    expect([h.read(), h.threads.ownPostFindings(), r.findings]).toEqual(['unfollowed', [], []])
    expect(h.h.queue.threadRecord('alpha', post.id!)?.state).toBe('observed')
  })

  test('a lifetime superseded while recovery\'s retry cancels an ineligible post makes it superseded: no finding line and no notice', async () => {
    const h = await open(), r = attachRecovery(h)
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: 'history-unresolved' })
    const pending = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    await h.notices.flush()
    const lines = h.h.logs.length, notices = h.notices.h.totalPosts()
    h.membership.set(`alpha:${C}`, { kind: 'ineligible', reason: 'absent' })
    const a = h.authority
    h.h.queue.cancelThreadObservation = async () => {
      expect(a.transact(a.revision, (next, order) => { next.personas.alpha!.resetOrder = order })).toMatchObject({ kind: 'applied' })
      throw new Error('injected cancel failure')
    }
    await r.settle()
    expect(h.h.ownPostOutcomes.at(-1)).toMatchObject({ kind: 'superseded', id: pending.id })
    await h.notices.flush()
    // No finding line and no notice; idle recovery then reports the earlier finding's episode recovered with its one line.
    expect([h.h.logs.slice(lines), h.notices.h.totalPosts() - notices, r.findings, h.threads.ownPostFindings()]).toEqual([[buildParticipationRecoveredLine(personaRef())], 0, [], []])
  })

  test('a storage gap closes in process once idle recovery saves it: the finding, episode and cap end with one recovered line and nothing is reposted', async () => {
    const h = await open(), r = attachRecovery(h)
    h.disk.fail('write', 'thread-participation')
    const gap = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    expect(gap).toMatchObject({ kind: 'gap', reason: 'storage' })
    expect(ownPostFindingCause(gap)).toBe('storage')
    await h.notices.flush()
    expect(h.h.logs.filter(l => l.includes(OWN_POST_NOT_ENROLLED))).toEqual([buildOwnPostNotEnrolledLine(personaRef(), gap)])
    expect(buildOwnPostNotEnrolledLine(personaRef(), gap)).toContain('cause=storage')
    // A first pass fails while the disk is still broken; its finding is storage and nothing recovers.
    await h.clock.advance(1); await r.recovery.idle('alpha')
    expect(r.findings[0]).toEqual({ key: 'alpha', finding: { cause: 'storage', channel: C } })
    expect([h.read(), r.recovered, h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)]).toEqual(['unresolved', [], true])
    h.disk.repair()
    await r.settle()
    await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle()
    expect([h.read(), h.threads.ownPostFindings('alpha'), r.recovered]).toEqual(['followed', [], ['alpha']])
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(false)
    expect(recoveredLines(h)).toHaveLength(1)
    await h.notices.flush()
    expect([h.notices.h.totalPosts(), postCount(h)]).toEqual([1, 0])
  })

  test('while storage stays broken, idle recovery retries an own-post storage gap at the bounded spacing, never in a hot loop, and logs one finding', async () => {
    const h = await open(), r = attachRecovery(h)
    h.disk.fail('write', 'thread-participation')
    expect(await h.confirmPost({ channel: C, ts: ROOT }).outcome).toMatchObject({ kind: 'gap', reason: 'storage' })
    await h.clock.advance(1); await r.recovery.idle('alpha')
    const firstPass = h.disk.failures.length
    expect(r.findings.map(f => f.finding)).toEqual([{ cause: 'storage', channel: C }])
    // The retry's own pending outcome, and outside kicks, are new evidence only in name: none starts the next pass early.
    const half = Math.floor(metadataRetryDelay(1) / 2)
    await h.clock.advance(half); r.recovery.kick('alpha'); await r.recovery.idle('alpha')
    await h.clock.advance(metadataRetryDelay(1) - half - 1); r.recovery.kick('alpha'); await r.recovery.idle('alpha')
    expect([h.disk.failures.length, r.findings.length]).toEqual([firstPass, 1])
    await h.clock.advance(1); await r.recovery.idle('alpha')
    const secondPass = h.disk.failures.length
    expect(secondPass).toBeGreaterThan(firstPass)
    // The next spacing grows by the failure tally, kicks or not.
    await h.clock.advance(metadataRetryDelay(2) - 1); r.recovery.kick('alpha'); await r.recovery.idle('alpha')
    expect(h.disk.failures.length).toBe(secondPass)
    await h.clock.advance(1); await r.recovery.idle('alpha')
    expect(h.disk.failures.length).toBeGreaterThan(secondPass)
    expect(recoveryLines(h)).toEqual([buildParticipationRecoveryLine(personaRef(), { cause: 'storage', channel: C })])
    expect([h.read(), r.recovered]).toEqual(['unresolved', []])
  })

  test('an own-post episode settled outside recovery is followed by one recovered line through one kick, never in the settling turn, with no other activity', async () => {
    const h = await open(), r = attachRecovery(h), passes = countPasses(h)
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: 'history-unresolved' })
    const pending = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    expect(pending).toMatchObject({ kind: 'pending' })
    await r.settle()
    // Recovery's own retry still reads eligibility unresolved: its next pass is the spacing away.
    expect([passes.count, h.owed, r.recovered]).toEqual([1, [], []])
    h.membership.delete(`alpha:${C}`)
    const settledAt = h.clock.now()
    expect(await h.threads.retryOwnPost('alpha', pending.id!)).toMatchObject({ kind: 'enrolled' })
    expect([h.owed, passes.count, recoveredLines(h)]).toEqual([[{ key: 'alpha', id: pending.id }], 1, []])
    expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_OWN_POST_NOT_ENROLLED)).toBe(false)
    await r.settle()
    expect([passes.count, recoveredLines(h).length, r.recovered, r.requests]).toEqual([2, 1, ['alpha'], []])
    expect(h.clock.now() - settledAt).toBeLessThan(metadataRetryDelay(1))
    await h.clock.advance(ENROLLMENT_RETRY_MAX_MS * 2); await r.settle()
    expect([passes.count, recoveredLines(h).length]).toEqual([2, 1])
  })

  test('a kick for a settled own-post episode does not cut the persona\'s notBefore short: its pass waits for the next permitted one', async () => {
    const h = await open(), r = attachRecovery(h), passes = countPasses(h)
    h.disk.fail('write', 'thread-participation')
    const gap = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    expect(gap).toMatchObject({ kind: 'gap', reason: 'storage' })
    // The first pass fails while the disk is broken, which holds every later pass back by the spacing.
    await h.clock.advance(1); await r.recovery.idle('alpha')
    const failedAt = h.clock.now()
    expect([passes.count, r.findings.map(f => f.finding)]).toEqual([1, [{ cause: 'storage', channel: C }]])
    h.disk.repair()
    expect(await h.threads.retryOwnPost('alpha', gap.id!)).toMatchObject({ kind: 'enrolled' })
    expect(h.owed).toEqual([{ key: 'alpha', id: gap.id }])
    await h.clock.advanceTo(failedAt + metadataRetryDelay(1) - 1); await r.recovery.idle('alpha')
    expect([passes.count, recoveredLines(h)]).toEqual([1, []])
    await h.clock.advanceTo(failedAt + metadataRetryDelay(1)); await r.settle()
    expect([passes.count, recoveredLines(h).length, h.read()]).toEqual([2, 1, 'followed'])
  })

  test('a settling outcome of recovery\'s own pass does not kick it again; a later settled duplicate asks for nothing; nothing reported asks for no pass', async () => {
    const h = await open(), r = attachRecovery(h), passes = countPasses(h)
    // Nothing reported: a settled outcome asks for no pass.
    expect(await h.confirmPost({ channel: C2, ts: ROOT2 }).outcome).toMatchObject({ kind: 'enrolled' })
    await r.settle()
    expect([h.owed, passes.count]).toEqual([[], 0])
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: 'history-unresolved' })
    const pending = await h.confirmPost({ channel: C, ts: ROOT }).outcome
    expect(pending).toMatchObject({ kind: 'pending' })
    // Eligibility resolves before the kicked pass, whose own retry then settles the post and ends the episode.
    h.membership.delete(`alpha:${C}`)
    await r.settle()
    expect([h.owed, passes.count, recoveredLines(h).length, h.read()]).toEqual([[{ key: 'alpha', id: pending.id }], 1, 1, 'followed'])
    const duplicate = await h.confirmPost({ channel: C, ts: '1700000000.000102', parent: ROOT }).outcome
    expect(duplicate).toMatchObject({ kind: 'enrolled', duplicate: true })
    await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle()
    expect([h.owed.length, passes.count, recoveredLines(h).length]).toEqual([1, 1, 1])
  })

  test('a reply post under an unresolved parent is no rootless post: an unmentioned reply to an unfollowed thread there is discarded once, with no lookup and no timer; the post\'s finding stays', async () => {
    const h = await open(), r = attachRecovery(h)
    const post = await h.confirmPost({ channel: C, ts: '1700000000.000900', parent: 'not-a-thread' }).outcome
    expect(post).toMatchObject({ kind: 'pending', missing: ['root'] })
    expect([h.read(), h.threads.rootLookupNeeded('alpha', C, ROOT)]).toEqual(['unfollowed', false])
    const { acks } = await holdReply(h)
    await r.settle()
    expect([h.read(), acks.count, accepted(h), h.h.routing.pendingCandidates(), r.requests, h.threads.rootLookups('alpha')]).toEqual(['unfollowed', 1, [], [], [], []])
    await h.clock.advance(ENROLLMENT_RETRY_MAX_MS * 2); await r.settle()
    expect([acks.count, r.requests.length, h.clock.pendingCount()]).toEqual([1, 0, 0])
    expect(h.threads.ownPostFindings('alpha')).toEqual([expect.objectContaining({ kind: 'pending', id: post.id, missing: ['root'] })])
  })

  test('routing tells recovery of each new event of a channel, never of a retained duplicate or a held reply\'s redelivery', async () => {
    const events: Array<[string, string]> = []
    const h = await open({ routing: { routingHooks: { onChannelEvent: (key, channel) => { events.push([key, channel]) } } } })
    attachRecovery(h)
    await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome
    const { reply } = await holdReply(h)
    expect(events).toEqual([['alpha', C]])
    await h.h.routing.receive(reply, () => {}, ['alpha'], false)
    expect(events).toEqual([['alpha', C]])
    const mention = h.mention({ ts: '1700000000.000900', thread_ts: undefined })
    expect((await h.receive(mention)).acknowledged).toBe(1)
    expect((await h.receive(mention)).acknowledged).toBe(1)
    expect((await h.receive(h.mention({ channel: C2, ts: '1700000000.000901', thread_ts: undefined }))).acknowledged).toBe(1)
    expect(events).toEqual([['alpha', C], ['alpha', C], ['alpha', C2]])
  })

  test('a new event of a channel forgets only that channel\'s lost-access gaps, of root lookups and file shares: one new request each; another channel or persona asks nothing', async () => {
    const { h, r } = await rootless()
    const F = 'F0UPLOAD7'
    await h.confirmPost({ channel: C, file: F }, 'alpha', 'file').outcome
    await holdReply(h)
    const lost = fails(slackPlatformError('channel_not_found'))
    r.respond(lost, lost)
    await r.settle()
    expect(r.requests.map(q => q.method)).toEqual(['conversations.replies', 'files.info'])
    expect(r.findings.map(f => f.finding)).toEqual([{ cause: 'access-lost', channel: C, root: ROOT }, { cause: 'access-lost', channel: C, file: F }])
    // A gap found less than ENROLLMENT_RETRY_MIN_MS before an event is released only then; these gaps are older.
    await h.clock.advance(ENROLLMENT_RETRY_MIN_MS); await r.settle()
    for (const [key, channel] of [['alpha', C2], ['beta', C]] as const) { r.recovery.channelEvent(key, channel); await r.settle(); await r.settle(key) }
    r.recovery.kick('alpha'); await r.settle()
    expect(r.requests).toHaveLength(2)
    r.respond(lost, lost)
    const eventAt = h.clock.now()
    r.recovery.channelEvent('alpha', C); await r.settle()
    // A gap older than ENROLLMENT_RETRY_MIN_MS is looked up at once.
    expect(r.requests.slice(2).map(q => [q.method, q.at - eventAt < ENROLLMENT_RETRY_MIN_MS])).toEqual([['conversations.replies', true], ['files.info', true]])
    expect(r.recovered).toEqual([])
  })

  test('new events right after a lost-access gap release it only ENROLLMENT_RETRY_MIN_MS after it was found, with one request each however many arrive', async () => {
    const { h, r } = await rootless()
    const F = 'F0UPLOAD9'
    await h.confirmPost({ channel: C, file: F }, 'alpha', 'file').outcome
    const { acks } = await holdReply(h)
    const lost = fails(slackPlatformError('channel_not_found'))
    r.respond(lost, lost)
    await r.settle()
    expect(r.requests.map(q => q.method)).toEqual(['conversations.replies', 'files.info'])
    const foundAt = r.requests[0]!.at
    expect(r.requests[1]!.at).toBe(foundAt)
    for (let i = 0; i < 5; i++) { r.recovery.channelEvent('alpha', C); await r.settle() }
    await h.clock.advanceTo(foundAt + ENROLLMENT_RETRY_MIN_MS / 2)
    r.recovery.channelEvent('alpha', C)
    await h.clock.advanceTo(foundAt + ENROLLMENT_RETRY_MIN_MS - 1); await r.recovery.idle('alpha')
    expect(r.requests).toHaveLength(2)
    r.respond(() => rootReplies(ROOT, { user: 'U0HUMAN01' }), () => fileInfo(F, C, [{ ts: ROOT2 }]))
    await h.clock.advanceTo(foundAt + ENROLLMENT_RETRY_MIN_MS); await r.settle()
    expect(r.requests.slice(2).map(q => [q.method, q.at - foundAt])).toEqual([['conversations.replies', ENROLLMENT_RETRY_MIN_MS], ['files.info', ENROLLMENT_RETRY_MIN_MS]])
    expect([h.read(), h.read(ROOT2), acks.count]).toEqual(['unfollowed', 'followed', 1])
    // Settled: later events ask nothing more.
    r.recovery.channelEvent('alpha', C); await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle()
    expect(r.requests).toHaveLength(4)
  })

  test.each<[string, 'strict' | 'open', MembershipFault]>([
    ['strict mode missing eligibility', 'strict', ELIGIBILITY_MISSING],
    ['strict mode without current membership', 'strict', 'current-membership-missing'],
    ['open mode without current membership', 'open', 'current-membership-missing'],
  ])('an own root pending on %s waits on membership with no channel lookup; the cached verdict enrolls once membership resolves, with no second request', async (_name, mode, reason) => {
    const { h, r } = await rootless({ mode })
    const { acks } = await holdReply(h)
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason })
    r.respond(ownAnswer(h))
    await r.settle()
    expect(r.requests.map(q => q.method)).toEqual(['conversations.replies'])
    await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); r.recovery.kick('alpha'); await r.settle()
    expect([r.requests.length, h.read(), acks.count, r.findings, r.recovered]).toEqual([1, 'unresolved', 0, [], []])
    h.membership.delete(`alpha:${C}`)
    await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle()
    expect([r.requests.length, h.read(), acks.count]).toEqual([1, 'followed', 1])
    expect(accepted(h).map(a => [a.ts, a.via])).toEqual([[threadReply().ts as string, 'thread']])
  })

  test('a lookup requested for an earlier identity is issued again for the current one: rewritten on disk with its policy, restored so after a restart, and never for a settled lookup', async () => {
    const h = await open()
    await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome
    const old = { botUserId: 'U0OLDBOT1', botId: 'B0OLDBOT1' }
    const first = await h.threads.requestRootLookup('alpha', C, ROOT, old, STRICT_POLICY)
    const again = await h.threads.requestRootLookup('alpha', C, ROOT, issuerOf(h), { mode: 'strict', delivery: 'mentions' })
    expect([again!.id, again!.lookup!.issuer, again!.policy]).toEqual([first!.id, issuerOf(h), first!.policy])
    expect(h.h.queue.threadRecord('alpha', first!.id)?.observation.lookup?.issuer).toEqual(issuerOf(h))
    // The same identity again writes nothing.
    const written = readQueue(dir).length
    expect((await h.threads.requestRootLookup('alpha', C, ROOT, issuerOf(h), STRICT_POLICY))!.lookup!.issuer).toEqual(issuerOf(h))
    expect(readQueue(dir)).toHaveLength(written)
    await h.close()
    const reopened = await open({ clock: h.clock })
    expect(reopened.threads.rootLookups('alpha').map(o => [o.id, o.lookup!.issuer, o.policy])).toEqual([[first!.id, issuerOf(h), first!.policy]])
    expect(await reopened.threads.resolveRootLookup('alpha', first!.id, { kind: 'not-own' })).toEqual({ kind: 'not-own' })
    expect(await reopened.threads.requestRootLookup('alpha', C, ROOT, old, STRICT_POLICY)).toBeUndefined()
  })

  test('recovery re-issues a lookup recorded for an earlier identity under the current one and resolves it', async () => {
    const h = await open(), r = attachRecovery(h)
    await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome
    const lookup = await h.threads.requestRootLookup('alpha', C, ROOT, { botUserId: 'U0OLDBOT1', botId: 'B0OLDBOT1' }, STRICT_POLICY)
    const { acks } = await holdReply(h)
    r.respond(ownAnswer(h))
    await r.settle()
    expect(r.requests.map(q => [q.method, q.args.ts])).toEqual([['conversations.replies', ROOT]])
    expect(h.h.queue.threadRecord('alpha', lookup!.id)).toMatchObject({ state: 'enrolled', observation: { lookup: { issuer: issuerOf(h) } } })
    expect([h.read(), acks.count, r.findings]).toEqual(['followed', 1, []])
  })

  test('a lookup of an earlier identity whose current identity recovery cannot name is reported and left as it is, with no request', async () => {
    const h = await open()
    const r = attachRecovery(h, { identities: { alpha: { ...h.h.p('alpha').stub.identity, botUserId: 'not a bot user' } } })
    await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome
    const stale = await h.threads.requestRootLookup('alpha', C, ROOT2, issuerOf(h), STRICT_POLICY)
    r.recovery.kick('alpha'); await r.settle()
    expect([r.requests, r.findings.map(f => f.finding)]).toEqual([[], [{ cause: 'metadata', channel: C, root: ROOT2, code: 'identity-unresolved' }]])
    expect(h.h.queue.threadRecord('alpha', stale!.id)?.observation.lookup?.issuer).toEqual(issuerOf(h))
    expect(r.recovered).toEqual([])
  })

  test('a held reply that arrives while a pass runs is passed as soon as that pass ends when it did not fail, not at the backoff', async () => {
    const { h, r } = await rootless()
    const hung = hungMetadata()
    r.respond(hung.respond, ownAnswer(h, ROOT2))
    const mine = await holdReply(h)
    await r.settle()
    expect(r.requests.map(q => q.args.ts)).toEqual([ROOT])
    const other = await holdReply(h, { thread_ts: ROOT2, ts: '1700000000.000201' })
    const ended = h.clock.now()
    hung.settle(rootReplies(ROOT, { user: h.h.p('alpha').stub.identity.botUserId }))
    await r.settle()
    expect(r.requests.map(q => q.args.ts)).toEqual([ROOT, ROOT2])
    expect(r.requests[1]!.at - ended).toBeLessThan(ENROLLMENT_RETRY_MIN_MS)
    expect([h.read(), h.read(ROOT2), mine.acks.count, other.acks.count]).toEqual(['followed', 'followed', 1, 1])
  })

  test('a reply routing holds again because it now waits on a root lookup is a new obligation, not a failure: its lookup is asked at once', async () => {
    const h = await open(), r = attachRecovery(h), F = 'F0UPLOAD8'
    const upload = await h.confirmPost({ channel: C, file: F }, 'alpha', 'file').outcome
    const held = await holdReply(h)
    // The upload's root is another thread: the held reply now reads unfollowed, so the pass re-evaluates it.
    expect(await h.threads.resolveOwnPostRoot('alpha', upload.id!, ROOT2)).toMatchObject({ kind: 'enrolled' })
    expect([h.read(), h.h.routing.pendingCandidates().length]).toEqual(['unfollowed', 1])
    // A rootless post confirmed during that re-evaluation makes routing hold the reply again for a lookup.
    const reevaluate = h.h.routing.reevaluate.bind(h.h.routing)
    let posted = false
    h.h.routing.reevaluate = async id => {
      if (!posted) { posted = true; await h.confirmPost({ channel: C }, 'alpha', 'prompt').outcome }
      return reevaluate(id)
    }
    r.respond(ownAnswer(h))
    const start = h.clock.now()
    await r.settle()
    expect([posted, r.requests.map(q => q.args.ts), r.findings]).toEqual([true, [ROOT], []])
    expect(r.requests[0]!.at - start).toBeLessThan(ENROLLMENT_RETRY_MIN_MS)
    expect([h.read(), held.acks.count]).toEqual(['followed', 1])
  })

  test('a pass revoked while working on an upload lets a kick for that upload run once it ends', async () => {
    const h = await open(), r = attachRecovery(h), F = 'F0UPLOAD6'
    const post = await h.confirmPost({ channel: C, file: F }, 'alpha', 'file').outcome
    const hung = hungMetadata()
    r.respond(hung.respond)
    await r.settle()
    expect(r.requests.map(q => q.method)).toEqual(['files.info'])
    r.recovery.revoke('alpha')
    r.recovery.kick('alpha', post.id)
    r.respond(() => fileInfo(F, C, [{ ts: ROOT }]))
    await r.settle()
    expect([hung.aborted, r.requests.map(q => q.method), h.read(), h.threads.ownPostFindings('alpha')]).toEqual([[true], ['files.info', 'files.info'], 'followed', []])
  })

  test('an own root set aside on an ineligible channel reads unresolved once eligibility is unresolved, and a later reply\'s lookup reopens it and enrolls', async () => {
    const { h, r } = await rootless()
    const first = await holdReply(h)
    h.membership.set(`alpha:${C}`, { kind: 'ineligible', reason: 'absent' })
    r.respond(ownAnswer(h))
    await r.settle()
    expect([h.read(), first.acks.count, accepted(h)]).toEqual(['unfollowed', 1, []])
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: 'history-unresolved' })
    expect([h.read(), h.threads.rootLookupNeeded('alpha', C, ROOT)]).toEqual(['unresolved', true])
    h.membership.delete(`alpha:${C}`)
    r.respond(ownAnswer(h))
    const later = await holdReply(h, { ts: '1700000000.000102' })
    await r.settle()
    expect(r.requests.map(q => q.args.ts)).toEqual([ROOT, ROOT])
    expect([h.read(), later.acks.count, accepted(h).map(a => a.ts)]).toEqual(['followed', 1, ['1700000000.000102']])
  })

  test('a lookup whose thread a mention durably followed is not listed, and costs no request after a restart', async () => {
    const first = await open()
    await first.confirmPost({ channel: C }, 'alpha', 'prompt').outcome
    await first.threads.requestRootLookup('alpha', C, ROOT, issuerOf(first), STRICT_POLICY)
    expect((await first.receive(first.mention({ ts: '1700000000.000900', thread_ts: ROOT }))).acknowledged).toBe(1)
    expect(first.threads.rootLookups('alpha')).toEqual([])
    await first.close()
    const h = await open({ clock: first.clock })
    const r = attachRecovery(h, { identities: { alpha: first.h.p('alpha').stub.identity } })
    expect([h.read(), h.threads.rootLookups('alpha')]).toEqual(['followed', []])
    for (const key of h.h.queue.keys()) r.recovery.kick(key)
    await r.settle()
    expect(r.requests).toEqual([])
  })

  describe('the capability re-check while a reply waits on a lookup', () => {
    const PARTIAL = [PUBLIC_HISTORY_SCOPE, DM_HISTORY_SCOPE]
    /** When the waiting reply's lookup was requested: the gap's re-check clock starts at that pass. */
    const requestedAt = (h: ThreadHarness) => h.threads.rootLookups('alpha')[0]!.lookup!.requestedAt

    test('a missing scope with no re-read is re-checked only at the next connection: no lookup however long the reply waits', async () => {
      const { h, r } = await rootless({}, { scopes: { alpha: PARTIAL } })
      r.capability.connected('alpha')
      const { acks } = await holdReply(h)
      for (let i = 0; i < 3; i++) { await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle() }
      expect([r.requests, acks.count, r.capability.gap('alpha')?.kind]).toEqual([[], 0, 'missing-scope'])
    })

    test('a scope still missing is re-read once per spacing while a reply waits: never before it, never a lookup, one notice', async () => {
      const { h, r } = await rootless({}, { scopes: { alpha: PARTIAL }, refreshScopes: () => undefined })
      r.capability.connected('alpha')
      const { acks } = await holdReply(h)
      await r.settle()
      const since = requestedAt(h)
      await h.clock.advanceTo(since + ENROLLMENT_RETRY_MAX_MS - 1); await r.recovery.idle('alpha')
      expect(r.refreshes).toEqual([])
      await h.clock.advanceTo(since + ENROLLMENT_RETRY_MAX_MS * 3); await r.settle()
      expect(r.refreshes.map(q => [q.key, q.connectionId, q.at - since])).toEqual([1, 2, 3].map(n => ['alpha', 'conn-alpha', ENROLLMENT_RETRY_MAX_MS * n]))
      expect([r.requests, acks.count, r.capability.gap('alpha')?.kind]).toEqual([[], 0, 'missing-scope'])
      await h.notices.flush()
      expect([capabilityLines(h).length, capabilityNotices(h).length]).toEqual([1, 1])
    })

    test('a missing scope with no reply waiting is never re-read, and its lookup is not tried', async () => {
      const { h, r } = await rootless({}, { scopes: { alpha: PARTIAL }, refreshScopes: () => undefined })
      r.capability.connected('alpha')
      await h.threads.requestRootLookup('alpha', C, ROOT, issuerOf(h), STRICT_POLICY)
      r.recovery.kick('alpha'); await r.settle()
      for (let i = 0; i < 3; i++) { await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle() }
      expect([r.refreshes, r.requests]).toEqual([[], []])
    })

    test('a re-read showing every scope clears the gap with no second notice: the lookup runs in that pass, the reply is delivered and the episode ends', async () => {
      const scopes: Record<string, readonly string[] | undefined> = { alpha: PARTIAL }
      let reinstalled: readonly string[] | undefined
      const { h, r } = await rootless({}, { scopes, refreshScopes: () => { scopes.alpha = reinstalled } })
      reinstalled = requiredHistoryScopes(h.h.config!.personas.find(p => p.key === 'alpha'))
      r.capability.connected('alpha')
      const { reply, acks } = await holdReply(h)
      await r.settle()
      const since = requestedAt(h)
      r.respond(ownAnswer(h))
      await h.clock.advanceTo(since + ENROLLMENT_RETRY_MAX_MS); await r.settle()
      expect([r.refreshes.map(q => q.at - since), r.requests.map(q => q.at - since)]).toEqual([[ENROLLMENT_RETRY_MAX_MS], [ENROLLMENT_RETRY_MAX_MS]])
      expect([r.capability.gap('alpha'), h.read(), acks.count]).toEqual([undefined, 'followed', 1])
      expect(accepted(h).map(a => [a.ts, a.via])).toEqual([[reply.ts, 'thread']])
      await h.notices.flush()
      expect([capabilityLines(h).length, capabilityNotices(h).length]).toEqual([1, 1])
      expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_ROOT_LOOKUP_CAPABILITY)).toBe(false)
    })

    test('a re-read that narrows the gap to im:history releases the held lookup in that pass; the narrowed gap stays open, and the re-reads stop', async () => {
      const scopes: Record<string, readonly string[] | undefined> = { alpha: [PUBLIC_HISTORY_SCOPE] }
      const { h, r } = await rootless({}, { scopes, refreshScopes: () => { scopes.alpha = [PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE] } })
      r.capability.connected('alpha')
      expect(r.capability.gap('alpha')).toEqual({ kind: 'missing-scope', scopes: [PRIVATE_HISTORY_SCOPE, DM_HISTORY_SCOPE] })
      const { reply, acks } = await holdReply(h)
      await r.settle()
      expect([r.requests, acks.count]).toEqual([[], 0])
      const since = requestedAt(h)
      r.respond(ownAnswer(h))
      await h.clock.advanceTo(since + ENROLLMENT_RETRY_MAX_MS); await r.settle()
      expect([r.refreshes.map(q => q.at - since), r.requests.map(q => q.at - since)]).toEqual([[ENROLLMENT_RETRY_MAX_MS], [ENROLLMENT_RETRY_MAX_MS]])
      expect([r.capability.gap('alpha'), h.read(), acks.count]).toEqual([{ kind: 'missing-scope', scopes: [DM_HISTORY_SCOPE] }, 'followed', 1])
      expect(accepted(h).map(a => [a.ts, a.via])).toEqual([[reply.ts, 'thread']])
      for (let i = 0; i < 3; i++) { await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle() }
      expect(r.refreshes).toHaveLength(1)
      await h.notices.flush()
      // One line per distinct gap, one notice for the episode, which stays open.
      expect([capabilityLines(h).length, capabilityNotices(h).length]).toEqual([2, 1])
      expect(h.notices.rig.episodes.isOpen('alpha', PERSONA_EPISODE_KIND_ROOT_LOOKUP_CAPABILITY)).toBe(true)
    })

    test('a gap of only im:history never re-reads the scopes, even while a reply waits on a lookup that keeps failing for another reason', async () => {
      const im: RootLookupCapabilityGap = { kind: 'missing-scope', scopes: [DM_HISTORY_SCOPE] }
      const { h, r } = await rootless({}, { scopes: { alpha: [PUBLIC_HISTORY_SCOPE, PRIVATE_HISTORY_SCOPE] }, refreshScopes: () => undefined })
      r.capability.connected('alpha')
      const { acks } = await holdReply(h)
      r.respond(fails(slackPlatformError('internal_error')))
      await r.settle()
      // Later lookups are unscripted, so each is a transient failure retried at its spacing.
      for (let i = 0; i < 3; i++) { await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle() }
      expect(r.requests.length).toBeGreaterThan(1)
      expect([...new Set(r.findings.map(f => f.finding.cause))]).toEqual(['metadata'])
      expect([r.refreshes, acks.count, h.read(), r.capability.gap('alpha')]).toEqual([[], 0, 'unresolved', im])
    })

    test.each<[string, unknown, ParticipationRecoveryFinding]>([
      ['a Slack error of its own', slackPlatformError('something_odd'), { cause: 'metadata', code: 'something_odd' }],
      ['a transport failure', new Error('socket hang up'), { cause: 'metadata', code: 'transient' }],
      ['a capability refusal', slackPlatformError('missing_scope'), { cause: 'capability', code: 'missing_scope' }],
      ['a credentials refusal', slackPlatformError('invalid_auth'), { cause: 'capability', code: 'invalid_auth' }],
    ])('a failing re-read (%s) logs one recovery finding and is tried again once per spacing, with no lookup', async (_name, error, finding) => {
      const { h, r } = await rootless({}, { scopes: { alpha: PARTIAL }, refreshScopes: () => { throw error } })
      r.capability.connected('alpha')
      const { acks } = await holdReply(h)
      await r.settle()
      const since = requestedAt(h)
      await h.clock.advanceTo(since + ENROLLMENT_RETRY_MAX_MS * 3); await r.settle()
      expect(r.refreshes.map(q => q.at - since)).toEqual([1, 2, 3].map(n => ENROLLMENT_RETRY_MAX_MS * n))
      expect(r.findings.map(f => f.finding)).toEqual([finding, finding, finding])
      expect(recoveryLines(h)).toEqual([buildParticipationRecoveryLine(personaRef(), finding)])
      expect([r.requests, acks.count, r.capability.gap('alpha')?.kind, r.recovered]).toEqual([[], 0, 'missing-scope', []])
    })

    /** Re-reads answered by `answer(n)` for the nth call, hanging by default; `open` counts hung ones whose signal is not yet aborted. */
    function scopeRereads(answer: (n: number) => unknown = () => new Promise(() => {})) {
      const signals: AbortSignal[] = [], open = { now: 0, most: 0 }
      const refreshScopes = ({ signal }: { signal: AbortSignal }) => {
        signals.push(signal)
        const result = answer(signals.length)
        if (result instanceof Promise) {
          open.most = Math.max(open.most, ++open.now)
          signal.addEventListener('abort', () => { open.now-- }, { once: true })
        }
        return result
      }
      return { refreshScopes, signals, open, get aborted() { return signals.map(s => s.aborted) } }
    }
    const turn = (r: AttachedRecovery) => Promise.race([r.recovery.idle('alpha'), new Promise(resolve => setImmediate(resolve))])
    const DEADLINE_FINDING = { cause: 'metadata', code: 'deadline' } as const
    /** A hung re-read started at `startedAt` is aborted exactly at the deadline, with one deadline finding and nothing left in flight. */
    async function expectRereadDeadline(h: ThreadHarness, r: AttachedRecovery, rereads: ReturnType<typeof scopeRereads>, startedAt: number) {
      const findings = r.findings.length
      await h.clock.advanceTo(startedAt + ENROLLMENT_METADATA_DEADLINE_MS - 1); await turn(r)
      expect([rereads.aborted.at(-1), r.attempts.inFlight('alpha'), r.findings.length]).toEqual([false, 1, findings])
      await h.clock.advanceTo(startedAt + ENROLLMENT_METADATA_DEADLINE_MS); await r.recovery.idle('alpha')
      expect([rereads.aborted.at(-1), r.attempts.inFlight('alpha'), r.findings.slice(findings).map(f => f.finding)]).toEqual([true, 0, [DEADLINE_FINDING]])
    }
    /** The re-read after one that hung from `startedAt`: never before the re-check spacing or the deadline plus the least retry wait, always by the deadline plus the most. */
    async function expectNextReread(h: ThreadHarness, r: AttachedRecovery, startedAt: number) {
      const earliest = Math.max(ENROLLMENT_RETRY_MAX_MS, ENROLLMENT_METADATA_DEADLINE_MS + metadataRetryDelay(1))
      const latest = ENROLLMENT_METADATA_DEADLINE_MS + ENROLLMENT_RETRY_MAX_MS
      const before = r.refreshes.length
      await h.clock.advanceTo(startedAt + earliest - 1); await turn(r)
      expect(r.refreshes).toHaveLength(before)
      await h.clock.advanceTo(startedAt + latest); await r.settle()
      expect(r.refreshes).toHaveLength(before + 1)
      const after = r.refreshes[before]!.at - startedAt
      expect([after >= earliest, after <= latest, r.attempts.inFlight('alpha')]).toEqual([true, true, 1])
    }

    test('a hung first re-read ends at the deadline with one finding; the next waits the permitted spacing after it and arrives by the bound; no lookup meanwhile', async () => {
      const rereads = scopeRereads()
      const { h, r } = await rootless({}, { scopes: { alpha: PARTIAL }, refreshScopes: rereads.refreshScopes })
      r.capability.connected('alpha')
      const { acks } = await holdReply(h)
      await r.settle()
      await h.clock.advanceTo(requestedAt(h) + ENROLLMENT_RETRY_MAX_MS); await r.settle()
      expect([r.refreshes.length, r.attempts.inFlight('alpha')]).toEqual([1, 1])
      const startedAt = r.refreshes[0]!.at
      await expectRereadDeadline(h, r, rereads, startedAt)
      expect(recoveryLines(h)).toEqual([buildParticipationRecoveryLine(personaRef(), DEADLINE_FINDING)])
      await expectNextReread(h, r, startedAt)
      expect([r.requests, acks.count, r.capability.gap('alpha')?.kind, rereads.open.most]).toEqual([[], 0, 'missing-scope', 1])
    })

    test('a later re-read that hangs after one answered still-missing has the same bound, and never more than one re-read is in flight', async () => {
      const rereads = scopeRereads(n => n === 1 ? undefined : new Promise(() => {}))
      const { h, r } = await rootless({}, { scopes: { alpha: PARTIAL }, refreshScopes: rereads.refreshScopes })
      r.capability.connected('alpha')
      const { acks } = await holdReply(h)
      await r.settle()
      const since = requestedAt(h)
      await h.clock.advanceTo(since + ENROLLMENT_RETRY_MAX_MS); await r.settle()
      expect([r.refreshes.length, r.attempts.inFlight('alpha'), r.findings, r.capability.gap('alpha')?.kind]).toEqual([1, 0, [], 'missing-scope'])
      await h.clock.advanceTo(since + ENROLLMENT_RETRY_MAX_MS * 2); await r.settle()
      expect([r.refreshes.map(q => q.at - since), r.attempts.inFlight('alpha')]).toEqual([[ENROLLMENT_RETRY_MAX_MS, ENROLLMENT_RETRY_MAX_MS * 2], 1])
      const startedAt = r.refreshes[1]!.at
      await expectRereadDeadline(h, r, rereads, startedAt)
      await expectNextReread(h, r, startedAt)
      expect(recoveryLines(h)).toEqual([buildParticipationRecoveryLine(personaRef(), DEADLINE_FINDING)])
      expect([r.requests, acks.count, r.capability.gap('alpha')?.kind, rereads.open.most]).toEqual([[], 0, 'missing-scope', 1])
    })

    test('a refusal of the first lookup after a re-read cleared the scope stops every other waiting lookup in that pass', async () => {
      const scopes: Record<string, readonly string[] | undefined> = { alpha: PARTIAL }
      const { h, r } = await rootless({}, { scopes, refreshScopes: () => { scopes.alpha = requiredHistoryScopes(h.h.config!.personas.find(p => p.key === 'alpha')) } })
      r.capability.connected('alpha')
      const mine = await holdReply(h), other = await holdReply(h, { thread_ts: ROOT2, ts: '1700000000.000201' })
      await r.settle()
      const since = requestedAt(h)
      r.respond(fails(slackPlatformError('not_allowed_token_type')), ownAnswer(h, ROOT2))
      await h.clock.advanceTo(since + ENROLLMENT_RETRY_MAX_MS); await r.settle()
      expect([r.refreshes.length, r.requests.map(q => q.args.ts), r.capability.gap('alpha')?.kind]).toEqual([1, [ROOT], 'method-refused'])
      expect([h.read(), h.read(ROOT2), mine.acks.count, other.acks.count, r.unused]).toEqual(['unresolved', 'unresolved', 0, 0, 1])
    })

    test('a refused method is tried by one real lookup per spacing for a held reply; a success clears it and the other lookups run in that pass', async () => {
      const { h, r } = await rootless()
      const mine = await holdReply(h), other = await holdReply(h, { thread_ts: ROOT2, ts: '1700000000.000201' })
      const refused = fails(slackPlatformError('not_allowed_token_type'))
      r.respond(refused)
      await r.settle()
      const refusedAt = r.requests[0]!.at
      expect([r.requests.map(q => q.args.ts), r.capability.gap('alpha')?.kind]).toEqual([[ROOT], 'method-refused'])
      await h.clock.advanceTo(refusedAt + ENROLLMENT_RETRY_MAX_MS - 1); await r.recovery.idle('alpha')
      expect(r.requests).toHaveLength(1)
      r.respond(refused)
      await h.clock.advanceTo(refusedAt + ENROLLMENT_RETRY_MAX_MS * 2 - 1); await r.recovery.idle('alpha')
      expect(r.requests.map(q => [q.args.ts, q.at - refusedAt])).toEqual([[ROOT, 0], [ROOT, ENROLLMENT_RETRY_MAX_MS]])
      r.respond(ownAnswer(h), ownAnswer(h, ROOT2))
      await h.clock.advanceTo(refusedAt + ENROLLMENT_RETRY_MAX_MS * 2); await r.settle()
      expect(r.requests.slice(2).map(q => [q.args.ts, q.at - refusedAt])).toEqual([[ROOT, ENROLLMENT_RETRY_MAX_MS * 2], [ROOT2, ENROLLMENT_RETRY_MAX_MS * 2]])
      expect([r.capability.gap('alpha'), h.read(), h.read(ROOT2), mine.acks.count, other.acks.count]).toEqual([undefined, 'followed', 'followed', 1, 1])
      await h.notices.flush()
      expect(capabilityNotices(h)).toHaveLength(1)
    })

    test('a lookup with no reply waiting, held back before the success that cleared a refused method, gets its request in a follow-up pass with no outside kick, then nothing', async () => {
      const { h, r } = await rootless()
      const foreign: MetadataResponder = q => rootReplies(q.args.ts as string, { user: 'U0HUMAN' })
      await h.threads.requestRootLookup('alpha', C, ROOT2, issuerOf(h), STRICT_POLICY)
      r.capability.connected('alpha'); r.capability.lookupRefused('alpha', 'not_allowed_token_type')
      const { acks } = await holdReply(h)
      await r.settle()
      expect([r.requests, h.threads.rootLookups('alpha').map(o => o.root)]).toEqual([[], [ROOT2, ROOT]])
      const since = h.threads.rootLookups('alpha').find(o => o.root === ROOT)!.lookup!.requestedAt
      r.respond(foreign, foreign)
      await h.clock.advanceTo(since + ENROLLMENT_RETRY_MAX_MS); await r.recovery.idle('alpha')
      // The re-check pass: the gate lets only the held reply's lookup through, and its answer clears the gap.
      expect([r.requests.map(q => q.args.ts), r.capability.gap('alpha'), h.threads.rootLookups('alpha').map(o => o.root)]).toEqual([[ROOT], undefined, [ROOT2]])
      await h.clock.advance(1); await r.recovery.idle('alpha')
      expect(r.requests.map(q => [q.args.ts, q.at - since])).toEqual([[ROOT, ENROLLMENT_RETRY_MAX_MS], [ROOT2, ENROLLMENT_RETRY_MAX_MS + 1]])
      for (let i = 0; i < 5; i++) { await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle() }
      expect([r.requests.length, r.unused, h.threads.rootLookups('alpha'), h.read(), h.read(ROOT2), acks.count, h.owed]).toEqual([2, 0, [], 'unfollowed', 'unfollowed', 1, []])
    })

    test('a refused method with no reply waiting tries no lookup again', async () => {
      const { h, r } = await rootless()
      const { acks } = await holdReply(h)
      r.respond(fails(slackPlatformError('missing_scope')))
      await r.settle()
      // A direct mention follows the reply's thread; the next pass settles the reply, so none waits on a lookup any more.
      expect((await h.receive(h.mention({ ts: '1700000000.000900', thread_ts: ROOT }))).acknowledged).toBe(1)
      await h.threads.requestRootLookup('alpha', C, ROOT2, issuerOf(h), STRICT_POLICY)
      await h.clock.advance(metadataRetryDelay(1)); await r.settle()
      expect([acks.count, h.h.routing.pendingCandidates()]).toEqual([1, []])
      for (let i = 0; i < 3; i++) { await h.clock.advance(ENROLLMENT_RETRY_MAX_MS); await r.settle() }
      expect([r.requests.length, r.capability.gap('alpha')?.kind, h.threads.rootLookups('alpha').map(o => o.root)]).toEqual([1, 'method-refused', [ROOT2]])
    })
  })

  test(`recovery finding lines are distinct and stop at ${PARTICIPATION_RECOVERY_LOGGED_PER_PERSONA} per persona with one capped line until it recovers`, async () => {
    const h = await open()
    // Recovery is reported only over readable thread state, so alpha's journal is loaded first.
    expect((await h.receive(h.mention())).acknowledged).toBe(1)
    expect(h.h.queue.threadReadable('alpha')).toBe(true)
    for (let i = 1; i <= PARTICIPATION_RECOVERY_LOGGED_PER_PERSONA + 3; i++) {
      for (let copy = 0; copy < 2; copy++) h.reporting.recoveryFinding('alpha', { cause: 'metadata', channel: C, root: `1700000001.${String(i).padStart(6, '0')}`, code: 'deadline' })
    }
    h.reporting.recoveryFinding('beta', { cause: 'storage' })
    expect(recoveryLines(h)).toHaveLength(PARTICIPATION_RECOVERY_LOGGED_PER_PERSONA + 1)
    expect(recoveryLines(h).at(-1)).toBe(buildParticipationRecoveryCappedLine(personaRef()))
    expect(recoveryLines(h, 'beta')).toEqual([buildParticipationRecoveryLine(personaRef('beta'), { cause: 'storage' })])
    h.reporting.participationRecovered('alpha')
    expect(recoveredLines(h)).toHaveLength(1)
    h.reporting.participationRecovered('alpha')
    expect(recoveredLines(h)).toHaveLength(1)
    h.reporting.recoveryFinding('alpha', { cause: 'metadata', channel: C, root: '1700000001.000001', code: 'deadline' })
    expect(recoveryLines(h).at(-1)).toBe(buildParticipationRecoveryLine(personaRef(), { cause: 'metadata', channel: C, root: '1700000001.000001', code: 'deadline' }))
    await h.notices.flush()
    expect(h.notices.h.totalPosts()).toBe(0)
  })
})

describe('own-post handoffs at the participation owner', () => {
  test('an own post whose write is in flight is not a finding and a retry meanwhile writes nothing; its write settles it', async () => {
    const gate = threadHold()
    const h = await open({ beforeObservationSave: async (_key, observation) => { if (observation.post) await gate.wait() } })
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: 'history-unresolved' })
    const { outcome } = h.confirmPost({ channel: C, ts: ROOT })
    await gate.entered
    const [inFlight] = h.threads.pending('alpha')
    expect(h.threads.ownPostFindings('alpha')).toEqual([])
    expect(await h.threads.retryOwnPost('alpha', inFlight!.id)).toMatchObject({ kind: 'pending', id: inFlight!.id })
    gate.release()
    expect(await outcome).toMatchObject({ kind: 'pending', id: inFlight!.id })
    expect(h.threads.ownPostFindings('alpha')).toEqual([expect.objectContaining({ kind: 'pending', id: inFlight!.id })])
    expect(ownRecords(h)).toHaveLength(1)
  })

  test('a retry after another post durably enrolled the thread is a duplicate: no second enrolled record', async () => {
    const h = await open()
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: 'history-unresolved' })
    const pending = await h.confirmPost({ channel: C, ts: '1700000000.000101', parent: ROOT }).outcome
    h.membership.delete(`alpha:${C}`)
    expect((await h.receive(h.mention({ ts: '1700000000.000102', thread_ts: ROOT }))).acknowledged).toBe(1)
    expect(h.read()).toBe('followed')
    expect(await h.threads.retryOwnPost('alpha', pending.id!)).toMatchObject({ kind: 'enrolled', duplicate: true, missing: [] })
    expect(ownRecords(h).map(r => r.state)).toEqual(['observed'])
    expect(h.threads.ownPostFindings('alpha')).toEqual([])
  })

  test('a repeated confirmation of a post a retry decided ineligible agrees with the retry: ineligible, nothing missing, no stale reason', async () => {
    const h = await open()
    h.membership.set(`alpha:${C}`, { kind: 'unresolved', reason: 'history-unresolved' })
    const issue = h.threads.issueOwnPost('alpha', 'text')
    const pending = await h.threads.confirmOwnPost(issue, { channel: C, ts: ROOT })
    h.membership.set(`alpha:${C}`, { kind: 'ineligible', reason: 'absent' })
    const retried = await h.threads.retryOwnPost('alpha', pending.id!)
    expect(retried).toMatchObject({ kind: 'ineligible', missing: [], reason: 'absent' })
    const again = await h.threads.confirmOwnPost(issue, { channel: C, ts: ROOT })
    expect(again).toMatchObject({ kind: 'ineligible', missing: [], duplicate: true })
    expect(again.reason).toBeUndefined()
    expect([h.read(), await h.threads.retryOwnPost('alpha', pending.id!)]).toEqual(['unfollowed', undefined])
  })
})

describe('the tear fixture', () => {
  test('fails closed on an unterminated journal before any rewrite', async () => {
    const h = await open()
    await h.receive(h.mention())
    await h.close()
    const path = queuePath(dir, 'alpha'), bytes = fs.readFileSync(path)
    fs.writeFileSync(path, bytes.subarray(0, -1))
    expect(() => tearJournal(dir)).toThrow('fixture tear needs a newline-terminated closed journal')
    expect(fs.readFileSync(path)).toEqual(bytes.subarray(0, -1))
  })
})
