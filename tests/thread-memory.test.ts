/**
 * Thread Memory journals and authority-driven forgetting, alongside the
 * bounded metadata calls, failure classification and retry spacing.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { THREAD_MEMORY_LOOKUP_METHODS, MetadataCancelledError, classifyMetadataFailure, createMetadataAttempts, metadataRetryDelay,
  THREAD_MEMORY_JOIN_SAVE_WINDOW_MS as JOIN_SAVE_WINDOW_MS, THREAD_MEMORY_JOIN_SAVE_MAX_REQUESTS as JOIN_SAVE_MAX_REQUESTS,
  type MetadataFailure } from '../src/thread-memory.ts'
import { THREAD_MEMORY_LOOKUP_DEADLINE_MS, THREAD_MEMORY_RETRY_MAX_MS, THREAD_MEMORY_RETRY_MIN_MS, THREAD_MEMORY_NOTICE_MAX_CHARS, THREAD_MEMORY_REWRITE_CHUNK_BYTES, THREAD_MEMORY_COMPACT_BACKLOG_MAX_MS } from '../src/delivery-constants.ts'
import { makeBacklogMemory } from './test-helpers/thread-memory-backlog.ts'
import { makeRoutingHarness, observedMembership, resetRoutingState, NEVER_FIRE_RESTART_DELAY_S, type RoutingHarness } from './test-helpers/persona-routing-harness.ts'
import { makeChannelMessage, mentionText } from './test-helpers/slack-stub.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { INITIAL_CREDENTIALS, slackHttpError, slackPlatformError, slackRateLimited } from './test-helpers/slack-stub.ts'
import { assertNoLeak, LEAK_SENTINEL, writeCredentialsFile, fakeToken, BOT_TOKEN_PREFIX, APP_TOKEN_PREFIX, writtenFile } from './test-helpers/credentials.ts'
import { PersonaSlackTokens } from '../src/persona-credentials.ts'
import { isThreadMemoryRecord, parseThreadMemoryRecord, serializeThreadMemoryRecords, THREAD_MEMORY_COMPACTION_SLICE, THREAD_MEMORY_DIRECTORY_MODE, THREAD_MEMORY_FILE_MODE,
  normaliseOwnPostText, ownPostDigest, type OwnPostIntent, type ThreadJoin, type ThreadMemory, type ThreadMemoryCompaction } from '../src/thread-memory.ts'
import { QUEUE_COMPACT_INTERVAL_MS } from '../src/delivery-queue.ts'
import { recoverQueuedJoins } from '../src/thread-join-recovery.ts'
import { createOwnPostJoins, ownPostAnswerOfPost, type OwnPostSurface } from '../src/own-post.ts'
import { DurableWriteUnsyncedError } from '../src/atomic-write.ts'
import { createThreadMemorySeal, isThreadMemorySealEntry, isThreadMemorySealFile, serializeThreadMemorySeal, judgeSeal, queueIdentitiesMatch,
  type JudgeSealInput, type ThreadMemorySealCase, type ThreadMemorySealEntry } from '../src/thread-memory-seal.ts'
import {
  makeThreadMemoryHarness, makeThreadMembershipHarness, threadConfig, threadPath, threadHeader,
  threadJoin, joinRecord, postIntent, postOutcome, seedThreads, readThreads, damagedThreadLine,
  THREAD_CHANNELS as C, THREAD_ROOTS as R, THREAD_TIME, type ThreadMemoryHarness, type ThreadHarnessOptions, slackTsOfMs,
  runningSealEntry, cleanSealEntry, cleanOwnPostSealEntry, seedThreadSeal, readThreadSeal, threadSealPath, damagedThreadSeal,
  threadFsControls, threadSealFsControls, populationConfig, populationEligible, seedUnitPopulation, populationChannels, populationJoins, oldestJoins, stampedJoins,
  sr8Personas, SR8_POPULATIONS, SR8_ELIGIBLE_CHANNELS, SR8_POPULATION_CHANNEL_COUNT, SR8_SHARED_LIST_CHANNELS, SR8_BURST_JOINS, SEED_BATCH_JOINS,
} from './test-helpers/thread-memory.ts'
import { makeOwnPostHarness, type OwnPostHarness } from './test-helpers/own-post.ts'
import { channelPopulation, makeSharedAuthority, membershipPage, readSharedState, FIXTURE_THREAD_HYBRID_SINCE_PREFIX } from './test-helpers/shared-channels.ts'
import { makeReloadHarness, type ReloadRun } from './test-helpers/reload-harness.ts'
import { acceptedRecord, deliveredRecord, fixedRecord, injectedInput, makeQueue, queuePath, seedQueue, slackInput, memoryHold, heldSlackInput } from './test-helpers/delivery-queue.ts'
import { durableIo } from './test-helpers/durable-io.ts'
import { makeDeferredWebApiCall, makeStubSlack } from './test-helpers/slack-stub.ts'
import { MEMBERSHIP_PAGE_LIMIT, MEMBERSHIP_RETRY_MIN_MS } from '../src/channel-membership-retry.ts'
import { _resetRegistry } from '../src/registry.ts'
import { _resetAckTracker } from '../src/ack-tracker.ts'
import { formatPersonaNotice } from '../src/persona-notifier.ts'
import { renderPersonaRef } from '../src/persona-identity.ts'
import { escapeSlackControlCharacters } from '../src/slack-text-escape.ts'
import {
  buildThreadMemoryNotSavedNotice, buildThreadMemoryNotSavedLine, buildThreadMemoryUnreadableNotice,
  buildThreadMemoryUnreadableLine, buildThreadMemoryRecoveredNotice, buildThreadMemoryRecoveredLine,
  buildThreadMemoryJoinsLostNotice, buildThreadMemoryJoinsLostLine, buildThreadMemoryQuarantinedLine,
  buildThreadMemoryChangedWhileStoppedNotice, buildThreadMemoryChangedWhileStoppedLine,
  buildThreadMemorySealNotSavedLine, buildThreadMemoryCompactionFailedLine, buildThreadMemoryRemovalFailedLine,
  buildThreadMemoryCompactionRecoveredLine, buildThreadMemorySealSavedLine,
  type ThreadMemoryLoss,
} from '../src/thread-memory-reports.ts'
import { THREAD_MEMORY_NOT_SAVED, THREAD_MEMORY_UNREADABLE } from '../src/persona-diagnostics.ts'
import type { MemoryHoldEvent } from '../src/memory-holds.ts'

const T0 = 1_700_000_000_000

const ownPostRuns: OwnPostHarness[] = []
const threadRuns: Array<ThreadMemoryHarness | ReturnType<typeof makeThreadMembershipHarness>> = [], threadDirs: string[] = []
const joinedChannels = [C.primary, C.secondary].map(id => ({ id, delivery: 'thread_hybrid' as const }))
function fixture(options: Parameters<typeof makeThreadMemoryHarness>[1] = {}, dir?: string) {
  dir ??= mkdtempSync(join(tmpdir(), 'thread-memory-'))
  if (!threadDirs.includes(dir)) threadDirs.push(dir)
  const h = makeThreadMemoryHarness(dir, options); threadRuns.push(h); return h
}
function membershipFixture(options: Parameters<typeof makeThreadMembershipHarness>[1] = {}, dir?: string) {
  dir ??= mkdtempSync(join(tmpdir(), 'thread-membership-'))
  if (!threadDirs.includes(dir)) threadDirs.push(dir)
  const h = makeThreadMembershipHarness(dir, options); threadRuns.push(h); return h
}
const view = (h: ThreadMemoryHarness, root: string = R.primary, key = 'alpha') => h.memory.view(key, C.primary, root)
const journalBytes = (h: ThreadMemoryHarness, key = 'alpha') => readFileSync(threadPath(h.stateDir, key))
const savedJoins = (h: ThreadMemoryHarness, key = 'alpha') => readThreads(h.stateDir, key).filter(r => r.kind === 'join')
function expectOnlySavedJoin(h: ThreadMemoryHarness, fact: ThreadJoin, key = 'alpha') {
  expect(h.memory.joins(key)).toEqual([{ join: fact, savedAt: fact.at }])
  expect(h.memory.isJoinSaved(key, fact)).toBe(true)
  expect(h.memory.view(key, fact.channel, fact.root)).toBe('joined')
}
/** The second saved join keeps its exact record bytes; the forgotten first one cannot replay. */
async function expectSurvivorAfterCompactionAndRestart(h: ThreadMemoryHarness, survivor: ThreadJoin) {
  const record = joinRecord(survivor, 3), bytes = serializeThreadMemoryRecords([record])
  expect(journalBytes(h).includes(bytes)).toBe(true)
  await h.memory.compact()
  expectOnlySavedJoin(h, survivor)
  expect(savedJoins(h)).toEqual([record]); expect(journalBytes(h).includes(bytes)).toBe(true)
  const compacted = journalBytes(h)
  await h.close()
  const reopened = fixture({ reopen: true }, h.stateDir); await reopened.start()
  expect(view(reopened)).toBe('not-joined'); expectOnlySavedJoin(reopened, record)
  expect(journalBytes(reopened)).toEqual(compacted)
}
function gate() {
  let release!: () => void, enter!: () => void
  const pending = new Promise<void>(r => { release = r }), entered = new Promise<void>(r => { enter = r })
  return { release, entered, async wait() { enter(); await pending } }
}
afterEach(async () => {
  for (const h of ownPostRuns.splice(0)) await h.close()
  for (const h of threadRuns.splice(0)) {
    await h.close()
    if ('membership' in h) assertNoLeak(h.membership.captured())
    expect(h.clock.pendingCount()).toBe(0)
    assertNoLeak({ events: h.events, sealEvents: h.sealEvents, retryEvents: h.retryEvents, posts: h.posts, logs: h.logs, state: readSharedState(h.stateDir),
      ...(existsSync(threadSealPath(h.stateDir)) ? { seal: writtenFile(threadSealPath(h.stateDir)) } : {}),
      ...(existsSync(join(h.stateDir, 'threads')) ? { threads: writtenFile(join(h.stateDir, 'threads')) } : {}) })
  }
  _resetAckTracker(); _resetRegistry()
  for (const dir of threadDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Thread Memory store', () => {
  test('construction does no I/O; first activation durably creates private metadata before its real marker', async () => {
    const h = fixture()
    expect(h.io.calls).toEqual([]); expect(h.events).toEqual([]); expect(h.clock.pendingCount()).toBe(0)
    h.memory.readAtStart()
    expect(h.authority.threadMemoryCreated('alpha')).toBe(false)
    await h.memory.activate()
    expect(h.markerCalls).toEqual([{ action: 'set', key: 'alpha', fileExists: true, synced: true }])
    expect(readSharedState(h.stateDir)!.threadMemoryCreated).toEqual({ alpha: true })
    expect(statSync(join(h.stateDir, 'threads')).mode & 0o777).toBe(THREAD_MEMORY_DIRECTORY_MODE)
    expect(statSync(threadPath(h.stateDir)).mode & 0o777).toBe(THREAD_MEMORY_FILE_MODE)
    expect(h.memory.store('alpha')).toMatchObject({ storeId: expect.any(String), digestKey: expect.stringMatching(/^[a-f0-9]{64}$/), lastRecordNumber: 1, readable: true, created: true })
    expect(h.events).toEqual([{ type: 'created', key: 'alpha', path: threadPath(h.stateDir) }])
  })

  test.each((['off', 'mentions', 'all'] as const).flatMap(delivery => (['ordinary', 'dry run'] as const).map(mode => [delivery, mode] as const)))('%s without a store skips startup/later reads and compaction; first hybrid after healing honors %s mode', async (delivery, mode) => {
    const dryRun = mode === 'dry run', h = fixture({ dryRun }), keys = ['alpha', 'beta']
    expect(h.choose(delivery).kind).toBe('applied')
    await h.start(); await h.memory.compact()
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    expect(h.io.calls.filter(c => c.path === threadPath(h.stateDir))).toEqual([])
    expect(h.events).toEqual([]); expect(h.markerCalls).toEqual([])

    // Both later addition and teardown/bring-up must leave a never-created
    // store alone, even when a read would fail during a storage outage.
    for (const key of keys) h.io.fail('readFileSync', key, { code: 'EACCES' })
    expect(h.apply(threadConfig(h.stateDir, delivery, keys)).kind).toBe('applied')
    await h.memory.loadKey('beta')
    h.memory.forget('alpha'); await h.memory.loadKey('alpha')
    await h.memory.compact(); h.memory.startMaintenance()
    await h.clock.advance(QUEUE_COMPACT_INTERVAL_MS)
    expect(h.io.calls.filter(c => c.op === 'readFileSync')).toEqual([])
    expect(h.io.writes()).toEqual([]); expect(existsSync(join(h.stateDir, 'threads'))).toBe(false)
    expect(h.events).toEqual([]); expect(h.markerCalls).toEqual([])
    for (const key of keys) {
      expect(h.memory.store(key)).toMatchObject({ readable: true, created: false })
      expect(h.memory.readFacts(key)).toEqual({ error: undefined, quarantined: [] })
      expect(h.authority.threadMemoryCreated(key)).toBe(false)
    }
    h.io.heal(); h.io.reset()
    for (const key of keys) await h.memory.loadKey(key)
    expect(h.io.calls).toEqual([])

    for (const key of keys) expect(h.choose('thread_hybrid', key).kind).toBe('applied')
    expect(h.io.writes()).toEqual([]); expect(h.markerCalls).toEqual([])
    await h.clock.flush()
    for (const key of keys) {
      expect(await h.memory.flush(key)).toEqual({ kind: dryRun ? 'kept' : 'saved' })
      expect(h.memory.store(key)).toMatchObject({ readable: true, created: !dryRun })
      expect(h.authority.threadMemoryCreated(key)).toBe(!dryRun)
    }
    if (dryRun) {
      expect(h.io.writes()).toEqual([]); expect(h.events).toEqual([]); expect(h.markerCalls).toEqual([])
      expect(existsSync(join(h.stateDir, 'threads'))).toBe(false)
    } else {
      // Each persona's store is created on its own writer; their I/O completes in either order.
      for (const key of keys) {
        expect(h.markerCalls.filter(call => call.key === key)).toEqual([{ action: 'set', key, fileExists: true, synced: true }])
        expect(h.events.filter(event => 'key' in event && event.key === key)).toEqual([{ type: 'created', key, path: threadPath(h.stateDir, key) }])
      }
      expect(h.markerCalls).toHaveLength(keys.length); expect(h.events).toHaveLength(keys.length)
      expect(readSharedState(h.stateDir)!.threadMemoryCreated).toEqual({ alpha: true, beta: true })
      expect(statSync(join(h.stateDir, 'threads')).mode & 0o777).toBe(THREAD_MEMORY_DIRECTORY_MODE)
      const stores = keys.map(key => h.memory.store(key))
      for (const key of keys) {
        expect(readThreads(h.stateDir, key)).toEqual([expect.objectContaining({ kind: 'header', seq: 1, highWater: 1, storeId: h.memory.store(key)!.storeId })])
        expect(statSync(threadPath(h.stateDir, key)).mode & 0o777).toBe(THREAD_MEMORY_FILE_MODE)
      }
      await h.close()
      const reopened = fixture({ reopen: true }, h.stateDir); await reopened.start()
      expect(keys.map(key => reopened.memory.store(key))).toEqual(stores)
      expect(reopened.markerCalls).toEqual([])
    }
  })

  test('the test-only save observer: unset by default; set, one count per appending save, none for failed or empty saves; a throw cannot fail a save', async () => {
    const h = fixture(); await h.start()
    const saves: unknown[] = []
    expect(await h.memory.saveJoins('alpha', [h.fact({ root: R.secondary })])).toEqual({ kind: 'saved' })
    h.memory.setSaveObserver(save => { saves.push(save) })
    expect(await h.memory.saveJoins('alpha', [h.fact()])).toEqual({ kind: 'saved' })
    expect(h.memory.addJoin('alpha', h.fact({ root: R.secondary, at: THREAD_TIME - 5 }))).toBe(true)
    expect(h.memory.addJoin('alpha', h.fact({ at: THREAD_TIME - 5 }))).toBe(true)
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(saves).toEqual([
      { key: 'alpha', records: 1, joins: 1, intents: 0, outcomes: 0 },
      { key: 'alpha', records: 2, joins: 2, intents: 0, outcomes: 0 },
    ])
    h.io.fail('writeSync')
    expect((await h.memory.saveJoins('alpha', [h.fact({ root: R.secondary, at: THREAD_TIME - 9 })])).kind).toBe('failed')
    h.io.heal()
    expect(saves).toHaveLength(2)
    h.memory.setSaveObserver(() => { throw new Error('observer failed') })
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    h.memory.setSaveObserver(undefined)
    expect(await h.memory.saveJoins('alpha', [h.fact({ at: THREAD_TIME - 9 })])).toEqual({ kind: 'saved' })
    expect(saves).toHaveLength(2)
    expect(savedJoins(h)).toHaveLength(6)
  })

  test('saved joins retain earliest times, store identity and increasing record numbers across compaction and restart', async () => {
    const h = fixture(); await h.start()
    const later = h.fact({ at: THREAD_TIME + 20 }), earlier = { ...later, at: THREAD_TIME + 10, source: 'broadcast' as const }
    expect(await h.memory.saveJoins('alpha', [later])).toEqual({ kind: 'saved' })
    expect(h.memory.addJoin('alpha', earlier)).toBe(true)
    expect(h.memory.joins('alpha')).toEqual([{ join: earlier, savedAt: later.at }])
    expect(h.memory.isJoinSaved('alpha', earlier)).toBe(false)
    expect(h.memory.isJoinSaved('alpha', later)).toBe(true)
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    const store = h.memory.store('alpha')!
    await h.memory.compact()
    expect(savedJoins(h)).toEqual([joinRecord(earlier, 3)])
    expect(readThreads(h.stateDir)[0]).toMatchObject({ storeId: store.storeId, highWater: 3 })
    await h.close()
    const reopened = fixture({ reopen: true }, h.stateDir); await reopened.start()
    expect(reopened.memory.store('alpha')).toEqual(store)
    expect(reopened.memory.joins('alpha')).toEqual([{ join: joinRecord(earlier, 3), savedAt: earlier.at }])
    expect(view(reopened)).toBe('joined')
    const next = reopened.fact({ root: R.secondary, source: 'own-post' })
    await reopened.memory.saveJoins('alpha', [next])
    expect(savedJoins(reopened).map(r => r.seq)).toEqual([3, 4])
    const before = reopened.io.calls.length
    for (let i = 0; i < 5; i++) expect(view(reopened)).toBe('joined')
    expect(reopened.io.calls).toHaveLength(before)
  })

  test.each(['joined', 'none'] as const)('activation and hourly compaction retain unresolved posts and drop %s outcomes without saving kept facts', async outcome => {
    const h = fixture(), fact = h.fact(), old = { ...fact, at: fact.at - 10 }
    const resolved = postIntent(fact), unresolved = postIntent(fact, { operationId: 'pending-post', seq: 5 })
    seedThreads(h.stateDir, [threadHeader(), joinRecord(fact), resolved, postOutcome(resolved, outcome), unresolved, joinRecord(old, 6)])
    h.memory.readAtStart()
    expect(h.io.calls.some(c => c.op === 'rename' || c.op === 'renameSync')).toBe(false)
    await h.memory.activate()
    expect(savedJoins(h)).toEqual([joinRecord(old, 6)])
    expect(h.memory.unresolvedIntents('alpha')).toEqual([unresolved])
    expect(readThreads(h.stateDir).map(r => r.kind)).toEqual(['header', 'post-intent', 'join'])
    const kept = h.fact({ root: R.secondary }); h.memory.addJoin('alpha', kept)
    h.io.reset(); h.memory.startMaintenance(); h.memory.startMaintenance()
    expect(h.clock.pending().map(t => t.delayMs)).toEqual([QUEUE_COMPACT_INTERVAL_MS])
    await h.clock.advance(QUEUE_COMPACT_INTERVAL_MS - 1)
    expect(h.io.calls.some(c => c.op === 'rename')).toBe(false)
    await h.clock.advance(1)
    expect(h.io.calls.some(c => c.op === 'rename')).toBe(true)
    expect(savedJoins(h)).toEqual([joinRecord(old, 6)])
    expect(h.memory.keptFacts('alpha')).toEqual([kept])
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(savedJoins(h).map(r => r.seq)).toEqual([6, 7])
    await h.close(); expect(h.clock.pendingCount()).toBe(0)
  })

  test.each([
    ['argument over option', QUEUE_COMPACT_INTERVAL_MS / 4, QUEUE_COMPACT_INTERVAL_MS / 2, QUEUE_COMPACT_INTERVAL_MS / 4],
    ['option over default', undefined, QUEUE_COMPACT_INTERVAL_MS / 2, QUEUE_COMPACT_INTERVAL_MS / 2],
    ['default when neither is given', undefined, undefined, QUEUE_COMPACT_INTERVAL_MS],
  ] as const)('maintenance interval: %s', async (_name, intervalMs, compactIntervalMs, expected) => {
    const h = fixture({ compactIntervalMs }); await h.start()
    h.memory.startMaintenance(intervalMs)
    expect(h.clock.pending().map(t => t.delayMs)).toEqual([expected])
    const identity = statSync(threadPath(h.stateDir)).ino
    await h.clock.advance(expected - 1)
    expect(statSync(threadPath(h.stateDir)).ino).toBe(identity)
    await h.clock.advance(1)
    expect(statSync(threadPath(h.stateDir)).ino).not.toBe(identity)
    expect(h.events.filter(e => e.type === 'compaction-failed')).toEqual([])
  })

  test.each(['missing', 'invalid'] as const)('%s header is repaired with a fresh identity and the largest readable sequence', async kind => {
    const h = fixture(), fact = h.fact(), oldHeader = threadHeader({ seq: 19, highWater: 19 })
    seedThreads(h.stateDir, [...(kind === 'invalid' ? [damagedThreadLine(oldHeader, 'invalid-header')] : []), joinRecord(fact, 12)])
    h.memory.readAtStart()
    expect(h.memory.store('alpha')?.storeId).toBeUndefined()
    await h.memory.activate()
    const store = h.memory.store('alpha')!, highWater = kind === 'invalid' ? 19 : 12
    expect(store.storeId).not.toBe(oldHeader.storeId); expect(store.digestKey).not.toBe(oldHeader.digestKey)
    expect(readThreads(h.stateDir)[0]).toMatchObject({ kind: 'header', seq: 0, highWater, storeId: store.storeId })
    expect(view(h)).toBe('joined')
    await h.memory.saveJoins('alpha', [h.fact({ root: R.secondary })])
    expect(savedJoins(h).at(-1)!.seq).toBe(highWater + 1)
  })

  test.each(['writeSync', 'fsync', 'rename'] as const)('pre-rename compaction %s failure leaves original bytes and keeps memory usable', async op => {
    const h = fixture(); await h.start()
    await h.memory.saveJoins('alpha', [h.fact()]); const before = journalBytes(h)
    const error = h.io.fail(op)
    await h.memory.compact('alpha')
    expect(journalBytes(h)).toEqual(before); expect(view(h)).toBe('joined')
    expect(h.events.at(-1)).toEqual({ type: 'compaction-failed', key: 'alpha', path: threadPath(h.stateDir), step: 'journal-rewrite', error })
    expect(readdirSync(join(h.stateDir, 'threads')).filter(n => n.endsWith('.tmp'))).toEqual([])
    h.io.heal(); await h.memory.compact('alpha')
    expect(savedJoins(h)).toHaveLength(1)
  })

  test('closed production record schemas refuse message text, names and credentials on every record kind', () => {
    const fact = threadJoin(), intent = postIntent(fact)
    const records = [threadHeader(), joinRecord(fact), intent, postOutcome(intent)]
    for (const record of records) {
      expect(isThreadMemoryRecord(record)).toBe(true)
      for (const field of ['text', 'user_name', 'credentials']) {
        const polluted = { ...record, [field]: LEAK_SENTINEL }
        expect(isThreadMemoryRecord(polluted)).toBe(false)
        expect(parseThreadMemoryRecord(serializeThreadMemoryRecords([polluted]).toString('utf8').trimEnd())).toBeUndefined()
      }
    }
    assertNoLeak({ records })
  })

  test('saveJoins cannot persist unrelated content carried on a structurally valid join object', async () => {
    const h = fixture(); await h.start()
    const unrelated = 'private-content-outside-thread-metadata'
    const fact = { ...h.fact(), text: unrelated, user_name: unrelated, credentials: unrelated }
    // TypeScript permits this structural subtype. Rejecting it or projecting
    // only metadata is safe; copying its unrelated properties into disk is not.
    await h.memory.saveJoins('alpha', [fact]).catch(() => undefined)
    const wroteContent = journalBytes(h).includes(Buffer.from(unrelated)), claimedSaved = h.memory.isJoinSaved('alpha', fact)
    const restarted = fixture({ reopen: true }, h.stateDir); await restarted.start()
    expect({ wroteContent, savedJoinSurvives: !claimedSaved || view(restarted) === 'joined' }).toEqual({ wroteContent: false, savedJoinSurvives: true })
    expect(readThreads(restarted.stateDir).every(isThreadMemoryRecord)).toBe(true)
  })

  test('addJoin keeps only metadata for flush, compaction and restart', async () => {
    const h = fixture(); await h.start(); const fact = h.fact()
    const input = { ...fact, text: LEAK_SENTINEL, user_name: LEAK_SENTINEL, credentials: LEAK_SENTINEL }
    expect(h.memory.addJoin('alpha', input)).toBe(true)
    expect(h.memory.keptFacts('alpha')).toEqual([fact])
    expect(h.memory.joins('alpha')).toEqual([{ join: fact }])
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(savedJoins(h)).toEqual([joinRecord(fact)])
    await h.memory.compact(); await h.close()
    const restarted = fixture({ reopen: true }, h.stateDir); await restarted.start()
    expect(view(restarted)).toBe('joined')
    expect(savedJoins(restarted)).toEqual([joinRecord(fact)])
    expect(restarted.memory.readFacts('alpha').quarantined).toEqual([])
  })

  test.each(['addJoin', 'saveJoins'] as const)('%s refuses extra nested stamp fields without retaining or saving them', async method => {
    const h = fixture(); await h.start(); const fact = h.fact(), before = journalBytes(h)
    const input = { ...fact, stamp: { ...fact.stamp, text: LEAK_SENTINEL, user_name: LEAK_SENTINEL, credentials: LEAK_SENTINEL } }
    await expect((async () => {
      if (method === 'addJoin') h.memory.addJoin('alpha', input)
      else await h.memory.saveJoins('alpha', [input])
    })()).rejects.toThrow()
    expect(h.memory.joins('alpha')).toEqual([]); expect(h.memory.keptFacts('alpha')).toEqual([])
    expect(h.memory.isJoinSaved('alpha', fact)).toBe(false)
    await h.memory.flush('alpha')
    expect(journalBytes(h)).toEqual(before)
    // A valid join still saves after the rejected input, and survives replay.
    expect(await h.memory.saveJoins('alpha', [fact])).toEqual({ kind: 'saved' })
    expect(savedJoins(h)).toEqual([joinRecord(fact)])
    await h.close()
    const restarted = fixture({ reopen: true }, h.stateDir); await restarted.start()
    expect(view(restarted)).toBe('joined')
    expect(restarted.memory.readFacts('alpha').quarantined).toEqual([])
  })

  test('post-rename directory sync failure reports unconfirmed durability with replacement bytes visible', async () => {
    const h = fixture(); await h.start(); const fact = h.fact()
    await h.memory.saveJoins('alpha', [fact]); await h.memory.saveJoins('alpha', [{ ...fact, at: fact.at - 1 }])
    const before = journalBytes(h)
    const error = h.io.fail('fsync', 'alpha', { match: path => path === join(h.stateDir, 'threads') })
    await h.memory.compact()
    expect(journalBytes(h).equals(before)).toBe(false)
    expect(savedJoins(h)).toEqual([joinRecord({ ...fact, at: fact.at - 1 }, 3)])
    expect(h.events.at(-1)).toEqual({ type: 'compaction-failed', key: 'alpha', path: threadPath(h.stateDir), step: 'journal-rewrite', error })
    h.io.heal(); await h.memory.compact()
    const restarted = fixture({ reopen: true }, h.stateDir); await restarted.start()
    expect(view(restarted)).toBe('joined'); expect(restarted.memory.store('alpha')?.lastRecordNumber).toBe(3)
  })

  test('failed quarantine preserves the journal and gives unknown until evidence can be saved', async () => {
    const h = fixture(), fact = h.fact(), tail = damagedThreadLine(joinRecord(fact, 3), 'torn')
    const bytes = seedThreads(h.stateDir, [threadHeader(), joinRecord(fact), tail])
    const error = h.io.fail('writeSync', 'alpha', { match: path => path.includes('.unreadable-') })
    await h.start()
    expect(view(h)).toBe('unknown'); expect(h.memory.readFacts('alpha').error).toBe(error)
    expect(journalBytes(h).equals(bytes)).toBe(true)
    expect(h.memory.readFacts('alpha').quarantined).toEqual([])
    h.io.heal(); await h.memory.loadKey('alpha')
    expect(view(h)).toBe('joined'); expect(savedJoins(h)).toEqual([joinRecord(fact)])
    expect(h.memory.readFacts('alpha').quarantined).toEqual([{ line: 3, invalidFinalLine: true, channel: C.primary, root: R.primary }])
  })

  test.each([false, true])('read-time quarantine is durable when the synchronous startup read returns, through blocking syncs only; failed=%s', failed => {
    const h = fixture(), fact = h.fact(), tail = damagedThreadLine(joinRecord(fact, 3), 'torn')
    const bytes = seedThreads(h.stateDir, [threadHeader(), joinRecord(fact), tail])
    const isQuarantine = (path: string) => path.includes('.unreadable-')
    // A callback-form fault can never reach quarantine; only the blocking one does.
    h.io.fail('fsync', 'alpha', { match: isQuarantine })
    const error = failed ? h.io.fail('fsyncSync', 'alpha', { match: isQuarantine }) : undefined
    h.memory.readAtStart()
    expect(h.io.durable.busy()).toBe(false); expect(h.io.durable.held()).toBe(0)
    expect(h.memory.readFacts('alpha').error).toBe(error)
    const syncs = h.io.calls.filter(c => (c.op === 'fsync' || c.op === 'fsyncSync') && (isQuarantine(c.path) || c.path === join(h.stateDir, 'threads')))
    if (failed) {
      // The refused file sync, then its rollback's sync after truncation; no directory sync.
      expect(syncs.map(c => [c.op, isQuarantine(c.path)])).toEqual([['fsyncSync', true], ['fsyncSync', true]])
      expect(journalBytes(h).equals(bytes)).toBe(true)
      expect(h.memory.readFacts('alpha').quarantined).toEqual([])
      return
    }
    expect(syncs.map(c => [c.op, isQuarantine(c.path)])).toEqual([['fsyncSync', true], ['fsyncSync', false]])
    const quarantine = h.events.find(e => e.type === 'lines-quarantined')
    if (quarantine?.type !== 'lines-quarantined') throw new Error('missing quarantine event')
    expect(readFileSync(quarantine.quarantinePath).equals(tail)).toBe(true)
    expect(h.memory.readFacts('alpha').quarantined).toEqual([{ line: 3, invalidFinalLine: true, channel: C.primary, root: R.primary }])
  })

  test.each(['json', 'utf8', 'torn', 'torn-utf8'] as const)('%s damage is quarantined byte for byte, appended at one UTC path and never completed by a later append', async kind => {
    const h = fixture(), fact = h.fact(), damaged = damagedThreadLine(joinRecord(fact, 3), kind)
    const valid = [threadHeader(), joinRecord(fact)]
    seedThreads(h.stateDir, [...valid, damaged]); h.memory.readAtStart()
    const quarantine = h.events.find(e => e.type === 'lines-quarantined')!
    expect(quarantine.type).toBe('lines-quarantined')
    if (quarantine.type !== 'lines-quarantined') throw new Error('missing quarantine event')
    expect(quarantine.quarantinePath).toBe(join(h.stateDir, 'threads', `alpha.unreadable-${new Date(THREAD_TIME).toISOString().replace(/:/g, '-')}`))
    expect(readFileSync(quarantine.quarantinePath).equals(damaged)).toBe(true)
    expect(statSync(quarantine.quarantinePath).mode & 0o777).toBe(THREAD_MEMORY_FILE_MODE)
    expect(h.memory.readFacts('alpha').quarantined).toEqual([{ line: 3, invalidFinalLine: true, channel: C.primary, root: R.primary }])
    // Another read in this same startup appends to the same evidence file.
    h.memory.forget('alpha'); await h.memory.loadKey('alpha')
    expect(readFileSync(quarantine.quarantinePath)).toEqual(Buffer.concat([damaged, ...(damaged.at(-1) === 10 ? [] : [Buffer.from('\n')]), damaged]))
    await h.memory.saveJoins('alpha', [h.fact({ root: R.secondary })])
    expect(savedJoins(h).map(r => r.root)).toEqual([R.primary, R.secondary])
    expect(journalBytes(h).includes(damaged)).toBe(false)
    const reopened = fixture({ reopen: true }, h.stateDir); await reopened.start()
    expect(reopened.memory.readFacts('alpha').quarantined).toEqual([])
    expect(view(reopened, R.secondary)).toBe('joined')
  })

  test('nonfinal damage keeps its line number and a failed torn-tail truncation prevents appends until retry', async () => {
    const h = fixture(), fact = h.fact()
    const bad = damagedThreadLine(joinRecord(fact, 2), 'json'), tail = damagedThreadLine(joinRecord(fact, 9), 'torn-utf8')
    const bytes = seedThreads(h.stateDir, [threadHeader(), bad, joinRecord(fact, 3), tail])
    h.io.fail('ftruncateSync'); await h.start()
    expect(h.memory.readFacts('alpha').quarantined).toEqual([
      { line: 2, invalidFinalLine: false, channel: C.primary, root: R.primary },
      { line: 4, invalidFinalLine: true, channel: C.primary, root: R.primary },
    ])
    expect((await h.memory.saveJoins('alpha', [h.fact({ root: R.secondary })])).kind).toBe('failed')
    expect(journalBytes(h).equals(bytes)).toBe(true)
    h.io.heal(); expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(journalBytes(h).includes(tail)).toBe(false)
    await h.memory.compact(); expect(savedJoins(h).map(r => r.root)).toEqual([R.primary, R.secondary])
  })

  test('unreadable journal retains its cause, merges in-memory joins on load, and skips compaction until readable', async () => {
    const h = fixture(), disk = h.fact({ at: THREAD_TIME + 10 })
    seedThreads(h.stateDir, [threadHeader(), joinRecord(disk)])
    const cause = h.io.fail('readFileSync'); await h.start()
    expect(view(h)).toBe('unknown'); expect(h.memory.readFacts('alpha').error).toBe(cause)
    const earlier = { ...disk, at: THREAD_TIME }, other = h.fact({ root: R.secondary })
    expect(await h.memory.saveJoins('alpha', [earlier, other])).toEqual({ kind: 'kept' })
    expect(view(h)).toBe('joined'); expect(view(h, R.third)).toBe('unknown')
    h.io.reset(); await h.memory.compact(); expect(h.io.writes()).toEqual([])
    h.io.heal(); await h.memory.loadKey('alpha')
    expect(h.memory.readFacts('alpha').error).toBeUndefined()
    expect(h.memory.joins('alpha')).toEqual([{ join: earlier, savedAt: disk.at }, { join: other }])
    expect(h.memory.isJoinSaved('alpha', earlier)).toBe(false)
    expect(h.memory.isJoinSaved('alpha', disk)).toBe(true)
    expect(savedJoins(h)).toEqual([joinRecord(disk)])
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(h.memory.isJoinSaved('alpha', earlier)).toBe(true)
  })

  test('missing files are empty; failed listing reads applied paths; live load is a no-op and forget forces reread', async () => {
    const h = fixture(); const fact = h.fact()
    seedThreads(h.stateDir, [threadHeader(), joinRecord(fact)])
    h.io.fail('readdirSync', 'alpha', { match: path => path === join(h.stateDir, 'threads') })
    await h.start(); expect(view(h)).toBe('joined')
    expect(h.io.calls.filter(c => c.op === 'readFileSync').map(c => c.path)).toEqual([threadPath(h.stateDir)])
    h.io.reset(); await h.memory.loadKey('alpha'); expect(h.io.calls).toEqual([])
    h.memory.forget('alpha'); expect(view(h)).toBe('not-joined')
    await h.memory.loadKey('alpha'); expect(view(h)).toBe('joined')
    expect(h.io.calls.filter(c => c.op === 'readFileSync')).toHaveLength(1)
    const empty = fixture(); await empty.start()
    expect(view(empty)).toBe('not-joined'); expect(empty.memory.readFacts('alpha').error).toBeUndefined()
  })

  test.each(['off', 'mentions', 'all'] as const)('existing journals under %s still load at startup, after forget and at later addition', async delivery => {
    const h = fixture(), fact = h.fact(), header = threadHeader(), intent = postIntent(fact)
    seedThreads(h.stateDir, [header, joinRecord(fact), intent])
    expect(h.choose(delivery).kind).toBe('applied')
    await h.start()
    expect(h.io.calls.filter(c => c.op === 'readFileSync').map(c => c.path)).toEqual([threadPath(h.stateDir)])
    const store = h.memory.store('alpha')
    expect(store).toMatchObject({ storeId: header.storeId, lastRecordNumber: intent.seq, readable: true, created: true })
    expect(h.memory.joins('alpha')).toEqual([])
    expect(h.memory.unresolvedIntents('alpha')).toEqual([intent])
    h.io.reset(); await h.memory.loadKey('alpha'); expect(h.io.calls).toEqual([])
    h.memory.forget('alpha'); await h.memory.loadKey('alpha')
    expect(h.io.calls.filter(c => c.op === 'readFileSync').map(c => c.path)).toEqual([threadPath(h.stateDir)])
    expect(h.memory.store('alpha')).toEqual(store)
    expect(h.memory.unresolvedIntents('alpha')).toEqual([intent])

    const laterHeader = threadHeader({ storeId: 'later-store' })
    seedThreads(h.stateDir, [laterHeader, intent], 'beta')
    expect(h.apply(threadConfig(h.stateDir, delivery, ['alpha', 'beta'])).kind).toBe('applied')
    h.io.reset(); await h.memory.loadKey('beta')
    expect(h.io.calls.filter(c => c.op === 'readFileSync').map(c => c.path)).toEqual([threadPath(h.stateDir, 'beta')])
    expect(h.memory.store('beta')).toMatchObject({ storeId: laterHeader.storeId, lastRecordNumber: intent.seq, readable: true, created: true })
    expect(h.memory.unresolvedIntents('beta')).toEqual([intent])
    expect(readThreads(h.stateDir, 'beta')).toEqual([{ ...laterHeader, highWater: intent.seq }, intent])
    expect(h.events.some(e => e.type === 'read-failed')).toBe(false)
  })

  test.each(['off', 'mentions', 'all'] as const)('a genuinely unreadable %s journal stays unknown when a later read finds it missing, until real evidence returns', async delivery => {
    const h = fixture(), header = threadHeader(), intent = postIntent(h.fact())
    seedThreads(h.stateDir, [header, intent])
    expect(h.choose(delivery).kind).toBe('applied')
    const cause = h.io.fail('readFileSync', 'alpha', { code: 'EACCES' }); await h.start()
    expect(h.memory.store('alpha')).toMatchObject({ readable: false, created: false })
    expect(h.memory.readFacts('alpha').error).toBe(cause)
    expect(h.events).toEqual([{ type: 'read-failed', key: 'alpha', path: threadPath(h.stateDir), error: cause }])
    expect(h.io.writes()).toEqual([])

    rmSync(threadPath(h.stateDir)); h.io.heal(); h.io.reset()
    await h.memory.loadKey('alpha'); await h.memory.compact()
    expect(h.io.calls.filter(c => c.op === 'readFileSync').map(c => c.path)).toEqual([threadPath(h.stateDir)])
    expect(h.memory.readFacts('alpha').error).toMatchObject({ code: 'ENOENT' })
    expect(h.memory.store('alpha')).toMatchObject({ readable: false, created: false })
    expect(h.events.at(-1)).toMatchObject({ type: 'read-failed', key: 'alpha', error: { code: 'ENOENT' } })
    expect(h.choose('thread_hybrid').kind).toBe('applied'); await h.clock.flush()
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'kept' })
    expect(view(h)).toBe('unknown')
    expect(h.io.writes()).toEqual([]); expect(h.markerCalls).toEqual([])
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    expect(h.authority.threadMemoryCreated('alpha')).toBe(false)

    seedThreads(h.stateDir, [header, intent]); await h.memory.loadKey('alpha')
    expect(h.memory.readFacts('alpha').error).toBeUndefined()
    expect(h.memory.store('alpha')).toMatchObject({ storeId: header.storeId, readable: true, created: true })
    expect(h.memory.unresolvedIntents('alpha')).toEqual([intent])
    expect(view(h)).toBe('not-joined'); expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(h.authority.threadMemoryCreated('alpha')).toBe(true)
  })

  test.each(['openSync', 'writeSync', 'fsync'] as const)('failed %s append preserves in-memory selection and flush saves all kept facts in one append', async op => {
    const h = fixture(); await h.start(); const before = journalBytes(h)
    const first = h.fact(), second = h.fact({ root: R.secondary })
    const error = h.io.fail(op)
    expect((await h.memory.saveJoins('alpha', [first, second])).kind).toBe('failed')
    expect(journalBytes(h)).toEqual(before)
    expect([view(h), view(h, R.secondary)]).toEqual(['joined', 'joined'])
    expect(h.memory.keptFacts('alpha')).toEqual([first, second]); expect(h.memory.isJoinSaved('alpha', first)).toBe(false)
    expect(h.events.at(-1)).toEqual({ type: 'append-failed', key: 'alpha', path: threadPath(h.stateDir), step: 'journal-append', error, noticeOnly: false })
    h.io.heal(); h.io.reset(); expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(h.io.calls.filter(c => c.op === 'writeSync' && c.path === threadPath(h.stateDir))).toHaveLength(1)
    expect(savedJoins(h)).toEqual([joinRecord(first, 2), joinRecord(second, 3)])
    expect(h.memory.keptFacts('alpha')).toEqual([])
    expect(h.events.at(-1)).toEqual({ type: 'saved-after-failure', key: 'alpha', path: threadPath(h.stateDir) })
  })

  test.each((['fails', 'succeeds after an earlier failure'] as const).flatMap(outcome => [[outcome, 'forgotten'], [outcome, 'still its own']] as const))('an append whose sync is held %s, its journal %s meanwhile: only its own journal reports the outcome', async (outcome, life) => {
    const h = fixture(), forgotten = life === 'forgotten'; await h.start()
    if (outcome !== 'fails') {
      h.io.fail('writeSync'); expect((await h.memory.saveJoins('alpha', [h.fact()])).kind).toBe('failed'); h.io.heal()
    }
    const events = h.events.length, sync = h.io.hold('fsync', 'alpha', { match: path => path === threadPath(h.stateDir) })
    // A flush saves every kept fact, so its success is the one that would report saved-after-failure.
    const saving = outcome === 'fails' ? h.memory.saveJoins('alpha', [h.fact({ root: R.secondary })]) : h.memory.flush('alpha')
    await sync.reached
    if (forgotten) h.memory.forget('alpha')
    if (outcome === 'fails') sync.fail(Object.assign(new Error('fixture fsync refused'), { code: 'EIO' }))
    else sync.release()
    expect((await saving).kind).toBe(outcome === 'fails' ? 'failed' : 'saved')
    const reported = h.events.slice(events).filter(e => e.type === 'append-failed' || e.type === 'saved-after-failure').map(e => e.type)
    expect(reported).toEqual(forgotten ? [] : [outcome === 'fails' ? 'append-failed' : 'saved-after-failure'])
  })

  test.each(['journal', 'marker'] as const)('failed %s creation keeps joins until flush completes journal then real marker', async step => {
    const h = fixture()
    if (step === 'journal') h.io.fail('writeSync')
    else h.failShared(() => 'before')
    await h.start(); const fact = h.fact()
    expect(h.events.some(e => e.type === 'creation-failed')).toBe(true)
    expect(h.authority.threadMemoryCreated('alpha')).toBe(false)
    expect(await h.memory.saveJoins('alpha', [fact])).toEqual({ kind: 'kept' }); expect(view(h)).toBe('joined')
    h.io.heal(); h.failShared()
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(h.authority.threadMemoryCreated('alpha')).toBe(true)
    expect(savedJoins(h)).toEqual([joinRecord(fact, 2)])
    expect(h.memory.keptFacts('alpha')).toEqual([])
  })

  test.each(['forget', 'remove', 'stop'] as const)('%s cancels a previously queued append and refuses later writes', async action => {
    const h = fixture(); await h.start(); const fact = h.fact(), before = journalBytes(h)
    h.io.reset(); const pending = h.memory.saveJoins('alpha', [fact])
    await h.memory[action]('alpha')
    expect(await pending).toEqual({ kind: 'cancelled' })
    expect(h.io.calls.filter(c => c.op === 'writeSync')).toEqual([])
    expect(await h.memory.saveJoins('alpha', [fact])).toEqual({ kind: 'cancelled' })
    if (action === 'remove') expect(existsSync(threadPath(h.stateDir))).toBe(false)
    else expect(journalBytes(h)).toEqual(before)
  })

  test('remove unlinks before clearing the real marker; failed unlink is retried for an unapplied key on restart', async () => {
    const h = fixture(); await h.start(); await h.memory.saveJoins('alpha', [h.fact()])
    const error = h.io.fail('unlinkSync'); const before = journalBytes(h)
    expect(h.apply(threadConfig(h.stateDir, 'all', ['beta'])).kind).toBe('applied')
    expect((await h.memory.remove('alpha')).kind).toBe('failed')
    expect(journalBytes(h)).toEqual(before); expect(h.authority.threadMemoryCreated('alpha')).toBe(true)
    expect(h.markerCalls.filter(c => c.action === 'clear')).toEqual([])
    expect(h.events.at(-1)).toEqual({ type: 'removal-failed', key: 'alpha', path: threadPath(h.stateDir), step: 'journal-unlink', error })
    const reopened = fixture({ reopen: true }, h.stateDir); await reopened.start()
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    expect(reopened.authority.threadMemoryCreated('alpha')).toBe(false)
    expect(reopened.markerCalls).toEqual([{ action: 'clear', key: 'alpha', fileExists: false, synced: false }])
    expect(reopened.events.at(-1)).toEqual({ type: 'removed', key: 'alpha', path: threadPath(h.stateDir) })
  })

  test.each(['journal', 'marker'] as const)('startup cleans an unapplied %s even when its companion is missing', async evidence => {
    const h = fixture()
    if (evidence === 'journal') seedThreads(h.stateDir, [threadHeader()])
    else expect(h.authority.setThreadMemoryCreated('alpha').kind).toBe('saved')
    expect(h.apply(threadConfig(h.stateDir, 'all', ['beta'])).kind).toBe('applied')
    await h.start()
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    expect(h.authority.threadMemoryCreated('alpha')).toBe(false)
    expect(h.events.some(e => e.type === 'removed' && e.key === 'alpha')).toBe(true)
  })

  test('a removal guard preserves old-key evidence until reviewed removal is allowed', async () => {
    let allowed = false
    const h = fixture({ canRemove: () => allowed })
    seedThreads(h.stateDir, [threadHeader()]); expect(h.authority.setThreadMemoryCreated('alpha').kind).toBe('saved')
    expect(h.apply(threadConfig(h.stateDir, 'all', ['beta'])).kind).toBe('applied')
    const bytes = journalBytes(h); await h.start()
    expect(journalBytes(h)).toEqual(bytes); expect(h.authority.threadMemoryCreated('alpha')).toBe(true)
    allowed = true; await h.memory.removeUnappliedAtStart()
    expect(existsSync(threadPath(h.stateDir))).toBe(false); expect(h.authority.threadMemoryCreated('alpha')).toBe(false)
  })

  test('dry run reads, judges and keeps facts without any journal, quarantine, marker or removal write', async () => {
    const h = fixture({ dryRun: true }), fact = h.fact()
    const before = seedThreads(h.stateDir, [threadHeader(), joinRecord(fact), damagedThreadLine(joinRecord(fact, 3), 'torn')])
    seedThreads(h.stateDir, [threadHeader()], 'removed')
    const shared = readFileSync(h.authority.path)
    await h.start(); expect(view(h)).toBe('joined')
    expect(h.memory.readFacts('alpha').quarantined).toHaveLength(1)
    const kept = h.fact({ root: R.secondary })
    expect(await h.memory.saveJoins('alpha', [kept])).toEqual({ kind: 'kept' })
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'kept' })
    await h.memory.compact(); await h.memory.remove('alpha')
    expect(h.io.writes()).toEqual([]); expect(h.markerCalls).toEqual([])
    expect(journalBytes(h).equals(before)).toBe(true); expect(readFileSync(h.authority.path)).toEqual(shared)
    expect(readdirSync(join(h.stateDir, 'threads')).sort()).toEqual(['alpha.jsonl', 'removed.jsonl'])
    expect(h.events.filter(e => e.type.endsWith('failed'))).toEqual([])
    const empty = fixture({ dryRun: true }); await empty.start()
    expect(existsSync(join(empty.stateDir, 'threads'))).toBe(false); expect(empty.events).toEqual([])
  })

  describe('own-post intents and outcomes', () => {
    function intent(fact: ThreadJoin, operationId = 'own-post'): OwnPostIntent {
      return { operationId, channel: fact.channel, root: fact.root, stamp: { ...fact.stamp }, at: fact.at,
        content: { kind: 'text', text: `private own-post ${LEAK_SENTINEL}` } }
    }
    function expectPrivate(h: ThreadMemoryHarness) {
      assertNoLeak({ journal: writtenFile(threadPath(h.stateDir)), events: h.events, logs: h.logs, posts: h.posts,
        intents: h.memory.unresolvedIntents('alpha'), kept: h.memory.keptFacts('alpha'), joins: h.memory.joins('alpha') })
    }

    test.each([
      ['  &amp; &lt;  ', '& <'],
      ['  &gt;  ', '>'],
      ['\n<https://example.test/a?b=1&amp;c=2>\t', 'https://example.test/a?b=1&c=2'],
      [' <https://example.test/a|a label> ', 'https://example.test/a'],
      ['&lt;https://example.test/a|escaped label&gt;', 'https://example.test/a'],
      [' <@U123|name> <#C123|channel> ', '@U123 #C123'],
      ['  first  line\nsecond line  ', 'first  line\nsecond line'],
    ])('normalises Slack text %s for the same digest', (text, normalised) => {
      expect(normaliseOwnPostText(text)).toBe(normalised)
      const key = threadHeader().digestKey
      expect(ownPostDigest(key, { kind: 'text', text })).toBe(ownPostDigest(key, { kind: 'text', text: normalised }))
    })

    test('digests use each store key and distinguish text, file names and byte sizes', async () => {
      const h = fixture(); expect(h.memory.digestKey('alpha')).toBeUndefined()
      expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
      await h.start()
      const alpha = h.memory.digestKey('alpha')!, beta = h.memory.digestKey('beta')!
      expect(alpha).toBe(readThreads(h.stateDir).find(r => r.kind === 'header')!.digestKey)
      expect(alpha).not.toBe(beta)
      const content = { kind: 'file' as const, name: 'report.txt', size: 42 }
      const digest = ownPostDigest(alpha, content)
      expect(digest).toMatch(/^[a-f0-9]{64}$/)
      expect(digest).toBe(ownPostDigest(alpha, { ...content }))
      expect(new Set([digest, ownPostDigest(beta, content),
        ownPostDigest(alpha, { ...content, name: 'other.txt' }), ownPostDigest(alpha, { ...content, size: 43 }),
        ownPostDigest(alpha, { kind: 'text', text: content.name }),
        ownPostDigest(alpha, { kind: 'text', text: JSON.stringify([content.name, content.size]) }),
      ]).size).toBe(6)
      expect(ownPostDigest(alpha, { kind: 'text', text: 'first' })).not.toBe(ownPostDigest(alpha, { kind: 'text', text: 'second' }))
      await h.close(); const next = fixture({ reopen: true }, h.stateDir); await next.start()
      expect(next.memory.digestKey('alpha')).toBe(alpha)
      expect(ownPostDigest(next.memory.digestKey('alpha')!, content)).toBe(digest)
    })

    test.each(['content', 'digest'] as const)('saves every intent field from %s, including an optional root, before ready settles', async kind => {
      const h = fixture(); await h.start(); const fact = h.fact(), before = readThreads(h.stateDir)
      const content = { kind: 'text' as const, text: `private intent ${LEAK_SENTINEL}` }
      const digest = ownPostDigest(h.memory.digestKey('alpha')!, content)
      for (const root of [fact.root, undefined]) {
        const operationId = root ? 'parent-post' : 'channel-post'
        const input = { operationId, channel: fact.channel, ...(root ? { root } : {}), at: fact.at, stamp: fact.stamp,
          ...(kind === 'content' ? { content } : { digest }), text: LEAK_SENTINEL }
        h.io.reset()
        const kept = h.memory.keepIntent('alpha', input)
        expect(kept.kept).toBe(true)
        if (!kept.kept) throw new Error('intent refused')
        expect(kept.ready).toBeDefined(); expect(h.memory.intentSaved('alpha', operationId)).toBe(false)
        expect(h.io.writes()).toEqual([])
        expect(await kept.ready).toBe('saved')
        const record = postIntent(fact, { operationId, root, at: input.at, digest, seq: before.length + (root ? 1 : 2) })
        expect(readThreads(h.stateDir).at(-1)).toEqual(record)
        expect(h.memory.unresolvedIntents('alpha', C.primary)).toContainEqual(record)
        expect(h.memory.intentSaved('alpha', operationId)).toBe(true)
        expect(h.memory.keepIntent('alpha', input)).toEqual({ kept: false })
        expectPrivate(h)
      }
      expect(h.memory.intentSaved('alpha', 'never-kept')).toBe(false)
      await h.close(); const next = fixture({ reopen: true }, h.stateDir); await next.start()
      expect(next.memory.unresolvedIntents('alpha')).toEqual(readThreads(next.stateDir).filter(r => r.kind === 'post-intent'))
    })

    test('an append waiting behind creation is not a failed-save episode and both intents get ready promises', async () => {
      const held = gate(); let h!: ThreadMemoryHarness
      h = fixture({ setCreated: async key => { await held.wait(); return h.authority.setThreadMemoryCreated(key) } })
      const starting = h.start(); await held.entered
      try {
        expect(h.memory.digestKey('alpha')).toBeDefined()
        const first = h.memory.keepIntent('alpha', intent(h.fact(), 'first'))
        const second = h.memory.keepIntent('alpha', intent(h.fact(), 'second'))
        expect(first.kept && first.ready).toBeInstanceOf(Promise)
        expect(second.kept && second.ready).toBeInstanceOf(Promise)
        let settled = false
        if (second.kept) void second.ready?.then(() => { settled = true })
        h.io.reset(); await h.clock.flush()
        expect(settled).toBe(false); expect(h.memory.saveBlocked('alpha')).toBe(false)
        expect(h.io.writes()).toEqual([])
        held.release(); await starting
        expect(first.kept && await first.ready).toBe('saved')
        expect(second.kept && await second.ready).toBe('saved')
        expect(readThreads(h.stateDir).filter(r => r.kind === 'post-intent').map(r => r.operationId)).toEqual(['first', 'second'])
      } finally { held.release(); await starting }
      expectPrivate(h)
    })

    test.each((['mention', 'own-post'] as const).flatMap(predecessor =>
      (['current', 'stale'] as const).map(outcome => [predecessor, outcome] as const)))
    ('an undecided %s predecessor cannot bypass a healthy intent append and resumes with a %s stamp', async (predecessor, outcome) => {
      const h = fixture({ failureHandling: true })
      expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], [C.primary, C.secondary])).kind).toBe('applied')
      await h.start()
      let serial = 0
      // Eligibility is fixed here to isolate the store writer; choices and
      // stamps still come from the real authority, as do its publications.
      const owner = createOwnPostJoins({ memory: h.memory, lookupSlackKey: () => undefined,
        eligibility: () => ({ kind: 'eligible', mode: 'strict', delivery: 'thread_hybrid' }),
        choice: (key, channel) => h.authority.readableFor(key, channel)
          ? { readable: true, choice: h.authority.choice(key, channel) } : { readable: false },
        now: h.clock.now, operationId: () => `predecessor-post-${++serial}`, isDryRun: () => false })
      const content = { kind: 'text' as const, text: `private predecessor ${LEAK_SENTINEL}` }
      try {
        let fact = h.fact(), predecessorId: string | undefined
        let mentionSave: ReturnType<typeof h.memory.saveJoins> | undefined
        if (predecessor === 'mention') {
          expect(h.memory.addJoin('alpha', fact)).toBe(true)
          mentionSave = h.memory.saveJoins('alpha', [fact])
        } else {
          const first = owner.startOperation('alpha', 'text', { channel: C.primary, parent: R.primary }, content)!
          expect(first.ready).toBeInstanceOf(Promise); await first.ready
          predecessorId = h.memory.unresolvedIntents('alpha', C.primary)[0]!.operationId
          owner.endOperation(first.operation, { kind: 'confirmed', channel: C.primary, ts: R.primary })
          fact = h.memory.keptFacts('alpha')[0]!
        }
        // No await between queueing the predecessor and making its stamp
        // undecided: its writer must encounter that undecided publication.
        h.failShared(() => 'unsynced')
        expect(h.choose(outcome === 'current' ? 'thread_hybrid' : 'mentions').kind).toBe('unresolved')
        expect(h.authority.channelStamp('alpha', C.primary)).toEqual({ kind: 'undecided' })
        const healthy = h.fact({ channel: C.secondary, root: R.secondary })
        expect(h.authority.channelStamp('alpha', C.secondary)).toEqual({ kind: 'decided', ...healthy.stamp })
        const before = readThreads(h.stateDir)
        h.io.reset()
        const later = owner.startOperation('alpha', 'text', { channel: C.secondary, parent: healthy.root }, content)!
        expect(later.ready).toBeInstanceOf(Promise)
        const pending = h.memory.unresolvedIntents('alpha', C.secondary)[0]!
        expect(h.memory.intentSaved('alpha', pending.operationId)).toBe(false)
        expect(readThreads(h.stateDir)).toEqual(before)
        const saved = postIntent(healthy, { ...pending, digest: ownPostDigest(h.memory.digestKey('alpha')!, content), seq: before.at(-1)!.seq + 1 })
        // Read at the caller's readiness boundary, before any explicit flush
        // or stamp recovery could hide a premature settlement.
        await later.ready!.then(() => {
          expect(readThreads(h.stateDir)).toEqual([...before, saved])
          expect(h.memory.intentSaved('alpha', pending.operationId)).toBe(true)
          expect(h.io.calls.filter(c => c.path === threadPath(h.stateDir) && c.op === 'writeSync')).toHaveLength(1)
          expect(h.io.calls.filter(c => c.path === threadPath(h.stateDir) && c.op === 'fsync')).toHaveLength(1)
        })
        if (mentionSave) expect(await mentionSave).toEqual({ kind: 'kept' })
        await h.clock.flush()
        expect(h.memory.keptFacts('alpha')).toEqual([fact])
        expect(savedJoins(h)).toEqual([])
        expect(h.memory.saveBlocked('alpha')).toBe(false)
        expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: predecessor === 'mention' ? 1 : 2, missing: false })
        // Compaction must retain the saved intents, leaving the undecided
        // join/outcome batch in memory for the later authority decision.
        await h.memory.compact()
        expect(readThreads(h.stateDir).slice(1)).toEqual([...before.slice(1), saved])
        expect(h.memory.keptFacts('alpha')).toEqual([fact])
        h.io.reset(); const beforeDecision = journalBytes(h)
        h.failShared(); expect(h.authority.recoverDurability().kind).toBe('applied')
        expect(view(h)).toBe(outcome === 'current' ? 'joined' : 'not-joined')
        expect(journalBytes(h)).toEqual(beforeDecision)
        // Own-post batches resume on publication alone. Mention joins retain
        // the queue caller's explicit save path after the stamp is decided.
        if (predecessor === 'mention') expect(await h.memory.saveJoins('alpha', [fact])).toEqual({ kind: 'saved' })
        await h.clock.flush()
        const resumed = readThreads(h.stateDir).slice(before.length + 1)
        const nextSeq = saved.seq + 1
        expect(resumed).toEqual([
          ...(outcome === 'current' ? [joinRecord(fact, nextSeq)] : []),
          ...(predecessorId ? [postOutcome(postIntent(fact, { operationId: predecessorId }),
            outcome === 'current' ? 'joined' : 'none', nextSeq + Number(outcome === 'current'))] : []),
        ])
        const appends = predecessor === 'mention' && outcome === 'stale' ? 0 : 1
        expect(h.io.calls.filter(c => c.path === threadPath(h.stateDir) && c.op === 'writeSync')).toHaveLength(appends)
        expect(h.io.calls.filter(c => c.path === threadPath(h.stateDir) && c.op === 'fsync')).toHaveLength(appends)
        expect(h.memory.keptFacts('alpha')).toEqual([])
        expect(h.memory.unresolvedIntents('alpha')).toEqual([saved])
        expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 0, missing: false })
        expect(h.memory.saveBlocked('alpha')).toBe(false)
        expect(h.events.every(event => ['created', 'outage-settled', 'compacted'].includes(event.type))).toBe(true)
        expect(h.retryEvents).toEqual([]); expect(h.posts).toEqual([]); expect(h.logs).toEqual([])
        expect(h.clock.pendingCount()).toBe(0)
        const settled = journalBytes(h)
        await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
        expect(journalBytes(h)).toEqual(settled)
        expectPrivate(h)
        await h.close()
        const reopened = fixture({ reopen: true }, h.stateDir); await reopened.start()
        expect(view(reopened)).toBe(outcome === 'current' ? 'joined' : 'not-joined')
        expect(reopened.memory.unresolvedIntents('alpha')).toEqual([saved])
      } finally { owner.stop() }
    })

    test.each((['intent', 'outcome'] as const).flatMap(append => [1, 3].map(publications => [append, publications] as const)))
    ('queued publications cannot retry a failed %s append before the minimum delay (%i publications)', async (append, publications) => {
      const h = fixture({ failureHandling: true }); await h.start()
      const fact = h.fact(), input = intent(fact)
      if (append === 'outcome') {
        const kept = h.memory.keepIntent('alpha', input)
        expect(kept.kept && await kept.ready).toBe('saved')
      }
      const before = readThreads(h.stateDir), beforeBytes = journalBytes(h), startedAt = h.clock.now()
      h.io.reset()
      h.io.fail('writeSync', 'alpha', { times: publications === 1 ? 1 : Infinity })
      const kept = append === 'intent' ? h.memory.keepIntent('alpha', input) : undefined
      if (append === 'outcome') expect(h.memory.resolveIntent('alpha', input.operationId, { joined: fact })).toBe('joined')
      // The authority publishes while j.failed is still false, before the
      // first queued append runs. Reassigning hybrid preserves this stamp.
      for (let i = 0; i < publications; i++) expect(h.choose('thread_hybrid').kind).toBe('applied')
      if (kept) expect(kept.kept && await kept.ready).toBe('failed')
      await h.clock.flush()
      const attempts = () => h.io.calls.filter(c => c.path === threadPath(h.stateDir) && c.op === 'writeSync')
      expect(h.clock.now()).toBe(startedAt)
      expect(attempts()).toHaveLength(1)
      expect(journalBytes(h)).toEqual(beforeBytes)
      expect(h.events.filter(event => event.type === 'append-failed')).toHaveLength(1)
      expect(h.memory.saveBlocked('alpha')).toBe(true)
      expect(h.clock.pending().map(timer => timer.delayMs)).toEqual([THREAD_MEMORY_RETRY_MIN_MS])
      await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS - 1)
      expect(attempts()).toHaveLength(1); expect(journalBytes(h)).toEqual(beforeBytes)
      h.io.heal(); await h.clock.advance(1)
      expect(attempts()).toHaveLength(2)
      const records = readThreads(h.stateDir), added = records.slice(before.length)
      if (append === 'intent') {
        expect(added).toEqual([postIntent(fact, { operationId: input.operationId,
          digest: ownPostDigest(h.memory.digestKey('alpha')!, { kind: 'text', text: `private own-post ${LEAK_SENTINEL}` }), seq: 2 })])
        expect(h.memory.intentSaved('alpha', input.operationId)).toBe(true)
      } else {
        const ownJoin = h.memory.joins('alpha')[0]!.join
        expect(added).toEqual([joinRecord(ownJoin, 3), { v: 1, kind: 'post-outcome', operationId: input.operationId, outcome: 'joined', seq: 4 }])
        expect(h.memory.isJoinSaved('alpha', ownJoin)).toBe(true)
        expect(h.memory.unresolvedIntents('alpha')).toEqual([])
      }
      expect(h.memory.saveBlocked('alpha')).toBe(false)
      expect(h.events.filter(event => event.type === 'append-failed')).toHaveLength(1)
      expect(h.retryEvents).toContainEqual({ type: 'saved-after-retries', key: 'alpha', attempts: 1 })
      expect(h.clock.pendingCount()).toBe(0)
      await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
      expect(readThreads(h.stateDir)).toEqual(records); expect(attempts()).toHaveLength(2)
      expectPrivate(h)
    })

    test.each(['writeSync', 'fsync'] as const)('failed intent %s settles failed, later intents do not wait, and retries preserve fact order exactly once', async op => {
      const h = fixture({ failureHandling: true }); await h.start()
      const fact = h.fact(), first = intent(fact, 'first'), second = intent(h.fact({ root: R.secondary }), 'second')
      h.memory.addJoin('alpha', fact)
      const before = journalBytes(h), error = h.io.fail(op)
      const kept = h.memory.keepIntent('alpha', first)
      expect(kept.kept && kept.ready).toBeInstanceOf(Promise)
      expect(kept.kept && await kept.ready).toBe('failed')
      expect(h.events).toContainEqual({ type: 'append-failed', key: 'alpha', path: threadPath(h.stateDir), step: 'journal-append', error, noticeOnly: false })
      expect(h.memory.saveBlocked('alpha')).toBe(true); expect(h.memory.intentSaved('alpha', 'first')).toBe(false)
      h.io.reset()
      expect(h.memory.keepIntent('alpha', second)).toEqual({ kept: true })
      await h.clock.flush(); expect(h.io.writes()).toEqual([]); expect(journalBytes(h)).toEqual(before)
      expect(h.memory.unresolvedIntents('alpha').map(i => i.operationId)).toEqual(['first', 'second'])
      h.io.heal()
      await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS - 1)
      expect(journalBytes(h)).toEqual(before)
      await h.clock.advance(1)
      const records = readThreads(h.stateDir)
      expect(records.map(r => r.kind)).toEqual(['header', 'join', 'post-intent', 'post-intent'])
      expect(records.map(r => r.seq)).toEqual([1, 2, 3, 4])
      expect(records.filter(r => r.kind === 'post-intent').map(r => r.operationId)).toEqual(['first', 'second'])
      expect(h.memory.intentSaved('alpha', 'first')).toBe(true); expect(h.memory.intentSaved('alpha', 'second')).toBe(true)
      expect(h.memory.saveBlocked('alpha')).toBe(false); expect(h.memory.keptFacts('alpha')).toEqual([])
      expect(h.retryEvents).toContainEqual({ type: 'saved-after-retries', key: 'alpha', attempts: 1 })
      await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS); expect(readThreads(h.stateDir)).toEqual(records)
      expectPrivate(h)
    })

    test('a failed creation keeps an intent without waiting and the existing retry saves it after the header', async () => {
      const h = fixture({ failureHandling: true }); h.io.fail('writeSync'); await h.start()
      expect(h.memory.saveBlocked('alpha')).toBe(true)
      const key = h.memory.digestKey('alpha'); expect(key).toBeDefined()
      h.io.reset(); expect(h.memory.keepIntent('alpha', intent(h.fact()))).toEqual({ kept: true })
      await h.clock.flush(); expect(h.io.writes()).toEqual([])
      h.io.heal(); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
      expect(readThreads(h.stateDir).map(r => r.kind)).toEqual(['header', 'post-intent'])
      expect(h.memory.digestKey('alpha')).toBe(key); expect(h.memory.intentSaved('alpha', 'own-post')).toBe(true)
      expectPrivate(h)
    })

    test('first successful read digests unknown-key intents, merges disk facts and saves memory-only joins without traffic', async () => {
      const h = fixture({ failureHandling: true }), fact = h.fact(), disk = postIntent(fact, { operationId: 'disk', seq: 2 })
      const header = threadHeader({ digestKey: 'ef'.repeat(32) })
      seedThreads(h.stateDir, [header, disk]); expect(h.authority.setThreadMemoryCreated('alpha').kind).toBe('saved')
      h.io.fail('readFileSync'); await h.start(); expect(h.memory.digestKey('alpha')).toBeUndefined()
      const unresolved = intent(fact, 'unresolved'), resolved = intent(fact, 'resolved')
      h.io.reset()
      expect(h.memory.keepIntent('alpha', unresolved)).toEqual({ kept: true })
      expect(h.memory.keepIntent('alpha', resolved)).toEqual({ kept: true })
      expect(h.memory.unresolvedIntents('alpha').every(i => i.digest === undefined)).toBe(true)
      expect(h.memory.resolveIntent('alpha', 'resolved', { joined: fact })).toBe('joined')
      expect(h.memory.hasKeptJoin('alpha', C.primary, R.primary)).toBe(true)
      expect(h.memory.hasKeptJoin('alpha', C.primary, R.secondary)).toBe(false)
      expect(h.memory.memoryOnlyOwnPostJoins('alpha')).toEqual([{ channel: C.primary, root: R.primary }])
      expect(h.memory.intentSaved('alpha', 'resolved')).toBe(false)
      await h.clock.flush(); expect(h.io.writes()).toEqual([])
      expectPrivate(h)
      h.io.heal(); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
      expect(h.memory.digestKey('alpha')).toBe(header.digestKey)
      const expectedDigest = ownPostDigest(header.digestKey, { kind: 'text', text: `private own-post ${LEAK_SENTINEL}` })
      const records = readThreads(h.stateDir)
      expect(records.map(r => r.kind)).toEqual(['header', 'post-intent', 'post-intent', 'post-intent', 'join', 'post-outcome'])
      expect(records.filter(r => r.kind === 'post-intent').slice(1).map(r => r.digest)).toEqual([expectedDigest, expectedDigest])
      expect(h.memory.unresolvedIntents('alpha').map(i => i.operationId)).toEqual(['disk', 'unresolved'])
      expect(h.memory.unresolvedIntents('alpha').find(i => i.operationId === 'unresolved')!.digest).toBe(expectedDigest)
      expect(h.memory.memoryOnlyOwnPostJoins('alpha')).toEqual([]); expect(h.memory.hasKeptJoin('alpha', C.primary, R.primary)).toBe(false)
      expectPrivate(h)
      await h.close(); const next = fixture({ reopen: true }, h.stateDir); await next.start()
      expect(next.memory.unresolvedIntents('alpha').map(i => i.operationId)).toEqual(['disk', 'unresolved'])
      expect(view(next)).toBe('joined'); expectPrivate(next)
    })

    test('a current confirmation selects immediately at a fresh clock reading and appends join then outcome atomically', async () => {
      const h = fixture(); await h.start(); const fact = h.fact()
      const kept = h.memory.keepIntent('alpha', intent(fact)); expect(kept.kept && await kept.ready).toBe('saved')
      const earlier = h.memory.clock('alpha'); h.io.reset()
      const confirmation = { ...fact, text: LEAK_SENTINEL }
      expect(h.memory.resolveIntent('alpha', 'own-post', { joined: confirmation })).toBe('joined')
      const first = { ...fact, source: 'own-post' as const, at: earlier + 1 }
      expect(h.memory.joins('alpha')).toEqual([{ join: first }]); expect(view(h)).toBe('joined')
      expect(h.memory.unresolvedIntents('alpha')).toEqual([]); expect(h.memory.memoryOnlyOwnPostJoins('alpha')).toEqual([])
      expect(h.io.writes()).toEqual([])
      await h.clock.flush()
      expect(readThreads(h.stateDir).slice(-2)).toEqual([joinRecord(first, 3), { v: 1, kind: 'post-outcome', seq: 4, operationId: 'own-post', outcome: 'joined' }])
      expect(h.io.calls.filter(c => c.path === threadPath(h.stateDir) && c.op === 'writeSync')).toHaveLength(1)
      expect(h.io.calls.filter(c => c.path === threadPath(h.stateDir) && c.op === 'fsync')).toHaveLength(1)
      const second = h.memory.keepIntent('alpha', intent(fact, 'second')); expect(second.kept && await second.ready).toBe('saved')
      expect(h.memory.resolveIntent('alpha', 'second', { joined: fact })).toBe('joined')
      await h.clock.flush()
      const later = savedJoins(h).at(-1)!
      expect(later.at).toBeGreaterThan(first.at)
      expect(h.memory.joins('alpha')).toEqual([{ join: first, savedAt: first.at }])
      await h.memory.compact(); expect(savedJoins(h)).toEqual([joinRecord(first, 3)])
      expectPrivate(h)
      await h.close(); const next = fixture({ reopen: true }, h.stateDir); await next.start()
      expectOnlySavedJoin(next, joinRecord(first, 3)); expect(next.memory.unresolvedIntents('alpha')).toEqual([])
    })

    test.each(['saved-intent', 'failed-intent'] as const)('a kept outcome with %s survives compaction and retries as one ordered append', async mode => {
      const h = fixture({ failureHandling: true }); await h.start(); const fact = h.fact()
      if (mode === 'failed-intent') h.io.fail('writeSync')
      const kept = h.memory.keepIntent('alpha', intent(fact)); expect(kept.kept && await kept.ready).toBe(mode === 'saved-intent' ? 'saved' : 'failed')
      if (mode === 'saved-intent') h.io.fail('writeSync')
      expect(h.memory.resolveIntent('alpha', 'own-post', { joined: fact })).toBe('joined')
      await h.clock.flush(); expect(view(h)).toBe('joined')
      const ownJoin = h.memory.joins('alpha')[0]!.join
      expect(h.memory.isJoinSaved('alpha', ownJoin)).toBe(false)
      expect(h.memory.unresolvedIntents('alpha')).toEqual([])
      expect(h.memory.memoryOnlyOwnPostJoins('alpha')).toEqual(mode === 'failed-intent' ? [{ channel: C.primary, root: R.primary }] : [])
      expect(h.memory.keepIntent('alpha', intent(h.fact({ root: R.secondary }), 'pending'))).toEqual({ kept: true })
      h.io.heal(); await h.memory.compact()
      expect(readThreads(h.stateDir).map(r => r.kind)).toEqual(mode === 'saved-intent' ? ['header', 'post-intent'] : ['header'])
      expect(h.memory.unresolvedIntents('alpha').map(i => i.operationId)).toEqual(['pending'])
      h.io.reset(); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
      expect(readThreads(h.stateDir).map(r => r.kind)).toEqual(['header', 'post-intent', 'join', 'post-outcome', 'post-intent'])
      expect(readThreads(h.stateDir).map(r => r.seq)).toEqual([1, 2, 3, 4, 5])
      expect(h.io.calls.filter(c => c.path === threadPath(h.stateDir) && c.op === 'writeSync')).toHaveLength(1)
      expect(h.memory.memoryOnlyOwnPostJoins('alpha')).toEqual([]); expect(h.memory.isJoinSaved('alpha', ownJoin)).toBe(true)
      const saved = journalBytes(h); await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS); expect(journalBytes(h)).toEqual(saved)
      await h.memory.compact()
      expect(readThreads(h.stateDir).map(r => r.kind)).toEqual(['header', 'join', 'post-intent'])
      expectPrivate(h)
      await h.close(); const next = fixture({ reopen: true }, h.stateDir); await next.start()
      expect(view(next)).toBe('joined'); expect(next.memory.unresolvedIntents('alpha').map(i => i.operationId)).toEqual(['pending'])
    })

    test.each(['none', 'stale-at-confirmation', 'stale-before-append'] as const)('%s records only an outcome none and cannot revive a join after a new hybrid choice', async mode => {
      const h = fixture(); await h.start(); const fact = h.fact()
      const kept = h.memory.keepIntent('alpha', intent(fact)); expect(kept.kept && await kept.ready).toBe('saved')
      if (mode === 'stale-at-confirmation') expect(h.choose('mentions').kind).toBe('applied')
      expect(h.memory.resolveIntent('alpha', 'own-post', mode === 'none' ? { none: true } : { joined: fact })).toBe(mode === 'stale-before-append' ? 'joined' : 'none')
      if (mode === 'stale-before-append') expect(h.choose('mentions').kind).toBe('applied')
      await h.clock.flush()
      expect(view(h)).toBe('not-joined'); expect(h.memory.hasKeptJoin('alpha', C.primary, R.primary)).toBe(false)
      expect(h.memory.memoryOnlyOwnPostJoins('alpha')).toEqual([]); expect(savedJoins(h)).toEqual([])
      expect(readThreads(h.stateDir).at(-1)).toEqual({ v: 1, kind: 'post-outcome', seq: 3, operationId: 'own-post', outcome: 'none' })
      expect(h.memory.unresolvedIntents('alpha')).toEqual([])
      expect(h.choose('thread_hybrid').kind).toBe('applied')
      await h.memory.compact(); expect(view(h)).toBe('not-joined')
      expect(readThreads(h.stateDir).map(r => r.kind)).toEqual(['header'])
      expectPrivate(h)
      await h.close(); const next = fixture({ reopen: true }, h.stateDir); await next.start(); expect(view(next)).toBe('not-joined')
    })

    test('unresolved indexes isolate personas and channels and return copies of both read and kept intents', async () => {
      const h = fixture(); h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'], [C.primary, C.secondary]))
      const disk = postIntent(h.fact(), { operationId: 'same-id', seq: 2 })
      seedThreads(h.stateDir, [threadHeader(), disk]); await h.start()
      const beta = intent(h.fact({}, 'beta'), 'same-id'), secondary = intent(h.fact({ channel: C.secondary }), 'secondary')
      const keptBeta = h.memory.keepIntent('beta', beta), keptSecondary = h.memory.keepIntent('alpha', secondary)
      expect(h.memory.unresolvedIntents('alpha', C.primary)).toEqual([disk])
      expect(h.memory.unresolvedIntents('alpha', C.secondary).map(i => i.operationId)).toEqual(['secondary'])
      expect(h.memory.unresolvedIntents('beta').map(i => i.operationId)).toEqual(['same-id'])
      const copy = h.memory.unresolvedIntents('alpha'); copy[0]!.stamp.incarnation = 'changed-copy'; copy[1]!.operationId = 'changed-copy'
      expect(h.memory.unresolvedIntents('alpha')[0]).toEqual(disk)
      expect(h.memory.unresolvedIntents('alpha')[1]!.operationId).toBe('secondary')
      expect(keptBeta.kept && await keptBeta.ready).toBe('saved'); expect(keptSecondary.kept && await keptSecondary.ready).toBe('saved')
      h.io.reset(); expect(h.memory.resolveIntent('alpha', 'same-id', { none: true })).toBe('none')
      expect(h.memory.unresolvedIntents('alpha', C.primary)).toEqual([])
      expect(h.memory.unresolvedIntents('beta').map(i => i.operationId)).toEqual(['same-id']); expect(h.io.calls).toEqual([])
      await h.clock.flush(); expectPrivate(h)
    })

    test.each(['forget', 'remove', 'unapplied', 'quiesce', 'stop', 'dry-run'] as const)('%s refuses new intents and outcomes without adding joins or writing', async mode => {
      const h = fixture({ dryRun: mode === 'dry-run' }), fact = h.fact()
      seedThreads(h.stateDir, [threadHeader(), postIntent(fact, { operationId: 'existing', seq: 2 })]); await h.start()
      if (mode === 'forget') h.memory.forget('alpha')
      else if (mode === 'remove') await h.memory.remove('alpha')
      else if (mode === 'unapplied') expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['beta'])).kind).toBe('applied')
      else if (mode === 'quiesce') await h.memory.quiesce()
      else if (mode === 'stop') await h.memory.stop()
      await h.clock.flush()
      const before = existsSync(threadPath(h.stateDir)) ? journalBytes(h) : undefined
      h.io.reset()
      expect(h.memory.keepIntent('alpha', intent(fact))).toEqual({ kept: false })
      expect(h.memory.resolveIntent('alpha', 'existing', { joined: fact })).toBeUndefined()
      expect(h.memory.resolveIntent('alpha', 'existing', { none: true })).toBeUndefined()
      await h.clock.flush(); expect(h.io.writes()).toEqual([])
      expect(h.memory.joins('alpha')).toEqual([]); expect(h.memory.memoryOnlyOwnPostJoins('alpha')).toEqual([])
      expect(h.memory.unresolvedIntents('alpha').some(i => i.operationId === 'own-post')).toBe(false)
      expect(existsSync(threadPath(h.stateDir)) ? journalBytes(h) : undefined).toEqual(before)
    })

    test.each(['forget', 'remove'] as const)('%s fences an intent already queued on the writer', async action => {
      const h = fixture(); await h.start(); const before = journalBytes(h)
      h.io.reset(); const kept = h.memory.keepIntent('alpha', intent(h.fact()))
      expect(kept.kept && kept.ready).toBeInstanceOf(Promise)
      const removing = action === 'remove' ? h.memory.remove('alpha') : h.memory.forget('alpha')
      expect(kept.kept && await kept.ready).toBe('failed'); await removing
      expect(h.io.calls.filter(c => c.op === 'writeSync' && c.path === threadPath(h.stateDir))).toEqual([])
      expect(h.memory.unresolvedIntents('alpha')).toEqual([])
      if (action === 'forget') expect(journalBytes(h)).toEqual(before)
      else expect(existsSync(threadPath(h.stateDir))).toBe(false)
    })
  })

  test('clock increases through stalled/backward wall time, read high-water and explicit advance, independently per persona', async () => {
    let wall = THREAD_TIME
    const h = fixture({ now: () => wall })
    expect(h.memory.clock('alpha')).toBe(wall); expect(h.memory.clock('alpha')).toBe(wall + 1)
    wall -= 500; expect(h.memory.clock('alpha')).toBe(THREAD_TIME + 2); expect(h.memory.clock('beta')).toBe(wall)
    const fact = h.fact({ at: THREAD_TIME + 1_000 })
    seedThreads(h.stateDir, [threadHeader(), joinRecord(fact)]); h.memory.readAtStart()
    expect(h.memory.clock('alpha')).toBe(fact.at + 1)
    h.memory.advancePast('alpha', fact.at + 200); expect(h.memory.clock('alpha')).toBe(fact.at + 201)
    h.memory.advancePast('alpha', 0); expect(h.memory.clock('alpha')).toBe(fact.at + 202)
  })
})

describe('the threads directory is synced only while a journal entry may not be durable', () => {
  const threadsDir = (h: ThreadMemoryHarness) => join(h.stateDir, 'threads')
  /** Each fsync's target from `h.io.calls[from]` on: the threads or parent directory, `key`'s journal, or another file. */
  function syncTargets(h: ThreadMemoryHarness, from = 0, key = 'alpha') {
    return h.io.calls.slice(from).filter(c => c.op === 'fsync' || c.op === 'fsyncSync').map(({ path }) => path === threadsDir(h) ? 'threads'
      : path === h.stateDir ? 'parent' : path === threadPath(h.stateDir, key) ? 'journal' : relative(threadsDir(h), path))
  }
  function seedCreated(h: ThreadMemoryHarness, key = 'alpha') {
    seedThreads(h.stateDir, [threadHeader()], key)
    expect(h.authority.setThreadMemoryCreated(key).kind).toBe('saved')
  }

  test('a store created by its header append syncs the threads directory; later saves sync only the journal', async () => {
    const h = fixture(); await h.start()
    expect(syncTargets(h)).toEqual(['parent', 'journal', 'threads'])
    const from = h.io.calls.length
    for (const root of [R.primary, R.secondary]) expect(await h.memory.saveJoins('alpha', [h.fact({ root })])).toEqual({ kind: 'saved' })
    expect(syncTargets(h, from)).toEqual(['journal', 'journal'])
  })

  test.each((['start', 'later bring-up'] as const).flatMap(at => (['succeeds', 'fails at its rename', 'fails at its directory sync'] as const)
    .map(compaction => [at, compaction] as const)))('an existing journal first read at %s, whose compaction %s: only a failed compaction leaves the first save to sync the threads directory, retryably', async (at, compaction) => {
    const h = fixture(), isThreads = (path: string) => path === threadsDir(h)
    seedCreated(h)
    const breakCompaction = () => {
      if (compaction === 'fails at its rename') h.io.fail('rename')
      else if (compaction === 'fails at its directory sync') h.io.fail('fsync', 'alpha', { match: isThreads })
    }
    // The fixture refuses the start read before the file opens, so the later bring-up's read is the first opening.
    if (at === 'start') breakCompaction(); else h.io.fail('readFileSync')
    await h.start()
    if (at === 'later bring-up') {
      expect(view(h)).toBe('unknown')
      h.io.heal(); breakCompaction(); await h.memory.loadKey('alpha')
    }
    h.io.heal()
    const from = h.io.calls.length, first = h.fact()
    if (compaction === 'succeeds') expect(await h.memory.saveJoins('alpha', [first])).toEqual({ kind: 'saved' })
    else {
      h.io.fail('fsync', 'alpha', { match: isThreads, times: 1 })
      expect((await h.memory.saveJoins('alpha', [first])).kind).toBe('failed')
      expect(h.memory.keptFacts('alpha')).toEqual([first])
      expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    }
    expect(await h.memory.saveJoins('alpha', [h.fact({ root: R.secondary })])).toEqual({ kind: 'saved' })
    expect(syncTargets(h, from)).toEqual(compaction === 'succeeds' ? ['journal', 'journal']
      // The refused directory sync and its rollback's file sync; the retry syncs the directory again.
      : ['journal', 'threads', 'journal', 'journal', 'threads', 'journal'])
    expect(savedJoins(h).map(r => r.root)).toEqual([R.primary, R.secondary])
  })

  test('a read retry of a journal this run already opened opens nothing new, so the start compaction still vouches for the first save', async () => {
    const h = fixture(); seedCreated(h); await h.start()
    h.memory.forget('alpha'); h.io.fail('readFileSync'); await h.memory.loadKey('alpha')
    expect(view(h)).toBe('unknown')
    h.io.heal(); expect(await h.memory.retryRead('alpha')).toBe('read')
    const from = h.io.calls.length
    expect(await h.memory.saveJoins('alpha', [h.fact()])).toEqual({ kind: 'saved' })
    expect(syncTargets(h, from)).toEqual(['journal'])
  })

  test("a journal recreated after remove is a new entry even when it reuses the removed file's identity: its first append syncs the threads directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-memory-')), controls = threadFsControls(dir)
    let reused: Pick<Stats, 'dev' | 'ino' | 'birthtimeMs'> | undefined
    // Model the filesystem giving the recreated journal the removed one's device, inode and birth time.
    const io = { ...controls, fs: { ...controls.fs, fstatSync(fd: number, ...rest: unknown[]) {
      const stat = (controls.fs.fstatSync as Function)(fd, ...rest) as Stats
      if (reused && existsSync(threadPath(dir)) && statSync(threadPath(dir)).ino === stat.ino) Object.assign(stat, reused)
      return stat
    } } as typeof controls.fs }
    const h = fixture({ fs: io }, dir); await h.start()
    expect(await h.memory.saveJoins('alpha', [h.fact()])).toEqual({ kind: 'saved' })
    const { dev, ino, birthtimeMs } = statSync(threadPath(dir)); reused = { dev, ino, birthtimeMs }
    expect(await h.memory.remove('alpha')).toEqual({ kind: 'saved' })
    const from = h.io.calls.length
    await h.memory.loadKey('alpha')
    expect(h.authority.threadMemoryCreated('alpha')).toBe(true)
    expect(await h.memory.saveJoins('alpha', [h.fact({ root: R.secondary })])).toEqual({ kind: 'saved' })
    expect(syncTargets(h, from)).toEqual(['journal', 'threads', 'journal'])
  })

  test.each(['removes the file and syncs the directory', 'finds no file', 'cannot sync the directory'] as const)("a removal that %s vouches for another journal's earlier opening only when its directory sync succeeded", async outcome => {
    const h = fixture()
    h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta']))
    for (const key of ['alpha', 'beta']) seedCreated(h, key)
    // Every start compaction fails before its rename: both journals stay opened with no directory sync since.
    h.io.fail('fsync', 'alpha', { match: path => path.endsWith('.tmp') })
    await h.start(); h.io.heal()
    if (outcome === 'finds no file') h.io.removeJournal('alpha')
    if (outcome === 'cannot sync the directory') h.io.fail('fsyncSync', 'alpha', { match: path => path === threadsDir(h) })
    expect(await h.memory.remove('alpha')).toEqual({ kind: 'saved' })
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    h.io.heal()
    const from = h.io.calls.length
    expect(await h.memory.saveJoins('beta', [h.fact({}, 'beta')])).toEqual({ kind: 'saved' })
    expect(syncTargets(h, from, 'beta')).toEqual(outcome === 'removes the file and syncs the directory' ? ['journal'] : ['journal', 'threads'])
  })
})

function sealFixture(options: Parameters<typeof fixture>[0] = {}, dir?: string) {
  const h = fixture({ seal: true, ...options }, dir)
  return { ...h, seal: h.seal!, queue: h.queue! }
}
const sealEntry = (h: ThreadMemoryHarness, key = 'alpha') => readThreadSeal(h.stateDir).entries[key]!
function expectSealFinding(h: ThreadMemoryHarness, reason?: ThreadMemorySealCase, wording: 'changed' | 'unclean' = 'changed') {
  const expected = reason ? [{ key: 'alpha', case: reason, wording }] : []
  expect(h.seal!.startupFindings()).toEqual(expected)
  expect(h.sealEvents.filter(e => e.type === 'changed-while-stopped')).toEqual(expected.map(e => ({ type: 'changed-while-stopped', ...e })))
}
async function queueTraffic(h: ReturnType<typeof sealFixture>, key = 'alpha') {
  const accepted = await h.queue.accept(key, slackInput())
  expect(accepted.status).toBe('accepted')
  if (accepted.status === 'failed') throw accepted.error
  await h.queue.append(key, fixedRecord(accepted.seq, ['fixture delivery']))
  await h.queue.append(key, deliveredRecord(accepted.seq))
  expect(h.queue.item(key, accepted.seq)?.delivered).toBe(true)
  expect(h.queue.openCount(key)).toBe(0)
}
async function deliverRecoveredItem(queue: Awaited<ReturnType<typeof makeQueue>>, key: string, seq: number) {
  const item = queue.item(key, seq)!
  await queue.append(key, fixedRecord(seq, [item.accepted.text]))
  await queue.append(key, deliveredRecord(seq))
}

function reportingFixture(options: Parameters<typeof fixture>[0] = {}, dir?: string) {
  const h = fixture({ seal: true, failureHandling: true, ...options }, dir)
  return { ...h, seal: h.seal!, retries: h.retries!, reporting: h.reporting!, episodes: h.episodes! }
}
function notice(h: ThreadMemoryHarness, body: (ref: string) => string, key = 'alpha') {
  const persona = h.authority.config().personas.find(p => p.key === key)!
  return { key, text: formatPersonaNotice(persona, body(renderPersonaRef(persona.name, key))) }
}
const recoveryNotice = (h: ThreadMemoryHarness, key = 'alpha') =>
  notice(h, ref => buildThreadMemoryRecoveredNotice(ref, h.authority.threadView().threadHybridChannels(key)), key)
function lossNotice(h: ThreadMemoryHarness, loss: ThreadMemoryLoss, key = 'alpha') {
  const persona = h.authority.config().personas.find(p => p.key === key)!
  const result = buildThreadMemoryJoinsLostNotice(persona, loss)
  return { key, text: formatPersonaNotice(persona, result.text, result.options) }
}
function seedReadable(h: ThreadMemoryHarness, facts: ThreadJoin[] = [], key = 'alpha') {
  seedThreads(h.stateDir, [threadHeader(), ...facts.map((fact, i) => joinRecord(fact, i + 2))], key)
  expect(h.authority.setThreadMemoryCreated(key).kind).toBe('saved')
  if (h.seal) seedThreadSeal(h.stateDir, {
    ...(existsSync(threadSealPath(h.stateDir)) ? readThreadSeal(h.stateDir).entries : {}),
    [key]: cleanSealEntry(h.stateDir, key, { lastRecordNumber: facts.length + 1 }),
  })
}

/** Reuse rn's real owner/authority/membership/queue composition. The memory
 * harness additionally owns seal startup/shutdown and the reporter/retry clock. */
async function ownPostFixture(options: Parameters<typeof makeOwnPostHarness>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'thread-own-post-'))
  threadDirs.push(dir)
  const memory: ThreadHarnessOptions = { seal: true, failureHandling: true, ...options.memory }
  const h = await makeOwnPostHarness(dir, { ...options, memory, start: false })
  h.threads.attachOwnPosts(h.owner)
  await h.clock.advanceTo(THREAD_TIME)
  if (options.start !== false) await h.start()
  ownPostRuns.push(h); threadRuns.push(h.threads)
  return h
}
const POST_CONTENT = { kind: 'text' as const, text: `private post ${LEAK_SENTINEL}` }
function beginPost(h: OwnPostHarness, surface: OwnPostSurface = 'text', channel: string = C.primary, key = 'alpha') {
  const started = h.observer.start(key, surface, { channel }, POST_CONTENT)
  expect(started).toBeDefined()
  return started!
}
async function confirmPost(h: OwnPostHarness, started: ReturnType<typeof beginPost>, root: string = R.primary, channel: string = C.primary) {
  await started.ready
  const slack = makeStubSlack({ post: [{ kind: 'ok', result: { ts: root } }] })
  h.observer.end(started.operation, ownPostAnswerOfPost(channel, await slack.web.chat.postMessage({ channel, text: POST_CONTENT.text })))
  await h.flush()
}
const sealedJoins = (h: ThreadMemoryHarness, key = 'alpha') => {
  const entry = sealEntry(h, key)
  return entry.memoryOnlyJoins
}
function undecideOwnPosts(h: OwnPostHarness) {
  h.members.unsyncWrites(() => true)
  expect(h.threads.mode('open').kind).toBe('unresolved')
  expect(h.authority.channelStamp('alpha', C.primary)?.kind).toBe('undecided')
}

describe('Thread Memory failure handling through the store', () => {
  test.each(['saved', 'discarded'] as const)('owner-only confirmed posts delay read recovery until %s after the channel decision', async resolution => {
    const h = await ownPostFixture()
    h.memory.forget('alpha'); h.io.fail('readFileSync'); await h.memory.loadKey('alpha')
    undecideOwnPosts(h)
    const post = beginPost(h)
    expect(post.ready).toBeUndefined()
    expect(h.memory.outage('alpha').unsaved).toBe(0)
    await confirmPost(h, post)
    expect(h.memory.unresolvedIntents('alpha')).toEqual([])
    expect(h.owner.memoryOnlyJoins('alpha')).toEqual([{ channel: C.primary, root: R.primary }])
    expect(h.memory.outage('alpha')).toEqual({ unknown: true, unsaved: 1, missing: false })
    h.io.heal()
    expect(await h.memory.retryRead('alpha')).toBe('read')
    await h.flush()
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 1, missing: false })
    const firstRead = [...h.threads.events].reverse().find(event => event.type === 'read')!
    const outageAtRead = h.memory.outage('alpha')
    expect(h.threads.episodes!.isOpen('alpha', THREAD_MEMORY_UNREADABLE)).toBe(true)
    expect(h.threads.posts).not.toContainEqual(recoveryNotice(h.threads))

    // Publication either transfers the post into the writer or discards it.
    // A failed append proves the transfer does not count the owner twice.
    if (resolution === 'saved') h.io.fail('writeSync')
    h.members.unsyncWrites(() => false)
    expect(h.authority.recoverDurability().kind).toBe('applied')
    if (resolution === 'discarded') expect(h.threads.choose('off').kind).toBe('applied')
    await h.flush()
    if (resolution === 'saved') {
      expect(h.memory.outage('alpha').unsaved).toBe(3)
      expect(h.threads.episodes!.isOpen('alpha', THREAD_MEMORY_UNREADABLE)).toBe(true)
      expect(h.threads.posts).not.toContainEqual(recoveryNotice(h.threads))
      h.io.heal()
      expect((await h.memory.flush('alpha')).kind).toBe('saved')
      expect(readThreads(h.stateDir).slice(-3).map(r => r.kind)).toEqual(['post-intent', 'join', 'post-outcome'])
    } else expect(readThreads(h.stateDir).some(r => r.kind === 'post-intent')).toBe(false)
    expect(h.owner.memoryOnlyJoins('alpha')).toEqual([])
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 0, missing: false })
    expect(h.threads.episodes!.isOpen('alpha', THREAD_MEMORY_UNREADABLE)).toBe(false)
    expect(h.threads.posts.filter(p => p.text === recoveryNotice(h.threads).text)).toEqual([recoveryNotice(h.threads)])
    h.owner.onSharedStatePublished('alpha'); h.memory.published()
    await h.memory.flush('alpha'); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(h.threads.posts.filter(p => p.text === recoveryNotice(h.threads).text)).toHaveLength(1)

    // Replay the real observations after the store is healthy, as startup's
    // buffer does. The earlier read must still wait for the later settlement.
    const reporting = h.threads.reporting!
    const settled = [...h.threads.events].reverse().find(event => event.type === 'outage-settled' || event.type === 'saved-after-failure')!
    expect(settled).toBeDefined()
    reporting.threadMemoryEvent(h.threads.events.find(event => event.type === 'read-failed')!)
    reporting.threadMemoryEvent(firstRead, outageAtRead)
    expect(h.threads.episodes!.isOpen('alpha', THREAD_MEMORY_UNREADABLE)).toBe(true)
    expect(h.threads.posts.filter(p => p.text === recoveryNotice(h.threads).text)).toHaveLength(1)
    reporting.threadMemoryEvent(settled, h.memory.outage('alpha'))
    reporting.threadMemoryEvent(settled, h.memory.outage('alpha'))
    expect(h.threads.episodes!.isOpen('alpha', THREAD_MEMORY_UNREADABLE)).toBe(false)
    expect(h.threads.posts.filter(p => p.text === recoveryNotice(h.threads).text)).toHaveLength(2)
  })

  test.each(['readable', 'unreadable'] as const)('own-post facts keep the %s outage open until the real append retry saves all three', async state => {
    const h = await ownPostFixture()
    if (state === 'unreadable') {
      h.memory.forget('alpha'); h.io.fail('readFileSync'); await h.memory.loadKey('alpha')
      expect(h.memory.digestKey('alpha')).toBeUndefined()
    } else h.io.fail('writeSync')
    const post = beginPost(h); await post.ready
    expect(h.memory.outage('alpha')).toEqual({ unknown: state === 'unreadable', unsaved: 1, missing: false })
    await confirmPost(h, post)
    expect(h.memory.outage('alpha').unsaved).toBe(3)
    const episode = state === 'unreadable' ? THREAD_MEMORY_UNREADABLE : THREAD_MEMORY_NOT_SAVED
    expect(h.threads.episodes!.isOpen('alpha', episode)).toBe(true)
    const initial = [...h.threads.posts]
    expect(initial).toHaveLength(1)
    if (state === 'unreadable') {
      h.io.heal(); h.io.fail('writeSync')
      expect(await h.memory.retryRead('alpha')).toBe('read')
      expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 3, missing: false })
      expect(h.threads.posts).toEqual(initial)
      expect(h.threads.episodes!.isOpen('alpha', episode)).toBe(true)
      // Save is still failing after the successful read; retries own recovery.
      await h.memory.flush('alpha')
    }
    await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(h.memory.outage('alpha').unsaved).toBe(3)
    expect(h.threads.posts).not.toContainEqual(recoveryNotice(h.threads))
    h.io.heal(); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS * 2)
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 0, missing: false })
    expect(h.threads.posts.filter(p => p.text === recoveryNotice(h.threads).text)).toEqual([recoveryNotice(h.threads)])
    expect(h.threads.episodes!.isOpen('alpha', episode)).toBe(false)
    expect(readThreads(h.stateDir).slice(-3).map(r => r.kind)).toEqual(['post-intent', 'join', 'post-outcome'])
  })

  test.each((['notice', 'text', 'file', 'prompt', 'warning'] as const).flatMap(surface =>
    (['intent', 'join-outcome', 'none-outcome', 'flush'] as const).map(kind => ({ surface, kind }))))(
    'own-post noticeOnly follows $surface facts in a failed $kind append', async ({ surface, kind }) => {
      const h = await ownPostFixture()
      if (kind === 'intent' || kind === 'flush') h.io.fail('writeSync')
      const post = beginPost(h, surface); await post.ready
      if (kind !== 'intent') {
        h.io.fail('writeSync')
        if (kind === 'none-outcome') {
          const slack = makeStubSlack({ post: [{ kind: 'ok', result: { ok: false, error: 'not_in_channel' } }] })
          h.observer.end(post.operation, ownPostAnswerOfPost(C.primary, await slack.web.chat.postMessage({ channel: C.primary, text: POST_CONTENT.text })))
          await h.flush()
        } else await confirmPost(h, post)
      }
      if (kind === 'flush') {
        h.threads.events.length = 0
        expect((await h.memory.flush('alpha')).kind).toBe('failed')
      }
      const failures = h.threads.events.filter(e => e.type === 'append-failed')
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({ type: 'append-failed', key: 'alpha', step: 'journal-append', noticeOnly: surface === 'notice' })
      expect(h.memory.outage('alpha').unsaved).toBe(kind === 'intent' || kind === 'none-outcome' ? 1 : kind === 'flush' ? 3 : 2)
      h.io.heal(); expect((await h.memory.flush('alpha')).kind).toBe('saved')
      const bytes = journalBytes(h.threads).toString()
      expect(bytes).not.toContain('noticeOnly'); assertNoLeak(bytes)
    })

  test.each(['text', 'file', 'prompt', 'warning', 'mention', 'broadcast'] as const)('own-post mixed flush containing %s is not notice-only', async kind => {
    const h = await ownPostFixture(); h.io.fail('writeSync')
    await confirmPost(h, beginPost(h, 'notice'))
    if (kind === 'mention' || kind === 'broadcast') h.memory.addJoin('alpha', h.threads.fact({ source: kind, root: R.secondary }))
    else await confirmPost(h, beginPost(h, kind), R.secondary)
    h.threads.events.length = 0
    expect((await h.memory.flush('alpha')).kind).toBe('failed')
    expect(h.threads.events.filter(e => e.type === 'append-failed').map(e => e.noticeOnly)).toEqual([false])
  })

  test.each(['membership', 'stamp', 'unknown-digest', 'lookup'] as const)('own-post notice provenance survives %s deferral until the actual failed append', async deferred => {
    const h = await ownPostFixture()
    if (deferred === 'unknown-digest') { h.memory.forget('alpha'); h.io.fail('readFileSync'); await h.memory.loadKey('alpha') }
    const post = beginPost(h, 'notice'); await post.ready
    if (deferred === 'membership') h.members.membership.invalidate('alpha')
    if (deferred === 'stamp') undecideOwnPosts(h)
    if (deferred === 'lookup') {
      h.observer.end(post.operation, { kind: 'no-answer' })
      const pending = h.owner.unknownOwnPosts('alpha')[0]!
      h.io.fail('writeSync')
      h.owner.recordLookup('alpha', pending.operationId, { found: { ts: R.primary }, holds: 'thread' })
    } else await confirmPost(h, post)
    if (deferred === 'membership') {
      h.io.fail('writeSync')
      h.members.h.stub(h.members.h.p('alpha')).script.inventory.push(membershipPage([C.primary]))
      h.members.scanner.connectionChanged('alpha'); await h.flush(); await h.members.scan(); h.owner.onSharedStatePublished('alpha')
    }
    if (deferred === 'stamp') {
      h.io.fail('writeSync'); h.members.unsyncWrites(() => false); expect(h.authority.recoverDurability().kind).toBe('applied')
    }
    if (deferred === 'unknown-digest') {
      expect(h.memory.outage('alpha').unsaved).toBe(3)
      h.io.heal(); h.io.fail('writeSync'); expect(await h.memory.retryRead('alpha')).toBe('read')
      await h.memory.flush('alpha')
    }
    await h.flush()
    const failures = h.threads.events.filter(e => e.type === 'append-failed')
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.map(e => e.noticeOnly)).toEqual(failures.map(() => true))
    expect(h.threads.posts.filter(p => p.text === recoveryNotice(h.threads).text)).toEqual([])
  })

  test('own-post notice provenance is absent from saved and compacted records, seals and recovered intents', async () => {
    const h = await ownPostFixture()
    const post = beginPost(h, 'notice'); await post.ready
    h.observer.end(post.operation, { kind: 'no-answer' }); await h.flush()
    const id = h.owner.unknownOwnPosts('alpha')[0]!.operationId
    const appended = journalBytes(h.threads)
    await h.memory.compact()
    const compacted = journalBytes(h.threads)
    await h.close()
    for (const bytes of [appended, compacted, readFileSync(threadSealPath(h.stateDir))]) {
      expect(bytes.toString()).not.toContain('noticeOnly'); expect(bytes.toString()).not.toContain('surface'); assertNoLeak(bytes.toString())
    }
    const next = reportingFixture({ reopen: true }, h.stateDir); await next.start()
    const intent = next.memory.unresolvedIntents('alpha')[0]!
    expect(intent.operationId).toBe(id); expect(intent).not.toHaveProperty('surface'); expect(intent).not.toHaveProperty('noticeOnly')
    next.io.fail('writeSync')
    expect(next.memory.resolveIntent('alpha', id, { joined: next.fact() })).toBe('joined'); await next.clock.flush()
    expect(next.events.filter(e => e.type === 'append-failed').map(e => e.noticeOnly)).toEqual([false])
    next.io.heal(); await next.memory.flush('alpha'); await next.memory.compact(); await next.close()
    for (const bytes of [journalBytes(next), readFileSync(threadSealPath(next.stateDir))]) {
      expect(bytes.toString()).not.toContain('noticeOnly'); assertNoLeak(bytes.toString())
    }
    for (const event of [...h.threads.events, ...next.events].filter(e => e.type !== 'append-failed')) expect(event).not.toHaveProperty('noticeOnly')
    for (const event of [...h.threads.sealEvents, ...next.sealEvents]) expect(event).not.toHaveProperty('noticeOnly')
  })

  test('own-post creation failure is distinct from append notice provenance', async () => {
    const h = await ownPostFixture({ start: false }); h.io.fail('writeSync'); await h.start()
    await confirmPost(h, beginPost(h, 'notice'))
    const failures = h.threads.events.filter(e => e.type === 'creation-failed')
    expect(failures.length).toBeGreaterThan(0)
    for (const event of failures) expect(event).not.toHaveProperty('noticeOnly')
  })

  test('retryRead retries unreadable files, judges the first read and merges saved, kept and pending joins', async () => {
    const h = sealFixture(), disk = h.fact(), kept = h.fact({ root: R.secondary }), pending = h.fact({ root: R.third })
    seedReadable(h, [disk])
    seedThreadSeal(h.stateDir, { alpha: cleanSealEntry(h.stateDir, 'alpha', { storeId: 'old-store' }) })
    const error = h.io.fail('readFileSync'); await h.start()
    expect(h.memory.outage('alpha')).toEqual({ unknown: true, unsaved: 0, missing: false })
    expect(await h.memory.retryRead('alpha')).toBe('unreadable')
    expect(h.events.at(-1)).toEqual({ type: 'read-failed', key: 'alpha', path: threadPath(h.stateDir), error })
    expect(h.memory.addJoin('alpha', kept)).toBe(true)
    h.memory.recoverJoins('alpha', [pending])
    expect(h.memory.outage('alpha')).toEqual({ unknown: true, unsaved: 2, missing: false })
    expect(view(h, R.secondary)).toBe('joined'); expect(view(h)).toBe('unknown')
    expect(h.seal.startupFindings()).toEqual([])
    h.io.heal()
    expect(await h.memory.retryRead('alpha')).toBe('read')
    expectSealFinding(h, 'journal-changed')
    expect(h.events.at(-1)).toEqual({ type: 'read', key: 'alpha', path: threadPath(h.stateDir), firstSuccessfulRead: true })
    expect([view(h), view(h, R.secondary)]).toEqual(['joined', 'joined'])
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 2, missing: false })
    h.memory.retryPendingJoins('alpha'); expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    for (const fact of [disk, kept, pending]) expect(h.memory.isJoinSaved('alpha', fact)).toBe(true)
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 0, missing: false })
    const events = [...h.events]; h.io.reset()
    expect(await h.memory.retryRead('alpha')).toBe('read')
    expect(h.events).toEqual(events); expect(h.io.calls).toEqual([])
  })

  test('a startup read retry stays pending without I/O until activation can judge the journal', async () => {
    const h = reportingFixture(); seedReadable(h)
    const error = h.io.fail('readFileSync'); h.memory.readAtStart(); h.io.heal(); h.io.reset()
    expect(await h.memory.retryRead('alpha')).toBe('unreadable')
    await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(h.io.calls).toEqual([])
    expect(h.retryEvents).toEqual([{ type: 'read-retry-started', key: 'alpha' }])
    expect(h.logs).toEqual([buildThreadMemoryUnreadableLine('alpha', [C.primary], threadPath(h.stateDir), error)])
    await h.seal.loadAtStart(h.memory.journalFacts()); await h.memory.activate()
    await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 0, missing: false })
    expect(h.posts).toEqual([
      notice(h, ref => buildThreadMemoryUnreadableNotice(ref, [C.primary], threadPath(h.stateDir))), recoveryNotice(h),
    ])
    expect(h.retryEvents).toContainEqual({ type: 'read-after-retries', key: 'alpha', attempts: 2 })
  })

  test('missing on retry is sticky across load, publication, compaction and flush until a new start', async () => {
    const h = sealFixture(); seedThreads(h.stateDir, [threadHeader()])
    h.io.fail('readFileSync'); await h.start()
    h.io.removeJournal(); h.io.heal(); h.io.reset(); h.sealIo.reset()
    const shared = readFileSync(h.authority.path), seal = readFileSync(threadSealPath(h.stateDir))
    expect(await h.memory.retryRead('alpha')).toBe('missing')
    const kept = h.fact(); expect(h.memory.addJoin('alpha', kept)).toBe(true)
    expect(h.memory.outage('alpha')).toEqual({ unknown: true, unsaved: 1, missing: true })
    expect([view(h), view(h, R.secondary)]).toEqual(['joined', 'unknown'])
    expect(await h.memory.saveJoins('alpha', [h.fact({ root: R.secondary })])).toEqual({ kind: 'kept' })
    await h.memory.loadKey('alpha'); h.memory.published(); await h.memory.compact()
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'kept' })
    expect(await h.memory.retryRead('alpha')).toBe('missing')
    expect(h.io.calls.filter(c => c.op === 'readFileSync')).toHaveLength(1)
    expect(h.io.writes()).toEqual([]); expect(h.sealIo.writes()).toEqual([]); expect(h.markerCalls).toEqual([])
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    expect(readFileSync(h.authority.path)).toEqual(shared); expect(readFileSync(threadSealPath(h.stateDir))).toEqual(seal)
    // Even restored bytes cannot revive this lifecycle's missing journal.
    seedThreads(h.stateDir, [threadHeader(), joinRecord(kept)])
    await h.memory.loadKey('alpha'); expect(await h.memory.retryRead('alpha')).toBe('missing')
    expect(h.memory.outage('alpha').unknown).toBe(true)
    h.io.removeJournal(); await h.crash()
    const restarted = sealFixture({ reopen: true }, h.stateDir); await restarted.start()
    expect(restarted.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 0, missing: false })
    expect(restarted.authority.threadMemoryCreated('alpha')).toBe(true)
    expect(view(restarted)).toBe('not-joined'); expect(savedJoins(restarted)).toEqual([])
  })

  test.each(['seal-entry', 'journal-header', 'marker'] as const)('failed creation at %s counts unsaved work and completes in order on its background retry', async step => {
    const h = reportingFixture()
    if (step === 'seal-entry') h.sealIo.failWrite()
    else if (step === 'journal-header') h.io.fail('writeSync')
    else h.failShared(() => 'before')
    await h.start()
    const failure = h.events.find(e => e.type === 'creation-failed')!
    expect(failure).toEqual({ type: 'creation-failed', key: 'alpha', path: threadPath(h.stateDir), step, error: expect.any(Error) })
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 1, missing: false })
    const fact = h.fact(); expect(h.memory.addJoin('alpha', fact)).toBe(true)
    expect(h.memory.outage('alpha').unsaved).toBe(2); expect(view(h)).toBe('joined')
    await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(h.posts).toHaveLength(1); expect(h.authority.threadMemoryCreated('alpha')).toBe(false)
    expect(savedJoinsIfPresent(h)).toEqual([])
    h.io.heal(); h.sealIo.heal(); h.failShared()
    await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    expect(h.posts).toHaveLength(2); expect(h.posts.at(-1)).toEqual(recoveryNotice(h))
    expect(h.memory.isJoinSaved('alpha', fact)).toBe(true)
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 0, missing: false })
    expect(h.markerCalls.at(-1)).toEqual({ action: 'set', key: 'alpha', fileExists: true, synced: true })
    const header = readThreads(h.stateDir)[0]!
    expect(header.kind).toBe('header'); expect(sealEntry(h).storeId).toBe(h.memory.store('alpha')!.storeId!)
    expect(h.retryEvents.filter(e => e.type === 'append-retry-started')).toEqual([{ type: 'append-retry-started', key: 'alpha' }])
    expect(h.logs.filter(line => line === buildThreadMemoryRecoveredLine('alpha', [C.primary]))).toHaveLength(1)
  })

  test('append retries save selecting facts without traffic, with one outage and one recovery per persona', async () => {
    const h = reportingFixture(); expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    await h.start(); const before = journalBytes(h), first = h.fact(), second = h.fact({ root: R.secondary })
    const error = h.io.fail('writeSync')
    expect((await h.memory.saveJoins('alpha', [first])).kind).toBe('failed')
    await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect((await h.memory.saveJoins('alpha', [second])).kind).toBe('failed')
    await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS * 2)
    expect(journalBytes(h)).toEqual(before)
    expect([view(h), view(h, R.secondary)]).toEqual(['joined', 'joined'])
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 2, missing: false })
    expect(h.posts).toEqual([notice(h, ref => buildThreadMemoryNotSavedNotice(ref, [C.primary], threadPath(h.stateDir), 'journal-append', error))])
    expect(h.logs).toEqual([buildThreadMemoryNotSavedLine('alpha', [C.primary], threadPath(h.stateDir), 'journal-append', error)])
    expect(h.retryEvents.filter(e => e.type === 'append-retry-started')).toEqual([{ type: 'append-retry-started', key: 'alpha' }])
    const sibling = h.fact({}, 'beta'); expect(await h.memory.saveJoins('beta', [sibling])).toEqual({ kind: 'saved' })
    expectOnlySavedJoin(h, sibling, 'beta')
    h.io.heal(); await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    expect(savedJoins(h)).toEqual([joinRecord(first, 2), joinRecord(second, 3)])
    expect(h.posts).toHaveLength(2); expect(h.posts.at(-1)).toEqual(recoveryNotice(h))
    expect(h.logs).toHaveLength(2); expect(h.logs.at(-1)).toBe(buildThreadMemoryRecoveredLine('alpha', [C.primary]))
    const writes = h.io.writes().length; await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    expect(h.posts).toHaveLength(2); expect(h.io.writes()).toHaveLength(writes)
    expect(h.retryEvents.every(e => !('key' in e) || e.key === 'alpha')).toBe(true)
  })

  test('read recovery merges pending and kept joins; both outages close only after the failed flush is saved', async () => {
    const h = reportingFixture(); expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    const disk = h.fact(), kept = h.fact({ root: R.secondary }), pending = h.fact({ root: R.third })
    seedReadable(h, [disk]); const sibling = h.fact({}, 'beta'); seedReadable(h, [sibling], 'beta')
    h.io.fail('readFileSync'); await h.start()
    expect(h.memory.addJoin('alpha', kept)).toBe(true); h.memory.recoverJoins('alpha', [pending])
    await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(h.posts).toHaveLength(1); expect(h.logs).toHaveLength(1)
    expect(h.memory.isJoinSaved('beta', sibling)).toBe(true)
    const extra = h.fact({ root: R.secondary }, 'beta')
    expect(await h.memory.saveJoins('beta', [extra])).toEqual({ kind: 'saved' })
    h.io.heal(); const writeError = h.io.fail('writeSync')
    await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS * 2)
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 2, missing: false })
    expect(h.posts).toEqual([
      notice(h, ref => buildThreadMemoryUnreadableNotice(ref, [C.primary], threadPath(h.stateDir))),
      notice(h, ref => buildThreadMemoryNotSavedNotice(ref, [C.primary], threadPath(h.stateDir), 'journal-append', writeError)),
    ])
    expect(h.episodes.isOpen('alpha', THREAD_MEMORY_UNREADABLE)).toBe(true)
    expect(h.episodes.isOpen('alpha', THREAD_MEMORY_NOT_SAVED)).toBe(true)
    expect(savedJoins(h)).toEqual([joinRecord(disk)])
    h.io.heal(); await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
    for (const fact of [disk, kept, pending]) expect(h.memory.isJoinSaved('alpha', fact)).toBe(true)
    expect(h.posts).toHaveLength(3); expect(h.posts.at(-1)).toEqual(recoveryNotice(h))
    expect(h.logs.filter(line => line === buildThreadMemoryRecoveredLine('alpha', [C.primary]))).toHaveLength(1)
    expect(h.episodes.isOpen('alpha', THREAD_MEMORY_UNREADABLE)).toBe(false)
    expect(h.episodes.isOpen('alpha', THREAD_MEMORY_NOT_SAVED)).toBe(false)
    expect(h.posts.every(post => post.key === 'alpha')).toBe(true)
  })

  describe('read recovery across authority publication', () => {
    async function deferredPublication(kind: 'kept' | 'pending', outcome: 'current' | 'stale' = 'current',
      canRun?: NonNullable<Parameters<typeof fixture>[0]>['canRun']) {
      const h = reportingFixture({ seal: false, canRun })
      expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
      seedReadable(h); seedReadable(h, [], 'beta')
      const queue = await makeQueue(h.stateDir, { now: h.clock.now })
      try {
        h.io.fail('readFileSync'); await h.start()
        const fact = h.fact({ source: kind === 'kept' ? 'mention' : 'broadcast' })
        expect((await queue.accept('alpha', slackInput({ channel: fact.channel, via: fact.source,
          text: `private-publication-${LEAK_SENTINEL}`,
          thread_join: { thread_ts: fact.root, stamp: fact.stamp, at: fact.at },
        }))).status).toBe('accepted')
        if (kind === 'kept') {
          expect(h.memory.addJoin('alpha', fact)).toBe(true)
          expect(await h.memory.saveJoins('alpha', [fact])).toEqual({ kind: 'kept' })
          expect(view(h)).toBe('joined')
        }
        // A real unsynced authority change defers stamp judgment. Recovering
        // durability later publishes either the same stamp or a stale choice.
        h.failShared(() => 'unsynced')
        expect((outcome === 'current' ? h.mode('open') : h.choose('mentions')).kind).toBe('unresolved')
        expect(h.authority.channelStamp('alpha', fact.channel)).toEqual({ kind: 'undecided' })
        if (kind === 'pending') recoverQueuedJoins('alpha', queue, h.memory)
        expect(h.memory.outage('alpha')).toEqual({ unknown: true, unsaved: 1, missing: false })
        h.io.heal()
        return { h, fact, queue, publish() {
          h.failShared(); expect(h.authority.recoverDurability().kind).toBe('applied')
        } }
      } catch (error) { await queue.stop(); throw error }
    }
    function expectRecovery(h: ReturnType<typeof reportingFixture>, count: 0 | 1) {
      expect(h.posts.filter(p => p.text === recoveryNotice(h).text)).toHaveLength(count)
      expect(h.logs.filter(line => line === buildThreadMemoryRecoveredLine('alpha', h.authority.threadView().threadHybridChannels('alpha')))).toHaveLength(count)
      expect(h.episodes.isOpen('alpha', THREAD_MEMORY_UNREADABLE)).toBe(count === 0)
    }

    test.each([
      ['kept', 'current'], ['pending', 'current'], ['kept', 'stale'], ['pending', 'stale'],
    ] as const)('%s join with a %s publication settles once without new traffic', async (kind, outcome) => {
      const { h, fact, queue, publish } = await deferredPublication(kind, outcome)
      try {
        const before = journalBytes(h)
        await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
        expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 1, missing: false })
        expect(h.memory.isJoinSaved('alpha', fact)).toBe(false)
        expect(h.posts).toEqual([notice(h, ref => buildThreadMemoryUnreadableNotice(ref, [C.primary], threadPath(h.stateDir)))])
        expectRecovery(h, 0)
        expect(h.retryEvents.filter(e => e.type === 'append-retry-started')).toHaveLength(kind === 'kept' ? 1 : 0)
        const deadline = h.clock.pending()[0]?.dueAt
        h.io.reset(); publish()
        if (outcome === 'current') {
          expect(h.authority.channelStamp('alpha', fact.channel)).toEqual({ kind: 'decided', ...fact.stamp })
          // Publication schedules saving; it cannot claim an append is durable.
          expect(h.memory.outage('alpha').unsaved).toBe(1); expectRecovery(h, 0)
          expect(journalBytes(h)).toEqual(before)
          h.memory.published(); await h.clock.flush()
          if (kind === 'kept') {
            expect(h.clock.pending().map(t => t.dueAt)).toEqual([deadline!])
            expectRecovery(h, 0)
            await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS - 1)
            expect(h.io.writes()).toEqual([]); expect(journalBytes(h)).toEqual(before)
            await h.clock.advance(1)
          }
          expect(h.memory.isJoinSaved('alpha', fact)).toBe(true)
          expect(savedJoins(h)).toEqual([joinRecord(fact)])
          expect(view(h)).toBe('joined')
          expect(h.io.calls.filter(c => c.op === 'writeSync' && c.path === threadPath(h.stateDir))).toHaveLength(1)
        } else {
          expect(h.memory.isJoinSaved('alpha', fact)).toBe(false)
          expect(view(h)).toBe('not-joined')
          expect(savedJoins(h)).toEqual([]); expect(journalBytes(h)).toEqual(before)
          expect(h.io.writes()).toEqual([])
        }
        expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 0, missing: false })
        expect(h.memory.keptFacts('alpha')).toEqual([]); expectRecovery(h, 1)
        expect(h.events.filter(e => e.type === 'outage-settled')).toEqual([
          { type: 'outage-settled', key: 'alpha', path: threadPath(h.stateDir) },
        ])
        expect(h.posts).toHaveLength(2); expect(h.posts.every(p => p.key === 'alpha')).toBe(true)
        const posts = [...h.posts], logs = [...h.logs], writes = [...h.io.writes()]
        await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS * 2)
        h.memory.published(); await h.clock.flush()
        expect(h.posts).toEqual(posts); expect(h.logs).toEqual(logs); expect(h.io.writes()).toEqual(writes)
        expect(h.clock.pendingCount()).toBe(0); expect(queue.items('alpha')).toHaveLength(1)
      } finally { await queue.stop() }
    })

    test('a published pending join reports recovery only after its failed fsync becomes durable', async () => {
      const { h, fact, queue, publish } = await deferredPublication('pending')
      try {
        await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
        const error = h.io.fail('fsync'); h.io.reset(); publish()
        expectRecovery(h, 0); expect(h.memory.outage('alpha').unsaved).toBe(1)
        await h.clock.flush()
        expect(h.io.calls.some(c => c.op === 'writeSync' && c.path === threadPath(h.stateDir))).toBe(true)
        expect(h.events).toContainEqual({ type: 'append-failed', key: 'alpha', path: threadPath(h.stateDir), step: 'journal-append', error, noticeOnly: false })
        expect(h.events.filter(e => e.type === 'outage-settled')).toEqual([])
        expect(h.memory.isJoinSaved('alpha', fact)).toBe(false); expectRecovery(h, 0)
        expect(h.episodes.isOpen('alpha', THREAD_MEMORY_NOT_SAVED)).toBe(true)
        expect(h.posts).toHaveLength(2)
        h.io.heal(); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS - 1)
        expectRecovery(h, 0)
        await h.clock.advance(1)
        expect(h.memory.isJoinSaved('alpha', fact)).toBe(true)
        expect(savedJoins(h)).toEqual([joinRecord(fact)])
        expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 0, missing: false })
        expectRecovery(h, 1); expect(h.episodes.isOpen('alpha', THREAD_MEMORY_NOT_SAVED)).toBe(false)
        expect(h.posts).toHaveLength(3)
        const posts = [...h.posts], logs = [...h.logs]
        h.memory.published(); await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS * 2)
        expect(h.posts).toEqual(posts); expect(h.logs).toEqual(logs); expect(h.clock.pendingCount()).toBe(0)
      } finally { await queue.stop() }
    })

    test.each(['kept', 'pending'] as const)('cancelling %s saving at publication retains the fact and lets a sibling save', async kind => {
      const blocked = new Set<string>()
      const { h, fact, queue, publish } = await deferredPublication(kind, 'current', key => !blocked.has(key))
      try {
        await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
        const before = journalBytes(h), posts = [...h.posts], logs = [...h.logs]
        h.io.reset(); publish(); blocked.add('alpha'); h.retries.forget('alpha')
        await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS * 2)
        expect(journalBytes(h)).toEqual(before); expect(h.io.writes()).toEqual([])
        expect(h.memory.isJoinSaved('alpha', fact)).toBe(false)
        expect(h.memory.keptFacts('alpha')).toEqual([fact]); expect(view(h)).toBe('joined')
        expect(h.events.filter(e => e.type === 'outage-settled')).toEqual([])
        expect(h.posts).toEqual(posts); expect(h.logs).toEqual(logs); expectRecovery(h, 0)
        const sibling = h.fact({}, 'beta')
        expect(await h.memory.saveJoins('beta', [sibling])).toEqual({ kind: 'saved' })
        expectOnlySavedJoin(h, sibling, 'beta'); expect(journalBytes(h)).toEqual(before)
        expect(h.posts).toEqual(posts); expect(h.clock.pendingCount()).toBe(0)
        // This is a store gate control; pb owns the actual lifecycle schedule.
        blocked.delete('alpha')
        expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
        expect(savedJoins(h)).toEqual([joinRecord(fact)]); expectRecovery(h, 1)
      } finally { await queue.stop() }
    })

    test('decided publication cannot settle a missing journal or start saving its kept join', async () => {
      const { h, fact, queue, publish } = await deferredPublication('kept')
      try {
        h.io.removeJournal(); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
        expect(h.memory.outage('alpha')).toEqual({ unknown: true, unsaved: 1, missing: true })
        const posts = [...h.posts], logs = [...h.logs]
        h.io.reset(); publish(); await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS * 2)
        expect(h.memory.outage('alpha')).toEqual({ unknown: true, unsaved: 1, missing: true })
        expect(h.memory.keptFacts('alpha')).toEqual([fact]); expect(view(h)).toBe('joined')
        expect(h.io.writes()).toEqual([]); expect(existsSync(threadPath(h.stateDir))).toBe(false)
        expect(h.events.filter(e => e.type === 'outage-settled')).toEqual([])
        expect(h.retryEvents.filter(e => e.type === 'append-retry-started')).toEqual([])
        expect(h.posts).toEqual(posts); expect(h.logs).toEqual(logs); expectRecovery(h, 0)
        expect(h.clock.pendingCount()).toBe(0)
      } finally { await queue.stop() }
    })
  })

  test('missing on a background read logs once, stays unknown and never posts recovery', async () => {
    const h = reportingFixture(); seedReadable(h)
    h.io.fail('readFileSync'); await h.start(); h.io.removeJournal(); h.io.heal()
    await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(h.memory.outage('alpha')).toEqual({ unknown: true, unsaved: 0, missing: true })
    expect(h.retryEvents).toEqual([{ type: 'read-retry-started', key: 'alpha' }, { type: 'journal-missing-on-retry', key: 'alpha' }])
    expect(h.posts).toHaveLength(1)
    expect(h.logs.at(-1)).toBe(buildThreadMemoryUnreadableLine('alpha', [C.primary], '', undefined, true))
    const calls = [...h.io.calls]; await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS * 2)
    expect(h.io.calls).toEqual(calls); expect(h.logs).toHaveLength(2); expect(h.posts).toHaveLength(1)
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
  })

  test('outage discards stale unreferenced facts but keeps facts still named by a hold', async () => {
    const held: Array<{ channel: string; stamp: ThreadJoin['stamp'] }> = []
    const h = fixture({ heldStamps: () => held }); await h.start(); const first = h.fact()
    h.io.fail('writeSync'); await h.memory.saveJoins('alpha', [first])
    held.push({ channel: first.channel, stamp: first.stamp })
    expect(h.choose('all').kind).toBe('applied')
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 1, missing: false })
    held.length = 0
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 0, missing: false })
    expect(h.choose('thread_hybrid').kind).toBe('applied')
    const pending = h.fact(); h.memory.forget('alpha'); h.io.heal(); h.io.fail('readFileSync'); await h.memory.loadKey('alpha')
    h.memory.recoverJoins('alpha', [pending]); expect(h.memory.outage('alpha').unsaved).toBe(1)
    expect(h.choose('all').kind).toBe('applied')
    expect(h.memory.outage('alpha')).toEqual({ unknown: true, unsaved: 0, missing: false })
  })

  test.each(['absent', 'saved', 'kept'] as const)('quarantine reports readable identities and unknown lines, preserving %s evidence', async evidence => {
    const h = reportingFixture({ seal: false }), fact = h.fact()
    const lost = damagedThreadLine(joinRecord(fact), 'json')
    const unidentified = damagedThreadLine(threadHeader(), 'invalid-header')
    seedThreads(h.stateDir, [threadHeader(), lost, unidentified, joinRecord(h.fact({ root: R.third }), 4),
      ...(evidence === 'saved' ? [joinRecord(fact, 5)] : [])])
    if (evidence === 'kept') h.io.fail('readFileSync')
    await h.start()
    if (evidence === 'kept') {
      expect(h.memory.addJoin('alpha', fact)).toBe(true); h.io.heal()
      await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    }
    const quarantine = h.events.find(e => e.type === 'lines-quarantined')!
    if (quarantine.type !== 'lines-quarantined') throw new Error('expected quarantine')
    expect(quarantine.facts).toEqual([
      { line: 2, invalidFinalLine: false, channel: C.primary, root: R.primary },
      { line: 3, invalidFinalLine: false },
    ])
    expect(readFileSync(quarantine.quarantinePath)).toEqual(Buffer.concat([lost, unidentified]))
    const loss = { threads: [{ channel: C.primary, root: R.primary }], messages: [], unreadableLines: 1 }
    const expected = lossNotice(h, loss)
    expect(h.posts.filter(p => p.text === expected.text)).toEqual([expected])
    expect(h.logs).toContain(buildThreadMemoryQuarantinedLine('alpha', quarantine.quarantinePath, 2, 0))
    expect(h.logs.filter(line => line === buildThreadMemoryJoinsLostLine(h.authority.config().personas[0]!, loss))).toHaveLength(1)
    expect(view(h)).toBe(evidence === 'absent' ? 'not-joined' : 'joined')
    expect(view(h, R.third)).toBe('joined')
  })

  test('a lone torn final line is quarantined and logged without a Joins lost post', async () => {
    const h = reportingFixture({ seal: false }), torn = damagedThreadLine(joinRecord(h.fact()), 'torn')
    seedThreads(h.stateDir, [threadHeader(), torn]); await h.start()
    const quarantine = h.events.find(e => e.type === 'lines-quarantined')!
    if (quarantine.type !== 'lines-quarantined') throw new Error('expected quarantine')
    expect(h.posts).toEqual([])
    expect(h.logs).toEqual([buildThreadMemoryQuarantinedLine('alpha', quarantine.quarantinePath, 1, 1)])
    expect(readFileSync(quarantine.quarantinePath).equals(torn)).toBe(true)
    expect(view(h)).toBe('not-joined')
  })

  test('long-name quarantine keeps the formatted notice bounded and the full name and every lost thread in its log', async () => {
    const h = reportingFixture({ seal: false }), name = 'N'.repeat(2100)
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', [name, 'beta'])).kind).toBe('applied')
    const persona = h.authority.config().personas[0]!, key = persona.key
    const lost = [h.fact({}, key), h.fact({ root: R.secondary }, key)], saved = h.fact({ root: R.third }, key)
    seedThreads(h.stateDir, [threadHeader(),
      ...lost.map((fact, i) => damagedThreadLine(joinRecord(fact, i + 2), 'json')),
      joinRecord(saved, 4)], key)
    const sourceBytes = h.authority.sourceBytes()
    await h.start()
    const loss = { threads: lost.map(fact => ({ channel: fact.channel, root: fact.root })), messages: [], unreadableLines: 0 }
    expect(h.posts).toEqual([lossNotice(h, loss, key)])
    const text = h.posts[0]!.text
    expect(text.length).toBeLessThanOrEqual(THREAD_MEMORY_NOTICE_MAX_CHARS)
    expect(text).not.toContain(name)
    // The complete identifiers still fit after the name fallback; none is counted away.
    expect(text.split('\n').slice(1)).toHaveLength(lost.length)
    for (const fact of lost) {
      expect(text).toContain(`${fact.channel} / ${fact.root}.`)
      expect(h.memory.view(key, fact.channel, fact.root)).toBe('not-joined')
    }
    const line = buildThreadMemoryJoinsLostLine(persona, loss)
    expect(h.logs.filter(log => log === line)).toHaveLength(1)
    expect(line).toContain(renderPersonaRef(name, key))
    for (const fact of lost) expect(line).toContain(`channel=${fact.channel} root=${fact.root}`)
    expectOnlySavedJoin(h, joinRecord(saved, 4), key)
    expect(h.authority.config().personas[0]).toEqual(persona)
    expect(h.authority.sourceBytes()).toEqual(sourceBytes)
  })

  test('withdrawn holds report every identifier once; the post counts overflow and the log keeps it all', async () => {
    const h = reportingFixture(); await h.start()
    const inputs = Array.from({ length: 120 }, (_, i) => {
      const ts = `${THREAD_TIME / 1000}.${String(i + 10).padStart(6, '0')}`
      return heldSlackInput(memoryHold(h.clock.now(), { thread_ts: ts, stamp: h.fact().stamp }), {
        channel: C.primary, ts, text: `private-message-${LEAK_SENTINEL}`, key: { chat_id: C.primary, ts },
      })
    })
    const event: Extract<MemoryHoldEvent, { type: 'withdrawn' }> = { type: 'withdrawn', key: 'alpha',
      holds: inputs.map((input, i) => ({ seq: i + 1, channel: input.channel!, thread_ts: input.hold!.thread_ts, ts: input.ts! })),
    }
    h.reporting.holdsEvent(event)
    const loss = { threads: event.holds.map(x => ({ channel: x.channel, root: x.thread_ts })),
      messages: event.holds.map(x => ({ channel: x.channel, ts: x.ts })) }
    expect(h.posts).toEqual([lossNotice(h, loss)])
    expect(h.posts[0]!.text.length).toBeLessThanOrEqual(THREAD_MEMORY_NOTICE_MAX_CHARS)
    const lines = h.posts[0]!.text.split('\n'), shown = lines.length - 2
    expect(shown).toBeGreaterThan(0); expect(shown).toBeLessThan(event.holds.length * 2)
    expect(lines.at(-1)).toStartWith(String(event.holds.length * 2 - shown))
    expect(h.logs).toEqual([buildThreadMemoryJoinsLostLine(h.authority.config().personas[0]!, loss)])
    for (const hold of event.holds) expect(h.logs[0]).toContain(`channel=${hold.channel} ts=${hold.ts}`)
    expect(h.logs[0]!.length).toBeGreaterThan(THREAD_MEMORY_NOTICE_MAX_CHARS)
    assertNoLeak({ event, posts: h.posts, logs: h.logs })
  })

  test.each(['startup-changed', 'startup-unclean', 'first-read'] as const)('%s reports the real seal finding once despite startup replay', async mode => {
    const h = reportingFixture(); seedReadable(h, [h.fact()])
    seedThreadSeal(h.stateDir, { alpha: mode === 'startup-unclean' ? runningSealEntry() : cleanSealEntry(h.stateDir, 'alpha', { storeId: 'previous-store' }) })
    if (mode === 'first-read') h.io.fail('readFileSync')
    await h.start()
    if (mode === 'first-read') {
      expect(h.seal.startupFindings()).toEqual([])
      h.io.heal(); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    }
    const findings = h.seal.startupFindings()
    expect(findings).toEqual([{ key: 'alpha', case: mode === 'startup-unclean' ? 'unclean-stop' : 'journal-changed',
      wording: mode === 'startup-unclean' ? 'unclean' : 'changed' }])
    h.reporting.startupFindings(findings); h.reporting.startupFindings(findings)
    const finding = findings[0]!
    if (finding.case === 'own-post-joins-lost') throw new Error('expected changed-while-stopped finding')
    const expected = notice(h, ref => buildThreadMemoryChangedWhileStoppedNotice(ref, [C.primary], finding.wording))
    expect(h.posts.filter(post => post.text === expected.text)).toEqual([expected])
    expect(h.logs.filter(line => line === buildThreadMemoryChangedWhileStoppedLine('alpha', [C.primary], finding.case, finding.wording))).toHaveLength(1)
  })

  test.each([false, true])('seal write failure (unsynced=%s) retries without holding persona reads, appends or selection', async unsynced => {
    const h = reportingFixture(); expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    const disk = h.fact(); seedReadable(h, [disk]); seedReadable(h, [], 'beta')
    h.io.fail('readFileSync'); await h.start(); h.sealIo.failWrite(unsynced)
    const result = await h.seal.flush()
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('expected seal write refusal')
    expect(result.unsynced).toBe(unsynced)
    expect(h.logs.at(-1)).toBe(buildThreadMemorySealNotSavedLine(threadSealPath(h.stateDir), result.error, unsynced))
    expect(h.posts).toHaveLength(1)
    // These all finish before virtual time moves or the shared seal heals.
    h.io.heal(); expect(await h.memory.retryRead('alpha')).toBe('read')
    const sibling = h.fact({}, 'beta')
    expect(await h.memory.saveJoins('beta', [sibling])).toEqual({ kind: 'saved' })
    expect(view(h)).toBe('joined'); expectOnlySavedJoin(h, sibling, 'beta')
    expect(h.clock.now()).toBe(THREAD_TIME)
    const posts = [...h.posts], failureCount = h.sealEvents.filter(e => e.type === 'seal-write-failed').length
    h.sealIo.heal(); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(h.retryEvents).toContainEqual({ type: 'seal-written-after-retries', attempts: 1 })
    expect(h.sealEvents.filter(e => e.type === 'seal-write-failed')).toHaveLength(failureCount)
    expect(h.posts).toEqual(posts)
    expect(Object.keys(readThreadSeal(h.stateDir).entries).sort()).toEqual(['alpha', 'beta'])
  })

  test('compaction and removal failures log their step and path without posting', async () => {
    const h = reportingFixture(); await h.start(); await h.memory.saveJoins('alpha', [h.fact()])
    const rewrite = h.io.fail('rename'); await h.memory.compact()
    expect(h.logs).toEqual([buildThreadMemoryCompactionFailedLine('alpha', threadPath(h.stateDir), 'journal-rewrite', rewrite)])
    h.io.heal(); const unlink = h.io.fail('unlinkSync'); expect((await h.memory.remove('alpha')).kind).toBe('failed')
    expect(h.logs.at(-1)).toBe(buildThreadMemoryRemovalFailedLine('alpha', threadPath(h.stateDir), 'journal-unlink', unlink))
    expect(h.logs).toHaveLength(2); expect(h.posts).toEqual([])
    expect(existsSync(threadPath(h.stateDir))).toBe(true)
  })

  test.each(['rename', 'directory fsync'] as const)('compaction %s failures retain every event; only durable recovery closes the log episode, and recurrence reports anew', async step => {
    const h = reportingFixture({ seal: false }); await h.start()
    const fact = h.fact(); await h.memory.saveJoins('alpha', [fact])
    const path = threadPath(h.stateDir), before = h.events.length
    const fail = () => h.io.fail(step === 'rename' ? 'rename' : 'fsync', 'alpha', {
      match: p => step === 'rename' ? p.startsWith(path + '.') : p === join(h.stateDir, 'threads'),
    })
    const error = fail()
    await h.memory.compact(); await h.memory.compact()
    expect(h.events.slice(before)).toEqual([1, 2].map(() => ({ type: 'compaction-failed', key: 'alpha', path, step: 'journal-rewrite', error })))
    const onset = buildThreadMemoryCompactionFailedLine('alpha', path, 'journal-rewrite', error)
    expect(h.logs).toEqual([onset])
    // A healthy read/append is unrelated to a failed rewrite.
    await h.memory.retryRead('alpha'); await h.memory.flush('alpha')
    expect(h.logs).toEqual([onset])
    h.io.heal()
    const held = h.io.hold('fsync', 'alpha', { match: p => p === join(h.stateDir, 'threads') })
    const pending = h.memory.compact()
    try {
      await held.reached
      expect(h.events.slice(before).map(e => e.type)).toEqual(['compaction-failed', 'compaction-failed'])
      expect(h.logs).toEqual([onset])
    } finally { held.release(); await pending }
    const recovered = buildThreadMemoryCompactionRecoveredLine('alpha', path)
    expect(h.events.at(-1)).toEqual({ type: 'compacted', key: 'alpha', path, outcome: 'rewritten' })
    expect(h.logs).toEqual([onset, recovered]); expectOnlySavedJoin(h, fact)
    await h.memory.compact(); expect(h.logs).toEqual([onset, recovered])
    const again = fail(); await h.memory.compact()
    h.io.heal(); await h.memory.compact()
    expect(h.logs).toEqual([onset, recovered, buildThreadMemoryCompactionFailedLine('alpha', path, 'journal-rewrite', again), recovered])
    expect(h.posts).toEqual([])
  })

  test('a durable compaction recovers while the independent seal write still fails', async () => {
    const h = reportingFixture(); await h.start(); await h.memory.saveJoins('alpha', [h.fact()])
    const error = h.io.fail('rename'); await h.memory.compact()
    h.io.heal(); h.sealIo.failWrite()
    await h.memory.compact(); await h.clock.flush()
    expect(h.logs.slice(0, 2)).toEqual([
      buildThreadMemoryCompactionFailedLine('alpha', threadPath(h.stateDir), 'journal-rewrite', error),
      buildThreadMemoryCompactionRecoveredLine('alpha', threadPath(h.stateDir)),
    ])
    expect(h.sealEvents.at(-1)?.type).toBe('seal-write-failed')
    expect(h.logs).toHaveLength(3)
    h.sealIo.heal(); await h.seal.flush()
    expect(h.logs.at(-1)).toBe(buildThreadMemorySealSavedLine(threadSealPath(h.stateDir)))
    expect(h.posts).toEqual([])
  })

  test.each(['forget', 'remove', 'stopKeys'] as const)('%s cancels both real read and append series before their next timer can run', async action => {
    const h = reportingFixture({ seal: false }); expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    seedReadable(h); h.io.fail('readFileSync'); await h.start(); h.io.fail('writeSync', 'beta')
    await h.memory.saveJoins('beta', [h.fact({}, 'beta')])
    expect(h.clock.pendingCount()).toBe(2)
    if (action === 'stopKeys') h.retries.stopKeys()
    else for (const key of ['alpha', 'beta']) h.retries.forget(key, action === 'remove' ? 'removal' : 'teardown')
    expect(h.clock.pendingCount()).toBe(0)
    expect(h.retryEvents.filter(e => e.type === 'retry-cancelled').sort((a, b) => ('key' in a ? a.key : '').localeCompare('key' in b ? b.key : ''))).toEqual([
      { type: 'retry-cancelled', series: 'read', key: 'alpha', why: action === 'remove' ? 'removal' : action === 'stopKeys' ? 'shutdown' : 'teardown' },
      { type: 'retry-cancelled', series: 'append', key: 'beta', why: action === 'remove' ? 'removal' : action === 'stopKeys' ? 'shutdown' : 'teardown' },
    ])
    h.io.heal()
    if (action === 'remove') for (const key of ['alpha', 'beta']) expect(await h.memory.remove(key)).toEqual({ kind: 'saved' })
    else if (action === 'forget') for (const key of ['alpha', 'beta']) h.memory.forget(key)
    const calls = [...h.io.calls], posts = [...h.posts], logs = [...h.logs]
    expect(await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS * 2)).toBe(0)
    expect(h.io.calls).toEqual(calls); expect(h.posts).toEqual(posts); expect(h.logs).toEqual(logs)
    if (action === 'remove') for (const key of ['alpha', 'beta']) expect(existsSync(threadPath(h.stateDir, key))).toBe(false)
  })

  test('forgetting an unreadable persona leaves its sibling append retry and reports intact', async () => {
    const h = reportingFixture({ seal: false }); expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    seedReadable(h); h.io.fail('readFileSync'); await h.start()
    h.io.fail('writeSync', 'beta'); const fact = h.fact({}, 'beta')
    await h.memory.saveJoins('beta', [fact])
    expect(h.clock.pendingCount()).toBe(2)
    h.retries.forget('alpha'); h.memory.forget('alpha'); h.episodes.forget('alpha')
    expect(h.clock.pendingCount()).toBe(1)
    const alphaPosts = h.posts.filter(p => p.key === 'alpha')
    h.io.heal(); h.io.reset(); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(h.memory.isJoinSaved('beta', fact)).toBe(true)
    expect(h.posts.filter(p => p.key === 'alpha')).toEqual(alphaPosts)
    expect(h.posts.at(-1)).toEqual(recoveryNotice(h, 'beta'))
    expect(h.io.calls.some(c => c.path === threadPath(h.stateDir, 'alpha'))).toBe(false)
    expect(h.clock.pendingCount()).toBe(0)
  })

  test('shutdown cancels key and seal retries, including a failed final seal write', async () => {
    const h = reportingFixture(); await h.start()
    h.io.fail('writeSync'); await h.memory.saveJoins('alpha', [h.fact()])
    h.sealIo.failWrite(); await h.seal.flush()
    expect(h.retryEvents).toContainEqual({ type: 'seal-retry-started' })
    const before = h.sealEvents.filter(e => e.type === 'seal-write-failed').length
    // The server's final-result handler owns shutdown logging; its executable
    // coverage belongs in server-startup-wiring.test.ts.
    // Ordinary reporter callbacks stay silent once episodes close, even while
    // the real seal makes its last write and the retry owner is still alive.
    h.episodes.close()
    const posts = [...h.posts], logs = [...h.logs]
    await h.close()
    // The last shutdown write was attempted despite an already active series.
    expect(h.sealEvents.filter(e => e.type === 'seal-write-failed')).toHaveLength(before + 1)
    expect(h.posts).toEqual(posts); expect(h.logs).toEqual(logs)
    expect(h.retryEvents.filter(e => e.type === 'retry-cancelled')).toEqual([
      { type: 'retry-cancelled', series: 'append', key: 'alpha', why: 'shutdown' },
      { type: 'retry-cancelled', series: 'seal', why: 'shutdown' },
    ])
    expect(h.clock.pendingCount()).toBe(0)
    h.io.heal(); h.sealIo.heal(); h.io.reset(); h.sealIo.reset()
    h.retries.appendFailed('alpha'); h.retries.readFailed('alpha'); h.retries.sealWriteFailed()
    expect(await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS * 2)).toBe(0)
    expect(h.io.calls).toEqual([]); expect(h.sealIo.calls).toEqual([])
  })

  test('failed and recovered join writes expose metadata only, never incoming text or credential fields', async () => {
    const h = reportingFixture(); await h.start()
    const message = `private-message-${LEAK_SENTINEL}`, token = fakeToken(BOT_TOKEN_PREFIX, 'thread-report')
    const fact = { ...h.fact(), text: message, token }
    h.io.fail('writeSync'); expect((await h.memory.saveJoins('alpha', [fact])).kind).toBe('failed')
    h.io.heal(); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    expect(h.posts).toHaveLength(2); expect(h.memory.isJoinSaved('alpha', fact)).toBe(true)
    const captured = { posts: h.posts, logs: h.logs, events: h.events, retries: h.retryEvents,
      joins: h.memory.joins('alpha'), journal: writtenFile(threadPath(h.stateDir)) }
    assertNoLeak(captured)
    expect(JSON.stringify(captured)).not.toContain(message)
  })

  test('a closed work gate cancels an admitted flush without losing kept facts or blocking a sibling', async () => {
    const blocked = new Set<string>()
    const h = reportingFixture({ seal: false, canRun: key => !blocked.has(key) })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    await h.start(); const fact = h.fact()
    h.io.fail('writeSync'); expect((await h.memory.saveJoins('alpha', [fact])).kind).toBe('failed')
    h.io.heal(); h.io.reset()
    const before = journalBytes(h), events = [...h.events], posts = [...h.posts], logs = [...h.logs]
    // Admission precedes the gate change; the serialized store turn has yet to run.
    // The real lifecycle schedule is covered by the reload harness.
    const admitted = h.memory.flush('alpha')
    blocked.add('alpha'); h.retries.forget('alpha')
    expect(await admitted).toEqual({ kind: 'cancelled' })
    expect(journalBytes(h)).toEqual(before); expect(h.io.calls).toEqual([])
    expect(h.memory.keptFacts('alpha')).toEqual([fact]); expect(view(h)).toBe('joined')
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 1, missing: false })
    expect(h.events).toEqual(events); expect(h.posts).toEqual(posts); expect(h.logs).toEqual(logs)
    expect(await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)).toBe(0)
    const sibling = h.fact({}, 'beta')
    expect(await h.memory.saveJoins('beta', [sibling])).toEqual({ kind: 'saved' })
    expectOnlySavedJoin(h, sibling, 'beta'); expect(journalBytes(h)).toEqual(before)
    // Reopening the gate alone preserves the original kept fact for a later save.
    blocked.delete('alpha')
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(savedJoins(h)).toEqual([joinRecord(fact)]); expect(h.memory.keptFacts('alpha')).toEqual([])
    expect(h.posts).toEqual([...posts, recoveryNotice(h)])
    expect(h.events.filter(e => e.type === 'saved-after-failure')).toHaveLength(1)
  })

  test('a closed work gate cancels an admitted read and preserves unknown, kept and pending facts', async () => {
    const blocked = new Set<string>()
    const h = reportingFixture({ seal: false, canRun: key => !blocked.has(key) })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    const disk = h.fact(), kept = h.fact({ root: R.secondary }), pending = h.fact({ root: R.third })
    seedReadable(h, [disk]); seedReadable(h, [], 'beta')
    h.io.fail('readFileSync'); await h.start()
    expect(h.memory.addJoin('alpha', kept)).toBe(true); h.memory.recoverJoins('alpha', [pending])
    h.io.heal(); h.io.reset()
    const before = journalBytes(h), events = [...h.events], posts = [...h.posts], logs = [...h.logs]
    const admitted = h.memory.retryRead('alpha')
    blocked.add('alpha'); h.retries.forget('alpha')
    h.retries.readFailed('alpha'); h.retries.appendFailed('alpha')
    expect(h.clock.pendingCount()).toBe(0)
    // The cancelled read has no separate cancellation result: its lack of I/O,
    // unchanged unknown view and retained evidence distinguish it from a read.
    expect(await admitted).toBe('read')
    await h.memory.loadKey('alpha'); await h.memory.compact('alpha')
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'cancelled' })
    h.memory.published(); h.memory.retryPendingJoins('alpha'); await h.clock.flush()
    expect(h.io.calls).toEqual([]); expect(journalBytes(h)).toEqual(before)
    expect(h.memory.outage('alpha')).toEqual({ unknown: true, unsaved: 2, missing: false })
    expect(h.memory.keptFacts('alpha')).toEqual([kept])
    expect([view(h), view(h, R.secondary), view(h, R.third)]).toEqual(['unknown', 'joined', 'unknown'])
    expect(h.events).toEqual(events); expect(h.posts).toEqual(posts); expect(h.logs).toEqual(logs)
    const sibling = h.fact({}, 'beta')
    expect(await h.memory.saveJoins('beta', [sibling])).toEqual({ kind: 'saved' })
    expectOnlySavedJoin(h, sibling, 'beta')
    blocked.delete('alpha')
    h.retries.readFailed('alpha'); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
    for (const fact of [disk, kept, pending]) expect(h.memory.isJoinSaved('alpha', fact)).toBe(true)
    expect(savedJoins(h)).toHaveLength(3)
    expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 0, missing: false })
    expect(h.posts).toEqual([...posts, recoveryNotice(h)])
  })

  test('a gate closed during creation cancels its queued join but preserves it for recovery', async () => {
    const marker = gate(), blocked = new Set<string>()
    const h = fixture({ canRun: key => !blocked.has(key), setCreated: async key => {
      if (key === 'alpha') await marker.wait()
      return h.authority.setThreadMemoryCreated(key)
    } })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    const starting = h.start()
    try {
      await marker.entered
      const fact = h.fact(), queued = h.memory.saveJoins('alpha', [fact]), before = journalBytes(h)
      h.io.reset(); blocked.add('alpha'); marker.release(); await starting
      expect(await queued).toEqual({ kind: 'cancelled' })
      expect(journalBytes(h)).toEqual(before)
      expect(h.io.calls.filter(c => c.path === threadPath(h.stateDir))).toEqual([])
      expect(h.memory.store('alpha')?.created).toBe(false)
      expect(h.memory.keptFacts('alpha')).toEqual([fact]); expect(view(h)).toBe('joined')
      expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 2, missing: false })
      expect(h.events.filter(e => e.key === 'alpha')).toEqual([])
      const sibling = h.fact({}, 'beta')
      expect(await h.memory.saveJoins('beta', [sibling])).toEqual({ kind: 'saved' })
      expectOnlySavedJoin(h, sibling, 'beta')
      blocked.delete('alpha')
      expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
      expect(savedJoins(h)).toEqual([joinRecord(fact)])
      expect(h.memory.outage('alpha')).toEqual({ unknown: false, unsaved: 0, missing: false })
      expect(h.events.filter(e => e.type === 'created' && e.key === 'alpha')).toHaveLength(1)
    } finally { marker.release(); await starting }
  })

  test('a replacement journal rejects the old queued writer and accepts resupplied recovery facts', async () => {
    const blocked = new Set<string>(), h = fixture({ canRun: key => !blocked.has(key) })
    await h.start(); const fact = h.fact()
    h.io.fail('writeSync'); expect((await h.memory.saveJoins('alpha', [fact])).kind).toBe('failed')
    h.io.heal(); const before = journalBytes(h), events = [...h.events]
    const admitted = h.memory.flush('alpha')
    blocked.add('alpha'); expect(h.memory.keptFacts('alpha')).toEqual([fact])
    h.memory.forget('alpha'); blocked.delete('alpha')
    const loading = h.memory.loadKey('alpha')
    expect(await admitted).toEqual({ kind: 'cancelled' }); await loading
    expect(journalBytes(h)).toEqual(before); expect(view(h)).toBe('not-joined')
    expect(h.events.slice(events.length).some(e => e.type === 'saved-after-failure')).toBe(false)
    // Recovery's source is tested with the real queue in the reload suite.
    h.memory.recoverJoins('alpha', [fact])
    expect(view(h)).toBe('joined'); expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(savedJoins(h)).toEqual([joinRecord(fact)]); expect(h.memory.keptFacts('alpha')).toEqual([])
  })

  test('a closed work gate fences a newly published key before its deferred load and creation', async () => {
    const blocked = new Set<string>(), h = fixture({ canRun: key => !blocked.has(key) })
    await h.start(); h.io.reset()
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    blocked.add('beta'); await h.clock.flush()
    expect(h.io.calls.filter(c => c.path === threadPath(h.stateDir, 'beta'))).toEqual([])
    expect(existsSync(threadPath(h.stateDir, 'beta'))).toBe(false)
    expect(h.authority.threadMemoryCreated('beta')).toBe(false)
    const fact = h.fact(); expect(await h.memory.saveJoins('alpha', [fact])).toEqual({ kind: 'saved' })
    blocked.delete('beta'); await h.memory.loadKey('beta')
    const sibling = h.fact({}, 'beta')
    expect(await h.memory.saveJoins('beta', [sibling])).toEqual({ kind: 'saved' })
    expectOnlySavedJoin(h, sibling, 'beta')
  })

  test('configured paths survive composed unreadable and not-saved reports with safe quoting and Slack escaping', async () => {
    const base = mkdtempSync(join(tmpdir(), 'thread-memory-path-')); threadDirs.push(base)
    const dir = join(base, fakeToken(BOT_TOKEN_PREFIX, 'configured-path'), '<ops>&"quoted"\nline\u2028separator')
    mkdirSync(dir, { recursive: true })
    // This fixture has a deliberate token-shaped configured path. Audit only
    // those exact structured fields below; the ordinary teardown audit stays
    // strict for every other fixture. Config and credentials remain under base.
    const h = makeThreadMemoryHarness(dir, { seal: true, failureHandling: true, input: threadConfig(base) })
    const path = threadPath(dir), quoted = JSON.stringify(path).replace(/\u2028/g, '\\u2028')
    const escaped = escapeSlackControlCharacters(quoted)
    try {
      const disk = h.fact(), kept = h.fact({ root: R.secondary }); seedReadable(h, [disk])
      h.io.fail('readFileSync'); await h.start()
      expect(h.memory.addJoin('alpha', kept)).toBe(true)
      expect(h.posts).toHaveLength(1); expect(h.logs).toHaveLength(1)
      expect(h.posts[0]!.text).toContain(escaped); expect(h.logs[0]).toContain(`path=${quoted}`)
      h.io.heal(); h.io.fail('writeSync'); await h.clock.advance(THREAD_MEMORY_RETRY_MIN_MS)
      expect(h.posts).toHaveLength(2); expect(h.logs).toHaveLength(2)
      expect(h.posts[1]!.text).toContain(escaped); expect(h.logs[1]).toContain(`path=${quoted}`)
      expect(h.memory.isJoinSaved('alpha', kept)).toBe(false)
      for (const line of h.logs) expect(/[\r\n\u2028\u2029]/.test(line)).toBe(false)
      for (const post of h.posts) expect(post.text).not.toContain('<ops>')
      h.io.heal(); await h.clock.advance(THREAD_MEMORY_RETRY_MAX_MS)
      expect(h.posts).toHaveLength(3); expect(h.posts.at(-1)).toEqual(recoveryNotice(h))
      expect(h.memory.isJoinSaved('alpha', kept)).toBe(true)
      expect(savedJoins(h)).toEqual([joinRecord(disk), joinRecord(kept, 3)])
    } finally {
      await h.close(); expect(h.clock.pendingCount()).toBe(0)
      assertNoLeak({
        posts: h.posts.map(post => ({ ...post, text: post.text.replace(escaped, '<configured-path>') })),
        logs: h.logs.map(line => line.replace(`path=${quoted}`, 'path="<configured-path>"')),
        events: h.events.map(event => {
          expect(event.path).toBe(path)
          return { ...event, path: '<configured-path>' }
        }),
        sealEvents: h.sealEvents.map(event => {
          if (!('path' in event)) return event
          expect(event.path).toBe(threadSealPath(dir))
          return { ...event, path: '<configured-path>' }
        }), retries: h.retryEvents,
        state: writtenFile(h.authority.path), journal: writtenFile(path), seal: writtenFile(threadSealPath(dir)),
      })
    }
  })
})

function savedJoinsIfPresent(h: ThreadMemoryHarness) {
  return existsSync(threadPath(h.stateDir)) ? savedJoins(h) : []
}

describe('Thread Memory queued join recovery', () => {
  test('saved-join intake query distinguishes kept facts, equal stamps, other threads and absent journals without I/O', async () => {
    const h = fixture(), fact = h.fact()
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, fact.stamp)).toBe(false)
    await h.start()
    expect(h.memory.addJoin('alpha', fact)).toBe(true)
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, fact.stamp)).toBe(false)
    expect(await h.memory.saveJoins('alpha', [fact])).toEqual({ kind: 'saved' })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], [C.primary, C.secondary])).kind).toBe('applied')
    const otherStamp = h.fact({ channel: C.secondary }).stamp
    expect(otherStamp).not.toEqual(fact.stamp)
    h.io.reset()
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, { ...fact.stamp })).toBe(true)
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, otherStamp)).toBe(false)
    expect(h.memory.hasSavedJoin('alpha', C.secondary, fact.root, fact.stamp)).toBe(false)
    expect(h.memory.hasSavedJoin('alpha', fact.channel, R.secondary, fact.stamp)).toBe(false)
    expect(h.memory.hasSavedJoin('beta', fact.channel, fact.root, fact.stamp)).toBe(false)
    expect(h.io.calls).toEqual([])
    expect(h.choose('mentions').kind).toBe('applied')
    expect(h.choose('thread_hybrid').kind).toBe('applied')
    const current = h.fact()
    expect(current.stamp).not.toEqual(fact.stamp)
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, current.stamp)).toBe(false)
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, fact.stamp)).toBe(false)
  })

  test('retention uses the earliest saved time before activation, never an earlier kept time or an absent authority', async () => {
    const h = fixture(), early = h.fact({ at: THREAD_TIME + 10 }), late = { ...early, at: early.at + 10 }
    seedThreads(h.stateDir, [threadHeader(), joinRecord(late), joinRecord(early, 3)])
    expect(h.memory.hasSavedJoin('alpha', early.channel, early.root, early.stamp)).toBe(false)
    expect(h.memory.threadJoinSaved('alpha', early.channel, early.root, early.stamp, late.at)).toBe(false)
    h.memory.readAtStart(); h.io.reset()
    expect(h.memory.threadJoinSaved('alpha', early.channel, early.root, { ...early.stamp }, early.at)).toBe(true)
    expect(h.memory.threadJoinSaved('alpha', early.channel, early.root, early.stamp, late.at)).toBe(true)
    expect(h.memory.threadJoinSaved('alpha', early.channel, early.root, early.stamp, early.at - 1)).toBe(false)
    expect(h.memory.threadJoinSaved('beta', early.channel, early.root, early.stamp, late.at)).toBe(false)
    expect(view(h)).toBe('not-joined')
    expect(h.io.calls).toEqual([])
    await h.memory.activate()
    const kept = { ...early, at: early.at - 1 }
    expect(h.memory.addJoin('alpha', kept)).toBe(true)
    expect(h.memory.hasSavedJoin('alpha', kept.channel, kept.root, kept.stamp)).toBe(true)
    expect(h.memory.threadJoinSaved('alpha', kept.channel, kept.root, kept.stamp, kept.at)).toBe(false)
    expect(await h.memory.saveJoins('alpha', [kept])).toEqual({ kind: 'saved' })
    expect(h.memory.threadJoinSaved('alpha', kept.channel, kept.root, kept.stamp, kept.at)).toBe(true)
  })

  test('retention confirms an unsaved stale stamp or removed persona, but never an unreadable journal', async () => {
    const h = fixture(); await h.start(); const fact = h.fact()
    expect(h.memory.addJoin('alpha', fact)).toBe(true)
    expect(h.memory.threadJoinSaved('alpha', fact.channel, fact.root, fact.stamp, fact.at)).toBe(false)
    expect(h.choose('mentions').kind).toBe('applied')
    expect(h.memory.threadJoinSaved('alpha', fact.channel, fact.root, fact.stamp, fact.at)).toBe(true)
    expect(h.choose('thread_hybrid').kind).toBe('applied')
    const current = h.fact()
    expect(h.memory.threadJoinSaved('alpha', current.channel, current.root, current.stamp, current.at)).toBe(false)
    expect(h.memory.threadJoinSaved('alpha', fact.channel, fact.root, fact.stamp, fact.at)).toBe(true)
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['beta'])).kind).toBe('applied')
    expect(h.authority.channelStamp('alpha', fact.channel)).toBeUndefined()
    expect(h.memory.threadJoinSaved('alpha', current.channel, current.root, current.stamp, current.at)).toBe(true)

    const unknown = fixture(), saved = unknown.fact()
    seedThreads(unknown.stateDir, [threadHeader(), joinRecord(saved)])
    unknown.io.fail('readFileSync'); await unknown.start()
    expect(view(unknown)).toBe('unknown')
    expect(unknown.memory.hasSavedJoin('alpha', saved.channel, saved.root, saved.stamp)).toBe(false)
    expect(unknown.memory.threadJoinSaved('alpha', saved.channel, saved.root, saved.stamp, saved.at)).toBe(false)
    expect(unknown.choose('mentions').kind).toBe('applied')
    expect(unknown.memory.threadJoinSaved('alpha', saved.channel, saved.root, saved.stamp, saved.at)).toBe(false)
    expect(unknown.memory.hasSavedJoin('alpha', saved.channel, saved.root, saved.stamp)).toBe(false)
  })

  test('pre-activation retention uses saved evidence without requiring the current authority stamp', async () => {
    const h = fixture(), fact = h.fact()
    seedThreads(h.stateDir, [threadHeader(), joinRecord(fact)])
    h.memory.readAtStart()
    // Keep this at the startup read boundary: the fixture's publication listener
    // would otherwise schedule loadKey and activate the journal.
    h.unsubscribe()
    expect(h.choose('mentions').kind).toBe('applied')
    expect(h.authority.channelStamp('alpha', fact.channel)).not.toEqual({ kind: 'decided', ...fact.stamp })
    h.io.reset()
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, fact.stamp)).toBe(false)
    expect(h.memory.threadJoinSaved('alpha', fact.channel, fact.root, fact.stamp, fact.at)).toBe(true)
    expect(h.memory.threadJoinSaved('alpha', fact.channel, fact.root, fact.stamp, fact.at - 1)).toBe(false)
    expect(h.io.calls).toEqual([])
  })

  test.each(['current', 'stale'] as const)('saved-join intake query does not report a saved join while its stamp is undecided (%s after resolution)', async outcome => {
    const h = fixture(); await h.start(); const fact = h.fact()
    await h.memory.saveJoins('alpha', [fact])
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, fact.stamp)).toBe(true)
    h.failShared(() => 'unsynced')
    expect((outcome === 'current' ? h.mode('open') : h.choose('mentions')).kind).toBe('unresolved')
    expect(h.authority.channelStamp('alpha', fact.channel)).toEqual({ kind: 'undecided' })
    expect(view(h)).toBe('not-joined')
    const before = journalBytes(h), events = [...h.events]
    h.io.reset()
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, fact.stamp)).toBe(false)
    expect(h.io.calls).toEqual([])
    h.failShared(); expect(h.authority.recoverDurability().kind).toBe('applied')
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, fact.stamp)).toBe(outcome === 'current')
    expect(view(h)).toBe(outcome === 'current' ? 'joined' : 'not-joined')
    await h.clock.flush()
    expect(journalBytes(h)).toEqual(before); expect(h.events).toEqual(events); expect(h.io.calls).toEqual([])
  })

  test('dry-run intake joins stay unsaved for retention until their real stamp becomes stale', async () => {
    const h = fixture({ dryRun: true }); await h.start(); const fact = h.fact()
    expect(h.memory.addJoin('alpha', fact)).toBe(true)
    expect(await h.memory.saveJoins('alpha', [fact])).toEqual({ kind: 'kept' })
    expect(view(h)).toBe('joined')
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, fact.stamp)).toBe(false)
    expect(h.memory.threadJoinSaved('alpha', fact.channel, fact.root, fact.stamp, fact.at)).toBe(false)
    expect(h.choose('all').kind).toBe('applied')
    expect(h.memory.threadJoinSaved('alpha', fact.channel, fact.root, fact.stamp, fact.at)).toBe(true)
    expect(h.io.writes()).toEqual([])
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
  })

  test('recovery preserves queue order, skips read/kept/earlier recovered coverage, and saves additions in one append', async () => {
    const h = fixture(), read = h.fact({ at: THREAD_TIME + 20 })
    seedThreads(h.stateDir, [threadHeader(), joinRecord(read)])
    await h.start()
    const kept = h.fact({ root: R.secondary, at: THREAD_TIME + 40 })
    h.memory.addJoin('alpha', kept)
    const first = h.fact({ root: R.third, source: 'broadcast', at: THREAD_TIME + 80 })
    const earlier = { ...first, source: 'mention' as const, at: THREAD_TIME + 60 }
    const coveredLast = { ...first, at: THREAD_TIME + 90 }
    h.io.reset()
    h.memory.recoverJoins('alpha', [{ ...read, at: read.at + 10 }, { ...kept, at: kept.at + 10 }, first, earlier, coveredLast])
    expect(h.io.calls).toEqual([]) // Recovery schedules its append; the serial intake/publication turn does no I/O.
    expect(view(h, R.third)).toBe('joined')
    expect(h.memory.keptFacts('alpha')).toEqual([kept, first, earlier])
    expect(h.memory.clock('alpha')).toBe(coveredLast.at + 1)
    await h.clock.flush()
    expect(savedJoins(h)).toEqual([joinRecord(read), joinRecord(first, 3), joinRecord(earlier, 4)])
    expect(h.io.calls.filter(c => c.op === 'writeSync' && c.path === threadPath(h.stateDir))).toHaveLength(1)
    expect(h.io.calls.filter(c => c.op === 'fsync' && c.path === threadPath(h.stateDir))).toHaveLength(1)
    expect(h.memory.keptFacts('alpha')).toEqual([kept])
    await h.close()
    const reopened = fixture({ reopen: true }, h.stateDir); await reopened.start()
    expect(reopened.memory.joins('alpha').map(({ join: fact, savedAt }) => ({ root: fact.root, source: fact.source, at: fact.at, savedAt })))
      .toEqual([{ root: read.root, source: read.source, at: read.at, savedAt: read.at },
        { root: earlier.root, source: earlier.source, at: earlier.at, savedAt: earlier.at }])
    expect(view(reopened, R.secondary)).toBe('not-joined')
  })

  test('stale candidates join nothing but advance the clock past their skipped times', async () => {
    const h = fixture(); await h.start(); const stale = h.fact({ at: THREAD_TIME + 1000 })
    expect(h.choose('mentions').kind).toBe('applied'); expect(h.choose('thread_hybrid').kind).toBe('applied')
    h.io.reset()
    h.memory.recoverJoins('alpha', [stale])
    await h.clock.flush()
    expect(h.memory.joins('alpha')).toEqual([]); expect(h.memory.keptFacts('alpha')).toEqual([])
    expect(view(h)).toBe('not-joined'); expect(savedJoins(h)).toEqual([])
    expect(h.io.calls).toEqual([])
    expect(h.memory.clock('alpha')).toBe(stale.at + 1)
  })

  test.each(['current', 'stale'] as const)('undecided recovery waits for the real publication and judges its %s stamp', async outcome => {
    const h = fixture(); await h.start(); const fact = h.fact({ at: THREAD_TIME + 1000, source: 'broadcast' })
    h.failShared(() => 'unsynced')
    expect((outcome === 'current' ? h.mode('open') : h.choose('mentions')).kind).toBe('unresolved')
    expect(h.authority.channelStamp('alpha', fact.channel)).toEqual({ kind: 'undecided' })
    h.io.reset()
    h.memory.recoverJoins('alpha', [fact])
    expect(h.memory.clock('alpha')).toBe(fact.at + 1)
    expect(h.memory.threadJoinSaved('alpha', fact.channel, fact.root, fact.stamp, fact.at)).toBe(false)
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, fact.stamp)).toBe(false)
    expect(h.memory.joins('alpha')).toEqual([]); expect(view(h)).toBe('not-joined')
    await h.clock.flush(); expect(h.io.calls).toEqual([])
    h.failShared(); expect(h.authority.recoverDurability().kind).toBe('applied')
    // Publication itself rejudges, before a timer or another intake can run.
    expect(view(h)).toBe(outcome === 'current' ? 'joined' : 'not-joined')
    await h.clock.flush()
    expect(savedJoins(h)).toEqual(outcome === 'current' ? [joinRecord(fact)] : [])
    const before = journalBytes(h)
    h.memory.retryPendingJoins('alpha'); await h.clock.flush()
    expect(journalBytes(h)).toEqual(before)
    if (outcome === 'stale') {
      expect(h.choose('thread_hybrid').kind).toBe('applied')
      await h.clock.flush(); expect(view(h)).toBe('not-joined'); expect(savedJoins(h)).toEqual([])
    }
  })

  test('unknown-journal candidates recover on the first successful read and the explicit retry is idempotent', async () => {
    const h = fixture(), disk = h.fact({ at: THREAD_TIME + 10 }), candidate = h.fact({ root: R.secondary, at: THREAD_TIME + 1000 })
    seedThreads(h.stateDir, [threadHeader(), joinRecord(disk)])
    h.io.fail('readFileSync'); await h.start(); h.io.reset()
    h.memory.recoverJoins('alpha', [disk, candidate]); h.memory.retryPendingJoins('alpha')
    await h.clock.flush()
    expect(h.memory.joins('alpha')).toEqual([]); expect(view(h, R.secondary)).toBe('unknown')
    expect(h.io.calls).toEqual([]); expect(h.memory.clock('alpha')).toBe(candidate.at + 1)
    h.io.heal(); await h.memory.loadKey('alpha')
    expect(view(h, R.secondary)).toBe('joined')
    h.memory.retryPendingJoins('alpha'); await h.clock.flush()
    expect(savedJoins(h)).toEqual([joinRecord(disk), joinRecord(candidate, 3)])
    expect(h.memory.hasSavedJoin('alpha', candidate.channel, candidate.root, candidate.stamp)).toBe(true)
    expect(h.memory.threadJoinSaved('alpha', candidate.channel, candidate.root, candidate.stamp, candidate.at)).toBe(true)
  })

  test.each(['forget', 'remove'] as const)('%s drops pending recovery; bring-up must supply the queue candidates again', async action => {
    const h = fixture(), fact = h.fact()
    seedThreads(h.stateDir, [threadHeader()])
    h.io.fail('readFileSync'); await h.start()
    h.memory.recoverJoins('alpha', [fact]); await h.clock.flush()
    expect(view(h)).toBe('unknown')
    await h.memory[action]('alpha')
    h.io.heal(); await h.memory.loadKey('alpha'); h.memory.retryPendingJoins('alpha'); await h.clock.flush()
    expect(view(h)).toBe('not-joined'); expect(savedJoins(h)).toEqual([])
    h.memory.recoverJoins('alpha', [fact]); await h.clock.flush()
    expect(view(h)).toBe('joined'); expect(savedJoins(h).map(r => r.at)).toEqual([fact.at])
  })

  test('an unknown journal whose pending stamp becomes stale never restores that join after its first successful read', async () => {
    const h = fixture(), fact = h.fact()
    seedThreads(h.stateDir, [threadHeader()])
    h.io.fail('readFileSync'); await h.start()
    h.memory.recoverJoins('alpha', [fact])
    expect(h.choose('mentions').kind).toBe('applied'); expect(h.choose('thread_hybrid').kind).toBe('applied')
    h.io.heal(); await h.memory.loadKey('alpha'); h.memory.retryPendingJoins('alpha'); await h.clock.flush()
    expect(view(h)).toBe('not-joined'); expect(savedJoins(h)).toEqual([])
    const current = h.fact()
    h.memory.recoverJoins('alpha', [current]); await h.clock.flush()
    expectOnlySavedJoin(h, current)
  })

  test('recovery queued behind one persona\'s creation does not delay another persona\'s recovery append', async () => {
    const blocked = gate()
    const h = fixture({ setCreated: async key => {
      if (key === 'alpha') await blocked.wait()
      return h.authority.setThreadMemoryCreated(key)
    } })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    const starting = h.start()
    try {
      await blocked.entered; await h.clock.flush()
      const a = h.fact(), b = h.fact({}, 'beta')
      expect(h.memory.store('alpha')?.created).toBe(false)
      expect(h.memory.store('beta')?.created).toBe(true)
      h.memory.recoverJoins('alpha', [a]); h.memory.recoverJoins('beta', [b]); await h.clock.flush()
      expect(h.memory.keptFacts('alpha')).toEqual([a]); expect(savedJoins(h)).toEqual([])
      expectOnlySavedJoin(h, b, 'beta'); expect(savedJoins(h, 'beta')).toEqual([joinRecord(b)])
      blocked.release(); await starting; await h.clock.flush()
      expectOnlySavedJoin(h, a)
    } finally { blocked.release(); await starting }
  })

  test.each(['unknown', 'failed-save'] as const)('one key with %s recovery cannot affect another key\'s reads, appends, answers or clock', async failure => {
    const h = fixture(); expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    seedThreads(h.stateDir, [threadHeader()])
    if (failure === 'unknown') h.io.fail('readFileSync')
    await h.start()
    if (failure === 'failed-save') h.io.fail('writeSync')
    const a = h.fact({ at: THREAD_TIME + 1000 }), b = h.fact({ source: 'broadcast', at: THREAD_TIME + 10 }, 'beta')
    h.io.reset()
    h.memory.recoverJoins('alpha', [a]); h.memory.recoverJoins('beta', [b]); await h.clock.flush()
    expect(h.memory.joins('alpha')).toEqual(failure === 'unknown' ? [] : [{ join: a }])
    expect(view(h)).toBe(failure === 'unknown' ? 'unknown' : 'joined')
    expect(h.memory.hasSavedJoin('alpha', a.channel, a.root, a.stamp)).toBe(false)
    expect(h.memory.threadJoinSaved('alpha', a.channel, a.root, a.stamp, a.at)).toBe(false)
    expect(h.memory.keptFacts('alpha')).toEqual(failure === 'unknown' ? [] : [a])
    expect(h.events.filter(e => e.type === 'append-failed').map(e => e.key)).toEqual(failure === 'unknown' ? [] : ['alpha'])
    expectOnlySavedJoin(h, b, 'beta')
    expect(savedJoins(h, 'beta')).toEqual([joinRecord(b)])
    expect(h.memory.clock('beta')).toBe(b.at + 1)
    expect(h.memory.clock('alpha')).toBe(a.at + 1)
    expect(h.io.calls.filter(c => c.op === 'readFileSync')).toEqual([])
    const betaBytes = journalBytes(h, 'beta'), betaState = h.memory.joins('beta')
    h.io.heal(); h.io.reset()
    if (failure === 'unknown') await h.memory.loadKey('alpha')
    else expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    await h.clock.flush()
    expect(h.memory.isJoinSaved('alpha', a)).toBe(true)
    expect(journalBytes(h, 'beta')).toEqual(betaBytes); expect(h.memory.joins('beta')).toEqual(betaState)
    expect(h.io.calls.filter(c => c.path === threadPath(h.stateDir, 'beta'))).toEqual([])
  })

  test('delivering a recovered accepted item does not rejoin its thread or rewrite Thread Memory', async () => {
    const h = fixture(); await h.start(); const fact = h.fact()
    let queue = await makeQueue(h.stateDir, { now: h.clock.now })
    try {
      const accepted = await queue.accept('alpha', slackInput({ channel: fact.channel, via: 'mention',
        thread_join: { thread_ts: fact.root, stamp: fact.stamp, at: fact.at } }))
      expect(accepted.status).toBe('accepted')
      if (accepted.status !== 'accepted') throw new Error('fixture acceptance failed')
      await queue.stop(); queue = await makeQueue(h.stateDir, { now: h.clock.now })
      expect(queue.item('alpha', accepted.seq)?.accepted.thread_join).toEqual({ thread_ts: fact.root, stamp: fact.stamp, at: fact.at })
      h.memory.recoverJoins('alpha', [fact]); await h.clock.flush()
      expect(view(h)).toBe('joined')
      expect(h.choose('mentions').kind).toBe('applied'); expect(h.choose('thread_hybrid').kind).toBe('applied')
      expect(view(h)).toBe('not-joined')
      const before = journalBytes(h), events = [...h.events]
      h.io.reset()
      await deliverRecoveredItem(queue, 'alpha', accepted.seq)
      await h.clock.flush()
      expect(queue.openCount('alpha')).toBe(0)
      expect(view(h)).toBe('not-joined'); expect(h.memory.joins('alpha')).toEqual([])
      expect(journalBytes(h)).toEqual(before); expect(h.events).toEqual(events); expect(h.io.calls).toEqual([])
    } finally { await queue.stop() }
  })
})

describe('SR-9.11 Thread Memory maintenance beside acceptance', () => {
  // Keep the SR-8 burst cadence; virtual time, never a wall-clock sleep.
  const CADENCE = 250
  const runs: Awaited<ReturnType<typeof makeBacklogMemory>>[] = []
  const routingRuns: Array<{ h: RoutingHarness; dir: string; release(): void; work?: Promise<void>; receive?: Promise<void>; retired?: boolean }> = []
  async function setup(keys?: string[]) { const h = await makeBacklogMemory(keys); runs.push(h); return h }
  afterEach(async () => {
    for (const run of routingRuns.splice(0)) {
      run.retired = true; run.release(); await run.work; await run.receive
      run.h.hold.cancelAll(); run.h.releaseLaunches(); await run.h.ready(); await run.h.settleJoinSaves()
      await run.h.threads?.close(); await run.h.preparation.stop(); await run.h.queue.stop()
      assertNoLeak(run.h.captured()); resetRoutingState(); rmSync(run.dir, { recursive: true, force: true })
    }
    for (const h of runs.splice(0)) { await h.close(); expect(h.clock.pendingCount()).toBe(0) }
  })
  const writes = (h: Awaited<ReturnType<typeof setup>>, key = 'alpha') => h.io.calls.filter(c => c.op === 'writeSync' && c.path.startsWith(`${threadPath(h.stateDir, key)}.`))

  test('a maintenance backlog wait leaves the memory writer free for a durable join save', async () => {
    const h = await setup(); await h.start(); await h.dirty(); h.reset()
    const backlog = await h.backlog()
    h.memory.startMaintenance(CADENCE)
    await h.clock.advance(CADENCE)
    const triggeredAt = h.clock.now(), fact = h.fact()
    expect(h.backlogWaitCount()).toBe(1)
    expect(writes(h)).toEqual([]); expect(h.completed).toEqual([])
    const saving = h.memory.saveJoins('alpha', [fact])
    const result = await saving
    if (h.closing) return // A failing baseline run has timed out and cleanup is draining it.
    expect(result).toEqual({ kind: 'saved' })
    expect(h.clock.now()).toBe(triggeredAt)
    expect(h.clock.now()).toBeLessThan(triggeredAt + THREAD_MEMORY_COMPACT_BACKLOG_MAX_MS)
    expect(h.queue.hasAcceptanceBacklog!('alpha')).toBe(true)
    expect(h.memory.isJoinSaved('alpha', fact)).toBe(true)
    expect(readThreads(h.stateDir).at(-1)).toEqual(joinRecord(fact, h.memory.store('alpha')!.lastRecordNumber))
    expect(h.io.calls.filter(c => c.op === 'fsync' && c.path === threadPath(h.stateDir))).toHaveLength(1)
    expect(writes(h)).toEqual([]); expect(h.completed).toEqual([]); expect(h.sealCalls).toEqual([])
    const expected = h.image(), complete = h.completion()
    backlog.release(); expect((await backlog.pending).status).toBe('accepted')
    await complete; await h.seal.flush()
    expect(h.completed.map(c => c.outcome)).toEqual(['rewritten'])
    expect(h.completed[0]!.startMonoMs).toBe(triggeredAt)
    expect(h.backlogWaitCount()).toBe(0)
    expect(h.bytes().equals(expected)).toBe(true)
    expect(h.memory.isJoinSaved('alpha', fact)).toBe(true)
  })

  test('quiesce cancels the outside-writer wait and drains an admitted save while acceptance stays backlogged', async () => {
    const h = await setup(); await h.start(); await h.dirty(); h.reset()
    const backlog = await h.backlog()
    h.memory.startMaintenance(CADENCE); await h.clock.advance(CADENCE)
    const deadline = h.clock.now() + THREAD_MEMORY_COMPACT_BACKLOG_MAX_MS
    expect(h.backlogWaitCount()).toBe(1)
    const append = h.io.hold('fsync', 'alpha', { match: p => p === threadPath(h.stateDir) })
    const saving = h.memory.saveJoins('alpha', [h.fact()])
    await append.reached
    let drained = false
    const quiescing = h.memory.quiesce().then(() => { drained = true })
    expect(h.backlogWaitCount()).toBe(0)
    expect(h.clock.pending().filter(t => t.delayMs === THREAD_MEMORY_COMPACT_BACKLOG_MAX_MS && t.dueAt === deadline)).toEqual([])
    // An independent real queue commit supplies an observed completion while
    // alpha's already-admitted memory append remains held, without a sleep.
    expect((await h.queue.accept('beta', slackInput())).status).toBe('accepted')
    expect(drained).toBe(false)
    expect(h.queue.hasAcceptanceBacklog!('alpha')).toBe(true)
    append.release(); expect((await saving).kind).toBe('saved'); await quiescing
    expect(drained).toBe(true)
    expect(h.queue.hasAcceptanceBacklog!('alpha')).toBe(true)
    expect(writes(h)).toEqual([]); expect(h.completed).toEqual([]); expect(h.sealCalls).toEqual([])
    const calls = [...h.io.calls], bytes = h.bytes()
    backlog.release(); await backlog.pending
    await h.clock.advanceTo(deadline + CADENCE)
    await h.memory.quiesce(); await h.seal.flush()
    expect(h.io.calls).toEqual(calls); expect(h.bytes()).toEqual(bytes)
    expect(h.completed).toEqual([]); expect(h.sealCalls).toEqual([]); expect(h.backlogWaitCount()).toBe(0)
  })

  test('forget cancels the old outside-writer wait and a reloaded life can schedule maintenance without stranding work', async () => {
    const h = await setup(); await h.start(); await h.dirty(); h.reset()
    const backlog = await h.backlog()
    h.memory.startMaintenance(CADENCE); await h.clock.advance(CADENCE)
    const oldDeadline = h.clock.now() + THREAD_MEMORY_COMPACT_BACKLOG_MAX_MS
    expect(h.backlogWaitCount()).toBe(1)
    h.memory.forget('alpha')
    expect(h.backlogWaitCount()).toBe(0)
    expect(h.clock.pending().filter(t => t.delayMs === THREAD_MEMORY_COMPACT_BACKLOG_MAX_MS && t.dueAt === oldDeadline)).toEqual([])
    expect(h.memory.store('alpha')).toBeUndefined()
    expect(writes(h)).toEqual([]); expect(h.completed).toEqual([])
    await h.memory.loadKey('alpha')
    expect(h.queue.hasAcceptanceBacklog!('alpha')).toBe(true)
    expect(h.completed.map(c => c.outcome)).toEqual(['rewritten'])
    await h.dirty(); h.reset()
    await h.clock.advanceTo(2 * CADENCE)
    expect(h.backlogWaitCount()).toBe(1)
    expect(writes(h)).toEqual([]); expect(h.completed).toEqual([])
    const expected = h.image(), complete = h.completion()
    backlog.release(); await backlog.pending; await complete
    expect(h.completed.map(c => c.outcome)).toEqual(['rewritten'])
    expect(h.bytes().equals(expected)).toBe(true)
    expect(h.backlogWaitCount()).toBe(0)
    await h.memory.quiesce(); await h.seal.flush()
    const calls = [...h.io.calls]
    await h.clock.advanceTo(oldDeadline + THREAD_MEMORY_COMPACT_BACKLOG_MAX_MS)
    await h.memory.quiesce()
    expect(h.io.calls).toEqual(calls)
    expect(h.completed.map(c => c.outcome)).toEqual(['rewritten'])
  })

  test('a backlog-clear notification starts maintenance, with unchanged image, durability, seal, skip and measurement boundaries', async () => {
    const h = await setup(); await h.start(); await h.measurements.flush(); await h.dirty(); h.reset()
    const baselineMeasurements = readFileSync(h.measurementsPath, 'utf8').trim().split('\n').length
    const expected = h.image(), backlog = await h.backlog()
    const temp = h.io.hold('fsync', 'alpha', { match: p => p.endsWith('.tmp') })
    const complete = h.completion()
    h.memory.startMaintenance(CADENCE)
    await h.clock.advance(CADENCE)
    const trigger = h.clock.now()
    expect(writes(h)).toEqual([]); expect(h.completed).toEqual([]); expect(h.sealCalls).toEqual([])
    await h.clock.advance(CADENCE / 2)
    expect(writes(h)).toEqual([])
    const started = h.clock.now()
    backlog.release(); expect((await backlog.pending).status).toBe('accepted')
    await temp.reached
    expect(writes(h).length).toBeGreaterThan(0)
    expect(h.completed).toEqual([]); expect(h.sealCalls).toEqual([])
    await h.measurements.flush()
    expect(readFileSync(h.measurementsPath, 'utf8').trim().split('\n')).toHaveLength(baselineMeasurements)
    await h.clock.advance(1)
    temp.release(); await complete; await h.seal.flush()
    expect(h.bytes().equals(expected)).toBe(true)
    const operations = h.io.calls.filter(c => ['writeSync', 'fsync', 'rename'].includes(c.op))
    const tempPath = writes(h)[0]!.path
    const steps = [...writes(h).map(c => `writeSync:${c.path}`), `fsync:${tempPath}`, `rename:${tempPath}`, `fsync:${join(h.stateDir, 'threads')}`]
    expect(operations.map(c => `${c.op}:${c.path}`)).toEqual(steps)
    expect(h.sealCalls).toEqual([{ key: 'alpha', steps }])
    expect(h.completed).toEqual([{ key: 'alpha', startMonoMs: started, endMonoMs: started + 1, outcome: 'rewritten' }])
    expect(started).toBeGreaterThan(trigger)
    await h.measurements.flush()
    expect(JSON.parse(readFileSync(h.measurementsPath, 'utf8').trim().split('\n').at(-1)!)).toEqual({
      v: 1, kind: 'thread-compaction', key: 'alpha', start_mono_ms: started, end_mono_ms: started + 1,
      outcome: 'rewritten', at_mono_ms: started + 1,
    })
    const before = h.bytes(), identity = statSync(threadPath(h.stateDir), { bigint: true })
    h.reset(); const skipped = h.completion()
    await h.clock.advanceTo(2 * CADENCE); await skipped
    expect(h.completed.map(c => c.outcome)).toEqual(['skipped'])
    expect(h.io.calls).toEqual([]); expect(h.sealCalls).toEqual([]); expect(h.sealIo.calls).toEqual([])
    expect(h.bytes()).toEqual(before)
    const after = statSync(threadPath(h.stateDir), { bigint: true })
    expect([after.ino, after.mtimeNs, after.size]).toEqual([identity.ino, identity.mtimeNs, identity.size])
  })

  test('earliest-trigger deadline is exact despite later triggers, and a trigger during the rewrite gets a subsequent complete pass', async () => {
    const h = await setup(); await h.start(); await h.dirty(); h.reset()
    const backlog = await h.backlog(), temp = h.io.hold('fsync', 'alpha', { match: p => p.endsWith('.tmp') })
    const complete = h.completion()
    h.memory.startMaintenance(CADENCE)
    await h.clock.advance(CADENCE)
    const trigger = h.clock.now(), deadline = trigger + THREAD_MEMORY_COMPACT_BACKLOG_MAX_MS
    await h.clock.advance(THREAD_MEMORY_COMPACT_BACKLOG_MAX_MS - 1)
    expect(h.clock.now()).toBe(deadline - 1)
    expect(writes(h)).toEqual([]); expect(h.completed).toEqual([])
    await h.clock.advance(1); await temp.reached
    expect(h.queue.hasAcceptanceBacklog!('alpha')).toBe(true)
    expect(writes(h).length).toBeGreaterThan(0)
    // A further trigger while the actual rewrite is held cannot be dropped.
    await h.clock.advance(CADENCE)
    const lastTrigger = h.clock.now(), subsequent = h.completion('alpha', 2)
    expect(h.completed).toEqual([])
    temp.release(); await complete
    expect(h.completed[0]).toMatchObject({ key: 'alpha', startMonoMs: deadline, endMonoMs: lastTrigger, outcome: 'rewritten' })
    backlog.release(); await backlog.pending; await subsequent
    expect(h.completed.map(c => c.outcome)).toEqual(['rewritten', 'skipped'])
    for (let at = trigger; at <= lastTrigger; at += CADENCE) expect(h.completed.some(c => c.endMonoMs >= at)).toBe(true)
    expect(h.completed[1]!.endMonoMs).toBeGreaterThanOrEqual(lastTrigger)
  })

  test.each(['startup', 'bring-up', 'explicit'] as const)('%s compaction bypasses an existing acceptance backlog', async phase => {
    const h = await setup()
    if (phase !== 'startup') await h.start()
    if (phase === 'bring-up') await h.memory.forget('alpha')
    h.reset()
    const expected = h.image(), backlog = await h.backlog(), now = h.clock.now()
    const temp = h.io.hold('fsync', 'alpha', { match: p => p.endsWith('.tmp') })
    const operation = phase === 'startup' ? h.start() : phase === 'bring-up' ? h.memory.loadKey('alpha') : h.memory.compact('alpha')
    try {
      await temp.reached
      expect(h.queue.hasAcceptanceBacklog!('alpha')).toBe(true)
      expect(h.clock.now()).toBe(now)
      temp.release(); await operation
      expect(h.completed.map(c => [c.key, c.outcome])).toEqual([['alpha', 'rewritten']])
      expect(h.bytes().equals(expected)).toBe(true)
      expect(h.queue.hasAcceptanceBacklog!('alpha')).toBe(true)
    } finally { temp.release(); backlog.release(); await backlog.pending; await operation }
  })

  test('alpha backlog leaves beta maintenance independent', async () => {
    const h = await setup(['alpha', 'beta']); await h.start(); await h.dirty('alpha'); await h.dirty('beta'); h.reset()
    const backlog = await h.backlog('alpha'), beta = h.completion('beta'), alpha = h.completion('alpha')
    h.memory.startMaintenance(CADENCE)
    await h.clock.advance(CADENCE); await beta
    expect(writes(h, 'alpha')).toEqual([])
    expect(h.completed.map(c => [c.key, c.outcome, c.startMonoMs])).toEqual([['beta', 'rewritten', CADENCE]])
    expect(h.queue.hasAcceptanceBacklog!('alpha')).toBe(true)
    backlog.release(); await backlog.pending; await alpha
    expect(h.completed.map(c => c.key)).toEqual(['beta', 'alpha'])
  })

  test.each(['strict', 'open'] as const)('%s intake reaches a partial rewrite, decides, stores and acks before it completes; its memory append waits', async mode => {
    resetRoutingState()
    const dir = mkdtempSync(join(tmpdir(), 'thread-memory-intake-rewrite-')), io = threadFsControls(dir), base = io.fs
    const slices: Buffer[] = [], order: string[] = [], first = Promise.withResolvers<void>()
    let atFirstWrite: (() => void) | undefined, partialBytes = 0, decisionBytes = 0, tempPath = '', receive: Promise<void> | undefined
    const seam = { ...base, writeSync(fd: number, bytes: Uint8Array, offset: number, length: number, position?: number | null) {
      const written = base.writeSync(fd, bytes, offset, length, position), call = io.calls.at(-1)!
      if (call.path.endsWith('.tmp') && atFirstWrite) {
        slices.push(Buffer.from(bytes.subarray(offset, offset + written)))
        tempPath = call.path; partialBytes = statSync(call.path).size
        const submit = atFirstWrite; atFirstWrite = undefined
        order.push('first-slice'); submit(); first.resolve()
      } else if (call.path.endsWith('.tmp')) slices.push(Buffer.from(bytes.subarray(offset, offset + written)))
      else if (call.path === threadPath(dir)) order.push('memory-append')
      return written
    } } as typeof base
    const h = makeRoutingHarness([{ name: 'alpha', channels: [{ id: C.primary, delivery: 'thread_hybrid' }], dm: { enabled: true } }], dir,
      { mode, threadMemory: { fs: { ...io, fs: seam } }, membership: observedMembership({ alpha: [C.primary] }), restartDelayS: NEVER_FIRE_RESTART_DELAY_S })
    const temp = io.hold('fsync', 'alpha', { match: p => p.endsWith('.tmp') })
    const run: typeof routingRuns[number] = { h, dir, release: temp.release }; routingRuns.push(run)
    await h.ready()
    const t = h.threads!, count = 2 * THREAD_MEMORY_COMPACTION_SLICE + 1
    const facts = Array.from({ length: count }, (_, i) => t.fact({ root: i === 0 ? R.primary : `1700000000.${String(300000 + i).padStart(6, '0')}` }))
    expect((await t.memory.saveJoins('alpha', facts)).kind).toBe('saved')
    const [header, ...records] = readThreads(dir)
    if (header?.kind !== 'header') throw new Error('fixture journal without its header')
    const image = serializeThreadMemoryRecords([{ ...header, highWater: t.memory.store('alpha')!.lastRecordNumber }, ...records])
    expect(image.length).toBeGreaterThan(THREAD_MEMORY_REWRITE_CHUNK_BYTES)
    const reply = makeChannelMessage({ channel: C.primary, thread_ts: R.primary, text: 'reply during rewrite' })
    const mention = makeChannelMessage({ channel: C.primary, ts: R.secondary, text: mentionText(h.p('alpha').stub.identity.botUserId) })
    const view = t.memory.view.bind(t.memory)
    t.memory.view = (...args) => { decisionBytes = statSync(tempPath).size; order.push('decided'); return view(...args) }
    const completed: ThreadMemoryCompaction[] = []
    t.memory.setCompactionObserver(c => { completed.push(c); order.push('rewrite-complete') })
    io.reset(); slices.length = 0; order.length = 0
    atFirstWrite = () => {
      receive = Promise.all([reply, mention].map((event, i) => h.receive(event, ['alpha'], () => { order.push(`ack:${i}`) }))).then(() => {})
      run.receive = receive
    }
    const rewrite = t.memory.compact('alpha'); run.work = rewrite
    await first.promise; await temp.reached; await receive
    if (run.retired) return // The test runner timed out; cleanup has released the rewrite.
    expect(partialBytes).toBeGreaterThan(0); expect(partialBytes).toBeLessThan(image.length)
    expect(decisionBytes).toBeGreaterThan(0); expect(decisionBytes).toBeLessThan(image.length)
    expect(h.order).toContain('save-join:alpha')
    expect(h.threadMemoryReads).toEqual([['alpha', C.primary, R.primary]])
    expect(order.indexOf('decided')).toBeGreaterThan(order.indexOf('first-slice'))
    expect(order).toContain('ack:0'); expect(order).toContain('ack:1')
    expect(completed).toEqual([]); expect(order).not.toContain('memory-append')
    expect(io.calls.filter(c => c.op === 'writeSync' && c.path === threadPath(dir))).toEqual([])
    expect(h.queued('alpha').map(i => [i.accepted.seq, i.accepted.via])).toEqual([[1, 'thread'], [2, 'mention']])
    expect(h.queue.lookupSlackKey('alpha', { chat_id: C.primary, ts: reply.ts as string })?.status).toBe('duplicate')
    expect(t.memory.hasSavedJoin('alpha', C.primary, R.secondary, t.fact().stamp)).toBe(false)
    expect(Buffer.concat(slices).equals(image)).toBe(true)
    for (const slice of slices) expect(slice.length).toBeLessThanOrEqual(THREAD_MEMORY_REWRITE_CHUNK_BYTES)
    temp.release(); await rewrite; await h.settleJoinSaves(); await t.memory.flush('alpha')
    expect(completed.map(c => c.outcome)).toEqual(['rewritten'])
    expect(order.indexOf('rewrite-complete')).toBeGreaterThan(order.indexOf('ack:1'))
    expect(order.indexOf('memory-append')).toBeGreaterThan(order.indexOf('rewrite-complete'))
    const calls = io.calls, append = calls.findIndex(c => c.op === 'writeSync' && c.path === threadPath(dir))
    const directory = calls.findIndex(c => c.op === 'fsync' && c.path === join(dir, 'threads'))
    expect(append).toBeGreaterThan(directory); expect(directory).toBeGreaterThan(-1)
    expect(readFileSync(threadPath(dir)).subarray(0, image.length).equals(image)).toBe(true)
    expect(readThreads(dir).filter(r => r.kind === 'join').map(r => r.root)).toEqual([...facts.map(f => f.root), R.secondary])
  })
})

describe('Thread Memory compaction in slices', () => {
  const SLICE = THREAD_MEMORY_COMPACTION_SLICE, COUNT = 2 * SLICE + 1
  // Capture actual writes without changing the shared harness used by other owners.
  const rewriteWrites = new WeakMap<ThreadMemoryHarness['io']['calls'][number], {
    start: number; position: number | null | undefined; bytes: Buffer
  }>()
  function rewriteFixture(options: ThreadHarnessOptions = {}, dir = mkdtempSync(join(tmpdir(), 'thread-memory-'))) {
    const io = options.fs ?? threadFsControls(dir), base = io.fs
    const fs = { ...base, writeSync(fd: number, bytes: Uint8Array, offset: number, length: number, position?: number | null) {
      const start = base.fstatSync(fd).size
      const written = base.writeSync(fd, bytes, offset, length, position)
      rewriteWrites.set(io.calls.at(-1)!, { start, position, bytes: Buffer.from(bytes.subarray(offset, offset + written)) })
      return written
    } } as typeof base
    return fixture({ ...options, fs: { ...io, fs } }, dir)
  }
  const rootOf = (i: number) => `1700000000.${100_000 + i}`
  const isTemp = (h: ThreadMemoryHarness) => (path: string) => path.startsWith(`${threadPath(h.stateDir)}.`) && path.endsWith('.tmp')
  const bySeq = (a: { seq: number }, b: { seq: number }) => a.seq - b.seq
  const turn = () => new Promise<void>(resolve => setImmediate(resolve))
  /** alpha with COUNT saved joins over both thread_hybrid channels. `alternate` interleaves them, so the
   * compaction's walk (channel by channel) differs from record order; `one-primary` saves one primary join
   * first, then every other join in the secondary channel, so the walk's first slice ends past it. */
  async function large(layout: 'alternate' | 'one-primary', options: Parameters<typeof fixture>[0] = {}) {
    const h = rewriteFixture(options)
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], [C.primary, C.secondary])).kind).toBe('applied')
    await h.start()
    const facts = Array.from({ length: COUNT }, (_, i) => h.fact({
      channel: (layout === 'alternate' ? i % 2 === 0 : i === 0) ? C.primary : C.secondary, root: rootOf(i) }))
    expect(await h.memory.saveJoins('alpha', facts)).toEqual({ kind: 'saved' })
    const [header, ...records] = readThreads(h.stateDir)
    expect(records).toHaveLength(COUNT)
    return { h, facts, header: header!, records }
  }
  /** The bytes the synchronous `serializeThreadMemoryRecords([header, ...records.sort(bySeq)])` writes, under the written header. */
  function expectSynchronousImage(h: ThreadMemoryHarness, header: ReturnType<typeof readThreads>[number], records: ReturnType<typeof readThreads>) {
    const [written] = readThreads(h.stateDir)
    if (written?.kind !== 'header' || header.kind !== 'header') throw new Error('fixture journal without its header')
    expect(written).toEqual({ ...header, highWater: written.highWater })
    expect(journalBytes(h).equals(serializeThreadMemoryRecords([written, ...[...records].sort(bySeq)]))).toBe(true)
  }

  const spies: Array<{ mockRestore(): void }> = []
  afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore() })
  const identity = (h: ThreadMemoryHarness) => {
    const { ino, mtimeNs } = statSync(threadPath(h.stateDir), { bigint: true })
    return { ino, mtimeNs, bytes: journalBytes(h) }
  }
  // Record the real durability boundaries, including their order before entryCompacted.
  const operations = (h: ThreadMemoryHarness) => h.io.calls
    .filter(c => ['writeSync', 'fsync', 'rename'].includes(c.op))
    .map(c => `${c.op}:${isTemp(h)(c.path) ? 'temp' : c.path === join(h.stateDir, 'threads') ? 'directory' : c.path === h.stateDir ? 'parent' : 'journal'}`)
  function fullRewrite(h: ThreadMemoryHarness, image: Uint8Array = journalBytes(h)) {
    const calls = h.io.calls.filter(c => c.op === 'writeSync' && isTemp(h)(c.path))
    expect(calls.length).toBeGreaterThan(0)
    expect(new Set(calls.map(c => c.path)).size).toBe(1)
    let covered = 0
    const chunks = calls.map(call => {
      const write = rewriteWrites.get(call)!
      expect(write).toBeDefined()
      expect(write.start).toBe(covered)
      expect(write.position ?? covered).toBe(covered)
      expect(write.bytes.length).toBeGreaterThan(0)
      expect(write.bytes.length).toBeLessThanOrEqual(THREAD_MEMORY_REWRITE_CHUNK_BYTES)
      expect(write.bytes.equals(image.subarray(covered, covered + write.bytes.length))).toBe(true)
      covered += write.bytes.length
      return write.bytes
    })
    expect(covered).toBe(image.length)
    expect(Buffer.concat(chunks).equals(image)).toBe(true)
    return [...calls.map(() => 'writeSync:temp'), 'fsync:temp', 'rename:temp', 'fsync:directory']
  }
  function observe(h: ThreadMemoryHarness) {
    const completed: ThreadMemoryCompaction[] = [], sealed: Array<{ key: string; steps: string[] }> = []
    let eventStart = h.events.length
    let nextCompletion: (() => void) | undefined
    h.memory.setCompactionObserver(c => { completed.push(c); nextCompletion?.(); nextCompletion = undefined })
    if (h.seal) {
      const original = h.seal.entryCompacted.bind(h.seal)
      spies.push(spyOn(h.seal, 'entryCompacted').mockImplementation((key, storeId, lastRecordNumber) => {
        sealed.push({ key, steps: operations(h) })
        return original(key, storeId, lastRecordNumber)
      }))
    }
    return {
      completed, sealed,
      nextCompletion: () => new Promise<void>(resolve => { nextCompletion = resolve }),
      reset() { h.io.reset(); h.sealIo.reset(); completed.length = 0; sealed.length = 0; eventStart = h.events.length },
      rewritten(prefix: string[] = []) {
        const steps = [...prefix, ...fullRewrite(h)]
        expect(operations(h)).toEqual(steps)
        expect(sealed).toEqual([{ key: 'alpha', steps }])
        expect(h.sealIo.writes().length).toBeGreaterThan(0)
        expect(completed.map(c => [c.key, c.outcome])).toEqual([['alpha', 'rewritten']])
        expect(h.events.slice(eventStart).filter(e => e.type === 'compacted')).toEqual([
          { type: 'compacted', key: 'alpha', path: threadPath(h.stateDir), outcome: 'rewritten' },
        ])
      },
      skipped(before: ReturnType<typeof identity>) {
        expect(h.io.calls).toEqual([]); expect(h.sealIo.calls).toEqual([])
        expect(sealed).toEqual([]); expect(identity(h)).toEqual(before)
        expect(completed.map(c => [c.key, c.outcome])).toEqual([['alpha', 'skipped']])
        expect(h.events.slice(eventStart).filter(e => e.type === 'compacted')).toEqual([
          { type: 'compacted', key: 'alpha', path: threadPath(h.stateDir), outcome: 'skipped' },
        ])
        expect(completed[0]!.startMonoMs).toBeLessThanOrEqual(completed[0]!.endMonoMs)
        expect(h.events.filter(e => e.type === 'compaction-failed')).toEqual([])
      },
    }
  }

  test('a mostly cached compaction preserves the complete image through reopen', async () => {
    const { h, header, records } = await large('alternate')
    await h.memory.compact('alpha')
    expect(await h.memory.saveJoins('alpha', [h.fact({ root: rootOf(COUNT) })])).toEqual({ kind: 'saved' })
    const expected = readThreads(h.stateDir).slice(1)
    const temp = h.io.hold('fsync', 'alpha', { match: isTemp(h) })
    const compaction = h.memory.compact('alpha')
    try {
      expect(await Promise.race([temp.reached.then(() => 'held'), compaction.then(() => 'completed')])).toBe('held')
    } finally { temp.release(); await compaction }
    expectSynchronousImage(h, header, expected)
    expect(savedJoins(h)).toHaveLength(records.length + 1)
    const bytes = journalBytes(h)
    await h.close()
    const reopened = rewriteFixture({ reopen: true }, h.stateDir); await reopened.start()
    expect(journalBytes(reopened)).toEqual(bytes)
    expect(readThreads(reopened.stateDir).slice(1)).toEqual(expected)
  })

  test.each(['temp', 'directory'] as const)('a mostly cached rewrite handles %s fsync failure and retries the full rewrite', async failure => {
    const { h, header, records } = await large('alternate', { seal: true })
    await h.memory.compact('alpha')
    await h.memory.saveJoins('alpha', [h.fact({ root: rootOf(COUNT) })])
    const before = journalBytes(h), expected = readThreads(h.stateDir).slice(1)
    const sealSteps: string[][] = [], entryCompacted = h.seal!.entryCompacted.bind(h.seal!)
    const notifications = spyOn(h.seal!, 'entryCompacted').mockImplementation((...args) => {
      sealSteps.push(operations(h))
      return entryCompacted(...args)
    })
    const cause = h.io.fail('fsync', 'alpha', {
      match: failure === 'directory' ? path => path === join(h.stateDir, 'threads') : isTemp(h),
    })
    h.io.reset()
    try {
      await h.memory.compact('alpha')
      expect(notifications).not.toHaveBeenCalled()
      expect(h.events.at(-1)).toMatchObject({ type: 'compaction-failed', error: cause })
      if (header.kind !== 'header') throw new Error('fixture journal without its header')
      const image = serializeThreadMemoryRecords([{ ...header, highWater: h.memory.store('alpha')!.lastRecordNumber }, ...expected.sort(bySeq)])
      const failedSteps = fullRewrite(h, image)
      expect(operations(h)).toEqual(failure === 'directory' ? failedSteps : failedSteps.slice(0, -2))
      if (failure === 'directory') expectSynchronousImage(h, header, expected)
      else expect(journalBytes(h)).toEqual(before)
      expect(readdirSync(join(h.stateDir, 'threads')).filter(name => name.endsWith('.tmp'))).toEqual([])
      h.io.heal(); h.io.reset()
      await h.memory.compact('alpha')
      const steps = fullRewrite(h)
      expect(operations(h)).toEqual(steps)
      expect(sealSteps).toEqual([steps])
      expect(readdirSync(join(h.stateDir, 'threads')).filter(name => name.endsWith('.tmp'))).toEqual([])
      expect(notifications).toHaveBeenCalledTimes(1)
      expectSynchronousImage(h, header, expected)
    } finally { h.io.heal(); notifications.mockRestore() }
    const bytes = journalBytes(h)
    await h.crash()
    const reopened = rewriteFixture({ reopen: true, seal: true }, h.stateDir); await reopened.start()
    expect(savedJoins(reopened)).toHaveLength(records.length + 1)
    expect(journalBytes(reopened)).toEqual(bytes)
  })

  test('successive saves and compactions retain old records and every new join', async () => {
    const { h, header, records } = await large('alternate')
    await h.memory.compact('alpha')
    for (let i = 0; i < 4; i++) {
      const fact = h.fact({ root: rootOf(COUNT + i) })
      expect(await h.memory.saveJoins('alpha', [fact])).toEqual({ kind: 'saved' })
      await h.memory.compact('alpha')
    }
    const written = readThreads(h.stateDir)
    expect(written.slice(1, records.length + 1)).toEqual(records)
    expect(written).toHaveLength(records.length + 5)
    expectSynchronousImage(h, header, written.slice(1))
    expect(h.events.filter(e => e.type === 'compaction-failed')).toEqual([])
  })

  test('new and earlier joins retain normalized facts and caller isolation', async () => {
    const h = rewriteFixture(); await h.start()
    const fact = h.fact(), original = structuredClone(fact)
    expect(h.memory.addJoin('alpha', fact)).toBe(true)
    fact.stamp.incarnation = 'caller changed'; fact.root = rootOf(999)
    expect(h.memory.addJoin('alpha', { ...original, at: original.at - 1 })).toBe(true)
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(h.memory.joins('alpha')).toEqual([{ join: { ...original, at: original.at - 1 }, savedAt: original.at - 1 }])
    expect(savedJoins(h).map(({ v, kind, seq, ...join }) => join)).toEqual([
      original, { ...original, at: original.at - 1 },
    ])
  })

  test('a cached image replaces earlier saved times only after append durability and drops resolved intents and unnamed held joins', async () => {
    let held: ThreadJoin[] = []
    const h = rewriteFixture({ heldStamps: () => held }); await h.start()
    const later = h.fact({ at: THREAD_TIME + 20 }), earlier = { ...later, at: THREAD_TIME + 10 }
    await h.memory.saveJoins('alpha', [later])
    const pending = h.memory.keepIntent('alpha', postIntent(later))
    expect(pending.kept && await pending.ready).toBe('saved')
    await h.memory.compact('alpha')
    const [header, ...saved] = readThreads(h.stateDir)

    h.io.fail('writeSync')
    expect((await h.memory.saveJoins('alpha', [earlier])).kind).toBe('failed')
    h.io.heal(); await h.memory.compact('alpha')
    expectSynchronousImage(h, header!, saved)
    expect(h.memory.isJoinSaved('alpha', earlier)).toBe(false)

    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    const replacement = readThreads(h.stateDir).at(-1)!
    expect(replacement).toMatchObject({ kind: 'join', at: earlier.at })
    await h.memory.compact('alpha')
    expectSynchronousImage(h, header!, [saved[1]!, replacement])

    expect(h.memory.resolveIntent('alpha', postIntent(later).operationId, { none: true })).toBe('none')
    await h.memory.flush('alpha')
    held = [earlier]
    expect(h.choose('mentions').kind).toBe('applied')
    await h.memory.compact('alpha')
    expectSynchronousImage(h, header!, [replacement])
    expect(h.memory.joinedBy('alpha', earlier.channel, earlier.root, earlier.stamp, earlier.at)).toBe(true)

    held = []; h.memory.pruneHeldJoins('alpha')
    await h.memory.compact('alpha')
    expectSynchronousImage(h, header!, [])
    const bytes = journalBytes(h)
    await h.close()
    const reopened = rewriteFixture({ reopen: true }, h.stateDir); await reopened.start()
    expect(journalBytes(reopened)).toEqual(bytes)
    expect(reopened.memory.unresolvedIntents('alpha')).toEqual([])
  })

  test('loaded records with equal sequence numbers retain the original stable walk order across stamp changes', async () => {
    let held: ThreadJoin[] = []
    const h = rewriteFixture({ heldStamps: () => held })
    h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], [C.primary, C.secondary]))
    const primary = h.fact(), secondary = h.fact({ channel: C.secondary })
    const a = joinRecord(primary, 2), b = joinRecord(secondary, 2)
    seedThreads(h.stateDir, [threadHeader(), a, b])
    await h.start()
    expectSynchronousImage(h, threadHeader(), [a, b])
    held = [primary]
    expect(h.choose('mentions').kind).toBe('applied')
    await h.memory.compact('alpha')
    expectSynchronousImage(h, threadHeader(), [b, a])
    held = []; h.memory.pruneHeldJoins('alpha')
    await h.memory.compact('alpha')
    expectSynchronousImage(h, threadHeader(), [b])
  })

  test(`over ${SLICE} records, the compacted image matches synchronous serialization through a held disk wait`, async () => {
    const { h, header, records } = await large('alternate')
    const temp = h.io.hold('fsync', 'alpha', { match: isTemp(h) })
    const compaction = h.memory.compact('alpha')
    try {
      expect(await Promise.race([temp.reached.then(() => 'held'), compaction.then(() => 'completed')])).toBe('held')
      expect(h.events.filter(e => e.type === 'compacted')).toEqual([])
    } finally { temp.release(); await compaction }
    expectSynchronousImage(h, header, records)
    expect(h.events.filter(e => e.type === 'compaction-failed')).toEqual([])
  })

  test.each([false, true])('a saved join that publication moves to the held index during a yield is written exactly once (cached=%s)', async cached => {
    let held: ThreadJoin[] = [], started = false
    const { h, facts, header, records } = await large('one-primary', {
      heldStamps: key => key === 'alpha' ? held : [], canRun: () => { started = true; return true } })
    if (cached) {
      await h.memory.compact('alpha')
      // Cached references no longer yield as if they encoded every record.
      // Add a full slice of new work to exercise publication during a build.
      const added = Array.from({ length: SLICE }, (_, i) => h.fact({ channel: C.secondary, root: rootOf(COUNT + i) }))
      await h.memory.saveJoins('alpha', added)
      records.push(...readThreads(h.stateDir).slice(records.length + 1))
    }
    const moved = facts[0]!
    held = [moved]; started = false; h.io.reset()
    let atYield: { started: boolean; rewriting: boolean } | undefined
    setImmediate(() => {
      atYield = { started, rewriting: h.io.calls.some(c => isTemp(h)(c.path)) }
      expect(h.choose('mentions').kind).toBe('applied')
    })
    await h.memory.compact('alpha')
    // The compaction had collected the primary join and yielded for actual
    // building work, before beginning its rewrite.
    expect(atYield).toEqual({ started: true, rewriting: false })
    expect(view(h, moved.root)).toBe('not-joined')
    expect(h.memory.joinedBy('alpha', moved.channel, moved.root, moved.stamp, moved.at)).toBe(true)
    expect(savedJoins(h).filter(r => r.root === moved.root)).toHaveLength(1)
    expectSynchronousImage(h, header, records)
  })

  test.each(['forget', 'stop'] as const)('%s between slices ends the compaction with the old image and no rewrite', async end => {
    let started = false
    const { h } = await large('alternate', { seal: true, canRun: () => { started = true; return true } })
    const probe = observe(h), before = journalBytes(h), records = readThreads(h.stateDir).slice(1)
    started = false; h.io.reset()
    let wasStarted: boolean | undefined, stopping: Promise<void> | undefined
    setImmediate(() => { wasStarted = started; if (end === 'forget') h.memory.forget('alpha'); else stopping = h.memory.stop() })
    await h.memory.compact('alpha'); await stopping
    expect(wasStarted).toBe(true)
    expect(journalBytes(h)).toEqual(before)
    expect(h.io.writes()).toEqual([])
    expect(h.io.calls.filter(c => c.op === 'fsync' || c.op === 'rename')).toEqual([])
    expect(h.events.filter(e => e.type === 'compaction-failed')).toEqual([])
    expect(probe.completed).toEqual([]); expect(probe.sealed).toEqual([])
    await h.crash()
    const next = rewriteFixture({ reopen: true, seal: true }, h.stateDir), restarted = observe(next)
    await next.start()
    expect(readThreads(next.stateDir).slice(1)).toEqual(records)
    expect(restarted.completed.map(c => c.outcome)).toEqual(['rewritten'])
  })

  test.each(['forget', 'stop'] as const)('%s while the rewrite waits on its temp-file sync lets that rewrite finish whole', async end => {
    const { h, header, records } = await large('alternate')
    const temp = h.io.hold('fsync', 'alpha', { match: isTemp(h) })
    const compaction = h.memory.compact('alpha')
    await temp.reached
    let ended = false
    const ending = end === 'forget' ? (h.memory.forget('alpha'), Promise.resolve()) : h.memory.stop()
    void ending.then(() => { ended = true })
    for (let i = 0; i < 3; i++) await turn()
    // A stop waits for the persona's writer turn; the old image is untouched while its replacement waits.
    expect(ended).toBe(end === 'forget')
    expect(readThreads(h.stateDir)).toEqual([header, ...records])
    temp.release(); await compaction; await ending
    expectSynchronousImage(h, header, records)
    expect(readdirSync(join(h.stateDir, 'threads')).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(h.events.filter(e => e.type === 'compaction-failed')).toEqual([])
  })

  test('maintenance triggers behind a queued, unstarted maintenance compaction add none; it compacts state after the last trigger, and a trigger once it starts queues one more', async () => {
    const { h, header, records } = await large('alternate')
    const completed: ThreadMemoryCompaction[] = []
    h.memory.setCompactionObserver(c => completed.push(c))
    const rewrites = () => h.io.calls.filter(c => c.op === 'rename' && isTemp(h)(c.path)).length
    const first = h.io.hold('fsync', 'alpha', { match: isTemp(h) })
    h.memory.startMaintenance()
    await h.clock.advance(QUEUE_COMPACT_INTERVAL_MS)
    await first.reached
    // The first trigger's compaction is running; the next queues one behind it, the last two add none.
    for (let i = 0; i < 3; i++) await h.clock.advance(QUEUE_COMPACT_INTERVAL_MS)
    // Published after the last trigger, so only a compaction started after it drops the secondary joins.
    expect(h.choose('mentions', 'alpha', C.secondary).kind).toBe('applied')
    const second = h.io.hold('fsync', 'alpha', { match: isTemp(h) })
    first.release(); await second.reached
    expect(rewrites()).toBe(1)
    const firedBefore = h.clock.firedCount()
    await h.clock.advance(QUEUE_COMPACT_INTERVAL_MS)
    // The third pass is queued behind second: this further trigger must add no fourth pass.
    await h.clock.advance(QUEUE_COMPACT_INTERVAL_MS)
    const firedWhileHeld = h.clock.firedCount() - firedBefore
    const completedWhileHeld = completed.map(c => c.outcome)
    // The third pass sees the second pass's unchanged durable image and completes by skipping.
    second.release(); await h.memory.flush('alpha')
    expect(firedWhileHeld).toBe(2)
    expect(completedWhileHeld).toEqual(['rewritten'])
    expect(rewrites()).toBe(2)
    expectSynchronousImage(h, header, records.filter(r => r.kind === 'join' && r.channel === C.primary))
    expect(completed.map(c => [c.key, c.outcome])).toEqual([
      ['alpha', 'rewritten'], ['alpha', 'rewritten'], ['alpha', 'skipped'],
    ])
    expect(h.events.filter(e => e.type === 'compaction-failed')).toEqual([])
  })

  describe('maintenance compaction proof', () => {
    async function established(options: ThreadHarnessOptions = {}) {
      const h = rewriteFixture({ ...options, seal: true }); await h.start()
      await h.memory.saveJoins('alpha', [h.fact()]); await h.memory.compact('alpha')
      const probe = observe(h); probe.reset()
      return { h, probe }
    }
    async function maintenance(h: ThreadMemoryHarness, probe?: ReturnType<typeof observe>) {
      const completed = probe?.nextCompletion()
      h.memory.startMaintenance()
      await h.clock.advance(QUEUE_COMPACT_INTERVAL_MS)
      // Observe completion without flush(), which would also retry kept appends.
      if (completed) await completed
      else await h.memory.flush('alpha') // Observer-unset/throwing cases have no kept append to retry.
      await h.clock.flush()
    }

    test.each(['graceful', 'crash'] as const)('repeated skips preserve journal and seal identity through a %s restart', async end => {
      const { h, probe } = await established(), before = identity(h), seal = sealEntry(h)
      for (let pass = 0; pass < 2; pass++) {
        probe.reset(); await maintenance(h, probe); probe.skipped(before)
        expect(sealEntry(h)).toEqual(seal)
      }
      if (end === 'graceful') await h.close(); else await h.crash()
      const next = rewriteFixture({ reopen: true, seal: true }, h.stateDir)
      const restarted = observe(next)
      await next.start()
      expect(journalBytes(next)).toEqual(before.bytes)
      expect(next.memory.store('alpha')).toMatchObject({ storeId: seal.storeId, lastRecordNumber: seal.lastRecordNumber })
      expectSealFinding(next, end === 'crash' ? 'unclean-stop' : undefined, 'unclean')
      expect(restarted.completed.map(c => c.outcome)).toEqual(['rewritten'])
    })

    test.each(['unrelated stamp', 'move saved join into hold', 'release hold on current join'] as const)('%s leaves the saved image identical and still skips', async change => {
      let held: ThreadJoin[] = []
      const { h, probe } = await established({ heldStamps: () => held }), before = identity(h)
      if (change === 'unrelated stamp') {
        expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], [C.primary, C.secondary])).kind).toBe('applied')
        expect(h.choose('mentions', 'alpha', C.secondary).kind).toBe('applied')
      } else {
        held = [h.fact()]
        if (change === 'move saved join into hold') expect(h.choose('mentions').kind).toBe('applied')
        else { held = []; h.memory.pruneHeldJoins('alpha') }
      }
      await maintenance(h, probe); probe.skipped(before)
      expect(savedJoins(h)).toHaveLength(1)
    })

    test.each((['join', 'intent', 'outcome-only'] as const).flatMap(kind =>
      (['saved', 'failed'] as const).map(result => [kind, result] as const)))('%s append attempt (%s) requires a maintenance rewrite', async (kind, result) => {
      const failed = result === 'failed'
      const { h, probe } = await established()
      const intent = postIntent(h.fact({ root: R.secondary }))
      if (kind === 'outcome-only') {
        const kept = h.memory.keepIntent('alpha', intent)
        expect(kept.kept && await kept.ready).toBe('saved')
        await h.memory.compact('alpha')
      }
      const before = journalBytes(h)
      if (failed) h.io.fail('writeSync')
      if (kind === 'join') expect((await h.memory.saveJoins('alpha', [h.fact({ root: R.secondary })])).kind).toBe(failed ? 'failed' : 'saved')
      else if (kind === 'intent') {
        const kept = h.memory.keepIntent('alpha', intent)
        expect(kept.kept && await kept.ready).toBe(failed ? 'failed' : 'saved')
      } else {
        expect(h.memory.resolveIntent('alpha', intent.operationId, { none: true })).toBe('none')
        expect((await h.memory.flush('alpha')).kind).toBe(failed ? 'failed' : 'saved')
        if (!failed) expect(readThreads(h.stateDir).at(-1)).toMatchObject({ kind: 'post-outcome', outcome: 'none' })
      }
      if (failed) expect(journalBytes(h)).toEqual(before)
      h.io.heal(); probe.reset()
      await maintenance(h, probe); probe.rewritten()
      expect(sealEntry(h).lastRecordNumber).toBe(h.memory.store('alpha')!.lastRecordNumber)
    })

    test.each(['stamp', 'held stamp release'] as const)('%s that drops saved evidence requires a maintenance rewrite', async change => {
      let held: ThreadJoin[] = []
      const { h, probe } = await established({ heldStamps: () => held })
      if (change === 'held stamp release') held = [h.fact()]
      expect(h.choose('mentions').kind).toBe('applied')
      if (change === 'held stamp release') {
        await h.memory.compact('alpha')
        expect(savedJoins(h)).toHaveLength(1)
        held = []; h.memory.pruneHeldJoins('alpha')
      }
      probe.reset(); await maintenance(h, probe); probe.rewritten()
      expect(savedJoins(h)).toEqual([])
    })

    test.each(['saved header', 'failed header', 'existing empty file'] as const)('creation from %s certifies no maintenance skip', async creation => {
      const h = rewriteFixture({ seal: true }), probe = observe(h)
      if (creation === 'existing empty file') seedThreads(h.stateDir, [])
      if (creation === 'failed header') h.io.fail('writeSync', 'alpha', { times: 1 })
      await h.start()
      if (creation === 'failed header') {
        expect(h.events.some(e => e.type === 'creation-failed' && e.step === 'journal-header')).toBe(true)
        h.io.heal(); expect((await h.memory.flush('alpha')).kind).toBe('saved')
      }
      expect(h.memory.store('alpha')?.created).toBe(true)
      expect(probe.completed.map(c => c.outcome)).toEqual(creation === 'existing empty file' ? ['rewritten'] : [])
      probe.reset(); await maintenance(h, probe); probe.rewritten()
    })

    test('a retry read requires a full maintenance rewrite before it can skip', async () => {
      const { h } = await established(); await h.close()
      const next = rewriteFixture({ reopen: true, seal: true }, h.stateDir), probe = observe(next)
      next.io.fail('readFileSync'); await next.start()
      expect(probe.completed).toEqual([])
      next.io.heal(); expect(await next.memory.retryRead('alpha')).toBe('read')
      expect(probe.completed).toEqual([])
      probe.reset(); await maintenance(next, probe); probe.rewritten(['fsync:parent'])
    })

    test.each(['write', 'file fsync', 'rename', 'directory fsync'] as const)('a rewrite failing at %s certifies nothing for the next maintenance pass', async step => {
      const { h, probe } = await established()
      const op = step === 'write' ? 'writeSync' : step === 'rename' ? 'rename' : 'fsync'
      const error = h.io.fail(op, 'alpha', { match: step === 'directory fsync' ? p => p === join(h.stateDir, 'threads') : isTemp(h) })
      await h.memory.compact('alpha')
      expect(probe.completed).toEqual([]); expect(probe.sealed).toEqual([])
      expect(h.events.at(-1)).toMatchObject({ type: 'compaction-failed', error })
      h.io.heal(); probe.reset(); await maintenance(h, probe); probe.rewritten()
    })

    test.each(['slice', 'awaited fsync'] as const)('saved evidence changed during a %s cannot certify the next maintenance pass', async boundary => {
      const { h, header, records } = await large('one-primary', { seal: true }), probe = observe(h)
      probe.reset()
      let changed = false
      const change = () => { expect(h.choose('mentions').kind).toBe('applied'); changed = true }
      if (boundary === 'slice') setImmediate(change)
      const held = boundary === 'awaited fsync' ? h.io.hold('fsync', 'alpha', { match: isTemp(h) }) : undefined
      const rewrite = h.memory.compact('alpha')
      try { if (held) { await held.reached; change() } } finally { held?.release() }
      await rewrite
      expect(changed).toBe(true)
      expect(probe.completed.map(c => c.outcome)).toEqual(['rewritten'])
      probe.reset(); await maintenance(h, probe); await h.memory.flush('alpha'); probe.rewritten()
      expectSynchronousImage(h, header, records.filter(r => r.kind === 'join' && r.channel === C.secondary))
    })

    test('a resumed pass after a cancelled build still rewrites', async () => {
      let allowed = true, cancelled = false
      const { h } = await large('alternate', { seal: true, canRun: () => allowed })
      await h.memory.compact('alpha')
      await h.memory.saveJoins('alpha', Array.from({ length: SLICE }, (_, i) => h.fact({ root: rootOf(COUNT + i) })))
      const expected = readThreads(h.stateDir), probe = observe(h), before = identity(h)
      probe.reset()
      setImmediate(() => { allowed = false; cancelled = true })
      await h.memory.compact('alpha')
      expect(cancelled).toBe(true); expect(probe.completed).toEqual([]); expect(probe.sealed).toEqual([])
      expect(identity(h)).toEqual(before); expect(h.io.writes()).toEqual([])
      allowed = true; probe.reset(); await maintenance(h, probe); probe.rewritten()
      expectSynchronousImage(h, expected[0]!, expected.slice(1))
    })

    test('legacy equal sequence records never certify an ordered-image skip', async () => {
      const h = rewriteFixture({ seal: true }), first = joinRecord(h.fact(), 2), second = joinRecord(h.fact({ root: R.secondary }), 2)
      seedThreads(h.stateDir, [threadHeader(), first, second]); await h.start()
      const probe = observe(h)
      for (let pass = 0; pass < 2; pass++) {
        probe.reset(); await maintenance(h, probe); probe.rewritten()
        expect(savedJoins(h)).toEqual([first, second])
      }
    })

    test.each(['key', 'all'] as const)('explicit compact(%s) always rewrites an unchanged journal', async scope => {
      const { h, probe } = await established()
      await h.memory.compact(scope === 'key' ? 'alpha' : undefined); probe.rewritten()
    })

    test('an observer installed before start times every startup and later loadKey rewrite inside its writer turn', async () => {
      let now = 10
      const h = rewriteFixture({ seal: true, monotonicNow: () => now++ })
      h.unsubscribe() // Configure the startup fixture without scheduling a publication-driven loadKey.
      h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta']))
      for (const key of ['alpha', 'beta']) seedThreads(h.stateDir, [threadHeader(), joinRecord(h.fact({}, key))], key)
      const probe = observe(h)
      await h.start()
      expect(probe.completed.map(c => [c.key, c.outcome]).sort()).toEqual([['alpha', 'rewritten'], ['beta', 'rewritten']])
      for (const key of ['alpha', 'beta']) {
        expect(h.io.calls.filter(c => c.path.startsWith(`${threadPath(h.stateDir, key)}.`) &&
          ['writeSync', 'fsync', 'rename'].includes(c.op)).map(c => c.op)).toEqual(['writeSync', 'fsync', 'rename'])
      }
      expect(h.io.calls.filter(c => c.op === 'fsync' && c.path === join(h.stateDir, 'threads'))).toHaveLength(2)
      expect(probe.sealed.map(c => c.key).sort()).toEqual(['alpha', 'beta'])
      for (const c of probe.completed) expect(c.startMonoMs).toBeLessThanOrEqual(c.endMonoMs)
      h.memory.forget('beta'); probe.reset()
      const held = h.io.hold('fsync', 'beta', { match: p => p.startsWith(`${threadPath(h.stateDir, 'beta')}.`) })
      const loading = h.memory.loadKey('beta')
      try {
        expect(await Promise.race([held.reached.then(() => 'held'), loading.then(() => 'completed')])).toBe('held')
        expect(probe.completed).toEqual([])
        now = 100
      } finally { held.release(); await loading }
      expect(probe.completed).toEqual([{ key: 'beta', startMonoMs: 14, endMonoMs: 100, outcome: 'rewritten' }])
      expect(h.io.calls.filter(c => ['writeSync', 'fsync', 'rename'].includes(c.op)).map(c => c.op))
        .toEqual(['writeSync', 'fsync', 'rename', 'fsync'])
      expect(probe.sealed.map(c => c.key)).toEqual(['beta'])
    })

    test('startup cancelled between slices emits no completion', async () => {
      const { h } = await large('alternate', { seal: true }); await h.close()
      const next = rewriteFixture({ reopen: true, seal: true }, h.stateDir), probe = observe(next), before = journalBytes(next)
      let stopping: Promise<void> | undefined
      next.memory.readAtStart(); await next.seal!.loadAtStart(next.memory.journalFacts())
      setImmediate(() => { stopping = next.memory.stop() })
      await next.memory.activate(); await stopping
      expect(stopping).toBeDefined(); expect(probe.completed).toEqual([]); expect(probe.sealed).toEqual([])
      expect(next.events.filter(e => e.type === 'compacted')).toEqual([])
      expect(journalBytes(next)).toEqual(before)
    })

    test.each(['not live', 'dry run', 'unreadable', 'absent', 'empty non-hybrid', 'seal without header'] as const)('early return for %s emits no completed compaction', async reason => {
      const h = rewriteFixture({ seal: true, dryRun: reason === 'dry run' })
      if (reason === 'absent' || reason === 'empty non-hybrid') h.choose('mentions')
      if (reason !== 'absent') seedThreads(h.stateDir, reason === 'empty non-hybrid' || reason === 'seal without header' ? [] : [threadHeader()])
      if (reason === 'unreadable') h.io.fail('readFileSync')
      if (reason === 'seal without header') h.sealIo.failWrite()
      const probe = observe(h)
      if (reason === 'not live') h.memory.readAtStart(); else await h.start()
      await h.memory.compact('alpha')
      expect(probe.completed).toEqual([])
      expect(h.events.filter(e => e.type === 'compacted')).toEqual([])
    })

    test('throwing and unset observers cannot fail completed rewrites or skips', async () => {
      const outcomes: ThreadMemoryCompaction['outcome'][] = []
      const { h } = await established()
      h.memory.setCompactionObserver(c => { outcomes.push(c.outcome); throw new Error('fixture observer failure') })
      await h.memory.compact('alpha'); await maintenance(h)
      expect(outcomes).toEqual(['rewritten', 'skipped'])
      expect(h.events.filter(e => e.type === 'compaction-failed')).toEqual([])
      h.memory.setCompactionObserver(undefined)
      await h.memory.compact('alpha'); await maintenance(h)
      expect(h.events.filter(e => e.type === 'compacted').slice(-4).map(e => e.outcome)).toEqual(['rewritten', 'skipped', 'rewritten', 'skipped'])
    })
  })
})

describe('Thread Memory held-stamp retention', () => {
  test.each(['publication', 'load', 'recovery'] as const)('%s keeps named stale joins apart, with their earliest saved time through compaction and reopen', async origin => {
    let held: ThreadJoin[] = []
    const heldStamps = (key: string) => key === 'alpha' ? held : []
    const h = fixture({ heldStamps })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], [C.primary, C.secondary])).kind).toBe('applied')
    const early = h.fact({ at: THREAD_TIME + 10 }), late = { ...early, at: early.at + 10 }
    const unnamed = h.fact({ channel: C.secondary, at: late.at + 10 })
    held = [early]
    if (origin === 'load') {
      h.unsubscribe() // Judge the seeded records only at startup, after the authority has changed.
      seedThreads(h.stateDir, [threadHeader(), joinRecord(late), joinRecord(early, 3), joinRecord(unnamed, 4)])
    } else {
      await h.start()
      if (origin === 'publication') await h.memory.saveJoins('alpha', [late, early, unnamed])
    }
    h.io.reset()
    expect(h.choose('mentions').kind).toBe('applied')
    expect(h.choose('mentions', 'alpha', C.secondary).kind).toBe('applied')
    expect(h.io.writes()).toEqual([])
    if (origin === 'load') await h.start()
    if (origin === 'recovery') {
      expect(h.memory.threadJoinSaved('alpha', early.channel, early.root, early.stamp, early.at)).toBe(false)
      h.memory.recoverJoins('alpha', [late, early, unnamed, { ...early, at: unnamed.at }])
      expect(h.memory.joins('alpha')).toEqual([])
      await h.clock.flush()
    }
    expect(h.memory.joins('alpha')).toEqual([])
    expect(view(h)).toBe('not-joined')
    expect(h.memory.hasSavedJoin('alpha', early.channel, early.root, early.stamp)).toBe(false)
    expect(h.memory.isJoinSaved('alpha', early)).toBe(false)
    expect(h.memory.joinedBy('alpha', early.channel, early.root, { ...early.stamp }, early.at)).toBe(true)
    expect(h.memory.joinedBy('alpha', early.channel, early.root, early.stamp, early.at - 1)).toBe(false)
    expect(h.memory.joinedBy('alpha', unnamed.channel, unnamed.root, unnamed.stamp, unnamed.at)).toBe(false)
    expect(h.memory.threadJoinSaved('alpha', early.channel, early.root, early.stamp, early.at)).toBe(true)
    expect(h.memory.threadJoinSaved('alpha', early.channel, early.root, early.stamp, early.at - 1)).toBe(false)
    await h.memory.compact('alpha')
    const records = savedJoins(h)
    expect(records).toHaveLength(1); expect(records[0]).toMatchObject(early)
    await h.close()
    const reopened = fixture({ reopen: true, heldStamps }, h.stateDir); await reopened.start()
    expect(savedJoins(reopened)).toEqual(records)
    expect(reopened.memory.joins('alpha')).toEqual([])
    expect(reopened.memory.joinedBy('alpha', early.channel, early.root, early.stamp, early.at)).toBe(true)
    expect(reopened.memory.hasSavedJoin('alpha', early.channel, early.root, early.stamp)).toBe(false)
    held = []
    reopened.memory.pruneHeldJoins('alpha')
    expect(reopened.memory.joinedBy('alpha', early.channel, early.root, early.stamp, early.at)).toBe(false)
    await reopened.memory.compact('alpha')
    expect(savedJoins(reopened)).toEqual([])
  })

  test.each(['unread', 'unreadable', 'read', 'kept', 'recovered', 'held'] as const)('joinedBy answers from %s evidence without I/O and respects stamp, root and arrival', async origin => {
    let held: ThreadJoin[] = []
    const h = fixture({ heldStamps: () => held }), fact = h.fact()
    held = [fact]
    if (origin === 'unread' || origin === 'unreadable' || origin === 'read') seedThreads(h.stateDir, [threadHeader(), joinRecord(fact)])
    if (origin === 'unreadable') h.io.fail('readFileSync')
    if (origin !== 'unread') await h.start()
    if (origin === 'kept') expect(h.memory.addJoin('alpha', fact)).toBe(true)
    if (origin === 'recovered') h.memory.recoverJoins('alpha', [fact])
    if (origin === 'held') {
      await h.memory.saveJoins('alpha', [fact])
      expect(h.choose('mentions').kind).toBe('applied')
    }
    const unknown = origin === 'unread' || origin === 'unreadable'
    h.io.reset()
    expect(h.memory.joinedBy('alpha', fact.channel, fact.root, { ...fact.stamp }, fact.at)).toBe(unknown ? 'unknown' : true)
    expect(h.memory.joinedBy('alpha', fact.channel, fact.root, fact.stamp, fact.at + 1)).toBe(unknown ? 'unknown' : true)
    expect(h.memory.joinedBy('alpha', fact.channel, fact.root, fact.stamp, fact.at - 1)).toBe(unknown ? 'unknown' : false)
    expect(h.memory.joinedBy('alpha', C.secondary, fact.root, fact.stamp, fact.at)).toBe(unknown ? 'unknown' : false)
    expect(h.memory.joinedBy('alpha', fact.channel, R.secondary, fact.stamp, fact.at)).toBe(unknown ? 'unknown' : false)
    expect(h.io.calls).toEqual([])
    if (unknown) return
    expect(h.choose('mentions').kind).toBe('applied')
    expect(h.choose('thread_hybrid').kind).toBe('applied')
    const current = h.fact()
    expect(current.stamp).not.toEqual(fact.stamp)
    expect(h.memory.joinedBy('alpha', fact.channel, fact.root, current.stamp, current.at)).toBe(false)
    expect(h.memory.hasSavedJoin('alpha', fact.channel, fact.root, current.stamp)).toBe(false)
    expect(view(h)).toBe('not-joined')
    // A new join in the same root cannot hide the old stamp's earlier evidence.
    expect(h.memory.addJoin('alpha', current)).toBe(true)
    expect(h.memory.joinedBy('alpha', fact.channel, fact.root, fact.stamp, fact.at)).toBe(true)
    expect(h.memory.joinedBy('alpha', fact.channel, fact.root, current.stamp, fact.at)).toBe(false)
    expect(view(h)).toBe('joined')
    h.failShared(() => 'unsynced'); expect(h.mode('open').kind).toBe('unresolved')
    const undecided = h.authority.channelStamp('alpha', fact.channel)
    expect(undecided).toEqual({ kind: 'undecided' })
    // The public query must reject an undecided authority value even across a loose caller boundary.
    expect(h.memory.joinedBy('alpha', fact.channel, fact.root, undecided as never, current.at)).toBe(false)
  })

  test('stale held recovery batches with current joins, skips covered candidates, and confirms only saved times', async () => {
    let held: ThreadJoin[] = []
    const h = fixture({ heldStamps: () => held }); await h.start()
    const early = h.fact({ at: THREAD_TIME + 10 }), late = { ...early, at: early.at + 10 }
    held = [early]
    await h.memory.saveJoins('alpha', [late])
    expect(h.choose('mentions').kind).toBe('applied'); expect(h.choose('thread_hybrid').kind).toBe('applied')
    const current = h.fact({ root: R.secondary })
    h.io.fail('writeSync'); h.io.reset()
    h.memory.recoverJoins('alpha', [early, { ...early, at: late.at }, current])
    expect(h.memory.keptFacts('alpha')).toEqual([early, current])
    expect(h.memory.joins('alpha')).toEqual([{ join: current }])
    expect(h.io.calls).toEqual([])
    expect(h.memory.joinedBy('alpha', early.channel, early.root, early.stamp, early.at)).toBe(true)
    expect(h.memory.threadJoinSaved('alpha', early.channel, early.root, early.stamp, early.at)).toBe(false)
    expect(h.memory.threadJoinSaved('alpha', early.channel, early.root, early.stamp, late.at)).toBe(true)
    expect(view(h)).toBe('not-joined'); expect(view(h, current.root)).toBe('joined')
    await h.clock.flush()
    expect(h.events.filter(e => e.type === 'append-failed')).toHaveLength(1)
    h.io.heal()
    await h.memory.compact('alpha')
    expect(savedJoins(h)).toEqual([joinRecord(late)]) // Never serialize the earlier, unsaved time as saved.
    h.io.reset()
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(savedJoins(h)).toEqual([joinRecord(late), joinRecord(early, 3), joinRecord(current, 4)])
    expect(h.io.calls.filter(c => c.op === 'writeSync' && c.path === threadPath(h.stateDir))).toHaveLength(1)
    expect(h.memory.threadJoinSaved('alpha', early.channel, early.root, early.stamp, early.at)).toBe(true)
    const bytes = journalBytes(h)
    h.memory.recoverJoins('alpha', [early, current]); await h.clock.flush()
    expect(journalBytes(h)).toEqual(bytes)
  })

  test('the call-time provider cannot revive dropped joins, and pruning prevents a kept stale join from being appended', async () => {
    let held: ThreadJoin[] = []
    const h = fixture({ heldStamps: () => held }); await h.start()
    const dropped = h.fact()
    await h.memory.saveJoins('alpha', [dropped])
    expect(h.choose('mentions').kind).toBe('applied') // Empty provider: drop at this publication.
    held = [dropped]
    expect(h.choose('thread_hybrid').kind).toBe('applied')
    expect(h.memory.joinedBy('alpha', dropped.channel, dropped.root, dropped.stamp, dropped.at)).toBe(false)
    const kept = h.fact({ root: R.secondary })
    held = [kept]; expect(h.memory.addJoin('alpha', kept)).toBe(true)
    expect(h.choose('mentions').kind).toBe('applied')
    expect(h.memory.joinedBy('alpha', kept.channel, kept.root, kept.stamp, kept.at)).toBe(true)
    expect(h.memory.threadJoinSaved('alpha', kept.channel, kept.root, kept.stamp, kept.at)).toBe(false)
    held = []
    h.memory.pruneHeldJoins('alpha')
    expect(h.memory.joinedBy('alpha', kept.channel, kept.root, kept.stamp, kept.at)).toBe(false)
    h.io.reset(); expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(h.io.calls.filter(c => c.op === 'writeSync')).toEqual([])
    expect(h.memory.keptFacts('alpha')).toEqual([])
    h.memory.recoverJoins('alpha', [kept]); await h.clock.flush()
    await h.memory.compact('alpha'); expect(savedJoins(h)).toEqual([])
    await h.close()
    const reopened = fixture({ reopen: true, heldStamps: () => [] }, h.stateDir); await reopened.start()
    expect(reopened.memory.joins('alpha')).toEqual([])
    expect(reopened.memory.joinedBy('alpha', kept.channel, kept.root, kept.stamp, kept.at)).toBe(false)
  })

  test.each(['current', 'stale-held'] as const)('B1: qualifying pending joins stay unknown until the %s publication recovers them', async outcome => {
    let held: ThreadJoin[] = []
    const h = fixture({ heldStamps: key => key === 'alpha' ? held : [] })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'], [C.primary, C.secondary])).kind).toBe('applied')
    await h.start()
    const fact = h.fact({ at: THREAD_TIME + 1000 }), other = h.fact({ channel: C.secondary })
    held = [fact]
    h.failShared(() => 'unsynced')
    expect((outcome === 'current' ? h.mode('open') : h.choose('mentions')).kind).toBe('unresolved')
    expect(h.authority.channelStamp('alpha', fact.channel)).toEqual({ kind: 'undecided' })
    h.memory.recoverJoins('alpha', [fact]); await h.clock.flush()
    expect(h.memory.store('alpha')?.readable).toBe(true)
    expect(h.memory.joinedBy('alpha', fact.channel, fact.root, fact.stamp, fact.at)).toBe('unknown')
    expect(h.memory.joinedBy('alpha', fact.channel, fact.root, { ...fact.stamp }, fact.at + 1)).toBe('unknown')
    expect(h.memory.joinedBy('alpha', fact.channel, fact.root, fact.stamp, fact.at - 1)).toBe(false)
    expect(h.memory.joinedBy('alpha', fact.channel, R.secondary, fact.stamp, fact.at)).toBe(false)
    expect(h.memory.joinedBy('alpha', C.secondary, fact.root, fact.stamp, fact.at)).toBe(false)
    expect(h.memory.joinedBy('alpha', fact.channel, fact.root, other.stamp, fact.at)).toBe(false)
    expect(h.memory.joinedBy('beta', fact.channel, fact.root, fact.stamp, fact.at)).toBe(false)
    expect(savedJoins(h)).toEqual([])
    h.failShared(); expect(h.authority.recoverDurability().kind).toBe('applied')
    // Recovery is synchronous with publication; its append follows separately.
    expect(h.memory.joinedBy('alpha', fact.channel, fact.root, fact.stamp, fact.at)).toBe(true)
    expect(h.memory.threadJoinSaved('alpha', fact.channel, fact.root, fact.stamp, fact.at)).toBe(false)
    expect(view(h)).toBe(outcome === 'current' ? 'joined' : 'not-joined')
    await h.clock.flush()
    expect(savedJoins(h)).toEqual([joinRecord(fact)])
    expect(h.memory.threadJoinSaved('alpha', fact.channel, fact.root, fact.stamp, fact.at)).toBe(true)
  })

  test.each(['forget', 'remove'] as const)('%s discards a held store without affecting another key or reviving unsaved work', async action => {
    const held = new Map<string, ThreadJoin[]>()
    const h = fixture({ heldStamps: key => held.get(key) ?? [] })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    await h.start()
    const a = h.fact(), b = h.fact({}, 'beta')
    for (const [key, fact] of [['alpha', a], ['beta', b]] as const) {
      held.set(key, [fact]); expect(h.memory.addJoin(key, fact)).toBe(true)
      expect(h.choose('mentions', key).kind).toBe('applied')
      expect(h.memory.joinedBy(key, fact.channel, fact.root, fact.stamp, fact.at)).toBe(true)
    }
    await h.memory.flush('beta'); const betaBytes = journalBytes(h, 'beta')
    const saving = h.memory.flush('alpha'), removing = h.memory[action]('alpha')
    expect(await saving).toEqual({ kind: 'cancelled' }); await removing
    expect(h.memory.joinedBy('alpha', a.channel, a.root, a.stamp, a.at)).toBe('unknown')
    expect(h.memory.joinedBy('beta', b.channel, b.root, b.stamp, b.at)).toBe(true)
    held.delete('alpha'); await h.memory.loadKey('alpha'); await h.memory.flush('alpha')
    expect(h.memory.joinedBy('alpha', a.channel, a.root, a.stamp, a.at)).toBe(false)
    expect(h.memory.hasSavedJoin('beta', b.channel, b.root, b.stamp)).toBe(false)
    expect(h.memory.threadJoinSaved('beta', b.channel, b.root, b.stamp, b.at)).toBe(true)
    expect(journalBytes(h, 'beta')).toEqual(betaBytes)
  })
})

describe('Thread Memory retains joins across publications until their stamp changes', () => {
  test.each(['value', 'leave', 'reset'] as const)('membership and mode publications retain all joins; a %s change forgets affected joins at publication', async cause => {
    const h = membershipFixture({ channels: joinedChannels }); await h.start()
    const many = Array.from({ length: 40 }, (_, i) => h.fact({ root: `1700000001.${String(i).padStart(6, '0')}` }))
    const one = h.fact({ channel: C.secondary })
    expect(await h.memory.saveJoins('alpha', [...many, one])).toEqual({ kind: 'saved' })
    async function rescan() {
      h.stub().script.inventory.push(membershipPage([C.primary, C.secondary]))
      h.membership.scanner.request('alpha'); await h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
      expect(h.membership.scanner.status('alpha').state).toBe('complete')
    }
    await rescan()
    // A mode switch and a rescan change neither stamp.
    expect(h.mode('strict').kind).toBe('applied')
    await rescan()
    expect(h.memory.joins('alpha')).toHaveLength(many.length + 1)
    if (cause === 'value') expect(h.choose('mentions').kind).toBe('applied')
    if (cause === 'leave') await h.membership.event(false)
    if (cause === 'reset') {
      const changed = structuredClone(h.authority.snapshot().source) as unknown as Parameters<typeof h.apply>[0]
      changed.personas![0]!.working_directory = join(h.stateDir, 'new-work')
      expect(h.apply(changed).kind).toBe('applied')
    }
    expect(h.memory.joins('alpha').map(({ join }) => join)).toEqual(cause === 'reset' ? [] : [one])
    if (cause === 'value') {
      expect(h.choose('thread_hybrid').kind).toBe('applied')
      expect(h.fact().stamp).not.toEqual(many[0]!.stamp)
      expect(h.memory.joins('alpha').map(({ join }) => join)).toEqual([one])
    }
  })

  test.each(['current', 'stale', 'held'] as const)('after a warm judgment an undecided stamp keeps every join until its %s decision is judged', async outcome => {
    let held: ThreadJoin[] = []
    const h = fixture({ heldStamps: key => key === 'alpha' ? held : [] })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], [C.primary, C.secondary])).kind).toBe('applied')
    await h.start()
    const changing = h.fact(), unchanged = h.fact({ channel: C.secondary })
    expect(await h.memory.saveJoins('alpha', [changing, unchanged])).toEqual({ kind: 'saved' })
    if (outcome === 'held') held = [changing]
    // Reassigning thread_hybrid keeps the stamp; this publication judges both channels.
    expect(h.choose('thread_hybrid').kind).toBe('applied')
    h.failShared(() => 'unsynced')
    expect((outcome === 'current' ? h.choose('thread_hybrid') : h.choose('mentions')).kind).toBe('unresolved')
    expect(h.authority.channelStamp('alpha', C.primary)).toEqual({ kind: 'undecided' })
    expect(h.memory.joins('alpha')).toHaveLength(2)
    h.failShared(); expect(h.authority.recoverDurability().kind).toBe('applied')
    expect(h.memory.joins('alpha').map(({ join }) => join.channel)).toEqual(outcome === 'current' ? [C.primary, C.secondary] : [C.secondary])
    expect(h.memory.joinedBy('alpha', changing.channel, changing.root, changing.stamp, changing.at)).toBe(outcome !== 'stale')
    expect(h.memory.joinedBy('alpha', unchanged.channel, unchanged.root, unchanged.stamp, unchanged.at)).toBe(true)
  })

  test('an identity reset that declares thread_hybrid anew forgets the old life\'s joins at its publication', async () => {
    const h = fixture()
    expect(h.apply(threadConfig(h.stateDir, 'mentions')).kind).toBe('applied')
    expect(h.choose('thread_hybrid').kind).toBe('applied')
    await h.start()
    const fact = h.fact(); expect(await h.memory.saveJoins('alpha', [fact])).toEqual({ kind: 'saved' })
    // Same-value reassignment: this publication judges the channel under its current stamp.
    expect(h.choose('thread_hybrid').kind).toBe('applied')
    expect(h.memory.joins('alpha')).toHaveLength(1)
    // One reviewed apply: a new life (working directory) whose changed delivery mints a new Since.
    const changed = threadConfig(h.stateDir)
    changed.personas![0]!.working_directory = join(h.stateDir, 'new-work')
    expect(h.apply(changed).kind).toBe('applied')
    const stamp = h.authority.channelStamp('alpha', C.primary)
    expect(stamp?.kind).toBe('decided')
    expect(stamp?.kind === 'decided' ? typeof stamp.threadHybridSince : undefined).toBe('string')
    expect(stamp?.kind === 'decided' ? [stamp.incarnation, stamp.threadHybridSince] : undefined).not.toEqual([fact.stamp.incarnation, fact.stamp.threadHybridSince])
    expect(h.memory.joins('alpha')).toEqual([])
  })

  test('a read retry rebuilds the judgment: a stale saved join read after a warm publication is forgotten', async () => {
    const h = fixture(), current = h.fact({ root: R.secondary })
    const stale = { ...h.fact(), stamp: { ...current.stamp, threadHybridSince: `${FIXTURE_THREAD_HYBRID_SINCE_PREFIX}0` } }
    seedReadable(h, [stale])
    h.io.fail('readFileSync'); await h.start()
    expect(h.memory.addJoin('alpha', current)).toBe(true)
    // Judges the kept join under the current stamp before the journal is read.
    expect(h.choose('thread_hybrid').kind).toBe('applied')
    h.io.heal(); expect(await h.memory.retryRead('alpha')).toBe('read')
    expect(h.memory.joins('alpha').map(({ join }) => join.root)).toEqual([current.root])
    expect(view(h)).toBe('not-joined')
  })

  test('a page-1 positive settles a membership-deferred own-post join on its own publication while page 2 hangs, and it stays joined after page 2 fails', async () => {
    const h = await ownPostFixture({ membership: { channels: joinedChannels } })
    const post = beginPost(h); await post.ready
    const operation = h.memory.unresolvedIntents('alpha', C.primary)[0]!.operationId, second = makeDeferredWebApiCall()
    h.members.h.stub(h.members.h.p('alpha')).script.inventory.push(membershipPage([C.primary, C.secondary], 'next'), second.outcome)
    h.members.scanner.connectionChanged('alpha')
    await confirmPost(h, post)
    expect(h.owner.operation('alpha', operation)).toMatchObject({ state: 'deferred' })
    // From here only the scan runs: no intake, settlement call or other traffic.
    await h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
    expect(h.members.scanner.status('alpha')).toMatchObject({ state: 'scanning', pages: 1 })
    expect(h.memory.view('alpha', C.primary, R.primary)).toBe('joined')
    second.settle({ kind: 'platform', error: 'internal_error' }); await h.flush()
    expect(h.members.scanner.status('alpha')).toMatchObject({ state: 'incomplete', problem: 'transport' })
    expect(h.memory.view('alpha', C.primary, R.primary)).toBe('joined')
    expect(h.records().filter(r => r.kind === 'post-outcome')).toMatchObject([{ operationId: operation, outcome: 'joined' }])
  })
})

describe('Thread Memory saves across stamp publications', () => {
  const channels = channelPopulation(24).map(channel => channel.id)
  /** Saves across `channels` between publications that keep, change, hold and
   * leave undecided their stamps. */
  async function history(stampFacts: boolean) {
    let held: ThreadJoin[] = []
    const h = fixture({ heldStamps: key => key === 'alpha' ? held : [], ...(stampFacts ? {} : { stampFacts: false as const }) })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], channels)).kind).toBe('applied')
    await h.start()
    const results: unknown[] = []
    let n = 0
    const factOn = (channel: string) => h.fact({ channel, root: `1700000002.${String(++n).padStart(6, '0')}` })
    async function save(facts: ThreadJoin[]) {
      results.push(await h.memory.saveJoins('alpha', facts))
      return facts
    }
    await save(channels.map(factOn))
    for (const channel of channels.slice(0, 12)) await save([factOn(channel)])
    // A changed stamp forgets that channel's joins at its publication.
    results.push(h.choose('mentions', 'alpha', channels[0]!).kind, h.choose('thread_hybrid', 'alpha', channels[0]!).kind)
    for (const channel of channels.slice(0, 6)) await save([factOn(channel)])
    // A join a hold names moves to the held index when its stamp changes.
    held = await save([factOn(channels[1]!)])
    results.push(h.choose('mentions', 'alpha', channels[1]!).kind)
    for (const channel of channels.slice(2, 8)) await save([factOn(channel)])
    results.push(held.map(fact => h.memory.joinedBy('alpha', fact.channel, fact.root, fact.stamp, fact.at)))
    held = []
    // Undecided stamps keep every join until the authority recovers.
    const pending = [factOn(channels[2]!), factOn(channels[3]!)]
    h.failShared(() => 'unsynced')
    results.push(h.choose('mentions', 'alpha', channels[2]!).kind)
    await save(pending)
    h.failShared(); results.push(h.authority.recoverDurability().kind)
    for (const channel of channels.slice(3, 9)) await save([factOn(channel)])
    // Store IDs, digest keys and stamps are minted per run; each history mints them in the same order.
    const minted = new Map<string, string>()
    const text = JSON.stringify({ results, joins: h.memory.joins('alpha'), records: readThreads(h.stateDir), events: h.events })
      .replaceAll(h.stateDir, '<dir>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}/g, id => minted.get(id) ?? minted.set(id, `id-${minted.size + 1}`).get(id)!)
    return JSON.parse(text) as unknown
  }

  test('a history of saves and publications retains outcomes, journal and events with or without stamp notifications', async () => {
    expect(await history(true)).toEqual(await history(false))
  })
})

// Integration test 44 measures join/backlog and compaction costs under load.
describe('Thread Memory backlog preserves unsaved joins across changes', () => {
  const channels = channelPopulation(4).map(channel => channel.id), wide = channelPopulation(16).map(channel => channel.id)
  const brief = (fact: Pick<ThreadJoin, 'channel' | 'root' | 'at'>) =>
    `${wide.includes(fact.channel) ? wide.indexOf(fact.channel) : fact.channel}:${fact.root.slice(-3)}@${fact.at - THREAD_TIME}`
  /** Each step's unsaved joins in order, unsaved count, save block and kept probes, then the journal, joins and events. */
  function tracer(h: ThreadMemoryHarness, probes: () => readonly ThreadJoin[]) {
    const trace: unknown[] = []
    return {
      trace,
      look(label: string) {
        const outage = h.memory.outage('alpha')
        trace.push(`${label} | kept ${h.memory.keptFacts('alpha').map(brief).join(' ')} | unsaved ${outage.unsaved}${outage.unknown ? ' unknown' : ''}` +
          `${h.memory.saveBlocked('alpha') ? ' blocked' : ''} | has ${probes().map(p => Number(h.memory.hasKeptJoin('alpha', p.channel, p.root))).join('')}`)
      },
      end() {
        trace.push(readThreads(h.stateDir).map(r => r.kind === 'join' ? `${r.seq} ${brief(r)}` : r.kind === 'post-intent' ? `${r.seq} intent ${r.operationId}`
          : r.kind === 'post-outcome' ? `${r.seq} ${r.operationId} ${r.outcome}` : `${r.seq} ${r.kind}`).join(', '))
        trace.push(h.memory.joins('alpha').map(({ join, savedAt }) => `${brief(join)}${savedAt === undefined ? '' : ` saved@${savedAt - THREAD_TIME}`}`).join(', '))
        trace.push(h.events.map(e => e.type).join(' '))
        return trace
      },
    }
  }
  const holdJournalSync = (h: ThreadMemoryHarness) => h.io.hold('fsync', 'alpha', { match: path => path === threadPath(h.stateDir) })
  test('b.fdw post-ACK batching bounds are pinned', () => {
    expect(JOIN_SAVE_WINDOW_MS).toBe(10)
    expect(JOIN_SAVE_MAX_REQUESTS).toBe(32)
  })
  test.each(['saved', 'failed'] as const)('b.fdw coalesces pending join saves into one durable append: %s', async ending => {
    const h = fixture(); await h.start()
    h.io.reset()
    const first = holdJournalSync(h), writes = h.io.calls
    const head = h.memory.saveJoins('alpha', [h.fact()])
    await first.reached
    const facts = Array.from({ length: 6 }, (_, n) => h.fact({ root: `1700000009.${String(n).padStart(6, '0')}` }))
    const completed: number[] = []
    const backlog = facts.map((fact, n) => h.memory.saveJoins('alpha', [fact], { coalesce: true }).then(result => { completed.push(n); return result }))
    const shared = h.io.hold('fsync', 'alpha', { match: path => path === threadPath(h.stateDir) })
    await h.clock.advance(JOIN_SAVE_WINDOW_MS)
    first.release(); await head; await shared.reached
    expect(completed).toEqual([])
    if (ending === 'failed') h.io.fail('writeSync')
    // Fail the held shared fsync, rather than a later unrelated append.
    if (ending === 'failed') shared.fail(Object.assign(new Error('EIO shared append'), { code: 'EIO' })); else shared.release()
    const results = await Promise.all(backlog)
    h.io.heal()
    expect(completed).toEqual([0, 1, 2, 3, 4, 5])
    expect(results.every(r => r.kind === ending || (ending === 'saved' && r.kind === 'kept'))).toBe(true)
    if (ending === 'saved') expect(savedJoins(h).slice(1).map(f => f.root)).toEqual(facts.map(f => f.root))
    else expect(facts.every(f => !h.memory.isJoinSaved('alpha', f))).toBe(true)
    expect(writes.filter(c => c.op === 'writeSync' && c.path === threadPath(h.stateDir)).length).toBeLessThanOrEqual(2)
  })
  test('b.fdw join-save window is bounded at 10 ms and preserves immediate in-memory joins', async () => {
    const h = fixture(); await h.start(); h.io.reset()
    const first = h.fact(), second = h.fact({ root: R.secondary })
    const a = h.memory.saveJoins('alpha', [first], { coalesce: true })
    await h.clock.flush()
    expect(view(h)).toBe('joined'); expect(h.memory.isJoinSaved('alpha', first)).toBe(false)
    expect(h.io.writes()).toEqual([])
    await h.clock.advance(JOIN_SAVE_WINDOW_MS - 1)
    const b = h.memory.saveJoins('alpha', [second], { coalesce: true })
    expect(h.io.writes()).toEqual([])
    await h.clock.advance(1)
    expect((await Promise.all([a, b])).map(r => r.kind)).toEqual(['kept', 'saved'])
    expect(savedJoins(h).map(r => r.root)).toEqual([first.root, second.root])
    expect(h.io.calls.filter(c => c.op === 'writeSync' && c.path === threadPath(h.stateDir))).toHaveLength(1)
  })
  test('b.fdw 70 saves behind a busy writer use three capped appends', async () => {
    const h = fixture(); await h.start(); h.io.reset()
    const held = holdJournalSync(h), head = h.memory.saveJoins('alpha', [h.fact()])
    await held.reached
    const facts = Array.from({ length: JOIN_SAVE_MAX_REQUESTS * 2 + 6 }, (_, n) => h.fact({ root: `1700000011.${String(n).padStart(6, '0')}` }))
    const pending = facts.map(f => h.memory.saveJoins('alpha', [f], { coalesce: true }))
    await h.clock.advance(JOIN_SAVE_WINDOW_MS)
    held.release(); await head; await Promise.all(pending)
    expect(savedJoins(h).slice(1).map(f => f.root)).toEqual(facts.map(f => f.root))
    expect(h.io.calls.filter(c => c.op === 'writeSync' && c.path === threadPath(h.stateDir))).toHaveLength(4)
    expect(h.clock.pending()).toEqual([])
  })
  test('b.fdw join batches preserve per-caller selections across an earlier timestamp for the same root', async () => {
    const h = fixture(); await h.start(); h.io.reset()
    const first = h.fact(), other = h.fact({ root: R.secondary }), earlier = { ...first, at: first.at - 1 }
    const pending = [first, other, earlier].map(f => h.memory.saveJoins('alpha', [f], { coalesce: true }))
    await h.clock.advance(JOIN_SAVE_WINDOW_MS)
    expect((await Promise.all(pending)).map(r => r.kind)).toEqual(['kept', 'saved', 'saved'])
    // As with separate saves, the first caller also selects its root's earlier
    // kept version. It must precede the other caller's root on disk.
    expect(savedJoins(h).map(({ root, at }) => ({ root, at }))).toEqual([first, earlier, other].map(({ root, at }) => ({ root, at })))
    expect(h.io.calls.filter(c => c.op === 'writeSync' && c.path === threadPath(h.stateDir))).toHaveLength(1)
  })
  test('b.fdw join-save cap closes a 32-request batch without waiting for its window', async () => {
    const h = fixture(); await h.start(); h.io.reset()
    const facts = Array.from({ length: JOIN_SAVE_MAX_REQUESTS }, (_, n) => h.fact({ root: `1700000010.${String(n).padStart(6, '0')}` }))
    const pending = facts.map(f => h.memory.saveJoins('alpha', [f], { coalesce: true }))
    await h.clock.flush()
    const results = await Promise.all(pending)
    expect(results.at(-1)).toEqual({ kind: 'saved' })
    expect(savedJoins(h).map(f => f.root)).toEqual(facts.map(f => f.root))
    expect(h.io.calls.filter(c => c.op === 'writeSync' && c.path === threadPath(h.stateDir))).toHaveLength(1)
    expect(h.clock.pending()).toEqual([])
  })
  test('b.fdw batch outcomes skip a large unrelated backlog and count repeated selections once', async () => {
    const h = fixture(); await h.start()
    const backlog = Array.from({ length: 4096 }, (_, n) => h.fact({ root: `1700000012.${String(n).padStart(6, '0')}` }))
    h.io.fail('writeSync')
    expect((await h.memory.saveJoins('alpha', backlog)).kind).toBe('failed')
    h.io.heal()
    const unrelated = new Set(backlog.map(f => f.root)), originalKeys = Map.prototype.keys
    let unrelatedVisits = 0
    // Count actual kept-write iterator visits, not wall time. Scope the spy
    // to this batch and restore it before the intentional full backlog flush.
    const keys = spyOn(Map.prototype, 'keys').mockImplementation(function* (this: Map<unknown, unknown>) {
      for (const key of originalKeys.call(this)) {
        if (typeof key === 'object' && key !== null && 'records' in key && Array.isArray(key.records) &&
          unrelated.has(key.records[0]?.root)) unrelatedVisits++
        yield key
      }
      return undefined
    })
    async function repeatedSelections(first: ThreadJoin, other: ThreadJoin) {
      const pending = [first, first, other, first].map(f => h.memory.saveJoins('alpha', [f], { coalesce: true }))
      await h.clock.advance(JOIN_SAVE_WINDOW_MS)
      return (await Promise.all(pending)).map(r => r.kind)
    }
    let outcomes: string[]
    try { outcomes = await repeatedSelections(h.fact(), h.fact({ root: R.secondary })) }
    finally { keys.mockRestore() }
    expect(outcomes).toEqual(['kept', 'kept', 'kept', 'kept'])
    expect(h.memory.keptFacts('alpha')).toHaveLength(backlog.length)
    expect(savedJoins(h).map(f => f.root)).toEqual([R.primary, R.secondary])
    // With no unrelated writes left, repeated selections must not decrement
    // the count twice and make the second caller claim saved prematurely.
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(await repeatedSelections(h.fact({ root: R.third }), h.fact({ root: '1700000013.000001' })))
      .toEqual(['kept', 'kept', 'saved', 'saved'])
    expect(unrelatedVisits).toBe(0)
  })
  test('b.fdw saves arriving during a shared append keep every earlier caller marked kept', async () => {
    const h = fixture(); await h.start(); h.io.reset()
    const facts = [h.fact(), h.fact({ root: R.secondary }), h.fact({ root: R.third })], held = holdJournalSync(h)
    const first = facts.slice(0, 2).map(f => h.memory.saveJoins('alpha', [f], { coalesce: true }))
    await h.clock.advance(JOIN_SAVE_WINDOW_MS); await held.reached
    const later = h.memory.saveJoins('alpha', [facts[2]!], { coalesce: true })
    held.release()
    expect((await Promise.all(first)).map(r => r.kind)).toEqual(['kept', 'kept'])
    await h.clock.advance(JOIN_SAVE_WINDOW_MS)
    expect(await later).toEqual({ kind: 'saved' })
    expect(savedJoins(h).map(f => f.root)).toEqual(facts.map(f => f.root))
  })
  test('b.fdw another writer operation seals the join batch immediately without draining its post intent', async () => {
    const h = fixture(); await h.start(); h.io.reset()
    const fact = h.fact(), second = h.fact({ root: R.secondary }), held = holdJournalSync(h)
    const pending = [fact, second].map(f => h.memory.saveJoins('alpha', [f], { coalesce: true }))
    const intent = h.memory.keepIntent('alpha', { operationId: 'post-after-batch', channel: fact.channel, root: fact.root,
      at: fact.at, stamp: fact.stamp, digest: 'ab'.repeat(32) })
    try {
      await h.clock.flush(); await held.reached
      expect(readThreads(h.stateDir).filter(r => r.kind !== 'header').map(r => r.kind)).toEqual(['join', 'join'])
    } finally { held.release() }
    expect((await Promise.all(pending)).map(r => r.kind)).toEqual(['kept', 'kept'])
    expect(intent.kept && await intent.ready).toBe('saved')
    expect(readThreads(h.stateDir).filter(r => r.kind !== 'header').map(r => r.kind)).toEqual(['join', 'join', 'post-intent'])
    expect(h.clock.pending()).toEqual([])
  })
  test.each(['forget', 'remove', 'stop'] as const)('b.fdw %s cancels a pending join-save window without a late append', async ending => {
    const h = fixture(); await h.start(); h.io.reset()
    const pending = h.memory.saveJoins('alpha', [h.fact()], { coalesce: true })
    if (ending === 'forget') h.memory.forget('alpha')
    else if (ending === 'remove') await h.memory.remove('alpha')
    else await h.memory.stop()
    expect(await pending).toEqual({ kind: 'cancelled' })
    const writes = h.io.calls.filter(c => c.op === 'writeSync').length
    await h.clock.advance(JOIN_SAVE_WINDOW_MS * 10)
    expect(h.io.calls.filter(c => c.op === 'writeSync')).toHaveLength(writes)
    expect(h.clock.pending()).toEqual([])
  })
  test('b.fdw a held join batch does not block another persona and shutdown waits for its active append', async () => {
    const h = fixture(); h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])); await h.start(); h.io.reset()
    const held = holdJournalSync(h), alpha = h.fact(), beta = h.fact({}, 'beta')
    const a = h.memory.saveJoins('alpha', [alpha], { coalesce: true })
    await h.clock.advance(JOIN_SAVE_WINDOW_MS); await held.reached
    const b = h.memory.saveJoins('beta', [beta], { coalesce: true })
    await h.clock.advance(JOIN_SAVE_WINDOW_MS)
    expect(await b).toEqual({ kind: 'saved' }); expect(h.memory.isJoinSaved('beta', beta)).toBe(true)
    let stopped = false
    const stop = h.memory.stop().then(() => { stopped = true })
    await h.clock.flush(); expect(stopped).toBe(false)
    held.release()
    expect(await a).toEqual({ kind: 'saved' }); await stop
    expect(stopped).toBe(true); expect(savedJoins(h).map(f => f.root)).toEqual([alpha.root])
    expect(h.clock.pending()).toEqual([])
  })
  test.each(['quiesce', 'stop', 'lifecycle gate'] as const)('b.fdw %s refuses a late join-save window', async ending => {
    let allowed = true
    const h = fixture({ canRun: () => allowed }); await h.start(); h.io.reset()
    if (ending === 'lifecycle gate') allowed = false
    else await h.memory[ending]()
    const pending = h.memory.saveJoins('alpha', [h.fact()], { coalesce: true })
    await h.clock.flush()
    expect(h.clock.pending()).toEqual([])
    expect(await pending).toEqual({ kind: 'cancelled' })
    expect(h.io.writes()).toEqual([])
  })
  // Recorded from the linear scans at 339a4ee1: kept order, counts, kept
  // answers, save results, journal records, joins and events, step by step.
  const backlogTrace = [
    'backlog | kept 0:001@0 0:002@1 1:003@2 2:004@3 3:005@4 0:006@5 1:007@6 2:008@7 3:009@8 0:010@9 1:011@10 2:012@11 3:013@12 0:014@13 1:015@14 2:016@15 3:017@16 1:018@17 2:019@18 1:007@5 3:020@19 3:020@18 | unsaved 22 | has 11111111',
    'applied',
    'applied',
    'stamps changed | kept 0:001@0 0:002@1 2:004@3 3:005@4 0:006@5 2:008@7 3:009@8 0:010@9 2:012@11 3:013@12 0:014@13 2:016@15 3:017@16 2:019@18 3:020@19 3:020@18 | unsaved 16 | has 11001100',
    'applied',
    'new stamp | kept 0:001@0 0:002@1 2:004@3 3:005@4 0:006@5 2:008@7 3:009@8 0:010@9 2:012@11 3:013@12 0:014@13 2:016@15 3:017@16 2:019@18 3:020@19 3:020@18 1:021@20 | unsaved 17 | has 11001100',
    '0:001@0 kept, 0:002@1 kept, 1:003@2 kept, 2:004@3 kept, 3:005@4 kept, 0:006@5 kept, 1:007@6 kept, 2:008@7 kept, 3:009@8 kept, 0:010@9 kept, 1:011@10 kept, 2:012@11 kept, 3:013@12 kept, 0:014@13 kept, 1:015@14 kept, 2:016@15 kept, 3:017@16 kept, 1:018@17+2:019@18 kept, 0:006@6 kept, 1:007@5 kept, 3:020@18 kept, 1:021@20 kept',
    'released | kept  | unsaved 0 | has 00000000',
    'unresolved',
    'undecided | kept 0:022@21 3:023@22 0:024@23 3:025@24 | unsaved 4 | has 00000000',
    '0:022@21 kept, 3:023@22 kept, 0:024@23+3:025@24 kept',
    'deferred | kept 3:023@22 3:025@24 | unsaved 2 | has 00000000',
    'applied',
    'recovered | kept  | unsaved 0 | has 00000000',
    'saved',
    'flushed | kept  | unsaved 0 | has 00000000',
    '0:026@25 failed',
    'failed | kept 0:026@25 | unsaved 1 blocked | has 00000000',
    '0:027@26 kept',
    'saved after failure | kept 0:026@25 | unsaved 1 blocked | has 00000000',
    'saved',
    'flushed again | kept  | unsaved 0 | has 00000000',
    'joined',
    'posts held | kept 0:028@28 | unsaved 4 | has 00000000',
    'saved',
    'saved',
    'none',
    'saved',
    'posts saved | kept  | unsaved 0 | has 00000000',
    '1 header, 2 0:001@0, 3 0:002@1, 4 2:004@3, 5 3:005@4, 6 0:006@5, 7 2:008@7, 8 3:009@8, 9 0:010@9, 10 2:012@11, 11 3:013@12, 12 0:014@13, 13 2:016@15, 14 3:017@16, 15 2:019@18, 16 3:020@18, 17 1:021@20, 18 0:022@21, 19 0:024@23, 20 0:027@26, 21 0:026@25, 22 intent post-a, 23 intent post-b, 24 0:028@28, 25 post-a joined, 26 post-b none',
    '0:001@0 saved@0, 0:002@1 saved@1, 0:006@5 saved@5, 0:010@9 saved@9, 0:014@13 saved@13, 0:022@21 saved@21, 0:024@23 saved@23, 0:026@25 saved@25, 0:027@26 saved@26, 0:028@28 saved@28, 1:021@20 saved@20',
    'created outage-settled outage-settled outage-settled append-failed saved-after-failure outage-settled',
  ]
  const readRetryTrace = [
    true,
    true,
    true,
    'unreadable | kept C0TEST001:002@1 C0TEST001:001@0 C0TEST001:001@-1 | unsaved 3 unknown | has 11',
    'read',
    'read | kept C0TEST001:002@1 C0TEST001:001@-1 | unsaved 2 | has 11',
    'saved',
    'flushed | kept  | unsaved 0 | has 00',
    '1 header, 2 C0TEST001:001@0, 3 C0TEST001:002@1, 4 C0TEST001:001@0, 5 C0TEST001:001@-1',
    'C0TEST001:002@1 saved@1, C0TEST001:001@-1 saved@-1',
    'read-failed read outage-settled',
  ]

  // Recorded from judging and counting every kept channel at each save, before
  // per-channel judgements under unchanged stamp facts.
  const wideTrace = [
    'backlog | kept 0:001@0 0:002@1 1:003@2 2:004@3 3:005@4 4:006@5 5:007@6 6:008@7 7:009@8 8:010@9 9:011@10 10:012@11 11:013@12 12:014@13 13:015@14 14:016@15 15:017@16 0:018@17 1:019@18 2:020@19 3:021@20 4:022@21 5:023@22 6:024@23 7:025@24 8:026@25 9:027@26 10:028@27 11:029@28 12:030@29 13:031@30 14:032@31 15:033@32 | unsaved 33 | has 111111',
    'applied',
    'applied',
    'stamps changed | kept 0:001@0 0:002@1 1:003@2 2:004@3 3:005@4 4:006@5 5:007@6 6:008@7 7:009@8 8:010@9 10:012@11 11:013@12 12:014@13 13:015@14 14:016@15 15:017@16 0:018@17 1:019@18 2:020@19 3:021@20 4:022@21 5:023@22 6:024@23 7:025@24 8:026@25 10:028@27 11:029@28 12:030@29 13:031@30 14:032@31 15:033@32 | unsaved 31 | has 110000',
    'one judged | kept 0:002@1 1:003@2 2:004@3 3:005@4 4:006@5 5:007@6 6:008@7 7:009@8 8:010@9 10:012@11 11:013@12 12:014@13 13:015@14 14:016@15 15:017@16 0:018@17 1:019@18 2:020@19 3:021@20 4:022@21 5:023@22 6:024@23 7:025@24 8:026@25 10:028@27 11:029@28 12:030@29 13:031@30 14:032@31 15:033@32 | unsaved 30 | has 110000',
    'hold withdrawn | kept 0:002@1 1:003@2 2:004@3 3:005@4 4:006@5 5:007@6 6:008@7 7:009@8 8:010@9 10:012@11 11:013@12 12:014@13 13:015@14 14:016@15 15:017@16 0:018@17 1:019@18 2:020@19 3:021@20 4:022@21 5:023@22 6:024@23 7:025@24 8:026@25 10:028@27 11:029@28 12:030@29 13:031@30 14:032@31 15:033@32 | unsaved 28 | has 110000',
    'next judged | kept 1:003@2 2:004@3 3:005@4 4:006@5 6:008@7 7:009@8 8:010@9 10:012@11 11:013@12 12:014@13 13:015@14 14:016@15 15:017@16 0:018@17 1:019@18 2:020@19 3:021@20 4:022@21 6:024@23 7:025@24 8:026@25 10:028@27 11:029@28 12:030@29 13:031@30 14:032@31 15:033@32 | unsaved 27 | has 010000',
    'unresolved',
    'undecided | kept 1:003@2 2:004@3 3:005@4 4:006@5 6:008@7 7:009@8 8:010@9 10:012@11 11:013@12 12:014@13 13:015@14 14:016@15 15:017@16 0:018@17 1:019@18 2:020@19 3:021@20 4:022@21 6:024@23 7:025@24 8:026@25 10:028@27 11:029@28 12:030@29 13:031@30 14:032@31 15:033@32 3:035@34 | unsaved 28 | has 000000',
    'applied',
    'recovered | kept 1:003@2 3:005@4 4:006@5 6:008@7 7:009@8 8:010@9 10:012@11 11:013@12 12:014@13 13:015@14 14:016@15 15:017@16 0:018@17 1:019@18 3:021@20 4:022@21 6:024@23 7:025@24 8:026@25 10:028@27 11:029@28 12:030@29 13:031@30 14:032@31 15:033@32 3:035@34 | unsaved 26 | has 000000',
    '0:001@0 kept, 0:002@1 kept, 1:003@2 kept, 2:004@3 kept, 3:005@4 kept, 4:006@5 kept, 5:007@6 kept, 6:008@7 kept, 7:009@8 kept, 8:010@9 kept, 9:011@10 kept, 10:012@11 kept, 11:013@12 kept, 12:014@13 kept, 13:015@14 kept, 14:016@15 kept, 15:017@16 kept, 0:018@17 kept, 1:019@18 kept, 2:020@19 kept, 3:021@20 kept, 4:022@21 kept, 5:023@22 kept, 6:024@23 kept, 7:025@24 kept, 8:026@25 kept, 9:027@26 kept, 10:028@27 kept, 11:029@28 kept, 12:030@29 kept, 13:031@30 kept, 14:032@31 kept, 15:033@32 kept, 2:034@33 kept, 3:035@34 saved',
    'drained | kept  | unsaved 0 | has 000000',
    'saved',
    'flushed | kept  | unsaved 0 | has 000000',
    '1 header, 2 0:001@0, 3 0:002@1, 4 1:003@2, 5 3:005@4, 6 4:006@5, 7 6:008@7, 8 7:009@8, 9 8:010@9, 10 10:012@11, 11 11:013@12, 12 12:014@13, 13 13:015@14, 14 14:016@15, 15 15:017@16, 16 0:018@17, 17 1:019@18, 18 3:021@20, 19 4:022@21, 20 6:024@23, 21 7:025@24, 22 8:026@25, 23 10:028@27, 24 11:029@28, 25 12:030@29, 26 13:031@30, 27 14:032@31, 28 15:033@32, 29 3:035@34',
    '0:001@0 saved@0, 0:002@1 saved@1, 0:018@17 saved@17, 1:003@2 saved@2, 1:019@18 saved@18, 3:005@4 saved@4, 3:021@20 saved@20, 3:035@34 saved@34, 4:006@5 saved@5, 4:022@21 saved@21, 6:008@7 saved@7, 6:024@23 saved@23, 7:009@8 saved@8, 7:025@24 saved@24, 8:010@9 saved@9, 8:026@25 saved@25, 10:012@11 saved@11, 10:028@27 saved@27, 11:013@12 saved@12, 11:029@28 saved@28, 12:014@13 saved@13, 12:030@29 saved@29, 13:015@14 saved@14, 13:031@30 saved@30, 14:016@15 saved@15, 14:032@31 saved@31, 15:017@16 saved@16, 15:033@32 saved@32',
    'created outage-settled',
  ]

  /** Saves queued behind held appends, through stamp changes, holds, undecided stamps, a failed append and posts. */
  async function backlogHistory() {
    let held: ThreadJoin[] = []
    const h = fixture({ heldStamps: key => key === 'alpha' ? held : [] })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], channels)).kind).toBe('applied')
    await h.start()
    let n = 0
    const on = (i: number) => h.fact({ channel: channels[i]!, root: `1700000003.${String(++n).padStart(6, '0')}` })
    const facts: ThreadJoin[] = [], results: string[] = [], saving: Promise<void>[] = []
    const { trace, look, end } = tracer(h, () => facts.slice(0, 8))
    const save = (batch: ThreadJoin[]) => {
      facts.push(...batch)
      saving.push(h.memory.saveJoins('alpha', batch).then(result => { results.push(`${batch.map(brief).join('+')} ${result.kind}`) }))
    }
    const settle = async () => { await Promise.all(saving.splice(0)); trace.push(results.splice(0).join(', ')) }
    const sync = holdJournalSync(h)
    save([on(0)]); await sync.reached
    for (let i = 0; i < 16; i++) save([on(i % 4)])
    save([on(1), on(2)])
    // A later time for a kept root keeps nothing new; an earlier one keeps another join.
    save([{ ...facts[5]!, at: facts[5]!.at + 1 }]); save([{ ...facts[6]!, at: facts[6]!.at - 1 }])
    // Kept with no save of its own; an earlier join's save saves its root first.
    const alone = on(3)
    expect(h.memory.addJoin('alpha', alone)).toBe(true); facts.push(alone)
    save([{ ...alone, at: alone.at - 1 }])
    look('backlog')
    // A changed stamp forgets its channel's unsaved joins; a hold keeps another channel's.
    trace.push(h.choose('mentions', 'alpha', channels[1]!).kind)
    held = [facts[3]!]
    trace.push(h.choose('mentions', 'alpha', channels[2]!).kind)
    look('stamps changed')
    trace.push(h.choose('thread_hybrid', 'alpha', channels[1]!).kind)
    save([on(1)])
    look('new stamp')
    sync.release(); await settle(); look('released')
    // Undecided stamps defer joins until the authority recovers.
    const again = holdJournalSync(h)
    save([on(0)]); await again.reached
    save([on(3)]); save([on(0), on(3)])
    h.failShared(() => 'unsynced'); trace.push(h.choose('mentions', 'alpha', channels[3]!).kind)
    look('undecided')
    again.release(); await settle(); look('deferred')
    h.failShared(); trace.push(h.authority.recoverDurability().kind)
    look('recovered')
    trace.push((await h.memory.flush('alpha')).kind); look('flushed')
    // A failed append blocks saves until one succeeds.
    h.io.fail('writeSync', 'alpha', { times: 1 })
    save([on(0)]); await settle(); look('failed')
    save([on(0)]); await settle(); look('saved after failure')
    trace.push((await h.memory.flush('alpha')).kind); look('flushed again')
    // Posts count as unsaved until their intent and outcome are saved.
    const post = holdJournalSync(h), target = on(0)
    const first = h.memory.keepIntent('alpha', { operationId: 'post-a', channel: target.channel, root: target.root, at: target.at, stamp: target.stamp,
      content: { kind: 'text', text: 'first post' } })
    await post.reached
    const second = h.memory.keepIntent('alpha', { operationId: 'post-b', channel: target.channel, at: target.at, stamp: target.stamp, digest: 'cd'.repeat(32) })
    trace.push(h.memory.resolveIntent('alpha', 'post-a', { joined: { channel: target.channel, root: target.root, stamp: target.stamp } }) ?? 'unresolved')
    look('posts held')
    post.release()
    trace.push(String(first.kept && await first.ready), String(second.kept && await second.ready))
    trace.push(h.memory.resolveIntent('alpha', 'post-b', { none: true }) ?? 'unresolved')
    trace.push((await h.memory.flush('alpha')).kind); look('posts saved')
    return end()
  }

  /** Saves across many channels behind held appends: a hold alone keeps a
   * changed channel's joins and is then withdrawn with no new stamp facts;
   * then undecided stamps, recovery and a drained backlog. */
  async function wideHistory() {
    let held: ThreadJoin[] = []
    const h = fixture({ heldStamps: key => key === 'alpha' ? held : [] })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], wide)).kind).toBe('applied')
    await h.start()
    let n = 0
    const on = (i: number) => h.fact({ channel: wide[i]!, root: `1700000005.${String(++n).padStart(6, '0')}` })
    const facts: ThreadJoin[] = [], results: string[] = [], saving: Promise<void>[] = []
    // facts[k] is on channel (k - 1) % 16 for k >= 1.
    const { trace, look, end } = tracer(h, () => [1, 3, 6, 10, 22, 26].map(k => facts[k]!))
    const save = (batch: ThreadJoin[]) => {
      facts.push(...batch)
      saving.push(h.memory.saveJoins('alpha', batch).then(result => { results.push(`${batch.map(brief).join('+')} ${result.kind}`) }))
    }
    const settle = async () => { await Promise.all(saving.splice(0)); trace.push(results.splice(0).join(', ')) }
    const first = holdJournalSync(h)
    save([on(0)]); await first.reached
    for (let i = 0; i < 32; i++) save([on(i % 16)])
    look('backlog')
    // Only a hold keeps channel 5's joins once its stamp changes; channel 9's are forgotten.
    held = [facts[6]!]
    trace.push(h.choose('mentions', 'alpha', wide[5]!).kind, h.choose('mentions', 'alpha', wide[9]!).kind)
    look('stamps changed')
    const second = holdJournalSync(h)
    first.release(); await second.reached
    look('one judged')
    // Withdrawn with no publication: the next judgement forgets channel 5's joins.
    held = []
    look('hold withdrawn')
    const third = holdJournalSync(h)
    second.release(); await third.reached
    look('next judged')
    const late = [on(2), on(3)]
    h.failShared(() => 'unsynced'); trace.push(h.choose('mentions', 'alpha', wide[2]!).kind)
    for (const fact of late) save([fact])
    look('undecided')
    h.failShared(); trace.push(h.authority.recoverDurability().kind)
    look('recovered')
    third.release(); await settle(); look('drained')
    trace.push((await h.memory.flush('alpha')).kind); look('flushed')
    return end()
  }
  /** Joins kept while the journal is unreadable, then read: saved evidence on disk settles them. */
  async function readRetryHistory() {
    const h = fixture()
    const saved = h.fact(), other = h.fact({ root: R.secondary })
    seedReadable(h, [saved])
    h.io.fail('readFileSync'); await h.start()
    const { trace, look, end } = tracer(h, () => [saved, other])
    for (const fact of [other, { ...saved }, { ...saved, at: saved.at - 1 }]) trace.push(h.memory.addJoin('alpha', fact))
    look('unreadable')
    h.io.heal(); trace.push(await h.memory.retryRead('alpha')); look('read')
    trace.push((await h.memory.flush('alpha')).kind); look('flushed')
    return end()
  }

  test('saves queued behind held appends keep the unsaved order, counts, kept answers, journal and events of scanning every unsaved join', async () => {
    expect(await backlogHistory()).toEqual(backlogTrace)
  })

  test('joins kept while the journal was unreadable settle against its saved evidence as scanning every unsaved join did', async () => {
    expect(await readRetryHistory()).toEqual(readRetryTrace)
  })

  test('saves across many channels keep the unsaved order, counts, kept answers, journal and events of judging and counting every kept channel', async () => {
    expect(await wideHistory()).toEqual(wideTrace)
  })

  test('a held append backlog across many channels saves every join and settles its outage once', async () => {
    const many = channelPopulation(200).map(channel => channel.id)
    const h = fixture()
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], many)).kind).toBe('applied')
    await h.start()
    const sync = holdJournalSync(h)
    const saves = [h.memory.saveJoins('alpha', [h.fact({ channel: many[0]! })])]
    await sync.reached
    saves.push(...Array.from({ length: 400 }, (_, i) =>
      h.memory.saveJoins('alpha', [h.fact({ channel: many[i % many.length]!, root: `1700000006.${String(i).padStart(6, '0')}` })])))
    sync.release()
    const results = await Promise.all(saves)
    expect(results.at(-1)).toEqual({ kind: 'saved' })
    expect(h.memory.keptFacts('alpha')).toEqual([])
    expect(h.events.filter(e => e.type === 'outage-settled')).toHaveLength(1)
    expect(savedJoins(h)).toHaveLength(saves.length)
  })
  test('a backlog retains held stale joins while saving every queued fact', async () => {
    let held: ThreadJoin[] = []
    const h = fixture({ heldStamps: key => key === 'alpha' ? held : [] })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], channels)).kind).toBe('applied')
    await h.start()
    const sync = holdJournalSync(h)
    const saves = [h.memory.saveJoins('alpha', [h.fact({ channel: channels[0]! })])]
    await sync.reached
    const backlog = Array.from({ length: 400 }, (_, i) => h.fact({ channel: channels[i % 4]!, root: `1700000004.${String(i).padStart(6, '0')}` }))
    saves.push(...backlog.map(fact => h.memory.saveJoins('alpha', [fact])))
    // The last channel's unsaved joins are stale but named by a hold.
    held = [backlog[3]!]
    expect(h.choose('mentions', 'alpha', channels[3]!).kind).toBe('applied')
    sync.release()
    const results = await Promise.all(saves)
    expect(results.at(-1)).toEqual({ kind: 'saved' })
    expect(h.memory.keptFacts('alpha')).toEqual([])
    expect(savedJoins(h)).toHaveLength(saves.length)
  })
})

describe('Thread Memory seal judgments and closed metadata', () => {
  test.each(['running-own-posts', 'own-post-channel', 'own-post-root', 'duplicate-own-post', 'own-post-extra-key'] as const)(
    'own-post seal rejects %s damage as no entries and rewrites valid running metadata', async damage => {
      const h = sealFixture(); seedThreads(h.stateDir, [threadHeader()])
      writeFileSync(threadSealPath(h.stateDir), damagedThreadSeal(h.stateDir, damage))
      await h.start()
      expect(h.sealEvents.filter(e => e.type === 'seal-invalid')).toHaveLength(1)
      expectSealFinding(h, 'entry-missing')
      expect(sealEntry(h)).toEqual(runningSealEntry())
    })

  test.each((['flush', 'creation', 'compaction', 'removal', 'start'] as const).flatMap(write =>
    [false, true].map(running => [write, running] as const)))('own-post list never survives a non-shutdown %s write; running=%s', async (write, running) => {
    const h = sealFixture(); await h.start()
    const identity = h.memory.completedStores().get('alpha')!
    if (write === 'removal') await h.seal.entryCreated('beta', identity.storeId, identity.lastRecordNumber)
    const memoryOnlyJoins = [{ channel: C.primary, root: R.primary }]
    await h.seal.writeShutdown(new Map([['alpha', running ? { memoryOnlyJoins } : { ...identity, memoryOnlyJoins }]]))
    expect(sealedJoins(h)).toHaveLength(1)
    expect(sealEntry(h).clean).toBe(!running)
    if (write === 'flush') await h.seal.flush()
    if (write === 'creation') await h.seal.entryCreated('beta', identity.storeId, identity.lastRecordNumber)
    if (write === 'compaction') await h.memory.compact()
    if (write === 'removal') await h.seal.removeEntry('beta')
    if (write === 'start') await h.seal.refreshAtStart(h.memory.journalFacts())
    expect(sealedJoins(h)).toBeUndefined()
    expect(sealEntry(h)).not.toHaveProperty('gracefulShutdown')
  })

  test('running own-post lists require the exact graceful-shutdown marker; legacy entries remain valid', async () => {
    const h = sealFixture(); await h.start()
    const threads = [{ channel: C.primary, root: R.secondary }, { channel: C.primary, root: R.primary }]
    await h.seal.writeShutdown(new Map([['alpha', { memoryOnlyJoins: threads }]]))
    const entry = sealEntry(h)
    expect(entry).toEqual({ clean: false, gracefulShutdown: true, memoryOnlyJoins: [...threads].reverse() })
    expect(isThreadMemorySealEntry(entry)).toBe(true)
    const { memoryOnlyJoins, ...withoutList } = entry
    expect(isThreadMemorySealEntry(withoutList)).toBe(true)
    for (const gracefulShutdown of [undefined, false, 'true', 1, null]) {
      expect(isThreadMemorySealEntry({ ...entry, gracefulShutdown })).toBe(false)
    }
    expect(isThreadMemorySealEntry({ clean: false, memoryOnlyJoins })).toBe(false)
    for (const invalid of [
      { ...entry, storeId: 'partial' }, { ...entry, lastRecordNumber: 0 },
      { ...entry, queue: cleanSealEntry(h.stateDir).queue }, { ...entry, text: LEAK_SENTINEL },
      { ...entry, memoryOnlyJoins: [...threads, threads[0]] },
      { ...entry, memoryOnlyJoins: [{ channel: 'invalid', root: R.primary }] },
      { ...entry, memoryOnlyJoins: [{ channel: C.primary, root: 'invalid' }] },
      { ...entry, memoryOnlyJoins: [{ ...threads[0], text: LEAK_SENTINEL }] },
    ]) expect(isThreadMemorySealEntry(invalid)).toBe(false)
    // All old v1 forms still round-trip through the same closed serializer.
    for (const legacy of [runningSealEntry(), cleanSealEntry(h.stateDir), { clean: false as const }]) {
      const file = { v: 1 as const, entries: { alpha: legacy } }
      expect(isThreadMemorySealFile(file)).toBe(true)
      expect(JSON.parse(serializeThreadMemorySeal(file).toString())).toEqual(file)
    }
  })

  test('production schema accepts running, clean and empty files and rejects extra content at every level', () => {
    const h = sealFixture(), running = runningSealEntry(), clean = cleanSealEntry(h.stateDir)
    const validEntries: Array<Record<string, ThreadMemorySealEntry>> = [{}, { alpha: running }, { alpha: clean, beta: running }]
    for (const entries of validEntries) {
      const file = { v: 1 as const, entries }
      expect(isThreadMemorySealFile(file)).toBe(true)
      expect(JSON.parse(serializeThreadMemorySeal(file).toString())).toEqual(file)
    }
    const file = { v: 1, entries: { alpha: clean } }
    for (const invalid of [null, [], { ...file, v: 2 }, { ...file, text: LEAK_SENTINEL },
      { ...file, entries: { '../alpha': clean } }, { ...file, entries: [] },
      { ...file, entries: { alpha: { ...clean, token: fakeToken(BOT_TOKEN_PREFIX) } } }]) {
      expect(isThreadMemorySealFile(invalid)).toBe(false)
      let rejection: unknown
      try { serializeThreadMemorySeal(invalid as never) } catch (error) { rejection = error }
      expect(rejection).toBeInstanceOf(Error)
      expect((rejection as Error).message).toStartWith('Invalid Thread Memory seal')
      assertNoLeak(rejection)
    }
    for (const invalid of [
      { ...running, storeId: '' }, { ...running, storeId: '../store' },
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(lastRecordNumber => ({ ...running, lastRecordNumber })),
      { ...running, clean: 'false' }, { ...running, queue: clean.queue }, { ...clean, queue: undefined },
      ...[{ ...clean.queue, text: LEAK_SENTINEL }, { ...clean.queue, size: '01' }, { ...clean.queue, sha256: 'invalid' },
        { ...clean.queue, inode: '1' }, { ...clean.queue, mtimeNs: '1' }, { ...clean.queue, size: '1' },
        { ...clean.queue, sha256: 'a'.repeat(64) }].map(queue => ({ ...clean, queue })),
    ]) expect(isThreadMemorySealEntry(invalid)).toBe(false)
  })

  test('judgment precedence uses original evidence, with unclean wording only for the stated cases', () => {
    const h = sealFixture(), previous = cleanSealEntry(h.stateDir), queue = { ...previous.queue!, inode: '3', mtimeNs: '4' }
    const input: JudgeSealInput = { key: 'alpha', previous, queue, journal: { kind: 'read', storeId: previous.storeId, lastRecordNumber: previous.lastRecordNumber },
      threadHybrid: true, created: true, sealExisted: true, anyUnclean: false }
    const rows: Array<[Partial<JudgeSealInput>, ThreadMemorySealCase | undefined, 'changed' | 'unclean']> = [
      [{ previous: runningSealEntry(), journal: { kind: 'absent' } }, 'unclean-stop', 'unclean'],
      [{ previous: runningSealEntry(), journal: { kind: 'read', storeId: 'other', lastRecordNumber: 0 } }, 'unclean-stop', 'unclean'],
      [{ journal: { kind: 'absent' } }, 'journal-missing', 'changed'],
      [{ journal: { kind: 'not-created' } }, 'journal-missing', 'changed'],
      [{ journal: { kind: 'read', storeId: 'other', lastRecordNumber: 0 } }, 'journal-changed', 'changed'],
      [{ previous: undefined }, 'entry-missing', 'changed'],
      [{ previous: undefined, journal: { kind: 'absent' } }, 'hybrid-without-store', 'changed'],
      [{ previous: undefined, journal: { kind: 'absent' }, anyUnclean: true }, 'hybrid-without-store', 'unclean'],
      [{ previous: undefined, journal: { kind: 'absent' }, threadHybrid: false, anyUnclean: true }, 'marker-without-store', 'changed'],
      [{ anyUnclean: true }, 'queue-changed', 'changed'],
      [{ queue: undefined }, undefined, 'changed'],
      [{ previous: undefined, journal: { kind: 'absent' }, sealExisted: false, created: false }, undefined, 'changed'],
    ]
    for (const [change, reason, wording] of rows) expect(judgeSeal({ ...input, ...change })).toEqual(reason ? { key: 'alpha', case: reason, wording } : undefined)
  })

  test.each(['inode', 'size', 'mtimeNs', 'sha256'] as const)('a change of queue %s alone is detected', field => {
    const h = sealFixture(), base = cleanSealEntry(h.stateDir)
    const queue = { inode: '9007199254740993', size: '42', mtimeNs: '1700000000000000001', sha256: base.queue!.sha256 }
    const changed = { ...queue, [field]: field === 'sha256' ? 'b'.repeat(64) : (BigInt(queue[field]) + 1n).toString() }
    expect(queueIdentitiesMatch(queue, queue)).toBe(true)
    expect(queueIdentitiesMatch(queue, changed)).toBe(false)
    expect(judgeSeal({ key: 'alpha', previous: { ...base, clean: true, queue }, queue: changed,
      journal: { kind: 'read', storeId: base.storeId, lastRecordNumber: base.lastRecordNumber + 1 },
      threadHybrid: false, created: false, sealExisted: true, anyUnclean: false })).toEqual({ key: 'alpha', case: 'queue-changed', wording: 'changed' })
  })

  test('queue hashing uses descriptor metadata and bounded reads, distinguishes absent from empty, and closes failed reads', async () => {
    const h = sealFixture(), absent = h.seal.queueIdentity('alpha')
    expect(absent).toEqual({ size: '0', sha256: createHash('sha256').digest('hex') })
    await h.queue.start(); await h.queue.accept('alpha', slackInput({ text: 'x'.repeat(200_000) }))
    h.sealIo.reset()
    const identity = h.seal.queueIdentity('alpha'), stat = statSync(queuePath(h.stateDir), { bigint: true })
    expect(identity).toEqual({ inode: stat.ino.toString(), size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(),
      sha256: createHash('sha256').update(readFileSync(queuePath(h.stateDir))).digest('hex') })
    const reads = h.sealIo.queueReads().filter(c => c.op === 'readSync')
    expect(reads.length).toBeGreaterThan(3)
    expect(reads.every(c => c.length! < Number(identity.size))).toBe(true)
    expect(h.sealIo.calls.some(c => c.op === 'readFileSync' && c.path === queuePath(h.stateDir))).toBe(false)
    const failure = h.sealIo.fail('readSync', 'alpha', { match: p => p === queuePath(h.stateDir) })
    expect(() => h.seal.queueIdentity('alpha')).toThrow(failure)
    expect(h.sealIo.calls.at(-1)).toEqual({ op: 'closeSync', path: queuePath(h.stateDir) })
    h.sealIo.heal(); writeFileSync(queuePath(h.stateDir), Buffer.alloc(0))
    expect(queueIdentitiesMatch(absent, h.seal.queueIdentity('alpha'))).toBe(false)
  })

  test("an observer of the seal's queue-journal openings changes nothing it reads or hashes, even when it throws; an absent journal notifies nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-memory-')); threadDirs.push(dir)
    seedQueue(dir, [acceptedRecord(1, slackInput(), THREAD_TIME)])
    function identify(key: string, observer?: (key: string) => void) {
      const io = threadSealFsControls(dir)
      const seal = createThreadMemorySeal({ stateDir: dir, fs: io.fs, queueJournalPath: k => queuePath(dir, k), appliedKeys: () => [],
        threadHybrid: () => false, created: () => false, ...(observer ? { onQueueJournalOpened: observer } : {}) })
      return { identity: seal.queueIdentity(key), reads: io.queueReads() }
    }
    const plain = identify('alpha'), opened: string[] = []
    expect(identify('alpha', key => { opened.push(key) })).toEqual(plain)
    expect(identify('alpha', () => { throw new Error('fixture observer failed') })).toEqual(plain)
    expect(identify('beta', key => { opened.push(key) }).identity).toEqual({ size: '0', sha256: createHash('sha256').digest('hex') })
    expect(opened).toEqual(['alpha'])
  })
})

describe('Thread Memory seal startup and restart', () => {
  // 'unreadable queue': the journal is readable, but the seal can't read the queue
  // journal at shutdown, so the entry stays running with its store identity.
  test.each((['unreadable', 'incomplete', 'unreadable queue'] as const).flatMap(journal =>
    (['graceful-joins', 'graceful-empty', 'crash-joins'] as const).map(stop => [journal, stop] as const)))(
    'Decision 6: %s journal, %s preserves only known shutdown losses beside unclean-stop', async (journal, stop) => {
      const h = await ownPostFixture({ start: false })
      if (journal === 'incomplete') h.io.fail('writeSync')
      await h.start()
      if (journal === 'unreadable') {
        expect(h.memory.completedStores().has('alpha')).toBe(true)
        expect(readThreads(h.stateDir)[0]?.kind).toBe('header')
        h.memory.forget('alpha'); h.io.fail('readFileSync'); await h.memory.loadKey('alpha')
        expect(h.memory.outage('alpha').unknown).toBe(true)
      }
      if (journal === 'unreadable queue') { await h.queue.accept('alpha', slackInput()); h.io.fail('writeSync') }
      expect(h.memory.completedStores().has('alpha')).toBe(journal === 'unreadable queue')
      const threads = [{ channel: C.primary, root: R.primary }, { channel: C.primary, root: R.secondary }]
      if (stop !== 'graceful-empty') {
        for (const { root } of [...threads].reverse()) await confirmPost(h, beginPost(h), root)
        expect(h.owner.memoryOnlyJoins('alpha')).toHaveLength(threads.length)
      } else expect(h.owner.memoryOnlyJoins('alpha')).toEqual([])
      const beforeStop = readFileSync(threadSealPath(h.stateDir)), identity = h.memory.completedStores().get('alpha') ?? {}
      h.threads.sealIo!.reset()
      const cause = journal === 'unreadable queue'
        ? h.threads.sealIo!.fail('openSync', 'alpha', { match: p => p === queuePath(h.stateDir) }) : undefined
      if (stop === 'crash-joins') { h.owner.stop(); await h.threads.crash() } else await h.close()
      const entry = sealEntry(h.threads)
      if (stop === 'graceful-joins') {
        expect(entry).toEqual({ ...identity, clean: false, gracefulShutdown: true, memoryOnlyJoins: threads })
      } else if (stop === 'graceful-empty') expect(entry).toEqual({ ...identity, clean: false })
      else {
        expect(readFileSync(threadSealPath(h.stateDir))).toEqual(beforeStop)
        expect(entry.clean).toBe(false)
        expect(entry.memoryOnlyJoins).toBeUndefined()
        expect(entry).not.toHaveProperty('gracefulShutdown')
      }
      // An uncertified journal cannot supply either identity or a queue digest; a
      // certified one's graceful stop tries the queue once, and that failure is still reported.
      const queueRead = journal === 'unreadable queue' && stop !== 'crash-joins'
      expect(h.threads.sealIo!.queueReads()).toEqual(queueRead ? [{ op: 'openSync', path: queuePath(h.stateDir), flags: 'r' }] : [])
      expect(h.threads.sealEvents.filter(e => e.type === 'queue-identity-failed'))
        .toEqual(queueRead ? [{ type: 'queue-identity-failed', key: 'alpha', phase: 'shutdown', error: cause }] : [])
      assertNoLeak(readFileSync(threadSealPath(h.stateDir), 'utf8'))
      const next = reportingFixture({ reopen: true }, h.stateDir); await next.start()
      const loss: ThreadMemoryLoss = { threads, messages: [] }
      const changed = { key: 'alpha', case: 'unclean-stop', wording: 'unclean' } as const
      const hasLoss = stop === 'graceful-joins'
      expect(next.seal.startupFindings()).toEqual([
        ...(hasLoss ? [{ key: 'alpha', case: 'own-post-joins-lost' as const, threads }] : []), changed,
      ])
      expect(next.posts).toEqual([
        ...(hasLoss ? [lossNotice(next, loss)] : []),
        notice(next, ref => buildThreadMemoryChangedWhileStoppedNotice(ref, [C.primary], 'unclean')),
      ])
      expect(next.logs).toEqual([
        ...(hasLoss ? [buildThreadMemoryJoinsLostLine(next.authority.config().personas[0]!, loss)] : []),
        buildThreadMemoryChangedWhileStoppedLine('alpha', [C.primary], 'unclean-stop', 'unclean'),
      ])
      if (hasLoss) for (const { channel, root } of threads) {
        expect(next.posts[0]!.text).toContain(channel); expect(next.posts[0]!.text).toContain(root)
      }
      expect(next.sealEvents.some(e => e.type === 'seal-invalid')).toBe(false)
      const posts = [...next.posts], logs = [...next.logs]
      for (const event of next.sealEvents) next.reporting.sealEvent(event)
      expect(next.posts).toEqual(posts); expect(next.logs).toEqual(logs)
      expect(sealedJoins(next)).toBeUndefined()
      expect(sealEntry(next)).not.toHaveProperty('gracefulShutdown')
      await next.close()
      const last = reportingFixture({ reopen: true }, h.stateDir); await last.start()
      expect(last.seal.startupFindings()).toEqual([])
      expect(last.posts).toEqual([]); expect(last.logs).toEqual([])
    })

  test.each([false, true])('own-post shutdown lists only unsaved joins in canonical order; reverse=%s', async reverse => {
    const h = await ownPostFixture({ membership: { names: ['alpha', 'beta'], channels: joinedChannels } })
    h.io.fail('writeSync')
    const threads = [{ channel: C.primary, root: R.primary }, { channel: C.primary, root: R.third }, { channel: C.secondary, root: R.secondary }]
    for (const { channel, root } of reverse ? [...threads].reverse() : threads) await confirmPost(h, beginPost(h, 'text', channel), root, channel)
    expect(h.owner.memoryOnlyJoins('alpha')).toHaveLength(threads.length)
    expect(sealedJoins(h.threads)).toBeUndefined()
    await h.close()
    expect(sealEntry(h.threads).clean).toBe(true)
    expect(sealedJoins(h.threads)).toEqual(threads)
    expect(sealedJoins(h.threads, 'beta')).toBeUndefined()
    const bytes = readFileSync(threadSealPath(h.stateDir), 'utf8')
    assertNoLeak(bytes)
    for (const forbidden of ['stamp', 'digest', 'text', 'noticeOnly']) expect(bytes).not.toContain(forbidden)
    const next = reportingFixture({ reopen: true }, h.stateDir); await next.start()
    const loss: ThreadMemoryLoss = { threads, messages: [] }
    expect(next.seal.startupFindings()).toEqual([{ key: 'alpha', case: 'own-post-joins-lost', threads }])
    expect(next.posts).toEqual([lossNotice(next, loss)])
    expect(next.logs).toEqual([buildThreadMemoryJoinsLostLine(next.authority.config().personas[0]!, loss)])
    expect(sealedJoins(next)).toBeUndefined()
    await next.close()
    const last = reportingFixture({ reopen: true }, h.stateDir); await last.start()
    expect(last.seal.startupFindings()).toEqual([]); expect(last.posts).toEqual([])
  })

  test.each(['saved-intent', 'saved-join', 'stale', 'crash', 'incomplete'] as const)('own-post %s shutdown list follows intent durability and graceful-stop evidence', async mode => {
    const h = await ownPostFixture(mode === 'incomplete' ? { start: false } : {})
    if (mode === 'incomplete') { h.io.fail('writeSync'); await h.start() }
    if (mode !== 'saved-intent') h.io.fail('writeSync')
    const post = beginPost(h); await post.ready
    if (mode === 'saved-intent') h.io.fail('writeSync')
    await confirmPost(h, post)
    if (mode === 'saved-join') { h.io.heal(); await h.memory.flush('alpha') }
    if (mode === 'stale') expect(h.threads.choose('off').kind).toBe('applied')
    if (mode === 'crash') { h.owner.stop(); await h.threads.crash() } else await h.close()
    expect(sealedJoins(h.threads)).toEqual(mode === 'incomplete' ? [{ channel: C.primary, root: R.primary }] : undefined)
    expect(sealEntry(h.threads).clean).toBe(mode !== 'crash' && mode !== 'incomplete')
  })

  test.each(['current-then-undecided', 'deferred-membership', 'deferred-stamp', 'started-undecided', 'deferred-saved-intent'] as const)(
    'own-post shutdown preserves the %s reader after owner stop and store quiescence', async mode => {
      const h = await ownPostFixture()
      if (mode !== 'deferred-saved-intent') h.io.fail('writeSync')
      if (mode === 'started-undecided') undecideOwnPosts(h)
      const post = beginPost(h); await post.ready
      if (mode === 'deferred-membership' || mode === 'deferred-saved-intent') h.members.membership.invalidate('alpha')
      if (mode === 'deferred-stamp') undecideOwnPosts(h)
      await confirmPost(h, post)
      if (mode === 'current-then-undecided') undecideOwnPosts(h)
      const expected = mode === 'deferred-saved-intent' ? [] : [{ channel: C.primary, root: R.primary }]
      expect(h.owner.memoryOnlyJoins('alpha')).toEqual(expected)
      h.owner.stop(); await h.memory.quiesce()
      expect(h.owner.memoryOnlyJoins('alpha')).toEqual(expected)
      await h.close()
      expect(sealedJoins(h.threads) ?? []).toEqual(expected)
    })

  test('own-post sealed loss coexists with a deleted-journal finding without duplicate startup reporting', async () => {
    const h = await ownPostFixture(); h.io.fail('writeSync')
    await confirmPost(h, beginPost(h)); await h.close(); h.io.removeJournal()
    const next = reportingFixture({ reopen: true }, h.stateDir); await next.start()
    expect(next.seal.startupFindings()).toEqual([
      { key: 'alpha', case: 'own-post-joins-lost', threads: [{ channel: C.primary, root: R.primary }] },
      { key: 'alpha', case: 'journal-missing', wording: 'changed' },
    ])
    expect(next.posts).toEqual([
      lossNotice(next, { threads: [{ channel: C.primary, root: R.primary }], messages: [] }),
      notice(next, ref => buildThreadMemoryChangedWhileStoppedNotice(ref, [C.primary], 'changed')),
    ])
    expect(next.sealEvents.filter(e => e.type === 'own-post-joins-lost')).toHaveLength(1)
  })

  test.each(['unapplied', 'unreadable', 'invalid'] as const)('own-post sealed loss ignores %s evidence', async mode => {
    const h = sealFixture(mode === 'unapplied' ? { appliedKeys: () => [] } : {})
    seedThreads(h.stateDir, [threadHeader()])
    seedThreadSeal(h.stateDir, { alpha: cleanOwnPostSealEntry(h.stateDir, [{ channel: C.primary, root: R.primary }]) })
    if (mode === 'unreadable') h.sealIo.failRead()
    if (mode === 'invalid') writeFileSync(threadSealPath(h.stateDir), damagedThreadSeal(h.stateDir, 'duplicate-own-post'))
    await h.start()
    expect(h.seal.startupFindings().filter(f => f.case === 'own-post-joins-lost')).toEqual([])
    expect(h.sealEvents.filter(e => e.type === 'own-post-joins-lost')).toEqual([])
  })

  test('own-post startup report bounds the post with an exact remainder and logs all sealed threads', async () => {
    const h = await ownPostFixture(); h.io.fail('writeSync')
    const threads = Array.from({ length: Math.ceil(THREAD_MEMORY_NOTICE_MAX_CHARS / R.primary.length) }, (_, i) =>
      ({ channel: C.primary, root: slackTsOfMs(THREAD_TIME + i) }))
    for (const thread of threads) await confirmPost(h, beginPost(h), thread.root)
    await h.close()
    const next = reportingFixture({ reopen: true }, h.stateDir); await next.start()
    expect(next.posts).toHaveLength(1); expect(next.logs).toHaveLength(1)
    const text = next.posts[0]!.text, visible = threads.filter(t => text.includes(t.root))
    expect(text.length).toBeLessThanOrEqual(THREAD_MEMORY_NOTICE_MAX_CHARS)
    expect(visible.length).toBeGreaterThan(0); expect(visible.length).toBeLessThan(threads.length)
    expect(text).toContain(`${threads.length - visible.length} more thread/message entry(s)`)
    for (const thread of threads) expect(next.logs[0]).toContain(`channel=${thread.channel} root=${thread.root}`)
    assertNoLeak({ posts: next.posts, logs: next.logs })
  })

  test.each([
    ['missing journal', 'journal-missing'], ['different store', 'journal-changed'], ['older journal', 'journal-changed'],
    ['missing entry', 'entry-missing'], ['missing entry and journal', 'hybrid-without-store'],
    ['marker only', 'marker-without-store'], ['other release queue rewrite', 'queue-changed'],
  ] as const)('%s produces one typed finding without changing the other persona', async (change, reason) => {
    const h = sealFixture(); h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])); await h.start()
    await h.memory.saveJoins('alpha', [h.fact()]); const earlier = journalBytes(h)
    await h.memory.saveJoins('alpha', [h.fact({ root: R.secondary })]); await queueTraffic(h)
    await h.close()
    if (change === 'missing journal') rmSync(threadPath(h.stateDir))
    if (change === 'different store') seedThreads(h.stateDir, [threadHeader({ storeId: 'other-store' })])
    if (change === 'older journal') writeFileSync(threadPath(h.stateDir), earlier)
    if (change === 'missing entry') {
      // Preserve beta's evidence to isolate the missing-entry case to alpha.
      seedThreadSeal(h.stateDir, { beta: sealEntry(h, 'beta') })
    }
    if (change === 'missing entry and journal') { seedThreadSeal(h.stateDir, { beta: sealEntry(h, 'beta') }); rmSync(threadPath(h.stateDir)) }
    if (change === 'marker only') {
      // The seal is still present for beta, but alpha has no hybrid entry.
      seedThreadSeal(h.stateDir, { beta: sealEntry(h, 'beta') }); rmSync(threadPath(h.stateDir)); h.choose('mentions')
    }
    if (change === 'other release queue rewrite') { const queue = await makeQueue(h.stateDir); await queue.stop() }
    const next = sealFixture({ reopen: true }, h.stateDir); await next.start()
    expectSealFinding(next, reason)
    next.seal.judgeAtStart(next.memory.journalFacts()); await next.memory.loadKey('alpha')
    expectSealFinding(next, reason)
    const snapshot = next.seal.startupFindings(); snapshot[0]!.key = 'mutated-snapshot'
    expect(next.seal.startupFindings()[0]!.key).toBe('alpha')
  })

  test.each(['threads', 'seal', 'both'] as const)('deleting the complete %s path after a clean stop is detected', async removed => {
    const h = sealFixture(); await h.start(); await h.close()
    if (removed !== 'seal') rmSync(join(h.stateDir, 'threads'), { recursive: true })
    if (removed !== 'threads') rmSync(threadSealPath(h.stateDir))
    const next = sealFixture({ reopen: true }, h.stateDir); await next.start()
    expectSealFinding(next, removed === 'both' ? 'marker-without-store' : removed === 'threads' ? 'journal-missing' : 'entry-missing')
  })

  test('abandoning a run leaves running entries, and unclean wins over a missing journal and changed queue', async () => {
    const h = sealFixture(); await h.start(); await queueTraffic(h); await h.crash()
    expect(sealEntry(h).clean).toBe(false)
    rmSync(threadPath(h.stateDir)); const queue = await makeQueue(h.stateDir); await queue.stop()
    const next = sealFixture({ reopen: true }, h.stateDir); await next.start()
    expectSealFinding(next, 'unclean-stop', 'unclean')
  })

  test('a new hybrid entry after an unclean stop uses unclean wording from another running entry', async () => {
    const h = sealFixture(); h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])); h.choose('mentions')
    await h.start(); await h.crash(); h.choose('thread_hybrid')
    const next = sealFixture({ reopen: true }, h.stateDir); await next.start()
    expect(next.seal.startupFindings()).toEqual([
      { key: 'alpha', case: 'hybrid-without-store', wording: 'unclean' },
      { key: 'beta', case: 'unclean-stop', wording: 'unclean' },
    ])
  })

  test('first start, missing queue, and consecutive clean restarts with real queue traffic give no finding', async () => {
    let h = sealFixture(); await h.start(); expectSealFinding(h)
    await h.close(); expect(sealEntry(h)).toMatchObject({ clean: true, queue: { size: '0' } })
    expect(existsSync(queuePath(h.stateDir))).toBe(false)
    for (let round = 0; round < 3; round++) {
      h = sealFixture({ reopen: true }, h.stateDir); await h.start(); expectSealFinding(h)
      const input = slackInput({ key: { chat_id: C.primary, ts: `1700000000.00000${round + 1}` } })
      expect((await h.queue.accept('alpha', input)).status).toBe('accepted')
      await h.memory.saveJoins('alpha', [h.fact({ root: R.secondary })]); await h.close()
      const entry = sealEntry(h)
      expect(entry).toEqual({ ...h.memory.completedStores().get('alpha')!, clean: true, queue: h.seal.queueIdentity('alpha') })
    }
  })

  test.each(['move', 'copy'] as const)('whole-directory %s preserves joins and judges the queue inode', async mode => {
    const h = sealFixture(); await h.start(); await h.memory.saveJoins('alpha', [h.fact()]); await queueTraffic(h); await h.close()
    const before = h.seal.queueIdentity('alpha'), aside = `${h.stateDir}-aside`; threadDirs.push(aside)
    renameSync(h.stateDir, aside)
    if (mode === 'move') renameSync(aside, h.stateDir)
    else cpSync(aside, h.stateDir, { recursive: true, preserveTimestamps: true })
    const next = sealFixture({ reopen: true }, h.stateDir)
    expect(next.seal.queueIdentity('alpha').inode === before.inode).toBe(mode === 'move')
    await next.start(); expect(view(next)).toBe('joined'); expectSealFinding(next, mode === 'move' ? undefined : 'queue-changed')
  })

  test('start writes running entries and captures only previous clean queues before replay rewrites them', async () => {
    const h = sealFixture(); h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])); await h.start()
    await queueTraffic(h); await queueTraffic(h, 'beta'); await h.close()
    const old = sealEntry(h), beta = runningSealEntry(sealEntry(h, 'beta'))
    seedThreadSeal(h.stateDir, { alpha: old, beta })
    const next = sealFixture({ reopen: true }, h.stateDir)
    next.memory.readAtStart(); await next.seal.loadAtStart(next.memory.journalFacts())
    expect(readThreadSeal(h.stateDir).entries).toEqual({ alpha: runningSealEntry(old), beta })
    expect(next.sealIo.queueReads().filter(c => c.op === 'openSync').map(c => c.path)).toEqual([queuePath(h.stateDir)])
    expect(next.seal.queueIdentity('alpha')).toEqual(old.queue!)
    await next.queue.start()
    expect(next.seal.queueIdentity('alpha')).not.toEqual(old.queue!)
    await next.memory.activate()
    expect(next.seal.startupFindings()).toEqual([{ key: 'beta', case: 'unclean-stop', wording: 'unclean' }])
  })

  test.each([
    ['succeeds', ['journal']],
    ['also fails before its rename', ['journal', 'queue']],
  ] as const)("the seal's read is a queue journal's first opening: when the earlier start compaction %s, the later journal's first append syncs %j", async (earlier, expected) => {
    // Start compacts the queue journals one at a time; the later one's rewrite always fails before its rename.
    let temps = 0, later = ''
    const rewrites = durableIo({ before(step) {
      if (step.op !== 'fsync' || !step.path.endsWith('.tmp') || (++temps === 1 && earlier === 'succeeds')) return
      later = basename(step.path).split('.')[0]!
      throw new Error('fixture temp sync refused')
    } })
    const h = sealFixture({ queueOptions: { fs: rewrites.fs } })
    h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta']))
    for (const key of ['alpha', 'beta']) { seedQueue(h.stateDir, [acceptedRecord(1, slackInput(), THREAD_TIME)], key); seedReadable(h, [], key) }
    await h.start()
    expect(h.sealIo.queueReads().filter(c => c.op === 'openSync').map(c => c.path).sort()).toEqual([queuePath(h.stateDir), queuePath(h.stateDir, 'beta')])
    expect(temps).toBe(2)
    expectSealFinding(h)
    const from = h.queueIo.steps.length
    expect((await h.queue.accept(later, injectedInput())).status).toBe('accepted')
    expect(h.queueIo.steps.slice(from).filter(step => step.op === 'fsync').map(({ path }) =>
      path === join(h.stateDir, 'queue') ? 'queue' : path === queuePath(h.stateDir, later) ? 'journal' : path)).toEqual([...expected])
  })

  test.each(['json', 'version', 'persona-key', 'missing-queue', 'read-failure'] as const)('%s seal is reported, treated as empty and replaced with valid running entries', async damage => {
    const h = sealFixture(); await h.start(); await h.close()
    const next = sealFixture({ reopen: true }, h.stateDir)
    const cause = damage === 'read-failure' ? next.sealIo.failRead() : undefined
    if (damage !== 'read-failure') writeFileSync(threadSealPath(h.stateDir), damagedThreadSeal(h.stateDir, damage))
    await next.start()
    const failure = next.sealEvents.find(e => e.type === (cause ? 'seal-read-failed' : 'seal-invalid'))
    expect(failure).toMatchObject({ path: threadSealPath(h.stateDir), error: cause ?? expect.any(Error) })
    expectSealFinding(next, 'entry-missing')
    expect(sealEntry(next)).toEqual(runningSealEntry(next.memory.completedStores().get('alpha')))
  })

  test('an unreadable seal path retains its cause and retries after the path is repaired', async () => {
    const h = sealFixture(); await h.start(); await h.close()
    rmSync(threadSealPath(h.stateDir)); mkdirSync(threadSealPath(h.stateDir))
    const next = sealFixture({ reopen: true }, h.stateDir); await next.start()
    expect(next.sealEvents).toContainEqual({ type: 'seal-read-failed', path: threadSealPath(h.stateDir), error: expect.objectContaining({ code: 'EISDIR' }) })
    expectSealFinding(next, 'entry-missing')
    rmSync(threadSealPath(h.stateDir), { recursive: true }); expect(await next.seal.flush()).toEqual({ kind: 'written' })
    expect(sealEntry(next).clean).toBe(false)
  })

  test.each(['older', 'other-store', 'matching'] as const)('unreadable startup journal defers %s identity judgment until its first successful read', async kind => {
    const h = sealFixture(); await h.start(); const older = journalBytes(h)
    await h.memory.saveJoins('alpha', [h.fact()]); await h.close(); const previous = sealEntry(h)
    if (kind === 'older') writeFileSync(threadPath(h.stateDir), older)
    if (kind === 'other-store') seedThreads(h.stateDir, [threadHeader({ storeId: 'other-store' })])
    const next = sealFixture({ reopen: true }, h.stateDir); next.io.fail('readFileSync'); await next.start()
    expectSealFinding(next); expect(sealEntry(next)).toEqual(runningSealEntry(previous))
    expect(view(next)).toBe('unknown')
    next.io.heal(); await next.memory.loadKey('alpha')
    expectSealFinding(next, kind === 'matching' ? undefined : 'journal-changed')
    await next.memory.loadKey('alpha'); expect(next.seal.startupFindings()).toHaveLength(kind === 'matching' ? 0 : 1)
  })

  test.each([false, true])('empty sealed journal is reported once before recreation (delayed first read=%s)', async delayedRead => {
    const h = sealFixture(); await h.start(); const fact = h.fact()
    await h.memory.saveJoins('alpha', [fact]); expectOnlySavedJoin(h, fact)
    await h.close(); const previous = sealEntry(h)
    expect(previous.clean).toBe(true)
    seedThreads(h.stateDir, [])
    const sizesAtFinding: number[] = []
    const next = sealFixture({ reopen: true, seal: { onEvent(event) {
      if (event.type === 'changed-while-stopped') sizesAtFinding.push(journalBytes(h).length)
    } } }, h.stateDir)
    if (delayedRead) next.io.fail('readFileSync')
    await next.start()
    if (delayedRead) {
      expect(view(next)).toBe('unknown'); expectSealFinding(next)
      expect(sealEntry(next)).toEqual(runningSealEntry(previous))
      expect(next.markerCalls).toEqual([])
      next.io.heal(); await next.memory.loadKey('alpha')
    }
    expectSealFinding(next, 'journal-missing')
    expect(sizesAtFinding).toEqual([0])
    const records = readThreads(h.stateDir), store = next.memory.store('alpha')!
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ kind: 'header', storeId: store.storeId })
    expect(store.storeId).not.toBe(previous.storeId)
    expect(next.memory.completedStores().get('alpha')?.storeId).toBe(store.storeId)
    expect(view(next)).toBe('not-joined')
    expect(next.memory.isJoinSaved('alpha', fact)).toBe(false)
    await next.memory.loadKey('alpha')
    next.memory.forget('alpha'); await next.memory.loadKey('alpha')
    expectSealFinding(next, 'journal-missing'); expect(sizesAtFinding).toEqual([0])
  })

  test('unreadable startup journal keeps missing-file retries unknown until an empty file returns', async () => {
    const h = sealFixture(); await h.start(); await h.memory.saveJoins('alpha', [h.fact()]); await h.close()
    const previous = sealEntry(h), next = sealFixture({ reopen: true }, h.stateDir)
    const cause = next.io.fail('readFileSync'); await next.start(); next.io.reset()
    await next.memory.loadKey('alpha')
    expect(next.memory.readFacts('alpha').error).toBe(cause)
    expect(view(next)).toBe('unknown'); expectSealFinding(next)
    next.io.heal(); rmSync(threadPath(h.stateDir))
    for (let retry = 0; retry < 2; retry++) {
      await next.memory.loadKey('alpha')
      expect(next.memory.readFacts('alpha').error).toMatchObject({ code: 'ENOENT' })
      expect(view(next)).toBe('unknown'); expectSealFinding(next)
      expect(existsSync(threadPath(h.stateDir))).toBe(false)
    }
    expect(next.io.writes()).toEqual([]); expect(next.markerCalls).toEqual([])
    expect(sealEntry(next)).toEqual(runningSealEntry(previous))
    seedThreads(h.stateDir, []); await next.memory.loadKey('alpha')
    expectSealFinding(next, 'journal-missing')
    expect(view(next)).toBe('not-joined')
    expect(readThreads(h.stateDir)[0]).toMatchObject({ kind: 'header', storeId: next.memory.store('alpha')!.storeId })
    expect(next.memory.store('alpha')!.storeId).not.toBe(previous.storeId)
  })

  test('delayed empty read keeps the sole unclean-stop finding while recreating the journal', async () => {
    const h = sealFixture(); await h.start(); await h.memory.saveJoins('alpha', [h.fact()]); await h.crash()
    const previous = sealEntry(h); expect(previous.clean).toBe(false)
    seedThreads(h.stateDir, [])
    const next = sealFixture({ reopen: true }, h.stateDir); next.io.fail('readFileSync'); await next.start()
    expect(view(next)).toBe('unknown'); expectSealFinding(next, 'unclean-stop', 'unclean')
    next.io.heal(); await next.memory.loadKey('alpha')
    expect(view(next)).toBe('not-joined')
    expect(next.memory.store('alpha')!.storeId).not.toBe(previous.storeId)
    expectSealFinding(next, 'unclean-stop', 'unclean')
    next.memory.forget('alpha'); await next.memory.loadKey('alpha')
    expectSealFinding(next, 'unclean-stop', 'unclean')
  })

  test('failed directory listing still judges by-path facts before repairs and never recaptures the replayed queue', async () => {
    const h = sealFixture(); await h.start(); await queueTraffic(h); await h.close()
    const next = sealFixture({ reopen: true }, h.stateDir)
    next.io.fail('readdirSync', 'alpha', { match: p => p === join(h.stateDir, 'threads') })
    await next.start(); expectSealFinding(next)
    expect(next.sealIo.queueReads().filter(c => c.op === 'openSync').map(c => c.path)).toEqual([queuePath(h.stateDir)])
    expect(sealEntry(next)).toEqual(runningSealEntry(next.memory.completedStores().get('alpha')))
  })
})

describe('Thread Memory seal creation and durable writer', () => {
  async function loseLastHybridDuringEmptyJournalCreation() {
    let armed = false, switched = false, choice: string | undefined
    const markerProofs: Array<{ header: boolean; runningSealMatches: boolean; fileSynced: boolean; directorySynced: boolean }> = []
    let h!: ReturnType<typeof sealFixture>
    h = sealFixture({ seal: { onEvent(event) {
      // The real seal has landed, but entryCreated's promise has not returned
      // to creation. Change the real authority before header repair resumes.
      if (armed && !switched && event.type === 'seal-written') {
        switched = true; choice = h.choose('off').kind
      }
    } }, setCreated(key) {
      const header = readThreads(h.stateDir, key)[0], entry = sealEntry(h, key)
      const renameAt = h.io.calls.map(call => call.op).lastIndexOf('rename')
      const temporary = h.io.calls[renameAt]?.path
      markerProofs.push({
        header: header?.kind === 'header',
        runningSealMatches: header?.kind === 'header' && entry.storeId === header.storeId && !entry.clean,
        fileSynced: renameAt >= 0 && h.io.calls.slice(0, renameAt).some(call => call.op === 'fsync' && call.path === temporary),
        directorySynced: renameAt >= 0 && h.io.calls.slice(renameAt + 1).some(call => call.op === 'fsync' && call.path === join(h.stateDir, 'threads')),
      })
      return h.authority.setThreadMemoryCreated(key)
    } })
    seedThreads(h.stateDir, [])
    h.memory.readAtStart(); await h.seal.loadAtStart(h.memory.journalFacts())
    expect(h.authority.threadView().threadHybridChannels('alpha')).toEqual([C.primary])
    armed = true; await h.start()
    expect(choice).toBe('applied')
    expect(h.authority.threadView().threadHybridChannels('alpha')).toEqual([])
    expect(h.authority.threadMemoryCreated('alpha')).toBe(false)
    expect(h.markerCalls).toEqual([]); expect(markerProofs).toEqual([])
    expect(journalBytes(h)).toHaveLength(0)
    expect(h.memory.store('alpha')).toMatchObject({ created: false, readable: true })
    expect(h.memory.store('alpha')?.storeId).toBeUndefined()
    expect(h.memory.store('alpha')?.digestKey).toBeUndefined()
    expect(h.memory.completedStores().size).toBe(0)
    expect(sealEntry(h).clean).toBe(false)
    const pending = sealEntry(h)
    if (pending.storeId === undefined) throw new Error('fixture needs the pending creation identity')
    return { h, markerProofs, pending }
  }

  test('CR1: losing the last hybrid during seal await keeps an empty journal incomplete until flush saves its header and join, then restarts cleanly', async () => {
    const { h, markerProofs, pending } = await loseLastHybridDuringEmptyJournalCreation()
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'kept' })
    expect(h.markerCalls).toEqual([]); expect(journalBytes(h)).toHaveLength(0)
    // Isolate the explicit flush retry; the next case keeps publication wired.
    h.unsubscribe(); expect(h.choose('thread_hybrid').kind).toBe('applied')
    const fact = h.fact()
    expect(await h.memory.saveJoins('alpha', [fact])).toEqual({ kind: 'kept' })
    expect(view(h)).toBe('joined'); expect(h.memory.isJoinSaved('alpha', fact)).toBe(false)
    expect(h.memory.completedStores().size).toBe(0); expect(journalBytes(h)).toHaveLength(0)
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(markerProofs).toEqual([{ header: true, runningSealMatches: true, fileSynced: true, directorySynced: true }])
    expect(h.markerCalls.map(c => c.action)).toEqual(['set'])
    expect(h.authority.threadMemoryCreated('alpha')).toBe(true)
    const records = readThreads(h.stateDir), digestKey = h.memory.store('alpha')?.digestKey
    expect(records.map(record => record.kind)).toEqual(['header', 'join'])
    expect(records[0]).toMatchObject({ kind: 'header', storeId: pending.storeId, digestKey })
    expect(digestKey).toMatch(/^[a-f0-9]{64}$/)
    expectOnlySavedJoin(h, fact)
    expect(h.memory.store('alpha')?.created).toBe(true)
    expect(h.memory.completedStores().get('alpha')).toEqual({ storeId: pending.storeId, lastRecordNumber: records[1]!.seq })
    await h.close()
    expect(sealEntry(h)).toMatchObject({ storeId: pending.storeId, clean: true, lastRecordNumber: records[1]!.seq })
    const next = sealFixture({ reopen: true }, h.stateDir); await next.start()
    expectSealFinding(next); expectOnlySavedJoin(next, joinRecord(fact, records[1]!.seq))
    expect(next.authority.threadMemoryCreated('alpha')).toBe(true)
    expect(next.memory.store('alpha')).toMatchObject({ storeId: pending.storeId, digestKey, created: true })
    expect(next.memory.completedStores().get('alpha')?.storeId).toBe(pending.storeId)
  })

  test('CR1: graceful shutdown keeps skipped empty-journal creation running; real hybrid publication after restart completes it', async () => {
    const { h } = await loseLastHybridDuringEmptyJournalCreation()
    await h.close()
    expect(sealEntry(h)).toEqual({ clean: false })
    const next = sealFixture({ reopen: true }, h.stateDir); await next.start()
    expectSealFinding(next, 'unclean-stop', 'unclean')
    expect(next.authority.threadMemoryCreated('alpha')).toBe(false)
    expect(next.memory.completedStores().size).toBe(0)
    expect(journalBytes(next)).toHaveLength(0)
    expect(next.choose('thread_hybrid').kind).toBe('applied')
    // Drain the publication's writer turn without explicitly retrying creation.
    await next.memory.compact('alpha')
    expect(next.authority.threadMemoryCreated('alpha')).toBe(true)
    expect(next.memory.store('alpha')?.created).toBe(true)
    const header = readThreads(next.stateDir)[0]!
    expect(header.kind).toBe('header')
    expect(header).toMatchObject({ storeId: next.memory.completedStores().get('alpha')?.storeId })
    expect(next.memory.completedStores().has('alpha')).toBe(true)
    await next.close(); expect(sealEntry(next).clean).toBe(true)
    const clean = sealFixture({ reopen: true }, h.stateDir); await clean.start()
    expectSealFinding(clean); expect(clean.memory.completedStores().has('alpha')).toBe(true)
  })

  test('CR1: a renamed but unsynced header on empty-journal retry cannot save the marker or complete the store', async () => {
    const { h, markerProofs, pending } = await loseLastHybridDuringEmptyJournalCreation()
    h.unsubscribe(); expect(h.choose('thread_hybrid').kind).toBe('applied')
    const fact = h.fact()
    expect(await h.memory.saveJoins('alpha', [fact])).toEqual({ kind: 'kept' })
    const cause = h.io.fail('fsync', 'alpha', { match: path => path === join(h.stateDir, 'threads') })
    const result = await h.memory.flush('alpha')
    expect(result).toEqual({ kind: 'failed', error: cause })
    expect(h.events).toContainEqual({ type: 'compaction-failed', key: 'alpha', path: threadPath(h.stateDir), step: 'journal-rewrite', error: cause })
    expect(readThreads(h.stateDir)).toEqual([expect.objectContaining({ kind: 'header', storeId: pending.storeId })])
    expect(h.memory.store('alpha')?.storeId).toBeUndefined()
    expect(h.memory.store('alpha')?.created).toBe(false)
    expect(h.authority.threadMemoryCreated('alpha')).toBe(false)
    expect(h.markerCalls).toEqual([]); expect(markerProofs).toEqual([])
    expect(h.memory.completedStores().size).toBe(0)
    expect(view(h)).toBe('joined'); expect(h.memory.isJoinSaved('alpha', fact)).toBe(false)
    h.io.heal(); h.io.reset()
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(markerProofs).toEqual([{ header: true, runningSealMatches: true, fileSynced: true, directorySynced: true }])
    expect(h.authority.threadMemoryCreated('alpha')).toBe(true)
    expect(h.memory.completedStores().get('alpha')?.storeId).toBe(pending.storeId)
    expect(readThreads(h.stateDir).map(record => record.kind)).toEqual(['header', 'join'])
    expectOnlySavedJoin(h, fact)
  })

  test.each(['activation', 'publication'] as const)('%s creates the running seal before the journal and the durable journal before the marker', async when => {
    const observed: Array<{ step: string; journal: boolean; marker: boolean; entry: ThreadMemorySealEntry }> = []
    const h = sealFixture({ seal: { onEvent(event) {
      if (event.type === 'seal-written') observed.push({ step: 'seal', journal: existsSync(threadPath(h.stateDir)),
        marker: h.authority.threadMemoryCreated('alpha'), entry: sealEntry(h) })
    } }, setCreated(key) {
      observed.push({ step: 'marker', journal: existsSync(threadPath(h.stateDir)), marker: h.authority.threadMemoryCreated(key), entry: sealEntry(h) })
      return h.authority.setThreadMemoryCreated(key)
    } })
    if (when === 'publication') h.choose('mentions')
    await h.start()
    if (when === 'publication') { h.choose('thread_hybrid'); await h.memory.flush('alpha') }
    const header = readThreads(h.stateDir)[0]!
    expect(observed).toEqual([
      { step: 'seal', journal: false, marker: false, entry: runningSealEntry({ storeId: 'storeId' in header ? header.storeId : '', lastRecordNumber: header.seq }) },
      { step: 'marker', journal: true, marker: false, entry: sealEntry(h) },
    ])
    expect(h.markerCalls).toEqual([{ action: 'set', key: 'alpha', fileExists: true, synced: true }])
    expect(h.authority.threadMemoryCreated('alpha')).toBe(true)
  })

  test.each([false, true])('failed creation seal (unsynced=%s) keeps joins, permits another persona and queue delivery, then resumes in order', async unsynced => {
    const h = sealFixture(); h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])); h.choose('mentions')
    await h.start(); h.sealIo.failWrite(unsynced)
    h.choose('thread_hybrid'); await h.memory.flush('alpha')
    const fact = h.fact(); expect(h.memory.addJoin('alpha', fact)).toBe(true)
    expect(view(h)).toBe('joined'); expect(h.memory.isJoinSaved('alpha', fact)).toBe(false)
    expect(existsSync(threadPath(h.stateDir))).toBe(false); expect(h.authority.threadMemoryCreated('alpha')).toBe(false)
    expect(h.markerCalls.map(c => c.key)).toEqual(['beta'])
    expect(h.sealEvents).toContainEqual({ type: 'seal-write-failed', path: threadSealPath(h.stateDir), error: expect.any(Error), unsynced })
    const firstId = unsynced ? sealEntry(h).storeId : undefined
    await h.memory.saveJoins('beta', [h.fact({}, 'beta')]); await h.memory.compact('beta')
    expect(view(h, R.primary, 'beta')).toBe('joined'); expect(savedJoins(h, 'beta')).toHaveLength(1)
    await queueTraffic(h); await queueTraffic(h, 'beta')
    expect(h.memory.store('alpha')?.created).toBe(false)
    h.sealIo.heal(); h.io.reset()
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expectOnlySavedJoin(h, fact)
    expect(h.markerCalls.at(-1)).toEqual({ action: 'set', key: 'alpha', fileExists: true, synced: true })
    expect(sealEntry(h).storeId).toBe(h.memory.store('alpha')!.storeId!)
    if (firstId) expect(sealEntry(h).storeId).toBe(firstId)
  })

  test.each((['seal', 'journal'] as const).flatMap(step => (['crash', 'graceful'] as const).map(stop => [step, stop] as const)))('%s boundary followed by %s keeps incomplete creation running and reports unclean on restart', async (step, stop) => {
    let interrupt = false, interrupted: Promise<void> | undefined
    const h = sealFixture({ seal: { onEvent(event) {
      if (interrupt && step === 'seal' && event.type === 'seal-written') interrupted ??= h.memory.quiesce()
    } }, setCreated(key) {
      if (interrupt && step === 'journal' && key === 'alpha') {
        interrupted ??= h.memory.quiesce()
        return { kind: 'failed', error: new Error('fixture stopped before marker') }
      }
      return h.authority.setThreadMemoryCreated(key)
    } })
    h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])); h.choose('mentions'); await h.start()
    expect(h.memory.store('beta')?.created).toBe(true)
    interrupt = true; h.choose('thread_hybrid'); await h.clock.flush(); await interrupted
    expect(interrupted).toBeDefined()
    expect(existsSync(threadPath(h.stateDir))).toBe(step === 'journal')
    expect(h.authority.threadMemoryCreated('alpha')).toBe(false)
    if (stop === 'crash') await h.crash(); else await h.close()
    expect(sealEntry(h).clean).toBe(false); expect(sealEntry(h, 'beta').clean).toBe(stop === 'graceful')
    const next = sealFixture({ reopen: true }, h.stateDir); await next.start()
    expect(next.seal.startupFindings()).toEqual([
      { key: 'alpha', case: 'unclean-stop', wording: 'unclean' },
      ...(stop === 'crash' ? [{ key: 'beta', case: 'unclean-stop', wording: 'unclean' } as const] : []),
    ])
  })

  test('startup compaction updates record numbers; a failed seal retries independently while unchanged maintenance skips', async () => {
    const h = sealFixture(); await h.start(); await h.memory.saveJoins('alpha', [h.fact()]); await h.crash()
    const interval = THREAD_MEMORY_RETRY_MIN_MS / 2
    const next = sealFixture({ reopen: true, failureHandling: true, compactIntervalMs: interval }, h.stateDir); await next.start()
    expect(sealEntry(next).lastRecordNumber).toBe(next.memory.store('alpha')!.lastRecordNumber)
    await next.memory.saveJoins('alpha', [next.fact({ root: R.secondary })]); const previous = readFileSync(threadSealPath(h.stateDir))
    next.io.fail('rename'); await next.memory.compact('alpha')
    expect(readFileSync(threadSealPath(h.stateDir))).toEqual(previous)
    next.io.heal(); next.sealIo.failWrite()
    await next.memory.compact('alpha')
    expect(readThreads(h.stateDir)[0]).toMatchObject({ highWater: next.memory.store('alpha')!.lastRecordNumber })
    expect(readFileSync(threadSealPath(h.stateDir))).toEqual(previous)
    expect(next.sealEvents.at(-1)).toMatchObject({ type: 'seal-write-failed', unsynced: false })
    const completed: ThreadMemoryCompaction[] = []
    next.memory.setCompactionObserver(c => completed.push(c))
    next.io.reset(); next.sealIo.reset()
    await next.clock.advance(interval)
    expect(completed.map(c => c.outcome)).toEqual(['skipped'])
    expect(next.io.calls).toEqual([]); expect(next.sealIo.calls).toEqual([])
    expect(readFileSync(threadSealPath(h.stateDir))).toEqual(previous)
    next.sealIo.heal(); await next.clock.advance(interval)
    expect(next.retryEvents).toContainEqual({ type: 'seal-written-after-retries', attempts: 1 })
    expect(completed.map(c => c.outcome)).toEqual(['skipped', 'skipped'])
    expect(next.io.calls).toEqual([])
    expect(sealEntry(next).lastRecordNumber).toBe(next.memory.store('alpha')!.lastRecordNumber)
    expect(savedJoins(next)).toHaveLength(2)
  })

  test('shutdown waits for the queue last write and seals only completed stores at their final record numbers', async () => {
    let acceptanceDuringSeal: Promise<{ status: string }> | undefined
    const h = sealFixture({ seal: { onEvent(event) {
      if (event.type === 'seal-written' && sealEntry(h).clean) {
        acceptanceDuringSeal = h.queue.accept('alpha', slackInput({ key: { chat_id: C.primary, ts: R.secondary } }))
      }
    } } })
    await h.start(); await queueTraffic(h)
    await h.memory.saveJoins('alpha', [h.fact()]); const before = h.seal.queueIdentity('alpha')
    // Queue an admitted compaction without awaiting it. stop() must drain it
    // before the seal samples the identity; the rewrite changes the inode.
    const lastWrite = h.queue.compact('alpha'), stopping = h.close()
    await Promise.all([lastWrite, stopping])
    expect(acceptanceDuringSeal).toBeDefined()
    expect(await acceptanceDuringSeal).toMatchObject({ status: 'failed' })
    const after = h.seal.queueIdentity('alpha')
    expect(after).not.toEqual(before)
    expect(sealEntry(h)).toEqual({ ...h.memory.completedStores().get('alpha')!, clean: true, queue: after })
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'cancelled' })
    expect(h.clock.pendingCount()).toBe(0)
    const next = sealFixture({ reopen: true }, h.stateDir); await next.start(); expectSealFinding(next)
  })

  test.each([false, true])('shared writer coalesces, rewrites the whole file, retains a failed write (unsynced=%s) and refuses writes after stop', async unsynced => {
    const snapshots: Array<Record<string, ThreadMemorySealEntry>> = []
    let later: Promise<unknown> | undefined, reenter = true
    const h = sealFixture({ seal: { onEvent(event) {
      if (event.type !== 'seal-written') return
      snapshots.push(readThreadSeal(h.stateDir).entries)
      if (reenter) { reenter = false; later = h.seal.entryCompacted('alpha', 'alpha-store', 4) }
    } } })
    const a = h.seal.entryCreated('alpha', 'alpha-store', 1), b = h.seal.entryCreated('beta', 'beta-store', 2)
    expect(a).toBe(b)
    await a; await later
    expect(snapshots).toEqual([
      { alpha: runningSealEntry({ storeId: 'alpha-store', lastRecordNumber: 1 }), beta: runningSealEntry({ storeId: 'beta-store', lastRecordNumber: 2 }) },
      { alpha: runningSealEntry({ storeId: 'alpha-store', lastRecordNumber: 4 }), beta: runningSealEntry({ storeId: 'beta-store', lastRecordNumber: 2 }) },
    ])
    // Each durable writer must close/sync its directory before the next temp opens.
    const boundaries = h.sealIo.calls.filter(c => c.op === 'openSync' && c.flags === 'wx' || c.op === 'closeSync' && c.path === h.stateDir)
    expect(boundaries.map(c => c.op)).toEqual(['openSync', 'closeSync', 'openSync', 'closeSync'])
    const before = readFileSync(threadSealPath(h.stateDir)), cause = h.sealIo.failWrite(unsynced)
    const result = await h.seal.entryCompacted('beta', 'beta-store', 7)
    expect(result).toMatchObject({ kind: 'failed', unsynced })
    if (result.kind === 'failed') {
      if (unsynced) { expect(result.error).toBeInstanceOf(DurableWriteUnsyncedError); expect((result.error as DurableWriteUnsyncedError).syncError).toBe(cause) }
      else expect(result.error).toBe(cause)
    }
    expect(readFileSync(threadSealPath(h.stateDir)).equals(before)).toBe(!unsynced)
    h.sealIo.heal(); await h.seal.entryCompacted('alpha', 'alpha-store', 8)
    expect(readThreadSeal(h.stateDir).entries).toEqual({
      alpha: runningSealEntry({ storeId: 'alpha-store', lastRecordNumber: 8 }), beta: runningSealEntry({ storeId: 'beta-store', lastRecordNumber: 7 }),
    })
    await h.seal.stop(); h.sealIo.reset()
    expect(await h.seal.entryCreated('gamma', 'gamma-store', 1)).toEqual({ kind: 'stopped' })
    expect(await h.seal.removeEntry('alpha')).toEqual({ kind: 'stopped' })
    expect(await h.seal.flush()).toEqual({ kind: 'stopped' }); expect(h.sealIo.writes()).toEqual([])
  })

  test('queue identity failures are retained as typed facts, never guessed as changes or sealed clean', async () => {
    const h = sealFixture(); h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])); await h.start()
    await queueTraffic(h); await h.close()
    const next = sealFixture({ reopen: true }, h.stateDir)
    const cause = next.sealIo.fail('openSync', 'alpha', { match: p => p === queuePath(h.stateDir) })
    await next.start(); expectSealFinding(next)
    expect(next.sealEvents).toContainEqual({ type: 'queue-identity-failed', key: 'alpha', phase: 'start', error: cause })
    await next.close()
    expect(sealEntry(next).clean).toBe(false); expect(sealEntry(next, 'beta').clean).toBe(true)
    expect(next.sealEvents).toContainEqual({ type: 'queue-identity-failed', key: 'alpha', phase: 'shutdown', error: cause })
    expect(next.sealEvents.at(-1)).toMatchObject({ type: 'seal-write-failed', error: cause, unsynced: false })
  })
})

describe('Thread Memory seal removal and dry run', () => {
  test('removal unlinks the journal, saves an empty seal, then clears the marker', async () => {
    const observations: Array<{ journal: boolean; entries: unknown; marker: boolean }> = []
    const h = sealFixture({ clearCreated(key) {
      observations.push({ journal: existsSync(threadPath(h.stateDir, key)), entries: readThreadSeal(h.stateDir).entries,
        marker: h.authority.threadMemoryCreated(key) })
      return h.authority.clearThreadMemoryCreated(key)
    } })
    await h.start(); await h.memory.remove('alpha')
    expect(observations).toEqual([{ journal: false, entries: {}, marker: true }])
    expect(readThreadSeal(h.stateDir).entries).toEqual({}); expect(h.authority.threadMemoryCreated('alpha')).toBe(false)
  })

  test.each(['journal-and-marker', 'seal-only'] as const)('unapplied %s evidence is removed without judgment after failed seal removal', async evidence => {
    const h = sealFixture(); await h.start(); h.sealIo.failWrite()
    expect((await h.memory.remove('alpha')).kind).toBe('failed')
    expect(existsSync(threadPath(h.stateDir))).toBe(false); expect(h.authority.threadMemoryCreated('alpha')).toBe(true)
    expect(h.markerCalls.filter(c => c.action === 'clear')).toEqual([])
    await h.crash()
    if (evidence === 'seal-only') h.authority.clearThreadMemoryCreated('alpha')
    const next = sealFixture({ reopen: true, appliedKeys: () => [] }, h.stateDir); await next.start()
    expectSealFinding(next); expect(readThreadSeal(h.stateDir).entries).toEqual({})
    expect(next.authority.threadMemoryCreated('alpha')).toBe(false)
    expect(next.markerCalls).toEqual([{ action: 'clear', key: 'alpha', fileExists: false, synced: false }])
  })

  test('unapplied journals and entries are removed without judging them, and missing-journal evidence is dropped at start', async () => {
    const h = sealFixture(); await h.start(); await h.crash()
    const next = sealFixture({ reopen: true, appliedKeys: () => [] }, h.stateDir); await next.start()
    expectSealFinding(next); expect(existsSync(threadPath(h.stateDir))).toBe(false)
    expect(readThreadSeal(h.stateDir).entries).toEqual({})
    await next.close()
    seedThreadSeal(h.stateDir, { alpha: cleanSealEntry(h.stateDir) })
    const last = sealFixture({ reopen: true }, h.stateDir); last.choose('mentions')
    last.memory.readAtStart(); await last.seal.loadAtStart(last.memory.journalFacts()); await last.queue.start(); await last.memory.activate()
    expectSealFinding(last, 'journal-missing'); expect(readThreadSeal(h.stateDir).entries).toEqual({})
    await last.close()
    const again = sealFixture({ reopen: true }, h.stateDir); await again.start(); expectSealFinding(again)
  })

  test.each(['off', 'mentions', 'all'] as const)('%s with no Thread Memory writes no seal and reads no queue, even with traffic and shutdown', async delivery => {
    const h = sealFixture(); h.choose(delivery); await h.start(); await queueTraffic(h)
    await h.clock.advance(QUEUE_COMPACT_INTERVAL_MS); await h.close()
    expect(existsSync(threadSealPath(h.stateDir))).toBe(false)
    expect(h.sealIo.writes()).toEqual([]); expect(h.sealIo.queueReads()).toEqual([]); expectSealFinding(h)
  })

  test('dry run only seals existing journals at start and shutdown; a new hybrid persona is reported on the next ordinary start', async () => {
    const h = sealFixture(); h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])); h.choose('mentions', 'beta')
    await h.start(); await h.memory.saveJoins('alpha', [h.fact()]); await queueTraffic(h); await h.close()
    const original = journalBytes(h), next = sealFixture({ reopen: true, dryRun: true }, h.stateDir)
    await next.start(); expectSealFinding(next)
    expect(next.sealEvents.filter(e => e.type === 'seal-written')).toHaveLength(1)
    next.sealIo.reset(); next.io.reset()
    next.choose('thread_hybrid', 'beta'); await next.memory.flush('beta')
    await next.memory.compact(); await next.clock.advance(QUEUE_COMPACT_INTERVAL_MS); await next.memory.remove('beta')
    expect(next.sealIo.writes()).toEqual([]); expect(next.io.writes()).toEqual([])
    expect(journalBytes(next)).toEqual(original); expect(existsSync(threadPath(h.stateDir, 'beta'))).toBe(false)
    expect(next.events.filter(e => e.type === 'creation-failed')).toEqual([])
    await next.close()
    expect(next.sealEvents.filter(e => e.type === 'seal-written')).toHaveLength(2)
    expect(Object.keys(readThreadSeal(h.stateDir).entries)).toEqual(['alpha'])
    expect(sealEntry(next).clean).toBe(true)
    const ordinary = sealFixture({ reopen: true }, h.stateDir); await ordinary.start()
    expect(ordinary.seal.startupFindings()).toEqual([{ key: 'beta', case: 'hybrid-without-store', wording: 'changed' }])
    expect(ordinary.memory.store('beta')?.created).toBe(true)
  })
})

describe('Thread Memory authority boundaries', () => {
  test.each(['off', 'mentions', 'all'] as const)('leaving thread_hybrid for %s forgets synchronously without a journal write; switching back and restart cannot revive it', async delivery => {
    const h = fixture()
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha'], [C.primary, C.secondary])).kind).toBe('applied')
    await h.start(); const fact = h.fact(), survivor = h.fact({ channel: C.secondary, root: fact.root })
    await h.memory.saveJoins('alpha', [fact, survivor]); const before = journalBytes(h)
    const atPublication: unknown[] = []
    h.authority.subscribe(() => atPublication.push({ primary: view(h), joins: h.memory.joins('alpha'), saved: h.memory.isJoinSaved('alpha', survivor) }))
    h.io.reset(); expect(h.choose(delivery).kind).toBe('applied')
    expect(atPublication).toEqual([{ primary: 'not-joined', joins: [{ join: survivor, savedAt: survivor.at }], saved: true }])
    expect(h.memory.isJoinSaved('alpha', fact)).toBe(false); expectOnlySavedJoin(h, survivor)
    expect(journalBytes(h)).toEqual(before); expect(h.io.writes()).toEqual([])
    expect(h.choose('thread_hybrid').kind).toBe('applied')
    expect(h.fact().stamp).not.toEqual(fact.stamp); expect(view(h)).toBe('not-joined')
    expect(h.memory.addJoin('alpha', fact)).toBe(false)
    expect(h.io.writes()).toEqual([]); expect(journalBytes(h)).toEqual(before)
    await expectSurvivorAfterCompactionAndRestart(h, survivor)
  })

  test('same-value apply, Channel Mode switches and ordinary restart keep the stamp and joins', async () => {
    const h = fixture(); await h.start(); const fact = h.fact()
    await h.memory.saveJoins('alpha', [fact]); const before = journalBytes(h); h.io.reset()
    expect(h.choose('thread_hybrid').kind).toBe('applied')
    expect(h.mode('open').kind).toBe('applied'); expect(h.mode('strict').kind).toBe('applied')
    expect(h.fact().stamp).toEqual(fact.stamp); expect(view(h)).toBe('joined')
    expect(h.io.writes()).toEqual([]); expect(journalBytes(h)).toEqual(before)
    const reopened = fixture({ reopen: true }, h.stateDir); await reopened.start()
    expect(view(reopened)).toBe('joined'); expect(reopened.fact().stamp).toEqual(fact.stamp)
  })

  test('a missed publication still cannot select, save or merge a stale stamp', async () => {
    const h = fixture(); await h.start(); const old = h.fact()
    await h.memory.saveJoins('alpha', [old]); h.unsubscribe()
    expect(h.choose('mentions').kind).toBe('applied'); expect(h.choose('thread_hybrid').kind).toBe('applied')
    expect(h.memory.joins('alpha')).toHaveLength(1) // Deliberately missed callback; lookup must defend itself.
    expect(view(h)).toBe('not-joined'); expect(h.memory.isJoinSaved('alpha', old)).toBe(false)
    expect(h.memory.addJoin('alpha', old)).toBe(false)
    const unknown = fixture({ reopen: true }, h.stateDir)
    unknown.io.fail('readFileSync'); await unknown.start()
    const kept = unknown.fact({ root: R.secondary }); unknown.memory.addJoin('alpha', kept)
    expect(unknown.choose('all').kind).toBe('applied'); expect(unknown.choose('thread_hybrid').kind).toBe('applied')
    unknown.io.heal(); await unknown.memory.loadKey('alpha')
    expect(unknown.memory.joins('alpha')).toEqual([]); expect(unknown.memory.keptFacts('alpha')).toEqual([])
    expect([view(unknown), view(unknown, R.secondary)]).toEqual(['not-joined', 'not-joined'])
    expect(savedJoins(unknown)).toEqual([])
  })

  test('unsynced shared write keeps undecided joins through compaction, then judges them when durability resolves', async () => {
    const h = fixture(); await h.start(); const fact = h.fact(); await h.memory.saveJoins('alpha', [fact])
    h.failShared(() => 'unsynced')
    expect(h.choose('mentions').kind).toBe('unresolved')
    expect(h.authority.channelStamp('alpha', C.primary)).toEqual({ kind: 'undecided' })
    expect(view(h)).toBe('not-joined'); expect(h.memory.joins('alpha')).toHaveLength(1)
    expect(h.memory.addJoin('alpha', { ...fact, root: R.secondary })).toBe(false)
    await h.memory.compact(); expect(savedJoins(h)).toEqual([joinRecord(fact)])
    h.io.reset(); h.failShared(); expect(h.authority.recoverDurability().kind).toBe('applied')
    expect(h.memory.joins('alpha')).toEqual([]); expect(h.io.writes()).toEqual([])
    const reopened = fixture({ reopen: true }, h.stateDir); await reopened.start()
    expect(view(reopened)).toBe('not-joined'); expect(savedJoins(reopened)).toEqual([])
  })

  test('staged restoration leaves readableFor true but keeps undecided joins through compaction and a held restart', async () => {
    const h = fixture(); await h.start(); const fact = h.fact(); await h.memory.saveJoins('alpha', [fact])
    expect(h.stageRestoration().kind).toBe('unresolved')
    expect(h.authority.readableFor('alpha', C.primary)).toBe(true)
    expect(h.authority.channelStamp('alpha', C.primary)).toEqual({ kind: 'undecided' })
    expect(view(h)).toBe('not-joined'); expect(h.memory.joins('alpha')).toHaveLength(1)
    await h.memory.compact(); expect(savedJoins(h)).toEqual([joinRecord(fact)])
    const reopened = fixture({ reopen: true }, h.stateDir); await reopened.start()
    expect(reopened.authority.reviewHeld('alpha')).toBe(true)
    expect(view(reopened)).toBe('not-joined'); expect(reopened.memory.joins('alpha')).toHaveLength(1)
    expect(savedJoins(reopened)).toEqual([joinRecord(fact)])
  })

  test.each(['remove-readd', 'rename-back', 'credentials-location', 'working-directory'] as const)('AC-W12 %s resets identity without a Thread Memory write and replay restores no old join', async change => {
    const h = fixture(); await h.start(); const fact = h.fact(); await h.memory.saveJoins('alpha', [fact])
    const original = threadConfig(h.stateDir), changed = structuredClone(original), before = journalBytes(h)
    if (change === 'remove-readd') changed.personas = threadConfig(h.stateDir, 'all', ['beta']).personas
    if (change === 'rename-back') changed.personas![0]!.name = 'renamed'
    if (change === 'credentials-location') changed.personas![0]!.credentials_file = join(h.stateDir, 'new-credentials.json')
    if (change === 'working-directory') changed.personas![0]!.working_directory = join(h.stateDir, 'new-work')
    h.io.reset(); expect(h.apply(changed).kind).toBe('applied')
    expect(view(h)).toBe('not-joined'); expect(h.memory.joins('alpha')).toEqual([])
    expect(h.io.writes()).toEqual([]); expect(journalBytes(h)).toEqual(before)
    if (change === 'remove-readd' || change === 'rename-back') expect(h.apply(original).kind).toBe('applied')
    expect(h.authority.incarnation('alpha')).not.toBe(fact.stamp.incarnation)
    expect(h.memory.addJoin('alpha', fact)).toBe(false)
    const reopened = fixture({ reopen: true }, h.stateDir); await reopened.start()
    expect(view(reopened)).toBe('not-joined'); expect(savedJoins(reopened)).toEqual([])
  })

  test('credential contents at the same location and reconnect retain joins', async () => {
    const h = membershipFixture({ names: ['alpha', 'beta'] }); await h.start()
    const fact = h.fact(), neighbor = h.fact({}, 'beta'), connections = h.membership.h
    expect(h.membership.scanner.status('beta').state).toBe('complete')
    expect(connections.manager.status('beta')?.state).toBe('up')
    await h.memory.saveJoins('alpha', [fact]); await h.memory.saveJoins('beta', [neighbor])
    const before = { alpha: journalBytes(h), beta: journalBytes(h, 'beta') }
    const cp = { activity: connections.slack.activity.length, statuses: connections.statuses.length,
      bringUps: structuredClone(connections.bringUpCalls), neighborCalls: structuredClone(h.stub('beta').calls),
      neighborLifecycle: [...h.stub('beta').socket.lifecycle], neighborWeb: connections.manager.webClient('beta'),
      neighborProvenance: connections.manager.provenance('beta')!, neighborStatus: connections.manager.status('beta') }
    const p = h.authority.config().personas[0]!
    // The production identity comparison takes paths, not credential bytes.
    // Write two different valid contents at the exact declaration path.
    writeCredentialsFile(h.stateDir, relative(h.stateDir, p.credentials_file))
    const bot = fakeToken(BOT_TOKEN_PREFIX, 'rotated'), app = fakeToken(APP_TOKEN_PREFIX, 'rotated')
    writeCredentialsFile(h.stateDir, relative(h.stateDir, p.credentials_file), { bot_token: bot, app_token: app })
    expect(h.authority.applyReviewed(h.authority.sourceBytes(), h.authority.revision).kind).toBe('applied')
    const tokens = new PersonaSlackTokens(bot, app), old = connections.manager.provenance('alpha')!
    const fresh = connections.slack.addCredentials('alpha', 'rotated', tokens, h.stub().identity)
    fresh.script.inventory.push(membershipPage([C.primary]))
    const outcome = await connections.manager.reconnectCredentials('alpha', tokens)
    const { botUserId, botId, teamId, appId } = fresh.identity
    expect(outcome).toEqual({ kind: 'swapped', identity: { botUserId, botId, teamId, appId } })
    expect(old.isCurrent()).toBe(false)
    await h.membership.scan()
    expect(h.membership.scanner.status('alpha').state).toBe('complete')
    // The entire activity delta names only alpha and proves exactly one overlap reconnect.
    expect(connections.slack.activity.slice(cp.activity).map(e => [e.persona, e.event, e.kind, e.credentials])).toEqual([
      ['alpha', 'built', 'validation', 'rotated'],
      ['alpha', 'built', 'web', 'rotated'],
      ['alpha', 'built', 'socket', 'rotated'],
      ['alpha', 'started', 'socket', 'rotated'],
      ['alpha', 'connected', 'socket', 'rotated'],
      ['alpha', 'discarded', 'socket', INITIAL_CREDENTIALS],
      ['alpha', 'disconnected', 'socket', INITIAL_CREDENTIALS],
      ['alpha', 'built', 'web', 'rotated'], // The scanner's isolated membership client.
    ])
    expect(connections.statuses.slice(cp.statuses)).toEqual([['alpha', { state: 'up', identity: { botUserId, botId, teamId, appId } }]])
    expect(connections.bringUpCalls).toEqual(cp.bringUps)
    expect(h.stub('beta').calls).toEqual(cp.neighborCalls)
    expect(h.stub('beta').socket.lifecycle).toEqual(cp.neighborLifecycle)
    expect(connections.manager.status('beta')).toEqual(cp.neighborStatus)
    expect(connections.manager.webClient('beta')).toBe(cp.neighborWeb)
    expect(cp.neighborProvenance.isCurrent()).toBe(true)
    expectOnlySavedJoin(h, fact); expectOnlySavedJoin(h, neighbor, 'beta')
    expect(h.fact().stamp).toEqual(fact.stamp); expect(h.fact({}, 'beta').stamp).toEqual(neighbor.stamp)
    expect({ alpha: journalBytes(h), beta: journalBytes(h, 'beta') }).toEqual(before)
    assertNoLeak({ outcome, captured: h.membership.captured() })
  })

  test.each([
    ['strict', 'leave-event'], ['strict', 'catch-up-absence'], ['open', 'leave-event'], ['open', 'catch-up-absence'],
  ] as const)('AC-J07 %s %s forgets at publication without writing Thread Memory and remains forgotten after rejoin', async (mode, cause) => {
    const h = membershipFixture({ mode, channels: joinedChannels }); await h.start()
    const fact = h.fact(), survivor = h.fact({ channel: C.secondary, root: fact.root })
    await h.memory.saveJoins('alpha', [fact, survivor])
    const bytes = journalBytes(h); h.io.reset()
    if (cause === 'leave-event') {
      await h.membership.event(false); expect(h.stub().socket.acks).toHaveLength(1)
    } else {
      h.stub().script.inventory.push(membershipPage([C.secondary])); h.membership.scanner.connectionChanged('alpha')
      await h.clock.advance(MEMBERSHIP_RETRY_MIN_MS)
      expect(h.membership.scanner.status('alpha').state).toBe('complete')
    }
    expect(h.authority.choice('alpha', C.primary)).toBeUndefined()
    expect(view(h)).toBe('not-joined'); expect(h.memory.isJoinSaved('alpha', fact)).toBe(false)
    expectOnlySavedJoin(h, survivor)
    expect(h.io.writes()).toEqual([]); expect(journalBytes(h)).toEqual(bytes)
    await h.clock.advance(2); await h.membership.event(true)
    expect(h.choose('thread_hybrid').kind).toBe('applied')
    expect(h.fact().stamp).not.toEqual(fact.stamp); expect(view(h)).toBe('not-joined')
    await expectSurvivorAfterCompactionAndRestart(h, survivor)
  })

  test.each(['open', 'strict'] as const)('AC-J08 %s verified leave, restart absent, switch mode and rejoin cannot replay old joins', async mode => {
    const h = membershipFixture({ mode, channels: joinedChannels }); await h.start()
    const fact = h.fact(), survivor = h.fact({ channel: C.secondary, root: fact.root })
    await h.memory.saveJoins('alpha', [fact, survivor])
    const bytes = journalBytes(h); h.io.reset(); await h.membership.event(false)
    expect(journalBytes(h)).toEqual(bytes); expect(h.io.writes()).toEqual([])
    expect(h.memory.isJoinSaved('alpha', fact)).toBe(false); expectOnlySavedJoin(h, survivor); await h.close()
    const reopened = membershipFixture({ reopen: true, startTime: h.clock.now() + 5 }, h.stateDir)
    await reopened.start([C.secondary]); expect(view(reopened)).toBe('not-joined')
    expectOnlySavedJoin(reopened, joinRecord(survivor, 3))
    expect(reopened.mode(mode === 'open' ? 'strict' : 'open').kind).toBe('applied')
    await reopened.clock.advance(2); await reopened.membership.event(true, C.primary, { id: 'EvAFTERRESTARTJOIN' })
    expect(reopened.authority.choice('alpha', C.primary)).toBe(mode === 'open' ? 'off' : 'mentions')
    expect(reopened.choose('thread_hybrid').kind).toBe('applied')
    expect(reopened.fact().stamp).not.toEqual(fact.stamp)
    expect(view(reopened)).toBe('not-joined')
    await expectSurvivorAfterCompactionAndRestart(reopened, joinRecord(survivor, 3))
  })

  test.each(['delayed', 'partial', 'failed'] as const)('AC-J13 leave while stopped: %s restart inventory preserves facts until verified complete absence, then forgets without a write', async scan => {
    const h = membershipFixture({ channels: joinedChannels }); await h.start()
    const fact = h.fact(), survivor = h.fact({ channel: C.secondary, root: fact.root })
    await h.memory.saveJoins('alpha', [fact, survivor]); await h.close()
    const restarted = membershipFixture({ reopen: true, startTime: h.clock.now() + 5 }, h.stateDir)
    await restarted.memory.activate()
    const pending = makeDeferredWebApiCall()
    if (scan === 'partial') restarted.stub().script.inventory.push(membershipPage([C.secondary], 'next'))
    restarted.stub().script.inventory.push(scan === 'failed' ? { kind: 'platform', error: 'internal_error' } : pending.outcome)
    await restarted.membership.start(); await restarted.membership.scan()
    expect(restarted.authority.choice('alpha', C.primary)).toBe('thread_hybrid')
    expect(restarted.memory.joins('alpha')).toEqual([
      { join: joinRecord(fact), savedAt: fact.at }, { join: joinRecord(survivor, 3), savedAt: survivor.at },
    ])
    expect(restarted.memory.isJoinSaved('alpha', survivor)).toBe(true)
    // A partial/failed scan is no absence proof; membership independently holds intake.
    expect(restarted.membership.membership.read('alpha', C.primary, 'open').kind).toBe('unresolved')
    const bytes = journalBytes(restarted); restarted.io.reset()
    if (scan === 'failed') {
      restarted.stub().script.inventory.push(membershipPage([C.secondary]))
      await restarted.clock.advanceTo(restarted.membership.scanner.status('alpha').nextAttemptAt!)
    } else { pending.settle(membershipPage(scan === 'partial' ? [] : [C.secondary])); await restarted.clock.flush() }
    expect(restarted.membership.scanner.status('alpha').state).toBe('complete')
    expect(restarted.authority.choice('alpha', C.primary)).toBeUndefined()
    expect(view(restarted)).toBe('not-joined'); expect(restarted.memory.isJoinSaved('alpha', fact)).toBe(false)
    expectOnlySavedJoin(restarted, joinRecord(survivor, 3))
    expect(restarted.io.writes()).toEqual([]); expect(journalBytes(restarted)).toEqual(bytes)
    await expectSurvivorAfterCompactionAndRestart(restarted, joinRecord(survivor, 3))
  })

  test('an unobserved leave and rejoin while stopped supplies no forgetting boundary', async () => {
    const h = membershipFixture(); await h.start(); const fact = h.fact(); await h.memory.saveJoins('alpha', [fact]); await h.close()
    const restarted = membershipFixture({ reopen: true, startTime: h.clock.now() + 5 }, h.stateDir)
    await restarted.start([C.primary])
    expect(view(restarted)).toBe('joined'); expect(restarted.fact().stamp).toEqual(fact.stamp)
  })

  test('crash after durable choice change before compaction cannot restore joins, and Thread Memory never changes accepted queue work', async () => {
    const h = fixture(); await h.start(); const fact = h.fact(); await h.memory.saveJoins('alpha', [fact])
    const queue = await makeQueue(h.stateDir)
    try {
      expect((await queue.accept('alpha', slackInput())).status).toBe('accepted')
      const queueBytes = readFileSync(queuePath(h.stateDir)), items = structuredClone(queue.items('alpha'))
      const oldJournal = journalBytes(h); h.io.reset()
      expect(h.choose('mentions').kind).toBe('applied')
      expect(journalBytes(h)).toEqual(oldJournal); expect(h.io.writes()).toEqual([])
      // Abandon the first instance without stop or compaction: only its authority write landed.
      const restarted = fixture({ reopen: true }, h.stateDir); await restarted.start()
      expect(view(restarted)).toBe('not-joined'); expect(savedJoins(restarted)).toEqual([])
      await restarted.memory.compact(); await restarted.memory.remove('alpha')
      expect(readFileSync(queuePath(h.stateDir))).toEqual(queueBytes)
      expect(queue.items('alpha')).toEqual(items); expect(queue.openCount('alpha')).toBe(1)
    } finally { await queue.stop() }
  })
})

describe('Thread Memory writer ownership', () => {
  test('an unknown/failing key leaves another key\'s reads, append, compaction and lookup independent', async () => {
    const h = fixture(); expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    const a = h.fact(), b = h.fact({}, 'beta')
    seedThreads(h.stateDir, [threadHeader(), joinRecord(a)])
    seedThreads(h.stateDir, [threadHeader({ storeId: 'beta-store' }), joinRecord(b)], 'beta')
    h.io.fail('readFileSync'); await h.start()
    expect([view(h), view(h, R.primary, 'beta')]).toEqual(['unknown', 'joined'])
    await h.memory.saveJoins('beta', [h.fact({ root: R.secondary }, 'beta')]); await h.memory.compact('beta')
    expect(savedJoins(h, 'beta')).toHaveLength(2); expect(view(h, R.secondary, 'beta')).toBe('joined')
    h.io.heal(); await h.memory.loadKey('alpha'); h.io.fail('writeSync')
    expect((await h.memory.saveJoins('alpha', [h.fact({ root: R.secondary })])).kind).toBe('failed')
    expect(await h.memory.saveJoins('beta', [h.fact({ root: R.third }, 'beta')])).toEqual({ kind: 'saved' })
    expect(view(h, R.third, 'beta')).toBe('joined'); expect(savedJoins(h, 'beta')).toHaveLength(3)
  })

  test('a held marker writer does not delay another persona, and stop waits for every admitted writer', async () => {
    const blocked = gate()
    const h = fixture({ setCreated: async key => {
      if (key === 'alpha') await blocked.wait()
      return h.authority.setThreadMemoryCreated(key)
    } })
    expect(h.apply(threadConfig(h.stateDir, 'thread_hybrid', ['alpha', 'beta'])).kind).toBe('applied')
    const starting = h.start()
    try {
      await blocked.entered; await h.clock.flush()
      expect(h.memory.store('alpha')?.created).toBe(false); expect(h.memory.store('beta')?.created).toBe(true)
      expect(await h.memory.saveJoins('beta', [h.fact({}, 'beta')])).toEqual({ kind: 'saved' })
      expect(view(h, R.primary, 'beta')).toBe('joined')
      let stopped = false
      const stopping = h.memory.stop().then(() => { stopped = true })
      await h.clock.flush(); expect(stopped).toBe(false)
      blocked.release(); await stopping; await starting
      expect(stopped).toBe(true)
    } finally { blocked.release(); await starting }
  })

  test.each(['forget', 'stop'] as const)('%s cancels deferred creation from a publication before it writes', async action => {
    const h = fixture(); expect(h.choose('mentions').kind).toBe('applied'); await h.start()
    h.io.reset(); expect(h.choose('thread_hybrid').kind).toBe('applied')
    await h.memory[action]('alpha'); await h.clock.flush()
    expect(existsSync(threadPath(h.stateDir))).toBe(false)
    expect(h.authority.threadMemoryCreated('alpha')).toBe(false)
    expect(h.io.writes()).toEqual([]); expect(h.markerCalls).toEqual([])
  })

  test.each(['forget', 'remove'] as const)('%s cancels joins queued behind in-flight creation', async action => {
    const blocked = gate(), h = fixture({ setCreated: async key => { await blocked.wait(); return h.authority.setThreadMemoryCreated(key) } })
    const starting = h.start()
    try {
      await blocked.entered
      const fact = h.fact(), queued = h.memory.saveJoins('alpha', [fact]), before = journalBytes(h)
      h.io.reset()
      const ending = h.memory[action]('alpha')
      blocked.release(); await ending; await starting
      expect(await queued).toEqual({ kind: 'cancelled' })
      expect(h.io.calls.filter(c => c.op === 'writeSync')).toEqual([])
      expect(h.events.some(e => e.type === 'created')).toBe(false)
      if (action === 'forget') expect(journalBytes(h)).toEqual(before)
      else { expect(existsSync(threadPath(h.stateDir))).toBe(false); expect(h.authority.threadMemoryCreated('alpha')).toBe(false) }
    } finally { blocked.release(); await starting }
  })
})

/** Operations answered in call order, each recording the signal its attempt gave it. */
function scripted() {
  const signals: AbortSignal[] = [], answers: Array<() => Promise<unknown>> = []
  const operation = (signal: AbortSignal) => { signals.push(signal); return answers.shift()!() }
  const hang = () => {
    let settle!: (value: unknown) => void, fail!: (error: unknown) => void
    const pending = new Promise((resolve, reject) => { settle = resolve; fail = reject })
    answers.push(() => pending)
    return { settle, fail }
  }
  return { signals, answers, operation, hang }
}

describe('the bounded metadata call', () => {
  test('Thread Memory\'s lookups may call exactly conversations.replies and conversations.history (SR-3.4.2)', () => {
    expect(THREAD_MEMORY_LOOKUP_METHODS).toEqual(['conversations.replies', 'conversations.history'])
  })

  test('a hung first and a hung later attempt each end at the lookup deadline, abort their request and leave nothing in flight; late answers change nothing', async () => {
    const clock = createFakeClock({ start: T0 }), attempts = createMetadataAttempts(clock), s = scripted()
    const run = () => attempts.run('alpha', () => true, s.operation)
    const first = s.hang()
    const one = run()
    await clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS - 1)
    expect([attempts.inFlight('alpha'), s.signals[0]!.aborted]).toEqual([1, false])
    await clock.advance(1)
    expect(await one).toEqual({ kind: 'deadline' })
    expect([attempts.inFlight('alpha'), s.signals[0]!.aborted]).toEqual([0, true])
    // The abandoned attempt's late answer is consumed; a fresh attempt starts at once and decides from its own answer.
    first.settle({ ok: true, late: true })
    const fresh = { ok: true, fresh: true }
    s.answers.push(async () => fresh)
    expect(await run()).toEqual({ kind: 'ok', value: fresh })
    const later = s.hang()
    const three = run()
    await clock.advance(THREAD_MEMORY_LOOKUP_DEADLINE_MS)
    expect(await three).toEqual({ kind: 'deadline' })
    later.fail(slackPlatformError('internal_error'))
    await clock.flush()
    expect([s.signals.length, s.signals[2]!.aborted, attempts.inFlight('alpha'), clock.pendingCount()]).toEqual([3, true, 0, 0])
  })

  test('a guard turning false, revocation or shutdown cancels the attempt; another persona\'s attempt is untouched', async () => {
    const clock = createFakeClock({ start: T0 }), attempts = createMetadataAttempts(clock), s = scripted()
    const answer = { ok: true }
    let current = true
    const guarded = s.hang(), revoked = s.hang(), other = s.hang()
    const a = attempts.run('alpha', () => current, s.operation)
    const b = attempts.run('alpha', () => true, s.operation)
    const c = attempts.run('beta', () => true, s.operation)
    current = false; guarded.settle(answer)
    expect(await a).toEqual({ kind: 'cancelled' })
    attempts.revoke('alpha')
    expect(await b).toEqual({ kind: 'cancelled' })
    expect([s.signals[1]!.aborted, s.signals[2]!.aborted, attempts.inFlight('beta')]).toEqual([true, false, 1])
    revoked.settle(answer); other.settle(answer)
    expect(await c).toEqual({ kind: 'ok', value: answer })
    attempts.stop()
    expect(await attempts.run('beta', () => true, s.operation)).toEqual({ kind: 'cancelled' })
    expect(s.signals).toHaveLength(3)
  })

  test.each<[string, unknown, MetadataFailure]>([
    ['a missing scope', slackPlatformError('missing_scope'), { kind: 'capability', slackError: 'missing_scope' }],
    ['a refused token type', slackPlatformError('not_allowed_token_type'), { kind: 'capability', slackError: 'not_allowed_token_type' }],
    ['a denied access', slackPlatformError('access_denied'), { kind: 'capability', slackError: 'access_denied' }],
    ['a missing permission', slackPlatformError('no_permission'), { kind: 'capability', slackError: 'no_permission' }],
    ['an unauthorized call', slackPlatformError('not_authorized'), { kind: 'capability', slackError: 'not_authorized' }],
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
    expect(classifyMetadataFailure(error)).toEqual(expected)
  })

  test('a sentinel-bearing failure keeps only its safe Slack code and Retry-After', async () => {
    const clock = createFakeClock({ start: T0 }), attempts = createMetadataAttempts(clock)
    const results = [
      await attempts.run('alpha', () => true, async () => { throw slackPlatformError('something_new', undefined, LEAK_SENTINEL) }),
      await attempts.run('alpha', () => true, async () => { throw slackPlatformError('ratelimited', 30, LEAK_SENTINEL) }),
      await attempts.run('alpha', () => true, async () => { throw slackRateLimited(120, LEAK_SENTINEL) }),
    ]
    expect(results).toEqual([{ kind: 'rejected', slackError: 'something_new' }, { kind: 'transient', retryAfter: 30 }, { kind: 'transient', retryAfter: 120 }])
    assertNoLeak({ results })
  })

  test('retry spacing: the minimum doubling to the local maximum; Retry-After below the cap changes nothing, above it is honored, and huge or invalid waits stay safe', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(n => metadataRetryDelay(n))).toEqual([1, 2, 4, 8, 16, 32, 32].map(m => Math.min(THREAD_MEMORY_RETRY_MAX_MS, THREAD_MEMORY_RETRY_MIN_MS * m)))
    expect(metadataRetryDelay(50)).toBe(THREAD_MEMORY_RETRY_MAX_MS)
    expect(metadataRetryDelay(1, 1)).toBe(THREAD_MEMORY_RETRY_MIN_MS)
    expect(metadataRetryDelay(50, THREAD_MEMORY_RETRY_MAX_MS / 1000 - 1)).toBe(THREAD_MEMORY_RETRY_MAX_MS)
    expect(metadataRetryDelay(1, THREAD_MEMORY_RETRY_MAX_MS / 1000 * 3)).toBe(THREAD_MEMORY_RETRY_MAX_MS * 3)
    expect(metadataRetryDelay(1, 1e300)).toBe(Number.MAX_SAFE_INTEGER)
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(metadataRetryDelay(1, bad)).toBe(THREAD_MEMORY_RETRY_MIN_MS)
  })

  test('pin: a lookup attempt\'s deadline is 15 s, and its retries are spaced from 5 s to 60 s (SR-5.1.1, SR-5.1.3)', () => {
    expect([THREAD_MEMORY_LOOKUP_DEADLINE_MS, THREAD_MEMORY_RETRY_MIN_MS, THREAD_MEMORY_RETRY_MAX_MS]).toEqual([15_000, 5_000, 60_000])
  })
})

describe('SR-8 Joined Thread populations (t1.k49.39 SR-8.1, SR-8.3, SR-2.4.4)', () => {
  // Hang backstops: focused 100k reopen/scan/compaction cases took 1.3–2.6 s;
  // seeds previously measured about 3 s per persona. 30 s allows at least 10x
  // headroom, including host load; these are never performance verdicts. Integration
  // tests 44/45/48 and 32 judge performance, including the 2 GiB shard cap.
  const POPULATION_SEED_TIMEOUT_MS = 30_000, POPULATION_CASE_TIMEOUT_MS = 30_000
  const keys = sr8Personas(2), eligible = populationEligible(), [, tenThousand, hundredThousand] = SR8_POPULATIONS
  const seeded = new Map<number, string>(), dirs: string[] = [], runs: ThreadMemoryHarness[] = []
  const closes: Array<() => Promise<void>> = []
  const populationDir = () => { const dir = mkdtempSync(join(tmpdir(), 'thread-population-')); dirs.push(dir); return dir }
  // Each population is seeded once, one hook per persona: 100,000 joins take about 3 s on the dev host.
  for (const population of SR8_POPULATIONS) {
    beforeAll(() => { const dir = populationDir(); makeSharedAuthority(dir, populationConfig(dir, 'strict', keys.length)); seeded.set(population, dir) })
    for (const key of keys) beforeAll(async () => { await seedUnitPopulation(seeded.get(population)!, { key, joins: populationJoins(key, population, eligible) }) }, POPULATION_SEED_TIMEOUT_MS)
  }
  afterEach(async () => { for (const h of runs.splice(0)) await h.close(); for (const close of closes.splice(0)) await close() })
  afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  function reopen(dir: string, options: ThreadHarnessOptions = {}) {
    const h = makeThreadMemoryHarness(dir, { reopen: true, ...options }); runs.push(h); return h
  }
  const byKey = <E extends { key: string }>(events: readonly E[]) => [...events].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const readEvents = (dir: string) => keys.flatMap(key => [
    { type: 'read' as const, key, path: threadPath(dir, key), firstSuccessfulRead: false },
    { type: 'compacted' as const, key, path: threadPath(dir, key), outcome: 'rewritten' as const },
  ])
  /** Every join `populationJoins` gives `key` is held, and the oldest are joined. */
  function expectPopulation(memory: Pick<ThreadMemory, 'joins' | 'view'>, key: string, count: number) {
    const joins = populationJoins(key, count, eligible), line = (j: { channel: string; root: string; at: number }) => `${j.channel} ${j.root} ${j.at}`
    expect(memory.joins(key).map(({ join, savedAt }) => line({ ...join, at: savedAt ?? Number.NaN })).sort()).toEqual(joins.map(line).sort())
    expect(oldestJoins(joins, SR8_BURST_JOINS).filter(j => memory.view(key, j.channel, j.root) !== 'joined')).toEqual([])
  }
  test.each([...SR8_POPULATIONS])('%i Joined Threads per persona, for two personas, reopen from disk with every join and the oldest, and nothing lost', async population => {
    const dir = seeded.get(population)!, h = reopen(dir); await h.start()
    expect(eligible).toHaveLength(SR8_ELIGIBLE_CHANNELS)
    // A population of 0 has no journal: activation creates each store.
    expect(byKey(h.events)).toEqual(population ? readEvents(dir) : keys.map(key => ({ type: 'created', key, path: threadPath(dir, key) })))
    for (const key of keys) expectPopulation(h.memory, key, population)
  }, POPULATION_CASE_TIMEOUT_MS)

  test('a seed in batches writes the journal bytes production writes for the same joins added one by one and flushed', async () => {
    const base = populationDir(), copy = populationDir()
    makeSharedAuthority(base, populationConfig(base))
    const first = reopen(base); await first.start(); await first.close()
    cpSync(base, copy, { recursive: true })
    const joins = populationJoins('alpha', 2 * SEED_BATCH_JOINS + 1, eligible)
    await seedUnitPopulation(base, { key: 'alpha', joins })
    const h = reopen(copy); await h.start()
    expect(stampedJoins(h.authority, 'alpha', joins).every(fact => h.memory.addJoin('alpha', fact))).toBe(true)
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    const digest = (dir: string) => createHash('sha256').update(readFileSync(threadPath(dir))).digest('hex')
    expect(digest(copy)).toBe(digest(base))
  }, POPULATION_CASE_TIMEOUT_MS)

  test('startup reads retain every join and arm the hourly compaction by default', async () => {
    const dir = seeded.get(tenThousand)!, h = reopen(dir); await h.start()
    expect(byKey(h.events)).toEqual(readEvents(dir))
    for (const key of keys) expectPopulation(h.memory, key, tenThousand)
    h.memory.startMaintenance()
    expect(h.clock.pending().map(t => t.delayMs)).toEqual([QUEUE_COMPACT_INTERVAL_MS])
  }, POPULATION_CASE_TIMEOUT_MS)

  test('an unreadable journal reports read-failed, a missing one is created, and a later loadKey recovers the unreadable journal', async () => {
    const from = seeded.get(tenThousand)!, dir = populationDir()
    cpSync(from, dir, { recursive: true, filter: path => path !== threadPath(from, 'beta') })
    const io = threadFsControls(dir), fault = io.fail('readFileSync', 'alpha', { code: 'EACCES', times: 1 })
    const h = reopen(dir, { fs: io }); await h.start()
    expect(byKey(h.events.splice(0))).toEqual([
      { type: 'read-failed', key: 'alpha', path: threadPath(dir), error: fault }, { type: 'created', key: 'beta', path: threadPath(dir, 'beta') },
    ])
    await h.memory.loadKey('alpha')
    expect(h.events).toEqual([{ type: 'read', key: 'alpha', path: threadPath(dir), firstSuccessfulRead: true },
      { type: 'compacted', key: 'alpha', path: threadPath(dir), outcome: 'rewritten' }])
  }, POPULATION_CASE_TIMEOUT_MS)

  test('1,000 joins added to 100,000, and the compaction at compactIntervalMs, forget nothing', async () => {
    const dir = populationDir(), from = seeded.get(hundredThousand)!
    cpSync(from, dir, { recursive: true, filter: path => path !== threadPath(from, 'beta') })
    const interval = QUEUE_COMPACT_INTERVAL_MS / 4
    const h = reopen(dir, { compactIntervalMs: interval }); await h.start()
    h.memory.startMaintenance()
    expect(h.clock.pending().map(t => t.delayMs)).toEqual([interval])
    const added = stampedJoins(h.authority, 'alpha', populationJoins('alpha', hundredThousand + SR8_BURST_JOINS, eligible).slice(hundredThousand))
    expect(added.every(fact => h.memory.addJoin('alpha', fact))).toBe(true)
    expect(await h.memory.saveJoins('alpha', added)).toEqual({ kind: 'saved' })
    const identity = statSync(threadPath(dir)).ino
    await h.clock.advance(interval)
    // The sliced compaction owns alpha's writer turn; a flush queued behind it starts only after it.
    await h.memory.flush('alpha')
    expect(statSync(threadPath(dir)).ino).not.toBe(identity)
    expect(h.events.filter(e => e.type === 'compaction-failed')).toEqual([])
    await h.close()
    const next = reopen(dir); await next.start()
    expectPopulation(next.memory, 'alpha', hundredThousand + SR8_BURST_JOINS)
  }, POPULATION_CASE_TIMEOUT_MS)

  test('at 100,000 joins, both personas scanning every listed channel in MEMBERSHIP_PAGE_LIMIT pages write once per page plus the commit and retain every join', async () => {
    const dir = populationDir(), from = seeded.get(hundredThousand)!
    cpSync(from, dir, { recursive: true, filter: path => path !== threadPath(from, 'beta') })
    // The integration population's listed channels: the eligible ones and the shared list.
    const listed = [...eligible, ...populationChannels(SR8_SHARED_LIST_CHANNELS, SR8_POPULATION_CHANNEL_COUNT).map(c => c.id)]
    const pages = Math.ceil(listed.length / MEMBERSHIP_PAGE_LIMIT)
    const h = makeThreadMembershipHarness(dir, { reopen: true, names: [...keys] })
    closes.push(() => h.close())
    // The store's start, without the harness's one-page inventory.
    h.memory.readAtStart(); await h.memory.activate()
    for (const key of keys) h.stub(key).script.inventory.push(...Array.from({ length: pages }, (_, i) =>
      membershipPage(listed.slice(i * MEMBERSHIP_PAGE_LIMIT, (i + 1) * MEMBERSHIP_PAGE_LIMIT), i + 1 < pages ? `page-${i + 1}` : undefined)))
    await h.membership.start()
    const writes = h.membership.writes.length
    await h.membership.scan()
    for (const key of keys) expect(h.membership.scanner.status(key)).toMatchObject({ state: 'complete', pages, positives: listed.length })
    expect(h.membership.writes.length - writes).toBe(keys.length * (pages + 1))
    expectPopulation(h.memory, 'alpha', hundredThousand)
  }, POPULATION_CASE_TIMEOUT_MS)

  describe('seeding while stopped and the seal check (Decisions 14 and 21)', () => {
    // Only the eligible channels: the seal check reads none, and the harness's start grows with every channel listed.
    const channels = channelPopulation(SR8_POPULATION_CHANNEL_COUNT).filter(c => eligible.includes(c.id)), inventory = channels.map(c => c.id)
    /** Two personas over the eligible population channels on the production start and stop. */
    function server() {
      const h = makeReloadHarness({ personaConfigDirs: true }), started: ReloadRun[] = []
      const personas = keys.map(name => h.persona(name, { channels, permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' } }))
      h.materialize(...personas)
      const input = { channel_mode: 'strict', personas }
      h.writeConfig(input)
      closes.push(async () => { for (const run of started) await run.stop(); await h.cleanup() })
      return {
        h, input,
        async start() {
          const run = h.build({ threadMemory: {}, slack: Object.fromEntries(personas.map(p => [p.name, { inventory: [membershipPage(inventory)] }])) })
          started.push(run)
          expect(run.resolveStart().kind).toBe('applied')
          await run.controller.runStartBringUp(); await run.membershipClock.runNext(); await run.clock.flush()
          return run
        },
        seed: (key: string, count: number) => seedUnitPopulation(h.stateDir, { key, joins: populationJoins(key, count, eligible) }, { authorityPath: h.channelDeliveryFile }),
        seal: () => existsSync(threadSealPath(h.stateDir)) ? readFileSync(threadSealPath(h.stateDir)) : undefined,
      }
    }
    const findings = (run: ReloadRun) => run.threadMemorySeal!.startupFindings()
    const reports = (run: ReloadRun) => run.threadMemorySealEvents.filter(e => e.type === 'changed-while-stopped')

    test('a seed before the first start is reported changed while stopped once per persona; after a clean stop the next start reports nothing and keeps every join', async () => {
      const s = server(); s.h.writeRecord(s.input)
      const before = s.seal()
      for (const key of keys) await s.seed(key, tenThousand)
      expect([before, s.seal()]).toEqual([undefined, undefined])
      const first = await s.start(), expected = keys.map(key => ({ key, case: 'entry-missing' as const, wording: 'changed' as const }))
      expect(findings(first)).toEqual(expected)
      expect(reports(first)).toEqual(expected.map(finding => ({ type: 'changed-while-stopped', ...finding })))
      await first.stop()
      const measured = await s.start()
      expect([findings(measured), reports(measured)]).toEqual([[], []])
      for (const key of keys) expectPopulation(measured.threadMemory!, key, tenThousand)
    }, POPULATION_CASE_TIMEOUT_MS)

    test('a seed after a start and clean stop leaves the seal as it was and appends to the sealed store, which SR-2.4.4 does not report', async () => {
      const s = server(), first = await s.start(); await first.stop()
      const sealed = s.seal()
      for (const key of keys) await s.seed(key, tenThousand)
      expect(s.seal()).toEqual(sealed)
      const next = await s.start()
      expect([findings(next), reports(next)]).toEqual([[], []])
      for (const key of keys) expectPopulation(next.threadMemory!, key, tenThousand)
    }, POPULATION_CASE_TIMEOUT_MS)

    test('population 0: a seed of 0 joins writes nothing, before the first start or after a clean stop; neither start reports and each journal is kept as written', async () => {
      const s = server(); s.h.writeRecord(s.input)
      const record = readFileSync(s.h.channelDeliveryFile)
      for (const key of keys) expect(await s.seed(key, 0)).toEqual({ key, seeded: 0 })
      expect([existsSync(join(s.h.stateDir, 'threads')), s.seal(), readFileSync(s.h.channelDeliveryFile)]).toEqual([false, undefined, record])
      const first = await s.start()
      expect([findings(first), reports(first)]).toEqual([[], []])
      await first.stop()
      const files = () => ({ seal: s.seal(), record: readFileSync(s.h.channelDeliveryFile), threads: readdirSync(join(s.h.stateDir, 'threads')).sort(),
        journals: keys.map(key => readFileSync(threadPath(s.h.stateDir, key))) })
      const written = files()
      for (const key of keys) expect(await s.seed(key, 0)).toEqual({ key, seeded: 0 })
      expect(files()).toEqual(written)
      const next = await s.start()
      expect([findings(next), reports(next)]).toEqual([[], []])
      expect(keys.map(key => readFileSync(threadPath(s.h.stateDir, key)))).toEqual(written.journals)
    }, POPULATION_CASE_TIMEOUT_MS)
  })
})
