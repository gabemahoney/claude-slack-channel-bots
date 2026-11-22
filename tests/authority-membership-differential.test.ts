/** Behaviour guards, expected green before C1-C3: the full reader is the
 * independent rejection oracle; native JSON is the byte parity oracle. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { durableWriteFileSync } from '../src/atomic-write.ts'
import { applySharedMembership, createSharedChannelAuthority, parseSharedChannelState, type SharedChannelState } from '../src/shared-channels.ts'
import { type SharedBotAttempt } from '../src/channel-delivery-attempt.ts'
import { SHARED_CHANNEL_IDS as C, deliveryAttempt, makeSharedAuthority, membershipJoin } from './test-helpers/shared-channels.ts'
import { makePersona, makePersonaConfigInput } from './test-helpers/persona-config.ts'
import { assertNoLeak, writtenFile } from './test-helpers/credentials.ts'

let root: string, sequence = 0
const captured: unknown[] = [], output: unknown[] = [], restores: Array<() => void> = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'authority-membership-differential-'))
  for (const method of ['log', 'warn', 'error', 'info', 'debug', 'trace'] as const) {
    const spy = spyOn(console, method).mockImplementation((...args: unknown[]) => { output.push(args) })
    restores.push(() => spy.mockRestore())
  }
})
afterEach(() => {
  try { assertNoLeak({ captured, output, files: writtenFile(root) }) }
  finally { restores.splice(0).forEach(restore => restore()); captured.length = 0; output.length = 0; rmSync(root, { recursive: true, force: true }) }
})
function capture<T>(fn: () => T): T {
  try { const result = fn(); captured.push({ result }); return result }
  catch (error) { captured.push({ error }); throw error }
}
const life = (s: SharedChannelState) => s.personas['alpha']!
const raw = (s: SharedChannelState) => (s.applied['personas'] as Array<Record<string, unknown>>)[0]!
const applied = (s: SharedChannelState) => Object.values(s.outcomes.botAttempts!).find((a): a is Extract<SharedBotAttempt, { status: 'applied' }> => a.status === 'applied')!
type Change = (state: SharedChannelState, order: number) => void
function rig() {
  const dir = join(root, String(sequence++)); mkdirSync(dir)
  const input = makePersonaConfigInput({ channel_mode: 'open', personas: ['alpha', 'beta'].map(name =>
    makePersona({ name, channels: [{ id: C.primary, delivery: 'all' }], permission_prompts: C.primary }, dir)) }, dir)
  const writes: Buffer[] = [], publications: string[] = []
  const authority = makeSharedAuthority(dir, input, { write(path, bytes) {
    captured.push({ path, bytes: Buffer.from(bytes) }); durableWriteFileSync(path, bytes); writes.push(Buffer.from(bytes))
  } })
  expect(authority.observeMembership('alpha', authority.incarnation('alpha')!, membershipJoin(C.primary, 'initial'), authority.revision).kind).toBe('applied')
  expect(authority.botAttempt('alpha', authority.incarnation('alpha')!, deliveryAttempt('retained', C.primary, 'all'),
    () => ({ kind: 'authorized', facts: { saved: 'all', effective: 'all' } })).kind).toBe('applied')
  authority.subscribeThreadView(() => publications.push('thread'))
  authority.subscribe(() => publications.push('config'))
  authority.subscribeChange(() => publications.push('change'))
  writes.length = 0; publications.length = 0
  return { authority, writes, publications }
}
type Rig = ReturnType<typeof rig>
function fullRead(state: SharedChannelState, r: Rig) {
  return capture(() => parseSharedChannelState(Buffer.from(JSON.stringify(state, null, 2) + '\n'), r.authority.path))
}
function unchanged(r: Rig, before: SharedChannelState, bytes: Buffer) {
  expect(r.writes).toEqual([]); expect(r.publications).toEqual([])
  expect(r.authority.revision).toBe(before.revision)
  expect(r.authority.snapshot()).toEqual(before)
  expect(readFileSync(r.authority.path).equals(bytes)).toBe(true)
}
function parity(r: Rig, change: Change) {
  const candidate = r.authority.snapshot(); candidate.revision++
  change(candidate, candidate.revision)
  // Construct expected bytes independently, before the scoped path can touch
  // any encoding cache. Reader acceptance alone is not serialization parity.
  const expected = Buffer.from(JSON.stringify(candidate, null, 2) + '\n')
  r.writes.length = 0; r.publications.length = 0
  expect(capture(() => r.authority.transactMembership('alpha', r.authority.revision, change)).kind).toBe('applied')
  expect(r.writes).toHaveLength(1)
  expect(r.writes[0]!.equals(expected)).toBe(true)
  const read = parseSharedChannelState(readFileSync(r.authority.path), r.authority.path)!
  expect(read).toEqual(JSON.parse(expected.toString('utf8')))
  expect(r.authority.snapshot()).toEqual(read)
  expect(createSharedChannelAuthority(r.authority.path, read).snapshot()).toEqual(read)
}
function rejected(r: Rig, change: Change) {
  const before = r.authority.snapshot(), config = r.authority.config(), bytes = readFileSync(r.authority.path)
  const candidate = structuredClone(before); candidate.revision++
  change(candidate, candidate.revision)
  expect(() => fullRead(candidate, r)).toThrow()
  expect(capture(() => r.authority.transactMembership('alpha', before.revision, change)))
    .toEqual({ kind: 'failed', revision: before.revision })
  unchanged(r, before, bytes)
  expect(r.authority.config()).toEqual(config)
  parity(r, (state, order) => applySharedMembership(state, order, 'alpha', life(state).incarnation, membershipJoin(C.secondary, 'after-rejection')))
}

const invalid: Array<[string, Change]> = [
  ['invalid channel ID', state => { raw(state)['channels'] = [{ id: 'bad', delivery: 'all' }] }],
  ['invalid channel delivery', state => { raw(state)['channels'] = [{ id: C.primary, delivery: 'bad' }] }],
  ['duplicate channels', state => { raw(state)['channels'] = [{ id: C.primary, delivery: 'all' }, { id: C.primary, delivery: 'all' }] }],
  ['extra channel field', state => { raw(state)['channels'] = [{ id: C.primary, delivery: 'all', extra: true }] }],
  ['assignment disagrees with applied list', (state, order) => { life(state).assignments[C.primary] = { delivery: 'mentions', order } }],
  ['applied list omits retained assignment', state => { raw(state)['channels'] = [] }],
  ['declaration mismatch', state => { life(state).declaration = { ...life(state).declaration, name: 'different' } }],
  ['destination mismatch', state => { raw(state)['permission_prompts'] = C.secondary }],
  ['old-position collision at bot start', state => {
    const position = applied(state).startedOrder, [id, event] = Object.entries(life(state).membershipEvents)[0]!
    life(state).membershipEvents[id] = { ...event, order: position, boundary: position }
    life(state).membership[C.primary] = { ...life(state).membership[C.primary]!, boundary: position }
  }],
  ['bot-effect collision at resolution', state => {
    life(state).assignments[C.primary] = { delivery: 'mentions', order: applied(state).resolvedOrder }
    raw(state)['channels'] = [{ id: C.primary, delivery: 'mentions' }]
  }],
  ['stale state revision below retained positions', state => { state.revision = 1 }],
]
describe('membership shortcut paired full-reader rejections', () => {
  test.each(invalid)('%s: no write, install or publication; valid next commit still works', (_, change) => rejected(rig(), change))
  test('changed removed-destination proof cannot reuse the old source proof', () => {
    const r = rig(), a = r.authority
    expect(a.observeMembership('alpha', a.incarnation('alpha')!, membershipJoin(C.primary, 'leave-destination', {
      member: false, boundary: a.lifetime('alpha', C.primary)!.membershipBoundary,
    }), a.revision).kind).toBe('applied')
    const proof = a.snapshot().personas['alpha']!.removedDestinations[C.primary]
    expect(proof).toBeDefined()
    r.writes.length = 0; r.publications.length = 0
    rejected(r, state => { delete life(state).removedDestinations[C.primary] })
  })
  test('stale expected revision is refused before the callback and leaves all surfaces unchanged', () => {
    const r = rig(), before = r.authority.snapshot(), bytes = readFileSync(r.authority.path)
    let calls = 0
    expect(r.authority.transactMembership('alpha', before.revision - 1, () => { calls++ })).toEqual({ kind: 'stale', revision: before.revision })
    expect(calls).toBe(0); unchanged(r, before, bytes)
    // A reader has no expected-revision argument. The paired state-invalid
    // stale-revision case above tests its actual independent obligation.
  })
  for (const kind of ['non-enumerable toJSON', 'inherited toJSON', 'getter', 'proxy'] as const) {
    test(`${kind} in callback values cannot replace validated membership bytes`, () => rejected(rig(), state => {
      const malformed = () => ({})
      if (kind === 'non-enumerable toJSON') {
        const map = { ...life(state).membership }
        Object.defineProperty(map, 'toJSON', { value: malformed, enumerable: false })
        life(state).membership = map
      } else if (kind === 'inherited toJSON') {
        life(state).membership = Object.assign(Object.create({ toJSON: malformed }), life(state).membership)
      } else if (kind === 'getter') {
        const map = { ...life(state).membership }
        Object.defineProperty(map, C.primary, { enumerable: true, get: () => ({ member: 'bad' }) })
        life(state).membership = map
      } else {
        life(state).membership = new Proxy({ ...life(state).membership }, { get(target, key, receiver) {
          return key === 'toJSON' ? malformed : Reflect.get(target, key, receiver)
        } })
      }
    }))
  }
})

test('native byte parity across reused fragments, Unicode/escapes, empty maps, insert/delete, integer keys and fallback', () => {
  const r = rig()
  const join: Change = (state, order) => applySharedMembership(state, order, 'alpha', life(state).incarnation,
    membershipJoin(C.secondary, 'unicode-雪-🦊-"-\\-\n-\t'))
  parity(r, join)
  // Changed raw channels must project or fall back, and then become reusable.
  parity(r, (state, order) => {
    life(state).assignments[C.secondary] = { delivery: 'all', order }
    raw(state)['channels'] = [{ id: C.primary, delivery: 'all' }, { id: C.secondary, delivery: 'all' }]
  })
  parity(r, (state, order) => applySharedMembership(state, order, 'alpha', life(state).incarnation,
    membershipJoin(C.secondary, 'repeat', { boundary: life(state).membership[C.secondary]!.boundary })))
  // Replace event IDs while keeping their values and positions: native key
  // order puts integer-like keys first even when they were inserted last.
  parity(r, state => {
    const events = life(state).membershipEvents, entries = Object.entries(events)
    const [first, one] = entries[0]!, [second, two] = entries[1]!
    delete events[first]; delete events[second]
    events['10'] = one; events['2'] = two
  })
  // Accessors require normalization before a changed container can be cached.
  parity(r, state => {
    const records = { ...life(state).membership }
    const value = records[C.primary]!
    Object.defineProperty(records, C.primary, { enumerable: true, get: () => value })
    life(state).membership = records
    life(state).leaves = {}; life(state).removedDestinations = {}
  })
  // The root hook survives descriptor checks and forces native serialization
  // plus full validation of the exact emitted bytes. It preserves the state.
  parity(r, state => {
    Object.defineProperty(state, 'toJSON', { enumerable: false,
      value(this: SharedChannelState) { return { ...this } } })
  })
  // The next canonical commit must agree after that native fallback too.
  parity(r, (state, order) => applySharedMembership(state, order, 'alpha', life(state).incarnation,
    membershipJoin(C.secondary, 'after-fallback', { boundary: life(state).membership[C.secondary]!.boundary })))
})
