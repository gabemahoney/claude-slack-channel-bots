/**
 * Thread Memory journals and authority-driven forgetting, alongside the
 * bounded metadata calls, failure classification and retry spacing.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { THREAD_MEMORY_LOOKUP_METHODS, MetadataCancelledError, classifyMetadataFailure, createMetadataAttempts, metadataRetryDelay,
  type MetadataFailure } from '../src/thread-memory.ts'
import { THREAD_MEMORY_LOOKUP_DEADLINE_MS, THREAD_MEMORY_RETRY_MAX_MS, THREAD_MEMORY_RETRY_MIN_MS } from '../src/delivery-constants.ts'
import { createFakeClock } from './test-helpers/fake-clock.ts'
import { INITIAL_CREDENTIALS, slackHttpError, slackPlatformError, slackRateLimited } from './test-helpers/slack-stub.ts'
import { assertNoLeak, LEAK_SENTINEL, writeCredentialsFile, fakeToken, BOT_TOKEN_PREFIX, APP_TOKEN_PREFIX, writtenFile } from './test-helpers/credentials.ts'
import { PersonaSlackTokens } from '../src/persona-credentials.ts'
import { isThreadMemoryRecord, parseThreadMemoryRecord, serializeThreadMemoryRecords, THREAD_MEMORY_DIRECTORY_MODE, THREAD_MEMORY_FILE_MODE, type ThreadJoin } from '../src/thread-memory.ts'
import { QUEUE_COMPACT_INTERVAL_MS } from '../src/delivery-queue.ts'
import { DurableWriteUnsyncedError } from '../src/atomic-write.ts'
import { isThreadMemorySealEntry, isThreadMemorySealFile, serializeThreadMemorySeal, judgeSeal, queueIdentitiesMatch,
  type JudgeSealInput, type ThreadMemorySealCase, type ThreadMemorySealEntry } from '../src/thread-memory-seal.ts'
import {
  makeThreadMemoryHarness, makeThreadMembershipHarness, threadConfig, threadPath, threadHeader,
  threadJoin, joinRecord, postIntent, postOutcome, seedThreads, readThreads, damagedThreadLine,
  THREAD_CHANNELS as C, THREAD_ROOTS as R, THREAD_TIME, type ThreadMemoryHarness,
  runningSealEntry, cleanSealEntry, seedThreadSeal, readThreadSeal, threadSealPath, damagedThreadSeal,
} from './test-helpers/thread-memory.ts'
import { membershipPage, readSharedState } from './test-helpers/shared-channels.ts'
import { deliveredRecord, makeQueue, queuePath, slackInput } from './test-helpers/delivery-queue.ts'
import { makeDeferredWebApiCall } from './test-helpers/slack-stub.ts'
import { MEMBERSHIP_RETRY_MIN_MS } from '../src/channel-membership-retry.ts'
import { _resetRegistry } from '../src/registry.ts'
import { _resetAckTracker } from '../src/ack-tracker.ts'

const T0 = 1_700_000_000_000

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
  for (const h of threadRuns.splice(0)) {
    await h.close()
    if ('membership' in h) assertNoLeak(h.membership.captured())
    assertNoLeak({ events: h.events, sealEvents: h.sealEvents, state: readSharedState(h.stateDir),
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
      expect(h.markerCalls).toEqual(keys.map(key => ({ action: 'set', key, fileExists: true, synced: true })))
      expect(h.events).toEqual(keys.map(key => ({ type: 'created', key, path: threadPath(h.stateDir, key) })))
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
    expect(h.io.calls.some(c => c.op === 'renameSync')).toBe(false)
    await h.memory.activate()
    expect(savedJoins(h)).toEqual([joinRecord(old, 6)])
    expect(h.memory.unresolvedIntents('alpha')).toEqual([unresolved])
    expect(readThreads(h.stateDir).map(r => r.kind)).toEqual(['header', 'post-intent', 'join'])
    const kept = h.fact({ root: R.secondary }); h.memory.addJoin('alpha', kept)
    h.io.reset(); h.memory.startMaintenance(); h.memory.startMaintenance()
    expect(h.clock.pending().map(t => t.delayMs)).toEqual([QUEUE_COMPACT_INTERVAL_MS])
    await h.clock.advance(QUEUE_COMPACT_INTERVAL_MS - 1)
    expect(h.io.calls.some(c => c.op === 'renameSync')).toBe(false)
    await h.clock.advance(1)
    expect(h.io.calls.some(c => c.op === 'renameSync')).toBe(true)
    expect(savedJoins(h)).toEqual([joinRecord(old, 6)])
    expect(h.memory.keptFacts('alpha')).toEqual([kept])
    expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(savedJoins(h).map(r => r.seq)).toEqual([6, 7])
    await h.close(); expect(h.clock.pendingCount()).toBe(0)
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

  test.each(['writeSync', 'fsyncSync', 'renameSync'] as const)('pre-rename compaction %s failure leaves original bytes and keeps memory usable', async op => {
    const h = fixture(); await h.start()
    await h.memory.saveJoins('alpha', [h.fact()]); const before = journalBytes(h)
    const error = h.io.fail(op)
    await h.memory.compact('alpha')
    expect(journalBytes(h)).toEqual(before); expect(view(h)).toBe('joined')
    expect(h.events.at(-1)).toEqual({ type: 'compaction-failed', key: 'alpha', path: threadPath(h.stateDir), error })
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
    const error = h.io.fail('fsyncSync', 'alpha', { match: path => path === join(h.stateDir, 'threads') })
    await h.memory.compact()
    expect(journalBytes(h).equals(before)).toBe(false)
    expect(savedJoins(h)).toEqual([joinRecord({ ...fact, at: fact.at - 1 }, 3)])
    expect(h.events.at(-1)).toEqual({ type: 'compaction-failed', key: 'alpha', path: threadPath(h.stateDir), error })
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

  test.each(['openSync', 'writeSync', 'fsyncSync'] as const)('failed %s append preserves in-memory selection and flush saves all kept facts in one append', async op => {
    const h = fixture(); await h.start(); const before = journalBytes(h)
    const first = h.fact(), second = h.fact({ root: R.secondary })
    const error = h.io.fail(op)
    expect((await h.memory.saveJoins('alpha', [first, second])).kind).toBe('failed')
    expect(journalBytes(h)).toEqual(before)
    expect([view(h), view(h, R.secondary)]).toEqual(['joined', 'joined'])
    expect(h.memory.keptFacts('alpha')).toEqual([first, second]); expect(h.memory.isJoinSaved('alpha', first)).toBe(false)
    expect(h.events.at(-1)).toEqual({ type: 'append-failed', key: 'alpha', path: threadPath(h.stateDir), error })
    h.io.heal(); h.io.reset(); expect(await h.memory.flush('alpha')).toEqual({ kind: 'saved' })
    expect(h.io.calls.filter(c => c.op === 'writeSync' && c.path === threadPath(h.stateDir))).toHaveLength(1)
    expect(savedJoins(h)).toEqual([joinRecord(first, 2), joinRecord(second, 3)])
    expect(h.memory.keptFacts('alpha')).toEqual([])
    expect(h.events.at(-1)).toEqual({ type: 'saved-after-failure', key: 'alpha', path: threadPath(h.stateDir) })
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
    expect(h.events.at(-1)).toEqual({ type: 'removal-failed', key: 'alpha', path: threadPath(h.stateDir), error })
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
  await h.queue.append(key, { v: 1, kind: 'fixed', seq: accepted.seq, parts: ['fixture delivery'] })
  await h.queue.append(key, deliveredRecord(accepted.seq))
  expect(h.queue.item(key, accepted.seq)?.delivered).toBe(true)
  expect(h.queue.openCount(key)).toBe(0)
}

describe('Thread Memory seal judgments and closed metadata', () => {
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
})

describe('Thread Memory seal startup and restart', () => {
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
      const renameAt = h.io.calls.map(call => call.op).lastIndexOf('renameSync')
      const temporary = h.io.calls[renameAt]?.path
      markerProofs.push({
        header: header?.kind === 'header',
        runningSealMatches: header?.kind === 'header' && entry.storeId === header.storeId && !entry.clean,
        fileSynced: renameAt >= 0 && h.io.calls.slice(0, renameAt).some(call => call.op === 'fsyncSync' && call.path === temporary),
        directorySynced: renameAt >= 0 && h.io.calls.slice(renameAt + 1).some(call => call.op === 'fsyncSync' && call.path === join(h.stateDir, 'threads')),
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
    return { h, markerProofs, pending: sealEntry(h) }
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
    const { h, pending } = await loseLastHybridDuringEmptyJournalCreation()
    await h.close()
    expect(sealEntry(h)).toEqual(pending)
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
    const cause = h.io.fail('fsyncSync', 'alpha', { match: path => path === join(h.stateDir, 'threads') })
    const result = await h.memory.flush('alpha')
    expect(result).toEqual({ kind: 'failed', error: cause })
    expect(h.events).toContainEqual({ type: 'compaction-failed', key: 'alpha', path: threadPath(h.stateDir), error: cause })
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

  test('startup compaction and the hourly interval update record numbers; failed compaction does not, and failed sealing cannot fail compaction', async () => {
    const h = sealFixture(); await h.start(); await h.memory.saveJoins('alpha', [h.fact()]); await h.crash()
    const next = sealFixture({ reopen: true }, h.stateDir); await next.start()
    expect(sealEntry(next).lastRecordNumber).toBe(next.memory.store('alpha')!.lastRecordNumber)
    await next.memory.saveJoins('alpha', [next.fact({ root: R.secondary })]); const previous = readFileSync(threadSealPath(h.stateDir))
    next.io.fail('renameSync'); await next.memory.compact('alpha')
    expect(readFileSync(threadSealPath(h.stateDir))).toEqual(previous)
    next.io.heal(); next.sealIo.failWrite()
    await next.memory.compact('alpha')
    expect(readThreads(h.stateDir)[0]).toMatchObject({ highWater: next.memory.store('alpha')!.lastRecordNumber })
    expect(readFileSync(threadSealPath(h.stateDir))).toEqual(previous)
    expect(next.sealEvents.at(-1)).toMatchObject({ type: 'seal-write-failed', unsynced: false })
    next.sealIo.heal(); await next.clock.advance(QUEUE_COMPACT_INTERVAL_MS)
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
