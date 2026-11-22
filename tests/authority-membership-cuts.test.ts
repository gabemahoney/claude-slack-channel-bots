/** b.o83 P1-P4: deterministic work guards, with independent behavior controls.
 * No timing verdict: the existing hold limits remain in their measured suite. */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { durableWriteFileSync, DurableWriteUnsyncedError } from '../src/atomic-write.ts'
import { createSharedChannelAuthority, parseSharedChannelState,
  type SharedChannelAuthority, type SharedChannelState, type SharedMembershipInventory, type SharedThreadView } from '../src/shared-channels.ts'
import { _assignFixture, channelPopulation, configBytes, fixtureThreadHybridSince, makeMembershipHarness,
  makeSharedAuthority, membershipJoin, membershipPage, sharedRecoveryRequest,
  SHARED_CHANNEL_IDS as C, type MembershipHarness } from './test-helpers/shared-channels.ts'
import { makePersona, makePersonaConfigInput } from './test-helpers/persona-config.ts'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'
import { AUTHORITY_FIXTURE_TIMEOUT_MS, AUTHORITY_POPULATIONS, makeAuthorityCostRig } from './test-helpers/authority-cost.ts'
import { prepareMembershipScan, verifyMembershipWrite } from './test-helpers/authority-membership.ts'
import { makeReloadHarness } from './test-helpers/reload-harness.ts'
import { activationRecord } from './test-helpers/shared-channels.ts'

const RECORD_MAPS = new Set(['assignments', 'membership', 'membershipEvents', 'leaves', 'removedDestinations',
  'membershipEvidence', 'membershipAbsenceConflicts', 'installationReadiness'])
/** Observe the completed signature's distinctive pair-array shape. Count the
 * whole-list calculation, never a stamp read by an observer or full reader. */
function isSignature(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(pair => Array.isArray(pair) && pair.length === 2 &&
    typeof pair[0] === 'string' && Array.isArray(pair[1]) && pair[1].every((entry: unknown) =>
      Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' &&
      !!entry[1] && typeof entry[1] === 'object' && ['decided', 'undecided'].includes(entry[1].kind)))
}
function signatureWork<T>(run: () => T) {
  let rebuilds = 0
  const stringify = JSON.stringify
  const spy = spyOn(JSON, 'stringify').mockImplementation((...args: unknown[]) => {
    if (isSignature(args[0])) rebuilds++
    return Reflect.apply(stringify, JSON, args)
  })
  try { return { result: run(), get rebuilds() { return rebuilds } } } finally { spy.mockRestore() }
}

/** Map.set records the actual shallow-copy registrations. Restoration reads
 * own property names of those maps. Retention's newest-event map is the only
 * channel -> numeric-position Map in this operation (history validation maps
 * channels to event objects, positions to strings). All spies are passive. */
async function frameWork(channels: readonly string[], run: () => Promise<void>) {
  const ids = new Set(channels), copies = new Set<object>()
  const counts = { copies: 0, restores: 0, retentionPositions: 0 }
  const set = Map.prototype.set, names = Object.getOwnPropertyNames
  const mapSpy = spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (typeof key === 'string' && RECORD_MAPS.has(key) && value && typeof value === 'object') {
      counts.copies++; copies.add(value)
    }
    if (typeof key === 'string' && ids.has(key) && typeof value === 'number') counts.retentionPositions++
    return set.call(this, key, value)
  })
  const namesSpy = spyOn(Object, 'getOwnPropertyNames').mockImplementation(value => {
    if (copies.has(value)) counts.restores++
    return names(value)
  })
  try { await run(); return counts } finally { namesSpy.mockRestore(); mapSpy.mockRestore() }
}

describe('P1/P4 real no-absence inventory at both retained-attempt populations', () => {
  const observations = new Map<number, { snapshots: number; copies: number; restores: number; retentionPositions: number }>()
  beforeAll(async () => {
    for (const population of AUTHORITY_POPULATIONS) {
      const r = await makeAuthorityCostRig(population)
      const seen: Array<{ kind: string; revision: number; writes: number }> = []
      const record = (kind: string) => seen.push({ kind, revision: r.authority.revision, writes: r.writes.length })
      const stops = [r.authority.subscribeThreadView(() => record('thread')), r.authority.subscribe(() => record('config')),
        r.authority.subscribeChange(() => record('change'))]
      try {
        const scan = await prepareMembershipScan(r)
        await scan.operation('page'); await r.collect('cuts.first-page'); await scan.remaining()
        const before = r.authority.snapshot(), cp = r.run.checkpoint()
        seen.length = 0
        const snapshot = spyOn(r.authority, 'personaSnapshot')
        let snapshots = 0
        let frame: Awaited<ReturnType<typeof frameWork>>
        try {
          frame = await frameWork(scan.channels, () => scan.operation('inventory'))
          snapshots = snapshot.mock.calls.length
        } finally { snapshot.mockRestore() }
        observations.set(population, { snapshots, ...frame })
        console.log('AUTHORITY-MEMBERSHIP-CUTS', JSON.stringify({ population, snapshots, ...frame }))
        verifyMembershipWrite(r, before.revision, 'inventory', before, scan.channels)
        const after = r.authority.snapshot(), previous = before.personas.beta!.membershipInventory!
        expect(after.personas.beta!.membershipInventory).toEqual({ ...previous, recordedOrder: before.revision + 1,
          observedThrough: (r.run.membershipClock.now() / 1000).toFixed(3),
          observedRevision: before.revision - scan.channels.length })
        expect(seen).toEqual(['thread', 'config', 'change'].map(kind => ({ kind, revision: before.revision + 1, writes: 1 })))
        expect(r.run.since(cp).writes.map(w => ({ authority: w.path === r.h.paths.lastApplied, ok: w.ok })))
          .toEqual([{ authority: true, ok: true }])
        await r.collect('cuts.inventory'); r.restart()
        expect(r.leakFailures).toEqual([])
      } finally {
        try { stops.forEach(stop => stop()) }
        finally {
          try {
            try { assertNoLeak(r.captured()) }
            finally { expect(r.leakFailures).toEqual([]) }
          } finally { await r.close() }
        }
      }
    }
  }, AUTHORITY_FIXTURE_TIMEOUT_MS)
  for (const population of AUTHORITY_POPULATIONS) {
    test(`P1 ${population}: no detached persona snapshot`, () => expect(observations.get(population)!.snapshots).toBe(0))
    test(`P4 ${population}: no record-map copies`, () => expect(observations.get(population)!.copies).toBe(0))
    test(`P4 ${population}: no copied-map restoration`, () => expect(observations.get(population)!.restores).toBe(0))
    test(`P4 ${population}: retention is a no-op before walking event history`, () => expect(observations.get(population)!.retentionPositions).toBe(0))
  }
})

let root: string, sequence = 0
const harnesses: MembershipHarness[] = [], captures: unknown[] = [], output: unknown[] = []
const restoreConsole: Array<() => void> = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'authority-membership-cuts-'))
  for (const method of ['log', 'warn', 'error', 'info', 'debug', 'trace'] as const) {
    const spy = spyOn(console, method).mockImplementation((...args: unknown[]) => { output.push(args) })
    restoreConsole.push(() => spy.mockRestore())
  }
})
afterEach(async () => {
  try {
    for (const f of harnesses.splice(0)) { await f.close(); assertNoLeak(f.captured()) }
    assertNoLeak({ captures, output, files: writtenFile(root) })
  } finally {
    restoreConsole.splice(0).forEach(stop => stop()); captures.length = 0; output.length = 0
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const dir = join(root, String(sequence++)); mkdirSync(dir)
  const f = makeMembershipHarness(dir, { channels: [{ id: C.primary, delivery: 'all' }] })
  harnesses.push(f); return f
}
const life = (f: MembershipHarness) => f.authority.snapshot().personas.alpha!
const inventory = (f: MembershipHarness, absent = new Map<string, number>()) => ({ scanId: `cuts-${sequence++}`,
  observedThrough: ((f.h.clock.now() + 2) / 1000).toFixed(3), observedRevision: f.authority.revision, absent })
function reopen(a: SharedChannelAuthority) {
  const bytes = readFileSync(a.path), parsed = parseSharedChannelState(bytes, a.path)!
  expect(parsed).toEqual(a.snapshot())
  expect(createSharedChannelAuthority(a.path, parsed).snapshot()).toEqual(parsed)
  return parsed
}
async function ready(f: MembershipHarness) {
  f.h.stub(f.h.p('alpha')).script.inventory.push(membershipPage([C.primary]))
  await f.start(); await f.scan()
  expect(f.membership.read('alpha', C.primary, 'open').kind).toBe('eligible')
}
async function withSnapshotCount(f: MembershipHarness, run: () => void) {
  const spy = spyOn(f.authority, 'personaSnapshot')
  try { run(); return spy.mock.calls.length } finally { spy.mockRestore() }
}

test.each(['absence', 'missed-leave', 'conflict', 'recovery'] as const)('P1/P4 %s control keeps snapshot, general frame and exact history', async kind => {
  const f = fixture(); await ready(f)
  let observedRevision = f.authority.revision
  if (kind === 'missed-leave') { await f.event(false, C.primary, { id: 'EvLEFT' }); observedRevision = f.authority.revision }
  if (kind === 'conflict') expect(_assignFixture(f.authority, 'alpha', f.authority.incarnation('alpha')!, C.primary, 'off',
    f.authority.revision, f.threadHybridSince).kind).toBe('applied')
  if (kind === 'recovery') {
    const timestamp = ((f.h.clock.now() + 1) / 1000).toFixed(3)
    await f.event(true, C.primary, { id: 'EvRECOVERJOIN', timestamp })
    await f.event(false, C.primary, { id: 'EvRECOVER', timestamp })
    expect(life(f).membershipEvidence!.EvRECOVER!.state).toBe('conflict')
    expect(f.membership.hasUnresolved('alpha', C.primary)).toBe(true)
  }
  const before = f.authority.snapshot(), boundary = life(f).membership[C.primary]!.boundary
  const inv = { ...inventory(f, new Map([[C.primary, boundary]])), observedRevision }
  const count = f.writes.length
  let result: { kind: string } | undefined, snapshots = 0
  const frame = await frameWork([C.primary], async () => {
    snapshots = await withSnapshotCount(f, () => { result = f.membership.commitInventory(f.membership.generation('alpha')!, inv) })
  })
  expect(snapshots).toBeGreaterThan(0); expect(frame.copies).toBeGreaterThan(0)
  const after = life(f), delta = f.authority.revision - before.revision
  expect(f.writes.length - count).toBe(1)
  if (kind === 'conflict') {
    expect(result!.kind).toBe('unresolved'); expect(delta).toBe(1)
    expect(after.membershipInventory).toEqual(before.personas.alpha!.membershipInventory)
    expect(after.assignments).toEqual(before.personas.alpha!.assignments)
    expect(after.membershipAbsenceConflicts![C.primary]).toEqual({ identity: f.membership.generation('alpha')!.identityKey,
      boundary, observedThrough: inv.observedThrough, observedRevision,
      assignmentOrder: before.personas.alpha!.assignments[C.primary]!.order, recordedOrder: f.authority.revision })
  } else {
    expect(result!.kind).toBe('applied'); expect(delta).toBe(kind === 'recovery' ? 3 : 2)
    expect(after.membershipInventory!.recordedOrder).toBe(f.authority.revision)
    expect(after.membershipEvents[`scan:${inv.scanId}:absent:${C.primary}`]!.order).toBe(f.authority.revision - 1)
    expect(after.assignments[C.primary]).toBeUndefined()
    expect(after.membership[C.primary]!.member).toBe(false)
    if (kind === 'recovery') {
      expect(after.membershipEvidence!.EvRECOVER!.state).toBe('applied')
      expect(after.membershipEvents.EvRECOVER!.order).toBe(before.revision + 1)
      expect(f.membership.hasUnresolved('alpha', C.primary)).toBe(false)
    }
    if (kind === 'missed-leave') expect(after.leaves[C.primary]).toEqual(before.personas.alpha!.leaves[C.primary])
  }
  reopen(f.authority)
})

function simpleRig(count = 1) {
  const dir = join(root, String(sequence++)); mkdirSync(dir)
  const input = makePersonaConfigInput({ channel_mode: 'open', personas: ['alpha', 'beta'].map((name, i) =>
    makePersona({ name, channels: channelPopulation(count, i * count), permission_prompts: 'dm', dm: { enabled: true, contact: 'U0OPERATOR' } }, dir)) }, dir)
  const writes: Buffer[] = []
  let fault: 'none' | 'before' | 'unsynced' = 'none'
  const a = makeSharedAuthority(dir, input, { write(path, bytes) {
    writes.push(Buffer.from(bytes)); captures.push({ path, bytes: Buffer.from(bytes) })
    if (fault === 'before') throw Object.assign(new Error('fixture before rename'), { code: 'EIO' })
    durableWriteFileSync(path, bytes)
    if (fault === 'unsynced') throw new DurableWriteUnsyncedError(path, { code: 'EIO' })
  } })
  return { a, writes, fault(value: typeof fault) { fault = value } }
}
function listVisits(a: SharedChannelAuthority, run: () => void) {
  const config = a.config(), siblingIds = new Set(config.personas[0]!.channels.map(c => c.id)), touchedIds = new Set(config.personas[1]!.channels.map(c => c.id))
  const counts = { sibling: 0, touched: 0 }, some = Array.prototype.some
  const spy = spyOn(Array.prototype, 'some').mockImplementation(function (this: unknown[], predicate, thisArg) {
    const first = this[0] as { id?: string } | undefined
    const which = first?.id && (siblingIds.has(first.id) ? 'sibling' : touchedIds.has(first.id) ? 'touched' : undefined)
    return some.call(this, (value, index, array) => {
      if (which) counts[which]++
      return predicate.call(thisArg, value, index, array)
    })
  })
  try { run(); return counts } finally { spy.mockRestore() }
}
test('P3 canonical reused config: zero sibling predicate visits and exactly 1,100 touched visits', () => {
  const { a } = simpleRig(1100)
  const visits = listVisits(a, () => expect(a.transactMembership('beta', a.revision, () => {}).kind).toBe('applied'))
  captures.push(visits)
  expect(visits.touched).toBe(1100)
  expect(visits.sibling).toBe(0)
})
test('P3 native/unproved input sensitivity: sibling list predicates still run', () => {
  const { a } = simpleRig(1100)
  const visits = listVisits(a, () => expect(a.transactMembership('beta', a.revision, next => {
    Object.defineProperty(next, 'toJSON', { value(this: SharedChannelState) { return { ...this } } })
  }).kind).toBe('applied'))
  expect(visits.sibling).toBeGreaterThan(0); expect(visits.touched).toBeGreaterThanOrEqual(1100)
  reopen(a)
})

function viewValue(view: SharedThreadView, channels: string[]) {
  return { revision: view.revision, keys: view.personaKeys(), values: view.personaKeys().map(key =>
    [key, view.threadHybridChannels(key), channels.map(channel => [channel, view.stamp(key, channel)])]) }
}
function publicationProbe(a: SharedChannelAuthority) {
  const channels = [...new Set([...a.channels('alpha'), ...a.channels('beta'), C.primary, C.secondary])]
  const rows: Array<{ kind: string; revision: number; disk: number }> = [], views: unknown[] = [], mismatches: unknown[] = []
  const record = (kind: string) => rows.push({ kind, revision: a.revision,
    disk: parseSharedChannelState(readFileSync(a.path), a.path)!.revision })
  a.subscribeThreadView(view => {
    try {
      record('thread'); views.push(viewValue(view, channels))
      const direct = a.threadView()
      if (JSON.stringify(viewValue(view, channels)) !== JSON.stringify(viewValue(direct, channels))) mismatches.push('view')
      for (const key of view.personaKeys()) for (const channel of channels) {
        if (JSON.stringify(view.stamp(key, channel)) !== JSON.stringify(a.channelStamp(key, channel))) mismatches.push([key, channel])
      }
    } catch (error) { mismatches.push(error) }
  })
  a.subscribe(() => record('config')); a.subscribeChange(() => record('change'))
  return { rows, views, mismatches }
}
test('P2 unchanged repeated positives and cutoff writes reuse signature but publish current revision in durable order', async () => {
  const f = fixture(); await ready(f)
  const a = f.authority, before = a.revision, p = publicationProbe(a), rebuilds: number[] = []
  for (let i = 0; i < 3; i++) {
    const positive = signatureWork(() => a.observeMembership('alpha', a.incarnation('alpha')!, membershipJoin(C.primary, `repeat-${i}`, {
      identity: life(f).membership[C.primary]!.identity, boundary: a.lifetime('alpha', C.primary)!.membershipBoundary,
    }), a.revision))
    expect(positive.result.kind).toBe('applied'); rebuilds.push(positive.rebuilds)
    const inv = inventory(f)
    rebuilds.push(signatureWork(() => expect(f.membership.commitInventory(f.membership.generation('alpha')!, inv).kind).toBe('applied')).rebuilds)
  }
  expect(a.revision).toBe(before + 6); expect(p.mismatches).toEqual([])
  expect(p.rows).toEqual(Array.from({ length: 6 }, (_, i) => ['thread', 'config', 'change'].map(kind =>
    ({ kind, revision: before + i + 1, disk: before + i + 1 }))).flat())
  expect(p.views).toHaveLength(6)
  const opened = createSharedChannelAuthority(a.path, reopen(a))
  expect(viewValue(a.threadView(), [C.primary, C.secondary])).toEqual(viewValue(opened.threadView(), [C.primary, C.secondary]))
  expect(rebuilds).toEqual([0, 0, 0, 0, 0, 0])
})

test.each(['assignment', 'same-value assignment', 'persona replacement', 'leave', 'rejoin', 'uncertainty', 'durability recovery',
  'restoration staging', 'native encoding', 'after native encoding'] as const)('P2 invalidation rebuilds: %s', kind => {
  const r = simpleRig(), { a } = r, channel = a.channels('alpha')[0]!, mint = fixtureThreadHybridSince(a.snapshot())
  const observe = (member: boolean, event: string) => a.observeMembership('alpha', a.incarnation('alpha')!,
    membershipJoin(channel, event, { member, boundary: a.lifetime('alpha', channel)!.membershipBoundary }), a.revision)
  expect(observe(true, 'initial').kind).toBe('applied')
  if (kind === 'rejoin') expect(observe(false, 'left').kind).toBe('applied')
  if (kind === 'durability recovery') { r.fault('unsynced'); expect(observe(false, 'uncertain').kind).toBe('unresolved'); r.fault('none') }
  if (kind === 'after native encoding') expect(a.transactMembership('alpha', a.revision, next => {
    Object.defineProperty(next, 'toJSON', { value(this: SharedChannelState) { return { ...this } } })
  }).kind).toBe('applied')
  const p = publicationProbe(a)
  const work = signatureWork(() => {
    switch (kind) {
      case 'assignment': case 'same-value assignment': return _assignFixture(a, 'alpha', a.incarnation('alpha')!, channel,
        kind === 'assignment' ? 'thread_hybrid' : a.choice('alpha', channel)!, a.revision, mint)
      case 'persona replacement': {
        const source = a.snapshot().source
        ;(source.personas as Array<Record<string, unknown>>)[0]!.working_directory = join(root, 'replacement')
        return a.applyReviewed(configBytes(source), a.revision)
      }
      case 'leave': return observe(false, 'left')
      case 'rejoin': return observe(true, 'rejoined')
      case 'uncertainty': r.fault('unsynced'); return observe(false, 'uncertain')
      case 'durability recovery': return a.recoverDurability()
      case 'restoration staging': {
        const damaged = Buffer.from('damaged fixture authority'); durableWriteFileSync(a.path, damaged)
        return a.stageRestoration(sharedRecoveryRequest('cuts-stage', damaged), damaged, a.sourceBytes())
      }
      case 'native encoding': return a.transactMembership('alpha', a.revision, next => {
        Object.defineProperty(next, 'toJSON', { value(this: SharedChannelState) { return { ...this } } })
      })
      case 'after native encoding': return observe(true, 'after-native')
    }
  })
  expect(work.result.kind).toBe(['uncertainty', 'restoration staging'].includes(kind) ? 'unresolved' : 'applied')
  expect(work.rebuilds).toBeGreaterThan(0); expect(p.mismatches).toEqual([])
  expect(p.rows.filter(row => row.kind === 'thread')).toHaveLength(kind === 'native encoding' ? 0 : 1)
  if (kind === 'uncertainty' || kind === 'restoration staging') expect(p.rows.map(row => row.kind)).toEqual(['thread'])
  else if (kind === 'native encoding') { expect(p.rows).toEqual([]); reopen(a) }
  else {
    expect(p.rows.map(row => row.kind)).toEqual(['thread', 'config', 'change'])
    expect(p.rows.every(row => row.revision === a.revision && row.disk === a.revision)).toBe(true)
    reopen(a)
  }
})

test('P2 interrupted retirement hold and release rebuild signatures on the real reload owner', async () => {
  const h = makeReloadHarness()
  let armed = false
  try {
    const alpha = h.persona('alpha'), beta = h.persona('beta'); h.materialize(alpha, beta)
    h.writeConfig({ personas: [alpha, beta] })
    const run = await h.startDetecting({ beforeWrite(path, bytes) {
      if (armed && path === h.paths.lastApplied && activationRecord(bytes, path)) h.failWrites({ code: 'EIO' })
    } })
    const a = run.controller.sharedChannels()!, p = publicationProbe(a)
    h.writeConfig({ personas: [beta] }); await run.ticks.tick()
    expect(h.pendingBody()).toBeDefined()
    assertNoLeak(run.captured({ pending: writtenFile(h.paths.pending) }))
    expect(run.slackPosts()).toEqual([])
    h.confirm(); armed = true
    // This callback is synchronous until its promise is returned; observe all
    // asynchronous continuations with the same passive spy, then restore.
    const stringify = JSON.stringify; let rebuilds = 0
    const spy = spyOn(JSON, 'stringify').mockImplementation((...args: unknown[]) => {
      if (isSignature(args[0])) rebuilds++
      return Reflect.apply(stringify, JSON, args)
    })
    try { await run.ticks.tick() } finally { spy.mockRestore() }
    expect(a.reviewHeld('alpha')).toBe(true); expect(a.channelStamp('alpha', C.primary)).toEqual({ kind: 'undecided' })
    expect(rebuilds).toBeGreaterThan(0); expect(p.mismatches).toEqual([])
    expect(run.slackPosts()).toEqual([])
    armed = false; h.clearWriteFailure()
    let releaseRebuilds = 0
    const releaseSpy = spyOn(JSON, 'stringify').mockImplementation((...args: unknown[]) => {
      if (isSignature(args[0])) releaseRebuilds++
      return Reflect.apply(stringify, JSON, args)
    })
    try { await run.ticks.tick() } finally { releaseSpy.mockRestore() }
    expect(a.reviewHeld('alpha')).toBe(false); expect(releaseRebuilds).toBeGreaterThan(0)
    expect(p.mismatches).toEqual([]); assertNoLeak(run.captured())
  } finally {
    try {
      for (const run of h.runs) {
        try { assertNoLeak(run.captured()) }
        finally { expect(run.slackPosts()).toEqual([]) }
      }
    } finally { await h.cleanup() }
  }
})

test('P2 canonical marker replacement invalidates assignment-map proof with the applied tree unchanged (TR3)', () => {
  const { a, writes } = simpleRig(), channel = a.channels('alpha')[0]!
  expect(_assignFixture(a, 'alpha', a.incarnation('alpha')!, channel, 'thread_hybrid', a.revision,
    fixtureThreadHybridSince(a.snapshot())).kind).toBe('applied')
  const before = a.snapshot(), saved = before.personas.alpha!.assignments[channel]!, marker = 'tr3-replacement-marker'
  expect(saved.delivery).toBe('thread_hybrid'); expect(saved.threadHybridSince).not.toBe(marker)
  const expected = structuredClone(before); expected.revision++
  expected.personas.alpha!.assignments[channel] = { ...saved, order: expected.revision, threadHybridSince: marker }
  // Independent reader/byte oracle is constructed before the operation can
  // populate its caches. Only assignment metadata changes; applied is untouched.
  const expectedBytes = Buffer.from(JSON.stringify(expected, null, 2) + '\n')
  expect(parseSharedChannelState(expectedBytes, a.path)).toEqual(expected)
  const p = publicationProbe(a), stamps: Array<{ published: ReturnType<typeof a.channelStamp>; direct: ReturnType<typeof a.channelStamp> }> = []
  a.subscribeThreadView(view => stamps.push({ published: view.stamp('alpha', channel), direct: a.threadView().stamp('alpha', channel) }))
  // Observe actual applied-container identity across the operation and one
  // subsequent immutable-starting-state read. Do not mutate or expose it.
  const applied = new Map<number, object>(), isFrozen = Object.isFrozen
  const spy = spyOn(Object, 'isFrozen').mockImplementation(value => {
    if (value && typeof value === 'object' && 'format' in value && value.format === before.format &&
        'revision' in value && typeof value.revision === 'number' && 'applied' in value && value.applied && typeof value.applied === 'object') {
      applied.set(value.revision, value.applied)
    }
    return isFrozen(value)
  })
  writes.length = 0
  let rebuilds = 0
  try {
    const work = signatureWork(() => a.transactMembership('alpha', a.revision, (next, order) => {
      next.personas.alpha!.assignments[channel] = { ...saved, order, threadHybridSince: marker }
    }))
    rebuilds = work.rebuilds
    expect(work.result).toEqual({ kind: 'applied', revision: expected.revision })
    expect(writes).toHaveLength(1); expect(writes[0]).toEqual(expectedBytes)
    expect(readFileSync(a.path)).toEqual(expectedBytes); expect(a.snapshot()).toEqual(expected)
    expect(a.snapshot().applied).toEqual(before.applied)
    expect(p.rows).toEqual(['thread', 'config', 'change'].map(kind => ({ kind, revision: expected.revision, disk: expected.revision })))
    const stamp = { kind: 'decided' as const, incarnation: before.personas.alpha!.incarnation, threadHybridSince: marker }
    expect(stamps).toEqual([{ published: stamp, direct: stamp }]); expect(p.mismatches).toEqual([])
    reopen(a)
    // This fresh transaction reads the installed first candidate under its
    // mutation lock, making the exact applied identity observable to the spy.
    expect(a.transactMembership('alpha', a.revision, () => {}).kind).toBe('applied')
  } finally { spy.mockRestore() }
  expect(applied.get(before.revision)).toBeDefined()
  expect(applied.get(expected.revision)).toBe(applied.get(before.revision))
  expect(rebuilds).toBeGreaterThan(0)
})

test('P4 inventory bytes equal the existing general callback path and native JSON, with one callback/write/publication', async () => {
  const f = fixture(); await ready(f)
  const a = f.authority, before = a.snapshot(), inv = inventory(f), generation = f.membership.generation('alpha')!
  const expected = structuredClone(before); expected.revision++
  expected.personas.alpha!.membershipInventory = { incarnation: generation.incarnation, identity: generation.identityKey,
    observedThrough: inv.observedThrough, observedRevision: inv.observedRevision, recordedOrder: expected.revision }
  const native = Buffer.from(JSON.stringify(expected, null, 2) + '\n'), generalWrites: Buffer[] = []
  const general = createSharedChannelAuthority(a.path, before, { write(_path, bytes) { generalWrites.push(Buffer.from(bytes)) } })
  let calls = 0
  expect(general.transactMembership('alpha', general.revision, next => { calls++;
    next.personas.alpha!.membershipInventory = structuredClone(expected.personas.alpha!.membershipInventory)
  }).kind).toBe('applied')
  const p = publicationProbe(a), writes = f.writes.length
  expect(f.membership.commitInventory(generation, inv).kind).toBe('applied')
  expect(calls).toBe(1); expect(f.writes.length - writes).toBe(1)
  expect(generalWrites).toHaveLength(1); expect(generalWrites[0]!.equals(native)).toBe(true)
  expect(readFileSync(a.path).equals(native)).toBe(true); expect(a.snapshot()).toEqual(general.snapshot())
  expect(p.rows.map(row => row.kind)).toEqual(['thread', 'config', 'change']); expect(p.mismatches).toEqual([])
  reopen(a)
})

test.each(['identity', 'incarnation', 'observed order', 'recorded order'] as const)('P4 invalid cutoff %s rejected by both full reader and membership boundary', async field => {
  const f = fixture(); await ready(f)
  const a = f.authority, before = a.snapshot(), bytes = readFileSync(a.path), p = publicationProbe(a), writes = f.writes.length
  const change = (next: SharedChannelState, order: number) => {
    const record = { ...before.personas.alpha!.membershipInventory!, recordedOrder: order }
    if (field === 'identity') record.identity = 'invalid'
    if (field === 'incarnation') record.incarnation = 'foreign-life'
    if (field === 'observed order') record.observedRevision = order
    if (field === 'recorded order') record.recordedOrder = order + 1
    next.personas.alpha!.membershipInventory = record
  }
  const invalid = structuredClone(before); invalid.revision++; change(invalid, invalid.revision)
  expect(() => parseSharedChannelState(Buffer.from(JSON.stringify(invalid)), a.path)).toThrow()
  let calls = 0
  // Preserve the general-boundary control; the direct restricted-boundary
  // matrix below separately exercises transactMembershipInventory.
  expect(a.transactMembership('alpha', a.revision, (next, order) => { calls++; change(next, order) }).kind).toBe('failed')
  expect(calls).toBe(1); expect(f.writes.length).toBe(writes); expect(p.rows).toEqual([])
  expect(a.snapshot()).toEqual(before); expect(readFileSync(a.path)).toEqual(bytes)
})

test.each(['generation', 'revision'] as const)('P4 stale %s admits no callback, write or publication', async kind => {
  const f = fixture(); await ready(f)
  const a = f.authority, generation = f.membership.generation('alpha')!, before = a.snapshot(), bytes = readFileSync(a.path)
  const p = publicationProbe(a), writes = f.writes.length
  let calls = 0
  if (kind === 'generation') {
    expect(f.membership.commitInventory({ ...generation, incarnation: 'obsolete' }, inventory(f)).kind).toBe('stale')
  } else expect(a.transactMembership('alpha', a.revision - 1, () => { calls++ }).kind).toBe('stale')
  expect(calls).toBe(0); expect(f.writes.length).toBe(writes); expect(p.rows).toEqual([])
  expect(a.snapshot()).toEqual(before); expect(readFileSync(a.path)).toEqual(bytes)
})

test.each(['before', 'unsynced'] as const)('P4 cutoff %s failure preserves exact positions and never replays callbacks', async kind => {
  const f = fixture(); await ready(f)
  const a = f.authority, before = a.snapshot(), bytes = readFileSync(a.path), writes = f.writes.length, p = publicationProbe(a)
  if (kind === 'before') f.failWrites(() => true); else f.unsyncWrites(() => true)
  const inv = inventory(f)
  expect(f.membership.commitInventory(f.membership.generation('alpha')!, inv).kind).toBe(kind === 'before' ? 'failed' : 'unresolved')
  expect(f.writes.length - writes).toBe(1); expect(a.snapshot()).toEqual(before)
  expect(p.rows).toEqual([])
  if (kind === 'before') expect(readFileSync(a.path)).toEqual(bytes)
  else {
    const staged = parseSharedChannelState(readFileSync(a.path), a.path)!
    expect(staged.revision).toBe(before.revision + 1)
    expect(staged.personas.alpha!.membershipInventory!.recordedOrder).toBe(staged.revision)
    expect(staged.personas.alpha!.membershipEvents).toEqual(before.personas.alpha!.membershipEvents)
    f.unsyncWrites(() => false)
    expect(a.recoverDurability().kind).toBe('applied')
    expect(a.revision).toBe(staged.revision); expect(f.writes.length - writes).toBe(2)
    expect(p.rows.map(row => row.kind)).toEqual(['thread', 'config', 'change'])
    expect(p.mismatches).toEqual([]); expect(a.snapshot()).toEqual(staged); reopen(a)
  }
})

for (const recovery of [false, true]) test.each(['before', 'unsynced'] as const)(
  `P4 general ${recovery ? 'recovery' : 'absence'} frame preserves %s failure and positions`, async fault => {
    const f = fixture(); await ready(f)
    if (recovery) {
      const timestamp = ((f.h.clock.now() + 1) / 1000).toFixed(3)
      await f.event(true, C.primary, { id: 'EvFAILJOIN', timestamp })
      await f.event(false, C.primary, { id: 'EvFAILLEAVE', timestamp })
      expect(life(f).membershipEvidence!.EvFAILLEAVE!.state).toBe('conflict')
    }
    const a = f.authority, before = a.snapshot(), bytes = readFileSync(a.path), p = publicationProbe(a), writes = f.writes.length
    const inv = inventory(f, new Map([[C.primary, life(f).membership[C.primary]!.boundary]]))
    if (fault === 'before') f.failWrites(() => true); else f.unsyncWrites(() => true)
    const frame = await frameWork([C.primary], async () => {
      expect(f.membership.commitInventory(f.membership.generation('alpha')!, inv).kind).toBe(fault === 'before' ? 'failed' : 'unresolved')
    })
    expect(frame.copies).toBeGreaterThan(0); expect(f.writes.length - writes).toBe(1)
    expect(a.snapshot()).toEqual(before)
    if (fault === 'before') { expect(p.rows).toEqual([]); expect(readFileSync(a.path)).toEqual(bytes) }
    else {
      const staged = parseSharedChannelState(readFileSync(a.path), a.path)!
      expect(staged.revision).toBe(before.revision + (recovery ? 3 : 2))
      const stagedLife = staged.personas.alpha!
      expect(stagedLife.membershipInventory!.recordedOrder).toBe(staged.revision)
      expect(stagedLife.membershipEvents[`scan:${inv.scanId}:absent:${C.primary}`]!.order).toBe(staged.revision - 1)
      if (recovery) expect(stagedLife.membershipEvents.EvFAILLEAVE!.order).toBe(before.revision + 1)
      f.unsyncWrites(() => false)
      expect(a.recoverDurability().kind).toBe('applied')
      expect(a.snapshot()).toEqual(staged); expect(f.writes.length - writes).toBe(2)
      expect(p.rows.filter(row => row.kind === 'config')).toHaveLength(1)
      expect(p.rows.filter(row => row.kind === 'change')).toHaveLength(1)
      expect(p.mismatches).toEqual([]); reopen(a)
    }
  })

test('P4 staged-review fallback runs the general callback once and preserves its existing anchor refusal', async () => {
  const f = fixture(); await ready(f)
  const a = f.authority, evidence = Buffer.from('damaged fixture for staged reader')
  durableWriteFileSync(a.path, evidence)
  expect(a.stageRestoration(sharedRecoveryRequest('cutoff-fallback', evidence), evidence, a.sourceBytes()).kind).toBe('unresolved')
  const state = parseSharedChannelState(readFileSync(a.path), a.path)!
  let calls = 0
  const writes: Buffer[] = []
  const opened = createSharedChannelAuthority(a.path, state, { write(path, bytes) { writes.push(Buffer.from(bytes)); durableWriteFileSync(path, bytes) } })
  const bytes = readFileSync(a.path), p = publicationProbe(opened)
  expect(opened.transactMembership('alpha', opened.revision, (next, order) => { calls++;
    next.personas.alpha!.membershipInventory = { ...next.personas.alpha!.membershipInventory!, recordedOrder: order }
  }).kind).toBe('failed')
  expect(calls).toBe(1); expect(writes).toHaveLength(0); expect(p.rows).toEqual([])
  expect(readFileSync(a.path)).toEqual(bytes); expect(opened.snapshot()).toEqual(state); reopen(opened)
})

test('P4 native inventory uses the general frame and keeps one write without callback replay', async () => {
  const f = fixture(); await ready(f)
  const a = f.authority
  let calls = 0
  expect(a.transactMembership('alpha', a.revision, next => { calls++;
    Object.defineProperty(next, 'toJSON', { value(this: SharedChannelState) { return { ...this } } })
  }).kind).toBe('applied')
  const p = publicationProbe(a), before = a.snapshot(), writes = f.writes.length, inv = inventory(f)
  const frame = await frameWork([C.primary], async () => {
    expect(f.membership.commitInventory(f.membership.generation('alpha')!, inv).kind).toBe('applied')
  })
  expect(frame.copies).toBeGreaterThan(0); expect(calls).toBe(1); expect(f.writes.length - writes).toBe(1)
  expect(a.revision).toBe(before.revision + 1); expect(p.rows.map(row => row.kind)).toEqual(['thread', 'config', 'change'])
  const after = a.snapshot()
  expect(readFileSync(a.path).equals(Buffer.from(JSON.stringify(after, null, 2) + '\n'))).toBe(true); reopen(a)
})

type InventoryFrame = 'normal' | 'native' | 'review'
const INVENTORY_FRAMES: InventoryFrame[] = ['normal', 'native', 'review']
/** Preserve native identity in memory; a full-reader reopen intentionally
 * clears the native-encoding provenance. Review fallback uses a real stage. */
async function directInventoryRig(frame: InventoryFrame, withPrevious = true) {
  const f = fixture()
  if (withPrevious) await ready(f); else await f.start()
  let a = f.authority
  let writeCount = () => f.writes.length
  if (frame === 'native') expect(a.transactMembership('alpha', a.revision, next => {
    Object.defineProperty(next, 'toJSON', { value(this: SharedChannelState) { return { ...this } } })
  }).kind).toBe('applied')
  if (frame === 'review') {
    const damaged = Buffer.from('damaged fixture for direct cutoff stage')
    durableWriteFileSync(a.path, damaged)
    expect(a.stageRestoration(sharedRecoveryRequest('direct-cutoff-stage', damaged), damaged, a.sourceBytes()).kind).toBe('unresolved')
    const staged = parseSharedChannelState(readFileSync(a.path), a.path)!
    const writes: Buffer[] = []
    a = createSharedChannelAuthority(a.path, staged, { write(path, bytes) {
      writes.push(Buffer.from(bytes)); durableWriteFileSync(path, bytes)
    } })
    writeCount = () => writes.length
  }
  const before = a.snapshot(), bytes = readFileSync(a.path), writes = writeCount(), p = publicationProbe(a)
  const generation = f.membership.generation('alpha')!
  const nextInventory = (order: number): SharedMembershipInventory => ({ incarnation: a.incarnation('alpha')!,
    identity: generation.identityKey, observedThrough: ((f.h.clock.now() + 2) / 1000).toFixed(3),
    observedRevision: before.revision, recordedOrder: order })
  return { f, a, before, bytes, p, writes: () => writeCount() - writes, nextInventory }
}
type DirectInventoryRig = Awaited<ReturnType<typeof directInventoryRig>>
function directUnchanged(r: DirectInventoryRig) {
  expect(r.writes()).toBe(0); expect(r.p.rows).toEqual([]); expect(r.p.mismatches).toEqual([])
  expect(r.a.revision).toBe(r.before.revision); expect(r.a.snapshot()).toEqual(r.before)
  expect(r.a.config()).toEqual(createSharedChannelAuthority(r.a.path, r.before).config())
  expect(readFileSync(r.a.path)).toEqual(r.bytes)
}

test.each(INVENTORY_FRAMES)('P4 direct %s admission chooses its frame before one guarded reducer evaluation', async frame => {
  const r = await directInventoryRig(frame), { a } = r, events: string[] = []
  const membership = a.transactMembership, whole = a.transact
  const membershipSpy = spyOn(a, 'transactMembership').mockImplementation((...args) => {
    events.push('membership-frame'); return membership.apply(a, args)
  })
  const wholeSpy = spyOn(a, 'transact').mockImplementation((...args) => {
    events.push('whole-frame'); return whole.apply(a, args)
  })
  let guards = 0, reducers = 0, nestedGuards = 0, nestedReducers = 0
  let result: ReturnType<typeof a.transactMembershipInventory>
  try {
    result = a.transactMembershipInventory('alpha', a.incarnation('alpha')!, a.revision, (previous, order) => {
      events.push('reduce'); reducers++
      expect(previous).toEqual(r.before.personas.alpha!.membershipInventory)
      expect(order).toBe(r.before.revision + 1)
      return r.nextInventory(order)
    }, () => {
      events.push('guard'); guards++
      // Reentrant admission proves this guard is inside the mutation lock.
      expect(a.transactMembershipInventory('alpha', a.incarnation('alpha')!, a.revision,
        (_previous, order) => { nestedReducers++; return r.nextInventory(order) }, () => { nestedGuards++; return true }).kind).toBe('stale')
      return true
    })
  } finally { wholeSpy.mockRestore(); membershipSpy.mockRestore() }
  expect(events).toEqual([...frame === 'normal' ? [] : frame === 'native' ? ['membership-frame'] : ['membership-frame', 'whole-frame'],
    'guard', 'reduce'])
  expect([guards, reducers, nestedGuards, nestedReducers]).toEqual([1, 1, 0, 0])
  if (frame === 'review') {
    expect(result.kind).toBe('failed'); directUnchanged(r)
  } else {
    expect(result).toEqual({ kind: 'applied', revision: r.before.revision + 1 })
    expect(r.writes()).toBe(1)
    const expected = structuredClone(r.before); expected.revision++
    expected.personas.alpha!.membershipInventory = r.nextInventory(expected.revision)
    expect(a.snapshot()).toEqual(expected)
    expect(readFileSync(a.path)).toEqual(Buffer.from(JSON.stringify(expected, null, 2) + '\n'))
    expect(r.p.rows).toEqual(['thread', 'config', 'change'].map(kind => ({ kind, revision: expected.revision, disk: expected.revision })))
    expect(r.p.mismatches).toEqual([]); reopen(a)
  }
})

test('P4 direct admission supplies undefined when no previous inventory exists', async () => {
  const r = await directInventoryRig('normal', false), { a } = r
  expect(r.before.personas.alpha!.membershipInventory).toBeUndefined()
  let guards = 0, reducers = 0
  expect(a.transactMembershipInventory('alpha', a.incarnation('alpha')!, a.revision, (previous, order) => {
    reducers++; expect(previous).toBeUndefined(); return r.nextInventory(order)
  }, () => { guards++; return true }).kind).toBe('applied')
  expect([guards, reducers, r.writes()]).toEqual([1, 1, 1]); reopen(a)
})

for (const frame of INVENTORY_FRAMES) test.each(['stale revision', 'wrong incarnation', 'false guard'] as const)(
  `P4 direct ${frame} %s refuses without reduction`, async refusal => {
    const r = await directInventoryRig(frame), { a } = r
    let guards = 0, reducers = 0
    const result = a.transactMembershipInventory('alpha', refusal === 'wrong incarnation' ? 'obsolete' : a.incarnation('alpha')!,
      a.revision - (refusal === 'stale revision' ? 1 : 0), (_previous, order) => { reducers++; return r.nextInventory(order) },
      () => { guards++; return false })
    expect(result).toEqual({ kind: refusal === 'false guard' ? 'failed' : 'stale', revision: r.before.revision })
    expect([guards, reducers]).toEqual([refusal === 'false guard' ? 1 : 0, 0]); directUnchanged(r)
  })

test.each(INVENTORY_FRAMES)('P4 direct %s guard becomes stale between admission and the transaction boundary', async frame => {
  const r = await directInventoryRig(frame), { a } = r
  let generationCurrent = true, boundaryCalls = 0, guards = 0, reducers = 0
  const membership = a.transactMembership, isFrozen = Object.isFrozen
  // The normal frame freezes its immutable starting state after admission,
  // under the transaction lock. Fallback selects the general frame first.
  const boundarySpy = frame === 'normal'
    ? spyOn(Object, 'isFrozen').mockImplementation(value => {
      if (value && typeof value === 'object' && 'personas' in value && 'revision' in value && value.revision === r.before.revision) {
        generationCurrent = false; boundaryCalls++
      }
      return isFrozen(value)
    })
    : spyOn(a, 'transactMembership').mockImplementation((...args) => {
      generationCurrent = false; boundaryCalls++; return membership.apply(a, args)
    })
  let result: ReturnType<typeof a.transactMembershipInventory>
  try {
    expect(generationCurrent).toBe(true)
    result = a.transactMembershipInventory('alpha', a.incarnation('alpha')!, a.revision,
      (_previous, order) => { reducers++; return r.nextInventory(order) }, () => { guards++; return generationCurrent })
  } finally { boundarySpy.mockRestore() }
  expect(boundaryCalls).toBe(1); expect([guards, reducers]).toEqual([1, 0])
  expect(result).toEqual({ kind: 'failed', revision: r.before.revision }); directUnchanged(r)
})

for (const frame of ['normal', 'native'] as const) test.each(['identity', 'incarnation', 'observed order', 'recorded order'] as const)(
  `P4 direct ${frame} malformed %s is rejected by retained validators and full reader`, async field => {
    const r = await directInventoryRig(frame), { a } = r
    const invalid = r.nextInventory(a.revision + 1)
    if (field === 'identity') invalid.identity = 'invalid'
    if (field === 'incarnation') invalid.incarnation = 'foreign-life'
    if (field === 'observed order') invalid.observedRevision = invalid.recordedOrder
    if (field === 'recorded order') invalid.recordedOrder++
    const candidate = structuredClone(r.before); candidate.revision++; candidate.personas.alpha!.membershipInventory = invalid
    expect(() => parseSharedChannelState(Buffer.from(JSON.stringify(candidate)), a.path)).toThrow()
    let guards = 0, reducers = 0
    expect(a.transactMembershipInventory('alpha', a.incarnation('alpha')!, a.revision,
      () => { reducers++; return invalid }, () => { guards++; return true }))
      .toEqual({ kind: 'failed', revision: r.before.revision })
    expect([guards, reducers]).toEqual([1, 1]); directUnchanged(r)
  })

test.each(INVENTORY_FRAMES)('P4 direct %s reducer owns a detached previous record even when it throws', async frame => {
  const r = await directInventoryRig(frame), { a } = r
  let reducers = 0, detachedMutationVerified = false
  expect(a.transactMembershipInventory('alpha', a.incarnation('alpha')!, a.revision, previous => {
    reducers++; expect(previous).toEqual(r.before.personas.alpha!.membershipInventory)
    previous!.identity = 'mutated detached input'
    expect(a.snapshot()).toEqual(r.before)
    detachedMutationVerified = true
    throw new Error('fixture reducer refusal')
  }, () => true).kind).toBe('failed')
  expect(reducers).toBe(1); expect(detachedMutationVerified).toBe(true); directUnchanged(r)
})

for (const frame of ['normal', 'native'] as const) test.each(['before', 'unsynced'] as const)(
  `P4 direct ${frame} %s failure and durability recovery never replay guard or reducer`, async fault => {
    const r = await directInventoryRig(frame), { a, f } = r
    let guards = 0, reducers = 0
    const reduce = (_previous: SharedMembershipInventory | undefined, order: number) => { reducers++; return r.nextInventory(order) }
    const guard = () => { guards++; return true }
    if (fault === 'before') f.failWrites(() => true); else f.unsyncWrites(() => true)
    expect(a.transactMembershipInventory('alpha', a.incarnation('alpha')!, a.revision, reduce, guard))
      .toEqual({ kind: fault === 'before' ? 'failed' : 'unresolved', revision: r.before.revision })
    expect([guards, reducers, r.writes()]).toEqual([1, 1, 1])
    expect(a.snapshot()).toEqual(r.before); expect(r.p.rows).toEqual([])
    if (fault === 'before') {
      expect(readFileSync(a.path)).toEqual(r.bytes)
      f.failWrites(() => false)
      expect(a.recoverDurability()).toEqual({ kind: 'applied', revision: r.before.revision })
      expect(r.writes()).toBe(1); expect(r.p.rows).toEqual([])
    } else {
      const candidate = structuredClone(r.before); candidate.revision++
      candidate.personas.alpha!.membershipInventory = r.nextInventory(candidate.revision)
      const staged = readFileSync(a.path)
      expect(staged).toEqual(Buffer.from(JSON.stringify(candidate, null, 2) + '\n'))
      let refusedGuards = 0, refusedReducers = 0
      expect(a.transactMembershipInventory('alpha', a.incarnation('alpha')!, a.revision,
        (_previous, order) => { refusedReducers++; return r.nextInventory(order) }, () => { refusedGuards++; return true }).kind).toBe('unresolved')
      expect([refusedGuards, refusedReducers, r.writes()]).toEqual([0, 0, 1])
      f.unsyncWrites(() => false)
      expect(a.recoverDurability()).toEqual({ kind: 'applied', revision: candidate.revision })
      expect(a.snapshot()).toEqual(candidate); expect(readFileSync(a.path)).toEqual(staged); expect(r.writes()).toBe(2)
      expect(r.p.rows).toEqual(['thread', 'config', 'change'].map(kind => ({ kind, revision: candidate.revision, disk: candidate.revision })))
      expect(a.recoverDurability()).toEqual({ kind: 'applied', revision: candidate.revision })
      expect(r.writes()).toBe(2); expect(r.p.rows).toHaveLength(3)
    }
    expect([guards, reducers]).toEqual([1, 1]); expect(r.p.mismatches).toEqual([]); reopen(a)
  })

/** CR2 hook changes only the signature's outer pair-array shape. Ordinary
 * configuration/channel arrays keep their native representation. */
function installInheritedSignatureHook(preserving = false) {
  Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value(this: unknown[]) {
    const first = this[0]
    return !preserving && Array.isArray(first) && typeof first[0] === 'string' && Array.isArray(first[1])
      ? 'review-synthetic-signature' : this
  } })
}
function withRestoredArrayHook(run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
  try { run() } finally {
    if (previous) Object.defineProperty(Array.prototype, 'toJSON', previous)
    else Reflect.deleteProperty(Array.prototype, 'toJSON')
  }
}
/** Compare values directly: JSON.stringify itself is the behavior under test.
 * Retain listener failures for assertions outside production's catch boundary. */
function hookPublicationProbe(a: SharedChannelAuthority) {
  const channels = [...new Set(a.personaKeys().flatMap(key => a.channels(key)))]
  const views: Array<{ published: ReturnType<typeof viewValue>; direct: ReturnType<typeof viewValue>; disk: number }> = []
  const errors: unknown[] = []
  a.subscribeThreadView(view => {
    try {
      views.push({ published: viewValue(view, channels), direct: viewValue(a.threadView(), channels),
        disk: parseSharedChannelState(readFileSync(a.path), a.path)!.revision })
    } catch (error) { errors.push(error) }
  })
  const parity = () => {
    expect(errors).toEqual([])
    for (const view of views) {
      expect(view.published).toEqual(view.direct)
      expect(view.published.revision).toBe(a.revision)
      expect(view.disk).toBe(a.revision)
    }
  }
  return { views, parity }
}

test.each([false, true])('CR2 publisher signature hook: preserving inherited hook kept for next commit=%p', preserving => {
  withRestoredArrayHook(() => {
    const { a, writes } = simpleRig(), before = a.snapshot(), p = hookPublicationProbe(a)
    let publisherCalls = 0
    expect(a.transact(a.revision, () => {}, 1, () => { publisherCalls++; installInheritedSignatureHook() }).kind).toBe('applied')
    expect(publisherCalls).toBe(1); expect(p.views).toHaveLength(1); p.parity()
    p.views.length = 0; writes.length = 0
    Reflect.deleteProperty(Array.prototype, 'toJSON')
    if (preserving) installInheritedSignatureHook(true)
    expect(a.transactMembership('alpha', a.revision, () => {}).kind).toBe('applied')
    expect(writes).toHaveLength(1); expect(a.revision).toBe(before.revision + 2)
    const expected = structuredClone(before); expected.revision += 2
    expect(a.snapshot()).toEqual(expected)
    p.parity(); reopen(a)
    expect(p.views).toHaveLength(1)
  })
})

test('CR2 signature hook present at construction and removed before unchanged membership commit', () => {
  withRestoredArrayHook(() => {
    installInheritedSignatureHook()
    const { a, writes } = simpleRig(), before = a.snapshot(), p = hookPublicationProbe(a)
    Reflect.deleteProperty(Array.prototype, 'toJSON')
    const count = writes.length
    expect(a.transactMembership('alpha', a.revision, () => {}).kind).toBe('applied')
    expect(writes.length - count).toBe(1); expect(a.revision).toBe(before.revision + 1)
    p.parity(); reopen(a)
    expect(p.views).toHaveLength(1)
  })
})

test('CR2 signature hook present before a commit and removed before the following commit', () => {
  withRestoredArrayHook(() => {
    const { a, writes } = simpleRig(), before = a.snapshot(), p = hookPublicationProbe(a)
    installInheritedSignatureHook()
    expect(a.transactMembership('alpha', a.revision, () => {}).kind).toBe('applied')
    expect(p.views).toHaveLength(1); p.parity()
    Reflect.deleteProperty(Array.prototype, 'toJSON'); p.views.length = 0; writes.length = 0
    expect(a.transactMembership('alpha', a.revision, () => {}).kind).toBe('applied')
    expect(writes).toHaveLength(1); expect(a.revision).toBe(before.revision + 2)
    p.parity(); reopen(a)
    expect(p.views).toHaveLength(1)
  })
})

test('CR2 no-hook unchanged membership keeps zero signature rebuilds and zero thread notifications', () => {
  withRestoredArrayHook(() => {
    Reflect.deleteProperty(Array.prototype, 'toJSON')
    const { a, writes } = simpleRig(), before = a.snapshot(), p = hookPublicationProbe(a)
    const count = writes.length
    const work = signatureWork(() => a.transactMembership('alpha', a.revision, () => {}))
    expect(work.result.kind).toBe('applied'); expect(work.rebuilds).toBe(0)
    expect(writes.length - count).toBe(1); expect(a.revision).toBe(before.revision + 1)
    p.parity(); expect(p.views).toHaveLength(0); reopen(a)
  })
})
