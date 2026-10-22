/** The file-free adapter and the durable shared-authority mutation contract. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableWriteUnsyncedError, durableWriteFileSync } from '../src/atomic-write.ts'
import { createChannelDeliveryStore, channelDeliveryDeclarationOf } from '../src/channel-delivery.ts'
import { createSharedChannelAuthority, parseSharedChannelState, serializeSharedChannelState, type SharedChannelState } from '../src/shared-channels.ts'
import { assertNoLeak, sentinelInMessage, writtenFile } from './test-helpers/credentials.ts'
import { makePersona, makePersonaConfigInput } from './test-helpers/persona-config.ts'
import { configBytes, initialSharedState, makeSharedAuthority, readSharedState, sharedChannelPath, writeSharedState } from './test-helpers/shared-channels.ts'
import { osTempDir } from './test-helpers/host-safe-env.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'shared-authority-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
function input() {
  return makePersonaConfigInput({ personas: [makePersona({ name: 'alpha' }, root), makePersona({ name: 'beta' }, root)] }, root)
}
function check(state: unknown) { assertNoLeak({ state, file: existsSync(sharedChannelPath(root)) ? writtenFile(sharedChannelPath(root)) : undefined }) }

 describe('one durable authority', () => {
  test('adapter reads only applied choices and each of the four values survives reopen', () => {
    const authority = makeSharedAuthority(root, input())
    const store = createChannelDeliveryStore(authority)
    const persona = authority.config().personas[0]!
    for (const delivery of ['off', 'mentions', 'all', 'thread_hybrid'] as const) {
      const previous = authority.choice(persona.key, 'C0TEST001')
      expect(store.set(persona.key, 'C0TEST001', delivery, channelDeliveryDeclarationOf(persona))).toEqual({ kind: 'stored', previous })
      const reopened = createSharedChannelAuthority(authority.path, readSharedState(root)!)
      expect(reopened.choice(persona.key, 'C0TEST001')).toBe(delivery)
      expect(reopened.config().personas[0]!.channels).toEqual([{ id: 'C0TEST001', delivery }])
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
    for (let i = 0; i < 2; i++) expect(authority.assign(alpha.key, authority.incarnation(alpha.key)!, 'C0TEST001', 'all', authority.revision).kind).toBe('applied')
    const after = readSharedState(root)!
    expect(after.revision).toBe(before.revision + 2)
    expect(after.personas[alpha.key]!.assignments['C0TEST001']!.order).toBe(after.revision)
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
    const edited = input(); edited.channel_mode = 'open'; edited.personas[0]!.channels = [{ id: 'C0TEST002', delivery: 'thread_hybrid' }]; edited.personas[0]!.permission_prompts = 'C0TEST002'
    expect(authority.transact(authority.revision, next => { next.pendingIntent = { prepared: 'review' }; next.outcomes = { prior: 'retained' } }).kind).toBe('applied')
    received.length = 0
    durable = false
    expect(authority.applyReviewed(configBytes(edited), authority.revision).kind).toBe('applied')
    expect(received).toEqual([authority.config()])
    expect(readSharedState(root)!.applied).toEqual(authority.snapshot().applied)
    expect(readSharedState(root)!.pendingIntent).toEqual({ prepared: 'review' })
    expect(readSharedState(root)!.outcomes).toEqual({ prior: 'retained' })
    unsubscribe()
    authority.assign('alpha', authority.incarnation('alpha')!, 'C0TEST002', 'off', authority.revision)
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
      expect(authority.assign('alpha', initial.personas['alpha']!.incarnation, 'C0TEST001', 'off', 1).kind).toBe('unresolved')
      expect(authority.observeMembership('alpha', initial.personas['alpha']!.incarnation, { event: 'join', identity: 'app', channel: 'C0TEST001', member: true, boundary: 0 }, 1).kind).toBe('unresolved')
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
    expect(authority.assign('alpha', authority.incarnation('alpha')!, 'C0TEST001', 'mentions', 1)).toEqual({ kind: 'applied', revision: 2 })
    expect(authority.snapshot().pendingIntent).toEqual({})
    expect(readSharedState(root)!.revision).toBe(2)
    check(authority.snapshot())
  })

  test('observer reentrancy cannot publish a second revision and memory matches serialized state', () => {
    const authority = makeSharedAuthority(root, input())
    const results: unknown[] = []
    authority.subscribe(() => {
      results.push(authority.assign('alpha', authority.incarnation('alpha')!, 'C0TEST001', 'off', authority.revision))
    })
    expect(authority.transact(1, next => { next.pendingIntent['omitted'] = undefined })).toEqual({ kind: 'applied', revision: 2 })
    expect(results).toEqual([]) // metadata alone publishes no runtime change
    expect(authority.assign('alpha', authority.incarnation('alpha')!, 'C0TEST001', 'mentions', 2)).toEqual({ kind: 'applied', revision: 3 })
    expect(results).toEqual([{ kind: 'stale', revision: 3 }])
    expect(authority.choice('alpha', 'C0TEST001')).toBe('mentions')
    expect(Object.hasOwn(authority.snapshot().pendingIntent, 'omitted')).toBe(false)
    expect(authority.snapshot()).toEqual(readSharedState(root)!)
    check(results)
  })

  test('retiring is adapter-local, rejects the held key and leaves its healthy neighbor writable', () => {
    const authority = makeSharedAuthority(root, input())
    const store = createChannelDeliveryStore(authority)
    store.beginRetiring(['alpha'])
    const [alpha, beta] = authority.config().personas
    expect(store.set('alpha', 'C0TEST001', 'off', channelDeliveryDeclarationOf(alpha!))).toEqual({ kind: 'invalid', field: 'declaration' })
    expect(store.set('beta', 'C0TEST001', 'mentions', channelDeliveryDeclarationOf(beta!)).kind).toBe('stored')
    expect(createChannelDeliveryStore(authority).isRetiring('alpha')).toBe(false)
    store.endRetiring(['alpha'])
    expect(store.set('alpha', 'C0TEST001', 'off', channelDeliveryDeclarationOf(alpha!)).kind).toBe('stored')
    check(authority.snapshot())
  })
 })

test('replaying a verified leave preserves a later future preference, while a never-joined preference has no leave evidence', () => {
  const authority = makeSharedAuthority(root, input())
  const life = authority.incarnation('alpha')!
  const leave = { event: 'verified-leave', identity: 'app', channel: 'C0TEST001', member: false, boundary: 0 }
  expect(authority.observeMembership('alpha', life, leave, authority.revision).kind).toBe('applied')
  const leaveRevision = authority.revision
  expect(authority.assign('alpha', life, 'C0TEST001', 'thread_hybrid', authority.revision).kind).toBe('applied')
  expect(authority.assign('alpha', life, 'C0FUTURE1', 'mentions', authority.revision).kind).toBe('applied')
  const reopened = createSharedChannelAuthority(authority.path, readSharedState(root)!)
  const before = readFileSync(authority.path)
  expect(reopened.observeMembership('alpha', life, leave, reopened.revision)).toEqual({ kind: 'applied', revision: leaveRevision })
  expect(readFileSync(authority.path)).toEqual(before)
  expect(reopened.choice('alpha', 'C0TEST001')).toBe('thread_hybrid')
  expect(reopened.choice('alpha', 'C0FUTURE1')).toBe('mentions')
  const state = reopened.snapshot().personas['alpha']!
  expect(state.membership['C0TEST001']!.member).toBe(false)
  expect(state.assignments['C0TEST001']!.order).toBeGreaterThan(state.leaves['C0TEST001']!.boundary)
  expect(state.membership['C0FUTURE1']).toBeUndefined()
  expect(state.leaves['C0FUTURE1']).toBeUndefined()
  let writes = 0
  const unresolved = createSharedChannelAuthority(authority.path, reopened.snapshot(), { write(path, bytes) {
    writes++
    durableWriteFileSync(path, bytes)
    throw new DurableWriteUnsyncedError(path, Object.assign(new Error(sentinelInMessage('sync')), { code: 'EIO' }))
  } })
  expect(unresolved.assign('alpha', life, 'C0FUTURE1', 'off', unresolved.revision).kind).toBe('unresolved')
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
  { label: 'applied choice disagrees with assignment', alter: s => { appliedPersona(s)['channels'] = [{ id: 'C0TEST001', delivery: 'off' }] } },
  { label: 'membership metadata has invalid type', alter: s => { Object.assign(s.personas['alpha']!.membership['C0TEST001']!, { isExtSharedChannel: 'false' }) } },
  { label: 'current membership contradicts latest event', alter: s => { s.personas['alpha']!.membership['C0TEST001']!.member = true } },
  { label: 'membership history is incomplete', alter: s => { delete s.personas['alpha']!.membershipEvents['left'] } },
  { label: 'membership boundary disagrees with event order', alter: s => { s.personas['alpha']!.membershipEvents['joined']!.boundary++ } },
  { label: 'leave points to a join', alter: s => { s.personas['alpha']!.leaves['C0TEST001']!.event = 'joined' } },
  { label: 'assignment predates leave', alter: s => { s.personas['alpha']!.assignments['C0TEST001']!.order = s.personas['alpha']!.leaves['C0TEST001']!.boundary } },
  { label: 'destination proof belongs to a foreign life', alter: s => { s.personas['alpha']!.removedDestinations['C0TEST001']!.incarnation = s.personas['beta']!.incarnation } },
  { label: 'destination proof no longer names the configured destination', alter: s => {
    const applied = appliedPersona(s)
    const source = (s.source['personas'] as Record<string, unknown>[])[0]!
    applied['permission_prompts'] = source['permission_prompts'] = 'C0OTHER01'
    for (const persona of [applied, source]) (persona['channels'] as unknown[]).push({ id: 'C0OTHER01', delivery: 'all' })
    s.personas['alpha']!.assignments['C0OTHER01'] = { delivery: 'all', order: s.revision }
    s.sourceBytesBase64 = configBytes(s.source).toString('base64')
  } },
])('$label is refused by parser and constructor without publishing', ({ alter }) => {
  const source = input()
  const authority = makeSharedAuthority(root, source)
  source.personas[1]!.working_directory = join(root, 'replacement')
  expect(authority.applyReviewed(configBytes(source), authority.revision, [{ key: 'beta', channel: 'C0TEST001', delivery: 'all' }]).kind).toBe('applied')
  const life = authority.incarnation('alpha')!
  expect(authority.observeMembership('alpha', life, { event: 'joined', identity: 'app', channel: 'C0TEST001', member: true, boundary: 0 }, authority.revision).kind).toBe('applied')
  expect(authority.observeMembership('alpha', life, { event: 'left', identity: 'app', channel: 'C0TEST001', member: false, boundary: authority.revision }, authority.revision).kind).toBe('applied')
  expect(authority.assign('alpha', life, 'C0TEST001', 'mentions', authority.revision).kind).toBe('applied')
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

 describe('identity and provenance foundations', () => {
  test('a real-path spelling preserves the life while a changed path retires it and rejects old work', () => {
    const edited = input(); const persona = edited.personas[0]!
    mkdirSync(persona.working_directory, { recursive: true })
    const alias = join(root, 'work-alias'); symlinkSync(persona.working_directory, alias)
    const authority = makeSharedAuthority(root, edited)
    const life = authority.incarnation('alpha')!
    authority.assign('alpha', life, 'C0TEST001', 'off', authority.revision)
    persona.working_directory = alias
    expect(authority.applyReviewed(configBytes(edited), authority.revision).kind).toBe('applied')
    expect(authority.incarnation('alpha')).toBe(life)
    expect(authority.choice('alpha', 'C0TEST001')).toBe('off')
    persona.working_directory = join(root, 'replacement')
    expect(authority.applyReviewed(configBytes(edited), authority.revision, [{ key: 'alpha', channel: 'C0TEST001', delivery: 'mentions' }]).kind).toBe('applied')
    expect(authority.incarnation('alpha')).not.toBe(life)
    expect(authority.snapshot().retiredIdentities[life]!.key).toBe('alpha')
    const beforeStale = readFileSync(authority.path)
    expect(authority.assign('alpha', life, 'C0TEST001', 'all', authority.revision).kind).toBe('stale')
    expect(readFileSync(authority.path)).toEqual(beforeStale)
    check(authority.snapshot())
  })

  test('a verified leave retains only this life’s destination provenance through production serialization', () => {
    const authority = makeSharedAuthority(root, input())
    const persona = authority.config().personas[0]!
    const incarnation = authority.incarnation(persona.key)!
    expect(authority.observeMembership(persona.key, incarnation, { event: 'leave-event', identity: 'authenticated-app', channel: 'C0TEST001', member: false, boundary: 0 }, 1).kind).toBe('applied')
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
    (state: SharedChannelState) => { state.personas['alpha']!.assignments['C0TEST001']!.order = 100 },
    (state: SharedChannelState) => { state.personas['alpha']!.removedDestinations['C0TEST001'] = { event: 'forged', boundary: 1, incarnation: state.personas['alpha']!.incarnation } },
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
  alpha.channels = [{ id: 'C0TEST001', delivery: original }]
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
  expect(authority.choice('alpha', 'C0TEST001')).toBe(changed)
  expect(authority.incarnation('alpha')).not.toBe(originalLife)
  for (let reset = 0; reset < 3; reset++) {
    const previousLife = authority.incarnation('alpha')!
    apply(false)
    const preview = authority.previewReviewed(configBytes(source))
    expect(preview.personas[0]!.channels).toEqual([])
    apply(true)
    expect(authority.incarnation('alpha')).not.toBe(previousLife)
    expect(authority.choice('alpha', 'C0TEST001')).toBeUndefined()
    expect(authority.snapshot().source).toEqual(JSON.parse(configBytes(source).toString()))
  }
  const retirements = Object.values(authority.snapshot().retiredIdentities)
  const latest = retirements.reduce((a, b) => a.order > b.order ? a : b)
  expect(new Set(retirements.map(record => record.order)).size).toBe(retirements.length)
  expect(latest.channels).toEqual(alpha.channels)
  // A fresh explicit assignment still works, but copying it through another reset does not.
  expect(authority.applyReviewed(configBytes(source), authority.revision, [
    { key: 'alpha', channel: 'C0TEST001', delivery: changed, incarnation: authority.incarnation('alpha') },
  ]).kind).toBe('applied')
  reopen()
  expect(authority.choice('alpha', 'C0TEST001')).toBe(changed)
  apply(false); apply(true)
  expect(authority.choice('alpha', 'C0TEST001')).toBeUndefined()
  check(authority.snapshot())
})

test.each(['name', 'credentials_file', 'working_directory'] as const)('replacement and return of %s cannot resurrect copied choices after reopen', field => {
  const source = input()
  const alpha = source.personas[0]!
  alpha.dm = { enabled: true, contact: 'U0TEST001' }
  alpha.permission_prompts = 'dm'
  alpha.channels = [{ id: 'C0TEST001', delivery: 'all' }]
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
  expect(authority.choice(field === 'name' ? 'gamma' : 'alpha', 'C0TEST001')).toBe('mentions')
  alpha[field] = original
  apply()
  expect(authority.choice('alpha', 'C0TEST001')).toBeUndefined()
  alpha[field] = field === 'name' ? 'gamma' : join(root, `replacement-${field}`)
  apply()
  expect(authority.choice(field === 'name' ? 'gamma' : 'alpha', 'C0TEST001')).toBeUndefined()
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
  expect(store.attempt('alpha', authority.incarnation('alpha')!, deliveryAttempt('parser-regression', 'C0TEST001', 'all'), () => undefined).kind).toBe('applied')
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
    const persona = h.h.p('alpha'), channel = 'C0TEST001'
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
  expect(store.attempt('alpha', authority.incarnation('alpha')!, deliveryAttempt('valid-source-record', 'C0TEST001', 'all'), () => undefined).kind).toBe('applied')
  for (const { state } of malformedBotHistories(authority.snapshot())) {
    const bytes = serializeSharedChannelState(state)
    let failure: unknown
    try { parseSharedChannelState(bytes, authority.path) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    assertNoLeak(String(failure))
    expect(String(failure)).not.toContain('must-not-be-persisted')
  }
  check(authority.snapshot())
})

test('attempt identifiers preserve exact code units and cannot collide after Unicode replacement or trimming', () => {
  const values = ['retained', ' retained ', '\ud800', '\ufffd', '😀', '😀 ']
  const keys = values.map(id => {
    expect(validChannelDeliveryAttemptId(id)).toBe(true)
    return botAttemptKey(botAttemptBinding('alpha', 'same-life', deliveryAttempt(id, 'C0TEST001', 'all')))
  })
  expect(new Set(keys).size).toBe(values.length)
  expect(validChannelDeliveryAttemptId(' \r\n\t')).toBe(false)
  assertNoLeak(keys)
})
