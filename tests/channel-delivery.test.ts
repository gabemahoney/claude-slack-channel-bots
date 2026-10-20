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
    expect(authority.transact(1, next => { next.revision = -1 })).toEqual({ kind: 'failed', revision: 1 })
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
    expect(authority.applyReviewed(configBytes(edited), authority.revision).kind).toBe('applied')
    expect(received).toEqual([authority.config()])
    expect(readSharedState(root)!.applied).toEqual(authority.snapshot().applied)
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
    expect(authority.assign('alpha', life, 'C0TEST001', 'all', authority.revision).kind).toBe('failed')
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
