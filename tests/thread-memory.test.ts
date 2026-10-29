/**
 * Thread Memory journals and authority-driven forgetting, alongside the
 * bounded metadata calls, failure classification and retry spacing.
 *
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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
import {
  makeThreadMemoryHarness, makeThreadMembershipHarness, threadConfig, threadPath, threadHeader,
  threadJoin, joinRecord, postIntent, postOutcome, seedThreads, readThreads, damagedThreadLine,
  THREAD_CHANNELS as C, THREAD_ROOTS as R, THREAD_TIME, type ThreadMemoryHarness,
} from './test-helpers/thread-memory.ts'
import { membershipPage, readSharedState } from './test-helpers/shared-channels.ts'
import { makeQueue, queuePath, slackInput } from './test-helpers/delivery-queue.ts'
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
    assertNoLeak({ events: h.events, state: readSharedState(h.stateDir),
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
