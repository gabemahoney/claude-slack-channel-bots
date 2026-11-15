/** The file-free adapter and the durable shared-authority mutation contract. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableWriteUnsyncedError, durableWriteFileSync } from '../src/atomic-write.ts'
import { createChannelDeliveryStore } from '../src/channel-delivery.ts'
import { createSharedChannelAuthority, parseSharedChannelState, serializeSharedChannelState, type SharedChannelState } from '../src/shared-channels.ts'
import { assertNoLeak, sentinelInMessage, writtenFile } from './test-helpers/credentials.ts'
import { makePersona, makePersonaConfigInput } from './test-helpers/persona-config.ts'
import {
  SHARED_CHANNEL_IDS as C, retainedScanHistory, RETAINED_SCAN_EVENTS, membershipJoin, membershipObservation, applyMembershipPage, membershipTimestamp,
  _assignFixture, fixtureThreadHybridSince, configBytes, FIXTURE_THREAD_HYBRID_SINCE_PREFIX, initialSharedState, makeSharedAuthority, malformedThreadMemoryMarkers, readSharedState,
  sharedChannelPath, withThreadMemoryCreated, writeSharedState,
} from './test-helpers/shared-channels.ts'
import { osTempDir } from './test-helpers/host-safe-env.ts'
import { spyOnCopies } from './test-helpers/copies.ts'

let root: string, mint: () => string
beforeEach(() => { mint = fixtureThreadHybridSince(); root = mkdtempSync(join(tmpdir(), 'shared-authority-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
function input() {
  return makePersonaConfigInput({ personas: [makePersona({ name: 'alpha' }, root), makePersona({ name: 'beta' }, root)] }, root)
}
function check(state: unknown) { assertNoLeak({ state, file: existsSync(sharedChannelPath(root)) ? writtenFile(sharedChannelPath(root)) : undefined }) }

 describe('one durable authority', () => {
  test('adapter reads only applied choices and each of the four values survives reopen', () => {
    const source = input(); source.channel_mode = 'open'
    const authority = makeSharedAuthority(root, source)
    const persona = authority.config().personas[0]!
    expect(authority.observeMembership(persona.key, authority.incarnation(persona.key)!, membershipJoin(C.primary, 'adapter-join', { identity: 'authenticated-app' }), authority.revision).kind).toBe('applied')
    const store = createChannelDeliveryStore(authority, (key, channel) => authority.personaSnapshot(key)?.membership[channel]?.member === true)
    for (const delivery of ['off', 'mentions', 'all', 'thread_hybrid'] as const) {
      const previous = authority.choice(persona.key, C.primary)
      expect(store.attempt(persona.key, authority.incarnation(persona.key)!,
        deliveryAttempt(`adapter-${delivery}`, C.primary, delivery), () => undefined))
        .toMatchObject({ kind: 'applied', historical: false, outcome: { previous, delivery } })
      const reopened = createSharedChannelAuthority(authority.path, readSharedState(root)!)
      expect(reopened.choice(persona.key, C.primary)).toBe(delivery)
      expect(reopened.config().personas[0]!.channels).toEqual([{ id: C.primary, delivery }])
    }
    expect(store.path).toBe(sharedChannelPath(root))
    expect(existsSync(join(root, 'channel-delivery.json'))).toBe(false)
    check(authority.snapshot())
  })

  test('same-value assignments advance the common order while preserving unrelated evidence and submitted source', () => {
    const authority = makeSharedAuthority(root, input())
    expect(authority.transact(authority.revision, next => { next.pendingIntent = { review: 'prepared' }; next.outcomes = { attempt: 'settled' } }).kind).toBe('applied')
    const before = authority.snapshot()
    const alpha = authority.config().personas[0]!
    for (let i = 0; i < 2; i++) expect(_assignFixture(authority, alpha.key, authority.incarnation(alpha.key)!, C.primary, 'all', authority.revision, mint).kind).toBe('applied')
    const after = readSharedState(root)!
    expect(after.revision).toBe(before.revision + 2)
    expect(after.personas[alpha.key]!.assignments[C.primary]!.order).toBe(after.revision)
    expect(after.personas['beta']).toEqual(before.personas['beta'])
    expect(after.source).toEqual(before.source)
    expect(after.pendingIntent).toEqual(before.pendingIntent)
    expect(after.outcomes).toEqual(before.outcomes)
    check(after)
  })

  test('stale revision, nested mutation and invalid callback write nothing', () => {
    const writes: Uint8Array[] = []
    const authority = makeSharedAuthority(root, input(), { write: (_path, bytes) => { writes.push(bytes) } })
    const before = authority.snapshot()
    expect(authority.transact(0, () => { throw new Error('must not run') })).toEqual({ kind: 'stale', revision: 1 })
    for (const revision of [-1, 1, 3]) {
      expect(authority.transact(1, next => { next.revision = revision })).toEqual({ kind: 'failed', revision: 1 })
    }
    expect(writes).toEqual([])
    expect(authority.snapshot()).toEqual(before)
    expect(authority.transact(1, next => {
      expect(authority.transact(1, () => {})).toEqual({ kind: 'stale', revision: 1 })
      next.outcomes = { result: 'outer' }
    })).toEqual({ kind: 'applied', revision: 2 })
    expect(writes).toHaveLength(1)
    check(authority.snapshot())
  })

  test('subscribers see a whole durable mode, list and destination after the writer completes', () => {
    let durable = false
    const authority = makeSharedAuthority(root, input(), { write(path, bytes) { durableWriteFileSync(path, bytes); durable = true } })
    const received: unknown[] = []
    const unsubscribe = authority.subscribe(config => { expect(durable).toBe(true); received.push(config) })
    const edited = input(); edited.channel_mode = 'open'; edited.personas[0]!.channels = [{ id: C.secondary, delivery: 'thread_hybrid' }]; edited.personas[0]!.permission_prompts = C.secondary
    expect(authority.transact(authority.revision, next => { next.pendingIntent = { prepared: 'review' }; next.outcomes = { prior: 'retained' } }).kind).toBe('applied')
    received.length = 0
    durable = false
    expect(authority.applyReviewed(configBytes(edited), authority.revision).kind).toBe('applied')
    expect(received).toEqual([authority.config()])
    expect(readSharedState(root)!.applied).toEqual(authority.snapshot().applied)
    expect(readSharedState(root)!.pendingIntent).toEqual({ prepared: 'review' })
    expect(readSharedState(root)!.outcomes).toEqual({ prior: 'retained' })
    unsubscribe()
    _assignFixture(authority, 'alpha', authority.incarnation('alpha')!, C.secondary, 'off', authority.revision, mint)
    expect(received).toHaveLength(1)
    check(received)
  })

  test.each(['before-rename', 'after-rename'] as const)('%s failure preserves memory, source, pending intent and evidence', fault => {
    const initial = initialSharedState(root, input())
    initial.pendingIntent = { prepared: 'retained' }; initial.outcomes = { prior: 'retained' }
    writeSharedState(root, initial)
    const before = readFileSync(sharedChannelPath(root))
    let writes = 0
    const authority = createSharedChannelAuthority(sharedChannelPath(root), initial, { write(path, bytes) {
      writes++
      if (fault === 'after-rename') { durableWriteFileSync(path, bytes); throw new DurableWriteUnsyncedError(path, Object.assign(new Error(sentinelInMessage('unsynced')), { code: 'EIO' })) }
      throw Object.assign(new Error(sentinelInMessage('capacity')), { code: 'ENOSPC' })
    } })
    const edited = input(); edited.channel_mode = 'open'
    expect(authority.applyReviewed(configBytes(edited), 1)).toEqual({ kind: fault === 'after-rename' ? 'unresolved' : 'failed', revision: 1 })
    expect(authority.snapshot()).toEqual(initial)
    expect(authority.readable).toBe(fault === 'before-rename')
    const disk = readSharedState(root)!
    expect(disk.revision).toBe(fault === 'before-rename' ? 1 : 2)
    if (fault === 'before-rename') expect(readFileSync(authority.path)).toEqual(before)
    else {
      expect(_assignFixture(authority, 'alpha', initial.personas['alpha']!.incarnation, C.primary, 'off', 1, mint).kind).toBe('unresolved')
      expect(authority.observeMembership('alpha', initial.personas['alpha']!.incarnation, membershipJoin(C.primary, 'join'), 1).kind).toBe('unresolved')
      expect(() => authority.previewReviewed(configBytes(edited))).toThrow('unresolved')
      expect(writes).toBe(1)
      expect(createSharedChannelAuthority(authority.path, disk).config().channel_mode).toBe('open')
    }
    check({ memory: authority.snapshot(), disk })
  })

  test('snapshots cannot mutate the authority, and observer failure cannot undo its durable result', () => {
    const authority = makeSharedAuthority(root, input())
    const detached = authority.snapshot(); detached.pendingIntent['outside'] = true; detached.personas['alpha']!.assignments = {}
    authority.subscribe(() => { throw new Error('observer failed') })
    expect(_assignFixture(authority, 'alpha', authority.incarnation('alpha')!, C.primary, 'mentions', 1, mint)).toEqual({ kind: 'applied', revision: 2 })
    expect(authority.snapshot().pendingIntent).toEqual({})
    expect(readSharedState(root)!.revision).toBe(2)
    check(authority.snapshot())
  })

  // t2.yiv.sf.ht: membership recovery copies its target persona, never the whole authority.
  test('a persona snapshot clones only that persona and cannot mutate the authority', () => {
    const authority = makeSharedAuthority(root, input())
    const join = membershipJoin(C.primary, 'join')
    expect(authority.observeMembership('alpha', authority.incarnation('alpha')!, join, authority.revision).kind).toBe('applied')
    const before = authority.snapshot()
    const copies = spyOnCopies()
    let alpha: ReturnType<typeof authority.personaSnapshot>
    try {
      alpha = authority.personaSnapshot('alpha')
      expect(copies.values).toEqual([before.personas['alpha']])
      // t3.yiv.sf.ws.ih: field by field, not through a structured clone's serialisation.
      expect(copies.serialised).toBe(0)
    } finally { copies.restore() }
    expect(alpha).toEqual(before.personas['alpha'])
    alpha!.assignments = {}; alpha!.membershipEvents['join']!.channel = C.forged; alpha!.incarnation = 'forged-life'
    expect(authority.snapshot()).toEqual(before)
    expect(authority.personaSnapshot('alpha')).toEqual(before.personas['alpha'])
    expect(['gone', '__proto__', 'constructor', 'hasOwnProperty'].map(key => authority.personaSnapshot(key))).toEqual([undefined, undefined, undefined, undefined])
    check(authority.snapshot())
  })

  test('observer reentrancy cannot publish a second revision and memory matches serialized state', () => {
    const authority = makeSharedAuthority(root, input())
    const results: unknown[] = []
    authority.subscribe(() => {
      results.push(_assignFixture(authority, 'alpha', authority.incarnation('alpha')!, C.primary, 'off', authority.revision, mint))
    })
    expect(authority.transact(1, next => { next.pendingIntent['omitted'] = undefined })).toEqual({ kind: 'applied', revision: 2 })
    expect(results).toEqual([]) // metadata alone publishes no runtime change
    expect(_assignFixture(authority, 'alpha', authority.incarnation('alpha')!, C.primary, 'mentions', 2, mint)).toEqual({ kind: 'applied', revision: 3 })
    expect(results).toEqual([{ kind: 'stale', revision: 3 }])
    expect(authority.choice('alpha', C.primary)).toBe('mentions')
    expect(Object.hasOwn(authority.snapshot().pendingIntent, 'omitted')).toBe(false)
    expect(authority.snapshot()).toEqual(readSharedState(root)!)
    check(results)
  })

  test('retiring is adapter-local, rejects the held key and leaves its healthy neighbor writable', () => {
    const source = input(); source.channel_mode = 'open'
    const authority = makeSharedAuthority(root, source)
    for (const key of ['alpha', 'beta']) expect(authority.observeMembership(key, authority.incarnation(key)!, membershipJoin(C.primary, `adapter-${key}-join`, { identity: 'authenticated-app' }), authority.revision).kind).toBe('applied')
    const membership = (key: string, channel: string) => authority.personaSnapshot(key)?.membership[channel]?.member === true
    const store = createChannelDeliveryStore(authority, membership)
    store.beginRetiring(['alpha'])
    const request = deliveryAttempt('retiring-alpha', C.primary, 'off')
    const before = authority.snapshot()
    expect(store.attempt('alpha', authority.incarnation('alpha')!, request, () => undefined)).toEqual({ kind: 'inactive' })
    expect(authority.snapshot()).toEqual(before)
    expect(store.attempt('beta', authority.incarnation('beta')!, deliveryAttempt('healthy-beta', request.channel, 'mentions'), () => undefined).kind).toBe('applied')
    const fresh = createChannelDeliveryStore(authority, membership)
    expect(fresh.isRetiring('alpha')).toBe(false)
    expect(fresh.attempt('alpha', authority.incarnation('alpha')!, deliveryAttempt('fresh-alpha', request.channel, request.delivery), () => undefined).kind).toBe('applied')
    store.endRetiring(['alpha'])
    expect(store.attempt('alpha', authority.incarnation('alpha')!, request, () => undefined).kind).toBe('applied')
    check(authority.snapshot())
  })
 })

test('replaying a verified leave preserves a later future preference, while a never-joined preference has no leave evidence', () => {
  const authority = makeSharedAuthority(root, input())
  const life = authority.incarnation('alpha')!
  const leave = membershipJoin(C.primary, 'verified-leave', { member: false })
  expect(authority.observeMembership('alpha', life, leave, authority.revision).kind).toBe('applied')
  const leaveRevision = authority.revision
  expect(_assignFixture(authority, 'alpha', life, C.primary, 'thread_hybrid', authority.revision, mint).kind).toBe('applied')
  expect(_assignFixture(authority, 'alpha', life, C.future, 'mentions', authority.revision, mint).kind).toBe('applied')
  const reopened = createSharedChannelAuthority(authority.path, readSharedState(root)!)
  const before = readFileSync(authority.path)
  expect(reopened.observeMembership('alpha', life, leave, reopened.revision)).toEqual({ kind: 'applied', revision: leaveRevision })
  expect(readFileSync(authority.path)).toEqual(before)
  expect(reopened.choice('alpha', C.primary)).toBe('thread_hybrid')
  expect(reopened.choice('alpha', C.future)).toBe('mentions')
  const state = reopened.snapshot().personas['alpha']!
  expect(state.membership[C.primary]!.member).toBe(false)
  expect(state.assignments[C.primary]!.order).toBeGreaterThan(state.leaves[C.primary]!.boundary)
  expect(state.membership[C.future]).toBeUndefined()
  expect(state.leaves[C.future]).toBeUndefined()
  let writes = 0
  const unresolved = createSharedChannelAuthority(authority.path, reopened.snapshot(), { write(path, bytes) {
    writes++
    durableWriteFileSync(path, bytes)
    throw new DurableWriteUnsyncedError(path, Object.assign(new Error(sentinelInMessage('sync')), { code: 'EIO' }))
  } })
  expect(_assignFixture(unresolved, 'alpha', life, C.future, 'off', unresolved.revision, mint).kind).toBe('unresolved')
  expect(unresolved.observeMembership('alpha', life, leave, unresolved.revision).kind).toBe('unresolved')
  expect(writes).toBe(1)
  check(reopened.snapshot())
})

// Every malformed envelope is a mutation of durable production output, never a
// separately maintained authority fixture. These relationships changed in gf.
const appliedPersona = (s: SharedChannelState) => (s.applied['personas'] as Record<string, unknown>[])[0]!
test.each<{ label: string; alter: (state: SharedChannelState) => void }>([
  { label: 'reviewed bytes disagree with source', alter: s => { s.source['channel_mode'] = 'open' } },
  { label: 'applied non-channel field differs from reviewed input', alter: s => { appliedPersona(s)['stop_hook_bootstrap'] = false } },
  { label: 'declaration belongs to another key', alter: s => { s.personas['alpha']!.declaration.name = 'foreign' } },
  { label: 'two current personas share an incarnation', alter: s => { s.personas['beta']!.incarnation = s.personas['alpha']!.incarnation } },
  { label: 'current incarnation is retired', alter: s => { s.personas['beta']!.incarnation = Object.keys(s.retiredIdentities)[0]! } },
  { label: 'retired channels repeat', alter: s => { const r = Object.values(s.retiredIdentities)[0]!; r.channels.push({ ...r.channels[0]! }) } },
  { label: 'applied choice disagrees with assignment', alter: s => { appliedPersona(s)['channels'] = [{ id: C.primary, delivery: 'off' }] } },
  { label: 'membership metadata has invalid type', alter: s => { Object.assign(s.personas['alpha']!.membership[C.primary]!, { isExtSharedChannel: 'false' }) } },
  { label: 'current membership contradicts latest event', alter: s => { s.personas['alpha']!.membership[C.primary]!.member = true } },
  { label: 'membership history is incomplete', alter: s => { delete s.personas['alpha']!.membershipEvents['left'] } },
  { label: 'membership boundary disagrees with event order', alter: s => { s.personas['alpha']!.membershipEvents['joined']!.boundary++ } },
  { label: 'leave points to a join', alter: s => { s.personas['alpha']!.leaves[C.primary]!.event = 'joined' } },
  { label: 'assignment predates leave', alter: s => { s.personas['alpha']!.assignments[C.primary]!.order = s.personas['alpha']!.leaves[C.primary]!.boundary } },
  { label: 'destination proof belongs to a foreign life', alter: s => { s.personas['alpha']!.removedDestinations[C.primary]!.incarnation = s.personas['beta']!.incarnation } },
  { label: 'destination proof no longer names the configured destination', alter: s => {
    const applied = appliedPersona(s)
    const source = (s.source['personas'] as Record<string, unknown>[])[0]!
    applied['permission_prompts'] = source['permission_prompts'] = C.foreign
    for (const persona of [applied, source]) (persona['channels'] as unknown[]).push({ id: C.foreign, delivery: 'all' })
    s.personas['alpha']!.assignments[C.foreign] = { delivery: 'all', order: s.revision }
    s.sourceBytesBase64 = configBytes(s.source).toString('base64')
  } },
])('$label is refused by parser and constructor without publishing', ({ alter }) => {
  const source = input()
  const authority = makeSharedAuthority(root, source)
  source.personas[1]!.working_directory = join(root, 'replacement')
  expect(authority.applyReviewed(configBytes(source), authority.revision, [{ key: 'beta', channel: C.primary, delivery: 'all' }]).kind).toBe('applied')
  const life = authority.incarnation('alpha')!
  expect(authority.observeMembership('alpha', life, membershipJoin(C.primary, 'joined'), authority.revision).kind).toBe('applied')
  expect(authority.observeMembership('alpha', life, membershipJoin(C.primary, 'left', { member: false, boundary: authority.revision }), authority.revision).kind).toBe('applied')
  expect(_assignFixture(authority, 'alpha', life, C.primary, 'mentions', authority.revision, mint).kind).toBe('applied')
  const seed = readSharedState(root)!
  // Object property order is not a source mismatch; exact reviewed bytes stay separate.
  seed.source = Object.fromEntries(Object.entries(seed.source).reverse())
  expect(parseSharedChannelState(serializeSharedChannelState(seed), authority.path)!.sourceBytesBase64).toBe(seed.sourceBytesBase64)
  const before = readFileSync(authority.path)
  alter(seed)
  expect(() => parseSharedChannelState(serializeSharedChannelState(seed), authority.path)).toThrow()
  expect(() => createSharedChannelAuthority(authority.path, seed)).toThrow()
  expect(readFileSync(authority.path)).toEqual(before)
  check(authority.snapshot())
})

// t2.yiv.sf.in (SR-8.9): the same checks over a history whose superseded scan
// repeats were dropped. They cannot tell a dropped newest repeat (SR-3.5).
test.each<{ label: string; event: string }>([
  { label: 'the record that began a channel\'s current membership', event: RETAINED_SCAN_EVENTS.beginning },
  { label: 'the named leave that began a channel\'s current membership', event: RETAINED_SCAN_EVENTS.leave },
])('a retained scan history missing $label is refused by parser and constructor without publishing', ({ event }) => {
  const authority = makeSharedAuthority(root, input())
  const seed = retainedScanHistory(authority)
  expect(Object.keys(seed.personas['alpha']!.membershipEvents).sort()).toEqual([
    RETAINED_SCAN_EVENTS.beginning, RETAINED_SCAN_EVENTS.secondaryBeginning, RETAINED_SCAN_EVENTS.leave,
    RETAINED_SCAN_EVENTS.latest, RETAINED_SCAN_EVENTS.latestAbsence])
  expect(seed.personas['alpha']!.leaves[C.secondary]!.event).toBe(RETAINED_SCAN_EVENTS.leave)
  expect(parseSharedChannelState(serializeSharedChannelState(seed), authority.path)).toEqual(seed)
  const before = readFileSync(authority.path)
  delete seed.personas['alpha']!.membershipEvents[event]
  expect(() => parseSharedChannelState(serializeSharedChannelState(seed), authority.path)).toThrow()
  expect(() => createSharedChannelAuthority(authority.path, seed)).toThrow()
  expect(readFileSync(authority.path)).toEqual(before)
  check(authority.snapshot())
})

describe('thread fields in the production format', () => {
  const ORDERED = 'The shared channel authority has an invalid ordered assignment.'
  const MARKER = 'The shared channel authority has an invalid Thread Memory marker.'
  function refused(state: SharedChannelState, path: string, message: string) {
    expect(() => parseSharedChannelState(serializeSharedChannelState(state), path)).toThrow(message)
    expect(() => createSharedChannelAuthority(path, state)).toThrow(message)
  }
  /** Fixture alpha starts hybrid; beta stays all. */
  function hybridSeed() {
    const authority = makeSharedAuthority(root, input())
    expect(_assignFixture(authority, 'alpha', authority.incarnation('alpha')!, C.primary, 'thread_hybrid', authority.revision, mint).kind).toBe('applied')
    return { authority, seed: readSharedState(root)! }
  }

  test.each<{ label: string; alter: (state: SharedChannelState) => void }>([
    { label: 'thread_hybrid entry without Thread Hybrid Since', alter: s => { delete s.personas['alpha']!.assignments[C.primary]!.threadHybridSince } },
    { label: 'thread_hybrid entry with an empty one', alter: s => { s.personas['alpha']!.assignments[C.primary]!.threadHybridSince = '' } },
    { label: 'thread_hybrid entry with a non-string one', alter: s => { Object.assign(s.personas['alpha']!.assignments[C.primary]!, { threadHybridSince: 7 }) } },
    { label: 'all entry with one', alter: s => { s.personas['beta']!.assignments[C.primary]!.threadHybridSince = s.personas['alpha']!.assignments[C.primary]!.threadHybridSince } },
  ])('$label is refused as an invalid ordered assignment', ({ alter }) => {
    const { authority, seed } = hybridSeed()
    expect(seed.personas['alpha']!.assignments[C.primary]!.threadHybridSince).toStartWith(FIXTURE_THREAD_HYBRID_SINCE_PREFIX)
    const before = readFileSync(authority.path)
    alter(seed)
    refused(seed, authority.path, ORDERED)
    expect(readFileSync(authority.path)).toEqual(before)
    check(seed)
  })

  test('markers for current and removed keys parse and round-trip through the fixture writer and reader', () => {
    const { authority, seed } = hybridSeed()
    expect(seed.personas['gone_key']).toBeUndefined()
    const seeded = withThreadMemoryCreated(seed, ['alpha', 'gone_key'])
    writeSharedState(root, seeded)
    expect(readSharedState(root)).toEqual(seeded)
    expect(createSharedChannelAuthority(authority.path, readSharedState(root)!).threadMemoryCreatedKeys()).toEqual(['alpha', 'gone_key'])
    const cleared = withThreadMemoryCreated(seeded, [])
    expect(Object.hasOwn(cleared, 'threadMemoryCreated')).toBe(false)
    writeSharedState(root, cleared)
    expect(readSharedState(root)).toEqual(cleared)
    check(readSharedState(root))
  })

  test('each malformed marker shape is refused', () => {
    const { authority } = hybridSeed()
    expect(authority.setThreadMemoryCreated('alpha')).toEqual({ kind: 'saved' })
    const before = readFileSync(authority.path)
    const variants = malformedThreadMemoryMarkers(readSharedState(root)!)
    for (const { state } of variants) {
      refused(state, authority.path, MARKER)
      expect(() => writeSharedState(root, state)).toThrow(MARKER)
    }
    expect(readFileSync(authority.path)).toEqual(before)
    check(variants)
  })
})

 describe('identity and provenance foundations', () => {
  test('a real-path spelling preserves the life while a changed path retires it and rejects old work', () => {
    const edited = input(); const persona = edited.personas[0]!
    mkdirSync(persona.working_directory, { recursive: true })
    const alias = join(root, 'work-alias'); symlinkSync(persona.working_directory, alias)
    const authority = makeSharedAuthority(root, edited)
    const life = authority.incarnation('alpha')!
    _assignFixture(authority, 'alpha', life, C.primary, 'off', authority.revision, mint)
    persona.working_directory = alias
    expect(authority.applyReviewed(configBytes(edited), authority.revision).kind).toBe('applied')
    expect(authority.incarnation('alpha')).toBe(life)
    expect(authority.choice('alpha', C.primary)).toBe('off')
    persona.working_directory = join(root, 'replacement')
    expect(authority.applyReviewed(configBytes(edited), authority.revision, [{ key: 'alpha', channel: C.primary, delivery: 'mentions' }]).kind).toBe('applied')
    expect(authority.incarnation('alpha')).not.toBe(life)
    expect(authority.snapshot().retiredIdentities[life]!.key).toBe('alpha')
    const beforeStale = readFileSync(authority.path)
    expect(_assignFixture(authority, 'alpha', life, C.primary, 'all', authority.revision, mint).kind).toBe('stale')
    expect(readFileSync(authority.path)).toEqual(beforeStale)
    check(authority.snapshot())
  })

  test('a verified leave retains only this life’s destination provenance through production serialization', () => {
    const authority = makeSharedAuthority(root, input())
    const persona = authority.config().personas[0]!
    const incarnation = authority.incarnation(persona.key)!
    expect(authority.observeMembership(persona.key, incarnation, membershipJoin(C.primary, 'leave-event', { member: false, identity: 'authenticated-app' }), 1).kind).toBe('applied')
    const state = readSharedState(root)!
    const reopened = createSharedChannelAuthority(authority.path, state)
    expect(reopened.config().personas[0]!.channels).toEqual([])
    expect(reopened.validatesRemovedDestination(persona)).toBe(true)
    expect(reopened.validatesRemovedDestination({ ...persona, working_directory: join(root, 'other') })).toBe(false)
    const altered = structuredClone(state); altered.personas['alpha']!.incarnation = 'replacement-life'
    expect(() => parseSharedChannelState(serializeSharedChannelState(altered), authority.path)).toThrow('provenance')
    check(state)
  })

  test.each([
    (state: SharedChannelState) => { state.revision = 0 },
    (state: SharedChannelState) => { state.personas['alpha']!.assignments[C.primary]!.order = 100 },
    (state: SharedChannelState) => { state.personas['alpha']!.removedDestinations[C.primary] = { event: 'forged', boundary: 1, incarnation: state.personas['alpha']!.incarnation } },
  ])('malformed authority is refused without changing its durable bytes', alter => {
    const authority = makeSharedAuthority(root, input())
    const before = readFileSync(authority.path)
    const state = authority.snapshot(); alter(state)
    expect(() => parseSharedChannelState(serializeSharedChannelState(state), authority.path)).toThrow()
    expect(readFileSync(authority.path)).toEqual(before)
    check(authority.snapshot())
  })

  test.each([osTempDir(), '/'])('fixture writer refuses an unowned directory %s', dir => {
    expect(() => writeSharedState(dir, initialSharedState(root, input()))).toThrow('owned directory')
    assertNoLeak({ dir })
  })
 })

// The retirement revision, never JSON property order, identifies the latest reviewed source.
test.each((['strict', 'open'] as const).flatMap(mode =>
  (['off', 'mentions', 'all', 'thread_hybrid'] as const).flatMap(original =>
    [false, true].map(reorder => ({ mode, original, reorder }))),
))('repeated remove/readd uses latest source after disk reopen: $mode / $original / reordered=$reorder', ({ mode, original, reorder }) => {
  const source = input(); source.channel_mode = mode
  const alpha = source.personas[0]!
  alpha.dm = { enabled: true, contact: 'U0TEST001' }
  alpha.permission_prompts = 'dm'
  alpha.channels = [{ id: C.primary, delivery: original }]
  let authority = makeSharedAuthority(root, source)
  const sibling = authority.snapshot().personas['beta']
  const originalLife = authority.incarnation('alpha')!
  const changed = original === 'mentions' ? 'all' : 'mentions'
  const reopen = () => {
    const state = readSharedState(root)!
    if (reorder) state.retiredIdentities = Object.fromEntries(Object.entries(state.retiredIdentities).reverse())
    // Reorder the actual persisted representation, then parse it as a new process would.
    writeSharedState(root, state)
    authority = createSharedChannelAuthority(authority.path, readSharedState(root)!)
  }
  const apply = (present: boolean) => {
    const reviewed = configBytes({ ...source, personas: present ? source.personas : source.personas.slice(1) })
    expect(authority.applyReviewed(reviewed, authority.revision).kind).toBe('applied')
    reopen()
    expect(authority.sourceBytes()).toEqual(reviewed)
    expect(authority.snapshot().personas['beta']).toEqual(sibling)
  }
  apply(false)
  alpha.channels[0]!.delivery = changed
  apply(true)
  expect(authority.choice('alpha', C.primary)).toBe(changed)
  expect(authority.incarnation('alpha')).not.toBe(originalLife)
  for (let reset = 0; reset < 3; reset++) {
    const previousLife = authority.incarnation('alpha')!
    apply(false)
    const preview = authority.previewReviewed(configBytes(source))
    expect(preview.personas[0]!.channels).toEqual([])
    apply(true)
    expect(authority.incarnation('alpha')).not.toBe(previousLife)
    expect(authority.choice('alpha', C.primary)).toBeUndefined()
    expect(authority.snapshot().source).toEqual(JSON.parse(configBytes(source).toString()))
  }
  const retirements = Object.values(authority.snapshot().retiredIdentities)
  const latest = retirements.reduce((a, b) => a.order > b.order ? a : b)
  expect(new Set(retirements.map(record => record.order)).size).toBe(retirements.length)
  expect(latest.channels).toEqual(alpha.channels)
  // A fresh explicit assignment still works, but copying it through another reset does not.
  expect(authority.applyReviewed(configBytes(source), authority.revision, [
    { key: 'alpha', channel: C.primary, delivery: changed, incarnation: authority.incarnation('alpha') },
  ]).kind).toBe('applied')
  reopen()
  expect(authority.choice('alpha', C.primary)).toBe(changed)
  apply(false); apply(true)
  expect(authority.choice('alpha', C.primary)).toBeUndefined()
  check(authority.snapshot())
})

test.each(['name', 'credentials_file', 'working_directory'] as const)('replacement and return of %s cannot resurrect copied choices after reopen', field => {
  const source = input()
  const alpha = source.personas[0]!
  alpha.dm = { enabled: true, contact: 'U0TEST001' }
  alpha.permission_prompts = 'dm'
  alpha.channels = [{ id: C.primary, delivery: 'all' }]
  let authority = makeSharedAuthority(root, source)
  const sibling = authority.snapshot().personas['beta']
  const apply = () => {
    expect(authority.applyReviewed(configBytes(source), authority.revision).kind).toBe('applied')
    authority = createSharedChannelAuthority(authority.path, readSharedState(root)!)
    expect(authority.snapshot().personas['beta']).toEqual(sibling)
  }
  const original = alpha[field]
  alpha[field] = field === 'name' ? 'gamma' : join(root, `replacement-${field}`)
  apply()
  alpha.channels[0]!.delivery = 'mentions'
  apply()
  expect(authority.choice(field === 'name' ? 'gamma' : 'alpha', C.primary)).toBe('mentions')
  alpha[field] = original
  apply()
  expect(authority.choice('alpha', C.primary)).toBeUndefined()
  alpha[field] = field === 'name' ? 'gamma' : join(root, `replacement-${field}`)
  apply()
  expect(authority.choice(field === 'name' ? 'gamma' : 'alpha', C.primary)).toBeUndefined()
  check(authority.snapshot())
})

test.each(['missing', 'zero', 'fractional', 'future'] as const)('retirement order %s is refused with the specific evidence diagnostic', invalid => {
  const source = input()
  const authority = makeSharedAuthority(root, source)
  expect(authority.applyReviewed(configBytes({ ...source, personas: source.personas.slice(1) }), authority.revision).kind).toBe('applied')
  const state = authority.snapshot()
  const record = Object.values(state.retiredIdentities)[0]! as unknown as Record<string, unknown>
  if (invalid === 'missing') delete record.order
  else record.order = invalid === 'zero' ? 0 : invalid === 'fractional' ? 1.5 : state.revision + 1
  const bytes = serializeSharedChannelState(state)
  expect(() => parseSharedChannelState(bytes, authority.path)).toThrow('The shared channel authority has invalid retired identity evidence.')
  check(state)
})

import { contradictoryBotHistory, deliveryAttempt } from './test-helpers/shared-channels.ts'
test.each(['rejection-at-assignment', 'colliding-attempts'] as const)('F1: production reader rejects %s rather than trusting contradictory history', shape => {
  const config = input(); config.channel_mode = 'open'
  const authority = makeSharedAuthority(root, config)
  const store = createChannelDeliveryStore(authority, () => true)
  expect(store.attempt('alpha', authority.incarnation('alpha')!, deliveryAttempt('parser-regression', C.primary, 'all'), () => undefined).kind).toBe('applied')
  const bytes = serializeSharedChannelState(contradictoryBotHistory(authority.snapshot(), shape))
  expect(() => parseSharedChannelState(bytes, authority.path)).toThrow()
  durableWriteFileSync(authority.path, bytes)
  expect(() => readSharedState(root)).toThrow()
  check(bytes)
})

import { malformedBotHistories } from './test-helpers/shared-channels.ts'
import { botAttemptBinding, botAttemptKey, validChannelDeliveryAttemptId } from '../src/channel-delivery-attempt.ts'
import { makeMembershipHarness, membershipPage } from './test-helpers/shared-channels.ts'
test.each(['pending-at-terminal', 'pending-at-inventory'] as const)('attempt positions exclude %s while an inventory may reference the applied revision', async shape => {
  const h = makeMembershipHarness(root)
  try {
    await h.start()
    const persona = h.h.p('alpha'), channel = C.primary
    h.h.stub(persona).script.inventory.push(membershipPage([channel])); await h.scan()
    const store = createChannelDeliveryStore(h.authority, () => true)
    const request = deliveryAttempt('before-authenticated-inventory', channel, 'all')
    expect(store.attempt('alpha', h.authority.incarnation('alpha')!, request, () => undefined).kind).toBe('applied')
    const appliedRevision = h.authority.revision
    h.h.stub(persona).script.inventory.push(membershipPage([channel])); h.scanner.request('alpha'); await h.scan()
    const valid = h.authority.snapshot()
    expect(valid.personas.alpha!.membershipInventory!.observedRevision).toBe(appliedRevision)
    expect(readSharedState(root)).toEqual(valid)
    expect(createSharedChannelAuthority(h.authority.path, readSharedState(root)!).lookupBotAttempt('alpha', h.authority.incarnation('alpha')!, request)?.kind).toBe('applied')
    const bytes = serializeSharedChannelState(contradictoryBotHistory(valid, shape))
    expect(() => parseSharedChannelState(bytes, h.authority.path)).toThrow(shape === 'pending-at-terminal' ? 'Invalid durable bot attempt order.' : 'Inconsistent durable bot attempt effect.')
    durableWriteFileSync(h.authority.path, bytes)
    expect(() => readSharedState(root)).toThrow()
    expect(readFileSync(h.authority.path)).toEqual(Buffer.from(bytes))
    check(bytes)
  } finally { await h.close() }
})

test('the production reader refuses malformed typed evidence without dumping identifiers or injected data', () => {
  const config = input(); config.channel_mode = 'open'
  const authority = makeSharedAuthority(root, config), store = createChannelDeliveryStore(authority, () => true)
  const request = deliveryAttempt('valid-source-record', C.primary, 'all')
  const applied = store.attempt('alpha', authority.incarnation('alpha')!, request, () => undefined)
  expect(applied.kind).toBe('applied')
  if (applied.kind !== 'applied') throw new Error('expected a durable application')
  expect(applied.outcome.facts).toEqual({ saved: 'all', effective: 'all' })
  const valid = authority.snapshot()
  expect(parseSharedChannelState(serializeSharedChannelState(valid), authority.path)).toEqual(valid)
  expect(readSharedState(root)).toEqual(valid)
  expect(createSharedChannelAuthority(authority.path, readSharedState(root)!).lookupBotAttempt('alpha', authority.incarnation('alpha')!, request)).toEqual({ ...applied, historical: true })
  for (const { label, state } of malformedBotHistories(valid)) {
    const bytes = serializeSharedChannelState(state)
    let failure: unknown
    try { parseSharedChannelState(bytes, authority.path) } catch (error) { failure = error }
    expect(failure, label).toBeInstanceOf(Error)
    assertNoLeak(String(failure))
    expect(String(failure)).not.toContain('must-not-be-persisted')
  }
  check(authority.snapshot())
})

import { closeSync, fsyncSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import type { DurableWriteFs } from '../src/atomic-write.ts'
import { applySharedMembership, applySharedMemberships, SHARED_CHANNEL_FORMAT, sharedAppliedConfig, type SharedChannelAuthority, type SharedChannelDeps, type VerifiedSharedMembership } from '../src/shared-channels.ts'
import { channelPopulation } from './test-helpers/shared-channels.ts'
import { SR8_SHARED_LIST_CHANNELS } from './test-helpers/thread-memory.ts'
import { MEMBERSHIP_PAGE_LIMIT } from '../src/channel-membership-retry.ts'
import { heapStats } from 'bun:jsc'
describe('membership transactions copy only their persona', () => {
  const observe = (authority: SharedChannelAuthority, key: string, channel: string, member: boolean, event: string) =>
    authority.observeMembership(key, authority.incarnation(key)!, membershipObservation(authority, key, channel, member, event), authority.revision)
  const wholeState = (value: unknown) => typeof value === 'object' && value !== null && (value as { format?: unknown }).format === SHARED_CHANNEL_FORMAT
  /** An open-mode authority in `dir` whose observers record each publication
   * with the revision on disk; `whole` routes membership through `transact`. */
  function historyRun(dir: string, whole: boolean, write: NonNullable<SharedChannelDeps['write']> = durableWriteFileSync) {
    mkdirSync(dir)
    const config = input(); config.channel_mode = 'open'
    const state = initialSharedState(root, config)
    writeSharedState(dir, state)
    const writes: Buffer[] = [], seen: unknown[] = []
    let since = 0
    const authority = createSharedChannelAuthority(sharedChannelPath(dir), state, {
      write(path, bytes) { writes.push(Buffer.from(bytes)); write(path, bytes) }, threadHybridSince: () => `since-${++since}`,
    })
    if (whole) authority.transactMembership = (key, revision, change, span) => authority.transact(revision, change, span)
    const disk = () => parseSharedChannelState(readFileSync(authority.path), authority.path)!.revision
    // Settings resolved beside the authority file name its directory.
    authority.subscribe(config => seen.push(['config', authority.revision, disk(), JSON.parse(JSON.stringify(config).replaceAll(dir, '<dir>'))]))
    authority.subscribeThreadView(view => seen.push(['view', view.revision, disk(), view.personaKeys().map(key => [key, view.threadHybridChannels(key), view.stamp(key, C.secondary)])]))
    authority.watch(() => seen.push(['watch', authority.revision, disk(), authority.readable]))
    return { authority, writes, seen }
  }
  function membershipHistory(authority: SharedChannelAuthority): unknown[] {
    const store = createChannelDeliveryStore(authority, () => true)
    return [
      observe(authority, 'alpha', C.primary, true, 'EvJOIN1'),
      applyMembershipPage(authority, 'alpha', [C.secondary, C.third], 'first'),
      store.attempt('alpha', authority.incarnation('alpha')!, deliveryAttempt('equivalent-attempt', C.secondary, 'thread_hybrid'), () => undefined),
      observe(authority, 'beta', C.primary, true, 'EvJOIN2'),
      observe(authority, 'alpha', C.secondary, false, 'EvLEAVE1'),
      observe(authority, 'alpha', C.primary, false, 'EvLEAVE2'),
      observe(authority, 'alpha', C.secondary, true, 'EvREJOIN1'),
      observe(authority, 'alpha', C.secondary, true, 'EvREJOIN1'),
      applyMembershipPage(authority, 'alpha', [C.third, C.fourth], 'second'),
      authority.transactMembership('alpha', authority.revision, () => { throw new Error('refused') }),
      authority.transactMembership('alpha', authority.revision - 1, () => { throw new Error('must not run') }),
    ]
  }

  test('a membership history commits the bytes, outcomes, publications and observer order of whole-state transactions', () => {
    const clones = spyOnCopies()
    const runs = [false, true].map(whole => {
      clones.clear()
      const run = historyRun(join(root, whole ? 'whole' : 'narrow'), whole)
      return { ...run, results: membershipHistory(run.authority), copies: clones.values.filter(wholeState).length }
    })
    clones.restore()
    const [narrow, whole] = runs as [typeof runs[0], typeof runs[0]]
    // The paths differ: the bot attempt's two writes copy the whole state on
    // both; whole-state membership adds one copy per write and one for the refusal.
    expect([narrow.copies, whole.copies]).toEqual([2, 10])
    expect(narrow.results).toEqual(whole.results)
    expect(narrow.results.map(result => (result as { kind: string }).kind)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'failed', 'stale'])
    expect(narrow.writes).toEqual(whole.writes)
    expect(narrow.seen).toEqual(whole.seen)
    // Every publication follows its durable write.
    for (const entry of narrow.seen.filter(entry => (entry as unknown[])[0] !== 'watch')) expect((entry as number[])[1]).toBe((entry as number[])[2])
    expect(narrow.authority.snapshot()).toEqual(whole.authority.snapshot())
    expect(readFileSync(narrow.authority.path)).toEqual(readFileSync(whole.authority.path))
    expect(parseSharedChannelState(readFileSync(narrow.authority.path), narrow.authority.path)).toEqual(narrow.authority.snapshot())
    check([narrow.seen, narrow.authority.snapshot()])
  })

  // t3.yiv.sf.ws.ih: each observation of a batch rebuilt the persona's raw
  // channel list from all its assignments, though only the last list survives.
  test('a batch of mixed observations commits the bytes, outcomes and publications of one application per observation, deriving the raw channel list once', () => {
    const batches: Array<[string, (authority: SharedChannelAuthority) => VerifiedSharedMembership[]]> = [
      ['alpha', a => [membershipObservation(a, 'alpha', C.secondary, true, 'EvB1J2'), membershipObservation(a, 'alpha', C.primary, false, 'EvB1L1'),
        membershipObservation(a, 'alpha', C.third, true, 'EvB1J3', membershipTimestamp()), membershipObservation(a, 'alpha', C.fourth, true, 'EvB1J4')]],
      ['alpha', a => [membershipObservation(a, 'alpha', C.primary, true, 'EvB2J1'), membershipObservation(a, 'alpha', C.secondary, true, 'EvB2J2', membershipTimestamp(1000)), membershipObservation(a, 'alpha', C.third, false, 'EvB2L3')]],
      // An obsolete boundary after an applicable observation refuses the whole batch.
      ['alpha', a => [membershipObservation(a, 'alpha', C.fifth, true, 'EvB3J5'), { ...membershipObservation(a, 'alpha', C.fourth, false, 'EvB3L4'), boundary: 999 }]],
      ['beta', a => [membershipObservation(a, 'beta', C.primary, false, 'EvB4L1'), membershipObservation(a, 'beta', C.sixth, true, 'EvB4J6'), membershipObservation(a, 'beta', C.seventh, true, 'EvB4J7')]],
      ['alpha', a => [membershipObservation(a, 'alpha', C.fourth, false, 'EvB5L4'), membershipObservation(a, 'alpha', C.fifth, true, 'EvB5J5')]],
    ]
    const runs = [false, true].map(batched => {
      const run = historyRun(join(root, batched ? 'batched' : 'single'), false)
      const { authority } = run
      let minted = 0
      const mint = () => `minted-${++minted}`
      const entries = spyOn(Object, 'entries'), derivations: number[] = []
      try {
        const results = batches.map(([key, of]) => {
          const staged = of(authority), incarnation = authority.incarnation(key)!
          return authority.transactMembership(key, authority.revision, (next, order) => {
            const assignments = next.personas[key]!.assignments, first = order - staged.length + 1, before = entries.mock.calls.length
            if (batched) applySharedMemberships(next, first, key, incarnation, staged, mint)
            else staged.forEach((observation, index) => applySharedMembership(next, first + index, key, incarnation, observation, mint))
            derivations.push(entries.mock.calls.slice(before).filter(([value]) => value === assignments).length)
          }, staged.length)
        })
        return { ...run, results, derivations, minted }
      } finally { entries.mockRestore() }
    })
    const [single, batched] = runs as [typeof runs[0], typeof runs[0]]
    expect(single.results.map(result => result.kind)).toEqual(['applied', 'applied', 'failed', 'applied', 'applied'])
    expect(batched.results).toEqual(single.results)
    expect([batched.minted, batched.writes, batched.seen]).toEqual([single.minted, single.writes, single.seen])
    expect(batched.authority.snapshot()).toEqual(single.authority.snapshot())
    expect(readFileSync(batched.authority.path)).toEqual(readFileSync(single.authority.path))
    // One raw channel list per applied observation before; one per batch now.
    expect([single.derivations, batched.derivations]).toEqual([[4, 3, 3, 2], [1, 1, 1, 1]])
    check([batched.seen, batched.authority.snapshot()])
  })

  test.each([true, false])('a saved empty source keeps its removal proof after rejoin: reject deletion without writing or publishing (whole=%p)', whole => {
    const config = input()
    const alpha = config.personas[0]!
    alpha.dm = { enabled: false }
    const channel = alpha.permission_prompts!
    const writes: Uint8Array[] = []
    const authority = makeSharedAuthority(root, config, { write(path, bytes) { writes.push(bytes); durableWriteFileSync(path, bytes) } })
    if (whole) authority.transactMembership = (_key, revision, change, span) => authority.transact(revision, change, span)
    expect(observe(authority, 'alpha', channel, false, 'EvSOURCELEAVE').kind).toBe('applied')
    alpha.channels = []; alpha.stop_hook_bootstrap = false
    const source = configBytes(config)
    expect(authority.applyReviewed(source, authority.revision).kind).toBe('applied')
    expect(authority.sourceBytes()).toEqual(source)
    expect(observe(authority, 'alpha', channel, true, 'EvSOURCEREJOIN').kind).toBe('applied')
    expect(authority.config().personas[0]!.channels.map(entry => entry.id)).toEqual([channel])
    expect(authority.snapshot().personas.alpha!.removedDestinations[channel]).toBeDefined()
    const before = { memory: authority.snapshot(), disk: readFileSync(authority.path), writes: writes.length }
    const published: unknown[] = []
    authority.subscribe(config => published.push(config))
    authority.subscribeThreadView(view => published.push(view.revision))

    expect(authority.transactMembership('alpha', authority.revision, next => {
      delete next.personas.alpha!.removedDestinations[channel]
    })).toEqual({ kind: 'failed', revision: before.memory.revision })
    expect([authority.snapshot(), readFileSync(authority.path), writes.length, published, authority.readable])
      .toEqual([before.memory, before.disk, before.writes, [], true])
    const reopened = createSharedChannelAuthority(authority.path, readSharedState(root)!)
    expect(reopened.snapshot()).toEqual(before.memory)
    expect(reopened.config()).toEqual(authority.config())
    check(reopened.snapshot())
  })

  const eio = () => Object.assign(new Error(sentinelInMessage('disk')), { code: 'EIO' })
  /** Real durable writes, failing at `fault.at`: the temporary file's open,
   * write or fsync, the rename, or the directory's open after the rename. */
  function faultyWrite(fault: { at?: string }) {
    const fs: DurableWriteFs = {
      openSync: (path, flags) => { if (fault.at === (flags === 'r' ? 'directory' : 'open')) throw eio(); return openSync(path, flags) },
      writeSync: (fd, buffer, offset, length) => { if (fault.at === 'write') throw eio(); return writeSync(fd, buffer, offset, length) },
      fsyncSync: fd => { if (fault.at === 'fsync') throw eio(); fsyncSync(fd) },
      closeSync: fd => closeSync(fd),
      renameSync: (from, to) => { if (fault.at === 'rename') throw eio(); renameSync(from, to) },
      unlinkSync: path => unlinkSync(path),
    }
    return (path: string, bytes: Uint8Array) => durableWriteFileSync(path, bytes, fs)
  }
  test.each(['open', 'write', 'fsync', 'rename', 'directory'] as const)('a membership write failing at %s leaves durable and memory state consistent and retryable, as a whole-state one does', at => {
    const [narrow, whole] = [false, true].map(routed => {
      const fault: { at?: string } = {}
      const dir = join(root, routed ? 'whole' : 'narrow')
      const { authority, seen } = historyRun(dir, routed, faultyWrite(fault))
      expect(observe(authority, 'alpha', C.primary, true, 'EvSETUP').kind).toBe('applied')
      const before = { disk: readFileSync(authority.path), memory: authority.snapshot(), seen: seen.length }
      fault.at = at
      const failed = observe(authority, 'alpha', C.secondary, true, 'EvFAULT')
      const after = { failed, readable: authority.readable, cause: authority.unreadableCause, failure: authority.failure,
        disk: readFileSync(authority.path), memory: authority.snapshot(), temporary: readdirSync(dir).filter(name => name.endsWith('.tmp')), seen: seen.slice(before.seen) }
      // Memory never runs ahead of a failed or uncertain write.
      expect(after.memory).toEqual(before.memory)
      if (at === 'directory') {
        expect([failed.kind, after.readable, after.disk.equals(before.disk)]).toEqual(['unresolved', false, false])
      } else {
        expect([failed, after.readable, after.disk]).toEqual([{ kind: 'failed', revision: before.memory.revision }, true, before.disk])
      }
      expect(after.temporary).toEqual([])
      fault.at = undefined
      const retried = at === 'directory' ? authority.recoverDurability() : observe(authority, 'alpha', C.secondary, true, 'EvFAULT')
      expect(retried).toEqual({ kind: 'applied', revision: before.memory.revision + 1 })
      expect(parseSharedChannelState(readFileSync(authority.path), authority.path)).toEqual(authority.snapshot())
      return { after, retried, final: readFileSync(authority.path), memory: authority.snapshot(), seen: seen.slice(before.seen) }
    })
    expect(narrow).toEqual(whole!)
    check(narrow)
  })

  test.each<[string, (next: SharedChannelState, order: number) => void]>([
    ['throws after writing its own persona', (next, order) => { applySharedMembership(next, order, 'alpha', next.personas['alpha']!.incarnation, membershipJoin(C.additional)); throw new Error('refused') }],
    ['changes a committed record in place', next => { next.personas['alpha']!.membership[C.primary]!.member = false }],
    ['writes another persona', (next, order) => { next.personas['beta']!.assignments[C.additional] = { delivery: 'off', order } }],
    ['replaces a shared field', next => { next.pendingIntent = { forged: true } }],
    ['changes its incarnation', next => { next.personas['alpha']!.incarnation = 'forged-life' }],
    ['changes its applied entry beyond channels', next => { (next.applied['personas'] as Record<string, unknown>[])[0]!['permission_prompts'] = C.additional }],
    ['writes an invalid record', (next, order) => { next.personas['alpha']!.membership[C.additional] = { member: true, boundary: order, identity: '' } }],
  ])('a membership transaction that %s fails, writes and publishes nothing, and stays retryable', (_case, change) => {
    const writes: Uint8Array[] = []
    const authority = makeSharedAuthority(root, input(), { write(path, bytes) { writes.push(bytes); durableWriteFileSync(path, bytes) } })
    expect(observe(authority, 'alpha', C.primary, true, 'EvSETUP').kind).toBe('applied')
    const before = { memory: authority.snapshot(), disk: readFileSync(authority.path), writes: writes.length }
    const published: unknown[] = []
    authority.subscribe(config => published.push(config)); authority.subscribeThreadView(view => published.push(view.revision))
    expect(authority.transactMembership('alpha', authority.revision, change)).toEqual({ kind: 'failed', revision: before.memory.revision })
    expect([authority.snapshot(), readFileSync(authority.path), writes.length, published, authority.readable]).toEqual([before.memory, before.disk, before.writes, [], true])
    expect(observe(authority, 'alpha', C.secondary, true, 'EvRETRY')).toEqual({ kind: 'applied', revision: before.memory.revision + 1 })
    expect(readSharedState(root)).toEqual(authority.snapshot())
    check(authority.snapshot())
  })

  test('committed state is frozen: a retained draft cannot change what was published', () => {
    const authority = makeSharedAuthority(root, input())
    let kept: SharedChannelState | undefined
    expect(authority.transactMembership('alpha', authority.revision, (next, order) => {
      kept = next
      applySharedMembership(next, order, 'alpha', authority.incarnation('alpha')!, membershipJoin(C.secondary))
    }).kind).toBe('applied')
    const committed = authority.snapshot()
    expect(() => { kept!.personas['alpha']!.membership[C.secondary]!.member = false }).toThrow(TypeError)
    expect(() => { kept!.personas['beta']!.assignments = {} }).toThrow(TypeError)
    expect(() => { kept!.pendingIntent['forged'] = true }).toThrow(TypeError)
    // Readers still get detached copies they may change.
    const copy = authority.snapshot(); copy.personas['alpha']!.membership = {}
    expect([authority.snapshot(), readSharedState(root)]).toEqual([committed, committed])
    check(committed)
  })

  // t2.yiv.sf.s3: each membership outcome cloned, reserialized, reparsed and
  // revalidated the whole shared state, work that grew with the population.
  test('live membership outcomes beside SR8_SHARED_LIST_CHANNELS channels per persona copy and reparse no whole state and share untouched records', () => {
    const authority = makeSharedAuthority(root, input())
    const ids = channelPopulation(SR8_SHARED_LIST_CHANNELS).map(channel => channel.id)
    for (const key of ['alpha', 'beta']) {
      expect(authority.transact(authority.revision, (next, order) => {
        let position = order - ids.length
        for (const channel of ids) applySharedMembership(next, ++position, key, authority.incarnation(key)!, { ...membershipJoin(channel, `scan:setup:${channel}`), channelType: 'channel', isExtSharedChannel: false })
      }, ids.length).kind).toBe('applied')
    }
    const size = readFileSync(authority.path).length
    const persona = (key: string) => authority.inspectMembershipHistory(key, life => life as never) as SharedChannelState['personas'][string]
    const setup = `scan:setup:${ids[0]}`
    const [alpha, beta] = [persona('alpha'), persona('beta')]
    const clones = spyOnCopies(), parses = spyOn(JSON, 'parse')
    let outcomes: string[], copies: number, reparses: number, untouched: unknown
    try {
      outcomes = [...ids.slice(1, 6).map(channel => observe(authority, 'alpha', channel, false, `EvLEAVE${channel}`)),
        ...ids.slice(1, 6).map(channel => observe(authority, 'alpha', channel, true, `EvREJOIN${channel}`))].map(outcome => outcome.kind)
      untouched = persona('beta')
      outcomes.push(observe(authority, 'beta', C.additional, true, 'EvBETA').kind)
      copies = clones.values.filter(wholeState).length
      reparses = parses.mock.calls.filter(([text]) => typeof text === 'string' && text.length >= size).length
    } finally { clones.restore(); parses.mockRestore() }
    expect({ outcomes, copies, reparses }).toEqual({ outcomes: outcomes.map(() => 'applied'), copies: 0, reparses: 0 })
    // Another persona's outcomes share this one whole, and their own untouched records.
    expect(untouched).toBe(beta)
    expect(persona('alpha').membershipEvents[setup]).toBe(alpha.membershipEvents[setup]!)
    expect(persona('beta').membershipEvents[setup]).toBe(beta.membershipEvents[setup]!)
    expect(readSharedState(root)).toEqual(authority.snapshot())
    check(authority.snapshot())
  })

  // t3.yiv.sf.ws.ih: every commit encoded the whole state as pretty JSON again,
  // though a membership commit shares all but one persona's changed records.
  test('membership commits beside SR8_SHARED_LIST_CHANNELS channels per persona write the native pretty JSON of each state, encoding only what they changed', () => {
    function populated(dir: string, whole: boolean) {
      mkdirSync(dir)
      const config = input(); config.channel_mode = 'open'
      const state = initialSharedState(root, config)
      writeSharedState(dir, state)
      const writes: Buffer[] = []
      let since = 0
      const authority = createSharedChannelAuthority(sharedChannelPath(dir), state, {
        write(path, bytes) { writes.push(Buffer.from(bytes)); durableWriteFileSync(path, bytes) }, threadHybridSince: () => `since-${++since}`,
      })
      const ids = channelPopulation(SR8_SHARED_LIST_CHANNELS).map(channel => channel.id)
      for (const key of ['alpha', 'beta']) {
        expect(authority.transact(authority.revision, (next, order) => {
          let position = order - ids.length
          for (const channel of ids) applySharedMembership(next, ++position, key, authority.incarnation(key)!, { ...membershipJoin(channel, `scan:setup:${channel}`), channelType: 'channel', isExtSharedChannel: false })
        }, ids.length).kind).toBe('applied')
      }
      if (whole) authority.transactMembership = (key, revision, change, span) => authority.transact(revision, change, span)
      return { authority, writes, ids }
    }
    const steps = (authority: SharedChannelAuthority, ids: string[]): Array<[string, () => unknown]> => {
      const store = createChannelDeliveryStore(authority, () => true)
      return [
        // The first membership commit over a state that \`transact\` installed encodes it whole.
        ['first', () => observe(authority, 'alpha', ids[0]!, false, 'EvFIRST')],
        ...ids.slice(1, 6).map((channel): [string, () => unknown] => ['membership', () => observe(authority, 'alpha', channel, false, `EvLEAVE${channel}`)]),
        ['membership', () => applyMembershipPage(authority, 'beta', [C.primary, C.secondary, ids[7]!], 'beta')],
        ...ids.slice(1, 4).map((channel): [string, () => unknown] => ['membership', () => observe(authority, 'alpha', channel, true, `EvREJOIN${channel}`)]),
        ['duplicate', () => observe(authority, 'alpha', ids[1]!, true, `EvREJOIN${ids[1]}`)],
        ['refused', () => authority.transactMembership('alpha', authority.revision, () => { throw new Error('refused') })],
        ['membership', () => applyMembershipPage(authority, 'alpha', [C.secondary], 'alpha')],
        ['attempt', () => store.attempt('alpha', authority.incarnation('alpha')!, deliveryAttempt('encoded-attempt', C.secondary, 'thread_hybrid'), () => undefined)],
        ['first', () => observe(authority, 'beta', ids[8]!, false, 'EvAFTERATTEMPT')],
        ['membership', () => observe(authority, 'alpha', C.additional, true, 'EvNEW')],
        ['membership', () => observe(authority, 'beta', ids[8]!, true, 'EvREJOINBETA')],
      ]
    }
    const rawInput = (value: unknown) => typeof value === 'object' && value !== null && Array.isArray((value as { personas?: unknown }).personas) && !wholeState(value)
    const runs = [false, true].map(whole => {
      const { authority, writes, ids } = populated(join(root, whole ? 'whole' : 'narrow'), whole)
      const size = readFileSync(authority.path).length, start = writes.length
      const encodes = spyOn(JSON, 'stringify')
      const measured: Array<{ kind: string; writes: number; encoded: number }> = []
      const results: unknown[] = []
      try {
        for (const [kind, step] of steps(authority, ids)) {
          const calls = encodes.mock.results.length, before = writes.length
          results.push(step())
          // Pretty encodings of state objects; validation still encodes the applied configuration input whole.
          const encoded = encodes.mock.calls.slice(calls).reduce((sum, [value, , space], i) => sum +
            (space === 2 && !rawInput(value) && typeof encodes.mock.results[calls + i]!.value === 'string' ? (encodes.mock.results[calls + i]!.value as string).length : 0), 0)
          measured.push({ kind, writes: writes.length - before, encoded })
          // The bytes written last are the native pretty JSON of the installed state.
          if (writes.length > before) expect(writes.at(-1)!.toString()).toBe(JSON.stringify(authority.snapshot(), null, 2) + '\n')
        }
      } finally { encodes.mockRestore() }
      return { authority, results, writes: writes.slice(start), measured, size }
    })
    const [narrow, whole] = runs as [typeof runs[0], typeof runs[0]]
    expect(narrow.results.map(result => (result as { kind: string }).kind)).toEqual([
      'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'failed', 'applied', 'applied', 'applied', 'applied', 'applied'])
    expect(narrow.results).toEqual(whole.results)
    expect(narrow.writes).toEqual(whole.writes)
    expect(readFileSync(narrow.authority.path)).toEqual(readFileSync(whole.authority.path))
    const steady = (run: typeof narrow) => run.measured.filter(step => step.kind === 'membership')
    console.info(`membership commit encoding size=${narrow.size} narrow=${steady(narrow).map(step => step.encoded).join(' ')} whole=${steady(whole).map(step => step.encoded).join(' ')} first=${narrow.measured.filter(step => step.kind === 'first').map(step => step.encoded).join(' ')}`)
    for (const run of [narrow, whole]) {
      expect(steady(run).every(step => step.writes === 1)).toBe(true)
      expect(run.measured.filter(step => step.kind === 'duplicate' || step.kind === 'refused').map(step => step.writes)).toEqual([0, 0])
    }
    // A whole encoding per commit fails the bound. A commit now encodes the records it changed, and once
    // a container's members: the first time a commit copies it after it was encoded whole (beta's page
    // and alpha's first new assignment here).
    expect(steady(whole).every(step => step.encoded >= narrow.size)).toBe(true)
    const encoded = steady(narrow).map(step => step.encoded)
    expect(encoded.every(chars => chars < narrow.size / 2)).toBe(true)
    expect(encoded.map(chars => chars < narrow.size / 10)).toEqual(encoded.map((_, i) => i !== 5 && i !== 10))
    check(narrow.authority.snapshot())
  })

  // t3.yiv.sf.pk.tj: the encodings kept for later commits held each copied
  // container's text, which repeats its members' at every level above them:
  // about five copies of the state, growing with the membership events each
  // scan adds, until test-32's measured server outgrew its shard.
  test('repeated scans beside SR8_SHARED_LIST_CHANNELS channels per persona retain under three bytes of text per state byte they add', () => {
    const config = input(); config.channel_mode = 'open'
    const state = initialSharedState(root, config)
    writeSharedState(root, state)
    const authority = createSharedChannelAuthority(sharedChannelPath(root), state, { threadHybridSince: () => 'since' })
    const ids = channelPopulation(SR8_SHARED_LIST_CHANNELS).map(channel => channel.id)
    // One full scan of both personas: a write per page of positives. Each
    // round alternates the issuing identity, so its records are change records
    // SR-3.5 keeps and the state grows by a round of records per scan, as it
    // did when every repeat was kept. Unchanged scans now add only the width of
    // their numbers, too little to measure retained text against.
    const scan = (round: number) => {
      for (const key of ['alpha', 'beta']) for (let at = 0; at < ids.length; at += MEMBERSHIP_PAGE_LIMIT) {
        expect(applyMembershipPage(authority, key, ids.slice(at, at + MEMBERSHIP_PAGE_LIMIT), `round-${round}`, `app-${round % 2}`).kind).toBe('applied')
      }
    }
    // String text lives outside the collected heap; a full collection leaves
    // only what is retained. Read before anything else is allocated.
    const reading = () => { Bun.gc(true); Bun.gc(true); const retained = heapStats().extraMemorySize; return { retained, bytes: statSync(authority.path).size } }
    scan(0)
    const first = reading()
    for (let round = 1; round <= 10; round++) scan(round)
    const last = reading()
    const grown = (last.retained - first.retained) / (last.bytes - first.bytes)
    console.info(`retained text per state byte added: ${grown.toFixed(2)} (state ${first.bytes} -> ${last.bytes} bytes)`)
    // Measured in this file and run alone: 5.6 and 9.8 with container
    // encodings kept (029eb0f7), 1.5 and 1.9 with the records' alone.
    expect(grown).toBeLessThan(3)
    expect(readFileSync(authority.path).toString()).toBe(JSON.stringify(authority.snapshot(), null, 2) + '\n')
    check(authority.snapshot())
  })

  // t3.yiv.sf.ws.ih: each recipient of a commit parsed the applied
  // configuration again, including the listeners that read none of it.
  test('commits give each configuration reader its own copy of the configuration they validated, and call configuration-free listeners in subscription order with none', () => {
    const dir = join(root, 'listeners'); mkdirSync(dir)
    const config = input(); config.channel_mode = 'open'
    const state = initialSharedState(root, config)
    writeSharedState(dir, state)
    const authority = createSharedChannelAuthority(sharedChannelPath(dir), state, { threadHybridSince: () => 'since' })
    type Config = ReturnType<typeof authority.config>
    const calls: Array<[string, number]> = [], received: Array<{ config: Config; state: SharedChannelState }> = []
    const reader = (name: string) => (config: Config) => { calls.push([name, 1]); received.push({ config, state: authority.snapshot() }) }
    authority.subscribe(reader('first'))
    authority.subscribeChange((...args: unknown[]) => { calls.push(['plain', args.length]) })
    authority.subscribe(reader('second'))
    const late = authority.subscribeChange((...args: unknown[]) => { calls.push(['late', args.length]) })
    const publish = reader('publish')
    const beta = (next: SharedChannelState, order: number) => applySharedMembership(next, order, 'beta', authority.incarnation('beta')!, membershipJoin(C.third, 'EvBETA'))
    const parses = spyOn(authority, 'config'), copies = spyOnCopies()
    // A parsed configuration, not the raw applied input that whole-state copies carry.
    const configCopy = (value: unknown) => typeof value === 'object' && value !== null && !wholeState(value) && 'reply_chunk_limit' in value &&
      Array.isArray((value as Config).personas) && (value as Config).personas.every(persona => typeof persona.key === 'string')
    let results: string[], parsed: number, copied: number[]
    try {
      const counted = (step: () => { kind: string }) => { const before = copies.values.filter(configCopy).length; const kind = step().kind; return [kind, copies.values.filter(configCopy).length - before] as const }
      const steps = [
        counted(() => observe(authority, 'alpha', C.primary, true, 'EvJOIN')),
        counted(() => authority.transact(authority.revision, beta, 1, publish)),
        // A metadata commit publishes the configuration but notifies no listener.
        counted(() => authority.transact(authority.revision, next => { next.threadMemoryCreated = { alpha: true } }, 1, publish)),
        counted(() => { late(); return observe(authority, 'alpha', C.primary, false, 'EvLEAVE') }),
      ]
      results = steps.map(([kind]) => kind)
      copied = steps.map(([, count]) => count)
      parsed = parses.mock.calls.length
    } finally { copies.restore(); parses.mockRestore() }
    expect(results).toEqual(['applied', 'applied', 'applied', 'applied'])
    // One parse per recipient before; now the commit's own validated configuration, copied for the publisher and for all but its last reader.
    expect({ parsed, copied }).toEqual({ parsed: 0, copied: [1, 2, 1, 1] })
    const first: [string, number] = ['first', 1], plain: [string, number] = ['plain', 0], second: [string, number] = ['second', 1], publisher: [string, number] = ['publish', 1]
    expect(calls).toEqual([first, plain, second, ['late', 0], publisher, first, plain, second, ['late', 0], publisher, first, plain, second])
    // Every recipient owns its configuration: what parsing the installed state gives.
    const configs = received.map(({ config }) => config)
    expect(new Set(configs).size).toBe(configs.length)
    expect(new Set(configs.map(config => config.personas[0])).size).toBe(configs.length)
    expect(new Set(received.map(({ state }) => state.revision)).size).toBe(4)
    for (const { config, state } of received) expect(config).toEqual(sharedAppliedConfig(state, authority.path))
    configs[0]!.personas.length = 0
    expect(configs[1]!.personas).toHaveLength(2)
    check(authority.snapshot())
  })

  function openAuthority(name: string) {
    const dir = join(root, name); mkdirSync(dir)
    const config = input(); config.channel_mode = 'open'
    const state = initialSharedState(root, config)
    writeSharedState(dir, state)
    return createSharedChannelAuthority(sharedChannelPath(dir), state, { threadHybridSince: () => 'since' })
  }
  const joinBeta = (authority: SharedChannelAuthority) => (next: SharedChannelState, order: number) =>
    applySharedMembership(next, order, 'beta', authority.incarnation('beta')!, membershipJoin(C.third, 'EvBETA'))

  // review-r1 R2: commits took their listeners before the publisher and the
  // thread-view callbacks ran, as the old path did after them, so a listener
  // those callbacks removed still ran and one they added did not.
  test('a commit notifies the listeners subscribed once its publisher and thread-view callbacks have run, each reader with its own configuration', () => {
    const authority = openAuthority('boundary')
    type Config = ReturnType<typeof authority.config>
    const calls: string[] = [], received: Array<{ name: string; config: Config; state: SharedChannelState }> = []
    const reader = (name: string) => (config: Config) => { calls.push(name); received.push({ name, config, state: authority.snapshot() }) }
    const plain = (name: string) => () => { calls.push(name) }
    let phase = ''
    const removedByPublisher = authority.subscribe(reader('removed by publisher'))
    const removedByView = authority.subscribeChange(plain('removed by view'))
    const kept = authority.subscribe(reader('kept'))
    authority.subscribeThreadView(() => {
      calls.push(`view: ${phase}`)
      if (phase === 'publisher commit') { removedByView(); authority.subscribe(reader('added by view')) }
      else { kept(); authority.subscribeChange(plain('added by view again')) }
    })
    const publish = (config: Config) => {
      calls.push('publisher')
      received.push({ name: 'publisher', config, state: authority.snapshot() })
      removedByPublisher(); authority.subscribeChange(plain('added by publisher')); authority.subscribe(reader('reader added by publisher'))
      config.personas.length = 0
    }
    phase = 'publisher commit'
    expect(authority.transact(authority.revision, joinBeta(authority), 1, publish).kind).toBe('applied')
    const first = calls.splice(0)
    phase = 'membership commit'
    expect(observe(authority, 'alpha', C.primary, true, 'EvJOIN').kind).toBe('applied')
    // The old path's recipients: the listeners as subscribed after both callbacks.
    expect([first, calls]).toEqual([
      ['publisher', 'view: publisher commit', 'kept', 'added by publisher', 'reader added by publisher', 'added by view'],
      ['view: membership commit', 'added by publisher', 'reader added by publisher', 'added by view', 'added by view again'],
    ])
    // Each recipient owns what parsing its installed state gives; the publisher changed only its own copy.
    const configs = received.map(({ config }) => config)
    expect(new Set(configs).size).toBe(configs.length)
    expect(received.map(({ name, state }) => [name, state.revision])).toEqual([['publisher', 2], ['kept', 2], ['reader added by publisher', 2], ['added by view', 2], ['reader added by publisher', 3], ['added by view', 3]])
    expect(configs[0]!.personas).toHaveLength(0)
    for (const { config, state } of received.slice(1)) expect(config).toEqual(sharedAppliedConfig(state, authority.path))
    check(authority.snapshot())
  })

  test('a publisher\'s configuration is its own when it subscribes the commit\'s only reader', () => {
    const authority = openAuthority('lone-publisher')
    type Config = ReturnType<typeof authority.config>
    const published: Config[] = [], read: Config[] = []
    expect(authority.transact(authority.revision, joinBeta(authority), 1, config => {
      published.push(config)
      authority.subscribe(config => read.push(config))
      config.personas.length = 0
    }).kind).toBe('applied')
    expect(read).toHaveLength(1)
    expect(read[0]).not.toBe(published[0])
    expect(read[0]).toEqual(sharedAppliedConfig(authority.snapshot(), authority.path))
    expect(read[0]!.personas).toHaveLength(2)
  })

  // review-r1 R1 sweep: a membership commit reused a committed object's
  // encoding without reading it again, so a hook a draft installed ran only
  // when first encoded, or never, where the old path's whole encoding ran it
  // at every commit. review-r2 R2: an own `toJSON`, enumerable or not, on a
  // copied object or array. Counts and bytes are the old path's (HEAD).
  const hooks: Array<[string, (next: SharedChannelState, call: () => void) => void, number[]]> = [
    ['an enumerable accessor on a copied map', (next, call) => {
      const membership = next.personas['alpha']!.membership, record = membership[C.primary]
      Object.defineProperty(membership, C.primary, { get() { call(); return record }, enumerable: true, configurable: true })
    }, [4, 1, 1]],
    ['a non-enumerable toJSON getter on a copied map', (next, call) => {
      Object.defineProperty(next.personas['alpha']!.membership, 'toJSON', { get() { call(); return undefined }, enumerable: false, configurable: true })
    }, [1, 1, 1]],
    ['a non-enumerable toJSON method on a copied map', (next, call) => {
      Object.defineProperty(next.personas['alpha']!.membership, 'toJSON', { value() { call(); return {} }, enumerable: false, configurable: true })
    }, [1, 1, 1]],
    ['a non-enumerable toJSON method on a copied array', (next, call) => {
      Object.defineProperty(next.applied['personas'], 'toJSON', { value(this: unknown[]) { call(); return Array.from(this) }, enumerable: false, configurable: true })
    }, [2, 0, 0]],
  ]
  test.each(hooks)('%s runs at each later commit\'s encoding as the native encoder of the whole state ran it, with its bytes', (_, install, expected) => {
    const authority = makeSharedAuthority(root, input())
    expect(observe(authority, 'alpha', C.primary, true, 'EvJOIN1').kind).toBe('applied')
    let calls = 0
    const call = () => { calls++ }
    const counted = (step: () => { kind: string }) => { const before = calls; expect(step().kind).toBe('applied'); return calls - before }
    const perCommit = [counted(() => authority.transactMembership('alpha', authority.revision, (next, order) => {
      applySharedMembership(next, order, 'alpha', authority.incarnation('alpha')!, membershipJoin(C.secondary))
      install(next, call)
    }))]
    for (const [channel, event] of [[C.third, 'EvBETA3'], [C.fourth, 'EvBETA4']] as const) perCommit.push(counted(() => observe(authority, 'beta', channel, true, event)))
    expect(perCommit).toEqual(expected)
    // The bytes the native encoder gives the installed state: alpha's committed life as it encodes, hooks run.
    const state = authority.snapshot()
    state.personas['alpha'] = JSON.parse(JSON.stringify(authority.inspectMembershipHistory('alpha', life => life as never)))
    expect(readFileSync(authority.path).toString()).toBe(JSON.stringify(state, null, 2) + '\n')
  })
})
test('attempt identifiers preserve exact code units and cannot collide after Unicode replacement or trimming', () => {
  const values = ['retained', ' retained ', '\ud800', '\ufffd', '😀', '😀 ']
  const keys = values.map(id => {
    expect(validChannelDeliveryAttemptId(id)).toBe(true)
    return botAttemptKey(botAttemptBinding('alpha', 'same-life', deliveryAttempt(id, C.primary, 'all')))
  })
  expect(new Set(keys).size).toBe(values.length)
  expect(validChannelDeliveryAttemptId(' \r\n\t')).toBe(false)
  assertNoLeak(keys)
})
